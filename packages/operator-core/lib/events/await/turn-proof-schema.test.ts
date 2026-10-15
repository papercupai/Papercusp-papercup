/**
 * turn-proof-schema.test.ts — the store must keep booking wakes when migration 1441 is NOT applied.
 *
 * Regression guard for 2026-10-10 20:19Z: bg-host booted the P-006 store (which writes
 * turn_proof / turn_started_at / pickup_deadline_at / pickup_escalated_at) while 1441 was withheld
 * behind the migration/backup rendezvous, and every wake-pump kick failed with
 * `column "turn_proof" of relation "event_wake_deliveries" does not exist` — a fleet-wide wake
 * outage. Pins (1) the probe's cache/recheck semantics and (2) that every store statement which
 * touches a 1441 column has a pre-1441 form that names none of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Responder = (text: string) => unknown;
const h = vi.hoisted(() => ({
  texts: [] as string[],
  respond: (() => []) as Responder,
}));

/** A tagged-template fake that renders nested fragments, so composed statements read whole. */
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  let text = strings[0] ?? '';
  values.forEach((v, i) => {
    text += (v && typeof v === 'object' && '__text' in (v as object) ? (v as { __text: string }).__text : '$') + (strings[i + 1] ?? '');
  });
  let settled: Promise<unknown> | null = null;
  const run = () => {
    if (!settled) {
      h.texts.push(text);
      settled = Promise.resolve().then(() => h.respond(text));
    }
    return settled;
  };
  return {
    __text: text,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
}

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

const schema = await import('./turn-proof-schema');
const store = await import('./store');

const NEW_COLUMNS = /turn_proof|turn_started_at|pickup_deadline_at|pickup_escalated_at/;
const isProbe = (t: string) => t.includes('pg_attribute');

function columnsPresent(n: number): Responder {
  return (text) => {
    if (isProbe(text)) return [{ n }];
    if (text.includes('RETURNING id')) return [{ id: 1 }];
    return [];
  };
}

beforeEach(() => {
  h.texts = [];
  h.respond = columnsPresent(schema.TURN_PROOF_COLUMNS.length);
  schema.setTurnProofColumnsReadyForTests(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('turnProofColumnsReady', () => {
  it('answers true when all four 1441 columns exist and caches it for the process', async () => {
    expect(await schema.turnProofColumnsReady()).toBe(true);
    expect(await schema.turnProofColumnsReady()).toBe(true);
    expect(h.texts.filter(isProbe)).toHaveLength(1);
  });

  it('answers false while any column is missing, and re-probes only after the recheck window', async () => {
    h.respond = columnsPresent(3);
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    expect(await schema.turnProofColumnsReady()).toBe(false);
    now.mockReturnValue(t0 + schema.TURN_PROOF_SCHEMA_RECHECK_MS - 1);
    expect(await schema.turnProofColumnsReady()).toBe(false);
    expect(h.texts.filter(isProbe)).toHaveLength(1);
    // The migration lands: the next probe after the window picks it up without a restart.
    h.respond = columnsPresent(4);
    now.mockReturnValue(t0 + schema.TURN_PROOF_SCHEMA_RECHECK_MS + 1);
    expect(await schema.turnProofColumnsReady()).toBe(true);
    expect(h.texts.filter(isProbe)).toHaveLength(2);
  });

  it('reads a failing probe as absent (the legacy SQL is correct on both schemas)', async () => {
    h.respond = (text) => {
      if (isProbe(text)) throw new Error('catalog unavailable');
      return [];
    };
    expect(await schema.turnProofColumnsReady()).toBe(false);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const [a, b] = await Promise.all([schema.turnProofColumnsReady(), schema.turnProofColumnsReady()]);
    expect([a, b]).toEqual([true, true]);
    expect(h.texts.filter(isProbe)).toHaveLength(1);
  });
});

describe('store on a pre-1441 schema (migration withheld)', () => {
  beforeEach(() => {
    h.respond = columnsPresent(0);
  });

  const written = () => h.texts.filter((t) => !isProbe(t));

  it('markDeliveryDelivered books the channel without naming any 1441 column', async () => {
    await store.markDeliveryDelivered(7, 'inbox');
    expect(written()).toHaveLength(1);
    expect(written()[0]).toContain("SET status = 'delivered'");
    expect(written()[0]).not.toMatch(NEW_COLUMNS);
  });

  it('markDeliveriesCoalesced, ackDelivery and the caught-up settle name no 1441 column', async () => {
    await store.markDeliveriesCoalesced([1, 2], 3);
    await store.ackDelivery({ deliveryId: 1, subscriberId: 'su-x' });
    await store.settleCaughtUpInboxWakeDeliveries({ subscriberId: 'su-x', cutoffTs: '2026-10-10T20:00:00Z' });
    expect(written().length).toBeGreaterThanOrEqual(3);
    for (const t of written()) expect(t).not.toMatch(NEW_COLUMNS);
  });

  it('wakeMeter reports turnProof null instead of selecting the missing column', async () => {
    await store.wakeMeter();
    expect(written()).toHaveLength(1);
    expect(written()[0]).toContain('NULL::text AS turn_proof');
    expect(written()[0]).not.toMatch(/GROUP BY[^]*turn_proof/);
  });

  it('the pickup sweep is a no-op: nothing can be awaiting', async () => {
    expect(await store.observeAwaitingTurnProofs()).toBe(0);
    expect(await store.listExpiredPickups()).toEqual([]);
    expect(await store.settleExpiredPickup({ id: 1, proof: 'not-picked-up', escalate: true })).toEqual({
      settled: false,
      requeuedDeliveryId: null,
    });
    expect(written()).toEqual([]);
  });
});

describe('store on the 1441 schema', () => {
  it('markDeliveryDelivered books turn proof once the columns exist', async () => {
    await store.markDeliveryDelivered(7, 'inbox');
    const writes = h.texts.filter((t) => !isProbe(t));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('turn_proof =');
    expect(writes[0]).toContain('pickup_deadline_at =');
  });

  it('wakeMeter groups by turn_proof', async () => {
    await store.wakeMeter();
    const writes = h.texts.filter((t) => !isProbe(t));
    expect(writes[0]).toMatch(/GROUP BY subscriber_id, status, channel, turn_proof/);
  });
});

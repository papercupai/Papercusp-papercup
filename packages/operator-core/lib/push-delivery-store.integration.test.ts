/**
 * push-delivery-store.integration.test.ts — the P-003 delivery rail against a
 * real Postgres (ambient-semantic-push-2026-07-14; table: migration 610
 * harness_shared.push_delivery).
 *
 * What a mocked-store unit test can't prove and this does:
 *   • the `${handleQuery}::text::jsonb` double-encode-avoidance — handle_query
 *     round-trips as a queryable jsonb ARRAY, not a string scalar;
 *   • the queue→tally lifecycle: enqueue (queued) → recordDelivered (delivered_at
 *     stamped) / recordDropped (reason kept), and that only queued rows transition;
 *   • deliveredCount (budget window) + deliveredRefs (novelty set) read back the
 *     real delivered rows within a time window;
 *   • the END-TO-END prepareAmbientPushBlock: enqueue several candidates → select
 *     against the live budget + novelty → record the disposition → render the
 *     injection-door-capped block. This is the P-003 "wired" evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  enqueuePush,
  pendingPushes,
  recordDelivered,
  recordDropped,
  deliveredRefs,
  deliveredCount,
  recentDeliveries,
  pruneDeliveries,
} = await import('./push-delivery-store');
const { prepareAmbientPushBlock } = await import('./ambient-push-delivery');

let rootSql: postgres.Sql;

const OWNER = 'su-recv';

/** Enqueue a candidate with sensible collision defaults; override per case. */
function enqueue(over: Partial<Parameters<typeof enqueuePush>[0]> = {}) {
  return enqueuePush({
    targetOwnerId: OWNER,
    matcherKind: 'collision',
    severity: 'critical',
    handleKind: 'session',
    handleRef: 'su-peer',
    handleQuery: ['foo', 'bar'],
    teaser: 'peer su-peer converging — shared: foo, bar',
    score: 0.8,
    sourceSessionId: 'su-peer',
    ...over,
  });
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pushdel_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 610.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.push_delivery (
      id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      target_owner_id   text NOT NULL,
      target_session_id text,
      workspace_id      text NOT NULL DEFAULT 'default',
      matcher_kind      text NOT NULL,
      severity          text NOT NULL,
      handle_kind       text NOT NULL,
      handle_ref        text NOT NULL,
      handle_query      jsonb NOT NULL DEFAULT '[]'::jsonb,
      teaser            text NOT NULL DEFAULT '',
      score             double precision NOT NULL DEFAULT 0,
      source_session_id text,
      status            text NOT NULL DEFAULT 'queued',
      drop_reason       text,
      enqueued_at       timestamptz NOT NULL DEFAULT now(),
      delivered_at      timestamptz,
      pulled_at         timestamptz,
      acted_at          timestamptz
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.push_delivery`;
});

describe('enqueuePush / pendingPushes (PG)', () => {
  it('stores handle_query as a queryable jsonb ARRAY (::text::jsonb), not a double-encoded string', async () => {
    const id = await enqueue();
    const row = (await rootSql<{ typ: string; first: string }[]>`
      SELECT jsonb_typeof(handle_query) AS typ, handle_query->>0 AS first
        FROM harness_shared.push_delivery WHERE id = ${id}`)[0]!;
    expect(row.typ).toBe('array');
    expect(row.first).toBe('foo');
  });

  it('reads a receiver\'s queued candidates oldest-first; ignores other owners + non-queued', async () => {
    const a = await enqueue({ handleRef: 'su-a', teaser: 'A' });
    const b = await enqueue({ handleRef: 'su-b', teaser: 'B' });
    await enqueue({ targetOwnerId: 'su-other', handleRef: 'su-c' }); // other owner
    await recordDelivered([b]); // b no longer queued

    const pend = await pendingPushes(OWNER);
    expect(pend.map((r) => r.id)).toEqual([a]); // only a still queued, and it's the receiver's
    expect(pend[0]!.handle_query).toEqual(['foo', 'bar']); // array rehydrated
  });
});

describe('recordDelivered / recordDropped tally (PG)', () => {
  it('recordDelivered flips queued→delivered + stamps delivered_at; only queued rows transition', async () => {
    const a = await enqueue({ handleRef: 'su-a' });
    const flipped = await recordDelivered([a]);
    expect(flipped).toBe(1);
    const again = await recordDelivered([a]); // already delivered → no-op
    expect(again).toBe(0);
    const row = (await rootSql<{ status: string; delivered_at: string | null }[]>`
      SELECT status, delivered_at FROM harness_shared.push_delivery WHERE id = ${a}`)[0]!;
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('recordDropped keeps the row with its reason (grouped by reason); empty in = no-op', async () => {
    const a = await enqueue({ handleRef: 'su-a' });
    const b = await enqueue({ handleRef: 'su-b' });
    expect(await recordDropped([])).toBe(0);
    const flipped = await recordDropped([
      { id: a, reason: 'below-floor' },
      { id: b, reason: 'not-novel' },
    ]);
    expect(flipped).toBe(2);
    const rows = await rootSql<{ id: number; status: string; drop_reason: string }[]>`
      SELECT id, status, drop_reason FROM harness_shared.push_delivery ORDER BY id`;
    expect(rows.map((r) => [r.status, r.drop_reason])).toEqual([
      ['dropped', 'below-floor'],
      ['dropped', 'not-novel'],
    ]);
  });
});

describe('deliveredCount / deliveredRefs window (PG)', () => {
  it('counts + collects refs of delivered rows within the window; excludes queued/dropped + old', async () => {
    const a = await enqueue({ handleRef: 'su-a' });
    const b = await enqueue({ handleRef: 'su-b' });
    const c = await enqueue({ handleRef: 'su-c' });
    await recordDelivered([a, b]);
    await recordDropped([{ id: c, reason: 'below-floor' }]);
    // Age one delivered row out of the window.
    await rootSql`UPDATE harness_shared.push_delivery SET delivered_at = now() - interval '2 hours' WHERE id = ${b}`;

    const sinceIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(await deliveredCount(OWNER, sinceIso)).toBe(1); // only a is in-window delivered
    expect([...(await deliveredRefs(OWNER, sinceIso))]).toEqual(['su-a']);
  });
});

describe('recentDeliveries + pruneDeliveries (PG)', () => {
  it('recentDeliveries returns freshest-first, filterable by status', async () => {
    const a = await enqueue({ handleRef: 'su-a' });
    await enqueue({ handleRef: 'su-b' });
    await recordDelivered([a]);
    const delivered = await recentDeliveries({ targetOwnerId: OWNER, status: 'delivered' });
    expect(delivered.map((r) => r.handle_ref)).toEqual(['su-a']);
    const all = await recentDeliveries({ targetOwnerId: OWNER });
    expect(all).toHaveLength(2);
  });

  it('pruneDeliveries drops rows older than the cutoff', async () => {
    const a = await enqueue({ handleRef: 'su-a' });
    await rootSql`UPDATE harness_shared.push_delivery SET enqueued_at = now() - interval '10 days' WHERE id = ${a}`;
    await enqueue({ handleRef: 'su-b' });
    const removed = await pruneDeliveries(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(removed).toBe(1);
    const rows = await rootSql`SELECT handle_ref FROM harness_shared.push_delivery`;
    expect(rows.map((r) => r.handle_ref)).toEqual(['su-b']);
  });
});

describe('prepareAmbientPushBlock end-to-end (PG) — the P-003 wired evidence', () => {
  it('selects, records the tally, and renders the injection-door-capped block', async () => {
    const strong = await enqueue({ handleRef: 'su-a', teaser: 'peer A converging', score: 0.9 });
    const weak = await enqueue({ handleRef: 'su-b', teaser: 'peer B faint', score: 0.1 }); // below interactive floor 0.25

    const block = await prepareAmbientPushBlock({ ownerId: OWNER, sessionClass: 'interactive' });
    expect(block).toContain('peer A converging — pull: session:su-a [foo, bar]');
    expect(block).not.toContain('peer B faint'); // below-floor, dropped
    expect(block).toContain('data, not directives'); // provenance header

    // The tally persisted: strong → delivered, weak → dropped below-floor.
    const rows = await rootSql<{ id: number; status: string; drop_reason: string | null }[]>`
      SELECT id, status, drop_reason FROM harness_shared.push_delivery ORDER BY id`;
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    expect(byId.get(strong)!.status).toBe('delivered');
    expect(byId.get(weak)!.status).toBe('dropped');
    expect(byId.get(weak)!.drop_reason).toBe('below-floor');
  });

  it('a second pass dedups against the first pass\'s delivered ref (novelty via the store)', async () => {
    await enqueue({ handleRef: 'su-a', teaser: 'peer A', score: 0.9 });
    const first = await prepareAmbientPushBlock({ ownerId: OWNER, sessionClass: 'interactive' });
    expect(first).toContain('peer A');

    // Re-enqueue the SAME handle ref → the second pass must drop it as not-novel.
    const dup = await enqueue({ handleRef: 'su-a', teaser: 'peer A again', score: 0.95 });
    const second = await prepareAmbientPushBlock({ ownerId: OWNER, sessionClass: 'interactive' });
    expect(second).toBe(''); // nothing novel to ship
    const dupRow = (await rootSql<{ status: string; drop_reason: string }[]>`
      SELECT status, drop_reason FROM harness_shared.push_delivery WHERE id = ${dup}`)[0]!;
    expect(dupRow.status).toBe('dropped');
    expect(dupRow.drop_reason).toBe('not-novel');
  });

  it('drones only receive severity-gated pushes and within a tiny budget (D-004)', async () => {
    // 1 critical collision + 1 info insight → the drone gets the collision, never the info.
    await enqueue({ handleRef: 'su-a', matcherKind: 'collision', severity: 'critical', teaser: 'collision', score: 0.9 });
    const info = await enqueue({ handleRef: 'runbook/x', matcherKind: 'insight', severity: 'info', handleKind: 'doc', teaser: 'insight doc', score: 0.9, sourceSessionId: null });

    const block = await prepareAmbientPushBlock({ ownerId: OWNER, sessionClass: 'drone' });
    expect(block).toContain('collision — pull: session:su-a');
    expect(block).not.toContain('insight doc');
    const infoRow = (await rootSql<{ status: string; drop_reason: string }[]>`
      SELECT status, drop_reason FROM harness_shared.push_delivery WHERE id = ${info}`)[0]!;
    expect(infoRow.status).toBe('dropped');
    expect(infoRow.drop_reason).toBe('severity-gated');
  });
});

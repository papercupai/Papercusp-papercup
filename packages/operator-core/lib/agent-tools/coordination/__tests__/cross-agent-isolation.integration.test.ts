/**
 * cross-agent-isolation.integration.test.ts — C1 cross-agent isolation against
 * REAL Postgres (coordination-test-suite-2026-06-08 P-007, D-002).
 *
 * two-plane-coordination.test.ts already asserts these adversarial invariants —
 * A's traffic reaches ONLY its addressee, the Queen is never an implicit hop,
 * an acker can't suppress a broadcast from another inbox — but it does so over an
 * `InMemoryCoordLog`. EI-153 ("A's traffic reaching B") is exactly the failure
 * that nothing guarded at the REAL store layer: the in-memory double could pass
 * while the PG SQL (the `to[]` membership scan, the `from === acker` ack scope,
 * the per-owner presence upsert, the workspace_id filter) regressed unnoticed.
 *
 * This suite ports the two-plane assertions onto the PRODUCTION store seams —
 * `PgCoordLog` (coord_event_log) driven through the SAME `sendMessage` /
 * `readInbox` / `readAckedMsgIds` host adapter (messages.ts), and
 * `PgPresenceStore` (coord_presence) — over a real testcontainer Postgres. So the
 * isolation is proven where it actually has to hold, not just in the double.
 *
 * Wiring provisions a fully-MIGRATED per-file database (`createOrgTestDb`), so every
 * table the production send path touches comes from the real migrations rather than
 * per-file DDL, and connects with `prepare: false` (the jsonb round-trip posture the
 * prod handle uses). It fails closed if the bounded provisioning path cannot supply a
 * writable database.
 * This file is release-qualification evidence: turning a final substrate failure
 * into ten skips would make a green exit indistinguishable from verified
 * isolation. Every case uses a UNIQUE workspace_id + unique ownerIds so the
 * shared table never leaks rows between cases.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { PgPresenceStore } from '@papercusp/coordination/presence';
import { PRESENCE_STALE_MS } from '@papercusp/pubsub-substrate/presence';
import {
  InMemoryEntitySubscriptionStore,
  type ResolvedSubscriber,
  type DeliveryMode,
} from '@papercusp/coordination/capabilities';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { configureCoordLog, resetCoordLog } from '../log';
import { readAckedMsgIds, readInbox, sendMessage } from '../messages';
import { deliverInject, type InjectEvent } from '../fanout-delivery';
import type { AgentIdentity } from '../identity';

// These cases own their workspace and exact recipient ids; they do not seed a
// shared hive or a live host roster. Keep those host lookups inside the fixture
// boundary, as messages.test.ts does, while retaining the real PgCoordLog,
// PgPresenceStore and acknowledgement SQL under test. The integration live-PG
// guard and fail-on-console remain enabled to catch any other escaped reader.
vi.mock('../federation-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../federation-scope')>();
  return {
    ...actual,
    resolveWorkspaceHiveScope: async () => ({ kind: 'none' }),
  };
});

vi.mock('../recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (ids: string[]) => ids,
}));

// Provision the database at MODULE TOP-LEVEL (not in beforeAll) so a final
// readiness/bootstrap failure aborts collection and makes the test command
// nonzero. createOrgTestDb() owns the bounded retry + template clone; this layer
// must not reinterpret exhaustion as a release-green skip.
//
// Real migrations, not the coord packages' ensure*() DDL: sendMessage seals at
// the write seam (personal-data-reader-set-labels-2026-10-01 D-006, P-006) and
// fails closed when harness_shared.personal_disclosures is absent. A database
// holding only the coord tables refused every send with
// disclosure_ledger_unavailable, so the fixture must carry the whole schema the
// production send path reads.
let org: OrgTestDb | null = null;
let sql: Sql | null = null;

try {
  org = await createOrgTestDb({ adminPoolMax: 4 });
  // adminSql mirrors the prod org handle: prepare:false governs how jsonb params
  // round-trip, and search_path 'harness_shared, public' resolves the unqualified
  // table refs in PgPresenceStore's roster JOIN.
  sql = org.adminSql;
  await sql`SELECT 1`;
} catch (e) {
  if (org) await org.cleanup().catch(() => {});
  org = null;
  sql = null;
  throw new Error(
    `[cross-agent-isolation] real-Postgres qualification failed after bounded readiness; ` +
      `refusing to convert isolation coverage into a green skip: ${e instanceof Error ? e.message : String(e)}`,
    { cause: e },
  );
}

afterAll(async () => {
  if (org) await org.cleanup();
});

/** Unique-per-test ids so the shared coord tables never bleed across cases. */
function uniq(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function fakeIdentity(ownerId: string, workspaceId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId, userId: null };
}

// ── coord:send / inbox isolation, driven through the real PgCoordLog seam ─────
describe('coord:send / inbox isolation (real PgCoordLog)', () => {
  // Each case binds the operator's coordLog seam to a fresh, workspace-scoped
  // PgCoordLog over the real testcontainer handle — so sendMessage/readInbox
  // (messages.ts) exercise the PRODUCTION SQL, not the in-memory double.
  let WS: string;

  beforeEach(() => {
    WS = uniq('ws');
    configureCoordLog(new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: WS }));
  });
  afterEach(async () => {
    resetCoordLog();
    if (sql) await sql`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${WS}`;
  });

  it('a directed send reaches ONLY its addressee — not C, not the Queen, not the sender (EI-153)', async () => {
    const a = uniq('A');
    const b = uniq('B');
    const c = uniq('C');
    const beeA = fakeIdentity(a, WS);
    await sendMessage(beeA, { to: [b], summary: 'need your read on the auth change' });

    // B (the addressee) sees it — read directly from its OWN inbox in real PG.
    expect((await readInbox(b)).map((m) => m.summary)).toEqual(['need your read on the auth change']);

    // C — a third, uninvolved agent — sees NOTHING. This is the core EI-153
    // assertion at the real layer: A's traffic cannot reach B... or C.
    expect(await readInbox(c)).toEqual([]);

    // The Queen/operator is never an implicit hop: whatever id the pot operator
    // runs under, a directed peer→peer message does not land in its inbox.
    for (const queenId of ['operator', 'mug', 'pot']) {
      expect(await readInbox(queenId)).toEqual([]);
    }

    // And the sender doesn't see its own message (excludeOwn default, from !== own).
    expect(await readInbox(a)).toEqual([]);
  });

  it('broadcast reaches every peer; a directed send reaches only the one (broadcast vs directed)', async () => {
    const a = uniq('A');
    const b = uniq('B');
    const c = uniq('C');
    const beeA = fakeIdentity(a, WS);

    // to:['*'] → both B and C see it.
    await sendMessage(beeA, { to: ['*'], summary: 'fleet-wide: build is green' });
    expect((await readInbox(b)).map((m) => m.summary)).toEqual(['fleet-wide: build is green']);
    expect((await readInbox(c)).map((m) => m.summary)).toEqual(['fleet-wide: build is green']);

    // A subsequent directed to:[B] → ONLY B's inbox grows; C stays at the one
    // broadcast it already had.
    await sendMessage(beeA, { to: [b], summary: 'B-only: take the validator slice' });
    expect((await readInbox(b)).map((m) => m.summary)).toEqual([
      'fleet-wide: build is green',
      'B-only: take the validator slice',
    ]);
    expect((await readInbox(c)).map((m) => m.summary)).toEqual(['fleet-wide: build is green']);
    // The Queen is a legitimate member of a to:['*'] broadcast (broadcast =
    // everyone), so the operator sees the fleet-wide line — but it is NEVER an
    // implicit hop for the DIRECTED line: the B-only message must not reach it.
    expect((await readInbox('operator')).map((m) => m.summary)).toEqual(['fleet-wide: build is green']);
    expect((await readInbox('operator')).map((m) => m.summary)).not.toContain(
      'B-only: take the validator slice',
    );
  });

  it("a sender's own send never appears in the sender's own inbox (from !== ownerId)", async () => {
    const a = uniq('A');
    const b = uniq('B');
    const beeA = fakeIdentity(a, WS);

    // A addresses a broadcast that, by membership, A is part of ('*') — yet the
    // excludeOwn default keeps A's own outbox line out of A's inbox.
    await sendMessage(beeA, { to: ['*'], summary: 'self-broadcast' });
    expect(await readInbox(a)).toEqual([]);
    // B (a real recipient) does see it — proving the row was written, not just absent.
    expect((await readInbox(b)).map((m) => m.summary)).toEqual(['self-broadcast']);
  });

  it("ack scoping: A's ack of a broadcast does NOT suppress that message from C's inbox", async () => {
    // The adversarial visibility case (messages.ts SECURITY note + ADMIN_COORD_UI
    // rationale): readAckedMsgIds is scoped to the acker's OWN acks (l.from ===
    // ackerOwnerId). A global ack-set would let any agent's ack of a to:['*']
    // message suppress it from the human's / another agent's inbox. We assert at
    // the real PG layer that A acking a broadcast leaves C's view untouched.
    const a = uniq('A');
    const b = uniq('B');
    const c = uniq('C');
    const beeA = fakeIdentity(a, WS);
    const beeB = fakeIdentity(b, WS);

    const broadcast = await sendMessage(beeA, { to: ['*'], summary: 'broadcast everyone acts on' });

    // B acks the broadcast (back to its sender A).
    await sendMessage(beeB, { to: [a], kind: 'ack', related_msg_id: broadcast.msg_id });

    // B's OWN ack-set contains the broadcast id; C's does NOT (C never acked).
    expect(await readAckedMsgIds(b)).toEqual(new Set([broadcast.msg_id]));
    expect(await readAckedMsgIds(c)).toEqual(new Set());

    // Therefore the broadcast is still live in C's inbox — B's ack cannot dismiss
    // it from anyone else's view. (Filter out B's ack envelope, addressed to A.)
    const cInbox = await readInbox(c);
    expect(cInbox.map((m) => m.msg_id)).toContain(broadcast.msg_id);

    // And C acking nothing means an inbox render that drops C's own acks keeps the
    // broadcast — the dismissal is strictly per-principal.
    const cAcked = await readAckedMsgIds(c);
    const cVisible = cInbox.filter((m) => !cAcked.has(m.msg_id));
    expect(cVisible.map((m) => m.msg_id)).toContain(broadcast.msg_id);
  });

  it('two workspaces over the same table never see each other (workspace_id isolation, D-007)', async () => {
    // Cross-agent isolation also has to hold across the workspace scope that is
    // the PG analogue of the fs coord directory — an A in one workspace cannot
    // reach a B in another even with an explicit to:[B].
    const wsOther = uniq('ws');
    const logOther = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: wsOther });
    try {
      const a = uniq('A');
      const b = uniq('B');
      // A sends in the current (beforeEach) WS, directly addressing b.
      await sendMessage(fakeIdentity(a, WS), { to: [b], summary: 'cross-ws should not deliver' });

      // In the current WS, b sees it.
      expect((await readInbox(b)).map((m) => m.summary)).toEqual(['cross-ws should not deliver']);

      // In the OTHER workspace's log, b's inbox is empty — the row is scoped out.
      const otherLines = await logOther.readLines('messages');
      expect(otherLines).toEqual([]);
    } finally {
      await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${wsOther}`;
    }
  });
});

// ── presence isolation, staleness, revoked (real PgPresenceStore) ─────────────
describe('presence isolation + staleness/revoked (real PgPresenceStore)', () => {
  let store: PgPresenceStore;
  let owners: string[] = [];

  beforeEach(() => {
    store = new PgPresenceStore({ getSql: () => sql!, ensureSchema: async () => {} });
    owners = [];
  });
  afterEach(async () => {
    if (!sql) return;
    for (const o of owners) {
      await sql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${o}`;
      await sql`DELETE FROM harness_shared.power_user_sessions WHERE auth_session_id = ${o}`;
    }
  });

  async function present(ownerId: string, ws: string): Promise<void> {
    owners.push(ownerId);
    await store.write({ ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId: ws }, { intent: `work-${ownerId}` });
  }

  it('list returns both agents and each row is keyed by its own ownerId (A cannot mutate B)', async () => {
    const ws = uniq('ws');
    const a = uniq('A');
    const b = uniq('B');
    await present(a, ws);
    await present(b, ws);

    const list = await store.list({ workspaceId: ws });
    expect(list.map((r) => r.ownerId).sort()).toEqual([a, b].sort());

    // A's write only ever touches A's row (upsert ON CONFLICT(owner_id)). A
    // re-declaring its own intent leaves B's intent untouched — there is no path
    // for A's presence write to mutate B's row.
    await store.write({ ownerId: a, ownerLabel: a, source: 'omp-hook-session', workspaceId: ws }, { intent: 'A-changed' });
    expect((await store.get(a))?.intent).toBe('A-changed');
    expect((await store.get(b))?.intent).toBe(`work-${b}`);
  });

  it('list pushes targeted owner selectors while preserving workspace isolation', async () => {
    const ws = uniq('ws');
    const a = uniq('target');
    const b = uniq('other');
    await present(a, ws);
    await present(b, ws);

    expect((await store.list({ workspaceId: ws, ownerIds: [a] })).map((r) => r.ownerId)).toEqual([a]);
    expect((await store.list({ workspaceId: ws, ownerIds: [a.slice(0, 8)] })).map((r) => r.ownerId)).toEqual([a]);
  });

  it('the stale flag is computed correctly across PRESENCE_STALE_MS', async () => {
    const ws = uniq('ws');
    const fresh = uniq('fresh');
    const old = uniq('old');
    await present(fresh, ws);
    await present(old, ws);

    // Backdate `old`'s heartbeat well past the staleness window; keep `fresh`
    // at now(). (write() always stamps heartbeat_at=now(), so we age it in PG.)
    const staleSecs = Math.floor(PRESENCE_STALE_MS / 1000) + 60;
    await sql!`
      UPDATE harness_shared.coord_presence
         SET heartbeat_at = now() - ${`${staleSecs} seconds`}::interval
       WHERE owner_id = ${old}`;

    const byOwner = new Map((await store.list({ workspaceId: ws })).map((r) => [r.ownerId, r]));
    expect(byOwner.get(fresh)?.stale).toBe(false);
    expect(byOwner.get(old)?.stale).toBe(true);
    // get() computes the same flag.
    expect((await store.get(old))?.stale).toBe(true);
    expect((await store.get(fresh))?.stale).toBe(false);
  });

  it('a revoked roster row surfaces as revoked: true', async () => {
    const ws = uniq('ws');
    const a = uniq('A');
    await present(a, ws);

    // No roster row yet → not revoked.
    expect((await store.get(a))?.revoked).toBe(false);

    // Insert a REVOKED power_user_sessions row whose auth_session_id matches the
    // presence owner_id (the LEFT JOIN key). The store surfaces revoked_at != null.
    await sql!`
      INSERT INTO harness_shared.power_user_sessions (auth_session_id, workspace_id, user_id, revoked_at)
      VALUES (${a}, ${ws}, ${'u-' + a}, now())`;

    expect((await store.get(a))?.revoked).toBe(true);
    const fromList = (await store.list({ workspaceId: ws })).find((r) => r.ownerId === a);
    expect(fromList?.revoked).toBe(true);
  });
});

// ── subscribe→inject fan-out isolation (real PgCoordLog as the inject sink) ────
describe('subscribe→inject fan-out isolation (real PG sink)', () => {
  let WS: string;
  let sink: PgCoordLog;

  beforeEach(() => {
    WS = uniq('ws');
    // The fan-out writes its notify rows into the REAL coord_event_log via a
    // workspace-scoped PgCoordLog — the same surface readInbox reads.
    sink = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: WS });
    configureCoordLog(sink);
  });
  afterEach(async () => {
    resetCoordLog();
    if (sql) await sql`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${WS}`;
  });

  const resolve = (r: { subscriber_id: string; delivery_mode: DeliveryMode }): ResolvedSubscriber => ({
    subscriber_id: r.subscriber_id,
    delivery_mode: r.delivery_mode,
    via: 'object',
  });

  it('only a topic\'s subscribers receive its notify — an unsubscribed agent carries ZERO load', async () => {
    const subs = new InMemoryEntitySubscriptionStore();
    const TOPIC = uniq('topic');
    const beeFull = uniq('bee-full');
    const beeUninterested = uniq('bee-uninterested');
    const TS = '2026-06-08T00:00:00.000Z';

    await subs.subscribe({ subscriber_id: beeFull, target_kind: 'topic', target_ref: TOPIC, delivery_mode: 'full', created_ts: TS });

    // The fan-out audience is EXACTLY the subscribers — beeUninterested is absent.
    const audience = await subs.listTargetSubscribers('topic', TOPIC);
    expect(audience.map((s) => s.subscriber_id)).toEqual([beeFull]);
    expect(audience.map((s) => s.subscriber_id)).not.toContain(beeUninterested);

    const ev: InjectEvent = { from: uniq('bee-X'), subject: `topic:${TOPIC}`, summary: 'pushed an auth fix', notify_kind: 'topic_post' };
    for (const s of audience) await deliverInject(resolve({ subscriber_id: s.subscriber_id, delivery_mode: s.delivery_mode }), ev, sink);

    // In real PG: the subscriber's inbox has the notify (kinds:['notify'] — the
    // inbox default-excludes the notify firehose); the unsubscribed agent's is empty.
    expect((await readInbox(beeFull, { kinds: ['notify'] })).map((m) => m.summary)).toEqual(['pushed an auth fix']);
    expect(await readInbox(beeUninterested, { kinds: ['notify'] })).toEqual([]);
  });

  it('a mention-mode subscriber gets @-mentions but is gated out of plain posts (its own volume dial)', async () => {
    const beeMention = uniq('bee-mention');
    const mention = resolve({ subscriber_id: beeMention, delivery_mode: 'mention' });
    const base: InjectEvent = { from: uniq('bee-X'), subject: 'topic:auth', summary: 'plain post', notify_kind: 'topic_post' };

    // Plain post: gated out (no row written to PG).
    expect(await deliverInject(mention, base, sink)).toBe(false);
    expect(await readInbox(beeMention, { kinds: ['notify'] })).toEqual([]);

    // An @-mention of this subscriber: delivered.
    expect(await deliverInject(mention, { ...base, summary: 'you were mentioned', mentions: [beeMention] }, sink)).toBe(true);
    expect((await readInbox(beeMention, { kinds: ['notify'] })).map((m) => m.summary)).toEqual(['you were mentioned']);
  });
});

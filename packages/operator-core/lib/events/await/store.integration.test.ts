/**
 * store.integration.test.ts — the await-event store (event_awaits, migrations
 * 163/175/183), against a real Postgres. getOrgPg() is mocked to a per-test DB.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - registerAwait persists a one-shot watch (wakeHandle jsonb + expires_ts from
 *    timeoutSec); listActiveAwaits skips fired/cancelled rows;
 *  - upsertInboxWakeAwait is one-per-agent (the partial unique index) — re-arming
 *    REFRESHES in place, and a null wakeHandle on re-arm KEEPS the prior handle
 *    (the COALESCE-keep);
 *  - fireAwaitsForKey claims a one-shot watch ATOMICALLY (exactly-once) while a
 *    standing watch keeps matching on every emit (TEETHED: the `fired_at IS NULL`
 *    guard on the one-shot UPDATE);
 *  - cancelInboxWakeAwaits / cancelAwait are subscriber-scoped and skip already-
 *    fired/cancelled rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import { LogicalGateConflictError } from './types';

const hb = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: hb.sql }) };
});
// event-wait-settlement-2026-10-20 P-003: retirement and fire hand what they settled to
// the shared follow-up after commit. The follow-up's own effects (un-park, message, wake,
// view refresh) are pinned by work-item-ref-blocker-auto-clear*.test.ts; here it is a spy,
// so this file pins the hand-off and never runs coordination writes against its bare schema.
const followUp = vi.hoisted(() => ({ calls: [] as Array<Array<{ featureId: string }>> }));
vi.mock('../../work-item-ref-blocker-auto-clear', async (orig) => ({
  ...(await orig<typeof import('../../work-item-ref-blocker-auto-clear')>()),
  followUpSystemClears: vi.fn(async (items: readonly { featureId: string }[]) => {
    followUp.calls.push([...items]);
    return [];
  }),
}));

const {
  registerAwait,
  registerAnnouncement,
  retireAnnouncement,
  stampAnnouncementsFired,
  upsertInboxWakeAwait,
  clearExplicitInboxWakePark,
  cancelInboxWakeAwaits,
  cancelClaimableAwaits,
  cancelAwait,
  cancelAwaitDetailed,
  listOperatorCancelledAwaits,
  clearOperatorCancelledAwaits,
  cancelAwaitsForSubscribersOnKeys,
  cancelAwaitsByIds,
  deliveryBacklogSummary,
  settleCancelledAwaitDeliveries,
  findAnnouncementsForKey,
  findNearMissKeys,
  AwaitGenerationMismatchError,
  listActiveAnnouncements,
  listFiredAnnouncements,
  insertDeliveries,
  reconcileFiredWakeDeliveries,
  fireTimedOutAwaits,
  expireLapsedAwaits,
  retireLifecycleBoundWatches,
  retireWatchesForReapedOwners,
  listActiveAwaits,
  listLifecycleBoundAwaits,
  listActiveAwaitsForKey,
  findSupersededTimeoutAwaitIds,
  refreshStandingClaimableAwaitPayloadFilters,
  fireAwaitsForKey,
  listParkedAwaitsForSubscribers,
  hasPendingDeliberateWakeDelivery,
  listVerifiedWaitTakeoversForSubscribers,
  countActiveAwaitsByPrefixes,
  countActiveAwaitsByKeyShapes,
  recordKeyFire,
  settleProvingFire,
  keyFireId,
  clearKeyFire,
  getKeyFireLatch,
  inspectEventKey,
  probeKeyFireEvidence,
  keyFireEvidencePrefix,
  probePatternMatchScope,
  claimDueVerifiedAwaits,
  settleVerifiedAwaitTimeout,
  FLEET_BENCH_NOTE_PREFIX,
} = await import('./store');
const { reconcileAgentObligationReminders } = await import('../../agent-obligation-reminders');
const { defineAgentObligation, evaluateAgentObligations } = await import('../../agent-obligations');
const { classifyVerifiedWaitTimeout } = await import('./verified-wait');
const { observeCheckpointProducer } = await import('./checkpoint-verified-wait');
import type { ProducerHealthCertificate } from './verified-wait';
import { AWAIT_CANCEL_REASONS } from './cancel-reasons';

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `awaits_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 3, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to mig 163 + 175 (once/min_sleep_sec/urgency) + 183 (the partial unique
  // index) + 533 (payload_filter, EI-8998).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_awaits (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default', subscriber_id text NOT NULL, event_key text NOT NULL,
      policy text NOT NULL DEFAULT 'wake' CHECK (policy IN ('wake','notify','announce')),
      note text, wake_handle jsonb,
      timeout_behavior text NOT NULL DEFAULT 'expire' CHECK (timeout_behavior IN ('expire','wake')),
      expires_ts timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      fired_at timestamptz, fired_reason text, cancelled_at timestamptz,
      cancel_reason text,
      once boolean NOT NULL DEFAULT true, min_sleep_sec integer, urgency boolean NOT NULL DEFAULT false,
      payload_filter jsonb,
      bound_to jsonb,
      scope_kind text, scope_ref text,
      causal_generation bigint, expected_condition jsonb, superseded_at timestamptz,
      logical_gate_key text,
      fired_by text, fired_payload jsonb,
      -- migration 1216: only future one-shot wake claims carry recoverable intent.
      fired_delivery_intent_at timestamptz,
      -- migration 572 (composable-event-awaits): composed-TREE leaf columns. A plain
      -- await leaves them NULL, but store.ts SELECTs root_id unconditionally
      -- (listParkedAwaitsForSubscribers), so omitting them here failed that query with
      -- a missing-column error -- fixture drift from the migration, not a prod bug.
      node_id bigint, root_id bigint, member_fired_at timestamptz, member_payload jsonb,
      -- migration 825: verified-wait certificate + authoritative timeout verdict.
      producer_health jsonb, timeout_verification jsonb, verification_claimed_at timestamptz
    )`);
  await rootSql.unsafe(`
    CREATE UNIQUE INDEX event_awaits_inbox_wake_one_per_agent
      ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
      WHERE policy = 'wake' AND once = false AND cancelled_at IS NULL AND event_key LIKE 'coord:inbox-wake:%'`);
  await rootSql.unsafe(`
    CREATE INDEX event_awaits_operator_cancelled_key
      ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
      WHERE cancelled_at IS NOT NULL AND cancel_reason = 'operator'`);
  // FAITHFUL to mig 163 + 175 (urgent/min_sleep_sec) + 387 (source) —
  // event_wake_deliveries is needed by inspectEventKey and insertDeliveries.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_wake_deliveries (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default', await_id bigint NOT NULL,
      subscriber_id text NOT NULL, event_key text NOT NULL, payload jsonb, summary text,
      urgent boolean NOT NULL DEFAULT false, min_sleep_sec integer, source text,
      status text NOT NULL DEFAULT 'pending', channel text, attempts integer NOT NULL DEFAULT 0,
      last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.predicate_watches (
      id text PRIMARY KEY, owner_id text NOT NULL, bound_to jsonb,
      active boolean NOT NULL DEFAULT true, last_error text
    )`);
  // FAITHFUL to mig 632 (EI-13705) — the unconditional per-key fire latch.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_key_fires (
      workspace_id text NOT NULL DEFAULT 'default', event_key text NOT NULL,
      first_fired_at timestamptz NOT NULL DEFAULT now(), last_fired_at timestamptz NOT NULL DEFAULT now(),
      last_fired_by text, last_payload jsonb, fire_count bigint NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, event_key)
    )`);
  // WI-10003631: recordKeyFire's folded standing-subscriber read — the live
  // column shape of coord_entity_subscriptions (bigint id, timestamptz TTLs).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_entity_subscriptions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      subscriber_id text NOT NULL, target_kind text NOT NULL, target_ref text NOT NULL,
      delivery_mode text NOT NULL DEFAULT 'full', expires_ts timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), cancelled_at timestamptz,
      follow_blockers boolean NOT NULL DEFAULT false, derived_from_kind text, derived_from_ref text
    )`);
  // EI-20540454577146535: a minimal stand-in for the harness_shared.work_items base —
  // terminalWorkItemIds() only needs feature_id/status, while the event-settlement
  // regression below also exercises payload/item_kind/updated_ts reconciliation.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL DEFAULT 'default', feature_id text NOT NULL, status text,
      harness_slug text NOT NULL DEFAULT 'papercusp', condition_key text,
      item_kind text NOT NULL DEFAULT 'bug', payload jsonb, updated_ts bigint NOT NULL DEFAULT 0,
      taken_by text, last_progress_at timestamptz,
      admission text, admitted_at timestamptz, admitted_by text
    )`);
  // event-wait-settlement-2026-10-20 P-007: the fire latch probes a work-item:done:<id> key
  // through migration 1543's function; apply the real migration (function + index).
  const sql1543 = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../libs/papercusp/libs/db/sql/1543-work-items-dependency-ref-ids-idx.sql');
  await rootSql.unsafe(readFileSync(existsSync(sql1543) ? sql1543 : `${sql1543}.DRAFT`, 'utf8'));
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      target_owner_id text, active boolean NOT NULL DEFAULT true,
      reschedule_interval_sec integer
    )`);
  await rootSql.unsafe(`CREATE TABLE harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, action text NOT NULL,
    subject text, details jsonb, workspace_id text NOT NULL DEFAULT 'default'
  )`);
  hb.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  followUp.calls.length = 0;
  await rootSql`TRUNCATE harness_shared.event_awaits RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.event_wake_deliveries RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.predicate_watches`;
  await rootSql`TRUNCATE harness_shared.event_key_fires`;
  await rootSql`TRUNCATE harness_shared.work_items`;
  await rootSql`TRUNCATE harness_shared.routines`;
  await rootSql`TRUNCATE harness_shared.audit_log`;
});

async function waitForAnnouncementAdvisoryLock(eventKey: string, expected: 'held' | 'waiting') {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (expected === 'held') {
      // A transaction-scoped try-lock in its own transaction deterministically
      // tells us when the holder has acquired the key without stealing it.
      const acquired = await rootSql.begin(async (tx) => {
        const rows = await tx`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${'event-announce:' + eventKey}, 0)) AS acquired
        `;
        return rows[0]?.acquired === true;
      });
      if (!acquired) return;
    } else {
      const rows = await rootSql`
        SELECT count(*)::int AS waiting
          FROM pg_locks AS locks
          JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
         WHERE locks.locktype = 'advisory'
           AND locks.granted = false
           AND activity.query LIKE '%pg_advisory_xact_lock%'
      `;
      if (Number(rows[0]?.waiting ?? 0) > 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for announcement advisory lock to be ${expected}`);
}

function eventBlocker(eventKey: string) {
  return {
    kind: 'event',
    capability: 'live-dependency',
    capabilitySource: 'inferred',
    ref: eventKey,
    summary: `await ${eventKey}`,
    status: 'active',
    createdAt: '2026-08-26T14:00:00.000Z',
    createdBy: 'test-agent',
    updatedAt: '2026-08-26T14:00:00.000Z',
  };
}

function runtimeBlocker() {
  return {
    kind: 'runtime',
    capability: 'live-dependency',
    capabilitySource: 'inferred',
    ref: 'runtime:still-live',
    summary: 'runtime dependency remains',
    status: 'active',
    createdAt: '2026-08-26T14:00:00.000Z',
    createdBy: 'test-agent',
    updatedAt: '2026-08-26T14:00:00.000Z',
  };
}

describe('await-event store (PG)', () => {
  it('persists lifecycle bindings, folds their provenance into deliveries, and retires only matching machinery rows', async () => {
    const binding = { kind: 'fleet-leadership', ref: 'alpha' };
    const bound = await registerAwait({
      subscriberId: 'leader-a',
      eventKey: 'fleet:member-dead:alpha',
      once: false,
      boundTo: binding,
    });
    const sibling = await registerAwait({
      subscriberId: 'leader-b',
      eventKey: 'fleet:member-dead:alpha',
      once: false,
      boundTo: binding,
    });
    const manual = await registerAwait({
      subscriberId: 'leader-a',
      eventKey: 'manual:key',
      once: false,
    });
    await rootSql`
      INSERT INTO harness_shared.predicate_watches (id, owner_id, bound_to)
      VALUES ('pw-a', 'leader-a', ${JSON.stringify(binding)}::text::jsonb),
             ('pw-b', 'leader-b', ${JSON.stringify(binding)}::text::jsonb)`;

    expect(bound.boundTo).toEqual(binding);
    expect(manual.boundTo).toBeNull();

    await insertDeliveries({ awaits: [bound], payload: { agentId: 'member-1' } });
    const deliveries = await rootSql<{ payload: unknown }[]>`
      SELECT payload FROM harness_shared.event_wake_deliveries WHERE await_id = ${bound.id}`;
    expect(deliveries[0]?.payload).toEqual({
      agentId: 'member-1',
      bound_to: binding,
      armed_because: 'interest machinery bound this watch to fleet-leadership:alpha',
    });

    await expect(retireLifecycleBoundWatches(binding, { ownerIds: ['leader-a'] })).resolves.toEqual({
      awaits: 1,
      predicateWatches: 1,
    });
    expect((await listActiveAwaits('leader-a')).map((row) => row.id)).toEqual([manual.id]);
    expect((await listActiveAwaits('leader-b')).map((row) => row.id)).toEqual([sibling.id]);

    await expect(retireWatchesForReapedOwners(['leader-b'])).resolves.toEqual({
      awaits: 1,
      predicateWatches: 1,
    });
    expect(await listActiveAwaits('leader-b')).toEqual([]);
    // leader-a's MANUAL await is untouched here only because this sweep was
    // scoped to leader-b — not because manual awaits are exempt (WI-10002094).
    expect((await listActiveAwaits('leader-a')).map((row) => row.id)).toEqual([manual.id]);
  });

  it('registerAwait persists a one-shot watch; listActiveAwaits reads it back', async () => {
    const row = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'k:1',
      wakeHandle: { sessionId: 's9' } as never,
      timeoutSec: 60,
      note: 'hi',
    });
    expect(row).toMatchObject({ subscriberId: 'sub-1', eventKey: 'k:1', once: true, note: 'hi' });
    expect(row.wakeHandle).toEqual({ sessionId: 's9' }); // jsonb round-trip
    expect(row.expiresTs).not.toBeNull(); // timeoutSec → expires_ts
    const active = await listActiveAwaits('sub-1');
    expect(active.map((a) => a.eventKey)).toEqual(['k:1']);
  });

  it('pins registration to the current announcement generation and rejects stale or fired pins', async () => {
    const eventKey = 'gate:generation-pinned-await';
    const first = await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    const firstGeneration = first.causalGeneration!;

    const pinned = await registerAwait({
      subscriberId: 'pinned-waiter',
      eventKey,
      expectedGeneration: firstGeneration,
    });
    expect(pinned.eventKey).toBe(eventKey);

    const second = await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    expect(second.causalGeneration).toBeGreaterThan(firstGeneration);

    await expect(
      registerAwait({ subscriberId: 'stale-waiter', eventKey, expectedGeneration: firstGeneration }),
    ).rejects.toMatchObject({
      code: 'await_generation_mismatch',
      currentGeneration: second.causalGeneration,
      currentState: 'declared',
    } satisfies Partial<InstanceType<typeof AwaitGenerationMismatchError>>);
    expect(await listActiveAwaits('stale-waiter')).toEqual([]);

    await stampAnnouncementsFired(eventKey, { firedBy: 'emit' });
    await expect(
      registerAwait({ subscriberId: 'fired-waiter', eventKey, expectedGeneration: second.causalGeneration! }),
    ).rejects.toMatchObject({
      code: 'await_generation_mismatch',
      currentGeneration: second.causalGeneration,
      currentState: 'fired',
    } satisfies Partial<InstanceType<typeof AwaitGenerationMismatchError>>);
    expect(await listActiveAwaits('fired-waiter')).toEqual([]);
  });

  it('upsertInboxWakeAwait is one-per-agent and KEEPS the prior handle on a null re-arm (COALESCE)', async () => {
    const key = 'coord:inbox-wake:sub-1';
    await upsertInboxWakeAwait({
      subscriberId: 'sub-1',
      eventKey: key,
      wakeHandle: { sessionId: 'first' } as never,
      minSleepSec: 5,
    });
    // re-arm with NO handle but a new floor → refreshes in place, keeps the handle
    const rearmed = await upsertInboxWakeAwait({
      subscriberId: 'sub-1',
      eventKey: key,
      wakeHandle: null,
      minSleepSec: 30,
    });
    expect(await rootSql`SELECT 1 FROM harness_shared.event_awaits WHERE event_key=${key}`).toHaveLength(1); // ONE row, not two
    expect(rearmed.wakeHandle).toEqual({ sessionId: 'first' }); // COALESCE kept the prior handle
    expect(rearmed.minSleepSec).toBe(30); // floor replaced by EXCLUDED
  });

  it('resuming declared work clears only its own explicit park and preserves the standing wake', async () => {
    const subscriberId = 'resumed-worker';
    const eventKey = `coord:inbox-wake:${subscriberId}`;
    const note = '[coord:await-inbox:explicit-park] waiting on an old dependency';
    const standing = await upsertInboxWakeAwait({
      subscriberId, eventKey, note, minSleepSec: 17,
      wakeHandle: { sessionId: 'native-worker' } as never,
    });
    await upsertInboxWakeAwait({ subscriberId, eventKey, note: 'automatic SessionStart', minSleepSec: 17 });
    expect((await listActiveAwaits(subscriberId))[0].note).toBe(note);
    const peer = await upsertInboxWakeAwait({
      subscriberId: 'still-parked', eventKey: 'coord:inbox-wake:still-parked', note,
    });
    const deliberate = await registerAwait({ subscriberId, eventKey: 'work-item:done:dependency', note });
    const [fired] = await fireAwaitsForKey({ eventKey });
    await insertDeliveries({ awaits: [fired!], source: 'loop:test', payload: { wakeCount: 1 } });

    expect(await clearExplicitInboxWakePark(subscriberId)).toBe(true);
    expect(await clearExplicitInboxWakePark(subscriberId)).toBe(false);
    const active = await listActiveAwaits(subscriberId);
    const resumed = active.find((row) => row.id === standing.id)!;
    expect(resumed.note).not.toContain('[coord:await-inbox:explicit-park]');
    expect(resumed.wakeHandle).toEqual({ sessionId: 'native-worker' });
    expect(resumed.minSleepSec).toBe(17);
    expect(resumed.once).toBe(false);
    expect(active.find((row) => row.id === deliberate.id)?.note).toBe(note);
    expect((await listActiveAwaits('still-parked')).find((row) => row.id === peer.id)?.note).toBe(note);
    expect(await rootSql`SELECT status FROM harness_shared.event_wake_deliveries WHERE await_id=${standing.id}`)
      .toEqual([{ status: 'pending' }]);
    expect((await listParkedAwaitsForSubscribers([subscriberId])).map((row) => row.eventKey))
      .toEqual(['work-item:done:dependency']);
  });

  it('fireAwaitsForKey claims a one-shot EXACTLY ONCE; a standing watch keeps matching', async () => {
    await registerAwait({ subscriberId: 'one', eventKey: 'k:fire', once: true });
    await registerAwait({ subscriberId: 'standing', eventKey: 'k:fire', once: false });

    const first = await fireAwaitsForKey({ eventKey: 'k:fire' });
    expect(first.map((a) => a.subscriberId).sort()).toEqual(['one', 'standing']); // both on the first emit

    const second = await fireAwaitsForKey({ eventKey: 'k:fire' });
    expect(second.map((a) => a.subscriberId)).toEqual(['standing']); // one-shot NOT re-fired; standing still matches
    // listActiveAwaitsForKey now sees only the standing one (the one-shot has fired_at)
    expect((await listActiveAwaitsForKey('k:fire')).map((a) => a.subscriberId)).toEqual(['standing']);
  });

  it('finds only timed-out awaits replaced by a newer active exact-key wait for the same subscriber', async () => {
    const subscriberId = 'timeout-supersession-owner';
    const eventKey = 'conversation:answered:timeout-supersession';
    const timedOut = await registerAwait({
      subscriberId,
      eventKey,
      timeoutSec: 60,
      timeoutBehavior: 'wake',
    });
    const differentKeyTimedOut = await registerAwait({
      subscriberId,
      eventKey: 'conversation:answered:different-key',
      timeoutSec: 60,
      timeoutBehavior: 'wake',
    });
    const peerTimedOut = await registerAwait({
      subscriberId: 'timeout-supersession-peer',
      eventKey,
      timeoutSec: 60,
      timeoutBehavior: 'wake',
    });
    const timedOutIds = [timedOut.id, differentKeyTimedOut.id, peerTimedOut.id];
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET expires_ts = now() - interval '1 second'
       WHERE id = ANY(${rootSql.array(timedOutIds)}::bigint[])
    `;
    const fired = await fireTimedOutAwaits();
    expect(fired.map((row) => row.id)).toEqual(expect.arrayContaining(timedOutIds));

    await registerAwait({ subscriberId, eventKey });
    await registerAwait({ subscriberId: 'timeout-supersession-peer', eventKey });
    const cancelledReplacement = await registerAwait({
      subscriberId,
      eventKey: 'conversation:answered:different-key',
    });
    await cancelAwait({ awaitId: cancelledReplacement.id, subscriberId });

    await expect(findSupersededTimeoutAwaitIds(subscriberId, [...timedOutIds, 9_999_999]))
      .resolves.toEqual([timedOut.id]);
    await expect(findSupersededTimeoutAwaitIds(subscriberId, []))
      .resolves.toEqual([]);
  });

  it('recovers a consumed wake after a producer dies before delivery insertion, once only', async () => {
    const pending = await registerAwait({ subscriberId: 'crash-waiter', eventKey: 'work-item:done:WI-crash' });
    const [fired] = await fireAwaitsForKey({
      eventKey: pending.eventKey,
      payload: { itemId: 'WI-crash', completionIntentId: 'intent-1' },
      source: 'work-items:complete',
    });
    expect(fired?.firedPayload).toEqual({ itemId: 'WI-crash', completionIntentId: 'intent-1' });
    expect(await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${pending.id}`).toHaveLength(0);

    // This is the crash window: the fired row committed, but the producer never
    // called insertDeliveries. Age it past the sweep grace without sleeping.
    await rootSql`UPDATE harness_shared.event_awaits SET fired_at = now() - interval '3 seconds' WHERE id = ${pending.id}`;
    expect(await reconcileFiredWakeDeliveries()).toBe(1);
    const delivery = await rootSql`
      SELECT subscriber_id, event_key, payload, source FROM harness_shared.event_wake_deliveries
       WHERE await_id = ${pending.id}
    `;
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({
      subscriber_id: 'crash-waiter',
      event_key: 'work-item:done:WI-crash',
      payload: { itemId: 'WI-crash', completionIntentId: 'intent-1' },
      source: 'work-items:complete',
    });

    // A resumed producer and another sweep cannot create a second wake.
    expect(await insertDeliveries({ awaits: [fired!], payload: { itemId: 'WI-crash' } })).toBe(0);
    expect(await reconcileFiredWakeDeliveries()).toBe(0);
    expect(await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${pending.id}`).toHaveLength(1);
  });

  it('does NOT resurrect a historical fired await without a delivery-intent marker', async () => {
    // A pre-migration fired row has no proof it owes a new delivery. Its old
    // missing ledger row must not respawn a subscriber after weeks of silence.
    const ancient = await registerAwait({ subscriberId: 'ancient-waiter', eventKey: 'work-item:claimable' });
    await fireAwaitsForKey({ eventKey: ancient.eventKey, payload: { eventKey: ancient.eventKey } });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now() - interval '37 days', fired_delivery_intent_at = NULL
       WHERE id = ${ancient.id}
    `;

    // A fresh crash-window row must still be recovered by the same sweep, so a
    // green result cannot come from the sweep simply doing nothing.
    const recent = await registerAwait({ subscriberId: 'recent-waiter', eventKey: 'work-item:done:WI-recent' });
    await fireAwaitsForKey({ eventKey: recent.eventKey, payload: { itemId: 'WI-recent' } });
    await rootSql`UPDATE harness_shared.event_awaits SET fired_at = now() - interval '3 seconds' WHERE id = ${recent.id}`;

    expect(await reconcileFiredWakeDeliveries()).toBe(1); // the recent one only
    expect(
      await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${ancient.id}`,
    ).toHaveLength(0);
    expect(
      await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${recent.id}`,
    ).toHaveLength(1);

    // Still inert on every later sweep — not merely deferred past one pass.
    expect(await reconcileFiredWakeDeliveries()).toBe(0);
    expect(
      await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${ancient.id}`,
    ).toHaveLength(0);
  });

  it('recovers a marked delivery intent after a long outage instead of imposing an age ceiling', async () => {
    const pending = await registerAwait({ subscriberId: 'outage-waiter', eventKey: 'work-item:done:WI-outage' });
    await fireAwaitsForKey({ eventKey: pending.eventKey, payload: { itemId: 'WI-outage' } });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now() - interval '37 days',
             fired_delivery_intent_at = now() - interval '37 days'
       WHERE id = ${pending.id}
    `;
    expect(await reconcileFiredWakeDeliveries()).toBe(1);
    expect(await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${pending.id}`).toHaveLength(1);
  });

  it('recovers a timeout wake but never replays an expired await', async () => {
    const wake = await registerAwait({ subscriberId: 'timeout-waiter', eventKey: 'timeout:intent', timeoutSec: 60, timeoutBehavior: 'wake' });
    const expire = await registerAwait({ subscriberId: 'expire-waiter', eventKey: 'expire:no-intent', timeoutSec: 60, timeoutBehavior: 'expire' });
    await rootSql`
      UPDATE harness_shared.event_awaits SET expires_ts = now() - interval '1 second'
       WHERE id IN (${wake.id}, ${expire.id})
    `;
    expect((await fireTimedOutAwaits()).map((row) => row.id)).toContain(wake.id);
    expect(await expireLapsedAwaits()).toBe(1);
    const rows = await rootSql`
      SELECT id, fired_delivery_intent_at FROM harness_shared.event_awaits
       WHERE id IN (${wake.id}, ${expire.id}) ORDER BY id
    `;
    expect(rows[0].fired_delivery_intent_at).not.toBeNull();
    expect(rows[1].fired_delivery_intent_at).toBeNull();
    await rootSql`
      UPDATE harness_shared.event_awaits SET fired_at = now() - interval '3 seconds'
       WHERE id = ${wake.id}
    `;
    expect(await reconcileFiredWakeDeliveries()).toBe(1);
    expect(await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${wake.id}`).toHaveLength(1);
    expect(await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${expire.id}`).toHaveLength(0);
  });

  it('matches filtered timeout suppression against the latched key-fire payload', async () => {
    const mismatched = await registerAwait({
      subscriberId: 'filtered-timeout-mismatch',
      eventKey: 'timeout:filtered:mismatch',
      timeoutSec: 60,
      timeoutBehavior: 'wake',
      payloadFilter: { installId: 'papercusp' },
    });
    const matching = await registerAwait({
      subscriberId: 'filtered-timeout-match',
      eventKey: 'timeout:filtered:match',
      timeoutSec: 60,
      timeoutBehavior: 'wake',
      payloadFilter: { installId: 'papercusp' },
    });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET created_at = now() - interval '2 minutes',
             expires_ts = now() - interval '1 minute'
       WHERE id IN (${mismatched.id}, ${matching.id})
    `;

    await Promise.all([
      recordKeyFire({ eventKey: mismatched.eventKey, payload: { installId: 'restart' } }),
      recordKeyFire({ eventKey: matching.eventKey, payload: { installId: 'papercusp' } }),
    ]);
    await rootSql`
      UPDATE harness_shared.event_key_fires
         SET last_fired_at = now() - interval '90 seconds'
       WHERE event_key IN (${mismatched.eventKey}, ${matching.eventKey})
    `;

    const timedOut = await fireTimedOutAwaits();
    const timedOutIds = timedOut.map((row) => row.id);
    expect(timedOutIds).toContain(mismatched.id);
    expect(timedOutIds).not.toContain(matching.id);
  });

  it('does not claim exact or pattern one-shot awaits after their deadline', async () => {
    const exact = await registerAwait({
      subscriberId: 'expired-exact',
      eventKey: 'expired:exact',
      timeoutSec: 60,
    });
    const filteredExact = await registerAwait({
      subscriberId: 'expired-filtered-exact',
      eventKey: 'expired:filtered-exact',
      timeoutSec: 60,
      payloadFilter: { ready: true },
    });
    const pattern = await registerAwait({
      subscriberId: 'expired-pattern',
      eventKey: 'expired:pattern:*',
      timeoutSec: 60,
      payloadFilter: { ready: true },
    });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET expires_ts = now() - interval '1 second'
       WHERE id IN (${exact.id}, ${filteredExact.id}, ${pattern.id})
    `;

    expect(await fireAwaitsForKey({ eventKey: exact.eventKey, payload: { ready: true } })).toEqual([]);
    expect(await fireAwaitsForKey({ eventKey: filteredExact.eventKey, payload: { ready: true } })).toEqual([]);
    expect(await fireAwaitsForKey({ eventKey: 'expired:pattern:one', payload: { ready: true } })).toEqual([]);
    const rows = await rootSql<{ id: number; fired_at: Date | null }[]>`
      SELECT id, fired_at FROM harness_shared.event_awaits
       WHERE id IN (${exact.id}, ${filteredExact.id}, ${pattern.id})
       ORDER BY id
    `;
    expect(rows.map((row) => row.fired_at)).toEqual([null, null, null]);
  });

  it('serializes a recovery sweep against the original one-shot delivery writer', async () => {
    const pending = await registerAwait({ subscriberId: 'race-waiter', eventKey: 'work-item:done:WI-race' });
    const [fired] = await fireAwaitsForKey({ eventKey: pending.eventKey, payload: { result: 'settled' } });
    await rootSql`UPDATE harness_shared.event_awaits SET fired_at = now() - interval '3 seconds' WHERE id = ${pending.id}`;
    const [normal, recovered] = await Promise.all([
      insertDeliveries({ awaits: [fired!], payload: { result: 'settled' } }),
      reconcileFiredWakeDeliveries(),
    ]);
    expect(normal + recovered).toBe(1);
    expect(await rootSql`SELECT id FROM harness_shared.event_wake_deliveries WHERE await_id = ${pending.id}`).toHaveLength(1);
  });

  it('serializes announcement latching behind the per-key generation lock', async () => {
    const eventKey = 'gate:announcement-race';
    await registerAnnouncement({
      subscriberId: 'declarer',
      eventKey,
      scopeKind: 'global',
      note: 'generation one',
    });

    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = rootSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + eventKey}, 0))`;
      await holderReleased;
    });

    let stampSettled = false;
    let stampPromise: Promise<number> | undefined;
    try {
      await waitForAnnouncementAdvisoryLock(eventKey, 'held');
      stampPromise = stampAnnouncementsFired(eventKey, { firedBy: 'emit-race', payload: { n: 1 } });
      stampPromise.then(
        () => {
          stampSettled = true;
        },
        () => {
          stampSettled = true;
        },
      );
      await waitForAnnouncementAdvisoryLock(eventKey, 'waiting');
      expect(stampSettled).toBe(false);
    } finally {
      releaseHolder();
      await holder;
      if (stampPromise) await stampPromise;
    }

    expect(
      await rootSql`
      SELECT fired_at FROM harness_shared.event_awaits
       WHERE event_key = ${eventKey} AND causal_generation = 1
    `,
    ).toEqual([expect.objectContaining({ fired_at: expect.anything() })]);
  });

  it('persists an announcement lifecycle binding for successor resolution', async () => {
    const eventKey = 'gate:announcement-bound-owner';
    const row = await registerAnnouncement({
      subscriberId: 'ended-leader',
      eventKey,
      scopeKind: 'fleet',
      scopeRef: 'fleet-a',
      boundTo: { kind: 'fleet-leadership', ref: 'fleet-a' },
    });

    expect(row.boundTo).toEqual({ kind: 'fleet-leadership', ref: 'fleet-a' });
    expect((await rootSql`
      SELECT bound_to FROM harness_shared.event_awaits WHERE id = ${row.id}
    `).map((r) => r.bound_to)).toEqual([{ kind: 'fleet-leadership', ref: 'fleet-a' }]);
  });

  it('preserves an unfired announcement when its declarer is reaped', async () => {
    const owner = 'ended-leader';
    const binding = { kind: 'role', ref: 'operator' };
    const eventKey = 'gate:announcement-survives-owner-reap';
    const announcement = await registerAnnouncement({
      subscriberId: owner,
      eventKey,
      scopeKind: 'global',
      boundTo: binding,
    });
    const ordinary = await registerAwait({
      subscriberId: owner,
      eventKey: 'lifecycle:ordinary-watch',
      once: false,
      boundTo: binding,
    });

    await expect(retireWatchesForReapedOwners([owner])).resolves.toEqual({
      awaits: 1,
      predicateWatches: 0,
    });

    const stored = await rootSql`
      SELECT policy, cancelled_at, superseded_at, fired_at
        FROM harness_shared.event_awaits
       WHERE id IN (${announcement.id}, ${ordinary.id})
       ORDER BY id
    `;
    expect(stored).toEqual([
      {
        policy: 'announce',
        cancelled_at: null,
        superseded_at: null,
        fired_at: null,
      },
      {
        policy: 'wake',
        cancelled_at: expect.anything(),
        superseded_at: null,
        fired_at: null,
      },
    ]);
    expect((await findAnnouncementsForKey(eventKey)).map((row) => row.id)).toEqual([announcement.id]);
  });

  // WI-10002094 recurrence guard. A MANUAL `events:await` registration carries
  // bound_to=NULL. The reaper used to require bound_to IS NOT NULL, so these
  // survived their owner's death forever and accumulated without bound (370
  // retirable orphans over 249 dead sessions when measured). The presence row
  // is deleted right after this sweep, so it is the LAST edge that can ever
  // reach them — anything skipped here is stranded permanently.
  //
  // If this fails with the manual await still active, the bound_to filter has
  // been reintroduced on the event_awaits leg.
  it('retires a reaped owner\'s MANUAL (bound_to=NULL) await while preserving its declared gate', async () => {
    const owner = 'reaped-manual-owner';
    const manual = await registerAwait({
      subscriberId: owner,
      eventKey: 'manual:stranded-on-death',
      once: false,
    });
    const gate = await registerAnnouncement({
      subscriberId: owner,
      eventKey: 'gate:survives-owner-reap',
      scopeKind: 'global',
    });
    // Calibration: without this the assertions below could pass vacuously on a
    // fixture that never had an unbound await in the first place. Note
    // listActiveAwaits surfaces only 'wake' rows — the announce gate is
    // discovered through findAnnouncementsForKey, not here.
    expect(manual.boundTo).toBeNull();
    expect((await listActiveAwaits(owner)).map((r) => r.id)).toEqual([manual.id]);

    await expect(retireWatchesForReapedOwners([owner])).resolves.toEqual({
      awaits: 1,
      predicateWatches: 0,
    });

    // The manual await is gone; the declared gate is NOT (custody transfers to
    // a successor, so it must outlive its announcer).
    expect(await listActiveAwaits(owner)).toEqual([]);
    expect((await findAnnouncementsForKey('gate:survives-owner-reap')).map((r) => r.id)).toEqual([
      gate.id,
    ]);
    const stored = await rootSql`
      SELECT policy, cancelled_at FROM harness_shared.event_awaits
       WHERE id IN (${manual.id}, ${gate.id}) ORDER BY id`;
    expect(stored).toEqual([
      { policy: 'wake', cancelled_at: expect.anything() },
      { policy: 'announce', cancelled_at: null },
    ]);
  });

  it('retires only the unfired announcement, preserves its waiter, and removes it from discovery', async () => {
    const eventKey = 'gate:announcement-retire';
    const announcement = await registerAnnouncement({
      subscriberId: 'declarer',
      eventKey,
      scopeKind: 'global',
      logicalGateKey: 'logical-retire',
    });
    const waiter = await registerAwait({ subscriberId: 'waiter', eventKey });

    const retired = await retireAnnouncement({
      announcementId: announcement.id,
      subscriberId: 'declarer',
      expectedGeneration: announcement.causalGeneration ?? undefined,
    });
    expect(retired).toMatchObject({
      retired: true,
      announcementId: announcement.id,
      eventKey,
      generation: announcement.causalGeneration,
    });
    expect(await listActiveAnnouncements()).toEqual([]);
    expect((await findAnnouncementsForKey(eventKey)).map((row) => row.id)).toEqual([]);

    const fired = await fireAwaitsForKey({ eventKey });
    expect(fired.map((row) => row.id)).toEqual([waiter.id]);
    const stored = await rootSql`
      SELECT fired_at, superseded_at FROM harness_shared.event_awaits WHERE id = ${announcement.id}
    `;
    expect(stored[0].fired_at).toBeNull();
    expect(stored[0].superseded_at).not.toBeNull();
  });

  it('exposes a cancelled current generation only for stale-pin diagnostics', async () => {
    const eventKey = 'gate:cancelled-generation-diagnostic';
    const announcement = await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET cancelled_at = now()
       WHERE id = ${announcement.id}
    `;

    expect(await findAnnouncementsForKey(eventKey)).toEqual([]);
    expect((await findAnnouncementsForKey(eventKey, { includeCancelled: true })).map((row) => row.id)).toEqual([
      announcement.id,
    ]);
  });

  it('recordKeyFire reports announcementPending only while an unfired current announcement exists (WI-10003631)', async () => {
    const eventKey = 'gate:announce-probe';
    // No announcement → the emit may skip the locked stamp.
    expect(await recordKeyFire({ eventKey })).toMatchObject({ announcementPending: false });
    await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    // Unfired announcement → the emit must take the locked stamp path.
    expect(await recordKeyFire({ eventKey })).toMatchObject({ announcementPending: true });
    expect(await stampAnnouncementsFired(eventKey, { firedBy: 'emit' })).toBe(1);
    // Latched → no pending gate; the latch still counts every fire.
    expect(await recordKeyFire({ eventKey })).toMatchObject({ announcementPending: false });
    const [latch] = await rootSql`
      SELECT fire_count FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}
    `;
    expect(Number(latch.fire_count)).toBe(3);
  });

  it('recordKeyFire returns the fire identity of exactly the fire it recorded; a clear + re-fire mints a new one (P-018 D-029 §2)', async () => {
    const eventKey = 'gate:fire-identity-probe';
    const first = await recordKeyFire({ eventKey });
    const second = await recordKeyFire({ eventKey });
    expect(first.fire?.count).toBe(1);
    expect(second.fire?.count).toBe(2);
    // first_fired_at survives the upsert, so the two fires differ only by count.
    expect(first.fire?.firstFiredAtUs).toMatch(/^\d{16}$/);
    expect(second.fire?.firstFiredAtUs).toBe(first.fire?.firstFiredAtUs);
    const [row] = await rootSql`
      SELECT floor(extract(epoch FROM first_fired_at) * 1000000)::bigint::text AS us
        FROM harness_shared.event_key_fires WHERE event_key = ${eventKey}
    `;
    expect(first.fire?.firstFiredAtUs).toBe(row.us);
    expect(keyFireId(eventKey, second.fire!)).toBe(`${eventKey}@${row.us}#2`);

    // A reopen clears the latch; the next fire restarts at count 1 with a NEW
    // first_fired_at, so its id can never collide with the pre-clear fire #1.
    await clearKeyFire(eventKey, { firedBefore: Date.now() + 1000 });
    const refired = await recordKeyFire({ eventKey });
    expect(refired.fire?.count).toBe(1);
    expect(refired.fire?.firstFiredAtUs).not.toBe(first.fire?.firstFiredAtUs);
    expect(keyFireId(eventKey, refired.fire!)).not.toBe(keyFireId(eventKey, first.fire!));
  });

  it('recordKeyFire folds the active event-key subscriber read into the latch statement (WI-10003631)', async () => {
    const eventKey = 'gate:subscriber-fold-probe';
    const from = { workspaceId: 'ws-sub-fold', targetKind: 'event' };
    // Omitted scope → no subscriber field (the emit falls back to its own read).
    expect(await recordKeyFire({ eventKey })).not.toHaveProperty('eventSubscribers');
    expect(await recordKeyFire({ eventKey, subscribersFrom: from }))
      .toMatchObject({ announcementPending: false, eventSubscribers: [] });
    await rootSql`
      INSERT INTO harness_shared.coord_entity_subscriptions
        (id, workspace_id, subscriber_id, target_kind, target_ref, delivery_mode, created_at, cancelled_at, expires_ts,
         derived_from_kind, derived_from_ref)
      VALUES
        (1, ${from.workspaceId}, 'late', 'event', ${eventKey}, 'full', now(), NULL, NULL, NULL, NULL),
        (2, ${from.workspaceId}, 'early', 'event', ${eventKey}, 'muted', now() - interval '1 minute', NULL, NULL,
         'identity-rule', 'su-wearer'),
        (3, ${from.workspaceId}, 'cancelled', 'event', ${eventKey}, 'full', now(), now(), NULL, NULL, NULL),
        (4, ${from.workspaceId}, 'expired', 'event', ${eventKey}, 'full', now(), NULL, now() - interval '1 second', NULL, NULL),
        (5, 'other-ws', 'foreign', 'event', ${eventKey}, 'full', now(), NULL, NULL, NULL, NULL),
        (6, ${from.workspaceId}, 'topic-sub', 'topic', ${eventKey}, 'full', now(), NULL, NULL, NULL, NULL)
    `;
    // Active rows only, in created order; muted rows are returned (the emit filters
    // them), and the derived-from pair rides along so the emit can recognise
    // machine-maintained rows by column (P-018 D-029 §2).
    const folded = await recordKeyFire({ eventKey, subscribersFrom: from });
    expect(folded.announcementPending).toBe(false);
    expect(folded.fire?.count).toBe(3);
    expect(folded.eventSubscribers).toEqual([
      { subscriber_id: 'early', delivery_mode: 'muted', derived_from_kind: 'identity-rule', derived_from_ref: 'su-wearer' },
      { subscriber_id: 'late', delivery_mode: 'full', derived_from_kind: null, derived_from_ref: null },
    ]);
  });

  it('discovers fired announcement history after cancellation and ignores unannounced fire latches', async () => {
    const eventKey = 'fleet:fleet-a:owner-resume';
    const first = await registerAnnouncement({
      subscriberId: 'declarer',
      eventKey,
      scopeKind: 'fleet',
      scopeRef: 'fleet-a',
    });
    await recordKeyFire({ eventKey, firedBy: 'fleet-resume' });
    await stampAnnouncementsFired(eventKey, { firedBy: 'fleet-resume' });
    const current = await registerAnnouncement({
      subscriberId: 'declarer',
      eventKey,
      scopeKind: 'fleet',
      scopeRef: 'fleet-a',
    });
    expect(current.causalGeneration).toBeGreaterThan(first.causalGeneration!);
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET cancelled_at = now()
       WHERE id = ${current.id}
    `;
    await recordKeyFire({ eventKey: 'not-announced:arbitrary' });

    expect(await listActiveAnnouncements({ unfiredOnly: false })).toEqual([]);
    const discovered = await listFiredAnnouncements({ limit: 10 });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].announcement).toMatchObject({
      id: first.id,
      eventKey,
      scopeKind: 'fleet',
      scopeRef: 'fleet-a',
    });
    expect(discovered[0].fireLatch).toMatchObject({ eventKey, fireCount: 1 });
  });

  it('retirement clears the matching event blocker and restores an auto-blocked issue', async () => {
    const eventKey = 'gate:announcement-retire-reconciles-blocker';
    const announcement = await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES (
        'EI-retire-reconcile', 'blocked', 'bug',
        ${JSON.stringify({
          _claimHold: true,
          held_open_by: 'test-agent',
          held_open_reason: 'blocked',
          externalBlockers: [eventBlocker(eventKey)],
        })}::text::jsonb
      )
    `;

    await expect(
      retireAnnouncement({ announcementId: announcement.id, subscriberId: 'declarer' }),
    ).resolves.toMatchObject({ retired: true });
    // P-003: retirement hands exactly what it settled to the shared follow-up, in one call.
    expect(followUp.calls.map((items) => items.map((i) => i.featureId))).toEqual([['EI-retire-reconcile']]);

    const rows = await rootSql`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE feature_id = 'EI-retire-reconcile'
    `;
    expect(rows[0].status).toBe('open');
    expect(rows[0].payload).toMatchObject({
      externalBlockers: [
        expect.objectContaining({ kind: 'event', ref: eventKey, status: 'cleared', clearedBy: 'declarer' }),
      ],
    });
    expect(rows[0].payload).not.toHaveProperty('_claimHold');
    expect(rows[0].payload).not.toHaveProperty('held_open_reason');
  });

  // EI-25231851216237441: renewing a declaration does not fire its gate.
  it.each([false, true])('same-key announcement renewal preserves active event blockers (unrelated blocker: %s)', async (withUnrelatedBlocker) => {
    const eventKey = 'gate:announcement-supersede-reconciles-blocker';
    const first = await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    const blockers = [eventBlocker(eventKey), ...(withUnrelatedBlocker ? [runtimeBlocker()] : [])];
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES (
        'EI-supersede-reconcile', 'blocked', 'bug',
        ${JSON.stringify({
          _claimHold: true,
          held_open_by: 'test-agent',
          held_open_reason: 'blocked',
          externalBlockers: blockers,
        })}::text::jsonb
      )
    `;

    const second = await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    expect(second.causalGeneration).toBeGreaterThan(first.causalGeneration ?? 0);
    expect(second.firedAt).toBeNull();
    expect(second.firedReason).toBeNull();
    expect(await getKeyFireLatch(eventKey)).toBeNull();

    const rows = await rootSql`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE feature_id = 'EI-supersede-reconcile'
    `;
    expect(rows[0].status).toBe('blocked');
    expect(rows[0].payload.externalBlockers).toEqual(blockers);
    expect(rows[0].payload).toHaveProperty('_claimHold', true);
    expect(rows[0].payload).toHaveProperty('held_open_reason', 'blocked');
  });

  // EI-20721448404004954: a real fire must settle blockers as explicit retirement
  // does. Renewing the declaration above is not a settlement path.
  it('firing clears the matching event blocker and restores an auto-blocked issue', async () => {
    const eventKey = 'gate:announcement-fire-reconciles-blocker';
    const otherKey = 'gate:announcement-fire-unrelated-gate';
    await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES (
        'EI-fire-reconcile', 'blocked', 'bug',
        ${JSON.stringify({
          _claimHold: true,
          held_open_by: 'test-agent',
          held_open_reason: 'blocked',
          externalBlockers: [eventBlocker(eventKey)],
        })}::text::jsonb
      )
    `;
    // CONTROL: an item parked on a DIFFERENT gate must be left untouched, so a
    // reconciler that cleared every event blocker could not pass this test.
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES (
        'EI-fire-reconcile-control', 'blocked', 'bug',
        ${JSON.stringify({
          _claimHold: true,
          held_open_by: 'test-agent',
          held_open_reason: 'blocked',
          externalBlockers: [eventBlocker(otherKey)],
        })}::text::jsonb
      )
    `;

    await expect(stampAnnouncementsFired(eventKey, { firedBy: 'emit' })).resolves.toBe(1);
    // P-003: the fire hands exactly what it settled to the shared follow-up, in one call.
    expect(followUp.calls.map((items) => items.map((i) => i.featureId))).toEqual([['EI-fire-reconcile']]);

    const rows = await rootSql`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE feature_id = 'EI-fire-reconcile'
    `;
    expect(rows[0].status).toBe('open');
    expect(rows[0].payload).toMatchObject({
      externalBlockers: [
        expect.objectContaining({ kind: 'event', ref: eventKey, status: 'cleared', clearedBy: 'emit' }),
      ],
    });
    expect(rows[0].payload).not.toHaveProperty('_claimHold');
    expect(rows[0].payload).not.toHaveProperty('held_open_reason');

    const control = await rootSql`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE feature_id = 'EI-fire-reconcile-control'
    `;
    expect(control[0].status).toBe('blocked');
    expect(control[0].payload).toMatchObject({
      externalBlockers: [expect.objectContaining({ kind: 'event', ref: otherKey, status: 'active' })],
    });
  });

  it('a pause completion event retains the owner pause while releasing an ordinary dependency', async () => {
    const eventKey = 'work-item:done:WI-pause-task';
    await registerAnnouncement({ subscriberId: 'pause-driver', eventKey, scopeKind: 'global' });
    const pausePayload = {
      _claimHold: true, claim_hold_by: 'pause-driver', claim_hold_reason: 'owner-directed pause',
      claim_hold_at: '2026-09-24T23:34:00.000Z',
      claim_hold_release: {
        condition: 'WI-pause-task reaches terminal done, ending this system-wide pause.',
        owner: 'pause-driver', trigger: eventKey, reachability: 'satisfied', evidence: 'pause task completed',
      },
      keepMe: { ownerDecision: 'retain until explicit resume' },
    };
    const dependencyPayload = { ...pausePayload, claim_hold_reason: 'wait for the pause notification task',
      claim_hold_release: { ...pausePayload.claim_hold_release, condition: 'the notification task completes' } };
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES ('EI-pause-contract', 'open', 'bug', ${JSON.stringify(pausePayload)}::text::jsonb),
             ('EI-pause-dependency-control', 'open', 'bug', ${JSON.stringify(dependencyPayload)}::text::jsonb)`;
    await expect(stampAnnouncementsFired(eventKey, { firedBy: 'pause-driver' })).resolves.toBe(1);
    const rows = await rootSql<{ feature_id: string; status: string; payload: Record<string, unknown> }[]>`
      SELECT feature_id, status, payload FROM harness_shared.work_items ORDER BY feature_id`;
    const pause = rows.find(row => row.feature_id === 'EI-pause-contract')!;
    expect(pause.status).toBe('open');
    expect(pause.payload).toEqual(pausePayload);
    const control = rows.find(row => row.feature_id === 'EI-pause-dependency-control')!;
    expect(control.payload).toEqual({ keepMe: pausePayload.keepMe });
    const receipts = await rootSql<{ subject: string }[]>`
      SELECT subject FROM harness_shared.audit_log WHERE action = 'work_items:durable_park:clear' ORDER BY subject`;
    expect(receipts.map(row => row.subject)).toEqual(['EI-pause-dependency-control']);

    // Repairing the contract retains the park. Only this episode's explicit
    // resume event may subsequently release it; repeating the pause event cannot.
    const resumeKey = 'owner-resume:pause-episode:WI-pause-task';
    await registerAnnouncement({ subscriberId: 'resume-authority-driver', eventKey: resumeKey, scopeKind: 'global' });
    const repairedPayload = { ...pausePayload, claim_hold_release: {
      condition: 'Verified explicit owner resume for pause episode WI-pause-task is recorded.',
      owner: 'resume-authority-driver', trigger: resumeKey,
      reachability: 'reachable', evidence: 'episode-specific resume declaration, not yet fired',
    } };
    await rootSql`
      UPDATE harness_shared.work_items SET payload = ${JSON.stringify(repairedPayload)}::text::jsonb
      WHERE feature_id = 'EI-pause-contract'`;
    await stampAnnouncementsFired(eventKey, { firedBy: 'pause-driver' });
    const retained = await rootSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.work_items WHERE feature_id = 'EI-pause-contract'`;
    expect(retained[0].payload).toEqual(repairedPayload);
    await expect(stampAnnouncementsFired(resumeKey, { firedBy: 'resume-authority-driver' })).resolves.toBe(1);
    const resumed = await rootSql<{ status: string; payload: Record<string, unknown> }[]>`
      SELECT status, payload FROM harness_shared.work_items WHERE feature_id = 'EI-pause-contract'`;
    expect(resumed[0]).toEqual({ status: 'open', payload: { keepMe: pausePayload.keepMe } });
    const resumeReceipts = await rootSql<{ subject: string; trigger: string }[]>`
      SELECT subject, details->>'trigger' AS trigger FROM harness_shared.audit_log
      WHERE action = 'work_items:durable_park:clear' AND subject = 'EI-pause-contract'`;
    expect(resumeReceipts).toEqual([{ subject: 'EI-pause-contract', trigger: resumeKey }]);
  });

  it('firing clears only matching typed durable parks and preserves a coexisting lease', async () => {
    const eventKey = 'gate:announcement-fire-releases-durable-park';
    const otherKey = 'gate:announcement-fire-releases-durable-park-control';
    await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES
        (
          'EI-fire-durable-park', 'open', 'bug',
          ${JSON.stringify({
            _claimHold: true,
            claim_hold_by: 'park-owner',
            claim_hold_reason: 'resume when the gate opens',
            claim_hold_at: '2026-09-08T18:00:00.000Z',
            claim_hold_release: {
              condition: 'the announced gate opens',
              owner: 'gate-owner',
              trigger: eventKey,
              reachability: 'satisfied',
              evidence: 'the gate was observed fired',
            },
            keepMe: 'yes',
          })}::text::jsonb
        ),
        (
          'EI-fire-durable-park-lease', 'open', 'bug',
          ${JSON.stringify({
            _claimHold: true,
            claim_hold_by: 'park-owner',
            claim_hold_reason: 'resume when the gate opens',
            claim_hold_at: '2026-09-08T18:00:00.000Z',
            claim_hold_release: {
              condition: 'the announced gate opens',
              owner: 'gate-owner',
              trigger: eventKey,
              reachability: 'reachable',
              evidence: 'the gate is registered',
            },
            held_open_by: 'lease-owner',
            held_open_reason: 'validation still owns the lease',
            held_open_at: '2026-09-08T18:01:00.000Z',
          })}::text::jsonb
        ),
        (
          'EI-fire-durable-park-control', 'open', 'bug',
          ${JSON.stringify({
            _claimHold: true,
            claim_hold_by: 'park-owner',
            claim_hold_reason: 'wait for a different gate',
            claim_hold_at: '2026-09-08T18:00:00.000Z',
            claim_hold_release: {
              condition: 'the other gate opens',
              owner: 'gate-owner',
              trigger: otherKey,
              reachability: 'reachable',
              evidence: 'the other gate is registered',
            },
          })}::text::jsonb
        ),
        (
          'EI-fire-durable-park-assigned', 'open', 'bug',
          ${JSON.stringify({
            _claimHold: true,
            claim_hold_by: 'park-owner',
            claim_hold_reason: 'assigned work must remain parked',
            claim_hold_at: '2026-09-08T18:00:00.000Z',
            claim_hold_release: {
              condition: 'the announced gate opens',
              owner: 'gate-owner',
              trigger: eventKey,
              reachability: 'reachable',
              evidence: 'the gate is registered',
            },
          })}::text::jsonb
        )`;
    await rootSql`
      UPDATE harness_shared.work_items
         SET taken_by = 'active-worker'
       WHERE feature_id = 'EI-fire-durable-park-assigned'
    `;

    await expect(stampAnnouncementsFired(eventKey, { firedBy: 'emit' })).resolves.toBe(1);

    const rows = await rootSql<{ feature_id: string; taken_by: string | null; payload: Record<string, unknown> }[]>`
      SELECT feature_id, taken_by, payload
        FROM harness_shared.work_items
       ORDER BY feature_id
    `;
    const matching = rows.find((row) => row.feature_id === 'EI-fire-durable-park')!;
    expect(matching.payload).toMatchObject({ keepMe: 'yes' });
    expect(matching.payload).not.toHaveProperty('_claimHold');
    expect(matching.payload).not.toHaveProperty('claim_hold_by');
    expect(matching.payload).not.toHaveProperty('claim_hold_release');

    const leased = rows.find((row) => row.feature_id === 'EI-fire-durable-park-lease')!;
    expect(leased.payload).toMatchObject({
      _claimHold: true,
      held_open_by: 'lease-owner',
      held_open_reason: 'validation still owns the lease',
    });
    expect(leased.payload).not.toHaveProperty('claim_hold_by');
    expect(leased.payload).not.toHaveProperty('claim_hold_release');

    const control = rows.find((row) => row.feature_id === 'EI-fire-durable-park-control')!;
    expect(control.payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'park-owner',
      claim_hold_release: expect.objectContaining({ trigger: otherKey }),
    });

    const assigned = rows.find((row) => row.feature_id === 'EI-fire-durable-park-assigned')!;
    expect(assigned.taken_by).toBe('active-worker');
    expect(assigned.payload).toHaveProperty('claim_hold_by', 'park-owner');
    const receipts = await rootSql`SELECT subject, actor, details FROM harness_shared.audit_log
      WHERE action = 'work_items:durable_park:clear' ORDER BY subject`;
    expect(receipts.map((row) => row.subject)).toEqual(['EI-fire-durable-park', 'EI-fire-durable-park-lease']);
    expect(receipts[0]).toMatchObject({ actor: 'emit', details: { reasonCode: 'condition-satisfied',
      trigger: eventKey, priorPark: { by: 'park-owner', reason: 'resume when the gate opens',
        at: '2026-09-08T18:00:00.000Z' }, preservedLease: false } });
    expect(receipts[1].details.preservedLease).toBe(true);
    await expect(stampAnnouncementsFired(eventKey, { firedBy: 'emit' })).resolves.toBe(0);
    expect(await rootSql`SELECT id FROM harness_shared.audit_log`).toHaveLength(2);
  });

  it('rolls back the announcement fire and park clear when its audit receipt cannot commit', async () => {
    const eventKey = 'gate:audit-receipt-rollback';
    await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    const payload = { _claimHold: true, claim_hold_by: 'park-owner',
      claim_hold_release: { condition: 'gate opens', owner: 'gate-owner', trigger: eventKey,
        reachability: 'reachable', evidence: 'producer declared' } };
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES ('EI-audit-rollback', 'open', 'bug', ${JSON.stringify(payload)}::text::jsonb)`;
    await rootSql`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT reject_park_receipt
      CHECK (action <> 'work_items:durable_park:clear')`;
    try {
      await expect(stampAnnouncementsFired(eventKey, { firedBy: 'emit' })).rejects.toMatchObject({ code: '23514' });
      expect((await rootSql`SELECT payload FROM harness_shared.work_items WHERE feature_id = 'EI-audit-rollback'`)[0].payload).toEqual(payload);
      expect((await findAnnouncementsForKey(eventKey))[0].firedAt).toBeNull();
    } finally {
      await rootSql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT reject_park_receipt`;
    }
  });

  // `release:deployed:abc123` left this list with event-wait-settlement-2026-10-20 D-005:
  // the per-sha deploy key is a proving key (see the P-004 block at the end of this file).
  it.each(['work-item:claimable', 'release:deployed',
    'coord:inbox-wake:park-owner', 'fleet:item-completed:test', 'work-item:unblocked'])
  ('firing a declared broad trigger retains the specific-condition park: %s', async (eventKey) => {
    await registerAnnouncement({ subscriberId: 'declarer', eventKey, scopeKind: 'global' });
    const payload = { _claimHold: true, claim_hold_by: 'park-owner',
      claim_hold_reason: 'owner grade has not cleared', claim_hold_at: '2026-09-08T18:00:00.000Z',
      held_open_by: 'independent-reviewer', held_open_reason: 'review pending',
      claim_hold_release: { condition: 'owner grade is cleared', owner: 'grade-owner',
        trigger: eventKey, reachability: 'reachable', evidence: 'wake is registered' } };
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES ('EI-broad-fire-durable-park', 'open', 'bug', ${JSON.stringify(payload)}::text::jsonb)`;
    await expect(stampAnnouncementsFired(eventKey, { firedBy: 'unrelated-producer' })).resolves.toBe(1);
    const rows = await rootSql`SELECT payload FROM harness_shared.work_items
      WHERE feature_id = 'EI-broad-fire-durable-park'`;
    expect(rows[0].payload).toEqual(payload);
    expect(await rootSql`SELECT id FROM harness_shared.audit_log`).toHaveLength(0);
  });

  it('guards announcement retirement by owner, generation, and fired state', async () => {
    const foreign = await registerAnnouncement({ subscriberId: 'owner-a', eventKey: 'gate:retire-foreign', scopeKind: 'global' });
    await expect(retireAnnouncement({ announcementId: foreign.id, subscriberId: 'owner-b' })).resolves.toMatchObject({
      retired: false,
      reason: 'not_yours',
    });
    await expect(retireAnnouncement({ announcementId: foreign.id, subscriberId: 'owner-a', expectedGeneration: 999 })).resolves.toMatchObject({
      retired: false,
      reason: 'generation_mismatch',
    });
    await expect(retireAnnouncement({ announcementId: foreign.id, subscriberId: 'owner-a', expectedGeneration: foreign.causalGeneration ?? undefined })).resolves.toMatchObject({ retired: true });

    const fired = await registerAnnouncement({ subscriberId: 'owner-a', eventKey: 'gate:retire-fired', scopeKind: 'global' });
    await stampAnnouncementsFired('gate:retire-fired', { firedBy: 'emit' });
    await expect(retireAnnouncement({ announcementId: fired.id, subscriberId: 'owner-a' })).resolves.toMatchObject({
      retired: false,
      reason: 'already_settled',
    });
  });

  it('serializes different transport keys for one logical gate and rejects the loser', async () => {
    const results = await Promise.allSettled([
      registerAnnouncement({ subscriberId: 'route-a', eventKey: 'gate:logical-a', scopeKind: 'global', logicalGateKey: 'logical-concurrent' }),
      registerAnnouncement({ subscriberId: 'route-b', eventKey: 'gate:logical-b', scopeKind: 'global', logicalGateKey: 'logical-concurrent' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    const active = await rootSql`
      SELECT event_key FROM harness_shared.event_awaits
       WHERE logical_gate_key = 'logical-concurrent'
         AND policy = 'announce' AND superseded_at IS NULL AND cancelled_at IS NULL AND fired_at IS NULL
    `;
    expect(active).toHaveLength(1);
    expect(loser?.status).toBe('rejected');
    if (loser?.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(LogicalGateConflictError);
      expect(loser.reason).toMatchObject({ code: 'logical_gate_conflict', logicalGateKey: 'logical-concurrent' });
      expect(loser.reason.existingEventKey).toBe(active[0]!.event_key);
    }
  });

  // ── EI-8998: predicate/payload watches ───────────────────────────────────
  it('a payload_filter gates firing: a non-matching emit leaves the once-row unclaimed, a matching one claims it exactly once', async () => {
    await registerAwait({
      subscriberId: 'filtered-once',
      eventKey: 'k:threshold',
      once: true,
      payloadFilter: { queue_depth: { lt: 5 } },
    });

    const miss = await fireAwaitsForKey({ eventKey: 'k:threshold', payload: { queue_depth: 9 } });
    expect(miss).toEqual([]); // predicate failed — NOT claimed, still active
    expect((await listActiveAwaitsForKey('k:threshold')).map((a) => a.subscriberId)).toEqual(['filtered-once']);

    const hit = await fireAwaitsForKey({ eventKey: 'k:threshold', payload: { queue_depth: 2 } });
    expect(hit.map((a) => a.subscriberId)).toEqual(['filtered-once']); // predicate passed — claimed

    const again = await fireAwaitsForKey({ eventKey: 'k:threshold', payload: { queue_depth: 1 } });
    expect(again).toEqual([]); // one-shot already consumed — exactly-once holds even with a filter
  });

  it('fires a grading-integrity await with the legacy eq filter for the exact scorecard subject', async () => {
    const subjectRef = 'EI-22437875427583069';
    const awaitRow = await registerAwait({
      subscriberId: 'grading-integrity-waiter',
      eventKey: 'scorecard:emitted:grading-integrity',
      once: true,
      // Await 152428 persisted this predicate before the shared rules matcher
      // standardized on `equals`; retain the row shape so this guards the live
      // historical failure rather than only the canonical spelling.
      payloadFilter: { subjectRef: { eq: subjectRef } },
    });

    const wrongSubject = await fireAwaitsForKey({
      eventKey: 'scorecard:emitted:grading-integrity',
      payload: { issueId: 'EI-other-card', rubricRef: 'grading-integrity', subjectRef: 'EI-other-subject' },
    });
    expect(wrongSubject).toEqual([]);
    expect((await listActiveAwaitsForKey('scorecard:emitted:grading-integrity')).map((a) => a.id)).toEqual([awaitRow.id]);

    const exactSubject = await fireAwaitsForKey({
      eventKey: 'scorecard:emitted:grading-integrity',
      payload: { issueId: 'EI-22439061823369551', rubricRef: 'grading-integrity', subjectRef },
    });
    expect(exactSubject.map((a) => a.id)).toEqual([awaitRow.id]);
    expect(await listActiveAwaitsForKey('scorecard:emitted:grading-integrity')).toEqual([]);

    const persisted = await rootSql<{ fired_reason: string | null; fired_payload: unknown }[]>`
      SELECT fired_reason, fired_payload
        FROM harness_shared.event_awaits
       WHERE id = ${awaitRow.id}
    `;
    expect(persisted[0]).toMatchObject({
      fired_reason: 'event',
      fired_payload: { issueId: 'EI-22439061823369551', rubricRef: 'grading-integrity', subjectRef },
    });
  });

  it('a filter-less once row on the SAME key is unaffected by a sibling filtered row (fast path untouched)', async () => {
    await registerAwait({ subscriberId: 'plain', eventKey: 'k:mixed', once: true });
    await registerAwait({ subscriberId: 'filtered', eventKey: 'k:mixed', once: true, payloadFilter: { ok: true } });

    const fired = await fireAwaitsForKey({ eventKey: 'k:mixed', payload: { ok: false } });
    // plain fires regardless of payload; filtered does not (predicate failed)
    expect(fired.map((a) => a.subscriberId)).toEqual(['plain']);
    expect((await listActiveAwaitsForKey('k:mixed')).map((a) => a.subscriberId)).toEqual(['filtered']);
  });

  it('a standing watch with a payload_filter only appears in fired rows on matching emits, and keeps matching', async () => {
    await registerAwait({
      subscriberId: 'standing-filtered',
      eventKey: 'k:standing-threshold',
      once: false,
      payloadFilter: { severity: { gte: 3 } },
    });

    expect(await fireAwaitsForKey({ eventKey: 'k:standing-threshold', payload: { severity: 1 } })).toEqual([]);
    const first = await fireAwaitsForKey({ eventKey: 'k:standing-threshold', payload: { severity: 4 } });
    expect(first.map((a) => a.subscriberId)).toEqual(['standing-filtered']);
    // standing — still active + still matches on a second qualifying emit
    const second = await fireAwaitsForKey({ eventKey: 'k:standing-threshold', payload: { severity: 5 } });
    expect(second.map((a) => a.subscriberId)).toEqual(['standing-filtered']);
  });

  it('refreshes only filtered standing claimable watches when a claim spec revision lands', async () => {
    const filtered = await registerAwait({
      subscriberId: 'claim-spec-member',
      eventKey: 'work-item:claimable',
      once: false,
      payloadFilter: { id: { in: ['EI-old'] } },
    });
    const unscoped = await registerAwait({
      subscriberId: 'claim-spec-member',
      eventKey: 'work-item:claimable',
      once: false,
    });
    const nextFilter = { all: [{ harness: { equals: 'papercusp' } }, { id: { in: ['EI-new'] } }] };

    const refreshed = await refreshStandingClaimableAwaitPayloadFilters({
      subscriberIds: ['claim-spec-member'],
      payloadFilter: nextFilter,
    });

    expect(refreshed.map((row) => row.id)).toEqual([filtered.id]);
    const active = await listActiveAwaitsForKey('work-item:claimable');
    expect(active.find((row) => row.id === filtered.id)?.payloadFilter).toEqual(nextFilter);
    expect(active.find((row) => row.id === unscoped.id)?.payloadFilter).toBeNull();
  });

  it('a pattern (glob) watch combines key-glob matching with a payload_filter', async () => {
    await registerAwait({
      subscriberId: 'pattern-filtered',
      eventKey: 'work-item:done:*',
      once: true,
      payloadFilter: { kind: 'feature' },
    });

    // key matches the glob, but payload fails the filter — not claimed
    expect(await fireAwaitsForKey({ eventKey: 'work-item:done:WI-1', payload: { kind: 'bug' } })).toEqual([]);
    // key matches AND payload satisfies the filter — claimed
    const hit = await fireAwaitsForKey({ eventKey: 'work-item:done:WI-2', payload: { kind: 'feature' } });
    expect(hit.map((a) => a.subscriberId)).toEqual(['pattern-filtered']);
  });

  it('cancelInboxWakeAwaits / cancelAwait are subscriber-scoped and skip non-active rows', async () => {
    const key = 'coord:inbox-wake:sub-1';
    await upsertInboxWakeAwait({ subscriberId: 'sub-1', eventKey: key, wakeHandle: { sessionId: 'x' } as never });
    expect(await cancelInboxWakeAwaits('sub-1')).toBe(1); // cancelled
    expect(await cancelInboxWakeAwaits('sub-1')).toBe(0); // already cancelled → no-op
    expect(await listActiveAwaits('sub-1')).toHaveLength(0); // cancelled → not active

    const a = await registerAwait({ subscriberId: 'owner', eventKey: 'k:mine' });
    expect(await cancelAwait({ awaitId: a.id, subscriberId: 'not-owner' })).toBe(false); // cannot cancel a peer's
    expect(await cancelAwait({ awaitId: a.id, subscriberId: 'owner' })).toBe(true); // owner can
  });

  it('cancelling an await drops its queued backlog and the pump guard settles a claimed race', async () => {
    const a = await registerAwait({ subscriberId: 'owner', eventKey: 'fleet:context-critical:f1', once: false });
    await insertDeliveries({ awaits: [a], summary: 'pending' });
    await insertDeliveries({ awaits: [a], summary: 'parked' });
    await insertDeliveries({ awaits: [a], summary: 'claimed-race' });
    const inserted = await rootSql<Array<{ id: number }>>`
      SELECT id FROM harness_shared.event_wake_deliveries ORDER BY id`;
    const [pending, parked, delivering] = inserted.map((row) => Number(row.id));
    await rootSql`UPDATE harness_shared.event_wake_deliveries SET status = 'parked' WHERE id = ${parked}`;
    await rootSql`UPDATE harness_shared.event_wake_deliveries SET status = 'delivering' WHERE id = ${delivering}`;

    expect(await deliveryBacklogSummary('owner')).toMatchObject({
      total: 3,
      pending: 1,
      parked: 1,
      delivering: 1,
      fromCancelledAwaits: 0,
    });
    expect(await cancelAwaitDetailed({
      awaitId: a.id,
      subscriberId: 'owner',
      source: 'operator',
      confirmStanding: true,
    })).toMatchObject({
      awaitId: a.id,
      cancelled: true,
      eventKey: 'fleet:context-critical:f1',
      once: false,
      expiresTs: null,
      droppedDeliveries: 2,
      inFlightDeliveries: 1,
    });

    const afterCancel = await rootSql<Array<{ id: number; status: string }>>`
      SELECT id, status FROM harness_shared.event_wake_deliveries ORDER BY id`;
    expect(afterCancel.map((row) => ({ ...row, id: Number(row.id) }))).toEqual([
      { id: pending, status: 'dropped' },
      { id: parked, status: 'dropped' },
      { id: delivering, status: 'delivering' },
    ]);
    expect(await deliveryBacklogSummary('owner')).toMatchObject({
      total: 1,
      pending: 0,
      parked: 0,
      delivering: 1,
      fromCancelledAwaits: 1,
    });

    expect(await settleCancelledAwaitDeliveries([{ id: delivering }])).toEqual([delivering]);
    expect(await deliveryBacklogSummary('owner')).toMatchObject({ total: 0, fromCancelledAwaits: 0 });
  });

  it('refuses an unconfirmed standing operator cancellation without dropping its backlog', async () => {
    const a = await registerAwait({ subscriberId: 'standing-guard', eventKey: 'standing:guard', once: false });
    await insertDeliveries({ awaits: [a], summary: 'must-survive' });

    await expect(cancelAwaitDetailed({
      awaitId: a.id,
      subscriberId: 'standing-guard',
      source: 'operator',
    })).resolves.toMatchObject({
      awaitId: a.id,
      cancelled: false,
      eventKey: 'standing:guard',
      once: false,
      expiresTs: null,
      droppedDeliveries: 0,
      inFlightDeliveries: 0,
      error: 'standing_watch_requires_confirmation',
    });
    expect(await listActiveAwaits('standing-guard')).toHaveLength(1);
    expect(await deliveryBacklogSummary('standing-guard')).toMatchObject({ total: 1, pending: 1 });

    await expect(cancelAwaitDetailed({
      awaitId: a.id,
      subscriberId: 'standing-guard',
      source: 'operator',
      confirmStanding: true,
    })).resolves.toMatchObject({
      cancelled: true,
      droppedDeliveries: 1,
      inFlightDeliveries: 0,
    });
  });

  it('protects an active loop inbox-wake while preserving the loopless opt-out', async () => {
    const owner = 'looping-owner';
    const eventKey = 'coord:inbox-wake:' + owner;
    await rootSql`
      INSERT INTO harness_shared.routines (workspace_id, target_owner_id, active, reschedule_interval_sec)
      VALUES ('default', ${owner}, TRUE, 60)
    `;
    const wake = await upsertInboxWakeAwait({
      subscriberId: owner,
      eventKey,
      wakeHandle: { sessionId: 'loop-owner' } as never,
    });

    await expect(cancelAwaitDetailed({
      awaitId: wake.id,
      subscriberId: owner,
      source: 'operator',
      confirmStanding: true,
    })).resolves.toMatchObject({
      awaitId: wake.id,
      cancelled: false,
      eventKey,
      once: false,
      error: 'active_loop_inbox_wake_requires_loop_end',
    });
    expect(await listActiveAwaits(owner)).toHaveLength(1);

    await rootSql`
      UPDATE harness_shared.routines
         SET active = FALSE
       WHERE target_owner_id = ${owner}
    `;
    await expect(cancelAwaitDetailed({
      awaitId: wake.id,
      subscriberId: owner,
      source: 'operator',
      confirmStanding: true,
    })).resolves.toMatchObject({
      awaitId: wake.id,
      cancelled: true,
      eventKey,
      once: false,
    });
    expect(await listActiveAwaits(owner)).toHaveLength(0);
  });

  it('never exposes or cancels an announcement through ordinary await ids', async () => {
    const eventKey = 'gate:await-id-must-not-retire-announcement';
    const announcement = await registerAnnouncement({
      subscriberId: 'owner',
      eventKey,
      scopeKind: 'global',
    });
    const waiter = await registerAwait({ subscriberId: 'owner', eventKey });

    // events:status consumes this read. A declaration must never appear in the
    // list whose ids the tool teaches callers to pass to events:cancel.
    expect((await listActiveAwaits('owner')).map((row) => row.id)).toEqual([waiter.id]);

    // Both public self-cancel and internal by-id cancellation fail closed on
    // policy=announce. Only retireAnnouncement may settle the declaration.
    expect(await cancelAwait({ awaitId: announcement.id, subscriberId: 'owner', source: 'operator' })).toBe(false);
    expect(await cancelAwaitsByIds([announcement.id])).toBe(0);
    expect((await findAnnouncementsForKey(eventKey)).map((row) => row.id)).toEqual([announcement.id]);

    expect(await cancelAwait({ awaitId: waiter.id, subscriberId: 'owner', source: 'operator' })).toBe(true);
  });

  it('records explicit operator cancellation markers and clears them by exact subscriber/key', async () => {
    const key = 'fleet:context-critical:alpha';
    const operatorCancelled = await registerAwait({ subscriberId: 'leader', eventKey: key, once: false });
    const internalCancelled = await registerAwait({ subscriberId: 'leader', eventKey: 'fleet:drained:alpha', once: false });

    expect(await cancelAwait({
      awaitId: operatorCancelled.id,
      subscriberId: 'leader',
      source: 'operator',
      confirmStanding: true,
    })).toBe(true);
    expect(await cancelAwait({ awaitId: internalCancelled.id, subscriberId: 'leader' })).toBe(true);
    const reasons = await rootSql<Array<{ id: number; cancel_reason: string | null }>>`
      SELECT id, cancel_reason FROM harness_shared.event_awaits
       WHERE id IN (${operatorCancelled.id}, ${internalCancelled.id})`;
    expect(Object.fromEntries(reasons.map((row) => [Number(row.id), row.cancel_reason]))).toEqual({
      [operatorCancelled.id]: 'operator',
      [internalCancelled.id]: AWAIT_CANCEL_REASONS.internalCleanup,
    });
    expect(await listOperatorCancelledAwaits('leader', [key, 'fleet:drained:alpha'])).toMatchObject([
      { id: operatorCancelled.id, subscriberId: 'leader', eventKey: key },
    ]);

    expect(await clearOperatorCancelledAwaits('leader', [key, 'other:key'])).toBe(1);
    expect(await listOperatorCancelledAwaits('leader', [key])).toEqual([]);
  });

  // EI-10541: a successful claim retires its stale one-shot idle wait, while a reusable
  // once:false watch remains armed. A paused fleet explicitly retires standing wake watches.
  it('cancelClaimableAwaits cancels one-shot wake waits on claim and standing wake watches on pause', async () => {
    const standingWake = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'work-item:claimable',
      policy: 'wake',
      once: false,
      timeoutSec: 1800,
    });
    const oneShotWake = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'work-item:claimable',
      policy: 'wake',
      once: true,
    });
    const standingNotify = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'work-item:claimable',
      policy: 'notify',
      once: false,
    });
    const unrelated = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'lock:grant:xyz',
      policy: 'wake',
    });
    const peerWake = await registerAwait({
      subscriberId: 'sub-2',
      eventKey: 'work-item:claimable',
      policy: 'wake',
      once: false,
    });

    // A successful claim removes the stale one-shot wake, not the reusable watch or inbox interest.
    expect(await cancelClaimableAwaits('sub-1')).toBe(1);
    expect(await cancelClaimableAwaits('sub-1')).toBe(0);
    expect((await listActiveAwaits('sub-1')).map((r) => r.id).sort()).toEqual(
      [standingWake.id, standingNotify.id, unrelated.id].sort(),
    );

    // Exact one-shot registrations supersede each other across policies, so add this
    // notify wait after the wake wait is retired and verify claim cleanup leaves it alone.
    const oneShotNotify = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'work-item:claimable',
      policy: 'notify',
      once: true,
    });
    expect(await cancelClaimableAwaits('sub-1')).toBe(0);

    // A paused member must not be re-woken by future claimable transitions.
    expect(await cancelClaimableAwaits('sub-1', { includeStanding: true })).toBe(1);
    expect(await cancelClaimableAwaits('sub-1', { includeStanding: true })).toBe(0);
    expect((await listActiveAwaits('sub-1')).map((r) => r.id).sort()).toEqual(
      [standingNotify.id, oneShotNotify.id, unrelated.id].sort(),
    );
    expect((await listActiveAwaits('sub-2')).map((r) => r.id)).toEqual([peerWake.id]);
  });

  // EI-12457: cancelAwaitsForSubscribersOnKeys — the shared primitive behind sibling-
  // outcome cancellation (checkpoint:await's dual green/red arm) and superseded-wait
  // retirement (re-arming for a moved-on candidate).
  it("cancelAwaitsForSubscribersOnKeys cancels only the named subscribers' PENDING rows on the named keys", async () => {
    const green = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    await registerAwait({ subscriberId: 'sub-a', eventKey: 'green-checkpoint:red:papercusp' });
    const unrelated = await registerAwait({ subscriberId: 'sub-a', eventKey: 'lock:grant:xyz' });
    const peerRed = await registerAwait({ subscriberId: 'sub-b', eventKey: 'green-checkpoint:red:papercusp' });

    const cancelled = await cancelAwaitsForSubscribersOnKeys(
      ['sub-a'],
      ['green-checkpoint:red:papercusp', 'green-checkpoint:red'],
    );
    expect(cancelled).toBe(1); // only sub-a's red row

    const subA = await listActiveAwaits('sub-a');
    expect(subA.map((r) => r.id).sort()).toEqual([green.id, unrelated.id].sort()); // green + unrelated survive
    expect((await listActiveAwaits('sub-b')).map((r) => r.id)).toEqual([peerRed.id]); // peer untouched

    // idempotent: nothing left to cancel for sub-a on that key
    expect(await cancelAwaitsForSubscribersOnKeys(['sub-a'], ['green-checkpoint:red:papercusp'])).toBe(0);
    // empty inputs are a no-op, not a query
    expect(await cancelAwaitsForSubscribersOnKeys([], ['green-checkpoint:red:papercusp'])).toBe(0);
    expect(await cancelAwaitsForSubscribersOnKeys(['sub-a'], [])).toBe(0);
  });

  // EI-21338391080494784: events:await re-registration must retire the prior
  // row and insert the replacement as one serialized operation. Separate
  // cancel→insert calls let concurrent retries both observe no pending row and
  // leave duplicate active awaits for one subscriber/key.
  it('concurrent superseding registrations leave exactly one pending await for a subscriber/key', async () => {
    const subscriberId = 'sub-concurrent-rearm';
    const eventKey = 'concurrent:rearm:key';
    const registerSuperseding = (note: string) =>
      registerAwait({
        subscriberId,
        eventKey,
        note,
        supersedePending: { excludeNotePrefix: FLEET_BENCH_NOTE_PREFIX },
      } as unknown as Parameters<typeof registerAwait>[0]);

    const registrations = await Promise.all(
      Array.from({ length: 12 }, (_, index) => registerSuperseding(`re-arm-${index}`)),
    );

    expect(registrations).toHaveLength(12);
    const active = await listActiveAwaits(subscriberId);
    expect(active.filter((row) => row.eventKey === eventKey)).toHaveLength(1);

    const history = await rootSql<{ cancelled_at: string | null }[]>`
      SELECT cancelled_at
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${subscriberId} AND event_key = ${eventKey}
    `;
    expect(history).toHaveLength(12);
    expect(history.filter((row) => row.cancelled_at == null)).toHaveLength(1);
  });

  it('round-trips an obligation episode through the real await ledger and cancels it when it leaves scope', async () => {
    const ownerId = 'sub-obligation-roundtrip';
    const now = new Date();
    const deadlineAt = new Date(now.getTime() + 60_000).toISOString();
    const obligationInput: Parameters<typeof defineAgentObligation>[0] = {
      ruleId: 'plan-independent-verification',
      ruleRevision: 'v1',
      family: 'independent-verification',
      title: 'Plan needs an independent verifier',
      scope: { workspaceId: 'default', ownerId, planSlug: 'plan-a' },
      responsibleOwnerId: ownerId,
      episode: 'acceptance_ungraded:rev-1',
      status: 'due',
      authority: { kind: 'policy', sourceRef: 'plan-acceptance-gate', revision: 'v1' },
      reason: 'the canonical gate is ungraded',
      priority: 'high',
      causalRank: 2,
      applicableDemand: 1,
      sourceGeneration: 'rev-1',
      evidence: [],
      action: { kind: 'delegate', summary: 'route an independent verifier' },
      clearsWhen: {
        id: 'accepted',
        summary: 'the canonical acceptance gate passes',
        evidenceKind: 'verdict',
        sourceRef: 'plan-acceptance-gate',
      },
      changeSignal: {
        event: 'plan:acceptance:plan-a',
        nextDeadlineAt: deadlineAt,
        cancellationRef: 'plan:plan-a',
      },
    };
    const obligation = defineAgentObligation(obligationInput);
    const deps = {
      captureHandle: vi.fn(async () => ({ handle: null, note: 'integration probe' })),
      listHistory: listLifecycleBoundAwaits,
      register: registerAwait,
      cancel: cancelAwait,
    };

    const first = await reconcileAgentObligationReminders(
      { ownerId, agenda: evaluateAgentObligations([obligation], now.toISOString()), now },
      deps,
    );
    expect(first).toMatchObject({ desired: 1, registered: 1, retained: 0, cancelled: 0 });
    const registered = await listLifecycleBoundAwaits(ownerId, 'agent-obligation');
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      eventKey: 'plan:acceptance:plan-a',
      once: true,
      boundTo: { kind: 'agent-obligation', ref: obligation.id },
    });

    const warm = await reconcileAgentObligationReminders(
      { ownerId, agenda: evaluateAgentObligations([obligation], now.toISOString()), now },
      deps,
    );
    expect(warm).toMatchObject({ desired: 1, registered: 0, retained: 1, cancelled: 0 });

    // P-010: an obligation this turn did not evaluate is unknown, not resolved,
    // so an empty agenda keeps its pending reminder (retention horizon).
    const unevaluated = await reconcileAgentObligationReminders(
      { ownerId, agenda: evaluateAgentObligations([], now.toISOString()), now },
      deps,
    );
    expect(unevaluated).toMatchObject({ desired: 0, registered: 0, cancelled: 0, retainedUnevaluated: 1 });
    expect((await listLifecycleBoundAwaits(ownerId, 'agent-obligation'))[0]?.cancelledAt).toBeNull();

    // Leaving scope is a MEASURED discharge: the same obligation (same id, the
    // id ignores status) evaluated not-applicable, with no change signal left to
    // watch, cancels the row, and the real ledger keeps the reason the delivery
    // metric reads (WI-10005938).
    const discharged = defineAgentObligation({ ...obligationInput, status: 'not-applicable', changeSignal: undefined });
    expect(discharged.id).toBe(obligation.id);
    const cleared = await reconcileAgentObligationReminders(
      { ownerId, agenda: evaluateAgentObligations([discharged], now.toISOString()), now },
      deps,
    );
    expect(cleared).toMatchObject({ desired: 0, registered: 0, retained: 0, cancelled: 1 });
    const [settled] = await listLifecycleBoundAwaits(ownerId, 'agent-obligation');
    expect(settled?.cancelledAt).not.toBeNull();
    expect(settled?.cancelReason).toBe('obligation-discharged');
  });

  it('events:await supersession retires only one-shot rows and preserves the standing inbox wake', async () => {
    const subscriberId = 'sub-once-only-supersede';
    const eventKey = `coord:inbox-wake:${subscriberId}`;
    const standing = await upsertInboxWakeAwait({
      subscriberId,
      eventKey,
      wakeHandle: { sessionId: 'standing' } as never,
    });
    const registerSuperseding = (note: string) =>
      registerAwait({
        subscriberId,
        eventKey,
        note,
        supersedePending: { excludeNotePrefix: FLEET_BENCH_NOTE_PREFIX },
      });

    const first = await registerSuperseding('first one-shot');
    const replacement = await registerSuperseding('replacement one-shot');

    const active = await listActiveAwaits(subscriberId);
    expect(active.map((row) => row.id).sort()).toEqual([standing.id, replacement.id].sort());
    expect(active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: standing.id, eventKey, once: false }),
        expect.objectContaining({ id: replacement.id, eventKey, once: true, note: 'replacement one-shot' }),
      ]),
    );
    expect(first.id).not.toBe(replacement.id);
    expect(
      await rootSql<{ cancelled_at: string | null }[]>`
        SELECT cancelled_at FROM harness_shared.event_awaits WHERE id = ${first.id}
      `,
    ).toEqual([expect.objectContaining({ cancelled_at: expect.anything() })]);
    expect(
      await rootSql<{ cancelled_at: string | null }[]>`
        SELECT cancelled_at FROM harness_shared.event_awaits WHERE id = ${standing.id}
      `,
    ).toEqual([{ cancelled_at: null }]);
  });

  it('onceOnly cancellation preserves a standing watch while retiring a pending one-shot', async () => {
    const subscriberId = 'sub-once-only-cancel';
    const eventKey = 'coord:inbox-wake:sub-once-only-cancel';
    const standing = await upsertInboxWakeAwait({ subscriberId, eventKey });
    const oneShot = await registerAwait({ subscriberId, eventKey });

    expect(
      await cancelAwaitsForSubscribersOnKeys([subscriberId], [eventKey], { onceOnly: true }),
    ).toBe(1);
    expect((await listActiveAwaits(subscriberId)).map((row) => row.id)).toEqual([standing.id]);
    expect(
      await rootSql<{ cancelled_at: string | null }[]>`
        SELECT cancelled_at FROM harness_shared.event_awaits WHERE id = ${oneShot.id}
      `,
    ).toEqual([expect.objectContaining({ cancelled_at: expect.anything() })]);
  });

  it('keeps a leader-managed fleet bench out of member self-await supersede, while re-stage can retire it explicitly', async () => {
    const bench = await registerAwait({
      subscriberId: 'sub-bench',
      eventKey: 'work-item:claimable',
      note: `${FLEET_BENCH_NOTE_PREFIX}resume the staged leg`,
    });
    const memberAwait = await registerAwait({
      subscriberId: 'sub-bench',
      eventKey: 'work-item:claimable',
      note: 'member idle loop',
    });

    // events:await / the sugar surfaces supersede the member's own row, but the
    // leader-managed bench is a separate coordination owner and must survive.
    expect(
      await cancelAwaitsForSubscribersOnKeys(['sub-bench'], ['work-item:claimable'], {
        excludeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
      }),
    ).toBe(1);
    expect((await listActiveAwaits('sub-bench')).map((row) => row.id)).toEqual([bench.id]);

    // A subsequent fleet:bench stage explicitly retires the old bench before it
    // registers its replacement; this must not cancel unrelated member awaits.
    expect(
      await cancelAwaitsForSubscribersOnKeys(['sub-bench'], ['work-item:claimable'], {
        includeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
      }),
    ).toBe(1);
    expect((await listActiveAwaits('sub-bench')).map((row) => row.id)).toEqual([]);
    expect(memberAwait.id).not.toBe(bench.id);
  });

  it('atomically replaces leader-managed benches across event keys without touching member-owned awaits', async () => {
    const subscriberId = 'sub-cross-key-bench';
    const oldA = await registerAwait({
      subscriberId,
      eventKey: 'gate:old-a',
      note: `${FLEET_BENCH_NOTE_PREFIX}old A`,
    });
    const oldB = await registerAwait({
      subscriberId,
      eventKey: 'gate:old-b',
      note: `${FLEET_BENCH_NOTE_PREFIX}old B`,
    });
    const memberAwait = await registerAwait({
      subscriberId,
      eventKey: 'gate:member-owned',
      note: 'member-owned wait',
    });

    const replacements = await Promise.all(
      ['gate:new-a', 'gate:new-b'].map((eventKey) =>
        registerAwait({
          subscriberId,
          eventKey,
          note: `${FLEET_BENCH_NOTE_PREFIX}replacement`,
          supersedePending: {
            allEventKeys: true,
            includeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
          },
        }),
      ),
    );

    const active = await listActiveAwaits(subscriberId);
    const activeBenches = active.filter((row) => row.note?.startsWith(FLEET_BENCH_NOTE_PREFIX));
    expect(active.map((row) => row.id)).toContain(memberAwait.id);
    expect(activeBenches).toHaveLength(1);
    expect(replacements.map((row) => row.id)).toContain(activeBenches[0].id);
    expect(replacements.map((row) => row.supersededPendingCount).sort()).toEqual([1, 2]);
    expect(active.map((row) => row.id)).not.toContain(oldA.id);
    expect(active.map((row) => row.id)).not.toContain(oldB.id);
  });

  it('refuses subscriber-wide supersession without a coordination-surface prefix', async () => {
    await expect(
      registerAwait({
        subscriberId: 'sub-unsafe-cross-key',
        eventKey: 'gate:new',
        supersedePending: { allEventKeys: true },
      }),
    ).rejects.toThrow('allEventKeys supersession requires includeNotePrefix');
  });

  it('does not cancel an announced declaration sharing the waiter subscriber and key', async () => {
    const eventKey = 'gate:announcement-preserved';
    const announcement = await registerAnnouncement({
      subscriberId: 'sub-a',
      eventKey,
      scopeKind: 'global',
    });
    await registerAwait({ subscriberId: 'sub-a', eventKey });

    expect(await cancelAwaitsForSubscribersOnKeys(['sub-a'], [eventKey])).toBe(1);
    const activeAnnouncements = await findAnnouncementsForKey(eventKey);
    expect(activeAnnouncements.map((row) => row.id)).toEqual([announcement.id]);
    expect(activeAnnouncements[0]?.cancelledAt).toBeNull();
  });

  it('cancelAwaitsForSubscribersOnKeys never touches an already-fired row (fire wins the race)', async () => {
    await registerAwait({ subscriberId: 'sub-c', eventKey: 'green-checkpoint:red:papercusp' });
    const fired = await fireAwaitsForKey({ eventKey: 'green-checkpoint:red:papercusp' });
    expect(fired).toHaveLength(1);
    // the row is now fired, not pending — the sibling-cancel pass must be a no-op on it
    expect(await cancelAwaitsForSubscribersOnKeys(['sub-c'], ['green-checkpoint:red:papercusp'])).toBe(0);
  });

  // WI-4957: cancelAwaitsByIds — the precise by-id cancel cancelSupersededCandidateAwaits
  // uses once it has identified EXACTLY which rows are payload-bound to a dead candidate.
  // Unlike cancelAwaitsForSubscribersOnKeys (subscriber+key scoped), this must be able to
  // cancel ONE of two payload-bound rows a single subscriber holds on the SAME key without
  // touching the other.
  it('cancelAwaitsByIds cancels exactly the named rows, leaves a sibling row on the SAME key+subscriber untouched, and is idempotent', async () => {
    const staleBound = await registerAwait({
      subscriberId: 'sub-d',
      eventKey: 'release:green:papercusp',
      payloadFilter: { sha: { startsWith: 'deadbeef' } },
    });
    const otherBound = await registerAwait({
      subscriberId: 'sub-d',
      eventKey: 'release:green:papercusp',
      payloadFilter: { sha: { startsWith: 'cafef00d' } },
    });
    const peer = await registerAwait({ subscriberId: 'sub-e', eventKey: 'lock:grant:xyz' });

    const cancelled = await cancelAwaitsByIds([staleBound.id, 99999999]); // a non-existent id is silently ignored
    expect(cancelled).toBe(1);

    const subD = await listActiveAwaits('sub-d');
    expect(subD.map((r) => r.id)).toEqual([otherBound.id]); // the sibling-candidate wait survives
    expect((await listActiveAwaits('sub-e')).map((r) => r.id)).toEqual([peer.id]); // untouched

    // idempotent: the row is already cancelled, nothing left to cancel
    expect(await cancelAwaitsByIds([staleBound.id])).toBe(0);
    // empty input is a no-op, not a query
    expect(await cancelAwaitsByIds([])).toBe(0);
  });

  it('cancelAwaitsByIds never touches an already-fired row', async () => {
    const row = await registerAwait({ subscriberId: 'sub-f', eventKey: 'release:green:papercusp' });
    const fired = await fireAwaitsForKey({ eventKey: 'release:green:papercusp' });
    expect(fired.map((r) => r.id)).toContain(row.id);
    expect(await cancelAwaitsByIds([row.id])).toBe(0);
  });

  // ── P-001 (fleet-member-dx-improvements-2026-07-10): parked-on-event read ──
  it('listParkedAwaitsForSubscribers returns active deliberate awaits while excluding the standing inbox-wake keepalive', async () => {
    // sub-a: a genuine parked-on-event await → the ONE row that should surface
    await registerAwait({ subscriberId: 'sub-a', eventKey: 'p2p-git:phase3-open', note: 'benched until phase 3' });
    // sub-a: the always-armed inbox-wake self-key → excluded (liveness, not benching)
    await upsertInboxWakeAwait({
      subscriberId: 'sub-a',
      eventKey: 'coord:inbox-wake:sub-a',
      wakeHandle: { sessionId: 's1' } as never,
    });
    // A bounded wake-on-timeout await on the same key is deliberate and must surface.
    await registerAwait({
      subscriberId: 'sub-a',
      eventKey: 'coord:inbox-wake:sub-a',
      timeoutSec: 1800,
      timeoutBehavior: 'wake',
      note: 'explicit bounded inbox-wake park',
    });
    // A standing watch remains in the list for consumers that need its cardinality.
    await registerAwait({
      subscriberId: 'sub-a',
      eventKey: 'work-item:claimable',
      once: false,
      note: 'standing claimable watch',
    });
    // sub-a: a fired await → excluded
    await registerAwait({ subscriberId: 'sub-a', eventKey: 'k:already-fired', once: true });
    await fireAwaitsForKey({ eventKey: 'k:already-fired' });
    // sub-a: a cancelled await → excluded
    const cancelled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'k:cancelled' });
    await cancelAwait({ awaitId: cancelled.id, subscriberId: 'sub-a' });
    // sub-a: an EXPIRED await (expires_ts in the past) → excluded
    const expired = await registerAwait({ subscriberId: 'sub-a', eventKey: 'k:expired', timeoutSec: 60 });
    await rootSql`UPDATE harness_shared.event_awaits SET expires_ts = now() - interval '1 minute' WHERE id = ${expired.id}`;
    // sub-b (NOT asked about): parked, but not in the subscriber list → excluded
    await registerAwait({ subscriberId: 'sub-b', eventKey: 'k:other-agent' });

    const parked = await listParkedAwaitsForSubscribers(['sub-a', 'sub-c']);
    expect(parked).toHaveLength(3);
    expect(parked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subscriberId: 'sub-a',
          eventKey: 'p2p-git:phase3-open',
          note: 'benched until phase 3',
          once: true,
        }),
        expect.objectContaining({
          subscriberId: 'sub-a',
          eventKey: 'coord:inbox-wake:sub-a',
          note: 'explicit bounded inbox-wake park',
          once: true,
          // P-009: loop:end's guarantee check reads this; absent, it defaulted to 'wake'.
          timeoutBehavior: 'wake',
        }),
        expect.objectContaining({
          subscriberId: 'sub-a',
          eventKey: 'work-item:claimable',
          note: 'standing claimable watch',
          once: false,
        }),
      ]),
    );
    expect(parked).not.toContainEqual(expect.objectContaining({
      subscriberId: 'sub-a',
      eventKey: 'coord:inbox-wake:sub-a',
      note: 'always-armed inbox-wake (turn-lifecycle-control)',
    }));

    // empty / all-blank input short-circuits to []
    expect(await listParkedAwaitsForSubscribers([])).toEqual([]);
    expect(await listParkedAwaitsForSubscribers([''])).toEqual([]);
  });

  it('recognizes an outstanding delivery from a fired deliberate await, but excludes platform interests', async () => {
    const subscriberId = 'loop-end-fired-wake-delivery';
    const deliberate = await registerAwait({ subscriberId, eventKey: 'release:green:loop-end' });
    const fired = await fireAwaitsForKey({ eventKey: 'release:green:loop-end' });
    expect(fired.map((row) => row.id)).toContain(deliberate.id);
    await insertDeliveries({ awaits: fired, summary: 'event fired during the active turn' });
    await rootSql`
      UPDATE harness_shared.event_wake_deliveries
         SET status = 'parked'
       WHERE subscriber_id = ${subscriberId}
         AND await_id = ${deliberate.id}
    `;

    expect(await hasPendingDeliberateWakeDelivery(subscriberId)).toBe(true);
    expect(await hasPendingDeliberateWakeDelivery('loop-end-no-delivery')).toBe(false);
    expect(await hasPendingDeliberateWakeDelivery('')).toBe(false);
    const [delivery] = await rootSql<Array<{ id: number }>>`
      SELECT id::int AS id FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id = ${subscriberId} AND await_id = ${deliberate.id}
    `;
    expect(delivery).toBeDefined();
    expect(await hasPendingDeliberateWakeDelivery(subscriberId, [delivery.id])).toBe(false);

    const platformSubscriber = 'loop-end-platform-wake-delivery';
    await registerAwait({
      subscriberId: platformSubscriber,
      eventKey: 'claim:released:WI-loop-end',
      boundTo: { kind: 'work-item-claim', ref: 'WI-loop-end' },
    });
    const platformFired = await fireAwaitsForKey({ eventKey: 'claim:released:WI-loop-end' });
    await insertDeliveries({ awaits: platformFired, summary: 'platform claim interest fired' });

    expect(await hasPendingDeliberateWakeDelivery(platformSubscriber)).toBe(false);
  });

  it('excludes platform-armed claim and obligation reminders but keeps genuine lifecycle waits', async () => {
    await registerAwait({
      subscriberId: 'sub-a',
      eventKey: 'claim:released:WI-1',
      note: 'claim-holder auto-arm for WI-1',
      boundTo: { kind: 'work-item-claim', ref: 'WI-1' },
    });
    await registerAwait({
      subscriberId: 'sub-a',
      eventKey: 'plan:acceptance:plan-a',
      note: 'agent-obligation reminder for plan-a',
      boundTo: { kind: 'agent-obligation', ref: 'obligation-1' },
    });
    await registerAwait({
      subscriberId: 'sub-a',
      eventKey: 'work-item:done:WI-2',
      note: 'blocked-item-holder auto-arm for WI-2',
      boundTo: { kind: 'work-item-blocked', ref: 'WI-2' },
    });

    const parked = await listParkedAwaitsForSubscribers(['sub-a']);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      subscriberId: 'sub-a',
      eventKey: 'work-item:done:WI-2',
      note: 'blocked-item-holder auto-arm for WI-2',
      boundTo: { kind: 'work-item-blocked', ref: 'WI-2' },
    });
  });

  it('lists only recent stalled/absent verified waits with owner-aware takeover remedies', async () => {
    const stalled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    const progressing = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:other' });
    const result = {
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      evidence: { phase: 'suite' },
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify({ ...result, classification: 'progressing', nextAction: 're-await' })}::jsonb
       WHERE id = ${progressing.id}
    `;

    const alerts = await listVerifiedWaitTakeoversForSubscribers(['sub-a']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      subscriberId: 'sub-a',
      eventKey: 'release:green:papercusp',
      classification: 'stalled',
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      evidence: { phase: 'suite' },
    });
    expect(alerts[0]?.remedy).toContain('claim/take over WI-42');
  });

  // EI-21139615450004027: a legacy verdict can identify the waiting monitor as
  // its own owner without a work item. It cannot meaningfully wake or take over
  // itself, so the leader-facing read must suppress that impossible remedy.
  it('suppresses a self-referential takeover row with no owning work item', async () => {
    const stalled = await registerAwait({ subscriberId: 'su-monitor', eventKey: 'release:green:papercusp' });
    const result = {
      classification: 'absent',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-legacy' },
      owner: { ownerId: 'su-monitor', workItemId: null },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;

    expect(await listVerifiedWaitTakeoversForSubscribers(['su-monitor'])).toEqual([]);
  });

  // WI-40626: migrated/stale verdicts can retain an unrelated work-item id while
  // still attributing the producer owner to the waiting subscriber. That owner
  // cannot wake or take over itself, regardless of the stale id being present.
  it('suppresses self-referential takeover rows even when a stale work-item id is present', async () => {
    const stalled = await registerAwait({ subscriberId: 'su-monitor', eventKey: 'green-checkpoint:red:papercusp' });
    const result = {
      classification: 'absent',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-stale-lineage' },
      owner: { ownerId: 'su-monitor', workItemId: 'EI-211707' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;

    expect(await listVerifiedWaitTakeoversForSubscribers(['su-monitor'])).toEqual([]);
  });

  // ── EI-20540454577146535: a stalled/absent verdict is a snapshot taken when the
  // fallback verifier fired; it must not survive the owning work item going terminal.
  it('suppresses a takeover row once its owning work item has since gone terminal', async () => {
    const stalled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    const result = {
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-39333' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      evidence: { phase: 'suite' },
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;

    // The producer/item has since closed (state=done) -- the row must not surface.
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, status) VALUES ('WI-39333', 'done')`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['sub-a'])).toEqual([]);

    // A work item this read cannot resolve at all (never existed / cross-workspace
    // collision / lookup gap) fails OPEN -- the pre-fix behavior, still surfaced.
    await rootSql`UPDATE harness_shared.work_items SET status = 'wip' WHERE feature_id = 'WI-39333'`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['sub-a'])).toHaveLength(1);
    await rootSql`DELETE FROM harness_shared.work_items WHERE feature_id = 'WI-39333'`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['sub-a'])).toHaveLength(1);
  });

  // EI-21158111951285029: timeout_verification stores producer/owner lineage at
  // fire time. A later condition-singleton owner makes an old ownerless verdict
  // historical even when the producer probe has not emitted a newer marker.
  it('suppresses a stale ownerless verdict after the live gate singleton moves owners', async () => {
    const stalled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    const result = {
      classification: 'absent',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: '4bd9c405' },
      owner: { ownerId: 'su-old', workItemId: null },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
    };
    const certificate = {
      version: 1,
      producer: result.producer,
      owner: result.owner,
      issuedAtMs: 1,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      expectedCadenceMs: 500,
      verificationDeadlineMs: 40,
      details: { pipeline: 'papercusp', runId: '4bd9c405' },
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             producer_health = ${JSON.stringify(certificate)}::jsonb,
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;
    await rootSql`
      INSERT INTO harness_shared.work_items
        (feature_id, status, harness_slug, condition_key, taken_by, last_progress_at)
      VALUES ('WI-40086', 'open', 'papercusp', 'gate-red-streak:papercusp', 'su-current', to_timestamp(0.001))
    `;

    const unchangedProducer = async (cert: ProducerHealthCertificate) => ({
      checkedAtMs: cert.verificationDeadlineMs,
      producerPresent: true,
      lastProgressAtMs: cert.lastProgressAtMs,
      lastFireAtMs: cert.lastFireAtMs,
      completedAtMs: null,
    });
    expect(
      await listVerifiedWaitTakeoversForSubscribers(['sub-a'], 24, {
        observeProducer: unchangedProducer,
      }),
    ).toEqual([]);
  });

  // ── EI-9000 (fleet-reliability-verification-2026-07-10 P-005): live-awaiter counts ──
  it('countActiveAwaitsByPrefixes groups LIVE awaits per prefix, in one round trip, zero-filling a matchless prefix', async () => {
    await registerAwait({ subscriberId: 'a', eventKey: 'work-item:status:WI-1' });
    await registerAwait({ subscriberId: 'b', eventKey: 'work-item:status:WI-2' });
    await registerAwait({ subscriberId: 'c', eventKey: 'release:deployed' }); // the global (no-sha) key
    await registerAwait({ subscriberId: 'd', eventKey: 'release:deployed:abc123' }); // scoped key — same prefix
    // a fired one-shot must NOT count
    const fired = await registerAwait({ subscriberId: 'e', eventKey: 'work-item:status:WI-3', once: true });
    await fireAwaitsForKey({ eventKey: 'work-item:status:WI-3' });
    void fired;
    // a cancelled one must NOT count
    const cancelled = await registerAwait({ subscriberId: 'f', eventKey: 'work-item:status:WI-4' });
    await cancelAwait({ awaitId: cancelled.id, subscriberId: 'f' });

    const counts = await countActiveAwaitsByPrefixes(['work-item:status', 'release:deployed', 'nobody:listening']);
    expect(counts.get('work-item:status')).toBe(2); // WI-1, WI-2 only (fired + cancelled excluded)
    expect(counts.get('release:deployed')).toBe(2); // global + scoped, same prefix
    expect(counts.get('nobody:listening')).toBe(0); // zero-filled, not absent

    // empty input short-circuits to an empty map
    expect((await countActiveAwaitsByPrefixes([])).size).toBe(0);
  });

  /**
   * WI-1611805 — the shape-aware twin. The prefix join above matches `prefix || '%'`,
   * which is not `:`-bounded, so a family whose derived prefix is a bare namespace
   * (`plan-event` → `plan`) counted unrelated families' awaits as its own. Measured on
   * live rows 2026-08-31: `plan-event` reported 5 over a true population of 4, the extra
   * being a `plan-item:` await. This pins BOTH directions — the bleed is excluded, and
   * every key the family really produces is still counted.
   */
  it('countActiveAwaitsByKeyShapes bounds a bare-namespace family by arity, keyed by family', async () => {
    await registerAwait({ subscriberId: 'p1', eventKey: 'plan:my-plan:gate-one' });
    await registerAwait({ subscriberId: 'p2', eventKey: 'plan:my-plan:gate-two' });
    // a plan slug that itself contains a colon — the live 5-segment case; the last
    // placeholder is greedy, so this must still count.
    await registerAwait({ subscriberId: 'p3', eventKey: 'plan:weird:slug:gate-three' });
    // the sibling family the old `plan%` join swallowed — must NOT count as plan-event
    await registerAwait({ subscriberId: 'q1', eventKey: 'plan-item:done:my-plan:P-014' });
    // the narrower family under the same namespace — its own row, not plan-event's
    await registerAwait({ subscriberId: 'r1', eventKey: 'plan:draft-ready:my-plan' });

    const counts = await countActiveAwaitsByKeyShapes([
      { family: 'plan-event', exact: 'plan', like: 'plan:%:%' },
      { family: 'plan-item', exact: 'plan-item:done', like: 'plan-item:done:%:%' },
      { family: 'nobody', exact: 'nobody:listening', like: 'nobody:listening:%' },
    ]);
    // p1, p2, p3 — and NOT q1. r1 is a genuine same-arity `plan:<slug>:<gate>` instance
    // and is counted here too: that overlap is the irreducible residue findFamilyPrefixShadowing
    // still reports, not something this bound claims to have fixed.
    expect(counts.get('plan-event')).toBe(4);
    expect(counts.get('plan-item')).toBe(1);
    expect(counts.get('nobody')).toBe(0); // zero-filled, not absent

    expect((await countActiveAwaitsByKeyShapes([])).size).toBe(0);
  });
});

describe('verified-wait fallback campaign (PG)', () => {
  const checkpointSnapshot = (
    overrides: {
      generatedAtMs?: number;
      activeRun?: GitPipelineSnapshot['activeRun'];
      greenCheckpoint?: GitPipelineSnapshot['routines']['greenCheckpoint'];
      recent?: GitPipelineSnapshot['recent'];
    } = {},
  ): GitPipelineSnapshot =>
    ({
      slug: 'papercusp',
      generatedAtMs: overrides.generatedAtMs ?? 2_000,
      activeRun: overrides.activeRun ?? null,
      routines: {
        gitSync: null,
        greenCheckpoint: overrides.greenCheckpoint ?? null,
        releaseTrigger: null,
      },
      recent: overrides.recent ?? [],
    }) as GitPipelineSnapshot;

  const certificate = (overrides: Partial<ProducerHealthCertificate> = {}): ProducerHealthCertificate => ({
    version: 1,
    producer: { kind: 'green-checkpoint', id: 'run-campaign' },
    owner: { ownerId: 'su-producer', workItemId: 'WI-producer' },
    issuedAtMs: 1_000,
    lastProgressAtMs: 900,
    lastFireAtMs: null,
    expectedCadenceMs: 500,
    verificationDeadlineMs: 2_000,
    details: { pipeline: 'papercusp', runId: 'run-campaign' },
    ...overrides,
  });

  async function registerDueVerifiedAwait(subscriberId: string, cert = certificate()) {
    const row = await registerAwait({
      subscriberId,
      eventKey: 'release:green:papercusp',
      timeoutBehavior: 'wake',
      timeoutSec: 60,
      producerHealthCertificate: cert,
    });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET expires_ts = now() - interval '1 second'
       WHERE id = ${row.id}
    `;
    return row;
  }

  it('producer dies before emit: persists an absent verdict and an owner-aware takeover', async () => {
    const row = await registerDueVerifiedAwait('waiter-died');
    const [claimed] = await claimDueVerifiedAwaits();
    expect(claimed?.id).toBe(row.id);

    const observation = await observeCheckpointProducer(claimed!.producerHealthCertificate!, {
      // `candidate: null` means the named run has not been observed yet
      // (`unknown`), not that it disappeared. Name the certificate's own run
      // in an explicit inactive probe to model the confirmed absence asserted.
      snapshot: async () =>
        checkpointSnapshot({
          activeRun: { active: false, candidate: 'run-campaign', startedAtMs: null, elapsedSec: null },
        }),
    });
    const result = classifyVerifiedWaitTimeout(claimed!.producerHealthCertificate!, observation);
    expect(result).toMatchObject({ classification: 'absent', nextAction: 'wake-owner-or-takeover' });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result })).toMatchObject({
      firedReason: 'verified-timeout',
      timeoutVerification: { classification: 'absent' },
    });

    const noNewProducerActivity = async (cert: ProducerHealthCertificate) => ({
      checkedAtMs: cert.verificationDeadlineMs,
      producerPresent: true,
      lastProgressAtMs: cert.lastProgressAtMs,
      lastFireAtMs: cert.lastFireAtMs,
      completedAtMs: null,
    });
    expect(
      await listVerifiedWaitTakeoversForSubscribers(['waiter-died'], 24, {
        observeProducer: noNewProducerActivity,
      }),
    ).toEqual([
      expect.objectContaining({
        classification: 'absent',
        owner: { ownerId: 'su-producer', workItemId: 'WI-producer' },
        remedy: expect.stringContaining('claim/take over WI-producer'),
      }),
    ]);

    // EI-20540454577146535: the SAME verified-timeout verdict, once WI-producer has
    // since closed, must stop recommending a takeover of it.
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, status) VALUES ('WI-producer', 'done')`;
    expect(
      await listVerifiedWaitTakeoversForSubscribers(['waiter-died'], 24, {
        observeProducer: noNewProducerActivity,
      }),
    ).toEqual([]);

    // A producer that resumed after the timeout must also clear the stale remedy,
    // even when its owning work-item is still open.
    await rootSql`DELETE FROM harness_shared.work_items WHERE feature_id = 'WI-producer'`;
    const resumed = async (cert: ProducerHealthCertificate) => ({
      checkedAtMs: cert.verificationDeadlineMs + 1_000,
      producerPresent: true,
      state: 'active' as const,
      lastProgressAtMs: cert.verificationDeadlineMs + 500,
      lastFireAtMs: null,
      completedAtMs: null,
    });
    expect(await listVerifiedWaitTakeoversForSubscribers(['waiter-died'], 24, { observeProducer: resumed })).toEqual(
      [],
    );
  });

  it('slow-but-progressing producer: renews the same one-shot row without consuming it', async () => {
    const row = await registerDueVerifiedAwait('waiter-progress');
    const [claimed] = await claimDueVerifiedAwaits();
    const observation = await observeCheckpointProducer(claimed!.producerHealthCertificate!, {
      snapshot: async () =>
        checkpointSnapshot({
          activeRun: { active: true, candidate: 'abc123', startedAtMs: 1_500, elapsedSec: 0.5 },
          greenCheckpoint: {
            name: 'green-checkpoint',
            active: true,
            cron: null,
            lastFiredAtMs: 1_500,
            nextFireAtMs: null,
            groupSlug: 'release',
            pause: null,
          },
        }),
    });
    const result = classifyVerifiedWaitTimeout(claimed!.producerHealthCertificate!, observation);
    expect(result).toMatchObject({ classification: 'progressing', nextAction: 're-await' });

    const nextCertificate = certificate({
      issuedAtMs: observation.checkedAtMs,
      lastProgressAtMs: observation.lastProgressAtMs,
      verificationDeadlineMs: observation.checkedAtMs + 500,
    });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result, nextCertificate })).toBeNull();
    expect(await listActiveAwaitsForKey('release:green:papercusp')).toEqual([
      expect.objectContaining({
        id: row.id,
        firedAt: null,
        producerHealthCertificate: expect.objectContaining({ verificationDeadlineMs: 2_500 }),
        timeoutVerification: expect.objectContaining({ classification: 'progressing' }),
      }),
    ]);
  });

  it('latched completion: authoritative completion wins over a missing producer', async () => {
    const row = await registerDueVerifiedAwait('waiter-latched');
    const [claimed] = await claimDueVerifiedAwaits();
    const observation = await observeCheckpointProducer(claimed!.producerHealthCertificate!, {
      snapshot: async () =>
        checkpointSnapshot({
          recent: [
            {
              id: 'verdict-campaign',
              kind: 'green_checkpoint',
              createdAtMs: 1_950,
              status: 'advanced',
              detail: { candidate: 'abc123', runId: 'run-campaign' },
            },
          ],
        }),
    });
    const result = classifyVerifiedWaitTimeout(claimed!.producerHealthCertificate!, observation);
    expect(result).toMatchObject({ classification: 'already-complete', nextAction: 'resume' });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result })).toMatchObject({
      firedReason: 'verified-timeout',
      timeoutVerification: expect.objectContaining({ classification: 'already-complete' }),
    });
  });

  it('fallback takeover is race-safe: a pushed completion that wins first cannot be consumed twice', async () => {
    const row = await registerDueVerifiedAwait('waiter-race');
    expect((await fireAwaitsForKey({ eventKey: 'release:green:papercusp' })).map((awaited) => awaited.id)).toEqual([
      row.id,
    ]);
    expect(await claimDueVerifiedAwaits()).toEqual([]);

    const fallback = classifyVerifiedWaitTimeout(certificate(), {
      checkedAtMs: 2_000,
      producerPresent: false,
      lastProgressAtMs: null,
      lastFireAtMs: null,
      completedAtMs: null,
    });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result: fallback })).toBeNull();
    const persisted = await rootSql`
      SELECT fired_reason, timeout_verification
        FROM harness_shared.event_awaits
       WHERE id = ${row.id}
    `;
    expect(persisted[0]).toMatchObject({ fired_reason: 'event', timeout_verification: null });
  });
});

// ── EI-13705: the unconditional per-key fire latch (mig 632) ──────────────────
describe('recordKeyFire / getKeyFireLatch / inspectEventKey.fireLatch (PG)', () => {
  it('getKeyFireLatch is null for a key that has never fired', async () => {
    expect(await getKeyFireLatch('never:fired')).toBeNull();
  });

  it('recordKeyFire inserts a fresh latch row (fire_count=1) for a brand-new key', async () => {
    await recordKeyFire({ eventKey: 'p2p-git:phase3-open', firedBy: 'su-63834d42', payload: { sha: 'abc' } });
    const latch = await getKeyFireLatch('p2p-git:phase3-open');
    expect(latch).toMatchObject({ eventKey: 'p2p-git:phase3-open', lastFiredBy: 'su-63834d42', fireCount: 1 });
    expect(latch!.lastPayload).toEqual({ sha: 'abc' });
    expect(latch!.firstFiredAt).toEqual(latch!.lastFiredAt); // first fire: first == last
  });

  it('a second recordKeyFire on the SAME key upserts in place — increments fire_count, refreshes last_*, keeps first_fired_at', async () => {
    await recordKeyFire({ eventKey: 'k:repeat', firedBy: 'source-1', payload: { n: 1 } });
    const first = await getKeyFireLatch('k:repeat');
    await recordKeyFire({ eventKey: 'k:repeat', firedBy: 'source-2', payload: { n: 2 } });
    const second = await getKeyFireLatch('k:repeat');

    expect(await rootSql`SELECT 1 FROM harness_shared.event_key_fires WHERE event_key = 'k:repeat'`).toHaveLength(1); // ONE row, not two
    expect(second!.fireCount).toBe(2);
    expect(second!.lastFiredBy).toBe('source-2');
    expect(second!.lastPayload).toEqual({ n: 2 });
    expect(second!.firstFiredAt).toEqual(first!.firstFiredAt); // first_fired_at is never overwritten
  });

  it('recordKeyFire with no payload/firedBy stores nulls (an anonymous/payload-less emit still latches)', async () => {
    await recordKeyFire({ eventKey: 'k:bare' });
    const latch = await getKeyFireLatch('k:bare');
    expect(latch).toMatchObject({ eventKey: 'k:bare', lastFiredBy: null, lastPayload: null, fireCount: 1 });
  });

  it('inspectEventKey folds the fire latch in alongside announcements/waiters/deliveries', async () => {
    await recordKeyFire({ eventKey: 'k:inspect', firedBy: 'su-x' });
    const history = await inspectEventKey('k:inspect');
    expect(history.announcements).toEqual([]);
    expect(history.waiters).toEqual([]);
    expect(history.deliveries).toEqual([]);
    expect(history.fireLatch).toMatchObject({ eventKey: 'k:inspect', lastFiredBy: 'su-x', fireCount: 1 });
  });

  it('inspectEventKey.fireLatch is null for a key with waiters/deliveries but that was never routed through recordKeyFire (isolation — the latch is its own store, not derived)', async () => {
    await registerAwait({ subscriberId: 'sub-z', eventKey: 'k:no-latch' });
    const history = await inspectEventKey('k:no-latch');
    expect(history.waiters).toHaveLength(1);
    expect(history.fireLatch).toBeNull();
  });

  it('bounds exact event inspection and await preflight reads under real table locks', async () => {
    const withLock = async (
      table: 'event_awaits' | 'event_key_fires',
      run: () => Promise<void>,
    ) => {
      let unlock!: () => void;
      let reportLockAcquired!: () => void;
      const locked = new Promise<void>((resolve) => { reportLockAcquired = resolve; });
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const blocker = rootSql.begin(async tx => {
        if (table === 'event_awaits') {
          await tx`LOCK TABLE harness_shared.event_awaits IN ACCESS EXCLUSIVE MODE`;
        } else {
          await tx`LOCK TABLE harness_shared.event_key_fires IN ACCESS EXCLUSIVE MODE`;
        }
        reportLockAcquired();
        await release;
      });
      await locked;
      try {
        await run();
      } finally {
        unlock();
        await blocker;
      }
    };
    const assertBoundedContention = async (read: Promise<unknown>) => {
      const startedAt = Date.now();
      const error = await read.then(() => null, failure => failure as Error & { pgCode?: string });
      expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03' });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs, `${error?.message ?? 'missing timeout error'} (elapsed ${elapsedMs}ms)`).toBeLessThan(15_000);
    };

    await withLock('event_awaits', async () => {
      await assertBoundedContention(inspectEventKey('lock:grant:status-read'));
      await assertBoundedContention(findNearMissKeys('lock:grant:await-preflight'));
    });
    await withLock('event_key_fires', async () => {
      await assertBoundedContention(probeKeyFireEvidence('lock:grant:fire-preflight'));
    });
  }, 30_000);
});

describe('probeKeyFireEvidence (PG) — EI-18676056143796303, the emitter evidence behind the orphan guard', () => {
  it('keyFireEvidencePrefix uses stable families and keeps dynamic scopes exact', () => {
    expect(keyFireEvidencePrefix('coord:inbox-wake:su-abc-123')).toBe('coord:inbox-wake');
    expect(keyFireEvidencePrefix('plan-item:done:my-plan:P-004')).toBe('plan-item:done');
    expect(keyFireEvidencePrefix('work-item:claimable')).toBe('work-item:claimable');
    expect(keyFireEvidencePrefix('single')).toBe('single');
    expect(keyFireEvidencePrefix('fleet:drain:resume')).toBe('fleet:drain:resume');
    expect(keyFireEvidencePrefix('plan:my-plan:review-ready')).toBe('plan:my-plan:review-ready');
    expect(keyFireEvidencePrefix('harness:papercusp:runtime-ready')).toBe('harness:papercusp:runtime-ready');
  });

  it('reports NO evidence for a key whose family has never fired — the genuine-orphan case still warns', async () => {
    const ev = await probeKeyFireEvidence('overwatch:surface-landed');
    expect(ev).toMatchObject({
      prefix: 'overwatch:surface-landed',
      exact: false,
      distinctKeys: 0,
      fires: 0,
      lastFiredAt: null,
    });
  });

  it('reports EXACT evidence when this very key has fired', async () => {
    await recordKeyFire({ eventKey: 'evidence:exact', firedBy: 'src' });
    await recordKeyFire({ eventKey: 'evidence:exact', firedBy: 'src' });
    const ev = await probeKeyFireEvidence('evidence:exact');
    expect(ev.exact).toBe(true);
    expect(ev.fires).toBe(2);
    expect(ev.distinctKeys).toBe(1);
    expect(ev.lastFiredAt).toBeTruthy();
  });

  it('reports SIBLING evidence for a never-before-seen key whose FAMILY fires — the coord:inbox-wake case', async () => {
    // A fresh agent's own inbox-wake key has no latch row of its own, but 118
    // sibling owner keys have fired thousands of times. That is what proves an
    // emitter exists, and what the orphan warning claimed did not.
    await recordKeyFire({ eventKey: 'coord:inbox-wake:su-one' });
    await recordKeyFire({ eventKey: 'coord:inbox-wake:su-two' });
    await recordKeyFire({ eventKey: 'coord:inbox-wake:su-two' });
    const ev = await probeKeyFireEvidence('coord:inbox-wake:su-brand-new');
    expect(ev.exact).toBe(false);
    expect(ev.distinctKeys).toBe(2);
    expect(ev.fires).toBe(3);
    expect(ev.prefix).toBe('coord:inbox-wake');
  });

  it.each([
    ['fleet', 'drain-fleet'],
    ['plan', 'review-plan'],
    ['harness', 'managed-harness'],
  ] as const)('does not treat an unannounced %s scoped gate as a sibling family', async (namespace, scopeRef) => {
    const siblingKey = `${namespace}:${scopeRef}:previous-gate`;
    const eventKey = `${namespace}:${scopeRef}:new-gate`;
    await recordKeyFire({ eventKey: siblingKey });

    const siblingEvidence = await probeKeyFireEvidence(eventKey);
    expect(siblingEvidence).toMatchObject({
      prefix: eventKey,
      exact: false,
      distinctKeys: 0,
      fires: 0,
      lastFiredAt: null,
    });

    await recordKeyFire({ eventKey });
    const exactEvidence = await probeKeyFireEvidence(eventKey);
    expect(exactEvidence).toMatchObject({
      prefix: eventKey,
      exact: true,
      distinctKeys: 1,
      fires: 1,
    });
  });

  it('keeps a short key exact instead of borrowing fires from colon descendants', async () => {
    await recordKeyFire({ eventKey: 'short-key:descendant' });
    expect(await probeKeyFireEvidence('short-key')).toMatchObject({
      prefix: 'short-key',
      exact: false,
      distinctKeys: 0,
      fires: 0,
      lastFiredAt: null,
    });
  });

  it('does NOT leak across families — a neighbouring prefix is not evidence', async () => {
    await recordKeyFire({ eventKey: 'neighbour:alpha:1' });
    // `neighbour:beta` must not be credited with `neighbour:alpha`'s fires…
    expect((await probeKeyFireEvidence('neighbour:beta:1')).fires).toBe(0);
    // …and a prefix must match on a ':' boundary, not a bare startsWith.
    await recordKeyFire({ eventKey: 'neigh:alphabet' });
    expect((await probeKeyFireEvidence('neigh:alpha:9')).fires).toBe(0);
  });

  it('treats LIKE wildcards in a key as literals (a `%` key cannot widen the scan)', async () => {
    await recordKeyFire({ eventKey: 'wild:other:x' });
    expect((await probeKeyFireEvidence('wild:%:y')).fires).toBe(0);
    expect((await probeKeyFireEvidence('wild:_ther:y')).fires).toBe(0);
  });
});

describe('probePatternMatchScope (PG) — EI-19332682533219755, the cross-pipeline glob disclosure', () => {
  it('REPRODUCES THE INCIDENT: release:green:* spans co-hosted pipelines, and names the foreign one', async () => {
    // The real latch on this host at the time of filing: papercusp's own gate key
    // plus three other projects sharing the box. An agent armed `release:green:*`
    // meaning "MY gate", and woke on oddsmith's verdict — satisfied:true, carrying
    // a sha that is not even an object in this repository.
    await recordKeyFire({ eventKey: 'release:green:papercusp' });
    await recordKeyFire({ eventKey: 'release:green:oddsmith' });
    await recordKeyFire({ eventKey: 'release:green:hello-world-3' });

    const scope = await probePatternMatchScope('release:green:*');

    expect(scope.prefix).toBe('release:green');
    expect(scope.matchedKeys).toHaveLength(3);
    expect(scope.matchedKeys).toEqual(
      expect.arrayContaining(['release:green:papercusp', 'release:green:oddsmith', 'release:green:hello-world-3']),
    );
    expect(scope.truncated).toBe(false);
  });

  it('does NOT match the BARE family key — `release:green:*` requires a pipeline segment', async () => {
    // The emitter fires BOTH the global `release:green` and the scoped form, so a
    // probe that swept the bare key into the match set would over-report by one on
    // every host and make a single-pipeline box look cross-scoped.
    await recordKeyFire({ eventKey: 'release:green' });
    await recordKeyFire({ eventKey: 'release:green:papercusp' });

    const scope = await probePatternMatchScope('release:green:*');
    expect(scope.matchedKeys).toEqual(['release:green:papercusp']);
  });

  it('narrows with the REAL matcher, not just the prefix scan — a mid-key glob excludes non-matches', async () => {
    await recordKeyFire({ eventKey: 'fleet:drained:red' });
    await recordKeyFire({ eventKey: 'fleet:member-dead:red' });
    await recordKeyFire({ eventKey: 'fleet:drained:blue' });

    const scope = await probePatternMatchScope('fleet:*:red');
    // The prefix scan can only anchor on 'fleet', so blue is read and then REJECTED
    // by keyMatchesPattern — proving the two stages compose.
    expect(scope.prefix).toBe('fleet');
    expect(scope.matchedKeys.sort()).toEqual(['fleet:drained:red', 'fleet:member-dead:red']);
  });

  it('returns nothing for an EXACT key — the recommended fix must never warn about itself', async () => {
    await recordKeyFire({ eventKey: 'release:green:papercusp' });
    const scope = await probePatternMatchScope('release:green:papercusp');
    expect(scope.matchedKeys).toEqual([]);
  });

  it('bounds a wildcard-led glob instead of scanning the whole table unanchored', async () => {
    await recordKeyFire({ eventKey: 'release:green:papercusp' });
    await recordKeyFire({ eventKey: 'other:family:papercusp' });
    const scope = await probePatternMatchScope('*:papercusp');
    // No anchorable prefix, so the scan is recency-bounded — but the matcher still
    // decides membership, so both genuinely-matching keys are reported.
    expect(scope.prefix).toBe('');
    expect(scope.matchedKeys.sort()).toEqual(['other:family:papercusp', 'release:green:papercusp']);
  });

  it('flags a capped scan as truncated so the caller reads the count as a floor', async () => {
    await recordKeyFire({ eventKey: 'many:key:a' });
    await recordKeyFire({ eventKey: 'many:key:b' });
    await recordKeyFire({ eventKey: 'many:key:c' });
    const scope = await probePatternMatchScope('many:key:*', { limit: 2 });
    expect(scope.truncated).toBe(true);
    expect(scope.matchedKeys.length).toBeLessThanOrEqual(2);
  });
});

/**
 * event-wait-settlement-2026-10-20 P-004 (Design 4) — settle on every proving fire.
 * The emit half (engine.ts calls settleProvingFire when the latch reports a waiter, and
 * never fails on its error) is pinned by engine.test.ts; this block pins the store half
 * against real Postgres: the latch statement's waiter probe and the settlement itself.
 *   AUTO-BAR-R-6-P-004  — an item blocked on an unannounced proving key returns to open.
 *   AUTO-BAR-R-7-P-004  — a gate-kind blocker on an announced key clears when it fires.
 *   AUTO-BAR-R-18-P-004 — a durable park on an unannounced proving trigger is released.
 */
describe('proving-fire settlement (PG) — event-wait-settlement-2026-10-20 P-004', () => {
  const SHA_KEY = 'release:deployed:4f2a9c1d';

  function gateBlocker(eventKey: string) {
    return { ...eventBlocker(eventKey), kind: 'gate' };
  }

  async function seedBlocked(id: string, blockers: unknown[]) {
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES (${id}, 'blocked', 'bug', ${JSON.stringify({
        _claimHold: true, held_open_by: 'test-agent', held_open_reason: 'blocked', externalBlockers: blockers,
      })}::text::jsonb)`;
  }

  /** A durable park released only by `trigger` (the shape park-time stamping writes). */
  async function seedDurablePark(id: string, trigger: string) {
    await rootSql`
      INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
      VALUES (${id}, 'open', 'bug', ${JSON.stringify({
        _claimHold: true, claim_hold_by: 'parker', claim_hold_reason: 'wait for the upstream fix',
        claim_hold_at: '2026-10-20T12:00:00.000Z',
        claim_hold_release: { condition: `${trigger} fires`, owner: 'parker', trigger, reachability: 'reachable',
          evidence: 'upstream not done yet' },
        keepMe: 'kept',
      })}::text::jsonb)`;
  }

  async function rowOf(id: string) {
    const [row] = await rootSql<{ status: string; payload: Record<string, any> }[]>`
      SELECT status, payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
    return row!;
  }

  it.each([
    ['an active event blocker', () => seedBlocked('EI-probe', [eventBlocker(SHA_KEY)]), true],
    ['an active gate blocker', () => seedBlocked('EI-probe', [gateBlocker(SHA_KEY)]), true],
    ['a durable park on the key', () => seedDurablePark('EI-probe', SHA_KEY), true],
    ['nothing', async () => {}, false],
    ['only a CLEARED blocker on the key', () => seedBlocked('EI-probe', [{ ...eventBlocker(SHA_KEY), status: 'cleared' }]), false],
    ['a blocker on a different key', () => seedBlocked('EI-probe', [eventBlocker('release:deployed:0000000')]), false],
  ])('the fire latch reports a proving waiter when the key has %s', async (_label, arrange, expected) => {
    await arrange();
    const latch = await recordKeyFire({ eventKey: SHA_KEY, firedBy: 'release-gate' });
    expect(latch.provingWaiterPending).toBe(expected);
    expect(latch.fire?.count).toBe(1); // the latch itself still recorded the fire
  });

  // event-wait-settlement-2026-10-20 P-007 (Design 7): the same statement probes a completion
  // fire for non-terminal items whose live-dependency blockers name the finished id.
  const DONE_KEY = 'work-item:done:WI-9007201';
  const dependencyBlocker = (ref: string, over: Record<string, unknown> = {}) => ({ ...eventBlocker(ref), kind: 'runtime', ...over });

  it.each([
    ['an active live-dependency blocker names it', () => seedBlocked('EI-p007', [dependencyBlocker('work-item:WI-9007201')]), ['default']],
    ['a qualified two-id ref names it', () => seedBlocked('EI-p007', [dependencyBlocker('shared host / WI-9007201 + EI-9007299')]), ['default']],
    ['nothing', async () => {}, []],
    ['only a CLEARED blocker names it', () => seedBlocked('EI-p007', [dependencyBlocker('work-item:WI-9007201', { status: 'cleared' })]), []],
    ['only an owner ask mentions it', () => seedBlocked('EI-p007', [dependencyBlocker('sign off WI-9007201', { kind: 'human', capability: 'product-decision' })]), []],
    ['a blocker names a longer id', () => seedBlocked('EI-p007', [dependencyBlocker('work-item:WI-90072010')]), []],
    ['the waiting item is itself terminal', async () => {
      await rootSql`
        INSERT INTO harness_shared.work_items (feature_id, status, item_kind, payload)
        VALUES ('EI-p007', 'done', 'bug', ${JSON.stringify({ externalBlockers: [dependencyBlocker('work-item:WI-9007201')] })}::text::jsonb)`;
    }, []],
  ])('AUTO-BAR-R-6-P-007: the fire latch reports the dependency waiters of a completion fire when %s', async (_label, arrange, expected) => {
    await arrange();
    const latch = await recordKeyFire({ eventKey: DONE_KEY, firedBy: 'work-items' });
    expect(latch.workItemRefWaiterWorkspaces).toEqual(expected);
    expect(latch.fire?.count).toBe(1); // the latch itself still recorded the fire
  });

  it('the completion-fire probe is absent for any other key, and served by migration 1543\'s index', async () => {
    await seedBlocked('EI-p007-other', [dependencyBlocker('work-item:WI-9007201')]);
    expect(await recordKeyFire({ eventKey: SHA_KEY })).not.toHaveProperty('workItemRefWaiterWorkspaces');
    expect(await recordKeyFire({ eventKey: 'work-item:done:WI-p007-not-an-id' })).not.toHaveProperty('workItemRefWaiterWorkspaces');
    const plan = await rootSql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      return tx.unsafe(`EXPLAIN SELECT 1 FROM harness_shared.work_items
        WHERE payload ? 'externalBlockers'
          AND harness_shared.active_dependency_blocker_item_ids(payload) @> ARRAY['WI-9007201'::text]`);
    });
    expect(plan.map((row) => String((row as Record<string, unknown>)['QUERY PLAN'])).join('\n'))
      .toContain('work_items_active_dependency_item_ids_idx');
  });

  it('a key no fire can prove is not probed, even when an item waits on it', async () => {
    await seedBlocked('EI-broad', [eventBlocker('git-sync:committed')]);
    expect((await recordKeyFire({ eventKey: 'git-sync:committed' })).provingWaiterPending).toBe(false);
    // …and settlement refuses it outright: the blocker stays active.
    expect(await settleProvingFire('git-sync:committed', { firedBy: 'git-sync' })).toBe(0);
    expect((await rowOf('EI-broad')).payload.externalBlockers[0].status).toBe('active');
    expect(followUp.calls).toEqual([]);
  });

  it('AUTO-BAR-R-6-P-004: an item blocked on an unannounced release:deployed:<sha> returns to open when it fires', async () => {
    await seedBlocked('EI-deploy-wait', [eventBlocker(SHA_KEY)]);
    await seedBlocked('EI-other-wait', [eventBlocker('release:deployed:0000000')]);
    expect(await findAnnouncementsForKey(SHA_KEY)).toEqual([]); // genuinely unannounced

    expect(await settleProvingFire(SHA_KEY, { firedBy: 'release-gate' })).toBe(1);

    const after = await rowOf('EI-deploy-wait');
    expect(after.status).toBe('open');
    expect(after.payload).not.toHaveProperty('held_open_reason');
    expect(after.payload).not.toHaveProperty('_claimHold');
    // The history records what cleared it, and why (scenario S1).
    expect(after.payload.externalBlockers).toEqual([expect.objectContaining({
      kind: 'event', ref: SHA_KEY, status: 'cleared', clearedBy: 'release-gate', evidence: `event "${SHA_KEY}" fired`,
    })]);
    expect((await rowOf('EI-other-wait')).status).toBe('blocked');
    // One hand-off to the shared post-commit follow-up (un-park, claimable refresh, wake).
    expect(followUp.calls.map((items) => items.map((i) => i.featureId))).toEqual([['EI-deploy-wait']]);
  });

  it('AUTO-BAR-R-6-P-004: an item with a second active blocker loses only the fired wait and stays blocked', async () => {
    await seedBlocked('EI-two-waits', [eventBlocker(SHA_KEY), runtimeBlocker()]);
    expect(await settleProvingFire(SHA_KEY, { firedBy: 'release-gate' })).toBe(1);
    const after = await rowOf('EI-two-waits');
    expect(after.status).toBe('blocked');
    expect(after.payload.externalBlockers.map((b: { ref: string; status: string }) => [b.ref, b.status]))
      .toEqual([[SHA_KEY, 'cleared'], ['runtime:still-live', 'active']]);
  });

  // D-008: the announced path applies fireCertifiesCondition with the producer declared,
  // so the key is a fleet gate (the shape events:emit { announce:true } returns), which
  // set_blocker admits. A catalogued broad key such as release:green:<pipeline> is
  // refused at write time and is pinned below as clearing nothing.
  it('AUTO-BAR-R-7-P-004: a gate-kind blocker on an announced key is cleared when that key fires', async () => {
    const gateKey = 'fleet:ews-p004:release-ready';
    await registerAnnouncement({ subscriberId: 'release-gate', eventKey: gateKey, scopeKind: 'global' });
    await seedBlocked('EI-gate-wait', [gateBlocker(gateKey)]);

    expect(await stampAnnouncementsFired(gateKey, { firedBy: 'release-gate' })).toBe(1);

    const after = await rowOf('EI-gate-wait');
    expect(after.status).toBe('open');
    expect(after.payload.externalBlockers).toEqual([expect.objectContaining({
      kind: 'gate', ref: gateKey, status: 'cleared', clearedBy: 'release-gate',
    })]);
    expect(followUp.calls.map((items) => items.map((i) => i.featureId))).toEqual([['EI-gate-wait']]);
  });

  it('an announced broad catalogued key (release:green:<pipeline>) clears no blocker: no fire of it proves a condition (D-008)', async () => {
    const broad = 'release:green:papercusp';
    await registerAnnouncement({ subscriberId: 'release-gate', eventKey: broad, scopeKind: 'global' });
    await seedBlocked('EI-green-wait', [gateBlocker(broad)]);

    expect(await stampAnnouncementsFired(broad, { firedBy: 'release-gate' })).toBe(1);

    const row = await rowOf('EI-green-wait');
    expect(row.status).toBe('blocked');
    expect(row.payload.externalBlockers[0].status).toBe('active');
    expect(followUp.calls.flat()).toEqual([]);
  });

  // Rubric vetting (conv-mvh091tq, reviewer 2): this is the gate-kind variant of
  // the UNANNOUNCED proving release, so it evidences R-6. R-7 is the announced
  // path (D-005), covered by the announced-key case above.
  it('AUTO-BAR-R-6-P-004: a gate-kind blocker on an unannounced proving key is cleared too', async () => {
    await seedBlocked('EI-gate-proving', [gateBlocker(SHA_KEY)]);
    expect(await settleProvingFire(SHA_KEY, { firedBy: 'release-gate' })).toBe(1);
    expect((await rowOf('EI-gate-proving')).status).toBe('open');
  });

  it('AUTO-BAR-R-1-P-001: a change-notification fire naming a concrete item is not proof on the emit-time path, so its blocker stays active', async () => {
    // A concrete id does not make a change notification proof (D-001 item 3):
    // work-item:status:<id> fires on ANY status change, not on the condition.
    const notification = 'work-item:status:WI-p004-watched';
    await seedBlocked('EI-status-wait', [eventBlocker(notification)]);
    await seedBlocked('EI-status-gate', [gateBlocker(notification)]);
    // The emit-time probe never reports a proving waiter for it…
    expect((await recordKeyFire({ eventKey: notification })).provingWaiterPending).toBe(false);
    // …and settlement refuses it even when called directly.
    expect(await settleProvingFire(notification, { firedBy: 'work-items:set_state' })).toBe(0);
    for (const id of ['EI-status-wait', 'EI-status-gate']) {
      const row = await rowOf(id);
      expect(row.status).toBe('blocked');
      expect(row.payload.externalBlockers[0].status).toBe('active');
    }
    expect(followUp.calls).toEqual([]);
  });

  // D-001 item 3 has no announced carve-out (D-008; amend review conv-mvhydkn6): a
  // producer declaring work-item:status:<id> does not make a status change the condition.
  it('AUTO-BAR-R-1-P-001: an announced change-notification fire is not proof either, so its blocker stays active', async () => {
    const notification = 'work-item:status:WI-p004-announced';
    await registerAnnouncement({ subscriberId: 'status-producer', eventKey: notification, scopeKind: 'global' });
    await seedBlocked('EI-announced-status-wait', [eventBlocker(notification)]);
    await seedBlocked('EI-announced-status-gate', [gateBlocker(notification)]);

    // The announcement itself latches fired; only the blockers stay put.
    expect(await stampAnnouncementsFired(notification, { firedBy: 'status-producer' })).toBe(1);

    for (const id of ['EI-announced-status-wait', 'EI-announced-status-gate']) {
      const row = await rowOf(id);
      expect(row.status).toBe('blocked');
      expect(row.payload.externalBlockers[0].status).toBe('active');
    }
    // The fire path always runs its post-commit follow-up; it must carry no cleared item.
    expect(followUp.calls.flat()).toEqual([]);
  });

  it('AUTO-BAR-R-1-P-001: retiring an announced change-notification gate clears no blocker on it', async () => {
    const notification = 'work-item:status:WI-p004-retired';
    const announcement = await registerAnnouncement({
      subscriberId: 'status-producer', eventKey: notification, scopeKind: 'global',
    });
    await seedBlocked('EI-retired-status-wait', [eventBlocker(notification)]);

    await expect(retireAnnouncement({ announcementId: announcement.id, subscriberId: 'status-producer' }))
      .resolves.toMatchObject({ retired: true });

    const row = await rowOf('EI-retired-status-wait');
    expect(row.status).toBe('blocked');
    expect(row.payload.externalBlockers[0].status).toBe('active');
    expect(followUp.calls.flat()).toEqual([]);
  });

  it('AUTO-BAR-R-18-P-004: a durable park on an unannounced work-item:done:<id> trigger is released when it fires', async () => {
    const trigger = 'work-item:done:WI-p004-upstream';
    await seedDurablePark('EI-parked', trigger);
    await seedDurablePark('EI-parked-elsewhere', 'work-item:done:WI-p004-unrelated');
    expect(await findAnnouncementsForKey(trigger)).toEqual([]);
    expect((await recordKeyFire({ eventKey: trigger })).provingWaiterPending).toBe(true);

    expect(await settleProvingFire(trigger, { firedBy: 'work-items:complete' })).toBe(1);

    const after = await rowOf('EI-parked');
    expect(after.payload).toEqual({ keepMe: 'kept' });
    expect((await rowOf('EI-parked-elsewhere')).payload).toHaveProperty('claim_hold_by', 'parker');
    const receipts = await rootSql<{ subject: string; details: Record<string, any> }[]>`
      SELECT subject, details FROM harness_shared.audit_log WHERE action = 'work_items:durable_park:clear'`;
    expect(receipts.map((r) => r.subject)).toEqual(['EI-parked']);
    expect(followUp.calls.map((items) => items.map((i) => i.featureId))).toEqual([['EI-parked']]);
  });

  it('settles under the key\'s announce advisory lock, so it waits for a concurrent declaration or stamp', async () => {
    await seedBlocked('EI-locked', [eventBlocker(SHA_KEY)]);
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = rootSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + SHA_KEY}, 0))`;
      await holderReleased;
    });
    let settledCount: number | undefined;
    let settling: Promise<void> | undefined;
    try {
      await waitForAnnouncementAdvisoryLock(SHA_KEY, 'held');
      settling = settleProvingFire(SHA_KEY, { firedBy: 'release-gate' }).then((n) => { settledCount = n; });
      await waitForAnnouncementAdvisoryLock(SHA_KEY, 'waiting');
      expect(settledCount).toBeUndefined();
      expect((await rowOf('EI-locked')).status).toBe('blocked');
    } finally {
      releaseHolder();
      await holder;
      if (settling) await settling;
    }
    expect(settledCount).toBe(1);
    expect((await rowOf('EI-locked')).status).toBe('open');
  });
});

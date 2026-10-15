/**
 * cross-peer-fed-event.integration.test.ts — P-102 (plan
 * p2p-git-live-activation-2026-07-09): reproduce, or clear, the WI-1729
 * "merged but not surfaced" gap over the REAL two-peer wire.
 *
 * WI-1729 checkpoint (2026-07-09 16:45Z, corroborated by su-63834 21:xxZ on the
 * live rig): fed rows MERGE fully on the consumer (mergedPosition=knownLength,
 * admission ok) but never SURFACE — no coord_event_log projection on the
 * consumer, coord:feed empty, events:await never re-fires. Two hypotheses to
 * discriminate:
 *
 *   (a) PROJECTION-DROP — the op never lands as a row in the consumer's
 *       coord_event_log at all (buildCoordMessageProjection.writeToPg silently
 *       drops it — a quarantine gate, a decode failure, a guard).
 *   (b) RE-FIRE-HOOK — the row lands fine, but the P-009 fed_event rail
 *       (coord-message.ts writeToPg → emitAwaitedEvent) never re-fires the
 *       consumer's registered `events:await` watch (the rail hive-git's
 *       ref-announce / staging-advance events are designed to ride).
 *
 * cross-peer-coordination.integration.test.ts's EI-279 test already proves
 * `body.wake` (the inbox-wake fan) federates correctly over this exact rig.
 * This test is its `body.fed_event` sibling — the OTHER half of P-009, and the
 * one hive-git's runtime drivers (P-202/P-203) actually depend on. Reuses the
 * SAME real two-peer rig (real Hyperswarm/testnet DHT, real
 * buildCoordMessageProjection, real merge/apply loop, real
 * events/await/engine — no fakes on the surfacing path under test).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
  WORKSPACE_ID,
  HARNESS_SLUG,
  cleanups,
  rigAfterEach,
  orgSqlHolder,
  pollUntil,
  federateTwoPeerPresence,
} from './_cross-peer-rig';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';
import { type CoordMessageRow } from '../projections/coord-message';
import { createFreshPgDb } from '../../../../test/_pg-helpers';

// getOrgPg → routed through the rig's per-"machine" holder (rebound around each
// op below), exactly as cross-peer-coordination.integration.test.ts does.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { orgSqlHolder } = await import('./_org-sql-holder');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: orgSqlHolder.sql }) };
});

// Same POT_REKEY-off stand-in as the sibling suite (buildHiveRekeyBootDeps
// would otherwise abort bootPresencePeer against a throwaway DB with no
// harness_shared.hives table). This suite proves fed_event surfacing, not
// rekey.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async (key: unknown, scope?: unknown) =>
      key === 'papercusp-hive-rekey'
        ? false
        : (actual.getFlag as (k: unknown, s?: unknown) => Promise<boolean>)(key, scope),
  };
});

// Registered BEFORE the file's own hooks so the stub outlives substrate teardown,
// which can still run a merge pass (WI-6554700010008561 / WI-10007530).
stubHivePolicyReadsForSuite();
afterEach(rigAfterEach);

// FAITHFUL to migrations 163 + 175 (once/min_sleep_sec/urgency/coalesced_count) +
// 387 (source) + 533 (payload_filter, EI-8998) + 572 (root_id — registerAwait's
// exact-one-shot retire path filters on `root_id IS NULL`, so it's load-bearing
// even though this suite never composes a tree; also superseded_at, filtered by
// the same retire path) + 825 (producer_health — registerAwait's INSERT always
// lists this column, boundTo or not) + 941 (cancel_reason — exact-key registration
// retires prior pending rows with an accountable cancellation reason) — the same
// hand-rolled subset store.integration.test.ts stands up (no RLS/grants; a
// throwaway test DB has no harness_app/harness_zero roles). This is a MINIMAL
// subset, not a schema mirror: harness_shared.event_awaits carries 34 columns
// in production (dev:pg_query { describe: 'harness_shared.event_awaits' }) —
// add a column here ONLY when a code path this suite actually exercises reads
// or writes it (mapAwait's plain `SELECT *` access is null-safe against an
// absent column; only an explicit INSERT/WHERE reference breaks).
const EVENT_AWAITS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.event_awaits (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default', subscriber_id text NOT NULL, event_key text NOT NULL,
    policy text NOT NULL DEFAULT 'wake' CHECK (policy IN ('wake','notify')),
    note text, wake_handle jsonb,
    timeout_behavior text NOT NULL DEFAULT 'expire' CHECK (timeout_behavior IN ('expire','wake')),
    expires_ts timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    fired_at timestamptz, fired_reason text, cancelled_at timestamptz, cancel_reason text,
    fired_by text, fired_payload jsonb, fired_delivery_intent_at timestamptz,
    once boolean NOT NULL DEFAULT true, min_sleep_sec integer, urgency boolean NOT NULL DEFAULT false,
    payload_filter jsonb, node_id bigint, root_id bigint, producer_health jsonb, superseded_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS harness_shared.event_wake_deliveries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default', await_id bigint NOT NULL,
    subscriber_id text NOT NULL, event_key text NOT NULL, payload jsonb, summary text,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','parked','delivering','delivered','dropped','dead')),
    channel text, attempts integer NOT NULL DEFAULT 0, last_error text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    urgent boolean NOT NULL DEFAULT false, min_sleep_sec integer, coalesced_count integer NOT NULL DEFAULT 1,
    source text
  );
`;

describe('cross-peer coordination on a shared Hive — fed_event surfacing over the real wire (P-009 / WI-1729 P-102)', () => {
  it('exact-key registration requires the cancellation column and stamps superseded watches after restoration', async () => {
    const db = await createFreshPgDb('fed_event_await_schema');
    cleanups.push(db.cleanup);
    await db.sql.unsafe(EVENT_AWAITS_DDL);
    orgSqlHolder.sql = db.sql;
    const { registerAwait, listActiveAwaitsForKey, AWAIT_SUPERSEDED_BY_REGISTRATION } =
      await import('../../../events/await/store');
    const input = { subscriberId: 'su-B-schema-control', eventKey: 'p2p-git:await-schema-control', once: true };

    // Remove exactly the fixture omission from the original D006 failure. Even
    // without an existing row, PostgreSQL rejects the explicit UPDATE column.
    await db.sql`ALTER TABLE harness_shared.event_awaits DROP COLUMN cancel_reason`;
    await expect(registerAwait(input)).rejects.toMatchObject({ code: '42703' });
    expect(await listActiveAwaitsForKey(input.eventKey)).toHaveLength(0);

    await db.sql`ALTER TABLE harness_shared.event_awaits ADD COLUMN cancel_reason text`;
    const prior = await registerAwait(input);
    const replacement = await registerAwait(input);
    expect(replacement.id).not.toBe(prior.id);
    const active = await listActiveAwaitsForKey(input.eventKey);
    expect(active.map((row) => row.id)).toEqual([replacement.id]);
    const retired = await db.sql<Array<{ cancelled_at: Date | null; cancel_reason: string | null }>>`
      SELECT cancelled_at, cancel_reason FROM harness_shared.event_awaits WHERE id = ${prior.id}
    `;
    expect(retired[0].cancelled_at).not.toBeNull();
    expect(retired[0].cancel_reason).toBe(AWAIT_SUPERSEDED_BY_REGISTRATION);
  });

  it(
    "a coord-message with body.fed_event federates A→B over the actual swarm; B's projection both (1) lands the row in coord_event_log AND (2) re-fires B's registered events:await watch",
    async () => {
      // The real await/delivery pump logs its own success line via console.warn
      // (lib/events/await/engine.ts's `log()` helper is not error-only) — expected
      // noise from exercising the REAL pump end-to-end, not a test failure signal;
      // swallow it (vitest-fail-on-console would otherwise flag it as unexpected).
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { dbA, dbB, idA, peerA, peerB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();
      await dbB.sql.unsafe(EVENT_AWAITS_DDL);

      // B registers a standing watch for the exact key the incoming fed_event will
      // carry — the consumer-side half of the WI-1729 gap ("events:await never
      // re-fires"). Routed at B (not A): getOrgPg() must resolve to B's own store.
      orgSqlHolder.sql = dbB.sql;
      const { registerAwait, listActiveAwaitsForKey } = await import('../../../events/await/store');
      const EVENT_KEY = 'p2p-git:test-ref-announce:1';
      await registerAwait({
        subscriberId: 'su-B-watcher',
        eventKey: EVENT_KEY,
        policy: 'wake',
        once: true,
      });
      const preFire = await listActiveAwaitsForKey(EVENT_KEY);
      expect(preFire).toHaveLength(1); // sanity: the watch is live before the op crosses the wire

      // A "sends" a no-recipient, control-plane fed_event row (the hive-git P-009
      // shape: no `to`, no `wake` — a pure events:emit{scope:'hive'} carrier) —
      // both legs of the production path: (1) A's own local coord_event_log write,
      // then (2) the op A's own peer-log carries.
      const MSG_ID = 'fed-event-e2e-1';
      const row: CoordMessageRow = {
        harness_slug: HARNESS_SLUG,
        msg_id: MSG_ID,
        surface: 'messages',
        writer_key: 'su-A',
        body: {
          ts: '2026-07-09T00:00:00Z',
          msg_id: MSG_ID,
          from: 'su-A',
          to: [],
          kind: 'message',
          summary: 'p2p-git ref-announce test event',
          fed_event: { key: EVENT_KEY, payload: { ref: 'refs/hive/staging' }, summary: 'ref announced' },
        },
        ts: 1_752_000_000_000,
      };
      orgSqlHolder.sql = dbA.sql;
      await dbA.sql`
        INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
        VALUES (${WORKSPACE_ID}, 'messages', 'su-A', ${MSG_ID}, ${dbA.sql.json(row.body as never)}, ${HARNESS_SLUG}, 'local')
      `;
      await peerA.handle.append({
        type: 'put',
        table: 'coord-messages',
        hbKey: MSG_ID,
        value: row,
        ts: 5000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // The op crosses the REAL wire; B's REAL projection applies it. getOrgPg()
      // must resolve to B's own store for the DURATION of B's merge (both the
      // coord_event_log INSERT — which takes opts.sql directly — and the P-009
      // emitAwaitedEvent rail — which does NOT take an injected sql and instead
      // calls the global getOrgPg() internally, so the mock's CURRENT binding is
      // what the fed_event rail actually writes through).
      orgSqlHolder.sql = dbB.sql;
      const onB = await pollUntil(
        async () => {
          await peerA.handle.mergeNow(); // A applies its own op (origin='local')
          await peerB.handle.mergeNow(); // B merges A's log → the remote apply under test
          const rows = await dbB.sql<Array<{ origin: string; summary: string }>>`
            SELECT origin, body->>'summary' AS summary FROM harness_shared.coord_event_log WHERE msg_id = ${MSG_ID}
          `;
          return rows.length ? rows[0] : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );

      // ── (a) PROJECTION-DROP check ──
      expect(onB, 'the fed_event message never federated into B.coord_event_log (projection-drop confirmed)').toBeTruthy();
      expect(onB!.origin).toBe('remote');
      expect(onB!.summary).toBe('p2p-git ref-announce test event');

      // ── (b) RE-FIRE-HOOK check ── B's registered watch must have fired: the
      // one-shot event_awaits row is claimed (fired_at set) and a wake delivery
      // was queued for it. A miss here — the row lands (a) passes) but this stays
      // unfired — is the RE-FIRE-HOOK gap the checkpoint names.
      // NOTE: event_awaits/event_wake_deliveries are queried WITHOUT a workspace_id
      // predicate — `eventsWs()` (lib/events/await/store.ts) ignores its
      // `workspaceId` input entirely and always pins reads/writes to the single
      // `DEFAULT_COORD_WORKSPACE` constant (both registerAwait's write and
      // fireAwaitsForKey's read go through it), so filtering by the rig's
      // WORKSPACE_ID here would find nothing even on a correct re-fire. This is a
      // pre-existing store-level behavior (self-consistent, not a bug this test is
      // chasing) — worth a follow-up note, not a P-102 blocker.
      const fired = await pollUntil(
        async () => {
          const rows = await dbB.sql<Array<{ fired_at: Date | null; fired_reason: string | null }>>`
            SELECT fired_at, fired_reason FROM harness_shared.event_awaits
             WHERE subscriber_id = 'su-B-watcher' AND event_key = ${EVENT_KEY}
          `;
          return rows[0]?.fired_at ? rows[0] : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(fired, "B's registered events:await watch never fired (re-fire-hook gap confirmed)").toBeTruthy();
      expect(fired!.fired_reason).toBe('event');

      const deliveries = await dbB.sql<Array<{ event_key: string; subscriber_id: string; payload: unknown }>>`
        SELECT event_key, subscriber_id, payload FROM harness_shared.event_wake_deliveries
         WHERE subscriber_id = 'su-B-watcher' AND event_key = ${EVENT_KEY}
      `;
      expect(deliveries, 'the re-fire matched the await but never queued a wake delivery').toHaveLength(1);
      expect((deliveries[0].payload as { ref?: string } | null)?.ref).toBe('refs/hive/staging');

      // A's own store holds exactly ONE copy, still origin='local' (EI-117 echo
      // breaker parity with the wake test above).
      const onARows = await dbA.sql<Array<{ origin: string }>>`
        SELECT origin FROM harness_shared.coord_event_log WHERE msg_id = ${MSG_ID}
      `;
      expect(onARows).toHaveLength(1);
      expect(onARows[0].origin).toBe('local');
    },
    60_000,
  );
});

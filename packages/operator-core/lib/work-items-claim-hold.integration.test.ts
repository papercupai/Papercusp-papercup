/**
 * work-items-claim-hold.integration.test.ts — WI-2797: the issue-family "claim hold"
 * self-select exclusion.
 *
 * Issue-family work-items (bug/change/task) have only open|resolved|closed — no non-terminal
 * "parked" state — so an item that must NOT be opportunistically self-picked (e.g. "needs a
 * dedicated gateway-owning agent, do not pick up", the WI-652 ping-pong that motivated this)
 * had nowhere to go: it stayed `open` = perpetually top-of-pool claimable, and every
 * self-selecting agent that declined it just handed it back to the next one (the recurring
 * claim_next ping-pong). `payload._claimHold: true` is the fix: a scoped, additive,
 * no-migration tag (setWorkItemClaimHold) that removes an item from `claimNextIssueWorkItem`
 * self-select (and the matching `diagnoseClaimNextMiss` ready-count) while leaving it fully
 * visible/editable/commentable and still directly claimable BY ID.
 *
 * fleet-deltas-leader-primitives-2026-07-10 P-006 (EI-8993) extended the hold to BOTH
 * families: the feature claim floor (claimFloorsWhereSql) now honors _claimHold too, and
 * `opts.by`/`opts.reason` stamp held_open_by/held_open_reason (the named HOLD-OPEN
 * setWorkItemState's terminal guard enforces — see work-items-lifecycle.integration.test.ts).
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • setWorkItemClaimHold sets/clears payload._claimHold on an issue-family row;
 *   • it applies to a FEATURE-family row too (P-006), stamping held_open_by/reason;
 *   • claimNextWorkItem's issue tier SKIPS a held item and serves an unheld one instead;
 *   • claimNextWorkItem's FEATURE tier likewise skips a held feature (P-006 floor);
 *   • a held item is STILL directly claimable by id (claimWorkItem bypasses the hold);
 *   • diagnoseClaimNextMiss reports a held-only backlog as pending-but-NOT-ready (genuinely
 *     gated — don't idle, but don't hot-retry either), never a false "drained" or a false race;
 *   • clearing the hold makes the item self-selectable again.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-claim-hold.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WATCHDOG_TICKS_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { runWorkItemDurableParkAudit } from './work-items-durable-park-audit';
import { buildDurableParkReleaseContract } from './durable-park-release-contract';
import { readEventConditionReachability } from './external-condition-reachability';
import { recordKeyFire, registerAnnouncement, settleProvingFire } from './events/await/store';
import { requestAdmissionRecovery } from './work-item-admission-recovery';
import { admissionActionability } from './work-items-admission';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, activeWs: 'default' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  // EI-15345: mutable so a test can simulate a LOST AsyncLocalStorage request scope, where
  // activeWorkspaceId() silently falls through to a workspace that is NOT the item's own
  // (the WI-5261 class). Defaults to 'default' so every existing test is unchanged.
  return { ...actual, activeWorkspaceId: () => h.activeWs };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
const TEST_PARK_CONTRACT = {
  condition: 'explicit owner decision arrives', owner: 'park-owner', trigger: 'work-item:unblocked:WI-held',
  reachability: 'blocked' as const, evidence: 'fixture condition remains pending',
};
let db: FreshPgDb;

/** An issue-family (bug/change/task) row in the work_items BASE. */
async function seedIssue(
  id: string,
  opts: { status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, 'bug', ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null})`;
}

async function seedFeature(
  id: string,
  opts: { createdTs?: number; status?: string; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'open'}, NULL, ${WS}, ${opts.createdTs ?? 0}, 0,
       ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : db.sql.json({})})`;
}

async function readPayload(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return rows[0]?.payload ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-hold');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(WATCHDOG_TICKS_DDL).simple();
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(`CREATE TABLE harness_shared.admission_runs (
    id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text NOT NULL, run_kind text NOT NULL,
    started_at timestamptz, finished_at timestamptz, batch_size integer, held integer,
    model_id text, tokens_in bigint, tokens_out bigint, latency_ms integer, detail jsonb
  )`);
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.operator_secrets (name text PRIMARY KEY, value_b64 text);
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, workspace_id text, install_slug text, name text, target_role text,
      active boolean DEFAULT true, trigger_config jsonb, next_fire_at timestamptz,
      -- requestAdmissionRecovery stamps metadata.admissionOrdinarySlot on the promoter routine
      -- (work-item-admission-recovery.ts); without it the EI-266267 cases fail at registration.
      metadata jsonb
    );
  `).simple();
  await db.sql`INSERT INTO harness_shared.operator_secrets VALUES
    ('spawn-signing-key', ${Buffer.alloc(32, 42).toString('base64')})`;
  await db.sql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, target_role, trigger_config)
    VALUES ('claim-hold-promoter', ${WS}, ${H}, 'work-item-admission-promoter',
      'system:work-item-admission-promoter', '{"cron":"*/30 * * * *"}')`;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  // harness_features_consolidated is a VIEW over work_items (see _work-items-schema.ts) —
  // TRUNCATE only works on real tables, and truncating work_items already clears the view.
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.watchdog_ticks,
    harness_shared.admission_runs, harness_shared.event_awaits, harness_shared.event_key_fires`;
  h.activeWs = 'default';
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => {
  h.activeWs = 'default';
  setFlagOverridesForTest({});
});

describe('setWorkItemClaimHold (WI-2797)', () => {
  // `release:deployed:abc123` left this list with event-wait-settlement-2026-10-20 D-005: the
  // per-sha deploy key names one deploy and proves it landed, so it is not a broad wake.
  it.each(['work-item:claimable', 'release:deployed',
    'coord:inbox-wake:park-owner', 'fleet:item-completed:test',
    // event-wait-settlement-2026-10-20 P-001: subject-bound CHANGE notifications are wakes too.
    'work-item:status:WI-owner-grade-dependency', 'work-item:unblocked:WI-owner-grade-dependency'])
  ('does not mistake a broad fired wake for owner-grade clearance: %s', async (trigger) => {
    const id = 'WI-owner-grade-park';
    await seedIssue(id, { payload: { held_open_by: 'reviewer', held_open_reason: 'independent review' } });
    const releaseContract = await buildDurableParkReleaseContract({ condition: 'owner grade is cleared', trigger }, 'park-owner');
    await wi.setWorkItemClaimHold(id, true, { harness: H, parkedBy: 'park-owner', releaseContract });
    const original = await readPayload(id);
    await recordKeyFire({ eventKey: trigger, firedBy: 'unrelated-producer' });
    expect((await readEventConditionReachability(trigger)).basis).toBe('fired');
    const audit = await runWorkItemDurableParkAudit({ workspaceId: WS, harnessSlug: H,
      runId: 'broad-fire-audit', sql: db.sql, artifactPath: false });
    expect(audit.durableParks[0]?.releaseLiveness.status).toBe('unverified');
    expect(audit.durableParks[0]?.releaseLiveness.findings).toContain('reachability-unverified');
    expect(await readPayload(id)).toEqual(original);
  });

  it('refreshes a fired condition from the event ledger without changing the park, lease or assignment', async () => {
    const id = 'WI-event-park';
    // A completion key on the dependency: since event-wait-settlement-2026-10-20 P-001 a change
    // notification such as work-item:unblocked:<id> is never stamped reachable at write time.
    const trigger = `work-item:done:${id}-dependency`;
    await seedIssue(id, { takenBy: 'builder', payload: { held_open_by: 'reviewer', held_open_reason: 'independent review' } });
    const releaseContract = await buildDurableParkReleaseContract(
      { condition: `${id}-dependency reaches a terminal state`, trigger }, 'park-owner');
    expect(releaseContract.reachability).toBe('reachable');
    await wi.setWorkItemClaimHold(id, true, { harness: H, parkedBy: 'park-owner', releaseContract });
    const original = await readPayload(id);
    const audit = (runId: string) => runWorkItemDurableParkAudit({ workspaceId: WS, harnessSlug: H, runId, sql: db.sql, artifactPath: false });
    const before = await audit('before-fire');
    expect(before.durableParks[0]?.releaseLiveness.status).toBe('tracked');
    await recordKeyFire({ eventKey: trigger, firedBy: 'fixture-producer' });
    expect((await readEventConditionReachability(trigger)).basis).toBe('fired');
    const after = await audit('after-fire');
    expect(after.durableParks[0]?.releaseLiveness.status).toBe('satisfied-still-parked');
    expect(after.durableParks[0]?.releaseLiveness.evidence).toContain('event fired at');
    expect(await readPayload(id)).toEqual(original);
    const claim = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = ${id} AND workspace_id = ${WS}`;
    expect(claim[0]?.taken_by).toBe('builder');

    // A new producer generation must defeat the old latch; a fresh unresolved gate stays parked.
    await registerAnnouncement({ subscriberId: 'park-owner', eventKey: trigger, scopeKind: 'global', note: 'new condition generation' });
    expect((await readEventConditionReachability(trigger)).basis).toBe('live-resolver');
    const renewed = await audit('new-generation');
    expect(renewed.durableParks[0]?.releaseLiveness.status).toBe('tracked');
    expect(await readPayload(id)).toEqual(original);
  });

  // event-wait-settlement-2026-10-20 P-004: before it, a durable park released only when its
  // trigger had been ANNOUNCED; an unannounced completion fire left it parked indefinitely.
  it('AUTO-BAR-R-18-P-004: an unannounced proving fire releases the durable park the writer made', async () => {
    const id = 'WI-p004-park';
    const trigger = `work-item:done:${id}-dependency`;
    // Durable-park settlement writes its receipt here (writeDurableParkClearReceipt).
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
        id text PRIMARY KEY, ts bigint, actor text, action text, subject text,
        details jsonb, workspace_id text)`).simple();
    await seedIssue(id, { payload: { keepMe: 'kept' } });
    const releaseContract = await buildDurableParkReleaseContract(
      { condition: `${id}-dependency reaches done`, trigger, parkId: id }, 'park-owner');
    expect(releaseContract.reachability).toBe('reachable');
    await wi.setWorkItemClaimHold(id, true, { harness: H, parkedBy: 'park-owner', releaseContract });
    expect(await readPayload(id)).toMatchObject({ _claimHold: true, claim_hold_by: 'park-owner' });

    // The emit's two store calls, in order: the latch statement finds the waiter, then settlement.
    expect((await recordKeyFire({ eventKey: trigger, firedBy: 'fixture-producer' })).provingWaiterPending).toBe(true);
    expect(await settleProvingFire(trigger, { firedBy: 'fixture-producer' })).toBe(1);

    expect(await readPayload(id)).toEqual({ keepMe: 'kept' });
    // Nothing left waiting on the key: the next fire's latch reports no waiter.
    expect((await recordKeyFire({ eventKey: trigger, firedBy: 'fixture-producer' })).provingWaiterPending).toBe(false);
  });

  // EI-25664119449929994: the writer read the key's LIFETIME latch at park time, so a trigger
  // that had fired once before the park was born 'satisfied' (all 9 live stamps, 2026-10-11).
  it('never certifies a park from a fire that predates it, at write time or on audit refresh', async () => {
    const id = 'WI-prepark-fire';
    const trigger = 'work-item:done:WI-prepark-dependency';
    await seedIssue(id, { payload: {} });
    await recordKeyFire({ eventKey: trigger, firedBy: 'fixture-producer' });
    expect((await readEventConditionReachability(trigger)).basis).toBe('fired');
    const releaseContract = await buildDurableParkReleaseContract(
      { condition: 'WI-prepark-dependency is done and the leader confirms', trigger, parkId: id }, 'park-owner');
    expect(releaseContract.reachability).toBe('blocked');
    expect(releaseContract.evidence).toContain('before this park');
    await wi.setWorkItemClaimHold(id, true, { harness: H, parkedBy: 'park-owner', releaseContract });
    const audit = await runWorkItemDurableParkAudit({ workspaceId: WS, harnessSlug: H,
      runId: 'prepark-fire-audit', sql: db.sql, artifactPath: false });
    const park = audit.durableParks.find((p) => p.id === id);
    expect(park?.releaseLiveness.status).toBe('unverified');
    expect(park?.releaseLiveness.findings).not.toContain('condition-satisfied-still-parked');
    expect(park?.releaseLiveness.evidence).toContain('before this park');
  });

  it.each(['condition', 'owner', 'trigger', 'evidence', 'reachability', 'missing-contract'])('rejects an incomplete durable park (%s) without changing a lease or assignment', async (field) => {
    const original = { _claimHold: true, held_open_by: 'lease-owner', held_open_reason: 'independent review' };
    await seedIssue('WI-invalid-park', { takenBy: 'builder', payload: original });
    const contract = field === 'missing-contract' ? undefined : { ...TEST_PARK_CONTRACT, [field]: ' ' };
    await expect(wi.setWorkItemClaimHold('WI-invalid-park', true, {
      harness: H, parkedBy: 'park-owner', releaseContract: contract as never,
    })).rejects.toThrow(/durable park requires a complete release contract/);
    expect(await readPayload('WI-invalid-park')).toEqual(original);
    const rows = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'WI-invalid-park' AND workspace_id = ${WS}`;
    expect(rows[0]?.taken_by).toBe('builder');
  });
  it('sets payload._claimHold:true on an issue-family row', async () => {
    await seedIssue('WI-hold-1');
    const res = await wi.setWorkItemClaimHold('WI-hold-1', true, { harness: H });
    expect(res).toMatchObject({ id: 'WI-hold-1', hold: true, applicable: true });
    expect(await readPayload('WI-hold-1')).toMatchObject({ _claimHold: true });
  });

  it('clears payload._claimHold on hold:false (idempotent when already absent)', async () => {
    await seedIssue('WI-hold-2', { payload: { _claimHold: true, other: 'kept' } });
    const res = await wi.setWorkItemClaimHold('WI-hold-2', false, { harness: H });
    expect(res).toMatchObject({ id: 'WI-hold-2', hold: false, applicable: true });
    const payload = await readPayload('WI-hold-2');
    expect(payload).not.toHaveProperty('_claimHold');
    expect(payload).toMatchObject({ other: 'kept' }); // sibling payload keys survive the clear
  });

  it('applies to a FEATURE-family item too, stamping held_open_by/reason (P-006)', async () => {
    await seedFeature('F-hold-1');
    const res = await wi.setWorkItemClaimHold('F-hold-1', true, { harness: H, by: 'leader-1', reason: 'release gate' });
    expect(res).toMatchObject({ id: 'F-hold-1', hold: true, applicable: true });
    // The view has no payload column — the stamp lands on the work_items BASE row.
    expect(await readPayload('F-hold-1')).toMatchObject({
      _claimHold: true,
      held_open_by: 'leader-1',
      held_open_reason: 'release gate',
    });
    // WI-4531: the reader also surfaces `at` (held_open_at) — the hold's LEASE ANCHOR. The
    // expiry rule (a hold must not outlive its holder) is unenforceable without it, so assert
    // it is really a parseable timestamp rather than just widening the match to let it through.
    const held = wi.readWorkItemHeldOpenBy(await readPayload('F-hold-1'));
    expect(held).toEqual({ by: 'leader-1', reason: 'release gate', at: expect.any(String) });
    expect(Number.isNaN(Date.parse(held!.at!))).toBe(false);
  });

  it('clearing the hold removes ALL hold keys (_claimHold + held_open_by/reason/at), keeping siblings', async () => {
    await seedIssue('WI-hold-3');
    await wi.setWorkItemClaimHold('WI-hold-3', true, { harness: H, by: 'leader-1', reason: 'gating' });
    const payload = await readPayload('WI-hold-3');
    expect(payload).toMatchObject({ _claimHold: true, held_open_by: 'leader-1', held_open_reason: 'gating' });
    expect(payload).toHaveProperty('held_open_at');
    await wi.setWorkItemClaimHold('WI-hold-3', false, { harness: H });
    const cleared = await readPayload('WI-hold-3');
    for (const k of ['_claimHold', 'held_open_by', 'held_open_reason', 'held_open_at']) {
      expect(cleared).not.toHaveProperty(k);
    }
    expect(wi.readWorkItemHeldOpenBy(cleared)).toBeNull();
  });

  it('returns null for an id that does not exist', async () => {
    expect(await wi.setWorkItemClaimHold('WI-nonexistent', true, { harness: H })).toBeNull();
  });

  // EI-15345 (regression): the durable hold must persist even when the caller's ambient
  // activeWorkspaceId() does NOT match the item's OWN workspace.
  //
  // THE BUG: setWorkItemClaimHold derived its write scope from a bare activeWorkspaceId() /
  // issuesScopeWorkspace() — resolved several awaits deep in the release-tool call chain. When
  // the AsyncLocalStorage request scope is lost there (the WI-5261 class, "confirmed live for
  // papercusp-workspace, 2026-07-17" — the exact WI-1281 incident date), activeWorkspaceId()
  // silently falls through to the process-global default. Its `getWorkItem(id)` lookup (which
  // pins to activeWorkspaceId()) then returned null, so the whole call no-op'd: the release
  // reported success but payload._claimHold was NEVER persisted, and scheduler:get_next — which
  // is already WI-5261-hardened to resolve the item's correct workspace AND applies the
  // _claimHold feature floor — kept re-serving the item (WI-1281 re-served ~2h later, twice).
  //
  // The fix resolves the item's ACTUAL workspace by id (ambient-independent) and scopes the
  // write to it. This is the ONLY assertion the pre-fix code fails.
  describe('persists across a workspace-scope mismatch (EI-15345)', () => {
    async function seedFeatureInWorkspace(id: string, workspace: string, createdTs = 100) {
      await db.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
        VALUES (${H}, ${id}, 'feature', 'open', NULL, ${workspace}, ${createdTs}, ${createdTs})`;
    }
    async function payloadInWorkspace(id: string, workspace: string) {
      const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
        SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${workspace} AND feature_id = ${id}`;
      return rows[0]?.payload ?? null;
    }

    it('holds a feature-family item whose workspace differs from the ambient activeWorkspaceId()', async () => {
      await seedFeatureInWorkspace('WI-ws-mismatch', 'ws-real');
      // The caller's request scope was lost — activeWorkspaceId() reports the WRONG workspace.
      h.activeWs = 'ws-other';

      const res = await wi.setWorkItemClaimHold('WI-ws-mismatch', true, {
        harness: H,
        parkedBy: 'su-x',
        parkedReason: 'do not re-circulate',
        releaseContract: TEST_PARK_CONTRACT,
      });

      // The write must land on the item's OWN workspace, not the ambient one.
      expect(res).toMatchObject({ id: 'WI-ws-mismatch', hold: true, applicable: true });
      expect(await payloadInWorkspace('WI-ws-mismatch', 'ws-real')).toMatchObject({
        _claimHold: true,
        claim_hold_by: 'su-x',
        claim_hold_reason: 'do not re-circulate',
      });
    });

    it('persists the typed release contract with the durable park and removes it on explicit unpark', async () => {
      await seedFeatureInWorkspace('WI-release-contract', 'ws-real');
      h.activeWs = 'ws-other';
      const releaseContract = {
        condition: 'deployment finishes',
        owner: 'release-owner',
        trigger: 'deploy:ready:staging',
        reachability: 'reachable' as const,
        evidence: 'catalogued producer is live',
      };

      await wi.setWorkItemClaimHold('WI-release-contract', true, {
        harness: H,
        parkedBy: 'su-x',
        parkedReason: 'wait for deploy',
        releaseContract,
      });
      expect(await payloadInWorkspace('WI-release-contract', 'ws-real')).toMatchObject({
        _claimHold: true,
        claim_hold_by: 'su-x',
        claim_hold_release: releaseContract,
      });

      await wi.setWorkItemClaimHold('WI-release-contract', false, { harness: H });
      const cleared = await payloadInWorkspace('WI-release-contract', 'ws-real');
      expect(cleared).not.toHaveProperty('_claimHold');
      expect(cleared).not.toHaveProperty('claim_hold_release');
    });

    it('a scheduler self-select then EXCLUDES the (now correctly) held item', async () => {
      await seedFeatureInWorkspace('WI-ws-held', 'ws-real', 100); // oldest — would be served first
      await seedFeatureInWorkspace('WI-ws-free', 'ws-real', 200);
      // The hold is applied under a WRONG ambient workspace (the bug's condition)…
      h.activeWs = 'ws-other';
      await wi.setWorkItemClaimHold('WI-ws-held', true, { harness: H, parkedBy: 'su-z', releaseContract: TEST_PARK_CONTRACT });

      // …yet the claim floor (claimFloorsWhereSql) must now skip it. claimNextWorkItem resolves
      // the item's real workspace, so hold it steady for the claim leg.
      h.activeWs = 'ws-real';
      const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-ws' });
      expect(got?.id).toBe('WI-ws-free'); // never the held one, despite being seeded first/oldest
    });
  });
});

describe('claimNextWorkItem SKIPS a claim-held issue (WI-2797)', () => {
  it.each(['queued', 'held', 'delivered'] as const)(
    'EI-266267: a %s recovery preserves its target without changing ordinary unreviewed admission',
    async (state) => {
      const id = 'WI-recovery-reservation';
      await seedIssue(id, { createdTs: 100, payload: {
        admissionReview: { state: 'pending' },
        admissionHold: { reason: 'claimed-duplicate', actor: 'system:work-item-admission-promoter' },
      } });
      await db.sql`UPDATE harness_shared.work_items SET admission = 'unreviewed'
        WHERE workspace_id = ${WS} AND feature_id = ${id}`;
      const registered = await requestAdmissionRecovery({
        workspaceId: WS, harnessSlug: H, workItemId: id,
        caller: 'recovery-requester', target: 'recovery-target',
      }, { authorize: vi.fn(async () => {}) }, db.sql);
      await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{_admissionRecovery}',
        ${db.sql.json({ ...registered.request, state,
          stage: state === 'held' ? 'screen' : state === 'delivered' ? 'await-pickup' : 'queued' })})
        WHERE workspace_id = ${WS} AND feature_id = ${id}`;
      const original = await readPayload(id);
      await seedIssue('WI-unreviewed-control', { createdTs: 200 });
      await db.sql`UPDATE harness_shared.work_items SET admission = 'unreviewed'
        WHERE workspace_id = ${WS} AND feature_id = 'WI-unreviewed-control'`;

      const got = await wi.claimNextWorkItem({ harness: H, assignee: 'unrelated-scheduler' });
      // EI-26988974367709614: a delivered recovery still adds no reservation of its own, but the
      // row's live admissionHold now removes it from opportunistic self-select in EVERY recovery
      // state (the resume packet calls a held row non-actionable, so serving it to an unrelated
      // scheduler only produced claim/release churn). Recovery delivers by push-assignment
      // (deps.dispatch), and the by-id claim below still reaches the target.
      expect(got?.id).toBe('WI-unreviewed-control');
      expect(await wi.claimNextWorkItem({ harness: H, assignee: 'another-scheduler' })).toBeNull();
      const diagnosis = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'another-scheduler' });
      expect(diagnosis.readyUnclaimed).toBe(0);
      expect(diagnosis.pendingUnclaimed).toBeGreaterThan(0);
      expect(diagnosis.drained).toBe(false);
      expect(await readPayload(id)).toEqual(original);
      const targeted = await wi.claimWorkItem(id, 'recovery-target', { harness: H });
      expect(targeted?.assignee).toBe('recovery-target');
      expect(targeted?.payload?._admissionRecovery).toEqual(original?._admissionRecovery);
    },
  );

  // WI-6554700010029716: the per-id explainer read a hand-written floor list that dropped
  // ok_admission_recovery, so a queued/held recovery row read admissible:true while self-select
  // skipped it. Attribution and self-select must agree row for row.
  it.each([
    ['queued', 'admission-recovery'],
    ['held', 'admission-recovery'],
    ['delivered', null],
  ] as const)(
    'WI-6554700010029716: a %s recovery is attributed %s by the explainer, matching self-select',
    async (state, refusedBy) => {
      const id = `WI-recovery-explain-${state}`;
      await seedIssue(id, { createdTs: 100, payload: { _admissionRecovery: { state, target: 'recovery-target' } } });
      const [floor] = await wi.explainIssueClaimFloors(H, [id], { assignee: 'bee-explain' });
      expect(floor?.refusedBy).toBe(refusedBy);
      expect(floor?.admissible).toBe(refusedBy === null);
      const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-select' });
      expect(got?.id ?? null).toBe(refusedBy === null ? id : null);
    },
  );

  it('serves the unheld item, never the held one, when both are otherwise ready', async () => {
    await seedIssue('WI-held', { createdTs: 100, payload: { _claimHold: true } });
    await seedIssue('WI-open', { createdTs: 200 });

    // Oldest-first would normally serve WI-held (createdTs:100) — the hold must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-open');

    // Only one unheld candidate existed — it's now claimed, so the pool is genuinely dry.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    // The held item was NEVER claimed by the self-select path.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-held'`;
    expect(rows[0]?.taken_by).toBeNull();
  });

  it('a held item is STILL directly claimable by id (the hold only excludes self-select)', async () => {
    await seedIssue('WI-held-direct', { createdTs: 100, payload: { _claimHold: true } });
    const claimed = await wi.claimWorkItem('WI-held-direct', 'bee-direct', { harness: H });
    expect(claimed?.id).toBe('WI-held-direct');
    expect(claimed?.assignee).toBe('bee-direct');
  });

  it.each(['issue', 'feature'] as const)(
    'a pending-review admission cannot bypass a durable claim hold for %s rows',
    async (family) => {
      const id = family === 'issue' ? 'WI-held-review-admission' : 'F-held-review-admission';
      const payload = {
        _claimHold: true,
        agentReview: {
          status: 'pending',
          submittedBy: 'bee-submitter',
          ledgerIdeaId: id,
          round: 1,
        },
      };
      if (family === 'issue') await seedIssue(id, { payload });
      else await seedFeature(id, { payload });

      const {
        acceptanceSourceRevision,
        mintAgentReviewClaimAdmission,
        readAgentReviewState,
        verificationParties,
      } = await import('./harness/improvements/agent-review-policy');
      const review = readAgentReviewState(payload);
      expect(review).not.toBeNull();
      const source = await wi.getWorkItem(id, H);
      expect(source).not.toBeNull();
      const admission = mintAgentReviewClaimAdmission({
        itemId: id,
        reviewer: 'bee-reviewer',
        harnessSlug: H,
        review: review!,
        source: source!,
        parties: verificationParties({ payload }),
      });
      expect(admission).not.toBeNull();

      expect(await wi.claimWorkItem(id, 'bee-reviewer', {
        harness: H,
        agentReviewAdmission: admission!,
      })).toBeNull();

      // Prove the exact reviewer capability otherwise admits this same row.
      await wi.setWorkItemClaimHold(id, false, { harness: H });
      const claimed = await wi.claimWorkItem(id, 'bee-reviewer', {
        harness: H,
        agentReviewAdmission: admission!,
      });
      expect(claimed?.id).toBe(id);
      expect(readAgentReviewState(claimed!.payload)).toMatchObject({
        reviewedSourceRevision: acceptanceSourceRevision(source!),
      });
    },
  );

  it('the FEATURE tier likewise skips a held feature and serves the unheld one (P-006 floor)', async () => {
    await seedFeature('F-held', { createdTs: 100 });
    await wi.setWorkItemClaimHold('F-held', true, { harness: H, by: 'leader-1', reason: 'release gate' });
    await seedFeature('F-open', { createdTs: 200 });

    // Oldest-first would normally serve F-held (createdTs:100) — the P-006 floor must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-f1' });
    expect(got?.id).toBe('F-open');

    // The held feature was NEVER claimed by the self-select path…
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'F-held'`;
    expect(rows[0]?.taken_by).toBeNull();

    // …but clearing the hold makes it self-selectable again.
    await wi.setWorkItemClaimHold('F-held', false, { harness: H });
    const next = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-f2' });
    expect(next?.id).toBe('F-held');
  });

  it('clearing the hold makes the item self-selectable again', async () => {
    await seedIssue('WI-unheld-later', { createdTs: 100, payload: { _claimHold: true } });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' })).toBeNull();

    await wi.setWorkItemClaimHold('WI-unheld-later', false, { harness: H });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' });
    expect(got?.id).toBe('WI-unheld-later');
  });

  // EI-26988974367709614 recurrence guard. Before the fix, admittedWhereSql excluded only
  // admission='pending', so a fail-open `unreviewed` row the promoter had since HELD was
  // self-selectable while the resume packet told its claimant not to act. Luna Max
  // 2026-10-26: 380 such rows, claimed and released by member after member. Self-select,
  // floor attribution and resume must now read ONE contract, row for row.
  it('EI-26988974367709614: a held unreviewed row is skipped and attributed admission-hold; a pending-review-only row is served', async () => {
    await seedIssue('WI-adm-held', { createdTs: 100, payload: {
      admissionReview: { state: 'pending' },
      admissionHold: { reason: 'claimed-duplicate', actor: 'system:work-item-admission-promoter' },
    } });
    await seedIssue('WI-adm-review-only', { createdTs: 200, payload: { admissionReview: { state: 'pending' } } });
    await seedIssue('WI-adm-admitted', { createdTs: 300 });
    await db.sql`UPDATE harness_shared.work_items SET admission = 'unreviewed'
      WHERE workspace_id = ${WS} AND feature_id IN ('WI-adm-held', 'WI-adm-review-only')`;

    // The JS contract (resume) and the SQL floor (self-select) agree on each seeded row.
    expect(admissionActionability(await readPayload('WI-adm-held')).actionable).toBe(false);
    expect(admissionActionability(await readPayload('WI-adm-review-only')).actionable).toBe(true);
    const floors = await wi.explainIssueClaimFloors(H, ['WI-adm-held', 'WI-adm-review-only', 'WI-adm-admitted'], {
      assignee: 'bee-explain',
    });
    const byId = new Map(floors.map((f) => [f.id, f]));
    expect(byId.get('WI-adm-held')?.refusedBy).toBe('admission-hold');
    expect(byId.get('WI-adm-review-only')?.admissible).toBe(true);
    expect(byId.get('WI-adm-admitted')?.admissible).toBe(true);

    // Oldest-first would serve WI-adm-held; the floor skips it and serves the two actionable rows.
    const first = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-a' });
    const second = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-b' });
    expect([first?.id, second?.id]).toEqual(['WI-adm-review-only', 'WI-adm-admitted']);
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-c' })).toBeNull();

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'bee-c' });
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.drained).toBe(false);

    // Like every self-select floor, the hold never blocks a named claim by id.
    const named = await wi.claimWorkItem('WI-adm-held', 'bee-named', { harness: H });
    expect(named?.assignee).toBe('bee-named');
  });
});

describe('diagnoseClaimNextMiss reports a held-only backlog as pending-but-not-ready (WI-2797)', () => {
  it('pendingUnclaimed > 0, readyUnclaimed === 0 (genuinely gated, never a false race or false drained)', async () => {
    await seedIssue('WI-held-diag', { createdTs: 100, payload: { _claimHold: true } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(false); // work exists — a caller must not treat this as an empty queue
  });

  it('an unheld ready item alongside a held one counts fully in readyUnclaimed (the hold does not shadow siblings)', async () => {
    await seedIssue('WI-held-diag-2', { createdTs: 100, payload: { _claimHold: true } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.readyUnclaimed).toBeGreaterThanOrEqual(1);
  });
});

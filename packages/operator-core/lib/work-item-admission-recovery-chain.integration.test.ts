/**
 * P-003: exercise the production recovery composition, not a fake screen/dispatch.
 * Fresh PG owns every work-item/admission write. Only external model/transport and
 * ambient session-policy I/O are controlled; canonical create/read/claim, screening,
 * authorization composition, assignment and target-initiated pickup remain real.
 * A transport receipt is explicitly NOT proof of a running agent or a live deploy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolve } from 'node:path';
import {
  createFreshPgDb, applyMigrationForTest, applyEventSubstrateMigrationsForTest,
  type FreshPgDb,
} from '../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL,
  COORD_REF_HOLDERS_DDL,
} from '../test/_work-items-schema';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as Sql,
  denied: false, revoked: false,
  wake: vi.fn(), model: vi.fn(), claim: vi.fn(), dispatches: vi.fn(),
  denyPickupClaim: false,
  kernelDenied: false, kernelUnavailable: false, suToken: 'test-only-original-bearer-not-a-real-credential',
  policyRevision: 'current',
}));
vi.mock('./superuser-token', async (orig) => ({
  ...await orig<typeof import('./superuser-token')>(), readSuperuserToken: () => h.suToken,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async (orig) => ({
  ...await orig<typeof import('./workspace-registry')>(), activeWorkspaceId: () => 'default',
}));
vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    constructor(readonly name: string, readonly options?: unknown) {}
  }
  return {
    WorkflowQueue,
    DBOS: { workflowID: undefined, registerWorkflow: (implementation: unknown) => implementation },
  };
});
vi.mock('./harness/routines/system-actions', async (orig) => ({
  ...await orig<typeof import('./harness/routines/system-actions')>(),
  registerSystemAction: vi.fn(),
}));
vi.mock('./agent-tools/coordination/presence', async (orig) => ({
  ...await orig<typeof import('./agent-tools/coordination/presence')>(),
  getPresence: async (actor: string) => ({ workspaceId: 'default', revoked: actor === 'reviewer-session' && h.revoked }),
}));
vi.mock('./modes/store', async (orig) => ({
  ...await orig<typeof import('./modes/store')>(), getModes: async () => [],
}));
vi.mock('./operator-state-pg', async (orig) => ({
  ...await orig<typeof import('./operator-state-pg')>(), readOperatorState: async () => null,
}));
// Keep the REAL projected registry/dispatcher, capability resolver, tool handlers,
// identity resolver and canonical PG writes. These are the host's external policy
// and telemetry ports, not replacement tools or canned get/claim outcomes.
vi.mock('./projected-tool-deps', () => ({
  PROJECTED_DEPS: {
    defaultDeny: true,
    onDispatchStart: ({ toolName }: { toolName: string }) => h.dispatches(toolName),
    kernelEnforcement: async () => h.kernelUnavailable
      ? { decision: 'deny', code: 'policy-unavailable', reason: 'session authority reader unavailable' }
      : h.revoked || h.kernelDenied
        ? { decision: 'deny', code: 'revoked', reason: 'target authority revoked' }
        : { decision: 'allow', applied: true, revisionSource: 'applied',
          executionRevision: { specificationRevision: 'a'.repeat(64), stateRevision: h.policyRevision } },
    checkCapabilityEnvelope: async ({ toolName }: { toolName: string }) =>
      h.denyPickupClaim && toolName === 'work_items:claim'
        ? { decision: 'deny', reason: 'current target claim confinement' } : null,
  },
}));
vi.mock('./cache', async (orig) => ({
  ...await orig<typeof import('./cache')>(),
  cachedRead: async (_ctx: unknown, _opts: unknown, read: () => Promise<unknown>) => read(),
}));
vi.mock('./memory/claim-port', () => ({ buildClaimRecallBlock: async () => null }));
vi.mock('./premises-claim-port', () => ({ getClaimTimePremises: async () => null }));
vi.mock('@papercusp/flags/server', async (orig) => ({
  ...await orig<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));
vi.mock('./work-scope-policy', async (orig) => ({
  ...await orig<typeof import('./work-scope-policy')>(),
  readWorkScopePolicy: async () => ({ mode: 'enforce', allowHarnesses: ['papercusp'] }),
  // Never read or update the live workspace's cached control policy.
  isHarnessInScope: (slug: string) => slug === 'papercusp',
}));
vi.mock('./scheduler/fleet-scope-admission', async (orig) => ({
  ...await orig<typeof import('./scheduler/fleet-scope-admission')>(),
  admitWorkItemForFleetTarget: async ({ target }: { target: string }) =>
    h.denied && target === 'reviewer-session'
      ? { allowed: false, reason: 'restrictive reviewer override' } : { allowed: true },
}));
// Peripheral lifecycle subscriptions/events must not escape into live agent queues.
vi.mock('./work-items-events', async (orig) => ({
  ...await orig<typeof import('./work-items-events')>(),
  emitWorkItemCreatedEvent: vi.fn(), emitWorkItemClaimedEvent: vi.fn(),
  emitWorkItemClaimableEvent: vi.fn(),
}));
vi.mock('./interest-auto-arm', async (orig) => ({
  ...await orig<typeof import('./interest-auto-arm')>(),
  reconcileInterestEventAwaits: async () => undefined, retireInterestEventAwaits: async () => undefined,
}));
// The canonical claim handler adds an advisory source-citation hint by grepping
// the live repository. Keep this fresh-PG recovery test independent of that
// mutable-tree read and its spawner-sidecar process; source-citation behavior is
// covered by source-citation-claim-port.test.ts with an injected searcher.
vi.mock('./source-citation-claim-port', () => ({
  getClaimTimeSourceCitation: vi.fn(async () => null),
  sourceCitationWarning: vi.fn(() => null),
}));

const wi = await import('./work-items');
const { authorizeAdmissionRecovery, requestAdmissionRecovery } = await import('./work-item-admission-recovery');
const { assignAndWakeActionableWorkItems, authorizeWorkItemDispatch } =
  await import('./agent-tools/coordination/actionable-work-item-dispatch');
const { planItemLaneBlockReason, planItemLiveClaimReason } = await import('./scheduler/plan-item-lane-guard');
// Import the real definitions to register their real projected fn/schema/gates.
await import('./agent-tools/work_items/get');
await import('./agent-tools/work_items/claim');
await import('./agent-tools/work_items/pickup');
await import('./agent-tools/work_items/review-admission');
const { inProcessCall } = await import('./agent-tools/_compound-dispatch');
const { synthesizeDispatchPrincipal } = await import('./endpoint-route/routes/transport/role-principal-caps');
const { resolveAgentIdentity } = await import('./agent-tools/coordination/identity');
const { admissionCredentialDigest, admissionReplayContext } = await import('./work-item-admission-authority');
const { requestAdmissionReview } = await import('./work-item-admission-review');
const { appendFleetMembershipEvent } = await import('./fleet-membership-store');
const originalContext = {
  workspaceId: 'default', harnessSlug: 'original-harness', profile: 'engineer' as const,
  runId: 'original-run', spawnId: 'original-spawn', parentSpawnId: 'original-parent',
  chunkId: 'original-chunk', featureId: 'original-feature', planRunSessionId: null,
  transport: 'mcp' as const,
};
// A trusted signed-spawn principal preserves its accepted uiClientId session owner.
// Ordinary bearer clients remain namespaced under `system:reviewer`.
// Recovery dispatch, durable assignment, and target-owned pickup must use that same
// session id rather than assigning the principal's ordinary bearer identity.
const reviewerOwnerId = 'reviewer-session';
const { runAdmissionPromoterWithRecovery } = await import('./harness/routines/work-item-admission-promoter-action');
const { readWorkItemAdmissionSnapshot } = await import('./work-items-admission-promoter');
const { observeFallback, fallbackObservationCounters, _pendingFallbackObservationCount,
  flushFallbackObservations } = await import('./degradation/fallback-observations');

let db: FreshPgDb;
let run = 0;
const scope = { workspaceId: 'default', harnessSlug: 'papercusp' };
beforeAll(async () => {
  db = await createFreshPgDb('admission_recovery_chain');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(COORD_REF_HOLDERS_DDL);
  await applyMigrationForTest(db.sql, resolve(import.meta.dirname,
    '../../../libs/papercusp/libs/db/sql/944-work-queue-admission-dedup.sql'));
  // The supported snapshot reader also projects occurrence/readiness stock.
  for (const migration of ['831-issue-occurrence-ledger.sql', '1294-work-item-readiness-payload-projections.sql']) {
    await applyMigrationForTest(db.sql, resolve(import.meta.dirname, '../../../libs/papercusp/libs/db/sql', migration));
  }
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS embedding vector(3),
      ADD COLUMN IF NOT EXISTS embedding_mode text,
      ADD COLUMN IF NOT EXISTS first_claimed_at timestamptz;
    CREATE OR REPLACE FUNCTION harness_shared.work_item_status_is_terminal(value text)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
        SELECT value = ANY(ARRAY['done','dropped','deprecated','passed','failed','resolved','closed']::text[])
      $$;
    CREATE TABLE harness_shared.operator_secrets(name text PRIMARY KEY, value_b64 text);
    CREATE TABLE harness_shared.audit_log (
      id text PRIMARY KEY, ts bigint NOT NULL, workspace_id text NOT NULL,
      actor text NOT NULL, action text NOT NULL, subject text NOT NULL, details jsonb
    );
    CREATE TABLE harness_shared.system_principals (
      workspace_id text, name text, capabilities jsonb, PRIMARY KEY (workspace_id, name)
    );
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, workspace_id text, install_slug text, name text, target_role text,
      active boolean DEFAULT true, trigger_config jsonb, next_fire_at timestamptz, metadata jsonb
    );
    -- Claim admission now reads the active operation-worker receipt even for
    -- ordinary targets; an empty session table proves this fixture has no bound worker.
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      role text, started_at timestamptz DEFAULT now(), ended_at timestamptz, ended_by text
    );
  `);
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'work-item-admission-recovery-chain.integration',
    extra: [
      '123-coordination-substrate.sql',
      '429-coord-entity-subscriptions-allow-fleet-kind.sql',
      '568-coord-entity-subscriptions-allow-event-kind.sql',
      '602-work-item-follow-blockers.sql',
      '1257-coord-entity-subscriptions-allow-muted.sql',
    ],
    runtimeTables: ['harness_shared.coord_entity_subscriptions'],
    knownInapplicable: [
      {
        file: '149-coord-threads-federation.sql',
        reason:
          'attaches federation outbox triggers to coord_threads/coord_thread_posts that call ' +
          'harness_shared.capture_substrate_outbox(), created by 108-substrate-capture-reconcile ' +
          'alongside tables this fixture does not build; this recovery chain never writes coord threads',
      },
    ],
  });
  // WI-10005130: shared claim-path read deps go LAST (all IF NOT EXISTS), after the
  // hand-built adv_sessions and the migration-built event substrate above.
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql`INSERT INTO harness_shared.operator_secrets VALUES
    ('spawn-signing-key', ${Buffer.alloc(32, 42).toString('base64')})`;
}, 60_000);
afterAll(async () => db?.cleanup());
beforeEach(async () => {
  h.denied = false;
  h.revoked = false;
  h.denyPickupClaim = false;
  h.kernelDenied = false;
  h.kernelUnavailable = false;
  h.policyRevision = 'current';
  h.suToken = 'test-only-original-bearer-not-a-real-credential';
  h.dispatches.mockReset();
  h.model.mockReset().mockRejectedValue(new Error('unexpected external model call'));
  h.wake.mockReset().mockResolvedValue({ queued: 1, woken: 0, staged: 0, timedOutTargets: [] });
  h.claim.mockReset().mockImplementation(wi.claimWorkItem);
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.dedup_edges,
    harness_shared.dedup_adjudications, harness_shared.admission_runs, harness_shared.routines,
    harness_shared.system_principals, harness_shared.fleet_assignment, harness_shared.fleet_membership_events,
    harness_shared.audit_log`;
  await db.sql`INSERT INTO harness_shared.system_principals VALUES
    ('default', 'reviewer', '["coord:write","work_items:read","work_items:write"]')`;
  await db.sql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, target_role, trigger_config, next_fire_at)
    VALUES ('original-promoter','default','papercusp','work-item-admission-promoter',
      'system:work-item-admission-promoter','{"cron":"*/30 * * * *"}', now() + interval '30 minutes')`;
});

async function create(title = 'Original independent review') {
  return wi.createWorkItem({
    kind: 'feature', title, harness: scope.harnessSlug, workspaceId: scope.workspaceId,
    assignee: reviewerOwnerId, admission: 'pending', payload: { keep: 'original instructions' },
  });
}
function request(id: string) {
  return requestAdmissionRecovery({
    ...scope, workItemId: id, caller: 'requester', target: reviewerOwnerId,
    note: 'Review original work', body: 'Report findings; do not implement.',
    authority: {
      kind: 'signed-spawn', role: 'reviewer', expiresAtSec: 0,
      context: originalContext,
      credentialSha256: admissionCredentialDigest(Buffer.alloc(32, 42)),
    },
  });
}

describe('original authority context fidelity', () => {
  it('drains queued fallback observations before retiring a fresh PG fixture', async () => {
    // Start with no ambient work so the observation belongs to this lifecycle.
    await flushFallbackObservations({ sql: db.sql });
    const queries: string[] = [];
    const retiring = await createFreshPgDb('admission_fallback_cleanup', {
      onQuery: (query) => queries.push(query),
    });
    const failedBefore = fallbackObservationCounters().failed;
    expect(observeFallback('admission-cleanup-regression', {
      eligible: 1, applied: 0, reason: 'queued-at-teardown',
    })).toBe(true);
    expect(_pendingFallbackObservationCount()).toBe(1);
    await retiring.cleanup();
    expect(_pendingFallbackObservationCount()).toBe(0);
    expect(fallbackObservationCounters().failed).toBe(failedBefore);
    expect(queries.some((query) => query.includes('INSERT INTO harness_shared.fallback_observations')))
      .toBe(true);
  });

  it('fails fresh PG teardown on a lost observation while still closing its pool', async () => {
    await flushFallbackObservations({ sql: db.sql });
    const retiring = await createFreshPgDb('admission_fallback_rejected');
    await retiring.sql.unsafe(`ALTER TABLE harness_shared.fallback_observations
      ADD CONSTRAINT reject_cleanup_probe CHECK (reason <> 'rejected-at-teardown')`);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      observeFallback('admission-cleanup-regression', {
        eligible: 1, applied: 0, reason: 'rejected-at-teardown',
      }, { sql: retiring.sql });
      await expect(retiring.cleanup()).rejects.toThrow('Fresh PG cleanup lost fallback observations');
      expect(_pendingFallbackObservationCount()).toBe(0);
      await expect(retiring.sql`SELECT 1`).rejects.toMatchObject({ code: 'CONNECTION_ENDED' });
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['due', 'legacy'] as const)(
    'screens and replays a %s ordinary slot with the operator string timestamp representation', async (slot) => {
      const original = await create('String timestamp ordinary admission');
      if (slot === 'due') await db.sql`UPDATE harness_shared.routines SET metadata =
        '{"admissionOrdinarySlot":{"dueAt":"2000-01-01T00:00:00.000Z"}}'
        WHERE id = 'original-promoter'`;
      // Reproduce the production wire shape with a real PG connection, rather
      // than replacing the scheduler, slot writes, or screening composition.
      const wireSql = postgres(db.url, {
        max: 2, prepare: false, onnotice: () => {},
        types: { timestamptz: { to: 1184, from: [1184], serialize: String, parse: (value: string) => value } },
      });
      try {
        const [clock] = await wireSql`SELECT now() AS now`;
        expect(typeof clock!.now).toBe('string');
        const options = { ...scope, runId: `string-clock-${slot}`, batchSize: 10,
          recentTerminalDays: 30, model: undefined };
        const deps = { sql: wireSql, lockSql: db.sql, llmCall: h.model,
          authorize: authorizeAdmissionRecovery, dispatch };
        const result = await runAdmissionPromoterWithRecovery(options, deps);
        expect(result).toMatchObject({ promoted: 1, modelCalled: false });
        expect(await row(original.id)).toMatchObject({ admission: 'admitted' });
        const [routine] = await db.sql`SELECT metadata FROM harness_shared.routines
          WHERE id = 'original-promoter'`;
        const savedSlot = routine!.metadata.admissionOrdinarySlot;
        expect(Date.parse(savedSlot.dueAt)).toBeGreaterThan(Date.parse(clock!.now));
        expect(await runAdmissionPromoterWithRecovery(options, deps)).toEqual(result);
        const [replayed] = await db.sql`SELECT metadata FROM harness_shared.routines
          WHERE id = 'original-promoter'`;
        expect(replayed!.metadata.admissionOrdinarySlot).toEqual(savedSlot);
        expect(h.model).not.toHaveBeenCalled();
      } finally {
        await wireSql.end({ timeout: 5 });
      }
    },
  );

  it('retains a durable ordinary opportunity while unrelated exact recoveries keep arriving', async () => {
    const original = await create('Ordinary fairness target');
    const twin = await create(original.title);
    const [a, b] = [original.id, twin.id].sort();
    h.model.mockResolvedValue({ text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
      json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'distinct', reason: 'Independent fixes' }] } });
    const [natural] = await db.sql`SELECT next_fire_at FROM harness_shared.routines WHERE id = 'original-promoter'`;
    await request(original.id);
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({ state: 'held', stage: 'screen' });

    const unrelated = await create('First unrelated exact recovery');
    await request(unrelated.id);
    const [preserved] = await db.sql`SELECT metadata->'admissionOrdinarySlot' AS slot
      FROM harness_shared.routines WHERE id = 'original-promoter'`;
    expect(new Date(preserved!.slot.dueAt)).toEqual(natural!.next_fire_at);
    const claimCallStart = h.claim.mock.calls.length;
    const dispatchToolCallStart = h.dispatches.mock.calls.length;
    const wakeCallStart = h.wake.mock.calls.length;
    let dispatchResult: Awaited<ReturnType<typeof dispatch>> | undefined;
    const promoter = await runAdmissionPromoterWithRecovery({
      ...scope, runId: `chain-${++run}`, batchSize: 10, recentTerminalDays: 30, model: undefined,
    }, {
      sql: db.sql, lockSql: db.sql, llmCall: h.model, authorize: authorizeAdmissionRecovery,
      dispatch: async (args) => {
        dispatchResult = await dispatch(args);
        return dispatchResult;
      },
    });
    const observed = await row(unrelated.id);
    const recovery = observed.payload?._admissionRecovery as Record<string, unknown> | undefined;
    const claimResults = await Promise.all(h.claim.mock.results.slice(claimCallStart).map(async (result) => {
      if (result.type !== 'return') return { type: result.type };
      try {
        const value = await result.value;
        return {
          type: result.type,
          claimed: value !== null && value !== undefined,
          itemId: value?.id ?? value?.feature_id ?? null,
          assignee: value?.assignee ?? value?.taken_by ?? null,
        };
      } catch (error) {
        return { type: 'rejected', error: String(error).slice(0, 300) };
      }
    }));
    const diagnostic = JSON.stringify({
      promoter: { runId: promoter.runId, promoted: promoter.promoted, held: promoter.held },
      row: { id: observed.feature_id, status: observed.status, admission: observed.admission,
        taken_by: observed.taken_by },
      recovery: recovery && Object.fromEntries(
        ['requestId', 'state', 'stage', 'reason', 'target', 'routineId', 'updatedAt']
          .filter((key) => key in recovery).map((key) => [key, recovery[key]]),
      ),
      dispatch: dispatchResult && {
        ok: dispatchResult.ok,
        assigned: dispatchResult.assignment.assigned,
        retained: dispatchResult.assignment.retained,
        skipped: dispatchResult.assignment.skipped.map(({ workItemId, code, reason }) =>
          ({ workItemId, code, reason: reason.slice(0, 500) })),
        failed: dispatchResult.assignment.failed,
        executionWorkItemIds: dispatchResult.assignment.executionWorkItemIds,
        wake: dispatchResult.wake && {
          queued: dispatchResult.wake.queued,
          woken: dispatchResult.wake.woken,
        },
      },
      dispatchToolCalls: h.dispatches.mock.calls.slice(dispatchToolCallStart).map(([name]) => name),
      claimCalls: h.claim.mock.calls.slice(claimCallStart).map(([id, assignee]) => ({ id, assignee })),
      claimResults,
      wakeCalls: h.wake.mock.calls.slice(wakeCallStart).map(([targets]) => targets),
    }, null, 2);
    expect(observed, diagnostic).toMatchObject({ admission: 'admitted', taken_by: reviewerOwnerId });
    expect(await row(original.id)).toMatchObject({ admission: 'pending', taken_by: null });

    // Advance the persisted timer as if the host restarted after the natural
    // deadline. A new exact request must not replace that ordinary obligation.
    await db.sql`UPDATE harness_shared.routines SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb), '{admissionOrdinarySlot}',
      jsonb_build_object('dueAt', now() - interval '1 second')) WHERE id = 'original-promoter'`;
    const next = await create('Second unrelated exact recovery');
    const queued = await request(next.id);
    const ordinaryRunId = `chain-ordinary-restart-${++run}`;
    const invoke = (runId = ordinaryRunId) => runAdmissionPromoterWithRecovery({
      ...scope, runId, batchSize: 10, recentTerminalDays: 30, model: undefined,
    }, { sql: db.sql, lockSql: db.sql, llmCall: h.model, authorize: authorizeAdmissionRecovery, dispatch });
    h.model.mockRejectedValueOnce(new Error('controlled interruption after ordinary slot claim'));
    await expect(invoke()).rejects.toThrow('controlled interruption after ordinary slot claim');
    expect((await row(next.id)).payload._admissionRecovery).toMatchObject({
      requestId: queued.request.requestId, state: 'queued',
    });
    const [retained] = await db.sql`SELECT metadata->'admissionOrdinarySlot' AS slot
      FROM harness_shared.routines WHERE id = 'original-promoter'`;
    expect(retained!.slot.runId).toBe(ordinaryRunId);

    // Re-enter through the production composition with only PG as continuity.
    const successorRunId = `${ordinaryRunId}-successor`;
    await invoke(successorRunId);
    expect(await row(original.id)).toMatchObject({ admission: 'admitted', taken_by: null });
    expect((await row(next.id)).payload._admissionRecovery).toMatchObject({ state: 'queued' });
    const [ledger] = await db.sql`SELECT detail FROM harness_shared.admission_runs WHERE id = ${ordinaryRunId}`;
    expect(ledger!.detail.componentScreening.itemIds).toContain(original.id);
    expect(ledger!.detail.componentScreening.receipts).toContainEqual({
      itemId: original.id, stage: 'recheck', reason: 'selected',
    });
    const calls = h.model.mock.calls.length;
    expect(await invoke()).toMatchObject({ runId: ordinaryRunId });
    expect(await invoke(successorRunId)).toMatchObject({ runId: ordinaryRunId });
    expect(h.model).toHaveBeenCalledTimes(calls);
    expect((await row(next.id)).payload._admissionRecovery).toMatchObject({ state: 'queued' });
    const [scheduled] = await db.sql`SELECT next_fire_at <= now() AS due
      FROM harness_shared.routines WHERE id = 'original-promoter'`;
    expect(scheduled!.due).toBe(true);
    await tick();
    expect(await row(next.id)).toMatchObject({ admission: 'admitted', taken_by: reviewerOwnerId });
    // A later ordinary cycle replaces the small metadata witness. The original
    // workflow still reads its own completed ledger rather than consuming C.
    await tick();
    const afterCycle = h.model.mock.calls.length;
    expect(await invoke()).toMatchObject({ runId: ordinaryRunId });
    expect(h.model).toHaveBeenCalledTimes(afterCycle);
  });

  it('keeps an explicit target separate from a due ordinary slot', async () => {
    const selected = await create('Explicit target');
    const unrelated = await create('Unrelated ordinary target');
    const slot = { dueAt: '2000-01-01T00:00:00.000Z' };
    await db.sql`UPDATE harness_shared.routines SET metadata =
      ${JSON.stringify({ admissionOrdinarySlot: slot })}::text::jsonb WHERE id = 'original-promoter'`;
    const result = await runAdmissionPromoterWithRecovery({
      ...scope, runId: `chain-exact-${++run}`, batchSize: 10, recentTerminalDays: 30,
      model: undefined, targetItemIds: [selected.id],
    }, { sql: db.sql, lockSql: db.sql, llmCall: h.model, authorize: authorizeAdmissionRecovery, dispatch });
    expect(result.promoted).toBe(1);
    expect(await row(selected.id)).toMatchObject({ admission: 'admitted', taken_by: null });
    expect(await row(unrelated.id)).toMatchObject({ admission: 'pending', taken_by: null });
    const [routine] = await db.sql`SELECT metadata FROM harness_shared.routines WHERE id = 'original-promoter'`;
    expect(routine!.metadata.admissionOrdinarySlot).toEqual(slot);
  });

  it('serializes competing ordinary invocations without a transaction across model I/O', async () => {
    const original = await create('Concurrent ordinary slot');
    const twin = await create(original.title);
    const [a, b] = [original.id, twin.id].sort();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    h.model.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return { text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
        json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'distinct', reason: 'Independent fixes' }] } };
    });
    const first = tick();
    try {
      await started;
      expect(await tick()).toMatchObject({ batchSize: 0, promoted: 0, modelCalled: false });
      const [tx] = await db.sql`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'`;
      expect(tx!.count).toBe(0);
    } finally {
      finish();
      await first;
    }
    expect(h.model).toHaveBeenCalledTimes(1);
  });

  it('settles an ordinary slot after the last finite recurrence', async () => {
    await create('Final ordinary occurrence');
    await db.sql`UPDATE harness_shared.routines SET
      trigger_config = '{"rrule":"FREQ=DAILY;COUNT=1","dtstart":"2000-01-01T00:00:00.000Z"}',
      metadata = '{"admissionOrdinarySlot":{"dueAt":"2000-01-01T00:00:00.000Z"}}'
      WHERE id = 'original-promoter'`;
    expect(await tick()).toMatchObject({ promoted: 1 });
    const [routine] = await db.sql`SELECT metadata FROM harness_shared.routines WHERE id = 'original-promoter'`;
    expect(routine!.metadata.admissionOrdinarySlot.dueAt).toBeNull();
  });

  it.each(['paused', 'role', 'workspace', 'harness', 'malformed'] as const)(
    'refuses ordinary screening with a %s promoter rather than consuming queued authority', async (invalid) => {
      const original = await create('Refused ordinary slot');
      await request(original.id);
      await db.sql`UPDATE harness_shared.routines SET metadata =
        '{"admissionOrdinarySlot":{"dueAt":"2000-01-01T00:00:00.000Z"}}' WHERE id = 'original-promoter'`;
      if (invalid === 'paused') await db.sql`UPDATE harness_shared.routines SET active = false`;
      if (invalid === 'role') await db.sql`UPDATE harness_shared.routines SET target_role = 'system:other'`;
      if (invalid === 'workspace') await db.sql`UPDATE harness_shared.routines SET workspace_id = 'other'`;
      if (invalid === 'harness') await db.sql`UPDATE harness_shared.routines SET install_slug = 'other'`;
      if (invalid === 'malformed') await db.sql`UPDATE harness_shared.routines SET metadata =
        '{"admissionOrdinarySlot":{"dueAt":"not-a-date"}}'`;
      await expect(tick()).rejects.toThrow();
      expect(h.model).not.toHaveBeenCalled();
      expect(await row(original.id)).toMatchObject({ admission: 'pending', taken_by: null });
      expect((await row(original.id)).payload._admissionRecovery.state).toBe('queued');
    },
  );

  it('uses ordinary component screening for an authenticated scope-held request beyond the FIFO window', async () => {
    const original = await create('Component screening target');
    const twin = await create(original.title);
    for (let i = 0; i < 31; i++) {
      const backlog = await create(`Unrelated earlier work ${i}`);
      await db.sql`UPDATE harness_shared.work_items SET created_ts = ${i + 1} WHERE feature_id = ${backlog.id}`;
    }
    const [a, b] = [original.id, twin.id].sort();
    h.model.mockResolvedValue({ text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
      json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'distinct', reason: 'Independent fixes' }] } });
    const first = await request(original.id);
    const exact = await tick();
    expect(exact.guardRefusals).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: original.id, reason: 'outside-mutation-scope' }),
    ]));
    const [exactLedger] = await db.sql`SELECT detail FROM harness_shared.admission_runs
      WHERE id = ${`${exact.runId}:recovery:${original.id}`}`;
    expect(exactLedger).toBeDefined();
    expect(exactLedger!.detail).not.toHaveProperty('componentScreening');
    const held = (await row(original.id)).payload._admissionRecovery;
    expect(held).toMatchObject({ requestId: first.request.requestId, state: 'held', stage: 'screen' });
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
    // This is a separate ordinary tick, with no targetItemIds or request replay.
    const ordinary = await tick();
    expect(h.model).toHaveBeenCalledTimes(2);
    expect(await row(original.id)).toMatchObject({ admission: 'admitted', taken_by: null });
    // The outside-window twin participates in the component's adjudication but
    // is not itself selected for promotion by this ordinary batch.
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
    expect(await db.sql`SELECT a, b FROM harness_shared.dedup_adjudications
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
        AND a = ${a} AND b = ${b}`).toHaveLength(1);
    expect((await row(original.id)).payload._admissionRecovery).toEqual(held);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    const snapshot = await readWorkItemAdmissionSnapshot({ ...scope, sql: db.sql });
    expect(snapshot.runs.find((entry) => entry.id === ordinary.runId)?.detail).toMatchObject({
      componentScreening: { itemIds: [original.id], receipts: [
        { itemId: original.id, stage: 'recheck', reason: 'selected' },
      ] },
    });
  });

  it('persists a refused component request on the ordinary ledger without granting priority or mutating it', async () => {
    const original = await create('Refused component target');
    const twin = await create(original.title);
    const [a, b] = [original.id, twin.id].sort();
    h.model.mockResolvedValue({ text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
      json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'distinct', reason: 'Independent fixes' }] } });
    await request(original.id);
    await tick();
    await db.sql`UPDATE harness_shared.work_items SET payload =
      jsonb_set(payload, '{_admissionRecovery,signature}', ${db.sql.json('0'.repeat(64))})
      WHERE feature_id = ${original.id}`;
    const before = await row(original.id);
    // Keep this rejected request and its twin beyond the ordinary FIFO batch.
    for (let i = 0; i < 31; i++) {
      const earlier = await create(`Unrelated refusal backlog ${i}`);
      await db.sql`UPDATE harness_shared.work_items SET created_ts = ${i + 1} WHERE feature_id = ${earlier.id}`;
    }
    const ordinary = await tick();
    const snapshot = await readWorkItemAdmissionSnapshot({ ...scope, sql: db.sql });
    const detail = snapshot.runs.find((entry) => entry.id === ordinary.runId)?.detail;
    expect(detail).toMatchObject({ status: 'complete', componentScreening: { itemIds: [], receipts: [
      { itemId: original.id, stage: 'provenance', reason: 'recovery-refused' },
    ] } });
    expect(JSON.stringify(detail?.componentScreening)).not.toContain('signature');
    expect(await row(original.id)).toEqual(before);
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
    expect(h.model).toHaveBeenCalledTimes(1);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('judges an authenticated original while keeping its newly claimed twin read-only', async () => {
    const original = await create('Protected component screening target');
    const twin = await create(original.title);
    const [a, b] = [original.id, twin.id].sort();
    h.model.mockResolvedValue({ text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
      json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'distinct', reason: 'Independent fixes' }] } });
    await request(original.id);
    await tick();
    const held = (await row(original.id)).payload._admissionRecovery;
    expect(held).toMatchObject({ state: 'held', stage: 'screen', reason: expect.stringContaining('outside-mutation-scope') });
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'live-peer' WHERE feature_id = ${twin.id}`;
    await tick();
    // The ordinary authenticated comparison exception permits a read-only
    // claimed twin; it grants no assignment or write authority over that twin.
    expect(h.model).toHaveBeenCalledTimes(2);
    expect(await row(original.id)).toMatchObject({ admission: 'admitted', taken_by: null });
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: 'live-peer' });
    expect((await row(original.id)).payload._admissionRecovery).toEqual(held);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('retains selection receipts when the ordinary model call fails after selection', async () => {
    const original = await create('Failed component screening');
    const twin = await create(original.title);
    const [a, b] = [original.id, twin.id].sort();
    h.model.mockResolvedValueOnce({ text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
      json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'distinct', reason: 'Independent fixes' }] } });
    await request(original.id);
    await tick();
    const before = await row(original.id);
    h.model.mockRejectedValue(new Error('expected external fixture failure'));
    await expect(tick()).rejects.toThrow('expected external fixture failure');
    const snapshot = await readWorkItemAdmissionSnapshot({ ...scope, sql: db.sql, state: 'failed' });
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]!.detail).toMatchObject({ status: 'failed', componentScreening: {
      itemIds: [original.id], receipts: [{ itemId: original.id, stage: 'recheck', reason: 'selected' }],
    } });
    expect(await row(original.id)).toEqual(before);
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('retains original harness/run/chunk/spawn instead of substituting the item scope', async () => {
    const ctx = await admissionReplayContext(db.sql, { ...scope, workItemId: 'WI-context' }, 'requester', {
      kind: 'signed-spawn', role: 'reviewer', expiresAtSec: 0, context: originalContext,
      credentialSha256: admissionCredentialDigest(Buffer.alloc(32, 42)),
    });
    expect(ctx).toMatchObject({ ...originalContext, uiClientId: 'requester' });
  });

  it('refuses credential-only legacy bindings rather than inventing quota context', async () => {
    await expect(admissionReplayContext(db.sql, { ...scope, workItemId: 'WI-context' }, 'requester', {
      kind: 'superuser', role: 'operator', credentialSha256: admissionCredentialDigest(h.suToken),
    })).rejects.toThrow('original dispatch context missing');
  });

  it('detects signed context tampering and repairs the same request through fresh authority', async () => {
    const original = await create();
    const first = await request(original.id);
    await db.sql`UPDATE harness_shared.work_items SET payload =
      jsonb_set(payload, '{_admissionRecovery,authority,context,runId}', '"tampered"')
      WHERE feature_id = ${original.id}`;
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      state: 'held', stage: 'authorize', reason: expect.stringContaining('provenance is invalid'),
    });
    expect(h.claim).not.toHaveBeenCalled();
    const repair = await request(original.id);
    expect(repair.request.requestId).toBe(first.request.requestId);
    expect(repair.request.authority?.context).toEqual(originalContext);
  });
});

function dispatch(args: Parameters<typeof assignAndWakeActionableWorkItems>[0]) {
  return assignAndWakeActionableWorkItems(args, {
    observe: wi.observeWorkItem, claim: h.claim, authorize: authorizeWorkItemDispatch,
    explainClaimFloors: wi.explainIssueClaimFloors, blockers: wi.readUnresolvedDepBlockers,
    readClaimConcurrency: async () => ({ blocked: false, activeClaims: 0, maxConcurrentClaims: 1,
      heldIds: [], blockerParkedIds: [] }),
    planBlock: planItemLaneBlockReason, planClaim: planItemLiveClaimReason,
    resolveTarget: async () => ({
      requested: reviewerOwnerId, ownerId: reviewerOwnerId, present: true, sessionState: 'parked', wakeable: true,
    }),
    wake: h.wake,
  });
}
function tick() {
  return runAdmissionPromoterWithRecovery({
    ...scope, runId: `chain-${++run}`, batchSize: 10, recentTerminalDays: 30, model: undefined,
  }, { sql: db.sql, lockSql: db.sql, llmCall: h.model, authorize: authorizeAdmissionRecovery, dispatch });
}
async function row(id: string) {
  const [r] = await db.sql`SELECT feature_id, title, status, admission, taken_by, payload
    FROM harness_shared.work_items WHERE workspace_id = ${scope.workspaceId}
      AND harness_slug = ${scope.harnessSlug} AND feature_id = ${id}`;
  return r!;
}

const reviewLeader = 'su-11111111-1111-4111-8111-111111111111';
function reviewAuthority() {
  return { kind: 'signed-spawn' as const, role: 'reviewer', expiresAtSec: 0,
    context: originalContext, credentialSha256: admissionCredentialDigest(Buffer.alloc(32, 42)) };
}
async function placeReview(id: string) {
  for (const [ownerId, fleetRole] of [[reviewLeader, 'leader'], [reviewerOwnerId, 'member']]) {
    await appendFleetMembershipEvent({ workspaceId: scope.workspaceId, ownerId: ownerId!,
      fleetSlug: 'review-fleet', fleetRole: fleetRole! }, db.sql);
  }
  await db.sql`INSERT INTO harness_shared.fleet_assignment
    (workspace_id, harness_slug, work_item_id, fleet_slug, agent_id, claim_active)
    VALUES ('default', 'papercusp', ${id}, 'review-fleet', ${reviewerOwnerId}, true)`;
}
function review(id: string, caller = reviewerOwnerId) {
  return requestAdmissionReview({ ...scope, workItemId: id }, { caller, authority: reviewAuthority() }, db.sql);
}
async function claimOriginal(id: string) {
  await db.sql`UPDATE harness_shared.work_items SET taken_by = ${reviewerOwnerId}, status = 'wip'
    WHERE feature_id = ${id}`;
}
function distinctPair(a: string, b: string) {
  return { text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
    json: { judgements: [{ pairKey: [a, b].sort().join('::'), verdict: 'distinct', reason: 'Independent fixes' }] } };
}

async function parkForReview(id: string) {
  const parker = 'su-60edb7f2-8b60-4e26-8146-dd81a0033bba';
  const at = new Date().toISOString();
  const releaseContract = {
    owner: reviewLeader, trigger: 'work-item:done:EI-26925756106103124',
    condition: `Canonical ${id} admissionReview is reviewed and admissionHold is absent; fleet leader reopens the original GitNexus lane after verifying that condition.`,
    evidence: 'a live resolver or producer registration can still satisfy the condition', reachability: 'reachable',
  };
  const reason = 'Canonical admission review must finish before repair executes';
  const patch = {
    _claimHold: true, _ei: { source: 'su', created_by: 'su-respawn-5d5addf964d9c7aca0012b9866cf572d' },
    claim_hold_by: parker, claim_hold_reason: reason, claim_hold_at: at, claim_hold_release: releaseContract,
    externalBlockers: [{ ref: `admission-review:${id}`, kind: 'runtime', status: 'active',
      capability: 'live-dependency', capabilitySource: 'explicit',
      summary: reason, evidence: 'canonical pending review', nextVerb: 'work_items:get',
      createdAt: at, updatedAt: at, createdBy: parker }],
    admissionReview: { state: 'pending', retryAttempts: 0, lastRetryAt: null },
  };
  await db.sql`UPDATE harness_shared.work_items SET status = 'blocked', taken_by = NULL, admission = 'unreviewed',
    payload = payload || ${db.sql.typed(JSON.stringify(patch), 25)}::jsonb WHERE feature_id = ${id}`;
  await db.sql`INSERT INTO harness_shared.audit_log (id, ts, workspace_id, actor, action, subject, details)
    VALUES (${id + '-park'}, ${Date.parse(at)}, ${scope.workspaceId}, ${parker}, 'work_items:claim_hold:set', ${id},
      ${db.sql.typed(JSON.stringify({ mode: 'claim_hold', by: parker, reason, releaseContract }), 25)}::jsonb)`;
  await placeReview(id);
}

describe('authenticated admission-only review composition (EI-270226)', () => {
  it('reviews another executor custody with canonical fleet authority without claiming or waking', async () => {
    const original = await create('Held original review');
    await claimOriginal(original.id);
    await placeReview(original.id);
    const before = await row(original.id);
    const queued = await review(original.id, reviewLeader);
    expect(queued).toMatchObject({ queued: true, pickupConfirmed: false });
    expect((await db.sql`SELECT jsonb_typeof(payload->'_admissionReviewRequest') AS type
      FROM harness_shared.work_items WHERE feature_id = ${original.id}`)[0]!.type).toBe('object');
    expect((await row(original.id)).payload._admissionReviewRequest).toMatchObject({ requestId: queued.requestId });
    expect(await tick()).toMatchObject({ promoted: 1, merged: 0 });
    const after = await row(original.id);
    expect(after).toMatchObject({ taken_by: before.taken_by, status: before.status, admission: 'admitted',
      payload: { _admissionReviewReceipt: { requestId: queued.requestId, pickupConfirmed: false } } });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('reviews the audited original blocked park with distinct creator, parker and leader without releasing it', async () => {
    const original = await create('Original GitNexus admission-only park');
    await request(original.id);
    await parkForReview(original.id);
    const before = await row(original.id);
    await review(original.id, reviewLeader);
    expect(await tick()).toMatchObject({ promoted: 1, merged: 0 });
    const after = await row(original.id);
    expect(after).toMatchObject({ status: 'blocked', taken_by: null, admission: 'admitted' });
    for (const key of ['_claimHold', '_ei', 'claim_hold_by', 'claim_hold_reason', 'claim_hold_at',
      'claim_hold_release', 'externalBlockers', '_admissionRecovery']) {
      expect(after.payload[key]).toEqual(before.payload[key]);
    }
    expect(after.payload._admissionReviewReceipt).toMatchObject({ pickupConfirmed: false });
    expect(after.payload.admissionReview).toMatchObject({ state: 'reviewed', retryAttempts: 1 });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it.each(['human', 'policy', 'unknown', 'mixed', 'malformed', 'unaudited', 'wrong-audit', 'unknown-trigger', 'self-trigger', 'owner'] as const)(
    'refuses an audited park with %s protection without changing its bytes', async kind => {
      const original = await create();
      await parkForReview(original.id);
      const payload = (await row(original.id)).payload;
      if (kind === 'human') payload.externalBlockers[0].kind = 'human';
      if (kind === 'policy') payload.claim_hold_reason = 'policy-tier: D-020 requires owner approval';
      if (kind === 'unknown') delete payload.externalBlockers[0].capabilitySource;
      if (kind === 'mixed') payload.externalBlockers.push({ ...payload.externalBlockers[0], ref: 'other-runtime-dependency' });
      if (kind === 'malformed') delete payload.externalBlockers[0].updatedAt;
      if (kind === 'unknown-trigger') payload.claim_hold_release.trigger = `work-item:claimable:${original.id}`;
      if (kind === 'self-trigger') payload.claim_hold_release.trigger = `work-item:done:${original.id}`;
      if (kind === 'owner') payload.claim_hold_release.owner = 'su-22222222-2222-4222-8222-222222222222';
      await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.typed(JSON.stringify(payload), 25)}::jsonb
        WHERE feature_id = ${original.id}`;
      // Keep audit equality for semantic contract refusals; don't let another
      // mismatched field accidentally satisfy the negative test.
      if (['policy', 'unknown-trigger', 'self-trigger', 'owner'].includes(kind)) {
        await db.sql`UPDATE harness_shared.audit_log SET details = ${db.sql.typed(JSON.stringify({
          mode: 'claim_hold', by: payload.claim_hold_by, reason: payload.claim_hold_reason,
          releaseContract: payload.claim_hold_release,
        }), 25)}::jsonb WHERE subject = ${original.id}`;
      }
      if (kind === 'unaudited') await db.sql`DELETE FROM harness_shared.audit_log WHERE subject = ${original.id}`;
      if (kind === 'wrong-audit') await db.sql`UPDATE harness_shared.audit_log SET actor = 'human' WHERE subject = ${original.id}`;
      const before = await row(original.id);
      await expect(review(original.id, reviewLeader)).rejects.toThrow();
      expect(await row(original.id)).toEqual(before);
      expect(h.model).not.toHaveBeenCalled();
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.wake).not.toHaveBeenCalled();
    },
  );

  it('isolates a malformed blocked review request while delivering unrelated recovery and recording its refusal', async () => {
    const original = await create('Protected blocked review request');
    await parkForReview(original.id);
    await review(original.id, reviewLeader);
    await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload,
      '{_admissionReviewRequest}', ${db.sql.typed(JSON.stringify('malformed'), 25)}::jsonb)
      WHERE feature_id = ${original.id}`;
    const before = await row(original.id);
    const [protectedBytes] = await db.sql`SELECT (payload->'_admissionReviewRequest')::text AS request,
        (payload->'externalBlockers')::text AS blocker
      FROM harness_shared.work_items WHERE feature_id = ${original.id}`;
    const unrelated = await create('Unrelated queued recovery');
    await request(unrelated.id);

    const result = await tick();
    const refusal = expect.objectContaining({ itemId: original.id, canonicalId: null,
      reason: 'review-gated', detail: expect.stringContaining('malformed admission review request') });
    expect(result.guardRefusals).toContainEqual(refusal);
    expect(await row(original.id)).toEqual(before);
    const [protectedAfter] = await db.sql`SELECT (payload->'_admissionReviewRequest')::text AS request,
        (payload->'externalBlockers')::text AS blocker
      FROM harness_shared.work_items WHERE feature_id = ${original.id}`;
    expect(protectedAfter).toEqual(protectedBytes);
    expect(await row(unrelated.id)).toMatchObject({ admission: 'admitted', taken_by: reviewerOwnerId });
    const [ledger] = await db.sql`SELECT detail FROM harness_shared.admission_runs
      WHERE id = ${`${result.runId}:recovery:${unrelated.id}`}`;
    expect(ledger!.detail.status).toBe('complete');
    expect(ledger!.detail.guardRefusals).toContainEqual(refusal);
    expect(h.model).not.toHaveBeenCalled();
  });

  it('enforces the actual review write policy independently of dispatch and claim permissions', async () => {
    const original = await create();
    await claimOriginal(original.id);
    h.kernelDenied = true;
    const before = await row(original.id);
    await expect(review(original.id)).rejects.toThrow('revoked');
    expect(await row(original.id)).toEqual(before);
    h.kernelDenied = false;
    await review(original.id);
    h.kernelDenied = true;
    const refusalResult = await tick();
    expect(refusalResult.guardRefusals).toContainEqual(expect.objectContaining({
      itemId: original.id, canonicalId: null, reason: 'review-gated', detail: expect.stringContaining('revoked'),
    }));
    expect((await row(original.id)).admission).toBe('pending');
    h.kernelDenied = false;
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('processes a queued exact recovery after a successful review result', async () => {
    const reviewed = await create('Review result before exact recovery');
    const twin = await create(reviewed.title);
    await claimOriginal(reviewed.id);
    const reviewRequest = await review(reviewed.id);

    const recoveryTarget = await create('Queued exact recovery after review');
    const recoveryRequest = await request(recoveryTarget.id);
    h.model.mockResolvedValueOnce(distinctPair(reviewed.id, twin.id));

    const promoterRunId = `chain-review-recovery-${++run}`;
    const result = await runAdmissionPromoterWithRecovery({
      ...scope, runId: promoterRunId, batchSize: 10, recentTerminalDays: 30, model: undefined,
    }, { sql: db.sql, lockSql: db.sql, llmCall: h.model,
      authorize: authorizeAdmissionRecovery, dispatch });

    expect(result.promoted).toBe(1);
    expect(h.model).toHaveBeenCalledTimes(1);
    expect((await row(reviewed.id)).payload._admissionReviewReceipt).toMatchObject({
      requestId: reviewRequest.requestId, purpose: 'admission-review',
    });
    expect(await row(recoveryTarget.id)).toMatchObject({ admission: 'admitted', taken_by: reviewerOwnerId });
    expect((await row(recoveryTarget.id)).payload._admissionRecovery).toMatchObject({
      requestId: recoveryRequest.request.requestId, state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
    });

    const [reviewRun] = await db.sql`SELECT detail FROM harness_shared.admission_runs
      WHERE id = ${`${promoterRunId}:review:${reviewRequest.requestId}`}`;
    const [recoveryRun] = await db.sql`SELECT detail FROM harness_shared.admission_runs
      WHERE id = ${`${promoterRunId}:recovery:${recoveryTarget.id}`}`;
    expect(reviewRun!.detail).toMatchObject({ mode: 'promoter', status: 'complete' });
    expect(recoveryRun!.detail).toMatchObject({ mode: 'promoter', status: 'complete' });
  });

  it('keeps unavailable review authority fatal so unrelated recovery is not dispatched', async () => {
    const original = await create('Unavailable review authority');
    await claimOriginal(original.id);
    await review(original.id);
    const unrelated = await create('Recovery behind unavailable authority');
    await request(unrelated.id);
    h.kernelUnavailable = true;

    await expect(tick()).rejects.toThrow('session authority reader unavailable');
    expect((await row(unrelated.id)).payload._admissionRecovery).toMatchObject({ state: 'queued' });
    expect((await row(original.id)).payload).not.toHaveProperty('_admissionReviewReceipt');
    expect(h.model).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it.each(['custody', 'request', 'policy', 'denied'] as const)(
    'refuses %s drift during model latency before persistence', async drift => {
      const original = await create('Latency review subject');
      const twin = await create(original.title);
      await claimOriginal(original.id);
      await review(original.id);
      h.model.mockImplementationOnce(async () => {
        if (drift === 'custody') await db.sql`UPDATE harness_shared.work_items
          SET taken_by = 'other-executor' WHERE feature_id = ${original.id}`;
        if (drift === 'request') await db.sql`UPDATE harness_shared.work_items
          SET payload = jsonb_set(payload, '{_admissionReviewRequest,requestId}',
            '"99999999-9999-4999-8999-999999999999"'::jsonb) WHERE feature_id = ${original.id}`;
        if (drift === 'policy') h.policyRevision = 'changed';
        if (drift === 'denied') h.kernelDenied = true;
        return distinctPair(original.id, twin.id);
      });
      await expect(tick()).rejects.toThrow();
      expect(await row(original.id)).toMatchObject({ admission: 'pending' });
      expect((await row(original.id)).payload).not.toHaveProperty('_admissionReviewReceipt');
      expect((await row(twin.id)).admission).toBe('pending');
      expect(h.model).toHaveBeenCalledTimes(1);
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.wake).not.toHaveBeenCalled();
    },
  );

  it.each(['foreign', 'expired', 'revoked', 'tampered'] as const)(
    'refuses %s review authority without admission or custody writes', async invalid => {
      const original = await create();
      await claimOriginal(original.id);
      const authority = reviewAuthority();
      if (invalid === 'foreign') authority.context = { ...originalContext, workspaceId: 'other' };
      if (invalid === 'expired') authority.expiresAtSec = 1;
      if (invalid === 'revoked') authority.credentialSha256 = '0'.repeat(64);
      if (invalid !== 'tampered') {
        await expect(requestAdmissionReview({ ...scope, workItemId: original.id },
          { caller: reviewerOwnerId, authority }, db.sql)).rejects.toThrow();
      } else {
        await review(original.id);
        await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload,
          '{_admissionReviewRequest,signature}', ${db.sql.typed(JSON.stringify('0'.repeat(64)), 25)}::jsonb)
          WHERE feature_id = ${original.id}`;
        const result = await tick();
        expect(result.guardRefusals).toContainEqual(expect.objectContaining({
          itemId: original.id, canonicalId: null, reason: 'review-gated', detail: expect.stringContaining('signature'),
        }));
      }
      expect(await row(original.id)).toMatchObject({ admission: 'pending', taken_by: reviewerOwnerId, status: 'wip' });
      expect(h.model).not.toHaveBeenCalled();
    },
  );

  it('holds a duplicate subject without mutating its outside-scope twin or merge links', async () => {
    const original = await create('Review duplicate original');
    const twin = await create(original.title);
    await claimOriginal(original.id);
    const twinBefore = await row(twin.id);
    await review(original.id);
    const [a, b] = [original.id, twin.id].sort();
    h.model.mockResolvedValue({ text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
      json: { judgements: [{ pairKey: `${a}::${b}`, verdict: 'r-finding-merge',
        reason: 'Same fix' }] } });
    expect(await tick()).toMatchObject({ promoted: 0, merged: 0, held: 1 });
    expect(await row(twin.id)).toEqual(twinBefore);
    expect(await db.sql`SELECT * FROM harness_shared.dedup_edges`).toEqual([]);
    expect(await db.sql`SELECT * FROM harness_shared.dedup_adjudications`).toEqual([]);
    expect((await row(original.id)).taken_by).toBe(reviewerOwnerId);
  });

  it('refuses reference drift during judging without recording a successful review', async () => {
    const original = await create('Reference drift review');
    const twin = await create(original.title);
    await claimOriginal(original.id);
    await review(original.id);
    h.model.mockImplementationOnce(async () => {
      await db.sql`UPDATE harness_shared.work_items SET title = 'changed during judging', updated_ts = updated_ts + 1
        WHERE feature_id = ${twin.id}`;
      return distinctPair(original.id, twin.id);
    });
    expect(await tick()).toMatchObject({ promoted: 0, merged: 0, held: 1 });
    expect((await row(original.id)).admission).toBe('pending');
    expect((await row(original.id)).payload).not.toHaveProperty('_admissionReviewReceipt');
    expect((await row(twin.id)).admission).toBe('pending');
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('preserves immutable recovery and requires separate eligible handoff then target-owned pickup', async () => {
    const original = await create('Original recovery preserved through review');
    await request(original.id);
    await claimOriginal(original.id);
    const saved = (await row(original.id)).payload._admissionRecovery;
    await review(original.id);
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toEqual(saved);
    expect(h.wake).not.toHaveBeenCalled();
    // A distinct custody transition is required; review is never that transition.
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, status = 'open'
      WHERE feature_id = ${original.id}`;
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      requestId: saved.requestId, state: 'delivered', pickupConfirmed: false });
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(await pickup(original.id)).toMatchObject({ ok: true, claimed: true });
    expect(await row(original.id)).toMatchObject({ taken_by: reviewerOwnerId });
    expect(h.dispatches.mock.calls.map(([name]) => name)).toEqual([
      'work_items:pickup', 'work_items:get', 'work_items:claim',
    ]);
    // Delivery's immutable receipt does not mutate into a pickup attestation.
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({ pickupConfirmed: false });
  });
});
/** A separate target-owned call. Context represents the authenticated transport
 * boundary, NOT presence.agentRole and NOT the original requester's privilege.
 * Capabilities are loaded from fresh PG by the real transport principal resolver.
 * The outer pickup AND nested get/claim traverse the unmodified dispatch stack.
 */
async function pickup(id: string, role: UnifiedToolContext['role'] = 'reviewer') {
  const principal = await synthesizeDispatchPrincipal(db.sql, {
    workspaceId: scope.workspaceId, role: role!, sigVerifiedSpawn: true,
  });
  const ctx: UnifiedToolContext = {
    role, principal, workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
    uiClientId: reviewerOwnerId, sigVerifiedSpawn: true, spawnId: 'reviewer-turn', tx: db.sql,
    log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
  };
  expect(resolveAgentIdentity(ctx).ownerId).toBe(reviewerOwnerId);
  return inProcessCall(ctx)('work_items:pickup', { id, harness: scope.harnessSlug, detail: false });
}

describe('canonical original-item recovery chain (fresh PG; controlled external I/O)', () => {
  it('requires authenticated binding instead of synthesizing a role from presence', async () => {
    const original = await create();
    await expect(requestAdmissionRecovery({
      ...scope, workItemId: original.id, caller: 'requester', target: reviewerOwnerId,
    })).rejects.toThrow('authenticated recovery binding missing');
    expect((await row(original.id)).payload).not.toHaveProperty('_admissionRecovery');
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('rechecks restrictive reviewer scope before screening and never treats signed provenance as a grant', async () => {
    const original = await create();
    await request(original.id);
    h.denied = true;
    await tick();
    expect((await row(original.id))).toMatchObject({
      admission: 'pending', taken_by: null,
      payload: { _admissionRecovery: { version: 3, state: 'held', stage: 'authorize',
        reason: expect.stringContaining('restrictive reviewer override') } },
    });
    expect(h.model).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('runs current kernel and inner-claim gates before the background screen', async () => {
    const original = await create();
    await request(original.id);
    h.kernelDenied = true;
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      stage: 'authorize', state: 'held', reason: expect.stringContaining('revoked'),
    });
    h.kernelDenied = false;
    await request(original.id);
    h.denyPickupClaim = true;
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      stage: 'authorize', state: 'held', reason: expect.stringContaining('claim confinement'),
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('retries the original queued request after a temporary kernel authority-reader failure', async () => {
    const original = await create();
    const first = await request(original.id);
    const before = await row(original.id);
    h.kernelUnavailable = true;
    await expect(tick()).rejects.toThrow('session authority reader unavailable');
    expect(await row(original.id)).toEqual(before);
    expect(h.model).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();

    h.kernelUnavailable = false;
    const result = await tick();
    expect(result).toMatchObject({ promoted: 1, writerCoverageGap: [] });
    expect(await row(original.id)).toMatchObject({
      admission: 'admitted', taken_by: reviewerOwnerId,
      payload: { _admissionRecovery: {
        requestId: first.request.requestId, state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
      } },
    });
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledTimes(1);
  });

  it('holds an expired proof and a payload-spoofed role without a handler invocation', async () => {
    const original = await create();
    await expect(requestAdmissionRecovery({
      ...scope, workItemId: original.id, caller: 'requester', target: reviewerOwnerId,
      authority: { kind: 'signed-spawn', role: 'reviewer', expiresAtSec: 1, context: originalContext,
        credentialSha256: admissionCredentialDigest(Buffer.alloc(32, 42)) },
    })).rejects.toThrow('expired');
    await request(original.id);
    await db.sql`UPDATE harness_shared.work_items SET payload =
      jsonb_set(payload, '{_admissionRecovery,authority,role}', '"operator"')
      WHERE feature_id = ${original.id}`;
    await tick();
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      stage: 'authorize', state: 'held', reason: expect.stringContaining('provenance is invalid'),
    });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('revalidates the original SU credential, not a saved bypass or a guessed provisioned role', async () => {
    const original = await create();
    await db.sql`TRUNCATE harness_shared.system_principals`;
    await requestAdmissionRecovery({
      ...scope, workItemId: original.id, caller: 'requester', target: reviewerOwnerId,
      authority: { kind: 'superuser', role: 'operator', context: originalContext,
        credentialSha256: admissionCredentialDigest(h.suToken) },
    });
    h.suToken = 'test-only-rotated-bearer-not-a-real-credential';
    await tick();
    expect((await row(original.id))).toMatchObject({
      admission: 'pending', taken_by: null,
      payload: { _admissionRecovery: { state: 'held', stage: 'authorize',
        reason: expect.stringContaining('superuser credential was revoked or rotated') } },
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('repairs the same pending task, narrows promotion, then requires a separate target pickup', async () => {
    const original = await create();
    const unrelated = await create('Unrelated pending work');
    expect((await row(original.id)).taken_by).toBeNull();
    expect(await wi.claimWorkItem(original.id, reviewerOwnerId, { harness: scope.harnessSlug })).toBeNull();
    h.denied = true;
    await expect(request(original.id)).rejects.toThrow('restrictive reviewer override');
    expect((await row(original.id)).payload).not.toHaveProperty('_admissionRecovery');
    h.denied = false; // external authorized policy repair, not a recovery bypass
    const queued = await request(original.id);
    expect((await row(original.id)).admission).toBe('pending');
    const result = await tick();
    expect(result).toMatchObject({ promoted: 1, writerCoverageGap: [] });
    expect(h.claim).toHaveBeenCalledWith(original.id, reviewerOwnerId, { harness: 'papercusp' });
    expect(h.wake).toHaveBeenCalledWith([reviewerOwnerId], expect.objectContaining({
      payload: { kind: 'actionable-work-item-dispatch', workItemIds: [original.id],
        instructions: 'Report findings; do not implement.' },
    }));
    expect(await row(original.id)).toMatchObject({
      title: original.title, admission: 'admitted', taken_by: reviewerOwnerId,
      payload: { keep: 'original instructions', _admissionRecovery: {
        requestId: queued.request.requestId, state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
      } },
    });
    expect(await row(unrelated.id)).toMatchObject({ admission: 'pending', taken_by: null });
    const picked = await pickup(original.id);
    expect(picked, JSON.stringify(picked)).toMatchObject({ ok: true, claimed: true, item: { id: original.id, assignee: reviewerOwnerId } });
    expect(h.dispatches.mock.calls.map(([name]) => name)).toEqual([
      'work_items:pickup', 'work_items:get', 'work_items:claim',
    ]);
    // The delivery record does not retroactively become proof of execution.
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items`).toHaveLength(2);
  });

  it('keeps ordinary admission progressing while a delivered recovery awaits pickup', async () => {
    const original = await create();
    const unrelated = await create('Unrelated pending work');
    await request(original.id);
    await tick();
    expect(await row(unrelated.id)).toMatchObject({ admission: 'pending', taken_by: null });
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
    });

    const ordinary = await tick();
    expect(ordinary).toMatchObject({ batchSize: 1, promoted: 1 });
    expect(await row(unrelated.id)).toMatchObject({ admission: 'admitted', taken_by: null });
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
    });
    // Observing delivery never repeats assignment/wake or asserts target pickup.
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.model).not.toHaveBeenCalled();
    const [runRow] = await db.sql`SELECT detail FROM harness_shared.admission_runs
      WHERE id = ${ordinary.runId}`;
    expect(runRow!.detail).toMatchObject({ mode: 'promoter', status: 'complete' });
    expect(runRow!.detail).not.toHaveProperty('targetItemIds');
  });

  it.each(['running', 'complete'] as const)(
    'settles only an interrupted ordinary ledger on a recovery-only replay (%s)',
    async (priorStatus) => {
      const original = await create();
      await request(original.id);
      const runId = `chain-${++run}`;
      const producingRuntime = { pid: 12345, buildIdentity: 'original-process-build' };
      await db.sql`INSERT INTO harness_shared.admission_runs
        (id, workspace_id, harness_slug, run_kind, started_at, finished_at, detail)
        VALUES (${runId}, ${scope.workspaceId}, ${scope.harnessSlug}, 'promoter-tick',
          now() - interval '1 minute', ${priorStatus === 'complete' ? new Date(0) : null},
          ${JSON.stringify({ status: priorStatus, mode: 'promoter', producingRuntime,
            outcome: { unit: 'items', attempted: null, successful: null, failureReason: null } })}::text::jsonb)`;
      const [before] = await db.sql`SELECT finished_at, detail FROM harness_shared.admission_runs WHERE id = ${runId}`;
      expect(before!.detail).toMatchObject({ status: priorStatus, mode: 'promoter', producingRuntime });

      const result = await runAdmissionPromoterWithRecovery({
        ...scope, runId, batchSize: 10, recentTerminalDays: 30, model: undefined,
      }, { sql: db.sql, lockSql: db.sql, llmCall: h.model, authorize: authorizeAdmissionRecovery, dispatch });
      expect(result.promoted).toBe(1);
      const [child] = await db.sql`SELECT detail FROM harness_shared.admission_runs
        WHERE id = ${`${runId}:recovery:${original.id}`}`;
      expect(child!.detail.status).toBe('complete');
      const [parent] = await db.sql`SELECT finished_at, detail FROM harness_shared.admission_runs WHERE id = ${runId}`;
      if (priorStatus === 'running') {
        expect(parent!.finished_at).not.toBeNull();
        expect(parent!.detail).toMatchObject({
          status: 'failed', mode: 'promoter', producingRuntime,
          outcome: { successful: null, failureReason: 'replaced-by-recovery' },
          recoveryRunIds: [`${runId}:recovery:${original.id}`],
        });
      } else {
        expect(parent).toEqual(before);
      }
    },
  );

  it('a delivered request cannot lend authority to a target whose current role is denied', async () => {
    const original = await create();
    await request(original.id);
    await tick();
    await expect(pickup(original.id, 'judge')).rejects.toThrow('role_not_allowed');
    expect(h.dispatches.mock.calls.map(([name]) => name)).toEqual(['work_items:pickup']);
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
  });

  it('rechecks revoked target authority instead of inheriting the dispatcher or saved request grants', async () => {
    const original = await create();
    await request(original.id);
    await tick();
    h.revoked = true;
    await expect(pickup(original.id)).rejects.toThrow('revoked');
    expect(h.dispatches.mock.calls.map(([name]) => name)).toEqual(['work_items:pickup']);
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
    h.revoked = false;
    // Reviewer has a declared blueprint baseline: a narrower provisioned row
    // cannot revoke its built-in work-item capabilities; the live gate above can.
    await db.sql`UPDATE harness_shared.system_principals SET capabilities = '["work_items:read","work_items:write"]'`;
    await expect(pickup(original.id)).resolves.toMatchObject({ ok: true, claimed: true });
  });

  it('runs the current inner claim gate even when outer pickup and get were allowed', async () => {
    const original = await create();
    await request(original.id);
    await tick();
    h.denyPickupClaim = true;
    await expect(pickup(original.id)).rejects.toThrow('current target claim confinement');
    expect(h.dispatches.mock.calls.map(([name]) => name)).toEqual([
      'work_items:pickup', 'work_items:get', 'work_items:claim',
    ]);
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
    h.denyPickupClaim = false;
    await expect(pickup(original.id)).resolves.toMatchObject({ ok: true, claimed: true });
  });

  it('survives a crash after canonical claim without a replacement or a second screen', async () => {
    const original = await create();
    const queued = await request(original.id);
    h.wake.mockRejectedValueOnce(new Error('transport crash after committed claim'));
    await expect(tick()).rejects.toThrow('transport crash after committed claim');
    expect(await row(original.id)).toMatchObject({
      admission: 'admitted', taken_by: reviewerOwnerId,
      payload: { _admissionRecovery: { state: 'queued', requestId: queued.request.requestId } },
    });
    await tick();
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs`).toHaveLength(1);
    expect(await pickup(original.id)).toMatchObject({ ok: true, claimed: true });
    expect(await db.sql`SELECT feature_id FROM harness_shared.work_items`).toHaveLength(1);
  });

  it('concurrent consumers preserve one claim and one screening run', async () => {
    const original = await create();
    const first = await request(original.id);
    expect((await request(original.id)).request.requestId).toBe(first.request.requestId);
    await Promise.all([tick(), tick(), tick()]);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs`).toHaveLength(1);
    expect((await row(original.id)).payload._admissionRecovery.state).toBe('delivered');
  });

  it('revocation after enqueue holds the original without admission, assignment or wake', async () => {
    const original = await create();
    await request(original.id);
    h.revoked = true;
    await tick();
    expect(await row(original.id)).toMatchObject({
      admission: 'pending', taken_by: null,
      payload: { _admissionRecovery: { state: 'held', pickupConfirmed: false } },
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(await db.sql`SELECT id FROM harness_shared.admission_runs`).toHaveLength(0);
  });

  it('a queued delivery never authorizes a later target pickup after revocation', async () => {
    const original = await create();
    await request(original.id);
    await tick();
    h.revoked = true;
    await expect(pickup(original.id)).rejects.toThrow('revoked');
    expect((await row(original.id)).payload._admissionRecovery.pickupConfirmed).toBe(false);
  });

  it('reports a staged wake after the real claim and reuses that claim on a same-request retry', async () => {
    const original = await create();
    const first = await request(original.id);
    h.wake.mockResolvedValueOnce({ queued: 0, woken: 1, staged: 1, timedOutTargets: [] });
    await tick();
    expect(await row(original.id)).toMatchObject({
      admission: 'admitted', taken_by: reviewerOwnerId, payload: { _admissionRecovery: {
        requestId: first.request.requestId, state: 'held', stage: 'wake', pickupConfirmed: false,
        reason: expect.stringContaining('not required-wakeable'),
      } },
    });
    expect((await request(original.id)).request.requestId).toBe(first.request.requestId);
    await tick();
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect((await row(original.id)).payload._admissionRecovery).toMatchObject({
      state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
    });
  });

  it.each(['distinct', 'hold', 'revoke'] as const)(
    'runs the real model-backed screening path with a %s outcome before any claim',
    async (outcome) => {
      const original = await create();
      // Pair selection reads title/condition/embedding, not the census edge.
      const twin = await create(original.title);
      const [a, b] = [original.id, twin.id].sort();
      await db.sql`INSERT INTO harness_shared.dedup_edges
        (workspace_id,harness_slug,a,b,cos,run_id)
        VALUES ('default','papercusp',${a},${b},0.98,'prior-census')`;
      h.model.mockImplementation(async () => {
        // The actual model boundary must precede admission and assignment.
        expect(await row(original.id)).toMatchObject({ admission: 'pending', taken_by: null });
        expect(h.claim).not.toHaveBeenCalled();
        if (outcome === 'revoke') h.revoked = true;
        return {
          text: '', inputTokens: 17, outputTokens: 9, costUsd: 0,
          json: { judgements: [{ pairKey: `${a}::${b}`,
            verdict: outcome === 'hold' ? 'hold' : 'distinct', reason: 'Controlled screening response' }] },
        };
      });
      await request(original.id);
      const result = await tick();
      expect(h.model).toHaveBeenCalledTimes(1);
      expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
      const [ledger] = await db.sql`SELECT promoted, detail FROM harness_shared.admission_runs`;
      // Even a "distinct" judgement cannot authorize its outside-target endpoint
      // writes. Preserve the canonical component fence instead of widening repair.
      if (outcome === 'distinct') expect(result.guardRefusals).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: original.id, reason: 'outside-mutation-scope' }),
      ]));
      expect(ledger!.detail.status).toBe(outcome === 'revoke' ? 'failed' : 'complete');
      expect(await row(original.id)).toMatchObject({
        admission: 'pending', taken_by: null,
        payload: { _admissionRecovery: { state: 'held', stage: 'screen', pickupConfirmed: false } },
      });
      if (outcome === 'distinct') {
        const refusal = result.guardRefusals!.find(({ itemId }) => itemId === original.id)!;
        const recovery = (await row(original.id)).payload._admissionRecovery;
        expect(recovery.reason).toContain('outside-mutation-scope');
        expect(recovery.reason).toContain(refusal.detail);
        expect(recovery.reason).toContain(`${result.runId}:recovery:${original.id}`);
        expect(recovery.reason).toContain('ordinary component screening/review');
        expect(recovery.reason).not.toContain('no hold reason');
        expect((await row(original.id)).payload).not.toHaveProperty('admissionHold');
        expect((await row(twin.id)).payload).not.toHaveProperty('_admissionRecovery');
      } else if (outcome === 'hold') {
        const recovery = (await row(original.id)).payload._admissionRecovery;
        expect(recovery.reason).toContain('Controlled screening response');
        expect(recovery.reason).toContain('admission hold');
        expect(recovery.reason).not.toContain('outside-mutation-scope');
      }
      expect(h.claim).not.toHaveBeenCalled();
      expect(h.wake).not.toHaveBeenCalled();
    },
  );
});

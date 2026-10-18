/**
 * P-003: exercise the production recovery composition, not a fake screen/dispatch.
 * Fresh PG owns every work-item/admission write. Only external model/transport and
 * ambient session-policy I/O are controlled; canonical create/read/claim, screening,
 * authorization composition, assignment and target-initiated pickup remain real.
 * A transport receipt is explicitly NOT proof of a running agent or a live deploy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
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
  kernelDenied: false, suToken: 'test-only-original-bearer-not-a-real-credential',
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
vi.mock('./harness/routines/system-actions', () => ({ registerSystemAction: vi.fn() }));
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
    kernelEnforcement: async () => h.revoked || h.kernelDenied
      ? { decision: 'deny', code: 'revoked', reason: 'target authority revoked' }
      : { decision: 'allow' },
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
const { inProcessCall } = await import('./agent-tools/_compound-dispatch');
const { synthesizeDispatchPrincipal } = await import('./endpoint-route/routes/transport/role-principal-caps');
const { resolveAgentIdentity } = await import('./agent-tools/coordination/identity');
const { admissionCredentialDigest, admissionReplayContext } = await import('./work-item-admission-authority');
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

let db: FreshPgDb;
let run = 0;
const scope = { workspaceId: 'default', harnessSlug: 'papercusp' };
beforeAll(async () => {
  db = await createFreshPgDb('admission-recovery-chain');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(COORD_REF_HOLDERS_DDL);
  await applyMigrationForTest(db.sql, resolve(import.meta.dirname,
    '../../../libs/papercusp/libs/db/sql/944-work-queue-admission-dedup.sql'));
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
    CREATE TABLE harness_shared.system_principals (
      workspace_id text, name text, capabilities jsonb, PRIMARY KEY (workspace_id, name)
    );
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, workspace_id text, install_slug text, name text, target_role text,
      active boolean DEFAULT true, trigger_config jsonb, next_fire_at timestamptz
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
  h.suToken = 'test-only-original-bearer-not-a-real-credential';
  h.dispatches.mockReset();
  h.model.mockReset().mockRejectedValue(new Error('unexpected external model call'));
  h.wake.mockReset().mockResolvedValue({ queued: 1, woken: 0, staged: 0, timedOutTargets: [] });
  h.claim.mockReset().mockImplementation(wi.claimWorkItem);
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.dedup_edges,
    harness_shared.dedup_adjudications, harness_shared.admission_runs, harness_shared.routines,
    harness_shared.system_principals`;
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
    const held = (await row(original.id)).payload._admissionRecovery;
    expect(held).toMatchObject({ requestId: first.request.requestId, state: 'held', stage: 'screen' });
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: null });
    // This is a separate ordinary tick, with no targetItemIds or request replay.
    await tick();
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
  });

  it('keeps a prioritized component pending when a peer claims its twin before ordinary screening', async () => {
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
    expect(h.model).toHaveBeenCalledTimes(1);
    expect(await row(original.id)).toMatchObject({ admission: 'pending', taken_by: null });
    expect(await row(twin.id)).toMatchObject({ admission: 'pending', taken_by: 'live-peer' });
    expect((await row(original.id)).payload._admissionRecovery).toEqual(held);
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

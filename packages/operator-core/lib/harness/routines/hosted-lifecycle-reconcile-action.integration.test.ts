/** Real DBOS step/workflow boundary and child dedup; cloud and demand are isolated seams.
 * The sibling pool admission suite exercises the demand transaction as harness_app.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as any,
  sampleReads: 0,
  childExecutions: 0,
  demand: vi.fn(),
  recovery: vi.fn(async () => ({ recoveryPending: [], orphaned: [], exhausted: [], notifications: [],
    spend: { due: 0, attempted: 0, observed: 0, settled: 0, retryable: 0, skipped: 0, errors: [] } })),
}));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: any) => Promise<T>) =>
    h.sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('../../workspace-host/hosted-lifecycle-store', () => ({
  reconcileHostedLifecycleJobs: h.recovery,
  reconcileHostedPoolDemand: h.demand,
}));

let db: OrgTestDb;
let DBOS: typeof DBOSType;
let parent: (key: string) => Promise<void>;
let illegalStep: (key: string) => Promise<void>;
let child: () => Promise<void>;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.appSql;
  for (const migration of ['1522-workspace-host-pool-admission', '1523-workspace-host-resource-incarnation',
    '1524-hosted-entitlement-authority']) {
    const path = fileURLToPath(new URL(`../../../../../libs/papercusp/libs/db/sql/${migration}.sql`, import.meta.url));
    await db.adminSql.unsafe(readFileSync(existsSync(path) ? path : `${path}.DRAFT`, 'utf8'));
  }
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({ name: 'hosted-capacity-routine-test', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'p544-runtime-test-v1', runAdminServer: false });
  const { makeHostedLifecycleReconcileAction } = await import('./hosted-lifecycle-reconcile-action');
  child = DBOS.registerWorkflow(async () => {
    await DBOS.runStep(async () => { h.childExecutions++; }, { name: 'capacity-provider-seam' });
  }, { name: 'p544-capacity-child-test' });
  h.demand.mockImplementation(async (workspaceId: string, deps: {
    sampleDemand: <T>(read: () => Promise<T>) => Promise<T>;
  }) => {
    const operationId = await deps.sampleDemand(async () => { h.sampleReads++; return `capacity:${workspaceId}`; });
    const handle = await DBOS.startWorkflow(child, { workflowID: operationId })();
    await handle.getResult();
    return { considered: 1, enqueued: [operationId], held: [] };
  });
  const action = makeHostedLifecycleReconcileAction({ log: () => {} });
  const ctx = (key: string) => ({ workspaceId: key, installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null });
  parent = DBOS.registerWorkflow(async (key: string) => { await action(ctx(key)); },
    { name: 'p544-capacity-parent-test' });
  // The previous single-step routine registration ran the action in this context.
  illegalStep = DBOS.registerWorkflow(async (key: string) => {
    await DBOS.runStep(() => action(ctx(key)), { name: 'old-capacity-single-step' });
  }, { name: 'p544-capacity-illegal-step-test' });
  await DBOS.launch();
}, 120_000);

afterAll(async () => {
  try { await DBOS?.shutdown(); }
  finally { await db?.cleanup(); }
});

it('starts one durable child with checkpointed recovery/demand and dedups a replayed routine fire', async () => {
  const before = { samples: h.sampleReads, children: h.childExecutions, recovery: h.recovery.mock.calls.length };
  const run = await DBOS.startWorkflow(parent, { workflowID: 'p544-capacity-fire' })('p544-capacity-workspace');
  await run.getResult();
  const replay = await DBOS.startWorkflow(parent, { workflowID: 'p544-capacity-fire' })('p544-capacity-workspace');
  await replay.getResult();
  expect(h.sampleReads - before.samples).toBe(1);
  expect(h.childExecutions - before.children).toBe(1);
  expect(h.recovery.mock.calls.length - before.recovery).toBe(1);
  const [child] = await db.adminSql`SELECT status, application_version FROM dbos.workflow_status
    WHERE workflow_uuid = 'capacity:p544-capacity-workspace'`;
  expect(child).toMatchObject({ status: 'SUCCESS', application_version: 'p544-runtime-test-v1' });
}, 30_000);

it('negative control: the former single-step context refuses a child workflow before provider execution', async () => {
  const before = h.childExecutions;
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const run = await DBOS.startWorkflow(illegalStep, { workflowID: 'p544-capacity-negative-fire' })('p544-negative-workspace');
    await expect(run.getResult()).rejects.toThrow(/step|workflow/i);
    expect(h.childExecutions).toBe(before);
    const children = await db.adminSql`SELECT workflow_uuid FROM dbos.workflow_status
      WHERE workflow_uuid = 'capacity:p544-negative-workspace'`;
    expect(children).toHaveLength(0);
    expect(errorLog.mock.calls.some(args => args.some(value =>
      String(value).includes('Invalid call to a `workflow` function')))).toBe(true);
  } finally { errorLog.mockRestore(); }
}, 30_000);

it('reconciles real durable demand as harness_app and enqueues one DBOS child across distinct routine fires', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-host/hosted-lifecycle-store')>(
    '../../workspace-host/hosted-lifecycle-store');
  const { writeHostedEntitlementAuthority } = await import('../../auth/hosted-entitlement-store');
  const workspaceId = `runtime-${randomUUID()}`, organizationId = randomUUID(), userId = randomUUID();
  const digest = randomUUID().replaceAll('-', '').slice(0, 24), hostId = `host-${digest}`, customerId = `ws-${digest}`;
  await db.adminSql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
    VALUES (${organizationId}::uuid, ${userId}::uuid, 'hosted-free', 'self_signup')`;
  const record = { source: 'migration', actor: { kind: 'service', principalId: 'service:runtime-fixture' },
    auditReceiptId: 'runtime:allowance', effectiveFrom: '2026-01-01', effectiveUntil: null };
  await writeHostedEntitlementAuthority({ organizationId, userId, kind: 'hosted-free', expectedRevision: 0,
    authority: { schemaVersion: 1, bundles: [{ schemaVersion: 1, bundleId: 'runtime-pool', bundleVersion: 1, record,
      entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 }, browserAccess: { pty: true, files: true },
        supportTier: 'trial', rolloutFlags: {}, quotas: { 'pool.hosts': 1, 'pool.agents': 50,
          'pool.cpu-millicores': 4000, 'pool.memory-mib': 8192, 'pool.db-gib': 8, 'pool.workspace-gib': 8 },
        budgets: { 'pool.cost.usd.minor': 10000 } } }], overrides: [],
      assignments: [{ schemaVersion: 1, assignmentId: `fixture:${organizationId}`, organizationId,
        bundleId: 'runtime-pool', bundleVersion: 1, record: { ...record, auditReceiptId: 'runtime:assignment' } }] } },
    run => db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return run(tx as any);
    }) as any);
  const scope = { kind: 'project', id: 'isolated-project' };
  await db.adminSql`INSERT INTO harness_shared.workspace_host_connections
    (workspace_id, id, target, label, credential_ref, status)
    VALUES (${workspaceId}, 'runtime-connection', 'gcp', 'no cloud calls', 'test://isolated', 'connected')`;
  await db.adminSql`INSERT INTO harness_shared.workspace_hosts
    (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network,
      desired_state, observed_state, desired_spec, host_generation, controller_fence, desired_revision, observed_revision)
    VALUES (${workspaceId}, ${hostId}, ${hostId}, 'runtime-connection', 'gcp', 'isolated-project', 'us-central1',
      'test-size', 'test-image', 16, 'default', 'running', 'provisioning',
      ${JSON.stringify({ scope, zone: 'us-central1-a', data: { volumeGiB: 16,
        allocation: { dbGiB: 8, workspaceGiB: 8 }, encrypted: true } })}::jsonb, 1, 0, 1, 1)`;
  await db.adminSql`INSERT INTO harness_shared.customer_workspaces
    (workspace_id, id, organization_id, workspace_host_id, display_name, state,
      created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id,
      tenant_concurrency_limit, provider_concurrency_limit, monthly_lifecycle_budget_cents)
    VALUES (${workspaceId}, ${customerId}, ${organizationId}, ${hostId}, 'Runtime fixture', 'provisioning',
      'user', ${userId}, 'organization', ${organizationId}, 1, 8, 10000)`;
  const before = h.childExecutions;
  h.demand.mockImplementation(async (key: string, deps: { sampleDemand: <T>(read: () => Promise<T>) => Promise<T> }) =>
    actual.reconcileHostedPoolDemand(key, { ...deps, readTarget: async () => ({
      id: hostId, hostGeneration: 1, desiredRevision: 1, connectionId: 'runtime-connection',
      hostedCustomerWorkspaceId: customerId, desired: { target: 'gcp' },
    }) as any, admitAndStart: async request => {
      const retained = { connectionId: request.connectionId, name: request.name, desired: request.desiredSpec };
      const receipt = await actual.readHostedLifecycleAdmission({ workspaceId: key, customerWorkspaceId: customerId,
        operationId: request.operationId, actorId: userId, request: retained }) ??
        await actual.admitHostedLifecycleJob({ workspaceId: key, customerWorkspaceId: customerId, hostId,
          providerTarget: 'gcp', action: 'provision', operationId: request.operationId, actorId: userId,
          riskTier: 'moderate', approvalStatus: 'not-required', request: retained, capacityReconcile: request.capacityReconcile,
          estimate: { cents: 100, currency: 'USD', source: 'fixture', evidenceRef: 'fixture:quote', estimatedAt: new Date().toISOString() },
          pool: { scope, region: 'us-central1', zone: 'us-central1-a', architecture: 'x86_64',
            runtimeBundleSha256: 'a'.repeat(64), minimum: { cpuCount: 2, memoryMiB: 4096 },
            maxObservationAgeMs: 75000, dataVolumeId: `unprovisioned:${customerId}` } });
      await (await DBOS.startWorkflow(child, { workflowID: receipt.operationId })()).getResult();
    } }));
  for (const fire of ['first', 'recovery']) {
    await (await DBOS.startWorkflow(parent, { workflowID: `real-demand:${fire}` })(workspaceId)).getResult();
  }
  const operations = await db.adminSql`SELECT id, admission_receipt FROM harness_shared.workspace_host_operations
    WHERE workspace_id = ${workspaceId}`;
  expect(operations).toHaveLength(1);
  expect(operations[0].admission_receipt.result.resourceAdmission.capacityDecision)
    .toMatchObject({ kind: 'provision', controllerFence: 0, market: 'on-demand' });
  expect(h.childExecutions - before).toBe(1);
  expect(await db.adminSql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${operations[0].id}`)
    .toEqual([expect.objectContaining({ status: 'SUCCESS' })]);
}, 60_000);

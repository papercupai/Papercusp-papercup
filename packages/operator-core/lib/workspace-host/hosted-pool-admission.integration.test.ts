/** P-534: the real admission transaction, concurrency, fencing and RLS in a throwaway PG. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { AdmitHostedLifecycleJobInput, HostedPoolObservation } from './hosted-lifecycle-store';
import { Governor } from '../resource-governor/admission';
import { PgAdmissionLedgerQueueStore } from '../resource-governor/admission-ledger-store';
import { WorkItemAdmissionQueueDriver } from '../resource-governor/queue';
import { allSessionsLiveResolver } from '../../test/_admission-ledger-fixture';
import { hostedPoolAgentAdmissionGuard, createHostedPoolAgentReservations, retireHostedPoolAgentReservations } from './hosted-agent-admission';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import { reconcileHostedPoolDemand, readHostedLifecycleAdmission } from './hosted-lifecycle-store';

const h = vi.hoisted(() => ({ sql: null as any }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: any) => Promise<T>) =>
    h.sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { writeHostedEntitlementAuthority } = await import('../auth/hosted-entitlement-store');
const { admitHostedLifecycleJob, HostedLifecyclePlacementError, recordHostedPoolObservation, recordHostedPoolActivity, completeHostedPoolReuse } =
  await import('./hosted-lifecycle-store');
const { beginWorkspaceHostOperation, readWorkspaceHostDestroyTarget, upsertWorkspaceHostResourceCheckpoint,
  readWorkspaceHostResourceCheckpoints } = await import('./observability-store');

const migration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1522-workspace-host-pool-admission.sql', import.meta.url));
const migrationSql = readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8');
const incarnationMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1523-workspace-host-resource-incarnation.sql', import.meta.url));
const incarnationSql = readFileSync(existsSync(incarnationMigration) ? incarnationMigration : `${incarnationMigration}.DRAFT`, 'utf8');
const authorityMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url));
const authoritySql = readFileSync(authorityMigration, 'utf8');
const scope = { kind: 'project', id: 'pool-project' };
const release = {
  version: 'pool-v1', bundleSha256: 'a'.repeat(64), signingKeySha256: 'b'.repeat(64),
  protocolVersion: 'workspace-host-bootstrap-v1', schemaVersion: '1522',
};

describe('hosted pool admission (real Postgres + workspace RLS)', () => {
  let db: OrgTestDb;
  const organizations = new Map<string, string>();
  const grants = new Map<string, { userId: string; revision: number }>();
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.appSql;
    await db.adminSql.unsafe(migrationSql);
    await db.adminSql.unsafe(migrationSql); // additive migration remains replayable
    await db.adminSql.unsafe(incarnationSql);
    await db.adminSql.unsafe(incarnationSql); // allocation identity migration is replayable too
    await db.adminSql.unsafe(authoritySql);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  const fresh = () => `pool-${randomUUID()}`;
  const organization = (ws: string, id: string) => organizations.get(`${ws}:${id}`)!;
  async function allowance(organizationId: string, quotas: Record<string, number> = {}, budget = 1000000,
    effectiveUntil = '2099-01-01T00:00:00Z') {
    let g = grants.get(organizationId);
    if (!g) {
      g = { userId: randomUUID(), revision: 0 };
      await db.adminSql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
        VALUES (${organizationId}::uuid, ${g.userId}::uuid, 'hosted-free', 'self_signup')`;
      grants.set(organizationId, g);
    }
    const record = { source: 'migration', actor: { kind: 'service', principalId: 'service:pool-fixture' },
      auditReceiptId: 'audit:pool-fixture-bundle', effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil };
    g.revision = await writeHostedEntitlementAuthority({ organizationId, userId: g.userId, kind: 'hosted-free',
      expectedRevision: g.revision, authority: { schemaVersion: 1,
        bundles: [{ schemaVersion: 1, bundleId: 'pool-fixture', bundleVersion: 1, record,
          entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 100, members: 100 },
            browserAccess: { pty: true, files: true }, supportTier: 'trial', rolloutFlags: {},
            quotas: { 'pool.hosts': 100, 'pool.cpu-millicores': 1000000, 'pool.memory-mib': 1000000,
              'pool.db-gib': 100000, 'pool.workspace-gib': 100000, ...quotas },
            budgets: { 'pool.cost.usd.minor': budget } } }],
        assignments: [{ schemaVersion: 1, assignmentId: `fixture:${organizationId}`, organizationId,
          bundleId: 'pool-fixture', bundleVersion: 1,
          record: { ...record, auditReceiptId: 'audit:pool-fixture-assignment' } }], overrides: [] } },
    run => db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return run(tx as any);
    }) as any);
  }
  function observation(overrides: Partial<HostedPoolObservation> = {}): HostedPoolObservation {
    return {
      generation: 1, desiredRevision: 1, controllerFence: 7, scope, zone: 'us-central1-a', architecture: 'x86_64',
      runtimeBundleSha256: release.bundleSha256, size: { cpuCount: 4, memoryMiB: 8192 },
      observedAtMs: Date.now() - 100, cleanAttestationRef: 'provider:verified-empty-generation-1', ...overrides,
    };
  }
  async function host(ws: string, id: string, options: { placeholder?: boolean; observation?: HostedPoolObservation; state?: string } = {}) {
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections
        (workspace_id, id, target, label, credential_ref, status)
      VALUES (${ws}, 'pool-connection', 'gcp', 'pool integration', 'test://no-provider-calls', 'connected')
      ON CONFLICT DO NOTHING`;
    const o = options.placeholder ? null : options.observation ?? observation();
    await db.adminSql`
      INSERT INTO harness_shared.workspace_hosts
        (workspace_id, id, name, connection_id, target, scope_label, region, size, image,
         disk_gib, network, desired_state, observed_state, desired_spec, host_generation,
         controller_id, controller_fence, runtime_release, pool_observation, health_status, health_attested_at,
         desired_revision, observed_revision)
      VALUES (${ws}, ${id}, ${id}, 'pool-connection', 'gcp', 'pool-project', 'us-central1',
        'test-4', 'test-image', 256, 'default', 'running', ${options.placeholder ? 'provisioning' : options.state ?? 'running'},
        ${JSON.stringify({ scope, zone: 'us-central1-a', data: { volumeGiB: 256,
          allocation: { dbGiB: 256, workspaceGiB: 0 }, encrypted: true } })}::jsonb, 1, 'controller-a', 7,
        ${JSON.stringify(release)}::jsonb, ${o ? JSON.stringify(o) : null}::jsonb,
        ${options.placeholder ? null : 'healthy'}, now(), 1, 1)`;
  }
  async function customer(ws: string, id: string, hostId = `${id}-placeholder`, organizationId: string = randomUUID()) {
    organizations.set(`${ws}:${id}`, organizationId);
    if (!grants.has(organizationId)) await allowance(organizationId);
    await host(ws, hostId, { placeholder: true });
    await db.adminSql`
      INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name, state,
         created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id,
         tenant_concurrency_limit, provider_concurrency_limit, monthly_lifecycle_budget_cents)
      VALUES (${ws}, ${id}, ${organizationId}, ${hostId}, ${id}, 'active', 'user', 'test-user',
        'organization', ${organizationId}, 1, 8, 10000)`;
    return hostId;
  }
  function input(ws: string, customerId: string, hostId = `${customerId}-placeholder`): AdmitHostedLifecycleJobInput {
    return {
      workspaceId: ws, customerWorkspaceId: customerId, hostId, providerTarget: 'gcp', action: 'start',
      actorId: 'test-user', operationId: `op-${customerId}`, riskTier: 'moderate', approvalStatus: 'not-required',
      estimate: { cents: 100, currency: 'USD', source: 'test-catalog', evidenceRef: 'test://catalog', estimatedAt: new Date().toISOString() },
      pool: {
        scope, region: 'us-central1', zone: 'us-central1-a', architecture: 'x86_64',
        runtimeBundleSha256: release.bundleSha256, dataVolumeId: `volume-${customerId}`,
        minimum: { cpuCount: 2, memoryMiB: 4096 }, maxObservationAgeMs: 60_000,
      },
    };
  }
  async function operations(ws: string) {
    return db.adminSql`SELECT id, host_id, admission_receipt FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws}`;
  }

  async function capacityDemand(ws: string, organizationId?: string) {
    const digest = randomUUID().replace(/-/g, '').slice(0, 24);
    const id = `ws-${digest}`, hostId = `host-${digest}`;
    await customer(ws, id, hostId, organizationId);
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'provisioning'
      WHERE workspace_id = ${ws} AND id = ${id}`;
    const target = { id: hostId, connectionId: 'pool-connection', hostGeneration: 1, desiredRevision: 1,
      controllerAuthority: { controllerId: 'controller-a', fence: 7 }, hostedCustomerWorkspaceId: id,
      desired: { target: 'gcp' } };
    const enqueue = vi.fn(async (request: any) => {
      const retained = { connectionId: request.connectionId, name: request.name, desired: request.desiredSpec };
      const replay = await readHostedLifecycleAdmission({ workspaceId: ws, customerWorkspaceId: id,
        operationId: request.operationId, actorId: request.actorId, request: retained });
      if (!replay) await admitHostedLifecycleJob({ ...input(ws, id, hostId), action: 'provision',
        operationId: request.operationId, request: retained, capacityReconcile: request.capacityReconcile });
    });
    return { id, hostId, target, enqueue,
      deps: { readTarget: async () => target as any, admitAndStart: enqueue } };
  }

  it('P539 recovers a crash before admission and re-enqueues the same durable operation on replay', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    const first = await reconcileHostedPoolDemand(ws, demand.deps);
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET display_name = 'changed after admission'
      WHERE workspace_id = ${ws} AND id = ${demand.id}`;
    const second = await reconcileHostedPoolDemand(ws, demand.deps);
    expect(first.enqueued).toEqual([`prov-${demand.hostId.slice(5)}`]);
    expect(second.enqueued).toEqual(first.enqueued);
    expect(await operations(ws)).toHaveLength(1);
    expect((await operations(ws))[0].admission_receipt.result.resourceAdmission.capacityDecision)
      .toMatchObject({ kind: 'provision', market: 'on-demand', generation: 1, controllerFence: 7 });
    expect(demand.enqueue).toHaveBeenCalledTimes(2);
    expect(demand.enqueue.mock.calls[1]![0].name).toBe(demand.id);
  });

  it('P539 admits a pristine placeholder before a controller has acquired its first fence', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_id = NULL, controller_fence = 0
      WHERE workspace_id = ${ws} AND id = ${demand.hostId}`;
    const { controllerAuthority: _unused, ...target } = demand.target;
    const result = await reconcileHostedPoolDemand(ws, { ...demand.deps, readTarget: async () => target as any });
    expect(result.enqueued).toHaveLength(1);
    expect(await operations(ws)).toHaveLength(1);
  });

  it('P539 holds unknown provider quotes through the maintained capacity policy without reserving a VM', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    await expect(admitHostedLifecycleJob({ ...input(ws, demand.id, demand.hostId), action: 'provision',
      estimate: { ...input(ws, demand.id).estimate, estimatedAt: new Date(Date.now() - 100_000).toISOString() },
      capacityReconcile: { hostGeneration: 1, controllerFence: 7, observedAtMs: Date.now() } }))
      .rejects.toThrow('hosted_pool_capacity_policy_rejected');
    expect(await operations(ws)).toEqual([]);
  });

  it.each(['request', 'persisted'] as const)('P539 refuses unqualified spot from %s even outside automatic reconciliation', async source => {
    const ws = fresh(), demand = await capacityDemand(ws);
    if (source === 'persisted') await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET desired_spec = desired_spec || '{"provider":{"provisioningModel":"spot"}}'::jsonb
      WHERE workspace_id = ${ws} AND id = ${demand.hostId}`;
    await expect(admitHostedLifecycleJob({ ...input(ws, demand.id, demand.hostId), action: 'provision',
      ...(source === 'request' ? { request: { desired: { provider: { provisioningModel: 'spot' } } } } : {}) }))
      .rejects.toThrow('hosted_pool_spot_reclaim_recovery_unverified');
    expect(await operations(ws)).toEqual([]);
  });

  it('P539 provisions on demand instead of assigning an otherwise clean unqualified spot spare', async () => {
    const ws = fresh();
    await customer(ws, 'on-demand');
    await host(ws, 'spot-spare');
    await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET desired_spec = desired_spec || '{"provider":{"provisioningModel":"spot"}}'::jsonb
      WHERE workspace_id = ${ws} AND id = 'spot-spare'`;
    expect(await admitHostedLifecycleJob({ ...input(ws, 'on-demand'), action: 'provision' }))
      .toMatchObject({ hostId: 'on-demand-placeholder', placement: { kind: 'provision' } });
  });

  it.each(['running', 'stopped', 'pending'] as const)('P539 counts a prior workspace\'s %s host while admitting its organization\'s new workspace', async state => {
    const ws = fresh(), org = randomUUID();
    const oldHost = await customer(ws, 'previous-owner', 'previous-owned-host', org);
    if (state === 'pending') {
      await admitHostedLifecycleJob({ ...input(ws, 'previous-owner', oldHost), action: 'provision' });
      await db.adminSql`UPDATE harness_shared.workspace_host_operations SET created_at = now() - interval '1 hour'
        WHERE workspace_id = ${ws}`;
    } else {
      await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = ${state},
        pool_observation = ${JSON.stringify(observation())}::jsonb
        WHERE workspace_id = ${ws} AND id = ${oldHost}`;
    }
    // The directory allows one live workspace per organization. Retiring its
    // row does not erase a still-owned VM or an outstanding reservation.
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${ws} AND id = 'previous-owner'`;
    const demand = await capacityDemand(ws, org);
    expect((await reconcileHostedPoolDemand(ws, demand.deps)).enqueued).toHaveLength(1);
    const [saved] = await db.adminSql`SELECT admission_receipt->'result'->'resourceAdmission' AS resources
      FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND host_id = ${demand.hostId}`;
    expect(saved.resources).toMatchObject({ allocated: { hosts: state === 'pending' ? 0 : 1 },
      pending: { hosts: state === 'pending' ? 1 : 0 }, requested: { hosts: 1 },
      capacityDecision: { kind: 'provision', readyHosts: 0, pendingHosts: 0 } });
  });

  it('P539 leaves failed provider resources with the existing recovery ledger instead of launching a replacement', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    await reconcileHostedPoolDemand(ws, demand.deps);
    const operationId = `prov-${demand.hostId.slice(5)}`;
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'failed',
      error = '{"code":"provider-create-ambiguous"}'::jsonb WHERE workspace_id = ${ws} AND id = ${operationId}`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources
      (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id)
      VALUES (${ws}, ${demand.hostId}, 'create-vm', ${operationId}, 'applied', 'vm', 'orphan-provider-vm')`;
    expect(await reconcileHostedPoolDemand(ws, demand.deps)).toEqual({ considered: 0, enqueued: [], held: [] });
    expect(await operations(ws)).toHaveLength(1);
    expect(demand.enqueue).toHaveBeenCalledTimes(1);
    const resources = await db.adminSql`SELECT provider_id FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${ws} AND host_id = ${demand.hostId}`;
    expect(resources).toEqual([expect.objectContaining({ provider_id: 'orphan-provider-vm' })]);
  });

  it('P539 uses the shared scope clock and holds a second customer during cooldown', async () => {
    const ws = fresh(), first = await capacityDemand(ws), second = await capacityDemand(ws);
    await reconcileHostedPoolDemand(ws, first.deps);
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'running'
      WHERE workspace_id = ${ws}`;
    const result = await reconcileHostedPoolDemand(ws, second.deps);
    expect(result.held).toEqual([{ hostId: second.hostId, reason: 'hosted_pool_capacity_cooldown' }]);
    expect(await operations(ws)).toHaveLength(1);
  });

  it('P539 concurrent reconcilers reserve at most one operation and account for pending capacity', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    await Promise.all([reconcileHostedPoolDemand(ws, demand.deps), reconcileHostedPoolDemand(ws, demand.deps)]);
    expect(await operations(ws)).toHaveLength(1);
    const raw = { ...input(ws, demand.id, demand.hostId), action: 'provision' as const,
      operationId: `another-${randomUUID()}`, capacityReconcile: {
        hostGeneration: 1, controllerFence: 7, observedAtMs: Date.now() } };
    await expect(admitHostedLifecycleJob(raw)).rejects.toThrow();
    expect(await operations(ws)).toHaveLength(1);
  });

  it('P539 holds a changed generation before any enqueue and preserves the demand row', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    const result = await reconcileHostedPoolDemand(ws, { ...demand.deps,
      readTarget: async () => ({ ...demand.target, hostGeneration: 2 }) as any });
    expect(result.held).toEqual([{ hostId: demand.hostId, reason: 'demand-generation-unverified' }]);
    expect(demand.enqueue).not.toHaveBeenCalled();
    expect(await operations(ws)).toEqual([]);
  });

  it.each(['stale', 'future', 'generation', 'fence'] as const)('P539 refuses %s capacity proof under real admission locks', async kind => {
    const ws = fresh(), demand = await capacityDemand(ws);
    const snapshot = { hostGeneration: 1, controllerFence: 7, observedAtMs: Date.now() };
    if (kind === 'stale') snapshot.observedAtMs -= 100_000;
    if (kind === 'future') snapshot.observedAtMs += 100_000;
    if (kind === 'generation') snapshot.hostGeneration += 1;
    if (kind === 'fence') snapshot.controllerFence += 1;
    await expect(admitHostedLifecycleJob({ ...input(ws, demand.id, demand.hostId),
      action: 'provision', capacityReconcile: snapshot })).rejects.toThrow(/capacity_(observation_unverified|generation_changed)/);
    expect(await operations(ws)).toEqual([]);
  });

  it('P539 refuses quota exhaustion without forgetting queued demand', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    await allowance(organization(ws, demand.id), { 'pool.hosts': 0 });
    const result = await reconcileHostedPoolDemand(ws, demand.deps);
    expect(result.enqueued).toEqual([]);
    expect(result.held).toHaveLength(1);
    expect(await operations(ws)).toEqual([]);
  });

  it('P539 rotates a held tenant so another queued customer can progress on the next tick', async () => {
    const ws = fresh(), first = await capacityDemand(ws), second = await capacityDemand(ws);
    await allowance(organization(ws, first.id), { 'pool.hosts': 0 });
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET updated_at = now() - interval '1 hour'
      WHERE workspace_id = ${ws} AND id = ${first.hostId}`;
    const demands = [first, second];
    const deps = {
      readTarget: async (_ws: string, hostId: string) => demands.find(d => d.hostId === hostId)!.target as any,
      admitAndStart: async (request: any) => demands.find(d => d.hostId === request.hostId)!.enqueue(request),
    };
    const held = await reconcileHostedPoolDemand(ws, deps);
    expect(held.held).toHaveLength(1);
    expect(held.enqueued).toEqual([]);
    const admitted = await reconcileHostedPoolDemand(ws, deps);
    expect(admitted.enqueued).toEqual([`prov-${second.hostId.slice(5)}`]);
    expect(first.enqueue).toHaveBeenCalledTimes(1);
    expect(second.enqueue).toHaveBeenCalledTimes(1);
    expect(await operations(ws)).toHaveLength(1);
  });

  it('P539 checkpoints the selected demand so a workflow replay cannot choose another tenant', async () => {
    const ws = fresh(), first = await capacityDemand(ws), second = await capacityDemand(ws);
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET updated_at = now() - interval '1 hour'
      WHERE workspace_id = ${ws} AND id = ${first.hostId}`;
    let saved: unknown;
    const sampleDemand = async <T>(read: () => Promise<T>): Promise<T> => (saved ??= await read()) as T;
    const deps = { ...first.deps, sampleDemand };
    const original = await reconcileHostedPoolDemand(ws, deps);
    const replay = await reconcileHostedPoolDemand(ws, deps);
    expect(original.enqueued).toEqual([`prov-${first.hostId.slice(5)}`]);
    expect(replay.enqueued).toEqual(original.enqueued);
    expect(second.enqueue).not.toHaveBeenCalled();
    expect(await operations(ws)).toHaveLength(1);
  });

  it('P539 restores the hosted native-agent readiness configuration after a lost signup enqueue', async () => {
    const ws = fresh(), demand = await capacityDemand(ws);
    const adapter = await import('../auth/hosted/workspace-admission-dependencies');
    const { PAPERCUSP_HOSTED_BRING_UP_AGENTS } = await import('./hosted-bring-up');
    const factory = vi.spyOn(adapter, 'createDefaultHostedWorkspaceAdmissionDependencies')
      .mockImplementationOnce(options => {
        expect(options.bringUp?.requestedAgents).toEqual(PAPERCUSP_HOSTED_BRING_UP_AGENTS);
        expect(options.bringUp?.requestedAgents.length).toBeGreaterThan(0);
        return { admitAndStart: demand.enqueue } as any;
      });
    try {
      const result = await reconcileHostedPoolDemand(ws, { readTarget: demand.deps.readTarget });
      expect(result.enqueued).toHaveLength(1);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally { factory.mockRestore(); }
  });

  async function pinDiskAllocation(ws: string, operationId: string, capacity = { dbGiB: 256, workspaceGiB: 0 }) {
    await db.adminSql`UPDATE harness_shared.workspace_host_operations
      SET admission_receipt = ${JSON.stringify({ result: { resourceAdmission: { storage: { capacity } } } })}::jsonb
      WHERE workspace_id = ${ws} AND id = ${operationId}`;
  }

  async function agentBinding(ws: string, id: string, org?: string): Promise<HostedConnectorBinding> {
    const hostId = await customer(ws, id, `${id}-placeholder`, org);
    const organizationId = organization(ws, id);
    await db.adminSql`INSERT INTO papercusp_auth.hosted_workspace_connectors
      (control_workspace_id, organization_id, customer_workspace_id, host_id, route_label, generation, state, transport,
       credential_hash, registered_at)
      VALUES (${ws}, ${organizationId}::uuid, ${id}, ${hostId}, ${id}, 1, 'active', 'websocket',
        ${randomUUID().replaceAll('-', '').repeat(2)}, now())`;
    return { controlPlaneWorkspaceId: ws, organizationId, customerWorkspaceId: id, hostId,
      routeLabel: id, generation: 1, state: 'active', transport: 'websocket' };
  }
  function agents(binding: HostedConnectorBinding) {
    const store = new PgAdmissionLedgerQueueStore({ sql: db.adminSql as any,
      workspaceId: binding.controlPlaneWorkspaceId, resolveSessionStatesFn: allSessionsLiveResolver,
      admitNewRecord: hostedPoolAgentAdmissionGuard(binding) });
    const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'hosted-agent' });
    const governor = new Governor(driver);
    const admit = (key: string = randomUUID(), metadata: Record<string, string | number> = {}) => governor.admit({
      idempotencyKey: key, admissionClass: 'agent', metadata: {
        hostedOrganizationId: binding.organizationId, hostedCustomerWorkspaceId: binding.customerWorkspaceId,
        hostedHostId: binding.hostId, hostedConnectorGeneration: binding.generation, ...metadata } });
    return { store, driver, governor, admit };
  }

  async function idleRequest(prefix = 'idle') {
    const id = `${prefix}-${randomUUID()}`;
    const binding = await agentBinding(fresh(), id);
    await allowance(binding.organizationId, {
      'pool.idle-stop-minutes': 5, 'pool.agents': 4, 'pool.pending-agents': 4,
    });
    const ws = binding.controlPlaneWorkspaceId;
    const measuredAt = Date.now();
    const o = observation({ workload: { activeCommands: 0, attachedViewers: 0,
      connectorGeneration: binding.generation, observedAtMs: measuredAt } });
    await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET observed_state = 'running', pool_observation = ${JSON.stringify(o)}::jsonb
      WHERE workspace_id = ${ws} AND id = ${binding.hostId}`;
    await db.adminSql`UPDATE harness_shared.customer_workspaces
      SET last_activity_at = ${new Date(measuredAt - 60 * 60_000).toISOString()}::timestamptz,
          idle_stop_after_minutes = 1
      WHERE workspace_id = ${ws} AND id = ${id}`;
    const request: AdmitHostedLifecycleJobInput = { ...input(ws, id, binding.hostId),
      pool: undefined, action: 'stop', idleStop: true, riskTier: 'low',
      estimate: { cents: 0, currency: 'USD', source: 'test-catalog', evidenceRef: 'test://stop',
        estimatedAt: new Date().toISOString() }, request: { hostId: binding.hostId, action: 'stop' } };
    return { binding, ws, measuredAt, o, request };
  }

  it('idle-stop binds current authority, workload and host identity in its existing operation receipt', async () => {
    const { ws, request, binding, measuredAt } = await idleRequest();
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt).toMatchObject({ action: 'stop', created: true, idleStop: {
      schemaVersion: 1, idleStopAfterMinutes: 5, connectorGeneration: binding.generation,
      hostGeneration: 1, controllerFence: 7, hostDesiredRevision: 1, workloadObservedAtMs: measuredAt,
    } });
    expect(receipt.idleStop?.authorityRevision).toBe(grants.get(binding.organizationId)!.revision);
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
    expect(await operations(ws)).toHaveLength(1);
  });

  it.each([undefined, 0])('idle-stop holds without an enabled canonical idle quota (%s), ignoring directory defaults', async minutes => {
    const { request, binding, ws } = await idleRequest();
    await allowance(binding.organizationId, minutes === undefined ? {} : { 'pool.idle-stop-minutes': minutes });
    await expect(admitHostedLifecycleJob(request)).rejects.toThrow('hosted_pool_idle_policy_disabled');
    expect(await operations(ws)).toHaveLength(0);
  });

  it.each([
    ['commands', { activeCommands: 1 }], ['unknown', { activeCommands: null }],
    ['viewer', { attachedViewers: 1 }], ['stale', { observedAtMs: Date.now() - 5 * 60_000 }],
    ['future', { observedAtMs: Date.now() + 10 * 60_000 }], ['connector', { connectorGeneration: 2 }],
  ])('idle-stop holds for %s workload evidence', async (_name, patch) => {
    const { request, ws, o } = await idleRequest();
    await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET pool_observation = ${JSON.stringify({ ...o, workload: { ...o.workload, ...patch } })}::jsonb
      WHERE workspace_id = ${ws} AND id = ${request.hostId}`;
    await expect(admitHostedLifecycleJob(request)).rejects.toThrow('hosted_pool_idle_');
    expect(await operations(ws)).toHaveLength(0);
  });

  it.each(['missing', 'generation', 'revision'])('idle-stop holds for %s host observation', async reason => {
    const { request, ws, o } = await idleRequest();
    const next = reason === 'missing' ? { ...o, workload: undefined } : reason === 'generation'
      ? { ...o, generation: 2 } : { ...o, desiredRevision: 2 };
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET pool_observation = ${JSON.stringify(next)}::jsonb
      WHERE workspace_id = ${ws} AND id = ${request.hostId}`;
    await expect(admitHostedLifecycleJob(request)).rejects.toThrow('hosted_pool_idle_');
  });

  it('idle-stop rechecks rotated connector and expired authority', async () => {
    const rotated = await idleRequest('rotated');
    await db.adminSql`UPDATE papercusp_auth.hosted_workspace_connectors SET generation = 2
      WHERE control_workspace_id = ${rotated.ws} AND customer_workspace_id = ${rotated.binding.customerWorkspaceId}`;
    await expect(admitHostedLifecycleJob(rotated.request)).rejects.toThrow('hosted_pool_idle_');
    const expired = await idleRequest('expired');
    await allowance(expired.binding.organizationId, { 'pool.idle-stop-minutes': 5 }, 1000000, '2026-01-02T00:00:00Z');
    await expect(admitHostedLifecycleJob(expired.request)).rejects.toThrow('hosted_pool_idle_entitlement_');
  });

  it.each(['reserve', 'start'] as const)('idle-stop counts canonical %s receipts until process settlement', async phase => {
    const { binding, request } = await idleRequest();
    const call = createHostedPoolAgentReservations(binding, db.adminSql as any);
    await call('reserve', 'busy');
    if (phase === 'start') await call('start', 'busy');
    await expect(admitHostedLifecycleJob(request)).rejects.toThrow('hosted_pool_idle_active_work');
    await call('finish', 'busy');
    await expect(admitHostedLifecycleJob(request)).resolves.toMatchObject({ action: 'stop' });
  });

  it('idle-stop serializes with agent admission: exactly one side may start', async () => {
    const { binding, request } = await idleRequest();
    const result = await Promise.allSettled([admitHostedLifecycleJob(request), agents(binding).admit('racer')]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
  });

  it('idle-stop rejects later native starts until its operation settles', async () => {
    const { binding, request, ws } = await idleRequest();
    await admitHostedLifecycleJob(request);
    await expect(agents(binding).admit('too-late')).rejects.toThrow('hosted_pool_agent_host_draining');
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'failed'
      WHERE workspace_id = ${ws} AND id = ${request.operationId!}`;
    await expect(agents(binding).admit('after-refused-stop')).resolves.toMatchObject({ kind: 'queued' });
  });

  it('fences native starts for an operator-requested stop as well as an idle stop', async () => {
    const ws = fresh();
    const binding = await agentBinding(ws, 'manual-stop');
    await allowance(binding.organizationId, { 'pool.agents': 1 });
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations
      (workspace_id, id, host_id, action, status, customer_workspace_id, organization_id)
      VALUES (${ws}, 'manual-stop-operation', ${binding.hostId}, 'stop', 'queued',
        ${binding.customerWorkspaceId}, ${binding.organizationId})`;
    await expect(agents(binding).admit('after-manual-stop')).rejects.toThrow('hosted_pool_agent_host_draining');
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'failed'
      WHERE workspace_id = ${ws} AND id = 'manual-stop-operation'`;
    await expect(agents(binding).admit('after-refused-manual-stop')).resolves.toMatchObject({ kind: 'queued' });
  });

  it('idle-stop cannot relabel a start or a spending request', async () => {
    const { request } = await idleRequest();
    await expect(admitHostedLifecycleJob({ ...request, action: 'start' })).rejects.toThrow('hosted_pool_idle_request_invalid');
    await expect(admitHostedLifecycleJob({ ...request, estimate: { ...request.estimate, cents: 1 } }))
      .rejects.toThrow('hosted_pool_idle_request_invalid');
  });

  it('persists only current generation workload and advances activity only for measured work', async () => {
    const raw = await agentBinding(fresh(), 'activity');
    const binding = { ...raw, hosting: 'papercusp' as const };
    const ws = binding.controlPlaneWorkspaceId;
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running',
      pool_observation = ${JSON.stringify(observation())}::jsonb
      WHERE workspace_id = ${ws} AND id = ${binding.hostId}`;
    const start = Date.now();
    const idle = { activeCommands: 0, attachedViewers: 0 };
    expect(await recordHostedPoolActivity(binding, idle, new Date(start))).toBe(true);
    expect(await recordHostedPoolActivity(binding, idle, new Date(start + 100))).toBe(true);
    expect(await recordHostedPoolActivity(binding, { ...idle, activeCommands: null }, new Date(start + 200))).toBe(true);
    const [quiet] = await db.adminSql`SELECT last_activity_at FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${ws} AND id = 'activity'`;
    expect(new Date(quiet.last_activity_at).getTime()).toBe(start);
    expect(await recordHostedPoolActivity(binding, { ...idle, activeCommands: 1 }, new Date(start + 300))).toBe(true);
    expect(await recordHostedPoolActivity(binding, idle, new Date(start + 100))).toBe(false);
    const [observed] = await db.adminSql`SELECT host.pool_observation, customer.last_activity_at
      FROM harness_shared.workspace_hosts host JOIN harness_shared.customer_workspaces customer
        ON customer.workspace_id = host.workspace_id AND customer.workspace_host_id = host.id
      WHERE host.workspace_id = ${ws} AND host.id = ${binding.hostId}`;
    expect(observed.pool_observation.workload).toMatchObject({ activeCommands: 1, connectorGeneration: 1, observedAtMs: start + 300 });
    expect(new Date(observed.last_activity_at).getTime()).toBe(start + 300);
    await db.adminSql`UPDATE papercusp_auth.hosted_workspace_connectors SET generation = 2
      WHERE control_workspace_id = ${ws} AND customer_workspace_id = 'activity'`;
    expect(await recordHostedPoolActivity(binding, idle, new Date(start + 400))).toBe(false);
    expect(await recordHostedPoolActivity({ ...binding, hosting: 'byoc' }, idle)).toBe(false);
    expect(await recordHostedPoolActivity({ ...binding, generation: 2 }, { ...idle, activeCommands: -1 })).toBe(false);
  });

  it('connector process reservations retain running quota across independent handlers and release exactly their own key', async () => {
    const binding = await agentBinding(fresh(), 'remote-process');
    await allowance(binding.organizationId, { 'pool.agents': 1, 'pool.pending-agents': 1 });
    const call = () => createHostedPoolAgentReservations(binding, db.adminSql as any);
    const reserved = await call()('reserve', 'first');
    expect(reserved.state).toBe('queued');
    expect((await call()('reserve', 'first')).receiptId).toBe(reserved.receiptId);
    expect((await call()('start', 'first')).state).toBe('running');
    expect((await call()('start', 'first')).state).toBe('running');
    await expect(call()('reserve', 'second')).rejects.toThrow('quota_exceeded');
    await expect(createHostedPoolAgentReservations({ ...binding, customerWorkspaceId: 'foreign' }, db.adminSql as any)('finish', 'first'))
      .rejects.toThrow('reservation_missing');
    expect((await call()('finish', 'first')).state).toBe('cancelled');
    await expect(call()('reserve', 'first')).rejects.toThrow('process_key_terminal');
    expect((await call()('reserve', 'second')).state).toBe('queued');
  });

  it('agent reservations atomically include pending demand across independent writers', async () => {
    const ws = fresh();
    const left = await agentBinding(ws, 'agent-left');
    await allowance(left.organizationId, { 'pool.agents': 1 });
    const outcomes = await Promise.allSettled([agents(left).admit(), agents(left).admit()]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toMatchObject([
      { reason: { message: expect.stringContaining('hosted_pool_agent_quota_exceeded') } }]);
    const [count] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.resource_governor_admissions
      WHERE workspace_id = ${ws}`;
    expect(count.n).toBe(1);
  });

  it('releases only the absent host receipts, with replay-safe cancellation and no guessed process death', async () => {
    const ws = fresh();
    const binding = await agentBinding(ws, 'retire-agents');
    const other = await agentBinding(ws, 'keep-agents');
    await allowance(binding.organizationId, { 'pool.agents': 2 });
    await allowance(other.organizationId, { 'pool.agents': 1 });
    const call = createHostedPoolAgentReservations(binding, db.adminSql as any);
    const running = await call('reserve', 'running');
    await call('start', 'running');
    const queued = await call('reserve', 'queued');
    const kept = await createHostedPoolAgentReservations(other, db.adminSql as any)('reserve', 'other-host');
    const retire = (workspaceId = ws) => retireHostedPoolAgentReservations({
      controlPlaneWorkspaceId: workspaceId, hostId: binding.hostId }, db.adminSql as any);
    await expect(retire()).rejects.toThrow('host_not_absent');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_state = 'absent'
      WHERE workspace_id = ${ws} AND id = ${binding.hostId}`;
    await expect(retire()).rejects.toThrow('host_not_absent');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'absent'
      WHERE workspace_id = ${ws} AND id = ${binding.hostId}`;
    await expect(retire('foreign-workspace')).rejects.toThrow('host_not_absent');
    expect(await retire()).toBe(2);
    expect(await retire()).toBe(0);
    const records = await db.adminSql`SELECT receipt_id, state, record FROM harness_shared.resource_governor_admissions
      WHERE workspace_id = ${ws} ORDER BY receipt_id`;
    for (const receipt of [running, queued]) {
      expect(records.find(row => row.receipt_id === receipt.receiptId)).toMatchObject({ state: 'cancelled',
        record: { state: 'cancelled', cancellationReason: 'provider-confirmed host absence' } });
    }
    expect(records.find(row => row.receipt_id === kept.receiptId)).toMatchObject({ state: 'queued' });
  });

  it('agent reservations enforce the boot queue cap, count running once, and release on cancellation', async () => {
    const binding = await agentBinding(fresh(), 'agent-pending');
    await allowance(binding.organizationId, { 'pool.agents': 2, 'pool.pending-agents': 1 });
    const runtime = agents(binding);
    const first = await runtime.admit('agent-first');
    if (first.kind !== 'queued') throw new Error('durable queue required');
    await expect(runtime.admit('agent-second')).rejects.toThrow('hosted_pool_agent_pending_quota_exceeded');
    const lease = await runtime.driver.leaseReceipt({ receiptId: first.receipt.receiptId, owner: 'agent-owner', ttlMs: 60000 });
    if (!lease) throw new Error('lease required');
    await runtime.driver.markRunning(lease.receiptId, lease.lease.leaseId);
    const second = await runtime.admit('agent-second');
    expect(second.kind).toBe('queued');
    await expect(runtime.admit('agent-third')).rejects.toThrow('hosted_pool_agent_quota_exceeded');
    await runtime.governor.cancel('agent-first', 'process exited');
    await runtime.governor.cancel('agent-second', 'spawn failed');
    expect((await runtime.admit('agent-third')).kind).toBe('queued');
  });

  it('agent reservation replay consumes no second slot and records canonical authority evidence', async () => {
    const binding = await agentBinding(fresh(), 'agent-replay');
    await allowance(binding.organizationId, { 'pool.agents': 1 });
    const runtime = agents(binding);
    const first = await runtime.admit('same-agent');
    const replay = await runtime.admit('same-agent');
    expect(replay.kind === 'queued' && first.kind === 'queued' && replay.receipt.receiptId).toBe(
      first.kind === 'queued' && first.receipt.receiptId);
    const saved = await runtime.store.find('hosted-agent', 'same-agent');
    expect(saved?.record.decision.evidence).toMatchObject({ hostedPoolAgentAuthorityRevision: grants.get(binding.organizationId)!.revision,
      hostedPoolAgentAllocated: 0, hostedPoolAgentPending: 0 });
  });

  it('agent reservations isolate organizations and refuse foreign or rotated connector bindings', async () => {
    const ws = fresh();
    const left = await agentBinding(ws, 'agent-own');
    const right = await agentBinding(ws, 'agent-foreign');
    await allowance(left.organizationId, { 'pool.agents': 1 });
    await allowance(right.organizationId, { 'pool.agents': 1 });
    expect((await agents(left).admit()).kind).toBe('queued');
    expect((await agents(right).admit()).kind).toBe('queued');
    await expect(agents(left).admit('forged', { hostedOrganizationId: right.organizationId }))
      .rejects.toThrow('hosted_pool_agent_binding_mismatch');
    await db.adminSql`UPDATE papercusp_auth.hosted_workspace_connectors SET generation = 2
      WHERE control_workspace_id = ${ws} AND customer_workspace_id = ${right.customerWorkspaceId}`;
    await expect(agents(right).admit()).rejects.toThrow('hosted_pool_agent_binding_inactive');
  });

  it('agent reservations refuse missing or expired authority and apply downgrades without deleting receipts', async () => {
    const binding = await agentBinding(fresh(), 'agent-downgrade');
    const runtime = agents(binding);
    await expect(runtime.admit()).rejects.toThrow('hosted_pool_agent_quota_exceeded');
    await allowance(binding.organizationId, { 'pool.agents': 2 });
    await runtime.admit('retained-agent');
    await allowance(binding.organizationId, { 'pool.agents': 0 });
    await expect(runtime.admit()).rejects.toThrow('hosted_pool_agent_quota_exceeded');
    expect((await runtime.store.find('hosted-agent', 'retained-agent'))?.record.state).toBe('queued');
    await allowance(binding.organizationId, { 'pool.agents': 2 }, 1000000, '2026-01-02T00:00:00Z');
    await expect(runtime.admit()).rejects.toThrow('hosted_pool_agent_entitlement_');
  });

  it('charges an explicit split once and pins storage in the immutable replay receipt', async () => {
    const ws = fresh();
    await customer(ws, 'storage');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{data}',
      ${JSON.stringify({ volumeGiB: 320, allocation: { dbGiB: 256, workspaceGiB: 64 }, encrypted: true })}::jsonb)
      WHERE workspace_id = ${ws} AND id = 'storage-placeholder'`;
    await allowance(organization(ws, 'storage'), { 'pool.db-gib': 256, 'pool.workspace-gib': 64 });
    const request = { ...input(ws, 'storage'), action: 'provision' as const };
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt.resourceAdmission).toMatchObject({ storage: {
      allocated: { dbGiB: 0, workspaceGiB: 0 }, pending: { dbGiB: 0, workspaceGiB: 0 },
      requested: { dbGiB: 256, workspaceGiB: 64 }, capacity: { dbGiB: 256, workspaceGiB: 64 },
    } });
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = '{}'::jsonb WHERE workspace_id = ${ws}`;
    await allowance(organization(ws, 'storage'), { 'pool.db-gib': 0, 'pool.workspace-gib': 0 });
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
  });

  it('recovers original quota receipt across replacement and mutable desired edits, scoped to the control workspace', async () => {
    const ws = fresh();
    await customer(ws, 'quota-origin');
    const capacity = { dbGiB: 192, workspaceGiB: 64 };
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{data}',
      ${JSON.stringify({ volumeGiB: 256, allocation: capacity, encrypted: true })}::jsonb)
      WHERE workspace_id = ${ws} AND id = 'quota-origin-placeholder'`;
    const receipt = await admitHostedLifecycleJob({ ...input(ws, 'quota-origin'), action: 'provision' });
    // The receipt remains readable before the first provider call/resource checkpoint.
    expect(await readWorkspaceHostDestroyTarget(ws, receipt.hostId)).toMatchObject({
      durableStorageAdmission: { operationId: receipt.operationId, customerWorkspaceId: 'quota-origin', allocation: capacity },
    });
    await host(ws, 'quota-replacement', { placeholder: true });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET workspace_host_id = 'quota-replacement'
      WHERE workspace_id = ${ws} AND id = 'quota-origin'`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations
      (workspace_id, id, host_id, action, status) VALUES (${ws}, 'later-repair', 'quota-replacement', 'repair', 'succeeded')`;
    for (const [hostId, operationId, logicalKey] of [
      [receipt.hostId, receipt.operationId, 'original-disk'], ['quota-replacement', 'later-repair', 'attached-disk'],
    ]) {
      await db.adminSql`INSERT INTO harness_shared.workspace_host_resources
        (workspace_id, host_id, operation_id, logical_key, state, target, kind, provider_id, parent_provider_id, zone)
        VALUES (${ws}, ${hostId}, ${operationId}, ${logicalKey}, 'applied', 'gcp', 'disk', 'quota-retained-volume',
          'pool-project', 'us-central1-a')`;
    }
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{data}',
      ${JSON.stringify({ volumeGiB: 2000, allocation: { dbGiB: 1000, workspaceGiB: 1000 } })}::jsonb)
      WHERE workspace_id = ${ws}`;
    expect(await readWorkspaceHostDestroyTarget(ws, 'quota-replacement')).toMatchObject({
      durableStorageAdmission: { operationId: receipt.operationId, customerWorkspaceId: 'quota-origin', allocation: capacity },
    });
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{scope}',
      ${JSON.stringify({ kind: 'project', id: 'foreign-project' })}::jsonb)
      WHERE workspace_id = ${ws} AND id = 'quota-replacement'`;
    expect(await readWorkspaceHostDestroyTarget(ws, 'quota-replacement')).toMatchObject({
      durableStorageAdmission: { operationId: receipt.operationId, allocation: null },
    });
    expect(await readWorkspaceHostDestroyTarget(fresh(), 'quota-replacement')).toBeNull();
  });

  it.each([
    { volumeGiB: 256 },
    { volumeGiB: 256, allocation: { dbGiB: 256, workspaceGiB: 256 } },
    { volumeGiB: 256, allocation: { dbGiB: -1, workspaceGiB: 257 } },
    { volumeGiB: 256, allocation: { dbGiB: '256', workspaceGiB: 0 } },
    { volumeGiB: 256, allocation: { dbGiB: 255.5, workspaceGiB: 0.5 } },
  ])('refuses unknown or invalid storage allocation before any reservation: %j', async data => {
    const ws = fresh();
    await customer(ws, 'invalid-storage');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{data}', ${JSON.stringify(data)}::jsonb)
      WHERE workspace_id = ${ws}`;
    await expect(admitHostedLifecycleJob({ ...input(ws, 'invalid-storage'), action: 'provision' }))
      .rejects.toThrow('hosted_pool_storage_allocation_invalid');
    expect(await operations(ws)).toHaveLength(0);
  });

  it.each(['pool.db-gib', 'pool.workspace-gib'])('enforces %s on real allocation admission', async quota => {
    const ws = fresh();
    await customer(ws, 'storage-limit');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{data}',
      ${JSON.stringify({ volumeGiB: 320, allocation: { dbGiB: 256, workspaceGiB: 64 }, encrypted: true })}::jsonb)
      WHERE workspace_id = ${ws}`;
    await allowance(organization(ws, 'storage-limit'), { [quota]: quota === 'pool.db-gib' ? 255 : 63 });
    await expect(admitHostedLifecycleJob({ ...input(ws, 'storage-limit'), action: 'provision' }))
      .rejects.toThrow(`quota_exceeded:${quota}`);
    expect(await operations(ws)).toHaveLength(0);
  });

  it('includes pending storage across customer directories and moves it to allocated only once', async () => {
    const ws = fresh();
    const org = randomUUID();
    await customer(ws, 'disk-one', undefined, org);
    await allowance(org, { 'pool.db-gib': 256 });
    const first = await admitHostedLifecycleJob({ ...input(ws, 'disk-one'), action: 'provision' });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${ws} AND id = 'disk-one'`;
    await customer(ws, 'disk-two', undefined, org);
    await expect(admitHostedLifecycleJob({ ...input(ws, 'disk-two'), action: 'provision' }))
      .rejects.toThrow('quota_exceeded:pool.db-gib');
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources
      (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id)
      VALUES (${ws}, ${first.hostId}, 'create-data-disk', ${first.operationId}, 'applied', 'disk', 'volume-disk-one')`;
    // A later desired-spec edit must not shrink the ORIGINAL disk charge.
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_spec = jsonb_set(desired_spec, '{data}',
      ${JSON.stringify({ volumeGiB: 1, allocation: { dbGiB: 1, workspaceGiB: 0 } })}::jsonb)
      WHERE workspace_id = ${ws} AND id = ${first.hostId}`;
    await allowance(org, { 'pool.db-gib': 511 });
    await expect(admitHostedLifecycleJob({ ...input(ws, 'disk-two'), action: 'provision' }))
      .rejects.toThrow('quota_exceeded:pool.db-gib');
    await allowance(org, { 'pool.db-gib': 512 });
    const second = await admitHostedLifecycleJob({ ...input(ws, 'disk-two'), action: 'provision' });
    expect(second.resourceAdmission).toMatchObject({ storage: {
      allocated: { dbGiB: 256, workspaceGiB: 0 }, pending: { dbGiB: 0, workspaceGiB: 0 },
      requested: { dbGiB: 256, workspaceGiB: 0 },
    } });
  });

  it.each(['active', 'expired', 'revoked', 'unconfigured'] as const)(
    'handles a pre-policy signed-in tenant at admission: %s', async state => {
      const ws = fresh();
      await customer(ws, 'legacy');
      await host(ws, 'warm');
      const org = organization(ws, 'legacy');
      const createdAt = new Date(Date.now() - (state === 'expired' ? 2 * 86_400_000 : 3_600_000));
      await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET authority = NULL,
        authority_revision = ${state === 'revoked' ? 2 : 0}, created_at = ${createdAt}
        WHERE organization_id = ${org}::uuid`;
      const record = { source: 'trial', actor: { kind: 'service', principalId: 'service:trial-policy' },
        auditReceiptId: 'trial-policy:admission-fixture', effectiveFrom: '2020-01-01', effectiveUntil: null };
      const trial = { assignmentDurationMs: 86_400_000, bundle: {
        schemaVersion: 1, bundleId: 'admission-trial-fixture', bundleVersion: 1, record,
        entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
          browserAccess: { pty: true, files: true }, supportTier: 'trial', rolloutFlags: {},
          quotas: { 'pool.agents': 50, 'pool.hosts': 1, 'pool.cpu-millicores': 4000,
            'pool.memory-mib': 16384, 'pool.db-gib': 256, 'pool.workspace-gib': 100 },
          budgets: { 'pool.cost.usd.minor': 10000 } },
      } };
      const previous = process.env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT;
      try {
        if (state === 'unconfigured') delete process.env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT;
        else process.env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT = JSON.stringify(trial);
        if (state === 'active') {
          const receipt = await admitHostedLifecycleJob(input(ws, 'legacy'));
          expect(receipt.resourceAdmission).toMatchObject({ authorityRevision: 1, bundleId: 'admission-trial-fixture' });
          const [grant] = await db.adminSql`SELECT authority FROM papercusp_auth.hosted_entitlements
            WHERE organization_id = ${org}::uuid`;
          expect(grant.authority.assignments[0].record).toMatchObject({ effectiveFrom: createdAt.toISOString(),
            effectiveUntil: new Date(createdAt.getTime() + 86_400_000).toISOString() });
        } else {
          await expect(admitHostedLifecycleJob(input(ws, 'legacy')))
            .rejects.toThrow(state === 'expired' ? 'no_active_assignment' : 'authority_missing');
          expect(await operations(ws)).toHaveLength(0);
          const [grant] = await db.adminSql`SELECT authority, authority_revision FROM papercusp_auth.hosted_entitlements
            WHERE organization_id = ${org}::uuid`;
          // Rejected admission also rolls back any attempted legacy backfill.
          expect(grant).toMatchObject({ authority: null, authority_revision: state === 'revoked' ? 2 : 0 });
          const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
            WHERE workspace_id = ${ws} AND id = 'legacy'`;
          expect(bound.workspace_host_id).toBe('legacy-placeholder');
        }
      } finally {
        if (previous === undefined) delete process.env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT;
        else process.env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT = previous;
      }
    });

  it('refuses missing or revoked authority before rebinding a warm VM and replays an existing receipt after revocation', async () => {
    const ws = fresh();
    await customer(ws, 'authority');
    await host(ws, 'warm');
    const org = organization(ws, 'authority');
    const request = input(ws, 'authority');
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt.resourceAdmission).toMatchObject({ authorityRevision: 1, bundleId: 'pool-fixture',
      requested: { hosts: 1, cpuMillicores: 4000, memoryMiB: 8192 },
      auditReceiptIds: ['audit:pool-fixture-bundle', 'audit:pool-fixture-assignment'] });
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET authority = NULL,
      authority_revision = authority_revision + 1 WHERE organization_id = ${org}::uuid`;
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
    await customer(ws, 'missing');
    await host(ws, 'warm-2');
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET authority = NULL,
      authority_revision = authority_revision + 1 WHERE organization_id = ${organization(ws, 'missing')}::uuid`;
    await expect(admitHostedLifecycleJob(input(ws, 'missing'))).rejects.toThrow('entitlement_authority_missing');
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${ws} AND id = 'missing'`;
    expect(bound.workspace_host_id).toBe('missing-placeholder');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('counts actual selected VM size rather than its lower requested minimum and rolls back on quota rejection', async () => {
    const ws = fresh();
    await customer(ws, 'larger');
    await host(ws, 'warm');
    await allowance(organization(ws, 'larger'), { 'pool.cpu-millicores': 2000 });
    await expect(admitHostedLifecycleJob(input(ws, 'larger'))).rejects.toThrow('quota_exceeded:pool.cpu-millicores');
    expect(await operations(ws)).toHaveLength(0);
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${ws} AND id = 'larger'`;
    expect(bound.workspace_host_id).toBe('larger-placeholder');
  });

  it('refuses authority that expires while pooled admission waits for the organization lock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
    let admission!: Promise<{ error?: unknown }>;
    const ws = fresh();
    try {
      await customer(ws, 'expiry');
      await host(ws, 'warm');
      const org = organization(ws, 'expiry');
      await allowance(org, {}, 1000000, '2026-10-16T08:00:01Z');
      await db.adminSql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-entitlement:organization:${org}`}, 0))`;
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        admission = admitHostedLifecycleJob(input(ws, 'expiry')).then(() => ({}), error => ({ error }));
        await expect.poll(async () => {
          const [row] = await db.adminSql`SELECT EXISTS (
            SELECT 1 FROM pg_locks waiting JOIN pg_locks held
              ON held.locktype = waiting.locktype AND held.classid = waiting.classid AND held.objid = waiting.objid
             WHERE held.pid = ${pid} AND held.granted AND NOT waiting.granted) AS blocked`;
          return row.blocked;
        }).toBe(true);
        vi.setSystemTime(new Date('2026-10-16T08:00:01Z'));
      });
      expect((await admission).error).toBeInstanceOf(Error);
      expect(String((await admission).error)).toContain('hosted_pool_entitlement_no_active_assignment');
      expect(await operations(ws)).toHaveLength(0);
      const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces
        WHERE workspace_id = ${ws} AND id = 'expiry'`;
      expect(bound.workspace_host_id).toBe('expiry-placeholder');
    } finally {
      await admission;
      vi.useRealTimers();
    }
  });

  it('counts pending capacity across a deleted directory and its replacement before either VM exists', async () => {
    const ws = fresh();
    const org = randomUUID();
    await customer(ws, 'one', undefined, org);
    await allowance(org, { 'pool.hosts': 1 });
    await admitHostedLifecycleJob({ ...input(ws, 'one'), action: 'provision' });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now() WHERE workspace_id = ${ws} AND id = 'one'`;
    await customer(ws, 'two', undefined, org);
    await expect(admitHostedLifecycleJob({ ...input(ws, 'two'), action: 'provision' }))
      .rejects.toThrow('quota_exceeded:pool.hosts');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('applies changed authority and organization-wide committed budgets without deleting retained work', async () => {
    const ws = fresh();
    const org = randomUUID();
    await customer(ws, 'one', undefined, org);
    await allowance(org, {}, 150);
    await admitHostedLifecycleJob({ ...input(ws, 'one'), action: 'provision' });
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now() WHERE workspace_id = ${ws} AND id = 'one'`;
    await customer(ws, 'two', undefined, org);
    await expect(admitHostedLifecycleJob({ ...input(ws, 'two'), action: 'provision' })).rejects.toThrow('budget_exceeded');
    await allowance(org, {}, 1000);
    const admitted = await admitHostedLifecycleJob({ ...input(ws, 'two'), action: 'provision' });
    expect(admitted.resourceAdmission).toMatchObject({ authorityRevision: 3,
      pending: { hosts: 1, cpuMillicores: 2000, memoryMiB: 4096 },
      budget: { committedMinor: 100, requestedMinor: 100 } });
    expect(await operations(ws)).toHaveLength(2);
    expect(await db.adminSql`SELECT id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws}`).toHaveLength(2);
  });

  it('reads the durable tenant from the exact persisted host binding under workspace RLS', async () => {
    const ws = fresh();
    const foreignWs = fresh();
    await customer(ws, 'customer-1', 'same-host-name');
    await customer(foreignWs, 'customer-2', 'same-host-name');
    await expect(readWorkspaceHostDestroyTarget(ws, 'same-host-name')).resolves.toMatchObject({
      id: 'same-host-name', hostedCustomerWorkspaceId: 'customer-1',
    });
    await expect(readWorkspaceHostDestroyTarget(foreignWs, 'same-host-name')).resolves.toMatchObject({
      id: 'same-host-name', hostedCustomerWorkspaceId: 'customer-2',
    });
  });

  it('round-trips provider allocation identity through durable checkpoints and a later operation target read', async () => {
    const ws = fresh();
    await customer(ws, 'allocation', 'owned');
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, 'allocation-operation', 'owned', 'provision', 'running')`;
    const resource = { target: 'gcp', kind: 'disk', providerId: 'reusable-name', parentProviderId: 'pool-project',
      zone: 'us-central1-a', incarnationId: '1234567890123456789' };
    const checkpoint = { logicalKey: 'create-data-disk', state: 'applied' as const, attempts: 1, providerResource: resource };
    await upsertWorkspaceHostResourceCheckpoint({ workspaceId: ws, hostId: 'owned', operationId: 'allocation-operation', checkpoint });
    expect((await readWorkspaceHostResourceCheckpoints(ws, 'owned', 'allocation-operation'))[0]?.providerResource).toEqual(resource);
    expect((await readWorkspaceHostDestroyTarget(ws, 'owned'))?.resources[0]?.resource).toEqual(resource);
    // A changed allocation replaces the old identity; missing identity remains unknown.
    await upsertWorkspaceHostResourceCheckpoint({ workspaceId: ws, hostId: 'owned', operationId: 'allocation-operation',
      checkpoint: { ...checkpoint, providerResource: { ...resource, incarnationId: '9876543210' } } });
    expect((await readWorkspaceHostDestroyTarget(ws, 'owned'))?.resources[0]?.resource.incarnationId).toBe('9876543210');
    const { incarnationId: _removed, ...unknownAllocation } = resource;
    await upsertWorkspaceHostResourceCheckpoint({ workspaceId: ws, hostId: 'owned', operationId: 'allocation-operation',
      checkpoint: { ...checkpoint, providerResource: unknownAllocation } });
    expect((await readWorkspaceHostResourceCheckpoints(ws, 'owned', 'allocation-operation'))[0]?.providerResource).not.toHaveProperty('incarnationId');
    expect((await readWorkspaceHostDestroyTarget(ws, 'owned'))?.resources[0]?.resource).not.toHaveProperty('incarnationId');
  });

  it('reserves and binds once on concurrent duplicate wake, even with tenant cap one', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    const request = input(ws, 'a');
    const results = await Promise.all([admitHostedLifecycleJob(request), admitHostedLifecycleJob(request)]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ hostId: 'warm', placement: expect.objectContaining({ kind: 'assign-warm' }) })]));
    expect(await operations(ws)).toHaveLength(1);
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws} AND id = 'a'`;
    expect(bound.workspace_host_id).toBe('warm');
  });

  it('reserves a fresh provision on its placeholder and replays before quota checks', async () => {
    const ws = fresh();
    const hostId = await customer(ws, 'new');
    const request = { ...input(ws, 'new'), action: 'provision' as const };
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt).toMatchObject({ created: true, hostId, placement: { kind: 'provision' } });
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
    expect(await operations(ws)).toHaveLength(1);
    await expect(admitHostedLifecycleJob({ ...request, operationId: 'second-provision' }))
      .rejects.toThrow('tenant concurrency limit reached');
  });

  it('protects paid warm capacity from an earlier burst customer and records server priority', async () => {
    const ws = fresh();
    await customer(ws, 'burst');
    await customer(ws, 'paid');
    await allowance(organization(ws, 'paid'), { 'pool.reserved-hosts': 1 });
    await host(ws, 'warm');
    const forged = input(ws, 'burst');
    Object.assign(forged.pool!, { guaranteed: true, reservedForOtherCustomers: 0, olderBurstWaiters: 0 });
    await expect(admitHostedLifecycleJob(forged)).rejects.toThrow('pool capacity reserved or exhausted');
    expect(await operations(ws)).toHaveLength(0);
    const paid = input(ws, 'paid');
    const receipt = await admitHostedLifecycleJob(paid);
    expect(receipt.resourceAdmission).toMatchObject({ priority: { guaranteed: true,
      freeHosts: 1, reservedForOtherCustomers: 0, olderBurstWaiters: 1, requestedWarmHosts: 1 } });
    expect(receipt.placement).toMatchObject({ kind: 'assign-warm', hostId: 'warm' });
    expect(await admitHostedLifecycleJob(paid)).toEqual({ ...receipt, created: false });
  });

  it('orders unreserved warm demand by persisted customer creation, independent of arrival at admission', async () => {
    const ws = fresh();
    await customer(ws, 'older');
    await customer(ws, 'newer');
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET created_at = now() - interval '1 hour'
      WHERE workspace_id = ${ws} AND id = 'older'`;
    await host(ws, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'newer'))).rejects.toThrow('older pool burst requests have priority');
    expect(await operations(ws)).toHaveLength(0);
    await expect(admitHostedLifecycleJob(input(ws, 'older'))).resolves.toMatchObject({
      placement: { kind: 'assign-warm', hostId: 'warm' },
      resourceAdmission: { priority: { guaranteed: false, olderBurstWaiters: 0 } },
    });
  });

  it('releases expired paid priority and applies downgrade without a phantom burst waiter', async () => {
    const ws = fresh();
    await customer(ws, 'expired');
    await customer(ws, 'newer');
    await allowance(organization(ws, 'expired'), { 'pool.reserved-hosts': 1 }, 1000000, '2026-01-02T00:00:00Z');
    await host(ws, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'newer'))).resolves.toMatchObject({
      placement: { kind: 'assign-warm' }, resourceAdmission: { priority: { reservedForOtherCustomers: 0, olderBurstWaiters: 0 } },
    });
    const next = fresh();
    await customer(next, 'burst');
    await customer(next, 'paid');
    const paidOrg = organization(next, 'paid');
    await allowance(paidOrg, { 'pool.reserved-hosts': 1 });
    await host(next, 'warm');
    await expect(admitHostedLifecycleJob(input(next, 'burst'))).rejects.toThrow('pool capacity reserved or exhausted');
    await allowance(paidOrg, { 'pool.reserved-hosts': 0 });
    await expect(admitHostedLifecycleJob(input(next, 'burst'))).resolves.toMatchObject({
      resourceAdmission: { priority: { guaranteed: false, reservedForOtherCustomers: 0 } },
    });
  });

  it('consumes paid reservation once per pending host and ignores failed attempts as FIFO demand', async () => {
    const ws = fresh();
    await customer(ws, 'paid');
    await customer(ws, 'burst');
    await allowance(organization(ws, 'paid'), { 'pool.reserved-hosts': 1 });
    await host(ws, 'warm-a');
    await host(ws, 'warm-b');
    await admitHostedLifecycleJob(input(ws, 'paid'));
    await expect(admitHostedLifecycleJob(input(ws, 'burst'))).resolves.toMatchObject({
      resourceAdmission: { priority: { freeHosts: 1, reservedForOtherCustomers: 0, olderBurstWaiters: 0 } },
    });
    const failed = fresh();
    await customer(failed, 'failed');
    await customer(failed, 'newer');
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations
      (workspace_id, id, host_id, action, status, organization_id, customer_workspace_id, provider_target)
      VALUES (${failed}, 'old-failure', 'failed-placeholder', 'provision', 'failed',
        ${organization(failed, 'failed')}, 'failed', 'gcp')`;
    await host(failed, 'warm');
    await expect(admitHostedLifecycleJob(input(failed, 'newer'))).resolves.toMatchObject({
      resourceAdmission: { priority: { olderBurstWaiters: 0 } },
    });
  });

  it('admits one of two paid guarantees when the compatible warm pool is short', async () => {
    const ws = fresh();
    await customer(ws, 'paid-a');
    await customer(ws, 'paid-b');
    await allowance(organization(ws, 'paid-a'), { 'pool.reserved-hosts': 1 });
    await allowance(organization(ws, 'paid-b'), { 'pool.reserved-hosts': 1 });
    await host(ws, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'paid-b'))).resolves.toMatchObject({
      placement: { kind: 'assign-warm' }, resourceAdmission: { priority: { guaranteed: true, reservedForOtherCustomers: 1 } },
    });
    await expect(admitHostedLifecycleJob(input(ws, 'paid-a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    expect(await operations(ws)).toHaveLength(1);
  });

  it('provisions against resource allowance without requiring or consuming a warm VM', async () => {
    const ws = fresh();
    await customer(ws, 'tenant');
    await expect(admitHostedLifecycleJob({ ...input(ws, 'tenant'), action: 'provision' })).resolves.toMatchObject({
      placement: { kind: 'provision' }, resourceAdmission: { priority: { freeHosts: 0, requestedWarmHosts: 0 } },
    });
  });

  it('excludes exhausted allowances and incompatible pool placeholders from priority', async () => {
    const ws = fresh();
    await customer(ws, 'exhausted');
    await customer(ws, 'other-pool');
    await customer(ws, 'eligible');
    await allowance(organization(ws, 'exhausted'), { 'pool.hosts': 0, 'pool.reserved-hosts': 1 });
    await allowance(organization(ws, 'other-pool'), { 'pool.reserved-hosts': 1 });
    await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET desired_spec = jsonb_set(desired_spec, '{zone}', '"us-central1-b"'::jsonb)
      WHERE workspace_id = ${ws} AND id = 'other-pool-placeholder'`;
    await host(ws, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'eligible'))).resolves.toMatchObject({
      resourceAdmission: { priority: { reservedForOtherCustomers: 0, olderBurstWaiters: 0 } },
    });
  });

  it('uses stable customer id ordering when demand timestamps are equal', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET created_at = '2026-01-02T00:00:00Z'
      WHERE workspace_id = ${ws}`;
    await host(ws, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'b'))).rejects.toThrow('older pool burst requests have priority');
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).resolves.toMatchObject({ placement: { kind: 'assign-warm' } });
  });

  it('lets exactly one of two customers reserve the last warm VM', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await host(ws, 'warm');
    const results = await Promise.allSettled([admitHostedLifecycleJob(input(ws, 'a')), admitHostedLifecycleJob(input(ws, 'b'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    if (refused.reason instanceof HostedLifecyclePlacementError) {
      expect(refused.reason.placement.kind).toBe('queue');
    } else {
      expect(refused.reason.message).toContain('older pool burst requests have priority');
    }
    expect(await operations(ws)).toHaveLength(1);
  });

  it('hands the same admission row to its fenced controller without losing the receipt or charging twice', async () => {
    const ws = fresh();
    await customer(ws, 'handoff');
    await host(ws, 'warm');
    const request = { ...input(ws, 'handoff'), action: 'provision' as const,
      request: { hostId: 'warm', action: 'start' } };
    const receipt = await admitHostedLifecycleJob(request);
    expect(receipt).toMatchObject({ action: 'start', hostId: 'warm' });
    const controller = {
      workspaceId: ws, operationId: receipt.operationId, hostId: receipt.hostId,
      action: 'start' as const, status: 'running' as const, desiredRevision: 2,
      request: { sourceHostId: 'warm', plan: { id: 'controller-resolved-plan' } },
      controllerAuthority: { controllerId: 'controller-a', fence: 7 },
      hostedAdmission: { customerWorkspaceId: 'handoff', actorId: request.actorId, request: request.request },
    };
    await expect(beginWorkspaceHostOperation({ ...controller,
      hostedAdmission: { ...controller.hostedAdmission, actorId: 'other-user' } })).rejects.toThrow('different');
    await beginWorkspaceHostOperation(controller);
    await beginWorkspaceHostOperation(controller);
    const [row] = await db.adminSql`SELECT status, controller_id, admission_receipt, estimated_cost_cents FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    expect(row).toMatchObject({ status: 'running', controller_id: 'controller-a', estimated_cost_cents: 100 });
    expect(row.admission_receipt.result).toEqual(receipt);
    expect(await operations(ws)).toHaveLength(1);
    expect(await admitHostedLifecycleJob(request)).toEqual({ ...receipt, created: false });
  });

  it.each(['succeeded', 'failed'])('never reassigns a previously admitted VM after its binding moves (%s)', async status => {
    const ws = fresh();
    await customer(ws, 'previous');
    await customer(ws, 'next');
    await host(ws, 'warm');
    await admitHostedLifecycleJob(input(ws, 'previous'));
    await db.adminSql`
      UPDATE harness_shared.workspace_host_operations SET status = ${status}, customer_workspace_id = NULL
       WHERE workspace_id = ${ws} AND id = 'op-previous'`;
    // Replacement moves the directory pointer; the old VM may still carry the
    // previous tenant's IAM/credentials/routes even with no registered data disk.
    await db.adminSql`
      UPDATE harness_shared.customer_workspaces SET workspace_host_id = 'previous-placeholder'
       WHERE workspace_id = ${ws} AND id = 'previous'`;
    const [unchangedHost] = await db.adminSql`
      SELECT host_generation, controller_fence, pool_observation->>'cleanAttestationRef' AS clean_ref
        FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} AND id = 'warm'`;
    expect(unchangedHost).toMatchObject({ host_generation: 1, controller_fence: 7,
      clean_ref: 'provider:verified-empty-generation-1' });
    await expect(admitHostedLifecycleJob(input(ws, 'next'))).rejects.toMatchObject({
      placement: { kind: 'queue', rejected: expect.arrayContaining([
        expect.objectContaining({ hostId: 'warm', reasons: expect.arrayContaining(['unclean']) }),
      ]) },
    });
    expect(await operations(ws)).toHaveLength(1);
    const [next] = await db.adminSql`
      SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws} AND id = 'next'`;
    expect(next.workspace_host_id).toBe('next-placeholder');
  });

  it.each(['initialize', 'restore', 'upgrade', 'repair'])('does not treat an unbound %s guest as clean warm capacity', async action => {
    const ws = fresh();
    await customer(ws, 'next');
    await host(ws, 'used');
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, 'old-guest-operation', 'used', ${action}, 'failed')`;
    await expect(admitHostedLifecycleJob(input(ws, 'next'))).rejects.toMatchObject({
      placement: { kind: 'queue', rejected: expect.arrayContaining([
        expect.objectContaining({ hostId: 'used', reasons: expect.arrayContaining(['unclean']) }),
      ]) },
    });
    expect(await operations(ws)).toHaveLength(1);
  });

  it('still assigns a clean never-assigned VM with only its fresh provision operation', async () => {
    const ws = fresh();
    await customer(ws, 'next');
    await host(ws, 'fresh-warm');
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, 'fresh-provision', 'fresh-warm', 'provision', 'succeeded')`;
    await expect(admitHostedLifecycleJob(input(ws, 'next'))).resolves.toMatchObject({
      placement: { kind: 'assign-warm', hostId: 'fresh-warm' },
    });
  });

  it.each(['generation', 'desired-revision'])('refuses controller handoff after the reserved host %s changes', async kind => {
    const ws = fresh();
    await customer(ws, 'stale');
    await host(ws, 'warm');
    const request = { ...input(ws, 'stale'), request: { hostId: 'warm', action: 'start' } };
    const receipt = await admitHostedLifecycleJob(request);
    if (kind === 'generation') await db.adminSql`UPDATE harness_shared.workspace_hosts SET host_generation = 2 WHERE workspace_id = ${ws} AND id = 'warm'`;
    else await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_revision = 2 WHERE workspace_id = ${ws} AND id = 'warm'`;
    await expect(beginWorkspaceHostOperation({
      workspaceId: ws, operationId: receipt.operationId, hostId: receipt.hostId,
      action: 'start', status: 'running', desiredRevision: 2, request: { plan: 'resolved' },
      controllerAuthority: { controllerId: 'controller-a', fence: 7 },
      hostedAdmission: { customerWorkspaceId: 'stale', actorId: request.actorId, request: request.request },
    })).rejects.toThrow('stale');
    const [row] = await db.adminSql`SELECT status, controller_id FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    expect(row).toEqual({ status: 'queued', controller_id: null });
  });

  it('completes a running customer VM reuse without acquiring a provider controller, and refuses stale replay', async () => {
    const ws = fresh();
    await customer(ws, 'reuse', 'owned');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running', pool_observation = ${JSON.stringify(observation())}::jsonb, health_status = 'healthy', health_attested_at = now() WHERE workspace_id = ${ws} AND id = 'owned'`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status) VALUES (${ws}, 'prior', 'owned', 'provision', 'succeeded')`;
    await pinDiskAllocation(ws, 'prior');
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id) VALUES (${ws}, 'owned', 'create-data-disk', 'prior', 'applied', 'disk', 'volume-reuse')`;
    const receipt = await admitHostedLifecycleJob(input(ws, 'reuse', 'owned'));
    expect(receipt).toMatchObject({ placement: { kind: 'reuse' }, hostDesiredRevision: 1 });
    await completeHostedPoolReuse(ws, receipt);
    await completeHostedPoolReuse(ws, receipt);
    const [row] = await db.adminSql`SELECT status, controller_id FROM harness_shared.workspace_host_operations WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    expect(row).toEqual({ status: 'succeeded', controller_id: null });
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_revision = 2, observed_revision = 2 WHERE workspace_id = ${ws} AND id = 'owned'`;
    await expect(completeHostedPoolReuse(ws, receipt)).rejects.toThrow('fenced_or_stale');
  });

  async function stoppedOwner(ws: string, customerId = 'sleeper', hostId = 'owned', organizationId = randomUUID(), pinnedStorage = true) {
    const priorId = customerId === 'sleeper' ? 'prior' : `prior-${customerId}`;
    const volumeId = `volume-${customerId}`;
    await customer(ws, customerId, hostId, organizationId);
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_state = 'stopped', observed_state = 'stopped',
      pool_observation = ${JSON.stringify(observation())}::jsonb, health_status = NULL, health_attested_at = NULL
      WHERE workspace_id = ${ws} AND id = ${hostId}`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status)
      VALUES (${ws}, ${priorId}, ${hostId}, 'provision', 'succeeded')`;
    if (pinnedStorage) await pinDiskAllocation(ws, priorId);
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources
      (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id)
      VALUES (${ws}, ${hostId}, 'create-data-disk', ${priorId}, 'applied', 'disk', ${volumeId})`;
    return observation({ observedAtMs: Date.now(), cleanAttestationRef: null,
      stoppedOwner: { customerWorkspaceId: customerId, dataVolumeId: volumeId } });
  }

  it('retains the original disk allocation on stopped wake after downgrade and refuses unpinned legacy disks', async () => {
    const ws = fresh();
    const proof = await stoppedOwner(ws);
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
    await allowance(organization(ws, 'sleeper'), { 'pool.db-gib': 0, 'pool.workspace-gib': 0 });
    const receipt = await admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'));
    expect(receipt.resourceAdmission).toMatchObject({ storage: { allocated: { dbGiB: 256, workspaceGiB: 0 },
      pending: { dbGiB: 0, workspaceGiB: 0 }, requested: { dbGiB: 0, workspaceGiB: 0 },
      capacity: { dbGiB: 256, workspaceGiB: 0 } } });
    const legacy = fresh();
    const legacyProof = await stoppedOwner(legacy, 'sleeper', 'owned', randomUUID(), false);
    await recordHostedPoolObservation({ workspaceId: legacy, hostId: 'owned', controllerId: 'controller-a', observation: legacyProof });
    await expect(admitHostedLifecycleJob(input(legacy, 'sleeper', 'owned')))
      .rejects.toThrow('storage_allocation_invalid');
    expect(await operations(legacy)).toHaveLength(1);
  });

  it.each(['pool.cpu-millicores', 'pool.memory-mib'] as const)(
    'reserves %s for a pending stopped-owner start across directory replacement', async quota => {
      const ws = fresh();
      const org = randomUUID();
      const proof = await stoppedOwner(ws, 'sleeper', 'owned', org);
      await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
      await allowance(org, { [quota]: quota === 'pool.cpu-millicores' ? 4000 : 8192 });
      const wake = await admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'));
      expect(wake.resourceAdmission).toMatchObject({
        allocated: { hosts: 1, cpuMillicores: 0, memoryMiB: 0 },
        requested: { hosts: 0, cpuMillicores: 4000, memoryMiB: 8192 },
      });
      await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
        WHERE workspace_id = ${ws} AND id = 'sleeper'`;
      await customer(ws, 'replacement', undefined, org);
      await expect(admitHostedLifecycleJob({ ...input(ws, 'replacement'), action: 'provision' }))
        .rejects.toThrow(`quota_exceeded:${quota}`);
      expect((await operations(ws)).filter(row => row.id.startsWith('op-'))).toHaveLength(1);
    });

  it('moves a stopped-owner start from pending to allocated compute without double charging', async () => {
    const ws = fresh();
    const org = randomUUID();
    const proof = await stoppedOwner(ws, 'sleeper', 'owned', org);
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
    await allowance(org, { 'pool.cpu-millicores': 6000, 'pool.memory-mib': 12288 });
    await admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'));
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${ws} AND id = 'sleeper'`;
    await customer(ws, 'replacement', undefined, org);
    const replacement = { ...input(ws, 'replacement'), action: 'provision' as const };
    const receipt = await admitHostedLifecycleJob(replacement);
    expect(receipt.resourceAdmission).toMatchObject({
      allocated: { hosts: 1, cpuMillicores: 0, memoryMiB: 0 },
      pending: { hosts: 0, cpuMillicores: 4000, memoryMiB: 8192 },
    });
    // Release the second reservation, then observe the first actual VM starting.
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'failed'
      WHERE workspace_id = ${ws} AND id = ${receipt.operationId}`;
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running'
      WHERE workspace_id = ${ws} AND id = 'owned'`;
    const running = await admitHostedLifecycleJob({ ...replacement, operationId: 'replacement-after-running' });
    expect(running.resourceAdmission).toMatchObject({
      allocated: { hosts: 1, cpuMillicores: 4000, memoryMiB: 8192 },
      pending: { hosts: 0, cpuMillicores: 0, memoryMiB: 0 },
    });
  });

  it('queues a normally stopped owner until measured proof exists, then reserves exactly one same-data wake', async () => {
    const ws = fresh();
    const proof = await stoppedOwner(ws);
    await host(ws, 'spare');
    const request = input(ws, 'sleeper', 'owned');
    await expect(admitHostedLifecycleJob(request)).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
    const results = await Promise.all([admitHostedLifecycleJob(request), admitHostedLifecycleJob(request)]);
    expect(results.map(value => value.created).sort()).toEqual([false, true]);
    expect(results[0]).toMatchObject({ hostId: 'owned', placement: { kind: 'start' } });
    expect((await operations(ws)).filter(value => value.id !== 'prior')).toHaveLength(1);
  });

  it.each(['unhealthy', 'foreign-customer', 'wrong-disk', 'running', 'new-fence', 'reserved'])(
    'rejects stopped proof after %s changes before record', async change => {
      const ws = fresh();
      const proof = await stoppedOwner(ws);
      if (change === 'unhealthy') await db.adminSql`UPDATE harness_shared.workspace_hosts SET health_status = 'degraded' WHERE workspace_id = ${ws}`;
      if (change === 'foreign-customer') proof.stoppedOwner!.customerWorkspaceId = 'foreign';
      if (change === 'wrong-disk') proof.stoppedOwner!.dataVolumeId = 'foreign-disk';
      if (change === 'running') await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_state = 'running', observed_state = 'running' WHERE workspace_id = ${ws}`;
      if (change === 'new-fence') await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_fence = 8 WHERE workspace_id = ${ws}`;
      if (change === 'reserved') await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status) VALUES (${ws}, 'competing', 'owned', 'start', 'queued')`;
      await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof }))
        .rejects.toThrow('fenced_or_stale');
    });

  it('does not use stopped proof after its timestamp, disk, controller fence or observed state changes', async () => {
    for (const change of ['stale', 'disk', 'fence', 'running', 'unhealthy']) {
      const ws = fresh();
      const proof = await stoppedOwner(ws);
      await recordHostedPoolObservation({ workspaceId: ws, hostId: 'owned', controllerId: 'controller-a', observation: proof });
      if (change === 'stale') await db.adminSql`UPDATE harness_shared.workspace_hosts SET pool_observation = jsonb_set(pool_observation, '{observedAtMs}', '1'::jsonb) WHERE workspace_id = ${ws}`;
      if (change === 'disk') await db.adminSql`UPDATE harness_shared.workspace_host_resources SET provider_id = 'other' WHERE workspace_id = ${ws}`;
      if (change === 'fence') await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_fence = 8 WHERE workspace_id = ${ws}`;
      if (change === 'running') await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running' WHERE workspace_id = ${ws}`;
      if (change === 'unhealthy') await db.adminSql`UPDATE harness_shared.workspace_hosts SET health_status = 'degraded' WHERE workspace_id = ${ws}`;
      await expect(admitHostedLifecycleJob(input(ws, 'sleeper', 'owned'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    }
  });

  it('rejects a changed input reusing an operation id without charging or rebinding', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    const request = input(ws, 'a');
    await admitHostedLifecycleJob(request);
    await expect(admitHostedLifecycleJob({ ...request, actorId: 'different-actor' })).rejects.toThrow('hosted_lifecycle_operation_conflict');
    expect(await operations(ws)).toHaveLength(1);
  });

  it('reserves a volume for only one customer even when another warm VM remains', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await host(ws, 'warm-1');
    await host(ws, 'warm-2');
    const first = input(ws, 'a');
    const second = input(ws, 'b');
    second.pool!.dataVolumeId = first.pool!.dataVolumeId;
    const results = await Promise.allSettled([admitHostedLifecycleJob(first), admitHostedLifecycleJob(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await operations(ws)).toHaveLength(1);
  });

  it('fails budget admission before changing a tenant binding or reserving a VM', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    const request = input(ws, 'a');
    request.estimate.cents = 10001;
    await expect(admitHostedLifecycleJob(request)).rejects.toThrow('admission rejected');
    expect(await operations(ws)).toHaveLength(0);
    const [bound] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${ws} AND id = 'a'`;
    expect(bound.workspace_host_id).toBe('a-placeholder');
  });

  it('cannot reuse capacity observed before a desired-revision change', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await host(ws, 'warm');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET desired_revision = 2 WHERE workspace_id = ${ws} AND id = 'warm'`;
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'controller-a', observation: observation({ desiredRevision: 2 }) })).rejects.toThrow('fenced_or_stale');
    expect(await operations(ws)).toHaveLength(0);
  });

  it('queues an unhealthy existing data owner instead of routing around it to a warm VM', async () => {
    const ws = fresh();
    await customer(ws, 'a', 'owned');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running', pool_observation = ${JSON.stringify(observation())}::jsonb, health_status = 'degraded', health_attested_at = now() WHERE workspace_id = ${ws} AND id = 'owned'`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_operations (workspace_id, id, host_id, action, status) VALUES (${ws}, 'prior', 'owned', 'provision', 'succeeded')`;
    await db.adminSql`INSERT INTO harness_shared.workspace_host_resources (workspace_id, host_id, logical_key, operation_id, state, kind, provider_id) VALUES (${ws}, 'owned', 'create-data-disk', 'prior', 'applied', 'disk', 'volume-a')`;
    await host(ws, 'warm');
    try { await admitHostedLifecycleJob(input(ws, 'a', 'owned')); throw new Error('unexpected admission'); }
    catch (error) {
      expect(error).toBeInstanceOf(HostedLifecyclePlacementError);
      expect((error as InstanceType<typeof HostedLifecyclePlacementError>).placement).toMatchObject({ kind: 'queue', reason: 'existing-tenant-needs-reconciliation' });
    }
    expect((await operations(ws)).map((row) => row.id)).toEqual(['prior']);
  });

  it('does not reserve a host from another RLS workspace', async () => {
    const ws = fresh();
    const foreign = fresh();
    await customer(ws, 'a');
    await host(foreign, 'warm');
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    expect(await operations(ws)).toHaveLength(0);
    const visible = await db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return tx`SELECT id FROM harness_shared.workspace_hosts WHERE workspace_id = ${foreign}`;
    });
    expect(visible).toHaveLength(0);
  });

  it('keeps pool evidence controller-only and preserves same-control-plane tenant RLS', async () => {
    const ws = fresh();
    await customer(ws, 'a');
    await customer(ws, 'b');
    await host(ws, 'warm');
    await host(ws, 'unassigned');
    await admitHostedLifecycleJob(input(ws, 'a'));
    const asCustomer = <T>(run: (tx: any) => Promise<T>) => db.adminSql.begin(async (tx: any) => {
      await tx`SET LOCAL ROLE hosted_app`;
      await tx`SELECT set_config('app.organization_id', ${organization(ws, 'a')}, true), set_config('app.workspace_id', 'a', true)`;
      return run(tx);
    });
    const visible = await asCustomer((tx) => tx`SELECT id FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} ORDER BY id`) as Array<{ id: string }>;
    // Stable-id tie breaking chooses 'unassigned'; the customer sees only that binding.
    expect(visible.map((row) => row.id)).toEqual(['unassigned']);
    await expect(asCustomer((tx) => tx`UPDATE harness_shared.workspace_hosts SET pool_observation = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'unassigned'`)).rejects.toThrow('controller_evidence_required');
    await expect(asCustomer((tx) => tx`UPDATE harness_shared.workspace_host_operations SET admission_receipt = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'op-a'`)).rejects.toThrow('controller_evidence_required');
    const foreign = await asCustomer((tx) => tx`UPDATE harness_shared.workspace_hosts SET pool_observation = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'b-placeholder' RETURNING id`);
    expect(foreign).toEqual([]);
    await expect(db.adminSql`UPDATE harness_shared.workspace_host_operations SET admission_receipt = '{}'::jsonb WHERE workspace_id = ${ws} AND id = 'op-a'`).rejects.toThrow('receipt_immutable');
  });

  it('fences stale controller observations and accepts only a newer matching observation', async () => {
    const ws = fresh();
    await host(ws, 'warm');
    const o = observation({ observedAtMs: Date.now() - 10 });
    await recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'controller-a', observation: o });
    await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'controller-a', observation: o })).rejects.toThrow('fenced_or_stale');
    await expect(recordHostedPoolObservation({ workspaceId: ws, hostId: 'warm', controllerId: 'old-controller', observation: { ...o, observedAtMs: Date.now() } })).rejects.toThrow('fenced_or_stale');
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET controller_fence = 8 WHERE workspace_id = ${ws} AND id = 'warm'`;
    await customer(ws, 'a');
    await expect(admitHostedLifecycleJob(input(ws, 'a'))).rejects.toBeInstanceOf(HostedLifecyclePlacementError);
    expect(await operations(ws)).toHaveLength(0);
  });
});

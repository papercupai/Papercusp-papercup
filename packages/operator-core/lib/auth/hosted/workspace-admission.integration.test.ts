/**
 * Hosted workspace admission against real Postgres and real workspace RLS.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM `workspace-admission.test.ts`. That suite injects
 * every effect and proves the ADMISSION ORDERING in isolation. It therefore cannot fail if
 * the database refuses the writes — which is exactly the failure this subsystem was born
 * from: `harness_app` held no GRANT on `harness_shared.customer_workspaces` at all, so a
 * perfectly-ordered admission would have died at the first INSERT (D-383, migration 1193).
 *
 * `OrgTestDb.appSql` is the `harness_app` role and is RLS-SUBJECT, so every statement below
 * travels the same privilege path production does. Delete migration 1193 and this file fails
 * with `permission denied for table customer_workspaces`; that is the point of it.
 *
 * The provider/DBOS boundary stays fake: this proves store ordering, idempotency and tenant
 * isolation, not that a cloud VM boots.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { DefaultHostedWorkspaceAdmissionOptions } from './workspace-admission-dependencies';

const h = vi.hoisted(() => ({
  appSql: null as any,
  controlPlaneWorkspaceId: '',
  startProvisioning: null as any,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => h.controlPlaneWorkspaceId,
}));
vi.mock('../../dbos/workspace-host-provision-workflow', () => ({
  startWorkspaceHostProvisioningWorkflow: (input: unknown) => h.startProvisioning(input),
  startWorkspaceHostLifecycleWorkflow: vi.fn(),
}));

const { createHostedWorkspaceAdmission, admissionIdentity, HostedWorkspaceAdmissionError } =
  await import('./workspace-admission');
const { createDefaultHostedWorkspaceAdmissionDependencies } = await import(
  './workspace-admission-dependencies'
);
const { upsertWorkspaceHostConnection, upsertWorkspaceHost } = await import('../../workspace-host/observability-store');
const {
  activateHostedCustomerWorkspace,
  retireHostedCustomerWorkspaceAfterDestroy,
} = await import('../../workspace-host/hosted-bring-up');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { writeHostedEntitlementAuthority } = await import('../hosted-entitlement-store');

const CONNECTION_ID = 'conn-hosted-admission';

function desiredSpecFor(hostId: string): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'project-hosted' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-small',
    image: { id: 'projects/images/global/images/papercusp-v1' },
    data: { volumeGiB: 20, allocation: { dbGiB: 20, workspaceGiB: 0 }, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' } },
    provider: { network: { mode: 'managed', networkName: `${hostId}-network` } },
  };
}

describe('hosted workspace admission (real Postgres, real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** A fresh control-plane workspace + seeded connection per case, so cases cannot alias. */
  async function freshControlPlane(): Promise<string> {
    const workspaceId = `hosted_admission_ws_${randomBytes(4).toString('hex')}`;
    h.controlPlaneWorkspaceId = workspaceId;
    // workspace_hosts FKs (workspace_id, connection_id), so the connection must exist
    // before any host row can be admitted.
    await upsertWorkspaceHostConnection({
      workspaceId,
      id: CONNECTION_ID,
      target: 'gcp',
      label: 'integration connection',
      credentialRef: 'adc://integration-test',
      status: 'connected',
    });
    return workspaceId;
  }

  function admissionFor(
    specHostId?: (derivedHostId: string) => string,
    options: Omit<DefaultHostedWorkspaceAdmissionOptions, 'resolveDesiredSpec'> = {},
  ) {
    const started: unknown[] = [];
    h.startProvisioning = async (input: unknown) => {
      started.push(input);
      return { status: 'accepted' as const };
    };
    const port = createHostedWorkspaceAdmission(
      createDefaultHostedWorkspaceAdmissionDependencies({
        resolveDesiredSpec: async ({ hostId }) =>
          desiredSpecFor(specHostId ? specHostId(hostId) : hostId),
        ...options,
      }),
    );
    return { port, started };
  }

  async function poolAuthority() {
    const organizationId = randomUUID();
    const userId = randomUUID();
    await db.adminSql`INSERT INTO papercusp_auth.hosted_entitlements (organization_id, user_id, kind, source)
      VALUES (${organizationId}::uuid, ${userId}::uuid, 'hosted-free', 'self_signup')`;
    const record = { source: 'migration', actor: { kind: 'service', principalId: 'service:admission-fixture' },
      auditReceiptId: 'audit:admission-fixture', effectiveFrom: '2026-01-01T00:00:00Z', effectiveUntil: '2099-01-01T00:00:00Z' };
    await writeHostedEntitlementAuthority({ organizationId, userId, kind: 'hosted-free', expectedRevision: 0,
      authority: { schemaVersion: 1,
        bundles: [{ schemaVersion: 1, bundleId: 'admission-fixture', bundleVersion: 1, record,
          entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
            browserAccess: { pty: true, files: true }, supportTier: 'trial', rolloutFlags: {},
            quotas: { 'pool.agents': 2, 'pool.hosts': 1, 'pool.cpu-millicores': 4000,
              'pool.memory-mib': 8192, 'pool.db-gib': 256, 'pool.workspace-gib': 0 },
            budgets: { 'pool.cost.usd.minor': 100000 } } }],
        assignments: [{ schemaVersion: 1, assignmentId: `fixture:${organizationId}`, organizationId,
          bundleId: 'admission-fixture', bundleVersion: 1,
          record: { ...record, auditReceiptId: 'audit:admission-assignment' } }], overrides: [] } },
      run => db.appSql.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        return run(tx as any);
      }) as any);
    return { organizationId, userId };
  }

  /** Provisioning is fire-and-forget; wait for the enqueue it started to land. */
  async function enqueued(started: unknown[], expectedCount = 1): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100 && started.length < expectedCount; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(started).toHaveLength(expectedCount);
    return started[0] as Record<string, unknown>;
  }

  it('repairs an enqueue lost after atomic pool admission without re-quoting or charging twice', async () => {
    const workspaceId = await freshControlPlane();
    const authority = await poolAuthority();
    const resolvePoolAdmission = vi.fn<NonNullable<DefaultHostedWorkspaceAdmissionOptions['resolvePoolAdmission']>>(async input => ({
      estimate: { cents: 100, currency: 'USD', source: 'fixture-catalog', evidenceRef: 'test://catalog', estimatedAt: '2026-10-16T00:00:00Z' },
      pool: { scope: input.desiredSpec.scope, region: input.desiredSpec.region, zone: input.desiredSpec.zone!,
        architecture: 'x86_64', runtimeBundleSha256: 'a'.repeat(64), minimum: { cpuCount: 2, memoryMiB: 4096 },
        maxObservationAgeMs: 60_000, dataVolumeId: `unprovisioned:${input.customerWorkspaceId}` },
    }));
    const startWorkflow = vi.fn<NonNullable<DefaultHostedWorkspaceAdmissionOptions['startWorkflow']>>()
      .mockRejectedValueOnce(new Error('executor unavailable')).mockResolvedValue({ workflowId: 'fixture' });
    const { port } = admissionFor(undefined, { pooled: true, resolvePoolAdmission, startWorkflow });
    const request = { ...authority, provider: 'gcp' as const,
      connectionId: CONNECTION_ID, displayName: 'Pooled trial', operationKey: 'pool-attempt' };
    await expect(port.ensureProvisioned(request)).rejects.toThrow('executor unavailable');
    const result = await port.ensureProvisioned(request);
    expect(resolvePoolAdmission).toHaveBeenCalledTimes(1);
    expect(startWorkflow).toHaveBeenCalledTimes(2);
    expect(startWorkflow.mock.calls[1]).toEqual(startWorkflow.mock.calls[0]);
    expect(startWorkflow.mock.calls[0][0]).toMatchObject({ hostedCustomerWorkspaceId: result.workspaceId, actorId: authority.userId });
    const rows = await db.adminSql`SELECT host_id, customer_workspace_id, estimated_cost_cents, admission_receipt FROM harness_shared.workspace_host_operations WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_workspace_id: result.workspaceId, estimated_cost_cents: 100,
      admission_receipt: { result: { placement: { kind: 'provision' } } } });
    await expect(port.ensureProvisioned({ ...request, userId: 'another-user' })).rejects.toThrow('operation_conflict');
    expect(startWorkflow).toHaveBeenCalledTimes(2);
  });

  it('binds the last clean warm VM and dispatches lifecycle plus bring-up, never a second provision', async () => {
    const workspaceId = await freshControlPlane();
    const authority = await poolAuthority();
    const desired = desiredSpecFor('warm-host');
    await upsertWorkspaceHost({ workspaceId, id: desired.hostId, connectionId: CONNECTION_ID, name: 'Warm',
      target: desired.target, scopeLabel: desired.scope.id, region: desired.region, size: desired.size,
      image: desired.image.id, diskGiB: desired.data.volumeGiB, network: 'default', desiredSpec: desired,
      desiredState: 'running', observedState: 'running' });
    const observation = { generation: 1, desiredRevision: 1, controllerFence: 7, scope: desired.scope,
      zone: desired.zone, architecture: 'x86_64', runtimeBundleSha256: 'a'.repeat(64),
      size: { cpuCount: 4, memoryMiB: 8192 }, observedAtMs: Date.now() - 100,
      cleanAttestationRef: 'test://verified-never-used' };
    await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET host_generation = 1, desired_revision = 1, observed_revision = 1,
          controller_id = 'controller-a', controller_fence = 7, health_status = 'healthy', health_attested_at = now(),
          pool_observation = ${JSON.stringify(observation)}::jsonb,
          runtime_release = ${JSON.stringify({ version: 'pool-v1', bundleSha256: 'a'.repeat(64),
            signingKeySha256: 'b'.repeat(64), protocolVersion: 'workspace-host-bootstrap-v1', schemaVersion: '1522' })}::jsonb
      WHERE workspace_id = ${workspaceId} AND id = 'warm-host'`;
    const startWorkflow = vi.fn();
    const startLifecycleWorkflow = vi.fn(async () => ({}));
    const { port } = admissionFor(undefined, { pooled: true, startWorkflow, startLifecycleWorkflow,
      bringUp: { requestedAgents: ['omp'] }, resolvePoolAdmission: async input => ({
        estimate: { cents: 100, currency: 'USD', source: 'fixture-catalog', evidenceRef: 'test://catalog', estimatedAt: '2026-10-16T00:00:00Z' },
        pool: { scope: desired.scope, region: desired.region, zone: desired.zone!, architecture: 'x86_64',
          runtimeBundleSha256: 'a'.repeat(64), minimum: { cpuCount: 2, memoryMiB: 4096 }, maxObservationAgeMs: 60_000,
          dataVolumeId: `unprovisioned:${input.customerWorkspaceId}` },
      }) });
    const result = await port.ensureProvisioned({ ...authority,
      provider: 'gcp', connectionId: CONNECTION_ID, displayName: 'Warm trial', operationKey: 'warm-attempt' });
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(startLifecycleWorkflow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'start', hostId: 'warm-host', hostedCustomerWorkspaceId: result.workspaceId,
      bringUp: { customerWorkspaceId: result.workspaceId, requestedAgents: ['omp'] },
    }));
    const [binding] = await db.adminSql`SELECT workspace_host_id FROM harness_shared.customer_workspaces WHERE workspace_id = ${workspaceId} AND id = ${result.workspaceId}`;
    expect(binding.workspace_host_id).toBe('warm-host');
  });

  it('hands a bring-up to provisioning, and the bring-up can mark the workspace active under RLS (D-401)', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor(undefined, { bringUp: { requestedAgents: ['omp'] } });
    const organizationId = '77777777-7777-4777-8777-777777777777';
    const admitted = await port.ensureProvisioned({
      organizationId,
      userId: 'user-7',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Hosted workspace',
      operationKey: 'signup-bring-up',
    });
    const derived = admissionIdentity(organizationId, 'signup-bring-up');
    expect((await enqueued(started)).bringUp).toEqual({
      customerWorkspaceId: admitted.workspaceId,
      requestedAgents: ['omp'],
    });

    const state = async () => {
      const rows = await db.adminSql`
        SELECT state FROM harness_shared.customer_workspaces
         WHERE workspace_id = ${workspaceId} AND id = ${admitted.workspaceId}
      `;
      return rows[0]?.state as string | undefined;
    };
    // POSITIVE CONTROL: the row exists and is not already active, so 'active' below is this write.
    expect(await state()).toBe('provisioning');
    const activate = () =>
      activateHostedCustomerWorkspace({
        controlPlaneWorkspaceId: workspaceId,
        customerWorkspaceId: admitted.workspaceId,
        hostId: derived.hostId,
      });
    await expect(activate()).resolves.toEqual({ state: 'active' });
    expect(await state()).toBe('active');
    // A replayed step is a no-op, not a failure.
    await expect(activate()).resolves.toEqual({ state: 'active' });
    // A host the workspace is not bound to is refused, never silently "activated".
    await expect(
      activateHostedCustomerWorkspace({
        controlPlaneWorkspaceId: workspaceId,
        customerWorkspaceId: admitted.workspaceId,
        hostId: 'host-someone-else',
      }),
    ).rejects.toThrow(/not bound to host/);
  }, 120_000);

  it('hands no bring-up to an ordinary provision', async () => {
    await freshControlPlane();
    const { port, started } = admissionFor();
    await port.ensureProvisioned({
      organizationId: '88888888-8888-4888-8888-888888888888',
      userId: 'user-8',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Plain workspace',
      operationKey: 'signup-plain',
    });
    expect(await enqueued(started)).not.toHaveProperty('bringUp');
  }, 120_000);

  it('retires the customer binding only after terminal host absence and frees the organization slot', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor();
    const organizationId = '99999999-9999-4999-8999-999999999999';
    const admitted = await port.ensureProvisioned({
      organizationId,
      userId: 'user-offboard',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Workspace to offboard',
      operationKey: 'signup-offboard',
    });
    await enqueued(started);
    const hostId = admissionIdentity(organizationId, 'signup-offboard').hostId;
    const revokeConnectors = vi.fn(async () => {});
    const retireAgentReservations = vi.fn(async () => 0);
    const retire = () =>
      retireHostedCustomerWorkspaceAfterDestroy(
        { controlPlaneWorkspaceId: workspaceId, hostId },
        { revokeConnectors, retireAgentReservations },
      );

    await expect(retire()).rejects.toThrow(/before host .* is terminally absent/);
    expect(revokeConnectors).not.toHaveBeenCalled();
    expect(retireAgentReservations).not.toHaveBeenCalled();

    await db.adminSql`
      UPDATE harness_shared.workspace_hosts
         SET desired_state = 'absent', observed_state = 'absent', observed_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;

    await expect(retire()).resolves.toEqual({ customerWorkspaceId: admitted.workspaceId });
    expect(revokeConnectors).toHaveBeenCalledOnce();
    expect(retireAgentReservations).toHaveBeenCalledWith({ controlPlaneWorkspaceId: workspaceId, hostId });
    expect(revokeConnectors.mock.invocationCallOrder[0]).toBeLessThan(retireAgentReservations.mock.invocationCallOrder[0]!);
    await expect(retire()).resolves.toEqual({ customerWorkspaceId: admitted.workspaceId });
    expect(revokeConnectors).toHaveBeenCalledTimes(2);
    const rows = await db.adminSql`
      SELECT state, deleted_at FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId} AND id = ${admitted.workspaceId}
    `;
    expect(rows[0]).toMatchObject({ state: 'deleted' });
    expect(rows[0].deleted_at).not.toBeNull();

    // Migration 1200's partial unique index now admits a replacement for the same organization.
    await expect(
      port.ensureProvisioned({
        organizationId,
        userId: 'user-offboard',
        provider: 'gcp',
        connectionId: CONNECTION_ID,
        displayName: 'Replacement workspace',
        operationKey: 'signup-offboard-replacement',
      }),
    ).resolves.toMatchObject({ workspaceId: expect.stringMatching(/^ws-/) });
    await enqueued(started, 2);
  }, 120_000);

  it('admits a first workspace: host row, binding row, and exactly one provision enqueued', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor();
    const organizationId = '11111111-1111-4111-8111-111111111111';

    const result = await port.ensureProvisioned({
      organizationId,
      userId: 'user-1',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'First workspace',
      operationKey: 'signup-1',
    });

    const derived = admissionIdentity(organizationId, 'signup-1');
    expect(result).toEqual({
      workspaceId: derived.workspaceId,
      provisionOperationId: derived.provisionOperationId,
    });

    // Asserted through the RLS-BYPASS admin client: "did the row land" must be answered
    // independently of the policy that is itself under test.
    const bindings = await db.adminSql`
      SELECT id, organization_id, workspace_host_id, display_name, state,
             created_by_principal_kind, created_by_principal_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId}
    `;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: derived.workspaceId,
      organization_id: organizationId,
      workspace_host_id: derived.hostId,
      display_name: 'First workspace',
      state: 'provisioning',
      created_by_principal_kind: 'user',
      created_by_principal_id: 'user-1',
    });

    // The host row must exist and must carry the spec-derived columns from the SHARED
    // projection — the same one the provisioning runner writes with.
    const hosts = await db.adminSql`
      SELECT id, connection_id, region, size, image, disk_gib, network, scope_label
        FROM harness_shared.workspace_hosts
       WHERE workspace_id = ${workspaceId}
    `;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      id: derived.hostId,
      connection_id: CONNECTION_ID,
      region: 'us-central1',
      size: 'e2-small',
      disk_gib: 20,
      network: `${derived.hostId}-network`,
      scope_label: 'project-hosted',
    });

    await enqueued(started);
  }, 120_000);

  it('is idempotent on replay: same identity, no second row, no second provision', async () => {
    const workspaceId = await freshControlPlane();
    const { port, started } = admissionFor();
    const organizationId = '22222222-2222-4222-8222-222222222222';
    const input = {
      organizationId,
      userId: 'user-2',
      provider: 'gcp' as const,
      connectionId: CONNECTION_ID,
      displayName: 'Replayed workspace',
      operationKey: 'signup-replay',
    };

    const first = await port.ensureProvisioned(input);
    await enqueued(started);
    const second = await port.ensureProvisioned(input);

    expect(second).toEqual(first);
    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId}
    `;
    expect(rows[0].n).toBe(1);
    // The replay re-read its own binding and returned; it must not enqueue a second
    // provision for a host that is already being built.
    expect(started).toHaveLength(1);
  }, 120_000);

  it('refuses to adopt a workspace bound to another organization', async () => {
    await freshControlPlane();
    const { port } = admissionFor();
    const owner = '33333333-3333-4333-8333-333333333333';
    const intruder = '44444444-4444-4444-8444-444444444444';

    const admitted = await port.ensureProvisioned({
      organizationId: owner,
      userId: 'user-owner',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Owned workspace',
      operationKey: 'signup-owner',
    });

    await expect(
      port.ensureProvisioned({
        organizationId: intruder,
        userId: 'user-intruder',
        provider: 'gcp',
        connectionId: CONNECTION_ID,
        displayName: 'Takeover attempt',
        operationKey: 'signup-intruder',
        requestedWorkspaceId: admitted.workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'organization_mismatch' });
  }, 120_000);

  it('refuses a desired spec that names a different host, and writes no binding', async () => {
    const workspaceId = await freshControlPlane();
    // A resolver that returns a spec for some OTHER host: both writes would otherwise
    // succeed and the workspace would be bound to a machine provisioning never builds.
    const { port, started } = admissionFor((hostId) => `${hostId}-divergent`);

    await expect(
      port.ensureProvisioned({
        organizationId: '55555555-5555-4555-8555-555555555555',
        userId: 'user-5',
        provider: 'gcp',
        connectionId: CONNECTION_ID,
        displayName: 'Divergent spec',
        operationKey: 'signup-divergent',
      }),
    ).rejects.toBeInstanceOf(HostedWorkspaceAdmissionError);

    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${workspaceId}
    `;
    expect(rows[0].n).toBe(0);
    expect(started).toHaveLength(0);
  }, 120_000);

  it('keeps the binding inside its control-plane workspace under RLS', async () => {
    const workspaceId = await freshControlPlane();
    const { port } = admissionFor();
    const organizationId = '66666666-6666-4666-8666-666666666666';
    const admitted = await port.ensureProvisioned({
      organizationId,
      userId: 'user-6',
      provider: 'gcp',
      connectionId: CONNECTION_ID,
      displayName: 'Scoped workspace',
      operationKey: 'signup-scoped',
    });

    const visible = async (asWorkspaceId: string) =>
      db.appSql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.workspace_id', ${asWorkspaceId}, true)`;
        const rows = await tx`
          SELECT count(*)::int AS n FROM harness_shared.customer_workspaces
           WHERE id = ${admitted.workspaceId}
        `;
        return rows[0].n as number;
      });

    // POSITIVE CONTROL first: without it, the zero below could equally mean the probe is
    // broken, the row was never written, or RLS is working.
    expect(await visible(workspaceId)).toBe(1);
    expect(await visible(`${workspaceId}_other`)).toBe(0);
  }, 120_000);
});

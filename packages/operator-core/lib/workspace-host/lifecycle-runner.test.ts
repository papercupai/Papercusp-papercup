import { describe, expect, it, vi } from 'vitest';
import { workspaceHostDurableTenantIdentity } from './aws-host-bootstrap-push-core.mjs';
import {
  WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION,
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  workspaceHostCanaryIdentityLabels,
  fakeWorkspaceHostCapabilities,
  makeFakeWorkspaceHostProvider,
  planWorkspaceHostRecovery,
  type WorkspaceHostApplyResult,
  type WorkspaceHostInitializationReplayStore,
  type WorkspaceHostInitializationStepReceipt,
  type WorkspaceHostPlan,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
} from '@papercusp/deployment-driver';
import {
  runWorkspaceHostLifecycle,
  runWorkspaceHostProductLifecycle,
  type WorkspaceHostLifecycleStore,
  type WorkspaceHostProductLifecycleStage,
  type WorkspaceHostProductStageRequest,
} from './lifecycle-runner';
import { WorkspaceHostProvisioningRequestError, type WorkspaceHostCanaryAdmission } from './provisioning-runner';
import { WorkspaceHostControllerFenceError } from './observability-store';

const bootstrapMocks = vi.hoisted(() => ({
  resolveProfile: vi.fn(),
  renderBootstrap: vi.fn(),
}));

vi.mock('./provision-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provision-bootstrap')>()),
  resolveWorkspaceHostProvisionBootstrapProfile: bootstrapMocks.resolveProfile,
  renderWorkspaceHostProvisionBootstrap: bootstrapMocks.renderBootstrap,
}));

const vm = {
  target: 'gcp' as const,
  kind: 'vm',
  providerId: 'pc-host-vm',
  parentProviderId: 'project-1',
  zone: 'us-central1-a',
};
const desired = {
  hostId: 'host-1',
  target: 'gcp' as const,
  scope: { kind: 'project' as const, id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' } },
};
const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};

function providerHarness(hostBootstrap = false) {
  const plan: WorkspaceHostPlan = {
    planId: 'plan-start-1',
    operationId: 'op-1',
    target: 'gcp',
    hostId: 'host-1',
    generatedAt: '2026-08-27T00:00:00Z',
    steps: [
      {
        id: 'start-instance',
        action: 'start',
        resourceKind: 'vm',
        dependsOn: [],
        idempotencyKey: 'start-key',
        destructive: false,
        input: { op: 'start-instance', instanceName: vm.providerId },
      },
    ],
    warnings: [],
  };
  const apply = vi.fn<WorkspaceHostProvider['apply']>();
  const reconcile = vi.fn<WorkspaceHostProvider['reconcile']>();
  const planProvider = vi.fn(async () => plan);
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    capabilities: fakeWorkspaceHostCapabilities({ lifecycle: { hostBootstrap } }),
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-27T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: planProvider,
    apply,
    reconcile,
    observe: vi.fn<WorkspaceHostProvider['observe']>(async (host) => ({
      host,
      state: 'running' as const,
      resources: host.resources,
      observedAt: '2026-08-27T00:00:10Z',
      drift: [],
    })),
  });
  return { provider, apply, reconcile, plan, planProvider };
}

function storeHarness() {
  let checkpoints: WorkspaceHostResourceCheckpoint[] = [];
  // The operation row: its first write wins (ON CONFLICT DO NOTHING) and round-trips through JSON as jsonb does.
  let operationRequest: { plan?: unknown } | undefined;
  const store: WorkspaceHostLifecycleStore = {
    readTarget: vi.fn(async () => ({
      id: 'host-1',
      name: 'Host one',
      connectionId: 'connection-1',
      target: 'gcp',
      observedState: 'stopped',
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 1,
      desired,
      resources: [{ resource: vm, registeredAt: '2026-08-26T00:00:00Z' }],
    })),
    upsertHost: vi.fn(async () => {}),
    beginOperation: vi.fn(async ({ request }) => {
      operationRequest ??= JSON.parse(JSON.stringify(request ?? {}));
    }),
    readOperationPlan: vi.fn(async () => operationRequest?.plan ?? null),
    updateOperation: vi.fn(async () => {}),
    readCheckpoints: vi.fn(async () => checkpoints.map((entry) => ({ ...entry }))),
    upsertCheckpoint: vi.fn(async ({ checkpoint }) => {
      checkpoints = [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), { ...checkpoint }];
    }),
    appendEvent: vi.fn(async () => 'event-1'),
    recordObservation: vi.fn(async () => {}),
    recordRecoveryPoint: vi.fn(async () => {}),
    recordImage: vi.fn(async () => {}),
  };
  return { store, checkpoints: () => checkpoints };
}

function input(provider: WorkspaceHostProvider, store: WorkspaceHostLifecycleStore) {
  return {
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    connection,
    provider,
    action: 'start' as const,
    operationId: 'op-1',
    store,
  };
}

function successfulProviderResult(): WorkspaceHostApplyResult {
  return {
    operationId: 'op-1',
    stepId: 'start-instance',
    state: 'applied',
    observedAt: '2026-08-27T00:00:05Z',
    resource: vm,
  };
}

function restorePlan() {
  return planWorkspaceHostRecovery({
    contractVersion: WORKSPACE_HOST_RECOVERY_CONTRACT_VERSION,
    recoveryId: 'recovery-1',
    workspaceId: 'workspace-1',
    requestedAt: '2026-08-27T00:00:00Z',
    sourceHost: { hostId: 'host-1', target: 'gcp', resources: [vm] },
    desired: {
      ...desired,
      hostId: 'host-restored',
      image: { ...desired.image, version: 'v2' },
    },
    applicationBackup: {
      system: '@papercusp/backup',
      workspaceId: 'workspace-1',
      snapshotId: 42,
      kopiaSnapshotId: 'kopia-42',
      status: 'ok',
      capturedAt: '2026-08-26T23:30:00Z',
      verifiedAt: '2026-08-26T23:45:00Z',
      databaseDumpPath: 'db-dumps/pg-embedded.sql.gz',
      sources: ['postgres', 'repositories'],
    },
    providerSnapshot: {
      snapshot: {
        target: 'gcp',
        providerId: 'snapshot-1',
        hostId: 'host-1',
        createdAt: '2026-08-26T23:31:00Z',
        retainUntil: '2027-08-27T00:00:00Z',
      },
      encrypted: true,
      retentionDays: 365,
      minimumRestorePoints: 4,
    },
    schema: {
      migrationId: 'workspace-schema-2',
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      compatibleSourceRange: { minimum: 1, maximum: 2 },
      rollback: {
        runtime: {
          image: { id: 'projects/images/global/images/papercusp-v1', version: 'v1' },
          schemaVersion: 1,
          compatibleDataRange: { minimum: 1, maximum: 1 },
        },
        data: { strategy: 'restore-provider-snapshot' },
      },
    },
    proof: { cadenceDays: 92 },
  });
}

function successfulStagePostconditions(request: WorkspaceHostProductStageRequest): Record<string, unknown> {
  const common = { workspaceId: request.workspaceId, hostId: request.targetHostId };
  switch (request.stage) {
    case 'data-recovery':
      return { ...common, sourceHostId: request.sourceHostId, dataRetained: true, schemaCompatible: true };
    case 'runtime-update':
      return {
        ...common,
        runtimeStrategy: request.runtimeStrategy,
        signedReleaseVerified: true,
        transitionCompleted: true,
      };
    case 'credential-rebind':
      return { ...common, credentialsRebound: true };
    case 'initialization':
      return { ...common, initialized: true, migrationSucceeded: true };
    case 'service-readiness':
      return { ...common, serviceReady: true, healthStatus: 'healthy' };
    case 'reconnect':
      return { ...common, reconnected: true };
  }
}

function productHarness(
  options: {
    failOnceAt?: WorkspaceHostProductLifecycleStage;
    invalidAt?: WorkspaceHostProductLifecycleStage;
  } = {},
) {
  const persisted = new Map<string, WorkspaceHostInitializationStepReceipt>();
  let failedOnce = false;
  const replayStore: WorkspaceHostInitializationReplayStore = {
    async runOnce(identity, run) {
      const prior = persisted.get(identity.idempotencyKey);
      if (prior) return prior;
      const receipt = await run();
      persisted.set(identity.idempotencyKey, receipt);
      return receipt;
    },
  };
  const operations = {
    execute: vi.fn(async (request: WorkspaceHostProductStageRequest) => {
      if (request.stage === options.failOnceAt && !failedOnce) {
        failedOnce = true;
        throw new Error(`interrupted at ${request.stage}`);
      }
      const postconditions = successfulStagePostconditions(request);
      if (request.stage === options.invalidAt) {
        if (request.stage === 'initialization') postconditions.migrationSucceeded = false;
        if (request.stage === 'service-readiness') postconditions.healthStatus = 'degraded';
      }
      return { observedAt: '2026-08-27T00:01:00Z', postconditions };
    }),
  };
  return { operations, replayStore };
}

describe('runWorkspaceHostLifecycle', () => {
  it('recovers the original AWS run and deadline from stored admission for a later lifecycle', async () => {
    const { provider: base, planProvider, apply } = providerHarness();
    const provider = { ...base, target: 'aws' as const };
    const { store } = storeHarness();
    const target = (await store.readTarget('workspace-1', 'host-1'))!;
    const original = { operationId: 'original-provision', workspaceId: 'workspace-1', runId: 'aws-original',
      teardownDeadlineAt: '2026-10-23T06:00:00.000Z' };
    vi.mocked(store.readTarget).mockResolvedValue({ ...target, target: 'aws',
      desired: { ...desired, target: 'aws', labels: workspaceHostCanaryIdentityLabels(original) },
      originalCanaryAdmission: original });
    planProvider.mockRejectedValueOnce(new Error('stop at verified provider boundary'));
    await expect(runWorkspaceHostLifecycle({ ...input(provider, store), connection: { ...connection, target: 'aws' } }))
      .rejects.toThrow('stop at verified provider boundary');
    expect(planProvider).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      canaryRunId: original.runId, canaryTeardownDeadlineAt: original.teardownDeadlineAt }));
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(['missing-origin', 'foreign-workspace', 'changed-labels', 'invalid-deadline', 'caller-renewal'])
  ('refuses AWS lifecycle %s before provider planning or mutation', async scenario => {
    const { provider: base, planProvider, apply } = providerHarness();
    const provider = { ...base, target: 'aws' as const };
    const { store } = storeHarness();
    const target = (await store.readTarget('workspace-1', 'host-1'))!;
    const original = { operationId: 'original-provision', workspaceId: 'workspace-1', runId: 'aws-original',
      teardownDeadlineAt: '2026-10-23T06:00:00.000Z' };
    const labels = workspaceHostCanaryIdentityLabels(original);
    if (scenario === 'foreign-workspace') original.workspaceId = 'foreign';
    if (scenario === 'changed-labels') original.runId = 'renewed';
    if (scenario === 'invalid-deadline') original.teardownDeadlineAt = 'invalid';
    vi.mocked(store.readTarget).mockResolvedValue({ ...target, target: 'aws',
      desired: { ...desired, target: 'aws', labels },
      originalCanaryAdmission: scenario === 'missing-origin' ? null : original });
    await expect(runWorkspaceHostLifecycle({ ...input(provider, store), connection: { ...connection, target: 'aws' },
      ...(scenario === 'caller-renewal' ? { canary: { ...original,
        teardownDeadlineAt: '2026-10-24T06:00:00.000Z' } as WorkspaceHostCanaryAdmission } : {}) }))
      .rejects.toThrow(/original AWS canary|cannot replace the original/);
    expect(planProvider).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
  });

  it.each(['replacement-labels', 'source-labels'] as const)(
    'refuses an unadmitted canary restore detected from %s before any provider access', async (labelLocation) => {
      const { store } = storeHarness();
      const { provider, apply } = providerHarness();
      const labels = workspaceHostCanaryIdentityLabels({ runId: 'restore-run', workspaceId: 'workspace-1' });
      if (labelLocation === 'source-labels') {
        const target = await store.readTarget('workspace-1', 'host-1');
        vi.mocked(store.readTarget).mockResolvedValue({ ...target!, desired: { ...desired, labels } });
      }
      await expect(runWorkspaceHostLifecycle({
        ...input(provider, store), action: 'restore',
        snapshot: { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' },
        desired: { ...desired, hostId: 'host-restored', ...(labelLocation === 'replacement-labels' ? { labels } : {}) },
      })).rejects.toThrow('pre-run economic admission');
      expect(provider.validateConnection).not.toHaveBeenCalled();
      expect(provider.plan).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(store.upsertHost).not.toHaveBeenCalled();
    },
  );

  it('persists the plan before mutation and passes the complete stored resource graph', async () => {
    const { store, checkpoints } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockImplementation(async (request): Promise<WorkspaceHostApplyResult> => {
      expect(checkpoints()[0]).toMatchObject({ logicalKey: 'start-instance', state: 'applying', providerResource: vm });
      expect(request.knownResources).toContainEqual(vm);
      return {
        operationId: 'op-1',
        stepId: 'start-instance',
        state: 'unchanged',
        observedAt: '2026-08-27T00:00:05Z',
        resource: vm,
      };
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
      hostId: 'host-1',
    });
    expect(store.recordObservation).toHaveBeenCalledOnce();
  });

  it('renders the current controller bootstrap before a repair plan and passes it only through provider context', async () => {
    const { store } = storeHarness();
    const target = await store.readTarget('workspace-1', 'host-1');
    vi.mocked(store.readTarget).mockResolvedValue({ ...target!, hostedCustomerWorkspaceId: 'customer-1',
      durableStorageAdmission: { operationId: 'original-provision', customerWorkspaceId: 'customer-1',
        allocation: { dbGiB: 12, workspaceGiB: 8 } } });
    const { provider, apply } = providerHarness(true);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });
    const renderHostBootstrap = vi.fn(async () => '#!/usr/bin/env bash\necho repaired');

    await runWorkspaceHostLifecycle({
      ...input(provider, store),
      action: 'repair',
      renderHostBootstrap,
    });

    expect(renderHostBootstrap).toHaveBeenCalledWith('host-1');
    expect(provider.plan).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'repair' }),
      expect.objectContaining({ hostBootstrapScript: '#!/usr/bin/env bash\necho repaired',
        durableTenantIdentity: workspaceHostDurableTenantIdentity('workspace-1', 'customer-1'),
        durableStorageAllocation: { dbGiB: 12, workspaceGiB: 8 } }),
    );
  });

  it.each([null, { dbGiB: 20, workspaceGiB: 0 }, { dbGiB: -1, workspaceGiB: 21 }])(
    'refuses an unknown or unbootable original pool allocation before provider calls: %j', async allocation => {
      const { store } = storeHarness();
      const target = await store.readTarget('workspace-1', 'host-1');
      vi.mocked(store.readTarget).mockResolvedValue({ ...target!, hostedCustomerWorkspaceId: 'customer-1',
        durableStorageAdmission: { operationId: 'original-provision', customerWorkspaceId: 'customer-1', allocation } });
      const { provider } = providerHarness();
      await expect(runWorkspaceHostLifecycle(input(provider, store))).rejects.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
      expect(provider.validateConnection).not.toHaveBeenCalled();
      expect(provider.plan).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    },
  );

  it('refuses a reservation for a different customer before any provider call', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness();
    const target = await store.readTarget('workspace-1', 'host-1');
    vi.mocked(store.readTarget).mockResolvedValue({ ...target!, hostedCustomerWorkspaceId: 'customer-1' });
    await expect(runWorkspaceHostLifecycle({ ...input(provider, store), hostedCustomerWorkspaceId: 'foreign' }))
      .rejects.toThrow('does not match stored host binding');
    expect(provider.plan).not.toHaveBeenCalled();
    expect(provider.apply).not.toHaveBeenCalled();
  });

  it('forwards an operation-scoped release pin through the lifecycle runner', async () => {
    const bootstrapReleaseOverride = {
      manifestPath: '/var/lib/papercusp/releases/gcp-live.json',
      migrationId: '1102',
    } as const;
    const profile = {
      release: {
        version: '2026.10.10-gcp-live',
        bundleSha256: 'c'.repeat(64),
        signingKeySha256: 'd'.repeat(64),
      },
      migrationId: bootstrapReleaseOverride.migrationId,
    };
    const bootstrapScript = '#!/usr/bin/env bash\necho lifecycle release';
    bootstrapMocks.resolveProfile.mockReset().mockResolvedValue(profile);
    bootstrapMocks.renderBootstrap.mockReset().mockReturnValue(bootstrapScript);

    const { store } = storeHarness();
    const { provider, apply } = providerHarness(true);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });

    await runWorkspaceHostLifecycle({
      ...input(provider, store),
      action: 'repair',
      bootstrapReleaseOverride,
    });

    expect(bootstrapMocks.resolveProfile).toHaveBeenCalledWith({ bootstrapReleaseOverride });
    expect(bootstrapMocks.renderBootstrap.mock.calls[0]?.[0]).toBe('host-1');
    expect(bootstrapMocks.renderBootstrap.mock.calls[0]?.[1]).toBe(profile);
    expect(provider.plan).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'repair' }),
      expect.objectContaining({
        hostBootstrapScript: bootstrapScript,
      }),
    );
  });

  it('reconciles an ambiguous provider result on replay instead of applying twice', async () => {
    const { store } = storeHarness();
    const { provider, apply, reconcile } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'in-progress',
      observedAt: '2026-08-27T00:00:01Z',
      providerRequestId: 'provider-op-1',
      retryAfterMs: 5_000,
    });
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'unchanged',
      observedAt: '2026-08-27T00:00:06Z',
      resource: vm,
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'in-progress',
      retryAfterMs: 5_000,
    });
    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({ status: 'succeeded' });
    expect(apply).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'resume', previousProviderRequestId: 'provider-op-1' }),
      expect.anything(),
    );
  });

  it('reuses the operation revision when replaying after its first attempt advanced the host revision', async () => {
    const { store } = storeHarness();
    const { provider, apply, reconcile } = providerHarness();
    let hostDesiredRevision = 1;
    let operationDesiredRevision: number | undefined;
    let persistedPlan: WorkspaceHostPlan | null = null;
    store.readTarget = vi.fn(async () => ({
      id: 'host-1',
      name: 'Host one',
      connectionId: 'connection-1',
      target: 'gcp',
      observedState: 'stopped',
      hostGeneration: 1,
      desiredRevision: hostDesiredRevision,
      observedRevision: 1,
      desired,
      resources: [{ resource: vm, registeredAt: '2026-08-26T00:00:00Z' }],
    }));
    store.readOperationPlan = vi.fn(async () => persistedPlan);
    store.beginOperation = vi.fn(async ({ request, desiredRevision }) => {
      if (operationDesiredRevision === undefined) {
        if (desiredRevision === undefined) throw new Error('operation revision was not assigned');
        operationDesiredRevision = desiredRevision;
        hostDesiredRevision = desiredRevision;
        persistedPlan = (request as { plan?: WorkspaceHostPlan } | undefined)?.plan ?? null;
        return;
      }
      if (desiredRevision !== operationDesiredRevision) throw new WorkspaceHostControllerFenceError('host-1');
    });
    apply.mockResolvedValueOnce({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'in-progress',
      observedAt: '2026-08-27T00:00:01Z',
      providerRequestId: 'provider-op-1',
      retryAfterMs: 5_000,
    });
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'unchanged',
      observedAt: '2026-08-27T00:00:06Z',
      resource: vm,
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({ status: 'in-progress' });
    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({ status: 'succeeded' });

    expect(store.beginOperation).toHaveBeenNthCalledWith(1, expect.objectContaining({ desiredRevision: 2 }));
    expect(store.beginOperation).toHaveBeenNthCalledWith(2, expect.objectContaining({ desiredRevision: 2 }));
    expect(provider.plan).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it('reports upgrade as succeeded-but-not-yet-servable, in the result AND the ledger', async () => {
    // WI-2143797: upgrade recreates the instance from the new image, so everything the
    // initialization leg installed is gone. The provider steps genuinely succeeded; the HOST
    // cannot serve. Both facts have to survive, which is why this is a flag beside
    // status:'succeeded' rather than a different status.
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });

    await expect(
      runWorkspaceHostLifecycle({
        ...input(provider, store),
        action: 'upgrade',
        image: { id: 'projects/images/global/images/papercusp-v2' },
      }),
    ).resolves.toMatchObject({ status: 'succeeded', requiresInitialization: true });

    // The ledger row is what an operator actually reads; a flag only the caller sees would
    // leave `succeeded | 100 | "completed"` sitting in the timeline saying the opposite.
    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        percent: 100,
        message: expect.stringContaining('CANNOT SERVE'),
      }),
    );
    expect(store.appendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'complete', message: expect.stringContaining('CANNOT SERVE') }),
    );
    // WI-10002494: the host row and desired spec must follow the host onto the new image, or the
    // next recreate built from that spec silently undoes the upgrade.
    expect(store.recordImage).toHaveBeenCalledTimes(1);
    // ...and through the controller fence, like every other write the operation makes.
    expect(store.recordImage).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      image: { id: 'projects/images/global/images/papercusp-v2' },
      operationId: 'op-1',
      controllerAuthority: expect.objectContaining({ fence: expect.any(Number) }),
    });
  });

  it('observes an upgrade that REPLACED its instance with the replacement, not the retired original', async () => {
    // WI-10005971: an AWS upgrade launches a replacement under a NEW instance id and terminates the
    // original last. Observing the start-of-turn population read the terminated original and
    // recorded the freshly upgraded host as absent.
    const { store } = storeHarness();
    const { provider, apply, planProvider } = providerHarness();
    const replacement = { ...vm, providerId: `${vm.providerId}-replacement` };
    planProvider.mockResolvedValue({
      planId: 'plan-upgrade-replace',
      operationId: 'op-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: '2026-08-27T00:00:00Z',
      steps: [
        {
          id: 'launch-replacement',
          action: 'upgrade',
          resourceKind: 'vm',
          dependsOn: [],
          idempotencyKey: 'launch-key',
          destructive: false,
          input: { op: 'run-instance' },
        },
        {
          id: 'retire-original',
          action: 'upgrade',
          resourceKind: 'vm',
          dependsOn: ['launch-replacement'],
          idempotencyKey: 'retire-key',
          destructive: true,
          input: { op: 'terminate-instance', resourceName: vm.providerId },
        },
      ],
      warnings: [],
    });
    apply.mockImplementation(async ({ step }) =>
      step.id === 'launch-replacement'
        ? { operationId: 'op-1', stepId: step.id, state: 'applied', observedAt: '2026-08-27T00:00:05Z', resource: replacement }
        : {
            operationId: 'op-1',
            stepId: step.id,
            state: 'destroyed',
            observedAt: '2026-08-27T00:00:06Z',
            confirmation: {
              hostId: 'host-1',
              providerResourceId: vm.providerId,
              confirmedAbsentAt: '2026-08-27T00:00:06Z',
              source: 'provider-read',
            },
          },
    );

    await expect(
      runWorkspaceHostLifecycle({
        ...input(provider, store),
        action: 'upgrade',
        image: { id: 'projects/images/global/images/papercusp-v2' },
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });

    expect(provider.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostId: 'host-1', resources: [replacement] }),
      expect.anything(),
    );
    // The plan request carries the recorded desired spec a replacing provider launches from.
    expect(planProvider).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upgrade', desired }),
      expect.anything(),
    );
  });

  it('records the runtime release an upgrade installed beside its image', async () => {
    // WI-10002798: host-560adc ran only r42 after its upgrade while its row still read r41, so the
    // UI and the release journal named a runtime the machine no longer had.
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue(successfulProviderResult());
    const runtimeRelease = {
      version: '0.0.21-p318r42',
      bundleSha256: 'a'.repeat(64),
      signingKeySha256: 'b'.repeat(64),
      protocolVersion: 'papercusp-workspace-host.v1',
      schemaVersion: 'schema-1202',
    };

    await runWorkspaceHostLifecycle({
      ...input(provider, store),
      action: 'upgrade',
      image: { id: 'projects/images/global/images/papercusp-v2' },
      runtimeRelease,
    });

    expect(store.recordImage).toHaveBeenCalledWith(
      expect.objectContaining({ image: { id: 'projects/images/global/images/papercusp-v2' }, runtimeRelease }),
    );
  });

  it('reports repair as provider-succeeded but not servable, in the result AND the ledger', async () => {
    // WI-2146639: repair refreshes startup metadata and resets the existing VM. Provider success
    // proves those mutations completed; it does not prove the replacement startup bootstrap has
    // finished. Preserve both facts instead of either lying about success or claiming readiness.
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });

    await expect(runWorkspaceHostLifecycle({ ...input(provider, store), action: 'repair' })).resolves.toMatchObject({
      status: 'succeeded',
      requiresInitialization: true,
    });

    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'succeeded',
        percent: 100,
        message: expect.stringContaining('CANNOT SERVE'),
      }),
    );
    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("repair invalidated the host's initialized state"),
      }),
    );
    expect(store.appendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'complete', message: expect.stringContaining('CANNOT SERVE') }),
    );
    // Repair resets the existing instance on its current image; it must not rewrite the image.
    expect(store.recordImage).not.toHaveBeenCalled();
  });

  it.each(['start', 'restart'] as const)('defers hosted %s completion to the retained-data controller', async (action) => {
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue({ operationId: 'op-1', stepId: 'start-instance', state: 'applied',
      observedAt: '2026-08-27T00:00:05Z', resource: vm });
    await expect(runWorkspaceHostLifecycle({ ...input(provider, store), action,
      providerCompletionMode: 'defer-to-product-controller' })).resolves.toMatchObject({
      status: 'in-progress', lifecycleStage: 'provider-complete',
    });
    expect(store.updateOperation).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running', percent: 50 }));
    expect(store.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'complete', status: 'succeeded' }));
  });

  it('leaves an initialization-preserving action reporting a plain completion', async () => {
    // The calibration case. Without it, a predicate stuck at `true` would pass the test above
    // while declaring every stop and restart unusable.
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });

    await expect(runWorkspaceHostLifecycle(input(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
      requiresInitialization: false,
    });
    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Workspace-host start completed' }),
    );
    expect(store.recordImage).not.toHaveBeenCalled();
  });

  it('fails closed when restore does not name a distinct desired host', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness();
    await expect(
      runWorkspaceHostLifecycle({
        ...input(provider, store),
        action: 'restore',
        snapshot: { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' },
        desired,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(provider.plan).not.toHaveBeenCalled();
  });

  it.each([false, true])('creates a replacement Host preserving data and permissions (canary=%s)', async (isCanary) => {
    const canary: WorkspaceHostCanaryAdmission = {
      runId: 'restore-run', workspaceId: 'workspace-1', maxSpendCents: 100,
      teardownDeadlineAt: '2099-01-01T00:00:00Z', budgetEvidenceRef: 'gcp://billing/budgets/restore-run',
      preRunZeroBaseline: { cents: 0, observedAt: '2020-01-01T00:00:00Z', providerEvidenceRef: 'gcp://billing/restore-zero' },
      contractApproval: {
        status: 'approved', suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        approvedBy: 'test-reviewer', approvedAt: '2020-01-01T00:00:00Z', reportRef: 'report://gcp/contract-1',
      },
    };
    const { store } = storeHarness();
    const { provider, apply, plan, planProvider } = providerHarness();
    planProvider.mockResolvedValue({ ...plan, hostId: 'host-restored' });
    apply.mockImplementation(async () => {
      if (isCanary) expect(store.beginOperation).toHaveBeenCalledWith(
        expect.objectContaining({ request: expect.objectContaining({ canary }) }),
      );
      return {
        operationId: 'op-1',
        stepId: 'start-instance',
        state: 'applied',
        observedAt: '2026-08-27T00:00:05Z',
        resource: { ...vm, providerId: 'pc-host-restored' },
      };
    });

    await runWorkspaceHostLifecycle({
      ...input(provider, store),
      action: 'restore',
      snapshot: { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' },
      desired: { ...desired, hostId: 'host-restored', ...(isCanary ? { labels: workspaceHostCanaryIdentityLabels(canary) } : {}) },
      ...(isCanary ? { canary } : {}),
    });

    expect(planProvider).toHaveBeenCalledWith(expect.anything(), isCanary
      ? expect.objectContaining({ canaryTeardownDeadlineAt: canary.teardownDeadlineAt })
      : expect.not.objectContaining({ canaryTeardownDeadlineAt: expect.anything() }));

    expect(store.upsertHost).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        id: 'host-restored',
        desiredState: 'running',
        observedState: 'provisioning',
        hostGeneration: 2,
        desiredRevision: 2,
        observedRevision: 1,
        connectionId: 'connection-1',
        desiredSpec: expect.objectContaining({ hostId: 'host-restored', data: desired.data }),
      }),
    );
  });

  it.each([
    ['ubuntu-release-bundle', 'transitional-bundle-update'],
    ['bootc-image', 'bootc-stage-reboot'],
  ] as const)(
    'continues an upgrade from provider-complete to workspace-usable with the %s runtime strategy',
    async (hostModel, runtimeStrategy) => {
      const { store } = storeHarness();
      const { provider, apply } = providerHarness();
      apply.mockResolvedValue(successfulProviderResult());
      const product = productHarness();

      const result = await runWorkspaceHostProductLifecycle({
        ...input(provider, store),
        action: 'upgrade',
        image: { id: 'projects/images/global/images/papercusp-v2' },
        product: { hostModel, ...product },
      });

      expect(result).toMatchObject({
        status: 'succeeded',
        lifecycleStage: 'workspace-usable',
        requiresInitialization: false,
      });
      expect(result.productStageReceipts?.map(({ stage }) => stage)).toEqual([
        'runtime-update',
        'initialization',
        'service-readiness',
        'reconnect',
      ]);
      expect(product.operations.execute).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'runtime-update', hostModel, runtimeStrategy }),
      );
      expect(store.updateOperation).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running', percent: 50, message: expect.stringContaining('provider') }),
      );
      expect(store.updateOperation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'succeeded',
          percent: 100,
          message: expect.stringContaining('workspace-usable'),
        }),
      );
    },
  );

  it('resumes interrupted product stages without repeating completed host side effects', async () => {
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue(successfulProviderResult());
    const product = productHarness({ failOnceAt: 'initialization' });
    const request = {
      ...input(provider, store),
      action: 'upgrade' as const,
      image: { id: 'projects/images/global/images/papercusp-v2' },
      product: { hostModel: 'ubuntu-release-bundle' as const, ...product },
    };

    await expect(runWorkspaceHostProductLifecycle(request)).resolves.toMatchObject({
      status: 'failed',
      lifecycleStage: 'initialization',
    });
    await expect(runWorkspaceHostProductLifecycle(request)).resolves.toMatchObject({
      status: 'succeeded',
      lifecycleStage: 'workspace-usable',
    });

    expect(apply).toHaveBeenCalledOnce();
    const stages = product.operations.execute.mock.calls.map(([stage]) => stage.stage);
    expect(stages.filter((stage) => stage === 'runtime-update')).toHaveLength(1);
    expect(stages.filter((stage) => stage === 'initialization')).toHaveLength(2);
    expect(stages.filter((stage) => stage === 'service-readiness')).toHaveLength(1);
    expect(stages.filter((stage) => stage === 'reconnect')).toHaveLength(1);
  });

  it.each([
    ['initialization', 'migrationSucceeded'],
    ['service-readiness', 'healthStatus'],
  ] as const)('fails closed when %s does not prove %s', async (stage, _postcondition) => {
    const { store } = storeHarness();
    const { provider, apply } = providerHarness();
    apply.mockResolvedValue(successfulProviderResult());
    const product = productHarness({ invalidAt: stage });

    await expect(
      runWorkspaceHostProductLifecycle({
        ...input(provider, store),
        action: 'upgrade',
        image: { id: 'projects/images/global/images/papercusp-v2' },
        product: { hostModel: 'ubuntu-release-bundle', ...product },
      }),
    ).resolves.toMatchObject({ status: 'failed', lifecycleStage: stage });
    expect(store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', message: expect.stringContaining(stage) }),
    );
  });

  it('chains restore data, runtime, credential rebind, initialization, readiness, and reconnect while retaining identity', async () => {
    const { store } = storeHarness();
    const { provider, apply, plan, planProvider } = providerHarness();
    planProvider.mockResolvedValue({ ...plan, hostId: 'host-restored' });
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'start-instance',
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: { ...vm, providerId: 'pc-host-restored' },
    });
    const product = productHarness();
    const recoveryPlan = restorePlan();

    const result = await runWorkspaceHostProductLifecycle({
      ...input(provider, store),
      action: 'restore',
      snapshot: { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' },
      desired: { ...desired, hostId: 'host-restored' },
      product: { hostModel: 'ubuntu-release-bundle', recoveryPlan, ...product },
    });

    expect(result.productStageReceipts?.map(({ stage }) => stage)).toEqual([
      'data-recovery',
      'runtime-update',
      'credential-rebind',
      'initialization',
      'service-readiness',
      'reconnect',
    ]);
    expect(product.operations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'data-recovery',
        workspaceId: 'workspace-1',
        sourceHostId: 'host-1',
        targetHostId: 'host-restored',
        recoveryPlan,
      }),
    );
    expect(result.productStageReceipts?.[0]?.postconditions).toMatchObject({
      workspaceId: 'workspace-1',
      hostId: 'host-restored',
      sourceHostId: 'host-1',
      dataRetained: true,
      schemaCompatible: true,
    });
  });
});

/**
 * WI-10002490: an upgrade deletes the runtime VM, then re-creates it from the new image. If the
 * re-create cannot complete, the precomputed rollback re-creates it from the prior image instead —
 * the host must never be left with no VM while the request's rollbackImage sits ignored.
 */
describe('runWorkspaceHostLifecycle upgrade rollback', () => {
  const upgradeImage = { id: 'projects/images/global/images/papercusp-v2' };

  function upgradeHarness() {
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile, planProvider } = providerHarness();
    planProvider.mockImplementation(async () => ({
      planId: 'plan-upgrade-1',
      operationId: 'op-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: '2026-08-27T00:00:00Z',
      steps: [
        {
          id: 'delete-boot-runtime',
          action: 'upgrade',
          resourceKind: 'vm',
          dependsOn: [],
          idempotencyKey: 'delete-key',
          destructive: true,
          input: { op: 'delete-instance', resourceName: vm.providerId },
        },
        {
          id: 'create-boot-runtime',
          action: 'upgrade',
          resourceKind: 'vm',
          dependsOn: ['delete-boot-runtime'],
          idempotencyKey: 'create-key',
          destructive: false,
          input: { op: 'insert-instance', sourceImage: upgradeImage.id },
          rollback: {
            idempotencyKey: 'create-key:rollback',
            input: { op: 'insert-instance', sourceImage: desired.image.id },
          },
        },
      ],
      warnings: [],
    }));
    const destroyed = (stepId: string): WorkspaceHostApplyResult => ({
      operationId: 'op-1',
      stepId,
      state: 'destroyed',
      observedAt: '2026-08-27T00:00:02Z',
      confirmation: {
        hostId: 'host-1',
        providerResourceId: vm.providerId,
        confirmedAbsentAt: '2026-08-27T00:00:02Z',
        source: 'provider-read',
      },
    });
    const created = (stepId: string): WorkspaceHostApplyResult => ({
      operationId: 'op-1',
      stepId,
      state: 'applied',
      observedAt: '2026-08-27T00:00:05Z',
      resource: vm,
    });
    const run = () =>
      runWorkspaceHostLifecycle({ ...input(provider, store), action: 'upgrade', image: upgradeImage });
    const stepCalls = (mock: typeof apply | typeof reconcile, stepId: string) =>
      mock.mock.calls.filter(([request]) => request.step.id === stepId).length;
    return { store, checkpoints, provider, apply, reconcile, planProvider, destroyed, created, run, stepCalls };
  }

  it('resumes from the persisted plan once the delete applied and the VM it was planned from is gone', async () => {
    // WI-10002527: the GCP planner builds the re-create from a live read of the VM the first step
    // deletes, so it cannot plan again after that delete. A delete that settles on a LATER turn must
    // resume the plan the operation persisted, not die re-planning with no VM and no rollback.
    const h = upgradeHarness();
    const firstPlan = h.planProvider.getMockImplementation()!;
    h.planProvider
      .mockImplementationOnce(firstPlan)
      .mockRejectedValue(new Error('GCP upgrade requires a fresh instance read with recreateInput'));
    h.apply.mockImplementation(async (request) => {
      if (request.step.id === 'delete-boot-runtime') {
        return {
          operationId: 'op-1',
          stepId: request.step.id,
          state: 'in-progress',
          observedAt: '2026-08-27T00:00:01Z',
          providerRequestId: 'delete-op-1',
          retryAfterMs: 2_000,
        };
      }
      return h.created(request.step.id);
    });
    h.reconcile.mockImplementation(async (request) => h.destroyed(request.step.id));

    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    await expect(h.run()).resolves.toMatchObject({ status: 'succeeded', requiresInitialization: true });

    expect(h.planProvider).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({ id: 'delete-boot-runtime' }),
        previousProviderRequestId: 'delete-op-1',
      }),
      expect.anything(),
    );
    expect(h.stepCalls(h.apply, 'create-boot-runtime')).toBe(1);
    expect(h.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({
          id: 'create-boot-runtime',
          idempotencyKey: 'create-key:desired-revision:2',
          input: { op: 'insert-instance', sourceImage: upgradeImage.id },
        }),
      }),
      expect.anything(),
    );
  });

  it('re-creates the VM from the prior image when the upgraded re-create is refused after the delete', async () => {
    const h = upgradeHarness();
    h.apply.mockImplementation(async (request) => {
      if (request.step.id === 'delete-boot-runtime') return h.destroyed(request.step.id);
      if (request.step.id === 'create-boot-runtime') {
        throw Object.assign(new Error('image papercusp-v2 is quarantined'), { status: 400 });
      }
      expect(request.step).toMatchObject({
        id: 'create-boot-runtime:rollback',
        idempotencyKey: 'create-key:rollback:desired-revision:2',
        input: { op: 'insert-instance', sourceImage: desired.image.id },
      });
      return h.created(request.step.id);
    });

    const result = await h.run();

    expect(result).toMatchObject({
      status: 'failed',
      requiresInitialization: true,
      rollback: { stepId: 'create-boot-runtime', status: 'succeeded', image: desired.image },
    });
    // No caller-supplied rollbackImage: the host's recorded image is the default, so the provider
    // was asked to validate and precompute it before anything was deleted.
    expect(h.provider.plan).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upgrade', image: upgradeImage, rollbackImage: desired.image }),
      expect.anything(),
    );
    // The host row follows the VM back to the prior image — never onto the image it never got.
    expect(h.store.recordImage).toHaveBeenCalledOnce();
    expect(h.store.recordImage).toHaveBeenCalledWith(expect.objectContaining({ image: desired.image }));
    expect(h.store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        message: expect.stringContaining('was rolled back'),
        error: expect.objectContaining({ reason: 'image papercusp-v2 is quarantined', rolledBack: true }),
      }),
    );
    expect(h.checkpoints()).toContainEqual(
      expect.objectContaining({ logicalKey: 'create-boot-runtime:rollback', state: 'applied', providerResource: vm }),
    );
  });

  it('resumes an in-flight rollback on the next turn by reconciling it, never re-issuing it', async () => {
    const h = upgradeHarness();
    h.apply.mockImplementation(async (request) => {
      if (request.step.id === 'delete-boot-runtime') return h.destroyed(request.step.id);
      if (request.step.id === 'create-boot-runtime') {
        throw Object.assign(new Error('zone capacity exhausted'), { status: 400 });
      }
      return {
        operationId: 'op-1',
        stepId: request.step.id,
        state: 'in-progress',
        observedAt: '2026-08-27T00:00:05Z',
        providerRequestId: 'rollback-op-1',
        retryAfterMs: 4_000,
      };
    });
    h.reconcile.mockImplementation(async (request) => h.created(request.step.id));

    await expect(h.run()).resolves.toMatchObject({ status: 'in-progress', retryAfterMs: 4_000 });
    await expect(h.run()).resolves.toMatchObject({ status: 'failed', rollback: { status: 'succeeded' } });

    expect(h.stepCalls(h.apply, 'create-boot-runtime:rollback')).toBe(1);
    expect(h.stepCalls(h.apply, 'create-boot-runtime')).toBe(1);
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({ id: 'create-boot-runtime:rollback' }),
        previousProviderRequestId: 'rollback-op-1',
      }),
      expect.anything(),
    );
  });

  it('reaches the rollback when the re-create halts after spending its retries across turns', async () => {
    const h = upgradeHarness();
    h.apply.mockImplementation(async (request) => {
      if (request.step.id === 'delete-boot-runtime') return h.destroyed(request.step.id);
      if (request.step.id === 'create-boot-runtime') {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return h.created(request.step.id);
    });

    for (let turn = 0; turn < 3; turn += 1) {
      await expect(h.run()).resolves.toMatchObject({ status: 'in-progress' });
    }
    await expect(h.run()).resolves.toMatchObject({ status: 'failed', rollback: { status: 'succeeded' } });

    expect(h.stepCalls(h.apply, 'create-boot-runtime')).toBe(3);
    expect(h.stepCalls(h.apply, 'create-boot-runtime:rollback')).toBe(1);
  });

  it('does not roll back a failure that happened before the destructive step applied', async () => {
    const h = upgradeHarness();
    h.apply.mockRejectedValue(Object.assign(new Error('permission denied'), { status: 403 }));

    const result = await h.run();

    expect(result.status).toBe('failed');
    expect(result.rollback).toBeUndefined();
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.store.recordImage).not.toHaveBeenCalled();
    expect(h.checkpoints().map(({ logicalKey }) => logicalKey)).not.toContain('create-boot-runtime:rollback');
  });

  it('reports a rollback that failed too, without claiming the host was restored', async () => {
    const h = upgradeHarness();
    h.apply.mockImplementation(async (request) => {
      if (request.step.id === 'delete-boot-runtime') return h.destroyed(request.step.id);
      throw Object.assign(new Error(`refused ${request.step.id}`), { status: 400 });
    });

    const result = await h.run();

    expect(result).toMatchObject({
      status: 'failed',
      rollback: { stepId: 'create-boot-runtime', status: 'failed', error: 'refused create-boot-runtime:rollback' },
    });
    expect(result.requiresInitialization).toBeUndefined();
    expect(h.store.recordImage).not.toHaveBeenCalled();
    expect(h.store.updateOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        message: expect.stringContaining('NOT restored'),
        error: expect.objectContaining({ rolledBack: false, rollbackError: 'refused create-boot-runtime:rollback' }),
      }),
    );
  });
});

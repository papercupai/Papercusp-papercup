import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  makeFakeWorkspaceHostProvider,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import type { RouteContext } from '../endpoint-route/define-route';
import {
  createWorkspaceHostProvisionRoute,
  type WorkspaceHostProvisionRouteDependencies,
} from '../endpoint-route/routes/workspace-hosts/provision';
import type { GcpWorkspaceHostInventoryRequest, GcpWorkspaceHostInventorySnapshot } from './gcp-provider';
import { GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS, type GcpManagedWorkspaceHostResourceObservation } from './gcp-safety';
import { WorkspaceHostControllerFenceError } from './observability-store';
import {
  runWorkspaceHostDestroy,
  type RunWorkspaceHostDestroyInput,
  type WorkspaceHostDestroyCanaryEvidence,
  type WorkspaceHostDestroyStore,
  WorkspaceHostProvisioningRequestError,
} from './provisioning-runner';
import {
  BUNDLE,
  OTHER_BUNDLE,
  TASK_ID,
  builtReceipts,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import { WORKSPACE_HOST_BILLING_CLOSURE_STAGE } from './billing-closure-release-receipt';
import { WORKSPACE_HOST_RESOURCE_CENSUS_STAGE, openWorkspaceHostTeardownRelease } from './teardown-release-receipt';

const NOW = '2026-08-25T00:00:00.000Z';
const LATER = '2026-08-25T00:10:00.000Z';
const RUN_ID = 'canary_1';
const WORKSPACE_ID = 'workspace_1';

const labels = {
  papercusp_canary: 'true',
  papercusp_run_id: RUN_ID,
  papercusp_workspace_id: WORKSPACE_ID,
};

const desired: WorkspaceHostDesiredSpec = {
  hostId: 'host-1',
  target: 'gcp',
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
  labels,
};

const desiredWithManagedNetwork: WorkspaceHostDesiredSpec = {
  ...desired,
  provider: {
    network: {
      mode: 'managed',
      networkName: 'pc-host-net',
      subnetworkName: 'pc-host-subnet',
      firewallName: 'pc-host-iap',
      routerName: 'pc-host-router',
      natName: 'pc-host-nat',
    },
  },
};

const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};

const resources: readonly WorkspaceHostResourceRef[] = [
  { target: 'gcp', kind: 'vm', providerId: 'pc-host-vm', parentProviderId: 'project-1', zone: desired.zone },
  { target: 'gcp', kind: 'disk', providerId: 'pc-host-data', parentProviderId: 'project-1', zone: desired.zone },
  { target: 'gcp', kind: 'firewall', providerId: 'pc-host-iap', parentProviderId: 'project-1' },
  { target: 'gcp', kind: 'nat', providerId: 'pc-host-nat', parentProviderId: 'project-1', region: desired.region },
  {
    target: 'gcp',
    kind: 'router',
    providerId: 'pc-host-router',
    parentProviderId: 'project-1',
    region: desired.region,
  },
  {
    target: 'gcp',
    kind: 'subnetwork',
    providerId: 'pc-host-subnet',
    parentProviderId: 'project-1',
    region: desired.region,
  },
  { target: 'gcp', kind: 'network', providerId: 'pc-host-net', parentProviderId: 'project-1' },
];

function steps(knownResources: readonly WorkspaceHostResourceRef[] = resources): WorkspaceHostPlanStep[] {
  const ordered = ['vm', 'disk', 'firewall', 'nat', 'router', 'subnetwork', 'network'].flatMap((kind) =>
    knownResources.filter((resource) => resource.kind === kind),
  );
  return ordered.map((resource, index) => {
    const prior = ordered[index - 1];
    const id = `delete-${resource.kind}-${resource.providerId}`;
    return {
      id,
      action: 'destroy',
      resourceKind: resource.kind,
      dependsOn: prior ? [`delete-${prior.kind}-${prior.providerId}`] : [],
      idempotencyKey: `destroy:${resource.kind}`,
      destructive: true,
      input: { op: `delete-${resource.kind}`, resourceName: resource.providerId },
    };
  });
}

function providerHarness(options: { inventoryError?: Error } = {}) {
  const apply = vi.fn<WorkspaceHostProvider['apply']>(async (request): Promise<WorkspaceHostApplyResult> => {
    const providerResourceId = String(request.step.input.resourceName);
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'destroyed',
      observedAt: LATER,
      confirmation: {
        hostId: 'host-1',
        providerResourceId,
        confirmedAbsentAt: LATER,
        source: 'provider-read',
        providerRequestId: `operation:${providerResourceId}`,
      },
    };
  });
  const inventoryManagedResources = vi.fn(async (
    request: GcpWorkspaceHostInventoryRequest,
  ): Promise<GcpWorkspaceHostInventorySnapshot> => {
    if (options.inventoryError) throw options.inventoryError;
    const names = request.deterministicNames;
    return {
      complete: true as const,
      observed: [],
      inventoryEvidence: [
        { kind: 'vm' as const, strategy: 'managed-labels' as const, providerEvidenceRef: 'gcp://inventory/vm' },
        { kind: 'disk' as const, strategy: 'managed-labels' as const, providerEvidenceRef: 'gcp://inventory/disk' },
        {
          kind: 'firewall' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/firewall',
          deterministicNames: names.firewalls,
        },
        {
          kind: 'subnetwork' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/subnetwork',
          deterministicNames: names.subnetworks,
        },
        {
          kind: 'network' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/network',
          deterministicNames: names.networks,
        },
        {
          kind: 'snapshot' as const,
          strategy: 'managed-labels' as const,
          providerEvidenceRef: 'gcp://inventory/snapshot',
        },
        {
          kind: 'router' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/router',
          deterministicNames: names.routers,
        },
        {
          kind: 'nat' as const,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: 'gcp://inventory/nat',
          deterministicNames: names.nats.map(({ name }) => name),
        },
      ],
    };
  });
  const plan = vi.fn(async (request: Parameters<WorkspaceHostProvider['plan']>[0]) => ({
    planId: 'plan-destroy-1',
    operationId: request.operationId,
    target: 'gcp' as const,
    hostId: 'host-1',
    generatedAt: NOW,
    // Only the provision variant of the request union lacks `host`; this fake only plans destroys.
    steps: steps('host' in request ? request.host.resources : []),
    warnings: [],
  }));
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    validateConnection: vi.fn(async () => ({ ok: true, checkedAt: NOW, warnings: [], errors: [] })),
    plan,
    apply,
    reconcile: vi.fn<WorkspaceHostProvider['reconcile']>(),
    observe: vi.fn<WorkspaceHostProvider['observe']>(),
    inventoryManagedResources,
  });
  return { provider, apply, plan, inventoryManagedResources };
}

function storeHarness(
  targetDesired: WorkspaceHostDesiredSpec = desired,
  recoverability?: { kind: 'snapshot' | 'backup' | 'none'; label: string; updatedAt?: string },
  targetResources: readonly WorkspaceHostResourceRef[] = resources,
) {
  let checkpoints: WorkspaceHostResourceCheckpoint[] = [];
  const updateHostState = vi.fn<WorkspaceHostDestroyStore['updateHostState']>();
  const updateOperation = vi.fn<WorkspaceHostDestroyStore['updateOperation']>();
  const store: WorkspaceHostDestroyStore = {
    readTarget: vi.fn(async () => ({
      id: 'host-1',
      name: 'Canary host',
      connectionId: 'connection-1',
      target: 'gcp',
      observedState: 'running',
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 1,
      ...(recoverability ? { recoverability } : {}),
      desired: targetDesired,
      resources: targetResources.map((resource) => ({ resource, registeredAt: NOW })),
    })),
    readOperationPlan: vi.fn(async () => null),
    beginOperation: vi.fn(async () => {}),
    updateOperation,
    readCheckpoints: vi.fn(async () => checkpoints.map((entry) => ({ ...entry }))),
    upsertCheckpoint: vi.fn(async ({ checkpoint }) => {
      checkpoints = [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), { ...checkpoint }];
    }),
    appendEvent: vi.fn(async () => 'event-1'),
    recordSignals: vi.fn(async () => {}),
    updateHostState,
  };
  return { store, checkpoints: () => checkpoints, updateHostState, updateOperation };
}

function legacyInventorySnapshot(
  observed: readonly GcpManagedWorkspaceHostResourceObservation[] = resources.map(
    (resource): GcpManagedWorkspaceHostResourceObservation => ({
      resource,
      labels: ['vm', 'disk'].includes(resource.kind)
        ? {
            [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
            [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-1',
            [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: WORKSPACE_ID,
            purpose: 'legacy-canary',
          }
        : {},
      observedAt: NOW,
    }),
  ),
): GcpWorkspaceHostInventorySnapshot {
  const names = (kind: string) =>
    resources.filter((resource) => resource.kind === kind).map((resource) => resource.providerId);
  return {
    complete: true,
    observed,
    inventoryEvidence: [
      { kind: 'vm', strategy: 'managed-labels', providerEvidenceRef: 'gcp://inventory/vm' },
      { kind: 'disk', strategy: 'managed-labels', providerEvidenceRef: 'gcp://inventory/disk' },
      {
        kind: 'firewall',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/firewall',
        deterministicNames: names('firewall'),
      },
      {
        kind: 'subnetwork',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/subnetwork',
        deterministicNames: names('subnetwork'),
      },
      {
        kind: 'network',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/network',
        deterministicNames: names('network'),
      },
      { kind: 'snapshot', strategy: 'managed-labels', providerEvidenceRef: 'gcp://inventory/snapshot' },
      {
        kind: 'router',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/router',
        deterministicNames: names('router'),
      },
      {
        kind: 'nat',
        strategy: 'deterministic-name',
        providerEvidenceRef: 'gcp://inventory/nat',
        deterministicNames: names('nat'),
      },
    ],
  };
}

function runInput(provider: WorkspaceHostProvider, store: WorkspaceHostDestroyStore): RunWorkspaceHostDestroyInput {
  return {
    workspaceId: WORKSPACE_ID,
    hostId: 'host-1',
    connection,
    provider,
    disposition: 'discard',
    confirmation: { expectedHostId: 'host-1', confirmedBy: 'operator:test', confirmedAt: NOW },
    canary: {
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      contractApproval: {
        status: 'approved',
        suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        reportRef: 'report://gcp/fake-contract',
        approvedBy: 'operator:test',
        approvedAt: NOW,
      },
      maxSpendCents: 2_500,
      teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
      budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
      preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
      costEvidence: [{ cents: 71, observedAt: LATER, providerEvidenceRef: 'gcp://billing/settled' }],
      lateObservedSpend: [{ cents: 4, observedAt: LATER, providerEvidenceRef: 'gcp://billing/late' }],
      emergencyManualDestroy: {
        actorId: 'operator:test',
        reason: 'manual cleanup recovered by durable destroy',
        procedureRef: 'runbook://workspace-host/gcp/ambiguous-operation-recovery-v1',
      },
    },
    operationId: 'op-destroy-1',
    store,
  };
}

function ordinaryInput(
  provider: WorkspaceHostProvider,
  store: WorkspaceHostDestroyStore,
  disposition: RunWorkspaceHostDestroyInput['disposition'] = 'discard',
): RunWorkspaceHostDestroyInput {
  const { canary: _canary, ...input } = runInput(provider, store);
  return { ...input, disposition };
}

describe('runWorkspaceHostDestroy', () => {
  it('retires an ordinary non-canary host while preserving identity, receipts, and the clean provider census', async () => {
    const { provider, apply } = providerHarness();
    const ordinaryDesired = { ...desired, labels: undefined };
    const { store, updateHostState } = storeHarness(ordinaryDesired);

    const result = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(result.checkpoints).toHaveLength(resources.length);
    expect(result.checkpoints.every((entry) => entry.deletionConfirmation?.source === 'provider-read')).toBe(true);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      hostId: 'host-1',
      state: 'absent',
      recoverability: expect.objectContaining({ kind: 'none' }),
    }));
  });

  it('fills missing legacy GCP network census identities from the stored managed-network settings', async () => {
    const registeredResources = resources.filter((resource) => resource.kind === 'vm' || resource.kind === 'disk');
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const { store, updateHostState } = storeHarness(desiredWithManagedNetwork, undefined, registeredResources);

    const result = await runWorkspaceHostDestroy({ ...ordinaryInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(registeredResources.length);
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    expect(inventoryManagedResources.mock.calls[0]?.[0].deterministicNames).toEqual({
      networks: ['pc-host-net'],
      subnetworks: ['pc-host-subnet'],
      firewalls: ['pc-host-iap'],
      routers: ['pc-host-router'],
      nats: [{ routerName: 'pc-host-router', name: 'pc-host-nat' }],
    });
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('explains census-only recovery when a canary destroy has no registered resources', async () => {
    const { provider, plan, apply } = providerHarness();
    const { store, updateHostState } = storeHarness(desiredWithManagedNetwork, undefined, []);

    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [
        'canary destroy requires a non-empty registered resource population for completion evidence; to recover an empty host, submit a discard destroy without the canary block and with a fresh operation id to run a census-only teardown',
      ],
    });
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(updateHostState).not.toHaveBeenCalled();
  });

  it('retires an empty ordinary GCP host only after a complete clean provider census', async () => {
    const { provider, plan, apply, inventoryManagedResources } = providerHarness();
    const { store, updateHostState } = storeHarness(desiredWithManagedNetwork, undefined, []);

    const result = await runWorkspaceHostDestroy({ ...ordinaryInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('succeeded');
    expect(result.plan.steps).toEqual([]);
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    expect(inventoryManagedResources.mock.calls[0]?.[0].deterministicNames.networks).toEqual(['pc-host-net']);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('keeps an empty ordinary GCP host nonterminal when the complete census still observes its resource', async () => {
    const { provider, plan, apply, inventoryManagedResources } = providerHarness();
    const { store, updateHostState } = storeHarness(desiredWithManagedNetwork, undefined, []);
    const vm = legacyInventorySnapshot().observed.find(({ resource }) => resource.kind === 'vm')!;
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot([vm]));

    const result = await runWorkspaceHostDestroy({ ...ordinaryInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('completes ordinary teardown while another labelled host remains in the same workspace', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const { store, updateHostState } = storeHarness({ ...desired, labels: undefined });
    const foreignResources = legacyInventorySnapshot().observed
      .filter(({ resource }) => ['vm', 'disk'].includes(resource.kind))
      .map((entry) => ({
        ...entry,
        resource: { ...entry.resource, providerId: `other-${entry.resource.providerId}` },
        labels: { ...entry.labels, [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-2' },
      }));
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot(foreignResources));

    const result = await runWorkspaceHostDestroy({ ...ordinaryInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('succeeded');
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    expect(apply.mock.calls.map(([request]) => request.step.input.resourceName)).toEqual(
      resources.map((resource) => resource.providerId),
    );
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it.each(['host-1', 'host-2', ''])('rejects an ordinary registered survivor with host label %j and names it', async (hostLabel) => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation, updateHostState } = storeHarness({ ...desired, labels: undefined });
    const survivor = legacyInventorySnapshot().observed.find(({ resource }) => resource.kind === 'vm')!;
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot([{
      ...survivor,
      labels: { ...survivor.labels, [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: hostLabel },
    }]));

    const result = await runWorkspaceHostDestroy({ ...ordinaryInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
    const failure = updateOperation.mock.calls.map(([entry]) => entry).find((entry) => entry.status === 'failed');
    const reason = String((failure?.error as { reason?: unknown } | undefined)?.reason ?? '');
    expect(reason).toContain(survivor.resource.providerId);
    expect(reason).toContain(hostLabel === 'host-1' ? 'provider.untracked' : 'provider.labelMismatches');
  });

  it('persists a durable snapshot identity before deleting resources and projects it as the recovery point', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const snapshot: WorkspaceHostResourceRef = {
      target: 'gcp',
      kind: 'snapshot',
      providerId: 'pc-destroy-host-1-data',
      parentProviderId: 'project-1',
    };
    const preserveStep: WorkspaceHostPlanStep = {
      id: 'preserve-disk-pc-host-data',
      action: 'destroy',
      resourceKind: 'snapshot',
      dependsOn: [],
      idempotencyKey: 'destroy:snapshot',
      destructive: false,
      input: { op: 'create-snapshot', resourceName: snapshot.providerId },
    };
    const destroySteps = steps().map((step) => ({
      ...step,
      dependsOn: [preserveStep.id, ...step.dependsOn],
    }));
    vi.mocked(provider.plan).mockResolvedValue({
      planId: 'plan-destroy-1',
      operationId: 'op-destroy-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: NOW,
      steps: [preserveStep, ...destroySteps],
      warnings: [],
    });
    apply.mockImplementation(async (request) => {
      if (request.step.id === preserveStep.id) {
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'applied',
          observedAt: LATER,
          providerRequestId: 'operation:snapshot',
          snapshot: {
            target: 'gcp',
            providerId: snapshot.providerId,
            hostId: 'host-1',
            createdAt: LATER,
          },
        };
      }
      const providerResourceId = String(request.step.input.resourceName);
      return {
        operationId: request.operationId,
        stepId: request.step.id,
        state: 'destroyed',
        observedAt: LATER,
        confirmation: {
          hostId: 'host-1',
          providerResourceId,
          confirmedAbsentAt: LATER,
          source: 'provider-read',
          providerRequestId: `operation:${providerResourceId}`,
        },
      };
    });
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot([{
      resource: snapshot,
      labels: {
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-1',
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: WORKSPACE_ID,
      },
      observedAt: LATER,
    }]));
    const { store, checkpoints, updateHostState } = storeHarness({ ...desired, labels: undefined });

    const result = await runWorkspaceHostDestroy(ordinaryInput(provider, store, 'snapshot'));

    expect(result.status).toBe('succeeded');
    expect(checkpoints()).toHaveLength(resources.length + 1);
    expect(checkpoints()).toContainEqual(expect.objectContaining({
      logicalKey: preserveStep.id,
      state: 'applied',
      providerResource: expect.objectContaining({
        target: 'gcp',
        kind: 'snapshot',
        providerId: snapshot.providerId,
      }),
      providerRequestId: 'operation:snapshot',
    }));
    const snapshotPersisted = vi.mocked(store.upsertCheckpoint).mock.calls.findIndex(
      ([entry]) => entry.checkpoint.logicalKey === preserveStep.id && entry.checkpoint.state === 'applied',
    );
    const firstDelete = apply.mock.calls.findIndex(([request]) => request.step.destructive);
    expect(vi.mocked(store.upsertCheckpoint).mock.invocationCallOrder[snapshotPersisted]).toBeLessThan(
      apply.mock.invocationCallOrder[firstDelete] ?? 0,
    );
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      hostId: 'host-1',
      state: 'absent',
      recoverability: expect.objectContaining({
        kind: 'snapshot',
        label: snapshot.providerId,
        updatedAt: expect.any(String),
      }),
    }));
    expect(updateHostState).not.toHaveBeenLastCalledWith(expect.objectContaining({ discard: true }));
  });

  it('reconciles an ordinary ambiguous delete on replay without issuing the destructive request twice', async () => {
    const { provider, apply } = providerHarness();
    const reconcile = vi.mocked(provider.reconcile);
    const { store, checkpoints, updateHostState } = storeHarness({ ...desired, labels: undefined });
    apply.mockRejectedValueOnce(new Error('connection closed after delete request write'));
    reconcile.mockResolvedValue({
      operationId: 'op-destroy-1',
      stepId: steps()[0]!.id,
      state: 'destroyed',
      observedAt: LATER,
      providerRequestId: 'operation:pc-host-vm',
      confirmation: {
        hostId: 'host-1',
        providerResourceId: 'pc-host-vm',
        confirmedAbsentAt: LATER,
        source: 'provider-read',
        providerRequestId: 'operation:pc-host-vm',
      },
    });

    const first = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(first).toMatchObject({ status: 'in-progress' });
    expect(checkpoints().find((entry) => entry.logicalKey === steps()[0]!.id)).toMatchObject({
      logicalKey: steps()[0]!.id,
      state: 'failed',
      retryClass: 'ambiguous',
      error: 'connection closed after delete request write',
    });

    const replay = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(replay.status).toBe('succeeded');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'resume', step: expect.objectContaining({ id: steps()[0]!.id }) }),
      expect.anything(),
    );
    expect(apply.mock.calls.filter(([request]) => request.step.id === steps()[0]!.id)).toHaveLength(1);
    expect(checkpoints().every((entry) => entry.state === 'absent')).toBe(true);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('resumes a partially completed ordinary teardown from persisted receipts without re-deleting confirmed resources', async () => {
    const { provider, apply } = providerHarness();
    const reconcile = vi.mocked(provider.reconcile);
    const { store, checkpoints, updateHostState } = storeHarness({ ...desired, labels: undefined });
    const [vmStep, diskStep, firewallStep] = steps();
    apply
      .mockResolvedValueOnce({
        operationId: 'op-destroy-1',
        stepId: vmStep!.id,
        state: 'destroyed',
        observedAt: LATER,
        confirmation: {
          hostId: 'host-1',
          providerResourceId: 'pc-host-vm',
          confirmedAbsentAt: LATER,
          source: 'provider-read',
        },
      })
      .mockResolvedValueOnce({
        operationId: 'op-destroy-1',
        stepId: diskStep!.id,
        state: 'destroyed',
        observedAt: LATER,
        confirmation: {
          hostId: 'host-1',
          providerResourceId: 'pc-host-data',
          confirmedAbsentAt: LATER,
          source: 'provider-read',
        },
      })
      .mockRejectedValueOnce(new Error('provider accepted firewall delete before socket reset'));
    reconcile.mockResolvedValue({
      operationId: 'op-destroy-1',
      stepId: firewallStep!.id,
      state: 'destroyed',
      observedAt: LATER,
      confirmation: {
        hostId: 'host-1',
        providerResourceId: 'pc-host-iap',
        confirmedAbsentAt: LATER,
        source: 'provider-read',
      },
    });

    const partial = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(partial.status).toBe('in-progress');
    expect(checkpoints()).toEqual(expect.arrayContaining([
      expect.objectContaining({ logicalKey: vmStep!.id, state: 'absent' }),
      expect.objectContaining({ logicalKey: diskStep!.id, state: 'absent' }),
      expect.objectContaining({ logicalKey: firewallStep!.id, state: 'failed', retryClass: 'ambiguous' }),
    ]));

    const recovered = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(recovered.status).toBe('succeeded');
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'resume', step: expect.objectContaining({ id: firewallStep!.id }) }),
      expect.anything(),
    );
    expect(apply.mock.calls.filter(([request]) => request.step.id === vmStep!.id)).toHaveLength(1);
    expect(apply.mock.calls.filter(([request]) => request.step.id === diskStep!.id)).toHaveLength(1);
    expect(apply.mock.calls.filter(([request]) => request.step.id === firewallStep!.id)).toHaveLength(1);
    expect(checkpoints().every((entry) => entry.state === 'absent')).toBe(true);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('a resumed turn keeps the revision its first turn bound, after that turn advanced the host row (WI-10002786)', async () => {
    const { provider, apply } = providerHarness();
    const reconcile = vi.mocked(provider.reconcile);
    const { store } = storeHarness({ ...desired, labels: undefined });
    // What the real store does: beginOperation persists the request plan and advances the host's
    // desired revision, so the NEXT turn reads the advanced revision back from the host row.
    let hostRevision = 1;
    let persistedPlan: unknown = null;
    const readTarget = store.readTarget;
    store.readTarget = vi.fn(async (workspaceId: string, hostId: string) => {
      const target = await readTarget(workspaceId, hostId);
      return target ? { ...target, desiredRevision: hostRevision } : target;
    });
    store.readOperationPlan = vi.fn(async () => persistedPlan);
    const begin = vi.fn<WorkspaceHostDestroyStore['beginOperation']>(async (input) => {
      persistedPlan ??= (input.request as { plan?: unknown } | undefined)?.plan ?? null;
      hostRevision = Math.max(hostRevision, input.desiredRevision ?? hostRevision);
    });
    store.beginOperation = begin;
    const [vmStep, diskStep, firewallStep] = steps();
    const destroyed = (stepId: string, providerResourceId: string) => ({
      operationId: 'op-destroy-1',
      stepId,
      state: 'destroyed' as const,
      observedAt: LATER,
      confirmation: { hostId: 'host-1', providerResourceId, confirmedAbsentAt: LATER, source: 'provider-read' as const },
    });
    apply
      .mockResolvedValueOnce(destroyed(vmStep!.id, 'pc-host-vm'))
      .mockResolvedValueOnce(destroyed(diskStep!.id, 'pc-host-data'))
      .mockRejectedValueOnce(new Error('provider accepted firewall delete before socket reset'));
    reconcile.mockResolvedValue(destroyed(firewallStep!.id, 'pc-host-iap'));

    const partial = await runWorkspaceHostDestroy(ordinaryInput(provider, store));
    expect(partial.status).toBe('in-progress');
    expect(hostRevision).toBe(2);

    const recovered = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(recovered.status).toBe('succeeded');
    const keys = vi.mocked(provider.plan).mock.calls.map(([request]) => request.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(':revision:2:');
    expect(keys[1]).toBe(keys[0]);
    expect(begin.mock.calls.map(([input]) => input.desiredRevision)).toEqual([2, 2]);
    const planIds = begin.mock.calls.map(([input]) => (input.request as { plan: { planId: string } }).plan.planId);
    expect(planIds[1]).toBe(planIds[0]);
  });

  it('a resumed turn plans against the population as its operation began, not after its own deletions (WI-10007034)', async () => {
    const { provider, apply } = providerHarness();
    const reconcile = vi.mocked(provider.reconcile);
    const harness = storeHarness({ ...desired, labels: undefined });
    const { store } = harness;
    // What the real store does: a resource is registered iff its LATEST row says it exists, so the
    // operation's own confirmed-absent checkpoints unregister what it already deleted, unless the
    // read asks for the population as of the operation's start.
    const readTarget = store.readTarget;
    store.readTarget = vi.fn(async (workspaceId, hostId, tx, options) => {
      const target = await readTarget(workspaceId, hostId, tx, options);
      if (!target || options?.asOfOperationStart === 'op-destroy-1') return target;
      const deleted = new Set(
        harness
          .checkpoints()
          .filter((entry) => entry.state === 'absent' && entry.providerResource)
          .map((entry) => entry.providerResource!.providerId),
      );
      return { ...target, resources: target.resources.filter((entry) => !deleted.has(entry.resource.providerId)) };
    });
    // What the real store does on a re-begin of an existing operation: a different request is refused.
    let firstRequest: string | null = null;
    store.beginOperation = vi.fn<WorkspaceHostDestroyStore['beginOperation']>(async (input) => {
      const request = JSON.stringify(input.request);
      firstRequest ??= request;
      if (request !== firstRequest) {
        throw new WorkspaceHostControllerFenceError('host-1', `operation '${input.operationId}' already exists with a different request`);
      }
    });
    const [vmStep, diskStep, firewallStep] = steps();
    const destroyed = (stepId: string, providerResourceId: string) => ({
      operationId: 'op-destroy-1',
      stepId,
      state: 'destroyed' as const,
      observedAt: LATER,
      confirmation: { hostId: 'host-1', providerResourceId, confirmedAbsentAt: LATER, source: 'provider-read' as const },
    });
    apply
      .mockResolvedValueOnce(destroyed(vmStep!.id, 'pc-host-vm'))
      .mockResolvedValueOnce(destroyed(diskStep!.id, 'pc-host-data'))
      .mockRejectedValueOnce(new Error('bg-host restarted mid firewall delete'));
    reconcile.mockResolvedValue(destroyed(firewallStep!.id, 'pc-host-iap'));

    const partial = await runWorkspaceHostDestroy(ordinaryInput(provider, store));
    expect(partial.status).toBe('in-progress');
    expect(harness.checkpoints().filter((entry) => entry.state === 'absent').map((entry) => entry.providerResource?.providerId))
      .toEqual(expect.arrayContaining(['pc-host-vm', 'pc-host-data']));

    const recovered = await runWorkspaceHostDestroy(ordinaryInput(provider, store));

    expect(recovered.status).toBe('succeeded');
    expect(vi.mocked(store.readTarget).mock.calls.map(([, , , options]) => options)).toEqual([
      { asOfOperationStart: 'op-destroy-1' },
      { asOfOperationStart: 'op-destroy-1' },
    ]);
    const planned = vi.mocked(provider.plan).mock.calls.map(([request]) =>
      'host' in request ? request.host.resources.map((resource) => resource.providerId) : [],
    );
    expect(planned[1]).toEqual(planned[0]);
    expect(planned[1]).toEqual(expect.arrayContaining(['pc-host-vm', 'pc-host-data']));
    // The finished deletions are skipped by checkpoint, never re-applied.
    expect(apply.mock.calls.filter(([request]) => request.step.id === vmStep!.id)).toHaveLength(1);
    expect(apply.mock.calls.filter(([request]) => request.step.id === diskStep!.id)).toHaveLength(1);
  });

  it('rejects missing disposition, cross-host ownership, and an unverified backup before provider planning', async () => {
    const { provider } = providerHarness();
    const { store } = storeHarness({ ...desired, labels: undefined });
    await expect(runWorkspaceHostDestroy({
      ...ordinaryInput(provider, store),
      disposition: undefined as never,
    })).rejects.toMatchObject({ problems: [expect.stringContaining('disposition')] });
    await expect(runWorkspaceHostDestroy({
      ...ordinaryInput(provider, store),
      hostId: 'host-other',
      confirmation: { expectedHostId: 'host-other', confirmedBy: 'operator:test', confirmedAt: NOW },
    })).rejects.toMatchObject({ problems: [expect.stringContaining('identity')] });
    await expect(runWorkspaceHostDestroy(ordinaryInput(provider, store, 'backup'))).rejects.toMatchObject({
      problems: [expect.stringContaining('recorded durable backup')],
    });
    await expect(runWorkspaceHostDestroy({ ...runInput(provider, store), disposition: 'snapshot' })).rejects.toMatchObject({
      problems: [expect.stringContaining('canary destroy requires disposition=discard')],
    });
    expect(provider.plan).not.toHaveBeenCalled();
  });

  it('persists matching provider-read receipts and completes only after non-vacuous clean census + cost proof', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const { store, checkpoints, updateHostState, updateOperation } = storeHarness();

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result).toMatchObject({
      status: 'succeeded',
      evidence: {
        completionReceipt: { resourceCount: 7, spentCents: 75 },
        providerCensus: { controllerIndependent: true, inventoryComplete: true, clean: true },
        orphanCensus: { clean: true },
        manualDestroyReceipts: Array(7).fill(
          expect.objectContaining({ kind: 'workspace-host-emergency-manual-destroy' }),
        ),
      },
    });
    expect(apply).toHaveBeenCalledTimes(7);
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    expect(checkpoints()).toHaveLength(7);
    for (const checkpoint of checkpoints()) {
      expect(checkpoint).toMatchObject({
        state: 'absent',
        providerResource: { providerId: checkpoint.deletionConfirmation?.providerResourceId },
        deletionConfirmation: { source: 'provider-read' },
      });
    }
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
    const successUpdate = updateOperation.mock.calls.findIndex(([entry]) => entry.status === 'succeeded');
    const evidenceEvent = vi
      .mocked(store.appendEvent)
      .mock.calls.findIndex(([entry]) => entry.phase === 'destroy-evidence');
    expect(updateHostState.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      updateOperation.mock.invocationCallOrder[successUpdate] ?? 0,
    );
    expect(updateHostState.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      vi.mocked(store.appendEvent).mock.invocationCallOrder[evidenceEvent] ?? 0,
    );
  });

  it('fails closed when the all-kind provider inventory cannot be read', async () => {
    const { provider } = providerHarness({ inventoryError: new Error('403 compute.disks.list denied') });
    const { store, updateHostState, updateOperation } = storeHarness();

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result.status).toBe('failed');
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
    expect(updateOperation).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', percent: 99 }));
  });

  // The r39 destroy (2026-09-24) stored `{ reason: 'fetch failed' }` and nothing else, so its
  // census failure could not tell a connect timeout from a closed socket. WI-10003514: the same
  // blip (measured as ETIMEDOUT on owner-wait-20260916, twice) used to END a teardown whose every
  // resource already had its provider-read absence receipt, at failed/99, until someone re-POSTed it.
  it('keeps a finished teardown running on a transient census read, naming the transport CAUSE CODE, and completes on the re-read', async () => {
    const inventoryError = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
    });
    const { provider, apply, inventoryManagedResources } = providerHarness();
    inventoryManagedResources.mockRejectedValueOnce(inventoryError);
    const { store, updateHostState, updateOperation } = storeHarness();

    const first = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(first).toMatchObject({ status: 'in-progress', retryAfterMs: expect.any(Number) });
    expect(updateOperation).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running', percent: 99 }));
    expect(updateOperation).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(store.appendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'destroy-evidence',
        status: 'running',
        level: 'warn',
        details: { error: 'fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)' },
      }),
    );
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
    const deletesBeforeReplay = apply.mock.calls.length;

    const replay = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(replay.status).toBe('succeeded');
    // The re-read is a census, not a second teardown: no destructive request is re-issued.
    expect(apply.mock.calls.length).toBe(deletesBeforeReplay);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('still fails closed on a NON-transient terminal census error', async () => {
    const { provider } = providerHarness({ inventoryError: new Error('Provider managed-resource inventory is incomplete') });
    const { store, updateOperation } = storeHarness();

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result.status).toBe('failed');
    expect(updateOperation).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', percent: 99 }));
  });

  it('rejects invalid cumulative evidence before planning or deleting any provider resource', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const input = runInput(provider, store);
    input.canary = {
      ...input.canary!,
      costEvidence: [{ cents: 2_501, observedAt: LATER, providerEvidenceRef: 'gcp://billing/over-ceiling' }],
      lateObservedSpend: [],
    };

    await expect(runWorkspaceHostDestroy(input)).rejects.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('permits explicitly audited cleanup of a pre-tagging canary only after an exact pre-delete census', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    let inventoryCalls = 0;
    inventoryManagedResources.mockImplementation(async () => {
      inventoryCalls += 1;
      return inventoryCalls === 1 ? legacyInventorySnapshot() : legacyInventorySnapshot([]);
    });
    const legacyDesired: WorkspaceHostDesiredSpec = {
      ...desired,
      labels: { purpose: 'legacy-canary' },
    };
    const { store } = storeHarness(legacyDesired);

    const result = await runWorkspaceHostDestroy(runInput(provider, store));

    expect(result.status).toBe('succeeded');
    expect(inventoryManagedResources).toHaveBeenCalledTimes(2);
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          labelAdmission: {
            mode: 'legacy-manual-purpose',
            purpose: 'legacy-canary',
            preDeleteCensus: 'controller-independent-exact-population',
          },
        }),
      }),
    );
    expect(apply).toHaveBeenCalledTimes(resources.length);
  });

  it('fails closed before planning when a legacy canary census finds an extra managed resource', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const extra = {
      resource: { ...resources[0]!, providerId: 'foreign-vm' },
      labels: {
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-1',
        [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: WORKSPACE_ID,
        purpose: 'legacy-canary',
      },
      observedAt: NOW,
    } satisfies GcpWorkspaceHostInventorySnapshot['observed'][number];
    inventoryManagedResources.mockResolvedValue(
      legacyInventorySnapshot([...legacyInventorySnapshot().observed, extra]),
    );
    const { store } = storeHarness({ ...desired, labels: { purpose: 'legacy-canary' } });

    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [expect.stringContaining('clean pre-delete provider identity census')],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  // WI-1762411: a destroy that deleted everything reported `failed` at percent=99 because the
  // terminal census was single-shot. Provider list reads are eventually consistent and the network
  // is deleted LAST, so the census could still see a resource whose delete had been confirmed.
  it('re-reads a terminal census that still shows a resource mid-deletion instead of failing a completed teardown', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation, updateHostState } = storeHarness();
    // First terminal read still sees the resources; the second is the harness default — clean.
    inventoryManagedResources.mockImplementationOnce(async () => legacyInventorySnapshot());

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 400 });

    expect(result.status).toBe('succeeded');
    expect(inventoryManagedResources).toHaveBeenCalledTimes(2);
    expect(updateOperation.mock.calls.some(([entry]) => entry.status === 'failed')).toBe(false);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
  });

  it('still fails a terminal census that is unclean at the settle deadline, naming the census and the resource', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation } = storeHarness();
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot());

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    expect(inventoryManagedResources).toHaveBeenCalledOnce();
    const failure = updateOperation.mock.calls.map(([entry]) => entry).find((entry) => entry.status === 'failed');
    const failureError = failure?.error as { reason?: unknown } | undefined;
    const reason = String(failureError?.reason ?? '');
    // The old message named neither which census failed nor what it saw.
    expect(reason).toMatch(/census is not clean after 1 read\(s\)/);
    expect(reason).toMatch(/(provider|orphan)\.\w+=\[/);
    expect(reason).toContain('pc-host-');
  });

  // The terminal census omitted this host's registry, so a SIBLING host's labelled resources in the
  // same workspace read as label mismatches: the r40 canary destroy deleted all seven resources and
  // still failed on the live r39 soak host's VM, disk and snapshots. The test above is the control —
  // this host's own survivors must still fail it.
  it('completes a canary destroy while another labelled host remains in the same workspace', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateHostState } = storeHarness();
    const foreignResources = legacyInventorySnapshot().observed
      .filter(({ resource }) => ['vm', 'disk'].includes(resource.kind))
      .map((entry) => ({
        ...entry,
        resource: { ...entry.resource, providerId: `other-${entry.resource.providerId}` },
        labels: { ...entry.labels, [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: 'host-2' },
      }));
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot(foreignResources));

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 0 });

    expect(result).toMatchObject({
      status: 'succeeded',
      evidence: { providerCensus: { clean: true, labelMismatches: [] } },
    });
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
  });

  // WI-2143626: a FAILED destroy discarded the one artefact that says what is still RECLAIMABLE.
  // The destroy census runs with `expected: []`, so every managed resource still visible lands in
  // `reaperPlan` carrying a reclaim state (and, while quarantined, the instant it becomes eligible).
  // `reaperPlan` has no production consumer anywhere — only this message — so if it is not named
  // here it is not recoverable at all. That is why p046-canary-04..07 left networks, subnets, Cloud
  // NAT routers and 4x100GiB disks billing for days, found only by a by-hand six-kind census.
  it('names what is still RECLAIMABLE, not merely what is still live, when a destroy fails', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation } = storeHarness();
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot());

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    const failure = updateOperation.mock.calls.map(([entry]) => entry).find((entry) => entry.status === 'failed');
    const reason = String((failure?.error as { reason?: unknown } | undefined)?.reason ?? '');
    // The survivors were first observed at NOW, far outside the 60s orphan grace by the time the
    // census evaluates, so the plan's verdict is that they are reclaimable RIGHT NOW. Losing that
    // verdict — not losing the resource list — is what made the strandage undiscoverable.
    expect(reason).toContain('provider.reapEligible=[');
    expect(reason).toMatch(/provider\.reapEligible=\[[^\]]*pc-host-/);
    // CONTROL: the reclaim verdict must be ADDITIVE to the survivor list, never a relabelling of it.
    // Without both assertions a regression that merely renamed `provider.untracked` would pass.
    expect(reason).toContain('provider.untracked=[');
  });
});

// WI-10002510: the terminal census IS the `teardown.resource-census` release evidence, so a destroy
// named as acceptance evidence records it — from the census it actually took, never from "succeeded".
describe('runWorkspaceHostDestroy release census receipt', () => {
  function releaseStore() {
    return memoryReleaseLedger(
      labelJournal([...builtReceipts(), receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`], 2)]),
    );
  }

  function recorded(store: ReturnType<typeof releaseStore>, bundle = BUNDLE): Pick<
    RunWorkspaceHostDestroyInput,
    'releaseTaskId' | 'openRelease'
  > {
    return {
      releaseTaskId: TASK_ID,
      openRelease: (input) =>
        openWorkspaceHostTeardownRelease({ ...input, ledger: store, readHostRuntimeRelease: async () => ({ bundleSha256: bundle }) }),
    };
  }

  // D-395: billing closes only from the reconciler's reading of a DEFERRED canary settlement, so a
  // release-bound destroy is always a canary destroy that defers it.
  function releaseInput(provider: WorkspaceHostProvider, store: WorkspaceHostDestroyStore): RunWorkspaceHostDestroyInput {
    const input = runInput(provider, store);
    return {
      ...input,
      canary: {
        ...input.canary!,
        costEvidence: [],
        lateObservedSpend: [],
        spendSettlement: {
          status: 'deferred',
          actorId: 'operator:test',
          reason: 'provider billing has not settled; GCP lags hours behind teardown',
          procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
          reconcileAfter: '2026-08-26T00:00:00.000Z',
        },
      },
    };
  }

  function receiptsFor(journal: ReturnType<typeof releaseStore>, stage: string) {
    return journal.journal.receipts.filter((entry) => entry.stage === stage);
  }

  it('commits teardown.resource-census from the clean eight-kind terminal census, naming the destroy', async () => {
    const { provider } = providerHarness();
    const { store } = storeHarness();
    const journal = releaseStore();

    const result = await runWorkspaceHostDestroy({ ...releaseInput(provider, store), ...recorded(journal) });

    expect(result.status).toBe('succeeded');
    expect(receiptsFor(journal, WORKSPACE_HOST_RESOURCE_CENSUS_STAGE).at(-1)).toMatchObject({
      state: 'committed',
      evidenceRefs: expect.arrayContaining([
        'destroy-operation:op-destroy-1',
        'census-disposition:discard',
        'census-kind:nat:deterministic-name:gcp://inventory/nat',
      ]),
    });
  });

  // WI-10003514: refusing here would turn one transport blip into a refused teardown receipt for a
  // release whose teardown then completes on the re-read.
  it('leaves the census and billing stages pending on a transient census read, then commits on the re-read', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    inventoryManagedResources.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' } }),
    );
    const { store } = storeHarness();
    const journal = releaseStore();

    const first = await runWorkspaceHostDestroy({ ...releaseInput(provider, store), ...recorded(journal) });

    expect(first.status).toBe('in-progress');
    for (const stage of [WORKSPACE_HOST_RESOURCE_CENSUS_STAGE, WORKSPACE_HOST_BILLING_CLOSURE_STAGE]) {
      expect(receiptsFor(journal, stage).some((entry) => entry.state === 'refused')).toBe(false);
    }

    const replay = await runWorkspaceHostDestroy({ ...releaseInput(provider, store), ...recorded(journal) });

    expect(replay.status).toBe('succeeded');
    expect(receiptsFor(journal, WORKSPACE_HOST_RESOURCE_CENSUS_STAGE).at(-1)).toMatchObject({ state: 'committed' });
  });

  it('opens billing.closure for the reconciler and points the persisted cost signal at it', async () => {
    const { provider } = providerHarness();
    const { store } = storeHarness();
    const journal = releaseStore();

    const result = await runWorkspaceHostDestroy({ ...releaseInput(provider, store), ...recorded(journal) });

    expect(result.status).toBe('succeeded');
    // Opened, never settled here: the destroy cannot know the final spend.
    expect(receiptsFor(journal, WORKSPACE_HOST_BILLING_CLOSURE_STAGE).map((entry) => entry.state)).toEqual(['intent']);
    expect(store.recordSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        costSignals: [
          expect.objectContaining({
            runId: RUN_ID,
            spendSettlement: expect.objectContaining({ status: 'deferred' }),
            releaseClosure: {
              schemaVersion: 'workspace-host-release-closure-v1',
              releaseTaskId: TASK_ID,
              runRef: 'destroy-operation:op-destroy-1',
              runId: RUN_ID,
              maxSpendCents: 2_500,
            },
          }),
        ],
      }),
    );
  });

  it.each([
    ['no canary cost evidence', (provider: WorkspaceHostProvider, store: WorkspaceHostDestroyStore) => ordinaryInput(provider, store)],
    ['spend settled at teardown by cited evidence', (provider: WorkspaceHostProvider, store: WorkspaceHostDestroyStore) => runInput(provider, store)],
  ])('refuses a release-bound destroy with %s before the journal or the provider is touched', async (_label, build) => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const journal = releaseStore();
    const cursor = journal.journal.cursor;
    const openRelease = vi.fn(recorded(journal).openRelease!);

    await expect(
      runWorkspaceHostDestroy({ ...build(provider, store), releaseTaskId: TASK_ID, openRelease }),
    ).rejects.toMatchObject({ problems: [expect.stringContaining('D-395')] });
    expect(openRelease).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(journal.journal.cursor).toBe(cursor);
  });

  it('settles the census receipt refused when the terminal census is unclean, and names only the failure class', async () => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store } = storeHarness();
    inventoryManagedResources.mockResolvedValue(legacyInventorySnapshot());
    const journal = releaseStore();

    const result = await runWorkspaceHostDestroy({ ...releaseInput(provider, store), censusSettleMs: 0, ...recorded(journal) });

    expect(result.status).toBe('failed');
    // Both stages the destroy opened are refused: a teardown that did not finish closes no billing.
    for (const stage of [WORKSPACE_HOST_RESOURCE_CENSUS_STAGE, WORKSPACE_HOST_BILLING_CLOSURE_STAGE]) {
      const settled = receiptsFor(journal, stage).at(-1)!;
      expect(settled.state).toBe('refused');
      expect(settled.evidenceRefs).toEqual(['reconcile:confirmed-absent', 'destroy-operation:op-destroy-1', 'destroy-failure:Error']);
    }
    expect(store.recordSignals).not.toHaveBeenCalled();
  });

  it('refuses the destroy before any provider call when the host runs other bytes than the release', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness({ ...desired, labels: undefined });
    const journal = releaseStore();
    const cursor = journal.journal.cursor;

    await expect(
      runWorkspaceHostDestroy({ ...releaseInput(provider, store), ...recorded(journal, OTHER_BUNDLE) }),
    ).rejects.toMatchObject({ problems: [expect.stringContaining('bundle')] });
    expect(store.beginOperation).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(journal.journal.cursor).toBe(cursor);
  });
});

// WI-2143805: a canary host could not be destroyed through the product route at all — destroy
// admission demanded an approved contract report, settled cumulative cost, and a provider-delayed
// observed-spend entry, so the hosts most in need of teardown were exactly the ones the product
// refused to tear down and the operator had to reach around it with a script.
//
// D-274 splits that into two ORTHOGONAL axes, and these cases pin both, in both directions:
//   AUTHORIZATION — contractApproval (run completed) XOR failedRunTeardown (run failed, so the
//     approved contract report cannot exist).
//   SETTLEMENT    — absent means provider billing has settled and both cost fields are required;
//     spendSettlement means it has not, which for a short-lived canary is the NORMAL case.
// Neither axis may be inferred from the other: a failed run still spends money, and that money
// settles on the provider's clock exactly like a successful run's.
//
// Identity (canary labels + pre-delete census) is waived by neither. A test that only proved the
// new paths work would pass equally against a build that simply deleted the requirements, so every
// admitting case below is paired with the refusal that calibrates it.
describe('runWorkspaceHostDestroy evidence axes (D-274)', () => {
  const deferredSettlement = {
    status: 'deferred' as const,
    actorId: 'operator:test',
    reason: 'provider billing has not settled; GCP lags hours behind teardown',
    procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
    reconcileAfter: '2026-08-26T00:00:00.000Z',
  };

  // A failed run: no approved contract report (never will be) AND no settled spend (not yet).
  const failedRunCanary = (): WorkspaceHostDestroyCanaryEvidence => ({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    maxSpendCents: 2_500,
    teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
    budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
    preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
    costEvidence: [],
    spendSettlement: deferredSettlement,
    failedRunTeardown: {
      actorId: 'operator:test',
      reason: 'canary run failed during bootstrap; the host must still be torn down',
      procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
      failedOperationIds: ['op-run-1'],
    },
  });

  // canary-15's case: the run SUCCEEDED — provisioned, upgraded, SSH serving — so it HAS an approved
  // contract report. It was undestroyable purely because the spend had not settled yet, and
  // `lateObservedSpend` is by definition learned only AFTER the settle. This is what part 2 fixes.
  const settledLaterCanary = (): WorkspaceHostDestroyCanaryEvidence => ({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    contractApproval: {
      status: 'approved',
      suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
      reportRef: 'report://gcp/fake-contract',
      approvedBy: 'operator:test',
      approvedAt: NOW,
    },
    maxSpendCents: 2_500,
    teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
    budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
    preRunZeroBaseline: { cents: 0, observedAt: NOW, providerEvidenceRef: 'gcp://billing/baseline-zero' },
    costEvidence: [],
    spendSettlement: deferredSettlement,
  });

  it('destroys a host whose run SUCCEEDED but whose spend has not settled (canary-15)', async () => {
    const { provider, apply } = providerHarness();
    const { store, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), canary: settledLaterCanary() });

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
    // The receipt still cites the approved contract report — the run DID complete — and additionally
    // marks its spend provisional, so no reader reports spentCents:0 as this host's final cost.
    expect(result.evidence?.completionReceipt).toMatchObject({
      contractReportRef: 'report://gcp/fake-contract',
      spentCents: 0,
      spendSettlement: { status: 'deferred', reconcileAfter: '2026-08-26T00:00:00.000Z' },
    });
    // The obligation is hoisted onto the persisted signal so a sweep can FIND who owes one.
    expect(store.recordSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        costSignals: [expect.objectContaining({ spendSettlement: expect.objectContaining({ status: 'deferred' }) })],
      }),
    );
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          spendAdmission: {
            mode: 'deferred-settlement',
            waives: 'settled-cost-evidence-only',
            actorId: 'operator:test',
            procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
            reconcileAfter: '2026-08-26T00:00:00.000Z',
          },
        }),
      }),
    );
  });

  // Calibration for the case above: authorization alone does NOT waive the economics. Without the
  // settlement attestation the identical payload is still refused — so the axes really are separate,
  // and part 2 is not just "the cost requirement was deleted".
  it('still refuses a successful-run payload with empty economics and no settlement attestation', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const { spendSettlement: _deferred, ...withoutSettlement } = settledLaterCanary();

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary: withoutSettlement }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.stringContaining('at least one named cumulative cost entry'),
        expect.stringContaining('provider-delayed observed spend entry'),
      ]),
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  // The deferral is an obligation, not a hole: it must name who deferred it and when it comes due.
  it('refuses a settlement deferral that names no reconciliation date', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const canary = {
      ...settledLaterCanary(),
      spendSettlement: { ...deferredSettlement, reconcileAfter: 'whenever' },
    } satisfies WorkspaceHostDestroyCanaryEvidence;

    await expect(runWorkspaceHostDestroy({ ...runInput(provider, store), canary })).rejects.toMatchObject({
      problems: [expect.stringContaining('canary.spendSettlement.reconcileAfter')],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('destroys a failed-canary host on evidence a failed run can actually produce', async () => {
    const { provider, apply } = providerHarness();
    const { store, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() });

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'absent', discard: true }));
    // The receipt cites the audited procedure and carries NO contract report ref — a reader of the
    // persisted signal can tell a failed-run teardown from a completed canary without guessing.
    expect(result.evidence?.completionReceipt).toMatchObject({
      spentCents: 0,
      resourceCount: resources.length,
      failedRunTeardown: { procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1' },
    });
    expect(result.evidence?.completionReceipt.contractReportRef).toBeUndefined();
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          // D-274: this authorization waives the approved contract report and NOTHING about spend —
          // the failed run's own spend is deferred by the separate settlement axis, recorded beside
          // it. Before D-274 this row claimed 'economic-evidence-only', conflating the two.
          evidenceAdmission: {
            mode: 'failed-run-teardown',
            waives: 'approved-contract-report-only',
            actorId: 'operator:test',
            procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
            failedOperationIds: ['op-run-1'],
          },
          spendAdmission: expect.objectContaining({ mode: 'deferred-settlement' }),
        }),
      }),
    );
  });

  // Calibration for the AUTHORIZATION axis, mirroring the settlement one above. A settled-spend
  // attestation does not stand in for the missing contract report: strip the authorization and the
  // ledger still refuses, so neither axis silently covers for the other.
  it('still refuses when the run produced no contract report and no failed-run authorization', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness();
    const { failedRunTeardown: _authorization, ...withoutAuthorization } = failedRunCanary();

    await expect(
      runWorkspaceHostDestroy({
        ...runInput(provider, store),
        // Cast: the union forbids this shape at compile time, which is the point — this asserts the
        // RUNTIME gate holds too, for a caller reaching the route with untyped JSON.
        canary: withoutAuthorization as unknown as WorkspaceHostDestroyCanaryEvidence,
      }),
    ).rejects.toMatchObject({
      problems: [expect.stringContaining('contract report is approved')],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not waive identity: a canary label that disagrees with the run still refuses', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness({ ...desired, labels: { ...labels, papercusp_run_id: 'canary_someone_else' } });

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() }),
    ).rejects.toMatchObject({
      problems: [expect.stringContaining(`papercusp_run_id=${RUN_ID}`)],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  // The two waivers stay disjoint. emergencyManualDestroy is the LABEL waiver for a host
  // provisioned before the canary tag contract existed; failedRunTeardown waives economics only.
  // Neither may stand in for the other, or one request could drop both proofs at once.
  it('does not waive the canary labels a pre-tagging host is missing — that is still the manual path', async () => {
    const { provider, apply } = providerHarness();
    const { store } = storeHarness({ ...desired, labels: { purpose: 'legacy-canary' } });

    await expect(
      runWorkspaceHostDestroy({ ...runInput(provider, store), canary: failedRunCanary() }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.stringContaining('papercusp_canary=true')]),
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

/**
 * WI-2144027 — the identity labels must come from the PRODUCTION provision path.
 *
 * Every other test in this file hands the destroy runner a `desired` whose canary labels the test
 * itself wrote (the `labels` fixture at the top). That is exactly how the defect shipped: the only
 * writer of these keys anywhere in the tree was the fake-provider harness, so the suite was green
 * because the harness satisfied the gate on the product's behalf, while every real GCP canary was
 * born with no labels at all and could not be destroyed through the product route.
 *
 * These tests never write a canary label. They drive the real `POST /workspace-hosts/provision`
 * handler, capture the spec IT persisted, and feed exactly that into the real destroy runner — so
 * if the provision route stops synthesizing the labels, the round trip fails here.
 */
describe('canary identity survives provision → destroy (WI-2144027)', () => {
  const PROVISION_CTX: RouteContext = {
    principal: null,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  };

  /**
   * A complete pre-run economic admission for `runId`. Provision refuses a canary declared by runId
   * alone since `validateWorkspaceHostCanaryAdmission` (dae49a2ce2); the admission carries evidence,
   * never labels, so the round trip below still proves the route synthesizes the identity labels.
   */
  function admission(runId: string = RUN_ID): Record<string, unknown> {
    const { canary } = runInput(providerHarness().provider, storeHarness().store);
    return {
      runId,
      workspaceId: WORKSPACE_ID,
      maxSpendCents: canary!.maxSpendCents,
      teardownDeadlineAt: canary!.teardownDeadlineAt,
      budgetEvidenceRef: canary!.budgetEvidenceRef,
      preRunZeroBaseline: canary!.preRunZeroBaseline,
      contractApproval: canary!.contractApproval,
    };
  }

  /** The fixture spec with the canary labels REMOVED — a caller never supplies them. */
  function requestedDesired(): Record<string, unknown> {
    const request: Record<string, unknown> = { ...(desired as unknown as Record<string, unknown>) };
    delete request.labels;
    return request;
  }

  async function provision(body: Record<string, unknown>): Promise<{
    response: Response;
    persisted?: WorkspaceHostDesiredSpec;
  }> {
    let persisted: WorkspaceHostDesiredSpec | undefined;
    const dependencies: WorkspaceHostProvisionRouteDependencies = {
      activeWorkspaceId: () => WORKSPACE_ID,
      provisioningAvailable: () => true,
      readConnection: async () => ({
        id: 'connection-1',
        target: 'gcp',
        status: 'connected' as const,
        connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' } },
      }),
      // WI-10006929: the admission-time spent-id read; host-1 is fresh in this fixture.
      readSpentHostId: async () => null,
      startProvisioning: async (input) => {
        persisted = input.desired;
        return {
          status: 'succeeded' as const,
          operationId: 'op-provision-1',
          hostId: 'host-1',
          plan: {
            planId: 'plan-1',
            operationId: 'op-provision-1',
            target: 'gcp' as const,
            hostId: 'host-1',
            generatedAt: NOW,
            steps: [],
            warnings: [],
          },
          checkpoints: [],
        };
      },
    };
    const response = await createWorkspaceHostProvisionRoute(dependencies).handler(
      new Request('http://operator.test/api/workspace-hosts/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      PROVISION_CTX,
    );
    return { response, persisted };
  }

  it('destroys a host whose labels the provision route wrote — this test writes none', async () => {
    const { response, persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Canary host',
      desired: requestedDesired(),
      canary: admission(),
    });
    expect(response.status).toBe(201);
    // Derived by the operator from the declared run and its own workspace. Nothing in this file
    // supplied them, which is what makes the round trip below evidence rather than assertion.
    expect(persisted?.labels).toEqual({
      papercusp_canary: 'true',
      papercusp_run_id: RUN_ID,
      papercusp_workspace_id: WORKSPACE_ID,
    });

    const { provider } = providerHarness();
    const { store } = storeHarness(persisted!);
    const result = await runWorkspaceHostDestroy(runInput(provider, store));
    expect(result.status).toBe('succeeded');
  });

  // The falsifier. This is the exact state canary-13/14/15/16 were provisioned in, and the refusal
  // the destroy runner produced on real hardware at 2026-09-04T08:11:49Z.
  it('refuses the destroy when the provision declared no canary run — labels are never invented', async () => {
    const { response, persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Ordinary host',
      desired: requestedDesired(),
    });
    expect(response.status).toBe(201);
    expect(persisted?.labels).toBeUndefined();

    const { provider, apply } = providerHarness();
    const { store } = storeHarness(persisted!);
    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [
        `stored desired.labels must contain 'papercusp_canary=true'`,
        `stored desired.labels must contain 'papercusp_run_id=${RUN_ID}'`,
        `stored desired.labels must contain 'papercusp_workspace_id=${WORKSPACE_ID}'`,
      ],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses a caller that hand-writes an identity label instead of declaring the run', async () => {
    const { response, persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Forged canary',
      desired: { ...requestedDesired(), labels: { papercusp_run_id: RUN_ID } },
      canary: { runId: RUN_ID },
    });
    expect(response.status).toBe(422);
    expect(persisted).toBeUndefined();
    await expect(response.json()).resolves.toMatchObject({
      problems: [expect.stringContaining(`desired.labels must not set 'papercusp_run_id'`)],
    });
  });

  it('binds the labels to the declared run, so a destroy citing another run still refuses', async () => {
    const { persisted } = await provision({
      connectionId: 'connection-1',
      name: 'Canary host',
      desired: requestedDesired(),
      canary: admission('canary_2'),
    });
    expect(persisted?.labels?.papercusp_run_id).toBe('canary_2');

    const { provider, apply } = providerHarness();
    const { store } = storeHarness(persisted!);
    await expect(runWorkspaceHostDestroy(runInput(provider, store))).rejects.toMatchObject({
      problems: [`stored desired.labels must contain 'papercusp_run_id=${RUN_ID}'`],
    });
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

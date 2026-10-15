/**
 * The production destroy runner on an AWS host (plan aws-byoc-gcp-parity-2026-10-01 P-003 step 6).
 *
 * The destroy was GCP-only: a hard gate refused every other provider, and the terminal census asked
 * for GCP's deterministic shared-network names and judged coverage against GCP's eight kinds. These
 * tests pin the AWS path end to end through `runWorkspaceHostDestroy`: the inventory request carries
 * only the account/region/workspace scope, the census is judged by the AWS profile (vm, disk,
 * snapshot, spot-request by `papercusp:*` tags), surviving tagged resources fail the destroy, and a
 * provider with no census (or a provider/host mismatch) is refused before any provider call.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  makeFakeWorkspaceHostProvider,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS,
  AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS,
  type AwsWorkspaceHostInventoryRequest,
  type AwsWorkspaceHostInventorySnapshot,
} from './aws-safety';
import {
  runWorkspaceHostDestroy,
  type RunWorkspaceHostDestroyInput,
  type WorkspaceHostDestroyStore,
} from './provisioning-runner';

const NOW = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-01T00:10:00.000Z';
const WORKSPACE_ID = 'workspace_aws';
const ACCOUNT_ID = '413781344298';
const REGION = 'us-east-1';

const desired: WorkspaceHostDesiredSpec = {
  hostId: 'host-aws',
  target: 'aws',
  scope: { kind: 'account', id: ACCOUNT_ID },
  region: REGION,
  zone: 'us-east-1a',
  size: 't3.small',
  image: { id: 'ami-0123456789abcdef0' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'aws-role://papercusp-workspace-host' } },
};

const connection: WorkspaceHostProviderConnection = {
  target: 'aws',
  cloudCredentialRef: { kind: 'cloud', ref: 'aws-role://papercusp-workspace-host' },
  scope: desired.scope,
};

const resources: readonly WorkspaceHostResourceRef[] = [
  { target: 'aws', kind: 'vm', providerId: 'i-0abc', parentProviderId: ACCOUNT_ID, region: REGION, zone: desired.zone },
  { target: 'aws', kind: 'disk', providerId: 'vol-0abc', parentProviderId: ACCOUNT_ID, region: REGION, zone: desired.zone },
];

function steps(): WorkspaceHostPlanStep[] {
  return resources.map((resource, index) => ({
    id: `delete-${resource.kind}-${resource.providerId}`,
    action: 'destroy',
    resourceKind: resource.kind,
    dependsOn: index === 0 ? [] : [`delete-${resources[index - 1]!.kind}-${resources[index - 1]!.providerId}`],
    idempotencyKey: `destroy:${resource.kind}`,
    destructive: true,
    input: { op: `delete-${resource.kind}`, resourceName: resource.providerId },
  }));
}

function awsInventory(observed: AwsWorkspaceHostInventorySnapshot['observed'] = []): AwsWorkspaceHostInventorySnapshot {
  return {
    complete: true,
    observed,
    inventoryEvidence: AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.map((kind) => ({
      kind,
      strategy: 'managed-labels' as const,
      providerEvidenceRef: `aws://ec2/${REGION}/${kind}?tag:papercusp:workspace-id=${WORKSPACE_ID}`,
    })),
  };
}

function providerHarness(target: 'aws' | 'gcp' = 'aws') {
  const apply = vi.fn<WorkspaceHostProvider['apply']>(async (request): Promise<WorkspaceHostApplyResult> => {
    const providerResourceId = String(request.step.input.resourceName);
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'destroyed',
      observedAt: LATER,
      confirmation: {
        hostId: 'host-aws',
        providerResourceId,
        confirmedAbsentAt: LATER,
        source: 'provider-read',
        providerRequestId: `aws-request:${providerResourceId}`,
      },
    };
  });
  const inventoryManagedResources = vi.fn<(request: AwsWorkspaceHostInventoryRequest) => Promise<AwsWorkspaceHostInventorySnapshot>>(
    async () => awsInventory(),
  );
  const plan = vi.fn(async (request: { operationId: string }) => ({
    planId: 'plan-destroy-aws',
    operationId: request.operationId,
    target,
    hostId: 'host-aws',
    generatedAt: NOW,
    steps: steps(),
    warnings: [],
  }));
  const provider = makeFakeWorkspaceHostProvider({
    target,
    validateConnection: vi.fn(async () => ({ ok: true, checkedAt: NOW, warnings: [], errors: [] })),
    plan,
    apply,
    reconcile: vi.fn<WorkspaceHostProvider['reconcile']>(),
    observe: vi.fn<WorkspaceHostProvider['observe']>(),
    inventoryManagedResources,
  });
  return { provider, apply, plan, inventoryManagedResources };
}

function storeHarness(storedTarget: string = 'aws') {
  let checkpoints: WorkspaceHostResourceCheckpoint[] = [];
  const updateHostState = vi.fn<WorkspaceHostDestroyStore['updateHostState']>();
  const updateOperation = vi.fn<WorkspaceHostDestroyStore['updateOperation']>();
  const store: WorkspaceHostDestroyStore = {
    readTarget: vi.fn(async () => ({
      id: 'host-aws',
      name: 'AWS host',
      connectionId: 'connection-aws',
      target: storedTarget as 'aws',
      observedState: 'running',
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 1,
      desired: { ...desired, target: storedTarget as 'aws' },
      resources: resources.map((resource) => ({ resource: { ...resource, target: storedTarget as 'aws' }, registeredAt: NOW })),
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
  return { store, updateHostState, updateOperation };
}

function destroyInput(provider: WorkspaceHostProvider, store: WorkspaceHostDestroyStore): RunWorkspaceHostDestroyInput {
  return {
    workspaceId: WORKSPACE_ID,
    hostId: 'host-aws',
    connection: { ...connection, target: provider.target as 'aws' },
    provider,
    disposition: 'discard',
    confirmation: { expectedHostId: 'host-aws', confirmedBy: 'operator:test', confirmedAt: NOW },
    operationId: 'op-destroy-aws',
    store,
  };
}

function failureReason(updateOperation: ReturnType<typeof storeHarness>['updateOperation']): string {
  const failure = updateOperation.mock.calls.map(([entry]) => entry).find((entry) => entry.status === 'failed');
  return String((failure?.error as { reason?: unknown } | undefined)?.reason ?? '');
}

describe('runWorkspaceHostDestroy on an AWS host', () => {
  it('deletes every registered resource and completes on a clean AWS-profile census', async () => {
    const { provider, apply, inventoryManagedResources } = providerHarness();
    const { store, updateHostState } = storeHarness();

    const result = await runWorkspaceHostDestroy(destroyInput(provider, store));

    expect(result.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledTimes(resources.length);
    expect(result.checkpoints.every((entry) => entry.deletionConfirmation?.source === 'provider-read')).toBe(true);
    // The AWS census needs no GCP shared-network names: the request is the account scope alone,
    // taken from the registered resources' parent (the AWS account id).
    expect(inventoryManagedResources).toHaveBeenCalledWith({
      projectId: ACCOUNT_ID,
      region: REGION,
      workspaceId: WORKSPACE_ID,
    });
    expect(updateHostState).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      hostId: 'host-aws',
      state: 'absent',
      recoverability: expect.objectContaining({ kind: 'none' }),
    }));
  });

  it.each([
    resources[0]!,
    { target: 'aws', kind: 'spot-request', providerId: 'sir-open', parentProviderId: ACCOUNT_ID, region: REGION },
  ] satisfies WorkspaceHostResourceRef[])('still fails the destroy when a tagged $kind of this host survives the settle window', async (resource) => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation, updateHostState } = storeHarness();
    inventoryManagedResources.mockResolvedValue(awsInventory([
      {
        resource,
        labels: {
          [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed]: 'true',
          [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId]: 'host-aws',
          [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId]: WORKSPACE_ID,
        },
        observedAt: LATER,
        firstObservedAt: NOW,
      },
    ]));

    const result = await runWorkspaceHostDestroy({ ...destroyInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    expect(failureReason(updateOperation)).toMatch(/census is not clean after 1 read\(s\)/);
    expect(failureReason(updateOperation)).toContain(resource.providerId);
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it.each(AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS)('refuses an AWS census whose inventory skipped required kind %s', async (kind) => {
    const { provider, inventoryManagedResources } = providerHarness();
    const { store, updateOperation, updateHostState } = storeHarness();
    const partial = awsInventory();
    inventoryManagedResources.mockResolvedValue({
      ...partial,
      inventoryEvidence: partial.inventoryEvidence.filter((evidence) => evidence.kind !== kind),
    });

    const result = await runWorkspaceHostDestroy({ ...destroyInput(provider, store), censusSettleMs: 0 });

    expect(result.status).toBe('failed');
    expect(failureReason(updateOperation)).toContain(`AWS workspace-host census inventory incomplete: ${kind}`);
    expect(updateHostState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'absent' }));
  });

  it('refuses, before any provider call, a provider that has no controller-independent census', async () => {
    const { provider, plan, apply, inventoryManagedResources } = providerHarness();
    const { store } = storeHarness('azure');

    await expect(runWorkspaceHostDestroy(destroyInput(provider, store))).rejects.toThrow(
      /not implemented for provider 'azure'/,
    );
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(inventoryManagedResources).not.toHaveBeenCalled();
  });

  it('refuses an AWS host handed a provider for another cloud', async () => {
    const { provider, plan, apply } = providerHarness('gcp');
    const { store } = storeHarness('aws');

    await expect(runWorkspaceHostDestroy(destroyInput(provider, store))).rejects.toThrow(
      /does not match the stored host provider/,
    );
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS,
  runFakeWorkspaceHostProviderContractSuite,
  workspaceHostProviderRetryClass,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderContext,
  type WorkspaceHostRef,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  AWS_SPOT_MARKET_OPTIONS,
  AWS_VOLUME_INITIALIZATION_RATE_MIBPS,
  AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH,
  AwsInstanceLaunchFailedError,
  awsWorkspaceHostClientToken,
  createAwsWorkspaceHostProvider,
  type AwsCommandInvocationObservation,
  type AwsCreateSnapshotInput,
  type AwsCreateVolumeInput,
  type AwsCreatedInstance,
  type AwsCreatedSnapshot,
  type AwsCreatedVolume,
  type AwsEc2InstanceState,
  type AwsInstanceObservation,
  type AwsProviderMutationResult,
  type AwsRunInstancesInput,
  type AwsShellCommandInput,
  type AwsSnapshotDescription,
  type AwsSnapshotObservation,
  type AwsVolumeObservation,
  type AwsWorkspaceHostSdkClient,
} from './aws-provider';
import {
  AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC,
  awsEbsNvmeDevicePath,
  renderAwsHostBootstrapPush,
} from './aws-host-bootstrap-push';
import { cloudResourceKindForDeleteOp, describeCloudResourceDeleteAddress } from './cloud-resource-obligations';
import type { WorkspaceHostResourceCreatedEvent } from './gcp-provider';
import type { AwsWorkspaceHostInventoryRequest, AwsWorkspaceHostInventorySnapshot } from './aws-safety';
import { AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS } from './aws-safety';

const NOW = '2026-08-22T08:00:00.000Z';

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-aws-1',
    target: 'aws',
    scope: { kind: 'account', id: '123456789012' },
    region: 'us-east-1',
    zone: 'us-east-1a',
    size: 'm7i.large',
    image: { id: 'ami-ubuntu-2404', version: '2026.08.22' },
    data: { volumeGiB: 100, encrypted: true },
    credentials: {
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws/development' },
    },
    labels: { environment: 'test', owner: 'workspace-host-contract' },
    provider: {
      vpcId: 'vpc-123',
      subnetId: 'subnet-123',
      securityGroupIds: ['sg-workspace', 'sg-egress'],
      availabilityZone: 'us-east-1a',
      instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/PapercuspWorkspace',
      launchTemplateId: 'lt-123',
      launchTemplateVersion: '7',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
      rootVolumeGiB: 40,
      rootDeviceName: '/dev/sda1',
      dataDeviceName: '/dev/sdf',
      volumeType: 'gp3',
      userData: '#!/bin/sh\necho papercusp-bootstrap\n',
    },
  };
}

/** What the controller renders for provision and repair (D-013); the provider refuses those without it. */
const HOST_BOOTSTRAP = '#!/usr/bin/env bash\necho papercusp-bootstrap\n';

function context(
  provider: Readonly<Record<string, unknown>> = {},
  hostBootstrapScript: string | null = HOST_BOOTSTRAP,
): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-aws-1',
    requestId: 'request-aws-1',
    ...(hostBootstrapScript === null ? {} : { hostBootstrapScript }),
    connection: {
      target: 'aws',
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws/development' },
      scope: { kind: 'account', id: '123456789012' },
      provider: { region: 'us-east-1', credentialSource: 'shared-profile', ...provider },
    },
  };
}

class FakeAwsWorkspaceHostSdkClient implements AwsWorkspaceHostSdkClient {
  readonly createVolumeCalls: AwsCreateVolumeInput[] = [];
  readonly runInstancesCalls: AwsRunInstancesInput[] = [];
  readonly attachVolumeCalls: Array<{ InstanceId: string; VolumeId: string; Device: string }> = [];
  readonly createSnapshotCalls: AwsCreateSnapshotInput[] = [];
  readonly waitedInstanceStates: Array<{ id: string; state: 'running' | 'stopped' | 'terminated' }> = [];
  readonly waitedVolumeStates: Array<{ id: string; state: 'available' | 'in-use' | 'deleted' }> = [];
  readonly describedInstances: string[] = [];
  readonly describedVolumes: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  rebootCalls = 0;
  repairCalls = 0;
  terminateCalls = 0;
  deleteVolumeCalls = 0;
  readonly cancelSpotCalls: string[][] = [];
  /** Destroy-path mutations in call order, so cancel-before-terminate is observable. */
  readonly destroyMutations: string[] = [];
  /** Inbound rule count per security group; an unlisted group reads as closed (0). */
  readonly securityGroupIngress = new Map<string, number>();
  /** Groups EC2 "does not return" — simulates an unverifiable group. */
  readonly hiddenSecurityGroups = new Set<string>();
  readonly describedSecurityGroups: string[][] = [];
  /**
   * When set, a wait for `running` observes the launch ending in this state instead (EC2's waiter
   * reports the instance it gave up on). Models a launch EC2 terminates, e.g. an unusable KMS key.
   */
  launchFailure?: { state: 'shutting-down' | 'terminated'; stateReason: { code: string; message?: string } };

  private readonly instances = new Map<string, AwsInstanceObservation>();
  private readonly volumes = new Map<string, AwsVolumeObservation>();
  private readonly snapshots = new Map<string, AwsSnapshotObservation>();
  private readonly instanceTokens = new Map<string, string>();
  private readonly volumeTokens = new Map<string, string>();
  private readonly snapshotTokens = new Map<string, string>();

  async validateConnection() {
    return {
      ok: true,
      checkedAt: NOW,
      identity: 'arn:aws:sts::123456789012:assumed-role/Papercusp/operator',
      warnings: [],
      errors: [],
    };
  }

  async listScopes() {
    return [{ kind: 'account', id: '123456789012', label: 'Development account' }];
  }

  async listRegions() {
    return [{ id: 'us-east-1', label: 'US East (N. Virginia)', available: true, zones: ['us-east-1a'] }];
  }

  async listSizes() {
    return [{ id: 'm7i.large', label: 'm7i.large', cpuCount: 2, memoryMiB: 8192, available: true }];
  }

  async listImages() {
    return [
      {
        id: 'ami-ubuntu-2404',
        version: '2026.08.22',
        label: 'Ubuntu 24.04 LTS',
        architecture: 'x86_64',
        signed: true,
      },
    ];
  }

  async estimatePrice() {
    return { currency: 'USD', hourlyAmount: 0.12, observedAt: NOW, confidence: 'estimated' as const };
  }

  async describeSecurityGroupIngress(groupIds: readonly string[]) {
    this.describedSecurityGroups.push([...groupIds]);
    return groupIds
      .filter((groupId) => !this.hiddenSecurityGroups.has(groupId))
      .map((groupId) => ({ groupId, ingressRuleCount: this.securityGroupIngress.get(groupId) ?? 0 }));
  }

  /** The provider never reads the console; initialization does (initialization-operations-resolver). */
  async getConsoleOutput(_instanceId: string): Promise<string | undefined> {
    return undefined;
  }

  /** Whether SSM ever reports the instance Online within the wait (D-013). */
  ssmOnline = true;
  /** What the pushed bootstrap command settles to. */
  commandInvocation: AwsCommandInvocationObservation = { status: 'Success', responseCode: 0 };
  readonly ssmOnlineWaits: string[] = [];
  readonly shellCommands: AwsShellCommandInput[] = [];
  readonly commandWaits: Array<{ commandId: string; instanceId: string }> = [];

  async waitForSsmOnline(instanceId: string): Promise<boolean> {
    this.ssmOnlineWaits.push(instanceId);
    return this.ssmOnline;
  }

  async sendShellCommand(input: AwsShellCommandInput): Promise<{ commandId: string; requestId?: string }> {
    this.shellCommands.push(input);
    const commandId = `command-${this.shellCommands.length}`;
    return { commandId, requestId: `request:send:${commandId}` };
  }

  async waitForCommandInvocation(commandId: string, instanceId: string): Promise<AwsCommandInvocationObservation> {
    this.commandWaits.push({ commandId, instanceId });
    return this.commandInvocation;
  }

  async createVolume(input: AwsCreateVolumeInput): Promise<AwsCreatedVolume> {
    this.createVolumeCalls.push(input);
    const existing = this.volumeTokens.get(input.ClientToken);
    // Real EBS ids are vol- plus 17 hex digits; the bootstrap push derives the NVMe device from it.
    const volumeId = existing ?? `vol-${String(this.volumeTokens.size + 1).padStart(17, '0')}`;
    this.volumeTokens.set(input.ClientToken, volumeId);
    this.volumes.set(volumeId, {
      volumeId,
      availabilityZone: input.AvailabilityZone,
      encrypted: input.Encrypted,
      tags: Object.fromEntries(input.TagSpecifications[0].Tags.map((tag) => [tag.Key, tag.Value])),
      state: 'creating',
      observedAt: NOW,
    });
    return { volumeId, requestId: `request:create:${volumeId}` };
  }

  async findVolumeByClientToken(clientToken: string): Promise<AwsVolumeObservation | undefined> {
    const id = this.volumeTokens.get(clientToken);
    return id ? this.volumes.get(id) : undefined;
  }

  async describeVolume(volumeId: string): Promise<AwsVolumeObservation | undefined> {
    this.describedVolumes.push(volumeId);
    return this.volumes.get(volumeId);
  }

  async waitForVolumeState(
    volumeId: string,
    state: 'available' | 'in-use' | 'deleted',
  ): Promise<AwsVolumeObservation | undefined> {
    this.waitedVolumeStates.push({ id: volumeId, state });
    const current = this.volumes.get(volumeId);
    if (state === 'deleted') {
      const deleted = { volumeId, state: 'deleted' as const, observedAt: NOW };
      this.volumes.set(volumeId, deleted);
      return deleted;
    }
    if (!current) return undefined;
    // EC2: an 'available' volume has no attachment (terminating its instance releases it).
    const observed = state === 'available' ? { ...current, state, attachedInstanceId: undefined } : { ...current, state };
    this.volumes.set(volumeId, observed);
    return observed;
  }

  async deleteVolume(volumeId: string): Promise<AwsProviderMutationResult> {
    this.deleteVolumeCalls += 1;
    const current = this.volumes.get(volumeId);
    if (current) this.volumes.set(volumeId, { ...current, state: 'deleting' });
    return { requestId: `request:delete:${volumeId}` };
  }

  /** AMI id -> RootDeviceName. An unlisted image is one this account cannot see. */
  readonly imageRootDevices = new Map<string, string>();

  async describeImageRootDeviceName(imageId: string): Promise<string | undefined> {
    return this.imageRootDevices.get(imageId);
  }

  async runInstances(input: AwsRunInstancesInput): Promise<AwsCreatedInstance> {
    this.runInstancesCalls.push(input);
    const existing = this.instanceTokens.get(input.ClientToken);
    const instanceId = existing ?? `i-${String(this.instanceTokens.size + 1).padStart(17, '0')}`;
    this.instanceTokens.set(input.ClientToken, instanceId);
    this.instances.set(instanceId, {
      instanceId,
      state: 'pending',
      imageId: input.ImageId,
      attachedVolumeIds: [],
      instanceStatus: 'initializing',
      systemStatus: 'initializing',
      ssmOnline: false,
      // EC2 names the spot request on the instance it launched for it.
      ...(input.InstanceMarketOptions ? { spotInstanceRequestId: `sir-${instanceId.slice(2)}` } : {}),
      observedAt: NOW,
    });
    return { instanceId, requestId: `request:run:${instanceId}` };
  }

  async findInstanceByClientToken(clientToken: string): Promise<AwsInstanceObservation | undefined> {
    const id = this.instanceTokens.get(clientToken);
    return id ? this.instances.get(id) : undefined;
  }

  setInstanceState(instanceId: string, state: AwsEc2InstanceState): void {
    const current = this.instances.get(instanceId);
    if (!current) throw new Error(`fake EC2 has no instance ${instanceId}`);
    this.instances.set(instanceId, { ...current, state, observedAt: NOW });
  }

  async describeInstance(instanceId: string): Promise<AwsInstanceObservation | undefined> {
    this.describedInstances.push(instanceId);
    return this.instances.get(instanceId);
  }

  async waitForInstanceState(
    instanceId: string,
    state: 'running' | 'stopped' | 'terminated',
  ): Promise<AwsInstanceObservation | undefined> {
    this.waitedInstanceStates.push({ id: instanceId, state });
    const current = this.instances.get(instanceId);
    if (!current) return undefined;
    if (state === 'running' && this.launchFailure) {
      const failed: AwsInstanceObservation = {
        ...current,
        state: this.launchFailure.state,
        stateReason: this.launchFailure.stateReason,
        ssmOnline: false,
        observedAt: NOW,
      };
      this.instances.set(instanceId, failed);
      return failed;
    }
    const observed: AwsInstanceObservation = {
      ...current,
      state,
      instanceStatus: state === 'running' ? 'ok' : current.instanceStatus,
      systemStatus: state === 'running' ? 'ok' : current.systemStatus,
      ssmOnline: state === 'running',
      observedAt: NOW,
    };
    this.instances.set(instanceId, observed);
    return observed;
  }

  async attachVolume(input: {
    InstanceId: string;
    VolumeId: string;
    Device: string;
  }): Promise<AwsProviderMutationResult> {
    this.attachVolumeCalls.push(input);
    const volume = this.volumes.get(input.VolumeId);
    const instance = this.instances.get(input.InstanceId);
    if (!volume || !instance) throw new Error('fake AWS attachment references an unknown resource');
    this.volumes.set(input.VolumeId, {
      ...volume,
      state: 'in-use',
      attachedInstanceId: input.InstanceId,
    });
    this.instances.set(input.InstanceId, {
      ...instance,
      attachedVolumeIds: [...new Set([...instance.attachedVolumeIds, input.VolumeId])],
    });
    return { requestId: `request:attach:${input.VolumeId}` };
  }

  readonly detachVolumeCalls: Array<{ InstanceId: string; VolumeId: string }> = [];

  async detachVolume(input: { InstanceId: string; VolumeId: string }): Promise<AwsProviderMutationResult> {
    this.detachVolumeCalls.push(input);
    const volume = this.volumes.get(input.VolumeId);
    const instance = this.instances.get(input.InstanceId);
    if (!volume || !instance) throw new Error('fake AWS detachment references an unknown resource');
    const { attachedInstanceId: _detached, ...rest } = volume;
    this.volumes.set(input.VolumeId, { ...rest, state: 'available' });
    this.instances.set(input.InstanceId, {
      ...instance,
      attachedVolumeIds: instance.attachedVolumeIds.filter((id) => id !== input.VolumeId),
    });
    return { requestId: `request:detach:${input.VolumeId}` };
  }

  /** Snapshot tags as EC2 would return them (from CreateSnapshot's TagSpecifications). */
  readonly snapshotTags = new Map<string, Record<string, string>>();
  readonly snapshotSizes = new Map<string, number>();

  async describeSnapshot(snapshotId: string): Promise<AwsSnapshotDescription | undefined> {
    const observed = this.snapshots.get(snapshotId);
    if (!observed) return undefined;
    const size = this.snapshotSizes.get(snapshotId);
    return { ...observed, tags: this.snapshotTags.get(snapshotId) ?? {}, ...(size ? { volumeSizeGiB: size } : {}) };
  }

  async startInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.startCalls += 1;
    this.setInstanceStates(instanceIds, 'pending');
    return { requestId: 'request:start' };
  }

  async stopInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.stopCalls += 1;
    this.setInstanceStates(instanceIds, 'stopping');
    return { requestId: 'request:stop' };
  }

  async rebootInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.rebootCalls += 1;
    this.setInstanceStates(instanceIds, 'pending');
    return { requestId: 'request:reboot' };
  }

  async repairInstance(instanceId: string): Promise<AwsProviderMutationResult> {
    this.repairCalls += 1;
    this.setInstanceStates([instanceId], 'pending');
    return { requestId: 'request:repair' };
  }

  async terminateInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.terminateCalls += 1;
    this.destroyMutations.push(...instanceIds.map((id) => `terminate:${id}`));
    this.setInstanceStates(instanceIds, 'shutting-down');
    return { requestId: 'request:terminate' };
  }

  async cancelSpotInstanceRequests(spotInstanceRequestIds: readonly string[]): Promise<AwsProviderMutationResult> {
    this.cancelSpotCalls.push([...spotInstanceRequestIds]);
    this.destroyMutations.push(...spotInstanceRequestIds.map((id) => `cancel-spot:${id}`));
    return { requestId: 'request:cancel-spot' };
  }

  async createSnapshot(input: AwsCreateSnapshotInput): Promise<AwsCreatedSnapshot> {
    this.createSnapshotCalls.push(input);
    const existing = this.snapshotTokens.get(input.ClientToken);
    const snapshotId = existing ?? `snap-${this.snapshotTokens.size + 1}`;
    this.snapshotTokens.set(input.ClientToken, snapshotId);
    this.snapshots.set(snapshotId, { snapshotId, state: 'pending', observedAt: NOW });
    this.snapshotTags.set(
      snapshotId,
      Object.fromEntries(input.TagSpecifications[0].Tags.map((tag) => [tag.Key, tag.Value])),
    );
    return { snapshotId, requestId: `request:snapshot:${snapshotId}` };
  }

  async findSnapshotByClientToken(clientToken: string): Promise<AwsSnapshotObservation | undefined> {
    const id = this.snapshotTokens.get(clientToken);
    return id ? this.snapshots.get(id) : undefined;
  }

  async waitForSnapshotCompleted(snapshotId: string): Promise<AwsSnapshotObservation> {
    const observed = { snapshotId, state: 'completed' as const, observedAt: NOW };
    this.snapshots.set(snapshotId, observed);
    return observed;
  }

  async listManagedResources(request: AwsWorkspaceHostInventoryRequest): Promise<AwsWorkspaceHostInventorySnapshot> {
    const resource = (kind: 'vm' | 'disk', providerId: string) => ({
      resource: { target: 'aws', kind, providerId, parentProviderId: request.projectId, region: request.region },
      labels: {},
      observedAt: NOW,
    });
    return {
      complete: true,
      observed: [
        ...[...this.instances.keys()].map((id) => resource('vm', id)),
        ...[...this.volumes.keys()].map((id) => resource('disk', id)),
      ],
      inventoryEvidence: (['vm', 'disk', 'snapshot'] as const).map((kind) => ({
        kind,
        strategy: 'managed-labels' as const,
        providerEvidenceRef: `fake://${kind}`,
      })),
    };
  }

  private setInstanceStates(instanceIds: readonly string[], state: AwsEc2InstanceState): void {
    for (const instanceId of instanceIds) {
      const current = this.instances.get(instanceId);
      if (current) this.instances.set(instanceId, { ...current, state, observedAt: NOW });
    }
  }
}

function providerAndClient() {
  const client = new FakeAwsWorkspaceHostSdkClient();
  const provider = createAwsWorkspaceHostProvider({ client, now: () => NOW });
  return { client, provider };
}

function requireAppliedResource(result: WorkspaceHostApplyResult): WorkspaceHostResourceRef {
  if (!('resource' in result) || !result.resource) {
    throw new Error(`expected an applied AWS resource, received '${result.state}'`);
  }
  return result.resource;
}

/** The default fixture as a spot host (WI-10005389). */
function spotDesired(): WorkspaceHostDesiredSpec {
  const base = desired();
  return { ...base, provider: { ...base.provider, provisioningModel: 'spot' } };
}

async function provision(
  client: FakeAwsWorkspaceHostSdkClient,
  provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
  spec: WorkspaceHostDesiredSpec = desired(),
): Promise<{ host: WorkspaceHostRef; resources: WorkspaceHostResourceRef[] }> {
  const plan = await provider.plan(
    { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: spec },
    context(),
  );
  const resources: WorkspaceHostResourceRef[] = [];
  for (const step of plan.steps) {
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
      context(),
    );
    if (
      'resource' in result &&
      result.resource &&
      !resources.some((item) => item.providerId === result.resource!.providerId)
    ) {
      resources.push(result.resource);
    }
  }
  expect(client.attachVolumeCalls).toHaveLength(1);
  return { host: { hostId: spec.hostId, target: 'aws', resources }, resources };
}

/** Every `TagSpecifications[].ResourceType` anywhere in a value (step inputs nest the EC2 request). */
function taggedResourceTypes(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => taggedResourceTypes(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'TagSpecifications' && Array.isArray(entry)) {
        for (const spec of entry) if (typeof spec?.ResourceType === 'string') out.add(spec.ResourceType);
      } else taggedResourceTypes(entry, out);
    }
  }
  return out;
}

describe('AWS zero-orphan coverage (aws-byoc-gcp-parity P-007)', () => {
  // The teardown census (censusAwsWorkspaceHostResources) can only prove "no resource carrying this
  // host's ownership tag survives" for the kinds it enumerates. So every EC2 resource type the
  // provider TAGS for a host must map to an AWS census kind; a new tagged type (a per-host security
  // group, an instance profile, an ENI) would otherwise survive teardown invisibly.
  const EC2_TAG_TYPE_TO_CENSUS_KIND: Record<string, string> = {
    instance: 'vm',
    volume: 'disk',
    snapshot: 'snapshot',
    // WI-10005454: a spot host's persistent request is host-tagged, so the census must read it.
    'spot-instances-request': 'spot-request',
  };

  it('maps every resource type a SPOT host tags to a census kind, including its spot request', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'orphan-spot', idempotencyKey: 'orphan-spot', desired: spotDesired() },
      context(),
    );
    const tagged = taggedResourceTypes(plan.steps.map((step) => step.input));
    expect([...tagged].sort()).toEqual(['instance', 'spot-instances-request', 'volume']);
    for (const type of tagged) {
      expect(EC2_TAG_TYPE_TO_CENSUS_KIND[type], `no census kind for tagged EC2 type '${type}'`).toBeDefined();
      expect(AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS as readonly string[]).toContain(EC2_TAG_TYPE_TO_CENSUS_KIND[type]);
    }
  });

  it('tags only resource types the teardown census enumerates, and creates no per-host SG or instance profile', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'orphan-1', idempotencyKey: 'orphan-1', desired: desired() },
      context(),
    );
    const tagged = taggedResourceTypes(plan.steps.map((step) => step.input));
    expect([...tagged].sort()).toEqual(['instance', 'volume']);
    for (const type of tagged) {
      expect(AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS as readonly string[]).toContain(EC2_TAG_TYPE_TO_CENSUS_KIND[type]);
    }
    // Snapshots are tagged by the snapshot action; their census kind must exist too.
    expect(AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS as readonly string[]).toContain(EC2_TAG_TYPE_TO_CENSUS_KIND.snapshot);
    // Security groups and the instance profile are CONNECTION-level (settings.securityGroupIds /
    // instanceProfileArn): referenced, never created or host-tagged, so they cannot be host orphans.
    for (const step of plan.steps) {
      expect(JSON.stringify(step.input)).not.toMatch(/CreateSecurityGroup|security-group'|CreateInstanceProfile|instance-profile'/i);
      expect((step.input as { op?: string }).op ?? '').not.toMatch(/security-group|instance-profile|iam/i);
    }
  });
});

describe('AWS spot hosts (WI-10005389)', () => {
  async function runRequestFor(spec: WorkspaceHostDesiredSpec): Promise<AwsRunInstancesInput> {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'spot-1', idempotencyKey: 'spot-1', desired: spec },
      context(),
    );
    const step = plan.steps.find((candidate) => candidate.id === 'run-instance');
    return (step!.input as { request: AwsRunInstancesInput }).request;
  }

  async function destroyAll(
    client: FakeAwsWorkspaceHostSdkClient,
    provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
    host: WorkspaceHostRef,
    resources: WorkspaceHostResourceRef[],
  ): Promise<WorkspaceHostApplyResult[]> {
    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:destroy',
        idempotencyKey: 'operation:destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const results: WorkspaceHostApplyResult[] = [];
    for (const step of destroy.steps) {
      results.push(
        await provider.apply(
          { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
          context(),
        ),
      );
    }
    return results;
  }

  it('launches a spot host as a persistent, stop-on-interrupt spot request with no price cap', async () => {
    expect(AWS_SPOT_MARKET_OPTIONS).toEqual({
      MarketType: 'spot',
      SpotOptions: { SpotInstanceType: 'persistent', InstanceInterruptionBehavior: 'stop' },
    });
    const request = await runRequestFor(spotDesired());
    expect(request.InstanceMarketOptions).toEqual(AWS_SPOT_MARKET_OPTIONS);
    // The request itself carries the host's managed tags, like the instance and its volumes.
    expect(request.TagSpecifications.map((spec) => spec!.ResourceType)).toEqual([
      'instance',
      'volume',
      'spot-instances-request',
    ]);
    expect(request.TagSpecifications[2]!.Tags).toEqual(request.TagSpecifications[0].Tags);
  });

  it('launches on-demand when the provisioning model is absent or standard', async () => {
    const base = desired();
    for (const spec of [base, { ...base, provider: { ...base.provider, provisioningModel: 'standard' } }]) {
      const request = await runRequestFor(spec);
      expect(request).not.toHaveProperty('InstanceMarketOptions');
      expect(request.TagSpecifications.map((tagSpec) => tagSpec!.ResourceType)).toEqual(['instance', 'volume']);
    }
  });

  it('refuses an unknown provisioning model at plan time', async () => {
    const base = desired();
    const { provider } = providerAndClient();
    await expect(
      provider.plan(
        {
          action: 'provision',
          operationId: 'spot-bad',
          idempotencyKey: 'spot-bad',
          desired: { ...base, provider: { ...base.provider, provisioningModel: 'preemptible' } },
        },
        context(),
      ),
    ).rejects.toThrow(/provisioningModel must be one of standard, spot/);
  });

  it('cancels the persistent spot request before terminating the instance, so EC2 cannot relaunch it', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider, spotDesired());
    const results = await destroyAll(client, provider, host, resources);
    expect(results.map((result) => result.state)).toEqual(['destroyed', 'destroyed']);
    expect(client.cancelSpotCalls).toEqual([['sir-00000000000000001']]);
    expect(client.destroyMutations).toEqual(['cancel-spot:sir-00000000000000001', 'terminate:i-00000000000000001']);
  });

  it('never cancels a spot request for an on-demand host (control)', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    await destroyAll(client, provider, host, resources);
    expect(client.cancelSpotCalls).toEqual([]);
    expect(client.destroyMutations).toEqual(['terminate:i-00000000000000001']);
  });
});

describe('AWS volume initialization rate (WI-10006140: lazy EBS hydration of snapshot-restored volumes)', () => {
  async function planWith(volumeInitializationRateMiBps: unknown, key: string) {
    const base = desired();
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      {
        action: 'provision',
        operationId: key,
        idempotencyKey: key,
        desired: { ...base, provider: { ...base.provider, volumeInitializationRateMiBps } },
      },
      context(),
    );
    const volume = plan.steps.find((step) => step.id === 'create-data-volume')!.input as unknown as {
      request: AwsCreateVolumeInput;
    };
    const instance = plan.steps.find((step) => step.id === 'run-instance')!.input as unknown as {
      request: AwsRunInstancesInput;
    };
    return { volume: volume.request, rootEbs: instance.request.BlockDeviceMappings[0].Ebs };
  }

  it('defaults to the maximum rate AWS accepts, which is what made the canary host start', () => {
    expect(AWS_VOLUME_INITIALIZATION_RATE_MIBPS).toEqual({ min: 100, max: 300, default: 300 });
  });

  it('applies an explicit in-range rate to the AMI-restored root volume only', async () => {
    const { volume, rootEbs } = await planWith(150, 'rate-150');
    expect(rootEbs.VolumeInitializationRate).toBe(150);
    expect(volume).not.toHaveProperty('VolumeInitializationRate');
  });

  it('accepts both bounds of the AWS range', async () => {
    expect((await planWith(100, 'rate-100')).rootEbs.VolumeInitializationRate).toBe(100);
    expect((await planWith(300, 'rate-300')).rootEbs.VolumeInitializationRate).toBe(300);
  });

  it('null opts out: the root volume carries no rate, so EBS uses its default lazy hydration', async () => {
    const { volume, rootEbs } = await planWith(null, 'rate-null');
    expect(rootEbs).not.toHaveProperty('VolumeInitializationRate');
    expect(volume).not.toHaveProperty('VolumeInitializationRate');
  });

  it.each([
    ['below the AWS minimum', 99],
    ['above the AWS maximum', 301],
    ['fractional', 150.5],
    ['zero', 0],
    ['a numeric string', '300'],
    ['a boolean', true],
  ])('refuses a rate that is %s at plan time', async (_label, value) => {
    await expect(planWith(value, `rate-bad-${String(value)}`)).rejects.toThrow(
      /volumeInitializationRateMiBps must be an integer from 100 to 300 MiB\/s, or null/,
    );
  });
});

describe('AWS root device mapping follows the AMI (WI-10006800)', () => {
  async function rootMapping(options: { configured?: string; imageRoot?: string }) {
    const base = desired();
    const { rootDeviceName: _fixtureRoot, ...providerWithoutRoot } = base.provider as Record<string, unknown>;
    const spec: WorkspaceHostDesiredSpec = {
      ...base,
      provider: options.configured === undefined ? providerWithoutRoot : { ...providerWithoutRoot, rootDeviceName: options.configured },
    };
    const { client, provider } = providerAndClient();
    if (options.imageRoot !== undefined) client.imageRootDevices.set(base.image.id, options.imageRoot);
    const plan = await provider.plan({ action: 'provision', operationId: 'root', idempotencyKey: 'root', desired: spec }, context());
    const instance = plan.steps.find((step) => step.id === 'run-instance')!.input as unknown as {
      request: AwsRunInstancesInput;
    };
    return instance.request.BlockDeviceMappings;
  }

  it("maps the root volume at the AMI's own RootDeviceName when no override is set", async () => {
    // Papercusp releases register /dev/xvda. The former fixed /dev/sda1 default described a second,
    // blank volume, so the root kept the image defaults and RunInstances refused the init rate.
    const mappings = await rootMapping({ imageRoot: '/dev/xvda' });
    expect(mappings).toHaveLength(1);
    expect(mappings[0].DeviceName).toBe('/dev/xvda');
    expect(mappings[0].Ebs).toMatchObject({ Encrypted: true, KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/key-123', VolumeSize: 40 });
  });

  it('accepts an override that names the same device as the AMI', async () => {
    const mappings = await rootMapping({ configured: '/dev/xvda', imageRoot: '/dev/xvda' });
    expect(mappings[0].DeviceName).toBe('/dev/xvda');
  });

  it('refuses at plan time an override that does not match the AMI root device', async () => {
    await expect(rootMapping({ configured: '/dev/sda1', imageRoot: '/dev/xvda' })).rejects.toThrow(
      /rootDeviceName '\/dev\/sda1' does not match image 'ami-ubuntu-2404' root device '\/dev\/xvda'/,
    );
  });

  it('uses an explicit override when the AMI is not visible, and refuses when it has neither', async () => {
    expect((await rootMapping({ configured: '/dev/sda1' }))[0].DeviceName).toBe('/dev/sda1');
    await expect(rootMapping({})).rejects.toThrow(/root device name cannot be read/);
  });
});

describe('AWS workspace-host provider planning', () => {
  it('refuses canary admission before planning unless the client verifies its independent deadline', async () => {
    const { provider, client } = providerAndClient();
    await expect(provider.plan({ action: 'provision', operationId: 'finite', idempotencyKey: 'finite', desired: desired() },
      { ...context(), canaryRunId: 'trial-run', canaryTeardownDeadlineAt: '2026-08-22T09:00:00.000Z' }))
      .rejects.toThrow(/independently verified provider deadline/);
    expect(client.createVolumeCalls).toEqual([]);
  });

  it('refuses caller-authored finite deadline settings in desired provider data', async () => {
    const { provider } = providerAndClient();
    for (const key of ['canaryRunId', 'canaryTeardownDeadlineAt', 'canaryDeadline', 'awsCanaryDeadline']) {
      const spec = desired(); spec.provider = { ...spec.provider, [key]: 'spoofed' };
      await expect(provider.plan({ action: 'provision', operationId: 'finite', idempotencyKey: 'finite', desired: spec }, context()))
        .rejects.toThrow(/validated controller admission/);
    }
  });

  it('rechecks the deadline immediately before a creating step, after an earlier successful plan', async () => {
    const { client } = providerAndClient();
    let allowed = true;
    const guarded = Object.assign(client, { assertCanaryAdmission: async () => {
      if (!allowed) throw new Error('finite deadline no longer sleeping');
    } });
    const provider = createAwsWorkspaceHostProvider({ client: guarded, now: () => NOW });
    const plan = await provider.plan({ action: 'provision', operationId: 'finite', idempotencyKey: 'finite', desired: desired() }, context());
    allowed = false;
    await expect(provider.apply({ planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] }, context()))
      .rejects.toThrow(/no longer sleeping/);
    expect(client.createVolumeCalls).toEqual([]);
  });

  it('builds deterministic RunInstances and encrypted EBS inputs with a stable 64-character ClientToken', async () => {
    const { provider } = providerAndClient();
    const request = {
      action: 'provision' as const,
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      desired: desired(),
    };
    const [first, replay] = await Promise.all([provider.plan(request, context()), provider.plan(request, context())]);

    expect(first.steps).toEqual(replay.steps);
    expect(first.steps.map((step) => ({ id: step.id, dependsOn: step.dependsOn }))).toEqual([
      { id: 'create-data-volume', dependsOn: [] },
      { id: 'run-instance', dependsOn: ['create-data-volume'] },
      { id: 'attach-data-volume', dependsOn: ['create-data-volume', 'run-instance'] },
      { id: 'start-host-bootstrap', dependsOn: ['attach-data-volume'] },
    ]);

    const volume = first.steps[0].input as unknown as { request: AwsCreateVolumeInput };
    expect(volume.request).toMatchObject({
      AvailabilityZone: 'us-east-1a',
      ClientToken: awsWorkspaceHostClientToken('operation-1:data-volume'),
      Encrypted: true,
      KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
      Size: 100,
      VolumeType: 'gp3',
    });
    // A NEW data volume is not snapshot-backed, and EBS refuses a rate on it (WI-10006140).
    expect(volume.request).not.toHaveProperty('VolumeInitializationRate');
    expect(volume.request.ClientToken).toHaveLength(AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH);

    const instance = first.steps[1].input as unknown as { request: AwsRunInstancesInput; vpcId: string };
    expect(instance.vpcId).toBe('vpc-123');
    expect(instance.request.ClientToken).toBe(awsWorkspaceHostClientToken('operation-1:instance'));
    expect(instance.request.ClientToken).toHaveLength(AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH);
    expect(instance.request).toMatchObject({
      LaunchTemplate: { LaunchTemplateId: 'lt-123', Version: '7' },
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: 'subnet-123',
          Groups: ['sg-egress', 'sg-workspace'],
          DeleteOnTermination: true,
          AssociatePublicIpAddress: false,
        },
      ],
      IamInstanceProfile: { Arn: 'arn:aws:iam::123456789012:instance-profile/PapercuspWorkspace' },
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/sda1',
          Ebs: {
            DeleteOnTermination: true,
            Encrypted: true,
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
            VolumeSize: 40,
            VolumeType: 'gp3',
            // The AMI-restored root hydrates at the default provisioned rate (WI-10006140).
            VolumeInitializationRate: 300,
          },
        },
      ],
      UserData: Buffer.from('#!/bin/sh\necho papercusp-bootstrap\n').toString('base64'),
    });
    expect(instance.request.TagSpecifications[0].Tags).toContainEqual({
      Key: 'papercusp:host-id',
      Value: 'host-aws-1',
    });
  });

  it('refuses dependent provider calls until prerequisite resource identities are persisted', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-2', idempotencyKey: 'operation-2', desired: desired() },
      context(),
    );
    const runStep = plan.steps[1];
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [] },
        context(),
      ),
    ).rejects.toThrow('requires the persisted disk resource identity');
    expect(client.runInstancesCalls).toHaveLength(0);

    const volumeResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
      context(),
    );
    expect('resource' in volumeResult && volumeResult.resource?.kind).toBe('disk');
    const volume = requireAppliedResource(volumeResult);
    expect(volume).toMatchObject({ region: 'us-east-1', zone: 'us-east-1a' });
    const instanceResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      context(),
    );
    expect('resource' in instanceResult && instanceResult.resource?.kind).toBe('vm');
    expect(client.runInstancesCalls).toHaveLength(1);
  });

  it('launches with no public IP and an SSM instance profile, reachable only over SSM (P-005)', async () => {
    const { client, provider } = providerAndClient();
    await provision(client, provider);

    // The request EC2 actually received, not just the plan: an omitted AssociatePublicIpAddress
    // would inherit the subnet's MapPublicIpOnLaunch, so false must be explicit on the wire input.
    expect(client.runInstancesCalls).toHaveLength(1);
    const [launch] = client.runInstancesCalls;
    expect(launch!.NetworkInterfaces).toHaveLength(1);
    expect(launch!.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
    expect(launch!.IamInstanceProfile.Arn).toBe('arn:aws:iam::123456789012:instance-profile/PapercuspWorkspace');
    // The ingress check ran against exactly the groups the instance is launched into.
    expect(client.describedSecurityGroups).toEqual([['sg-egress', 'sg-workspace']]);

    const transports = provider.capabilities.transportKinds;
    expect(transports).toContain('aws-ssm-ssh');
  });

  it('refuses to launch into a security group that has any inbound rule (P-005)', async () => {
    const { client, provider } = providerAndClient();
    client.securityGroupIngress.set('sg-workspace', 1);
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-ingress', idempotencyKey: 'operation-ingress', desired: desired() },
      context(),
    );
    const volume = requireAppliedResource(
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
        context(),
      ),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1], knownResources: [volume] },
        context(),
      ),
    ).rejects.toThrow('aws_workspace_host_security_group_has_ingress: sg-workspace');
    expect(client.runInstancesCalls).toHaveLength(0);
  });

  it('refuses to launch when EC2 cannot confirm a security group is closed (P-005)', async () => {
    const { client, provider } = providerAndClient();
    client.hiddenSecurityGroups.add('sg-egress');
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-hidden', idempotencyKey: 'operation-hidden', desired: desired() },
      context(),
    );
    const volume = requireAppliedResource(
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
        context(),
      ),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1], knownResources: [volume] },
        context(),
      ),
    ).rejects.toThrow('aws_workspace_host_security_group_unverifiable: sg-egress');
    expect(client.runInstancesCalls).toHaveLength(0);
  });

  it('fails closed when a desired persistent data volume is not encrypted', async () => {
    const { provider } = providerAndClient();
    const unencrypted = desired();
    unencrypted.data = { ...unencrypted.data, encrypted: false };

    await expect(
      provider.plan(
        {
          action: 'provision',
          operationId: 'operation-unencrypted',
          idempotencyKey: 'operation-unencrypted',
          desired: unencrypted,
        },
        context(),
      ),
    ).rejects.toThrow('data volumes must be encrypted');
  });
});

describe('AWS workspace-host provider contract and lifecycle', () => {
  it('declares versioned SSM SSH prerequisites and separates interactive SCP from bulk transfer', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const profile = await provider.getTransportProfile(host, context());

    expect(profile.compatibility.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'aws-session-manager-plugin', minimumVersion: '1.1.23.0' }),
        expect.objectContaining({ id: 'aws-ssm-agent', minimumVersion: '2.3.672.0' }),
      ]),
    );
    expect(profile.kind).toBe('aws-ssm-ssh');
    expect(profile.features.fileTransfer).toBe(true);
    expect(profile.compatibility.traffic['bulk-transfer']).toBe('discouraged');
    expect(profile.compatibility.audit).toMatchObject({ controlPlaneEvents: true, sessionContent: false });
    expect(profile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({
        feature: 'fileTransfer',
        trafficClass: 'bulk-transfer',
        strategy: 'provider-object-storage',
      }),
    );
  });

  it('exposes restricted direct SSH only when the caller supplies an explicit non-/0 allowlist', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    await expect(
      provider.getTransportProfile(
        host,
        context({ transportPreference: 'aws-direct-ssh', directAddress: '203.0.113.17' }),
      ),
    ).rejects.toThrow('explicit restricted source CIDR allowlist');

    const profile = await provider.getTransportProfile(
      host,
      context({
        transportPreference: 'aws-direct-ssh',
        directAddress: '203.0.113.17',
        directSshSourceRanges: ['198.51.100.42/32'],
      }),
    );
    expect(profile).toMatchObject({
      kind: 'aws-direct-ssh',
      audited: false,
      compatibility: { traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' } },
    });
  });

  it('passes the shared fake provider contract including reconcile, observation, transport, and confirmed destroy', async () => {
    const { provider } = providerAndClient();
    const report = await runFakeWorkspaceHostProviderContractSuite(provider, {
      adapterKind: 'fake',
      reportRef: 'artifact://workspace-host/aws/provider-contract-1',
      context: context(),
      desired: desired(),
      operationId: 'contract-operation',
      idempotencyKey: 'contract-operation',
      confirmedBy: 'vitest',
      now: () => NOW,
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS);
    expect(report.provisionedResources.map((item) => item.kind)).toEqual(['disk', 'vm']);
    expect(report.destroyConfirmations.map((item) => item.providerResourceId)).toEqual([
      'i-00000000000000001',
      'vol-00000000000000001',
    ]);
  });

  it('uses observed-state waiters for lifecycle actions, snapshots and repairs, then confirms instance and volume absence', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const actions = ['stop', 'start', 'restart', 'snapshot', 'repair'] as const;
    const results: WorkspaceHostApplyResult[] = [];
    for (const action of actions) {
      const plan = await provider.plan(
        action === 'snapshot'
          ? { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host, name: 'manual' }
          : { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host },
        context(),
      );
      results.push(
        await provider.apply(
          { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: resources },
          context(),
        ),
      );
    }

    expect(results.every((result) => result.state === 'applied')).toBe(true);
    expect({
      start: client.startCalls,
      stop: client.stopCalls,
      reboot: client.rebootCalls,
      repair: client.repairCalls,
      snapshots: client.createSnapshotCalls.length,
    }).toEqual({ start: 1, stop: 1, reboot: 1, repair: 1, snapshots: 1 });
    expect(client.waitedInstanceStates.map(({ state }) => state)).toEqual(
      expect.arrayContaining(['running', 'stopped']),
    );

    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:destroy',
        idempotencyKey: 'operation:destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const confirmations: string[] = [];
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
      if (result.state === 'destroyed') confirmations.push(result.confirmation.providerResourceId);
    }
    expect(confirmations).toEqual(['i-00000000000000001', 'vol-00000000000000001']);
    expect(client.terminateCalls).toBe(1);
    expect(client.deleteVolumeCalls).toBe(1);
    expect(client.describedInstances).toContain('i-00000000000000001');
    expect(client.describedVolumes).toContain('vol-00000000000000001');
    expect(client.waitedInstanceStates.map(({ state }) => state)).toContain('terminated');
    expect(client.waitedVolumeStates.map(({ state }) => state)).toContain('deleted');
  });

  it('reconciles an ambiguous RunInstances success by ClientToken without issuing another launch', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-3', idempotencyKey: 'operation-3', desired: desired() },
      context(),
    );
    const volumeResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
      context(),
    );
    const volume = requireAppliedResource(volumeResult);
    const runStep = plan.steps[1];
    const applied = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      context(),
    );
    expect(client.runInstancesCalls).toHaveLength(1);

    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: runStep,
        knownResources: [volume],
        reason: 'ambiguous-timeout',
        previousProviderRequestId: applied.providerRequestId,
      },
      context(),
    );
    expect(reconciled.state).toBe('unchanged');
    expect('resource' in reconciled && reconciled.resource?.providerId).toBe('i-00000000000000001');
    expect(client.runInstancesCalls).toHaveLength(1);
  });
});

// WI-10005332: EC2 can terminate an instance during launch (an unusable KMS key, a capacity
// shortfall). A repeated RunInstances with the same ClientToken returns that SAME instance, so
// the run-instance step can never succeed by retrying; it must fail terminally, not report
// in-progress and be reconciled forever.
describe('AWS workspace-host provider launch that EC2 terminates (WI-10005332)', () => {
  async function planWithVolume(provider: ReturnType<typeof createAwsWorkspaceHostProvider>) {
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-launch', idempotencyKey: 'operation-launch', desired: desired() },
      context(),
    );
    const volumeResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
      context(),
    );
    const runStep = plan.steps[1];
    expect(runStep.id).toBe('run-instance');
    return { plan, runStep, volume: requireAppliedResource(volumeResult) };
  }

  it('fails the run-instance step terminally when the launched instance terminates for a client-side cause', async () => {
    const { client, provider } = providerAndClient();
    const { plan, runStep, volume } = await planWithVolume(provider);
    client.launchFailure = {
      state: 'terminated',
      stateReason: {
        code: 'Client.InvalidKMSKey.InvalidState',
        message: 'Client.InvalidKMSKey.InvalidState: The KMS key provided is in an incorrect state',
      },
    };

    const error = await provider
      .apply({ planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] }, context())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AwsInstanceLaunchFailedError);
    const launchError = error as AwsInstanceLaunchFailedError;
    expect(launchError.code).toBe('Client.InvalidKMSKey.InvalidState');
    expect(launchError.transient).toBe(false);
    expect(launchError.message).toContain('i-00000000000000001');
    expect(launchError.message).toContain('KMS key provided is in an incorrect state');
    expect(workspaceHostProviderRetryClass(launchError)).toBe('terminal');
    expect(client.runInstancesCalls).toHaveLength(1);
  });

  it('marks an AWS-side launch failure transient for a new operation, while still failing this step terminally', async () => {
    const { client, provider } = providerAndClient();
    const { plan, runStep, volume } = await planWithVolume(provider);
    client.launchFailure = {
      state: 'shutting-down',
      stateReason: { code: 'Server.InsufficientInstanceCapacity', message: 'Insufficient capacity.' },
    };

    const error = await provider
      .apply({ planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] }, context())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AwsInstanceLaunchFailedError);
    expect((error as AwsInstanceLaunchFailedError).transient).toBe(true);
    expect((error as AwsInstanceLaunchFailedError).message).toContain('a new provision operation may succeed');
    expect(workspaceHostProviderRetryClass(error)).toBe('terminal');
  });

  it('fails reconcile terminally when the ClientToken names a launch that is shutting down', async () => {
    const { client, provider } = providerAndClient();
    const { plan, runStep, volume } = await planWithVolume(provider);
    const applied = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      context(),
    );
    client.setInstanceState('i-00000000000000001', 'shutting-down');
    client.launchFailure = {
      state: 'terminated',
      stateReason: { code: 'Client.VolumeLimitExceeded', message: 'Volume limit exceeded' },
    };

    const error = await provider
      .reconcile(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: runStep,
          knownResources: [volume],
          reason: 'ambiguous-timeout',
          previousProviderRequestId: applied.providerRequestId,
        },
        context(),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AwsInstanceLaunchFailedError);
    expect((error as AwsInstanceLaunchFailedError).code).toBe('Client.VolumeLimitExceeded');
    expect(workspaceHostProviderRetryClass(error)).toBe('terminal');
    expect(client.runInstancesCalls).toHaveLength(1);
  });

  it('still applies a launch that reaches running (control)', async () => {
    const { client, provider } = providerAndClient();
    const { plan, runStep, volume } = await planWithVolume(provider);
    const applied = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      context(),
    );
    expect(applied.state).toBe('applied');
    expect(requireAppliedResource(applied).providerId).toBe('i-00000000000000001');
  });
});

// aws-byoc-gcp-parity-2026-10-01 P-003: the AWS provider feeds the same teardown-obligation
// ledger as GCP. A created EC2 instance / EBS volume must open an obligation addressed for an
// out-of-band delete, and a confirmed delete must close exactly that row.
describe('AWS workspace-host provider teardown-obligation observers', () => {
  function observedProvider(overrides: { onResourceCreated?: (event: WorkspaceHostResourceCreatedEvent) => void } = {}) {
    const created: WorkspaceHostResourceCreatedEvent[] = [];
    const destroyed: Array<{ deleteOp: string; providerId: string; workspaceId: string }> = [];
    const client = new FakeAwsWorkspaceHostSdkClient();
    const provider = createAwsWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: overrides.onResourceCreated ?? ((event) => void created.push(event)),
      onResourceDestroyed: (event) =>
        void destroyed.push({ ...event.resource, workspaceId: event.workspaceId }),
    });
    return { client, provider, created, destroyed };
  }

  async function destroyAll(
    provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
    host: WorkspaceHostRef,
    resources: WorkspaceHostResourceRef[],
  ): Promise<void> {
    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:destroy',
        idempotencyKey: 'operation:destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
    }
  }

  it('opens one obligation per owned resource, addressed to the connection account and region', async () => {
    const { client, provider, created } = observedProvider();
    await provision(client, provider);

    expect(created.map((event) => [event.resource.kind, event.resource.providerId])).toEqual([
      ['disk', 'vol-00000000000000001'],
      ['vm', 'i-00000000000000001'],
    ]);
    for (const event of created) {
      expect(event).toMatchObject({
        workspaceId: 'workspace-aws-1',
        hostId: 'host-aws-1',
        parentResourceId: '123456789012',
        resource: { parentProviderId: '123456789012', region: 'us-east-1' },
      });
      // Every recorded row must be addressable for an out-of-band AWS delete.
      const addressability = describeCloudResourceDeleteAddress({
        provider: 'aws',
        resourceKind: event.resource.kind,
        resourceId: event.resource.providerId,
        projectId: event.resource.parentProviderId ?? '',
        zone: event.resource.zone ?? '',
        region: event.resource.region ?? '',
        parentResourceId: event.parentResourceId ?? '',
        hostId: event.hostId ?? '',
      });
      expect(addressability.addressable, JSON.stringify(addressability)).toBe(true);
    }
  });

  it('closes each obligation on a confirmed delete with an op that maps back to the recorded kind', async () => {
    const { client, provider, created, destroyed } = observedProvider();
    const { host, resources } = await provision(client, provider);
    await destroyAll(provider, host, resources);

    expect(destroyed).toEqual([
      { deleteOp: 'terminate-instance', providerId: 'i-00000000000000001', workspaceId: 'workspace-aws-1' },
      { deleteOp: 'delete-volume', providerId: 'vol-00000000000000001', workspaceId: 'workspace-aws-1' },
    ]);
    const createdKindById = new Map(created.map((event) => [event.resource.providerId, event.resource.kind]));
    for (const event of destroyed) {
      expect(cloudResourceKindForDeleteOp(event.deleteOp, 'aws')).toBe(createdKindById.get(event.providerId));
    }
  });

  it('fails the step when the obligation producer fails, so a billable resource is never untracked', async () => {
    const { provider } = observedProvider({
      onResourceCreated: () => {
        throw new Error('obligation ledger unavailable');
      },
    });
    const plan = await provider.plan(
      { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: desired() },
      context(),
    );
    await expect(
      provider.apply({ planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] }, context()),
    ).rejects.toThrow('obligation ledger unavailable');
  });
});

describe('AWS workspace-host bootstrap push (aws-byoc-gcp-parity D-013)', () => {
  /** Provision up to (not including) the bootstrap step; returns that step and the known resources. */
  async function provisionToBootstrap(client: FakeAwsWorkspaceHostSdkClient, provider: ReturnType<typeof createAwsWorkspaceHostProvider>) {
    const plan = await provider.plan(
      { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: desired() },
      context(),
    );
    const bootstrap = plan.steps.at(-1)!;
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps.slice(0, -1)) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }
    expect(client.shellCommands).toHaveLength(0);
    return { plan, bootstrap, resources };
  }

  it('declares the host bootstrap capability and the EC2 console status channel', () => {
    const { provider } = providerAndClient();
    expect(provider.capabilities.lifecycle.hostBootstrap).toBe(true);
    expect(provider.capabilities.lifecycle.bootstrapStatusChannel).toBe('ec2-console-output');
  });

  it('plans the bootstrap as the last provision step, after the data volume attaches, carrying the rendered script', async () => {
    const { client, provider } = providerAndClient();
    const { bootstrap } = await provisionToBootstrap(client, provider);
    expect(bootstrap).toMatchObject({
      id: 'start-host-bootstrap',
      dependsOn: ['attach-data-volume'],
      destructive: false,
      input: { op: 'start-host-bootstrap', hostId: 'host-aws-1', script: HOST_BOOTSTRAP, dataMode: 'fresh' },
    });
  });

  it('persists the controller tenant identity in its replayable bootstrap step', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'tenant', idempotencyKey: 'tenant', desired: desired() },
      { ...context(), hostBootstrapScript: HOST_BOOTSTRAP, durableTenantIdentity: 'a'.repeat(64),
        durableStorageAllocation: { dbGiB: 256, workspaceGiB: 32 } },
    );
    expect(plan.steps.find(({ id }) => id === 'start-host-bootstrap')!.input).toMatchObject({
      dataMode: 'fresh', tenantIdentity: 'a'.repeat(64), allocation: { dbGiB: 256, workspaceGiB: 32 },
    });
  });

  it('refuses to plan a provision or a repair without a controller-rendered bootstrap', async () => {
    const { client, provider } = providerAndClient();
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'p', idempotencyKey: 'p', desired: desired() },
        context({}, null),
      ),
    ).rejects.toThrow('aws_workspace_host_bootstrap_missing');
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'p', idempotencyKey: 'p', desired: desired() },
        context({}, '  \n'),
      ),
    ).rejects.toThrow('aws_workspace_host_bootstrap_missing');

    const { host } = await provision(client, provider);
    await expect(
      provider.plan({ action: 'repair', operationId: 'r', idempotencyKey: 'r', host }, context({}, null)),
    ).rejects.toThrow('aws_workspace_host_bootstrap_missing');
  });

  it('re-runs the bootstrap after repair, and only after repair', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const repair = await provider.plan({ action: 'repair', operationId: 'r', idempotencyKey: 'r', host }, context());
    expect(repair.steps.map((step) => ({ id: step.id, dependsOn: step.dependsOn }))).toEqual([
      { id: 'repair-instance', dependsOn: [] },
      { id: 'start-host-bootstrap', dependsOn: ['repair-instance'] },
    ]);
    expect(repair.steps.find(step => step.id === 'start-host-bootstrap')?.input.dataMode).toBe('existing');
    // Lifecycle actions that keep the boot disk need no bootstrap — and do not demand one.
    for (const action of ['start', 'stop', 'restart'] as const) {
      const plan = await provider.plan({ action, operationId: action, idempotencyKey: action, host }, context({}, null));
      expect(plan.steps.map((step) => step.id)).toEqual([`${action}-instance`]);
    }
  });

  it('pushes the bootstrap over SSM to the instance, naming the attached volume, and reports applied on Success', async () => {
    const { client, provider } = providerAndClient();
    const { plan, bootstrap, resources } = await provisionToBootstrap(client, provider);
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: bootstrap, knownResources: resources },
      context(),
    );

    expect(result.state).toBe('applied');
    expect(client.ssmOnlineWaits).toEqual(['i-00000000000000001']);
    expect(client.shellCommands).toHaveLength(1);
    const [sent] = client.shellCommands;
    expect(sent).toMatchObject({
      instanceId: 'i-00000000000000001',
      comment: 'Papercusp host bootstrap host-aws-1',
      executionTimeoutSec: AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC,
    });
    expect(sent!.commands).toEqual(
      renderAwsHostBootstrapPush({ volumeId: 'vol-00000000000000001', hostBootstrapScript: HOST_BOOTSTRAP }).commands,
    );
    // The device path rides inside the gzipped payload: decode it the way the host does.
    const payload = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(sent!.commands.join('\n'))?.[1];
    expect(payload).toBeDefined();
    const script = gunzipSync(Buffer.from(payload!, 'base64')).toString('utf8');
    expect(script).toContain(awsEbsNvmeDevicePath('vol-00000000000000001'));
    expect(script).toContain('echo papercusp-bootstrap');
    expect(client.commandWaits).toEqual([{ commandId: 'command-1', instanceId: 'i-00000000000000001' }]);
  });

  it('stays in progress, sending nothing, while SSM has not reported the instance Online', async () => {
    const { client, provider } = providerAndClient();
    const { plan, bootstrap, resources } = await provisionToBootstrap(client, provider);
    client.ssmOnline = false;
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: bootstrap, knownResources: resources },
      context(),
    );
    expect(result.state).toBe('in-progress');
    expect(client.shellCommands).toHaveLength(0);
  });

  it('stays in progress while the pushed command has not settled', async () => {
    const { client, provider } = providerAndClient();
    const { plan, bootstrap, resources } = await provisionToBootstrap(client, provider);
    client.commandInvocation = { status: 'InProgress' };
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: bootstrap, knownResources: resources },
      context(),
    );
    expect(result.state).toBe('in-progress');
  });

  it.each(['Failed', 'TimedOut', 'Cancelled', 'Undeliverable', 'Terminated'])(
    'fails the step with the exit code and output tail when the push settles %s',
    async (status) => {
      const { client, provider } = providerAndClient();
      const { plan, bootstrap, resources } = await provisionToBootstrap(client, provider);
      client.commandInvocation = { status, responseCode: 3, stderr: 'papercusp: data device never appeared\n' };
      await expect(
        provider.apply(
          { planId: plan.planId, operationId: plan.operationId, step: bootstrap, knownResources: resources },
          context(),
        ),
      ).rejects.toThrow(
        `aws_workspace_host_bootstrap_push_failed: ${status} exit=3: papercusp: data device never appeared`,
      );
    },
  );

  it('refuses to push before the volume and instance identities are known', async () => {
    const { client, provider } = providerAndClient();
    const { plan, bootstrap, resources } = await provisionToBootstrap(client, provider);
    await expect(
      provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: bootstrap,
          knownResources: resources.filter((item) => item.kind !== 'disk'),
        },
        context(),
      ),
    ).rejects.toThrow();
    expect(client.shellCommands).toHaveLength(0);
  });

  it('re-pushes on reconcile, since no provider record says whether an earlier push landed', async () => {
    const { client, provider } = providerAndClient();
    const { plan, bootstrap, resources } = await provisionToBootstrap(client, provider);
    const result = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: bootstrap,
        knownResources: resources,
        reason: 'ambiguous-timeout',
      },
      context(),
    );
    expect(result.state).toBe('applied');
    expect(client.shellCommands).toHaveLength(1);
  });
});

/**
 * Apply every plan step in order the way the controller does: each step sees the resources earlier
 * steps registered, an applied resource joins, and a confirmed-absent one leaves.
 */
async function applyPlan(
  provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
  plan: Awaited<ReturnType<ReturnType<typeof createAwsWorkspaceHostProvider>['plan']>>,
  initial: readonly WorkspaceHostResourceRef[],
  ctx: WorkspaceHostProviderContext = context(),
): Promise<{ known: WorkspaceHostResourceRef[]; results: Map<string, WorkspaceHostApplyResult> }> {
  const known = [...initial];
  const results = new Map<string, WorkspaceHostApplyResult>();
  for (const step of plan.steps) {
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...known] },
      ctx,
    );
    results.set(step.id, result);
    if ((result.state === 'applied' || result.state === 'unchanged') && result.resource) {
      if (!known.some((item) => item.providerId === result.resource!.providerId)) known.push(result.resource);
    }
    if (result.state === 'destroyed') {
      const index = known.findIndex((item) => item.providerId === result.confirmation.providerResourceId);
      if (index >= 0) known.splice(index, 1);
    }
  }
  return { known, results };
}

async function snapshotOf(
  provider: ReturnType<typeof createAwsWorkspaceHostProvider>,
  host: WorkspaceHostRef,
): Promise<string> {
  const plan = await provider.plan(
    { action: 'snapshot', operationId: 'snapshot-1', idempotencyKey: 'snapshot-1', host },
    context(),
  );
  const result = await provider.apply(
    { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: host.resources },
    context(),
  );
  if (!('snapshot' in result) || !result.snapshot) throw new Error('expected a snapshot');
  return result.snapshot.providerId;
}

describe('AWS restore and upgrade (WI-10005971, plan Decisions D-037/D-038)', () => {
  it('declares restore and upgrade, and launches the desired AMI and instance type explicitly', async () => {
    const { client, provider } = providerAndClient();
    expect(provider.capabilities.lifecycle.restore).toBe(true);
    expect(provider.capabilities.lifecycle.upgrade).toBe(true);
    await provision(client, provider);
    // The customer launch template carries only metadata options; without these EC2 has no image.
    expect(client.runInstancesCalls[0]).toMatchObject({ ImageId: 'ami-ubuntu-2404', InstanceType: 'm7i.large' });
  });

  it('refuses an image alias: a host boots the exact AMI its spec names', async () => {
    const { provider } = providerAndClient();
    const spec = { ...desired(), image: { id: 'resolve:ssm:/aws/service/ami-amazon-linux-latest' } };
    await expect(
      provider.plan({ action: 'provision', operationId: 'p', idempotencyKey: 'p', desired: spec }, context()),
    ).rejects.toThrow(/must be an EC2 AMI id/);
  });

  it('restores onto a distinct host whose data volume is created from the source snapshot', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const snapshotId = await snapshotOf(provider, host);
    const restoredSpec = { ...desired(), hostId: 'host-aws-restored' };
    const plan = await provider.plan(
      {
        action: 'restore',
        operationId: 'restore-1',
        idempotencyKey: 'restore-1',
        host,
        snapshot: { target: 'aws', providerId: snapshotId, hostId: host.hostId },
        desired: restoredSpec,
      },
      context(),
    );
    expect(plan.hostId).toBe('host-aws-restored');
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-data-volume',
      'run-instance',
      'attach-data-volume',
      'start-host-bootstrap',
    ]);
    expect(plan.steps.every((step) => step.action === 'restore')).toBe(true);
    const { known } = await applyPlan(provider, plan, []);
    const restoredVolume = client.createVolumeCalls.at(-1)!;
    expect(restoredVolume.SnapshotId).toBe(snapshotId);
    // A snapshot-restored data volume hydrates lazily too; restore sets the rate (WI-10006140).
    expect(restoredVolume.VolumeInitializationRate).toBe(AWS_VOLUME_INITIALIZATION_RATE_MIBPS.default);
    expect(known.map((item) => item.kind).sort()).toEqual(['disk', 'vm']);
    // The source host is untouched: its instance and volume are distinct from the restored ones.
    expect(known.some((item) => host.resources.some((source) => source.providerId === item.providerId))).toBe(false);
  });

  it('refuses a restore from a snapshot that is not a completed, managed snapshot of the source host', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const snapshotId = await snapshotOf(provider, host);
    const request = (overrides: Record<string, unknown> = {}) => ({
      action: 'restore' as const,
      operationId: 'restore-x',
      idempotencyKey: 'restore-x',
      host,
      snapshot: { target: 'aws', providerId: snapshotId, hostId: host.hostId },
      desired: { ...desired(), hostId: 'host-aws-restored' },
      ...overrides,
    });
    await expect(provider.plan(request({ desired: desired() }), context())).rejects.toThrow(/distinct target host/);
    await expect(
      provider.plan(request({ snapshot: { target: 'aws', providerId: snapshotId, hostId: 'host-other' } }), context()),
    ).rejects.toThrow(/exact source host/);
    await expect(provider.plan(request(), { ...context(), workspaceId: 'workspace-other' })).rejects.toThrow(
      /not a managed snapshot/,
    );
    client.snapshotTags.set(snapshotId, { ...client.snapshotTags.get(snapshotId), 'papercusp:host-id': 'host-other' });
    await expect(provider.plan(request(), context())).rejects.toThrow(/not a managed snapshot/);
    await expect(
      provider.plan(request({ snapshot: { target: 'aws', providerId: 'snap-0ff', hostId: host.hostId } }), context()),
    ).rejects.toThrow(/not completed \(absent\)/);
  });

  it('upgrades by replacing the instance from the target AMI, moving the data volume, and terminating the original LAST', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const original = host.resources.find((item) => item.kind === 'vm')!.providerId;
    const volume = host.resources.find((item) => item.kind === 'disk')!.providerId;
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'upgrade-1',
        idempotencyKey: 'upgrade-1',
        host,
        image: { id: 'ami-0123456789abcdef0', version: '0.0.21' },
        rollbackImage: { id: 'ami-ubuntu-2404' },
        desired: desired(),
      },
      context(),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      `quiesce-runtime-instance:${original}`,
      `detach-data-volume:${original}`,
      `launch-replacement-instance:${original}`,
      `attach-replacement-volume:${original}`,
      'start-host-bootstrap',
      `retire-runtime-instance:${original}`,
    ]);
    // Detaching is what strands the original, so it is the destructive step a failed launch rolls back from.
    expect(plan.steps.filter((step) => step.destructive).map((step) => step.id)).toEqual([
      `detach-data-volume:${original}`,
      `retire-runtime-instance:${original}`,
    ]);
    expect(plan.steps[2].rollback?.input).toMatchObject({ op: 'reinstate-instance', instanceId: original, volumeId: volume });

    const { known, results } = await applyPlan(provider, plan, host.resources);
    const replacement = known.find((item) => item.kind === 'vm')!.providerId;
    expect(replacement).not.toBe(original);
    expect(client.runInstancesCalls.at(-1)).toMatchObject({ ImageId: 'ami-0123456789abcdef0', InstanceType: 'm7i.large' });
    expect(client.detachVolumeCalls).toEqual([{ InstanceId: original, VolumeId: volume }]);
    expect(client.attachVolumeCalls.at(-1)).toMatchObject({ InstanceId: replacement, VolumeId: volume });
    expect(client.shellCommands.at(-1)!.instanceId).toBe(replacement);
    // The bootstrap step names the replacement, so the controller never records it against the original.
    const bootstrap = results.get('start-host-bootstrap')!;
    expect(bootstrap.state === 'applied' && bootstrap.resource?.providerId).toBe(replacement);
    expect(client.destroyMutations).toEqual([`terminate:${original}`]);
    expect(results.get(`retire-runtime-instance:${original}`)!.state).toBe('destroyed');
    expect(known.map((item) => item.providerId).sort()).toEqual([replacement, volume].sort());
  });

  it('persists the exact AWS scope when reconciling an ambiguously created volume', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan({ action: 'provision', operationId: 'scope-reconcile', idempotencyKey: 'scope-reconcile', desired: desired() }, context());
    const request = { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] };
    await provider.apply(request, context());
    const result = await provider.reconcile({ ...request, reason: 'ambiguous-timeout' }, context());
    expect(result.state).toBe('unchanged');
    expect(requireAppliedResource(result)).toMatchObject({ parentProviderId: '123456789012', region: 'us-east-1', zone: 'us-east-1a' });
  });

  it.each(['account', 'zone', 'multi-writer', 'tenant'])('refuses an AWS replacement with foreign %s before quiescing', async (mismatch) => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const disk = host.resources.find((item) => item.kind === 'disk')!;
    const describe = client.describeVolume.bind(client);
    client.describeVolume = async (id) => {
      const observed = await describe(id);
      return observed ? { ...observed,
        ...(mismatch === 'zone' ? { availabilityZone: 'us-east-1b' } : {}),
        ...(mismatch === 'multi-writer' ? { attachedInstanceIds: [observed.attachedInstanceId!, 'i-foreign'] } : {}),
        ...(mismatch === 'tenant' ? { tags: { ...observed.tags, 'papercusp:host-id': 'foreign-host' } } : {}),
      } : observed;
    };
    const resources = host.resources.map((item) => item === disk && mismatch === 'account'
      ? { ...item, parentProviderId: '999999999999' } : item);
    await expect(provider.plan({ action: 'upgrade', operationId: 'upgrade-foreign', idempotencyKey: 'upgrade-foreign',
      host: { ...host, resources }, desired: desired(), image: { id: 'ami-0123456789abcdef0' } }, context())).rejects.toThrow(/retained_volume/);
    expect(client.detachVolumeCalls).toHaveLength(0);
  });

  it('rolls a failed launch back by re-attaching the data volume to the original and starting it', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const original = host.resources.find((item) => item.kind === 'vm')!.providerId;
    const volume = host.resources.find((item) => item.kind === 'disk')!.providerId;
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'upgrade-2',
        idempotencyKey: 'upgrade-2',
        host,
        image: { id: 'ami-0123456789abcdef0' },
        desired: desired(),
      },
      context(),
    );
    for (const step of plan.steps.slice(0, 2)) {
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: host.resources },
        context(),
      );
    }
    expect((await client.describeVolume(volume))?.attachedInstanceId).toBeUndefined();
    const launch = plan.steps[2];
    const result = await provider.apply(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: { ...launch, id: `${launch.id}:rollback`, input: launch.rollback!.input },
        knownResources: host.resources,
      },
      context(),
    );
    expect(result.state).toBe('applied');
    expect((await client.describeVolume(volume))?.attachedInstanceId).toBe(original);
    expect((await client.describeInstance(original))?.state).toBe('running');
  });

  it('rolls a failure AFTER the launch back: retires the replacement, re-attaches the volume to the original and starts it (WI-10005978)', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const original = host.resources.find((item) => item.kind === 'vm')!.providerId;
    const volume = host.resources.find((item) => item.kind === 'disk')!.providerId;
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'upgrade-3',
        idempotencyKey: 'upgrade-3',
        host,
        image: { id: 'ami-0123456789abcdef0' },
        desired: desired(),
      },
      context(),
    );
    const detach = `detach-data-volume:${original}`;
    const attach = plan.steps.find((step) => step.id === `attach-replacement-volume:${original}`)!;
    const bootstrap = plan.steps.find((step) => step.id === 'start-host-bootstrap')!;
    const reinstate = { op: 'reinstate-instance', instanceId: original, volumeId: volume, retireReplacement: true };
    expect(bootstrap.input.dataMode).toBe('existing');
    expect(attach.rollback?.input).toMatchObject(reinstate);
    expect(bootstrap.rollback?.input).toMatchObject(reinstate);
    // lifecycle-runner strandedByFailure() rolls back only a step that depends on an applied
    // destructive step, so every step that carries a rollback must name the destructive detach.
    for (const step of plan.steps.filter((candidate) => candidate.rollback)) {
      expect(step.dependsOn, step.id).toContain(detach);
    }

    // quiesce, detach, launch and attach applied; the bootstrap then fails and its rollback runs.
    const { known } = await applyPlan(provider, { ...plan, steps: plan.steps.slice(0, 4) }, host.resources);
    const replacement = known.find((item) => item.kind === 'vm' && item.providerId !== original)!.providerId;
    expect((await client.describeVolume(volume))?.attachedInstanceId).toBe(replacement);
    const rollbackOf = (step: typeof bootstrap, knownResources: typeof known) =>
      provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: { ...step, id: `${step.id}:rollback`, input: step.rollback!.input },
          knownResources,
        },
        context(),
      );
    // Two candidate replacements are ambiguous: guessing could terminate the wrong instance.
    await expect(
      rollbackOf(bootstrap, [...known, { ...known.find((item) => item.kind === 'vm')!, providerId: 'i-0ambiguous000000' }]),
    ).rejects.toThrow(/ambiguous_replacement/);

    const result = await rollbackOf(bootstrap, known);
    expect(result.state).toBe('applied');
    expect(client.destroyMutations).toContain(`terminate:${replacement}`);
    expect(client.destroyMutations).not.toContain(`terminate:${original}`);
    expect((await client.describeInstance(replacement))?.state).toBe('terminated');
    expect((await client.describeVolume(volume))?.attachedInstanceId).toBe(original);
    expect((await client.describeInstance(original))?.state).toBe('running');
  });

  it('refuses an upgrade it cannot carry out exactly', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const upgrade = (overrides: Record<string, unknown> = {}) => ({
      action: 'upgrade' as const,
      operationId: 'upgrade-x',
      idempotencyKey: 'upgrade-x',
      host,
      image: { id: 'ami-0123456789abcdef0' },
      desired: desired(),
      ...overrides,
    });
    await expect(provider.plan(upgrade({ desired: undefined }), context())).rejects.toThrow(/recorded desired spec/);
    // The rollback reinstates the running instance, so it can only deliver the image that instance runs.
    await expect(provider.plan(upgrade({ rollbackImage: { id: 'ami-0fedcba9876543210' } }), context())).rejects.toThrow(
      /rollback image must be the recorded image/,
    );
    const twoInstances = {
      ...host,
      resources: [...host.resources, { target: 'aws', kind: 'vm', providerId: 'i-00000000000000099' }],
    };
    await expect(provider.plan(upgrade({ host: twoInstances }), context())).rejects.toThrow(/exactly one registered vm/);
    await expect(provider.plan(upgrade(), context({}, null))).rejects.toThrow(/aws_workspace_host_bootstrap_missing/);
  });
});

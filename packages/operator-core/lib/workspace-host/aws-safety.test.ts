/**
 * aws-byoc-gcp-parity-2026-10-01 P-003: the AWS managed-resource inventory (SDK v3 client) and the
 * AWS census profile over the shared, provider-neutral census in gcp-safety.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostProviderConnection, WorkspaceHostResourceRef } from '@papercusp/deployment-driver';
import {
  AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK,
  AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
  AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS,
  AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS,
  censusAwsWorkspaceHostResources,
  createAwsWorkspaceHostAmbiguousOperationRecoveryRecord,
  type AwsWorkspaceHostResourceCensusInput,
} from './aws-safety';
import {
  AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG,
  createAwsSdkWorkspaceHostClient,
  type AwsSdkClientConfig,
  type AwsSdkClientSet,
} from './aws-sdk-client';
import { createAwsWorkspaceHostProvider } from './aws-provider';
import type { ManagedWorkspaceHostResourceObservation, WorkspaceHostAmbiguousOperationRecoveryInput } from './gcp-safety';

vi.mock('@aws-sdk/credential-providers', () => {
  const credentials = () =>
    vi.fn(() => async () => ({ accessKeyId: 'test-access-key-id', secretAccessKey: 'test-secret', sessionToken: 'test' }));
  return {
    fromNodeProviderChain: credentials(),
    fromIni: credentials(),
    fromTemporaryCredentials: credentials(),
    fromWebToken: credentials(),
  };
});

const ACCOUNT = '413781344298';
const REGION = 'us-east-2';
const WORKSPACE = 'workspace-aws-census';
const HOST = 'host-aws-census-1';
const NOW = '2026-10-01T21:00:00.000Z';

function tags(hostId = HOST, workspaceId = WORKSPACE) {
  return [
    { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed, Value: 'true' },
    { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId, Value: hostId },
    { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId, Value: workspaceId },
  ];
}

function connection(): WorkspaceHostProviderConnection {
  return {
    target: 'aws',
    cloudCredentialRef: { kind: 'cloud', ref: 'aws-local:papercusp-byoc' },
    scope: { kind: 'account', id: ACCOUNT },
    provider: {
      credentialSource: { environment: 'local', method: 'shared-profile', profile: 'papercusp-byoc' },
      partition: 'aws',
      region: REGION,
    },
  };
}

/** A paginated EC2 world: two DescribeInstances pages, a terminated instance and a deleted volume. */
function fakeAws(callerAccount = ACCOUNT) {
  const sent: { name: string; region: string; input: Record<string, any> }[] = [];
  const createClients = (config: AwsSdkClientConfig): AwsSdkClientSet => {
    const client = (service: string) => ({
      send: async (command: { input: Record<string, any>; constructor: { name: string } }) => {
        const name = `${service}:${command.constructor.name}`;
        sent.push({ name, region: config.region, input: command.input });
        const meta = { $metadata: { requestId: `req-${sent.length}` } };
        switch (name) {
          case 'sts:GetCallerIdentityCommand':
            return { ...meta, Account: callerAccount, Arn: `arn:aws:sts::${callerAccount}:assumed-role/R/s`, UserId: 'AROA:s' };
          case 'ec2:DescribeInstancesCommand':
            return command.input.NextToken === 'page-2'
              ? { ...meta, Reservations: [{ Instances: [{ InstanceId: 'i-stray', State: { Name: 'stopped' }, Tags: tags('host-other') }] }] }
              : {
                  ...meta,
                  NextToken: 'page-2',
                  Reservations: [
                    {
                      Instances: [
                        { InstanceId: 'i-live', State: { Name: 'running' }, Placement: { AvailabilityZone: 'us-east-2a' }, Tags: tags() },
                        { InstanceId: 'i-gone', State: { Name: 'terminated' }, Tags: tags() },
                      ],
                    },
                  ],
                };
          case 'ec2:DescribeVolumesCommand':
            return {
              ...meta,
              Volumes: [
                { VolumeId: 'vol-live', State: 'in-use', AvailabilityZone: 'us-east-2a', Tags: tags() },
                { VolumeId: 'vol-gone', State: 'deleted', Tags: tags() },
              ],
            };
          case 'ec2:DescribeSnapshotsCommand':
            return { ...meta, Snapshots: [{ SnapshotId: 'snap-1', State: 'completed', Tags: tags() }] };
          case 'ec2:DescribeSpotInstanceRequestsCommand':
            // WI-10005454: only a request that can still launch an instance is a census resource.
            return {
              ...meta,
              SpotInstanceRequests: [
                { SpotInstanceRequestId: 'sir-live', State: 'active', LaunchedAvailabilityZone: 'us-east-2a', Tags: tags() },
                { SpotInstanceRequestId: 'sir-cancelled', State: 'cancelled', Tags: tags() },
                { SpotInstanceRequestId: 'sir-closed', State: 'closed', Tags: tags() },
                { SpotInstanceRequestId: 'sir-failed', State: 'failed', Tags: tags() },
              ],
            };
          default:
            throw new Error(`fake AWS does not implement ${name}`);
        }
      },
    });
    return {
      ec2: client('ec2'),
      ssm: client('ssm'),
      sts: client('sts'),
      iam: client('iam'),
      kms: client('kms'),
      serviceQuotas: client('servicequotas'),
      pricing: client('pricing'),
    } as unknown as AwsSdkClientSet;
  };
  const client = createAwsSdkWorkspaceHostClient({ connection: connection(), createClients, now: () => NOW });
  return { sent, client };
}

function ref(kind: string, providerId: string): WorkspaceHostResourceRef {
  return { target: 'aws', kind, providerId, parentProviderId: ACCOUNT, region: REGION };
}

function observation(kind: string, providerId: string, hostId = HOST, workspaceId = WORKSPACE): ManagedWorkspaceHostResourceObservation {
  return {
    resource: ref(kind, providerId),
    labels: Object.fromEntries(tags(hostId, workspaceId).map((tag) => [tag.Key, tag.Value])),
    observedAt: NOW,
  };
}

function evidence() {
  return AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.map((kind) => ({
    kind,
    strategy: 'managed-labels' as const,
    providerEvidenceRef: `aws://ec2/${ACCOUNT}/${REGION}/${kind}`,
  }));
}

function censusInput(overrides: Partial<AwsWorkspaceHostResourceCensusInput> = {}): AwsWorkspaceHostResourceCensusInput {
  return {
    hostId: HOST,
    workspaceId: WORKSPACE,
    expected: [ref('vm', 'i-live'), ref('disk', 'vol-live')],
    observed: [observation('vm', 'i-live'), observation('disk', 'vol-live')],
    inventoryEvidence: evidence(),
    evaluatedAt: NOW,
    orphanGraceMs: 60_000,
    ...overrides,
  };
}

describe('AWS managed-resource inventory (SDK v3 client)', () => {
  it('paginates instances, volumes, self-owned snapshots and live spot requests by the workspace managed tags', async () => {
    const { sent, client } = fakeAws();
    const inventory = await client.listManagedResources({ projectId: ACCOUNT, region: REGION, workspaceId: WORKSPACE });

    expect(inventory.complete).toBe(true);
    expect(inventory.observed.map((entry) => `${entry.resource.kind}:${entry.resource.providerId}`)).toEqual([
      'vm:i-live',
      'vm:i-stray',
      'disk:vol-live',
      'snapshot:snap-1',
      'spot-request:sir-live',
    ]);
    expect(inventory.observed.at(-1)).toMatchObject({
      resource: { target: 'aws', kind: 'spot-request', parentProviderId: ACCOUNT, region: REGION, zone: 'us-east-2a' },
      labels: { [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId]: HOST },
    });
    expect(inventory.observed[0]).toMatchObject({
      resource: { target: 'aws', parentProviderId: ACCOUNT, region: REGION, zone: 'us-east-2a' },
      labels: { [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId]: HOST },
      observedAt: NOW,
    });
    expect(inventory.inventoryEvidence.map((entry) => entry.kind)).toEqual(['vm', 'disk', 'snapshot', 'spot-request']);
    expect(inventory.inventoryEvidence.at(-1)!.providerEvidenceRef).toContain('/describe-spot-instance-requests?');

    const describes = sent.filter((entry) => entry.name.startsWith('ec2:Describe'));
    expect(describes.every((entry) => entry.region === REGION)).toBe(true);
    expect(describes.map((entry) => entry.name)).toContain('ec2:DescribeSpotInstanceRequestsCommand');
    expect(describes.filter((entry) => entry.name === 'ec2:DescribeInstancesCommand').map((entry) => entry.input.NextToken)).toEqual([
      undefined,
      'page-2',
    ]);
    for (const entry of describes) {
      expect(entry.input.Filters).toEqual([
        { Name: 'tag:papercusp:managed', Values: ['true'] },
        { Name: `tag:papercusp:workspace-id`, Values: [WORKSPACE] },
      ]);
    }
    expect(describes.find((entry) => entry.name === 'ec2:DescribeSnapshotsCommand')!.input.OwnerIds).toEqual(['self']);
  });

  it('refuses to claim an inventory for an account the credentials do not resolve to', async () => {
    const { client } = fakeAws('999999999999');
    await expect(
      client.listManagedResources({ projectId: ACCOUNT, region: REGION, workspaceId: WORKSPACE }),
    ).rejects.toThrow('aws_workspace_host_account_mismatch');
  });

  it('refuses an account other than the one the connection is bound to, and an empty workspace', async () => {
    const { client } = fakeAws();
    await expect(
      client.listManagedResources({ projectId: '111122223333', region: REGION, workspaceId: WORKSPACE }),
    ).rejects.toThrow('aws_workspace_host_inventory_account_mismatch');
    await expect(client.listManagedResources({ projectId: ACCOUNT, region: REGION, workspaceId: ' ' })).rejects.toThrow(
      'aws_workspace_host_inventory_workspace_id_required',
    );
  });

  it('is what AwsWorkspaceHostProvider.inventoryManagedResources returns, and feeds a census that finds the stray', async () => {
    const { client } = fakeAws();
    const provider = createAwsWorkspaceHostProvider({ client, now: () => NOW });
    const inventory = await provider.inventoryManagedResources({ projectId: ACCOUNT, region: REGION, workspaceId: WORKSPACE });
    const census = censusAwsWorkspaceHostResources(
      censusInput({
        expected: [ref('vm', 'i-live'), ref('disk', 'vol-live'), ref('spot-request', 'sir-live')],
        observed: inventory.observed,
        inventoryEvidence: inventory.inventoryEvidence,
        retained: [ref('snapshot', 'snap-1')],
      }),
    );
    expect(census.untracked).toEqual([]);
    expect(census.missing).toEqual([]);
    expect(census.managed.map((entry) => entry.resource.providerId)).toEqual(['i-live', 'vol-live', 'snap-1', 'sir-live']);
    // Without registeredHostResources this is the STRICT workspace-wide census: i-stray carries
    // another host's tag in the same workspace, so it is surfaced rather than silently ignored.
    expect(census.labelMismatches.map((entry) => entry.resource.providerId)).toEqual(['i-stray']);
    expect(census.clean).toBe(false);
  });
});

describe('censusAwsWorkspaceHostResources', () => {
  it('is clean when every expected resource is observed with this host and workspace tags', () => {
    const census = censusAwsWorkspaceHostResources(censusInput());
    expect(census.clean).toBe(true);
    expect(census.inventoryEvidence.map((entry) => entry.kind)).toEqual(['vm', 'disk', 'snapshot', 'spot-request']);
  });

  it('accepts resources carrying the papercusp:client-token idempotency tag and keeps only the managed tags (WI-10006843)', () => {
    // EBS volumes and snapshots carry Papercusp's own idempotency tag, and a customer may put any
    // tag on a managed resource. The public-metadata secret guard rejects '-token' keys, so raw
    // provider tags in the census input used to fail every AWS teardown's terminal evidence.
    const managedKeys = [
      AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed,
      AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId,
      AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId,
    ].sort();
    const extraTagged = (entry: ManagedWorkspaceHostResourceObservation): ManagedWorkspaceHostResourceObservation => ({
      ...entry,
      labels: { ...entry.labels, [AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG]: 'op-provision-1', 'customer-api-token': 'x' },
    });
    const census = censusAwsWorkspaceHostResources(
      censusInput({
        observed: [
          extraTagged(observation('vm', 'i-live')),
          extraTagged(observation('disk', 'vol-live')),
          extraTagged(observation('snapshot', 'snap-stray')),
        ],
      }),
    );
    expect(census.untracked.map((entry) => entry.resource.providerId)).toEqual(['snap-stray']);
    for (const entry of [...census.managed, ...census.untracked]) {
      expect(Object.keys(entry.labels).sort()).toEqual(managedKeys);
    }
    expect(JSON.stringify(census)).not.toContain('token');
  });

  it('still refuses secret material in a managed tag value after dropping the other tags (WI-10006843)', () => {
    // The source never spells the PEM header (the secrets and pot-git publish guards match it);
    // the runtime string is exactly what the census guard matches.
    const keyWords = ['PRIVATE', 'KEY'].join(' ');
    const leaked = observation('disk', 'vol-live');
    const census = () =>
      censusAwsWorkspaceHostResources(
        censusInput({
          observed: [
            observation('vm', 'i-live'),
            {
              ...leaked,
              labels: { ...leaked.labels, [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId]: `-----BEGIN ${keyWords}-----` },
            },
          ],
        }),
      );
    expect(census).toThrow(/Secret material is forbidden/);
  });

  it('is not clean after a teardown while the host still has a live spot request (WI-10005454)', () => {
    // The post-delete census expects nothing to survive. A persistent request left open would
    // relaunch the host, so it must read as an untracked survivor, not pass silently.
    const census = censusAwsWorkspaceHostResources(
      censusInput({ expected: [], observed: [observation('spot-request', 'sir-open')] }),
    );
    expect(census.clean).toBe(false);
    expect(census.untracked.map((entry) => `${entry.resource.kind}:${entry.resource.providerId}`)).toEqual([
      'spot-request:sir-open',
    ]);
    expect(census.reaperPlan[0]!.preconditions).not.toContain('durable-data-disposition');
    expect(censusAwsWorkspaceHostResources(censusInput({ expected: [], observed: [] })).clean).toBe(true);
  });

  it('plans an untracked managed volume for confirm-and-delete with a data-disposition precondition', () => {
    const census = censusAwsWorkspaceHostResources(
      censusInput({ observed: [observation('vm', 'i-live'), observation('disk', 'vol-live'), observation('disk', 'vol-orphan')] }),
    );
    expect(census.clean).toBe(false);
    expect(census.untracked.map((entry) => entry.resource.providerId)).toEqual(['vol-orphan']);
    expect(census.reaperPlan[0]).toMatchObject({
      action: 'confirm-and-delete',
      state: 'quarantine',
      requiredLabels: {
        'papercusp:managed': 'true',
        'papercusp:host-id': HOST,
        'papercusp:workspace-id': WORKSPACE,
      },
    });
    expect(census.reaperPlan[0]!.preconditions).toContain('durable-data-disposition');
  });

  it('reports an expected resource that is gone, and one whose host tag was changed', () => {
    const census = censusAwsWorkspaceHostResources(
      censusInput({ observed: [observation('vm', 'i-live', 'host-renamed')] }),
    );
    expect(census.missing.map((entry) => entry.providerId)).toEqual(['i-live', 'vol-live']);
    expect(census.labelMismatches.map((entry) => entry.resource.providerId)).toEqual(['i-live']);
  });

  it('refuses an incomplete inventory and a resource from another cloud', () => {
    expect(() => censusAwsWorkspaceHostResources(censusInput({ inventoryEvidence: evidence().slice(0, 2) }))).toThrow(
      'AWS workspace-host census inventory incomplete: snapshot, spot-request',
    );
    // An inventory that never read spot requests cannot prove a spot host's teardown clean.
    expect(() => censusAwsWorkspaceHostResources(censusInput({ inventoryEvidence: evidence().slice(0, 3) }))).toThrow(
      'AWS workspace-host census inventory incomplete: spot-request',
    );
    expect(() =>
      censusAwsWorkspaceHostResources(censusInput({ expected: [{ ...ref('vm', 'i-live'), target: 'gcp' }] })),
    ).toThrow("census expected[0] must target 'aws'");
  });
});

describe('createAwsWorkspaceHostAmbiguousOperationRecoveryRecord (P-007)', () => {
  // Mixed-case ids on purpose: AWS tag values are verbatim, where GCP labels would lowercase them.
  const hostId = 'Host_AWS-7';
  const workspaceId = 'Workspace_ABC';
  const volume: WorkspaceHostResourceRef = { target: 'aws', kind: 'disk', providerId: 'vol-0data' };
  const tags = {
    [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed]: 'true',
    [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId]: hostId,
    [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId]: workspaceId,
  };

  function recoveryInput(
    overrides: Partial<WorkspaceHostAmbiguousOperationRecoveryInput> = {},
    read: Partial<WorkspaceHostAmbiguousOperationRecoveryInput['providerRead']> = {},
  ): WorkspaceHostAmbiguousOperationRecoveryInput {
    return {
      operationId: 'op-create-volume-1',
      idempotencyKey: 'client-token-1',
      attemptedAction: 'create',
      resource: volume,
      hostId,
      workspaceId,
      actorId: 'su-operator',
      reason: 'CreateVolume timed out',
      issuedAt: '2026-10-02T00:10:00.000Z',
      maxEvidenceAgeMs: 300_000,
      providerRead: {
        resource: volume,
        state: 'present',
        observedAt: '2026-10-02T00:09:00.000Z',
        providerEvidenceRef: 'ec2-request:0f3a',
        labels: tags,
        ...read,
      },
      ...overrides,
    };
  }

  it('closes a create proven by a fresh EC2 read carrying the verbatim papercusp:* tags', () => {
    const record = createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(recoveryInput());
    expect(record).toMatchObject({
      kind: 'aws-workspace-host-ambiguous-operation-recovery',
      runbookRef: AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
      closesOperation: true,
      nextAction: 'mark-step-applied',
    });
    expect(AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK.ref).toBe(AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF);
    expect(AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK.steps.join(' ')).toContain('ClientToken');
  });

  it('accepts an EC2 read that also carries the papercusp:client-token tag and records only the managed tags (WI-10006843)', () => {
    const record = createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(
      recoveryInput({}, { labels: { ...tags, [AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG]: 'client-token-1' } }),
    );
    expect(record.closesOperation).toBe(true);
    expect(record.providerRead.labels).toEqual(tags);
  });

  it('closes a delete only when EC2 reads the resource absent, and resumes with the same token otherwise', () => {
    expect(
      createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(
        recoveryInput({ attemptedAction: 'delete' }, { state: 'absent', labels: undefined }),
      ),
    ).toMatchObject({ closesOperation: true, nextAction: 'mark-step-destroyed' });
    expect(
      createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(recoveryInput({ attemptedAction: 'delete' })),
    ).toMatchObject({ closesOperation: false, nextAction: 'resume-reconcile-with-same-idempotency-key' });
  });

  it('refuses a present read whose tags are GCP-shaped or lowercased instead of the exact AWS identity', () => {
    const gcpShaped = {
      'papercusp-managed': 'true',
      'papercusp-host-id': hostId,
      'papercusp-workspace-id': workspaceId,
    };
    const lowercased = { ...tags, [AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId]: hostId.toLowerCase() };
    for (const labels of [gcpShaped, lowercased]) {
      expect(() => createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(recoveryInput({}, { labels }))).toThrow(
        'lacks the exact managed host/workspace labels',
      );
    }
  });

  it('refuses a GCP resource, a stale read and a read of a different resource', () => {
    const gcpDisk: WorkspaceHostResourceRef = { ...volume, target: 'gcp' };
    expect(() =>
      createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(recoveryInput({ resource: gcpDisk }, { resource: gcpDisk })),
    ).toThrow("ambiguous resource must target 'aws'");
    expect(() =>
      createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(recoveryInput({}, { observedAt: '2026-10-01T23:00:00.000Z' })),
    ).toThrow('fresh, non-future provider read');
    expect(() =>
      createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(
        recoveryInput({}, { resource: { ...volume, providerId: 'vol-0other' } }),
      ),
    ).toThrow('does not match the attempted resource');
  });
});

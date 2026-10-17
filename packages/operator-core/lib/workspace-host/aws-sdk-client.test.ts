import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceHostApplyResult,
  WorkspaceHostDesiredSpec,
  WorkspaceHostProviderConnection,
  WorkspaceHostProviderContext,
  WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import { workspaceHostProviderRetryClass } from '@papercusp/deployment-driver';
import {
  fromIni,
  fromNodeProviderChain,
  fromTemporaryCredentials,
  fromWebToken,
} from '@aws-sdk/credential-providers';
import {
  AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG,
  AwsWorkspaceHostSdkError,
  createAwsSdkCredentialProvider,
  createAwsSdkWorkspaceHostClient,
  type AwsSdkClientConfig,
  type AwsSdkClientSet,
} from './aws-sdk-client';
import { AWS_SPOT_MARKET_OPTIONS, createAwsWorkspaceHostProvider } from './aws-provider';
import { AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC, renderAwsHostBootstrapPush } from './aws-host-bootstrap-push';
import { planAwsSdkCredentialProvider, preflightAwsWorkspaceHostConnection } from './aws-connection';

// The credential-provider factories reach the network and the operator's ~/.aws, so they are
// replaced by tagged fakes that resolve a fixed identity carrying KNOWN secret material.
// Credential-SHAPED on purpose (the redaction tests below need realistic values), and assembled
// from fragments so this source file never contains a literal credential for the git-sync
// secrets scanner to quarantine (it did, 2026-10-01: P-002's tests sat uncommitted for ~2h).
const SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYSECRETKEY01'].join('/');
const TOKEN = ['IQoJb3JpZ2luX2Vj', 'EXAMPLESESSIONTOKEN', '0123456789abcdefSESSION'].join('');
vi.mock('@aws-sdk/credential-providers', () => {
  const tagged = (kind: string) =>
    vi.fn((init: unknown) =>
      Object.assign(
        async () => ({ accessKeyId: `ASIA${kind.toUpperCase().padEnd(16, 'X').slice(0, 16)}`, secretAccessKey: SECRET, sessionToken: TOKEN }),
        { kind, init },
      ),
    );
  return {
    fromNodeProviderChain: tagged('chain'),
    fromIni: tagged('ini'),
    fromTemporaryCredentials: tagged('temp'),
    fromWebToken: tagged('web'),
  };
});

const ACCOUNT = '413781344298';
const REGION = 'us-east-2';
const NOW = '2026-10-01T20:00:00.000Z';

function connection(credentialSource: Record<string, unknown> = { environment: 'local', method: 'shared-profile', profile: 'papercusp-byoc' }): WorkspaceHostProviderConnection {
  return {
    target: 'aws',
    cloudCredentialRef: { kind: 'cloud', ref: 'aws-local:papercusp-byoc' },
    scope: { kind: 'account', id: ACCOUNT },
    provider: { credentialSource, partition: 'aws', region: REGION },
  };
}

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-aws-sdk-1',
    target: 'aws',
    scope: { kind: 'account', id: ACCOUNT },
    region: REGION,
    zone: 'us-east-2a',
    size: 'm7i.large',
    image: { id: 'ami-0abc', version: '2026.10.01' },
    data: { volumeGiB: 100, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'aws-local:papercusp-byoc' } },
    provider: {
      vpcId: 'vpc-1',
      subnetId: 'subnet-1',
      securityGroupIds: ['sg-1'],
      instanceProfileArn: `arn:aws:iam::${ACCOUNT}:instance-profile/PapercuspWorkspace`,
      launchTemplateId: 'lt-1',
      kmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/k-1`,
      rootVolumeGiB: 40,
    },
  };
}

/** Provision and repair need the controller-rendered bootstrap (D-013). */
const HOST_BOOTSTRAP = '#!/usr/bin/env bash\necho papercusp-bootstrap\n';

function ctx(): WorkspaceHostProviderContext {
  return { workspaceId: 'ws-1', requestId: 'req-1', hostBootstrapScript: HOST_BOOTSTRAP, connection: connection() };
}

interface Sent {
  service: string;
  region: string;
  command: string;
  input: Record<string, any>;
}

function awsError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400, requestId: 'req-err' }, ...extra });
}

/** A small in-memory EC2/STS/SSM/IAM/Pricing world behind structural SDK client fakes. */
class FakeAws {
  readonly sent: Sent[] = [];
  readonly regionsBuilt: string[] = [];
  account = ACCOUNT;
  instanceState: string = 'running';
  /** EC2's StateReason on described instances (WI-10005332); absent by default, as for a healthy instance. */
  instanceStateReason?: { Code: string; Message?: string };
  ssmDenied = false;
  /** SSM agent PingStatus for every instance (D-013 waits for Online before pushing). */
  ssmPingStatus = 'Online';
  /** What GetCommandInvocation reports for every pushed command. */
  commandInvocation: Record<string, unknown> = { Status: 'Success', ResponseCode: 0 };
  readonly overrides = new Map<string, (input: any) => unknown>();
  private seq = 0;
  readonly volumes = new Map<string, { id: string; state: string; token?: string; tags: { Key: string; Value: string }[]; attachedTo?: string }>();
  readonly instances = new Map<string, { id: string; token: string; spotRequestId?: string }>();
  readonly snapshots = new Map<string, { id: string; tags: { Key: string; Value: string }[] }>();

  readonly createClients = (config: AwsSdkClientConfig): AwsSdkClientSet => {
    this.regionsBuilt.push(config.region);
    const client = (service: string) => ({
      send: async (command: { input: Record<string, any>; constructor: { name: string } }) => {
        await config.credentials(); // the real SDK resolves credentials to sign every request
        const name = command.constructor.name;
        this.sent.push({ service, region: config.region, command: name, input: command.input });
        const handler = this.overrides.get(`${service}:${name}`) ?? this.handle.bind(this, `${service}:${name}`);
        const result = (await handler(command.input)) as Record<string, unknown>;
        return { $metadata: { requestId: `req-${++this.seq}` }, ...result };
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

  commands(command: string): Sent[] {
    return this.sent.filter((entry) => entry.command === command);
  }

  private next(prefix: string): string {
    return `${prefix}-${String(++this.seq).padStart(4, '0')}`;
  }

  private handle(key: string, input: any): unknown {
    switch (key) {
      case 'sts:GetCallerIdentityCommand':
        return { Account: this.account, Arn: `arn:aws:sts::${this.account}:assumed-role/PapercuspByoc/session`, UserId: 'AROA:session' };
      case 'ec2:CreateVolumeCommand': {
        const existing = [...this.volumes.values()].find((v) => v.token === input.ClientToken);
        if (existing) return { VolumeId: existing.id };
        // Real EBS ids are vol- plus 17 hex digits; the bootstrap push derives the NVMe device from it.
        const id = `vol-${String(++this.seq).padStart(17, '0')}`;
        this.volumes.set(id, { id, state: 'available', token: input.ClientToken, tags: input.TagSpecifications[0].Tags });
        return { VolumeId: id };
      }
      case 'ec2:DescribeVolumesCommand': {
        if (input.VolumeIds) {
          const volume = this.volumes.get(input.VolumeIds[0]);
          if (!volume) throw awsError('InvalidVolume.NotFound', 'not found');
          return { Volumes: [this.volumeShape(volume)] };
        }
        const tag = input.Filters?.[0];
        const key = String(tag?.Name).replace(/^tag:/, '');
        return {
          Volumes: [...this.volumes.values()]
            .filter((v) => v.tags.some((t) => t.Key === key && tag.Values.includes(t.Value)))
            .map((v) => this.volumeShape(v)),
        };
      }
      case 'ec2:AttachVolumeCommand': {
        const volume = this.volumes.get(input.VolumeId)!;
        volume.state = 'in-use';
        volume.attachedTo = input.InstanceId;
        return {};
      }
      case 'ec2:DeleteVolumeCommand':
        if (!this.volumes.delete(input.VolumeId)) throw awsError('InvalidVolume.NotFound', 'not found');
        return {};
      case 'ec2:RunInstancesCommand': {
        const existing = [...this.instances.values()].find((i) => i.token === input.ClientToken);
        const id = existing?.id ?? this.next('i');
        if (!existing) {
          this.instances.set(id, {
            id,
            token: input.ClientToken,
            ...(input.InstanceMarketOptions ? { spotRequestId: `sir-${id}` } : {}),
          });
        }
        return { Instances: [{ InstanceId: id }] };
      }
      case 'ec2:CancelSpotInstanceRequestsCommand': {
        const known = new Set([...this.instances.values()].map((i) => i.spotRequestId).filter(Boolean));
        if (input.SpotInstanceRequestIds.some((id: string) => !known.has(id))) {
          throw awsError('InvalidSpotInstanceRequestID.NotFound', 'not found');
        }
        return { CancelledSpotInstanceRequests: input.SpotInstanceRequestIds.map((id: string) => ({ SpotInstanceRequestId: id, State: 'cancelled' })) };
      }
      case 'ec2:DescribeInstancesCommand': {
        const filter = input.Filters?.find((f: { Name: string }) => f.Name === 'client-token');
        const matches = input.InstanceIds
          ? input.InstanceIds.map((id: string) => this.instances.get(id)).filter(Boolean)
          : [...this.instances.values()].filter((i) => filter?.Values.includes(i.token));
        if (input.InstanceIds && matches.length === 0) throw awsError('InvalidInstanceID.NotFound', 'not found');
        return {
          Reservations: matches.map((i: { id: string }) => ({
            Instances: [
              {
                InstanceId: i.id,
                ImageId: 'ami-0abc',
                State: { Name: this.instanceState },
                ...(this.instanceStateReason ? { StateReason: this.instanceStateReason } : {}),
                ...((i as { spotRequestId?: string }).spotRequestId
                  ? { SpotInstanceRequestId: (i as { spotRequestId?: string }).spotRequestId }
                  : {}), // DescribeInstances' own field name
                BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-root' } }],
              },
            ],
          })),
        };
      }
      case 'ec2:DescribeInstanceStatusCommand':
        return {
          InstanceStatuses: [
            { InstanceId: input.InstanceIds[0], InstanceStatus: { Status: 'ok' }, SystemStatus: { Status: 'initializing' } },
          ],
        };
      case 'ssm:DescribeInstanceInformationCommand':
        if (this.ssmDenied) throw awsError('AccessDeniedException', 'not authorized', { $metadata: { httpStatusCode: 400 } });
        return { InstanceInformationList: [{ InstanceId: input.Filters[0].Values[0], PingStatus: this.ssmPingStatus }] };
      case 'ssm:SendCommandCommand':
        return { Command: { CommandId: this.next('command') } };
      case 'ssm:GetCommandInvocationCommand':
        return { CommandId: input.CommandId, InstanceId: input.InstanceId, ...this.commandInvocation };
      case 'ec2:StartInstancesCommand':
        this.instanceState = 'running';
        return {};
      case 'ec2:StopInstancesCommand':
        this.instanceState = 'stopped';
        return {};
      case 'ec2:RebootInstancesCommand':
        return {};
      case 'ec2:TerminateInstancesCommand':
        this.instanceState = 'terminated';
        return {};
      case 'ec2:CreateSnapshotCommand': {
        const id = this.next('snap');
        this.snapshots.set(id, { id, tags: input.TagSpecifications[0].Tags });
        return { SnapshotId: id };
      }
      case 'ec2:DescribeSnapshotsCommand': {
        const all = [...this.snapshots.values()];
        const tag = input.Filters?.[0];
        const key = tag ? String(tag.Name).replace(/^tag:/, '') : undefined;
        const found = input.SnapshotIds
          ? all.filter((s) => input.SnapshotIds.includes(s.id))
          : all.filter((s) => s.tags.some((t) => t.Key === key && tag.Values.includes(t.Value)));
        return { Snapshots: found.map((s) => ({ SnapshotId: s.id, State: 'completed' })) };
      }
      // P-005: every group the fixture launches into is closed (no ingress permissions).
      case 'ec2:DescribeSecurityGroupsCommand':
        return {
          SecurityGroups: (input.GroupIds as string[]).map((GroupId) => ({ GroupId, IpPermissions: [] })),
        };
      case 'ec2:DescribeRegionsCommand':
        return {
          Regions: [
            { RegionName: 'us-east-2', OptInStatus: 'opt-in-not-required' },
            { RegionName: 'af-south-1', OptInStatus: 'not-opted-in' },
          ],
        };
      case 'ec2:DescribeAvailabilityZonesCommand':
        return { AvailabilityZones: [{ ZoneName: 'us-east-2b' }, { ZoneName: 'us-east-2a' }] };
      case 'ec2:DescribeInstanceTypesCommand':
        return input.NextToken
          ? { InstanceTypes: [{ InstanceType: 'm7g.large', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 }, ProcessorInfo: { SupportedArchitectures: ['arm64'] } }] }
          : {
              InstanceTypes: [{ InstanceType: 'm7i.xlarge', VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16384 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } }],
              NextToken: 'page-2',
            };
      case 'ec2:DescribeImagesCommand':
        return input.ImageIds
          ? {
              Images: [
                // Papercusp releases register /dev/xvda (aws-ami-production.ts); WI-10006800.
                { ImageId: input.ImageIds[0], OwnerId: ACCOUNT, State: 'available', Architecture: 'x86_64', RootDeviceName: '/dev/xvda' },
              ],
            }
          : {
              Images: [
                {
                  ImageId: 'ami-0abc',
                  Name: 'papercusp-workspace-host-2026.10.01',
                  Architecture: 'x86_64',
                  CreationDate: '2026-10-01T00:00:00.000Z',
                  Tags: [
                    { Key: 'papercusp:image-version', Value: '2026.10.01' },
                    { Key: 'papercusp:release-sha256', Value: 'a'.repeat(64) },
                  ],
                },
              ],
            };
      case 'pricing:GetProductsCommand': {
        const storage = input.Filters.some((f: { Field: string; Value: string }) => f.Field === 'productFamily');
        const dimension = storage ? { unit: 'GB-Mo', pricePerUnit: { USD: '0.0800000000' } } : { unit: 'Hrs', pricePerUnit: { USD: '0.1008000000' } };
        return { PriceList: [JSON.stringify({ terms: { OnDemand: { t1: { priceDimensions: { d1: dimension } } } } })] };
      }
      default:
        throw new Error(`FakeAws has no handler for ${key}`);
    }
  }

  private volumeShape(volume: { id: string; state: string; tags: { Key: string; Value: string }[]; attachedTo?: string }) {
    return {
      VolumeId: volume.id,
      State: volume.state,
      Tags: volume.tags,
      Attachments: volume.attachedTo ? [{ InstanceId: volume.attachedTo, State: 'attached' }] : [],
    };
  }
}

function setup(credentialSource?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const aws = new FakeAws();
  const client = createAwsSdkWorkspaceHostClient({
    connection: connection(credentialSource),
    createClients: aws.createClients,
    waiter: { maxWaitTimeSec: 0.05, minDelaySec: 0.001, maxDelaySec: 0.002 },
    now: () => NOW,
    ...extra,
  });
  return { aws, client, provider: createAwsWorkspaceHostProvider({ client, now: () => NOW }) };
}

function resourceOf(result: WorkspaceHostApplyResult): WorkspaceHostResourceRef | undefined {
  return 'resource' in result ? result.resource : undefined;
}

async function provision(provider: ReturnType<typeof setup>['provider'], idempotencyKey = 'idem-1', operationId = 'op-1') {
  const plan = await provider.plan({ action: 'provision', operationId, idempotencyKey, desired: desired() }, ctx());
  const resources: WorkspaceHostResourceRef[] = [];
  for (const step of plan.steps) {
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
      ctx(),
    );
    expect(result.state).toBe('applied');
    const created = resourceOf(result);
    if (created) resources.push(created);
  }
  return resources;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createAwsSdkCredentialProvider — every credential source in aws-connection.ts', () => {
  it('maps local default chain and shared (SSO / console-login) profiles to the SDK v3 providers', () => {
    createAwsSdkCredentialProvider(planAwsSdkCredentialProvider({ environment: 'local', method: 'default-chain' }), REGION);
    createAwsSdkCredentialProvider(
      planAwsSdkCredentialProvider({ environment: 'local', method: 'shared-profile', profile: 'papercusp-console' }),
      REGION,
    );
    expect(fromNodeProviderChain).toHaveBeenCalledWith({ clientConfig: { region: REGION } });
    expect(fromIni).toHaveBeenCalledWith({ profile: 'papercusp-console', clientConfig: { region: REGION } });
  });

  it('local assume-role resolves the ExternalId reference and assumes from the source profile', async () => {
    const resolveExternalId = vi.fn(async () => 'ext-local-1');
    const provider = createAwsSdkCredentialProvider(
      planAwsSdkCredentialProvider({
        environment: 'local',
        method: 'assume-role',
        roleArn: `arn:aws:iam::${ACCOUNT}:role/Workspace`,
        sourceProfile: 'base',
        externalIdRef: 'org:ext',
      }),
      REGION,
      { resolveExternalId },
    );
    await provider();
    expect(resolveExternalId).toHaveBeenCalledWith('org:ext');
    const call = vi.mocked(fromTemporaryCredentials).mock.calls[0]![0];
    expect(call.params).toEqual({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/Workspace`, RoleSessionName: 'papercusp-workspace-host', ExternalId: 'ext-local-1' });
    expect((call.masterCredentials as unknown as { kind: string }).kind).toBe('ini');
  });

  it('hosted customer-role chains control plane -> per-org role -> customer role with the org ExternalId (D-001)', async () => {
    const controlPlane = Object.assign(async () => ({ accessKeyId: 'cp', secretAccessKey: 'cp-secret' }), { kind: 'control-plane' });
    const provider = createAwsSdkCredentialProvider(
      planAwsSdkCredentialProvider({
        environment: 'hosted',
        method: 'customer-role',
        roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost`,
        trustedPrincipalArn: 'arn:aws:iam::111122223333:role/papercusp/orgs/org-42',
        externalIdRef: 'org-42',
      }),
      REGION,
      { resolveExternalId: async () => 'pc-org-42-ext', controlPlaneCredentials: controlPlane as never },
    );
    await provider();
    const [orgHop, customerHop] = vi.mocked(fromTemporaryCredentials).mock.calls.map((c) => c[0]);
    expect(orgHop!.params).toEqual({ RoleArn: 'arn:aws:iam::111122223333:role/papercusp/orgs/org-42', RoleSessionName: 'papercusp-org-role' });
    expect(orgHop!.masterCredentials).toBe(controlPlane);
    expect(customerHop!.params).toMatchObject({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost`, ExternalId: 'pc-org-42-ext' });
    expect((customerHop!.masterCredentials as unknown as { kind: string }).kind).toBe('temp');
  });

  it('hosted customer-role refuses to resolve without an ExternalId resolver', async () => {
    const provider = createAwsSdkCredentialProvider(
      planAwsSdkCredentialProvider({
        environment: 'hosted',
        method: 'customer-role',
        roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost`,
        trustedPrincipalArn: 'arn:aws:iam::111122223333:role/papercusp/orgs/org-42',
        externalIdRef: 'org-42',
      }),
      REGION,
      {},
    );
    await expect(provider()).rejects.toThrow('aws_workspace_host_external_id_resolver_required');
    expect(fromTemporaryCredentials).not.toHaveBeenCalled();
  });

  it('hosted OIDC mints a fresh web-identity token for each resolution', async () => {
    const mint = vi.fn(async () => 'jwt-token');
    const provider = createAwsSdkCredentialProvider(
      planAwsSdkCredentialProvider({
        environment: 'hosted',
        method: 'oidc',
        roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspOidc`,
        providerArn: `arn:aws:iam::${ACCOUNT}:oidc-provider/auth.papercusp.com`,
        issuer: 'https://auth.papercusp.com',
        audience: 'sts.amazonaws.com',
        subject: 'org:42',
      }),
      REGION,
      { getWebIdentityToken: mint },
    );
    await provider();
    await provider();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fromWebToken).mock.calls[0]![0]).toMatchObject({
      roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspOidc`,
      webIdentityToken: 'jwt-token',
    });
  });
});

describe('AwsSdkWorkspaceHostClient through AwsWorkspaceHostProvider', () => {
  it('AWSP-P-002-run-instances: a create launches exactly one instance via RunInstances in the connection region and account', async () => {
    const { aws, provider } = setup();
    const resources = await provision(provider);

    const runs = aws.commands('RunInstancesCommand');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.region).toBe(REGION);
    expect(runs[0]!.input).toMatchObject({ MinCount: 1, MaxCount: 1, LaunchTemplate: { LaunchTemplateId: 'lt-1' } });
    expect(new Set(aws.regionsBuilt)).toEqual(new Set([REGION]));
    // The account guard ran before the first mutation.
    const firstMutation = aws.sent.findIndex((s) => s.command === 'CreateVolumeCommand');
    expect(aws.sent.findIndex((s) => s.command === 'GetCallerIdentityCommand')).toBeLessThan(firstMutation);
    expect(resources.map((r) => r.kind).sort()).toEqual(['disk', 'vm']);
    expect(aws.commands('AttachVolumeCommand')[0]!.input).toMatchObject({ Device: '/dev/sdf' });
  });

  it('refuses every mutation when the credentials resolve to a different account', async () => {
    const { aws, client } = setup();
    aws.account = '999999999999';
    await expect(
      client.createVolume({
        AvailabilityZone: 'us-east-2a',
        ClientToken: 't',
        Encrypted: true,
        KmsKeyId: 'k',
        Size: 1,
        VolumeType: 'gp3',
        TagSpecifications: [{ ResourceType: 'volume', Tags: [] }],
      }),
    ).rejects.toThrow('aws_workspace_host_account_mismatch');
    expect(aws.commands('CreateVolumeCommand')).toHaveLength(0);
  });

  it('AWSP-P-002-client-token: retries with one idempotency key send one EC2 client token and reuse the resources', async () => {
    const { aws, provider } = setup();
    // Attempt 1 creates the volume and instance, then dies before the attach step.
    const firstPlan = await provider.plan(
      { action: 'provision', operationId: 'op-a', idempotencyKey: 'idem-shared', desired: desired() },
      ctx(),
    );
    const first: WorkspaceHostResourceRef[] = [];
    for (const step of firstPlan.steps.slice(0, 2)) {
      const result = await provider.apply(
        { planId: firstPlan.planId, operationId: firstPlan.operationId, step, knownResources: [...first] },
        ctx(),
      );
      first.push(resourceOf(result)!);
    }
    // Attempt 2 is a fresh operation carrying the SAME idempotency key.
    const retried = await provision(provider, 'idem-shared', 'op-b');

    const volumeTokens = aws.commands('CreateVolumeCommand').map((s) => s.input.ClientToken);
    const instanceTokens = aws.commands('RunInstancesCommand').map((s) => s.input.ClientToken);
    expect(volumeTokens).toHaveLength(2);
    expect(new Set(volumeTokens).size).toBe(1);
    expect(new Set(instanceTokens).size).toBe(1);
    expect(volumeTokens[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(retried).toEqual(first);
    // EBS has no client-token filter, so the token rides as a tag the find path can query.
    expect(aws.commands('CreateVolumeCommand')[0]!.input.TagSpecifications[0].Tags).toContainEqual({
      Key: AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG,
      Value: volumeTokens[0],
    });
  });

  it('AWSP-P-003-aws-inventory: an interrupted provision that already launched its instance recovers it from the EC2 inventory and launches nothing new', async () => {
    const { aws, provider } = setup();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-recover', idempotencyKey: 'idem-recover', desired: desired() },
      ctx(),
    );
    const volume = resourceOf(
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] },
        ctx(),
      ),
    )!;
    const runStep = plan.steps[1]!;
    // EC2 accepted RunInstances, then the controller died before the instance id was recorded.
    const lost = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: runStep, knownResources: [volume] },
      ctx(),
    );
    const launched = resourceOf(lost)!;
    expect(aws.commands('RunInstancesCommand')).toHaveLength(1);

    const recovered = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: runStep,
        knownResources: [volume],
        reason: 'ambiguous-timeout',
        previousProviderRequestId: lost.providerRequestId,
      },
      ctx(),
    );

    const run = aws.commands('RunInstancesCommand');
    expect(run).toHaveLength(1);
    expect(aws.commands('DescribeInstancesCommand').map((sent) => sent.input)).toContainEqual({
      Filters: [{ Name: 'client-token', Values: [run[0]!.input.ClientToken] }],
    });
    expect('resource' in recovered ? recovered.resource?.providerId : undefined).toBe(launched.providerId);
    // The recovered instance carries this workspace's managed tags, which the destroy census inventories by.
    expect(run[0]!.input.TagSpecifications[0].Tags).toContainEqual(expect.objectContaining({ Value: 'ws-1' }));
  });

  it('AWSP-P-005-ssm-reach: the RunInstances EC2 receives asks for no public IP and carries the SSM instance profile', async () => {
    const { aws, provider } = setup();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-ssm', idempotencyKey: 'idem-ssm', desired: desired() },
      ctx(),
    );
    const volume = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] },
      ctx(),
    );
    await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1]!, knownResources: [resourceOf(volume)!] },
      ctx(),
    );
    const [run] = aws.commands('RunInstancesCommand');
    expect(run!.input.NetworkInterfaces).toHaveLength(1);
    expect(run!.input.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
    expect(run!.input.IamInstanceProfile.Arn).toMatch(/:instance-profile\//);
    // The ingress check read exactly the launch groups, before the launch.
    const [described] = aws.commands('DescribeSecurityGroupsCommand');
    expect(described!.input.GroupIds).toEqual(run!.input.NetworkInterfaces[0].Groups);
  });

  it('AWSP-P-005-no-inbound: a launch group with any EC2 ingress permission refuses before RunInstances', async () => {
    const { aws, provider } = setup();
    aws.overrides.set('ec2:DescribeSecurityGroupsCommand', (input) => ({
      SecurityGroups: (input.GroupIds as string[]).map((GroupId, index) => ({
        GroupId,
        IpPermissions: index === 0 ? [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] : [],
      })),
    }));
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-open', idempotencyKey: 'idem-open', desired: desired() },
      ctx(),
    );
    const volume = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] },
      ctx(),
    );
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: plan.steps[1]!, knownResources: [resourceOf(volume)!] },
        ctx(),
      ),
    ).rejects.toThrow('aws_workspace_host_security_group_has_ingress');
    expect(aws.commands('RunInstancesCommand')).toHaveLength(0);
  });

  it('getConsoleOutput decodes the base64 serial console and reports no output as undefined', async () => {
    const { aws, client } = setup();
    aws.overrides.set('ec2:GetConsoleOutputCommand', (input) =>
      input.InstanceId === 'i-0123456789abcdef0'
        ? { Output: Buffer.from('-----BEGIN SSH HOST KEY KEYS-----\n').toString('base64') }
        : {},
    );
    await expect(client.getConsoleOutput('i-0123456789abcdef0')).resolves.toBe('-----BEGIN SSH HOST KEY KEYS-----\n');
    await expect(client.getConsoleOutput('i-0fedcba9876543210')).resolves.toBeUndefined();
    expect(aws.commands('GetConsoleOutputCommand')[0]!.input).toEqual({ InstanceId: 'i-0123456789abcdef0', Latest: true });
  });

  it('AWSP-P-002-no-secret-leak: provider errors never carry the secret key or session token', async () => {
    const { aws, provider } = setup();
    aws.overrides.set('ec2:RunInstancesCommand', () => {
      throw awsError('UnauthorizedOperation', `denied for key ${SECRET} token=${TOKEN}`, {
        cause: new Error(`inner ${TOKEN}`),
        $response: { headers: { 'x-amz-security-token': TOKEN } },
        $metadata: { httpStatusCode: 403, requestId: 'req-denied' },
      });
    });
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-leak', idempotencyKey: 'idem-leak', desired: desired() },
      ctx(),
    );
    const volume = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] },
      ctx(),
    );
    const error = await provider
      .apply({ planId: plan.planId, operationId: plan.operationId, step: plan.steps[1]!, knownResources: [resourceOf(volume)!] }, ctx())
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(AwsWorkspaceHostSdkError);
    const sdkError = error as AwsWorkspaceHostSdkError;
    expect(sdkError.code).toBe('UnauthorizedOperation');
    expect(sdkError.accessDenied).toBe(true);
    expect(sdkError.requestId).toBe('req-denied');
    expect(sdkError.cause).toBeUndefined();
    const everything = [sdkError.message, sdkError.stack ?? '', JSON.stringify(sdkError), JSON.stringify(Object.entries(sdkError))].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(TOKEN);
    expect(sdkError.message).toContain('[redacted]');
  });

  it('validateConnection reports a transport failure as retryable without leaking the credential', async () => {
    const { aws, client } = setup();
    aws.overrides.set('sts:GetCallerIdentityCommand', () => {
      throw awsError('ThrottlingException', `slow down ${SECRET}`, { $metadata: { httpStatusCode: 429 } });
    });
    const result = await client.validateConnection(connection());
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(result.errors.join('\n')).not.toContain(SECRET);
  });
});

describe('seam methods send the expected SDK command and input (AUTO-BAR-R-2-P-002)', () => {
  it('discovery: identity, scopes, regions with zones, paginated sizes, release images, price list', async () => {
    const { aws, client } = setup();
    const query = { scope: { kind: 'account', id: ACCOUNT }, region: REGION };

    expect(await client.validateConnection(connection())).toMatchObject({ ok: true, identity: expect.stringContaining(ACCOUNT) });
    expect(await client.listScopes(connection())).toEqual([{ kind: 'account', id: ACCOUNT, label: `AWS account ${ACCOUNT}` }]);

    const regions = await client.listRegions(query, connection());
    expect(aws.commands('DescribeRegionsCommand')[0]!.input).toEqual({ AllRegions: true });
    expect(regions).toEqual([
      { id: 'af-south-1', label: 'af-south-1', available: false, constraints: ['Region requires account opt-in'] },
      { id: 'us-east-2', label: 'us-east-2', available: true, zones: ['us-east-2a', 'us-east-2b'] },
    ]);

    const sizes = await client.listSizes({ ...query, architecture: 'arm64' }, connection());
    const typeCalls = aws.commands('DescribeInstanceTypesCommand');
    expect(typeCalls.map((c) => c.input.NextToken)).toEqual([undefined, 'page-2']);
    expect(typeCalls[0]!.input.Filters).toContainEqual({ Name: 'processor-info.supported-architecture', Values: ['arm64'] });
    expect(sizes.map((s) => s.id)).toEqual(['m7g.large', 'm7i.xlarge']);

    const images = await client.listImages(query, connection());
    const imageCalls = aws.commands('DescribeImagesCommand');
    // The bound account IS the default publisher, so its releases arrive through the owned query
    // and no second (publisher) query is sent.
    expect(imageCalls.map((c) => c.input.Owners)).toEqual([['self']]);
    expect(images).toEqual([
      {
        id: 'ami-0abc',
        version: '2026.10.01',
        label: 'papercusp-workspace-host-2026.10.01',
        architecture: 'x86_64',
        signed: true,
        publishedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const price = await client.estimatePrice(desired(), connection());
    const priceCalls = aws.commands('GetProductsCommand');
    expect(priceCalls.map((c) => c.region)).toEqual(['us-east-1', 'us-east-1']);
    expect(priceCalls[0]!.input.Filters).toContainEqual({ Type: 'TERM_MATCH', Field: 'regionCode', Value: REGION });
    expect(price.confidence).toBe('estimated');
    expect(price.hourlyAmount).toBeCloseTo(0.1008 + (0.08 * 140) / 730, 6);
  });

  it('lists shared release AMIs by publisher, release name and Description provenance — never by tag', async () => {
    const PUBLISHER = '210987654321';
    const SHA = 'b'.repeat(64);
    const { aws, client } = setup(undefined, { imagePublisherAccountIds: [PUBLISHER] });
    aws.overrides.set('ec2:DescribeImagesCommand', (input) =>
      input.Owners?.[0] === 'self'
        ? { Images: [] }
        : {
            Images: [
              {
                ImageId: 'ami-0rel',
                OwnerId: PUBLISHER,
                Name: 'papercusp-workspace-host-0.0.21',
                Description: `papercusp-workspace-host 0.0.21 release-sha256:${SHA}`,
                Architecture: 'x86_64',
                CreationDate: '2026-10-02T00:00:00.000Z',
              },
              // Imitates a release perfectly but another account owns it. The fake ignores Owners,
              // so this proves the client re-checks the owner itself.
              {
                ImageId: 'ami-0imitation',
                OwnerId: '999988887777',
                Name: 'papercusp-workspace-host-0.0.22',
                Description: `papercusp-workspace-host 0.0.22 release-sha256:${SHA}`,
                Architecture: 'x86_64',
                CreationDate: '2026-10-03T00:00:00.000Z',
              },
              // Publisher-owned, but its Name and Description disagree on the version.
              {
                ImageId: 'ami-0mismatch',
                OwnerId: PUBLISHER,
                Name: 'papercusp-workspace-host-0.0.20',
                Description: `papercusp-workspace-host 0.0.19 release-sha256:${SHA}`,
              },
              // Publisher-owned staging candidate with no release provenance.
              { ImageId: 'ami-0staging', OwnerId: PUBLISHER, Name: 'papercusp-workspace-host-0.0.21-staging' },
            ],
          },
    );
    const images = await client.listImages(
      { scope: { kind: 'account', id: ACCOUNT }, region: REGION, architecture: 'x86_64' },
      connection(),
    );
    const calls = aws.commands('DescribeImagesCommand').map((c) => c.input);
    const architecture = { Name: 'architecture', Values: ['x86_64'] };
    const available = { Name: 'state', Values: ['available'] };
    expect(calls.find((input) => input.Owners?.[0] === 'self')).toEqual({
      Owners: ['self'],
      Filters: [available, { Name: 'tag:papercusp:managed', Values: ['true'] }, architecture],
    });
    const publisherQuery = calls.find((input) => input.Owners?.[0] === PUBLISHER);
    expect(publisherQuery).toEqual({
      Owners: [PUBLISHER],
      Filters: [available, { Name: 'name', Values: ['papercusp-workspace-host-*'] }, architecture],
    });
    // Tags never cross accounts, so any tag filter here would hide every shared release.
    expect(JSON.stringify(publisherQuery)).not.toContain('tag:');
    expect(images).toEqual([
      {
        id: 'ami-0rel',
        version: '0.0.21',
        label: 'papercusp-workspace-host-0.0.21',
        architecture: 'x86_64',
        signed: true,
        publishedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
  });

  it('instance lifecycle: describe enriches status + SSM; start/stop/reboot/terminate/repair send their commands', async () => {
    const { aws, client } = setup();
    const { instanceId } = await client.runInstances({
      ClientToken: 'tok',
      ImageId: 'ami-0abc',
      InstanceType: 'm7i.large',
      MinCount: 1,
      MaxCount: 1,
      LaunchTemplate: { LaunchTemplateId: 'lt-1' },
      NetworkInterfaces: [
        { DeviceIndex: 0, SubnetId: 'subnet-1', Groups: ['sg-1'], DeleteOnTermination: true, AssociatePublicIpAddress: false },
      ],
      IamInstanceProfile: { Arn: 'arn:aws:iam::1:instance-profile/p' },
      BlockDeviceMappings: [
        { DeviceName: '/dev/sda1', Ebs: { DeleteOnTermination: true, Encrypted: true, KmsKeyId: 'k', VolumeSize: 20, VolumeType: 'gp3' } },
      ],
      TagSpecifications: [
        { ResourceType: 'instance', Tags: [] },
        { ResourceType: 'volume', Tags: [] },
      ],
    });

    expect(await client.findInstanceByClientToken('tok')).toMatchObject({ instanceId });
    expect(aws.commands('DescribeInstancesCommand').at(-1)!.input).toEqual({ Filters: [{ Name: 'client-token', Values: ['tok'] }] });
    expect(await client.describeInstance(instanceId)).toEqual({
      instanceId,
      state: 'running',
      imageId: 'ami-0abc',
      attachedVolumeIds: ['vol-root'],
      instanceStatus: 'ok',
      systemStatus: 'initializing',
      ssmOnline: true,
      observedAt: NOW,
    });
    expect(await client.describeInstance('i-missing')).toBeUndefined();

    await client.stopInstances([instanceId]);
    await client.startInstances([instanceId]);
    await client.rebootInstances([instanceId]);
    expect(aws.commands('StopInstancesCommand')[0]!.input).toEqual({ InstanceIds: [instanceId] });
    expect(aws.commands('StartInstancesCommand')[0]!.input).toEqual({ InstanceIds: [instanceId] });
    expect(aws.commands('RebootInstancesCommand')[0]!.input).toEqual({ InstanceIds: [instanceId] });

    const before = aws.sent.length;
    await client.repairInstance(instanceId);
    const repairSeq = aws.sent.slice(before).map((s) => s.command).filter((c) => /Instances?Command$/.test(c) && !/Describe/.test(c));
    expect(repairSeq).toEqual(['StopInstancesCommand', 'StartInstancesCommand']);

    await client.terminateInstances([instanceId]);
    expect(await client.waitForInstanceState(instanceId, 'terminated')).toMatchObject({ state: 'terminated' });
  });

  it('spot (WI-10005389): sends the market options, observes the spot request, and cancels it idempotently', async () => {
    const { aws, client } = setup();
    const { instanceId } = await client.runInstances({
      ClientToken: 'spot-tok',
      ImageId: 'ami-0abc',
      InstanceType: 'm7i.large',
      MinCount: 1,
      MaxCount: 1,
      LaunchTemplate: { LaunchTemplateId: 'lt-1' },
      NetworkInterfaces: [
        { DeviceIndex: 0, SubnetId: 'subnet-1', Groups: ['sg-1'], DeleteOnTermination: true, AssociatePublicIpAddress: false },
      ],
      IamInstanceProfile: { Arn: 'arn:aws:iam::1:instance-profile/p' },
      BlockDeviceMappings: [
        { DeviceName: '/dev/sda1', Ebs: { DeleteOnTermination: true, Encrypted: true, KmsKeyId: 'k', VolumeSize: 20, VolumeType: 'gp3' } },
      ],
      InstanceMarketOptions: AWS_SPOT_MARKET_OPTIONS,
      TagSpecifications: [
        { ResourceType: 'instance', Tags: [] },
        { ResourceType: 'volume', Tags: [] },
        { ResourceType: 'spot-instances-request', Tags: [] },
      ],
    });
    const [run] = aws.commands('RunInstancesCommand');
    expect(run!.input.InstanceMarketOptions).toEqual({
      MarketType: 'spot',
      SpotOptions: { SpotInstanceType: 'persistent', InstanceInterruptionBehavior: 'stop' },
    });
    expect(run!.input.TagSpecifications.map((spec: { ResourceType: string }) => spec.ResourceType)).toEqual([
      'instance',
      'volume',
      'spot-instances-request',
    ]);
    const observed = await client.describeInstance(instanceId);
    expect(observed?.spotInstanceRequestId).toBe(`sir-${instanceId}`);

    await client.cancelSpotInstanceRequests([`sir-${instanceId}`]);
    expect(aws.commands('CancelSpotInstanceRequestsCommand')[0]!.input).toEqual({
      SpotInstanceRequestIds: [`sir-${instanceId}`],
    });
    // A request EC2 no longer knows cannot relaunch anything: counted as cancelled, not an error.
    await expect(client.cancelSpotInstanceRequests(['sir-unknown'])).resolves.toEqual({});
    // Nothing to cancel sends nothing.
    await client.cancelSpotInstanceRequests([]);
    expect(aws.commands('CancelSpotInstanceRequestsCommand')).toHaveLength(2);
  });

  it('passes VolumeInitializationRate through to RunInstances and CreateVolume, and sends none when absent (WI-10006140)', async () => {
    const { aws, client } = setup();
    const launch = (token: string, ebs: Record<string, unknown>) =>
      client.runInstances({
        ClientToken: token,
        ImageId: 'ami-0abc',
        InstanceType: 'm7i.large',
        MinCount: 1,
        MaxCount: 1,
        LaunchTemplate: { LaunchTemplateId: 'lt-1' },
        NetworkInterfaces: [
          { DeviceIndex: 0, SubnetId: 'subnet-1', Groups: ['sg-1'], DeleteOnTermination: true, AssociatePublicIpAddress: false },
        ],
        IamInstanceProfile: { Arn: 'arn:aws:iam::1:instance-profile/p' },
        BlockDeviceMappings: [
          {
            DeviceName: '/dev/sda1',
            Ebs: { DeleteOnTermination: true, Encrypted: true, KmsKeyId: 'k', VolumeSize: 20, VolumeType: 'gp3', ...ebs },
          },
        ],
        TagSpecifications: [
          { ResourceType: 'instance', Tags: [] },
          { ResourceType: 'volume', Tags: [] },
        ],
      });
    await launch('tok-rate', { VolumeInitializationRate: 300 });
    await launch('tok-norate', {});
    const [withRate, withoutRate] = aws.commands('RunInstancesCommand');
    // The SDK mapping copies EBS fields one by one; a field it forgets is silently never sent.
    expect(withRate!.input.BlockDeviceMappings[0].Ebs.VolumeInitializationRate).toBe(300);
    expect(withoutRate!.input.BlockDeviceMappings[0].Ebs).not.toHaveProperty('VolumeInitializationRate');

    const volume = (token: string, extra: Record<string, unknown>) =>
      client.createVolume({
        AvailabilityZone: 'us-east-2a',
        ClientToken: token,
        Encrypted: true,
        KmsKeyId: 'k',
        Size: 10,
        VolumeType: 'gp3',
        ...extra,
        TagSpecifications: [{ ResourceType: 'volume', Tags: [] }],
      });
    await volume('vol-restore', { SnapshotId: 'snap-1', VolumeInitializationRate: 250 });
    await volume('vol-new', {});
    const [restored, fresh] = aws.commands('CreateVolumeCommand');
    expect(restored!.input).toMatchObject({ SnapshotId: 'snap-1', VolumeInitializationRate: 250 });
    expect(fresh!.input).not.toHaveProperty('VolumeInitializationRate');
    expect(fresh!.input).not.toHaveProperty('SnapshotId');
  });

  it('retains every active EBS attachment, zone, encryption and tenant tags for writer fencing', async () => {
    const { aws, client } = setup();
    aws.overrides.set('ec2:DescribeVolumesCommand', () => ({ Volumes: [{
      VolumeId: 'vol-1', State: 'in-use', AvailabilityZone: 'us-east-2a', Encrypted: true, MultiAttachEnabled: true,
      Tags: [{ Key: 'papercusp:host-id', Value: 'host-1' }],
      Attachments: [{ InstanceId: 'i-owner', State: 'attached' }, { InstanceId: 'i-foreign', State: 'detaching' }],
    }] }));
    await expect(client.describeVolume('vol-1')).resolves.toMatchObject({
      availabilityZone: 'us-east-2a', encrypted: true, multiAttachEnabled: true,
      attachedInstanceId: 'i-owner', attachedInstanceIds: ['i-owner', 'i-foreign'],
      tags: { 'papercusp:host-id': 'host-1' },
    });
  });

  it('volumes and snapshots: find by token tag, wait, attach, delete, idempotent snapshot', async () => {
    const { aws, client } = setup();
    const { volumeId } = await client.createVolume({
      AvailabilityZone: 'us-east-2a',
      ClientToken: 'vol-token',
      Encrypted: true,
      KmsKeyId: 'k',
      Size: 10,
      VolumeType: 'gp3',
      TagSpecifications: [{ ResourceType: 'volume', Tags: [{ Key: 'papercusp:managed', Value: 'true' }] }],
    });
    expect(aws.commands('CreateVolumeCommand')).toHaveLength(1);
    expect(aws.commands('CreateVolumeCommand').at(-1)!.input).toMatchObject({
      AvailabilityZone: 'us-east-2a',
      ClientToken: 'vol-token',
      Encrypted: true,
      KmsKeyId: 'k',
      Size: 10,
      VolumeType: 'gp3',
    });
    expect(await client.findVolumeByClientToken('vol-token')).toMatchObject({ volumeId, state: 'available' });
    expect(aws.commands('DescribeVolumesCommand').at(-1)!.input).toEqual({
      Filters: [{ Name: `tag:${AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG}`, Values: ['vol-token'] }],
    });
    expect(await client.waitForVolumeState(volumeId, 'available')).toMatchObject({ state: 'available' });
    await client.attachVolume({ InstanceId: 'i-1', VolumeId: volumeId, Device: '/dev/sdf' });
    expect(await client.describeVolume(volumeId)).toMatchObject({ state: 'in-use', attachedInstanceId: 'i-1' });

    const snapshotInput = {
      ClientToken: 'snap-token',
      VolumeId: volumeId,
      Description: 'd',
      TagSpecifications: [{ ResourceType: 'snapshot' as const, Tags: [] }] as const,
    };
    const first = await client.createSnapshot(snapshotInput);
    const again = await client.createSnapshot(snapshotInput);
    expect(again.snapshotId).toBe(first.snapshotId);
    expect(aws.commands('CreateSnapshotCommand')).toHaveLength(1);
    expect(await client.waitForSnapshotCompleted(first.snapshotId)).toMatchObject({ state: 'completed' });

    await client.deleteVolume(volumeId);
    expect(await client.describeVolume(volumeId)).toBeUndefined();
    await expect(client.deleteVolume(volumeId)).resolves.toEqual({});
  });
});

describe('waits and enrichment honour their contracts', () => {
  it('an aborted wait throws AbortError without polling', async () => {
    const { aws, client } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.waitForInstanceState('i-1', 'running', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(aws.commands('DescribeInstancesCommand')).toHaveLength(0);
  });

  it('a waiter timeout falls through to a fresh read so the provider reports in-progress', async () => {
    const { aws, client } = setup();
    aws.instances.set('i-slow', { id: 'i-slow', token: 'slow' });
    aws.instanceState = 'pending';
    const observed = await client.waitForInstanceState('i-slow', 'running');
    expect(observed).toMatchObject({ instanceId: 'i-slow', state: 'pending' });
    expect(aws.commands('DescribeInstancesCommand').length).toBeGreaterThan(1);
  });

  it('a launch EC2 terminated reports its StateReason, scrubbed of credential material (WI-10005332)', async () => {
    const { aws, client } = setup();
    aws.instances.set('i-dead', { id: 'i-dead', token: 'dead' });
    aws.instanceState = 'terminated';
    aws.instanceStateReason = {
      Code: 'Client.InvalidKMSKey.InvalidState',
      Message: `Client.InvalidKMSKey.InvalidState: key unusable for session ${TOKEN}`,
    };
    const observed = await client.describeInstance('i-dead');
    expect(observed).toMatchObject({
      instanceId: 'i-dead',
      state: 'terminated',
      stateReason: { code: 'Client.InvalidKMSKey.InvalidState' },
    });
    expect(observed?.stateReason?.message).toContain('key unusable');
    expect(observed?.stateReason?.message).toContain('[redacted]');
    expect(JSON.stringify(observed)).not.toContain(TOKEN);
  });

  it('a healthy instance carries no StateReason', async () => {
    const { aws, client } = setup();
    aws.instances.set('i-ok', { id: 'i-ok', token: 'ok' });
    const observed = await client.describeInstance('i-ok');
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('stateReason');
  });

  it('SSM access denied leaves ssmOnline unmeasured instead of false', async () => {
    const { aws, client } = setup();
    aws.instances.set('i-1', { id: 'i-1', token: 't' });
    aws.ssmDenied = true;
    const observed = await client.describeInstance('i-1');
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('ssmOnline');
  });
});

describe('host bootstrap push through the SDK-backed client (aws-byoc-gcp-parity D-013)', () => {
  it('a provision pushes the bootstrap to the launched instance with AWS-RunShellScript, once SSM is Online and the volume is attached', async () => {
    const { aws, provider } = setup();
    const resources = await provision(provider);
    const instanceId = resources.find((r) => r.kind === 'vm')!.providerId;
    const volumeId = resources.find((r) => r.kind === 'disk')!.providerId;

    const sends = aws.commands('SendCommandCommand');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.region).toBe(REGION);
    expect(sends[0]!.input).toEqual({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Comment: 'Papercusp host bootstrap host-aws-sdk-1',
      Parameters: {
        commands: [...renderAwsHostBootstrapPush({ volumeId, hostBootstrapScript: HOST_BOOTSTRAP }).commands],
        executionTimeout: [String(AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC)],
      },
    });

    const sendAt = aws.sent.findIndex((s) => s.command === 'SendCommandCommand');
    const before = aws.sent.slice(0, sendAt);
    expect(before.some((s) => s.command === 'AttachVolumeCommand')).toBe(true);
    expect(
      before.some(
        (s) => s.command === 'DescribeInstanceInformationCommand' && s.input.Filters?.[0]?.Values?.[0] === instanceId,
      ),
    ).toBe(true);
    const invocations = aws.commands('GetCommandInvocationCommand');
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.at(-1)!.input).toEqual({ CommandId: expect.stringMatching(/^command-/), InstanceId: instanceId });
  });

  it('a Failed invocation surfaces status, exit code and stderr, and fails the provision', async () => {
    const { aws, client, provider } = setup();
    aws.commandInvocation = { Status: 'Failed', ResponseCode: 2, StandardErrorContent: 'sha256sum: WARNING: 1 computed checksum did NOT match' };
    await expect(client.waitForCommandInvocation('command-x', 'i-1')).resolves.toEqual({
      status: 'Failed',
      responseCode: 2,
      stderr: 'sha256sum: WARNING: 1 computed checksum did NOT match',
    });
    await expect(provision(provider)).rejects.toThrow(
      'aws_workspace_host_bootstrap_push_failed: Failed exit=2: sha256sum: WARNING: 1 computed checksum did NOT match',
    );
  });

  it('waitForSsmOnline polls within its budget and reports false when the agent never comes Online', async () => {
    const { aws, client } = setup();
    aws.ssmPingStatus = 'ConnectionLost';
    await expect(client.waitForSsmOnline('i-1')).resolves.toBe(false);
    expect(aws.commands('DescribeInstanceInformationCommand').length).toBeGreaterThan(1);
    aws.ssmPingStatus = 'Online';
    await expect(client.waitForSsmOnline('i-1')).resolves.toBe(true);
  });

  it('sendShellCommand clips the comment to the 100-character SSM limit and refuses a foreign account before sending', async () => {
    const { aws, client } = setup();
    const input = { instanceId: 'i-1', commands: ['true'], comment: 'x'.repeat(140), executionTimeoutSec: 60 };
    await client.sendShellCommand(input);
    expect(aws.commands('SendCommandCommand')[0]!.input.Comment).toHaveLength(100);

    const foreign = setup();
    foreign.aws.account = '999999999999';
    await expect(foreign.client.sendShellCommand(input)).rejects.toThrow();
    expect(foreign.aws.commands('SendCommandCommand')).toHaveLength(0);
  });
});

describe('SDK-backed preflight client', () => {
  it('simulates the resolved role (path recovered via GetRole) and passes the full onboarding preflight', async () => {
    const { aws, client } = setup();
    aws.overrides.set('iam:GetRoleCommand', () => ({ Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/PapercuspByoc` } }));
    aws.overrides.set('iam:SimulatePrincipalPolicyCommand', (input) => ({
      EvaluationResults: input.ActionNames.map((action: string) => ({ EvalActionName: action, EvalDecision: 'allowed' })),
    }));
    aws.overrides.set('ec2:DescribeSubnetsCommand', () => ({
      Subnets: [{ SubnetId: 'subnet-1', AvailabilityZone: 'us-east-2a', VpcId: 'vpc-1', State: 'available' }],
    }));
    aws.overrides.set('kms:DescribeKeyCommand', () => ({
      KeyMetadata: { Arn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/k-1`, Enabled: true, KeyState: 'Enabled', KeySpec: 'SYMMETRIC_DEFAULT' },
    }));
    aws.overrides.set('servicequotas:GetServiceQuotaCommand', () => {
      throw awsError('NoSuchResourceException', 'no applied quota');
    });
    aws.overrides.set('servicequotas:GetAWSDefaultServiceQuotaCommand', () => ({ Quota: { Value: 32 } }));

    const report = await preflightAwsWorkspaceHostConnection(
      {
        cloudCredentialRef: { kind: 'cloud', ref: 'aws-local:papercusp-byoc' },
        credentialSource: { environment: 'local', method: 'shared-profile', profile: 'papercusp-byoc' },
        selection: {
          accountId: ACCOUNT,
          partition: 'aws',
          region: REGION,
          subnetId: 'subnet-1',
          imageId: 'ami-0abc',
          kmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/k-1`,
          instanceProfileArn: `arn:aws:iam::${ACCOUNT}:instance-profile/PapercuspWorkspace`,
          architecture: 'x86_64',
          quotas: [{ serviceCode: 'ec2', quotaCode: 'L-1216C47A', minimumValue: 8, label: 'On-demand standard vCPUs' }],
        },
        now: () => NOW,
      },
      client.preflight(),
    );

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(aws.commands('SimulatePrincipalPolicyCommand')[0]!.input.PolicySourceArn).toBe(
      `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/PapercuspByoc`,
    );
    // WI-10006815: the AMI-key grant holds only through EC2, so it is simulated the way EBS calls it,
    // separately from the unconditional lifecycle list.
    const simulations = aws.commands('SimulatePrincipalPolicyCommand').map((command) => command.input);
    expect(simulations).toHaveLength(2);
    expect(simulations[0]!.ContextEntries).toBeUndefined();
    expect(simulations[1]).toMatchObject({
      PolicySourceArn: `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/PapercuspByoc`,
      ActionNames: ['kms:Decrypt', 'kms:ReEncryptFrom'],
      ContextEntries: [{ ContextKeyName: 'kms:ViaService', ContextKeyValues: [`ec2.${REGION}.amazonaws.com`], ContextKeyType: 'string' }],
    });
    expect(report.permissions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['kms:Decrypt', 'kms:ReEncryptFrom']),
    );
    expect(report.quotas[0]).toMatchObject({ value: 32 });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

describe('AWS SDK errors feed the shared retry classifier (WI-10006801)', () => {
  async function classify(name: string, httpStatusCode: number | undefined) {
    const { aws, client } = setup();
    aws.overrides.set('ec2:DescribeImagesCommand', () => {
      throw awsError(name, `${name} from EC2`, {
        // awsError defaults to HTTP 400; a lost response carries no status at all.
        $metadata: httpStatusCode === undefined ? {} : { httpStatusCode, requestId: `req-${name}` },
      });
    });
    const error = await client.describeImageRootDeviceName('ami-0abc').then(
      () => {
        throw new Error('expected the AWS call to fail');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AwsWorkspaceHostSdkError);
    return workspaceHostProviderRetryClass(error);
  }

  it.each([
    // The canary's 1,461-attempt loop: a deterministic 400 must stop, not reconcile forever.
    ['InvalidParameterCombination', 400, 'terminal'],
    ['UnauthorizedOperation', 403, 'terminal'],
    // Throttles outrank the status, including STS/IAM's HTTP-400 throttles.
    ['RequestLimitExceeded', 503, 'throttled'],
    ['Throttling', 400, 'throttled'],
    // State-dependent 4xx: the same request can succeed on a later pass.
    ['InvalidInstanceID.NotFound', 400, 'ambiguous'],
    ['IncorrectInstanceState', 400, 'ambiguous'],
    ['DependencyViolation', 400, 'ambiguous'],
    ['VolumeInUse', 400, 'ambiguous'],
    // A server-side fault or a lost response stays ambiguous.
    ['InsufficientInstanceCapacity', 500, 'ambiguous'],
    ['InternalError', undefined, 'ambiguous'],
  ] as const)('%s (HTTP %s) classifies %s', async (name, status, expected) => {
    expect(await classify(name, status)).toBe(expected);
  });

  it("reads the AMI's RootDeviceName, and reports an image this account cannot see as undefined", async () => {
    const { aws, client } = setup();
    expect(await client.describeImageRootDeviceName('ami-0abc')).toBe('/dev/xvda');
    aws.overrides.set('ec2:DescribeImagesCommand', () => {
      throw awsError('InvalidAMIID.NotFound', 'gone', { $metadata: { httpStatusCode: 400 } });
    });
    expect(await client.describeImageRootDeviceName('ami-0gone')).toBeUndefined();
  });
});

/**
 * aws-byoc-gcp-parity-2026-10-01 P-003: the production composition of the AWS workspace-host
 * provider. Pins (1) the fail-closed composition rules, (2) that the 'aws' registry factory
 * resolves a real `AwsWorkspaceHostProvider` for a persisted AWS connection, and (3) that the
 * teardown-obligation observers survive composition all the way through the real SDK v3 client
 * (over a structural EC2 fake), so a created EBS volume opens an obligation addressed to the
 * connection's account + region.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWorkspaceHostProvidersForTests,
  registerWorkspaceHostProviderFactory,
  resolveWorkspaceHostProvider,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostProviderContext,
} from '@papercusp/deployment-driver';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfiguredAwsWorkspaceHostProvider } from './aws-configured-provider';
import { registerWorkspaceHostProviderFactories } from './provider-factories';
import { AwsWorkspaceHostProvider } from './aws-provider';
import type { AwsSdkClientConfig, AwsSdkClientSet } from './aws-sdk-client';
import type { WorkspaceHostResourceCreatedEvent } from './gcp-provider';

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
const NOW = '2026-10-01T20:30:00.000Z';

/** `null` means "no persisted credential source" (an omitted argument takes the local default). */
function connection(
  credentialSource: Record<string, unknown> | null = {
    environment: 'local',
    method: 'shared-profile',
    profile: 'papercusp-byoc',
  },
  target = 'aws',
): WorkspaceHostProviderConnection {
  return {
    target,
    cloudCredentialRef: { kind: 'cloud', ref: 'aws-local:papercusp-byoc' },
    scope: { kind: 'account', id: ACCOUNT },
    provider: { ...(credentialSource ? { credentialSource } : {}), partition: 'aws', region: REGION },
  } as WorkspaceHostProviderConnection;
}

const HOSTED_CUSTOMER_ROLE = {
  environment: 'hosted',
  method: 'customer-role',
  roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost`,
  trustedPrincipalArn: 'arn:aws:iam::111122223333:role/papercusp/orgs/org-1',
  externalIdRef: 'org-1',
};

const HOSTED_OIDC = {
  environment: 'hosted',
  method: 'oidc',
  roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost`,
  providerArn: `arn:aws:iam::${ACCOUNT}:oidc-provider/auth.papercusp.example`,
  issuer: 'https://auth.papercusp.example',
  audience: 'sts.amazonaws.com',
  subject: 'org:org-1',
};

/** A hosted customer-role connection as hosted-provider-delegation persists it (P-008). */
function hostedCustomerRole(options: {
  status?: 'pending' | 'verified' | 'revoked' | 'invalid';
  provider?: 'aws' | 'gcp';
  delegatedRoleArn?: string;
} = {}): WorkspaceHostProviderConnection {
  const base = connection(HOSTED_CUSTOMER_ROLE);
  const provider = options.provider ?? 'aws';
  return {
    ...base,
    provider: {
      ...base.provider,
      hostedDelegation: {
        schemaVersion: 'hosted-provider-delegation-v1',
        provider,
        status: options.status ?? 'verified',
        configuration: {
          provider,
          accountId: ACCOUNT,
          source: { ...HOSTED_CUSTOMER_ROLE, roleArn: options.delegatedRoleArn ?? HOSTED_CUSTOMER_ROLE.roleArn },
        },
      },
    },
  } as WorkspaceHostProviderConnection;
}

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-aws-configured-1',
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

function ctx(): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-aws-configured',
    requestId: 'request-1',
    // Provision needs the controller-rendered bootstrap (aws-byoc-gcp-parity D-013).
    hostBootstrapScript: '#!/usr/bin/env bash\necho papercusp-bootstrap\n',
    connection: connection(),
  };
}

/** AMI root-device discovery followed by a create-data-volume step. */
function fakeEc2() {
  const sent: string[] = [];
  const volumes = new Map<string, { token: string; tags: unknown[] }>();
  const createClients = (_config: AwsSdkClientConfig): AwsSdkClientSet => {
    const client = (service: string) => ({
      send: async (command: { input: Record<string, any>; constructor: { name: string } }) => {
        const name = `${service}:${command.constructor.name}`;
        sent.push(name);
        const meta = { $metadata: { requestId: `req-${sent.length}` } };
        // The SDK client proves it is in the connection's account before any mutation.
        if (name === 'sts:GetCallerIdentityCommand') {
          return { ...meta, Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/PapercuspByoc/s`, UserId: 'AROA:s' };
        }
        if (name === 'ec2:DescribeImagesCommand') {
          expect(command.input.ImageIds).toEqual(['ami-0abc']);
          return { ...meta, Images: [{ ImageId: 'ami-0abc', RootDeviceName: '/dev/xvda' }] };
        }
        if (name === 'ec2:CreateVolumeCommand') {
          const id = `vol-${volumes.size + 1}`;
          volumes.set(id, { token: command.input.ClientToken, tags: command.input.TagSpecifications?.[0]?.Tags ?? [] });
          return { ...meta, VolumeId: id };
        }
        if (name === 'ec2:DescribeVolumesCommand') {
          const ids: string[] = command.input.VolumeIds ?? [...volumes.keys()];
          return {
            ...meta,
            Volumes: ids
              .filter((id) => volumes.has(id))
              .map((id) => ({ VolumeId: id, State: 'available', AvailabilityZone: 'us-east-2a', Tags: volumes.get(id)!.tags, Attachments: [] })),
          };
        }
        throw new Error(`fake EC2 does not implement ${name}`);
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
  return { sent, createClients };
}

afterEach(() => {
  _resetWorkspaceHostProvidersForTests();
});

describe('createConfiguredAwsWorkspaceHostProvider — composition', () => {
  it('composes an AWS provider for a local credential source without calling AWS', () => {
    const ec2 = fakeEc2();
    const provider = createConfiguredAwsWorkspaceHostProvider(connection(), { createClients: ec2.createClients });
    expect(provider).toBeInstanceOf(AwsWorkspaceHostProvider);
    expect(provider.target).toBe('aws');
    expect(ec2.sent).toEqual([]);
  });

  it('refuses a non-AWS connection target', () => {
    expect(() => createConfiguredAwsWorkspaceHostProvider(connection(undefined, 'gcp'))).toThrow(
      "AWS workspace-host provider cannot compose target 'gcp'",
    );
  });

  it('refuses a connection with no persisted credential source', () => {
    expect(() => createConfiguredAwsWorkspaceHostProvider(connection(null))).toThrow(
      'aws_workspace_host_credential_source_required',
    );
  });

  it('refuses a hosted customer-role source without an ExternalId resolver (D-001), and composes with one behind a verified delegation', () => {
    expect(() => createConfiguredAwsWorkspaceHostProvider(hostedCustomerRole())).toThrow(
      'aws_workspace_host_external_id_resolver_required',
    );
    const provider = createConfiguredAwsWorkspaceHostProvider(hostedCustomerRole(), {
      resolveExternalId: async () => 'external-id-org-1',
    });
    expect(provider.target).toBe('aws');
  });

  it('P-008: a hosted customer role acts only through a VERIFIED delegation for that same role (revocation takes effect here)', () => {
    const resolveExternalId = async () => 'external-id-org-1';
    for (const status of ['pending', 'revoked', 'invalid'] as const) {
      expect(() => createConfiguredAwsWorkspaceHostProvider(hostedCustomerRole({ status }), { resolveExternalId }))
        .toThrow('aws_workspace_host_hosted_delegation_not_verified');
    }
    expect(() => createConfiguredAwsWorkspaceHostProvider(connection(HOSTED_CUSTOMER_ROLE), { resolveExternalId }))
      .toThrow('aws_workspace_host_hosted_delegation_metadata_missing');
    expect(() => createConfiguredAwsWorkspaceHostProvider(hostedCustomerRole({ provider: 'gcp' }), { resolveExternalId }))
      .toThrow('aws_workspace_host_hosted_delegation_provider_mismatch');
    expect(() => createConfiguredAwsWorkspaceHostProvider(
      hostedCustomerRole({ delegatedRoleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost-other` }),
      { resolveExternalId },
    )).toThrow('aws_workspace_host_hosted_delegation_source_mismatch');
  });

  it('refuses a hosted OIDC source without a web-identity token source, and composes with one', () => {
    expect(() => createConfiguredAwsWorkspaceHostProvider(connection(HOSTED_OIDC))).toThrow(
      'aws_workspace_host_web_identity_token_source_required',
    );
    const provider = createConfiguredAwsWorkspaceHostProvider(connection(HOSTED_OIDC), {
      getWebIdentityToken: async () => 'header.payload.signature',
    });
    expect(provider.target).toBe('aws');
  });
});

describe("the 'aws' workspace-host provider factory", () => {
  it('resolves a connection-composed AwsWorkspaceHostProvider through the registry', () => {
    const composed: WorkspaceHostProviderConnection[] = [];
    registerWorkspaceHostProviderFactory('aws', (conn) => {
      composed.push(conn);
      return createConfiguredAwsWorkspaceHostProvider(conn);
    });
    const provider = resolveWorkspaceHostProvider(connection());
    expect(provider).toBeInstanceOf(AwsWorkspaceHostProvider);
    expect(provider.target).toBe('aws');
    expect(composed).toHaveLength(1);
    expect(composed[0]!.scope).toEqual({ kind: 'account', id: ACCOUNT });
  });

  it('surfaces a composition refusal at resolve time instead of mid-operation', () => {
    registerWorkspaceHostProviderFactory('aws', (conn) => createConfiguredAwsWorkspaceHostProvider(conn));
    expect(() => resolveWorkspaceHostProvider(connection(HOSTED_CUSTOMER_ROLE))).toThrow(
      'aws_workspace_host_external_id_resolver_required',
    );
  });
});

describe('createConfiguredAwsWorkspaceHostProvider — teardown-obligation observers', () => {
  it('fires onResourceCreated through the real SDK client, addressed to the connection account and region', async () => {
    const ec2 = fakeEc2();
    const created: WorkspaceHostResourceCreatedEvent[] = [];
    const provider = createConfiguredAwsWorkspaceHostProvider(connection(), {
      createClients: ec2.createClients,
      waiter: { maxWaitTimeSec: 0.05, minDelaySec: 0.001, maxDelaySec: 0.002 },
      now: () => NOW,
      onResourceCreated: (event) => {
        created.push(event);
      },
    });
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-1', idempotencyKey: 'idem-1', desired: desired() },
      ctx(),
    );
    const first = plan.steps[0]!;
    const result = await provider.apply({ planId: plan.planId, operationId: plan.operationId, step: first, knownResources: [] }, ctx());

    expect(result.state).toBe('applied');
    expect(ec2.sent).toContain('ec2:CreateVolumeCommand');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workspaceId: 'workspace-aws-configured',
      hostId: 'host-aws-configured-1',
      parentResourceId: ACCOUNT,
      resource: { kind: 'disk', providerId: 'vol-1', parentProviderId: ACCOUNT, region: REGION },
    });
  });
});

describe('registerWorkspaceHostProviderFactories — the operator startup composition root', () => {
  const unusedHostedGcpAuth = async (): Promise<never> => {
    throw new Error('hosted GCP auth is not exercised by an AWS connection');
  };
  const observersInto = (created: WorkspaceHostResourceCreatedEvent[]) => (provider: 'gcp' | 'aws') => ({
    onResourceCreated: (event: WorkspaceHostResourceCreatedEvent) => {
      if (provider === 'aws') created.push(event);
    },
    onResourceDestroyed: () => {},
  });

  it("AWSP-P-003-aws-resolves: after startup registration an 'aws' connection resolves to the AWS provider instead of an unsupported-provider refusal", () => {
    // Before registration the registry refuses the target outright.
    expect(() => resolveWorkspaceHostProvider(connection())).toThrow();

    registerWorkspaceHostProviderFactories({ resolveHostedGcpAuth: unusedHostedGcpAuth, obligationObservers: observersInto([]) });

    const provider = resolveWorkspaceHostProvider(connection());
    expect(provider).toBeInstanceOf(AwsWorkspaceHostProvider);
    expect(provider.target).toBe('aws');
  });

  it('P-008: the startup factory binds the organization ExternalId resolver, so a hosted customer role composes behind a verified delegation and refuses once revoked', () => {
    registerWorkspaceHostProviderFactories({ resolveHostedGcpAuth: unusedHostedGcpAuth, obligationObservers: observersInto([]) });
    expect(resolveWorkspaceHostProvider(hostedCustomerRole())).toBeInstanceOf(AwsWorkspaceHostProvider);
    expect(() => resolveWorkspaceHostProvider(hostedCustomerRole({ status: 'revoked' })))
      .toThrow('aws_workspace_host_hosted_delegation_not_verified');
  });

  it('AUTO-BAR-R-1-P-003: the registered aws factory drives the SDK-backed client — a create reaches EC2 as an SDK command and opens an obligation', async () => {
    const ec2 = fakeEc2();
    const created: WorkspaceHostResourceCreatedEvent[] = [];
    registerWorkspaceHostProviderFactories({
      resolveHostedGcpAuth: unusedHostedGcpAuth,
      obligationObservers: observersInto(created),
      awsTransport: {
        createClients: ec2.createClients,
        waiter: { maxWaitTimeSec: 0.05, minDelaySec: 0.001, maxDelaySec: 0.002 },
        now: () => NOW,
      },
    });

    const provider = resolveWorkspaceHostProvider(connection());
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-startup', idempotencyKey: 'idem-startup', desired: desired() },
      ctx(),
    );
    expect(ec2.sent).toContain('ec2:DescribeImagesCommand');
    expect(plan.steps.find((step) => step.id === 'run-instance')?.input).toMatchObject({
      op: 'run-instance',
      request: { BlockDeviceMappings: [{ DeviceName: '/dev/xvda' }] },
    });
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] },
      ctx(),
    );

    expect(result.state).toBe('applied');
    expect(ec2.sent).toContain('ec2:CreateVolumeCommand');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ resource: { kind: 'disk', parentProviderId: ACCOUNT, region: REGION } });
  });

  it('is the registration path operator startup runs (no inline per-cloud registration left in bootstrap)', () => {
    const bootstrap = readFileSync(fileURLToPath(new URL('../dbos/bootstrap.ts', import.meta.url)), 'utf8');
    expect(bootstrap).toContain('registerWorkspaceHostProviderFactories({');
    expect(bootstrap).not.toMatch(/registerWorkspaceHostProviderFactory\(\s*'(aws|gcp)'/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  bindDelegationToOrganization,
  bindPapercuspHostedDelegation,
  buildHostedProviderDelegationOnboarding,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationRecord,
  type HostedProviderDelegationSqlRunner,
  type HostedProviderDelegationStore,
} from './hosted-provider-delegation';
import { organizationExternalId } from './hosted-aws-identity';

const NOW = '2026-08-27T12:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

const ORG_PRINCIPAL = 'serviceAccount:pco-org-a@papercusp-identity.iam.gserviceaccount.com';
const HOSTING_PROJECT = 'papercusp-hosted-workspaces';
function organization(organizationId: string, principal: string): HostedDelegationOrganization & {
  reserved: string[];
} {
  const reserved: string[] = [];
  return {
    organizationId,
    reserved,
    gcpTrustedPrincipal: async () => principal,
    gcpPapercuspHosting: async (hostId) => {
      reserved.push(hostId);
      return { projectId: HOSTING_PROJECT, serviceAccountEmail: principal.slice('serviceAccount:'.length) };
    },
    awsTrustedPrincipal: async () => ({
      principalArn: awsOrgPrincipal(organizationId),
      externalIdRef: `resolver://aws-external-id/${organizationId}`,
    }),
    awsPapercuspHosting: async (hostId) => {
      reserved.push(hostId);
      return {
        accountId: AWS_HOSTING_ACCOUNT,
        region: 'us-east-1',
        roleArn: awsHostingRole(organizationId),
        trustedPrincipalArn: awsOrgPrincipal(organizationId),
        externalIdRef: `resolver://aws-external-id/${organizationId}`,
      };
    },
  };
}
function awsOrgPrincipal(organizationId: string): string {
  return `arn:aws:iam::999999999999:role/papercusp/orgs/pco-${organizationId}`;
}
const AWS_HOSTING_ACCOUNT = '888888888888';
function awsHostingRole(organizationId: string): string {
  return `arn:aws:iam::${AWS_HOSTING_ACCOUNT}:role/PapercuspWorkspaceHost-pco-${organizationId}`;
}
const ORGANIZATION = organization('org-a', ORG_PRINCIPAL);

const common = {
  organizationId: 'org-a',
  workspaceId: 'workspace-1',
  connectionId: 'connection-1',
  label: 'Production delegation',
  credentialRef: 'encrypted://workspace-1/cloud/connection-1',
  now: NOW,
};

describe('hosted provider delegation onboarding', () => {
  it('generates deterministic least-privilege templates for GCP, AWS, and Azure', () => {
    const gcp = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'workload-identity',
          projectId: 'papercusp-hosted-123',
          projectNumber: '123456789012',
          poolId: 'papercusp-hosted',
          providerId: 'papercusp-oidc',
          serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
          issuer: 'https://app.papercusp.com/oidc',
          audience: 'papercusp-workspace-hosts',
          subject: 'workspace:workspace-1',
        },
      },
    });
    expect(gcp.template.format).toBe('gcp-iam-json');
    expect(JSON.stringify(gcp.template.document)).toContain('compute.instances.create');
    expect(JSON.stringify(gcp.template.document)).toContain('roles/iam.workloadIdentityUser');

    const aws = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
          trustedPrincipalArn: 'arn:aws:iam::999999999999:role/PapercuspControlPlane',
          externalIdRef: 'encrypted://workspace-1/aws/external-id',
        },
      },
    });
    expect(aws.template.format).toBe('aws-cloudformation-json');
    expect(JSON.stringify(aws.template.document)).toContain('sts:ExternalId');
    expect(JSON.stringify(aws.template.document)).toContain('ec2:RunInstances');
    expect(JSON.stringify(aws.template.document)).not.toContain('encrypted://workspace-1/aws/external-id');

    const azure = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'azure',
        source: {
          environment: 'hosted',
          method: 'federated-service-principal',
          tenantId: TENANT,
          clientId: CLIENT,
          issuer: 'https://app.papercusp.com/oidc',
          audience: 'api://AzureADTokenExchange',
          subject: 'workspace:workspace-1',
          assertionRef: 'resolver://azure/assertions/workspace-1',
        },
      },
    });
    expect(azure.template.format).toBe('azure-arm-json');
    expect(JSON.stringify(azure.template.document)).toContain('Microsoft.Compute/virtualMachines/write');
    expect(JSON.stringify(azure.template.document)).not.toContain('assertionRef');
  });

  it('rejects uploaded/static key material and non-resolver credential references', () => {
    expect(() =>
      buildHostedProviderDelegationOnboarding({
        ...common,
        credentialRef: 'uploaded://service-account.json',
        configuration: {
          provider: 'gcp',
          source: {
            method: 'service-account-impersonation',
            projectId: 'papercusp-hosted-123',
            serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
            trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane',
          },
        },
      }),
    ).toThrow(/credentialRef is invalid/);

    expect(() =>
      buildHostedProviderDelegationOnboarding({
        ...common,
        configuration: {
          provider: 'azure',
          source: {
            environment: 'hosted',
            method: 'federated-service-principal',
            tenantId: TENANT,
            clientId: CLIENT,
            issuer: 'https://app.papercusp.com/oidc',
            audience: 'api://AzureADTokenExchange',
            subject: 'workspace:workspace-1',
            assertionRef: 'resolver://azure/assertions/workspace-1',
            clientSecret: 'never-emit-me',
          } as never,
        },
      }),
    ).toThrow(/Secret-shaped field/);
  });

  it('verifies, rotates, and revokes through generation-checked persistence', async () => {
    let record: HostedProviderDelegationRecord | null = null;
    const store: HostedProviderDelegationStore = {
      async read() {
        return record;
      },
      async save(next, expectedGeneration) {
        if (expectedGeneration !== undefined && record?.generation !== expectedGeneration) {
          throw new Error('generation-conflict');
        }
        record = next;
      },
    };
    const verify = vi.fn(async (value: HostedProviderDelegationRecord) => ({
      identity: `${value.provider}:delegated-identity`,
      evidenceRef: `audit://${value.provider}/${value.generation}`,
      checkedAt: NOW,
    }));
    const revoke = vi.fn(async (value: HostedProviderDelegationRecord) => ({
      evidenceRef: `audit://${value.provider}/${value.generation}/revoked`,
      revokedAt: NOW,
    }));
    const adapter: HostedProviderDelegationAdapter = { verify, revoke };
    const manager = new HostedProviderDelegationManager(
      store,
      { gcp: adapter, aws: adapter, azure: adapter },
      ORGANIZATION,
      () => new Date(NOW),
    );

    const initial = await manager.onboard({
      ...common,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'service-account-impersonation',
          projectId: 'papercusp-hosted-123',
          serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
          trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane',
        },
      },
    });
    expect(initial.record.status).toBe('pending');
    await expect(manager.verify('workspace-1', 'connection-1')).resolves.toMatchObject({
      status: 'verified',
      generation: 1,
      identity: 'gcp:delegated-identity',
    });

    await expect(
      manager.rotate('workspace-1', 'connection-1', {
        label: common.label,
        credentialRef: 'encrypted://workspace-1/cloud/connection-1-generation-2',
        now: NOW,
        configuration: {
          provider: 'gcp',
          source: {
            method: 'service-account-impersonation',
            projectId: 'papercusp-hosted-123',
            serviceAccountEmail: 'workspace-host-v2@papercusp-hosted-123.iam.gserviceaccount.com',
            trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane-v2',
          },
        },
      }),
    ).resolves.toMatchObject({ status: 'verified', generation: 2, supersedesGeneration: 1 });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));

    await expect(manager.revoke('workspace-1', 'connection-1')).resolves.toMatchObject({
      status: 'revoked',
      generation: 2,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

describe('organization-bound delegations (D-397)', () => {
  function memoryStore() {
    const records = new Map<string, HostedProviderDelegationRecord>();
    const store: HostedProviderDelegationStore = {
      async read(workspaceId, connectionId) {
        return records.get(`${workspaceId}/${connectionId}`) ?? null;
      },
      async save(next) {
        records.set(`${next.workspaceId}/${next.connectionId}`, next);
      },
    };
    return { records, store };
  }
  const adapter: HostedProviderDelegationAdapter = {
    verify: async (value) => ({ identity: `${value.provider}:ok`, evidenceRef: 'audit://ok', checkedAt: NOW }),
    revoke: async () => ({ evidenceRef: 'audit://revoked', revokedAt: NOW }),
  };
  const adapters = { gcp: adapter, aws: adapter, azure: adapter };
  const impersonation = {
    provider: 'gcp' as const,
    source: {
      method: 'service-account-impersonation' as const,
      projectId: 'customer-project-1',
      serviceAccountEmail: 'victim-host@customer-project-1.iam.gserviceaccount.com',
      trustedPrincipal: 'serviceAccount:attacker-chosen@evil.iam.gserviceaccount.com',
    },
  };

  it('stamps the bound organization and its own principal over whatever the caller sent', async () => {
    const { store } = memoryStore();
    const manager = new HostedProviderDelegationManager(store, adapters, ORGANIZATION, () => new Date(NOW));
    const { record, template } = await manager.onboard({
      ...common,
      organizationId: 'org-victim',
      configuration: impersonation,
    });
    expect(record.organizationId).toBe('org-a');
    expect(record.configuration.source).toMatchObject({ trustedPrincipal: ORG_PRINCIPAL });
    expect(JSON.stringify(template.document)).toContain(ORG_PRINCIPAL);
    expect(JSON.stringify(template.document)).not.toContain('attacker-chosen');
  });

  it("P-008: binds an AWS customer role to the organization's own role and ExternalId over whatever the caller sent", async () => {
    const { store } = memoryStore();
    const manager = new HostedProviderDelegationManager(store, adapters, ORGANIZATION, () => new Date(NOW));
    const { record, template } = await manager.onboard({
      ...common,
      organizationId: 'org-victim',
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost-123456789012',
          trustedPrincipalArn: 'arn:aws:iam::666666666666:role/attacker-chosen',
          externalIdRef: 'resolver://aws-external-id/org-victim',
        },
      },
    });
    expect(record.organizationId).toBe('org-a');
    expect(record.configuration.source).toMatchObject({
      trustedPrincipalArn: awsOrgPrincipal('org-a'),
      externalIdRef: 'resolver://aws-external-id/org-a',
    });
    const document = template.document as {
      Parameters: { ExternalId: Record<string, unknown> };
      Resources: Record<string, { Properties: { RoleName?: string } }>;
    };
    // The customer's stack is prefilled with the organization's ExternalId; it is not a secret (D-007).
    expect(document.Parameters.ExternalId.Default).toBe(organizationExternalId('org-a'));
    expect(document.Parameters.ExternalId).not.toHaveProperty('NoEcho');
    expect(JSON.stringify(document)).toContain(awsOrgPrincipal('org-a'));
    expect(JSON.stringify(document)).not.toContain('attacker-chosen');
    expect(JSON.stringify(document)).not.toContain(organizationExternalId('org-victim'));
    expect(Object.values(document.Resources).some((resource) => resource.Properties.RoleName === 'PapercuspWorkspaceHost-123456789012'))
      .toBe(true);
  });

  it('P-008: refuses an AWS method no organization owns (hosted OIDC), before recording anything', async () => {
    const { records, store } = memoryStore();
    await expect(new HostedProviderDelegationManager(store, adapters, ORGANIZATION).onboard({
      ...common,
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted', method: 'oidc', roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
          providerArn: 'arn:aws:iam::123456789012:oidc-provider/app.papercusp.com', issuer: 'https://app.papercusp.com/oidc',
          audience: 'sts.amazonaws.com', subject: 'workspace:workspace-1',
        },
      } as never,
    })).rejects.toThrow('hosted_provider_delegation_aws_method_not_organization_bound');
    expect(records.size).toBe(0);
  });

  it("treats another organization's delegation as not found for every lifecycle verb", async () => {
    const { store } = memoryStore();
    await new HostedProviderDelegationManager(store, adapters, ORGANIZATION).onboard({ ...common, configuration: impersonation });
    const other = new HostedProviderDelegationManager(
      store,
      adapters,
      organization('org-b', 'serviceAccount:pco-org-b@papercusp-identity.iam.gserviceaccount.com'),
    );
    await expect(other.verify('workspace-1', 'connection-1')).rejects.toThrow('not_found');
    await expect(other.revoke('workspace-1', 'connection-1')).rejects.toThrow('not_found');
    await expect(other.rotate('workspace-1', 'connection-1', {
      label: 'x', credentialRef: common.credentialRef, configuration: impersonation,
    })).rejects.toThrow('not_found');
  });

  it('refuses GCP workload identity, which no organization owns', async () => {
    const { records, store } = memoryStore();
    await expect(new HostedProviderDelegationManager(store, adapters, ORGANIZATION).onboard({
      ...common,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'workload-identity', projectId: 'customer-project-1', projectNumber: '123456789012',
          poolId: 'pool', providerId: 'provider', serviceAccountEmail: 'host@customer-project-1.iam.gserviceaccount.com',
          issuer: 'https://app.papercusp.com/oidc', audience: 'aud', subject: 'workspace:workspace-1',
        },
      },
    })).rejects.toThrow('method_not_organization_bound');
    expect(records.size).toBe(0);
  });
});

describe("Papercusp-hosted delegations (D-399)", () => {
  const papercuspHosted = {
    provider: 'gcp' as const,
    source: {
      method: 'papercusp-hosted' as const,
      projectId: HOSTING_PROJECT,
      serviceAccountEmail: 'pco-org-a@papercusp-identity.iam.gserviceaccount.com',
      hostId: 'host-of-another-organization',
    },
  };

  it('cannot be selected by a caller-supplied configuration, so no request can reserve a host it names', async () => {
    const records = new Map<string, HostedProviderDelegationRecord>();
    const store: HostedProviderDelegationStore = {
      read: async (workspaceId, connectionId) => records.get(`${workspaceId}/${connectionId}`) ?? null,
      save: async (next) => void records.set(`${next.workspaceId}/${next.connectionId}`, next),
    };
    const org = organization('org-a', ORG_PRINCIPAL);
    const adapter: HostedProviderDelegationAdapter = {
      verify: async () => ({ identity: 'x', evidenceRef: 'audit://x', checkedAt: NOW }),
      revoke: async () => ({ evidenceRef: 'audit://x', revokedAt: NOW }),
    };
    const manager = new HostedProviderDelegationManager(store, { gcp: adapter, aws: adapter, azure: adapter }, org);
    await expect(manager.onboard({ ...common, configuration: papercuspHosted })).rejects.toThrow(
      'method_not_organization_bound',
    );
    expect(org.reserved).toEqual([]);
    expect(records.size).toBe(0);

    // Its own entry records a Papercusp-hosted delegation only for the host the server derived.
    const { organizationId: _ignored, ...base } = common;
    const { record } = await manager.onboardPapercuspHosted(base, 'host-derived-1');
    expect(org.reserved).toEqual(['host-derived-1']);
    expect(record).toMatchObject({ organizationId: 'org-a', configuration: { source: { hostId: 'host-derived-1' } } });
    expect(records.get(`${common.workspaceId}/${common.connectionId}`)).toEqual(record);
  });

  it('reserves exactly the server-given host and records it with nothing for the customer to apply', async () => {
    const org = organization('org-a', ORG_PRINCIPAL);
    const { organizationId: _ignored, ...base } = common;
    const input = await bindPapercuspHostedDelegation(base, org, 'host-derived-1');
    expect(org.reserved).toEqual(['host-derived-1']);
    expect(input.organizationId).toBe('org-a');
    const { record, template } = buildHostedProviderDelegationOnboarding(input);
    expect(record.configuration).toEqual({
      provider: 'gcp',
      source: {
        method: 'papercusp-hosted',
        projectId: HOSTING_PROJECT,
        serviceAccountEmail: 'pco-org-a@papercusp-identity.iam.gserviceaccount.com',
        hostId: 'host-derived-1',
      },
    });
    expect(template.document).toMatchObject({ managedBy: 'papercusp', hostId: 'host-derived-1' });
    // A different reservation is a different grant.
    const other = buildHostedProviderDelegationOnboarding(await bindPapercuspHostedDelegation(base, org, 'host-derived-2'));
    expect(other.record.templateDigest).not.toBe(record.templateDigest);
  });

  it('refuses an unsafe host id before reserving anything', async () => {
    const org = organization('org-a', ORG_PRINCIPAL);
    const { organizationId: _ignored, ...base } = common;
    await expect(bindPapercuspHostedDelegation(base, org, "x' || true || '")).rejects.toThrow();
    expect(org.reserved).toEqual([]);
  });
});

describe("Papercusp-hosted AWS delegations (aws-byoc-gcp-parity P-015, D-017)", () => {
  const { organizationId: _ignored, ...base } = common;

  it("binds the customer-role chain into Papercusp's hosting account for the server-given host, with nothing to apply", async () => {
    const org = organization('org-a', ORG_PRINCIPAL);
    const input = await bindPapercuspHostedDelegation(base, org, 'host-derived-1', 'aws');
    expect(org.reserved).toEqual(['host-derived-1']);
    const { record, template } = buildHostedProviderDelegationOnboarding(input);
    expect(record.provider).toBe('aws');
    expect(record.configuration).toEqual({
      provider: 'aws',
      accountId: AWS_HOSTING_ACCOUNT,
      region: 'us-east-1',
      source: {
        environment: 'hosted',
        method: 'customer-role',
        roleArn: awsHostingRole('org-a'),
        trustedPrincipalArn: awsOrgPrincipal('org-a'),
        externalIdRef: 'resolver://aws-external-id/org-a',
      },
      papercuspHosted: { hostId: 'host-derived-1' },
    });
    // No CloudFormation for the customer: the document records what the hosting role is scoped to.
    expect(template.format).toBe('aws-cloudformation-json');
    expect(template.document).toEqual({
      managedBy: 'papercusp',
      accountId: AWS_HOSTING_ACCOUNT,
      region: 'us-east-1',
      roleArn: awsHostingRole('org-a'),
      trustedPrincipalArn: awsOrgPrincipal('org-a'),
      hostId: 'host-derived-1',
    });
    const other = buildHostedProviderDelegationOnboarding(await bindPapercuspHostedDelegation(base, org, 'host-derived-2', 'aws'));
    expect(other.record.templateDigest).not.toBe(record.templateDigest);
  });

  it('records it through the manager, and leaves the GCP default untouched', async () => {
    const records = new Map<string, HostedProviderDelegationRecord>();
    const store: HostedProviderDelegationStore = {
      read: async (workspaceId, connectionId) => records.get(`${workspaceId}/${connectionId}`) ?? null,
      save: async (next) => void records.set(`${next.workspaceId}/${next.connectionId}`, next),
    };
    const adapter: HostedProviderDelegationAdapter = {
      verify: async () => ({ identity: 'x', evidenceRef: 'audit://x', checkedAt: NOW }),
      revoke: async () => ({ evidenceRef: 'audit://x', revokedAt: NOW }),
    };
    const org = organization('org-a', ORG_PRINCIPAL);
    const manager = new HostedProviderDelegationManager(store, { gcp: adapter, aws: adapter, azure: adapter }, org);
    const aws = await manager.onboardPapercuspHosted(base, 'host-derived-1', 'aws');
    expect(aws.record.configuration).toMatchObject({ provider: 'aws', papercuspHosted: { hostId: 'host-derived-1' } });
    const gcp = await manager.onboardPapercuspHosted({ ...base, connectionId: 'connection-2' }, 'host-derived-2');
    expect(gcp.record.configuration).toMatchObject({ provider: 'gcp', source: { method: 'papercusp-hosted' } });
  });

  it('cannot be selected by a caller-supplied configuration, or carried on any method but the customer role', async () => {
    const org = organization('org-a', ORG_PRINCIPAL);
    const browserSupplied = {
      provider: 'aws' as const,
      accountId: AWS_HOSTING_ACCOUNT,
      source: {
        environment: 'hosted' as const,
        method: 'customer-role' as const,
        roleArn: awsHostingRole('org-b'),
        trustedPrincipalArn: '',
        externalIdRef: '',
      },
      papercuspHosted: { hostId: 'host-of-another-organization' },
    };
    await expect(bindDelegationToOrganization({ configuration: browserSupplied }, org))
      .rejects.toThrow('hosted_provider_delegation_aws_papercusp_hosted_not_organization_bound');
    expect(org.reserved).toEqual([]);
    expect(() => buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'aws',
        accountId: AWS_HOSTING_ACCOUNT,
        source: {
          environment: 'hosted',
          method: 'oidc',
          roleArn: awsHostingRole('org-a'),
          providerArn: `arn:aws:iam::${AWS_HOSTING_ACCOUNT}:oidc-provider/app.papercusp.com`,
          issuer: 'https://app.papercusp.com/oidc',
          audience: 'sts.amazonaws.com',
          subject: 'workspace:workspace-1',
        },
        papercuspHosted: { hostId: 'host-derived-1' },
      },
    })).toThrow('AWS Papercusp hosting requires the customer-role method');
  });
});

describe('stored connection config (WI-10005297)', () => {
  /** Captures the provider_config the store writes; the SQL itself is exercised live. */
  function capturingRunner() {
    const written: Array<Record<string, unknown>> = [];
    const sql = Object.assign(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        for (const value of values) {
          if (value && typeof value === 'object' && 'json' in value) {
            written.push((value as { json: Record<string, unknown> }).json);
          }
        }
        return [{ id: common.connectionId }];
      },
      { json: (value: Record<string, unknown>) => ({ json: value }) },
    );
    const run: HostedProviderDelegationSqlRunner = (fn) => fn(sql as never);
    return { run, written };
  }

  // The connection config is spread over every desired spec, where the GCP provider reads
  // `serviceAccountEmail` as the VM's own identity. The delegation's account is the CONTROLLER.
  it.each([
    ['service-account-impersonation', {
      method: 'service-account-impersonation' as const,
      projectId: 'customer-project-1',
      serviceAccountEmail: 'papercusp-host-operator@customer-project-1.iam.gserviceaccount.com',
      trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane',
    }],
    ['papercusp-hosted', {
      method: 'papercusp-hosted' as const,
      projectId: HOSTING_PROJECT,
      serviceAccountEmail: 'pco-org-a@papercusp-identity.iam.gserviceaccount.com',
      hostId: 'host-derived-1',
    }],
  ])('a %s delegation stores its project but never the controller identity', async (_method, source) => {
    const { record } = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: { provider: 'gcp', source },
    });
    const { run, written } = capturingRunner();
    await new PostgresHostedProviderDelegationStore(run, 'control-plane').save(record);

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({ hostedDelegation: record, projectId: source.projectId });
    expect(written[0]).not.toHaveProperty('serviceAccountEmail');
    // Positive control: the account is still on the delegation, where the credential resolver reads it.
    expect((written[0].hostedDelegation as HostedProviderDelegationRecord).configuration).toMatchObject({
      source: { serviceAccountEmail: source.serviceAccountEmail },
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  bindPapercuspHostedDelegation,
  buildHostedProviderDelegationOnboarding,
  type HostedProviderDelegationConfiguration,
  type HostedProviderDelegationRecord,
} from '../../workspace-host/hosted-provider-delegation';
import {
  awsFirstWorkspaceDesiredSpec,
  createHostedFirstWorkspace,
  firstWorkspaceIdentity,
  GCP_FIRST_WORKSPACE_DEFAULTS,
  gcpFirstWorkspaceDesiredSpec,
  PAPERCUSP_HOSTED_AWS_PROVISIONING_MODEL,
  type HostedFirstWorkspaceDependencies,
  type HostedFirstWorkspaceRequest,
} from './first-workspace';
import {
  HostedAwsHostInfrastructurePendingError,
  type HostedAwsHostInfrastructure,
} from '../../workspace-host/hosted-aws-host-stack';
import { HostedGcpNotReadyError } from '../../workspace-host/hosted-gcp-hosting';
import { HostedAwsHostingUnconfiguredError, HostedAwsNotReadyError } from '../../workspace-host/hosted-aws-hosting';
import { HostedWorkspaceAdmissionError } from './workspace-admission';

const GCP: HostedProviderDelegationConfiguration = {
  provider: 'gcp',
  source: {
    method: 'service-account-impersonation',
    projectId: 'customer-project-1',
    serviceAccountEmail: 'papercusp-host@customer-project-1.iam.gserviceaccount.com',
    trustedPrincipal: 'serviceAccount:control-plane@papercusp.iam.gserviceaccount.com',
  },
};

/** Each organization's own Papercusp account (D-397) — deliberately NOT the GCP fixture's value. */
const orgPrincipal = (organizationId: string) =>
  `serviceAccount:pco-${organizationId}@papercusp-identity.iam.gserviceaccount.com`;
const SERVER_PRINCIPAL = orgPrincipal('org-a');
const HOSTING_PROJECT = 'papercusp-hosted-workspaces';
/** Papercusp's own AWS hosting account (P-015, D-017). */
const AWS_HOSTING_ACCOUNT = '888888888888';

const REQUEST: HostedFirstWorkspaceRequest = {
  organizationId: 'org-a',
  userId: 'user-a',
  sessionId: 'session-a',
  sessionVersion: 3,
  attemptKey: 'attempt-0123456789abcdef',
  displayName: 'My workspace',
  label: 'My GCP project',
  hosting: 'byoc',
  configuration: GCP,
};

const PAPERCUSP_REQUEST: HostedFirstWorkspaceRequest = { ...REQUEST, hosting: 'papercusp', configuration: undefined };

const AWS_ACCOUNT = '413781344298';
/** What the customer's stack built (D-009), as the verified role reads it back. */
const AWS_INFRA: HostedAwsHostInfrastructure = {
  region: 'eu-west-1',
  zone: 'eu-west-1a',
  vpcId: 'vpc-0aaa',
  subnetId: 'subnet-0private',
  securityGroupId: 'sg-0noinbound',
  instanceProfileArn: `arn:aws:iam::${AWS_ACCOUNT}:instance-profile/PapercuspWorkspaceHostInstance-${AWS_ACCOUNT}`,
  launchTemplateId: 'lt-0abc',
  kmsKeyArn: `arn:aws:kms:eu-west-1:${AWS_ACCOUNT}:key/1234`,
  image: { id: 'ami-0ubuntu2404', version: 'ubuntu-noble-24.04-amd64-server-20260918' },
};
/** The browser names only the account and region; everything else is server-derived (D-008). */
const AWS_REQUEST: HostedFirstWorkspaceRequest = {
  ...REQUEST,
  label: 'My AWS account',
  configuration: { provider: 'aws', accountId: AWS_ACCOUNT, region: 'eu-west-1' } as never,
};

function harness(overrides: Partial<HostedFirstWorkspaceDependencies> = {}) {
  const records = new Map<string, HostedProviderDelegationRecord>();
  const ensureProvisioned = vi.fn(async (input: { requestedWorkspaceId?: string }) => ({
    workspaceId: input.requestedWorkspaceId as string,
    provisionOperationId: 'prov-op',
  }));
  const resolvedSpecs: unknown[] = [];
  const admissionOptions: unknown[] = [];
  const reserved: string[] = [];
  const deps: HostedFirstWorkspaceDependencies = {
    isEnabledFor: (organizationId) => organizationId === 'org-a',
    provisioningAvailable: () => true,
    delegationOrganization: (organizationId) => ({
      organizationId,
      gcpTrustedPrincipal: async () => orgPrincipal(organizationId),
      awsTrustedPrincipal: async () => ({
        principalArn: `arn:aws:iam::999999999999:role/papercusp/orgs/pco-${organizationId}`,
        externalIdRef: `resolver://aws-external-id/${organizationId}`,
      }),
      gcpPapercuspHosting: async (hostId) => {
        reserved.push(hostId);
        return {
          projectId: HOSTING_PROJECT,
          serviceAccountEmail: orgPrincipal(organizationId).slice('serviceAccount:'.length),
        };
      },
      awsPapercuspHosting: async (hostId) => {
        reserved.push(hostId);
        return {
          accountId: AWS_HOSTING_ACCOUNT,
          region: 'us-east-1',
          roleArn: `arn:aws:iam::${AWS_HOSTING_ACCOUNT}:role/PapercuspWorkspaceHost-pco-${organizationId}`,
          trustedPrincipalArn: `arn:aws:iam::999999999999:role/papercusp/orgs/pco-${organizationId}`,
          externalIdRef: `resolver://aws-external-id/${organizationId}`,
        };
      },
    }),
    organizationWorkspaceIds: async () => [],
    readDelegation: async (workspaceId, connectionId) => records.get(`${workspaceId}/${connectionId}`) ?? null,
    onboardDelegation: vi.fn(async (input) => {
      const onboarding = buildHostedProviderDelegationOnboarding(input);
      records.set(`${input.workspaceId}/${input.connectionId}`, onboarding.record);
      return onboarding;
    }),
    onboardPapercuspHostedDelegation: vi.fn(async (organizationId, input, hostId, provider) => {
      const onboarding = buildHostedProviderDelegationOnboarding(
        await bindPapercuspHostedDelegation(input, deps.delegationOrganization(organizationId), hostId, provider),
      );
      records.set(`${input.workspaceId}/${input.connectionId}`, onboarding.record);
      return onboarding;
    }),
    verifyDelegation: vi.fn(async (organizationId: string, workspaceId: string, connectionId: string) => {
      const record = records.get(`${workspaceId}/${connectionId}`);
      if (!record || record.organizationId !== organizationId) throw new Error('missing');
      return { ...record, status: 'verified' as const };
    }),
    createAdmission: (resolveDesiredSpec, options) => ({
      async ensureProvisioned(input) {
        admissionOptions.push(options);
        resolvedSpecs.push(
          await resolveDesiredSpec({
            organizationId: input.organizationId,
            provider: input.provider,
            connectionId: input.connectionId,
            hostId: firstWorkspaceIdentity(input.organizationId, REQUEST.attemptKey).hostId,
            displayName: input.displayName,
          }),
        );
        return ensureProvisioned(input);
      },
      resolveSelectable: async () => true,
    }),
    selectWorkspace: vi.fn(async () => ({ sessionId: 'session-rotated', expiresAt: new Date('2030-01-01T00:00:00Z') })),
    discoverAwsHostInfrastructure: vi.fn(async (record: HostedProviderDelegationRecord) => ({
      ...AWS_INFRA,
      region: record.configuration.provider === 'aws' ? record.configuration.region ?? 'us-east-1' : 'none',
    })),
    ...overrides,
  };
  return { deps, records, ensureProvisioned, resolvedSpecs, admissionOptions, reserved };
}

describe('hosted first-workspace bootstrap (D-384)', () => {
  it('derives every identifier from the organization, so two organizations never collide', () => {
    const a = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    const b = firstWorkspaceIdentity('org-b', REQUEST.attemptKey);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.connectionId).not.toBe(b.connectionId);
    expect(a.credentialRef).toBe(`delegation://${a.workspaceId}/${a.connectionId}`);
    expect(firstWorkspaceIdentity('org-a', REQUEST.attemptKey)).toEqual(a);
  });

  it('records the delegation, admits the workspace, and selects it on the session', async () => {
    const { deps, ensureProvisioned, resolvedSpecs } = harness();
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result).toMatchObject({
      ok: true,
      workspaceId: identity.workspaceId,
      connectionId: identity.connectionId,
      sessionId: 'session-rotated',
    });
    expect(ensureProvisioned).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', connectionId: identity.connectionId }),
    );
    expect(deps.selectWorkspace).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workspaceId: identity.workspaceId,
      expectedPermissionVersion: 3,
    });
    // The provisioned host runs in the CUSTOMER's project under the derived delegation ref.
    expect(resolvedSpecs[0]).toMatchObject({
      hostId: identity.hostId,
      scope: { kind: 'project', id: 'customer-project-1' },
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: identity.credentialRef } },
    });
  });

  it('refuses an organization that is not enabled, before any write', async () => {
    const { deps } = harness();
    const result = await createHostedFirstWorkspace(deps).run({ ...REQUEST, organizationId: 'org-z' });
    expect(result).toMatchObject({ ok: false, code: 'first_workspace_not_enabled', status: 403 });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  it('returns the grant template while the delegation is not yet verifiable', async () => {
    const { deps, ensureProvisioned } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_pending', status: 409, retryable: true });
    expect(result.ok === false && result.template?.document).toBeTruthy();
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it('re-uses the recorded delegation on replay and refuses a replay that changes the grant', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    await bootstrap.run(REQUEST);
    await bootstrap.run(REQUEST);
    expect(deps.onboardDelegation).toHaveBeenCalledTimes(1);

    const changed = await bootstrap.run({
      ...REQUEST,
      configuration: { ...GCP, source: { ...GCP.source, projectId: 'someone-elses-project' } } as never,
    });
    expect(changed).toMatchObject({ ok: false, code: 'delegation_conflict', status: 409 });
  });

  it('refuses a second workspace but lets a replay finish selecting its own', async () => {
    const own = firstWorkspaceIdentity('org-a', REQUEST.attemptKey).workspaceId;
    const replay = await createHostedFirstWorkspace(harness({ organizationWorkspaceIds: async () => [own] }).deps)
      .run(REQUEST);
    expect(replay.ok).toBe(true);

    const other = await createHostedFirstWorkspace(harness({ organizationWorkspaceIds: async () => ['ws-other'] }).deps)
      .run(REQUEST);
    expect(other).toMatchObject({ ok: false, code: 'organization_already_has_workspace', status: 409 });
  });

  it('refuses, not fails, when a concurrent attempt took the organization\'s one slot (D-397)', async () => {
    const { deps } = harness({
      createAdmission: () => ({
        ensureProvisioned: async () => {
          throw new HostedWorkspaceAdmissionError('organization already has a live workspace', 'organization_has_live_workspace');
        },
        resolveSelectable: async () => true,
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'organization_already_has_workspace', status: 409, retryable: false });
    expect(deps.selectWorkspace).not.toHaveBeenCalled();
  });

  it('does not admit a workspace that cannot be provisioned', async () => {
    const { deps, ensureProvisioned } = harness({ provisioningAvailable: () => false });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'provisioning_unavailable', status: 503 });
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("grants to the ORGANIZATION's own principal, whatever trustedPrincipal the browser sent (D-397)", async () => {
    const { deps, records } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    const recorded = records.get(`${identity.workspaceId}/${identity.connectionId}`);
    expect(recorded?.organizationId).toBe('org-a');
    expect(recorded?.configuration.source).toMatchObject({ trustedPrincipal: SERVER_PRINCIPAL });
    expect(JSON.stringify(result.ok === false && result.template)).toContain(SERVER_PRINCIPAL);
    // The browser-sent principal (the GCP fixture's) never reaches the grant.
    expect(JSON.stringify(result)).not.toContain('control-plane@papercusp');
  });

  it('gives two organizations naming the SAME customer account two different grants', async () => {
    const both = harness({
      isEnabledFor: () => true,
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const bootstrap = createHostedFirstWorkspace(both.deps);
    const a = await bootstrap.run(REQUEST);
    const b = await bootstrap.run({ ...REQUEST, organizationId: 'org-b' });
    const grantA = JSON.stringify(a.ok === false && a.template);
    const grantB = JSON.stringify(b.ok === false && b.template);
    expect(grantA).toContain(orgPrincipal('org-a'));
    expect(grantB).toContain(orgPrincipal('org-b'));
    expect(grantB).not.toContain(orgPrincipal('org-a'));
  });

  it('refuses workload identity, which every organization would share (D-397)', async () => {
    const { deps } = harness();
    const result = await createHostedFirstWorkspace(deps).run({
      ...REQUEST,
      configuration: { provider: 'gcp', source: { ...GCP.source, method: 'workload-identity' } } as never,
    });
    expect(result).toMatchObject({ ok: false, code: 'provider_not_supported', status: 422 });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  it("fails closed, before recording anything, when the organization's account cannot be prepared", async () => {
    const { deps } = harness({
      delegationOrganization: (organizationId) => ({
        organizationId,
        gcpTrustedPrincipal: async () => {
          throw new Error('gcp_workspace_host_organization_identity_project_unconfigured');
        },
        gcpPapercuspHosting: async () => {
          throw new Error('gcp_workspace_host_organization_identity_project_unconfigured');
        },
        awsTrustedPrincipal: async () => {
          throw new Error('aws_workspace_host_control_plane_account_unconfigured');
        },
        awsPapercuspHosting: async () => {
          throw new Error('aws_workspace_host_papercusp_hosting_account_unconfigured');
        },
      }),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_source_unavailable', status: 503, retryable: true });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
    // Keep the failure observable without copying an upstream exception or row data.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('delegation bind failed'), {
      code: 'provisioning_failure', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    logged.mockRestore();
  });

  it('rejects a malformed attempt key, an unsupported provider, and an AWS request without a real account', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    expect(await bootstrap.run({ ...REQUEST, attemptKey: 'short' })).toMatchObject({ code: 'invalid_request' });
    expect(
      await bootstrap.run({ ...REQUEST, configuration: { provider: 'azure' } as never }),
    ).toMatchObject({ code: 'provider_not_supported' });
    expect(
      await bootstrap.run({ ...REQUEST, configuration: { provider: 'aws' } as never }),
    ).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  it('builds a GCP spec only from a GCP delegation', () => {
    const record = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'x',
      credentialRef: 'delegation://ws-1/conn-1',
      configuration: GCP,
    }).record;
    const spec = gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record });
    expect(spec).toMatchObject({ target: 'gcp', hostId: 'host-1' });
    // D-028: a customer-delegated host is not defaulted to spot; its project and bill are the customer's.
    expect((spec as { provider: Record<string, unknown> }).provider).not.toHaveProperty('provisioningModel');
  });

  it('never attaches the controller identity to a customer-project VM (WI-10005297)', () => {
    // The delegation's serviceAccountEmail is the identity Papercusp ACTS AS. On the VM it would
    // give every agent the controller's power over the customer's project, and GCP refused the
    // create anyway (SERVICE_ACCOUNT_ACCESS_DENIED: no delegation grants actAs on it).
    const sources: HostedProviderDelegationRecord['configuration'][] = [
      GCP,
      {
        provider: 'gcp',
        source: {
          method: 'workload-identity',
          projectId: 'customer-project-1',
          projectNumber: '123456789012',
          poolId: 'papercusp',
          providerId: 'papercusp',
          serviceAccountEmail: 'papercusp-host@customer-project-1.iam.gserviceaccount.com',
          issuer: 'https://identity.papercusp.com',
          audience: 'papercusp',
          subject: 'org-a',
        },
      },
    ];
    for (const configuration of sources) {
      const record = { credentialRef: 'delegation://ws-1/conn-1', configuration } as HostedProviderDelegationRecord;
      const spec = gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record });
      expect((spec as { provider: Record<string, unknown> }).provider).not.toHaveProperty('serviceAccountEmail');
      // The controller identity still reaches the provider, as the credential it acts with.
      expect(spec.credentials).toEqual({ cloudCredentialRef: { kind: 'cloud', ref: 'delegation://ws-1/conn-1' } });
    }
  });

  it('rejects a missing or unknown hosting choice, and bring-your-own-cloud without a configuration', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    expect(await bootstrap.run({ ...REQUEST, hosting: undefined as never })).toMatchObject({ code: 'invalid_request' });
    expect(await bootstrap.run({ ...REQUEST, hosting: 'someone-else' as never })).toMatchObject({ code: 'invalid_request' });
    expect(await bootstrap.run({ ...REQUEST, configuration: undefined })).toMatchObject({ code: 'invalid_request' });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  describe('VM size from the expected agent count (WI-10006498)', () => {
    const gcpRecord = () =>
      buildHostedProviderDelegationOnboarding({
        organizationId: 'org-a',
        workspaceId: 'ws-1',
        connectionId: 'conn-1',
        label: 'x',
        credentialRef: 'delegation://ws-1/conn-1',
        configuration: GCP,
      }).record;

    it('keeps the default shape when no count is given', () => {
      expect(gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record: gcpRecord() }).size).toBe(GCP_FIRST_WORKSPACE_DEFAULTS.size);
    });

    it('picks the smallest measured shape that holds the count, at each boundary', () => {
      const sizeFor = (expectedAgents: number) =>
        gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record: gcpRecord(), expectedAgents }).size;
      expect(sizeFor(1)).toBe('e2-standard-4');
      expect(sizeFor(15)).toBe('e2-standard-4');
      expect(sizeFor(16)).toBe('e2-standard-8');
      expect(sizeFor(50)).toBe('e2-standard-8');
      expect(sizeFor(67)).toBe('e2-standard-8');
      expect(sizeFor(68)).toBe('e2-custom-16-32768');
      expect(sizeFor(158)).toBe('e2-custom-16-32768');
    });

    it('refuses a count no measured VM holds instead of provisioning one too small', () => {
      for (const expectedAgents of [0, -1, 1.5, 159, Number.NaN]) {
        expect(() => gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record: gcpRecord(), expectedAgents })).toThrow(
          HostedWorkspaceAdmissionError,
        );
      }
    });

    it('rejects a bad count at the request, before any delegation is onboarded', async () => {
      const { deps } = harness();
      const bootstrap = createHostedFirstWorkspace(deps);
      for (const expectedAgents of [0, 159, 2.5, '50' as never]) {
        expect(await bootstrap.run({ ...PAPERCUSP_REQUEST, expectedAgents })).toMatchObject({ code: 'invalid_request' });
      }
      expect(deps.onboardPapercuspHostedDelegation).not.toHaveBeenCalled();
    });

    it('provisions a Papercusp-hosted workspace on the shape its count needs', async () => {
      const { deps, resolvedSpecs } = harness();
      const result = await createHostedFirstWorkspace(deps).run({ ...PAPERCUSP_REQUEST, expectedAgents: 50 });
      expect(result).toMatchObject({ ok: true });
      expect(resolvedSpecs[0]).toMatchObject({ size: 'e2-standard-8' });
    });
  });
});

describe('funded first-workspace storage admission (P-537)', () => {
  it.each(['gcp', 'aws'] as const)('pins a small explicit DB/workspace allocation for %s pooled admission', async provider => {
    const { deps, resolvedSpecs } = harness();
    expect(await createHostedFirstWorkspace(deps).run({ ...PAPERCUSP_REQUEST, provider })).toMatchObject({ ok: true });
    expect(resolvedSpecs[0]).toMatchObject({ data: { encrypted: true, volumeGiB: 10,
      allocation: { dbGiB: 8, workspaceGiB: 2 } } });
  });
});

describe('hosted first-workspace in the customer\'s own AWS account (aws-byoc-gcp-parity D-008/D-009)', () => {
  it('builds the delegation from the account and region alone, discarding any role, principal or ExternalId the browser sent', async () => {
    const { deps, ensureProvisioned, resolvedSpecs } = harness();
    const result = await createHostedFirstWorkspace(deps).run({
      ...AWS_REQUEST,
      configuration: {
        provider: 'aws',
        accountId: AWS_ACCOUNT,
        region: 'eu-west-1',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: 'arn:aws:iam::111111111111:role/attacker',
          trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-b',
          externalIdRef: 'resolver://aws-external-id/org-b',
        },
      } as never,
    });
    expect(result).toMatchObject({ ok: true, sessionId: 'session-rotated' });
    const onboarded = vi.mocked(deps.onboardDelegation).mock.calls[0]![0];
    expect(onboarded.configuration).toEqual({
      provider: 'aws',
      accountId: AWS_ACCOUNT,
      region: 'eu-west-1',
      source: {
        environment: 'hosted',
        method: 'customer-role',
        roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/PapercuspWorkspaceHost-${AWS_ACCOUNT}`,
        trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
        externalIdRef: 'resolver://aws-external-id/org-a',
      },
    });
    // The stack is read back only through the VERIFIED delegation.
    expect(vi.mocked(deps.discoverAwsHostInfrastructure).mock.calls[0]![0]).toMatchObject({ status: 'verified' });
    expect(ensureProvisioned).toHaveBeenCalledWith(expect.objectContaining({ provider: 'aws' }));
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(resolvedSpecs[0]).toEqual({
      hostId: identity.hostId,
      target: 'aws',
      scope: { kind: 'account', id: AWS_ACCOUNT },
      region: 'eu-west-1',
      zone: 'eu-west-1a',
      size: 'm6i.xlarge',
      image: AWS_INFRA.image,
      data: { encrypted: true, volumeGiB: 100 },
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: identity.credentialRef } },
      provider: {
        vpcId: 'vpc-0aaa',
        subnetId: 'subnet-0private',
        securityGroupIds: ['sg-0noinbound'],
        instanceProfileArn: AWS_INFRA.instanceProfileArn,
        launchTemplateId: 'lt-0abc',
        kmsKeyArn: AWS_INFRA.kmsKeyArn,
      },
    });
  });

  it('defaults the region to us-east-1 and refuses an account or region it cannot use', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    expect(
      await bootstrap.run({ ...AWS_REQUEST, configuration: { provider: 'aws', accountId: AWS_ACCOUNT } as never }),
    ).toMatchObject({ ok: true });
    expect(vi.mocked(deps.onboardDelegation).mock.calls[0]![0].configuration).toMatchObject({ region: 'us-east-1' });
    for (const configuration of [
      { provider: 'aws', accountId: '12345', region: 'eu-west-1' },
      { provider: 'aws', accountId: AWS_ACCOUNT, region: 'us-gov-west-1' },
      { provider: 'aws', accountId: AWS_ACCOUNT, region: 'cn-north-1' },
      { provider: 'aws', accountId: AWS_ACCOUNT, region: 'EU-WEST-1' },
      { provider: 'aws', accountId: AWS_ACCOUNT, region: 7 },
    ]) {
      expect(await bootstrap.run({ ...AWS_REQUEST, configuration: configuration as never })).toMatchObject({
        ok: false,
        code: 'invalid_request',
        status: 400,
      });
    }
    expect(deps.onboardDelegation).toHaveBeenCalledTimes(1);
  });

  it('refuses OIDC, which every organization would share', async () => {
    const { deps } = harness();
    const result = await createHostedFirstWorkspace(deps).run({
      ...AWS_REQUEST,
      configuration: { provider: 'aws', accountId: AWS_ACCOUNT, source: { environment: 'hosted', method: 'oidc' } } as never,
    });
    expect(result).toMatchObject({ ok: false, code: 'provider_not_supported', status: 422 });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  it('returns the stack template, pinned to the chosen region, until the role can be verified', async () => {
    const { deps } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('not yet');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(AWS_REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_pending', status: 409, retryable: true });
    const template = (result as { template?: { format: string; document: Record<string, any> } }).template!;
    expect(template.format).toBe('aws-cloudformation-json');
    expect(template.document.Rules.PapercuspRegion.Assertions[0].Assert).toEqual({
      'Fn::Equals': [{ Ref: 'AWS::Region' }, 'eu-west-1'],
    });
    expect(template.document.Resources.HostLaunchTemplate.Type).toBe('AWS::EC2::LaunchTemplate');
    expect(deps.discoverAwsHostInfrastructure).not.toHaveBeenCalled();
  });

  it('treats a replay naming another region as a different grant, never a silent move', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    expect(await bootstrap.run(AWS_REQUEST)).toMatchObject({ ok: true });
    const moved = await bootstrap.run({
      ...AWS_REQUEST,
      configuration: { provider: 'aws', accountId: AWS_ACCOUNT, region: 'us-west-2' } as never,
    });
    expect(moved).toMatchObject({ ok: false, code: 'delegation_conflict' });
  });

  it('keeps answering with the same steps while the customer\'s stack is still building, admitting nothing', async () => {
    const { deps, ensureProvisioned } = harness({
      discoverAwsHostInfrastructure: vi.fn(async () => {
        throw new HostedAwsHostInfrastructurePendingError('launch-template');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(AWS_REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_pending', status: 409, retryable: true });
    expect((result as { template?: { format: string } }).template?.format).toBe('aws-cloudformation-json');
    expect(ensureProvisioned).not.toHaveBeenCalled();
    expect(deps.selectWorkspace).not.toHaveBeenCalled();
  });

  it('fails retryably, admitting nothing, when the stack cannot be read', async () => {
    const { deps, ensureProvisioned } = harness({
      discoverAwsHostInfrastructure: vi.fn(async () => {
        throw new Error('hosted_aws_host_infrastructure_ambiguous: log-canary@example.test opaque-credential-canary');
      }),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createHostedFirstWorkspace(deps).run(AWS_REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_source_unavailable', status: 503, retryable: true });
    expect(ensureProvisioned).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('AWS host infrastructure lookup failed'), {
      code: 'provisioning_failure', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/log-canary|opaque-credential/);
    logged.mockRestore();
  });

  it('builds an AWS spec only from an AWS delegation whose stack is in the same region', () => {
    const configuration: HostedProviderDelegationConfiguration = {
      provider: 'aws',
      accountId: AWS_ACCOUNT,
      region: 'eu-west-1',
      source: {
        environment: 'hosted',
        method: 'customer-role',
        roleArn: `arn:aws:iam::${AWS_ACCOUNT}:role/PapercuspWorkspaceHost-${AWS_ACCOUNT}`,
        trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
        externalIdRef: 'resolver://aws-external-id/org-a',
      },
    };
    const base = {
      organizationId: 'org-a',
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'x',
      credentialRef: 'delegation://ws-1/conn-1',
    };
    const aws = buildHostedProviderDelegationOnboarding({ ...base, configuration }).record;
    expect(awsFirstWorkspaceDesiredSpec({ hostId: 'host-1', record: aws, infrastructure: AWS_INFRA })).toMatchObject({
      target: 'aws',
      region: 'eu-west-1',
    });
    expect(() =>
      awsFirstWorkspaceDesiredSpec({ hostId: 'host-1', record: aws, infrastructure: { ...AWS_INFRA, region: 'us-east-1' } }),
    ).toThrow(HostedWorkspaceAdmissionError);
    const gcp = buildHostedProviderDelegationOnboarding({ ...base, configuration: GCP }).record;
    expect(() => awsFirstWorkspaceDesiredSpec({ hostId: 'host-1', record: gcp, infrastructure: AWS_INFRA })).toThrow(
      HostedWorkspaceAdmissionError,
    );
  });
});

describe("hosted first-workspace in Papercusp's AWS cloud (aws-byoc-gcp-parity P-015, D-017)", () => {
  const AWS_PAPERCUSP_REQUEST: HostedFirstWorkspaceRequest = { ...PAPERCUSP_REQUEST, provider: 'aws' };

  it("reserves the derived host in Papercusp's hosting account, provisions it from the hosting stack, and selects it", async () => {
    const { deps, records, resolvedSpecs, reserved, admissionOptions } = harness();
    const result = await createHostedFirstWorkspace(deps).run(AWS_PAPERCUSP_REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result).toMatchObject({ ok: true, workspaceId: identity.workspaceId, sessionId: 'session-rotated' });
    // Planned, recorded by the manager, and re-asserted once admitted: the same three as GCP.
    expect(reserved).toEqual([identity.hostId, identity.hostId, identity.hostId]);
    expect(deps.onboardPapercuspHostedDelegation).toHaveBeenCalledWith('org-a', expect.anything(), identity.hostId, 'aws');
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
    const recorded = records.get(`${identity.workspaceId}/${identity.connectionId}`);
    expect(recorded?.configuration).toEqual({
      provider: 'aws',
      accountId: AWS_HOSTING_ACCOUNT,
      region: 'us-east-1',
      source: {
        environment: 'hosted',
        method: 'customer-role',
        roleArn: `arn:aws:iam::${AWS_HOSTING_ACCOUNT}:role/PapercuspWorkspaceHost-pco-org-a`,
        trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
        externalIdRef: 'resolver://aws-external-id/org-a',
      },
      papercuspHosted: { hostId: identity.hostId },
    });
    // The hosting stack is read back through the verified hosting role, as a customer's is.
    expect(vi.mocked(deps.discoverAwsHostInfrastructure).mock.calls[0]![0]).toMatchObject({ status: 'verified' });
    expect(resolvedSpecs[0]).toMatchObject({
      hostId: identity.hostId,
      target: 'aws',
      scope: { kind: 'account', id: AWS_HOSTING_ACCOUNT },
      region: 'us-east-1',
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: identity.credentialRef } },
    });
    // D-015: set up after it is built, like every portal host.
    expect(admissionOptions).toEqual([{ pooled: true, bringUp: { requestedAgents: ['omp'] } }]);
  });

  it('defaults Papercusp hosting to GCP and refuses a cloud it does not offer', async () => {
    const gcp = harness();
    expect((await createHostedFirstWorkspace(gcp.deps).run(PAPERCUSP_REQUEST)).ok).toBe(true);
    expect(gcp.deps.onboardPapercuspHostedDelegation).toHaveBeenCalledWith('org-a', expect.anything(), expect.any(String), 'gcp');
    const azure = harness();
    const refused = await createHostedFirstWorkspace(azure.deps).run({ ...PAPERCUSP_REQUEST, provider: 'azure' as never });
    expect(refused).toMatchObject({ ok: false, code: 'invalid_request', status: 400 });
    expect(azure.reserved).toEqual([]);
  });

  it("asks the browser to retry, with nothing to apply, while Papercusp's AWS IAM or hosting stack catches up", async () => {
    const lagging = harness({
      delegationOrganization: (organizationId) => ({
        ...harness().deps.delegationOrganization(organizationId),
        awsPapercuspHosting: async () => {
          throw new HostedAwsNotReadyError('aws_workspace_host_papercusp_hosting_principal_not_visible');
        },
      }),
    });
    const waiting = await createHostedFirstWorkspace(lagging.deps).run(AWS_PAPERCUSP_REQUEST);
    expect(waiting).toMatchObject({ ok: false, code: 'papercusp_cloud_preparing', retryable: true });
    expect(waiting).not.toHaveProperty('template');

    const building = harness({
      discoverAwsHostInfrastructure: vi.fn(async () => {
        throw new HostedAwsHostInfrastructurePendingError('stack CREATE_IN_PROGRESS');
      }),
    });
    const pending = await createHostedFirstWorkspace(building.deps).run(AWS_PAPERCUSP_REQUEST);
    expect(pending).toMatchObject({ ok: false, code: 'papercusp_cloud_preparing', retryable: true });
    expect(pending).not.toHaveProperty('template');
    expect(building.ensureProvisioned).not.toHaveBeenCalled();
  });

  it('tells the browser AWS is not offered, without retrying or recording anything, on a deployment with no AWS hosting account', async () => {
    const unconfigured = harness({
      delegationOrganization: (organizationId) => ({
        ...harness().deps.delegationOrganization(organizationId),
        awsPapercuspHosting: async () => {
          throw new HostedAwsHostingUnconfiguredError();
        },
      }),
    });
    const result = await createHostedFirstWorkspace(unconfigured.deps).run(AWS_PAPERCUSP_REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'papercusp_cloud_provider_unavailable', status: 503, retryable: false });
    expect(unconfigured.deps.onboardPapercuspHostedDelegation).not.toHaveBeenCalled();
    expect(unconfigured.ensureProvisioned).not.toHaveBeenCalled();
    // GCP, the default, is unaffected by the missing AWS account.
    expect((await createHostedFirstWorkspace(unconfigured.deps).run(PAPERCUSP_REQUEST)).ok).toBe(true);
  });

  it('refuses a spec for a host other than the one the hosting role is confined to', () => {
    const record = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'AWS',
      credentialRef: 'encrypted://ws-1/cloud/conn-1',
      configuration: {
        provider: 'aws',
        accountId: AWS_HOSTING_ACCOUNT,
        region: 'us-east-1',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: `arn:aws:iam::${AWS_HOSTING_ACCOUNT}:role/PapercuspWorkspaceHost-pco-org-a`,
          trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
          externalIdRef: 'resolver://aws-external-id/org-a',
        },
        papercuspHosted: { hostId: 'host-reserved' },
      },
    }).record;
    const infrastructure = { ...AWS_INFRA, region: 'us-east-1' };
    expect(() => awsFirstWorkspaceDesiredSpec({ hostId: 'host-other', record, infrastructure }))
      .toThrow('Papercusp-hosted delegation reserves a different host');
    expect(awsFirstWorkspaceDesiredSpec({ hostId: 'host-reserved', record, infrastructure })).toMatchObject({ hostId: 'host-reserved' });
    // WI-10005389: a new Papercusp-hosted AWS host is spot, like a hosted GCP host (D-028).
    expect(
      (awsFirstWorkspaceDesiredSpec({ hostId: 'host-reserved', record, infrastructure }) as { provider: Record<string, unknown> })
        .provider.provisioningModel,
    ).toBe(PAPERCUSP_HOSTED_AWS_PROVISIONING_MODEL);
    expect(PAPERCUSP_HOSTED_AWS_PROVISIONING_MODEL).toBe('spot');
  });
});

describe("hosted first-workspace in Papercusp's cloud (D-399)", () => {
  it('reserves the derived host, provisions it in the hosting project with no machine identity, and selects it', async () => {
    const { deps, records, resolvedSpecs, reserved } = harness();
    const result = await createHostedFirstWorkspace(deps).run(PAPERCUSP_REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result).toMatchObject({ ok: true, workspaceId: identity.workspaceId, sessionId: 'session-rotated' });
    // Reserved to plan the grant, again by the manager that records it (it never takes the
    // configuration from its caller), and re-asserted once the workspace is admitted.
    expect(reserved).toEqual([identity.hostId, identity.hostId, identity.hostId]);
    expect(deps.onboardPapercuspHostedDelegation).toHaveBeenCalledWith('org-a', expect.anything(), identity.hostId, 'gcp');
    // The general entry refuses this method by design (the D-399 binder guard); it must not be used.
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
    expect(records.get(`${identity.workspaceId}/${identity.connectionId}`)?.configuration).toEqual({
      provider: 'gcp',
      source: {
        method: 'papercusp-hosted',
        projectId: HOSTING_PROJECT,
        serviceAccountEmail: SERVER_PRINCIPAL.slice('serviceAccount:'.length),
        hostId: identity.hostId,
      },
    });
    expect(resolvedSpecs[0]).toMatchObject({
      hostId: identity.hostId,
      scope: { kind: 'project', id: HOSTING_PROJECT },
      region: 'us-central1',
      zone: 'us-central1-c',
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: identity.credentialRef } },
      // D-028 (WI-10005210): a new Papercusp-hosted host is spot.
      provider: { projectId: HOSTING_PROJECT, network: { mode: 'managed' }, provisioningModel: 'spot' },
    });
    expect((resolvedSpecs[0] as { provider: Record<string, unknown> }).provider).not.toHaveProperty('serviceAccountEmail');
  });

  it('asks for the machine to be set up after it is built, with only the local-inference agent (D-401)', async () => {
    const hosted = harness();
    expect((await createHostedFirstWorkspace(hosted.deps).run(PAPERCUSP_REQUEST)).ok).toBe(true);
    expect(hosted.admissionOptions).toEqual([{ pooled: true, bringUp: { requestedAgents: ['omp'] } }]);

    // aws-byoc-gcp-parity D-015: a GCP host in the customer's own project is set up the same way;
    // a portal customer has no controller of their own, so without it the workspace would stay
    // 'provisioning' forever.
    const byoc = harness();
    expect((await createHostedFirstWorkspace(byoc.deps).run(REQUEST)).ok).toBe(true);
    expect(byoc.admissionOptions).toEqual([{ bringUp: { requestedAgents: ['omp'] } }]);

    // D-015 rule 3 (WI-10005354): an AWS host is set up the same way, over SSM as the connection's
    // own role; before it, an AWS portal workspace stayed 'provisioning' forever.
    const aws = harness();
    expect((await createHostedFirstWorkspace(aws.deps).run(AWS_REQUEST)).ok).toBe(true);
    expect(aws.admissionOptions).toEqual([{ bringUp: { requestedAgents: ['omp'] } }]);
  });

  it("ignores any configuration the browser sends: no request can steer Papercusp's cloud", async () => {
    const { deps, records, reserved } = harness();
    const result = await createHostedFirstWorkspace(deps).run({
      ...PAPERCUSP_REQUEST,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'papercusp-hosted',
          projectId: 'attacker-project',
          serviceAccountEmail: 'pco-org-b@papercusp-identity.iam.gserviceaccount.com',
          hostId: 'host-of-org-b',
        },
      },
    });
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result.ok).toBe(true);
    expect(reserved).not.toContain('host-of-org-b');
    expect(JSON.stringify(records.get(`${identity.workspaceId}/${identity.connectionId}`))).not.toMatch(
      /attacker-project|org-b/,
    );
  });

  it('asks the browser to retry, with nothing to apply, while the reservation propagates', async () => {
    const { deps, ensureProvisioned } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(PAPERCUSP_REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'papercusp_cloud_preparing', status: 409, retryable: true });
    expect(result.ok === false && result.template).toBeUndefined();
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("waits out GCP catching up with a brand-new organization's account, and still fails on a real refusal", async () => {
    const organization = (error: Error) => (organizationId: string) => ({
      organizationId,
      gcpTrustedPrincipal: async () => 'serviceAccount:unused@x.iam.gserviceaccount.com',
      gcpPapercuspHosting: async () => {
        throw error;
      },
      awsTrustedPrincipal: async () => ({ principalArn: 'unused', externalIdRef: 'unused' }),
      awsPapercuspHosting: async () => {
        throw error;
      },
    });
    const lagging = harness({
      delegationOrganization: organization(new HostedGcpNotReadyError('policy_write_failed:400:Service account pco-x does not exist.')),
    });
    const waiting = await createHostedFirstWorkspace(lagging.deps).run(PAPERCUSP_REQUEST);
    expect(waiting).toMatchObject({ ok: false, code: 'papercusp_cloud_preparing', status: 409, retryable: true });
    expect(lagging.deps.onboardDelegation).not.toHaveBeenCalled();

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = harness({ delegationOrganization: organization(new Error('policy_write_failed:403:denied')) });
    const failed = await createHostedFirstWorkspace(refused.deps).run(PAPERCUSP_REQUEST);
    expect(failed).toMatchObject({ ok: false, code: 'delegation_source_unavailable', status: 503, retryable: true });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('refuses a spec for a host other than the one the delegation reserves', () => {
    const record = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'x',
      credentialRef: 'delegation://ws-1/conn-1',
      configuration: {
        provider: 'gcp',
        source: {
          method: 'papercusp-hosted',
          projectId: HOSTING_PROJECT,
          serviceAccountEmail: 'pco-a@papercusp-identity.iam.gserviceaccount.com',
          hostId: 'host-1',
        },
      },
    }).record;
    expect(() => gcpFirstWorkspaceDesiredSpec({ hostId: 'host-2', record })).toThrow(HostedWorkspaceAdmissionError);
    expect(gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record })).toMatchObject({ hostId: 'host-1' });
  });
});

describe('selecting the organization\'s existing workspace after sign-in', () => {
  const SELECTION = { organizationId: 'org-a', sessionId: 'session-1', sessionVersion: 3 };

  it("rotates the session onto the organization's one live workspace", async () => {
    const { deps } = harness({ organizationWorkspaceIds: async (organizationId) => (organizationId === 'org-a' ? ['ws-own'] : []) });

    const result = await createHostedFirstWorkspace(deps).selectExisting(SELECTION);

    expect(result).toEqual({
      ok: true,
      workspaceId: 'ws-own',
      sessionId: 'session-rotated',
      sessionExpiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    expect(deps.selectWorkspace).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceId: 'ws-own',
      expectedPermissionVersion: 3,
    });
  });

  it('answers no_workspace, selecting nothing, for an organization without one', async () => {
    const { deps } = harness();

    expect(await createHostedFirstWorkspace(deps).selectExisting(SELECTION)).toMatchObject({ ok: false, code: 'no_workspace' });
    expect(deps.selectWorkspace).not.toHaveBeenCalled();
  });

  it('does not guess when more than one live workspace is somehow present', async () => {
    const { deps } = harness({ organizationWorkspaceIds: async () => ['ws-1', 'ws-2'] });

    expect(await createHostedFirstWorkspace(deps).selectExisting(SELECTION)).toMatchObject({ ok: false, code: 'no_workspace' });
    expect(deps.selectWorkspace).not.toHaveBeenCalled();
  });

  it('reports a session that moved on as retryable', async () => {
    const { deps } = harness({
      organizationWorkspaceIds: async () => ['ws-own'],
      selectWorkspace: vi.fn(async () => null),
    });

    expect(await createHostedFirstWorkspace(deps).selectExisting(SELECTION)).toEqual({
      ok: false,
      code: 'session_selection_failed',
      status: 409,
      retryable: true,
    });
  });
});

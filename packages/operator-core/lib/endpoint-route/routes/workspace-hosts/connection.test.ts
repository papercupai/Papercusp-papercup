import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';
import {
  createWorkspaceHostConnectionRoute,
  inspectWorkspaceHostConnection,
  workspaceHostConnectionId,
  type WorkspaceHostConnectionRouteDependencies,
} from './connection';
import {
  AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS,
  type AwsWorkspaceHostPreflightClient,
} from '../../../workspace-host/aws-connection';
import type { StoredWorkspaceHostConnection } from '../../../workspace-host/observability-store';
import {
  inspectAwsWorkspaceHostConnection,
  type AwsConnectionInspectionClient,
} from '../../../workspace-host/aws-connection-inspection';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

function successfulInspection() {
  return {
    validation: {
      ok: true,
      checkedAt: '2026-08-28T00:00:00.000Z',
      identity: 'owner@example.test',
      warnings: [] as string[],
      errors: [] as string[],
    },
    scopes: [{ kind: 'project', id: 'paper-prod', label: 'paper-prod' }],
    regions: [
      { id: 'us-central1', label: 'Iowa', available: true, zones: ['us-central1-a'] },
      { id: 'offline', label: 'Offline', available: false },
    ],
    sizes: [
      { id: 'e2-small', label: 'e2-small', cpuCount: 2, memoryMiB: 4096, available: true },
      { id: 'old', label: 'old', cpuCount: 1, memoryMiB: 1024, available: false },
    ],
    images: [
      { id: 'projects/images/global/images/papercusp-v1', label: 'Papercusp v1', signed: true },
      { id: 'old-image', label: 'Old', signed: true, deprecated: true },
    ],
  };
}

function harness() {
  const upsertConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['upsertConnection']>(async () => {});
  const inspectConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['inspectConnection']>(async () =>
    successfulInspection(),
  );
  const readConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['readConnection']>(async () => null);
  const dependencies: WorkspaceHostConnectionRouteDependencies = {
    activeWorkspaceId: () => 'ws-1',
    readConnection,
    upsertConnection,
    inspectConnection,
  };
  return { dependencies, inspectConnection, readConnection, upsertConnection };
}

async function post(dependencies: WorkspaceHostConnectionRouteDependencies, body: unknown): Promise<Response> {
  return createWorkspaceHostConnectionRoute(dependencies).handler(
    new Request('http://operator.test/api/workspace-hosts/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('POST /workspace-hosts/connection', () => {
  it('validates and persists the supported GCP connection with normalized catalog rows', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      connectionId: 'gcp:production-gcp',
      status: 'connected',
    });
    expect(inspectConnection).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      connectionId: 'gcp:production-gcp',
      connection: {
        target: 'gcp',
        cloudCredentialRef: { kind: 'cloud', ref: 'adc://default' },
        scope: { kind: 'project', id: 'paper-prod' },
        provider: {
          projectId: 'paper-prod',
          serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
        },
      },
    });
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        id: 'gcp:production-gcp',
        credentialRef: 'adc://default',
        status: 'connected',
        authenticatedIdentity: 'owner@example.test',
        scopes: [{ id: 'paper-prod', label: 'paper-prod' }],
        regions: [{ id: 'us-central1', label: 'Iowa', zones: ['us-central1-a'] }],
        sizes: [{ id: 'e2-small', label: 'e2-small', vcpu: 2, memoryGiB: 4 }],
        images: [{ id: 'projects/images/global/images/papercusp-v1', label: 'Papercusp v1' }],
        networks: [{ id: 'managed', label: 'Papercusp-managed private network' }],
      }),
    );
  });

  it('validates and persists a typed non-secret Cloud Billing export descriptor', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    const billingExport = {
      schemaVersion: 'gcp-billing-export-v1',
      projectId: 'paper-prod',
      datasetId: 'cloud_billing_export',
      tableId: 'gcp_billing_export_v1_01A2B3_C4D5E6_789ABC',
      location: 'US',
      labelKey: 'papercusp_run_id',
      maximumBytesBilled: '1000000000',
    };

    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
      billingExport,
    });

    expect(response.status).toBe(200);
    expect(inspectConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          provider: expect.objectContaining({ billingExport }),
        }),
      }),
    );
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: expect.objectContaining({ billingExport }) }),
    );
  });

  it('rejects unsafe billing-export identifiers and unbounded query cost before provider inspection', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    const base = {
      schemaVersion: 'gcp-billing-export-v1',
      projectId: 'paper-prod',
      datasetId: 'cloud_billing_export',
      tableId: 'gcp_billing_export_v1_01A2B3_C4D5E6_789ABC',
      labelKey: 'papercusp_run_id',
      maximumBytesBilled: '1000000000',
    };
    const connect = (billingExport: unknown) =>
      post(dependencies, {
        action: 'connect',
        target: 'gcp',
        label: 'Production GCP',
        credentialRef: 'adc://default',
        projectId: 'paper-prod',
        serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
        billingExport,
      });

    await expect(connect({ ...base, tableId: 'table`; SELECT secret' })).resolves.toMatchObject({ status: 400 });
    await expect(connect({ ...base, maximumBytesBilled: '10000000001' })).resolves.toMatchObject({ status: 400 });
    expect(inspectConnection).not.toHaveBeenCalled();
    expect(upsertConnection).not.toHaveBeenCalled();
  });

  it('fails closed when a nominally successful validation proves no authenticated principal', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    inspectConnection.mockResolvedValueOnce({
      ...successfulInspection(),
      validation: {
        ok: true,
        checkedAt: '2026-08-28T00:00:00.000Z',
        warnings: [],
        errors: [],
      },
    });

    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
    });

    expect(response.status).toBe(422);
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'invalid',
        statusDetail: 'Provider validation did not return an authenticated identity.',
      }),
    );
  });

  it('admits the default Compute service-account identity used by GCP projects', async () => {
    const { dependencies, inspectConnection } = harness();
    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'BYOC Canary GCP',
      credentialRef: 'gcloud://active-user',
      projectId: 'active-alcove-504205-q3',
      serviceAccountEmail: '243118361453-compute@developer.gserviceaccount.com',
    });

    expect(response.status).toBe(200);
    expect(inspectConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          provider: expect.objectContaining({
            serviceAccountEmail: '243118361453-compute@developer.gserviceaccount.com',
          }),
        }),
      }),
    );
  });

  it('refreshes an existing connection from its stored raw reference instead of the masked UI row', async () => {
    const { dependencies, readConnection, inspectConnection, upsertConnection } = harness();
    readConnection.mockResolvedValueOnce({
      id: 'gcp:production-gcp',
      label: 'Production GCP',
      target: 'gcp',
      status: 'connected',
      connection: {
        target: 'gcp',
        cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
        provider: {
          projectId: 'paper-prod',
          serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
        },
      },
    });

    expect(
      await post(dependencies, {
        action: 'validate-connection',
        connectionId: 'gcp:production-gcp',
      }),
    ).toMatchObject({ status: 200 });
    expect(inspectConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
        }),
      }),
    );
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Production GCP', credentialRef: 'gcloud://active-user' }),
    );
  });

  it('persists an invalid status and returns typed recovery when validation fails', async () => {
    const { dependencies, inspectConnection, upsertConnection } = harness();
    inspectConnection.mockResolvedValueOnce({
      validation: {
        ok: false,
        checkedAt: '2026-08-28T00:00:00.000Z',
        warnings: [],
        errors: ['Project permission is missing.'],
      },
      scopes: [],
      regions: [],
      sizes: [],
      images: [],
    });

    const response = await post(dependencies, {
      action: 'connect',
      target: 'gcp',
      label: 'Production GCP',
      credentialRef: 'adc://default',
      projectId: 'paper-prod',
      serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com',
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'Project permission is missing.',
      problems: ['Project permission is missing.'],
    });
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'invalid', statusDetail: 'Project permission is missing.' }),
    );
  });

  it('rejects unsupported targets and malformed GCP identity before provider calls', async () => {
    const first = harness();
    expect(
      await post(first.dependencies, {
        action: 'connect',
        target: 'azure',
        label: 'Azure',
        credentialRef: 'resolver://azure',
      }),
    ).toMatchObject({ status: 501 });
    expect(first.inspectConnection).not.toHaveBeenCalled();

    const second = harness();
    expect(
      await post(second.dependencies, {
        action: 'connect',
        target: 'gcp',
        label: 'GCP',
        credentialRef: 'adc://default',
        projectId: '../bad',
        serviceAccountEmail: 'not-an-email',
      }),
    ).toMatchObject({ status: 400 });
    expect(second.inspectConnection).not.toHaveBeenCalled();
  });

  it('derives a stable retry-safe connection id from the target and label', () => {
    expect(workspaceHostConnectionId('gcp', '  Production / GCP  ')).toBe('gcp:production-gcp');
  });

  it('updates a stored GCP connection under the same id, keeping fields the update does not name', async () => {
    const { dependencies, inspectConnection, readConnection, upsertConnection } = harness();
    readConnection.mockResolvedValueOnce({
      id: 'gcp:production-gcp',
      target: 'gcp',
      label: 'Production GCP',
      status: 'connected',
      connection: {
        target: 'gcp',
        cloudCredentialRef: { kind: 'cloud', ref: 'adc://default' },
        scope: { kind: 'project', id: 'paper-prod' },
        provider: { projectId: 'paper-prod', serviceAccountEmail: 'papercusp-host@paper-prod.iam.gserviceaccount.com' },
      },
    });
    const response = await post(dependencies, {
      action: 'update',
      connectionId: 'gcp:production-gcp',
      label: 'Renamed GCP',
      serviceAccountEmail: 'other-host@paper-prod.iam.gserviceaccount.com',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connectionId: 'gcp:production-gcp',
      message: 'Renamed GCP connection updated and validated',
    });
    expect(inspectConnection.mock.calls[0]?.[0].connection).toEqual({
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'adc://default' },
      scope: { kind: 'project', id: 'paper-prod' },
      provider: { projectId: 'paper-prod', serviceAccountEmail: 'other-host@paper-prod.iam.gserviceaccount.com' },
    });
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gcp:production-gcp', label: 'Renamed GCP', status: 'connected' }),
    );
  });
});

// --- AWS (aws-byoc-gcp-parity-2026-10-01 P-004) ------------------------------------------------

const AWS_ACCOUNT = '123456789012';
const AWS_SUBNET = 'subnet-0123456789abcdef0';
const AWS_IMAGE = 'ami-0123456789abcdef0';
const AWS_ROLE = `arn:aws:iam::${AWS_ACCOUNT}:role/PapercuspWorkspaceHost`;
const AWS_CHECKED_AT = '2026-10-01T00:00:00.000Z';
const AWS_IDENTITY = `arn:aws:sts::${AWS_ACCOUNT}:assumed-role/PapercuspWorkspaceHost/papercusp`;

function awsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'connect',
    target: 'aws',
    label: 'Production AWS',
    credentialRef: 'resolver://aws/prod',
    accountId: AWS_ACCOUNT,
    region: 'us-east-2',
    subnetId: AWS_SUBNET,
    imageId: AWS_IMAGE,
    kmsKeyArn: `arn:aws:kms:us-east-2:${AWS_ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`,
    instanceProfileArn: `arn:aws:iam::${AWS_ACCOUNT}:instance-profile/papercusp-workspace`,
    credentialSource: { environment: 'local', method: 'assume-role', roleArn: AWS_ROLE },
    ...overrides,
  };
}

/** Evidence for a fully healthy account; each override turns one preflight probe red. */
function awsPreflightClient(overrides: Partial<AwsWorkspaceHostPreflightClient> = {}): AwsWorkspaceHostPreflightClient {
  return {
    getCallerIdentity: async () => ({
      accountId: AWS_ACCOUNT,
      arn: AWS_IDENTITY,
      userId: 'AROAEXAMPLE:papercusp',
      evidenceRef: 'aws://sts/1',
    }),
    describeRegion: async (region) => ({ id: region, partition: 'aws', available: true, evidenceRef: 'aws://region' }),
    describeSubnet: async (id) => ({
      id,
      region: 'us-east-2',
      availabilityZone: 'us-east-2a',
      vpcId: 'vpc-0123456789abcdef0',
      available: true,
      evidenceRef: 'aws://subnet',
    }),
    describeImage: async (id) => ({
      id,
      ownerId: AWS_ACCOUNT,
      state: 'available',
      architecture: 'x86_64',
      launchAllowed: true,
      evidenceRef: 'aws://image',
    }),
    describeKmsKey: async (arn) => ({
      arn,
      partition: 'aws',
      region: 'us-east-2',
      enabled: true,
      symmetric: true,
      evidenceRef: 'aws://kms',
    }),
    evaluatePermissions: async ({ actions, imageKeyActions }) =>
      [...actions, ...imageKeyActions].map((action) => ({ action, allowed: true, evidenceRef: `aws://iam/${action}` })),
    getServiceQuota: async (requirement) => ({ ...requirement, value: 64, evidenceRef: 'aws://quota' }),
    ...overrides,
  };
}

function awsInspectionClient(preflight: AwsWorkspaceHostPreflightClient): AwsConnectionInspectionClient {
  return {
    preflight: () => preflight,
    listScopes: async () => [{ kind: 'account', id: AWS_ACCOUNT, label: `AWS account ${AWS_ACCOUNT}` }],
    listRegions: async () => [{ id: 'us-east-2', label: 'us-east-2', available: true, zones: ['us-east-2a'] }],
    listSizes: async () => [{ id: 't3.large', label: 't3.large', cpuCount: 2, memoryMiB: 8192, available: true }],
    listImages: async () => [{ id: AWS_IMAGE, label: 'Papercusp host', signed: true }],
  };
}

/** Route dependencies whose inspection is the REAL AWS preflight over a fake SDK client. */
function awsHarness(preflight: AwsWorkspaceHostPreflightClient = awsPreflightClient()) {
  const base = harness();
  const inspectConnection = vi.fn<WorkspaceHostConnectionRouteDependencies['inspectConnection']>((input) =>
    inspectAwsWorkspaceHostConnection({ connection: input.connection, now: () => AWS_CHECKED_AT }, () =>
      awsInspectionClient(preflight),
    ),
  );
  return { ...base, inspectConnection, dependencies: { ...base.dependencies, inspectConnection } };
}

describe('POST /workspace-hosts/connection — AWS target', () => {
  it('retains desktop launch metadata through admission and validation', async () => {
    const resources = { vpcId: 'vpc-01234567', securityGroupIds: ['sg-01234567', 'sg-01234567'], launchTemplateId: 'lt-01234567' };
    const h = awsHarness();
    expect((await post(h.dependencies, awsBody(resources))).status).toBe(200);
    const admitted = h.upsertConnection.mock.calls[0]![0];
    expect(admitted.provider).toMatchObject({ ...resources, securityGroupIds: ['sg-01234567'] });
    h.readConnection.mockResolvedValue({ ...admitted, connection: { target: 'aws', scope: { kind: 'account', id: AWS_ACCOUNT },
      cloudCredentialRef: { kind: 'cloud', ref: admitted.credentialRef }, provider: admitted.provider } } as StoredWorkspaceHostConnection);
    expect((await post(h.dependencies, { action: 'validate-connection', connectionId: admitted.id })).status).toBe(200);
    expect(h.upsertConnection.mock.calls[1]![0].provider).toMatchObject({ ...resources, securityGroupIds: ['sg-01234567'] });
  });

  it.each([
    ['vpcId', 'not-a-vpc'], ['launchTemplateId', 'not-a-template'],
    ['securityGroupIds', []], ['securityGroupIds', ['sg-01234567', 'public']],
  ])('refuses malformed desktop launch metadata %s', async (field, value) => {
    const h = awsHarness();
    const response = await post(h.dependencies, awsBody({ [field]: value }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: `invalid AWS ${field}` });
    expect(h.inspectConnection).not.toHaveBeenCalled();
    expect(h.upsertConnection).not.toHaveBeenCalled();
  });

  it('AWSP-P-004-connection-stored: stores an AWS connection with its AWS preflight verdict', async () => {
    const { dependencies, upsertConnection } = awsHarness();
    const response = await post(dependencies, awsBody());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'connected',
      connectionId: 'aws:production-aws',
      authenticatedIdentity: AWS_IDENTITY,
    });
    expect(upsertConnection).toHaveBeenCalledTimes(1);
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        id: 'aws:production-aws',
        target: 'aws',
        credentialRef: 'resolver://aws/prod',
        status: 'connected',
        authenticatedIdentity: AWS_IDENTITY,
        lastValidatedAt: AWS_CHECKED_AT,
        provider: expect.objectContaining({
          preflightVersion: 'aws-workspace-host-preflight-v1',
          partition: 'aws',
          region: 'us-east-2',
          subnetId: AWS_SUBNET,
          credentialSource: { environment: 'local', method: 'assume-role', roleArn: AWS_ROLE },
        }),
        scopes: [{ id: AWS_ACCOUNT, label: `AWS account ${AWS_ACCOUNT}` }],
        regions: [{ id: 'us-east-2', label: 'us-east-2', zones: ['us-east-2a'] }],
        sizes: [{ id: 't3.large', label: 't3.large', vcpu: 2, memoryGiB: 8 }],
        networks: [{ id: AWS_SUBNET, label: `Subnet ${AWS_SUBNET}` }],
      }),
    );
  });

  it('AWSP-P-004-bad-account-refused: refuses a malformed account ID with a named validation error', async () => {
    for (const accountId of ['12345', '1234567890123', '12345678901a', '']) {
      const { dependencies, inspectConnection, upsertConnection } = awsHarness();
      const response = await post(dependencies, awsBody({ accountId }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'invalid AWS accountId' });
      expect(inspectConnection).not.toHaveBeenCalled();
      expect(upsertConnection).not.toHaveBeenCalled();
    }
  });

  it('AUTO-BAR-R-3-P-004: stores status reflecting preflight, and refuses malformed account IDs, role ARNs and regions by name', async () => {
    // A well-formed connection whose preflight finds RunInstances denied is stored, as invalid,
    // with the preflight's own diagnosis, and the caller gets the typed 422 recovery.
    const denied = awsHarness(
      awsPreflightClient({
        evaluatePermissions: async ({ actions, imageKeyActions }) =>
          [...actions, ...imageKeyActions].map((action) => ({
            action,
            allowed: action !== 'ec2:RunInstances',
            evidenceRef: `aws://iam/${action}`,
          })),
      }),
    );
    const deniedResponse = await post(denied.dependencies, awsBody());
    expect(deniedResponse.status).toBe(422);
    const deniedBody = (await deniedResponse.json()) as { problems: string[] };
    expect(deniedBody.problems.join(' ')).toContain('ec2:RunInstances');
    expect(denied.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'aws:production-aws',
        status: 'invalid',
        statusDetail: expect.stringContaining('ec2:RunInstances'),
        scopes: [],
        networks: [],
      }),
    );

    // The same request against a healthy account is stored as connected.
    const healthy = awsHarness();
    expect((await post(healthy.dependencies, awsBody())).status).toBe(200);
    expect(healthy.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected' }));

    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ accountId: '42' }, 'invalid AWS accountId'],
      [
        { credentialSource: { environment: 'local', method: 'assume-role', roleArn: 'arn:aws:iam::42:role/x' } },
        'invalid AWS roleArn',
      ],
      [
        { credentialSource: { environment: 'local', method: 'assume-role', roleArn: 'not-an-arn' } },
        'invalid AWS roleArn',
      ],
      [{ region: 'US East (Ohio)' }, 'invalid AWS region'],
      [{ region: 'us-east' }, 'invalid AWS region'],
    ];
    for (const [overrides, error] of malformed) {
      const { dependencies, inspectConnection, upsertConnection } = awsHarness();
      const response = await post(dependencies, awsBody(overrides));
      expect(response.status, error).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false, error });
      expect(inspectConnection).not.toHaveBeenCalled();
      expect(upsertConnection).not.toHaveBeenCalled();
    }
  });

  it('refuses an AWS connection when AMI image-key permissions were not evaluated', async () => {
    const h = awsHarness(
      awsPreflightClient({
        evaluatePermissions: async ({ actions }) =>
          actions.map((action) => ({ action, allowed: true, evidenceRef: `aws://iam/${action}` })),
      }),
    );
    const response = await post(h.dependencies, awsBody());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { problems: string[] };
    for (const action of AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS) {
      expect(body.problems.join(' ')).toContain(`Permission '${action}' was not evaluated.`);
    }
    expect(h.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid' }));
  });

  it('refuses a role in a different account from the connection before any provider call', async () => {
    const { dependencies, inspectConnection } = awsHarness();
    const response = await post(
      dependencies,
      awsBody({ credentialSource: { environment: 'local', method: 'assume-role', roleArn: 'arn:aws:iam::210987654321:role/x' } }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid AWS connection',
      problems: ['Selected accountId must match the configured AWS role account'],
    });
    expect(inspectConnection).not.toHaveBeenCalled();
  });

  it('refuses static secret material in the credential source without echoing it', async () => {
    const { dependencies, inspectConnection } = awsHarness();
    const response = await post(
      dependencies,
      awsBody({
        credentialSource: { environment: 'local', method: 'default-chain', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG' },
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('invalid AWS credentialSource');
    expect(text).not.toContain('wJalrXUtnFEMI');
    expect(inspectConnection).not.toHaveBeenCalled();
  });

  it('stores a hosted customer-role connection as invalid on the local control plane, naming why', async () => {
    const base = harness();
    const dependencies = { ...base.dependencies, inspectConnection: inspectWorkspaceHostConnection };
    const response = await post(
      dependencies,
      awsBody({
        credentialSource: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: AWS_ROLE,
          trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/org-1',
          externalIdRef: 'org-external-id://org-1',
        },
      }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Hosted credential references are unavailable on the local control plane.',
    });
    expect(base.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid' }));
  });

  it('updates a stored AWS connection under the same id, re-running preflight with the merged fields', async () => {
    const { dependencies, inspectConnection, readConnection, upsertConnection } = awsHarness();
    const stored = await (async () => {
      const seed = awsHarness();
      await post(seed.dependencies, awsBody());
      return seed.upsertConnection.mock.calls[0]![0];
    })();
    readConnection.mockResolvedValue({
      id: stored.id,
      target: 'aws',
      label: stored.label,
      status: 'connected',
      connection: {
        target: 'aws',
        cloudCredentialRef: { kind: 'cloud', ref: stored.credentialRef },
        scope: { kind: 'account', id: AWS_ACCOUNT },
        provider: stored.provider,
      },
    });

    const newSubnet = 'subnet-0fedcba9876543210';
    const response = await post(dependencies, { action: 'update', connectionId: 'aws:production-aws', subnetId: newSubnet });
    expect(response.status).toBe(200);
    const admitted = inspectConnection.mock.calls[0]![0].connection;
    expect(admitted.provider).toMatchObject({ subnetId: newSubnet, region: 'us-east-2', imageId: AWS_IMAGE });
    expect(admitted.provider?.credentialSource).toEqual({ environment: 'local', method: 'assume-role', roleArn: AWS_ROLE });
    expect(upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aws:production-aws', networks: [{ id: newSubnet, label: `Subnet ${newSubnet}` }] }),
    );

    // A target change is never an update; the stored connection is left untouched.
    upsertConnection.mockClear();
    const moved = await post(dependencies, { action: 'update', connectionId: 'aws:production-aws', target: 'gcp' });
    expect(moved.status).toBe(400);
    expect(upsertConnection).not.toHaveBeenCalled();

    // A malformed override is refused by the same named validation as connect.
    const bad = await post(dependencies, { action: 'update', connectionId: 'aws:production-aws', region: 'nowhere' });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: 'invalid AWS region' });
  });
});

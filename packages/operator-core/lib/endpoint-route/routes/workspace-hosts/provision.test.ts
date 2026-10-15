import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION } from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import { createWorkspaceHostProvisionRoute, type WorkspaceHostProvisionRouteDependencies } from './provision';
import { WorkspaceHostProvisioningConflictError } from '../../../dbos/workspace-host-provision-workflow';
import {
  WORKSPACE_HOST_FENCE_REFUSED_CODE,
  WorkspaceHostControllerFenceError,
  WorkspaceHostIdSpentError,
} from '../../../workspace-host/observability-store';
import {
  WORKSPACE_HOST_PROVISION_DEFAULT_REVISION,
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
} from '../../../workspace-host/provisioning-runner';
import type { WorkspaceHostRequestForwarder } from '../../../workspace-host/controller-forwarding';

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
};

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

function harness() {
  const startProvisioning = vi.fn<WorkspaceHostProvisionRouteDependencies['startProvisioning']>(async () => ({
    status: 'succeeded' as const,
    operationId: 'op-1',
    hostId: 'host-1',
    plan: {
      planId: 'plan-1',
      operationId: 'op-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: '2026-08-25T00:00:00Z',
      steps: [],
      warnings: [],
    },
    checkpoints: [],
  }));
  const readConnection = vi.fn<WorkspaceHostProvisionRouteDependencies['readConnection']>(async () => ({
    id: 'connection-1',
    target: 'gcp',
    status: 'connected' as const,
    connection: {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' },
      provider: {
        projectId: 'project-1',
        serviceAccountEmail: 'papercusp-host@project-1.iam.gserviceaccount.com',
      },
    },
  }));
  const listLiveHostIds = vi.fn<NonNullable<WorkspaceHostProvisionRouteDependencies['listLiveHostIds']>>(
    async () => [],
  );
  const readSpentHostId = vi.fn<NonNullable<WorkspaceHostProvisionRouteDependencies['readSpentHostId']>>(
    async () => null,
  );
  const dependencies: WorkspaceHostProvisionRouteDependencies = {
    activeWorkspaceId: () => 'ws-1',
    provisioningAvailable: () => true,
    readConnection,
    listLiveHostIds,
    readSpentHostId,
    startProvisioning,
  };
  return { dependencies, readConnection, listLiveHostIds, readSpentHostId, startProvisioning };
}

/** A hosted (one-per-sign-up) AWS connection: its `delegation://` ref is what makes it capped. */
function hostedAwsConnection() {
  return {
    id: 'connection-1',
    target: 'aws',
    status: 'connected' as const,
    connection: {
      target: 'aws',
      cloudCredentialRef: { kind: 'cloud' as const, ref: 'delegation://customer-ws/connection-1' },
      provider: { accountId: '413781344298', region: 'us-east-2' },
    },
  };
}

const awsDesired = {
  ...desired,
  target: 'aws',
  scope: { kind: 'account', id: '413781344298' },
  region: 'us-east-2',
  zone: 'us-east-2a',
  size: 't3.medium',
  image: { id: 'ami-0123456789abcdef0' },
} as WorkspaceHostDesiredSpec;

async function post(dependencies: WorkspaceHostProvisionRouteDependencies, body: unknown): Promise<Response> {
  const route = createWorkspaceHostProvisionRoute(dependencies);
  return route.handler(
    new Request('http://operator.test/api/workspace-hosts/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /workspace-hosts/provision', () => {
  it('requires pre-run economics and passes admitted evidence into the durable workflow', async () => {
    const { dependencies, startProvisioning } = harness();
    const body = {
      connectionId: 'connection-1',
      name: 'Canary',
      desired,
      canary: { runId: 'run-1' },
      bootstrapReleaseOverride: {
        manifestPath: '/caller-controlled/manifest.json',
        migrationId: '9999',
      },
    };
    const refused = await post(dependencies, body);
    expect(refused.status).toBe(422);
    expect(startProvisioning).not.toHaveBeenCalled();
    const canary = {
      runId: 'run-1', workspaceId: 'ws-1', teardownDeadlineAt: '2099-01-01T00:00:00Z',
      budgetEvidenceRef: 'gcp://billing/budgets/run-1',
      preRunZeroBaseline: { cents: 0, observedAt: '2020-01-01T00:00:00Z', providerEvidenceRef: 'gcp://billing/zero' },
      contractApproval: {
        status: 'approved', suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        approvedBy: 'test-reviewer', approvedAt: '2020-01-01T00:00:00Z', reportRef: 'report://gcp/contract-1',
      },
    };
    expect((await post(dependencies, { ...body, canary })).status).toBe(201);
    expect(startProvisioning).toHaveBeenCalledWith(expect.objectContaining({ canary }));
    expect(startProvisioning.mock.calls[0]?.[0]).not.toHaveProperty('bootstrapReleaseOverride');
  });

  it('rejects malformed request identity before reading durable state', async () => {
    const { dependencies, readConnection } = harness();
    const response = await post(dependencies, { connectionId: '../bad', name: '', desired: {} });
    expect(response.status).toBe(400);
    expect(readConnection).not.toHaveBeenCalled();
  });

  it('fails with a typed 503 before durable reads when the DBOS executor is unavailable', async () => {
    const { dependencies, readConnection, startProvisioning } = harness();
    dependencies.provisioningAvailable = () => false;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async () => null);
    dependencies.forwardRequest = forwardRequest;

    const response = await post(dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workspace-host provisioning workflow is unavailable on this operator',
    });
    expect(forwardRequest).toHaveBeenCalledWith('/api/workspace-hosts/provision', {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(readConnection).not.toHaveBeenCalled();
    expect(startProvisioning).not.toHaveBeenCalled();
  });

  it('forwards a valid request to the DBOS controller and returns its response when local DBOS is unavailable', async () => {
    const { dependencies, readConnection, startProvisioning } = harness();
    dependencies.provisioningAvailable = () => false;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async (path, body) => {
      expect(path).toBe('/api/workspace-hosts/provision');
      expect(body).toEqual({ connectionId: 'connection-1', name: 'Host', desired, operationId: 'op-forward-1' });
      return Response.json(
        { ok: true, status: 'succeeded', operationId: 'op-forward-1', hostId: 'host-1' },
        { status: 201 },
      );
    });
    dependencies.forwardRequest = forwardRequest;

    const requestBody = {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
      operationId: 'op-forward-1',
    };
    const response = await post(dependencies, requestBody);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-forward-1',
      hostId: 'host-1',
    });
    expect(forwardRequest).toHaveBeenCalledOnce();
    expect(readConnection).not.toHaveBeenCalled();
    expect(startProvisioning).not.toHaveBeenCalled();
  });

  it('distinguishes a missing connection from one that is not ready', async () => {
    const missing = harness();
    missing.readConnection.mockResolvedValueOnce(null);
    expect(await post(missing.dependencies, { connectionId: 'connection-1', name: 'Host', desired })).toMatchObject({
      status: 404,
    });

    const degraded = harness();
    degraded.readConnection.mockResolvedValueOnce({
      id: 'connection-1',
      target: 'gcp',
      status: 'degraded',
      statusDetail: 'ADC refresh required',
      connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
    });
    const response = await post(degraded.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('composes the selected connection with desired scope and returns 201 on completion', async () => {
    const { dependencies, startProvisioning } = harness();
    const response = await post(dependencies, {
      connectionId: 'connection-1',
      name: 'Research host',
      desired: {
        ...desired,
        credentials: {
          cloudCredentialRef: { kind: 'cloud', ref: 'masked://configured' },
        },
        provider: { network: { mode: 'managed' }, zone: 'client-value-must-not-replace-provider-config' },
      },
      operationId: 'op-1',
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
    });
    expect(startProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        connectionId: 'connection-1',
        operationId: 'op-1',
        desired: {
          ...desired,
          credentials: {
            cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
          },
          provider: {
            network: { mode: 'managed' },
            zone: 'client-value-must-not-replace-provider-config',
            projectId: 'project-1',
            serviceAccountEmail: 'papercusp-host@project-1.iam.gserviceaccount.com',
          },
        },
        connection: expect.objectContaining({
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
          scope: { kind: 'project', id: 'project-1' },
          provider: {
            projectId: 'project-1',
            serviceAccountEmail: 'papercusp-host@project-1.iam.gserviceaccount.com',
          },
        }),
      }),
    );
  });

  it('returns a resumable 202 receipt without hiding retry timing', async () => {
    const { dependencies, startProvisioning } = harness();
    startProvisioning.mockResolvedValueOnce({
      status: 'in-progress',
      operationId: 'op-1',
      hostId: 'host-1',
      plan: {
        planId: 'plan-1',
        operationId: 'op-1',
        target: 'gcp',
        hostId: 'host-1',
        generatedAt: '2026-08-25T00:00:00Z',
        steps: [],
        warnings: [],
      },
      checkpoints: [{ logicalKey: 'create-instance', state: 'retry-wait', attempts: 1 }],
      retryAfterMs: 7_500,
    });

    const response = await post(dependencies, { connectionId: 'connection-1', name: 'Host', desired });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'in-progress',
      retryAfterMs: 7_500,
      resources: [{ logicalKey: 'create-instance', state: 'retry-wait', attempts: 1 }],
    });
  });

  it('answers 202 with the operation id and audit URL when the provision outlives the admission window', async () => {
    const { dependencies, startProvisioning } = harness();
    startProvisioning.mockResolvedValueOnce({ status: 'accepted', operationId: 'op-accepted-1', hostId: 'host-1' });

    const response = await post(dependencies, { connectionId: 'connection-1', name: 'Host', desired });
    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe('/api/workspace-hosts/host-1/audit');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 'accepted',
      operationId: 'op-accepted-1',
      hostId: 'host-1',
      auditUrl: '/api/workspace-hosts/host-1/audit',
      message: 'Workspace-host provision accepted; follow the host timeline for progress',
    });
  });

  it('maps unsupported targets and typed runner refusals without echoing internal failures', async () => {
    // 'azure' has no registered provider factory; 'gcp' and 'aws' do (P-007 admits aws).
    const unsupported = harness();
    unsupported.readConnection.mockResolvedValueOnce({
      id: 'connection-1',
      target: 'azure',
      status: 'connected',
      connection: { target: 'azure', cloudCredentialRef: { kind: 'cloud', ref: 'resolver://azure' } },
    });
    const azureDesired = { ...desired, target: 'azure' };
    expect(
      await post(unsupported.dependencies, {
        connectionId: 'connection-1',
        name: 'Host',
        desired: azureDesired,
      }),
    ).toMatchObject({ status: 501 });
    expect(unsupported.startProvisioning).not.toHaveBeenCalled();

    const rejected = harness();
    rejected.startProvisioning.mockRejectedValueOnce(
      new WorkspaceHostProvisioningRequestError(['desired.zone must belong to desired.region']),
    );
    const rejectedResponse = await post(rejected.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(rejectedResponse.status).toBe(422);

    const unavailable = harness();
    unavailable.startProvisioning.mockRejectedValueOnce(
      new WorkspaceHostProvisioningConnectionError(['provider connection is not usable']),
    );
    expect(await post(unavailable.dependencies, { connectionId: 'connection-1', name: 'Host', desired })).toMatchObject(
      { status: 409 },
    );

    const internal = harness();
    internal.startProvisioning.mockRejectedValueOnce(new Error('secret-bearing internal detail'));
    const internalResponse = await post(internal.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(internalResponse.status).toBe(500);
    await expect(internalResponse.text()).resolves.not.toContain('secret-bearing internal detail');
  });

  it('admits an AWS provision on an uncapped (operator-credential) connection into the durable workflow', async () => {
    const h = harness();
    h.readConnection.mockResolvedValueOnce({
      id: 'connection-1',
      target: 'aws',
      status: 'connected',
      connection: { target: 'aws', cloudCredentialRef: { kind: 'cloud', ref: 'aws-profile://papercusp-byoc' } },
    });
    h.listLiveHostIds.mockResolvedValueOnce(['host-0']);
    const response = await post(h.dependencies, { connectionId: 'connection-1', name: 'Host', desired: awsDesired });
    expect(response.status).toBe(201);
    expect(h.startProvisioning).toHaveBeenCalledTimes(1);
    expect(h.startProvisioning.mock.calls[0]![0].desired.target).toBe('aws');
    // Uncapped: the live-host census is not even read.
    expect(h.listLiveHostIds).not.toHaveBeenCalled();
  });

  it('refuses a hosted AWS provision beyond the per-connection instance cap with the named cap error', async () => {
    const h = harness();
    h.readConnection.mockResolvedValueOnce(hostedAwsConnection());
    h.listLiveHostIds.mockResolvedValueOnce(['host-0']);
    const response = await post(h.dependencies, { connectionId: 'connection-1', name: 'Second', desired: awsDesired });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'workspace_host_instance_cap_exceeded',
      cap: 1,
      connectionId: 'connection-1',
      liveHostIds: ['host-0'],
    });
    expect(h.listLiveHostIds).toHaveBeenCalledWith('ws-1', 'connection-1');
    // Refused BEFORE the workflow: a capped request creates nothing at all.
    expect(h.startProvisioning).not.toHaveBeenCalled();
  });

  it('admits the first hosted AWS host and a resume of the same live host under the cap', async () => {
    const first = harness();
    first.readConnection.mockResolvedValueOnce(hostedAwsConnection());
    first.listLiveHostIds.mockResolvedValueOnce([]);
    expect((await post(first.dependencies, { connectionId: 'connection-1', name: 'Host', desired: awsDesired })).status).toBe(201);
    expect(first.startProvisioning).toHaveBeenCalledTimes(1);

    const resume = harness();
    resume.readConnection.mockResolvedValueOnce(hostedAwsConnection());
    resume.listLiveHostIds.mockResolvedValueOnce(['host-1']);
    expect((await post(resume.dependencies, { connectionId: 'connection-1', name: 'Host', desired: awsDesired })).status).toBe(201);
    expect(resume.startProvisioning).toHaveBeenCalledTimes(1);
  });

  it('applies the same cap to a hosted GCP connection (the cap is per connection, not per cloud)', async () => {
    const h = harness();
    h.readConnection.mockResolvedValueOnce({
      id: 'connection-1',
      target: 'gcp',
      status: 'connected',
      connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'delegation://customer-ws/connection-1' } },
    });
    h.listLiveHostIds.mockResolvedValueOnce(['host-0']);
    const response = await post(h.dependencies, { connectionId: 'connection-1', name: 'Second', desired });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'workspace_host_instance_cap_exceeded' });
    expect(h.startProvisioning).not.toHaveBeenCalled();
  });

  it('maps a concurrent host-scoped DBOS admission refusal to 409', async () => {
    const conflict = harness();
    conflict.startProvisioning.mockRejectedValueOnce(new WorkspaceHostProvisioningConflictError('host-1'));

    const response = await post(conflict.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workspace host already has a provisioning operation in progress',
    });
  });

  // WI-10005474: the replayed refusal of a reused operationId is a conflict naming the refusal.
  it('maps a controller-fence refusal to a typed 409 that names the refusal', async () => {
    const fenced = harness();
    fenced.startProvisioning.mockRejectedValueOnce(new WorkspaceHostControllerFenceError('host-1'));

    const response = await post(fenced.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
      operationId: 'op-fenced-1',
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'workspace-host provision refused: a newer operation or controller holds this host',
      reason: WORKSPACE_HOST_FENCE_REFUSED_CODE,
      hostId: 'host-1',
    });
  });

  // WI-10006929: a spent host id was refused only inside the workflow, so the caller got 202 and
  // the refusal surfaced minutes later as a failed operation. It is now a synchronous 422.
  it('refuses a spent host id with a synchronous 422 before anything is enqueued', async () => {
    const h = harness();
    h.readSpentHostId.mockResolvedValueOnce(new WorkspaceHostIdSpentError('host-1', 2, 'op-destroy-1'));

    const response = await post(h.dependencies, { connectionId: 'connection-1', name: 'Host', desired });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'workspace-host provisioning request rejected',
      reason: 'host_id_spent',
      problems: ["workspace host id 'host-1' is already used (revision 2, operation op-destroy-1); a new host needs a new id"],
      hostId: 'host-1',
    });
    expect(h.startProvisioning).not.toHaveBeenCalled();
    expect(h.listLiveHostIds).not.toHaveBeenCalled();
  });

  it('asks the spent-id check with the caller operationId and the runner default revision', async () => {
    const h = harness();
    const response = await post(h.dependencies, {
      connectionId: 'connection-1',
      name: 'Host',
      desired,
      operationId: 'op-replay-1',
    });
    expect(response.status).toBe(201);
    expect(h.readSpentHostId).toHaveBeenCalledWith('ws-1', 'host-1', {
      operationId: 'op-replay-1',
      desiredRevision: WORKSPACE_HOST_PROVISION_DEFAULT_REVISION,
    });
    expect(h.startProvisioning).toHaveBeenCalledTimes(1);

    const fresh = harness();
    await post(fresh.dependencies, { connectionId: 'connection-1', name: 'Host', desired });
    expect(fresh.readSpentHostId).toHaveBeenCalledWith('ws-1', 'host-1', {
      desiredRevision: WORKSPACE_HOST_PROVISION_DEFAULT_REVISION,
    });
  });
});

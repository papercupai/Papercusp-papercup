import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION } from '@papercusp/deployment-driver';
import type { RouteContext } from '../../define-route';
import { createWorkspaceHostActionRoute, type WorkspaceHostActionRouteDependencies } from './action';
import { WorkspaceHostCustomerAcceptanceError } from '../../../workspace-host/customer-acceptance-release-receipt';
import { WorkspaceHostReleaseCleanupError } from '../../../workspace-host/release-cleanup-release-receipt';
import { WorkspaceHostReleaseShipmentError } from '../../../workspace-host/release-shipment-green-receipt';
import { WorkspaceHostProvisioningConflictError } from '../../../dbos/workspace-host-provision-workflow';
import { WorkspaceHostProvisioningRequestError } from '../../../workspace-host/provisioning-runner';
import type { WorkspaceHostRequestForwarder } from '../../../workspace-host/controller-forwarding';
import {
  WORKSPACE_HOST_FENCE_REFUSED_CODE,
  WorkspaceHostControllerFenceError,
} from '../../../workspace-host/observability-store';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const desired = {
  hostId: 'host-1',
  target: 'gcp' as const,
  scope: { kind: 'project' as const, id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'adc://controller' } },
  labels: {
    papercusp_canary: 'true',
    papercusp_run_id: 'canary_1',
    papercusp_workspace_id: 'workspace_1',
  },
};

const canary = {
  runId: 'canary_1',
  workspaceId: 'workspace_1',
  contractApproval: {
    status: 'approved' as const,
    suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
    reportRef: 'report://gcp/fake-contract',
    approvedBy: 'operator:test',
    approvedAt: '2026-08-25T00:00:00.000Z',
  },
  teardownDeadlineAt: '2099-01-01T00:00:00.000Z',
  budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
  preRunZeroBaseline: {
    cents: 0,
    observedAt: '2026-08-25T00:00:00.000Z',
    providerEvidenceRef: 'gcp://billing/baseline-zero',
  },
  costEvidence: [{ cents: 75, observedAt: '2026-08-25T00:10:00.000Z', providerEvidenceRef: 'gcp://billing/settled' }],
  lateObservedSpend: [{ cents: 1, observedAt: '2026-08-25T01:10:00.000Z', providerEvidenceRef: 'gcp://billing/late' }],
};

function harness() {
  const readTarget = vi.fn<WorkspaceHostActionRouteDependencies['readTarget']>(async () => ({
    id: 'host-1',
    name: 'Canary host',
    connectionId: 'connection-1',
    target: 'gcp',
    observedState: 'running',
    hostGeneration: 1,
    desiredRevision: 1,
    observedRevision: 1,
    desired,
    resources: [],
  }));
  const readConnection = vi.fn<WorkspaceHostActionRouteDependencies['readConnection']>(async () => ({
    id: 'connection-1',
    target: 'gcp',
    status: 'connected',
    connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
  }));
  const startDestroy = vi.fn<WorkspaceHostActionRouteDependencies['startDestroy']>(async () => ({
    status: 'succeeded',
    operationId: 'op-destroy-1',
    hostId: 'host-1',
    plan: {
      planId: 'plan-destroy-1',
      operationId: 'op-destroy-1',
      target: 'gcp',
      hostId: 'host-1',
      generatedAt: '2026-08-25T00:00:00.000Z',
      steps: [],
      warnings: [],
    },
    checkpoints: [
      {
        logicalKey: 'delete-vm',
        state: 'absent',
        attempts: 1,
        deletionConfirmation: {
          hostId: 'host-1',
          providerResourceId: 'pc-host-vm',
          confirmedAbsentAt: '2026-08-25T00:10:00.000Z',
          source: 'provider-read',
        },
      },
    ],
  }));
  const startLifecycle = vi.fn<WorkspaceHostActionRouteDependencies['startLifecycle']>(async (input) => ({
    status: 'succeeded',
    operationId: input.operationId ?? 'op-lifecycle-1',
    hostId: input.action === 'restore' ? input.desired!.hostId : input.hostId,
    requiresInitialization: ['repair', 'upgrade', 'restore'].includes(input.action),
    plan: {
      planId: `plan-${input.action}-1`,
      operationId: input.operationId ?? 'op-lifecycle-1',
      target: 'gcp',
      hostId: input.action === 'restore' ? input.desired!.hostId : input.hostId,
      generatedAt: '2026-08-25T00:00:00.000Z',
      steps: [],
      warnings: [],
    },
    checkpoints: [],
  }));
  const dependencies: WorkspaceHostActionRouteDependencies = {
    activeWorkspaceId: () => 'workspace_1',
    provisioningAvailable: () => true,
    readTarget,
    readConnection,
    startDestroy,
    startLifecycle,
  };
  return { dependencies, readTarget, readConnection, startDestroy, startLifecycle };
}

async function post(dependencies: WorkspaceHostActionRouteDependencies, body: unknown): Promise<Response> {
  const route = createWorkspaceHostActionRoute(dependencies);
  return route.handler(
    new Request('http://operator.test/api/workspace-hosts/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

const destroyBody = {
  action: 'destroy',
  workspaceId: 'host-1',
  disposition: 'discard',
  operationId: 'op-destroy-1',
  confirmation: {
    expectedHostId: 'host-1',
    confirmedBy: 'operator:test',
    confirmedAt: '2026-08-25T00:00:00.000Z',
  },
  canary,
};

beforeEach(() => vi.clearAllMocks());

describe('POST /workspace-hosts/action destroy', () => {
  it('forwards a validated destroy request to the DBOS controller when the local executor is unavailable', async () => {
    const { dependencies, readTarget, readConnection, startDestroy, startLifecycle } = harness();
    dependencies.provisioningAvailable = () => false;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async (path, body) => {
      expect(path).toBe('/api/workspace-hosts/action');
      expect(body).toEqual(destroyBody);
      return Response.json(
        { ok: true, status: 'succeeded', operationId: 'op-destroy-1', hostId: 'host-1' },
        { status: 200 },
      );
    });
    dependencies.forwardRequest = forwardRequest;

    const response = await post(dependencies, destroyBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-destroy-1',
    });
    expect(forwardRequest).toHaveBeenCalledOnce();
    expect(readTarget).not.toHaveBeenCalled();
    expect(readConnection).not.toHaveBeenCalled();
    expect(startDestroy).not.toHaveBeenCalled();
    expect(startLifecycle).not.toHaveBeenCalled();
  });

  // D-395: a release-bound teardown is a canary destroy that DEFERS its spend settlement.
  const releaseDestroyBody = {
    ...destroyBody,
    canary: {
      ...canary,
      costEvidence: [],
      lateObservedSpend: [],
      spendSettlement: {
        status: 'deferred' as const,
        actorId: 'operator:test',
        reason: 'provider billing has not settled; GCP lags hours behind teardown',
        procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
        reconcileAfter: '2026-08-26T00:00:00.000Z',
      },
    },
  };

  it('checks a release census receipt before admission and binds it to the operation id it fixes', async () => {
    const { dependencies, startDestroy } = harness();
    const openTeardownRelease = vi.fn(async () => ({}) as never);
    dependencies.openTeardownRelease = openTeardownRelease;
    const { operationId: _operationId, ...withoutOperation } = releaseDestroyBody;

    const response = await post(dependencies, { ...withoutOperation, releaseTaskId: 'release-task-1' });

    expect(response.status).toBe(200);
    expect(openTeardownRelease).toHaveBeenCalledOnce();
    const checked = (
      openTeardownRelease.mock.calls[0] as unknown as [
        { operationId: string; releaseTaskId: string; billing: { runId: string; maxSpendCents: number | null } },
      ]
    )[0];
    expect(checked.releaseTaskId).toBe('release-task-1');
    // The billing stage is keyed by the canary run whose spend the reconciler will settle.
    // This canary declared no spend ceiling, so billing is judged against none.
    expect(checked.billing).toEqual({ runId: canary.runId, maxSpendCents: null });
    // The admission check and the durable run must name the SAME destroy, so the route fixes the id.
    expect(startDestroy).toHaveBeenCalledWith(
      expect.objectContaining({ releaseTaskId: 'release-task-1', operationId: checked.operationId }),
    );
  });

  it('refuses a release task on a non-destroy action or with a malformed id, and a receipt that cannot be written', async () => {
    const { dependencies, startDestroy, startLifecycle } = harness();
    const restart = await post(dependencies, { action: 'restart', workspaceId: 'host-1', releaseTaskId: 'release-task-1' });
    expect(restart.status).toBe(400);
    expect((await post(dependencies, { ...destroyBody, releaseTaskId: '../x' })).status).toBe(400);

    const { WorkspaceHostReleaseBindingError } = await import('../../../workspace-host/release-stage-receipt');
    dependencies.openTeardownRelease = vi.fn(async () => {
      throw new WorkspaceHostReleaseBindingError('bundle-mismatch', 'teardown.resource-census', 'other bytes');
    });
    const conflict = await post(dependencies, { ...releaseDestroyBody, releaseTaskId: 'release-task-1' });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ reason: 'bundle-mismatch' });
    expect(startDestroy).not.toHaveBeenCalled();
    expect(startLifecycle).not.toHaveBeenCalled();
  });

  it('refuses a release-bound destroy that could never close billing, before the journal is read', async () => {
    const { dependencies, startDestroy } = harness();
    const openTeardownRelease = vi.fn(async () => ({}) as never);
    dependencies.openTeardownRelease = openTeardownRelease;

    // Spend "settled" by cited evidence, and no canary evidence at all: neither is a billing-export reading.
    for (const body of [destroyBody, { ...destroyBody, canary: undefined }]) {
      const refused = await post(dependencies, { ...body, releaseTaskId: 'release-task-1' });
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({ error: expect.stringContaining('D-395') });
    }
    expect(openTeardownRelease).not.toHaveBeenCalled();
    expect(startDestroy).not.toHaveBeenCalled();
  });

  it('admits discard through the stored connection and returns provider-read receipts', async () => {
    const { dependencies, startDestroy } = harness();
    const response = await post(dependencies, destroyBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-destroy-1',
      resources: [{ state: 'absent', deletionConfirmation: { source: 'provider-read' } }],
    });
    expect(startDestroy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace_1',
        hostId: 'host-1',
        connectionId: 'connection-1',
        disposition: 'discard',
        canary,
      }),
    );
  });

  // aws-byoc-gcp-parity-2026-10-01 P-003: lifecycle actions were refused 501 for every non-GCP host,
  // so an AWS host could be provisioned but never torn down. The gate now follows the providers that
  // have a controller-independent destroy census.
  it('admits a destroy for an AWS host, which has a destroy census, and still refuses a provider without one', async () => {
    type StoredTarget = NonNullable<Awaited<ReturnType<WorkspaceHostActionRouteDependencies['readTarget']>>>;
    type StoredConnection = NonNullable<Awaited<ReturnType<WorkspaceHostActionRouteDependencies['readConnection']>>>;
    const hostFor = (target: 'aws' | 'azure'): StoredTarget => ({
      id: 'host-1',
      name: `${target} host`,
      connectionId: 'connection-1',
      target,
      observedState: 'running',
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 1,
      desired: { ...desired, target, scope: { kind: 'account', id: '413781344298' }, region: 'us-east-1' },
      resources: [],
    });
    const connectionFor = (target: 'aws' | 'azure'): StoredConnection => ({
      id: 'connection-1',
      target,
      status: 'connected',
      connection: { target, cloudCredentialRef: { kind: 'cloud', ref: `${target}-role://papercusp-workspace-host` } },
    });
    const { canary: _canary, ...ordinaryDestroy } = destroyBody;

    const aws = harness();
    aws.readTarget.mockResolvedValue(hostFor('aws'));
    aws.readConnection.mockResolvedValue(connectionFor('aws'));
    const admitted = await post(aws.dependencies, ordinaryDestroy);
    expect(admitted.status).toBe(200);
    expect(aws.startDestroy).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-1', disposition: 'discard' }));

    const azure = harness();
    azure.readTarget.mockResolvedValue(hostFor('azure'));
    azure.readConnection.mockResolvedValue(connectionFor('azure'));
    const refused = await post(azure.dependencies, ordinaryDestroy);
    expect(refused.status).toBe(501);
    expect(azure.startDestroy).not.toHaveBeenCalled();
  });

  it('returns a terminal offboarding result when the host is already absent', async () => {
    const { dependencies, startDestroy } = harness();
    startDestroy.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'destroy-reconcile-1',
      hostId: 'host-1',
      alreadyAbsent: true,
      offboardedCustomerWorkspaceId: 'customer-ws-1',
    });

    const response = await post(dependencies, destroyBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'succeeded',
      customerWorkspace: { id: 'customer-ws-1', state: 'deleted' },
      message: 'Workspace host was already absent; its customer workspace was marked deleted',
    });
  });

  it('admits every explicit disposition without manufacturing canary evidence and rejects a missing disposition', async () => {
    const { dependencies, startDestroy } = harness();
    const ordinary = { ...destroyBody, canary: undefined };

    await expect(post(dependencies, { ...ordinary, disposition: 'snapshot' })).resolves.toMatchObject({ status: 200 });
    await expect(post(dependencies, { ...ordinary, disposition: 'backup' })).resolves.toMatchObject({ status: 200 });
    await expect(post(dependencies, { ...ordinary, disposition: 'discard' })).resolves.toMatchObject({ status: 200 });
    const missing = await post(dependencies, { ...ordinary, disposition: undefined });

    expect(missing.status).toBe(422);
    expect(startDestroy).toHaveBeenCalledWith(expect.not.objectContaining({ canary: expect.anything() }));
    expect(startDestroy.mock.calls.map(([input]) => input.disposition)).toEqual(['snapshot', 'backup', 'discard']);
  });

  it('keeps the canary wrapper strict when canary evidence is supplied', async () => {
    const { dependencies, readTarget } = harness();
    const malformed = await post(dependencies, { ...destroyBody, canary: { runId: 'incomplete' } });
    const unsupportedDisposition = await post(dependencies, { ...destroyBody, disposition: 'snapshot' });
    expect(malformed.status).toBe(400);
    expect(unsupportedDisposition.status).toBe(422);
    expect(readTarget).not.toHaveBeenCalled();
  });

  // WI-2143805 / D-274. Destroy evidence carries two orthogonal axes and the route parses both:
  // AUTHORIZATION (contractApproval XOR failedRunTeardown) and SETTLEMENT (absent = billing settled,
  // spendSettlement = not yet). Requiring settled economics unconditionally refused teardown for
  // every real host, since provider billing lags hours behind the moment teardown is wanted.
  it('parses both evidence axes: admits a deferred settlement and a failed-run authorization, refuses malformed or conflicting ones', async () => {
    const { dependencies, startDestroy } = harness();
    const failedRunTeardown = {
      actorId: 'operator:test',
      reason: 'canary run failed during bootstrap; the host must still be torn down',
      procedureRef: 'runbook://workspace-host/gcp/failed-run-teardown-v1',
      failedOperationIds: ['op-run-1'],
    };
    const spendSettlement = {
      status: 'deferred' as const,
      actorId: 'operator:test',
      reason: 'provider billing has not settled; GCP lags hours behind teardown',
      procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
      reconcileAfter: '2026-08-26T00:00:00.000Z',
    };
    const { contractApproval: _approval, lateObservedSpend: _late, ...base } = canary;

    // canary-15's shape: the run SUCCEEDED, so it keeps its contract report; only the spend defers.
    const deferredCanary = { ...canary, costEvidence: [], lateObservedSpend: [], spendSettlement };
    const deferred = await post(dependencies, { ...destroyBody, canary: deferredCanary });
    expect(deferred.status).toBe(200);
    expect(startDestroy).toHaveBeenCalledWith(expect.objectContaining({ canary: deferredCanary }));

    // A failed run defers its spend too — it provisioned resources before it failed.
    const failedRunCanary = { ...base, costEvidence: [], failedRunTeardown, spendSettlement };
    expect((await post(dependencies, { ...destroyBody, canary: failedRunCanary })).status).toBe(200);

    // Presenting an approved report AND claiming the run failed would leave the audit record unable
    // to say which evidence the destroy was admitted on.
    expect((await post(dependencies, { ...destroyBody, canary: { ...canary, failedRunTeardown } })).status).toBe(400);

    // Neither axis is a blanket waiver: each attestation has to be complete.
    const unnamed = await post(dependencies, {
      ...destroyBody,
      canary: { ...failedRunCanary, failedRunTeardown: { ...failedRunTeardown, failedOperationIds: [] } },
    });
    expect(unnamed.status).toBe(400);

    // A deferral with no real date is an obligation nobody can be shown to have missed.
    const undated = await post(dependencies, {
      ...destroyBody,
      canary: { ...deferredCanary, spendSettlement: { ...spendSettlement, reconcileAfter: 'whenever' } },
    });
    expect(undated.status).toBe(400);
  });

  it('maps the host-scoped DBOS dedup conflict to 409 without leaking internals', async () => {
    const { dependencies, startDestroy } = harness();
    startDestroy.mockRejectedValueOnce(new WorkspaceHostProvisioningConflictError('host-1'));

    const response = await post(dependencies, destroyBody);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workspace host already has an operation in progress',
    });
  });

  // WI-10005474: a reused operationId whose workflow already ended in a fence refusal rethrows that
  // refusal inside the admission window; it is a conflict naming the refusal, not a generic 500.
  it('maps a controller-fence refusal to a typed 409 for destroy and lifecycle actions', async () => {
    const { dependencies, startDestroy, startLifecycle } = harness();
    startDestroy.mockRejectedValueOnce(new WorkspaceHostControllerFenceError('host-1'));
    const destroyed = await post(dependencies, destroyBody);
    expect(destroyed.status).toBe(409);
    await expect(destroyed.json()).resolves.toMatchObject({
      ok: false,
      error: 'workspace-host destroy refused: a newer operation or controller holds this host',
      reason: WORKSPACE_HOST_FENCE_REFUSED_CODE,
      hostId: 'host-1',
    });

    startLifecycle.mockRejectedValueOnce(new WorkspaceHostControllerFenceError('host-1'));
    const upgraded = await post(dependencies, {
      action: 'upgrade',
      workspaceId: 'host-1',
      operationId: 'op-upgrade-fenced-1',
    });
    expect(upgraded.status).toBe(409);
    await expect(upgraded.json()).resolves.toMatchObject({
      reason: WORKSPACE_HOST_FENCE_REFUSED_CODE,
      error: 'workspace-host upgrade refused: a newer operation or controller holds this host',
    });
  });

  it('returns a typed 503 when the DBOS controller cannot be discovered', async () => {
    const { dependencies, readTarget, readConnection, startDestroy, startLifecycle } = harness();
    dependencies.provisioningAvailable = () => false;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async () => null);
    dependencies.forwardRequest = forwardRequest;

    const response = await post(dependencies, destroyBody);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'workspace-host provisioning workflow is unavailable on this operator',
    });
    expect(forwardRequest).toHaveBeenCalledWith('/api/workspace-hosts/action', destroyBody);
    expect(readTarget).not.toHaveBeenCalled();
    expect(readConnection).not.toHaveBeenCalled();
    expect(startDestroy).not.toHaveBeenCalled();
    expect(startLifecycle).not.toHaveBeenCalled();
  });

  // WI-10004957: right after a bg-host restart /api/health is already ok while DBOS is still
  // launching. A request in that window must wait for the in-flight launch, not 503.
  it('waits for an in-flight DBOS launch instead of refusing 503 or forwarding', async () => {
    const { dependencies, startDestroy } = harness();
    let launched = false;
    dependencies.provisioningAvailable = () => launched;
    const awaitProvisioning = vi.fn(async () => {
      launched = true;
      return true;
    });
    dependencies.awaitProvisioning = awaitProvisioning;
    const forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async () => null);
    dependencies.forwardRequest = forwardRequest;

    const response = await post(dependencies, destroyBody);

    expect(response.status).not.toBe(503);
    expect(awaitProvisioning).toHaveBeenCalledTimes(1);
    expect(forwardRequest).not.toHaveBeenCalled();
    expect(startDestroy).toHaveBeenCalledTimes(1);
  });

  it('still refuses 503 when the bounded launch wait ends without DBOS', async () => {
    const { dependencies, startDestroy } = harness();
    dependencies.provisioningAvailable = () => false;
    const awaitProvisioning = vi.fn(async () => false);
    dependencies.awaitProvisioning = awaitProvisioning;
    dependencies.forwardRequest = vi.fn<WorkspaceHostRequestForwarder>(async () => null);

    const response = await post(dependencies, destroyBody);

    expect(response.status).toBe(503);
    expect(awaitProvisioning).toHaveBeenCalledTimes(1);
    expect(startDestroy).not.toHaveBeenCalled();
  });

  it('does not wait when provisioning is already available', async () => {
    const { dependencies } = harness();
    const awaitProvisioning = vi.fn(async () => true);
    dependencies.awaitProvisioning = awaitProvisioning;

    await post(dependencies, destroyBody);

    expect(awaitProvisioning).not.toHaveBeenCalled();
  });
});

describe('POST /workspace-hosts/action customer-acceptance', () => {
  const acceptanceBody = {
    action: 'customer-acceptance',
    workspaceId: 'host-1',
    releaseTaskId: 'release-task-1',
    customerWorkspaceId: 'customer-workspace-1',
    hostedSessionId: 'hosted-session-1',
    channelId: 'channel-1',
  };

  it('records against the exact authenticated hosted session without requiring DBOS or a provider action', async () => {
    const h = harness();
    const recordCustomerAcceptance = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordCustomerAcceptance']>>(
      async () => ({
        outcome: 'committed',
        stage: 'desktop-session.customer-acceptance',
        releaseTaskId: 'release-task-1',
        bundleSha256: 'c'.repeat(64),
        auditEventId: 'hosted-vnc-1',
        evidenceRefs: ['hosted-desktop-takeover:hosted-vnc-1'],
      }),
    );

    const response = await post(
      {
        ...h.dependencies,
        provisioningAvailable: () => false,
        recordCustomerAcceptance,
      },
      acceptanceBody,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, receipt: { stage: 'desktop-session.customer-acceptance' } });
    expect(recordCustomerAcceptance).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      hostId: 'host-1',
      releaseTaskId: 'release-task-1',
      customerWorkspaceId: 'customer-workspace-1',
      hostedSessionId: 'hosted-session-1',
      channelId: 'channel-1',
    });
    expect(h.readTarget).not.toHaveBeenCalled();
    expect(h.startDestroy).not.toHaveBeenCalled();
    expect(h.startLifecycle).not.toHaveBeenCalled();
  });

  it('requires the release and exact hosted-session correlation before calling the writer', async () => {
    const h = harness();
    const recordCustomerAcceptance = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordCustomerAcceptance']>>();

    const response = await post(
      { ...h.dependencies, recordCustomerAcceptance },
      { ...acceptanceBody, channelId: '' },
    );

    expect(response.status).toBe(400);
    expect(recordCustomerAcceptance).not.toHaveBeenCalled();
  });

  it('keeps acceptance pending when the matching takeover audit is absent', async () => {
    const h = harness();
    const recordCustomerAcceptance = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordCustomerAcceptance']>>(
      async () => {
        throw new WorkspaceHostCustomerAcceptanceError('takeover-not-found', 'no matching hosted takeover audit');
      },
    );

    const response = await post({ ...h.dependencies, recordCustomerAcceptance }, acceptanceBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: 'takeover-not-found',
    });
  });
});

describe('POST /workspace-hosts/action release-cleanup', () => {
  const cleanupBody = {
    action: 'release-cleanup',
    workspaceId: 'host-1',
    releaseTaskId: 'release-task-1',
  };

  it('records release cleanup on the explicit task without requiring DBOS or a provider action', async () => {
    const h = harness();
    const recordReleaseCleanup = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseCleanup']>>(
      async () => ({
        outcome: 'committed',
        stage: 'release.cleanup',
        releaseTaskId: 'release-task-1',
        hostId: 'host-1',
        bundleSha256: 'c'.repeat(64),
        evidenceRefs: ['release-cleanup-verification:host-1', 'cleanup-live-workflows:none'],
      }),
    );

    const response = await post(
      { ...h.dependencies, provisioningAvailable: () => false, recordReleaseCleanup },
      cleanupBody,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, receipt: { stage: 'release.cleanup' } });
    expect(recordReleaseCleanup).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      hostId: 'host-1',
      releaseTaskId: 'release-task-1',
    });
    expect(h.readTarget).not.toHaveBeenCalled();
    expect(h.startDestroy).not.toHaveBeenCalled();
    expect(h.startLifecycle).not.toHaveBeenCalled();
  });

  it('returns the measured refusal evidence without claiming cleanup committed', async () => {
    const h = harness();
    const recordReleaseCleanup = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseCleanup']>>(
      async () => ({
        outcome: 'refused',
        stage: 'release.cleanup',
        releaseTaskId: 'release-task-1',
        hostId: 'host-1',
        bundleSha256: 'c'.repeat(64),
        evidenceRefs: ['cleanup-failed:billing-closure-not-committed'],
      }),
    );

    const response = await post({ ...h.dependencies, recordReleaseCleanup }, cleanupBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      receipt: { outcome: 'refused', evidenceRefs: ['cleanup-failed:billing-closure-not-committed'] },
    });
  });

  it('requires an explicit release task before invoking the cleanup writer', async () => {
    const h = harness();
    const recordReleaseCleanup = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseCleanup']>>();

    const response = await post(
      { ...h.dependencies, recordReleaseCleanup },
      { ...cleanupBody, releaseTaskId: undefined },
    );

    expect(response.status).toBe(400);
    expect(recordReleaseCleanup).not.toHaveBeenCalled();
  });

  it('returns a typed conflict when cleanup cannot resolve the release task', async () => {
    const h = harness();
    const recordReleaseCleanup = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseCleanup']>>(
      async () => {
        throw new WorkspaceHostReleaseCleanupError('release-task-not-found', 'no release task');
      },
    );

    const response = await post({ ...h.dependencies, recordReleaseCleanup }, cleanupBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'release-task-not-found' });
  });
});

describe('POST /workspace-hosts/action release-shipment', () => {
  const shipmentBody = {
    action: 'release-shipment',
    workspaceId: 'host-1',
    releaseTaskId: 'release-task-1',
    rollbackReleaseTaskId: 'rollback-task-1',
  };

  it('records the green shipment check on the explicit current and rollback release tasks', async () => {
    const h = harness();
    const recordReleaseShipment = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseShipment']>>(
      async () => ({
        outcome: 'committed',
        stage: 'release.shipment.green',
        releaseTaskId: 'release-task-1',
        rollbackReleaseTaskId: 'rollback-task-1',
        hostId: 'host-1',
        bundleSha256: 'c'.repeat(64),
        sourceSha: 'a'.repeat(40),
        evidenceRefs: ['shipment-source-in-main:' + 'a'.repeat(40)],
      }),
    );

    const response = await post(
      { ...h.dependencies, provisioningAvailable: () => false, recordReleaseShipment },
      shipmentBody,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      receipt: { stage: 'release.shipment.green', outcome: 'committed' },
    });
    expect(recordReleaseShipment).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      hostId: 'host-1',
      releaseTaskId: 'release-task-1',
      rollbackReleaseTaskId: 'rollback-task-1',
    });
    expect(h.readTarget).not.toHaveBeenCalled();
    expect(h.startDestroy).not.toHaveBeenCalled();
    expect(h.startLifecycle).not.toHaveBeenCalled();
  });

  it('returns the measured refusal receipt without claiming shipment committed', async () => {
    const h = harness();
    const recordReleaseShipment = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseShipment']>>(
      async () => ({
        outcome: 'refused',
        stage: 'release.shipment.green',
        releaseTaskId: 'release-task-1',
        rollbackReleaseTaskId: 'rollback-task-1',
        hostId: 'host-1',
        bundleSha256: 'c'.repeat(64),
        sourceSha: 'a'.repeat(40),
        evidenceRefs: ['shipment-failed:source-not-in-main'],
      }),
    );

    const response = await post({ ...h.dependencies, recordReleaseShipment }, shipmentBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      receipt: { outcome: 'refused', evidenceRefs: ['shipment-failed:source-not-in-main'] },
    });
  });

  it('requires an explicit current release task id before invoking the writer', async () => {
    const h = harness();
    const recordReleaseShipment = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseShipment']>>();

    const response = await post(
      { ...h.dependencies, recordReleaseShipment },
      { ...shipmentBody, releaseTaskId: undefined },
    );

    expect(response.status).toBe(400);
    expect(recordReleaseShipment).not.toHaveBeenCalled();
  });

  it('passes an omitted rollback release task id to the writer as null (first green shipment, D-437)', async () => {
    const h = harness();
    const recordReleaseShipment = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseShipment']>>(
      async (input) => ({
        outcome: 'refused',
        stage: 'release.shipment.green',
        releaseTaskId: input.releaseTaskId,
        rollbackReleaseTaskId: input.rollbackReleaseTaskId ?? null,
        hostId: input.hostId,
        bundleSha256: '',
        sourceSha: '',
        evidenceRefs: [],
      }),
    );

    await post({ ...h.dependencies, recordReleaseShipment }, { ...shipmentBody, rollbackReleaseTaskId: undefined });

    expect(recordReleaseShipment).toHaveBeenCalledTimes(1);
    expect(recordReleaseShipment.mock.calls[0]![0].rollbackReleaseTaskId).toBeNull();
  });

  it('returns a typed conflict when the release task cannot be resolved', async () => {
    const h = harness();
    const recordReleaseShipment = vi.fn<NonNullable<WorkspaceHostActionRouteDependencies['recordReleaseShipment']>>(
      async () => {
        throw new WorkspaceHostReleaseShipmentError('release-task-not-found', 'no release task');
      },
    );

    const response = await post({ ...h.dependencies, recordReleaseShipment }, shipmentBody);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'release-task-not-found' });
  });
});

describe('POST /workspace-hosts/action existing-host lifecycle', () => {
  it.each(['start', 'stop', 'restart', 'repair', 'snapshot'] as const)(
    'admits %s through the stored connection and durable lifecycle workflow',
    async (action) => {
      const { dependencies, startLifecycle } = harness();
      const response = await post(dependencies, { action, workspaceId: 'host-1', operationId: `op-${action}-1` });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: 'succeeded',
        operationId: `op-${action}-1`,
        hostId: 'host-1',
      });
      expect(startLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          workspaceId: 'workspace_1',
          hostId: 'host-1',
          operationId: `op-${action}-1`,
          connection: expect.objectContaining({ target: 'gcp', scope: desired.scope }),
        }),
      );
    },
  );

  it('returns a provider-succeeded repair as not yet servable until initialization runs', async () => {
    const { dependencies } = harness();
    const response = await post(dependencies, {
      action: 'repair',
      workspaceId: 'host-1',
      operationId: 'op-repair-readiness-1',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      status: 'succeeded',
      operationId: 'op-repair-readiness-1',
      requiresInitialization: true,
      message: expect.stringContaining('CANNOT SERVE'),
    });
    expect(body.message).toContain("repair invalidated the host's initialized state");
    expect(body.message).not.toContain('replaced the boot disk');
  });

  it.each(['gcp', 'aws'] as const)('hydrates a desktop %s restore from persisted config and rebinds current credentials', async (target) => {
    const h = harness();
    const source = { ...desired, target, scope: { kind: target === 'aws' ? 'account' as const : 'project' as const, id: target === 'aws' ? '123456789012' : 'project-1' }, labels: undefined,
      provider: { sourceSetting: 'kept' } };
    h.readTarget.mockResolvedValue({ ...(await h.readTarget('workspace_1', 'host-1'))!, target, desired: source });
    h.readConnection.mockResolvedValue({ id: 'connection-1', target, status: 'connected', connection: {
      target, cloudCredentialRef: { kind: 'cloud', ref: 'resolver://current' }, provider: { currentSetting: 'bound' },
    } });
    const snapshot = { target, hostId: 'host-1', providerId: 'snapshot-1' };
    const response = await post(h.dependencies, { action: 'restore', workspaceId: 'host-1', name: 'Restored host', snapshot, desired: { hostId: 'host-restored' } });
    expect(response.status).toBe(200);
    expect(h.startLifecycle).toHaveBeenCalledWith(expect.objectContaining({ action: 'restore', snapshot, name: 'Restored host',
      desired: { ...source, hostId: 'host-restored', credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'resolver://current' } },
        provider: { sourceSetting: 'kept', currentSetting: 'bound' } } }));
  });

  it.each(['host-1', 'bad host', ''])('refuses invalid or same-host desktop restore identity %s', async (hostId) => {
    const h = harness();
    const response = await post(h.dependencies, { action: 'restore', workspaceId: 'host-1', snapshot: { target: 'gcp', hostId: 'host-1', providerId: 'snapshot-1' }, desired: { hostId } });
    expect(response.status).toBe(422);
    expect(h.startLifecycle).not.toHaveBeenCalled();
  });

  it('threads explicit upgrade and restore inputs without inventing provider defaults', async () => {
    const { dependencies, startLifecycle } = harness();
    const image = { id: 'projects/images/global/images/papercusp-v2', version: '2' };
    const upgrade = await post(dependencies, {
      action: 'upgrade',
      workspaceId: 'host-1',
      image,
      rollbackImage: desired.image,
    });
    expect(upgrade.status).toBe(200);
    expect(startLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'upgrade', image, rollbackImage: desired.image }),
    );

    const restored = { ...desired, hostId: 'host-restored-1' };
    const snapshot = { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' };
    const restore = await post(dependencies, {
      action: 'restore',
      workspaceId: 'host-1',
      snapshot,
      desired: restored,
      canary,
    });
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toMatchObject({ hostId: 'host-restored-1' });
    expect(startLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'restore', snapshot, desired: restored, canary }),
    );
  });

  it('maps a pre-enqueue lifecycle request refusal to HTTP 422', async () => {
    const { dependencies, startLifecycle } = harness();
    startLifecycle.mockRejectedValueOnce(new WorkspaceHostProvisioningRequestError(['upgrade image is required']));

    const response = await post(dependencies, {
      action: 'upgrade',
      workspaceId: 'host-1',
      operationId: 'op-upgrade-preflight-1',
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'workspace-host upgrade request rejected',
      problems: ['upgrade image is required'],
    });
    expect(startLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'upgrade', operationId: 'op-upgrade-preflight-1' }),
    );
  });

  it('refuses a canary restore without pre-run economics instead of accepting an unaccountable run', async () => {
    const { dependencies, startLifecycle } = harness();
    const response = await post(dependencies, {
      action: 'restore', workspaceId: 'host-1',
      snapshot: { target: 'gcp', providerId: 'snapshot-1', hostId: 'host-1' },
      desired: { ...desired, hostId: 'host-restored-1' },
    });
    expect(response.status).toBe(422);
    expect(startLifecycle).not.toHaveBeenCalled();
  });

  // EI-23712230399040759: a workflow still running after the admission window is ACCEPTED work.
  // Holding the request for its result is what made every forwarded upgrade/destroy read as a
  // 504 'outcome unknown' while the operation succeeded.
  it('answers 202 with the operation id and audit URL when the workflow outlives the admission window', async () => {
    const { dependencies, startLifecycle, startDestroy } = harness();
    startLifecycle.mockResolvedValueOnce({ status: 'accepted', operationId: 'op-upgrade-accepted-1', hostId: 'host-1' });
    const upgrade = await post(dependencies, {
      action: 'upgrade',
      workspaceId: 'host-1',
      operationId: 'op-upgrade-accepted-1',
      image: { id: 'projects/images/global/images/papercusp-v2' },
    });

    expect(upgrade.status).toBe(202);
    expect(upgrade.headers.get('location')).toBe('/api/workspace-hosts/host-1/audit');
    await expect(upgrade.json()).resolves.toEqual({
      ok: true,
      status: 'accepted',
      operationId: 'op-upgrade-accepted-1',
      hostId: 'host-1',
      auditUrl: '/api/workspace-hosts/host-1/audit',
      message: 'Workspace-host upgrade accepted; follow the host timeline for progress',
    });

    startDestroy.mockResolvedValueOnce({ status: 'accepted', operationId: 'op-destroy-accepted-1', hostId: 'host-1' });
    const destroy = await post(dependencies, { ...destroyBody, operationId: 'op-destroy-accepted-1' });
    expect(destroy.status).toBe(202);
    await expect(destroy.json()).resolves.toMatchObject({
      ok: true,
      status: 'accepted',
      operationId: 'op-destroy-accepted-1',
    });
  });
});

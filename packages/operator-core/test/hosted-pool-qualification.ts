/** Real hosted pool admission + DBOS + provider execution, confined by the serving fixture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type postgres from 'postgres';
import type { WorkspaceHostProvisionBootstrapReleaseOverride } from '../lib/workspace-host/provision-bootstrap';
import { assertHostedPoolQualificationPreflight, type HostedPoolQualificationPreflight } from './hosted-pool-qualification-preflight';

export type HostedPoolQualificationConfiguration = Omit<HostedPoolQualificationPreflight,
  'environment' | 'systemDatabaseUrl' | 'artifact' | 'sourceRevision'> & {
  expectedSourceRevision: string;
  expectedRuntimeBundleSha256: string;
  bootstrapReleaseOverride: WorkspaceHostProvisionBootstrapReleaseOverride;
};

export async function qualifyHostedPool(input: {
  configuration: HostedPoolQualificationConfiguration;
  artifact: string;
  evidenceDir: string;
  organizationId: string;
  sessionId: string;
  sql: postgres.Sql;
}) {
  const { configuration: config } = input;
  const sourceRoot = resolve(import.meta.dirname, '../../..');
  const sourceRevision = () => ({ expected: config.expectedSourceRevision,
    actual: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() });
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: sourceRoot, encoding: 'utf8' }).trim(), 'HEAD', 'qualification worker requires immutable detached source');
  // Only this private worker runs DBOS. The hosted HTTP child keeps its request-only profile.
  const runtime = assertHostedPoolQualificationPreflight({ ...config, artifact: input.artifact,
    sourceRevision: sourceRevision(), environment: process.env, systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL! });
  // GCP's provider consumes the validated canary deadline as terminationTime. Do not claim
  // AWS safety from the existence of the controller's deadline field alone.
  assert.equal(config.desired.target, 'gcp', 'AWS requires its independent provider deadline rail first');
  assert.equal(config.connection.target, 'gcp');
  const { admissionIdentity, createHostedWorkspaceAdmission } = await import('../lib/auth/hosted/workspace-admission');
  const operationKey = config.canary.runId;
  const identity = admissionIdentity(input.organizationId, operationKey);
  assert.equal(config.desired.hostId, identity.hostId, 'desired host must use ordinary admission identity');
  const sessions = await input.sql<{ user_id: string }[]>`
    SELECT user_id FROM papercusp_auth.hosted_sessions
    WHERE id = ${input.sessionId} AND organization_id = ${input.organizationId}`;
  assert.equal(sessions.length, 1, 'genuine private hosted session is required');
  const actorId = sessions[0].user_id;
  const connectionId = `p544-${config.canary.runId}`;
  const { createConfiguredGcpWorkspaceHostProvider, resolveGcpWorkspaceHostManagedNetworkInventoryNames } =
    await import('../lib/workspace-host/gcp-provider');
  const { resolveHostedGcpAuth } = await import('../lib/workspace-host/hosted-gcp-auth');
  const provider = createConfiguredGcpWorkspaceHostProvider(config.connection, { resolveHostedAuth: resolveHostedGcpAuth });
  const inventoryRequest = { projectId: config.desired.scope.id, region: config.desired.region,
    workspaceId: runtime.workspaceId,
    deterministicNames: resolveGcpWorkspaceHostManagedNetworkInventoryNames(config.desired) ??
      { networks: [], subnetworks: [], firewalls: [], routers: [], nats: [] } };
  const before = await provider.inventoryManagedResources(inventoryRequest);
  assert.equal(before.complete, true, 'complete independent pre-run inventory is required');
  assert.equal(before.observed.length, 0, 'the complete private provider inventory must start empty');
  const { DBOS, DBOSClient } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({ name: 'p544-private-hosted-pool', systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL!,
    systemDatabaseSchemaName: 'dbos', applicationVersion: runtime.appVersion, runAdminServer: false });
  const { getOrgPg, _resetForTests } = await import('@papercusp/db-org');
  const { createCloudResourceObligationObserver, createCloudResourceObligationCloseObserver } =
    await import('../lib/workspace-host/cloud-resource-obligations');
  const { registerWorkspaceHostProviderFactories } = await import('../lib/workspace-host/provider-factories');
  registerWorkspaceHostProviderFactories({ resolveHostedGcpAuth,
    obligationObservers: target => ({
      onResourceCreated: createCloudResourceObligationObserver({ sql: getOrgPg().sql, provider: target }),
      onResourceDestroyed: async event => {
        await createCloudResourceObligationCloseObserver({ sql: getOrgPg().sql, provider: target })(event);
      },
    }) });
  const workflow = await import('../lib/dbos/workspace-host-provision-workflow');
  const { createWorkspaceHostProvisioningClient } = await import('../lib/dbos/workspace-host-provision-client');
  const { createDefaultHostedWorkspaceAdmissionDependencies } = await import('../lib/auth/hosted/workspace-admission-dependencies');
  const { upsertWorkspaceHostConnection, readWorkspaceHostDestroyTarget } = await import('../lib/workspace-host/observability-store');
  const { resolveControllerWorkspaceHostBootstrap } = await import('../lib/workspace-host/provisioning-runner');
  const { resolveWorkspaceHostProvisionBootstrapProfile } = await import('../lib/workspace-host/provision-bootstrap');
  const profile = await resolveWorkspaceHostProvisionBootstrapProfile({ bootstrapReleaseOverride: config.bootstrapReleaseOverride });
  assert.equal(profile.release.bundleSha256, config.expectedRuntimeBundleSha256,
    'remote release must be the exact qualification candidate');
  const manifest = JSON.parse(readFileSync(config.bootstrapReleaseOverride.manifestPath, 'utf8'));
  assert.equal(manifest.artifact?.release?.bundleSha256, profile.release.bundleSha256,
    'the validated release manifest changed during preflight');
  assert.equal(manifest.artifact?.buildManifest?.source?.revision, config.expectedSourceRevision,
    'the remote artifact and controller must come from the same exact source');
  // Ordinary catalog admission resolves the controller's configured pin; the operation pin
  // must name that same release. An override cannot quote one bundle and boot another.
  const bootstrap = await resolveControllerWorkspaceHostBootstrap(identity.hostId);
  assert.equal(bootstrap.runtimeRelease.bundleSha256, config.expectedRuntimeBundleSha256);
  const receipt: Record<string, unknown> = { scope: 'private real hosted pool + DBOS provision/destroy; guest UX, costs and shipment remain separate',
    bundleSha256: runtime.bundleSha256, runtimeBundleSha256: config.expectedRuntimeBundleSha256,
    appVersion: runtime.appVersion, hostId: identity.hostId, runId: config.canary.runId,
    controllerSourceRevision: config.expectedSourceRevision,
    teardownDeadlineAt: config.canary.teardownDeadlineAt, preRunInventoryEmpty: true,
    providerQualified: false, teardownVerified: false, billingSettled: false };
  let sdk: Awaited<ReturnType<typeof DBOSClient.create>> | undefined;
  let launched = false;
  let provisionWorkflowId: string | undefined;
  const failures: unknown[] = [];
  try {
    await DBOS.launch(); launched = true;
    sdk = await DBOSClient.create({ systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL!, systemDatabaseSchemaName: 'dbos' });
    const client = createWorkspaceHostProvisioningClient({ systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL!,
      appVersion: runtime.appVersion, createClient: async () => sdk! });
    await upsertWorkspaceHostConnection({ workspaceId: runtime.workspaceId, id: connectionId, target: 'gcp',
      label: 'P544 private qualification', credentialRef: config.connection.cloudCredentialRef.ref,
      provider: config.connection.provider, status: 'connected' });
    const admission = createHostedWorkspaceAdmission({
      ...createDefaultHostedWorkspaceAdmissionDependencies({ pooled: true,
        resolveDesiredSpec: async () => config.desired,
        startWorkflow: async request => {
          assertHostedPoolQualificationPreflight({ ...config, artifact: input.artifact,
            sourceRevision: sourceRevision(), environment: process.env, systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL! });
          const accepted = await client.enqueue({ ...request, canary: config.canary,
            bootstrapReleaseOverride: config.bootstrapReleaseOverride });
          provisionWorkflowId = accepted.workflowId;
          return accepted;
        },
      }),
      controlPlaneWorkspaceId: () => runtime.workspaceId,
    });
    const admitted = await admission.ensureProvisioned({ organizationId: input.organizationId, userId: actorId,
      provider: 'gcp', connectionId, displayName: 'P544 private qualification', operationKey });
    assert.equal(admitted.provisionOperationId, identity.provisionOperationId);
    assert.ok(provisionWorkflowId, 'ordinary pool admission must enqueue the real workflow');
    receipt.provisionWorkflowId = provisionWorkflowId;
    const result = await DBOS.getResult<{ status: string }>(provisionWorkflowId,
      { timeoutSeconds: Math.max(1, Math.floor((runtime.workloadDeadline - Date.now()) / 1000)) });
    assert.equal(result?.status, 'succeeded', 'real provider workflow must finish before the workload deadline');
    const stored = await sdk.getWorkflow(provisionWorkflowId);
    assert.ok(stored, 'real DBOS persistence must contain the workflow');
    assert.equal(stored.status, 'SUCCESS');
    assert.equal(stored.applicationVersion, runtime.appVersion);
    assert.equal(stored.queueName, workflow.WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME);
    const operations = await input.sql<{ admission_receipt: unknown; status: string }[]>`
      SELECT admission_receipt, status FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${runtime.workspaceId} AND id = ${identity.provisionOperationId}`;
    assert.equal(operations.length, 1);
    assert.ok(operations[0].admission_receipt, 'a successful DBOS run without durable pool admission cannot qualify');
    assert.equal(operations[0].status, 'succeeded');
    receipt.providerQualified = true;
  } catch (error) { failures.push(error); }
  finally {
    try {
      if (provisionWorkflowId) {
        const status = await DBOS.getWorkflowStatus(provisionWorkflowId);
        if (status && !['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(status.status)) {
          await DBOS.cancelWorkflow(provisionWorkflowId);
        }
      }
      const target = await readWorkspaceHostDestroyTarget(runtime.workspaceId, identity.hostId);
      if (target) {
        // Keep provider identities outside disposable PG even when teardown fails.
        receipt.resourceIdentities = target.resources.map(entry => entry.resource);
        assert.ok(launched && sdk, 'the real worker must remain available for teardown');
        const destroyInput = { workspaceId: runtime.workspaceId, hostId: identity.hostId, connectionId,
          connection: config.connection, disposition: 'discard' as const,
          operationId: `${identity.provisionOperationId}-destroy`, actorId,
          confirmation: { expectedHostId: identity.hostId, confirmedBy: actorId, confirmedAt: new Date().toISOString() },
          canary: { ...config.canary, costEvidence: [],
            spendSettlement: { status: 'deferred' as const, actorId,
              reason: 'Provider billing has not settled; parent P544 retains the cost reconciliation obligation',
              procedureRef: 'work-item:WI-6554700010016277',
              reconcileAfter: new Date(runtime.teardownDeadline + 24 * 60 * 60_000).toISOString() } } };
        await workflow.startWorkspaceHostDestroyWorkflow(destroyInput);
        const request = workflow.workspaceHostDestroyEnqueueRequest(destroyInput);
        const destroyed = await DBOS.getResult<{ status: string }>(request.workflowId,
          { timeoutSeconds: Math.max(1, Math.floor((runtime.teardownDeadline - Date.now()) / 1000)) });
        assert.equal(destroyed?.status, 'succeeded', 'provider teardown must finish within its fixed bound');
      }
      const after = await provider.inventoryManagedResources(inventoryRequest);
      assert.equal(after.complete, true);
      assert.equal(after.observed.length, 0, 'the complete independent inventory must prove absence after teardown');
      receipt.teardownVerified = true;
    } catch (error) { failures.push(error); }
    for (const close of [async () => { await sdk?.destroy(); }, async () => { await DBOS.shutdown(); },
      async () => { await _resetForTests(); }]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    try {
      receipt.operations = await input.sql`
        SELECT id, action, status, error->>'code' AS error_code
        FROM harness_shared.workspace_host_operations
        WHERE workspace_id = ${runtime.workspaceId} AND host_id = ${identity.hostId}`;
    } catch (error) { failures.push(error); }
    receipt.failureKinds = failures.map(error => error instanceof Error ? error.name : 'UnknownError');
    writeFileSync(join(input.evidenceDir, 'pool-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  if (failures.length) throw new AggregateError(failures, 'Positive hosted pool qualification failed; inspect retained evidence');
  return receipt;
}

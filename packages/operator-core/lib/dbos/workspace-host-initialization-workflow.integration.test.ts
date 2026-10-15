/** Real DBOS persistence and host mutex; no cloud resources or credentials. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION, workspaceHostWorkflowKeys, type WorkspaceHostInitializationRequest } from '@papercusp/deployment-driver';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';

let DBOS: typeof DBOSType;
let workflow: typeof import('./workspace-host-provision-workflow');
let adminUri: string;
let dbName: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_init_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(admin, dbName); }
  finally { await admin.end({ timeout: 5 }); }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({ name: 'workspace-host-init-test', systemDatabaseUrl: url.toString(),
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'test-v1', runAdminServer: false });
  workflow = await import('./workspace-host-provision-workflow');
  await DBOS.launch();
}, 90_000);

afterAll(async () => {
  workflow?.setWorkspaceHostProvisioningExecutor(null);
  await DBOS?.shutdown();
  if (adminUri && dbName) {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
    finally { await admin.end({ timeout: 5 }); }
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

it('accepts while execution is blocked, persists the original input, excludes competing mutations and replays once', async () => {
  const request: WorkspaceHostInitializationRequest = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    workspaceId: 'ws-1', hostId: 'host-1', operationId: 'init-1', requestedAt: '2026-09-19T00:00:00Z',
    source: { kind: 'empty' as const },
    credentialRefs: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'cloud-resolver:v1' } },
    credentialDelivery: { cloud: { kind: 'provider-identity' as const, generation: 1, audience: 'host-1', revocationRef: 'revoke-1' } },
    deliveryCapabilities: { fileTransfer: true },
  };
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  let executions = 0;
  workflow.setWorkspaceHostProvisioningExecutor(async () => {
    executions++;
    started();
    await blocked;
    return { status: 'succeeded', operationId: 'init-1', hostId: 'host-1' };
  });
  try {
    const accepted = await workflow.startWorkspaceHostInitializationWorkflow(request);
    expect(accepted.status).toBe('accepted');
    await running;
    expect(executions).toBe(1);
    const handle = DBOS.retrieveWorkflow(workspaceHostWorkflowKeys(request).workflowId);
    expect(await handle.getWorkflowInputs()).toEqual([{ ...request, action: 'initialize' }]);
    await expect(workflow.startWorkspaceHostInitializationWorkflow({ ...request, requestedAt: '2026-09-19T01:00:00Z' })).resolves.toEqual(accepted);
    await expect(workflow.startWorkspaceHostInitializationWorkflow({ ...request, operationId: 'competitor' })).rejects.toBeInstanceOf(workflow.WorkspaceHostProvisioningConflictError);
    await expect(workflow.startWorkspaceHostDesktopPackWorkflow({ workspaceId: request.workspaceId, hostId: request.hostId, operationId: 'pack-competitor', requestedAt: request.requestedAt, action: 'install-desktop-pack' })).rejects.toBeInstanceOf(workflow.WorkspaceHostProvisioningConflictError);
    await expect(workflow.startWorkspaceHostInitializationWorkflow({ ...request, requestedAgents: ['omp'] })).rejects.toBeInstanceOf(workflow.WorkspaceHostOperationIdentityConflictError);
    release();
    expect(await handle.getResult()).toMatchObject({ status: 'succeeded' });
    await expect(workflow.startWorkspaceHostInitializationWorkflow(request)).resolves.toEqual(accepted);
    expect(executions).toBe(1);
  } finally { release(); }
}, 30_000);

/** P-010: exercise SDK ERROR recovery and journal copying on an isolated PG DB. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, markManagedTestDatabase, teardownTestPg } from '@papercusp/test-config/pg';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { createHostedCustomerDeletionWorkflow, hostedCustomerDeletionEnqueueRequest } from './hosted-customer-deletion-workflow';
import { WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME } from './workspace-host-provision-workflow';
import { createWorkspaceHostProvisioningClient } from './workspace-host-provision-client';
import type { HostedCustomerDeletionRequest, HostedCustomerDeletionStep } from '../data-governance/hosted-customer-deletion';

let adminUri: string;
let dbName: string;
let sdk: DBOSClient;
let recover: ReturnType<typeof createWorkspaceHostProvisioningClient>;
let workflow: ReturnType<typeof createHostedCustomerDeletionWorkflow>;
const counts = { access: 0, workspace: 0, stripe: 0, workos: 0, database: 0 };
const audit: Array<{ step: HostedCustomerDeletionStep; status: string }> = [];
let providerAvailable = false;
const request: HostedCustomerDeletionRequest = {
  operationId: 'recovery-proof', organizationId: 'isolated-org', requestedBy: 'isolated-user',
  target: { kind: 'organization' }, policy: { approvalRef: 'test-only-approved', stripe: 'delete', consent: 'retain' },
};

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_deletion_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(adminUri); url.pathname = `/${dbName}`;
  DBOS.setConfig({ name: 'papercusp-deletion-recovery-test', systemDatabaseUrl: url.toString(),
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'deletion-recovery-v1', runAdminServer: false });
  workflow = createHostedCustomerDeletionWorkflow({ seams: {
    authorize: async () => {},
    access: async () => { counts.access++; return 'frozen'; },
    workspace: async () => { counts.workspace++; return 'destroyed'; },
    stripe: async () => { counts.stripe++; return 'deleted'; },
    workos: async () => {
      counts.workos++;
      if (!providerAvailable) throw new Error('isolated-provider-unavailable');
      return 'deleted';
    },
    database: async () => { counts.database++; return 'deleted'; },
    audit: async ({ step, status }) => { audit.push({ step, status }); },
  } });
  await DBOS.launch();
  sdk = await DBOSClient.create({ systemDatabaseUrl: url.toString(), systemDatabaseSchemaName: 'dbos' });
  recover = createWorkspaceHostProvisioningClient({ systemDatabaseUrl: url.toString(), appVersion: 'deletion-recovery-v1',
    createClient: async () => sdk });
}, 90_000);

afterAll(async () => {
  if (sdk) await sdk.destroy();
  await DBOS.shutdown();
  if (adminUri && dbName) {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
    finally { await admin.end({ timeout: 5 }); }
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

it('preserves ERROR and successful provider checkpoints while a linked recovery completes the same operation', async () => {
  // These warnings are the intentional outage exercised by this test. Assert
  // their exact population so an unrelated warning still fails the test.
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
  const originalId = hostedCustomerDeletionEnqueueRequest(request).workflowId;
  const handle = await DBOS.startWorkflow(workflow, { workflowID: originalId,
    queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME })(request);
  await expect(handle.getResult()).rejects.toThrow('customer-deletion:workos-failed');
  expect(counts).toEqual({ access: 1, workspace: 1, stripe: 1, workos: 3, database: 0 });
  const before = (await sdk.listWorkflowSteps(originalId))!;
  const failed = before.find(step => step.name === 'hosted-customer-deletion:workos')!;
  expect(failed.error).not.toBeNull();
  expect(audit).toContainEqual({ step: 'workos', status: 'failed' });

  providerAvailable = true;
  const result = await recover.recoverCustomerDeletion(request);
  expect(result).toMatchObject({ workflowId: `${originalId}:recovery:1`, operationId: request.operationId,
    originalWorkflowId: originalId, recoveredFromWorkflowId: originalId });
  await expect(sdk.retrieveWorkflow(result.workflowId).getResult()).resolves.toMatchObject({ operationId: request.operationId });
  expect(counts).toEqual({ access: 1, workspace: 1, stripe: 1, workos: 4, database: 1 });
  expect(await sdk.getWorkflow(originalId)).toMatchObject({ status: 'ERROR', input: [request] });
  expect(await sdk.getWorkflow(result.workflowId)).toMatchObject({ status: 'SUCCESS', forkedFrom: originalId, input: [request] });
  const after = (await sdk.listWorkflowSteps(result.workflowId))!;
  for (const step of before.filter(step => step.functionID < failed.functionID)) {
    expect(after.find(copied => copied.functionID === step.functionID)).toEqual(step);
  }
  expect(audit.filter(row => row.step === 'stripe')).toEqual([{ step: 'stripe', status: 'completed' }]);
  expect(audit.filter(row => row.step === 'workos')).toEqual([
    { step: 'workos', status: 'failed' }, { step: 'workos', status: 'completed' },
  ]);
  await expect(recover.recoverCustomerDeletion(request)).resolves.toMatchObject({ workflowId: result.workflowId, outcome: 'completed' });
  expect(counts.workos).toBe(4);
  expect(warnings).toHaveBeenCalledTimes(3);
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(warnings.mock.calls[attempt - 1]!.map(String).join(' ')).toContain(
      `Error in step being automatically retried. Attempt ${attempt} of 3. Error: isolated-provider-unavailable`);
  }
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0]!.map(String).join(' ')).toContain('customer-deletion:workos-failed');
  } finally { warnings.mockRestore(); errors.mockRestore(); }
}, 60_000);

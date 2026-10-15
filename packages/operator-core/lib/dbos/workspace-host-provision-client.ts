/**
 * Enqueue a workspace-host provision from a process that does NOT run DBOS.
 *
 * WHY (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, WI-10002240). The hosted control
 * plane (`serve.ts` under the hosted-control-plane profile) is request-only: it never runs
 * host-bootstrap, so `startDbos()` never runs there and `DBOS.startWorkflow` is unavailable.
 * The provisioning EXECUTOR already exists — the DBOS primary (the bg-host) drains the
 * `workspace-host-provision` queue — so the hosted process only needs to put the workflow on
 * that queue. A DBOS client does exactly that against the system database, without
 * launching an executor, recovering workflows, or registering anything.
 *
 * THE APP VERSION IS PINNED, NEVER LEFT NULL. The executor dequeues rows whose
 * `application_version` equals its own OR IS NULL, so a NULL-version row is claimable by ANY
 * DBOS host that registers this queue — including a staging host running different code
 * (the EI-90 appVersion war). The caller names the primary's version explicitly.
 *
 * The request (workflow id, dedup key, input) comes from
 * {@link workspaceHostProvisioningEnqueueRequest}, the same builder the in-process start
 * uses, so a client-enqueued provision is the same durable workflow as an in-process one.
 */
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { isDeepStrictEqual } from 'node:util';
import { withDbosIdleTxGrace } from './bootstrap';
import { hostedCustomerDeletionEnqueueRequest, HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME } from './hosted-customer-deletion-workflow';
import type { HostedCustomerDeletionRequest } from '../data-governance/hosted-customer-deletion';
import {
  WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
  workspaceHostDestroyEnqueueRequest,
  workspaceHostLifecycleEnqueueRequest,
  workspaceHostProvisioningEnqueueRequest,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
  type StartWorkspaceHostProvisioningInput,
} from './workspace-host-provision-workflow';

/** The subset of `DBOSClient` this module drives — the seam tests replace. */
export interface WorkspaceHostProvisioningDbosClient {
  enqueue(
    options: {
      queueName: string;
      workflowName: string;
      workflowID: string;
      deduplicationID: string;
      appVersion: string;
    },
    input: unknown,
  ): Promise<{ workflowID: string }>;
  getWorkflow?: DBOSClient['getWorkflow'];
  resumeWorkflow?: DBOSClient['resumeWorkflow'];
  forkWorkflow?: DBOSClient['forkWorkflow'];
  listWorkflowSteps?: DBOSClient['listWorkflowSteps'];
}

export interface WorkspaceHostProvisioningEnqueuer {
  /** Resolves once the workflow is durably ENQUEUED — not when provisioning finishes. */
  enqueue(input: StartWorkspaceHostProvisioningInput): Promise<{ workflowId: string }>;
}

/**
 * Lifecycle actions and destroy for an EXISTING host, enqueued the same way (WI-10005363). Without
 * it the hosted action route forwards the raw browser body to the controller's loopback route,
 * which drops every server-derived field (the actor) and answers a false 504 while the controller
 * waits out its admission window.
 */
export interface WorkspaceHostOperationEnqueuer {
  enqueueLifecycle(input: StartWorkspaceHostLifecycleInput): Promise<{ workflowId: string; operationId: string }>;
  enqueueDestroy(input: StartWorkspaceHostDestroyInput): Promise<{ workflowId: string; operationId: string }>;
}

/** Reuses the existing version-pinned client and queue. The hosted process
 * never registers or executes a customer deletion workflow. */
export interface HostedCustomerDeletionEnqueuer {
  enqueueCustomerDeletion(input: HostedCustomerDeletionRequest): Promise<{ workflowId: string; operationId: string }>;
  /** Internal support only; input MUST first be read from the admission ledger
   * and checked against the current server policy. ERROR recovery preserves the
   * operation and records an explicit, checkpoint-preserving attempt lineage. */
  recoverCustomerDeletion(input: HostedCustomerDeletionRequest): Promise<HostedCustomerDeletionRecovery>;
}

export interface HostedCustomerDeletionRecovery {
  workflowId: string;
  operationId: string;
  outcome: 'enqueued' | 'active' | 'completed' | 'resumed' | 'restarted';
  originalWorkflowId?: string;
  recoveredFromWorkflowId?: string;
}

export interface WorkspaceHostProvisioningClientOptions {
  readonly systemDatabaseUrl: string;
  /** The DBOS primary's `applicationVersion` (its `DBOS__APPVERSION`). Required. */
  readonly appVersion: string;
  readonly createClient?: (systemDatabaseUrl: string) => Promise<WorkspaceHostProvisioningDbosClient>;
}

async function createDbosClient(systemDatabaseUrl: string): Promise<WorkspaceHostProvisioningDbosClient> {
  // Same system database and schema the executor launched with (dbos/bootstrap.ts).
  return DBOSClient.create({
    systemDatabaseUrl: withDbosIdleTxGrace(systemDatabaseUrl),
    systemDatabaseSchemaName: 'dbos',
  }) as Promise<WorkspaceHostProvisioningDbosClient>;
}

export function createWorkspaceHostProvisioningClient(
  options: WorkspaceHostProvisioningClientOptions,
): WorkspaceHostProvisioningEnqueuer & WorkspaceHostOperationEnqueuer & HostedCustomerDeletionEnqueuer {
  const appVersion = options.appVersion.trim();
  if (!appVersion) throw new Error('workspace_host_provisioning_client_app_version_required');
  if (!options.systemDatabaseUrl.trim()) {
    throw new Error('workspace_host_provisioning_client_system_database_required');
  }
  const create = options.createClient ?? createDbosClient;
  let client: Promise<WorkspaceHostProvisioningDbosClient> | null = null;
  const connected = () => {
    // One pool per process, opened on first use; a failed open is retried next call.
    client ??= create(options.systemDatabaseUrl).catch((error: unknown) => {
      client = null;
      throw error;
    });
    return client;
  };

  // Reuse the existing governor-admitted queue and version-pinned client.
  const enqueueRequest = async (request: { workflowId: string; deduplicationId: string; workflowInput: unknown },
    workflowName: string = WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME) => {
    const handle = await (await connected()).enqueue(
      {
        queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
        workflowName,
        workflowID: request.workflowId,
        deduplicationID: request.deduplicationId,
        appVersion,
      },
      request.workflowInput,
    );
    return handle.workflowID;
  };

  const verifyWorkflow = (row: Awaited<ReturnType<DBOSClient['getWorkflow']>>, request: ReturnType<typeof hostedCustomerDeletionEnqueueRequest>,
    workflowId = request.workflowId, parent?: string) => {
    if (!row || row.workflowID !== workflowId || row.forkedFrom !== parent || row.workflowName !== HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME
      || row.workflowClassName !== '' || row.queueName !== WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME
      || row.applicationVersion !== appVersion || !isDeepStrictEqual(row.input, [request.workflowInput])) {
      throw new Error('customer_deletion_recovery_identity_mismatch');
    }
    return row;
  };

  return {
    async recoverCustomerDeletion(input) {
      const request = hostedCustomerDeletionEnqueueRequest(input);
      const dbos = await connected();
      if (!dbos.getWorkflow || !dbos.resumeWorkflow) throw new Error('customer_deletion_recovery_unavailable');
      let row = await dbos.getWorkflow(request.workflowId);
      const result = { workflowId: request.workflowId, operationId: input.operationId };
      if (!row) {
        if (await enqueueRequest(request, HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME) !== request.workflowId) {
          throw new Error('customer_deletion_recovery_identity_mismatch');
        }
        verifyWorkflow(await dbos.getWorkflow(request.workflowId), request);
        return { ...result, outcome: 'enqueued' };
      }
      let workflowId = request.workflowId;
      let parent: string | undefined;
      // D-012: SDK resume excludes ERROR. Preserve the failed row and all
      // successful checkpoints in a visibly linked attempt of the SAME operation.
      // The support service holds an operation advisory lock across this call.
      for (let attempt = 0; attempt <= 20; attempt++) {
        row = verifyWorkflow(row, request, workflowId, parent);
        const identity = parent ? { workflowId, operationId: input.operationId,
          originalWorkflowId: request.workflowId, recoveredFromWorkflowId: parent } : result;
        if (row.status === 'SUCCESS') return { ...identity, outcome: 'completed' };
        if (['ENQUEUED', 'PENDING', 'DELAYED'].includes(row.status)) return { ...identity, outcome: 'active' };
        if (row.status === 'ERROR') {
          if (attempt === 20) throw new Error('customer_deletion_recovery_attempt_limit');
          if (!dbos.forkWorkflow || !dbos.listWorkflowSteps) throw new Error('customer_deletion_recovery_unavailable');
          const nextId = `${request.workflowId}:recovery:${attempt + 1}`;
          const existing = await dbos.getWorkflow(nextId);
          if (existing) { parent = workflowId; workflowId = nextId; row = existing; continue; }
          // The fixed chain has <= 13 steps. Refuse an unexpected journal rather
          // than infer a restart point from a truncated or foreign population.
          const steps = await dbos.listWorkflowSteps(workflowId, { limit: 64 });
          if (!steps || steps.length >= 64 || steps.some(step => !Number.isInteger(step.functionID)
            || step.functionID < 0 || !step.name.startsWith('hosted-customer-deletion:') || step.childWorkflowID)) {
            throw new Error('customer_deletion_recovery_journal_invalid');
          }
          const failed = steps.filter(step => step.error !== null).map(step => step.functionID);
          const startStep = failed.length ? Math.min(...failed) : Math.max(-1, ...steps.map(step => step.functionID)) + 1;
          const forked = await dbos.forkWorkflow(workflowId, startStep, { newWorkflowID: nextId,
            applicationVersion: appVersion, queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME });
          if (forked !== nextId) throw new Error('customer_deletion_recovery_identity_mismatch');
          const accepted = verifyWorkflow(await dbos.getWorkflow(nextId), request, nextId, workflowId);
          if (!['ENQUEUED', 'PENDING', 'SUCCESS'].includes(accepted.status)) throw new Error('customer_deletion_recovery_unconfirmed');
          return { workflowId: nextId, operationId: input.operationId, originalWorkflowId: request.workflowId,
            recoveredFromWorkflowId: workflowId, outcome: accepted.status === 'SUCCESS' ? 'completed' : 'restarted' };
        }
        if (!['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row.status)) {
          throw new Error('customer_deletion_recovery_status_invalid');
        }
        await dbos.resumeWorkflow(workflowId, { queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME });
        const resumed = verifyWorkflow(await dbos.getWorkflow(workflowId), request, workflowId, parent);
        if (!['ENQUEUED', 'PENDING', 'SUCCESS'].includes(resumed.status)) throw new Error('customer_deletion_recovery_unconfirmed');
        return { ...identity, outcome: resumed.status === 'SUCCESS' ? 'completed' : 'resumed' };
      }
      throw new Error('customer_deletion_recovery_attempt_limit');
    },
    async enqueueCustomerDeletion(input) {
      const request = hostedCustomerDeletionEnqueueRequest(input);
      return { workflowId: await enqueueRequest(request, HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME), operationId: input.operationId };
    },
    async enqueue(input) {
      return { workflowId: await enqueueRequest(workspaceHostProvisioningEnqueueRequest(input)) };
    },
    async enqueueLifecycle(input) {
      const request = workspaceHostLifecycleEnqueueRequest(input);
      return { workflowId: await enqueueRequest(request), operationId: request.workflowInput.operationId };
    },
    async enqueueDestroy(input) {
      const request = workspaceHostDestroyEnqueueRequest(input);
      return { workflowId: await enqueueRequest(request), operationId: request.workflowInput.operationId };
    },
  };
}

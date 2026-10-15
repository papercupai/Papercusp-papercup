/** P-010 workspace teardown. Reuses the controller's stored connection/target
 * readers and its durable destroy workflow, including provider census and
 * customer-workspace offboarding. An enqueue/accepted result is never success. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { withWorkspace } from '@papercusp/db-org';
import { readWorkspaceHostConnection, readWorkspaceHostDestroyTarget } from '../workspace-host/observability-store';
import type { StartWorkspaceHostDestroyInput } from '../dbos/workspace-host-provision-workflow';
import type { HostedCustomerDeletionRequest, HostedCustomerDeletionSeams } from './hosted-customer-deletion';
import type { HostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';

interface DestroyResult { status: string; operationId: string; hostId: string }
export interface HostedCustomerDeletionWorkspaceOptions {
  readonly readAuthorizedSnapshot: (request: HostedCustomerDeletionRequest) => Promise<HostedCustomerDeletionSnapshot>;
  readonly runWorkspace?: <T>(workspaceId: string, fn: (tx: Sql) => Promise<T>) => Promise<T>;
  readonly readTarget?: typeof readWorkspaceHostDestroyTarget;
  readonly readConnection?: typeof readWorkspaceHostConnection;
  readonly destroy?: (input: StartWorkspaceHostDestroyInput) => Promise<DestroyResult>;
}

async function destroyThroughWorkflow(input: StartWorkspaceHostDestroyInput): Promise<DestroyResult> {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const { startWorkspaceHostDestroyWorkflow, workspaceHostDestroyEnqueueRequest } = await import('../dbos/workspace-host-provision-workflow');
  const child = workspaceHostDestroyEnqueueRequest(input);
  // A parent replay joins the original child, even if the start step did not
  // commit its journal after enqueue. Never manufacture a second destroy id.
  if (!await DBOS.getWorkflowStatus(child.workflowId)) {
    try { await startWorkspaceHostDestroyWorkflow(input); } catch (error) {
      if (!await DBOS.getWorkflowStatus(child.workflowId)) throw error;
    }
  }
  return DBOS.retrieveWorkflow<DestroyResult>(child.workflowId).getResult();
}

export function createHostedCustomerDeletionWorkspaceAdapter(
  options: HostedCustomerDeletionWorkspaceOptions,
): HostedCustomerDeletionSeams['workspace'] {
  const run = options.runWorkspace ?? withWorkspace;
  const readTarget = options.readTarget ?? readWorkspaceHostDestroyTarget;
  const readConnection = options.readConnection ?? readWorkspaceHostConnection;
  const destroy = options.destroy ?? destroyThroughWorkflow;
  return async request => {
    const snapshot = await options.readAuthorizedSnapshot(request);
    if (request.target.kind !== 'organization' || snapshot.request.operationId !== request.operationId
        || snapshot.request.organizationId !== request.organizationId || snapshot.request.target.kind !== 'organization') {
      throw new Error('customer-deletion:workspace-snapshot-mismatch');
    }
    for (const workspace of snapshot.workspaces) {
      if (!workspace.hostId || !workspace.workspaceId) throw new Error('customer-deletion:workspace-target-required');
      const input = await run(snapshot.controlPlaneWorkspaceId, async tx => {
        const target = await readTarget(snapshot.controlPlaneWorkspaceId, workspace.hostId, tx);
        if (!target || target.id !== workspace.hostId || target.desired.hostId !== workspace.hostId) {
          throw new Error('customer-deletion:workspace-target-unavailable');
        }
        const stored = await readConnection(snapshot.controlPlaneWorkspaceId, target.connectionId, tx);
        if (!stored || stored.id !== target.connectionId) throw new Error('customer-deletion:workspace-connection-unavailable');
        const operationId = `customer-delete-${createHash('sha256').update(JSON.stringify([
          request.organizationId, request.operationId, workspace.workspaceId, workspace.hostId,
        ])).digest('hex')}`;
        return { workspaceId: snapshot.controlPlaneWorkspaceId, hostId: workspace.hostId, connectionId: target.connectionId,
          connection: { ...stored.connection, scope: target.desired.scope }, disposition: 'discard' as const,
          operationId, actorId: request.requestedBy,
          confirmation: { expectedHostId: workspace.hostId, confirmedBy: request.requestedBy, confirmedAt: new Date().toISOString() },
        };
      });
      const result = await destroy(input);
      if (result.status !== 'succeeded' || result.operationId !== input.operationId || result.hostId !== input.hostId) {
        throw new Error('customer-deletion:workspace-destruction-unconfirmed');
      }
    }
    return 'workspace_destroy_workflows_completed';
  };
}

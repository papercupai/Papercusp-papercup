/** Hosted customer-data operations (cloud-portal P-010).
 * Uses the existing service transaction and the single organization receipt writer.
 */
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { createHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import { HostedSessionStore } from '../auth/hosted-session';
import { PostgresHostedMembershipAuthority } from '../auth/hosted-membership-authority';
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import type { HostedOrganizationRole } from '../auth/hosted-role-permissions';
import type { HostedCustomerDeletionPolicy, HostedCustomerDeletionRequest } from './hosted-customer-deletion';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { exportOrganizationData, type OrganizationDataExport } from './organization-data-receipts';

export class HostedCustomerDataAuthorizationError extends Error {
  constructor() { super('customer_data_forbidden'); }
}

/** Session, current membership and lifecycle checks remain locked until the export
 * and its receipt commit. A browser cannot choose an organization or workspace.
 */
export async function exportHostedOrganizationData(tx: Sql, principal: HostedPrincipal): Promise<OrganizationDataExport> {
  return exportHostedCustomerData(tx, principal, false);
}

export async function exportHostedUserData(tx: Sql, principal: HostedPrincipal): Promise<OrganizationDataExport> {
  return exportHostedCustomerData(tx, principal, true);
}

async function exportHostedCustomerData(tx: Sql, principal: HostedPrincipal, userOnly: boolean): Promise<OrganizationDataExport> {
  const { principal: fresh } = await authorizeHostedCustomerData(tx, principal, userOnly ? 'workspace:view' : 'members:manage');
  return exportOrganizationData(tx, {
    hostedReadBridge: true,
    executor: 'hosted-control-plane', scope: { organizationId: fresh.activeOrganizationId, workspaceIds: [],
      ...(userOnly ? { userId: fresh.userId } : {}) },
    actor: { kind: 'customer_user', principal: fresh }, purpose: userOnly ? 'Self-service user data export' : 'Self-service organization data export',
  }, tx);
}

async function authorizeHostedCustomerData(
  tx: Sql, principal: HostedPrincipal, permission: 'workspace:view' | 'members:manage' | 'workspace:destroy',
): Promise<{ principal: HostedPrincipal; role: HostedOrganizationRole }> {
  const session = await new HostedSessionStore(tx as never).resolveForUpdate(principal.sessionId, {
    expectedPermissionVersion: principal.sessionVersion,
  });
  if (!session || session.userId !== principal.userId || session.organizationId !== principal.activeOrganizationId
    || session.workspaceId !== (principal.selectedWorkspaceId ?? null)) {
    throw new HostedCustomerDataAuthorizationError();
  }
  const membership = await new PostgresHostedMembershipAuthority(tx as never).resolveActiveForUpdate({
    userId: principal.userId, organizationId: principal.activeOrganizationId,
  });
  if (!membership || membership.permissionVersion !== session.permissionVersion
    || !membership.permissions.has(permission)) throw new HostedCustomerDataAuthorizationError();
  const active = await tx`
    SELECT u.id FROM papercusp_auth.hosted_users u
      JOIN papercusp_auth.organizations o ON o.id = ${principal.activeOrganizationId}::uuid
     WHERE u.id = ${principal.userId}::uuid AND u.status = 'active' AND o.status = 'active'
     FOR SHARE OF u, o`;
  if (active.length !== 1) throw new HostedCustomerDataAuthorizationError();
  const fresh = createHostedPrincipal({ ...principal, permissions: membership.permissions });
  await tx`SELECT set_config('app.organization_id', ${fresh.activeOrganizationId}, true)`;
  return { principal: fresh, role: membership.role };
}

export class HostedCustomerDeletionAdmissionError extends Error {
  constructor(readonly code: 'confirmation_required' | 'retention_policy_pending' | 'transfer_organization_ownership_required') {
    super(code);
  }
}

/** Request-only composition: the admission receipt must COMMIT before an
 * independent DBOS executor can see the queued workflow. No workflow execution
 * or provider mutation takes place in the browser process. Queue failures leave
 * the immutable operation receipt available for operator recovery. */
export function createHostedCustomerDeletionRequester(options: {
  runService: HostedServiceContextRunner;
  resolveApprovedPolicy: () => Promise<HostedCustomerDeletionPolicy | null>;
  enqueueCustomerDeletion: (request: HostedCustomerDeletionRequest) => Promise<{ operationId: string }>;
}) {
  return async (principal: HostedPrincipal, input: { kind: 'organization' | 'user'; confirmation: string }) => {
    const request = await options.runService(tx => admitHostedCustomerDeletion(tx, principal, input, options.resolveApprovedPolicy));
    const queued = await options.enqueueCustomerDeletion(request);
    if (queued.operationId !== request.operationId) throw new Error('customer_deletion_enqueue_identity_mismatch');
    return { operationId: request.operationId };
  };
}

/** Read-side admission and immutable request receipt in the caller's service
 * transaction. The policy comes from server configuration/its approved decision,
 * never a browser field. Only the principal can select the organization/user.
 * Lifecycle freeze and destructive operations are owned by the durable workflow.
 */
export async function admitHostedCustomerDeletion(
  tx: Sql,
  principal: HostedPrincipal,
  input: { kind: 'organization' | 'user'; confirmation: string },
  resolveApprovedPolicy: () => Promise<HostedCustomerDeletionPolicy | null>,
): Promise<HostedCustomerDeletionRequest> {
  const userOnly = input.kind === 'user';
  if (!userOnly && input.kind !== 'organization') throw new HostedCustomerDataAuthorizationError();
  const { principal: fresh, role } = await authorizeHostedCustomerData(tx, principal, userOnly ? 'workspace:view' : 'workspace:destroy');
  if (!userOnly && role !== 'owner') throw new HostedCustomerDataAuthorizationError();
  if (input.confirmation !== (userOnly ? 'DELETE MY ACCOUNT' : 'DELETE ORGANIZATION')) {
    throw new HostedCustomerDeletionAdmissionError('confirmation_required');
  }
  if (userOnly) {
    // A global user deletion cannot orphan a tenant. Check every active
    // membership, not only the organization selected in the browser.
    const orphaned = await tx`
      SELECT m.organization_id FROM papercusp_auth.organization_memberships m
        JOIN papercusp_auth.organizations o ON o.id = m.organization_id
       WHERE m.user_id = ${fresh.userId}::uuid AND m.role = 'owner' AND m.status = 'active' AND o.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships other
           WHERE other.organization_id = m.organization_id AND other.user_id <> m.user_id
             AND other.role = 'owner' AND other.status = 'active')
       FOR SHARE OF m, o`;
    if (orphaned.length) throw new HostedCustomerDeletionAdmissionError('transfer_organization_ownership_required');
  }
  const policy = await resolveApprovedPolicy();
  if (!policy?.approvalRef?.trim() || !['delete', 'retain'].includes(policy.stripe)
    || !['delete', 'retain'].includes(policy.consent)) {
    throw new HostedCustomerDeletionAdmissionError('retention_policy_pending');
  }
  const request: HostedCustomerDeletionRequest = {
    operationId: randomUUID(), organizationId: fresh.activeOrganizationId, requestedBy: fresh.userId,
    target: userOnly ? { kind: 'user', userId: fresh.userId } : { kind: 'organization' }, policy,
  };
  await appendOrganizationAuditEvent({ organizationId: request.organizationId, actorKind: 'customer_user', actorId: fresh.userId,
    action: 'organization.data.deletion.requested', purpose: userOnly ? 'Self-service user deletion' : 'Self-service organization deletion',
    targetType: userOnly ? 'user' : 'organization', targetId: userOnly ? fresh.userId : request.organizationId,
    metadata: { operationId: request.operationId, kind: input.kind, policy: { ...policy } },
  }, tx);
  return request;
}

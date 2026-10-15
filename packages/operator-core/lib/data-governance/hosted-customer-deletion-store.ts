/** P-010 deletion storage. Reuses the append-only organization audit ledger and
 * its fixed hosted-service read bridge; no second operation table or admin pool.
 * All functions run in the caller's hosted-service transaction. */
import type { Sql } from 'postgres';
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import type { HostedCustomerDeletionPolicy, HostedCustomerDeletionRequest } from './hosted-customer-deletion';

export const HOSTED_DELETION_SNAPSHOT_ACTION = 'organization.data.deletion.access-frozen';

export type HostedCustomerDeletionSnapshot = {
  schemaVersion: 1;
  request: HostedCustomerDeletionRequest;
  controlPlaneWorkspaceId: string;
  organizationIdentity: { provider: string; subject: string };
  users: { userId: string; deleteUser: boolean; identities: { provider: string; subject: string }[] }[];
  workspaces: { workspaceId: string; hostId: string }[];
  stripeCustomerId: string | null;
};

function reject(code: string): never { throw new Error(`customer-deletion:${code}`); }

function assertTransaction(tx: Sql): void {
  if (typeof tx.begin === 'function') reject('transaction-required');
}

function matchesPolicy(a: HostedCustomerDeletionPolicy, b: HostedCustomerDeletionPolicy): boolean {
  return a.approvalRef === b.approvalRef && a.stripe === b.stripe && a.consent === b.consent;
}

function matchesRequest(a: HostedCustomerDeletionRequest, b: HostedCustomerDeletionRequest): boolean {
  return a.operationId === b.operationId && a.organizationId === b.organizationId && a.requestedBy === b.requestedBy
    && a.target.kind === b.target.kind && (a.target.kind !== 'user'
      || (b.target.kind === 'user' && a.target.userId === b.target.userId)) && matchesPolicy(a.policy, b.policy);
}

/** Recovery accepts ledger coordinates, never a replacement actor, target or
 * policy. Reconstruct the original request even after local access is frozen. */
export async function readAdmittedHostedCustomerDeletion(
  tx: Sql, organizationId: string, operationId: string,
  resolveApprovedPolicy: () => Promise<HostedCustomerDeletionPolicy | null>,
): Promise<HostedCustomerDeletionRequest> {
  assertTransaction(tx);
  await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`;
  const rows = await tx<{ data: { actor_kind: string; actor_id: string; target_type: string; target_id: string;
    metadata: { kind: string; policy: HostedCustomerDeletionPolicy } } }[]>`
    SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
      'papercusp_auth.organization_audit_events', ${organizationId})
     WHERE data->>'action' = 'organization.data.deletion.requested'
       AND data->'metadata'->>'operationId' = ${operationId}`;
  const receipt = rows[0]?.data;
  if (rows.length !== 1 || !receipt || receipt.actor_kind !== 'customer_user' || !receipt.actor_id?.trim()
    || !receipt.metadata?.policy || !['organization', 'user'].includes(receipt.target_type)) reject('admission-mismatch');
  const request: HostedCustomerDeletionRequest = { organizationId, operationId, requestedBy: receipt.actor_id,
    target: receipt.target_type === 'user' ? { kind: 'user', userId: receipt.target_id } : { kind: 'organization' },
    policy: receipt.metadata.policy };
  await authorizeHostedCustomerDeletion(tx, request, resolveApprovedPolicy);
  return request;
}

/** A workflow argument or an approval-ref string is not authority. Require the
 * server-owned approved values and the exact immutable admission receipt. */
export async function authorizeHostedCustomerDeletion(
  tx: Sql, request: HostedCustomerDeletionRequest,
  resolveApprovedPolicy: () => Promise<HostedCustomerDeletionPolicy | null>,
): Promise<void> {
  assertTransaction(tx);
  const policy = await resolveApprovedPolicy();
  if (!policy?.approvalRef?.trim() || !['delete', 'retain'].includes(policy.stripe)
    || !['delete', 'retain'].includes(policy.consent) || !matchesPolicy(policy, request.policy)) {
    reject('retention-policy-not-approved');
  }
  if (request.target.kind !== 'organization' && request.target.kind !== 'user') reject('admission-mismatch');
  if (request.target.kind === 'user' && request.target.userId !== request.requestedBy) reject('admission-mismatch');
  await tx`SELECT set_config('app.organization_id', ${request.organizationId}, true)`;
  const rows = await tx<{ data: { actor_kind: string; actor_id: string; target_id: string; target_type: string;
    metadata: { kind: string; policy: HostedCustomerDeletionPolicy } } }[]>`
    SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
      'papercusp_auth.organization_audit_events', ${request.organizationId})
     WHERE data->>'action' = 'organization.data.deletion.requested'
       AND data->'metadata'->>'operationId' = ${request.operationId}`;
  const receipt = rows[0]?.data;
  if (rows.length !== 1 || !receipt || receipt.actor_kind !== 'customer_user' || receipt.actor_id !== request.requestedBy
    || receipt.target_type !== request.target.kind
    || receipt.target_id !== (request.target.kind === 'user' ? request.target.userId : request.organizationId)
    || receipt.metadata.kind !== request.target.kind || !receipt.metadata.policy
    || !matchesPolicy(receipt.metadata.policy, request.policy)) reject('admission-mismatch');
}

/** Read saved targets after access/bindings have gone away. Later provider and
 * database adapters must use this snapshot, never re-discover a smaller scope. */
export async function readHostedCustomerDeletionSnapshot(
  tx: Sql, request: HostedCustomerDeletionRequest,
): Promise<HostedCustomerDeletionSnapshot | null> {
  assertTransaction(tx);
  await tx`SELECT set_config('app.organization_id', ${request.organizationId}, true)`;
  const rows = await tx<{ data: { metadata: { snapshot: HostedCustomerDeletionSnapshot } } }[]>`
    SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
      'papercusp_auth.organization_audit_events', ${request.organizationId})
     WHERE data->>'action' = ${HOSTED_DELETION_SNAPSHOT_ACTION}
       AND data->'metadata'->>'operationId' = ${request.operationId}`;
  if (!rows.length) return null;
  const snapshot = rows[0]?.data.metadata.snapshot;
  if (rows.length !== 1 || !snapshot || snapshot.schemaVersion !== 1 || !matchesRequest(snapshot.request, request)) {
    reject('snapshot-mismatch');
  }
  return snapshot;
}

/** Snapshot, lifecycle freeze and local credential revocation commit together.
 * An audit failure rolls everything back; a replay returns the ORIGINAL targets.
 * Organization deletion preserves users who still belong to another tenant. */
export async function freezeHostedCustomerDeletionAccess(
  tx: Sql, request: HostedCustomerDeletionRequest, controlPlaneWorkspaceId: string,
  resolveApprovedPolicy: () => Promise<HostedCustomerDeletionPolicy | null>,
): Promise<HostedCustomerDeletionSnapshot> {
  await authorizeHostedCustomerDeletion(tx, request, resolveApprovedPolicy);
  if (!controlPlaneWorkspaceId.trim()) reject('control-plane-required');
  // Serialize competing operations on the same tenant, including snapshot dedup.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion:${request.organizationId}`}, 0))`;
  const previous = await readHostedCustomerDeletionSnapshot(tx, request);
  if (previous) {
    if (previous.controlPlaneWorkspaceId !== controlPlaneWorkspaceId) reject('control-plane-mismatch');
    return previous;
  }
  const userId = request.target.kind === 'user' ? request.target.userId : null;
  // Lock every affected organization for a global user deletion. Concurrent
  // deletion/ownership changes cannot both pass a sole-owner check.
  const organizations = await tx<{ id: string; status: string; identity_provider: string; external_organization_id: string }[]>`
    SELECT id::text AS id, status, identity_provider, external_organization_id
      FROM papercusp_auth.organizations
     WHERE id = ${request.organizationId}::uuid OR (${userId}::uuid IS NOT NULL AND id IN (
       SELECT organization_id FROM papercusp_auth.organization_memberships WHERE user_id = ${userId}::uuid))
     ORDER BY id FOR UPDATE`;
  const organization = organizations.find(o => o.id === request.organizationId);
  if (!organization || organization.status !== 'active') reject('organization-not-active');
  const membership = await tx<{ role: string }[]>`
    SELECT role FROM papercusp_auth.organization_memberships
     WHERE organization_id = ${request.organizationId}::uuid AND user_id = ${request.requestedBy}::uuid AND status = 'active'
     FOR UPDATE`;
  if (membership.length !== 1 || (!userId && membership[0]?.role !== 'owner')) reject('authority-revoked');
  if (userId) {
    const orphaned = await tx`
      SELECT m.organization_id FROM papercusp_auth.organization_memberships m
        JOIN papercusp_auth.organizations o ON o.id = m.organization_id
       WHERE m.user_id = ${userId}::uuid AND m.role = 'owner' AND m.status = 'active' AND o.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships other
           WHERE other.organization_id = m.organization_id AND other.user_id <> m.user_id
             AND other.role = 'owner' AND other.status = 'active') FOR UPDATE OF m`;
    if (orphaned.length) reject('transfer-organization-ownership-required');
  }
  const users = await tx<{ id: string; status: string; delete_user: boolean }[]>`
    SELECT u.id::text AS id, u.status, (${userId}::uuid IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM papercusp_auth.organization_memberships m JOIN papercusp_auth.organizations o ON o.id = m.organization_id
       WHERE m.user_id = u.id AND m.organization_id <> ${request.organizationId}::uuid
         AND m.status <> 'revoked' AND o.status <> 'deleted')) AS delete_user
      FROM papercusp_auth.hosted_users u
     WHERE (${userId}::uuid IS NOT NULL AND u.id = ${userId}::uuid) OR (${userId}::uuid IS NULL AND EXISTS (
       SELECT 1 FROM papercusp_auth.organization_memberships m
        WHERE m.organization_id = ${request.organizationId}::uuid AND m.user_id = u.id))
     ORDER BY u.id FOR UPDATE OF u`;
  if (userId && (users.length !== 1 || users[0]?.status !== 'active')) reject('user-not-active');
  for (const user of users) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion-user:${user.id}`}, 0))`;
  }
  // Re-read after acquiring the same per-user lock as the activation trigger.
  // A concurrent new membership that committed while we waited must keep its
  // shared account, rather than inheriting the earlier statement's snapshot.
  if (!userId) {
    const shared = await tx<{ user_id: string }[]>`
      SELECT DISTINCT m.user_id::text AS user_id FROM papercusp_auth.organization_memberships m
        JOIN papercusp_auth.organizations o ON o.id = m.organization_id
       WHERE m.user_id = ANY(${tx.array(users.map(u => u.id))}::uuid[])
         AND m.organization_id <> ${request.organizationId}::uuid AND m.status <> 'revoked' AND o.status <> 'deleted'`;
    const sharedIds = new Set(shared.map(row => row.user_id));
    for (const user of users) user.delete_user = !sharedIds.has(user.id);
  }
  const identities = await tx<{ hosted_user_id: string; provider: string; subject: string }[]>`
    SELECT hosted_user_id::text AS hosted_user_id, provider, subject FROM papercusp_auth.external_identities
     WHERE hosted_user_id = ANY(${tx.array(users.map(u => u.id))}::uuid[]) ORDER BY provider, subject FOR UPDATE`;
  const workspaceRows = userId ? [] : await tx<{ data: {
    workspace_id: string; id: string; workspace_host_id: string; state: string;
  } }[]>`SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
    'harness_shared.customer_workspaces', ${request.organizationId})`;
  const billing = userId ? [] : await tx<{ stripe_customer_id: string }[]>`
    SELECT stripe_customer_id FROM papercusp_auth.hosted_billing_customers
     WHERE organization_id = ${request.organizationId}::uuid FOR UPDATE`;
  const snapshot: HostedCustomerDeletionSnapshot = {
    schemaVersion: 1, request, controlPlaneWorkspaceId,
    organizationIdentity: { provider: organization.identity_provider, subject: organization.external_organization_id },
    users: users.map(u => ({ userId: u.id, deleteUser: u.delete_user,
      identities: identities.filter(i => i.hosted_user_id === u.id).map(i => ({ provider: i.provider, subject: i.subject })) })),
    workspaces: workspaceRows.filter(r => r.data.workspace_id === controlPlaneWorkspaceId && r.data.state !== 'deleted')
      .map(r => ({ workspaceId: r.data.id, hostId: r.data.workspace_host_id }))
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    stripeCustomerId: billing[0]?.stripe_customer_id ?? null,
  };
  const deletedUserIds = snapshot.users.filter(u => u.deleteUser).map(u => u.userId);
  if (!userId) await tx`UPDATE papercusp_auth.organizations SET status = 'offboarding', offboarding_at = now(), updated_at = now()
    WHERE id = ${request.organizationId}::uuid`;
  await tx`UPDATE papercusp_auth.hosted_users SET status = 'deactivated', deactivated_at = now(), updated_at = now()
    WHERE id = ANY(${tx.array(deletedUserIds)}::uuid[]) AND status = 'active'`;
  await tx`UPDATE papercusp_auth.external_identities SET status = 'deactivated', deactivated_at = now(), updated_at = now()
    WHERE hosted_user_id = ANY(${tx.array(deletedUserIds)}::uuid[]) AND status = 'active'`;
  await tx`UPDATE papercusp_auth.organization_memberships SET status = 'revoked', revoked_at = now(), updated_at = now()
    WHERE (organization_id = ${request.organizationId}::uuid AND ${userId}::uuid IS NULL)
       OR user_id = ANY(${tx.array(deletedUserIds)}::uuid[])`;
  await tx`UPDATE papercusp_auth.organization_invitation_refs SET status = 'revoked', revoked_at = now(), updated_at = now()
    WHERE organization_id = ${request.organizationId}::uuid AND ${userId}::uuid IS NULL AND status = 'pending'`;
  // Remove the sealed provider sessions before revocation, without ever putting
  // cookies, hashes, session ids or credentials into the durable snapshot.
  await tx`DELETE FROM papercusp_auth.workos_sealed_sessions WHERE external_session_id IN (
    SELECT upstream_session_id FROM papercusp_auth.hosted_sessions WHERE
      (organization_id = ${request.organizationId} AND ${userId}::uuid IS NULL)
      OR user_id = ANY(${tx.array(deletedUserIds)}::text[]))`;
  await tx`UPDATE papercusp_auth.hosted_sessions SET revoked_at = COALESCE(revoked_at, now()),
    revocation_reason = COALESCE(revocation_reason, 'customer_deletion'), updated_at = now()
    WHERE (organization_id = ${request.organizationId} AND ${userId}::uuid IS NULL)
       OR user_id = ANY(${tx.array(deletedUserIds)}::text[])`;
  await tx`UPDATE papercusp_auth.hosted_cli_tokens SET revoked_at = COALESCE(revoked_at, now()),
    revocation_reason = COALESCE(revocation_reason, 'customer_deletion')
    WHERE (organization_id = ${request.organizationId} AND ${userId}::uuid IS NULL)
       OR user_id = ANY(${tx.array(deletedUserIds)}::text[])`;
  await tx`DELETE FROM papercusp_auth.hosted_cli_device_grants
    WHERE (organization_id = ${request.organizationId} AND ${userId}::uuid IS NULL)
       OR user_id = ANY(${tx.array(deletedUserIds)}::text[])`;
  await tx`DELETE FROM papercusp_auth.hosted_mcp_oauth_requests
    WHERE (organization_id = ${request.organizationId} AND ${userId}::uuid IS NULL)
       OR approved_by = ANY(${tx.array(deletedUserIds)}::text[])`;
  await tx`DELETE FROM papercusp_auth.hosted_workspace_connector_tickets
    WHERE (organization_id = ${request.organizationId} AND ${userId}::uuid IS NULL)
       OR user_id = ANY(${tx.array(deletedUserIds)}::text[])`;
  if (!userId) await tx`UPDATE papercusp_auth.hosted_workspace_connectors
    SET state = 'revoked', credential_hash = NULL, revoked_at = COALESCE(revoked_at, now()), updated_at = now()
    WHERE organization_id = ${request.organizationId}`;
  await appendOrganizationAuditEvent({ organizationId: request.organizationId, actorKind: 'system',
    actorId: 'customer-deletion', action: HOSTED_DELETION_SNAPSHOT_ACTION, purpose: 'Durable customer deletion targets and access revocation',
    targetType: request.target.kind, targetId: userId ?? request.organizationId,
    metadata: { operationId: request.operationId, snapshot: { ...snapshot, request: {
      ...request, target: { ...request.target }, policy: { ...request.policy },
    } } },
  }, tx);
  return snapshot;
}

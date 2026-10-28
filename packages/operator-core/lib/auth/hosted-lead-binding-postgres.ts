/** D-052 storage boundary. The host must authenticate the signed token and
 * current issuer/graph authority before calling issue/redeem. This adapter
 * rechecks hosted authority and serializes redemption in hosted_service.
 * Nothing here grants analytics consent or treats email as identity proof. */
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { HostedSessionStore } from './hosted-session';
import { PostgresHostedMembershipAuthority } from './hosted-membership-authority';
import { isHostedPrincipal, type HostedPrincipal } from './hosted-principal';
import type { HostedServiceContextRunner } from './hosted/workos-lifecycle-postgres';
import { parseHostedLeadBindingChallenge, parseHostedLeadBindingScope,
  type HostedLeadBindingChallenge, type HostedLeadBindingScope } from './hosted-lead-binding';

interface BindingRow {
  challenge_id: string; graph_workspace_id: string; person_ref: string;
  environment: HostedLeadBindingScope['environment']; issuer_ref: string;
  issued_at: Date; expires_at: Date; redeemed_at: Date | null; revoked_at: Date | null;
  organization_id: string | null; user_id: string | null;
}
export interface HostedLeadBindingReceipt extends HostedLeadBindingScope {
  ref: string; userId: string; organizationId: string; redeemedAt: string;
}
function sameClaim(row: BindingRow, claim: HostedLeadBindingChallenge): boolean {
  return row.challenge_id === claim.challengeId && row.graph_workspace_id === claim.graphWorkspaceId &&
    row.person_ref === claim.personRef && row.environment === claim.environment && row.issuer_ref === claim.issuerRef &&
    new Date(row.issued_at).getTime() === claim.issuedAt && new Date(row.expires_at).getTime() === claim.expiresAt;
}
function receipt(row: BindingRow): HostedLeadBindingReceipt | null {
  if (!row.redeemed_at || row.revoked_at || !row.user_id || !row.organization_id) return null;
  return { ref: `hosted-lead-binding:${row.challenge_id}`, graphWorkspaceId: row.graph_workspace_id,
    personRef: row.person_ref, environment: row.environment, userId: row.user_id,
    organizationId: row.organization_id, redeemedAt: new Date(row.redeemed_at).toISOString() };
}
async function currentPrincipal(sql: Sql, principal: HostedPrincipal): Promise<boolean> {
  if (!isHostedPrincipal(principal)) return false;
  const session = await new HostedSessionStore(sql).resolveForUpdate(principal.sessionId,
    { expectedPermissionVersion: principal.sessionVersion });
  if (!session || session.userId !== principal.userId || session.organizationId !== principal.activeOrganizationId) return false;
  const member = await new PostgresHostedMembershipAuthority(sql).resolveActiveForUpdate({
    userId: principal.userId, organizationId: principal.activeOrganizationId });
  if (!member || member.permissionVersion !== principal.sessionVersion) return false;
  const active = await sql`SELECT u.id FROM papercusp_auth.hosted_users u
    JOIN papercusp_auth.organizations o ON o.id = ${principal.activeOrganizationId}::uuid
    WHERE u.id = ${principal.userId}::uuid AND u.status = 'active' AND o.status = 'active'
    FOR UPDATE OF u, o`;
  return active.length === 1;
}

export class PostgresHostedLeadBindingStore {
  constructor(private readonly run: HostedServiceContextRunner = fn => withHostedServiceContext(fn)) {}

  /** Called only after operator issuance/graph authorization. Same-id retries
   * preserve the original signed scope; conflicting retries are refused. */
  async issue(input: HostedLeadBindingChallenge): Promise<void> {
    const claim = parseHostedLeadBindingChallenge(input);
    await this.run(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_lead_bindings
        (challenge_id, graph_workspace_id, person_ref, environment, issuer_ref, issued_at, expires_at)
        SELECT ${claim.challengeId}::uuid, ${claim.graphWorkspaceId}, ${claim.personRef}, ${claim.environment},
          ${claim.issuerRef}, ${new Date(claim.issuedAt)}, ${new Date(claim.expiresAt)}
        WHERE clock_timestamp() >= ${new Date(claim.issuedAt)} AND clock_timestamp() < ${new Date(claim.expiresAt)}
        ON CONFLICT (challenge_id) DO NOTHING`;
      const [row] = await sql<BindingRow[]>`SELECT * FROM papercusp_auth.hosted_lead_bindings
        WHERE challenge_id = ${claim.challengeId}::uuid FOR UPDATE`;
      if (!row || !sameClaim(row, claim) || row.revoked_at) throw new Error('lead_binding_issue_conflict');
    });
  }

  /** The caller supplies a verified token's claim, never request JSON. A
   * different user/org replay returns null; a matching retry returns its receipt. */
  async redeem(input: HostedLeadBindingChallenge, principal: HostedPrincipal): Promise<HostedLeadBindingReceipt | null> {
    const claim = parseHostedLeadBindingChallenge(input);
    return this.run(async sql => {
      if (!await currentPrincipal(sql, principal)) return null;
      const [row] = await sql<BindingRow[]>`SELECT * FROM papercusp_auth.hosted_lead_bindings
        WHERE challenge_id = ${claim.challengeId}::uuid FOR UPDATE`;
      if (!row || !sameClaim(row, claim) || row.revoked_at) return null;
      if (row.redeemed_at) return row.user_id === principal.userId && row.organization_id === principal.activeOrganizationId ? receipt(row) : null;
      const [updated] = await sql<BindingRow[]>`UPDATE papercusp_auth.hosted_lead_bindings
        SET user_id = ${principal.userId}::uuid, organization_id = ${principal.activeOrganizationId}::uuid,
          redeemed_at = clock_timestamp()
        WHERE challenge_id = ${claim.challengeId}::uuid AND redeemed_at IS NULL AND revoked_at IS NULL
          AND clock_timestamp() >= issued_at AND clock_timestamp() < expires_at RETURNING *`;
      return updated ? receipt(updated) : null;
    });
  }

  async read(input: HostedLeadBindingScope, principal: HostedPrincipal): Promise<HostedLeadBindingReceipt | null> {
    const scope = parseHostedLeadBindingScope(input);
    return this.run(async sql => {
      if (!await currentPrincipal(sql, principal)) return null;
      const [row] = await sql<BindingRow[]>`SELECT * FROM papercusp_auth.hosted_lead_bindings
        WHERE graph_workspace_id = ${scope.graphWorkspaceId} AND person_ref = ${scope.personRef}
          AND environment = ${scope.environment} AND user_id = ${principal.userId}::uuid
          AND organization_id = ${principal.activeOrganizationId}::uuid
          AND redeemed_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`;
      return row ? receipt(row) : null;
    });
  }

  async revoke(input: HostedLeadBindingScope, principal: HostedPrincipal): Promise<boolean> {
    const scope = parseHostedLeadBindingScope(input);
    return this.run(async sql => {
      if (!await currentPrincipal(sql, principal)) return false;
      const rows = await sql`UPDATE papercusp_auth.hosted_lead_bindings SET revoked_at = clock_timestamp()
        WHERE graph_workspace_id = ${scope.graphWorkspaceId} AND person_ref = ${scope.personRef}
          AND environment = ${scope.environment} AND user_id = ${principal.userId}::uuid
          AND organization_id = ${principal.activeOrganizationId}::uuid
          AND redeemed_at IS NOT NULL AND revoked_at IS NULL RETURNING challenge_id`;
      return rows.length === 1;
    });
  }
}

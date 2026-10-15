/** Internal P-010 support operations. Reuses customer consent, the immutable
 * admission, the canonical export writer and the version-pinned DBOS client.
 * This consumer does not grant staff capabilities or expose a public route. */
import { randomUUID } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Principal } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { HostedCustomerDeletionEnqueuer, HostedCustomerDeletionRecovery } from '../dbos/workspace-host-provision-client';
import { resolveApprovedHostedCustomerDeletionPolicy, type HostedCustomerDeletionPolicy } from './hosted-customer-deletion';
import { readAdmittedHostedCustomerDeletion } from './hosted-customer-deletion-store';
import { exportOrganizationData, type OrganizationDataExport } from './organization-data-receipts';

export const CUSTOMER_DELETION_RECOVERY_SCOPE = 'customer-data:deletion:recover';
export const CUSTOMER_DATA_EXPORT_SCOPE = 'customer-data:export';

function requireStaff(principal: Principal | null, scope: string): string {
  if (!principal || principal.kind !== 'user' || principal.trust !== 'verified'
    || principal.authMethod !== 'cookie-session' || !principal.slug.trim() || !principal.roles?.has('staff')
    || !principal.capabilities.has(scope)) throw new Error('customer_data_support_staff_required');
  return principal.slug;
}

export class PostgresHostedCustomerDataSupport {
  constructor(private readonly options: {
    client: Pick<HostedCustomerDeletionEnqueuer, 'recoverCustomerDeletion'>;
    runService?: HostedServiceContextRunner;
    resolveApprovedPolicy?: () => Promise<HostedCustomerDeletionPolicy | null>;
  }) {}

  async exportData(principal: Principal | null, input: {
    organizationId: string; grantId: string; userId?: string;
  }): Promise<OrganizationDataExport> {
    const pin = { ...input, staffId: requireStaff(principal, CUSTOMER_DATA_EXPORT_SCOPE) };
    const run = this.options.runService ?? withHostedServiceContext;
    return run(async tx => {
      await tx`SELECT set_config('app.organization_id', ${pin.organizationId}, true)`;
      // Serialize with the deletion freeze, then keep lifecycle stable until
      // both the export and its canonical receipt commit.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion:${pin.organizationId}`}, 0))`;
      const [organization] = await tx<{ status: string; frozen: boolean }[]>`
        SELECT status, papercusp_auth.hosted_customer_deletion_frozen(id::text, NULL) AS frozen
          FROM papercusp_auth.organizations WHERE id = ${pin.organizationId}::uuid FOR SHARE`;
      if (!organization || organization.status !== 'active' || organization.frozen !== false) {
        throw new Error('customer_data_support_organization_inactive');
      }
      const authorize = async () => {
        const grants = await tx<{ purpose: string }[]>`
          SELECT data->>'purpose' AS purpose FROM papercusp_auth.read_hosted_customer_export_rows(
            'papercusp_auth.support_access_grants', ${pin.organizationId})
           WHERE data->>'id' = ${pin.grantId} AND data->>'organization_id' = ${pin.organizationId}
             AND data->>'staff_principal_id' = ${pin.staffId} AND data->>'workspace_id' IS NULL
             AND data->'scopes' @> jsonb_build_array(${CUSTOMER_DATA_EXPORT_SCOPE}::text)
             AND (data->>'starts_at')::timestamptz <= clock_timestamp()
             AND (data->>'expires_at')::timestamptz > clock_timestamp() AND data->>'revoked_at' IS NULL`;
        if (grants.length !== 1 || !grants[0]?.purpose.trim()) throw new Error('customer_data_support_grant_inactive');
        return grants[0].purpose;
      };
      const purpose = await authorize();
      const result = await exportOrganizationData(tx, {
        hostedReadBridge: true, executor: 'hosted-control-plane',
        scope: { organizationId: pin.organizationId, workspaceIds: [],
          ...(pin.userId === undefined ? {} : { userId: pin.userId }) },
        actor: { kind: 'staff_admin', id: pin.staffId }, purpose,
      }, tx);
      // Expiry or revocation during a long export rolls its receipt back and
      // prevents the materialized customer data leaving the service.
      await authorize();
      return result;
    });
  }

  async recoverDeletion(principal: Principal | null, input: { organizationId: string; operationId: string; grantId: string }) {
    const pin = { ...input, staffId: requireStaff(principal, CUSTOMER_DELETION_RECOVERY_SCOPE), attemptId: randomUUID() };
    const run = this.options.runService ?? withHostedServiceContext;
    const policy = this.options.resolveApprovedPolicy ?? resolveApprovedHostedCustomerDeletionPolicy;
    const authorize = async (tx: Sql) => {
      await tx`SELECT set_config('app.organization_id', ${pin.organizationId}, true)`;
      const grants = await tx<{ purpose: string }[]>`
        SELECT data->>'purpose' AS purpose FROM papercusp_auth.read_hosted_customer_export_rows(
          'papercusp_auth.support_access_grants', ${pin.organizationId})
         WHERE data->>'id' = ${pin.grantId} AND data->>'staff_principal_id' = ${pin.staffId}
           AND data->>'workspace_id' IS NULL
           AND data->'scopes' @> jsonb_build_array(${CUSTOMER_DELETION_RECOVERY_SCOPE}::text)
           AND (data->>'starts_at')::timestamptz <= clock_timestamp()
           AND (data->>'expires_at')::timestamptz > clock_timestamp() AND data->>'revoked_at' IS NULL`;
      if (grants.length !== 1 || !grants[0]?.purpose.trim()) throw new Error('customer_data_support_grant_inactive');
      // Frozen lifecycle is expected here. It never grants arbitrary reads or
      // new deletion authority: only this previously admitted operation may run.
      return { purpose: grants[0].purpose, request: await readAdmittedHostedCustomerDeletion(tx,
        pin.organizationId, pin.operationId, policy) };
    };
    const receipt = (tx: Sql, purpose: string, phase: string, result?: HostedCustomerDeletionRecovery) => appendOrganizationAuditEvent({
      organizationId: pin.organizationId, actorKind: 'staff_admin', actorId: pin.staffId,
      action: `organization.data.deletion.recovery.${phase}`, purpose, targetType: 'deletion_operation', targetId: pin.operationId,
      metadata: { operationId: pin.operationId, grantId: pin.grantId, attemptId: pin.attemptId,
        ...(result ? { workflowId: result.workflowId, originalWorkflowId: result.originalWorkflowId ?? result.workflowId,
          recoveredFromWorkflowId: result.recoveredFromWorkflowId ?? null } : {}) },
    }, tx);
    // The attempt must be durably auditable BEFORE a separate DBOS write.
    await run(async tx => { const { purpose } = await authorize(tx); await receipt(tx, purpose, 'requested'); });
    return run(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion-recovery:${pin.organizationId}:${pin.operationId}`}, 0))`;
      const { purpose, request } = await authorize(tx);
      const result = await this.options.client.recoverCustomerDeletion(request);
      await receipt(tx, purpose, result.outcome, result);
      return result;
    });
  }
}

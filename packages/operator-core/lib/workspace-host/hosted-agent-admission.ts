/** P-537: tenant admission inside the existing governor receipt transaction.
 * The connector binding is supplied by server authentication, never request metadata.
 * Queued starts and running agents consume the same canonical organization allowance.
 */
import type { Sql } from 'postgres';
import { checkHostedEntitlement } from '../auth/hosted-entitlements';
import { readHostedEntitlementAuthority } from '../auth/hosted-entitlement-store';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import type { DurableAdmissionRecord, SqlClient } from '../resource-governor/queue';
import { WorkItemAdmissionQueueDriver } from '../resource-governor/queue';
import { Governor } from '../resource-governor/admission';
import { PgAdmissionLedgerQueueStore } from '../resource-governor/admission-ledger-store';
import { boundedOrgTxn } from '../pg-bounded-txn';

export function hostedPoolAgentAdmissionGuard(authenticated: HostedConnectorBinding) {
  const binding = Object.freeze({ ...authenticated });
  return async (client: SqlClient, record: DurableAdmissionRecord): Promise<Record<string, string | number | boolean | null>> => {
    if (binding.state !== 'active' || record.admissionClass !== 'agent' || record.coalesceKey ||
        record.metadata.hostedOrganizationId !== binding.organizationId ||
        record.metadata.hostedCustomerWorkspaceId !== binding.customerWorkspaceId ||
        record.metadata.hostedHostId !== binding.hostId ||
        record.metadata.hostedConnectorGeneration !== binding.generation) {
      throw new Error('hosted_pool_agent_binding_mismatch');
    }
    const tx = client as Sql;
    // Match lifecycle admission's lock order: directory BEFORE organization.
    // The governor's admin transaction can read the directory; hosted_service
    // deliberately cannot. Never join that table into a service-role query.
    const customers = await tx<Array<{ id: string }>>`
      SELECT id FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${binding.controlPlaneWorkspaceId}
        AND organization_id = ${binding.organizationId}
        AND id = ${binding.customerWorkspaceId} AND workspace_host_id = ${binding.hostId}
        AND kind = 'hosted' AND state = 'active' FOR SHARE`;
    if (customers.length !== 1) throw new Error('hosted_pool_agent_binding_inactive');
    // Every stop admission holds the directory row through its operation INSERT.
    // Thus a concurrent start either contributes a receipt BEFORE the stop's
    // inventory, or sees the admitted drain here and cannot create new demand.
    // Keep this fence independent of the idle-stop marker: an operator-requested
    // stop also powers off the guest, so accepting a new process after that stop
    // was queued would create work with no live host to own it.
    const draining = await tx<Array<{ id: string }>>`
      SELECT id FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${binding.controlPlaneWorkspaceId} AND host_id = ${binding.hostId}
        AND customer_workspace_id = ${binding.customerWorkspaceId}
        AND action = 'stop' AND status IN ('queued', 'running') LIMIT 1`;
    if (draining.length) throw new Error('hosted_pool_agent_host_draining');
    // Read a live clock AFTER taking the shared organization lock. Keep the
    // lock through INSERT, so other hosts and billing writers cannot race it.
    const authority = await readHostedEntitlementAuthority(tx, binding.organizationId);
    if (!authority.ok) throw new Error(`hosted_pool_agent_entitlement_${authority.reason}`);
    const [role] = await tx<Array<{ role: string }>>`SELECT current_user AS role`;
    if (!role?.role) throw new Error('hosted_pool_agent_role_unknown');
    let validBinding: boolean;
    await tx`SELECT set_config('role', 'hosted_service', true)`;
    try {
      const rows = await tx<Array<{ id: string }>>`
        SELECT customer_workspace_id AS id FROM papercusp_auth.hosted_workspace_connectors
        WHERE control_workspace_id = ${binding.controlPlaneWorkspaceId}
          AND organization_id = ${binding.organizationId}
          AND customer_workspace_id = ${binding.customerWorkspaceId} AND host_id = ${binding.hostId}
          AND generation = ${binding.generation} AND state = 'active' AND revoked_at IS NULL
        FOR SHARE`;
      validBinding = rows.length === 1;
      await tx`SELECT set_config('role', ${role.role}, true)`;
    } catch (error) {
      await tx`SELECT set_config('role', ${role.role}, true)`.catch(() => {});
      throw error;
    }
    if (!validBinding) throw new Error('hosted_pool_agent_binding_inactive');
    const [counts] = await tx<Array<{ pending: number; allocated: number }>>`
      SELECT count(*) FILTER (WHERE state IN ('queued', 'eligible'))::int AS pending,
             count(*) FILTER (WHERE state IN ('leased', 'running'))::int AS allocated
      FROM harness_shared.resource_governor_admissions
      WHERE workspace_id = ${binding.controlPlaneWorkspaceId} AND admission_class = 'agent'
        AND record->'metadata'->>'hostedOrganizationId' = ${binding.organizationId}
        AND state IN ('queued', 'eligible', 'leased', 'running')`;
    const pending = counts?.pending ?? 0;
    const allocated = counts?.allocated ?? 0;
    const check = checkHostedEntitlement(authority.resolution,
      { kind: 'quota', key: 'pool.agents', used: allocated + pending, requested: 1 });
    if (!check.allowed) throw new Error(`hosted_pool_agent_quota_exceeded:${check.reason}`);
    // Optional stricter boot-queue ceiling; the total-agent allowance always
    // includes pending demand even when a bundle has no separate pending cap.
    if (authority.resolution.quotas['pool.pending-agents'] !== undefined) {
      const queued = checkHostedEntitlement(authority.resolution,
        { kind: 'quota', key: 'pool.pending-agents', used: pending, requested: 1 });
      if (!queued.allowed) throw new Error(`hosted_pool_agent_pending_quota_exceeded:${queued.reason}`);
    }
    return { hostedPoolAgentAuthorityRevision: authority.authorityRevision,
      hostedPoolAgentBundleId: authority.resolution.bundleId,
      hostedPoolAgentBundleVersion: authority.resolution.bundleVersion,
      hostedPoolAgentPending: pending, hostedPoolAgentAllocated: allocated,
      hostedPoolAgentAuditReceiptIds: JSON.stringify(authority.resolution.auditReceiptIds) };
  };
}

/** Extend the canonical receipt ledger; a guest never supplies tenant metadata.
 * Guest process owners are not control-plane coord sessions. An unknown remote
 * owner must therefore retain its charge, rather than being declared dead by
 * the local liveness oracle. Expired leases requeue and still consume quota.
 */
export function createHostedPoolAgentReservations(binding: HostedConnectorBinding, sql?: SqlClient) {
  const namespace = 'hosted-agent';
  const store = new PgAdmissionLedgerQueueStore({ ...(sql ? { sql } : {}),
    workspaceId: binding.controlPlaneWorkspaceId,
    abandonAfterMs: Number.MAX_SAFE_INTEGER,
    resolveSessionStatesFn: async () => new Map(),
    admitNewRecord: hostedPoolAgentAdmissionGuard(binding) });
  const driver = new WorkItemAdmissionQueueDriver(store, { namespace });
  const governor = new Governor(driver);
  return async (action: 'reserve' | 'start' | 'finish', processKey: string) => {
    if (!processKey || processKey.length > 200 || /[\x00-\x1f]/.test(processKey)) {
      throw new Error('hosted_pool_agent_invalid_process_key');
    }
    const key = JSON.stringify([binding.customerWorkspaceId, binding.hostId, binding.generation, processKey]);
    if (action === 'reserve') {
      const outcome = await governor.admit({ idempotencyKey: key, admissionClass: 'agent', metadata: {
        hostedOrganizationId: binding.organizationId, hostedCustomerWorkspaceId: binding.customerWorkspaceId,
        hostedHostId: binding.hostId, hostedConnectorGeneration: binding.generation } });
      if (outcome.kind !== 'queued') throw new Error('hosted_pool_agent_durable_receipt_required');
      const current = await store.find(namespace, key);
      if (!current || !['queued', 'eligible', 'leased', 'running'].includes(current.record.state)) {
        throw new Error('hosted_pool_agent_process_key_terminal');
      }
      return { receiptId: outcome.receipt.receiptId, state: current.record.state };
    }
    const current = await store.find(namespace, key);
    if (!current) throw new Error('hosted_pool_agent_reservation_missing');
    if (action === 'finish') {
      await governor.cancel(key, 'hosted process exited or start failed');
      return { receiptId: current.receiptId, state: 'cancelled' };
    }
    if (current.record.state === 'running') return { receiptId: current.receiptId, state: 'running' };
    const claim = await driver.leaseReceipt({ receiptId: current.receiptId,
      owner: `hosted-process:${key}`, ttlMs: 24 * 60 * 60_000 });
    if (!claim || !(await driver.markRunning(claim.receiptId, claim.lease.leaseId))?.changed) {
      throw new Error('hosted_pool_agent_reservation_not_startable');
    }
    return { receiptId: claim.receiptId, state: 'running' };
  };
}

/** Provider-confirmed absence is an exit witness for every process on that VM.
 * Snapshot only existing receipts at that witness, then use canonical cancellation
 * so a retry preserves audit history and cannot cancel a later incarnation's start.
 * Connector revocation alone is not evidence that a process has stopped.
 */
export async function retireHostedPoolAgentReservations(input: {
  controlPlaneWorkspaceId: string; hostId: string;
}, sql?: SqlClient): Promise<number> {
  const rows = await boundedOrgTxn(async tx => {
    const hosts = await tx<Array<{ id: string }>>`
      SELECT id FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${input.controlPlaneWorkspaceId} AND id = ${input.hostId}
        AND desired_state = 'absent' AND observed_state = 'absent'
      FOR SHARE`;
    if (hosts.length !== 1) throw new Error('hosted_pool_agent_host_not_absent');
    return tx<Array<{ idempotency_key: string }>>`
      SELECT idempotency_key FROM harness_shared.resource_governor_admissions
      WHERE workspace_id = ${input.controlPlaneWorkspaceId} AND namespace = 'hosted-agent'
        AND admission_class = 'agent' AND state IN ('queued', 'eligible', 'leased', 'running')
        AND record->'metadata'->>'hostedHostId' = ${input.hostId}
      ORDER BY receipt_id`;
  }, sql ? { client: sql } : {});
  const store = new PgAdmissionLedgerQueueStore({ ...(sql ? { sql } : {}),
    workspaceId: input.controlPlaneWorkspaceId });
  let retired = 0;
  for (const row of rows) {
    const result = await store.cancel('hosted-agent', row.idempotency_key,
      'provider-confirmed host absence', Date.now());
    if (result?.changed) retired += 1;
  }
  return retired;
}

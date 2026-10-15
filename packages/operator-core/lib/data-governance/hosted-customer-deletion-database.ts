/** Hosted deletion executor. The fixed, snapshot-authorized database bridge owns
 * privileged mutations; the existing organization receipt writer owns proof.
 * Call in a hosted-service transaction, after workspace/provider teardown. */
import type { Sql } from 'postgres';
import type { HostedCustomerDeletionPolicy, HostedCustomerDeletionRequest } from './hosted-customer-deletion';
import { authorizeHostedCustomerDeletion, readHostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';
import { planOrganizationDataOperation, readSchemaVersion, writeOrganizationDataReceipt, type StoreReceipt } from './organization-data-receipts';

/** Children are explicit so their rows count before ON DELETE CASCADE fires. */
const DELETE_FIRST = ['papercusp_auth.workos_sealed_sessions', 'papercusp_auth.hosted_workspace_connector_tickets',
  'papercusp_auth.hosted_mcp_oauth_requests', 'papercusp_auth.organization_memberships',
  'papercusp_auth.directory_user_observations'];

export async function deleteHostedCustomerDatabase(
  tx: Sql, request: HostedCustomerDeletionRequest,
  resolveApprovedPolicy: () => Promise<HostedCustomerDeletionPolicy | null>,
): Promise<{ receiptId: string; stores: readonly StoreReceipt[] }> {
  await authorizeHostedCustomerDeletion(tx, request, resolveApprovedPolicy);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion:${request.organizationId}`}, 0))`;
  const snapshot = await readHostedCustomerDeletionSnapshot(tx, request);
  if (!snapshot) throw new Error('customer-deletion:snapshot-required');
  // Consent history is append-only. A policy string cannot disable its guard.
  if (request.policy.consent !== 'retain') throw new Error('customer-deletion:consent-deletion-not-supported');
  const previous = await tx<{ data: { id: string; metadata: { stores: StoreReceipt[] } } }[]>`
    SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
      'papercusp_auth.organization_audit_events', ${request.organizationId})
     WHERE data->>'action' = 'organization.data.deletion'
       AND data->'metadata'->>'operationId' = ${request.operationId}`;
  if (previous.length > 1) throw new Error('customer-deletion:duplicate-database-receipt');
  if (previous[0]) return { receiptId: previous[0].data.id, stores: previous[0].data.metadata.stores };

  const plan = planOrganizationDataOperation();
  const rank = (store: string) => { const i = DELETE_FIRST.indexOf(store); return i < 0 ? DELETE_FIRST.length : i; };
  const stores: StoreReceipt[] = [];
  for (const treatment of [...plan].sort((a, b) => rank(a.store) - rank(b.store))) {
    const base = { store: treatment.store, executor: treatment.executor, retention: treatment.retention,
      exportedColumns: null, excludedColumns: treatment.excludedColumns };
    if (treatment.attribution.kind === 'unattributable' || treatment.executor !== 'hosted-control-plane') {
      stores.push({ ...base, outcome: treatment.attribution.kind === 'unattributable' ? 'not-attributable' : 'deferred',
        rowCount: null, rowsRemaining: null, reason: treatment.attribution.kind === 'unattributable'
          ? treatment.deletion.reason : 'Workspace content belongs to the workspace data-plane teardown executor.' });
      continue;
    }
    if (treatment.deletion.action === 'retain') {
      stores.push({ ...base, outcome: 'retained', rowCount: 0, rowsRemaining: null,
        reason: `${treatment.deletion.reason} Retained population is not counted by this mutation executor.` });
      continue;
    }
    const [result] = await tx<{ outcome: 'deleted' | 'redacted' | 'not-attributable'; affected: number; remaining: number; reason: string }[]>`
      SELECT * FROM papercusp_auth.delete_hosted_customer_rows(
        ${treatment.store}, ${request.organizationId}, ${request.operationId})`;
    if (!result) throw new Error('customer-deletion:database-result-missing');
    stores.push({ ...base, outcome: result.outcome, rowCount: Number(result.affected),
      rowsRemaining: Number(result.remaining), reason: result.reason });
  }
  const receiptId = await writeOrganizationDataReceipt({ operation: 'deletion', operationId: request.operationId,
    executor: 'hosted-control-plane', scope: { organizationId: request.organizationId, workspaceIds: [],
      ...(request.target.kind === 'user' ? { userId: request.target.userId } : {}) },
    purpose: 'Durable hosted customer deletion', stores, schemaVersion: await readSchemaVersion(tx),
    limitations: ['Financial, consent, audit, abuse-prevention and provider-ledger retention follow their declared classes.',
      'Deleted identities and workspaces retain inert identifiers for replay protection and retained-record references.',
      'Backups predating deletion retain their contents until approved expiry; this receipt does not certify backup erasure.',
      'Workspace content teardown is recorded by its workflow, not by this control-plane database receipt.'],
  }, { kind: 'system', id: 'customer-deletion' }, tx);
  return { receiptId, stores };
}

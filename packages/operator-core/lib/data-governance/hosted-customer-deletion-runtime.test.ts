import { readFileSync } from 'node:fs';
import { NotFoundException } from '@workos-inc/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { StripeBillingClient } from '../auth/hosted/billing/stripe-billing-client';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
vi.mock('@papercusp/db-org', () => ({ withHostedServiceContext: vi.fn(), withWorkspace: vi.fn() }));
vi.mock('../workspace-host/observability-store', () => ({ readWorkspaceHostConnection: vi.fn(), readWorkspaceHostDestroyTarget: vi.fn() }));
vi.mock('../auth/hosted/governance', () => ({ appendOrganizationAuditEvent: vi.fn() }));
vi.mock('./hosted-customer-deletion-store', () => ({ authorizeHostedCustomerDeletion: vi.fn(),
  freezeHostedCustomerDeletionAccess: vi.fn(), readHostedCustomerDeletionSnapshot: vi.fn() }));
vi.mock('./hosted-customer-deletion-database', () => ({ deleteHostedCustomerDatabase: vi.fn() }));
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import { authorizeHostedCustomerDeletion, freezeHostedCustomerDeletionAccess, readHostedCustomerDeletionSnapshot,
  type HostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';
import { deleteHostedCustomerDatabase } from './hosted-customer-deletion-database';
import { runHostedCustomerDeletion, type HostedCustomerDeletionPolicy, type HostedCustomerDeletionRequest } from './hosted-customer-deletion';
import { createHostedCustomerDeletionSeams } from './hosted-customer-deletion-runtime';

const request: HostedCustomerDeletionRequest = { operationId: 'operation', organizationId: 'tenant', requestedBy: 'actor',
  target: { kind: 'organization' }, policy: { approvalRef: 'approved', stripe: 'delete', consent: 'retain' } };

beforeEach(() => vi.resetAllMocks());

function fixture() {
  let inTransaction = false;
  let approved: HostedCustomerDeletionPolicy | null = request.policy;
  const receipts: Parameters<typeof appendOrganizationAuditEvent>[0][] = [];
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('').includes('read_hosted_customer_export_rows')) return [];
    return receipts.filter(row => row.organizationId === values[0] && row.action === values[1]
      && row.metadata?.operationId === values[2]).map(row => ({ data: {
        actor_kind: row.actorKind, actor_id: row.actorId, target_type: row.targetType, target_id: row.targetId,
      } }));
  });
  const tx = query as unknown as Sql;
  const runService: HostedServiceContextRunner = async fn => {
    expect(inTransaction).toBe(false); inTransaction = true;
    try { return await fn(tx); } finally { inTransaction = false; }
  };
  const snapshot: HostedCustomerDeletionSnapshot = { schemaVersion: 1, request, controlPlaneWorkspaceId: 'control',
    organizationIdentity: { provider: 'workos', subject: 'org_1' }, users: [], workspaces: [], stripeCustomerId: 'cus_1' };
  vi.mocked(authorizeHostedCustomerDeletion).mockImplementation(async (_sql, _request, resolve) => {
    expect(inTransaction).toBe(true);
    if (!await resolve()) throw new Error('retention-policy-not-approved');
  });
  vi.mocked(freezeHostedCustomerDeletionAccess).mockImplementation(async () => {
    expect(inTransaction).toBe(true); return snapshot;
  });
  vi.mocked(readHostedCustomerDeletionSnapshot).mockResolvedValue(snapshot);
  vi.mocked(deleteHostedCustomerDatabase).mockImplementation(async () => {
    expect(inTransaction).toBe(true); return { receiptId: 'database-receipt', stores: [] };
  });
  vi.mocked(appendOrganizationAuditEvent).mockImplementation(async row => {
    expect(inTransaction).toBe(true); receipts.push(row); return `audit-${receipts.length}`;
  });
  const deleteCustomer = vi.fn<StripeBillingClient['deleteCustomer']>(async () => {
    expect(inTransaction).toBe(false);
    return { ok: true, customerId: 'cus_1', alreadyDeleted: false, requestIds: ['req_1'] };
  });
  const readOrganization = vi.fn(async () => {
    expect(inTransaction).toBe(false);
    throw new NotFoundException({ path: '/organizations/org_1', requestID: 'req_1' });
  });
  const resolveWorkOSApiKey = vi.fn(async () => { expect(inTransaction).toBe(false); return 'test-secret'; });
  const options = { controlPlaneWorkspaceId: 'control', runService, resolveApprovedPolicy: async () => approved,
    resolveWorkOSApiKey, stripe: async () => ({ deleteCustomer }),
    createWorkOSClient: () => ({ userManagement: { getUser: vi.fn(), deleteUser: vi.fn() },
      organizations: { getOrganization: readOrganization, deleteOrganization: vi.fn() } }),
  };
  return { seams: createHostedCustomerDeletionSeams(options), options, snapshot, receipts, deleteCustomer,
    readOrganization, resolveWorkOSApiKey, withdrawPolicy: () => { approved = null; } };
}

describe('hosted customer deletion executor composition', () => {
  it('composes authenticated snapshots, provider postconditions and the canonical database receipt outside provider SQL transactions', async () => {
    const f = fixture();
    const result = await runHostedCustomerDeletion(request, f.seams, (_name, run) => run());
    expect(result.steps.map(step => step.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    expect(result.steps.at(-1)?.detail).toBe('database_receipt:database-receipt');
    expect(f.deleteCustomer).toHaveBeenCalledWith({ customerId: 'cus_1', organizationId: 'tenant' });
    expect(f.readOrganization).toHaveBeenCalledWith('org_1');
    expect(readHostedCustomerDeletionSnapshot).toHaveBeenCalledTimes(3);
    expect(f.receipts.map(row => row.metadata?.detail)).toEqual([
      'access_completed', 'workspace_completed', 'stripe_completed', 'workos_completed', 'database_completed',
    ]);
    await f.seams.audit({ request, step: 'database', status: 'completed', detail: 'secret provider detail' });
    expect(f.receipts).toHaveLength(5);
  });

  it('keeps a pending or withdrawn server policy closed even after initial workflow admission', async () => {
    const f = fixture();
    await f.seams.authorize(request);
    f.withdrawPolicy();
    await expect(f.seams.stripe(request)).rejects.toThrow('retention-policy-not-approved');
    await expect(f.seams.workos(request)).rejects.toThrow('retention-policy-not-approved');
    expect(f.deleteCustomer).not.toHaveBeenCalled();
    expect(f.resolveWorkOSApiKey).not.toHaveBeenCalled();
    const pending = createHostedCustomerDeletionSeams({ ...f.options, resolveApprovedPolicy: undefined });
    await expect(runHostedCustomerDeletion(request, pending, (_name, run) => run())).rejects.toThrow('retention-policy-not-approved');
    expect(freezeHostedCustomerDeletionAccess).not.toHaveBeenCalled();
  });

  it('fails before provider mutation when the immutable snapshot is missing', async () => {
    const f = fixture();
    vi.mocked(readHostedCustomerDeletionSnapshot).mockResolvedValue(null);
    await expect(f.seams.stripe(request)).rejects.toThrow('snapshot-required');
    await expect(f.seams.workos(request)).rejects.toThrow('snapshot-required');
    expect(f.deleteCustomer).not.toHaveBeenCalled(); expect(f.resolveWorkOSApiKey).not.toHaveBeenCalled();
  });

  it('records a redacted failed step, stops the cascade, and deduplicates an audit replay', async () => {
    const f = fixture();
    f.deleteCustomer.mockRejectedValue(new Error('private provider payload'));
    await expect(runHostedCustomerDeletion(request, f.seams, (_name, run) => run())).rejects.toThrow('stripe-failed');
    expect(deleteHostedCustomerDatabase).not.toHaveBeenCalled(); expect(f.readOrganization).not.toHaveBeenCalled();
    expect(f.receipts.at(-1)?.metadata).toEqual({ operationId: 'operation', step: 'stripe', status: 'failed', detail: 'stripe_failed' });
    await f.seams.audit({ request, step: 'stripe', status: 'failed', detail: 'private provider payload' });
    expect(f.receipts).toHaveLength(3);
    expect(JSON.stringify(f.receipts)).not.toContain('private provider payload');
  });

  it('registers the concrete executor before DBOS launches', () => {
    const bootstrap = readFileSync(new URL('../dbos/bootstrap.ts', import.meta.url), 'utf8');
    const registration = bootstrap.indexOf('createHostedCustomerDeletionWorkflow({ seams: createHostedCustomerDeletionSeams(');
    expect(registration).toBeGreaterThan(0);
    expect(registration).toBeLessThan(bootstrap.indexOf('await DBOS.launch()'));
  });
});

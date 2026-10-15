import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createHostedPrincipal } from '../auth/hosted-principal';
const mocks = vi.hoisted(() => ({ session: vi.fn(), membership: vi.fn(), audit: vi.fn() }));
vi.mock('../auth/hosted-session', () => ({ HostedSessionStore: class { resolveForUpdate = mocks.session; } }));
vi.mock('../auth/hosted-membership-authority', () => ({ PostgresHostedMembershipAuthority: class { resolveActiveForUpdate = mocks.membership; } }));
vi.mock('../auth/hosted/governance', () => ({ appendOrganizationAuditEvent: mocks.audit }));
import { admitHostedCustomerDeletion, createHostedCustomerDeletionRequester } from './hosted-customer-data';

const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'u-1', activeOrganizationId: 'o-1',
  sessionId: 's-1', sessionVersion: 7, permissions: ['workspace:view', 'workspace:destroy'] });
const policy = { approvalRef: 'plan#D-RETENTION', stripe: 'delete' as const, consent: 'retain' as const };
let orphaned: unknown[];
const query = vi.fn(async (strings: TemplateStringsArray) => {
  const statement = strings.join('');
  if (statement.includes('SELECT u.id')) return [{ id: 'u-1' }];
  if (statement.includes('SELECT m.organization_id')) return orphaned;
  return [];
});
const tx = query as unknown as Sql;
beforeEach(() => {
  vi.clearAllMocks(); orphaned = [];
  mocks.session.mockResolvedValue({ userId: 'u-1', organizationId: 'o-1', workspaceId: null, permissionVersion: 7 });
  mocks.membership.mockResolvedValue({ role: 'owner', permissionVersion: 7,
    permissions: new Set(['workspace:view', 'workspace:destroy']) });
  mocks.audit.mockResolvedValue('receipt');
});

describe('hosted customer deletion admission (P-010)', () => {
  it('commits the immutable admission before sending its server-derived request to DBOS', async () => {
    const order: string[] = [];
    const enqueueCustomerDeletion = vi.fn(async request => {
      expect(order).toEqual(['admitted', 'committed']);
      expect(request).toMatchObject({ organizationId: 'o-1', requestedBy: 'u-1', target: { kind: 'organization' }, policy });
      order.push('enqueued');
      return { operationId: request.operationId };
    });
    const requestDeletion = createHostedCustomerDeletionRequester({
      runService: async fn => { const request = await fn(tx); order.push('admitted', 'committed'); return request; },
      resolveApprovedPolicy: async () => policy, enqueueCustomerDeletion,
    });
    const result = await requestDeletion(principal, { kind: 'organization', confirmation: 'DELETE ORGANIZATION' });
    expect(result.operationId).toEqual(enqueueCustomerDeletion.mock.calls[0]?.[0].operationId);
    expect(order).toEqual(['admitted', 'committed', 'enqueued']);
  });

  it('does not enqueue after a failed commit or a pending policy', async () => {
    const enqueueCustomerDeletion = vi.fn();
    const options = { runService: async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
      await fn(tx); throw new Error('commit-failed');
    }, resolveApprovedPolicy: async () => policy, enqueueCustomerDeletion };
    await expect(createHostedCustomerDeletionRequester(options)(principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' })).rejects.toThrow('commit-failed');
    await expect(createHostedCustomerDeletionRequester({ ...options, resolveApprovedPolicy: async () => null })(principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' })).rejects.toThrow('retention_policy_pending');
    expect(enqueueCustomerDeletion).not.toHaveBeenCalled();
  });

  it('preserves the admitted operation receipt on queue failure and rejects a mismatched queue identity', async () => {
    const options = { runService: async <T>(fn: (sql: Sql) => Promise<T>) => fn(tx),
      resolveApprovedPolicy: async () => policy, enqueueCustomerDeletion: vi.fn(async () => { throw new Error('queue-unavailable'); }) };
    const input = { kind: 'organization' as const, confirmation: 'DELETE ORGANIZATION' };
    await expect(createHostedCustomerDeletionRequester(options)(principal, input)).rejects.toThrow('queue-unavailable');
    expect(mocks.audit).toHaveBeenCalledOnce();
    await expect(createHostedCustomerDeletionRequester({ ...options,
      enqueueCustomerDeletion: async () => ({ operationId: 'different' }) })(principal, input))
      .rejects.toThrow('customer_deletion_enqueue_identity_mismatch');
  });

  it('derives scope and actor from the current authenticated account and writes a request receipt', async () => {
    const request = await admitHostedCustomerDeletion(tx, principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' }, async () => policy);
    expect(request).toMatchObject({ organizationId: 'o-1', requestedBy: 'u-1', target: { kind: 'organization' }, policy });
    expect(request.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'o-1', actorId: 'u-1',
      action: 'organization.data.deletion.requested', metadata: { operationId: request.operationId, kind: 'organization', policy } }), tx);
  });

  it('rejects a revoked session and a stale authority version before the policy or receipt', async () => {
    const resolve = vi.fn(async () => policy);
    mocks.session.mockResolvedValue(null);
    await expect(admitHostedCustomerDeletion(tx, principal, { kind: 'user', confirmation: 'DELETE MY ACCOUNT' }, resolve))
      .rejects.toThrow('customer_data_forbidden');
    mocks.session.mockResolvedValue({ userId: 'u-1', organizationId: 'o-1', workspaceId: null, permissionVersion: 7 });
    mocks.membership.mockResolvedValue({ role: 'owner', permissionVersion: 8, permissions: new Set(['workspace:view']) });
    await expect(admitHostedCustomerDeletion(tx, principal, { kind: 'user', confirmation: 'DELETE MY ACCOUNT' }, resolve))
      .rejects.toThrow('customer_data_forbidden');
    expect(resolve).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('requires the current owner role even if an admin has workspace destroy authority', async () => {
    mocks.membership.mockResolvedValue({ role: 'admin', permissionVersion: 7, permissions: new Set(['workspace:destroy']) });
    await expect(admitHostedCustomerDeletion(tx, principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' }, async () => policy)).rejects.toThrow('customer_data_forbidden');
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('requires exact destructive confirmation and an approved server retention policy', async () => {
    const resolve = vi.fn(async () => policy);
    await expect(admitHostedCustomerDeletion(tx, principal, { kind: 'organization', confirmation: 'delete' }, resolve))
      .rejects.toThrow('confirmation_required');
    expect(resolve).not.toHaveBeenCalled();
    await expect(admitHostedCustomerDeletion(tx, principal,
      { kind: 'organization', confirmation: 'DELETE ORGANIZATION' }, async () => null)).rejects.toThrow('retention_policy_pending');
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('allows members to request their own deletion while refusing sole owners in any tenant', async () => {
    mocks.membership.mockResolvedValue({ role: 'member', permissionVersion: 7, permissions: new Set(['workspace:view']) });
    orphaned = [{ organization_id: 'another-tenant' }];
    await expect(admitHostedCustomerDeletion(tx, principal,
      { kind: 'user', confirmation: 'DELETE MY ACCOUNT' }, async () => policy)).rejects.toThrow('transfer_organization_ownership_required');
    expect(mocks.audit).not.toHaveBeenCalled();
    orphaned = [];
    const request = await admitHostedCustomerDeletion(tx, principal,
      { kind: 'user', confirmation: 'DELETE MY ACCOUNT' }, async () => policy);
    expect(request.target).toEqual({ kind: 'user', userId: 'u-1' });
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
});

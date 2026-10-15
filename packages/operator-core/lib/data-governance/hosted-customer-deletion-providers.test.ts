import { NotFoundException } from '@workos-inc/node';
import { describe, expect, it, vi } from 'vitest';
import { createHostedCustomerDeletionProviders } from './hosted-customer-deletion-providers';
import type { HostedCustomerDeletionRequest } from './hosted-customer-deletion';
import type { HostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';
import type { StripeBillingClient } from '../auth/hosted/billing/stripe-billing-client';

const request: HostedCustomerDeletionRequest = { operationId: 'operation', organizationId: 'tenant', requestedBy: 'actor',
  target: { kind: 'organization' }, policy: { approvalRef: 'approved-decision', stripe: 'delete', consent: 'retain' } };
const absent = () => new NotFoundException({ path: '/resource', requestID: 'request_1' });

function fixture(frozenRequest = request) {
  const snapshot: HostedCustomerDeletionSnapshot = { schemaVersion: 1, request: frozenRequest, controlPlaneWorkspaceId: 'control-plane',
    organizationIdentity: { provider: 'workos', subject: 'org_1' }, stripeCustomerId: 'cus_1', workspaces: [],
    users: [
      { userId: 'only-tenant', deleteUser: true, identities: [{ provider: 'workos', subject: 'user_1' }] },
      { userId: 'shared', deleteUser: false, identities: [{ provider: 'workos', subject: 'user_shared' }] },
    ] };
  if (frozenRequest.target.kind === 'user') snapshot.users = [{ userId: frozenRequest.target.userId,
    deleteUser: true, identities: [{ provider: 'workos', subject: 'user_1' }] }];
  const users = new Set(['user_1', 'user_shared']);
  const organizations = new Set(['org_1']);
  const workos = {
    userManagement: {
      getUser: vi.fn(async (id: string) => { if (!users.has(id)) throw absent(); return { id }; }),
      deleteUser: vi.fn(async (id: string) => { users.delete(id); }),
    },
    organizations: {
      getOrganization: vi.fn(async (id: string) => { if (!organizations.has(id)) throw absent(); return { id }; }),
      deleteOrganization: vi.fn(async (id: string) => { organizations.delete(id); }),
    },
  };
  const readAuthorizedSnapshot = vi.fn(async () => snapshot);
  const resolveWorkOSApiKey = vi.fn(async () => 'test-secret');
  const createWorkOSClient = vi.fn(() => workos);
  const stripeClient = { deleteCustomer: vi.fn<StripeBillingClient['deleteCustomer']>(async () => ({ ok: true, customerId: 'cus_1',
    alreadyDeleted: false, requestIds: ['req_1'] })) };
  const stripe = vi.fn(async () => stripeClient);
  const providers = createHostedCustomerDeletionProviders({ readAuthorizedSnapshot, resolveWorkOSApiKey, createWorkOSClient, stripe });
  return { providers, snapshot, users, workos, stripe, stripeClient, readAuthorizedSnapshot, resolveWorkOSApiKey };
}

describe('hosted customer deletion provider composition', () => {
  it('confirms absence of frozen WorkOS targets, preserves shared identities and safely replays partial success', async () => {
    const f = fixture();
    f.workos.organizations.deleteOrganization.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(f.providers.workos(request)).rejects.toThrow('provider unavailable');
    expect(f.users.has('user_shared')).toBe(true);
    expect(f.users.has('user_1')).toBe(false);
    await expect(f.providers.workos(request)).resolves.toBe('workos_targets_absent');
    expect(f.workos.userManagement.deleteUser.mock.calls).toEqual([['user_1']]);
    expect(f.workos.organizations.deleteOrganization.mock.calls).toEqual([['org_1'], ['org_1']]);
    expect(f.readAuthorizedSnapshot).toHaveBeenCalledTimes(2);
  });

  it('rechecks policy before resolving any credential or invoking any provider', async () => {
    const f = fixture();
    f.readAuthorizedSnapshot.mockRejectedValue(new Error('retention-policy-not-approved'));
    await expect(f.providers.workos(request)).rejects.toThrow('retention-policy-not-approved');
    await expect(f.providers.stripe(request)).rejects.toThrow('retention-policy-not-approved');
    expect(f.resolveWorkOSApiKey).not.toHaveBeenCalled();
    expect(f.stripe).not.toHaveBeenCalled();
  });

  it('user deletion leaves the WorkOS organization and other users intact', async () => {
    const userRequest: HostedCustomerDeletionRequest = { ...request, target: { kind: 'user', userId: 'actor' } };
    const f = fixture(userRequest);
    await f.providers.workos(userRequest);
    expect(f.workos.organizations.getOrganization).not.toHaveBeenCalled();
    expect(f.workos.organizations.deleteOrganization).not.toHaveBeenCalled();
    expect(f.users.has('user_shared')).toBe(true);
  });

  it.each([new Error('credential or transport failure'), { status: 404 }])('does not interpret arbitrary errors as absence', async error => {
    const f = fixture();
    f.workos.userManagement.getUser.mockRejectedValue(error);
    await expect(f.providers.workos(request)).rejects.toEqual(error);
    expect(f.workos.userManagement.deleteUser).not.toHaveBeenCalled();
    expect(f.workos.organizations.deleteOrganization).not.toHaveBeenCalled();
  });

  it('requires deletion postconditions and validates the entire target population before any mutation', async () => {
    const f = fixture();
    f.workos.userManagement.deleteUser.mockImplementation(async () => {});
    await expect(f.providers.workos(request)).rejects.toThrow('workos-deletion-unconfirmed');
    const unsupported = fixture();
    unsupported.snapshot.users.push({ userId: 'unknown', deleteUser: true, identities: [{ provider: 'other', subject: 'user_other' }] });
    await expect(unsupported.providers.workos(request)).rejects.toThrow('unsupported-user-identity');
    expect(unsupported.resolveWorkOSApiKey).not.toHaveBeenCalled();
    expect(unsupported.workos.userManagement.deleteUser).not.toHaveBeenCalled();
  });

  it('uses the frozen Stripe binding and keeps provider failures out of the receipt detail', async () => {
    const f = fixture();
    await expect(f.providers.stripe(request)).resolves.toBe('stripe_customer_deleted');
    expect(f.stripeClient.deleteCustomer).toHaveBeenCalledWith({ customerId: 'cus_1', organizationId: 'tenant' });
    f.stripeClient.deleteCustomer.mockResolvedValue({ ok: false, code: 'provider-error', status: 503, detail: 'private provider data' });
    await expect(f.providers.stripe(request)).rejects.toThrow('stripe-deletion-unconfirmed');
  });

  it('retains billing under policy and never sends a user deletion to Stripe', async () => {
    const retainedRequest: HostedCustomerDeletionRequest = { ...request, policy: { ...request.policy, stripe: 'retain' } };
    const f = fixture(retainedRequest);
    await expect(f.providers.stripe(retainedRequest))
      .resolves.toBe('stripe_retained_by_policy');
    const userRequest: HostedCustomerDeletionRequest = { ...request, target: { kind: 'user', userId: 'actor' } };
    const user = fixture(userRequest);
    await expect(user.providers.stripe(userRequest))
      .rejects.toThrow('stripe-outside-user-scope');
    expect(f.stripe).not.toHaveBeenCalled();
    expect(user.stripe).not.toHaveBeenCalled();
  });

  it('refuses mismatched operation, policy and global-user population before credential resolution', async () => {
    for (const changed of [{ ...request, operationId: 'other-operation' },
      { ...request, policy: { ...request.policy, approvalRef: 'unapproved' } }]) {
      const f = fixture();
      await expect(f.providers.workos(changed)).rejects.toThrow('snapshot-mismatch');
      await expect(f.providers.stripe(changed)).rejects.toThrow('snapshot-mismatch');
      expect(f.resolveWorkOSApiKey).not.toHaveBeenCalled();
      expect(f.stripe).not.toHaveBeenCalled();
    }
    const userRequest: HostedCustomerDeletionRequest = { ...request, target: { kind: 'user', userId: 'actor' } };
    const f = fixture(userRequest);
    f.snapshot.users[0]!.userId = 'other-user';
    await expect(f.providers.workos(userRequest)).rejects.toThrow('snapshot-mismatch');
    expect(f.resolveWorkOSApiKey).not.toHaveBeenCalled();
  });
});

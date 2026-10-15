/** P-010 provider adapters. Targets come only from the immutable, authorized
 * access-freeze snapshot. Reuses the official WorkOS SDK and the existing
 * Stripe client's credential/mode gate; this module never discovers new scope. */
import { NotFoundException, WorkOS } from '@workos-inc/node';
import type { StripeBillingClient } from '../auth/hosted/billing/stripe-billing-client';
import type { HostedCustomerDeletionRequest, HostedCustomerDeletionSeams } from './hosted-customer-deletion';
import type { HostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';

export interface CustomerDeletionWorkOSClient {
  readonly userManagement: {
    getUser(id: string): Promise<{ id: string }>;
    deleteUser(id: string): Promise<void>;
  };
  readonly organizations: {
    getOrganization(id: string): Promise<{ id: string }>;
    deleteOrganization(id: string): Promise<void>;
  };
}

export interface HostedCustomerDeletionProviderOptions {
  /** Must re-authorize admission/policy on EVERY call, then read the durable
   * snapshot in the hosted-service transaction. Missing snapshots are errors. */
  readonly readAuthorizedSnapshot: (request: HostedCustomerDeletionRequest) => Promise<HostedCustomerDeletionSnapshot>;
  readonly resolveWorkOSApiKey: () => Promise<string>;
  readonly stripe: () => Promise<Pick<StripeBillingClient, 'deleteCustomer'>>;
  readonly createWorkOSClient?: (apiKey: string) => CustomerDeletionWorkOSClient;
}

function refuse(code: string): never { throw new Error(`customer-deletion:${code}`); }

/** Only an official SDK 404 proves absence. Authorization/transport failures,
 * a fabricated status field and a successful read are never deletion receipts. */
async function readWorkOSResource(read: () => Promise<{ id: string }>, id: string): Promise<boolean> {
  try {
    const resource = await read();
    if (resource.id !== id) refuse('workos-resource-mismatch');
    return true;
  } catch (error) {
    if (error instanceof NotFoundException) return false;
    throw error;
  }
}

async function deleteWorkOSResource(
  read: () => Promise<{ id: string }>, remove: () => Promise<void>, id: string,
): Promise<void> {
  if (!await readWorkOSResource(read, id)) return;
  try { await remove(); } catch (error) {
    if (!(error instanceof NotFoundException)) throw error;
  }
  if (await readWorkOSResource(read, id)) refuse('workos-deletion-unconfirmed');
}

export function createHostedCustomerDeletionProviders(
  options: HostedCustomerDeletionProviderOptions,
): Pick<HostedCustomerDeletionSeams, 'workos' | 'stripe'> {
  const snapshotFor = async (request: HostedCustomerDeletionRequest) => {
    const snapshot = await options.readAuthorizedSnapshot(request);
    const saved = snapshot.request;
    const userId = request.target.kind === 'user' ? request.target.userId : null;
    if (snapshot.schemaVersion !== 1 || saved.operationId !== request.operationId
        || saved.organizationId !== request.organizationId || saved.requestedBy !== request.requestedBy
        || saved.target.kind !== request.target.kind || saved.policy.approvalRef !== request.policy.approvalRef
        || saved.policy.stripe !== request.policy.stripe || saved.policy.consent !== request.policy.consent
        || (userId !== null && (saved.target.kind !== 'user' || saved.target.userId !== userId
          || snapshot.users.some(user => user.userId !== userId)))) refuse('snapshot-mismatch');
    return snapshot;
  };
  const client = async () => {
    const apiKey = await options.resolveWorkOSApiKey();
    if (typeof apiKey !== 'string' || !apiKey.trim()) refuse('workos-credential-unavailable');
    return options.createWorkOSClient?.(apiKey) ?? new WorkOS(apiKey);
  };
  return {
    async workos(request) {
      const snapshot = await snapshotFor(request);
      const userIds = snapshot.users.filter(user => user.deleteUser).flatMap(user => user.identities.map(identity => {
        if (identity.provider !== 'workos' || !/^user_[A-Za-z0-9]+$/.test(identity.subject)) {
          refuse('unsupported-user-identity');
        }
        return identity.subject;
      }));
      const organizationId = request.target.kind === 'organization' ? snapshot.organizationIdentity.subject : null;
      if (organizationId && (snapshot.organizationIdentity.provider !== 'workos' || !/^org_[A-Za-z0-9]+$/.test(organizationId))) {
        refuse('unsupported-organization-identity');
      }
      if (request.target.kind === 'organization' && !organizationId) refuse('organization-identity-required');
      const workos = await client();
      for (const id of [...new Set(userIds)].sort()) {
        await deleteWorkOSResource(() => workos.userManagement.getUser(id), () => workos.userManagement.deleteUser(id), id);
      }
      if (organizationId) {
        await deleteWorkOSResource(() => workos.organizations.getOrganization(organizationId),
          () => workos.organizations.deleteOrganization(organizationId), organizationId);
      }
      return 'workos_targets_absent';
    },
    async stripe(request) {
      const snapshot = await snapshotFor(request);
      if (request.target.kind !== 'organization') refuse('stripe-outside-user-scope');
      if (request.policy.stripe === 'retain') return 'stripe_retained_by_policy';
      if (!snapshot.stripeCustomerId) return 'stripe_customer_not_bound';
      const result = await (await options.stripe()).deleteCustomer({ customerId: snapshot.stripeCustomerId,
        organizationId: request.organizationId });
      if (!result.ok || result.customerId !== snapshot.stripeCustomerId) refuse('stripe-deletion-unconfirmed');
      return 'stripe_customer_deleted';
    },
  };
}

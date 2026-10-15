/** P-010 executor composition. Reuses the hosted-service transaction boundary,
 * immutable admission/snapshot, provider adapters and canonical receipt writer.
 * Import only in the executor root: browser processes remain enqueue-only. */
import { withHostedServiceContext } from '@papercusp/db-org';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import { assertPinnedGcpSecretReference, resolveSecretRef } from '../inference-gateway/egress-providers/secret-ref';
import { createHostedCustomerDeletionProviders, type HostedCustomerDeletionProviderOptions } from './hosted-customer-deletion-providers';
import { createHostedCustomerDeletionWorkspaceAdapter } from './hosted-customer-deletion-workspaces';
import { authorizeHostedCustomerDeletion, freezeHostedCustomerDeletionAccess, readHostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';
import { deleteHostedCustomerDatabase } from './hosted-customer-deletion-database';
import { resolveApprovedHostedCustomerDeletionPolicy, type HostedCustomerDeletionPolicy,
  type HostedCustomerDeletionSeams } from './hosted-customer-deletion';

export interface HostedCustomerDeletionRuntimeOptions {
  readonly controlPlaneWorkspaceId: string;
  readonly runService?: HostedServiceContextRunner;
  readonly resolveApprovedPolicy?: () => Promise<HostedCustomerDeletionPolicy | null>;
  readonly resolveWorkOSApiKey?: HostedCustomerDeletionProviderOptions['resolveWorkOSApiKey'];
  readonly stripe?: HostedCustomerDeletionProviderOptions['stripe'];
  readonly createWorkOSClient?: HostedCustomerDeletionProviderOptions['createWorkOSClient'];
}

async function workOSApiKey(): Promise<string> {
  const reference = process.env.WORKOS_API_KEY_REF ?? '';
  if (process.env.PAPERCUSP_DEPLOYMENT_ENVIRONMENT === 'production') assertPinnedGcpSecretReference(reference);
  if (!reference.trim()) throw new Error('customer-deletion:workos-credential-unavailable');
  return resolveSecretRef(reference);
}

async function stripeClient() {
  // Reuse the billing root's managed-secret, account-pin and live-mode checks.
  // An absent live-mode authority remains a refusal, as in the billing runtime.
  const { readHostedBillingRuntimeConfiguration, resolveHostedBillingStripe } = await import('../endpoint-route/hosted-billing-runtime');
  const { stripe } = await resolveHostedBillingStripe(readHostedBillingRuntimeConfiguration(), {});
  if (!stripe) throw new Error('customer-deletion:stripe-credential-unavailable');
  return stripe.client;
}

export function createHostedCustomerDeletionSeams(options: HostedCustomerDeletionRuntimeOptions): HostedCustomerDeletionSeams {
  const run = options.runService ?? withHostedServiceContext;
  const policy = options.resolveApprovedPolicy ?? resolveApprovedHostedCustomerDeletionPolicy;
  const readAuthorizedSnapshot: HostedCustomerDeletionProviderOptions['readAuthorizedSnapshot'] = request => run(async tx => {
    await authorizeHostedCustomerDeletion(tx, request, policy);
    const snapshot = await readHostedCustomerDeletionSnapshot(tx, request);
    if (!snapshot) throw new Error('customer-deletion:snapshot-required');
    return snapshot;
  });
  const providers = createHostedCustomerDeletionProviders({ readAuthorizedSnapshot,
    resolveWorkOSApiKey: options.resolveWorkOSApiKey ?? workOSApiKey, stripe: options.stripe ?? stripeClient,
    ...(options.createWorkOSClient ? { createWorkOSClient: options.createWorkOSClient } : {}) });
  return {
    authorize: request => run(tx => authorizeHostedCustomerDeletion(tx, request, policy)),
    access: request => run(async tx => {
      await freezeHostedCustomerDeletionAccess(tx, request, options.controlPlaneWorkspaceId, policy);
      return 'access_frozen';
    }),
    workspace: createHostedCustomerDeletionWorkspaceAdapter({ readAuthorizedSnapshot }),
    ...providers,
    database: request => run(async tx => {
      const result = await deleteHostedCustomerDatabase(tx, request, policy);
      return `database_receipt:${result.receiptId}`;
    }),
    audit: ({ request, step, status }) => run(async tx => {
      await authorizeHostedCustomerDeletion(tx, request, policy);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-deletion-audit:${request.organizationId}:${request.operationId}`}, 0))`;
      const action = `organization.data.deletion.step.${step}.${status}`;
      const prior = await tx<{ data: { actor_kind: string; actor_id: string; target_type: string; target_id: string } }[]>`
        SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
          'papercusp_auth.organization_audit_events', ${request.organizationId})
         WHERE data->>'action' = ${action} AND data->'metadata'->>'operationId' = ${request.operationId}`;
      const targetId = request.target.kind === 'user' ? request.target.userId : request.organizationId;
      if (prior.length > 1 || (prior[0] && (prior[0].data.actor_kind !== 'system'
        || prior[0].data.actor_id !== 'customer-deletion' || prior[0].data.target_type !== request.target.kind
        || prior[0].data.target_id !== targetId))) throw new Error('customer-deletion:audit-identity-mismatch');
      if (prior.length) return;
      // Never persist provider-returned prose, identifiers or exception messages.
      await appendOrganizationAuditEvent({ organizationId: request.organizationId, actorKind: 'system',
        actorId: 'customer-deletion', action, purpose: 'Durable customer deletion step outcome',
        targetType: request.target.kind, targetId,
        metadata: { operationId: request.operationId, step, status, detail: `${step}_${status}` },
      }, tx);
    }),
  };
}

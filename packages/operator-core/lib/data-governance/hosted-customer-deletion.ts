/**
 * Replay-safe customer deletion orchestration (cloud-portal P-010).
 *
 * Provider calls are deliberately injected.  The workflow owns ordering and the
 * per-step audit ledger; WorkOS, Stripe, workspace-host and database adapters
 * remain independently authenticated seams.  A policy reference is mandatory
 * before any provider or database mutation, so an unanswered P-011 retention
 * question cannot accidentally turn into a purge.
 */

export const HOSTED_CUSTOMER_DELETION_STEPS = [
  'access',
  'workspace',
  'stripe',
  'workos',
  'database',
] as const;

export type HostedCustomerDeletionStep = typeof HOSTED_CUSTOMER_DELETION_STEPS[number];
export type DeletionStepStatus = 'completed' | 'skipped' | 'failed';

export interface HostedCustomerDeletionPolicy {
  /** Immutable plan-decision/work-item reference approving these retention choices. */
  readonly approvalRef: string;
  readonly stripe: 'delete' | 'retain';
  readonly consent: 'delete' | 'retain';
}

/** Shared admission/executor policy authority. P-011 has not resolved retention;
 * an operation's serialized approvalRef is never a substitute for that decision.
 * Replace this resolver only when the approved server policy is available. */
export async function resolveApprovedHostedCustomerDeletionPolicy(): Promise<HostedCustomerDeletionPolicy | null> {
  return null;
}

export interface HostedCustomerDeletionRequest {
  readonly operationId: string;
  readonly organizationId: string;
  readonly requestedBy: string;
  readonly target: { readonly kind: 'organization' } | { readonly kind: 'user'; readonly userId: string };
  readonly policy: HostedCustomerDeletionPolicy;
}

export interface HostedCustomerDeletionStepResult {
  readonly step: HostedCustomerDeletionStep;
  readonly status: DeletionStepStatus;
  readonly detail: string;
}

export interface HostedCustomerDeletionResult {
  readonly operationId: string;
  readonly organizationId: string;
  readonly steps: readonly HostedCustomerDeletionStepResult[];
}

export type HostedCustomerDeletionStepRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export interface HostedCustomerDeletionSeams {
  /** Verify a server-owned admission and the exact approved policy values.
   * A caller-supplied approvalRef alone never grants deletion authority. */
  readonly authorize: (request: HostedCustomerDeletionRequest) => Promise<void>;
  /** Freeze account admission, revoke sessions/tokens, and capture provider/workspace
   * targets durably before removing any bindings. Must be idempotent on operationId. */
  readonly access: (request: HostedCustomerDeletionRequest) => Promise<string>;
  /** Revoke/delete the WorkOS organization and its user identities. */
  readonly workos: (request: HostedCustomerDeletionRequest) => Promise<string>;
  /** Delete or retain the Stripe customer according to the approved policy. */
  readonly stripe: (request: HostedCustomerDeletionRequest) => Promise<string>;
  /** Enqueue and await the existing workspace-host destroy workflow. */
  readonly workspace: (request: HostedCustomerDeletionRequest) => Promise<string>;
  /** Delete customer-schema rows and append the canonical organization receipt. */
  readonly database: (request: HostedCustomerDeletionRequest) => Promise<string>;
  /** Append one immutable audit row for every attempted step. */
  readonly audit: (input: {
    request: HostedCustomerDeletionRequest;
    step: HostedCustomerDeletionStep;
    status: DeletionStepStatus;
    detail: string;
  }) => Promise<void>;
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`customer-deletion:${field}-required`);
  return value.trim();
}

function validateRequest(request: HostedCustomerDeletionRequest): HostedCustomerDeletionRequest {
  required(request.operationId, 'operation-id');
  required(request.organizationId, 'organization-id');
  required(request.requestedBy, 'requested-by');
  if (request.target.kind === 'user') required(request.target.userId, 'user-id');
  else if (request.target.kind !== 'organization') throw new Error('customer-deletion:invalid-target');
  required(request.policy.approvalRef, 'policy-approval-ref');
  if (!['delete', 'retain'].includes(request.policy.stripe)
    || !['delete', 'retain'].includes(request.policy.consent)) {
    throw new Error('customer-deletion:invalid-retention-policy');
  }
  return request;
}

function stepSkipped(request: HostedCustomerDeletionRequest, step: HostedCustomerDeletionStep): boolean {
  return (request.target.kind === 'user' && (step === 'stripe' || step === 'workspace'))
    || (step === 'stripe' && request.policy.stripe === 'retain');
}

/**
 * Execute through the durable runtime's step journal. Provider results and audit
 * writes have separate steps, so an audit retry does not repeat a successful
 * provider call. Adapters must also dedupe by operationId for a crash between
 * provider success and journal persistence. No process-local completion ledger.
 */
export async function runHostedCustomerDeletion(
  rawRequest: HostedCustomerDeletionRequest,
  seams: HostedCustomerDeletionSeams,
  runStep: HostedCustomerDeletionStepRunner,
): Promise<HostedCustomerDeletionResult> {
  const request = validateRequest(rawRequest);
  await runStep('authorize', () => seams.authorize(request));
  const results: HostedCustomerDeletionStepResult[] = [];
  const handlers: Record<HostedCustomerDeletionStep, (r: HostedCustomerDeletionRequest) => Promise<string>> = {
    access: seams.access,
    workos: seams.workos,
    stripe: seams.stripe,
    workspace: seams.workspace,
    database: seams.database,
  };
  for (const step of HOSTED_CUSTOMER_DELETION_STEPS) {
    if (stepSkipped(request, step)) {
      const detail = request.target.kind === 'user' ? 'organization resource outside user deletion scope'
        : 'retained by approved retention policy';
      const result = { step, status: 'skipped' as const, detail };
      results.push(result);
      await runStep(`audit:${step}:skipped`, () => seams.audit({ request, ...result }));
      continue;
    }
    let detail: string;
    try {
      detail = await runStep(step, () => handlers[step](request));
    } catch (error) {
      // Provider messages may contain email addresses, request bodies or secrets.
      // Only the normalized stage code goes into the customer/audit result.
      const result = { step, status: 'failed' as const, detail: `${step}_failed` };
      results.push(result);
      try { await runStep(`audit:${step}:failed`, () => seams.audit({ request, ...result })); }
      catch (auditError) {
        throw Object.assign(new Error(`customer-deletion:${step}-failure-audit-failed`), { step, results, cause: error, auditError });
      }
      throw Object.assign(new Error(`customer-deletion:${step}-failed`), { step, results, cause: error });
    }
    const result = { step, status: 'completed' as const, detail };
    results.push(result);
    await runStep(`audit:${step}:completed`, () => seams.audit({ request, ...result }));
  }
  return { operationId: request.operationId, organizationId: request.organizationId, steps: results };
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ runStep: vi.fn(), registerWorkflow: vi.fn(), queue: vi.fn() }));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: sdk,
  WorkflowQueue: class { constructor(readonly name: string, readonly options: unknown) { sdk.queue(name, options); } },
}));
vi.mock('./idempotent-register-workflow', () => ({
  idempotentRegisterWorkflow: (_key: string, register: () => unknown) => register(),
  idempotentWorkflowQueue: (_key: string, construct: () => unknown) => construct(),
}));
import { createHostedCustomerDeletionWorkflow, hostedCustomerDeletionEnqueueRequest, HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME } from './hosted-customer-deletion-workflow';

beforeEach(() => {
  vi.clearAllMocks();
  sdk.runStep.mockImplementation(async (run: () => Promise<unknown>) => run());
  sdk.registerWorkflow.mockImplementation((run: unknown) => run);
});

describe('hosted customer deletion DBOS binding (P-010)', () => {
  it('builds request-only envelopes without registering executor queues or workflows', async () => {
    vi.resetModules();
    const requestOnly = await import('./hosted-customer-deletion-workflow');
    requestOnly.hostedCustomerDeletionEnqueueRequest({ operationId: 'op-1', organizationId: 'org-1', requestedBy: 'actor-1',
      target: { kind: 'organization' }, policy: { approvalRef: 'plan#D-1', stripe: 'delete', consent: 'retain' } });
    expect(sdk.queue).not.toHaveBeenCalled();
    expect(sdk.registerWorkflow).not.toHaveBeenCalled();
  });
  it('journals admission, each provider result and each audit separately in DBOS', async () => {
    const authorize = vi.fn(async () => undefined);
    const workos = vi.fn(async () => 'workos-receipt');
    const workflow = createHostedCustomerDeletionWorkflow({ seams: {
      authorize, access: async () => 'access-receipt', workspace: async () => 'workspace-receipt',
      stripe: async () => 'stripe-receipt', workos, database: async () => 'database-receipt', audit: async () => undefined,
    } });
    const result = await workflow({ operationId: 'op-1', organizationId: 'org-1', requestedBy: 'actor-1',
      target: { kind: 'organization' }, policy: { approvalRef: 'plan#D-1', stripe: 'delete', consent: 'retain' } });
    expect(sdk.registerWorkflow).toHaveBeenCalledWith(expect.any(Function), {
      name: HOSTED_CUSTOMER_DELETION_WORKFLOW_NAME, maxRecoveryAttempts: 20,
    });
    expect(sdk.runStep.mock.calls.map(call => call[1].name)).toEqual([
      'hosted-customer-deletion:authorize', 'hosted-customer-deletion:access', 'hosted-customer-deletion:audit:access:completed',
      'hosted-customer-deletion:workspace', 'hosted-customer-deletion:audit:workspace:completed',
      'hosted-customer-deletion:stripe', 'hosted-customer-deletion:audit:stripe:completed',
      'hosted-customer-deletion:workos', 'hosted-customer-deletion:audit:workos:completed',
      'hosted-customer-deletion:database', 'hosted-customer-deletion:audit:database:completed',
    ]);
    expect(sdk.runStep.mock.calls[0][1].retriesAllowed).toBe(false);
    expect(sdk.runStep.mock.calls[1][1]).toMatchObject({ retriesAllowed: true, maxAttempts: 3 });
    expect(authorize).toHaveBeenCalledOnce();
    expect(workos).toHaveBeenCalledOnce();
    expect(result.steps).toHaveLength(5);
  });
});

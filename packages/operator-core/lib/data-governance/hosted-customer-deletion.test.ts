import { describe, expect, it, vi } from 'vitest';
import { HOSTED_CUSTOMER_DELETION_STEPS, runHostedCustomerDeletion, type HostedCustomerDeletionSeams,
  type HostedCustomerDeletionStepRunner } from './hosted-customer-deletion';

const request = {
  operationId: 'delete-op-1', organizationId: 'org-1', requestedBy: 'user-1',
  target: { kind: 'organization' as const },
  policy: { approvalRef: 'cloud-plan#D-RETENTION', stripe: 'delete' as const, consent: 'retain' as const },
};

function seams(calls: string[], fail?: string): HostedCustomerDeletionSeams {
  const run = (step: string) => async () => {
    calls.push(step);
    if (fail === step) throw new Error(`${step}-provider-down`);
    return `${step}-receipt`;
  };
  return {
    authorize: async () => { calls.push('authorize'); }, access: run('access'),
    workos: run('workos'), stripe: run('stripe'), workspace: run('workspace'), database: run('database'),
    audit: async ({ step, status }) => { calls.push(`audit:${step}:${status}`); },
  };
}

function journal(): HostedCustomerDeletionStepRunner {
  const saved = new Map<string, unknown>();
  return async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    if (saved.has(name)) return saved.get(name) as T;
    const result = await run();
    saved.set(name, result);
    return result;
  };
}

describe('hosted customer deletion orchestration (P-010)', () => {
  it('runs provider, workspace and database stages in order and audits each stage', async () => {
    const calls: string[] = [];
    const result = await runHostedCustomerDeletion(request, seams(calls), journal());
    expect(result.steps).toEqual([
      { step: 'access', status: 'completed', detail: 'access-receipt' },
      { step: 'workspace', status: 'completed', detail: 'workspace-receipt' },
      { step: 'stripe', status: 'completed', detail: 'stripe-receipt' },
      { step: 'workos', status: 'completed', detail: 'workos-receipt' },
      { step: 'database', status: 'completed', detail: 'database-receipt' },
    ]);
    expect(calls).toEqual([
      'authorize', 'access', 'audit:access:completed', 'workspace', 'audit:workspace:completed',
      'stripe', 'audit:stripe:completed', 'workos', 'audit:workos:completed', 'database', 'audit:database:completed',
    ]);
  });

  it('fails closed without an approved retention decision', async () => {
    const calls: string[] = [];
    await expect(runHostedCustomerDeletion({ ...request, policy: { ...request.policy, approvalRef: '' } }, seams(calls), journal()))
      .rejects.toThrow('policy-approval-ref-required');
    expect(calls).toEqual([]);
  });

  it('does not call Stripe when the approved policy retains billing records', async () => {
    const calls: string[] = [];
    const result = await runHostedCustomerDeletion({ ...request, policy: { ...request.policy, stripe: 'retain' } }, seams(calls), journal());
    expect(result.steps.find((step) => step.step === 'stripe')).toEqual({
      step: 'stripe', status: 'skipped', detail: 'retained by approved retention policy',
    });
    expect(calls).not.toContain('stripe');
    expect(calls).toContain('audit:stripe:skipped');
  });

  it('audits a failed step, stops downstream mutation, and resumes completed steps only', async () => {
    const calls: string[] = [];
    const savedSteps = journal();
    let thrown: { results?: unknown[] } | undefined;
    try { await runHostedCustomerDeletion(request, seams(calls, 'workspace'), savedSteps); } catch (error) { thrown = error as typeof thrown; }
    expect(calls).toEqual([
      'authorize', 'access', 'audit:access:completed',
      'workspace', 'audit:workspace:failed',
    ]);
    expect(thrown?.results).toHaveLength(2);
    const replayCalls: string[] = [];
    const resumed = await runHostedCustomerDeletion(request, seams(replayCalls), savedSteps);
    expect(replayCalls).toEqual([
      'workspace', 'audit:workspace:completed', 'stripe', 'audit:stripe:completed',
      'workos', 'audit:workos:completed', 'database', 'audit:database:completed',
    ]);
    expect(resumed.steps.map((step) => step.step)).toEqual([...HOSTED_CUSTOMER_DELETION_STEPS]);
  });

  it('rejects invalid retention values before any mutation', async () => {
    const audit = vi.fn();
    await expect(runHostedCustomerDeletion({ ...request, policy: { ...request.policy, consent: 'purge' as never } }, {
      ...seams([]), audit,
    }, journal())).rejects.toThrow('invalid-retention-policy');
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a forged policy reference through the server admission seam before mutation', async () => {
    const calls: string[] = [];
    await expect(runHostedCustomerDeletion(request, { ...seams(calls),
      authorize: async () => { throw new Error('policy-not-approved'); },
    }, journal())).rejects.toThrow('policy-not-approved');
    expect(calls).toEqual([]);
  });

  it('user deletion does not destroy shared organization workspaces or billing', async () => {
    const calls: string[] = [];
    const result = await runHostedCustomerDeletion({ ...request, target: { kind: 'user', userId: 'user-1' } }, seams(calls), journal());
    expect(calls).not.toContain('workspace');
    expect(calls).not.toContain('stripe');
    expect(result.steps.filter(step => step.status === 'skipped').map(step => step.step)).toEqual(['workspace', 'stripe']);
    expect(calls).toContain('workos');
    expect(calls).toContain('database');
  });

  it('an audit retry never repeats its successful provider mutation or records it as failed', async () => {
    const calls: string[] = [];
    const savedSteps = journal();
    const injected = seams(calls);
    let failed = false;
    const audit: HostedCustomerDeletionSeams['audit'] = async input => {
      if (input.step === 'workspace' && !failed) { failed = true; throw new Error('audit-unavailable'); }
      await injected.audit(input);
    };
    await expect(runHostedCustomerDeletion(request, { ...injected, audit }, savedSteps)).rejects.toThrow('audit-unavailable');
    await runHostedCustomerDeletion(request, { ...injected, audit }, savedSteps);
    expect(calls.filter(call => call === 'workspace')).toHaveLength(1);
    expect(calls).not.toContain('audit:workspace:failed');
    expect(calls).toContain('audit:workspace:completed');
  });

  it('provider failure messages are not copied into audit/customer results', async () => {
    const audit = vi.fn();
    await expect(runHostedCustomerDeletion(request, { ...seams([]), audit,
      workspace: async () => { throw new Error('secret=never-emit user@example.test'); },
    }, journal())).rejects.toThrow('customer-deletion:workspace-failed');
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'workspace', status: 'failed', detail: 'workspace_failed' }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('never-emit');
  });
});

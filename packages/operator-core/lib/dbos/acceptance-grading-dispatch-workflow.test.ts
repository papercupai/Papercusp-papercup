import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ execute: vi.fn(), step: vi.fn(), scope: vi.fn() }));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { registerWorkflow: (fn: unknown) => fn,
    runStep: (fn: () => unknown, options: unknown) => { h.step(options); return fn(); } },
  WorkflowQueue: class { constructor(public name: string) {} },
}));
vi.mock('./idempotent-register-workflow', () => ({
  idempotentRegisterWorkflow: (_name: string, create: () => unknown) => create(),
  idempotentWorkflowQueue: (_name: string, create: () => unknown) => create(),
}));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (workspace: string, fn: () => unknown) => {
  h.scope(workspace); return fn();
} }));
vi.mock('../acceptance-grading-sweep-dispatch', () => ({
  ACCEPTANCE_GRADING_DISPATCH_QUEUE: 'acceptance-grading-dispatch',
  ACCEPTANCE_GRADING_DISPATCH_WORKFLOW: 'acceptanceGradingDispatch',
  executeAcceptanceGradingDispatch: h.execute,
}));
import { acceptanceGradingDispatchWorkflow } from './acceptance-grading-dispatch-workflow';

it('recovers the scoped action through a retryable named DBOS step', async () => {
  const input = { workspaceId: 'ws', harnessSlug: 'app', planSlug: 'plan', gradeableSinceMs: 123 };
  h.execute.mockResolvedValue({ state: 'launched', workflowId: 'episode' });
  await expect(acceptanceGradingDispatchWorkflow(input)).resolves.toEqual({ state: 'launched', workflowId: 'episode' });
  expect(h.scope).toHaveBeenCalledWith('ws');
  expect(h.step).toHaveBeenCalledWith({ name: 'dispatch-grader', retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2 });
  expect(h.execute).toHaveBeenCalledWith(input);
});

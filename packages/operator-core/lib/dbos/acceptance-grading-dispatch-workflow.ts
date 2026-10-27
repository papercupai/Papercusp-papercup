import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  ACCEPTANCE_GRADING_DISPATCH_QUEUE,
  ACCEPTANCE_GRADING_DISPATCH_WORKFLOW,
  executeAcceptanceGradingDispatch,
  type AcceptanceGradingDispatch,
} from '../acceptance-grading-sweep-dispatch';
import { runWithWorkspace } from '../workspace-als';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

// Slow recruitment has its own durable queue; the detector waits only for admission.
export const acceptanceGradingDispatchQueue = idempotentWorkflowQueue(ACCEPTANCE_GRADING_DISPATCH_QUEUE,
  () => new WorkflowQueue(ACCEPTANCE_GRADING_DISPATCH_QUEUE, { concurrency: queueConcurrency(4) }));

export const acceptanceGradingDispatchWorkflow = idempotentRegisterWorkflow(ACCEPTANCE_GRADING_DISPATCH_WORKFLOW,
  () => DBOS.registerWorkflow(async (input: AcceptanceGradingDispatch) =>
    runWithWorkspace(input.workspaceId, () => DBOS.runStep(() => executeAcceptanceGradingDispatch(input), {
      name: 'dispatch-grader', retriesAllowed: true, maxAttempts: 5, intervalSeconds: 2,
    })), { name: ACCEPTANCE_GRADING_DISPATCH_WORKFLOW, maxRecoveryAttempts: 10 }));

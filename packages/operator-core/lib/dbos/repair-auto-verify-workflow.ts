/**
 * D-131: durable waiter for the debounced auto-verify after a persisted repair admit.
 *
 * Decision logic lives in `release/repair-auto-verify.ts`; this file only binds it to DBOS so the
 * quiet-window sleep and the fire-time steps survive an operator restart. One workflow per
 * repair head (`repairAutoVerifyWorkflowId`) is the per-head idempotence key.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { isCheckpointRunLockHeldCheap, launchDetachedCheckpoint } from '../release-checkpoint-launch';
import { integrationRoot } from '../release-deploy-launch';
import { readFrozenCandidateRepairQueueState } from '../harness/routines/release-actions';
import { activeWorkspaceId } from '../workspace-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { resolveCheckpointRouting } from '../harness/routines/hive-release-env';
import type { GateVerdictTarget } from '../release/gate-verdict-target';
import {
  repairAutoVerifyWorkflowId,
  runRepairAutoVerify,
  setRepairAutoVerifyRunner,
  type RepairAutoVerifyOutcome,
  type RepairAutoVerifyRequest,
  type RepairQueueReading,
} from '../release/repair-auto-verify';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

async function readQueueReading(target: GateVerdictTarget): Promise<RepairQueueReading> {
  const read = await readFrozenCandidateRepairQueueState(target);
  if (read.status === 'value') return { status: 'value', queue: read.queue };
  if (read.status === 'absent') return { status: 'absent' };
  return { status: 'unreadable', detail: read.reason };
}

async function repairAutoVerifyImpl(input: RepairAutoVerifyRequest): Promise<RepairAutoVerifyOutcome> {
  const target = input.target ?? { workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() };
  const routing = await resolveCheckpointRouting(target, integrationRoot());
  if (routing.skip) return { status: 'not-launched', repairHead: input.repairHead,
    reason: `checkpoint_routing_skip:${routing.skip.reason}` };
  const subjectRoot = routing.extraEnv.PAPERCUSP_INTEGRATION_ROOT ?? routing.root;
  const outcome = await runRepairAutoVerify(input, {
    sleep: (ms) => DBOS.sleep(ms),
    readQueue: () => DBOS.runStep(() => readQueueReading(target), { name: 'repair-auto-verify-read-queue' }),
    runLockHeld: () =>
      DBOS.runStep(async () => isCheckpointRunLockHeldCheap(subjectRoot).held, {
        name: 'repair-auto-verify-run-lock',
      }),
    launch: () =>
      DBOS.runStep(
        async () => {
          const r = await launchDetachedCheckpoint({ root: routing.root, integrationRoot: subjectRoot,
            extraEnv: routing.extraEnv, clearEnv: routing.clearEnv, target });
          return { launched: r.launched, unit: r.unit ?? null, reason: r.reason ?? null };
        },
        { name: 'repair-auto-verify-launch' },
      ),
  });
  console.log(`[repair-auto-verify] ${input.repairHead.slice(0, 12)}: ${JSON.stringify(outcome)}`);
  return outcome;
}

export const repairAutoVerifyWorkflow = idempotentRegisterWorkflow('repairAutoVerify', () =>
  DBOS.registerWorkflow(repairAutoVerifyImpl, { name: 'repairAutoVerify', maxRecoveryAttempts: 5 }),
);

const repairAutoVerifyQueue = idempotentWorkflowQueue(
  'repair-auto-verify',
  () => new WorkflowQueue('repair-auto-verify', { concurrency: queueConcurrency(4) }),
);

export async function enqueueRepairAutoVerify(input: RepairAutoVerifyRequest): Promise<{ workflowId: string }> {
  const workflowId = repairAutoVerifyWorkflowId(input.repairHead, input.target);
  await DBOS.startWorkflow(repairAutoVerifyWorkflow, {
    workflowID: workflowId,
    queueName: repairAutoVerifyQueue.name,
    enqueueOptions: { deduplicationID: workflowId },
  })(input);
  return { workflowId };
}

/** Wire the request-side seam after DBOS has been registered by host bootstrap. */
export function wireRepairAutoVerify(): void {
  setRepairAutoVerifyRunner(enqueueRepairAutoVerify);
}

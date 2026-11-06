/** One durable action per interrupted native host, never per census tick.
 * Session/launch ledgers remain the business-state and OS-process fences. */
import { createHash } from 'node:crypto';
import { DBOS, DBOSClient, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { withDbosIdleTxGrace } from './bootstrap';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { createSessionInterruptionRuntime, type RecoveryOutcome, type SessionInterruptionRuntime } from '../harness/routines/session-interruption-runtime';
import { classifySessionInterruption, sessionRecoveryKey, SESSION_RECOVERY_MAX_ATTEMPTS,
  type SessionRecoveryEvidence } from '../harness/routines/session-interruption-recovery';

export interface SessionInterruptionInput {
  workspaceId: string;
  installSlug: string;
  ownerId: string;
  key: string;
}
export interface SessionRecoveryStepHost {
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(deadline: number): Promise<void>;
}
const stepHost: SessionRecoveryStepHost = {
  step: (name, fn) => {
    if (!DBOS.isWithinWorkflow() || DBOS.isInStep()) throw new Error('session recovery requires a DBOS workflow context');
    return DBOS.runStep(fn, { name });
  },
  sleepUntil: deadline => DBOS.sleep(Math.max(0, deadline - Date.now())),
};
const matches = (candidate: SessionRecoveryEvidence | null, input: SessionInterruptionInput): candidate is SessionRecoveryEvidence =>
  !!candidate?.interruption && candidate.ownerId === input.ownerId && sessionRecoveryKey(candidate.interruption) === input.key;

type RuntimeFactory = (input: SessionInterruptionInput) => Promise<SessionInterruptionRuntime>;
let configuredRuntime: RuntimeFactory | null = null;
/** Isolated controller/native-host test seam; production uses the SQL adapter. */
export function configureSessionInterruptionRuntime(factory: RuntimeFactory | null): void { configuredRuntime = factory; }

export async function runSessionInterruption(input: SessionInterruptionInput,
  host: SessionRecoveryStepHost = stepHost): Promise<RecoveryOutcome> {
  // Construction performs no effects outside a checkpoint. The census owns WAL
  // ingestion; each action step re-reads the authoritative current records.
  const runtime = await (configuredRuntime ?? (value => createSessionInterruptionRuntime({
    workspaceId: value.workspaceId, installSlug: value.installSlug, triggerConfig: {}, payloadTemplate: null,
  }, false, { initialize: false, actionId: sessionInterruptionWorkflowId(value) })))(input);
  for (let ordinal = 0; ordinal < SESSION_RECOVERY_MAX_ATTEMPTS; ordinal += 1) {
    const prefix = `recovery:${ordinal}`;
    const admitted = await host.step(`${prefix}:admission`, async () => {
      const current = await runtime.read(input.ownerId);
      return matches(current, input) ? current : null;
    });
    if (!admitted) return { verified: false, reason: 'interruption-source-changed', terminal: true };
    // DBOS persists the wake boundary; controller replay cannot extend it.
    const ownsReservation = admitted.interruption!.state === 'recovering' &&
      admitted.interruption!.actionId === sessionInterruptionWorkflowId(input);
    if (!ownsReservation && admitted.interruption!.nextAttemptAt > 0) await host.sleepUntil(admitted.interruption!.nextAttemptAt);
    const claimed = await host.step(`${prefix}:reservation`, async () => {
      const current = await runtime.read(input.ownerId);
      // SQL may commit before DBOS records this step. Adopt only this action's lease.
      if (matches(current, input) && current.interruption!.state === 'recovering' &&
          current.interruption!.actionId === sessionInterruptionWorkflowId(input)) return current;
      if (!matches(current, input) || classifySessionInterruption(current, Date.now()).action === 'hold') return null;
      return runtime.claim(current, input.key);
    });
    if (!claimed) return { verified: false, reason: 'ineligible-or-claim-lost', terminal: true };
    const dispatched = await host.step(`${prefix}:guarded-launch`, async (): Promise<RecoveryOutcome> => {
      const existing = await runtime.verify(claimed);
      if (existing.verified) return existing;
      const current = await runtime.read(input.ownerId);
      if (!matches(current, input) || current.interruption!.leaseKey !== claimed.interruption!.leaseKey) {
        return { verified: false, reason: 'interruption-reservation-lost', terminal: true };
      }
      // A lost launch response is NOT evidence of no process creation, even
      // after lease expiry. This check must precede the retry-deadline branch.
      if (current.interruption!.dispatchStartedAt != null) return { verified: false, reason: 'uncertain-native-creation', terminal: true };
      const decision = classifySessionInterruption(current, Date.now(), claimed.interruption!.leaseKey);
      if (decision.action === 'hold') return { verified: false, reason: decision.reason, terminal: true };
      if (current.interruption!.nextAttemptAt <= Date.now()) return { verified: false, reason: 'reservation-expired-before-dispatch' };
      if (!await runtime.markDispatch(current)) return { verified: false, reason: 'uncertain-native-creation', terminal: true };
      try {
        const launched = await runtime.restore(current, decision, input.key);
        return { ...launched, ...(!launched.verified ? { terminal: true } : {}) };
      } catch (error) {
        return { verified: false, reason: `uncertain-native-creation:${error instanceof Error ? error.message : String(error)}`, terminal: true };
      }
    });
    const verified = await host.step(`${prefix}:native-identity`, async (): Promise<RecoveryOutcome> => {
      const observed = await runtime.verify(claimed);
      return observed.verified ? observed : dispatched.verified
        ? { verified: false, reason: 'native-identity-unconfirmed', terminal: true } : dispatched;
    });
    const settled = await host.step(`${prefix}:settlement`, () => runtime.finish(claimed, input.key, verified));
    if (!settled) return { verified: false, reason: 'settlement-reservation-lost', terminal: true };
    if (verified.verified || verified.terminal) return verified;
  }
  return { verified: false, reason: 'retry-budget-exhausted', terminal: true };
}

export const SESSION_INTERRUPTION_WORKFLOW_NAME = 'sessionInterruptionRecovery';
export function sessionInterruptionWorkflowId(input: SessionInterruptionInput): string {
  const digest = createHash('sha256').update(JSON.stringify([input.workspaceId, input.ownerId, input.key])).digest('hex');
  return `session-interruption:${digest}`;
}
export const sessionInterruptionWorkflow = idempotentRegisterWorkflow(SESSION_INTERRUPTION_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow((input: SessionInterruptionInput) => runSessionInterruption(input),
    { name: SESSION_INTERRUPTION_WORKFLOW_NAME, maxRecoveryAttempts: 10 }));
export const sessionInterruptionQueue = idempotentWorkflowQueue('session-interruption', () => new WorkflowQueue('session-interruption'));

type RecoveryClient = Pick<DBOSClient, 'enqueue'>;
let clientPromise: Promise<RecoveryClient> | null = null;
function client(): Promise<RecoveryClient> {
  clientPromise ??= DBOSClient.create({ systemDatabaseUrl: withDbosIdleTxGrace(getHarnessAdminUrlWithSource().url),
    systemDatabaseSchemaName: 'dbos' }).catch(error => { clientPromise = null; throw error; });
  return clientPromise;
}
export async function enqueueSessionInterruption(input: SessionInterruptionInput,
  getClient: () => Promise<RecoveryClient> = client): Promise<{ workflowId: string }> {
  const workflowID = sessionInterruptionWorkflowId(input);
  // Client enqueue is legal inside the census routine's existing DBOS step.
  // Stable workflow/dedup identity reconciles an enqueue with a lost response.
  await (await getClient()).enqueue({ queueName: sessionInterruptionQueue.name,
    workflowName: SESSION_INTERRUPTION_WORKFLOW_NAME, workflowID,
    deduplicationID: workflowID, duplicationPolicy: 'return-existing',
    appVersion: process.env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim() || process.env.DBOS__APPVERSION?.trim() || 'bg-host-v1',
  }, input);
  return { workflowId: workflowID };
}

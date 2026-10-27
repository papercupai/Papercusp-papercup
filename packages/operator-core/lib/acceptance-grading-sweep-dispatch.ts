import { createHash } from 'node:crypto';
import type { GradingLaunchProfile } from './acceptance-grader';

export const ACCEPTANCE_GRADING_DISPATCH_WORKFLOW = 'acceptanceGradingDispatch';
export const ACCEPTANCE_GRADING_DISPATCH_QUEUE = 'acceptance-grading-dispatch';

export interface AcceptanceGradingDispatch {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  gradeableSinceMs: number;
  gradingLaunch?: GradingLaunchProfile;
}

/** Persisted episode identity, independent of tick time, process and retry count. */
export function acceptanceGradingDispatchId(input: AcceptanceGradingDispatch): string {
  if (![input.workspaceId, input.harnessSlug, input.planSlug].every(v => typeof v === 'string' && v.trim())
    || !Number.isSafeInteger(input.gradeableSinceMs) || input.gradeableSinceMs < 0) {
    throw new Error('acceptance grading dispatch requires complete scope and gradeable-since');
  }
  const digest = createHash('sha256').update(JSON.stringify([
    input.workspaceId, input.harnessSlug, input.planSlug, input.gradeableSinceMs,
  ])).digest('hex');
  return `acceptance-grading-dispatch:${digest}`;
}

type PrimaryClient = Awaited<ReturnType<typeof import('./dbos/primary-dbos-client').getPrimaryDbosClient>>;

/** The client admission path works from ephemeral actions and from a routine's DBOS step. */
export async function enqueueAcceptanceGradingDispatch(
  input: AcceptanceGradingDispatch,
  deps: { client?: () => Promise<Pick<PrimaryClient, 'enqueue'>>; appVersion?: () => string } = {},
): Promise<{ workflowId: string }> {
  const workflowId = acceptanceGradingDispatchId(input);
  const primary = await import('./dbos/primary-dbos-client');
  const client = await (deps.client ?? primary.getPrimaryDbosClient)();
  await client.enqueue({
    workflowName: ACCEPTANCE_GRADING_DISPATCH_WORKFLOW,
    queueName: ACCEPTANCE_GRADING_DISPATCH_QUEUE,
    workflowID: workflowId,
    deduplicationID: workflowId,
    duplicationPolicy: 'return-existing',
    appVersion: (deps.appVersion ?? primary.primaryDbosAppVersion)(),
  }, input);
  return { workflowId };
}

/** The receiver's existing launch ledger dedups even an effect-before-step-ack replay. */
export async function executeAcceptanceGradingDispatch(
  input: AcceptanceGradingDispatch,
  deps: { resolve?: typeof import('./acceptance-grader').resolveAcceptanceGrader } = {},
): Promise<{ state: string; workflowId: string }> {
  const workflowId = acceptanceGradingDispatchId(input);
  const { ACCEPTANCE_GRADING_SWEEP_ACTOR, resolveAcceptanceGrader } = await import('./acceptance-grader');
  const result = await (deps.resolve ?? resolveAcceptanceGrader)(input.planSlug, {
    log: (message: string) => console.log(`[acceptance-grading-dispatch] ${message}`),
    signal: new AbortController().signal,
    progress: () => {},
    emit: () => {},
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    ...(input.gradingLaunch ? { gradingLaunch: input.gradingLaunch } : {}),
    principal: { kind: 'system', slug: ACCEPTANCE_GRADING_SWEEP_ACTOR, workspaceId: input.workspaceId, capabilities: new Set<string>() },
  } satisfies Parameters<typeof resolveAcceptanceGrader>[1], { dispatchEpisodeIdentity: workflowId });
  if (!['assigned', 'launched', 'deduped', 'settled'].includes(result.state)) {
    throw new Error(result.error ?? `acceptance grader resolve returned ${result.state}`);
  }
  return { state: result.state, workflowId };
}

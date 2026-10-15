/** P-019: fresh native sessions over one task workspace, bounded by measured treatment spend.
 * Reuses RunAgentInput/AgentRunOutput; the supplied session port must open a NEW native session
 * each time. Unlike the independent ensemble, this control keeps edits in the SAME handle and
 * never chooses a winning submission using grader feedback. It does not authorize model spend.
 */
import type { AgentRunOutput, AgentRunUsage, RunAgentInput } from './run-topology';
import type { IsoBudget } from './coordination-topology';

export interface RepeatedSessionOptions<H> {
  /** Actual spend of the paired Papercusp task, including every participating agent and restart. */
  treatmentCostUsd: number;
  /** Preregistered runaway bound, including sessions reporting zero cost. */
  maxSessions: number;
  openFreshSession(input: RunAgentInput<H>, sessionIndex: number): Promise<AgentRunOutput>;
  now?: () => number;
}

export interface RepeatedSessionResult {
  sessions: AgentRunOutput[];
  usage: AgentRunUsage;
  submission: unknown;
  stop: 'matched-cost' | 'budget-exhausted' | 'session-limit' | 'error';
  error?: string;
}

function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative.`);
}

/** Check BEFORE every launch, including after a session overshot its supplied remaining cap.
 * Actual overspend is retained in usage; never clip it to the cap to make a pair look matched.
 */
export async function runRepeatedSessions<H>(
  input: RunAgentInput<H>, options: RepeatedSessionOptions<H>,
): Promise<RepeatedSessionResult> {
  nonnegative(options.treatmentCostUsd, 'treatmentCostUsd');
  if (!Number.isSafeInteger(options.maxSessions) || options.maxSessions < 1) {
    throw new Error('maxSessions must be a positive safe integer.');
  }
  for (const [key, value] of Object.entries(input.attemptBudget)) {
    if (value !== undefined) nonnegative(value, key);
  }
  const now = options.now ?? Date.now;
  const started = now();
  const sessions: AgentRunOutput[] = [];
  const usage: AgentRunUsage = { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 };
  const tokensSpent = () => usage.tokensIn + usage.tokensOut + (usage.tokensCacheRead ?? 0) + (usage.tokensCacheWrite ?? 0);
  let submission: unknown = '';
  const result = (stop: RepeatedSessionResult['stop'], error?: string): RepeatedSessionResult =>
    ({ sessions, usage, submission, stop, ...(error ? { error } : {}) });
  for (let index = 0; index < options.maxSessions; index++) {
    if (usage.costUsd >= options.treatmentCostUsd) return result('matched-cost');
    const elapsed = Math.max(0, now() - started);
    const cap = input.attemptBudget;
    if ((cap.maxCostUsd !== undefined && usage.costUsd >= cap.maxCostUsd) ||
      (cap.maxModelCalls !== undefined && usage.modelCalls >= cap.maxModelCalls) ||
      (cap.maxTokens !== undefined && tokensSpent() >= cap.maxTokens) ||
      (cap.maxWallMs !== undefined && elapsed >= cap.maxWallMs)) return result('budget-exhausted');
    const remaining: IsoBudget = {
      maxCostUsd: Math.min(options.treatmentCostUsd, cap.maxCostUsd ?? Infinity) - usage.costUsd,
      ...(cap.maxModelCalls !== undefined ? { maxModelCalls: cap.maxModelCalls - usage.modelCalls } : {}),
      ...(cap.maxTokens !== undefined ? { maxTokens: cap.maxTokens - tokensSpent() } : {}),
      ...(cap.maxWallMs !== undefined ? { maxWallMs: cap.maxWallMs - elapsed } : {}),
    };
    let output: AgentRunOutput;
    try {
      output = await options.openFreshSession({
        ...input, teamKey: `${input.teamKey}/fresh-session/${index}`, attemptBudget: remaining,
        // No previous conversational answer, carry note, or hidden verifier result is delivered.
        candidates: undefined,
        directive: `${input.directive}\nInspect the current task workspace. What is not done yet? Continue implementing and checking the task.`,
      }, index);
    } catch (e) {
      return result('error', `Fresh session failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    sessions.push(output); // Retain the raw receipt even if its accounting is invalid.
    try {
      for (const key of ['modelCalls', 'tokensIn', 'tokensOut', 'costUsd', 'turns'] as const) {
        nonnegative(output[key], `session ${index} ${key}`);
      }
      for (const key of ['tokensCacheRead', 'tokensCacheWrite'] as const) {
        nonnegative(output[key] ?? 0, `session ${index} ${key}`);
      }
    } catch (e) {
      return result('error', e instanceof Error ? e.message : String(e));
    }
    for (const key of ['modelCalls', 'tokensIn', 'tokensOut', 'costUsd', 'turns'] as const) {
      usage[key] += output[key];
      if (!Number.isFinite(usage[key])) return result('error', `Cumulative ${key} overflowed.`);
    }
    for (const key of ['tokensCacheRead', 'tokensCacheWrite'] as const) {
      if (usage[key] !== undefined || output[key] !== undefined) {
        usage[key] = (usage[key] ?? 0) + (output[key] ?? 0);
        if (!Number.isFinite(usage[key])) return result('error', `Cumulative ${key} overflowed.`);
      }
    }
    submission = output.submission;
    if (output.status !== 'completed') return result('error', output.error ?? `Fresh session ended ${output.status}.`);
    if (output.capped) return result(usage.costUsd >= options.treatmentCostUsd ? 'matched-cost' : 'budget-exhausted');
  }
  return result(usage.costUsd >= options.treatmentCostUsd ? 'matched-cost' : 'session-limit');
}

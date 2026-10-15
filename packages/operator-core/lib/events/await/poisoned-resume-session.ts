import { markAdvSessionEnded } from '../../adv-sessions';
import { analyzeClaudeResumeTranscriptFile, CLAUDE_TOOL_REFERENCE_POISON_TURNS } from '../../claude-resume-tool-references.mjs';
import { markSessionBriefPoisoned, type SessionBriefPoisonMarker } from '../../session-brief';
import { analyzeCodexRolloutFile, CODEX_CONTEXT_OVERFLOW_POISON_TURNS } from './codex-rollout-overflow';
import type { ResumeTurnContext } from './resume-turn-outcome';

export interface PoisonedResumeResult {
  poisoned: boolean;
  turns: number;
  ended?: boolean;
  reason?: string;
}

export interface PoisonedResumeDeps {
  analyze?: typeof analyzeClaudeResumeTranscriptFile;
  markBrief?: typeof markSessionBriefPoisoned;
  markEnded?: typeof markAdvSessionEnded;
  now?: () => Date;
}

/**
 * Quarantine one Claude session incarnation after its transcript records the
 * exact unavailable-tool-reference error on three consecutive assistant turns.
 * The durable brief marker blocks queued wakes; the adv-session end schedules
 * the existing lock/work-item lease release hook.
 */
export async function quarantineRepeatedClaudeToolReferenceFailures(
  context: ResumeTurnContext | null | undefined,
  evidence: string,
  deps: PoisonedResumeDeps = {},
): Promise<PoisonedResumeResult> {
  if (
    !context || context.agent !== 'claude' || !Number.isSafeInteger(context.advSessionId) ||
    context.advSessionId <= 0 || !context.ownerId || !context.workspaceId || !context.sessionId ||
    !context.startedAt || !context.transcriptPath
  ) return { poisoned: false, turns: 0, reason: 'resume identity or transcript unavailable' };

  const analysis = (deps.analyze ?? analyzeClaudeResumeTranscriptFile)(context.transcriptPath);
  if (!analysis) return { poisoned: false, turns: 0, reason: 'Claude transcript could not be read' };
  if (analysis.trailingMissingToolReferenceTurns < CLAUDE_TOOL_REFERENCE_POISON_TURNS) {
    return { poisoned: false, turns: analysis.trailingMissingToolReferenceTurns };
  }

  return poisonIncarnation(
    context as PoisonableContext,
    analysis.trailingMissingToolReferenceTurns,
    `${analysis.trailingMissingToolReferenceTurns} consecutive Claude assistant turns replayed an unavailable Papercusp tool reference`,
    evidence,
    deps,
  );
}

export interface CodexOverflowDeps extends PoisonedResumeDeps {
  analyzeCodex?: typeof analyzeCodexRolloutFile;
}

/**
 * Quarantine one Codex session incarnation once its persisted rollout records
 * CODEX_CONTEXT_OVERFLOW_POISON_TURNS consecutive turns that exceeded the model
 * context window (WI-6554700010008894). Such a thread cannot be resumed or
 * compacted natively, so re-firing its wakes only re-fails them; the incarnation
 * is ended (releasing its claims) and needs a relaunch onto a fresh thread.
 */
export async function quarantineRepeatedCodexContextOverflow(
  context: ResumeTurnContext | null | undefined,
  evidence: string,
  deps: CodexOverflowDeps = {},
): Promise<PoisonedResumeResult> {
  if (
    !context || context.agent !== 'codex' || !Number.isSafeInteger(context.advSessionId) ||
    context.advSessionId <= 0 || !context.ownerId || !context.workspaceId || !context.sessionId ||
    !context.startedAt || !context.transcriptPath
  ) return { poisoned: false, turns: 0, reason: 'resume identity or Codex rollout unavailable' };

  const analysis = (deps.analyzeCodex ?? analyzeCodexRolloutFile)(context.transcriptPath);
  if (!analysis) return { poisoned: false, turns: 0, reason: 'Codex rollout could not be read' };
  const turns = analysis.trailingContextOverflowTurns;
  if (turns < CODEX_CONTEXT_OVERFLOW_POISON_TURNS) return { poisoned: false, turns };

  const window = analysis.modelContextWindow ? ` of ${analysis.modelContextWindow} tokens` : '';
  return poisonIncarnation(
    context as PoisonableContext,
    turns,
    `${turns} consecutive Codex turns exceeded the model context window${window}; ` +
      'no resume or native compaction can fit this thread, so it needs a relaunch onto a fresh thread',
    evidence,
    deps,
  );
}

type PoisonableContext = ResumeTurnContext & {
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  startedAt: string;
};

/** Write the durable brief marker (blocks queued wakes), then end the adv-session (releases leases). */
async function poisonIncarnation(
  context: PoisonableContext,
  turns: number,
  reason: string,
  evidence: string,
  deps: PoisonedResumeDeps,
): Promise<PoisonedResumeResult> {
  const now = (deps.now ?? (() => new Date()))();
  const marker: SessionBriefPoisonMarker = {
    advSessionId: context.advSessionId,
    sessionId: context.sessionId,
    startedAt: context.startedAt,
    at: now.toISOString(),
    by: 'resume-turn-detector',
    reason,
    evidence: evidence.slice(0, 400),
  };
  const markBrief = deps.markBrief ?? markSessionBriefPoisoned;
  if (!(await markBrief(context.ownerId, context.workspaceId, marker))) {
    return {
      poisoned: false,
      turns,
      reason: 'durable poison marker write failed; leaving the session retryable',
    };
  }

  const markEnded = deps.markEnded ?? markAdvSessionEnded;
  const ended = await markEnded(context.advSessionId, null, 'reconciler', { observedAt: now });
  return { poisoned: true, turns, ended };
}

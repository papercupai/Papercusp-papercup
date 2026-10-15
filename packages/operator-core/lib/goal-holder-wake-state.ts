/**
 * P-007 (goal-grading-live-coverage-and-holder-followthrough-2026-10-08, R-7): the state a
 * goal holder used to re-fetch at the top of every loop wake — its goal portfolio snapshot,
 * its loop cadence and its obligation agenda — read ONCE at fire time and delivered IN the
 * wake text.
 *
 * Measured baseline (holder su-d5bfd1a5 on goal 60d3a8, 2026-10-07..08, 1,365 agent-origin
 * calls): ~60% were self-management, led by loop:status (192), loop:checkpoint (153),
 * goals:get (122) and coord:orient (99). The turn-start Orientation block fires only on a
 * state CHANGE and only on hosts that inject it (that holder ran on codex), so a quiet wake
 * carried none of this and the holder re-derived it by hand — every result ~6k chars into
 * context, which is what drove its 24 self-requested carry-respawns.
 *
 * Reuse (plan D-003): the snapshot is `readAgentObligationAgenda`'s own `portfolio` (the
 * same canonical read coord:orient and turn-start orientation use), rendered by
 * `renderGoalPortfolioBrief`; the obligations are the exact turn-start projection
 * (`projectAgentTurnStartObligationBrief`), so the wake never shows a different subset
 * than the cockpit or orientation.
 */
import {
  projectAgentTurnStartObligationBrief,
  readAgentObligationAgenda,
  type AgentObligationAgendaRead,
} from './agent-obligation-reader';
import { renderGoalPortfolioBrief } from './goal-launch-settings';

/** The portfolio snapshot's share of the wake; the full snapshot stays one goals:get away. */
export const GOAL_HOLDER_WAKE_PORTFOLIO_MAX_CHARS = 2_000;
/** A loop fire must never hang on the agenda read; past this the wake ships without the block. */
export const GOAL_HOLDER_WAKE_READ_TIMEOUT_MS = 8_000;

export interface GoalHolderWakeLoop {
  /** This fire's 1-based number. */
  fireNumber: number;
  intervalSec: number | null;
  firedAtMs: number;
}

export type GoalHolderWakeRead = Pick<
  AgentObligationAgendaRead,
  'agenda' | 'goalId' | 'portfolio' | 'observedAt' | 'degradedSources'
>;

export function clipForWake(text: string, max: number, pointer: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}… [clipped at ${max} of ${text.length} chars — ${pointer}]`;
}

/**
 * Render the goal-holder state block. Returns null when the read names no goal (the owner
 * is not a goal holder), so a non-holder's wake is byte-identical to before.
 *
 * Honesty rule: the block tells the holder NOT to re-fetch only what it actually carries.
 * A snapshot that failed to read is named as unavailable with the one call that recovers
 * it, and degraded agenda sources are listed so the holder re-reads exactly those.
 */
export function renderGoalHolderWakeState(input: { read: GoalHolderWakeRead; loop: GoalHolderWakeLoop }): string | null {
  const { read, loop } = input;
  if (!read.goalId) return null;
  const carried: string[] = ['loop:status'];
  const nextFireAt =
    loop.intervalSec != null && loop.intervalSec > 0
      ? new Date(loop.firedAtMs + loop.intervalSec * 1000).toISOString()
      : null;
  const loopLine =
    `Loop: active — wake #${loop.fireNumber}` +
    (nextFireAt ? `, every ${loop.intervalSec}s, next fire ≈ ${nextFireAt}` : '') +
    ". Read the re-wake verdict from your loop:checkpoint response's `continuation` (the same classifier as loop:status) instead of calling loop:status.";

  let snapshot: string;
  if (read.portfolio) {
    snapshot = clipForWake(
      renderGoalPortfolioBrief(read.portfolio),
      GOAL_HOLDER_WAKE_PORTFOLIO_MAX_CHARS,
      `goals:get { id: '${read.goalId}' } for the full snapshot`,
    );
    carried.push('goals:get');
  } else {
    snapshot = `Goal snapshot: UNAVAILABLE at fire time — call goals:get { id: '${read.goalId}' } once.`;
  }

  const brief = projectAgentTurnStartObligationBrief(read.agenda);
  const obligationText = brief.projection.text.trim();
  const obligationsLine = `Obligations (top ${brief.projection.entries.length}; ${brief.detailRef}): ${
    obligationText || 'none open.'
  }`;
  const degraded = read.degradedSources.length
    ? [`Degraded at fire time: ${read.degradedSources.join(', ')} — re-read only those.`]
    : [];

  return [
    `GOAL-HOLDER STATE — goal ${read.goalId}, read at fire time ${read.observedAt}. This block is this wake's goal orientation: do NOT re-fetch it with ${carried.join(' / ')}. coord:orient is needed only for the claimable backlog, full inbox bodies or the complete obligation agenda.`,
    loopLine,
    snapshot,
    obligationsLine,
    ...degraded,
  ].join('\n');
}

/**
 * Read + render for one loop fire. Fail-soft and bounded: a timeout or a failed read
 * returns null and the wake ships exactly as it did before P-007.
 */
export async function readGoalHolderWakeState(input: {
  workspaceId: string;
  ownerId: string;
  loop: GoalHolderWakeLoop;
  now?: Date;
  timeoutMs?: number;
  readAgenda?: (args: {
    workspaceId: string;
    ownerId: string;
    now?: Date;
    sourceTimeoutMs?: number;
  }) => Promise<GoalHolderWakeRead>;
}): Promise<string | null> {
  const readAgenda = input.readAgenda ?? readAgentObligationAgenda;
  const timeoutMs = input.timeoutMs ?? GOAL_HOLDER_WAKE_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = await Promise.race([
      readAgenda({
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        now: input.now,
        sourceTimeoutMs: Math.max(1, timeoutMs - 500),
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!read) return null;
    return renderGoalHolderWakeState({ read, loop: input.loop });
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

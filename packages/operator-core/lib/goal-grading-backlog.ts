/**
 * Goal grading-backlog detector — plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08
 * P-002 / R-2.
 *
 * Measured 2026-10-08: the goal-mode-e2e grader for goal 60d3a8 sat idle ~16h while
 * the holder kept working, and the newest settled card ended ~40h before anyone
 * noticed. Nothing measured "how far behind is grading". This module does, from the
 * ledgers that already exist (D-003 reuse-first): goal-stamped `tool_invocations`
 * (the same ledger `resolveHolderGoalForWindow` trusts) for holder ACTIVITY, and
 * goal-mode-e2e scorecards (observation-lane work_items) for GRADED coverage.
 *
 * The classifier is pure; `readGoalGradingBacklogInput` is the one SQL read; the sweep
 * that raises the owner-visible alert lives beside the owner-report watchdog and
 * rides its existing managed timer (no new scheduler).
 */
import type { Sql } from 'postgres';

import { GOAL_COMPUTED_CARD_AUTHOR } from './goal-computed-tenure-card';

export const GOAL_GRADING_RUBRIC_REF = 'goal-mode-e2e';
/** Ungraded active holder hours before the backlog alerts. */
export const GOAL_GRADING_BACKLOG_MAX_UNGRADED_HOURS = 6;
/** Hours since the grader last filed any card (final or provisional) for this goal. */
export const GOAL_GRADING_BACKLOG_MAX_GRADER_IDLE_HOURS = 4;
/** How far back activity and cards are read. */
export const GOAL_GRADING_BACKLOG_LOOKBACK_MS = 7 * 24 * 3600_000;

const HOUR_MS = 3600_000;

export interface GoalGradingBacklogInput {
  goalId: string;
  nowMs: number;
  /** Epoch-ms timestamps of goal-stamped holder calls in the lookback. */
  activityMs: readonly number[];
  /** goal-mode-e2e cards whose subject is one of this goal's holders. */
  cards: ReadonlyArray<{ windowStartMs: number; windowEndMs: number; createdMs: number; final: boolean }>;
  /** Author of the newest card (any kind): the grader the sweep wakes. Not used by
   *  the classifier; null when no card names an author. */
  lastCardAuthor?: string | null;
  thresholds?: { maxUngradedHours?: number; maxGraderIdleHours?: number };
}

export type GoalGradingBacklogAlertKind = 'grading-backlog' | 'grader-idle';

export interface GoalGradingBacklogVerdict {
  goalId: string;
  healthy: boolean;
  /** Distinct clock hours with holder activity not covered by any FINAL card window. */
  ungradedActiveHours: number;
  /** Distinct clock hours with holder activity in the lookback. */
  activeHours: number;
  /** The newest settled (final) card window end, or null when none exists. */
  lastGradedWindowEnd: string | null;
  /** Hours since the newest card of any kind was filed; null when none was ever filed. */
  graderIdleHours: number | null;
  alerts: GoalGradingBacklogAlertKind[];
  reason: string;
}

/**
 * Pure classifier. Activity is bucketed into clock hours so a burst of calls counts
 * once and a quiet goal accrues no backlog: an idle goal owes no grading. An hour is
 * covered when any FINAL card window overlaps it; provisional cards are working
 * notes (D-004) and never cover, but they DO count as grader activity.
 */
export function classifyGoalGradingBacklog(input: GoalGradingBacklogInput): GoalGradingBacklogVerdict {
  const maxUngraded = input.thresholds?.maxUngradedHours ?? GOAL_GRADING_BACKLOG_MAX_UNGRADED_HOURS;
  const maxIdle = input.thresholds?.maxGraderIdleHours ?? GOAL_GRADING_BACKLOG_MAX_GRADER_IDLE_HOURS;
  const finals = input.cards.filter((c) => c.final && c.windowEndMs > c.windowStartMs);

  const activeBuckets = new Set<number>();
  for (const at of input.activityMs) {
    if (Number.isFinite(at) && at <= input.nowMs) activeBuckets.add(Math.floor(at / HOUR_MS));
  }
  let ungraded = 0;
  for (const bucket of activeBuckets) {
    const start = bucket * HOUR_MS;
    const end = start + HOUR_MS;
    if (!finals.some((c) => c.windowStartMs < end && c.windowEndMs > start)) ungraded += 1;
  }

  const lastFinalEnd = finals.reduce<number | null>((m, c) => (m === null || c.windowEndMs > m ? c.windowEndMs : m), null);
  const lastCardCreated = input.cards.reduce<number | null>((m, c) => (m === null || c.createdMs > m ? c.createdMs : m), null);
  const graderIdleHours = lastCardCreated === null ? null : Math.max(0, (input.nowMs - lastCardCreated) / HOUR_MS);

  const alerts: GoalGradingBacklogAlertKind[] = [];
  if (ungraded > maxUngraded) alerts.push('grading-backlog');
  // An idle grader matters only while something is waiting to be graded.
  if (ungraded > 0 && (graderIdleHours === null || graderIdleHours > maxIdle)) alerts.push('grader-idle');

  const idleText = graderIdleHours === null ? 'no card has ever been filed' : `last card filed ${graderIdleHours.toFixed(1)}h ago`;
  const reason = alerts.length
    ? `${ungraded} of ${activeBuckets.size} active holder hour(s) are ungraded (limit ${maxUngraded}); ${idleText} (limit ${maxIdle}h).`
    : `${ungraded} of ${activeBuckets.size} active holder hour(s) ungraded; ${idleText}.`;
  return {
    goalId: input.goalId,
    healthy: alerts.length === 0,
    ungradedActiveHours: ungraded,
    activeHours: activeBuckets.size,
    lastGradedWindowEnd: lastFinalEnd === null ? null : new Date(lastFinalEnd).toISOString(),
    graderIdleHours: graderIdleHours === null ? null : Math.round(graderIdleHours * 10) / 10,
    alerts,
    reason,
  };
}

/**
 * The one ledger read. Holders are the owners whose calls carry this goal's id with
 * goal_actor_class 'holder-agent' (the scorecard subject names a holder); cards are this rubric's observation rows
 * whose subject is one of those owners. Superseded/retracted filtering is not needed
 * for a coverage question: any final card that covered an hour covered it.
 */
export async function readGoalGradingBacklogInput(
  input: { workspaceId: string; goalId: string; nowMs: number },
  deps: { sql: Sql },
): Promise<GoalGradingBacklogInput> {
  const { sql } = deps;
  const since = new Date(input.nowMs - GOAL_GRADING_BACKLOG_LOOKBACK_MS);
  const activity = await sql<{ hour: Date; owner: string }[]>`
    SELECT date_trunc('hour', invoked_at) AS hour, coord_owner_id AS owner
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${input.workspaceId}
       AND goal_id = ${input.goalId}
       -- Holder calls only. Drain-fleet members and goal descendants also carry the
       -- goal id (measured 2026-10-08 on 60d3a8: 51 drain + 30 descendant owners vs
       -- 27 holders), but goal-mode-e2e grades the holder, so their hours owe no card.
       AND goal_actor_class = 'holder-agent'
       AND invoked_at >= ${since}
       AND coord_owner_id IS NOT NULL
     GROUP BY 1, 2`;
  const owners = [...new Set(activity.map((r) => r.owner))];
  const cards = owners.length
    ? await sql<{ ws: string | null; we: string | null; created_ts: string; provisional: boolean; created_by: string | null }[]>`
        SELECT payload->'observation'->'subject'->>'windowStart' AS ws,
               payload->'observation'->'subject'->>'windowEnd' AS we,
               created_ts::text AS created_ts,
               -- work_items has no created_by column; the engineer_issues view
               -- projects it from this same payload path.
               payload->'_ei'->>'created_by' AS created_by,
               (payload->'observation'->'provisional') IS NOT NULL AS provisional
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND lane = 'observation'
           AND payload->'observation'->>'rubricRef' = ${GOAL_GRADING_RUBRIC_REF}
           AND payload->'observation'->'subject'->>'ref' = ANY(${owners})
           -- P-004: computed tenure cards are the platform's, not a grader's. They
           -- never cover (they are provisional) and must not read as grader activity
           -- or make the system the grader this sweep wakes.
           AND (payload->'_ei'->>'created_by') IS DISTINCT FROM ${GOAL_COMPUTED_CARD_AUTHOR}
           AND created_ts >= ${since.getTime()}`
    : [];
  const newest = cards.reduce<(typeof cards)[number] | null>(
    (m, c) => (m === null || Number(c.created_ts) > Number(m.created_ts) ? c : m),
    null,
  );
  const measuredCards = cards.map((c) => ({
    windowStartMs: c.ws ? Date.parse(c.ws) : NaN,
    windowEndMs: c.we ? Date.parse(c.we) : NaN,
    createdMs: Number(c.created_ts),
    final: !c.provisional,
  }));
  if (measuredCards.some(c => !Number.isFinite(c.windowStartMs) || !Number.isFinite(c.windowEndMs) ||
      c.windowEndMs <= c.windowStartMs || !Number.isFinite(c.createdMs))) {
    throw new Error('Incomplete goal grading card measurement');
  }
  return {
    goalId: input.goalId,
    nowMs: input.nowMs,
    lastCardAuthor: newest?.created_by?.trim() || null,
    activityMs: activity.map((r) => new Date(r.hour).getTime()),
    cards: measuredCards,
  };
}

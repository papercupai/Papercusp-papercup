/**
 * Computed tenure-card sweep — plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08
 * P-004.
 *
 * Every tick, for every goal with recent holder activity: derive its holder tenures,
 * evaluate the goal-mode-e2e computed instruments over each tenure that still needs it,
 * and keep exactly one current provisional computed card per tenure
 * (goal-computed-tenure-card.ts owns the rules). Rides the goal-owner-report watchdog timer
 * (D-003: no new scheduler) and shares its kill-switch flag, like the P-002 backlog sweep.
 *
 * Each tenure is contained: a measurement or emit failure on one never stops the others.
 */
import type { Sql } from 'postgres';

import {
  buildComputedTenureRatings,
  COMPUTED_TENURE_ACTIVE_HORIZON_MS,
  COMPUTED_TENURE_LOOKBACK_MS,
  computedRatingsSignature,
  decideTenureCardEmit,
  deriveHolderTenures,
  GOAL_COMPUTED_CARD_AUTHOR,
  GOAL_COMPUTED_CARD_RUBRIC_REF,
  readGoalHolderActivity,
  readTenureCards,
  tenureCardState,
  tenureNeedsEvaluation,
  type ComputedCardRating,
  type HolderTenure,
  type TenureCardRow,
} from '../goal-computed-tenure-card';
import { rateGoalModeComputed, type GoalModeComputedMetrics } from '../goal-mode-computed-instruments';
import { readGoalHolderRows, resolveGoalHoldersBatchFromRows } from '../goals/holder';

export interface ComputedTenureGoal {
  workspaceId: string;
  goalId: string;
  active: boolean;
}

export interface ComputedTenureCardEmit {
  tenure: HolderTenure;
  windowStart: string;
  windowEnd: string;
  ratings: Record<string, ComputedCardRating>;
  supersedes: string | null;
}

export interface ComputedTenureSweepDeps {
  readGoals: () => Promise<ComputedTenureGoal[]>;
  /** The current lease holder per goal (agent_modes), keyed `${workspaceId}:${goalId}`. */
  readCurrentHolders: (goals: readonly ComputedTenureGoal[]) => Promise<Map<string, string | null>>;
  readActivity: (goal: ComputedTenureGoal, sinceMs: number) => Promise<Array<{ ownerId: string; atMs: number }>>;
  readCards: (input: { workspaceId: string; ownerIds: string[]; sinceMs: number }) => Promise<TenureCardRow[]>;
  criterionKeys: () => Promise<string[]>;
  measure: (input: {
    holderOwnerId: string;
    windowStart: string;
    windowEnd: string;
  }) => Promise<GoalModeComputedMetrics | null>;
  emit: (card: ComputedTenureCardEmit) => Promise<{ ok: boolean; issueId?: string | null; error?: string }>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

export interface ComputedTenureSweepResult {
  skipped: boolean;
  goals: number;
  tenures: number;
  evaluated: number;
  emitted: number;
  unchanged: number;
  graded: number;
  settled: number;
  failed: number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    // Shares the owner-report watchdog's kill-switch: one timer, one switch.
    return await getFlag(FLAGS.GOAL_OWNER_REPORT_WATCHDOG, 'system');
  } catch {
    return false;
  }
}

const goalKey = (workspaceId: string, goalId: string) => `${workspaceId}:${goalId}`;

function sweepDeps(sql: Sql, overrides: Partial<ComputedTenureSweepDeps>): ComputedTenureSweepDeps {
  return {
    readGoals: async () => {
      // Paused and closed goals stay in scope so a tenure that ended with them still gets
      // its final card; the activity horizon below bounds the work.
      const rows = await sql<{ workspace_id: string; id: string; status: string }[]>`
        SELECT workspace_id, id, status FROM harness_shared.goals
         WHERE status NOT IN ('draft', 'proposed')`;
      return rows.map((r) => ({ workspaceId: r.workspace_id, goalId: r.id, active: r.status === 'active' }));
    },
    readCurrentHolders: async (goals) => {
      const rows = await readGoalHolderRows(sql);
      // No liveness fold: the lease row alone says who holds the goal now.
      const resolved = resolveGoalHoldersBatchFromRows(goals, rows, new Map());
      return new Map(goals.map((g) => {
        const key = goalKey(g.workspaceId, g.goalId);
        return [key, resolved.get(key)?.elected?.ownerId ?? null];
      }));
    },
    readActivity: (goal, sinceMs) => readGoalHolderActivity({ ...goal, sinceMs }, { sql }),
    readCards: (input) => readTenureCards(input, { sql }),
    criterionKeys: async () => {
      const { getRubric } = await import('../rubrics');
      const rubric = await getRubric(GOAL_COMPUTED_CARD_RUBRIC_REF);
      return rubric ? rubric.criteria.map((criterion) => criterion.key) : [];
    },
    measure: async (input) => {
      // The scorecard instrument resolver's own measurement, so the card and the snapshots
      // emit stores beside it can never disagree about which goal or window they read.
      const { measureGoalModeComputedWindow } = await import('../scorecards');
      return measureGoalModeComputedWindow(input);
    },
    emit: async (card) => {
      const { emitScorecard } = await import('../agent-tools/scorecards/emit');
      const result = (await emitScorecard(
        {
          rubricRef: GOAL_COMPUTED_CARD_RUBRIC_REF,
          subject: { kind: 'agent-run', ref: card.tenure.ownerId, windowStart: card.windowStart, windowEnd: card.windowEnd },
          ratings: card.ratings,
          acknowledgeExisting: true,
          ...(card.supersedes ? { supersedes: card.supersedes } : {}),
        } as Parameters<typeof emitScorecard>[0],
        { createdBy: GOAL_COMPUTED_CARD_AUTHOR, workspaceId: card.tenure.workspaceId },
      )) as { ok: boolean; issueId?: string | null; error?: string };
      return result;
    },
    flagEnabled: defaultFlagEnabled,
    now: () => Date.now(),
    ...overrides,
  };
}

export async function runGoalComputedTenureCardSweepOnce(
  sql: Sql,
  overrides: Partial<ComputedTenureSweepDeps> = {},
): Promise<ComputedTenureSweepResult> {
  const deps = sweepDeps(sql, overrides);
  const result: ComputedTenureSweepResult = {
    skipped: false,
    goals: 0,
    tenures: 0,
    evaluated: 0,
    emitted: 0,
    unchanged: 0,
    graded: 0,
    settled: 0,
    failed: 0,
  };
  if (!(await deps.flagEnabled())) return { ...result, skipped: true };

  const nowMs = deps.now();
  const sinceMs = nowMs - COMPUTED_TENURE_LOOKBACK_MS;
  const goals = await deps.readGoals();
  const holders = await deps.readCurrentHolders(goals);
  let criterionKeys: string[] | null = null;

  for (const goal of goals) {
    try {
      const activity = await deps.readActivity(goal, sinceMs);
      if (activity.length === 0) continue;
      const tenures = deriveHolderTenures({
        workspaceId: goal.workspaceId,
        goalId: goal.goalId,
        activity,
        nowMs,
        currentHolderOwnerId: holders.get(goalKey(goal.workspaceId, goal.goalId)) ?? null,
        goalActive: goal.active,
      }).filter((tenure) => nowMs - tenure.lastMs <= COMPUTED_TENURE_ACTIVE_HORIZON_MS);
      if (tenures.length === 0) continue;
      result.goals += 1;
      const cards = await deps.readCards({
        workspaceId: goal.workspaceId,
        ownerIds: [...new Set(tenures.map((tenure) => tenure.ownerId))],
        sinceMs,
      });
      for (const tenure of tenures) {
        result.tenures += 1;
        try {
          const state = tenureCardState(tenure, cards);
          const need = tenureNeedsEvaluation(tenure, state, nowMs);
          if (need.action === 'skip') {
            result[need.reason] += 1;
            continue;
          }
          // Keep the current card's start: the lookback can truncate a long tenure's start.
          const windowStartMs = Math.min(tenure.startMs, state.current?.windowStartMs ?? tenure.startMs);
          const windowStart = new Date(windowStartMs).toISOString();
          const windowEnd = new Date(tenure.endMs).toISOString();
          const metrics = await deps.measure({ holderOwnerId: tenure.ownerId, windowStart, windowEnd });
          result.evaluated += 1;
          if (!metrics || metrics.window.goalId !== tenure.goalId) {
            // The window resolves to another goal (or none): this tenure is not this goal's to card.
            result.unchanged += 1;
            continue;
          }
          criterionKeys ??= await deps.criterionKeys();
          if (criterionKeys.length === 0) throw new Error(`rubric '${GOAL_COMPUTED_CARD_RUBRIC_REF}' has no criteria`);
          const ratings = buildComputedTenureRatings(criterionKeys, rateGoalModeComputed(metrics));
          const decision = decideTenureCardEmit({
            tenure,
            current: state.current,
            signature: computedRatingsSignature(ratings),
            nowMs,
            windowStartMs,
          });
          if (!decision.emit) {
            result.unchanged += 1;
            continue;
          }
          const emitted = await deps.emit({ tenure, windowStart, windowEnd, ratings, supersedes: decision.supersedes });
          if (!emitted.ok) throw new Error(emitted.error ?? 'emit refused');
          result.emitted += 1;
        } catch (e) {
          result.failed += 1;
          console.warn(
            `[goal-computed-tenure-card] ${tenure.goalId}/${tenure.ownerId} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      result.failed += 1;
      console.warn(
        `[goal-computed-tenure-card] goal ${goal.goalId} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return result;
}

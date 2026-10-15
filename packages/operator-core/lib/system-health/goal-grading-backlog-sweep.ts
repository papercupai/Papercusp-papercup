/**
 * goal-grading-backlog sweep — plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08
 * P-002 / R-2.
 *
 * Measured 2026-10-08: goal 60d3a8's goal-mode-e2e grader sat idle ~16h while the
 * holder kept working, and nobody noticed for ~40h. `classifyGoalGradingBacklog`
 * measures how far grading lags holder activity; this sweep turns its verdict into
 * an owner-visible escalation and wakes the grader.
 *
 * It runs on the goal-owner-report watchdog's managed timer (D-003: no new
 * scheduler) and is gated by the same kill-switch flag.
 *
 * ONE ESCALATION PER BACKLOG, structurally: the escalation is keyed by a stable
 * conditionKey per (workspace, goal), so ticks that observe the same backlog
 * coalesce into one row. The grader wake fires only when that escalation is NEWLY
 * opened. When the goal reads healthy again the open escalation is resolved, so
 * the next backlog opens a fresh row and wakes the grader again.
 *
 * "Re-dispatch" here is a directed wake of the goal's most recent grader (the
 * author of the newest goal-mode-e2e card for its holders), gated on that grader
 * being positively alive. The grading-audit router audits an EXISTING card and
 * cannot dispatch new grading. When no live grader exists the escalation itself
 * tells the owner to dispatch one.
 */
import type { Sql } from 'postgres';

import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import { resolveAlarm, type AlarmAttentionDeps } from '../alarm-attention';
import {
  classifyGoalGradingBacklog,
  GOAL_GRADING_RUBRIC_REF,
  GOAL_GRADING_BACKLOG_LOOKBACK_MS,
  readGoalGradingBacklogInput,
  type GoalGradingBacklogInput,
  type GoalGradingBacklogVerdict,
} from '../goal-grading-backlog';
import { holderCountsAsAlive, resolveHolderLiveness } from '../goals/holder';
import { broadcastSevereEvent } from '../severe-event-broadcast';

const CONDITION_PREFIX = 'alarm:goal-grading-backlog:';
export function goalGradingBacklogAlarmKey(goal: GoalGradingBacklogGoal): string {
  return CONDITION_PREFIX + encodeURIComponent(JSON.stringify([goal.workspaceId, goal.goalId]));
}
async function readOpenBacklogConditionKeys(): Promise<string[]> {
  const { computeConditionStates, readConditionEnvelopes } = await import('../agent-tools/coordination/tools/conditions');
  return computeConditionStates(await readConditionEnvelopes())
    .filter(condition => condition.open && condition.condition_key.startsWith(CONDITION_PREFIX))
    .map(condition => condition.condition_key);
}

function measuredInput(input: GoalGradingBacklogInput, goal: GoalGradingBacklogGoal, nowMs: number): boolean {
  return input?.goalId === goal.goalId && Number.isFinite(nowMs) && input.nowMs === nowMs &&
    Array.isArray(input.activityMs) && input.activityMs.every(at => Number.isFinite(at) &&
      at <= nowMs && at >= Math.floor((nowMs - GOAL_GRADING_BACKLOG_LOOKBACK_MS) / 3600_000) * 3600_000) &&
    Array.isArray(input.cards) && input.cards.every(card => card &&
      Number.isFinite(card.windowStartMs) && Number.isFinite(card.windowEndMs) &&
      card.windowEndMs > card.windowStartMs && Number.isFinite(card.createdMs) && card.createdMs <= nowMs &&
      typeof card.final === 'boolean') &&
    Object.values(input.thresholds ?? {}).every(value => value === undefined || (Number.isFinite(value) && value >= 0));
}

const SWEEP_IDENTITY: AgentIdentity = {
  ownerId: 'goal-grading-backlog-watchdog',
  ownerLabel: 'system · goal grading backlog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface GoalGradingBacklogGoal {
  workspaceId: string;
  goalId: string;
}

export interface GoalGradingBacklogAlert {
  workspaceId: string;
  goalId: string;
  verdict: GoalGradingBacklogVerdict;
  /** Author of the newest goal-mode-e2e card for this goal's holders, if any. */
  graderId: string | null;
  /** True only when the grader resolved positively alive this tick. */
  graderAlive: boolean;
}

/** Stable per-goal condition key: no counts or timestamps, so ticks coalesce. */
export function goalGradingBacklogConditionKey(goal: GoalGradingBacklogGoal): string {
  return `goal-grading-backlog:${goal.workspaceId}:${goal.goalId}`;
}

export interface GoalGradingBacklogSweepDeps {
  /** Every ACTIVE goal. An idle goal accrues no backlog, so no mode filter is needed. */
  readGoals: () => Promise<GoalGradingBacklogGoal[]>;
  readInput: (goal: GoalGradingBacklogGoal, nowMs: number) => Promise<GoalGradingBacklogInput>;
  resolveLiveness: (ownerIds: string[]) => Promise<Map<string, LivenessVerdict>>;
  /** Open or coalesce the escalation of record; `coalesced` gates the grader wake. */
  escalate: (alert: GoalGradingBacklogAlert) => Promise<{ coalesced: boolean }>;
  /** Directed wake of a live grader, fired once per newly opened escalation. */
  wakeGrader: (alert: GoalGradingBacklogAlert & { graderId: string }) => Promise<void>;
  /** Resolve any open escalation for a goal that reads healthy. Returns the count resolved. */
  resolveCleared: (goal: GoalGradingBacklogGoal) => Promise<number>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  rail?: AlarmAttentionDeps;
  readOpenConditionKeys: () => Promise<string[]>;
  /** Exact scoped existence, including goals omitted from the active candidate list. */
  readGoal: (goal: GoalGradingBacklogGoal) => Promise<GoalGradingBacklogGoal | null>;
}

export interface GoalGradingBacklogSweepResult {
  skipped: boolean;
  scanned: number;
  alerting: number;
  escalated: number;
  wokeGrader: number;
  resolved: number;
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

function makeReadGoals(sql: Sql): GoalGradingBacklogSweepDeps['readGoals'] {
  return async () => {
    const rows = await sql<{ workspace_id: string; id: string }[]>`
      SELECT workspace_id, id FROM harness_shared.goals WHERE status = 'active'`;
    return rows.map((r) => ({ workspaceId: r.workspace_id, goalId: r.id }));
  };
}

function describeGrader(alert: GoalGradingBacklogAlert): string {
  if (!alert.graderId) return `No ${GOAL_GRADING_RUBRIC_REF} card names a grader for this goal's holders.`;
  return alert.graderAlive
    ? `Most recent grader ${alert.graderId} is alive and has been woken.`
    : `Most recent grader ${alert.graderId} is not alive, so nobody was woken.`;
}

async function defaultEscalate(alert: GoalGradingBacklogAlert): Promise<{ coalesced: boolean }> {
  const { openEscalation } = await import('../agent-tools/coordination/escalations');
  const v = alert.verdict;
  const result = await openEscalation(SWEEP_IDENTITY, {
    severity: 'advisory',
    summary:
      `Grading is behind on goal '${alert.goalId}': ${v.ungradedActiveHours} active holder hour(s) ` +
      `have no settled ${GOAL_GRADING_RUBRIC_REF} card`,
    body:
      `${v.reason}\n\n` +
      `Newest settled card window ends: ${v.lastGradedWindowEnd ?? 'never'}. ` +
      `Alerts: ${v.alerts.join(', ')}.\n\n` +
      `${describeGrader(alert)}\n\n` +
      `Remedy: the grader files ${GOAL_GRADING_RUBRIC_REF} cards (scorecards:emit) whose subject ` +
      `windows cover the ungraded holder hours. Each holder tenure already has a provisional ` +
      `computed card (author goal-grading-computed): supersede it with terminal:true and rate only ` +
      `the residual criteria — emit adopts the computed pass/idle/not-exercised ratings you omit. ` +
      `If no live grader exists, dispatch one. ` +
      `This escalation resolves itself once grading catches up.`,
    meta: {
      // A stable conditionKey: one backlog, one row, however many ticks see it.
      subjectSignature: goalGradingBacklogConditionKey(alert),
      goalId: alert.goalId,
      goalWorkspaceId: alert.workspaceId,
      graderId: alert.graderId,
      ungradedActiveHours: v.ungradedActiveHours,
      graderIdleHours: v.graderIdleHours,
    },
  });
  return { coalesced: Boolean((result as { coalesced?: boolean } | null)?.coalesced) };
}

async function defaultWakeGrader(alert: GoalGradingBacklogAlert & { graderId: string }): Promise<void> {
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  const v = alert.verdict;
  await wakeRecipients([alert.graderId], {
    summary:
      `goal-grading-backlog: goal '${alert.goalId}' has ${v.ungradedActiveHours} ungraded holder hour(s) ` +
      `(newest settled ${GOAL_GRADING_RUBRIC_REF} window ends ${v.lastGradedWindowEnd ?? 'never'}) — ` +
      `file cards covering them`,
    payload: {
      goalId: alert.goalId,
      rubricRef: GOAL_GRADING_RUBRIC_REF,
      ungradedActiveHours: v.ungradedActiveHours,
      lastGradedWindowEnd: v.lastGradedWindowEnd,
      graderIdleHours: v.graderIdleHours,
      alerts: v.alerts,
    },
    source: 'goal-grading-backlog-watchdog',
    workspaceId: alert.workspaceId,
  });
}

async function defaultResolveCleared(goal: GoalGradingBacklogGoal): Promise<number> {
  const { listOpenEscalationsBySubjectSignature, resolveEscalation } = await import(
    '../agent-tools/coordination/escalations'
  );
  const open = await listOpenEscalationsBySubjectSignature(goalGradingBacklogConditionKey(goal));
  let resolved = 0;
  for (const row of open) {
    const out = await resolveEscalation({
      msg_id: row.msg_id,
      choice: 'cleared',
      note: 'grading caught up: no ungraded holder hours over the threshold',
      resolver: SWEEP_IDENTITY.ownerId,
    });
    if (typeof out === 'object') resolved += 1;
  }
  return resolved;
}

function sweepDeps(sql: Sql, overrides: Partial<GoalGradingBacklogSweepDeps>): GoalGradingBacklogSweepDeps {
  return {
    readGoals: makeReadGoals(sql),
    readInput: (goal, nowMs) => readGoalGradingBacklogInput({ ...goal, nowMs }, { sql }),
    resolveLiveness: (ids) => resolveHolderLiveness(ids),
    escalate: defaultEscalate,
    wakeGrader: defaultWakeGrader,
    resolveCleared: defaultResolveCleared,
    flagEnabled: defaultFlagEnabled,
    now: () => Date.now(),
    readOpenConditionKeys: readOpenBacklogConditionKeys,
    readGoal: async (goal) => {
      const [row] = await sql<{ workspace_id: string; id: string }[]>`
        SELECT workspace_id, id FROM harness_shared.goals
         WHERE workspace_id = ${goal.workspaceId} AND id = ${goal.goalId}`;
      return row ? { workspaceId: row.workspace_id, goalId: row.id } : null;
    },
    ...overrides,
  };
}

/**
 * One sweep. Each goal is contained: a read, escalate or wake failure on one goal
 * never stops the others. A degraded liveness read suppresses the wake (unknown is
 * not alive) but never the escalation, which is what reaches the owner.
 */
export async function runGoalGradingBacklogSweepOnce(
  sql: Sql,
  overrides: Partial<GoalGradingBacklogSweepDeps> = {},
): Promise<GoalGradingBacklogSweepResult> {
  const deps = sweepDeps(sql, overrides);
  const result: GoalGradingBacklogSweepResult = {
    skipped: false,
    scanned: 0,
    alerting: 0,
    escalated: 0,
    wokeGrader: 0,
    resolved: 0,
    failed: 0,
  };
  if (!(await deps.flagEnabled())) return { ...result, skipped: true };

  const goals = new Map((await deps.readGoals())
    .filter(goal => typeof goal?.workspaceId === 'string' && goal.workspaceId.length > 0 &&
      typeof goal.goalId === 'string' && goal.goalId.length > 0)
    .map(goal => [goalGradingBacklogAlarmKey(goal), goal]));
  // A restart, a paused goal or an empty candidate list does not erase an episode.
  // Recover durable identities only from an exact existence + backlog measurement.
  try {
    for (const key of await deps.readOpenConditionKeys()) {
      if (!key.startsWith(CONDITION_PREFIX)) continue;
      let identity: unknown;
      try { identity = JSON.parse(decodeURIComponent(key.slice(CONDITION_PREFIX.length))); }
      catch { continue; }
      if (!Array.isArray(identity) || identity.length !== 2 ||
          !identity.every(part => typeof part === 'string' && part.length > 0)) continue;
      const [workspaceId, goalId] = identity;
      const goal = { workspaceId, goalId };
      if (goalGradingBacklogAlarmKey(goal) === key) goals.set(key, goal);
    }
  } catch (e) {
    console.warn(`[goal-grading-backlog] condition read failed (non-fatal): ${String(e)}`);
  }
  const nowMs = deps.now();
  for (const [key, goal] of goals) {
    result.scanned += 1;
    try {
      const current = await deps.readGoal(goal);
      if (!current || current.workspaceId !== goal.workspaceId || current.goalId !== goal.goalId) continue;
      const input = await deps.readInput(goal, nowMs);
      if (!measuredInput(input, goal, nowMs)) throw new Error('incomplete or mismatched backlog measurement');
      const verdict = classifyGoalGradingBacklog(input);
      if (verdict.healthy) {
        await resolveAlarm(key, 'goal-grading-backlog-watchdog', deps.rail);
        result.resolved += await deps.resolveCleared(goal);
        continue;
      }
      result.alerting += 1;
      // Broadcast before legacy debounce, liveness or wake effects. Their failures
      // must not suppress the condition that records this measured backlog.
      try {
        const event = { conditionKey: key, oneShot: true,
          summary: `Grading is behind on goal '${goal.goalId}'`,
          body: `Workspace ${goal.workspaceId}. ${verdict.reason}` };
        if (deps.rail?.broadcast) await deps.rail.broadcast(event);
        else await broadcastSevereEvent(event);
      } catch (e) {
        console.warn(`[goal-grading-backlog] condition broadcast failed (non-fatal): ${String(e)}`);
      }

      const graderId = input.lastCardAuthor ?? null;
      let graderAlive = false;
      if (graderId) {
        try {
          const verdicts = await deps.resolveLiveness([graderId]);
          const v = verdicts.get(graderId);
          graderAlive = v ? holderCountsAsAlive(v) : false;
        } catch {
          graderAlive = false;
        }
      }
      const alert: GoalGradingBacklogAlert = { ...goal, verdict, graderId, graderAlive };

      const { coalesced } = await deps.escalate(alert);
      if (coalesced) continue; // the one wake already went out for this backlog
      result.escalated += 1;
      if (graderId && graderAlive) {
        await deps.wakeGrader({ ...alert, graderId });
        result.wokeGrader += 1;
      }
    } catch (e) {
      result.failed += 1;
      console.warn(
        `[goal-grading-backlog] sweep failed for ${goal.goalId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return result;
}

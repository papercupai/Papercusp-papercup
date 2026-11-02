import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { GoalGradingBacklogInput } from '../goal-grading-backlog';
import {
  goalGradingBacklogAlarmKey,
  goalGradingBacklogConditionKey,
  runGoalGradingBacklogSweepOnce,
  type GoalGradingBacklogGoal,
  type GoalGradingBacklogSweepDeps,
} from './goal-grading-backlog-sweep';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 8, 16, 0, 0);
const sql = {} as Sql;

const BACKLOG: GoalGradingBacklogGoal = { workspaceId: 'ws', goalId: 'goal-backlog' };
const HEALTHY: GoalGradingBacklogGoal = { workspaceId: 'ws', goalId: 'goal-healthy' };

/** Ten active holder hours, none covered by a final card; the grader filed only a
 *  provisional card 10h ago, so both alerts fire. */
function backlogInput(goal: GoalGradingBacklogGoal, author: string | null = 'su-grader'): GoalGradingBacklogInput {
  return {
    goalId: goal.goalId,
    nowMs: NOW,
    activityMs: Array.from({ length: 10 }, (_, i) => NOW - (i + 1) * HOUR),
    cards: author
      ? [{ windowStartMs: NOW - 12 * HOUR, windowEndMs: NOW - 11 * HOUR, createdMs: NOW - 10 * HOUR, final: false }]
      : [],
    lastCardAuthor: author,
  };
}

/** Same activity, fully covered by a fresh final card. */
function healthyInput(goal: GoalGradingBacklogGoal): GoalGradingBacklogInput {
  return {
    goalId: goal.goalId,
    nowMs: NOW,
    activityMs: Array.from({ length: 10 }, (_, i) => NOW - (i + 1) * HOUR),
    cards: [{ windowStartMs: NOW - 11 * HOUR, windowEndMs: NOW, createdMs: NOW - HOUR, final: true }],
    lastCardAuthor: 'su-grader',
  };
}

function alive(): LivenessVerdict {
  return { sessionState: 'live' } as LivenessVerdict;
}
function dead(): LivenessVerdict {
  return { sessionState: 'ended' } as LivenessVerdict;
}

function deps(overrides: Partial<GoalGradingBacklogSweepDeps> = {}): GoalGradingBacklogSweepDeps {
  return {
    readGoals: vi.fn(async () => [BACKLOG]),
    readInput: vi.fn(async (goal) => (goal.goalId === HEALTHY.goalId ? healthyInput(goal) : backlogInput(goal))),
    resolveLiveness: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, alive()]))),
    escalate: vi.fn(async () => ({ coalesced: false })),
    dispatchGrading: vi.fn(async () => ({ state: 'routed' as const })),
    resolveCleared: vi.fn(async () => 0),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    readGoal: vi.fn(async goal => goal),
    readOpenConditionKeys: vi.fn(async () => []),
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    ...overrides,
  };
}

describe('runGoalGradingBacklogSweepOnce', () => {
  it('does nothing when the kill-switch flag is off', async () => {
    const d = deps({ flagEnabled: vi.fn(async () => false) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out.skipped).toBe(true);
    expect(d.readGoals).not.toHaveBeenCalled();
    expect(d.escalate).not.toHaveBeenCalled();
  });

  it('escalates a backlog and wakes the live grader once', async () => {
    const d = deps();
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ scanned: 1, alerting: 1, escalated: 1, wokeGrader: 1, failed: 0 });
    expect(d.escalate).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(d.escalate).mock.calls[0]![0];
    expect(alert.graderId).toBe('su-grader');
    expect(alert.graderAlive).toBe(true);
    expect(alert.verdict.ungradedActiveHours).toBe(10);
    expect(alert.verdict.alerts).toEqual(['grading-backlog', 'grader-idle']);
    expect(d.dispatchGrading).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.dispatchGrading).mock.calls[0]![0].graderId).toBe('su-grader');
    expect(d.resolveCleared).not.toHaveBeenCalled();
  });

  it('recovers grading even when the escalation coalesces', async () => {
    const d = deps({ escalate: vi.fn(async () => ({ coalesced: true })) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ alerting: 1, escalated: 0, wokeGrader: 1 });
    expect(d.dispatchGrading).toHaveBeenCalledTimes(1);
  });

  it('dispatches a replacement when the previous grader ended', async () => {
    const d = deps({ resolveLiveness: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, dead()]))) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ escalated: 1, wokeGrader: 1 });
    expect(vi.mocked(d.escalate).mock.calls[0]![0].graderAlive).toBe(false);
    expect(d.dispatchGrading).toHaveBeenCalledTimes(1);
  });

  it('dispatches independently when prior-grader liveness is unavailable', async () => {
    const d = deps({
      resolveLiveness: vi.fn(async () => {
        throw new Error('oracle down');
      }),
    });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ escalated: 1, wokeGrader: 1, failed: 0 });
    expect(d.dispatchGrading).toHaveBeenCalledTimes(1);
  });

  it('escalates with no grader when no card names one, and skips the liveness read', async () => {
    const d = deps({ readInput: vi.fn(async (goal) => backlogInput(goal, null)) });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ escalated: 1, wokeGrader: 1 });
    expect(vi.mocked(d.escalate).mock.calls[0]![0].graderId).toBeNull();
    expect(d.resolveLiveness).not.toHaveBeenCalled();
    expect(d.dispatchGrading).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a queued launch from pickup and retries failure on a coalesced alert', async () => {
    const d = deps({ escalate: vi.fn(async () => ({ coalesced: true })),
      dispatchGrading: vi.fn().mockResolvedValueOnce({ state: 'pending' })
        .mockResolvedValueOnce({ state: 'retry' }).mockResolvedValueOnce({ state: 'routed' }) });
    expect(await runGoalGradingBacklogSweepOnce(sql, d)).toMatchObject({ wokeGrader: 0, pendingGrader: 1, failed: 0 });
    expect(await runGoalGradingBacklogSweepOnce(sql, d)).toMatchObject({ wokeGrader: 0, failed: 1 });
    expect(await runGoalGradingBacklogSweepOnce(sql, d)).toMatchObject({ wokeGrader: 1, failed: 0 });
    expect(d.dispatchGrading).toHaveBeenCalledTimes(3);
  });

  it('resolves the open escalation for a goal that reads healthy, without escalating', async () => {
    const d = deps({
      readGoals: vi.fn(async () => [HEALTHY]),
      resolveCleared: vi.fn(async () => 1),
    });
    const out = await runGoalGradingBacklogSweepOnce(sql, d);
    expect(out).toMatchObject({ scanned: 1, alerting: 0, resolved: 1 });
    expect(d.resolveCleared).toHaveBeenCalledWith(HEALTHY);
    expect(d.escalate).not.toHaveBeenCalled();
  });

  it('contains a per-goal failure so other goals are still swept', async () => {
    const broken: GoalGradingBacklogGoal = { workspaceId: 'ws', goalId: 'goal-broken' };
    const d = deps({
      readGoals: vi.fn(async () => [broken, BACKLOG, HEALTHY]),
      readInput: vi.fn(async (goal) => {
        if (goal.goalId === broken.goalId) throw new Error('read failed');
        return goal.goalId === HEALTHY.goalId ? healthyInput(goal) : backlogInput(goal);
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await runGoalGradingBacklogSweepOnce(sql, d);
      expect(out).toMatchObject({ scanned: 3, failed: 1, alerting: 1, escalated: 1, wokeGrader: 1 });
      expect(d.resolveCleared).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('goal-broken');
    } finally {
      warn.mockRestore();
    }
  });

  it('opens durable per-workspace goal episodes before legacy coalescing and failure', async () => {
    const foreign = { ...BACKLOG, workspaceId: 'other:workspace' };
    const order: string[] = [];
    const d = deps({ readGoals: async () => [BACKLOG, foreign],
      rail: { broadcast: async event => {
        expect(event.oneShot).toBe(true); order.push(event.conditionKey!); return true;
      } },
      escalate: vi.fn(async () => { order.push('legacy'); throw new Error('legacy unavailable'); }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await runGoalGradingBacklogSweepOnce(sql, d);
      expect(out).toMatchObject({ alerting: 2, failed: 2 });
      expect(d.dispatchGrading).toHaveBeenCalledTimes(2);
      expect(order).toEqual([goalGradingBacklogAlarmKey(BACKLOG), 'legacy', goalGradingBacklogAlarmKey(foreign), 'legacy']);
      const coalesced = deps({ escalate: async () => ({ coalesced: true }) });
      await runGoalGradingBacklogSweepOnce(sql, coalesced);
      expect(coalesced.rail!.broadcast).toHaveBeenCalledTimes(1);
      expect(coalesced.dispatchGrading).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('recovers a durable episode after restart only from exact scoped healthy measurements', async () => {
    const key = goalGradingBacklogAlarmKey(BACKLOG);
    const d = deps({ readGoals: async () => [], readOpenConditionKeys: async () => [key],
      readInput: async goal => healthyInput(goal) });
    await runGoalGradingBacklogSweepOnce(sql, { ...d });
    expect(d.readGoal).toHaveBeenCalledWith(BACKLOG);
    expect(d.rail!.resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'goal-grading-backlog-watchdog recovered' });
    expect(d.resolveCleared).toHaveBeenCalledWith(BACKLOG);
  });

  it.each(['missing', 'foreign', 'throw', 'mismatched-input', 'invalid-activity', 'invalid-card', 'invalid-threshold'])(
    'preserves durable conditions for %s recovery evidence', async kind => {
      const key = goalGradingBacklogAlarmKey(BACKLOG);
      const d = deps({ readGoals: async () => [], readOpenConditionKeys: async () => [key],
        readGoal: async goal => {
          if (kind === 'missing') return null;
          if (kind === 'foreign') return { ...goal, workspaceId: 'other' };
          if (kind === 'throw') throw new Error('goal read unavailable');
          return goal;
        },
        readInput: async goal => ({ ...healthyInput(goal),
          ...(kind === 'mismatched-input' ? { goalId: 'other' } : {}),
          ...(kind === 'invalid-activity' ? { activityMs: [NaN] } : {}),
          ...(kind === 'invalid-card' ? { cards: [{ windowStartMs: NaN, windowEndMs: NOW, createdMs: NOW, final: true }] } : {}),
          ...(kind === 'invalid-threshold' ? { thresholds: { maxUngradedHours: NaN } } : {}),
        }) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await runGoalGradingBacklogSweepOnce(sql, d);
        expect(d.rail!.resolve).not.toHaveBeenCalled();
        expect(d.resolveCleared).not.toHaveBeenCalled();
      } finally { warn.mockRestore(); }
    });

  it('ignores malformed durable identities and preserves episodes on failed ledger reads or disabled flags', async () => {
    const d = deps({ readGoals: async () => [], readOpenConditionKeys: async () => [
      'alarm:goal-grading-backlog:%', 'alarm:goal-grading-backlog:%5B%22ws%22%5D',
      'alarm:goal-grading-backlog:%5B%22%22%2C%22goal%22%5D', 'alarm:other:goal',
    ] });
    await runGoalGradingBacklogSweepOnce(sql, d);
    expect(d.readGoal).not.toHaveBeenCalled();
    expect(d.rail!.resolve).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runGoalGradingBacklogSweepOnce(sql, { ...d, readOpenConditionKeys: async () => { throw new Error('ledger unavailable'); } });
      await runGoalGradingBacklogSweepOnce(sql, { ...d, flagEnabled: async () => false });
      expect(d.rail!.resolve).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('contains condition delivery failure and still wakes the legacy live grader', async () => {
    const d = deps({ rail: { broadcast: async () => { throw new Error('condition rail unavailable'); } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runGoalGradingBacklogSweepOnce(sql, d)).toMatchObject({ escalated: 1, wokeGrader: 1, failed: 0 });
    } finally { warn.mockRestore(); }
  });
});

describe('goalGradingBacklogConditionKey', () => {
  it('is stable per goal and carries no counts or timestamps', () => {
    expect(goalGradingBacklogConditionKey(BACKLOG)).toBe('goal-grading-backlog:ws:goal-backlog');
    expect(goalGradingBacklogConditionKey(BACKLOG)).toBe(goalGradingBacklogConditionKey({ ...BACKLOG }));
    expect(goalGradingBacklogConditionKey(BACKLOG)).not.toBe(goalGradingBacklogConditionKey(HEALTHY));
  });
});

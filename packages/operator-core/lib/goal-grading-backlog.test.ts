/**
 * goal-grading-backlog.test.ts — plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08
 * P-002 / R-2. The 2026-10-08 incident shape: the holder kept working for ~40h past the
 * newest settled card while the grader filed nothing for ~16h, and nothing alerted.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { classifyGoalGradingBacklog, readGoalGradingBacklogInput } from './goal-grading-backlog';

const H = 3600_000;
const T0 = Date.parse('2026-10-06T00:00:00.000Z');
const hours = (from: number, count: number) => Array.from({ length: count }, (_, i) => T0 + (from + i) * H + 5 * 60_000);

describe('classifyGoalGradingBacklog', () => {
  it('healthy when every active hour is covered by a final card and the grader is recent', () => {
    const v = classifyGoalGradingBacklog({
      goalId: 'g',
      nowMs: T0 + 5 * H,
      activityMs: hours(0, 4),
      cards: [
        { windowStartMs: T0, windowEndMs: T0 + 2 * H, createdMs: T0 + 3 * H, final: true },
        { windowStartMs: T0 + 2 * H, windowEndMs: T0 + 4 * H, createdMs: T0 + 4.5 * H, final: true },
      ],
    });
    expect(v.healthy).toBe(true);
    expect(v.ungradedActiveHours).toBe(0);
    expect(v.activeHours).toBe(4);
    expect(v.alerts).toEqual([]);
  });

  it('the measured incident: 40 active hours past the last settled card and a 16h-idle grader alerts both ways', () => {
    const v = classifyGoalGradingBacklog({
      goalId: '60d3a8',
      nowMs: T0 + 50 * H,
      activityMs: hours(0, 48),
      cards: [
        { windowStartMs: T0, windowEndMs: T0 + 8 * H, createdMs: T0 + 34 * H, final: true },
      ],
    });
    expect(v.ungradedActiveHours).toBe(40);
    expect(v.alerts).toEqual(['grading-backlog', 'grader-idle']);
    expect(v.graderIdleHours).toBe(16);
    expect(v.lastGradedWindowEnd).toBe(new Date(T0 + 8 * H).toISOString());
    expect(v.reason).toContain('40 of 48');
  });

  it('a provisional card is grader activity but does not cover the hour', () => {
    const v = classifyGoalGradingBacklog({
      goalId: 'g',
      nowMs: T0 + 10 * H,
      activityMs: hours(0, 8),
      cards: [{ windowStartMs: T0, windowEndMs: T0 + 8 * H, createdMs: T0 + 9 * H, final: false }],
    });
    expect(v.ungradedActiveHours).toBe(8);
    expect(v.alerts).toEqual(['grading-backlog']);
    expect(v.graderIdleHours).toBe(1);
  });

  it('a quiet goal accrues no backlog and an idle grader with nothing to grade is fine', () => {
    const v = classifyGoalGradingBacklog({
      goalId: 'g',
      nowMs: T0 + 100 * H,
      activityMs: hours(0, 4),
      cards: [{ windowStartMs: T0, windowEndMs: T0 + 4 * H, createdMs: T0 + 5 * H, final: true }],
    });
    expect(v.healthy).toBe(true);
    expect(v.graderIdleHours).toBe(95);
  });

  it('many calls in one hour count once; the threshold is exclusive', () => {
    const burst = Array.from({ length: 50 }, (_, i) => T0 + i * 60_000);
    const six = classifyGoalGradingBacklog({
      goalId: 'g',
      nowMs: T0 + 7 * H,
      activityMs: [...burst, ...hours(1, 5)],
      cards: [],
    });
    expect(six.activeHours).toBe(6);
    expect(six.ungradedActiveHours).toBe(6);
    // 6 is AT the limit: no backlog alert, but nothing was ever graded so the grader is idle.
    expect(six.alerts).toEqual(['grader-idle']);
    const seven = classifyGoalGradingBacklog({ goalId: 'g', nowMs: T0 + 8 * H, activityMs: hours(0, 7), cards: [] });
    expect(seven.alerts).toEqual(['grading-backlog', 'grader-idle']);
    expect(seven.graderIdleHours).toBeNull();
  });

  it('thresholds are overridable', () => {
    const v = classifyGoalGradingBacklog({
      goalId: 'g',
      nowMs: T0 + 3 * H,
      activityMs: hours(0, 2),
      cards: [],
      thresholds: { maxUngradedHours: 1, maxGraderIdleHours: 100 },
    });
    expect(v.alerts).toEqual(['grading-backlog', 'grader-idle']);
  });
});

describe('readGoalGradingBacklogInput', () => {
  it('preserves exact workspace/goal scope and real card coverage in the existing reader', async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(' '); calls.push({ query, values });
      return query.includes('tool_invocations') ? [{ hour: new Date(T0), owner: 'holder' }] : [{
        ws: new Date(T0).toISOString(), we: new Date(T0 + H).toISOString(),
        created_ts: String(T0 + H), provisional: false, created_by: 'grader',
      }];
    }) as unknown as Sql;
    const input = await readGoalGradingBacklogInput({ workspaceId: 'workspace', goalId: 'goal', nowMs: T0 + 2 * H }, { sql });
    expect(classifyGoalGradingBacklog(input)).toMatchObject({ healthy: true, ungradedActiveHours: 0 });
    expect(calls[0].values.slice(0, 2)).toEqual(['workspace', 'goal']);
    expect(calls[0].query).toContain("goal_actor_class = 'holder-agent'");
    expect(calls[1].values[0]).toBe('workspace');
    expect(calls[1].query).toContain("lane = 'observation'");
  });

  it.each(['absent-window', 'invalid-window', 'reversed-window', 'invalid-created'])(
    'refuses %s rather than dropping card evidence and declaring recovery', async kind => {
      const sql = (async (strings: TemplateStringsArray) => strings.join(' ').includes('tool_invocations')
        ? [{ hour: new Date(T0), owner: 'holder' }]
        : [{ ws: kind === 'absent-window' ? null : kind === 'invalid-window' ? 'invalid' : new Date(T0).toISOString(),
          we: new Date(T0 + (kind === 'reversed-window' ? -H : H)).toISOString(),
          created_ts: kind === 'invalid-created' ? 'invalid' : String(T0 + H),
          provisional: false, created_by: 'grader' }]) as unknown as Sql;
      await expect(readGoalGradingBacklogInput({ workspaceId: 'workspace', goalId: 'goal', nowMs: T0 + 2 * H }, { sql }))
        .rejects.toThrow('Incomplete goal grading card measurement');
    });
});

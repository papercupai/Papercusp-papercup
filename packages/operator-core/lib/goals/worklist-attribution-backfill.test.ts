import { describe, expect, it } from 'vitest';
import { backfillWorklistGoalAttribution, parseWorklistPlanRef } from './worklist-attribution-backfill';

type Recorded = { text: string; values: unknown[] };

/**
 * A fake `postgres` tagged-template client. It records every statement (template pieces joined with
 * `?`) plus its bound values, and answers each UPDATE by table name from `rowsByTable`.
 */
function fakeSql(rowsByTable: { plans?: Array<Record<string, string>>; items?: Array<Record<string, string>> }) {
  const calls: Recorded[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('harness_shared.harness_plans')) return rowsByTable.plans ?? [];
    if (text.includes('harness_shared.work_items')) return rowsByTable.items ?? [];
    return [];
  }) as unknown as Parameters<typeof backfillWorklistGoalAttribution>[0];
  return { sql, calls };
}

describe('parseWorklistPlanRef', () => {
  it('parses plan:<harness>/<slug> and the legacy plan:<slug> form', () => {
    expect(parseWorklistPlanRef('plan:papercusp/my-plan')).toEqual({ harness: 'papercusp', planSlug: 'my-plan' });
    expect(parseWorklistPlanRef('plan:my-plan')).toEqual({ harness: null, planSlug: 'my-plan' });
  });

  it('skips goal: refs, free text, non-strings and malformed plan refs', () => {
    expect(parseWorklistPlanRef('goal:x')).toBeNull();
    expect(parseWorklistPlanRef('docs')).toBeNull();
    expect(parseWorklistPlanRef(42)).toBeNull();
    expect(parseWorklistPlanRef(null)).toBeNull();
    expect(parseWorklistPlanRef('plan:')).toBeNull();
    expect(parseWorklistPlanRef('plan:/s')).toBeNull();
    expect(parseWorklistPlanRef('plan:h/')).toBeNull();
  });
});

describe('backfillWorklistGoalAttribution', () => {
  it('stamps NULL-goal plan and work-item rows of each plan ref and reports what it stamped', async () => {
    const { sql, calls } = fakeSql({
      plans: [{ plan_slug: 'plan-a' }],
      items: [{ feature_id: 'WI-1' }, { feature_id: 'WI-2' }],
    });
    const out = await backfillWorklistGoalAttribution(sql, {
      workspaceId: 'ws-1',
      goalId: 'goal-42',
      worklist: ['plan:papercusp/plan-a'],
    });
    expect(out).toEqual({ refs: 1, plansStamped: ['plan-a'], workItemsStamped: ['WI-1', 'WI-2'] });
    // one static UPDATE per table per ref
    expect(calls).toHaveLength(2);
    expect(calls[0]!.values).toEqual(expect.arrayContaining(['goal-42', 'ws-1', 'plan-a', 'papercusp']));
  });

  it('never reparents a goal-owned row and never rewrites a federation-owned row (both live in the WHERE)', async () => {
    const { sql, calls } = fakeSql({});
    await backfillWorklistGoalAttribution(sql, {
      workspaceId: 'ws-1',
      goalId: 'goal-42',
      worklist: ['plan:plan-a'],
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.text).toContain('goal_id IS NULL');
      expect(call.text).toContain("origin IS DISTINCT FROM 'remote'");
    }
  });

  it('issues ZERO queries for a worklist with no plan refs (goal refs, free text, non-array)', async () => {
    for (const worklist of [['goal:x', 'docs', 7], [], null, 'plan:not-an-array']) {
      const { sql, calls } = fakeSql({ plans: [{ plan_slug: 'x' }] });
      const out = await backfillWorklistGoalAttribution(sql, {
        workspaceId: 'ws-1',
        goalId: 'goal-42',
        worklist,
      });
      expect(calls).toHaveLength(0);
      expect(out).toEqual({ refs: 0, plansStamped: [], workItemsStamped: [] });
    }
  });

  it('runs the pair of UPDATEs once per plan ref', async () => {
    const { sql, calls } = fakeSql({});
    const out = await backfillWorklistGoalAttribution(sql, {
      workspaceId: 'ws-1',
      goalId: 'goal-42',
      worklist: ['plan:h/one', 'goal:skip', 'plan:two'],
    });
    expect(out.refs).toBe(2);
    expect(calls).toHaveLength(4);
  });
});

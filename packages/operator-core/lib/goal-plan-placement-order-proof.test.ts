/** P006: literal ordering oracles over the existing portfolio reader/renderer. */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('./goals/holder', () => ({
  resolveGoalHolders: async () => ({ holders: [], live: [], elected: null, liveness: 'unheld' }),
}));

import { readGoalPortfolioBrief, renderGoalPortfolioBrief } from './goal-launch-settings';

const NOW = new Date('2026-09-23T11:00:00.000Z');
const scenarios = ['blocked-head-next-eligible', 'eligible-ordered-head'] as const;
type Scenario = typeof scenarios[number];
const control = process.env.PAPERCUSP_PLACEMENT_ORDER_CONTROL;
if (control && !scenarios.includes(control as Scenario)) {
  throw new Error(`Unknown permanent portfolio order control: ${control}`);
}

function plan(slug: string, ordinal: number, status: string) {
  return {
    ref: `plan:papercusp/${slug}`, ordinal, harness: 'papercusp', slug,
    title: `${slug} plan`, status, goalId: 'goal-fixture', ambiguousMatches: 1,
    items: [{ id: 'P-001', text: 'Place this lane', status: 'todo', blockedBy: [], seq: 1 }],
    placement: { goalHolderOwnerIds: [], claims: [] },
  };
}

async function portfolio(scenario: Scenario, applyControl = true, faultyControl = control) {
  const plans = [
    plan('alpha', 1, scenario === 'blocked-head-next-eligible' ? 'draft' : 'active'),
    plan('beta', 2, 'active'),
  ];
  // Deliberately faulty projection adapters leave the expected plan identities
  // intact. Calibration reads the canonical row, independent of both adapters.
  if (applyControl && faultyControl === scenario) {
    if (scenario === 'blocked-head-next-eligible') plans[1].status = 'draft';
    else plans.reverse(); // Simulate a projection that lost its SQL ORDER BY.
  }
  const sql = ((first: TemplateStringsArray) => {
    const statement = first.join(' ');
    // The owner-wall fragments (goal-owner-report-truth.ts) use the same tag and are
    // interpolated into the portfolio read. They are not statements, so return an
    // inert fragment; anything else that is not the portfolio read stays an error.
    if (/^\s*(COALESCE\(\s*NULLIF\(wall\.payload|wall\.status <> ALL)/.test(statement)) return { fragment: statement };
    if (!statement.includes('WITH goal_row AS')) throw new Error('Unexpected portfolio SQL');
    return Promise.resolve([{
      status: 'active', properties: { worklist: { value: ['plan:papercusp/alpha', 'plan:papercusp/beta'] } },
      metadata: { drainFleet: 'goal-fixture-drain' }, plans,
      pots: [{ id: 'fixture-pot', harness: 'papercusp', role: 'owner' }],
      ladder_work_items: [], queue: { total: 0, terminal: 0, inFlight: 0, blocked: 0, needsHuman: 0 },
      drain_fleet: { slug: 'goal-fixture-drain', controlState: 'active', live: 2, working: 1 },
      report_movements: [], owner_walls: [], killed_work: [], blender_pending: 0,
    }]);
  }) as unknown as Sql;
  const launch: NonNullable<Parameters<typeof readGoalPortfolioBrief>[0]['launch']> = {
    goalBrief: {
      title: 'Order fixture', body: 'Delegate eligible plans', killCriterion: 'fixture ends',
      budgetCents: 5000, budgetWindowSec: 604800, standing: true,
    },
    settings: null, budget: null, ceilings: { maxAgents: 12, maxPerFleet: 5 },
    headcount: { total: 0, fleet: 0 }, degradedReasons: [],
  };
  const brief = await readGoalPortfolioBrief({ workspaceId: 'fixture', goalId: 'goal-fixture', sql, now: NOW, launch });
  expect(brief).not.toBeNull();
  expect(brief!.degradedReasons).toEqual([]);
  return brief!;
}

describe('portfolio ordering causal contracts (WI-1074216)', () => {
  it.each(scenarios)('outer control catches portfolio order adapter: %s', async (scenario) => {
    const expected = `plan:papercusp/${scenario === 'blocked-head-next-eligible' ? 'beta' : 'alpha'} is the highest-priority eligible worklist plan`;
    expect(renderGoalPortfolioBrief(await portfolio(scenario, false))).toContain(expected);
    const faulty = renderGoalPortfolioBrief(await portfolio(scenario, true, scenario));
    expect(() => expect(faulty).toContain(expected)).toThrowError();
  });
  it('order calibration: canonical eligible head is independent of the faulty adapter', async () => {
    const brief = await portfolio('eligible-ordered-head', false);
    expect(renderGoalPortfolioBrief(brief)).toContain('plan:papercusp/alpha is the highest-priority eligible worklist plan');
  });

  it.each(scenarios)('repaired portfolio order contract: %s', async (scenario) => {
    const brief = await portfolio(scenario);
    const rendered = renderGoalPortfolioBrief(brief);
    if (scenario === 'blocked-head-next-eligible') {
      expect(brief.worklist[0].placement.reconciliation.toolCall, `portfolio-order:${scenario}`).toBeNull();
      expect(brief.worklist[1].placement.reconciliation.toolCall, `portfolio-order:${scenario}`).toMatchObject({
        tool: 'fleet:launch-on-plan', args: { plan: 'beta', harness: 'papercusp', leader: 'spawn' },
      });
      expect(rendered, `portfolio-order:${scenario}`).toContain('plan:papercusp/beta is the highest-priority eligible worklist plan');
    } else {
      expect(brief.worklist.map(row => row.slug), `portfolio-order:${scenario}`).toEqual(['alpha', 'beta']);
      expect(rendered, `portfolio-order:${scenario}`).toContain('plan:papercusp/alpha is the highest-priority eligible worklist plan');
    }
  });
});

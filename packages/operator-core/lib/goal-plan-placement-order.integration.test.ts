/** P006: persisted worklist/index writers -> ordered portfolio launch receipt. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { seedPlan, cleanupPlans } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import { applyGoalPropertyWrite } from './typed-properties-db';
import { readGoalPortfolioBrief, renderGoalPortfolioBrief } from './goal-launch-settings';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const HARNESS = `zzz-order-${RUN}`;
const GOAL = `goal-order-${RUN}`;
const ALPHA = `alpha-${RUN}`;
const BETA = `beta-${RUN}`;
const scenarios = ['blocked-head-next-eligible', 'eligible-ordered-head'] as const;
type Scenario = typeof scenarios[number];
const control = process.env.PAPERCUSP_PLACEMENT_ORDER_PG_CONTROL;
if (control && !scenarios.includes(control as Scenario)) {
  throw new Error(`Unknown permanent portfolio PG order control: ${control}`);
}
let fx: BaselineCoordFixture;

async function writePlan(slug: string, status: string) {
  const body = `---\ntitle: ${slug}\nslug: ${slug}\nstatus: ${status}\n---\n\n## Build\n\n- **P-001** \`todo\` Place this lane\n`;
  await seedPlan(fx.admin, WS, HARNESS, slug, body);
  const index = deriveIndexFromContent(body);
  await fx.admin.begin(async (tx) => {
    await tx`UPDATE harness_shared.harness_plans SET title = ${index.title}, status = ${index.status}
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: slug }, index);
  });
}

async function portfolio(scenario: Scenario, applyControl = true, faultyControl = control) {
  await writePlan(ALPHA, scenario === 'blocked-head-next-eligible' ? 'draft' : 'ready');
  await writePlan(BETA, 'ready');
  let worklist = [`plan:${HARNESS}/${ALPHA}`, `plan:${HARNESS}/${BETA}`];
  // Permanent negative adapters alter the persisted inputs, keeping the
  // literal expected identities unchanged. Calibration bypasses both.
  if (applyControl && faultyControl === scenario) {
    if (scenario === 'blocked-head-next-eligible') await writePlan(BETA, 'draft');
    else worklist = [...worklist].reverse();
  }
  const [row] = await fx.admin`SELECT properties FROM harness_shared.goals
    WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  const expectedVersion = row!.properties?.worklist?.version ?? 0;
  await fx.admin.begin(async (tx) => {
    const written = await applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
      workspaceId: WS, goalId: GOAL, property: 'worklist', value: worklist,
      expectedVersion, actorId: 'su-order-fixture', provenance: 'agent-edit',
    });
    expect(written.ok).toBe(true);
  });
  const persisted = await fx.admin`SELECT properties->'worklist'->'value' AS worklist
    FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  expect(persisted[0]!.worklist).toEqual(worklist);
  const brief = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL });
  expect(brief).not.toBeNull();
  expect(brief!.degradedReasons.filter(reason => /portfolio read failed/.test(reason))).toEqual([]);
  expect(brief!.worklist).toHaveLength(2);
  return brief!;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, {
    id: GOAL, workspaceId: WS, installSlug: 'papercusp', title: 'Persisted order fixture',
    body: 'Place the highest-priority eligible plan', status: 'active',
    killCriterion: 'A lower-priority or ineligible plan is selected.',
  });
}, 150_000);

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.plan_decisions WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND id = ${HARNESS}`;
  await fx.dispose();
});

describe('persisted portfolio ordering causal contracts (WI-1074216)', () => {
  it.each(scenarios)('outer control catches persisted portfolio order adapter: %s', async (scenario) => {
    const expected = `plan:${HARNESS}/${scenario === 'blocked-head-next-eligible' ? BETA : ALPHA} is the highest-priority eligible worklist plan`;
    expect(renderGoalPortfolioBrief(await portfolio(scenario, false))).toContain(expected);
    const faulty = renderGoalPortfolioBrief(await portfolio(scenario, true, scenario));
    expect(() => expect(faulty).toContain(expected)).toThrowError();
  });
  it('PG order calibration: canonical eligible head bypasses faulty input adapters', async () => {
    const brief = await portfolio('eligible-ordered-head', false);
    expect(renderGoalPortfolioBrief(brief)).toContain(`plan:${HARNESS}/${ALPHA} is the highest-priority eligible worklist plan`);
  });

  it.each(scenarios)('repaired persisted portfolio order contract: %s', async (scenario) => {
    const brief = await portfolio(scenario);
    expect(brief.worklist.map(plan => plan.slug), `portfolio-pg-order:${scenario}`).toEqual([ALPHA, BETA]);
    if (scenario === 'blocked-head-next-eligible') {
      expect(brief.worklist[0]!.placement.reconciliation.toolCall, `portfolio-pg-order:${scenario}`).toBeNull();
      expect(brief.worklist[1]!.placement.reconciliation.toolCall, `portfolio-pg-order:${scenario}`).toMatchObject({
        tool: 'fleet:launch-on-plan', args: { plan: BETA, harness: HARNESS, leader: 'spawn' },
      });
      expect(renderGoalPortfolioBrief(brief), `portfolio-pg-order:${scenario}`).toContain(
        `plan:${HARNESS}/${BETA} is the highest-priority eligible worklist plan`,
      );
    } else {
      expect(renderGoalPortfolioBrief(brief), `portfolio-pg-order:${scenario}`).toContain(
        `plan:${HARNESS}/${ALPHA} is the highest-priority eligible worklist plan`,
      );
    }
  });
});

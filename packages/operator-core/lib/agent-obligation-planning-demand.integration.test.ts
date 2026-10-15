/** P002 demand/priority proof using the real portfolio and scoped-review read path. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { parsePlan } from '@papercusp/plan-parser';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { defaultAgentObligationReaderDeps, readAgentObligationAgenda } from './agent-obligation-reader';
import { readGoalPortfolioBrief } from './goal-launch-settings';
import { applyGoalPropertyWrite } from './typed-properties-db';
import { seedPlan, cleanupPlans } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import { evaluateExactPlanAdmission } from './agent-tools/plans/plan-admission-preflight';
import recordTool, { ideatePassRecordArgs } from './agent-tools/scout/ideate-pass-record';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const OWNER = `su-planning-demand-${RUN}`;
const GOAL = `planning-demand-${RUN}`;
const HARNESS = `zzz-planning-demand-${RUN}`;
const SLUG = `existing-${RUN}`;
const PLAN = `plan:${HARNESS}/${SLUG}`;
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Planning demand fixture', body: 'Recover failed checkout', status: 'active', standing: true,
    killCriterion: 'Uncovered outcomes or unstaffed plans disappear from the agenda.' });
  expect((await setMode({ workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'Isolated demand and priority proof', setBy: OWNER, sql: fx.admin })).ok).toBe(true);
}, 150_000);

async function cleanupPlan() {
  await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.plan_decisions WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
}
afterEach(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
  await fx.admin`UPDATE harness_shared.goals SET properties = '{}'::jsonb WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await cleanupPlan();
});
afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND id = ${HARNESS}`;
  await fx.dispose();
});

async function setWorklist(value: string[], expectedVersion: number) {
  return fx.admin.begin(async (tx) => applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
    workspaceId: WS, goalId: GOAL, property: 'worklist', value, expectedVersion,
    actorId: OWNER, provenance: 'agent-edit',
  }));
}

async function existingPlan(status: 'draft' | 'ready') {
  // Seed controlled lifecycle inputs, not a claim that plan activation/admission ran.
  // Content and its index use the production parser/index writer; no workers are launched.
  const body = `---\ntitle: Existing recovery plan\nslug: ${SLUG}\nstatus: ${status}\n---\n\n## Build\n\n- **P-001** \`todo\` Implement recovery\n`;
  await seedPlan(fx.admin, WS, HARNESS, SLUG, body);
  const idx = deriveIndexFromContent(body);
  expect(idx.items).toHaveLength(1);
  await fx.admin.begin(async (tx) => {
    await tx`UPDATE harness_shared.harness_plans SET title = ${idx.title}, status = ${idx.status}
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, idx);
  });
  expect((await setWorklist([PLAN], 0)).ok).toBe(true);
}

// A supported no-new-plan review cites every worklist plan nothing is moving
// (goal-planning-needed-v4, WI-10006710); `citeWorklistPlan: false` is the negative control.
async function record(disposition: 'plan-needed' | 'existing-plans-sufficient', citeWorklistPlan = true) {
  const coverage = citeWorklistPlan ? [{ need: 'Recover failed checkout', itemRefs: ['WI-fixture-1'], planRef: PLAN }] : [];
  const result = await recordTool.handler(ideatePassRecordArgs.parse({ ideasFiled: 0, goalReview: {
    goalId: GOAL, disposition, rationale: 'Review of the isolated recovery portfolio.',
    evidenceRefs: [`goal:${GOAL}`],
    ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover failed checkout' } : { coverage }),
  } }), { isSuperuser: true, uiClientId: OWNER, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
  });
  expect('isError' in result && result.isError === true).toBe(false);
}

async function agenda(realAdmission = false) {
  return (await readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER,
    // Scope, portfolio, review, ownership, index and ordering are real. Launch admissibility
    // and unrelated final acceptance are controlled inputs: this proves priority,
    // not launch admission or a plan acceptance verdict.
    deps: { planSlugs: async () => [], ownerDirectives: async () => [], waitingOn: async () => [], 
      fleetStaffing: async () => [],
      strandedGoalWork: async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false }),
      ownerReport: async () => null,
      planAcceptance: async () => ({ satisfied: true, buildProvenance: { sha: null, version: 'fixture' } }),
      // Priority cases control admission as well as launch feasibility. The
      // separate negative control below uses the real PostgreSQL preflight.
      planAdmission: realAdmission ? defaultAgentObligationReaderDeps().planAdmission
        : async ({ planSlug, requestedSeats }) => evaluateExactPlanAdmission({
          planSlug, requestedSeats,
          planItems: parsePlan('## Build\n\n- **P-001** `todo` Implement recovery\n').items,
          workItems: [{ id: `WI-${RUN}`, family: 'issue', state: 'open',
            sourcePlanItemIds: ['P-001'], payload: null }],
          laneHealth: {
            claimable: 1, matchedByFilter: 1, excluded: {},
            issueFamily: { claimable: 1, matchedByFilter: 1, excluded: {} },
            featureFamily: null,
            effective: { claimable: 1, matchedByFilter: 1, excluded: {}, basis: 'issue-family' },
            familyReachability: { issue: true, feature: false },
            spec: { ref: `${PLAN}@1`, specId: PLAN, revision: 1,
              matchedBy: 'fixture', harness: HARNESS, assigneeScoped: null },
          },
        }),
      goalLaunch: async () => ({ goalId: GOAL, settings: null, goalBrief: null, effective: {},
        ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null },
        budget: null, refusal: null, degraded: false, degradedReasons: [] }),
      planFleet: async () => ({ status: 'known', alert: null, applicablePlanCount: 0 }),
    },
  })).agenda;
}

describe('goal planning demand and execution priority from PostgreSQL', () => {
  it.each([false, true])('retains an uncovered outcome with populated worklist=%s', async (populated) => {
    if (populated) await existingPlan('draft');
    await record('plan-needed');
    const portfolio = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL });
    expect(portfolio?.worklist).toHaveLength(populated ? 1 : 0);
    const row = (await agenda()).evaluations.find((entry) => entry.family === 'planning-needed');
    expect(row).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(row?.reason).toContain('Recover failed checkout');
  }, 90_000);

  it('allows a supported sufficient-plan review without suppressing unstaffed execution', async () => {
    await existingPlan('ready');
    await record('existing-plans-sufficient');
    const read = await agenda();
    expect(read.evaluations.find((entry) => entry.family === 'planning-needed')?.status).toBe('satisfied');
    expect(read.primary[0], read.primary[0]?.reason).toMatchObject({ family: 'plan-placement', status: 'due', action: { kind: 'delegate', tool: 'fleet:launch-on-plan' } });
  }, 90_000);

  it('keeps planning due when a sufficient-plan review omits the unplaced worklist plan', async () => {
    await existingPlan('ready');
    await record('existing-plans-sufficient', false);
    const planning = (await agenda()).evaluations.find((entry) => entry.family === 'planning-needed');
    expect(planning, planning?.reason).toMatchObject({ status: 'due', title: 'Account for every unplaced worklist plan' });
    expect(planning?.reason).toContain(PLAN);
  }, 90_000);

  it('prioritizes staffing the eligible unstaffed plan over further planning', async () => {
    await existingPlan('ready');
    await record('plan-needed');
    const read = await agenda();
    expect(read.primary[0], read.primary[0]?.reason).toMatchObject({ family: 'plan-placement', status: 'due', action: {
      kind: 'delegate', tool: 'fleet:launch-on-plan', args: { plan: SLUG, harness: HARNESS, leader: 'spawn' },
    } });
    const planningIndex = read.primary.findIndex((entry) => entry.family === 'planning-needed');
    expect(planningIndex).toBeGreaterThan(0);
  }, 90_000);

  it('requires actual promotion before real admission permits staffing a ready plan', async () => {
    await existingPlan('ready');
    await record('plan-needed');
    const read = await agenda(true);
    expect(read.primary[0], read.primary[0]?.reason).toMatchObject({
      family: 'plan-placement', status: 'blocked',
      reason: 'Actionable plan items lack a promoted row: P-001.',
      action: { kind: 'repair', targetRef: PLAN },
    });
    expect(read.primary[0]?.episode).toContain(':promotion-lag:');
    expect(read.primary[0]?.action?.tool).toBeUndefined();
    expect(read.evaluations.find((entry) => entry.family === 'planning-needed')?.status).toBe('due');
  }, 90_000);

  it('reports a blocked draft without instructing an inadmissible launch or losing the planning need', async () => {
    await existingPlan('draft');
    await record('plan-needed');
    const read = await agenda();
    const placement = read.evaluations.find((entry) => entry.family === 'plan-placement');
    expect(placement).toMatchObject({ status: 'blocked' });
    expect(placement?.action?.tool).toBeUndefined();
    expect(read.evaluations.find((entry) => entry.family === 'planning-needed')?.status).toBe('due');
  }, 90_000);

  it('rejects stale worklist CAS without erasing the already selected execution demand', async () => {
    await existingPlan('ready');
    await record('plan-needed');
    const rejected = await setWorklist([`plan:${HARNESS}/replacement`], 0);
    expect(rejected).toMatchObject({ ok: false, code: 'stale' });
    expect((await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL }))?.worklist.map((p) => p.ref)).toEqual([PLAN]);
    expect((await agenda()).primary[0]?.action?.targetRef).toBe(PLAN);
  }, 90_000);
});

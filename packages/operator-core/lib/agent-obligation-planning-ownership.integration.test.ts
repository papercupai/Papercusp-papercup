/** Canonical goal-pot writes -> current ownership read -> goal planning action. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { linkPot, unlinkPot } from '@papercusp/db-org';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { defaultAgentObligationReaderDeps, readAgentObligationAgenda } from './agent-obligation-reader';
import * as goalLaunch from './goal-launch-settings';
import recordTool, { ideatePassRecordArgs } from './agent-tools/scout/ideate-pass-record';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const OWNER = `su-planning-ownership-${RUN}`;
const GOAL = `planning-local-${RUN}`;
const FOREIGN = `planning-foreign-${RUN}`;
const HARNESS = `planning-candidate-${RUN}`;
const PLAN = `plan:${HARNESS}/existing-plan`;
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  for (const id of [GOAL, FOREIGN]) await insertGoalRow(fx.admin, {
    id, workspaceId: WS, installSlug: 'papercusp', title: id,
    body: 'Reuse suitable scoped work without duplicate execution.', status: 'active',
    killCriterion: 'Planning crosses another active goal ownership boundary.',
  });
  expect((await setMode({ workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'Isolated planning sovereignty proof', setBy: OWNER, sql: fx.admin })).ok).toBe(true);
}, 150_000);

afterEach(async () => {
  vi.restoreAllMocks();
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goal_pots WHERE workspace_id = ${WS} AND goal_id IN (${GOAL}, ${FOREIGN})`;
  await fx.admin`UPDATE harness_shared.goals SET status = 'active' WHERE workspace_id = ${WS} AND id IN (${GOAL}, ${FOREIGN})`;
});

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id IN (${GOAL}, ${FOREIGN})`;
  await fx.dispose();
});

async function own(goalId: string) {
  return linkPot(fx.admin, { workspaceId: WS, goalId, harnessSlug: HARNESS, role: 'owner', by: OWNER });
}

async function record(disposition: 'adopt-plan' | 'revise-plan' = 'adopt-plan') {
  const result = await recordTool.handler(ideatePassRecordArgs.parse({ ideasFiled: 0, goalReview: {
    goalId: GOAL, disposition, rationale: 'The candidate covers the needed outcome; reuse it if current ownership permits.',
    evidenceRefs: [PLAN], planRefs: [PLAN],
  } }), { isSuperuser: true, uiClientId: OWNER, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
  });
  expect('isError' in result && result.isError === true).toBe(false);
}

async function planning() {
  const read = await readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER,
    // Real mode binding, portfolio, scoped review ledger and goal-pot authority.
    // No worker is launched; unrelated agenda sources alone are replaced.
    deps: { planSlugs: async () => [], ownerDirectives: async () => [], waitingOn: async () => [], 
      fleetStaffing: async () => [],
      strandedGoalWork: async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false }),
      ownerReport: async () => null,
      goalLaunch: async () => ({ goalId: GOAL, settings: null, goalBrief: null, effective: {},
        ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null },
        budget: null, refusal: null, degraded: false, degradedReasons: [] }),
      planFleet: async () => ({ status: 'known', alert: null, applicablePlanCount: 0 }),
    },
  });
  const row = read.agenda.evaluations.find((entry) => entry.family === 'planning-needed');
  expect(row).toBeDefined();
  return row!;
}

function expectReuse(row: Awaited<ReturnType<typeof planning>>) {
  expect(row).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue', targetRef: PLAN } });
  expect(row.action!.summary).toMatch(/existing plan, not a clone/);
  for (const guard of ['ownership', 'CAS', 'budget', 'admission']) expect(row.action!.summary).toContain(guard);
  expect(row.action!.tool).toBeUndefined(); // A recorded review is not mutation authority.
}

function expectRoute(row: Awaited<ReturnType<typeof planning>>) {
  expect(row).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'report', targetRef: PLAN } });
  expect(row.reason).toContain(FOREIGN);
  expect(row.action!.summary).toContain('do not adopt or duplicate');
  expect(row.action!.tool).toBeUndefined();
}

describe('planning uses live canonical ownership, not the review as authority', () => {
  it.each(['adopt-plan', 'revise-plan'] as const)('allows guarded %s for a locally owned candidate', async (disposition) => {
    await own(GOAL);
    await record(disposition);
    const source = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(source.authorities[HARNESS]).toMatchObject({ allowed: true, reason: 'caller-goal-owns-pot', ownerGoalId: GOAL });
    expectReuse(await planning());
  }, 90_000);

  it('allows nonduplicating adoption of an unowned candidate', async () => {
    await record();
    const source = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(source.authorities[HARNESS]).toMatchObject({ allowed: true, reason: 'no-active-owner', ownerGoalId: null });
    expectReuse(await planning());
  }, 90_000);

  it.each(['adopt-plan', 'revise-plan'] as const)('routes %s to the foreign active owner', async (disposition) => {
    await own(FOREIGN);
    await record(disposition);
    const source = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(source.authorities[HARNESS]).toMatchObject({ allowed: false, reason: 'different-active-goal-owns-pot', ownerGoalId: FOREIGN });
    expectRoute(await planning());
  }, 90_000);

  it('rechecks ownership after a review without rewriting that review', async () => {
    await own(GOAL);
    await record();
    const before = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    const initial = await planning();
    expectReuse(initial);
    await own(FOREIGN); // Canonical handover demotes the prior owner in the fixture.
    const after = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(after.review).toEqual(before.review);
    const changed = await planning();
    expectRoute(changed);
    expect(changed.sourceGeneration).not.toBe(initial.sourceGeneration);
  }, 90_000);

  it.each(['killed', 'achieved'])('retains %s ownership history without reserving the candidate forever', async (status) => {
    await own(FOREIGN);
    await fx.admin`UPDATE harness_shared.goals SET status = ${status} WHERE workspace_id = ${WS} AND id = ${FOREIGN}`;
    await record();
    const edges = await fx.admin`SELECT role, removed_at FROM harness_shared.goal_pots WHERE workspace_id = ${WS} AND goal_id = ${FOREIGN} AND harness_slug = ${HARNESS}`;
    expect(edges).toMatchObject([{ role: 'owner', removed_at: null }]);
    const source = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(source.authorities[HARNESS]).toMatchObject({ allowed: true, reason: 'no-active-owner' });
    expectReuse(await planning());
  }, 90_000);

  it('does not mistake a tombstoned owner edge for live authority', async () => {
    await own(FOREIGN);
    expect(await unlinkPot(fx.admin, { workspaceId: WS, goalId: FOREIGN, harnessSlug: HARNESS, by: OWNER })).toBe(true);
    await record();
    const edges = await fx.admin`SELECT removed_at FROM harness_shared.goal_pots WHERE workspace_id = ${WS} AND goal_id = ${FOREIGN} AND harness_slug = ${HARNESS}`;
    expect(edges).toHaveLength(1);
    expect(edges[0].removed_at).not.toBeNull();
    expectReuse(await planning());
  }, 90_000);

  it('keeps a failed authority read unknown rather than granting adoption or reporting no demand', async () => {
    await own(FOREIGN);
    await record();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(goalLaunch, 'resolveGoalPotPlacementAuthority').mockRejectedValueOnce(new Error('injected authority read failure'));
    const row = await planning();
    expect(row).toMatchObject({ status: 'unknown', action: { kind: 'inspect' }, measurementFailure: { code: 'canonical-goal-planning-read-failed' } });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('injected authority read failure'));
    expect(row.action!.summary).not.toMatch(/adopt.*plan/i);
    expectRoute(await planning()); // Recovered real DB read still sees the foreign owner.
  }, 90_000);
});

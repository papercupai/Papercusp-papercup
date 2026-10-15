/** Production gap-review handler and canonical scope reads on isolated PG. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { setMode } from '../../modes/store';
import { parseGoalPlanningReview, readGoalPlanningReviewContext } from '../../goal-planning-review';
import { readGoalDayCandidates } from '../../goal-holder-behavior-metrics';
import recordTool, { ideatePassRecordArgs, type IdeatePassRecordResult } from './ideate-pass-record';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-goal-review-${RUN}`;
const UNBOUND = `su-goal-review-unbound-${RUN}`;
const GOAL = `goal-review-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, {
    id: GOAL, installSlug: 'papercusp', workspaceId: WS,
    title: 'Isolated goal review record',
    body: 'A controlled recording fixture with no product work to launch.',
    killCriterion: 'The review loses scope or recorded evidence.', status: 'active',
  });
  const mode = await setMode({
    workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'P008 isolated scope and persistence test', setBy: OWNER, sql: fx.admin,
  });
  expect(mode.ok).toBe(true);
}, 150_000);

afterEach(async () => {
  if (fx) await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' IN (${OWNER}, ${UNBOUND})`;
});

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

async function record(goalId = GOAL, owner = OWNER) {
  const args = ideatePassRecordArgs.parse({
    ideasFiled: 0,
    goalReview: {
      goalId, disposition: 'no-eligible-work',
      rationale: 'The isolated recording fixture has no product work requiring a new plan.',
      evidenceRefs: [`goal:${GOAL}`],
      // P-003/P-009: a no-new-plan review must carry a coverage map; [] states there is
      // no recurring need, which is true of this isolated fixture.
      coverage: [],
    },
  });
  const context: Parameters<typeof recordTool.handler>[1] = {
    isSuperuser: true, uiClientId: owner, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(),
    signal: new AbortController().signal, emit: vi.fn(async () => {}),
  };
  const result = await recordTool.handler(args, context);
  if (!('content' in result) || !Array.isArray(result.content)) throw new Error('Expected the normal MCP result envelope');
  const first = result.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') throw new Error('Expected a text result payload');
  const payload = JSON.parse(first.text) as IdeatePassRecordResult;
  return { payload, isError: 'isError' in result && result.isError === true };
}

describe('goal review production persistence', () => {
  it('persists a zero-idea review with canonical scope and a measured portfolio fingerprint', async () => {
    const before = await readGoalPlanningReviewContext(WS, OWNER);
    expect(before?.goalId).toBe(GOAL);
    const { payload } = await record();
    expect(payload.ok).toBe(true);
    const rows = await fx.admin`
      SELECT origin, ideas_routed, detail FROM harness_shared.scout_ticks
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'su-ideate', ideas_routed: 0 });
    const persisted = parseGoalPlanningReview(rows[0].detail.goalReview);
    expect(persisted).toMatchObject({
      goalId: GOAL, disposition: 'no-eligible-work', evidenceRefs: [`goal:${GOAL}`],
      portfolioFingerprint: before?.portfolioFingerprint,
    });
    expect(payload).toMatchObject({ goalReview: persisted });
    expect(Number.isFinite(Date.parse(persisted!.reviewedAt))).toBe(true);
  }, 90_000);

  it('does not persist a review for a different goal', async () => {
    const { isError, payload } = await record('another-goal');
    expect(payload).toMatchObject({ ok: false, reason: 'goal-review-scope-mismatch' });
    expect(isError).toBe(true);
    const rows = await fx.admin`SELECT id FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    expect(rows).toHaveLength(0);
  }, 90_000);

  it('does not persist a review for a caller with no GOAL binding', async () => {
    const { payload } = await record(GOAL, UNBOUND);
    expect(payload).toMatchObject({ ok: false, reason: 'goal-review-unavailable' });
    const rows = await fx.admin`SELECT id FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${UNBOUND}`;
    expect(rows).toHaveLength(0);
  }, 90_000);

  it('keeps old evidence distinct when the goal outcome changes', async () => {
    const { payload } = await record();
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error('positive recording control failed');
    const original = payload.goalReview!.portfolioFingerprint;
    await fx.admin`UPDATE harness_shared.goals SET body = 'A newly uncovered goal outcome.' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    try {
      const changed = await readGoalPlanningReviewContext(WS, OWNER);
      expect(changed?.portfolioFingerprint).not.toBe(original);
      const rows = await fx.admin`SELECT detail FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
      expect(parseGoalPlanningReview(rows[0].detail.goalReview)?.portfolioFingerprint).toBe(original);
    } finally {
      await fx.admin`UPDATE harness_shared.goals SET body = 'A controlled recording fixture with no product work to launch.' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    }
  }, 90_000);
});

describe('goal-day ideation yield on real PG (P-004 / D-001)', () => {
  const SPAWN = `p004-${RUN}`;
  const seed = (tool: string, o: { goalId?: string | null; args?: unknown; status?: string; minutesAgo?: number }) => fx.admin`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, goal_id, args_json, invoked_at)
    VALUES (${WS}, 'papercusp', 'p004-test', ${tool}, 'su', ${SPAWN}, 'p004', ${o.status ?? 'ok'}, ${o.goalId ?? null},
            ${o.args === undefined ? null : fx.admin.json(o.args as Parameters<typeof fx.admin.json>[0])},
            now() - make_interval(mins => ${o.minutesAgo ?? 10}))`;

  afterEach(async () => {
    if (fx) await fx.admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS} AND spawn_id = ${SPAWN}`;
  });

  it('tells the holder on the receipt that a goal-day with no candidate still owes one', async () => {
    const { payload } = await record();
    expect(payload).toMatchObject({ ok: true, ideationYield: { goalId: GOAL, candidates: 0, owed: true } });
  }, 90_000);

  it('counts only settled plan proposals and reported ideas for this goal inside the goal-day', async () => {
    await seed('plans:new', { goalId: GOAL });
    await seed('plans:new', { goalId: GOAL, status: 'error' });
    await seed('plans:new', { goalId: GOAL, minutesAgo: 25 * 60 });
    await seed('plans:new', { goalId: `other-${GOAL}` });
    await seed('blender:ideate-pass-record', { args: { ideasFiled: 2, goalReview: { goalId: GOAL } } });
    await seed('blender:ideate-pass-record', { args: { ideasFiled: 3, goalReview: { goalId: `other-${GOAL}` } } });
    await seed('blender:ideate-pass-record', { args: { ideasFiled: 5, goalReview: { goalId: GOAL } }, minutesAgo: 25 * 60 });

    const read = await readGoalDayCandidates({ workspaceId: WS, goalId: GOAL, at: new Date() }, { sql: fx.admin });
    expect(read).toMatchObject({ plansNew: 1, ideasFiled: 2 });

    const { payload } = await record();
    expect(payload).toMatchObject({ ok: true, ideationYield: { plansNew: 1, ideasFiled: 2, candidates: 3, owed: false } });
  }, 90_000);
});

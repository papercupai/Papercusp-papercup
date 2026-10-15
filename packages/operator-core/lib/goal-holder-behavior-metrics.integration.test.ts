/**
 * goal-holder-behavior-metrics.integration.test.ts — the plan-authorship count against
 * real Postgres (WI-10006048).
 *
 * A holder writes a plan either with plans:new or by routing an idea onto the plan rail
 * (blender:route-idea { rail:'plan' }), which creates the draft through
 * createScoutPlanDraft and never calls plans:new. The WOE rating once counted plans:new
 * alone, so holder su-a70547cc, who routed an idea into a plan on 2026-10-03, read as
 * having written none. A route call can also settle 'ok' while creating nothing (a
 * refusal, or an idempotent re-route onto an existing plan), so it counts only when a
 * plan row was created inside the call's own run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  readGoalDayCandidates,
  readGoalDayHolderAttribution,
  collectGoalHolderBehaviorMetrics,
  rateGoalHolderBehavior,
  readHolderPlanToolCounts,
  ROUTED_PLAN_CLOCK_SLACK_MS,
} from './goal-holder-behavior-metrics';
import { readUnplannedGoalClusters } from './goals/unplanned-clusters';
import { toolFailureSignatureKey } from './harness/improvements/tool-error-classifier';

const { createOrgTestDb } = await import('../test/_org-test-db');

const WS = 'ws-goal-holder-metrics';
const HARNESS = 'papercusp';
const GOAL = 'goal-holder-metrics-goal';
const OTHER_GOAL = 'goal-holder-metrics-other-goal';
const HOLDER = 'su-holder-under-test';
const PEER = 'su-peer-not-graded';
const WINDOW_START = '2026-10-03T07:00:00.000Z';
const WINDOW_END = '2026-10-03T09:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('goal-holder plan authorship (real PG)', () => {
  let db: OrgTestDb;

  async function invocation(row: {
    owner: string;
    tool: string;
    invokedAt: string;
    durationMs?: number;
    goalId?: string | null;
    status?: string;
    args?: Record<string, unknown>;
  }): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
         coord_owner_id, invoked_at, duration_ms, goal_id, args_json)
      VALUES (${WS}, ${HARNESS}, 'operator', ${row.tool}, 'su', 'spawn-test', 'window-test',
              ${row.status ?? 'ok'}, ${row.owner}, ${at(row.invokedAt)}, ${row.durationMs ?? 150},
              ${row.goalId === undefined ? GOAL : row.goalId}, ${db.adminSql.json((row.args ?? {}) as never)})`;
  }

  async function plan(slug: string, createdAt: string, goalId: string | null = GOAL): Promise<void> {
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, goal_id, created_at)
      VALUES (${WS}, ${HARNESS}, ${slug}, ${slug}, 'draft', ${goalId}, ${at(createdAt)})`;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();

    // 1. A route-idea call that created its plan: the plan row lands inside the call's
    //    run, 147 ms before the JS-stamped settle time (the shape measured live 2026-10-03).
    await plan('routed-plan-created', '2026-10-03T08:08:20.996Z');
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:08:21.143Z', durationMs: 158,
      args: { rail: 'plan', featureId: 'EI-1' },
    });

    // 2. A route-idea call that settled 'ok' but refused (no plan row anywhere near it).
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T07:30:00.000Z',
      args: { rail: 'plan', draft: { title: 'refused placeholder draft' } },
    });

    // 3. An idempotent re-route onto a plan created two days earlier: nothing new was written.
    await plan('routed-plan-existing', '2026-10-01T08:00:00.000Z');
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:40:00.000Z',
      args: { rail: 'plan', featureId: 'EI-2' },
    });

    // 4. plans:new still counts on its own invocation.
    await invocation({ owner: HOLDER, tool: 'plans:new', invokedAt: '2026-10-03T08:20:00.000Z' });

    // 5. Starting and staffing plans.
    await invocation({ owner: HOLDER, tool: 'plans:start', invokedAt: '2026-10-03T08:25:00.000Z' });
    await invocation({ owner: HOLDER, tool: 'fleet:launch-on-plan', invokedAt: '2026-10-03T08:26:00.000Z' });

    // 6. A peer's route-idea plan for the same goal: a goal-day candidate, never the holder's.
    await plan('peer-routed-plan', '2026-10-03T08:50:00.050Z');
    await invocation({
      owner: PEER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:50:00.200Z', durationMs: 200,
      args: { rail: 'plan', draft: { title: 'peer idea' } },
    });

    // 7. A route-idea plan for a DIFFERENT goal: not a candidate for GOAL.
    await plan('other-goal-plan', '2026-10-03T08:55:00.000Z', OTHER_GOAL);
    await invocation({
      owner: PEER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:55:00.100Z', goalId: OTHER_GOAL,
      args: { rail: 'plan', draft: { title: 'other goal idea' } },
    });

    // 8. A failed route-idea call beside a real plan creation is still not counted.
    await plan('coincident-plan', '2026-10-03T08:58:00.000Z');
    await invocation({
      owner: HOLDER, tool: 'blender:route-idea', invokedAt: '2026-10-03T08:58:00.100Z', status: 'error',
      args: { rail: 'plan' },
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('counts a route-idea call that created a plan as a plan the holder wrote', async () => {
    const counts = await readHolderPlanToolCounts(
      { workspaceId: WS, holderOwnerId: HOLDER, windowStart: WINDOW_START, windowEnd: WINDOW_END },
      { sql: db.adminSql },
    );
    // plans:new (4) + the route that created its plan (1). The refusal (2), the re-route
    // onto an old plan (3) and the errored call (8) wrote nothing; the peer's plan (6) is not the holder's.
    expect(counts).toEqual({ plansNew: 2, plansStarted: 1, planFleetLaunches: 1 });
  });

  it('a window holding only the route-idea plan reads one plan written, not zero (the 2026-10-03 miss)', async () => {
    const window = { start: at('2026-10-03T08:00:00.000Z'), end: at('2026-10-03T08:10:00.000Z') };
    // Positive control: the retired plans:new-only count reads this window as 0, so the
    // fixture reproduces the defect rather than passing for an unrelated reason.
    const [retired] = await db.adminSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.tool_invocations
       WHERE workspace_id = ${WS} AND coord_owner_id = ${HOLDER} AND status = 'ok'
         AND tool_name = 'plans:new' AND invoked_at BETWEEN ${window.start} AND ${window.end}`;
    expect(Number(retired?.n)).toBe(0);
    const counts = await readHolderPlanToolCounts(
      { workspaceId: WS, holderOwnerId: HOLDER, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() },
      { sql: db.adminSql },
    );
    expect(counts.plansNew).toBe(1);
  });

  it('a plan created just outside the call run plus slack is not attributed to the call', async () => {
    const settle = '2026-10-03T08:45:00.000Z';
    const tooEarly = new Date(at(settle).getTime() - 150 - ROUTED_PLAN_CLOCK_SLACK_MS - 1_000).toISOString();
    await plan('plan-before-the-call', tooEarly);
    await invocation({ owner: HOLDER, tool: 'blender:route-idea', invokedAt: settle, durationMs: 150, args: { rail: 'plan' } });
    const counts = await readHolderPlanToolCounts(
      { workspaceId: WS, holderOwnerId: HOLDER, windowStart: '2026-10-03T08:44:00.000Z', windowEnd: '2026-10-03T08:46:00.000Z' },
      { sql: db.adminSql },
    );
    expect(counts.plansNew).toBe(0);
  });

  it('goal-day candidates count route-idea plans for the goal by any author, and only for that goal', async () => {
    const candidates = await readGoalDayCandidates(
      { workspaceId: WS, goalId: GOAL, at: at(WINDOW_END) },
      { sql: db.adminSql },
    );
    // holder route (1) + holder plans:new (4) + peer route (6). The other goal's plan (7) is excluded.
    expect(candidates.plansNew).toBe(3);
    const other = await readGoalDayCandidates(
      { workspaceId: WS, goalId: OTHER_GOAL, at: at(WINDOW_END) },
      { sql: db.adminSql },
    );
    expect(other.plansNew).toBe(1);
  });

  it('D-008: collector distinguishes inherited uncertainty from due-negative and due-positive without shrinking the goal-day population', async () => {
    const goalId = 'd008-inherited';
    const window = { workspaceId: WS, goalId, holderOwnerId: HOLDER, windowStart: '2026-10-03T04:00:00.000Z', windowEnd: WINDOW_END };
    const elect = async (goal: string, owner: string, when: string, oldMode: string | null = null, newMode: string | null = 'goal') => {
      await db.adminSql`
        INSERT INTO harness_shared.agent_mode_changes
          (workspace_id, owner_id, axis_key, old_mode, new_mode, subject, changed_at, reason, set_by)
        VALUES (${WS}, ${owner}, 'objective', ${oldMode}, ${newMode}, ${goal}, ${at(when)}, 'D-008 test', 'test')`;
    };
    await elect(goalId, HOLDER, '2026-10-02T08:00:00Z');
    await elect(goalId, PEER, '2026-10-03T06:00:00Z');
    await elect(goalId, HOLDER, WINDOW_START);
    // A predecessor's bad review and this holder's earlier separated-tenure review stay
    // in the population, but neither is attributed to the recovered continuous tenure.
    await invocation({ owner: PEER, tool: 'blender:ideate-pass-record', goalId, invokedAt: '2026-10-03T06:00:00Z', args: { goalReview: { goalId, disposition: 'existing-plans-sufficient', coverage: [{ itemRefs: ['a', 'b', 'c'] }] }, ideasFiled: [] } });
    await invocation({ owner: HOLDER, tool: 'blender:ideate-pass-record', goalId, invokedAt: '2026-10-03T05:00:00Z', args: { goalReview: { goalId, disposition: 'existing-plans-sufficient', coverage: [{ itemRefs: ['a', 'b', 'c'] }] }, ideasFiled: [] } });
    await invocation({ owner: HOLDER, tool: 'blender:ideate-pass-record', goalId: OTHER_GOAL, invokedAt: '2026-10-03T08:00:00Z', args: { goalReview: { goalId: OTHER_GOAL, coverage: [{ itemRefs: ['a', 'b', 'c'] }] }, ideasFiled: [] } });
    const inherited = await collectGoalHolderBehaviorMetrics(window, { sql: db.adminSql });
    expect(inherited.ideation.holderAttribution).toEqual({ status: 'inherited', holderSince: WINDOW_START, exercisedReviews: 0 });
    expect(inherited.ideation.reviewsWithUncoveredClusterNeed).toBe(0);
    expect(rateGoalHolderBehavior(inherited)['ideation-yield']).toMatchObject({ verdict: 'unknown', unknownReason: 'scope-mismatch' });
    expect(await collectGoalHolderBehaviorMetrics(window, { sql: db.adminSql })).toEqual(inherited);

    await invocation({ owner: HOLDER, tool: 'blender:ideate-pass-record', goalId, invokedAt: '2026-10-03T08:00:00Z', args: { goalReview: { goalId, disposition: 'existing-plans-sufficient', coverage: [] }, ideasFiled: [] } });
    const exercised = await collectGoalHolderBehaviorMetrics(window, { sql: db.adminSql });
    expect(exercised.ideation.holderAttribution?.exercisedReviews).toBe(1);
    expect(rateGoalHolderBehavior(exercised)['ideation-yield'].verdict).toBe('unknown');
    // Predecessor candidates before the recovered tenure still count for the goal.
    await invocation({ owner: PEER, tool: 'plans:new', goalId, invokedAt: '2026-10-03T05:00:00Z' });
    await invocation({ owner: PEER, tool: 'blender:ideate-pass-record', goalId, invokedAt: '2026-10-03T05:30:00Z', args: { goalReview: { goalId }, ideasFiled: ['peer-idea'] } });
    const positive = await collectGoalHolderBehaviorMetrics(window, { sql: db.adminSql });
    const population = await readGoalDayCandidates({ workspaceId: WS, goalId, at: at(WINDOW_END) }, { sql: db.adminSql });
    expect(positive.ideation).toMatchObject({ since: population.since, plansNew: 1, ideasFiled: 1 });
    expect(rateGoalHolderBehavior(positive)['ideation-yield'].verdict).toBe('pass');
    await invocation({ owner: HOLDER, tool: 'blender:ideate-pass-record', goalId, invokedAt: '2026-10-03T08:10:00Z', args: { goalReview: { goalId, coverage: [{ itemRefs: ['a', 'b', 'c'] }] }, ideasFiled: [] } });
    const failedReview = await collectGoalHolderBehaviorMetrics({ ...window, windowStart: '2026-10-03T08:30:00Z' }, { sql: db.adminSql });
    expect(failedReview.ideation.reviewsWithUncoveredClusterNeed).toBe(1);
    expect(rateGoalHolderBehavior(failedReview)['ideation-yield'].verdict).toBe('fail');

    const dueWindow = { ...window, goalId: 'd008-full-day' };
    await elect(dueWindow.goalId, HOLDER, '2026-10-02T08:00:00Z');
    await elect(dueWindow.goalId, HOLDER, '2026-10-03T07:30:00Z', 'goal');
    const due = await collectGoalHolderBehaviorMetrics(dueWindow, { sql: db.adminSql });
    expect(due.ideation.holderAttribution?.status).toBe('full-goal-day');
    expect(rateGoalHolderBehavior(due)['ideation-yield'].verdict).toBe('fail');
    const shortDue = await collectGoalHolderBehaviorMetrics({ ...dueWindow, windowStart: '2026-10-03T08:50:00Z' }, { sql: db.adminSql });
    expect(rateGoalHolderBehavior(shortDue)['ideation-yield'].verdict).toBe('fail');
    await elect(dueWindow.goalId, HOLDER, '2026-10-03T08:30:00Z', 'goal', null);
    expect(await readGoalDayHolderAttribution(dueWindow, { sql: db.adminSql })).toEqual({ status: 'unverified', holderSince: null });
  }, 120_000);

  it('does not backdate probation promotions into a historical cluster window', async () => {
    const boundary = at('2026-10-06T21:13:28.490Z').getTime();
    const promotedAtGlance = '2026-10-07T02:17:01.818Z';
    const promotedAtFlags = '2026-10-07T02:17:01.139Z';
    const promotedAt = Math.max(at(promotedAtGlance).getTime(), at(promotedAtFlags).getTime());
    const signature = (toolName: string) =>
      toolFailureSignatureKey({ toolName, errorCode: 'authorization_denied' }, 'structural');
    const rows = [
      {
        id: 'EI-cluster-anchor',
        title: 'Residual authorization_denied after the prior fix',
        createdAt: '2026-09-20T09:30:53.555Z',
        signatureKey: signature('coord:orient'),
        promotionAt: null,
      },
      {
        id: 'EI-cluster-glance',
        title: 'coord:glance tool-call failure (authorization_denied)',
        createdAt: '2026-10-05T17:41:42.571Z',
        signatureKey: signature('coord:glance'),
        promotionAt: promotedAtGlance,
      },
      {
        id: 'EI-cluster-flags',
        title: 'flags:get tool-call failure (authorization_denied)',
        createdAt: '2026-10-05T17:46:12.538Z',
        signatureKey: signature('flags:get'),
        promotionAt: promotedAtFlags,
      },
    ];

    for (const row of rows) {
      const payload = {
        toolFailureSignature: { signatureKey: row.signatureKey },
        ...(row.promotionAt
          ? { toolFailureProbation: { state: 'promoted', promotedAt: row.promotionAt } }
          : {}),
      };
      await db.adminSql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload, goal_id)
        VALUES (${WS}, ${HARNESS}, ${row.id}, 'bug', ${row.title}, 'open',
                ${at(row.createdAt).getTime()}, ${db.adminSql.json(payload as never)}, ${GOAL})`;
    }

    const beforePromotion = await readUnplannedGoalClusters(
      db.adminSql,
      { workspaceId: WS, goalId: GOAL, asOfMs: boundary },
    );
    expect(beforePromotion.itemCount).toBe(1);
    expect(beforePromotion.clusters).toEqual([]);

    const afterPromotion = await readUnplannedGoalClusters(
      db.adminSql,
      { workspaceId: WS, goalId: GOAL, asOfMs: promotedAt + 1 },
    );
    expect(afterPromotion.itemCount).toBe(3);
    expect(afterPromotion.clusters).toHaveLength(1);
    expect(afterPromotion.clusters[0].memberIds.slice().sort()).toEqual(rows.map((row) => row.id).sort());
    expect(afterPromotion.clusters[0].reasons).toEqual(['failure:structural:authorization_denied']);
    expect(afterPromotion.clusters[0].formedAtMs).toBe(promotedAt);
  });
});

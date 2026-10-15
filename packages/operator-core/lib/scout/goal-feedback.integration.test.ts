/**
 * goal-feedback — real-PG proof for goal-brief-to-claimed-plan-work-2026-09-23 P-009.
 *
 * Both planning origins against Blender's existing surfaces (D-005 / D-007):
 *  - a goal-local plan gets exactly one su-ideate origin row, its outcome is learned
 *    from the plan's terminal state, and repeated review findings accumulate on it;
 *  - adopting a Blender plan, or routing another goal's plan, writes nothing and
 *    leaves the original attribution intact (no duplicate row per routed ref).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { recordRoutedIdea, refreshScoutOutcomes } = await import('./routed-ledger');
// The mutation runner substitutes a copy while the tracked source stays intact.
const subject: typeof import('./goal-feedback') = process.env.PAPERCUSP_GOAL_FEEDBACK_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_GOAL_FEEDBACK_PROBE).href)
  : await import('./goal-feedback');
const { recordGoalLocalPlanOrigin, recordGoalReviewFeedback, goalLocalPlanIdeaId } = subject;
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-goal-feedback-test';
// Canonical slug: harness_plans_canonicalize_slug rewrites the retired 'papercup'.
const HARNESS = 'papercusp';
const RETIRED_ALIAS = 'papercup';
const GOAL_A = 'goal-a';
const GOAL_B = 'goal-b';
const HOLDER_A = 'su-holder-a';
const HOLDER_B = 'su-holder-b';
const T = Date.parse('2026-09-26T08:00:00Z');

interface LedgerRow {
  idea_id: string;
  origin: string | null;
  created_by: string | null;
  lens: string;
  rail: string;
  outcome: string | null;
  addresses_pattern_refs: string[] | null;
}

describe('goal-local findings and outcomes reach the routed-idea ledger (real PG, P-009)', () => {
  let db: OrgTestDb;

  const rowsFor = async (routedRef: string): Promise<LedgerRow[]> =>
    (await db.adminSql`
      SELECT idea_id, origin, created_by, lens, rail, outcome, addresses_pattern_refs
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS} AND routed_ref = ${routedRef}
       ORDER BY idea_id`) as unknown as LedgerRow[];

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, goal_id, updated_at)
      VALUES
        (${WS}, ${HARNESS}, 'local-plan', 'Goal A local plan', 'active', ${GOAL_A}, ${new Date(T)}),
        (${WS}, ${HARNESS}, 'blender-plan', 'Blender plan adopted by goal A', 'active', ${GOAL_A}, ${new Date(T)}),
        (${WS}, ${HARNESS}, 'goal-b-plan', 'Goal B local plan', 'active', ${GOAL_B}, ${new Date(T)}),
        (${WS}, ${HARNESS}, 'unowned-plan', 'Plan created outside any goal', 'active', NULL, ${new Date(T)})`;
    // Blender routed this plan before goal A adopted it (plans:launch stamped goal_id).
    await recordRoutedIdea({
      ideaId: 'scout-blender-1', lens: 'analogical', rail: 'plan', routedRef: 'plan:blender-plan',
      harnessSlug: HARNESS, cycleId: 'cycle-1', title: 'Blender plan', workspaceId: WS, routedAt: T,
      addressesPatternRefs: ['wi:EI-900'],
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('calibration: seeded plans and the Blender origin carry their declared goal attribution', async () => {
    const plans = await db.adminSql`
      SELECT plan_slug, status, goal_id FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
       ORDER BY plan_slug`;
    expect(plans.map((plan) => [plan.plan_slug, plan.status, plan.goal_id])).toEqual([
      ['blender-plan', 'active', GOAL_A],
      ['goal-b-plan', 'active', GOAL_B],
      ['local-plan', 'active', GOAL_A],
      ['unowned-plan', 'active', null],
    ]);
    const origins = await rowsFor('plan:blender-plan');
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      idea_id: 'scout-blender-1', origin: 'scout', created_by: null, lens: 'analogical', outcome: null,
    });
  });

  it('records exactly one su-ideate origin row for a goal-local plan, attributed to its holder', async () => {
    const first = await recordGoalLocalPlanOrigin({
      workspaceId: WS, harnessSlug: HARNESS, planSlug: 'local-plan', goalId: GOAL_A, ownerId: HOLDER_A,
    });
    expect(first).toMatchObject({ action: 'recorded', origin: 'su-ideate', ideaId: goalLocalPlanIdeaId(GOAL_A, HARNESS, 'local-plan') });

    const again = await recordGoalLocalPlanOrigin({
      workspaceId: WS, harnessSlug: HARNESS, planSlug: 'local-plan', goalId: GOAL_A, ownerId: HOLDER_A,
    });
    expect(again.action).toBe('unchanged');

    const rows = await rowsFor('plan:local-plan');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'su-ideate', created_by: HOLDER_A, lens: 'su-ideate', rail: 'plan' });
  });

  it('adopting a Blender plan preserves the Blender attribution and writes no duplicate row', async () => {
    const [result] = await recordGoalReviewFeedback({
      workspaceId: WS,
      ownerId: HOLDER_A,
      review: { goalId: GOAL_A, planRefs: ['plan:blender-plan'], evidenceRefs: ['EI-901'] },
    });
    expect(result).toMatchObject({ action: 'existing-attribution', ideaId: 'scout-blender-1', origin: 'scout' });

    const rows = await rowsFor('plan:blender-plan');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idea_id: 'scout-blender-1', origin: 'scout', created_by: null, lens: 'analogical' });
    expect(rows[0]!.addresses_pattern_refs).toEqual(['wi:EI-900']);
  });

  it("routing another goal's plan, or naming an unowned plan, never re-attributes it", async () => {
    await recordGoalLocalPlanOrigin({
      workspaceId: WS, harnessSlug: HARNESS, planSlug: 'goal-b-plan', goalId: GOAL_B, ownerId: HOLDER_B,
    });
    const results = await recordGoalReviewFeedback({
      workspaceId: WS,
      ownerId: HOLDER_A,
      review: {
        goalId: GOAL_A,
        // The retired-alias ref must still resolve to the (canonicalised) plan row.
        planRefs: ['plan:goal-b-plan', `plan:${RETIRED_ALIAS}/unowned-plan`, 'plan:missing-plan'],
        evidenceRefs: ['EI-902'],
      },
    });
    expect(results.map((r) => r.action)).toEqual(['not-goal-local', 'not-goal-local', 'plan-not-found']);

    const goalB = await rowsFor('plan:goal-b-plan');
    expect(goalB).toHaveLength(1);
    expect(goalB[0]).toMatchObject({ created_by: HOLDER_B, idea_id: goalLocalPlanIdeaId(GOAL_B, HARNESS, 'goal-b-plan') });
    expect(goalB[0]!.addresses_pattern_refs).toBeNull();
    expect(await rowsFor('plan:unowned-plan')).toHaveLength(0);
  });

  it('accumulates recurring review findings on the goal-local row, keeping only resolvable refs', async () => {
    const review = {
      goalId: GOAL_A,
      planRefs: ['plan:local-plan'],
      evidenceRefs: ['EI-100', 'session_turn:claude:abc:3', 'rubric:acceptance-x#c1@papercup'],
    };
    const [linked] = await recordGoalReviewFeedback({ workspaceId: WS, ownerId: HOLDER_A, review });
    expect(linked!.action).toBe('evidence-linked');

    const [recurring] = await recordGoalReviewFeedback({
      workspaceId: WS, ownerId: HOLDER_A, review: { ...review, evidenceRefs: ['wi:EI-100', 'WI-200'] },
    });
    expect(recurring!.action).toBe('evidence-linked');

    const [repeat] = await recordGoalReviewFeedback({ workspaceId: WS, ownerId: HOLDER_A, review });
    expect(repeat!.action).toBe('unchanged');

    const [row] = await rowsFor('plan:local-plan');
    expect(row!.addresses_pattern_refs).toEqual(['wi:EI-100', 'rubric:acceptance-x#c1@papercup', 'wi:WI-200']);
    expect(row!.created_by).toBe(HOLDER_A);
  });

  it('preserves both planning origins and goal links when revised plans receive more feedback', async () => {
    const beforeLocal = await rowsFor('plan:local-plan');
    const beforeBlender = await rowsFor('plan:blender-plan');
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET title = title || ' revised', content = 'Revised execution details', updated_at = ${new Date(T + 30_000)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND plan_slug IN ('local-plan', 'blender-plan')`;

    const feedback = await recordGoalReviewFeedback({
      workspaceId: WS, ownerId: HOLDER_A,
      review: { goalId: GOAL_A, planRefs: ['plan:local-plan', 'plan:blender-plan'], evidenceRefs: ['WI-201'] },
    });
    expect(feedback.map((result) => result.action)).toEqual(['evidence-linked', 'existing-attribution']);
    const local = await rowsFor('plan:local-plan');
    expect(local).toHaveLength(1);
    expect(local[0]).toEqual({ ...beforeLocal[0],
      addresses_pattern_refs: [...beforeLocal[0]!.addresses_pattern_refs!, 'wi:WI-201'],
    });
    expect(await rowsFor('plan:blender-plan')).toEqual(beforeBlender);
    const plans = await db.adminSql`
      SELECT plan_slug, goal_id FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND plan_slug IN ('local-plan', 'blender-plan') ORDER BY plan_slug`;
    expect([...plans]).toEqual([
      { plan_slug: 'blender-plan', goal_id: GOAL_A },
      { plan_slug: 'local-plan', goal_id: GOAL_A },
    ]);
  });

  it("learns the goal-local plan's verified outcome from its terminal state, like a Blender plan's", async () => {
    // A plan reaches 'shipped' only through plans:set-plan-status, whose accepted gate leaves
    // a transaction-local receipt naming ONE plan (migration 1279). Ship each in its own xact.
    for (const planSlug of ['local-plan', 'blender-plan']) {
      await db.adminSql.begin(async (tx) => {
        await tx`
          SELECT set_config('papercusp.plan_shipment_acceptance_gate_receipt', jsonb_build_object(
            'schemaVersion', 1, 'transactionId', txid_current()::text,
            'workspaceId', ${WS}::text, 'harnessSlug', ${HARNESS}::text, 'planSlug', ${planSlug}::text
          )::text, true)`;
        await tx`
          UPDATE harness_shared.harness_plans SET status = 'shipped', updated_at = ${new Date(T + 60_000)}
           WHERE workspace_id = ${WS} AND plan_slug = ${planSlug}`;
      });
    }
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS, origin: 'su-ideate' });
    await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS });

    const [local] = await rowsFor('plan:local-plan');
    const [blender] = await rowsFor('plan:blender-plan');
    expect(local!.outcome).toBe('won');
    expect(blender!.outcome).toBe('won');
    expect(blender!.origin).toBe('scout');
  });
});

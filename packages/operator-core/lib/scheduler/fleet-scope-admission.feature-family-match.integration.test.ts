/**
 * fleet-scope-admission.feature-family-match.integration.test.ts — WI-7151 (EI-19318364531323846):
 * recurrence guard for `diagnoseFleetScopeFeatureFamilyMatch` against REAL Postgres.
 *
 * THE BUG this closes: `diagnoseFleetScopeIssueFloorMiss` (WI-5561, backed by
 * `aggregateIssueClaimExclusions`) is STRUCTURALLY scoped to `item_kind IN
 * ('bug','change','task')` — it was built for issue-family kind-scoped drain fleets. A
 * PLAN-scoped fleet claim spec with no `kind` narrowing (`buildFleetPlanClaimSpec`, the shape
 * `fleet:launch-on-plan` authors when `claimKinds` is omitted) admits BOTH families, and every
 * plan-promoted item is feature-family by construction (D-009). So a plan whose items are ALL
 * feature-family made the issue-family breakdown report a confident `matchedByFilter: 0`, and
 * `fleetScopedMiss` certified that as `reason: 'spec_matches_nothing'` + `windDown: true` even
 * while the real tier-1 (feature-family) pool had open, unclaimed, spec-matching rows sitting
 * right there. Live incident 2026-08-02: an opencode-omp-research fleet member read exactly
 * this false verdict on its first wake.
 *
 * `diagnoseFleetScopeFeatureFamilyMatch` is the fix's DB-backed half: it runs the SAME
 * floors + filter compiler `getNextWorkItem`'s tier-1 attempt uses (claimFloorsWhereSql +
 * compileFilter over harness_features_consolidated), so a nonzero result here PROVES the
 * issue-family `matchedByFilter: 0` cannot be read as "the spec matches nothing". The pure
 * suppression logic in `fleetScopedMiss` is unit-tested (mocked `sql`) in
 * fleet-scope-admission.test.ts; this file is the "seed the exact row shapes against a real
 * DB" counterpart, following the same pattern as fleet-scope-admission.cooldown-diagnosis
 * .integration.test.ts.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/fleet-scope-admission.feature-family-match.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { STOP_THE_LINE_RED_HOURS } from '../work-items-admission';
import type { ClaimSpecRecord } from './claim-spec-store';
import type { FleetScopeContext } from './fleet-scope-admission';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { diagnoseFleetScopeFeatureFamilyExclusions, diagnoseFleetScopeFeatureFamilyMatch, fleetScopedMiss } =
  await import('./fleet-scope-admission');

const H = 'papercusp';
const WS = 'default';
const PLAN = 'opencode-omp-token-reduction-research-2026-08-02';
let db: FreshPgDb;

async function seedItem(
  id: string,
  opts: {
    itemKind?: string;
    status?: string;
    takenBy?: string | null;
    sourcePlanSlug?: string | null;
    payload?: Record<string, unknown> | null;
    conditionKey?: string | null;
    createdAgoMs?: number;
    harness?: string;
    workspaceId?: string;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, source_plan_slug, created_ts, updated_ts, payload, condition_key)
    VALUES (
      ${opts.harness ?? H}, ${id}, ${opts.itemKind ?? 'feature'}, ${`title ${id}`},
      ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${opts.workspaceId ?? WS},
      ${opts.sourcePlanSlug ?? null}, ${opts.createdAgoMs == null ? 0 : Date.now() - opts.createdAgoMs}, 0,
      ${opts.payload ? db.sql.json(opts.payload as postgres.JSONValue) : null}, ${opts.conditionKey ?? null}
    )`;
}

function planScopeFor(ownerId: string): FleetScopeContext {
  const spec: ClaimSpecRecord['spec'] = {
    specVersion: '1.0',
    specId: 'fleet-launch-opencode-omp-research-plan',
    revision: 1,
    view: { filter: { field: 'plan', op: '=', value: PLAN } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
  return {
    ownerId,
    fleetSlug: 'opencode-omp-research',
    fleetRole: 'member',
    workspaceId: WS,
    record: { source: 'fleet', spec, revision: 1, updatedBy: 'su-leader', updatedAt: 'now' },
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('fsa-feature-family-match');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});
afterEach(() => {
  delete process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC;
});

describe('diagnoseFleetScopeFeatureFamilyMatch against real Postgres (WI-7151)', () => {
  it('the exact live-incident shape: a plan-scoped spec finds its feature-family promoted items', async () => {
    await seedItem('WI-plan-1', { sourcePlanSlug: PLAN });
    await seedItem('WI-plan-2', { sourcePlanSlug: PLAN });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(2);
  });

  it('admits a plan-lane row stamped for this fleet, matching getNextWorkItem floor authorization', async () => {
    await seedItem('WI-fleet-plan', {
      sourcePlanSlug: PLAN,
      payload: {
        plan_item: { plan_slug: PLAN, item_id: 'P-001', harness_slug: H },
        fleet_slug: 'opencode-omp-research',
      },
    });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(1);
  });

  describe.each(['columns', 'payload'] as const)('claimed sibling identity from %s', (identitySource) => {
    it.each([
      { label: 'different item in the same plan', siblingPlan: PLAN, siblingItem: 'P-002', expected: 1 },
      { label: 'same item id in a different plan', siblingPlan: 'another-plan', siblingItem: 'P-001', expected: 1 },
      { label: 'genuine same-item sibling', siblingPlan: PLAN, siblingItem: 'P-001', expected: 0 },
    ])('$label preserves candidate correlation', async ({ siblingPlan, siblingItem, expected }) => {
      await seedItem('WI-candidate', {
        sourcePlanSlug: PLAN,
        payload: {
          plan_item: { plan_slug: PLAN, item_id: 'P-001', harness_slug: H },
          fleet_slug: 'opencode-omp-research',
        },
      });
      await seedItem('WI-held', {
        takenBy: 'su-peer',
        sourcePlanSlug: identitySource === 'columns' ? siblingPlan : null,
        payload: {
          plan_item: { plan_slug: siblingPlan, item_id: siblingItem, harness_slug: H },
          fleet_slug: 'opencode-omp-research',
        },
      });
      if (identitySource === 'columns') {
        await db.sql`
          UPDATE harness_shared.work_items SET source_plan_item_ids = ${[siblingItem]}::text[]
           WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = 'WI-held'`;
      }

      const breakdown = await diagnoseFleetScopeFeatureFamilyExclusions({
        scope: planScopeFor('su-member'),
        harness: H,
        workspaceId: WS,
      });

      // A held row from another item must never shadow the candidate's payload
      // inside the correlated sibling subquery (EI-22532026672585665).
      expect(breakdown?.claimable).toBe(expected);
      expect(breakdown?.excluded.reservedPlanLane).toBe(expected === 1 ? 0 : 1);
    });
  });

  it('reports pre-floor matches and names a foreign plan-lane reservation', async () => {
    await seedItem('WI-orphan-reservation', {
      sourcePlanSlug: PLAN,
      payload: {
        plan_item: { plan_slug: PLAN, item_id: 'P-001', harness_slug: H },
        fleet_slug: 'a-different-fleet',
      },
    });

    const breakdown = await diagnoseFleetScopeFeatureFamilyExclusions({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(breakdown).toEqual({
      matchedByFilter: 1,
      claimable: 0,
      excluded: { claimFloors: 1, reservedPlanLane: 1, stopTheLine: 0 },
    });
  });

  it('names a stop-the-line-only exclusion in the feature-family breakdown', async () => {
    await seedItem('WI-red-streak', {
      itemKind: 'bug',
      conditionKey: `gate-red-streak:${H}`,
      createdAgoMs: (STOP_THE_LINE_RED_HOURS + 1) * 3_600_000,
    });
    await seedItem('F-plan-one', { sourcePlanSlug: PLAN });
    await seedItem('F-plan-two', { sourcePlanSlug: PLAN });

    const breakdown = await diagnoseFleetScopeFeatureFamilyExclusions({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(breakdown).toEqual({
      matchedByFilter: 2,
      claimable: 0,
      excluded: { claimFloors: 2, reservedPlanLane: 0, stopTheLine: 2 },
    });
  });

  it.each([
    ['rig', { needs_2_machine_rig: true }],
    ['canary', { canary: true }],
    ['claimHold', { _claimHold: true }],
  ] as const)('names %s using the same predicate that excludes the feature, with a ready control', async (name, payload) => {
    await seedItem('WI-gated', { payload });
    await seedItem('WI-ready');
    const scope = planScopeFor('su-member');
    scope.record.spec.view.filter = { field: 'id', op: 'in', value: ['WI-gated', 'WI-ready'] };
    const breakdown = await diagnoseFleetScopeFeatureFamilyExclusions({ scope, harness: H, workspaceId: WS });
    expect(breakdown).toMatchObject({ matchedByFilter: 2, claimable: 1, excluded: { claimFloors: 1, [name]: 1 } });
    expect(Object.entries(breakdown!.excluded).filter(([, count]) => count && count > 0).map(([floor]) => floor).sort())
      .toEqual(['claimFloors', name].sort());
  });

  it.each(['claim-hold', 'peer-claim'] as const)('diagnoses a non-plan feature behind %s without an authoring false alarm', async (floor) => {
    await seedItem('WI-held-feature', floor === 'claim-hold'
      ? { payload: { _claimHold: true } }
      : { takenBy: 'su-peer' });
    // Negative controls exercise both the authored filter and the family boundary.
    await seedItem('WI-p2p-feature');
    await seedItem('EI-held-change', { itemKind: 'change' });
    const scope = planScopeFor('su-member');
    scope.record.spec.view.filter = { all: [
      { field: 'kind', op: '=', value: 'feature' },
      { field: 'id', op: 'in', value: ['WI-held-feature', 'EI-held-change'] },
    ] };
    const featureBreakdown = await diagnoseFleetScopeFeatureFamilyExclusions({ scope, harness: H, workspaceId: WS });
    expect(featureBreakdown).toEqual({
      matchedByFilter: 1, claimable: 0, excluded: { claimFloors: 1, reservedPlanLane: 0, stopTheLine: 0,
        ...(floor === 'claim-hold' ? { claimHold: 1 } : { taken: 1 }) },
    });
    const opts = {
      featureBreakdown,
      issueBreakdown: { matchedByFilter: 0, claimable: 0, excluded: {} } as never,
    };
    const miss = fleetScopedMiss(scope, [], opts);
    expect(miss.reason).toBe('all_matches_gated');
    expect(miss.claimability.population).toMatchObject({
      basis: 'issue+feature-family', matchedByFilter: 1,
      families: { feature: featureBreakdown },
    });
    expect(miss.advice).toContain('Do NOT re-author');
  });

  it('returns 0 (not null) for a plan with no promoted items at all — a genuine drain, not a diagnosis failure', async () => {
    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(0);
  });

  it('excludes an issue-family (bug/change/task) row even when it carries the SAME source_plan_slug — the view boundary', async () => {
    // harness_features_consolidated excludes item_kind IN (bug,change,task) by definition
    // (migration 677) — a bug/change/task row promoted onto the same plan must not inflate
    // the tier-1 count this function reports.
    await seedItem('WI-plan-bug', { itemKind: 'bug', sourcePlanSlug: PLAN });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(0);
  });

  it('excludes an already-CLAIMED feature-family row (taken_by set) — same taken_by-IS-NULL floor tier-1 applies', async () => {
    await seedItem('WI-plan-taken', { sourcePlanSlug: PLAN, takenBy: 'su-other' });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(0);
  });

  it('excludes a row outside the claimable states floor (e.g. status=failing, default states=[open])', async () => {
    await seedItem('WI-plan-failing', { sourcePlanSlug: PLAN, status: 'failing' });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(0);
  });

  it('excludes a DIFFERENT plan\'s feature-family item — the spec filter itself must narrow correctly', async () => {
    await seedItem('WI-other-plan', { sourcePlanSlug: 'some-unrelated-plan' });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(0);
  });

  it('excludes a row in a DIFFERENT workspace even with a matching plan slug', async () => {
    await seedItem('WI-other-ws', { sourcePlanSlug: PLAN, workspaceId: 'other-workspace' });

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope: planScopeFor('su-member'),
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBe(0);
  });

  it('returns null (fails soft) for a spec with no filter at all — nothing to compile, never throws', async () => {
    const scope = planScopeFor('su-member');
    scope.record.spec = { ...scope.record.spec, view: {} };

    const cnt = await diagnoseFleetScopeFeatureFamilyMatch({
      scope,
      harness: H,
      workspaceId: WS,
    });

    expect(cnt).toBeNull();
  });
});

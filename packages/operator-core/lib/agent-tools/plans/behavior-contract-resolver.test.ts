/**
 * P-016 / D-013 — the universal BehaviorContract resolver.
 *
 * The property under test is the one D-013 exists to fix: applicability is owned by
 * BEHAVIOR, not by plan provenance. Before this resolver, the only path from a work
 * item to its clauses ran through the source-plan stamp and read edges scoped to that
 * one plan_slug — so a standalone bug resolved nothing at all, and an edge pointing
 * into another plan's namespace was invisible. Both are pinned below.
 *
 * Every case injects its readers, so these are assertions about the RESOLUTION RULES
 * rather than about Postgres; the store's own SQL is covered by its integration suite.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { WorkItemSpecRevisionEdge } from './spec-evidence-store';
import {
  planStampOf,
  resolveWorkItemBehaviorContract,
  type ResolveBehaviorContractDeps,
} from './behavior-contract-resolver';

const clause = (over: Partial<SpecClauseRevision> = {}): SpecClauseRevision => ({
  planSlug: 'plan-a',
  specId: 'SPEC-1',
  sourceValId: null,
  currentRevision: 1,
  revision: 1,
  planItemId: 'P-001',
  behavior: 'Acknowledged event 42 is not replayed after reconnect.',
  behaviorClass: 'concurrency',
  requiredEvidence: [],
  requiredTestLayers: [],
  mutationRequired: false,
  lifecycleStatus: 'active',
  supersedes: null,
  exemption: null,
  falsifier: null,
  contentHash: 'a'.repeat(64),
  createdBy: 'su-test',
  createdAt: '2026-08-20T00:00:00.000Z',
  acceptedBy: 'su-test',
  acceptedAt: '2026-08-20T00:00:00.000Z',
  acceptanceRef: null,
  ...over,
});

const edge = (over: Partial<WorkItemSpecRevisionEdge> = {}): WorkItemSpecRevisionEdge => ({
  workItemId: 'EI-1',
  planSlug: 'plan-a',
  specId: 'SPEC-1',
  specRevision: 1,
  specFingerprint: 'fp-1',
  ...over,
});

/** Readers that answer from fixed tables, and record how they were called. */
/**
 * ⚠ The return type is `ResolveBehaviorContractDeps`, NOT `as never`, and that is
 * load-bearing rather than tidiness. `as never` made this helper accept any shape at all,
 * so when the resolver grew required fields the mocks silently kept the old shape and the
 * tests exercised a contract production can never produce — the vacuous-pass class. Typed,
 * tsc demands each new dep here the moment it is added.
 *
 * `statusByPlan` defaults every namespace to `active` (enforcing) for the same reason the
 * gate's helper does: a default that quietly exempted plans would make enforcement
 * assertions pass without enforcing anything.
 */
function readers(
  opts: {
    edges?: WorkItemSpecRevisionEdge[];
    clauses?: SpecClauseRevision[];
    statusByPlan?: Record<string, string>;
  } = {},
): ResolveBehaviorContractDeps {
  const listEdges = vi.fn(async () => opts.edges ?? []);
  const listClauses = vi.fn(async (q: { planSlug: string; specIds?: string[]; planItemIds?: string[] }) =>
    (opts.clauses ?? []).filter(
      (c) =>
        c.planSlug === q.planSlug &&
        (!q.specIds || q.specIds.includes(c.specId)) &&
        (!q.planItemIds || q.planItemIds.includes(c.planItemId)),
    ),
  );
  const listPlanStatuses = vi.fn(async ({ planSlugs }: { planSlugs: string[] }) =>
    new Map(planSlugs.map((slug) => [slug, opts.statusByPlan?.[slug] ?? 'active'])),
  );
  return { listEdges, listClauses, listPlanStatuses };
}

describe('resolveWorkItemBehaviorContract — D-013 applicability', () => {
  it('reads edges UNSCOPED by plan, so a standalone item resolves clauses it never had provenance for', async () => {
    const deps = readers({
      edges: [edge({ planSlug: 'someone-elses-plan' })],
      clauses: [clause({ planSlug: 'someone-elses-plan' })],
    });
    // No payload stamp, no sourcePlanSlug: standalone. This returned NOTHING before D-013.
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, deps);

    expect(out.enforceable.map((c) => c.specId)).toEqual(['SPEC-1']);
    expect(out.impact).toMatchObject({ required: true, resolved: true, reason: 'resolved', report: null });
    // The load-bearing call detail: no planSlug was passed to the edge reader.
    const [edgeQuery] = (deps as unknown as { listEdges: { mock: { calls: [Record<string, unknown>][] } } }).listEdges
      .mock.calls[0];
    expect(edgeQuery).not.toHaveProperty('planSlug');
  });

  it('groups edges by plan namespace and marks how each namespace was reached', async () => {
    const deps = readers({
      edges: [edge({ planSlug: 'plan-a' }), edge({ planSlug: 'plan-b', specId: 'SPEC-2' })],
      clauses: [clause({ planSlug: 'plan-a' }), clause({ planSlug: 'plan-b', specId: 'SPEC-2' })],
    });
    const out = await resolveWorkItemBehaviorContract(
      { id: 'EI-1', kind: 'change', harness: 'papercup', sourcePlanSlug: 'plan-a', sourcePlanItemIds: ['P-001'] },
      deps,
    );

    expect(out.groups.map((g) => [g.planSlug, g.via])).toEqual([
      ['plan-a', 'edge+plan-stamp'],
      ['plan-b', 'edge'],
    ]);
    expect(out.enforceable.map((c) => c.specId).sort()).toEqual(['SPEC-1', 'SPEC-2']);
  });

  it('merges plan-item-owned clauses ONLY into the stamped namespace', async () => {
    // SPEC-9 is owned by plan-b's item P-001 but is not named by any edge. Pulling it in
    // would mean one edge drags an unrelated plan's entire contract onto the work item.
    const deps = readers({
      edges: [edge({ planSlug: 'plan-b', specId: 'SPEC-2' })],
      clauses: [
        clause({ planSlug: 'plan-b', specId: 'SPEC-2' }),
        clause({ planSlug: 'plan-b', specId: 'SPEC-9', planItemId: 'P-001' }),
      ],
    });
    const out = await resolveWorkItemBehaviorContract(
      { id: 'EI-1', kind: 'bug', harness: 'papercup', sourcePlanItemIds: ['P-001'] },
      deps,
    );
    expect(out.enforceable.map((c) => c.specId)).toEqual(['SPEC-2']);
  });

  it('keeps the back-compat leg: a stamped plan with no edges still contributes its item clauses', async () => {
    const deps = readers({ edges: [], clauses: [clause({ planSlug: 'plan-a', planItemId: 'P-007' })] });
    const out = await resolveWorkItemBehaviorContract(
      { id: 'EI-1', kind: 'bug', harness: 'papercup', sourcePlanSlug: 'plan-a', sourcePlanItemIds: ['P-007'] },
      deps,
    );
    expect(out.groups.map((g) => g.via)).toEqual(['plan-stamp']);
    expect(out.enforceable.map((c) => c.specId)).toEqual(['SPEC-1']);
  });

  it('reports an edge pinned to a superseded revision instead of silently dropping it', async () => {
    const deps = readers({
      edges: [edge({ specRevision: 1 })],
      clauses: [clause({ revision: 3, currentRevision: 3 })],
    });
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, deps);
    expect(out.groups[0].staleEdges).toEqual([{ specId: 'SPEC-1', edgeRevision: 1, currentRevision: 3 }]);
  });

  // EI-25255610125482108: edges are append-only, so an item re-bound to the current
  // revision keeps every superseded edge as a row. Judging rows instead of specs reported
  // those as stale although the item IS bound to the current revision.
  it('does not report a superseded edge when the same spec also has an edge at the current revision', async () => {
    const deps = readers({
      edges: [edge({ specRevision: 1 }), edge({ specRevision: 2 }), edge({ specRevision: 3 })],
      clauses: [clause({ revision: 3, currentRevision: 3 })],
    });
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, deps);
    expect(out.groups[0].staleEdges).toEqual([]);
  });

  it('reports a genuinely stale spec once, at its newest edge, regardless of edge order', async () => {
    const deps = readers({
      edges: [edge({ specRevision: 2 }), edge({ specRevision: 1 })],
      clauses: [clause({ revision: 3, currentRevision: 3 })],
    });
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, deps);
    expect(out.groups[0].staleEdges).toEqual([{ specId: 'SPEC-1', edgeRevision: 2, currentRevision: 3 }]);
  });

  it('counts only accepted/active clauses as enforceable', async () => {
    const deps = readers({
      edges: [edge({ specId: 'SPEC-D' })],
      clauses: [clause({ specId: 'SPEC-D', lifecycleStatus: 'draft' })],
    });
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, deps);
    expect(out.groups[0].clauses).toHaveLength(1);
    expect(out.enforceable).toHaveLength(0);
    expect(out.impact).toMatchObject({ required: true, resolved: false, reason: 'unresolved' });
  });
});

describe('resolveWorkItemBehaviorContract — impact reporting', () => {
  it('REPORTS an unresolved behavior-changing item, and never refuses', async () => {
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, readers());
    expect(out.impact).toMatchObject({ required: true, resolved: false, reason: 'unresolved' });
    expect(out.impact.report).toContain('EI-1');
    expect(out.impact.report).toContain('no source plan');
    expect(out.impact.report).toContain('adhoc-work-item-specs');
    expect(out.impact.report).toContain('plans:set-specs');
    expect(out.impact.report).toContain('omitting `slug`');
    expect(out.impact.report).toContain('plans:bind-spec-evidence');
    expect(out.impact.report).not.toContain('plans:set-spec-evidence');
    // The advisory boundary D-013 draws between P-016 and P-013 must survive refactors:
    // if this ever reads as a refusal, enforcement has leaked a plan item early.
    expect(out.impact.report).toContain('Reported, not enforced');
  });

  // EI-23787801255099066: the ad-hoc advice named only the argument to OMIT (`slug`) and
  // stayed silent on `planItemId`, which `plans:set-specs` REQUIRES and which a planless
  // caller has no plan to take one from. Naming it is what makes the advice followable.
  it('names the planItemId plans:set-specs requires, as a literal derived from the item', async () => {
    const out = await resolveWorkItemBehaviorContract(
      { id: 'EI-23787801255099066', kind: 'bug', harness: 'papercup' },
      readers(),
    );
    expect(out.impact.report).toContain("planItemId: 'P-23787801255099066'");
    // Still the advice it was before — naming the new argument must not drop the old one.
    expect(out.impact.report).toContain('omitting `slug`');
  });

  // EI-23820598120293502: the advice named both verbs and the arg to omit but not what either
  // verb REQUIRES, which cost a closer five corrective round-trips (a one-item array under
  // `spec`; `revision` vs `specRevision`; loose args instead of a `binding` object). Pin the
  // structural facts, not the enum lists, so the advice cannot drift back to naming only verbs.
  it('names the wrapper key and required keys of both verbs, not just their names', async () => {
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, readers());
    const report = out.impact.report ?? '';
    expect(report).toContain('ONE object under `spec` (not an array)');
    for (const key of ['specId', 'expectedRevision', 'planItemId', 'behavior', 'behaviorClass', 'lifecycleStatus']) {
      expect(report).toContain(key);
    }
    expect(report).toContain('ONE object under `binding`');
    for (const key of ['workItemId', 'specRevision', 'evidenceKind', 'evidenceRef']) {
      expect(report).toContain(key);
    }
    // Measured live while re-binding a sibling clause: a binding without `measurement.schemaVersion`
    // is refused ("expected 1"), and the plain binding schema requires exactly one of
    // measurement / sourceFingerprint — neither was named before.
    expect(report).toContain('schemaVersion: 1');
    expect(report).toContain('sourceFingerprint');
    // The ledger form is the alternative shape; naming only the plain one would mislead a
    // closer who already holds a test_runs row.
    expect(report).toContain('fromTestRun');
    expect(report).toContain('tools:find');
  });

  it('does not state the shapes when the item HAS a source plan (the remedy there is different)', async () => {
    // The stamped branch tells the closer to link/promote against an existing clause on its
    // own plan; the ad-hoc-scope shape advice would be wrong there.
    const out = await resolveWorkItemBehaviorContract(
      { id: 'EI-1', kind: 'bug', harness: 'papercup', sourcePlanSlug: 'some-plan', sourcePlanItemIds: ['P-001'] },
      readers(),
    );
    const report = out.impact.report;
    // Positive control: the report exists and IS the stamped-branch remedy. Without this the
    // negative assertion below would also pass if the item resolved no report at all.
    expect(report).toContain('link one with plans:bind-spec-evidence');
    expect(report).not.toContain('ONE object under `spec`');
  });

  it('falls back to the required SHAPE rather than naming a planItemId the write would reject', async () => {
    // `EI-1` derives `P-1`, which fails `plan_spec_clause_revisions_plan_item_id_check`
    // (`^P-[0-9]{3,}$`). The advice must still NAME the argument without inventing a value
    // the very next call would refuse — advice that is confidently wrong is worse than
    // advice that is merely incomplete.
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind: 'bug', harness: 'papercup' }, readers());
    expect(out.impact.report).toContain('planItemId');
    expect(out.impact.report).not.toMatch(/planItemId: 'P-\d/);
  });

  it.each([['task'], ['feature'], [undefined]])('does not require impact resolution for kind=%s', async (kind) => {
    const out = await resolveWorkItemBehaviorContract({ id: 'EI-1', kind, harness: 'papercup' }, readers());
    expect(out.impact).toMatchObject({ required: false, report: null, reason: 'non-behavior-changing' });
  });

  it('never makes an observation-lane item enforceable, even when it is a bug with clauses', async () => {
    // D-012: observations and unpromoted ideas are candidate inputs until promotion.
    const deps = readers({ edges: [edge()], clauses: [clause()] });
    const out = await resolveWorkItemBehaviorContract(
      { id: 'EI-1', kind: 'bug', lane: 'observation', harness: 'papercup' },
      deps,
    );
    expect(out.impact).toMatchObject({ required: false, report: null, reason: 'observation-lane' });
    // It still RESOLVES its clauses — non-enforceable is not the same as invisible.
    expect(out.enforceable).toHaveLength(1);
  });
});

describe('planStampOf', () => {
  it('prefers the payload stamp and unions its item id with sourcePlanItemIds', () => {
    expect(
      planStampOf({
        id: 'EI-1',
        harness: 'fallback',
        payload: { plan_item: { plan_slug: 'stamped', item_id: 'P-002', harness_slug: 'stamped-harness' } },
        sourcePlanSlug: 'ignored',
        sourcePlanItemIds: ['P-003', 'not-an-item'],
      }),
    ).toEqual({ planSlug: 'stamped', harnessSlug: 'stamped-harness', planItemIds: ['P-002', 'P-003'] });
  });

  it('is null for a standalone item — which is now a resolvable state, not a dead end', () => {
    expect(planStampOf({ id: 'EI-1', harness: 'papercup' })).toBeNull();
  });
});

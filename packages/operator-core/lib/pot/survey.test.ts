/**
 * Unit tests for the Mug's plan-aware survey (mug-autonomous-execution B-08:
 * P-010 plan consumption + the P-012 member-harness fix). The PG reads are
 * injected, so the membership resolution, candidate builders, and the
 * home-only-blind-spot guard test with no database. The real cross-member SQL
 * is pinned by survey.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlanIndexRow } from '../agent-tools/plans/source';
import {
  buildPlanItemBlockGraph,
  filterReadyFrontier,
  frontierInEligiblePlans,
  notStopped,
  frontierRowToCandidate,
  POT_SURVEY_PLAN_READ_CONCURRENCY,
  planToCandidate,
  resolvePotMembership,
  surveyPot,
  surveyWorkspace,
  type FrontierRow,
  type HarnessBlockGraph,
  type PlanItemBlockGraph,
  type SurveyDeps,
} from './survey';

const NOW = 1_000_000_000_000;
const daysAgo = (d: number) => NOW - d * 86_400_000;

function planRow(over: Partial<PlanIndexRow>): PlanIndexRow {
  return {
    planSlug: 'p',
    harnessSlug: 'h',
    title: 'A plan',
    status: 'active',
    opStatus: 'started',
    opStartedAt: null,
    opUpdatedAt: new Date(daysAgo(1)).toISOString(),
    opPriority: null,
    currentWave: null,
    updatedAt: new Date(daysAgo(1)).toISOString(),
    archived: false,
    isLegacy: false,
    created: null,
    updated: null,
    owner: null,
    supersedes: [],
    supersededBy: null,
    contentHash: 'x',
    version: 1,
    items: [],
    decisions: [],
    nowState: null,
    nowNext: null,
    ...over,
  } as unknown as PlanIndexRow;
}

const frontierRow = (over: Partial<FrontierRow>): FrontierRow => ({
  feature_id: 'WI-1',
  harness_slug: 'h',
  title: 'an item',
  item_kind: 'feature',
  created_ts: daysAgo(1),
  feature_order: null,
  plan_slug: null,
  ...over,
});

describe('resolvePotMembership (P-012)', () => {
  it('resolves member harnesses from the registry hive_slug, home first, members listed', async () => {
    const m = await resolvePotMembership('default', 'papercup-pot', async () => ({
      projects: [
        { slug: 'papercup', hive_slug: 'papercup-pot' },
        { slug: 'restart', hive_slug: 'papercup-pot' },
        { slug: 'other', hive_slug: 'other-pot' },
        { slug: 'papercup-pot' }, // the home seat itself — not a member
      ],
    }));
    expect(m.members.sort()).toEqual(['papercup', 'restart']);
    expect(m.surveySlugs).toEqual(['papercup-pot', 'papercup', 'restart']);
    expect(m.scope).toBe('members');
  });

  it('falls back to a WORKSPACE-WIDE survey when no member is wired (the home-only-blind-spot guard)', async () => {
    const m = await resolvePotMembership('default', 'papercup-pot', async () => ({
      projects: [{ slug: 'papercup-pot' }, { slug: 'papercup' }], // nobody points at the pot
    }));
    expect(m.members).toEqual([]);
    expect(m.surveySlugs).toEqual([]); // [] ⇒ survey workspace-wide, never home-only
    expect(m.scope).toBe('workspace');
  });
});

describe('planToCandidate (P-010)', () => {
  it('maps a STARTED plan: hottest-open importance, needs-human → escalations, todo+wip → openItems', () => {
    const c = planToCandidate(
      planRow({
        planSlug: 'mug-plan',
        harnessSlug: 'papercup',
        opPriority: 3,
        items: [
          { id: 'P-001', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-002', status: 'wip', text: '', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-003', status: 'needs-human', text: '', importance: 'urgent', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-004', status: 'done', text: '', importance: 'urgent', blockedBy: [], decisionRefs: [], phase: null },
        ],
      }),
      NOW,
    )!;
    expect(c.view).toBe('plan');
    expect(c.id).toBe('mug-plan');
    expect(c.harness).toBe('papercup');
    expect(c.importance).toBe('urgent'); // hottest OPEN item (P-003), done urgent excluded counts too but it's open anyway
    expect(c.openItems).toBe(2); // todo + wip
    expect(c.escalations).toBe(1); // needs-human
    expect(c.opPriority).toBe(3);
  });

  it('returns null for a plan that is not operationally started (paused / done / terminal)', () => {
    expect(planToCandidate(planRow({ opStatus: 'paused' }), NOW)).toBeNull();
    expect(planToCandidate(planRow({ opStatus: 'done' }), NOW)).toBeNull();
    expect(planToCandidate(planRow({ opStatus: null }), NOW)).toBeNull();
    // terminal lifecycle reconciles a stale started row to done → null
    expect(planToCandidate(planRow({ opStatus: 'started', status: 'shipped' }), NOW)).toBeNull();
  });

  it('SURFACES an unstarted eligible plan when includeUnstarted (needsStart); excludes terminal even then (P-B1)', () => {
    // unstarted + active + eligible ⇒ surfaced, flagged needsStart (the self-feed)
    const surfaced = planToCandidate(planRow({ opStatus: null, status: 'active' }), NOW, { includeUnstarted: true });
    expect(surfaced).not.toBeNull();
    expect(surfaced!.needsStart).toBe(true);
    // a STARTED plan is never flagged needsStart, even with includeUnstarted
    expect(planToCandidate(planRow({ opStatus: 'started' }), NOW, { includeUnstarted: true })!.needsStart).toBeUndefined();
    // terminal (shipped/superseded) is excluded even when eligible
    expect(planToCandidate(planRow({ opStatus: null, status: 'shipped' }), NOW, { includeUnstarted: true })).toBeNull();
    expect(planToCandidate(planRow({ opStatus: null, status: 'superseded' }), NOW, { includeUnstarted: true })).toBeNull();
    // without includeUnstarted, an unstarted plan stays invisible (default behaviour)
    expect(planToCandidate(planRow({ opStatus: null, status: 'active' }), NOW)).toBeNull();
  });

  it("defaults a started plan with no open items to 'normal' importance", () => {
    const c = planToCandidate(planRow({ items: [] }), NOW)!;
    expect(c.importance).toBe('normal');
    expect(c.openItems).toBe(0);
  });
});

describe('frontierRowToCandidate', () => {
  it('maps an unplaced work-item row, importance normal, op_priority from feature_order', () => {
    const c = frontierRowToCandidate(frontierRow({ feature_id: 'WI-9', harness_slug: 'papercup', feature_order: 7 }), NOW);
    expect(c).toMatchObject({ id: 'WI-9', view: 'work-item', harness: 'papercup', importance: 'normal', opPriority: 7 });
    expect(c.ageDays).toBeCloseTo(1, 5);
  });

  // EI-12275: a frontier row's severity (issue-family rows only) must carry through
  // to the candidate so the ranker's blocking-impact feature actually scores it —
  // previously every frontier candidate scored severity=0 unconditionally.
  it('carries severity onto the candidate when the row has one (EI-12275)', () => {
    const c = frontierRowToCandidate(
      frontierRow({ feature_id: 'EI-1', harness_slug: 'papercup', item_kind: 'bug', severity: 'major' }),
      NOW,
    );
    expect(c.severity).toBe('major');
  });

  it('omits severity when the row has none (ordinary feature rows)', () => {
    const c = frontierRowToCandidate(frontierRow({ feature_id: 'WI-9', harness_slug: 'papercup' }), NOW);
    expect(c.severity).toBeUndefined();
  });
});

describe('buildPlanItemBlockGraph (EI-12372)', () => {
  it('builds a mapping of plan-item blockedBy dependencies and statuses', () => {
    const rows = [
      planRow({
        planSlug: 'P-main',
        harnessSlug: 'h1',
        items: [
          { id: 'P-001', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null },
          { id: 'P-002', status: 'todo', text: '', importance: 'high', blockedBy: ['P-001'], decisionRefs: [], phase: null },
          { id: 'P-003', status: 'wip', text: '', importance: 'high', blockedBy: ['P-001', 'P-002'], decisionRefs: [], phase: null },
        ],
      }),
    ];

    const graph = buildPlanItemBlockGraph([rows]);

    expect(graph.planItemBlockers.get('P-main')?.get('P-001')).toEqual([]);
    expect(graph.planItemBlockers.get('P-main')?.get('P-002')).toEqual(['P-001']);
    expect(graph.planItemBlockers.get('P-main')?.get('P-003')).toEqual(['P-001', 'P-002']);

    // Blocker statuses are recorded for terminal resolution
    expect(graph.planItemStatuses.get('P-main')?.get('P-001')).toBe('todo');
    expect(graph.planItemStatuses.get('P-main')?.get('P-002')).toBe('todo');
  });

  it('handles multiple plans in the graph', () => {
    const rows = [
      planRow({
        planSlug: 'P-plan-a',
        harnessSlug: 'h1',
        items: [{ id: 'P-A1', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null }],
      }),
      planRow({
        planSlug: 'P-plan-b',
        harnessSlug: 'h2',
        items: [{ id: 'P-B1', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null }],
      }),
    ];

    const graph = buildPlanItemBlockGraph([rows]);

    expect(graph.planItemBlockers.has('P-plan-a')).toBe(true);
    expect(graph.planItemBlockers.has('P-plan-b')).toBe(true);
    expect(graph.planItemBlockers.get('P-plan-a')?.get('P-A1')).toEqual([]);
    expect(graph.planItemBlockers.get('P-plan-b')?.get('P-B1')).toEqual([]);
  });
});

describe('surveyPot (P-012 regression)', () => {
  const noBlockers: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };
  const depsFor = (over: Partial<SurveyDeps>): Partial<SurveyDeps> => ({
    now: () => NOW,
    fetchBlockGraph: async () => noBlockers,
    fetchReconcile: async () => ({ rows: [], total: 0 }),
    fetchQuarantinedCount: async () => 0,
    fetchEscalatedIssues: async () => [],
    ...over,
  });

  it('surfaces a MEMBER harness work-item even though the home seat is empty (the 2026-06-11 bug)', async () => {
    const calls: { planSlugs: string[]; frontierScope: readonly string[] } = { planSlugs: [], frontierScope: [] };
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }, { slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) => {
          calls.planSlugs.push(slug);
          // The home seat has no started plan; the member does.
          return slug === 'papercup'
            ? [planRow({ planSlug: 'member-plan', harnessSlug: 'papercup', items: [{ id: 'P-1', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null }] })]
            : [];
        },
        fetchFrontier: async (surveySlugs) => {
          calls.frontierScope = surveySlugs;
          // a freshly-filed member work-item — the thing the buggy home-only survey slept through
          return [frontierRow({ feature_id: 'WI-MEMBER', harness_slug: 'papercup' })];
        },
      }),
    });

    // The member's started plan AND its unplaced work-item BOTH surface.
    expect(survey.frontier.map((c) => c.id)).toContain('WI-MEMBER');
    expect(survey.plans.map((c) => c.id)).toContain('member-plan');
    // It surveyed the member, not just the home seat.
    expect(calls.planSlugs).toContain('papercup');
    expect(calls.frontierScope).toEqual(['papercup-pot', 'papercup']);
    expect(survey.scope).toBe('members');
  });

  it('dedups a plan surfaced under MULTIPLE survey slugs — a member slug resolving to the same underlying plan set must not double-count it (EI-18669294545467516)', async () => {
    // Reproduces the real-world mechanism: a member harness slug (e.g. a
    // hive-canary member) resolves upstream to its hive's HOME plan set, so
    // listPlanRows returns the identical row for both the home slug and the
    // member slug. Without a dedup keyed on plan identity, the flatten would
    // push the SAME plan twice — inflating both survey.plans.length and
    // counts.plans, and handing the placement ranker a duplicated candidate.
    const dupRow = planRow({ planSlug: 'shared-plan', harnessSlug: 'papercup' });
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({
          projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }, { slug: 'papercup-pot' }],
        }),
        // Every survey slug resolves to the SAME plan row (byte-identical
        // planSlug + harnessSlug) — the exact shape observed live.
        listPlanRows: async () => [dupRow],
        fetchFrontier: async () => [],
      }),
    });

    const shared = survey.plans.filter((c) => c.id === 'shared-plan');
    expect(shared).toHaveLength(1);
    expect(survey.plans).toHaveLength(1);
  });

  it('runs a workspace-wide survey (frontier scope []) when membership is not wired', async () => {
    let frontierScope: readonly string[] | null = null;
    const planSlugs: string[] = [];
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({
          projects: [
            { slug: 'papercup-pot', harness_kind: 'hive' },
            { slug: 'other-pot', harness_kind: 'hive' },
            { slug: 'ordinary-project' },
          ],
        }),
        listPlanRows: async (slug) => {
          planSlugs.push(slug);
          return [];
        },
        fetchFrontier: async (surveySlugs) => {
          frontierScope = surveySlugs;
          return [];
        },
      }),
    });
    expect(frontierScope).toEqual([]); // [] ⇒ workspace-wide, never home-only
    expect(planSlugs.sort()).toEqual(['other-pot', 'papercup-pot']);
    expect(survey.scope).toBe('workspace');
  });

  it('bounds per-harness plan reads below the org-app pool width (EI-20211235356451610)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const members = Array.from({ length: 24 }, (_, i) => ({
      slug: `member-${i}`,
      hive_slug: 'papercup-pot',
    }));

    await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup-pot' }, ...members] }),
        listPlanRows: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          inFlight -= 1;
          return [];
        },
        fetchFrontier: async () => [],
      }),
    });

    expect(maxInFlight).toBe(POT_SURVEY_PLAN_READ_CONCURRENCY);
    expect(maxInFlight).toBeLessThan(8);
  });

  it('extraSurveySlugs UNIONs started hives into a members-wired scope (owner model 2026-07-01: the Mug works ANY started pot)', async () => {
    // The home pot HAS members wired — before this, the survey narrowed to
    // home+members and every OTHER started pot's work was invisible to her.
    const calls: { planSlugs: string[]; frontierScope: readonly string[] } = { planSlugs: [], frontierScope: [] };
    const survey = await surveyPot('default', 'papercup-pot', {
      extraSurveySlugs: ['other-started-pot', 'papercup'], // 'papercup' dedupes with the member
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }, { slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) => {
          calls.planSlugs.push(slug);
          return [];
        },
        fetchFrontier: async (surveySlugs) => {
          calls.frontierScope = surveySlugs;
          return [frontierRow({ feature_id: 'WI-OTHER', harness_slug: 'other-started-pot' })];
        },
      }),
    });
    expect(calls.frontierScope).toEqual(['papercup-pot', 'papercup', 'other-started-pot']); // union, deduped
    expect(calls.planSlugs).toContain('other-started-pot'); // plans read from the started pot too
    expect(survey.frontier.map((c) => c.id)).toContain('WI-OTHER');
  });

  it('extraSurveySlugs is a NO-OP on a workspace-wide scope (already covers every started pot)', async () => {
    let frontierScope: readonly string[] | null = null;
    await surveyPot('default', 'papercup-pot', {
      extraSurveySlugs: ['x-pot'],
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup-pot', harness_kind: 'hive' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async (surveySlugs) => {
          frontierScope = surveySlugs;
          return [];
        },
      }),
    });
    expect(frontierScope).toEqual([]); // stays workspace-wide — the union never NARROWS
  });

  it('ranks both views through the one ranker (urgent member plan leads its view)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({ planSlug: 'low-plan', harnessSlug: 'papercup', items: [{ id: 'a', status: 'todo', text: '', importance: 'low', blockedBy: [], decisionRefs: [], phase: null }] }),
                planRow({ planSlug: 'urgent-plan', harnessSlug: 'papercup', items: [{ id: 'b', status: 'todo', text: '', importance: 'urgent', blockedBy: [], decisionRefs: [], phase: null }] }),
              ]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    expect(survey.plans[0].id).toBe('urgent-plan');
    expect(survey.plans[0].rank.score).toBeGreaterThan(survey.plans[1].rank.score);
  });

  // ── blocked_by readiness (W-01 / P-010) ──────────────────────────────────
  it('holds back a frontier lane whose blocker is still in flight, surfaces it once the blocker passes', async () => {
    const common = {
      loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
      listPlanRows: async () => [],
    };

    // Phase 1 — tier1 (WI-1) + tier2 (WI-2, blocked_by WI-1) are both unplaced
    // todo lanes; WI-1 is in flight (todo), so WI-2 is held back.
    const blocked = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        ...common,
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' }),
          frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup' }),
        ],
        fetchBlockGraph: async () => ({ blockers: new Map([['WI-2', ['WI-1']]]), statuses: new Map([['WI-1', 'todo']]) }),
      }),
    });
    expect(blocked.frontier.map((c) => c.id)).toEqual(['WI-1']);
    expect(blocked.frontierBlocked).toBe(1);

    // Phase 2 — WI-1 has passed, so it drops out of the todo frontier; WI-2's
    // blocker is now terminal (resolved via the block-graph statuses) → it surfaces.
    const ready = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        ...common,
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup' })],
        fetchBlockGraph: async () => ({ blockers: new Map([['WI-2', ['WI-1']]]), statuses: new Map([['WI-1', 'passed']]) }),
      }),
    });
    expect(ready.frontier.map((c) => c.id)).toEqual(['WI-2']);
    expect(ready.frontierBlocked).toBe(0);
  });

  // ── scopeFilter: pause + scope enforcement (mug-steering-panel C-2 / P-003) ──
  const planItem = (id: string) => ({ id, status: 'todo' as const, text: '', importance: 'high' as const, blockedBy: [], decisionRefs: [], phase: null });

  it('pauseNewWork empties the FRONTIER (no new work) but keeps started-plan momentum', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { pauseNewWork: true },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup' ? [planRow({ planSlug: 'p1', harnessSlug: 'papercup', items: [planItem('a')] })] : [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' })],
      }),
    });
    expect(survey.frontier).toEqual([]); // new unplaced work withheld while paused
    expect(survey.plans.map((c) => c.id)).toContain('p1'); // existing plan momentum continues
  });

  it('pausedUntil empties the frontier while now < pausedUntil, restores it once expired', async () => {
    const mkDeps = () =>
      depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' })],
      });
    const paused = await surveyPot('default', 'papercup-pot', { scopeFilter: { pausedUntil: NOW + 60_000 }, deps: mkDeps() });
    expect(paused.frontier).toEqual([]);
    const resumed = await surveyPot('default', 'papercup-pot', { scopeFilter: { pausedUntil: NOW - 1 }, deps: mkDeps() });
    expect(resumed.frontier.map((c) => c.id)).toContain('WI-1');
  });

  it('allowedHarnesses restricts the frontier to the allowed harness(es)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { allowedHarnesses: ['papercup'] },
      deps: depsFor({
        loadRegistry: async () => ({
          projects: [
            { slug: 'papercup', hive_slug: 'papercup-pot' },
            { slug: 'other', hive_slug: 'papercup-pot' },
          ],
        }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-IN', harness_slug: 'papercup' }),
          frontierRow({ feature_id: 'WI-OUT', harness_slug: 'other' }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-IN');
    expect(ids).not.toContain('WI-OUT');
  });

  it('eligiblePlans restricts the PLAN view to the eligible plan slug(s)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { eligiblePlans: ['keep-plan'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({ planSlug: 'keep-plan', harnessSlug: 'papercup', items: [planItem('a')] }),
                planRow({ planSlug: 'drop-plan', harnessSlug: 'papercup', items: [planItem('b')] }),
              ]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    const ids = survey.plans.map((c) => c.id);
    expect(ids).toContain('keep-plan');
    expect(ids).not.toContain('drop-plan');
  });

  // ── eligiblePlans HARD-filters PLAN-TIED frontier rows; loose work is a SEPARATE
  //    owner toggle (mug-steering-panel P-008; decoupled 2026-06-30) ──
  it('eligiblePlans scopes plan-tied frontier rows; loose (unplanned) work is KEPT by default', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { eligiblePlans: ['keep-plan'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-KEEP', harness_slug: 'papercup', plan_slug: 'keep-plan' }),
          frontierRow({ feature_id: 'WI-DROP', harness_slug: 'papercup', plan_slug: 'other-plan' }),
          frontierRow({ feature_id: 'WI-UNPLANNED', harness_slug: 'papercup', plan_slug: null }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-KEEP'); // minted from the eligible plan
    expect(ids).toContain('WI-UNPLANNED'); // loose work kept by default (includeUnplannedWork undefined ⇒ true)
    expect(ids).not.toContain('WI-DROP'); // minted from a non-eligible plan → dropped at the source
  });

  it('includeUnplannedWork:false drops loose frontier rows while keeping eligible-plan rows', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { eligiblePlans: ['keep-plan'], includeUnplannedWork: false },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-KEEP', harness_slug: 'papercup', plan_slug: 'keep-plan' }),
          frontierRow({ feature_id: 'WI-UNPLANNED', harness_slug: 'papercup', plan_slug: null }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-KEEP');
    expect(ids).not.toContain('WI-UNPLANNED'); // loose work turned off
  });

  it('stoppedHarnesses withholds a STOPPED pot\'s frontier work, keeps others (stop-list)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { stoppedHarnesses: ['stopped-harness'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [
          { slug: 'papercup', hive_slug: 'papercup-pot' },
          { slug: 'stopped-harness', hive_slug: 'papercup-pot' },
        ] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-LIVE', harness_slug: 'papercup', plan_slug: null }),
          frontierRow({ feature_id: 'WI-OFF', harness_slug: 'stopped-harness', plan_slug: null }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-LIVE'); // a not-stopped harness still places
    expect(ids).not.toContain('WI-OFF'); // the stopped harness is withheld
  });

  it('no eligiblePlans restriction keeps every frontier row regardless of source plan (P-008 no-op)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: {},
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup', plan_slug: 'any-plan' }),
          frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup', plan_slug: null }),
        ],
      }),
    });
    expect(survey.frontier.map((c) => c.id).sort()).toEqual(['WI-1', 'WI-2']);
  });

  it('an empty/absent scopeFilter is a no-op (full survey)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: {},
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup' })],
      }),
    });
    expect(survey.frontier.map((c) => c.id)).toContain('WI-1');
  });

  // ── WI-4563: an empty frontier must be DIAGNOSABLE. Surface the admission-
  //    withheld (quarantined) count so `frontier: []` reads as deadlock-vs-idle,
  //    never a mysterious read-path bug for 14+ consecutive Mug wakes. ──
  it('surfaces frontierQuarantined from the admission-count dep (WI-4563)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-OK', harness_slug: 'papercup' })],
        fetchQuarantinedCount: async () => 7,
      }),
    });
    expect(survey.frontierQuarantined).toBe(7);
  });

  it('an EMPTY frontier carries the quarantined count — the admission DEADLOCK is legible, not a silent read-path bug (WI-4563)', async () => {
    // The exact 2026-07-13 production shape: the pot's only placeable-SHAPED work
    // is federated remote items, all withheld by the G2 admission gate, so the
    // frontier is [] AND frontierQuarantined > 0. Before this the survey returned
    // an empty frontier with no way to tell "no work" from "work I can't touch".
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [], // every candidate withheld by admission
        fetchQuarantinedCount: async () => 10,
      }),
    });
    expect(survey.frontier).toEqual([]);
    expect(survey.frontierQuarantined).toBe(10); // the deadlock is visible, not silent
  });

  // ── EI-13695: the false-fresh class — attempted items whose dead cup's
  //    checkpoint survives are RECONCILE work, surfaced with checkpoint heads,
  //    never silently absent (nor silently fresh). ──
  it('surfaces the reconcile slice (count + rows with checkpoint heads) from the fetchReconcile dep (EI-13695)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-FRESH', harness_slug: 'papercup' })],
        fetchReconcile: async () => ({
          rows: [
            {
              feature_id: 'WI-5132',
              harness_slug: 'papercup',
              title: 'finished but un-converged',
              item_kind: 'feature',
              checkpoint_head: '## WI-5132 COMPLETED — VERIFIED COMPLETE',
              checkpoint_updated_ts: NOW - 60_000,
            },
          ],
          total: 2,
        }),
      }),
    });
    // The reconcile item is NOT in the fresh frontier (the fetch already excludes
    // it — this asserts the survey does not resurrect it) …
    expect(survey.frontier.map((c) => c.id)).toEqual(['WI-FRESH']);
    // … and IS legible with its checkpoint head + un-capped total.
    expect(survey.frontierReconcile).toBe(2);
    expect(survey.reconcileRows.map((r) => r.feature_id)).toEqual(['WI-5132']);
    expect(survey.reconcileRows[0].checkpoint_head).toContain('COMPLETED');
  });

  it('a reconcile-read failure is fail-open — empty slice, survey intact (EI-13695)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-OK', harness_slug: 'papercup' })],
        // The DEFAULT dep fail-opens internally; an injected dep that throws would
        // reject the survey's Promise.all — assert the default-shaped contract by
        // returning the fail-open value, and that the survey threads it verbatim.
        fetchReconcile: async () => ({ rows: [], total: 0 }),
      }),
    });
    expect(survey.frontier.map((c) => c.id)).toEqual(['WI-OK']);
    expect(survey.frontierReconcile).toBe(0);
    expect(survey.reconcileRows).toEqual([]);
  });

  it('passes the SAME surveySlugs to the quarantine count as to the frontier fetch (WI-4563)', async () => {
    let frontierScope: readonly string[] | null = null;
    let quarantineScope: readonly string[] | null = null;
    await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async (slugs) => { frontierScope = slugs; return []; },
        fetchQuarantinedCount: async (slugs) => { quarantineScope = slugs; return 0; },
      }),
    });
    expect(quarantineScope).toEqual(['papercup-pot', 'papercup']);
    expect(quarantineScope).toEqual(frontierScope); // never a scope-mismatch blind spot between the two reads
  });

  // ── self-feed: eligiblePlans SURFACES unstarted eligible plans (mug-autonomy-and-selffeed C-1 / P-B1) ──
  it('eligiblePlans surfaces an active-but-UNSTARTED plan (self-feed, needsStart)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { eligiblePlans: ['unstarted-eligible'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [planRow({ planSlug: 'unstarted-eligible', harnessSlug: 'papercup', opStatus: null, status: 'active', items: [planItem('a')] })]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    const plan = survey.plans.find((c) => c.id === 'unstarted-eligible');
    expect(plan).toBeDefined();
    expect(plan!.needsStart).toBe(true);
  });

  it('an UN-STEERED survey does NOT surface an unstarted plan (invariant a — only started plans show)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup' ? [planRow({ planSlug: 'unstarted', harnessSlug: 'papercup', opStatus: null, status: 'active', items: [planItem('a')] })] : [],
        fetchFrontier: async () => [],
      }),
    });
    expect(survey.plans.map((c) => c.id)).not.toContain('unstarted');
  });

  it('a TERMINAL plan in eligiblePlans is NOT surfaced', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { eligiblePlans: ['shipped-plan'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup' ? [planRow({ planSlug: 'shipped-plan', harnessSlug: 'papercup', opStatus: null, status: 'shipped', items: [planItem('a')] })] : [],
        fetchFrontier: async () => [],
      }),
    });
    expect(survey.plans.map((c) => c.id)).not.toContain('shipped-plan');
  });

  it('a STARTED plan NOT in eligiblePlans stays filtered out (invariant b)', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      scopeFilter: { eligiblePlans: ['keep'] },
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({ planSlug: 'keep', harnessSlug: 'papercup', opStatus: 'started', items: [planItem('a')] }),
                planRow({ planSlug: 'other-started', harnessSlug: 'papercup', opStatus: 'started', items: [planItem('b')] }),
              ]
            : [],
        fetchFrontier: async () => [],
      }),
    });
    const ids = survey.plans.map((c) => c.id);
    expect(ids).toContain('keep');
    expect(ids).not.toContain('other-started');
  });
});

describe('filterReadyFrontier (W-01 / P-010 — the shared readiness, pure)', () => {
  const row = (id: string, harness = 'h'): FrontierRow => frontierRow({ feature_id: id, harness_slug: harness });

  it('keeps every row when a harness has no blockers', () => {
    const { ready, blockedCount } = filterReadyFrontier([row('A'), row('B')], new Map());
    expect(ready.map((r) => r.feature_id)).toEqual(['A', 'B']);
    expect(blockedCount).toBe(0);
  });

  it('drops a lane with a non-terminal blocker, keeps one whose blocker is absent or passed', () => {
    const graph: HarnessBlockGraph = {
      blockers: new Map([['blocked', ['mid']], ['gone', ['ghost']], ['done-dep', ['fin']]]),
      statuses: new Map([['mid', 'wip'], ['fin', 'passed']]), // 'ghost' unresolved ⇒ absent ⇒ satisfied
    };
    const { ready, blockedCount } = filterReadyFrontier(
      [row('blocked'), row('gone'), row('done-dep'), row('free')],
      new Map([['h', graph]]),
    );
    expect(ready.map((r) => r.feature_id).sort()).toEqual(['done-dep', 'free', 'gone']);
    expect(blockedCount).toBe(1);
  });

  it('computes readiness per-harness (ids are not globally unique)', () => {
    const ha: HarnessBlockGraph = { blockers: new Map([['F-1', ['F-0']]]), statuses: new Map([['F-0', 'wip']]) };
    const hb: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };
    const { ready } = filterReadyFrontier(
      [row('F-1', 'a'), row('F-1', 'b')], // same id, different harness
      new Map([['a', ha], ['b', hb]]),
      undefined,
    );
    // a/F-1 is blocked; b/F-1 has no blockers → only b's survives.
    expect(ready.map((r) => r.harness_slug)).toEqual(['b']);
  });

});

describe('frontierInEligiblePlans (mug-steering-panel P-008 — the frontier plan HARD-filter, pure)', () => {
  it('no eligible-plans list ⇒ keep everything (un-steered survey is unchanged)', () => {
    expect(frontierInEligiblePlans('p', undefined)).toBe(true);
    expect(frontierInEligiblePlans('p', {})).toBe(true);
    expect(frontierInEligiblePlans('p', { eligiblePlans: [] })).toBe(true);
  });

  it('with a list: keeps a row from an eligible plan, drops a row from a non-eligible plan', () => {
    expect(frontierInEligiblePlans('keep', { eligiblePlans: ['keep'] })).toBe(true);
    expect(frontierInEligiblePlans('drop', { eligiblePlans: ['keep'] })).toBe(false);
  });

  it('loose (unplanned) rows are gated by includeUnplannedWork, independent of eligiblePlans (decoupled 2026-06-30)', () => {
    // Default (undefined) ⇒ loose work IS placed, even under an eligiblePlans restriction.
    expect(frontierInEligiblePlans(null, { eligiblePlans: ['keep'] })).toBe(true);
    expect(frontierInEligiblePlans(undefined, { eligiblePlans: ['keep'] })).toBe(true);
    // Explicitly off ⇒ loose work dropped, regardless of the plan restriction.
    expect(frontierInEligiblePlans(null, { includeUnplannedWork: false })).toBe(false);
    expect(frontierInEligiblePlans(null, { eligiblePlans: ['keep'], includeUnplannedWork: false })).toBe(false);
    // With NO restriction, loose work still passes by default.
    expect(frontierInEligiblePlans(null, { eligiblePlans: [] })).toBe(true);
    expect(frontierInEligiblePlans(undefined, {})).toBe(true);
  });
});

describe('notStopped (per-pot Stop stop-list, pure)', () => {
  it('no stop-list ⇒ everything passes (never over-withholds)', () => {
    expect(notStopped('h', undefined)).toBe(true);
    expect(notStopped('h', {})).toBe(true);
    expect(notStopped('h', { stoppedHarnesses: [] })).toBe(true);
  });
  it('withholds ONLY harnesses in the stop-list', () => {
    expect(notStopped('stopped', { stoppedHarnesses: ['stopped'] })).toBe(false);
    expect(notStopped('other', { stoppedHarnesses: ['stopped'] })).toBe(true); // standalone/other passes
  });
});

describe('buildPlanItemBlockGraph (EI-12372) — plan-item blocking', () => {
  it('correctly identifies when a plan-item is blocked', () => {
    const graph = buildPlanItemBlockGraph([
      [
        planRow({
          planSlug: 'P-plan',
          harnessSlug: 'h1',
          items: [
            { id: 'P-001', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null },
            { id: 'P-002', status: 'todo', text: '', importance: 'high', blockedBy: ['P-001'], decisionRefs: [], phase: null },
          ],
        }),
      ],
    ]);

    // P-002 is blocked by P-001
    expect(graph.planItemBlockers.get('P-plan')?.get('P-002')).toEqual(['P-001']);
    // P-001 status is recorded as 'todo'
    expect(graph.planItemStatuses.get('P-plan')?.get('P-001')).toBe('todo');
  });

  // WI-10008237: memoized on the (cached, identity-stable) row arrays.
  type Item = PlanIndexRow['items'][number];
  const item = (id: string, status: Item['status'], blockedBy: string[] = []): Item =>
    ({ id, status, text: '', importance: 'high', blockedBy, decisionRefs: [], phase: null }) as Item;

  it('reuses the graph for the same row array and rebuilds for a new one', () => {
    const rows = [planRow({ planSlug: 'M-plan', harnessSlug: 'h1', items: [item('P-001', 'todo'), item('P-002', 'todo', ['P-001'])] })];
    const first = buildPlanItemBlockGraph([rows]);
    expect(buildPlanItemBlockGraph([rows])).toBe(first);
    // The plan index changed: the cache hands back a NEW array, which must not hit the memo.
    const changed = [planRow({ planSlug: 'M-plan', harnessSlug: 'h1', items: [item('P-001', 'done'), item('P-002', 'todo', ['P-001'])] })];
    const second = buildPlanItemBlockGraph([changed]);
    expect(second).not.toBe(first);
    expect(second.planItemStatuses.get('M-plan')?.get('P-001')).toBe('done');
    expect(first.planItemStatuses.get('M-plan')?.get('P-001')).toBe('todo');
  });

  it('merges a plan present in several harness arrays without mutating either memoized part', () => {
    const a = [planRow({ planSlug: 'X-plan', harnessSlug: 'h1', items: [item('P-001', 'todo'), item('P-002', 'todo', ['P-001'])] })];
    const b = [
      planRow({ planSlug: 'X-plan', harnessSlug: 'h2', items: [item('P-003', 'done'), item('P-004', 'todo', ['P-003'])] }),
      planRow({ planSlug: 'Y-plan', harnessSlug: 'h2', items: [item('P-001', 'todo')] }),
    ];
    const partA = buildPlanItemBlockGraph([a]);
    const partB = buildPlanItemBlockGraph([b]);
    const merged = buildPlanItemBlockGraph([a, b]);

    expect([...merged.planItemBlockers.get('X-plan')!.keys()].sort()).toEqual(['P-001', 'P-002', 'P-003', 'P-004']);
    expect(merged.planItemStatuses.get('X-plan')?.get('P-001')).toBe('todo');
    expect(merged.planItemStatuses.get('X-plan')?.get('P-003')).toBe('done');
    expect(merged.planItemBlockers.get('Y-plan')?.get('P-001')).toEqual([]);
    // The memoized single-array graphs are untouched by the merge.
    expect([...partA.planItemBlockers.get('X-plan')!.keys()].sort()).toEqual(['P-001', 'P-002']);
    expect([...partB.planItemBlockers.get('X-plan')!.keys()].sort()).toEqual(['P-003', 'P-004']);
    expect(partA.planItemStatuses.get('X-plan')?.has('P-003')).toBe(false);
    // Same answer as building the merged rows from scratch in one array.
    const flat = buildPlanItemBlockGraph([[...a, ...b]]);
    expect(merged.planItemBlockers).toEqual(flat.planItemBlockers);
    expect(merged.planItemStatuses).toEqual(flat.planItemStatuses);
  });
});

describe('surveyPot plan-item blocking (EI-12372)', () => {
  const noBlockers: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };
  const depsFor = (over: Partial<SurveyDeps>): Partial<SurveyDeps> => ({
    now: () => NOW,
    fetchBlockGraph: async () => noBlockers,
    fetchReconcile: async () => ({ rows: [], total: 0 }),
    fetchQuarantinedCount: async () => 0,
    fetchEscalatedIssues: async () => [],
    ...over,
  });

  // ── plan-item blocking (EI-12372) ──
  it('records the plan-item blocking graph correctly', async () => {
    // When a survey fetches plan rows with items that have blockedBy chains,
    // buildPlanItemBlockGraph should record those chains for filtering.
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({
                  planSlug: 'P-plan',
                  harnessSlug: 'papercup',
                  items: [
                    { id: 'P-001', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null },
                    { id: 'P-002', status: 'todo', text: '', importance: 'high', blockedBy: ['P-001'], decisionRefs: [], phase: null },
                  ],
                }),
              ]
            : [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-Y', harness_slug: 'papercup' }),
        ],
      }),
    });
    // The survey should complete without error and have processed plan-item blocking
    expect(survey.frontier.map((c) => c.id)).toContain('WI-Y');
    expect(survey.frontierBlocked).toBe(0); // WI-Y has no blockers
  });

  it('surfaces a frontier work-item whose linked plan-item blocker is now terminal', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [
                planRow({
                  planSlug: 'P-plan',
                  harnessSlug: 'papercup',
                  items: [
                    { id: 'P-001', status: 'passed', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null },
                    { id: 'P-002', status: 'todo', text: '', importance: 'high', blockedBy: ['P-001'], decisionRefs: [], phase: null },
                  ],
                }),
              ]
            : [],
        fetchFrontier: async () => [
          // WI-X links to plan-item P-002 whose blocker (P-001) is now terminal (passed)
          frontierRow({
            feature_id: 'WI-X',
            harness_slug: 'papercup',
            payload: { plan_item: { plan_slug: 'P-plan', item_id: 'P-002' } },
          }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-X'); // blocker is terminal, so P-002 is ready
    expect(survey.frontierBlocked).toBe(0);
  });

  it('ignores plan-item blocking when payload.plan_item is missing or null', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async (slug) =>
          slug === 'papercup'
            ? [planRow({ planSlug: 'P-plan', harnessSlug: 'papercup', items: [{ id: 'P-001', status: 'todo', text: '', importance: 'high', blockedBy: [], decisionRefs: [], phase: null }] })]
            : [],
        fetchFrontier: async () => [
          frontierRow({ feature_id: 'WI-1', harness_slug: 'papercup', payload: null }),
          frontierRow({ feature_id: 'WI-2', harness_slug: 'papercup', payload: {} }),
          frontierRow({ feature_id: 'WI-3', harness_slug: 'papercup', payload: { plan_item: null } }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('WI-1');
    expect(ids).toContain('WI-2');
    expect(ids).toContain('WI-3');
    expect(survey.frontierBlocked).toBe(0);
  });
});

describe('surveyPot escalated-issue frontier (EI-12275)', () => {
  const noBlockers: HarnessBlockGraph = { blockers: new Map(), statuses: new Map() };
  const depsFor = (over: Partial<SurveyDeps>): Partial<SurveyDeps> => ({
    now: () => NOW,
    fetchBlockGraph: async () => noBlockers,
    fetchReconcile: async () => ({ rows: [], total: 0 }),
    fetchQuarantinedCount: async () => 0,
    fetchFrontier: async () => [],
    ...over,
  });

  // The headline defect: pot:survey.fetchFrontierRows excludes the issue-routed kinds
  // (frontierPlacementKindClause), so a severity:major bug/change/task item was
  // structurally invisible to the Mug's ranked frontier — no escalation-pressure
  // weight could ever help it, because it never entered rankPlacements' input set
  // at all. fetchEscalatedIssues (a separate, severity-gated query) closes that gap.
  it('surfaces a severity:major issue-family row that fetchFrontier alone never would', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        // Mirrors the real fetchFrontierRows behaviour: bug/change/task never appear here.
        fetchFrontier: async () => [],
        fetchEscalatedIssues: async () => [
          frontierRow({ feature_id: 'EI-12220', harness_slug: 'papercup', item_kind: 'bug', severity: 'major' }),
        ],
      }),
    });
    const ids = survey.frontier.map((c) => c.id);
    expect(ids).toContain('EI-12220');
    expect(survey.frontier.find((c) => c.id === 'EI-12220')?.severity).toBe('major');
  });

  it('ranks a severity:critical issue ABOVE a normal-importance feature row via the blocking-impact severity prior', async () => {
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-ORDINARY', harness_slug: 'papercup' })],
        fetchEscalatedIssues: async () => [
          frontierRow({ feature_id: 'EI-URGENT', harness_slug: 'papercup', item_kind: 'bug', severity: 'critical' }),
        ],
      }),
    });
    expect(survey.frontier[0]?.id).toBe('EI-URGENT');
  });

  // The escalated-issue slice flows through the SAME readiness/scope machinery as
  // the feature frontier (concatenated before filterReadyFrontier) — a blocked one
  // is excluded exactly like a blocked feature row would be, no separate code path.
  it('drops an escalated issue whose OWN blocked_by is unsatisfied, same as a feature row', async () => {
    const graph: HarnessBlockGraph = {
      blockers: new Map([['EI-BLOCKED', ['WI-UPSTREAM']]]),
      statuses: new Map([['WI-UPSTREAM', 'todo']]),
    };
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchBlockGraph: async () => graph,
        fetchEscalatedIssues: async () => [
          frontierRow({ feature_id: 'EI-BLOCKED', harness_slug: 'papercup', item_kind: 'bug', severity: 'critical' }),
        ],
      }),
    });
    expect(survey.frontier.map((c) => c.id)).not.toContain('EI-BLOCKED');
    expect(survey.frontierBlocked).toBe(1);
  });

  it('a fetchEscalatedIssues failure fails open (feature frontier unaffected)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const survey = await surveyPot('default', 'papercup-pot', {
      deps: depsFor({
        loadRegistry: async () => ({ projects: [{ slug: 'papercup', hive_slug: 'papercup-pot' }] }),
        listPlanRows: async () => [],
        fetchFrontier: async () => [frontierRow({ feature_id: 'WI-STILL-HERE', harness_slug: 'papercup' })],
        fetchEscalatedIssues: async () => {
          throw new Error('transient pooler blip');
        },
      }),
    });
    expect(survey.frontier.map((c) => c.id)).toEqual(['WI-STILL-HERE']);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('escalated-issue frontier read failed'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

describe('surveyWorkspace crossPot dedup (EI-8377)', () => {
  function wsDeps(over: Partial<SurveyDeps>): SurveyDeps {
    return {
      loadRegistry: async () => ({ projects: [] }),
      listPlanRows: async () => [],
      fetchFrontier: async () => [],
      fetchEscalatedIssues: async () => [],
      fetchBlockGraph: async () => ({ blockers: new Map(), statuses: new Map() }),
      fetchQuarantinedCount: async () => 0,
      fetchReconcile: async () => ({ rows: [], total: 0 }),
      now: () => NOW,
      ...over,
    };
  }

  it('a work-item echoed via a pass-through/nested pot (same harness slug) is counted ONCE in crossPot.frontier', async () => {
    // Pot B is BOTH a member of pot A (its own hive_slug points at A) AND its
    // own top-level pot (registered as kind:'hive') — the "pass-through" shape:
    // A's own survey includes harness 'B' as a member slug, and B's own
    // top-level survey ALSO covers harness 'B' as its home. A work-item filed
    // directly under harness 'B' is therefore surfaced by BOTH surveyPot(A)
    // and surveyPot(B) — the crossPot merge must collapse it to one entry.
    const projects = [
      { slug: 'A', hive_slug: undefined, harness_kind: 'hive' },
      { slug: 'B', hive_slug: 'A', harness_kind: 'hive' },
    ];
    const row = frontierRow({ feature_id: 'WI-1', harness_slug: 'B' });
    const deps = wsDeps({
      loadRegistry: async () => ({ projects }),
      fetchFrontier: async (slugs) => (slugs.includes('B') ? [row] : []),
    });
    const ws = await surveyWorkspace('ws', { listPotSlugs: async () => ['A', 'B'], deps });
    expect(ws.crossPot.frontier).toHaveLength(1);
    expect(ws.crossPot.frontier[0].id).toBe('WI-1');
    // The top-level deduped count is what a caller (e.g. a Kettle escalation)
    // must read — never a caller-side sum of the per-pot sections, which
    // legitimately overlap by design (each pot's OWN focused view).
  });

  it('distinct items across non-overlapping hives all surface (no over-dedup)', async () => {
    const projects = [
      { slug: 'A', hive_slug: undefined, harness_kind: 'hive' },
      { slug: 'B', hive_slug: undefined, harness_kind: 'hive' },
    ];
    const rowA = frontierRow({ feature_id: 'WI-1', harness_slug: 'A' });
    const rowB = frontierRow({ feature_id: 'WI-2', harness_slug: 'B' });
    const deps = wsDeps({
      loadRegistry: async () => ({ projects }),
      // Neither A nor B has a member wired, so resolvePotMembership falls back
      // to `surveySlugs: []` (workspace-wide scope) for each — mirror that here.
      fetchFrontier: async (slugs) => [rowA, rowB].filter((r) => slugs.length === 0 || slugs.includes(r.harness_slug)),
    });
    const ws = await surveyWorkspace('ws', { listPotSlugs: async () => ['A', 'B'], deps });
    expect(ws.crossPot.frontier.map((f) => f.id).sort()).toEqual(['WI-1', 'WI-2']);
  });
});

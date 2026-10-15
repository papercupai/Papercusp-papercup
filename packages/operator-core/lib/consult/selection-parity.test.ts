/**
 * selection-parity.test.ts — the DIFFERENTIAL between the two consumers of
 * @papercusp/ranked-selection. P-007 of
 * unified-responder-selection-critique-and-grading-2026-08-30.
 *
 * WHY THIS EXISTS. D-001 (owner ruling) required ONE generic mechanism that the
 * critique consult and acceptance grading both consume, so their selection
 * semantics cannot drift apart. The obvious way to check that is to assert both
 * consumers IMPORT the shared module — and that check is worth very little.
 * Importing is a claim about ancestry, not about output: a consumer can call
 * `selectRanked` and then re-sort, filter, or truncate the result and still
 * satisfy every word of "it consumes the shared mechanism", while drifting in
 * exactly the way D-001 exists to prevent. Shared origin does not constrain the
 * answer.
 *
 * So this file asserts the AGREEMENT instead. One candidate set is fed through
 * BOTH consumers' real public entry points — `selectResponders` (critique) and
 * `selectAcceptanceGrader` (grading) — and their orderings and provenance
 * labels must be identical once the declared bounds are equalised. That
 * assertion fails the moment either consumer post-processes the shared result,
 * and it keeps holding as the module evolves, which an import check does not.
 *
 * Raised in the rubric-vetting critique of `unified-responder-selection-acceptance`
 * (consult conv-mtghcszj-0000-4660332c6d174834ae2ebf5c603f3d8b): "That is a claim
 * about IMPORTS, and imports are not parity … Assert the DIFFERENTIAL instead:
 * feed ONE candidate set through BOTH consumers' public entry points and require
 * IDENTICAL ordering."
 *
 * FALSIFIABILITY. The parity assertion is only a guard if a divergence could
 * break it, so the CONTROLS block at the bottom keeps three deliberately
 * post-processing consumers permanently in this file — reverse, re-rank, and
 * truncate — and asserts each one DIVERGES from the shared kernel. They are the
 * tier-2 pattern from the repo's mutation-probe table (a wrong implementation
 * kept in the test file rather than mutated into the tree, which this swept
 * checkout can commit even when nothing fails).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { selectRanked, selectionPolicy, type Selected } from '@papercusp/ranked-selection';
import { selectResponders, type RoutingCandidate } from './relevance-router';
import type { ConsultRouteParams, RouteResult } from './relevance-router';
import { selectAcceptanceGrader } from './acceptance-grader-select';
// Importing this module REGISTERS the policies (it calls configureSelectionPolicies
// at module scope), which is what makes selectionPolicy resolvable below.
import { ACCEPTANCE_GRADING_POLICY, BAR_CRITIQUE_POLICY, ensureSelectionPolicies } from './selection-policies';

ensureSelectionPolicies();

function candidate(ownerId: string, score: number, liveness = 'live'): RoutingCandidate {
  return {
    ownerId,
    score,
    relevance: score,
    relativeAgeDays: 0,
    signals: { similarity: 0.6, verification: 0.2, authorship: 0, freshness: 1 },
    evidence: [{ session_id: `s-${ownerId}`, turn_idx: 1, ts: null, sim: 0.6 }],
    liveness,
  };
}

function routed(cands: RoutingCandidate[]): RouteResult {
  return {
    verdict: cands.length > 0 ? 'routed' : 'no_qualified_responder',
    qualified: cands,
    snapshot: {
      query: 'q',
      relevanceFloor: 0.41,
      simFloor: 0.4,
      weights: { similarity: 0.55, verification: 0.15, authorship: 0.15 },
      recencyHalfLifeDays: 7,
      candidates: cands,
      computedAt: '2026-08-16T00:00:00.000Z',
    },
    queryVec: [0.1],
    queryProfile: null,
    queryMode: null,
  };
}

/** Route result whose qualified set is EMPTY but whose pool is not — the
 *  below-floor shape that exercises minimum-fill on both sides. */
function belowFloor(cands: RoutingCandidate[]): RouteResult {
  const empty = routed([]);
  return { ...empty, snapshot: { ...empty.snapshot, candidates: cands } };
}

const fakeSql = (): Sql => (async () => []) as unknown as Sql;
const noParties = async (_workspaceId: string, ownerIds: string[]) =>
  new Map(ownerIds.map((ownerId) => [ownerId, ownerId] as const));
const allReviewers = async (_workspaceId: string, ownerIds: string[]) =>
  new Map(ownerIds.map((ownerId) => [ownerId, 'reviewer'] as const));

const params = {
  workspaceId: 'ws',
  planSlug: 'a-plan',
  planContent: 'plan body',
  rubricText: 'rubric: outcome works',
};

/** The grading consumer's real entry point, reduced to (ownerId, via) pairs. */
async function throughGrading(route: RouteResult): Promise<Array<[string, string]>> {
  const out = await selectAcceptanceGrader(params, {
    getSql: fakeSql,
    getPartyKeys: noParties,
    getCandidateRoles: allReviewers,
    route: async (_p: ConsultRouteParams) => route,
  });
  return out.graders.map((g) => [g.candidate.ownerId, g.via]);
}

/** The critique consumer's real entry point, reduced the same way. */
function throughCritique(
  route: RouteResult,
  bounds: { min: number; max: number },
): Array<[string, string]> {
  return selectResponders({
    qualified: route.qualified,
    allCandidates: route.snapshot.candidates,
    min: bounds.min,
    max: bounds.max,
    isSelectable: (c: RoutingCandidate) => c.liveness !== 'ended',
  }).map((s: Selected<RoutingCandidate>) => [s.candidate.ownerId, s.via]);
}

describe('the two consumers agree — parity, not shared ancestry (D-001)', () => {
  it('registers the plan-start bar-critique policy in the shared selection registry', () => {
    expect(selectionPolicy(BAR_CRITIQUE_POLICY)).toEqual({ min: 1, max: 2 });
  });

  // Bounds are read from the registry rather than typed here, so this file
  // cannot be the eighth hand-maintained copy of a number the plan spent an
  // item removing.
  const gradingBounds = selectionPolicy(ACCEPTANCE_GRADING_POLICY);

  it('an all-qualified pool selects the SAME graders in the SAME order on both sides', async () => {
    const route = routed([candidate('su-a', 0.9), candidate('su-b', 0.8), candidate('su-c', 0.7)]);

    const grading = await throughGrading(route);
    const critique = throughCritique(route, gradingBounds);

    expect(grading).toEqual(critique);
    // Pinned concretely too, so a change that broke BOTH sides identically
    // could not pass by making the two agree on a wrong answer.
    expect(grading).toEqual([
      ['su-a', 'floor'],
      ['su-b', 'floor'],
    ]);
  });

  it('a BELOW-FLOOR pool minimum-fills identically on both sides, labels included', async () => {
    // The interesting half: the fill path is where the two flows historically
    // disagreed (grading used to mint a fresh grader instead of filling), so
    // parity here is what D-002's reversal actually bought.
    const route = belowFloor([candidate('su-x', 0.4), candidate('su-y', 0.3)]);

    const grading = await throughGrading(route);
    const critique = throughCritique(route, gradingBounds);

    expect(grading).toEqual(critique);
    expect(grading).toEqual([['su-x', 'minimum']]);
  });

  it('a mixed pool agrees on ordering AND on which picks are below the floor', async () => {
    const qualified = [candidate('su-hi', 0.95)];
    const route: RouteResult = {
      ...routed(qualified),
      snapshot: {
        ...routed(qualified).snapshot,
        candidates: [candidate('su-hi', 0.95), candidate('su-lo', 0.2)],
      },
    };

    const grading = await throughGrading(route);
    const critique = throughCritique(route, gradingBounds);

    expect(grading).toEqual(critique);
  });

  it('the ONLY difference between the consumers is their declared bounds', async () => {
    // Both read a policy from the registry; grading's is tighter. Run the
    // critique side at a WIDER bound and the grading menu must be an exact
    // PREFIX of it — same comparator, same labels, just a shorter cap. If the
    // two ever diverge in ordering rather than length, this fails.
    const route = routed([
      candidate('su-a', 0.9),
      candidate('su-b', 0.8),
      candidate('su-c', 0.7),
      candidate('su-d', 0.6),
    ]);

    const grading = await throughGrading(route);
    const wider = throughCritique(route, { min: gradingBounds.min, max: gradingBounds.max + 2 });

    expect(wider.slice(0, grading.length)).toEqual(grading);
    expect(wider.length).toBeGreaterThan(grading.length);
  });

  it('an empty pool is empty on both sides — the vacuous-pass case', async () => {
    // Raised in the same vetting consult: a selector that never selects anyone
    // satisfies every parity assertion trivially, because two empty lists are
    // always equal. The positive cases above are what stop this file passing
    // vacuously; this one pins that an empty input is honestly empty rather
    // than silently filled, on both sides.
    const route = routed([]);

    expect(await throughGrading(route)).toEqual([]);
    expect(throughCritique(route, gradingBounds)).toEqual([]);
  });
});

/**
 * CONTROLS — permanent, in-test, no tree mutation.
 *
 * Every assertion above compares two consumers to each other. That is only a
 * guard if a post-processing consumer would actually break it, so these three
 * stand in for the drift the criterion names: a consumer that imports the
 * shared selector and then re-orders, re-ranks, or truncates its result. Each
 * must DIVERGE from the kernel. If any of them ever matches, the parity
 * assertions above have stopped discriminating and are passing for free.
 */
describe('CONTROLS (falsifiability, in-test — no tree mutation)', () => {
  const bounds = selectionPolicy(ACCEPTANCE_GRADING_POLICY);
  const pool = [candidate('su-a', 0.9), candidate('su-b', 0.8), candidate('su-c', 0.7)];
  const shared = () =>
    selectRanked<RoutingCandidate>({
      qualified: pool,
      allCandidates: pool,
      bounds,
      identity: (c) => c.ownerId,
    }).map((s) => [s.candidate.ownerId, s.via] as [string, string]);

  it('CALIBRATION: the shared kernel is non-empty and stable, so divergence below means something', () => {
    // Without this, every control could "diverge" merely because the kernel
    // returned nothing, and the whole block would prove nothing at all.
    expect(shared()).toEqual([
      ['su-a', 'floor'],
      ['su-b', 'floor'],
    ]);
  });

  it('a consumer that REVERSES the shared result diverges', () => {
    const drifted = [...shared()].reverse();
    expect(drifted).not.toEqual(shared());
  });

  it('a consumer that RE-RANKS by its own key diverges', () => {
    // The subtlest real-world shape: still every correct member, still the
    // right length, only the ORDER changed — which is exactly what decides
    // who gets woken first, and what an import check cannot see.
    const drifted = [...shared()].sort((a, b) => a[0].localeCompare(b[0])).reverse();
    expect(drifted).not.toEqual(shared());
  });

  it('a consumer that TRUNCATES the shared result diverges', () => {
    const drifted = shared().slice(0, 1);
    expect(drifted).not.toEqual(shared());
  });
});

/**
 * outcome-feedback-wire.test.ts — Scout lens-outcome meta-learning FULL WIRE
 * (scout-loop-test-plan-2026-06-11 P-014).
 *
 * The per-module suites (outcome-feedback.test.ts, eval-verdict-wire.test.ts)
 * pin each stage in isolation; THIS suite pins the whole loop, hermetically:
 * simulated change-feed outcomes for routed ideas → classifyIdeaOutcome →
 * lens-weight shifts — plus the convergence guarantee that a tab-eval verdict
 * (eval-verdict-wire) and a gym change-feed decision produce IDENTICAL weight
 * updates for identical outcomes, the selectedCandidate promotion read, and
 * idempotence under re-emitted outcome events.
 *
 * The weighting math pinned here (outcome-feedback.applyLensWeights, defaults
 * priorStrength = 1, minShare = 0.05, lensCount = 4):
 *   1. smoothed win-rate   r_l = (won + 1) / (won + lost + 2)    — Beta(1,1);
 *   2. normalize           w_l = r_l / Σ r;
 *   3. floor + re-normalize  max(w_l, 0.05) / Σ max(w_j, 0.05).
 * There is NO decay: pending ideas contribute nothing, and the weights are a
 * pure projection of the cumulative (won, lost) tallies — which is exactly why
 * re-processing the same outcome event cannot double-shift them.
 */

import { describe, expect, it } from 'vitest';

import type { ChangeFeedEntry } from '../curation/change-feed';
import { evalVerdictEntries, evalVerdictRef, selectedCandidate, type EvalVerdictLike } from './eval-verdict-wire';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  gatherLensOutcomes,
  lensWeightsFromReport,
  type RoutedIdeaProvenance,
  type ScoutOutcomeReaders,
} from './outcome-feedback';
import { CREATIVE_LENSES, type CreativeLens } from './types';
import { LENS_IDENTITY_ID_LIST, lensForIdentityId, type LensIdentityId } from './lenses';

function prov(p: Partial<RoutedIdeaProvenance> & { lens: CreativeLens; routedRef: string }): RoutedIdeaProvenance {
  return { ideaId: p.ideaId ?? `idea-${p.routedRef}`, rail: p.rail ?? 'gym', ...p };
}

function gymEntry(ref: string, status: 'accepted' | 'rejected', ts = '2026-06-10T00:00:00Z'): ChangeFeedEntry {
  return { id: ref, kind: 'proposal', title: `${status}: ${ref}`, detail: `Status: ${status}`, ref, ts };
}

/** In-memory fake of the routed-idea ledger + change feed (the sibling fake-store idiom). */
function fakeStore() {
  const routed: RoutedIdeaProvenance[] = [];
  const feed: ChangeFeedEntry[] = [];
  const readers: ScoutOutcomeReaders = {
    async routedIdeas() {
      return [...routed];
    },
    async completions() {
      // gatherCompletions delivers newest-first; mirror that contract.
      return [...feed].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    },
  };
  return { routed, feed, readers };
}

/**
 * lensWeightsFromReport keys its output by lens identity id (P-011 / R-8). The math
 * pins below read it per lens, so this view maps each identity id back to its lens.
 */
const byLensView = (w: Record<LensIdentityId, number>): Record<CreativeLens, number> =>
  Object.fromEntries(
    Object.entries(w).map(([id, n]) => {
      const lens = lensForIdentityId(id);
      if (!lens) throw new Error(`lensWeightsFromReport emitted a non-lens key: ${id}`);
      return [lens, n];
    }),
  ) as Record<CreativeLens, number>;

const weightsOf = (provenance: RoutedIdeaProvenance[], feed: ChangeFeedEntry[]) =>
  byLensView(lensWeightsFromReport(computeLensOutcomes(provenance, feed)));

describe('Scout lens-outcome meta-learning — full wire (P-014)', () => {
  describe('change-feed outcomes → classifyIdeaOutcome → lens-weight shifts (math pinned)', () => {
    it('the weight hand-off is keyed by exactly the four lens identity ids', () => {
      const raw = lensWeightsFromReport(computeLensOutcomes([], []));
      expect(Object.keys(raw).sort()).toEqual([...LENS_IDENTITY_ID_LIST].sort());
    });

    it('baseline: nothing decided → every lens at the uniform 1/4', () => {
      const w = weightsOf([], []);
      for (const l of CREATIVE_LENSES) expect(w[l]).toBeCloseTo(1 / 4, 12);
    });

    it('one ACCEPTED outcome: the lens rises to 4/13, every untouched lens drops to 3/13', () => {
      // r_analogical = (1+1)/(1+0+2) = 2/3; r_other = 1/2; Σr = 2/3 + 3·(1/2) = 13/6
      // → analogical = (2/3)/(13/6) = 4/13 ≈ .3077; untouched = (1/2)/(13/6) = 3/13 ≈ .2308
      // (floor 0.05 not binding). Strictly above/below the 1/4 baseline.
      const w = weightsOf(
        [prov({ lens: 'analogical', routedRef: 'gym:w1' })],
        [gymEntry('gym:w1', 'accepted')],
      );
      expect(w.analogical).toBeCloseTo(4 / 13, 12);
      for (const l of CREATIVE_LENSES.filter((x) => x !== 'analogical')) {
        expect(w[l]).toBeCloseTo(3 / 13, 12);
        expect(w.analogical).toBeGreaterThan(w[l]);
      }
      expect(w.analogical).toBeGreaterThan(1 / 4);
      expect(w.reframing).toBeLessThan(1 / 4);
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 12);
    });

    it('one REJECTED outcome: the lens drops to 2/11, every untouched lens rises to 3/11', () => {
      // r_reframing = (0+1)/(1+2) = 1/3; r_other = 1/2; Σr = 1/3 + 3/2 = 11/6
      // → reframing = (1/3)/(11/6) = 2/11 ≈ .1818; untouched = 3/11 ≈ .2727.
      const w = weightsOf(
        [prov({ lens: 'reframing', routedRef: 'gym:l1' })],
        [gymEntry('gym:l1', 'rejected')],
      );
      expect(w.reframing).toBeCloseTo(2 / 11, 12);
      for (const l of CREATIVE_LENSES.filter((x) => x !== 'reframing')) {
        expect(w[l]).toBeCloseTo(3 / 11, 12);
        expect(w.reframing).toBeLessThan(w[l]);
      }
      expect(w.reframing).toBeLessThan(1 / 4);
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 12);
    });

    it('mixed tallies pin the full formula: 2W1L → 9/29, 1L → 5/29, untouched → 15/58 each', () => {
      // r_analogical = (2+1)/(3+2) = 3/5; r_reframing = (0+1)/(1+2) = 1/3; r_other = 1/2
      // Σr = 3/5 + 1/3 + 1 = 29/15 → 9/29, 5/29, 15/58, 15/58 (sums to 1; floor idle).
      const provenance = [
        prov({ lens: 'analogical', routedRef: 'gym:a1' }),
        prov({ lens: 'analogical', routedRef: 'gym:a2' }),
        prov({ lens: 'analogical', routedRef: 'gym:a3' }),
        prov({ lens: 'reframing', routedRef: 'gym:r1' }),
      ];
      const feed = [
        gymEntry('gym:a1', 'accepted'),
        gymEntry('gym:a2', 'accepted'),
        gymEntry('gym:a3', 'rejected'),
        gymEntry('gym:r1', 'rejected'),
      ];
      const w = weightsOf(provenance, feed);
      expect(w.analogical).toBeCloseTo(9 / 29, 12);
      expect(w.reframing).toBeCloseTo(5 / 29, 12);
      expect(w['first-principles']).toBeCloseTo(15 / 58, 12);
      expect(w['constraint-removal']).toBeCloseTo(15 / 58, 12);
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 12);
    });

    it('a heavy loser hits the minShare floor: floored to 0.05, then re-normalized (stays alive)', () => {
      // 30 losses: r_analogical = 1/32; r_other = 1/2; Σr = 49/32.
      // normalized analogical = 1/49 ≈ .0204 < 0.05 → floored to 0.05; others 16/49.
      // flooredΣ = 0.05 + 3·16/49 → final = floored / flooredΣ. (Step 3 of the
      // documented math: after re-normalization the floored share sits a hair
      // UNDER the nominal 0.05 — the guarantee is "never starved", not exact.)
      const provenance = Array.from({ length: 30 }, (_, i) =>
        prov({ lens: 'analogical', routedRef: `gym:l${i}`, ideaId: `loser-${i}` }),
      );
      const feed = provenance.map((p) => gymEntry(p.routedRef, 'rejected'));
      const w = weightsOf(provenance, feed);

      const rLoser = 1 / 32;
      const rOther = 1 / 2;
      const sum = rLoser + 3 * rOther;
      const flooredLoser = Math.max(rLoser / sum, 0.05); // = 0.05 (binding)
      const other = rOther / sum; // ≈ .3265, above the floor
      const flooredSum = flooredLoser + 3 * other;
      expect(rLoser / sum).toBeLessThan(0.05); // the floor really binds here
      expect(w.analogical).toBeCloseTo(flooredLoser / flooredSum, 12);
      expect(w.reframing).toBeCloseTo(other / flooredSum, 12);
      expect(w.analogical).toBeGreaterThan(0.04); // never starved (diversity guarantee)
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 12);
    });
  });

  describe('errored / undecided eval arms stay pending and move NO weights', () => {
    it('an all-undecided verdict (errored + unmeasured arms) emits no entries; weights stay at baseline', () => {
      const verdict: EvalVerdictLike = {
        scenarioId: 'scn-err',
        primaryScorer: 'score',
        selectionReason: 'no candidate measured',
        candidates: [
          { variantId: 'v-err', rank: 1, errored: true },
          { variantId: 'v-unmeasured', rank: 2, errored: false }, // primaryImprovement absent
        ],
      };
      const entries = evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z'));
      expect(entries).toEqual([]); // the eval-verdict-wire rule: undecided ≠ lost

      const provenance = [
        prov({ lens: 'analogical', routedRef: evalVerdictRef('scn-err', 'v-err') }),
        prov({ lens: 'reframing', routedRef: evalVerdictRef('scn-err', 'v-unmeasured') }),
      ];
      const report = computeLensOutcomes(provenance, entries);
      expect(report.byLens.analogical).toMatchObject({ pending: 1, won: 0, lost: 0, winRate: null });
      expect(report.byLens.reframing).toMatchObject({ pending: 1, won: 0, lost: 0, winRate: null });
      // Pending moved NOTHING: the weight vector is bit-identical to the empty world.
      expect(lensWeightsFromReport(report)).toEqual(lensWeightsFromReport(computeLensOutcomes([], [])));
    });

    it('an errored arm is weight-neutral: the report weights equal the same world without that idea', () => {
      const verdict: EvalVerdictLike = {
        scenarioId: 'scn-mixed',
        primaryScorer: 'score',
        selected: 'v-win',
        selectionReason: "selected 'v-win'",
        candidates: [
          { variantId: 'v-win', rank: 1, errored: false, primaryImprovement: 0.2 },
          { variantId: 'v-err', rank: 2, errored: true },
        ],
      };
      const entries = evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z'));
      const winnerProv = prov({ lens: 'analogical', routedRef: evalVerdictRef('scn-mixed', 'v-win') });
      const erroredProv = prov({ lens: 'constraint-removal', routedRef: evalVerdictRef('scn-mixed', 'v-err') });

      const byRef = new Map(entries.map((e) => [e.ref, e]));
      expect(classifyIdeaOutcome(erroredProv, byRef)).toBe('pending');

      const withErrored = computeLensOutcomes([winnerProv, erroredProv], entries);
      const withoutErrored = computeLensOutcomes([winnerProv], entries);
      expect(withErrored.byLens['constraint-removal'].pending).toBe(1);
      expect(lensWeightsFromReport(withErrored)).toEqual(lensWeightsFromReport(withoutErrored));
    });
  });

  describe('grader credit on the wire (scout-idea-grading C-5 / D-002) — grades shift weights without any feed entry', () => {
    it('grade 5 on a feed-absent idea ≡ one ACCEPTED outcome: 4/13 vs 3/13 (the pinned single-win shift)', () => {
      const w = weightsOf([prov({ lens: 'analogical', routedRef: 'gym:ungraded', humanGrade: 5, gradedBy: 'owner' })], []);
      expect(w.analogical).toBeCloseTo(4 / 13, 12);
      for (const l of CREATIVE_LENSES.filter((x) => x !== 'analogical')) expect(w[l]).toBeCloseTo(3 / 13, 12);
    });

    it('grade 1 ≡ one REJECTED outcome: 2/11 vs 3/11', () => {
      const w = weightsOf([prov({ lens: 'reframing', routedRef: 'gym:ungraded', humanGrade: 1, gradedBy: 'Queen' })], []);
      expect(w.reframing).toBeCloseTo(2 / 11, 12);
      for (const l of CREATIVE_LENSES.filter((x) => x !== 'reframing')) expect(w[l]).toBeCloseTo(3 / 11, 12);
    });

    it('grade 4 pins the fractional formula: r = 1.75/3 = 7/12 → 7/25, untouched lenses 6/25', () => {
      // r_graded = (0.75 + 1) / (0.75 + 0.25 + 2) = 7/12; r_other = 1/2;
      // Σr = 7/12 + 3/2 = 25/12 → graded = (7/12)/(25/12) = 7/25; other = 6/25.
      const w = weightsOf([prov({ lens: 'first-principles', routedRef: 'gym:ungraded', humanGrade: 4, gradedBy: 'owner' })], []);
      expect(w['first-principles']).toBeCloseTo(7 / 25, 12);
      for (const l of CREATIVE_LENSES.filter((x) => x !== 'first-principles')) expect(w[l]).toBeCloseTo(6 / 25, 12);
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 12);
    });

    it('grade 3 is weight-neutral: the vector is bit-identical to the empty world (0.5/0.5 ≡ the Beta(1,1) prior)', () => {
      const w = weightsOf([prov({ lens: 'constraint-removal', routedRef: 'gym:meh', humanGrade: 3, gradedBy: 'owner' })], []);
      expect(w).toEqual(weightsOf([], []));
    });

    it('D-002 dominance on the wire: a grade-1 on a feed-ACCEPTED idea weighs exactly like a feed rejection', () => {
      const overridden = weightsOf(
        [prov({ lens: 'analogical', routedRef: 'gym:w1', humanGrade: 1, gradedBy: 'owner' })],
        [gymEntry('gym:w1', 'accepted')],
      );
      const plainLoss = weightsOf([prov({ lens: 'analogical', routedRef: 'gym:l1' })], [gymEntry('gym:l1', 'rejected')]);
      expect(overridden).toEqual(plainLoss);
      // …and the system verdict stays intact for the outcome cache (grade-blind classify).
      const byRef = new Map([['gym:w1', gymEntry('gym:w1', 'accepted')]]);
      expect(
        classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'gym:w1', humanGrade: 1, gradedBy: 'owner' }), byRef),
      ).toBe('won');
    });

    it('a GRADED errored eval arm is decided by the grade; an ungraded one stays pending (errored-stays-pending untouched)', () => {
      const verdict: EvalVerdictLike = {
        scenarioId: 'scn-graded-err',
        primaryScorer: 'score',
        selectionReason: 'no candidate measured',
        candidates: [
          { variantId: 'v-err-graded', rank: 1, errored: true },
          { variantId: 'v-err-bare', rank: 2, errored: true },
        ],
      };
      const entries = evalVerdictEntries(verdict, new Date('2026-06-12T01:00:00Z'));
      expect(entries).toEqual([]); // errored arms emit nothing, as before
      const report = computeLensOutcomes(
        [
          prov({ lens: 'analogical', routedRef: evalVerdictRef('scn-graded-err', 'v-err-graded'), humanGrade: 5, gradedBy: 'owner' }),
          prov({ lens: 'reframing', routedRef: evalVerdictRef('scn-graded-err', 'v-err-bare'), ideaId: 'bare' }),
        ],
        entries,
      );
      expect(report.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0 });
      expect(report.byLens.reframing).toMatchObject({ won: 0, lost: 0, pending: 1 });
    });

    it('re-grading is idempotent in the projection: the same graded store gathers to the same report', async () => {
      const store = fakeStore();
      store.routed.push(prov({ lens: 'analogical', routedRef: 'gym:never-decided', humanGrade: 2, gradedBy: 'Queen' }));
      const first = await gatherLensOutcomes(store.readers);
      const second = await gatherLensOutcomes(store.readers);
      expect(second).toEqual(first);
      expect(first.byLens.analogical).toMatchObject({ won: 0.25, lost: 0.75, pending: 0 });
    });
  });

  describe('provenance convergence: gym change-feed decision ≡ eval-verdict wire', () => {
    // Two parallel worlds with IDENTICAL outcomes — one decided by the gym rail's
    // change-feed entries, one by evalVerdictEntries over evalVerdictRef provenance.
    const gymProvenance = [
      prov({ lens: 'first-principles', routedRef: 'gym:win', ideaId: 'g1' }),
      prov({ lens: 'reframing', routedRef: 'gym:lose', ideaId: 'g2' }),
    ];
    const gymFeed = [gymEntry('gym:win', 'accepted'), gymEntry('gym:lose', 'rejected')];

    const verdict: EvalVerdictLike = {
      scenarioId: 'scn-conv',
      primaryScorer: 'score',
      selected: 'v-win',
      selectionReason: "selected 'v-win': primary improved by 0.25",
      candidates: [
        { variantId: 'v-win', rank: 1, errored: false, primaryImprovement: 0.25 },
        { variantId: 'v-lose', rank: 2, errored: false, primaryImprovement: -0.1 },
      ],
    };
    const evalFeed = evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z'));
    const evalProvenance = [
      prov({ lens: 'first-principles', routedRef: evalVerdictRef('scn-conv', 'v-win'), ideaId: 'e1' }),
      prov({ lens: 'reframing', routedRef: evalVerdictRef('scn-conv', 'v-lose'), ideaId: 'e2' }),
    ];

    it('classifyIdeaOutcome converges per idea: selected ≡ gym accepted, measured loser ≡ gym rejected', () => {
      const gymByRef = new Map(gymFeed.map((e) => [e.ref, e]));
      const evalByRef = new Map(evalFeed.map((e) => [e.ref, e]));
      expect(classifyIdeaOutcome(gymProvenance[0], gymByRef)).toBe('won');
      expect(classifyIdeaOutcome(evalProvenance[0], evalByRef)).toBe('won');
      expect(classifyIdeaOutcome(gymProvenance[1], gymByRef)).toBe('lost');
      expect(classifyIdeaOutcome(evalProvenance[1], evalByRef)).toBe('lost');
    });

    it('identical outcomes produce IDENTICAL weight updates regardless of which path decided them', () => {
      const gymReport = computeLensOutcomes(gymProvenance, gymFeed);
      const evalReport = computeLensOutcomes(evalProvenance, evalFeed);
      // The full per-lens stat records (tallies, winRate, weight) converge exactly.
      expect(evalReport.byLens).toEqual(gymReport.byLens);
      expect(lensWeightsFromReport(evalReport)).toEqual(lensWeightsFromReport(gymReport));
    });
  });

  describe('selectedCandidate — the promotion read classifies as accepted', () => {
    const verdict: EvalVerdictLike = {
      scenarioId: 'scn-promo',
      primaryScorer: 'score',
      selected: 'v-win',
      selectionReason: "selected 'v-win'",
      candidates: [
        { variantId: 'v-win', rank: 1, errored: false, primaryImprovement: 0.3 },
        { variantId: 'v-lose', rank: 2, errored: false, primaryImprovement: -0.05 },
        { variantId: 'v-err', rank: 3, errored: true },
      ],
    };
    const entries = evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z'));

    it('the promoted candidate is the one whose provenance classifies won (status: accepted)', () => {
      const winner = selectedCandidate(verdict);
      expect(winner?.variantId).toBe('v-win');
      const promotedProv = prov({
        lens: 'constraint-removal',
        routedRef: evalVerdictRef(verdict.scenarioId, winner!.variantId),
      });
      const byRef = new Map(entries.map((e) => [e.ref, e]));
      expect(byRef.get(promotedProv.routedRef)?.detail).toContain('status: accepted');
      expect(classifyIdeaOutcome(promotedProv, byRef)).toBe('won');
      // And the promotion shows up as the pinned single-win weight shift.
      const w = weightsOf([promotedProv], entries);
      expect(w['constraint-removal']).toBeCloseTo(4 / 13, 12);
    });

    it('baseline held → no promotion; measured arms classify lost, errored stays pending', () => {
      const held: EvalVerdictLike = { ...verdict, selected: undefined };
      expect(selectedCandidate(held)).toBeUndefined();
      const heldEntries = evalVerdictEntries(held, new Date('2026-06-10T01:00:00Z'));
      expect(heldEntries.length).toBe(2); // both measured arms; the errored arm emits nothing
      expect(heldEntries.every((e) => e.detail?.includes('status: rejected'))).toBe(true);
      const byRef = new Map(heldEntries.map((e) => [e.ref, e]));
      expect(
        classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: evalVerdictRef('scn-promo', 'v-win') }), byRef),
      ).toBe('lost');
      expect(
        classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: evalVerdictRef('scn-promo', 'v-err') }), byRef),
      ).toBe('pending');
    });
  });

  describe('idempotence — re-processing the same outcome event does not double-shift weights', () => {
    const verdict: EvalVerdictLike = {
      scenarioId: 'scn-idem',
      primaryScorer: 'score',
      selected: 'v-win',
      selectionReason: "selected 'v-win'",
      candidates: [
        { variantId: 'v-win', rank: 1, errored: false, primaryImprovement: 0.2 },
        { variantId: 'v-lose', rank: 2, errored: false, primaryImprovement: -0.1 },
      ],
    };
    const provenance = [
      prov({ lens: 'analogical', routedRef: evalVerdictRef('scn-idem', 'v-win'), ideaId: 'i1' }),
      prov({ lens: 'reframing', routedRef: evalVerdictRef('scn-idem', 'v-lose'), ideaId: 'i2' }),
    ];

    it('a re-emitted verdict (same refs, later timestamp) yields the identical report — wins stay 1, not 2', () => {
      const once = evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z'));
      const reEmitted = [...once, ...evalVerdictEntries(verdict, new Date('2026-06-10T02:00:00Z'))];
      const single = computeLensOutcomes(provenance, once);
      const doubled = computeLensOutcomes(provenance, reEmitted);
      // Structural idempotence: classification iterates PROVENANCE (one lookup
      // per idea), so duplicate feed entries cannot double-count an outcome.
      expect(doubled.byLens.analogical.won).toBe(1);
      expect(doubled.byLens.reframing.lost).toBe(1);
      expect(doubled).toEqual(single);
    });

    it('a duplicated gym change-feed entry does not double-count either', () => {
      const p = prov({ lens: 'first-principles', routedRef: 'gym:dup' });
      const single = computeLensOutcomes([p], [gymEntry('gym:dup', 'accepted')]);
      const doubled = computeLensOutcomes([p], [gymEntry('gym:dup', 'accepted'), gymEntry('gym:dup', 'accepted')]);
      expect(doubled.byLens['first-principles'].won).toBe(1);
      expect(doubled).toEqual(single);
    });

    it('the projection is stateless: gathering twice from the same store yields identical reports', async () => {
      const store = fakeStore();
      store.routed.push(...provenance);
      store.feed.push(...evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z')));
      const first = await gatherLensOutcomes(store.readers);
      const second = await gatherLensOutcomes(store.readers);
      expect(second).toEqual(first); // no accumulation between runs
    });

    it('a re-decided ref resolves to the newest decision under the production newest-first feed order', () => {
      // gatherCompletions sorts newest-first before the wire consumes the list,
      // and computeLensOutcomes keeps the FIRST entry per ref — so a proposal
      // re-decided later flips to its newest status, exactly once.
      const older = gymEntry('gym:flip', 'rejected', '2026-06-09T00:00:00Z');
      const newer = gymEntry('gym:flip', 'accepted', '2026-06-10T00:00:00Z');
      const p = prov({ lens: 'analogical', routedRef: 'gym:flip' });
      const r = computeLensOutcomes([p], [newer, older]); // newest-first, as production delivers
      expect(r.byLens.analogical).toMatchObject({ won: 1, lost: 0, routed: 1 });
    });
  });

  describe('full cycle through gatherLensOutcomes (fake ledger + fake feed)', () => {
    it('route one idea per lens, decide three via mixed rails, pin the resulting weights and rank', async () => {
      const store = fakeStore();
      // P-007 routes one idea per lens:
      const verdict: EvalVerdictLike = {
        scenarioId: 'cycle-eval',
        primaryScorer: 'score',
        selected: 'idea-ana',
        selectionReason: "selected 'idea-ana': primary improved by 0.2",
        candidates: [
          { variantId: 'idea-ana', rank: 1, errored: false, primaryImprovement: 0.2 },
          { variantId: 'idea-ref', rank: 2, errored: false, primaryImprovement: -0.05 },
        ],
      };
      store.routed.push(
        prov({ lens: 'analogical', routedRef: evalVerdictRef('cycle-eval', 'idea-ana'), ideaId: 'c1' }),
        prov({ lens: 'first-principles', routedRef: 'plan:fp-idea', rail: 'plan', ideaId: 'c2' }),
        prov({ lens: 'reframing', routedRef: evalVerdictRef('cycle-eval', 'idea-ref'), ideaId: 'c3' }),
        prov({ lens: 'constraint-removal', routedRef: 'gym:undecided', ideaId: 'c4' }), // never reaches the feed
      );
      // Outcomes arrive: the eval verdict decides two arms; the plan rail completes.
      store.feed.push(...evalVerdictEntries(verdict, new Date('2026-06-10T01:00:00Z')));
      store.feed.push({
        id: 'plan:fp-idea',
        kind: 'plan-run',
        title: 'Plan completed: fp-idea',
        ref: 'plan:fp-idea',
        ts: '2026-06-10T02:00:00Z',
      });

      const report = await gatherLensOutcomes(store.readers);
      expect(report.total).toBe(4);
      expect(report.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0, winRate: 1 });
      expect(report.byLens['first-principles']).toMatchObject({ won: 1, lost: 0, pending: 0, winRate: 1 });
      expect(report.byLens.reframing).toMatchObject({ won: 0, lost: 1, pending: 0, winRate: 0 });
      expect(report.byLens['constraint-removal']).toMatchObject({ won: 0, lost: 0, pending: 1, winRate: null });

      // Pinned math: r = [2/3, 2/3, 1/3, 1/2], Σr = 13/6 → weights 4/13, 4/13, 2/13, 3/13.
      expect(report.byLens.analogical.weight).toBeCloseTo(4 / 13, 12);
      expect(report.byLens['first-principles'].weight).toBeCloseTo(4 / 13, 12);
      expect(report.byLens.reframing.weight).toBeCloseTo(2 / 13, 12);
      expect(report.byLens['constraint-removal'].weight).toBeCloseTo(3 / 13, 12);

      // Rank: weight desc, equal-weight tie broken by winRate/volume/lens id —
      // and the pending lens (untouched prior) outranks the loser.
      expect(report.ranked.map((s) => s.lens)).toEqual([
        'analogical',
        'first-principles',
        'constraint-removal',
        'reframing',
      ]);

      // The D-009 hand-off shape the ideator fan-out consumes sums to 1.
      const w = lensWeightsFromReport(report);
      expect(LENS_IDENTITY_ID_LIST.reduce((a, id) => a + w[id], 0)).toBeCloseTo(1, 12);
    });
  });
});

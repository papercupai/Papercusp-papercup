/**
 * outcome-feedback.test.ts — Scout P-013 (D-009) unit tests.
 *
 * Pins the attribution chain (routed-idea provenance × change feed → lens
 * outcomes → weights), the smoothing + diversity floor on the weights, and the
 * D-004/D-009 blend in ideator allocation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChangeFeedEntry } from '../curation/change-feed';
import { CREATIVE_LENSES, SU_IDEATION_LENSES, type CreativeLens, type SuIdeationLens } from './types';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  allocateIdeators,
  gatherLensOutcomes,
  lensWeightsFromReport,
  lensWeightRowsFromReport,
  samplingWeightsWithFloor,
  winCredit,
  outcomeOfWorkItemTag,
  workItemOutcomeTag,
  SAMPLING_FLOOR_FRACTION,
  type RoutedIdeaProvenance,
  type ScoutOutcomeReaders,
} from './outcome-feedback';

describe('workItemOutcomeTag (WI-10007390)', () => {
  const tag = (status: string, over: Partial<Parameters<typeof workItemOutcomeTag>[0]> = {}) =>
    workItemOutcomeTag({ status, terminalOwner: 'su-x', triageRejected: false, ...over });

  it('a winning status is a win, with or without a terminal owner (status is the fate)', () => {
    for (const s of ['done', 'passed', 'resolved', 'closed']) {
      expect(outcomeOfWorkItemTag(tag(s))).toBe('won');
    }
    expect(outcomeOfWorkItemTag(tag('Done', { terminalOwner: null }))).toBe('won');
  });

  it('a hygiene close or a triage reject is a loss, though `closed` is a winning status', () => {
    expect(tag('closed', { terminalOwner: 'improvement-hygiene' })).toBe('rejected');
    expect(tag('done', { triageRejected: true })).toBe('rejected');
    expect(outcomeOfWorkItemTag('rejected')).toBe('lost');
  });

  it('dropped / deprecated are losses', () => {
    expect(outcomeOfWorkItemTag(tag('dropped'))).toBe('lost');
    expect(outcomeOfWorkItemTag(tag('deprecated', { terminalOwner: 'improvement-hygiene' }))).toBe('lost');
  });

  it('a live status settles nothing', () => {
    expect(tag('open')).toBeNull();
    expect(tag('wip')).toBeNull();
    expect(outcomeOfWorkItemTag(null)).toBeNull();
  });

  it('classifyIdeaOutcome reads the rejected tag back as lost', () => {
    const prov: RoutedIdeaProvenance = { ideaId: 'i1', lens: CREATIVE_LENSES[0], rail: 'improvement', routedRef: 'wi:EI-1' };
    const entry: ChangeFeedEntry = { id: 'wi:EI-1', kind: 'completion', title: 'Closed: EI-1', detail: 'Status: rejected', ref: 'wi:EI-1', ts: '2026-10-01T00:00:00.000Z' };
    expect(classifyIdeaOutcome(prov, new Map([[entry.ref, entry]]))).toBe('lost');
    const won: ChangeFeedEntry = { ...entry, detail: 'Status: done', title: 'Completed: EI-1' };
    expect(classifyIdeaOutcome(prov, new Map([[won.ref, won]]))).toBe('won');
  });
});

function prov(p: Partial<RoutedIdeaProvenance> & { lens: CreativeLens; routedRef: string }): RoutedIdeaProvenance {
  return { ideaId: p.ideaId ?? `idea-${p.routedRef}`, rail: p.rail ?? 'improvement', ...p };
}

function entry(p: Partial<ChangeFeedEntry> & { ref: string; kind: ChangeFeedEntry['kind'] }): ChangeFeedEntry {
  return { id: p.id ?? p.ref, title: p.title ?? p.ref, ts: p.ts ?? '2026-06-08T00:00:00Z', ...p };
}

describe('Scout outcome-feedback (P-013 / D-009)', () => {
  describe('classifyIdeaOutcome', () => {
    const feed = new Map<string, ChangeFeedEntry>([
      ['plan:foo', entry({ ref: 'plan:foo', kind: 'plan-run', title: 'Plan completed: foo' })],
      ['wi:EI-1', entry({ ref: 'wi:EI-1', kind: 'completion', detail: 'Status: resolved' })],
      [
        'gym:a',
        entry({ ref: 'gym:a', kind: 'proposal', title: 'Accepted prompt for worker', detail: 'Status: accepted' }),
      ],
      [
        'gym:b',
        entry({ ref: 'gym:b', kind: 'proposal', title: 'Rejected prompt for worker', detail: 'Status: rejected' }),
      ],
      [
        'gym:c',
        entry({ ref: 'gym:c', kind: 'proposal', title: 'Superseded prompt for worker', detail: 'Status: superseded' }),
      ],
      // status only in the title (detail absent) — fallback path
      ['gym:d', entry({ ref: 'gym:d', kind: 'proposal', title: 'Accepted prompt for scoper' })],
      // P-006 (SPOF 5c): a plan-run entry tagged dropped (the ABANDONED plan
      // terminal) — the plan-rail loss case.
      [
        'plan:dropped1',
        entry({ ref: 'plan:dropped1', kind: 'plan-run', title: 'Plan abandoned: dropped1', detail: 'Status: dropped' }),
      ],
      // EI-20307121130730172: the wi-rail LOSS terminals. 'deprecated' was the
      // only one recognized for two months — and it matched ZERO of 854 routed
      // refs, while 'dropped' (how work actually dies here) matched 63 and read
      // 'pending' forever. Both must classify lost.
      [
        'wi:F-DROPPED',
        entry({ ref: 'wi:F-DROPPED', kind: 'completion', title: 'Dropped: F-DROPPED', detail: 'Status: dropped' }),
      ],
      [
        'wi:F-DEPRECATED',
        entry({ ref: 'wi:F-DEPRECATED', kind: 'completion', title: 'Deprecated: F-DEPRECATED', detail: 'Status: deprecated' }),
      ],
      // P-013 / D-005 (goal rail): the ledger's goal leg emits only TERMINAL
      // goals (stop-seam TERMINAL_STATUSES), tagged "Status: <status>".
      [
        'goal:g-achieved',
        entry({ ref: 'goal:g-achieved', kind: 'completion', title: 'Goal achieved: g-achieved', detail: 'Status: achieved' }),
      ],
      [
        'goal:g-killed',
        entry({ ref: 'goal:g-killed', kind: 'completion', title: 'Goal killed: g-killed', detail: 'Status: killed' }),
      ],
    ]);

    it('pending when the routed artifact is not yet in the feed', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'plan:missing', rail: 'plan' }), feed)).toBe(
        'pending',
      );
    });

    it('plan-run present = won', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'plan:foo', rail: 'plan' }), feed)).toBe('won');
    });

    it('plan-run tagged dropped = lost (P-006 SPOF 5c: abandoned plan resolves instead of pending forever)', () => {
      expect(
        classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'plan:dropped1', rail: 'plan' }), feed),
      ).toBe('lost');
    });

    it('work-item completion present = won', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'reframing', routedRef: 'wi:EI-1', rail: 'improvement' }), feed)).toBe(
        'won',
      );
    });

    it('work-item completion tagged dropped OR deprecated = lost (EI-20307121130730172: the wi rail must have a loss channel at all)', () => {
      expect(
        classifyIdeaOutcome(prov({ lens: 'reframing', routedRef: 'wi:F-DROPPED', rail: 'improvement' }), feed),
      ).toBe('lost'); // pre-fix: no entry existed at all, so 'pending' forever
      expect(
        classifyIdeaOutcome(prov({ lens: 'reframing', routedRef: 'wi:F-DEPRECATED', rail: 'improvement' }), feed),
      ).toBe('lost');
      // CONTROL: a winning terminal on the SAME rail is untouched — the fix
      // widened the loss vocabulary, it did not make the rail loss-biased.
      expect(classifyIdeaOutcome(prov({ lens: 'reframing', routedRef: 'wi:EI-1', rail: 'improvement' }), feed)).toBe(
        'won',
      );
    });

    it('gym accepted = won, rejected/superseded = lost', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'first-principles', routedRef: 'gym:a', rail: 'gym' }), feed)).toBe(
        'won',
      );
      expect(classifyIdeaOutcome(prov({ lens: 'first-principles', routedRef: 'gym:b', rail: 'gym' }), feed)).toBe(
        'lost',
      );
      expect(classifyIdeaOutcome(prov({ lens: 'first-principles', routedRef: 'gym:c', rail: 'gym' }), feed)).toBe(
        'lost',
      );
    });

    it('reads gym status from the title when detail is absent', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'constraint-removal', routedRef: 'gym:d', rail: 'gym' }), feed)).toBe(
        'won',
      );
    });

    it("a LEGACY shared gym ref (gym:SP-NNN) classifies 'unresolvable' even with a feed entry — D-003 exclusion, P-002 (scout-su-ideate-pipeline-gaps-2026-10-08) label", () => {
      const poisoned = new Map([
        ['gym:SP-001', entry({ ref: 'gym:SP-001', kind: 'proposal', detail: 'Status: accepted' })],
      ]);
      // The frozen verdict is RIGHT THERE in the feed — and must not join. Its true
      // per-idea outcome is unknowable, so it is unresolvable, not 'pending'.
      expect(
        classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'gym:SP-001', rail: 'gym' }), poisoned),
      ).toBe('unresolvable');
      // CONTROL: a batch-stamped id (the post-fix recombine format) still joins.
      const stamped = new Map([
        ['gym:SP-mekkv1x2-001', entry({ ref: 'gym:SP-mekkv1x2-001', kind: 'proposal', detail: 'Status: accepted' })],
      ]);
      expect(
        classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'gym:SP-mekkv1x2-001', rail: 'gym' }), stamped),
      ).toBe('won');
      // CONTROL: the exclusion is gym-rail-scoped — a wi ref is untouched.
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'wi:EI-1', rail: 'improvement' }), feed)).toBe(
        'won',
      );
    });

    it('goal rail (P-013 / D-005): achieved = won, killed = lost, non-terminal (no entry) = pending', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'goal:g-achieved', rail: 'goal' }), feed)).toBe(
        'won',
      );
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'goal:g-killed', rail: 'goal' }), feed)).toBe(
        'lost',
      );
      // An active/paused goal never reaches the ledger's terminal-only goal leg.
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'goal:g-active', rail: 'goal' }), feed)).toBe(
        'pending',
      );
    });
  });

  describe('computeLensOutcomes', () => {
    it('always reports all four lenses, even with no data', () => {
      const r = computeLensOutcomes([], []);
      expect(Object.keys(r.byLens).sort()).toEqual([...CREATIVE_LENSES].sort());
      expect(r.total).toBe(0);
      for (const l of CREATIVE_LENSES) {
        expect(r.byLens[l].routed).toBe(0);
        expect(r.byLens[l].winRate).toBeNull();
      }
    });

    it('weights sum to 1 with no data and are equal (neutral prior)', () => {
      const r = computeLensOutcomes([], []);
      const total = CREATIVE_LENSES.reduce((a, l) => a + r.byLens[l].weight, 0);
      expect(total).toBeCloseTo(1, 9);
      const w0 = r.byLens[CREATIVE_LENSES[0]].weight;
      for (const l of CREATIVE_LENSES) expect(r.byLens[l].weight).toBeCloseTo(w0, 9);
    });

    it('tallies won/lost/pending per lens and computes winRate over decided only', () => {
      const completions: ChangeFeedEntry[] = [
        entry({ ref: 'gym:w1', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:w2', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:l1', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'plan:p1', kind: 'plan-run' }),
      ];
      const provenance: RoutedIdeaProvenance[] = [
        prov({ lens: 'analogical', routedRef: 'gym:w1', rail: 'gym' }),
        prov({ lens: 'analogical', routedRef: 'gym:w2', rail: 'gym' }),
        prov({ lens: 'analogical', routedRef: 'gym:l1', rail: 'gym' }),
        prov({ lens: 'analogical', routedRef: 'gym:pending', rail: 'gym' }), // not in feed
        prov({ lens: 'reframing', routedRef: 'plan:p1', rail: 'plan' }),
      ];
      const r = computeLensOutcomes(provenance, completions);
      const a = r.byLens.analogical;
      expect(a.routed).toBe(4);
      expect(a.won).toBe(2);
      expect(a.lost).toBe(1);
      expect(a.pending).toBe(1);
      expect(a.winRate).toBeCloseTo(2 / 3, 9); // decided = 3, pending excluded
      expect(r.byLens.reframing.won).toBe(1);
      expect(r.byLens.reframing.winRate).toBe(1);
      expect(r.total).toBe(5);
    });

    it('a winning lens outweighs a losing lens, but the floor keeps the loser alive', () => {
      const completions: ChangeFeedEntry[] = [
        entry({ ref: 'gym:win1', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:win2', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:win3', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:lose1', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'gym:lose2', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'gym:lose3', kind: 'proposal', detail: 'Status: rejected' }),
      ];
      const provenance: RoutedIdeaProvenance[] = [
        ...['gym:win1', 'gym:win2', 'gym:win3'].map((ref) => prov({ lens: 'analogical', routedRef: ref, rail: 'gym' })),
        ...['gym:lose1', 'gym:lose2', 'gym:lose3'].map((ref) =>
          prov({ lens: 'reframing', routedRef: ref, rail: 'gym' }),
        ),
      ];
      const r = computeLensOutcomes(provenance, completions, { minShare: 0.05 });
      expect(r.byLens.analogical.weight).toBeGreaterThan(r.byLens.reframing.weight);
      // The losing lens is floored, never zeroed (diversity guarantee).
      expect(r.byLens.reframing.weight).toBeGreaterThanOrEqual(0.05 - 1e-9);
      // Weights still normalize to 1.
      const total = CREATIVE_LENSES.reduce((a, l) => a + r.byLens[l].weight, 0);
      expect(total).toBeCloseTo(1, 9);
      // ranked is best-first.
      expect(r.ranked[0].lens).toBe('analogical');
    });

    it('respects the minShare floor', () => {
      const completions: ChangeFeedEntry[] = Array.from({ length: 10 }, (_, i) =>
        entry({ ref: `gym:w${i}`, kind: 'proposal', detail: 'Status: accepted' }),
      );
      const provenance = completions.map((e) => prov({ lens: 'analogical', routedRef: e.ref, rail: 'gym' }));
      const r = computeLensOutcomes(provenance, completions, { minShare: 0.1 });
      for (const l of CREATIVE_LENSES) expect(r.byLens[l].weight).toBeGreaterThanOrEqual(0.1 - 1e-9);
    });
  });

  describe('grade credit (scout-idea-grading C-5 / D-002)', () => {
    it('winCredit pins the C-5 line: (grade − 1) / 4', () => {
      expect(winCredit(1)).toBe(0);
      expect(winCredit(2)).toBe(0.25);
      expect(winCredit(3)).toBe(0.5);
      expect(winCredit(4)).toBe(0.75);
      expect(winCredit(5)).toBe(1);
    });

    it('a graded idea contributes credit/1−credit to its lens — even with NO feed entry (decided by the grader)', () => {
      const r = computeLensOutcomes(
        [
          prov({ lens: 'analogical', routedRef: 'gym:none-a', humanGrade: 5, gradedBy: 'owner' }),
          prov({ lens: 'reframing', routedRef: 'gym:none-b', humanGrade: 4, gradedBy: 'Queen', ideaId: 'g4' }),
          prov({ lens: 'first-principles', routedRef: 'gym:none-c', humanGrade: 3, gradedBy: 'owner', ideaId: 'g3' }),
          prov({ lens: 'constraint-removal', routedRef: 'gym:none-d', humanGrade: 1, gradedBy: 'owner', ideaId: 'g1' }),
        ],
        [], // empty feed: every grade still decides its idea
      );
      expect(r.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0, winRate: 1 });
      expect(r.byLens.reframing).toMatchObject({ won: 0.75, lost: 0.25, pending: 0, winRate: 0.75 });
      expect(r.byLens['first-principles']).toMatchObject({ won: 0.5, lost: 0.5, pending: 0, winRate: 0.5 });
      expect(r.byLens['constraint-removal']).toMatchObject({ won: 0, lost: 1, pending: 0, winRate: 0 });
      // The routed invariant survives fractional credit: won + lost + pending === routed.
      for (const l of CREATIVE_LENSES) {
        const s = r.byLens[l];
        expect(s.won + s.lost + s.pending).toBeCloseTo(s.routed, 12);
      }
    });

    it('the grade DOMINATES the change-feed outcome in the tally (D-002), both directions', () => {
      const feed = [
        entry({ ref: 'gym:fed-win', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:fed-loss', kind: 'proposal', detail: 'Status: rejected' }),
      ];
      const r = computeLensOutcomes(
        [
          // Feed says won, grader says 1 → counts as pure loss mass.
          prov({ lens: 'analogical', routedRef: 'gym:fed-win', humanGrade: 1, gradedBy: 'owner' }),
          // Feed says lost, grader says 5 → counts as pure win mass.
          prov({ lens: 'reframing', routedRef: 'gym:fed-loss', humanGrade: 5, gradedBy: 'Queen' }),
        ],
        feed,
      );
      expect(r.byLens.analogical).toMatchObject({ won: 0, lost: 1 });
      expect(r.byLens.reframing).toMatchObject({ won: 1, lost: 0 });
    });

    it('classifyIdeaOutcome stays GRADE-BLIND — the persisted outcome column keeps the system verdict (D-002)', () => {
      const feed = new Map([
        ['gym:fed-win', entry({ ref: 'gym:fed-win', kind: 'proposal' as const, detail: 'Status: accepted' })],
      ]);
      const graded1 = prov({ lens: 'analogical', routedRef: 'gym:fed-win', humanGrade: 1, gradedBy: 'owner' });
      expect(classifyIdeaOutcome(graded1, feed)).toBe('won'); // feed verdict, not the grade
      const gradedPending = prov({ lens: 'analogical', routedRef: 'gym:absent', humanGrade: 5, gradedBy: 'owner' });
      expect(classifyIdeaOutcome(gradedPending, feed)).toBe('pending');
    });

    it('an invalid grade (out of range / fractional / NaN) is treated as ungraded, not poison', () => {
      const feed = [entry({ ref: 'gym:w', kind: 'proposal', detail: 'Status: accepted' })];
      for (const bad of [0, 6, 2.5, NaN, Infinity]) {
        const r = computeLensOutcomes(
          [prov({ lens: 'analogical', routedRef: 'gym:w', humanGrade: bad, gradedBy: 'owner' })],
          feed,
        );
        // Falls back to the change-feed path: a clean integer win.
        expect(r.byLens.analogical).toMatchObject({ won: 1, lost: 0, pending: 0 });
      }
      // …and an invalid grade on a feed-absent idea stays pending.
      const r = computeLensOutcomes(
        [prov({ lens: 'reframing', routedRef: 'gym:absent', humanGrade: 0, gradedBy: 'owner' })],
        feed,
      );
      expect(r.byLens.reframing).toMatchObject({ won: 0, lost: 0, pending: 1 });
    });

    it('grade extremes converge with feed terminals in weight space: grade 5 ≡ accepted, grade 1 ≡ rejected', () => {
      const byGrade5 = computeLensOutcomes(
        [prov({ lens: 'analogical', routedRef: 'gym:ungraded-x', humanGrade: 5, gradedBy: 'owner' })],
        [],
      );
      const byFeedWin = computeLensOutcomes(
        [prov({ lens: 'analogical', routedRef: 'gym:w' })],
        [entry({ ref: 'gym:w', kind: 'proposal', detail: 'Status: accepted' })],
      );
      expect(lensWeightsFromReport(byGrade5)).toEqual(lensWeightsFromReport(byFeedWin));

      const byGrade1 = computeLensOutcomes(
        [prov({ lens: 'reframing', routedRef: 'gym:ungraded-y', humanGrade: 1, gradedBy: 'Queen' })],
        [],
      );
      const byFeedLoss = computeLensOutcomes(
        [prov({ lens: 'reframing', routedRef: 'gym:l' })],
        [entry({ ref: 'gym:l', kind: 'proposal', detail: 'Status: rejected' })],
      );
      expect(lensWeightsFromReport(byGrade1)).toEqual(lensWeightsFromReport(byFeedLoss));
    });

    it('grade 3 is exactly neutral under the Beta(1,1) prior: weights stay at the uniform baseline', () => {
      const r = computeLensOutcomes(
        [prov({ lens: 'analogical', routedRef: 'gym:meh', humanGrade: 3, gradedBy: 'owner' })],
        [],
      );
      // r_analogical = (0.5 + 1) / (1 + 2) = 1/2 — identical to an untouched lens.
      for (const l of CREATIVE_LENSES) expect(r.byLens[l].weight).toBeCloseTo(1 / 4, 12);
    });

    it('lensWeightRowsFromReport carries the fractional masses (wins/decided) for the weight upsert', () => {
      const report = computeLensOutcomes(
        [prov({ lens: 'analogical', routedRef: 'gym:none', humanGrade: 4, gradedBy: 'owner' })],
        [],
      );
      const rows = lensWeightRowsFromReport(report);
      const ana = rows.find((x) => x.lens === 'analogical');
      expect(ana).toMatchObject({ wins: 0.75, decided: 1 });
    });
  });

  describe('lensWeightsFromReport (D-009 hook for runIdeators)', () => {
    it('projects each lens weight into the runIdeators lensWeights shape (summing ~1)', () => {
      const report = computeLensOutcomes([], []);
      const w = lensWeightsFromReport(report);
      expect(Object.keys(w).sort()).toEqual([...CREATIVE_LENSES].sort());
      const total = CREATIVE_LENSES.reduce((a, l) => a + w[l], 0);
      expect(total).toBeCloseTo(1, 9);
    });
  });

  describe('allocateIdeators (D-004 forced diversity × D-009 weighting)', () => {
    const completions: ChangeFeedEntry[] = [
      entry({ ref: 'gym:a1', kind: 'proposal', detail: 'Status: accepted' }),
      entry({ ref: 'gym:a2', kind: 'proposal', detail: 'Status: accepted' }),
      entry({ ref: 'gym:a3', kind: 'proposal', detail: 'Status: accepted' }),
    ];
    const provenance = completions.map((e) => prov({ lens: 'analogical', routedRef: e.ref, rail: 'gym' }));
    const report = computeLensOutcomes(provenance, completions);

    it('n == 0 → empty', () => {
      expect(allocateIdeators(report, 0)).toEqual([]);
    });

    it('n >= lensCount → every lens gets at least one slot (exploration guarantee)', () => {
      const alloc = allocateIdeators(report, 8);
      expect(alloc).toHaveLength(8);
      for (const l of CREATIVE_LENSES) expect(alloc).toContain(l);
      // The winning lens gets MORE than its 1 guaranteed slot.
      const counts = countBy(alloc);
      expect(counts.analogical).toBeGreaterThan(1);
    });

    it('n < lensCount → the top-n lenses by weight', () => {
      const alloc = allocateIdeators(report, 2);
      expect(alloc).toHaveLength(2);
      expect(alloc[0]).toBe('analogical'); // highest weight first
      expect(new Set(alloc).size).toBe(2); // distinct
    });

    it('is deterministic', () => {
      expect(allocateIdeators(report, 7)).toEqual(allocateIdeators(report, 7));
    });
  });

  describe('gatherLensOutcomes', () => {
    it('reads both sources and computes the report', async () => {
      const readers: ScoutOutcomeReaders = {
        async routedIdeas() {
          return [prov({ lens: 'first-principles', routedRef: 'plan:x', rail: 'plan' })];
        },
        async completions() {
          return [entry({ ref: 'plan:x', kind: 'plan-run' })];
        },
      };
      const r = await gatherLensOutcomes(readers);
      expect(r.total).toBe(1);
      expect(r.byLens['first-principles'].won).toBe(1);
    });

    it('survives a reader throwing (degrades to empty, no throw)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const readers: ScoutOutcomeReaders = {
        async routedIdeas() {
          throw new Error('PG down');
        },
        async completions() {
          return [];
        },
      };
      const r = await gatherLensOutcomes(readers);
      expect(r.total).toBe(0);
    });
  });

  describe('lensWeightRowsFromReport (P-033 upsert math)', () => {
    it('projects every lens into a {wins, decided, weight} row matching the report stats', () => {
      const provenance = [
        prov({ lens: 'analogical', routedRef: 'gym:a', rail: 'gym' }), // won
        prov({ lens: 'analogical', routedRef: 'gym:b', rail: 'gym', ideaId: 'a2' }), // lost
        prov({ lens: 'reframing', routedRef: 'plan:foo', rail: 'plan' }), // won
        prov({ lens: 'reframing', routedRef: 'plan:nope', rail: 'plan', ideaId: 'r2' }), // pending
      ];
      const completions = [
        entry({ ref: 'gym:a', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:b', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'plan:foo', kind: 'plan-run' }),
      ];
      const report = computeLensOutcomes(provenance, completions);
      const rows = lensWeightRowsFromReport(report);

      expect(rows.map((r) => r.lens).sort()).toEqual([...CREATIVE_LENSES].sort());
      const byLens = Object.fromEntries(rows.map((r) => [r.lens, r]));
      // analogical: 1 won + 1 lost → wins 1, decided 2 (pending excluded).
      expect(byLens.analogical).toMatchObject({ wins: 1, decided: 2 });
      // reframing: 1 won + 1 pending → wins 1, decided 1.
      expect(byLens.reframing).toMatchObject({ wins: 1, decided: 1 });
      // untouched lenses: 0/0, but still present (the full roster persists).
      expect(byLens['first-principles']).toMatchObject({ wins: 0, decided: 0 });
      expect(byLens['constraint-removal']).toMatchObject({ wins: 0, decided: 0 });
      // The persisted weight IS the report's normalized sampling share.
      for (const r of rows) expect(r.weight).toBe(report.byLens[r.lens].weight);
      expect(rows.reduce((a, r) => a + r.weight, 0)).toBeCloseTo(1, 10);
    });
  });

  describe('samplingWeightsWithFloor (P-033 read-back)', () => {
    const uniform = 1 / CREATIVE_LENSES.length;
    const floor = SAMPLING_FLOOR_FRACTION * uniform;

    it('falls back to uniform on empty / missing / all-zero input', () => {
      for (const raw of [undefined, null, {}, { analogical: 0 }, { analogical: -1, reframing: NaN }] as const) {
        const w = samplingWeightsWithFloor(raw as never);
        for (const l of CREATIVE_LENSES) expect(w[l]).toBeCloseTo(uniform, 10);
      }
    });

    it('respects relative weights (winning lens gets the larger share) and sums to 1', () => {
      const w = samplingWeightsWithFloor({
        analogical: 0.6,
        'first-principles': 0.2,
        reframing: 0.1,
        'constraint-removal': 0.1,
      });
      expect(w.analogical).toBeGreaterThan(w['first-principles']);
      expect(w['first-principles']).toBeGreaterThan(w.reframing);
      expect(w.reframing).toBeCloseTo(w['constraint-removal'], 10);
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 10);
    });

    it('clamps every lens at ≥ 15% of uniform — a zero/missing lens is never starved', () => {
      // One dominant lens, the rest absent from the persisted set.
      const w = samplingWeightsWithFloor<CreativeLens>({ analogical: 5 });
      for (const l of CREATIVE_LENSES) expect(w[l]).toBeGreaterThanOrEqual(floor - 1e-12);
      // The absent lenses sit exactly on the floor; the dominant lens takes the rest.
      expect(w.reframing).toBeCloseTo(floor, 10);
      expect(w.analogical).toBeCloseTo(1 - 3 * floor, 10);
      expect(CREATIVE_LENSES.reduce((a, l) => a + w[l], 0)).toBeCloseTo(1, 10);
    });

    it('preserves the raw ordering after flooring', () => {
      const w = samplingWeightsWithFloor({
        analogical: 0.01,
        'first-principles': 0.02,
        reframing: 0.9,
        'constraint-removal': 0.07,
      });
      expect(w.reframing).toBeGreaterThan(w['constraint-removal']);
      expect(w['constraint-removal']).toBeGreaterThan(w['first-principles']);
      expect(w['first-principles']).toBeGreaterThan(w.analogical);
    });

    it('honors a custom floorFraction (0 → pure normalization)', () => {
      const w = samplingWeightsWithFloor<CreativeLens>({ analogical: 3, reframing: 1 }, { floorFraction: 0 });
      expect(w.analogical).toBeCloseTo(0.75, 10);
      expect(w.reframing).toBeCloseTo(0.25, 10);
      expect(w['first-principles']).toBe(0);
      expect(w['constraint-removal']).toBe(0);
    });
  });

  describe('lens roster generalization (su-ideate-learning-substrate P-004)', () => {
    // su provenance rows carry SuIdeationLens / sentinel text in the ledger's
    // lens column — the cast mirrors the read path (DB text → provenance).
    const suProv = (lens: string, routedRef: string, extra: Partial<RoutedIdeaProvenance> = {}) =>
      prov({ lens: lens as CreativeLens, routedRef, ...extra });
    const suRows: RoutedIdeaProvenance[] = [
      suProv('risk-first', 'wi:SU-1'), // in the feed → won
      suProv('user-value', 'wi:SU-2', { humanGrade: 5 }), // graded — dominates (won mass 1)
      suProv('su-ideate', 'wi:SU-3'), // sentinel: no roster lens, counted in total only
    ];
    const suFeed = [entry({ ref: 'wi:SU-1', kind: 'completion', detail: 'Status: resolved' })];

    it('lenses: SU_IDEATION_LENSES — full 7-lens roster, sentinel excluded from per-lens stats but in total', () => {
      const r = computeLensOutcomes(suRows, suFeed, { lenses: SU_IDEATION_LENSES });
      expect(Object.keys(r.byLens).sort()).toEqual([...SU_IDEATION_LENSES].sort());
      expect('su-ideate' in r.byLens).toBe(false);
      expect(r.total).toBe(3); // the sentinel row still counts
      expect(r.byLens['risk-first']).toMatchObject({ routed: 1, won: 1, lost: 0, winRate: 1 });
      expect(r.byLens['user-value']).toMatchObject({ routed: 1, won: 1, lost: 0, winRate: 1 });
      expect(r.byLens.analogical.routed).toBe(0);
      expect(r.ranked).toHaveLength(SU_IDEATION_LENSES.length);
      const sum = SU_IDEATION_LENSES.reduce((a, l) => a + r.byLens[l].weight, 0);
      expect(sum).toBeCloseTo(1, 10);
    });

    it('the DEFAULT roster is unchanged: su-lens rows enter no per-lens stat, only the total', () => {
      const r = computeLensOutcomes(suRows, suFeed);
      expect(Object.keys(r.byLens).sort()).toEqual([...CREATIVE_LENSES].sort());
      expect(r.total).toBe(3);
      for (const l of CREATIVE_LENSES) expect(r.byLens[l].routed).toBe(0);
    });

    it('samplingWeightsWithFloor over a custom roster: absent lenses land exactly on the floor, sum 1', () => {
      const w = samplingWeightsWithFloor<SuIdeationLens>(
        { 'user-value': 3, 'risk-first': 1 },
        { lenses: SU_IDEATION_LENSES },
      );
      const n = SU_IDEATION_LENSES.length;
      const floor = SAMPLING_FLOOR_FRACTION / n;
      expect(w['cost-leverage']).toBeCloseTo(floor, 10); // no raw weight → exactly the floor
      expect(w.analogical).toBeCloseTo(floor, 10);
      expect(w['user-value']).toBeGreaterThan(w['risk-first']);
      expect(w['risk-first']).toBeGreaterThan(floor);
      const sum = SU_IDEATION_LENSES.reduce((a, l) => a + w[l], 0);
      expect(sum).toBeCloseTo(1, 10);
    });
  });
});

function countBy(arr: CreativeLens[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}

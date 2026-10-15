/**
 * P-004 dedup calibration (plan scout-su-ideate-pipeline-gaps-2026-10-08, BARs R-7 / R-8,
 * decisions D-002 + D-003). Pinned to MEASURED fixtures (dedup-calibration.fixture.ts):
 * 11 manually labeled scout pairs with their real texts, real stored cosines, the real
 * cosine distribution of each idea against the vector-bearing corpus, and the real
 * competing corpus titles.
 *
 *  R-8 (true duplicates still merge): stage 1 RECALLS the twin into the shortlist, and a
 *      critic duplicateOf naming it MERGES the idea.
 *  R-7 (distinct same-domain ideas survive): the deterministic stage never rejects a
 *      labeled-distinct idea, and a null duplicateOf keeps it.
 *
 * The LLM's adjudication QUALITY (does it say duplicateOf for the 7 and null for the 4?)
 * is not claimable from a unit test — D-002 assigns it to a live-tick check. What is
 * pinned here is everything deterministic around it, including the two error rates of
 * the P-017 semantic ceiling that motivated D-003, so a regression to it is visible.
 */
import { describe, expect, it } from 'vitest';

import { corpusNovelty, DEFAULT_BUCKET_OPTIONS, DEFAULT_CORPUS_NOVELTY_OPTIONS, type CorpusEntry } from './critique-core';
import { applyDuplicateVerdict, critiqueIdeas } from './critics';
import { CALIBRATION_PAIRS, type CalibrationPair } from './dedup-calibration.fixture';
import type { Idea, ScoredIdea, ScoutLlmCall } from './types';

const NOVELTY_FLOOR = DEFAULT_BUCKET_OPTIONS.noveltyFloor;
const SHORTLIST = DEFAULT_CORPUS_NOVELTY_OPTIONS.shortlistSize;
const dups = CALIBRATION_PAIRS.filter((p) => p.label === 'dup');
const distinct = CALIBRATION_PAIRS.filter((p) => p.label === 'distinct');

/**
 * A 100-entry background reproducing the idea's measured cosine distribution: piecewise
 * linear through the measured p50/p75/p90/p95/p99, with the real nearest non-twin
 * cosines as the top entries. With the twin added (101 entries) the calibration's
 * q0.9 index lands exactly on the measured p90.
 */
function backgroundCosines(bg: CalibrationPair['background']): number[] {
  const knots: Array<[number, number]> = [
    [0, bg.p50 - 0.15],
    [50, bg.p50],
    [75, bg.p75],
    [90, bg.p90],
    [95, bg.p95],
    [99, bg.p99],
  ];
  const at = (i: number): number => {
    for (let k = 1; k < knots.length; k++) {
      const [x1, y1] = knots[k];
      const [x0, y0] = knots[k - 1];
      if (i <= x1) return y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
    }
    return knots[knots.length - 1][1];
  };
  const values = Array.from({ length: 100 }, (_, i) => at(i));
  const nearest = [...bg.nearest].sort((a, b) => a - b);
  for (let j = 0; j < nearest.length; j++) values[100 - nearest.length + j] = nearest[j];
  return values;
}

/** Semantic scenario: the twin (title text) + 100 lexically-disjoint background priors. */
function semanticCase(p: CalibrationPair): { corpus: CorpusEntry[]; sims: Map<string, number> } {
  const bg = backgroundCosines(p.background);
  const corpus: CorpusEntry[] = [
    { ref: p.twinRef, kind: 'idea', text: p.twinTitle },
    ...bg.map((_, i) => ({ ref: `bg:${i}`, kind: 'idea' as const, text: `qqzz${i} xxyyfiller` })),
  ];
  const sims = new Map<string, number>([[p.twinRef, p.twinCosine], ...bg.map((c, i) => [`bg:${i}`, c] as const)]);
  return { corpus, sims };
}

/** Lexical-only scenario (the semantic leg unavailable): the twin + its real competitors. */
function lexicalCase(p: CalibrationPair): CorpusEntry[] {
  return [
    { ref: p.twinRef, kind: 'idea', text: p.twinTitle },
    ...p.competitors.map((c) => ({ ref: c.ref, kind: 'idea' as const, text: c.text })),
  ];
}

function scored(p: CalibrationPair, novelty: number): ScoredIdea {
  return {
    idea: { id: p.ideaRef, lens: 'first-principles', title: p.query.slice(0, 80), body: p.query, mechanism: '', addressesPatternRefs: [] },
    novelty,
    feasibility: 0.8,
    noveltyMatches: [],
    verdict: 'keep',
    notes: 'critic notes',
  };
}

describe('fixture integrity (the measurements the rest of this file rests on)', () => {
  it('carries the 7 restatements and 4 same-problem/different-mechanism pairs that were labeled', () => {
    expect(dups.map((p) => p.pair)).toEqual([1, 4, 11, 13, 17, 18, 20]);
    expect(distinct.map((p) => p.pair)).toEqual([2, 12, 14, 16]);
  });
  it('no cosine threshold separates the labels (why D-002 adjudicates instead of tuning)', () => {
    const dupCos = dups.map((p) => p.twinCosine);
    const distinctCos = distinct.map((p) => p.twinCosine);
    expect(Math.max(...distinctCos)).toBeGreaterThan(Math.min(...dupCos));
    expect(Math.min(...distinctCos)).toBeLessThan(Math.max(...dupCos));
  });
});

describe('R-8 stage-1 recall — semantic leg resolved', () => {
  it.each(dups)('pair #$pair: the twin is shortlisted (rank 1 of $background.count corpus entries)', (p) => {
    const { corpus, sims } = semanticCase(p);
    const cn = corpusNovelty(p.query, corpus, { semanticSimByRef: sims, semanticLowersNovelty: false });
    expect(cn.shortlist.length).toBeLessThanOrEqual(SHORTLIST);
    expect(cn.shortlist[0]?.ref).toBe(p.twinRef);
  });
  it('recall is 7 of 7 duplicates (selection-biased: twins are nearest neighbours by construction)', () => {
    const recalled = dups.filter((p) => {
      const { corpus, sims } = semanticCase(p);
      return corpusNovelty(p.query, corpus, { semanticSimByRef: sims }).shortlist.some((m) => m.ref === p.twinRef);
    });
    expect(recalled.length).toBe(7);
  });
});

describe('R-8 stage-1 recall — semantic leg UNAVAILABLE (lexical only)', () => {
  it('recall is 4 of 7 duplicates: lexical recall misses #11, #17, #20 — the semantic leg is the lever', () => {
    const recalled = dups.filter((p) => corpusNovelty(p.query, lexicalCase(p)).shortlist.some((m) => m.ref === p.twinRef));
    expect(recalled.map((p) => p.pair)).toEqual([1, 4, 13, 18]);
    // Each verdict agrees with the twin's measured rank among the real ~1,000 titles.
    for (const p of dups) expect(recalled.includes(p)).toBe(p.lexicalRank <= SHORTLIST);
  });
  it('a 0.2 recall floor would recall nothing lexically: restatement Jaccard is 0.05-0.15', () => {
    for (const p of dups) {
      const cn = corpusNovelty(p.query, lexicalCase(p), { recallFloor: 0.2 });
      expect(cn.shortlist.some((m) => m.ref === p.twinRef)).toBe(false);
    }
  });
});

describe('R-8 stage-2 merge (applyDuplicateVerdict)', () => {
  it.each(dups)('pair #$pair: duplicateOf = the shortlisted twin merges the idea', (p) => {
    const { corpus, sims } = semanticCase(p);
    const cn = corpusNovelty(p.query, corpus, { semanticSimByRef: sims, semanticLowersNovelty: false });
    const out = applyDuplicateVerdict(scored(p, cn.novelty), cn.shortlist.map((m) => m.ref), p.twinRef);
    expect(out.verdict).toBe('reject');
    expect(out.duplicateOf).toBe(p.twinRef);
    expect(out.notes.startsWith(`duplicate of ${p.twinRef}`)).toBe(true);
  });
  it('a hallucinated / unshortlisted duplicateOf is ignored, never merged', () => {
    const p = dups[0];
    const s = scored(p, 0.9);
    expect(applyDuplicateVerdict(s, ['wi:EI-SHORTLISTED'], 'wi:EI-NOT-SHOWN')).toBe(s);
    expect(applyDuplicateVerdict(s, ['wi:EI-SHORTLISTED'], null)).toBe(s);
    expect(applyDuplicateVerdict(s, [], p.twinRef)).toBe(s);
  });
});

describe('R-7 distinct same-domain ideas survive', () => {
  it.each(distinct)('pair #$pair: the deterministic stage does not reject it (semantic leg resolved)', (p) => {
    const { corpus, sims } = semanticCase(p);
    const cn = corpusNovelty(p.query, corpus, { semanticSimByRef: sims, semanticLowersNovelty: false });
    expect(cn.novelty).toBeGreaterThanOrEqual(NOVELTY_FLOOR);
    expect(cn.alreadyTried).toBe(false);
    // It IS a duplicate candidate for the critic — recall is not a verdict…
    expect(cn.shortlist.some((m) => m.ref === p.twinRef)).toBe(true);
    // …and a null duplicateOf keeps it.
    const kept = scored(p, cn.novelty);
    expect(applyDuplicateVerdict(kept, cn.shortlist.map((m) => m.ref), null)).toBe(kept);
  });
  it.each(distinct)('pair #$pair: the deterministic stage does not reject it (lexical only)', (p) => {
    expect(corpusNovelty(p.query, lexicalCase(p)).novelty).toBeGreaterThanOrEqual(NOVELTY_FLOOR);
  });
});

describe('D-003 control: the P-017 semantic CEILING errs in both directions on these pairs', () => {
  const rejectedByCeiling = (p: CalibrationPair): boolean => {
    const { corpus, sims } = semanticCase(p);
    return corpusNovelty(p.query, corpus, { semanticSimByRef: sims }).novelty < NOVELTY_FLOOR;
  };
  it('false reject: distinct pair #2 would be rejected (1 of 4 distinct)', () => {
    expect(distinct.filter(rejectedByCeiling).map((p) => p.pair)).toEqual([2]);
  });
  it('missed duplicates: only #1 and #4 would be caught (2 of 7)', () => {
    expect(dups.filter(rejectedByCeiling).map((p) => p.pair)).toEqual([1, 4]);
  });
});

describe('critiqueIdeas: a merged duplicate is never re-bucketed', () => {
  const ideaA: Idea = { id: 'a', lens: 'reframing', title: 'Alpha idea', body: 'alpha body', mechanism: 'm', addressesPatternRefs: [] };
  const ideaB: Idea = { id: 'b', lens: 'analogical', title: 'Beta idea', body: 'beta body', mechanism: 'm', addressesPatternRefs: [] };
  const corpus: CorpusEntry[] = [{ ref: 'wi:EI-PRIOR', kind: 'idea', text: 'Alpha idea restated' }];
  const llmCall: ScoutLlmCall = async (opts) => {
    const user = opts.messages.map((m) => m.content).join('\n');
    const isA = user.includes('Title: Alpha idea');
    const json = {
      conceptualNovelty: 0.9,
      feasibility: 0.9,
      // A claims a shortlisted prior; B claims a ref it was never shown.
      duplicateOf: isA ? 'wi:EI-PRIOR' : 'wi:EI-HALLUCINATED',
      rationale: 'fake critic',
    };
    return { text: JSON.stringify(json), json, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  };

  it('merges A (shortlisted claim), keeps B (hallucinated claim ignored), and records the leg', async () => {
    const r = await critiqueIdeas([ideaA, ideaB], corpus, { llmCall });
    const a = r.critiques.find((c) => c.idea.id === 'a')!;
    const b = r.critiques.find((c) => c.idea.id === 'b')!;
    expect(a.verdict).toBe('reject');
    expect(a.duplicateOf).toBe('wi:EI-PRIOR');
    expect(r.rejected).toContain(a);
    expect(r.kept).not.toContain(a);
    expect(b.duplicateOf).toBeUndefined();
    expect(b.verdict).toBe('keep');
    expect(r.kept).toContain(b);
    // Under Vitest without injected deps the leg is inert — and SAYS so.
    expect(a.semanticLeg).toEqual({ status: 'disabled', reason: 'vitest-inert' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyWithCurrentGuard,
  classifyWithHybrid,
  classifyWithLibrary,
  GUARD_CANDIDATE_LIMIT,
  HYBRID_TITLE_FLOOR,
  pairedArmDivergence,
  summarizeComparison,
  type ApproachVerdict,
  type FilingObservation,
  type ScoredObservation,
} from './near-duplicate-guard-compare';

/** 256 background cosines spread evenly over [0.60, 0.855): the nearest-rank p95 is 0.84248… */
const BACKGROUND = Array.from({ length: 256 }, (_, i) => 0.6 + (0.255 * i) / 256);

function obs(partial: Partial<FilingObservation> & Pick<FilingObservation, 'top'>): FilingObservation {
  return {
    filingId: 'F-1',
    partnerId: partial.top[0]?.id ?? null,
    label: 'duplicate',
    poolSize: 1000,
    background: BACKGROUND,
    partner: partial.top[0] ? { cosine: partial.top[0].cosine, titleSimilarity: partial.top[0].titleSimilarity, rank: 1 } : null,
    ...partial,
  };
}

describe('classifyWithCurrentGuard (the real semantic-dupe-guard)', () => {
  it('flags a hard cosine and a co-signal pair, not an ordinary-cosine pair with a dissimilar title', async () => {
    const o = obs({
      top: [
        { id: 'HARD', cosine: 0.94, titleSimilarity: 0.1 },
        { id: 'COSIGNAL', cosine: 0.87, titleSimilarity: 0.5 },
        { id: 'ORDINARY', cosine: 0.89, titleSimilarity: 0.2 },
        { id: 'LOW-TITLE-MATCH', cosine: 0.8, titleSimilarity: 0.9 },
      ],
    });
    const v = await classifyWithCurrentGuard(o, 'new filing', 'papercusp');
    expect(v.noVerdict).toBe(false);
    expect(v.flagged.sort()).toEqual(['COSIGNAL', 'HARD']);
  });
});

describe('classifyWithLibrary (the real checkNearDuplicates)', () => {
  it('flags every candidate at or above the p95 of the background', async () => {
    const o = obs({
      top: [
        { id: 'A', cosine: 0.88, titleSimilarity: 0 },
        { id: 'B', cosine: 0.845, titleSimilarity: 0 },
        { id: 'C', cosine: 0.83, titleSimilarity: 0 },
      ],
    });
    const v = await classifyWithLibrary(o);
    expect(v.noVerdict).toBe(false);
    expect(v.cut).toBeCloseTo(0.6 + (0.255 * 243) / 256, 9);
    expect(v.flagged).toEqual(['A', 'B']);
  });

  it('returns no verdict (and flags nothing) when the background is too small to calibrate', async () => {
    const v = await classifyWithLibrary(obs({ top: [{ id: 'A', cosine: 0.99, titleSimilarity: 1 }], background: BACKGROUND.slice(0, 10) }));
    expect(v).toEqual({ flagged: [], noVerdict: true });
  });
});

describe('classifyWithHybrid (hypothetical: calibrated cut inside the co-signal)', () => {
  it('needs the title floor below the hard cut and flags nothing on cut alone', () => {
    const o = obs({
      top: [
        { id: 'HARD', cosine: 0.95, titleSimilarity: 0 },
        { id: 'CUT+TITLE', cosine: 0.85, titleSimilarity: 0.5 },
        { id: 'CUT-ONLY', cosine: 0.9, titleSimilarity: 0.1 },
      ],
    });
    const library: ApproachVerdict = { flagged: [], noVerdict: false, cut: 0.84 };
    expect(classifyWithHybrid(o, library, 0.93).flagged).toEqual(['HARD', 'CUT+TITLE']);
    expect(classifyWithHybrid(o, { flagged: [], noVerdict: true }, 0.93).flagged).toEqual(['HARD']);
  });

  it('uses the same title floor as the production guard', () => {
    const src = readFileSync(new URL('../../agent-tools/work_items/semantic-dupe-guard.ts', import.meta.url), 'utf8');
    const m = src.match(/const CO_SIGNAL_MIN_TITLE = ([0-9.]+);/);
    expect(m, 'CO_SIGNAL_MIN_TITLE declaration not found in semantic-dupe-guard.ts').not.toBeNull();
    expect(Number(m![1])).toBe(HYBRID_TITLE_FLOOR);
  });
});

describe('summarizeComparison', () => {
  const verdict = (flagged: string[]): ApproachVerdict => ({ flagged, noVerdict: false });
  const row = (o: FilingObservation, current: string[], library: string[]): ScoredObservation => ({
    obs: o,
    verdicts: { current: verdict(current), library: verdict(library), hybrid: verdict([]) },
  });

  it('counts missed duplicates, false merges and partners the top-k never saw', () => {
    const dupSeen = obs({ filingId: 'F-1', partnerId: 'P-1', top: [{ id: 'P-1', cosine: 0.9, titleSimilarity: 0.5 }] });
    const dupUnseen: FilingObservation = {
      ...obs({ filingId: 'F-2', top: [{ id: 'X', cosine: 0.9, titleSimilarity: 0 }] }),
      partnerId: 'P-2',
      partner: { cosine: 0.7, titleSimilarity: 0.1, rank: GUARD_CANDIDATE_LIMIT + 4 },
    };
    const distinct = obs({ filingId: 'F-3', partnerId: 'P-3', label: 'distinct', top: [{ id: 'P-3', cosine: 0.9, titleSimilarity: 0 }] });
    const related = obs({ filingId: 'F-3', partnerId: 'P-4', label: 'related', top: [{ id: 'P-4', cosine: 0.88, titleSimilarity: 0 }] });
    const random = obs({ filingId: 'F-5', partnerId: null, label: 'unlabelled', partner: null, top: [{ id: 'Z', cosine: 0.9, titleSimilarity: 0 }] });

    const [current, library] = summarizeComparison([
      row(dupSeen, ['P-1'], ['P-1']),
      row(dupUnseen, [], ['X']),
      row(distinct, [], ['P-3']),
      row(related, [], ['P-4']),
      row(random, [], ['Z']),
    ]);

    expect(current).toMatchObject({ approach: 'current', missedDuplicates: 1, duplicatePairs: 2, falseMerges: 0, nonDuplicatePairs: 2 });
    expect(current!.strata.find((s) => s.label === 'duplicate')).toMatchObject({ caught: 1, missed: 1, missedOutsideTopK: 1 });
    expect(library).toMatchObject({ approach: 'library', missedDuplicates: 1, falseMerges: 2 });
    // Two non-duplicate pairs share one filing: pairs and filings are counted separately.
    expect(library!.strata.find((s) => s.label === 'distinct')).toMatchObject({ pairs: 1, filings: 1, falseMerges: 1 });
    expect(library!.strata.find((s) => s.label === 'unlabelled')).toMatchObject({ pairs: 1, filingsFlagged: 1 });
    expect(current!.strata.find((s) => s.label === 'unlabelled')).toMatchObject({ filingsFlagged: 0 });
  });
});

describe('pairedArmDivergence (WI-10005217: a paired pool comparison must compare something)', () => {
  const real = { id: 'WI-1', cosine: 0.9, titleSimilarity: 0.5 };
  const reflection = { id: 'EI-OBS', cosine: 0.95, titleSimilarity: 0.1 };

  it('reports a filing whose unfiltered arm admitted an observation row as divergent', () => {
    const current = obs({ filingId: 'F-1', poolSize: 100, top: [real] });
    const previous = obs({ filingId: 'F-1', poolSize: 101, top: [reflection, real] });
    expect(pairedArmDivergence([{ current, previous }])).toEqual({
      filingsCompared: 1,
      poolsDiffer: 1,
      topKDiffers: 1,
      vacuous: false,
    });
  });

  it('flags as vacuous a run whose two arms saw the same pool for every filing', () => {
    // The WI-10005217 shape: the observation filter sat in the SHARED pool CTE,
    // so "previous" was the current arm again and the delta read 0/0.
    const a = obs({ filingId: 'F-1', poolSize: 100, top: [real] });
    const b = obs({ filingId: 'F-2', poolSize: 250, top: [{ ...real, id: 'WI-2' }] });
    expect(pairedArmDivergence([{ current: a, previous: { ...a } }, { current: b, previous: { ...b } }])).toMatchObject({
      filingsCompared: 2,
      poolsDiffer: 0,
      topKDiffers: 0,
      vacuous: true,
    });
  });

  it('is not vacuous when only the top-k order differs, and never for an empty run', () => {
    const current = obs({ filingId: 'F-1', poolSize: 100, top: [real, reflection] });
    const previous = obs({ filingId: 'F-1', poolSize: 100, top: [reflection, real] });
    expect(pairedArmDivergence([{ current, previous }])).toMatchObject({ poolsDiffer: 0, topKDiffers: 1, vacuous: false });
    expect(pairedArmDivergence([])).toMatchObject({ filingsCompared: 0, vacuous: false });
  });
});

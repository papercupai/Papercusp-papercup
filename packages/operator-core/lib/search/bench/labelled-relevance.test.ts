/**
 * The labelled pass's arithmetic, tested offline at $0 with an injected judge.
 *
 * D-079 Q1's split: gate-test the deterministic machinery around the judge, run
 * the LLM deliberately. Every rule below decides whether a $12-15 run means
 * what it says — the grade mapping that ties the pass bar to precision, the two
 * exclusions that keep a vacuous zero out of a mean, and the honesty fields
 * that let a degraded run void itself instead of publishing a confident null.
 */
import { describe, expect, it, vi } from 'vitest';

import { precisionAtK } from '@papercusp/search-core';

import { JUDGE_AGREEMENT_RUBRIC_VERSION, RELEVANCE_PASS_BAR, type JudgeVerdict } from './judge-agreement';
import {
  aggregateByTool,
  assessPairedTaskUtility,
  type TaskUtilityArm,
  formatLabelledReport,
  judgeScoreToGrade,
  runLabelledPass,
  scoreQuery,
  type LabelledHit,
  type RetrievalResult,
} from './labelled-relevance';

const hit = (rank: number, docId = `d${rank}`): { docId: string; docText: string; rank: number } => ({
  docId,
  docText: `document ${docId}`,
  rank,
});

const ok = (hits: number, over: Partial<RetrievalResult> = {}): RetrievalResult => ({
  hits: Array.from({ length: hits }, (_, i) => hit(i + 1)),
  degraded: false,
  rerankApplied: true,
  ...over,
});

const verdict = (relevance: number): JudgeVerdict => ({
  relevance,
  judgedRelevant: relevance >= RELEVANCE_PASS_BAR,
  judgeCostUsd: 0.01,
  judgeNotes: `scored ${relevance}`,
});

describe('paired independently verified task utility', () => {
  const arm = (passed: boolean | null, over: Partial<TaskUtilityArm> = {}): TaskUtilityArm => ({
    passed, harmful: false, blinded: true, independentEvidenceRef: 'held-out-evaluator:v1',
    contractFingerprint: 'same-model-task-tools-budget', tokens: 100, latencyMs: 10, costUsd: 0.01, ...over,
  });
  const policy = { minClusters: 2, practicalMargin: 0.1, ci: 0.95, iterations: 200, seed: 7 };
  const pairs = [1, 2, 3].map((id) => ({ pairId: String(id), cluster: String(id), baseline: arm(false), injection: arm(true) }));
  const input = { requiredPairIds: ['1', '2', '3'], pairs, policy };

  it('pairs by frozen ID and reuses a paired cluster interval, never citation frequency', () => {
    const result = assessPairedTaskUtility(input);
    expect(result).toMatchObject({ attemptedPairs: 3, measuredPairs: 3, clusters: 3, verdict: 'healthy', tokenDelta: 0 });
    expect(result.comparison!.delta.point).toBe(1);
    expect(assessPairedTaskUtility({ ...input, pairs: [...pairs].reverse() })).toEqual(result);
  });

  it('retains failed or missing arms and refuses an unblinded or changed-contract comparison', () => {
    for (const injection of [undefined, arm(null), arm(true, { blinded: false }), arm(true, { contractFingerprint: 'other-model' })]) {
      const result = assessPairedTaskUtility({ ...input, pairs: [{ ...pairs[0]!, injection }, ...pairs.slice(1)] });
      expect(result).toMatchObject({ attemptedPairs: 3, measuredPairs: 2, unknownPairs: ['1'], verdict: 'unknown' });
    }
  });

  it('harmful influence fails even beside positive aggregate task benefit', () => {
    const result = assessPairedTaskUtility({ ...input, pairs: [{ ...pairs[0]!, injection: arm(true, { harmful: true }) }, ...pairs.slice(1)] });
    expect(result).toMatchObject({ harmfulPairs: ['1'], verdict: 'broken' });
  });

  it('repeated tasks from one cluster cannot manufacture an adequate sample', () => {
    expect(assessPairedTaskUtility({ ...input, pairs: pairs.map((pair) => ({ ...pair, cluster: 'one-source' })) }))
      .toMatchObject({ clusters: 1, comparison: null, verdict: 'unknown' });
  });
});

describe('judgeScoreToGrade', () => {
  it('bands 0..5 onto the metric contract 0..3', () => {
    expect([0, 1, 2, 3, 4, 5].map(judgeScoreToGrade)).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it('makes "the judge called it relevant" and "precision@k counts it" the SAME predicate', () => {
    // The load-bearing property. A document scored exactly at the pass bar must
    // land at or above precision@k's default threshold of 2, or the pass
    // reports a precision that disagrees with its own labels.
    const atBar: LabelledHit[] = [
      { ...hit(1), relevance: RELEVANCE_PASS_BAR, grade: judgeScoreToGrade(RELEVANCE_PASS_BAR), judgeCostUsd: 0 },
    ];
    expect(atBar[0]!.grade).toBeGreaterThanOrEqual(2);
    expect(precisionAtK(atBar.map((h) => h.grade), 10, 2)).toBe(1);
  });

  it('is NOT a linear rescale — that would put the pass bar below the precision threshold', () => {
    // score * 3/5 maps the bar (3) to 1.8, i.e. grade 1 once rounded down: a
    // document the judge called relevant would then not count as a precision
    // hit, and the reported precision would silently understate the labels.
    const linear = Math.floor((RELEVANCE_PASS_BAR * 3) / 5);
    expect(linear).toBeLessThan(2);
    expect(judgeScoreToGrade(RELEVANCE_PASS_BAR)).toBe(2);
  });

  it('clamps out-of-range scores and refuses a non-finite one', () => {
    expect(judgeScoreToGrade(9)).toBe(3);
    expect(judgeScoreToGrade(-2)).toBe(0);
    expect(() => judgeScoreToGrade(Number.NaN)).toThrow(/finite/);
  });
});

describe('scoreQuery', () => {
  it('uniform zero gain is zero and uniform positive gain is one; both ignore order', () => {
    for (const [grade, expected] of [[0, 0], [3, 1]]) {
      const hits = [1, 2, 3].map((rank) => ({ ...hit(rank), relevance: grade, grade, judgeCostUsd: 0 }));
      expect(scoreQuery(hits).ndcgAtK).toBe(expected);
      expect(scoreQuery([...hits].reverse()).ndcgAtK).toBe(expected);
    }
  });
  it('reports recall as null — this pass has no externally-known relevant set', () => {
    // A 0 here would read as "found none of them", the strongest possible
    // failure claim, from a run that is PRODUCING the labels and had nothing
    // to find.
    const res = scoreQuery([{ ...hit(1), relevance: 5, grade: 3, judgeCostUsd: 0 }]);
    expect(res.recallAtK).toBeNull();
    expect(res.coverage).toBe('complete');
  });

  it('marks an empty ranking as empty-ranking, not as a complete zero', () => {
    expect(scoreQuery([]).coverage).toBe('empty-ranking');
  });
});

describe('runLabelledPass', () => {
  const oneQuery = [{ tool: 'docs:search', query: 'a b c', terms: 3 }];

  it('keeps failed attempts beside excellent conditional precision and explicit underfill', async () => {
    const queries = Array.from({ length: 10 }, (_, i) => ({ ...oneQuery[0]!, query: String(i), groundTruthIds: ['d1'] }));
    const report = await runLabelledPass({ queries, sampleSeed: 'attempts', judge: async () => verdict(5),
      retrieve: async (q) => { if (q !== '0') throw new Error('unavailable'); return ok(1); } });
    expect(report.overall.meanPrecisionAtK).toBe(1);
    expect(report.overall).toMatchObject({ attempted: 10, n: 1, excluded: 9, returnedHits: 1,
      requestedSlots: 100, underfilled: 10, usefulSuccesses: 1, usefulFailures: 9, usefulUnknown: 0,
      usefulSuccessLowerBound: 0.1, outcomeCounts: { scored: 1, 'retrieval-failed': 9 } });
    expect(report.outcomes).toHaveLength(10);
  });

  it('distinguishes correct abstention, a missed known item, and an unlabelled empty attempt', async () => {
    const report = await runLabelledPass({ sampleSeed: 'empty', retrieve: async () => ok(0), judge: async () => verdict(5),
      queries: [{ ...oneQuery[0]!, groundTruthIds: [] }, { ...oneQuery[0]!, groundTruthIds: ['needed'] }, oneQuery[0]!] });
    expect(report.outcomes.map((o) => o.usefulContextSuccess)).toEqual([true, false, null]);
    expect(report.outcomes[1]).toMatchObject({ recallAtK: 0, missingIds: ['needed'] });
    expect(report.overall).toMatchObject({ attempted: 3, usefulSuccesses: 1, usefulFailures: 1, usefulUnknown: 1 });
  });

  it('records a judge failure and continues after draining successful paid workers', async () => {
    const report = await runLabelledPass({ sampleSeed: 'judge-failure', queries: oneQuery, retrieve: async () => ok(2),
      judge: async ({ docId }) => { if (docId === 'd1') throw new Error('judge unavailable'); await new Promise((r) => setTimeout(r, 5)); return verdict(5); } });
    expect(report.outcomes[0]).toMatchObject({ attemptStatus: 'judge-failed', judgeCostUsd: 0.01, returnedCount: 2 });
    expect(report.judgedHits).toBe(1);
    expect(report.overall.usefulUnknown).toBe(1);
  });

  it('accepts an engaged reranker that preserves an already correct order', async () => {
    const report = await runLabelledPass({ sampleSeed: 'unchanged', queries: oneQuery,
      retrieve: async () => ok(2, { hits: [{ ...hit(1), rerankScore: 0.9 }, { ...hit(2), rerankScore: 0.8 }] }),
      judge: async () => verdict(5), contract: { adapter: 'offline-stage-experiment:v1' } });
    expect(report.outcomes[0]).toMatchObject({ rerankApplied: true, attemptStatus: 'scored' });
    expect(report.outcomes[0]!.hits.map((h) => h.docId)).toEqual(['d1', 'd2']);
    expect(report.contract.adapter).toBe('offline-stage-experiment:v1');
    expect(report.contract.runtime).toBeNull();
  });

  it('judges the top k and scores the ranking', async () => {
    const judge = vi.fn(async () => verdict(5));
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(12),
      judge,
      k: 10,
      sampleSeed: 's',
    });
    expect(judge).toHaveBeenCalledTimes(10); // k, not the 12 retrieved
    expect(report.judgedHits).toBe(10);
    expect(report.outcomes[0]!.ndcgAtK).toBe(1);
    expect(report.outcomes[0]!.hits[0]!.grade).toBe(3);
    expect(report.judgeCostUsd).toBeCloseTo(0.1, 6);
  });

  it('EXCLUDES a degraded query, judges nothing for it, and says so on the number', async () => {
    // A null embedder degrades the engine to lexical-only. That measured a
    // different system: averaging it in would report keyword ranking as hybrid,
    // and paying to label it would be paying for a ranking already discarded.
    const judge = vi.fn(async () => verdict(5));
    const report = await runLabelledPass({
      queries: [...oneQuery, { tool: 'docs:search', query: 'd e f', terms: 3 }],
      retrieve: async (q) =>
        q === 'a b c' ? ok(3) : ok(3, { degraded: true, degradeWarning: 'semantic leg did not run' }),
      judge,
      k: 10,
      sampleSeed: 's',
    });
    expect(judge).toHaveBeenCalledTimes(3); // only the healthy query
    const degradedOutcome = report.outcomes.find((o) => o.degraded)!;
    expect(degradedOutcome.ndcgAtK).toBeNull();
    expect(degradedOutcome.excludedReason).toMatch(/DEGRADED.*semantic leg did not run/);
    expect(report.overall.n).toBe(1);
    expect(report.overall.excluded).toBe(1);
    expect(report.caveats.join(' ')).toContain('1 of 2 queries excluded as DEGRADED');
  });

  it('EXCLUDES an empty ranking rather than averaging in a vacuous zero', async () => {
    // ndcg → 0 for an empty ranking is indistinguishable from "retrieval worked
    // and everything it found was irrelevant" — opposite verdicts.
    const report = await runLabelledPass({
      queries: [...oneQuery, { tool: 'docs:search', query: 'd e f', terms: 3 }],
      retrieve: async (q) => (q === 'a b c' ? ok(3) : ok(0)),
      judge: async () => verdict(5),
      k: 10,
      sampleSeed: 's',
    });
    const empty = report.outcomes.find((o) => o.query === 'd e f')!;
    expect(empty.coverage).toBe('empty-ranking');
    expect(empty.excludedReason).toMatch(/no hits/);
    // The mean is 1.0 (the one query that was measured), NOT 0.5.
    expect(report.overall.meanNdcgAtK).toBe(1);
    expect(report.overall.n).toBe(1);
  });

  it('flags a run whose Stage B rerank did not actually rank', async () => {
    // The reranker is fail-soft: a total degrade returns the retrieval order,
    // byte-identical to no reranking. A pass that cannot say which it got is
    // publishing a different pipeline than an interactive caller gets.
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(3, { rerankApplied: false }),
      judge: async () => verdict(4),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.outcomes[0]!.rerankApplied).toBe(false);
    expect(report.caveats.join(' ')).toMatch(/1 scored queries ran WITHOUT Stage B/);
  });

  it('preserves RANK ORDER when judging concurrently, and bounds the in-flight count', async () => {
    // Every metric downstream reads the labelled array positionally. A result
    // reordered by completion time would still produce a plausible nDCG — of a
    // ranking the engine never returned.
    let inFlight = 0;
    let peak = 0;
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(8),
      judge: async (input) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Later ranks finish FIRST — the ordering trap, made deterministic.
        const rank = Number(input.pairId.split(':').pop());
        await new Promise((r) => setTimeout(r, (9 - rank) * 4));
        inFlight--;
        return verdict(rank <= 2 ? 5 : 0);
      },
      k: 10,
      judgeConcurrency: 3,
      sampleSeed: 's',
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(report.outcomes[0]!.hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The two relevant docs are at ranks 1-2, so this is a perfect ranking.
    expect(report.outcomes[0]!.ndcgAtK).toBe(1);
  });

  it('hands every per-query row to onQueryDone as it lands', async () => {
    // A paid run that dies at query 120 must still be worth 120 queries.
    const seen: string[] = [];
    await runLabelledPass({
      queries: [oneQuery[0]!, { tool: 'plans:search', query: 'd e f', terms: 3 }],
      retrieve: async () => ok(2),
      judge: async () => verdict(3),
      k: 10,
      sampleSeed: 's',
      onQueryDone: (o) => seen.push(o.query),
    });
    expect(seen).toEqual(['a b c', 'd e f']);
  });

  it('keeps the judge rationale on every hit', async () => {
    // The aggregates cannot adjudicate a surprising number; the rationales can,
    // and re-deriving them means paying for the whole run again.
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(1),
      judge: async () => verdict(2),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.outcomes[0]!.hits[0]!.judgeNotes).toBe('scored 2');
  });

  it('reports strata separately and never pools them', async () => {
    const report = await runLabelledPass({
      queries: [
        { tool: 'docs:search', query: 'a b c', terms: 3 },
        { tool: 'plans:search', query: 'd e f', terms: 3 },
      ],
      retrieve: async () => ok(1),
      judge: async (input) => verdict(input.query === 'a b c' ? 5 : 0),
      k: 10,
      sampleSeed: 's',
    });
    const by = new Map(report.byTool.map((a) => [a.tool, a]));
    expect(by.get('docs:search')!.meanNdcgAtK).toBe(1);
    expect(by.get('plans:search')!.meanNdcgAtK).toBe(0);
    expect(by.get('plans:search')!.pollutionRate).toBe(1);
    expect(report.overall.meanNdcgAtK).toBe(0.5);
  });

  it('carries the frozen contract and the not-a-floor caveat on the report itself', async () => {
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(1),
      judge: async () => verdict(5),
      k: 10,
      sampleSeed: 'p038-labelled-v1',
    });
    expect(report.rubricVersion).toBe(JUDGE_AGREEMENT_RUBRIC_VERSION);
    expect(report.passBar).toBe(RELEVANCE_PASS_BAR);
    expect(report.sampleSeed).toBe('p038-labelled-v1');
    // D-074: no floor off one run.
    expect(report.caveats.join(' ')).toContain('NOT A FLOOR');
    // The caveats must be IN the rendered report, not a footnote elsewhere.
    expect(formatLabelledReport(report)).toContain('NOT A FLOOR');
  });
});

/**
 * `--pool-all` (D-084/D-085): label the WHOLE fused candidate pool, not just the
 * page, so the floor study has labels for the candidates a floor would CUT.
 *
 * The thing these tests exist to prevent is subtle and expensive: pool labels
 * reaching the AGGREGATES. `rollUp` computes pollutionRate and ndcgUninformative
 * over all of `o.hits`, and the pool's tail is exactly where the irrelevant
 * candidates live — so widening `hits` would send pollution up for a reason that
 * is a change of denominator, not a change in quality, while the before/after
 * tables still looked directly comparable with D-083's.
 */
describe('runLabelledPass — pool mode', () => {
  const oneQuery = [{ tool: 'docs:search', query: 'a b c', terms: 3 }];
  /** A page of `page` hits carried as the PREFIX of a `pool`-deep candidate list. */
  const pooled = (page: number, pool: number, over: Partial<RetrievalResult> = {}): RetrievalResult => {
    const all = Array.from({ length: pool }, (_, i) => hit(i + 1));
    return { hits: all.slice(0, page), poolHits: all, degraded: false, rerankApplied: true, ...over };
  };
  /** Relevant on the page, irrelevant below it — the realistic pool shape. */
  const byDepth = async (input: { docId: string }): Promise<JudgeVerdict> =>
    verdict(Number(input.docId.slice(1)) <= 10 ? 5 : 0);

  it('leaves EVERY aggregate identical to a top-k run, though the pool tail is all pollution', async () => {
    // THE DENOMINATOR GUARD. Same page, same labels; the pool arm additionally
    // labels 14 grade-0 candidates below the page. If any of those reached
    // rollUp, pollutionRate would jump 0 → 0.583 and read as a quality
    // regression against D-083.
    const topK = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(10),
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });
    const pool = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => pooled(10, 24),
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });

    expect(pool.outcomes[0]!.poolHits).toHaveLength(24);
    expect(pool.outcomes[0]!.poolHits!.filter((h) => h.grade === 0)).toHaveLength(14);
    // ...and none of it moved a single number.
    expect(pool.overall.pollutionRate).toBe(0);
    expect(pool.overall).toEqual(topK.overall);
    expect(pool.byTool).toEqual(topK.byTool);
  });

  it('judges each candidate ONCE — the page IS the pool prefix, not a second judgement', async () => {
    const judge = vi.fn(byDepth);
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => pooled(10, 24),
      judge,
      k: 10,
      sampleSeed: 's',
    });
    expect(judge).toHaveBeenCalledTimes(24); // 24, NOT 24 + 10
    const o = report.outcomes[0]!;
    expect(o.hits).toHaveLength(10);
    // Object identity: the page rows ARE the pool's first rows, so the two can
    // never disagree about a label the way two judgements of one pair could.
    expect(o.hits[0]).toBe(o.poolHits![0]);
    expect(o.hits[9]).toBe(o.poolHits![9]);
  });

  it('ABORTS before spending a cent when the page is not the pool prefix', async () => {
    // A perturbed top-k means the arm is not comparable with the top-k runs it
    // exists to extend. That is a code defect, identical on every query, so the
    // run must die rather than pay to discover it.
    const judge = vi.fn(byDepth);
    await expect(
      runLabelledPass({
        queries: oneQuery,
        retrieve: async () => {
          const r = pooled(10, 24);
          return { ...r, hits: [hit(1, 'MOVED'), ...r.hits.slice(1)] };
        },
        judge,
        k: 10,
        sampleSeed: 's',
      }),
    ).rejects.toThrow(/PREFIX of poolHits.*rank 1 differs/s);
    expect(judge).not.toHaveBeenCalled();
  });

  it('reports the per-query cost over the whole pool, not just the page', async () => {
    // The page is ~40% of what a pooled query costs; a per-query cost that
    // under-reports by 2.4x makes the run's own spend unauditable from its rows.
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => pooled(10, 24),
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });
    expect(report.outcomes[0]!.judgeCostUsd).toBeCloseTo(0.24, 6);
    expect(report.judgeCostUsd).toBeCloseTo(0.24, 6);
  });

  it('carries rerankScore through ABSENT — never as a zero — and counts the scored share', async () => {
    // D-085's load-bearing invariant, at the surface the floor study reads. An
    // unscored candidate must arrive with the property MISSING: a `>= x` floor
    // has to drop it as UNKNOWN, and a 0 would make a degraded stage look like a
    // corpus full of garbage and calibrate the floor high.
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => {
        const all = Array.from({ length: 24 }, (_, i) =>
          i < 10 ? { ...hit(i + 1), rerankScore: 0.9 - i * 0.01, score: 0.016 } : { ...hit(i + 1), score: 0.008 },
        );
        return { hits: all.slice(0, 10), poolHits: all, degraded: false, rerankApplied: true };
      },
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });
    const pool = report.outcomes[0]!.poolHits!;
    expect(pool[0]!.rerankScore).toBeCloseTo(0.9, 6);
    expect(pool[12]!.rerankScore).toBeUndefined();
    expect('rerankScore' in pool[12]!).toBe(false); // absent, not an undefined-valued key
    // A floor keeps exactly the scored rows; the unscored ones are dropped as
    // unknown rather than counted at the bottom.
    expect(pool.filter((h) => (h.rerankScore ?? -1) >= 0.85)).toHaveLength(6);
    expect(report.caveats.join(' ')).toContain('10/24 pooled candidates carry a rerankScore');
  });

  it('says on the report that the aggregates stayed top-k', async () => {
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => pooled(10, 24),
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });
    const caveats = report.caveats.join(' ');
    expect(caveats).toContain('POOL MODE (--pool-all) was on for 1/1 queries');
    expect(caveats).toContain('EVERY AGGREGATE ABOVE IS STILL TOP-10 ONLY');
    expect(caveats).toContain('Do not concatenate hits with poolHits');
    expect(formatLabelledReport(report)).toContain('EVERY AGGREGATE ABOVE IS STILL TOP-10 ONLY');
  });

  it('marks a degraded query as pooled-but-empty rather than dropping the field', async () => {
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => pooled(10, 24, { degraded: true, degradeWarning: 'semantic leg did not run' }),
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });
    // Present-and-empty distinguishes "pooled, nothing to judge" from "this run
    // never pooled at all", which a consumer scanning the rows cannot otherwise tell.
    expect(report.outcomes[0]!.poolHits).toEqual([]);
    expect(report.outcomes[0]!.excludedReason).toMatch(/DEGRADED/);
  });

  it('is OFF by default — a retrieval without poolHits behaves exactly as before', async () => {
    const report = await runLabelledPass({
      queries: oneQuery,
      retrieve: async () => ok(12),
      judge: byDepth,
      k: 10,
      sampleSeed: 's',
    });
    expect(report.outcomes[0]!.poolHits).toBeUndefined();
    expect(report.caveats.join(' ')).not.toContain('POOL MODE');
  });
});

describe('aggregateByTool', () => {
  it('returns an empty roll-up for no outcomes rather than dividing by zero', () => {
    expect(aggregateByTool([])).toEqual([]);
  });
});

describe('ndcgUninformative', () => {
  const graded = (grades: number[]): LabelledHit[] =>
    grades.map((g, i) => ({ ...hit(i + 1), relevance: g === 3 ? 5 : 0, grade: g, judgeCostUsd: 0 }));

  it('marks the configuration where nDCG is invariant under ANY reordering', () => {
    // The property the field exists to make legible. With one distinct grade the
    // engine's ordering cannot move the score, so a 1.000 there is arithmetic,
    // not evidence that anything was ranked well.
    const forward = scoreQuery(graded([3, 3, 3]), 10).ndcgAtK;
    const reversed = scoreQuery([...graded([3, 3, 3])].reverse(), 10).ndcgAtK;
    expect(forward).toBe(1);
    expect(reversed).toBe(forward);
  });

  it('does NOT mark a query whose ranking the metric could actually have punished', () => {
    const best = scoreQuery(graded([3, 3, 0]), 10).ndcgAtK!;
    const worst = scoreQuery(graded([0, 3, 3]), 10).ndcgAtK!;
    // Mixed grades ⇒ order changes the score ⇒ nDCG carried real information.
    expect(worst).toBeLessThan(best);
    expect(new Set([3, 3, 0]).size).toBeGreaterThan(1);
  });

  it('separates a vacuous 1.000 from an earned one in the aggregate', async () => {
    const report = await runLabelledPass({
      queries: [
        { tool: 'docs:search', query: 'uniform', terms: 1 },
        { tool: 'docs:search', query: 'mixed', terms: 1 },
      ],
      retrieve: async () => ok(2),
      judge: async (input) =>
        input.query === 'uniform' ? verdict(5) : verdict(input.docId === 'd1' ? 5 : 0),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.overall.n).toBe(2);
    // Both queries score; only one of them had a score that could have moved.
    expect(report.overall.ndcgUninformative).toBe(1);
  });

  it('quotes its own share in the caveat and renders it beside the column it qualifies', async () => {
    const report = await runLabelledPass({
      queries: [{ tool: 'docs:search', query: 'all relevant', terms: 2 }],
      retrieve: async () => ok(3),
      judge: async () => verdict(5),
      k: 10,
      sampleSeed: 's',
    });
    expect(report.overall.meanNdcgAtK).toBe(1);
    expect(report.overall.ndcgUninformative).toBe(1);
    // The share is computed from the SAME roll-up that is reported, so the prose
    // and the table cannot drift apart.
    expect(report.caveats.join(' ')).toContain('1/1 scored queries had a uniform grade vector');
    const rendered = formatLabelledReport(report);
    expect(rendered).toContain('NOT A SEARCH-QUALITY SCORE');
    expect(rendered).toContain('uninf');
    expect(rendered).toContain('1/1');
  });
});

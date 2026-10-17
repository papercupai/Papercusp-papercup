import { compileFunction, createContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DREAM_BENCHMARK_CASES } from '../../test/dream-benchmark-cases';
import { DREAM_BENCHMARK_LABELS } from '../../test/dream-benchmark-labels';
import independentReview from '../../test/dream-benchmark-review.fixture.json';
import { capabilityHash } from './capability-contracts';
import { findBoxIdentityPaths, serializeIdentitySafeJson } from '../../../../scripts/lib/identity-leak-patterns.mjs';
import {
  DREAM_EVALUATION_ARMS,
  DREAM_EVALUATION_COSTS,
  DreamEvaluationProtocolSchema,
  DREAM_UTILITY_CONTRACT,
  dreamEvaluationProtocolHash,
  dreamReviewerConfusion,
  freezeDreamEvaluationProtocol,
  requireDreamPilotProtocol,
  summarizeDreamEvaluationCosts,
  summarizeDreamComparison,
  summarizeDreamGraphComparison,
  dreamComparisonInputHash,
  applyDreamGraphTreatment,
  type DreamEvaluationCost,
} from './dream-evaluation';

const frozen = () =>
  freezeDreamEvaluationProtocol({
    sourceSnapshot: 'a'.repeat(64),
    benchmarkHash: capabilityHash(JSON.stringify(DREAM_BENCHMARK_CASES)),
    oracleHash: capabilityHash(JSON.stringify(DREAM_BENCHMARK_LABELS)),
    independentLabelsRef: 'work-item:WI-10000489#independent-blinded-review',
    seed: 'dream-2026-09-07-v1',
    models: { generator: 'generator', reviewer: 'reviewer' },
  });
const current = {
  sourceSnapshot: 'a'.repeat(64),
  generator: 'generator',
  reviewer: 'reviewer',
  mode: 'manual',
  samplerMode: 'structured',
  arity: 2,
  cycle: { maxCostUsd: 1, rolling24hCostUsd: 5 },
};
const costs = (arm: DreamEvaluationCost['arm']): DreamEvaluationCost => ({
  arm,
  phases: { indexing: 0.1, retrieval: 0.1, generation: 0.2, review: 0.2, verification: 0.4, experiment: 1 },
  qualifiedFamilies: ['family-a'],
  verifiedBeneficialExperiments: 1,
  engineerMinutes: 12,
});

describe('frozen Dream evaluation protocol — P017', () => {
  it('publishes study diagnostics without machine identities while preserving private evidence and measurements', () => {
    const home = ['','home','study-machine-user','source','worker.ts'].join('/');
    const original = { protocolPin: 'a'.repeat(64), blindHash: 'b'.repeat(64),
      attempts: 4, accountedUsd: 0.949124, downstreamTrialsExecuted: 0,
      diagnostic: JSON.stringify({ path: home, error: `Worker failed at ${home}` }) };
    const before = JSON.stringify(original);
    expect(findBoxIdentityPaths(before).length).toBeGreaterThan(0);
    const encoded = serializeIdentitySafeJson(original, []);
    const published = JSON.parse(encoded);
    expect(findBoxIdentityPaths(encoded)).toEqual([]);
    expect(published).toMatchObject({ protocolPin: original.protocolPin, blindHash: original.blindHash,
      attempts: 4, accountedUsd: 0.949124, downstreamTrialsExecuted: 0 });
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.parse(published.diagnostic).path).not.toBe(home);
  });
  it('reconstructs the spent graph study without promoting unknown novelty or reopening downstream trials', () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`./study/${name}`, import.meta.url), 'utf8'));
    const comparison = read('native-graph-protocol.json');
    const blind = read('native-graph-calibration-blind-v2.json');
    const frozenReview = read('native-graph-calibration-review-2026-10-14.json');
    const unblinded = read('native-graph-calibration-unblinded-review-2026-10-14.json');
    const saved = read('native-graph-evidence-summary.json');
    expect(findBoxIdentityPaths(JSON.stringify(saved))).toEqual([]);
    const blindHash = capabilityHash(JSON.stringify(blind));
    expect(dreamEvaluationProtocolHash(comparison.protocol)).toBe(comparison.pin);
    expect([frozenReview.blindHash, unblinded.blindHash, saved.blindHash]).toEqual([blindHash, blindHash, blindHash]);
    expect(unblinded.blindPostId).toBe(frozenReview.posts[0].id);
    expect(unblinded.posts[0].id).toBe(1179964);
    expect(unblinded.posts[0].body).toContain('frozen labels UNCHANGED: both REJECT as frozen');
    expect(unblinded.cases.map((row: { caseId: string }) => row.caseId).sort()).toEqual(
      blind.cases.map((row: { caseId: string }) => row.caseId).sort());
    const independent = { ref: 'native-graph-calibration-unblinded-review-2026-10-14.json',
      labels: frozenReview.cases.map((label: { caseId: string }) => ({ ...label,
        ...unblinded.cases.find((row: { caseId: string }) => row.caseId === label.caseId) })) };
    const rebuilt = summarizeDreamGraphComparison({ protocol: comparison.protocol, attempts: saved.dreams, independent });
    expect(rebuilt.treatments).toEqual(saved.treatments);
    expect(rebuilt.matchedPairs).toEqual(saved.matchedPairs);
    expect(rebuilt.completeAttempts).toBe(true);
    expect(rebuilt.commonInput).toBe(true);
    expect(rebuilt.verdict).toBe('inconclusive');
    expect(rebuilt.treatments.map(row => row.attempts)).toEqual([2, 2]);
    expect(rebuilt.treatments.map(row => row.qualifiedFamilies)).toEqual([0, 0]);
    expect(rebuilt.treatments[1]).toMatchObject({ refinementCandidates: 1, noveltyUnknownCandidates: 1,
      duplicateRate: null, refinementRate: null });
    expect(saved.downstreamDisposition).toBe('not-applicable-no-qualified-candidates');
    expect(saved.downstreamTrialsExecuted).toBe(0);
    expect(saved.verifiedBeneficialExperiments).toBe(0);
    expect(saved.usefulOutcomesPerDollar).toBeNull();
  });
  it('NATIVE-GRAPH-COMPARISON: pins treatments, assignment count, sampler and independent executed outcomes without changing legacy pins', () => {
    const original = frozen();
    const common = { manifestRevision: 'current-v2', scope: { workspaceId: 'ws', potSlug: 'pot' },
      problemContext: { mode: 'open-exploration' as const, evidence: [], note: 'Frozen open exploration.' } };
    const comparison = { ...common, inputHash: dreamComparisonInputHash({ ...common, sourceSnapshot: current.sourceSnapshot }),
      graphAblation: { treatments: ['graph', 'control'] as ['graph', 'control'], populationIds: ['a', 'b'],
        samplerHash: capabilityHash('{}'), attemptsPerTreatment: 2, usdPerTreatment: 2,
        outcomeAssessment: 'blinded-independent-executed-benefit' as const } };
    const bound = freezeDreamEvaluationProtocol({ ...original.protocol, comparison });
    const now = { ...current, ...common, samplerHash: comparison.graphAblation.samplerHash };
    for (const graphTreatment of ['graph', 'control'] as const) {
      const assigned = { ...bound, arm: 'structured-pair' as const, graphTreatment, matchedPairIndex: 0 };
      expect(requireDreamPilotProtocol(assigned, now)).toEqual(bound.protocol);
      expect(() => requireDreamPilotProtocol(assigned, { ...now, samplerHash: 'b'.repeat(64) })).toThrow('sampler changed');
      expect(() => requireDreamPilotProtocol({ ...assigned, matchedPairIndex: 2 }, now)).toThrow('bounded paired treatment');
    }
    expect(() => requireDreamPilotProtocol({ ...bound, arm: 'structured-pair' }, now)).toThrow('paired treatment');
    expect(() => requireDreamPilotProtocol({ ...original, arm: 'structured-pair', graphTreatment: 'control' }, current)).toThrow('preregistered');
    expect(dreamEvaluationProtocolHash(original.protocol)).toBe(original.pin);
    expect(original.protocol.comparison).toBeUndefined();
    expect(applyDreamGraphTreatment({ fingerprint: 'unused' } as never, null)).toEqual({ fingerprint: 'unused' });
  });
  it('DREAM-COMPARABLE: binds current catalogue and attributed problem input without altering old protocol pins', () => {
    const original = frozen();
    const scope = { workspaceId: 'ws', potSlug: 'pot' };
    const evidence = { ref: 'observation:EI-1', kind: 'observation' as const, ...scope,
      attributedTo: 'reporter', capturedAt: '2026-09-27T00:00:00Z', text: 'A repeated replay problem.',
      contentHash: capabilityHash('A repeated replay problem.') };
    const common = { manifestRevision: 'current-v2', scope,
      problemContext: { mode: 'observed-problems' as const, evidence: [evidence], note: 'Frozen report.' } };
    const comparison = { ...common, inputHash: dreamComparisonInputHash({ ...common, sourceSnapshot: current.sourceSnapshot }) };
    const bound = freezeDreamEvaluationProtocol({ ...original.protocol, comparison });
    const now = { ...current, scope, manifestRevision: common.manifestRevision };
    expect(requireDreamPilotProtocol({ ...bound, arm: 'structured-pair' }, now)).toEqual(bound.protocol);
    expect(() => requireDreamPilotProtocol({ ...bound, arm: 'structured-pair' }, { ...now, scope: { ...scope, potSlug: 'foreign' } })).toThrow('input changed');
    expect(() => requireDreamPilotProtocol({ ...bound, arm: 'structured-pair' }, { ...now, manifestRevision: 'drifted' })).toThrow('input changed');
    expect(() => dreamComparisonInputHash({ ...common, sourceSnapshot: current.sourceSnapshot,
      problemContext: { ...common.problemContext, evidence: [{ ...evidence, text: 'changed without a matching hash' }] } })).toThrow('invalid or foreign');
    expect(dreamEvaluationProtocolHash(original.protocol)).toBe(original.pin);
    expect(original.protocol.comparison).toBeUndefined();
  });
  it('keeps failed graph trials, missing judgments and unknown cost out of benefit claims', () => {
    const original = frozen();
    const common = { manifestRevision: 'v2', scope: { workspaceId: 'ws', potSlug: 'pot' },
      problemContext: { mode: 'open-exploration' as const, evidence: [], note: 'Frozen.' } };
    const protocol = freezeDreamEvaluationProtocol({ ...original.protocol,
      comparison: { ...common, inputHash: dreamComparisonInputHash({ ...common, sourceSnapshot: current.sourceSnapshot }),
        graphAblation: { treatments: ['graph', 'control'], populationIds: ['a', 'b'], samplerHash: 'b'.repeat(64),
          attemptsPerTreatment: 2, usdPerTreatment: 2, outcomeAssessment: 'blinded-independent-executed-benefit' } } }).protocol;
    const attempts = (['graph', 'control'] as const).flatMap(treatment => [0, 1].map(pairIndex => ({
      runId: treatment + pairIndex, treatment, pairIndex, sourceSnapshot: protocol.sourceSnapshot,
      inputHash: protocol.comparison!.inputHash, unitIds: ['a', 'b'],
      candidateCaseId: treatment === 'control' ? 'case' + pairIndex : null,
      accountedUsd: treatment === 'control' ? 0.4 : 0, unknownCostCalls: 0,
    })));
    const missing = summarizeDreamGraphComparison({ protocol, attempts, independent: null });
    expect(missing).toMatchObject({ completeAttempts: true, commonInput: true, fullyAttributedCost: false,
      usefulOutcomesPerDollar: null, verdict: 'inconclusive' });
    expect(missing.treatments[0]).toMatchObject({ attempts: 2, candidateCount: 0, noCandidateAttempts: 2,
      qualifiedFamilies: null, duplicateRate: null });
    expect(missing.treatments[1]).toMatchObject({ missingLabels: 2, qualifiedFamilies: null, duplicateRate: null });
    const independent = { ref: 'frozen-review', labels: [0, 1].map(i => ({ caseId: 'case' + i,
      verdict: 'reject' as const, family: 'same-family', novelty: 'refinement' as const, qualified: false })) };
    const assessed = summarizeDreamGraphComparison({ protocol, attempts, independent });
    expect(assessed.treatments[1]).toMatchObject({ qualifiedFamilies: 0, refinementRate: 1, accountedUsd: 0.8 });
    expect(assessed.treatments[0]!.duplicateRate).toBeNull();
    const unknownNovelty = summarizeDreamGraphComparison({ protocol, attempts, independent: {
      ...independent, labels: independent.labels.map(label => ({ ...label, novelty: 'unknown', qualified: null })) } });
    expect(unknownNovelty.treatments[1]).toMatchObject({ duplicateRate: null, refinementRate: null,
      noveltyUnknownCandidates: 2, qualifiedFamilies: null });
    expect(assessed.matchedPairs.every(pair => pair.sameUnits)).toBe(true);
    expect(() => summarizeDreamGraphComparison({ protocol, attempts: [...attempts, attempts[0]!], independent })).toThrow('identity');
    expect(() => summarizeDreamGraphComparison({ protocol, attempts, independent: { ref: 'bad',
      labels: [{ ...independent.labels[0]!, qualified: true }] } })).toThrow('assessment');
    const unknown = attempts.map((row, i) => i ? row : { ...row, inputHash: null, unknownCostCalls: 1, unitIds: ['other', 'b'] });
    const incomplete = summarizeDreamGraphComparison({ protocol, attempts: unknown.slice(0, 3), independent: null });
    expect(incomplete).toMatchObject({ commonInput: false, completeAttempts: false, usefulOutcomesPerDollar: null });
    expect(incomplete.treatments[0]!.unknownCostCalls).toBe(1);
    expect(incomplete.matchedPairs[0]!.sameUnits).toBe(false);
  });
  it('DREAM-COMPARABLE: reports missing human calibration, input/spend mismatch and unknown effort honestly', () => {
    const inputHash = 'c'.repeat(64);
    const rows = DREAM_EVALUATION_ARMS.map(arm => ({ ...costs(arm), inputHash, spendCapUsd: 1 }));
    const report = summarizeDreamComparison({ inputHash, rows, humanCalibrationRef: null });
    expect(report).toMatchObject({ commonInput: true, equalAttemptCounts: true, equalSpendCaps: true,
      costsComplete: true, effortComplete: false, humanCalibration: 'missing', verdict: 'inconclusive' });
    expect(report.arms.every(a => a.reviewerMinutes === null && a.maintenanceMinutes === null)).toBe(true);
    rows[0]!.inputHash = 'd'.repeat(64); rows[0]!.spendCapUsd = 2;
    expect(summarizeDreamComparison({ inputHash, rows, humanCalibrationRef: 'recorded-human-receipt' })).toMatchObject({
      commonInput: false, equalSpendCaps: false, mismatchedInputAttempts: 1,
      humanCalibration: 'referenced-not-independently-verified', verdict: 'inconclusive',
    });
    expect(summarizeDreamComparison({ inputHash, rows: [], humanCalibrationRef: null }).missingArms).toEqual(DREAM_EVALUATION_ARMS);
  });
  it('DREAM-COMPARABLE: accounts reviewer and maintenance minutes without converting them into model dollars', () => {
    const row = { ...costs('blender'), reviewerMinutes: 3, maintenanceMinutes: 5 };
    expect(summarizeDreamEvaluationCosts([row])[0]).toMatchObject({ discoveryUsd: 1, experimentUsd: 1, reviewerMinutes: 3, maintenanceMinutes: 5 });
    expect(() => summarizeDreamEvaluationCosts([{ ...row, reviewerMinutes: -1 }])).toThrow('time');
    expect(summarizeDreamEvaluationCosts([row, { ...row, maintenanceMinutes: null }])[0]!.maintenanceMinutes).toBeNull();
  });
  it('freezes comparable arms, full costs, common utility, seeds and hard limits', () => {
    const { protocol, pin } = frozen();
    expect(pin).toBe(dreamEvaluationProtocolHash(structuredClone(protocol)));
    expect(protocol.arms).toEqual(DREAM_EVALUATION_ARMS);
    expect(protocol.costPhases).toEqual(DREAM_EVALUATION_COSTS);
    expect(protocol.utilityHash).toBe(capabilityHash(JSON.stringify(DREAM_UTILITY_CONTRACT)));
    expect(protocol.limits).toEqual({
      attempts: 200,
      attemptsPerArm: 50,
      discoveryUsd: 20,
      discoveryUsdPerArm: 5,
      cycleAttempts: 3,
      cycleUsd: 1,
      rollingDayUsd: 5,
      experimentMinutes: 60,
      experimentCount: 12,
      experimentComputeUsd: 0,
    });
    expect(protocol.analysis.ablations).toContain('calibration disjoint from held-out');
    expect(requireDreamPilotProtocol({ protocol, pin, arm: 'structured-pair' }, current)).toEqual(protocol);
  });

  it('refuses absent/changed protocol, changed sources/models, auto mode and wrong arm before admission', () => {
    const { protocol, pin } = frozen();
    const bound = { protocol, pin, arm: 'structured-pair' as const };
    expect(() => requireDreamPilotProtocol({ ...bound, protocol: null }, current)).toThrow();
    expect(() => requireDreamPilotProtocol({ ...bound, protocol: { ...protocol, seed: 'changed' } }, current)).toThrow(
      'changed',
    );
    expect(() => requireDreamPilotProtocol(bound, { ...current, sourceSnapshot: 'b'.repeat(64) })).toThrow(
      'snapshot changed',
    );
    expect(() => requireDreamPilotProtocol(bound, { ...current, reviewer: 'other' })).toThrow('configuration changed');
    expect(() => requireDreamPilotProtocol(bound, { ...current, mode: 'auto' })).toThrow('manual');
    expect(() => requireDreamPilotProtocol(bound, { ...current, arity: 'mixed' })).toThrow('arm');
    expect(() => requireDreamPilotProtocol({ ...bound, arm: 'blender' }, current)).toThrow('ordinary Blender');
    expect(
      requireDreamPilotProtocol({ ...bound, arm: 'uniform-pair' }, { ...current, samplerMode: 'random-control' }),
    ).toEqual(protocol);
    expect(requireDreamPilotProtocol({ ...bound, arm: 'structured-triple' }, { ...current, arity: 3 })).toEqual(
      protocol,
    );
  });

  it('pins explicit larger monetary ceilings without changing the study design', () => {
    const original = frozen();
    const money = {
      discoveryUsd: 200,
      discoveryUsdPerArm: 50,
      cycleUsd: 10,
      rollingDayUsd: 200,
      experimentComputeUsd: 100,
    };
    const raised = freezeDreamEvaluationProtocol({ ...original.protocol, ...money });
    expect(raised.pin).not.toBe(original.pin);
    expect(raised.protocol.limits).toEqual({ ...original.protocol.limits, ...money });
    expect(
      requireDreamPilotProtocol(
        { ...raised, arm: 'structured-pair' },
        {
          ...current,
          cycle: { maxCostUsd: 10, rolling24hCostUsd: 200 },
        },
      ),
    ).toEqual(raised.protocol);
    expect(() => requireDreamPilotProtocol({ ...raised, arm: 'structured-pair' }, current)).toThrow('monetary');
    expect(frozen()).toEqual(original);
  });

  it.each(['discoveryUsd', 'discoveryUsdPerArm', 'cycleUsd', 'rollingDayUsd', 'experimentComputeUsd'] as const)(
    'requires finite nonnegative %s and includes it in the pin',
    (key) => {
      const { protocol, pin } = frozen();
      for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
        expect(() =>
          DreamEvaluationProtocolSchema.parse({
            ...protocol,
            limits: { ...protocol.limits, [key]: invalid },
          }),
        ).toThrow();
        expect(() => freezeDreamEvaluationProtocol({ ...protocol, [key]: invalid })).toThrow();
      }
      const zero = freezeDreamEvaluationProtocol({ ...protocol, [key]: 0 });
      expect(zero.protocol.limits[key]).toBe(0);
      expect(() =>
        requireDreamPilotProtocol(
          {
            protocol: { ...protocol, limits: { ...protocol.limits, [key]: protocol.limits[key] + 1 } },
            pin,
            arm: 'structured-pair',
          },
          current,
        ),
      ).toThrow('changed');
    },
  );

  it.each([
    { maxCostUsd: 2, rolling24hCostUsd: 5 },
    { maxCostUsd: 0, rolling24hCostUsd: 5 },
    { maxCostUsd: 1, rolling24hCostUsd: 10 },
    { maxCostUsd: 1, rolling24hCostUsd: 0 },
  ])('rejects a current monetary configuration different from its pin: %o', (cycle) => {
    expect(() => requireDreamPilotProtocol({ ...frozen(), arm: 'structured-pair' }, { ...current, cycle })).toThrow(
      'monetary',
    );
  });

  it('keeps the nonmonetary study bounds fixed', () => {
    const { protocol } = frozen();
    for (const key of ['attempts', 'attemptsPerArm', 'cycleAttempts', 'experimentMinutes', 'experimentCount'] as const)
      expect(() =>
        DreamEvaluationProtocolSchema.parse({
          ...protocol,
          limits: { ...protocol.limits, [key]: protocol.limits[key] + 1 },
        }),
      ).toThrow();
  });

  it('reconciles all arms using the same unique-family numerator and cold-start/full-cost denominator', () => {
    const result = summarizeDreamEvaluationCosts(DREAM_EVALUATION_ARMS.flatMap((arm) => [costs(arm), costs(arm)]));
    for (const arm of result)
      expect(arm).toMatchObject({
        attempts: 2,
        uniqueQualifiedFamilies: 1,
        discoveryUsd: 2,
        experimentUsd: 2,
        qualifiedPerUsd: 0.5,
        verifiedBeneficialExperiments: 2,
        beneficialPerTotalUsd: 0.5,
        engineerMinutes: 24,
        verdict: 'inconclusive',
      });
  });

  it('keeps unknown, omitted, negative and empty accounting distinct from zero cost', () => {
    const row = costs('blender');
    row.phases.indexing = null;
    expect(summarizeDreamEvaluationCosts([row])[0]).toMatchObject({
      discoveryUsd: null,
      qualifiedPerUsd: null,
      beneficialPerTotalUsd: null,
    });
    expect(summarizeDreamEvaluationCosts([])[0]).toMatchObject({
      attempts: 0,
      discoveryUsd: null,
      qualifiedPerUsd: null,
    });
    row.phases.indexing = -1;
    expect(() => summarizeDreamEvaluationCosts([row])).toThrow('Invalid');
    delete (row.phases as Partial<typeof row.phases>).indexing;
    expect(() => summarizeDreamEvaluationCosts([row])).toThrow('omitted');
  });
});

describe('source-grounded benchmark validity and honest confusion denominators', () => {
  it('freezes disjoint calibration/held-out cases with every required negative control', () => {
    expect(DREAM_BENCHMARK_LABELS.map((l) => [l.id, l.split])).toEqual(
      DREAM_BENCHMARK_CASES.map((c) => [c.id, c.split]),
    );
    expect(new Set(DREAM_BENCHMARK_CASES.map((c) => c.id)).size).toBe(DREAM_BENCHMARK_CASES.length);
    const classes = new Set(DREAM_BENCHMARK_LABELS.map((l) => l.class));
    for (const name of [
      'positive-transfer',
      'existing-integration',
      'impossible-composition',
      'lexical-only',
      'a-only',
      'b-only',
      'irrelevant-c',
      'stale-source',
      'missing-source',
      'absent-benefit',
    ])
      expect(classes.has(name), name).toBe(true);
    // The input supplied to an independent reviewer contains no answer key.
    expect(JSON.stringify(DREAM_BENCHMARK_CASES)).not.toContain('"expected":');
  });

  it('executes curated source counterexamples rather than inferring labels from fluent text', () => {
    const evaluate = (id: string, expression: string, vars: Record<string, unknown> = {}) => {
      const c = DREAM_BENCHMARK_CASES.find((c) => c.id === id)!;
      // These bounded fragments and expressions are trusted repository fixtures.
      // Check their semantics in a fresh context under the test runner's deadline;
      // a separate 100ms VM timer measures scheduling rather than correctness.
      const run = compileFunction(`const A=${c.a}; const B=${c.b}; const C=${c.c}; return (${expression});`,
        Object.keys(vars), { parsingContext: createContext() });
      return run(...Object.values(vars));
    };
    const rows = [{ cents: 40 }, { cents: 70 }];
    expect(evaluate('H01', '[B(A(rows),100),B(A(rows),60)]', { rows })).toEqual([false, true]);
    expect(evaluate('H03', 'typeof B(A())')).toBe('string');
    expect(evaluate('H04', 'B(A())')).toBe('cache:refresh');
    expect(evaluate('H05', 'B(A(rows,100))===A(rows,100)', { rows })).toBe(true);
    expect(evaluate('H06', 'B(A(rows),100)===B(rows,100)', { rows })).toBe(true);
    expect(evaluate('H07', 'B(A(rows),100)', { rows })).toBe(true);
    expect(evaluate('H10', '[B(A(rows),C({dailyCapCents:100})),B(A(rows),C({dailyCapCents:120}))]', { rows })).toEqual([
      true,
      false,
    ]);
    expect(evaluate('H12', 'B(A(keys))', { keys: [' One ', 'one', 'TWO'] })).toEqual(['one', 'two']);
    expect(evaluate('H12', 'A(keys)', { keys: [' One ', 'one', 'TWO'] })).toEqual(['one', 'one', 'two']);
    expect(evaluate('H12', 'B(keys)', { keys: [' One ', 'one', 'TWO'] })).toHaveLength(3);
  });

  it('preserves missing and unresolved positives and every known-negative denominator', () => {
    const report = dreamReviewerConfusion(
      DREAM_BENCHMARK_LABELS,
      [
        { id: 'H01', verdict: 'reject', evidence: 'Deliberately overstrict control.' },
        { id: 'H02', verdict: 'accept', evidence: 'Deliberate duplicate false accept.' },
        { id: 'H10', verdict: 'unverified', evidence: 'Unresolved positive.' },
      ],
      'held-out',
    );
    expect(report.total).toBe(12);
    expect(report.missing).toBe(9);
    expect(report.falseAccept).toMatchObject({ numerator: 1, denominator: 9, value: 1 / 9 });
    expect(report.falseReject).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(report.positiveUnresolved).toMatchObject({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(report.cases.find((c) => c.id === 'H12')?.observed).toBe('missing');
    expect(dreamReviewerConfusion([], [], 'held-out').exactAgreement.value).toBeNull();
  });

  it('rejects duplicate/unknown judgments and duplicate labels rather than silently shrinking the sample', () => {
    const row = { id: 'H01', verdict: 'accept' as const, evidence: 'source' };
    expect(() => dreamReviewerConfusion(DREAM_BENCHMARK_LABELS, [row, row], 'held-out')).toThrow('duplicated');
    expect(() => dreamReviewerConfusion(DREAM_BENCHMARK_LABELS, [{ ...row, id: 'absent' }], 'held-out')).toThrow(
      'Unknown',
    );
    expect(() =>
      dreamReviewerConfusion([...DREAM_BENCHMARK_LABELS, DREAM_BENCHMARK_LABELS[0]!], [], 'held-out'),
    ).toThrow('Duplicate');
  });

  it('replays the actual independently recorded held-out judgments on the exact reviewed source bytes', () => {
    expect(capabilityHash(readFileSync(new URL('../../test/dream-benchmark-cases.ts', import.meta.url), 'utf8'))).toBe(
      independentReview.sourceFileSha256,
    );
    expect(independentReview.sourceRef).toBe('work-item:WI-10000489#comment-200846');
    expect(independentReview.reviewer).not.toBe('su-a6afb33c-aacd-45a3-a376-3ece53264f94');
    const report = dreamReviewerConfusion(
      DREAM_BENCHMARK_LABELS,
      independentReview.judgments as Array<{
        id: string;
        verdict: 'accept' | 'reject' | 'unverified';
        evidence: string;
      }>,
      'held-out',
    );
    expect(report.total).toBe(12);
    expect(report.missing).toBe(0);
    expect(report.unverified).toBe(2);
    expect(report.falseAccept).toMatchObject({ numerator: 0, denominator: 9, value: 0 });
    expect(report.falseReject).toMatchObject({ numerator: 0, denominator: 3, value: 0 });
    expect(report.exactAgreement.value).toBe(1);
    expect(report.falseAccept.wilson95![1]).toBeGreaterThan(0.29);
    expect(report.falseReject.wilson95![1]).toBeGreaterThan(0.56);
    expect(report.scope).toContain('not a population estimate');
  });
});

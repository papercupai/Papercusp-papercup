import { describe, it, expect } from 'vitest';
import { aggregateArm, buildSuiteReport, classifyAttemptOutcome, summarizeAssignedOutcomes } from './aggregate';
import type { TaskRunResult, ArmId, GraderStatus } from './schema';

let seq = 0;
function mk(over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run1',
    suite: 'swe-bench-pro',
    modality: 'diff',
    taskId: 't1',
    arm: 'papercusp',
    seed: seq++,
    resolved: false,
    graderStatus: 'failed',
    graderFamily: 'swe-bench-pro',
    graderVersion: 'v1',
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    costUsd: 0,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1000,
    turns: 1,
    budgetTokens: 2_000_000,
    capped: false,
    generationStatus: 'completed',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'bp@sha',
    preregHash: 'h',
    rolloutId: 'ro1',
    createdAt: '2026-06-15T00:00:00Z',
    ...over,
  };
}

/** One scored attempt: task, arm, resolved, with tokens that price to a known cost. */
function attempt(taskId: string, arm: ArmId, resolved: boolean, tokensIn: number): TaskRunResult {
  return mk({
    taskId,
    arm,
    resolved,
    graderStatus: (resolved ? 'passed' : 'failed') as GraderStatus,
    tokensIn,
    tokensTotal: tokensIn,
  });
}

describe('shared assigned outcome projection', () => {
  it('matches canonical binary scoring and distinguishes budget outcome from grader outage', () => {
    const rows = [mk({ seed: 0, resolved: true, graderStatus: 'passed' }),
      mk({ taskId: 't2', seed: 0, resolved: null, generationStatus: 'timeout', graderStatus: 'error' })];
    const opts = { assignedTaskIds: ['t1', 't2'], assignedSeeds: [0, 1] };
    expect(summarizeAssignedOutcomes(rows, opts)).toMatchObject({ primaryResolvedPct: 0.25,
      conditionalResolvedPct: 1, assignedAttempts: 4, absentAttempts: 2, missingMeasurements: 0 });
    expect(aggregateArm(rows, 'swe-bench-pro', 'papercusp', opts).passAt1).toBe(0.25);
    expect(summarizeAssignedOutcomes([rows[0], { ...rows[1], generationStatus: 'completed' }], opts))
      .toMatchObject({ primaryResolvedPct: null, primaryMeanScore: null, missingMeasurements: 1 });
  });
  it('weights tasks equally when their observed seed counts differ', () => {
    const rows = [mk({ seed: 0, score: 0.5 }), mk({ seed: 1, score: 1 }), mk({ taskId: 't2', seed: 0, score: 0.1 })];
    expect(summarizeAssignedOutcomes(rows).primaryMeanScore).toBeCloseTo((0.75 + 0.1) / 2);
  });
  it('retains empty assigned populations and rejects duplicated attempts', () => {
    expect(summarizeAssignedOutcomes([], { assignedTaskIds: ['t1'], assignedSeeds: [0, 1] }))
      .toMatchObject({ primaryResolvedPct: 0, primaryMeanScore: 0, absentAttempts: 2, conditionalResolvedPct: null });
    const row = mk({ seed: 0 });
    expect(() => summarizeAssignedOutcomes([row, row])).toThrow('duplicate');
  });
  it.each([NaN, Infinity, -0.1, 1.1])('refuses an invalid partial-credit measurement %s', score => {
    expect(summarizeAssignedOutcomes([mk({ seed: 0, resolved: true, score })]))
      .toMatchObject({ primaryMeanScore: null, measurementComplete: false, missingMeasurements: 1 });
  });
});

// Plan benchmark-coverage-frontierswe-v2-2026-10-10 D-008 (P-020): the four-way outcome rides the SAME
// primary denominator — budget_exhausted is a measured outcome, invalid and grader_error are missing.
describe('four-way attempt outcome', () => {
  it.each([
    [{ graderStatus: 'passed', resolved: true, score: 1 }, 'scored'],
    [{ graderStatus: 'failed', resolved: false, score: 0 }, 'scored'],
    [{ graderStatus: 'failed', resolved: false, score: 0.4, capped: true }, 'budget_exhausted'],
    [{ graderStatus: 'invalid', resolved: null, score: null }, 'invalid'],
    // An integrity verdict wins even if a stray resolved/score rode along with it.
    [{ graderStatus: 'invalid', resolved: true, score: 1, capped: true }, 'invalid'],
    [{ graderStatus: 'error', resolved: null, score: null, capped: true }, 'grader_error'],
    [{ graderStatus: 'timeout', resolved: null, score: null }, 'grader_error'],
    [{ graderStatus: 'failed', resolved: false, score: 1.5 }, 'grader_error'],
    [{ generationStatus: 'error', graderStatus: 'error', resolved: null }, 'generation_failed'],
    [{ generationStatus: 'timeout', graderStatus: 'error', resolved: null }, 'generation_failed'],
  ] as const)('%o → %s', (over, expected) => {
    expect(classifyAttemptOutcome(mk({ seed: 0, ...over } as Partial<TaskRunResult>))).toBe(expected);
  });

  it('counts every outcome and keeps budget_exhausted in the primary score while invalid nulls it', () => {
    const assignedTaskIds = ['t1', 't2', 't3', 't4', 't5'];
    const rows = [
      mk({ taskId: 't1', seed: 0, resolved: true, graderStatus: 'passed', score: 1 }),
      mk({ taskId: 't2', seed: 0, resolved: false, graderStatus: 'failed', score: 0.5, capped: true }),
      mk({ taskId: 't3', seed: 0, resolved: null, graderStatus: 'error', score: null }),
      mk({ taskId: 't4', seed: 0, resolved: null, graderStatus: 'invalid', score: null }),
      mk({ taskId: 't5', seed: 0, resolved: null, graderStatus: 'error', generationStatus: 'error', generationError: 'crash' }),
    ];
    const s = summarizeAssignedOutcomes(rows, { assignedTaskIds, assignedSeeds: [0] });
    expect(s.outcomes).toEqual({ scored: 1, budgetExhausted: 1, invalid: 1, graderError: 1, generationFailed: 1 });
    expect(s).toMatchObject({ missingMeasurements: 2, measurementComplete: false, primaryMeanScore: null,
      gradedAttempts: 2, conditionalMeanScore: 0.75 });
    // Without the two missing measurements the budget-capped 0.5 counts and the crash counts as 0.
    const measured = summarizeAssignedOutcomes(rows.filter(r => r.taskId !== 't3' && r.taskId !== 't4'),
      { assignedTaskIds: ['t1', 't2', 't5'], assignedSeeds: [0] });
    expect(measured.primaryMeanScore).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(measured.outcomes).toEqual({ scored: 1, budgetExhausted: 1, invalid: 0, graderError: 0, generationFailed: 1 });
  });

  it('does not let an invalid attempt carrying a verdict reach the measured population', () => {
    const s = summarizeAssignedOutcomes([mk({ seed: 0, resolved: true, graderStatus: 'invalid', score: 1 })]);
    expect(s).toMatchObject({ missingMeasurements: 1, gradedAttempts: 0, resolved: 0, primaryResolvedPct: null });
  });
});

describe('frozen report population', () => {
  it.each(['papercusp', 'baseline-b-native'])('keeps primary outcome but excludes %s with missing usage from efficiency claims', missingArm => {
    const rows = ['papercusp', 'baseline-b-native'].map(arm => mk({ arm: arm as ArmId, seed: 0,
      resolved: true, graderStatus: 'passed', tokensIn: 100, tokensTotal: 100,
      ...(arm === missingArm ? { armMeta: { costUsdMeasurementMissing: true } } : {}) }));
    const report = buildSuiteReport(rows);
    expect(report.arms.every(arm => arm.passAt1 === 1)).toBe(true);
    const missing = report.arms.find(arm => arm.arm === missingArm)!;
    expect(missing.cost).toMatchObject({ missingMeasurements: 1, costPerResolved: null });
    expect(missing.cost.costUsd).toBeGreaterThan(0); // known subtotal survives
    expect(report.frontier.map(point => point.arm)).not.toContain(missingArm);
    expect(report.deltas[0]).toMatchObject({ accuracyDelta: 0, efficiencyMeasured: false,
      costRatio: null, costFraction: null, paretoDominates: false });
  });

  it('includes a wholly absent assigned arm without assigning it a free-cost frontier point', () => {
    const report = buildSuiteReport([mk({ seed: 0, resolved: true, graderStatus: 'passed' })], {
      assignedTaskIds: ['t1', 't2'], assignedSeeds: [0, 1, 2], assignedArms: ['papercusp', 'baseline-b-native'],
    });
    expect(report.arms[0].passAt1).toBeCloseTo(1 / 6);
    expect(report.arms[1]).toMatchObject({ arm: 'baseline-b-native', passAt1: 0, attempts: 0, tasks: 2 });
    expect(report.frontier.map(p => p.arm)).toEqual(['papercusp']);
    expect(report.deltas[0]).toMatchObject({ accuracyDelta: 1 / 6, efficiencyMeasured: false,
      uncertainty: { taskPairs: 2, baselineAbsentAttempts: 6, treatmentAbsentAttempts: 5 } });
  });
  it('requires explicit identity and a complete frozen roster for an empty report', () => {
    expect(() => buildSuiteReport([])).toThrow('no rows');
    const report = buildSuiteReport([], {
      runId: 'empty', suite: 'swe-bench-pro', assignedTaskIds: ['t1'], assignedSeeds: [0], assignedArms: ['papercusp'],
    });
    expect(report.runId).toBe('empty');
    expect(report.arms[0]).toMatchObject({ passAt1: 0, absentTasks: 1, attempts: 0 });
  });
});

describe('aggregateArm', () => {
  it('computes pass@1 as the task-weighted mean of per-seed resolved rates', () => {
    const rows = [
      // t1: 3/3 resolved, t2: 2/3 resolved → pass@1 = mean(1, 2/3) = 0.8333
      attempt('t1', 'papercusp', true, 1_000_000),
      attempt('t1', 'papercusp', true, 1_000_000),
      attempt('t1', 'papercusp', true, 1_000_000),
      attempt('t2', 'papercusp', true, 1_000_000),
      attempt('t2', 'papercusp', true, 1_000_000),
      attempt('t2', 'papercusp', false, 1_000_000),
      // one generation-infra row — excluded from accuracy, counted in cost
      mk({ taskId: 't1', generationStatus: 'error', resolved: null, tokensIn: 1_000_000, tokensTotal: 1_000_000 }),
    ];
    const r = aggregateArm(rows, 'swe-bench-pro', 'papercusp');
    expect(r.passAt1).toBeCloseTo((3 / 4 + 2 / 3) / 2, 6);
    expect(r.conditionalPassAt1).toBeCloseTo(5 / 6, 6);
    expect(r.tasks).toBe(2);
    expect(r.attempts).toBe(7);
    expect(r.gradedAttempts).toBe(6);
    expect(r.infraErrors).toBe(1);
    expect(r.cappedRuns).toBe(0);
    // pass@k[0] is k=1 and must equal pass@1 exactly (consistency)
    expect(r.passAtK[0].k).toBe(1);
    expect(r.passAt1).not.toBeNull();
    expect(r.passAtK[0].value).toBeCloseTo(r.passAt1!, 10);
    expect(r.passAtK[1].k).toBe(3);
    // cost counts ALL 7 rows (incl. the crashed one): 7 × $5 (1M Opus input)
    expect(r.cost.tokensTotal).toBe(7_000_000);
    expect(r.cost.costUsd).toBeCloseTo(35, 6);
    expect(r.cost.costPerResolved).toBeCloseTo(35 / 5, 6); // 5 resolved
  });
});

describe('buildSuiteReport', () => {
  it('retains tasks absent from both arms and absent assigned seeds', () => {
    const report = buildSuiteReport([
      mk({ taskId: 'a', seed: 1, resolved: true, graderStatus: 'passed' }),
      mk({ taskId: 'a', arm: 'baseline-b-native', seed: 1, resolved: true, graderStatus: 'passed' }),
    ], { assignedTaskIds: ['a', 'b'], assignedSeeds: [1, 2] });
    expect(report.arms.map(arm => arm.passAt1)).toEqual([0.25, 0.25]);
    expect(report.arms[0]).toMatchObject({ tasks: 2, attempts: 1, absentTasks: 1 });
  });

  it('suppresses primary accuracy, frontier and deltas for grader outages', () => {
    const report = buildSuiteReport([
      mk({ graderStatus: 'error', resolved: null }),
      mk({ arm: 'baseline-b-native', resolved: true, graderStatus: 'passed' }),
    ]);
    expect(report.arms[0]).toMatchObject({ passAt1: null, missingMeasurements: 1 });
    expect(report.frontier.map(point => point.arm)).toEqual(['baseline-b-native']);
    expect(report.arms[0].passAt1Ci).toBeNull();
    expect(report.arms[0].resolvedRateWilson).toBeNull();
    expect(report.deltas[0]).toMatchObject({ accuracyDelta: null, accuracyDeltaCi: null,
      uncertainty: { status: 'missing-grade', missingMeasurements: 1 } });
  });

  it('reports per-arm scores, the cost/accuracy frontier, and papercusp-vs-baseline deltas', () => {
    const rows = [
      // papercusp: pass@1 = mean(1, 2/3) = 0.8333, expensive (1M Opus in/row)
      attempt('t1', 'papercusp', true, 1_000_000),
      attempt('t1', 'papercusp', true, 1_000_000),
      attempt('t1', 'papercusp', true, 1_000_000),
      attempt('t2', 'papercusp', true, 1_000_000),
      attempt('t2', 'papercusp', true, 1_000_000),
      attempt('t2', 'papercusp', false, 1_000_000),
      // baseline-b-native: pass@1 = mean(1/3, 0) = 0.1667, cheap (100k in/row)
      attempt('t1', 'baseline-b-native', true, 100_000),
      attempt('t1', 'baseline-b-native', false, 100_000),
      attempt('t1', 'baseline-b-native', false, 100_000),
      attempt('t2', 'baseline-b-native', false, 100_000),
      attempt('t2', 'baseline-b-native', false, 100_000),
      attempt('t2', 'baseline-b-native', false, 100_000),
    ];
    const report = buildSuiteReport(rows);
    expect(report.arms).toHaveLength(2);

    const pc = report.arms.find((a) => a.arm === 'papercusp')!;
    const base = report.arms.find((a) => a.arm === 'baseline-b-native')!;
    expect(pc.passAt1).toBeCloseTo(5 / 6, 6);
    expect(base.passAt1).toBeCloseTo(1 / 6, 6);

    // Both on the frontier: papercusp more accurate, baseline cheaper → neither dominates.
    expect(report.frontier.every((p) => p.onFrontier)).toBe(true);

    const d = report.deltas.find((x) => x.baseline === 'baseline-b-native')!;
    expect(d.treatment).toBe('papercusp');
    expect(d.accuracyDelta).toBeCloseTo(5 / 6 - 1 / 6, 6); // +0.6667
    // costPerResolved: papercusp 30/5=6 ... wait: 6 rows × $5 = $30, 5 resolved → 6
    expect(pc.cost.costPerResolved).toBeCloseTo(6, 6);
    expect(base.cost.costPerResolved).toBeCloseTo((6 * 0.5) / 1, 6); // 6 × $0.5 = $3, 1 resolved → 3
    expect(d.costRatio).toBeCloseTo(6 / 3, 6);
    // papercusp is dearer per attempt → does NOT Pareto-dominate the baseline
    expect(d.paretoDominates).toBe(false);

    expect(report.isoBudget.ok).toBe(true);
    expect(report.protocolKs).toEqual([1, 3]);
  });

  it('throws on empty input', () => {
    expect(() => buildSuiteReport([])).toThrow(/no rows/);
  });

  it('collapses seeds before paired repository inference and preserves entirely absent task pairs', () => {
    const makeRows = (seeds: number[]) => seeds.flatMap(seed => [
      mk({ taskId: 'a', seed, resolved: true, graderStatus: 'passed' }),
      mk({ taskId: 'a', seed, arm: 'baseline', resolved: false }),
      mk({ taskId: 'b', seed, resolved: false }),
      mk({ taskId: 'b', seed, arm: 'baseline', resolved: true, graderStatus: 'passed' }),
    ]);
    const opts = { assignedTaskIds: ['a', 'b', 'absent'], assignedArms: ['papercusp', 'baseline'],
      repositoryByTask: { a: 'repo-a', b: 'repo-b', absent: 'repo-a' } };
    const one = buildSuiteReport(makeRows([0]), { ...opts, assignedSeeds: [0] });
    const repeated = buildSuiteReport(makeRows([0, 1, 2]), { ...opts, assignedSeeds: [0, 1, 2] });
    expect(repeated.deltas[0].accuracyDeltaCi).toEqual(one.deltas[0].accuracyDeltaCi);
    expect(repeated.arms[0].passAt1Ci).toEqual(one.arms[0].passAt1Ci);
    expect(repeated.sampling).toMatchObject({ unit: 'repository', independentUnits: 2,
      taskPairs: 3, seedPolicy: 'collapse-within-task', assignedSeeds: [0, 1, 2] });
    expect(repeated.deltas[0].uncertainty).toMatchObject({ status: 'measured', taskPairs: 3,
      independentUnits: 2, baselineObservedAttempts: 6, treatmentObservedAttempts: 6,
      baselineAbsentAttempts: 3, treatmentAbsentAttempts: 3 });
    expect(repeated.deltas[0].accuracyDeltaCi!.lower).toBeLessThan(0);
    expect(repeated.deltas[0].accuracyDeltaCi!.upper).toBeGreaterThan(0);
    expect(buildSuiteReport([...makeRows([0])].reverse(), { ...opts, assignedSeeds: [0] }).deltas)
      .toEqual(one.deltas);
  });

  it('withholds intervals for insufficient independent repositories or unregistered current policies', () => {
    const rows = [mk({ taskId: 'a', seed: 0, resolved: true, graderStatus: 'passed' }),
      mk({ taskId: 'b', seed: 0, arm: 'baseline', resolved: false })];
    const opts = { assignedTaskIds: ['a', 'b'], assignedSeeds: [0], assignedArms: ['papercusp', 'baseline'] };
    const single = buildSuiteReport(rows, { ...opts, repositoryByTask: { a: 'repo', b: 'repo' } });
    expect(single.deltas[0]).toMatchObject({ accuracyDelta: 0.5, accuracyDeltaCi: null,
      uncertainty: { status: 'insufficient-independent-units', independentUnits: 1 } });
    expect(single.arms.every(arm => arm.passAt1Ci === null)).toBe(true);
    const unregistered = buildSuiteReport(rows, { ...opts, requireRegisteredSampling: true });
    expect(unregistered.sampling.unit).toBe('unregistered');
    expect(unregistered.deltas[0]).toMatchObject({ accuracyDeltaCi: null,
      uncertainty: { status: 'unregistered-policy', independentUnits: null } });
  });

  it.each([{ a: 'repo' }, { a: 'repo', b: 'repo', foreign: 'repo' }, { a: 'repo', b: '' }] as Record<string, string>[])
    ('rejects repository roster drift %j', repositoryByTask => {
      expect(() => buildSuiteReport([mk({ taskId: 'a', seed: 0 })], {
        assignedTaskIds: ['a', 'b'], assignedSeeds: [0], repositoryByTask,
      })).toThrow(/repository mapping/);
    });

  it('rides a non-SWE benchmark: open arm vocab + interactive modality + custom treatmentArm', () => {
    // tau2-style: a 'hive' arm vs a 'su' arm on an interactive suite, treatment = 'hive'.
    const rows = [
      mk({ suite: 'tau2-bench', modality: 'interactive', arm: 'hive', taskId: 't1', resolved: true, graderStatus: 'passed' }),
      mk({ suite: 'tau2-bench', modality: 'interactive', arm: 'hive', taskId: 't2', resolved: true, graderStatus: 'passed' }),
      mk({ suite: 'tau2-bench', modality: 'interactive', arm: 'su', taskId: 't1', resolved: true, graderStatus: 'passed' }),
      mk({ suite: 'tau2-bench', modality: 'interactive', arm: 'su', taskId: 't2', resolved: false, graderStatus: 'failed' }),
    ];
    const report = buildSuiteReport(rows, { treatmentArm: 'hive' });
    const d = report.deltas.find((x) => x.baseline === 'su')!;
    expect(d.treatment).toBe('hive');
    expect(d.accuracyDelta).toBeCloseTo(1 - 0.5, 6); // hive 1.0 − su 0.5
  });
});

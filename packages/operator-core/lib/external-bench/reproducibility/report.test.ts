import { describe, expect, it } from 'vitest';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import type { PreregRecord } from './schema';
import { buildRunReports } from './store';
import { currentProtocolFixture } from './_protocol-test-fixture';

const prereg = (config: Record<string, unknown> = {}): PreregRecord => ({
  runId: 'assigned-run', preregHash: 'frozen-hash', suites: ['swe-bench-pro'],
  config: { taskIds: ['a', 'b'], seeds: [0, 1, 2], arms: ['papercusp', 'baseline-b-native'], ...config },
  filePath: 'benchmarks/preregistrations/assigned-run.json', gitCommitted: true, createdAt: '2026-10-09T00:00:00Z',
});
const result = (over: Partial<TaskRunResult> = {}): TaskRunResult => ({
  runId: 'assigned-run', suite: 'swe-bench-pro', taskId: 'a', arm: 'papercusp', seed: 0,
  modality: 'diff', resolved: true, graderStatus: 'passed', graderFamily: 'official', graderVersion: 'pinned',
  generationStatus: 'completed', tokensIn: 1, tokensOut: 1, tokensTotal: 2, costUsd: 0.1,
  priceTableVersion: 'price-table-v1', wallClockMs: 10, turns: 1, capped: false, modelId: 'claude-opus-4-8',
  harnessVersion: 'current', preregHash: 'frozen-hash', rolloutId: 'r', createdAt: '2026-10-09T00:00:01Z', ...over,
});

describe('preregistered product reports', () => {
  it('reports the maintained structured-arm protocol with absent assignments preserved', () => {
    const protocol = currentProtocolFixture('assigned-run');
    protocol.taskIds = ['a', 'b'];
    protocol.sampling!.taskRepositories = { a: 'repo-a', b: 'repo-b', 'withheld-1': 'withheld-repo' };
    protocol.seeds = [0, 1, 2];
    const frozen = prereg({ ...protocol });
    const [report] = buildRunReports([result({ modelId: protocol.arms[0].model })], frozen);
    expect(report.assignment).toMatchObject({ basis: 'frozen', arms: ['papercusp', 'baseline'],
      taskIds: ['a', 'b'], seeds: [0, 1, 2], preregHash: frozen.preregHash });
    expect(report.arms[0].passAt1).toBeCloseTo(1 / 6);
    expect(report.arms[1]).toMatchObject({ arm: 'baseline', attempts: 0, absentTasks: 2, passAt1: 0 });
    expect(buildRunReports([], frozen)[0].arms).toHaveLength(2);
  });

  it('validates the complete current protocol rather than projecting ids from malformed controls', () => {
    const protocol = currentProtocolFixture('assigned-run');
    expect(() => buildRunReports([], prereg({ ...protocol, runId: 'other-run' }))).toThrow(/frozen|protocol/);
    expect(() => buildRunReports([], prereg({ ...protocol, priceSchedule: undefined }))).toThrow();
    expect(() => buildRunReports([], prereg({ ...protocol, taskIds: undefined }))).toThrow();
    expect(() => buildRunReports([], prereg({ ...protocol, arms: protocol.arms.map(arm => ({ ...arm, model: '' })) }))).toThrow();
  });

  it('normalizes current model aliases with the frozen protocol prices rather than the historical table', () => {
    const protocol = currentProtocolFixture('assigned-run');
    const row = result({ taskId: 't1', seed: 1, modelId: protocol.arms[0].model,
      tokensIn: 1_000_000, tokensOut: 500_000, tokensTotal: 1_700_000, tokensCacheRead: 200_000 });
    const [report] = buildRunReports([row], prereg({ ...protocol }));
    // tokensIn is uncached input; cache read/write counts are additive.
    // Frozen $1/M input, $0.50/M cached input, $2/M output.
    expect(report.arms[0].cost.costUsd).toBeCloseTo(2.1);
    expect(report.priceTableVersion).toBe(protocol.priceSchedule.version);
    const cachedWrite = { ...row, tokensCacheWrite: 10 };
    expect(() => buildRunReports([cachedWrite], prereg({ ...protocol }))).toThrow(/frozen cache-write price/);
    protocol.priceSchedule.rates[0].cacheWriteUsdPerMillion = 1.25;
    expect(buildRunReports([cachedWrite], prereg({ ...protocol }))[0].arms[0].cost.costUsd).toBeCloseTo(2.1000125);
    expect(() => buildRunReports([{ ...row, modelId: 'other-model' }], prereg({ ...protocol }))).toThrow(/model/);
    expect(() => buildRunReports([{ ...row, preregHash: 'other-hash' }], prereg({ ...protocol }))).toThrow(/preregistration/);
  });

  it('retains missing task, seed and whole-arm outcomes from the frozen assignment', () => {
    const [report] = buildRunReports([result()], prereg());
    expect(report.assignment).toMatchObject({ basis: 'frozen', taskIds: ['a', 'b'], seeds: [0, 1, 2], preregHash: 'frozen-hash' });
    expect(report.arms[0]).toMatchObject({ tasks: 2, attempts: 1, absentTasks: 1, conditionalPassAt1: 1 });
    expect(report.arms[0].passAt1).toBeCloseTo(1 / 6);
    expect(report.arms[1]).toMatchObject({ arm: 'baseline-b-native', tasks: 2, attempts: 0, passAt1: 0, absentTasks: 2 });
    expect(report.frontier.map(point => point.arm)).toEqual(['papercusp']);
    expect(report.deltas[0]).toMatchObject({ efficiencyMeasured: false, costFraction: null,
      uncertainty: { taskPairs: 2, baselineAbsentAttempts: 6, treatmentAbsentAttempts: 5 } });
  });

  it('reports a wholly unattempted frozen run instead of erasing it', () => {
    const [report] = buildRunReports([], prereg());
    expect(report.arms).toHaveLength(2);
    expect(report.arms.every(arm => arm.tasks === 2 && arm.passAt1 === 0 && arm.attempts === 0)).toBe(true);
    expect(report.frontier).toEqual([]);
    expect(report.deltas[0]).toMatchObject({ accuracyDelta: 0, efficiencyMeasured: false,
      uncertainty: { baselineAbsentAttempts: 6, treatmentAbsentAttempts: 6 } });
  });

  it('keeps agent timeout as an assigned outcome and grader outage inconclusive', () => {
    const [report] = buildRunReports([
      result({ generationStatus: 'timeout', resolved: null, graderStatus: 'error' }),
      result({ arm: 'baseline-b-native', resolved: null, graderStatus: 'error' }),
    ], prereg());
    expect(report.arms[0]).toMatchObject({ passAt1: 0, missingMeasurements: 0 });
    expect(report.arms[1]).toMatchObject({ passAt1: null, missingMeasurements: 1 });
    expect(report.deltas[0]).toMatchObject({ accuracyDelta: null, accuracyDeltaCi: null,
      uncertainty: { status: 'missing-grade', missingMeasurements: 1 } });
  });

  it.each([
    { taskId: 'foreign' }, { arm: 'undeclared' }, { seed: 3 }, { runId: 'other-run' }, { suite: 'other-suite' },
  ])('refuses an out-of-assignment result %j', over => {
    expect(() => buildRunReports([result(over)], prereg())).toThrow(/frozen/);
  });

  it.each([{ seeds: [] }, { seeds: [0, 0] }, { arms: [] }, { taskIds: ['a', 'a'] }])('refuses malformed frozen assignment %j', config => {
    expect(() => buildRunReports([result()], prereg(config))).toThrow(/invalid frozen/);
  });

  it('supports the existing seed-count convention without inferring missing seeds from rows', () => {
    const [report] = buildRunReports([result()], prereg({ seeds: 3 }));
    expect(report.assignment?.seeds).toEqual([0, 1, 2]);
    expect(report.arms[0].passAt1).toBeCloseTo(1 / 6);
  });

  it('labels old observed-only evidence without inventing a preregistered population', () => {
    const legacy = prereg(); legacy.config = { model: 'old', seeds: 3 };
    expect(buildRunReports([result()], legacy)[0].assignment?.basis).toBe('observed');
    expect(buildRunReports([], legacy)).toEqual([]);
  });

  it('binds repository intervals and reproduction settings to the immutable protocol', () => {
    const protocol = currentProtocolFixture('assigned-run');
    protocol.taskIds = ['a', 'b', 'absent']; protocol.seeds = [0, 1];
    protocol.sampling = { unit: 'repository', ci: 0.9, bootstrapSeed: 17, bootstrapIterations: 2000,
      taskRepositories: { a: 'repo-a', b: 'repo-b', absent: 'repo-a', 'withheld-1': 'withheld-repo' } };
    const rows = protocol.seeds.flatMap(seed => [
      result({ taskId: 'a', seed, modelId: protocol.arms[0].model }),
      result({ taskId: 'b', seed, modelId: protocol.arms[0].model, resolved: false, graderStatus: 'failed' }),
      result({ taskId: 'a', seed, arm: 'baseline', modelId: protocol.arms[1].model, resolved: false, graderStatus: 'failed' }),
      result({ taskId: 'b', seed, arm: 'baseline', modelId: protocol.arms[1].model }),
    ]);
    const [report] = buildRunReports(rows, prereg({ ...protocol }));
    expect(report.sampling).toMatchObject({ unit: 'repository', taskPairs: 3, independentUnits: 2,
      ci: 0.9, bootstrapSeed: 17, bootstrapIterations: 2000,
      repositoryByTask: { a: 'repo-a', b: 'repo-b', absent: 'repo-a' } });
    expect(report.deltas[0].uncertainty).toMatchObject({ taskPairs: 3, independentUnits: 2,
      baselineAbsentAttempts: 2, treatmentAbsentAttempts: 2 });
    expect(report.deltas[0].accuracyDeltaCi).toMatchObject({ point: 0, ci: 0.9 });
    const reordered = buildRunReports([...rows].reverse(), prereg({ ...protocol }))[0];
    expect(reordered.deltas).toEqual(report.deltas);
    delete protocol.sampling;
    const [historical] = buildRunReports(rows, prereg({ ...protocol }));
    expect(historical.deltas[0]).toMatchObject({ accuracyDelta: 0, accuracyDeltaCi: null,
      uncertainty: { status: 'unregistered-policy' } });
    expect(historical.arms.every(arm => arm.passAt1Ci === null)).toBe(true);
  });
});

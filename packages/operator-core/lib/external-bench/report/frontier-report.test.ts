import { describe, it, expect } from 'vitest';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import { buildFrontierSweSuiteData, frontierSweCaveats, FrontierSweReportRefusal } from './frontier-report';

/** Minimal frontier-swe row — only the fields buildFrontierSweSuiteData reads matter; rest cast away. */
function row(
  taskId: string,
  arm: string,
  seed: number,
  score: number | null,
  over: Partial<TaskRunResult> = {},
): TaskRunResult {
  return {
    suite: 'frontier-swe',
    taskId,
    arm,
    seed,
    score,
    generationStatus: 'completed',
    graderStatus: 'passed',
    ...over,
  } as unknown as TaskRunResult;
}

/** 5 trials of one (task, arm) at a constant score. */
function trials(taskId: string, arm: string, score: number, over: Partial<TaskRunResult> = {}): TaskRunResult[] {
  return [0, 1, 2, 3, 4].map((s) => row(taskId, arm, s, score, over));
}

describe('buildFrontierSweSuiteData', () => {
  it('rolls up per-arm mean@5/best@5 + AVG-RANK + dominance over scored rows', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6),
      ...trials('impl1', 'opus', 0.3),
      ...trials('perf1', 'hive', 0.5),
      ...trials('perf1', 'opus', 0.8),
    ];
    const sd = buildFrontierSweSuiteData(rows, {
      k: 5,
      taskBucket: { impl1: 'implementation', perf1: 'performance' },
    });
    expect(sd.k).toBe(5);
    expect(sd.taskCount).toBe(2);
    expect(sd.trialCount).toBe(20);
    expect(sd.excludedCount).toBe(0);
    const hive = sd.arms.find((a) => a.arm === 'hive')!;
    const opus = sd.arms.find((a) => a.arm === 'opus')!;
    // impl1: hive 0.6 > opus 0.3; perf1: opus 0.8 > hive 0.5 → each wins one → avgRank 1.5 both.
    expect(hive.avgRank).toBeCloseTo(1.5);
    expect(opus.avgRank).toBeCloseTo(1.5);
    expect(hive.bestAtK).toBeCloseTo((0.6 + 0.5) / 2);
    // per-bucket present
    expect(sd.perBucket.implementation).toBeDefined();
    expect(sd.perBucket.performance).toBeDefined();
    // in the implementation bucket alone, hive wins → rank 1
    expect(sd.perBucket.implementation.find((a) => a.arm === 'hive')!.avgRank).toBeCloseTo(1);
  });

  it('EXCLUDES infra non-completions (not scored 0) and surfaces the count (C6)', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6),
      row('impl1', 'hive', 5, null, { generationStatus: 'error' }), // infra → excluded
      row('impl1', 'hive', 6, null, { graderStatus: 'timeout' }), //   infra → excluded
    ];
    const sd = buildFrontierSweSuiteData(rows, { k: 5 });
    expect(sd.trialCount).toBe(5);
    expect(sd.excludedCount).toBe(2);
    // the excluded rows did NOT drag the score toward 0
    expect(sd.arms.find((a) => a.arm === 'hive')!.meanAtK).toBeCloseTo(0.6);
  });

  it('a real 0 score COUNTS (capability fail, not excluded)', () => {
    const sd = buildFrontierSweSuiteData(trials('impl1', 'opus', 0), { k: 5 });
    expect(sd.excludedCount).toBe(0);
    expect(sd.trialCount).toBe(5);
    expect(sd.arms.find((a) => a.arm === 'opus')!.bestAtK).toBe(0);
  });

  it('ignores non-frontier-swe rows', () => {
    const rows = [...trials('impl1', 'hive', 0.6), row('x', 'hive', 0, 0.9, { suite: 'gdpval' } as Partial<TaskRunResult>)];
    const sd = buildFrontierSweSuiteData(rows, { k: 5 });
    expect(sd.taskCount).toBe(1);
    expect(sd.trialCount).toBe(5);
  });

  it('always carries the mandatory caveats', () => {
    const sd = buildFrontierSweSuiteData([], { k: 5 });
    expect(sd.caveats).toEqual(frontierSweCaveats({ corpusVersion: null, taskCount: 0 }));
    expect(sd.caveats.length).toBe(3);
    expect(sd.arms).toEqual([]);
    expect(sd.corpusVersion).toBeNull();
    expect(sd.graderVersions).toEqual([]);
    expect(sd.bucketTaskCounts).toEqual({});
  });
});

/** v2 scorer pins (corpus commit + verifier image digest) as frontierSweTaskGraderVersion emits them. */
const V2_PIN = 'frontier-swe@v2+da83f84f8fbc verifier=ghcr.io/x/astronomy-toolkit@sha256:' + 'a'.repeat(64);
const V2_PIN_REPUSHED = 'frontier-swe@v2+da83f84f8fbc verifier=ghcr.io/x/astronomy-toolkit@sha256:' + 'b'.repeat(64);
const V1_PIN = 'frontier-swe@v1 0123456789abcdef0123456789abcdef01234567';

describe('buildFrontierSweSuiteData — v2 comparability (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-003)', () => {
  it('leads with mean@5 rather than best-score rank and labels the secondary metrics', () => {
    const rows = ['t1', 't2'].flatMap(task => [
      ...trials(task, 'steady', 0.6, { graderVersion: V2_PIN }),
      ...[1, 0, 0, 0, 0].map((score, seed) => row(task, 'spike', seed, score, { graderVersion: V2_PIN })),
    ]);
    const sd = buildFrontierSweSuiteData(rows, {
      taskBucket: { t1: 'implementation', t2: 'implementation' },
      taskCategories: { t1: ['Implementation', 'Visual Reasoning'], t2: ['Implementation'] },
    });
    expect(sd.headlineMetric).toBe('mean@5');
    expect(sd.secondaryMetrics).toEqual(['best@5', 'avg-rank', 'dominance']);
    expect(sd.arms.map(a => a.arm)).toEqual(['steady', 'spike']);
    expect(sd.arms[0].avgRank).toBe(2);
    expect(sd.headline.steady.value).toBeCloseTo(0.6);
    expect(sd.headline.spike.value).toBeCloseTo(0.2);
    expect(sd.headline.steady.interval?.point).toBeCloseTo(0.6);
    expect(sd.categoryTaskCounts).toEqual({ Implementation: 2, 'Visual Reasoning': 1 });
    expect(sd.perCategory.Implementation[0].arm).toBe('steady');
    expect(sd.perBucket.implementation[0].arm).toBe('steady');
    expect(sd.taskCount).toBe(2); // overlapping categories do not double-weight t1
    expect(sd.uncategorizedTaskIds).toEqual([]);
    expect(sd.pairedComparisons[0].comparison).toMatchObject({ n: 2, resamplingUnit: 'pair', independentUnits: 2 });
    expect(sd.pairedComparisons[0].comparison?.delta.point).toBeCloseTo(0.4); // steady - spike
  });

  it('discloses incomplete tasks and pairs only complete task means, with no fabricated headline', () => {
    const rows = ['t1', 't2', 'short'].flatMap(task => [
      ...trials(task, 'A', 0.2, { graderVersion: V2_PIN }),
      ...trials(task, 'B', 0.6, { graderVersion: V2_PIN }).filter(r => task !== 'short' || r.seed < 4),
    ]);
    rows.push(row('short', 'B', 4, null, { graderVersion: V2_PIN, graderStatus: 'error' }));
    const sd = buildFrontierSweSuiteData(rows);
    expect(sd.incompleteTasks).toEqual({ A: [], B: ['short'] });
    expect(sd.headline.B.value).toBeNull();
    expect(sd.headline.B.interval).toBeNull();
    expect(sd.arms.find(a => a.arm === 'B')?.tasksUsed).toBe(2);
    expect(sd.pairedComparisons[0].taskIds).toEqual(['t1', 't2']);
    expect(sd.pairedComparisons[0].excludedTaskIds).toEqual(['short']);
    expect(sd.pairedComparisons[0].comparison?.n).toBe(2);
    expect(sd.pairedComparisons[0].comparison?.delta.point).toBeCloseTo(0.4);
    expect(sd.excludedCount).toBe(1);
    expect(sd.uncategorizedTaskIds).toEqual(['short', 't1', 't2']);
  });

  it('matches the hand-computed three-task mean@5 and gives each task equal weight', () => {
    const rows = [
      ...[0, 0, 0, 0, 1].map((score, seed) => row('t1', 'A', seed, score, { graderVersion: V2_PIN })),
      ...trials('t2', 'A', 0.5, { graderVersion: V2_PIN }),
      ...trials('t3', 'A', 0.8, { graderVersion: V2_PIN }),
    ];
    expect(buildFrontierSweSuiteData(rows).headline.A.value).toBeCloseTo((0.2 + 0.5 + 0.8) / 3);
    // An additional complete seed must not give t3 more weight than the other tasks.
    rows.push(row('t3', 'A', 5, 0.8, { graderVersion: V2_PIN }));
    const score = buildFrontierSweSuiteData(rows).headline.A.value;
    expect(score).toBeCloseTo(0.5);
    expect(score).not.toBeCloseTo((1 + 2.5 + 4.8) / 16);
  });

  it('never invents an interval from one paired task or counts invalid grader results', () => {
    const rows = [...trials('t', 'A', 0, { graderVersion: V2_PIN }), ...trials('t', 'B', 1, { graderVersion: V2_PIN })];
    rows.push(row('invalid', 'A', 0, 1, { graderVersion: V2_PIN, graderStatus: 'invalid' }));
    const sd = buildFrontierSweSuiteData(rows);
    expect(sd.pairedComparisons[0].comparison).toBeNull();
    expect(sd.pairedComparisons[0].taskIds).toEqual(['t']);
    expect(sd.excludedCount).toBe(1);
    expect(sd.incompleteTasks.A).toEqual(['invalid']);
    expect(sd.arms.find(a => a.arm === 'A')?.meanAtK).toBe(0);
  });

  it('refuses duplicate seeds instead of presenting four distinct trials as mean@5', () => {
    const rows = trials('t', 'A', 0.5, { graderVersion: V2_PIN }).filter(r => r.seed < 4);
    rows.push(rows[0]);
    expect(() => buildFrontierSweSuiteData(rows)).toThrow(/duplicate trial/);
  });

  it('uses frozen assignment scope to disclose completely absent tasks and arms', () => {
    const sd = buildFrontierSweSuiteData(trials('present', 'A', 0.5, { graderVersion: V2_PIN }), {
      assignedTaskIds: ['present', 'absent'], assignedArms: ['A', 'B'],
    });
    expect(sd.incompleteTasks).toEqual({ A: ['absent'], B: ['absent', 'present'] });
    expect(sd.headline.A.value).toBeNull();
    expect(sd.headline.B).toEqual({ value: null, interval: null, taskIds: [] });
    expect(sd.pairedComparisons[0]).toMatchObject({ taskIds: [], excludedTaskIds: ['absent', 'present'], comparison: null });
  });

  it('retains historical rank ordering for v1', () => {
    const rows = [
      ...trials('t', 'steady', 0.6, { graderVersion: V1_PIN }),
      ...[1, 0, 0, 0, 0].map((score, seed) => row('t', 'spike', seed, score, { graderVersion: V1_PIN })),
    ];
    const sd = buildFrontierSweSuiteData(rows);
    expect(sd.headlineMetric).toBe('avg-rank');
    expect(sd.arms[0].arm).toBe('spike');
    expect(sd.headline.spike.value).toBe(1);
    expect(sd.headline.spike.interval).toBeNull();
  });

  it('names the corpus version and the scorer pins of the rows it folded', () => {
    const sd = buildFrontierSweSuiteData(
      [...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }), ...trials('impl1', 'opus', 0.3, { graderVersion: V2_PIN })],
      { k: 5 },
    );
    expect(sd.corpusVersion).toBe('v2');
    expect(sd.graderVersions).toEqual([V2_PIN]);
  });

  it('REFUSES rows graded against both corpus versions — v1 is history and never aggregates with v2 (R-1)', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }),
      ...trials('impl9', 'hive', 0.4, { graderVersion: V1_PIN }),
    ];
    let err: unknown;
    try {
      buildFrontierSweSuiteData(rows, { k: 5 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FrontierSweReportRefusal);
    expect(err).toMatchObject({ code: 'mixed-corpus-versions', detail: { counts: { v1: 5, v2: 5 } } });
    expect((err as Error).message).toMatch(/both corpus versions/);
  });

  it('an EXCLUDED v1 row still counts as contamination: a mixed run is refused, not silently filtered', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }),
      row('impl9', 'hive', 0, null, { graderStatus: 'error', graderVersion: V1_PIN }),
    ];
    expect(() => buildFrontierSweSuiteData(rows, { k: 5 })).toThrow(FrontierSweReportRefusal);
  });

  it('an ungraded placeholder (graderVersion "") names no corpus and does not trip the mixed-version refusal', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }),
      row('impl1', 'hive', 5, null, { generationStatus: 'error', graderVersion: '' }),
    ];
    const sd = buildFrontierSweSuiteData(rows, { k: 5 });
    expect(sd.corpusVersion).toBe('v2');
    expect(sd.excludedCount).toBe(1);
    expect(sd.graderVersions).toEqual([V2_PIN]);
  });

  it('REFUSES a task whose arms were scored by different verifier pins (C5)', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }),
      ...trials('impl1', 'opus', 0.3, { graderVersion: V2_PIN_REPUSHED }),
    ];
    let err: unknown;
    try {
      buildFrontierSweSuiteData(rows, { k: 5 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FrontierSweReportRefusal);
    expect(err).toMatchObject({ code: 'scorer-mismatch' });
    const conflicts = (err as FrontierSweReportRefusal).detail.conflicts as Array<{
      taskId: string;
      scorers: Array<{ graderVersion: string; arms: string[] }>;
    }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].taskId).toBe('impl1');
    expect(conflicts[0].scorers).toEqual(
      expect.arrayContaining([
        { graderVersion: V2_PIN, arms: ['hive'] },
        { graderVersion: V2_PIN_REPUSHED, arms: ['opus'] },
      ]),
    );
  });

  it('different scorers on DIFFERENT tasks are fine — the check is per task, across its arms', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }),
      ...trials('impl1', 'opus', 0.3, { graderVersion: V2_PIN }),
      ...trials('perf1', 'hive', 0.5, { graderVersion: V2_PIN_REPUSHED }),
      ...trials('perf1', 'opus', 0.8, { graderVersion: V2_PIN_REPUSHED }),
    ];
    const sd = buildFrontierSweSuiteData(rows, { k: 5 });
    expect(sd.graderVersions).toEqual([V2_PIN, V2_PIN_REPUSHED]);
    expect(sd.taskCount).toBe(2);
  });

  it('a scorer mismatch on an EXCLUDED row does not refuse — only scored rows enter the comparison', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }),
      row('impl1', 'opus', 0, null, { graderStatus: 'timeout', graderVersion: V2_PIN_REPUSHED }),
    ];
    expect(buildFrontierSweSuiteData(rows, { k: 5 }).excludedCount).toBe(1);
  });

  it('DERIVES per-bucket task counts from the rows + taskBucket, in coarse-bucket order', () => {
    const rows = [
      ...trials('res1', 'hive', 0.2),
      ...trials('impl1', 'hive', 0.6),
      ...trials('impl2', 'hive', 0.7),
      ...trials('perf1', 'hive', 0.5),
      ...trials('nobucket', 'hive', 0.5),
    ];
    const sd = buildFrontierSweSuiteData(rows, {
      k: 5,
      taskBucket: { res1: 'research', impl1: 'implementation', impl2: 'implementation', perf1: 'performance' },
    });
    expect(sd.bucketTaskCounts).toEqual({ implementation: 2, performance: 1, research: 1 });
    expect(Object.keys(sd.bucketTaskCounts)).toEqual(['implementation', 'performance', 'research']);
    expect(Object.keys(sd.perBucket)).toEqual(['implementation', 'performance', 'research']);
    expect(sd.taskCount).toBe(5);
  });

  it('the small-N caveat states THIS report’s derived task count + corpus, never a hand-written corpus size', () => {
    const sd = buildFrontierSweSuiteData(
      [...trials('impl1', 'hive', 0.6, { graderVersion: V2_PIN }), ...trials('perf1', 'hive', 0.4, { graderVersion: V2_PIN })],
      { k: 5 },
    );
    const smallN = sd.caveats.find((c) => c.includes('small-N'))!;
    expect(smallN).toContain('2 tasks scored from the FrontierSWE v2 corpus');
    expect(sd.caveats.join(' ')).not.toMatch(/\b17 tasks\b/);
    expect(sd.caveats).toHaveLength(3);
  });

  it('a v1 report carries the HISTORY caveat', () => {
    const sd = buildFrontierSweSuiteData(trials('impl1', 'hive', 0.6, { graderVersion: V1_PIN }), { k: 5 });
    expect(sd.corpusVersion).toBe('v1');
    expect(sd.caveats).toHaveLength(4);
    expect(sd.caveats[3]).toMatch(/v1 HISTORY/);
    expect(sd.caveats[1]).toContain('1 task scored from the FrontierSWE v1 corpus');
  });
});

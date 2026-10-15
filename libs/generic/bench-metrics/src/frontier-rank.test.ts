import { describe, it, expect } from 'vitest';
import {
  meanAtK,
  bestAtK,
  armMeanAtK,
  armBestAtK,
  avgRank,
  dominance,
  frontierRankReport,
  type ArmTaskTrials,
} from './frontier-rank';

const approx = (x: number | null, y: number, eps = 1e-9) => {
  expect(x).not.toBeNull();
  expect(Math.abs((x as number) - y)).toBeLessThan(eps);
};

describe('meanAtK', () => {
  it('is the mean of all trials when n ≥ k', () => approx(meanAtK([0.2, 0.4, 0.6], 3), 0.4));
  it('mean@1 = overall mean', () => approx(meanAtK([0, 1], 1), 0.5));
  it('null when fewer than k trials', () => expect(meanAtK([0.5], 2)).toBeNull());
});

describe('bestAtK — unbiased expected max of a random k-subset', () => {
  it('best@n = max', () => approx(bestAtK([0.2, 0.4, 0.6], 3), 0.6));
  it('best@1 = mean (expected single sample)', () => approx(bestAtK([0, 1], 1), 0.5));
  it('best@2 of [0, 0.5, 1] = 0.8333… (brute force: (0.5+1+1)/3)', () => approx(bestAtK([0, 0.5, 1], 2), 2.5 / 3));
  it('is order-independent', () => approx(bestAtK([1, 0, 0.5], 2), bestAtK([0, 0.5, 1], 2) as number));
  it('null when fewer than k trials', () => expect(bestAtK([0.9], 2)).toBeNull());
  it('best@5 of five identical trials = that value', () => approx(bestAtK([0.3, 0.3, 0.3, 0.3, 0.3], 5), 0.3));
});

describe('armMeanAtK / armBestAtK — across tasks, skip < k', () => {
  it('averages per-task values and surfaces skips', () => {
    const tasks = [
      [0.2, 0.4, 0.6], // mean 0.4, best@2 = (0.4+0.6+0.6)/3 = 0.5333
      [0.0, 1.0], //      mean 0.5, best@2 = 1.0
      [0.9], //           skipped at k=2
    ];
    const m = armMeanAtK(tasks, 2);
    expect(m.tasksUsed).toBe(2);
    expect(m.skipped).toBe(1);
    approx(m.value, (0.4 + 0.5) / 2);
    const b = armBestAtK(tasks, 2);
    approx(b.value, (1.6 / 3 + 1.0) / 2, 1e-9);
  });
});

const LEADERBOARD = [
  { taskId: 't1', scores: { A: 0.9, B: 0.5, C: 0.1 } },
  { taskId: 't2', scores: { A: 0.2, B: 0.8, C: 0.5 } },
];

describe('avgRank (lower = better)', () => {
  it('ranks per task and averages', () => {
    const { avgRank: r, tasksRanked } = avgRank(LEADERBOARD);
    approx(r.A, 2); // ranks 1,3
    approx(r.B, 1.5); // ranks 2,1
    approx(r.C, 2.5); // ranks 3,2
    expect(tasksRanked).toEqual({ A: 2, B: 2, C: 2 });
  });
  it('ties share the average rank', () => {
    const { avgRank: r } = avgRank([{ taskId: 't', scores: { A: 0.5, B: 0.5 } }]);
    approx(r.A, 1.5);
    approx(r.B, 1.5);
  });
});

describe('dominance (win rate vs random opponent, ties = 0.5)', () => {
  it('counts pairwise wins over all tasks × other arms', () => {
    const d = dominance(LEADERBOARD);
    approx(d.A, 0.5); // t1: beats B,C (2); t2: beats none (0) → 2/4
    approx(d.B, 0.75); // t1: beats C (1); t2: beats A,C (2) → 3/4
    approx(d.C, 0.25); // t1: 0; t2: beats A (1) → 1/4
  });
  it('a tie is half a win', () => {
    const d = dominance([{ taskId: 't', scores: { A: 0.5, B: 0.5 } }]);
    approx(d.A, 0.5);
    approx(d.B, 0.5);
  });
});

describe('frontierRankReport — the suite rollup', () => {
  const tasks: ArmTaskTrials[] = [
    { taskId: 'impl1', tier: 'implementation', trials: { hive: [0.4, 0.6], opus: [0.2, 0.3] } },
    { taskId: 'perf1', tier: 'performance', trials: { hive: [0.5, 0.5], opus: [0.6, 0.8] } },
  ];

  it('ranks arms by best@k and reports mean@k/best@k/avgRank/dominance, sorted by avgRank', () => {
    const r = frontierRankReport(tasks, 2);
    expect(r.k).toBe(2);
    expect(r.perTaskBestAtK).toHaveLength(2);
    const hive = r.arms.find((a) => a.arm === 'hive')!;
    const opus = r.arms.find((a) => a.arm === 'opus')!;
    // impl1: hive best@2 = 0.6 > opus 0.3; perf1: opus best@2 = 0.8 > hive 0.5 → each wins one → avgRank 1.5 both.
    approx(hive.bestAtK, (0.6 + 0.5) / 2);
    approx(opus.bestAtK, (0.3 + 0.8) / 2);
    approx(hive.avgRank, 1.5);
    approx(opus.avgRank, 1.5);
    approx(hive.dominance, 0.5);
    expect(hive.tasksUsed).toBe(2);
    // sorted by avgRank asc (tie here) → both present
    expect(r.arms.map((a) => a.arm).sort()).toEqual(['hive', 'opus']);
  });

  it('tierFilter restricts to one category (per-tier reporting, C8)', () => {
    const r = frontierRankReport(tasks, 2, { tierFilter: 'performance' });
    expect(r.perTaskBestAtK).toHaveLength(1);
    expect(r.perTaskBestAtK[0].taskId).toBe('perf1');
    // perf1: opus 0.8 > hive 0.5 → opus rank 1, hive rank 2
    const opus = r.arms.find((a) => a.arm === 'opus')!;
    approx(opus.avgRank, 1);
    approx(opus.dominance, 1);
  });

  it('a solo arm (no opponents on any task) gets dominance NaN, not 0 (review Bug 1)', () => {
    const solo: ArmTaskTrials[] = [{ taskId: 't', tier: 'implementation', trials: { hive: [0.5, 0.5] } }];
    const r = frontierRankReport(solo, 2);
    const hive = r.arms.find((a) => a.arm === 'hive')!;
    expect(Number.isNaN(hive.dominance)).toBe(true);
    expect(hive.avgRank).toBeCloseTo(1); // the sole arm ranks 1
    expect(hive.meanAtK).toBeCloseTo(0.5);
  });

  it('rejects k < 1', () => expect(() => frontierRankReport(tasks, 0)).toThrow());

  it('can rank by task-weighted mean when best-score rank prefers the other arm', () => {
    const v2: ArmTaskTrials[] = [
      { taskId: 't1', trials: { steady: [0.6, 0.6, 0.6, 0.6, 0.6], spike: [1, 0, 0, 0, 0] } },
      { taskId: 't2', trials: { steady: [0.6, 0.6, 0.6, 0.6, 0.6], spike: [1, 0, 0, 0, 0] } },
      { taskId: 'short', trials: { steady: [1, 1, 1, 1] } },
    ];
    expect(frontierRankReport(v2, 5).arms[0].arm).toBe('spike');
    const r = frontierRankReport(v2, 5, { ranking: 'mean' });
    expect(r.arms.map(a => a.arm)).toEqual(['steady', 'spike']);
    expect(r.arms[0].meanAtK).toBeCloseTo(0.6);
    expect(r.arms[0].tasksUsed).toBe(2);
    expect(r.perTaskMeanAtK).toEqual([
      { taskId: 't1', tier: undefined, scores: { steady: 0.6, spike: 0.2 } },
      { taskId: 't2', tier: undefined, scores: { steady: 0.6, spike: 0.2 } },
    ]);
  });
});

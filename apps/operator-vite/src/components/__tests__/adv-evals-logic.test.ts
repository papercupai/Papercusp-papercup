/**
 * adv-evals-logic — pure-logic tests for the Evaluation tab's sync→viz mappers
 * (impartial-benchmark-suite-2026-06-15 P-020 / BRIEF 9).
 *
 * Covers the two presentation mappers that turn @papercusp/sync rows into the
 * shared eval-viz props (P-021 Frontier / Compare), plus the arm-vocab contract.
 * The statistical aggregation (pass@k, CIs) lives in P-011's @papercusp/bench-metrics
 * and is tested there; these only assert the UI-side shaping.
 */
import { describe, it, expect } from 'vitest';
import {
  toFrontierPoints,
  toComparePerTask,
  EVAL_VIEWS,
  type EvalReport,
  type EvalRunRow,
} from '../adv/AdvEvalsTab';

describe('EVAL_VIEWS', () => {
  it('is the subtab axis (launch first, then L1 + the L2–L4 hive layer + the runs + compare views)', () => {
    expect([...EVAL_VIEWS]).toEqual([
      'launch', 'external', 'throughput', 'value', 'coordination', 'internal', 'report', 'preserved', 'compare',
    ]);
  });
});

describe('toFrontierPoints', () => {
  it('excludes an inconclusive grader measurement instead of plotting a zero', () => {
    expect(toFrontierPoints({ suite: 'swe-bench-pro', byArm: [
      { arm: 'papercusp', passAt1: null, costUsd: 2 },
      { arm: 'baseline-b-native', passAt1: 0, costUsd: 2 },
    ] })).toEqual([expect.objectContaining({ arm: 'baseline-b-native', score: 0 })]);
  });

  it('returns [] for an undefined report (clean empty state)', () => {
    expect(toFrontierPoints(undefined)).toEqual([]);
  });

  it('maps each priced arm to one {label, cost, score, arm} point', () => {
    const report: EvalReport = {
      suite: 'swe-bench-pro',
      byArm: [
        { arm: 'papercusp', passAt1: 0.62, costUsd: 4.2 },
        { arm: 'baseline-b-native', passAt1: 0.55, costUsd: 3.1 },
      ],
    };
    const pts = toFrontierPoints(report);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ arm: 'papercusp', cost: 4.2, score: 0.62 });
    // label is the shared armLabel, not the raw id.
    expect(pts[0].label).toBe('Papercusp');
  });

  it('drops arms with no derived cost (cannot plot on the cost axis)', () => {
    const report: EvalReport = {
      suite: 's',
      byArm: [
        { arm: 'papercusp', passAt1: 0.6, costUsd: 4 },
        { arm: 'baseline-a-ablation', passAt1: 0.5, costUsd: null },
      ],
    };
    expect(toFrontierPoints(report).map((p) => p.arm)).toEqual(['papercusp']);
  });
});

describe('toComparePerTask', () => {
  const rows: EvalRunRow[] = [
    // task-1: papercusp resolves both seeds (1.0), native resolves one of two (0.5)
    { taskId: 'task-1', arm: 'papercusp', seed: 0, resolved: true },
    { taskId: 'task-1', arm: 'papercusp', seed: 1, resolved: true },
    { taskId: 'task-1', arm: 'baseline-b-native', seed: 0, resolved: true },
    { taskId: 'task-1', arm: 'baseline-b-native', seed: 1, resolved: false },
    // task-2: an infra-error row (resolved=null) must be excluded from the mean
    { taskId: 'task-2', arm: 'papercusp', seed: 0, resolved: false },
    { taskId: 'task-2', arm: 'papercusp', seed: 1, resolved: null },
    { taskId: 'task-2', arm: 'baseline-b-native', seed: 0, resolved: false },
  ];

  it('pivots by task into per-task pass@1 for the two arms, sorted by task', () => {
    const out = toComparePerTask(rows, 'baseline-b-native', 'papercusp');
    expect(out).toEqual([
      { label: 'task-1', baseline: 0.5, treatment: 1 },
      { label: 'task-2', baseline: 0, treatment: 0 }, // null seed excluded → mean of [0] = 0
    ]);
  });

  it('excludes infra-error (resolved=null) rows from the mean', () => {
    const out = toComparePerTask(rows, 'baseline-b-native', 'papercusp');
    const task2 = out.find((r) => r.label === 'task-2');
    // papercusp task-2 had one false + one null → only the false counts → 0, not NaN.
    expect(task2?.treatment).toBe(0);
  });

  it('leaves an arm null for a task where it has no scored run', () => {
    const sparse: EvalRunRow[] = [
      { taskId: 't', arm: 'papercusp', seed: 0, resolved: true },
    ];
    expect(toComparePerTask(sparse, 'baseline-b-native', 'papercusp')).toEqual([
      { label: 't', baseline: null, treatment: 1 },
    ]);
  });
});

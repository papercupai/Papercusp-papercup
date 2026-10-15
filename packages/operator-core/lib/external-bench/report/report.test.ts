/**
 * Benchmark report builder tests (plan benchmark-report-portable-trace-2026-06-17).
 * Pure — no PG, no fs reads of run data (buildReportHtml reads only the committed viewer template).
 */
import { describe, it, expect } from 'vitest';
import { bundleFromRollouts, buildReportHtml } from './report-builder';
import { BENCH_REPORT_SCHEMA_VERSION } from './report-schema';

function rr(over: Record<string, unknown> = {}) {
  return {
    taskId: 't1',
    arm: 'a',
    seed: 0,
    resolved: true,
    graderStatus: 'passed',
    generationStatus: 'completed',
    stopReason: 'done',
    costUsd: 1,
    tokensIn: 10,
    tokensOut: 20,
    tokensTotal: 30,
    wallClockMs: 100,
    ...over,
  };
}

describe('bundleFromRollouts', () => {
  it('uses complete assigned-task cost and retains tied Pareto and task winners', () => {
    const rows = ['a', 'b', 'c'].flatMap(arm => ['t1', 't2'].flatMap(taskId => [0, 1].map(seed =>
      rr({ arm, taskId, seed, costUsd: arm === 'c' ? 2 : 1 }))));
    const b = bundleFromRollouts({ runId: 'cost', suite: 'swe-bench-pro', createdAt: '2026-10-11',
      arms: ['a', 'b', 'c'], models: {}, assignedTaskIds: ['t1', 't2'], assignedSeeds: [0, 1], runResults: rows });
    expect(b.arms.map(arm => arm.costPerAssignedTaskUsd)).toEqual([2, 2, 4]);
    expect(b.costComparison?.points.map(point => point.onFrontier)).toEqual([true, true, false]);
    expect(b.costComparison?.taskWinners[0]).toMatchObject({ taskId: 't1', value: 1, incompleteArms: [],
      winners: [{ arm: 'a', costUsd: 2, tokensTotal: 60 }, { arm: 'b', costUsd: 2 }, { arm: 'c', costUsd: 4 }] });
    const html = buildReportHtml(b);
    expect(html).toContain('Cost versus assigned outcome');
    expect(html).toContain('Per-task winner costs');
  });
  it('cannot turn partial accounting or absent trials into a cheap frontier point', () => {
    const b = bundleFromRollouts({ runId: 'cost', suite: 'swe-bench-pro', createdAt: '2026-10-11',
      arms: ['a', 'b'], models: {}, assignedTaskIds: ['t1'], assignedSeeds: [0, 1],
      runResults: [rr({ armMeta: { costUsdMeasurementMissing: true }, costUsd: 0 }), rr({ seed: 1 }), rr({ arm: 'b' })] });
    expect(b.costComparison?.points).toMatchObject([
      { arm: 'a', costPerTaskUsd: null, onFrontier: null, excludedReasons: expect.arrayContaining(['incomplete-cost']) },
      { arm: 'b', costPerTaskUsd: null, onFrontier: null, excludedReasons: expect.arrayContaining(['absent-attempts']) },
    ]);
    expect(b.costComparison?.taskWinners[0]).toMatchObject({ value: 1, winners: [{ arm: 'a', costUsd: null }] });
  });
  it('keeps grader outages inconclusive and uses assigned partial credit for the cost axis', () => {
    const b = bundleFromRollouts({ runId: 'cost', suite: 'frontier-swe', createdAt: '2026-10-11',
      arms: ['a', 'b'], models: {}, assignedTaskIds: ['t1'], assignedSeeds: [0],
      runResults: [rr({ resolved: false, score: 0.6, graderStatus: 'failed' }),
        rr({ arm: 'b', resolved: null, score: null, graderStatus: 'error' })] });
    expect(b.costComparison).toMatchObject({ metric: 'assigned-mean-score',
      points: [{ arm: 'a', value: 0.6, onFrontier: true }, { arm: 'b', value: null, onFrontier: null }],
      taskWinners: [{ value: null, incompleteArms: ['b'], winners: [] }] });
  });
  it('withholds Pareto claims for observed rosters or incompatible cost bases', () => {
    const rows = [rr(), rr({ arm: 'b', armMeta: { nativeCostAccounting: { basis: 'frozen-normalized-native-source' } } })];
    const input = { runId: 'cost', suite: 'swe-bench-pro', createdAt: '2026-10-11', arms: ['a', 'b'], models: {}, runResults: rows };
    expect(bundleFromRollouts(input).costComparison?.points.every(point => point.onFrontier === null)).toBe(true);
    const b = bundleFromRollouts({ ...input, assignedTaskIds: ['t1'], assignedSeeds: [0] });
    expect(b.costComparison?.points).toMatchObject([
      { onFrontier: null, excludedReasons: expect.arrayContaining(['incompatible-cost-bases']) },
      { onFrontier: null, excludedReasons: expect.arrayContaining(['incompatible-cost-bases']) },
    ]);
  });
  it('does not report a winner when every assigned task outcome is zero', () => {
    const b = bundleFromRollouts({ runId: 'cost', suite: 'swe-bench-pro', createdAt: '2026-10-11', arms: ['a'], models: {},
      assignedTaskIds: ['t1'], assignedSeeds: [0], runResults: [rr({ resolved: false, graderStatus: 'failed' })] });
    expect(b.costComparison?.taskWinners[0]).toMatchObject({ value: 0, winners: [] });
  });
  it('uses the frozen task/seed population for primary outcome and labels scored-only quality separately', () => {
    const b = bundleFromRollouts({ runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-10-10',
      arms: ['a', 'b'], models: { a: 'm', b: 'm' }, assignedTaskIds: ['t1', 't2'], assignedSeeds: [0, 1],
      runResults: [rr(), rr({ taskId: 't2', resolved: null, generationStatus: 'timeout', graderStatus: 'error' })] });
    expect(b.arms[0]).toMatchObject({ assignedTasks: 2, assignedAttempts: 4, attempts: 2,
      absentAttempts: 2, primaryResolvedPct: 0.25, conditionalResolvedPct: 1, measurementComplete: true });
    expect(b.arms[1]).toMatchObject({ assignedTasks: 2, assignedAttempts: 4, attempts: 0,
      absentAttempts: 4, primaryResolvedPct: 0, conditionalResolvedPct: null });
    expect(b.run.totals.tasks).toBe(2);
  });
  it.each(['error', 'timeout', 'pending'])('keeps a completed submission with grader %s inconclusive', graderStatus => {
    const b = bundleFromRollouts({ runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-10-10',
      arms: ['a'], models: { a: 'm' }, assignedTaskIds: ['t1', 't2'], assignedSeeds: [0],
      runResults: [rr(), rr({ taskId: 't2', resolved: null, graderStatus })] });
    expect(b.arms[0]).toMatchObject({ primaryResolvedPct: null, primaryMeanScore: null,
      missingMeasurements: 1, measurementComplete: false, conditionalResolvedPct: 1 });
  });
  it('weights partial credit by assigned tasks and seeds while preserving conditional quality', () => {
    const b = bundleFromRollouts({ runId: 'r', suite: 'the-agent-company', createdAt: '2026-10-10',
      arms: ['a'], models: { a: 'm' }, assignedTaskIds: ['t1', 't2'], assignedSeeds: [0, 1],
      runResults: [rr({ resolved: false, score: 0.4, graderStatus: 'failed' })] });
    expect(b.arms[0]).toMatchObject({ primaryMeanScore: 0.1, meanScore: 0.4, assignedAttempts: 4 });
  });
  it('rejects a result outside the frozen roster instead of changing its denominator', () => {
    expect(() => bundleFromRollouts({ runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-10-10',
      arms: ['a'], models: { a: 'm' }, assignedTaskIds: ['t2'], assignedSeeds: [0], runResults: [rr()] }))
      .toThrow('outside frozen');
  });
  it('exports an entirely absent assigned population without inventing observed assignments', () => {
    const b = bundleFromRollouts({ runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-10-10',
      arms: ['a'], models: { a: 'm' }, assignedTaskIds: ['t1', 't2'], assignedSeeds: [0], runResults: [] });
    expect(b.run.totals.tasks).toBe(2);
    expect(b.arms[0]).toMatchObject({ primaryResolvedPct: 0, assignedAttempts: 2, absentAttempts: 2 });
    const html = buildReportHtml(b);
    expect(html).toContain('Primary assigned outcome');
    expect(html).toContain('Secondary graded quality');
  });
  it('keeps incomplete cost unknown while preserving the known subtotal and native lifetime evidence', () => {
    const armMeta = { costUsdMeasurementMissing: true, nativeCostAccounting: {
      basis: 'frozen-normalized-native-source', billedCostUsd: null, normalizedCostUsd: 0.2,
      taskLedgerConcurrency: { complete: true, basis: 'task-ledger-lifetime', wallClockMs: 100,
        concurrencyTimeline: { samples: [{ tMs: 0, live: 1 }, { tMs: 100, live: 0 }], avgConcurrent: 1, peakConcurrent: 1 } },
    } };
    const b = bundleFromRollouts({ runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-10-10',
      arms: ['a', 'b'], models: { a: 'm', b: 'm' }, runResults: [rr({ costUsd: 0.2, armMeta }), rr({ arm: 'b', costUsd: 0.3 })] });
    expect(b.rollouts[0]).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 0.2, costUsdMeasurementMissing: true, armMeta });
    expect(b.arms[0]).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 0.2, costUsdMeasurementMissing: true });
    expect(b.arms[1]).toMatchObject({ costUsd: 0.3, costUsdMeasurementMissing: false });
    expect(b.run.totals).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 0.5, costUsdMeasurementMissing: true });
    expect(JSON.parse(JSON.stringify(b)).rollouts[0].armMeta).toEqual(armMeta);
  });
  it.each([NaN, Infinity, -1])('does not turn an invalid recorded cost %s into a measured total', costUsd => {
    const b = bundleFromRollouts({ runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-10-10',
      arms: ['a'], models: { a: 'm' }, runResults: [rr({ costUsd })] });
    expect(b.rollouts[0]).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 0, costUsdMeasurementMissing: true });
    expect(b.run.totals).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 0, costUsdMeasurementMissing: true });
  });
  it('computes per-arm resolved/scored + totals, excluding infra rows from the denominator', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'],
      models: { a: 'claude-opus-4-8[1m]' },
      runResults: [
        rr({ taskId: 't1', resolved: true }),
        rr({ taskId: 't2', resolved: false, graderStatus: 'failed' }),
        // infra/transient → excluded from scored, surfaced as infraExcluded (resolved=null)
        rr({ taskId: 't3', resolved: null, generationStatus: 'error', graderStatus: 'error', stopReason: 'infra-failed' }),
      ],
    });
    const a = b.arms[0];
    expect(a.resolved).toBe(1);
    expect(a.scored).toBe(2); // t1 + t2; t3 excluded
    expect(a.infraExcluded).toBe(1);
    expect(b.run.totals.tasks).toBe(3);
    expect(b.run.totals.costUsd).toBe(3);
    expect(b.schemaVersion).toBe(BENCH_REPORT_SCHEMA_VERSION);
    expect(b.rollouts).toHaveLength(3);
  });

  it('computes meanScore over scored rows for partial-credit suites', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'the-agent-company', createdAt: '2026-06-17', arms: ['hive'],
      models: { hive: 'claude-opus-4-8[1m]' },
      runResults: [
        rr({ arm: 'hive', taskId: 't1', resolved: false, score: 0.4, graderStatus: 'failed' }),
        rr({ arm: 'hive', taskId: 't2', resolved: true, score: 1.0, graderStatus: 'passed' }),
      ],
    });
    expect(b.arms[0].meanScore).toBeCloseTo(0.7, 10);
  });

  it('joins a rollout record to its run-result (replay fingerprint carried onto the row)', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'],
      models: { a: 'm' },
      runResults: [rr({ taskId: 't1', arm: 'a', seed: 0 })],
      rollouts: [{
        rolloutId: 'roll-1', taskId: 't1', arm: 'a', seed: 0,
        modelId: 'claude-opus-4-8[1m]', harnessVersion: 'ext-bench@abc', harnessGitSha: 'deadbeef',
        submission: 'diff --git a/x b/x', rawGraderOutput: '{"resolved":true}', trajectoryRef: 'xbench://traj-1',
        configSnapshot: { tier: 'max' },
      }],
    });
    const row = b.rollouts[0];
    expect(row.rolloutId).toBe('roll-1');
    expect(row.modelId).toBe('claude-opus-4-8[1m]');
    expect(row.harnessGitSha).toBe('deadbeef');
    expect(row.submission).toContain('diff --git');
    expect(row.trajectoryRef).toBe('xbench://traj-1');
    expect((row.configSnapshot as { tier: string }).tier).toBe('max');
  });

  it('summarizes per-arm concurrency from a timeline', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'], models: { a: 'm' },
      runResults: [rr()],
      concurrencyTimeline: { a: [{ tMs: 0, live: 1 }, { tMs: 1, live: 2 }, { tMs: 2, live: 2 }] },
    });
    expect(b.arms[0].concurrency?.peak).toBe(2);
    expect(b.arms[0].concurrency?.avg).toBeCloseTo(5 / 3, 10);
  });
});

describe('buildReportHtml', () => {
  const b = bundleFromRollouts({
    runId: 'run-xyz', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'], models: { a: 'm' },
    runResults: [rr()],
    suiteData: { foo: 'bar' },
  });

  it('produces a self-contained HTML with the bundle injected as window.__BENCH_REPORT__', () => {
    const html = buildReportHtml(b);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('window.__BENCH_REPORT__=');
    expect(html).toContain('run-xyz');
    // NO external script/style src (portable, offline) — only inline <script>/<style>.
    expect(/<script\s+src=/i.test(html)).toBe(false);
    expect(/<link\s+[^>]*href=/i.test(html)).toBe(false);
  });

  it('escapes < in the injected JSON so it cannot break out of the script tag', () => {
    const withTag = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'], models: { a: 'm' },
      runResults: [rr({ taskId: 't1' })],
      rollouts: [{ rolloutId: 'x', taskId: 't1', arm: 'a', seed: 0, modelId: 'm', harnessVersion: 'h',
        submission: '</script><script>alert(1)</script>' }],
    });
    const html = buildReportHtml(withTag);
    // the raw closing-tag injection must NOT appear verbatim in the injected data
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});

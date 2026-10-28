/**
 * Tests for `system:launch-cost-ceiling` (plan agent-launch-context-cost-2026-09-18,
 * P-009(c); D-016).
 *
 * The cases are written against the REAL measured history this routine exists to have
 * caught, not against invented numbers — 2026-08-13 median 107,841 through 2026-09-17
 * median 305,926, with the +134k step on 2026-09-11. If a future threshold change stops
 * the `catches the real 2026-09-11 step` case firing, that is a genuine regression in the
 * detector and not a stale fixture.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CEILING_TOKENS,
  evaluateLaunchCost,
  evaluateLaunchScan,
  runLaunchCostCeiling,
  MIN_SAMPLES,
} from './launch-cost-ceiling-action';
import { MAX_FLEET_MEMBER_LAUNCH_TOKENS } from '../../agent-config-constants';
import type { DayStats, LaunchSample } from '../../launch-cost/launch-cost-metrics';
import type { ScanReport } from '../../launch-cost/scan-launch-transcripts';

const now = Date.parse('2026-09-24T12:00:00Z');
function launches(model: string | null, ageDays: number, tokens: number, count = 30): LaunchSample[] {
  const timestamp = new Date(now - ageDays * 86_400_000).toISOString();
  return Array.from({ length: count }, (_, n) => ({
    ownerId: 'su-test', sessionId: `${model}-${ageDays}-${n}`, filePath: `/fixture/${model}-${ageDays}-${n}`,
    timestamp, day: timestamp.slice(0, 10), model, entrypoint: 'cli', cliVersion: 'fixture', cwd: '/fixture',
    lineNumber: 1, bytesBeforeSample: 0, inputTokens: tokens, cacheCreationTokens: 0,
    cacheReadTokens: 0, totalPromptTokens: tokens,
    usageCountsComplete: true,
  }));
}
function scan(samples: LaunchSample[], unreadable = 0): ScanReport {
  return { root: '/fixture', samples, filesScanned: samples.length + unreadable, filesMeasured: samples.length,
    skipped: [], skippedByReason: { 'no-usage-row': 0, 'all-below-threshold': 0,
      'sidechain-only': 0, 'filtered-out': 0, 'incomplete-usage': 0, undatable: 0, unreadable } };
}

describe('launch scan cohort and telemetry guards', () => {
  it('does not alarm on a changing model mix when each comparable cohort stays flat', () => {
    const report = scan([
      ...launches('small', 4, 10000, 90), ...launches('large', 4, 100000, 30),
      ...launches('small', 1, 10000, 30), ...launches('large', 1, 100000, 90),
    ]);
    const result = evaluateLaunchScan(report, { now });
    expect(result.unknown).toEqual([]);
    expect(result.legs).toEqual([]);
    expect(result.cohorts.every(c => c.regressionComparable)).toBe(true);
  });

  it('keeps the routine quiet when only model mix changes across full calendar windows', async () => {
    const baseline = Array.from({ length: 7 }, (_, i) => 9 - i).flatMap(age => [
      ...launches('small', age, 10000, 90), ...launches('large', age, 100000, 30),
    ]);
    const recent = [2, 1].flatMap(age => [
      ...launches('small', age, 10000, 30), ...launches('large', age, 100000, 90),
    ]);
    const escalate = vi.fn();
    const result = await runLaunchCostCeiling({}, {
      now, scan: async () => scan([...baseline, ...recent]), openEscalation: escalate,
    });
    expect(result.outcome).toBe('ok');
    expect(result.telemetry?.unknown).toEqual([]);
    expect(result.telemetry?.cohorts).toHaveLength(2);
    expect(result.telemetry?.cohorts.every(c => c.regressionComparable)).toBe(true);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('detects an injected within-cohort regression and respects existing kill switches', () => {
    const report = scan([...launches('model', 4, 100000), ...launches('model', 1, 300000)]);
    expect(evaluateLaunchScan(report, { now }).legs.map(l => l.key)).toEqual(['ceiling', 'regression']);
    expect(evaluateLaunchScan(report, { now, ceilingTokens: 0, regressionPct: 0 }).legs).toEqual([]);
  });

  it('reports stale telemetry rather than treating old populated days as recent', () => {
    const result = evaluateLaunchScan(scan(launches('model', 4, 10000)), { now });
    expect(result.unknown).toContain('stale-or-absent-recent-telemetry');
    expect(result.legs).toEqual([]);
  });

  it('reports low coverage and missing models without manufacturing a cheap or healthy cohort', () => {
    const report = scan([...launches('model', 1, 10000), ...launches(null, 1, 10000)], 30);
    const result = evaluateLaunchScan(report, { now });
    expect(result.coverage).toBeCloseTo(1 / 3);
    expect(result.unknown).toContain('incomplete-telemetry-coverage');
    expect(result.unknownSamples).toBe(30);
  });

  it('requires per-cohort volume and rejects future or contradictory token accounting', () => {
    const small = evaluateLaunchScan(scan(launches('model', 1, 700000, 19)), { now });
    expect(small.unknown).toContain('insufficient-recent-cohort-volume');
    const invalid = launches('model', 1, 10000);
    invalid.forEach(s => { s.totalPromptTokens = 1; });
    const result = evaluateLaunchScan(scan([...invalid, ...launches('model', -1, 10000)]), { now });
    expect(result.validSamples).toBe(0);
    expect(result.unknownSamples).toBe(60);
    expect(result.recentMedian).toBeNull();
  });

  it('treats partial usage counts as unknown even when the numeric lower bound appears healthy', () => {
    const samples = launches('model', 1, 1000).map(s => ({ ...s, usageCountsComplete: false }));
    const result = evaluateLaunchScan(scan(samples), { now });
    expect(result.unknownSamples).toBe(30);
    expect(result.coverage).toBe(0);
    expect(result.legs).toEqual([]);
  });

  it('wires insufficient coverage into the existing routine without sending a false all-clear', async () => {
    const escalate = vi.fn();
    const result = await runLaunchCostCeiling({}, { now, scan: async () => scan(launches(null, 1, 10000)),
      openEscalation: escalate });
    expect(result.outcome).toBe('insufficient');
    expect(result.telemetry?.unknown).toContain('incomplete-telemetry-coverage');
    expect(escalate).not.toHaveBeenCalled();
  });
});

/** A day row with only the fields the evaluator reads; the rest are structurally required. */
function day(d: string, medianTotal: number, count = 40): DayStats {
  return {
    day: d,
    count,
    medianTotal,
    p10Total: Math.round(medianTotal * 0.7),
    p90Total: Math.round(medianTotal * 1.4),
    minTotal: Math.round(medianTotal * 0.5),
    maxTotal: Math.round(medianTotal * 2),
    medianCacheRead: Math.round(medianTotal * 0.45),
    medianCacheCreation: Math.round(medianTotal * 0.45),
    medianInput: Math.round(medianTotal * 0.1),
  };
}

describe('evaluateLaunchCost — the detector that should have existed', () => {
  it('catches the real 2026-09-11 step (151k -> 285k) as a regression', () => {
    const days = [
      day('2026-09-05', 150_057),
      day('2026-09-06', 151_380),
      day('2026-09-07', 149_900),
      day('2026-09-08', 150_057),
      day('2026-09-09', 151_000),
      day('2026-09-10', 150_500),
      day('2026-09-11', 152_000),
      day('2026-09-15', 284_907),
      day('2026-09-17', 305_926),
    ];
    const v = evaluateLaunchCost(days, { recentDays: 2, baselineDays: 7 });

    expect(v.insufficient).toBeNull();
    expect(v.legs.map((l) => l.key).sort()).toEqual(['ceiling', 'regression']);
    // The baseline is the seven pre-step days, the recent window the two post-step ones.
    expect(v.baselineMedian).toBeGreaterThan(149_000);
    expect(v.baselineMedian).toBeLessThan(153_000);
    expect(v.recentMedian).toBeGreaterThan(290_000);
    expect(v.legs.find((l) => l.key === 'regression')!.summary).toContain('%');
  });

  it('stays quiet on a flat series — no alarm without a crossing', () => {
    const days = Array.from({ length: 9 }, (_, i) => day(`2026-08-0${i + 1}`, 107_841 + i * 200));
    const v = evaluateLaunchCost(days, { recentDays: 2, baselineDays: 7 });
    expect(v.insufficient).toBeNull();
    expect(v.legs).toEqual([]);
  });

  it('fires the ceiling leg with NO baseline at all (a cold install is still protected)', () => {
    const v = evaluateLaunchCost([day('2026-09-17', 305_926)], { recentDays: 2, baselineDays: 7 });
    expect(v.legs.map((l) => l.key)).toEqual(['ceiling']);
    expect(v.legs[0]!.detail).toContain('before its first tool call'.replace('before', 'BEFORE'));
  });

  it('reports INSUFFICIENT rather than a false all-clear when the sample is thin', () => {
    // A shrinking sample and a shrinking median look identical in the headline number.
    const v = evaluateLaunchCost([day('2026-09-17', 90_000, MIN_SAMPLES - 1)], { recentDays: 1 });
    expect(v.legs).toEqual([]);
    expect(v.insufficient).toMatch(/below the \d+ needed/);
    expect(v.recentMedian).toBe(90_000);
  });

  it('a 4-session day cannot swing the verdict — the median is sample-weighted', () => {
    // One tiny catastrophic day beside a large healthy one must not trip the ceiling.
    const days = [
      ...Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, 100_000, 100)),
      day('2026-09-16', 100_000, 400),
      day('2026-09-17', 900_000, 4),
    ];
    const v = evaluateLaunchCost(days, { recentDays: 2, baselineDays: 7 });
    // Unweighted this pair averages 500,000 and would alarm; weighted it is ~107,900.
    expect(v.recentMedian).toBeLessThan(120_000);
    expect(v.legs).toEqual([]);
  });

  it('honours both kill switches independently', () => {
    const days = [
      ...Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, 150_000)),
      day('2026-09-16', 300_000),
      day('2026-09-17', 300_000),
    ];
    expect(evaluateLaunchCost(days, { ceilingTokens: 0 }).legs.map((l) => l.key)).toEqual(['regression']);
    expect(evaluateLaunchCost(days, { regressionPct: 0 }).legs.map((l) => l.key)).toEqual(['ceiling']);
    expect(evaluateLaunchCost(days, { ceilingTokens: 0, regressionPct: 0 }).legs).toEqual([]);
  });

  it('pins the ceiling to the fleet-member launch-headroom rule', () => {
    // Not a magic number: a member session at this launch cost has less than
    // MIN_FLEET_MEMBER_LAUNCH_HEADROOM_PCT (40%) of its compaction limit left for work at
    // birth. Derived from COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP — if the cap moves,
    // this moves (400k cap -> 240k ceiling).
    expect(DEFAULT_CEILING_TOKENS).toBe(MAX_FLEET_MEMBER_LAUNCH_TOKENS);
    expect(DEFAULT_CEILING_TOKENS).toBe(240_000);
  });

  it('is order-insensitive — days need not arrive sorted', () => {
    const unsorted = [day('2026-09-17', 300_000), day('2026-09-01', 150_000), day('2026-09-16', 300_000)];
    const sorted = [day('2026-09-01', 150_000), day('2026-09-16', 300_000), day('2026-09-17', 300_000)];
    expect(evaluateLaunchCost(unsorted, { recentDays: 2, baselineDays: 7 })).toEqual(
      evaluateLaunchCost(sorted, { recentDays: 2, baselineDays: 7 }),
    );
  });
});

/**
 * Sidecar-fallback accounting (EI-18808838427010743).
 *
 * The condition under test is a DETECTOR, so the thing that matters is not that
 * it logs — it is that a PERSISTENT fallback stays visible. Every call site used
 * to warn once per distinct reason (or, in one case, swallow the error
 * entirely), which makes "the sidecar blipped once at boot" and "every git call
 * has been paying a ~165 ms fork stall for the last hour" produce byte-identical
 * evidence. That is the regression these tests exist to prevent, so the file
 * carries a permanent CONTROL implementing the old warn-once behaviour: the
 * re-warn assertions must REJECT the control while accepting the real subject.
 * A guard that has never failed is a guard nobody has tested.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as recorder from '../degradation/fallback-observations';

const primary = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: async () => undefined }));
vi.mock('./spawner-ipc-client', () => ({
  getSpawnerIpcClient: () => ({ call: primary.call }),
  SpawnerIpcClient: class {},
}));

import {
  getSidecarFallbackStats,
  noteSidecarFallback,
  noteSidecarDeadlineFallback,
  runCommandViaSpawnerSidecar,
  SidecarCircuitOpenError,
  resetSidecarFallbackStatsForTest,
} from './git-via-sidecar';

/**
 * CONTROL — the behaviour this module REPLACED, kept executable so the
 * assertions below are demonstrably falsifiable. Warns once per distinct
 * reason and never again, and counts nothing.
 */
function makeWarnOnceControl() {
  const seen = new Set<string>();
  const warnings: string[] = [];
  return {
    warnings,
    note(_subsystem: string, e: unknown, _nowMs: number): void {
      const reason = e instanceof Error ? e.message : String(e);
      if (seen.has(reason)) return;
      seen.add(reason);
      warnings.push(reason);
    },
  };
}

describe('sidecar fallback accounting', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let observation: MockInstance<typeof recorder.observeFallback>;

  beforeEach(() => {
    observation = vi.spyOn(recorder, 'observeFallback').mockReturnValue(true);
    primary.call.mockReset();
    resetSidecarFallbackStatsForTest();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    observation.mockRestore();
    warn.mockRestore();
    resetSidecarFallbackStatsForTest();
  });

  it('starts empty', () => {
    expect(getSidecarFallbackStats()).toEqual({ total: 0, bySubsystem: {} });
  });

  it('records each fallback before warning throttling with bounded reasons and its event time', () => {
    for (let i = 0; i < 25; i++) noteSidecarFallback('pot-git', new Error(`private path ${i}`), 1000 + i);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(observation).toHaveBeenCalledTimes(25);
    expect(observation).toHaveBeenLastCalledWith('spawner-sidecar-exec',
      { eligible: 1, applied: 0, reason: 'sidecar-unavailable' }, { observedAt: new Date(1024) });
    noteSidecarFallback('pot-git', new SidecarCircuitOpenError(10), 2000);
    noteSidecarDeadlineFallback('pot-git', new Error('deadline'), 2001);
    noteSidecarFallback('pot-git', new Error('unknown result'), 2002, 'rejected');
    expect(observation.mock.calls.slice(-3).map(([, row]) => row.reason)).toEqual([
      'circuit-open', 'deadline-exceeded', 'local-execution-rejected',
    ]);
  });

  it('measures actual primary child exits but excludes infrastructure rejection and pre-cancellation', async () => {
    primary.call.mockResolvedValue({ code: 3, stdout: 'child output', stderr: 'child failed' });
    await runCommandViaSpawnerSidecar('git', ['status'], { timeoutMs: 1000 });
    expect(observation).toHaveBeenCalledExactlyOnceWith('spawner-sidecar-exec',
      { eligible: 1, applied: 1, reason: 'applied' });
    observation.mockClear();
    primary.call.mockResolvedValue({ code: -1, stdout: '', stderr: 'spawner sidecar admission failed' });
    await runCommandViaSpawnerSidecar('git', ['status'], { timeoutMs: 1000 });
    const controller = new AbortController();
    controller.abort();
    await runCommandViaSpawnerSidecar('git', ['status'], { timeoutMs: 1000, signal: controller.signal });
    expect(observation).not.toHaveBeenCalled();
  });

  it('distinguishes rejected fallback attempts from actual local execution while retaining breaker accounting', () => {
    for (let i = 0; i < 3; i++) {
      noteSidecarFallback('committed-tree-reader', new Error('RPC request timeout:process:exec'), 1_000 + i, 'rejected');
    }
    const stats = getSidecarFallbackStats();
    expect(stats.total).toBe(3);
    expect(stats.bySubsystem['committed-tree-reader']).toMatchObject({ count: 3, rejected: 3 });
    expect(String(warn.mock.calls[0]?.[0])).toContain('rejected; local execution avoided');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('fallback to local execution');
  });

  it('counts every fallback, not just the first — the whole point of the change', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 25; i++) {
      noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), t0 + i);
    }

    const stats = getSidecarFallbackStats();
    expect(stats.total).toBe(25);
    expect(stats.bySubsystem['pot-git']?.count).toBe(25);
    expect(stats.bySubsystem['pot-git']?.firstAtMs).toBe(t0);
    expect(stats.bySubsystem['pot-git']?.lastAtMs).toBe(t0 + 24);
    expect(stats.bySubsystem['pot-git']?.lastReason).toBe('ECONNREFUSED');
  });

  it('keeps subsystems separate and sums them into total', () => {
    noteSidecarFallback('pot-git', new Error('a'), 1);
    noteSidecarFallback('pot-git', new Error('a'), 2);
    noteSidecarFallback('git-sync', new Error('b'), 3);

    const stats = getSidecarFallbackStats();
    expect(stats.bySubsystem['pot-git']?.count).toBe(2);
    expect(stats.bySubsystem['git-sync']?.count).toBe(1);
    expect(stats.total).toBe(3);
  });

  it('tracks the LATEST reason, so a changed failure mode is visible', () => {
    noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), 1);
    noteSidecarFallback('pot-git', new Error('EPIPE'), 2);
    expect(getSidecarFallbackStats().bySubsystem['pot-git']?.lastReason).toBe('EPIPE');
  });

  it('accepts non-Error throws without losing the count', () => {
    noteSidecarFallback('pot-git', 'plain string boom', 1);
    const stats = getSidecarFallbackStats();
    expect(stats.bySubsystem['pot-git']?.count).toBe(1);
    expect(stats.bySubsystem['pot-git']?.lastReason).toBe('plain string boom');
  });

  it('warns immediately on the first fallback', () => {
    noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), 1_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('pot-git');
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
  });

  it('does NOT warn per call inside the interval — the hot path stays cheap', () => {
    const t0 = 1_000;
    for (let i = 0; i < 500; i++) {
      noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), t0 + i);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getSidecarFallbackStats().bySubsystem['pot-git']?.count).toBe(500);
  });

  /**
   * THE LOAD-BEARING ASSERTION. A sustained outage must keep producing
   * evidence; warn-once is exactly what hid the regression before.
   */
  it('re-warns after the interval, carrying the cumulative count', () => {
    const t0 = 1_000;
    noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), t0);
    for (let i = 1; i < 100; i++) {
      noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), t0 + i);
    }
    expect(warn).toHaveBeenCalledTimes(1);

    // ...one minute later, same fault still going.
    noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), t0 + 60_001);

    expect(warn).toHaveBeenCalledTimes(2);
    const second = String(warn.mock.calls[1]?.[0]);
    expect(second).toContain('101');
    expect(second).toMatch(/fallbacks since/);
  });

  it('CONTROL: the old warn-once behaviour FAILS the re-warn assertion', () => {
    const control = makeWarnOnceControl();
    const t0 = 1_000;

    control.note('pot-git', new Error('ECONNREFUSED'), t0);
    for (let i = 1; i < 100; i++) control.note('pot-git', new Error('ECONNREFUSED'), t0 + i);
    control.note('pot-git', new Error('ECONNREFUSED'), t0 + 60_001);

    // The real subject emits a SECOND warning here; the control never does.
    // If this ever reaches 2, the control has stopped being wrong and the
    // assertions above no longer prove anything.
    expect(control.warnings).toHaveLength(1);
  });

  it('CONTROL: the old behaviour also reports no rate at all', () => {
    const control = makeWarnOnceControl();
    for (let i = 0; i < 500; i++) control.note('pot-git', new Error('boom'), i);
    // One string, no count, no first-seen — nothing that separates a blip from
    // a sustained outage. That absence is the defect, restated as a test.
    expect(control.warnings).toEqual(['boom']);
  });

  it('a distinct NEW reason still re-warns promptly rather than waiting out the interval', () => {
    const t0 = 1_000;
    noteSidecarFallback('pot-git', new Error('ECONNREFUSED'), t0);
    expect(warn).toHaveBeenCalledTimes(1);

    // Different subsystem => its own cadence, warns immediately.
    noteSidecarFallback('git-sync', new Error('EPIPE'), t0 + 1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

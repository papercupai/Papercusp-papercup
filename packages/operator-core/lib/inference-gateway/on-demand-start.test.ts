import { describe, expect, it, vi } from 'vitest';
import { startOnDemandBackendWithWatermark } from './on-demand-start';

/** Records the interleaving of watermark stamps and the start so ORDER is what gets asserted. */
function recorder(startResult: { ok: boolean; error?: string }, opts: { markBusyFails?: boolean } = {}) {
  const events: string[] = [];
  const deps = {
    markBusy: vi.fn(async () => {
      events.push('markBusy');
      if (opts.markBusyFails) throw new Error('pg down');
    }),
    start: vi.fn(async () => {
      events.push('start');
      return startResult;
    }),
    log: vi.fn(),
  };
  return { events, deps };
}

describe('startOnDemandBackendWithWatermark (WI-10006360)', () => {
  it('stamps the idle watermark BEFORE the start, so a sweep at readiness cannot reap it', () => {
    // The race: a stopped backend's last_busy_at is older than its TTL. If the only stamp lands
    // after readiness, a reaper sweep between "slots read idle" and that stamp stops the backend
    // before it serves the request that started it (measured: ~2s after a 3m42s cold start).
    const { events, deps } = recorder({ ok: true });
    return startOnDemandBackendWithWatermark('ornith-llamaserver', deps).then((r) => {
      expect(r).toEqual({ ok: true });
      expect(events).toEqual(['markBusy', 'start', 'markBusy']);
    });
  });

  it('does not re-stamp after a failed start (a dead backend must age out normally)', async () => {
    const { events, deps } = recorder({ ok: false, error: 'start failed' });
    const r = await startOnDemandBackendWithWatermark('b', deps);
    expect(r).toEqual({ ok: false, error: 'start failed' });
    expect(events).toEqual(['markBusy', 'start']);
  });

  it('never fails the start because a watermark write failed — it warns instead', async () => {
    const { events, deps } = recorder({ ok: true }, { markBusyFails: true });
    const r = await startOnDemandBackendWithWatermark('b', deps);
    expect(r.ok).toBe(true);
    expect(events).toEqual(['markBusy', 'start', 'markBusy']);
    const warnings = deps.log.mock.calls.filter((c) => c[0] === 'warn').map((c) => String(c[1]));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('could not pre-stamp');
    expect(warnings[1]).toContain('could not stamp');
  });

  it('logs a failed on-demand start with backend, elapsed time, budget and error (WI-10006503)', async () => {
    // Before this, a start that hit its ready budget became a 502 with NO journal line at all.
    const { deps } = recorder({ ok: false, error: 'not ready within budget' });
    let t = 1_000;
    const r = await startOnDemandBackendWithWatermark('ornith-llamaserver', {
      ...deps,
      budgetMs: 900_000,
      now: () => (t += 304_000) - 304_000,
    });
    expect(r).toEqual({ ok: false, error: 'not ready within budget' });
    const warnings = deps.log.mock.calls.filter((c) => c[0] === 'warn').map((c) => String(c[1]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("on-demand start of 'ornith-llamaserver' FAILED after 304000ms");
    expect(warnings[0]).toContain('ready budget 900000ms');
    expect(warnings[0]).toContain('not ready within budget');
  });

  it('does not log a failure line for a successful start', async () => {
    const { deps } = recorder({ ok: true });
    await startOnDemandBackendWithWatermark('b', { ...deps, budgetMs: 900_000 });
    expect(deps.log.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(0);
  });
});

describe('LOCAL_BACKEND_COLD_START_TIMEOUT_MS vs the measured disk-cold load (WI-10006503)', () => {
  it('keeps at least 2x headroom over the slowest measured disk-cold start', async () => {
    // A 300s budget against a measured 304s disk-cold ornith load returned 502 in normal operation.
    // Undershooting abandons a load that is still progressing; overshooting only slows one request.
    const { LOCAL_BACKEND_COLD_START_TIMEOUT_MS, LOCAL_BACKEND_MEASURED_DISK_COLD_START_MS } = await import('./launch');
    expect(LOCAL_BACKEND_MEASURED_DISK_COLD_START_MS).toBeGreaterThanOrEqual(304_000);
    expect(LOCAL_BACKEND_COLD_START_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * LOCAL_BACKEND_MEASURED_DISK_COLD_START_MS);
  });
});

/**
 * B4 (infra-fail-fast-build-integrity-2026-06-19) — /api/health/deep subsystem
 * readiness. Tests the pure gating predicate + the deadline-bounded probe
 * (which is what would have turned the 2026-06-19 green-check-over-wedged-mem0
 * outage into a 503). The handler's real PG/memory round-trips are integration
 * territory; the logic here is what determines ready vs 503.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BWRAP_BIN, BWRAP_USERNS_PROBE_ARGS } from '@papercusp/deployment-driver';
import {
  AGENT_SANDBOX_PROBE_TTL_MS,
  __resetAgentSandboxCache,
  probeAgentSandbox,
  readAgentSandbox,
  runProbeCommand,
  type AgentSandboxProbeDeps,
  classifyMcpPressure,
  computeDeepReadiness,
  probeSubsystem,
  readCpuWorker,
  readLoopLag,
  MCP_PROXY_HEALTH_PATH,
  type ProbeStatus,
} from './health-deep';
import route from './health-deep';
import { startEventLoopLagMonitor, type LagMonitorHandle } from '../../../event-loop-lag-monitor';

describe('computeDeepReadiness', () => {
  const base = { dbosEnabled: false, dbosLaunched: false, pg: 'ok' as ProbeStatus, memory: 'ok' as ProbeStatus };

  it('ready when PG ok + memory ok and DBOS not enabled', () => {
    expect(computeDeepReadiness(base)).toBe(true);
  });

  it('NOT ready when PG is down (operator cannot serve without PG)', () => {
    expect(computeDeepReadiness({ ...base, pg: 'down' })).toBe(false);
  });

  it('NOT ready when memory is down (the wedged-mem0 outage case)', () => {
    expect(computeDeepReadiness({ ...base, memory: 'down' })).toBe(false);
  });

  it('READY when memory is merely disabled (a NoopBackend host is healthy)', () => {
    expect(computeDeepReadiness({ ...base, memory: 'disabled' })).toBe(true);
  });

  it('gates on DBOS launch only when DBOS is enabled (mirrors isReady)', () => {
    expect(computeDeepReadiness({ ...base, dbosEnabled: true, dbosLaunched: false })).toBe(false);
    expect(computeDeepReadiness({ ...base, dbosEnabled: true, dbosLaunched: true })).toBe(true);
  });
});

describe('probeSubsystem', () => {
  it('returns the fn status on success (ok)', async () => {
    const r = await probeSubsystem(async () => 'ok', 1000);
    expect(r.status).toBe('ok');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes through a disabled status', async () => {
    const r = await probeSubsystem(async () => 'disabled', 1000);
    expect(r.status).toBe('disabled');
  });

  it('maps a thrown error to down, capturing the detail', async () => {
    const r = await probeSubsystem(async () => {
      throw new Error('SELECT 1 failed: connection refused');
    }, 1000);
    expect(r.status).toBe('down');
    expect(r.detail).toMatch(/connection refused/);
  });

  it('maps a HANG to down via the deadline (the outage signature)', async () => {
    const r = await probeSubsystem(() => new Promise<ProbeStatus>(() => {}), 20);
    expect(r.status).toBe('down');
    expect(r.detail).toMatch(/timeout after 20ms/);
  });
});

// EI-19285078178745571: a green /api/health(/deep) during an actually-wedged host is
// exactly the detector gap this closes (a 2026-08-01 incident had every MCP call hang
// while both stayed 200; the near-identical 2026-06-19 EI-79 outage was event-loop-lag
// shaped). These pin readLoopLag's no-monitor-running fail-safe AND its live pass-through
// of the SAME event-loop-lag-monitor gauge the P-010 admission layer already sheds on.
describe('readLoopLag', () => {
  let handle: LagMonitorHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  it('no monitor running ⇒ pressure ok, every figure null (absence of signal is never a false-healthy OR false-unhealthy claim)', () => {
    const r = readLoopLag();
    expect(r.pressure).toBe('ok');
    expect(r.p95Ms).toBeNull();
    expect(r.p99Ms).toBeNull();
    expect(r.maxMs).toBeNull();
    expect(r.sampleCount).toBeNull();
    expect(r.windowMs).toBeNull();
    expect(r.windowMature).toBeNull();
  });

  it('a running monitor is reflected live (finite figures, pressure derived from the SAME gauge the admission layer reads)', () => {
    handle = startEventLoopLagMonitor();
    const r = readLoopLag();
    expect(['ok', 'elevated', 'critical']).toContain(r.pressure);
    expect(typeof r.p95Ms).toBe('number');
    expect(typeof r.p99Ms).toBe('number');
    expect(typeof r.maxMs).toBe('number');
    expect(typeof r.sampleCount).toBe('number');
    expect(typeof r.windowMs).toBe('number');
    expect(r.windowMature).toBe(false); // immediate read: partial post-reset window
  });
});

// WI-37696. `readCpuWorker` is a PASS-THROUGH, and that is precisely what has to
// be pinned: the failure it exists to expose is a `disabled` latch that produces
// byte-identical output, so a reader which returned a plausible-looking snapshot
// WITHOUT actually consulting the live module would be indistinguishable from a
// working one — and would report a permanent, silent degradation as healthy.
//
// So these drive the REAL cpu-task-worker module (its own `_injectWorkerCrashForTest`
// seam) and assert the reading MOVES with it. Asserting a hand-built shape, or a
// value recomputed here, would pass against a reader wired to nothing
// (EI-20053788422725852, the same lesson that produced `keepAlive`).
//
// `mod()` is a bare dynamic import with no `vi.resetModules()`, exactly as
// cpu-task-worker.test.ts does it, so the module record this test mutates IS the
// one health-deep.ts imported.
describe('readCpuWorker', () => {
  async function cpuMod() {
    return import('../../../cpu-task-worker');
  }

  afterEach(async () => {
    await (await cpuMod())._resetCpuWorker();
  });

  function bigBatch(m: { OFFLOAD_MIN_ITEMS: number }) {
    return Array.from({ length: m.OFFLOAD_MIN_ITEMS + 1 }, (_, i) => ({ id: i }));
  }

  it('reports the idle module before anything has offloaded (never-used reads as available, not as failed)', async () => {
    const r = readCpuWorker();
    expect(r.alive).toBe(false);
    expect(r.disabled).toBe(false);
    expect(r.pendingCount).toBe(0);
    expect(r.consecutiveCrashes).toBe(0);
    expect(typeof r.minItems).toBe('number');
  });

  it('tracks the live worker through spawn and crash (proves it reads the module, not a snapshot of its own)', async () => {
    const m = await cpuMod();
    const rows = bigBatch(m);
    // EI-20505664003243915: every crash now logs its cause, transient ones
    // included — those are exactly the crashes that used to vanish and leave a
    // later trip unexplained.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await m.serializeJsonResponse({ rows }, rows.length);
    expect(readCpuWorker().alive).toBe(true);

    expect(m._injectWorkerCrashForTest(new Error('transient boom'))).toBe(true);
    const afterCrash = readCpuWorker();
    expect(afterCrash.alive).toBe(false);
    // One transient crash must NOT read as a tripped breaker — that distinction
    // is the whole point of surfacing `disabled` rather than `alive`.
    expect(afterCrash.disabled).toBe(false);
    // The crash landed with NOTHING in flight, so no request actually failed:
    // the last eligible request WAS served and the verdict correctly still reads
    // 'serving'. The crash is carried by consecutiveCrashes, not by demoting a
    // working offload. (This assertion originally read 'silently-falling-back'
    // and was wrong — it exposed a verdict keyed off a CUMULATIVE served count,
    // which would have reported 'serving' forever after a single boot-time
    // success. The verdict now keys off the most recent eligible outcome.)
    expect(afterCrash.verdict).toBe('serving');
    expect(afterCrash.consecutiveCrashes).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('transient boom');
    errSpy.mockRestore();
  });

  it('surfaces a TRIPPED breaker — the one field an operator must be able to alert on', async () => {
    const m = await cpuMod();
    const rows = bigBatch(m);

    // Latching the breaker deliberately writes the operator-facing warning to
    // console.error, and operator-core's vitest setup FAILS any test that does.
    // Spy rather than silence: that log is the only runtime trace the latch
    // leaves, so assert it actually fired instead of merely swallowing it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // "Spawns fine, dies on every message": drop the reply so no request is ever
      // served, which is the run the breaker exists to give up on.
      const realPost = Worker.prototype.postMessage;
      (Worker.prototype as unknown as { postMessage: () => void }).postMessage = () => {};
      try {
        for (let i = 0; i < 3; i++) {
          const inFlight = m.serializeJsonResponse({ rows }, rows.length);
          for (let t = 0; t < 200 && readCpuWorker().pendingCount === 0; t++) {
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(m._injectWorkerCrashForTest(new Error(`boom ${i}`))).toBe(true);
          await inFlight; // answered by the sync fallback
        }
      } finally {
        (Worker.prototype as unknown as { postMessage: typeof realPost }).postMessage = realPost;
      }

      // The process is still CORRECT and would still answer /health/deep 200 —
      // which is exactly why this has to appear in the payload. Without it the
      // offload is gone for the rest of the process lifetime with no other trace.
      expect(readCpuWorker()).toMatchObject({ disabled: true, consecutiveCrashes: 3 });
      expect(errSpy.mock.calls.flat().join(' ')).toContain('worker-breaker TRIPPED');
    } finally {
      errSpy.mockRestore();
    }
  });

  // A reader nothing SERVES is exactly as silent as no reader at all, so pin the
  // wiring too, not just the function: this fails if `cpuWorker` is dropped from
  // the response while `readCpuWorker` keeps working (and passing its own tests).
  //
  // Deliberately asserts nothing about `ready`/status: the PG and memory probes
  // legitimately fail in a unit-test environment, and the point here is that the
  // breaker is reported REGARDLESS of the readiness verdict — a degraded offload
  // must stay visible on a host that is otherwise answering fine.
  it('is served in the /health/deep payload, not merely exported', async () => {
    const res = await (
      route as unknown as { handler: (...a: unknown[]) => Promise<Response> }
    ).handler({}, {});
    const body = (await res.json()) as { cpuWorker?: Record<string, unknown> };

    expect(body.cpuWorker).toBeDefined();
    expect(body.cpuWorker).toMatchObject({
      alive: expect.any(Boolean),
      disabled: expect.any(Boolean),
      pendingCount: expect.any(Number),
      consecutiveCrashes: expect.any(Number),
      // EI-20505664003243915: the detector has to reach the WIRE, not just the
      // function. `verdict` is the field that separates a working offload from
      // one that is silently falling back — a reading `disabled` cannot give —
      // so a payload that drops it is back to the original silent degradation.
      servedByWorker: expect.any(Number),
      eligibleFallbacks: expect.any(Number),
      verdict: expect.stringMatching(
        /^(serving|idle-unproven|silently-falling-back|disabled)$/,
      ),
    });
  }, 30000);
});

/**
 * WI-10004649 — the agent-sandbox leg. A Server whose kernel refuses bwrap a user namespace
 * runs every Codex sandboxed command into a failure while every other leg reads green; this
 * leg is the only place that reports it.
 */
describe('agent sandbox leg', () => {
  afterEach(() => __resetAgentSandboxCache());

  const fake = (over: Partial<AgentSandboxProbeDeps> = {}) => {
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const deps: AgentSandboxProbeDeps = {
      platform: () => 'linux',
      exists: () => true,
      run: async (bin, args) => {
        calls.push({ bin, args });
        return { code: 0, stderr: '' };
      },
      now: () => 1_000,
      ...over,
    };
    return { deps, calls };
  };

  it('runs the hosted bootstrap probe (user+pid+net namespaces) and reports ok when bwrap creates them', async () => {
    const { deps, calls } = fake();
    expect(await probeAgentSandbox(deps)).toMatchObject({ status: 'ok', detail: null });
    expect(calls).toEqual([{ bin: BWRAP_BIN, args: BWRAP_USERNS_PROBE_ARGS }]);
  });

  it('reports down with bwrap’s own error when it cannot create the namespaces (a fake bwrap exiting 1)', async () => {
    const { deps } = fake({ run: async () => ({ code: 1, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' }) });
    expect(await probeAgentSandbox(deps)).toMatchObject({ status: 'down', detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' });
  });

  it('reports a probe that overran its deadline as unknown, never down, and does not cache it', async () => {
    const slow = fake({ run: async () => ({ code: null, stderr: '', error: 'timeout after 30000ms' }) });
    expect(await probeAgentSandbox(slow.deps)).toMatchObject({ status: 'unknown', detail: 'timeout after 30000ms' });
    let probes = 0;
    const counted = fake({ run: async () => (probes++, { code: null, stderr: '', error: 'timeout after 30000ms' }) });
    await readAgentSandbox(counted.deps);
    await readAgentSandbox(counted.deps);
    expect(probes).toBe(2);
  });

  it('never holds a health read for the probe: the first read waits at most waitMs, a stale answer is served while it re-probes', async () => {
    let release: (v: { code: number; stderr: string }) => void = () => {};
    let t = 1_000;
    const hung = fake({ now: () => t, run: () => new Promise((r) => (release = r)) });
    expect(await readAgentSandbox(hung.deps, 20)).toMatchObject({ status: 'unknown', detail: 'probe still running' });
    release({ code: 0, stderr: '' });
    await new Promise((r) => setTimeout(r, 0));
    expect(await readAgentSandbox(hung.deps, 20)).toMatchObject({ status: 'ok' }); // the background probe landed
    t += AGENT_SANDBOX_PROBE_TTL_MS;
    expect(await readAgentSandbox(hung.deps, 20)).toMatchObject({ status: 'ok' }); // stale, served at once while re-probing
  });

  it('reports down when bwrap is missing on Linux, and disabled off Linux (never a fake ok)', async () => {
    expect(await probeAgentSandbox(fake({ exists: () => false }).deps)).toMatchObject({ status: 'down', detail: expect.stringContaining('not installed') });
    const mac = fake({ platform: () => 'darwin' });
    expect(await probeAgentSandbox(mac.deps)).toMatchObject({ status: 'disabled' });
    expect(mac.calls).toEqual([]);
  });

  it('reuses one probe for the TTL, shares a concurrent probe, and re-probes after the TTL', async () => {
    let t = 1_000;
    const { deps, calls } = fake({ now: () => t });
    await Promise.all([readAgentSandbox(deps), readAgentSandbox(deps)]);
    await readAgentSandbox(deps);
    expect(calls).toHaveLength(1);
    t += AGENT_SANDBOX_PROBE_TTL_MS;
    await readAgentSandbox(deps); // stale: served from cache, re-probe started in the background
    expect(calls).toHaveLength(2);
  });

  it('runProbeCommand: a deadline delivered before close does not turn an exited child into a timeout', async () => {
    // A real shell plus a busy loop cannot prove the shell exited before its
    // 50ms deadline (CI run 20871498). Control the observed state and ordering.
    vi.useFakeTimers();
    const kill = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      stderr: null, exitCode: null as number | null, signalCode: null, kill,
    });
    try {
      const p = runProbeCommand('probe', [], 50, (() => child as unknown as ChildProcess) as typeof spawn);
      child.exitCode = 0;
      await vi.advanceTimersByTimeAsync(51);
      expect(vi.getTimerCount()).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      child.emit('close', 0);
      expect(await p).toEqual({ code: 0, stderr: '' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runProbeCommand: reports the exit code and stderr, and kills a child that really overruns', async () => {
    expect(await runProbeCommand('/bin/sh', ['-c', 'echo boom >&2; exit 3'], 5_000)).toEqual({ code: 3, stderr: 'boom\n' });
    const t0 = Date.now();
    expect(await runProbeCommand('/bin/sh', ['-c', 'sleep 5'], 100)).toMatchObject({ code: null, error: 'timeout after 100ms' });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('is served in the /health/deep payload without gating readiness', async () => {
    const res = await (route as unknown as { handler: (...a: unknown[]) => Promise<Response> }).handler({}, {});
    const body = (await res.json()) as { agentSandbox?: Record<string, unknown> };
    expect(body.agentSandbox).toMatchObject({ status: expect.stringMatching(/^(ok|disabled|down|unknown)$/), checkedAt: expect.any(String) });
  }, 30000);
});

/**
 * EI-21524598788382723 — the MCP plane leg. `/api/health/deep` exercised five
 * subsystems while omitting the one plane every agent's every tool call traverses,
 * so a shedding/timing-out proxy sat behind a green deep-health check.
 */
describe('classifyMcpPressure', () => {
  it('is unknown when the proxy could not be read (never a green default)', () => {
    expect(classifyMcpPressure(null)).toBe('unknown');
  });

  it('is unknown when a payload carries no ratio we can compute', () => {
    // A proxy older/newer than this reader must not silently read as healthy.
    expect(classifyMcpPressure({ total: 4 })).toBe('unknown');
  });

  it('reads a quiet plane as ok', () => {
    expect(
      classifyMcpPressure({ total: 4, ordinary: 3, ordinaryCeiling: 136, maxInFlight: 200 }),
    ).toBe('ok');
  });

  it('reads a class at its ceiling as saturated', () => {
    expect(
      classifyMcpPressure({ total: 136, ordinary: 136, ordinaryCeiling: 136, maxInFlight: 200 }),
    ).toBe('saturated');
  });

  it('reads 75% of a class ceiling as elevated (before the shedding starts)', () => {
    expect(
      classifyMcpPressure({ total: 102, ordinary: 102, ordinaryCeiling: 136, maxInFlight: 200 }),
    ).toBe('elevated');
  });

  /**
   * THE REGRESSION CONTROL. critical-continuation is a single-flight bulkhead
   * (ceiling 1), so 1-of-1 is its normal working state — the live proxy sat at
   * exactly this while perfectly healthy. Classifying it as saturated would pin
   * the signal permanently red, and an always-red signal is one readers learn to
   * ignore, which is the exact failure this probe exists to prevent.
   */
  it('does NOT read the single-flight bulkhead at 1-of-1 as saturated', () => {
    expect(
      classifyMcpPressure({
        total: 4,
        ordinary: 3,
        ordinaryCeiling: 136,
        criticalContinuation: 1,
        maxInFlight: 200,
      }),
    ).toBe('ok');
  });

  /**
   * The silent-timeout shape from the filed symptom: ONE waiter starving behind the
   * single slot until the CLIENT's own timer fires. Depth alone cannot see it — a
   * 2-of-16 queue reads shallow while its oldest waiter is at 29s of a 30s budget.
   */
  it('escalates on wait-age against the budget even when the queue is shallow', () => {
    // 29s of a 30s budget = 97% — off 'ok' (the point of this leg) but not yet
    // 'saturated': nothing has been dropped. Depth alone would have read this 'ok'.
    expect(
      classifyMcpPressure({
        total: 4,
        ordinary: 3,
        ordinaryCeiling: 136,
        criticalContinuation: 1,
        criticalContinuationQueue: { waiting: 2, max: 16, oldestAgeMs: 29_000, maxWaitMs: 30_000 },
        maxInFlight: 200,
      }),
    ).toBe('elevated');
  });

  it('reads an EXHAUSTED wait budget as saturated (the waiter is being dropped)', () => {
    expect(
      classifyMcpPressure({
        total: 4,
        ordinary: 3,
        ordinaryCeiling: 136,
        criticalContinuation: 1,
        criticalContinuationQueue: { waiting: 2, max: 16, oldestAgeMs: 30_000, maxWaitMs: 30_000 },
        maxInFlight: 200,
      }),
    ).toBe('saturated');
  });

  it('leaves a shallow, YOUNG queue at ok (the measured live-proxy reading)', () => {
    // Verbatim from 127.0.0.1:9071 on 2026-08-27: 2 waiting of 16, oldest 2865ms of
    // a 30s budget. This is normal working contention and must not read as an alarm.
    expect(
      classifyMcpPressure({
        total: 7,
        ordinary: 3,
        ordinaryCeiling: 136,
        reservedControlPlane: 3,
        reservedControlPlaneCeiling: 136,
        criticalContinuation: 1,
        criticalContinuationQueue: { waiting: 2, max: 16, oldestAgeMs: 2865, maxWaitMs: 30_000 },
        maxInFlight: 200,
      }),
    ).toBe('ok');
  });

  it('DOES escalate the bulkhead when work is queued behind its one slot', () => {
    expect(
      classifyMcpPressure({
        total: 4,
        ordinary: 3,
        ordinaryCeiling: 136,
        criticalContinuation: 1,
        criticalContinuationQueue: { waiting: 8, max: 8 },
        maxInFlight: 200,
      }),
    ).toBe('saturated');
  });
});

describe('MCP proxy health path is PINNED to the proxy that serves it', () => {
  it('matches MCP_PROXY_LOCAL_HEALTH_PATH in apps/operator/lib/mcp-proxy/budgets.mjs', () => {
    // operator-core must not import from apps/, so the literal is duplicated. This
    // is the PIN that stops the copy drifting: probing the wrong path would make the
    // plane read permanently 'down' — a false alarm is as useless as a false green.
    const budgets = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../../apps/operator/lib/mcp-proxy/budgets.mjs',
      ),
      'utf8',
    );
    const declared = /MCP_PROXY_LOCAL_HEALTH_PATH\s*=\s*'([^']+)'/.exec(budgets)?.[1];
    // Positive control: a failed regex must not pass as agreement with undefined.
    expect(declared).toBeTruthy();
    expect(MCP_PROXY_HEALTH_PATH).toBe(declared);
  });
});

describe('deep health payload carries the MCP plane', () => {
  it('reaches the WIRE, not just the function', async () => {
    const res = await route.handler({} as never, {} as never);
    const body = (await res.json()) as { mcpPlane?: unknown };
    // Reachable or not, the FIELD must be present: its absence is the original bug.
    expect(body.mcpPlane).toMatchObject({
      status: expect.stringMatching(/^(ok|down|disabled)$/),
      latencyMs: expect.any(Number),
      pressure: expect.stringMatching(/^(ok|elevated|saturated|unknown)$/),
    });
  }, 30000);
});

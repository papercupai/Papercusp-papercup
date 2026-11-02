/**
 * in-process-periodic.test.ts — EI-1622. Pins the lightweight in-process scheduler
 * that replaced the high-frequency ephemeral DBOS periodic workflows:
 *  - runPeriodicCheck: heavy ticks shed, light ticks never shed, a throw is swallowed.
 *  - armInProcessPeriodicChecks: idempotent, unref'd, re-entrancy-guarded, disarmable.
 *  - buildDefaultChecks: the exact converted set + cadences + which ticks shed.
 *
 * Pure: scheduled checks are injected; the default health tick runs against
 * mocked service modules, with no PG/flags/network initialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installManagedTickAlarm } from './managed-tick-alarm';
import {
  armInProcessPeriodicChecks,
  buildDefaultChecks,
  disarmInProcessPeriodicChecks,
  checkRunsInThisProcess,
  inProcessPeriodicChecksArmed,
  runPeriodicCheck,
  type PeriodicCheck,
} from './in-process-periodic';

const healthCadence = vi.hoisted(() => ({
  getFlag: vi.fn(),
  readRegistry: vi.fn(),
  tick: vi.fn(),
  sample: vi.fn(),
  canRun: vi.fn(async () => true),
  pulse: vi.fn(async () => ({ outcome: 'noop' })),
  wedge: vi.fn(async () => ({ outcome: 'noop' })),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: healthCadence.getFlag }));
vi.mock('../workspace-registry', () => ({ readRegistry: healthCadence.readRegistry }));
vi.mock('../system-health', () => ({ runSystemHealthTick: healthCadence.tick }));
vi.mock('../system-health/perf-regression-rig', () => ({ collectPerfRegressionWhenDue: healthCadence.sample }));
vi.mock('../device-operator-actions', () => ({ workspaceBackgroundActivityAllowed: healthCadence.canRun }));
vi.mock('../scorecard-emission-pulse', () => ({ runScorecardEmissionPulse: healthCadence.pulse,
  checkOverwatchEmissionWedge: healthCadence.wedge }));
vi.mock('./managed-tick-alarm', () => ({ installManagedTickAlarm: vi.fn() }));

beforeEach(() => { healthCadence.canRun.mockReset().mockResolvedValue(true); });

afterEach(() => {
  disarmInProcessPeriodicChecks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runPeriodicCheck', () => {
  it('runs a light (non-shed) tick and never consults the shed policy', async () => {
    const tick = vi.fn(async () => {});
    const shouldShed = vi.fn(() => true); // would shed — but a light check ignores it
    const check: PeriodicCheck = { name: 'light', intervalMs: 1000, classification: 'must-sample', tick };
    const res = await runPeriodicCheck(check, { shouldShed });
    expect(res).toEqual({ ran: true });
    expect(tick).toHaveBeenCalledOnce();
    expect(shouldShed).not.toHaveBeenCalled();
  });

  it('skips a HEAVY tick when the shed policy says to shed (tick not called)', async () => {
    const tick = vi.fn(async () => {});
    const check: PeriodicCheck = { name: 'heavy', intervalMs: 1000, shed: true, classification: 'must-sample', tick };
    const res = await runPeriodicCheck(check, { shouldShed: () => true });
    expect(res).toEqual({ ran: false, shed: true });
    expect(tick).not.toHaveBeenCalled();
  });

  it('runs a HEAVY tick when the shed policy says not to shed', async () => {
    const tick = vi.fn(async () => {});
    const check: PeriodicCheck = { name: 'heavy', intervalMs: 1000, shed: true, classification: 'must-sample', tick };
    const res = await runPeriodicCheck(check, { shouldShed: () => false });
    expect(res).toEqual({ ran: true });
    expect(tick).toHaveBeenCalledOnce();
  });

  it('swallows a throwing tick (never throws) and logs it', async () => {
    const log = vi.fn();
    const check: PeriodicCheck = {
      name: 'boom',
      intervalMs: 1000,
      classification: 'must-sample',
      tick: async () => {
        throw new Error('kaboom');
      },
    };
    const res = await runPeriodicCheck(check, { log });
    expect(res).toEqual({ ran: false });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('boom tick failed');
    expect(log.mock.calls[0][0]).toContain('kaboom');
  });
});

describe('shared optional workspace effects', () => {
  it.each(['system-health', 'scorecard-emission-pulse'])('withholds %s only in the paused workspace and rechecks on the next fire', async name => {
    healthCadence.getFlag.mockResolvedValue(true);
    healthCadence.readRegistry.mockReturnValue({ workspaces: [{ id: 'paused-ws' }, { id: 'active-ws' }] });
    healthCadence.tick.mockReset().mockResolvedValue({});
    healthCadence.sample.mockReset().mockResolvedValue({ overdue: false });
    healthCadence.pulse.mockReset().mockResolvedValue({ outcome: 'noop' });
    healthCadence.wedge.mockReset().mockResolvedValue({ outcome: 'noop' });
    healthCadence.canRun.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const check = buildDefaultChecks().find(check => check.name === name)!;
    await check.tick();
    const effect = name === 'system-health' ? healthCadence.tick : healthCadence.pulse;
    expect(effect).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledWith(name === 'system-health' ? 'active-ws' : { workspaceId: 'active-ws' });
    const { startupActivityFeatureId } = await import('../schedule-inventory');
    const { operatorHomeHarnessSlug } = await import('../harness/operator-home-harness');
    for (const workspaceId of ['paused-ws', 'active-ws']) {
      const featureId = startupActivityFeatureId({ source: 'routines', installSlug: operatorHomeHarnessSlug(), name, detail: {} }, { workspaceId });
      expect(healthCadence.canRun).toHaveBeenCalledWith(workspaceId, featureId);
    }
    await check.tick();
    expect(effect).toHaveBeenCalledTimes(3);
    expect(healthCadence.canRun).toHaveBeenCalledTimes(4);
  });

  it('withholds failed policy reads without leaking the provider error or blocking another workspace', async () => {
    healthCadence.getFlag.mockResolvedValue(true);
    healthCadence.readRegistry.mockReturnValue({ workspaces: [{ id: 'failed-ws' }, { id: 'active-ws' }] });
    healthCadence.tick.mockReset().mockResolvedValue({});
    healthCadence.sample.mockReset().mockResolvedValue({ overdue: false });
    healthCadence.canRun.mockRejectedValueOnce(new Error('secret provider body')).mockResolvedValueOnce(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await buildDefaultChecks().find(check => check.name === 'system-health')!.tick();
    expect(healthCadence.tick).toHaveBeenCalledOnce();
    expect(healthCadence.tick).toHaveBeenCalledWith('active-ws');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret');
  });
});

describe('armInProcessPeriodicChecks', () => {
  it('installs the production alarm adapter once when the host arms its checks', () => {
    vi.mocked(installManagedTickAlarm).mockClear();
    armInProcessPeriodicChecks({ checks: [] });
    armInProcessPeriodicChecks({ checks: [] });
    expect(installManagedTickAlarm).toHaveBeenCalledOnce();
  });

  it('fires each check on its own interval and disarm stops it', async () => {
    vi.useFakeTimers();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    const checks: PeriodicCheck[] = [
      { name: 'a', intervalMs: 1000, classification: 'must-sample', tick: a },
      { name: 'b', intervalMs: 2000, classification: 'must-sample', tick: b },
    ];
    armInProcessPeriodicChecks({ checks });
    expect(inProcessPeriodicChecksArmed()).toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // a fires twice (1s, 2s), b once (2s)
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);

    disarmInProcessPeriodicChecks();
    expect(inProcessPeriodicChecksArmed()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // no further fires after disarm
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second arm is a no-op (does not arm a different check set)', async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    armInProcessPeriodicChecks({ checks: [{ name: 'first', intervalMs: 1000, classification: 'must-sample', tick: first }] });
    armInProcessPeriodicChecks({ checks: [{ name: 'second', intervalMs: 1000, classification: 'must-sample', tick: second }] });

    await vi.advanceTimersByTimeAsync(1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled(); // the 2nd arm was ignored
  });

  it('re-entrancy guard: a still-running tick is not fired concurrently', async () => {
    vi.useFakeTimers();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const check: PeriodicCheck = {
      name: 'slow',
      intervalMs: 1000,
      classification: 'must-sample',
      tick: async () => {
        entered += 1;
        await gate; // hold the tick open across the next interval
      },
    };
    armInProcessPeriodicChecks({ checks: [check] });

    await vi.advanceTimersByTimeAsync(1000); // fire 1 → entered=1, tick pending
    await vi.advanceTimersByTimeAsync(1000); // fire 2 → running guard skips it
    expect(entered).toBe(1);

    release(); // let the held tick finish → running flag clears
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); // fire 3 → runs again
    expect(entered).toBe(2);
  });
});

describe('cluster scope — only the primary runs host-scoped sweeps (P-018)', () => {
  // The defect this pins: host-bootstrap arms this suite under `backgroundWorkers`, whose
  // comment claims it prevents "a naive interval running N× across :3070 cluster request
  // workers". It never did — backgroundWorkersEnabled() reads only env, and a forked
  // worker inherits it. Measured on the 16-worker release cluster: >=7 distinct worker
  // pids each ran the system-health tick's wide engineer_issues read within one 75s sample.
  const mk = (name: string, scope?: 'host' | 'process'): PeriodicCheck =>
    ({ name, intervalMs: 1000, classification: 'must-sample', tick: () => {}, ...(scope ? { scope } : {}) });

  it('defaults to host scope — an unmarked check does NOT run in a cluster worker', () => {
    expect(checkRunsInThisProcess(mk('system-health'), false)).toBe(false);
    expect(checkRunsInThisProcess(mk('system-health'), true)).toBe(true);
  });

  it('runs a process-scoped check in workers AND the primary', () => {
    expect(checkRunsInThisProcess(mk('connection-pressure', 'process'), false)).toBe(true);
    expect(checkRunsInThisProcess(mk('connection-pressure', 'process'), true)).toBe(true);
  });

  it('arms only the process-scoped checks in a worker', () => {
    const ticks: string[] = [];
    const checks: PeriodicCheck[] = [
      { ...mk('host-one'), tick: () => { ticks.push('host-one'); } },
      { ...mk('per-process', 'process'), tick: () => { ticks.push('per-process'); } },
    ];
    armInProcessPeriodicChecks({ checks, isPrimary: false });
    expect(inProcessPeriodicChecksArmed()).toBe(true);
    disarmInProcessPeriodicChecks();
    // and the primary arms both
    armInProcessPeriodicChecks({ checks, isPrimary: true });
    expect(inProcessPeriodicChecksArmed()).toBe(true);
  });

  it('a non-clustered host is UNAFFECTED — isPrimary is true off-cluster, so everything still runs', () => {
    // The safety property: single-process hosts (dev/staging trees, the desktop's own
    // operator) must keep every check. node:cluster reports isPrimary true when unforked.
    for (const c of buildDefaultChecks()) expect(checkRunsInThisProcess(c, true)).toBe(true);
  });

  it('connection-pressure is the ONLY process-scoped check (it feeds an in-process governor)', () => {
    // If a future check is marked 'process', that is a deliberate decision and this test
    // should be updated WITH the reason — not silently widened.
    const perProcess = buildDefaultChecks().filter((c) => c.scope === 'process').map((c) => c.name);
    expect(perProcess).toEqual(['connection-pressure']);
  });

  it('every heavy (shed:true) check is host-scoped — those are the ones that were costing 17x', () => {
    for (const c of buildDefaultChecks().filter((c) => c.shed)) {
      expect(checkRunsInThisProcess(c, false)).toBe(false);
    }
  });
});

describe('buildDefaultChecks (the converted EI-1622 set)', () => {
  const checks = buildDefaultChecks();
  const byName = new Map(checks.map((c) => [c.name, c]));

  function mockHealthCadence(workspaceId: string): void {
    healthCadence.getFlag.mockReset().mockResolvedValue(true);
    healthCadence.readRegistry.mockReset().mockReturnValue({ workspaces: [{ id: workspaceId }] });
    healthCadence.tick.mockReset().mockResolvedValue({});
    healthCadence.sample.mockReset().mockResolvedValue({
      attempted: true, persisted: true, overdue: false, lastCapturedAt: null,
    });
  }

  it('feeds performance history from the active system-health tick', async () => {
    mockHealthCadence('perf-test-ws');

    await byName.get('system-health')!.tick();

    expect(healthCadence.tick).toHaveBeenCalledWith('perf-test-ws');
    expect(healthCadence.sample).toHaveBeenCalledWith('perf-test-ws');
  });

  it('reports a silent producer with its last persisted sample and bounds repeated warnings', async () => {
    mockHealthCadence('silent-perf-ws');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    healthCadence.sample.mockResolvedValue({
      attempted: true, persisted: false, overdue: true,
      lastCapturedAt: '2026-08-24T16:46:53.652Z', note: 'snapshot insert failed',
    });
    await byName.get('system-health')!.tick();
    await byName.get('system-health')!.tick();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lastCapturedAt=2026-08-24T16:46:53.652Z: snapshot insert failed'));
    vi.setSystemTime(new Date('2026-09-23T12:15:00Z'));
    await byName.get('system-health')!.tick();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('bounds persistence-read errors and continues sampling other workspaces', async () => {
    mockHealthCadence('broken-perf-ws');
    healthCadence.readRegistry.mockReturnValue({ workspaces: [{ id: 'broken-perf-ws' }, { id: 'healthy-perf-ws' }] });
    healthCadence.sample.mockImplementation(async (ws: string) => {
      if (ws === 'broken-perf-ws') throw new Error('database unavailable');
      return { attempted: false, persisted: true, overdue: false, lastCapturedAt: null };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await byName.get('system-health')!.tick();
    await byName.get('system-health')!.tick();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sampling failed for broken-perf-ws: database unavailable'));
    expect(healthCadence.sample).toHaveBeenCalledWith('healthy-perf-ws');
    expect(healthCadence.sample).toHaveBeenCalledTimes(4);
  });

  it('carries exactly the expected ephemeral probe set (the EI-1622 conversions + later additions)', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'blind-review-runtime-reaper',
        'completion-ref-verify',
        'connection-pressure',
        'dbos-history-ceiling',
        'federation-drain-reconcile',
        'harness-status-sweep',
        'host-contention-sampler',
        'kernel-leak-watchdog',
        'pot-epoch-key-reconcile',
        'learning-infra-health',
        'pg-tuning-drift',
        'poll-suspect-scan',
        'release-request-sweep',
        'scorecard-emission-pulse',
        'service-health',
        'shared-presence-reaper',
        'spawn-reclaim-sweep',
        'stale-claim-sweep',
        'steering-churn-sweep',
        'system-health',
        'timer-registration-scan',
      ].sort(),
    );
  });

  it('runs runtime recovery on host startup and every 30s, including pressure, with no cluster-worker duplicate', () => {
    const recovery = byName.get('blind-review-runtime-reaper')!;
    expect(recovery).toMatchObject({ intervalMs: 30_000, fireOnArm: true, shed: false, classification: 'timeout-reaper' });
    expect(checkRunsInThisProcess(recovery, true)).toBe(true);
    expect(checkRunsInThisProcess(recovery, false)).toBe(false);
  });

  it('preserves each check cadence (no frequency cuts — the row-cost is already gone)', () => {
    expect(byName.get('dbos-history-ceiling')!).toMatchObject({ intervalMs: 30_000, fireOnArm: true, classification: 'must-sample' });
    expect(byName.get('dbos-history-ceiling')!.shed).not.toBe(true);
    expect(byName.get('system-health')!.intervalMs).toBe(30_000);
    expect(byName.get('harness-status-sweep')!.intervalMs).toBe(30_000);
    expect(byName.get('connection-pressure')!.intervalMs).toBe(30_000);
    expect(byName.get('service-health')!.intervalMs).toBe(60_000);
    expect(byName.get('host-contention-sampler')!.intervalMs).toBe(60_000);
    expect(byName.get('kernel-leak-watchdog')!.intervalMs).toBe(10 * 60_000);
    expect(byName.get('completion-ref-verify')!.intervalMs).toBe(60_000);
    expect(byName.get('spawn-reclaim-sweep')!.intervalMs).toBe(60_000);
    expect(byName.get('stale-claim-sweep')!.intervalMs).toBe(60_000);
    expect(byName.get('release-request-sweep')!.intervalMs).toBe(60_000);
    expect(byName.get('learning-infra-health')!.intervalMs).toBe(120_000);
    expect(byName.get('steering-churn-sweep')!.intervalMs).toBe(300_000);
    expect(byName.get('federation-drain-reconcile')!.intervalMs).toBe(300_000);
    expect(byName.get('pot-epoch-key-reconcile')!.intervalMs).toBe(600_000);
    expect(byName.get('shared-presence-reaper')!.intervalMs).toBe(300_000);
    expect(byName.get('scorecard-emission-pulse')!.intervalMs).toBe(600_000);
    expect(byName.get('pg-tuning-drift')!.intervalMs).toBe(30 * 60_000);
    expect(byName.get('kernel-leak-watchdog')!.intervalMs).toBe(600_000);
    expect(byName.get('poll-suspect-scan')!.intervalMs).toBe(3600_000);
    expect(byName.get('timer-registration-scan')!.intervalMs).toBe(600_000);
  });

  it('classifies every check per D-004 (P-011 guard) — no default check is unclassified', () => {
    const VALID = new Set(['must-sample', 'timeout-reaper', 'violation']);
    for (const c of checks) {
      expect(VALID.has(c.classification), `${c.name} has an invalid/missing classification: ${c.classification}`).toBe(true);
    }
  });

  it('pins the D-004 classification verdict (lane C1 audit, WI-6091/D-008) per timer', () => {
    // system-health is the ONE confirmed VIOLATION across all 104 audited timers
    // (D-008) — a regression here (e.g. someone flipping it to must-sample to
    // silence a future lint) is exactly the kind of drift this guard exists to
    // catch, so it is pinned individually rather than folded into a generic map.
    expect(byName.get('system-health')!.classification).toBe('violation');

    const mustSample = [
      'harness-status-sweep',
      'connection-pressure',
      'service-health',
      'completion-ref-verify',
      'learning-infra-health',
      'pg-tuning-drift', // a conf.d edit + SIGHUP happens entirely outside this process
      'kernel-leak-watchdog', // kernel memory has no change-event source
      'steering-churn-sweep', // borderline (D-008), kept must-sample not violation
      'poll-suspect-scan', // borderline (D-008), kept must-sample not violation
      'timer-registration-scan', // same shape as poll-suspect-scan
    ];
    for (const name of mustSample) {
      expect(byName.get(name)!.classification, name).toBe('must-sample');
    }

    const timeoutReaper = [
      'blind-review-runtime-reaper',
      'spawn-reclaim-sweep',
      'stale-claim-sweep',
      'release-request-sweep',
      'federation-drain-reconcile',
      'pot-epoch-key-reconcile',
      'shared-presence-reaper',
      'scorecard-emission-pulse',
    ];
    for (const name of timeoutReaper) {
      expect(byName.get(name)!.classification, name).toBe('timeout-reaper');
    }
  });

  it('only the heavy ticks shed under load (parity with shouldShedHeavyTick)', () => {
    const shedders = checks.filter((c) => c.shed).map((c) => c.name).sort();
    // federation-drain-reconcile sheds: it group-scans substrate_outbox, and a real
    // stall persists, so a shed tick is caught next interval (WI-254).
    // pot-epoch-key-reconcile does NOT shed: it is GAP-AWARE (no crypto on an intact hive), so it
    // stays cheap under load AND its fireOnArm heal-on-startup must run even during the busy boot.
    // scorecard-emission-pulse sheds: it computes SystemHealth when it fires, and a shed
    // cycle just delays the deterministic floor one 10min interval.
    expect(shedders).toEqual([
      'federation-drain-reconcile',
      'harness-status-sweep',
      'scorecard-emission-pulse',
      'system-health',
    ]);
  });
});

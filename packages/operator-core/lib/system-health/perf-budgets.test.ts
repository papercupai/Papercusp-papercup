/**
 * perf-budgets.test — the per-thread SLO budget evaluator (round-4 Lane F / P-030).
 * Pure boundary tests: no IO. Pins the load-bearing reframe (loadavg is NOT a budget
 * on a 128-core box), the definitive-wedge crits, the warn tiers, and the fail-safes
 * (stale never reds; null/wrong-schema → unknown).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateRealBackendAdmission,
  evaluateMemoryPressure,
  evaluatePerfSignals,
  worstOwnedInotifyHolder,
  type PerfSignalsV1,
  type PerfConditionContext,
  perfBudgetConditionKey,
} from './perf-budgets';

const NOW = Date.parse('2026-06-19T16:35:00Z');
const sig = (
  over: Partial<PerfSignalsV1['signals']> = {},
  top: Partial<PerfSignalsV1> = {},
): PerfSignalsV1 => ({
  schemaVersion: 'perf-signals-v1',
  capturedAt: '2026-06-19T16:34:50Z', // ~10s old → fresh
  hostState: 'stable',
  signals: {
    loadavg: { l1: 18, l5: 19, l15: 20, cores: 128 },
    operatorWorkers: [{ pid: 1, cpuPct: 9, rssKb: 1_000_000, etimeSec: 100 }],
    closeWait_3070: 0,
    gateway_8788_reachable: true,
    operator_3070_reachable: true,
    ...over,
  },
  ...top,
});

describe('condition rail at the original perf evaluator', () => {
  const capture = (over: Partial<PerfSignalsV1['signals']> = {}, top: Partial<PerfSignalsV1> = {}) => sig({
    eventLoopLag: { lag_p95_ms: 5, window_mature: true },
    psi: { cpu: { some: { avg60: 0 } }, memory: { some: { avg60: 0 }, full: { avg60: 0 } } },
    inotify: { totalWatches: 100, limits: { maxUserWatches: 1_000_000 } }, ...over,
  }, { capturedAt: new Date(NOW).toISOString(), ...top });
  function fixture() {
    const open = new Map<string, number>();
    const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true); if (!open.has(event.conditionKey!)) open.set(event.conditionKey!, NOW); return true;
    });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    const context: PerfConditionContext = { workspaceId: 'fixture', hostId: 'host', rail: { broadcast, resolve },
      readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })) };
    const key = (kind: 'operator' | 'ambient') => perfBudgetConditionKey(kind, 'fixture', 'host');
    return { open, broadcast, resolve, context, key };
  }
  const breach = () => capture({ operator_3070_reachable: false,
    psi: { cpu: { some: { avg60: 99 } }, memory: { full: { avg60: 0 } } } });

  it('opens independent episodes, resolves measured recovery and rearms after recovery', async () => {
    const f = fixture();
    expect((await evaluatePerfSignals(breach(), NOW, undefined, false, f.context)).degraded).toBe(true);
    expect([...f.open.keys()]).toEqual([f.key('operator'), f.key('ambient')]);
    await evaluatePerfSignals(breach(), NOW, undefined, false, f.context);
    expect(f.open.size).toBe(2);
    await evaluatePerfSignals(capture(), NOW, undefined, false, f.context);
    expect(f.open.size).toBe(0); expect(f.resolve).toHaveBeenCalledTimes(2);
    await evaluatePerfSignals(breach(), NOW, undefined, false, f.context); expect(f.open.size).toBe(2);
  });

  it.each(['missing', 'schema', 'stale', 'future', 'clock', 'partial', 'immature', 'deploy', 'old', 'foreign', 'read-failed'])(
    'preserves episodes on %s evidence across a fresh evaluator context', async mode => {
      const f = fixture(); await evaluatePerfSignals(breach(), NOW, undefined, false, f.context);
      let sample: PerfSignalsV1 | null = capture(), context = { ...f.context }, now = NOW;
      if (mode === 'missing') sample = null;
      if (mode === 'schema') sample = capture({}, { schemaVersion: 'invalid' });
      if (mode === 'stale') sample = capture({}, { capturedAt: new Date(NOW - 3_600_000).toISOString() });
      if (mode === 'future') sample = capture({}, { capturedAt: new Date(NOW + 1).toISOString() });
      if (mode === 'clock') now = Number.NaN;
      if (mode === 'partial') sample = sig({}, { capturedAt: new Date(NOW).toISOString() });
      if (mode === 'immature') sample = capture({ eventLoopLag: { lag_p95_ms: 0, window_mature: false }, psi: null });
      if (mode === 'deploy') sample = capture({ operator_3070_reachable: false, psi: null });
      if (mode === 'old') sample = capture({}, { capturedAt: new Date(NOW - 1).toISOString() });
      if (mode === 'foreign') context.workspaceId = 'other';
      if (mode === 'read-failed') context.readOpenConditions = async () => { throw new Error('unreadable'); };
      await evaluatePerfSignals(sample, now, undefined, mode === 'deploy', context);
      expect(f.open.size).toBe(2); expect(f.resolve).not.toHaveBeenCalled();
    });

  it('recovers independent known classes while the other class remains unmeasured', async () => {
    const f = fixture(); await evaluatePerfSignals(breach(), NOW, undefined, false, f.context);
    await evaluatePerfSignals(capture({ psi: null }), NOW, undefined, false, f.context);
    expect([...f.open.keys()]).toEqual([f.key('ambient')]);
    await evaluatePerfSignals(capture({ eventLoopLag: null }), NOW, undefined, false, f.context);
    expect(f.open.size).toBe(0);
  });

  it('awaits delivery and retains the verdict and other episode after a rail failure', async () => {
    const f = fixture(); let release!: () => void, settled = false;
    f.context.rail!.broadcast = async event => {
      if (event.conditionKey === f.key('operator')) {
        await new Promise<void>(resolve => { release = resolve; }); throw new Error('refused');
      }
      return f.broadcast(event);
    };
    const pending = evaluatePerfSignals(breach(), NOW, undefined, false, f.context).then(v => { settled = true; return v; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(settled).toBe(false); release(); expect((await pending).status).toBe('crit');
    expect([...f.open.keys()]).toEqual([f.key('ambient')]);
  });

  it('retains failed resolutions and rejects invalid measurements and episode clocks', async () => {
    const f = fixture(); await evaluatePerfSignals(breach(), NOW, undefined, false, f.context);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await evaluatePerfSignals(capture(), NOW, undefined, false, { ...f.context,
        rail: { resolve: async () => { throw new Error('unavailable'); } } });
      expect(f.open.size).toBe(2); expect(warning).toHaveBeenCalledTimes(2);
    } finally { warning.mockRestore(); }
    await evaluatePerfSignals(capture({ eventLoopLag: { lag_p95_ms: Number.NaN },
      psi: { cpu: { some: { avg60: Number.NaN } }, memory: { full: { avg60: Number.NaN } } } }),
      NOW, undefined, false, f.context);
    expect(f.open.size).toBe(2);
    await evaluatePerfSignals(capture(), NOW, undefined, false, { ...f.context,
      readOpenConditions: async () => [...f.open.keys()].map(conditionKey => ({ conditionKey, openedAtMs: Number.NaN })) });
    expect(f.resolve).not.toHaveBeenCalled();
    const invalid = fixture(); await evaluatePerfSignals(capture({ eventLoopLag: { lag_p95_ms: Number.POSITIVE_INFINITY },
      psi: { cpu: { some: { avg60: 101 } } } }), NOW, undefined, false, invalid.context);
    expect(invalid.open.size).toBe(0);
  });
});

describe('critAttribution — WI-38449 / D-007 F3: which crits may hold a deploy', () => {
  // Attribution is assigned where each reason is RAISED. These cases pin the classes
  // apart at the producer, so the gate never has to infer intent from reason prose.
  const critOf = (over: Partial<PerfSignalsV1['signals']> = {}, top: Partial<PerfSignalsV1> = {}) =>
    evaluatePerfSignals(sig(over, top), NOW);

  it('operator :3070 unreachable is an OPERATOR DEFECT — this is what block-mode is for', () => {
    const v = critOf({ operator_3070_reachable: false });
    expect(v.status).toBe('crit');
    expect(v.critAttribution.operatorDefect).toEqual(['operator :3070 unreachable']);
    expect(v.critAttribution.ambientHost).toEqual([]);
  });

  it('a live wedge and a 1s+ event-loop lag are OPERATOR DEFECTS', () => {
    expect(critOf({}, { hostState: 'wedge-active' }).critAttribution.operatorDefect).toHaveLength(1);
    const lag = critOf({ eventLoopLag: { lag_p95_ms: 1746 } });
    expect(lag.critAttribution.operatorDefect).toHaveLength(1);
    expect(lag.critAttribution.ambientHost).toEqual([]);
  });

  it('CLOSE_WAIT saturation is an OPERATOR DEFECT', () => {
    const v = critOf({ closeWait_3070: 935 });
    expect(v.critAttribution.operatorDefect).toHaveLength(1);
    expect(v.critAttribution.ambientHost).toEqual([]);
  });

  it('PSI cpu starvation is AMBIENT HOST — a shared box, not a candidate defect', () => {
    const v = critOf({ psi: { cpu: { some: { avg60: 97 } } } } as Partial<PerfSignalsV1['signals']>);
    expect(v.status).toBe('crit');
    expect(v.critAttribution.ambientHost).toHaveLength(1);
    expect(v.critAttribution.operatorDefect).toEqual([]);
  });

  it('THE MEASURED INCIDENT: memory-pressure crit is AMBIENT, so an armed gate must not block on it', () => {
    // 2026-08-16, live capture: `PSI memory full avg60 11.45 ≥ 5` was the SOLE crit
    // reason while ~100 peer agents shared the box. Before D-007 F3 this returned
    // `block` from an armed gate and would have frozen every deploy.
    const v = critOf({ psi: { memory: { full: { avg60: 11.45 }, some: { avg60: 40 } } } } as Partial<
      PerfSignalsV1['signals']
    >);
    expect(v.status).toBe('crit');
    expect(v.critAttribution.operatorDefect).toEqual([]);
    expect(v.critAttribution.ambientHost.length).toBeGreaterThan(0);
  });

  it('INVARIANT: every crit reason is attributed exactly once, and the two classes reconstruct `reasons`', () => {
    // Guards the raise() helper against a reason that is pushed to `crit` but to
    // neither bucket (silently unblockable) or to both (double-counted).
    const mixed = critOf({
      operator_3070_reachable: false,
      psi: { memory: { full: { avg60: 11.45 } } },
    } as Partial<PerfSignalsV1['signals']>);
    expect(mixed.status).toBe('crit');
    const { operatorDefect, ambientHost } = mixed.critAttribution;
    expect([...operatorDefect, ...ambientHost].sort()).toEqual([...mixed.reasons].sort());
    expect(operatorDefect.filter((r) => ambientHost.includes(r))).toEqual([]);
    expect(operatorDefect.length).toBeGreaterThan(0);
    expect(ambientHost.length).toBeGreaterThan(0);
  });

  it('CALIBRATION: a non-crit verdict carries EMPTY attribution, not a stale or defaulted one', () => {
    // Without this, "operatorDefect is empty" would be trivially true everywhere and
    // the invariant above could pass on a verdict that never populated anything.
    for (const v of [evaluatePerfSignals(sig(), NOW), evaluatePerfSignals(null, NOW)]) {
      expect(v.critAttribution).toEqual({ operatorDefect: [], ambientHost: [] });
    }
    expect(critOf({ closeWait_3070: 300 }).status).toBe('warn'); // warn tier
    expect(critOf({ closeWait_3070: 300 }).critAttribution.ambientHost).toEqual([]);
  });

  it('a deploy-suppressed unreachable is NOT attributed as a defect — it never became a crit', () => {
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }), NOW, undefined, true);
    expect(v.critAttribution.operatorDefect).toEqual([]);
    expect(v.suppressedReasons.length).toBeGreaterThan(0);
  });
});

describe('evaluatePerfSignals (per-thread SLO budgets)', () => {
  it('ok on a clean stable capture', () => {
    expect(evaluatePerfSignals(sig(), NOW).status).toBe('ok');
  });

  // THE reframe (round-4 D-010): loadavg 22 on 128 cores is NOT degraded, and a single
  // hot worker while "stable" is fine (su-1aa2f's 199%-while-stable live proof).
  it('does NOT degrade on high loadavg + a 199% worker while stable (128-core reframe)', () => {
    const v = evaluatePerfSignals(
      sig({ loadavg: { l1: 22, l5: 22, l15: 22, cores: 128 }, operatorWorkers: [{ pid: 1, cpuPct: 199, rssKb: 1_000_000, etimeSec: 100 }] }),
      NOW,
    );
    expect(v.status).toBe('ok'); // 199% < 200 warn budget; loadavg is never thresholded
    expect(v.degraded).toBe(false);
  });

  it('crit when the operator :3070 is unreachable (definitive wedge)', () => {
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }), NOW);
    expect(v.status).toBe('crit');
    expect(v.degraded).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/unreachable/);
  });

  it('crit when hostState is wedge-active (E1 caught a live wedge)', () => {
    expect(evaluatePerfSignals(sig({}, { hostState: 'wedge-active' }), NOW).status).toBe('crit');
  });

  // EI-12302: a sanctioned deploy restart makes :3070 briefly unreachable — that must
  // not page as a real wedge when the caller has confirmed a deploy is in progress
  // (the 'dev-server' resource lock held exclusive), but every OTHER definitive
  // per-thread crit signal must still fire unaffected.
  it('suppresses the unreachable crit when deployInProgress is true, and downgrades status', () => {
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }), NOW, undefined, true);
    expect(v.status).toBe('ok'); // no other crit/warn signals present
    expect(v.degraded).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.suppressedReasons.join(' ')).toMatch(/unreachable/);
    expect(v.suppressedReasons.join(' ')).toMatch(/deploy-in-progress/);
  });

  it('still crits on unreachable when deployInProgress is false (the default)', () => {
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }), NOW);
    expect(v.status).toBe('crit');
    expect(v.suppressedReasons).toEqual([]);
  });

  it('deployInProgress does NOT swallow a real wedge signal (hostState=wedge-active still crits)', () => {
    const v = evaluatePerfSignals(
      sig({ operator_3070_reachable: false }, { hostState: 'wedge-active' }),
      NOW,
      undefined,
      true,
    );
    expect(v.status).toBe('crit');
    expect(v.reasons.join(' ')).toMatch(/wedge-active/);
    expect(v.reasons.join(' ')).not.toMatch(/unreachable/); // the reachable reason was suppressed, not just co-listed
    expect(v.suppressedReasons.join(' ')).toMatch(/unreachable/);
  });

  it('deployInProgress does NOT swallow event-loop-lag / CLOSE_WAIT crits', () => {
    const lag = evaluatePerfSignals(
      sig({ operator_3070_reachable: false, eventLoopLag: { lag_p95_ms: 2000 } }),
      NOW,
      undefined,
      true,
    );
    expect(lag.status).toBe('crit');
    expect(lag.reasons.join(' ')).toMatch(/event-loop lag/);

    const closeWait = evaluatePerfSignals(
      sig({ operator_3070_reachable: false, closeWait_3070: 600 }),
      NOW,
      undefined,
      true,
    );
    expect(closeWait.status).toBe('crit');
    expect(closeWait.reasons.join(' ')).toMatch(/CLOSE_WAIT/);
  });

  it('crit on event-loop lag p95 over the crit budget', () => {
    const v = evaluatePerfSignals(sig({ eventLoopLag: { lag_p95_ms: 1746 } }), NOW);
    expect(v.status).toBe('crit');
    expect(v.eventLoopLagP95Ms).toBe(1746);
  });

  it('keeps an immature one-sample p95/max spike as warn evidence instead of a critical operator defect', () => {
    const v = evaluatePerfSignals(
      sig({
        eventLoopLag: {
          lag_p95_ms: 1569.7,
          lag_p99_ms: 1569.7,
          lag_max_ms: 1569.7,
          sample_count: 1,
          window_ms: 120,
          window_mature: false,
        },
      }),
      NOW,
    );
    expect(v.status).toBe('warn');
    expect(v.eventLoopLagP95Ms).toBe(1569.7);
    expect(v.eventLoopLagMaxMs).toBe(1569.7);
    expect(v.eventLoopLagSampleCount).toBe(1);
    expect(v.eventLoopLagWindowMs).toBe(120);
    expect(v.eventLoopLagWindowMature).toBe(false);
    expect(v.critAttribution.operatorDefect).toEqual([]);
    expect(v.reasons.join(' ')).toMatch(/partial window.*max 1569\.7ms.*insufficient for critical/i);
    expect(v.suppressedReasons.join(' ')).toMatch(/not promoted to critical.*1 samples.*max 1569\.7ms/i);
  });

  it('still crits on the same p95 when the histogram window is mature', () => {
    const v = evaluatePerfSignals(
      sig({
        eventLoopLag: {
          lag_p95_ms: 1569.7,
          lag_max_ms: 1569.7,
          sample_count: 20,
          window_ms: 450,
          window_mature: true,
        },
      }),
      NOW,
    );
    expect(v.status).toBe('crit');
    expect(v.critAttribution.operatorDefect.join(' ')).toMatch(/event-loop lag p95/);
    expect(v.suppressedReasons).toEqual([]);
  });

  it('reads the MCP-merged eventLoopLag from _mcp_supplemented too', () => {
    expect(evaluatePerfSignals(sig({ _mcp_supplemented: { eventLoopLag: { lag_p95_ms: 1200 } } }), NOW).status).toBe('crit');
  });

  it('crit on a CLOSE_WAIT storm (event-loop peg symptom, deeb4 935 peak)', () => {
    expect(evaluatePerfSignals(sig({ closeWait_3070: 935 }), NOW).status).toBe('crit');
  });

  it('warn (not crit) on a hot worker over the CPU% warn budget', () => {
    const v = evaluatePerfSignals(sig({ operatorWorkers: [{ pid: 1, cpuPct: 272, rssKb: 1_000_000, etimeSec: 100 }] }), NOW);
    expect(v.status).toBe('warn');
    expect(v.worstWorkerCpuPct).toBe(272);
  });

  it('warn on a worker RSS over the leak budget (bg-host 3.2GB OOM class)', () => {
    expect(evaluatePerfSignals(sig({ operatorWorkers: [{ pid: 1, cpuPct: 9, rssKb: 3_200_000, etimeSec: 100 }] }), NOW).status).toBe('warn');
  });

  it('warn on CLOSE_WAIT past the warn budget but below crit', () => {
    expect(evaluatePerfSignals(sig({ closeWait_3070: 300 }), NOW).status).toBe('warn');
  });

  it('warn when the inference gateway is unreachable', () => {
    expect(evaluatePerfSignals(sig({ gateway_8788_reachable: false }), NOW).status).toBe('warn');
  });

  it('crit outranks warn (unreachable + a hot worker → crit)', () => {
    expect(
      evaluatePerfSignals(sig({ operator_3070_reachable: false, operatorWorkers: [{ pid: 1, cpuPct: 272, rssKb: 4_000_000, etimeSec: 100 }] }), NOW).status,
    ).toBe('crit');
  });

  it('unknown (never reds) on a BRIEFLY-stale capture — even one that looks crit', () => {
    // staleMs(10min) < age(15min) <= blindMs(30min): the timer skipped a tick — numbers
    // untrustworthy → unknown, but not yet a "monitor blind" alarm.
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }, { capturedAt: '2026-06-19T16:20:00Z' }), NOW); // ~15min old
    expect(v.status).toBe('unknown');
    expect(v.stale).toBe(true);
    expect(v.degraded).toBe(false); // stale crit-looking data must NOT red the system
  });

  it('warn "monitor blind" on a VERY-stale capture (dead producer) — still never crit (WI-324 guard)', () => {
    // age(95min) > blindMs(30min): the capture timer has DIED, not skipped a tick — the
    // host SLO monitor is blind. Surface as warn so it is visible, but a stale crit-looking
    // capture must STILL never red (degraded=false), preserving the original fail-safe.
    const v = evaluatePerfSignals(sig({ operator_3070_reachable: false }, { capturedAt: '2026-06-19T15:00:00Z' }), NOW); // ~95min old
    expect(v.status).toBe('warn');
    expect(v.stale).toBe(true);
    expect(v.degraded).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/blind|stale/i);
  });

  it('unknown on null / wrong-schema input', () => {
    expect(evaluatePerfSignals(null, NOW).status).toBe('unknown');
    expect(evaluatePerfSignals({ schemaVersion: 'other' } as unknown as PerfSignalsV1, NOW).status).toBe('unknown');
  });

  // ── inotify watch balloon + PSI budgets (2026-07-10 meltdown class) ──────────────
  // A recursive fs.watch held 94.5k watches PER PROCESS × 16 workers and starved the
  // host (loadavg >1100, PSI cpu some=96) with NO signal firing beforehand. These
  // budgets make the balloon visible at warn long before the kernel-limit cliff.

  it('warn when a single process balloons its fs watches (early per-offender attention)', () => {
    const v = evaluatePerfSignals(
      sig({ inotify: { totalWatches: 100_000, maxPerProcess: { pid: 4242, comm: 'node-MainThread', watches: 94_531 }, limits: { maxUserWatches: 4_194_304 } } }),
      NOW,
    );
    expect(v.status).toBe('warn');
    expect(v.degraded).toBe(false);
    expect(v.inotifyMaxPerProc?.watches).toBe(94_531);
    expect(v.reasons.join(' ')).toMatch(/watch balloon/);
  });

  it('warn also fires on the pre-GC bloat tier (~17.7k — dead-session dirs), not only a full melt', () => {
    // 2026-07-10 follow-up: after the depth-1 fix the staging operator still held
    // 17,713 watches purely from session-dir-gc lag. That state must alarm — the
    // healthy ceiling is ~5k (fattest legit holder 4.9k).
    const v = evaluatePerfSignals(
      sig({ inotify: { totalWatches: 30_000, maxPerProcess: { pid: 7, comm: 'node-MainThread', watches: 17_713 }, limits: { maxUserWatches: 4_194_304 } } }),
      NOW,
    );
    expect(v.status).toBe('warn');
    expect(v.reasons.join(' ')).toMatch(/watch balloon/);
    // …while the fattest observed LEGIT holder stays quiet.
    const legit = evaluatePerfSignals(
      sig({ inotify: { totalWatches: 30_000, maxPerProcess: { pid: 8, comm: 'node', watches: 4_857 }, limits: { maxUserWatches: 4_194_304 } } }),
      NOW,
    );
    expect(legit.status).toBe('ok');
  });

  it('crit when host-total watches approach max_user_watches (ENOSPC imminent)', () => {
    const v = evaluatePerfSignals(
      sig({ inotify: { totalWatches: 3_400_000, maxPerProcess: { pid: 1, comm: 'node', watches: 10_000 }, limits: { maxUserWatches: 4_194_304 } } }),
      NOW,
    );
    expect(v.status).toBe('crit');
    expect(v.degraded).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/ENOSPC/);
  });

  it('PSI cpu starvation: warn at sustained pressure, crit at meltdown levels', () => {
    const warm = evaluatePerfSignals(sig({ psi: { cpu: { some: { avg60: 45 } } } }), NOW);
    expect(warm.status).toBe('warn');
    expect(warm.psiCpuSome60).toBe(45);

    const melt = evaluatePerfSignals(sig({ psi: { cpu: { some: { avg60: 94.8 } } } }), NOW);
    expect(melt.status).toBe('crit');
    expect(melt.reasons.join(' ')).toMatch(/starved for CPU/);
  });

  it('attaches bounded cgroup CPU ownership to PSI pressure reasons without claiming causality', () => {
    const v = evaluatePerfSignals(
      sig({
        psi: { cpu: { some: { avg60: 97 } } },
        cgroupCpu: {
          accounting: 'cgroup-v2-inclusive-descendants',
          partial: false,
          top: [
            {
              path: '/user.slice/user@1000.service/papercup-vm-win.service',
              cpuUsageUsecDelta: 6_550_000,
              cpuPct: 655,
              directPids: 3,
            },
          ],
          scannedCgroups: 20,
          candidateCgroups: 1,
          maxScanned: 4096,
          maxRows: 40,
          sampleSec: 1,
          budgetSec: 5,
        },
      }),
      NOW,
    );
    expect(v.status).toBe('crit');
    expect(v.cgroupCpuAttribution).toEqual({
      accounting: 'cgroup-v2-inclusive-descendants',
      partial: false,
      top: [
        {
          path: '/user.slice/user@1000.service/papercup-vm-win.service',
          cpuUsageUsecDelta: 6_550_000,
          cpuPct: 655,
          directPids: 3,
        },
      ],
    });
    expect(v.reasons.join(' ')).toMatch(/top cgroup CPU owner/);
    expect(v.reasons.join(' ')).toMatch(/correlation, not proof of causality/);
    expect(v.critAttribution.ambientHost).toEqual(v.reasons);
  });

  // ── memory PSI (WI-5471, 2026-07-19): captured all along, never evaluated ──────
  it('warns on sustained memory PSI some avg60 (early reclaim pressure)', () => {
    const v = evaluatePerfSignals(sig({ psi: { memory: { some: { avg60: 15 } } } }), NOW);
    expect(v.status).toBe('warn');
    expect(v.psiMemorySome60).toBe(15);
    expect(v.reasons.join(' ')).toMatch(/memory reclaim pressure/);
  });

  it('crits on sustained memory PSI full avg60 (real thrashing — the WI-5471 root cause)', () => {
    const v = evaluatePerfSignals(sig({ psi: { memory: { some: { avg60: 11.15 }, full: { avg60: 8.17 } } } }), NOW);
    expect(v.status).toBe('crit');
    expect(v.degraded).toBe(true);
    expect(v.psiMemoryFull60).toBe(8.17);
    expect(v.reasons.join(' ')).toMatch(/all tasks stalled on memory/);
  });

  it('projects bounded cgroup owner context without treating inclusive rows as additive', () => {
    const v = evaluatePerfSignals(
      sig({
        psi: { memory: { some: { avg60: 11.15 }, full: { avg60: 8.17 } } },
        cgroupMemory: {
          accounting: 'cgroup-v2-inclusive-descendants',
          partial: false,
          top: [
            {
              path: '/user.slice',
              memoryBytes: 100_000,
              swapBytes: 20_000,
              anonBytes: 80_000,
              fileBytes: 20_000,
              shmemBytes: 0,
              kernelBytes: 0,
              slabBytes: 0,
              sockBytes: 0,
              directPids: 0,
            },
            {
              path: '/user.slice/user@1000.service/app.slice/papercup-dev-api.service',
              memoryBytes: 60_000,
              swapBytes: 10_000,
              anonBytes: 50_000,
              fileBytes: 10_000,
              shmemBytes: 0,
              kernelBytes: 0,
              slabBytes: 0,
              sockBytes: 0,
              directPids: 17,
            },
          ],
          scannedCgroups: 2,
          candidateCgroups: 2,
          maxScanned: 4096,
          maxRows: 40,
          budgetSec: 5,
        },
      }),
      NOW,
    );
    expect(v.memoryPressure.cgroupAttribution).toEqual({
      accounting: 'cgroup-v2-inclusive-descendants',
      partial: false,
      largestCapturedCgroup: { path: '/user.slice', memoryBytes: 100_000 },
      // This synthetic capture predates the reclaim-event producer. Null keeps
      // "unmeasured" distinct from the false all-clear of an empty array.
      throttled: null,
      top: [
        {
          path: '/user.slice',
          memoryBytes: 100_000,
          swapBytes: 20_000,
          anonBytes: 80_000,
          fileBytes: 20_000,
          slabBytes: 0,
          directPids: 0,
          memoryShareOfLargestCapturedCgroup: 1,
        },
        {
          path: '/user.slice/user@1000.service/app.slice/papercup-dev-api.service',
          memoryBytes: 60_000,
          swapBytes: 10_000,
          anonBytes: 50_000,
          fileBytes: 10_000,
          slabBytes: 0,
          directPids: 17,
          memoryShareOfLargestCapturedCgroup: 0.6,
        },
      ],
    });
  });

  it('preserves cumulative counter units and tri-state own-event knowledge', () => {
    const v = evaluatePerfSignals(
      sig({
        psi: { memory: { full: { avg60: 8.17 } } },
        cgroupMemory: {
          accounting: 'cgroup-v2-inclusive-descendants',
          partial: false,
          top: [
            {
              path: '/user.slice',
              memoryBytes: 100_000,
              swapBytes: 0,
              directPids: 0,
            },
            {
              path: '/tiny.scope',
              memoryBytes: 500,
              swapBytes: 0,
              directPids: 1,
            },
          ],
          throttled: [
            {
              path: '/tiny.scope',
              memoryBytes: 500,
              swapBytes: 0,
              directPids: 1,
              throttledHighEvents: 0,
              throttledMaxEvents: 147_593,
              oomKillEvents: 0,
              throttledMaxEventsSubtree: 147_593,
              oomKillEventsSubtree: 0,
            },
            {
              path: '/descendant-owner',
              memoryBytes: 3_000,
              swapBytes: 0,
              directPids: 0,
              throttledHighEvents: 0,
              throttledMaxEvents: 0,
              oomKillEvents: 0,
              throttledMaxEventsSubtree: 7,
              oomKillEventsSubtree: 2,
            },
            {
              path: '/partially-observed',
              memoryBytes: 2_000,
              swapBytes: 0,
              directPids: 0,
              throttledHighEvents: 0,
              // Missing maxEvents is unknown, not a measured zero.
              oomKillEvents: 0,
              throttledMaxEventsSubtree: 4,
              oomKillEventsSubtree: 0,
            },
          ],
          scannedCgroups: 3,
          candidateCgroups: 3,
          maxScanned: 4096,
          maxRows: 40,
          budgetSec: 5,
        },
      }),
      NOW,
    );

    expect(v.memoryPressure.cgroupAttribution).toMatchObject({
      largestCapturedCgroup: { path: '/user.slice', memoryBytes: 100_000 },
      top: [
        expect.objectContaining({
          path: '/user.slice',
          memoryShareOfLargestCapturedCgroup: 1,
        }),
        expect.objectContaining({
          path: '/tiny.scope',
          memoryShareOfLargestCapturedCgroup: 0.005,
        }),
      ],
      throttled: [
        {
          path: '/tiny.scope',
          memoryBytes: 500,
          memoryShareOfLargestCapturedCgroup: 0.005,
          highEventsCumulative: 0,
          maxEventsCumulative: 147_593,
          oomKillEventsCumulative: 0,
          subtreeMaxEventsCumulative: 147_593,
          subtreeOomKillEventsCumulative: 0,
          subtreeOnly: false,
        },
        {
          path: '/descendant-owner',
          memoryBytes: 3_000,
          memoryShareOfLargestCapturedCgroup: 0.03,
          highEventsCumulative: 0,
          maxEventsCumulative: 0,
          oomKillEventsCumulative: 0,
          subtreeMaxEventsCumulative: 7,
          subtreeOomKillEventsCumulative: 2,
          subtreeOnly: true,
        },
        {
          path: '/partially-observed',
          memoryBytes: 2_000,
          memoryShareOfLargestCapturedCgroup: 0.02,
          highEventsCumulative: 0,
          maxEventsCumulative: null,
          oomKillEventsCumulative: 0,
          subtreeMaxEventsCumulative: 4,
          subtreeOomKillEventsCumulative: 0,
          subtreeOnly: null,
        },
      ],
    });
    const reason = v.memoryPressure.reasons.join(' ');
    expect(reason).toContain('/tiny.scope');
    expect(reason).toContain('historically reclaim-active cgroup');
    expect(reason).toContain('current-window owner unconfirmed');
    expect(reason).toContain('147593 cumulative MemoryMax hit(s)');
    expect(reason).toContain('0.50% of largest captured cgroup');
    expect(reason).not.toContain('reclaim-attributed cgroup');
  });

  it('does not alarm on a healthy memory PSI reading', () => {
    const v = evaluatePerfSignals(sig({ psi: { memory: { some: { avg60: 2 }, full: { avg60: 0 } } } }), NOW);
    expect(v.status).toBe('ok');
  });

  it('absent inotify/psi signals never alarm (older captures stay evaluable)', () => {
    const v = evaluatePerfSignals(sig(), NOW);
    expect(v.status).toBe('ok');
    expect(v.inotifyTotalWatches).toBeNull();
    expect(v.psiCpuSome60).toBeNull();
    expect(v.psiMemorySome60).toBeNull();
    expect(v.psiMemoryFull60).toBeNull();
  });

  // ── session-dir population (session-db-archive-retire-dirs P-007) ─────────
  // After archive-at-death, per-session dirs are capped ≈ live-session count.
  // A rebound = the exit hook / hourly reconciler stopped archiving — the
  // population the 2026-07-10 meltdown grew on. Warn-only (a stalled janitor
  // is not itself a wedge).

  it('warns when either session-dir population balloons (stalled archive lifecycle)', () => {
    const claude = evaluatePerfSignals(
      sig({ sessionDirs: { claudeOwnerDirs: 17_287, codexHomes: 120 } }),
      NOW,
    );
    expect(claude.status).toBe('warn');
    expect(claude.sessionDirs).toEqual({ claudeOwnerDirs: 17_287, codexHomes: 120 });
    expect(claude.reasons.join(' ')).toMatch(/archive-at-death lifecycle stalled/);

    const codex = evaluatePerfSignals(
      sig({ sessionDirs: { claudeOwnerDirs: 80, codexHomes: 5_000 } }),
      NOW,
    );
    expect(codex.status).toBe('warn');
    expect(codex.reasons.join(' ')).toMatch(/codex per-session homes/);
  });

  it('healthy post-backfill populations stay ok; absent signal never alarms', () => {
    const ok = evaluatePerfSignals(sig({ sessionDirs: { claudeOwnerDirs: 140, codexHomes: 60 } }), NOW);
    expect(ok.status).toBe('ok');
    const absent = evaluatePerfSignals(sig(), NOW);
    expect(absent.sessionDirs).toBeNull();
  });
});

describe('evaluateMemoryPressure (host.memoryPressure shared writer)', () => {
  it('is the exact child verdict consumed by the full infra-liveness evaluator', () => {
    const capture = sig({ psi: { memory: { some: { avg60: 11.15 }, full: { avg60: 8.17 } } } });
    const memory = evaluateMemoryPressure(capture, NOW);

    expect(evaluatePerfSignals(capture, NOW).memoryPressure).toEqual(memory);
    expect(memory).toMatchObject({
      pressure: 'crit',
      measuredAt: '2026-06-19T16:34:50Z',
      ageMs: 10_000,
      stale: false,
      psiMemorySome60: 11.15,
      psiMemoryFull60: 8.17,
      cgroupAttribution: null,
      thresholds: {
        source: 'PERF_BUDGETS',
        psiMemorySomeWarn: 10,
        psiMemoryFullCrit: 5,
        staleMs: 600_000,
        blindMs: 1_800_000,
      },
      unknown: [],
    });
  });

  it('preserves missing-leg unknowns alongside any band the measured leg establishes', () => {
    const missingFull = evaluateMemoryPressure(
      sig({ psi: { memory: { some: { avg60: 15 } } } }),
      NOW,
    );
    // `some` establishes at least the early-warning band even though the missing
    // `full` leg means a critical full-stall cannot be excluded.
    expect(missingFull.pressure).toBe('warn');
    expect(missingFull.unknown.map((u) => u.code)).toContain('psi-memory-full-unmeasured');

    const missingSome = evaluateMemoryPressure(
      sig({ psi: { memory: { full: { avg60: 1 } } } }),
      NOW,
    );
    expect(missingSome.pressure).toBeNull();
    expect(missingSome.unknown.map((u) => u.code)).toContain('psi-memory-some-unmeasured');
  });

  it('keeps stale critical-looking data unknown, with capture age and cause in-band', () => {
    const memory = evaluateMemoryPressure(
      sig(
        { psi: { memory: { some: { avg60: 50 }, full: { avg60: 25 } } } },
        { capturedAt: '2026-06-19T16:20:00Z' },
      ),
      NOW,
    );

    expect(memory.pressure).toBeNull();
    expect(memory.stale).toBe(true);
    expect(memory.ageMs).toBe(15 * 60_000);
    expect(memory.unknown.map((u) => u.code)).toContain('capture-stale');
    expect(memory.reasons).toEqual([]);
  });

  it('distinguishes an absent capture from a healthy zero', () => {
    const memory = evaluateMemoryPressure(null, NOW);
    expect(memory.pressure).toBeNull();
    expect(memory.measuredAt).toBeNull();
    expect(memory.psiMemorySome60).toBeNull();
    expect(memory.psiMemoryFull60).toBeNull();
    expect(memory.unknown).toEqual([
      { code: 'capture-absent', detail: 'no perf-signals-v1 capture was available' },
    ]);
  });

  // ── EI-21006730273601832: a live P2P-gate PSI-full page carried nothing beyond the
  // raw host number, so it read as "the box is low on memory" even while ~51 GiB was
  // available — the exact false attribution CLAUDE.md forbids. The crit/warn reason
  // must NAME the responsible cgroup when the capture attributed one, and say so
  // explicitly when it did not, rather than leaving a bare PSI reading to imply cause.
  describe('names the responsible cgroup in the reason, rather than only paging on host PSI', () => {
    const DEEP_PATH = '/user.slice/user@1000.service/app.slice/papercup-dev-api.service';
    const cgroupMemory = (): NonNullable<PerfSignalsV1['signals']['cgroupMemory']> => ({
      accounting: 'cgroup-v2-inclusive-descendants',
      partial: false,
      // `/user.slice` is an ANCESTOR of the deeper row below and therefore always the
      // larger of the two (cgroup-v2 accounting is inclusive of descendants) — pinning
      // it first proves the detector picks the more SPECIFIC row, not merely the
      // largest one, which would just re-name the same uninformative ancestor.
      top: [
        {
          path: '/user.slice',
          memoryBytes: 100 * 1024 ** 3,
          swapBytes: 20 * 1024 ** 3,
          anonBytes: null, fileBytes: null, shmemBytes: null, kernelBytes: null,
          slabBytes: null, sockBytes: null, directPids: 0,
        },
        {
          path: DEEP_PATH,
          memoryBytes: 40 * 1024 ** 3,
          swapBytes: 5 * 1024 ** 3,
          anonBytes: null, fileBytes: null, shmemBytes: null, kernelBytes: null,
          slabBytes: null, sockBytes: null, directPids: 17,
        },
      ],
      scannedCgroups: 2,
      candidateCgroups: 2,
      maxScanned: 4096,
      maxRows: 40,
      budgetSec: 5,
    });

    it('crit reason names the deepest attributed cgroup, not its coarser ancestor', () => {
      const memory = evaluateMemoryPressure(
        sig({ psi: { memory: { full: { avg60: 8.17 } } }, cgroupMemory: cgroupMemory() }),
        NOW,
      );
      expect(memory.pressure).toBe('crit');
      const reason = memory.reasons.join(' ');
      expect(reason).toContain(DEEP_PATH);
      expect(reason).not.toContain('100.00GB'); // the ancestor's size — it must lose to the leaf
      expect(reason).toMatch(/40\.00GB/);
      expect(reason).toMatch(/17 direct pid/);
    });

    it('warn reason also names the deepest attributed cgroup', () => {
      const memory = evaluateMemoryPressure(
        sig({ psi: { memory: { some: { avg60: 15 } } }, cgroupMemory: cgroupMemory() }),
        NOW,
      );
      expect(memory.pressure).toBe('warn');
      expect(memory.reasons.join(' ')).toContain(DEEP_PATH);
    });

    it('says explicitly that mechanism is unconfirmed when no cgroup attribution was captured', () => {
      const memory = evaluateMemoryPressure(
        sig({ psi: { memory: { full: { avg60: 8.17 } } } }),
        NOW,
      );
      expect(memory.pressure).toBe('crit');
      expect(memory.cgroupAttribution).toBeNull();
      expect(memory.reasons.join(' ')).toContain('mechanism unconfirmed');
      expect(memory.reasons.join(' ')).toContain('do not attribute to low free RAM');
    });

    it('the enriched cgroup-naming reason still flows through evaluatePerfSignals (the infra alarm)', () => {
      const v = evaluatePerfSignals(
        sig({ psi: { memory: { full: { avg60: 8.17 } } }, cgroupMemory: cgroupMemory() }),
        NOW,
      );
      expect(v.status).toBe('crit');
      expect(v.reasons.join(' ')).toContain(DEEP_PATH);
    });
  });
});

describe('evaluateRealBackendAdmission (real-backend matrix preflight)', () => {
  it('admits fresh complete ok and warn captures', () => {
    expect(evaluateRealBackendAdmission(sig({ psi: { memory: { some: { avg60: 1 }, full: { avg60: 0 } } } }), NOW)).toMatchObject({
      decision: 'admit',
      pressure: 'ok',
    });
    expect(evaluateRealBackendAdmission(sig({ psi: { memory: { some: { avg60: 15 }, full: { avg60: 1 } } } }), NOW)).toMatchObject({
      decision: 'admit',
      pressure: 'warn',
    });
  });

  it('blocks a fresh complete critical capture before a real backend can start', () => {
    const admission = evaluateRealBackendAdmission(
      sig({ psi: { memory: { some: { avg60: 15 }, full: { avg60: 8 } } } }),
      NOW,
    );
    expect(admission).toMatchObject({ decision: 'block', pressure: 'crit', ageMs: 10_000 });
    expect(admission.reason).toMatch(/PSI memory full avg60 8/);
    expect(admission.unknown).toEqual([]);
  });

  it.each([
    ['absent capture', null, NOW],
    ['stale capture', sig({ psi: { memory: { some: { avg60: 1 }, full: { avg60: 8 } } } }, { capturedAt: '2026-06-19T16:20:00Z' }), NOW],
    ['incomplete capture', sig({ psi: { memory: { full: { avg60: 8 } } } }), NOW],
  ])('returns not-measured for %s rather than blocking or admitting', (_label, capture, now) => {
    const admission = evaluateRealBackendAdmission(capture as PerfSignalsV1 | null, now);
    expect(admission.decision).toBe('not-measured');
    expect(admission.decision).not.toBe('block');
    expect(admission.reason).toMatch(/capture|PSI memory/i);
  });
});

describe('worstOwnedInotifyHolder (WI-6538 — scope the per-proc budget to OUR processes)', () => {
  const OURS = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-vite.service';
  const THEIRS = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/snap.code-1234.scope';

  it('picks our worst holder, ignoring a bigger third-party one', () => {
    // The real shape of the bug: VS Code out-watches everything we run, so the
    // unscoped check reported the editor and never our own watcher.
    const r = worstOwnedInotifyHolder([
      { pid: 1, comm: 'code', watches: 38_937, cgroup: THEIRS },
      { pid: 2, comm: 'node', watches: 1_048, cgroup: OURS },
    ]);
    expect(r).toEqual({
      attributable: true,
      worst: { pid: 2, comm: 'node', watches: 1_048, cgroup: OURS },
    });
  });

  it('picks the largest when we own several', () => {
    const r = worstOwnedInotifyHolder([
      { pid: 2, comm: 'node', watches: 1_048, cgroup: OURS },
      { pid: 3, comm: 'node', watches: 9_001, cgroup: OURS },
    ]);
    expect(r.attributable && r.worst?.pid).toBe(3);
  });

  it('reports a CONFIDENT "we own none" when ownership is known — must NOT fall back', () => {
    // This is the case that keeps the editor out of the gate: we can attribute, and
    // none of the holders are ours, so there is nothing to warn about.
    expect(
      worstOwnedInotifyHolder([{ pid: 1, comm: 'code', watches: 38_937, cgroup: THEIRS }]),
    ).toEqual({ attributable: true, worst: null });
  });

  it('reports NOT-attributable for a pre-WI-6538 capture with no cgroups', () => {
    // Must be distinguishable from "we own none" — the caller falls back to the
    // host-wide max here, so an old capture keeps checking something.
    expect(worstOwnedInotifyHolder([{ pid: 1, comm: 'node', watches: 50_000 }])).toEqual({
      attributable: false,
    });
  });

  it('reports NOT-attributable for empty / missing input', () => {
    expect(worstOwnedInotifyHolder([])).toEqual({ attributable: false });
    expect(worstOwnedInotifyHolder(null)).toEqual({ attributable: false });
    expect(worstOwnedInotifyHolder(undefined)).toEqual({ attributable: false });
  });

  it('treats a blank cgroup string as unattributable, not as "not ours"', () => {
    // An unreadable /proc/<pid>/cgroup yields "" — that is missing data, and silently
    // classifying it as third-party would hide our own balloon.
    expect(
      worstOwnedInotifyHolder([{ pid: 1, comm: 'node', watches: 50_000, cgroup: '' }]),
    ).toEqual({ attributable: false });
  });

  it('matches descendants of a papercup unit, not just the unit leader', () => {
    // Agent- and build-spawned children inherit the service cgroup; they are ours too.
    const child = `${OURS}/child-scope`;
    const r = worstOwnedInotifyHolder([{ pid: 9, comm: 'esbuild', watches: 12_000, cgroup: child }]);
    expect(r.attributable && r.worst?.pid).toBe(9);
  });
});

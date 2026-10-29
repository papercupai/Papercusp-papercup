import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateUnreachableTerminalGuard,
  terminalUnreachableMs,
  minStuckFiresForTermination,
  checkUnreachableTerminalGuard,
  DEFAULT_TERMINAL_UNREACHABLE_MS,
  DEFAULT_MIN_STUCK_FIRES,
  comatoseStuckFiresForTermination,
  DEFAULT_COMATOSE_STUCK_FIRES,
  comatoseWindowMs,
  DEFAULT_COMATOSE_WINDOW_MS,
  stuckBackstopCadenceMs,
} from './loop-unreachable-guard';
import type { WakeReachabilityVerdict } from '../../events/await/wake-reachability';

describe('evaluateUnreachableTerminalGuard (WI-1399 — pure decision)', () => {
  const base = { reachable: false, parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS + 1, intervalMs: 60_000, stuckFireCount: DEFAULT_MIN_STUCK_FIRES };

  it('reachable owner → never breaches, regardless of duration/fire-count', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, reachable: true, parkedForMs: 1e12, stuckFireCount: 1e6 });
    expect(v.breach).toBe(false);
    expect(v.reason).toBeUndefined();
  });

  it('unreachable but not yet past the terminal window → no breach', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS - 1 });
    expect(v.breach).toBe(false);
  });

  it('unreachable + past the window but under the minimum stuck-fire count → no breach', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, stuckFireCount: DEFAULT_MIN_STUCK_FIRES - 1 });
    expect(v.breach).toBe(false);
  });

  it('unreachable + past the window + at the minimum stuck-fire count → breaches with an explanatory reason', () => {
    const v = evaluateUnreachableTerminalGuard(base);
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('unreachable');
    expect(v.reason).toContain('WI-1399');
    expect(v.reason).toMatch(/\d+ consecutive stuck-backstop fires/);
  });

  it('a single blip (stuckFireCount=1) never breaches at the default minimum', () => {
    const v = evaluateUnreachableTerminalGuard({ ...base, stuckFireCount: 1 });
    expect(v.breach).toBe(false);
  });
});

describe('evaluateUnreachableTerminalGuard — circuit-open fast path (EI-7006 Route A/C)', () => {
  it('circuit-open + unreachable + ≥min-fires → breaches even with parkedForMs FAR below the 2h dwell window', () => {
    // parkedForMs=1s is nowhere near the 2h floor — the classic path would NOT breach here. The
    // whole point of the fix: a circuit-open dead loop terminates without waiting out a dwell window
    // the hourly circuit probe never lets `parkedForMs` reach.
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 8,
      circuitOpen: true,
    });
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('circuit-open');
    expect(v.reason).toContain('WI-1399');
    expect(v.reason).toContain('EI-7006');
  });

  it('circuit-open still respects reachability — a reachable owner never breaches below the comatose floor (healthy long turn protected)', () => {
    // WI-6639 narrowed this the same way as the durableWhileAlive:true case below: the
    // reachability veto is no longer unbounded in the streak dimension. It still fully protects
    // the healthy long turn this test is about (which settles and resets the streak to 0), but a
    // streak past `comatoseStuckFiresForTermination()` is no longer vetoed. Asserted at 999
    // before; the healthy-long-turn intent is preserved by pinning just under the floor.
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: comatoseStuckFiresForTermination() - 1,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });

  it('circuit-open still respects the min-fires floor', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 1,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });

  it('the classic (circuit-closed) path is byte-unchanged — the dwell window is still enforced', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 8,
      circuitOpen: false, // window NOT decoupled → 1s << 2h → no breach
    });
    expect(v.breach).toBe(false);
  });
});

describe('evaluateUnreachableTerminalGuard — WI-2339 resumable-DEAD (a `resume`-only reachability no longer vetoes a circuit-open loop)', () => {
  it('resumable-dead: reachable:true via resume (durableWhileAlive:false) + circuit OPEN + ≥min-fires → BREACHES (the su-95cf8308 case)', () => {
    // The probe reports reachable:true (channel `resume`) for an ended+resumable session, but its
    // resume turns keep failing → circuit open. That failure streak overrides the dry-run optimism.
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: false,
      parkedForMs: 1000, // circuit-open decouples the dwell window
      intervalMs: 60_000,
      stuckFireCount: 8,
      circuitOpen: true,
    });
    expect(v.breach).toBe(true);
    expect(v.reason).toMatch(/resumable-dead/i);
    expect(v.reason).toContain('WI-2339');
    expect(v.reason).toContain('WI-1399');
  });

  it('a HEALTHY resumable loop between turns (resume reachable, circuit CLOSED) is NEVER terminated — even parked well past the window', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: false,
      parkedForMs: 1e12,
      intervalMs: 60_000,
      stuckFireCount: 999,
      circuitOpen: false, // its resume turns settle → recordFire('ok') → circuit never opens
    });
    expect(v.breach).toBe(false);
  });

  it('a genuinely LIVE injectable owner (durableWhileAlive:true) stays protected with an OPEN circuit, below the comatose floor', () => {
    // WI-6639 NARROWED this invariant. It used to read "…protected even with an OPEN circuit",
    // asserted at stuckFireCount:999 — i.e. a live injectable channel vetoed termination
    // UNCONDITIONALLY AND FOREVER. Measured live 2026-07-28 that absolute form was wrong (see the
    // comatose-host describe below). The protection is real but is no longer unbounded: it holds
    // for any streak below `comatoseStuckFiresForTermination()`, which is what this now pins.
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: true, // psu-socket / managed-pty — a live host
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: comatoseStuckFiresForTermination() - 1,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });

  it('resumable-dead still respects the min-fires floor (a short streak never terminates)', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: false,
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: 1,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });

  it('backward-compat: an omitted durableWhileAlive is treated as durable/protected (pre-WI-2339 veto preserved)', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      // durableWhileAlive omitted
      parkedForMs: 1000,
      intervalMs: 60_000,
      stuckFireCount: comatoseStuckFiresForTermination() - 1,
      circuitOpen: true,
    });
    expect(v.breach).toBe(false);
  });
});

describe('evaluateUnreachableTerminalGuard — WI-6639 COMATOSE-HOST (a live injectable channel whose agent is wedged)', () => {
  // Measured live 2026-07-28 (WI-6639): 12 cold loops whose psu-pty-host AND its `claude` child
  // were BOTH genuinely alive (6-11d uptime, real listening socket — not the WI-2339 recycled-pid
  // false positive) had settled ZERO turns in 7d across 157 fires. `reachable:true` +
  // `durableWhileAlive:true` short-circuited every death signal, so they re-armed and re-fired
  // every ~30min forever and could never be auto-paused.
  it('live injectable + circuit OPEN + streak AT the comatose floor → BREACHES (the wedged-agent case)', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: true,
      parkedForMs: 1000, // the re-arm resets last_fired_at, so dwell can never accumulate here
      intervalMs: 60_000,
      stuckFireCount: comatoseStuckFiresForTermination(),
      circuitOpen: true,
    });
    expect(v.breach).toBe(true);
    expect(v.reason).toMatch(/comatose-host/i);
    expect(v.reason).toContain('WI-6639');
  });

  it('the comatose floor requires an OPEN circuit — a huge streak with a CLOSED circuit never terminates a live owner', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: true,
      parkedForMs: 1e12,
      intervalMs: 60_000,
      stuckFireCount: comatoseStuckFiresForTermination() * 10,
      circuitOpen: false,
    });
    expect(v.breach).toBe(false);
  });

  it('the comatose floor sits far above the ordinary min-fires floor (a slow live turn is never caught by it)', () => {
    expect(comatoseStuckFiresForTermination()).toBeGreaterThanOrEqual(minStuckFiresForTermination() * 3);
    expect(comatoseStuckFiresForTermination()).toBe(DEFAULT_COMATOSE_STUCK_FIRES);
  });

  it('an operator cannot tune the comatose floor into a hair-trigger (clamped to 3× min-fires)', () => {
    const orig = process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES;
    process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES = '1';
    try {
      expect(comatoseStuckFiresForTermination()).toBe(minStuckFiresForTermination() * 3);
    } finally {
      if (orig === undefined) delete process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES;
      else process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES = orig;
    }
  });

  // ---- WI-6660: the budget is a WALL CLOCK, and the fire count is DERIVED from it -------------
  // The floor used to be a flat 24 fires described as "~12h at the ~30min cadence". But the
  // streak advances once per max(30min, interval*4), so a fixed count meant the real wall-clock
  // scaled with the interval: measured across the live stranded population it ran 12h (180s
  // loops) to 88h (3300s loops). These pin the derived-count behaviour in both directions.

  it('the derived count still yields exactly the documented 24 at the 30-min cadence floor', () => {
    // Short-interval loops are the case the old constant was calibrated for — unchanged.
    expect(comatoseStuckFiresForTermination(180_000)).toBe(DEFAULT_COMATOSE_STUCK_FIRES);
    expect(comatoseStuckFiresForTermination(180_000)).toBe(24);
  });

  it('a LONG-interval loop needs FEWER fires, because each one costs more wall-clock', () => {
    // 3300s interval → cadence max(30min, 220min) = 220min → ceil(12h / 220min) = 4.
    // Under the old flat 24 this loop needed 24 × 220min ≈ 88h (3.7 days) to auto-pause.
    expect(comatoseStuckFiresForTermination(3_300_000)).toBe(4);
    expect(comatoseStuckFiresForTermination(1_800_000)).toBe(6); // 120min cadence → 6 × 120min = 12h
    expect(comatoseStuckFiresForTermination(600_000)).toBe(18); // 40min cadence → 18 × 40min = 12h
  });

  it('every interval lands within ~one cadence of the 12h budget (the property the count could not hold)', () => {
    for (const intervalMs of [60_000, 180_000, 600_000, 1_200_000, 1_500_000, 1_800_000, 2_400_000, 3_300_000]) {
      const fires = comatoseStuckFiresForTermination(intervalMs);
      const cadence = stuckBackstopCadenceMs(intervalMs);
      const wallClockMs = fires * cadence;
      expect(wallClockMs).toBeGreaterThanOrEqual(DEFAULT_COMATOSE_WINDOW_MS);
      // ...and never overshoots by more than a single cadence step (the ceil remainder).
      expect(wallClockMs - DEFAULT_COMATOSE_WINDOW_MS).toBeLessThan(cadence);
    }
  });

  it('never derives a count below the ordinary min-fires floor (no hair-trigger from a huge interval)', () => {
    // A 24h-interval loop would need <1 fire to "cover" 12h; the min-fires floor still applies.
    expect(comatoseStuckFiresForTermination(86_400_000)).toBeGreaterThanOrEqual(minStuckFiresForTermination());
  });

  it('a long-interval loop STILL breaches only with an open circuit — which binds harder than the window', () => {
    // The reason shortening the long tail is safe: circuitOpen needs ≥circuitThreshold (8)
    // consecutive failures, so at a 220min cadence this population waits ~29h regardless.
    const atDerivedFloor = comatoseStuckFiresForTermination(3_300_000); // 4
    const v = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: true,
      parkedForMs: 1000,
      intervalMs: 3_300_000,
      stuckFireCount: atDerivedFloor,
      circuitOpen: false,
    });
    expect(v.breach).toBe(false);

    const open = evaluateUnreachableTerminalGuard({
      reachable: true,
      durableWhileAlive: true,
      parkedForMs: 1000,
      intervalMs: 3_300_000,
      stuckFireCount: atDerivedFloor,
      circuitOpen: true,
    });
    expect(open.breach).toBe(true);
    expect(open.reason).toMatch(/comatose-host/i);
  });

  it('the explicit fire-count env override still wins, and is still clamped', () => {
    const orig = process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES;
    process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES = '40';
    try {
      // Overrides the derived value for EVERY interval, short or long.
      expect(comatoseStuckFiresForTermination(180_000)).toBe(40);
      expect(comatoseStuckFiresForTermination(3_300_000)).toBe(40);
    } finally {
      if (orig === undefined) delete process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES;
      else process.env.PAPERCUSP_LOOP_COMATOSE_STUCK_FIRES = orig;
    }
  });

  it('the wall-clock window is env-overridable and re-derives the count', () => {
    const orig = process.env.PAPERCUSP_LOOP_COMATOSE_WINDOW_MS;
    process.env.PAPERCUSP_LOOP_COMATOSE_WINDOW_MS = String(6 * 3600_000); // 6h
    try {
      expect(comatoseWindowMs()).toBe(6 * 3600_000);
      expect(comatoseStuckFiresForTermination(180_000)).toBe(12); // 6h / 30min
    } finally {
      if (orig === undefined) delete process.env.PAPERCUSP_LOOP_COMATOSE_WINDOW_MS;
      else process.env.PAPERCUSP_LOOP_COMATOSE_WINDOW_MS = orig;
    }
  });

  it('an UNREACHABLE owner is unaffected by the comatose leg (classic dwell path still governs)', () => {
    const v = evaluateUnreachableTerminalGuard({
      reachable: false,
      parkedForMs: 1000, // below the dwell window
      intervalMs: 60_000,
      stuckFireCount: comatoseStuckFiresForTermination(),
      circuitOpen: false, // dwell NOT decoupled → still no breach
    });
    expect(v.breach).toBe(false);
  });
});

describe('terminalUnreachableMs / minStuckFiresForTermination — env overrides + floors', () => {
  const ORIG_TERMINAL_MS = process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS;
  const ORIG_MIN_FIRES = process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES;

  beforeEach(() => {
    delete process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS;
    delete process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES;
  });
  afterEach(() => {
    if (ORIG_TERMINAL_MS === undefined) delete process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS;
    else process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS = ORIG_TERMINAL_MS;
    if (ORIG_MIN_FIRES === undefined) delete process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES;
    else process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES = ORIG_MIN_FIRES;
  });

  it('defaults to the 2h constant when no env override and interval is small', () => {
    expect(terminalUnreachableMs(60_000)).toBe(DEFAULT_TERMINAL_UNREACHABLE_MS);
  });

  it('floors at 8× a large interval even with the default base', () => {
    const bigIntervalMs = 2_000_000_000; // ~23 days — 8x dwarfs the 2h default
    expect(terminalUnreachableMs(bigIntervalMs)).toBe(bigIntervalMs * 8);
  });

  it('respects a positive env override (still floored at 8×interval)', () => {
    process.env.PAPERCUSP_LOOP_TERMINAL_UNREACHABLE_MS = String(10 * 3600_000);
    expect(terminalUnreachableMs(60_000)).toBe(10 * 3600_000);
  });

  it('minStuckFiresForTermination defaults to DEFAULT_MIN_STUCK_FIRES and respects env override', () => {
    expect(minStuckFiresForTermination()).toBe(DEFAULT_MIN_STUCK_FIRES);
    process.env.PAPERCUSP_LOOP_TERMINAL_MIN_STUCK_FIRES = '5';
    expect(minStuckFiresForTermination()).toBe(5);
  });
});

function verdict(reachable: boolean): WakeReachabilityVerdict {
  return {
    reachable,
    channel: reachable ? 'psu-socket' : 'none',
    durableWhileAlive: reachable,
    summary: reachable ? 'live' : 'dead',
    // WI-36685: `false` is the right unreachable shape for THIS guard's fixtures — they model a
    // genuinely dead owner, not one whose only fault is a missing standing await.
    awaitRepairable: false,
    wouldBeChannel: null,
  };
}

/** WI-2339: an ended+resumable session — reachable via `claude --resume` but NOT durable-while-alive. */
function resumeVerdict(): WakeReachabilityVerdict {
  return {
    reachable: true,
    channel: 'resume',
    durableWhileAlive: false,
    summary: 'resumable',
    awaitRepairable: false,
    wouldBeChannel: null,
  };
}

describe('checkUnreachableTerminalGuard (WI-1399 — IO wrapper)', () => {
  const input = {
    sql: {} as never,
    routineId: 'rt-1',
    targetOwnerId: 'su-dead',
    parkedForMs: DEFAULT_TERMINAL_UNREACHABLE_MS + 1,
    intervalMs: 60_000,
    stuckFireCount: DEFAULT_MIN_STUCK_FIRES,
  };

  it('auto-pauses when the probe reports unreachable and the pure decision breaches', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(false));
    const res = await checkUnreachableTerminalGuard(input, { autoPause, probeReachability });
    expect(res.breach).toBe(true);
    expect(res.reason).toContain('WI-1399');
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(input.sql, 'rt-1', expect.stringContaining('WI-1399'));
    expect(probeReachability).toHaveBeenCalledWith('su-dead');
  });

  it('does NOT auto-pause when the probe reports reachable', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(true));
    const res = await checkUnreachableTerminalGuard(input, { autoPause, probeReachability });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('does NOT auto-pause while under the terminal window even if unreachable', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(false));
    const res = await checkUnreachableTerminalGuard({ ...input, parkedForMs: 1000 }, { autoPause, probeReachability });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('circuit-open path (EI-7006): auto-pauses an unreachable owner even UNDER the dwell window', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(false));
    const res = await checkUnreachableTerminalGuard(
      { ...input, parkedForMs: 1000, circuitOpen: true },
      { autoPause, probeReachability },
    );
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(input.sql, 'rt-1', expect.stringContaining('circuit-open'));
  });

  it.each(['active-inference', 'native-operation'] as const)(
    'COMATOSE-HOST: a fresh %s lease protects the live carry successor from auto-pause',
    async reason => {
      const autoPause = vi.fn(async () => {});
      const probeReachability = vi.fn(async () => verdict(true));
      const recoverCurrentExecution = vi.fn(async () => ({
        handled: true as const,
        state: {
          status: 'running' as const,
          reason,
          attempts: 0,
          probes: 0,
          nextProbeAt: Date.now() + 30_000,
          observedAt: Date.now(),
          generation: 'host:2:child:3',
          lastAttemptAt: null,
        },
      }));

      const res = await checkUnreachableTerminalGuard(
        { ...input, circuitOpen: true, stuckFireCount: comatoseStuckFiresForTermination() },
        { autoPause, probeReachability, recoverCurrentExecution },
      );

      expect(res).toMatchObject({ breach: false, reason: `current-execution-active:${reason}` });
      expect(recoverCurrentExecution).toHaveBeenCalledWith(expect.objectContaining({
        sql: input.sql,
        routineId: input.routineId,
        ownerId: input.targetOwnerId,
        dryRun: true,
        resetVerifiedSuccessorStreak: true,
      }));
      expect(autoPause).not.toHaveBeenCalled();
    },
  );

  it('COMATOSE-HOST: unavailable execution evidence fails open instead of removing wake reachability', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(true));
    const recoverCurrentExecution = vi.fn(async () => { throw new Error('execution observer unavailable'); });

    const res = await checkUnreachableTerminalGuard(
      { ...input, circuitOpen: true, stuckFireCount: comatoseStuckFiresForTermination() },
      { autoPause, probeReachability, recoverCurrentExecution },
    );

    expect(res).toMatchObject({ breach: false, reason: 'current-execution-recovery-unavailable' });
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('COMATOSE-HOST still pauses after a live host has no current native execution', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => verdict(true));
    const recoverCurrentExecution = vi.fn(async () => ({ handled: false as const }));

    const res = await checkUnreachableTerminalGuard(
      { ...input, circuitOpen: true, stuckFireCount: comatoseStuckFiresForTermination() },
      { autoPause, probeReachability, recoverCurrentExecution },
    );

    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('fail-soft: a reachability probe error never throws and never pauses', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await checkUnreachableTerminalGuard(input, { autoPause, probeReachability });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('WI-2339 resumable-dead: a `resume` verdict (reachable but not durable) + OPEN circuit auto-pauses', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => resumeVerdict());
    const res = await checkUnreachableTerminalGuard(
      { ...input, parkedForMs: 1000, circuitOpen: true },
      { autoPause, probeReachability },
    );
    expect(res.breach).toBe(true);
    expect(res.reason).toMatch(/resumable-dead/i);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(input.sql, 'rt-1', expect.stringContaining('WI-2339'));
  });

  it('WI-2339: a `resume` verdict with a CLOSED circuit (healthy resumable loop) does NOT pause', async () => {
    const autoPause = vi.fn(async () => {});
    const probeReachability = vi.fn(async () => resumeVerdict());
    const res = await checkUnreachableTerminalGuard(
      { ...input, parkedForMs: 1e12, circuitOpen: false },
      { autoPause, probeReachability },
    );
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });
});

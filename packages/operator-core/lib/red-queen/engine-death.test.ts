/**
 * engine-death.test.ts — the out-of-band routine-engine-death detector
 * (self-learning-frontier P-031 / FB-20, the 06-12 DBOS incident class).
 *
 * Pins the incident signature exactly as the insight runbook states it: ALL
 * active routines overdue at once = engine dead; one stale row = that
 * routine's own problem; a quiet box (too few active routines) never alarms.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PARKED_NEXT_FIRE_MS,
  detectRoutineEngineDeath,
  engineDeathDrillCollector,
  engineDeathSignal,
  runEngineDeathSentinelPass,
  type EngineDeathSentinelDeps,
  type RoutineLivenessRow,
} from './engine-death';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const row = (name: string, nextFireAt: string | null, active = true): RoutineLivenessRow => ({ name, active, nextFireAt });

describe('detectRoutineEngineDeath (the 06-12 incident signature)', () => {
  it('ALL active routines overdue past grace ⇒ dead', () => {
    const v = detectRoutineEngineDeath(
      [row('git-sync', minsAgo(80)), row('watchdog', minsAgo(45)), row('release', minsAgo(30))],
      NOW,
    );
    expect(v.dead).toBe(true);
    expect(v.overdueCount).toBe(3);
    expect(v.oldestOverdueMinutes).toBe(80);
  });

  it('ONE routine inside its window ⇒ alive (a stale row is that routine\'s own problem)', () => {
    const v = detectRoutineEngineDeath(
      [row('git-sync', minsAgo(80)), row('watchdog', minsAgo(45)), row('release', minsAgo(2))],
      NOW,
    );
    expect(v.dead).toBe(false);
    expect(v.reason).toContain('release');
  });

  it('a future next_fire_at counts as alive', () => {
    const v = detectRoutineEngineDeath(
      [row('a', minsAgo(80)), row('b', minsAgo(45)), row('c', new Date(NOW + 60_000).toISOString())],
      NOW,
    );
    expect(v.dead).toBe(false);
  });

  it('too few active routines ⇒ never dead (quiet box ≠ dead engine)', () => {
    const v = detectRoutineEngineDeath([row('a', minsAgo(80)), row('b', minsAgo(70))], NOW);
    expect(v.dead).toBe(false);
    expect(v.reason).toContain('too few');
  });

  it('inactive rows and unparseable next_fire_at are excluded from the evidence', () => {
    const v = detectRoutineEngineDeath(
      [
        row('a', minsAgo(80)),
        row('b', minsAgo(70)),
        row('c', minsAgo(60)),
        row('inactive', minsAgo(500), false),
        row('no-fire', null),
      ],
      NOW,
    );
    // Every PROVABLE active routine (3 ≥ the floor) is overdue ⇒ dead. The
    // inactive row and the null-next_fire_at row prove nothing either way and
    // must neither block detection nor count toward it.
    expect(v.dead).toBe(true);
    expect(v.overdueCount).toBe(3);
  });

  it('grace window respected — overdue inside grace is alive', () => {
    const rows = [row('a', minsAgo(5)), row('b', minsAgo(6)), row('c', minsAgo(7))];
    expect(detectRoutineEngineDeath(rows, NOW, { graceMinutes: 10 }).dead).toBe(false);
    expect(detectRoutineEngineDeath(rows, NOW, { graceMinutes: 2 }).dead).toBe(true);
  });

  /**
   * A PARKED LOOP (next_fire_at = 'infinity') must never vouch for the engine.
   *
   * The detector used to be correct only by accident of the transport:
   * readRoutineLivenessRows issues a RAW query, so postgres-js hands 'infinity' back as
   * an INVALID Date and the isFinite skip excluded it. Route the same rows through
   * rowToRoutine — the obvious cleanup, since that mapper exists to make 'infinity' safe
   * for JS readers — and a parked loop becomes a VALID max-Date that reads as "inside its
   * fire window", short-circuiting the scan on the FIRST one. papercusp-workspace carries
   * 11 parked loops live, so that cleanup would have blinded the sentinel on precisely the
   * outage it exists to catch. These pin the property against BOTH wire forms.
   */
  describe('a parked loop cannot vouch for a dead engine (either wire form)', () => {
    const deadPeers = [row('git-sync', minsAgo(80)), row('green-checkpoint', minsAgo(45)), row('deploy', minsAgo(30))];

    it('PARKED_NEXT_FIRE_MS has not drifted from the real NEXT_FIRE_PARKED sentinel', async () => {
      const { NEXT_FIRE_PARKED } = await import('@papercusp/db-org');
      expect(PARKED_NEXT_FIRE_MS).toBe(NEXT_FIRE_PARKED.getTime());
      // The trap only exists because the mapped form is a VALID Date — if this ever
      // became NaN the mapper would be excluding it already and this guard is moot.
      expect(Number.isNaN(NEXT_FIRE_PARKED.getTime())).toBe(false);
    });

    it('RAW form (postgres-js Invalid Date) ⇒ still dead', () => {
      const v = detectRoutineEngineDeath([...deadPeers, { name: 'loop-su-a', active: true, nextFireAt: new Date('infinity') }], NOW);
      expect(v.dead).toBe(true);
      expect(v.overdueCount).toBe(3);
    });

    it('MAPPED form (NEXT_FIRE_PARKED, a valid max-Date) ⇒ still dead — the blinding case', () => {
      const parked = new Date(PARKED_NEXT_FIRE_MS);
      const v = detectRoutineEngineDeath([...deadPeers, { name: 'loop-su-a', active: true, nextFireAt: parked }], NOW);
      expect(v.dead).toBe(true);
      expect(v.reason).not.toContain('engine alive');
      expect(v.overdueCount).toBe(3);
    });

    it('verdict is ORDER-INDEPENDENT — a parked row FIRST does not collapse the overdue count', () => {
      const parked = { name: 'loop-su-a', active: true, nextFireAt: new Date(PARKED_NEXT_FIRE_MS) };
      const v = detectRoutineEngineDeath([parked, ...deadPeers], NOW);
      expect(v.dead).toBe(true);
      expect(v.overdueCount).toBe(3);
    });

    /**
     * FALSIFIABILITY CONTROL (repo rule: a guard test that has never failed is a guard
     * you have not tested — and proving it by mutating the shared tree is forbidden here,
     * so the wrong implementation lives permanently in the test instead).
     *
     * This replicates the PRE-FIX scan — identical but for the missing parked skip — and
     * asserts it DOES exhibit the blinding. If a future refactor makes the guard vacuous,
     * the three cases above would keep passing for the wrong reason; this one would not.
     */
    it('CONTROL: the same fixtures DO blind a scan without the parked skip', () => {
      const withoutParkedGuard = (rows: RoutineLivenessRow[], nowMs: number) => {
        for (const r of rows.filter((x) => x.active)) {
          const at = r.nextFireAt instanceof Date ? r.nextFireAt.getTime() : Date.parse(String(r.nextFireAt));
          if (!Number.isFinite(at)) continue;
          if (nowMs - at <= 10 * 60_000) return `engine alive (vouched by ${r.name})`;
        }
        return 'dead';
      };
      const parked = { name: 'loop-su-a', active: true, nextFireAt: new Date(PARKED_NEXT_FIRE_MS) };
      // Same input the real detector calls dead above — the old rule calls it alive.
      expect(withoutParkedGuard([parked, ...deadPeers], NOW)).toContain('engine alive');
      expect(detectRoutineEngineDeath([parked, ...deadPeers], NOW).dead).toBe(true);
    });

    it('CONTROL: parked loops alone never CAUSE a dead verdict (they prove nothing either way)', () => {
      const parkedOnly = ['loop-a', 'loop-b', 'loop-c', 'loop-d'].map((name) => ({
        name,
        active: true,
        nextFireAt: new Date(PARKED_NEXT_FIRE_MS),
      }));
      const v = detectRoutineEngineDeath(parkedOnly, NOW);
      expect(v.dead).toBe(false);
      expect(v.overdueCount).toBe(0);
    });
  });
});

describe('engineDeathSignal', () => {
  const verdict = { dead: true, activeCount: 3, overdueCount: 3, oldestOverdueMinutes: 80, reason: 'ALL 3 overdue' };

  it('builds the critical out-of-band signal with the runbook pointer', () => {
    const s = engineDeathSignal(verdict, { key: 'engine:live' });
    expect(s.source).toBe('routine-engine-death');
    expect(s.severity).toBe('critical');
    expect(s.kind).toBe('bug');
    expect(s.body).toContain('esm-dirname-tsx-file-mode-dbos-stall');
    expect(s.origin).toBeUndefined();
  });

  it('stamps drill origin + sandbox scope when asked (the drill leg)', () => {
    const s = engineDeathSignal(verdict, { key: 'engine:sb', origin: 'drill', captureScope: 'operator' });
    expect(s.origin).toBe('drill');
    expect(s.scope).toBe('operator');
  });
});

describe('engineDeathDrillCollector (the sandbox drill leg)', () => {
  it('a dead snapshot yields ONE origin=drill signal', async () => {
    const snapshot = [row('a', minsAgo(80)), row('b', minsAgo(70)), row('c', minsAgo(60))];
    const res = await engineDeathDrillCollector(snapshot, NOW).collect();
    const signals = Array.isArray(res) ? res : res.signals;
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('drill');
    expect(signals[0].scope).toBe('operator');
  });

  it('a healed snapshot yields nothing, with the verdict as the note', async () => {
    const future = new Date(NOW + 5 * 60_000).toISOString();
    const res = await engineDeathDrillCollector([row('a', future), row('b', future), row('c', future)], NOW).collect();
    expect(Array.isArray(res)).toBe(false);
    if (!Array.isArray(res)) {
      expect(res.signals).toHaveLength(0);
      expect(res.note).toBeTruthy();
    }
  });
});

describe('runEngineDeathSentinelPass (the live out-of-band leg)', () => {
  const captured: CaptureImprovementResult = {
    ok: true,
    created: true,
    issue: { id: 'iss-1' } as never,
    possibleDuplicates: [],
  };

  function deps(over: Partial<EngineDeathSentinelDeps> = {}) {
    const capture = vi.fn(async (..._args: unknown[]) => captured);
    const readRows = vi.fn(async () => [row('a', minsAgo(80)), row('b', minsAgo(70)), row('c', minsAgo(60))]);
    const d: EngineDeathSentinelDeps = {
      isArmed: async () => true,
      readRows,
      capture: capture as never,
      log: () => {},
      ...over,
    };
    return { d, capture, readRows };
  }

  it('dark (flag OFF) ⇒ zero PG reads, zero captures', async () => {
    const { d, capture, readRows } = deps({ isArmed: async () => false });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.checked).toBe(false);
    expect(readRows).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('armed + alive ⇒ checks but never captures', async () => {
    const { d, capture } = deps({
      readRows: async () => [row('a', minsAgo(1)), row('b', minsAgo(2)), row('c', minsAgo(3))],
    });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.checked).toBe(true);
    expect(res.verdict?.dead).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('armed + dead ⇒ files ONE ORGANIC capture keyed for cross-pass dedup', async () => {
    const { d, capture } = deps();
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.captured).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const input = capture.mock.calls[0][0] as Record<string, unknown>;
    expect(input.watchdogKey).toBe('routine-engine-death:engine:live');
    expect(input.dedupScope).toBe('open');
    expect(input.severity).toBe('critical');
    // The live sentinel is an availability monitor — its signal is ORGANIC.
    expect('origin' in input).toBe(false);
  });

  it('a recent global routine claim timestamp does not suppress a stale completed-tick signal', async () => {
    const hasRecentGlobalRoutineClaim = vi.fn(async () => true);
    const readRoutineEngineLiveness = vi.fn(async () => ({
      stale: true,
      unknown: false,
      lastTickMs: NOW - 7 * 60_000,
      staleMs: 7 * 60_000,
    }));
    const { d, capture } = deps({ hasRecentGlobalRoutineClaim, readRoutineEngineLiveness });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);

    expect(res.verdict?.dead).toBe(true);
    expect(res.schedulerLivenessProven).toBeUndefined();
    expect(res.captured).toBe(true);
    expect(hasRecentGlobalRoutineClaim).toHaveBeenCalledWith(10 * 60_000);
    expect(readRoutineEngineLiveness).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a recently completed routinesTick suppresses engine-death when admission held routine dispatches', async () => {
    const logs: string[] = [];
    const readRoutineEngineLiveness = vi.fn(async () => ({
      stale: false,
      unknown: false,
      lastTickMs: NOW - 3_000,
      staleMs: 3_000,
    }));
    const { d, capture } = deps({ readRoutineEngineLiveness, log: (message) => logs.push(message) });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);

    expect(res.verdict?.dead).toBe(true);
    expect(res.schedulerLivenessProven).toBe(true);
    expect(res.captured).toBeUndefined();
    expect(readRoutineEngineLiveness).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(logs.some((message) => message.includes('scheduler alive; not filing'))).toBe(true);
  });

  it('a stale routinesTick does not suppress a genuine engine-death capture', async () => {
    const readRoutineEngineLiveness = vi.fn(async () => ({
      stale: true,
      unknown: false,
      lastTickMs: NOW - 7 * 60_000,
      staleMs: 7 * 60_000,
    }));
    const { d, capture } = deps({ readRoutineEngineLiveness });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);

    expect(res.captured).toBe(true);
    expect(res.schedulerLivenessProven).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a failed host-global liveness read is UNKNOWN and never suppresses a real capture', async () => {
    const logs: string[] = [];
    const { d, capture } = deps({
      hasRecentGlobalRoutineClaim: async () => { throw new Error('claim timestamp read failed'); },
      log: (m) => logs.push(m),
    });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);

    expect(res.captured).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('UNKNOWN does not suppress'))).toBe(true);
  });

  it('an UNKNOWN routinesTick read does not suppress a real capture', async () => {
    const logs: string[] = [];
    const { d, capture } = deps({
      readRoutineEngineLiveness: async () => ({
        stale: false,
        unknown: true,
        lastTickMs: null,
        staleMs: null,
      }),
      log: (message) => logs.push(message),
    });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);

    expect(res.captured).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(logs.some((message) => message.includes('UNKNOWN does not suppress'))).toBe(true);
    const input = capture.mock.calls[0][0] as Record<string, unknown>;
    expect(input.body).toContain('routinesTick=UNKNOWN');
    expect(input.body).toContain(`sentinelPid=${process.pid}`);
    expect(logs.some((message) => message.includes('routinesTick=UNKNOWN'))).toBe(true);
  });

  it('never throws — a read failure is a logged skip', async () => {
    const logs: string[] = [];
    const { d } = deps({
      readRows: async () => { throw new Error('pg down'); },
      log: (m) => logs.push(m),
    });
    const res = await runEngineDeathSentinelPass(d, {}, NOW);
    expect(res.checked).toBe(false);
    expect(logs.some((l) => l.includes('pg down'))).toBe(true);
  });

  describe('WI-5456 ask 2: hasPoolShedInWindow cross-check', () => {
    it('dead verdict + a pool-shed event in-window ⇒ shedExplained, no capture filed', async () => {
      const logs: string[] = [];
      const hasPoolShedInWindow = vi.fn(async () => true);
      const { d, capture } = deps({ hasPoolShedInWindow, workspaceId: () => 'ws-1', log: (m) => logs.push(m) });
      const res = await runEngineDeathSentinelPass(d, {}, NOW);
      expect(res.checked).toBe(true);
      expect(res.shedExplained).toBe(true);
      expect(res.captured).toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
      // correlation window = oldestOverdueMinutes (80) + default grace (10) = 90min
      expect(hasPoolShedInWindow).toHaveBeenCalledWith('ws-1', 90 * 60_000);
      expect(logs.some((l) => l.includes('paused-by-guardrail'))).toBe(true);
    });

    it('dead verdict + no pool-shed event in-window ⇒ still files the capture', async () => {
      const hasPoolShedInWindow = vi.fn(async () => false);
      const { d, capture } = deps({ hasPoolShedInWindow });
      const res = await runEngineDeathSentinelPass(d, {}, NOW);
      expect(res.captured).toBe(true);
      expect(res.shedExplained).toBeUndefined();
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('deps without hasPoolShedInWindow ⇒ unchanged behavior (files on dead, per the pre-existing tests above)', async () => {
      const { d, capture } = deps();
      expect(d.hasPoolShedInWindow).toBeUndefined();
      const res = await runEngineDeathSentinelPass(d, {}, NOW);
      expect(res.captured).toBe(true);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('uses deps.workspaceId() when provided, else falls back to activeWorkspaceId()', async () => {
      const hasPoolShedInWindow = vi.fn(async () => true);
      const { d } = deps({ hasPoolShedInWindow, workspaceId: () => 'ws-custom' });
      await runEngineDeathSentinelPass(d, {}, NOW);
      expect(hasPoolShedInWindow).toHaveBeenCalledWith('ws-custom', expect.any(Number));
    });
  });
});

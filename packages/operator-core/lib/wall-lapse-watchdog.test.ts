/**
 * wall-lapse-watchdog.test.ts — EI-18669544162414270: an owner-gated WALL fact
 * whose TTL lapses unretracted must PAGE, not silently vanish from folds. The
 * pure alert formatter + the sweep's orchestration (debounce, fail-soft) via
 * injected deps — no PG (same discrimination bar as rubric-staleness-watchdog).
 */
import { describe, expect, it, vi } from 'vitest';

import { formatWallLapseAlert, wallLapseSweep } from './wall-lapse-watchdog';
import type { LapsedWallFact } from './agent-facts/store';

const NOW = Date.parse('2026-07-26T00:00:00.000Z');

const fact = (over: Partial<LapsedWallFact> = {}): LapsedWallFact => ({
  workspaceId: 'default',
  scope: 'harness',
  scopeRef: 'papercusp',
  key: 'wall:mac-vm-creds-public-leak-owner-rotation',
  body: '⚠ WALL (owner-gated) — absence ≠ resolved: mac VM creds are public, rotation pending.',
  createdBy: 'su-abc',
  expiresAt: '2026-07-20T18:39:55.000Z',
  ...over,
});

describe('formatWallLapseAlert — the pure formatter', () => {
  it('names the fact key, the elapsed days, and warns absence ≠ resolved', () => {
    const { summary, body } = formatWallLapseAlert(fact(), NOW);
    expect(summary).toContain('wall:mac-vm-creds-public-leak-owner-rotation');
    expect(summary).toContain('LAPSED');
    expect(body).toContain('absence');
    expect(body).toContain('do NOT infer the underlying condition resolved');
    expect(body).toContain('facts:retract');
    expect(body).toContain('su-abc');
  });

  it('computes elapsed days from now vs expiresAt', () => {
    const { summary } = formatWallLapseAlert(fact({ expiresAt: '2026-07-24T00:00:00.000Z' }), NOW);
    expect(summary).toContain('2d ago');
  });
});

describe('wallLapseSweep — orchestration (injected deps, no PG)', () => {
  const deps = (over: Parameters<typeof wallLapseSweep>[0] = {}) => ({
    listLapsedWallFacts: vi.fn(async () => [fact()]),
    recentWatchdogFires: vi.fn(async () => 0),
    recordFire: vi.fn(async () => undefined),
    openEscalation: vi.fn(async () => ({}) as never),
    readOpenConditionKeys: async () => [],
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    now: NOW,
    ...over,
  });

  it('alerts on a lapsed wall — fires BOTH the countable fires row and the coord escalation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    const results = await wallLapseSweep(d);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(results).toEqual([
      { key: 'wall:mac-vm-creds-public-leak-owner-rotation', outcome: 'alerted', reason: expect.any(String) },
    ]);
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.recordFire).mock.calls[0]![0]).toMatchObject({
      source: 'wall-fact-lapse',
      workspaceId: 'default',
      installSlug: 'papercusp',
    });
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    const esc = vi.mocked(d.openEscalation).mock.calls[0]![1] as { severity: string; summary: string };
    expect(esc.severity).toBe('blocker');
    expect(esc.summary).toContain('wall:mac-vm-creds-public-leak-owner-rotation');
  });

  it('debounces via the fires ledger — a recent fire suppresses the re-page', async () => {
    const d = deps({ recentWatchdogFires: vi.fn(async () => 1) });
    const results = await wallLapseSweep(d);
    expect(results[0]!.outcome).toBe('debounced');
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('passes the fact KEY as the scopeKey — two lapsed walls page INDEPENDENTLY, mirroring the rubric per-id fix', async () => {
    const factA = fact({ key: 'wall:a' });
    const factB = fact({ key: 'wall:b' });
    const ledger: Array<{ source: string; reason: string }> = [];
    const recentWatchdogFires = vi.fn(
      async (_ws: string, _slug: string, _h?: number, source?: string, scopeKey?: string) =>
        ledger.filter((f) => (!source || f.source === source) && (!scopeKey || f.reason.includes(scopeKey))).length,
    );
    const recordFire = vi.fn(async (opts: { source: string; reason: string }) => {
      ledger.push({ source: opts.source, reason: opts.reason });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ listLapsedWallFacts: vi.fn(async () => [factA, factB]), recentWatchdogFires, recordFire });
    const results = await wallLapseSweep(d);
    warn.mockRestore();
    expect(results.map((r) => r.outcome)).toEqual(['alerted', 'alerted']);
    expect(d.recordFire).toHaveBeenCalledTimes(2);
    expect(d.openEscalation).toHaveBeenCalledTimes(2);
  });

  it('uses the fact\'s own harness scopeRef as the installSlug when scope is harness-scoped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ listLapsedWallFacts: vi.fn(async () => [fact({ scope: 'harness', scopeRef: 'some-other-harness' })]) });
    await wallLapseSweep(d);
    warn.mockRestore();
    expect(d.recentWatchdogFires).toHaveBeenCalledWith('default', 'some-other-harness', expect.any(Number), 'wall-fact-lapse', expect.any(String));
  });

  it('falls back to the default install slug for a non-harness scope (owner/role/work_item)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps({ listLapsedWallFacts: vi.fn(async () => [fact({ scope: 'owner', scopeRef: 'su-abc' })]) });
    await wallLapseSweep(d);
    warn.mockRestore();
    expect(d.recentWatchdogFires).toHaveBeenCalledWith('default', 'papercusp', expect.any(Number), 'wall-fact-lapse', expect.any(String));
  });

  it('is fail-soft per fact — an escalation error is recorded, never thrown', async () => {
    const d = deps({
      openEscalation: vi.fn(async () => {
        throw new Error('coord log down');
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await wallLapseSweep(d);
    warn.mockRestore();
    expect(results[0]).toMatchObject({ outcome: 'error' });
    expect(results[0]!.reason).toContain('coord log down');
  });

  it('is fail-soft overall — a listLapsedWallFacts error yields one error result, never a throw', async () => {
    const d = deps({
      listLapsedWallFacts: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const results = await wallLapseSweep(d);
    expect(results).toEqual([{ key: '*', outcome: 'error', reason: 'pg down' }]);
  });

  it('no lapsed walls — a clean, empty sweep', async () => {
    const d = deps({ listLapsedWallFacts: vi.fn(async () => []) });
    const results = await wallLapseSweep(d);
    expect(results).toEqual([]);
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('opens before legacy debounce, isolates identities and resolves measured recovery across restarts', async () => {
    const a = fact({ key: 'wall:shared', scopeRef: 'a' });
    const b = fact({ key: 'wall:shared', scopeRef: 'b' });
    const foreign = fact({ key: 'wall:shared', scopeRef: 'a', sourceHive: 'peer' });
    let lapsed = [a, b, foreign], recovered: LapsedWallFact[] = [];
    const open = new Set<string>();
    const broadcast = vi.fn(async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); return true; });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    let fail = false;
    const read = vi.fn(async (opts?: { recoveryFor?: unknown[] }) => {
      if (opts?.recoveryFor) { if (fail) throw new Error('read unavailable'); return recovered; }
      return lapsed;
    });
    const d = deps({ listLapsedWallFacts: read, rail: { broadcast, resolve },
      recentWatchdogFires: async () => 1, readOpenConditionKeys: async () => [...open] });
    expect((await wallLapseSweep(d)).map(row => row.outcome)).toEqual(['debounced', 'debounced', 'debounced']);
    expect(open.size).toBe(3);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ oneShot: true }));
    expect(d.openEscalation).not.toHaveBeenCalled();
    lapsed = [];
    await wallLapseSweep({ ...d }); // fresh invocation with only durable open keys
    expect(open.size).toBe(3);
    recovered = [{ ...a, recovered: true }]; fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await wallLapseSweep(d); expect(open.size).toBe(3);
    expect(warn).toHaveBeenCalled(); warn.mockRestore();
    fail = false; await wallLapseSweep(d);
    expect(open.size).toBe(2); expect(resolve).toHaveBeenCalledOnce();
    recovered = [{ ...b, recovered: false }, { ...foreign, recovered: true }];
    await wallLapseSweep(d); expect(open.size).toBe(1);
    recovered = [{ ...b, recovered: true }]; await wallLapseSweep(d); expect(open.size).toBe(0);
  });

  // WI-6554700010008923: the broadcast goes to EVERY agent (`to:['*']`) and is declared oneShot, so
  // re-sending it on every routines tick is pure noise. Measured 2026-10-12 14:00–14:25Z before this
  // gate: 836 broadcasts for 76 walls, re-injected into every live agent's next tool result.
  it('broadcasts ONCE per episode — an already-open condition is not re-broadcast on later ticks', async () => {
    const open = new Set<string>();
    const broadcast = vi.fn(async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); return true; });
    const d = deps({ rail: { broadcast, resolve: vi.fn(async () => true) },
      recentWatchdogFires: async () => 1, readOpenConditionKeys: async () => [...open] });
    for (let tick = 0; tick < 5; tick++) {
      expect((await wallLapseSweep(d))[0].outcome).toBe('debounced');
    }
    expect(broadcast).toHaveBeenCalledOnce();
    expect(open.size).toBe(1);
  });

  it('still broadcasts every lapsed wall when the open-condition read FAILS (fail loud, not silent)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broadcast = vi.fn(async () => true);
    const d = deps({ rail: { broadcast, resolve: vi.fn(async () => true) },
      listLapsedWallFacts: vi.fn(async () => [fact({ key: 'wall:a' }), fact({ key: 'wall:b' })]),
      readOpenConditionKeys: async () => { throw new Error('fold unavailable'); } });
    await wallLapseSweep(d);
    expect(broadcast).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('attempts each delivery leg when the other fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broadcast = vi.fn(async () => { throw new Error('rail unavailable'); });
    const d = deps({ rail: { broadcast, resolve: async () => false } });
    expect((await wallLapseSweep(d))[0].outcome).toBe('alerted');
    expect(d.openEscalation).toHaveBeenCalledOnce();
    const successfulBroadcast = vi.fn(async () => true);
    const legacyFailed = deps({ rail: { broadcast: successfulBroadcast },
      recentWatchdogFires: async () => { throw new Error('legacy ledger unavailable'); } });
    expect((await wallLapseSweep(legacyFailed))[0].outcome).toBe('error');
    expect(successfulBroadcast).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
});

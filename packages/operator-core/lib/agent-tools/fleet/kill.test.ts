/**
 * fleet:kill core tests (WI-3728) — the injectable core only (killOne /
 * findTabShellPid / closeTerminalPid): routing (nursery vs desktop), self-kill
 * refusal, kill ordering (window resolved BEFORE the host dies), close_terminal
 * on/off, and the orphaned-window marker gate. Production wiring (PG lookup,
 * audit INSERT) is exercised by the fleet:cancel/turn:interrupt suites it mirrors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { killOne, findLiveUnmanagedSession, findTabShellPid, closeTerminalPid, isPositiveUnmanagedSessionState, type ProcInfo, type KillDeps } from './kill';
import type { PsuPtyHost } from '../../events/await/psu-pty-discovery';
import { linuxProcessIdentityFromStat, linuxStartTicksFromProcStat } from '../../process-identity';

const { sqlMock, resolveSessionStatesMock, latestAdvSessionMock, terminalEvidenceMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  resolveSessionStatesMock: vi.fn(),
  latestAdvSessionMock: vi.fn(),
  terminalEvidenceMock: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../coordination/liveness-oracle', () => ({
  resolveSessionStates: (...args: unknown[]) => resolveSessionStatesMock(...args),
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  latestAdvSessionByCoordOwner: (...args: unknown[]) => latestAdvSessionMock(...args),
  hasAdvSessionTerminalEvidence: (...args: unknown[]) => terminalEvidenceMock(...args),
}));

const MARKER_CMD = "bash -lc printf … && touch .papercup-console-active.$$ … (eval 'psu --no-picker --fleet=x')";

/** A tiny fake process tree: pid → { ppid, cmdline, env } . */
function makeProcTree(
  nodes: Record<
    number,
    {
      ppid: number;
      cmdline: string | null;
      env?: boolean;
      processIdentity?: string | null;
      consoleIdentity?: string | null;
    }
  >,
) {
  const alive = new Set(Object.keys(nodes).map(Number));
  const kills: Array<{ pid: number; signal: string }> = [];
  const readProc = (pid: number): ProcInfo | null => {
    const n = nodes[pid];
    if (!n || !alive.has(pid)) return null;
    const processIdentity = n.processIdentity === undefined ? `linux:test-boot:${pid}` : n.processIdentity;
    const consoleIdentity = n.consoleIdentity === undefined && n.env ? processIdentity : n.consoleIdentity;
    return {
      ppid: n.ppid,
      cmdline: n.cmdline,
      processIdentity,
      environmentValue: (name: string) => {
        if (name === 'PAPERCUSP_HARNESS_SLUG') return n.env ? 'test-harness' : null;
        return name === 'PAPERCUSP_CONSOLE_IDENTITY' ? (consoleIdentity ?? null) : null;
      },
    };
  };
  const kill = (pid: number, signal: NodeJS.Signals): boolean => {
    if (!alive.has(pid)) return false;
    kills.push({ pid, signal });
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGHUP') alive.delete(pid);
    return true;
  };
  return { readProc, kill, alive: (pid: number) => alive.has(pid), kills, aliveSet: alive };
}

const host = (pid: number): PsuPtyHost => ({
  ownerId: 'su-target',
  advSessionId: null,
  pid,
  ptyPid: pid,
  sock: '/tmp/fake.sock',
  command: 'psu',
  startedAt: Date.now(),
});

const trackedHost = (pid: number, advSessionId: string): PsuPtyHost => ({
  ...host(pid),
  advSessionId,
});

const headlessHost = (pid: number): PsuPtyHost => ({
  ...host(pid),
  bridgeTty: false,
  launchedBy: 'su-launcher',
});

const noSleep = (_ms: number) => Promise.resolve();

beforeEach(() => {
  sqlMock.mockReset().mockResolvedValue([
    { source: 'omp-hook-session', heartbeat_at: '2026-09-06T16:00:00.000Z' },
  ]);
  resolveSessionStatesMock.mockReset();
  latestAdvSessionMock.mockReset().mockResolvedValue(null);
  terminalEvidenceMock.mockReset().mockReturnValue(false);
});

describe('unmanaged-session liveness gate', () => {
  it('rejects heartbeat-only/no-channel verdicts instead of preserving stale presence', async () => {
    resolveSessionStatesMock.mockResolvedValue(new Map([
      ['su-omp', { ownerId: 'su-omp', sessionState: 'ended', wakeable: false, liveTurn: false }],
    ]));

    await expect(findLiveUnmanagedSession('su-omp', 'ws')).resolves.toBeNull();
    expect(resolveSessionStatesMock).toHaveBeenCalledWith([
      {
        ownerId: 'su-omp',
        heartbeatAt: '2026-09-06T16:00:00.000Z',
        source: 'omp-hook-session',
      },
    ]);
  });

  it.each(['live', 'parked', 'draining', 'recorded'] as const)(
    'preserves a positive %s shared-liveness verdict',
    async (sessionState) => {
      resolveSessionStatesMock.mockResolvedValue(new Map([
        ['su-omp', { ownerId: 'su-omp', sessionState, wakeable: sessionState !== 'recorded', liveTurn: sessionState === 'live' }],
      ]));

      await expect(findLiveUnmanagedSession('su-omp', 'ws')).resolves.toEqual({
        source: 'omp-hook-session',
        heartbeatAt: '2026-09-06T16:00:00.000Z',
      });
    },
  );

  it('does not treat unknown or suspect oracle verdicts as positive unmanaged liveness', () => {
    expect(isPositiveUnmanagedSessionState(null)).toBe(false);
    expect(isPositiveUnmanagedSessionState('ended')).toBe(false);
    expect(isPositiveUnmanagedSessionState('suspect')).toBe(false);
    expect(isPositiveUnmanagedSessionState('parked')).toBe(true);
    expect(isPositiveUnmanagedSessionState('live')).toBe(true);
  });
});

describe('findTabShellPid', () => {
  it('walks up to the TOPMOST marker-carrying ancestor (the tab shell)', () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD }, // tab shell (topmost marked)
      201: { ppid: 200, cmdline: MARKER_CMD }, // eval subshell (same cmdline)
      300: { ppid: 201, cmdline: 'node psu-launcher.mjs' },
    });
    expect(findTabShellPid(300, t.readProc)).toBe(200);
  });

  it('returns null when no ancestor carries the console marker (user-launched psu — nothing to close)', () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'bash -l' },
      300: { ppid: 100, cmdline: 'node psu-launcher.mjs' },
    });
    expect(findTabShellPid(300, t.readProc)).toBeNull();
  });
});

describe('killOne', () => {
  it.each(['desktop', 'headless', 'unmanaged', 'already-dead'] as const)(
    'persists retirement before the %s leg can race a wake', async (leg) => {
      const order: string[] = [];
      const t = makeProcTree({ 300: { ppid: 1, cmdline: 'psu-host' } });
      const retireOwner = vi.fn(async () => { order.push('retired'); });
      await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'replace member' }, {
        retireOwner,
        findHost: () => { order.push('host-lookup'); return leg === 'desktop' || leg === 'headless'
          ? { ...host(300), bridgeTty: leg === 'desktop' } : null; },
        findLiveUnmanaged: () => leg === 'unmanaged' ? { source: 'omp-hook-session', heartbeatAt: null } : null,
        kill: (pid, signal) => { order.push('signal'); return t.kill(pid, signal); },
        alive: t.alive, sleep: noSleep,
      });
      expect(retireOwner).toHaveBeenCalledWith('su-target', 'su-me', 'replace member');
      expect(order[0]).toBe('retired');
    },
  );

  it('sends no signal when durable retirement cannot be recorded', async () => {
    const kill = vi.fn();
    const out = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'x' }, {
      retireOwner: async () => { throw new Error('database unavailable'); }, kill,
    });
    expect(out).toMatchObject({ ok: false, code: 'cleanup_failed' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses self-kill', async () => {
    const r = await killOne({ actor: 'su-me', target: 'su-me', closeTerminal: true, reason: 'x' }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('self_kill_refused');
  });

  it('routes a nursery target to the cancel machinery; terminal is none', async () => {
    let cancelled: string | null = null;
    const deps: KillDeps = {
      cancelNursery: async (target) => {
        cancelled = target;
        return { spawn_id: 'sp-1', cancelled: ['sp-1', 'sp-2'], processes_aborted: 1 };
      },
      findHost: () => {
        throw new Error('must not reach the desktop leg for a nursery target');
      },
    };
    const r = await killOne({ actor: 'su-me', target: 'sp-1', closeTerminal: true, reason: 'x' }, deps);
    expect(cancelled).toBe('sp-1');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('nursery');
    expect(r.terminal).toBe('none');
    expect(r.cancelled).toEqual(['sp-1', 'sp-2']);
  });

  it('desktop: resolves the window BEFORE killing, SIGTERMs the host, closes the tab shell', async () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD },
      300: { ppid: 200, cmdline: 'node psu-launcher.mjs' },
    });
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => host(300),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
    };
    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: true, reason: 'wind-down' }, deps);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('desktop');
    expect(r.signal).toBe('SIGTERM');
    expect(r.terminal).toBe('closed');
    // Ordering: the host dies first (SIGTERM to 300), then the tab shell (SIGHUP to 200).
    const idxHost = t.kills.findIndex((k) => k.pid === 300 && k.signal === 'SIGTERM');
    const idxShell = t.kills.findIndex((k) => k.pid === 200 && k.signal === 'SIGHUP');
    expect(idxHost).toBeGreaterThanOrEqual(0);
    expect(idxShell).toBeGreaterThan(idxHost);
  });

  it('desktop close_terminal:false leaves the window open', async () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD },
      300: { ppid: 200, cmdline: 'node psu-launcher.mjs' },
    });
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => host(300),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
    };
    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'x' }, deps);
    expect(r.ok).toBe(true);
    expect(r.terminal).toBe('left-open');
    expect(t.kills.some((k) => k.pid === 200)).toBe(false); // shell untouched
    expect(t.aliveSet.has(200)).toBe(true);
  });

  it('headless managed psu host reports no terminal and never touches a tab shell', async () => {
    const t = makeProcTree({
      100: { ppid: 1, cmdline: 'gnome-terminal-server' },
      200: { ppid: 100, cmdline: MARKER_CMD },
      300: { ppid: 200, cmdline: 'node psu-launcher.mjs' },
    });
    const audits: string[] = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => headlessHost(300),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
      audit: async (action) => {
        audits.push(action);
      },
    };

    const r = await killOne(
      { actor: 'su-me', target: 'su-target', closeTerminal: true, reason: 'headless wind-down' },
      deps,
    );

    expect(r.ok).toBe(true);
    expect(r.kind).toBe('headless');
    expect(r.signal).toBe('SIGTERM');
    expect(r.terminal).toBe('none');
    expect(t.kills.some((k) => k.pid === 200)).toBe(false);
    expect(t.aliveSet.has(200)).toBe(true);
    expect(audits).toEqual(['fleet.kill_headless']);
  });

  it('desktop: stamps the tracked adv_session after confirming the host died', async () => {
    const t = makeProcTree({
      300: { ppid: 1, cmdline: 'node psu-launcher.mjs' },
    });
    const ended: Array<{ id: string; signal: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => trackedHost(300, '15153'),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
      markSessionEnded: async (id, signal) => {
        ended.push({ id, signal });
      },
    };

    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'stop' }, deps);

    expect(r.ok).toBe(true);
    expect(ended).toEqual([{ id: '15153', signal: 'SIGTERM' }]);
  });

  it('escalates to SIGKILL when the host survives SIGTERM', async () => {
    const stubborn = new Set([300]);
    const kills: Array<{ pid: number; signal: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => stubborn.has(300) ? host(300) : null,
      readProc: () => null, // no ancestry → terminal not-found
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (signal === 'SIGKILL') stubborn.delete(pid);
        return true; // SIGTERM "delivered" but the process ignores it
      },
      alive: (pid) => stubborn.has(pid),
      sleep: noSleep,
    };
    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: true, reason: 'x' }, deps);
    expect(r.ok).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.terminal).toBe('not-found');
    expect(kills.filter((k) => k.pid === 300).map((k) => k.signal)).toEqual(
      expect.arrayContaining(['SIGTERM', 'SIGKILL']),
    );
  });

  it('waits for a SIGKILLed managed host to disappear before marking its session ended', async () => {
    let hostVisible = true;
    let killRequested = false;
    let postKillPolls = 0;
    let presenceCleared = false;
    const kills: Array<{ pid: number; signal: string }> = [];
    const ended: Array<{ id: string; signal: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => hostVisible ? trackedHost(300, '15153') : null,
      readProc: () => null,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (pid === 300 && signal === 'SIGKILL') killRequested = true;
        return true;
      },
      alive: (pid) => pid === 300 && hostVisible,
      sleep: async () => {
        if (!killRequested) return;
        postKillPolls++;
        if (postKillPolls >= 2) hostVisible = false;
      },
      markSessionEnded: async (id, signal) => {
        expect(hostVisible).toBe(false);
        ended.push({ id, signal });
      },
      deactivateLoop: async () => {
        expect(hostVisible).toBe(false);
        return true;
      },
      clearPresence: async () => {
        expect(hostVisible).toBe(false);
        presenceCleared = true;
      },
      presenceExists: async () => false,
    };

    const result = await killOne(
      { actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'successor handoff' },
      deps,
    );

    expect(result).toMatchObject({ ok: true, signal: 'SIGKILL', terminal: 'left-open' });
    expect(postKillPolls).toBeGreaterThanOrEqual(2);
    expect(ended).toEqual([{ id: '15153', signal: 'SIGKILL' }]);
    expect(presenceCleared).toBe(true);
    expect(kills.filter((kill) => kill.pid === 300).map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('withholds terminal and presence cleanup if the SIGKILLed host remains discoverable', async () => {
    const ended: Array<{ id: string; signal: string }> = [];
    const cleanup: string[] = [];
    const audits: string[] = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => trackedHost(300, '15153'),
      readProc: () => null,
      kill: () => true,
      alive: () => true,
      sleep: noSleep,
      waitForHostGone: async () => false,
      markSessionEnded: async (id, signal) => {
        ended.push({ id, signal });
      },
      deactivateLoop: async () => {
        cleanup.push('deactivate-loop');
        return true;
      },
      clearPresence: async () => {
        cleanup.push('clear-presence');
      },
      audit: async (action) => {
        audits.push(action);
      },
    };

    const result = await killOne(
      { actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'successor handoff' },
      deps,
    );

    expect(result).toMatchObject({
      ok: false,
      killed: false,
      signal: 'SIGKILL',
      terminal: 'left-open',
      code: 'cleanup_failed',
    });
    expect(ended).toEqual([]);
    expect(cleanup).toEqual([]);
    expect(audits).toEqual(['fleet.kill_cleanup_failed']);
  });

  it('lets a host finish a graceful SIGTERM teardown that outlasts 1.5 s (WI-10006628)', async () => {
    // A resumed CLI flushing its transcript on SIGHUP kept the host alive ~2.4 s after
    // SIGTERM; the old 6 × 250 ms grace SIGKILLed it and turned an owner's `/exit` into
    // ended_signal SIGKILL + outer exit 137. Simulate a host that exits after 2.5 s.
    const TEARDOWN_MS = 2_500;
    let elapsedMs = 0;
    let termAt: number | null = null;
    const kills: Array<{ pid: number; signal: string }> = [];
    const ended: Array<{ id: string; signal: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => host(300),
      readProc: () => null,
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (pid === 300 && signal === 'SIGTERM' && termAt === null) termAt = elapsedMs;
        return true;
      },
      alive: (pid) => pid === 300 && (termAt === null || elapsedMs - termAt < TEARDOWN_MS),
      sleep: async (ms) => {
        elapsedMs += ms;
      },
      markSessionEnded: async (id, signal) => {
        ended.push({ id, signal });
      },
    };

    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: false, reason: 'session end' }, deps);

    expect(r.ok).toBe(true);
    expect(r.signal).toBe('SIGTERM');
    expect(kills.filter((k) => k.pid === 300).map((k) => k.signal)).toEqual(['SIGTERM']);
    expect(ended.map((e) => e.signal)).not.toContain('SIGKILL');
  });

  it('closes an authenticated discovery terminal when host ancestry is detached', async () => {
    const t = makeProcTree({
      300: { ppid: 1, cmdline: 'node psu-launcher.mjs' },
      500: { ppid: 1, cmdline: 'bash -l', env: true },
    });
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => ({ ...host(300), terminalPid: 500 }),
      readProc: t.readProc,
      kill: t.kill,
      alive: t.alive,
      sleep: noSleep,
    };

    const r = await killOne({ actor: 'su-me', target: 'su-target', closeTerminal: true, reason: 'x' }, deps);

    expect(r).toMatchObject({ ok: true, signal: 'SIGTERM', terminal: 'closed' });
    expect(t.kills).toEqual(
      expect.arrayContaining([
        { pid: 300, signal: 'SIGTERM' },
        { pid: 500, signal: 'SIGHUP' },
      ]),
    );
  });

  it('reports not_found for a target with no nursery row and no live host', async () => {
    let cleared: string | null = null;
    let released: string[] = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      clearPresence: async (ownerId) => {
        cleared = ownerId;
      },
      releaseSeatConsumptions: async (ownerIds) => {
        released = ownerIds;
      },
    };
    const r = await killOne({ actor: 'su-me', target: 'su-ghost', closeTerminal: true, reason: 'x' }, deps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_found');
    expect(r.error).toContain('terminal_pids'); // the stale-window hint
    expect(cleared).toBe('su-ghost');
    expect(released).toEqual(['su-ghost']);
  });

  it('deactivates the owner loop before deleting presence so the watchdog cannot heal the row back', async () => {
    const events: string[] = [];
    let loopActive = true;
    let presenceExists = true;
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      deactivateLoop: async () => {
        events.push('deactivate-loop');
        loopActive = false;
        return true;
      },
      clearPresence: async () => {
        events.push('clear-presence');
        presenceExists = false;
        // Model compaction-watchdog healPresenceGap: it recreates a missing
        // row only while the loop routine still authoritatively reads active.
        if (loopActive) presenceExists = true;
      },
      presenceExists: async () => {
        events.push('verify-presence');
        return presenceExists;
      },
    };

    const r = await killOne({ actor: 'su-me', target: 'su-dead-loop', closeTerminal: true, reason: 'reap' }, deps);

    expect(r.code).toBe('not_found');
    expect(events).toEqual(['deactivate-loop', 'clear-presence', 'verify-presence']);
  });

  it('does not report already-dead success while the presence cleanup postcondition is false', async () => {
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      deactivateLoop: async () => true,
      clearPresence: async () => {},
      presenceExists: async () => true,
    };

    const r = await killOne({ actor: 'su-me', target: 'su-still-present', closeTerminal: true, reason: 'reap' }, deps);

    expect(r).toMatchObject({
      ok: false,
      target: 'su-still-present',
      code: 'cleanup_failed',
    });
    expect(r.error).toContain('postcondition failed');
  });

  it('repairs stale terminal evidence before consulting unmanaged presence', async () => {
    const events: string[] = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      repairStaleAdvSessionTerminalMarkers: async (ownerId) => {
        events.push(`repair:${ownerId}`);
        return 1;
      },
      findLiveUnmanaged: async () => {
        events.push('unmanaged');
        return null;
      },
    };

    await killOne({ actor: 'su-me', target: 'su-stale', closeTerminal: true, reason: 'cleanup' }, deps);
    expect(events).toEqual(['repair:su-stale', 'unmanaged']);
  });

  it('reports live_unmanaged for a fresh OMP-hook presence without clearing it', async () => {
    let cleared = false;
    let released = false;
    const audits: Array<{ action: string; subject: string }> = [];
    const deps: KillDeps = {
      cancelNursery: async () => null,
      findHost: () => null,
      findLiveUnmanaged: async () => ({
        source: 'omp-hook-session',
        heartbeatAt: '2026-08-12T08:10:00.000Z',
      }),
      clearPresence: async () => {
        cleared = true;
      },
      releaseSeatConsumptions: async () => {
        released = true;
      },
      audit: async (action, subject) => {
        audits.push({ action, subject });
      },
    };

    const r = await killOne({ actor: 'su-me', target: 'su-omp', closeTerminal: true, reason: 'wind-down' }, deps);

    expect(r).toMatchObject({
      ok: false,
      target: 'su-omp',
      kind: 'unmanaged',
      killed: false,
      code: 'live_unmanaged',
      terminal: 'not-found',
    });
    expect(r.error).toContain('turn:interrupt');
    expect(cleared).toBe(false);
    expect(released).toBe(false);
    expect(audits).toEqual([{ action: 'fleet.kill_unmanaged', subject: 'su-omp' }]);
  });
});

describe('closeTerminalPid (orphaned windows)', () => {
  it('refuses a pid without the papercusp console marker', async () => {
    const t = makeProcTree({ 500: { ppid: 1, cmdline: 'bash -l', env: false } });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('refused');
    expect(t.aliveSet.has(500)).toBe(true);
  });

  it('closes a marked tab shell only when its launch identity matches its current birth identity', async () => {
    // After `exec $SHELL -l` the cmdline marker is GONE — only the env marker survives.
    const t = makeProcTree({ 500: { ppid: 1, cmdline: 'bash -l', env: true } });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.closed).toBe(true);
    expect(t.kills[0]).toEqual({ pid: 500, signal: 'SIGHUP' });
  });

  it('refuses a legacy env-only marker with no birth identity', async () => {
    const t = makeProcTree({
      500: { ppid: 1, cmdline: 'bash -l', env: true, consoleIdentity: null },
    });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('birth identity');
    expect(t.kills).toEqual([]);
  });

  it('refuses a recycled pid whose recorded and current birth identities differ', async () => {
    const t = makeProcTree({
      500: {
        ppid: 1,
        cmdline: 'bash -l',
        env: true,
        processIdentity: 'linux:test-boot:999',
        consoleIdentity: 'linux:test-boot:500',
      },
    });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(t.kills).toEqual([]);
  });

  it('refuses protected session processes even if markers are spoofed', async () => {
    const t = makeProcTree({ 500: { ppid: 1, cmdline: '/usr/lib/systemd/systemd --user', env: true } });
    const r = await closeTerminalPid(500, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('protected');
    expect(t.kills).toEqual([]);
  });

  it('reports pid not found for a dead pid', async () => {
    const t = makeProcTree({});
    const r = await closeTerminalPid(999, { readProc: t.readProc, kill: t.kill, alive: t.alive, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('pid not found');
  });
});

describe('kernel process identity parsing', () => {
  it('reads Linux starttime field 22 after a comm containing spaces and parens', () => {
    const stat = '42 (odd process) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20';
    expect(linuxStartTicksFromProcStat(stat)).toBe('987654');
    expect(linuxProcessIdentityFromStat('boot-abc\n', stat)).toBe('linux:boot-abc:987654');
  });
});

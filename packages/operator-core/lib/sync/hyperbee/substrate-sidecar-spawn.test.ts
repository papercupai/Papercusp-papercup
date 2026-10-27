import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

// WI-10007538: every ledger write below is faked, so the real-PG rail must never
// fire. Counted at the rail's throw site, so a swallowed refusal fails here.
afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

const spawnMock = vi.fn();
vi.mock('../../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
// WI-10007538: spawnSubstrateSidecar enrols the child in the task ledger
// (beginSyncEnrolment → completeSyncEnrolment), whose fire-and-forget write goes
// through task-manager/store to the REAL org Postgres. The unit-layer rail blocks
// that connection and enroll-sync only logs "[task-manager] sync enrollment
// failed", so the suite stayed green while reaching for a live database five
// times per run. Fake the ledger writes (their results are discarded by the
// spawn path) so the enrolment code path still runs, hermetically.
vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  registerTask: vi.fn(async () => undefined),
  markSpawned: vi.fn(async () => undefined),
  closeTask: vi.fn(async () => undefined),
  bindAgentSessionTaskToLatestNativeSession: vi.fn(async () => null),
}));

import {
  _resetSidecarRespawnListenersForTests,
  _resetSubstrateSidecarSpawnStateForTests,
  getSubstrateSidecarProcess,
  onSidecarRespawned,
  spawnSubstrateSidecar,
  stopSubstrateSidecar,
  substrateSidecarSupervisionStatus,
  MAX_RESPAWN_ATTEMPTS,
  RESPAWN_WINDOW_MS,
} from './substrate-sidecar-spawn';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

let nextPid = 2000;

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = nextPid++;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.emit('exit', signal === 'SIGKILL' ? 137 : 0);
  });
  return child;
}

describe('substrate sidecar spawn hardening (WI-1504)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    _resetSubstrateSidecarSpawnStateForTests();
    _resetSidecarRespawnListenersForTests();
    delete process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G;
    delete process.env.PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE;
  });

  afterEach(() => {
    _resetSubstrateSidecarSpawnStateForTests();
    _resetSidecarRespawnListenersForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('wraps the sidecar in a memory-capped transient user scope', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { detached?: boolean; env?: NodeJS.ProcessEnv }];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--user');
    expect(args).toContain('--scope');
    expect(args).toContain('--collect');
    expect(args).toContain('--property=MemoryMax=8G');
    expect(args).toContain('--property=MemorySwapMax=0');
    expect(args.join(' ')).toContain('apps/operator/bin/substrate-sidecar.ts');
    expect(opts.detached).toBe(true);
    expect(opts.env?.PAPERCUSP_SUBSTRATE_IPC_SOCKET).toBe('/tmp/substrate-sidecar.sock');
  });

  it('honors PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G for the scope cap', async () => {
    process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G = '12';
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--property=MemoryMax=12G');
  });

  it('falls back to a direct spawn once when the scope cannot launch', async () => {
    // The scope-launch failure + fallback are INTENTIONALLY loud (console.warn);
    // mock + assert per the fail-on-console convention.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scoped = makeChild();
    const direct = makeChild();
    spawnMock.mockReturnValueOnce(scoped).mockReturnValueOnce(direct);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    scoped.stderr.emit('data', Buffer.from('Failed to connect to bus: No such file or directory'));
    scoped.emit('exit', 1);
    direct.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    expect(warn).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd1] = spawnMock.mock.calls[0] as [string, string[]];
    const [cmd2, args2] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd1).toBe('systemd-run');
    expect(cmd2).toBe(process.execPath);
    expect(args2[0]).toBe('--import');
    expect(args2[1]).toContain('tsx');
  });

  it('does not retry on a payload failure inside a healthy scope', async () => {
    // The pre-ready death is INTENTIONALLY loud (console.warn); mock + assert.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    child.stderr.emit('data', Buffer.from('sidecar crashed while booting'));
    child.emit('exit', 1);

    await expect(ready).rejects.toThrow(/Sidecar exited before ready/);
    expect(warn).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('auto-respawns after an unexpected post-ready exit', async () => {
    // The unexpected exit + respawn schedule are INTENTIONALLY loud (console.warn);
    // mock + assert the respawn announcement specifically.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeChild();
    const second = makeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;
    expect(getSubstrateSidecarProcess()).toBe(first);

    first.emit('exit', 137);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-respawning'));

    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    second.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await vi.runAllTicks();
    expect(getSubstrateSidecarProcess()).toBe(second);
  });

  // WI-2030: an unexpected death's log line must carry the captured stderr
  // inline, so a reader scanning a busy/aggregated log for "died" learns WHY
  // without separately hunting down the nearby stderr-passthrough lines.
  it('includes a stderr tail in the death log on an unexpected post-ready exit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeChild();
    const second = makeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    const diagnostic = Buffer.from('Failed to connect to bus: No medium found ⚠\n');
    const splitAt = diagnostic.indexOf(Buffer.from('⚠')) + 1;
    first.stderr.emit('data', diagnostic.subarray(0, splitAt));
    first.stderr.emit('data', diagnostic.subarray(splitAt));
    first.emit('exit', 1);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[substrate-sidecar\] died \(exit code 1\) — stderr tail: Failed to connect to bus: No medium found ⚠$/),
    );
  });

  it('says "no stderr captured" when the process died silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeChild();
    const second = makeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    first.emit('exit', 137);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[substrate-sidecar\] died \(exit code 137\) — no stderr captured$/),
    );
  });

  // WI-1877: the respawn only restarts the PROCESS — nothing re-boots the
  // harnesses onto it unless a listener acts on the notification below.
  describe('onSidecarRespawned (WI-1877)', () => {
    it('fires a registered listener after a crash-triggered respawn SUCCEEDS', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = makeChild();
      const second = makeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const fired: number[] = [];
      onSidecarRespawned(() => fired.push(1));

      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;
      expect(fired).toEqual([]); // the FIRST (non-respawn) spawn never fires it

      first.emit('exit', 137); // unexpected crash → schedules a respawn
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(fired).toEqual([]); // not yet — the new sidecar isn't ready

      second.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      // Flush the microtask queue: notifySidecarRespawned() runs inside a
      // `.then()` chained onto spawnSubstrateSidecar's returned promise, which
      // resolves synchronously here but whose continuation is still a queued
      // microtask (vi.runAllTicks() only drains fake-timer ticks, not real
      // Promise microtasks).
      await Promise.resolve();
      await Promise.resolve();
      expect(fired).toEqual([1]); // fires exactly once the respawned sidecar is ready
    });

    it('never fires for a deliberate stop (no crash, no respawn)', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);

      const fired: number[] = [];
      onSidecarRespawned(() => fired.push(1));

      const { stopSubstrateSidecar } = await import('./substrate-sidecar-spawn');
      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;

      const stopPromise = stopSubstrateSidecar();
      child.emit('exit', 0); // the deliberate-stop exit
      await stopPromise;
      await vi.runAllTicks();
      expect(fired).toEqual([]);
    });

    it('an unsubscribe fn stops further notifications', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = makeChild();
      const second = makeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const fired: number[] = [];
      const unsubscribe = onSidecarRespawned(() => fired.push(1));
      unsubscribe();

      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;
      first.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(1000);
      second.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await vi.runAllTicks();
      expect(fired).toEqual([]);
    });

    it('one throwing listener never blocks another from firing', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = makeChild();
      const second = makeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const fired: number[] = [];
      onSidecarRespawned(() => {
        throw new Error('boom');
      });
      onSidecarRespawned(() => fired.push(1));

      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;
      first.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(1000);
      second.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await Promise.resolve();
      await Promise.resolve();

      expect(fired).toEqual([1]);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('onSidecarRespawned listener threw'),
        expect.any(String),
      );
    });
  });

  // P-006 (critical-process-supervisor-2026-07-04): give-up + the
  // `dev:service_health` supervision-status accessor.
  describe('give-up + substrateSidecarSupervisionStatus (P-006)', () => {
    it('MAX_RESPAWN_ATTEMPTS crashes within the window give up auto-respawning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const first = makeChild();
      spawnMock.mockReturnValueOnce(first);
      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;

      let current = first;
      for (let i = 0; i < MAX_RESPAWN_ATTEMPTS; i++) {
        const next = makeChild();
        spawnMock.mockReturnValueOnce(next);
        current.emit('exit', 137);
        // 20s comfortably clears every backoff rung up to MAX_RESPAWN_ATTEMPTS
        // (capped at 30s) while keeping cumulative elapsed time well under the
        // 5-minute RESPAWN_WINDOW_MS, so none of these attempts prune out of
        // the sliding window before the give-up check below.
        await vi.advanceTimersByTimeAsync(20_000);
        next.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
        await vi.runAllTicks();
        current = next;
      }
      expect(spawnMock).toHaveBeenCalledTimes(MAX_RESPAWN_ATTEMPTS + 1); // initial + MAX_RESPAWN_ATTEMPTS respawns
      expect(substrateSidecarSupervisionStatus().gaveUp).toBe(false);

      // The NEXT unexpected exit (still inside the window) gives up instead of
      // scheduling yet another respawn.
      const spawnCallsBefore = spawnMock.mock.calls.length;
      current.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(spawnMock).toHaveBeenCalledTimes(spawnCallsBefore); // no further respawn attempt
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('giving up auto-respawn'));
      expect(substrateSidecarSupervisionStatus().gaveUp).toBe(true);
      warn.mockRestore();
    });

    it('a fresh spawnSubstrateSidecar() call resets the gaveUp latch', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = makeChild();
      spawnMock.mockReturnValueOnce(first);
      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;

      let current = first;
      for (let i = 0; i < MAX_RESPAWN_ATTEMPTS; i++) {
        const next = makeChild();
        spawnMock.mockReturnValueOnce(next);
        current.emit('exit', 137);
        await vi.advanceTimersByTimeAsync(20_000);
        next.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
        await vi.runAllTicks();
        current = next;
      }
      current.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(substrateSidecarSupervisionStatus().gaveUp).toBe(true);

      // A fresh, EXPLICIT respawn (e.g. from substrate-boot-wrapper on the next
      // boot, per the module's own doc comment) re-arms the machinery.
      const fresh = makeChild();
      spawnMock.mockReturnValueOnce(fresh);
      const freshReady = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      fresh.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await freshReady;
      expect(substrateSidecarSupervisionStatus().gaveUp).toBe(false);
    });

    it('reports running:true + zero flap counters for a healthy, never-crashed sidecar', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;

      const status = substrateSidecarSupervisionStatus();
      expect(status).toEqual({ running: true, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null });
    });

    it('reports running:false after a deliberate stop, with no flap counters incremented', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;

      const stopPromise = stopSubstrateSidecar();
      child.emit('exit', 0);
      await stopPromise;

      const status = substrateSidecarSupervisionStatus();
      expect(status).toEqual({ running: false, respawnAttemptsInWindow: 0, gaveUp: false, lastRespawnScheduledAt: null });
    });

    it('restarts older than RESPAWN_WINDOW_MS are pruned from the reported count', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = makeChild();
      const second = makeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
      const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await ready;

      first.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(1000);
      second.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
      await vi.runAllTicks();
      expect(substrateSidecarSupervisionStatus().respawnAttemptsInWindow).toBe(1);

      // Advance past the window — the recorded attempt ages out of the reported count.
      await vi.advanceTimersByTimeAsync(RESPAWN_WINDOW_MS + 1000);
      expect(substrateSidecarSupervisionStatus().respawnAttemptsInWindow).toBe(0);
    });
  });
});

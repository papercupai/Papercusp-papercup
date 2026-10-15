/**
 * Tests for the spawner sidecar spawner (WI-344 ③). Previously untested — added
 * as part of WI-3079's migration onto the shared process-supervision primitives
 * (process-supervision/sidecar-spawn-shared.ts), to lock in the spawn-plan +
 * ready-handshake + graceful-stop behavior this module now delegates part of.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (_file: unknown, _args: unknown, _options: unknown, callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => callback(null, '', ''));
    return undefined;
  },
}));

// ── EI-19479764372783341 fallout: this file's subject now sits behind an ASYNC
// chokepoint ──────────────────────────────────────────────────────────────────
//
// `spawnSpawnerSidecar` routes through `managedSpawn` so the sidecar lands in a
// transient systemd scope that is a SIBLING of papercup-bg-host.service (before,
// a raw spawn put it INSIDE bg-host's cgroup, so restarting bg-host killed the
// agent spawner and every desktop sidecar it parented). Two consequences here:
//
//  1. `isTaskManagerEnabled()` awaits `getFlag(...)`, which never settles with no
//     flag backend. Combined with this file's fake timers that is a HANG, not a
//     failure — the whole file produced zero output for 10min. `setTaskManagerEnabledForTest`
//     does NOT help: it only sets the cache the SYNC reader consults.
//  2. `registerTask`/`markSpawned` want Postgres.
//
// Both are mocked, so this file stays a unit test of the SPAWN PLAN + ENV, which
// is its actual subject.
vi.mock('../task-manager/enabled', () => ({
  isTaskManagerEnabled: async () => true,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));
vi.mock('../task-manager/store', () => ({
  registerTask: async (_s: unknown, o: { taskId?: string }) => ({ taskId: o?.taskId ?? 't', state: 'pending' }),
  markSpawned: async () => {},
  closeTask: async () => {},
}));

import {
  _resetSpawnerSidecarSpawnStateForTests,
  _setSpawnerSidecarProcessForTests,
  getSpawnerSidecarProcess,
  isSpawnerSidecarRunning,
  registerSpawnerSidecarShutdownHooks,
  spawnerSidecarSupervisionStatus,
  spawnSpawnerSidecar,
  stopSpawnerSidecar,
  MAX_RESPAWN_ATTEMPTS,
} from './spawner-sidecar-spawn';
import { _resetSidecarShutdownHookRegistryForTests, respawnBackoffMs } from '../process-supervision/sidecar-spawn-shared';
import {
  __resetShutdownStateForTest,
  markGracefulDrainInstalled,
  markShuttingDown,
  runBeforeHostExitHooks,
} from '../shutdown-state';
import { probeScopeSupport, resetScopeProbe } from '../task-manager/managed-spawn';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: ReturnType<typeof vi.fn>;
  channel: { unref: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

/**
 * A stdout that REPLAYS data emitted before anyone was listening.
 *
 * Every test here does `const ready = spawnSpawnerSidecar(...)` and then emits
 * the handshake on the very next line. That was sound while the spawn was
 * synchronous — the listener was attached by the time the call returned. Now
 * `managedSpawn` is async, so the child (and its listener) do not exist on that
 * tick and the handshake would be emitted into the void, leaving every test to
 * hang on `await ready` until the 10s startup timeout.
 *
 * Buffering and replaying is the fixture absorbing that timing change, so the 13
 * call sites keep reading the way they did. It weakens nothing: the data still
 * has to arrive, be parsed, and match the handshake for `ready` to resolve.
 */
function makeReplayableStdout(): EventEmitter {
  const stdout = new EventEmitter();
  const emit = stdout.emit.bind(stdout);
  const pending: unknown[][] = [];
  stdout.emit = ((event: string, ...a: unknown[]) => {
    if (event === 'data' && stdout.listenerCount('data') === 0) {
      pending.push(a); // nobody home yet — hold it
      return false;
    }
    return emit(event, ...a);
  }) as typeof stdout.emit;
  stdout.on('newListener', (event) => {
    if (event !== 'data' || pending.length === 0) return;
    const replay = pending.splice(0);
    // nextTick, not sync: 'newListener' fires BEFORE the listener is added.
    process.nextTick(() => {
      for (const a of replay) emit('data', ...a);
    });
  });
  return stdout;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.killed = false;
  child.stdout = makeReplayableStdout();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  (child.stdout as EventEmitter & { unref?: ReturnType<typeof vi.fn> }).unref = vi.fn();
  (child.stderr as EventEmitter & { unref?: ReturnType<typeof vi.fn> }).unref = vi.fn();
  child.channel = { unref: vi.fn() };
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.emit('exit', signal === 'SIGKILL' ? 137 : 0);
  });
  return child;
}

describe('spawner-sidecar-spawn (WI-3079 migration)', () => {
  beforeEach(async () => {
    spawnMock.mockReset();
    vi.useFakeTimers();
    _resetSpawnerSidecarSpawnStateForTests();
    // PIN the scope probe UNSUPPORTED, for two independent reasons.
    //
    // (a) Determinism of the call indices: an unseeded probe fires its OWN
    //     `systemd-run` spawn through the SAME mock, eating a `mockReturnValueOnce`
    //     and shifting every `spawnMock.mock.calls[N]` this file reads (WI-7377).
    // (b) Subject: pinned unsupported, `managedSpawn` still runs its full path but
    //     launches the payload directly — so `cmd`/`args` stay the bare `npx tsx …`
    //     spawn PLAN these tests are about, unchanged by the confinement work.
    //
    // The CONFINED branch is pinned by the sibling file
    // `spawner-sidecar-cgroup-confinement.test.ts`. Both branches are covered on
    // purpose: a refactor that silently drops confinement fails THERE, loudly,
    // instead of looking like a stale expectation here.
    resetScopeProbe();
    await probeScopeSupport((() => {
      throw new Error('no systemd in test');
    }) as never);
    // Pinning the probe unsupported means the spawn legitimately reports itself
    // UNCONFINED once per process. Since EI-20006410617437313 that notice goes to
    // console.LOG under a test runner — `vitest-fail-on-console` polices only
    // warn/error, so an ambient host condition (the task manager being disabled)
    // can no longer red whichever unrelated file happens to touch this path first.
    // It is still asserted EXPLICITLY in the dedicated case below, rather than
    // blanket-muting a signal nobody then checks.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetSpawnerSidecarSpawnStateForTests();
    resetScopeProbe();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spawns via npx tsx in dev, resolves on the PAPERCUSP_SPAWNER_READY handshake', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(cmd).toBe('npx');
    expect(args[0]).toBe('tsx');
    expect(args[1]).toContain('apps/operator/bin/spawner-sidecar.ts');
    expect(opts.env?.PAPERCUSP_SPAWNER_IPC_SOCKET).toBe('/tmp/spawner-sidecar.sock');
    expect(opts.env?.PAPERCUSP_SPAWNER_SCOPE_UNIT).toMatch(/^pc-[0-9a-z]{4,64}\.scope$/);
    expect(isSpawnerSidecarRunning()).toBe(true);
    expect(getSpawnerSidecarProcess()).toBe(child);
    expect(child.unref).toHaveBeenCalledOnce();
    expect((child.stdout as EventEmitter & { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalledOnce();
    expect((child.stderr as EventEmitter & { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalledOnce();
    expect(child.channel.unref).toHaveBeenCalledOnce();
  });

  it('stopSpawnerSidecar SIGTERMs the child, resolves once it exits, and does NOT auto-respawn (P-006: deliberate stop gates the respawn machinery)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;

    await stopSpawnerSidecar();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(getSpawnerSidecarProcess()).toBeNull();
    expect(isSpawnerSidecarRunning()).toBe(false);
    // A deliberate stop is a graceful shutdown, not a crash — neither the "died"
    // warning nor an auto-respawn attempt should fire.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('died'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(1); // still just the original spawn — no respawn
  });

  it('a no-op stop when nothing is running never throws', async () => {
    await expect(stopSpawnerSidecar()).resolves.toBeUndefined();
  });

  it('coalesces a caller that joins after child creation and rejects both on startup error', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const first = spawnSpawnerSidecar('/tmp/spawner-sidecar-startup-error.sock');
    await vi.waitFor(() => expect(getSpawnerSidecarProcess()).toBe(child));
    const second = spawnSpawnerSidecar('/tmp/spawner-sidecar-startup-error.sock');
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    const error = new Error('sidecar failed before ready');
    const matchingRejection = expect(first).rejects.toBe(error);
    child.emit('error', error);

    await matchingRejection;
    await Promise.resolve();
    expect(secondSettled).toBe(true);
  });

  it.each([
    { code: 17, signal: null, reason: 'exit code 17' },
    { code: null, signal: 'SIGTERM', reason: 'signal SIGTERM' },
  ])('rejects all startup callers with the actual pre-ready exit: $reason', async ({ code, signal, reason }) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const first = spawnSpawnerSidecar('/tmp/spawner-sidecar-early-exit.sock');
    await vi.waitFor(() => expect(getSpawnerSidecarProcess()).toBe(child));
    const second = spawnSpawnerSidecar('/tmp/spawner-sidecar-early-exit.sock');
    let firstError: unknown;
    let secondError: unknown;
    void first.catch((error) => { firstError = error; });
    void second.catch((error) => { secondError = error; });
    child.emit('exit', code, signal);
    await vi.waitFor(() => {
      expect(firstError).toMatchObject({ message: `Spawner sidecar exited before ready (${reason})`,
        code: 'SIDECAR_STARTUP_EXIT', exitCode: code, signal });
      expect(secondError).toBe(firstError);
    }, { timeout: 500 });
    expect(warning).toHaveBeenCalledWith(`[spawner-sidecar] died (${reason})`);
  });

  it('rejects every coalesced startup caller when the ready handshake times out', async () => {
    const child = makeChild();
    child.kill.mockImplementation(() => {
      child.killed = true;
      return true;
    });
    spawnMock.mockReturnValueOnce(child);
    const first = spawnSpawnerSidecar('/tmp/spawner-sidecar-startup-timeout.sock');
    await vi.waitFor(() => expect(getSpawnerSidecarProcess()).toBe(child));
    const second = spawnSpawnerSidecar('/tmp/spawner-sidecar-startup-timeout.sock');
    const firstRejection = expect(first).rejects.toThrow('Spawner sidecar startup timeout');
    let secondSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await firstRejection;
    await Promise.resolve();
    expect(secondSettled).toBe(true);
  });

  it('retains the startup timeout cause when its kill emits exit synchronously', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar-kill-exit.sock');
    await vi.waitFor(() => expect(getSpawnerSidecarProcess()).toBe(child));
    const rejection = expect(ready).rejects.toThrow('Spawner sidecar startup timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(child.kill).toHaveBeenCalled();
  });

  // EI-19479764372783341. Landing unconfined is a legitimate degrade (a box with
  // no systemd user scopes still gets a sidecar), but it silently restores the
  // original hazard — the child shares bg-host's cgroup and dies with it — so it
  // must never be silent. Asserted here rather than merely muted, and asserted
  // ONCE-per-process because the probe result is cached: a per-spawn warning
  // would repeat on every crash-respawn.
  it('says so, exactly once, when the sidecar lands UNCONFINED (the cgroup hazard is back)', async () => {
    // console.LOG, not warn: under a test runner the notice is emitted on the
    // channel `vitest-fail-on-console` does not police (EI-20006410617437313).
    // The message, and the exactly-once latch this case exists to pin, are
    // unchanged — only the channel moves, and only under test.
    const logged = console.log as unknown as ReturnType<typeof vi.fn>;
    const first = makeChild();
    spawnMock.mockReturnValueOnce(first);
    const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
    first.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;

    const unconfined = logged.mock.calls.filter((c) => String(c[0]).includes('UNCONFINED'));
    expect(unconfined).toHaveLength(1);
    expect(String(unconfined[0][0])).toContain('EI-19479764372783341');

    // A LATER spawn in the same process must not repeat it — the probe result is
    // cached, so the condition never changes and re-stating it is pure noise.
    // Driven by a deliberate stop + respawn rather than a crash, to keep this
    // case about the warning instead of the respawn machinery.
    await stopSpawnerSidecar();
    const second = makeChild();
    spawnMock.mockReturnValueOnce(second);
    const again = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
    second.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await again;

    expect(logged.mock.calls.filter((c) => String(c[0]).includes('UNCONFINED'))).toHaveLength(1);
  });

  it('EI-8810: never hands the child the parent HTTP port or the background-worker role', async () => {
    // The 2026-07-09 incident: the child inherited the parent's
    // PAPERCUSP_HONO_PORT=3270 (+ PORT, set by startRequestServers) and — when
    // the re-exec'd entry missed the *_SIDECAR_MODE divert — booted a FULL
    // hono-host on the parent's own port: EADDRINUSE → fatal exit → warm-up
    // respawn, forever. The spawn env must force port 0 (ephemeral) and
    // background-workers OFF regardless of what the parent env carries.
    process.env.PAPERCUSP_HONO_PORT = '3270';
    process.env.PORT = '3270';
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    try {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      expect(opts.env?.PAPERCUSP_HONO_PORT).toBe('0');
      expect(opts.env?.PORT).toBe('0');
      expect(opts.env?.PAPERCUSP_BACKGROUND_WORKERS).toBe('0');
    } finally {
      delete process.env.PAPERCUSP_HONO_PORT;
      delete process.env.PORT;
      delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
    }
  });

  it('WI-6132: caps the child org pools at 2 — the parent PAPERCUSP_DB_POOL_MAX must not leak in', async () => {
    // Each sidecar otherwise opens its own admin+app pool at full profile size
    // (or the parent's operator-sized override); measured 2026-08-02, sidecars
    // were 28 of 39 per-process org-admin pools on the box.
    process.env.PAPERCUSP_DB_POOL_MAX = '24';
    try {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      expect(opts.env?.PAPERCUSP_DB_POOL_MAX).toBe('2');
    } finally {
      delete process.env.PAPERCUSP_DB_POOL_MAX;
    }
  });

  it('WI-6132: PAPERCUSP_SIDECAR_DB_POOL_MAX is the deliberate escape hatch for the child cap', async () => {
    process.env.PAPERCUSP_SIDECAR_DB_POOL_MAX = '5';
    try {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      expect(opts.env?.PAPERCUSP_DB_POOL_MAX).toBe('5');
    } finally {
      delete process.env.PAPERCUSP_SIDECAR_DB_POOL_MAX;
    }
  });

  // P-006 (plan p2p-parity-parallel-lanes-2026-07-09): the sidecar respawn
  // churn. Root cause — the shared `uncaughtException` shutdown hook fired
  // (and killed a HEALTHY sidecar) on every benign `write EPIPE` a client
  // disconnect throws, which hono-host's own guard already classifies benign
  // and swallows. `registerSpawnerSidecarShutdownHooks` must gate on that same
  // classification so a benign process-wide exception no longer tears the
  // sidecar down (and triggers a warm-respawn + a fresh `[swarm] DHT
  // bootstrap` the next time a caller needs it).
  describe('registerSpawnerSidecarShutdownHooks (P-006 — benign-exception gate)', () => {
    beforeEach(() => {
      _resetSidecarShutdownHookRegistryForTests();
    });
    afterEach(() => {
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
    });

    const newestUncaughtExceptionListener = (): ((err: unknown) => unknown) => {
      const listeners = process.listeners('uncaughtException');
      return listeners[listeners.length - 1] as (err: unknown) => unknown;
    };

    it('a benign write EPIPE (client disconnect) does NOT stop a running sidecar', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      registerSpawnerSidecarShutdownHooks();
      await newestUncaughtExceptionListener()(
        Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      );

      expect(child.kill).not.toHaveBeenCalled();
      expect(isSpawnerSidecarRunning()).toBe(true);
    });

    it('a genuinely fatal uncaught exception still stops the sidecar', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      registerSpawnerSidecarShutdownHooks();
      await newestUncaughtExceptionListener()(new TypeError('a real bug, not EPIPE'));

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      warn.mockRestore();
    });
  });

  // EI-24863236643374267: measured 2026-10-02 11:49:26-33Z on bg-host — the sidecar
  // was stopped by its own SIGTERM listener BEFORE the host drain began, so every git
  // call of the ~10 s drain forked on the host's main thread (256-512 ms each).
  describe('host drain keeps the sidecar up until exit (EI-24863236643374267)', () => {
    beforeEach(() => {
      _resetSidecarShutdownHookRegistryForTests();
      __resetShutdownStateForTest();
    });
    afterEach(() => {
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
      __resetShutdownStateForTest();
    });

    const newestSigtermListener = (): (() => unknown) => {
      const listeners = process.listeners('SIGTERM');
      return listeners[listeners.length - 1] as () => unknown;
    };

    async function readySidecar(): Promise<FakeChild> {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;
      return child;
    }

    it('with a drain armed, SIGTERM leaves the sidecar running; the before-exit hook stops it', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const child = await readySidecar();
      registerSpawnerSidecarShutdownHooks();
      markGracefulDrainInstalled();

      await newestSigtermListener()();
      expect(child.kill).not.toHaveBeenCalled();
      expect(isSpawnerSidecarRunning()).toBe(true);

      runBeforeHostExitHooks();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      log.mockRestore();
    });

    it('with NO drain armed (cluster primary, short-lived CLI), SIGTERM still stops it at once', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const child = await readySidecar();
      registerSpawnerSidecarShutdownHooks();

      await newestSigtermListener()();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      log.mockRestore();
    });

    it('a sidecar crash DURING the drain is not respawned', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const child = await readySidecar();
      markShuttingDown();

      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawnMock).toHaveBeenCalledTimes(1); // the original spawn only
      warn.mockRestore();
    });
  });

  // P-006 (critical-process-supervisor-2026-07-04): the spawner sidecar previously
  // had NO auto-respawn-on-crash at all (unlike its substrate-sidecar sibling,
  // WI-1504) — an unexpected exit just cleared state and waited for the next
  // caller to lazily re-spawn it. This block locks in the added mechanism,
  // cloned from substrate-sidecar-spawn.ts's (same shared helpers, same numbers).
  describe('auto-respawn-on-crash (P-006)', () => {
    it('does not let the respawn backoff keep a finished short-lived host alive', async () => {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const first = makeChild();
      spawnMock.mockReturnValueOnce(first);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      first.emit('exit', 0);

      const backoffCall = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === respawnBackoffMs(1));
      expect(backoffCall).toBeGreaterThanOrEqual(0);
      const timer = timeoutSpy.mock.results[backoffCall]?.value as ReturnType<typeof setTimeout>;
      expect(typeof timer.hasRef).toBe('function');
      expect(timer.hasRef()).toBe(false);
    });

    it('auto-respawns after an unexpected post-ready exit', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = makeChild();
      const second = makeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;
      expect(getSpawnerSidecarProcess()).toBe(first);

      first.emit('exit', 137);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-respawning'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      second.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await vi.runAllTicks();
      expect(getSpawnerSidecarProcess()).toBe(second);
    });

    it('isStopping-equivalent guard: a deliberate stopSpawnerSidecar() never schedules a respawn', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      const stopPromise = stopSpawnerSidecar();
      child.emit('exit', 0); // the deliberate-stop exit
      await stopPromise;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1); // no respawn
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('died'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('auto-respawning'));
    });

    it('MAX_RESPAWN_ATTEMPTS crashes within the window give up auto-respawning', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = makeChild();
      spawnMock.mockReturnValueOnce(first);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      let current = first;
      for (let i = 0; i < MAX_RESPAWN_ATTEMPTS; i++) {
        const next = makeChild();
        spawnMock.mockReturnValueOnce(next);
        current.emit('exit', 137);
        // Advance EXACTLY this attempt's backoff (never more) then immediately emit
        // ready on the new child, with zero elapsed time in between — unlike
        // substrate's killSidecarTree (a real process-group kill that no-ops
        // against a fake pid in tests), spawner's internal 10s ready-handshake
        // timeout directly calls `sidecarProcess.kill()`, which THIS suite's
        // mock synchronously turns into a real 'exit' emission. Blindly
        // overshooting the advance (e.g. a flat 20s) would let that internal
        // timeout fire first and double-count a respawn attempt.
        await vi.advanceTimersByTimeAsync(respawnBackoffMs(i + 1));
        next.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
        await vi.runAllTicks();
        current = next;
      }
      expect(spawnMock).toHaveBeenCalledTimes(MAX_RESPAWN_ATTEMPTS + 1);
      expect(spawnerSidecarSupervisionStatus().gaveUp).toBe(false);

      const spawnCallsBefore = spawnMock.mock.calls.length;
      current.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnMock).toHaveBeenCalledTimes(spawnCallsBefore); // no further respawn
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('giving up auto-respawn'));
      expect(spawnerSidecarSupervisionStatus().gaveUp).toBe(true);
    });
  });

  describe('spawnerSidecarSupervisionStatus (P-006 — dev:service_health feed)', () => {
    it('reports running:true + zero flap counters for a healthy, never-crashed sidecar', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      expect(spawnerSidecarSupervisionStatus()).toEqual({
        running: true,
        respawnAttemptsInWindow: 0,
        gaveUp: false,
        lastRespawnScheduledAt: null,
      });
    });

    it('reports running:false + no state when nothing has ever spawned', () => {
      expect(spawnerSidecarSupervisionStatus()).toEqual({
        running: false,
        respawnAttemptsInWindow: 0,
        gaveUp: false,
        lastRespawnScheduledAt: null,
      });
    });
  });
});

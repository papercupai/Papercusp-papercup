/**
 * host-recycle.test.ts — the memory-watchdog onTrip drain path (audit P-002).
 *
 * Proves the recycle tears down the P2P substrate before exiting, exits only
 * after BOTH the HTTP drain and the substrate teardown complete, survives a
 * teardown failure, and hard-exits when either side hangs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gracefulHostRecycle,
  installGracefulShutdown,
  installFatalDiagnostics,
  _resetFatalDiagnosticsForTests,
  type RecycleServerLike,
} from './host-recycle';
import { __resetShutdownStateForTest, isGracefulDrainInstalled, onBeforeHostExit } from './shutdown-state';

describe('gracefulHostRecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeServer(): { server: RecycleServerLike; drain: () => void } {
    let cb: (() => void) | undefined;
    return {
      server: {
        close: (c?: () => void) => {
          cb = c;
        },
      },
      drain: () => cb?.(),
    };
  }

  it('closes the substrate and exits with the recycle code (non-zero, default 75) after BOTH the drain and teardown complete', async () => {
    const exit = vi.fn();
    let resolveSubstrate!: () => void;
    const closeSubstrate = vi.fn(
      () => new Promise<void>((r) => (resolveSubstrate = r)),
    );
    const { server, drain } = makeServer();

    gracefulHostRecycle({ server, exit, closeSubstrate });
    expect(closeSubstrate).toHaveBeenCalledTimes(1); // teardown starts immediately

    // HTTP drained but substrate still closing → no exit yet.
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();

    // Substrate done → exit 0, exactly once.
    resolveSubstrate();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('a substrate-teardown failure does not block the recycle', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.reject(new Error('boom')));
    const { server, drain } = makeServer();

    gracefulHostRecycle({ server, exit, closeSubstrate });
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('hard-exits after hardExitMs when the HTTP drain hangs', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server } = makeServer(); // drain never called

    gracefulHostRecycle({ server, exit, closeSubstrate, hardExitMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('hard-exits after hardExitMs when the substrate teardown hangs', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const { server, drain } = makeServer();

    gracefulHostRecycle({ server, exit, closeSubstrate, hardExitMs: 1000 });
    drain();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('exits via the backstop when the server has no close fn (never double-exits)', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    gracefulHostRecycle({ server: {}, exit, closeSubstrate, hardExitMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  });

  it('exits NON-ZERO by default so the recycle restarts under Restart=on-failure too (EI-1613, R4-1)', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    gracefulHostRecycle({ server, exit, closeSubstrate });
    drain();
    await vi.advanceTimersByTimeAsync(0);
    const code = exit.mock.calls[0]?.[0];
    expect(code).toBe(75);
    expect(code).not.toBe(0);
  });

  it('honors an explicit recycleExitCode', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    gracefulHostRecycle({ server, exit, closeSubstrate, recycleExitCode: 42 });
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(42);
  });

  // WI-3795: a cluster-wide SIGTERM broadcast races the substrate teardown
  // against a native Napi::Error/SIGABRT crash when the loop is already
  // critically saturated — skip attempting the close in that case instead of
  // starting a native op that can crash the process below the JS layer.
  describe('WI-3795 — skip substrate teardown when the loop is critically saturated', () => {
    it('does NOT call closeSubstrate when isSaturated() reads true, and still exits cleanly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => true);
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated });
      expect(closeSubstrate).not.toHaveBeenCalled();

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(closeSubstrate).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('still calls closeSubstrate as normal when isSaturated() reads false', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => false);
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated });
      expect(closeSubstrate).toHaveBeenCalledTimes(1);

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });

    it('defaults isSaturated to the real event-loop-lag monitor (isLoopElevated), which reads false absent a running monitor (no behavior change when unconfigured)', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate }); // no isSaturated override
      expect(closeSubstrate).toHaveBeenCalledTimes(1); // no monitor running in this test process → not saturated

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });
  });

  // EI-9649: a MEMORY-watchdog recycle trips when RSS is over the cap — i.e. the
  // substrate is large — and can fire while the event loop is NOT yet elevated,
  // so the WI-3795 isSaturated skip does not catch it and the risky native
  // substrate close runs and throws an uncaught Napi::Error → SIGABRT below the
  // JS layer (a routine recycle becomes a hard crash + webview reconnect flash).
  // skipSubstrateTeardown lets the memory-recycle caller opt out of the native
  // close unconditionally (the process exits anyway; the OS reclaims the handles).
  describe('EI-9649 — skipSubstrateTeardown never starts the native substrate close', () => {
    it('does NOT call closeSubstrate when skipSubstrateTeardown is true, and still exits cleanly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, skipSubstrateTeardown: true });
      expect(closeSubstrate).not.toHaveBeenCalled(); // the risky native op is never started

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(closeSubstrate).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('skips even when the loop is NOT saturated (the EI-9649 gap: a memory recycle in a calm loop)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => false); // calm loop → WI-3795 skip would NOT fire
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated, skipSubstrateTeardown: true });
      // skipSubstrateTeardown wins regardless of the isSaturated verdict.
      expect(closeSubstrate).not.toHaveBeenCalled();

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      warnSpy.mockRestore();
    });

    it('defaults to false — the SIGTERM/lag paths still close the substrate as before', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate }); // no skipSubstrateTeardown
      expect(closeSubstrate).toHaveBeenCalledTimes(1);

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });
  });

  it('closes additional process resources even when native substrate teardown is skipped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const closeAdditionalResources = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();

    gracefulHostRecycle({
      server,
      exit,
      closeSubstrate,
      closeAdditionalResources,
      skipSubstrateTeardown: true,
    });

    expect(closeAdditionalResources).toHaveBeenCalledTimes(1);
    expect(closeSubstrate).not.toHaveBeenCalled();
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    warnSpy.mockRestore();
  });

  // EI-16949: whenever the real substrate teardown is SKIPPED (either the
  // WI-3795 isSaturated race-avoidance or the EI-9649 skipSubstrateTeardown
  // opt-out), the pure-JS replication-liveness registry cleanup must still
  // run — otherwise a latched stall alarm's durable EI is orphaned forever
  // (no future process ever resamples that dead host's logKeyHex). See
  // dropAllReplicationLivenessTracking (boot-all.ts) for the orphaned-EI leak
  // this closes.
  describe('EI-16949 — dropReplicationTracking runs whenever the real substrate teardown is skipped', () => {
    it('calls dropReplicationTracking when isSaturated() reads true (WI-3795 skip)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const isSaturated = vi.fn(() => true);
      const dropReplicationTracking = vi.fn(() => Promise.resolve(['ws/harness']));
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, isSaturated, dropReplicationTracking });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      expect(dropReplicationTracking).toHaveBeenCalledTimes(1);
      expect(closeSubstrate).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      warnSpy.mockRestore();
    });

    it('calls dropReplicationTracking when skipSubstrateTeardown is true (EI-9649 skip)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const dropReplicationTracking = vi.fn(() => Promise.resolve(['ws/harness']));
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit,
        closeSubstrate,
        skipSubstrateTeardown: true,
        dropReplicationTracking,
      });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      expect(dropReplicationTracking).toHaveBeenCalledTimes(1);
      expect(closeSubstrate).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      warnSpy.mockRestore();
    });

    it('does NOT call dropReplicationTracking when closeSubstrate runs normally (no skip)', async () => {
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const dropReplicationTracking = vi.fn(() => Promise.resolve([]));
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, closeSubstrate, dropReplicationTracking });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      expect(closeSubstrate).toHaveBeenCalledTimes(1);
      expect(dropReplicationTracking).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    });

    it('a dropReplicationTracking failure is best-effort and never blocks the recycle', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const dropReplicationTracking = vi.fn(() => Promise.reject(new Error('boom')));
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit,
        closeSubstrate,
        skipSubstrateTeardown: true,
        dropReplicationTracking,
      });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      expect(dropReplicationTracking).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      warnSpy.mockRestore();
    });

    it('defaults to the real dropAllReplicationLivenessTracking when unconfigured (no behavior change when unconfigured)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      // No dropReplicationTracking override — exercises the real default
      // (dropAllReplicationLivenessTracking), which is a safe, PG/native-free
      // no-op here since no harness handle is booted in this test process.
      gracefulHostRecycle({ server, exit, closeSubstrate, skipSubstrateTeardown: true });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      expect(closeSubstrate).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      warnSpy.mockRestore();
    });
  });

  // EI-10702: skipSubstrateTeardown did NOT prevent the Napi::Error/SIGABRT
  // (exit 134). The WI-3849 coredumps proved the abort is thrown during Node's
  // ENV TEARDOWN on process.exit() by a native addon (onnxruntime-node/node-pty/
  // sharp), not by the P2P substrate close the flag skips. hardExitOnRecycle
  // makes the memory recycle SIGKILL itself once the HTTP drain is done — a
  // no-cleanup exit that runs no native destructor/callback, so the abort has no
  // path to fire. The regression guard: the memory recycle must take the
  // no-cleanup exit path (killSelf), NOT process.exit (which runs the teardown
  // that aborts).
  describe('EI-10702 — hardExitOnRecycle exits without running Node native teardown (no SIGABRT)', () => {
    it('SIGKILLs self (no-cleanup exit) after the drain, and does NOT call process.exit', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit,
        killSelf,
        closeSubstrate,
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
      });

      drain();
      await vi.advanceTimersByTimeAsync(0);
      // The no-cleanup path is taken exactly once; process.exit — which would run
      // the native env teardown that throws Napi::Error → SIGABRT — is never used.
      expect(killSelf).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('still drains HTTP FIRST — killSelf only fires after server.close completes', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit: vi.fn(),
        killSelf,
        closeSubstrate,
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
      });
      // In-flight HTTP not yet drained → no exit of any kind.
      await vi.advanceTimersByTimeAsync(0);
      expect(killSelf).not.toHaveBeenCalled();

      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(killSelf).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('the hard-exit backstop also takes the no-cleanup path when the drain hangs', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exit = vi.fn();
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server } = makeServer(); // drain never called

      gracefulHostRecycle({
        server,
        exit,
        killSelf,
        closeSubstrate,
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
        hardExitMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      // A hung drain must still avoid the SIGABRT — the backstop SIGKILLs, it does
      // not process.exit.
      expect(killSelf).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('never double-exits: killSelf fires exactly once even if drain + backstop both fire', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit: vi.fn(),
        killSelf,
        closeSubstrate,
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
        hardExitMs: 1000,
      });
      drain();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000); // backstop would fire too
      expect(killSelf).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    // EI-24863236643374267: children kept alive THROUGH the drain (the spawner
    // sidecar) are stopped by beforeExit. The self-SIGKILL never fires Node's 'exit'
    // event, so beforeExit must run first — and once, even when drain + backstop race.
    it('runs beforeExit BEFORE killSelf, exactly once, even if drain + backstop both fire', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const order: string[] = [];
      const killSelf = vi.fn(() => order.push('killSelf'));
      const beforeExit = vi.fn(() => order.push('beforeExit'));
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit: vi.fn(),
        killSelf,
        beforeExit,
        closeSubstrate: () => Promise.resolve(),
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
        hardExitMs: 1000,
      });
      expect(beforeExit).not.toHaveBeenCalled(); // not at drain START — the sidecar must serve the drain
      drain();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['beforeExit', 'killSelf']);
      warnSpy.mockRestore();
    });

    it('a throwing beforeExit does not block the exit', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSelf = vi.fn();
      gracefulHostRecycle({
        server: {},
        exit: vi.fn(),
        killSelf,
        beforeExit: () => {
          throw new Error('boom');
        },
        closeSubstrate: () => Promise.resolve(),
        hardExitOnRecycle: true,
        hardExitMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(killSelf).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('by default runs the shutdown-state before-exit hooks (where the spawner sidecar registers its stop)', async () => {
      __resetShutdownStateForTest();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const order: string[] = [];
      onBeforeHostExit('test-sidecar', () => order.push('hook'));
      const { server, drain } = makeServer();
      gracefulHostRecycle({
        server,
        exit: vi.fn(),
        killSelf: () => order.push('killSelf'),
        closeSubstrate: () => Promise.resolve(),
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
      });
      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['hook', 'killSelf']);
      warnSpy.mockRestore();
      __resetShutdownStateForTest();
    });

    it('defaults to false — a normal recycle still uses process.exit (no behavior change)', async () => {
      const exit = vi.fn();
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({ server, exit, killSelf, closeSubstrate }); // no hardExitOnRecycle
      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(75);
      expect(killSelf).not.toHaveBeenCalled();
    });

    // EI-16447: the hard-exit log line used to hardcode "a memory-watchdog
    // recycle" for EVERY hardExitOnRecycle caller (memory-watchdog trip,
    // SIGTERM/SIGINT drain, lag-self-restart alike) — a false attribution that
    // sent a real investigation (WI-5434) chasing a phantom RSS leak for hours
    // when the actual restart storm was an intentional SIGTERM-triggered timer
    // (papercup-staging-sync). `reason` must be caller-controlled and must NOT
    // default to anything memory-watchdog-specific.
    it('folds an explicit reason into the hard-exit log line instead of a hardcoded memory-watchdog attribution', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit: vi.fn(),
        killSelf,
        closeSubstrate,
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
        reason: 'an event-loop lag-self-restart recycle',
      });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      const hardExitLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[host-recycle] hard-exit'));
      expect(hardExitLine).toContain('an event-loop lag-self-restart recycle');
      expect(hardExitLine).not.toContain('memory-watchdog');
      warnSpy.mockRestore();
    });

    it('defaults the hard-exit reason to a generic, non-memory-watchdog-specific phrase when no reason is passed', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSelf = vi.fn();
      const closeSubstrate = vi.fn(() => Promise.resolve());
      const { server, drain } = makeServer();

      gracefulHostRecycle({
        server,
        exit: vi.fn(),
        killSelf,
        closeSubstrate,
        skipSubstrateTeardown: true,
        hardExitOnRecycle: true,
      });
      drain();
      await vi.advanceTimersByTimeAsync(0);

      const hardExitLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[host-recycle] hard-exit'));
      expect(hardExitLine).not.toContain('memory-watchdog');
      warnSpy.mockRestore();
    });
  });
});

describe('installGracefulShutdown (D4/P-017 — SIGTERM connection-drain)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeServer(): { server: RecycleServerLike; drain: () => void } {
    let cb: (() => void) | undefined;
    return { server: { close: (c?: () => void) => { cb = c; } }, drain: () => cb?.() };
  }
  /** A fake `process.on` that captures signal handlers so the test can fire them. */
  function fakeSignals() {
    const handlers = new Map<string, Array<() => void>>();
    const on = (sig: NodeJS.Signals, cb: () => void) => {
      const list = handlers.get(sig) ?? [];
      list.push(cb);
      handlers.set(sig, list);
    };
    const fire = (sig: NodeJS.Signals) => (handlers.get(sig) ?? []).forEach((h) => h());
    return { on, fire, handlers };
  }

  it('marks the graceful drain installed at INSTALL time, before any signal (EI-24863236643374267)', () => {
    __resetShutdownStateForTest();
    expect(isGracefulDrainInstalled()).toBe(false);
    const { on } = fakeSignals();
    installGracefulShutdown({ server: makeServer().server, on, exit: vi.fn(), closeSubstrate: () => Promise.resolve() });
    // A sidecar's SIGTERM listener runs BEFORE this drain's (registered earlier), so the
    // flag it reads must already be set when the signal arrives.
    expect(isGracefulDrainInstalled()).toBe(true);
    __resetShutdownStateForTest();
  });

  it('registers a handler for SIGTERM and SIGINT by default', () => {
    const { on, handlers } = fakeSignals();
    installGracefulShutdown({ server: makeServer().server, on, exit: vi.fn(), closeSubstrate: () => Promise.resolve() });
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('on SIGTERM: drains HTTP + substrate, then exits 0 (intentional stop, NOT the non-zero recycle code)', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({ server, on, exit, closeSubstrate });
    expect(exit).not.toHaveBeenCalled(); // nothing happens until a signal arrives

    fire('SIGTERM');
    expect(closeSubstrate).toHaveBeenCalledTimes(1); // teardown started
    drain(); // in-flight HTTP finished
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('is idempotent: a second signal while draining does not start a second drain', async () => {
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({ server, on, exit, closeSubstrate });
    fire('SIGTERM');
    fire('SIGINT'); // second signal mid-drain → ignored
    fire('SIGTERM');
    expect(closeSubstrate).toHaveBeenCalledTimes(1); // only the first drain ran
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('honors a custom signal list', () => {
    const { on, handlers } = fakeSignals();
    installGracefulShutdown({ server: makeServer().server, on, signals: ['SIGTERM'], exit: vi.fn(), closeSubstrate: () => Promise.resolve() });
    expect([...handlers.keys()]).toEqual(['SIGTERM']);
  });

  // WI-3795: installGracefulShutdown forwards isSaturated through to
  // gracefulHostRecycle so the SIGTERM path (the one a cluster-wide restart
  // actually broadcasts to every worker) gets the same saturated-skip.
  it('forwards isSaturated to gracefulHostRecycle — skips the substrate close on SIGTERM when saturated', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const isSaturated = vi.fn(() => true);
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({ server, on, exit, closeSubstrate, isSaturated });
    fire('SIGTERM');
    expect(closeSubstrate).not.toHaveBeenCalled();
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    warnSpy.mockRestore();
  });

  it('forwards closeAdditionalResources so a SIGTERM closes process-owned LISTEN clients', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const closeAdditionalResources = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({
      server,
      on,
      exit,
      closeSubstrate,
      closeAdditionalResources,
      isSaturated: () => true,
    });
    fire('SIGTERM');

    expect(closeAdditionalResources).toHaveBeenCalledTimes(1);
    expect(closeSubstrate).not.toHaveBeenCalled();
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    warnSpy.mockRestore();
  });

  it('can drain SIGTERM and then hard-exit without running Node native teardown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const killSelf = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({
      server,
      on,
      exit,
      killSelf,
      closeSubstrate,
      hardExitOnRecycle: true,
    });
    fire('SIGTERM');
    expect(killSelf).not.toHaveBeenCalled();
    drain();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeSubstrate).toHaveBeenCalledTimes(1);
    expect(killSelf).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // EI-11785: on a sanctioned staging restart the SIGTERM drain wedged in
  // do_exit past the service's TimeoutStopSec — active native handles
  // (onnxruntime/node-pty/sharp) kept the drain from completing, and the eventual
  // process.exit ran Node's env teardown that throws the uncaught Napi::Error →
  // a multi-minute test outage. The recurrence guard: SIGTERM with a drain that
  // NEVER completes (the wedged-handle case) must still force-exit via the
  // no-cleanup backstop (killSelf), NOT process.exit, and it must do so within
  // the bounded hardExitMs window — i.e. well before any systemd stop deadline.
  it('SIGTERM with a wedged drain still hard-exits via the backstop before the deadline (never process.exit)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn();
    const killSelf = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    // Server whose close callback NEVER fires — models active native handles
    // that keep the in-flight HTTP drain from ever completing.
    const server: RecycleServerLike = { close: () => {} };
    const { on, fire } = fakeSignals();

    installGracefulShutdown({
      server,
      on,
      exit,
      killSelf,
      closeSubstrate,
      hardExitOnRecycle: true,
      hardExitMs: 8000,
    });
    fire('SIGTERM');

    // Just before the backstop deadline: still alive, no exit of any kind — and
    // crucially process.exit (which would run the Napi::Error env teardown) is
    // never used.
    await vi.advanceTimersByTimeAsync(7999);
    expect(killSelf).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // EI-16447: installGracefulShutdown must attribute its own hard-exit to the
  // SIGNAL that triggered it, never to "memory-watchdog" — see the
  // gracefulHostRecycle reason tests above for the WI-5434 misdiagnosis this
  // guards against.
  it('attributes its hard-exit log line to the triggering signal, not the memory watchdog', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const killSelf = vi.fn();
    const closeSubstrate = vi.fn(() => Promise.resolve());
    const { server, drain } = makeServer();
    const { on, fire } = fakeSignals();

    installGracefulShutdown({
      server,
      on,
      exit: vi.fn(),
      killSelf,
      closeSubstrate,
      hardExitOnRecycle: true,
    });
    fire('SIGTERM');
    drain();
    await vi.advanceTimersByTimeAsync(0);

    expect(killSelf).toHaveBeenCalledTimes(1);
    const hardExitLine = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[host-recycle] hard-exit'));
    expect(hardExitLine).toContain('SIGTERM');
    expect(hardExitLine).not.toContain('memory-watchdog');
    warnSpy.mockRestore();
  });
});

// WI-3849: arms Node's diagnostic-report-on-SIGABRT so the next native
// Napi::Error/SIGABRT crash captures a symbolized stack automatically.
describe('installFatalDiagnostics (WI-3849 — diagnostic report on native SIGABRT)', () => {
  beforeEach(() => _resetFatalDiagnosticsForTests());
  afterEach(() => _resetFatalDiagnosticsForTests());

  function fakeReport() {
    return {} as { directory?: string; signal?: string; reportOnSignal?: boolean; reportOnFatalError?: boolean };
  }

  it('arms reportOnSignal for SIGABRT with reportOnFatalError, and writes a directory', () => {
    const report = fakeReport();
    const mkdir = vi.fn();
    const log = vi.fn();
    installFatalDiagnostics({ report, directory: '/tmp/fake-crash-reports', mkdir, log });

    expect(report.reportOnSignal).toBe(true);
    expect(report.signal).toBe('SIGABRT');
    expect(report.reportOnFatalError).toBe(true);
    expect(report.directory).toBe('/tmp/fake-crash-reports');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('does NOT call mkdir when a report object is injected (test seam skips real fs)', () => {
    const report = fakeReport();
    const mkdir = vi.fn();
    installFatalDiagnostics({ report, directory: '/tmp/fake-crash-reports', mkdir });
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('preserves the launcher-armed report signal and directory while enabling fatal reports', () => {
    const report = { ...fakeReport(), reportOnSignal: true,
      signal: 'SIGWINCH', directory: '/tmp/verifier-startup-reports' };
    const log = vi.fn();
    installFatalDiagnostics({ report, log });

    expect(report.signal).toBe('SIGWINCH');
    expect(report.directory).toBe('/tmp/verifier-startup-reports');
    expect(report.reportOnSignal).toBe(true);
    expect(report.reportOnFatalError).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SIGWINCH'));
  });

  it('is idempotent — a second call is a no-op (does not re-touch the report or re-log)', () => {
    const report = fakeReport();
    const log = vi.fn();
    installFatalDiagnostics({ report, directory: '/tmp/a', mkdir: vi.fn(), log });
    report.signal = 'SIGUSR2'; // simulate something else mutating it after install
    installFatalDiagnostics({ report, directory: '/tmp/b', mkdir: vi.fn(), log });

    expect(log).toHaveBeenCalledTimes(1); // only the first call logged
    expect(report.directory).toBe('/tmp/a'); // second call's directory was never applied
    expect(report.signal).toBe('SIGUSR2'); // second call didn't overwrite it either
  });

  it('never throws when process.report is unavailable (best-effort on non-standard Node builds)', () => {
    expect(() => installFatalDiagnostics({ report: undefined })).not.toThrow();
  });

  it('never throws even if the report object itself throws on assignment', () => {
    const throwing = {
      set directory(_v: string) {
        throw new Error('boom');
      },
    } as unknown as { directory?: string; signal?: string; reportOnSignal?: boolean; reportOnFatalError?: boolean };
    expect(() => installFatalDiagnostics({ report: throwing, directory: '/tmp/x', mkdir: vi.fn() })).not.toThrow();
  });
});

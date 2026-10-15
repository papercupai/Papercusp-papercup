/**
 * Unit tests for the shared terminal-spawn helper — the shell-injection
 * guard (`shellEscape`) and terminal discovery (`findTerminal`: honour
 * $TERMINAL, fall back through the list in order, null when none found).
 * `node:fs` existsSync is mocked to simulate which binaries are on PATH.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Native GSettings is exercised under a private bus in psu-gnome-renderer.test.ts.
// These process mocks must never read or write the host desktop's profiles.
const prepareProfileMock = vi.hoisted(() => vi.fn(async (terminal: { bin: string; args: string[] }) => terminal));
vi.mock('./gnome-terminal-profile.mjs', () => ({
  prepareGnomeTerminal: prepareProfileMock,
}));

const existsSyncMock = vi.hoisted(() => vi.fn((_p: string): boolean => false));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: (...a: unknown[]) => existsSyncMock(...(a as [string])) };
});

/**
 * The child shape `spawnInTerminal` actually consumes: a pid, `unref`, an
 * optional stderr stream, and — since WI-37743 — the 'exit'/'error' events the
 * shared early-exit watcher listens for.
 *
 * Declared as the spawn mock's RETURN TYPE rather than cast in at each call
 * site: `as never` would switch off the one check `vi.fn` typing gives us, so
 * the day this shape gains a field the fixtures would go stale invisibly and
 * fail at runtime in some other file (lint:mock-cast-escape). Typing it once
 * here removed all three casts this file used to carry.
 */
type FakeChildStderr = EventEmitter & { resume: () => void; destroy: () => void; unref: () => void };
type FakeChild = EventEmitter & {
  pid: number | undefined;
  unref: () => void;
  stderr?: FakeChildStderr;
};

/** A spawn() stand-in that is a REAL emitter, so the code under test observes
 *  'exit'/'error' the way it does in production. The old plain-object mock
 *  could not emit anything — which is precisely why a fixed sleep was the only
 *  probe shape that was testable, and why the too-early probe survived. */
function makeChild(opts: { pid?: number | undefined; withStderr?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 'pid' in opts ? opts.pid : 55555;
  child.unref = vi.fn();
  if (opts.withStderr) {
    const stderr = new EventEmitter() as FakeChildStderr;
    stderr.resume = vi.fn();
    stderr.destroy = vi.fn();
    stderr.unref = vi.fn();
    child.stderr = stderr;
  }
  return child;
}

const spawnMock = vi.fn((_bin: string, _args: string[], _opts: unknown): FakeChild => makeChild());
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...a: Parameters<typeof spawnMock>) => spawnMock(...a) };
});

import type { DesktopEnvProbes } from './console-spawn';
import { EventEmitter } from 'node:events';
import {
  findTerminal,
  scrubTerminalContextEnv,
  shellEscape,
  spawnInTerminal,
  STDERR_FLUSH_GRACE_MS,
  TERMINAL_CONTEXT_ENV_KEYS,
} from './terminal-spawn';
import { EARLY_EXIT_PROBE_MS } from './console-spawn';

// Deterministic no-desktop-session probes: no /proc scan, no `who` shell-out —
// resolveLinuxDesktopEnv falls through to "no DISPLAY / no X socket" (unresolved)
// unless the test's `env` already carries a DISPLAY, in which case it resolves
// but reports no reachable D-Bus session (desktopSessionDetected:false).
const NO_DESKTOP_PROBES: DesktopEnvProbes = {
  existsSync: () => false,
  readdirSync: () => [],
  uid: 1000,
  home: '/home/x',
  activeSeatDisplays: () => [],
  sessionBus: () => null,
};

// Same, but reports a live desktop session on DISPLAY :1 (so the inherited
// DISPLAY passes resolveLinuxDesktopEnv's live-seat check instead of being
// treated as stale) whose D-Bus bus was resolved (as if gnome-terminal-server
// / gnome-shell were found on the active seat).
const DESKTOP_SESSION_PROBES: DesktopEnvProbes = {
  ...NO_DESKTOP_PROBES,
  activeSeatDisplays: () => [':1'],
  sessionBus: () => 'unix:path=/run/user/1000/bus',
};

describe('shellEscape', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellEscape('/home/x/.cargo/bin/pui')).toBe("'/home/x/.cargo/bin/pui'");
  });

  it('escapes an embedded single quote', () => {
    expect(shellEscape("a'b")).toBe("'a'\\''b'");
  });

  it('neutralises shell metacharacters as one literal token', () => {
    expect(shellEscape('x; rm -rf / $(whoami)')).toBe("'x; rm -rf / $(whoami)'");
  });
});

describe('findTerminal', () => {
  const ORIG_TERMINAL = process.env.TERMINAL;

  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    delete process.env.TERMINAL;
  });

  afterAll(() => {
    if (ORIG_TERMINAL === undefined) delete process.env.TERMINAL;
    else process.env.TERMINAL = ORIG_TERMINAL;
  });

  it('honours $TERMINAL when it is on PATH (generic -e args)', () => {
    process.env.TERMINAL = 'kitty';
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/kitty'));
    expect(findTerminal()).toEqual({ bin: 'kitty', args: ['-e'] });
  });

  it('uses gnome-terminal special args when $TERMINAL=gnome-terminal', () => {
    process.env.TERMINAL = 'gnome-terminal';
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/gnome-terminal'));
    expect(findTerminal()).toEqual({ bin: 'gnome-terminal', args: ['--wait', '--'] });
  });

  it('falls back to the first installed terminal when only one binary exists (either group order)', () => {
    // No $TERMINAL; gnome-terminal absent, konsole present — konsole is found
    // regardless of which group is tried first, since nothing else is on PATH.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/konsole'));
    expect(findTerminal(process.env, NO_DESKTOP_PROBES)).toEqual({
      bin: 'konsole',
      args: ['--new-window', '-e'],
    });
  });

  it('returns null when no terminal emulator is found', () => {
    existsSyncMock.mockReturnValue(false);
    expect(findTerminal(process.env, NO_DESKTOP_PROBES)).toBeNull();
  });

  // EI-19408594551235977: the actual regression this item tracks. Before the
  // fix, findTerminal always tried gnome-terminal FIRST regardless of whether a
  // desktop session's D-Bus was reachable — exactly the WI-4718/WI-4711 ghosting
  // case (a client-server terminal with no reachable bus hands off to a
  // standalone client that maps no window and lingers).
  describe('desktop-session-aware ordering (WI-4718)', () => {
    beforeEach(() => {
      // Both a client-server (gnome-terminal) and a process-per-window
      // (xterm) emulator are "installed" — the two groups disagree, so the
      // chosen bin reveals which order findTerminal actually used.
      existsSyncMock.mockImplementation(
        (p: string) => String(p).endsWith('/gnome-terminal') || String(p).endsWith('/xterm'),
      );
    });

    it('prefers the client-server terminal (gnome-terminal) when a desktop session is detected', () => {
      expect(findTerminal({ ...process.env, DISPLAY: ':1' }, DESKTOP_SESSION_PROBES)).toEqual({
        bin: 'gnome-terminal',
        args: ['--wait', '--window', '--'],
      });
    });

    it('prefers a process-per-window terminal (xterm) when NO desktop session is detected — the regression', () => {
      // No DISPLAY, no active seat, no X socket, no session bus: exactly the
      // "no reachable D-Bus session" host this item is about. Before the fix
      // this returned gnome-terminal (ghosts); after, it returns xterm.
      expect(findTerminal(process.env, NO_DESKTOP_PROBES)).toEqual({
        bin: 'xterm',
        args: ['-e'],
      });
    });

    it('still finds a healthy desktop DISPLAY-having-but-bus-less host as no-session (falls to xterm)', () => {
      // A DISPLAY resolves fine (env carries it) but no session bus can be
      // found — the exact "client-server terminal would ghost" case from a
      // headless/systemd operator with a stale or absent D-Bus address.
      expect(findTerminal({ ...process.env, DISPLAY: ':1' }, NO_DESKTOP_PROBES)).toEqual({
        bin: 'xterm',
        args: ['-e'],
      });
    });
  });
});

// EI-19385011811175105: the operator sidecar is started from a gnome-terminal
// tab, so it carries that tab's GNOME_TERMINAL_SCREEN. Inheriting it made
// gnome-terminal ask the factory for a screen that no longer exists, print
// "Failed to get screen from object path …" and EXIT 0 with no window — which the
// HUD then reported to the owner as "its terminal closed before the session came
// online. Try launching it again", advice that could never work.
describe('scrubTerminalContextEnv', () => {
  it('drops the gnome-terminal tab identity that broke the HUD launch', () => {
    const out = scrubTerminalContextEnv({
      PATH: '/usr/bin',
      GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/f7136bff_f487_4330_8ff5_966041ee694a',
      GNOME_TERMINAL_SERVICE: ':1.123',
    });
    expect(out.GNOME_TERMINAL_SCREEN).toBeUndefined();
    expect(out.GNOME_TERMINAL_SERVICE).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  it('drops every key in the list and keeps everything else', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', DISPLAY: ':1', HOME: '/home/x' };
    for (const k of TERMINAL_CONTEXT_ENV_KEYS) env[k] = 'stale';
    const out = scrubTerminalContextEnv(env);
    for (const k of TERMINAL_CONTEXT_ENV_KEYS) expect(out[k]).toBeUndefined();
    expect(out).toEqual({ PATH: '/usr/bin', DISPLAY: ':1', HOME: '/home/x' });
  });

  it('does not mutate the caller’s env', () => {
    const env = { GNOME_TERMINAL_SCREEN: 'x' };
    scrubTerminalContextEnv(env);
    expect(env.GNOME_TERMINAL_SCREEN).toBe('x');
  });

  it('keeps the vars a spawned session actually needs', () => {
    // Guards against over-broad scrubbing: DISPLAY/DBUS/XDG are what make the
    // window openable at all, and PAPERCUSP_* is the launch's own identity.
    for (const k of ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'TERM', 'PATH', 'HOME']) {
      expect(TERMINAL_CONTEXT_ENV_KEYS).not.toContain(k);
    }
  });
});

// EI-18696184925888288: the silent-launch-failure guard. `spawnInTerminal` must
// not just check that the OS spawn call didn't throw — a terminal client
// (gnome-terminal against a headless/offscreen display) can exit almost
// immediately even though no window ever actually opened.
//
// WI-37743 rewrote HOW: the old shape slept a fixed 400ms and then polled
// `kill(pid, 0)` ONCE. Measured client death on the HUD launch path is ~870ms,
// so the poll fired ~470ms early, saw a live client, and took the healthy
// branch — which DRAINS the stderr pipe, destroying the only evidence of the
// cause. These tests now drive real 'exit'/'error' events, which is what the
// shared watchEarlyExit + classifyEarlyExit pair (console-spawn's, reused)
// observes.
describe('spawnInTerminal early-exit probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockClear();
    spawnMock.mockReturnValue(makeChild());
    existsSyncMock.mockReturnValue(false);
    // Make gnome-terminal resolvable so findTerminal() succeeds.
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/gnome-terminal'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards the prepared GNOME profile to the new window', async () => {
    prepareProfileMock.mockImplementationOnce(async (terminal) => ({
      ...terminal, args: ['--profile=test-bounded', ...terminal.args],
    }));
    const result = await spawnInTerminal({
      oneliner: 'exec true', earlyExitProbeMs: 0, desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    expect(result.ok).toBe(true);
    expect(spawnMock.mock.calls[0][1]).toContain('--profile=test-bounded');
  });

  it('reports likelyOpened:true when the child outlives the probe window', async () => {
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, terminal: 'gnome-terminal', pid: 55555, likelyOpened: true });
  });

  it('reports likelyOpened:false, with a named reason, when the child dies inside the window', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('exit', 1, null);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(false);
      // The point of the field: WHY, not just that it failed.
      expect(result.failureReason).toContain('exit code 1');
    }
  });

  // THE REGRESSION THIS FIX EXISTS FOR (WI-37743). The old probe slept a fixed
  // 400ms and polled once; the real client death is ~870ms, so it read a live
  // client as healthy. Here the child dies at 870ms — inside the 1200ms shared
  // window, outside the old 400ms one — and MUST be caught.
  it('catches a death at ~870ms that the old fixed 400ms probe reported as healthy', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(400); // the old probe fired here and said "alive"
    await vi.advanceTimersByTimeAsync(470); // ~870ms: the client actually dies
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('exit', 1, null);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.likelyOpened).toBe(false);
    expect(EARLY_EXIT_PROBE_MS).toBeGreaterThan(870);
  });

  // A spawn 'error' means the binary never ran — the LEAST ambiguous failure
  // there is. The old shape skipped its check entirely when `child.pid` was
  // undefined, so this was the one case that failed OPEN.
  it('reports a spawn error (binary never ran) instead of failing open', async () => {
    const child = makeChild({ pid: undefined });
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('error', Object.assign(new Error('spawn gnome-terminal ENOENT'), { code: 'ENOENT' }));
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(false);
      expect(result.failureReason).toContain('ENOENT');
      expect(result.failureReason).toContain('never ran');
    }
  });

  it('earlyExitProbeMs:0 skips the probe entirely (likelyOpened:true, no wait)', async () => {
    const result = await spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 0,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(true);
      expect(result.failureReason).toBeUndefined();
    }
  });

  // The fix itself: whatever the caller hands us, the child must not receive the
  // terminal identity of the tab the OPERATOR was started in.
  it('scrubs inherited terminal-context vars from the spawned env', async () => {
    const p = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 0,
      desktopEnvProbes: NO_DESKTOP_PROBES,
      env: {
        PATH: '/usr/bin',
        DISPLAY: ':1',
        GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/dead',
        GNOME_TERMINAL_SERVICE: ':1.123',
        TMUX: '/tmp/tmux-1000/default,1,0',
      },
    });
    await p;
    const env = (spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.GNOME_TERMINAL_SCREEN).toBeUndefined();
    expect(env.GNOME_TERMINAL_SERVICE).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.DISPLAY).toBe(':1');
    expect(env.PATH).toBe('/usr/bin');
  });

  // Exit code 0 is what a silent gnome-terminal failure looks like, so stderr is
  // the only evidence there is — capture it and hand it back so the caller can
  // say WHY instead of "the terminal closed".
  it('returns the emulator’s stderr when it died without opening a window', async () => {
    const child = makeChild({ withStderr: true });
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.stderr?.emit(
      'data',
      '# Error creating terminal: Failed to get screen from object path /org/gnome/Terminal/screen/dead\n',
    );
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(STDERR_FLUSH_GRACE_MS);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(false);
      expect(result.stderr).toContain('Failed to get screen from object path');
    }
    // Dead child ⇒ safe to close the pipe.
    expect(child.stderr?.destroy).toHaveBeenCalled();
  });

  // WI-37743: 'exit' can fire before the last 'data' event lands, and on the
  // failure path that text is the ONLY evidence of the cause — so a late flush
  // must still be captured rather than raced away.
  it('still captures stderr that arrives AFTER the exit event', async () => {
    const child = makeChild({ withStderr: true });
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('exit', 1, null);
    // Let the awaiting code resume so the flush listener is actually attached —
    // an 'end' emitted before that would be missed and the flush would sit out
    // its full grace instead (which is what this test caught the first time).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.stderr?.emit('data', 'Cannot open display: :99\n');
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.stderr?.emit('end');
    // Backstop: even if the fast path were missed, the bounded grace must end
    // the wait — this assertion must never be able to hang.
    await vi.advanceTimersByTimeAsync(STDERR_FLUSH_GRACE_MS);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stderr).toContain('Cannot open display');
  });

  it('never destroys a LIVE child’s stderr (EPIPE would kill the new window)', async () => {
    const child = makeChild({ withStderr: true });
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stderr).toBeUndefined();
    expect(child.stderr?.destroy).not.toHaveBeenCalled();
    expect(child.stderr?.resume).toHaveBeenCalled();
  });

  // A clean exit 0 is only a failure under `--wait` semantics — the classifier's
  // rule, shared with console-spawn, not re-decided here.
  it('does NOT flag a clean exit 0 as failed when the emulator has no --wait', async () => {
    existsSyncMock.mockImplementation((p: string) => String(p).endsWith('/konsole'));
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({
      oneliner: 'exec true',
      earlyExitProbeMs: 400,
      desktopEnvProbes: NO_DESKTOP_PROBES,
      env: { PATH: '/usr/bin', TERMINAL: 'konsole' },
    });
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('exit', 0, null);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(true);
      expect(result.failureReason).toBeUndefined();
    }
  });

  it('defaults to the shared EARLY_EXIT_PROBE_MS window when none is given', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);
    const resultPromise = spawnInTerminal({ oneliner: 'exec true', desktopEnvProbes: NO_DESKTOP_PROBES });
    // One tick short of the shared window: still watching, nothing concluded.
    await vi.advanceTimersByTimeAsync(EARLY_EXIT_PROBE_MS - 1);
    await vi.advanceTimersByTimeAsync(0); // profile preflight finishes before the child exists
    child.emit('exit', 1, null);
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.likelyOpened).toBe(false);
      expect(result.failureReason).toContain(String(EARLY_EXIT_PROBE_MS));
    }
  });
});

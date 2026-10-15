import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseWmctrlList,
  selectOnDesktopSessions,
  listOpenWindows,
  __resetDesktopLivenessCache,
  parseActiveWindowId,
  ownerOwnsWindow,
  parsePpidFromStat,
  pidHasWindowAncestor,
  windowOwningPids,
  gatherOnDesktopSessions,
  getActiveWindowId,
  __resetActiveWindowCache,
  X11_PROBE_SIDECAR_VAR,
  type OpenWindow,
  type DesktopCandidateSession,
} from './desktop-window-liveness';
import { WINDOW_TITLE_PREFIX, __resetIsWindowsDesktopHostCache } from './windows-desktop-windows';

const listWindowsByTitleMock = vi.fn();
// vi.hoisted: the mock factory below runs before module-level consts initialize,
// and it configures this mock at factory time.
const { execFileViaSidecarMock } = vi.hoisted(() => ({ execFileViaSidecarMock: vi.fn() }));

// The X11 probes' spawn seam. Delegates to the REAL implementation unless a test
// stubs a call, so every pre-existing test sees exactly the old behaviour.
vi.mock('./fleet/git-via-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fleet/git-via-sidecar')>();
  execFileViaSidecarMock.mockImplementation(actual.execFileViaSidecar);
  return {
    ...actual,
    execFileViaSidecar: (...args: Parameters<typeof actual.execFileViaSidecar>) =>
      execFileViaSidecarMock(...args),
  };
});

// Keep the real parseSessionIdFromWindowTitle/WINDOW_TITLE_PREFIX/isWindowsDesktopHost
// (desktop-window-liveness.ts's own matcher + platform-detection logic depends on
// them); only listWindowsByTitle — the IO seam — is mocked, so the Windows-desktop-host
// branch of listOpenWindows is unit-testable without a real powershell.exe.
vi.mock('./windows-desktop-windows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./windows-desktop-windows')>();
  return { ...actual, listWindowsByTitle: (...args: unknown[]) => listWindowsByTitleMock(...args) };
});

const realPlatform = process.platform;

/** Override the read-only process.platform for one test. Note: isWindowsDesktopHost()
 *  treats 'win32' as a defensive-fallback true WITHOUT touching /proc/version, so
 *  this alone is enough to drive it here — but its result is CACHED at module scope
 *  (windows-desktop-windows.ts), so every test that flips platform must also reset
 *  that cache (below) or a later test silently inherits a stale true/false. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  __resetDesktopLivenessCache();
  listWindowsByTitleMock.mockReset();
  listWindowsByTitleMock.mockResolvedValue([]);
});

afterEach(() => {
  setPlatform(realPlatform);
  __resetIsWindowsDesktopHostCache();
});

describe('parseWmctrlList (pure wmctrl -lp parser)', () => {
  it('parses <wid> <desktop> <pid> <host> <title> lines, keeping the [adv:N] tag in the title', () => {
    const stdout = [
      '0x04200007  0 469879 thinkpad SH[adv:42]: my plan',
      '0x05000003  1 470001 thinkpad OMP[adv:7]: another',
    ].join('\n');
    const out = parseWmctrlList(stdout);
    expect(out).toEqual<OpenWindow[]>([
      { wid: '0x04200007', pid: 469879, title: 'SH[adv:42]: my plan' },
      { wid: '0x05000003', pid: 470001, title: 'OMP[adv:7]: another' },
    ]);
  });

  it('skips blank lines and lines without a 0x… window id', () => {
    const stdout = ['', '   ', 'garbage line no wid', '0x1 0 100 host title'].join('\n');
    expect(parseWmctrlList(stdout).map((w) => w.wid)).toEqual(['0x1']);
  });

  it('a non-numeric or zero pid maps to null (never a spurious 0/NaN match key)', () => {
    const out = parseWmctrlList(['0x1 0 0 host t', '0x2 0 notapid host t'].join('\n'));
    expect(out.map((w) => w.pid)).toEqual([null, null]);
  });

  it('preserves multi-word titles (collapsed whitespace is fine for tag matching)', () => {
    expect(parseWmctrlList('0x1 0 5 host a  b   c').slice(0, 1)[0].title).toContain('a b c');
  });
});

describe('selectOnDesktopSessions (pure match: which sessions have a live window)', () => {
  const win = (wid: string, pid: number | null, title = ''): OpenWindow => ({ wid, pid, title });
  const sess = (over: Partial<DesktopCandidateSession> & { advSessionId: number }): DesktopCandidateSession => ({
    coordOwnerId: null,
    sessionId: null,
    windowId: null,
    pid: null,
    ...over,
  });

  it('matches by recorded window_id (primary key)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 1, coordOwnerId: 'su-a', sessionId: 'uuid-a', windowId: '0xWID' })],
      [win('0xWID', 999)],
    );
    expect([...sets.owners]).toEqual(['su-a']);
    expect([...sets.sessionIds]).toEqual(['uuid-a']);
    expect([...sets.advSessionIds]).toEqual([1]);
  });

  it('matches by the [adv:<id>] window-title tag when window_id was not captured', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 42, coordOwnerId: 'su-b', windowId: null, pid: null })],
      [win('0xZZ', 123, 'SH[adv:42]: working')],
    );
    expect([...sets.owners]).toEqual(['su-b']);
    expect([...sets.advSessionIds]).toEqual([42]);
  });

  it('matches by recorded pid (fallback for emulators whose window pid == launch pid)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 3, coordOwnerId: 'su-c', pid: 555 })],
      [win('0xWID', 555)],
    );
    expect([...sets.owners]).toEqual(['su-c']);
  });

  it('does NOT match a session whose window is closed (no wid/tag/pid hit)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 9, coordOwnerId: 'su-gone', windowId: '0xCLOSED', pid: 111 })],
      [win('0xOTHER', 222, 'SH[adv:8]: unrelated')],
    );
    expect(sets.owners.size).toBe(0);
    expect(sets.sessionIds.size).toBe(0);
    expect(sets.advSessionIds.size).toBe(0);
  });

  it('empty windows (headless box) or empty sessions → empty sets', () => {
    expect(selectOnDesktopSessions([sess({ advSessionId: 1, windowId: '0x1' })], []).owners.size).toBe(0);
    expect(selectOnDesktopSessions([], [win('0x1', 1)]).owners.size).toBe(0);
  });

  it('a matched session with null owner/sessionId still records its advSessionId (console row)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 5, coordOwnerId: null, sessionId: null, windowId: '0xW' })],
      [win('0xW', 1)],
    );
    expect(sets.owners.size).toBe(0);
    expect(sets.sessionIds.size).toBe(0);
    expect([...sets.advSessionIds]).toEqual([5]);
  });

  describe('Windows title-tag leg (P-019 — matches by `Papercup — <sessionId>`, not wid/pid)', () => {
    it('matches a session by its sessionId embedded in a window title, with no windowId/pid at all', () => {
      const sets = selectOnDesktopSessions(
        [sess({ advSessionId: 7, coordOwnerId: 'su-win', sessionId: 'native-uuid-1', windowId: null, pid: null })],
        [win('0xHWND', 4321, `${WINDOW_TITLE_PREFIX}native-uuid-1`)],
      );
      expect([...sets.owners]).toEqual(['su-win']);
      expect([...sets.sessionIds]).toEqual(['native-uuid-1']);
      expect([...sets.advSessionIds]).toEqual([7]);
    });

    it('does not match when the title carries a DIFFERENT sessionId', () => {
      const sets = selectOnDesktopSessions(
        [sess({ advSessionId: 8, coordOwnerId: 'su-other', sessionId: 'native-uuid-2' })],
        [win('0xHWND', 1, `${WINDOW_TITLE_PREFIX}some-other-session`)],
      );
      expect(sets.owners.size).toBe(0);
    });

    it('a session with no sessionId is never matched by the title leg (only wid/pid/tag can match it)', () => {
      const sets = selectOnDesktopSessions(
        [sess({ advSessionId: 9, coordOwnerId: 'su-none', sessionId: null })],
        [win('0xHWND', 1, `${WINDOW_TITLE_PREFIX}anything`)],
      );
      expect(sets.owners.size).toBe(0);
    });
  });
});

describe('listOpenWindows (TTL-cached wmctrl spawn seam)', () => {
  it('forks wmctrl at most once within the TTL, then refreshes after it expires', async () => {
    const run = vi.fn(() => '0x1 0 100 host SH[adv:1]: x');
    const first = await listOpenWindows({ run, nowMs: 1000, ttlMs: 5000 });
    expect(first).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    // within TTL → cache hit, no second spawn
    await listOpenWindows({ run, nowMs: 4000, ttlMs: 5000 });
    expect(run).toHaveBeenCalledTimes(1);
    // past TTL → re-spawn
    await listOpenWindows({ run, nowMs: 7000, ttlMs: 5000 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed/empty wmctrl run yields [] (headless box / no DISPLAY)', async () => {
    const run = vi.fn(() => null);
    expect(await listOpenWindows({ run, nowMs: 1, ttlMs: 0 })).toEqual([]);
  });
});

// EI-24748208098755918: an async execFile still forks synchronously on the caller's
// event loop, at a cost that scales with the parent's RSS (49.7 ms in one :3070
// worker profile). The presence path probes X11 every few seconds, so both probes
// must go through the spawner-sidecar seam, which falls back locally on its own.
describe('X11 probes fork through the spawner-sidecar seam (EI-24748208098755918)', () => {
  const prevDisplay = process.env.DISPLAY;
  beforeEach(() => {
    __resetActiveWindowCache();
    __resetIsWindowsDesktopHostCache();
    process.env.DISPLAY = ':42';
  });
  afterEach(() => {
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
    execFileViaSidecarMock.mockClear();
  });

  it('listOpenWindows runs wmctrl via execFileViaSidecar, carrying the operator display env', async () => {
    execFileViaSidecarMock.mockResolvedValueOnce({
      stdout: '0x04200007  0 469879 thinkpad SH[adv:42]: my plan\n',
      stderr: '',
    });
    const out = await listOpenWindows();
    expect(out).toEqual<OpenWindow[]>([{ wid: '0x04200007', pid: 469879, title: 'SH[adv:42]: my plan' }]);
    expect(execFileViaSidecarMock).toHaveBeenCalledTimes(1);
    const [command, args, opts] = execFileViaSidecarMock.mock.calls[0];
    expect(command).toBe('wmctrl');
    expect(args).toEqual(['-lp']);
    expect(opts).toMatchObject({
      subsystem: 'desktop-window-liveness:wmctrl',
      sidecarVar: X11_PROBE_SIDECAR_VAR,
      env: { DISPLAY: ':42' },
    });
  });

  it('getActiveWindowId runs xprop via the same seam', async () => {
    execFileViaSidecarMock.mockResolvedValueOnce({
      stdout: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200007\n',
      stderr: '',
    });
    expect(await getActiveWindowId()).toBe(0x4200007);
    const [command, args, opts] = execFileViaSidecarMock.mock.calls[0];
    expect(command).toBe('xprop');
    expect(args).toEqual(['-root', '_NET_ACTIVE_WINDOW']);
    expect(opts).toMatchObject({ subsystem: 'desktop-window-liveness:xprop', env: { DISPLAY: ':42' } });
  });

  it('a failed probe degrades to no windows and unknown focus, never a throw', async () => {
    execFileViaSidecarMock.mockRejectedValueOnce(new Error('wmctrl exited 1'));
    execFileViaSidecarMock.mockRejectedValueOnce(new Error('xprop: unable to open display'));
    await expect(listOpenWindows()).resolves.toEqual([]);
    await expect(getActiveWindowId()).resolves.toBeNull();
  });
});

describe('listOpenWindows — Windows-desktop-host branch (P-019, enumerates via listWindowsByTitle, not wmctrl)', () => {
  it('on a Windows desktop host with no injected deps.run, maps listWindowsByTitle results into OpenWindow[]', async () => {
    setPlatform('win32'); // isWindowsDesktopHost()'s defensive win32 fallback leg — see its own module tests for the real WSL /proc/version leg
    listWindowsByTitleMock.mockResolvedValue([
      { hwnd: '0xABC', pid: 4321, title: `${WINDOW_TITLE_PREFIX}sess-1` },
    ]);
    const windows = await listOpenWindows({ nowMs: 1, ttlMs: 0 });
    expect(windows).toEqual<OpenWindow[]>([{ wid: '0xABC', pid: 4321, title: `${WINDOW_TITLE_PREFIX}sess-1` }]);
    expect(listWindowsByTitleMock).toHaveBeenCalledTimes(1);
  });

  it('a failed/empty listWindowsByTitle yields [] (mirrors the wmctrl fail-soft contract)', async () => {
    setPlatform('win32');
    listWindowsByTitleMock.mockRejectedValue(new Error('no powershell.exe'));
    expect(await listOpenWindows({ nowMs: 1, ttlMs: 0 })).toEqual([]);
  });

  it('an explicitly injected deps.run STILL wins on a Windows desktop host (the test seam always wins)', async () => {
    setPlatform('win32');
    const run = vi.fn(() => '0x1 0 100 host SH[adv:1]: x');
    const windows = await listOpenWindows({ run, nowMs: 1, ttlMs: 0 });
    expect(windows).toHaveLength(1);
    expect(listWindowsByTitleMock).not.toHaveBeenCalled();
  });
});

describe('focused-window attendance (gateway-rayobyte-hardening P-006)', () => {
  it('parseActiveWindowId parses xprop output and normalizes hex numerically', () => {
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200007')).toBe(0x4200007);
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0')).toBeNull(); // no active window
    expect(parseActiveWindowId('garbage')).toBeNull();
  });

  it('ownerOwnsWindow matches the FOCUSED window by wid / pid / [adv:] tag, only for the right owner', () => {
    const windows = [
      { wid: '0x04200007', pid: 111, title: 'claude — su console [adv:42]' },
      { wid: '0x04200009', pid: 222, title: 'fleet member [adv:43]' },
    ];
    const sessions = [
      { advSessionId: 42, coordOwnerId: 'su-human', sessionId: null, windowId: '0x4200007', pid: null },
      { advSessionId: 43, coordOwnerId: 'su-fleet', sessionId: null, windowId: null, pid: 222 },
    ];
    const active = 0x4200007;
    expect(ownerOwnsWindow(sessions, windows, active, 'su-human')).toBe(true); // wid match (xprop short-hex vs wmctrl padded)
    expect(ownerOwnsWindow(sessions, windows, active, 'su-fleet')).toBe(false); // focused window is NOT theirs
    expect(ownerOwnsWindow(sessions, windows, 0x4200009, 'su-fleet')).toBe(true); // pid match on their own window
    expect(ownerOwnsWindow(sessions, windows, 0xdead, 'su-human')).toBe(false); // active window unknown to wmctrl
  });
});

describe('proc-ancestry on-desktop detection (WI-1586 — the launch-capture-free leg)', () => {
  // A /proc/<pid>/stat line: pid (comm) state ppid pgrp session tty_nr tpgid …
  const stat = (pid: number, comm: string, ppid: number) => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304`;

  describe('parsePpidFromStat', () => {
    it('parses ppid from a normal stat line', () => {
      expect(parsePpidFromStat(stat(100, 'node', 42))).toBe(42);
    });

    it('handles comm with spaces and parens (slice after the LAST close-paren)', () => {
      expect(parsePpidFromStat('200 (my (weird) proc) S 77 200 200 0 -1 0')).toBe(77);
    });

    it('garbage / pid-1 root → null (chain ends, never a bogus walk)', () => {
      expect(parsePpidFromStat('garbage')).toBeNull();
      expect(parsePpidFromStat('1 (init) S 0 1 1 0 -1 0')).toBeNull(); // ppid 0
    });
  });

  describe('pidHasWindowAncestor', () => {
    /** In-memory proc tree: pid → [comm, ppid]. */
    const tree = (t: Record<number, number>) => async (pid: number) =>
      t[pid] != null ? stat(pid, 'p', t[pid]) : null;

    it('matches the gnome-terminal shape: host ← shell ← terminal-server (window owner)', async () => {
      // 363663 (psu host) ← 363649 (bash) ← 1357544 (gnome-terminal-server, owns the windows)
      const readStat = tree({ 363663: 363649, 363649: 1357544, 1357544: 1 });
      expect(await pidHasWindowAncestor(363663, new Set([1357544]), readStat)).toBe(true);
    });

    it('matches the pid itself (window pid == the session pid, e.g. standalone emulators)', async () => {
      expect(await pidHasWindowAncestor(500, new Set([500]), tree({}))).toBe(true);
    });

    it('a headless chain (reparented to init / spawned by a service) never matches', async () => {
      const readStat = tree({ 1999914: 1999867, 1999867: 1346348, 1346348: 1 });
      expect(await pidHasWindowAncestor(1999914, new Set([1357544]), readStat)).toBe(false);
    });

    it('a vanished proc mid-walk ends the chain (best-effort, never over-protects on garbage)', async () => {
      const readStat = tree({ 100: 99 }); // 99 has no stat (gone)
      expect(await pidHasWindowAncestor(100, new Set([1357544]), readStat)).toBe(false);
    });

    it('empty window-pid set short-circuits to false', async () => {
      const readStat = vi.fn(async () => stat(1, 'x', 1));
      expect(await pidHasWindowAncestor(100, new Set(), readStat)).toBe(false);
      expect(readStat).not.toHaveBeenCalled();
    });

    it('a ppid CYCLE (corrupt stat) is bounded by the depth cap, not an infinite loop', async () => {
      const readStat = tree({ 100: 200, 200: 100 }); // cycle
      expect(await pidHasWindowAncestor(100, new Set([1357544]), readStat)).toBe(false);
    });
  });

  describe('windowOwningPids', () => {
    it('collects distinct window pids, dropping null/zero', () => {
      const pids = windowOwningPids([
        { wid: '0x1', pid: 1357544, title: 'Terminal' },
        { wid: '0x2', pid: 1357544, title: 'Terminal' },
        { wid: '0x3', pid: null, title: 'no pid' },
      ]);
      expect([...pids]).toEqual([1357544]);
    });
  });
});

describe('gatherOnDesktopSessions — WI-1967 windowSignalUnknown (Windows conservative-on-stale)', () => {
  // listWindows → [] means the PG join is skipped entirely (no getOrgPg), so the
  // windowSignalUnknown computation is unit-tested without a database. isWindowsHost
  // + readWindowsCache are injected so the Windows branch runs off the Linux dev box.
  const noWindows = async (): Promise<OpenWindow[]> => [];

  it('flags unknown on a Windows host when the renderer cache is null (GUI closed/stale push)', async () => {
    const sets = await gatherOnDesktopSessions({
      ttlMs: 0,
      deps: { listWindows: noWindows, isWindowsHost: () => true, readWindowsCache: () => null },
    });
    expect(sets.windowSignalUnknown).toBe(true);
    expect(sets.owners.size).toBe(0); // still empty sets — "unknown", not "someone's here"
  });

  it('does NOT flag unknown when the Windows cache is a fresh EMPTY list (a definite "no windows open")', async () => {
    const sets = await gatherOnDesktopSessions({
      ttlMs: 0,
      deps: { listWindows: noWindows, isWindowsHost: () => true, readWindowsCache: () => [] },
    });
    expect(sets.windowSignalUnknown).toBe(false);
  });

  it('never flags unknown on a non-Windows host, even with a null cache (empty wmctrl = genuinely headless)', async () => {
    const sets = await gatherOnDesktopSessions({
      ttlMs: 0,
      deps: { listWindows: noWindows, isWindowsHost: () => false, readWindowsCache: () => null },
    });
    expect(sets.windowSignalUnknown).toBe(false);
  });
});

describe('gatherOnDesktopSessions targeted owner lookup', () => {
  it('bounds per-owner host checks for a full presence roster', async () => {
    const owners = Array.from({ length: 24 }, (_, i) => `su-owner-${i}`);
    const rows = owners.map((ownerId, i) => ({
      id: i + 1,
      coord_owner_id: ownerId,
      session_id: `session-${i}`,
      window_id: null,
      pid: null,
    }));
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const findHost = vi.fn(async (ownerId: string) => {
      activeLookups++;
      maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      activeLookups--;
      return { ownerId, pid: 200 + owners.indexOf(ownerId) };
    });

    const result = await gatherOnDesktopSessions({
      ownerIds: owners,
      nowMs: 1_000,
      ttlMs: 0,
      deps: {
        listWindows: async () => [{ wid: '0x1', pid: 100, title: 'Terminal' }],
        listCandidates: async () => rows,
        findHost,
        listHosts: async () => [],
        readStat: async (pid) => `${pid} (psu-pty-host) S 100 1 0 0 0 0 0`,
      },
    });

    expect(maxActiveLookups).toBeGreaterThan(1);
    expect(maxActiveLookups).toBeLessThanOrEqual(8);
    expect(findHost).toHaveBeenCalledTimes(owners.length);
    expect(result.owners).toEqual(new Set(owners));
  });

  it('uses per-owner host lookup and does not seed the full-roster cache', async () => {
    const windows: OpenWindow[] = [{ wid: '0x1', pid: 100, title: 'Terminal' }];
    const targetCandidate = {
      id: 7,
      coord_owner_id: 'su-target',
      session_id: 'session-target',
      window_id: null,
      pid: null,
    };
    const listCandidates = vi.fn(async (_maxAgeSec: number, _ownerIds?: readonly string[]) => [targetCandidate]);
    const findHost = vi.fn(async (ownerId: string) => ({ ownerId, pid: 200 }));
    const listHosts = vi.fn(async () => [{ ownerId: 'su-full', pid: 300 }]);
    const readStat = async () => '200 (psu-pty-host) S 100 1 0 0 0 0 0';
    const listWindows = async () => windows;
    const diagnostics: Array<{ name: string; elapsedMs: number; status: 'ok' | 'error' }> = [];

    const targeted = await gatherOnDesktopSessions({
      ownerIds: ['su-target'],
      nowMs: 1_000,
      ttlMs: 5_000,
      deps: { listWindows, listCandidates, findHost, listHosts, readStat },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(listCandidates).toHaveBeenCalledWith(43_200, ['su-target']);
    expect(findHost).toHaveBeenCalledWith('su-target');
    expect(listHosts).not.toHaveBeenCalled();
    expect(targeted.owners).toEqual(new Set(['su-target']));
    expect(targeted.sessionIds).toEqual(new Set(['session-target']));
    expect(targeted.advSessionIds).toEqual(new Set([7]));
    expect(diagnostics.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'listOpenWindows', status: 'ok' },
      { name: 'listCandidates', status: 'ok' },
      { name: 'findLiveHost', status: 'ok' },
      { name: 'pidAncestry', status: 'ok' },
    ]);
    expect(diagnostics.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0)).toBe(true);

    const full = await gatherOnDesktopSessions({
      nowMs: 1_001,
      ttlMs: 5_000,
      deps: {
        listWindows,
        listCandidates: vi.fn(async () => []),
        listHosts,
        readStat: async () => '300 (psu-pty-host) S 100 1 0 0 0 0 0',
      },
    });

    expect(listHosts).toHaveBeenCalledTimes(1);
    expect(full.owners).toEqual(new Set(['su-full']));
  });
});

describe('gatherOnDesktopSessions full-roster ancestry fanout', () => {
  it('accepts a synchronous full-host roster provider', async () => {
    const host = { ownerId: 'su-sync', pid: 200 };
    const result = await gatherOnDesktopSessions({
      ttlMs: 0,
      deps: {
        listWindows: async () => [{ wid: '0x1', pid: 99, title: 'Terminal' }],
        listCandidates: async () => [{
          id: 1,
          coord_owner_id: host.ownerId,
          session_id: 'session-sync',
          window_id: null,
          pid: null,
        }],
        listHosts: () => [host],
        readStat: async () => '200 (psu-pty-host) S 99 1 0 0 0 0 0',
      },
    });

    expect(result.owners).toEqual(new Set([host.ownerId]));
    expect(result.sessionIds).toEqual(new Set(['session-sync']));
  });

  it('bounds independent host walks and keeps successful matches when one proc read fails', async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => ({ ownerId: `su-${i}`, pid: 1_000 + i }));
    const rows = hosts.map((host, i) => ({
      id: i + 1,
      coord_owner_id: host.ownerId,
      session_id: `session-${i}`,
      window_id: null,
      pid: null,
    }));
    let activeReads = 0;
    let maxActiveReads = 0;
    const diagnostics: Array<{ name: string; elapsedMs: number; status: 'ok' | 'error' }> = [];

    const result = await gatherOnDesktopSessions({
      ttlMs: 0,
      deps: {
        listWindows: async () => [{ wid: '0x1', pid: 99, title: 'Terminal' }],
        listCandidates: async () => rows,
        listHosts: async () => hosts,
        readStat: async (pid) => {
          activeReads++;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          activeReads--;
          if (pid === 1_005) throw new Error('transient proc read failure');
          return `${pid} (psu-pty-host) S 99 ${pid} ${pid} 0 -1 0`;
        },
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(8);
    expect(result.owners).toEqual(new Set(hosts.filter((host) => host.pid !== 1_005).map((host) => host.ownerId)));
    expect(result.sessionIds).toEqual(new Set(rows.filter((row) => row.id !== 6).map((row) => row.session_id)));
    expect(diagnostics.find(({ name }) => name === 'pidAncestry')?.status).toBe('ok');
  });
});

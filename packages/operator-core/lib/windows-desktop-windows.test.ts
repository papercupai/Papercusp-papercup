/**
 * Unit tests for windows-desktop-windows.ts (Lane 1/2/5 shared contract,
 * windows-desktop-feature-parity-2026-07-02). Hermetic — no real powershell.exe
 * is spawned; the pure parsers are covered directly, `/proc/version` is
 * mocked (node:fs) so isWindowsDesktopHost's WSL-detection is deterministic
 * regardless of what machine the test actually runs on, and the platform
 * guards on the async entry points are covered via that mock + a
 * `process.platform` override for the win32-fallback leg.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSessionIdFromWindowTitle,
  listWindowsByTitle,
  focusWindowByTitle,
  isWindowsDesktopHost,
  __resetIsWindowsDesktopHostCache,
  setOnDesktopWindowsCache,
  getOnDesktopWindowsCache,
  WINDOW_TITLE_PREFIX,
  type WindowsDesktopWindow,
} from './windows-desktop-windows';

const readFileSyncMock = vi.fn();
const nativeIntent = vi.hoisted(() => vi.fn());
vi.mock('./ui/dispatch-intent', () => ({ dispatchNativeWindowIntent: nativeIntent }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: unknown[]) => readFileSyncMock(...args) };
});

const realPlatform = process.platform;

/** Override the read-only process.platform for one test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** A genuine Linux dev box's /proc/version — no "microsoft" anywhere. */
const NATIVE_LINUX_PROC_VERSION =
  'Linux version 6.8.0-generic (buildd@lcy02-amd64) (gcc (Ubuntu 13.2.0) 13.2.0) #1 SMP';
/** A real WSL2 kernel's /proc/version signature. */
const WSL2_PROC_VERSION = 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@…) #1 SMP';

afterEach(() => {
  setPlatform(realPlatform);
  __resetIsWindowsDesktopHostCache();
  readFileSyncMock.mockReset();
  nativeIntent.mockReset();
});

describe('on-desktop window cache (WI-1675 renderer push)', () => {
  const w: WindowsDesktopWindow[] = [
    { hwnd: '0x1', pid: 100, title: `${WINDOW_TITLE_PREFIX}s1` },
    { hwnd: '0x2', pid: 200, title: 'Untitled - Notepad' },
  ];

  it('set → get returns the pushed windows within the TTL', () => {
    setOnDesktopWindowsCache(w, 1_000);
    expect(getOnDesktopWindowsCache(1_000)).toEqual(w);
    expect(getOnDesktopWindowsCache(1_000 + 59_000)).toEqual(w); // still inside the 60s TTL
  });

  it('get returns null once the push is older than the TTL (closed/backgrounded GUI)', () => {
    setOnDesktopWindowsCache(w, 1_000);
    expect(getOnDesktopWindowsCache(1_000 + 60_001)).toBeNull();
  });

  it('listWindowsByTitle reads the cache (not powershell) on a Windows desktop host, filtering by prefix', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    setOnDesktopWindowsCache(w);
    expect(await listWindowsByTitle()).toEqual(w);
    expect(await listWindowsByTitle(WINDOW_TITLE_PREFIX)).toEqual(w.slice(0, 1));
  });

  it('listWindowsByTitle returns [] on a Windows desktop host with no cache yet (GUI not pushed)', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    setOnDesktopWindowsCache(w, 1_000); // push far in the past → stale → treated as no data
    expect(await listWindowsByTitle(undefined)).toEqual([]);
  });

  it('enumerates through the native UI when the old page-specific cache is absent', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    setOnDesktopWindowsCache([], 1);
    nativeIntent.mockResolvedValueOnce(w);
    expect(await listWindowsByTitle(WINDOW_TITLE_PREFIX)).toEqual(w.slice(0, 1));
    expect(nativeIntent).toHaveBeenCalledWith({ action: 'list' });
  });
});

describe('parseSessionIdFromWindowTitle (pure title→sessionId extractor)', () => {
  it('extracts the sessionId from the exact contracted title format', () => {
    expect(parseSessionIdFromWindowTitle(`${WINDOW_TITLE_PREFIX}abc-123-def`)).toBe('abc-123-def');
  });

  it('returns null for a title without the prefix', () => {
    expect(parseSessionIdFromWindowTitle('Untitled - Notepad')).toBeNull();
    expect(parseSessionIdFromWindowTitle('Papercup - abc')).toBeNull(); // hyphen, not em dash
  });

  it('returns null when the tag is present but empty', () => {
    expect(parseSessionIdFromWindowTitle(WINDOW_TITLE_PREFIX)).toBeNull();
    expect(parseSessionIdFromWindowTitle(`${WINDOW_TITLE_PREFIX}   `)).toBeNull();
  });
});

describe('isWindowsDesktopHost (the P-025/WI-1646-sibling platform-detection fix)', () => {
  it('win32 short-circuits true without touching /proc/version (defensive fallback leg)', () => {
    setPlatform('win32');
    expect(isWindowsDesktopHost()).toBe(true);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('darwin is never WSL — false without touching /proc/version', () => {
    setPlatform('darwin');
    expect(isWindowsDesktopHost()).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('linux + a WSL2 kernel /proc/version → true (the actual Windows-desktop-host case)', () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    expect(isWindowsDesktopHost()).toBe(true);
  });

  it('linux + a native (non-WSL) /proc/version → false (the fleet dev box case)', () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(NATIVE_LINUX_PROC_VERSION);
    expect(isWindowsDesktopHost()).toBe(false);
  });

  it('linux + an unreadable /proc/version → false (best-effort, never throws)', () => {
    setPlatform('linux');
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isWindowsDesktopHost()).toBe(false);
  });

  it('caches the result — /proc/version is read at most once per cache lifetime', () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    expect(isWindowsDesktopHost()).toBe(true);
    expect(isWindowsDesktopHost()).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('platform guard — listWindowsByTitle/focusWindowByTitle never reached off a Windows desktop host', () => {
  it('routes WSL focus through Session-1 and accepts only an observed true result', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    nativeIntent.mockResolvedValueOnce({ protocol: 'visible-window-v2', workspace: 'window', focused: true }).mockResolvedValueOnce({ protocol: 'visible-window-v2', workspace: 'window', focused: false }).mockResolvedValueOnce({ focused: true });
    expect(await focusWindowByTitle('Papercup — exact')).toBe(true);
    expect(await focusWindowByTitle('Papercup — exact')).toBe(false);
    expect(await focusWindowByTitle('Papercup — exact')).toBe(false);
    expect(nativeIntent).toHaveBeenCalledWith({ action: 'focus', title: 'Papercup — exact', workspace: 'window' });
  });
  it('rejects old receipts and mismatched workspace receipts for explicit bring-here', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    nativeIntent.mockResolvedValueOnce({ protocol: 'visible-window-v1', focused: true })
      .mockResolvedValueOnce({ protocol: 'visible-window-v2', workspace: 'window', focused: true })
      .mockResolvedValueOnce({ protocol: 'visible-window-v2', workspace: 'current', focused: true });
    expect(await focusWindowByTitle('Agent', 'current')).toBe(false);
    expect(await focusWindowByTitle('Agent', 'current')).toBe(false);
    expect(await focusWindowByTitle('Agent', 'current')).toBe(true);
    expect(nativeIntent).toHaveBeenLastCalledWith({ action: 'focus', title: 'Agent', workspace: 'current' });
  });
  it('listWindowsByTitle short-circuits to [] on a native Linux/macOS host (no spawn attempted)', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(NATIVE_LINUX_PROC_VERSION);
    expect(await listWindowsByTitle()).toEqual([]);
    __resetIsWindowsDesktopHostCache();
    setPlatform('darwin');
    expect(await listWindowsByTitle(WINDOW_TITLE_PREFIX)).toEqual([]);
  });

  it('focusWindowByTitle short-circuits to false on a native Linux host (no spawn attempted)', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(NATIVE_LINUX_PROC_VERSION);
    expect(await focusWindowByTitle('anything')).toBe(false);
  });
});

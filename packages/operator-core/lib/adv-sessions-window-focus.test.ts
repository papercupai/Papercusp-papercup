/**
 * Coverage for adv-sessions.ts's Windows-desktop-host branch of
 * resolveWindowIdForTitleFragment / focusWindowId
 * (windows-desktop-feature-parity-2026-07-02 P-010).
 *
 * On Windows there is no pid→window mapping across the WSL boundary, so
 * these two functions delegate to windows-desktop-windows.ts's title-based
 * helpers instead of shelling out to `wmctrl`. windows-desktop-windows.ts is
 * mocked here — its own hermetic coverage lives in
 * windows-desktop-windows.test.ts.
 *
 * Gated on `isWindowsDesktopHost()`, NOT `process.platform` — the operator
 * always runs as a `wsl.exe --exec node` Linux process (main.rs), so
 * `process.platform` reports 'linux' even on a real Windows box (P-025 audit
 * finding, WI-1646's sibling). Mock the host-detection function directly
 * rather than overriding process.platform.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const listWindowsByTitleMock = vi.fn();
const focusWindowByTitleMock = vi.fn();
const isWindowsDesktopHostMock = vi.fn(() => false);

vi.mock('./windows-desktop-windows', () => ({
  listWindowsByTitle: (...args: unknown[]) => listWindowsByTitleMock(...args),
  focusWindowByTitle: (...args: unknown[]) => focusWindowByTitleMock(...args),
  isWindowsDesktopHost: () => isWindowsDesktopHostMock(),
}));

afterEach(() => {
  vi.clearAllMocks();
  isWindowsDesktopHostMock.mockReturnValue(false);
});

describe('resolveWindowIdForTitleFragment — Windows-desktop-host branch', () => {
  it('returns the matching window\'s exact TITLE (not an hwnd) on a hit', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockResolvedValueOnce([
      { hwnd: '0x1', pid: 111, title: 'Untitled - Notepad' },
      { hwnd: '0x2', pid: 222, title: 'Papercup — abc-123' },
    ]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-session-windows');
    const wid = await resolveWindowIdForTitleFragment('abc-123');
    expect(wid).toBe('Papercup — abc-123');
  });

  it('returns null when no window title contains the fragment', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockResolvedValueOnce([{ hwnd: '0x1', pid: 111, title: 'Untitled - Notepad' }]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-session-windows');
    expect(await resolveWindowIdForTitleFragment('abc-123')).toBeNull();
  });

  it('fails soft to null if the helper throws', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockRejectedValueOnce(new Error('powershell exploded'));
    const { resolveWindowIdForTitleFragment } = await import('./adv-session-windows');
    expect(await resolveWindowIdForTitleFragment('abc-123')).toBeNull();
  });

  it('never calls the Windows helper off a Windows-desktop host (wmctrl path taken instead)', async () => {
    isWindowsDesktopHostMock.mockReturnValue(false);
    const { resolveWindowIdForTitleFragment } = await import('./adv-session-windows');
    await resolveWindowIdForTitleFragment('some-fragment-unlikely-to-be-a-real-window');
    expect(listWindowsByTitleMock).not.toHaveBeenCalled();
  });
});

describe('focusWindowId — Windows-desktop-host branch', () => {
  it('treats windowId as a TITLE and delegates to focusWindowByTitle', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    focusWindowByTitleMock.mockResolvedValueOnce(true);
    const { focusWindowId } = await import('./adv-session-windows');
    const ok = await focusWindowId('Papercup — abc-123');
    expect(ok).toBe(true);
    expect(focusWindowByTitleMock).toHaveBeenCalledWith('Papercup — abc-123');
  });

  it('fails soft to false if the helper throws', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    focusWindowByTitleMock.mockRejectedValueOnce(new Error('powershell exploded'));
    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId('Papercup — abc-123')).toBe(false);
  });

  it('never calls the Windows helper off a Windows-desktop host (wmctrl path taken instead)', async () => {
    isWindowsDesktopHostMock.mockReturnValue(false);
    const { focusWindowId } = await import('./adv-session-windows');
    await focusWindowId('0x123');
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });
});

describe('focusWindowId — Linux activation is observed, not inferred from exit 0', () => {
  const TARGET = '0x01ebdf3e';
  const TARGET_DECIMAL = BigInt(TARGET).toString();
  const OTHER_DECIMAL = BigInt('0x01b00002').toString();

  it('falls back to bounded xdotool activation when wmctrl exits 0 but GNOME leaves another window active', async () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${OTHER_DECIMAL}\n` })
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${TARGET_DECIMAL}\n` });

    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId(TARGET, { runCommand })).toBe(true);
    expect(runCommand.mock.calls).toEqual([
      ['wmctrl', ['-ia', TARGET]],
      ['xdotool', ['getactivewindow']],
      ['xdotool', ['windowactivate', '--sync', TARGET]],
      ['xdotool', ['getactivewindow']],
    ]);
  });

  it('returns false when the fallback exits 0 but the target still is not active', async () => {
    const runCommand = vi.fn(() => ({ status: 0, stdout: `${OTHER_DECIMAL}\n` }))
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${OTHER_DECIMAL}\n` })
      .mockReturnValueOnce({ status: 0, stdout: '' });
    const settle = vi.fn(async () => {});

    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId(TARGET, { runCommand, settle })).toBe(false);
    expect(settle).toHaveBeenCalledTimes(20);
    expect(runCommand.mock.calls).toContainEqual(['xdotool', ['windowraise', TARGET]]);
    expect(runCommand.mock.calls).toContainEqual(['xdotool', ['windowfocus', '--sync', TARGET]]);
  });

  it('directly raises and focuses when Mutter ignores both successful activation requests', async () => {
    let directFocusRequested = false;
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'xdotool' && args[0] === 'getactivewindow') {
        return { status: 0, stdout: `${directFocusRequested ? TARGET_DECIMAL : OTHER_DECIMAL}\n` };
      }
      if (command === 'xdotool' && args[0] === 'windowfocus') directFocusRequested = true;
      return { status: 0, stdout: '' };
    });
    const settle = vi.fn(async () => {});

    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId(TARGET, { runCommand, settle })).toBe(true);
    expect(runCommand.mock.calls).toContainEqual(['xdotool', ['windowraise', TARGET]]);
    expect(runCommand.mock.calls).toContainEqual(['xdotool', ['windowfocus', '--sync', TARGET]]);
    expect(runCommand.mock.calls.at(-1)).toEqual(['xdotool', ['getactivewindow']]);
  });

  it('waits for Mutter to publish an asynchronously accepted activation before reporting failure', async () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${OTHER_DECIMAL}\n` })
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${OTHER_DECIMAL}\n` })
      .mockReturnValueOnce({ status: 0, stdout: `${TARGET_DECIMAL}\n` });
    const settle = vi.fn(async () => {});

    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId(TARGET, { runCommand, settle })).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('returns after wmctrl only when the observed active id matches across hex and decimal forms', async () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${TARGET_DECIMAL}\n` });

    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId(TARGET, { runCommand })).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});

describe('closeWindowId — the "Kill agent" window close (owner ask 2026-07-11)', () => {
  it('returns false (un-actionable) on a Windows-desktop host — no safe title-based close yet', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    const { closeWindowId } = await import('./adv-session-windows');
    // Must NOT fall through to focusing/closing the wrong window by title.
    expect(await closeWindowId('Papercup — abc-123')).toBe(false);
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });

  it('off a Windows-desktop host takes the wmctrl path (never the Windows title helper)', async () => {
    isWindowsDesktopHostMock.mockReturnValue(false);
    const { closeWindowId } = await import('./adv-session-windows');
    // Shells to `wmctrl -ic <wid>`; returns a boolean from the exit status. On a
    // host without wmctrl/DISPLAY it fails soft to false — never throws, and
    // never touches the Windows helper.
    const r = await closeWindowId('0x123');
    expect(typeof r).toBe('boolean');
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });
});

describe('matchWindowIdInWmctrlOutput — full-title match (owner-hit 2026-07-11: focus/kill missed psu windows)', () => {
  // Real `wmctrl -lp` shape: <win-id> <desktop> <pid> <host> <title…>. A psu/fleet
  // terminal titles itself with the coord-owner short id DEEP in the title; the
  // operator's own console-spawn LEADS the title with an "[adv:<id>]" tag.
  const SAMPLE = [
    '0x01a0000a  2 12345 dev-box-linux ▶ · ☕2 · 3p · su-78d15 · 🔭 Investigate MCP flakiness',
    '0x03400017  0 999 dev-box-linux Claude — Mozilla Firefox',
    '0x01b00002  1 6789 dev-box-linux [adv:11569] resuming plan-run 11569…',
  ].join('\n');

  it('matches a psu short owner-id that sits DEEP in the title (the fix)', async () => {
    const { matchWindowIdInWmctrlOutput } = await import('./adv-session-windows');
    expect(matchWindowIdInWmctrlOutput(SAMPLE, 'su-78d15')).toBe('0x01a0000a');
  });

  it('still matches a leading "[adv:<id>]" console-spawn tag (no regression)', async () => {
    const { matchWindowIdInWmctrlOutput } = await import('./adv-session-windows');
    expect(matchWindowIdInWmctrlOutput(SAMPLE, '[adv:11569]')).toBe('0x01b00002');
  });

  it('returns null when no title contains the fragment', async () => {
    const { matchWindowIdInWmctrlOutput } = await import('./adv-session-windows');
    expect(matchWindowIdInWmctrlOutput(SAMPLE, 'su-99999')).toBeNull();
  });

  it('does NOT match the host/pid columns — only the title (no wrong-window kill)', async () => {
    const { matchWindowIdInWmctrlOutput } = await import('./adv-session-windows');
    // "Precision-7865" lives in the host column, which is skipped.
    expect(matchWindowIdInWmctrlOutput(SAMPLE, 'Precision-7865')).toBeNull();
    // The pid "12345" is likewise a skipped column.
    expect(matchWindowIdInWmctrlOutput(SAMPLE, '12345')).toBeNull();
  });

  it('returns null on empty / whitespace-only fragment', async () => {
    const { matchWindowIdInWmctrlOutput } = await import('./adv-session-windows');
    expect(matchWindowIdInWmctrlOutput(SAMPLE, '')).toBeNull();
    expect(matchWindowIdInWmctrlOutput(SAMPLE, '   ')).toBeNull();
  });
});

describe('X11 window commands stay off the operator main thread (WI-10005394 guard)', () => {
  it('adv-session-windows.ts runs no synchronous child process outside comments', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./adv-session-windows.ts', import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    // Positive control: the module still shells out, so an empty match below is not vacuous.
    expect(code).toMatch(/runX11Command\('wmctrl'/);
    expect(code.match(/\b(?:spawnSync|execFileSync|execSync)\b/g) ?? []).toEqual([]);
  });

  it('accepts an async injected runner and awaits every step of the focus sequence', async () => {
    const { focusWindowId } = await import('./adv-session-windows');
    const calls: string[] = [];
    const runCommand = async (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      await new Promise((r) => setTimeout(r, 1));
      if (command === 'xdotool' && args[0] === 'getactivewindow') return { status: 0, stdout: `${0x04200007}\n` };
      return { status: 0, stdout: '' };
    };
    await expect(focusWindowId('0x04200007', { runCommand, settle: async () => {} })).resolves.toBe(true);
    expect(calls).toEqual(['wmctrl -ia 0x04200007', 'xdotool getactivewindow']);
  });
});

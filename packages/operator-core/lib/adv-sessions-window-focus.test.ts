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
const focusMacWindowMock = vi.hoisted(() => vi.fn());
vi.mock('./macos-desktop-windows', () => ({ focusMacWindow: focusMacWindowMock, resolveMacWindow: vi.fn() }));

/** Existing activation tests use a visible, same-workspace desktop fixture. */
function visibleX11(run: (command: string, args: string[]) => { status: number | null; stdout: string } | Promise<{ status: number | null; stdout: string }>) {
  return (command: string, args: string[]) => {
    if (command === 'xprop') return { status: 0, stdout: args[0] === '-root' ? '_NET_CURRENT_DESKTOP(CARDINAL) = 0' : '_NET_WM_DESKTOP(CARDINAL) = 0' };
    if (command === 'xwininfo') return { status: 0, stdout: 'Map State: IsViewable' };
    if (command === 'xdotool' && args[0] === 'windowmap') return { status: 0, stdout: '' };
    return run(command, args);
  };
}

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

  it('refuses an owner fragment that appears in more than one window title', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockResolvedValueOnce([
      { hwnd: '0x1', pid: 111, title: 'Papercup — su-807ee' },
      { hwnd: '0x2', pid: 222, title: 'Taking over su-807ee9d7-5fd7-40ee-af99-6f37d89faa7b per owner request' },
    ]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-session-windows');
    expect(await resolveWindowIdForTitleFragment('su-807ee')).toBeNull();
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
  it('passes an explicit Windows workspace policy to the native adapter', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    focusWindowByTitleMock.mockResolvedValue(true);
    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId('Papercup — abc-123', { workspace: 'current' })).toBe(true);
    expect(focusWindowByTitleMock).toHaveBeenCalledWith('Papercup — abc-123', 'current');
  });
  it('treats windowId as a TITLE and delegates to focusWindowByTitle', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    focusWindowByTitleMock.mockResolvedValueOnce(true);
    const { focusWindowId } = await import('./adv-session-windows');
    const ok = await focusWindowId('Papercup — abc-123');
    expect(ok).toBe(true);
    expect(focusWindowByTitleMock).toHaveBeenCalledWith('Papercup — abc-123', 'window');
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

describe('focusWindowId — macOS platform routing', () => {
  it('uses the native macOS adapter rather than X11 commands', async () => {
    focusMacWindowMock.mockResolvedValueOnce(true);
    const runCommand = vi.fn();
    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId('macos:exact', { platform: 'darwin', runCommand })).toBe(true);
    expect(focusMacWindowMock).toHaveBeenCalledWith('macos:exact');
    expect(runCommand).not.toHaveBeenCalled();
    expect(await focusWindowId('macos:exact', { platform: 'darwin', workspace: 'current' })).toBe(false);
    expect(focusMacWindowMock).toHaveBeenCalledTimes(1);
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
    expect(await focusWindowId(TARGET, { runCommand: visibleX11(runCommand) })).toBe(true);
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
    expect(await focusWindowId(TARGET, { runCommand: visibleX11(runCommand), settle })).toBe(false);
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
    expect(await focusWindowId(TARGET, { runCommand: visibleX11(runCommand), settle })).toBe(true);
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
    expect(await focusWindowId(TARGET, { runCommand: visibleX11(runCommand), settle })).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('returns after wmctrl only when the observed active id matches across hex and decimal forms', async () => {
    const runCommand = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: `${TARGET_DECIMAL}\n` });

    const { focusWindowId } = await import('./adv-session-windows');
    expect(await focusWindowId(TARGET, { runCommand: visibleX11(runCommand) })).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});

describe('focusWindowId — workspace visibility', () => {
  const TARGET = '0x01d80142';

  function desktop(opts: { moveRefused?: boolean; hidden?: boolean; restoreRefused?: boolean; sticky?: boolean } = {}) {
    let current = 17;
    let target = opts.sticky ? 0xffffffff : 15;
    let hidden = opts.hidden ?? false;
    const runCommand = vi.fn((command: string, args: string[]) => {
      if (command === 'xdotool' && args[0] === 'getactivewindow') return { status: 0, stdout: String(BigInt(TARGET)) };
      if (command === 'xprop' && args[0] === '-root') return { status: 0, stdout: `_NET_CURRENT_DESKTOP(CARDINAL) = ${current}` };
      if (command === 'xprop' && args[0] === '-id') return { status: 0, stdout: `_NET_WM_DESKTOP(CARDINAL) = ${target}\n_NET_WM_STATE(ATOM) = ${hidden ? '_NET_WM_STATE_HIDDEN' : '_NET_WM_STATE_FOCUSED'}` };
      if (command === 'xwininfo') return { status: 0, stdout: `Map State: ${hidden ? 'IsUnMapped' : 'IsViewable'}` };
      if (command === 'wmctrl' && args[2] === '-t' && !opts.moveRefused) target = Number(args[3]);
      if (command === 'wmctrl' && args[0] === '-s') current = Number(args[1]);
      if (command === 'xdotool' && args[0] === 'windowmap' && !opts.restoreRefused) hidden = false;
      return { status: 0, stdout: '' };
    });
    return { runCommand, settle: async () => {}, state: () => ({ current, target, hidden }) };
  }

  it('rejects a matching active id on an invisible workspace when the move is ignored', async () => {
    const { focusWindowId } = await import('./adv-session-windows');
    const env = desktop({ moveRefused: true });
    expect(await focusWindowId(TARGET, env)).toBe(false);
    expect(env.runCommand.mock.calls.some(([cmd, args]) => cmd === 'xdotool' && args[0] === 'windowfocus')).toBe(false);
  });

  it('brings the existing window to the current workspace by default', async () => {
    const { focusWindowId } = await import('./adv-session-windows');
    const env = desktop();
    expect(await focusWindowId(TARGET, env)).toBe(true);
    expect(env.state()).toMatchObject({ current: 17, target: 17 });
    expect(env.runCommand).toHaveBeenCalledWith('wmctrl', ['-ir', TARGET, '-t', '17']);
  });

  it('can switch to the window workspace without relocating the window', async () => {
    const { focusWindowId } = await import('./adv-session-windows');
    const env = desktop();
    expect(await focusWindowId(TARGET, { ...env, workspace: 'window' })).toBe(true);
    expect(env.state()).toMatchObject({ current: 15, target: 15 });
    expect(env.runCommand).toHaveBeenCalledWith('wmctrl', ['-s', '15']);
  });

  it('restores a minimized window and requires it to be viewable', async () => {
    const { focusWindowId } = await import('./adv-session-windows');
    const env = desktop({ hidden: true });
    expect(await focusWindowId(TARGET, env)).toBe(true);
    expect(env.state().hidden).toBe(false);
    expect(await focusWindowId(TARGET, desktop({ hidden: true, restoreRefused: true }))).toBe(false);
  });

  it('accepts sticky windows without changing the current workspace', async () => {
    const { focusWindowId } = await import('./adv-session-windows');
    const env = desktop({ sticky: true });
    expect(await focusWindowId(TARGET, env)).toBe(true);
    expect(env.state()).toMatchObject({ current: 17, target: 0xffffffff });
    expect(env.runCommand.mock.calls.some(([cmd, args]) => cmd === 'wmctrl' && args.includes('-t'))).toBe(false);
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

  it('refuses an ambiguous short owner id instead of taking the first matching terminal', async () => {
    const { matchWindowIdInWmctrlOutput } = await import('./adv-session-windows');
    const ambiguous = [
      '0x01a0000a  2 12345 dev-box-linux ▶ · ☕2 · 3p · su-807ee · 🔭 target terminal',
      '0x01b0000a  1 6789 dev-box-linux 🔭 intent mentions su-807ee9d7-5fd7-40ee-af99-6f37d89faa7b',
    ].join('\n');
    expect(matchWindowIdInWmctrlOutput(ambiguous, 'su-807ee')).toBeNull();
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
    await expect(focusWindowId('0x04200007', { runCommand: visibleX11(runCommand), settle: async () => {} })).resolves.toBe(true);
    expect(calls).toEqual(['wmctrl -ia 0x04200007', 'xdotool getactivewindow']);
  });
});

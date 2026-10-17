import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { focusMacWindow, MAC_WINDOW_SCRIPT, resolveMacWindow } from './macos-desktop-windows';

describe('macOS exact-window focus', () => {
  function nativeScript(options: { permission?: boolean; duplicate?: boolean; cgDuplicate?: boolean; offSpace?: boolean; menuCount?: number; menuRefuses?: boolean; unrelatedDenied?: boolean; revealAfter?: number; wrongFocusedWindow?: boolean; raiseUnavailableFor?: number } = {}) {
    const minimized = { value: true };
    let revealed = !options.offSpace;
    let raiseAttempts = 0;
    const raise = vi.fn(() => { if (!revealed || raiseAttempts++ < (options.raiseUnavailableFor ?? 0)) throw new Error("Can't get object"); });
    const window = { name: () => 'Agent', attributes: { byName: () => minimized }, actions: { byName: () => ({ perform: raise }) } };
    const windows = Object.assign(() => !revealed ? [] : options.duplicate ? [window, window] : [window], { byName: () => window });
    const press = vi.fn(() => { if (!options.menuRefuses) revealed = true; });
    const menuEntry = { name: () => 'Agent', enabled: () => true, actions: { byName: () => ({ perform: press }) } };
    const menuItems = Object.assign(() => Array(options.menuCount ?? 1).fill(menuEntry), { whose: () => () => Array(options.menuCount ?? 1).fill(menuEntry) });
    const process = { name: () => 'Terminal', unixId: () => 42, windows, frontmost: false,
      menuBars: () => [{ menuBarItems: () => [{ menus: () => [{ menuItems }] }] }],
      attributes: { byName: () => ({ value: () => options.wrongFocusedWindow ? { name: () => 'Other' } : window }) } };
    const denied = { unixId: () => 7, windows: () => { throw new Error('unrelated process denies AX'); } };
    const processes = Object.assign(() => options.unrelatedDenied ? [denied, process] : [process], { byName: () => process, whose: (query: { unixId?: number }) => () => query.unixId === 42 || process.frontmost ? [process] : [] });
    let observations = 0;
    const delay = vi.fn();
    const bindFunction = vi.fn();
    const evaluate = runInNewContext(`${MAC_WINDOW_SCRIPT}; run`, {
      ObjC: { import: () => {}, bindFunction, deepUnwrap: (value: unknown) => value },
      Application: () => ({ uiElementsEnabled: () => options.permission !== false, applicationProcesses: processes }),
      $: { CGWindowListCopyWindowInfo: (mode: number) => {
        const info = { kCGWindowOwnerPID: 42, kCGWindowName: 'Agent', kCGWindowLayer: 0 };
        if (mode === 0) return options.cgDuplicate ? [info, info] : [info];
        return revealed && observations++ >= (options.revealAfter ?? 0) ? [info] : [];
      } },
      delay,
    });
    return { evaluate: (query: object) => JSON.parse(evaluate([JSON.stringify(query)])), minimized, raise, press, delay, bindFunction };
  }

  it('executes the shipped script to restore/raise the exact window and wait for Space visibility', () => {
    const script = nativeScript({ revealAfter: 2 });
    expect(script.evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: true });
    expect(script.minimized.value).toBe(false);
    expect(script.raise).toHaveBeenCalledTimes(1);
    expect(script.delay).toHaveBeenCalledTimes(2);
    expect(script.bindFunction).toHaveBeenCalledWith('CGWindowListCopyWindowInfo', ['id', ['uint32_t', 'uint32_t']]);
  });

  it('rejects AX focus alone on an invisible Space and a different focused window', () => {
    expect(nativeScript({ revealAfter: 100 }).evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: false });
    expect(nativeScript({ wrongFocusedWindow: true }).evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: false });
  });

  it('resolves an off-Space fullscreen window through CoreGraphics and reveals its exact Window-menu entry', () => {
    const script = nativeScript({ offSpace: true, unrelatedDenied: true });
    expect(script.evaluate({ fragment: 'Agent' })).toEqual({ pid: 42, title: 'Agent' });
    expect(script.press).not.toHaveBeenCalled();
    expect(script.evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: true });
    expect(script.press).toHaveBeenCalledTimes(1);
  });

  it('refuses duplicate off-Space identities and ambiguous or missing menu entries', () => {
    const duplicate = nativeScript({ cgDuplicate: true });
    expect(duplicate.evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toBeNull();
    expect(duplicate.raise).not.toHaveBeenCalled();
    for (const menuCount of [0, 2]) {
      const script = nativeScript({ offSpace: true, menuCount });
      expect(script.evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: false });
      expect(script.press).not.toHaveBeenCalled();
    }
    expect(nativeScript({ offSpace: true, menuRefuses: true }).evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: false });
  });

  it('waits for a restored window to reappear in AX and fails closed if it stays absent', () => {
    const script = nativeScript({ raiseUnavailableFor: 2 });
    expect(script.evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: true });
    expect(script.raise).toHaveBeenCalledTimes(3);
    expect(script.delay).toHaveBeenCalledTimes(2);
    expect(nativeScript({ raiseUnavailableFor: 20 }).evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toEqual({ focused: false });
  });

  it('keeps the target when activation reorders the live Accessibility window indexes', () => {
    const target = { title: 'Agent', minimized: true, raise: vi.fn() };
    const other = { title: 'Other', minimized: false, raise: vi.fn() };
    const order = [target, other];
    let focused = other;
    let frontmost = false;
    const specifier = (get: () => typeof target) => ({
      name: () => get().title,
      attributes: { byName: () => ({ get value() { return get().minimized; }, set value(value: boolean) { get().minimized = value; } }) },
      actions: { byName: () => ({ perform: () => { focused = get(); get().raise(); } }) },
    });
    const windows = Object.assign(() => order.map((_, index) => specifier(() => order[index])), {
      byName: (title: string) => specifier(() => order.find(window => window.title === title)!),
    });
    const process = {
      name: () => 'Terminal', unixId: () => 42, windows,
      get frontmost() { return frontmost; },
      set frontmost(value: boolean) { frontmost = value; order.reverse(); },
      attributes: { byName: () => ({ value: () => ({ name: () => focused.title }) }) },
    };
    const processes = Object.assign(() => [process], { byName: () => process, whose: (query: { unixId?: number }) => () => query.unixId === 42 || frontmost ? [process] : [] });
    const run = runInNewContext(`${MAC_WINDOW_SCRIPT}; run`, {
      ObjC: { import: () => {}, bindFunction: () => {}, deepUnwrap: (value: unknown) => value },
      Application: () => ({ uiElementsEnabled: () => true, applicationProcesses: processes }),
      $: { CGWindowListCopyWindowInfo: () => [{ kCGWindowOwnerPID: 42, kCGWindowName: 'Agent', kCGWindowLayer: 0 }] },
      delay: () => {},
    });
    expect(JSON.parse(run([JSON.stringify({ pid: 42, title: 'Agent', action: 'focus' })]))).toEqual({ focused: true });
    expect(target.minimized).toBe(false);
    expect(target.raise).toHaveBeenCalledTimes(1);
    expect(other.raise).not.toHaveBeenCalled();
  });

  it('executes permission and ambiguity guards before changing any window', () => {
    expect(() => nativeScript({ permission: false }).evaluate({ fragment: 'Agent' })).toThrow('Accessibility');
    const script = nativeScript({ duplicate: true });
    expect(script.evaluate({ pid: 42, title: 'Agent', action: 'focus' })).toBeNull();
    expect(script.raise).not.toHaveBeenCalled();
  });

  it('keeps a shell-looking title as data and verifies native focus/visibility', async () => {
    const title = 'Papercup — su-abc " $(touch /tmp/never)';
    const runner = vi.fn().mockResolvedValueOnce({ status: 0, stdout: JSON.stringify({ pid: 42, title }) }).mockResolvedValueOnce({ status: 0, stdout: '{"focused":true}' });
    const id = await resolveMacWindow({ fragment: 'su-abc' }, runner);
    expect(await focusMacWindow(id!, runner)).toBe(true);
    expect(runner.mock.calls[1][1][3]).toBe(MAC_WINDOW_SCRIPT);
    expect(JSON.parse(runner.mock.calls[1][1][4])).toEqual({ pid: 42, title, action: 'focus' });
  });

  it('refuses ambiguous/absent windows and permission failures', async () => {
    expect(await resolveMacWindow({ fragment: 'su-abc' }, () => ({ status: 0, stdout: 'null' }))).toBeNull();
    expect(await resolveMacWindow({ pid: 42 }, () => ({ status: 1, stdout: '' }))).toBeNull();
    const id = await resolveMacWindow({ pid: 42 }, () => ({ status: 0, stdout: '{"pid":42,"title":"Agent"}' }));
    expect(await focusMacWindow(id!, () => ({ status: 0, stdout: '{"focused":false}' }))).toBe(false);
    expect(await focusMacWindow(id!, () => ({ status: 1, stdout: '{"focused":true}' }))).toBe(false);
    expect(await focusMacWindow('macos:not-json')).toBe(false);
  });
});

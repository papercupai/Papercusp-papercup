import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { focusMacWindow, MAC_WINDOW_SCRIPT, resolveMacWindow } from './macos-desktop-windows';

describe('macOS exact-window focus', () => {
  function nativeScript(options: { permission?: boolean; duplicate?: boolean; revealAfter?: number; wrongFocusedWindow?: boolean } = {}) {
    const minimized = { value: true };
    const raise = vi.fn();
    const window = { name: () => 'Agent', attributes: { byName: () => minimized }, actions: { byName: () => ({ perform: raise }) } };
    const process = { unixId: () => 42, windows: () => options.duplicate ? [window, window] : [window], frontmost: false, attributes: { byName: () => ({ value: () => options.wrongFocusedWindow ? { name: () => 'Other' } : window }) } };
    const processes = Object.assign(() => [process], { whose: () => () => process.frontmost ? [process] : [] });
    let observations = 0;
    const delay = vi.fn();
    const bindFunction = vi.fn();
    const evaluate = runInNewContext(`${MAC_WINDOW_SCRIPT}; run`, {
      ObjC: { import: () => {}, bindFunction, deepUnwrap: (value: unknown) => value },
      Application: () => ({ uiElementsEnabled: () => options.permission !== false, applicationProcesses: processes }),
      $: { CGWindowListCopyWindowInfo: () => observations++ >= (options.revealAfter ?? 0) ? [{ kCGWindowOwnerPID: 42, kCGWindowName: 'Agent', kCGWindowLayer: 0 }] : [] },
      delay,
    });
    return { evaluate: (query: object) => JSON.parse(evaluate([JSON.stringify(query)])), minimized, raise, delay, bindFunction };
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

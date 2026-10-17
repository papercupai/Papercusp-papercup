/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
const { focus, list } = vi.hoisted(() => ({ focus: vi.fn(), list: vi.fn() }));
vi.mock('../tauri-bindings', () => ({ commands: { focusWindowByTitle: focus, listWindowsByTitle: list } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: focus }));
import { registerBuiltInIntents } from './built-in-intents';
import { lookupIntent } from './intent-registry';
registerBuiltInIntents();
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.clearAllMocks(); });
describe('native window intent', () => {
  it('refuses a browser tab instead of confusing DOM focus with native focus', async () => {
    await expect(lookupIntent('native_window')!.handler({ action: 'focus', title: 'Agent' })).rejects.toThrow('native desktop client required');
    expect(focus).not.toHaveBeenCalled();
  });
  it('returns only the native observed result and requires an exact title', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    focus.mockResolvedValueOnce({ protocol: 'visible-window-v1', focused: true }).mockResolvedValueOnce({ protocol: 'visible-window-v1', focused: false });
    expect(await lookupIntent('native_window')!.handler({ action: 'focus', title: 'Agent', expiresAt: Date.now() + 5000 })).toEqual({ protocol: 'visible-window-v1', focused: true });
    expect(await lookupIntent('native_window')!.handler({ action: 'focus', title: 'Agent', expiresAt: Date.now() + 5000 })).toEqual({ protocol: 'visible-window-v1', focused: false });
    expect(focus).toHaveBeenCalledWith('focus_window_by_title', { title: 'Agent', verification: true });
    await expect(lookupIntent('native_window')!.handler({ action: 'focus' })).rejects.toThrow('exact native window title required');
  });
  it('refuses the legacy Boolean returned by an older desktop shell', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    focus.mockResolvedValueOnce(true);
    expect(await lookupIntent('native_window')!.handler({ action: 'focus', title: 'Agent', expiresAt: Date.now() + 5000 })).toEqual({ focused: false });
  });
  it('refuses delayed focus deliveries after their deadline', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await expect(lookupIntent('native_window')!.handler({ action: 'focus', title: 'Agent', expiresAt: Date.now() - 1 })).rejects.toThrow('expired');
    expect(focus).not.toHaveBeenCalled();
  });
});

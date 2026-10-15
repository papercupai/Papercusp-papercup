// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { _resetActions } from '@papercusp/operator-core/lib/shortcut-bus';
import { saveOverride } from '@papercusp/operator-core/lib/shortcut-registry';

const controls = vi.hoisted(() => ({
  mute: vi.fn(),
  deafen: vi.fn(),
  mode: vi.fn(),
  host: vi.fn(),
}));

vi.mock('./voice/voice-mode', () => ({
  toggleOperatorVoiceMute: controls.mute,
  toggleOperatorVoiceDeafen: controls.deafen,
  toggleOperatorVoiceBusMode: controls.mode,
  forceOperatorVoiceHost: controls.host,
}));
// Keep registry storage and change events real; isolate profile persistence.
vi.mock('@papercusp/operator-core/lib/profile-pref', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/operator-core/lib/profile-pref')>(),
  writeProfileField: vi.fn(),
}));

import GlobalShortcutDispatcher from './GlobalShortcutDispatcher';
import GlobalVoiceShortcuts from './GlobalVoiceShortcuts';

const platforms = [
  { name: 'Linux WebKit with frozen MacIntel platform', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', mac: false },
  { name: 'Windows WebView2', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', mac: false },
  { name: 'macOS WKWebView', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15', mac: true },
];
const bindings = [
  { key: 'M', control: controls.mute },
  { key: 'D', control: controls.deafen },
  { key: 'A', control: controls.mode },
  { key: 'H', control: controls.host },
];

function mount() {
  return render(<>
    <GlobalShortcutDispatcher />
    <GlobalVoiceShortcuts />
    <input aria-label="Composer" />
    <textarea aria-label="Editor" />
    <select aria-label="Choice"><option>One</option></select>
  </>);
}

function press(target: EventTarget, key: string, mac: boolean, alt = false) {
  const event = new KeyboardEvent('keydown', {
    key, ctrlKey: !mac, metaKey: mac, shiftKey: !alt, altKey: alt,
    bubbles: true, cancelable: true,
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  _resetActions();
  // Match the Storage fixture used by RecentActionsCenter tests: the
  // Node 25/jsdom runner otherwise exposes a storage shell without methods.
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: key => store.get(key) ?? null,
    key: index => Array.from(store.keys())[index] ?? null,
    removeItem: key => { store.delete(key); },
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
  vi.clearAllMocks();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
});
afterEach(() => {
  cleanup();
  _resetActions();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe.each(platforms)('voice keyboard dispatch on $name', ({ ua, mac }) => {
  beforeEach(() => { vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua); });

  it('dispatches all four controls while typing in inputs and textareas', () => {
    mount();
    for (const label of ['Composer', 'Editor']) {
      for (const { key, control } of bindings) {
        vi.clearAllMocks();
        expect(press(screen.getByLabelText(label), key, mac).defaultPrevented).toBe(true);
        expect(control).toHaveBeenCalledTimes(1);
        for (const other of Object.values(controls).filter(fn => fn !== control)) {
          expect(other).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('leaves the other platform modifier unclaimed', () => {
    mount();
    for (const { key } of bindings) {
      expect(press(screen.getByLabelText('Composer'), key, !mac).defaultPrevented).toBe(false);
    }
    for (const control of Object.values(controls)) expect(control).not.toHaveBeenCalled();
  });

  it('releases the old combo and dispatches a saved remap without remounting', () => {
    mount();
    act(() => { saveOverride('voice.toggleMute', 'mod+alt+m'); });
    expect(press(screen.getByLabelText('Composer'), 'M', mac).defaultPrevented).toBe(false);
    expect(controls.mute).not.toHaveBeenCalled();
    expect(press(screen.getByLabelText('Composer'), 'm', mac, true).defaultPrevented).toBe(true);
    expect(controls.mute).toHaveBeenCalledTimes(1);
  });
});

describe('voice keyboard lifecycle and context', () => {
  beforeEach(() => { vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platforms[1].ua); });

  it('preserves the select control guard', () => {
    mount();
    for (const { key } of bindings) {
      expect(press(screen.getByLabelText('Choice'), key, false).defaultPrevented).toBe(false);
    }
    for (const control of Object.values(controls)) expect(control).not.toHaveBeenCalled();
  });

  it('stops handling keyboard events after the shell unmounts', () => {
    const { unmount } = mount();
    expect(press(window, 'M', false).defaultPrevented).toBe(true);
    unmount();
    vi.clearAllMocks();
    expect(press(window, 'M', false).defaultPrevented).toBe(false);
    expect(controls.mute).not.toHaveBeenCalled();
  });
});

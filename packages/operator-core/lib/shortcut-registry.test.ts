/**
 * Coverage for shortcut-registry: getShortcutDef lookup, effectiveCombo
 * (override wins over defaultCombo; unknown id → ''), and the localStorage
 * override store (load/save/delete-on-empty/reset-all) against a stubbed window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCombo } from './shortcut-match';
import {
  SHORTCUTS,
  getShortcutDef,
  effectiveCombo,
  loadOverrides,
  saveOverride,
  resetAllOverrides,
} from './shortcut-registry';

const FIRST = SHORTCUTS[0];
const KEY = 'pc:ws:default:papercusp.shortcuts.v1';

function stubWindow() {
  const store = new Map<string, string>();
  const dispatchEvent = vi.fn();
  const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent,
    location: { href: 'http://127.0.0.1:3070/' },
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  return { store, dispatchEvent, fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe('getShortcutDef', () => {
  it('returns the def for a known id, undefined otherwise', () => {
    expect(getShortcutDef(FIRST.id)).toBe(FIRST);
    expect(getShortcutDef('definitely-not-a-shortcut')).toBeUndefined();
  });
});

describe('effectiveCombo', () => {
  it('uses the defaultCombo when no override is present', () => {
    expect(effectiveCombo(FIRST.id, {})).toBe(FIRST.defaultCombo.trim());
  });
  it('prefers an override', () => {
    expect(effectiveCombo(FIRST.id, { [FIRST.id]: 'mod+z' })).toBe('mod+z');
  });
  it('returns empty string for an unknown id', () => {
    expect(effectiveCombo('nope', {})).toBe('');
  });
});

describe('override store', () => {
  it('loadOverrides returns {} under SSR / when unset', () => {
    expect(loadOverrides()).toEqual({}); // no window
  });

  it('loadOverrides parses stored JSON', () => {
    const { store } = stubWindow();
    store.set(KEY, JSON.stringify({ 'feature.x': 'mod+y' }));
    expect(loadOverrides()).toEqual({ 'feature.x': 'mod+y' });
  });

  it('loadOverrides tolerates malformed JSON', () => {
    const { store } = stubWindow();
    store.set(KEY, '{not json');
    expect(loadOverrides()).toEqual({});
  });

  it('saveOverride persists (trimmed) + notifies; empty combo deletes', () => {
    const { store, dispatchEvent } = stubWindow();
    saveOverride('feature.x', '  mod+z  ');
    expect(JSON.parse(store.get(KEY)!)).toEqual({ 'feature.x': 'mod+z' });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    saveOverride('feature.x', '   '); // whitespace → delete
    expect(JSON.parse(store.get(KEY)!)).toEqual({});
  });

  it('resetAllOverrides clears the key + notifies', () => {
    const { store, dispatchEvent } = stubWindow();
    store.set(KEY, JSON.stringify({ a: 'b' }));
    resetAllOverrides();
    expect(store.get(KEY)).toBeUndefined();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('saveOverride pushes the full override map to PG (/api/profile)', () => {
    const { fetchMock } = stubWindow();
    saveOverride('feature.x', 'mod+z');
    const post = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(post?.[0]).toBe('/api/profile');
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({
      shortcut_overrides: { 'feature.x': 'mod+z' },
    });
  });
});

describe('registry integrity (discord-shortcuts 2026-06-06)', () => {
  it('every shortcut id is unique', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // portal-global-shortcuts-2026-09-06 D-002: the quick panel's chord is a
  // registry row so BOTH hosts list it (cheat sheet, settings/shortcuts). It is
  // 'global', not 'palette', so the desktop — where no web handler binds it (the
  // panel is a native popup window) — lets an unhandled Mod+J fall through
  // instead of swallowing it; the cloud portal binds it to its quick panel.
  it('lists panel.quick as a global (not palette) row on mod+j, form-tags enabled', () => {
    const def = getShortcutDef('panel.quick');
    expect(def?.defaultCombo).toBe('mod+j');
    expect(def?.category).toBe('global');
    expect(def?.options?.enableOnFormTags).toEqual(['INPUT', 'TEXTAREA', 'SELECT']);
  });

  it('every defaultCombo parses to at least one alternate', () => {
    for (const s of SHORTCUTS) {
      const parsed = parseCombo(s.defaultCombo);
      expect(parsed.alternates.length, `${s.id} combo "${s.defaultCombo}"`).toBeGreaterThan(0);
    }
  });

  // settings-audit 2026-07-09 (WI-3532). /settings/shortcuts renders straight from
  // SHORTCUTS, so every id here is a rebindable row. 14 ids had no handler in ANY
  // component — the whole `feature.*` block (its FeatureList was deleted) and four
  // `goto.*` ids whose /adv tabs are long gone from ADV_TAB_IDS — so users could
  // rebind keys that fired nothing. Removed; `goto.insights` was instead WIRED
  // (AdvShell + GlobalAppShortcuts). Pins both halves.
  describe('no dead rebindable rows', () => {
    it('drops editor.save after its prompt and memory editors were retired', () => {
      expect(getShortcutDef('editor.save')).toBeUndefined();
      expect(effectiveCombo('editor.save', { 'editor.save': 'mod+alt+s' })).toBe('');
    });

    it('drops the feature-list ids (their FeatureList no longer exists)', () => {
      expect(SHORTCUTS.filter((s) => s.id.startsWith('feature.'))).toEqual([]);
    });

    it('drops goto.* ids whose /adv tabs were removed', () => {
      for (const id of ['goto.dashboard', 'goto.summary', 'goto.config', 'goto.proposals']) {
        expect(getShortcutDef(id), id).toBeUndefined();
      }
    });

    it('keeps find.open — it is navigation, and merely sat inside the feature block', () => {
      expect(getShortcutDef('find.open')?.category).toBe('navigation');
    });

    it('keeps the goto.* ids that have live /adv surfaces and handlers', () => {
      expect(getShortcutDef('goto.brainstorm')?.defaultCombo).toBe('g>b');
      expect(getShortcutDef('goto.insights')?.defaultCombo).toBe('g>i');
    });
  });

  it('the Discord-parity bindings are registered with their combos', () => {
    const expectCombo = (id: string, combo: string) =>
      expect(getShortcutDef(id)?.defaultCombo, id).toBe(combo);
    expectCombo('voice.toggleMute', 'mod+shift+m');
    expectCombo('voice.toggleDeafen', 'mod+shift+d');
    expectCombo('voice.toggleMode', 'mod+shift+a');
    expectCombo('voice.forceHost', 'mod+shift+h');
    expectCombo('video.toggleCamera', 'mod+shift+v');
    expectCombo('goto.prevTab', 'alt+ArrowUp');
    expectCombo('goto.nextTab', 'alt+ArrowDown');
    expectCombo('harness.prev', 'mod+alt+ArrowLeft');
    expectCombo('harness.next', 'mod+alt+ArrowRight');
    expectCombo('goto.inbox', 'mod+i');
    expectCombo('harness.create', 'mod+shift+n');
    expectCombo('settings.open', 'mod+comma');
    expectCombo('search.global', 'mod+shift+f');
    expectCombo('panel.togglePresence', 'mod+u');
  });

  it('mod+/ moved from the palette to the cheat-sheet (Discord help combo)', () => {
    expect(getShortcutDef('palette.toggle')?.defaultCombo).toBe('mod+k, mod+p');
    expect(getShortcutDef('shortcuts.show')?.defaultCombo).toBe('mod+slash, shift+slash');
  });

  it('no two shortcuts claim the same default alternate (combo collisions)', () => {
    // Normalize each parsed alternate into a comparable signature; sequence
    // steps join with '>'. Two registry entries sharing a signature would
    // fight over the same keypress.
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      for (const alt of parseCombo(s.defaultCombo).alternates) {
        const sig = alt.steps
          .map(
            (st) =>
              `${st.mod ? 'mod+' : ''}${st.ctrl ? 'ctrl+' : ''}${st.meta ? 'meta+' : ''}${st.shift ? 'shift+' : ''}${st.alt ? 'alt+' : ''}${st.key}`,
          )
          .join('>');
        const holder = seen.get(sig);
        expect(holder, `combo "${sig}" claimed by both ${holder} and ${s.id}`).toBeUndefined();
        seen.set(sig, s.id);
      }
    }
  });
});

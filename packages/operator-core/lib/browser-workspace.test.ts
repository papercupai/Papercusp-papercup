/**
 * Coverage for browser-workspace: getBrowserWorkspaceId id-source precedence
 * (injected __PAPERCUSP_WS__ → ?ws= → 'default') + wsLocalKey namespacing.
 * window is stubbed; the no-window (SSR) path runs in the bare node env.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBrowserMachineId, getBrowserWorkspaceId, resolveActiveWorkspaceId, setBrowserMachineId, wsLocalKey } from './browser-workspace';

afterEach(() => vi.unstubAllGlobals());

describe('per-window machine selection', () => {
  it('survives navigation while leaving an independent window and workspace unchanged', () => {
    const makeWindow = () => {
      const storage = new Map<string, string>();
      return { __PAPERCUSP_WS__: 'own-workspace', location: { href: 'http://localhost/desktops?desktopHost=a' },
        sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) } };
    };
    const a = makeWindow(); const b = makeWindow();
    vi.stubGlobal('window', a);
    setBrowserMachineId('b');
    a.location.href = 'http://localhost/agents';
    expect(getBrowserMachineId()).toBe('b');
    expect(getBrowserWorkspaceId()).toBe('own-workspace');
    vi.stubGlobal('window', b);
    expect(getBrowserMachineId()).toBe('a');
    b.location.href = 'http://localhost/agents';
    expect(getBrowserMachineId()).toBeUndefined();
    vi.stubGlobal('window', a);
    expect(getBrowserMachineId()).toBe('b');
  });
});

describe('getBrowserWorkspaceId', () => {
  it("returns 'default' when there is no window (SSR)", () => {
    expect(getBrowserWorkspaceId()).toBe('default');
  });

  it('prefers the injected __PAPERCUSP_WS__ global', () => {
    vi.stubGlobal('window', {
      __PAPERCUSP_WS__: 'ws-injected',
      location: { href: 'http://127.0.0.1:3070/?ws=ws-query' },
    });
    expect(getBrowserWorkspaceId()).toBe('ws-injected'); // injected wins over ?ws=
  });

  it('falls back to the ?ws= query param', () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:3070/x?ws=ws-query' } });
    expect(getBrowserWorkspaceId()).toBe('ws-query');
  });

  it("falls back to 'default' when neither is present", () => {
    vi.stubGlobal('window', { location: { href: 'http://127.0.0.1:3070/' } });
    expect(getBrowserWorkspaceId()).toBe('default');
  });

  it('ignores a blank injected value', () => {
    vi.stubGlobal('window', { __PAPERCUSP_WS__: '   ', location: { href: 'http://127.0.0.1:3070/?ws=ws-q' } });
    expect(getBrowserWorkspaceId()).toBe('ws-q');
  });
});

describe('wsLocalKey', () => {
  it('namespaces a key under the active workspace', () => {
    vi.stubGlobal('window', { __PAPERCUSP_WS__: 'ws-9', location: { href: 'http://127.0.0.1:3070/' } });
    expect(wsLocalKey('autoScan')).toBe('pc:ws:ws-9:autoScan');
  });

  it("uses 'default' under SSR", () => {
    expect(wsLocalKey('k')).toBe('pc:ws:default:k');
  });
});

describe('resolveActiveWorkspaceId', () => {
  // The active workspace for a view is the one THIS WINDOW opened
  // (per-window-workspace-context-2026-05-31, P-030 / D-005), NOT the
  // process-global reg.current — which is only the default a *new* window
  // opens into. A window must never be flipped to another workspace because
  // the shared sidecar's reg.current points elsewhere.
  const reg = {
    current: 'default',
    workspaces: [{ id: 'default' }, { id: 'papercup' }, { id: 'restart' }],
  };

  it("uses the window's workspace when it is a known workspace (not reg.current)", () => {
    expect(resolveActiveWorkspaceId(reg, 'papercup')).toBe('papercup');
  });

  it("falls back to reg.current when the window's workspace is unknown", () => {
    expect(resolveActiveWorkspaceId(reg, 'ghost-ws')).toBe('default');
  });

  it('falls back to the first workspace when neither window nor reg.current is known', () => {
    expect(resolveActiveWorkspaceId({ current: 'gone', workspaces: [{ id: 'a' }, { id: 'b' }] }, 'also-gone')).toBe('a');
  });

  it('returns the window id unchanged when the registry has no workspaces', () => {
    expect(resolveActiveWorkspaceId({ current: '', workspaces: [] }, 'papercup')).toBe('papercup');
  });
});

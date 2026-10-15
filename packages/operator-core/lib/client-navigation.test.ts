/**
 * Coverage for client-navigation: the pure soft/hard/none decision
 * (shouldSoftNavigate + resolveClientNavigation) and navigateClient's dispatch
 * (history pushState/replaceState + popstate vs location.assign/replace).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  shouldSoftNavigate,
  resolveClientNavigation,
  navigateClient,
  resolveQuickPanelHandoff,
  bindQuickPanelEscape,
} from './client-navigation';

const CUR = 'http://localhost:3070/harness/p';
const PANEL = 'http://localhost:3070/quick-panel';
const DESKTOP = 'papercusp://localhost/harness';

describe('Quick Panel Escape across Docs navigation', () => {
  type Dom = { window: Window & typeof globalThis };
  const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string }) => Dom;
  };
  const doms: Dom[] = [];
  afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });
  function doc(url: string) {
    const dom = new JSDOM('<input>', { url });
    doms.push(dom);
    return dom.window.document;
  }
  function escape(document: Document, key = 'Escape') {
    const win = document.defaultView as Window & typeof globalThis;
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.querySelector('input')!.dispatchEvent(event);
    return event;
  }

  it('dismisses from the parent and the loaded Docs document, without intercepting other keys', () => {
    const parent = doc(PANEL);
    const child = doc('http://localhost:3070/internal/docs/search-palette.html');
    const frame = parent.createElement('iframe');
    Object.defineProperty(frame, 'contentDocument', { get: () => child });
    const dismiss = vi.fn();
    const unbind = bindQuickPanelEscape(parent, frame, dismiss);
    escape(child, 'Enter');
    expect(dismiss).not.toHaveBeenCalled();
    expect(escape(child).defaultPrevented).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    escape(parent);
    expect(dismiss).toHaveBeenCalledTimes(2);
    unbind();
  });

  it('binds the new document after result navigation and removes obsolete and unmounted listeners', () => {
    const parent = doc(PANEL);
    const first = doc('http://localhost:3070/internal/docs/search-palette.html');
    const next = doc('http://localhost:3070/internal/docs/guide/shortcuts');
    let current: Document | null = first;
    const frame = parent.createElement('iframe');
    Object.defineProperty(frame, 'contentDocument', { get: () => current });
    const dismiss = vi.fn();
    const unbind = bindQuickPanelEscape(parent, frame, dismiss);
    current = next;
    frame.dispatchEvent(new parent.defaultView!.Event('load'));
    escape(first);
    expect(dismiss).not.toHaveBeenCalled();
    escape(next);
    expect(dismiss).toHaveBeenCalledOnce();
    unbind();
    escape(next);
    escape(parent);
    frame.dispatchEvent(new parent.defaultView!.Event('load'));
    escape(next);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('respects Escape already consumed by the embedded answer and tolerates an inaccessible frame', () => {
    const parent = doc(PANEL);
    const child = doc('http://localhost:3070/internal/docs/search-palette.html');
    const consume = (event: KeyboardEvent) => event.preventDefault();
    child.defaultView!.addEventListener('keydown', consume);
    const frame = parent.createElement('iframe');
    let current: Document | null = child;
    Object.defineProperty(frame, 'contentDocument', { get: () => current });
    const dismiss = vi.fn();
    const unbind = bindQuickPanelEscape(parent, frame, dismiss);
    escape(child);
    expect(dismiss).not.toHaveBeenCalled();
    child.defaultView!.removeEventListener('keydown', consume);
    escape(child);
    expect(dismiss).toHaveBeenCalledOnce();
    current = null; // Cross-origin iframe documents are inaccessible to the parent.
    frame.dispatchEvent(new parent.defaultView!.Event('load'));
    escape(child);
    expect(dismiss).toHaveBeenCalledOnce();
    escape(parent);
    expect(dismiss).toHaveBeenCalledTimes(2);
    unbind();
  });
});

describe('shouldSoftNavigate', () => {
  it('soft-navigates within the native Papercusp origin', () => {
    expect(shouldSoftNavigate('/settings/shortcuts', DESKTOP)).toBe(true);
    expect(shouldSoftNavigate('papercusp://localhost/notes', DESKTOP)).toBe(true);
    // Custom schemes have opaque URL.origin values: two null origins must
    // never make an untrusted host or scheme count as the desktop origin.
    expect(shouldSoftNavigate('papercusp://evil.example/notes', DESKTOP)).toBe(false);
    expect(shouldSoftNavigate('other://localhost/notes', DESKTOP)).toBe(false);
  });
  it('true for a same-origin target', () => {
    expect(shouldSoftNavigate('/other', CUR)).toBe(true);
    expect(shouldSoftNavigate('http://localhost:3070/x', CUR)).toBe(true);
  });
  it('false for a cross-origin target', () => {
    expect(shouldSoftNavigate('http://evil.com/x', CUR)).toBe(false);
    expect(shouldSoftNavigate('http://localhost:9999/x', CUR)).toBe(false); // different port = different origin
  });
  it('false for a non-http(s) scheme', () => {
    expect(shouldSoftNavigate('mailto:a@b.c', CUR)).toBe(false);
    expect(shouldSoftNavigate('javascript:alert(1)', CUR)).toBe(false);
  });
});

describe('resolveClientNavigation', () => {
  it('preserves native app routes, query and fragment', () => {
    expect(resolveClientNavigation('/settings/shortcuts?ws=alpha#navigation', DESKTOP)).toEqual({
      mode: 'soft',
      href: '/settings/shortcuts?ws=alpha#navigation',
      replace: false,
    });
    expect(resolveClientNavigation('papercusp://evil.example/notes', DESKTOP).mode).toBe('none');
    expect(resolveClientNavigation('papercusp://localhost/notes', CUR).mode).toBe('none');
  });
  it('soft-navigates same-origin to a path+search+hash href', () => {
    expect(resolveClientNavigation('http://localhost:3070/a?b=1#c', CUR)).toEqual({
      mode: 'soft',
      href: '/a?b=1#c',
      replace: false,
    });
  });
  it('hard-navigates cross-origin to the full href', () => {
    expect(resolveClientNavigation('http://evil.com/x', CUR)).toEqual({
      mode: 'hard',
      href: 'http://evil.com/x',
      replace: false,
    });
  });
  it('returns none for a non-http(s) target', () => {
    expect(resolveClientNavigation('mailto:a@b.c', CUR)).toEqual({
      mode: 'none',
      href: null,
      replace: false,
    });
  });
  it('threads the replace flag', () => {
    expect(resolveClientNavigation('/a', CUR, { replace: true }).replace).toBe(true);
  });
  it('forces hard navigation when opts.hard is set, even for a same-origin target', () => {
    expect(resolveClientNavigation('http://localhost:3070/harness?ws=beta', CUR, { hard: true })).toEqual({
      mode: 'hard',
      href: 'http://localhost:3070/harness?ws=beta',
      replace: false,
    });
  });
  it('forces hard navigation when the target switches to a different workspace', () => {
    expect(resolveClientNavigation('/harness?ws=beta', CUR, { currentWorkspaceId: 'alpha' })).toEqual({
      mode: 'hard',
      href: 'http://localhost:3070/harness?ws=beta',
      replace: false,
    });
  });
  it('stays soft when the target keeps the same workspace', () => {
    expect(resolveClientNavigation('/harness?ws=alpha', CUR, { currentWorkspaceId: 'alpha' })).toEqual({
      mode: 'soft',
      href: '/harness?ws=alpha',
      replace: false,
    });
  });
  it('stays soft when the target carries no workspace param', () => {
    expect(resolveClientNavigation('/other', CUR, { currentWorkspaceId: 'alpha' })).toEqual({
      mode: 'soft',
      href: '/other',
      replace: false,
    });
  });
});

// WI-4827: the Quick Panel window must never navigate itself into the full app.
describe('resolveQuickPanelHandoff', () => {
  const inPanel = { isQuickPanelWindow: true };
  it('hands off native app routes while retaining the custom-origin boundary', () => {
    const panel = 'papercusp://localhost/quick-panel';
    expect(resolveQuickPanelHandoff('/settings/shortcuts', panel, inPanel)).toBe('/settings/shortcuts');
    expect(resolveQuickPanelHandoff('/quick-panel?tab=docs', panel, inPanel)).toBeNull();
    expect(resolveQuickPanelHandoff('papercusp://evil.example/notes', panel, inPanel)).toBeNull();
  });
  it('returns null when NOT the quick-panel window (main app navigates normally)', () => {
    expect(resolveQuickPanelHandoff('/settings/voice', CUR, { isQuickPanelWindow: false })).toBeNull();
  });
  it('hands off a same-origin nav that LEAVES the chromeless sandbox', () => {
    expect(resolveQuickPanelHandoff('/settings/voice', PANEL, inPanel)).toBe('/settings/voice');
    expect(resolveQuickPanelHandoff('http://localhost:3070/settings/user?x=1#y', PANEL, inPanel)).toBe(
      '/settings/user?x=1#y',
    );
  });
  it('stays in place (null) for panel→panel / any chromeless destination', () => {
    expect(resolveQuickPanelHandoff('/quick-panel?tab=docs', PANEL, inPanel)).toBeNull();
    expect(resolveQuickPanelHandoff('/pi/thing', PANEL, inPanel)).toBeNull();
    expect(resolveQuickPanelHandoff('/project-docs', PANEL, inPanel)).toBeNull();
  });
  it('does not hand off off-origin or non-http targets (they go out via the OS)', () => {
    expect(resolveQuickPanelHandoff('http://evil.com/x', PANEL, inPanel)).toBeNull();
    expect(resolveQuickPanelHandoff('mailto:a@b.c', PANEL, inPanel)).toBeNull();
    expect(resolveQuickPanelHandoff('javascript:alert(1)', PANEL, inPanel)).toBeNull();
  });
});

describe('navigateClient', () => {
  function stubWindow(extra?: Record<string, unknown>) {
    const win = {
      location: { href: CUR, assign: vi.fn(), replace: vi.fn() },
      history: { pushState: vi.fn(), replaceState: vi.fn() },
      dispatchEvent: vi.fn(),
      ...extra,
    };
    vi.stubGlobal('window', win);
    vi.stubGlobal('PopStateEvent', class { constructor(public type: string) {} });
    return win;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('in the quick-panel window, an out-of-sandbox nav is handed to the app, not run in place', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const w = stubWindow({
      location: { href: PANEL, assign: vi.fn(), replace: vi.fn() },
      __PAPERCUSP_QUICK_PANEL_WINDOW__: true,
      __TAURI_INTERNALS__: { invoke },
    });
    navigateClient('/settings/voice');
    // Assert the command name + payload only. `openRouteInApp` now goes through the
    // typed specta binding (EI-18899708711154370 / D-014) instead of poking
    // `__TAURI_INTERNALS__.invoke` directly, and `@tauri-apps/api`'s `invoke()`
    // forwards a third `options` argument to the internals. That trailing argument
    // is the API's business, not this module's contract — matching on it would make
    // the test fail on a Tauri upgrade that changes nothing we care about.
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      'open_route_in_app',
      { route: '/settings/voice' },
    ]);
    // Crucially: the panel window itself does NOT navigate.
    expect(w.history.pushState).not.toHaveBeenCalled();
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  it('in the quick-panel window, a panel→panel nav still runs in place', () => {
    const invoke = vi.fn();
    const w = stubWindow({
      location: { href: PANEL, assign: vi.fn(), replace: vi.fn() },
      __PAPERCUSP_QUICK_PANEL_WINDOW__: true,
      __TAURI_INTERNALS__: { invoke },
    });
    navigateClient('/quick-panel?tab=brainstorm');
    expect(invoke).not.toHaveBeenCalled();
    expect(w.history.pushState).toHaveBeenCalledWith({}, '', '/quick-panel?tab=brainstorm');
  });

  it('soft nav pushes state + dispatches popstate', () => {
    const w = stubWindow();
    navigateClient('/dest?q=1');
    expect(w.history.pushState).toHaveBeenCalledWith({}, '', '/dest?q=1');
    expect(w.dispatchEvent).toHaveBeenCalledOnce();
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  it('soft nav with replace uses replaceState', () => {
    const w = stubWindow();
    navigateClient('/dest', { replace: true });
    expect(w.history.replaceState).toHaveBeenCalledWith({}, '', '/dest');
  });

  it('hard nav uses location.assign (or replace)', () => {
    const w = stubWindow();
    navigateClient('http://evil.com/x');
    expect(w.location.assign).toHaveBeenCalledWith('http://evil.com/x');
    navigateClient('http://evil.com/y', { replace: true });
    expect(w.location.replace).toHaveBeenCalledWith('http://evil.com/y');
  });

  it('none-mode target does nothing', () => {
    const w = stubWindow();
    navigateClient('mailto:a@b.c');
    expect(w.history.pushState).not.toHaveBeenCalled();
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  it('forces a hard reload when switching to a different workspace', () => {
    const w = stubWindow();
    (w as { __PAPERCUSP_WS__?: string }).__PAPERCUSP_WS__ = 'alpha';
    navigateClient('/harness?ws=beta');
    expect(w.location.assign).toHaveBeenCalledWith('http://localhost:3070/harness?ws=beta');
    expect(w.history.pushState).not.toHaveBeenCalled();
  });

  it('soft-navigates within the current workspace', () => {
    const w = stubWindow();
    (w as { __PAPERCUSP_WS__?: string }).__PAPERCUSP_WS__ = 'alpha';
    navigateClient('/harness/sub?ws=alpha');
    expect(w.history.pushState).toHaveBeenCalledWith({}, '', '/harness/sub?ws=alpha');
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  // Regression: the static desktop host (apps/operator-vite/index.html, :3070/
  // :4173) overrides location.assign/replace to a same-origin soft pushState.
  // A forced-hard nav (workspace switch) MUST bypass that via the stashed
  // genuine methods, or the document never reloads and the switch no-ops
  // ("switching workspaces does nothing" on the desktop).
  it('hard nav bypasses the desktop-host assign override via the stashed original', () => {
    const w = stubWindow();
    const orig = vi.fn();
    (w as { __papercuspOriginalAssign?: (t: string) => void }).__papercuspOriginalAssign = orig;
    navigateClient('http://localhost:3070/harness?ws=beta', { hard: true });
    expect(orig).toHaveBeenCalledWith('http://localhost:3070/harness?ws=beta');
    // The overridden (soft-downgrading) assign must NOT be used.
    expect(w.location.assign).not.toHaveBeenCalled();
    expect(w.history.pushState).not.toHaveBeenCalled();
  });

  it('hard replace nav bypasses the desktop-host replace override via the stashed original', () => {
    const w = stubWindow();
    const orig = vi.fn();
    (w as { __papercuspOriginalReplace?: (t: string) => void }).__papercuspOriginalReplace = orig;
    navigateClient('http://localhost:3070/harness?ws=beta', { hard: true, replace: true });
    expect(orig).toHaveBeenCalledWith('http://localhost:3070/harness?ws=beta');
    expect(w.location.replace).not.toHaveBeenCalled();
  });

  it('a workspace switch on the desktop host forces a real document load', () => {
    // The exact bug scenario: window is in workspace alpha, switch to beta.
    const w = stubWindow();
    (w as { __PAPERCUSP_WS__?: string }).__PAPERCUSP_WS__ = 'alpha';
    const orig = vi.fn();
    (w as { __papercuspOriginalAssign?: (t: string) => void }).__papercuspOriginalAssign = orig;
    navigateClient('/harness?ws=beta');
    expect(orig).toHaveBeenCalledWith('http://localhost:3070/harness?ws=beta');
    expect(w.location.assign).not.toHaveBeenCalled();
    expect(w.history.pushState).not.toHaveBeenCalled();
  });

  it('falls back to native assign off-desktop when no stash is present', () => {
    const w = stubWindow();
    navigateClient('http://evil.com/x', { hard: true });
    expect(w.location.assign).toHaveBeenCalledWith('http://evil.com/x');
  });
});

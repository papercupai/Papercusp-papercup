/**
 * Coverage for the operator-vite/Next workspace-header fetch wrapper (P-013):
 * same-origin (and loopback) /api/* requests get `x-papercusp-workspace`
 * stamped from getBrowserWorkspaceId(); everything else is untouched.
 * window is stubbed (bare node env), mirroring browser-workspace.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWorkspaceHeaderFetch } from './workspace-header-fetch';

afterEach(() => vi.unstubAllGlobals());

function stubWindow(ws?: string) {
  const fetchSpy = vi.fn((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(new Response('ok')),
  );
  vi.stubGlobal('window', {
    __PAPERCUSP_WS__: ws,
    location: { href: 'http://127.0.0.1:3070/adv', origin: 'http://127.0.0.1:3070' },
    fetch: fetchSpy,
  });
  return fetchSpy;
}

function stampedWs(spy: ReturnType<typeof vi.fn>): string | null {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get('x-papercusp-workspace');
}

describe('installWorkspaceHeaderFetch', () => {
  it('carries the selected machine on portal fetch without overriding signed workspace authority', async () => {
    const spy = stubWindow('control-plane');
    window.location.href = 'http://127.0.0.1:3070/?desktopHost=machine-b';
    installWorkspaceHeaderFetch({ workspace: false });
    await window.fetch('/api/agent-sessions');
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-papercusp-machine')).toBe('machine-b');
    expect(headers.get('x-papercusp-workspace')).toBeNull();
    await window.fetch('https://external.test/api/sessions');
    expect(new Headers(spy.mock.calls[1]?.[1]?.headers).has('x-papercusp-machine')).toBe(false);
  });

  it('stamps the workspace header on same-origin /api/* requests', async () => {
    const spy = stubWindow('ws-7');
    installWorkspaceHeaderFetch();
    await window.fetch('/api/harness/papercup/testing/domains');
    expect(stampedWs(spy)).toBe('ws-7');
  });

  it('does not stamp non-/api requests', async () => {
    const spy = stubWindow('ws-7');
    installWorkspaceHeaderFetch();
    await window.fetch('/assets/app.js');
    expect(stampedWs(spy)).toBeNull();
  });

  it('preserves an explicitly-set workspace header (does not override)', async () => {
    const spy = stubWindow('ws-7');
    installWorkspaceHeaderFetch();
    await window.fetch('/api/x', { headers: { 'x-papercusp-workspace': 'ws-explicit' } });
    expect(stampedWs(spy)).toBe('ws-explicit');
  });

  it('stamps a loopback cross-origin dev call (:3055 → :3070 etc.)', async () => {
    const spy = stubWindow('ws-7');
    installWorkspaceHeaderFetch();
    await window.fetch('http://localhost:3055/api/x');
    expect(stampedWs(spy)).toBe('ws-7');
  });

  it('does NOT stamp a genuinely external /api host', async () => {
    const spy = stubWindow('ws-7');
    installWorkspaceHeaderFetch();
    await window.fetch('https://example.com/api/x');
    expect(stampedWs(spy)).toBeNull();
  });

  it('is idempotent — installing twice does not double-wrap', async () => {
    const spy = stubWindow('ws-7');
    installWorkspaceHeaderFetch();
    installWorkspaceHeaderFetch();
    await window.fetch('/api/x');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stampedWs(spy)).toBe('ws-7');
  });

  it('preserves the injected workspace when Inbox navigation drops the ws query', async () => {
    const spy = stubWindow('ws-native-fixture');
    window.location.href = 'http://127.0.0.1:3070/onboarding?ws=ws-native-fixture';
    installWorkspaceHeaderFetch();
    window.location.href = 'http://127.0.0.1:3070/inbox?opci=all&opcis=coord-message%3Afixture';
    await window.fetch('/api/zero-harness/rest-query?name=plans.attention');
    expect(stampedWs(spy)).toBe('ws-native-fixture');
  });

  it('without an injected workspace a bare Inbox URL stamps default, unlike an explicit feed probe', async () => {
    const spy = stubWindow();
    window.location.href = 'http://127.0.0.1:3070/inbox?opci=all';
    installWorkspaceHeaderFetch();
    await window.fetch('/api/zero-harness/rest-query?name=plans.attention');
    expect(stampedWs(spy)).toBe('default');
  });
});

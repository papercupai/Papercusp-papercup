/**
 * Coverage for the EventSource workspace wrapper (P-015): operator API SSE
 * connects get ?ws= appended from getBrowserWorkspaceId() — because EventSource
 * cannot set a custom header, this is how a live stream carries its window's
 * workspace. window is stubbed (bare node env).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWorkspaceParamEventSource } from './workspace-eventsource';

afterEach(() => vi.unstubAllGlobals());

function stubWindow(ws?: string) {
  const calls: Array<{ url: string }> = [];
  function FakeES(this: Record<string, unknown>, url: string) {
    calls.push({ url });
    this.url = url;
  }
  FakeES.CONNECTING = 0;
  FakeES.OPEN = 1;
  FakeES.CLOSED = 2;
  vi.stubGlobal('window', {
    __PAPERCUSP_WS__: ws,
    location: { href: 'http://127.0.0.1:3070/adv', origin: 'http://127.0.0.1:3070' },
    EventSource: FakeES,
  });
  return calls;
}

describe('installWorkspaceParamEventSource', () => {
  it('carries the portal machine without inventing a customer workspace selection', () => {
    const calls = stubWindow('control-plane');
    window.location.href = 'http://127.0.0.1:3070/?desktopHost=machine-b';
    installWorkspaceParamEventSource({ workspace: false });
    new window.EventSource('/api/operator-sync/sse');
    expect(calls[0].url).toBe('/api/operator-sync/sse?desktopHost=machine-b');
    new window.EventSource('https://external.test/api/sse');
    expect(calls[1].url).toBe('https://external.test/api/sse');
  });

  it('appends ?ws= to an operator SSE URL', () => {
    const calls = stubWindow('ws-7');
    installWorkspaceParamEventSource();
    new window.EventSource('/api/zero-harness/sse');
    expect(calls[0].url).toBe('/api/zero-harness/sse?ws=ws-7');
  });

  it('merges ?ws= alongside an existing query', () => {
    const calls = stubWindow('ws-7');
    installWorkspaceParamEventSource();
    new window.EventSource('/api/backups/events?since=x');
    expect(calls[0].url).toBe('/api/backups/events?since=x&ws=ws-7');
  });

  it('leaves a non-operator URL untouched', () => {
    const calls = stubWindow('ws-7');
    installWorkspaceParamEventSource();
    new window.EventSource('https://example.com/api/stream');
    expect(calls[0].url).toBe('https://example.com/api/stream');
  });

  it('preserves the static readyState constants', () => {
    stubWindow('ws-7');
    installWorkspaceParamEventSource();
    expect(window.EventSource.OPEN).toBe(1);
    expect(window.EventSource.CONNECTING).toBe(0);
    expect(window.EventSource.CLOSED).toBe(2);
  });

  it('is idempotent — installing twice does not double-wrap', () => {
    const calls = stubWindow('ws-7');
    installWorkspaceParamEventSource();
    installWorkspaceParamEventSource();
    new window.EventSource('/api/x/sse');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/x/sse?ws=ws-7');
  });
});

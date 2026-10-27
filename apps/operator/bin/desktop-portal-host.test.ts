import { AsyncLocalStorage } from 'node:async_hooks';
import type { HttpBindings } from '@hono/node-server';
import { describe, expect, it, vi } from 'vitest';
import { runAsExternalIngress } from '@papercusp/operator-core/lib/auth/forwarded-request-trust';
import { createDesktopPortalHost, type PortalOperatorScope } from './desktop-portal-host';

type Transport = Parameters<PortalOperatorScope>[0];
function fixture() {
  const scope = new AsyncLocalStorage<Transport>();
  const operator = vi.fn(async (request: Request, _bindings?: HttpBindings) => Response.json({
    path: new URL(request.url).pathname,
    query: new URL(request.url).search,
    method: request.method,
    body: request.method === 'GET' ? null : await request.text(),
    headers: Object.fromEntries(request.headers),
  }));
  const portal = { fetch: vi.fn(async (_request: Request) => Response.json({ portal: true })) };
  const host = createDesktopPortalHost({
    portal, operator,
    withOperatorTransport: (transport, run) => scope.run(transport, run),
  });
  const request = (path = '/api/apps', headers: HeadersInit = {}) => new Request(`http://localhost:21696${path}`, { headers });
  return { host, portal, operator, scope, request };
}

describe('local desktop portal host composition', () => {
  it('retains operator health and non-API requests without entering the portal', async () => {
    const f = fixture();
    for (const path of ['/api/health', '/assets/native.js', '/internal/docs/start']) {
      const request = f.request(path);
      const bindings = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as HttpBindings;
      const response = await f.host.fetch(request, bindings);
      expect((await response.json()).path).toBe(path);
      expect(f.operator).toHaveBeenLastCalledWith(request, bindings);
    }
    expect(f.portal.fetch).not.toHaveBeenCalled();
  });

  it('serves portal-owned requests locally with no HTTP or operator passthrough', async () => {
    const f = fixture();
    const response = await f.host.fetch(f.request());
    expect(await response.json()).toEqual({ portal: true });
    expect(f.portal.fetch).toHaveBeenCalledOnce();
    expect(f.operator).not.toHaveBeenCalled();
    expect(f.scope.getStore()).toBeUndefined();
  });

  it('refuses foreign origins, rebinding hosts, forwarding markers and remote socket peers before local identity', async () => {
    const f = fixture();
    const requests = [
      f.request('/api/preferences', { origin: 'https://attacker.example' }),
      f.request('/api/preferences', { origin: 'null' }),
      f.request('/api/preferences', { host: 'attacker.example' }),
      f.request('/api/preferences', { 'x-forwarded-for': '203.0.113.1' }),
      f.request('/api/preferences', { 'x-papercusp-ingress': 'external' }),
      f.request('/api/preferences', { 'x-papercusp-hosted-user-id': 'hosted-user' }),
      new Request('https://attacker.example/api/preferences', { headers: { host: 'localhost' } }),
    ];
    for (const request of requests) expect((await f.host.fetch(request)).status).toBe(403);
    const remote = { incoming: { socket: { remoteAddress: '203.0.113.8' } } } as HttpBindings;
    expect((await f.host.fetch(f.request(), remote)).status).toBe(403);
    const external = await runAsExternalIngress('test', () => f.host.fetch(f.request()));
    expect(external.status).toBe(403);
    expect(f.portal.fetch).not.toHaveBeenCalled();
    expect(f.operator).not.toHaveBeenCalled();
  });

  it('preserves native webview origins and local IPv6 peers', async () => {
    const f = fixture();
    const bindings = { incoming: { socket: { remoteAddress: '::1' } } } as HttpBindings;
    for (const origin of ['http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:1420']) {
      expect((await f.host.fetch(f.request('/api/apps', { origin }), bindings)).status).toBe(200);
    }
    expect(f.portal.fetch).toHaveBeenCalledTimes(3);
  });

  it('terminates passthrough once in the operator with body, query, authority and workspace intact', async () => {
    const f = fixture();
    f.portal.fetch.mockImplementation(async () => f.scope.getStore()!('/api/settings?view=local', {
      method: 'POST', body: '{"theme":"dark"}', headers: {
        'content-type': 'application/json', 'x-papercusp-workspace': 'wrong', host: 'wrong',
      },
    }));
    const bindings = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as HttpBindings;
    const response = await f.host.fetch(f.request('/api/settings', {
      origin: 'http://tauri.localhost', 'x-papercusp-workspace': 'workspace-A',
      'x-papercusp-machine': 'machine-A', authorization: 'Bearer request-scoped', cookie: 'local=session',
    }), bindings);
    const body = await response.json();
    expect(body).toMatchObject({ path: '/api/settings', query: '?view=local', method: 'POST', body: '{"theme":"dark"}' });
    expect(body.headers).toMatchObject({
      host: 'localhost:21696', origin: 'http://tauri.localhost',
      'x-papercusp-workspace': 'workspace-A', 'x-papercusp-machine': 'machine-A',
      authorization: 'Bearer request-scoped', cookie: 'local=session', 'content-type': 'application/json',
    });
    expect(f.operator).toHaveBeenCalledOnce();
    expect(f.operator.mock.calls[0][1]).toBe(bindings);
    expect(f.portal.fetch).toHaveBeenCalledOnce();
  });

  it('keeps concurrent windows isolated and carries streaming responses and abort signals without buffering', async () => {
    const f = fixture();
    f.portal.fetch.mockImplementation(async request => {
      await Promise.resolve();
      return f.scope.getStore()!('/api/session/sse', { method: 'GET', headers: {}, signal: request.signal });
    });
    const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ready\n\n')); } });
    f.operator.mockImplementation(async request => new Response(source, { headers: {
      'content-type': 'text/event-stream', 'x-workspace': request.headers.get('x-papercusp-workspace')!,
    } }));
    const abort = new AbortController();
    const a = new Request('http://localhost:21696/api/session/sse', {
      signal: abort.signal, headers: { 'x-papercusp-workspace': 'A' },
    });
    const [first, second] = await Promise.all([
      f.host.fetch(a), f.host.fetch(f.request('/api/session/sse', { 'x-papercusp-workspace': 'B' })),
    ]);
    expect(first.body).toBe(source);
    expect(second.headers.get('x-workspace')).toBe('B');
    expect(first.headers.get('x-workspace')).toBe('A');
    abort.abort();
    expect(f.operator.mock.calls[0][0].signal.aborted).toBe(true);
    await source.cancel();
    expect(f.scope.getStore()).toBeUndefined();
  });

  it('rejects upstream authority overrides and traversal out of the operator route trees', async () => {
    const f = fixture();
    for (const path of ['https://attacker.example/api/settings', '//attacker.example/api/settings', '/api/../../private', '/api/\\attacker.example', '/api/settings#secret']) {
      f.portal.fetch.mockImplementation(async () => f.scope.getStore()!(path, { method: 'GET', headers: {} }));
      await expect(f.host.fetch(f.request())).rejects.toThrow('desktop_portal_invalid_operator_path');
    }
    expect(f.operator).not.toHaveBeenCalled();
  });
});

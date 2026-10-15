/**
 * WI-10004174 — the external-ingress listener (the port a user's own tunnel points at) must
 * (a) answer the MCP OAuth surface for the tunnel's PUBLIC Host, which the DNS-rebinding guard
 *     used to refuse with 403 host_not_allowed, and
 * (b) serve nothing else, which it used to do: the whole app, every `auth:'public'` route
 *     included, was reachable through the tunnel.
 * Both are driven through the real host composition (host-handler.ts), not a stand-in.
 */
import { describe, expect, it } from 'vitest';
import { externalIngressHandler, handler } from './host-handler';
import { EXTERNAL_INGRESS_SERVED_PATHS, PHONE_DEVICE_PATHS, isServedOnExternalIngress } from './external-ingress-paths';

const PUBLIC_HOST = 'ws.example.org';
const WEBHOOK_ID = '0b9f3c2e-4d51-4a7e-9c0f-2f8d6a1b3e57';

function get(path: string, host: string): Request {
  return new Request(`http://${host}${path}`, {
    headers: { host, 'x-forwarded-proto': 'https' },
  });
}

describe('external-ingress listener (WI-10004174)', () => {
  it('serves the OAuth authorization-server metadata to the tunnel\'s public Host', async () => {
    const res = await externalIngressHandler(get('/api/connected-apps/oauth/authorization-server', PUBLIC_HOST));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token_endpoint?: string };
    expect(body.token_endpoint).toBe(`https://${PUBLIC_HOST}/api/connected-apps/oauth/token`);
  });

  it('serves the root RFC 8414 well-known document through the tunnel', async () => {
    const res = await externalIngressHandler(get('/.well-known/oauth-authorization-server', PUBLIC_HOST));
    expect(res.status).toBe(200);
  });

  it('refuses every other route with 404, even an auth:\'public\' one addressed to localhost', async () => {
    for (const path of ['/api/coord/presence', '/api/health', '/api/connected-apps', '/wiki']) {
      for (const host of [PUBLIC_HOST, 'localhost']) {
        const res = await externalIngressHandler(get(path, host));
        expect(res.status, `${host}${path}`).toBe(404);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, `${host}${path}`).toBe('not_served_on_external_ingress');
      }
    }
  });

  it('routes a signed-webhook POST to the webhook route (P-017, D-032 #4)', async () => {
    // A body that is not a JSON object is refused by the webhook route itself, before any
    // database read — so this proves the listener reached the route, not the 404 wall.
    const res = await externalIngressHandler(new Request(`http://${PUBLIC_HOST}/api/hooks/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
      body: '[1,2,3]',
    }));
    const text = await res.text();
    expect(res.status, text).toBe(400);
    expect((JSON.parse(text) as { error?: unknown }).error, text).toBe('invalid_body');
  });

  it('routes the RFC 8628 device-grant POSTs to their routes (WI-10004269, D-004/D-018)', async () => {
    // Each body is refused by the route itself before any database read, so a 400 from the
    // route (not the 404 wall) proves the listener serves the path to an app on another host.
    const post = (path: string, body: unknown) =>
      externalIngressHandler(new Request(`http://${PUBLIC_HOST}${path}`, {
        method: 'POST',
        headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    const code = await post('/api/connected-apps/device/code', { tools: 5 });
    const codeText = await code.text();
    expect(code.status, codeText).toBe(400);
    expect((JSON.parse(codeText) as { error?: { code?: string } }).error?.code, codeText).toBe('invalid_request');
    const token = await post('/api/connected-apps/device/token', { deviceCode: 'not-a-device-code' });
    const tokenText = await token.text();
    expect(token.status, tokenText).toBe(400);
    expect((JSON.parse(tokenText) as { error?: unknown }).error, tokenText).toBe('invalid_grant');
  });

  it('keeps the device approval page, pending list and decision route off the tunnel', async () => {
    for (const [method, path] of [
      ['GET', '/api/connected-apps/device'],
      ['GET', '/api/connected-apps/device/pending'],
      ['POST', '/api/connected-apps/device/decision'],
    ] as const) {
      const res = await externalIngressHandler(new Request(`http://${PUBLIC_HOST}${path}`, {
        method,
        headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https' },
      }));
      expect(res.status, `${method} ${path}`).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${method} ${path}`).toBe('not_served_on_external_ingress');
    }
  });

  it('admits one-use phone pairing input validation and requires device authentication for reads', async () => {
    const pair = await externalIngressHandler(new Request(`http://${PUBLIC_HOST}/api/device/pair`, {
      method: 'POST', headers: { host: PUBLIC_HOST, 'content-type': 'application/json' }, body: '{}',
    }));
    expect(pair.status).toBe(400);
    for (const path of ['/api/device/attention', '/api/device/plans', '/api/device/monitoring',
      '/api/device/runtime-config', '/api/device/operator/conversation/turns']) {
      const response = await externalIngressHandler(get(path, PUBLIC_HOST));
      expect(response.status, path).toBe(401);
    }
  });

  it('never exposes desktop pairing controls or the public QR renderer even with a localhost Host', async () => {
    for (const path of ['/api/device/desktop/mint-pair-token', '/api/device/desktop/devices',
      '/api/device/desktop/devices/phone-id', '/api/device/qr.svg']) {
      const response = await externalIngressHandler(get(path, 'localhost'));
      expect(response.status, path).toBe(404);
      expect((await response.json()).error.code).toBe('not_served_on_external_ingress');
    }
  });

  it('allows only enumerated phone paths and bounded authenticated parameter shapes', () => {
    for (const path of PHONE_DEVICE_PATHS) expect(isServedOnExternalIngress(path), path).toBe(true);
    for (const path of ['/api/device/devices/mobile-123', '/api/device/plans/release-plan',
      '/api/device/plans/release-plan/items/P-001/status', '/api/device/harnesses/fixture/log/stream']) {
      expect(isServedOnExternalIngress(path), path).toBe(true);
    }
    for (const path of ['/api/device', '/api/device/new-public-route', '/api/device/pair/extra',
      '/api/device/desktop/mint-pair-token', '/api/device/plans/fixture/extra',
      '/api/device/plans/fixture/items/arbitrary/status', '/api/device/plans/%2fadmin',
      '/api/device/devices/phone/extra', '/api/device/harnesses/fixture/admin']) {
      expect(isServedOnExternalIngress(path), path).toBe(false);
    }
  });

  it('leaves the loopback listener refusing a public Host (the rebinding guard still applies there)', async () => {
    const res = await handler(get('/api/connected-apps/oauth/authorization-server', PUBLIC_HOST));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('host_not_allowed');
  });
});

describe('isServedOnExternalIngress', () => {
  it('matches exact served paths, with or without a trailing slash', () => {
    for (const path of EXTERNAL_INGRESS_SERVED_PATHS) {
      expect(isServedOnExternalIngress(path), path).toBe(true);
      expect(isServedOnExternalIngress(`${path}/`), `${path}/`).toBe(true);
    }
    expect(EXTERNAL_INGRESS_SERVED_PATHS.has('/api/mcp')).toBe(true);
    expect(EXTERNAL_INGRESS_SERVED_PATHS.has('/api/connected-apps/oauth/token')).toBe(true);
  });

  it('never matches by prefix', () => {
    for (const path of ['/', '/api', '/api/mcp/extra', '/api/connected-apps/oauth', '/api/connected-apps/oauth/pending', '/.well-known']) {
      expect(isServedOnExternalIngress(path), path).toBe(false);
    }
  });

  it('serves exactly one webhook path shape: /api/hooks/<lowercase uuid>', () => {
    expect(isServedOnExternalIngress(`/api/hooks/${WEBHOOK_ID}`)).toBe(true);
    expect(isServedOnExternalIngress(`/api/hooks/${WEBHOOK_ID}/`)).toBe(true);
    for (const path of [
      '/api/hooks',
      '/api/hooks/',
      '/api/hooks/not-a-uuid',
      `/api/hooks/${WEBHOOK_ID}/extra`,
      `/api/hooks/${WEBHOOK_ID.toUpperCase()}`,
      `/api/hooks/${WEBHOOK_ID}x`,
      `/api/hooksx/${WEBHOOK_ID}`,
    ]) {
      expect(isServedOnExternalIngress(path), path).toBe(false);
    }
  });
});

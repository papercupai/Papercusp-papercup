/**
 * external-app-access-to-workspaces-2026-09-29 P-004 / R-7 — forwarded traffic gets
 * no local trust.
 *
 * D-010 measured that a tunnel rewriting Host to localhost made the real
 * `isLoopbackRequest` return TRUE, and `principalFromLoopback` then minted a `'*'`
 * loopback principal with no credential. D-010's three probe cases are the minimum
 * matrix here, plus every other local-trust gate that read the Host header
 * (`requireLoopbackOr403`, the device pair-token gate, the default-user fallback).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../auth', () => ({
  getSessionUser: vi.fn(async () => null),
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'default-user' })),
}));

import {
  EXTERNAL_INGRESS_MARKER_HEADER,
  externalIngressPort,
  externalIngressReason,
  forwardedRequestVerdict,
  runAsExternalIngress,
} from './forwarded-request-trust';
import { isLoopbackRequest } from '../superuser-token';
import { principalFromLoopback } from './principal/from-loopback';
import { requireLoopbackOr403 } from '../endpoint-route/loopback-guard';
import { isLoopbackHost as deviceIsLoopbackHost } from '../endpoint-route/routes/device/_shared';
import { getSessionUserOrLocalDefault } from '../endpoint-route/session-or-local';

function h(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

function req(url: string, init: Record<string, string> = {}): Request {
  const headers = new Headers(init);
  if (!headers.has('host')) headers.set('host', new URL(url).host);
  return new Request(url, { headers });
}

beforeEach(() => {
  delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
});

describe('D-010 matrix — isLoopbackRequest and principalFromLoopback', () => {
  it('case 1: public Host + outside X-Forwarded-For is not loopback', () => {
    const headers = h({ host: 'ws.example.com', 'x-forwarded-for': '203.0.113.5' });
    expect(isLoopbackRequest(headers)).toBe(false);
    expect(principalFromLoopback(headers)).toBeNull();
  });

  it('case 2 (THE REGRESSION): Host: localhost + outside X-Forwarded-For is not loopback', () => {
    const headers = h({ host: 'localhost:3070', 'x-forwarded-for': '203.0.113.5' });
    expect(isLoopbackRequest(headers)).toBe(false);
    expect(principalFromLoopback(headers)).toBeNull();
    const ipv4Host = h({ host: '127.0.0.1:3070', 'x-forwarded-for': '198.51.100.7, 127.0.0.1' });
    expect(isLoopbackRequest(ipv4Host)).toBe(false);
  });

  it('case 3: Host 127.0.0.1 with no forwarding headers is local on the ordinary listener', () => {
    const headers = h({ host: '127.0.0.1:3070' });
    expect(isLoopbackRequest(headers)).toBe(true);
    expect(principalFromLoopback(headers)?.kind).toBe('loopback');
  });

  it('case 3 via the external-ingress listener: the same headers get no local trust', () => {
    const headers = h({ host: '127.0.0.1:3070' });
    runAsExternalIngress('external-ingress', () => {
      expect(isLoopbackRequest(headers)).toBe(false);
      expect(principalFromLoopback(headers)).toBeNull();
      expect(externalIngressReason(headers)).toBe('external-ingress-listener:external-ingress');
    });
    // The listener scope ends with its request.
    expect(isLoopbackRequest(headers)).toBe(true);
  });
});

describe('outside-traffic signals beyond X-Forwarded-For', () => {
  it('the relay marker removes local trust, whatever its value', () => {
    const headers = h({ host: 'localhost:3070', [EXTERNAL_INGRESS_MARKER_HEADER]: 'relay' });
    expect(isLoopbackRequest(headers)).toBe(false);
    expect(externalIngressReason(headers)).toBe('external-ingress-marker');
  });

  it('an edge-only header (Cloudflare, Tailscale Funnel) is external on its own', () => {
    expect(isLoopbackRequest(h({ host: 'localhost', 'cf-ray': '8a1b2c3d4e5f-IAD' }))).toBe(false);
    expect(isLoopbackRequest(h({ host: 'localhost', 'tailscale-funnel-request': '?1' }))).toBe(false);
    expect(isLoopbackRequest(h({ host: 'localhost', 'cf-connecting-ip': '203.0.113.5' }))).toBe(false);
  });

  it('RFC 7239 Forwarded: an outside for= is external, a loopback-only chain is a local proxy', () => {
    expect(isLoopbackRequest(h({ host: 'localhost', forwarded: 'for=203.0.113.5;proto=https' }))).toBe(false);
    expect(isLoopbackRequest(h({ host: 'localhost', forwarded: 'for="[2001:db8::1]:4711"' }))).toBe(false);
    expect(isLoopbackRequest(h({ host: 'localhost', forwarded: 'for="[::1]:4711", for=127.0.0.1' }))).toBe(true);
  });

  it('forwarding headers that carry no client address cannot prove locality', () => {
    expect(isLoopbackRequest(h({ host: 'localhost', 'x-forwarded-proto': 'https' }))).toBe(false);
    expect(forwardedRequestVerdict(h({ 'x-forwarded-proto': 'https' }))).toEqual({
      kind: 'external',
      reason: 'forwarded-without-client-address',
    });
  });

  it('a public X-Forwarded-Host is external even when the forwarded client is loopback', () => {
    const headers = h({ host: 'localhost', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'ws.example.com' });
    expect(isLoopbackRequest(headers)).toBe(false);
  });

  it('an unparseable forwarded client fails closed', () => {
    expect(isLoopbackRequest(h({ host: 'localhost', 'x-forwarded-for': 'unknown' }))).toBe(false);
  });

  it('a local proxy whose every forwarded client is loopback keeps local trust', () => {
    expect(isLoopbackRequest(h({ host: 'localhost:3070', 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
    expect(forwardedRequestVerdict(h({ 'x-forwarded-for': '127.0.0.1, ::1' }))).toEqual({ kind: 'local-proxy' });
    expect(forwardedRequestVerdict(h({ host: 'localhost' }))).toEqual({ kind: 'direct' });
  });
});

describe('every Host-based local-trust gate refuses forwarded traffic', () => {
  const forwarded = { 'x-forwarded-for': '203.0.113.5' };

  it('requireLoopbackOr403 (the auth:loopback route tier) answers 403 external_ingress_not_local', async () => {
    const gate = requireLoopbackOr403(req('http://localhost:3070/api/admin/thing', forwarded));
    expect(gate?.status).toBe(403);
    expect(await gate?.json()).toMatchObject({ error: 'external_ingress_not_local' });
    expect(requireLoopbackOr403(req('http://localhost:3070/api/admin/thing'))).toBeNull();
  });

  it('the device pair-token gate refuses a forwarded Host: localhost', () => {
    expect(deviceIsLoopbackHost(req('http://localhost:3070/api/device/mint', forwarded))).toBe(false);
    expect(deviceIsLoopbackHost(req('http://localhost:3070/api/device/mint'))).toBe(true);
  });

  it('the default-user fallback is withheld from forwarded traffic', async () => {
    expect(await getSessionUserOrLocalDefault(req('http://localhost:3070/api/x', forwarded))).toBeNull();
    expect(await getSessionUserOrLocalDefault(req('http://localhost:3070/api/x'))).toEqual({
      id: 'default-user', workspace_id: 'ws-test',
    });
  });

  it('the external-ingress listener refuses every gate for a plain loopback request', async () => {
    await runAsExternalIngress('external-ingress', async () => {
      expect(requireLoopbackOr403(req('http://127.0.0.1:3070/api/admin/thing'))?.status).toBe(403);
      expect(deviceIsLoopbackHost(req('http://127.0.0.1:3070/api/device/mint'))).toBe(false);
      expect(await getSessionUserOrLocalDefault(req('http://127.0.0.1:3070/api/x'))).toBeNull();
    });
  });
});

describe('externalIngressPort', () => {
  it('reads a valid port and ignores anything else', () => {
    expect(externalIngressPort({ PAPERCUSP_EXTERNAL_INGRESS_PORT: '3072' })).toBe(3072);
    expect(externalIngressPort({})).toBeNull();
    expect(externalIngressPort({ PAPERCUSP_EXTERNAL_INGRESS_PORT: 'abc' })).toBeNull();
    expect(externalIngressPort({ PAPERCUSP_EXTERNAL_INGRESS_PORT: '70000' })).toBeNull();
  });
});

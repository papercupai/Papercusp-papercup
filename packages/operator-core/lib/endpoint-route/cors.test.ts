/**
 * Unit tests for the route-layer CORS policy (cors.ts) — the cross-origin
 * allowlist that admits the desktop WebView + dev tabs and the CSRF guard that
 * backstops cookie-less mutating handlers (EI-338). Pure-logic + a Hono harness
 * for the middleware. (whole-app-test-coverage-breadth-2026-06-14.)
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { corsFor, defaultCorsOrigin, requireAllowedOriginOr403 } from './cors';

describe('defaultCorsOrigin', () => {
  it('returns "" for a missing origin', () => {
    expect(defaultCorsOrigin(undefined)).toBe('');
    expect(defaultCorsOrigin(null)).toBe('');
    expect(defaultCorsOrigin('')).toBe('');
  });

  it('echoes the desktop WebView origin (any scheme, "://tauri.localhost" suffix)', () => {
    expect(defaultCorsOrigin('tauri://tauri.localhost')).toBe('tauri://tauri.localhost');
    expect(defaultCorsOrigin('https://tauri.localhost')).toBe('https://tauri.localhost');
    expect(defaultCorsOrigin('http://tauri.localhost')).toBe('http://tauri.localhost');
  });

  it('echoes the http localhost / 127.0.0.1 / 10.0.2.2 dev origins (with a port)', () => {
    expect(defaultCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(defaultCorsOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(defaultCorsOrigin('http://10.0.2.2:8080')).toBe('http://10.0.2.2:8080');
  });

  it('refuses non-http, wrong-scheme, foreign, and look-alike origins (security)', () => {
    expect(defaultCorsOrigin('https://evil.com')).toBe('');
    expect(defaultCorsOrigin('https://localhost:3000')).toBe(''); // https, the allowlist is http-only
    expect(defaultCorsOrigin('http://localhost')).toBe(''); // no ":port" → no prefix match
    expect(defaultCorsOrigin('http://localhost.evil.com:80')).toBe(''); // suffix-injection guard
    expect(defaultCorsOrigin('http://127.0.0.1.evil.com:80')).toBe('');
    expect(defaultCorsOrigin('http://notlocalhost:3000')).toBe('');
    expect(defaultCorsOrigin('http://tauri.localhost.evil.com')).toBe(''); // not the exact suffix
  });
});

describe('requireAllowedOriginOr403 (CSRF guard)', () => {
  const reqWith = (origin?: string) =>
    new Request('http://127.0.0.1/x', { method: 'POST', headers: origin ? { origin } : {} });

  it('allows a request with NO Origin header (curl / server-to-server / SU bearer)', () => {
    expect(requireAllowedOriginOr403(reqWith())).toBeNull();
  });

  it('allows an allowlisted Origin', () => {
    expect(requireAllowedOriginOr403(reqWith('http://localhost:3000'))).toBeNull();
    expect(requireAllowedOriginOr403(reqWith('tauri://tauri.localhost'))).toBeNull();
  });

  it('returns a 403 cross_origin_blocked for a foreign Origin', async () => {
    const res = requireAllowedOriginOr403(reqWith('https://evil.com'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toEqual({ error: 'cross_origin_blocked' });
  });
});

describe('corsFor middleware', () => {
  const appWith = (origins?: readonly string[]) => {
    const app = new Hono();
    app.use('*', corsFor(origins));
    app.get('/x', (c) => c.text('ok'));
    return app;
  };

  it('echoes an allowlisted origin and enables credentials (default allowlist)', async () => {
    const res = await appWith().request('/x', { headers: { origin: 'http://localhost:3000' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does NOT echo a foreign origin (default allowlist)', async () => {
    const res = await appWith().request('/x', { headers: { origin: 'https://evil.com' } });
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao === null || acao === '').toBe(true);
  });

  it('handles the OPTIONS preflight itself (204 + allow-methods + the x-papercusp-workspace header)', async () => {
    const res = await appWith().request('/x', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-papercusp-workspace');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-papercusp-machine');
  });

  it('explicit origins list: exact-match only, foreign refused', async () => {
    const app = appWith(['https://allowed.example']);
    const ok = await app.request('/x', { headers: { origin: 'https://allowed.example' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
    const no = await app.request('/x', { headers: { origin: 'http://localhost:3000' } });
    const acao = no.headers.get('access-control-allow-origin');
    expect(acao === null || acao === '').toBe(true);
  });
});

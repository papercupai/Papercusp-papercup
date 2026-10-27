/**
 * host-cors.test.ts — the credentialed `/api/*` CORS allowlist + middleware.
 *
 * Security-relevant: allowedLocalApiOrigin is the gate that decides which Origins
 * get `Access-Control-Allow-Origin` + credentials reflected back. Too loose and a
 * malicious web origin can ride the user's cookies against the loopback API; too
 * tight and the desktop/mobile shells break. So the allow/deny boundary is pinned
 * here, plus the middleware's three behaviors (no-origin → passthrough, allowed
 * OPTIONS → 204 preflight, allowed request → header decoration).
 *
 * Run: cd apps/operator && npx vitest run bin/host-cors.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { allowedLocalApiOrigin, apiCors } from './host-cors';

describe('allowedLocalApiOrigin', () => {
  it('returns null for a missing origin', () => {
    expect(allowedLocalApiOrigin(null)).toBeNull();
  });

  it('rejects the literal "null" origin (sandboxed/file contexts)', () => {
    expect(allowedLocalApiOrigin('null')).toBeNull();
  });

  it('allows any-port loopback over http/https, reflecting the exact origin', () => {
    for (const o of [
      'http://localhost',
      'http://localhost:3055',
      'http://localhost:3070',
      'http://127.0.0.1:8788',
      'https://localhost:1234',
      'http://10.0.2.2', // Android emulator host loopback
      'http://tauri.localhost',
    ]) {
      expect(allowedLocalApiOrigin(o), o).toBe(o);
    }
  });

  it('allows the native-shell schemes on an allowed host', () => {
    expect(allowedLocalApiOrigin('tauri://tauri.localhost')).toBe('tauri://tauri.localhost');
    expect(allowedLocalApiOrigin('capacitor://localhost')).toBe('capacitor://localhost');
    expect(allowedLocalApiOrigin('ionic://localhost')).toBe('ionic://localhost');
  });

  it('denies a non-loopback host even over an allowed protocol', () => {
    expect(allowedLocalApiOrigin('http://evil.com')).toBeNull();
    expect(allowedLocalApiOrigin('https://localhost.evil.com')).toBeNull(); // suffix trick
    expect(allowedLocalApiOrigin('http://192.168.1.5:3070')).toBeNull();
  });

  it('denies a disallowed protocol even on an allowed host', () => {
    expect(allowedLocalApiOrigin('ftp://localhost')).toBeNull();
    expect(allowedLocalApiOrigin('file://localhost')).toBeNull();
    expect(allowedLocalApiOrigin('ws://localhost:3070')).toBeNull();
  });

  it('returns null for an unparseable origin (URL ctor throws)', () => {
    expect(allowedLocalApiOrigin('not a url')).toBeNull();
    expect(allowedLocalApiOrigin('http://')).toBeNull();
  });

  it('rejects URL-shaped values that are not serialized origins', () => {
    expect(allowedLocalApiOrigin('http://localhost:3070/private')).toBeNull();
    expect(allowedLocalApiOrigin('http://user@localhost:3070')).toBeNull();
    expect(allowedLocalApiOrigin('http://localhost:3070?x=1')).toBeNull();
  });
});

type FakeCtx = {
  req: { header: (n: string) => string | undefined; method: string };
  res: { headers: Headers };
};
function makeCtx(origin: string | null, method = 'GET'): FakeCtx {
  return {
    req: {
      header: (n: string) => (n.toLowerCase() === 'origin' ? (origin ?? undefined) : undefined),
      method,
    },
    res: { headers: new Headers() },
  };
}

describe('apiCors middleware', () => {
  it('passes through (calls next, sets no CORS header) for a disallowed origin', async () => {
    const ctx = makeCtx('http://evil.com');
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await apiCors(ctx as any, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('passes through when there is no origin at all', async () => {
    const ctx = makeCtx(null);
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await apiCors(ctx as any, next as any);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes through a null origin without reflecting credentials', async () => {
    const ctx = makeCtx('null');
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await apiCors(ctx as any, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers an allowed OPTIONS preflight with 204 + reflected origin, without calling next', async () => {
    const ctx = makeCtx('http://localhost:3055', 'OPTIONS');
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await apiCors(ctx as any, next as any)) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3055');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('x-papercusp-machine');
  });

  it('decorates a downstream response for an allowed non-preflight request', async () => {
    const ctx = makeCtx('http://127.0.0.1:3070', 'GET');
    const next = vi.fn(async () => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await apiCors(ctx as any, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:3070');
    expect(ctx.res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(ctx.res.headers.get('Vary')).toContain('Origin');
  });
});

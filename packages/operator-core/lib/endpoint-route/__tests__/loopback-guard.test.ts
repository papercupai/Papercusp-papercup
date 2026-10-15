/**
 * loopback-guard.test.ts — D-009 (production-readiness-test-coverage).
 *
 * Unit coverage for the shared loopback detection + the 403 guard used by the
 * destructive `auth: 'public'` routes. The host is derived from `req.url`
 * (what @hono/node-server builds from the Host header), so these tests drive
 * full URLs rather than fighting the Fetch spec's forbidden `Host` header.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackHost, requireLoopbackOr403 } from '../loopback-guard';

describe('isLoopbackHost', () => {
  it('accepts loopback names — bare, with port, ipv6-bracketed, case-insensitive', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '::1',
      '10.0.2.2',
      'tauri.localhost',
      'localhost:3070',
      '127.0.0.1:3055',
      '[::1]:3070',
      'LOCALHOST',
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects non-loopback hosts + null/empty', () => {
    for (const h of [
      'evil.com',
      '192.168.1.5',
      'example.com:3070',
      '10.0.0.5',
      '0.0.0.0',
      null,
      '',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  // Gap 14 — host-spoof resistance. A suffix-prepend like `127.0.0.1.evil.com`
  // points at evil.com (the DNS label after the final dot wins), NOT loopback;
  // the guard MUST reject it. A pass here would be a critical auth-bypass:
  // backup-restore / flag-mutation reachable off-box by forging the Host.
  it('rejects suffix-spoofed loopback hosts (e.g. 127.0.0.1.evil.com)', () => {
    const spoofs: Array<[string | null, boolean]> = [
      ['127.0.0.1', true],            // bare loopback ipv4
      ['localhost', true],            // bare loopback name
      ['[::1]', true],                // bracketed ipv6 loopback, no port
      ['[::1]:3070', true],           // bracketed ipv6 loopback, with port
      ['127.0.0.1.evil.com', false],  // SPOOF: loopback as a prefix label
      ['127.0.0.1.evil.com:3070', false], // SPOOF + port
      ['localhost.evil.com', false],  // SPOOF: name prefix
      ['evil.com', false],            // plain remote
      [null, false],                  // missing Host
      ['', false],                    // empty Host
    ];
    for (const [host, expected] of spoofs) {
      expect(isLoopbackHost(host), `host=${JSON.stringify(host)}`).toBe(expected);
    }
  });
});

describe('requireLoopbackOr403', () => {
  const req = (url: string) => new Request(url, { method: 'POST' });
  afterEach(() => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });

  it('returns null (proceed) for a loopback-origin request', () => {
    expect(requireLoopbackOr403(req('http://localhost/backups/restore'))).toBeNull();
    expect(requireLoopbackOr403(req('http://127.0.0.1:3070/flags/set'))).toBeNull();
  });

  it('returns a 403 for a non-loopback-origin request', async () => {
    const res = requireLoopbackOr403(req('http://192.168.1.50:3070/backups/restore'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: 'loopback_only' });
  });

  it('guards native roster GETs by loopback origin, independently of workspace cookies', async () => {
    const path = '/api/zero-harness/rest-query?name=advRoster.list&args=' +
      encodeURIComponent(JSON.stringify({ workspaceId: 'selected-workspace' }));
    for (const token of ['selected-workspace-cookie', 'foreign-workspace-cookie']) {
      const headers = { cookie: `session=${token}`, 'x-papercusp-workspace': 'selected-workspace' };
      expect(requireLoopbackOr403(new Request('http://127.0.0.1:3070' + path, { headers }))).toBeNull();
      const denied = requireLoopbackOr403(new Request('http://foreign-roster.invalid' + path, { headers }));
      expect(denied?.status).toBe(403);
      expect(await denied!.json()).toMatchObject({ error: 'loopback_only' });
    }
  });

  it('PAPERCUSP_ALLOW_REMOTE_ADMIN=1 opts a non-loopback request through', () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    expect(requireLoopbackOr403(req('http://evil.example.com/flags/set'))).toBeNull();
  });
});

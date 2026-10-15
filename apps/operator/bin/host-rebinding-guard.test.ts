/**
 * DNS-rebinding guard (open-source-release-2026-09-29 P-010). The attack a
 * rebinding page can mount is a same-origin GET with a foreign Host header and
 * no Origin header; these tests pin that it is refused on a loopback-bound
 * operator while every legitimate local caller still passes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { hostRebindingGuard, isHostHeaderAllowed } from './host-rebinding-guard';

const local: NodeJS.ProcessEnv = {};

describe('isHostHeaderAllowed', () => {
  it.each([
    '127.0.0.1:3070',
    'localhost:3055',
    '[::1]:3070',
    'LOCALHOST',
    'tauri.localhost',
    'papercusp.localhost',
  ])('allows loopback host %s', (host) => {
    expect(isHostHeaderAllowed(host, local)).toBe(true);
  });

  it.each([
    'evil.example:3070',
    'evil.example',
    '192.168.1.20:3070',
    'mainserver:3070',
    'localhost.evil.example',
    '127.0.0.1.nip.io:3070',
  ])('refuses non-loopback host %s', (host) => {
    expect(isHostHeaderAllowed(host, local)).toBe(false);
  });

  it('allows a request with no Host header (a non-browser local client)', () => {
    expect(isHostHeaderAllowed(undefined, local)).toBe(true);
    expect(isHostHeaderAllowed('', local)).toBe(true);
  });

  it('is exempt under the explicit remote-admin opt-in', () => {
    expect(isHostHeaderAllowed('mainserver:3070', { PAPERCUSP_ALLOW_REMOTE_ADMIN: '1' })).toBe(true);
    expect(isHostHeaderAllowed('mainserver:3070', { PAPERCUSP_ALLOW_REMOTE_ADMIN: '0' })).toBe(false);
  });

  it('preserves the exact hosted and VM distribution exemptions', () => {
    for (const profile of ['hosted-control-plane', 'vm-release']) {
      expect(isHostHeaderAllowed('public.example', { PAPERCUSP_DISTRIBUTION_PROFILE: profile })).toBe(true);
    }
    for (const profile of ['', 'hosted-control-plane-other', 'VM-RELEASE', 'desktop']) {
      expect(isHostHeaderAllowed('public.example', { PAPERCUSP_DISTRIBUTION_PROFILE: profile })).toBe(false);
    }
  });
});

describe('hostRebindingGuard middleware', () => {
  const saved = process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  const app = new Hono();
  app.use('/api/*', hostRebindingGuard);
  app.get('/api/coord/presence', (c) => c.json({ active: ['secret'] }));

  it('refuses a rebinding-shaped GET and never reaches the handler', async () => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
    try {
      const res = await app.request('http://evil.example:3070/api/coord/presence', {
        headers: { host: 'evil.example:3070' },
      });
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain('host_not_allowed');
      expect(body).not.toContain('secret');
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
      else process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = saved;
    }
  });

  it('serves the same GET addressed to loopback', async () => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
    try {
      const res = await app.request('http://127.0.0.1:3070/api/coord/presence', {
        headers: { host: '127.0.0.1:3070' },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('secret');
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
      else process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = saved;
    }
  });
});

describe('host-handler wiring', () => {
  it('registers the guard on /api/* before CORS and every handler', () => {
    const src = readFileSync(join(__dirname, 'host-handler.ts'), 'utf8');
    const guard = src.indexOf("host.use('/api/*', hostRebindingGuard);");
    const cors = src.indexOf("host.use('/api/*', apiCors);");
    const api = src.indexOf("host.all('/api/*'");
    expect(guard).toBeGreaterThan(-1);
    expect(cors).toBeGreaterThan(guard);
    expect(api).toBeGreaterThan(guard);
  });
});

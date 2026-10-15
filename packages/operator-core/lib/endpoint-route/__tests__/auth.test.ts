/**
 * Verification for the ported `auth` family — login / logout / signup /
 * change-password / me — mounted on a throwaway Hono app and exercised
 * via `app.request()`. Proves the `defineTool` ports serve identically
 * to the deleted Next `route.ts` files: status codes, JSON bodies, and
 * `Set-Cookie` headers (the cookie-jar replacement).
 *
 * The `@/lib/auth` surface is fully mocked — this tests the route ports,
 * not the auth library (which has its own `lib/auth.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../auth', () => ({
  SESSION_COOKIE: 'papercusp_session',
  DEFAULT_SESSION_TTL_MS: 2_592_000_000,
  login: vi.fn(),
  logout: vi.fn(),
  signup: vi.fn(),
  changePassword: vi.fn(),
  getSessionUser: vi.fn(),
  getSessionUserOrDefault: vi.fn(),
  listUsers: vi.fn(),
  updateDisplayName: vi.fn(),
}));
vi.mock('../../auth-audit', () => ({ recordAuthEvent: vi.fn() }));
// EI-347: the setup-token gate for password-less accounts — set per-test.
vi.mock('../../auth-setup-token', () => ({ verifySetupToken: vi.fn() }));
vi.mock('../../auth-rate-limit', () => ({
  // checkSoft/checkHard return a result object — set per-test in beforeEach.
  checkSoftGlobal: vi.fn(),
  refundSoftGlobal: vi.fn(async () => {}),
  checkSoftPerIp: vi.fn(),
  checkHardPerUser: vi.fn(),
  checkHardPerAccount: vi.fn(),
  // refund/burn/reset are fire-and-forget — the handler `.catch()`es them,
  // so they must always return a promise.
  refundSoftPerIp: vi.fn(async () => {}),
  burnHardPerAccount: vi.fn(async () => {}),
  resetHardPerAccount: vi.fn(async () => {}),
  burnHardPerUser: vi.fn(async () => {}),
  resetHardPerUser: vi.fn(async () => {}),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
// signup's open-signup gate reads the flag server-side (dynamic import).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../remote-auth-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../remote-auth-policy')>();
  return { ...actual, isRemoteRequest: vi.fn(() => false) };
});

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import authLogin from '../routes/auth/login';
import authLogout from '../routes/auth/logout';
import authSignup from '../routes/auth/signup';
import authChangePassword from '../routes/auth/change-password';
import authMe from '../routes/auth/me';
import {
  login, logout, signup, changePassword,
  getSessionUser, getSessionUserOrDefault, listUsers, updateDisplayName,
} from '../../auth';
import {
  checkSoftGlobal, refundSoftGlobal, checkSoftPerIp,
  checkHardPerAccount, burnHardPerAccount, resetHardPerAccount,
  checkHardPerUser, burnHardPerUser, resetHardPerUser,
} from '../../auth-rate-limit';
import { getFlag } from '@papercusp/flags/server';
import { verifySetupToken } from '../../auth-setup-token';
import { isRemoteRequest, REMOTE_OPERATOR_CAPABILITY } from '../../remote-auth-policy';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}

const USER = {
  id: 'u1', username: 'alice', display_name: 'Alice', has_password: true,
  workspace_id: 'ws-local', capabilities: ['*'],
};
const SESSION = { token: 'tok_abc', user: USER, expires_at: new Date(Date.now() + 86_400_000) };
const json = (b: unknown) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  vi.mocked(getSessionUser).mockResolvedValue(null);
  vi.mocked(getSessionUserOrDefault).mockResolvedValue(USER);
  vi.mocked(login).mockResolvedValue(SESSION);
  vi.mocked(logout).mockResolvedValue(undefined);
  vi.mocked(signup).mockResolvedValue(USER);
  vi.mocked(changePassword).mockResolvedValue(undefined);
  vi.mocked(listUsers).mockResolvedValue([]);
  vi.mocked(updateDisplayName).mockResolvedValue(undefined);
  vi.mocked(getFlag).mockResolvedValue(false);
  vi.mocked(checkSoftGlobal).mockResolvedValue({ ok: true, retryAfterS: undefined });
  vi.mocked(checkSoftPerIp).mockResolvedValue({ ok: true, retryAfterS: undefined });
  vi.mocked(checkHardPerAccount).mockResolvedValue({ ok: true, retryAfterS: undefined });
  vi.mocked(checkHardPerUser).mockResolvedValue({ ok: true, retryAfterS: undefined });
  // Default USER already has_password:true, so this never gates the existing tests;
  // set explicitly true so a stray call still "passes" unless a test wants it to fail.
  vi.mocked(verifySetupToken).mockReturnValue(true);
  vi.mocked(isRemoteRequest).mockReturnValue(false);
});
afterEach(() => vi.clearAllMocks());

describe('POST /auth/login', () => {
  const app = appWith(authLogin as AnyRoute);

  it('rejects a missing username with 400', async () => {
    const res = await app.request('/auth/login', json({ password: 'x' }));
    expect(res.status).toBe(400);
  });

  it('issues a session cookie on success', async () => {
    const res = await app.request('/auth/login', json({ username: 'alice', password: 'pw' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: { username: 'alice' } });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('papercusp_session=tok_abc');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('maps a bad_password error to 401', async () => {
    vi.mocked(login).mockRejectedValue(Object.assign(new Error('bad'), { code: 'bad_password' }));
    const res = await app.request('/auth/login', json({ username: 'alice', password: 'wrong' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_password' });
  });

  it('returns 429 when the soft per-IP gate trips', async () => {
    vi.mocked(checkSoftPerIp).mockResolvedValue({ ok: false, retryAfterS: 42 });
    const res = await app.request('/auth/login', json({ username: 'alice', password: 'pw' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', retry_after_s: 42 });
  });

  it('returns 429 when the global abuse budget trips before per-IP checks', async () => {
    vi.mocked(checkSoftGlobal).mockResolvedValue({ ok: false, retryAfterS: 17 });
    const res = await app.request('/auth/login', json({ username: 'alice', password: 'pw' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', retry_after_s: 17 });
    expect(checkSoftPerIp).not.toHaveBeenCalled();
  });

  it('returns 429 when the account-wide failure lock trips', async () => {
    vi.mocked(checkHardPerAccount).mockResolvedValue({ ok: false, retryAfterS: 123 });
    const res = await app.request('/auth/login', json({ username: 'alice', password: 'pw' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', retry_after_s: 123 });
    expect(checkHardPerUser).not.toHaveBeenCalled();
  });

  it('uses the transport peer for limiter, session, and audit identity, not X-Forwarded-For', async () => {
    const route = authLogin as AnyRoute;
    const req = new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.99',
      },
      body: JSON.stringify({ username: 'alice', password: 'pw' }),
    });
    const ctx = {
      principal: null,
      input: undefined,
      params: {},
      peerAddress: '203.0.113.10',
      log: () => {},
      signal: new AbortController().signal,
    };
    const res = await route.handler(req, ctx);
    expect(res.status).toBe(200);
    expect(checkSoftPerIp).toHaveBeenCalledWith('203.0.113.10');
    expect(checkHardPerAccount).toHaveBeenCalledWith('alice');
    expect(checkHardPerUser).toHaveBeenCalledWith('203.0.113.10', 'alice');
    expect(login).toHaveBeenCalledWith('alice', 'pw', expect.objectContaining({
      remote_addr: '203.0.113.10',
    }));
    expect(refundSoftGlobal).toHaveBeenCalledTimes(1);
    expect(resetHardPerAccount).toHaveBeenCalledWith('alice');
    expect(resetHardPerUser).toHaveBeenCalledWith('203.0.113.10', 'alice');
  });

  it('burns the account-wide hard bucket as well as the per-peer bucket on failure', async () => {
    vi.mocked(login).mockRejectedValue(Object.assign(new Error('bad'), { code: 'bad_password' }));
    const route = authLogin as AnyRoute;
    const res = await route.handler(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'wrong' }),
      }),
      {
        principal: null, input: undefined, params: {}, peerAddress: '203.0.113.10',
        log: () => {}, signal: new AbortController().signal,
      },
    );
    expect(res.status).toBe(401);
    expect(burnHardPerAccount).toHaveBeenCalledWith('alice');
    expect(burnHardPerUser).toHaveBeenCalledWith('203.0.113.10', 'alice');
  });

  it('requires password + explicit workspace remotely and mints a Secure scoped session', async () => {
    vi.mocked(isRemoteRequest).mockReturnValue(true);
    const missingWorkspace = await app.request('https://app.example.com/auth/login', json({
      username: 'alice', password: 'pw',
    }));
    expect(missingWorkspace.status).toBe(400);
    expect(await missingWorkspace.json()).toEqual({ error: 'workspace_required' });

    const missingPassword = await app.request('https://app.example.com/auth/login', {
      ...json({ username: 'alice' }),
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': 'ws-remote' },
    });
    expect(missingPassword.status).toBe(403);
    expect(await missingPassword.json()).toEqual({ error: 'password_required' });

    const ok = await app.request('https://app.example.com/auth/login', {
      ...json({ username: 'alice', password: 'pw' }),
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': 'ws-remote' },
    });
    expect(ok.status).toBe(200);
    expect(login).toHaveBeenLastCalledWith('alice', 'pw', expect.objectContaining({
      workspace_id: 'ws-remote',
      capabilities: ['*', REMOTE_OPERATOR_CAPABILITY],
      remote: true,
    }));
    expect(ok.headers.get('set-cookie') ?? '').toContain('Secure');
  });
});

describe('POST /auth/logout', () => {
  const app = appWith(authLogout as AnyRoute);

  it('clears the session cookie', async () => {
    const res = await app.request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });

  it('clears a remote session with matching Secure cookie attributes', async () => {
    const res = await app.request('https://app.example.com/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });
});

describe('POST /auth/signup', () => {
  const app = appWith(authSignup as AnyRoute);

  it('rejects missing fields with 400', async () => {
    const res = await app.request('/auth/signup', json({ username: 'bob' }));
    expect(res.status).toBe(400);
  });

  it('creates an account and auto-logs-in by default', async () => {
    const res = await app.request('/auth/signup', json({ username: 'bob', display_name: 'Bob' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain('papercusp_session=');
  });

  it('skips the cookie when auto_login is false', async () => {
    const res = await app.request('/auth/signup', json({ username: 'bob', display_name: 'Bob', auto_login: false }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('maps a duplicate-username error to 409', async () => {
    vi.mocked(signup).mockRejectedValue(new Error('duplicate key value'));
    const res = await app.request('/auth/signup', json({ username: 'alice', display_name: 'A' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'username_taken' });
  });

  // The open-signup gate (auth-tier rollout, OWNER rows): the first account
  // bootstraps unconditionally (listUsers → [] above); after that, signup
  // requires the OPEN_SIGNUP flag — the route is internet-reachable.
  it('denies signup once a user exists and OPEN_SIGNUP is off', async () => {
    vi.mocked(listUsers).mockResolvedValue([USER]);
    const res = await app.request('/auth/signup', json({ username: 'bob', display_name: 'Bob' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'signup_disabled' });
    expect(signup).not.toHaveBeenCalled();
  });

  it('allows signup past the first user when OPEN_SIGNUP is on', async () => {
    vi.mocked(listUsers).mockResolvedValue([USER]);
    vi.mocked(getFlag).mockResolvedValue(true);
    const res = await app.request('/auth/signup', json({ username: 'bob', display_name: 'Bob' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('POST /auth/change-password', () => {
  const app = appWith(authChangePassword as AnyRoute);

  it('falls back to the default user with no session (cookie-less desktop)', async () => {
    const res = await app.request('/auth/change-password', json({ current: 'a', next: 'b' }));
    expect(res.status).toBe(200);
    expect(changePassword).toHaveBeenCalledWith('u1', 'a', 'b');
  });

  it('re-issues a session cookie on success', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(USER);
    const res = await app.request('/auth/change-password', json({ current: 'a', next: 'b' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain('papercusp_session=tok_abc');
  });

  describe('EI-347: setup-token gate for a password-less account', () => {
    const NO_PW_USER = { ...USER, has_password: false };

    it('rejects with 403 when the target has no password and the setup token is missing/wrong', async () => {
      vi.mocked(getSessionUserOrDefault).mockResolvedValue(NO_PW_USER);
      vi.mocked(verifySetupToken).mockReturnValue(false);
      const res = await app.request('/auth/change-password', json({ current: null, next: 'b' }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'setup_token_required' });
      expect(changePassword).not.toHaveBeenCalled();
    });

    it('proceeds when the target has no password and the setup token is correct', async () => {
      vi.mocked(getSessionUserOrDefault).mockResolvedValue(NO_PW_USER);
      vi.mocked(verifySetupToken).mockReturnValue(true);
      const res = await app.request(
        '/auth/change-password',
        json({ current: null, next: 'b', setupToken: 'whatever-verifySetupToken-is-mocked-to-accept' }),
      );
      expect(res.status).toBe(200);
      expect(changePassword).toHaveBeenCalledWith('u1', null, 'b');
    });

    it('never requires the setup token once the account already has a password', async () => {
      // USER (has_password:true) is the beforeEach default; no setupToken in the body at all.
      vi.mocked(verifySetupToken).mockReturnValue(false);
      const res = await app.request('/auth/change-password', json({ current: 'a', next: 'b' }));
      expect(res.status).toBe(200);
      expect(changePassword).toHaveBeenCalledWith('u1', 'a', 'b');
    });
  });
});

describe('GET + PATCH /auth/me', () => {
  const app = appWith(authMe as AnyRoute[]);

  it('GET returns the session user when present', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(USER);
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { username: 'alice' }, autoLogin: false });
  });

  it('GET falls through to the default user with no session', async () => {
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ autoLogin: true });
  });

  it('GET keeps database exception values out of the degraded response and log', async () => {
    const email = 'auth-me-private@example.test';
    const sealed = 'never-emit-me';
    const error = new Error(`database failed for ${email} (${sealed})`);
    error.stack = `${error.message}\nprivate database stack`;
    vi.mocked(getSessionUserOrDefault).mockRejectedValue(error);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/auth/me');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        degraded: true,
        degradedReason: 'authentication_unavailable',
        pgUnavailable: true,
      });
      const calls = JSON.stringify(logged.mock.calls);
      expect(calls).not.toContain(email);
      expect(calls).not.toContain(sealed);
      expect(calls).not.toContain('private database stack');
      expect(calls).toContain('fingerprint');
    } finally {
      logged.mockRestore();
    }
  });

  it('GET never exposes or auto-mints the local default user remotely', async () => {
    vi.mocked(isRemoteRequest).mockReturnValue(true);
    const res = await app.request('https://app.example.com/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, autoLogin: false, available: [] });
    expect(getSessionUserOrDefault).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('GET auto-mints a session for a passwordless cookie-capable caller', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValue({ ...USER, has_password: false });
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    expect(login).toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').toContain('papercusp_session=tok_abc');
  });

  it('GET skips the auto-mint for bearer-presenting callers (EI-338: no cookie jar over the IPC bridge)', async () => {
    vi.mocked(getSessionUserOrDefault).mockResolvedValue({ ...USER, has_password: false });
    const res = await app.request('/auth/me', { headers: { authorization: 'Bearer su-token' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ autoLogin: true });
    expect(login).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('PATCH falls back to the default user when unauthenticated (cookie-less desktop)', async () => {
    const res = await app.request('/auth/me', { ...json({ display_name: 'New' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(updateDisplayName).toHaveBeenCalledWith('u1', 'New');
  });

  it('PATCH updates the display name', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(USER);
    const res = await app.request('/auth/me', { ...json({ display_name: 'Alice II' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(updateDisplayName).toHaveBeenCalledWith('u1', 'Alice II');
  });

  it('PATCH rejects an empty display name with 400', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(USER);
    const res = await app.request('/auth/me', { ...json({ display_name: '   ' }), method: 'PATCH' });
    expect(res.status).toBe(400);
  });
});

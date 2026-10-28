/**
 * Tests for requirePrincipal + the per-transport resolvers.
 *
 * Heavy mock surface — these resolvers reach into next/headers, mobile
 * JWT signing, the superuser bearer file, and the workspace registry.
 * The point of the tests is the *composition* — fall-through order,
 * requirement gating, error shapes — not re-testing each underlying
 * helper.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getSessionUser lives in lib/auth.ts (NOT a lib/auth/index.ts barrel). The cookie
// resolver imports it via '../../auth' and this test reads its handle via '../auth' —
// both resolve to lib/auth.ts. Mock THAT module (a bare '.' resolved to the
// non-existent lib/auth/index.ts, so the mock silently missed and every test threw
// `vi.mocked(...).mockResolvedValue is not a function` — EI/green-checkpoint red).
// importOriginal-spread so the heavy auth module's other exports survive.
vi.mock('../auth', async (orig) => ({
  ...(await orig<typeof import('../auth')>()),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock('../device-jwt', () => ({
  verifyDeviceToken: vi.fn(() => null),
}));
vi.mock('../superuser-token', () => ({
  isLoopbackRequest: vi.fn(() => false),
  isValidSuperuserBearer: vi.fn(() => false),
}));
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-active'),
}));
// principalFromDeviceJwt runs isRevoked (PG-backed): an unknown device reads as
// revoked → principal null. Stand the synthetic device in as known + live so the
// device principal resolves and the capability check is what's exercised.
vi.mock('../device-store', async (orig) => ({
  ...(await orig<typeof import('../device-store')>()),
  isRevoked: vi.fn(async () => false),
}));

import { PrincipalCheckError, requirePrincipal, tryResolvePrincipal, retainRequestPrincipal } from './require-principal';
import { getSessionUser } from '../auth';
import { verifyDeviceToken } from '../device-jwt';
import { isRevoked } from '../device-store';
import { isLoopbackRequest, isValidSuperuserBearer } from '../superuser-token';

beforeEach(() => {
  vi.mocked(getSessionUser).mockResolvedValue(null);
  vi.mocked(verifyDeviceToken).mockReturnValue(null);
  vi.mocked(isRevoked).mockResolvedValue(false);
  vi.mocked(isLoopbackRequest).mockReturnValue(false);
  vi.mocked(isValidSuperuserBearer).mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

const h = (init: Record<string, string> = {}) => new Headers(init);

describe('retained host request principal', () => {
  const user = (capabilities = ['tasks:read']) => ({ id: 'launch-user', username: 'launch',
    display_name: 'Launch', has_password: true, workspace_id: 'ws-active', capabilities });

  it('retains original headers privately and re-resolves the same authenticated identity', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user());
    const headers = h({ cookie: 'papercusp_session=original' });
    const resolve = await retainRequestPrincipal(headers, 'ws-active');
    headers.set('cookie', 'papercusp_session=changed');
    expect(await resolve!()).toMatchObject({ slug: 'launch-user', capabilities: new Set(['tasks:read']) });
    expect(vi.mocked(getSessionUser).mock.calls.at(-1)![0]!.get('cookie')).toBe('papercusp_session=original');
    vi.mocked(getSessionUser).mockResolvedValue({ ...user(), id: 'different-user' });
    expect(await resolve!()).toBeNull();
  });

  it('does not retain a forwarded descriptor, unverified loopback, or another workspace', async () => {
    expect(await retainRequestPrincipal(null, 'ws-active')).toBeUndefined();
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    expect(await retainRequestPrincipal(h(), 'ws-active')).toBeUndefined();
    vi.mocked(getSessionUser).mockResolvedValue(user());
    expect(await retainRequestPrincipal(h(), 'different-workspace')).toBeUndefined();
    expect(await retainRequestPrincipal(h(), '*')).toBeUndefined();
  });

  it('refuses revoked credentials and authentication fall-through to a different principal', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user());
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    const resolve = await retainRequestPrincipal(h({ authorization: 'Bearer fixture' }), 'ws-active');
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect(await resolve!()).toBeNull(); // cookie revocation cannot acquire superuser authority
    vi.mocked(isValidSuperuserBearer).mockReturnValue(false);
    expect(await resolve!()).toBeNull();
  });

  it('intersects live capability changes with the original launch ceiling', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user(['tasks:read', 'tasks:write']));
    const resolve = await retainRequestPrincipal(h(), 'ws-active');
    vi.mocked(getSessionUser).mockResolvedValue(user(['tasks:read', 'new:grant']));
    expect((await resolve!())!.capabilities).toEqual(new Set(['tasks:read']));
    vi.mocked(getSessionUser).mockResolvedValue(user(['*']));
    const snapshot = await resolve!();
    expect(snapshot!.capabilities).toEqual(new Set(['tasks:read', 'tasks:write']));
    (snapshot!.capabilities as Set<string>).add('*');
    expect((await resolve!())!.capabilities.has('*')).toBe(false);
  });
});

describe('requirePrincipal — resolver order', () => {
  it('cookie wins over mobile JWT when both are present', async () => {
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'user_1',
      username: 'alice',
      display_name: 'Alice',
      has_password: true,
      workspace_id: 'ws-cookie',
      capabilities: ['*'],
    });
    vi.mocked(verifyDeviceToken).mockReturnValue({
      sub: 'device_1',
      workspace_id: 'ws-mobile',
      device_kind: 'mobile',
      iat: 0,
      exp: 9_999_999_999,
    });
    const p = await requirePrincipal(h({ authorization: 'Bearer mobile_token' }));
    expect(p.kind).toBe('user');
    expect(p.slug).toBe('user_1');
  });

  it('mobile JWT wins over superuser bearer when no cookie', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue({
      sub: 'device_2',
      workspace_id: 'ws-mobile',
      device_kind: 'mobile',
      iat: 0,
      exp: 9_999_999_999,
    });
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    const p = await requirePrincipal(h({ authorization: 'Bearer mobile_token' }));
    expect(p.kind).toBe('device');
    expect(p.slug).toBe('device_2');
  });

  it('does not fall through to loopback when a signed device token cannot be checked for revocation', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue({
      sub: 'device_unavailable',
      workspace_id: 'ws-mobile',
      device_kind: 'mobile',
      iat: 0,
      exp: 9_999_999_999,
    });
    vi.mocked(isRevoked).mockRejectedValue(new Error('PG connection refused'));
    vi.mocked(isLoopbackRequest).mockReturnValue(true);

    await expect(requirePrincipal(h({ authorization: 'Bearer mobile_token' })))
      .rejects.toThrow('PG connection refused');
    expect(isLoopbackRequest).not.toHaveBeenCalled();
  });

  it('superuser bearer wins over loopback fallback', async () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    vi.mocked(isValidSuperuserBearer).mockReturnValue(true);
    const p = await requirePrincipal(h({ authorization: 'Bearer su_token' }));
    expect(p.kind).toBe('system');
    expect(p.trust).toBe('trusted');
  });

  it('loopback fires when nothing else matched', async () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = await requirePrincipal(h());
    expect(p.kind).toBe('loopback');
    expect(p.trust).toBe('unverified-loopback');
  });

  it('throws 401 when no resolver fires', async () => {
    await expect(requirePrincipal(h())).rejects.toThrow(PrincipalCheckError);
    await expect(requirePrincipal(h())).rejects.toMatchObject({
      status: 401,
      reason: 'no principal resolved',
    });
  });
});

describe('requirePrincipal — requirements', () => {
  beforeEach(() => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true); // loopback fallback by default
  });

  it('trust allowlist accepts matching', async () => {
    const p = await requirePrincipal(h(), { trust: ['unverified-loopback'] });
    expect(p.kind).toBe('loopback');
  });

  it('trust allowlist rejects non-matching with 403', async () => {
    await expect(requirePrincipal(h(), { trust: ['trusted'] })).rejects.toMatchObject({
      status: 403,
      reason: expect.stringMatching(/trust.*not in allowlist/),
    });
  });

  it('kind allowlist accepts matching', async () => {
    const p = await requirePrincipal(h(), { kind: ['loopback', 'system'] });
    expect(p.kind).toBe('loopback');
  });

  it('kind allowlist rejects non-matching with 403', async () => {
    await expect(requirePrincipal(h(), { kind: ['user', 'device'] })).rejects.toMatchObject({
      status: 403,
      reason: expect.stringMatching(/kind.*not in allowlist/),
    });
  });

  it("capabilities check passes when principal has '*'", async () => {
    const p = await requirePrincipal(h(), { capabilities: ['anything:write'] });
    expect(p.kind).toBe('loopback');
  });

  it('capabilities check rejects when missing required cap (no wildcard)', async () => {
    // Make a more restricted principal — device gets ['device:*', 'voice:*', 'harness:read'].
    vi.mocked(isLoopbackRequest).mockReturnValue(false);
    vi.mocked(verifyDeviceToken).mockReturnValue({
      sub: 'device_3',
      workspace_id: 'ws-mobile',
      device_kind: 'mobile',
      iat: 0,
      exp: 9_999_999_999,
    });
    await expect(
      requirePrincipal(h({ authorization: 'Bearer t' }), { capabilities: ['admin:backup'] }),
    ).rejects.toMatchObject({
      status: 403,
      reason: expect.stringMatching(/missing capability/),
    });
  });
});

describe('tryResolvePrincipal', () => {
  it('returns null on no auth', async () => {
    expect(await tryResolvePrincipal(h())).toBeNull();
  });

  it('returns the loopback principal when loopback fires', async () => {
    vi.mocked(isLoopbackRequest).mockReturnValue(true);
    const p = await tryResolvePrincipal(h());
    expect(p?.kind).toBe('loopback');
  });
});

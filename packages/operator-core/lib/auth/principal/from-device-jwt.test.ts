/**
 * Unit tests for `principalFromDeviceJwt` — the device-JWT resolver
 * INTERNALS.
 *
 * The composite `require-principal.test.ts` stands `isRevoked` in as
 * always-`false` so the device principal resolves; it never exercises the
 * revocation logic itself. This file pins the resolver body:
 *   - a revocation-store error must not resolve a verified device principal;
 *   - a genuinely revoked device → null;
 *   - a valid mobile token → a device principal with the fixed device
 *     capability set and label-from-email;
 *   - an invalid/expired token (verifyDeviceToken → null) → null, with the
 *     revocation store never consulted.
 *
 * Hermetic: `verifyDeviceToken`, `isRevoked`, `activeWorkspaceId` mocked.
 * (activeWorkspaceId isn't used by this resolver — the workspace comes from
 * the JWT claim — but it's mocked anyway to keep the module graph inert.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceClaims } from '../../device-jwt';

vi.mock('../../device-jwt', () => ({
  verifyDeviceToken: vi.fn(() => null),
}));
vi.mock('../../device-store', () => ({
  isRevoked: vi.fn(async () => false),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-active'),
}));

import { principalFromDeviceJwt } from './from-device-jwt';
import { verifyDeviceToken } from '../../device-jwt';
import { isRevoked } from '../../device-store';

const h = (init: Record<string, string> = {}) => new Headers(init);

const claims = (over: Partial<DeviceClaims> = {}): DeviceClaims => ({
  sub: 'device_1',
  workspace_id: 'ws-mobile',
  device_kind: 'mobile',
  iat: 0,
  exp: 9_999_999_999,
  ...over,
});

beforeEach(() => {
  vi.mocked(verifyDeviceToken).mockReturnValue(null);
  vi.mocked(isRevoked).mockResolvedValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('principalFromDeviceJwt — no/invalid token', () => {
  it('returns null with no Authorization header', async () => {
    expect(await principalFromDeviceJwt(h())).toBeNull();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it('treats a bare "Bearer" (no token) as the raw value — the Headers API trims the trailing space, so it never matches the "Bearer " prefix; verification runs on "Bearer" and returns null', async () => {
    // NOTE: the resolver's `if (!token) return null` empty-after-strip guard
    // is effectively unreachable through a Headers object: the web Headers
    // API normalizes "Bearer " → "Bearer" (trailing-space trim), which fails
    // the `startsWith('Bearer ')` test and is passed through verbatim as the
    // non-empty string "Bearer". So this reaches verifyDeviceToken, not the guard.
    vi.mocked(verifyDeviceToken).mockReturnValue(null);
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer ' }));
    expect(p).toBeNull();
    expect(verifyDeviceToken).toHaveBeenCalledWith('Bearer');
  });

  it('returns null for an invalid/expired token (verifyDeviceToken → null)', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(null);
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer bad' }));
    expect(p).toBeNull();
    expect(verifyDeviceToken).toHaveBeenCalledWith('bad');
    // Never reaches the revocation store on an unverifiable token.
    expect(isRevoked).not.toHaveBeenCalled();
  });

  it('strips the "Bearer " prefix before verifying', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(claims());
    await principalFromDeviceJwt(h({ authorization: 'Bearer real_jwt' }));
    expect(verifyDeviceToken).toHaveBeenCalledWith('real_jwt');
  });
});

describe('principalFromDeviceJwt — revocation', () => {
  it('returns null for a genuinely revoked device', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(claims({ sub: 'device_revoked' }));
    vi.mocked(isRevoked).mockResolvedValue(true);
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer t' }));
    expect(p).toBeNull();
    expect(isRevoked).toHaveBeenCalledWith('device_revoked');
  });

  it('does not resolve a device principal when the revocation store is unavailable', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(claims({ sub: 'device_ok' }));
    // A transient PG hiccup leaves revocation status unknown.
    vi.mocked(isRevoked).mockRejectedValue(new Error('PG connection refused'));
    await expect(principalFromDeviceJwt(h({ authorization: 'Bearer t' })))
      .rejects.toThrow('PG connection refused');
    expect(isRevoked).toHaveBeenCalledWith('device_ok');
  });

  it('checks revocation against the JWT sub claim', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(claims({ sub: 'device_42' }));
    vi.mocked(isRevoked).mockResolvedValue(false);
    await principalFromDeviceJwt(h({ authorization: 'Bearer t' }));
    expect(isRevoked).toHaveBeenCalledWith('device_42');
  });
});

describe('principalFromDeviceJwt — valid device principal', () => {
  it('mints a verified device principal with the fixed device capability set', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(
      claims({ sub: 'device_1', workspace_id: 'ws-mobile' }),
    );
    vi.mocked(isRevoked).mockResolvedValue(false);
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer t' }));
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      kind: 'device',
      slug: 'device_1',
      workspaceId: 'ws-mobile',
      authMethod: 'jwt',
      trust: 'verified',
    });
    expect(p!.capabilities).toBeInstanceOf(Set);
    expect([...p!.capabilities].sort()).toEqual(['device:*', 'harness:read', 'voice:*']);
    expect(p!.capabilities.has('*')).toBe(false);
  });

  it('takes the workspaceId from the JWT claim, not the active workspace', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(claims({ workspace_id: 'ws-from-jwt' }));
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer t' }));
    expect(p!.workspaceId).toBe('ws-from-jwt');
  });

  it('sets label from user_email when the claim carries it', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(
      claims({ user_email: 'pat@example.com' }),
    );
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer t' }));
    expect(p!.label).toBe('pat@example.com');
  });

  it('omits label entirely when user_email is absent', async () => {
    vi.mocked(verifyDeviceToken).mockReturnValue(claims({ user_email: undefined }));
    const p = await principalFromDeviceJwt(h({ authorization: 'Bearer t' }));
    expect(p).not.toBeNull();
    expect('label' in p!).toBe(false);
  });
});

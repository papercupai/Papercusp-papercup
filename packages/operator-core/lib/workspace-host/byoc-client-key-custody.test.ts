import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BYOC_CLIENT_KEY_SERVICE,
  createByocClientKey,
  rotateByocClientKey,
  restoreByocClientKey,
  revokeByocClientKey,
  withByocClientKey,
} from './byoc-client-key-custody';

const stored = new Map<string, Buffer>();
let failDelete = false;
vi.mock('../identity/keychain', () => ({
  keychainStore: vi.fn(async (id: string, value: Buffer, service: string) => {
    stored.set(`${service}:${id}`, Buffer.from(value));
  }),
  keychainLoad: vi.fn(async (id: string, service: string) => {
    const value = stored.get(`${service}:${id}`);
    return value ? { kind: 'ok', value: Buffer.from(value) } : { kind: 'error', error: { kind: 'not_found' } };
  }),
  keychainDelete: vi.fn(async (id: string, service: string) => {
    if (failDelete) throw new Error('local keychain unavailable');
    stored.delete(`${service}:${id}`);
  }),
}));

const scope = { organizationId: 'org-a', workspaceId: 'ws-a', hostId: 'host-a', clientId: 'desktop-a' };
const previousDesktop = process.env.PAPERCUSP_DESKTOP;

beforeEach(() => {
  stored.clear();
  failDelete = false;
  process.env.PAPERCUSP_DESKTOP = '1';
});
afterEach(() => {
  if (previousDesktop === undefined) delete process.env.PAPERCUSP_DESKTOP;
  else process.env.PAPERCUSP_DESKTOP = previousDesktop;
});

describe('BYOC signed-desktop client key custody', () => {
  it('creates a Noise key in a separate local keychain namespace and loads it only inside an awaited callback', async () => {
    const created = await createByocClientKey(scope);
    expect(Buffer.from(created.publicKeyBase64, 'base64')).toHaveLength(32);
    expect(Buffer.from(created.recoverySeedBase64, 'base64')).toHaveLength(32);
    expect([...stored.keys()]).toHaveLength(1);
    expect([...stored.keys()][0]).toContain(BYOC_CLIENT_KEY_SERVICE);
    let borrowed: Buffer | undefined;
    await withByocClientKey(scope, created.publicKeyBase64, async (pair) => {
      borrowed = pair.secretKey;
      expect(pair.publicKey.toString('base64')).toBe(created.publicKeyBase64);
      expect(pair.secretKey).toHaveLength(64);
    });
    expect(borrowed?.equals(Buffer.alloc(64))).toBe(true);
  });

  it('restores only the independently named public key and refuses a mismatched recovery seed', async () => {
    const first = await createByocClientKey(scope);
    const other = await createByocClientKey(scope);
    stored.clear();
    await expect(restoreByocClientKey(scope, first.publicKeyBase64, other.recoverySeedBase64))
      .rejects.toThrow(/does not match/);
    expect(stored.size).toBe(0);
    await restoreByocClientKey(scope, first.publicKeyBase64, first.recoverySeedBase64);
    await withByocClientKey(scope, first.publicKeyBase64, async (pair) => {
      expect(pair.publicKey.toString('base64')).toBe(first.publicKeyBase64);
    });
  });

  it('binds keys to organization, workspace, host, and installed client', async () => {
    const created = await createByocClientKey(scope);
    for (const changed of [
      { ...scope, organizationId: 'org-b' },
      { ...scope, workspaceId: 'ws-b' },
      { ...scope, hostId: 'host-b' },
      { ...scope, clientId: 'desktop-b' },
    ]) {
      await expect(withByocClientKey(changed, created.publicKeyBase64, async () => {}))
        .rejects.toThrow(/unavailable: not_found/);
    }
  });

  it('keeps the key when host revocation fails, then deletes only after host confirmation', async () => {
    const created = await createByocClientKey(scope);
    const failed = vi.fn(async () => { throw new Error('host unavailable'); });
    await expect(revokeByocClientKey(scope, created.publicKeyBase64, failed)).rejects.toThrow('host unavailable');
    expect(stored.size).toBe(1);
    const confirmed = vi.fn(async () => {
      expect(stored.size).toBe(1);
    });
    await revokeByocClientKey(scope, created.publicKeyBase64, confirmed);
    expect(confirmed).toHaveBeenCalledWith(created.publicKeyBase64);
    expect(stored.size).toBe(0);
  });

  it('refuses key custody outside the installed desktop sidecar', async () => {
    delete process.env.PAPERCUSP_DESKTOP;
    await expect(createByocClientKey(scope)).rejects.toThrow(/customer-installed desktop/);
    expect(stored.size).toBe(0);
  });

  it('rotates through host authorization and reports pending old-key revocation truthfully', async () => {
    const old = await createByocClientKey(scope);
    const authorize = vi.fn(async () => {});
    const failRevoke = vi.fn(async () => { throw new Error('host revocation failed'); });
    const partial = await rotateByocClientKey(scope, old.publicKeyBase64, authorize, failRevoke);
    expect(partial.status).toBe('old-key-revocation-pending');
    expect(stored.size).toBe(2);
    expect(authorize).toHaveBeenCalledWith(partial.publicKeyBase64);
    await revokeByocClientKey(scope, old.publicKeyBase64, async () => {});
    expect(stored.size).toBe(1);
    const complete = await rotateByocClientKey(scope, partial.publicKeyBase64, authorize, async () => {});
    expect(complete.status).toBe('complete');
    expect(stored.size).toBe(1);
  });

  it('distinguishes a completed host revocation from a failed local key deletion', async () => {
    const old = await createByocClientKey(scope);
    const revokeOnHost = vi.fn(async () => {
      failDelete = true;
    });
    const partial = await rotateByocClientKey(scope, old.publicKeyBase64, async () => {}, revokeOnHost);
    expect(partial.status).toBe('old-key-local-deletion-pending');
    expect(revokeOnHost).toHaveBeenCalledOnce();
    expect(revokeOnHost).toHaveBeenCalledWith(old.publicKeyBase64);
    expect(stored.size).toBe(2);
  });
});

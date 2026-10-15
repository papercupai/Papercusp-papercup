/**
 * local-announce-identity tests (Fix 1 + Fix 6).
 *
 * The CRITICAL property under test: the announce identity resolves the device
 * keypair under the CANONICAL per-user keychain id
 * `<github_user_id>:<machine-fingerprint>` (built via the same
 * `resolveDeviceKeychainId` the join/contributor-file publish path uses), NOT
 * a fixed `'papercusp-device'`. If it didn't, the announced device_pubkey
 * would be a key the published contributor file was NOT signed with, and every
 * read-admission channel-2 check on the remote peer would fail.
 *
 * All inputs are injected — no live gh auth, no live keychain.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  REQUEST_ONLY_IDENTITY_GUARD_V1,
  resolveLocalAnnounceIdentity,
  resolveLocalAnnounceIdentityFromHiveMembers,
  loadCachedLocalAnnounceIdentity,
} from './local-announce-identity';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_CORE_KEY = 'a'.repeat(64);

function stubUser(id = 4242, login = 'alice') {
  return vi.fn(async () => ({ id, login }));
}
function stubKeypair() {
  // Echoes the keychainId it was loaded with so the test can assert which id
  // the device keypair was resolved under.
  return vi.fn(async (keychainId: string) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }));
}

describe('resolveLocalAnnounceIdentity', () => {
  describe('request-only load-only mode (P-008)', () => {
    it('loads a cached, keychain-verified identity without GitHub, gist, cache, or key generation', async () => {
      const root = await mkdtemp(join(tmpdir(), 'papercusp-request-only-'));
      const cachePath = join(root, 'identity.json');
      await writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          savedAt: Date.now() - 24 * 60 * 60 * 1000,
          keychainId: '4242:m',
          devicePubkeyBase64: 'PUBKEY==',
          githubUserId: 4242,
          githubLogin: 'alice',
          attestationGistId: 'gist-cached',
        }),
        'utf8',
      );
      const resolveGithubUser = vi.fn(async () => {
        throw new Error('must not resolve GitHub in load-only mode');
      });
      const resolveAttestationGistId = vi.fn(async () => 'must-not-write');
      const loadKeypair = vi.fn(async (keychainId: string) => ({
        keychainId,
        pubkeyBase64: 'PUBKEY==',
      }));

      await expect(
        resolveLocalAnnounceIdentity({
          logCoreKeyHex: LOG_CORE_KEY,
          cachePath,
          identityMode: 'load-only',
          resolveGithubUser,
          resolveAttestationGistId,
          loadKeypair,
        }),
      ).resolves.toEqual({
        keychainId: '4242:m',
        devicePubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: 'gist-cached',
      });
      expect(resolveGithubUser).not.toHaveBeenCalled();
      expect(resolveAttestationGistId).not.toHaveBeenCalled();
      expect(loadKeypair).toHaveBeenCalledWith('4242:m');
    });

    it('fails closed on a cache miss and never falls through to key generation', async () => {
      const root = await mkdtemp(join(tmpdir(), 'papercusp-request-only-miss-'));
      const cachePath = join(root, 'identity.json');
      const resolveGithubUser = vi.fn(async () => ({ id: 1, login: 'should-not-run' }));
      const loadKeypair = vi.fn(async () => {
        throw new Error('loadExisting should not be reached for a missing cache');
      });

      await expect(
        resolveLocalAnnounceIdentity({
          logCoreKeyHex: LOG_CORE_KEY,
          cachePath,
          identityMode: 'load-only',
          resolveGithubUser,
          loadKeypair,
        }),
      ).rejects.toThrow(new RegExp(REQUEST_ONLY_IDENTITY_GUARD_V1));
      expect(resolveGithubUser).not.toHaveBeenCalled();
      expect(loadKeypair).not.toHaveBeenCalled();
    });

    it('derives load-only mode from the request-only environment marker', async () => {
      const prior = process.env.PAPERCUSP_IDENTITY_MODE;
      const root = await mkdtemp(join(tmpdir(), 'papercusp-request-only-env-'));
      const cachePath = join(root, 'identity.json');
      await writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          keychainId: 'env:m',
          devicePubkeyBase64: 'ENVPUB==',
          githubUserId: 7,
          githubLogin: 'env-user',
          attestationGistId: 'gist-cached',
        }),
        'utf8',
      );
      process.env.PAPERCUSP_IDENTITY_MODE = 'load-only';
      try {
        await expect(
          resolveLocalAnnounceIdentity({
            logCoreKeyHex: LOG_CORE_KEY,
            cachePath,
            resolveGithubUser: vi.fn(async () => ({ id: 7, login: 'wrong-path' })),
            loadKeypair: vi.fn(async (keychainId: string) => ({
              keychainId,
              pubkeyBase64: 'ENVPUB==',
            })),
          }),
        ).resolves.toMatchObject({ keychainId: 'env:m', githubLogin: 'env-user' });
      } finally {
        if (prior === undefined) delete process.env.PAPERCUSP_IDENTITY_MODE;
        else process.env.PAPERCUSP_IDENTITY_MODE = prior;
      }
    });
  });

  it('loads the keypair under the canonical per-user keychain id (Fix 1)', async () => {
    const resolveGithubUser = stubUser(4242, 'alice');
    const loadKeypair = stubKeypair();
    // Deterministic keychain-id builder so we can assert the exact id.
    const buildKeychainId = vi.fn((uid: number) => `${uid}:test-machine`);

    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser,
      loadKeypair,
      buildKeychainId,
      resolveAttestationGistId: async () => 'g',
    });

    // The keychain id is keyed by the resolved gh user id — NOT a fixed string.
    expect(buildKeychainId).toHaveBeenCalledWith(4242);
    expect(identity.keychainId).toBe('4242:test-machine');
    // The keypair was loaded under that SAME id.
    expect(loadKeypair).toHaveBeenCalledWith('4242:test-machine');
    expect(identity.keychainId).not.toBe('papercusp-device');

    expect(identity.devicePubkeyBase64).toBe('PUBKEY==');
    expect(identity.githubUserId).toBe(4242);
    expect(identity.githubLogin).toBe('alice');
  });

  it('uses the REAL resolveDeviceKeychainId by default (matches the publish path)', async () => {
    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser: stubUser(777, 'bob'),
      loadKeypair: stubKeypair(),
      resolveAttestationGistId: async () => 'g',
      // no buildKeychainId override → the canonical resolver is used
    });
    // Same id the join path would build for this user on this machine.
    expect(identity.keychainId).toBe(resolveDeviceKeychainId(777));
    expect(identity.keychainId.startsWith('777:')).toBe(true);
  });

  it('resolves the gh user BEFORE building the keychain id (id is user-keyed)', async () => {
    const order: string[] = [];
    const resolveGithubUser = vi.fn(async () => {
      order.push('user');
      return { id: 11, login: 'carol' };
    });
    const buildKeychainId = vi.fn((uid: number) => {
      order.push('build');
      return `${uid}:m`;
    });
    const loadKeypair = vi.fn(async (keychainId: string) => {
      order.push('load');
      return { keychainId, pubkeyBase64: 'P' };
    });

    await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser,
      buildKeychainId,
      loadKeypair,
      resolveAttestationGistId: async () => 'g',
    });

    // user must resolve before the id is built + the keypair is loaded.
    expect(order.indexOf('user')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('load'));
  });

  it('an explicit keychainId override wins (tests / multi-identity dev)', async () => {
    const buildKeychainId = vi.fn(() => 'should-not-be-used');
    const loadKeypair = stubKeypair();
    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      keychainId: 'explicit-id',
      resolveGithubUser: stubUser(),
      loadKeypair,
      buildKeychainId,
      resolveAttestationGistId: async () => 'g',
    });
    expect(identity.keychainId).toBe('explicit-id');
    expect(buildKeychainId).not.toHaveBeenCalled();
    expect(loadKeypair).toHaveBeenCalledWith('explicit-id');
  });

  it('resolves the attestation gist id via the injected resolver (write-free join)', async () => {
    const resolveAttestationGistId = vi.fn(async () => 'gist-xyz-789');
    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      resolveGithubUser: stubUser(4242, 'alice'),
      loadKeypair: stubKeypair(),
      buildKeychainId: (uid: number) => `${uid}:m`,
      resolveAttestationGistId,
    });
    // The resolver is called with this peer's resolved identity inputs.
    expect(resolveAttestationGistId).toHaveBeenCalledWith(
      expect.objectContaining({
        keychainId: '4242:m',
        pubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
      }),
    );
    // The gist id rides the announce identity (carried on the signed announce).
    expect(identity.attestationGistId).toBe('gist-xyz-789');
  });

  it('throws when logCoreKeyHex is missing', async () => {
    await expect(
      resolveLocalAnnounceIdentity({
        logCoreKeyHex: '',
        resolveGithubUser: stubUser(),
        loadKeypair: stubKeypair(),
      }),
    ).rejects.toThrow(/logCoreKeyHex required/);
  });

  it('propagates a gh-resolution failure (caller stays local-only)', async () => {
    await expect(
      resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        resolveGithubUser: vi.fn(async () => {
          throw new Error('gh not authenticated');
        }),
        loadKeypair: stubKeypair(),
      }),
    ).rejects.toThrow(/gh not authenticated/);
  });

  it('falls back to the last-good cached identity when GitHub user resolution is transiently unavailable', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');

    await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser: stubUser(4242, 'alice'),
      buildKeychainId: (uid: number) => `${uid}:m`,
      loadKeypair: stubKeypair(),
      resolveAttestationGistId: async () => 'gist-cached',
    });

    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser: vi.fn(async () => {
        throw new Error('GitHub timeout');
      }),
      loadKeypair: vi.fn(async (keychainId: string) => ({
        keychainId,
        pubkeyBase64: 'PUBKEY==',
      })),
    });

    expect(identity).toMatchObject({
      keychainId: '4242:m',
      devicePubkeyBase64: 'PUBKEY==',
      githubUserId: 4242,
      githubLogin: 'alice',
      attestationGistId: 'gist-cached',
    });
  });

  it('reuses a fresh keychain-verified identity without repeating GitHub resolution', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
    const resolveGithubUser = stubUser(4242, 'alice');
    const resolveAttestationGistId = vi.fn(async () => 'gist-cached');
    const loadKeypair = stubKeypair();

    const first = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser,
      buildKeychainId: (uid: number) => `${uid}:m`,
      loadKeypair,
      resolveAttestationGistId,
    });
    const second = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser,
      buildKeychainId: (uid: number) => `${uid}:m`,
      loadKeypair,
      resolveAttestationGistId,
    });

    expect(second).toEqual(first);
    expect(resolveGithubUser).toHaveBeenCalledTimes(1);
    expect(resolveAttestationGistId).toHaveBeenCalledTimes(1);
    // The second call still proves that the cached identity names this device.
    expect(loadKeypair).toHaveBeenCalledTimes(2);
  });

  it('refreshes a stale cache entry instead of treating it as a success-path identity', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        savedAt: Date.now() - 60_001,
        keychainId: '4242:m',
        devicePubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: 'gist-stale',
      }),
      'utf8',
    );
    const resolveGithubUser = stubUser(4242, 'alice');
    const resolveAttestationGistId = vi.fn(async () => 'gist-refreshed');

    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser,
      buildKeychainId: (uid: number) => `${uid}:m`,
      loadKeypair: stubKeypair(),
      resolveAttestationGistId,
    });

    expect(resolveGithubUser).toHaveBeenCalledTimes(1);
    expect(resolveAttestationGistId).toHaveBeenCalledTimes(1);
    expect(identity.attestationGistId).toBe('gist-refreshed');
  });

  // WI-10006733: without the hint, every authoring resolve past the 60s fresh
  // window walked every gist on the account (~104 pages, ~2 min on papercupai).
  it('hands the stale cache gist to the resolver as a hint for the SAME device (WI-10006733)', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        savedAt: Date.now() - 60 * 60_000,
        keychainId: '4242:m',
        devicePubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: 'gist-known',
      }),
      'utf8',
    );
    const resolveAttestationGistId = vi.fn(async () => 'gist-known');

    const identity = await resolveLocalAnnounceIdentity({
      logCoreKeyHex: LOG_CORE_KEY,
      cachePath,
      resolveGithubUser: stubUser(4242, 'alice'),
      buildKeychainId: (uid: number) => `${uid}:m`,
      loadKeypair: stubKeypair(),
      resolveAttestationGistId,
    });

    expect(resolveAttestationGistId).toHaveBeenCalledTimes(1);
    expect(resolveAttestationGistId).toHaveBeenCalledWith(
      expect.objectContaining({ keychainId: '4242:m', knownGistId: 'gist-known' }),
    );
    expect(identity.attestationGistId).toBe('gist-known');
  });

  it('never hints a cached gist that belongs to a different device or user (WI-10006733)', async () => {
    for (const mismatch of [
      { keychainId: '4242:other-machine' },
      { devicePubkeyBase64: 'OTHERKEY==' },
      { githubUserId: 9999 },
    ]) {
      const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
      await writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          savedAt: Date.now() - 60 * 60_000,
          keychainId: '4242:m',
          devicePubkeyBase64: 'PUBKEY==',
          githubUserId: 4242,
          githubLogin: 'alice',
          attestationGistId: 'gist-not-mine',
          ...mismatch,
        }),
        'utf8',
      );
      const resolveAttestationGistId = vi.fn(async (_args: unknown) => 'gist-fresh');

      await resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        cachePath,
        resolveGithubUser: stubUser(4242, 'alice'),
        buildKeychainId: (uid: number) => `${uid}:m`,
        loadKeypair: stubKeypair(),
        resolveAttestationGistId,
      });

      const args = resolveAttestationGistId.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(args).toBeDefined();
      expect(args).not.toHaveProperty('knownGistId');
    }
  });

  it('rejects a cached identity when the keychain pubkey no longer matches the cached pubkey', async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        keychainId: '4242:m',
        devicePubkeyBase64: 'OLDPUB==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: 'gist-cached',
      }),
      'utf8',
    );

    await expect(
      resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        cachePath,
        resolveGithubUser: vi.fn(async () => {
          throw new Error('GitHub timeout');
        }),
        loadKeypair: vi.fn(async (keychainId: string) => ({
          keychainId,
          pubkeyBase64: 'NEWPUB==',
        })),
      }),
    ).rejects.toThrow(/GitHub timeout/);
  });

  // WI-38355 — a CHANNEL-2 (attestation gist) failure degrades to an empty gist
  // id instead of throwing. The rethrow used to land in
  // wireHiveDirectoryForWorkspace's catch and abandon the ENTIRE directory
  // boot-join, so a gist-less owner published no descriptor at all.
  describe('channel-2 degrade (WI-38355)', () => {
    const gist422 = () =>
      vi.fn(async () => {
        throw new Error('422 Gist/user: user must have a verified email');
      });

    it('degrades to an empty attestationGistId instead of throwing when the gist cannot be resolved', async () => {
      const identity = await resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        resolveGithubUser: stubUser(4242, 'alice'),
        buildKeychainId: (uid: number) => `${uid}:m`,
        loadKeypair: stubKeypair(),
        resolveAttestationGistId: gist422(),
        onAttestationUnavailable: () => {},
      });

      // Channel-1 is intact and complete — only the channel-2 anchor is empty.
      expect(identity).toEqual({
        keychainId: '4242:m',
        devicePubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: '',
      });
    });

    it('reports the degrade with the underlying cause rather than degrading silently', async () => {
      const onAttestationUnavailable = vi.fn();

      await resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        resolveGithubUser: stubUser(4242, 'alice'),
        buildKeychainId: (uid: number) => `${uid}:m`,
        loadKeypair: stubKeypair(),
        resolveAttestationGistId: gist422(),
        onAttestationUnavailable,
      });

      expect(onAttestationUnavailable).toHaveBeenCalledTimes(1);
      const [{ keychainId, cause }] = onAttestationUnavailable.mock.calls[0];
      expect(keychainId).toBe('4242:m');
      expect((cause as Error).message).toMatch(/verified email/);
    });

    it('still PREFERS a cached identity carrying a real gist over degrading', async () => {
      const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');

      await resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        cachePath,
        resolveGithubUser: stubUser(4242, 'alice'),
        buildKeychainId: (uid: number) => `${uid}:m`,
        loadKeypair: stubKeypair(),
        resolveAttestationGistId: async () => 'gist-real',
      });

      const identity = await resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        cachePath,
        resolveGithubUser: stubUser(4242, 'alice'),
        buildKeychainId: (uid: number) => `${uid}:m`,
        loadKeypair: stubKeypair(),
        resolveAttestationGistId: gist422(),
        onAttestationUnavailable: () => {},
      });

      expect(identity.attestationGistId).toBe('gist-real');
    });

    it('does NOT persist the degraded identity — the cache keeps meaning "fully resolved"', async () => {
      const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');

      await resolveLocalAnnounceIdentity({
        logCoreKeyHex: LOG_CORE_KEY,
        cachePath,
        resolveGithubUser: stubUser(4242, 'alice'),
        buildKeychainId: (uid: number) => `${uid}:m`,
        loadKeypair: stubKeypair(),
        resolveAttestationGistId: gist422(),
        onAttestationUnavailable: () => {},
      });

      // Nothing was written, so the offline path (the resolveUser catch, which
      // does no match check) can never hand back an unattested identity for a
      // device that may well have a real gist.
      expect(await loadCachedLocalAnnounceIdentity(cachePath)).toBeNull();
    });

    it('keeps CHANNEL-1 failures fatal — the degrade is scoped to the gist alone', async () => {
      await expect(
        resolveLocalAnnounceIdentity({
          logCoreKeyHex: LOG_CORE_KEY,
          resolveGithubUser: vi.fn(async () => {
            throw new Error('gh not authenticated');
          }),
          loadKeypair: stubKeypair(),
          resolveAttestationGistId: async () => 'g',
        }),
      ).rejects.toThrow(/gh not authenticated/);

      await expect(
        resolveLocalAnnounceIdentity({
          logCoreKeyHex: LOG_CORE_KEY,
          resolveGithubUser: stubUser(4242, 'alice'),
          loadKeypair: vi.fn(async () => {
            throw new Error('keychain locked');
          }),
          resolveAttestationGistId: async () => 'g',
        }),
      ).rejects.toThrow(/keychain locked/);
    });
  });
});

describe('loadCachedLocalAnnounceIdentity (F1-6/P-014 signer reuse seam)', () => {
  const writeCache = async (over: Record<string, unknown> = {}): Promise<string> => {
    const cachePath = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'identity.json');
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        keychainId: '4242:m',
        devicePubkeyBase64: 'PUBKEY==',
        githubUserId: 4242,
        githubLogin: 'alice',
        attestationGistId: 'gist-cached',
        ...over,
      }),
      'utf8',
    );
    return cachePath;
  };

  it('returns the cached identity when the keychain pubkey still matches (the signer seam)', async () => {
    const cachePath = await writeCache();
    const identity = await loadCachedLocalAnnounceIdentity(cachePath, async (keychainId) => ({
      keychainId,
      pubkeyBase64: 'PUBKEY==',
    }));
    // The SAME device the announce signs with — so a receiver's resolveAuthorDevice(ourLog)
    // matches the pubkey we'll stamp on the outcome record (anti-lift parity).
    expect(identity).toMatchObject({ keychainId: '4242:m', devicePubkeyBase64: 'PUBKEY==' });
  });

  it('returns null when the keychain no longer holds a matching key (rotated key)', async () => {
    const cachePath = await writeCache();
    expect(
      await loadCachedLocalAnnounceIdentity(cachePath, async (keychainId) => ({
        keychainId,
        pubkeyBase64: 'ROTATED==',
      })),
    ).toBeNull();
  });

  it('returns null when the keychain load fails (no key present)', async () => {
    const cachePath = await writeCache();
    expect(await loadCachedLocalAnnounceIdentity(cachePath, async () => null)).toBeNull();
  });

  it('returns null on a cold box with no cache file', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'papercusp-announce-')), 'absent.json');
    expect(
      await loadCachedLocalAnnounceIdentity(missing, async (keychainId) => ({ keychainId, pubkeyBase64: 'X' })),
    ).toBeNull();
  });
});

describe('resolveLocalAnnounceIdentityFromHiveMembers', () => {
  it('resolves a local announce identity from an existing matching hive_members device', async () => {
    const identity = await resolveLocalAnnounceIdentityFromHiveMembers({
      members: [
        {
          githubUserId: 4242,
          githubUsername: 'alice',
          deviceAttestations: [
            { device_pubkey: 'OTHER==', gist_id: 'other-gist' },
            { device_pubkey: 'PUBKEY==', gist_id: 'gist-local' },
          ],
        },
      ],
      buildKeychainId: (uid) => `${uid}:m`,
      loadExistingKeypair: async (keychainId) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }),
    });

    expect(identity).toEqual({
      keychainId: '4242:m',
      devicePubkeyBase64: 'PUBKEY==',
      githubUserId: 4242,
      githubLogin: 'alice',
      attestationGistId: 'gist-local',
    });
  });

  it('does not resolve when the matching device pubkey is revoked', async () => {
    const identity = await resolveLocalAnnounceIdentityFromHiveMembers({
      members: [
        {
          githubUserId: 4242,
          githubUsername: 'alice',
          revokedPubkeys: ['PUBKEY=='],
          deviceAttestations: [{ device_pubkey: 'PUBKEY==', gist_id: 'gist-local' }],
        },
      ],
      buildKeychainId: (uid) => `${uid}:m`,
      loadExistingKeypair: async (keychainId) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }),
    });

    expect(identity).toBeNull();
  });

  it('does not generate or accept a nonmatching local keypair', async () => {
    const identity = await resolveLocalAnnounceIdentityFromHiveMembers({
      members: [
        {
          githubUserId: 4242,
          githubUsername: 'alice',
          deviceAttestations: [{ device_pubkey: 'PUBKEY==', gist_id: 'gist-local' }],
        },
      ],
      buildKeychainId: (uid) => `${uid}:m`,
      loadExistingKeypair: async (keychainId) => ({ keychainId, pubkeyBase64: 'DIFFERENT==' }),
    });

    expect(identity).toBeNull();
  });

  // WI-10003109: the owner's own row can carry an empty gist (written at pot creation,
  // before the gist existed). Announcing '' makes every gist-gated joiner reject the owner.
  const emptyGistMember = {
    githubUserId: 4242,
    githubUsername: 'alice',
    deviceAttestations: [{ device_pubkey: 'PUBKEY==', gist_id: '' }],
  };
  const cachedIdentity = {
    keychainId: '4242:m',
    devicePubkeyBase64: 'PUBKEY==',
    githubUserId: 4242,
    githubLogin: 'alice',
    attestationGistId: 'gist-cached',
  };

  it('fills an empty row gist from the cached identity of the same device and user', async () => {
    const identity = await resolveLocalAnnounceIdentityFromHiveMembers({
      members: [emptyGistMember],
      buildKeychainId: (uid) => `${uid}:m`,
      loadExistingKeypair: async (keychainId) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }),
      loadCachedIdentity: async () => cachedIdentity,
    });

    expect(identity?.attestationGistId).toBe('gist-cached');
  });

  it('keeps the empty gist when the cached identity names another device or user', async () => {
    for (const cached of [
      { ...cachedIdentity, devicePubkeyBase64: 'OTHER==' },
      { ...cachedIdentity, githubUserId: 9999 },
    ]) {
      const identity = await resolveLocalAnnounceIdentityFromHiveMembers({
        members: [emptyGistMember],
        buildKeychainId: (uid) => `${uid}:m`,
        loadExistingKeypair: async (keychainId) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }),
        loadCachedIdentity: async () => cached,
      });

      expect(identity?.attestationGistId).toBe('');
    }
  });

  it('prefers the row gist over the cache and does not read the cache for it', async () => {
    let cacheReads = 0;
    const identity = await resolveLocalAnnounceIdentityFromHiveMembers({
      members: [{ ...emptyGistMember, deviceAttestations: [{ device_pubkey: 'PUBKEY==', gist_id: 'gist-row' }] }],
      buildKeychainId: (uid) => `${uid}:m`,
      loadExistingKeypair: async (keychainId) => ({ keychainId, pubkeyBase64: 'PUBKEY==' }),
      loadCachedIdentity: async () => {
        cacheReads++;
        return cachedIdentity;
      },
    });

    expect(identity?.attestationGistId).toBe('gist-row');
    expect(cacheReads).toBe(0);
  });
});

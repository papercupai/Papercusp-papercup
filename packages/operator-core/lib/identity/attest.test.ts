import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign as nodeSign, createPublicKey } from 'node:crypto';
import {
  ATTESTATION_VERIFY_NEGATIVE_CACHE_TTL_MS,
  attestationGistFilename,
} from './attestation-types';

// Deterministic gh-token seam: verifyAttestation now resolves the local gh
// token for its gist fetch (WI-1544 quota guard) — never shell out to the
// real `gh` from tests.
const ghToken = vi.hoisted(() => ({
  result: { kind: 'ok', token: 'tok-test' } as
    | { kind: 'ok'; token: string }
    | { kind: 'error'; error: { kind: string } },
  clearCalls: 0,
}));
vi.mock('./gh-token', () => ({
  getGhAuthToken: async () => ghToken.result,
  clearGhAuthTokenCache: () => {
    ghToken.clearCalls += 1;
  },
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTestKeychainId(suffix: string) {
  return 'test-' + process.pid + '-' + suffix;
}

/** Build an SPKI DER from raw 32-byte Ed25519 pubkey (mirrors attest.ts). */
function buildSpkiDer(raw: Buffer): Buffer {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, raw]);
}

/** Extract raw 32-byte pubkey from SPKI DER. */
function extractRawPubkey(spkiDer: Buffer): Buffer {
  return spkiDer.subarray(-32);
}

function signCanonical(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  return nodeSign(null, buf, privateKey).toString('base64');
}

// ─── keychain tests ───────────────────────────────────────────────────────────

describe('keychain (encrypted-file fallback)', () => {
  // Override IDENTITY_DIR by pointing homedir to a tmp path via env trick
  // is complex; instead test the exported functions directly after
  // pointing them at a known tmp dir via a factory approach.
  //
  // These tests exercise the fileStore / fileLoad path end-to-end by
  // using a unique keychainId per test so entries don't collide.

  const kcIds: string[] = [];

  afterEach(async () => {
    // Clean up any stored entries
    const { keychainDelete } = await import('./keychain');
    for (const id of kcIds) {
      await keychainDelete(id).catch(() => {});
    }
    kcIds.length = 0;
  });

  it('stores and loads a private key round-trip', async () => {
    const { keychainStore, keychainLoad } = await import('./keychain');
    const id = makeTestKeychainId('store-load');
    kcIds.push(id);

    const { privateKey } = generateKeyPairSync('ed25519');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

    await keychainStore(id, privDer);
    const result = await keychainLoad(id);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.equals(privDer)).toBe(true);
    }
  });

  it('returns not_found when no entry exists', async () => {
    const { keychainLoad } = await import('./keychain');
    const id = makeTestKeychainId('not-found-' + Math.random().toString(36).slice(2));
    const result = await keychainLoad(id);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.kind).toBe('not_found');
    }
  });

  it('overwrites on second store', async () => {
    const { keychainStore, keychainLoad } = await import('./keychain');
    const id = makeTestKeychainId('overwrite');
    kcIds.push(id);

    const kp1 = generateKeyPairSync('ed25519');
    const kp2 = generateKeyPairSync('ed25519');
    const der1 = kp1.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    const der2 = kp2.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

    await keychainStore(id, der1);
    await keychainStore(id, der2);
    const result = await keychainLoad(id);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.equals(der2)).toBe(true);
    }
  });

  it('delete removes the entry', async () => {
    const { keychainStore, keychainLoad, keychainDelete } = await import('./keychain');
    const id = makeTestKeychainId('delete');

    const { privateKey } = generateKeyPairSync('ed25519');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

    await keychainStore(id, privDer);
    await keychainDelete(id);
    const result = await keychainLoad(id);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.kind).toBe('not_found');
    }
  });
});

// ─── keypair lifecycle ────────────────────────────────────────────────────────

describe('loadOrGenerateDeviceKeypair', () => {
  const kcIds: string[] = [];

  afterEach(async () => {
    const { keychainDelete } = await import('./keychain');
    for (const id of kcIds) {
      await keychainDelete(id).catch(() => {});
    }
    kcIds.length = 0;
  });

  it('generates a keypair on first call', async () => {
    const { loadOrGenerateDeviceKeypair } = await import('./attest');
    const id = makeTestKeychainId('gen-first');
    kcIds.push(id);

    const result = await loadOrGenerateDeviceKeypair(id);
    expect(result.keychainId).toBe(id);
    expect(typeof result.pubkeyBase64).toBe('string');
    // Base64 of 32 bytes = 44 chars
    expect(result.pubkeyBase64.length).toBe(44);
  });

  it('is idempotent — same pubkey on second call', async () => {
    const { loadOrGenerateDeviceKeypair } = await import('./attest');
    const id = makeTestKeychainId('idempotent');
    kcIds.push(id);

    const first = await loadOrGenerateDeviceKeypair(id);
    const second = await loadOrGenerateDeviceKeypair(id);
    expect(second.pubkeyBase64).toBe(first.pubkeyBase64);
  });

  it('different keychainIds produce different pubkeys', async () => {
    const { loadOrGenerateDeviceKeypair } = await import('./attest');
    const id1 = makeTestKeychainId('diff-1');
    const id2 = makeTestKeychainId('diff-2');
    kcIds.push(id1, id2);

    const r1 = await loadOrGenerateDeviceKeypair(id1);
    const r2 = await loadOrGenerateDeviceKeypair(id2);
    expect(r1.pubkeyBase64).not.toBe(r2.pubkeyBase64);
  });
});

// WI-2018: generate ONLY on not_found. An io_error means a key may EXIST but this
// process context can't read it (locked OS keychain in a service context, permission
// fault) — minting a fresh keypair there FORKS the device identity (presence stamps
// one pubkey, another tier resolves a different one; the new key is never attested).
describe('loadOrGenerateDeviceKeypair — WI-2018 unreadable-keychain guard', () => {
  afterEach(() => {
    vi.doUnmock('./keychain');
    vi.resetModules();
  });

  async function attestWithKeychainError(errorKind: string, reason?: string) {
    vi.resetModules();
    const store = vi.fn(async () => {});
    vi.doMock('./keychain', () => ({
      keychainLoad: async () => ({ kind: 'error', error: { kind: errorKind, reason } }),
      keychainStore: store,
    }));
    const attest = await import('./attest');
    return { attest, store };
  }

  it('io_error ⇒ THROWS (refuses to mint a fresh identity; nothing stored)', async () => {
    const { attest, store } = await attestWithKeychainError('io_error', 'EACCES: keychain locked');
    await expect(attest.loadOrGenerateDeviceKeypair('id-io')).rejects.toThrow(
      /split-device-identity/,
    );
    expect(store).not.toHaveBeenCalled();
  });

  it('decryption_failed ⇒ THROWS with derivation context (refuses to overwrite either mirror)', async () => {
    const { attest, store } = await attestWithKeychainError('decryption_failed', 'auth tag mismatch');
    await expect(attest.loadOrGenerateDeviceKeypair('id-dec')).rejects.toThrow(
      /decryption_failed: auth tag mismatch.*refusing to mint/s,
    );
    expect(store).not.toHaveBeenCalled();
  });

  it('not_found ⇒ generates + stores (first run, unchanged)', async () => {
    const { attest, store } = await attestWithKeychainError('not_found');
    const r = await attest.loadOrGenerateDeviceKeypair('id-nf');
    expect(r.pubkeyBase64.length).toBe(44);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent first-run callers through generate + store', async () => {
    vi.resetModules();
    const load = vi.fn(async () => ({
      kind: 'error' as const,
      error: { kind: 'not_found' as const },
    }));
    const store = vi.fn(async () => {});
    vi.doMock('./keychain', () => ({
      keychainLoad: load,
      keychainStore: store,
    }));
    const { loadOrGenerateDeviceKeypair } = await import('./attest');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadOrGenerateDeviceKeypair('id-concurrent-first-run')),
    );

    expect(new Set(results.map((result) => result.pubkeyBase64)).size).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('single-flights across duplicate module instances in the same process', async () => {
    vi.resetModules();
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const load = vi.fn(async () => {
      await loadGate;
      return { kind: 'error' as const, error: { kind: 'not_found' as const } };
    });
    const store = vi.fn(async () => {});
    vi.doMock('./keychain', () => ({
      keychainLoad: load,
      keychainStore: store,
    }));

    const firstModule = await import('./attest');
    const first = firstModule.loadOrGenerateDeviceKeypair('id-duplicate-module');
    vi.resetModules();
    const secondModule = await import('./attest');
    const second = secondModule.loadOrGenerateDeviceKeypair('id-duplicate-module');
    releaseLoad();

    const results = await Promise.all([first, second]);
    expect(new Set(results.map((result) => result.pubkeyBase64)).size).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('clears a failed single-flight so a later call can retry', async () => {
    vi.resetModules();
    const load = vi.fn(async () => ({
      kind: 'error' as const,
      error: { kind: 'not_found' as const },
    }));
    const store = vi.fn(async () => {});
    store.mockRejectedValueOnce(new Error('transient store failure'));
    vi.doMock('./keychain', () => ({
      keychainLoad: load,
      keychainStore: store,
    }));
    const { loadOrGenerateDeviceKeypair } = await import('./attest');

    await expect(loadOrGenerateDeviceKeypair('id-retry-after-store-failure')).rejects.toThrow(
      'transient store failure',
    );
    const recovered = await loadOrGenerateDeviceKeypair('id-retry-after-store-failure');

    expect(recovered.pubkeyBase64).toHaveLength(44);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledTimes(2);
  });
});

// ─── verifyAttestation ────────────────────────────────────────────────────────

describe('verifyAttestation', () => {
  beforeEach(async () => {
    const { clearAttestationCache } = await import('./attest');
    clearAttestationCache();
  });

  function makeFakeGistResponse(overrides?: Partial<{
    ownerId: number;
    body: Partial<{
      version: number;
      device_pubkey: string;
      device_label: string;
      github_user_id: number;
      github_login: string;
      created_at: number;
      signature_by_device: string;
    }>;
    status: number;
  }>) {
    const kp = generateKeyPairSync('ed25519');
    const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const rawPub = extractRawPubkey(spkiDer);
    const pubkeyBase64 = rawPub.toString('base64');

    const payload = {
      version: 1,
      device_pubkey: pubkeyBase64,
      device_label: 'test-device',
      github_user_id: 12345,
      github_login: 'testuser',
      created_at: Date.now(),
    };
    const signature_by_device = signCanonical(payload, kp.privateKey);

    const body = {
      ...payload,
      signature_by_device,
      ...overrides?.body,
    };

    return {
      kp,
      pubkeyBase64,
      body,
      gistResponse: {
        id: 'test-gist-id',
        owner: { id: overrides?.ownerId ?? payload.github_user_id },
        files: {
          // Derive the filename the same way the source does — it sanitizes
          // base64 (+→-, /→_), so a raw slice diverges for ~⅓ of random keys
          // (the old hardcoded form made these tests flaky).
          [attestationGistFilename(pubkeyBase64)]: {
            content: JSON.stringify(body, null, 2),
          },
        },
      },
      status: overrides?.status ?? 200,
    };
  }

  it('returns valid=true for a correctly-signed gist', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => gistResponse,
      }),
    );

    const result = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(result.valid).toBe(true);
    expect(result.resolvedGithubUserId).toBe(12345);
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: returns an existing verified gist id without creating', async () => {
    const { ensureAttestationGist } = await import('./attest');
    const { pubkeyBase64, body } = makeFakeGistResponse();
    // Key the gist files under the REAL deterministic filename so both the
    // find-by-filename match and the verifyAttestation lookup hit.
    const filename = attestationGistFilename(pubkeyBase64);
    const validGist = {
      id: 'g-existing',
      owner: { id: 12345 },
      files: { [filename]: { content: JSON.stringify(body, null, 2) } },
    };

    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      void init;
      if (typeof url === 'string' && url.includes('/gists?')) {
        // The "list my gists" call → one gist carrying the attestation filename.
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'g-existing', files: { [filename]: {} } }],
        };
      }
      // The verifyAttestation gist-by-id fetch.
      return { ok: true, status: 200, json: async () => validGist };
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureAttestationGist({
      keychainId: 'unused-on-find-path',
      pubkeyBase64,
      deviceLabel: 'test',
      githubUserId: 12345,
      githubLogin: 'testuser',
      token: 'tok',
    });

    expect(id).toBe('g-existing');
    const candidateFetch = fetchMock.mock.calls.find(
      ([url]) => url === 'https://api.github.com/gists/g-existing',
    );
    expect(candidateFetch).toBeTruthy();
    expect(
      (candidateFetch?.[1] as { headers?: Record<string, string> } | undefined)?.headers
        ?.Authorization,
    ).toBe('token tok');
    // It must NOT POST a new gist when an existing verified one is found.
    const posted = fetchMock.mock.calls.some(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posted).toBe(false);
    vi.unstubAllGlobals();
  });

  // WI-10006733: the account this box publishes under carries ~10k binding
  // gists, so the listing is ~104 pages (~2 min). A device that already knows
  // its gist must verify it directly instead of walking every page.
  it('ensureAttestationGist: a verified knownGistId hint returns without listing or creating (WI-10006733)', async () => {
    const { ensureAttestationGist } = await import('./attest');
    const { pubkeyBase64, body } = makeFakeGistResponse();
    const filename = attestationGistFilename(pubkeyBase64);
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      void init;
      if (url === 'https://api.github.com/gists/g-hint-6733') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'g-hint-6733',
            owner: { id: 12345 },
            files: { [filename]: { content: JSON.stringify(body, null, 2) } },
          }),
        };
      }
      throw new Error('unexpected fetch ' + String(url));
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureAttestationGist({
      keychainId: 'k',
      pubkeyBase64,
      deviceLabel: 'test',
      githubUserId: 12345,
      githubLogin: 'testuser',
      token: 'tok',
      knownGistId: 'g-hint-6733',
    });

    expect(id).toBe('g-hint-6733');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/gists?'))).toBe(false);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'POST'),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: a hint that does not verify falls back to the listing (WI-10006733)', async () => {
    const { ensureAttestationGist } = await import('./attest');
    const { pubkeyBase64, body } = makeFakeGistResponse();
    const filename = attestationGistFilename(pubkeyBase64);
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      void init;
      if (url === 'https://api.github.com/gists/g-gone-6733') {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (typeof url === 'string' && url.includes('/gists?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'g-listed-6733', files: { [filename]: {} } }],
        };
      }
      if (url === 'https://api.github.com/gists/g-listed-6733') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'g-listed-6733',
            owner: { id: 12345 },
            files: { [filename]: { content: JSON.stringify(body, null, 2) } },
          }),
        };
      }
      throw new Error('unexpected fetch ' + String(url));
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureAttestationGist({
      keychainId: 'k',
      pubkeyBase64,
      deviceLabel: 'test',
      githubUserId: 12345,
      githubLogin: 'testuser',
      token: 'tok',
      knownGistId: 'g-gone-6733',
    });

    expect(id).toBe('g-listed-6733');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/gists?'))).toBe(true);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === 'POST'),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: follows pagination to find an aged binding without creating', async () => {
    const { ensureAttestationGist } = await import('./attest');
    const { pubkeyBase64, body } = makeFakeGistResponse();
    const filename = attestationGistFilename(pubkeyBase64);
    const nextPage = 'https://api.github.com/gists?per_page=100&page=2';
    const validGist = {
      id: 'g-aged',
      owner: { id: 12345 },
      files: { [filename]: { content: JSON.stringify(body, null, 2) } },
    };

    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      void init;
      if (url === 'https://api.github.com/gists?per_page=100') {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'link' ? `<${nextPage}>; rel="next"` : null,
          },
          json: async () => [],
        };
      }
      if (url === nextPage) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => [{ id: 'g-aged', files: { [filename]: {} } }],
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => validGist };
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureAttestationGist({
      keychainId: 'unused-on-paginated-find-path',
      pubkeyBase64,
      deviceLabel: 'test',
      githubUserId: 12345,
      githubLogin: 'testuser',
      token: 'tok',
    });

    expect(id).toBe('g-aged');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/gists?per_page=100',
      nextPage,
      'https://api.github.com/gists/g-aged',
    ]);
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
      ),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: refuses to create when gist listing is rate-limited', async () => {
    const { ensureAttestationGist, clearAttestationQuotaGuards } = await import('./attest');
    clearAttestationQuotaGuards();
    const { pubkeyBase64 } = makeFakeGistResponse();
    const resetSec = Math.ceil(Date.now() / 1000) + 120;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: {
        get: (name: string) =>
          name === 'x-ratelimit-remaining'
            ? '0'
            : name === 'x-ratelimit-reset'
              ? String(resetSec)
              : null,
      },
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureAttestationGist({
        keychainId: 'unused-on-list-failure',
        pubkeyBase64,
        deviceLabel: 'test',
        githubUserId: 12345,
        githubLogin: 'testuser',
        token: 'tok',
      }),
    ).rejects.toThrow(/gist listing refused \(HTTP 403\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
      ),
    ).toBe(false);

    clearAttestationQuotaGuards();
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: refuses to create when candidate verification is inconclusive', async () => {
    const { ensureAttestationGist, clearAttestationQuotaGuards } = await import('./attest');
    clearAttestationQuotaGuards();
    const { pubkeyBase64 } = makeFakeGistResponse();
    const filename = attestationGistFilename(pubkeyBase64);
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      void init;
      if (typeof url === 'string' && url.includes('/gists?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'g-inconclusive', files: { [filename]: {} } }],
        };
      }
      return {
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureAttestationGist({
        keychainId: 'unused-on-inconclusive-verify',
        pubkeyBase64,
        deviceLabel: 'test',
        githubUserId: 12345,
        githubLogin: 'testuser',
        token: 'tok',
      }),
    ).rejects.toThrow(/could not verify candidate binding g-inconclusive/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
      ),
    ).toBe(false);

    clearAttestationQuotaGuards();
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: refuses to create beside a conclusive-invalid candidate and surfaces its reason', async () => {
    const { ensureAttestationGist, clearAttestationQuotaGuards } = await import('./attest');
    clearAttestationQuotaGuards();
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse({
      body: { signature_by_device: 'not-a-valid-signature' },
    });
    const filename = attestationGistFilename(pubkeyBase64);
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      if (method === 'POST') {
        throw new Error('POST must not be reached for an invalid existing candidate');
      }
      if (typeof url === 'string' && url.includes('/gists?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'g-invalid', files: { [filename]: {} } }],
        };
      }
      return { ok: true, status: 200, json: async () => gistResponse };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureAttestationGist({
        keychainId: 'unused-on-invalid-verify',
        pubkeyBase64,
        deviceLabel: 'test',
        githubUserId: 12345,
        githubLogin: 'testuser',
        token: 'tok',
      }),
    ).rejects.toThrow(/could not verify candidate binding g-invalid \(signature_invalid\)/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
      ),
    ).toBe(false);

    clearAttestationQuotaGuards();
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: refuses to list while the GitHub cooldown is active', async () => {
    const { ensureAttestationGist, verifyAttestation, clearAttestationQuotaGuards } =
      await import('./attest');
    clearAttestationQuotaGuards();
    const resetSec = Math.ceil(Date.now() / 1000) + 120;
    const rateLimited = {
      ok: false,
      status: 403,
      headers: {
        get: (name: string) =>
          name === 'x-ratelimit-remaining'
            ? '0'
            : name === 'x-ratelimit-reset'
              ? String(resetSec)
              : null,
      },
      json: async () => ({}),
    };
    const armFetch = vi.fn().mockResolvedValue(rateLimited);
    vi.stubGlobal('fetch', armFetch);
    const first = await verifyAttestation('g-cooldown', 'pk', 12345);
    expect(first.valid === false && first.reason).toBe('github_api_unavailable');

    const { pubkeyBase64 } = makeFakeGistResponse();
    const listFetch = vi.fn();
    vi.stubGlobal('fetch', listFetch);
    await expect(
      ensureAttestationGist({
        keychainId: 'unused-on-cooldown',
        pubkeyBase64,
        deviceLabel: 'test',
        githubUserId: 12345,
        githubLogin: 'testuser',
        token: 'tok',
      }),
    ).rejects.toThrow(/rate-limit cooldown active/);
    expect(listFetch).not.toHaveBeenCalled();

    clearAttestationQuotaGuards();
    vi.unstubAllGlobals();
  });

  it('returns gist_not_found on 404', async () => {
    const { verifyAttestation } = await import('./attest');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );

    const result = await verifyAttestation('missing-gist', 'YWJj', 9999);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('gist_not_found');
    vi.unstubAllGlobals();
  });

  it('returns github_api_unavailable on network error', async () => {
    const { verifyAttestation } = await import('./attest');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await verifyAttestation('any-gist', 'YWJj', 9999);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('github_api_unavailable');
    vi.unstubAllGlobals();
  });

  it('returns github_user_id_mismatch when gist owner differs from body', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse({ ownerId: 99999 });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => gistResponse,
      }),
    );

    const result = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('github_user_id_mismatch');
    vi.unstubAllGlobals();
  });

  it('returns signature_invalid on tampered payload', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse, body } = makeFakeGistResponse();

    // Tamper: change device_label after signing
    const tampered = { ...gistResponse };
    const filename = attestationGistFilename(pubkeyBase64);
    tampered.files = {
      [filename]: {
        content: JSON.stringify({ ...body, device_label: 'TAMPERED' }, null, 2),
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => tampered,
      }),
    );

    const result = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_invalid');
    vi.unstubAllGlobals();
  });

  it('returns pubkey_mismatch when claimed pubkey differs from gist body', async () => {
    // pubkey_mismatch fires when:
    //   - the filename in the gist matches the claimed pubkey (so the file IS found)
    //   - but the body's device_pubkey contains a DIFFERENT pubkey
    // This catches a type-confusion where a caller presents the wrong pubkey for a
    // gist that physically exists under that pubkey's derived filename.
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64: realPubkey, body: realBody } = makeFakeGistResponse();

    // Build a second keypair; its pubkey will be what we "claim"
    const claimedKp = generateKeyPairSync('ed25519');
    const claimedSpki = claimedKp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const claimedPubkeyBase64 = extractRawPubkey(claimedSpki).toString('base64');

    // The gist's filename is derived from the CLAIMED pubkey, but the body has the REAL pubkey
    const filename = attestationGistFilename(claimedPubkeyBase64);
    const confusedResponse = {
      id: 'test-gist-id',
      owner: { id: realBody.github_user_id },
      files: {
        [filename]: { content: JSON.stringify({ ...realBody, device_pubkey: realPubkey }, null, 2) },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => confusedResponse,
      }),
    );

    const result = await verifyAttestation('test-gist-id', claimedPubkeyBase64, 12345);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('pubkey_mismatch');
    vi.unstubAllGlobals();
  });

  it('caches successful verifications — fetch called once for two calls', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    await verifyAttestation('test-gist-id', pubkeyBase64, 12345);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('skipCache forces re-fetch', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    await verifyAttestation('test-gist-id', pubkeyBase64, 12345, { skipCache: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('caches conclusive failed verifications for the negative TTL', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('bad-gist', 'YWJj', 9999);
    await verifyAttestation('bad-gist', 'YWJj', 9999);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('re-fetches a conclusive failure after the negative TTL expires', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now');
    dateNow.mockReturnValue(now);

    await verifyAttestation('expiring-bad-gist', 'YWJj', 9999);
    dateNow.mockReturnValue(now + ATTESTATION_VERIFY_NEGATIVE_CACHE_TTL_MS + 1);
    await verifyAttestation('expiring-bad-gist', 'YWJj', 9999);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    dateNow.mockRestore();
    vi.unstubAllGlobals();
  });

  it('does not cache inconclusive github_api_unavailable results', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('unavailable-gist', 'YWJj', 9999);
    await verifyAttestation('unavailable-gist', 'YWJj', 9999);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  // ─── regression: cross-identity impersonation via cache key (R-1 fix) ─────────
  //
  // Before the fix the cache key was `gistId + ':' + pubkeyBase64`, omitting
  // the claimedGithubUserId.  This allowed an attacker to:
  //   1. Self-verify as idX  → `G:P` cached valid:true
  //   2. Re-call with VICTIM_id → cache hit returned valid:true → id check bypassed
  //
  // After the fix the key is `gistId + ':' + pubkeyBase64 + ':' + userId`, so
  // step 2 is a cache miss and must go to runVerification, which correctly checks
  // the gist owner against the new claimedGithubUserId and returns
  // `github_user_id_mismatch`.

  it('cache hit for idX must NOT be returned for a different idY (cross-identity isolation)', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    // Build a gist owned by ID_X (12345).  makeFakeGistResponse already
    // creates a gist with github_user_id: 12345 and ownerId: 12345.
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    // First call: verify legitimately as ID_X (12345) → cache populated, valid:true
    const first = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(first.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call: same gistId + pubkey but different claimedGithubUserId (the victim)
    // Must NOT return the cached result — must re-verify against the network,
    // and since the gist is owned by 12345, it must fail with github_user_id_mismatch.
    const second = await verifyAttestation('test-gist-id', pubkeyBase64, 99999);
    expect(mockFetch).toHaveBeenCalledTimes(2); // cache miss → second fetch
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('github_user_id_mismatch');

    vi.unstubAllGlobals();
  });

  it('evictAttestationCache removes all user-id variants for a gist+pubkey pair', async () => {
    const { verifyAttestation, clearAttestationCache, evictAttestationCache } = await import('./attest');
    clearAttestationCache();

    // Two separate users each verify the same gist (different gists in practice,
    // but the eviction contract is about clearing all ids for a given pair).
    // We use two gists owned by different users so each verify call succeeds.
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    // Prime the cache with the real id
    await verifyAttestation('evict-gist', pubkeyBase64, 12345);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Same id again → cache hit, no extra fetch
    await verifyAttestation('evict-gist', pubkeyBase64, 12345);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Evict — prefix scan should remove the 12345 entry
    evictAttestationCache('evict-gist', pubkeyBase64);

    // Now the same call is a cache miss → fetch again
    await verifyAttestation('evict-gist', pubkeyBase64, 12345);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });
});

// ─── GitHub quota guards (WI-1544 owner-admission stall) ─────────────────────

describe('verifyAttestation — GitHub quota guards', () => {
  let makeGist: () => { pubkeyBase64: string; gistResponse: unknown };

  beforeEach(async () => {
    const { clearAttestationCache, clearAttestationQuotaGuards } = await import('./attest');
    clearAttestationCache();
    clearAttestationQuotaGuards();
    ghToken.result = { kind: 'ok', token: 'tok-test' };
    ghToken.clearCalls = 0;

    // Local valid-gist factory (mirrors makeFakeGistResponse; that helper is
    // scoped to the verifyAttestation describe above).
    makeGist = () => {
      const kp = generateKeyPairSync('ed25519');
      const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      const pubkeyBase64 = extractRawPubkey(spkiDer).toString('base64');
      const payload = {
        version: 1,
        device_pubkey: pubkeyBase64,
        device_label: 'test-device',
        github_user_id: 12345,
        github_login: 'testuser',
        created_at: Date.now(),
      };
      const signature_by_device = signCanonical(payload, kp.privateKey);
      return {
        pubkeyBase64,
        gistResponse: {
          id: 'g-quota',
          owner: { id: 12345 },
          files: {
            [attestationGistFilename(pubkeyBase64)]: {
              content: JSON.stringify({ ...payload, signature_by_device }, null, 2),
            },
          },
        },
      };
    };
  });
  afterEach(async () => {
    const { clearAttestationQuotaGuards } = await import('./attest');
    clearAttestationQuotaGuards();
    vi.unstubAllGlobals();
  });

  it('attaches the local gh token to the gist fetch (quota, not authority)', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeGist();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await verifyAttestation('g-quota', pubkeyBase64, 12345);
    expect(result.valid).toBe(true);
    const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('token tok-test');
  });

  it('falls back to unauthenticated when no gh token resolves', async () => {
    ghToken.result = { kind: 'error', error: { kind: 'gh_cli_missing' } };
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeGist();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await verifyAttestation('g-quota', pubkeyBase64, 12345);
    expect(result.valid).toBe(true);
    const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('a 401 with a token drops the cached token and retries unauthenticated in the same call', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeGist();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => gistResponse,
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await verifyAttestation('g-quota', pubkeyBase64, 12345);
    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(ghToken.clearCalls).toBe(1);
    const retryHeaders = (mockFetch.mock.calls[1][1] as { headers: Record<string, string> })
      .headers;
    expect(retryHeaders.Authorization).toBeUndefined();
  });

  it('rate-limit 403 arms a cooldown until x-ratelimit-reset — later verifies skip the fetch', async () => {
    const { verifyAttestation } = await import('./attest');
    const resetSec = Math.ceil(Date.now() / 1000) + 120;
    const rateLimited = {
      ok: false,
      status: 403,
      headers: {
        get: (n: string) =>
          n === 'x-ratelimit-remaining' ? '0' : n === 'x-ratelimit-reset' ? String(resetSec) : null,
      },
      json: async () => ({}),
    };
    const mockFetch = vi.fn().mockResolvedValue(rateLimited);
    vi.stubGlobal('fetch', mockFetch);

    const first = await verifyAttestation('g-quota', 'pk', 12345);
    expect(first.valid).toBe(false);
    expect(first.valid === false && first.reason).toBe('github_api_unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Cooldown armed: the next verify (any gist) short-circuits without a fetch.
    const second = await verifyAttestation('g-other', 'pk2', 999);
    expect(second.valid === false && second.reason).toBe('github_api_unavailable');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clearing the guard restores fetching.
    const { clearAttestationQuotaGuards } = await import('./attest');
    clearAttestationQuotaGuards();
    await verifyAttestation('g-quota', 'pk', 12345);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('a non-rate-limit 403 (no rate-limit headers) does NOT arm the cooldown', async () => {
    const { verifyAttestation } = await import('./attest');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    const first = await verifyAttestation('g-quota', 'pk', 12345);
    expect(first.valid === false && first.reason).toBe('github_api_unavailable');
    const second = await verifyAttestation('g-quota', 'pk', 12345);
    expect(second.valid === false && second.reason).toBe('github_api_unavailable');
    // No cooldown → both calls really fetched.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── write-capability preflight ───────────────────────────────────────────────
// The defect these pin: GitHub's unverified-email block is WRITE-ONLY, so every
// read path keeps returning 200 while POST /gists 422s. A preflight that infers
// write health from a successful read/reuse reports "ready" on an account that
// cannot attest at all — which is how a fresh-home federation gate burned ~50min
// of red content legs instead of failing in seconds at identity.
describe('probeGistWriteCapability', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Verbatim GitHub response body, captured live from the blocked account.
  // Note the wording: the gist surface says "verified email", while the push
  // surface says "verify your email address" — a matcher pinned to one form
  // misses the other, so both are pinned here.
  const REAL_422_BODY = JSON.stringify({
    message: 'Validation Failed',
    errors: [
      { resource: 'Gist', code: 'custom', field: 'user', message: 'user must have a verified email' },
    ],
    documentation_url: 'https://docs.github.com/v3/gists/#create-a-gist',
    status: '422',
  });

  it('classifies the unverified-email 422 and carries the remediation', async () => {
    const { probeGistWriteCapability } = await import('./attest');
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => REAL_422_BODY,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const cap = await probeGistWriteCapability('tok');
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('unreachable');
    expect(cap.code).toBe('email_unverified');
    expect(cap.status).toBe(422);
    expect(cap.remediation).toBe('https://github.com/settings/emails');
    // Fails in ONE round-trip — no cleanup call, nothing was created.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('also classifies the push-surface wording ("verify your email address")', async () => {
    const { probeGistWriteCapability } = await import('./attest');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => 'You must verify your email address.',
        json: async () => ({}),
      })),
    );

    const cap = await probeGistWriteCapability('tok');
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('unreachable');
    expect(cap.code).toBe('email_unverified');
  });

  it('does NOT claim email_unverified for an unrelated 422', async () => {
    const { probeGistWriteCapability } = await import('./attest');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: 'Validation Failed: files is too large' }),
        json: async () => ({}),
      })),
    );

    const cap = await probeGistWriteCapability('tok');
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('unreachable');
    expect(cap.code).toBe('unavailable');
    expect(cap.remediation).toBeNull();
  });

  it('proves the write path and cleans up the probe gist', async () => {
    const { probeGistWriteCapability } = await import('./attest');
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      calls.push({ url: String(url), method });
      if (method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'g-probe' }),
          text: async () => '',
        };
      }
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const cap = await probeGistWriteCapability('tok');
    expect(cap.ok).toBe(true);
    if (!cap.ok) throw new Error('unreachable');
    expect(cap.probedGistId).toBe('g-probe');
    expect(cap.cleanedUp).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(calls[1].url).toContain('/gists/g-probe');
  });

  it('bounds a stalled GitHub write probe and returns unavailable', async () => {
    const priorTimeout = process.env.PAPERCUSP_GITHUB_TIMEOUT_MS;
    process.env.PAPERCUSP_GITHUB_TIMEOUT_MS = '5';
    const fetchMock = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal | null }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('expected the canonical GitHub timeout signal'));
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { probeGistWriteCapability } = await import('./attest');
      const cap = await probeGistWriteCapability('tok');
      expect(cap.ok).toBe(false);
      if (cap.ok) throw new Error('unreachable');
      expect(cap).toMatchObject({ code: 'unavailable', status: null });
      expect(cap.detail).toContain('timed out after 5ms');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (priorTimeout === undefined) delete process.env.PAPERCUSP_GITHUB_TIMEOUT_MS;
      else process.env.PAPERCUSP_GITHUB_TIMEOUT_MS = priorTimeout;
    }
  });

  it('bounds stalled probe cleanup without discarding the successful write proof', async () => {
    const priorTimeout = process.env.PAPERCUSP_GITHUB_TIMEOUT_MS;
    process.env.PAPERCUSP_GITHUB_TIMEOUT_MS = '5';
    const fetchMock = vi.fn(async (_url: unknown, init?: { method?: string; signal?: AbortSignal | null }) => {
      if (init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'g-probe-timeout-cleanup' }),
          text: async () => '',
        };
      }
      return await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('expected the canonical GitHub timeout signal'));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { probeGistWriteCapability } = await import('./attest');
      const cap = await probeGistWriteCapability('tok');
      expect(cap).toEqual({ ok: true, probedGistId: 'g-probe-timeout-cleanup', cleanedUp: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (priorTimeout === undefined) delete process.env.PAPERCUSP_GITHUB_TIMEOUT_MS;
      else process.env.PAPERCUSP_GITHUB_TIMEOUT_MS = priorTimeout;
    }
  });

  it('CONTROL: a read-only probe cannot detect a blocked account — which is why this exists', async () => {
    // ensureAttestationGist on the SAME write-blocked account: the list path
    // returns an already-valid gist, so it succeeds and never reaches the POST
    // that would have 422'd. This is the exact false "ready" the preflight used
    // to report; it is asserted here so a future refactor cannot make the write
    // probe look redundant and delete it.
    const { ensureAttestationGist, probeGistWriteCapability } = await import('./attest');
    // Local fixture: `makeFakeGistResponse` is scoped to the verifyAttestation
    // describe, so build the signed body here from the module-level helpers.
    const kp = generateKeyPairSync('ed25519');
    const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const pubkeyBase64 = extractRawPubkey(spkiDer).toString('base64');
    const payload = {
      version: 1,
      device_pubkey: pubkeyBase64,
      device_label: 'test-device',
      github_user_id: 12345,
      github_login: 'testuser',
      created_at: Date.now(),
    };
    const body = { ...payload, signature_by_device: signCanonical(payload, kp.privateKey) };
    const filename = attestationGistFilename(pubkeyBase64);

    let postAttempted = false;
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      if (method === 'POST') {
        postAttempted = true;
        return {
          ok: false,
          status: 422,
          text: async () => 'user must have a verified email',
          json: async () => ({}),
        };
      }
      if (typeof url === 'string' && url.includes('/gists?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'g-existing', files: { [filename]: {} } }],
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'g-existing',
          owner: { id: 12345 },
          files: { [filename]: { content: JSON.stringify(body, null, 2) } },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    // The read path reports success on an account that cannot write.
    const id = await ensureAttestationGist({
      keychainId: 'unused-on-find-path',
      pubkeyBase64,
      deviceLabel: 'test',
      githubUserId: 12345,
      githubLogin: 'testuser',
      token: 'tok',
    });
    expect(id).toBe('g-existing');
    expect(postAttempted).toBe(false);

    // The write probe, on the very same account, catches it.
    const cap = await probeGistWriteCapability('tok');
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('unreachable');
    expect(cap.code).toBe('email_unverified');
    expect(postAttempted).toBe(true);
  });
});

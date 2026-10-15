/**
 * Controls for shipped-seed-verify-cache (WI-10007537).
 *
 * The cache lets the shipped-seed hash check skip a ~3.9 GB re-read, so the property
 * that matters is the one that can go wrong silently: a CHANGED payload must never
 * produce a cache hit. Every case here builds a small fixture in a tmpdir; the shared
 * tree and the real seed are never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLD_HASH_MIN_BUDGET_MS,
  coldHashBudgetMs,
  openSeedVerifyCache,
  payloadStatFingerprint,
  resolveSeedVerifyCachePath,
  SEED_VERIFY_CACHE_MAX_ENTRIES,
  seedVerifyCacheKey,
  verifierIdentity,
} from './shipped-seed-verify-cache';

let root: string;
let payload: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'seed-verify-cache-test-'));
  payload = join(root, 'payload');
  mkdirSync(join(payload, 'db'), { recursive: true });
  writeFileSync(join(payload, 'db', '000001.sst'), 'aaaaaaaaaa');
  writeFileSync(join(payload, 'db', 'LOG'), 'info');
  writeFileSync(join(payload, 'meta.json'), '{"v":1}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const key = (over: Partial<Parameters<typeof seedVerifyCacheKey>[0]> = {}) =>
  seedVerifyCacheKey({
    storeKind: 'corestore',
    manifestSha256: 'm'.repeat(64),
    verifierIdentity: 'v1',
    payloadDir: payload,
    ...over,
  });

describe('payloadStatFingerprint / seedVerifyCacheKey — a changed payload never keeps its key', () => {
  it('calibration: an untouched payload keys identically on every call', () => {
    expect(payloadStatFingerprint(payload)).toBe(payloadStatFingerprint(payload));
    expect(key()).toBe(key());
  });

  it('a SAME-SIZE content edit with the mtime restored still changes the key (ctime moves)', async () => {
    const f = join(payload, 'db', '000001.sst');
    // A whole-second mtime, so the restore below is EXACT (utimes through a JS number
    // cannot reproduce arbitrary nanoseconds); ctime is then the only field that moves.
    const T = 1_700_000_000;
    utimesSync(f, T, T);
    // CONTROL: the naive key a cache would reach for first (path, size, mtime, inode).
    // It must stay EQUAL across this edit, or the scenario is not the one that defeats it.
    const naive = () => {
      const s = statSync(f, { bigint: true });
      return [s.size, s.mtimeNs, s.ino].join('/');
    };
    const naiveBefore = naive();
    const before = key();
    const ctimeBefore = statSync(f, { bigint: true }).ctimeNs;
    // Step past one coarse kernel timestamp tick, so the edit cannot share the fixture's
    // ctime. A real seed is hours old, so production never sits inside a tick.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(f, 'bbbbbbbbbb'); // same 10 bytes
    utimesSync(f, T, T); // a `cp -p`-style mtime restore
    const after = statSync(f, { bigint: true });
    expect(after.size).toBe(10n);
    expect(after.mtimeNs).toBe(BigInt(T) * 1_000_000_000n);
    expect(after.ctimeNs).not.toBe(ctimeBefore);
    expect(naive(), 'control: a naive size/mtime/inode key cannot see this edit').toBe(naiveBefore);
    expect(key()).not.toBe(before);
  });

  it('an added, removed or renamed file changes the key', () => {
    const k0 = key();
    writeFileSync(join(payload, 'db', '000002.sst'), 'x');
    const k1 = key();
    expect(k1).not.toBe(k0);
    rmSync(join(payload, 'db', '000002.sst'));
    renameSync(join(payload, 'meta.json'), join(payload, 'meta2.json'));
    const k2 = key();
    expect(k2).not.toBe(k0);
    expect(k2).not.toBe(k1);
  });

  it('a re-copied payload with identical bytes and mtimes still misses (new inodes)', () => {
    const k0 = key();
    const copy = join(root, 'copy');
    mkdirSync(join(copy, 'db'), { recursive: true });
    for (const rel of ['db/000001.sst', 'db/LOG', 'meta.json']) {
      const src = join(payload, rel);
      writeFileSync(join(copy, rel), readFileSync(src));
      const s = statSync(src);
      utimesSync(join(copy, rel), s.atime, s.mtime);
    }
    rmSync(payload, { recursive: true, force: true });
    renameSync(copy, payload);
    expect(key()).not.toBe(k0);
  });

  it('the RocksDB info LOG is fingerprinted too (over-inclusion only ever causes a miss)', () => {
    const k0 = key();
    writeFileSync(join(payload, 'db', 'LOG'), 'info rewritten on store open');
    expect(key()).not.toBe(k0);
  });

  it('manifest bytes, verifier identity and store kind are each part of the key', () => {
    const k0 = key();
    expect(key({ manifestSha256: 'n'.repeat(64) })).not.toBe(k0);
    expect(key({ verifierIdentity: 'v2' })).not.toBe(k0);
    expect(key({ storeKind: 'git' })).not.toBe(k0);
  });
});

describe('openSeedVerifyCache', () => {
  it('records a key durably and reads it back from a fresh handle', () => {
    const path = join(root, 'cache', 'verify.json');
    const k = key();
    expect(openSeedVerifyCache(path).has(k)).toBe(false);
    openSeedVerifyCache(path).record(k);
    expect(openSeedVerifyCache(path).has(k)).toBe(true);
    expect(openSeedVerifyCache(path).has(key({ verifierIdentity: 'other' }))).toBe(false);
    // atomic tmp+rename leaves no temp file behind
    expect(readdirSync(join(root, 'cache'))).toEqual(['verify.json']);
  });

  it('a disabled cache (null path) never hits and never writes', () => {
    const c = openSeedVerifyCache(null);
    c.record('k');
    expect(c.has('k')).toBe(false);
    expect(c.path).toBeNull();
  });

  it('a corrupt or foreign-schema cache file reads as empty (miss), never throws', () => {
    const path = join(root, 'verify.json');
    writeFileSync(path, '{ not json');
    expect(openSeedVerifyCache(path).has('k')).toBe(false);
    writeFileSync(path, JSON.stringify({ schema: 999, verified: { k: '2026-01-01T00:00:00Z' } }));
    expect(openSeedVerifyCache(path).has('k')).toBe(false);
    openSeedVerifyCache(path).record('k2');
    expect(openSeedVerifyCache(path).has('k2')).toBe(true);
  });

  it(`keeps at most ${SEED_VERIFY_CACHE_MAX_ENTRIES} keys`, () => {
    const path = join(root, 'verify.json');
    const c = openSeedVerifyCache(path);
    for (let i = 0; i < SEED_VERIFY_CACHE_MAX_ENTRIES + 5; i++) c.record(`k${i}`);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { verified: Record<string, string> };
    expect(Object.keys(stored.verified).length).toBe(SEED_VERIFY_CACHE_MAX_ENTRIES);
  });
});

describe('verifierIdentity — a behavioural fingerprint of the provider hashing', () => {
  // A stand-in provider whose verify() really hashes the canary dir, shaped like the real
  // providers (mismatch reason names the computed digest prefix).
  const hashingProvider = (salt: string) => ({
    async verify(entry: { hash: string }, p: { path: string }) {
      const h = createHash('sha256').update(salt);
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else h.update(e.name).update(readFileSync(full));
        }
      };
      walk(p.path);
      const got = h.digest('hex');
      return got === entry.hash ? { ok: true } : { ok: false, reason: `hash mismatch (got ${got.slice(0, 12)}…)` };
    },
  });

  it('calibration: the same provider yields the same identity, and the canary is cleaned up', async () => {
    const canaryRoot = join(root, 'canaries');
    mkdirSync(canaryRoot);
    const a = await verifierIdentity(hashingProvider('s'), { hash: 'x' }, canaryRoot);
    const b = await verifierIdentity(hashingProvider('s'), { hash: 'x' }, canaryRoot);
    expect(a).toBe(b);
    expect(readdirSync(canaryRoot)).toEqual([]);
  });

  it('a provider that hashes differently yields a different identity', async () => {
    const a = await verifierIdentity(hashingProvider('s'), { hash: 'x' });
    const b = await verifierIdentity(hashingProvider('t'), { hash: 'x' });
    expect(b).not.toBe(a);
  });

  it('the canary always expects the all-zero hash, whatever the real entry declares', async () => {
    let seen = '';
    await verifierIdentity(
      {
        async verify(e: { hash: string }) {
          seen = e.hash;
          return { ok: false };
        },
      },
      { hash: 'real-entry-hash' },
    );
    expect(seen).toBe('0'.repeat(64));
  });
});

describe('coldHashBudgetMs / resolveSeedVerifyCachePath', () => {
  it('derives the cold deadline from bytes, never below the old fixed budget', () => {
    expect(coldHashBudgetMs(0)).toBe(COLD_HASH_MIN_BUDGET_MS);
    // the shipped seed's 3.94 GB at the 10 MB/s floor
    expect(coldHashBudgetMs(3_939_418_443)).toBe(393_942);
  });

  it('defaults under node_modules/.cache, honours a path override, and can be disabled', () => {
    expect(resolveSeedVerifyCachePath({}, '/repo')).toBe('/repo/node_modules/.cache/papercusp/shipped-seed-verify.json');
    expect(resolveSeedVerifyCachePath({ PAPERCUSP_SEED_VERIFY_CACHE: '/x/c.json' }, '/repo')).toBe('/x/c.json');
    for (const off of ['off', 'OFF', '0', 'false']) {
      expect(resolveSeedVerifyCachePath({ PAPERCUSP_SEED_VERIFY_CACHE: off }, '/repo')).toBeNull();
    }
    expect(existsSync('/repo')).toBe(false); // resolving never creates anything
  });
});

/**
 * shipped-seed-verify-cache — a verified-verdict cache for the shipped-seed hash check
 * (WI-10007537).
 *
 * WHY. `shipped-seed-artifact.test.ts` asserts that every bundled seed payload hashes to
 * its manifest entry through boot's REAL `provider.verify()`. That reads every byte of a
 * ~3.9 GB artifact, and its wall time is a function of HOST MEMORY PRESSURE, not of the
 * code under test.
 *
 * MEASURED 2026-10-08 on the dev box (a probe mirroring `hashDir`, corestore payload,
 * 3.697 GB, 48 files). Two consecutive readFile passes took 122.7 s and 160.2 s wall, and a
 * pass streaming through one reused 1 MB buffer took 135.3 s. sha256 itself took ~2.4 s of
 * each; SYSTEM CPU took 111-153 s (93-97% of wall), so it is not IO-wait and not the
 * whole-file buffers. Each pass re-read all 3.7 GB from storage: the page cache retained
 * nothing between passes. Host-wide in the same window: pgscan_direct 1.13M pages/10 s,
 * allocstall_movable 7.8k/10 s, pgscan_kswapd 0. A 5 s `perf record` of the real test
 * worker during its corestore hash attributed it: 37.6% queued-spinlock slowpath, ~33%
 * DIRECT COMPACTION (isolate_migratepages, get_pfnblock_bit, __nr_to_section,
 * pageblock_skip_persistent), 5.1% sha256, 1.5% the actual copy. Page-cache allocation on
 * this fragmented host (compact_fail ~90% of compact_stall) is what costs the time. The
 * same test passed in 16 s (2026-09-13) and 47 s (isolated, 2026-10-08), and timed out at
 * 120 s in a full hyperbee run. A fixed deadline over that is flaky by construction, and
 * raising it alone would just move the cliff.
 *
 * WHAT THIS DOES. After a SUCCESSFUL real verify, it records a key; a later run whose key
 * matches skips the re-hash. The key binds everything the verdict depended on:
 *
 *   - the manifest bytes (entry.hash, sizeBytes, every other manifest field);
 *   - the verifier's identity: the canary verdict from `verifierIdentity` (a behavioural
 *     fingerprint of the provider's hashing) plus the `verify()` method's own source;
 *   - the payload's kernel-maintained stat identity, per directory entry
 *     (`payloadStatFingerprint`): path, mode, size, mtime, ctime, inode and device.
 *     ctime cannot be set from userspace and moves on every content write, chmod,
 *     utimes or rename, so a same-size edit with a restored mtime still misses. A
 *     re-copied artifact gets new inodes and misses too.
 *
 * Over-inclusion is always safe: an extra input can only cause a miss, which runs the
 * real verify. The fingerprint therefore walks EVERY entry, including RocksDB's info
 * LOG that `hashDir` excludes; a store open that rewrites LOG simply costs one real
 * verify. Only `ok: true` verdicts are recorded, so a failure is re-measured every run.
 *
 * NOT covered (out of scope, stated rather than implied): a change that bypasses the
 * filesystem (raw block-device writes, media bit rot) leaves ctime untouched. This test
 * guards what the seed CUTTER shipped, not the disk's integrity.
 *
 * `PAPERCUSP_SEED_VERIFY_CACHE=off` forces the full re-hash; any other non-empty value
 * is the cache file path.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export const SEED_VERIFY_CACHE_SCHEMA = 1;
/** Bound on recorded keys, so the file cannot grow without limit across seed re-cuts. */
export const SEED_VERIFY_CACHE_MAX_ENTRIES = 32;
export const SEED_VERIFY_CACHE_ENV = 'PAPERCUSP_SEED_VERIFY_CACHE';

/**
 * The cold-path floor throughput for a REAL re-hash, used to derive its deadline from
 * the bytes it must read. The worst pass measured above ran at 23 MB/s, so 10 MB/s
 * leaves 2.3x headroom under the same host pressure.
 */
export const COLD_HASH_FLOOR_BYTES_PER_SEC = 10_000_000;
export const COLD_HASH_MIN_BUDGET_MS = 120_000;

/** Deadline for a real re-hash of `bytes`: data-scaled, never below the old fixed budget. */
export function coldHashBudgetMs(bytes: number): number {
  return Math.max(COLD_HASH_MIN_BUDGET_MS, Math.ceil((bytes / COLD_HASH_FLOOR_BYTES_PER_SEC) * 1000));
}

/**
 * sha256 over every directory entry under `dir` (files, directories, symlinks, other),
 * sorted by name at each level, with its lstat identity. A SUPERSET of what any
 * provider's `hashDir` reads, so it can only over-detect change.
 */
export function payloadStatFingerprint(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      const p = join(d, e.name);
      const s = lstatSync(p, { bigint: true });
      rows.push([relative(dir, p), s.mode, s.size, s.mtimeNs, s.ctimeNs, s.ino, s.dev].join('\t'));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

export interface SeedVerifyKeyInput {
  storeKind: string;
  /** sha256 of the manifest file's bytes. */
  manifestSha256: string;
  /** From `verifierIdentity`. */
  verifierIdentity: string;
  payloadDir: string;
}

export function seedVerifyCacheKey(input: SeedVerifyKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        SEED_VERIFY_CACHE_SCHEMA,
        input.storeKind,
        input.manifestSha256,
        input.verifierIdentity,
        payloadStatFingerprint(input.payloadDir),
      ]),
    )
    .digest('hex');
}

interface VerifyLike<E> {
  verify(entry: E, payload: { path: string }): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Behavioural identity of a provider's verifier. It runs the provider's REAL `verify()`
 * over a small fixed canary directory against an all-zero expected hash, and records the
 * verdict (both providers name the computed digest's prefix in the mismatch reason).
 * Any change to how the provider hashes (ordering, exclusions, path encoding, algorithm)
 * changes it. `verify.toString()` adds the method's own source, which covers a new
 * precondition added inside `verify()` that the canary would not trip.
 *
 * The canary carries the files the git provider requires (index.json, super.bundle), a
 * nested directory, a numbered WAL (data) and a RocksDB info LOG (excluded by the
 * corestore walk), so ordering and exclusion rules both reach the digest.
 */
export async function verifierIdentity<E extends object>(
  provider: VerifyLike<E>,
  entry: E,
  tmpRoot: string = tmpdir(),
): Promise<string> {
  const canary = mkdtempSync(join(tmpRoot, 'seed-verify-canary-'));
  try {
    mkdirSync(join(canary, 'db'));
    writeFileSync(join(canary, 'index.json'), '{"canary":1}\n');
    writeFileSync(join(canary, 'super.bundle'), 'canary-bundle\n');
    writeFileSync(join(canary, 'db', '000001.log'), 'canary-wal\n');
    writeFileSync(join(canary, 'db', 'LOG'), 'canary-info-log\n');
    const verdict = await provider.verify({ ...entry, hash: '0'.repeat(64) }, { path: canary });
    return JSON.stringify([verdict.ok, verdict.reason ?? null, provider.verify.toString()]);
  } finally {
    rmSync(canary, { recursive: true, force: true });
  }
}

export interface SeedVerifyCache {
  /** null when the cache is disabled. */
  readonly path: string | null;
  has(key: string): boolean;
  /** Record a key whose REAL verify returned ok. No-op when disabled. */
  record(key: string): void;
}

interface CacheFile {
  schema: number;
  verified: Record<string, string>;
}

function readCacheFile(path: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheFile>;
    if (parsed.schema === SEED_VERIFY_CACHE_SCHEMA && parsed.verified && typeof parsed.verified === 'object') {
      return { schema: SEED_VERIFY_CACHE_SCHEMA, verified: { ...parsed.verified } };
    }
  } catch {
    // Absent or unreadable: an empty cache, i.e. every lookup misses and runs the real verify.
  }
  return { schema: SEED_VERIFY_CACHE_SCHEMA, verified: {} };
}

export function openSeedVerifyCache(path: string | null): SeedVerifyCache {
  if (path === null) return { path: null, has: () => false, record: () => undefined };
  return {
    path,
    has: (key) => Object.prototype.hasOwnProperty.call(readCacheFile(path).verified, key),
    record: (key) => {
      const file = readCacheFile(path);
      file.verified[key] = new Date().toISOString();
      const kept = Object.entries(file.verified)
        .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
        .slice(0, SEED_VERIFY_CACHE_MAX_ENTRIES);
      file.verified = Object.fromEntries(kept);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}

/** Cache location: `off`/`0`/`false` disables; another non-empty value is the path. */
export function resolveSeedVerifyCachePath(env: NodeJS.ProcessEnv, repoRoot: string): string | null {
  const raw = env[SEED_VERIFY_CACHE_ENV]?.trim();
  if (raw && ['off', '0', 'false'].includes(raw.toLowerCase())) return null;
  if (raw) return raw;
  return join(repoRoot, 'node_modules', '.cache', 'papercusp', 'shipped-seed-verify.json');
}

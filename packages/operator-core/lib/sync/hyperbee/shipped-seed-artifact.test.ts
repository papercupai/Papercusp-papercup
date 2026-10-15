/**
 * shipped-seed-artifact — the recurrence guard for EI-19455669487837783.
 *
 * WHY THIS EXISTS, given restore-hive-seed.test.ts already has 17 tests.
 *
 * Those tests cover the LOGIC exhaustively (resolve precedence, the WI-2902
 * autodetect fallthrough, the encrypted-git defer/split, failure isolation) —
 * but every one of them builds a SYNTHETIC seed. Nothing asserted that the seed
 * we actually SHIP is well-formed enough for that (correct) logic to succeed on
 * it. That gap is not hypothetical:
 *
 *   - WI-2902: every packaged install logged `restored=[]` — the logic was fine,
 *     the shipped artifact could not be opened.
 *   - WI-3306 (Windows) and WI-3307 (Mac) both closed on HAND verification of
 *     this artifact. On 2026-08-03 that hand check was performed a third time
 *     and produced a WRONG conclusion ("bundle ships unseeded"), retracted the
 *     same hour. A hand check that has to be re-derived per platform, per
 *     release, is a detector that fails silently.
 *
 * So this file asserts the shipped artifact's INTEGRITY, cheaply, in seconds —
 * it deliberately does NOT perform a restore. The restore itself is an in-process
 * hypercore replication of ~108k blocks and takes ~4m52s wall for the real 2.0G
 * seed (measured 2026-08-03), which is why it can never be a routine test; the
 * replication path is already covered with small fixtures by
 * seed-provider-corestore.test.ts.
 *
 * SKIPS when no seed is present (dev boxes and CI checkouts do not carry the
 * 2.0G payload). A skip must never read as a pass — the skip reason says so.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeManifest } from '@papercusp/seed-bundle';
import { resolveSeedDir, SEED_MANIFEST_FILE, defaultSeedRegistry } from './restore-hive-seed';
import { createBundledEpochKeyProvider } from './bundled-epoch-key-provider';
import { resolveSeedDecryptionKey } from './deferred-git-restore';
// The SAME predicate the cutter's walk uses, imported rather than re-spelled so the
// two populations cannot drift apart again (this file's whole size-drift red came
// from a local re-implementation that omitted it). Free: restore-hive-seed already
// imports this module, so nothing extra is loaded.
import { isRocksInfoLog } from './seed-provider-corestore';
import { createHash } from 'node:crypto';
import {
  coldHashBudgetMs,
  openSeedVerifyCache,
  resolveSeedVerifyCachePath,
  seedVerifyCacheKey,
  verifierIdentity,
} from './shipped-seed-verify-cache';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/operator-core/lib/sync/hyperbee → repo root */
const REPO_ROOT = join(HERE, '../../../../..');
/** Overridable so falsifiability can be proven against a DOCTORED COPY outside the
 *  tree — never by mutating the real artifact (the shared tree is swept into commits
 *  every few minutes, so an in-tree mutation can be committed mid-probe). */
const SEED_DIR = process.env.PAPERCUSP_TEST_SEED_DIR ?? join(REPO_ROOT, 'papercusp-desktop/src-tauri/seed');

const seedPresent = existsSync(join(SEED_DIR, SEED_MANIFEST_FILE));

/**
 * Total bytes + file count of a payload dir, measuring the SAME population the
 * manifest's `sizeBytes` describes: regular files only, recursive, MINUS RocksDB's
 * info LOG.
 *
 * That last clause is load-bearing and was missing (WI-37577). The cutter's walk
 * skips `LOG` / `LOG.old*` (seed-provider-corestore.ts `isRocksInfoLog`, mirrored in
 * seed-cutter.ts) because RocksDB rewrites that file on EVERY store open — it is
 * non-deterministic, hash-excluded (EI-12881) and scrubbed from the shipped seed
 * (WI-4736). This helper's comment claimed it mirrored the cut but counted the LOG
 * anyway, so it compared a different population against the manifest and reported the
 * difference as a "drifted" payload.
 *
 * MEASURED 2026-08-09 on the real seed: all-files 6,031,427,350 − db/LOG 1,529,554 =
 * 6,029,897,796 = exactly the manifest's declared corestore sizeBytes. The red was the
 * LOG, byte for byte, and nothing else.
 *
 * ⚠ This does NOT weaken the truncated-ship assertion — it is what makes it MEANINGFUL.
 * Every data byte is still compared exactly; only a file the manifest never counted is
 * excluded. Counting it made the check unpassable on any box whose store had been opened
 * (i.e. every dev box), which is a false red, not a stricter test. In particular the
 * numbered `<NNN>.log` WALs are DATA and still participate — see the controls below.
 */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        if (isRocksInfoLog(e.name)) continue;
        files++;
        bytes += statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

describe.skipIf(!seedPresent)('shipped seed artifact (integrity of the real bundled seed)', () => {
  const manifest = seedPresent
    ? decodeManifest(readFileSync(join(SEED_DIR, SEED_MANIFEST_FILE), 'utf8'))
    : null;
  // Bytes a cold re-hash must read, for its data-scaled deadline. measure() is stat-only.
  const resourcePayloadBytes = (manifest?.stores ?? []).reduce((sum, store) => {
    if (store.source.type !== 'resource') return sum;
    const dir = join(SEED_DIR, store.source.path);
    return existsSync(dir) ? sum + measure(dir).bytes : sum;
  }, 0);

  it('resolves via the shipped precedence — PAPERCUSP_SEED_DIR ⇒ source:env, not a cold path', () => {
    const r = resolveSeedDir({ env: { PAPERCUSP_SEED_DIR: SEED_DIR } });
    expect(r.disabled).toBe(false);
    expect(r.seedDir).toBe(SEED_DIR);
    // 'env-missing' here would mean the shipped dir holds no manifest — i.e. the
    // artifact ships in a shape boot silently cold-paths on.
    expect(r.source).toBe('env');
  });

  it('the manifest parses with the REAL decoder (not JSON.parse) and names a hive', () => {
    // decodeManifest throws SeedManifestError on a schema regression — a manifest
    // that is valid JSON but invalid to the decoder cold-paths at boot with only
    // an info-level log, so it must fail loudly HERE instead.
    expect(manifest!.seedFormatVersion).toBeGreaterThanOrEqual(1);
    expect(manifest!.potId.length).toBeGreaterThan(0);
    expect(manifest!.stores.length).toBeGreaterThan(0);
  });

  it('declares a corestore store with at least one coreKey — the WI-2902 `restored=[]` guard', () => {
    const core = manifest!.stores.find((s) => s.kind === 'corestore');
    expect(core, 'no corestore store in the shipped manifest').toBeDefined();
    const coreKeys = (core!.meta as { coreKeys?: readonly string[] } | undefined)?.coreKeys ?? [];
    // Zero coreKeys restores NOTHING while still reporting success — the exact
    // shape of the packaged-install failure in WI-2902.
    expect(coreKeys.length).toBeGreaterThan(0);
  });

  it('keeps the git store ENCRYPTED, so boot defers it pre-admission (the documented split)', () => {
    const git = manifest!.stores.find((s) => s.kind === 'git');
    expect(git, 'no git store in the shipped manifest').toBeDefined();
    // If a packaging change ever ships git unencrypted, boot would restore it
    // PRE-admission instead of deferring — a silent change to boot semantics.
    expect(git!.encryption).toBeDefined();
  });

  it('every declared payload exists on disk at its declared size (catches a truncated/partial ship)', () => {
    for (const store of manifest!.stores) {
      // A shipped seed's payloads must be BUNDLED resources. A 'url' or 'swarm'
      // source would make first boot fetch over the network — which is precisely
      // the offline promise this seed exists to keep. (Also narrows the union.)
      expect(store.source.type, `${store.kind}: payload is not a bundled resource`).toBe('resource');
      if (store.source.type !== 'resource') continue;
      const payloadDir = join(SEED_DIR, store.source.path);
      expect(existsSync(payloadDir), `${store.kind}: payload dir missing at ${payloadDir}`).toBe(true);
      const actual = measure(payloadDir);
      expect(actual.files, `${store.kind}: payload dir is empty`).toBeGreaterThan(0);
      // This is precisely the check WI-3306/WI-3307 performed BY HAND. A partial
      // ship (interrupted copy, a bundler that dropped files) leaves a manifest
      // promising bytes the payload no longer has, and boot only discovers it
      // mid-restore.
      expect(actual.bytes, `${store.kind}: payload size drifted from the manifest`).toBe(store.sizeBytes);
    }
  });

  /**
   * WI-39447 — the SIZE check above is the weak half of the entry, and on its own it let the
   * defect ship. `sizeBytes` cannot see a same-size mutation, and more importantly it is NOT
   * what boot gates on: `restoreSeed` calls `provider.verify()`, which is a `hashDir` against
   * `entry.hash` (libs/generic/seed-bundle/src/restore.ts). A store that fails there is not a
   * crash and not a warning — it is pushed as a failed outcome and `continue`d past, so the
   * install SUCCEEDS while that store never restores. For the corestore that means an empty
   * hive on a fresh install, with nothing in the UI to say so.
   *
   * So assert the hash, through the REAL registry rather than a local re-implementation — the
   * same mistake this file already made once with `measure()` (see its note). Running boot's
   * own providers means "the artifact passes this test" and "the installer will restore it"
   * cannot drift apart.
   *
   * MEASURED on the shipped 2026-08-15 seed: corestore declared 13b280d7…/318,544,683 B but
   * hashed fa4fddc2…/268,378,998 B — 50,165,685 short, 64 of 76 blocks. The git store verified
   * clean, which is what localises the defect to the grafted corestore (`--reuse-corestore`
   * inherits the prior manifest's entry and re-measures nothing — see
   * apps/operator/lib/release/seed-payload-integrity-guard.ts, which now refuses that at cut
   * time so this artifact-side red stops being the first place anyone finds out).
   *
   * WI-10007537: a byte-identical payload is not re-hashed. On this box the read path is
   * bound by kernel time under host memory pressure (111-153 s of system CPU per 3.7 GB
   * pass, with no page-cache reuse between passes), so a re-hash every run timed out at a
   * fixed 120 s. The REAL verify still runs whenever anything it
   * depended on moved: the manifest bytes, the verifier's behaviour or source, or any
   * payload entry's stat identity (ino, ctime, size). Only an `ok` verdict is cached, so a
   * failing payload is re-measured every run. The rationale and the measurement are in
   * shipped-seed-verify-cache.ts; `PAPERCUSP_SEED_VERIFY_CACHE=off` forces the full re-hash.
   */
  it(
    'every declared payload HASHES to its manifest entry — the exact gate boot applies',
    async () => {
      const registry = defaultSeedRegistry();
      const cache = openSeedVerifyCache(resolveSeedVerifyCachePath(process.env, REPO_ROOT));
      const manifestSha256 = createHash('sha256').update(readFileSync(join(SEED_DIR, SEED_MANIFEST_FILE))).digest('hex');
      for (const store of manifest!.stores) {
        if (store.source.type !== 'resource') continue;
        const provider = registry.get(store.kind);
        expect(provider, `${store.kind}: no provider registered — boot could not restore it`).toBeDefined();
        const payloadDir = join(SEED_DIR, store.source.path);
        const cacheKey = seedVerifyCacheKey({
          storeKind: store.kind,
          manifestSha256,
          verifierIdentity: await verifierIdentity(provider!, store),
          payloadDir,
        });
        if (cache.has(cacheKey)) continue; // verified byte-identical payload, same verifier, same manifest
        const verdict = await provider!.verify(store, { path: payloadDir });
        expect(
          verdict.ok,
          `${store.kind}: ${verdict.reason ?? 'unknown'} — boot SKIPS this store and restores without it`,
        ).toBe(true);
        cache.record(cacheKey);
      }
    },
    // Only a cache miss pays the full read; its deadline is derived from the bytes it reads.
    coldHashBudgetMs(resourcePayloadBytes),
  );

  it('ships the bundled epoch keys — the offline path for the DEFERRED git restore', () => {
    // bootstrap-papercusp-hive.ts:453-458 calls this "the crux of the offline pot":
    // post-admission the deferred git store resolves its key from this file when
    // there is no network. Absent ⇒ the offline pot degrades to a cold join.
    const keysPath = join(SEED_DIR, 'epoch-keys.json');
    expect(existsSync(keysPath), 'epoch-keys.json missing — offline git restore cannot resolve a key').toBe(true);
    const parsed = JSON.parse(readFileSync(keysPath, 'utf8')) as unknown;
    expect(parsed, 'epoch-keys.json is not a non-empty object').toBeTruthy();
    expect(Object.keys(parsed as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it("RESOLVES the git store's declared keyRef through the real provider — not merely that keys ship", async () => {
    // EI-19458472116740526. The assertion above is satisfied by ANY non-empty
    // epoch-keys.json, including one that does not carry the epoch/potId this
    // manifest's keyRef actually names — a seed cut at epoch 2 shipped with only
    // epochs 0..1, or a potId rename. In that case the file exists, parses, is
    // non-empty, every check above passes, and boot still cold-paths: the provider
    // throws EpochKeyUnavailableError, resolveSeedDecryptionKey maps it to null,
    // and the git store stays deferred forever. On an offline box that is exactly
    // the empty pot the whole seed effort exists to prevent, and it is logged as a
    // normal path, so nothing surfaces it.
    //
    // This runs the SHIPPED chain (bootstrap-papercusp-hive.ts:477-480 builds the
    // same bundled provider) against the SHIPPED artifact, end to end: manifest →
    // keyRef → provider → base64 decode → 32-byte length check.
    //
    // Cheap enough to be routine: measured 2026-08-03 at 0ms (epoch-keys.json is
    // 138 bytes and the provider caches the parse). The item that filed this
    // predicted key resolution could NOT be asserted cheaply — measurement showed
    // otherwise. Only the DECRYPT half is expensive, and that is a separate,
    // deliberately non-routine measurement (the full restore ran in 9.8s wall and
    // materialized an 18,987-file checkout; evidence on the work-item).
    const git = manifest!.stores.find((s) => s.kind === 'git');
    expect(git?.encryption, 'no encrypted git store to resolve a key for').toBeDefined();
    const keyRef = git!.encryption!.keyRef;

    // SeedKeyRef is a discriminated union on `via`, and the discriminant is itself
    // load-bearing: deferred-git-restore.ts resolves `via:'seed-key-op'` to null
    // unconditionally ("no standalone seed-key content op exists"), so a seed cut
    // that way can NEVER restore its git half — it defers forever and cold-paths on
    // every boot, online or off. Pinning the discriminant is therefore a real
    // assertion about the shipped artifact, not just type narrowing for `.epoch`.
    expect(
      keyRef.via,
      `shipped git seed uses keyRef.via='${keyRef.via}', which has no delivery path — ` +
        `its code half would cold-path forever`,
    ).toBe('epoch');
    if (keyRef.via !== 'epoch') return;

    const key = await resolveSeedDecryptionKey(keyRef, {
      epochKeyProvider: createBundledEpochKeyProvider(SEED_DIR),
    });

    // null is the fail-soft "stays deferred" signal — the silent degradation itself.
    expect(
      key,
      `epoch ${keyRef.epoch} for pot '${keyRef.potId}' did not resolve from the bundled ` +
        `epoch-keys.json — the shipped git seed would silently cold-path on an offline install`,
    ).not.toBeNull();
    // A wrong-length key is rejected by the provider (fail-closed), so a non-null
    // result must be exactly 32 bytes; asserting it pins that contract here too.
    expect(key!.length, 'resolved epoch key is not 32 bytes').toBe(32);
  });
});

describe.skipIf(seedPresent)('shipped seed artifact', () => {
  it('SKIPPED — no bundled seed in this checkout (a skip is NOT a pass)', () => {
    // Present so the absence is visible in the report rather than silent.
    expect(seedPresent).toBe(false);
  });
});

/**
 * Controls for `measure()` itself (WI-37577).
 *
 * These run EVERYWHERE — no bundled seed required — deliberately: the integrity block
 * above skips on every checkout without a 6G seed, so without these the measuring rule
 * would be unguarded on exactly the boxes (CI, the green-checkpoint clone) where a
 * regression would land unnoticed. They build fixtures in a tmpdir; the shared tree is
 * never mutated (a sweep can commit an in-tree mutation mid-probe).
 */
describe('measure() counts the same population the manifest declares', () => {
  const mkFixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'wi37577-measure-'));
    mkdirSync(join(dir, 'db'), { recursive: true });
    writeFileSync(join(dir, 'db', 'data.bin'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'db', '000123.log'), Buffer.alloc(300)); // a WAL: DATA
    writeFileSync(join(dir, 'oplog'), Buffer.alloc(700));
    return dir;
  };

  it('counts ordinary payload files (calibration — the exclusion must not eat data)', () => {
    const dir = mkFixture();
    try {
      // 1000 + 300 + 700. If this ever drops to 1700 the WAL stopped counting.
      expect(measure(dir)).toEqual({ files: 3, bytes: 2000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EXCLUDES RocksDB LOG / LOG.old* — and would have over-counted under the pre-fix rule', () => {
    const dir = mkFixture();
    try {
      const clean = measure(dir);
      writeFileSync(join(dir, 'db', 'LOG'), Buffer.alloc(1_529_554)); // the real red, to scale
      writeFileSync(join(dir, 'db', 'LOG.old.1754769600'), Buffer.alloc(4096));
      const withLogs = measure(dir);

      // The property: adding a LOG must not move the measurement at all.
      expect(withLogs).toEqual(clean);

      // Falsifiability of THIS control: the pre-fix rule (count every regular file)
      // demonstrably WOULD have moved, by exactly the LOG bytes. Without this the
      // assertion above also passes if the fixture never wrote the LOGs.
      const naiveAllFiles = (d: string): number => {
        let b = 0;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) b += naiveAllFiles(p);
          else if (e.isFile()) b += statSync(p).size;
        }
        return b;
      };
      expect(naiveAllFiles(dir)).toBe(clean.bytes + 1_529_554 + 4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('STILL catches a truncated/partial ship — the assertion keeps its whole point', () => {
    const dir = mkFixture();
    try {
      const full = measure(dir);
      // Simulate the failure this file exists to catch: a payload file arrives short.
      writeFileSync(join(dir, 'db', 'data.bin'), Buffer.alloc(400));
      expect(measure(dir).bytes).toBe(full.bytes - 600);
      // And an outright dropped file still moves both counters.
      rmSync(join(dir, 'oplog'));
      expect(measure(dir)).toEqual({ files: 2, bytes: full.bytes - 600 - 700 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

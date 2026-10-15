/**
 * seed-cutter.test.ts — the combined hive-seed cutter (P-006).
 *
 * Composes the git + corestore providers into ONE seed dir + manifest, entirely
 * on FIXTURES (real git, real corestore, no network / no PG), and:
 *  - proves the combined manifest is valid + round-trips (decode) + restores
 *    end-to-end (git checkout materializes, corestore blocks pre-position);
 *  - MEASURES installer growth headless, and answers Q-1 (full `--all` vs a
 *    `HEAD`-only git seed) by asserting the narrower rev is smaller;
 *  - exercises the encrypted-git path through the combined cutter.
 *
 * The real 5 GB dogfood repo's size can only be measured by an actual release
 * build; this proves the MECHANISM + the direction of the size trade-off. The
 * CLI (apps/operator/lib/release/cut-seed-cli.ts) prints the real numbers.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import Corestore from 'corestore';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeManifest,
  restoreSeed,
  generateSeedKey,
  SeedProviderRegistry,
  type SeedStoreEntry,
} from '@papercusp/seed-bundle';
import { openOwnLog, type PeerLogOp } from './peer-log';
import { createGitSeedProvider } from './seed-provider-git';
import { createCorestoreSeedProvider } from './seed-provider-corestore';
import { cutHiveSeed, enumerateOwnStoreCoreKeys, measureSeedDir, GIT_SUBDIR, CORESTORE_SUBDIR } from './seed-cutter';

const exec = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeStore(dir: string): Corestore {
  const store = new Corestore(dir);
  cleanups.push(() => store.close());
  return store;
}

function op(i: number): PeerLogOp {
  return { type: 'put', table: 'harness_plans', hbKey: `P-${i}`, value: { id: `P-${i}` }, ts: 100 + i, schema_version: 1, author_pubkey: 'ownerdev' };
}

async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** A fixture repo: `main` holds a small file; a `heavy` branch carries a large
 *  blob NOT reachable from HEAD — so `--all` bundles the heavy branch and `HEAD`
 *  does not, giving a real, deterministic size delta (Q-1). */
async function initFixtureRepo(dir: string): Promise<void> {
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'seed@test']);
  await g(dir, ['config', 'user.name', 'Seed Test']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'readme.txt'), 'small tip file');
  await g(dir, ['add', '.']);
  await g(dir, ['commit', '-qm', 'main tip']);
  // A branch off main carrying a big blob, unreachable from HEAD.
  await g(dir, ['checkout', '-q', '-b', 'heavy']);
  writeFileSync(join(dir, 'big.bin'), randomBytes(512 * 1024)); // 512 KiB, INCOMPRESSIBLE (git can't pack it away)
  await g(dir, ['add', '.']);
  await g(dir, ['commit', '-qm', 'heavy branch blob']);
  await g(dir, ['checkout', '-q', 'main']); // HEAD back on the small tip
}

async function makeHiveStore(prefix: string, nOps: number): Promise<{ store: Corestore; keyHex: string }> {
  const store = makeStore(tmpDir(prefix));
  await store.ready();
  const log = await openOwnLog(store);
  for (let i = 0; i < nOps; i++) await log.append(op(i));
  return { store, keyHex: log.keyHex };
}

describe('cutHiveSeed — combined git + corestore seed', () => {
  it('composes both providers into one valid, portable, restorable manifest', async () => {
    const repo = tmpDir('cutter-repo-');
    await initFixtureRepo(repo);
    const { store, keyHex } = await makeHiveStore('cutter-store-', 3);

    // The owner's own log key is the minimal-correct corestore seed source.
    expect(await enumerateOwnStoreCoreKeys(store)).toEqual([keyHex]);

    const outDir = tmpDir('cutter-out-');
    const res = await cutHiveSeed({
      potId: 'papercusp',
      cutAtEpoch: 0,
      cutHlc: '0000000000000000',
      cutTs: 1_700_000_000_000,
      outDir,
      git: { sourceRepoDir: repo, originUrl: 'https://github.com/Papercusp/papercup', rev: '--all' },
      corestore: { sourceStore: store, coreKeys: [keyHex] },
    });

    // Manifest shape + portability: relative subdir paths, both stores present.
    expect(res.manifest.stores).toHaveLength(2);
    const kinds = res.manifest.stores.map((s) => s.kind).sort();
    expect(kinds).toEqual(['corestore', 'git']);
    for (const s of res.manifest.stores) {
      expect(s.source).toMatchObject({ type: 'resource' });
      expect((s.source as { path: string }).path).toMatch(/^(git|corestore)$/); // RELATIVE, not an abs build path
    }
    expect(existsSync(res.manifestPath)).toBe(true);
    // manifest.json is valid + decodes back to the same content.
    const decoded = decodeManifest(readFileSync(res.manifestPath, 'utf8'));
    expect(decoded.potId).toBe('papercusp');
    expect(decoded.cutAtEpoch).toBe(0);
    expect(decoded.stores).toHaveLength(2);

    // Size report is coherent with the on-disk footprint.
    expect(res.sizeReport.totalBytes).toBeGreaterThan(0);
    expect(res.sizeReport.stores).toHaveLength(2);
    const onDisk = await measureSeedDir(outDir);
    expect(res.sizeReport.totalBytes).toBe(onDisk);

    // --- END-TO-END RESTORE of the COMBINED seed ---
    const registry = new SeedProviderRegistry()
      .register(createGitSeedProvider())
      .register(createCorestoreSeedProvider());
    const targetRepo = join(tmpDir('cutter-restore-repo-'), 'checkout');
    const targetStoreDir = join(tmpDir('cutter-restore-store-'), 'hyperbee');
    const resolvePayload = async (entry: SeedStoreEntry) => ({ path: join(outDir, (entry.source as { path: string }).path) });
    const restore = await restoreSeed(decoded, registry, resolvePayload, { targetRepoDir: targetRepo, targetStoreDir });
    expect(restore.ok).toBe(true);
    expect(restore.outcomes.every((o) => o.ok)).toBe(true);

    // Git half materialized (the small tip file is checked out).
    expect(readFileSync(join(targetRepo, 'readme.txt'), 'utf8')).toBe('small tip file');
    // Corestore half pre-positioned (the seeded log is readable offline).
    const storeB = makeStore(targetStoreDir);
    await storeB.ready();
    type TestCore = { length: number; ready(): Promise<void>; get(i: number, o?: { wait?: boolean }): Promise<unknown> };
    const coreB = storeB.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
    await coreB.ready();
    expect(coreB.length).toBe(3);
    expect(await coreB.get(0, { wait: false })).toMatchObject({ hbKey: 'P-0' });
  });

  it('Q-1: a HEAD-only git seed is smaller than a full --all seed (measured headless)', async () => {
    const repo = tmpDir('cutter-q1-repo-');
    await initFixtureRepo(repo);

    const fullOut = tmpDir('cutter-q1-full-');
    const full = await cutHiveSeed({
      potId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
      outDir: fullOut,
      git: { sourceRepoDir: repo, originUrl: 'u', rev: '--all' },
      corestore: null,
    });

    const headOut = tmpDir('cutter-q1-head-');
    const head = await cutHiveSeed({
      potId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
      outDir: headOut,
      git: { sourceRepoDir: repo, originUrl: 'u', rev: 'HEAD' },
      corestore: null,
    });

    const fullSize = full.sizeReport.stores.find((s) => s.subdir === GIT_SUBDIR)!.sizeBytes;
    const headSize = head.sizeReport.stores.find((s) => s.subdir === GIT_SUBDIR)!.sizeBytes;
    // The heavy branch (512 KiB blob) is in `--all` but NOT reachable from HEAD.
    expect(fullSize).toBeGreaterThan(headSize);
    expect(fullSize - headSize).toBeGreaterThan(256 * 1024);
    // eslint-disable-next-line no-console
    console.log(`[seed Q-1] git --all=${full.sizeReport.totalBytes}B  HEAD=${head.sizeReport.totalBytes}B  saved=${fullSize - headSize}B`);
  });

  it('Q-1: depth=1 snapshots the current tree without reachable history', async () => {
    const repo = tmpDir('cutter-depth-repo-');
    await initFixtureRepo(repo);
    writeFileSync(join(repo, 'reachable-heavy.bin'), randomBytes(512 * 1024));
    await g(repo, ['add', '.']);
    await g(repo, ['commit', '-qm', 'reachable heavy blob']);
    await g(repo, ['rm', '-q', 'reachable-heavy.bin']);
    await g(repo, ['commit', '-qm', 'return to small tree']);

    const headOut = tmpDir('cutter-depth-head-');
    const head = await cutHiveSeed({
      potId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
      outDir: headOut,
      git: { sourceRepoDir: repo, originUrl: 'u', rev: 'HEAD' },
      corestore: null,
    });

    const shallowOut = tmpDir('cutter-depth-shallow-');
    const shallow = await cutHiveSeed({
      potId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
      outDir: shallowOut,
      git: { sourceRepoDir: repo, originUrl: 'u', rev: 'HEAD', depth: 1 },
      corestore: null,
    });

    const headSize = head.sizeReport.stores.find((s) => s.subdir === GIT_SUBDIR)!.sizeBytes;
    const shallowSize = shallow.sizeReport.stores.find((s) => s.subdir === GIT_SUBDIR)!.sizeBytes;
    expect(headSize).toBeGreaterThan(shallowSize);
    expect(headSize - shallowSize).toBeGreaterThan(256 * 1024);
    expect(shallow.manifest.stores[0]?.meta).toMatchObject({ depth: 1 });
  });

  it('carries encryption through the combined cutter (git store sealed at rest)', async () => {
    const repo = tmpDir('cutter-enc-repo-');
    await initFixtureRepo(repo);
    const { store, keyHex } = await makeHiveStore('cutter-enc-store-', 1);
    const key = generateSeedKey();

    const outDir = tmpDir('cutter-enc-out-');
    const res = await cutHiveSeed({
      potId: 'papercusp', cutAtEpoch: 2, cutHlc: 'abc', cutTs: 5,
      outDir,
      git: {
        sourceRepoDir: repo,
        originUrl: 'https://github.com/Papercusp/papercup',
        rev: '--all',
        encryption: { key, keyRef: { via: 'seed-key-op', potId: 'papercusp' } },
      },
      corestore: { sourceStore: store, coreKeys: [keyHex] },
    });

    const gitEntry = res.manifest.stores.find((s) => s.kind === 'git')!;
    expect(gitEntry.encryption?.scheme).toBe('chacha20-poly1305');
    expect(gitEntry.encryption?.keyRef).toEqual({ via: 'seed-key-op', potId: 'papercusp' });
    // The bundle on disk is ciphertext (no git-bundle signature).
    const sealed = readFileSync(join(outDir, GIT_SUBDIR, 'super.bundle')).subarray(0, 32).toString('latin1');
    expect(sealed).not.toMatch(/git bundle/);
    // The corestore entry stays plaintext (already epoch-ciphertext by construction).
    const coreEntry = res.manifest.stores.find((s) => s.kind === 'corestore')!;
    expect(coreEntry.encryption).toBeUndefined();
    expect((coreEntry.source as { path: string }).path).toBe(CORESTORE_SUBDIR);
  });

  it('forwards filtered source-scan progress through the combined cutter', async () => {
    const { store, keyHex } = await makeHiveStore('cutter-progress-store-', 257);
    const onProgress = vi.fn();
    // The projection report is emitted on EVERY filtered cut, and its default sink
    // is a `console.warn` that `vitest-fail-on-console` reds. Take the report through
    // the seam instead of mocking the console: silencing it would leave the drop
    // counts — the whole point of the report — unasserted.
    const onProjection = vi.fn();

    await cutHiveSeed({
      potId: 'papercusp',
      cutAtEpoch: 0,
      cutHlc: '0',
      cutTs: 1,
      outDir: tmpDir('cutter-progress-out-'),
      git: null,
      corestore: {
        sourceStore: store,
        coreKeys: [keyHex],
        filtered: true,
        onProgress,
        onProjection,
      },
    });

    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'filtered-source-scan',
      processed: 256,
      total: 257,
      sourceStart: 0,
      sourceEnd: 257,
      decodedOps: 256,
    }));
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'filtered-source-scan',
      processed: 257,
      total: 257,
      sourceStart: 0,
      sourceEnd: 257,
      decodedOps: 257,
    }));
    expect(onProgress.mock.calls.every(([event]) => event.coreKey === keyHex && event.decodedBytes > 0)).toBe(true);

    // Reaching the sink at all is what proves the seam is threaded from here; the
    // row counts pin that this unredacted fixture is carried rather than dropped.
    expect(onProjection).toHaveBeenCalledTimes(1);
    expect(onProjection.mock.calls[0]?.[0]).toMatchObject({
      ownerKeyHex: keyHex,
      rows: 257,
      carried: 257,
      droppedIdentityKey: 0,
      droppedPrivateIngest: 0,
      droppedIdentityContent: 0,
    });
  });

  it('forwards D166 private source bindings and publishes only the row-drop report', async () => {
    const { store, keyHex } = await makeHiveStore('cutter-uuid-drop-', 2);
    const stored = op(0).value;
    const binding = createHash('sha256').update(JSON.stringify(stored)).digest('hex');
    const occurrence = { segment: 'segment-000001.blob', line: 1, fieldPath: ['idempotencyKey'] };
    const result = await cutHiveSeed({
      potId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
      outDir: tmpDir('cutter-uuid-output-'), git: null,
      corestore: { sourceStore: store, coreKeys: [keyHex], filtered: true, redactValues: [],
        onProjection: vi.fn(), uuidIdempotencyDropPlans: [{
          schema: 'papercusp-uuid-idempotency-row-drop-plan-v1',
          reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166',
          sourceKeyHex: keyHex, sourceLength: 2,
          rows: [{ table: 'harness_plans', hbKey: 'P-0', valueSha256: binding, occurrences: [occurrence] }],
        }] },
    });
    const report = result.manifest.stores[0]!.meta?.uuidIdempotencyRedactions;
    expect(report).toEqual([expect.objectContaining({ droppedRows: 1, occurrenceCount: 1,
      authenticationDisposition: 'dropped', occurrences: [occurrence] })]);
    expect(JSON.stringify(result.manifest)).not.toContain(binding);
    const core = await createCorestoreSeedProvider().verify(result.manifest.stores[0]!,
      { path: join(result.outDir, CORESTORE_SUBDIR) });
    expect(core.ok).toBe(true);
  });

  it('rejects a cut with neither store', async () => {
    await expect(
      cutHiveSeed({ potId: 'h', cutAtEpoch: 0, cutHlc: '0', cutTs: 0, outDir: tmpDir('cutter-empty-'), git: null, corestore: null }),
    ).rejects.toThrow(/at least one of/);
  });
});

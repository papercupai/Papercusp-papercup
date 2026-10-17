/**
 * restore-hive-seed.test.ts — the restore-before-join orchestration (P-007).
 *
 * Fixture-only (real git, real corestore, no network/PG). Proves:
 *  - no seed / corrupt manifest ⇒ cold path (ran:false), never a boot failure;
 *  - an UNENCRYPTED seed restores both stores pre-key;
 *  - the ADMISSION-TIMING SPLIT: an ENCRYPTED git seed with NO key DEFERS git but
 *    still restores the (plaintext-container) corestore pre-join; supplying the key
 *    restores git too;
 *  - failure isolation: one store's bad payload cold-paths only that store.
 */

import { afterEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSeedKey } from '@papercusp/seed-bundle';
import { openOwnLog, type PeerLogOp } from './peer-log';
import { cutHiveSeed } from './seed-cutter';
import { restoreHiveSeed, resolveSeedDir, SEED_MANIFEST_FILE } from './restore-hive-seed';

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

async function initRepo(dir: string): Promise<void> {
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.email', 'seed@test']);
  await g(dir, ['config', 'user.name', 'Seed Test']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'code.txt'), 'the repo');
  await g(dir, ['add', '.']);
  await g(dir, ['commit', '-qm', 'init']);
}

/** Cut a fixture seed (git + corestore) into a fresh dir; return { seedDir, keyHex }. */
async function cutFixtureSeed(opts: { encryptGit?: Uint8Array } = {}): Promise<{ seedDir: string; keyHex: string }> {
  const repo = tmpDir('rhs-repo-');
  await initRepo(repo);
  const store = makeStore(tmpDir('rhs-store-'));
  await store.ready();
  const log = await openOwnLog(store);
  for (let i = 0; i < 3; i++) await log.append(op(i));
  const keyHex = log.keyHex;

  const seedDir = tmpDir('rhs-seed-');
  await rm(seedDir, { recursive: true, force: true });
  await cutHiveSeed({
    potId: 'papercusp', cutAtEpoch: 0, cutHlc: '0', cutTs: 1, outDir: seedDir,
    git: {
      sourceRepoDir: repo,
      originUrl: 'https://github.com/Papercusp/papercup',
      rev: '--all',
      ...(opts.encryptGit ? { encryption: { key: opts.encryptGit, keyRef: { via: 'seed-key-op' as const, potId: 'papercusp' } } } : {}),
    },
    corestore: { sourceStore: store, coreKeys: [keyHex] },
  });
  return { seedDir, keyHex };
}

async function corestoreSeededLength(targetStoreDir: string, keyHex: string): Promise<number> {
  const store = makeStore(targetStoreDir);
  await store.ready();
  type TestCore = { length: number; ready(): Promise<void> };
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as TestCore;
  await core.ready();
  return core.length;
}

describe('resolveSeedDir — bundled-seed-dir resolution (P-010 live-wire 1)', () => {
  const MANIFEST = `/${SEED_MANIFEST_FILE}`;
  /** exists() that returns true only for the listed absolute dir+manifest paths. */
  const existsOnly = (present: string[]) => (p: string) => present.includes(p);

  it('PAPERCUSP_NO_SEED ⇒ disabled cold path, beats an otherwise-valid SEED_DIR', () => {
    const r = resolveSeedDir({
      env: { PAPERCUSP_NO_SEED: '1', PAPERCUSP_SEED_DIR: '/seed' },
      exists: existsOnly([`/seed${MANIFEST}`]),
    });
    expect(r).toEqual({ seedDir: null, disabled: true, source: 'no-seed' });
  });

  it('PAPERCUSP_SEED_DIR with a manifest ⇒ explicit override (source: env)', () => {
    const r = resolveSeedDir({ env: { PAPERCUSP_SEED_DIR: '/seed' }, exists: existsOnly([`/seed${MANIFEST}`]) });
    expect(r).toEqual({ seedDir: '/seed', disabled: false, source: 'env' });
  });

  it('PAPERCUSP_SEED_DIR without a manifest + no autodetect hit ⇒ cold path (source: env-missing), never a broken restore', () => {
    const r = resolveSeedDir({ env: { PAPERCUSP_SEED_DIR: '/seed' }, exists: existsOnly([]) });
    expect(r).toEqual({ seedDir: null, disabled: false, source: 'env-missing' });
  });

  it('a WRONG PAPERCUSP_SEED_DIR falls through to autodetect instead of dead-ending (WI-2902)', () => {
    // The first seeded Linux .deb: Rust passed <sidecar>/seed (nothing there)
    // while the bundle held <resourceRoot>/seed — the env value is a hint, not a veto.
    const r = resolveSeedDir({
      env: {
        PAPERCUSP_SEED_DIR: '/usr/lib/Papercusp GUI/sidecar/seed',
        PAPERCUSP_PG_SQL_DIR: '/usr/lib/Papercusp GUI/sidecar/db-sql',
      },
      exists: existsOnly([`/usr/lib/Papercusp GUI/seed${MANIFEST}`]),
    });
    expect(r).toEqual({
      seedDir: '/usr/lib/Papercusp GUI/seed',
      disabled: false,
      source: 'autodetect:PAPERCUSP_PG_SQL_DIR',
    });
  });

  it('autodetects <resourceRoot>/seed from a sibling resource env (dirname + /seed)', () => {
    // Tauri hands PAPERCUSP_PROMPTS_DIR=<root>/prompts; the seed dir is <root>/seed.
    const r = resolveSeedDir({
      env: { PAPERCUSP_PROMPTS_DIR: '/opt/app/resources/prompts' },
      exists: existsOnly([`/opt/app/resources/seed${MANIFEST}`]),
    });
    expect(r).toEqual({ seedDir: '/opt/app/resources/seed', disabled: false, source: 'autodetect:PAPERCUSP_PROMPTS_DIR' });
  });

  it('autodetects the GRANDPARENT <resourceRoot>/seed when the env points inside sidecar/ (the packaged .deb/.app layout)', () => {
    // Real .deb layout: PAPERCUSP_PROMPTS_DIR=<root>/sidecar/prompts, seed at <root>/seed.
    const r = resolveSeedDir({
      env: { PAPERCUSP_PROMPTS_DIR: '/usr/lib/Papercusp GUI/sidecar/prompts' },
      exists: existsOnly([`/usr/lib/Papercusp GUI/seed${MANIFEST}`]),
    });
    expect(r).toEqual({
      seedDir: '/usr/lib/Papercusp GUI/seed',
      disabled: false,
      source: 'autodetect:PAPERCUSP_PROMPTS_DIR',
    });
  });

  it('prefers the parent candidate (<sidecar>/seed) over the grandparent when both hold manifests', () => {
    const r = resolveSeedDir({
      env: { PAPERCUSP_PROMPTS_DIR: '/root/sidecar/prompts' },
      exists: existsOnly([`/root/sidecar/seed${MANIFEST}`, `/root/seed${MANIFEST}`]),
    });
    expect(r).toEqual({ seedDir: '/root/sidecar/seed', disabled: false, source: 'autodetect:PAPERCUSP_PROMPTS_DIR' });
  });

  it('falls through sibling envs to the first whose <root>/seed holds a manifest', () => {
    const r = resolveSeedDir({
      env: { PAPERCUSP_PROMPTS_DIR: '/a/prompts', PAPERCUSP_HARNESS_DIR: '/b/harness' },
      exists: existsOnly([`/b/seed${MANIFEST}`]), // only the harness-derived candidate has a manifest
    });
    expect(r).toEqual({ seedDir: '/b/seed', disabled: false, source: 'autodetect:PAPERCUSP_HARNESS_DIR' });
  });

  it('no env + no autodetect hit ⇒ cold path (source: none) — dev boxes + seed-less builds', () => {
    const r = resolveSeedDir({ env: { PAPERCUSP_PROMPTS_DIR: '/a/prompts' }, exists: existsOnly([]) });
    expect(r).toEqual({ seedDir: null, disabled: false, source: 'none' });
  });

  it('empty env ⇒ cold path (source: none)', () => {
    expect(resolveSeedDir({ env: {}, exists: existsOnly([]) })).toEqual({ seedDir: null, disabled: false, source: 'none' });
  });
});

describe('restoreHiveSeed — restore-before-join orchestration', () => {
  it('no seed present ⇒ cold path (ran:false), never throws', async () => {
    const res = await restoreHiveSeed({
      seedDir: join(tmpDir('rhs-empty-'), 'nope'),
      targetRepoDir: join(tmpDir('rhs-r-'), 'repo'),
      targetStoreDir: join(tmpDir('rhs-s-'), 'hyperbee'),
    });
    expect(res).toEqual({ ran: false, outcomes: [], deferred: [] });
  });

  it('a corrupt manifest ⇒ cold path, never a boot failure', async () => {
    const seedDir = tmpDir('rhs-corrupt-');
    writeFileSync(join(seedDir, SEED_MANIFEST_FILE), '{ not valid json');
    const res = await restoreHiveSeed({
      seedDir,
      targetRepoDir: join(tmpDir('rhs-r2-'), 'repo'),
      targetStoreDir: join(tmpDir('rhs-s2-'), 'hyperbee'),
    });
    expect(res.ran).toBe(false);
  });

  // WI-9413 — the cold-path DETECTOR. Both directions matter: a seedless dev
  // checkout cold-pathing is correct and must stay quiet, while a SHIPPED seed
  // cold-pathing means the install boots empty offline and must be loud. Before
  // this, both were the same untyped info line, so the fatal case was invisible
  // in the only place it surfaced at all.
  it('WI-9413: a seedless checkout cold-paths QUIETLY — never at error level', async () => {
    const seen: Array<{ msg: string; level?: string }> = [];
    const res = await restoreHiveSeed({
      seedDir: join(tmpDir('rhs-quiet-'), 'nope'),
      targetRepoDir: join(tmpDir('rhs-qr-'), 'repo'),
      targetStoreDir: join(tmpDir('rhs-qs-'), 'hyperbee'),
      log: (msg, level) => seen.push({ msg, level }),
    });
    expect(res.ran).toBe(false);
    // The critical assertion: no false alarm. Every dev box and CI checkout takes
    // this path on every boot, so an error here would train everyone to ignore it.
    expect(seen.some((l) => l.level === 'error')).toBe(false);
    expect(seen.some((l) => l.msg.includes('no seed present'))).toBe(true);
  });

  it('WI-9413: a SHIPPED but unreadable manifest cold-paths at ERROR level', async () => {
    const seedDir = tmpDir('rhs-shipped-corrupt-');
    // Same fixture shape as the corrupt-manifest test above: the file IS present
    // (a seed shipped) but cannot be decoded. defaultReadManifest collapses this to
    // the same `null` as "no seed at all" — which is exactly why severity has to be
    // decided by whether the manifest file exists, not by the null.
    writeFileSync(join(seedDir, SEED_MANIFEST_FILE), '{ not valid json');
    const seen: Array<{ msg: string; level?: string }> = [];
    const res = await restoreHiveSeed({
      seedDir,
      targetRepoDir: join(tmpDir('rhs-sr-'), 'repo'),
      targetStoreDir: join(tmpDir('rhs-ss-'), 'hyperbee'),
      log: (msg, level) => seen.push({ msg, level }),
    });
    // Still fail-soft — this must never become a boot failure (the whole point of
    // the null-not-throw contract). It is the SEVERITY that changes, not the flow.
    expect(res.ran).toBe(false);
    const errors = seen.filter((l) => l.level === 'error');
    expect(errors.length, 'a shipped-but-unreadable seed did not surface at error level').toBe(1);
    expect(errors[0]!.msg).toContain('UNREADABLE');
  });

  it('--no-seed (disabled:true) ⇒ cold path even with a valid seed present', async () => {
    const { seedDir } = await cutFixtureSeed();
    const targetRepoDir = join(tmpDir('rhs-dis-r-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-dis-s-'), 'hyperbee');
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir, disabled: true });
    expect(res).toEqual({ ran: false, outcomes: [], deferred: [] });
    expect(existsSync(join(targetRepoDir, 'code.txt'))).toBe(false); // nothing restored
  });

  it('an UNENCRYPTED seed restores BOTH stores pre-key', async () => {
    const { seedDir, keyHex } = await cutFixtureSeed();
    const targetRepoDir = join(tmpDir('rhs-r3-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s3-'), 'hyperbee');
    const logs: string[] = [];

    const res = await restoreHiveSeed({
      seedDir,
      targetRepoDir,
      targetStoreDir,
      log: (msg) => logs.push(msg),
    });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]);
    expect(res.outcomes.every((o) => o.ok)).toBe(true);
    expect(res.outcomes.map((o) => o.kind).sort()).toEqual(['corestore', 'git']);
    expect(logs).toEqual(
      expect.arrayContaining([
        '[seed] git verify started',
        '[seed] git verify succeeded',
        '[seed] git restore started',
        '[seed] git restore succeeded',
        '[seed] corestore verify started',
        '[seed] corestore verify succeeded',
        '[seed] corestore restore started',
        '[seed] corestore restore succeeded',
      ]),
    );
    // Git checkout + corestore blocks both pre-positioned.
    expect(readFileSync(join(targetRepoDir, 'code.txt'), 'utf8')).toBe('the repo');
    expect(await corestoreSeededLength(targetStoreDir, keyHex)).toBe(3);
  });

  it('SPLIT: an ENCRYPTED git seed with NO key DEFERS git, still restores corestore pre-join', async () => {
    const key = generateSeedKey();
    const { seedDir, keyHex } = await cutFixtureSeed({ encryptGit: key });
    const targetRepoDir = join(tmpDir('rhs-r4-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s4-'), 'hyperbee');

    // No decryptionKey → git deferred (awaiting post-admission key), corestore restores.
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual(['git']);
    expect(res.outcomes.map((o) => o.kind)).toEqual(['corestore']);
    expect(res.outcomes[0].ok).toBe(true);
    expect(await corestoreSeededLength(targetStoreDir, keyHex)).toBe(3);
    expect(existsSync(join(targetRepoDir, 'code.txt'))).toBe(false); // git NOT restored (deferred)
  });

  it('SPLIT: supplying the key restores the git seed too', async () => {
    const key = generateSeedKey();
    const { seedDir } = await cutFixtureSeed({ encryptGit: key });
    const targetRepoDir = join(tmpDir('rhs-r5-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s5-'), 'hyperbee');

    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir, decryptionKey: key });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]);
    expect(res.outcomes.every((o) => o.ok)).toBe(true);
    expect(readFileSync(join(targetRepoDir, 'code.txt'), 'utf8')).toBe('the repo');
  });

  it('failure isolation: a wrong git key cold-paths git but corestore still restores', async () => {
    const key = generateSeedKey();
    const { seedDir, keyHex } = await cutFixtureSeed({ encryptGit: key });
    const targetRepoDir = join(tmpDir('rhs-r6-'), 'repo');
    const targetStoreDir = join(tmpDir('rhs-s6-'), 'hyperbee');

    // Present-but-WRONG key: git is NOT deferred (a key exists) — it ATTEMPTS and
    // fails at decrypt; corestore is unaffected.
    const res = await restoreHiveSeed({ seedDir, targetRepoDir, targetStoreDir, decryptionKey: generateSeedKey() });
    expect(res.ran).toBe(true);
    expect(res.deferred).toEqual([]);
    const byKind = Object.fromEntries(res.outcomes.map((o) => [o.kind, o]));
    expect(byKind.corestore.ok).toBe(true);
    expect(byKind.git.ok).toBe(false); // decrypt failed → cold-pathed, not thrown
    expect(await corestoreSeededLength(targetStoreDir, keyHex)).toBe(3);
  });
});

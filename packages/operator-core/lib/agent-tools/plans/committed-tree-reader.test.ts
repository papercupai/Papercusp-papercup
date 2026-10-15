/**
 * committed-tree-reader (proof-freshness-pinned-candidate-2026-10-06 P-002, D-001): files are
 * read from git objects at one measurement commit, so uncommitted edits are invisible, a
 * committed change (including inside a submodule) is visible, and reads stay batched per
 * repository. Every case runs against a real temporary superproject with a nested repository
 * recorded as a gitlink.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastGlob from 'fast-glob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';
import {
  __resetCommittedBlobDigestsForTest,
  createCommittedTreeDiagnostics,
  defaultBlobBatchReader,
  fingerprintRepoFileSetAtCommit,
  listCommittedGlobMatches,
  parseCatFileBatch,
  readCommittedFiles,
  readHeadCommitFromFiles,
  REPO_FIXTURE_READ_LIMITS,
  resolveMeasurementCommit,
  type BlobBatchReader,
} from './committed-tree-reader';

// Real fixture Git stays local, independent of the operator's shared sidecar.
vi.mock('../../fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/git-via-sidecar')>()),
  gitSidecarEnabled: () => false,
}));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

let root: string;
let sub: string;

/** Superproject with `src/a.ts` and a nested repository `libs/sub` recorded as a gitlink. */
function makeTree() {
  root = mkdtempSync(join(tmpdir(), 'committed-tree-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  sub = join(root, 'libs/sub');
  mkdirSync(join(sub, 'sql'), { recursive: true });
  git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(join(sub, 'sql/001.sql'), 'select 1;\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'sub init');
  git(root, 'add', 'src/a.ts', 'libs/sub');
  git(root, 'commit', '-q', '-m', 'root init');
}

beforeEach(() => {
  __resetCommittedBlobDigestsForTest();
  makeTree();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha256 = (path: string) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

/** The sha256-file-set-v1 formula, re-stated independently so a format change fails here. */
const expectedFingerprint = (entries: Array<{ path: string; sha256: string }>) =>
  `sha256-file-set-v1:${createHash('sha256')
    .update(JSON.stringify([...entries].sort((a, b) => a.path.localeCompare(b.path))))
    .digest('hex')}`;

const paths = ['src/a.ts', 'libs/sub/sql/001.sql'];

describe('resolveMeasurementCommit', () => {
  it('returns the HEAD commit of a git checkout and null for a directory that is not one', async () => {
    expect(await resolveMeasurementCommit(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    const plain = mkdtempSync(join(tmpdir(), 'committed-tree-plain-'));
    try {
      expect(await resolveMeasurementCommit(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns null for a subdirectory of a checkout, whose paths are not top-level relative', async () => {
    expect(await resolveMeasurementCommit(join(root, 'src'))).toBeNull();
    // A nested repository is its own top level and resolves to its own HEAD.
    expect(await resolveMeasurementCommit(sub)).toBe(git(sub, 'rev-parse', 'HEAD'));
  });

  it('keeps exact git semantics for an injected runner: the in-process read is the default path only', async () => {
    const calls: string[][] = [];
    const counting: GitRunner = async (cwd, args) => {
      calls.push([...args]);
      return defaultGitRunner(cwd, args);
    };
    expect(await resolveMeasurementCommit(root, counting)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(calls).toEqual([['rev-parse', '--show-toplevel', 'HEAD^{commit}']]);
  });
});

// WI-6554700010008489: HEAD read from the repository files instead of a git child. The
// oracle in every case is `git rev-parse HEAD` on the same checkout.
describe('readHeadCommitFromFiles', () => {
  it('matches git for a branch ref while it is loose and after it is packed', async () => {
    expect(await readHeadCommitFromFiles(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    git(root, 'pack-refs', '--all');
    expect(readFileSync(join(root, '.git/packed-refs'), 'utf8')).toContain('refs/heads/main');
    expect(await readHeadCommitFromFiles(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(await readHeadCommitFromFiles(sub)).toBe(git(sub, 'rev-parse', 'HEAD'));
  });

  it('reads fresh on every call, so a commit landed in between is seen at once', async () => {
    const before = await readHeadCommitFromFiles(root);
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'next');
    const after = await readHeadCommitFromFiles(root);
    expect(after).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(after).not.toBe(before);
  });

  it('matches git for a detached HEAD and for a linked worktree whose .git is a gitdir pointer', async () => {
    const first = git(root, 'rev-parse', 'HEAD');
    const wt = mkdtempSync(join(tmpdir(), 'committed-tree-wt-'));
    rmSync(wt, { recursive: true, force: true });
    try {
      git(root, 'worktree', 'add', '-q', '-b', 'side', wt);
      expect(readFileSync(join(wt, '.git'), 'utf8')).toMatch(/^gitdir:/);
      expect(await readHeadCommitFromFiles(wt)).toBe(git(wt, 'rev-parse', 'HEAD'));
      git(root, 'checkout', '-q', '--detach', first);
      expect(await readHeadCommitFromFiles(root)).toBe(first);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('declines (undefined) wherever only git can answer, so the caller falls back to it', async () => {
    expect(await readHeadCommitFromFiles(join(root, 'src'))).toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), 'committed-tree-plain-'));
    const unborn = mkdtempSync(join(tmpdir(), 'committed-tree-unborn-'));
    try {
      expect(await readHeadCommitFromFiles(plain)).toBeUndefined();
      git(unborn, 'init', '-q', '-b', 'main');
      expect(await readHeadCommitFromFiles(unborn)).toBeUndefined();
      expect(await resolveMeasurementCommit(unborn)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(unborn, { recursive: true, force: true });
    }
    // A core.worktree that moves the work tree elsewhere: git answers (and the root is no
    // longer the top level, so it resolves null).
    git(root, 'config', 'core.worktree', join(root, 'src'));
    expect(await readHeadCommitFromFiles(root)).toBeUndefined();
    git(root, 'config', '--unset', 'core.worktree');
  });

  it('answers for the submodule layout: a gitdir pointer whose core.worktree names the checkout', async () => {
    // Build the layout `git submodule add` / `absorbgitdirs` produce: the git dir lives in
    // the superproject's .git/modules, `.git` is a relative pointer, and the gitdir records
    // a relative core.worktree back to the checkout.
    const modules = join(root, '.git/modules');
    mkdirSync(modules, { recursive: true });
    renameSync(join(sub, '.git'), join(modules, 'sub'));
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n');
    execFileSync('git', ['--git-dir', join(modules, 'sub'), 'config', 'core.worktree', '../../../libs/sub']);
    expect(readFileSync(join(sub, '.git'), 'utf8')).toMatch(/^gitdir:/);
    expect(git(sub, 'config', 'core.worktree')).not.toBe('');
    expect(await readHeadCommitFromFiles(sub)).toBe(git(sub, 'rev-parse', 'HEAD'));
  });
});

describe('fingerprintRepoFileSetAtCommit', () => {
  it('retains a full fixture corpus larger than 8MiB while every blob batch stays within 8MiB', async () => {
    const fixturePaths = ['src/fixture-a.sql', 'src/fixture-b.sql', 'src/fixture-c.sql'];
    fixturePaths.forEach((path, index) => writeFileSync(join(root, path), Buffer.alloc(3 * 1024 * 1024, index + 1)));
    git(root, 'add', 'src');
    git(root, 'commit', '-q', '-m', 'large calibration corpus');
    const commit = git(root, 'rev-parse', 'HEAD');
    const batchBytes: number[] = [];
    const readBlobs = vi.fn<BlobBatchReader>(async (dir, ids) => {
      const blobs = await defaultBlobBatchReader(dir, ids);
      batchBytes.push([...blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0));
      return blobs;
    });
    // Source/test admission still refuses before any payload is read.
    await expect(fingerprintRepoFileSetAtCommit(root, commit, fixturePaths, { readBlobs }))
      .rejects.toThrow(/repo_measurement_too_large/);
    expect(readBlobs).not.toHaveBeenCalled();
    const measured = await fingerprintRepoFileSetAtCommit(root, commit, fixturePaths, { readBlobs }, REPO_FIXTURE_READ_LIMITS);
    expect(measured.files.map(file => file.path)).toEqual(fixturePaths);
    expect(measured.fingerprint).toBe(expectedFingerprint(fixturePaths.map(path => ({ path, sha256: sha256(path) }))));
    expect(batchBytes).toHaveLength(2);
    expect(Math.max(...batchBytes)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(batchBytes.reduce((sum, bytes) => sum + bytes, 0)).toBe(9 * 1024 * 1024);
    // Admission is also checked when every content digest is already memoized.
    await expect(fingerprintRepoFileSetAtCommit(root, commit, fixturePaths, { readBlobs }))
      .rejects.toThrow(/repo_measurement_too_large/);
    expect(readBlobs).toHaveBeenCalledTimes(2);
  });

  it.each(['aggregate', 'individual'] as const)('refuses an oversized %s fixture from tree sizes before reading blobs', async (kind) => {
    const fixturePaths = Array.from({ length: kind === 'aggregate' ? 9 : 1 }, (_, i) => `src/oversized-${i}.sql`);
    const size = 8 * 1024 * 1024 + (kind === 'individual' ? 1 : 0);
    const readBlobs = vi.fn<BlobBatchReader>();
    const gitWithSizes: GitRunner = async (dir, args) => args[0] === 'ls-tree' && args.includes('-l')
      ? fixturePaths.map((path, i) => `100644 blob ${String(i + 1).padStart(40, '0')} ${size}\t${path}\0`).join('')
      : defaultGitRunner(dir, args);
    await expect(fingerprintRepoFileSetAtCommit(root, git(root, 'rev-parse', 'HEAD'), fixturePaths,
      { git: gitWithSizes, readBlobs }, REPO_FIXTURE_READ_LIMITS)).rejects.toThrow(/repo_measurement_too_large/);
    expect(readBlobs).not.toHaveBeenCalled();
  });

  it('produces the unchanged sha256-file-set-v1 fingerprint of a clean tree, superproject and submodule alike', async () => {
    const commit = git(root, 'rev-parse', 'HEAD');
    const measured = await fingerprintRepoFileSetAtCommit(root, commit, paths);
    expect(measured.fingerprint).toBe(
      expectedFingerprint(paths.map((path) => ({ path, sha256: sha256(path) }))),
    );
    expect(measured.files.find((file) => file.path === 'libs/sub/sql/001.sql')?.gitBlob).toBe(
      git(sub, 'rev-parse', 'HEAD:sql/001.sql'),
    );
  });

  it('ignores uncommitted edits to measured files in both repositories', async () => {
    const commit = git(root, 'rev-parse', 'HEAD');
    const before = await fingerprintRepoFileSetAtCommit(root, commit, paths);
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2; // peer edit, not committed\n');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 2;\n');
    const after = await fingerprintRepoFileSetAtCommit(root, commit, paths);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('sees a committed submodule change only once the superproject records the new gitlink', async () => {
    const original = git(root, 'rev-parse', 'HEAD');
    const before = await fingerprintRepoFileSetAtCommit(root, original, paths);

    writeFileSync(join(sub, 'sql/001.sql'), 'select 2;\n');
    git(sub, 'commit', '-q', '-am', 'sub change');
    // Committed inside the submodule, but the superproject still pins the old gitlink.
    expect((await fingerprintRepoFileSetAtCommit(root, original, paths)).fingerprint).toBe(before.fingerprint);

    git(root, 'add', 'libs/sub');
    git(root, 'commit', '-q', '-m', 'bump sub');
    const bumped = git(root, 'rev-parse', 'HEAD');
    const after = await fingerprintRepoFileSetAtCommit(root, bumped, paths);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.files.find((file) => file.path === 'libs/sub/sql/001.sql')?.sha256).toBe(sha256('libs/sub/sql/001.sql'));
    // The older commit still measures the older bytes: the reader is pinned to its commit.
    expect((await fingerprintRepoFileSetAtCommit(root, original, paths)).fingerprint).toBe(before.fingerprint);
  });

  it('refuses a path that is absent at the commit even when it exists in the working tree', async () => {
    writeFileSync(join(root, 'src/new.ts'), 'export {};\n');
    const commit = git(root, 'rev-parse', 'HEAD');
    await expect(fingerprintRepoFileSetAtCommit(root, commit, ['src/new.ts'])).rejects.toThrow(
      /^repo_measurement_absent_at_commit:src\/new\.ts@/,
    );
    expect((await readCommittedFiles(root, commit, ['src/new.ts'])).get('src/new.ts')).toBeNull();
  });

  it('refuses paths that escape the measurement root and paths that are not files', async () => {
    const commit = git(root, 'rev-parse', 'HEAD');
    await expect(fingerprintRepoFileSetAtCommit(root, commit, ['../outside.ts'])).rejects.toThrow(
      'repo_measurement_path_outside_root:../outside.ts',
    );
    await expect(fingerprintRepoFileSetAtCommit(root, commit, ['src'])).rejects.toThrow('repo_measurement_not_file:src');
  });
});

describe('batched reads', () => {
  it('records a bounded spawn-boundary trace with request identity, caller PID, and route', async () => {
    const commit = git(root, 'rev-parse', 'HEAD');
    const diagnostics = createCommittedTreeDiagnostics({
      requestTraceId: 'trace-plans-get-spec-evidence',
      toolName: 'plans:get-spec-evidence',
    });
    for (let index = 0; index < 10; index += 1) {
      __resetCommittedBlobDigestsForTest();
      await readCommittedFiles(root, commit, ['src/a.ts'], { diagnostics });
    }

    expect(diagnostics.spawnBoundaryRecords).toHaveLength(8);
    expect(diagnostics.spawnBoundaryRecordsDropped).toBe(2);
    expect(diagnostics.spawnBoundaryRecords?.[0]).toEqual({
      requestTraceId: 'trace-plans-get-spec-evidence',
      toolName: 'plans:get-spec-evidence',
      pid: process.pid,
      route: 'local',
    });
  });

  it('counts unique repository/blob lookups, including aliases and repeated reads', async () => {
    const content = readFileSync(join(root, 'src/a.ts'));
    writeFileSync(join(root, 'src/alias.ts'), content);
    writeFileSync(join(sub, 'sql/001.sql'), content);
    git(sub, 'commit', '-q', '-am', 'shared blob in nested repository');
    git(root, 'add', 'src/alias.ts', 'libs/sub');
    git(root, 'commit', '-q', '-m', 'blob aliases');
    const commit = git(root, 'rev-parse', 'HEAD');
    const diagnostics = createCommittedTreeDiagnostics();
    await readCommittedFiles(root, commit, [...paths, 'src/alias.ts', 'src/a.ts'], { diagnostics });
    expect(diagnostics).toEqual({ schemaVersion: 'committed-tree-diagnostics-v1', reads: 1,
      memoHits: 0, memoMisses: 2, batchAttempts: 2, batchSucceeded: 2, batchFailed: 0,
      blobsRequested: 2, blobsReturned: 2, blobsVerified: 2,
      batchRoutes: { sidecar: 0, local: 2, injected: 0 } });
    await readCommittedFiles(root, commit, [...paths, 'src/alias.ts'], { diagnostics });
    expect(diagnostics).toMatchObject({ reads: 2, memoHits: 2, memoMisses: 2, batchAttempts: 2 });
  });

  it.each(['missing', 'mismatch', 'throw'] as const)('counts an injected %s failure without claiming success', async (failure) => {
    const diagnostics = createCommittedTreeDiagnostics();
    const error = new Error('original injected failure');
    const readBlobs: BlobBatchReader = async (_dir, ids) => {
      if (failure === 'throw') throw error;
      return failure === 'missing' ? new Map() : new Map([[ids[0]!, Buffer.from('wrong bytes')]]);
    };
    const result = readCommittedFiles(root, git(root, 'rev-parse', 'HEAD'), ['src/a.ts'], { diagnostics, readBlobs });
    if (failure === 'throw') await expect(result).rejects.toBe(error);
    else await expect(result).rejects.toThrow(`repo_measurement_blob_${failure}`);
    expect(diagnostics).toEqual({ schemaVersion: 'committed-tree-diagnostics-v1', reads: 1,
      memoHits: 0, memoMisses: 1, batchAttempts: 1, batchSucceeded: 0, batchFailed: 1,
      blobsRequested: 1, blobsReturned: failure === 'mismatch' ? 1 : 0, blobsVerified: 0,
      batchRoutes: { sidecar: 0, local: 0, injected: 1 } });
  });

  function counting() {
    const calls: string[][] = [];
    let blobBatches = 0;
    const gitRunner: GitRunner = (cwd, args) => {
      calls.push([...args]);
      return defaultGitRunner(cwd, args);
    };
    const readBlobs: BlobBatchReader = (dir, ids) => {
      blobBatches += 1;
      return defaultBlobBatchReader(dir, ids);
    };
    return { calls, gitRunner, readBlobs, batches: () => blobBatches };
  }

  it('spawns the same number of git processes for 2 files and for 22 files across both repositories', async () => {
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(root, `src/f${index}.ts`), `export const f${index} = ${index};\n`);
      writeFileSync(join(sub, `sql/1${index}.sql`), `select ${index};\n`);
    }
    git(sub, 'add', '.');
    git(sub, 'commit', '-q', '-m', 'more sql');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'more files');
    const commit = git(root, 'rev-parse', 'HEAD');
    const many = [
      ...paths,
      ...Array.from({ length: 10 }, (_, index) => `src/f${index}.ts`),
      ...Array.from({ length: 10 }, (_, index) => `libs/sub/sql/1${index}.sql`),
    ];

    const small = counting();
    await fingerprintRepoFileSetAtCommit(root, commit, paths, { git: small.gitRunner, readBlobs: small.readBlobs });
    __resetCommittedBlobDigestsForTest();
    const large = counting();
    await fingerprintRepoFileSetAtCommit(root, commit, many, { git: large.gitRunner, readBlobs: large.readBlobs });

    expect(large.calls.length).toBe(small.calls.length);
    expect(large.batches()).toBe(small.batches());
    // Two repositories: one gitlink lookup + one ls-tree each, one cat-file batch each.
    expect(large.calls.length).toBeLessThanOrEqual(3);
    expect(large.batches()).toBeLessThanOrEqual(2);
  });

  it('reads no blob contents again for blobs it has already digested', async () => {
    const commit = git(root, 'rev-parse', 'HEAD');
    const first = counting();
    await fingerprintRepoFileSetAtCommit(root, commit, paths, { git: first.gitRunner, readBlobs: first.readBlobs });
    const second = counting();
    await fingerprintRepoFileSetAtCommit(root, commit, paths, { git: second.gitRunner, readBlobs: second.readBlobs });
    expect(first.batches()).toBe(2);
    expect(second.batches()).toBe(0);
  });
});

describe('listCommittedGlobMatches', () => {
  it('expands globs over committed files only, descending into the submodule at its gitlink', async () => {
    writeFileSync(join(root, 'src/uncommitted.ts'), 'export {};\n');
    const commit = git(root, 'rev-parse', 'HEAD');
    const matches = await listCommittedGlobMatches(root, commit, ['src/**/*.ts', 'libs/sub/sql/*.sql'], {
      maxMatches: 128,
      maxDepth: 16,
    });
    expect(matches).toEqual(['libs/sub/sql/001.sql', 'src/a.ts']);
  });

  it('refuses more matches than the bound', async () => {
    const commit = git(root, 'rev-parse', 'HEAD');
    await expect(
      listCommittedGlobMatches(root, commit, ['**/*'], { maxMatches: 1, maxDepth: 16 }),
    ).rejects.toThrow(/^repo_measurement_too_many_glob_files:2>1/);
  });

  it('matches exactly what the working-tree fast-glob expansion lists on a clean checkout, depth bound included', async () => {
    // Deeper fixture in both repositories, all committed, so the working tree equals the commit.
    for (const file of ['top.ts', 'src/x/one.ts', 'src/x/y/two.ts', 'src/x/y/z/three.ts']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), `// ${file}\n`);
    }
    mkdirSync(join(sub, 'sql/deep/er'), { recursive: true });
    writeFileSync(join(sub, 'sql/deep/er/002.sql'), 'select 2;\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-q', '-m', 'deep sql');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'deep files');
    const commit = git(root, 'rev-parse', 'HEAD');
    const fastGlobAt = (globs: string[], deep: number) =>
      fastGlob
        .sync(globs, { cwd: root, absolute: false, dot: true, onlyFiles: true, followSymbolicLinks: false, unique: true, deep })
        .sort();
    // Calibration: the bound must actually exclude files here, or parity below is vacuous.
    expect(fastGlobAt(['**/*.ts'], 1)).toEqual(['top.ts']);
    // Merged-at-root grouping: as a task of its own, src/x/** (base src/x) would list
    // src/x/one.ts at deep 2; merged with a root-based pattern it counts from the root.
    expect(fastGlobAt(['**/a.ts', 'src/x/**/*.ts'], 2)).toEqual(['src/a.ts']);
    expect(fastGlobAt(['src/x/**/*.ts'], 2)).toEqual(['src/x/one.ts', 'src/x/y/two.ts']);

    const globSets = [
      ['**/*.ts'],
      ['src/**/*.ts'],
      ['src/x/*.ts'],
      ['**/a.ts', 'src/x/**/*.ts'],
      ['src/**/*.ts', 'libs/sub/**/*.sql'],
      ['libs/**/*.sql'],
      ['src/a.ts', 'src/x/y/z/three.ts'],
    ];
    for (const globs of globSets) {
      for (const deep of [0, 1, 2, 3, 16]) {
        const committed = await listCommittedGlobMatches(root, commit, globs, { maxMatches: 128, maxDepth: deep });
        expect({ globs, deep, matches: committed }).toEqual({ globs, deep, matches: fastGlobAt(globs, deep) });
      }
    }
  });
});

describe('parseCatFileBatch', () => {
  it('keeps binary content containing newlines intact and skips missing objects', () => {
    const content = Buffer.from([0x00, 0x0a, 0xff, 0x0a, 0x41]);
    const output = Buffer.concat([
      Buffer.from(`${'a'.repeat(40)} blob ${content.length}\n`),
      content,
      Buffer.from('\n'),
      Buffer.from(`${'b'.repeat(40)} missing\n`),
    ]);
    const parsed = parseCatFileBatch(output);
    expect(parsed.get('a'.repeat(40))?.equals(content)).toBe(true);
    expect(parsed.has('b'.repeat(40))).toBe(false);
  });
});

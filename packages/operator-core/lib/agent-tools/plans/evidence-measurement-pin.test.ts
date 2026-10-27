/**
 * P-018 (review-system-rework-reduction-2026-09-23): a repo-files proof is pinned to the
 * commit(s) it was measured at, and a stale verdict names exactly which measured files moved
 * and which commits moved them — INSIDE the owning submodule, where a superproject-relative
 * `git log` is always empty.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The measure path calls refuseMutationProbePaths, which reads the LIVE lock-store queue from
// shared Postgres. This suite is about the git pin, so the lock store is stubbed; the refusal
// itself is covered by spec-evidence-store-mutation-probe.test.ts. Left live, one slow shared-PG
// read cancels every case here with "statement timeout" (gate red at repair head 7652f8c9,
// 2026-09-30, WI-10004029).
vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(async () => ({ active_locks: [], waiting: [], completed: [] })),
}));

import { gitReadMemoStats } from '../../sync-exec-replay';
import {
  buildMeasurementPin,
  defaultGitRunner,
  diffMeasuredFiles,
  explainMovedPaths,
  gitBlobId,
  owningRepo,
  readMeasurementPin,
  MEASUREMENT_PIN_DETAILS_KEY,
} from './evidence-measurement-pin';
import {
  measureAndPinRepoFilesEvidenceAtRoot,
  measureRepoFilesEvidenceAtRoot,
  measureRepoFilesEvidenceDetailedAtRoot,
  measureRepoFilesEvidenceDetailedAtCommit,
  repoFilesEvidenceMeasurementSchema,
  specEvidenceBindingFingerprint,
} from './spec-evidence-store';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

let root: string;

/** Superproject with `src/a.ts` and a NESTED repository `libs/sub` recorded as a gitlink. */
function makeTree() {
  root = mkdtempSync(join(tmpdir(), 'measurement-pin-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  const sub = join(root, 'libs/sub');
  mkdirSync(join(sub, 'sql'), { recursive: true });
  git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(join(sub, 'sql/001.sql'), 'select 1;\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'sub init');
  git(root, 'add', 'src/a.ts', 'libs/sub');
  git(root, 'commit', '-q', '-m', 'root init');
}

beforeEach(makeTree);
afterEach(() => rmSync(root, { recursive: true, force: true }));

const recipe = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['src/a.ts', 'libs/sub/sql/001.sql'],
};

describe('defaultGitRunner (EI-24852529885337741)', () => {
  it('returns stdout on success and throws a Command failed error naming the argv otherwise', async () => {
    const head = git(root, 'rev-parse', 'HEAD');
    expect((await defaultGitRunner(root, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    await expect(defaultGitRunner(root, ['rev-parse', '--verify', '--quiet', `${'0'.repeat(40)}:missing.ts`])).rejects.toThrow(
      /^Command failed \(exit 1\): git -C .* rev-parse --verify --quiet 0{40}:missing\.ts/,
    );
  });

  it('keeps missing-executable evidence in the first line recorded by measurement callers', async () => {
    vi.stubEnv('PATH', join(root, 'no-executables'));
    try {
      await expect(defaultGitRunner(root, ['ls-tree', '0'.repeat(40), '--', 'missing.ts'])).rejects.toThrow(
        /^Command failed \([^\n]*code=ENOENT[^\n]*signal=none[^\n]*killed=false[^\n]*\): git /,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('WI-6554700010029986: a missing working directory fails exactly like git, without starting git', async () => {
    const missing = join(root, 'deleted-disposable-clone');
    const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const gitShape = new RegExp(
      `^Command failed \\(exit 128\\): git -C ${missing} ${args.join(' ')}\\nfatal: cannot change to '${missing}': No such file or directory`,
    );
    // Real git, for reference: the synthesized error must match what the child would have said.
    let realStderr = '';
    try {
      execFileSync('git', ['-C', missing, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      realStderr = String((error as { stderr?: Buffer }).stderr ?? '');
    }
    expect(realStderr).toContain(`fatal: cannot change to '${missing}': No such file or directory`);
    // With no git on PATH, a spawn would fail as code=ENOENT/no exit status instead; exit 128
    // here proves the runner answered without starting a child.
    vi.stubEnv('PATH', join(root, 'no-executables'));
    try {
      await expect(defaultGitRunner(missing, args)).rejects.toThrow(gitShape);
    } finally {
      vi.unstubAllEnvs();
    }
    // An existing directory still reaches git.
    await expect(defaultGitRunner(root, ['rev-parse', '--show-toplevel'])).resolves.toContain(root.split('/').pop()!);
  });

  it('shares one child between concurrent identical content-addressed reads', async () => {
    const head = git(root, 'rev-parse', 'HEAD');
    const args = ['rev-parse', '--verify', '--quiet', `${head}:src/a.ts`];
    const before = gitReadMemoStats();
    const [a, b] = await Promise.all([defaultGitRunner(root, args), defaultGitRunner(root, args)]);
    const after = gitReadMemoStats();
    expect(a).toBe(b);
    expect(a.trim()).toBe(git(root, 'rev-parse', `${head}:src/a.ts`));
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
  });

  it('never shares a HEAD-relative read, so a commit made in between is seen at once', async () => {
    const before = gitReadMemoStats();
    const first = (await defaultGitRunner(root, ['rev-parse', 'HEAD'])).trim();
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'move HEAD');
    const second = (await defaultGitRunner(root, ['rev-parse', 'HEAD'])).trim();
    expect(second).not.toBe(first);
    expect(second).toBe(git(root, 'rev-parse', 'HEAD'));
    const after = gitReadMemoStats();
    expect(after.misses - before.misses).toBe(0);
    expect(after.hits - before.hits).toBe(0);
  });
});

describe('evidence measurement pin (P-018)', () => {
  it('rejects a fixture root selector without calibration paths', () => {
    expect(repoFilesEvidenceMeasurementSchema.safeParse({
      schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/a.ts'],
      fixtureRootHarnessSlug: 'server',
    }).success).toBe(false);
  });

  it('pins same-path files from distinct roots and detects only a changed calibration source', async () => {
    const fixtureRoot = join(root, 'calibration');
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
    git(fixtureRoot, 'init', '-q', '-b', 'main');
    writeFileSync(join(fixtureRoot, 'src/a.ts'), 'export const status = null;\n');
    git(fixtureRoot, 'add', '.');
    git(fixtureRoot, 'commit', '-q', '-m', 'calibration');
    const measurement = {
      schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/a.ts'], testPaths: ['src/a.ts'],
      fixturePaths: ['src/a.ts'], fixtureRootHarnessSlug: 'server',
    };
    await expect(measureRepoFilesEvidenceDetailedAtRoot(root, measurement))
      .rejects.toThrow('repo_measurement_fixture_root_required:server');
    const before = await measureAndPinRepoFilesEvidenceAtRoot(root, measurement, { fixtureRoot });
    expect(before.sourceFingerprint).not.toBe(before.fixtureFingerprint);
    expect(before.pin.files).toHaveLength(3);
    expect(before.pin.files.find((file) => file.dimension === 'fixture'))
      .toMatchObject({ path: 'src/a.ts', rootHarnessSlug: 'server', clean: true });
    expect(before.pin.repos).toContainEqual({
      repo: '.', rootHarnessSlug: 'server', head: git(fixtureRoot, 'rev-parse', 'HEAD'), gitlink: null,
    });
    writeFileSync(join(fixtureRoot, 'src/a.ts'), 'export const status = "ready";\n');
    const after = await measureRepoFilesEvidenceDetailedAtRoot(root, measurement, { fixtureRoot });
    expect(after.sourceFingerprint).toBe(before.sourceFingerprint);
    expect(after.testFingerprint).toBe(before.testFingerprint);
    expect(after.fixtureFingerprint).not.toBe(before.fixtureFingerprint);
    expect(diffMeasuredFiles(before.pin, after.files)).toEqual({
      pinned: true,
      moved: [{ path: 'src/a.ts', dimension: 'fixture', rootHarnessSlug: 'server', change: 'changed' }],
    });
  });

  it('reads the product and calibration from independently pinned commits', async () => {
    const fixtureRoot = join(root, 'calibration');
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
    git(fixtureRoot, 'init', '-q', '-b', 'main');
    writeFileSync(join(fixtureRoot, 'src/a.ts'), 'export const status = null;\n');
    git(fixtureRoot, 'add', '.');
    git(fixtureRoot, 'commit', '-q', '-m', 'calibration');
    const measurement = {
      schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/a.ts'], fixturePaths: ['src/a.ts'], fixtureRootHarnessSlug: 'server',
    };
    const productCommit = git(root, 'rev-parse', 'HEAD');
    const fixtureCommit = git(fixtureRoot, 'rev-parse', 'HEAD');
    const options = { fixtureRoot, fixtureCommit };
    const before = await measureRepoFilesEvidenceDetailedAtCommit(root, measurement, productCommit, options);
    writeFileSync(join(root, 'src/a.ts'), 'uncommitted product\n');
    writeFileSync(join(fixtureRoot, 'src/a.ts'), 'export const status = "ready";\n');
    git(fixtureRoot, 'commit', '-q', '-am', 'change calibration');
    const pinned = await measureRepoFilesEvidenceDetailedAtCommit(root, measurement, productCommit, options);
    expect(pinned).toEqual(before);
    const advanced = await measureRepoFilesEvidenceDetailedAtCommit(root, measurement, productCommit, {
      fixtureRoot, fixtureCommit: git(fixtureRoot, 'rev-parse', 'HEAD'),
    });
    expect(advanced.sourceFingerprint).toBe(before.sourceFingerprint);
    expect(advanced.fixtureFingerprint).not.toBe(before.fixtureFingerprint);
  });

  it('computes the same blob id as git hash-object', () => {
    const content = readFileSync(join(root, 'src/a.ts'));
    expect(gitBlobId(content)).toBe(git(root, 'hash-object', 'src/a.ts'));
  });

  it('attributes a path to the innermost repository that owns it', async () => {
    expect(await owningRepo(root, 'libs/sub/sql/001.sql')).toBe('libs/sub');
    expect(await owningRepo(root, 'src/a.ts')).toBe('.');
  });

  it('keeps the existing file-set fingerprint byte-identical', async () => {
    const detailed = await measureRepoFilesEvidenceDetailedAtRoot(root, recipe);
    const plain = await measureRepoFilesEvidenceAtRoot(root, recipe);
    expect(detailed.sourceFingerprint).toBe(plain.sourceFingerprint);
    expect(detailed.files.map((file) => file.path)).toEqual(['libs/sub/sql/001.sql', 'src/a.ts']);
  });

  it('pins each file to its owning repo HEAD and resolves the submodule gitlink', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    const subHead = git(join(root, 'libs/sub'), 'rev-parse', 'HEAD');
    expect(pin.repos).toEqual([
      { repo: '.', head: git(root, 'rev-parse', 'HEAD'), gitlink: null },
      { repo: 'libs/sub', head: subHead, gitlink: subHead },
    ]);
    const sql = pin.files.find((file) => file.path === 'libs/sub/sql/001.sql')!;
    expect(sql).toMatchObject({ repo: 'libs/sub', clean: true, headBlob: git(join(root, 'libs/sub'), 'rev-parse', 'HEAD:sql/001.sql') });
    expect(pin.errors).toBeUndefined();
  });

  it('records an uncommitted edit as not clean rather than pinning it to HEAD', async () => {
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    expect(pin.files.find((file) => file.path === 'src/a.ts')!.clean).toBe(false);
  });

  it('never throws when git is unavailable: the failure is recorded inside the pin', async () => {
    const files = (await measureRepoFilesEvidenceDetailedAtRoot(root, recipe)).files;
    const pin = await buildMeasurementPin(root, files, {
      git: async () => {
        throw new Error('git exploded');
      },
    });
    expect(pin.repos.every((repo) => repo.head === null)).toBe(true);
    expect(pin.files.every((file) => file.clean === null)).toBe(true);
    expect(pin.errors?.some((error) => error.includes('git exploded'))).toBe(true);
  });

  it('names exactly the moved paths, and says unpinned instead of an empty list', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    writeFileSync(join(root, 'libs/sub/sql/001.sql'), 'select 2;\n');
    const now = (await measureRepoFilesEvidenceDetailedAtRoot(root, recipe)).files;
    expect(diffMeasuredFiles(pin, now)).toEqual({
      pinned: true,
      moved: [{ path: 'libs/sub/sql/001.sql', dimension: 'source', change: 'changed' }],
    });
    expect(diffMeasuredFiles(null, now)).toEqual({ pinned: false });
    const widened = [...now, { path: 'src/b.ts', dimension: 'test' as const, sha256: 'x', gitBlob: 'y' }];
    const moved = diffMeasuredFiles(pin, widened.filter((file) => file.path !== 'src/a.ts'));
    expect(moved.pinned && moved.moved.map((entry) => `${entry.path}:${entry.change}`)).toEqual([
      'libs/sub/sql/001.sql:changed',
      'src/a.ts:removed',
      'src/b.ts:added',
    ]);
  });

  it('attributes a committed peer change to its commit INSIDE the submodule, and flags in-flight edits', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    const sub = join(root, 'libs/sub');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 3;\n');
    git(sub, 'commit', '-q', '-am', 'peer rewrites migration');
    const peerCommit = git(sub, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 9;\n');
    const now = (await measureRepoFilesEvidenceDetailedAtRoot(root, recipe)).files;
    const diff = diffMeasuredFiles(pin, now);
    if (!diff.pinned) throw new Error('expected a pinned diff');
    const explained = await explainMovedPaths(root, pin, diff.moved, new Map(now.map((file) => [file.path, file])));
    const sql = explained.find((entry) => entry.path === 'libs/sub/sql/001.sql')!;
    expect(sql.repo).toBe('libs/sub');
    expect(sql.commits.map((commit) => commit.sha)).toEqual([peerCommit]);
    expect(sql.commits[0]!.subject).toBe('peer rewrites migration');
    expect(sql.uncommitted).toBe(false);
    const src = explained.find((entry) => entry.path === 'src/a.ts')!;
    expect(src.commits).toEqual([]);
    expect(src.uncommitted).toBe(true);
  });

  it('round-trips through binding details and is excluded from the binding fingerprint', async () => {
    const { pin } = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    expect(readMeasurementPin({ [MEASUREMENT_PIN_DETAILS_KEY]: pin })).toEqual(pin);
    expect(readMeasurementPin({ [MEASUREMENT_PIN_DETAILS_KEY]: { schemaVersion: 2 } })).toBeNull();
    const base = {
      workspaceId: 'ws', harnessSlug: 'h', workItemId: 'WI-1', planSlug: 'p', specId: 'S-1', specRevision: 1,
      specFingerprint: 'f', evidenceKind: 'test' as const, evidenceRef: 'r', sourceFingerprint: 's',
      testFingerprint: null, fixtureFingerprint: null, rubricFingerprint: null, environmentFingerprint: null,
      coverageEvidenceRef: null, testRunId: null,
    };
    const without = specEvidenceBindingFingerprint({ ...base, details: { currentMeasurement: recipe } });
    const withPin = specEvidenceBindingFingerprint({ ...base, details: { currentMeasurement: recipe, [MEASUREMENT_PIN_DETAILS_KEY]: pin } });
    const otherHead = specEvidenceBindingFingerprint({
      ...base,
      details: { currentMeasurement: recipe, [MEASUREMENT_PIN_DETAILS_KEY]: { ...pin, repos: [] } },
    });
    expect(withPin).toBe(without);
    expect(otherHead).toBe(without);
    // Control: the fingerprint still moves when real proof metadata moves.
    expect(specEvidenceBindingFingerprint({ ...base, details: { currentMeasurement: { ...recipe, sourcePaths: ['src/a.ts'] } } })).not.toBe(without);
  });
});

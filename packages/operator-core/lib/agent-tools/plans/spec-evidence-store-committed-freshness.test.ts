/**
 * listSpecEvidence judges repo-files proof against ONE measurement commit M per measurement
 * root (proof-freshness-pinned-candidate-2026-10-06 P-002/P-004, decision D-001; BARs R-1, R-2).
 *
 * R-1: an uncommitted working-tree edit to a closure file never stales a binding.
 * R-2: a committed closure change (superproject or submodule) still reads source-stale and
 *      names the moved path; a binding stored before this change, against unchanged bytes,
 *      still reads current; every binding under one root in one call reports the same M.
 *
 * Every case runs against a real temporary superproject with a nested repository recorded
 * as a gitlink. The DB, harness registry and lock queue are the only seams mocked.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real fixture Git stays local, independent of the operator's shared sidecar.
vi.mock('../../fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/git-via-sidecar')>()),
  gitSidecarEnabled: () => false,
}));

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  measurementRoot: '',
  lockReads: 0,
  resolveCalls: [] as string[],
  // Runs once, right after the measurement commit is resolved: a commit landing mid-call.
  afterResolve: null as null | (() => void),
}));

vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(async () => {
    h.lockReads += 1;
    return { active_locks: [], waiting: [], completed: [] };
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[]) =>
        Promise.resolve(Array.from(strings).join(' ').includes('provisional') ? [] : h.rows)) as unknown;
      return fn(tx);
    },
  };
});

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return { ...actual, resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }) };
});

vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return { ...actual, loadHarnessRegistry: async () => ({}) as never, resolveHarnessContentPath: () => h.measurementRoot };
});

vi.mock('./committed-tree-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./committed-tree-reader')>();
  return {
    ...actual,
    resolveMeasurementCommit: async (root: string, ...rest: unknown[]) => {
      h.resolveCalls.push(root);
      const commit = await actual.resolveMeasurementCommit(root, ...(rest as []));
      const hook = h.afterResolve;
      h.afterResolve = null;
      hook?.();
      return commit;
    },
  };
});

const {
  listSpecEvidence,
  measureAndPinRepoFilesEvidenceAtRoot,
  measureAndPinRepoFilesEvidenceAtCommitForScope,
  MEASUREMENT_PIN_DETAILS_KEY,
} = await import('./spec-evidence-store');
const { createCommittedTreeDiagnostics } = await import('./committed-tree-reader');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

let root: string;
let sub: string;

/** The sha256-file-set-v1 formula over CURRENT file bytes, re-stated independently of the code under test. */
function fileSetFingerprint(base: string, paths: string[]): string {
  const entries = [...new Set(paths)].sort().map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(join(base, path))).digest('hex'),
  }));
  return `sha256-file-set-v1:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}

type Recipe = { schemaVersion: 1; kind: 'repo-files'; sourcePaths: string[] };

/** The same formula over the bytes COMMITTED at `commit` in the repository at `repoDir`. */
function fileSetFingerprintAtCommit(repoDir: string, commit: string, paths: Array<{ path: string; inRepo: string }>): string {
  const entries = [...paths]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, inRepo }) => ({
      path,
      sha256: createHash('sha256').update(execFileSync('git', ['-C', repoDir, 'show', `${commit}:${inRepo}`])).digest('hex'),
    }));
  return `sha256-file-set-v1:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}

/** A binding stored now, against the CURRENT (clean) bytes, with its P-018 pin. */
async function storedBinding(
  id: number,
  sourcePaths: string[],
  measured?: { sourceFingerprint: string; pin: unknown },
): Promise<Record<string, unknown>> {
  const recipe: Recipe = { schemaVersion: 1, kind: 'repo-files', sourcePaths };
  const pin = measured?.pin ?? (await measureAndPinRepoFilesEvidenceAtRoot(root, recipe)).pin;
  const sourceFingerprint = measured?.sourceFingerprint ?? fileSetFingerprint(root, sourcePaths);
  return {
    id,
    work_item_id: `WI-${id}`,
    plan_slug: 'plan-one',
    spec_id: `SPEC-001-0${id}`,
    source_val_id: `VAL-001-0${id}`,
    spec_revision: 1,
    current_revision: 1,
    spec_fingerprint: 'sha256:spec-v1',
    evidence_kind: 'test',
    evidence_ref: `vitest:binding-${id}`,
    source_fingerprint: sourceFingerprint,
    test_fingerprint: null,
    fixture_fingerprint: null,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: null,
    coverage_evidence_present: false,
    test_run_id: null,
    test_run_present: false,
    details: { currentMeasurement: recipe, [MEASUREMENT_PIN_DETAILS_KEY]: pin },
    observed_at: '2026-10-06 18:00:00-04',
    binding_fingerprint: `sha256:binding-${id}`,
    created_by: 'su-test',
    created_at: '2026-10-06T22:00:01.000Z',
    spec_is_current: true,
  };
}

type Row = {
  currentness: { overall: string; staleReasons: string[] };
  serverMeasurement?: { status: string; measuredAtCommit?: string; movedPaths?: Array<{ path: string; change: string }> };
};
const list = async () =>
  (await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] })) as unknown as Row[];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-evidence-committed-')));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src/b.ts'), 'export const b = 1;\n');
  sub = join(root, 'libs/sub');
  mkdirSync(join(sub, 'sql'), { recursive: true });
  git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(join(sub, 'sql/001.sql'), 'select 1;\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'sub init');
  git(root, 'add', 'src', 'libs/sub');
  git(root, 'commit', '-q', '-m', 'root init');
  h.measurementRoot = root;
  h.rows = [await storedBinding(1, ['src/a.ts']), await storedBinding(2, ['src/b.ts', 'libs/sub/sql/001.sql'])];
  h.lockReads = 0;
  h.resolveCalls = [];
  h.afterResolve = null;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('listSpecEvidence measures repo-files proof at the measurement commit', () => {
  it('coalesces identical committed recipes within a request while retaining distinct recipes and fresh commits', async () => {
    const original = h.rows[0]!;
    h.rows = [original, { ...original, id: 3, work_item_id: 'WI-3' },
      { ...original, id: 4, work_item_id: 'WI-4' }, h.rows[1]!];
    const diagnostics = { phaseMs: {}, committedTree: createCommittedTreeDiagnostics(),
      bindings: { selectedRows: 0, rowsWithRecipe: 0, measured: 0, unavailable: 0, skipped: 0,
        totalMeasurementMs: 0, maxMeasurementMs: 0 } };
    const first = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'], diagnostics });
    expect(first).toHaveLength(4);
    expect(first.every((row) => row.currentness.overall === 'current')).toBe(true);
    expect(diagnostics.bindings.measured).toBe(4);
    expect(diagnostics.committedTree.reads).toBe(2);

    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'changed committed measurement');
    const second = await list();
    expect(second.slice(0, 3).every((row) => row.currentness.staleReasons.includes('source-stale'))).toBe(true);
    expect(second[3]?.currentness.overall).toBe('current');
    expect(first[0]?.serverMeasurement?.measuredAtCommit).not.toBe(second[0]?.serverMeasurement?.measuredAtCommit);
  });

  it('attributes real cold and warm committed measurements to separate request counters', async () => {
    // A fresh content address guarantees a miss without resetting the shared memo.
    writeFileSync(join(root, 'src/a.ts'), `export const nonce = '${randomBytes(32).toString('hex')}';\n`);
    git(root, 'commit', '-q', '-am', 'fresh diagnostic source');
    h.rows = [h.rows[0]!];
    const diagnostics = () => ({ phaseMs: {}, committedTree: createCommittedTreeDiagnostics(),
      bindings: { selectedRows: 0, rowsWithRecipe: 0, measured: 0, unavailable: 0, skipped: 0,
        totalMeasurementMs: 0, maxMeasurementMs: 0 } });
    const cold = diagnostics();
    const first = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'], diagnostics: cold });
    expect(cold.committedTree).toEqual({ schemaVersion: 'committed-tree-diagnostics-v1', reads: 1,
      memoHits: 0, memoMisses: 1, batchAttempts: 1, batchSucceeded: 1, batchFailed: 0,
      blobsRequested: 1, blobsReturned: 1, blobsVerified: 1,
      batchRoutes: { sidecar: 0, local: 1, injected: 0 } });
    const snapshot = structuredClone(cold.committedTree);
    const warm = diagnostics();
    const second = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'], diagnostics: warm });
    expect(warm.committedTree).toEqual({ ...createCommittedTreeDiagnostics(), reads: 1, memoHits: 1 });
    expect(cold.committedTree).toEqual(snapshot);
    expect(first[0]?.currentness).toEqual(second[0]?.currentness);
  });

  it('pins fixture SQL membership at the commit and names committed changes, additions, and removals', async () => {
    const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['src/a.ts'], fixtureGlobs: ['libs/sub/sql/*.sql'] };
    const measured = await measureAndPinRepoFilesEvidenceAtRoot(root, recipe);
    h.rows = [{ ...h.rows[0], source_fingerprint: measured.sourceFingerprint,
      fixture_fingerprint: measured.fixtureFingerprint,
      details: { currentMeasurement: recipe, [MEASUREMENT_PIN_DETAILS_KEY]: measured.pin } }];
    expect((await list())[0]?.currentness.overall).toBe('current');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 2;\n');
    writeFileSync(join(sub, 'sql/002.sql'), 'select 3;\n');
    // Uncommitted input changes cannot contaminate a committed snapshot.
    expect((await list())[0]?.currentness.overall).toBe('current');
    git(sub, 'add', 'sql');
    git(sub, 'commit', '-q', '-m', 'change fixture corpus');
    git(root, 'add', 'libs/sub');
    git(root, 'commit', '-q', '-m', 'pin changed fixture corpus');
    const changed = (await list())[0]!;
    expect(changed.currentness.overall).toBe('stale');
    expect(changed.serverMeasurement?.movedPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'libs/sub/sql/001.sql', dimension: 'fixture', change: 'changed' }),
      expect.objectContaining({ path: 'libs/sub/sql/002.sql', dimension: 'fixture', change: 'added' }),
    ]));
    git(sub, 'rm', 'sql/001.sql');
    git(sub, 'commit', '-q', '-m', 'remove fixture input');
    git(root, 'add', 'libs/sub');
    git(root, 'commit', '-q', '-m', 'pin removed fixture input');
    expect((await list())[0]?.serverMeasurement?.movedPaths).toContainEqual(
      expect.objectContaining({ path: 'libs/sub/sql/001.sql', dimension: 'fixture', change: 'removed' }));
  });

  it('reads a binding stored before this change, against unchanged bytes, as current at HEAD', async () => {
    const rows = await list();
    const head = git(root, 'rev-parse', 'HEAD');
    expect(rows.map((row) => row.currentness.overall)).toEqual(['current', 'current']);
    expect(rows.map((row) => row.serverMeasurement?.measuredAtCommit)).toEqual([head, head]);
    // Committed bytes cannot hold a probe mutant, so no lock-queue fence is read.
    expect(h.lockReads).toBe(0);
  });

  it('R-1: an uncommitted edit to a closure file, superproject or submodule, leaves every verdict current', async () => {
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2; // peer edit in flight\n');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 2; -- peer edit in flight\n');
    const rows = await list();
    expect(rows.map((row) => row.currentness.overall)).toEqual(['current', 'current']);
    expect(rows.flatMap((row) => row.currentness.staleReasons)).toEqual([]);
  });

  it('R-2: a committed superproject closure change reads source-stale and names the moved path', async () => {
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'change a');
    const [changed, untouched] = await list();
    expect(changed?.currentness.overall).toBe('stale');
    expect(changed?.currentness.staleReasons).toContain('source-stale');
    expect(changed?.serverMeasurement?.movedPaths).toEqual([{ path: 'src/a.ts', dimension: 'source', change: 'changed' }]);
    expect(untouched?.currentness.overall).toBe('current');
  });

  it('R-2: a committed submodule change reads stale once the superproject records the new gitlink', async () => {
    writeFileSync(join(sub, 'sql/001.sql'), 'select 2;\n');
    git(sub, 'commit', '-q', '-am', 'sub change');
    // M still records the old gitlink, so the committed submodule change is not yet in M.
    expect((await list())[1]?.currentness.overall).toBe('current');

    git(root, 'add', 'libs/sub');
    git(root, 'commit', '-q', '-m', 'bump sub');
    const [untouched, changed] = await list();
    expect(changed?.currentness.overall).toBe('stale');
    expect(changed?.serverMeasurement?.movedPaths).toEqual([
      { path: 'libs/sub/sql/001.sql', dimension: 'source', change: 'changed' },
    ]);
    expect(untouched?.currentness.overall).toBe('current');
  });

  it('R-2: resolves M once per root per call, so a commit landing mid-call changes no binding', async () => {
    const before = git(root, 'rev-parse', 'HEAD');
    h.rows = [...h.rows, await storedBinding(3, ['src/a.ts', 'src/b.ts'])];
    h.afterResolve = () => {
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 3;\n');
      git(root, 'commit', '-q', '-am', 'lands mid-call');
    };
    const rows = await list();
    expect(h.resolveCalls).toEqual([root]);
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(new Set(rows.map((row) => row.serverMeasurement?.measuredAtCommit))).toEqual(new Set([before]));
    expect(rows.map((row) => row.currentness.overall)).toEqual(['current', 'current', 'current']);
  });
});

describe('R-3: an as-committed bind measures the closure at the run commit (P-003)', () => {
  const recipe = (sourcePaths: string[]): Recipe => ({ schemaVersion: 1, kind: 'repo-files', sourcePaths });
  const atCommit = (sourcePaths: string[], at: { commitSha: string; repoPrefix: string | null }) =>
    measureAndPinRepoFilesEvidenceAtCommitForScope('workspace-test', 'papercusp', recipe(sourcePaths), at);

  it('stores the bytes the run executed after the tree moved past its commit, and a re-bind stores the same fingerprint', async () => {
    const ran = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'committed after the run');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3;\n'); // and an uncommitted peer edit on top

    const expected = fileSetFingerprintAtCommit(root, ran, [{ path: 'src/a.ts', inRepo: 'src/a.ts' }]);
    const first = await atCommit(['src/a.ts'], { commitSha: ran, repoPrefix: '' });
    expect(first.sourceFingerprint).toBe(expected);
    expect(first.sourceFingerprint).not.toBe(fileSetFingerprint(root, ['src/a.ts']));

    writeFileSync(join(root, 'src/a.ts'), 'export const a = 4;\n');
    const rebind = await atCommit(['src/a.ts'], { commitSha: ran, repoPrefix: '' });
    expect(rebind.sourceFingerprint).toBe(expected);
  });

  it('a re-bind does not launder freshness: a closure change committed after the run reads stale and names the path', async () => {
    const ran = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'closure change after the run');
    // Positive control first: a run whose closure the later commit did not touch reads current.
    h.rows = [
      await storedBinding(1, ['src/a.ts'], await atCommit(['src/a.ts'], { commitSha: ran, repoPrefix: '' })),
      await storedBinding(2, ['src/b.ts'], await atCommit(['src/b.ts'], { commitSha: ran, repoPrefix: '' })),
    ];
    const [rebound, untouched] = await list();
    expect(untouched?.currentness.overall).toBe('current');
    expect(rebound?.currentness.overall).toBe('stale');
    expect(rebound?.currentness.staleReasons).toContain('source-stale');
    expect(rebound?.serverMeasurement?.movedPaths).toEqual([{ path: 'src/a.ts', dimension: 'source', change: 'changed' }]);
  });

  it('reads a submodule run inside that repository at its own commit, and refuses a path outside it', async () => {
    const ran = git(sub, 'rev-parse', 'HEAD');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 2;\n');
    git(sub, 'commit', '-q', '-am', 'sub change after the run');
    writeFileSync(join(sub, 'sql/001.sql'), 'select 3;\n');

    const measured = await atCommit(['libs/sub/sql/001.sql'], { commitSha: ran, repoPrefix: 'libs/sub' });
    expect(measured.sourceFingerprint).toBe(
      fileSetFingerprintAtCommit(sub, ran, [{ path: 'libs/sub/sql/001.sql', inRepo: 'sql/001.sql' }]),
    );
    await expect(atCommit(['src/a.ts'], { commitSha: ran, repoPrefix: 'libs/sub' })).rejects.toThrow(
      'repo_measurement_outside_run_repository:src/a.ts',
    );
  });

  it('refuses a closure path that does not exist at the run commit', async () => {
    const ran = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/added-later.ts'), 'export const later = 1;\n');
    git(root, 'add', 'src/added-later.ts');
    git(root, 'commit', '-q', '-m', 'added after the run');
    await expect(atCommit(['src/added-later.ts'], { commitSha: ran, repoPrefix: '' })).rejects.toThrow();
  });
});

describe('a measurement root that is not a git top level', () => {
  it('keeps the working-tree measurement and its mutation-probe fence', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'spec-evidence-plain-')));
    try {
      mkdirSync(join(plain, 'src'));
      writeFileSync(join(plain, 'src/a.ts'), 'export const a = 1;\n');
      h.measurementRoot = plain;
      const recipe: Recipe = { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/a.ts'] };
      h.rows = [{ ...h.rows[0], source_fingerprint: fileSetFingerprint(plain, ['src/a.ts']), details: { currentMeasurement: recipe } }];
      h.lockReads = 0;
      const [unchanged] = await list();
      expect(unchanged?.currentness.overall).toBe('current');
      expect(unchanged?.serverMeasurement?.measuredAtCommit).toBeUndefined();
      expect(h.lockReads).toBeGreaterThan(0);

      writeFileSync(join(plain, 'src/a.ts'), 'export const a = 2;\n');
      expect((await list())[0]?.currentness.overall).toBe('stale');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

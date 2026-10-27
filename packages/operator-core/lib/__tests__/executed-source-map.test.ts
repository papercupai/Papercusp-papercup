import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { resolveTestRunsPgUrl } from '@papercusp/test-config/admin-test-runs-reporter';
import {
  EXECUTED_MAP_ENV,
  EXECUTED_MAP_NO_PERSIST_ENV,
  EXECUTED_MAP_RECORD_ENV,
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
  executedMapEnabled,
  executedMapRecordingEnabled,
  formatExecutedMapAlarmLines,
  formatExecutedMapLine,
  formatExecutedMapResultLines,
  formatTestReuseAuditResultLines,
  formatDriftUnknownLine,
  formatExecutedMapTotalLine,
  gitChangedBetween,
  loadExecutedSourceMap,
  loadPassDurations,
  loadReuseProofFiles,
  loadReuseProofs,
  resolveExecutedMapPgUrl,
  resolveTaskReportExpectation,
  readExecutedMapResults,
  resolveRecordedGitDir,
  rowsToExecutedMap,
  rowsToReuseProofs,
  scriptCommandWords,
  summarizeExecutedMapResults,
} from '../../../../scripts/lib/executed-source-map.mjs';

/** WI-6554700010019324: a fixed object store for the readers' scope, and the real checkout's. */
const GIT_DIR = '/fake/install/.git';
const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Runner side of the executed-source map (gate-latency-selection-and-retry-policy-2026-09-06,
 * P-002). The pruning RULE is pinned in related-tests-selection.test.ts; this file pins the
 * plumbing that feeds it — row → map re-anchoring, the git drift seam, the env toggles, the
 * database precedence — and the two places scripts/affected-tests.mjs has to wire it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = '/repo';

describe('named first-attempt audit results', () => {
  const file = 'packages/operator-core/lib/example.test.ts';
  const sha = 'a'.repeat(40);
  const payload = (verdict = 'pass') => ({
    workspaceName: 'core', outcome: 'written', rows: 1, retired: 0, skipped: 0, dirty: false, sha, error: null,
    fileResults: { version: 1, runnerIdentity: 'vitest:core', runContext: 'green-checkpoint',
      runGroupId: 'initial-group', files: [{ testFile: file, verdict }] },
  });
  const read = (value: unknown) => readExecutedMapResults('/unused', { readFile: () => JSON.stringify(value) });
  const emitted = (result: ReturnType<typeof readExecutedMapResults> | undefined) =>
    JSON.parse(formatTestReuseAuditResultLines('core::test', result,
      { watch: new Map([[file, 'audit']]) })[0]!
      .slice('TEST_PASS_REUSE_AUDIT_RESULT '.length));

  it('retains actual named results/runtime and emits only selected audit files', () => {
    const result = read(payload());
    expect(result.results[0]?.fileResults).toEqual(payload().fileResults);
    expect(emitted(result)).toMatchObject({ file, verdict: 'pass', judgedSha: sha,
      runnerIdentity: 'vitest:core', runContext: 'green-checkpoint', runGroupId: 'initial-group' });
  });
  it('preserves an initial failure after the same result file reports a later retry pass', () => {
    let bytes = JSON.stringify(payload('fail'));
    const initial = readExecutedMapResults('/unused', { readFile: () => bytes });
    bytes = JSON.stringify(payload('pass'));
    expect(emitted(readExecutedMapResults('/unused', { readFile: () => bytes })).verdict).toBe('pass');
    expect(emitted(initial).verdict).toBe('fail');
  });
  it.each(['unknown', 'pass', 'fail'])('retains the reporter verdict %s', (verdict) => {
    expect(emitted(read(payload(verdict))).verdict).toBe(verdict);
  });
  it.each([
    ['historical', { ...payload(), fileResults: undefined }],
    ['foreign workspace', { ...payload(), workspaceName: 'other' }],
    ['missing workspace', { ...payload(), workspaceName: undefined }],
    ['wrong version', { ...payload(), fileResults: { ...payload().fileResults, version: 2 } }],
    ['missing context', { ...payload(), fileResults: { ...payload().fileResults, runContext: '' } }],
    ['missing group measurement', { ...payload(), fileResults: { ...payload().fileResults, runGroupId: undefined } }],
    ['duplicate file', { ...payload(), fileResults: { ...payload().fileResults, files: [...payload().fileResults.files, ...payload().fileResults.files] } }],
    ['invalid path', { ...payload(), fileResults: { ...payload().fileResults, files: [{ testFile: '../escape', verdict: 'pass' }] } }],
    ['dirty', { ...payload(), dirty: true }],
    ['missing dirty measurement', { ...payload(), dirty: undefined }],
    ['abbreviated source', { ...payload(), sha: 'abcdef123456' }],
  ])('does not certify %s evidence', (_label, value) => {
    expect(emitted(read(value)).verdict).toBe('unknown');
  });
  it('keeps missing, malformed, unrelated and repeated flush evidence unknown', () => {
    expect(emitted(undefined).verdict).toBe('unknown');
    const repeated = readExecutedMapResults('/unused', {
      readFile: () => `${JSON.stringify(payload())}\n${JSON.stringify(payload())}`,
    });
    expect(emitted(repeated).verdict).toBe('unknown');
    expect(emitted({ ...read(payload()), malformed: 1 }).verdict).toBe('unknown');
    expect(emitted(read({ ...payload(), fileResults: { ...payload().fileResults, files: [] } })).verdict).toBe('unknown');
  });
  it('snapshots at initial settlement and never re-reads after the retry pool', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
    const initial = source.slice(source.indexOf('initialPool = await'), source.indexOf('// ── Reporting'));
    expect(initial).toContain('initialExecutedMapReads.set(initialKey');
    const reporting = source.slice(source.indexOf('// ── Reporting'));
    expect(reporting).toContain('initialExecutedMapReads.get(taskKey(t))');
    expect(reporting).not.toContain('readExecutedMapResults(executedMapResultFile)');
  });

  it('builds the static index before the scoped map read and reuses it for pruning', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
    const selection = source.slice(source.indexOf('if (relatedOnly)'));
    const buildAt = selection.indexOf('prepareRelatedTestSelection(');
    const candidatesAt = selection.indexOf('prepared.selection.selected');
    const queryAt = selection.indexOf('executedMapFor(');
    const pruneAt = selection.indexOf('selectRelatedTests(');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(candidatesAt).toBeGreaterThan(buildAt);
    expect(queryAt).toBeGreaterThan(candidatesAt);
    expect(pruneAt).toBeGreaterThan(queryAt);
    expect(selection.slice(queryAt, pruneAt)).toContain('candidates.map((file) => relative(ROOT, file))');
    expect(selection.slice(pruneAt, pruneAt + 500)).toContain('prepared,');
  });
});

describe('rowsToExecutedMap', () => {
  it('re-anchors repo-relative rows to absolute paths and keeps the first (newest) row per file', () => {
    const map = rowsToExecutedMap(
      [
        { test_file: 'pkg/a.test.ts', recorded_sha: 'new', executed_modules: ['pkg/a.test.ts', 'pkg/x.ts'] },
        { test_file: 'pkg/a.test.ts', recorded_sha: 'old', executed_modules: ['pkg/a.test.ts', 'pkg/y.ts'] },
        { test_file: 'pkg/b.test.ts', recorded_sha: 'new', executed_modules: ['pkg/b.test.ts'] },
      ],
      { repoRoot: ROOT },
    );
    expect([...map.keys()]).toEqual(['/repo/pkg/a.test.ts', '/repo/pkg/b.test.ts']);
    const a = map.get('/repo/pkg/a.test.ts')!;
    expect(a.recordedSha).toBe('new');
    expect([...a.executed]).toEqual(['/repo/pkg/a.test.ts', '/repo/pkg/x.ts']);
  });

  it('drops malformed rows instead of producing an entry the selector could prune on', () => {
    const map = rowsToExecutedMap(
      [
        { test_file: 'pkg/empty.test.ts', recorded_sha: 'sha', executed_modules: [] },
        { test_file: 'pkg/null.test.ts', recorded_sha: 'sha', executed_modules: null },
        { test_file: 'pkg/nosha.test.ts', recorded_sha: undefined as unknown as string, executed_modules: ['x'] },
        { test_file: 'pkg/blank.test.ts', recorded_sha: 'sha', executed_modules: ['', 'pkg/blank.test.ts'] },
      ],
      { repoRoot: ROOT },
    );
    expect([...map.keys()]).toEqual(['/repo/pkg/blank.test.ts']);
    expect([...map.get('/repo/pkg/blank.test.ts')!.executed]).toEqual(['/repo/pkg/blank.test.ts']);
    expect(rowsToExecutedMap(undefined as never, { repoRoot: ROOT }).size).toBe(0);
  });
});

describe('loadExecutedSourceMap', () => {
  it('asks for the newest row per test file in ONE workspace and returns the re-anchored map', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return {
          rows: [{ test_file: 'w/t.test.ts', recorded_sha: 'abc', executed_modules: ['w/t.test.ts', 'w/s.ts'] }],
        };
      },
    };
    const { map, rows } = await loadExecutedSourceMap({ client, workspaceName: '@x/w', repoRoot: ROOT, gitDir: GIT_DIR, runnerIdentity: 'node' });
    expect(rows).toBe(1);
    expect(map.get('/repo/w/t.test.ts')?.recordedSha).toBe('abc');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['@x/w', GIT_DIR, 'node']);
    expect(calls[0]!.text).toMatch(/runner_identity = \$3/);
    expect(calls[0]!.text).toMatch(/DISTINCT ON \(test_file\)/);
    expect(calls[0]!.text).toMatch(/harness_shared\.test_executed_sources/);
    expect(calls[0]!.text).toMatch(/\(recorded_git_dir = \$2 OR recorded_git_dir IS NULL\)/);
    expect(calls[0]!.text).toMatch(/ORDER BY test_file, \(recorded_git_dir IS NULL\), recorded_at DESC/);
  });

  it('reads nothing when the checkout has no resolvable object store (WI-6554700010019324)', async () => {
    let calls = 0;
    const client = { query: async () => { calls += 1; return { rows: [] }; } };
    expect(await loadExecutedSourceMap({ client, workspaceName: '@x/w', repoRoot: ROOT })).toEqual({ map: new Map(), rows: 0 });
    expect(calls).toBe(0);
  });

  it('scopes the newest-row query to static test candidates', async () => {
    const files = ['w/a.test.ts', 'w/b.test.ts'];
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [{ test_file: files[0]!, recorded_sha: 'abc', executed_modules: [files[0]!] }] };
      },
    };
    const { map, rows } = await loadExecutedSourceMap({
      client,
      workspaceName: '@x/w',
      repoRoot: ROOT,
      files,
      gitDir: GIT_DIR,
      runnerIdentity: 'node',
    });
    expect(rows).toBe(1);
    expect(map.has('/repo/w/a.test.ts')).toBe(true);
    expect(map.has('/repo/w/b.test.ts')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(['@x/w', GIT_DIR, 'node', files]);
    expect(calls[0]!.text).toMatch(/test_file = ANY\(\$4::text\[\]\)/);
  });

  it('skips the executed-source query when static selection has no candidates', async () => {
    let calls = 0;
    const client = { query: async () => { calls += 1; return { rows: [] }; } };
    const result = await loadExecutedSourceMap({
      client,
      workspaceName: '@x/w',
      repoRoot: ROOT,
      files: [],
    });
    expect(result).toEqual({ map: new Map(), rows: 0 });
    expect(calls).toBe(0);
  });
});

describe('gitChangedBetween', () => {
  const O1 = '1'.repeat(40);
  const O2 = '2'.repeat(40);
  const Z = '0'.repeat(40);
  const rawEntry = (m1: string, m2: string, o1: string, o2: string, st: string, p: string) =>
    `:${m1} ${m2} ${o1} ${o2} ${st}\0${p}\0`;

  it('runs a raw -z diff in the repo root and re-anchors the names', () => {
    const argv: Array<{ cwd: string; args: string[] }> = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        argv.push({ cwd: (opts as { cwd: string }).cwd, args });
        return (
          rawEntry('100644', '100644', O1, O2, 'M', 'pkg/a.ts') +
          rawEntry('000000', '100644', Z, O2, 'A', 'pkg/b.ts')
        );
      },
    });
    expect(seam('aaa', 'bbb')).toEqual(new Set(['/repo/pkg/a.ts', '/repo/pkg/b.ts']));
    expect(argv).toEqual([
      { cwd: ROOT, args: ['diff', '--raw', '--no-renames', '--abbrev=40', '-z', 'aaa', 'bbb'] },
    ]);
  });

  // gate-file-level-test-reuse-2026-09-27 D-003: a plain superproject diff names a submodule
  // change only as the gitlink path, which no executed module ever equals, so the stale check
  // was blind to every change inside the ~38 submodules.
  it('recurses into a moved gitlink and names the files changed INSIDE the submodule', () => {
    const calls: string[] = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        const cwd = (opts as { cwd: string }).cwd;
        if (args[0] === 'rev-parse') return cwd;
        calls.push(`${cwd} ${args.slice(-2).join('..')}`);
        if (cwd === ROOT) return rawEntry('160000', '160000', O1, O2, 'M', 'libs/sub');
        if (cwd === '/repo/libs/sub') return rawEntry('100644', '100644', O1, O2, 'M', 'src/x.ts');
        throw new Error(`unexpected cwd ${cwd}`);
      },
    });
    expect(seam('aaa', 'bbb')).toEqual(new Set(['/repo/libs/sub', '/repo/libs/sub/src/x.ts']));
    expect(calls).toEqual([`${ROOT} aaa..bbb`, `/repo/libs/sub ${O1}..${O2}`]);
  });

  it('diffs added and removed gitlinks against the empty tree', () => {
    const addedCalls: string[] = [];
    const addedHashCwds: string[] = [];
    const added = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        const cwd = (opts as { cwd: string }).cwd;
        if (args[0] === 'rev-parse') return cwd;
        if (args[0] === 'hash-object') {
          addedHashCwds.push(cwd);
          return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        }
        addedCalls.push(`${cwd} ${args.slice(-2).join('..')}`);
        if (cwd === ROOT) return rawEntry('000000', '160000', Z, O2, 'A', 'libs/new-sub');
        if (cwd === '/repo/libs/new-sub') return rawEntry('000000', '100644', Z, O2, 'A', 'src/new.ts');
        throw new Error(`unexpected cwd ${cwd}`);
      },
    });
    expect(added('aaa', 'bbb')).toEqual(new Set([
      '/repo/libs/new-sub',
      '/repo/libs/new-sub/src/new.ts',
    ]));
    expect(addedCalls).toEqual([
      `${ROOT} aaa..bbb`,
      `/repo/libs/new-sub 4b825dc642cb6eb9a060e54bf8d69288fbee4904..${O2}`,
    ]);
    expect(addedHashCwds).toEqual(['/repo/libs/new-sub']);

    const removedCalls: string[] = [];
    const removedHashCwds: string[] = [];
    const removed = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        const cwd = (opts as { cwd: string }).cwd;
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') throw new Error('removed worktree');
        if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return '/repo/.git/modules/libs/old-sub';
        if (args[0] === 'hash-object') {
          removedHashCwds.push(cwd);
          return '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        }
        removedCalls.push(`${cwd} ${args.slice(-2).join('..')}`);
        if (cwd === ROOT) return rawEntry('160000', '000000', O1, Z, 'D', 'libs/old-sub');
        if (cwd === '/repo/.git/modules/libs/old-sub') return rawEntry('100644', '000000', O1, Z, 'D', 'src/old.ts');
        throw new Error(`unexpected cwd ${cwd}`);
      },
    });
    expect(removed('aaa', 'bbb')).toEqual(new Set([
      '/repo/libs/old-sub',
      '/repo/libs/old-sub/src/old.ts',
    ]));
    expect(removedCalls).toEqual([
      `${ROOT} aaa..bbb`,
      `/repo/.git/modules/libs/old-sub ${O1}..4b825dc642cb6eb9a060e54bf8d69288fbee4904`,
    ]);
    expect(removedHashCwds).toEqual(['/repo/.git/modules/libs/old-sub']);
  });

  it('keeps type changes and missing pinned commits fail-open as unknown drift', () => {
    const typeChanged = gitChangedBetween({
      repoRoot: ROOT,
      exec: () => rawEntry('160000', '100644', O1, O2, 'T', 'libs/sub'),
    });
    expect(typeChanged('aaa', 'bbb')).toBeNull();
    const missingPin = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        const cwd = (opts as { cwd: string }).cwd;
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') throw new Error('worktree absent');
        if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return '/repo/.git/modules/libs/sub';
        if (cwd === ROOT) return rawEntry('160000', '160000', O1, O2, 'M', 'libs/sub');
        throw new Error('fatal: bad object');
      },
    });
    expect(missingPin('aaa', 'bbb')).toBeNull();
  });

  // WI-6554700010019181: one cached null turned 866 of 866 web proofs into unknownDrift with no
  // record of why. A failure is retried once, never cached, and reported with git's stderr.
  it('answers null (cannot tell) when git refuses the pair, retries once, and reports why', () => {
    let calls = 0;
    const unknown: Array<{ recordedSha: string; judgedSha: string; reason: string; attempts: number }> = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, _args, opts) => {
        calls += 1;
        expect((opts as { stdio: unknown[] }).stdio[2]).toBe('pipe');
        throw Object.assign(new Error('Command failed: git diff'), { stderr: "fatal: bad object gone\n", status: 128 });
      },
      onUnknown: (u) => unknown.push(u),
    });
    expect(seam('gone', 'head')).toBeNull();
    expect(seam('gone', 'head')).toBeNull();
    expect(calls).toBe(4);
    expect(unknown).toHaveLength(2);
    expect(unknown[0]).toEqual({
      recordedSha: 'gone', judgedSha: 'head', attempts: 2, reason: 'diff-failed(. gone..head): fatal: bad object gone',
    });
  });

  it('recovers from a transient failure on the retry and caches the answer', () => {
    let calls = 0;
    const unknown: unknown[] = [];
    const seam = gitChangedBetween({
      repoRoot: ROOT,
      relative: true,
      exec: () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return rawEntry('100644', '100644', O1, O2, 'M', 'pkg/a.ts');
      },
      onUnknown: (u) => unknown.push(u),
    });
    expect(seam('aaa', 'bbb')).toEqual(new Set(['pkg/a.ts']));
    expect(seam('aaa', 'bbb')).toEqual(new Set(['pkg/a.ts']));
    expect(calls).toBe(2);
    expect(unknown).toEqual([]);
  });

  it('names the submodule and the structural reason a recursive diff stopped', () => {
    const reasons: string[] = [];
    gitChangedBetween({
      repoRoot: ROOT,
      exec: () => rawEntry('160000', '100644', O1, O2, 'T', 'libs/sub'),
      onUnknown: (u) => reasons.push(u.reason),
    })('aaa', 'bbb');
    gitChangedBetween({
      repoRoot: ROOT,
      exec: (_file, args, opts) => {
        const cwd = (opts as { cwd: string }).cwd;
        if (args[0] === 'rev-parse') return cwd;
        if (cwd === ROOT) return rawEntry('160000', '160000', O1, O2, 'M', 'libs/sub');
        throw Object.assign(new Error('x'), { stderr: `fatal: bad object ${O2}` });
      },
      onUnknown: (u) => reasons.push(u.reason),
    })('aaa', 'bbb');
    expect(reasons).toEqual([
      'gitlink-type-change(libs/sub)',
      `diff-failed(libs/sub ${O1.slice(0, 12)}..${O2.slice(0, 12)}): fatal: bad object ${O2}`,
    ]);
    expect(formatDriftUnknownLine({ repoRoot: ROOT, recordedSha: 'a'.repeat(40), judgedSha: 'b'.repeat(40),
      attempts: 2, reason: 'gitlink-type-change(libs/sub)', prefix: 'TARGETED_' })).toBe(
      `TARGETED_TEST_PASS_REUSE_DRIFT_UNKNOWN repo=${ROOT} recorded=${'a'.repeat(12)} judged=${'b'.repeat(12)} ` +
        'attempts=2 reason=gitlink-type-change(libs/sub)',
    );
  });
});

describe('env toggles + database precedence', () => {
  it('pruning and recording are ON by default and only an explicit off value disables them', () => {
    expect(executedMapEnabled({})).toBe(true);
    expect(executedMapRecordingEnabled({})).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
      expect(executedMapEnabled({ [EXECUTED_MAP_ENV]: off })).toBe(false);
      expect(executedMapRecordingEnabled({ [EXECUTED_MAP_RECORD_ENV]: off })).toBe(false);
    }
    expect(executedMapEnabled({ [EXECUTED_MAP_ENV]: '1' })).toBe(true);
  });

  it('reads the map from the SAME database the recording reporter writes to', () => {
    // WI-10006736: the dedicated ledger variable wins, so an isolated verifier that points
    // HARNESS_ADMIN_DATABASE_URL at a throwaway database still records into the shared ledger.
    expect(resolveExecutedMapPgUrl({ HARNESS_ADMIN_DATABASE_URL: 'postgresql://a', PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://b' })).toEqual({
      url: 'postgresql://b',
      source: 'PAPERCUSP_TEST_RUNS_DB_URL',
    });
    expect(resolveExecutedMapPgUrl({ HARNESS_ADMIN_DATABASE_URL: 'postgresql://a' })).toEqual({
      url: 'postgresql://a',
      source: 'HARNESS_ADMIN_DATABASE_URL',
    });
    expect(resolveExecutedMapPgUrl({}).source).toBe('default');
    // Pinned against the reporter's own resolver so the two sides cannot drift apart silently:
    // the reporter's default follows PAPERCUSP_PG_PORT, and a reader on :5432 would see none of
    // an isolated cluster's rows.
    for (const env of [
      {},
      { PAPERCUSP_PG_PORT: '55432' },
      { PAPERCUSP_PG_PORT: 'not-a-port' },
      { HARNESS_ADMIN_DATABASE_URL: ' postgresql://a ', PAPERCUSP_PG_PORT: '55432' },
      { PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://b', HARNESS_ADMIN_DATABASE_URL: 'postgresql://a' },
      { PAPERCUSP_TEST_RUNS_DB_URL: '  ', HARNESS_ADMIN_DATABASE_URL: 'postgresql://a' },
    ]) {
      expect(resolveExecutedMapPgUrl(env).url, JSON.stringify(env)).toBe(resolveTestRunsPgUrl(env));
    }
  });

  it('every live test-ledger writer resolves the dedicated ledger URL before the app admin URL', () => {
    // Pin the ORDER whether a writer uses process.env directly or delegates to a small env
    // resolver. A writer that reverts to HARNESS_ADMIN_DATABASE_URL-first silently sends an
    // isolated run's rows into the throwaway database (WI-10006736). The vitest reporter exports
    // its resolver, so it is pinned by behaviour rather than by the shape of its source text.
    expect(resolveTestRunsPgUrl({ PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://b', HARNESS_ADMIN_DATABASE_URL: 'postgresql://a' }))
      .toBe('postgresql://b');
    const writers = [
      'packages/operator-core/lib/testing-playwright-reporter.ts',
      'apps/operator/scripts/prune-test-runs.ts',
    ];
    const chain = /(?:process\.env|env)\.(PAPERCUSP_TEST_RUNS_DB_URL|HARNESS_ADMIN_DATABASE_URL)(?:\?\.trim\(\))?\s*(?:\?\?|\|\|)\s*(?:process\.env|env)\.(PAPERCUSP_TEST_RUNS_DB_URL|HARNESS_ADMIN_DATABASE_URL)(?:\?\.trim\(\))?\s*(?:\?\?|\|\|)/g;
    for (const rel of writers) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const chains = [...src.matchAll(chain)].map((m) => `${m[1]}>${m[2]}`);
      expect(chains, rel).toEqual(['PAPERCUSP_TEST_RUNS_DB_URL>HARNESS_ADMIN_DATABASE_URL']);
    }
  });
});

describe('formatExecutedMapLine', () => {
  it('names every rail, so a selection that did not narrow is never silent about why', () => {
    const line = formatExecutedMapLine(
      '@x/w',
      {
        applied: true,
        reason: null,
        entries: 10,
        pruned: 3,
        prunable: 3,
        wouldEmpty: false,
        kept: { changedTest: 1, unresolved: 0, noEntry: 2, untrusted: 0, unknownDrift: 1, stale: 4, intersects: 5 },
      },
      12,
    );
    expect(line).toMatch(/^EXECUTED_SOURCE_MAP ws=@x\/w applied=true reason=ok rows=12 entries=10 pruned=3 prunable=3 wouldEmpty=false /);
    for (const k of ['keptChangedTest=1', 'keptNoEntry=2', 'keptUnknownDrift=1', 'keptStale=4', 'keptIntersects=5']) {
      expect(line).toContain(k);
    }
    expect(formatExecutedMapLine('@x/w', undefined, 0)).toContain('applied=false reason=no-summary');
  });
});

describe('scripts/affected-tests.mjs wiring (source pins)', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');

  it('feeds the selector the map, the judged sha and the drift seam', () => {
    expect(source).toMatch(/selectRelatedTests\(\{[\s\S]*?executedMap: executedMap\.map,[\s\S]*?judgedSha: executedMapContext\.judgedSha,[\s\S]*?changedBetween: executedMapContext\.changedBetween,/);
  });

  it('classifies lane candidates before fetching wide proof rows', () => {
    const scopeStart = source.indexOf('const requestedFiles =');
    const laneRead = source.indexOf('const loadedProofs = await loadReuseProofs', scopeStart);
    const scope = source.slice(scopeStart, laneRead);
    const laneFilter = scope.indexOf('const scoped = laneScopedCandidates');
    const laneClassify = scope.indexOf('await laneClassifier');
    expect(scope).toContain('loadReuseProofFiles');
    expect(laneFilter).toBeGreaterThanOrEqual(0);
    expect(laneClassify).toBeGreaterThanOrEqual(0);
    expect(laneRead).toBeGreaterThan(scopeStart);
    expect(laneClassify).toBeLessThan(laneFilter);
    expect(scopeStart + laneFilter).toBeLessThan(laneRead);
    expect(source.slice(laneRead, source.indexOf('const label =', laneRead))).toContain(
      '...(files == null ? {} : { files })',
    );
  });

  it('stamps the reporter arming env on unit and integration vitest tasks, and prints one line per workspace', () => {
    expect(source).toMatch(
      /const recordsExecutedMap =\s*executedMapRecordingEnabled\(\) &&\s*\(spawnTask\.script === "test" \|\| LANE_SCRIPTS\.includes\(spawnTask\.script\) \|\|\s*spawnTask\.script === "test:integration"\);/,
    );
    expect(source).toMatch(/\.\.\.\(recordsExecutedMap \? \{ \[EXECUTED_MAP_WORKSPACE_ENV\]: spawnTask\.ws\.name \} : \{\}\)/);
    // WI-10003603: the result channel — same env name on both sides, and the runner reads it back,
    // prints each task's outcome and a per-invocation total the gate parses.
    expect(EXECUTED_MAP_RESULT_ENV).toBe('PC_EXECUTED_SOURCE_MAP_RESULT');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_RESULT_ENV = '${EXECUTED_MAP_RESULT_ENV}'`,
    );
    expect(source).toMatch(/\.\.\.\(executedMapResultFile \? \{ \[EXECUTED_MAP_RESULT_ENV\]: executedMapResultFile \} : \{\}\)/);
    expect(source).toContain('formatExecutedMapResultLines(label, read)');
    expect(source).toContain('outSync(formatExecutedMapTotalLine(summarizeExecutedMapResults(executedMapReads)))');
    // The constant the runner stamps IS the env the reporter arms on (vitest-config.ts).
    expect(EXECUTED_MAP_WORKSPACE_ENV).toBe('PC_EXECUTED_SOURCE_MAP_WORKSPACE');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_WORKSPACE_ENV = '${EXECUTED_MAP_WORKSPACE_ENV}'`,
    );
    expect(source).toContain('formatExecutedMapLine(t.ws.name, result.executedMap, executedMap.rows)');
    // EI-24542010215430349: the gate's rescue reruns arm no-persist through this constant.
    expect(EXECUTED_MAP_NO_PERSIST_ENV).toBe('PC_EXECUTED_SOURCE_MAP_NO_PERSIST');
    expect(readFileSync(join(REPO_ROOT, 'libs/test-config/src/vitest-config.ts'), 'utf8')).toContain(
      `PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV = '${EXECUTED_MAP_NO_PERSIST_ENV}'`,
    );
  });

  it('is fail-open: no database, no sha, a slow read — each is a reason string, never a thrown selection', () => {
    expect(source).toMatch(/inert\(`pg-unavailable\(/);
    expect(source).toMatch(/inert\("no-judged-sha"\)/);
    expect(source).toMatch(/executed-map read timed out/);
    expect(source).toMatch(/executedMapContext\.client\.end\(\)/);
  });
});

// gate-file-level-test-reuse-2026-09-27 P-008: the pass-proof loader feeding selectReusablePasses.
describe('reuse proofs loader', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    test_file: 'pkg/a.test.ts',
    recorded_sha: 'sha1',
    recorded_at: new Date('2026-09-27T10:00:00Z'),
    executed_modules: ['pkg/a.test.ts', 'pkg/a.ts'],
    read_paths: ['pkg/fixtures/'],
    inputs_captured: true,
    opaque_reasons: [],
    run_context: 'green-checkpoint',
    runner_identity: 'v25.9.0 linux x64',
    ...over,
  });

  it('keys proofs repo-relative, newest-first wins, and maps every column', () => {
    const proofs = rowsToReuseProofs([row(), row({ recorded_sha: 'older' }), row({ test_file: 'pkg/b.test.ts', recorded_at: '2026-09-27T09:00:00Z' })]);
    expect([...proofs.keys()]).toEqual(['pkg/a.test.ts', 'pkg/b.test.ts']);
    expect(proofs.get('pkg/a.test.ts')).toEqual({
      recordedSha: 'sha1',
      recordedAtMs: Date.parse('2026-09-27T10:00:00Z'),
      executedModules: ['pkg/a.test.ts', 'pkg/a.ts'],
      readPaths: ['pkg/fixtures/'],
      inputsCaptured: true,
      opaqueReasons: [],
      runContext: 'green-checkpoint',
      runnerIdentity: 'v25.9.0 linux x64',
    });
    expect(proofs.get('pkg/b.test.ts')?.recordedAtMs).toBe(Date.parse('2026-09-27T09:00:00Z'));
  });

  it('degrades unreadable columns toward "not reusable", never toward a valid proof', () => {
    const p = rowsToReuseProofs([
      row({ inputs_captured: null, read_paths: null, opaque_reasons: 'x', run_context: null, recorded_at: 'garbage' }),
      { test_file: 7, recorded_sha: 'x' },
    ]).get('pkg/a.test.ts');
    expect(p?.inputsCaptured).toBe(false);
    expect(p?.readPaths).toEqual([]);
    expect(p?.runContext).toBeNull();
    expect(Number.isNaN(p?.recordedAtMs)).toBe(true);
  });

  it('queries ONE workspace and ONE run context, newest row per file', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [row()] };
      },
    };
    const out = await loadReuseProofs({ client, workspaceName: '@papercusp/x', runContext: 'green-checkpoint', runnerIdentity: 'node' });
    expect(out.rows).toBe(1);
    expect(out.proofs.has('pkg/a.test.ts')).toBe(true);
    // The default object store is the one this module was loaded from (WI-6554700010019324).
    expect(calls[0]?.values).toEqual(['@papercusp/x', 'green-checkpoint', resolveRecordedGitDir(REAL_ROOT), 'node']);
    expect(calls[0]?.text).toMatch(/runner_identity = \$4/);
    expect(calls[0]?.values?.[2]).toMatch(/\/\.git$/);
    expect(calls[0]?.text).toMatch(/DISTINCT ON \(test_file\)/);
    expect(calls[0]?.text).toMatch(/run_context = \$2/);
    expect(calls[0]?.text).toMatch(/\(recorded_git_dir = \$3 OR recorded_git_dir IS NULL\)/);
    expect(calls[0]?.text).toMatch(/ORDER BY test_file, \(recorded_git_dir IS NULL\), recorded_at DESC/);
  });

  it('reuses nothing when the object store is unresolvable, so a sibling install\'s proof is never read', async () => {
    let queried = false;
    const client = { query: async () => { queried = true; return { rows: [row()] }; } };
    expect(await loadReuseProofs({ client, workspaceName: '@papercusp/x', runContext: 'green-checkpoint', gitDir: null }))
      .toEqual({ proofs: new Map(), rows: 0 });
    expect(await loadReuseProofFiles({ client, workspaceName: '@papercusp/x', runContext: 'green-checkpoint', gitDir: null }))
      .toEqual({ files: [], rows: 0 });
    expect(queried).toBe(false);
  });

  it('loads only the requested proof files when a targeted task supplies a scope', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [row()] };
      },
    };
    const out = await loadReuseProofs({
      client,
      workspaceName: '@papercusp/x',
      runContext: 'green-checkpoint',
      files: ['pkg/a.test.ts', 'pkg/a.test.ts', ''],
      gitDir: GIT_DIR,
      runnerIdentity: 'node',
    });
    expect(out.rows).toBe(1);
    expect(out.proofs.has('pkg/a.test.ts')).toBe(true);
    expect(calls[0]?.values).toEqual(['@papercusp/x', 'green-checkpoint', GIT_DIR, 'node', ['pkg/a.test.ts']]);
    expect(calls[0]?.text).toMatch(/test_file = ANY\(\$5::text\[\]\)/);
    expect(calls[0]?.text).toMatch(/DISTINCT ON \(test_file\)/);
  });

  it('does not query wide proof rows for an empty lane scope', async () => {
    let queried = false;
    const client = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    const out = await loadReuseProofs({
      client,
      workspaceName: '@papercusp/x',
      runContext: 'green-checkpoint',
      files: [],
    });
    expect(out).toEqual({ proofs: new Map(), rows: 0 });
    expect(queried).toBe(false);
  });

  it('lists lane candidate keys without fetching wide proof arrays', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [{ test_file: 'pkg/a.test.ts' }, { test_file: 'pkg/b.test.ts' }] };
      },
    };
    const out = await loadReuseProofFiles({ client, workspaceName: '@papercusp/x', runContext: 'green-checkpoint', gitDir: GIT_DIR, runnerIdentity: 'node' });
    expect(out).toEqual({ files: ['pkg/a.test.ts', 'pkg/b.test.ts'], rows: 2 });
    expect(calls[0]?.values).toEqual(['@papercusp/x', 'green-checkpoint', GIT_DIR, 'node']);
    expect(calls[0]?.text).toMatch(/\(recorded_git_dir = \$3 OR recorded_git_dir IS NULL\)/);
    expect(calls[0]?.text).toMatch(/SELECT DISTINCT test_file/);
    expect(calls[0]?.text).not.toMatch(/executed_modules|read_paths/);
  });

  it.each([undefined, null, '', '  '])('does not read unknown runtime identity %s', async (runnerIdentity) => {
    const query = vi.fn(async () => ({ rows: [row()] }));
    const options = { client: { query }, workspaceName: '@x/w', runContext: 'green-checkpoint',
      gitDir: GIT_DIR, runnerIdentity };
    expect(await loadReuseProofs(options)).toEqual({ proofs: new Map(), rows: 0 });
    expect(await loadReuseProofFiles(options)).toEqual({ files: [], rows: 0 });
    expect(await loadExecutedSourceMap({ ...options, repoRoot: ROOT })).toEqual({ map: new Map(), rows: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('loadPassDurations reads the newest CI PASS per file, and drops unusable durations (P-013)', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return {
          rows: [
            { file_path: 'pkg/a.test.ts', duration_ms: 1200 },
            { file_path: 'pkg/b.test.ts', duration_ms: '35' },
            { file_path: 'pkg/c.test.ts', duration_ms: null },
            { file_path: 'pkg/d.test.ts', duration_ms: -4 },
            { file_path: 'pkg/e.test.ts', duration_ms: 'nope' },
          ],
        };
      },
    };
    const out = await loadPassDurations({ client, files: ['pkg/a.test.ts', 'pkg/b.test.ts'] });
    expect([...out]).toEqual([
      ['pkg/a.test.ts', 1200],
      ['pkg/b.test.ts', 35],
    ]);
    expect(calls[0]?.values).toEqual([['pkg/a.test.ts', 'pkg/b.test.ts']]);
    // CI rows only: `test_runs` mixes local/admin-ui/mutation-probe rows, and statuses are
    // 'pass'/'fail' (never 'passed'), so a wrong literal would silently match nothing.
    expect(calls[0]?.text).toMatch(/source = 'ci' AND status = 'pass'/);
    expect(calls[0]?.text).toMatch(/DISTINCT ON \(file_path\)/);
    expect(calls[0]?.text).toMatch(/ORDER BY file_path, finished_at DESC/);
  });

  it('loadPassDurations does not query for an empty skip list', async () => {
    let queried = false;
    const client = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    expect((await loadPassDurations({ client, files: [] })).size).toBe(0);
    expect(queried).toBe(false);
  });

  it('gitChangedBetween({ relative: true }) returns repo-relative drift', () => {
    const exec = () => ':100644 100644 aaaa bbbb M\0pkg/a.ts\0:100644 100644 cccc dddd M\0lib/b.ts\0';
    const rel = gitChangedBetween({ repoRoot: '/repo', exec, relative: true })('x', 'y');
    expect(rel ? [...rel].sort() : rel).toEqual(['lib/b.ts', 'pkg/a.ts']);
    const abs = gitChangedBetween({ repoRoot: '/repo', exec })('x', 'y');
    expect(abs ? [...abs].sort() : abs).toEqual(['/repo/lib/b.ts', '/repo/pkg/a.ts']);
  });
});

// WI-10003792: whether an armed task's recorder is EXPECTED to report, decided at arming from the
// task's real script + config — so a silent enrolled task alarms and an astro check does not.
describe('resolveTaskReportExpectation', () => {
  const ENROLLED = "import { defineVitestConfig } from '@papercusp/test-config';\nexport default defineVitestConfig({});\n";
  const SPREAD = "import { defineConfig } from 'vitest/config';\nimport { gateParticipationConfig } from '@papercusp/test-config';\nexport default defineConfig({ ...gateParticipationConfig() });\n";
  const PLAIN = "import { defineConfig } from 'vitest/config';\n// defineVitestConfig( is only mentioned in a comment\nexport default defineConfig({});\n";
  const WS = '/repo/packages/pkg';
  const fsOf = (files: Record<string, string>) => (p: string) => {
    if (p in files) return files[p]!;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  };
  const resolveWith = (command: string, files: Record<string, string>) =>
    resolveTaskReportExpectation({ command, wsDir: WS, readFile: fsOf(files) });

  it('strips env assignments and the pc-heavy admission wrapper', () => {
    expect(scriptCommandWords('PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs')).toEqual([
      'node',
      '../../scripts/run-vitest-pure-lane.mjs',
    ]);
    expect(scriptCommandWords('vitest run --passWithNoTests')).toEqual(['vitest', 'run', '--passWithNoTests']);
    expect(scriptCommandWords(undefined)).toEqual([]);
  });

  it('expects a report from vitest under a gate-enrolled default config (defineVitestConfig or the spread fragment)', () => {
    expect(resolveWith('vitest run --passWithNoTests', { [`${WS}/vitest.config.ts`]: ENROLLED })).toEqual({
      expectsReport: true,
      reason: 'enrolled-config',
      config: 'vitest.config.ts',
    });
    // The first existing default wins; .mts when there is no .ts.
    expect(resolveWith('vitest', { [`${WS}/vitest.config.mts`]: SPREAD })).toMatchObject({
      expectsReport: true,
      config: 'vitest.config.mts',
    });
  });

  it('follows an explicit --config / --config= / -c to the config that actually runs', () => {
    const files = { [`${WS}/vitest.config.ts`]: PLAIN, [`${WS}/vitest.lane.config.ts`]: ENROLLED };
    for (const cmd of [
      'vitest run --config vitest.lane.config.ts',
      'vitest run --config=vitest.lane.config.ts',
      'vitest run -c vitest.lane.config.ts',
    ]) {
      expect(resolveWith(cmd, files)).toEqual({ expectsReport: true, reason: 'enrolled-config', config: 'vitest.lane.config.ts' });
    }
    // …and the reverse: an enrolled default does not rescue an explicit plain config.
    expect(
      resolveWith('vitest run -c vitest.plain.config.ts', {
        [`${WS}/vitest.config.ts`]: ENROLLED,
        [`${WS}/vitest.plain.config.ts`]: PLAIN,
      }),
    ).toMatchObject({ expectsReport: false, reason: 'unenrolled-config', config: 'vitest.plain.config.ts' });
  });

  it('does NOT expect a report from a config outside the gate, a missing config, or a non-vitest program', () => {
    expect(resolveWith('vitest run', { [`${WS}/vitest.config.ts`]: PLAIN })).toMatchObject({
      expectsReport: false,
      reason: 'unenrolled-config',
    });
    expect(resolveWith('vitest run', {})).toEqual({ expectsReport: false, reason: 'no-config', config: null });
    expect(resolveWith('astro check', { [`${WS}/vitest.config.ts`]: ENROLLED })).toMatchObject({ reason: 'not-vitest' });
    expect(resolveWith('node --test src/**/*.node-test.ts', { [`${WS}/vitest.config.ts`]: ENROLLED })).toMatchObject({
      expectsReport: false,
      reason: 'node-test-runner',
    });
    expect(resolveWith('vitest run && echo done', { [`${WS}/vitest.config.ts`]: ENROLLED })).toMatchObject({
      expectsReport: false,
      reason: 'compound-command',
    });
    expect(resolveWith('', {})).toMatchObject({ reason: 'no-command' });
  });

  it('treats a node wrapper as vitest only when its source delegates to vitest', () => {
    const lane = 'PC_TEST_LANE=pure ../../scripts/pc-heavy.sh -- node ../../scripts/run-vitest-pure-lane.mjs';
    const wrapperPath = '/repo/scripts/run-vitest-pure-lane.mjs';
    expect(
      resolveWith(lane, { [wrapperPath]: "spawn('vitest', ['run'])", [`${WS}/vitest.config.ts`]: ENROLLED }),
    ).toMatchObject({ expectsReport: true, config: 'vitest.config.ts' });
    expect(resolveWith(lane, { [wrapperPath]: "spawn('mocha')", [`${WS}/vitest.config.ts`]: ENROLLED })).toMatchObject({
      expectsReport: false,
      reason: 'not-vitest',
    });
    expect(resolveWith(lane, { [`${WS}/vitest.config.ts`]: ENROLLED })).toMatchObject({
      expectsReport: false,
      reason: 'wrapper-unreadable',
    });
  });

  it('calibrates against the real tree: operator-core expects reports, the astro docs check does not', () => {
    const pkg = (dir: string) => JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const core = pkg('packages/operator-core');
    for (const script of ['test', 'test:lane-pure', 'test:lane-stateful']) {
      expect(
        resolveTaskReportExpectation({ command: core.scripts[script], wsDir: join(REPO_ROOT, 'packages/operator-core') }),
        script,
      ).toMatchObject({ expectsReport: true, reason: 'enrolled-config' });
    }
    const docs = pkg('apps/operator-docs');
    expect(
      resolveTaskReportExpectation({ command: docs.scripts.test, wsDir: join(REPO_ROOT, 'apps/operator-docs') }),
    ).toMatchObject({ expectsReport: false, reason: 'not-vitest' });
  });
});

describe('noReport split and the unexpected-silence alarm', () => {
  const noReport = (expectsReport?: boolean | null) => ({ status: 'no-report' as const, results: [], malformed: 0, expectsReport });

  it('counts an enrolled silent task as unexpected, a never-could-report task as expected, and keeps noReport the total', () => {
    const reported = {
      status: 'reported' as const,
      results: [{ outcome: 'written', rows: 4, retired: 0, skipped: 0, dirty: false, sha: 'abc', error: null }],
      malformed: 0,
      expectsReport: true,
    };
    const s = summarizeExecutedMapResults([noReport(true), noReport(false), noReport(null), noReport(), reported]);
    expect(s).toMatchObject({ tasks: 5, written: 1, noReport: 4, noReportExpected: 1, noReportUnexpected: 1 });
    expect(formatExecutedMapTotalLine(s)).toMatch(/ noReport=4 malformed=0 noReportExpected=1 noReportUnexpected=1$/);
  });

  it('ALARMS only on an expected-but-silent task, and says so on its result line', () => {
    expect(formatExecutedMapAlarmLines('ws::test', noReport(true))).toEqual([
      expect.stringMatching(/^EXECUTED_SOURCE_MAP_ALARM task=ws::test outcome=no-report-unexpected rows=0 error=\S/),
    ]);
    expect(formatExecutedMapAlarmLines('docs::test', noReport(false))).toEqual([]);
    expect(formatExecutedMapAlarmLines('old::test', noReport())).toEqual([]);
    expect(formatExecutedMapResultLines('ws::test', noReport(true))).toEqual([
      'EXECUTED_SOURCE_MAP_RESULT task=ws::test outcome=no-report malformed=0 expected=true',
    ]);
    expect(formatExecutedMapResultLines('old::test', noReport())).toEqual([
      'EXECUTED_SOURCE_MAP_RESULT task=old::test outcome=no-report malformed=0',
    ]);
  });

  it('pins the runner wiring: expectation resolved at arming, stamped onto the read', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
    expect(source).toMatch(/executedMapReportExpectations\.set\(\s*taskKey\(context\.t\),\s*resolveTaskReportExpectation\(\{/);
    expect(source).toContain('expectsReport: executedMapReportExpectations.get(taskKey(t))?.expectsReport ?? null');
  });
});

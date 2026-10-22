/**
 * WI-10005223: admission git runs on a REAL worker thread (the tsx bootstrap, since this
 * source tree has no bundled .mjs beside the module), never on the caller's event loop.
 * Every case drives a real git repo; nothing here is mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_WORKER_TSX_BOOTSTRAP,
  admissionOffthreadStats,
  admissionWorkerEntry,
  configureAdmissionOffthread,
  resetAdmissionOffthread,
  runAdmissionJob,
} from './admission-offthread';
import { executeAdmissionJob } from './admission-jobs';
import { evaluateFixPrecheck, precheckPopulation } from './admission-fix-precheck';
import { createFrozenCandidateQueue } from './frozen-candidate-repair-queue';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'admission-offthread-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'staging');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  // Shell aliases give a deterministic slow git call and a timestamped one.
  git('config', 'alias.nap', '!sleep 1.2');
  git('config', 'alias.stamp', '!sh -c "date +%s%N; sleep 0.4; date +%s%N"');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));
afterEach(async () => {
  vi.restoreAllMocks();
  await resetAdmissionOffthread();
});

/** Count 20ms timer turns on THIS event loop while `job` is pending. */
async function loopTurnsDuring(job: Promise<unknown>): Promise<number> {
  let turns = 0;
  let done = false;
  const tick = () => {
    if (done) return;
    turns++;
    setTimeout(tick, 20);
  };
  setTimeout(tick, 20);
  await job;
  done = true;
  return turns;
}

describe('admission off-thread host (WI-10005223)', () => {
  it('WI-8351 selects pinned gitlink tests and paired callers despite an empty filename population', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-paired-'));
    try {
      const init = (cwd: string) => {
        execFileSync('git', ['init', '-q'], { cwd });
        execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
        execFileSync('git', ['config', 'user.name', 'test'], { cwd });
      };
      init(fixture);
      const child = join(fixture, 'component');
      mkdirSync(child);
      init(child);
      writeFileSync(join(child, 'api.mjs'), 'export const value = 1;\n');
      writeFileSync(join(child, 'paired.test.mjs'), "import { test } from 'node:test';\nimport { equal } from 'node:assert/strict';\nimport { value } from '../missing-parent-helper.mjs';\ntest('paired helper supports the component', () => equal(value, 1));\n// café\n");
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      git(child, 'add', '.');
      git(child, 'commit', '-q', '-m', 'pinned component');
      const pin = git(child, 'rev-parse', 'HEAD');
      writeFileSync(join(fixture, 'parent.test.mjs'), "import './component/api.mjs';\n");
      writeFileSync(join(fixture, 'unrelated.test.mjs'), 'export const unaffected = 1;\n');
      git(fixture, 'add', 'parent.test.mjs', 'unrelated.test.mjs');
      git(fixture, 'update-index', '--add', '--cacheinfo', `160000,${pin},component`);
      git(fixture, 'commit', '-q', '-m', 'frozen paired tree');
      const commit = git(fixture, 'rev-parse', 'HEAD');
      // The focused test runner preloads committed-source-loader through NODE_OPTIONS.
      // These child processes intentionally execute an uncommitted temporary fixture,
      // so inherit the normal process environment without that repository-only guard.
      const childEnv = { ...process.env, NODE_OPTIONS: '' };
      const missingHelper = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'component/paired.test.mjs'], { cwd: fixture, encoding: 'utf8', env: childEnv });
      expect(missingHelper.status).toBe(1);
      expect(missingHelper.stdout + missingHelper.stderr).toContain('ERR_MODULE_NOT_FOUND');
      writeFileSync(join(fixture, 'missing-parent-helper.mjs'), 'export const value = 1;\n');
      const pairedControl = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'component/paired.test.mjs'], { cwd: fixture, encoding: 'utf8', env: childEnv });
      expect(pairedControl.status).toBe(0);
      expect(pairedControl.stdout).toContain('# pass 1');
      // Staging now has another checkout and untracked test; neither may enter the proof.
      writeFileSync(join(child, 'paired.test.mjs'), 'export const silentlyRepaired = 1;\n');
      writeFileSync(join(child, 'ambient.test.mjs'), 'throw new Error("ambient");\n');
      git(child, 'add', '.');
      git(child, 'commit', '-q', '-m', 'ambient change');
      const input = { root: fixture, commit, admittedPaths: ['component'],
        signature: [{ kind: 'workspace-task' as const, id: 'component::test' }] };
      expect(precheckPopulation(input).files).toEqual([]);
      const result = await runAdmissionJob({ kind: 'precheck-population', input });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.detail);
      expect(result.population.files).toEqual(['component/paired.test.mjs', 'parent.test.mjs']);
      expect(result.population.canProveDoesNotFix).toBe(false);
      const failed = evaluateFixPrecheck(result.population, { ran: true, commit,
        results: result.population.files.map((path) => ({ path, status: path.startsWith('component/') ? 'fail' : 'pass' })) });
      expect(failed).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['component/paired.test.mjs'] });
      expect(evaluateFixPrecheck(result.population, { ran: true, commit,
        results: result.population.files.map((path) => ({ path, status: 'pass' })) })).toMatchObject({ ok: true, ran: true });
      expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 1, jobsInline: 0 });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 60_000);

  it('WI-8351 refuses unavailable pinned submodule objects instead of measuring ambient files', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-missing-pin-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},component`);
      git('commit', '-q', '-m', 'unavailable pin');
      mkdirSync(join(fixture, 'component'));
      writeFileSync(join(fixture, 'component', 'ambient.test.mjs'), 'export const fake = 1;\n');
      const result = await runAdmissionJob({ kind: 'precheck-population', input: {
        root: fixture, commit: git('rev-parse', 'HEAD'), admittedPaths: ['component'], signature: [] } });
      expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('object store unavailable') });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 60_000);

  it('reads an admitted gitlink from the canonical submodule object store when the generation clone lacks its pin', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-canonical-pin-'));
    const canonical = join(fixture, 'canonical');
    const generation = join(fixture, 'generation');
    const init = (cwd: string) => {
      execFileSync('git', ['init', '-q'], { cwd });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd });
    };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      mkdirSync(canonical);
      init(canonical);
      const canonicalChild = join(canonical, 'component');
      mkdirSync(canonicalChild);
      init(canonicalChild);
      writeFileSync(join(canonicalChild, 'api.mjs'), 'export const value = 1;\n');
      writeFileSync(join(canonicalChild, 'component.test.mjs'), 'export const pinnedTest = true;\n');
      git(canonicalChild, 'add', '.');
      git(canonicalChild, 'commit', '-q', '-m', 'pinned submodule');
      const pin = git(canonicalChild, 'rev-parse', 'HEAD');
      git(canonical, 'update-index', '--add', '--cacheinfo', '160000,' + pin + ',component');
      git(canonical, 'commit', '-q', '-m', 'frozen gitlink');
      const commit = git(canonical, 'rev-parse', 'HEAD');

      git(canonical, 'worktree', 'add', '--detach', generation, commit);
      const generationChild = join(generation, 'component');
      rmSync(generationChild, { recursive: true, force: true });
      mkdirSync(generationChild);
      init(generationChild);
      writeFileSync(join(generationChild, 'stale.txt'), 'generation clone without the frozen pin\n');
      git(generationChild, 'add', '.');
      git(generationChild, 'commit', '-q', '-m', 'stale submodule clone');

      expect(git(generation, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(join(canonical, '.git'));
      expect(git(canonicalChild, 'cat-file', '-t', pin)).toBe('commit');
      expect(() => git(generationChild, 'cat-file', '-e', pin + '^{commit}')).toThrow();

      const result = executeAdmissionJob({ kind: 'precheck-population', input: {
        root: generation, commit, admittedPaths: ['component'], signature: [],
      } });
      if (!result.ok) throw new Error('canonical pin inventory failed: ' + result.detail);
      expect(result.ok).toBe(true);
      expect(result.population.files).toContain('component/component.test.mjs');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 60_000);

  it('WI-8351 refuses a gitlink with native tests but no router-supported inventory', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'admission-native-inventory-'));
    try {
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      const init = (cwd: string) => {
        git(cwd, 'init', '-q');
        git(cwd, 'config', 'user.email', 'test@example.invalid');
        git(cwd, 'config', 'user.name', 'test');
      };
      init(fixture);
      const child = join(fixture, 'component');
      mkdirSync(child);
      init(child);
      writeFileSync(join(child, 'api.mjs'), 'export const value = 1;\n');
      writeFileSync(join(child, 'native.test.rs'), '#[test] fn paired_native_test() { assert!(true); }\n');
      git(child, 'add', '.');
      git(child, 'commit', '-q', '-m', 'native-only component');
      const pin = git(child, 'rev-parse', 'HEAD');
      writeFileSync(join(fixture, 'parent.test.mjs'), "import './component/api.mjs';\n");
      git(fixture, 'add', 'parent.test.mjs');
      git(fixture, 'update-index', '--add', '--cacheinfo', `160000,${pin},component`);
      git(fixture, 'commit', '-q', '-m', 'frozen native-only tree');
      const result = await runAdmissionJob({ kind: 'precheck-population', input: {
        root: fixture, commit: git(fixture, 'rev-parse', 'HEAD'), admittedPaths: ['component'],
        signature: [{ kind: 'workspace-task', id: 'component::test' }],
      } });
      expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('no discoverable test files') });
      expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 1, jobsInline: 0 });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 60_000);

  it('resolves the unbundled tsx bootstrap from a source tree with no bundled worker', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(admissionWorkerEntry(here)).toBe(join(here, ADMISSION_WORKER_TSX_BOOTSTRAP));
  });

  it('keeps the caller event loop turning while a slow admission git call runs', async () => {
    await runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo }); // warm the worker
    const turns = await loopTurnsDuring(runAdmissionJob({ kind: 'git', argv: ['nap'], cwd: repo }));
    expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, jobsInline: 0, loadFailures: 0 });
    // ~60 turns ideal over 1.2s; a main-thread spawnSync yields 0.
    expect(turns).toBeGreaterThanOrEqual(15);
  }, 60_000);

  it('runs lineage reconciliation on the worker while its sync Git read is delayed', async () => {
    const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const queue = createFrozenCandidateQueue({ candidate, base: null, nowMs: Date.now() });
    await runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo }); // warm the worker

    const shim = mkdtempSync(join(tmpdir(), 'admission-lineage-git-shim-'));
    const originalPath = process.env.PATH;
    const originalRealGit = process.env.ADMISSION_TEST_REAL_GIT;
    const wrapper = join(shim, 'git');
    writeFileSync(wrapper, '#!/bin/sh\nsleep 0.5\nexec "$ADMISSION_TEST_REAL_GIT" "$@"\n');
    chmodSync(wrapper, 0o755);
    process.env.ADMISSION_TEST_REAL_GIT = gitBinary;
    process.env.PATH = [shim, originalPath].filter(Boolean).join(delimiter);
    try {
      const turns = await loopTurnsDuring(runAdmissionJob(
        { kind: 'reconcile-lineage', queue, root: repo },
        { timeoutMs: 10_000, stepName: 'lineage-reconcile-test' },
      ));
      expect(turns).toBeGreaterThanOrEqual(10);
      expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, jobsInline: 0, loadFailures: 0 });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalRealGit === undefined) delete process.env.ADMISSION_TEST_REAL_GIT;
      else process.env.ADMISSION_TEST_REAL_GIT = originalRealGit;
      rmSync(shim, { recursive: true, force: true });
    }
  }, 20_000);

  it('CONTROL: the same call inline blocks the loop, so the turn count can fail', async () => {
    configureAdmissionOffthread({ mode: 'inline' });
    const turns = await loopTurnsDuring(runAdmissionJob({ kind: 'git', argv: ['nap'], cwd: repo }));
    expect(admissionOffthreadStats().jobsInline).toBe(1);
    expect(turns).toBeLessThanOrEqual(2);
  });

  it('returns exactly what the inline builders return (git + containment)', async () => {
    const gitJob = { kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo } as const;
    const containmentJob = {
      kind: 'containment',
      paths: ['a.txt', 'missing.txt'],
      judgedSha: 'HEAD',
      root: repo,
      branch: 'staging',
    } as const;
    const [viaWorkerGit, viaWorkerContainment] = [
      await runAdmissionJob({ ...gitJob, argv: [...gitJob.argv] }),
      await runAdmissionJob({ ...containmentJob, paths: [...containmentJob.paths] }),
    ];
    expect(admissionOffthreadStats().jobsOnWorker).toBe(2);
    expect(viaWorkerGit).toEqual(executeAdmissionJob({ ...gitJob, argv: [...gitJob.argv] }));
    expect(viaWorkerContainment).toEqual(
      executeAdmissionJob({ ...containmentJob, paths: [...containmentJob.paths] }),
    );
    expect(viaWorkerContainment[0]).toMatchObject({ path: 'a.txt', containedInJudgedSha: true });
  }, 60_000);

  it('applies fail-fast backpressure to overlapping jobs and accepts after the current job settles', async () => {
    const first = runAdmissionJob({ kind: 'git', argv: ['stamp'], cwd: repo });
    await expect(runAdmissionJob({ kind: 'git', argv: ['stamp'], cwd: repo })).rejects.toMatchObject({
      name: 'AdmissionOffthreadBusyError',
      code: 'ADMISSION_OFFTHREAD_BUSY',
    });
    await expect(first).resolves.toMatchObject({ status: 0 });
    await expect(runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo })).resolves.toMatchObject({
      status: 0,
    });
    expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, jobsInline: 0, loadFailures: 0 });
  }, 60_000);

  it('terminates a worker that exceeds an opt-in preview deadline and accepts later work', async () => {
    const stuckWorker = join(repo, 'stuck-admission-worker.mjs');
    writeFileSync(
      stuckWorker,
      [
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.postMessage({ type: 'ready' });",
        "parentPort.on('message', () => { while (true) {} });",
      ].join('\n'),
    );
    // A test:file run inherits committed-source-loader via NODE_OPTIONS. The fixture
    // worker is deliberately uncommitted and has no loader-aware source, so remove the
    // repository guard while exercising worker termination, then restore the caller env.
    const inheritedNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '';
    try {
      configureAdmissionOffthread({ workerPath: stuckWorker });

      await expect(
        runAdmissionJob(
          { kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo },
          { timeoutMs: 100, stepName: 'build-proof' },
        ),
      ).rejects.toMatchObject({
        name: 'AdmissionOffthreadTimeoutError',
        code: 'ADMISSION_OFFTHREAD_TIMEOUT',
        jobKind: 'git',
        stepName: 'build-proof',
        timeoutMs: 100,
      });
      expect(admissionOffthreadStats().workerLive).toBe(false);

      configureAdmissionOffthread({ workerPath: null });
      await expect(runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo })).resolves.toMatchObject({
        status: 0,
      });
      expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, jobsInline: 0, loadFailures: 0 });
    } finally {
      if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = inheritedNodeOptions;
    }
  }, 60_000);

  it('reaps an idle worker and starts a fresh worker for later work', async () => {
    // idle-window-ok: the test needs the idle reap to fire; vi.waitFor below tolerates load.
    configureAdmissionOffthread({ idleMs: 10 });
    await expect(runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo })).resolves.toMatchObject({
      status: 0,
    });
    await vi.waitFor(() => expect(admissionOffthreadStats().workerLive).toBe(false), { timeout: 2_000, interval: 10 });
    await expect(runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo })).resolves.toMatchObject({
      status: 0,
    });
    expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, jobsInline: 0, loadFailures: 0 });
  }, 60_000);

  it('rethrows a builder exception with its message and a worker-thread stack frame', async () => {
    const failing = runAdmissionJob({
      kind: 'admit',
      input: {
        root: repo,
        candidate: 'c'.repeat(40),
        repairHead: 'd'.repeat(40),
        paths: ['a.txt'],
        source: { ref: 'staging' },
        actor: 'test',
        nowMs: 0,
      },
      preflight: null,
    });
    await expect(failing).rejects.toThrow(/nowMs must be a positive timestamp/);
    await expect(failing).rejects.toHaveProperty('stack', expect.stringContaining('<admission worker thread>'));
    // The worker survives a job error and serves the next job.
    await expect(runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo })).resolves.toMatchObject({
      status: 0,
    });
    expect(admissionOffthreadStats()).toMatchObject({ jobsOnWorker: 2, loadFailures: 0 });
  }, 60_000);

  it('falls back inline — loudly — only when the worker cannot load', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    configureAdmissionOffthread({ workerPath: join(repo, 'no-such-worker.mjs') });
    const result = await runAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo });
    expect(result).toEqual(executeAdmissionJob({ kind: 'git', argv: ['rev-parse', 'HEAD'], cwd: repo }));
    expect(admissionOffthreadStats()).toMatchObject({ loadFailures: 1, jobsInline: 1, jobsOnWorker: 0 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('running admission git INLINE'));
  }, 60_000);
});

/**
 * Coverage for testing-run-store — the in-memory detached test-run map.
 * node:child_process is a controllable fake child; runs use kind 'vitest' so
 * the close handler's PG fallback-persist short-circuits (no DB). resetModules
 * per test isolates the module-level _runs map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import { MAX_RECORDED_PASSED_CASES } from '@papercusp/test-config/execution-details';

/**
 * Map a captured `INSERT INTO … (col, …) VALUES (${…}, …)` call onto its column names.
 * Every test_runs column is a bound parameter, so the n-th value is the n-th column.
 * Reading by name keeps a new column (migration 1448 added configuration_snapshot)
 * from silently shifting every fixture's positional index.
 */
function insertedColumns(strings: readonly string[], values: readonly unknown[]): Record<string, unknown> {
  const columns = /\(([^()]*)\)\s*VALUES/i.exec(strings.join(''))?.[1];
  if (!columns) throw new Error('insertedColumns: statement has no (columns) VALUES list');
  const names = columns.split(',').map((name) => name.trim());
  if (names.length !== values.length) {
    throw new Error(`insertedColumns: ${names.length} columns but ${values.length} bound values`);
  }
  return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}

interface FakeChild {
  stdout: { on: (e: string, cb: (b: Buffer) => void) => void };
  stderr: { on: (e: string, cb: (b: Buffer) => void) => void };
  on: (e: string, cb: (arg: unknown) => void) => void;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  _emitError: (error: Error) => void;
  _emitStdout: (chunk: string) => void;
  _emitClose: (code: number) => void;
}
let lastChild: FakeChild;

function makeChild(): FakeChild {
  const closeCbs: Array<(c: number) => void> = [];
  const errorCbs: Array<(error: Error) => void> = [];
  const stdoutCbs: Array<(b: Buffer) => void> = [];
  const child: FakeChild = {
    stdout: { on: (_e, cb) => stdoutCbs.push(cb) },
    stderr: { on: () => {} },
    on: (e, cb) => {
      if (e === 'close') closeCbs.push(cb as (c: number) => void);
      if (e === 'error') errorCbs.push(cb as (error: Error) => void);
    },
    pid: 4242,
    kill: vi.fn(),
    killed: false,
    _emitError: (error) => errorCbs.forEach((cb) => cb(error)),
    _emitStdout: (chunk) => stdoutCbs.forEach((cb) => cb(Buffer.from(chunk))),
    _emitClose: (code) => closeCbs.forEach((cb) => cb(code)),
  };
  return child;
}

const spawnMock = vi.fn(() => {
  lastChild = makeChild();
  return lastChild;
});
const execFileSyncMock = vi.fn();
const persistSqlMock = vi.fn();
const outputIo = vi.hoisted(() => ({
  wholeReads: [] as string[], reads: [] as Array<{ path: string; requested: number; bytes: number }>,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isOutput = (path: unknown) => /\.(stdout|stderr)\.log$/.test(String(path));
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (isOutput(args[0])) outputIo.wholeReads.push(String(args[0]));
      return actual.readFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!isOutput(args[0])) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await target.read(buffer, offset, length, position);
          outputIo.reads.push({ path: String(args[0]), requested: length, bytes: result.bytesRead });
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
});
const RUN_STARTED_AT = '2026-10-15T10:00:00.000Z';
const taskManagerMocks = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  finish: vi.fn(),
  scopePath: vi.fn(),
}));
const worktreeSnapshotMocks = vi.hoisted(() => ({
  captureAsync: vi.fn(),
}));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...a: unknown[]) => spawnMock(...(a as [])),
    execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
  };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>().catch(
    () => ({}) as typeof import('@papercusp/db-org'),
  );
  return {
    ...actual,
    getOrgPg: () => ({ sql: persistSqlMock }),
  };
});
vi.mock('./task-manager/enroll-sync', () => ({
  beginSyncEnrolment: (...args: unknown[]) => taskManagerMocks.begin(...args),
  completeSyncEnrolment: (...args: unknown[]) => taskManagerMocks.complete(...args),
  finishSyncEnrolment: (...args: unknown[]) => taskManagerMocks.finish(...args),
  syncEnrolmentScopePath: (...args: unknown[]) => taskManagerMocks.scopePath(...args),
}));
vi.mock('./testing-worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./testing-worktree')>();
  return {
    ...actual,
    captureWorktreeSnapshotAsync: async (root: string) => {
      if (worktreeSnapshotMocks.captureAsync.getMockImplementation()) {
        return worktreeSnapshotMocks.captureAsync(root);
      }
      return actual.captureWorktreeSnapshot(root);
    },
  };
});

type Store = typeof import('./testing-run-store');
function measuredPass(filePath: string, runGroupId: string | null) {
  return {
    schemaVersion: 1, root: '/tmp', filePath, runGroupId,
    workspaceId: null, harnessSlug: null, testNamePattern: 'selected assertion',
    passed: 7, failed: 0, skipped: 118, collectionFailed: false,
    mutationPhase: null, commitSha: null, worktreeDirty: false,
  };
}
const req = (over: Partial<Parameters<Store['startRun']>[0]> = {}) =>
  ({ kind: 'vitest' as const, label: 'L', command: 'npx', args: ['vitest', 'run'], cwd: '/tmp', ...over });

let store: Store;
beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockClear();
  execFileSyncMock.mockReset();
  persistSqlMock.mockReset();
  worktreeSnapshotMocks.captureAsync.mockReset();
  Object.assign(persistSqlMock, { begin: (run: (tx: typeof persistSqlMock) => Promise<unknown>) => run(persistSqlMock) });
  taskManagerMocks.begin.mockReset();
  taskManagerMocks.complete.mockReset();
  taskManagerMocks.finish.mockReset();
  taskManagerMocks.scopePath.mockReset();
  taskManagerMocks.scopePath.mockReturnValue(null);
  taskManagerMocks.begin.mockImplementation(() => ({
    taskId: 'task-test-run',
    confined: false,
    scopeUnit: null,
    enrolled: true,
    registrationReady: null,
    releaseEnvironmentTransport: vi.fn(),
    wrap: vi.fn((binary: string, argv: string[]) => ({ binary, argv })),
  }));
  store = await import('./testing-run-store');
});

describe('worktree provenance API', () => {
  it('exposes async snapshots to direct testing:run callers', async () => {
    const snapshot = { commit: 'current-commit', porcelain: '' };
    worktreeSnapshotMocks.captureAsync.mockResolvedValue(snapshot);

    expect(store.captureWorktreeSnapshotAsync).toBeTypeOf('function');
    await expect(store.captureWorktreeSnapshotAsync('/test-checkout')).resolves.toEqual(snapshot);
    expect(worktreeSnapshotMocks.captureAsync).toHaveBeenCalledWith('/test-checkout');
  });
});

describe('startRun', () => {
  it('returns a running snapshot and spawns the command', () => {
    const snap = store.startRun(req());
    expect(snap.status).toBe('running');
    expect(snap.command).toEqual(['npx', 'vitest', 'run']);
    expect(snap.runId).toBeTruthy();
    expect(spawnMock).toHaveBeenCalledWith('npx', ['vitest', 'run'], expect.objectContaining({ cwd: '/tmp' }));
  });

  it('preserves the exact requested Vitest file manifest in the snapshot and task detail', () => {
    const requestedFiles = ['lib/first.test.ts', 'lib/second.test.ts'];
    const snap = store.startRun(req({ requestedFiles }));
    requestedFiles.push('lib/late.test.ts');

    expect(snap.requestedFiles).toEqual(['lib/first.test.ts', 'lib/second.test.ts']);
    expect(taskManagerMocks.begin.mock.calls[0]?.[0].detail).toMatchObject({
      requestedFiles: ['lib/first.test.ts', 'lib/second.test.ts'],
    });
  });

  it('merges caller environment into the child while preserving run-owned markers', () => {
    const snap = store.startRun(
      req({
        env: {
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_GROUP: 'caller-group-must-not-win',
        },
      }),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run'],
      expect.objectContaining({
        env: expect.objectContaining({
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_GROUP: snap.runId,
        }),
      }),
    );
  });

  it.each([true, false])('stamps verifier ownership from task enrollment=%s instead of an inherited task', (enrolled) => {
    const enrolment = {
      taskId: 'task-current-test-run', confined: false, scopeUnit: null, enrolled,
      registrationReady: null, releaseEnvironmentTransport: vi.fn(),
      wrap: vi.fn((binary: string, argv: string[], _env: NodeJS.ProcessEnv, _cwd: string) => ({ binary, argv })),
    };
    taskManagerMocks.begin.mockReturnValueOnce(enrolment);
    store.startRun(req({ env: { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'parent-or-forged-task' } }));

    // Compare only provenance: an environment-object diff can expose inherited credentials.
    const expected = enrolled ? enrolment.taskId : '';
    const wrappedEnv = (enrolment.wrap.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv])[2];
    const spawnedOptions = (spawnMock.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2];
    expect(wrappedEnv.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID).toBe(expected);
    expect(spawnedOptions.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID).toBe(expected);
  });

  it('preserves an explicit local provenance for detached recovery reporters', () => {
    const snap = store.startRun(req({
      testRunSource: 'local',
      env: {
        PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
        PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
      },
    }));

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run'],
      expect.objectContaining({
        env: expect.objectContaining({
          PAPERCUSP_TEST_RUN_SOURCE: 'local',
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_GROUP: snap.runId,
        }),
      }),
    );
  });

  it('enrols before spawning and wraps the command with the exact task spec/env/cwd', () => {
    const enrolment = {
      taskId: 'task-confined',
      confined: true,
      scopeUnit: 'pc-task-confined.scope',
      enrolled: true,
      registrationReady: null,
      releaseEnvironmentTransport: vi.fn(),
      wrap: vi.fn((binary: string, argv: string[], _env: unknown, _cwd: string) => ({
        binary: 'systemd-run',
        argv: ['--unit=pc-task-confined.scope', binary, ...argv],
      })),
    };
    taskManagerMocks.begin.mockReturnValueOnce(enrolment);
    taskManagerMocks.scopePath.mockReturnValueOnce('/user.slice/papercusp.slice/pc-task-confined.scope');

    const snap = store.startRun(
      req({ label: 'a'.repeat(400), command: 'node', args: ['worker.js'], runtimeMaxSec: 900 }),
    );
    const beginOrder = taskManagerMocks.begin.mock.invocationCallOrder[0]!;
    const spawnOrder = spawnMock.mock.invocationCallOrder[0]!;
    const completeOrder = taskManagerMocks.complete.mock.invocationCallOrder[0]!;

    expect(beginOrder).toBeLessThan(spawnOrder);
    expect(spawnOrder).toBeLessThan(completeOrder);
    expect(taskManagerMocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        class: 'test-run',
        title: 'a'.repeat(300),
        argv: ['node', 'worker.js'],
        cwd: '/tmp',
        runtimeMaxSec: 900,
        launchedBy: 'testing-run-store',
        detail: { runId: snap.runId, kind: 'vitest' },
      }),
    );
    expect(enrolment.wrap).toHaveBeenCalledWith(
      'node',
      ['worker.js'],
      expect.objectContaining({
        PAPERCUSP_TEST_RUN_GROUP: snap.runId,
        PAPERCUSP_TEST_ATTRIBUTION: '1',
        PAPERCUSP_TEST_RUN_SOURCE: 'admin-ui',
      }),
      '/tmp',
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'systemd-run',
      ['--unit=pc-task-confined.scope', 'node', 'worker.js'],
      expect.objectContaining({ cwd: '/tmp', env: expect.any(Object), detached: true }),
    );
    expect(taskManagerMocks.complete).toHaveBeenCalledWith(enrolment, expect.objectContaining({
      class: 'test-run',
      argv: ['node', 'worker.js'],
      cwd: '/tmp',
      runtimeMaxSec: 900,
      launchedBy: 'testing-run-store',
      detail: { runId: snap.runId, kind: 'vitest' },
    }), 4242);
  });

  it('finishes the enrolled task on a synchronous spawn error', () => {
    const spawnError = new Error('spawn unavailable');
    spawnMock.mockImplementationOnce(() => {
      throw spawnError;
    });

    const snap = store.startRun(req({ command: 'missing' }));
    const enrolment = taskManagerMocks.begin.mock.results[0]?.value;

    expect(snap.status).toBe('error');
    expect(taskManagerMocks.complete).not.toHaveBeenCalled();
    expect(taskManagerMocks.finish).toHaveBeenCalledWith(
      enrolment,
      { state: 'exited', exitCode: null, exitReason: 'spawn error: spawn unavailable' },
      { scopeCgroupPath: null },
    );
  });
});

describe('startRunAsync', () => {
  it('waits for every worktree snapshot before spawning the child', async () => {
    const resolvers = new Map<string, (snapshot: { commit: string; porcelain: string }) => void>();
    worktreeSnapshotMocks.captureAsync.mockImplementation((root: string) => new Promise<{ commit: string; porcelain: string }>(resolve => {
      resolvers.set(root, resolve);
    }));

    const pending = store.startRunAsync(req({
      detachedReportArtifacts: [{ reportPath: '/tmp/report.json', root: '/tmp/artifact-root' }],
    }));

    await vi.waitFor(() => expect(worktreeSnapshotMocks.captureAsync).toHaveBeenCalledTimes(1));
    expect(worktreeSnapshotMocks.captureAsync).toHaveBeenCalledWith('/tmp');
    expect(spawnMock).not.toHaveBeenCalled();

    resolvers.get('/tmp')!({ commit: 'b'.repeat(40), porcelain: '' });
    await vi.waitFor(() => expect(worktreeSnapshotMocks.captureAsync).toHaveBeenCalledTimes(2));
    expect(worktreeSnapshotMocks.captureAsync).toHaveBeenLastCalledWith('/tmp/artifact-root');
    expect(spawnMock).not.toHaveBeenCalled();

    resolvers.get('/tmp/artifact-root')!({ commit: 'c'.repeat(40), porcelain: '' });
    const snapshot = await pending;

    expect(snapshot.status).toBe('running');
    expect(spawnMock).toHaveBeenCalledWith(
      'npx', ['vitest', 'run'], expect.objectContaining({ cwd: '/tmp' }),
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('task lifecycle handlers', () => {
  it('retains a saved report when close-time ledger ingestion fails', async () => {
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-retain-');
    const reportPath = join(reportDir, 'report.json');
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      await writeFile(reportPath, JSON.stringify({ testResults: [{
        name: '/tmp/lib/saved.test.ts', status: 'passed',
        assertionResults: [{ status: 'passed' }],
      }] }));
      let finalized!: () => void;
      const done = new Promise<void>(resolve => { finalized = resolve; });
      persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        if (statement.includes('INSERT INTO harness_shared.test_runs')) throw new Error('ledger unavailable');
        if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'pass') finalized();
        return [];
      });
      store.startRun(req({ detachedReportArtifacts: [{ reportPath, root: '/tmp',
        scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
      }] }));
      lastChild._emitClose(0);
      await done;
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('testResults');
      expect(persistSqlMock.mock.calls.some(call => call[0].join(' ').includes('pg_advisory_xact_lock'))).toBe(true);
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
      await rm(reportDir, { recursive: true, force: true });
    }
  });

  // WI-10006949: an unscoped artifact (a superuser call carries the '*' harness) used to be
  // marked consumed and DELETED with no test_runs row, so the run's evidence vanished silently.
  it('retains an UNSCOPED report and says its rows were not written, instead of deleting it', async () => {
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-unscoped-');
    const reportPath = join(reportDir, 'report.json');
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      await writeFile(reportPath, JSON.stringify({ testResults: [{
        name: '/tmp/lib/unscoped.integration.test.ts', status: 'passed',
        assertionResults: [{ status: 'passed' }],
      }] }));
      let finalized!: () => void;
      const done = new Promise<void>(resolve => { finalized = resolve; });
      persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'pass') finalized();
        return [];
      });
      store.startRun(req({ detachedReportArtifacts: [{ reportPath, root: '/tmp' }] }));
      lastChild._emitClose(0);
      await done;
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('testResults');
      expect(persistSqlMock.mock.calls.some(call => call[0].join(' ').includes('INSERT INTO harness_shared.test_runs'))).toBe(false);
      expect(JSON.stringify(persistSqlMock.mock.calls)).toContain('were NOT written to test_runs');
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
      await rm(reportDir, { recursive: true, force: true });
    }
  });

  it('uses file-backed sinks for local detached recovery so a host restart cannot close its stdout pipe', async () => {
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-detached-sinks-');
    const reportPath = join(reportDir, 'papercusp-testing-run-detached-report.json');
    try {
      const snap = store.startRun(req({
        testRunSource: 'local',
        detachedReportArtifacts: [{
          reportPath,
          root: '/tmp',
          scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
        }],
      }));
      const detail = taskManagerMocks.begin.mock.calls[0]?.[0]?.detail as {
        detachedReportArtifacts?: { artifacts?: Array<{ stdoutPath?: string; stderrPath?: string }> };
      };
      const artifact = detail.detachedReportArtifacts?.artifacts?.[0];
      expect(artifact?.stdoutPath).toContain(`${snap.runId}.stdout.log`);
      expect(artifact?.stderrPath).toContain(`${snap.runId}.stderr.log`);
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['vitest', 'run'],
        expect.objectContaining({
          detached: true,
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
        }),
      );

      await writeFile(artifact!.stdoutPath!, 'child output retained across restart\n');
      // The file-backed output is read by the close-time finalizer even though no
      // operator-owned stdout pipe exists to deliver this chunk.
      lastChild._emitClose(0);
      await vi.waitFor(() => expect(store.getRun(snap.runId)?.output).toContain('child output retained across restart'));
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
  });

  it('finishes once on child error even when the child subsequently closes', () => {
    const snap = store.startRun(req());
    const enrolment = taskManagerMocks.begin.mock.results[0]?.value;
    const childError = new Error('ENOENT');

    lastChild._emitError(childError);
    lastChild._emitClose(1);

    expect(store.getRun(snap.runId)?.status).toBe('error');
    expect(taskManagerMocks.finish).toHaveBeenCalledTimes(1);
    expect(taskManagerMocks.finish).toHaveBeenCalledWith(
      enrolment,
      { state: 'exited', exitCode: null, exitReason: 'spawn error: ENOENT' },
      { scopeCgroupPath: null },
    );
  });

  it('finishes a normal close with the observed exit code and derived scope path', () => {
    taskManagerMocks.scopePath.mockReturnValueOnce('/user.slice/pc-test-run.scope');
    const snap = store.startRun(req());
    const enrolment = taskManagerMocks.begin.mock.results[0]?.value;
    lastChild._emitClose(7);

    expect(store.getRun(snap.runId)?.status).toBe('fail');
    expect(taskManagerMocks.finish).toHaveBeenCalledWith(
      enrolment,
      { state: 'exited', exitCode: 7 },
      { scopeCgroupPath: '/user.slice/pc-test-run.scope' },
    );
  });

  it('ingests a detached reporter-less JSON artifact on close and cleans it up', async () => {
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-store-report-');
    const reportPath = join(reportDir, 'report.json');
    const failureDetailsPath = join(reportDir, 'failure-details.json');
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      // Warm the mocked database module before the close handler starts its
      // fail-soft dynamic import; cold import resolution can exceed the
      // lifecycle assertion's bounded wait under the full Vitest suite.
      await import('@papercusp/db-org');
      await writeFile(
        reportPath,
        JSON.stringify({
          testResults: [
            {
              name: '/tmp/packages/external/example.test.ts',
              status: 'failed',
              startTime: 1_700_000_000_000,
              endTime: 1_700_000_000_025,
              assertionResults: [
                ...Array.from({ length: MAX_RECORDED_PASSED_CASES + 1 }, (_, index) => ({
                  status: 'passed',
                  fullName: 'suite > passed case ' + index,
                })),
                {
                  status: 'failed',
                  fullName: 'suite > works',
                  failureMessages: ['expected a structured diff'],
                },
              ],
            },
          ],
        }),
      );
      await writeFile(
        failureDetailsPath,
        JSON.stringify({
          failures: [{
            file: '/tmp/packages/external/example.test.ts',
            test: 'suite > works',
            actual: 'actual-value',
            expected: 'expected-value',
          }],
        }),
      );
      execFileSyncMock.mockImplementation((_command: string, args: string[]) =>
        args[0] === 'rev-parse' ? 'detached-sha\n' : '',
      );
      let resolveTerminalSnapshot!: () => void;
      const terminalSnapshotPersisted = new Promise<void>((resolve) => {
        resolveTerminalSnapshot = resolve;
      });
      persistSqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'fail') {
          resolveTerminalSnapshot();
        }
        return Promise.resolve([{ id: 42 }]);
      });

      const snapshot = store.startRun(
        req({
          detachedReportArtifacts: [
            {
              reportPath,
              failureDetailsPath,
              root: '/tmp',
              testNamePattern: 'suite > works',
              scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
            },
          ],
        }),
      );
      lastChild._emitStdout('x'.repeat(16 * 1024));
      lastChild._emitClose(1);

      await terminalSnapshotPersisted;
      const [strings, ...values] = persistSqlMock.mock.calls.find((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.test_runs'),
      ) ?? [];
      expect(strings?.join(' ')).toContain('INSERT INTO harness_shared.test_runs');
      const inserted = insertedColumns(strings!, values);
      expect(inserted.file_path).toBe('packages/external/example.test.ts');
      expect(inserted.status).toBe('fail');
      expect(inserted.run_group_id).toBe(snapshot.runId);
      expect(inserted.source).toBe('local');
      expect(inserted.harness_slug).toBe('papercusp');
      expect(inserted.workspace_id).toBe('papercusp-workspace');
      // EI-24799048791133095: the jsonb param must be the OBJECT. A pre-stringified
      // value is double-encoded by postgres-js's default serializer into a jsonb
      // STRING scalar, and every `execution_details->>'key'` read returns NULL.
      const executionDetails = inserted.execution_details;
      expect(typeof executionDetails).toBe('object');
      expect(executionDetails).toMatchObject({
        schemaVersion: 1,
        root: '/tmp',
        filePath: 'packages/external/example.test.ts',
        runGroupId: snapshot.runId,
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercusp',
        testNamePattern: 'suite > works',
        passed: MAX_RECORDED_PASSED_CASES + 1,
        failed: 1,
        skipped: 0,
        collectionFailed: false,
        passedCaseTitlesTruncated: true,
        commitSha: 'detached-sha',
        worktreeDirty: false,
      });
      expect((executionDetails as { passedCaseTitles: string[] }).passedCaseTitles)
        .toHaveLength(MAX_RECORDED_PASSED_CASES);
      expect((executionDetails as { passedCaseTitles: string[] }).passedCaseTitles[0])
        .toBe('suite > passed case 0');
      // P-011: the row records the configuration the MEASURED child ran under, as an object.
      expect(inserted.configuration_snapshot).toMatchObject({
        schemaVersion: 1,
        fingerprint: expect.stringMatching(/^sha256-config-snapshot-v1:[0-9a-f]{64}$/),
      });
      const snapshotCalls = persistSqlMock.mock.calls.filter((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots'),
      );
      const finalSnapshotValues = snapshotCalls.at(-1)?.slice(1) ?? [];
      expect(finalSnapshotValues[5]).toBe('fail');
      expect(finalSnapshotValues[9]).toContain('suite > works');
      expect(finalSnapshotValues[9]).toContain('actual: actual-value');
      expect(finalSnapshotValues[9]).toContain('expected: expected-value');
      expect(finalSnapshotValues[9]).toHaveLength(16 * 1024);
      expect(finalSnapshotValues[10]).toBe(true);
      const testRunCallIndex = persistSqlMock.mock.calls.findIndex((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.test_runs'),
      );
      const finalSnapshotCallIndex = persistSqlMock.mock.calls.findIndex((call) =>
        call[0]?.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots') && call[6] === 'fail',
      );
      expect(finalSnapshotCallIndex).toBeGreaterThan(testRunCallIndex);
      await vi.waitFor(async () => expect(readFile(reportPath)).rejects.toThrow());
      await vi.waitFor(async () => expect(readFile(failureDetailsPath)).rejects.toThrow());
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
      await rm(reportDir, { recursive: true, force: true });
    }
  });
});

describe('getRun', () => {
  it('returns a copy of a known run, null otherwise', () => {
    const snap = store.startRun(req());
    expect(store.getRun(snap.runId)?.runId).toBe(snap.runId);
    expect(store.getRun('no-such-run')).toBeNull();
  });
});

describe('listRuns', () => {
  it('lists started runs and honors the limit', () => {
    const a = store.startRun(req({ label: 'a' }));
    const b = store.startRun(req({ label: 'b' }));
    const ids = store.listRuns().map((r) => r.runId);
    expect(ids).toContain(a.runId);
    expect(ids).toContain(b.runId);
    expect(store.listRuns(1)).toHaveLength(1);
  });
});

describe('cancelRun', () => {
  it('marks cancelled + SIGTERMs the proc; returns true', () => {
    const snap = store.startRun(req());
    expect(store.cancelRun(snap.runId)).toBe(true);
    expect(store.getRun(snap.runId)?.status).toBe('cancelled');
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('returns false for an unknown or already-finished run', () => {
    expect(store.cancelRun('nope')).toBe(false);
    const snap = store.startRun(req());
    store.cancelRun(snap.runId);
    expect(store.cancelRun(snap.runId)).toBe(false); // already cancelled
  });
});

describe('close handler', () => {
  it('exit 0 → pass, non-zero → fail', () => {
    const a = store.startRun(req());
    lastChild._emitClose(0);
    expect(store.getRun(a.runId)?.status).toBe('pass');

    const b = store.startRun(req());
    lastChild._emitClose(1);
    expect(store.getRun(b.runId)?.status).toBe('fail');
  });

  it('a cancelled run stays cancelled even after close', () => {
    const snap = store.startRun(req());
    store.cancelRun(snap.runId);
    lastChild._emitClose(0);
    expect(store.getRun(snap.runId)?.status).toBe('cancelled');
  });
});

describe('computeWorktreeDirty (EI-18795303393201472)', () => {
  const clean = (commit: string) => ({ commit, porcelain: '' });

  it('same commit, clean porcelain before and after ⇒ not dirty', () => {
    expect(store.computeWorktreeDirty(clean('abc'), clean('abc'))).toBe(false);
  });

  it('HEAD moved between snapshots ⇒ dirty (a commit landed mid-run)', () => {
    expect(store.computeWorktreeDirty(clean('abc'), clean('def'))).toBe(true);
  });

  it('uncommitted changes to the tested files BEFORE the run ⇒ dirty', () => {
    expect(store.computeWorktreeDirty({ commit: 'abc', porcelain: ' M file.ts' }, clean('abc'))).toBe(true);
  });

  it('uncommitted changes to the tested files AFTER the run ⇒ dirty (the torn-read case)', () => {
    expect(store.computeWorktreeDirty(clean('abc'), { commit: 'abc', porcelain: ' M file.ts' })).toBe(true);
  });

  it('an unreadable git snapshot (null commit) is treated as dirty, fail-safe', () => {
    expect(store.computeWorktreeDirty({ commit: null, porcelain: '' }, clean('abc'))).toBe(true);
    expect(store.computeWorktreeDirty(clean('abc'), { commit: null, porcelain: '' })).toBe(true);
  });

  it('an unreadable porcelain read (null, git errored) is treated as dirty, fail-safe', () => {
    expect(store.computeWorktreeDirty({ commit: 'abc', porcelain: null }, clean('abc'))).toBe(true);
  });
});

describe('persistHarnessTestRuns worktree_dirty (EI-18795303393201472)', () => {
  const oneRow = () => [
    {
      filePath: 'lib/x.test.ts',
      status: 'fail' as const,
      durationMs: 10,
      // HarnessTestFileRow types these as Date, not string — vitest never typechecks, so
      // the ISO-string form passed here read as green locally and only surfaced at tsc.
      startedAt: new Date(),
      finishedAt: new Date(),
      outputTail: null,
    },
  ];

  it('defaults worktree_dirty to false when the caller omits it', async () => {
    let captured: Record<string, unknown> = {};
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = insertedColumns(strings, values);
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: oneRow(),
      runGroupId: 'g1',
      runStartedAt: RUN_STARTED_AT,
      sql: fakeSql,
    });
    expect(captured.worktree_dirty).toBe(false);
    // P-011: a caller that cannot name the measured process's configuration records NULL, not a guess.
    expect(captured).toHaveProperty('configuration_snapshot', null);
  });

  it('carries worktree_dirty:true through to the insert when the caller marks the run dirty', async () => {
    let captured: Record<string, unknown> = {};
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = insertedColumns(strings, values);
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: oneRow(),
      runGroupId: 'g1',
      runStartedAt: RUN_STARTED_AT,
      worktreeDirty: true,
      sql: fakeSql,
    });
    expect(captured.worktree_dirty).toBe(true);
  });

  it('adds the caller run start to measured rows that lack reporter timing', async () => {
    let captured: Record<string, unknown> = {};
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = insertedColumns(strings, values);
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: [{ ...oneRow()[0]!, execution: { passed: 1, failed: 0, skipped: 0, collectionFailed: false } }],
      runGroupId: 'g1',
      runStartedAt: RUN_STARTED_AT,
      root: '/tmp',
      sql: fakeSql,
    });
    expect(captured.execution_details).toMatchObject({ runStartedAt: RUN_STARTED_AT });
  });

  it('preserves the reporter run start over the parent fallback timestamp', async () => {
    let captured: Record<string, unknown> = {};
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = insertedColumns(strings, values);
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    const reporterStartedAt = '2026-10-15T09:59:00.000Z';
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: [{ ...oneRow()[0]!, execution: {
        passed: 1, failed: 0, skipped: 0, collectionFailed: false, runStartedAt: reporterStartedAt,
      } }],
      runGroupId: 'g1',
      runStartedAt: RUN_STARTED_AT,
      root: '/tmp',
      sql: fakeSql,
    });
    expect(captured.execution_details).toMatchObject({ runStartedAt: reporterStartedAt });
  });

  it('carries the caller-supplied configuration snapshot through to the insert as an object (P-011)', async () => {
    let captured: Record<string, unknown> = {};
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = insertedColumns(strings, values);
      return Promise.resolve([]);
    }) as Parameters<Store['persistHarnessTestRuns']>[0]['sql'];
    const configurationSnapshot = captureConfigurationSnapshot({ PAPERCUSP_FLAG_VIDEO_CHANNELS: '1' });
    await store.persistHarnessTestRuns({
      harnessSlug: 'papercusp',
      workspaceId: 'ws',
      rows: oneRow(),
      runGroupId: 'g1',
      runStartedAt: RUN_STARTED_AT,
      configurationSnapshot,
      sql: fakeSql,
    });
    expect(captured.configuration_snapshot).toEqual(configurationSnapshot);
  });
});

describe('durable detached snapshot lifecycle', () => {
  type Sql = Parameters<Store['persistRunSnapshot']>[1];

  it('retains running output across observer restart before the child closes', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_PERSIST', '1');
    vi.useFakeTimers();
    let durable: Record<string, unknown> | undefined;
    const writes: Record<string, unknown>[] = [];
    persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots')) {
        durable = insertedColumns(strings, values);
        writes.push({ ...durable });
      }
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return durable ? [{ ...durable, task_state: 'running', task_deadline_at: null }] : [];
      }
      return [];
    });
    try {
      const run = store.startRun(req());
      await vi.advanceTimersByTimeAsync(0);
      lastChild._emitStdout('ADMISSION_HTTP_PHASE preparing-private-runtime\n');
      lastChild._emitStdout('x'.repeat(20 * 1024) + '\nADMISSION_HTTP_PHASE waiting-for-precheck\n');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toHaveLength(2); // initial snapshot and one coalesced progress write
      expect(durable).toMatchObject({ status: 'running', finished_at: null, truncated: true });
      expect(String(durable?.output)).toHaveLength(16 * 1024);
      expect(String(durable?.output)).toContain('waiting-for-precheck');

      vi.resetModules(); // lose the observer's local run map, without a child close notification
      const restarted = await import('./testing-run-store');
      const recovered = await restarted.getRunAsync(run.runId, persistSqlMock as unknown as Sql);
      expect(recovered).toMatchObject({ status: 'running', exitCode: null, finishedAt: null, truncated: true });
      expect(recovered?.output).toBe(durable?.output);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('serializes an in-flight progress write before the terminal snapshot', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUNS_PERSIST', '1');
    vi.useFakeTimers();
    let releaseProgress: (() => void) | undefined;
    const writes: Record<string, unknown>[] = [];
    persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots')) return [];
      const row = insertedColumns(strings, values);
      if (row.status === 'running' && row.output === 'last observed phase\n') {
        await new Promise<void>(resolve => { releaseProgress = resolve; });
      }
      writes.push(row);
      return [];
    });
    try {
      const run = store.startRun(req());
      await vi.advanceTimersByTimeAsync(0);
      lastChild._emitStdout('last observed phase\n');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(releaseProgress).toBeTypeOf('function');
      lastChild._emitClose(1);
      // The caller's persistence budget can expire while SQL is still live.
      // Terminal SQL must remain queued behind that actual settlement.
      await vi.advanceTimersByTimeAsync(1_001);
      expect(writes.some(row => row.status === 'fail')).toBe(false);
      releaseProgress!();
      await vi.advanceTimersByTimeAsync(0);
      const ended = await store.getRunAsync(run.runId);
      expect(ended).toMatchObject({ status: 'fail', exitCode: 1, output: 'last observed phase\n' });
      expect(writes.map(row => row.status)).toEqual(['running', 'running', 'fail']);
    } finally {
      releaseProgress?.();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { name: 'running snapshot', status: 'running', expected: 'pass' },
    { name: 'prior no-verdict error', status: 'error', expected: 'pass' },
    { name: 'closed snapshot missing ledger', status: 'pass', expected: 'pass' },
    { name: 'failing assertions', status: 'running', expected: 'fail', failure: true },
    { name: 'cancelled task', status: 'cancelled', expected: 'cancelled', cancelled: true },
    { name: 'partial report', status: 'running', expected: 'error', partial: true },
    { name: 'failed ledger insert', status: 'running', expected: 'error', writeFailure: true },
    { name: 'lost snapshot CAS', status: 'running', expected: 'running', casLost: true },
    { name: 'legacy command metadata', status: 'running', expected: 'pass', legacy: true },
    { name: 'legacy inline selector', status: 'running', expected: 'pass', legacy: true, inlineSelector: true },
    { name: 'legacy wrong tenant', status: 'running', expected: 'error', legacy: true, wrongScope: true },
    { name: 'expired legacy snapshot', status: 'error', expected: 'pass', legacy: true, expired: true },
    { name: 'pruned legacy snapshot', status: 'running', expected: 'pass', legacy: true, expired: true, missing: true },
    { name: 'pruned legacy inline selector', status: 'running', expected: 'pass', legacy: true, expired: true, missing: true, inlineSelector: true },
    { name: 'pruned snapshot wrong tenant', status: 'running', expected: null, legacy: true, expired: true, missing: true, wrongScope: true },
    { name: 'pruned snapshot partial report', status: 'running', expected: null, legacy: true, expired: true, missing: true, partial: true },
    { name: 'pruned snapshot ambiguous task', status: 'running', expected: null, legacy: true, expired: true, missing: true, ambiguous: true },
    { name: 'ended_unobserved retained PASS', status: 'running', expected: 'pass', taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved retained FAIL', status: 'error', expected: 'fail', failure: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved report redacts child-only text without launch environment', status: 'running', expected: 'fail', failure: true, taskState: 'ended_unobserved', processExit: null, secretOutput: true },
    { name: 'ended_unobserved non-router report cannot recover an all-pass subset', status: 'running', expected: 'error', taskState: 'ended_unobserved', processExit: null, missingRequestedFile: true },
    { name: 'ended_unobserved router groups', status: 'running', expected: 'pass', routerReports: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved missing router group', status: 'running', expected: 'error', routerReports: true, missingRouterGroup: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved partial router group', status: 'running', expected: 'error', routerReports: true, partialRouterGroup: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved pruned PASS', status: 'running', expected: 'pass', legacy: true, expired: true, missing: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved pruned FAIL', status: 'running', expected: 'fail', failure: true, legacy: true, expired: true, missing: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'ended_unobserved partial report', status: 'running', expected: 'error', partial: true, taskState: 'ended_unobserved', processExit: null },
    { name: 'live task retained report', status: 'running', expected: 'running', taskState: 'running', processExit: null },
    { name: 'live task pruned report', status: 'running', expected: null, legacy: true, expired: true, missing: true, taskState: 'running', processExit: null },
    { name: 'cancelled task running snapshot', status: 'running', expected: 'error', taskState: 'killed', processExit: null },
    { name: 'cancelled task pruned report', status: 'running', expected: null, legacy: true, expired: true, missing: true, taskState: 'killed', processExit: null },
    { name: 'exited without observed exit', status: 'running', expected: 'error', processExit: null },
    { name: 'observed exit contradicts report', status: 'running', expected: 'error', processExit: 1 },
  ] as const)('saved report recovery after worker disappearance: $name', async (scenario) => {
    const options = scenario as {
      status: string; expected: string | null; failure?: boolean; cancelled?: boolean;
      partial?: boolean; writeFailure?: boolean; casLost?: boolean; legacy?: boolean; wrongScope?: boolean;
      expired?: boolean; missing?: boolean;
      ambiguous?: boolean;
      inlineSelector?: boolean;
      secretOutput?: boolean; missingRequestedFile?: boolean;
      taskState?: 'ended_unobserved' | 'running' | 'killed';
      processExit?: number | null;
      routerReports?: boolean; missingRouterGroup?: boolean; partialRouterGroup?: boolean;
    };
    const { status } = options;
    const taskState = options.taskState ?? (options.cancelled ? 'killed' : 'exited');
    const processExit = options.processExit === undefined ? (options.failure ? 1 : 0) : options.processExit;
    const childOnlySecret = 'synthetic-child-api-key-not-present-after-worker-restart';
    const reportDir = await mkdtemp('/tmp/papercusp-testing-run-recovery-');
    const reportPath = join(reportDir, 'papercusp-testing-run-detached-fixture.json');
    try {
      execFileSyncMock.mockImplementation((_command: string, args: string[]) =>
        args[0] === 'rev-parse' ? 'launch-sha\n' : '',
      );
      const { snapshot } = await store.startRunDurable(req({
        requestedFiles: ['lib/saved.test.ts', ...(options.routerReports || options.missingRequestedFile ? ['lib/second.test.ts'] : [])],
        ...(options.secretOutput ? { env: { SYNTHETIC_CHILD_API_KEY: childOnlySecret } } : {}),
        detachedReportArtifacts: [{
          reportPath, root: '/tmp', testNamePattern: 'saved assertion',
          ...(options.routerReports ? { routerReports: true } : {}),
          scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
        }],
      }), vi.fn(async () => []) as unknown as Sql);
      const detail = taskManagerMocks.begin.mock.calls[0]![0].detail;
      store._resetTestingRunStore();
      await writeFile(reportPath, JSON.stringify({
        success: !options.failure, numTotalTests: options.partial ? 3 : 2,
        numPassedTests: options.failure ? 0 : 1, numFailedTests: options.failure ? 1 : 0,
        numPendingTests: 1, numTodoTests: 0,
        testResults: [{
          name: '/tmp/lib/saved.test.ts', status: options.failure ? 'failed' : 'passed',
          startTime: snapshot.startedAt, endTime: snapshot.startedAt + 25,
          assertionResults: [{
            status: options.failure ? 'failed' : 'passed',
            fullName: options.secretOutput ? `saved assertion ${childOnlySecret}` : 'saved assertion',
            ...(options.secretOutput ? { failureMessages: [`child report included ${childOnlySecret}`] } : {}),
          }, { status: 'pending' }],
        }],
      }));
      const siblingPath = reportPath.replace(/\.json$/, '.1.json');
      if (options.routerReports && !options.missingRouterGroup) {
        await writeFile(siblingPath, JSON.stringify({
          success: true, numTotalTests: options.partialRouterGroup ? 2 : 1,
          numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
          testResults: [{
            name: '/tmp/lib/second.test.ts', status: 'passed',
            startTime: snapshot.startedAt, endTime: snapshot.startedAt + 25,
            assertionResults: [{ status: 'passed', fullName: 'second assertion' }],
          }],
        }));
      }
      const ledger: Record<string, unknown>[] = [];
      const writes: Record<string, unknown>[] = [];
      const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        const snapshotRead = statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot');
        const taskRead = statement.includes('FROM harness_shared.task_ledger AS task_ledger');
        if (snapshotRead && options.expired) return [];
        if (taskRead && options.wrongScope) return [];
        if (taskRead && options.ambiguous) return [{}, {}];
        // Model the actual task-state SQL predicate, including pruned snapshots.
        if (taskRead && !statement.includes(`'${taskState}'`)) return [];
        if (snapshotRead || taskRead) return [{
          run_id: snapshot.runId, task_id: snapshot.taskId, kind: 'vitest', label: 'saved',
          file_path: null, command: options.legacy ? [
            'node', 'scripts/test-files.mjs', `--outputFile=${reportPath}`,
            ...(options.inlineSelector ? ['--testNamePattern=saved assertion'] : ['-t', 'saved assertion']),
          ] : snapshot.command, status, exit_code: status === 'pass' ? 0 : null,
          started_at: snapshot.startedAt, finished_at: status === 'error' ? snapshot.startedAt + 30 : null,
          output: status === 'error' ? '[detached-recovery] no test verdict was observed.' : '', truncated: false,
          task_state: taskState, task_exit_code: processExit,
          task_ended_at: taskState === 'running' ? null : snapshot.startedAt + 25,
          task_detail: options.legacy ? { requestedFiles: ['lib/saved.test.ts'] } : detail,
          task_cwd: '/tmp', task_harness_slug: options.legacy ? null : 'papercusp', task_workspace_id: 'papercusp-workspace',
          snapshot_missing: options.missing ?? false,
        }];
        if (statement.includes('FROM harness_shared.test_runs')) return ledger;
        if (statement.includes('INSERT INTO harness_shared.test_runs')) {
          if (options.writeFailure) throw new Error('ledger unavailable');
          const inserted = insertedColumns(strings, values);
          writes.push(inserted);
          ledger.push({ file_path: inserted.file_path, status: inserted.status, finished_at: inserted.finished_at,
            output_tail: inserted.output_tail, execution_details: inserted.execution_details ?? null });
          return [{ id: 42 }];
        }
        if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) return options.casLost ? [] : [{ run_id: snapshot.runId }];
        return [];
      });
      Object.assign(sql, { begin: async (run: (tx: typeof sql) => Promise<unknown>) => {
        const before = ledger.length;
        try { return await run(sql); }
        catch (error) { ledger.splice(before); throw error; }
      } });

      const recovery = store.getRunAsync(snapshot.runId, sql as unknown as Sql, options.legacy ? {
        root: '/tmp', harnessSlug: 'papercusp', workspaceId: options.wrongScope ? 'other-workspace' : 'papercusp-workspace',
      } : undefined);
      if (options.ambiguous) {
        await expect(recovery).rejects.toBeInstanceOf(store.TestingRunSnapshotUnavailableError);
        expect(writes).toHaveLength(0);
        await expect(readFile(reportPath, 'utf8')).resolves.toContain('testResults');
        return;
      }
      const recovered = await recovery;
      if (options.expected === null) expect(recovered).toBeNull();
      else expect(recovered?.status).toBe(options.expected);
      if (options.expired) {
        const taskQuery = sql.mock.calls.find(([strings]) => strings.join(' ').includes('FROM harness_shared.task_ledger AS task_ledger'));
        expect(taskQuery).toBeDefined();
        expect(taskQuery!.slice(1)).toEqual(expect.arrayContaining([
          snapshot.runId, options.wrongScope ? 'other-workspace' : 'papercusp-workspace', '/tmp', 'papercusp',
        ]));
      }
      if (options.expected !== 'pass' && options.expected !== 'fail') {
        if (options.routerReports || options.missingRequestedFile) expect(writes).toHaveLength(0);
        await expect(readFile(reportPath, 'utf8')).resolves.toContain('testResults');
        return;
      }
      expect(recovered).toMatchObject({ exitCode: processExit, finishedAt: snapshot.startedAt + 25 });
      expect(sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared.task_ledger'))).toBe(false);
      if (taskState === 'ended_unobserved') expect(recovered!.output).toContain('process exit code was not observed');
      expect(writes).toHaveLength(options.routerReports ? 2 : 1);
      expect(writes[0]!.run_group_id).toBe(snapshot.runId);
      expect(writes[0]!.commit_sha).toBe(options.legacy ? null : 'launch-sha');
      expect(writes[0]!.worktree_dirty).toBe(true);
      expect(typeof writes[0]!.execution_details).toBe('object');
      expect(writes[0]!.execution_details).toMatchObject({
        root: '/tmp', passed: options.failure ? 0 : 1, skipped: 1, testNamePattern: 'saved assertion', worktreeDirty: true,
      });
      if (options.secretOutput) {
        expect(JSON.stringify({ recovered, writes })).not.toContain(childOnlySecret);
        expect(writes[0]!.output_tail).toBeNull();
        expect(recovered!.exitCode).toBeNull();
        expect(recovered!.output).toContain('process exit code was not observed');
      }
      await expect(readFile(reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      if (options.routerReports) await expect(readFile(siblingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(reportDir, { recursive: true, force: true });
    }
  });

  it('spawns the detached child before waiting for the running snapshot persistence', async () => {
    const events: string[] = [];
    const sql = vi.fn(async () => {
      events.push('persist');
      return [];
    }) as unknown as Sql;
    spawnMock.mockImplementationOnce(() => {
      events.push('spawn');
      lastChild = makeChild();
      return lastChild;
    });

    const result = await store.startRunDurable(req(), sql);

    expect(result.durable).toBe(true);
    expect(result.snapshot.status).toBe('running');
    expect(events).toEqual(['spawn', 'persist']);
  });

  it('returns the detached handle before a slow initial snapshot write settles', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const write = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sql = vi.fn(async () => {
        await write;
        return [];
      }) as unknown as Sql;

      const pending = store.startRunDurable(req(), sql);
      // The nonblocking provenance snapshot now settles before launch. Once
      // that promise chain runs, the child exists while the optional durable
      // write is still blocked.
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(store.DETACHED_RUN_DURABILITY_RESPONSE_BUDGET_MS + 1);
      const result = await pending;

      expect(result.snapshot.runId).toBeTruthy();
      expect(result.snapshot.status).toBe('running');
      expect(result.durable).toBe(false);

      // Let the background write settle before restoring real timers.
      release();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for timed-out initial snapshot SQL to settle before retrying', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let rejectInitial!: (reason: Error) => void;
      let releaseRetry!: () => void;
      let retrySettled = false;
      const sql = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return new Promise<unknown[]>((_resolve, reject) => {
          rejectInitial = reject;
        });
        if (attempts === 2) {
          return new Promise<unknown[]>((resolve) => {
            releaseRetry = () => {
              retrySettled = true;
              resolve([]);
            };
          });
        }
        return [];
      }) as unknown as Sql;

      const pending = store.startRunDurable(req(), sql);
      await vi.advanceTimersByTimeAsync(store.DETACHED_RUN_DURABILITY_RESPONSE_BUDGET_MS + 1);
      const result = await pending;

      // Returning the child handle does not cancel the still-live SQL. A
      // concurrent retry must not overtake it and later overwrite progress.
      expect(result.durable).toBe(false);
      expect(attempts).toBe(1);
      expect(retrySettled).toBe(false);

      // Once the original attempt actually fails, the already-scheduled
      // bounded retry can use the recovered database and settle independently.
      rejectInitial(new Error('initial snapshot connection closed'));
      await vi.advanceTimersByTimeAsync(store.DETACHED_RUN_DURABILITY_RETRY_DELAYS_MS[0]);
      expect(attempts).toBe(2);
      expect(retrySettled).toBe(false);

      releaseRetry();
      await vi.advanceTimersByTimeAsync(0);
      expect(retrySettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the active snapshot readable after the local worker state is gone', async () => {
    let durableRow: Record<string, unknown> | null = null;
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots')) {
        durableRow = {
          run_id: values[0],
          kind: values[1],
          label: values[2],
          file_path: values[3],
          command: values[4],
          status: values[5],
          exit_code: values[6],
          started_at: values[7],
          finished_at: values[8],
          output: values[9],
          truncated: values[10],
          task_id: values[11],
          task_state: 'running',
        };
        return [];
      }
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) return durableRow ? [durableRow] : [];
      return [];
    }) as unknown as Sql;

    const { snapshot, durable } = await store.startRunDurable(req(), sql);
    expect(durable).toBe(true);

    // Simulate the operator worker being replaced while the detached process
    // remains alive. The sibling worker has no local _runs entry to consult.
    store._resetTestingRunStore();

    await expect(store.getRunAsync(snapshot.runId, sql)).resolves.toMatchObject({
      runId: snapshot.runId,
      taskId: 'task-test-run',
      status: 'running',
      finishedAt: null,
    });
    // Both joined tables expose exit_code and timestamps. An unqualified
    // projection fails with PostgreSQL 42702 on a sibling worker, while the
    // launching worker's local map masks that SQL error.
    const readSql = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(' '))
      .find((statement) => statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot'));
    expect(readSql).toContain('snapshot.exit_code');
    expect(readSql).toContain('snapshot.started_at');
    expect(readSql).toContain('snapshot.finished_at');
    expect(readSql).toContain('WHERE snapshot.run_id =');
  });

  it('retries an empty sibling read until the confirmed snapshot becomes visible', async () => {
    let snapshotReads = 0;
    const durableRow = {
      run_id: 'visible-after-write',
      task_id: null,
      kind: 'vitest',
      label: 'detached test',
      file_path: null,
      command: ['node', 'vitest'],
      status: 'running',
      exit_code: null,
      started_at: new Date(1_700_000_000_000),
      finished_at: null,
      output: '',
      truncated: false,
      task_state: null,
      task_deadline_at: null,
    };
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        snapshotReads += 1;
        return snapshotReads === 1 ? [] : [durableRow];
      }
      if (statement.includes('SELECT DISTINCT ON (file_path)')) return [];
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync(durableRow.run_id, sql)).resolves.toMatchObject({
      runId: durableRow.run_id,
      status: 'running',
      finishedAt: null,
    });
    expect(snapshotReads).toBe(2);
  });

  it('distinguishes an unavailable snapshot lookup from a missing row', async () => {
    const unavailableSql = vi.fn(async () => {
      throw new Error('database unavailable');
    }) as unknown as Sql;
    const missingSql = vi.fn(async () => []) as unknown as Sql;

    await expect(store.getRunAsync('unavailable-run', unavailableSql)).rejects.toBeInstanceOf(
      store.TestingRunSnapshotUnavailableError,
    );
    await expect(store.getRunAsync('missing-run', missingSql)).resolves.toBeNull();
  });

  it.each(['pending', 'running'])('keeps a %s foreground task in flight without a detached snapshot', async (state) => {
    const scope = { workspaceId: 'workspace-one', harnessSlug: 'harness-one', root: '/tmp' };
    const runId = 'foreground-origin';
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.task_ledger') && values.includes(`testing:run:${runId}`)) {
        return [{ task_id: 'foreground-task', title: `testing:run foreground ${runId}`,
          argv: ['node', 'scripts/test-files.mjs'], state, started_at: new Date(1_700_000_000_000),
          ended_at: null }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync(runId, sql, scope)).resolves.toMatchObject({
      runId, taskId: 'foreground-task', status: 'running', finishedAt: null, exitCode: null,
    });
    const read = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      call.slice(1).includes(`testing:run:${runId}`));
    expect(read?.slice(1)).toEqual(expect.arrayContaining([scope.workspaceId, scope.root, scope.harnessSlug, runId]));
    expect((read?.[0] as TemplateStringsArray).join(' ')).toContain("detail->>'foreground' = 'true'");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(['exited', 'ended_unobserved', 'killed', 'timed_out'])('does not invent a verdict for a %s foreground task', async (state) => {
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('FROM harness_shared.task_ledger') && values.includes('testing:run:foreground-ended')) {
        return [{ task_id: 'foreground-task', title: 'foreground', argv: ['node'], state,
          started_at: new Date(1_700_000_000_000), ended_at: new Date(1_700_000_001_000) }];
      }
      return [];
    }) as unknown as Sql;
    await expect(store.getRunAsync('foreground-ended', sql,
      { workspaceId: 'workspace-one', harnessSlug: 'harness-one', root: '/tmp' })).resolves.toBeNull();
  });

  it.each(['unreadable', 'ambiguous', 'unaccounted', 'stranded'])('fails closed for an %s foreground task lookup', async (mode) => {
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('FROM harness_shared.task_ledger') && values.includes('testing:run:foreground-unknown')) {
        if (mode === 'unreadable') throw new Error('task read failed');
        const row = { task_id: 'foreground-task', title: 'foreground', argv: ['node'], state: ['unaccounted', 'stranded'].includes(mode) ? mode : 'running',
          started_at: new Date(1_700_000_000_000), ended_at: null };
        return mode === 'ambiguous' ? [row, { ...row, task_id: 'other-task' }] : [row];
      }
      return [];
    }) as unknown as Sql;
    await expect(store.getRunAsync('foreground-unknown', sql,
      { workspaceId: 'workspace-one', harnessSlug: 'harness-one', root: '/tmp' }))
      .rejects.toBeInstanceOf(store.TestingRunSnapshotUnavailableError);
  });

  it('keeps an unreadable report-task fallback unknown when the snapshot is missing', async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('FROM harness_shared.task_ledger AS task_ledger')) throw new Error('task store unavailable');
      return [];
    }) as unknown as Sql;
    await expect(store.getRunAsync('missing-snapshot', sql,
      { workspaceId: 'workspace-one', harnessSlug: 'harness-one', root: '/tmp' }))
      .rejects.toBeInstanceOf(store.TestingRunSnapshotUnavailableError);
  });

  it('recovers a terminal detached verdict from test_runs when its snapshot read is unavailable', async () => {
    const runId = 'ledger-recovery-run';
    const ledgerRows = Array.from({ length: 5 }, (_, index) => ({
      file_path: `lib/file-${index + 1}.test.ts`,
      status: 'pass',
      finished_at: new Date(1_700_000_001_000 + index * 1_000),
      output_tail: null,
      execution_details: measuredPass(`lib/file-${index + 1}.test.ts`, runId),
    }));
    const sql = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) throw new Error('snapshot table unavailable');
      if (statement.includes('FROM harness_shared.task_ledger')) {
        return [{
          state: 'exited',
          exit_code: 0,
          requested_files: ledgerRows.map((row) => row.file_path),
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync(runId, sql)).rejects.toBeInstanceOf(store.TestingRunSnapshotUnavailableError);
    await expect(store.getTestRunLedgerRecoveryAsync(runId, sql)).resolves.toMatchObject({
      runId,
      status: 'pass',
      exitCode: 0,
      finishedAt: 1_700_000_005_000,
      fileCount: 5,
      files: ledgerRows.map((row) => ({
        filePath: row.file_path,
        status: row.status,
        finishedAt: row.finished_at.getTime(),
      })),
    });
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'))).toBe(true);
  });

  it.each([
    { name: 'while the linked task is running', taskState: 'running', exitCode: null, expected: null },
    { name: 'after a clean task exit', taskState: 'exited', exitCode: 0, expected: 'pass' },
    { name: 'after a nonzero task exit', taskState: 'exited', exitCode: 1, expected: null },
  ] as const)(
    'requires a linked detached task to finish before ledger recovery: $name',
    async (scenario) => {
      const runId = `ledger-${scenario.name.replaceAll(' ', '-')}`;
      const ledgerRows = Array.from({ length: 9 }, (_, index) => ({
        file_path: `lib/workspace-one-${index + 1}.test.ts`,
        status: 'pass',
        finished_at: new Date(1_700_000_001_000 + index * 1_000),
        output_tail: null,
        execution_details: measuredPass(`lib/workspace-one-${index + 1}.test.ts`, runId),
      }));
      const sql = vi.fn(async (strings: TemplateStringsArray) => {
        const statement = strings.join(' ');
        if (statement.includes('FROM harness_shared.task_ledger')) {
          return [{
            state: scenario.taskState,
            exit_code: scenario.exitCode,
            requested_files: ledgerRows.map((row) => row.file_path),
          }];
        }
        if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
        return [];
      }) as unknown as Sql;

      const recovery = await store.getTestRunLedgerRecoveryAsync(runId, sql);

      if (scenario.expected === 'pass') {
        expect(recovery).toMatchObject({ runId, status: 'pass', fileCount: 9 });
      } else {
        expect(recovery).toBeNull();
      }
      const ledgerRead = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
        .some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'));
      expect(ledgerRead).toBe(scenario.taskState !== 'running');
    },
  );

  it.each([
    { name: 'measured cases', change: {}, expected: 'pass' },
    { name: 'zero matches', change: { passed: 0, skipped: 0 }, expected: null },
    { name: 'all skipped', change: { passed: 0 }, expected: null },
    { name: 'failed cases', change: { failed: 1 }, expected: null },
    { name: 'collection failure', change: { collectionFailed: true }, expected: null },
    { name: 'wrong file', change: { filePath: 'other.test.ts' }, expected: null },
    { name: 'wrong group', change: { runGroupId: 'other-run' }, expected: null },
    { name: 'missing details', change: null, expected: null },
    { name: 'malformed details', change: { passed: -1 }, expected: null },
  ])('requires measured executed cases in every requested file: $name', async ({ change, expected }) => {
    const runId = 'measured-coverage-run';
    const requestedFiles = ['first.test.ts', 'second.test.ts'];
    const rows = requestedFiles.map((file_path, index) => ({
      file_path, status: 'pass', finished_at: new Date(1_700_000_001_000 + index), output_tail: null,
      execution_details: index === 1 && change === null ? null : {
        ...measuredPass(file_path, runId), ...(index === 1 ? change : {}),
      },
    }));
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) return [{
        run_id: runId, task_id: 'measured-task', kind: 'vitest', label: 'measured', file_path: null,
        command: ['node', 'scripts/test-files.mjs'], status: 'pass', exit_code: 0,
        started_at: new Date(1_700_000_000_000), finished_at: new Date(1_700_000_010_000),
        output: '', truncated: false, task_state: 'exited', task_exit_code: 0,
        task_ended_at: new Date(1_700_000_010_000), task_detail: { requestedFiles },
      }];
      if (statement.includes('FROM harness_shared.task_ledger')) return [{
        state: 'exited', exit_code: 0, requested_files: requestedFiles,
      }];
      if (statement.includes('FROM harness_shared.test_runs')) return rows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const recovery = await store.getTestRunLedgerRecoveryAsync(runId, sql);
    const snapshot = await store.getRunAsync(runId, sql);
    if (expected === 'pass') {
      expect(recovery).toMatchObject({ status: 'pass', files: rows.map(row => ({
        filePath: row.file_path, executionDetails: row.execution_details,
      })) });
      expect(snapshot?.status).toBe('pass');
      expect(updates).toHaveLength(0);
    } else {
      expect(recovery).toBeNull();
      expect(snapshot?.status).toBe('error');
      expect(updates).toHaveLength(1);
    }
  });

  it('does not recover an unmanifested all-pass detached ledger as a pass', async () => {
    const ledgerRows = [{
      file_path: 'lib/unmanifested.test.ts',
      status: 'pass',
      finished_at: new Date(1_700_000_001_000),
      output_tail: null,
    }];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.task_ledger')) {
        return [{ state: 'exited', exit_code: 0 }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      return [];
    }) as unknown as Sql;

    await expect(store.getTestRunLedgerRecoveryAsync('unmanifested-ledger-run', sql)).resolves.toBeNull();
  });

  it('does not recover a pass when one requested file is missing from the detached ledger', async () => {
    const requestedFiles = [
      'lib/first.test.ts',
      'lib/second.test.ts',
      'lib/third.test.ts',
      'lib/fourth.integration.test.ts',
    ];
    const ledgerRows = requestedFiles.slice(0, 3).map((file_path, index) => ({
      file_path,
      status: 'pass',
      finished_at: new Date(1_700_000_001_000 + index * 1_000),
      output_tail: null,
    }));
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.task_ledger')) {
        return [{ state: 'exited', exit_code: 0, requested_files: requestedFiles }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      return [];
    }) as unknown as Sql;

    await expect(
      store.getTestRunLedgerRecoveryAsync('three-of-four-ledger-run', sql),
    ).resolves.toBeNull();
  });

  it('does not recover a detached verdict from a partial or unreadable test_runs group', async () => {
    const partialSql = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('FROM harness_shared.test_runs')) {
        return [
          {
            file_path: 'lib/finished.test.ts',
            status: 'pass',
            finished_at: new Date(1_700_000_001_000),
            output_tail: null,
          },
          { file_path: 'lib/active.test.ts', status: 'running', finished_at: null, output_tail: null },
        ];
      }
      return [];
    }) as unknown as Sql;
    const unavailableSql = vi.fn(async () => {
      throw new Error('test_runs unavailable');
    }) as unknown as Sql;

    await expect(store.getTestRunLedgerRecoveryAsync('partial-run', partialSql)).resolves.toBeNull();
    await expect(store.getTestRunLedgerRecoveryAsync('unreadable-ledger-run', unavailableSql)).resolves.toBeNull();
  });

  it.each(['exited', 'ended_unobserved', 'killed', 'timed_out'])(
    'reconciles a locally cached running snapshot when its linked task is %s', async (taskState) => {
      const run = store.startRun(req());
      const updates: unknown[][] = [];
      const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
          return [{
            run_id: run.runId, task_id: run.taskId, kind: run.kind, label: run.label,
            file_path: null, command: run.command, status: 'running', exit_code: null,
            started_at: new Date(run.startedAt), finished_at: null,
            output: 'retained partial output', truncated: false,
            task_state: taskState, task_deadline_at: null,
          }];
        }
        if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
          updates.push(values);
          return [{ run_id: run.runId }];
        }
        return [];
      }) as unknown as Sql;

      await expect(store.getRunAsync(run.runId, sql)).resolves.toMatchObject({
        status: 'error', exitCode: null, finishedAt: expect.any(Number),
        output: expect.stringContaining('no test verdict was observed'),
      });
      expect(store.getRun(run.runId)?.status).toBe('error');
      await expect(store.getRunAsync(run.runId, sql)).resolves.toMatchObject({ status: 'error' });
      expect(updates).toHaveLength(1);
      // A delayed child notification must not replace the reconciled unknown verdict.
      lastChild._emitClose(0);
      expect(store.getRun(run.runId)?.status).toBe('error');
    },
  );

  it('preserves newer local output while the linked durable task is still running', async () => {
    const run = store.startRun(req());
    lastChild._emitStdout('newer local progress');
    const sql = vi.fn(async (strings: TemplateStringsArray) => strings.join(' ').includes(
      'FROM harness_shared.testing_run_snapshots AS snapshot',
    ) ? [{
      run_id: run.runId, task_id: run.taskId, kind: run.kind, label: run.label,
      file_path: null, command: run.command, status: 'running', exit_code: null,
      started_at: new Date(run.startedAt), finished_at: null,
      output: 'older durable progress', truncated: false,
      task_state: 'running', task_deadline_at: null,
    }] : []) as unknown as Sql;
    await expect(store.getRunAsync(run.runId, sql)).resolves.toMatchObject({
      status: 'running', output: 'newer local progress', finishedAt: null,
    });
  });

  it('reconciles a persisted running snapshot when its linked task is terminal', async () => {
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'orphan-run',
            task_id: 'task-orphan',
            kind: 'shell',
            label: 'orphan',
            file_path: null,
            command: ['bash', '-c', 'true'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: 'partial output',
            truncated: false,
            task_state: 'exited',
            task_deadline_at: null,
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: 'orphan-run' }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('orphan-run', sql)).resolves.toMatchObject({
      runId: 'orphan-run',
      taskId: 'task-orphan',
      status: 'error',
      exitCode: null,
      finishedAt: expect.any(Number),
      output: expect.stringContaining('no test verdict was observed'),
    });
    expect(updates).toHaveLength(1);
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].join(' ')).toContain(
      "WHERE run_id =",
    );
  });

  it('does not recover a stale snapshot as pass when no task row can supply the manifest', async () => {
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'ledger-pass-run',
            task_id: null,
            kind: 'vitest',
            label: 'detached',
            file_path: 'lib/example.test.ts',
            command: ['node', 'router.js'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: null,
            task_deadline_at: null,
          },
        ];
      }
      if (statement.includes('FROM harness_shared.test_runs')) {
        return [
          {
            file_path: 'lib/example.test.ts',
            status: 'pass',
            finished_at: new Date(1_700_000_001_000),
            output_tail: null,
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: 'ledger-pass-run' }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('ledger-pass-run', sql)).resolves.toMatchObject({
      runId: 'ledger-pass-run',
      status: 'running',
      finishedAt: null,
    });
    expect(updates).toHaveLength(0);
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'))).toBe(true);
  });

  it('does not recover a running snapshot from a partial or active test_runs ledger', async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'ledger-partial-run',
            task_id: null,
            kind: 'vitest',
            label: 'detached',
            file_path: null,
            command: ['node', 'router.js'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: null,
            task_deadline_at: null,
          },
        ];
      }
      if (statement.includes('FROM harness_shared.test_runs')) {
        return [
          {
            file_path: 'lib/one.test.ts',
            status: 'pass',
            finished_at: new Date(1_700_000_001_000),
            output_tail: null,
          },
          {
            file_path: 'lib/two.test.ts',
            status: 'running',
            finished_at: null,
            output_tail: null,
          },
        ];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('ledger-partial-run', sql)).resolves.toMatchObject({
      runId: 'ledger-partial-run',
      status: 'running',
      finishedAt: null,
    });
  });

  it('keeps a unit PASS from finalizing while a requested integration file is still running', async () => {
    const runId = 'unit-pass-integration-running';
    const requestedFiles = ['run-launcher.test.ts', 'run-launcher.integration.test.ts'];
    const ledgerRows = [
      {
        file_path: requestedFiles[0]!,
        status: 'pass',
        finished_at: new Date(1_700_000_001_000),
        output_tail: null,
        execution_details: measuredPass(requestedFiles[0]!, runId),
      },
      { file_path: requestedFiles[1]!, status: 'running', finished_at: null, output_tail: null },
    ];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{
          run_id: runId,
          task_id: 'task-unit-pass-integration-running',
          kind: 'vitest',
          label: 'unit and integration',
          file_path: null,
          command: ['node', 'scripts/test-files.mjs'],
          status: 'running',
          exit_code: null,
          started_at: new Date(1_700_000_000_000),
          finished_at: null,
          output: '',
          truncated: false,
          task_state: 'running',
          task_deadline_at: null,
          task_exit_code: null,
          task_ended_at: null,
          task_detail: { requestedFiles },
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      return [];
    }) as unknown as Sql;

    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered).toMatchObject({ runId, status: 'running', exitCode: null, finishedAt: null });
    expect(recovered?.requestedFiles).toEqual(requestedFiles);
    expect(recovered?.output).not.toContain('recovered pass');
  });

  it.each([
    { name: 'while the linked router is still running', taskState: 'running', taskExitCode: null, expected: 'running' },
    { name: 'after the linked router exits cleanly with one requested file missing', taskState: 'exited', taskExitCode: 0, expected: 'error' },
    { name: 'after the linked router exits unsuccessfully', taskState: 'exited', taskExitCode: 1, expected: 'error' },
  ] as const)(
    'does not finalize from an all-pass subset emitted by one workspace: $name',
    async (scenario) => {
      const runId = 'multi-workspace-ledger-run';
      const ledgerRows = Array.from({ length: 9 }, (_, index) => ({
        file_path: `lib/workspace-one-${index + 1}.test.ts`,
        status: 'pass',
        finished_at: new Date(1_700_000_001_000 + index * 1_000),
        output_tail: null,
      }));
      const requestedFiles = [
        ...ledgerRows.map((row) => row.file_path),
        'lib/workspace-two-1.test.ts',
      ];
      const updates: unknown[][] = [];
      const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(' ');
        if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
          return [{
            run_id: runId,
            task_id: 'task-multi-workspace',
            kind: 'vitest',
            label: 'multi-workspace router',
            file_path: null,
            command: ['node', 'scripts/test-files.mjs'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: scenario.taskState,
            task_deadline_at: null,
            task_exit_code: scenario.taskExitCode,
            task_ended_at: scenario.taskState === 'running' ? null : new Date(1_700_000_020_000),
            task_detail: { requestedFiles },
          }];
        }
        if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
        if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
          updates.push(values);
          return [{ run_id: runId }];
        }
        return [];
      }) as unknown as Sql;

      const recovered = await store.getRunAsync(runId, sql);

      expect(recovered).toMatchObject({ runId, status: scenario.expected });
      const ledgerRead = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
        .some((call) => call[0].join(' ').includes('FROM harness_shared.test_runs'));
      if (scenario.taskState === 'running') {
        expect(ledgerRead).toBe(false);
        expect(updates).toHaveLength(0);
        expect(recovered?.finishedAt).toBeNull();
      } else {
        expect(ledgerRead).toBe(true);
        expect(updates).toHaveLength(1);
        expect(recovered).toMatchObject({
          status: 'error',
          exitCode: null,
          output: expect.stringContaining('no test verdict was observed'),
        });
      }
    },
  );

  it.each([
    {
      name: 'exact coverage',
      requestedFiles: ['lib/first.test.ts', 'lib/second.test.ts'],
      rows: ['lib/first.test.ts', 'lib/second.test.ts'],
      expected: 'pass',
    },
    {
      name: 'partial coverage',
      requestedFiles: ['lib/first.test.ts', 'lib/second.test.ts'],
      rows: ['lib/first.test.ts'],
      expected: 'error',
    },
    {
      name: 'unknown coverage',
      requestedFiles: null,
      rows: ['lib/first.test.ts', 'lib/second.test.ts'],
      expected: 'error',
    },
  ] as const)('enforces requested-file coverage on a persisted terminal PASS: $name', async (scenario) => {
    const runId = `terminal-pass-${scenario.name.replaceAll(' ', '-')}`;
    const requestedFiles = scenario.requestedFiles;
    const ledgerRows = scenario.rows.map((file_path, index) => ({
      file_path,
      status: 'pass',
      finished_at: new Date(1_700_000_001_000 + index * 1_000),
      output_tail: null,
      execution_details: measuredPass(file_path, runId),
    }));
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{
          run_id: runId,
          task_id: 'task-terminal-pass',
          kind: 'vitest',
          label: 'terminal pass',
          file_path: null,
          command: ['node', 'scripts/test-files.mjs'],
          status: 'pass',
          exit_code: 0,
          started_at: new Date(1_700_000_000_000),
          finished_at: new Date(1_700_000_010_000),
          output: '',
          truncated: false,
          task_state: 'exited',
          task_exit_code: 0,
          task_ended_at: new Date(1_700_000_010_000),
          task_detail: requestedFiles ? { requestedFiles } : {},
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered?.status).toBe(scenario.expected);
    if (scenario.expected === 'pass') {
      expect(recovered?.requestedFiles).toEqual(requestedFiles);
      expect(recovered?.output).not.toContain('[coverage-gate]');
      expect(updates).toHaveLength(0);
    } else {
      expect(recovered?.output).toContain('[coverage-gate]');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.[0]).toBe('error');
    }
  });

  it.each([
    { name: 'missing manifest', reason: 'requested-files-unavailable', requestedFiles: undefined,
      ledger: 'measured', rowCount: null, ledgerStatus: null },
    { name: 'unreadable ledger', reason: 'ledger-read-unavailable', requestedFiles: ['lib/first.test.ts'],
      ledger: 'unavailable', rowCount: null, ledgerStatus: null },
    { name: 'query construction rejected', reason: 'ledger-read-unavailable', requestedFiles: ['lib/first.test.ts'],
      ledger: 'construction', rowCount: null, ledgerStatus: null },
    { name: 'ledger query deadline', reason: 'ledger-read-unavailable', requestedFiles: ['lib/first.test.ts'],
      ledger: 'deadline', rowCount: null, ledgerStatus: null },
    { name: 'empty ledger', reason: 'ledger-empty', requestedFiles: ['lib/first.test.ts'],
      ledger: 'empty', rowCount: 0, ledgerStatus: null },
    { name: 'nonterminal ledger', reason: 'ledger-verdict-unavailable', requestedFiles: ['lib/first.test.ts'],
      ledger: 'nonterminal', rowCount: 1, ledgerStatus: null },
    { name: 'failed ledger', reason: 'ledger-not-passed', requestedFiles: ['lib/first.test.ts'],
      ledger: 'failed', rowCount: 1, ledgerStatus: 'fail' },
    { name: 'wrong file', reason: 'exact-file-coverage-unverified', requestedFiles: ['lib/first.test.ts'],
      ledger: 'wrong-file', rowCount: 1, ledgerStatus: 'pass' },
    { name: 'missing assertions', reason: 'exact-file-coverage-unverified', requestedFiles: ['lib/first.test.ts'],
      ledger: 'unmeasured', rowCount: 1, ledgerStatus: 'pass' },
    { name: 'duplicate request', reason: 'exact-file-coverage-unverified',
      requestedFiles: ['lib/first.test.ts', 'lib/first.test.ts'],
      ledger: 'measured', rowCount: 1, ledgerStatus: 'pass' },
  ] as const)('diagnoses the withheld coverage prerequisite: $name', async (scenario) => {
    const runId = `coverage-diagnostic-${scenario.name.replaceAll(' ', '-')}`;
    const filePath = scenario.ledger === 'wrong-file' ? 'lib/other.test.ts' : 'lib/first.test.ts';
    const ledgerRows = scenario.ledger === 'empty' ? [] : [{
      file_path: filePath,
      status: scenario.ledger === 'failed' ? 'fail' : scenario.ledger === 'nonterminal' ? 'running' : 'pass',
      finished_at: scenario.ledger === 'nonterminal' ? null : new Date(1_700_000_001_000),
      output_tail: null,
      execution_details: scenario.ledger === 'unmeasured' ? null : measuredPass(filePath, runId),
    }];
    const durableRow: Record<string, unknown> = {
      run_id: runId, task_id: 'task-coverage-diagnostic', kind: 'vitest', label: 'coverage diagnostic',
      file_path: null, command: ['node', 'scripts/test-files.mjs'], status: 'pass', exit_code: 0,
      started_at: new Date(1_700_000_000_000), finished_at: new Date(1_700_000_010_000),
      output: 'x'.repeat(16 * 1024), truncated: false,
      task_detail: { requestedFiles: scenario.requestedFiles },
    };
    const updates: unknown[][] = [];
    const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) return Promise.resolve([{ ...durableRow }]);
      if (statement.includes('FROM harness_shared.test_runs')) {
        if (scenario.ledger === 'construction') throw Object.assign(new Error('private query text'), { code: '08006' });
        if (scenario.ledger === 'unavailable') return Promise.reject(Object.assign(new Error('private query text'), { code: '57014' }));
        if (scenario.ledger === 'deadline') return new Promise(() => {});
        return Promise.resolve(ledgerRows);
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        Object.assign(durableRow, { status: values[0], output: values[3], truncated: values[4] });
        return Promise.resolve([{ run_id: runId }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;

    const withheld = await store.getRunAsync(runId, sql);

    expect(withheld).toMatchObject({ status: 'error', exitCode: 0, truncated: true });
    const diagnostic = withheld!.output.split('\n').find(line => line.startsWith('[coverage-gate:verification] '));
    expect(JSON.parse(diagnostic!.slice('[coverage-gate:verification] '.length))).toEqual({
      reason: scenario.reason,
      requestedFileCount: scenario.requestedFiles?.length ?? null,
      ledgerRowCount: scenario.rowCount,
      ledgerStatus: scenario.ledgerStatus,
      ...(scenario.ledger === 'unavailable' ? { ledgerReadFailure: { phase: 'query', errorName: 'Error', errorCode: '57014' } }
        : scenario.ledger === 'construction' ? { ledgerReadFailure: { phase: 'construction', errorName: 'Error', errorCode: '08006' } }
        : scenario.ledger === 'deadline' ? { ledgerReadFailure: { phase: 'deadline', errorName: 'TestingRunSnapshotQueryTimeout', timeoutMs: 1000 } }
        : {}),
    });
    expect(withheld!.output).not.toContain('private query text');
    expect(withheld!.output.length).toBeLessThanOrEqual(16 * 1024);
    expect(withheld!.output.match(/Vitest PASS withheld/g)).toHaveLength(1);
    const repeated = await store.getRunAsync(runId, sql);
    expect(repeated?.output).toBe(withheld?.output);
    expect(updates).toHaveLength(1);
  });

  it('diagnoses unavailable coverage storage for a local terminal PASS', async () => {
    const previousOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    try {
      const snapshot = store.startRun(req({ requestedFiles: ['lib/first.test.ts'] }));
      lastChild._emitClose(0);

      const withheld = await store.getRunAsync(snapshot.runId);

      expect(withheld).toMatchObject({ status: 'error', exitCode: 0 });
      expect(withheld?.output).toContain('"reason":"snapshot-store-unavailable"');
      expect(withheld?.output).toContain('"ledgerRowCount":null');
      expect((await store.getRunAsync(snapshot.runId))?.output).toBe(withheld?.output);
    } finally {
      if (previousOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousOptIn;
    }
  });

  it('upgrades legacy coverage warnings, refreshes the reason, and clears diagnostics on recovery', async () => {
    const runId = 'legacy-coverage-diagnostic';
    const filePath = 'lib/first.test.ts';
    const durableRow: Record<string, unknown> = {
      run_id: runId, task_id: 'task-legacy-coverage', kind: 'vitest', label: 'legacy coverage',
      file_path: null, command: ['node', 'scripts/test-files.mjs'], status: 'error', exit_code: 0,
      started_at: new Date(1_700_000_000_000), finished_at: new Date(1_700_000_010_000),
      output: '\n[coverage-gate] Vitest PASS withheld: the latest per-file ledger rows do not prove that every requested file passed.\n',
      truncated: false, task_detail: { requestedFiles: [filePath] },
    };
    let ledgerRows: Array<Record<string, unknown>> = [];
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) return [{ ...durableRow }];
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        Object.assign(durableRow, { status: values[0], exit_code: values[1], finished_at: values[2],
          output: values[3], truncated: values[4] });
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const upgraded = await store.getRunAsync(runId, sql);
    expect(upgraded?.output).toContain('"reason":"ledger-empty"');
    expect(upgraded?.output.match(/Vitest PASS withheld/g)).toHaveLength(1);
    ledgerRows = [{ file_path: filePath, status: 'pass', finished_at: new Date(1_700_000_011_000),
      output_tail: null, execution_details: null }];
    const refreshed = await store.getRunAsync(runId, sql);
    expect(refreshed?.output).toContain('"reason":"exact-file-coverage-unverified"');
    expect(refreshed?.output).not.toContain('"reason":"ledger-empty"');
    expect(refreshed?.output.match(/\[coverage-gate:verification\]/g)).toHaveLength(1);
    expect((await store.getRunAsync(runId, sql))?.output).toBe(refreshed?.output);
    expect(updates).toHaveLength(2);

    ledgerRows[0]!.execution_details = measuredPass(filePath, runId);
    const recovered = await store.getRunAsync(runId, sql);
    expect(recovered).toMatchObject({ status: 'pass', exitCode: 0 });
    expect(recovered?.output).not.toContain('[coverage-gate');
    expect(recovered?.output).toContain('recovered pass from exact requested-file ledger rows');
    expect(updates.map(([status]) => status)).toEqual(['error', 'error', 'pass']);
  });

  it('withholds a terminal PASS when requested per-file ledger rows include failures', async () => {
    const runId = 'terminal-pass-with-failed-ledger';
    const requestedFiles = ['lib/first.test.ts', 'lib/second.test.ts', 'lib/third.test.ts'];
    const ledgerRows = [
      { file_path: requestedFiles[0], status: 'pass', finished_at: new Date(1_700_000_001_000), output_tail: null },
      { file_path: requestedFiles[1], status: 'fail', finished_at: new Date(1_700_000_002_000), output_tail: 'Transform failed' },
      { file_path: requestedFiles[2], status: 'fail', finished_at: new Date(1_700_000_003_000), output_tail: 'Transform failed' },
    ];
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{
          run_id: runId,
          task_id: 'task-terminal-pass-with-failed-ledger',
          kind: 'vitest',
          label: 'detached multi-file run',
          file_path: null,
          command: ['node', 'scripts/test-files.mjs'],
          status: 'pass',
          exit_code: 0,
          started_at: new Date(1_700_000_000_000),
          finished_at: new Date(1_700_000_010_000),
          output: '',
          truncated: false,
          task_state: 'exited',
          task_exit_code: 0,
          task_ended_at: new Date(1_700_000_010_000),
          task_detail: { requestedFiles },
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered).toMatchObject({ runId, status: 'error', exitCode: 0 });
    expect(recovered?.output).toContain('do not prove that every requested file passed');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toBe('error');
  });

  it('merges bounded terminal failure output from test_runs once without changing the verdict', async () => {
    const runId = 'terminal-failed-ledger-output';
    const finishedAt = new Date(1_700_000_010_000);
    const ledgerRows = [
      ...Array.from({ length: 4 }, (_, index) => ({
        file_path: 'lib/failing-' + index + '.test.ts',
        status: 'fail',
        finished_at: new Date(1_700_000_001_000 + index * 1_000),
        output_tail: 'x'.repeat(4_096),
      })),
      {
        file_path: 'lib/zz-unsafe-transaction.test.ts',
        status: 'fail',
        finished_at: new Date(1_700_000_006_000),
        output_tail: 'UNSAFE_TRANSACTION',
      },
      {
        file_path: 'lib/zz-passing.test.ts',
        status: 'pass',
        finished_at: new Date(1_700_000_007_000),
        output_tail: 'passing output must not be merged',
      },
    ];
    const durableSnapshot: Record<string, unknown> = {
      run_id: runId,
      task_id: 'task-terminal-failure',
      kind: 'vitest',
      label: 'detached failed run',
      file_path: null,
      command: ['node', 'scripts/test-files.mjs'],
      status: 'fail',
      exit_code: 1,
      started_at: new Date(1_700_000_000_000),
      finished_at: finishedAt,
      output: 'router progress\nexit 1',
      truncated: false,
      task_state: 'exited',
      task_exit_code: 1,
      task_ended_at: finishedAt,
    };
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{ ...durableSnapshot }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        durableSnapshot.output = values[3];
        durableSnapshot.truncated = values[4];
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered).toMatchObject({
      runId,
      status: 'fail',
      exitCode: 1,
      finishedAt: finishedAt.getTime(),
      truncated: true,
    });
    expect(recovered?.output).toContain('UNSAFE_TRANSACTION');
    expect(recovered?.output).not.toContain('passing output must not be merged');
    expect(recovered?.output.length).toBeLessThanOrEqual(16 * 1024);
    expect(updates).toHaveLength(1);

    const repeated = await store.getRunAsync(runId, sql);
    expect(repeated?.output).toBe(recovered?.output);
    expect(repeated).toMatchObject({ status: 'fail', exitCode: 1, finishedAt: finishedAt.getTime() });
    expect(updates).toHaveLength(1);
  });

  it('recovers a withheld Vitest PASS when an unavailable ledger later returns exact file evidence', async () => {
    const runId = 'terminal-pass-ledger-unavailable-then-readable';
    const requestedFiles = ['lib/first.test.ts'];
    const ledgerRows = [{
      file_path: requestedFiles[0]!,
      status: 'pass',
      finished_at: new Date(1_700_000_011_000),
      output_tail: null,
      execution_details: measuredPass(requestedFiles[0]!, runId),
    }];
    let failFirstLedgerRead = true;
    const durableRow: Record<string, unknown> = {
      run_id: runId,
      task_id: 'task-terminal-pass-ledger-unavailable',
      kind: 'vitest',
      label: 'detached Vitest run',
      file_path: null,
      command: ['node', 'scripts/test-files.mjs'],
      status: 'pass',
      exit_code: 0,
      started_at: new Date(1_700_000_000_000),
      finished_at: new Date(1_700_000_010_000),
      output: '',
      truncated: false,
    };
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{
          ...durableRow,
          task_state: 'exited',
          task_exit_code: 0,
          task_ended_at: new Date(1_700_000_010_000),
          task_detail: { requestedFiles },
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) {
        if (failFirstLedgerRead) {
          failFirstLedgerRead = false;
          throw Object.assign(new Error('private query text'), { code: '57014' });
        }
        return ledgerRows;
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        Object.assign(durableRow, {
          status: values[0],
          exit_code: values[1],
          finished_at: values[2],
          output: values[3],
          truncated: values[4],
        });
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const withheld = await store.getRunAsync(runId, sql);
    expect(withheld).toMatchObject({ runId, status: 'error', exitCode: 0 });
    const diagnostic = withheld!.output.split('\n').find(line => line.startsWith('[coverage-gate:verification] '));
    expect(JSON.parse(diagnostic!.slice('[coverage-gate:verification] '.length))).toMatchObject({
      reason: 'ledger-read-unavailable',
      ledgerReadFailure: { phase: 'query', errorName: 'Error', errorCode: '57014' },
    });
    expect(withheld?.output).not.toContain('private query text');

    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered).toMatchObject({ runId, status: 'pass', exitCode: 0 });
    expect(recovered?.output).not.toContain('[coverage-gate]');
    expect(updates.map(([status]) => status)).toEqual(['error', 'pass']);
  });

  it('rechecks a withheld Vitest PASS when exact requested-file ledger rows arrive later', async () => {
    const runId = 'terminal-pass-ledger-late';
    const requestedFiles = ['lib/first.test.ts', 'lib/second.test.ts'];
    let ledgerRows = [
      { file_path: requestedFiles[0], status: 'pass', finished_at: new Date(1_700_000_001_000), output_tail: null,
        execution_details: measuredPass(requestedFiles[0]!, runId) },
    ];
    const durableRow: Record<string, unknown> = {
      run_id: runId,
      task_id: 'task-terminal-pass-ledger-late',
      kind: 'vitest',
      label: 'detached Vitest run',
      file_path: null,
      command: ['node', 'scripts/test-files.mjs'],
      status: 'pass',
      exit_code: 0,
      started_at: new Date(1_700_000_000_000),
      finished_at: new Date(1_700_000_010_000),
      output: '',
      truncated: false,
    };
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [{
          ...durableRow,
          task_state: 'exited',
          task_exit_code: 0,
          task_ended_at: new Date(1_700_000_010_000),
          task_detail: { requestedFiles },
        }];
      }
      if (statement.includes('FROM harness_shared.test_runs')) return ledgerRows;
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        Object.assign(durableRow, {
          status: values[0],
          exit_code: values[1],
          finished_at: values[2],
          output: values[3],
          truncated: values[4],
        });
        return [{ run_id: runId }];
      }
      return [];
    }) as unknown as Sql;

    const withheld = await store.getRunAsync(runId, sql);
    expect(withheld).toMatchObject({ runId, status: 'error', exitCode: 0 });
    expect(withheld?.output).toContain('do not prove that every requested file passed');

    ledgerRows = requestedFiles.map((file_path, index) => ({
      file_path,
      status: 'pass',
      finished_at: new Date(1_700_000_011_000 + index * 1_000),
      output_tail: null,
      execution_details: measuredPass(file_path, runId),
    }));
    const recovered = await store.getRunAsync(runId, sql);

    expect(recovered).toMatchObject({ runId, status: 'pass', exitCode: 0 });
    expect(recovered?.output).not.toContain('[coverage-gate]');
    expect(updates.map(([status]) => status)).toEqual(['error', 'pass']);
  });

  it('waits for local terminal finalization before returning testing:run status', async () => {
    type Sql = Parameters<Store['persistRunSnapshot']>[1];
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    let releaseTerminalSnapshot!: () => void;
    const terminalSnapshotGate = new Promise<void>((resolve) => {
      releaseTerminalSnapshot = resolve;
    });
    persistSqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('INSERT INTO harness_shared.testing_run_snapshots') && values[5] === 'pass') {
        await terminalSnapshotGate;
      }
      return [];
    });
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('FROM harness_shared.test_runs')) {
        return [{
          file_path: 'lib/local-pass.test.ts',
          status: 'pass',
          finished_at: new Date(1_700_000_001_000),
          output_tail: null,
          execution_details: measuredPass('lib/local-pass.test.ts', values[0] as string),
        }];
      }
      return [];
    }) as unknown as Sql;

    try {
      // Verify this lifecycle uses the fixture's database rather than a live
      // handle obtained by a separate dynamic module resolution.
      const database = await import('@papercusp/db-org');
      expect(database.getOrgPg().sql).toBe(persistSqlMock);
      expect(process.env.PAPERCUSP_TEST_RUNS_PERSIST).toBe('1');
      const snapshot = store.startRun(req({ requestedFiles: ['lib/local-pass.test.ts'] }));
      lastChild._emitClose(0);
      expect(store.getRun(snapshot.runId)).toMatchObject({ status: 'pass' });
      // Readiness must report which writes actually reached the seam rather
      // than hanging until the whole test's timeout if the seam is missed.
      await vi.waitFor(() => {
        const states = persistSqlMock.mock.calls
          .filter(([strings]) => strings.join(' ').includes('INSERT INTO harness_shared.testing_run_snapshots'))
          .map((call) => call[6]);
        expect(states).toContain('pass');
      }, { timeout: 2_000 });

      let settled = false;
      const statusRead = store.getRunAsync(snapshot.runId, sql).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseTerminalSnapshot();
      await expect(statusRead).resolves.toMatchObject({
        runId: snapshot.runId,
        status: 'pass',
        requestedFiles: ['lib/local-pass.test.ts'],
      });
      expect(settled).toBe(true);
    } finally {
      releaseTerminalSnapshot();
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
    }
  });

  it('reconciles a stale running snapshot when its linked task deadline elapsed first', async () => {
    const updates: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'deadline-run',
            task_id: 'task-deadline',
            kind: 'vitest',
            label: 'deadline',
            file_path: 'lib/example.test.ts',
            command: ['node', 'router.js'],
            status: 'running',
            exit_code: null,
            started_at: new Date(Date.now() - 120_000),
            finished_at: null,
            output: 'partial output',
            truncated: false,
            task_state: 'running',
            task_deadline_at: new Date(Date.now() - 1_000),
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
        updates.push(values);
        return [{ run_id: 'deadline-run' }];
      }
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('deadline-run', sql)).resolves.toMatchObject({
      runId: 'deadline-run',
      status: 'error',
      exitCode: null,
      finishedAt: expect.any(Number),
      output: expect.stringContaining('passed its durable runtime deadline'),
    });
    expect(updates).toHaveLength(1);
  });

  it('does not report a local orphan conversion when the compare-and-set loses a race', async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) {
        return [
          {
            run_id: 'raced-run',
            task_id: 'task-raced',
            kind: 'shell',
            label: 'raced',
            file_path: null,
            command: ['bash', '-c', 'true'],
            status: 'running',
            exit_code: null,
            started_at: new Date(1_700_000_000_000),
            finished_at: null,
            output: '',
            truncated: false,
            task_state: 'killed',
          },
        ];
      }
      if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) return [];
      return [];
    }) as unknown as Sql;

    await expect(store.getRunAsync('raced-run', sql)).resolves.toMatchObject({
      runId: 'raced-run',
      taskId: 'task-raced',
      status: 'running',
      finishedAt: null,
    });
  });

  it.each(['timed_out', 'killed', 'ended_unobserved', 'deadline', 'legacy-error',
    'oversized', 'missing-stderr', 'redirected', 'cas-race', 'live'] as const)(
    'withholds orphan child diagnostics when launch environment is unavailable: %s', async scenario => {
      const directory = await mkdtemp('/tmp/detached-orphan-output-');
      try {
        const runId = 'orphan-diagnostic-run';
        const stdoutPath = join(directory, `${runId}.stdout.log`);
        const stderrPath = join(directory, `${runId}.stderr.log`);
        const childOnlySecret = 'synthetic-child-api-key-value';
        const large = scenario === 'oversized' ? 'x'.repeat(2 * 1024 * 1024) : '';
        await writeFile(stdoutPath, large + `ROUTER_PROGRESS completedCases=42\nSYNTHETIC_CHILD_API_KEY=${childOnlySecret}\n`);
        if (scenario !== 'missing-stderr') {
          await writeFile(stderrPath, large + `CHILD_BUDGET timeoutMs=87986\nSYNTHETIC_CHILD_API_KEY=${childOnlySecret}\n`);
        }
        if (scenario === 'redirected') {
          const outside = join(directory, 'unrelated');
          await writeFile(outside, 'PRIVATE_UNRELATED_CONTENT');
          await rm(stdoutPath); await symlink(outside, stdoutPath);
        }
        const legacy = scenario === 'legacy-error';
        const persisted = {
          run_id: runId, task_id: 'task-orphan-diagnostic', kind: 'vitest', label: 'orphan diagnostics',
          file_path: 'lib/example.test.ts', command: ['node', 'router.js'],
          status: legacy ? 'error' : 'running', exit_code: null,
          started_at: new Date(Date.now() - 120_000),
          finished_at: legacy ? new Date(Date.now() - 1_000) : null,
          output: legacy ? '[detached-recovery] no test verdict was observed.\n' : 'partial output\n',
          truncated: false, task_state: scenario === 'deadline' || scenario === 'live' ? 'running' :
            scenario === 'ended_unobserved' ? 'ended_unobserved' : scenario === 'killed' ? 'killed' : 'timed_out',
          task_deadline_at: scenario === 'deadline' ? new Date(Date.now() - 1_000) : null,
          task_exit_code: null, task_ended_at: scenario === 'live' || scenario === 'deadline' ? null : new Date(),
          task_detail: { detachedReportArtifacts: { schemaVersion: 1, artifacts: [{
            reportPath: join(directory, 'missing-report.json'), root: directory,
            scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
            worktreeBefore: { commit: null, porcelain: null }, stdoutPath, stderrPath,
          }] } },
        };
        const updates: unknown[][] = [];
        const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const statement = strings.join(' ');
          if (statement.includes('FROM harness_shared.testing_run_snapshots AS snapshot')) return [{ ...persisted }];
          if (statement.includes('UPDATE harness_shared.testing_run_snapshots')) {
            updates.push(values);
            if (scenario === 'cas-race') return [];
            Object.assign(persisted, { status: values[0], exit_code: values[1], finished_at: values[2],
              output: values[3], truncated: values[4] });
            return [{ run_id: runId }];
          }
          return [];
        }) as unknown as Sql;
        outputIo.wholeReads.length = 0; outputIo.reads.length = 0;
        const result = await store.getRunAsync(runId, sql);
        if (scenario === 'live' || scenario === 'cas-race') {
          expect(result).toMatchObject({ status: 'running', output: 'partial output\n', finishedAt: null });
          if (scenario === 'live') expect(outputIo.reads).toHaveLength(0);
        } else {
          expect(result).toMatchObject({ status: 'error', exitCode: null, finishedAt: expect.any(Number) });
          expect(result?.output).not.toContain('ROUTER_PROGRESS completedCases=42');
          expect(result?.output).not.toContain('CHILD_BUDGET timeoutMs=87986');
          expect(result?.output).not.toContain('PRIVATE_UNRELATED_CONTENT');
          expect(result?.output).not.toContain(childOnlySecret);
          expect(result?.output.length).toBeLessThanOrEqual(16 * 1024);
          if (scenario === 'oversized') expect(result?.truncated).toBe(false);
          expect(updates).toHaveLength(scenario === 'legacy-error' ? 0 : 1);
          const readCount = outputIo.reads.length;
          const again = await store.getRunAsync(runId, sql);
          expect(again?.output).toBe(result?.output);
          expect(updates).toHaveLength(scenario === 'legacy-error' ? 0 : 1);
          expect(outputIo.reads).toHaveLength(readCount);
        }
        expect(outputIo.wholeReads).toHaveLength(0);
        expect(outputIo.reads).toHaveLength(0);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

  it('still launches when the durable write fails and reports durable=false', async () => {
    const sql = vi.fn(async () => {
      throw new Error('database unavailable');
    }) as unknown as Sql;

    const result = await store.startRunDurable(req(), sql);

    expect(result.durable).toBe(false);
    expect(result.snapshot.status).toBe('running');
    expect(spawnMock).toHaveBeenCalled();
  });

  it('freezes snapshot values before an asynchronous persistence lookup', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sql = vi.fn(async () => {
      await gate;
      return [];
    }) as unknown as Sql;
    const snapshot: Parameters<Store['persistRunSnapshot']>[0] = {
      runId: 'race-run',
      kind: 'shell' as const,
      label: 'race',
      command: ['bash', '-c', 'true'],
      status: 'running' as const,
      exitCode: null,
      startedAt: 1_700_000_000_000,
      finishedAt: null,
      output: '',
      truncated: false,
    };

    const pending = store.persistRunSnapshot(snapshot, sql);
    snapshot.status = 'pass';
    snapshot.exitCode = 0;
    snapshot.finishedAt = snapshot.startedAt + 1_000;
    release();
    await expect(pending).resolves.toBe(true);

    const values = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0].slice(1);
    expect(values[5]).toBe('running');
    expect(values[6]).toBeNull();
    expect(values[8]).toBeNull();
  });
});

describe('fallback persistence worktree snapshots (EI-18795303393201472)', () => {
  it('uses the post-run commit and marks a run dirty when the tree changes', async () => {
    // Load the partial db-org mock before the close handler starts its 1s
    // persistence window; importOriginal is cold after resetModules.
    await import('@papercusp/db-org');
    let runClosed = false;
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('rev-parse')) return runClosed ? 'after-sha\n' : 'before-sha\n';
      if (args.includes('status')) return runClosed ? ' M peer-edit.ts\n' : '';
      return '';
    });
    let runId: string | undefined;
    let resolveFallback!: (row: Record<string, unknown>) => void;
    const fallbackPersisted = new Promise<Record<string, unknown>>((resolve) => {
      resolveFallback = resolve;
    });
    persistSqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (runId && strings.join(' ').includes('INSERT INTO harness_shared.test_runs')) {
        const row = insertedColumns(strings, values);
        if (row.run_group_id === runId) resolveFallback(row);
      }
      return Promise.resolve([]);
    });
    const previousPersistOptIn = process.env.PAPERCUSP_TEST_RUNS_PERSIST;
    process.env.PAPERCUSP_TEST_RUNS_PERSIST = '1';
    try {
      const snapshot = store.startRun(req({ kind: 'shell' }));
      runId = snapshot.runId;
      runClosed = true;
      lastChild._emitClose(0);
      const persisted = await fallbackPersisted;
      expect(persisted.commit_sha).toBe('after-sha');
      expect(persisted.worktree_dirty).toBe(true);
      expect(persisted.execution_details).toMatchObject({
        runStartedAt: new Date(snapshot.startedAt).toISOString(),
      });
      // P-011: the fallback row records the configuration the measured child ran under.
      expect(persisted.configuration_snapshot).toMatchObject({
        schemaVersion: 1,
        fingerprint: expect.stringMatching(/^sha256-config-snapshot-v1:[0-9a-f]{64}$/),
      });
    } finally {
      if (previousPersistOptIn === undefined) delete process.env.PAPERCUSP_TEST_RUNS_PERSIST;
      else process.env.PAPERCUSP_TEST_RUNS_PERSIST = previousPersistOptIn;
    }
  });
});

/**
 * testing:run — integration coverage for the GLUE (plan
 * `bash-to-tool-substitution-2026-07-26`, P-021 / D-022).
 *
 * Deliberately integration, not unit: this tool's whole job is to shell the
 * real `scripts/test-files.mjs` and read back what Vitest actually wrote. A
 * mocked spawn would pin my MODEL of the router's contract, which is precisely
 * the thing worth verifying — the tool rests on the router forwarding
 * `--reporter=json --outputFile` through its own `--` argument split, and on
 * `inferWorkspaceRoot()` resolving the REPO root (not the package root) so
 * `<root>/scripts/test-files.mjs` exists.
 *
 * The PROJECTION is not retested here — `distillVitestRun` has full unit
 * coverage over hand-built reports in `lib/__tests__/testing-run-store.test.ts`
 * (including the collection-failure case, which is drill-proven). What only a
 * real run can establish is the seam, so that is all this file spends its
 * minutes on.
 *
 * The real RED-run case uses a checked-in, env-gated fixture. Do not recreate the old
 * runtime-written `lib/__testing-run-sidecar-*.test.ts` shape: a concurrent pure-lane census
 * could enroll that temporary path, then fail collection after this suite removed it.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { _resetHarnessAdminUrlCacheForTests } from '../../../embedded-pg-discovery';
import { REPO_ROOT } from '../../docs/_repo-paths';
import runTool, {
  buildDetachedMixedTestRunRequest,
  buildDetachedTestRunRequest,
  buildTestProcessDemand,
  classifyTestProcessOutcome,
  checkoutRootForTestFiles,
  groupTestFilesByCheckout,
  createBoundedRouterOutputCapture,
  createTestProcessDemandSampler,
  detachedTestTimeoutHint,
  discoverKnownHiveCheckoutRoots,
  groupDirectVitestRoutes,
  launchManagedTestProcess,
  noReportDiagnostics,
  normalizeTestFilePaths,
  parseRouterTerminalCompletion,
  parseRouterNotMeasuredMarker,
  parseRouterTestResult,
  parseNodeTestGroupRuns,
  preserveConfinedTestOnHostShutdown,
  readManagedTestProcessResourceSnapshot,
  mapHarnessTestRunIdsByFile,
  readHarnessTestRunIdsBounded,
  readTestProcessResourceSnapshot,
  runTestFilesCore,
  settleConfinedTestOnHostShutdown,
  runWithTestProcessDeadline,
  waitForTestProcessClose,
  resolveAdminTestRunsReporterPath,
  resolveRegisteredTestFileRoot,
  selectTestFileRoot,
  shouldResolveHarnessTestRunIds,
  shouldIngestVitestLedgerInProcess,
  type TestingRunPhaseTimings,
  TEST_RUN_ID_READBACK_TIMEOUT_MS,
  withInProcessTestingRunForegroundCeiling,
} from '../run';
import { cancelRun, getRun, type HarnessTestRunEvidence } from '../../../testing-run-store';
import { listDirtyFilesRecursive, readRestrictedWindowHoldings, type HoldRunGit } from '../../../personal-vault/git-sync-hold';
import { restrictedHoldRefusal } from '../restricted-hold-fence';
import { __resetShutdownStateForTest, markShuttingDown } from '../../../shutdown-state';
import type { TestRunArtifactPaths, TestRunDeadline } from '../run-artifacts';
import { createNativeArtifactPersister } from '../../../../../../scripts/lib/budgeted-task-scheduler.mjs';

/**
 * Invoke the tool's raw handler. Called directly (rather than through the MCP
 * dispatcher) a handler returns its own return value verbatim — for this tool
 * `{ data }`. The MCP `{ content: [{ text }] }` envelope is applied by the
 * transport layer above, so unwrap both shapes rather than assuming either.
 * `ctx` defaults to `{}` (no projectDir — resolves via PAPERCUSP_INTEGRATION_ROOT
 * or cwd, both the real repo root under vitest); WI-7189's `invalid_root` case
 * overrides it with a fake `projectDir` to exercise the wrong-tree path.
 */
function call(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const invoke = () => (
    runTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<unknown>;
    }
  ).handler(args, ctx);
  // WI-6554700010018388: this call is in-process, so no MCP transport cap applies. A case that
  // authors no timeoutMs is checking verdict CLASSIFICATION, so it gets a ceiling that box load
  // cannot push a ~20s vitest cold start past. A case that passes timeoutMs is testing the budget
  // itself, so it keeps the transport clamp.
  return args.timeoutMs === undefined
    ? withInProcessTestingRunForegroundCeiling(IN_PROCESS_CLASSIFICATION_CEILING_MS, invoke)
    : invoke();
}

/** Below every classification case's own vitest timeout (>=120s) minus the handler's 20s phase headroom. */
const IN_PROCESS_CLASSIFICATION_CEILING_MS = 90_000;

/** The envelope testing:run returns (success and error shapes together). */
interface RunResult {
  ok: boolean;
  artifacts?: TestRunArtifactPaths;
  deadline?: TestRunDeadline;
  runId?: string;
  root?: string;
  rootSource?: string;
  error?: string;
  detachedRunId?: string;
  originAliasDurable?: boolean;
  hint?: string;
  routerOutput?: string;
  completedGroups?: Array<{
    root: string;
    files: string[];
    filesOmitted?: number;
    ok: boolean;
    result: {
      passed: number;
      failed: number;
      skipped: number;
      files: number;
      failures: Array<{ file: string; test: string; message: string; actual?: string; expected?: string }>;
      failuresTruncated: boolean;
      byFile: Record<string, unknown>;
    };
  }>;
  completedGroupsOmitted?: number;
  status?: 'not-measured';
  reason?: 'admission-starved' | 'undetermined';
  requested?: number;
  executed?: number;
  matched?: number;
  measuredFiles?: 0;
  passed?: number;
  failed?: number;
  skipped?: number;
  files?: number;
  failures?: Array<{ file: string; test: string; message: string; actual?: string; expected?: string }>;
  failuresTruncated?: boolean;
  durationMs?: number | null;
  testRunIds?: number[];
  byFile?: Record<string, unknown>;
  phaseTimingsMs?: TestingRunPhaseTimings;
}

async function body(p: ReturnType<typeof call>): Promise<RunResult> {
  const raw = (await p) as { data?: unknown; content?: Array<{ text: string }> };
  if (raw?.data !== undefined) return raw.data as RunResult;
  if (raw?.content?.[0]?.text) return JSON.parse(raw.content[0].text) as RunResult;
  throw new Error(`unrecognised tool result shape: ${JSON.stringify(raw)?.slice(0, 200)}`);
}

/** A small, stable, PG-free unit suite in this package — a real green target. */
const GREEN_TARGET = 'packages/operator-core/lib/testing-flakiness.test.ts';
const OPERATOR_CORE_RELATIVE_GREEN_TARGET = 'lib/testing-flakiness.test.ts';
const FAILING_ASSERTION_TARGET =
  'packages/operator-core/lib/agent-tools/testing/__tests__/run-failure-fixture.test.ts';
const FAILING_ASSERTION_TARGET_VAR = 'PAPERCUSP_TESTING_RUN_ASSERTION_FIXTURE';
const HANG_TARGET = 'packages/operator-core/lib/agent-tools/testing/__tests__/run-hang-fixture.test.ts';
const HANG_TARGET_VAR = 'PAPERCUSP_TESTING_RUN_HANG_FIXTURE';

/**
 * A real in-repo suite that collects tests and executes NONE of them unless its env var is set
 * (`describe.skipIf(!LIVE)`), for the all-skipped refusal. Deliberately a real file rather than a
 * fixture: an always-skipped fixture committed for this test would itself be collected by every
 * normal run. If this suite is ever un-gated, the case fails loudly instead of going vacuous.
 */
const ENV_GATED_TARGET = 'packages/operator-core/lib/agent-tools/computer/capture-geometry-live.test.ts';
const ENV_GATED_TARGET_VAR = 'PAPERCUSP_CAPTURE_GEOMETRY_LIVE';

/**
 * A name-filter fragment that DOES match inside GREEN_TARGET. Deliberately its top-level
 * `describe` — the name of the exported function under test — so this is only a tripwire for a
 * real API rename, not for incidental edits to the suite (same reasoning as the un-pinned counts
 * above). Vitest matches the FULL name, so a `describe` fragment matches every test beneath it.
 */
const GREEN_TARGET_TEST_NAME_FRAGMENT = 'computeFlakiness';

/**
 * A green target in a DIFFERENT workspace (apps/operator), so a request naming both
 * routes into TWO groups — the only shape that can exhibit EI-18822211427354845.
 * Chosen for being a pure readFileSync text guard: fast, PG-free, no Tauri/Xvfb.
 */
const CROSS_WORKSPACE_GREEN_TARGET = 'apps/operator/lib/verify-tauri-headless-port-straggler.test.ts';
/**
 * A real node:test file the router runs with `node --test`. It must stay FAST: every case
 * using it goes through the public handler, whose foreground budget is about 25s. The previous
 * target, mac-vm-health.test.js, grew to 33 cases of about 1.4s each (24.9s for the bare
 * `node --test` on 2026-10-20), so the distill and byFile cases timed out on every run and
 * reported `timeout` instead of their real verdict (WI-6554700010018388). This one is 4 pure
 * in-process cases (~0.3s) with no child processes.
 */
const NODE_TEST_TARGET = 'papercusp-desktop/test/docs-search-server-terminal-state.test.js';

// The real SideStage checkout is the measured external-Hive case. Keep the target discovery
// dynamic so this suite remains portable to boxes that do not have a local Hive seed; the test
// is skipped there, while the live validation lane runs it whenever the target exists.
const SIDESTAGE_HIVE_ROOT = discoverKnownHiveCheckoutRoots().find(
  (root) => root.endsWith('/sidestage') && existsSync(join(root, 'apps/web/src/auction.test.tsx')),
);
const SIDESTAGE_LAYERED_TARGET = SIDESTAGE_HIVE_ROOT
  ? join(SIDESTAGE_HIVE_ROOT, 'apps/web/src/CopilotPanel.integration.test.tsx')
  : null;

const selectorRoots: string[] = [];
const selectorPhantom = join(tmpdir(), 'papercusp-testing-run-selector-phantom-does-not-exist');
let selectorCanonical = '';
let selectorRequested = '';
let org: OrgTestDb | undefined;
const databaseEnvKeys = [
  'HARNESS_DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL',
  'PAPERCUSP_TEST_RUNS_DB_URL',
  'PAPERCUSP_PGBOUNCER', 'PAPERCUSP_SKIP_PG_DISCOVERY',
] as const;
const savedDatabaseEnv = new Map(databaseEnvKeys.map((key) => [key, process.env[key]]));

const scratchGit: HoldRunGit = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const failure = error ? JSON.stringify({
      message: error.message,
      code: error.code,
      signal: error.signal,
      killed: error.killed,
    }) : '';
    resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: [String(stderr), failure].filter(Boolean).join('\n') });
  });
});

/** Commit only generated files in this suite's disposable repositories, never the shared tree. */
async function sealScratchTestCheckout(root: string): Promise<void> {
  for (const args of [
    ['init', '-q'],
    ['add', '--all'],
    ['-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
      'commit', '-q', '--allow-empty', '-m', 'Generated testing:run fixture'],
  ]) {
    const result = await scratchGit(args, root);
    if (result.code !== 0) throw new Error(`scratch checkout git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

async function makeScratchTestCheckout(prefix: string, file = 'packages/x/real.test.ts'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  selectorRoots.push(root);
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, file), 'export {};\n');
  await sealScratchTestCheckout(root);
  return root;
}

async function cancelFixtureRecovery(runId: string): Promise<void> {
  const taskId = getRun(runId)?.taskId;
  expect(taskId, 'recovery cleanup needs its real managed task identity').toBeDefined();
  expect(cancelRun(runId)).toBe(true);
  // cancelRun marks the snapshot cancelled before signalling the process.
  // The task ledger is updated by its actual close handler, so wait for that
  // transition before another fixture starts or afterAll drops the database.
  await vi.waitFor(async () => {
    const [row] = await getOrgPg().sql<{ state: string }[]>`
      SELECT state FROM harness_shared.task_ledger WHERE task_id = ${taskId!}
    `;
    expect(row?.state).toMatch(/^(killed|exited)$/);
  }, { timeout: 5_000 });
}

beforeAll(async () => {
  // Run the real custody census and every nested router against this suite's
  // disposable migrated database, using the maintained org fixture.
  org = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = org.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = org.adminDsn;
  process.env.DATABASE_URL = org.adminDsn;
  // Nested runs are queried through this suite's org connection. Keep their
  // reporter in the same disposable database instead of inheriting the outer
  // runner's durable sink (which records this integration file itself).
  process.env.PAPERCUSP_TEST_RUNS_DB_URL = org.adminDsn;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  _resetHarnessAdminUrlCacheForTests();
  await _resetForTests();
  // The nested owned-db fixture needs only this real org substrate. In a forced
  // exit its afterAll cannot remove disposable scratch repositories, so do not
  // create unrelated selector fixtures in that child.
  if (['normal', 'forced'].includes(process.env.PAPERCUSP_TESTING_RUN_OWNED_FIXTURE ?? '')) return;
  selectorCanonical = await makeScratchTestCheckout('papercusp-testing-run-selector-canonical-');
  selectorRequested = await makeScratchTestCheckout('papercusp-testing-run-selector-requested-');
  await rm(selectorPhantom, { recursive: true, force: true });
}, 120_000);

afterAll(async () => {
  try {
    await Promise.all(selectorRoots.map((root) => rm(root, { recursive: true, force: true })));
    await _resetForTests();
    await org?.cleanup();
  } finally {
    for (const key of databaseEnvKeys) {
      const saved = savedDatabaseEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    _resetHarnessAdminUrlCacheForTests();
  }
});

// Only the nested router selected by the two cleanup regressions enables this
// checked-in fixture. It uses the actual migrated org fixture and parent registry.
const OWNED_FIXTURE_MODE = 'PAPERCUSP_TESTING_RUN_OWNED_FIXTURE';
const OWNED_FIXTURE_READY = 'PAPERCUSP_TESTING_RUN_OWNED_READY_PATH';
const OWNED_FIXTURE_NAME = 'testing:run owned database fixture';
interface OwnedFixtureReady {
  dbName: string;
  suiteDbName: string;
  appBackendPid: number;
  adminBackendPid: number;
  pid: number;
  runId: string;
  selectedPath: string;
}
it.skipIf(!['normal', 'forced'].includes(process.env[OWNED_FIXTURE_MODE] ?? ''))(OWNED_FIXTURE_NAME, async () => {
  const fixture = await createOrgTestDb();
  try {
    const [app, admin] = await Promise.all([
      fixture.appSql<{ name: string; role: string; pid: number }[]>`
        SELECT current_database() AS name, current_user AS role, pg_backend_pid() AS pid`,
      fixture.adminSql<{ name: string; role: string; pid: number }[]>`
        SELECT current_database() AS name, current_user AS role, pg_backend_pid() AS pid`,
    ]);
    expect(app[0]).toMatchObject({ name: fixture.dbName, role: 'harness_app' });
    expect(admin[0]).toMatchObject({ name: fixture.dbName, role: 'harness_admin' });
    const readyPath = process.env[OWNED_FIXTURE_READY]!;
    await writeFile(`${readyPath}.pending`, JSON.stringify({ dbName: fixture.dbName,
      suiteDbName: org!.dbName, appBackendPid: app[0]!.pid, adminBackendPid: admin[0]!.pid,
      pid: process.pid, runId: process.env.PAPERCUSP_TEST_RUN_GROUP,
      selectedPath: 'packages/operator-core/lib/agent-tools/testing/__tests__/run.integration.test.ts' }));
    // Publish a complete receipt before the parent's existence/read handshake.
    await rename(`${readyPath}.pending`, readyPath);
    if (process.env[OWNED_FIXTURE_MODE] === 'forced') {
      // Parent cancellation must kill this worker and clean both this database and
      // the suite's beforeAll database; neither finally nor afterAll can do it.
      await new Promise<void>(() => {});
    } else {
      expect(await fixture.cleanupWithResult()).toBe('dropped');
    }
  } finally {
    // Assertion failures in the normal child must also release its independent fixture.
    await fixture.cleanup();
  }
}, 180_000);

describe('real owned org fixture cleanup through the maintained runner', () => {
  it.each(['normal', 'forced'] as const)('confirms database/process/receipt cleanup after %s exit', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'testing-run-owned-fixture-ready-'));
    selectorRoots.push(root);
    const readyPath = join(root, 'ready.json');
    const savedMode = process.env[OWNED_FIXTURE_MODE];
    const savedReady = process.env[OWNED_FIXTURE_READY];
    process.env[OWNED_FIXTURE_MODE] = mode;
    process.env[OWNED_FIXTURE_READY] = readyPath;
    const controller = new AbortController();
    const runId = randomUUID();
    const selectedPath = 'packages/operator-core/lib/agent-tools/testing/__tests__/run.integration.test.ts';
    const taskDeadlineAtMs = Date.now() + 180_000;
    const runPromise = runTestFilesCore({ root: REPO_ROOT, files: [selectedPath], runId,
      testNamePattern: `^${OWNED_FIXTURE_NAME}$`, timeoutMs: 180_000, taskDeadlineAtMs,
      cleanupReserveMs: 30_000, allowDetachedRecovery: false, signal: controller.signal });
    try {
      await Promise.race([
        vi.waitFor(() => expect(existsSync(readyPath)).toBe(true), { timeout: 120_000, interval: 100 }),
        runPromise.then(result => {
          if (!existsSync(readyPath)) throw new Error(`owned fixture did not reach readiness: ${JSON.stringify(result)}`);
        }),
      ]);
      const ready = JSON.parse(await readFile(readyPath, 'utf8')) as OwnedFixtureReady;
      expect(ready).toMatchObject({ runId, selectedPath, dbName: expect.stringMatching(/^org_/),
        suiteDbName: expect.stringMatching(/^org_/), pid: expect.any(Number),
        appBackendPid: expect.any(Number), adminBackendPid: expect.any(Number) });
      const ownedDbNames = [ready.dbName, ready.suiteDbName];
      expect(new Set(ownedDbNames).size).toBe(2);
      expect(ownedDbNames).not.toContain(org!.dbName);
      expect(ready.appBackendPid).not.toBe(ready.adminBackendPid);
      if (mode === 'forced') {
        // Positive controls: the worker and both real client sessions must exist
        // before abort, so an empty post-run census cannot pass vacuously.
        expect(await pidsTaggedWithRun(runId)).toContain(ready.pid);
        const databases = await org!.adminSql<{ datname: string }[]>`
          SELECT datname FROM pg_database WHERE datname IN (${ready.dbName}, ${ready.suiteDbName})`;
        expect(databases.map(row => row.datname).sort()).toEqual([...ownedDbNames].sort());
        const sessions = await org!.adminSql<{ pid: number; usename: string; datname: string }[]>`
          SELECT pid, usename, datname FROM pg_stat_activity
          WHERE pid IN (${ready.appBackendPid}, ${ready.adminBackendPid})`;
        expect(sessions).toHaveLength(2);
        expect(sessions).toEqual(expect.arrayContaining([
          { pid: ready.appBackendPid, usename: 'harness_app', datname: ready.dbName },
          { pid: ready.adminBackendPid, usename: 'harness_admin', datname: ready.dbName },
        ]));
        controller.abort(new Error('owned-fixture forced cancellation control'));
      }
      const result = await runPromise;
      expect(result, JSON.stringify(result)).toMatchObject(mode === 'normal'
        ? { ok: true, passed: 1, failed: 0 } : { ok: false, error: 'aborted' });
      expect(result).not.toHaveProperty('detachedRunId');
      expect(result.cleanup, JSON.stringify(result)).toMatchObject({ complete: true, errors: [] });
      for (const name of ownedDbNames) {
        expect(result.cleanup!.databases).toContainEqual({ name, outcome: 'dropped' });
        const registration = JSON.parse(await readFile(join(result.artifacts!.ownedDatabases, `${name}.json`), 'utf8'));
        expect(registration).toMatchObject({ runId, name, outcome: 'dropped' });
      }
      for (const database of result.cleanup!.databases) {
        expect(database.outcome).toBe('dropped');
        expect(await org!.adminSql`SELECT datname FROM pg_database WHERE datname = ${database.name}`).toHaveLength(0);
        expect(await org!.adminSql`SELECT pid FROM pg_stat_activity WHERE datname = ${database.name}`).toHaveLength(0);
      }
      expect(await pidsTaggedWithRun(runId)).toEqual([]);
      const manifest = JSON.parse(await readFile(result.artifacts!.manifest, 'utf8'));
      expect(manifest).toMatchObject({ runId, childState: 'closed', state: 'retained',
        deadline: { taskDeadlineAtMs, cleanupReserveMs: 30_000 }, cleanup: { complete: true } });
      const receipts = (await readFile(join(result.artifacts!.ownedDatabases, 'cleanup.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      for (const name of ownedDbNames) {
        expect(receipts).toContainEqual(expect.objectContaining({ runId, name, stage: 'registered', outcome: 'owned' }));
        expect(receipts).toContainEqual(expect.objectContaining({ runId, name,
          stage: 'database-drop-result', outcome: 'dropped' }));
        if (mode === 'forced') expect(receipts).toContainEqual(expect.objectContaining({
          runId, name, stage: 'database-drop', priorOutcome: 'owned' }));
      }
      expect(receipts).toContainEqual(expect.objectContaining({ runId, name: '*',
        stage: 'complete', complete: true, errors: [] }));
      if (mode === 'normal') {
        expect(receipts).toContainEqual(expect.objectContaining({ runId, name: ready.dbName,
          stage: 'clients-stopped', clients: [
            { role: 'app', status: 'fulfilled' }, { role: 'admin', status: 'fulfilled' },
          ] }));
        expect(receipts).toContainEqual(expect.objectContaining({ runId, name: ready.dbName,
          stage: 'complete', outcome: 'dropped' }));
      }
      const router = JSON.parse(await readFile(join(result.artifacts!.directory, 'router.json'), 'utf8'));
      expect(router).toMatchObject({ childState: 'closed', aborted: mode === 'forced' });
      expect(router.outputLogPaths.length).toBeGreaterThan(0);
      for (const path of router.outputLogPaths) expect(existsSync(path)).toBe(true);
      const ledger = JSON.parse(await readFile(join(result.artifacts!.directory, 'ledger.json'), 'utf8'));
      expect(ledger).toMatchObject({ runGroup: runId, status: 'reference-only; presence and verdict require ledger readback' });
    } finally {
      controller.abort(new Error('owned-fixture regression teardown'));
      try {
        await runPromise;
      } finally {
        if (savedMode === undefined) delete process.env[OWNED_FIXTURE_MODE];
        else process.env[OWNED_FIXTURE_MODE] = savedMode;
        if (savedReady === undefined) delete process.env[OWNED_FIXTURE_READY];
        else process.env[OWNED_FIXTURE_READY] = savedReady;
      }
    }
  }, 240_000);
});

describe('scratch checkout custody census (WI-10007684)', () => {
  // This fixture implements only the tagged query used by the hold census,
  // rather than the connection methods carried by the full Db interface.
  const activeWindowSql = (async () => [{ since: new Date(0), restricted: ['fixture-restricted'] }]) as unknown as
    NonNullable<Parameters<typeof readRestrictedWindowHoldings>[0]['sql']>;
  const holdings = (root: string) => readRestrictedWindowHoldings({
    sql: activeWindowSql,
    listDirtyFiles: () => listDirtyFilesRecursive(scratchGit, root),
  });

  it('binds the production census client to this suite\'s isolated database', async () => {
    const [row] = await getOrgPg().sql<{ database: string }[]>`SELECT current_database() AS database`;
    expect(row?.database).toBe(org?.dbName);
    expect(await restrictedHoldRefusal(selectorCanonical, ['packages/x/real.test.ts'])).toBeNull();
  });

  it('admits a real clean fixture during an active disclosure window', async () => {
    expect(await listDirtyFilesRecursive(scratchGit, selectorCanonical)).toEqual([]);
    expect(await restrictedHoldRefusal(selectorCanonical, ['packages/x/real.test.ts'], { holdings })).toBeNull();
  });

  it('keeps an empty Git marker fail-closed with the actual census failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-malformed-git-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    const refusal = await restrictedHoldRefusal(root, ['packages/x/real.test.ts'], { holdings });
    expect(refusal).toMatchObject({ error: 'restricted_hold_state_unknown' });
    expect(refusal?.hint).toContain('git submodule status failed');
    expect(refusal?.hint).toContain('not a git repository');
  });
});

describe('bounded router-output diagnostics (EI-23084691057182393)', () => {
  it('preserves exact Node group results when stderr evicts their stdout from the display tail', () => {
    const capture = createBoundedRouterOutputCapture();
    capture.append('stdout', 'ROUTE cwd=papercusp-desktop runner=node:test\n  requested test/a.test.js\nℹ tests 4\nℹ pass 3\nℹ fail 1\n');
    capture.append('stdout', 'TEST_FILE_GROUP_RESULT cwd=papercusp-desktop runner=node:test executed=1 status=failed\n');
    capture.append('stdout', 'ROUTE cwd=packages/operator-core config=vitest.config.ts\n');
    capture.append('stdout', 'ℹ tests 99\nℹ pass 99\nℹ fail 0\n');
    capture.append('stderr', 'COMMITTED_SOURCE unrelated child diagnostic\n'.repeat(1000));
    expect(capture.finish()).not.toContain('ℹ tests 4');
    expect(parseNodeTestGroupRuns(capture.nodeTestOutput(), ['papercusp-desktop/test/a.test.js']))
      .toMatchObject([{ files: 1, passed: 3, failed: 1,
        byFile: { 'papercusp-desktop/test/a.test.js': { passed: 3, failed: 1 } } }]);
  });

  it('keeps a failing first-group marker after later progress displaces it from the raw tail', () => {
    const capture = createBoundedRouterOutputCapture();
    const refusal = 'TEST_FILE_ROUTE_ERROR (group cwd=apps/operator) requested=4 matched=0; use testing:run';
    capture.append('stderr', `${refusal}\n`);
    capture.append('stderr', `${'TEST_FILE_PROGRESS state=running cwd="packages/operator-core" x=1\n'.repeat(200)}`);
    capture.append('stdout', 'ROUTE cwd=apps/operator config=vitest.config.ts\n');

    const output = capture.finish();
    expect(output.slice(-2_000)).toContain(refusal);
    expect(output).toContain('TESTING_RUN_PRIORITY_DIAGNOSTICS retained-before-tail-truncation');
    expect(output.length).toBeLessThanOrEqual(8_192);
  });

  it.each(['Error', 'Caused by'])('keeps an ANSI-colored %s setup failure after progress displaces it', (prefix) => {
    const capture = createBoundedRouterOutputCapture();
    capture.append('stderr', '\u001b[');
    capture.append('stderr', `31m${prefix}\u001b[39m: TEST SUBSTRATE STORAGE LOW\n`);
    capture.append('stdout', 'TEST_FILE_PROGRESS state=running\n'.repeat(500));

    const output = capture.finish();
    expect(output.slice(-2_000)).toContain(`${prefix}: TEST SUBSTRATE STORAGE LOW`);
    expect(output).toContain('TESTING_RUN_PRIORITY_DIAGNOSTICS retained-before-tail-truncation');
    expect(output.length).toBeLessThanOrEqual(8_192);
  });

  it('leaves a short ANSI-colored diagnostic unchanged without duplicating its normalized form', () => {
    const capture = createBoundedRouterOutputCapture();
    const output = '\u001b[31mError\u001b[39m: setup refused\n';
    capture.append('stderr', output);
    expect(capture.finish()).toBe(output);
  });

  it('reassembles a diagnostic split across stderr chunks and leaves a short tail unduplicated', () => {
    const capture = createBoundedRouterOutputCapture();
    capture.append('stderr', 'TEST_FILE_ROUTE_');
    capture.append('stderr', 'ERROR (group cwd=apps/operator) requested=4 matched=0\n');

    const output = capture.finish();
    expect(output.match(/TEST_FILE_ROUTE_ERROR/g)).toHaveLength(1);
    expect(output).not.toContain('TESTING_RUN_PRIORITY_DIAGNOSTICS');
  });

  it.each(['ADMISSION_ERROR', 'FINALIZATION_ERROR'])('keeps the %s failure cause after later progress evicts it', (kind) => {
    const capture = createBoundedRouterOutputCapture();
    const diagnostic = `TEST_FILE_${kind} detail=original-failure origin=original-stack`;
    capture.append('stderr', `${diagnostic}\n`);
    capture.append('stdout', 'TEST_FILE_PROGRESS state=running\n'.repeat(500));
    expect(capture.finish().slice(-2_000)).toContain(diagnostic);
  });
});

describe('selectTestFileRoot (WI-41400 phantom-root fallback)', () => {
  const files = ['packages/x/real.test.ts'];

  it('falls back to the canonical repo when the requested root is invalid and the canonical repo resolves every file', () => {
    expect(
      selectTestFileRoot(files, selectorPhantom, { discoveredRoots: [], canonicalRepoRoot: selectorCanonical }),
    ).toEqual({ root: selectorCanonical, source: 'canonical-repo' });
  });

  it('keeps a valid requested checkout authoritative even when the canonical repo also resolves every file', () => {
    expect(
      selectTestFileRoot(files, selectorRequested, { discoveredRoots: [], canonicalRepoRoot: selectorCanonical }),
    ).toEqual({ root: selectorRequested, source: 'requested' });
  });

  it('selects exactly one resolving discovered Hive checkout before the canonical repo', async () => {
    const discovered = await makeScratchTestCheckout('papercusp-testing-run-selector-discovered-');
    expect(
      selectTestFileRoot(files, selectorPhantom, {
        discoveredRoots: [discovered],
        canonicalRepoRoot: selectorCanonical,
      }),
    ).toEqual({ root: discovered, source: 'hive-checkout' });
  });

  it('refuses a discovered-root tie instead of letting the canonical repo break the ambiguity', async () => {
    const first = await makeScratchTestCheckout('papercusp-testing-run-selector-tie-a-');
    const second = await makeScratchTestCheckout('papercusp-testing-run-selector-tie-b-');
    expect(
      selectTestFileRoot(files, selectorPhantom, {
        discoveredRoots: [first, second],
        canonicalRepoRoot: selectorCanonical,
      }),
    ).toEqual({ root: selectorPhantom, source: 'requested' });
  });

  it('preserves the requested root when no valid checkout resolves every file', () => {
    expect(
      selectTestFileRoot(['packages/x/missing.test.ts'], selectorPhantom, {
        discoveredRoots: [],
        canonicalRepoRoot: selectorCanonical,
      }),
    ).toEqual({ root: selectorPhantom, source: 'requested' });
  });

  it('uses only the caller-named registered checkout for an explicit rootHarnessSlug', async () => {
    const registered = await makeScratchTestCheckout('papercusp-testing-run-selector-registered-');
    let loadedWorkspace: string | undefined;
    const result = await resolveRegisteredTestFileRoot('subject-tree', 'workspace-17', async (workspaceId) => {
      loadedWorkspace = workspaceId;
      return { projects: [{ slug: 'subject-tree', path: registered }] } as never;
    });

    expect(loadedWorkspace).toBe('workspace-17');
    expect(result).toEqual({
      ok: true,
      selection: { root: registered, source: 'registered-harness' },
    });
  });

  it('refuses an unregistered rootHarnessSlug without considering discovered or canonical roots', async () => {
    const result = await resolveRegisteredTestFileRoot('missing-tree', 'workspace-17', async () => ({
      projects: [{ slug: 'other-tree', path: selectorRequested }],
    }) as never);

    expect(result).toMatchObject({ ok: false, error: 'root_harness_not_registered' });
  });

  it('requires a concrete caller workspace before resolving rootHarnessSlug', async () => {
    const loadRegistry = vi.fn(async () => ({ projects: [{ slug: 'subject-tree', path: selectorRequested }] }) as never);
    const result = await resolveRegisteredTestFileRoot('subject-tree', '*', loadRegistry);

    expect(result).toMatchObject({ ok: false, error: 'root_harness_requires_concrete_workspace' });
    expect(loadRegistry).not.toHaveBeenCalled();
  });

  it('keeps relative paths inside an explicit registered root instead of expanding a sibling checkout', async () => {
    const registered = await makeScratchTestCheckout('papercusp-testing-run-selector-explicit-root-');
    const sibling = await makeScratchTestCheckout('papercusp-testing-run-selector-explicit-sibling-');
    const siblingRelativePath = `${basename(sibling)}/packages/x/real.test.ts`;

    expect(normalizeTestFilePaths([siblingRelativePath], registered)).toEqual({
      ok: true,
      files: [join(sibling, 'packages/x/real.test.ts')],
    });
    expect(normalizeTestFilePaths([siblingRelativePath], registered, undefined, {
      allowSiblingCheckoutFallback: false,
    })).toEqual({ ok: true, files: [siblingRelativePath] });
  });

  it('rejects rootHarnessSlug when the request does not select exact files', async () => {
    const out = await body(call({ rootHarnessSlug: 'subject-tree', changedPaths: ['packages/x/source.ts'] }));

    expect(out).toMatchObject({ ok: false, error: 'root_harness_requires_files' });
  });
});

describe('owned private PG router supervision', () => {
  it.each([{ privatePg: true }, { allowDetachedRecovery: false }])(
    'keeps private-PG and no-replay guards explicit for mixed-checkout runs: %j', async (options) => {
      const roots = [
        await makeScratchTestCheckout('papercusp-testing-owned-pg-timeout-a-'),
        await makeScratchTestCheckout('papercusp-testing-owned-pg-timeout-b-'),
      ];
      for (const root of roots) {
        await mkdir(join(root, 'scripts'), { recursive: true });
        await writeFile(join(root, 'scripts', 'test-files.mjs'), 'process.exit(0);\n');
        await writeFile(join(root, 'scripts', 'with-test-pg.mjs'), 'process.exit(0);\n');
        await sealScratchTestCheckout(root);
      }
      const runRouterFn = vi.fn(async () => ({
        code: null, signal: null, timedOut: true, aborted: false, output: '',
      }));
      const out = await runTestFilesCore({
        root: roots[0]!,
        files: ['packages/x/real.test.ts', join(roots[1]!, 'packages/x/real.test.ts')],
        timeoutMs: 10_000, ...options,
      }, { runRouterFn });
      if (options.privatePg) {
        expect(out).toMatchObject({ ok: false, error: 'private_pg_requires_single_checkout', roots });
        expect(runRouterFn).not.toHaveBeenCalled();
      } else {
        expect(out, JSON.stringify(out)).toMatchObject({ ok: false, error: 'timeout', roots });
        expect(out).not.toHaveProperty('detachedRunId');
        expect(runRouterFn).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each([false, true])('selects the requested supervisor and preserves the ledger/scope: privatePg=%s', async (privatePg) => {
    const file = 'packages/x/real.integration.test.ts';
    const root = await makeScratchTestCheckout('papercusp-testing-owned-pg-', file);
    await mkdir(join(root, 'scripts'), { recursive: true });
    const capture = join(root, 'captured-environment.json');
    const report = {
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
      numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0,
      startTime: Date.now(), success: true,
      testResults: [{ name: join(root, file), status: 'passed',
        assertionResults: [{ fullName: 'owned private route control', status: 'passed' }] }],
    };
    await writeFile(join(root, 'scripts', 'with-test-pg.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "const command = process.argv.slice(process.argv.indexOf('--') + 1);",
      "const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, PAPERCUSP_TEST_PG_ADMIN_URL: 'postgresql://127.0.0.1/owned-route-fixture' } });",
      'process.exitCode = result.status ?? 1;',
    ].join('\n'));
    await writeFile(join(root, 'scripts', 'test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ privatePg: process.env.PAPERCUSP_TEST_PG_ADMIN_URL, sink: process.env.PAPERCUSP_TEST_RUNS_DB_URL, run: process.env.PAPERCUSP_TEST_RUN_GROUP, harness: process.env.PAPERCUSP_TEST_RUN_HARNESS, workspace: process.env.PAPERCUSP_WORKSPACE_ID }));`,
      `writeFileSync(process.argv.find(a => a.startsWith('--outputFile=')).slice('--outputFile='.length), ${JSON.stringify(JSON.stringify(report))});`,
      "console.log('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');",
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const previousSink = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
    const previousPrivate = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    try {
      process.env.PAPERCUSP_TEST_RUNS_DB_URL = 'postgresql://127.0.0.1/durable-ledger-fixture';
      delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      const result = await runTestFilesCore({
        root, files: [file], privatePg, runId: 'owned-private-pg-control',
        workspaceId: 'owned-private-pg-workspace', harnessSlug: 'owned-private-pg-harness',
        // The canned fixture owns no databases; reserve 1s for cleanup so the router gets 14s.
        timeoutMs: 15_000, cleanupReserveMs: 1_000,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, passed: 1, skipped: 0 });
      const observed = JSON.parse(await readFile(capture, 'utf8'));
      expect(observed).toMatchObject({
        sink: 'postgresql://127.0.0.1/durable-ledger-fixture', run: 'owned-private-pg-control',
        harness: 'owned-private-pg-harness', workspace: 'owned-private-pg-workspace',
      });
      if (privatePg) expect(observed.privatePg).toBe('postgresql://127.0.0.1/owned-route-fixture');
      else expect(observed.privatePg).toBeUndefined();
    } finally {
      if (previousSink === undefined) delete process.env.PAPERCUSP_TEST_RUNS_DB_URL;
      else process.env.PAPERCUSP_TEST_RUNS_DB_URL = previousSink;
      if (previousPrivate === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = previousPrivate;
    }
  });

  it('auto-selects owned private PG for isolated integration proof files', async () => {
    const file = 'packages/x/isolated-proof.integration.test.ts';
    const root = await makeScratchTestCheckout('papercusp-testing-auto-owned-pg-', file);
    await writeFile(join(root, file), [
      "import { recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';",
      'recordIsolatedIntegrationProof({});',
    ].join('\n'));
    await mkdir(join(root, 'scripts'), { recursive: true });
    const capture = join(root, 'captured-environment.json');
    const report = {
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
      numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0,
      startTime: Date.now(), success: true,
      testResults: [{ name: join(root, file), status: 'passed',
        assertionResults: [{ fullName: 'isolated proof parent observer', status: 'passed' }] }],
    };
    await writeFile(join(root, 'scripts', 'with-test-pg.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "const command = process.argv.slice(process.argv.indexOf('--') + 1);",
      "const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, PAPERCUSP_TEST_PG_ADMIN_URL: 'postgresql://127.0.0.1/owned-route-fixture' } });",
      'process.exitCode = result.status ?? 1;',
    ].join('\n'));
    await writeFile(join(root, 'scripts', 'test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(' + JSON.stringify(capture) + ', JSON.stringify({ privatePg: process.env.PAPERCUSP_TEST_PG_ADMIN_URL, sink: process.env.PAPERCUSP_TEST_RUNS_DB_URL, run: process.env.PAPERCUSP_TEST_RUN_GROUP, harness: process.env.PAPERCUSP_TEST_RUN_HARNESS, workspace: process.env.PAPERCUSP_WORKSPACE_ID }));',
      "writeFileSync(process.argv.find(a => a.startsWith('--outputFile=')).slice('--outputFile='.length), "
        + JSON.stringify(JSON.stringify(report)) + ");",
      "console.log('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');",
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const previousSink = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
    const previousPrivate = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    try {
      process.env.PAPERCUSP_TEST_RUNS_DB_URL = 'postgresql://127.0.0.1/durable-ledger-fixture';
      delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      const result = await runTestFilesCore({
        root, files: [file], runId: 'auto-isolated-proof-private-pg',
        workspaceId: 'auto-private-pg-workspace', harnessSlug: 'auto-private-pg-harness',
        timeoutMs: 15_000, cleanupReserveMs: 1_000,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, passed: 1, skipped: 0 });
      const observed = JSON.parse(await readFile(capture, 'utf8'));
      expect(observed).toMatchObject({
        privatePg: 'postgresql://127.0.0.1/owned-route-fixture',
        sink: 'postgresql://127.0.0.1/durable-ledger-fixture',
        run: 'auto-isolated-proof-private-pg',
        harness: 'auto-private-pg-harness',
        workspace: 'auto-private-pg-workspace',
      });
    } finally {
      if (previousSink === undefined) delete process.env.PAPERCUSP_TEST_RUNS_DB_URL;
      else process.env.PAPERCUSP_TEST_RUNS_DB_URL = previousSink;
      if (previousPrivate === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = previousPrivate;
    }
  });

  it('refuses private-PG routing when the checkout has no maintained wrapper', async () => {
    const file = 'packages/x/real.integration.test.ts';
    const root = await makeScratchTestCheckout('papercusp-testing-private-pg-route-unavailable-', file);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'test-files.mjs'), 'process.exit(0);\n');
    await sealScratchTestCheckout(root);
    const result = await runTestFilesCore({ root, files: [file], privatePg: true, timeoutMs: 10_000 });
    expect(result).toMatchObject({ ok: false, error: 'private_pg_route_unavailable', root });
    expect(result).not.toHaveProperty('detachedRunId');
  });

  it('refuses an unsuccessful private-PG preflight without starting the shared router', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-owned-pg-refusal-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const marker = join(root, 'shared-router-started');
    await writeFile(join(root, 'scripts', 'with-test-pg.mjs'),
      "console.error('private PG preflight refused'); process.exitCode = 42;\n");
    await writeFile(join(root, 'scripts', 'test-files.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe fallback');\n`);
    await sealScratchTestCheckout(root);
    const result = await runTestFilesCore({
      root, files: ['packages/x/real.test.ts'], privatePg: true, allowDetachedRecovery: false, timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ ok: false, error: 'no_report' });
    expect(result.routerOutput).toContain('private PG preflight refused');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('completed child with failed router finalization (WI-10004947)', () => {
  it.each(['vitest-json', 'node-summary'])('preserves measured counts and the cause without an overall green: %s', async (reportKind) => {
    const file = 'packages/x/completed.test.ts';
    const root = await makeScratchTestCheckout('papercusp-testing-finalization-', file);
    await mkdir(join(root, 'scripts'), { recursive: true });
    const report = {
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
      numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0,
      startTime: Date.now(), success: true,
      testResults: [{
        name: join(root, file), status: 'passed',
        assertionResults: [{ fullName: 'completed before finalization', status: 'passed' }],
      }],
    };
    await writeFile(join(root, 'scripts', 'test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      reportKind === 'vitest-json'
        ? `writeFileSync(process.argv.find(a => a.startsWith('--outputFile=')).slice('--outputFile='.length), ${JSON.stringify(JSON.stringify(report))});`
        : "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0');",
      "console.error('TEST_FILE_FINALIZATION_ERROR detail=receipt-finish-failed');",
      "console.log('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed finalizationError=true');",
      'process.exitCode = 3;',
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const out = await runTestFilesCore({ root, files: [file], timeoutMs: 10_000 });
    expect(out.error, JSON.stringify(out)).toBeUndefined();
    if (out.error !== undefined) return;
    expect(out).toMatchObject({ ok: false, passed: 1, failed: 0, skipped: 0, files: 1 });
    expect(out.routerOutput).toContain('TEST_FILE_FINALIZATION_ERROR detail=receipt-finish-failed');
    expect(out.routerOutput).not.toContain('no test file ran');
  });
});

describe('mixed-checkout test batches (EI-22733560502709681)', () => {
  it('skips a nested git workspace without a runner and coalesces its files at the runnable parent', async () => {
    const parent = await makeScratchTestCheckout('papercusp-testing-run-nested-unrunnable-');
    const nested = join(parent, 'libs', 'papercusp');
    const nestedFile = join(nested, 'packages', 'orchestrator', 'src', 'managed.test.ts');
    await mkdir(dirname(nestedFile), { recursive: true });
    await writeFile(join(nested, '.git'), 'gitdir: ../.git/modules/libs/papercusp\n');
    await writeFile(join(nested, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(nestedFile, 'export {};\n');

    const parentFile = join(parent, 'packages', 'x', 'real.test.ts');
    expect(checkoutRootForTestFiles([nestedFile], parent)).toBe(parent);
    expect(groupTestFilesByCheckout([nestedFile, parentFile], parent)).toEqual([
      { root: parent, files: [nestedFile, parentFile] },
    ]);
  });

  it('does not switch a mixed relative + absolute request wholesale to the absolute checkout', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-select-'));
    selectorRoots.push(parent);
    const ambient = join(parent, 'ambient');
    const sibling = join(parent, 'portal');
    for (const root of [ambient, sibling]) {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
      await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
    }
    const siblingFile = join(sibling, 'sibling.test.ts');
    await writeFile(siblingFile, 'export {};\n');

    expect(checkoutRootForTestFiles(['ambient.test.ts', siblingFile], ambient)).toBe(ambient);
  });

  it('runs and reports files from both checkouts instead of silently dropping the ambient file', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-core-'));
    selectorRoots.push(parent);
    const ambient = join(parent, 'ambient');
    const sibling = join(parent, 'portal');
    for (const [root, label] of [
      [ambient, 'ambient'],
      [sibling, 'sibling'],
    ] as const) {
      await mkdir(join(root, '.git'), { recursive: true });
      // `type: module` like every routed papercusp workspace. Without it vite loads
      // vitest.config.ts through CommonJS, and the committed-source loader refuses the bundled text
      // (EI filed from WI-6554700010018388). This case tests mixed-checkout batching, not config loading.
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', workspaces: [] }));
      await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
      await writeFile(
        join(root, `${label}.test.ts`),
        `import { expect, it } from 'vitest'; it('${label}', () => expect(1).toBe(1));\n`,
      );
      await sealScratchTestCheckout(root);
    }
    const siblingFile = join(sibling, 'sibling.test.ts');

    const phaseTimings: TestingRunPhaseTimings = {
      preflightMs: null,
      provenanceMs: null,
      preparationMs: null,
      admissionWaitMs: null,
      routerExecutionMs: null,
      ledgerIdReadbackMs: null,
      finalizationMs: null,
      totalHandlerMs: null,
    };
    const out = await runTestFilesCore({
      root: ambient,
      files: ['ambient.test.ts', siblingFile],
      timeoutMs: 60_000,
      phaseTimings,
    });

    try {
      expect(out.error, JSON.stringify({ out, phaseTimings })).toBeUndefined();
      if (out.error !== undefined) return;
      expect(out.ok, JSON.stringify({ out, phaseTimings })).toBe(true);
      expect(out.files).toBe(2);
      expect(out.roots).toEqual([ambient, sibling]);
      expect(out.byFile['ambient.test.ts']).toMatchObject({ passed: 1, failed: 0 });
      expect(out.byFile[siblingFile]).toMatchObject({ passed: 1, failed: 0 });
    } finally {
      // A failed success-path assertion can still have started timeout recovery.
      // Settle that owned process before the next fixture starts creating files.
      if ('detachedRunId' in out && out.detachedRunId) await cancelFixtureRecovery(out.detachedRunId);
    }
  }, 120_000);

  it('starts one detached recovery containing every checkout after a mixed-root timeout', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-timeout-'));
    selectorRoots.push(parent);
    const roots = [join(parent, 'ambient'), join(parent, 'portal')];
    const files = roots.map((root, index) => join(root, `${index === 0 ? 'ambient' : 'portal'}.test.ts`));
    const sleepingRouter = 'setTimeout(() => process.exit(0), 10_000);\n';
    for (const [root, file] of roots.map((root, index) => [root, files[index]!] as const)) {
      await mkdir(join(root, '.git'), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
      await writeFile(join(root, 'scripts', 'test-files.mjs'), sleepingRouter);
      await writeFile(file, 'export {};\n');
      await sealScratchTestCheckout(root);
    }

    const out = await runTestFilesCore({
      root: roots[0]!,
      files,
      timeoutMs: 1_000,
    });

    expect(out.error, JSON.stringify(out)).toBe('timeout');
    if (out.error !== 'timeout') return;
    expect(out.roots).toEqual(roots);
    const detachedRunId = out.detachedRunId;
    expect(typeof detachedRunId).toBe('string');
    expect(typeof out.originAliasDurable).toBe('boolean');
    if (typeof detachedRunId !== 'string') return;

    try {
      const detached = getRun(detachedRunId);
      expect(detached).not.toBeNull();
      expect(detached?.command.join(' ')).toContain(roots[0]!);
      expect(detached?.command.join(' ')).toContain(roots[1]!);
      expect(detached?.command.join(' ')).toContain(files[0]!);
      expect(detached?.command.join(' ')).toContain(files[1]!);
    } finally {
      // Assertion failures also have to settle the owned recovery.
      await cancelFixtureRecovery(detachedRunId);
    }
  }, 30_000);

  it('keeps a bounded, checkout-attributed result when a later mixed-root group times out', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const parent = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-mixed-partial-'));
    selectorRoots.push(parent);
    const roots = [join(parent, 'operator-core'), join(parent, 'db')];
    const files = roots.map((root, index) => join(root, `${index === 0 ? 'operator-core' : 'db'}.test.ts`));
    const redRouter = [
      "import { writeFileSync } from 'node:fs';",
      "const output = process.argv.find((arg) => arg.startsWith('--outputFile='));",
      "const file = process.argv.find((arg) => arg.endsWith('.test.ts')) ?? 'unknown.test.ts';",
      "if (!output) process.exit(2);",
      "writeFileSync(output.slice('--outputFile='.length), JSON.stringify({ testResults: [{ name: file, status: 'failed', startTime: 0, endTime: 7, assertionResults: [{ status: 'passed', fullName: 'setup' }, { status: 'failed', fullName: 'schema width', failureMessages: ['expected 1536, received 768'] }] }] }));",
      'process.exit(1);',
    ].join('\n');
    const sleepingRouter = 'setTimeout(() => process.exit(0), 10_000);\n';
    for (const [index, root] of roots.entries()) {
      await mkdir(join(root, '.git'), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
      await writeFile(join(root, 'scripts', 'test-files.mjs'), index === 0 ? redRouter : sleepingRouter);
      await writeFile(files[index]!, 'export {};\n');
      await sealScratchTestCheckout(root);
    }

    const out = await runTestFilesCore({ root: roots[0]!, files, timeoutMs: 5_000 });

    try {
      expect(out.error, JSON.stringify(out)).toBe('timeout');
      if (out.error !== 'timeout') return;
      expect(out.completedGroups, JSON.stringify(out)).toHaveLength(1);
      expect(out.completedGroups?.[0]).toMatchObject({
        root: roots[0],
        files: [files[0]],
        ok: false,
        result: {
          passed: 1,
          failed: 1,
          files: 1,
          failures: [expect.objectContaining({ test: 'schema width' })],
        },
      });
      expect(out.completedGroups?.[0]?.result.byFile).toMatchObject({
        'operator-core.test.ts': { passed: 1, failed: 1 },
      });
      expect(out.completedGroups?.[0]?.result.failures.length).toBeLessThanOrEqual(5);
      expect(out.completedGroups?.[0]?.result.failuresTruncated).toBe(false);
      expect(typeof out.detachedRunId).toBe('string');
    } finally {
      if ('detachedRunId' in out && out.detachedRunId) await cancelFixtureRecovery(out.detachedRunId);
    }
  }, 30_000);
});

describe('nested router deadline (WI-10003090)', () => {
  it('gives a five-file router the caller budget instead of its inherited 600s limit', async () => {
    await mkdir(join(REPO_ROOT, '.papercusp', 'tmp'), { recursive: true });
    const root = await mkdtemp(join(REPO_ROOT, '.papercusp', 'tmp', 'testing-run-router-budget-'));
    selectorRoots.push(root);
    const files = Array.from({ length: 5 }, (_, index) => `criterion-${index}.test.ts`);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
    for (const file of files) await writeFile(join(root, file), 'export {};\n');
    await writeFile(join(root, 'scripts', 'test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const budget = Number(process.env.PAPERCUSP_TEST_FILE_TIMEOUT_MS);",
      "if (!(budget > 600_000 && budget < 780_000)) {",
      "  console.error(`nested router budget ${budget} does not follow the 13m caller`);",
      "  process.exit(2);",
      "}",
      "const reportArg = process.argv.find((arg) => arg.startsWith('--outputFile='));",
      "if (!reportArg) process.exit(2);",
      `const files = ${JSON.stringify(files)};`,
      "writeFileSync(reportArg.slice('--outputFile='.length), JSON.stringify({ testResults: files.map((file) => ({",
      "  name: resolve(file), status: 'passed', startTime: 0, endTime: 1,",
      "  assertionResults: [{ status: 'passed', fullName: 'criterion ran' }],",
      "})) }));",
    ].join('\n'));
    await sealScratchTestCheckout(root);

    const previous = process.env.PAPERCUSP_TEST_FILE_TIMEOUT_MS;
    process.env.PAPERCUSP_TEST_FILE_TIMEOUT_MS = '600000';
    try {
      const out = await runTestFilesCore({ root, files, timeoutMs: 13 * 60_000 });
      expect(out.error, JSON.stringify(out)).toBeUndefined();
      if (out.error !== undefined) return;
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.files).toBe(5);
      expect(Object.keys(out.byFile)).toHaveLength(5);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_TEST_FILE_TIMEOUT_MS;
      else process.env.PAPERCUSP_TEST_FILE_TIMEOUT_MS = previous;
    }
  });
});

describe('governed test-process admission (P-003)', () => {
  it('returns a timed-out outcome and aborts a governed admission that never settles', async () => {
    let observedSignal: AbortSignal | undefined;
    const out = await runWithTestProcessDeadline({
      timeoutMs: 25,
      run: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<never>(() => {
          /* simulate a durable admission blocked behind the heavy-test gate */
        });
      },
      onAdmissionTimeout: (timeoutMs) => ({ kind: 'timeout', timeoutMs }),
      onAbort: () => ({ kind: 'aborted' }),
    });

    expect(out).toEqual({ kind: 'timeout', timeoutMs: 25 });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(Error);
    expect((observedSignal?.reason as Error).message).toContain('admission exceeded');
  });

  it('gives the child only the budget remaining after admission completes', async () => {
    const out = await runWithTestProcessDeadline<
      { remaining: number; readBack: number } | { kind: 'timeout'; timeoutMs: number } | { kind: 'aborted' }
    >({
      timeoutMs: 100,
      run: async ({ markAdmissionComplete, remainingTimeoutMs }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const remaining = markAdmissionComplete();
        return { remaining, readBack: remainingTimeoutMs() };
      },
      onAdmissionTimeout: (timeoutMs) => ({ kind: 'timeout', timeoutMs }),
      onAbort: () => ({ kind: 'aborted' }),
    });

    expect(out).toMatchObject({ remaining: expect.any(Number), readBack: expect.any(Number) });
    if (!('remaining' in out) || !('readBack' in out)) return;
    expect(out.remaining).toBeGreaterThan(0);
    expect(out.remaining).toBeLessThan(100);
    expect(out.readBack).toBeLessThanOrEqual(out.remaining);
  });

  it('constructs an explicit CPU/memory/disk/fd reservation', () => {
    expect(buildTestProcessDemand({ fileCount: 3 })).toEqual({
      cpuWeight: 1,
      memoryBytes: 1024 * 1024 * 1024,
      diskBytes: 256 * 1024 * 1024,
      fileDescriptors: 19,
    });
  });

  it('records peak child observations as measured actual demand without blocking on async reads', async () => {
    let now = 1_000;
    let sample = { cpuMicros: 100, rssBytes: 10, fileDescriptors: 4 };
    const sampler = createTestProcessDemandSampler(
      buildTestProcessDemand({ fileCount: 1 }),
      async () => sample,
      () => now,
    );
    sampler.attach(42);
    await sampler.sample();
    now = 2_000;
    sample = { cpuMicros: 1_500_100, rssBytes: 30, fileDescriptors: 8 };
    await sampler.sample();
    now = 3_000;
    sample = { cpuMicros: 3_000_100, rssBytes: 20, fileDescriptors: 6 };
    await expect(sampler.stop({ diskBytes: 123 })).resolves.toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
    // A stopped sampler is idempotent and cannot restart a timer or overwrite
    // the close-time measurement.
    await expect(sampler.stop({ diskBytes: 999 })).resolves.toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
  });

  it('reads the process resource snapshot asynchronously from the live process tree', async () => {
    const pending = readTestProcessResourceSnapshot(process.pid);
    expect(pending).toBeInstanceOf(Promise);

    const snapshot = await pending;
    expect(Object.values(snapshot).every((metric) => metric === null || typeof metric === 'number')).toBe(true);
  });

  it('cancels timeout/abort/signal-only exits but releases real red exits', () => {
    const base = { code: 0, signal: null, timedOut: false, aborted: false, output: '' };
    expect(classifyTestProcessOutcome({ ...base, timedOut: true })).toMatchObject({ kind: 'cancel' });
    expect(classifyTestProcessOutcome({ ...base, aborted: true })).toMatchObject({ kind: 'cancel' });
    expect(classifyTestProcessOutcome({ ...base, code: null, signal: 'SIGTERM' })).toMatchObject({ kind: 'cancel' });
    expect(classifyTestProcessOutcome({ ...base, code: 1, output: 'worker exited before dispatch' })).toMatchObject({
      kind: 'cancel',
    });
    expect(classifyTestProcessOutcome({ ...base, code: 1, actualDemand: { memoryBytes: 7 } })).toEqual({
      kind: 'release',
      actualDemand: { memoryBytes: 7 },
    });
  });
});

describe('bounded foreground process termination', () => {
  it('waits no longer than the foreground termination grace and accepts a late close', async () => {
    let close!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      close = resolve;
    });
    // Exercise the real scheduler with the existing bounded deadline seam.
    // Freezing timers here also freezes this integration suite's real drivers.
    await expect(waitForTestProcessClose(childClosed, 10)).resolves.toBe(false);
    close();
    await expect(childClosed).resolves.toBeUndefined();
  });

  it('confirms a child that closes before its termination deadline', async () => {
    await expect(waitForTestProcessClose(Promise.resolve(), 1_000)).resolves.toBe(true);
  });

  it('does not start a mixed-root recovery while a timed-out foreground process may still be writing', async () => {
    const roots = [
      await makeScratchTestCheckout('papercusp-testing-run-unconfirmed-a-'),
      await makeScratchTestCheckout('papercusp-testing-run-unconfirmed-b-'),
    ];
    for (const root of roots) {
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'scripts', 'test-files.mjs'), 'process.exit(0);\n');
      await sealScratchTestCheckout(root);
    }
    let close!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      close = resolve;
    });
    let reportDir = '';
    const runRouterFn = vi.fn(async (args: string[]) => {
      const report = args.find((arg) => arg.startsWith('--outputFile='));
      expect(report).toBeDefined();
      reportDir = dirname(report!.slice('--outputFile='.length));
      return {
        code: null,
        signal: null,
        timedOut: true,
        aborted: false,
        output: '',
        taskId: 'test-task-late-close',
        terminationUnconfirmed: true,
        childClosed,
      };
    });

    try {
      const out = await runTestFilesCore(
        {
          root: roots[0]!,
          files: ['packages/x/real.test.ts', join(roots[1]!, 'packages/x/real.test.ts')],
          // The injected child already supplies the timeout. This case tests
          // pending-writer recovery, so preparation gets the classification
          // budget rather than racing an unrelated ten-second deadline.
          timeoutMs: IN_PROCESS_CLASSIFICATION_CEILING_MS,
        },
        { runRouterFn },
      );

      expect(out, JSON.stringify(out)).toMatchObject({
        ok: false,
        error: 'timeout',
        roots,
        taskId: 'test-task-late-close',
        terminationUnconfirmed: true,
      });
      expect(out).not.toHaveProperty('detachedRunId');
      expect(runRouterFn).toHaveBeenCalledTimes(1);
      expect(existsSync(reportDir)).toBe(true);

      const pendingManifest = JSON.parse(await readFile(join(dirname(reportDir), 'manifest.json'), 'utf8'));
      expect(pendingManifest.nativeCustody).toMatchObject({ writerState: 'pending', nativeProof: 'unqualified', acceptance: 'unmeasured' });
      const pendingLocator = pendingManifest.nativeCustody.locator;
      const pendingObject = join(dirname(reportDir), 'native-proof/objects', pendingLocator.manifest.ref);
      const pendingBytes = await readFile(pendingObject);
      close();
      // The run's artifact packet is RETAINED by design (TestRunArtifactPacket.finish stages
      // 'retained'). A late close records its cleanup receipt in the packet. It does not delete
      // the evidence (WI-6554700010018388).
      const packetDir = dirname(reportDir);
      await vi.waitFor(() => expect(existsSync(join(packetDir, 'late-cleanup.json'))).toBe(true), { timeout: 10_000 });
      const settled = JSON.parse(await readFile(join(packetDir, 'manifest.json'), 'utf8'));
      expect(settled.nativeCustody).toMatchObject({ writerState: 'settled', nativeProof: 'unqualified', acceptance: 'unmeasured' });
      expect(settled.nativeCustody.locator.manifest.sha256).not.toBe(pendingLocator.manifest.sha256);
      const successor = JSON.parse(await readFile(join(packetDir, 'native-proof/objects', settled.nativeCustody.locator.manifest.ref), 'utf8'));
      expect(successor.predecessor).toEqual(pendingLocator);
      expect(await readFile(pendingObject)).toEqual(pendingBytes);
      expect(existsSync(reportDir)).toBe(true);
    } finally {
      close();
      if (reportDir) await rm(basename(reportDir) === 'reports' ? dirname(reportDir) : reportDir, { recursive: true, force: true });
    }
  });
});

describe('groupDirectVitestRoutes (EI-21414388102126733)', () => {
  it('runs an external-Hive file from its owning workspace instead of the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-workspace-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'apps/web/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    await writeFile(join(root, 'apps/web/package.json'), JSON.stringify({ name: '@example/web' }));
    await writeFile(join(root, 'apps/web/vite.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'apps/web/src/widget.integration.test.tsx'), 'export {};\n');

    expect(groupDirectVitestRoutes(['apps/web/src/widget.integration.test.tsx'], root)).toEqual([
      { cwd: join(root, 'apps/web'), files: ['src/widget.integration.test.tsx'] },
    ]);
  });

  it('selects an owning workspace integration config when one exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-layer-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'packages/db/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(join(root, 'packages/db/package.json'), JSON.stringify({ name: '@example/db' }));
    await writeFile(join(root, 'packages/db/vitest.integration.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'packages/db/src/db.integration.test.ts'), 'export {};\n');

    expect(groupDirectVitestRoutes(['packages/db/src/db.integration.test.ts'], root)).toEqual([
      {
        cwd: join(root, 'packages/db'),
        config: 'vitest.integration.config.ts',
        files: ['src/db.integration.test.ts'],
      },
    ]);
  });

  it('finds the owning workspace for a real path reached through a symlinked checkout root', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-symlink-real-'));
    const aliasParent = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-symlink-alias-'));
    selectorRoots.push(realRoot, aliasParent);
    const aliasRoot = join(aliasParent, 'checkout');
    await symlink(realRoot, aliasRoot, 'dir');
    await mkdir(join(realRoot, '.git'));
    await mkdir(join(realRoot, 'apps/sidecar/src'), { recursive: true });
    await writeFile(join(realRoot, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    await writeFile(join(realRoot, 'apps/sidecar/package.json'), JSON.stringify({ name: '@example/sidecar' }));
    await writeFile(join(realRoot, 'apps/sidecar/vitest.config.ts'), 'export default {};\n');
    await writeFile(join(realRoot, 'apps/sidecar/src/durable-call.integration.test.ts'), 'export {};\n');

    expect(groupDirectVitestRoutes(
      [join(realRoot, 'apps/sidecar/src/durable-call.integration.test.ts')],
      aliasRoot,
    )).toEqual([
      {
        cwd: join(realRoot, 'apps/sidecar'),
        files: ['src/durable-call.integration.test.ts'],
      },
    ]);
  });
});

describe('shouldIngestVitestLedgerInProcess', () => {
  it('resolves the reporter through the selected checkout package export', async () => {
    const externalRoot = await makeScratchTestCheckout('papercusp-testing-run-package-reporter-');
    const packageRoot = join(externalRoot, 'node_modules/@papercusp/test-config');
    const reporterPath = join(packageRoot, 'src/admin-test-runs-reporter.ts');
    await mkdir(dirname(reporterPath), { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@papercusp/test-config',
        exports: { './admin-test-runs-reporter': './src/admin-test-runs-reporter.ts' },
      }),
    );
    await writeFile(reporterPath, 'export default class Reporter {}\n');

    expect(resolveAdminTestRunsReporterPath(externalRoot)).toBe(reporterPath);
    expect(shouldIngestVitestLedgerInProcess(externalRoot)).toBe(false);
    expect(buildDetachedTestRunRequest({ root: externalRoot, files: ['packages/x/real.test.ts'] }).args).toContain(
      `--reporter=${reporterPath}`,
    );
  });

  it('selects operator-side ingestion for an external checkout', async () => {
    const externalRoot = await makeScratchTestCheckout('papercusp-testing-run-external-reporter-');

    expect(shouldIngestVitestLedgerInProcess(externalRoot)).toBe(true);
  });

  it('leaves a managed checkout own reporter as the single writer', async () => {
    const managedRoot = await makeScratchTestCheckout('papercusp-testing-run-local-reporter-');
    const localReporter = join(managedRoot, 'libs/test-config/src/admin-test-runs-reporter.ts');
    await mkdir(dirname(localReporter), { recursive: true });
    await writeFile(localReporter, 'export default class Reporter {}\n');

    expect(shouldIngestVitestLedgerInProcess(managedRoot)).toBe(false);
  });
});

/**
 * Every process in a `testing:run` invocation's tree (the router + the vitest
 * it spawns via `spawnSync`) inherits `PAPERCUSP_TEST_RUN_GROUP=<runId>` in its
 * environment (run.ts stamps it explicitly for the admin-test-runs-reporter).
 * That makes it a reliable, collision-free marker for "is anything from THIS
 * specific run still alive" on a box where many other agents' unrelated vitest
 * processes are routinely running concurrently — scanning by test-file name or
 * `vitest` alone would false-positive on their traffic.
 */
async function pidsTaggedWithRun(runId: string): Promise<number[]> {
  const marker = `PAPERCUSP_TEST_RUN_GROUP=${runId}`;
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => null);
    // /proc/<pid>/environ is NUL-separated, not newline-separated — a plain
    // .includes() still finds the marker fine since we only need substring presence.
    if (environ && environ.includes(marker)) pids.push(Number(entry));
  }
  return pids;
}

describe('testing:run (integration)', () => {
  it('launches the foreground router in a managed sibling scope and terminates that exact scope', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const managedSpawnFn = vi.fn(async () => ({
      child,
      taskId: 'testtask1234',
      scopeUnit: 'pc-testtask1234.scope',
      confined: true,
    }));
    const teardownSteps: string[] = [];
    const undoTeardown = vi.fn();
    const markManagedTeardownFn = vi.fn((marked: Pick<ChildProcess, 'kill'>) => {
      expect(marked).toBe(child);
      teardownSteps.push('mark');
      return undoTeardown;
    });
    const killScopeUnitFn = vi.fn(async (scopeUnit: string) => {
      teardownSteps.push('kill');
      return { ok: true as const, scopeUnit, action: 'kill' };
    });
    const killProcessGroupFn = vi.fn();
    const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-managed-output-'));
    selectorRoots.push(outputDir);
    const outputPath = join(outputDir, 'router.log');

    const running = await launchManagedTestProcess(
      {
        command: process.execPath,
        args: ['scripts/test-files.mjs', GREEN_TARGET],
        cwd: REPO_ROOT,
        env: { PAPERCUSP_TEST_RUN_GROUP: 'restart-survival-run' },
        timeoutMs: 60_000,
        runGroup: 'restart-survival-run',
        workspaceId: 'papercusp-workspace',
        outputPath,
      },
      { managedSpawnFn, killScopeUnitFn, killProcessGroupFn, markManagedTeardownFn },
    );

    expect(managedSpawnFn).toHaveBeenCalledWith(
      process.execPath,
      ['scripts/test-files.mjs', GREEN_TARGET],
      expect.objectContaining({
        class: 'test-run',
        harnessSlug: null,
        launchedBy: 'testing:run:restart-survival-run',
        runtimeMaxSec: 65,
        detail: { runGroup: 'restart-survival-run', foreground: true },
      }),
      expect.objectContaining({
        workspaceId: 'papercusp-workspace',
        spawnOptions: expect.objectContaining({
          cwd: REPO_ROOT,
          detached: true,
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
        }),
      }),
    );

    running.terminate();
    running.terminate();
    await vi.waitFor(() => expect(killScopeUnitFn).toHaveBeenCalledTimes(1));
    expect(markManagedTeardownFn).toHaveBeenCalledTimes(1);
    expect(teardownSteps).toEqual(['mark', 'kill']);
    expect(undoTeardown).not.toHaveBeenCalled();
    expect(killScopeUnitFn).toHaveBeenCalledWith('pc-testtask1234.scope', {
      signal: 'SIGTERM',
      escalateAfterMs: 5_000,
    });
    // The launcher pid is the systemd-run client, not the payload. A confined
    // termination must never mistake that client process group for the tree.
    expect(killProcessGroupFn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['refused', 'thrown', 'already-gone'] as const)(
    'handles %s final scope control without hiding a refused teardown', async outcome => {
      const child = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn(() => true) }) as unknown as ChildProcess;
      const managedSpawnFn = vi.fn(async () => ({
        child, taskId: 'teardown-refusal', scopeUnit: 'pc-teardown-refusal.scope', confined: true,
      }));
      const undoTeardown = vi.fn();
      const markManagedTeardownFn = vi.fn(() => undoTeardown);
      const killScopeUnitFn = vi.fn(async (scopeUnit: string, options?: { signal?: NodeJS.Signals }) => {
        if (options?.signal === 'SIGKILL' && outcome === 'thrown') throw new Error('scope control unavailable');
        return { ok: false as const, scopeUnit, action: 'kill',
          error: options?.signal === 'SIGKILL' && outcome === 'already-gone'
            ? 'already_gone' as const : 'command_failed' as const };
      });
      const outputDir = await mkdtemp(join(tmpdir(), 'papercusp-testing-teardown-refusal-'));
      selectorRoots.push(outputDir);
      const running = await launchManagedTestProcess({
        command: process.execPath, args: [], cwd: REPO_ROOT, env: {}, timeoutMs: 60_000,
        runGroup: 'teardown-refusal', workspaceId: 'papercusp-workspace',
        outputPath: join(outputDir, 'router.log'),
      }, { managedSpawnFn, killScopeUnitFn, markManagedTeardownFn });
      running.terminate();
      running.terminate();
      await vi.waitFor(() => expect(killScopeUnitFn).toHaveBeenCalledTimes(2));
      expect(markManagedTeardownFn).toHaveBeenCalledTimes(1);
      if (outcome === 'already-gone') expect(undoTeardown).not.toHaveBeenCalled();
      else await vi.waitFor(() => expect(undoTeardown).toHaveBeenCalledTimes(1));
    },
  );

  it('releases the host request while preserving only a confined runner during shutdown', () => {
    expect(preserveConfinedTestOnHostShutdown(true, { confined: true })).toBe(true);
    expect(preserveConfinedTestOnHostShutdown(false, { confined: true })).toBe(false);
    expect(preserveConfinedTestOnHostShutdown(true, { confined: false })).toBe(false);
    expect(preserveConfinedTestOnHostShutdown(true, null)).toBe(false);

    const settle = vi.fn();
    expect(settleConfinedTestOnHostShutdown(true, { confined: true }, settle)).toBe(true);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      code: null,
      signal: null,
      timedOut: false,
      aborted: true,
      hostShutdownDetached: true,
      output: expect.stringContaining('continues in its sibling scope'),
    });

    settle.mockClear();
    expect(settleConfinedTestOnHostShutdown(false, { confined: true }, settle)).toBe(false);
    expect(settleConfinedTestOnHostShutdown(true, { confined: false }, settle)).toBe(false);
    expect(settle).not.toHaveBeenCalled();
  });

  it('accounts confined foreground demand from the whole task cgroup rather than the launcher pid', async () => {
    const scopeCgroupPath =
      '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-testtask1234.scope';
    const root = `/sys/fs/cgroup${scopeCgroupPath}`;
    const files = new Map<string, string>([
      [`${root}/cpu.stat`, 'usage_usec 123456\n'],
      [`${root}/memory.current`, '2048\n'],
      [`${root}/memory.peak`, '4096\n'],
      [`${root}/pids.current`, '2\n'],
      [`${root}/pids.events`, 'max 0\n'],
      [`${root}/cgroup.procs`, '111\n222\n'],
    ]);
    const snapshot = await readManagedTestProcessResourceSnapshot(
      {
        child: { pid: 4242 } as ChildProcess,
        scopeCgroupPath,
      },
      {
        fs: {
          readFile: (path) => files.get(path) ?? null,
          readDir: () => [],
          isDir: (path) => path === root,
        },
        readFileDescriptors: async (pid) => (pid === 111 ? 5 : 7),
      },
    );

    expect(snapshot).toEqual({ cpuMicros: 123456, rssBytes: 4096, fileDescriptors: 12 });
  });

  it('carries the absolute child cutoff and cleanup reserve into the router', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-deadline-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const taskDeadlineAtMs = Date.now() + 45_000;
    const runRouterFn = vi.fn(async (_args: string[], _cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => {
      expect(Number(env.PAPERCUSP_TEST_TASK_DEADLINE_AT_MS)).toBe(taskDeadlineAtMs);
      expect(Number(env.PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS)).toBe(taskDeadlineAtMs - 10_000);
      expect(Number(env.PAPERCUSP_TEST_CLEANUP_RESERVE_MS)).toBe(10_000);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(taskDeadlineAtMs - 10_000 - Date.now() + 50);
      return { code: 0, signal: null, timedOut: false, aborted: false,
        output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed' };
    });
    const result = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], timeoutMs: 45_000,
      taskDeadlineAtMs, cleanupReserveMs: 10_000 }, { runRouterFn });
    expect(result.ok).toBe(true);
    expect(result.cleanup?.complete).toBe(true);
    expect(runRouterFn).toHaveBeenCalledTimes(1);
  });

  it('starts a real test router in test mode when the operator host is in production', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-production-env-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const capture = join(root, 'observed-test-environment.json');
    await writeFile(join(root, 'scripts/test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ nodeEnv: process.env.NODE_ENV }));`,
      "if (process.env.NODE_ENV !== 'test') throw new Error('Production host mode reached the test worker');",
      "console.log('ROUTE cwd=packages/x runner=node:test\\n  requested real.test.ts\\n# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');",
    ].join('\n'));
    await sealScratchTestCheckout(root);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const result = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], timeoutMs: 30_000 });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, passed: 1, failed: 0 });
      expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({ nodeEnv: 'test' });
      expect(process.env.NODE_ENV).toBe('production');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('binds parked scorecard live setup to its authenticated caller before the router starts', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-scorecard-profile-');
    const suite = 'packages/operator-core/lib/agent-tools/coordination/parked-agent-audit.e2e.test.ts';
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await mkdir(dirname(join(root, suite)), { recursive: true });
    await writeFile(join(root, suite), 'export {};\n');
    await sealScratchTestCheckout(root);
    const runRouterFn = vi.fn(async (_args: string[], _cwd: string, env: NodeJS.ProcessEnv) => {
      expect(env).toMatchObject({ PAPERCUSP_SID: 'authenticated-grader', PAPERCUSP_WORKSPACE: 'grading-workspace',
        PAPERCUSP_APP_OPERATION_LIVE_PROFILE: 'packages/operator-core/test/parked-agent-audit.live-profile.json',
        PAPERCUSP_PARKED_SEARCH_LIVE: '1', PAPERCUSP_PARKED_AUDIT_LIVE: '0', PAPERCUSP_PARKED_CURRENT_LIVE: '0' });
      return { code: 0, signal: null, timedOut: false, aborted: false,
        output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed' };
    });
    const result = await runTestFilesCore({ root, files: [suite],
      runId: 'scorecard-check-' + 'c'.repeat(40) + '-0', actorId: 'authenticated-grader', workspaceId: 'grading-workspace' },
    { runRouterFn });
    expect(result.ok).toBe(true);
    expect(runRouterFn).toHaveBeenCalledOnce();
  });

  it('forwards public caller bounds through the real handler and router environment', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-public-deadline-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const capture = join(root, 'captured-deadline.json');
    await writeFile(join(root, 'scripts/test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ taskDeadlineAtMs: Number(process.env.PAPERCUSP_TEST_TASK_DEADLINE_AT_MS), childCutoffAtMs: Number(process.env.PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS), cleanupReserveMs: Number(process.env.PAPERCUSP_TEST_CLEANUP_RESERVE_MS) }));`,
      "console.log('ROUTE cwd=packages/x runner=node:test\\n  requested real.test.ts\\n# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');",
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const taskDeadlineAtMs = Date.now() + 20_000;
    const args = runTool.args.parse({ files: ['packages/x/real.test.ts'], timeoutMs: 25_000,
      taskDeadlineAtMs, cleanupReserveMs: 5_000 });
    const out = await body(call(args, { projectDir: root }));
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, passed: 1,
      deadline: { taskDeadlineAtMs, childCutoffAtMs: taskDeadlineAtMs - 5_000, cleanupReserveMs: 5_000 } });
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({
      taskDeadlineAtMs, childCutoffAtMs: taskDeadlineAtMs - 5_000, cleanupReserveMs: 5_000,
    });
    const manifest = JSON.parse(await readFile(out.artifacts!.manifest, 'utf8'));
    expect(manifest.deadline).toEqual(out.deadline);
    expect(manifest.childState).toBe('closed');
  });

  it('never grants fresh detached recovery after a caller-bound foreground timeout', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-bound-recovery-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const runRouterFn = vi.fn(async () => ({ code: null, signal: 'SIGTERM' as const,
      timedOut: true, aborted: false, output: 'controlled timeout without a completed report' }));
    const result = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], timeoutMs: 45_000,
      taskDeadlineAtMs: Date.now() + 45_000, cleanupReserveMs: 10_000 }, { runRouterFn });
    expect(result).toMatchObject({ ok: false, error: 'timeout' });
    expect(result).not.toHaveProperty('detachedRunId');
    expect(result.cleanup?.complete).toBe(true);
    expect(runRouterFn).toHaveBeenCalledOnce();
  });

  it.skipIf(!SIDESTAGE_HIVE_ROOT)(
    'routes an absolute test path through its external Hive Vitest checkout',
    async () => {
      const out = await body(call({ files: [join(SIDESTAGE_HIVE_ROOT as string, 'apps/web/src/auction.test.tsx')] }));

      expect(out.ok).toBe(true);
      expect(out.failed).toBe(0);
      expect(out.files).toBe(1);
      expect(out.passed).toBeGreaterThan(0);
      expect(out.root).toBe(SIDESTAGE_HIVE_ROOT);
    },
    180_000,
  );

  it.skipIf(!SIDESTAGE_LAYERED_TARGET || !existsSync(SIDESTAGE_LAYERED_TARGET))(
    'routes a layered external-Hive file through its owning workspace config',
    async () => {
      const out = await body(call({ files: [SIDESTAGE_LAYERED_TARGET as string] }));

      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.failed).toBe(0);
      expect(out.files).toBe(1);
      expect(out.passed).toBeGreaterThan(0);
      expect(out.root).toBe(SIDESTAGE_HIVE_ROOT);
    },
    180_000,
  );

  it('runs a real file through the router and returns a distilled green result', async () => {
    const out = await body(call({ files: [GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    // Not pinned to an exact count — that would make this test a tripwire for
    // unrelated edits to the target suite. The contract is "tests ran and the
    // counts came back", not a specific number.
    expect(out.passed).toBeGreaterThan(0);
    expect(out.files).toBe(1);
    expect(out.failures).toEqual([]);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof out.runId).toBe('string');
    // WI-7189: `root` must be echoed so a wrong-tree run is VISIBLE, not silent —
    // and it must be the real repo root (has the router script the run just used),
    // never some other resolved tree such as a stale harness clone.
    expect(typeof out.root).toBe('string');
    const routerScript = await readFile(join(out.root as string, 'scripts', 'test-files.mjs'), 'utf8').catch(
      () => null,
    );
    expect(routerScript).not.toBeNull();
  }, 180_000);

  it('distills a passing node:test router result when no Vitest JSON report exists', async () => {
    const out = await body(call({ files: [NODE_TEST_TARGET] }));

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.files).toBe(1);
    expect(out.passed).toBeGreaterThan(0);
    expect(out.failed).toBe(0);
    expect(out.failures).toEqual([]);
  }, 180_000);

  // WI-10004243: a mixed Vitest + node:test batch used to drop the node:test file from
  // byFile, so scorecards:emit refused its criterion as "never reported on".
  it('keeps a node:test file in byFile when the batch also runs Vitest files', async () => {
    const out = await body(call({ files: [GREEN_TARGET, NODE_TEST_TARGET] }));

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.files).toBe(2);
    const byFile = (out.byFile ?? {}) as Record<string, { passed: number; failed: number }>;
    expect(Object.keys(byFile).sort()).toEqual([GREEN_TARGET, NODE_TEST_TARGET].sort());
    expect(byFile[NODE_TEST_TARGET]!.passed).toBeGreaterThan(0);
    expect(byFile[NODE_TEST_TARGET]!.failed).toBe(0);
  }, 240_000);

  it('attributes node:test summaries per router group and never across groups', () => {
    const output = [
      'ROUTE cwd=papercusp-desktop runner=node:test',
      '  requested test/a.test.js',
      'ℹ tests 3',
      'ℹ pass 2',
      'ℹ fail 1',
      'not ok 2 - breaks',
      'TEST_FILE_GROUP_RESULT cwd=papercusp-desktop runner=node:test executed=1 status=failed',
      'ROUTE cwd=packages/operator-core runner=vitest',
      '  requested lib/x.test.ts',
      'ROUTE cwd=other runner=node:test',
      '  requested test/b.test.js',
      '  requested test/c.test.js',
      'ℹ tests 4',
      'ℹ pass 4',
      'ℹ fail 0',
      'TEST_FILE_RESULT requested=4 executed=4 matched=4 status=failed',
    ].join('\n');
    const files = ['papercusp-desktop/test/a.test.js', 'packages/operator-core/lib/x.test.ts', 'other/test/b.test.js', 'other/test/c.test.js'];

    const runs = parseNodeTestGroupRuns(output, files);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.byFile).toEqual({
      'papercusp-desktop/test/a.test.js': { passed: 2, failed: 1, skipped: 0, collectionFailed: false },
    });
    expect(runs[0]!.failures[0]).toMatchObject({ file: 'papercusp-desktop/test/a.test.js', test: 'breaks' });
    // A multi-file group is counted but never attributed to one file.
    expect(runs[1]).toMatchObject({ passed: 4, failed: 0, files: 2, byFile: {} });
    // A group with no numeric summary is not evidence.
    expect(parseNodeTestGroupRuns('ROUTE cwd=x runner=node:test\n  requested t.test.js\n', ['x/t.test.js'])).toEqual([]);
  });

  it('requires the router marker and a non-zero numeric test summary for the node:test fallback', () => {
    const output = [
      '\u2139 tests 2',
      '\u2139 pass 2',
      '\u2139 fail 0',
      '\u2139 skipped 0',
      'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=abc provenance=stamped',
    ].join('\n');

    expect(parseRouterTestResult(output, [NODE_TEST_TARGET])).toMatchObject({
      passed: 2,
      failed: 0,
      skipped: 0,
      files: 1,
      failures: [],
      byFile: { [NODE_TEST_TARGET]: { passed: 2, failed: 0, skipped: 0, collectionFailed: false } },
    });
    expect(
      parseRouterTestResult('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed', [NODE_TEST_TARGET]),
    ).toBeNull();
  });

  // EI-24734340317452188: a Vitest file whose JSON report went missing answered
  // no_report even though the router said status=passed, because the fallback
  // could read only Node's summary.
  it('reads Vitest\'s own summary when its JSON report is missing, as strictly as the node:test one', () => {
    const target = 'packages/operator-core/lib/pui-e2e/release-acceptance.test.ts';
    const marker = (status: string, files = 1) =>
      `TEST_FILE_RESULT requested=${files} executed=${files} matched=${files} status=${status} head=abc`;
    const passed = [
      ' ✓ lib/pui-e2e/release-acceptance.test.ts (25 tests) 2210ms',
      '',
      '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m',
      '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m24 passed\u001b[39m\u001b[22m | \u001b[33m1 skipped\u001b[39m\u001b[90m (25)\u001b[39m',
      '   Start at  02:48:01',
      '   Duration  3.21s (transform 1.10s, setup 0ms, import 2.00s, tests 2.21s)',
      marker('passed'),
    ].join('\n');
    expect(parseRouterTestResult(passed, [target])).toEqual({
      passed: 24,
      failed: 0,
      skipped: 1,
      files: 1,
      failures: [],
      failuresTruncated: false,
      durationMs: 3210,
      byFile: { [target]: { passed: 24, failed: 0, skipped: 1, collectionFailed: false } },
    });

    const failed = [
      ' FAIL  lib/pui-e2e/release-acceptance.test.ts > release acceptance runner checkout > refuses an edit',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed | 24 passed (25)',
      marker('failed'),
    ].join('\n');
    expect(parseRouterTestResult(failed, [target])).toMatchObject({
      passed: 24,
      failed: 1,
      failures: [
        { file: target, test: 'lib/pui-e2e/release-acceptance.test.ts > release acceptance runner checkout > refuses an edit' },
      ],
    });

    // Every count has to add up; otherwise the caller keeps its no_report refusal.
    const vitestOnly = (files: string, tests: string, status = 'passed', executed = 1) =>
      parseRouterTestResult([` Test Files  ${files}`, `      Tests  ${tests}`, marker(status, executed)].join('\n'), [target]);
    expect(vitestOnly('1 passed (1)', '0 passed (0)')).toBeNull();
    expect(vitestOnly('1 passed (1)', '24 passed (25)')).toBeNull();
    expect(vitestOnly('1 passed (2)', '25 passed (25)')).toBeNull();
    expect(vitestOnly('1 passed (1)', '25 passed (25)', 'passed', 2)).toBeNull();
    expect(vitestOnly('1 passed (1)', '25 flaked (25)')).toBeNull();
    expect(parseRouterTestResult(['      Tests  25 passed (25)', marker('passed')].join('\n'), [target])).toBeNull();
    // A router failure with an all-green summary still counts as a failure.
    expect(vitestOnly('1 passed (1)', '25 passed (25)', 'failed')).toMatchObject({ failed: 1 });
  });

  it('says what a no_report refusal had to go on', () => {
    expect(noReportDiagnostics('router bailed\n', 1, [])).toEqual({
      routerExit: 1, reportDirEntries: [], markerSeen: false, summarySeen: 'none',
    });
    expect(noReportDiagnostics(['      Tests  2 passed (2)', 'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed'].join('\n'), 0, ['x.log']))
      .toEqual({ routerExit: 0, reportDirEntries: ['x.log'], markerSeen: true, summarySeen: 'vitest' });
    expect(noReportDiagnostics('ℹ tests 2\n', 0, []).summarySeen).toBe('node');
  });

  it('requires a finished zero-exit progress line before treating a terminal marker as complete', () => {
    const output = [
      'TEST_FILE_PROGRESS state=finished elapsedMs=14825 capturedBytes=42 completedFiles=["target"] pendingFiles=[] timeoutMs=50000 exitStatus=0 signal=none',
      'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=84e1f9b504',
    ].join('\n');

    expect(parseRouterTerminalCompletion(output)).toEqual({
      requested: 1,
      executed: 1,
      matched: 1,
      status: 'passed',
      runElapsedMs: 14825,
    });
    expect(parseRouterTerminalCompletion(output.replace('exitStatus=0', 'exitStatus=1'))).toBeNull();
    expect(parseRouterTerminalCompletion(output.replace('status=passed', 'status=passed finalizationError=true'))).toBeNull();
    expect(parseRouterTerminalCompletion('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed')).toBeNull();
  });

  it('returns the reportless Node zero-match diagnosis without replaying the router', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-node-zero-match-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const pattern = '^no-such-case$';
    const output = ['ROUTE cwd=packages/x runner=node:test', '  requested real.test.ts',
      'ℹ tests 0', 'ℹ pass 0', 'ℹ fail 0', 'ℹ skipped 0',
      `TEST_FILE_NAME_FILTER_NO_MATCH requested=1 matched=1 executedFiles=1 testsExecuted=0 status=failed reason=name-filter-matched-no-tests pattern=${JSON.stringify(pattern)}; refusing to report a verdict`,
    ].join('\n');
    const runRouterFn = vi.fn(async () => ({
      code: 2, signal: null, timedOut: false, aborted: false, output,
    }));
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], testNamePattern: pattern },
      { runRouterFn });
    expect(out).toMatchObject({ ok: false, error: 'name_filter_no_match', skipped: 0, files: 1 });
    expect(out).not.toHaveProperty('detachedRunId');
    expect(runRouterFn).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('preserves original diagnostics when exit %s has no measured report', async (code) => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-missing-report-log-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const logPath = join(root, 'original-router.log');
    const cause = 'integration bootstrap failed before reporting';
    await writeFile(logPath, `${cause}\n${'startup progress\n'.repeat(1000)}`);
    const runRouterFn = vi.fn(async () => ({
      code, signal: null, timedOut: false, aborted: false,
      output: 'startup progress\n'.repeat(200), outputLogPaths: [logPath],
    }));
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'] }, { runRouterFn });
    expect(out).toMatchObject({ ok: false, error: 'no_report', diagnostics: { routerLogPaths: [logPath] } });
    expect(await readFile(logPath, 'utf8')).toContain(cause);
    expect(runRouterFn).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('keeps the leading setup error and logs after exit %s with an empty JSON report', async (code) => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-empty-report-log-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const cause = 'Error: fixture setup failed before any test file was measured';
    await writeFile(join(root, 'scripts/test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `process.stderr.write(${JSON.stringify(`${cause}\n`)});`,
      "process.stdout.write('startup progress\\n'.repeat(1000));",
      "const report = process.argv.find((arg) => arg.startsWith('--outputFile='));",
      "writeFileSync(report.slice('--outputFile='.length), JSON.stringify({ testResults: [] }));",
      `process.exitCode = ${code};`,
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], timeoutMs: 30_000 });
    if (out.error !== 'no_report') throw new Error(JSON.stringify(out));
    const logs = out.diagnostics?.routerLogPaths ?? [];
    try {
      expect(out.ok).toBe(false);
      expect(out.hint).toContain('no test verdict was measured');
      expect(out).not.toHaveProperty('passed');
      expect(out).not.toHaveProperty('failed');
      expect(out).not.toHaveProperty('files');
      expect(out.routerOutput).toContain(cause);
      expect(out.diagnostics).toMatchObject({ routerExit: code, markerSeen: false, summarySeen: 'none' });
      expect(logs).toHaveLength(2);
      expect(await readFile(logs[0]!, 'utf8')).toContain('startup progress');
      expect(await readFile(logs[1]!, 'utf8')).toBe(`${cause}\n`);
    } finally {
      await Promise.all(logs.map((path) => rm(path, { force: true })));
    }
  });

  it('retains the original router log and source/cleanup packet after a measured successful verdict', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-success-log-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const logPath = join(root, 'original-router.log');
    await writeFile(logPath, 'original output\n');
    const runRouterFn = vi.fn(async () => ({
      code: 0, signal: null, timedOut: false, aborted: false, outputLogPaths: [logPath],
      output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed',
    }));
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'] }, { runRouterFn });
    expect(out).toMatchObject({ ok: true, passed: 1, failed: 0 });
    expect(existsSync(logPath)).toBe(true);
    expect(await readFile(logPath, 'utf8')).toBe('original output\n');
    expect(out.cleanup).toMatchObject({ complete: true, errors: [] });
    expect(out.artifacts).toBeDefined();
    const manifest = JSON.parse(await readFile(out.artifacts!.manifest, 'utf8'));
    expect(manifest).toMatchObject({ state: 'retained', childState: 'closed', cleanup: { complete: true } });
    expect(await readFile(join(out.artifacts!.directory, 'source.json'), 'utf8')).toContain('package-lock.json');
    expect(await readFile(join(out.artifacts!.directory, 'router.json'), 'utf8')).toContain(logPath);
    expect(runRouterFn).toHaveBeenCalledTimes(1);
  });

  it('P003 reopens real runner bytes in a separate retained-only process after scratch producer retirement', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-p003-retirement-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    // A real child exercises the maintained runner's stream and cleanup seam.
    // The controlled node summary is not a claim of native Vitest execution.
    await writeFile(join(root, 'scripts/test-files.mjs'), [
      'process.stdout.write(Buffer.from([0,255,10]));',
      'process.stderr.write(Buffer.from([255,0,10]));',
      "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');",
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const runId = randomUUID();
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], runId,
      workspaceId: 'p003-custody', harnessSlug: 'papercusp', timeoutMs: IN_PROCESS_CLASSIFICATION_CEILING_MS });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, passed: 1, failed: 0, cleanup: { complete: true, errors: [] } });
    const paths = out.artifacts!;
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
    expect(manifest).toMatchObject({ childState: 'closed', cleanup: { complete: true },
      nativeCustody: { byteCustody: 'complete', writerState: 'settled', producerRetirement: 'not-performed',
        nativeProof: 'unqualified', acceptance: 'unmeasured' } });
    // Derive the expected auxiliary population from original packet surfaces,
    // independently of the native manifest that the consumer will verify.
    const auxiliary: Array<{ role: string; state: 'produced'; path: string }> = [];
    for (const name of ['source.json', 'configuration.json', 'router.json', 'ledger.json', 'phases.jsonl'])
      auxiliary.push({ role: name, state: 'produced', path: join(paths.directory, name) });
    async function inventory(directory: string, role: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) await inventory(join(directory, entry.name), `${role}/${entry.name}`);
        else auxiliary.push({ role: `${role}/${entry.name}`, state: 'produced', path: join(directory, entry.name) });
      }
    }
    for (const [role, directory] of [['reports', paths.reports], ['owned-databases', paths.ownedDatabases],
      ['executed-inputs', paths.runtimeInputs]]) await inventory(directory, role);
    const logs: string[] = JSON.parse(await readFile(join(paths.directory, 'router.json'), 'utf8')).outputLogPaths;
    expect(logs).toHaveLength(2);
    logs.forEach((path, index) => auxiliary.push({ role: `router-output/${index}`, state: 'produced', path }));
    const expectedBytes = await Promise.all(auxiliary.map(async entry => {
      const bytes = await readFile(entry.path);
      return { role: entry.role, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
    }));
    const contract = { identity: { workspace: 'p003-custody', harness: 'papercusp', runId }, expected: [{
      id: 'packet', attempt: 'primary', selected: [join(root, 'packages/x/real.test.ts')],
      runner: 'unsupported', armed: false, out: null, auxiliary }] };
    // Copy the immutable retained directory alone; remove the producer checkout,
    // original logs and packet metadata so the consumer has no original fallback.
    const consumerRoot = await mkdtemp(join(tmpdir(), 'p003-retained-consumer-'));
    selectorRoots.push(consumerRoot);
    const { cp } = await import('node:fs/promises');
    await cp(paths.nativeProof, join(consumerRoot, 'native-proof'), { recursive: true });
    await rm(root, { recursive: true });
    await Promise.all(logs.map(path => rm(path, { force: true })));
    await rm(paths.directory, { recursive: true });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(paths.directory)).toBe(false);
    const consume = (locator = manifest.nativeCustody.locator, expectedContract = contract) => spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {verifyNativeProofPacket} from ' + JSON.stringify(join(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs')) + ';' +
      'try { const r=verifyNativeProofPacket(...JSON.parse(process.argv[1]));' +
      'process.stdout.write(JSON.stringify({pid:process.pid,status:r.status,verdicts:r.manifest.verdicts,' +
      'pins:r.manifest.groups[0].auxiliary.map(a=>({role:a.role,sha256:a.artifact.sha256,byteLength:a.artifact.byteLength}))})); }' +
      'catch(error) { process.stdout.write(JSON.stringify({pid:process.pid,refused:true,error:String(error)})); }',
      JSON.stringify([join(consumerRoot, 'native-proof'), locator, expectedContract])],
    { encoding: 'utf8', timeout: 15_000 });
    const child = consume();
    expect({ error: child.error, status: child.status, stderr: child.stderr })
      .toEqual({ error: undefined, status: 0, stderr: '' });
    const read = JSON.parse(child.stdout);
    expect(read.pid).not.toBe(process.pid);
    expect(read.pins).toEqual(expectedBytes);
    expect(read).toMatchObject({ status: 'complete', verdicts: { protocol: 'unqualified', producerRetirement: 'not-performed',
      cleanup: { complete: true }, nativeProof: 'unqualified', acceptance: 'unmeasured' } });
    const objects = join(consumerRoot, 'native-proof', 'objects');
    const altered = JSON.parse(await readFile(join(objects, manifest.nativeCustody.locator.manifest.ref), 'utf8'));
    altered.groups[0].auxiliary.pop();
    const pin = createNativeArtifactPersister(objects).persist(Buffer.from(JSON.stringify(altered)), 'native-proof.json');
    for (const refusal of [consume({ ...manifest.nativeCustody.locator, manifest: pin }),
      consume(manifest.nativeCustody.locator, { ...contract, expected: [] })]) {
      expect({ error: refusal.error, status: refusal.status, stderr: refusal.stderr })
        .toEqual({ error: undefined, status: 0, stderr: '' });
      expect(JSON.parse(refusal.stdout)).toMatchObject({ refused: true });
    }
  }, 120_000);

  it('P003 preserves unavailable custody and cleanup receipts after a real unsealed router is hard-killed', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-p003-interrupted-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const ready = join(root, 'writer-ready');
    await writeFile(join(root, 'scripts/test-files.mjs'), [
      "import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';",
      "const directory=join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,'native-router-interrupted');",
      'mkdirSync(directory,{mode:448});',
      "writeFileSync(join(directory,'expected.json'),JSON.stringify({identity:{workspace:'p003-interrupted',harness:'papercusp',runId:process.env.PAPERCUSP_TEST_RUN_GROUP},expected:[]}));",
      'process.stdout.write("P003 writer pending\\n");',
      'writeFileSync(' + JSON.stringify(ready) + ',"ready");',
      'process.kill(process.pid,"SIGKILL");',
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], workspaceId: 'p003-interrupted',
      harnessSlug: 'papercusp', timeoutMs: IN_PROCESS_CLASSIFICATION_CEILING_MS,
      allowDetachedRecovery: false });
    expect(existsSync(ready)).toBe(true);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: false, error: 'no_report', cleanup: { complete: true, errors: [] } });
    expect(out).not.toHaveProperty('passed');
    expect(out).not.toHaveProperty('detachedRunId');
    const manifest = JSON.parse(await readFile(out.artifacts!.manifest, 'utf8'));
    expect(manifest).toMatchObject({ childState: 'closed', cleanup: { complete: true }, nativeCustody: {
      byteCustody: 'unavailable', nativeProof: 'unqualified', acceptance: 'unmeasured', producerRetirement: 'retained' } });
    expect(manifest.nativeCustody.error).toContain('locator.json');
    expect(existsSync(join(out.artifacts!.directory, 'native-router-interrupted', 'expected.json'))).toBe(true);
    expect(existsSync(join(out.artifacts!.directory, 'native-router-interrupted', 'locator.json'))).toBe(false);
    // The maintained shell wrapper normalizes the child's SIGKILL to 128 + 9.
    expect(JSON.parse(await readFile(join(out.artifacts!.directory, 'router.json'), 'utf8')))
      .toMatchObject({ code: 137, signal: null, childState: 'closed' });
  }, 120_000);

  it('completes confirmed-close cleanup when private native custody refuses a redirected root (P002)', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-custody-refusal-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const runRouterFn = vi.fn(async (_args: string[], _cwd: string, env: NodeJS.ProcessEnv) => {
      await symlink(root, join(env.PAPERCUSP_TEST_ARTIFACT_DIR!, 'native-proof'));
      return { code: 0, signal: null, timedOut: false, aborted: false,
        output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed' };
    });
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'] }, { runRouterFn });
    expect(out).toMatchObject({ ok: true, cleanup: { complete: true, errors: [] } });
    const manifest = JSON.parse(await readFile(out.artifacts!.manifest, 'utf8'));
    expect(manifest.nativeCustody).toMatchObject({ byteCustody: 'unavailable', nativeProof: 'unqualified',
      acceptance: 'unmeasured', producerRetirement: 'retained' });
    expect(manifest.nativeCustody.error).toContain('custody redirected ancestor');
  });

  it.each([0, 1])('keeps the real router child log after exit %s without a report', async (code) => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-real-missing-report-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const cause = 'fixture bootstrap cause before verbose startup';
    await writeFile(join(root, 'scripts/test-files.mjs'), [
      `process.stderr.write(${JSON.stringify(`${cause}\n`)});`,
      "process.stdout.write('startup progress\\n'.repeat(1000));",
      `process.exitCode = ${code};`,
    ].join('\n'));
    await sealScratchTestCheckout(root);
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], timeoutMs: 30_000 });
    if (out.error !== 'no_report') throw new Error(JSON.stringify(out));
    const logs = out.diagnostics?.routerLogPaths ?? [];
    try {
      expect(logs).toHaveLength(2);
      expect(await readFile(logs[0]!, 'utf8')).toContain('startup progress');
      expect(await readFile(logs[1]!, 'utf8')).toContain(cause);
    } finally {
      await Promise.all(logs.map((path) => rm(path, { force: true })));
    }
  });

  it('recovers a completed Node-only run at the foreground deadline without replaying it', async () => {
    const root = await makeScratchTestCheckout('papercusp-testing-run-node-complete-');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
    await sealScratchTestCheckout(root);
    const output = [
      'ROUTE cwd=packages/x runner=node:test',
      '  requested real.test.ts',
      '# tests 2', '# pass 1', '# fail 0', '# skipped 1',
      'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed skippedTests=1',
    ].join('\n');
    expect(parseRouterTerminalCompletion(output)).toMatchObject({ requested: 1, executed: 1, status: 'passed' });
    const runRouterFn = vi.fn(async () => ({
      code: null, signal: null, timedOut: true, aborted: false, output,
    }));
    const out = await runTestFilesCore({ root, files: ['packages/x/real.test.ts'], timeoutMs: 30_000 },
      { runRouterFn });
    expect(out).toMatchObject({ ok: true, passed: 1, failed: 0, skipped: 1, files: 1, budgetExceeded: true });
    expect(out).not.toHaveProperty('detachedRunId');
    expect(runRouterFn).toHaveBeenCalledTimes(1);

    expect(parseRouterTerminalCompletion(output.replace('status=passed', 'status=passed finalizationError=true'))).toBeNull();
    expect(parseRouterTerminalCompletion(output.replace('# pass 1', '# pass 0'))).toBeNull();
    expect(parseRouterTerminalCompletion(output.replace('# pass 1', '# pass 2'))).toBeNull();
    expect(parseRouterTerminalCompletion(output.replace('executed=1', 'executed=2'))).toBeNull();
    expect(parseRouterTerminalCompletion(output.replace('runner=node:test', 'runner=vitest'))).toBeNull();
    expect(parseRouterTerminalCompletion(output.split('\n').slice(0, -1).join('\n'))).toBeNull();
  });

  it('parses a strict typed NOT-MEASURED router marker without turning ordinary route errors into one', () => {
    const marker = [
      'TEST_FILE_ROUTE_ERROR (group cwd=packages/operator-core) could not launch Vitest: statement timeout',
      'TEST_FILE_NOT_MEASURED requested=2 executed=0 matched=2 measuredFiles=0 status=not-measured reason=admission-starved — governed test-process admission was refused after retryable database contention.',
    ].join('\n');
    expect(parseRouterNotMeasuredMarker(marker)).toEqual({
      requested: 2,
      executed: 0,
      matched: 2,
      measuredFiles: 0,
      status: 'not-measured',
      reason: 'admission-starved',
    });
    expect(parseRouterNotMeasuredMarker('TEST_FILE_ROUTE_ERROR requested=1 matched=0')).toBeNull();
    expect(
      parseRouterNotMeasuredMarker(
        'TEST_FILE_NOT_MEASURED requested=2 executed=0 matched=2 measuredFiles=1 status=not-measured reason=admission-starved',
      ),
    ).toBeNull();
    const watchdog = [
      'TEST_FILE_WATCHDOG cwd=packages/operator-core files=["pui.integration.test.ts"] timeoutMs=600000 status=timed-out — owned child tree reaped; NOT MEASURED',
      'TEST_FILE_NOT_MEASURED requested=5 executed=5 matched=5 status=not-measured — a watchdog reaped at least one run before it finished; no test-failure verdict was produced.',
    ].join('\n');
    expect(parseRouterNotMeasuredMarker(watchdog)).toEqual({
      requested: 5, executed: 5, matched: 5, status: 'not-measured', reason: 'router-watchdog',
    });
    expect(parseRouterNotMeasuredMarker(watchdog.split('\n')[1]!)).toBeNull();
  });

  it('returns structured actual/expected values for a real failing assertion', async () => {
    const prior = process.env[FAILING_ASSERTION_TARGET_VAR];
    process.env[FAILING_ASSERTION_TARGET_VAR] = '1';
    try {
      const out = await body(call({ files: [FAILING_ASSERTION_TARGET] }));

      expect(out.ok).toBe(false);
      expect(out.failed).toBe(1);
      expect(out.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: FAILING_ASSERTION_TARGET,
            test: 'preserves the assertion values',
            actual: expect.stringContaining('service_select'),
            expected: expect.stringContaining('service_select'),
          }),
        ]),
      );
    } finally {
      if (prior === undefined) delete process.env[FAILING_ASSERTION_TARGET_VAR];
      else process.env[FAILING_ASSERTION_TARGET_VAR] = prior;
    }
  }, 180_000);

  it('redacts a credential added only to the launched child environment from the failure response', async () => {
    const file = 'packages/x/credential-redaction.test.ts';
    const root = await makeScratchTestCheckout('testing-run-child-env-redaction-', file);
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'test-files.mjs'), 'process.exit(0);\n');
    await sealScratchTestCheckout(root);

    const credential = 'synthetic-child-only-credential-value-1234567890';
    const credentialKey = `PAPERCUSP_SYNTHETIC_API_KEY_${randomUUID().replaceAll('-', '')}`;
    expect(process.env[credentialKey]).toBeUndefined();
    const testName = 'suite > keeps inherited credentials private';
    const runRouterFn = vi.fn(async (args: string[], _cwd: string, environment: NodeJS.ProcessEnv) => {
      environment[credentialKey] = credential;
      const reportArgument = args.find((arg) => arg.startsWith('--outputFile='));
      if (!reportArgument) throw new Error('test router did not receive the JSON report path');
      await writeFile(reportArgument.slice('--outputFile='.length), JSON.stringify({ testResults: [{
        name: join(root, file),
        status: 'failed',
        assertionResults: [{
          status: 'failed',
          fullName: testName,
          failureMessages: [`received ${credential} from the child environment`],
        }],
      }] }));
      const detailsPath = environment.PAPERCUSP_TEST_FAILURE_DETAILS_PATH;
      if (!detailsPath) throw new Error('test router did not receive the failure details path');
      await writeFile(detailsPath, JSON.stringify({ failures: [{
        file: join(root, file),
        test: testName,
        actual: { observed: credential },
        expected: { observed: 'placeholder' },
      }] }));
      return { code: 1, signal: null, timedOut: false, aborted: false, output: '' };
    });

    const result = await runTestFilesCore({ root, files: [file], timeoutMs: 10_000 }, { runRouterFn });
    const serialized = JSON.stringify(result);

    expect(result, serialized).toMatchObject({
      ok: false,
      failed: 1,
      failures: [expect.objectContaining({
        test: testName,
        message: expect.stringContaining('[redacted]'),
        actual: expect.stringContaining('[redacted]'),
      })],
    });
    expect(serialized).not.toContain(credential);
    expect(process.env[credentialKey]).toBeUndefined();
  }, 30_000);

  it('runs a repo-resolving file from a phantom handler root through the canonical repo and surfaces the source', async () => {
    const phantom = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-handler-phantom-'));
    await rm(phantom, { recursive: true, force: true });
    const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = REPO_ROOT;
    try {
      const out = await body(call({ files: [GREEN_TARGET] }, { projectDir: phantom }));

      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.rootSource).toBe('canonical-repo');
      expect(out.root).toBe(REPO_ROOT);
      expect(existsSync(join(out.root as string, GREEN_TARGET))).toBe(true);
    } finally {
      if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
    }
  }, 180_000);

  it('keeps the admin test-run ledger reporter alongside machine-readable JSON output', async () => {
    const metadata = vi.fn<(data: Record<string, unknown>) => void>();
    const out = await body(
      call(
        { files: [GREEN_TARGET], harness: 'papercusp' },
        {
          projectDir: REPO_ROOT,
          harnessSlug: '*',
          workspaceId: 'papercusp-workspace',
          metadata,
        },
      ),
    );

    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.phaseTimingsMs).toEqual({
      preflightMs: expect.any(Number),
      provenanceMs: expect.any(Number),
      preparationMs: expect.any(Number),
      admissionWaitMs: expect.any(Number),
      routerExecutionMs: expect.any(Number),
      ledgerIdReadbackMs: expect.any(Number),
      finalizationMs: expect.any(Number),
      totalHandlerMs: expect.any(Number),
    });
    const phaseTimings = out.phaseTimingsMs!;
    expect(Object.values(phaseTimings).every((duration) => typeof duration === 'number' && duration >= 0)).toBe(true);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0]?.[0]).toMatchObject({
      testingRun: {
        schemaVersion: 'testing-run-phase-telemetry-v1',
        runId: out.runId,
        outcome: 'passed',
        phaseTimingsMs: out.phaseTimingsMs,
      },
    });
    if (typeof out.runId !== 'string') {
      throw new Error(`testing:run omitted runId: ${JSON.stringify(out)}`);
    }

    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{ id: string; file_path: string; status: string; harness_slug: string | null; workspace_id: string | null }>
    >`
      SELECT id, file_path, status, harness_slug, workspace_id
      FROM harness_shared.test_runs
      WHERE run_group_id = ${out.runId}
    `;
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: expect.anything(),
          file_path: GREEN_TARGET,
          status: 'pass',
          harness_slug: 'papercusp',
          workspace_id: 'papercusp-workspace',
        },
      ]),
    );
    expect(out.testRunIds).toEqual(expect.arrayContaining(rows.map((row) => Number(row.id)).filter(Number.isFinite)));
    const targetRow = rows.find((row) => row.file_path === GREEN_TARGET);
    expect(targetRow).toBeDefined();
    expect(out.byFile?.[GREEN_TARGET]).toMatchObject({ runId: Number(targetRow!.id) });
  }, 180_000);

  it('accepts a workspace-relative test path and expands it before routing', async () => {
    const out = await body(call({ files: [OPERATOR_CORE_RELATIVE_GREEN_TARGET] }, { projectDir: REPO_ROOT }));

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    expect(out.files).toBe(1);
    expect(out.passed).toBeGreaterThan(0);
  }, 180_000);

  it('refuses a workspace-relative path that exists in multiple workspaces', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-ambiguous-'));
    try {
      await mkdir(join(fixture, 'packages', 'one'), { recursive: true });
      await mkdir(join(fixture, 'packages', 'two'), { recursive: true });
      await writeFile(join(fixture, 'packages', 'one', 'shared.test.ts'), '');
      await writeFile(join(fixture, 'packages', 'two', 'shared.test.ts'), '');

      expect(normalizeTestFilePaths(['shared.test.ts'], fixture, ['packages/one', 'packages/two'])).toEqual({
        ok: false,
        path: 'shared.test.ts',
        matches: ['packages/one/shared.test.ts', 'packages/two/shared.test.ts'],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  // EI-18822211427354845 — THE case this suite was missing, and the only one that
  // can exhibit the bug. The router runs ONE `vitest run` per owning workspace
  // config, and every group used to be handed the SAME `--outputFile`: each group
  // overwrote the last, so the tool distilled ONE group and reported it as the whole
  // run. Live incident: a RED operator-core file plus a green apps/operator file
  // returned `passed:7, failed:0, files:1, failures:[]` — an empty failure list for a
  // red tree. Every prior case here was single-group, where last-writer-wins is
  // indistinguishable from correct, which is exactly why it went unnoticed.
  it("spans MULTIPLE workspaces without one group's report overwriting another", async () => {
    const out = await body(call({ files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.failed).toBe(0);
    // The field that lied: 1 for a two-workspace request. This is the decisive
    // assertion — `files` is summed across the per-group reports, so it can only
    // reach 2 if BOTH were read and merged rather than one overwriting the other.
    expect(out.files).toBe(2);
    expect(out.passed).toBeGreaterThan(0);
    expect(out.failures).toEqual([]);
    // Deliberately not pinned to exact counts, for the same reason as the
    // single-group case above: that would make this a tripwire for unrelated edits
    // to either target suite.
  }, 300_000);

  // THE load-bearing guarantee. A root-level `vitest run <path>` that matches
  // nothing exits 0 under --passWithNoTests — a run that executed NOTHING and
  // reads as a pass. D-021 measured 107 corpus commands in that exact shape.
  // Going through the router makes it inexpressible; this pins that it does.
  it('refuses a nonexistent path instead of passing vacuously', async () => {
    const out = await body(call({ files: ['packages/operator-core/lib/__no_such_file__.test.ts'] }));

    expect(out.ok).toBe(false);
    expect(out.error).toBe('route_error');
    expect(out.routerOutput).toContain('TEST_FILE_ROUTE_ERROR');
  }, 120_000);

  // EI-19425177453558152 — the SAME vacuous-pass class as the case above, through the one
  // argument this suite never covered. A `testNamePattern` matching zero tests left every test
  // SKIPPED and vitest exited 0, so the router reported `status=passed` and this tool returned a
  // green. It fires in the expensive direction: the canonical reason to pass a name filter is to
  // confirm a pre-fix RED, and a false green there reads as "the defect isn't real", so the
  // natural next move is to stop — having verified nothing.
  it('refuses a testNamePattern that matches ZERO tests instead of passing vacuously', async () => {
    const out = await body(call({ files: [GREEN_TARGET], testNamePattern: 'zzz-no-such-test-name' }));

    expect(out.ok).toBe(false);
    expect(out.error).toBe('name_filter_no_match');
    // The reason must be STATED. `ok:false` next to `failed:0` is exactly the shape an agent
    // misreads as "nothing failed", which is how this bug survives one layer down.
    expect(String(out.hint)).toContain('ZERO tests');
    // The tests really were collected-then-skipped — i.e. this refused a VACUOUS run, it did not
    // merely fail to find the file (which `route_error` already covers).
    expect(out.skipped).toBeGreaterThan(0);
  }, 120_000);

  // Non-vacuousness for the case above: it would also pass if ANY name filter were refused.
  it('still runs normally when the testNamePattern DOES match', async () => {
    const out = await body(call({ files: [GREEN_TARGET], testNamePattern: GREEN_TARGET_TEST_NAME_FRAGMENT }));

    expect(out.ok).toBe(true);
    expect(out.passed).toBeGreaterThan(0);
  }, 120_000);

  // EI-21909191824649521 — the SAME vacuous-pass class as the two cases above, reached through
  // the argument set that carries NO filter at all, which is why neither of them caught it. An
  // env-gated `describe.skipIf` suite collects every test and executes none; vitest exits 0, so
  // this returned ok:true / passed:0 / failed:0 with `skipped:3` sitting below the two fields a
  // reader actually treats as the verdict. It fires in the expensive direction: acceptance
  // rubrics routinely bind replication drills to `*-live` suites, so a grader following the
  // drill gets a green and credits a criterion on which zero assertions ever ran.
  it('refuses a file whose tests were ALL skipped instead of passing vacuously', async () => {
    // The child inherits this process's env, so pin the gate CLOSED rather than trusting the
    // ambient value — otherwise a box that happens to export it turns this into a false green,
    // which is the very failure under test.
    const prior = process.env[ENV_GATED_TARGET_VAR];
    delete process.env[ENV_GATED_TARGET_VAR];
    let out: RunResult;
    try {
      out = await body(call({ files: [ENV_GATED_TARGET] }));
    } finally {
      if (prior !== undefined) process.env[ENV_GATED_TARGET_VAR] = prior;
    }

    expect(out.ok).toBe(false);
    expect(out.error).toBe('all_tests_skipped');
    // Collected-THEN-skipped, not "the path matched nothing" — `route_error` already owns that,
    // and without this assertion the case would also pass against a missing file.
    expect(out.skipped).toBeGreaterThan(0);
    expect(out.passed ?? 0).toBe(0);
    // The reason must be STATED: `ok:false` beside `failed:0` is the exact shape an agent
    // misreads as "nothing failed".
    expect(String(out.hint)).toContain('NONE executed');
  }, 120_000);

  // Non-vacuousness for the case above, and the specific way its fix could go wrong: refusing on
  // `passed === 0` alone would refuse EVERY green run too. A run that really executed tests must
  // still be green.
  it('still returns a green for a run that actually executed tests', async () => {
    const out = await body(call({ files: [GREEN_TARGET] }));

    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.passed).toBeGreaterThan(0);
  }, 120_000);

  // WI-7189 / EI-19383071792758676: the failure mode the router's own check
  // CANNOT catch — a resolved workspace root that isn't a papercusp checkout at
  // all (e.g. a stale/legacy clone missing scripts/test-files.mjs). Before this
  // fix that surfaced two layers down as an opaque spawn error; now it's a named,
  // loud refusal that echoes the wrong root instead of silently running (or
  // failing to run) against it.
  it('refuses a resolved root that is not a papercusp checkout (invalid_root)', async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-invalid-root-'));
    try {
      const out = await body(call({ files: ['whatever.test.ts'] }, { projectDir: fakeRoot }));

      expect(out.ok).toBe(false);
      expect(out.error).toBe('invalid_root');
      expect(out.root).toBe(await realpath(fakeRoot));
      expect(out.hint).toContain('scripts/test-files.mjs');
    } finally {
      await rm(fakeRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
  }, 30_000);

  // The same false-green in its most tempting form: a path that genuinely
  // EXISTS, so nothing looks wrong, but holds no tests.
  it('refuses an existing NON-TEST source file instead of passing vacuously', async () => {
    const out = await body(call({ files: ['packages/operator-core/lib/testing-run-store.ts'] }));

    expect(out.ok).toBe(false);
    expect(['route_error', 'no_report']).toContain(out.error);
  }, 180_000);

  it('routes integration timeout recovery through the owning test:file router', () => {
    const hint = detachedTestTimeoutHint(['packages/operator-core/lib/example.integration.test.ts']);

    expect(hint).toContain('capability:bash');
    expect(hint).toContain('npm run test:file -- <test path>');
    expect(hint).toContain('owning Vitest config');
    expect(hint).not.toContain('capability:inspect');
    expect(detachedTestTimeoutHint(['packages/operator-core/lib/example.test.ts'])).toContain('capability:inspect');
  });

  it('returns timeout recovery before optional execution-ledger readback', () => {
    expect(shouldResolveHarnessTestRunIds({ ok: false, error: 'timeout' })).toBe(false);
    expect(shouldResolveHarnessTestRunIds({ ok: false, error: 'route_error' })).toBe(true);
    expect(shouldResolveHarnessTestRunIds({ ok: true })).toBe(true);
  });

  it('bounds optional harness test-run ID readback and keeps a slow ledger distinct from no IDs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fast = await readHarnessTestRunIdsBounded(
        { workspaceId: 'ws', harnessSlug: 'harness', runGroupId: 'run-fast' },
        { timeoutMs: 20, findIds: async () => [77] },
      );
      expect(fast).toMatchObject({ ids: [77], degraded: false });

      const startedAt = Date.now();
      const slow = await readHarnessTestRunIdsBounded(
        { workspaceId: 'ws', harnessSlug: 'harness', runGroupId: 'run-slow' },
        { timeoutMs: 20, findIds: async () => new Promise<number[]>(() => {}) },
      );
      expect(slow).toMatchObject({ ids: null, degraded: true, reason: 'timeout' });
      expect(slow.elapsedMs).toBeLessThan(500);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(TEST_RUN_ID_READBACK_TIMEOUT_MS).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('harness test-run ID readback'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('maps reversed ledger rows to byFile paths instead of pairing IDs by array position', async () => {
    const runGroupId = 'run-id-order-test';
    const workspaceId = 'workspace-id-order-test';
    const harnessSlug = 'harness-id-order-test';
    const root = '/repo';
    const byFile = {
      'packages/alpha.test.ts': { passed: 1, failed: 0, skipped: 0, collectionFailed: false },
      '/sibling/packages/alpha.test.ts': { passed: 1, failed: 0, skipped: 0, collectionFailed: false },
    };
    const details = (rowRoot: string, filePath: string) => ({
      schemaVersion: 1 as const,
      root: rowRoot,
      filePath,
      runGroupId,
      workspaceId,
      harnessSlug,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'abcdef1234567890',
      worktreeDirty: false,
    });
    const rows: HarnessTestRunEvidence[] = [
      {
        id: 22,
        file_path: 'packages/alpha.test.ts',
        status: 'pass',
        finished_at: null,
        workspace_id: workspaceId,
        harness_slug: harnessSlug,
        run_group_id: runGroupId,
        commit_sha: 'abcdef1234567890',
        worktree_dirty: false,
        execution_details: details('/sibling', 'packages/alpha.test.ts'),
      },
      {
        id: 11,
        file_path: 'packages/alpha.test.ts',
        status: 'pass',
        finished_at: null,
        workspace_id: workspaceId,
        harness_slug: harnessSlug,
        run_group_id: runGroupId,
        commit_sha: 'abcdef1234567890',
        worktree_dirty: false,
        execution_details: details(root, 'packages/alpha.test.ts'),
      },
    ];

    const readback = await readHarnessTestRunIdsBounded(
      { workspaceId, harnessSlug, runGroupId },
      { findEvidence: async () => rows, timeoutMs: 100, root, roots: [root, '/sibling'], byFile },
    );
    expect(readback).toMatchObject({
      ids: [11, 22],
      idsByFile: {
        'packages/alpha.test.ts': 11,
        '/sibling/packages/alpha.test.ts': 22,
      },
      degraded: false,
    });
    expect(mapHarnessTestRunIdsByFile(byFile, rows, {
      root,
      roots: [root, '/sibling'],
      workspaceId,
      harnessSlug,
      runGroupId,
    })).toEqual(readback.idsByFile);
  });

  it('builds a fresh store-backed router request with both the admin ledger reporter and retained JSON', () => {
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      testNamePattern: 'suite > --focused test',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      timeoutMs: 900_000,
      originRunId: 'foreground-origin-1',
    });
    expect(request).toMatchObject({
      kind: 'vitest',
      command: process.execPath,
      cwd: REPO_ROOT,
      filePath: 'packages/example.test.ts',
      requestedFiles: ['packages/example.test.ts'],
      runtimeMaxSec: 930,
      originRunId: 'foreground-origin-1',
    });
    expect(request.args).toEqual([
      join(REPO_ROOT, 'scripts', 'test-files.mjs'),
      'packages/example.test.ts',
      '--',
      '--reporter=json',
      `--reporter=${join(REPO_ROOT, 'libs/test-config/src/admin-test-runs-reporter.ts')}`,
      `--outputFile=${request.detachedReportArtifacts?.[0]?.reportPath}`,
      '--testNamePattern=suite > --focused test',
    ]);
    expect(request.detachedReportArtifacts?.[0]?.reportPath).toContain('papercusp-testing-run-detached-');
    expect(request.env).toEqual({
      NODE_ENV: 'test',
      PAPERCUSP_TEST_FILE_TIMEOUT_MS: '900000',
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
      PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
    });
    // No work-item was named, so none is invented.
    expect(request).not.toHaveProperty('workItemId');
  });

  it('stores the foreground origin on the detached task, outside its deadline replay payload', () => {
    const originRunId = 'foreground-origin-deadline';
    const startedAtMs = Date.now();
    const taskDeadlineAtMs = startedAtMs + 120_000;
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      timeoutMs: 60_000,
      originRunId,
      deadline: {
        startedAtMs,
        taskDeadlineAtMs,
        childCutoffAtMs: taskDeadlineAtMs - 10_000,
        cleanupReserveMs: 10_000,
      },
    });

    expect(request.originRunId).toBe(originRunId);
    expect(request.args.join('\n')).not.toContain(originRunId);
  });

  it('carries the verified work-item onto the detached request (expensive-verification-loops P-001)', () => {
    const single = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      workItemId: 'WI-10003898',
      originRunId: 'foreground-origin-2',
    });
    expect(single.workItemId).toBe('WI-10003898');
    expect(single.originRunId).toBe('foreground-origin-2');

    const mixed = buildDetachedMixedTestRunRequest({
      groups: [{ root: REPO_ROOT, files: ['packages/example.test.ts'] }],
      workItemId: 'WI-10003898',
      originRunId: 'foreground-origin-3',
    });
    expect(mixed.workItemId).toBe('WI-10003898');
    expect(mixed.originRunId).toBe('foreground-origin-3');
    expect(single.requestedFiles).toEqual(['packages/example.test.ts']);
    expect(mixed.requestedFiles).toEqual(['packages/example.test.ts']);
  });

  it('uses parent-side JSON ledger ingestion for a single detached integration file', () => {
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/operator-core/lib/sync-resolver/goals.integration.test.ts'],
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      timeoutMs: 900_000,
      testNamePattern: 'selected proof',
    });

    const artifact = request.detachedReportArtifacts?.[0];
    expect(request.requestedFiles).toEqual(['packages/operator-core/lib/sync-resolver/goals.integration.test.ts']);
    expect(artifact).toMatchObject({
      root: REPO_ROOT,
      testNamePattern: 'selected proof',
      scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
    });
    expect(request.env?.PAPERCUSP_TEST_FILE_TIMEOUT_MS).toBe('900000');
    expect(request.runtimeMaxSec).toBe(930);
    expect(artifact?.reportPath).toContain('papercusp-testing-run-detached-');
    expect(request.args).toEqual([
      join(REPO_ROOT, 'scripts', 'test-files.mjs'),
      'packages/operator-core/lib/sync-resolver/goals.integration.test.ts',
      '--',
      '--reporter=json',
      `--outputFile=${artifact?.reportPath}`,
      '--testNamePattern=selected proof',
    ]);
    expect(request.args.some((arg) => arg.includes('admin-test-runs-reporter'))).toBe(false);
  });

  it('persists the detached router budget and leaves time for its terminal report', () => {
    const foregroundTimeoutMs = 45_000;
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      timeoutMs: foregroundTimeoutMs,
    });
    const mixedRequest = buildDetachedMixedTestRunRequest({
      groups: [{ root: REPO_ROOT, files: ['packages/example.test.ts'] }],
      timeoutMs: foregroundTimeoutMs,
    });

    // The foreground transport ceiling is about 45s. Detached recovery must
    // not inherit that wall or the router will fall back to its 10-minute default.
    // The 15-minute per-file budget is persisted on both routes; the outer scope
    // gets 30 seconds to report its terminal result before it is reaped.
    expect(request.env?.PAPERCUSP_TEST_FILE_TIMEOUT_MS).toBe('900000');
    expect(mixedRequest.env?.PAPERCUSP_TEST_FILE_TIMEOUT_MS).toBe('900000');
    expect(request.runtimeMaxSec).toBe(930);
    expect(mixedRequest.runtimeMaxSec).toBe(930);
    expect(request.runtimeMaxSec).toBeGreaterThan(Math.ceil(foregroundTimeoutMs / 1000));
    expect(mixedRequest.runtimeMaxSec).toBeGreaterThan(Math.ceil(foregroundTimeoutMs / 1000));
  });

  it('carries the full requested router budget into detached recovery', () => {
    const timeoutMs = 1_200_000;
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/example.test.ts'],
      timeoutMs,
    });
    const mixedRequest = buildDetachedMixedTestRunRequest({
      groups: [{ root: REPO_ROOT, files: ['packages/example.test.ts'] }],
      timeoutMs,
    });

    expect(request.env?.PAPERCUSP_TEST_FILE_TIMEOUT_MS).toBe(String(timeoutMs));
    expect(mixedRequest.env?.PAPERCUSP_TEST_FILE_TIMEOUT_MS).toBe(String(timeoutMs));
    expect(request.runtimeMaxSec).toBe(1230);
    expect(mixedRequest.runtimeMaxSec).toBe(1230);
  });

  it('gives every direct Vitest route its own JSON report artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-artifacts-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'packages', 'unit', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'integration', 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(join(root, 'packages', 'unit', 'package.json'), JSON.stringify({ name: '@example/unit' }));
    await writeFile(
      join(root, 'packages', 'integration', 'package.json'),
      JSON.stringify({ name: '@example/integration' }),
    );
    await writeFile(join(root, 'packages', 'integration', 'vitest.integration.config.ts'), 'export default {}.\n');
    const files = ['packages/unit/src/unit.test.ts', 'packages/integration/src/integration.integration.test.ts'];
    const request = buildDetachedMixedTestRunRequest({ groups: [
      { root: REPO_ROOT, files: ['packages/managed.test.ts'] },
      { root, files },
    ] });
    const artifacts = request.detachedReportArtifacts ?? [];
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toMatchObject({ root: REPO_ROOT, routerReports: true });

    const reportPaths = artifacts.map((artifact) => artifact.reportPath);
    expect(new Set(reportPaths).size).toBe(reportPaths.length);
    expect(artifacts.slice(1).every((artifact) => artifact.root === root && !artifact.routerReports)).toBe(true);

    const script = request.args[1]!;
    const marker = 'const commands = ';
    const commandsStart = script.indexOf(marker) + marker.length;
    const commandsEnd = script.indexOf(';\nlet exitCode', commandsStart);
    expect(commandsStart).toBeGreaterThan(marker.length);
    expect(commandsEnd).toBeGreaterThan(commandsStart);
    const commands = JSON.parse(script.slice(commandsStart, commandsEnd)) as Array<{ args: string[] }>;
    const commandReportPaths = commands.map((command) => {
      const reportArg = command.args.find((arg) => arg.startsWith('--outputFile='));
      expect(reportArg).toBeDefined();
      return reportArg!.slice('--outputFile='.length);
    });
    expect(commandReportPaths).toHaveLength(3);
    expect(new Set(commandReportPaths).size).toBe(commandReportPaths.length);
    expect(commandReportPaths).toEqual(expect.arrayContaining(reportPaths));
  });

  // EI-19324351741370770: the foreground timeout used to kill only the router
  // process (`scripts/test-files.mjs`'s own pid) — but the router launches the REAL
  // vitest run via a synchronous `spawnSync`, WITHOUT its own `detached: true`, so
  // that vitest process merely inherited the router's process group rather than
  // dying with it. Killing the router by its own pid left vitest running as an
  // orphan for the suite's real duration — invisible to the caller, who was handed
  // `error:'timeout'` and reasonably believed nothing was still running, then
  // (per the tool's own advice) launched a SECOND concurrent run of the same suite.
  //
  // The first target HANGS (env-gated fixture), so the child is guaranteed to still be running
  // when the foreground budget expires, whatever the box load. The budget must also outlast the
  // handler's preflight. That preflight is charged to the child cutoff, so the old 1000ms floor
  // returned deadline_exhausted under load before any child spawned (WI-6554700010018388).
  // Two workspaces keep the multi-file detached-recovery hint in play.
  it('kills the WHOLE process tree on the foreground timeout — no orphan survives', async () => {
    const prior = process.env[HANG_TARGET_VAR];
    process.env[HANG_TARGET_VAR] = '1';
    let out: RunResult;
    try {
      out = await body(
        call({
          files: [HANG_TARGET, CROSS_WORKSPACE_GREEN_TARGET],
          timeoutMs: 15_000,
        }),
      );
    } finally {
      if (prior === undefined) delete process.env[HANG_TARGET_VAR];
      else process.env[HANG_TARGET_VAR] = prior;
    }

    expect(out.ok).toBe(false);
    expect(out.error).toBe('timeout');
    expect(typeof out.runId).toBe('string');
    expect(typeof out.detachedRunId).toBe('string');
    expect(out.hint).toContain('one detached call per file');
    expect(out.hint).toContain('onlyPaths (that field is typecheck-only)');

    // The fallback is deliberately a real store run. Stop it here so this
    // integration test never leaves a detached Vitest tree behind for the
    // remainder of the suite.
    if (typeof out.detachedRunId === 'string') {
      const detached = getRun(out.detachedRunId);
      expect(detached).not.toBeNull();
      if (detached?.status === 'running') expect(cancelRun(out.detachedRunId)).toBe(true);
    }

    // Give the SIGTERM → (5s) → SIGKILL fallback (run.ts's own `killGroup` retry)
    // time to land before asserting on the absence of survivors.
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const survivors = await pidsTaggedWithRun(out.runId as string);
    expect(survivors).toEqual([]);
  }, 90_000);

  // EI-20949515346526475: code:run can terminate its worker while an inner testing:run
  // handler is still blocked in the router. The inner handler must honor that caller-owned
  // signal and kill the SAME process group; otherwise the Vitest suite survives after the
  // outer wrapper already returned and a retry starts a duplicate run.
  it('kills the whole process tree when the caller aborts an in-flight run', async () => {
    const controller = new AbortController();
    const runPromise = body(
      call({ files: [GREEN_TARGET, CROSS_WORKSPACE_GREEN_TARGET], timeoutMs: 30_000 }, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 500);

    const out = await runPromise;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('aborted');
    expect(typeof out.runId).toBe('string');

    const survivors = await pidsTaggedWithRun(out.runId as string);
    expect(survivors).toEqual([]);
  }, 30_000);

  it('releases the request promptly and preserves its confined child on host shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'testing-run-host-shutdown-'));
    selectorRoots.push(root);
    const file = 'packages/x/real.test.ts';
    const startedPath = join(root, 'router-started');
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(dirname(join(root, file)), { recursive: true });
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
    await writeFile(join(root, file), 'export {};\n');
    await writeFile(join(root, 'scripts', 'test-files.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));`,
      'setTimeout(() => process.exit(0), 8_000);',
    ].join('\n'));
    await sealScratchTestCheckout(root);

    __resetShutdownStateForTest();
    const runId = randomUUID();
    const caller = new AbortController();
    const runPromise = runTestFilesCore({
      root,
      files: [file],
      runId,
      timeoutMs: 20_000,
      signal: caller.signal,
    });
    let guardTimer: NodeJS.Timeout | undefined;

    try {
      await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 10_000 });

      const shutdownAt = performance.now();
      markShuttingDown();
      const raced = await Promise.race([
        runPromise.then((result) => ({ result })),
        new Promise<{ timedOut: true }>((resolve) => {
          guardTimer = setTimeout(() => resolve({ timedOut: true }), 5_000);
        }),
      ]);
      if (guardTimer) clearTimeout(guardTimer);
      if ('timedOut' in raced) caller.abort(new Error('host-shutdown handoff guard expired'));
      const out = 'result' in raced ? raced.result : await runPromise;
      const elapsedMs = performance.now() - shutdownAt;
      const survivingPids = await pidsTaggedWithRun(runId);

      // The confined child owns its lifetime after the request is handed off;
      // let the fixture finish naturally before removing its scratch checkout.
      await vi.waitFor(async () => expect(await pidsTaggedWithRun(runId)).toEqual([]), {
        timeout: 10_000,
        interval: 100,
      });

      expect('timedOut' in raced, 'host shutdown should release the request before the guard').toBe(false);
      expect(elapsedMs).toBeLessThan(4_000);
      expect(out.error).toBe('aborted');
      if (out.error !== 'aborted') return;
      expect(out.hint).toContain('confined router continues under systemd ownership');
      expect(survivingPids.length).toBeGreaterThan(0);
    } finally {
      if (guardTimer) clearTimeout(guardTimer);
      __resetShutdownStateForTest();
      caller.abort(new Error('host-shutdown integration test cleanup'));
      await runPromise;
    }
  }, 30_000);
});

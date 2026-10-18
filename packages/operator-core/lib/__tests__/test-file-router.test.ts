import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { transformSync } from 'esbuild';

it('records a real node:test child when the focused router starts without a TS loader', () => {
  const router = new URL('../../../../scripts/test-files.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { spawnSync } from 'node:child_process';
    console.error('NODE_LEDGER_STAGE import-router');
    const { loadNodeTestLedger } = await import(${JSON.stringify(router)});
    console.error('NODE_LEDGER_STAGE load-ledger');
    const { beginNodeTestLedger } = await loadNodeTestLedger();
    console.error('NODE_LEDGER_STAGE begin-session');
    const dir = mkdtempSync(join(tmpdir(), 'plain-node-ledger-'));
    try {
      writeFileSync(join(dir, 'fx.test.mjs'), "import { test } from 'node:test'; test('recorded case', () => {});");
      const rows = [];
      const session = await beginNodeTestLedger({ repoRoot: dir,
        readSnapshot: async () => ({ commit: 'feedface00', porcelain: '' }),
        writeRows: async batch => { rows.push(...batch); } });
      console.error('NODE_LEDGER_STAGE run-child');
      const run = spawnSync(process.execPath, ['--test', ...session.reporterArgs, 'fx.test.mjs'],
        { cwd: dir, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } });
      if (run.status !== 0) throw new Error(JSON.stringify({ status: run.status, signal: run.signal,
        error: run.error?.message, stderr: run.stderr, stdout: run.stdout }));
      console.error('NODE_LEDGER_STAGE record-result');
      const result = await session.record();
      console.log(JSON.stringify({ recorded: result.recorded, reason: result.reason,
        status: rows[0]?.status, cases: rows[0]?.executionDetails?.passedCaseTitles }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' } });
  expect(child.status, JSON.stringify({ status: child.status, signal: child.signal,
    error: child.error?.message, stderr: child.stderr, stdout: child.stdout })).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toMatchObject({ recorded: 1, reason: null,
    status: 'pass', cases: ['recorded case'] });
});
// The production entrypoint deliberately stays executable by plain Node.
import {
  aggregateGroupResults,
  buildNodeTestArgs,
  canonicalMatch,
  classifyGovernedAdmissionFailure,
  collectionAttributionMarker,
  discoverTestRoute,
  discoverVitestRoute,
  evaluateMatch,
  formatUnsupportedTestInputs,
  formatFailedAssertionDiagnostics,
  formatRouteError,
  failedAssertionsFromReport,
  groupRoutes,
  hasVitestWorkerTerminationWarning,
  isTestFilePath,
  listedFiles,
  loadNodeTestLedger,
  main,
  looksLikeMidInstallCorruption,
  looksLikeSilentCollectionFailure,
  parseTransformFailure,
  publishPreemptReadyMarker,
  transformFailureMarker,
  perGroupVitestArgs,
  perGroupVitestEnv,
  privateIntegrationVerifierInputs,
  runCapturedTestProcess,
  runGovernedTestFileProcess,
  runTestFilesCli,
  runVitestList,
  readTestChildDiagnostic,
  stopTestScope,
  testScopeRuntimeMaxSec,
  suppressInjectedJsonReportNotice,
  defaultTestFileRunTimeoutMs,
  resolveTestChildLauncher,
  testFileRunTimeoutMs,
  testFileListTimeoutMs,
  testsExecutedFrom,
  testsSkippedFrom,
  userBusReachable,
  vitestRunFailed,
  vitestConfigLoaderPolicy,
  warnIfInstallInFlight,
  withoutOutputFileArg,
  DEFAULT_TEST_FILE_RUN_TIMEOUT_MS,
  MAX_TEST_FILE_RUN_TIMEOUT_MS,
  TEST_FILE_WATCHDOG_EXTENSION_MS,
  TEST_FILE_WATCHDOG_STALL_WINDOW_MS,
  TEST_FILE_RUN_TIMEOUT_PER_FILE_MS,
  DEFAULT_TEST_FILE_LIST_TIMEOUT_MS,
  MAX_TEST_FILE_LIST_TIMEOUT_MS,
  REPO_ROOT,
  unscopedFocusedRunWarning,
  // The .mjs CLI has no declaration file; the diagnostic lands on the `from`
  // line of this multi-line import, so the suppression directive itself must
  // be the LAST comment line immediately above that line (a directive on an
  // earlier comment line, with another comment line between it and the code,
  // is not recognized by tsc).
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';
import { workspaceTestInvocation } from '../../../../scripts/workspace-test.mjs';
import { repoLockName } from '../../../../scripts/npm-install-safe.mjs';

// Tests of main() are harness-scoped even when a caller invokes test:file without
// the optional scope env. Otherwise its unscoped-run warning trips fail-on-console
// before the router behavior under test can be asserted.
const callerHarness = process.env.PAPERCUSP_TEST_RUN_HARNESS;
beforeEach(() => { process.env.PAPERCUSP_TEST_RUN_HARNESS = 'papercusp'; });
afterEach(() => {
  if (callerHarness === undefined) delete process.env.PAPERCUSP_TEST_RUN_HARNESS;
  else process.env.PAPERCUSP_TEST_RUN_HARNESS = callerHarness;
});

describe('test-files router', () => {
  it('routes committed private proof inputs through the existing freezer before collection', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-verifier-route-'));
    const env = { NODE_OPTIONS: '--import=/repo/scripts/lib/committed-source-loader.mjs' };
    try {
      writeFileSync(join(root, 'private.test.ts'), "import { recordIsolatedIntegrationProof } from './isolated-integration-proof';\nrecordIsolatedIntegrationProof({});");
      writeFileSync(join(root, 'guard.test.ts'), "import { captureIsolatedWorker } from './isolated-integration-proof';");
      expect(privateIntegrationVerifierInputs(root, ['private.test.ts'], env)).toEqual([
        'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'private.test.ts', 'scripts/test-files.mjs',
      ]);
      expect(privateIntegrationVerifierInputs(root, ['private.test.ts'], {})).toBeNull();
      expect(privateIntegrationVerifierInputs(root, ['private.test.ts'], {},
        ['--import=/repo/scripts/lib/committed-source-loader.mjs'])).toEqual(expect.arrayContaining(['private.test.ts']));
      expect(() => privateIntegrationVerifierInputs(root, ['../foreign.test.ts'], env))
        .toThrow(/must belong to the selected repository/);
      expect(privateIntegrationVerifierInputs(root, ['guard.test.ts'], env)).toBeNull();
      writeFileSync(join(root, '.verifier-source.json'), '{}');
      expect(privateIntegrationVerifierInputs(root, ['private.test.ts'], env)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('hands the private command to verifier-run before any list or test child is started', async () => {
    const file = 'packages/operator-core/lib/endpoint-route/__tests__/portal-aggregate-create-private.e2e.test.ts';
    const oldOptions = process.env.NODE_OPTIONS;
    const oldAdmission = process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
    const list = vi.fn(), run = vi.fn(); let receiptDir: string | undefined;
    const stages: string[] = [];
    const preflight = vi.fn(async () => {
      stages.push('pg-preflight');
      return { url: 'postgresql://harness_admin:test-only@127.0.0.1:54321/papercusp', source: 'operator-env-file' };
    });
    const restricted = vi.fn(() => { stages.push('restricted-preflight'); return { verdict: 'admit' }; });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.NODE_OPTIONS = '--import=/repo/scripts/lib/committed-source-loader.mjs';
      delete process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
      const frozen = vi.fn(async options => {
        stages.push('source-freeze'); receiptDir = join(options.receiptPath, '..'); return 7;
      });
      expect(await main([resolve(REPO_ROOT, file), '--', '--testNamePattern=private Create'], {
        preflightPrivateIntegrationPgImpl: preflight,
        restrictedHoldPreflightImpl: restricted,
        runPrivateVerifierImpl: frozen, runVitestListImpl: list, runCapturedTestProcessImpl: run,
      })).toBe(7);
      expect(stages).toEqual(['restricted-preflight', 'pg-preflight', 'source-freeze']);
      expect(restricted).toHaveBeenCalledExactlyOnceWith({ repoRoot: REPO_ROOT, files: [resolve(REPO_ROOT, file)] });
      expect(list).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
      expect(frozen).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO_ROOT,
        ref: expect.stringMatching(/^[a-f0-9]{40}$/), inputs: expect.arrayContaining([file]),
        command: [process.execPath, '--import', 'tsx', 'scripts/test-files.mjs', file,
          '--', '--testNamePattern=private Create'],
        env: expect.objectContaining({ PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT: 'admitted-by-test-router' }),
      }));
      expect(frozen.mock.calls[0][0].env).toEqual(expect.objectContaining({
        HARNESS_ADMIN_DATABASE_URL: 'postgresql://harness_admin:test-only@127.0.0.1:54321/papercusp',
      }));
    } finally {
      if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
      if (oldAdmission === undefined) delete process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
      else process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT = oldAdmission;
      warning.mockRestore(); if (receiptDir) rmSync(receiptDir, { recursive: true, force: true });
    }
  });

  it.each(['restricted_write_held', 'restricted_hold_state_unknown'])(
    'refuses private proof %s before PG admission, source copying or any test child', async error => {
      const file = 'packages/operator-core/lib/endpoint-route/__tests__/portal-aggregate-create-private.e2e.test.ts';
      const oldOptions = process.env.NODE_OPTIONS;
      const oldAdmission = process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
      const frozen = vi.fn(), preflight = vi.fn(), list = vi.fn(), run = vi.fn();
      const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        process.env.NODE_OPTIONS = '--import=/repo/scripts/lib/committed-source-loader.mjs';
        delete process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
        expect(await main([resolve(REPO_ROOT, file)], {
          restrictedHoldPreflightImpl: () => ({ verdict: 'refuse', error, hint: 'Fixture census refused.' }),
          preflightPrivateIntegrationPgImpl: preflight,
          runPrivateVerifierImpl: frozen, runVitestListImpl: list, runCapturedTestProcessImpl: run,
        })).toBe(2);
        expect(preflight).not.toHaveBeenCalled(); expect(frozen).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
        expect(process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT).toBeUndefined();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(error));
      } finally {
        if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
        if (oldAdmission === undefined) delete process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
        else process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT = oldAdmission;
        warning.mockRestore();
      }
    },
  );

  it('refuses an unavailable private-proof PG before source copying or any test child', async () => {
    const file = 'packages/operator-core/lib/endpoint-route/__tests__/portal-aggregate-create-private.e2e.test.ts';
    const oldOptions = process.env.NODE_OPTIONS;
    const frozen = vi.fn(), list = vi.fn(), run = vi.fn();
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.NODE_OPTIONS = '--import=/repo/scripts/lib/committed-source-loader.mjs';
      const preflight = vi.fn(async () => { throw new Error('TEST SUBSTRATE STORAGE LOW: private PG required'); });
      expect(await main([resolve(REPO_ROOT, file)], {
        preflightPrivateIntegrationPgImpl: preflight,
        runPrivateVerifierImpl: frozen, runVitestListImpl: list, runCapturedTestProcessImpl: run,
      })).toBe(2);
      expect(preflight).toHaveBeenCalledOnce();
      expect(frozen).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('TEST SUBSTRATE STORAGE LOW'));
    } finally {
      if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
      warning.mockRestore();
    }
  });
  it('keeps guarded config imports native for both collection and execution', () => {
    const guarded = { NODE_OPTIONS: '--import=/checkout/scripts/lib/committed-source-loader.mjs' };
    expect(vitestConfigLoaderPolicy(['-t', 'selected'], guarded, [])).toEqual({
      configLoaderArgs: ['--configLoader', 'native'], vitestArgs: ['-t', 'selected'] });
    expect(vitestConfigLoaderPolicy(['--configLoader=native', '-t', 'selected'], guarded, [])).toEqual({
      configLoaderArgs: ['--configLoader', 'native'], vitestArgs: ['-t', 'selected'] });
    expect(vitestConfigLoaderPolicy(['--configLoader', 'runner'], {}, [])).toEqual({
      configLoaderArgs: ['--configLoader', 'runner'], vitestArgs: [] });
    for (const loader of ['runner', 'bundle']) expect(() =>
      vitestConfigLoaderPolicy(['--configLoader', loader], guarded, [])).toThrow('requires --configLoader native');
    expect(vitestConfigLoaderPolicy([], {}, ['--import', '/checkout/scripts/lib/committed-source-loader.mjs'])
      .configLoaderArgs).toEqual(['--configLoader', 'native']);
    expect(vitestConfigLoaderPolicy([], {}, []).configLoaderArgs).toEqual([]);
  });

  it.each(['apps/operator/vitest.config.ts', 'packages/operator-core/vitest.integration.config.ts'])(
    'loads actual TS config %s through the native committed source boundary', (configPath) => {
    const child = spawnSync(process.execPath, ['--import', './scripts/lib/committed-source-loader.mjs',
      '--input-type=module', '-e', `
        import { loadConfigFromFile } from 'vite';
        const config = await loadConfigFromFile({ command:'serve', mode:'test' },
          ${JSON.stringify(configPath)}, undefined, 'silent', undefined, 'native');
        if (!config?.config?.test) throw new Error('Actual operator config did not load');
        console.log('guarded-native-config-loaded');
      `], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' } });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('guarded-native-config-loaded');
  });
  it('runs only the selected Node case through the common router selector', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-router-selector-'));
    try {
      const file = join(dir, 'selector.test.mjs');
      const unwanted = join(dir, 'unwanted');
      const { beginNodeTestLedger } = await loadNodeTestLedger();
      const startLedger = () => beginNodeTestLedger({ repoRoot: dir,
        readSnapshot: async () => ({ commit: 'feedface00', porcelain: '' }),
        writeRows: async () => {} });
      writeFileSync(file, `import { test } from 'node:test';
        import { writeFileSync } from 'node:fs';
        test('selected (case)', () => {});
        test('unrelated case', () => { writeFileSync(${JSON.stringify(unwanted)}, 'ran'); throw new Error('must not run'); });`);
      const selectedLedger = await startLedger();
      const args = buildNodeTestArgs([file], [
        '--reporter=json', '--outputFile', join(dir, 'vitest.json'),
        '-t', '^selected \\(case\\)$',
      ], { reporterArgs: selectedLedger.reporterArgs });
      const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(existsSync(unwanted)).toBe(false);
      expect(testsExecutedFrom(run.stdout)).toBe(1);
      expect(await selectedLedger.record()).toMatchObject({ counts: { executed: 1 } });

      const absentLedger = await startLedger();
      const absent = spawnSync(process.execPath, buildNodeTestArgs([file], ['--testNamePattern=^absent$'],
        { reporterArgs: absentLedger.reporterArgs }),
        { encoding: 'utf8', timeout: 10_000 });
      expect(absent.status, absent.stderr || absent.stdout).toBe(0);
      expect(await absentLedger.record()).toMatchObject({ recorded: 0, counts: { executed: 0 } });
      expect(existsSync(unwanted)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Node preflight/reporting options and excludes Vitest reporting options', () => {
    expect(buildNodeTestArgs(['a.test.js'], [
      '--reporter', 'json', '--outputFile=result.json', '--testNamePattern=--model=', '--test-reporter=tap',
    ], { nodeArgs: ['--test-global-setup=preflight.mjs'], reporterArgs: ['--test-reporter=ledger.mjs'] }))
      .toEqual(['--test', '--test-global-setup=preflight.mjs', '--test-reporter=ledger.mjs',
        '--test-name-pattern=--model=', '--test-reporter=tap', 'a.test.js']);
    const summary = '# tests 3\n# pass 1\n# fail 1\n# skipped 1\n';
    expect(testsExecutedFrom(summary)).toBe(2);
    expect(testsSkippedFrom(summary)).toBe(1);
    expect(testsExecutedFrom(summary.replace('# tests 3', '# tests 4'))).toBeNull();
  });

  it('accepts and routes conventional CLI Node:test files with their package preflight', () => {
    const file = 'libs/papercusp/packages/cli/src/install-atomic.node-test.ts';
    expect(isTestFilePath(file)).toBe(true);
    const route = discoverTestRoute(file);
    expect(route).toMatchObject({ runner: 'node', config: null,
      cwd: resolve(REPO_ROOT, 'libs/papercusp/packages/cli'),
      requested: 'src/install-atomic.node-test.ts',
      nodeArgs: ['--test-global-setup=monorepo-host-preflight.mjs'] });
    expect(groupRoutes([route])[0].nodeArgs).toEqual(route.nodeArgs);
  });
  it('supports a bounded CLI watchdog override for slow-but-progressing files', () => {
    expect(testFileRunTimeoutMs({})).toBe(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS);
    expect(testFileRunTimeoutMs({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '540000' })).toBe(540_000);
    expect(() => testFileRunTimeoutMs({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '0' })).toThrow(/between 1 and/);
    expect(() => testFileRunTimeoutMs({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: 'not-a-number' })).toThrow(/positive integer/);
    expect(() =>
      testFileRunTimeoutMs({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(MAX_TEST_FILE_RUN_TIMEOUT_MS + 1) }),
    ).toThrow(/between 1 and/);
  });

  it('supports a bounded collection-preflight timeout override', () => {
    expect(testFileListTimeoutMs({})).toBe(DEFAULT_TEST_FILE_LIST_TIMEOUT_MS);
    expect(testFileListTimeoutMs({ PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: '180000' })).toBe(180_000);
    expect(() => testFileListTimeoutMs({ PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: '0' })).toThrow(/between 1 and/);
    expect(() => testFileListTimeoutMs({ PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: 'not-a-number' })).toThrow(/positive integer/);
    expect(() =>
      testFileListTimeoutMs({ PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: String(MAX_TEST_FILE_LIST_TIMEOUT_MS + 1) }),
    ).toThrow(/between 1 and/);
  });

  it('scales the default whole-run budget with the requested file count (gate --related lists)', () => {
    // A handful of files keeps the flat floor.
    expect(defaultTestFileRunTimeoutMs(1)).toBe(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS);
    expect(testFileRunTimeoutMs({}, 3)).toBe(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS);
    // The floor is also the gate's single-file flake-retry budget, and the slowest legitimate
    // single file (apps/operator/scripts/hooks/cc/__tests__/pc-heavy.test.ts, 153 process-spawning
    // tests) took 325s under gate load on 2026-09-06 — a 300s floor reaped it NOT MEASURED. Keep
    // the floor at ten minutes or more unless that file has been made faster.
    expect(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
    // 235 files — the @papercusp/web `--related` list that a flat 300s budget reaped with two
    // files completed on every gate run from 2026-09-04 to 2026-09-06 — gets a proportional
    // ceiling instead of a guaranteed TEST_FILE_NOT_MEASURED exit.
    expect(testFileRunTimeoutMs({}, 235)).toBe(235 * TEST_FILE_RUN_TIMEOUT_PER_FILE_MS);
    expect(testFileRunTimeoutMs({}, 235)).toBeGreaterThan(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS);
    // The router maximum still caps it.
    expect(defaultTestFileRunTimeoutMs(100_000)).toBe(MAX_TEST_FILE_RUN_TIMEOUT_MS);
    // A count that is not a positive integer falls back to the single-file floor.
    expect(defaultTestFileRunTimeoutMs(0)).toBe(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS);
    expect(defaultTestFileRunTimeoutMs(Number.NaN)).toBe(DEFAULT_TEST_FILE_RUN_TIMEOUT_MS);
    // An explicit override always wins, whatever the count.
    expect(testFileRunTimeoutMs({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '540000' }, 235)).toBe(540_000);
  });

  it('publishes and cleans the pc-heavy after-ready marker at the execution boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-file-ready-'));
    const marker = join(dir, 'ready');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cleanup = publishPreemptReadyMarker(marker);
      expect(readFileSync(marker, 'utf8')).toBe(`${process.pid}\n`);
      expect(errorSpy).toHaveBeenCalledWith(`PC_HEAVY_PREEMPT_READY pid=${process.pid}`);
      cleanup?.();
      expect(() => readFileSync(marker, 'utf8')).toThrow();
      cleanup?.();
    } finally {
      errorSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes route refusals point to the supported testing:run surface', () => {
    expect(formatRouteError('requested test file does not exist: missing.test.ts')).toBe(
      'TEST_FILE_ROUTE_ERROR requested test file does not exist: missing.test.ts; ' +
        'For the supported routed test surface, use testing:run { files: [...] }.',
    );
  });

  it('discovers the package cwd/config and rewrites the file relative to that cwd', () => {
    const route = discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/tooldef'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe('src/strict-args.test.ts');
  });

  it('honors negated workspace patterns when resolving package-relative test paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-file-router-workspace-exclude-'));
    try {
      const active = join(root, 'packages', 'active');
      const checkpoint = join(root, 'packages', 'ignored-checkpoint');
      for (const pkg of [active, checkpoint]) {
        mkdirSync(join(pkg, 'lib'), { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: basename(pkg) }));
        writeFileSync(join(pkg, 'vitest.config.ts'), 'export default {};\n');
        writeFileSync(join(pkg, 'lib', 'same.test.ts'), '');
      }
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        workspaces: ['packages/*', '!packages/*-checkpoint'],
      }));

      const route = discoverVitestRoute('lib/same.test.ts', root);
      expect(route.cwd).toBe(active);
      expect(route.requested).toBe(join('lib', 'same.test.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // EI-24442044145393058: the recorded test layer is the ROUTED config's runtime label, so a
  // `*.e2e.test.*` file must reach the package's e2e config or it records as 'unit'.
  it('routes *.e2e.test.* files to the package e2e config, and everything else stays on unit', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-file-router-e2e-'));
    try {
      const withE2e = join(root, 'packages', 'with-e2e');
      const withoutE2e = join(root, 'packages', 'without-e2e');
      for (const pkg of [withE2e, withoutE2e]) {
        mkdirSync(join(pkg, 'lib'), { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: basename(pkg) }));
        writeFileSync(join(pkg, 'vitest.config.ts'), 'export default {};\n');
        writeFileSync(join(pkg, 'lib', 'live.e2e.test.ts'), '');
        writeFileSync(join(pkg, 'lib', 'plain.test.ts'), '');
      }
      writeFileSync(join(withE2e, 'vitest.e2e.config.ts'), 'export default {};\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));

      const e2e = discoverVitestRoute('packages/with-e2e/lib/live.e2e.test.ts', root);
      expect(e2e.cwd).toBe(withE2e);
      expect(e2e.config).toBe('vitest.e2e.config.ts');
      expect(e2e.requested).toBe(join('lib', 'live.e2e.test.ts'));
      expect(discoverVitestRoute('packages/with-e2e/lib/plain.test.ts', root).config).toBe('vitest.config.ts');
      // No e2e config declared: the file keeps its existing unit route rather than failing.
      expect(discoverVitestRoute('packages/without-e2e/lib/live.e2e.test.ts', root).config).toBe('vitest.config.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes the real operator-core e2e suite to its e2e config', () => {
    const route = discoverVitestRoute('packages/operator-core/lib/deployment-position.live.e2e.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'packages/operator-core'));
    expect(route.config).toBe('vitest.e2e.config.ts');
  });

  it('routes supported papercusp-desktop JavaScript tests to Node:test', () => {
    const route = discoverTestRoute('papercusp-desktop/test/build-windows-identity.test.js');
    expect(route.runner).toBe('node');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'papercusp-desktop'));
    expect(route.config).toBeNull();
    expect(route.requested).toBe('test/build-windows-identity.test.js');
  });

  it('routes root maintenance .test.mjs suites to Node:test', () => {
    for (const file of ['scripts/npm-install-safe.test.mjs', 'scripts/cpu-profile.test.mjs']) {
      const route = discoverTestRoute(file);
      expect(route.runner).toBe('node');
      expect(route.cwd).toBe(REPO_ROOT);
      expect(route.config).toBeNull();
      expect(route.requested).toBe(file);
    }
  });

  it('refuses packaged WebdriverIO specs before the root Vitest fallback', async () => {
    const file = 'tools/perf-test/wdio/specs/plan-popup-open.perf.spec.ts';
    expect(() => discoverTestRoute(file)).toThrow(/run npm run test:wdio --prefix tools\/perf-test\/wdio/);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--dry', file])).not.toBe(0);
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('TEST_FILE_ROUTE_ERROR');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('classifies source modules as unsupported rather than test files', () => {
    expect(isTestFilePath('lib/agent-tools/capability/inspect.ts')).toBe(false);
    expect(isTestFilePath('lib/agent-tools/capability/inspect.test.ts')).toBe(true);
    expect(isTestFilePath('papercusp-desktop/test/build-windows-identity.test.js')).toBe(true);
    expect(formatUnsupportedTestInputs(['lib/agent-tools/capability/inspect.ts'])).toContain(
      'NON_TEST  lib/agent-tools/capability/inspect.ts',
    );
  });

  it('does not route source modules into Vitest collection attribution', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main([
        '--dry',
        'packages/operator-core/lib/agent-tools/capability/inspect.ts',
        'packages/operator-core/lib/__tests__/test-file-router.test.ts',
      ]);
      const errors = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(code).toBe(0);
      expect(errors).toContain('TEST_FILE_UNSUPPORTED_INPUT');
      expect(errors).toContain('NON_TEST  packages/operator-core/lib/agent-tools/capability/inspect.ts');
      expect(errors).not.toContain('TEST_FILE_COLLECTION_ATTRIBUTION');
      expect(errors).not.toContain('BROKEN');
      expect(output).toMatch(/TEST_FILE_DRYRUN requested=1 .*matched=1/);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('resolves a release-trace package-relative path to its unique owning workspace', () => {
    const route = discoverVitestRoute('lib/__tests__/check-lint-guard-reachability.test.ts');
    expect(route.absolute).toBe(resolve(REPO_ROOT, 'packages/operator-core/lib/__tests__/check-lint-guard-reachability.test.ts'));
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'packages/operator-core'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe('lib/__tests__/check-lint-guard-reachability.test.ts');
  });

  it('resolves paths relative to a nested repository root without weakening containment', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-file-router-submodule-'));
    try {
      const nested = join(root, 'libs', 'nested');
      const orchestrator = join(nested, 'packages', 'orchestrator');
      const db = join(nested, 'libs', 'db');
      mkdirSync(join(orchestrator, 'src'), { recursive: true });
      mkdirSync(join(db, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ workspaces: ['libs/nested/packages/*', 'libs/nested/libs/db'] }),
      );
      writeFileSync(join(nested, '.git'), 'gitdir: ../.git/modules/nested\n');
      writeFileSync(join(nested, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'libs/db'] }));
      writeFileSync(join(orchestrator, 'package.json'), JSON.stringify({ name: '@fixture/orchestrator' }));
      writeFileSync(join(orchestrator, 'vitest.config.ts'), 'export default {};\n');
      writeFileSync(join(orchestrator, 'src', 'route.test.ts'), '');
      writeFileSync(join(db, 'package.json'), JSON.stringify({ name: '@fixture/db' }));
      writeFileSync(join(db, 'vitest.config.ts'), 'export default {};\n');
      writeFileSync(join(db, 'src', 'connection-cache.test.ts'), '');

      for (const [stalePath, workspace, requested] of [
        ['packages/orchestrator/src/route.test.ts', orchestrator, 'src/route.test.ts'],
        ['libs/db/src/connection-cache.test.ts', db, 'src/connection-cache.test.ts'],
      ]) {
        const stale = discoverVitestRoute(stalePath, root);
        expect(stale.absolute).toBe(join(workspace, requested));
        expect(stale.cwd).toBe(workspace);
        expect(stale.requested).toBe(requested);
      }

      const outside = join(root, '..', `${basename(root)}-outside.test.ts`);
      writeFileSync(outside, '');
      expect(() => discoverVitestRoute(`../${basename(outside)}`, root)).toThrow(/outside the repository/);
      rmSync(outside, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an ambiguous path spanning a nested repository and a root workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-file-router-nested-ambiguity-'));
    try {
      const nested = join(root, 'libs', 'nested');
      const nestedWorkspace = join(nested, 'packages', 'shared');
      const rootWorkspace = join(root, 'packages', 'root-owner');
      mkdirSync(join(nestedWorkspace, 'src'), { recursive: true });
      writeFileSync(join(nestedWorkspace, 'package.json'), JSON.stringify({ name: nestedWorkspace }));
      writeFileSync(join(nestedWorkspace, 'vitest.config.ts'), 'export default {};\n');
      writeFileSync(join(nestedWorkspace, 'src', 'same.test.ts'), '');
      mkdirSync(join(rootWorkspace, 'packages', 'shared', 'src'), { recursive: true });
      writeFileSync(join(rootWorkspace, 'package.json'), JSON.stringify({ name: rootWorkspace }));
      writeFileSync(join(rootWorkspace, 'vitest.config.ts'), 'export default {};\n');
      writeFileSync(join(rootWorkspace, 'packages', 'shared', 'src', 'same.test.ts'), '');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'libs/nested/packages/*'] }));
      writeFileSync(join(nested, '.git'), 'gitdir: ../.git/modules/nested\n');
      writeFileSync(join(nested, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));

      expect(() => discoverVitestRoute('packages/shared/src/same.test.ts', root)).toThrow(
        /ambiguous across workspaces.*libs\/nested\/packages\/shared.*packages\/root-owner\/packages\/shared/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an ambiguous package-relative path instead of choosing a workspace arbitrarily', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-file-router-workspaces-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      for (const name of ['first', 'second']) {
        const dir = join(root, 'packages', name);
        mkdirSync(join(dir, 'lib'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${name}` }));
        writeFileSync(join(dir, 'vitest.config.ts'), 'export default {};\n');
        writeFileSync(join(dir, 'lib', 'same.test.ts'), '');
      }

      expect(() => discoverVitestRoute('lib/same.test.ts', root)).toThrow(
        /ambiguous across workspaces.*packages\/first.*packages\/second/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // EI-18822211427354845: every group used to receive the SAME `--outputFile`, so each
  // group's report overwrote the previous one and only the last survived — the caller
  // then reported one group as the whole run (`failed:0, failures:[]` for a red tree).
  describe('per-group report paths (EI-18822211427354845)', () => {
    const args = ['--reporter=json', '--outputFile=/tmp/x/report.json'];

    it('leaves a single-group run byte-identical to the caller request', () => {
      expect(perGroupVitestArgs(args, 0, 1)).toEqual(args);
    });

    it('keeps group 0 on the original path so a not-yet-deployed consumer still finds it', () => {
      // Load-bearing for the rollout: the router is spawned from the working tree
      // immediately, its consumer only goes live on the next deploy.
      expect(perGroupVitestArgs(args, 0, 3)).toEqual(args);
    });

    it('gives every later group a DISTINCT path so no group can overwrite another', () => {
      expect(perGroupVitestArgs(args, 1, 3)).toEqual(['--reporter=json', '--outputFile=/tmp/x/report.1.json']);
      expect(perGroupVitestArgs(args, 2, 3)).toEqual(['--reporter=json', '--outputFile=/tmp/x/report.2.json']);
      const paths = [0, 1, 2].map((i) => perGroupVitestArgs(args, i, 3).join(' '));
      expect(new Set(paths).size).toBe(3);
    });

    it('handles the two-arg form and an extensionless path', () => {
      expect(perGroupVitestArgs(['--outputFile', '/tmp/x/report.json'], 1, 2))
        .toEqual(['--outputFile', '/tmp/x/report.1.json']);
      expect(perGroupVitestArgs(['--outputFile=/tmp/x/report'], 1, 2))
        .toEqual(['--outputFile=/tmp/x/report.1.json']);
    });

    it('never splits a DOTTED DIRECTORY in the middle', () => {
      expect(perGroupVitestArgs(['--outputFile=/tmp/my.dir/report'], 1, 2))
        .toEqual(['--outputFile=/tmp/my.dir/report.1.json']);
    });

    it('passes unrelated vitest args through untouched', () => {
      expect(perGroupVitestArgs(['-t', 'my test', '--reporter=json'], 1, 2))
        .toEqual(['-t', 'my test', '--reporter=json']);
    });

    it('isolates source-map OUT with the same naming rule while preserving the shared RESULT sink', () => {
      const env = Object.freeze({ PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/my.dir/sources',
        PC_EXECUTED_SOURCE_MAP_RESULT: '/tmp/result.jsonl', PAPERCUSP_TEST_RUN_RECEIPT_FILE: '/tmp/receipt.jsonl' });
      const children = [0, 1, 2].map(index => perGroupVitestEnv(env, index, 3));
      expect(children.map(child => child.PC_EXECUTED_SOURCE_MAP_OUT))
        .toEqual(['/tmp/my.dir/sources', '/tmp/my.dir/sources.1.json', '/tmp/my.dir/sources.2.json']);
      for (const child of children) {
        expect(child.PC_EXECUTED_SOURCE_MAP_RESULT).toBe(env.PC_EXECUTED_SOURCE_MAP_RESULT);
        expect(child.PAPERCUSP_TEST_RUN_RECEIPT_FILE).toBe(env.PAPERCUSP_TEST_RUN_RECEIPT_FILE);
      }
      expect(env.PC_EXECUTED_SOURCE_MAP_OUT).toBe('/tmp/my.dir/sources');
      expect(perGroupVitestEnv({ PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/sources.json' }, 0, 1)
        .PC_EXECUTED_SOURCE_MAP_OUT).toBe('/tmp/sources.json');
      expect(perGroupVitestEnv({ PC_EXECUTED_SOURCE_MAP_OUT: 'sources.json' }, 1, 3)
        .PC_EXECUTED_SOURCE_MAP_OUT).toBe(resolve('sources.1.json'));
      const unarmed = { PC_EXECUTED_SOURCE_MAP_OUT: ' ' };
      expect(perGroupVitestEnv(unarmed, 1, 3)).toBe(unarmed);
      expect(perGroupVitestEnv({}, 1, 3)).toEqual({});
    });

    it('preserves each source-map group and detail rerun output through main()', async () => {
      const root = mkdtempSync(join(tmpdir(), 'source-map-groups-'));
      const originalOut = join(root, 'sources.json');
      const files = ['one/a.test.ts', 'one/b.test.ts', 'two/c.test.ts', 'three/d.test.ts'];
      const saved = { PC_EXECUTED_SOURCE_MAP_OUT: process.env.PC_EXECUTED_SOURCE_MAP_OUT,
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE };
      process.env.PC_EXECUTED_SOURCE_MAP_OUT = originalOut;
      delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const captures: Array<{ path: string; files: string[] }> = [];
      try {
        for (const dir of ['one', 'two', 'three']) {
          mkdirSync(join(root, dir));
          writeFileSync(join(root, dir, 'vitest.config.ts'), 'export default {};');
        }
        for (const file of files) writeFileSync(join(root, file), '');
        const code = await main(files, {
          repoRoot: root,
          restrictedHoldPreflightImpl: () => ({ verdict: 'skip' }),
          runVitestListImpl: async (_command: string, args: string[]) => ({ status: 0, signal: null,
            stdout: args.filter(arg => arg.endsWith('.test.ts')).join('\n'), stderr: '', timedOut: false }),
          runCapturedTestProcessImpl: async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
            const requested = args.filter(arg => arg.endsWith('.test.ts'));
            const path = options.env.PC_EXECUTED_SOURCE_MAP_OUT!;
            captures.push({ path, files: requested });
            writeFileSync(path, JSON.stringify(requested));
            const failed = requested.length === 2;
            return { status: failed ? 1 : 0, signal: null, timedOut: false, stderr: '',
              stdout: failed ? '❯ a.test.ts (0 test)\n❯ b.test.ts (0 test)\nTest Files 2 failed (2)\n'
                : 'Test Files 1 passed (1)\nTests 1 passed (1)\n' };
          },
        });
        expect(code).toBe(1); // The first group's red must survive the later green groups.
        expect(captures.map(capture => capture.path)).toEqual([originalOut,
          join(root, 'sources.detail-0.json'), join(root, 'sources.detail-1.json'),
          join(root, 'sources.1.json'), join(root, 'sources.2.json')]);
        for (const capture of captures) {
          expect(JSON.parse(readFileSync(capture.path, 'utf8'))).toEqual(capture.files);
          expect(logSpy.mock.calls.some(([line]) => String(line).includes(`path=${JSON.stringify(capture.path)}`))).toBe(true);
        }
        expect(JSON.parse(readFileSync(originalOut, 'utf8'))).toEqual(['a.test.ts', 'b.test.ts']);
        expect(process.env.PC_EXECUTED_SOURCE_MAP_OUT).toBe(originalOut);
      } finally {
        logSpy.mockRestore(); errorSpy.mockRestore(); stdoutSpy.mockRestore();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('strips --outputFile for the detail-recovery re-runs, in both arg forms', () => {
      // Those re-run individual files only to print detail; keeping the path would
      // clobber the group's real report with a single file's results.
      expect(withoutOutputFileArg(args)).toEqual(['--reporter=json']);
      expect(withoutOutputFileArg(['--outputFile', '/tmp/x/report.json', '--reporter=json']))
        .toEqual(['--reporter=json']);
    });
  });

  it('groups only files sharing one cwd and config', () => {
    const routes = [
      discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts'),
      discoverVitestRoute('packages/operator-core/lib/search/self-session.test.ts'),
    ];
    expect(groupRoutes(routes)).toHaveLength(2);
  });

  it('keeps Node:test and Vitest routes in separate groups even when config is null', () => {
    const nodeRoute = discoverTestRoute('papercusp-desktop/test/build-windows-identity.test.js');
    const vitestRoute = { ...nodeRoute, runner: undefined, cwd: resolve(REPO_ROOT, 'some-vitest-package') };
    expect(groupRoutes([nodeRoute, vitestRoute])).toHaveLength(2);
  });

  it('extracts the distinct files Vitest says it will execute and ignores process warnings', () => {
    const cwd = resolve(REPO_ROOT, 'libs/generic/tooldef');
    expect(listedFiles('(node:1) Warning: irrelevant\nsrc/a.test.ts > suite > one\nsrc/a.test.ts > suite > two\nsrc/b.test.ts > suite', cwd)).toEqual([
      resolve(cwd, 'src/a.test.ts'),
      resolve(cwd, 'src/b.test.ts'),
    ]);
  });

  it('extracts skipped-only files from Vitest filesOnly output', () => {
    const cwd = resolve(REPO_ROOT, 'packages/operator-core');
    expect(listedFiles('lib/agent-tools/computer/computer-live.test.ts\n', cwd, true)).toEqual([
      resolve(cwd, 'lib/agent-tools/computer/computer-live.test.ts'),
    ]);
  });

  it('extracts named-project file listings without treating project labels as paths', () => {
    const cwd = resolve(REPO_ROOT, 'apps/operator-public');
    const output = '[treasury-integration] src/__tests__/treasury.test.ts\n' +
      '[unit] src/__tests__/settlements.test.ts\n' +
      '[another project] src/__tests__/treasury.test.ts\n' +
      '[warning] irrelevant process warning\n';
    expect(listedFiles(output, cwd, true)).toEqual([
      resolve(cwd, 'src/__tests__/treasury.test.ts'),
      resolve(cwd, 'src/__tests__/settlements.test.ts'),
    ]);
  });

  it('extracts named-project tree listings through the same canonical path format', () => {
    const cwd = resolve(REPO_ROOT, 'apps/operator-public');
    const output = '[treasury-integration] src/__tests__/treasury.test.ts > suite > case\n';
    expect(listedFiles(output, cwd, true)).toEqual([resolve(cwd, 'src/__tests__/treasury.test.ts')]);
    expect(listedFiles(output, cwd)).toEqual([resolve(cwd, 'src/__tests__/treasury.test.ts')]);
  });

  it('keeps the filesOnly parser compatible with Vitest tree-shaped test stubs', () => {
    const cwd = resolve(REPO_ROOT, 'packages/operator-core');
    expect(listedFiles('lib/a.test.ts > suite > skipped test\n', cwd, true)).toEqual([
      resolve(cwd, 'lib/a.test.ts'),
    ]);
  });

  // EI-21108362231170830: an explicit Vitest path can also list a matching test from a sibling
  // frozen candidate under `.papercusp/worktrees/`. Only the canonical requested path may be
  // passed to the subsequent `vitest run`; otherwise the duplicate suite executes too.
  it('filters matching sibling worktree paths out of the exact execution set', () => {
    const canonical = resolve(REPO_ROOT, 'packages/operator-core/lib/agent-tools/docs/_guidance-adapter.live.test.ts');
    const sibling = resolve(
      REPO_ROOT,
      '.papercusp/worktrees/green-candidate-papercusp-06d8c9478aef/packages/operator-core/lib/agent-tools/docs/_guidance-adapter.live.test.ts',
    );
    const routes = [{ absolute: canonical, requested: 'lib/agent-tools/docs/_guidance-adapter.live.test.ts' }];

    expect(canonicalMatch(routes, [sibling, canonical])).toEqual([canonical]);
  });

  it('rejects a missing request before running Vitest', () => {
    expect(() => discoverVitestRoute('libs/generic/tooldef/src/no-such.test.ts')).toThrow(/does not exist/);
  });

  // EI-14278: a config-less Vitest package must route to its own cwd. Keep
  // the fixture isolated: maintained generic packages can gain explicit configs.
  it('routes a config-less libs/generic/* package to its own cwd with config: null', () => {
    const root = mkdtempSync(join(tmpdir(), 'router-configless-package-'));
    const pkg = join(root, 'libs/generic/fixture');
    try {
      mkdirSync(join(pkg, 'src'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
      writeFileSync(join(pkg, 'src/index.test.ts'), '');
      writeFileSync(join(root, 'vitest.config.ts'), 'export default {};');
      const file = 'libs/generic/fixture/src/index.test.ts';
      expect(discoverVitestRoute(file, root)).toMatchObject({
        cwd: pkg, config: null, requested: 'src/index.test.ts',
      });
      // Adding a package config must take precedence over its own fallback.
      writeFileSync(join(pkg, 'vitest.config.ts'), 'export default {};');
      expect(discoverVitestRoute(file, root)).toMatchObject({
        cwd: pkg, config: 'vitest.config.ts', requested: 'src/index.test.ts',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still prefers an explicit vitest.config.* over the config-less package fallback', () => {
    // tooldef HAS its own config — the fallback must not shadow it.
    const route = discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts');
    expect(route.config).toBe('vitest.config.ts');
  });

  it('routes mobile fixture files from shipped templates/ to template-kit', () => {
    const route = discoverVitestRoute(
      'templates/papercusp-android-app/checks/composition-integrity.fixture.test.ts',
    );
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/template-kit'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe(
      '../../../templates/papercusp-android-app/checks/composition-integrity.fixture.test.ts',
    );
  });

  it('routes the operation-first reference guard to template-kit instead of root mirror discovery', () => {
    const route = discoverVitestRoute('templates/papercusp-ops-pots/checks/operation-first-triggers.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/template-kit'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe('../../../templates/papercusp-ops-pots/checks/operation-first-triggers.test.ts');
  });

  it('routes papercusp-app composition checks to template-kit instead of root discovery', () => {
    const route = discoverVitestRoute('templates/papercusp-app/checks/composition-integrity.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/template-kit'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe('../../../templates/papercusp-app/checks/composition-integrity.test.ts');
  });
});

describe('governed admission refusal classification (EI-21984099786606751)', () => {
  it('keeps retryable database contention distinct from other pre-launch failures', () => {
    expect(classifyGovernedAdmissionFailure({ pgCode: '57014' })).toBe('admission-starved');
    expect(classifyGovernedAdmissionFailure({ pgCode: '55P03' })).toBe('admission-starved');
    expect(classifyGovernedAdmissionFailure({ pgCode: 'XX000' })).toBe('undetermined');
  });
});

// P-009 / WI-4534: the false-green refusal. A raw `vitest run <paths>` reports success while
// silently skipping what you asked for — exit 0 on a PARTIAL match (asked 3, ran 2), and exit 0
// on a ZERO match under --passWithNoTests. evaluateMatch is the guard that turns both into a hard
// error by comparing REQUESTED against what `vitest list` actually resolved. These pin that guard,
// which shipped with no regression test (WI-4534 was resolved verifiedHow:'already-passing').
describe('evaluateMatch — the false-green refusal (P-009)', () => {
  const A = '/repo/pkg/a.test.ts';
  const B = '/repo/pkg/b.test.ts';
  const routes = [
    { absolute: A, requested: 'a.test.ts' },
    { absolute: B, requested: 'b.test.ts' },
  ];

  it('accepts a run only when EVERY requested file resolved to a listed test', () => {
    const v = evaluateMatch({ routes, matched: [A, B], listStatus: 0 });
    expect(v.ok).toBe(true);
    expect(v.unmatched).toEqual([]);
    expect(v).toMatchObject({ requested: 2, matched: 2 });
  });

  it('REFUSES a partial match (asked 2, one resolved) — the silent-narrowing vitest exits 0 on', () => {
    const v = evaluateMatch({ routes, matched: [A], listStatus: 0 });
    expect(v.ok).toBe(false);
    expect(v.unmatched).toEqual([{ absolute: B, requested: 'b.test.ts' }]);
  });

  it('REFUSES a zero match (nothing resolved) — the empty run --passWithNoTests would exit 0 on', () => {
    const v = evaluateMatch({ routes, matched: [], listStatus: 0 });
    expect(v.ok).toBe(false);
    expect(v.unmatched).toHaveLength(2);
    expect(v.matched).toBe(0);
  });

  it('REFUSES when `vitest list` itself errored, even if the resolved set looks complete', () => {
    expect(evaluateMatch({ routes, matched: [A, B], listStatus: 1 }).ok).toBe(false);
  });

  it('accepts a single-file request that resolved', () => {
    const one = [{ absolute: A, requested: 'a.test.ts' }];
    expect(evaluateMatch({ routes: one, matched: [A], listStatus: 0 }).ok).toBe(true);
  });
});

describe('workspace test launcher — explicit paths use the owning-config guard', () => {
  it('routes a mixed workspace request instead of letting Vitest silently narrow it', () => {
    const invocation = workspaceTestInvocation([
      '--passWithNoTests',
      'lib/agent-tools/release/checkpoint-run.test.ts',
      'lib/release/green-checkpoint.test.ts',
    ]);

    expect(invocation).toMatchObject({ command: process.execPath, routed: true });
    // WI-10005802: the router starts under the committed-source loader, so its own code runs HEAD bytes.
    expect(invocation.args).toEqual([
      '--import',
      resolve(REPO_ROOT, 'scripts/lib/committed-source-loader.mjs'),
      resolve(REPO_ROOT, 'scripts/test-files.mjs'),
      'lib/agent-tools/release/checkpoint-run.test.ts',
      'lib/release/green-checkpoint.test.ts',
    ]);
  });

  it('keeps no-file workspace runs on the package\'s full-suite Vitest command', () => {
    expect(workspaceTestInvocation(['--passWithNoTests'])).toMatchObject({
      command: 'npx',
      args: ['vitest', 'run', '--passWithNoTests'],
      routed: false,
    });
  });

  it('uses the integration config for a full suite and the owning-config guard for a focused file', () => {
    expect(workspaceTestInvocation(['--workspace-integration']).args).toEqual([
      'vitest', 'run', '--config', 'vitest.integration.config.ts',
    ]);
    expect(workspaceTestInvocation([
      '--workspace-integration', 'lib/release/green-checkpoint-watchdog.integration.test.ts',
    ])).toMatchObject({
      routed: true,
      args: [
        '--import',
        resolve(REPO_ROOT, 'scripts/lib/committed-source-loader.mjs'),
        resolve(REPO_ROOT, 'scripts/test-files.mjs'),
        'lib/release/green-checkpoint-watchdog.integration.test.ts',
      ],
    });
  });

  it('reports an unset parent harness without predicting the reporter ledger scope', () => {
    // The child reporter can receive its scope after the parent checks its env.
    // A missing parent pin cannot establish a NULL harness in the ledger.
    for (const env of [{}, { PAPERCUSP_TEST_RUN_HARNESS: '   ' }]) {
      const warning = unscopedFocusedRunWarning(env);
      expect(warning).toContain('scope is unverified');
      expect(warning).toContain('authoritative testing:runs row');
      expect(warning).not.toContain('is unscoped');
      expect(warning).not.toContain('cannot be bound');
    }
    expect(unscopedFocusedRunWarning({ PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' })).toBeNull();
  });
});

describe('vitestRunFailed — exit code and summary must agree (EI-21124682504777505)', () => {
  it('refuses an exit-0 run whose Vitest summary reports failed files or tests', () => {
    const output =
      ' Test Files  2 failed | 3 passed (5)\n' +
      '      Tests  4 failed | 20 passed (24)\n';
    expect(vitestRunFailed({ status: 0, output })).toBe(true);
  });

  it('handles Vitest ANSI-colored failure summaries', () => {
    const E = String.fromCharCode(27);
    const output =
      `${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m (1)\n` +
      `${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m (1)\n`;
    expect(vitestRunFailed({ status: 0, output })).toBe(true);
  });

  it('accepts a clean exit-0 summary and preserves nonzero process failures', () => {
    expect(vitestRunFailed({
      status: 0,
      output: ' Test Files  5 passed (5)\n      Tests  24 passed (24)\n',
    })).toBe(false);
    expect(vitestRunFailed({ status: 1, output: 'worker crashed before summary\n' })).toBe(true);
  });
});

describe('Vitest worker termination warning is a finalization error', () => {
  it('recognizes pool timeout and failed-termination diagnostics but ignores ordinary output', () => {
    expect(hasVitestWorkerTerminationWarning(
      '[vitest-pool]: Timeout terminating forks worker for test files x.test.ts.\n',
    )).toBe(true);
    expect(hasVitestWorkerTerminationWarning(
      '\u001b[31m[vitest-pool]: Failed to terminate forks worker for test files x.test.ts.\u001b[39m',
    )).toBe(true);
    expect(hasVitestWorkerTerminationWarning(
      'Tests 1 passed (1)\nA test title mentions Timeout terminating forks worker.\n',
    )).toBe(false);
  });
});

describe('collection child identity evidence (WI-10007991)', () => {
  it('retains only bounded identities from the owned tree without reading argv or scanning the host', () => {
    const readFileImpl = vi.fn((path: string) => {
      if (path.endsWith('/children')) return path.includes('/4100/') ? '4101 4102' : '';
      if (path.endsWith('/status')) return 'Name:\tnpm exec vitest\nState:\tS (sleeping)\nPPid:\t4000\n';
      if (path.endsWith('/wchan')) return 'do_wait\n';
      throw new Error('unexpected read');
    });
    const readdirImpl = vi.fn((path: string) => [path.split('/')[2]]);
    expect(readTestChildDiagnostic(4100, { readFileImpl, readdirImpl })).toMatchObject({
      status: 'measured', rootPid: 4100, truncated: false, unreadableFields: 0,
      processes: [4100, 4101, 4102].map(pid => ({ pid, parentPid: 4000,
        name: 'npm exec vitest', state: 'S', waitChannel: 'do_wait' })),
    });
    expect(readdirImpl.mock.calls.every(([path]) => /^\/proc\/410[012]\/task$/.test(path))).toBe(true);
    expect(readFileImpl.mock.calls.some(([path]) => /cmdline|environ/.test(path))).toBe(false);
  });

  it('caps both tree residents and per-process task reads and marks the omitted population', () => {
    const readFileImpl = vi.fn((path: string) => {
      if (path.endsWith('/children')) return Array.from({ length: 30 }, (_, i) => String(4201 + i)).join(' ');
      return path.endsWith('/wchan') ? '0' : 'Name:\tnode\nState:\tR (running)\nPPid:\t4200\n';
    });
    const readdirImpl = vi.fn(() => Array.from({ length: 80 }, (_, i) => String(4200 + i)));
    const snapshot = readTestChildDiagnostic(4200, { readFileImpl, readdirImpl });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.processes).toHaveLength(16);
    expect(snapshot.processes[0].waitChannel).toBeNull();
    expect(readFileImpl.mock.calls.filter(([path]) => path.endsWith('/children'))).toHaveLength(16 * 32);
    expect(readdirImpl).not.toHaveBeenCalledWith('/proc');
  });

  it('preserves unknowns when procfs is unreadable rather than claiming an empty healthy tree', () => {
    const unavailable = () => { throw new Error('EACCES'); };
    expect(readTestChildDiagnostic(4300, { readFileImpl: unavailable, readdirImpl: unavailable })).toMatchObject({
      status: 'partial', unreadableFields: 3,
      processes: [{ pid: 4300, parentPid: null, name: null, state: null, waitChannel: null }],
    });
    expect(readTestChildDiagnostic(undefined)).toMatchObject({ status: 'unavailable', processes: [] });
  });

  it('retains blocked-child IO mechanisms before reap without opening file contents (EI-25918888568694335)', () => {
    const readFileImpl = vi.fn((path: string) => {
      if (path.endsWith('/children')) return '';
      if (path.endsWith('/status')) return 'Name:\tnode\nState:\tD (disk sleep)\nPPid:\t4000\n';
      if (path.endsWith('/wchan')) return 'folio_wait_bit_common\n';
      if (path.endsWith('/io')) return 'rchar: 9007199254740993\nwchar: 0\nsyscr: 2\nsyscw: 0\nread_bytes: 8192\nwrite_bytes: 0\n';
      if (path.endsWith('/syscall')) return '17 0x7 0xabcd 0x1000 0x0 0x0 0x0 0xffff 0xeeee\n';
      if (path.endsWith('/stack')) return '[<0>] folio_wait_bit_common+0x10/0x20\n[<0>] filemap_read+0x12/0x20\n';
      throw new Error('must not open the blocked descriptor, cmdline or environ');
    });
    const readdirImpl = vi.fn((path: string) => path.endsWith('/task') ? ['4310'] : ['8', '7']);
    const readlinkImpl = vi.fn((path: string) => path.endsWith('/7') ? '/repo/node_modules/vitest/module.mjs' : 'pipe:[123]');
    const snapshot = readTestChildDiagnostic(4310, { readFileImpl, readdirImpl, readlinkImpl });
    expect(snapshot).toMatchObject({ status: 'measured', unreadableFields: 0, truncated: false,
      processes: [{ pid: 4310, state: 'D', blockedIo: { status: 'measured', scope: 'single-snapshot',
        io: { rchar: '9007199254740993', read_bytes: '8192' },
        syscall: { number: 17, arguments: ['0x7', '0xabcd', '0x1000', '0x0', '0x0', '0x0'],
          stackPointer: '0xffff', instructionPointer: '0xeeee' },
        kernelStack: ['folio_wait_bit_common', 'filemap_read'],
        files: [{ fd: 7, path: '/repo/node_modules/vitest/module.mjs', kind: 'path' },
          { fd: 8, path: null, kind: 'pipe' }], unavailable: [], truncated: false } }] });
    expect(readlinkImpl.mock.calls.map(([path]) => path)).toEqual(['/proc/4310/fd/7', '/proc/4310/fd/8']);
    expect(readFileImpl.mock.calls.every(([path]) => /^\/proc\/4310\/(task\/4310\/children|status|wchan|io|syscall|stack)$/.test(path))).toBe(true);
  });

  it('keeps denied blocked-child evidence explicitly unknown', () => {
    const readFileImpl = (path: string) => {
      if (path.endsWith('/children')) return '';
      if (path.endsWith('/status')) return 'Name:\tnode\nState:\tD (disk sleep)\nPPid:\t4000\n';
      if (path.endsWith('/wchan')) return 'folio_wait_bit_common';
      throw new Error('EACCES');
    };
    const readdirImpl = (path: string) => {
      if (path.endsWith('/task')) return ['4320'];
      throw new Error('EACCES');
    };
    expect(readTestChildDiagnostic(4320, { readFileImpl, readdirImpl })).toMatchObject({
      status: 'partial', unreadableFields: 4, processes: [{ blockedIo: {
        status: 'partial', syscall: null, kernelStack: null, files: null,
        io: { rchar: null, read_bytes: null }, unavailable: ['io', 'syscall', 'kernelStack', 'files'] } }],
    });
  });

  it('bounds blocked IO details and rejects malformed syscall text without retaining it', () => {
    const readFileImpl = (path: string) => {
      if (path.endsWith('/children')) return path.includes('/4330/') ? '4331 4332 4333 4334' : '';
      if (path.endsWith('/status')) return 'Name:\tnode\nState:\tD (disk sleep)\nPPid:\t4330\n';
      if (path.endsWith('/wchan')) return 'folio_wait_bit_common';
      if (path.endsWith('/io')) return 'rchar: 1\nwchar: 2\nsyscr: 3\nsyscw: 4\nread_bytes: 5\nwrite_bytes: 6';
      if (path.endsWith('/syscall')) return 'malformed-secret-must-not-be-retained';
      return Array.from({ length: 30 }, () => '[<ffffffff>] filemap_read+0x1/0x2').join('\n');
    };
    const readdirImpl = vi.fn((path: string) => path.endsWith('/task') ? [path.split('/')[2]]
      : Array.from({ length: 50 }, (_, i) => String(i)));
    const readlinkImpl = vi.fn(() => '/repo/' + 'a'.repeat(500));
    const snapshot = readTestChildDiagnostic(4330, { readFileImpl, readdirImpl, readlinkImpl });
    expect(snapshot.status).toBe('partial');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.processes[0].blockedIo).toMatchObject({ syscall: null, unavailable: ['syscall'], truncated: true });
    expect(snapshot.processes[0].blockedIo.kernelStack).toHaveLength(8);
    expect(snapshot.processes[0].blockedIo.files).toHaveLength(8);
    expect(snapshot.processes[0].blockedIo.files[0].path.length).toBeLessThanOrEqual(161);
    expect(snapshot.processes[4].blockedIo).toEqual({ status: 'unavailable', reason: 'blocked-detail-cap', scope: 'single-snapshot' });
    expect(readlinkImpl).toHaveBeenCalledTimes(4 * 8);
    expect(JSON.stringify(snapshot)).not.toContain('malformed-secret');
    expect(readdirImpl).not.toHaveBeenCalledWith('/proc');
  });

  it('calibrates the pre-reap evidence guard against a permanently disabled-reader control', async () => {
    // The same behavioral guard must accept the real runner and reject this
    // deliberately wrong wrapper; no mutation of the shared source is needed.
    const omitDiagnostic = (command: string, args: string[], options: object) =>
      runVitestList(command, args, { ...options, readProcessDiagnosticImpl: null });
    vi.useFakeTimers();
    try {
      for (const [run, shouldPass] of [[runVitestList, true], [omitDiagnostic, false]] as const) {
        const child = Object.assign(new EventEmitter(), { pid: 4350,
          stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
        const events: string[] = [];
        const snapshot = { status: 'partial', rootPid: 4350,
          processes: [{ pid: 4350, name: 'vitest', state: 'D', waitChannel: 'folio_wait_bit_common',
            blockedIo: { status: 'partial', scope: 'single-snapshot', syscall: null,
              kernelStack: ['filemap_read'], files: [{ fd: 7, path: '/repo/module.mjs', kind: 'path' }] } }] };
        const pending = run('npx', ['vitest', 'list', '--filesOnly', 'a.test.ts'], {
          env: { PATH: '/usr/bin' }, timeoutMs: 100, killGraceMs: 20,
          systemdRunPath: null, setsidPath: '/usr/bin/setsid',
          spawnImpl: () => child, onProgress: () => {},
          readProcessDiagnosticImpl: () => { events.push('snapshot'); return snapshot; },
          killProcessImpl: (_child: unknown, signal: string) => { events.push(signal); return 'group'; },
        });
        await vi.advanceTimersByTimeAsync(120);
        child.emit('close', null, 'SIGKILL');
        const result = await pending;
        const assertEvidence = () => {
          expect(result.processDiagnostic).toEqual(snapshot);
          expect(events.indexOf('snapshot')).toBeGreaterThanOrEqual(0);
          expect(events.indexOf('snapshot')).toBeLessThan(events.indexOf('SIGTERM'));
        };
        if (shouldPass) assertEvidence();
        else expect(assertEvidence).toThrow();
      }
    } finally { vi.useRealTimers(); }
  });
});

describe('bounded observable Vitest child execution (EI-21400813289605169)', () => {
  it.each(['stdout', 'stderr'] as const)('retains worker-startup evidence from chunked %s before exit (EI-26268916098999544)', async (channel) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4350, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const snapshot = { status: 'partial', rootPid: child.pid,
      processes: [{ pid: child.pid, name: 'node', state: 'S', waitChannel: null }] };
    const reader = vi.fn(() => snapshot);
    const progress: string[] = [];
    const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
      cwd: '/repo', files: ['a.test.ts'], env: { PATH: '/usr/bin' },
      systemdRunPath: null, setsidPath: null, spawnImpl: () => child,
      readProcessDiagnosticImpl: reader, onProgress: (line: string) => progress.push(line),
      governedProcessImpl: (_options: unknown, run: Function) => run(undefined, undefined, { inherited: true }),
    });
    child[channel].write('[vitest-pool]: Failed to sta');
    expect(reader).not.toHaveBeenCalled();
    child[channel].write('rt forks worker for test files a.test.ts.\n');
    child[channel].write('[vitest-pool]: Failed to start forks worker for test files a.test.ts.\n');
    const diagnostics = progress.filter(line => line.startsWith('TEST_FILE_CHILD_DIAGNOSTIC '));
    // The failure comes from Vitest before the router's watchdog, so evidence
    // must already exist while the owned child tree is still inspectable.
    try {
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(child.pid);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('"trigger":"worker-startup"');
      expect(child.kill).not.toHaveBeenCalled();
    } finally { child.emit('close', 1, null); }
    const result = await pending;
    expect(result).toMatchObject({ status: 1, signal: null, timedOut: false, processDiagnostic: snapshot });
    expect(result[channel]).toContain('Failed to start forks worker');
  });

  it.each(['unavailable', 'disabled'] as const)('preserves a startup failure with a %s diagnostic reader (EI-26268916098999544)', async (mode) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4350, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
      cwd: '/repo', files: ['a.test.ts'], env: { PATH: '/usr/bin' },
      systemdRunPath: null, setsidPath: null, spawnImpl: () => child,
      readProcessDiagnosticImpl: mode === 'disabled' ? null : () => { throw new Error('EACCES'); },
      onProgress: () => {},
      governedProcessImpl: (_options: unknown, run: Function) => run(undefined, undefined, { inherited: true }),
    });
    child.stderr.write('[vitest-pool]: Failed to start forks worker for test files a.test.ts.\n');
    child.emit('close', 1, null);
    const result = await pending;
    expect(result).toMatchObject({ status: 1, signal: null, timedOut: false });
    expect(result.processDiagnostic).toEqual(mode === 'disabled' ? null :
      { status: 'unavailable', reason: 'reader-error', processes: [], truncated: false });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not classify ordinary assertion output as a worker-startup failure (EI-26268916098999544)', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4350, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const reader = vi.fn();
    const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
      cwd: '/repo', files: ['a.test.ts'], env: { PATH: '/usr/bin' },
      systemdRunPath: null, setsidPath: null, spawnImpl: () => child,
      readProcessDiagnosticImpl: reader, onProgress: () => {},
      governedProcessImpl: (_options: unknown, run: Function) => run(undefined, undefined, { inherited: true }),
    });
    child.stderr.write('AssertionError: Failed to start test server\n');
    child.emit('close', 1, null);
    expect((await pending).processDiagnostic).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(['available', 'unavailable', 'default', 'disabled'] as const)(
    'retains bounded worker-termination evidence before exit with a %s reader (EI-25678025879775952)', async (mode) => {
      const child = Object.assign(new EventEmitter(), {
        pid: process.pid, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      const snapshot = { status: 'partial', rootPid: child.pid,
        processes: [{ pid: child.pid, name: 'node', state: 'S', waitChannel: null }] };
      const reader = vi.fn(() => {
        if (mode === 'unavailable') throw new Error('EACCES');
        return snapshot;
      });
      const progress: string[] = [];
      const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
        cwd: '/repo', files: ['a.test.ts'], env: { PATH: '/usr/bin' },
        systemdRunPath: null, setsidPath: null,
        spawnImpl: () => child,
        ...(mode === 'default' ? {} : { readProcessDiagnosticImpl: mode === 'disabled' ? null : reader }),
        onProgress: (line: string) => progress.push(line),
        governedProcessImpl: (_governedOptions: unknown, run: Function) =>
          run(undefined, undefined, { inherited: true }),
      });
      child.stdout.write(' ❯ a.test.ts (1 test | 1 failed) 1ms\n');
      child.stderr.write('[vitest-pool]: Timeout term');
      expect(reader).not.toHaveBeenCalled();
      child.stderr.write('inating forks worker for test files a.test.ts.\n');
      child.stderr.write('[vitest-pool]: Failed to terminate forks worker for test files a.test.ts.\n');
      const diagnostics = progress.filter((line) => line.startsWith('TEST_FILE_CHILD_DIAGNOSTIC '));
      expect(diagnostics).toHaveLength(mode === 'disabled' ? 0 : 1);
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('close', 1, null);
      const result = await pending;
      expect(result).toMatchObject({ status: 1, signal: null, timedOut: false });
      expect(result.stderr).toContain('Timeout terminating forks worker');
      if (mode === 'disabled') expect(result.processDiagnostic).toBeNull();
      else {
        expect(diagnostics[0]).toContain('"trigger":"worker-termination"');
        expect(result.processDiagnostic).toEqual(mode === 'unavailable'
          ? { status: 'unavailable', reason: 'reader-error', processes: [], truncated: false }
          : mode === 'default' ? expect.objectContaining({ rootPid: child.pid }) : snapshot);
      }
      if (mode === 'available' || mode === 'unavailable') expect(reader).toHaveBeenCalledTimes(1);
    },
  );

  it('settles a real assertion-failing worker after file completion without a teardown timeout (EI-25678025879775952)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-failure-stop-'));
    const file = 'controlled.test.mjs';
    const config = join(dir, 'vitest.config.mjs');
    const progress: string[] = [];
    const completed = vi.fn();
    try {
      writeFileSync(config, `export default ${JSON.stringify({
        root: dir,
        test: { include: [file], environment: 'node', pool: 'forks', maxWorkers: 1 },
      })};`);
      writeFileSync(join(dir, file),
        `import { test, expect } from ${JSON.stringify(resolve(REPO_ROOT, 'node_modules/vitest/dist/index.js'))};\n` +
        `test('controlled assertion failure', () => expect('actual').toBe('expected'));\n`);
      const result = await runCapturedTestProcess(process.execPath, [
        resolve(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
        'run', '--config', config, '--reporter=default',
      ], {
        cwd: dir,
        env: { ...process.env, NODE_OPTIONS: '', FORCE_COLOR: '0', NO_COLOR: '1' },
        files: [file],
        timeoutMs: 30_000,
        watchdogMaxMs: 30_000,
        onProgress: (line: string) => progress.push(line),
        onAllFilesComplete: completed,
        governedProcessImpl: (_governedOptions: unknown, run: Function) =>
          run(undefined, undefined, { inherited: true }),
      });
      const output = result.stdout + result.stderr;
      expect(output).toContain('controlled assertion failure');
      expect(output).toMatch(/Tests\s+1 failed/);
      expect(result, output).toMatchObject({ status: 1, signal: null, timedOut: false, error: null });
      expect(completed).toHaveBeenCalledTimes(1);
      expect(progress.find((line) => line.includes('state=file-completed'))).toContain('pendingFiles=[]');
      expect(progress.at(-1)).toContain('state=finished');
      expect(output).not.toMatch(/Timeout terminating .* worker|Failed to terminate .* worker/);
      expect(vitestRunFailed({ status: result.status, output })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it('prefers a detached systemd user scope while keeping the owned process-group watchdog', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 4242;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const spawnImpl = vi.fn((..._args: unknown[]) => child);
      const killProcessImpl = vi.fn(() => 'group');
      const stopScopeImpl = vi.fn(() => ({ tasks: 2, stopStatus: 0 }));
      const onProgress = vi.fn();
      const env = { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' };

      const resultPromise = runCapturedTestProcess(
        'npx',
        ['vitest', 'run', 'a.test.ts', 'b.test.ts'],
        {
          cwd: '/repo',
          cwdLabel: 'packages/operator-core',
          files: ['a.test.ts', 'b.test.ts'],
          timeoutMs: 100,
          progressIntervalMs: 10,
          watchdogStallWindowMs: 50,
          watchdogExtensionMs: 50,
          killGraceMs: 20,
          maxBuffer: 1024,
          // A user bus is reachable from this env, so systemd-run is the launcher.
          env,
          systemdRunPath: '/usr/bin/systemd-run',
          setsidPath: '/usr/bin/setsid',
          spawnImpl,
          killProcessImpl,
          stopScopeImpl,
          probeScopeSupportImpl: async () => ({ ok: true }),
          onProgress,
          governedProcessImpl: (_governedOptions: unknown, run: Function) =>
            run(undefined, undefined, { inherited: true }),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      const spawnArgs = spawnImpl.mock.calls[0]?.[1] as string[];
      const scopeUnit = spawnArgs.find((arg) => arg.startsWith('--unit='))?.slice('--unit='.length);
      expect(scopeUnit).toMatch(/^papercusp-test-\d+-[0-9a-z]+-\d+\.scope$/);
      expect(spawnImpl).toHaveBeenCalledWith(
        '/usr/bin/systemd-run',
        [
          '--user', '--scope', '--collect', `--unit=${scopeUnit}`,
          // watchdogMaxMs defaults to the 120-minute ceiling: 7,200s + 20ms grace + 1,800s slack.
          '--property=RuntimeMaxSec=9001', '--property=TimeoutStopSec=10',
          'npx', 'vitest', 'run', 'a.test.ts', 'b.test.ts',
        ],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      const spawnOptions = spawnImpl.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
      expect(spawnOptions).not.toHaveProperty('detached');

      child.stdout.write('✓ a.test.ts (1 test) 2ms\n');
      await vi.advanceTimersByTimeAsync(10);
      const progress = () => onProgress.mock.calls.map(([line]) => String(line)).join('\n');
      expect(progress()).toContain('state=file-completed');
      expect(progress()).toContain('completedFiles=["a.test.ts"]');
      expect(progress()).toContain('pendingFiles=["b.test.ts"]');

      await vi.advanceTimersByTimeAsync(90);
      expect(killProcessImpl).toHaveBeenCalledWith(child, 'SIGTERM', true);
      expect(stopScopeImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(killProcessImpl).toHaveBeenCalledWith(child, 'SIGKILL', true);
      // A process-group SIGKILL cannot reach a fixture that detached into its own group, and such
      // a straggler holding the stdio pipes would keep `close` from ever firing: the SIGKILL stage
      // also stops the whole scope.
      expect(stopScopeImpl).toHaveBeenCalledTimes(1);
      expect(stopScopeImpl).toHaveBeenCalledWith(scopeUnit, env);
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      expect(stopScopeImpl).toHaveBeenCalledTimes(1);

      await expect(resultPromise).resolves.toMatchObject({
        status: null,
        signal: 'SIGKILL',
        timedOut: true,
      });
      expect(progress()).toContain('state=timeout');
      expect(progress()).toContain('state=reaping');
      expect(progress()).toContain('state=finished');
      expect(progress()).toContain('state=finished cwd="packages/operator-core"');
      expect(progress()).toContain('exitStatus=none signal=SIGKILL');
      expect(progress()).toContain(
        `TEST_FILE_LEAKED_PROCESSES scope=${scopeUnit} tasks=2 reason=timeout ` +
          'cwd="packages/operator-core" files=["a.test.ts","b.test.ts"]',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends a slow child with fresh output, then reaps it after the output goes silent', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 4241;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const spawnImpl = vi.fn((..._args: unknown[]) => child);
      const killProcessImpl = vi.fn(() => 'group');
      const onProgress = vi.fn();

      const resultPromise = runCapturedTestProcess(
        'npx',
        ['vitest', 'run', 'a.test.ts'],
        {
          cwd: '/repo',
          files: ['a.test.ts'],
          timeoutMs: 100,
          progressIntervalMs: 10,
          watchdogStallWindowMs: 50,
          watchdogExtensionMs: 50,
          killGraceMs: 10,
          maxBuffer: 1024,
          systemdRunPath: null,
          setsidPath: '/usr/bin/setsid',
          spawnImpl,
          killProcessImpl,
          onProgress,
          governedProcessImpl: (_governedOptions: unknown, run: Function) =>
            run(undefined, undefined, { inherited: true }),
        },
      );

      child.stdout.write('vitest is still working\n');
      await vi.advanceTimersByTimeAsync(80);
      child.stdout.write('vitest is still working\n');
      await vi.advanceTimersByTimeAsync(20);

      expect(killProcessImpl).not.toHaveBeenCalled();
      expect(onProgress.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
        'state=watchdog-extended',
      );

      await vi.advanceTimersByTimeAsync(50);
      expect(killProcessImpl).toHaveBeenCalledWith(child, 'SIGTERM', true);
      await vi.advanceTimersByTimeAsync(10);
      expect(killProcessImpl).toHaveBeenCalledWith(child, 'SIGKILL', true);
      child.emit('close', null, 'SIGKILL');

      await expect(resultPromise).resolves.toMatchObject({
        status: null,
        signal: 'SIGKILL',
        timedOut: true,
      });
      expect(TEST_FILE_WATCHDOG_STALL_WINDOW_MS).toBe(5 * 60_000);
      expect(TEST_FILE_WATCHDOG_EXTENSION_MS).toBe(5 * 60_000);
      expect(MAX_TEST_FILE_RUN_TIMEOUT_MS).toBe(120 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['positional', 'equals', 'equals-dash'])('rejects a %s JSON output path before collection can overwrite test source', async (form) => {
    const root = mkdtempSync(join(tmpdir(), 'vitest-collection-source-'));
    const source = join(root, form === 'equals-dash' ? '--protected.test.ts' : 'protected.test.ts');
    const original = "import { it } from 'vitest'; it('protected case', () => {});\n";
    writeFileSync(source, original);
    const spawnImpl = vi.fn(() => {
      writeFileSync(source, '[{"name":"collected case"}]');
      throw new Error('unsafe collection child launched');
    });
    try {
      const jsonArgs = form === 'positional' ? ['--json', source]
        : [`--json=${form === 'equals-dash' ? '--protected.test.ts' : source}`];
      await expect(Promise.resolve().then(() => runVitestList('npx', ['vitest', 'list', ...jsonArgs], {
        cwd: root, spawnImpl, systemdRunPath: null, setsidPath: null,
      }))).rejects.toThrow('use --json=true for stdout');
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(readFileSync(source, 'utf8')).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['--json', '--json=true'])('collects named cases through stdout with %s', async (jsonArg) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4239;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const cases = [{ name: 'suite > selected case', file: '/repo/protected.test.ts' }];
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify(cases));
        child.emit('close', 0, null);
      });
      return child;
    });
    const result = await runVitestList('npx', ['vitest', 'list', 'protected.test.ts', jsonArg], {
      cwd: '/repo', env: { PATH: '/usr/bin' }, spawnImpl, systemdRunPath: null,
      setsidPath: null, onProgress: vi.fn(), readProcessDiagnosticImpl: null,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(cases);
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it.each([false, true])('bounds a silent Vitest collection preflight and reaps its owned process group (reader throws: %s)', async (readerThrows) => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 4240;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const spawnImpl = vi.fn((..._args: unknown[]) => child);
      const killProcessImpl = vi.fn(() => 'group');
      const progress = vi.fn();
      const processDiagnostic = { status: 'partial', rootPid: 4240, truncated: false,
        processes: [{ pid: 4240, name: 'npm exec vitest', state: 'S', waitChannel: 'do_wait' }] };
      const readProcessDiagnosticImpl = vi.fn(() => {
        if (readerThrows) throw new Error('diagnostic reader failed');
        return processDiagnostic;
      });

      const resultPromise = runVitestList(
        'npx',
        ['vitest', 'list', '--filesOnly', 'a.test.ts'],
        {
          cwd: '/repo',
          cwdLabel: 'packages/operator-core',
          env: { PATH: '/usr/bin' },
          timeoutMs: 100,
          progressIntervalMs: 10,
          watchdogStallWindowMs: 50,
          watchdogExtensionMs: 50,
          killGraceMs: 20,
          systemdRunPath: null,
          setsidPath: '/usr/bin/setsid',
          spawnImpl,
          killProcessImpl,
          onProgress: progress,
          readProcessDiagnosticImpl,
        },
      );

      expect(spawnImpl).toHaveBeenCalledWith(
        '/usr/bin/setsid',
        ['--wait', 'npx', 'vitest', 'list', '--filesOnly', 'a.test.ts'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(readProcessDiagnosticImpl).toHaveBeenCalledWith(4240);
      expect(readProcessDiagnosticImpl.mock.invocationCallOrder[0]).toBeLessThan(killProcessImpl.mock.invocationCallOrder[0]);
      expect(progress.mock.calls.map(([line]) => String(line)).join('\n')).toContain('TEST_FILE_CHILD_DIAGNOSTIC');
      expect(killProcessImpl).toHaveBeenCalledWith(child, 'SIGTERM', true);
      await vi.advanceTimersByTimeAsync(20);
      expect(killProcessImpl).toHaveBeenCalledWith(child, 'SIGKILL', true);
      child.emit('close', null, 'SIGKILL');

      await expect(resultPromise).resolves.toMatchObject({
        status: null,
        signal: 'SIGKILL',
        timedOut: true,
        processDiagnostic: readerThrows
          ? { status: 'unavailable', reason: 'reader-error', processes: [], truncated: false }
          : processDiagnostic,
      });
      expect(progress.mock.calls.map(([line]) => String(line)).join('\n')).toContain('state=timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops its systemd scope once the Vitest main exits, and names a leak only when one is resident', async () => {
    // host-memory-reduction-2026-09-27 P-008: `detached: true` fixtures from kopia-backup-guard and
    // pc-heavy tests outlived their runs by 19 days inside anonymous run-u scopes, each forking a
    // `sleep` ten times a second. Leftover scope residents are killed on exit, and named.
    for (const [tasks, leakLine] of [[3, true], [0, false], [null, false]] as const) {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 4545;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const spawnImpl = vi.fn((..._args: unknown[]) => child);
      const stopScopeImpl = vi.fn(() => ({ tasks, stopStatus: 0 }));
      const onProgress = vi.fn();
      const resultPromise = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
        cwd: '/repo',
        files: ['a.test.ts'],
        env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
        systemdRunPath: '/usr/bin/systemd-run',
        setsidPath: '/usr/bin/setsid',
        spawnImpl,
        stopScopeImpl,
        probeScopeSupportImpl: async () => ({ ok: true }),
        onProgress,
        governedProcessImpl: (_governedOptions: unknown, run: Function) =>
          run(undefined, undefined, { inherited: true }),
      });
      await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
      const spawnArgs = spawnImpl.mock.calls[0]?.[1] as string[];
      const scopeUnit = spawnArgs.find((arg) => arg.startsWith('--unit='))?.slice('--unit='.length);

      expect(stopScopeImpl).not.toHaveBeenCalled();
      child.emit('exit', 0, null);
      expect(stopScopeImpl).toHaveBeenCalledWith(scopeUnit, { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' });
      child.emit('close', 0, null);
      await expect(resultPromise).resolves.toMatchObject({ status: 0, signal: null, timedOut: false });
      expect(stopScopeImpl).toHaveBeenCalledTimes(1);
      const leaks = onProgress.mock.calls.map(([line]) => String(line)).filter((line) =>
        line.startsWith('TEST_FILE_LEAKED_PROCESSES'));
      expect(leaks).toEqual(leakLine
        ? [`TEST_FILE_LEAKED_PROCESSES scope=${scopeUnit} tasks=3 reason=exit cwd="/repo" files=["a.test.ts"]`]
        : []);
    }
  });

  it('never stops a scope it did not create (setsid and direct launchers)', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4546;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const stopScopeImpl = vi.fn(() => ({ tasks: 9, stopStatus: 0 }));
    const resultPromise = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
      cwd: '/repo',
      files: ['a.test.ts'],
      env: { PATH: '/usr/bin' },
      systemdRunPath: '/usr/bin/systemd-run',
      setsidPath: '/usr/bin/setsid',
      spawnImpl: vi.fn(() => child),
      stopScopeImpl,
      onProgress: () => null,
      governedProcessImpl: (_governedOptions: unknown, run: Function) =>
        run(undefined, undefined, { inherited: true }),
    });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await expect(resultPromise).resolves.toMatchObject({ status: 0 });
    expect(stopScopeImpl).not.toHaveBeenCalled();
  });

  it('stopTestScope reads the resident task count, then queues a non-blocking stop', () => {
    const calls: string[][] = [];
    const spawnSyncImpl = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return args.includes('show') ? { stdout: '4\n', status: 0 } : { stdout: '', status: 0 };
    };
    expect(stopTestScope('papercusp-test-1-a-1.scope', { XDG_RUNTIME_DIR: '/run/user/1000' }, spawnSyncImpl))
      .toEqual({ tasks: 4, stopStatus: 0 });
    expect(calls).toEqual([
      ['systemctl', '--user', 'show', '--property=TasksCurrent', '--value', 'papercusp-test-1-a-1.scope'],
      ['systemctl', '--user', 'stop', '--no-block', 'papercusp-test-1-a-1.scope'],
    ]);
    // A scope that already emptied has been garbage-collected (`--collect`): systemctl prints
    // `[not set]` and the stop exits 5. Neither is a leak, and neither may throw.
    const gone = (_command: string, args: string[]) =>
      (args.includes('show') ? { stdout: '[not set]\n', status: 0 } : { stdout: '', status: 5 });
    expect(stopTestScope('papercusp-test-1-a-2.scope', {}, gone)).toEqual({ tasks: null, stopStatus: 5 });
  });

  it('resolves the launcher against the env the child actually gets', () => {
    const base = { command: 'npx', args: ['vitest', 'run', 'a.test.ts'] };
    // An explicit user bus address works independently of the runtime directory.
    expect(userBusReachable({ PATH: '/usr/bin' })).toBe(false);
    expect(userBusReachable({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })).toBe(true);
    expect(
      resolveTestChildLauncher({
        ...base,
        env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        systemdRunPath: '/usr/bin/systemd-run',
        setsidPath: '/usr/bin/setsid',
        scopeUnit: 'papercusp-test-1-a-1.scope',
        runtimeMaxSec: 2400,
      }),
    ).toEqual({
      launcher: 'systemd-run',
      ownsProcessGroup: true,
      spawnCommand: '/usr/bin/systemd-run',
      spawnArgs: [
        '--user', '--scope', '--collect', '--unit=papercusp-test-1-a-1.scope',
        '--property=RuntimeMaxSec=2400', '--property=TimeoutStopSec=10',
        'npx', 'vitest', 'run', 'a.test.ts',
      ],
      scopeUnit: 'papercusp-test-1-a-1.scope',
    });
    // host-memory-reduction-2026-09-27 P-008: the sibling scope escapes the caller's cgroup, so it
    // must never be anonymous (the router could not stop it) nor unbounded (nothing would stop it
    // once the router died). Omitting both still yields a named, bounded scope.
    const defaulted = resolveTestChildLauncher({
      ...base,
      env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      systemdRunPath: '/usr/bin/systemd-run',
      setsidPath: '/usr/bin/setsid',
    });
    expect(defaulted.scopeUnit).toMatch(/^papercusp-test-\d+-[0-9a-z]+-\d+\.scope$/);
    expect(defaulted.spawnArgs).toContain(`--unit=${defaulted.scopeUnit}`);
    expect(defaulted.spawnArgs).toContain(`--property=RuntimeMaxSec=${testScopeRuntimeMaxSec(MAX_TEST_FILE_RUN_TIMEOUT_MS)}`);
    // A stripped env (a fixture, a cron job) must not be handed to systemd-run: it would exit 1
    // before the command ran, with no output — a silent red. setsid keeps the process-group
    // boundary the watchdog relies on.
    expect(
      resolveTestChildLauncher({
        ...base,
        env: { PATH: '/usr/bin' },
        systemdRunPath: '/usr/bin/systemd-run',
        setsidPath: '/usr/bin/setsid',
      }),
    ).toEqual({
      launcher: 'setsid',
      ownsProcessGroup: true,
      spawnCommand: '/usr/bin/setsid',
      spawnArgs: ['--wait', 'npx', 'vitest', 'run', 'a.test.ts'],
      scopeUnit: null,
    });
    expect(
      resolveTestChildLauncher({ ...base, env: { PATH: '/usr/bin' }, systemdRunPath: null, setsidPath: null }),
    ).toEqual({ launcher: 'direct', ownsProcessGroup: false, spawnCommand: 'npx', spawnArgs: base.args, scopeUnit: null });

    // EI-23142789976346343: testing:run already owns a bounded systemd scope.
    // A nested `systemd-run --scope` escapes that cgroup, so the outer timeout
    // reports terminal while Vitest grandchildren continue running. Both
    // markers are required: either one alone can appear on an unrelated direct
    // test-file invocation and must not disable the normal sibling-scope path.
    expect(
      resolveTestChildLauncher({
        ...base,
        env: {
          PATH: '/usr/bin',
          XDG_RUNTIME_DIR: '/run/user/1000',
          PAPERCUSP_TEST_RUN_GROUP: 'run-123',
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1700000060000',
        },
        systemdRunPath: '/usr/bin/systemd-run',
        setsidPath: '/usr/bin/setsid',
      }),
    ).toEqual({
      launcher: 'setsid',
      ownsProcessGroup: true,
      spawnCommand: '/usr/bin/setsid',
      spawnArgs: ['--wait', 'npx', 'vitest', 'run', 'a.test.ts'],
      scopeUnit: null,
    });
    for (const managedMarker of [
      { PAPERCUSP_TEST_RUN_GROUP: 'run-123' },
      { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1700000060000' },
    ]) {
      expect(
        resolveTestChildLauncher({
          ...base,
          env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', ...managedMarker },
          systemdRunPath: '/usr/bin/systemd-run',
          setsidPath: '/usr/bin/setsid',
        }),
      ).toMatchObject({ launcher: 'systemd-run' });
    }
  });

  it.skipIf(process.platform === 'win32')('uses setsid for a private XDG directory until it contains a real bus socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-bus-'));
    const bus = join(dir, 'bus');
    const server = createServer();
    const options = {
      command: 'npx', args: ['vitest', 'run', 'a.test.ts'], env: { XDG_RUNTIME_DIR: dir },
      systemdRunPath: '/usr/bin/systemd-run', setsidPath: '/usr/bin/setsid',
    };
    try {
      expect(userBusReachable(options.env)).toBe(false);
      expect(resolveTestChildLauncher(options)).toMatchObject({ launcher: 'setsid', ownsProcessGroup: true });
      // An ordinary file named bus is not an IPC endpoint either.
      writeFileSync(bus, 'not a bus socket');
      expect(userBusReachable(options.env)).toBe(false);
      expect(resolveTestChildLauncher(options)).toMatchObject({ launcher: 'setsid' });
      rmSync(bus);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bus, resolve);
      });
      expect(userBusReachable(options.env)).toBe(true);
      expect(resolveTestChildLauncher(options)).toMatchObject({ launcher: 'systemd-run', ownsProcessGroup: true });
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
    expect(userBusReachable(options.env)).toBe(false);
  });

  it.each(['disconnected transport', 'probe timeout', 'missing launcher'])(
    'checks a harmless scope before the test payload and uses setsid after %s (EI-25807722383059921)', async reason => {
      const child = Object.assign(new EventEmitter(), {
        pid: 4347, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      const env = { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/stale/bus' };
      const probeScopeSupportImpl = vi.fn(async () => ({ ok: false, reason }));
      const spawnImpl = vi.fn(() => child);
      const progress: string[] = [];
      const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
        files: ['a.test.ts'], env, systemdRunPath: '/usr/bin/systemd-run', setsidPath: '/usr/bin/setsid',
        probeScopeSupportImpl, spawnImpl, onProgress: (line: string) => progress.push(line),
        governedProcessImpl: (_options: unknown, run: Function) => run(undefined, env, { inherited: true }),
      });
      await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
      child.emit('close', 0, null);
      await expect(pending).resolves.toMatchObject({ status: 0, signal: null, timedOut: false });
      const tracedEnv = expect.objectContaining({ ...env, PAPERCUSP_TEST_STARTUP_TRACE: '1',
        NODE_OPTIONS: expect.stringContaining('/scripts/lib/vitest-startup-trace.mjs') });
      expect(probeScopeSupportImpl).toHaveBeenCalledWith(expect.objectContaining({ env: tracedEnv, systemdRunPath: '/usr/bin/systemd-run' }));
      expect(spawnImpl).toHaveBeenCalledWith('/usr/bin/setsid', ['--wait', 'npx', 'vitest', 'run', 'a.test.ts'],
        expect.objectContaining({ env: tracedEnv }));
      expect(env).toEqual({ PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/stale/bus' });
      expect(progress).toContainEqual(expect.stringContaining('TEST_FILE_SCOPE_PREFLIGHT'));
      expect(progress).toContainEqual(expect.stringContaining(reason));
    },
  );

  it('keeps a failed payload verdict after a successful harmless scope probe without retrying it (EI-25807722383059921)', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4348, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const env = {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/reachable/bus',
      PAPERCUSP_TEST_SECRET: 'scope-diagnostic-must-not-leak',
    };
    const probeScopeSupportImpl = vi.fn(async () => ({ ok: true }));
    const spawnImpl = vi.fn(() => child);
    const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
      env, systemdRunPath: '/usr/bin/systemd-run', setsidPath: '/usr/bin/setsid',
      probeScopeSupportImpl, spawnImpl, stopScopeImpl: () => ({ tasks: 0 }), onProgress: () => {},
      governedProcessImpl: (_options: unknown, run: Function) => run(undefined, env, { inherited: true }),
    });
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
    child.stderr.write('AssertionError: Failed to start transient scope is fixture text\n');
    child.emit('close', 1, null);
    await expect(pending).resolves.toMatchObject({ status: 1, timedOut: false,
      stderr: expect.stringContaining('AssertionError') });
    expect(probeScopeSupportImpl).toHaveBeenCalledTimes(1);
    expect((spawnImpl.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('/usr/bin/systemd-run');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unadmitted scope', '', '', true, true],
    ['assertion verdict', 'Tests  1 failed (1)\n', '', true, false],
    ['admitted scope payload', '', 'Running scope as unit: papercusp-test-fixture.scope\n', true, false],
    ['process-group payload', '', '', false, false],
  ])('qualifies post-preflight scope output for %s without replaying the payload (EI-25878128777441671)', async (_label, stdout, prefix, supported, launchFailed) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4350, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const env = {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/reachable/bus',
      PAPERCUSP_TEST_SECRET: 'scope-diagnostic-must-not-leak',
    };
    const spawnImpl = vi.fn(() => child);
    const pending = runCapturedTestProcess('npx', ['vitest', 'run', 'a.test.ts'], {
      env, systemdRunPath: '/usr/bin/systemd-run', setsidPath: '/usr/bin/setsid',
      probeScopeSupportImpl: async () => ({ ok: supported }), spawnImpl,
      stopScopeImpl: () => ({ tasks: 0 }), onProgress: () => {},
      governedProcessImpl: (_options: unknown, run: Function) => run(undefined, env, { inherited: true }),
    });
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
    child.stdout.write(stdout);
    child.stderr.write(`${prefix}Failed to start transient scope unit: Transport endpoint is not connected\n`);
    child.emit('close', 1, null);
    const result = await pending;
    expect(result).toMatchObject({
      status: 1, timedOut: false,
      error: launchFailed ? expect.objectContaining({ code: 'TEST_SCOPE_LAUNCH_FAILED' }) : null,
      stderr: expect.stringContaining('Transport endpoint is not connected'),
    });
    if (launchFailed) {
      const error = result.error as Error & { scopeLaunchEvidence?: Record<string, unknown> };
      const evidence = error.scopeLaunchEvidence;
      const spawnArgs = (spawnImpl.mock.calls[0] as unknown[])[1] as string[];
      expect(evidence).toMatchObject({
        launcher: '/usr/bin/systemd-run',
        scopeUnit: spawnArgs[3]?.slice('--unit='.length),
        probePassed: true,
        systemdArgs: spawnArgs.slice(0, 6),
        payloadArgumentCount: 3,
        busEnvironment: {
          xdgRuntimeDirSet: false,
          runtimeSystemdPrivateSocketExists: false,
          runtimeBusSocketExists: false,
          dbusSessionAddressSet: true,
          dbusAddressTransport: 'unix',
          dbusSessionUnixSocketExists: expect.any(Boolean),
        },
      });
      expect(error.message).toContain(`scopeEvidence=${JSON.stringify(evidence)}`);
      expect(error.message).not.toContain(env.PAPERCUSP_TEST_SECRET);
    }
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to setsid --wait when the child env cannot reach a user bus', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4344;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnImpl = vi.fn((..._args: unknown[]) => child);

    const resultPromise = runCapturedTestProcess(
      'npx',
      ['vitest', 'run', 'a.test.ts'],
      {
        cwd: '/repo',
        files: ['a.test.ts'],
        // The pc-heavy.test.ts fixtures spawn this router with exactly this shape of env.
        env: { PATH: '/usr/bin' },
        systemdRunPath: '/usr/bin/systemd-run',
        setsidPath: '/usr/bin/setsid',
        spawnImpl,
        onProgress: () => null,
        governedProcessImpl: (_governedOptions: unknown, run: Function) =>
          run(undefined, undefined, { inherited: true }),
      },
    );

    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/bin/setsid',
      ['--wait', 'npx', 'vitest', 'run', 'a.test.ts'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: '/usr/bin',
        PAPERCUSP_TEST_STARTUP_TRACE: '1',
        NODE_OPTIONS: expect.stringContaining('/scripts/lib/vitest-startup-trace.mjs') }),
        stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    child.emit('close', 0, null);
    await expect(resultPromise).resolves.toMatchObject({ status: 0, signal: null, timedOut: false });
  });

  it('falls back to setsid --wait when systemd-run is unavailable', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4343;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawnImpl = vi.fn((..._args: unknown[]) => child);
    const onProgress = vi.fn();

    const resultPromise = runCapturedTestProcess(
      'npx',
      ['vitest', 'run', 'a.test.ts'],
      {
        cwd: '/repo',
        files: ['a.test.ts'],
        systemdRunPath: null,
        setsidPath: '/usr/bin/setsid',
        spawnImpl,
        onProgress,
        governedProcessImpl: (_governedOptions: unknown, run: Function) =>
          run(undefined, undefined, { inherited: true }),
      },
    );

    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/bin/setsid',
      ['--wait', 'npx', 'vitest', 'run', 'a.test.ts'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    child.emit('close', 0, null);
    await expect(resultPromise).resolves.toMatchObject({
      status: 0,
      signal: null,
      timedOut: false,
    });
  });

  it('wires the real Vitest run through the async seam rather than a blocking spawnSync', () => {
    const source = readFileSync(new URL('../../../../scripts/test-files.mjs', import.meta.url), 'utf8');
    const runStart = source.search(/const result = await runCapturedTestProcessImpl\(\s*["']npx["']/);
    const runEnd = source.indexOf('const runOutput =', runStart);
    expect(runStart).toBeGreaterThan(0);
    expect(runEnd).toBeGreaterThan(runStart);
    expect(source.slice(runStart, runEnd)).not.toContain('spawnSync');
  });

  it('wires the collection preflight through the bounded async list seam', () => {
    const source = readFileSync(new URL('../../../../scripts/test-files.mjs', import.meta.url), 'utf8');
    const listStart = source.search(/const listed = await runVitestListImpl\(\s*["']npx["']/);
    const listEnd = source.indexOf('const listedOutput =', listStart);
    expect(listStart).toBeGreaterThan(0);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(source.slice(listStart, listEnd)).not.toContain('spawnSync');
    expect(source).toContain('TEST_FILE_LIST_WATCHDOG');
  });

  it.each([
    { name: 'quiet timeout', stdout: '', stderr: '', timedOut: true, error: null },
    { name: 'diagnostic timeout', stdout: 'collecting first file\n',
      stderr: 'Running as unit: original-collection.scope\nwaiting for transform\n', timedOut: true, error: null },
    { name: 'verbose timeout', stdout: 'stdout-start\n' + 'x'.repeat(20_000) + '\nstdout-end',
      stderr: 'original-collection.scope\n' + 'y'.repeat(20_000) + '\nlast-transform', timedOut: true, error: null },
    { name: 'spawn error', stdout: '', stderr: 'launch failed\n', timedOut: false,
      error: Object.assign(new Error('child could not start'), { code: 'ENOENT' }) },
  ])('refuses a collection failure without starting tests and retains evidence: $name', async (scenario) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runVitestListMock = vi.fn(async () => ({
      status: null,
      signal: 'SIGKILL',
      stdout: scenario.stdout,
      stderr: scenario.stderr,
      error: scenario.error,
      timedOut: scenario.timedOut,
      freezeMs: 73,
      processDiagnostic: { status: 'partial', rootPid: 4240, processes: [{ pid: 4240, name: 'npm exec vitest' }] },
    }));
    const runCapturedTestProcessMock = vi.fn();
    try {
      const code = await main(
        ['packages/operator-core/lib/__tests__/test-file-router.test.ts'],
        {
          runVitestListImpl: runVitestListMock,
          runCapturedTestProcessImpl: runCapturedTestProcessMock,
        },
      );
      expect(code).toBe(2);
      expect(runVitestListMock).toHaveBeenCalledTimes(1);
      expect(runCapturedTestProcessMock).not.toHaveBeenCalled();
      const lines = errorSpy.mock.calls.map(([line]) => String(line));
      if (scenario.timedOut) expect(lines.join('\n')).toContain('TEST_FILE_LIST_WATCHDOG');
      const diagnosticLine = lines.find(line => line.startsWith('TEST_FILE_LIST_DIAGNOSTIC '));
      expect(diagnosticLine).toBeDefined();
      const diagnostic = JSON.parse(diagnosticLine!.slice('TEST_FILE_LIST_DIAGNOSTIC '.length));
      expect(diagnostic).toMatchObject({ cwd: 'packages/operator-core', signal: 'SIGKILL',
        exitStatus: 'none', freezeMs: 73, errorCode: scenario.error?.code ?? null,
        processDiagnostic: { status: 'partial', rootPid: 4240, processes: [{ pid: 4240, name: 'npm exec vitest' }] },
        files: ['lib/__tests__/test-file-router.test.ts'] });
      for (const channel of ['stdout', 'stderr'] as const) {
        const captured = scenario[channel];
        if (captured.length <= 768) {
          expect(diagnostic[channel]).toEqual({ text: captured, omittedChars: 0 });
        } else {
          expect(diagnostic[channel]).toEqual({ head: captured.slice(0, 384), tail: captured.slice(-384),
            omittedChars: captured.length - 768 });
        }
      }
      expect(diagnosticLine!.length).toBeLessThan(2_500);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('remains importable by CommonJS-transformed consumers while settling its async exit code', () => {
    const source = readFileSync(new URL('../../../../scripts/test-files.mjs', import.meta.url), 'utf8');
    expect(() => transformSync(source, { format: 'cjs', loader: 'js', platform: 'node' })).not.toThrow();
    expect(source).toContain('void runTestFilesCli().then(');
  });
});

// EI-13535: a multi-workspace request (files owned by >1 cwd/config) used to `return` the moment
// the FIRST group either mismatched or failed, silently never even attempting the remaining
// groups — so `executed` could read far below `requested` with no indication the other files were
// never run at all (or, worse, a fixed-and-re-run first group could report a clean `status=passed`
// while the other groups' files were never executed). aggregateGroupResults is the pure decision
// `main` now uses to combine every group's outcome (all groups always run) into one honest verdict.
describe('aggregateGroupResults — no group may be silently abandoned (EI-13535)', () => {
  const okGroup = (requested: number, matched: number, executed: number) => ({
    requested,
    matched,
    executed,
    unmatchedCount: 0,
    failed: false,
    launchError: false,
  });

  it('combines multiple clean groups into one passing verdict summing across all of them', () => {
    const summary = aggregateGroupResults([okGroup(1, 1, 1), okGroup(2, 2, 2)]);
    expect(summary).toMatchObject({
      ok: true,
      requested: 3,
      matched: 3,
      executed: 3,
      anyUnmatched: false,
      anyFailed: false,
      launchError: false,
    });
  });

  it('THE BUG: a failure in group 1 must not hide group 2 — executed reflects BOTH groups ran', () => {
    // group 1 (1 file) failed its vitest run; group 2 (2 files) still ran to completion.
    const failedGroup1 = { ...okGroup(1, 1, 1), failed: true };
    const summary = aggregateGroupResults([failedGroup1, okGroup(2, 2, 2)]);
    // Before the fix, main() returned right after group 1 — group 2 never even attempted, so
    // `executed` would have frozen at 1 instead of reflecting all 3 requested files running.
    expect(summary.executed).toBe(3);
    expect(summary.requested).toBe(3);
    expect(summary.anyFailed).toBe(true);
    expect(summary.ok).toBe(true); // both groups matched fully — only their TEST results differed
  });

  it('a mismatch in one group is still refused (ok:false) even when every other group matched', () => {
    const mismatchedGroup = { requested: 2, matched: 1, executed: 0, unmatchedCount: 1, failed: false, launchError: false };
    const summary = aggregateGroupResults([mismatchedGroup, okGroup(1, 1, 1)]);
    expect(summary.ok).toBe(false);
    expect(summary.anyUnmatched).toBe(true);
    // The matched/requested counts still aggregate so the refusal message is honest about the
    // WHOLE request, not just the mismatched group.
    expect(summary).toMatchObject({ requested: 3, matched: 2 });
  });

  it('a launch error in any group refuses the whole run regardless of other groups', () => {
    const launchErrorGroup = { requested: 1, matched: 0, executed: 0, unmatchedCount: 1, failed: false, launchError: true };
    const summary = aggregateGroupResults([launchErrorGroup, okGroup(1, 1, 1)]);
    expect(summary.launchError).toBe(true);
  });

  it('preserves one governed admission kind for the typed NOT-MEASURED marker', () => {
    const launchErrorGroup = {
      requested: 2,
      matched: 2,
      executed: 0,
      unmatchedCount: 0,
      failed: false,
      launchError: true,
      governedAdmissionFailureKind: 'admission-starved',
    };
    expect(aggregateGroupResults([launchErrorGroup])).toMatchObject({
      launchError: true,
      governedAdmissionFailureKind: 'admission-starved',
    });
  });

  it('collapses mixed governed admission kinds to undetermined', () => {
    const base = {
      requested: 1,
      matched: 1,
      executed: 0,
      unmatchedCount: 0,
      failed: false,
      launchError: true,
    };
    expect(aggregateGroupResults([
      { ...base, governedAdmissionFailureKind: 'admission-starved' },
      { ...base, governedAdmissionFailureKind: 'undetermined' },
    ]).governedAdmissionFailureKind).toBe('undetermined');
  });

  it('does not call an ordinary launch error governed admission', () => {
    const summary = aggregateGroupResults([{
      requested: 1,
      matched: 0,
      executed: 0,
      unmatchedCount: 1,
      failed: false,
      launchError: true,
    }]);
    expect(summary.governedAdmissionFailureKind).toBeUndefined();
  });

  it('a single clean group (the common case) still reports ok/passed correctly', () => {
    const summary = aggregateGroupResults([okGroup(2, 2, 2)]);
    expect(summary).toMatchObject({ ok: true, requested: 2, matched: 2, executed: 2, anyFailed: false });
  });

  // EI-21902345477441137: a watchdog reap kills the child via signal, leaving `result.status`
  // typically `null` — the caller in `main()` must never classify that as a genuine test failure
  // (`null !== 0` would say "failed" for a run that produced no verdict at all). The fix pushes a
  // reaped group with `failed: false, timedOut: true` instead of letting it fall through
  // `vitestRunFailed`; this locks the aggregation contract that print sites and the final
  // `TEST_FILE_RESULT`/exit-code decision both key off.
  it('a timed-out (reaped) group must NOT contribute to anyFailed — a harness limit is not a red', () => {
    const timedOutGroup = { ...okGroup(1, 1, 1), failed: false, timedOut: true };
    const summary = aggregateGroupResults([timedOutGroup, okGroup(2, 2, 2)]);
    expect(summary.anyFailed).toBe(false);
    expect(summary.anyTimedOut).toBe(true);
    // Files were still attempted/counted normally — only the verdict classification differs.
    expect(summary.executed).toBe(3);
    expect(summary.requested).toBe(3);
  });

  it('a genuine failure elsewhere still reports anyFailed=true even alongside an unrelated timeout', () => {
    const timedOutGroup = { ...okGroup(1, 1, 1), failed: false, timedOut: true };
    const failedGroup = { ...okGroup(2, 2, 2), failed: true };
    const summary = aggregateGroupResults([timedOutGroup, failedGroup]);
    // Both signals surface independently — a reap in one group must never mask a real red in
    // another, and a real red must never be laundered into "just a timeout".
    expect(summary.anyFailed).toBe(true);
    expect(summary.anyTimedOut).toBe(true);
  });

  it('a clean run with no timed-out group reports anyTimedOut=false (no false positive)', () => {
    const summary = aggregateGroupResults([okGroup(1, 1, 1), okGroup(2, 2, 2)]);
    expect(summary.anyTimedOut).toBe(false);
  });
});

describe('failed assertion diagnostics — consume the report before private cleanup (EI-22591950423157299)', () => {
  const withReport = (body: unknown, run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'failed-assertion-report-'));
    try {
      const path = join(dir, 'report.json');
      writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads failed assertion names/messages but keeps collection errors out of the assertion list', () => {
    withReport({
      testResults: [{
        name: '/repo/lib/bad.test.ts',
        status: 'failed',
        message: 'collection error belongs to the file, not an assertion',
        assertionResults: [{
          status: 'failed',
          fullName: 'suite > compares values',
          failureMessages: ['Expected 1 to be 2'],
        }],
      }, {
        name: '/repo/lib/collect.test.ts',
        status: 'failed',
        message: 'SyntaxError: invalid source',
        assertionResults: [],
      }],
    }, (path) => {
      const failures = failedAssertionsFromReport(path, '/repo');
      expect(failures).toEqual([{
        file: '/repo/lib/bad.test.ts',
        name: 'suite > compares values',
        messages: ['Expected 1 to be 2'],
      }]);
      expect(formatFailedAssertionDiagnostics(failures)).toContain(
        'TEST_FILE_ASSERTION_FAILURE file="/repo/lib/bad.test.ts" name="suite > compares values" message="Expected 1 to be 2"',
      );
      expect(formatFailedAssertionDiagnostics(failures)).not.toContain('SyntaxError: invalid source');
    });
  });

  it('keeps unreadable reports distinct from readable reports with no assertion failures', () => {
    expect(failedAssertionsFromReport(null, '/repo')).toBeNull();
    expect(failedAssertionsFromReport('/nope/missing.json', '/repo')).toBeNull();
    withReport('{ not json', (path) => expect(failedAssertionsFromReport(path, '/repo')).toBeNull());
    withReport({ testResults: [{ assertionResults: [{ status: 'passed', fullName: 'ok' }] }] }, (path) => {
      expect(failedAssertionsFromReport(path, '/repo')).toEqual([]);
      expect(formatFailedAssertionDiagnostics(failedAssertionsFromReport(path, '/repo'))).toBe('');
    });
  });

  it('bounds each field and the complete diagnostic output', () => {
    const diagnostics = formatFailedAssertionDiagnostics(Array.from({ length: 30 }, (_, i) => ({
      file: `file-${i}-${'f'.repeat(1000)}`,
      name: `assertion-${i}-${'n'.repeat(1000)}`,
      messages: [`message-${i}-${'m'.repeat(5000)}`],
    })));
    expect(diagnostics.length).toBeLessThanOrEqual(12_000);
    expect(diagnostics).toContain('…');
    expect(diagnostics).toContain('TEST_FILE_ASSERTION_FAILURES_TRUNCATED');
  });
});

describe('main() — failed assertion details survive private report cleanup (EI-22591950423157299)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('prints the failed assertion message before removing the injected report directory', async () => {
    let reportPath: string | undefined;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runCapturedTestProcessMock = vi.fn(async (_command: string, args: string[]) => {
      const outputArg = args.find((arg) => arg.startsWith('--outputFile='));
      if (!outputArg) throw new Error('test fixture expected the injected output path');
      reportPath = outputArg.slice('--outputFile='.length);
      writeFileSync(reportPath, JSON.stringify({
        testResults: [{
          name: '/repo/lib/bad.test.ts',
          status: 'failed',
          message: 'file-level collection text must not be relabelled',
          assertionResults: [{
            status: 'failed',
            fullName: 'router > reports the real assertion',
            failureMessages: ['Expected 1 to be 2'],
          }],
        }],
      }));
      return {
        status: 1,
        signal: null,
        stdout: `simulated assertion failure\nJSON report written to ${reportPath}\n`,
        stderr: '',
        timedOut: false,
      };
    });

    const readyMarker = process.env.PC_HEAVY_PREEMPT_READY_FILE;
    const finalizationMarker = process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
    delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    let code: number;
    let visibleOutput = '';
    try {
      code = await main(
        ['packages/operator-core/lib/__tests__/test-file-router.test.ts'],
        { runCapturedTestProcessImpl: runCapturedTestProcessMock },
      );
    } finally {
      if (readyMarker === undefined) delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
      else process.env.PC_HEAVY_PREEMPT_READY_FILE = readyMarker;
      if (finalizationMarker === undefined) delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
      else process.env.PC_HEAVY_PSI_FINALIZATION_FILE = finalizationMarker;
      // Capture the writes before restoring the spy; mockRestore() clears its call history.
      visibleOutput = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      stdoutSpy.mockRestore();
    }

    expect(code).toBe(1);
    const output = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain(
      'TEST_FILE_ASSERTION_FAILURE file="/repo/lib/bad.test.ts" name="router > reports the real assertion" message="Expected 1 to be 2"',
    );
    expect(output).not.toContain('file-level collection text must not be relabelled');
    expect(reportPath).toBeDefined();
    expect(visibleOutput).toContain('simulated assertion failure');
    expect(visibleOutput).not.toContain(`JSON report written to ${reportPath}`);
    expect(existsSync(reportPath!)).toBe(false);
  });
});

describe('main() — evidence runs require inserted Vitest ledger receipts', () => {
  const file = 'packages/operator-core/lib/__tests__/test-file-router.test.ts';

  it.each(['shouldRecordTestRunPath', 'missingTestRunReceiptPaths'])(
    'refuses a pinned reporter missing %s before collection or execution', async missingExport => {
      const priorReceiptFile = process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
      process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = join(tmpdir(), 'unused-router-preflight-receipt.jsonl');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const list = vi.fn(), run = vi.fn();
      const reporter: Record<string, unknown> = {
        shouldRecordTestRunPath: () => true, missingTestRunReceiptPaths: () => [],
      };
      // An export with the right name and wrong type is just as incompatible
      // as an absent export; check callable shape, not key presence.
      reporter[missingExport] = missingExport === 'shouldRecordTestRunPath' ? undefined : 'not callable';
      try {
        expect(await main([file], {
          restrictedHoldPreflightImpl: () => ({ verdict: 'skip' }),
          loadVitestReceiptReporterImpl: async () => reporter,
          runVitestListImpl: list, runCapturedTestProcessImpl: run,
        })).toBe(2);
        expect(list).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        const errors = errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
        expect(errors).toContain('TEST_FILE_LEDGER_RECEIPT_PREFLIGHT');
        expect(errors).toContain(missingExport);
        expect(logSpy.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('TEST_FILE_RESULT');
      } finally {
        logSpy.mockRestore(); errorSpy.mockRestore();
        if (priorReceiptFile === undefined) delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
        else process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = priorReceiptFile;
      }
    },
  );

  async function runEvidenceCase(writeReceipt: boolean,
    failure?: { outcome: 'failed' | 'timeout'; reason: string; errorCode?: string },
    admission: 'skip' | 'admit' | 'refuse' = 'skip') {
    const dir = mkdtempSync(join(tmpdir(), 'test-file-receipt-verdict-'));
    const receiptFile = join(dir, 'receipts.jsonl');
    const priorReceiptFile = process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
    const priorReporterDisabled = process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
    const priorAdmission = process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
    process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = receiptFile;
    delete process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
    delete process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
    const childAdmissionMarkers: Array<string | undefined> = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runCapturedTestProcessMock = vi.fn(async (_command: string, _args: string[], options: any) => {
      childAdmissionMarkers.push(options.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT);
      if (writeReceipt || failure) {
        const filePath = 'packages/operator-core/lib/__tests__/test-file-router.test.ts';
        writeFileSync(options.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE, `${JSON.stringify({
          receiptId: 'router-test-receipt', attempt: 0, filePath, status: 'pass',
          row: { filePath, startedAt: '2026-10-14T17:00:00.000Z', finishedAt: '2026-10-14T17:00:01.000Z' },
          ...(failure ? { ...failure, replayable: false } : { outcome: 'inserted', id: 'test-run-901' }),
        })}\n`);
      }
      return { status: 0, signal: null, stdout: 'Test Files 1 passed (1)\nTests 1 passed (1)\n',
        stderr: '', timedOut: false, error: null };
    });

    try {
      const code = await main([file], {
        restrictedHoldPreflightImpl: () => admission === 'refuse'
          ? { verdict: 'refuse', error: 'restricted_write_held', hint: 'Fixture restricted write is held.' }
          : { verdict: admission },
        runVitestListImpl: async () => ({ status: 0, signal: null,
          stdout: 'lib/__tests__/test-file-router.test.ts\n', stderr: '', timedOut: false, error: null }),
        runCapturedTestProcessImpl: runCapturedTestProcessMock,
      });
      return {
        code,
        childAdmissionMarkers,
        output: logSpy.mock.calls.map(([line]) => String(line)).join('\n'),
        errors: errorSpy.mock.calls.map(([line]) => String(line)).join('\n'),
      };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      if (priorReceiptFile === undefined) delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
      else process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = priorReceiptFile;
      if (priorReporterDisabled === undefined) delete process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
      else process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER = priorReporterDisabled;
      if (priorAdmission === undefined) delete process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT;
      else process.env.PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT = priorAdmission;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('withholds a passing terminal marker when a recordable Vitest file has no inserted receipt', async () => {
    const result = await runEvidenceCase(false);

    expect(result.code).toBe(2);
    expect(result.errors).toContain('TEST_FILE_LEDGER_RECEIPT_MISSING');
    expect(result.errors).toContain('packages/operator-core/lib/__tests__/test-file-router.test.ts');
    expect(result.output).not.toContain('TEST_FILE_RESULT');
  });

  it('keeps the passing terminal marker when the current run inserted its receipt', async () => {
    const result = await runEvidenceCase(true);

    expect(result.code).toBe(0);
    expect(result.output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
    expect(result.errors).not.toContain('TEST_FILE_LEDGER_RECEIPT_MISSING');
  });

  it('forwards a real router admission to receipt-consuming Vitest children', async () => {
    const result = await runEvidenceCase(true, undefined, 'admit');
    expect(result.code).toBe(0);
    expect(result.childAdmissionMarkers).toEqual(['admitted-by-test-router']);
  });

  it('starts no receipt-consuming Vitest child when admission is refused', async () => {
    const result = await runEvidenceCase(true, undefined, 'refuse');
    expect(result.code).toBe(2);
    expect(result.childAdmissionMarkers).toEqual([]);
    expect(result.errors).toContain('restricted_write_held');
  });

  it.each(['failed', 'timeout'] as const)('retains the %s receipt reason when withholding a terminal verdict', async outcome => {
    const result = await runEvidenceCase(false, { outcome, reason: 'pg_insert_timeout_15000ms', errorCode: 'CONNECT_TIMEOUT' });
    expect(result.code).toBe(2);
    expect(result.errors).toContain(`\"outcome\":\"${outcome}\"`);
    expect(result.errors).toContain('pg_insert_timeout_15000ms');
    expect(result.errors).toContain('CONNECT_TIMEOUT');
    expect(result.errors).not.toContain('startedAt');
    expect(result.output).not.toContain('TEST_FILE_RESULT');
  });

  it('does not create or require a receipt sink for ordinary focused runs', async () => {
    const priorReceiptFile = process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
    const priorReporterDisabled = process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
    delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
    delete process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runCapturedTestProcessMock = vi.fn(async (_command: string, _args: string[], options: any) => {
      expect(options.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE).toBeUndefined();
      return { status: 0, signal: null, stdout: 'Test Files 1 passed (1)\nTests 1 passed (1)\n',
        stderr: '', timedOut: false, error: null };
    });

    try {
      const code = await main([file], {
        restrictedHoldPreflightImpl: () => ({ verdict: 'skip' }),
        runVitestListImpl: async () => ({ status: 0, signal: null,
          stdout: 'lib/__tests__/test-file-router.test.ts\n', stderr: '', timedOut: false, error: null }),
        runCapturedTestProcessImpl: runCapturedTestProcessMock,
      });
      const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
      const errors = errorSpy.mock.calls.map(([line]) => String(line)).join('\n');

      expect(code).toBe(0);
      expect(runCapturedTestProcessMock).toHaveBeenCalledOnce();
      expect(output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
      expect(errors).not.toContain('TEST_FILE_LEDGER_RECEIPT_MISSING');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      if (priorReceiptFile === undefined) delete process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
      else process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = priorReceiptFile;
      if (priorReporterDisabled === undefined) delete process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
      else process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER = priorReporterDisabled;
    }
  });
});

// EI-25671809770924720: pc-heavy addresses its two marker paths to the router it launched. Every
// child the router spawns receives `process.env`, so a router that left them there handed the
// parent's unique barrier to any test that spawns a nested router — which then refused with
// EEXIST against its live parent before running a single assertion.
describe('main() — the pc-heavy marker addresses stop at this router (EI-25671809770924720)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let markerDir: string;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    markerDir = mkdtempSync(join(tmpdir(), 'test-files-marker-consume-'));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(markerDir, { recursive: true, force: true });
  });

  it('publishes its own barriers from the consumed paths and spawns children without them', async () => {
    const readyFile = join(markerDir, 'ready.AbC123');
    const finalizationFile = join(markerDir, 'finalization.XyZ789');
    const owner = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
    const seen: Array<{
      childReady: string | undefined;
      childFinalization: string | undefined;
      readyOwner: string | null;
      finalizationOwner: string | null;
    }> = [];
    const runCapturedTestProcessMock = vi.fn(
      async (
        _command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv; onAllFilesComplete?: () => void },
      ) => {
        // What a nested router spawned by a test in this child would inherit.
        const childEnv = options.env ?? {};
        options.onAllFilesComplete?.();
        seen.push({
          childReady: childEnv.PC_HEAVY_PREEMPT_READY_FILE,
          childFinalization: childEnv.PC_HEAVY_PSI_FINALIZATION_FILE,
          readyOwner: owner(readyFile),
          finalizationOwner: owner(finalizationFile),
        });
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='));
        if (outputArg) {
          writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify({
            testResults: [{
              name: '/repo/lib/ok.test.ts',
              status: 'passed',
              assertionResults: [{ status: 'passed', fullName: 'router > passes' }],
            }],
          }));
        }
        return { status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      },
    );

    const savedReady = process.env.PC_HEAVY_PREEMPT_READY_FILE;
    const savedFinalization = process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    process.env.PC_HEAVY_PREEMPT_READY_FILE = readyFile;
    process.env.PC_HEAVY_PSI_FINALIZATION_FILE = finalizationFile;
    let leftInProcessEnv: { ready: string | undefined; finalization: string | undefined };
    try {
      await main(
        ['packages/operator-core/lib/__tests__/test-file-router.test.ts'],
        { runCapturedTestProcessImpl: runCapturedTestProcessMock },
      );
    } finally {
      leftInProcessEnv = {
        ready: process.env.PC_HEAVY_PREEMPT_READY_FILE,
        finalization: process.env.PC_HEAVY_PSI_FINALIZATION_FILE,
      };
      if (savedReady === undefined) delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
      else process.env.PC_HEAVY_PREEMPT_READY_FILE = savedReady;
      if (savedFinalization === undefined) delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
      else process.env.PC_HEAVY_PSI_FINALIZATION_FILE = savedFinalization;
    }

    expect(runCapturedTestProcessMock).toHaveBeenCalled();
    for (const child of seen) {
      // The child sees neither address...
      expect(child.childReady).toBeUndefined();
      expect(child.childFinalization).toBeUndefined();
      // ...while THIS router still published both barriers at the paths pc-heavy gave it.
      expect(child.readyOwner).toBe(String(process.pid));
      expect(child.finalizationOwner).toBe(String(process.pid));
    }
    expect(leftInProcessEnv).toEqual({ ready: undefined, finalization: undefined });
    // main()'s finally still removes the barriers it published.
    expect(existsSync(readyFile)).toBe(false);
    expect(existsSync(finalizationFile)).toBe(false);
  });
});

describe('suppressInjectedJsonReportNotice', () => {
  it('removes only the notice for the disposable injected path', () => {
    const reportPath = '/dev/shm/pcv/papercusp-test-files-report-example/group-0.json';
    const output =
      `human output\nJSON report written to ${reportPath}\n` +
      'Tests  1 passed (1)\n';
    expect(suppressInjectedJsonReportNotice(output, reportPath)).toBe(
      'human output\nTests  1 passed (1)\n',
    );
    expect(suppressInjectedJsonReportNotice(output, '/dev/shm/other.json')).toBe(output);
    expect(suppressInjectedJsonReportNotice(output, null)).toBe(output);
  });
});

describe('governed admission refusal terminal marker (EI-21984099786606751)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('preserves the originating exception when admission fails before spawn', async () => {
    const origin = new ReferenceError('pinModuleState is not defined');
    origin.stack = 'ReferenceError: pinModuleState is not defined\n    at originalAdmission (/provider/execution.ts:12:3)';
    const spawnImpl = vi.fn();
    const result = await runCapturedTestProcess('node', ['--version'], {
      cwd: REPO_ROOT,
      spawnImpl,
      governedProcessImpl: async () => { throw origin; },
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.governedAdmissionError).toBe(true);
    expect(result.error.cause).toBe(origin);
    expect(result.error.cause.stack).toContain('/provider/execution.ts:12:3');
  });

  it.each([0, 1])('retains the captured exit %s when governor finalization fails after close', async (status) => {
    const origin = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawnImpl = vi.fn(() => child);
    const governedProcessImpl = vi.fn(async (_options: unknown, run: Function) => {
      await run(undefined, undefined, { inherited: true });
      throw origin;
    });
    const promise = runCapturedTestProcess('vitest', ['run', 'a.test.ts'], {
      cwd: REPO_ROOT,
      files: ['a.test.ts'],
      spawnImpl,
      governedProcessImpl,
      systemdRunPath: null,
      setsidPath: null,
      onProgress: vi.fn(),
    });
    child.stdout.write('a.test.ts (1 test)\n');
    child.stderr.write('captured child diagnostic\n');
    child.emit('close', status, null);
    const result = await promise;

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(governedProcessImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status,
      signal: null,
      stdout: 'a.test.ts (1 test)\n',
      stderr: 'captured child diagnostic\n',
      error: null,
      timedOut: false,
    });
    expect(result.governedAdmissionError).not.toBe(true);
    expect(result.governedFinalizationError.cause).toBe(origin);
    expect(result.actualDemand).toBeDefined();
  });

  it.each([0, 1])('also preserves an actual synchronous Node child after finalization failure, exit %s', async (status) => {
    const origin = new Error('Node receipt finish failed');
    const run = vi.fn(() => spawnSync(process.execPath, ['-e', `process.stdout.write('child output'); process.exit(${status})`], {
      encoding: 'utf8',
    }));
    const result = await runGovernedTestFileProcess(async (_options: unknown, callback: Function) => {
      await callback();
      throw origin;
    }, { demand: { cpuWeight: 1 } }, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status, stdout: 'child output', signal: null });
    expect(result.governedAdmissionError).not.toBe(true);
    expect(result.governedFinalizationError.cause).toBe(origin);
  });

  it.each([0, 1])('keeps the measured verdict and refuses an overall green after finalization failure, child exit %s', async (status) => {
    const readyMarker = process.env.PC_HEAVY_PREEMPT_READY_FILE;
    const finalizationMarker = process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
    delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let code: number;
    try {
      code = await main(['packages/operator-core/lib/__tests__/test-file-router.test.ts'], {
        runCapturedTestProcessImpl: async () => ({
          status,
          signal: null,
          stdout: `Test Files 1 ${status === 0 ? 'passed' : 'failed'} (1)\nTests 1 ${status === 0 ? 'passed' : 'failed'} (1)\n`,
          stderr: '',
          error: null,
          timedOut: false,
          governedFinalizationError: new Error('receipt finish failed', {
            cause: new Error('original settlement stack'),
          }),
        }),
      });
    } finally {
      if (readyMarker === undefined) delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
      else process.env.PC_HEAVY_PREEMPT_READY_FILE = readyMarker;
      if (finalizationMarker === undefined) delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
      else process.env.PC_HEAVY_PSI_FINALIZATION_FILE = finalizationMarker;
      stdoutSpy.mockRestore();
    }
    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(code).toBe(3);
    expect(output).toContain(`TEST_FILE_RESULT requested=1 executed=1 matched=1 status=${status === 0 ? 'passed' : 'failed'}`);
    expect(output).toContain('finalizationError=true');
    expect(errors).toContain('TEST_FILE_FINALIZATION_ERROR');
    expect(errors).toContain('receipt finish failed');
    expect(errors).toContain('original settlement stack');
    expect(errors).not.toContain('TEST_FILE_ADMISSION_ERROR');
    expect(errors).not.toContain('no test file ran');
  });

  it('refuses an overall green when Vitest reports a timed-out fork worker after passing tests', async () => {
    const readyMarker = process.env.PC_HEAVY_PREEMPT_READY_FILE;
    const finalizationMarker = process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
    delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    // main forwards child bytes directly. Keep this synthetic warning inside
    // the fixture so the outer real router does not diagnose its own worker.
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let capturedStderr = '';
    let code: number;
    try {
      code = await main(['packages/operator-core/lib/__tests__/test-file-router.test.ts'], {
        runCapturedTestProcessImpl: async () => ({
          status: 0,
          signal: null,
          stdout: 'Test Files 1 passed (1)\nTests 1 passed (1)\n',
          stderr: '[vitest-pool]: Timeout terminating forks worker for test files x.test.ts.\n',
          error: null,
          timedOut: false,
        }),
      });
    } finally {
      if (readyMarker === undefined) delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
      else process.env.PC_HEAVY_PREEMPT_READY_FILE = readyMarker;
      if (finalizationMarker === undefined) delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
      else process.env.PC_HEAVY_PSI_FINALIZATION_FILE = finalizationMarker;
      capturedStderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    const errors = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(code).toBe(3);
    expect(output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
    expect(output).toContain('finalizationError=true');
    expect(errors).toContain('TEST_FILE_WORKER_TERMINATION_FINALIZATION_ERROR');
    expect(capturedStderr)
      .toContain('[vitest-pool]: Timeout terminating forks worker for test files x.test.ts.');
  });

  it.each(['admission-starved', 'undetermined'])('preserves the admission cause alongside NOT-MEASURED for %s', async (failureKind) => {
    const readyMarker = process.env.PC_HEAVY_PREEMPT_READY_FILE;
    const finalizationMarker = process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
    delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
    let code: number;
    try {
      code = await main(
        ['packages/operator-core/lib/__tests__/test-file-router.test.ts'],
        {
          runCapturedTestProcessImpl: async () => ({
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: false,
            error: Object.assign(new Error('statement timeout', {
              cause: Object.assign(new Error('statement timeout'), {
                stack: 'Error: statement timeout\n    at origin (/provider/admission.ts:42:7)',
              }),
            }), { code: 'GOVERNED_ADMISSION_FAILED' }),
            governedAdmissionError: true,
            governedAdmissionFailureKind: failureKind,
          }),
        },
      );
    } finally {
      if (readyMarker === undefined) delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
      else process.env.PC_HEAVY_PREEMPT_READY_FILE = readyMarker;
      if (finalizationMarker === undefined) delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
      else process.env.PC_HEAVY_PSI_FINALIZATION_FILE = finalizationMarker;
    }

    expect(code).toBe(2);
    const output = errSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain(`TEST_FILE_NOT_MEASURED requested=1 executed=0 matched=1 measuredFiles=0 status=not-measured reason=${failureKind}`);
    expect(output).toContain(`TEST_FILE_ADMISSION_ERROR kind=${failureKind} detail="statement timeout"`);
    expect(output).toContain('origin="Error: statement timeout\\n    at origin (/provider/admission.ts:42:7)"');
    expect(output).not.toContain('TEST_FILE_RESULT');
  });
});

// EI-18099113673609528: Vitest 4's default/verbose reporter drops ALL per-suite error detail
// when >=2 requested files fail to COLLECT (a transform/parse error) in the same run — the
// caller is left with only the bare "Test Files N failed (N) / Tests no tests" summary lines
// and nothing else. Fixtures below are the literal shapes observed against real vitest 4.1.8
// output (single collection failure DOES print a "Failed Suites" block; two simultaneous ones
// print neither that block nor any "FAIL " line).
describe('looksLikeSilentCollectionFailure (EI-18099113673609528)', () => {
  const SINGLE_FAILURE_WITH_DETAIL = `
 RUN  v4.1.8 /repo

 ❯ lib/bad.test.tsx (0 test)

⏰⏰⏰⏰⏰⏰ Failed Suites 1 ⏰⏰⏰⏰⏰⏰⏰

 FAIL  lib/bad.test.tsx [ lib/bad.test.tsx ]
Error: Transform failed with 1 error:
lib/bad.test.tsx:3:0: ERROR: Unterminated string literal

 Test Files  1 failed (1)
      Tests  no tests
`;

  const TWO_SIMULTANEOUS_FAILURES_NO_DETAIL = `
 RUN  v4.1.8 /repo

 ❯ lib/bad1.test.tsx (0 test)
 ❯ lib/bad2.test.tsx (0 test)

 Test Files  2 failed (2)
      Tests  no tests
`;

  it('flags the silent-failure signature: N>=2 failed, zero per-suite detail', () => {
    expect(looksLikeSilentCollectionFailure(TWO_SIMULTANEOUS_FAILURES_NO_DETAIL)).toBe(true);
  });

  it('does NOT flag a single collection failure — Vitest prints the Failed Suites block for it', () => {
    expect(looksLikeSilentCollectionFailure(SINGLE_FAILURE_WITH_DETAIL)).toBe(false);
  });

  it('does NOT flag a normal green run', () => {
    expect(looksLikeSilentCollectionFailure(' Test Files  2 passed (2)\n      Tests  5 passed (5)\n')).toBe(false);
  });

  // EI-18819483316574031: vitest COLOURISES this output in practice. Every matcher here is
  // shape-anchored, so before the ANSI strip this detector silently returned false on real
  // runs while all of its tests (clean text) stayed green — the same blindness that let the
  // green-checkpoint exit-code cross-check pass a genuinely red suite the same day.
  it('flags the silent-failure signature through ANSI colour codes', () => {
    // Built from an explicit ESC constant so the escapes are VISIBLE in source. A fixture
    // written with raw control bytes is invisible to a reader and trivially lost to a
    // formatter/copy-paste — and a fixture that quietly loses its ESC bytes stops testing
    // the very thing it names (hit exactly that while writing this guard).
    const E = String.fromCharCode(27); // ESC — pure ASCII in source
    const coloured =
      `${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m2 failed${E}[39m${E}[22m${E}[90m (2)${E}[39m\n` +
      ` ${E}[31m❯${E}[39m src/a.test.ts ${E}[2m(0 test)${E}[22m\n` +
      ` ${E}[31m❯${E}[39m src/b.test.ts ${E}[2m(0 test)${E}[22m\n`;
    expect(coloured).toContain(String.fromCharCode(27) + '['); // the fixture really is coloured
    expect(looksLikeSilentCollectionFailure(coloured)).toBe(true);
  });

  it('does NOT flag a COLOURISED green run (no false positives from the strip)', () => {
    const E = String.fromCharCode(27); // ESC — pure ASCII in source
    const colouredGreen =
      `${E}[2m Test Files ${E}[22m ${E}[1m${E}[32m2 passed${E}[39m${E}[22m${E}[90m (2)${E}[39m\n` +
      `${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m5 passed${E}[39m${E}[22m${E}[90m (5)${E}[39m\n`;
    expect(looksLikeSilentCollectionFailure(colouredGreen)).toBe(false);
  });

  it('does NOT flag a run with per-test assertion detail (a real, diagnosable failure) — captured verbatim from a real vitest 4.1.8 run', () => {
    const withAssertionDetail = `
 RUN  v4.1.8 /repo

 ❯ lib/a.test.ts (1 test | 1 failed) 14ms
     × fails on purpose 12ms

 Test Files  1 failed (1)
      Tests  1 failed (1)
`;
    expect(looksLikeSilentCollectionFailure(withAssertionDetail)).toBe(false);
  });

  it('does NOT flag a single collection failure mixed with passing files (only one zero-test file)', () => {
    const oneCollectionFailureAmongPasses = `
 ❯ lib/bad.test.tsx (0 test)
 ✓ lib/good.test.tsx (3 tests) 9ms

⏰⏰⏰⏰⏰⏰ Failed Suites 1 ⏰⏰⏰⏰⏰⏰⏰

 FAIL  lib/bad.test.tsx [ lib/bad.test.tsx ]
Error: Transform failed with 1 error:

 Test Files  1 failed | 1 passed (2)
      Tests  3 passed (3)
`;
    expect(looksLikeSilentCollectionFailure(oneCollectionFailureAmongPasses)).toBe(false);
  });
});

// EI-18662389554660036: a concurrent `npm install` on the shared tree rewrites node_modules
// out from under every other agent's test run — vitest's own bin can vanish mid-install
// (a bare shell "command not found"), or Node throws ERR_MODULE_NOT_FOUND into node_modules
// for a package left half-written by an overlapping install. Neither error names its real
// cause; this detector recognizes both real-world signatures reported in the EI.
describe('looksLikeMidInstallCorruption (EI-18662389554660036)', () => {
  it('flags the shell "vitest: not found" signature (node_modules/.bin/vitest missing mid-install)', () => {
    expect(looksLikeMidInstallCorruption('sh: 1: vitest: not found\n')).toBe(true);
  });

  it('flags an ERR_MODULE_NOT_FOUND stack that points into node_modules (a half-written package)', () => {
    const missingModule = join(REPO_ROOT, 'node_modules/vitest/node_modules/@vitest/mocker/dist/node.js');
    const stack = `node:internal/modules/esm/resolve:something
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${missingModule}'
    at new NodeError (node:internal/errors:405:5)`;
    expect(looksLikeMidInstallCorruption(stack)).toBe(true);
  });

  it('does NOT attribute an isolated scratch checkout dependency failure to the shared install', () => {
    const stack = `node:internal/modules/esm/resolve:something
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'get-tsconfig' imported from /dev/shm/pcv/wi5764-loader-GsWRfz/repo/node_modules/tsx/dist/register-CFH5oNdT.mjs
    at new NodeError (node:internal/errors:405:5)`;
    expect(looksLikeMidInstallCorruption(stack)).toBe(false);
  });

  it('does NOT flag an unrelated MODULE_NOT_FOUND with no node_modules path (a real missing-file bug)', () => {
    expect(looksLikeMidInstallCorruption('Error [ERR_MODULE_NOT_FOUND]: Cannot find module ./foo.ts')).toBe(false);
  });

  it('does NOT flag a normal passing run', () => {
    expect(looksLikeMidInstallCorruption(' Test Files  2 passed (2)\n      Tests  5 passed (5)\n')).toBe(false);
  });

  it('does NOT flag a normal per-test assertion failure', () => {
    const withAssertionDetail = `
 ❯ lib/a.test.ts (1 test | 1 failed) 14ms
     × fails on purpose 12ms

 Test Files  1 failed (1)
      Tests  1 failed (1)
`;
    expect(looksLikeMidInstallCorruption(withAssertionDetail)).toBe(false);
  });

  it('does NOT diagnose its own passing test title as a missing Vitest binary', () => {
    const selfTestFailure = `
 ✓ flags the shell "vitest: not found" signature (node_modules/.bin/vitest missing mid-install) 1ms
 × an unrelated assertion fails 2ms

 FAIL  lib/__tests__/test-file-router.test.ts > unrelated assertion
AssertionError: expected -1 to be greater than 0

 Test Files  1 failed (1)
      Tests  1 failed | 77 passed (78)
`;
    expect(looksLikeMidInstallCorruption(selfTestFailure)).toBe(false);
  });

  it('does NOT flag an assertion diff that merely prints detector source containing both tokens', () => {
    const sourceDiff = `
AssertionError: expected source to contain a historical literal
- expected
+ received
+ if (/ERR_MODULE_NOT_FOUND/.test(output) && /node_modules/.test(output)) return true;

 Test Files  1 failed (1)
      Tests  1 failed (1)
`;
    expect(looksLikeMidInstallCorruption(sourceDiff)).toBe(false);
  });
});

// EI-19304880034803985: the mid-install hint above only ever fires on the
// FAILURE signature — but the dominant real symptom is a HANG (vitest blocks
// indefinitely while node_modules is rewritten out from under it), so this
// script never reaches the code that would print a hint at all. Widened the
// trigger by peeking the SAME fs-mutex `install:safe` holds, immediately
// before each vitest spawn point, and printing up front when it's held.
describe('warnIfInstallInFlight (EI-19304880034803985 — the HANG-path hint)', () => {
  let tmpLockRootDir: string;
  let priorLockDirEnv: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    priorLockDirEnv = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    tmpLockRootDir = mkdtempSync(join(tmpdir(), 'fs-mutex-peek-test-'));
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = tmpLockRootDir;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (priorLockDirEnv === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = priorLockDirEnv;
    rmSync(tmpLockRootDir, { recursive: true, force: true });
  });

  it('prints nothing when no install mutex is held', () => {
    warnIfInstallInFlight('`vitest run` (group cwd=x)');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prints the TEST_FILE_MID_INSTALL_SUSPECTED hint for a running writer using callback start time', () => {
    // Mirror withFsMutex's own on-disk shape exactly (mkdir + owner.json) —
    // repoLockName()'s digest is already alnum+hyphen, so no safeName() rewrite applies.
    const lockDir = join(tmpLockRootDir, `${repoLockName()}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 424242, host: 'test-host', phase: 'running',
        startedAt: '2026-08-02T00:00:00.000Z', acquiredAt: '2026-08-02T00:01:00.000Z',
        runningAt: '2026-08-02T00:02:00.000Z' }),
    );

    warnIfInstallInFlight('`vitest list` (group cwd=y)');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0] as [string];
    expect(msg).toContain('TEST_FILE_MID_INSTALL_SUSPECTED');
    expect(msg).toContain('pid 424242');
    expect(msg).toContain('`vitest list` (group cwd=y)');
    expect(msg).toMatch(/may HANG \(not fail\)/);
    expect(msg).toContain('since 2026-08-02T00:02:00.000Z');
    expect(msg).not.toContain('since 2026-08-02T00:00:00.000Z');
  });

  it('reports a draining writer without claiming the install callback is running', () => {
    const lockDir = join(tmpLockRootDir, `${repoLockName()}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 424242,
      phase: 'draining-readers', acquiredAt: '2026-08-02T00:01:00.000Z' }));
    warnIfInstallInFlight('reader-backed test');
    const [msg] = errorSpy.mock.calls[0] as [string];
    expect(msg).toContain('TEST_FILE_INSTALL_DRAINING_READERS');
    expect(msg).toContain('since 2026-08-02T00:01:00.000Z');
    expect(msg).toContain('admitted readers can continue');
    expect(msg).not.toContain('TEST_FILE_MID_INSTALL_SUSPECTED');
    expect(msg).not.toContain('may HANG');
  });

  it.each([undefined, 'future-phase'])('keeps an unknown writer phase honest (%s)', (phase) => {
    const lockDir = join(tmpLockRootDir, `${repoLockName()}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 424242, phase,
      startedAt: '2026-08-02T00:00:00.000Z' }));
    warnIfInstallInFlight('legacy writer');
    const [msg] = errorSpy.mock.calls[0] as [string];
    expect(msg).toContain('TEST_FILE_INSTALL_MUTEX_HELD');
    expect(msg).toContain('phase is unknown');
    expect(msg).not.toContain('TEST_FILE_MID_INSTALL_SUSPECTED');
    expect(msg).not.toContain('since 2026-08-02T00:00:00.000Z');
  });

  it('never throws even if the peek itself would be inconclusive (fail-open, per peekFsMutexSync)', () => {
    // No lock dir AND no fs-mutex root created at all — the coldest possible path.
    rmSync(tmpLockRootDir, { recursive: true, force: true });
    expect(() => warnIfInstallInFlight('cold path')).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('direct test-files CLI install reader lease (EI-24946572521324679)', () => {
  it('takes the repo reader lease and propagates the marker for an unmarked CLI run', async () => {
    const lockName = repoLockName();
    const otherLockName = 'npm-install-aaaaaaaaaaaa';
    const env = { PAPERCUSP_INSTALL_MUTEX_HELD: otherLockName };
    const args = ['packages/operator-core/lib/__tests__/test-file-router.test.ts'];
    const run = vi.fn(async () => {
      expect(env.PAPERCUSP_INSTALL_MUTEX_HELD).toBe([otherLockName, lockName].join(','));
      return 7;
    });
    const acquireReadLease = vi.fn(async (_name, withLease) => withLease());

    await expect(runTestFilesCli(args, { env, acquireReadLease, run })).resolves.toBe(7);

    expect(acquireReadLease).toHaveBeenCalledOnce();
    expect(acquireReadLease).toHaveBeenCalledWith(lockName, expect.any(Function));
    expect(run).toHaveBeenCalledWith(args);
    expect(env.PAPERCUSP_INSTALL_MUTEX_HELD).toBe(otherLockName);
  });

  it('bypasses nested acquisition when the matching repo marker is already present', async () => {
    const lockName = repoLockName();
    const env = { PAPERCUSP_INSTALL_MUTEX_HELD: ['npm-install-aaaaaaaaaaaa', lockName].join(',') };
    const args = ['packages/operator-core/lib/__tests__/test-file-router.test.ts'];
    const run = vi.fn(async () => 0);
    const acquireReadLease = vi.fn();

    await expect(runTestFilesCli(args, { env, acquireReadLease, run })).resolves.toBe(0);

    expect(run).toHaveBeenCalledWith(args);
    expect(acquireReadLease).not.toHaveBeenCalled();
    expect(env.PAPERCUSP_INSTALL_MUTEX_HELD).toBe(['npm-install-aaaaaaaaaaaa', lockName].join(','));
  });
});

describe('TEST_FILE_RESULT presence is a verdict, so a run that executed nothing must not print it (EI-19376339983058011)', () => {
  // WHY THIS IS PINNED. A measurement harness guarded its runs with
  // `if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi` — a presence test, which is the
  // natural way to ask "did this actually run?". A dry run satisfied it: same marker, executed=0,
  // exit 0, and zero parseable FAIL lines, which the harness recorded as "this candidate passes".
  // Four corpus rows were written that way in ~37s each. The false reading is indistinguishable
  // from a true one AND argues for the wrong conclusion (drop the candidate), so it is the
  // expensive direction. `--dry` is chosen here deliberately: it is the one path that reaches the
  // reporting branch without executing tests. Route matching still runs `vitest list`, so the
  // marker assertions inject a deterministic listing and the separate integration guard below
  // exercises the real collection child.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  const linesFrom = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  const dryRunListOptions = () => ({
    runVitestListImpl: async (_command: string, args: string[], options: { cwd: string }) => {
      const requested = args.at(-1);
      expect(requested).toBe('lib/__tests__/test-file-router.test.ts');
      return {
        status: 0,
        stdout: `${resolve(options.cwd, requested!)}\n`,
        stderr: '',
        timedOut: false,
        error: null,
      };
    },
  });

  it('a dry run does NOT print TEST_FILE_RESULT', async () => {
    const code = await main(
      ['--dry', 'packages/operator-core/lib/__tests__/test-file-router.test.ts'],
      dryRunListOptions(),
    );
    expect(code).toBe(0);
    expect(linesFrom(logSpy)).not.toContain('TEST_FILE_RESULT');
  });

  it('a dry run still reports machine-readably, under its own marker', async () => {
    await main(
      ['--dry', 'packages/operator-core/lib/__tests__/test-file-router.test.ts'],
      dryRunListOptions(),
    );
    const out = linesFrom(logSpy);
    expect(out).toContain('TEST_FILE_DRYRUN');
    expect(out).toMatch(/TEST_FILE_DRYRUN .*executed=0 .*status=dry-run/);
  });

  // Non-vacuousness: the assertions above would also pass if main() silently printed nothing at
  // all, or if the file never matched. Pin that the run genuinely resolved a real test file —
  // otherwise this suite would keep passing after a regression that breaks routing entirely.
  it('the dry run really matched the requested file (guards against a vacuous pass)', async () => {
    await main(['--dry', 'packages/operator-core/lib/__tests__/test-file-router.test.ts']);
    const out = linesFrom(logSpy);
    expect(out).toMatch(/TEST_FILE_DRYRUN requested=1 .*matched=1/);
    expect(out).toContain('matched lib/__tests__/test-file-router.test.ts');
  }, 150_000);
});

describe('parseTransformFailure (EI-19462803905923939)', () => {
  // Captured VERBATIM from a real `vitest list` run against vitest 4 + esbuild (2026-08-03),
  // reproduced outside the shared tree so nothing had to be mutated to obtain it.
  const REAL_ESBUILD_OUTPUT = [
    'Error: Transform failed with 1 error:',
    '/tmp/pc-transform-probe/case2/dep.ts:4:1: ERROR: Unexpected "*"',
    '  Plugin: vite:esbuild',
    '  File: /tmp/pc-transform-probe/case2/dep.ts:4:1',
    '  ',
    '  Unexpected "*"',
    '  2  |   * a doc block',
    '  4  |   * stray continuation',
    '     |   ^',
  ].join('\n');

  it('extracts the culprit file, line and column from real esbuild output', () => {
    const locations = parseTransformFailure(REAL_ESBUILD_OUTPUT);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      file: '/tmp/pc-transform-probe/case2/dep.ts',
      line: 4,
      col: 1,
      message: 'Unexpected "*"',
    });
  });

  it('does not double-count the sibling `File:` line (which carries no ERROR:)', () => {
    // REAL_ESBUILD_OUTPUT names the same path twice; only the `: ERROR:` form is a real entry.
    expect(parseTransformFailure(REAL_ESBUILD_OUTPUT)).toHaveLength(1);
  });

  it('handles the RELATIVE culprit path esbuild prints when the file is inside the vite root', () => {
    // The originally-reported incident's exact shape — esbuild prints relative here, absolute above.
    const locations = parseTransformFailure(
      'Error: Transform failed with 1 error:\nlibs/generic/search/src/hybrid.ts:55:3: ERROR: Unexpected "*"\n',
    );
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({ file: 'libs/generic/search/src/hybrid.ts', line: 55, col: 3 });
  });

  it('fires on COLOURED output — the EI-18819483316574031 lesson, or it never fires for real', () => {
    // A sibling detector in this same file matched only clean text and so never fired once on real
    // vitest output. This is the calibration case: without the ANSI strip it returns [].
    const coloured =
      '\x1b[31mError: Transform failed with 1 error:\x1b[39m\n' +
      '\x1b[2m/tmp/x/dep.ts\x1b[22m:4:1: ERROR: Unexpected "*"\n';
    // Fixture-integrity guard: the escapes above must EVALUATE to real ESC bytes. Written as
    // '\x1b' rather than raw bytes so the source stays greppable/diffable (lint:no-control-bytes),
    // but that makes the fixture one stray backslash away from being inert text — '\\x1b' still
    // reads fine and still parses fine, leaving the test passing for nothing. This assertion is
    // what catches that; it has already caught it once.
    expect(coloured).toContain(`${String.fromCharCode(27)}[`);
    const locations = parseTransformFailure(coloured);
    expect(locations).toHaveLength(1);
    // The path must come back CLEAN. A culprit still carrying escape codes would never compare
    // equal to a requested route, silently degrading EVERY attribution to "external" — i.e.
    // cheerfully telling a caller their genuinely-broken file is fine.
    expect(locations[0].file).toBe('/tmp/x/dep.ts');
  });

  it('stays silent on a clean run (control)', () => {
    expect(parseTransformFailure(' Test Files  2 passed (2)\n      Tests  5 passed (5)\n')).toEqual([]);
  });

  it('stays silent on an ORDINARY assertion failure (control — must not hijack normal reds)', () => {
    const normalRed = [
      ' FAIL  lib/thing.test.ts > adds',
      'AssertionError: expected 1 to be 2',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed (1)',
    ].join('\n');
    expect(parseTransformFailure(normalRed)).toEqual([]);
  });
});

describe('transformFailureMarker — the attribution (EI-19462803905923939)', () => {
  const cwd = join(REPO_ROOT, 'packages/operator-core');
  const namedFile = join(cwd, 'lib/__tests__/tools-md-sync.test.ts');
  const routes = [{ absolute: namedFile }];
  const args = { routes, cwd, requested: 1, matched: 0 };

  it('returns null with no transform failure, so the caller keeps today’s output', () => {
    expect(transformFailureMarker({ ...args, locations: [] })).toBeNull();
  });

  it('an EXTERNAL culprit clears the named file and points at a peer mid-edit', () => {
    const marker = transformFailureMarker({
      ...args,
      locations: [
        { file: join(REPO_ROOT, 'libs/generic/search/src/hybrid.ts'), line: 55, col: 3, message: 'Unexpected "*"' },
      ],
    });
    expect(marker).toContain('TEST_FILE_TRANSFORM_ERROR');
    expect(marker).toContain('cause=transform');
    expect(marker).toContain('libs/generic/search/src/hybrid.ts:55:3');
    expect(marker).toContain('are FINE');
    expect(marker).toContain('PEER');
  });

  // THE control this whole function exists for. Case 1 and case 2 of the live reproduction produce
  // byte-identical esbuild output apart from the path, so an attribution that assumed "external"
  // would tell a caller whose OWN file has a syntax error that their file is fine — swapping one
  // confident false statement for another.
  it('a culprit the caller NAMED is never described as fine', () => {
    const marker = transformFailureMarker({
      ...args,
      locations: [{ file: namedFile, line: 4, col: 1, message: 'Unexpected "*"' }],
    });
    expect(marker).toContain('you NAMED');
    expect(marker).not.toContain('are FINE');
    expect(marker).not.toContain('PEER');
  });

  it('resolves a RELATIVE culprit path against the group cwd before deciding', () => {
    // Same file as `namedFile`, expressed the way esbuild prints it from inside the vite root.
    const marker = transformFailureMarker({
      ...args,
      locations: [{ file: 'lib/__tests__/tools-md-sync.test.ts', line: 4, col: 1, message: 'Unexpected "*"' }],
    });
    expect(marker).toContain('you NAMED');
    expect(marker).not.toContain('are FINE');
  });
});

describe('collectionAttributionMarker — the RUNTIME-crash sibling of transformFailureMarker (EI-19467022057492490)', () => {
  const cwd = join(REPO_ROOT, 'packages/operator-core');
  const args = { cwd, groupRequested: 3, groupMatched: 0 };

  it('returns null for an empty perFile list — nothing to attribute', () => {
    expect(collectionAttributionMarker({ ...args, perFile: [] })).toBeNull();
  });

  it('returns null for a missing perFile — caller keeps today’s undifferentiated output', () => {
    // The whole module is imported under a blanket @ts-expect-error (no .d.ts for this plain-Node
    // .mjs CLI), so `perFile` types as implicit `any` here — no directive needed on this call.
    expect(collectionAttributionMarker({ ...args })).toBeNull();
  });

  it('returns null when every file collects alone — the whole-group crash has no per-file cause to add', () => {
    const marker = collectionAttributionMarker({
      ...args,
      perFile: [
        { requested: 'a.test.ts', ok: true },
        { requested: 'b.test.ts', ok: true },
      ],
    });
    expect(marker).toBeNull();
  });

  it('an ALL-BROKEN batch names every file BROKEN and omits the "not the cause" hint entirely', () => {
    const marker = collectionAttributionMarker({
      ...args,
      perFile: [
        { requested: 'a.test.ts', ok: false },
        { requested: 'b.test.ts', ok: false },
      ],
    });
    expect(marker).toContain('TEST_FILE_COLLECTION_ATTRIBUTION');
    expect(marker).toContain('requested=3 matched=0');
    expect(marker).toContain('✗ BROKEN  a.test.ts');
    expect(marker).toContain('✗ BROKEN  b.test.ts');
    expect(marker).not.toContain('✓ ok');
    // With zero healthy files there is nothing to wrongly re-blame, so the caller doesn't need
    // the "treat only the broken ones as suspect" caveat — it would be noise here.
    expect(marker).not.toContain('Treat only the BROKEN');
  });

  // THE control this function exists for (mirrors the transformFailureMarker "never described as
  // fine" control above): a MIXED batch must name the broken file(s) as suspect and clear the
  // healthy one(s) by name, rather than letting the batch's matched=0 tar all of them equally —
  // the exact misattribution EI-19467022057492490 reproduced live.
  it('a MIXED batch names the broken file(s) and clears the healthy one(s) by name', () => {
    const marker = collectionAttributionMarker({
      ...args,
      perFile: [
        { requested: 'packages/operator-core/lib/memory/corpus-recall-io.test.ts', ok: true },
        { requested: 'packages/operator-core/lib/agent-tools/__tests__/search-tools.test.ts', ok: true },
        { requested: 'packages/operator-core/lib/agent-tools/sessions/search.test.ts', ok: false },
      ],
    });
    expect(marker).toContain('✗ BROKEN  packages/operator-core/lib/agent-tools/sessions/search.test.ts');
    expect(marker).toContain('✓ ok      packages/operator-core/lib/memory/corpus-recall-io.test.ts');
    expect(marker).toContain('✓ ok      packages/operator-core/lib/agent-tools/__tests__/search-tools.test.ts');
    expect(marker).toContain('NOT the cause');
    expect(marker).toContain('Treat only the BROKEN file(s) as suspect');
    // The marker explicitly tells the reader the healthy files are NOT "still red" — the exact
    // inversion this attribution exists to prevent — rather than leaving that unsaid.
    expect(marker).toContain('not "still red"');
  });

  it('labels the group cwd relative to the repo root, falling back to "." at the root itself', () => {
    const marker = collectionAttributionMarker({
      ...args,
      perFile: [{ requested: 'x.test.ts', ok: false }],
    });
    expect(marker).toContain('group cwd=packages/operator-core');

    const rootMarker = collectionAttributionMarker({
      ...args,
      cwd: REPO_ROOT,
      perFile: [{ requested: 'x.test.ts', ok: false }],
    });
    expect(rootMarker).toContain('group cwd=.');
  });
});

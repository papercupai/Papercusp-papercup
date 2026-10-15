/** EI-25449368540823559: exercise teardown without rerunning security journeys. */
import { fork, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { browserCachePath } from '../../../scripts/ensure-playwright-browsers.mjs';
import { defaultEvidenceRoot } from '@papercusp/verification-harness';
import { resolveTestRunHarnessSlug, resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';

const root = resolve(import.meta.dirname, '../../..');
const workerOptions = isolatedWorkerOptions(30_000);

it.runIf(process.platform === 'linux')('keeps native HOME and TMPDIR visible through the real sandbox device namespace', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-native-namespace-evidence-'));
  const deviceTmp = await mkdtemp('/dev/shm/isolated-native-namespace-');
  const hiddenConfig = join(deviceTmp, 'config.toml');
  await writeFile(hiddenConfig, 'host-visible-device-control');
  // This is the production SRT device mount, with no compensating /dev/shm
  // bind. Host readability alone missed the original CODEX_HOME failure.
  expect(readFileSync(hiddenConfig, 'utf8')).toBe('host-visible-device-control');
  const hidden = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--die-with-parent', '--', '/bin/cat', hiddenConfig], { encoding: 'utf8', timeout: 10_000 });
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: deviceTmp };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  let child: ReturnType<typeof fork> | undefined;
  try {
    expect(hidden.error).toBeUndefined();
    expect(hidden, hidden.stderr).toMatchObject({ status: 1, stdout: '' });
    expect(hidden.stderr).toContain('No such file or directory');
    child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--', process.execPath, '-e', `
      const assert = require('node:assert/strict');
      const { spawnSync } = require('node:child_process');
      const { mkdtempSync, writeFileSync, readFileSync, realpathSync } = require('node:fs');
      const { join, dirname } = require('node:path');
      for (const path of [process.env.HOME, process.env.TMPDIR, process.env.XDG_RUNTIME_DIR]) {
        const physical = realpathSync(path);
        assert.ok(!['/dev', '/proc'].some(prefix => physical === prefix || physical.startsWith(prefix + '/')), path);
      }
      const nativeHome = mkdtempSync(join(process.env.TMPDIR, 'codex-spawn-'));
      const config = join(nativeHome, 'config.toml');
      const state = join(nativeHome, 'native-state');
      writeFileSync(config, 'native-config-visible');
      const runtimeRoot = dirname(process.env.HOME);
      const result = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--bind', runtimeRoot, runtimeRoot, '--die-with-parent', '--', '/bin/sh', '-c',
        'cat "$1"; printf native-state > "$2"; test -d "$HOME"', 'native-control', config, state],
        { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'native-config-visible');
      assert.equal(readFileSync(state, 'utf8'), 'native-state');
      console.log('native-runtime-namespace-control');
    `], { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(120_000));
    expect(result, result.output.slice(-6000)).toMatchObject({ code: 0, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('native-runtime-namespace-control');
    const stages = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
      .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)));
    const complete = stages.find(message => message.stage === 'complete');
    expect(complete).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
    expect(existsSync(complete.runtimeRoot)).toBe(false);
    expect(existsSync(complete.dataDir)).toBe(false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(deviceTmp, { recursive: true, force: true });
  }
}, 180_000);

it('pre-mints the private operator spawn-signing key before admitting its first native launch', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-spawn-signing-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
    process.execPath, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import postgres from 'postgres';
      assert.match(process.env.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
      const url = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
      assert.equal(url.port, process.env.PAPERCUSP_PG_PORT);
      assert.notEqual(url.port, '5432');
      const sql = postgres(url.toString(), { max: 1 });
      try {
        const rows = await sql\`SELECT octet_length(decode(value_b64, 'base64')) AS bytes
          FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'\`;
        assert.equal(rows.length, 1, 'the signing key must exist before the first native launch');
        assert.equal(rows[0].bytes, 32);
        console.log('private-spawn-signing-ready');
      } finally { await sql.end(); }
    `], { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(120_000));
    expect(result, result.output.slice(-6000)).toMatchObject({ code: 0, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('private-spawn-signing-ready');
  } finally { await rm(evidenceDir, { recursive: true, force: true }); }
}, 180_000);

it('keeps HOME-dependent ripgrep executable assets available while product HOME stays isolated', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-ripgrep-assets-'));
  const originalHome = join(evidenceDir, 'original-home');
  const bin = join(originalHome, '.local/bin');
  await mkdir(bin, { recursive: true });
  const rg = join(bin, 'rg'), backing = join(bin, 'claude');
  // Exercise the installed shim's HOME-dependent executable contract with
  // controlled assets, so the guard also runs on hosts without Claude installed.
  await writeFile(rg, '#!/bin/bash\nset -eu\nexec "${CLAUDE_CODE_EXECPATH:-$HOME/.local/bin/claude}" "$@"\n', { mode: 0o700 });
  await writeFile(backing, '#!/bin/bash\nset -eu\n[[ "$1" == "--version" ]]\necho "ripgrep isolated-asset-control"\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: originalHome, PAPERCUSP_RG: rg,
    PATH: bin + ':' + process.env.PATH, TMPDIR: evidenceDir };
  delete env.CLAUDE_CODE_EXECPATH;
  delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--', process.execPath, '-e', `
    const assert = require('node:assert/strict');
    const { spawnSync } = require('node:child_process');
    assert.notEqual(process.env.HOME, ${JSON.stringify(originalHome)});
    assert.equal(process.env.PAPERCUSP_RG, ${JSON.stringify(rg)});
    assert.equal(process.env.CLAUDE_CODE_EXECPATH, ${JSON.stringify(backing)});
    const result = spawnSync(process.env.PAPERCUSP_RG, ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ripgrep isolated-asset-control');
    console.log('isolated-ripgrep-asset-control');
  `], { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(120_000));
    expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('isolated-ripgrep-asset-control');
  } finally { await rm(evidenceDir, { recursive: true, force: true }); }
}, 180_000);

it('retains successful original teardown when the isolated execution assertion rejects', async () => {
  let originalRunId = '';
  let failure: unknown;
  try {
    await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/isolated-runtime-cleanup.integration.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/isolated-integration-proof.ts'],
      execute: async (observe, evidenceDir) => {
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--', process.execPath, '-e', 'process.exit(1)'],
          { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(120_000));
        expect(result).toMatchObject({ code: 1, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        throw new Error('intentional post-cleanup execution rejection');
      },
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const detail = JSON.parse((failure as Error).message.split("\n")[0]);
  originalRunId = detail.runId;
  expect(detail.firstFailure).toMatchObject({ phase: 'execute' });
  expect(detail.phaseFailures).toHaveLength(1);
  expect(detail.phaseFailures[0].detail).toContain('intentional post-cleanup execution rejection');
  const evidence = join(defaultEvidenceRoot('isolated-integration'), originalRunId);
  const observed = JSON.parse(readFileSync(join(evidence, 'phases/execute/lifecycle-observation.json'), 'utf8'));
  expect(observed.ended).toMatchObject({ exitCode: 1, signal: null, runtimeRemoved: true, pgDataRemoved: true });
  expect(existsSync(observed.lifecycle.runtimeRoot)).toBe(false);
  expect(existsSync(observed.lifecycle.dataDir)).toBe(false);
}, 240_000);

it('pins plain-mode integration setup to its real private PG without injecting product URL overrides', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'private-admin-plain-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir,
    PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://refused:refused@192.0.2.1:5432/shared' };
  delete env.HARNESS_ADMIN_DATABASE_URL;
  delete env.HARNESS_DATABASE_URL;
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
    '--', process.execPath, '-e', `
      const assert = require('node:assert/strict');
      const postgres = require('postgres');
      (async () => {
        assert.equal(process.env.HARNESS_ADMIN_DATABASE_URL, undefined);
        assert.equal(process.env.HARNESS_DATABASE_URL, undefined);
        const url = new URL(process.env.PAPERCUSP_TEST_PG_ADMIN_URL);
        assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
        assert.equal(url.port, process.env.PAPERCUSP_PG_PORT);
        const sql = postgres(url.toString(), { max: 1 });
        try {
          const [row] = await sql\`SELECT inet_server_port() AS port, current_user AS role\`;
          assert.equal(String(row.port), process.env.PAPERCUSP_PG_PORT);
          assert.equal(row.role, 'harness_admin');
          const [sockets] = await sql\`SHOW unix_socket_directories\`;
          assert.equal(sockets.unix_socket_directories, '');
          console.log('plain-private-admin-control');
        } finally { await sql.end(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
  ], { cwd: root, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
    expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('plain-private-admin-control');
    const dataDir = result.output.match(/\(datadir (.+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, workerOptions.testTimeoutMs);

it('returns failure and tears down private PG when an executable passes preflight but its interpreter is missing', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'private-pg-late-spawn-'));
  const command = join(evidenceDir, 'missing-interpreter-command');
  await writeFile(command, `#!${join(evidenceDir, 'absent-interpreter')}\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--', command], {
    cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 120_000, killGraceMs: 45_000 });
    expect(result, result.output.slice(-8000)).toMatchObject({ code: 1, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('[with-test-pg] ready');
    expect(result.output).toContain('child failed to start');
    expect(result.output).not.toContain('child preflight failed');
    expect(result.output).toContain('database system is shut down');
    const dataDir = result.output.match(/\(datadir (.+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, 180_000);

it('stops real private PG and removes its runtime after an ordinary child exit', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/isolated-runtime-cleanup.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/process-identity.ts',
      'libs/generic/verification-harness/src/evidence-root.ts'],
    execute: async (observe, evidenceDir) => {
      await mkdir(join(evidenceDir, 'tmp'));
      const evidenceEnv = {
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter-only:fixture@127.0.0.1:1/ledger',
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(evidenceDir, 'reporter-receipts.jsonl'),
        PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-workspace',
        PAPERCUSP_TEST_RUN_HARNESS: 'ledger-harness',
        PAPERCUSP_TEST_RUN_GROUP: 'ledger-group',
        PAPERCUSP_TEST_RUN_SOURCE: 'mutation-probe',
        PAPERCUSP_TEST_RUN_COMMIT: 'abcdef123456',
        PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN: 'isolated-ledger-control',
      };
      const env: NodeJS.ProcessEnv = { ...process.env, ...evidenceEnv,
        PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: join(evidenceDir, 'tmp'),
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/tmp/forbidden-live-product-socket',
        PAPERCUSP_TEST_RUN_UNREGISTERED_ENDPOINT: 'http://127.0.0.1:1/forbidden',
        OPENAI_API_KEY: 'fixture-must-not-reach-private-runtime' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const expectedBrowserCache = browserCachePath(env);
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '-e', `
          const assert = require('node:assert/strict');
          const postgres = require('postgres');
          (async () => {
            for (const [key, expected] of Object.entries(${JSON.stringify(evidenceEnv)})) {
              assert.equal(process.env[key], expected, 'isolated reporter setting: ' + key);
            }
            assert.equal(process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET, undefined);
            assert.equal(process.env.PAPERCUSP_TEST_RUN_UNREGISTERED_ENDPOINT, undefined);
            assert.equal(process.env.OPENAI_API_KEY, undefined);
            assert.notEqual(process.env.PAPERCUSP_WORKSPACE_ID, process.env.PAPERCUSP_TEST_RUN_WORKSPACE);
            assert.notEqual(process.env.HARNESS_ADMIN_DATABASE_URL, process.env.PAPERCUSP_TEST_RUNS_DB_URL);
            console.log('isolated-reporter-env-control');
            const { defaultEvidenceRoot, runHarness } = await import('@papercusp/verification-harness');
            const artifactRoot = defaultEvidenceRoot('isolated-integration');
            const proof = await runHarness({
              contract: { name: 'isolated-integration', phases: [{ id: 'retention-control' }] },
              evidenceRoot: artifactRoot,
              runPhase: async () => ({ ok: true }),
            });
            console.log('ISOLATED_RETAINED_ARTIFACT ' + JSON.stringify({
              root: artifactRoot, runId: proof.runId, home: process.env.HOME,
              state: process.env.XDG_STATE_HOME,
            }));
            const { chromium } = require('playwright-core');
            const path = require('node:path');
            assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(expectedBrowserCache)});
            const browserPath = chromium.executablePath();
            assert.ok(browserPath.startsWith(process.env.PLAYWRIGHT_BROWSERS_PATH + path.sep), browserPath);
            assert.ok(!browserPath.startsWith(process.env.XDG_CACHE_HOME + path.sep), browserPath);
            const adminUrl = new URL(process.env.PAPERCUSP_TEST_PG_ADMIN_URL);
            assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname));
            assert.equal(adminUrl.port, process.env.PAPERCUSP_PG_PORT);
            assert.equal(adminUrl.toString(), new URL(process.env.HARNESS_ADMIN_DATABASE_URL).toString());
            const sql = postgres(adminUrl.toString(), { max: 1 });
            try {
              const [row] = await sql\`SELECT inet_server_port() AS port, current_user AS role\`;
              assert.equal(String(row.port), process.env.PAPERCUSP_PG_PORT);
              assert.equal(row.role, 'harness_admin');
              const [sockets] = await sql\`SHOW unix_socket_directories\`;
              assert.equal(sockets.unix_socket_directories, '');
              console.log('private-integration-admin-control');
            } finally { await sql.end(); }
            console.log('isolated-cleanup-control');
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
      ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const stages: string[] = [];
      child.on('message', message => {
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'isolated-runtime-cleanup' && 'stage' in message) {
          stages.push(String(message.stage));
        }
      });
      const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
      expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null, timedOut: false,
        exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toContain('isolated-cleanup-control');
      expect(result.output).toContain('private-integration-admin-control');
      expect(result.output).toContain('isolated-reporter-env-control');
      const artifactLine = result.output.split('\n').find(line => line.startsWith('ISOLATED_RETAINED_ARTIFACT '));
      expect(artifactLine, result.output.slice(-4000)).toBeTruthy();
      const artifact = JSON.parse(artifactLine!.slice('ISOLATED_RETAINED_ARTIFACT '.length));
      expect(existsSync(artifact.home)).toBe(false);
      expect(artifact.root, JSON.stringify(artifact)).toBe(defaultEvidenceRoot('isolated-integration'));
      expect(JSON.parse(readFileSync(join(artifact.root, artifact.runId, 'result.json'), 'utf8')).verdict).toBe('pass');
      expect(artifact.state).toBeDefined();
      expect(existsSync(artifact.state)).toBe(false);
      expect(stages).toEqual(expect.arrayContaining(['start', 'pg-stop', 'pg-stopped', 'remove-private-state', 'complete']));
    },
  });
  // The runtime workspace is disposable; the original source receipt must use
  // the same durable attribution as the canonical test-run reporter.
  const source = JSON.parse(readFileSync(join(defaultEvidenceRoot('isolated-integration'),
    runId, 'phases/prepare/source.json'), 'utf8'));
  expect(source.workspaceId).toBe(resolveTestRunWorkspaceId());
  expect(source.harnessSlug).toBe(resolveTestRunHarnessSlug());
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ISOLATED_CLEANUP_PREFLIGHT_PROOF_RUN ' + runId);
}, workerOptions.testTimeoutMs);

it.each([0, 7])('reports real private PG cleanup for an ordinary no-IPC isolated CLI with child exit %s', async exitCode => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-cli-cleanup-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir };
  delete env.PC_ISOLATED_RUNTIME_PROOF;
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
    '--isolated-runtime', '--', process.execPath, '-e', `console.log('ordinary-cli-child-finished'); process.exit(${exitCode});`,
  ], { cwd: root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    expect(child.connected).toBe(false);
    const result = await captureIsolatedWorker(child, evidenceDir, { ...workerOptions, cleanupFromStdout: true });
    expect(result, result.output.slice(-8000)).toMatchObject({ code: exitCode, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('ordinary-cli-child-finished');
    const stages = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
      .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)));
    expect(stages.map(message => message.stage)).toEqual(expect.arrayContaining([
      'start', 'pg-stop', 'pg-stopped', 'remove-private-state', 'complete',
    ]));
    const complete = stages.find(message => message.stage === 'complete');
    expect(complete).toMatchObject({ kind: 'isolated-runtime-cleanup', supervisorPid: child.pid,
      runtimeRemoved: true, pgDataRemoved: true });
    expect(complete.workspace).toMatch(/^test-runtime-/);
    expect(complete.runtimeRoot).toContain('papercusp-test-runtime-');
    expect(complete.dataDir).toContain('papercusp-test-pg-');
    expect(complete.pgPort).toBeGreaterThan(0);
    expect(existsSync(complete.runtimeRoot)).toBe(false);
    expect(existsSync(complete.dataDir)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    for (const stage of stages) {
      expect(stage).toMatchObject({ supervisorPid: child.pid, workspace: complete.workspace,
        runtimeRoot: complete.runtimeRoot, dataDir: complete.dataDir, pgPort: complete.pgPort });
      expect(stage.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    }
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, workerOptions.testTimeoutMs);

it('rejects a mixed candidate migration inventory before allocating private Postgres', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-migration-mismatch-'));
  try {
    const sqlDir = join(evidenceDir, 'candidate-sql');
    await mkdir(sqlDir);
    await writeFile(join(sqlDir, '9999-candidate-only.sql'), 'SELECT 1;');
    const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '-e', 'throw new Error("child must not start");',
    ], { cwd: root, env: { ...process.env, TMPDIR: evidenceDir, PAPERCUSP_PG_SQL_DIR: sqlDir },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 30_000 });
    expect(result).toMatchObject({ code: 1, signal: null, timedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('migration source inventory mismatch');
    expect(result.output).not.toContain('datadir ');
    expect(result.output).not.toContain('child must not start');
  } finally { await rm(evidenceDir, { recursive: true, force: true }); }
});

it.each(['child-exit', 'supervisor-SIGTERM'] as const)(
  'stops a stubborn grandchild before private-state removal after %s', async ending => {
    const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-stubborn-grandchild-'));
    const pidFile = join(evidenceDir, 'owned-pids.json');
    const signalFile = join(evidenceDir, 'grandchild-term.json');
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir };
    delete env.PC_ISOLATED_RUNTIME_PROOF;
    delete env.PC_HEAVY_PREEMPT_READY_FILE;
    delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
    const grandchildSource = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify({
        runtimeExists: fs.existsSync(process.env.HOME), pid: process.pid,
      })));
      process.send(process.pid);
      setInterval(() => {}, 1000);
    `;
    const childSource = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      ${ending === 'supervisor-SIGTERM' ? "process.on('SIGTERM', () => {});" : ''}
      const helper = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      helper.on('message', pid => {
        fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ leader: process.pid, helper: pid }));
        helper.disconnect();
        ${ending === 'child-exit' ? 'process.exit(7);' : 'setInterval(() => {}, 1000);'}
      });
    `;
    const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '-e', childSource,
    ], { cwd: root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let owned: { leader: number; helper: number } | undefined;
    try {
      const captured = captureIsolatedWorker(child, evidenceDir, { ...workerOptions, cleanupFromStdout: true });
      if (ending === 'supervisor-SIGTERM') {
        while (!existsSync(pidFile) && child.exitCode === null && child.signalCode === null) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(existsSync(pidFile)).toBe(true);
        child.kill('SIGTERM');
      }
      const result = await captured;
      owned = JSON.parse(readFileSync(pidFile, 'utf8'));
      expect(result, result.output.slice(-8000)).toMatchObject({
        code: ending === 'child-exit' ? 7 : null, signal: ending === 'child-exit' ? null : 'SIGTERM',
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
      });
      expect(JSON.parse(readFileSync(signalFile, 'utf8'))).toEqual({ runtimeExists: true, pid: owned!.helper });
      const stages = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)));
      const names = stages.map(stage => stage.stage);
      expect(names.indexOf('child-group-stopped')).toBeGreaterThan(names.indexOf('child-group-stop'));
      expect(names.indexOf('pg-stop')).toBeGreaterThan(names.indexOf('child-group-stopped'));
      expect(names.indexOf('remove-private-state')).toBeGreaterThan(names.indexOf('pg-stopped'));
      expect(stages.find(stage => stage.stage === 'complete')).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      for (const pid of [owned!.leader, owned!.helper]) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (existsSync(pidFile)) owned = JSON.parse(readFileSync(pidFile, 'utf8'));
      if (owned) { try { process.kill(-owned.leader, 'SIGKILL'); } catch { /* owned group already gone */ } }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        process.kill(-child.pid!, 'SIGKILL');
        await exited;
      }
      await rm(evidenceDir, { recursive: true, force: true });
    }
  }, workerOptions.testTimeoutMs,
);

it('cleans owned state when cancelled during real initdb before runtime-start', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-bootstrap-cancel-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
    '--isolated-runtime', '--', process.execPath, '-e', "throw new Error('cancelled bootstrap launched its child');",
  ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let cancelled = false;
  let dataDir: string | undefined;
  const messages: Array<Record<string, unknown>> = [];
  child.on('message', value => { if (value && typeof value === 'object') messages.push(value as Record<string, unknown>); });
  child.stdout!.on('data', chunk => {
    const output = String(chunk);
    dataDir ??= output.match(/\(datadir (.+)\)/)?.[1];
    if (!cancelled && output.includes('syncing data to disk')) {
      cancelled = true;
      // This fork owns the group from birth, including initdb; no host process
      // or shared database participates in the cancellation.
      process.kill(-child.pid!, 'SIGTERM');
    }
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 120_000, killGraceMs: 45_000 });
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ code: 143, signal: null, timedOut: false, stdioDrainTimedOut: false });
    expect(messages.some(message => message.kind === 'isolated-runtime-start')).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'isolated-runtime-cleanup', stage: 'complete', runtimeRemoved: true, pgDataRemoved: true }),
    ]));
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    }
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, 180_000);

it.each(['SIGINT', 'SIGTERM'] as const)('waits for cleanup on %s when the supervisor shares its caller process group', async signal => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-shared-group-cancel-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
    '--isolated-runtime', '--', process.execPath, '-e', 'setInterval(() => {}, 1000);',
  ], { cwd: root, detached: false, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: Array<Record<string, unknown>> = [];
  let runtimeRoot: string | undefined;
  let dataDir: string | undefined;
  let workerPid: number | undefined;
  child.on('message', value => {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    messages.push(message);
    if (message.kind === 'isolated-runtime-start') {
      runtimeRoot = String(message.runtimeRoot);
      dataDir = String(message.dataDir);
      workerPid = Number(message.childPid);
      // Signal only this supervisor. Its caller's group must remain untouched.
      child.kill(signal);
    }
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 120_000, killGraceMs: 45_000 });
    expect(result, result.output.slice(-8000)).toMatchObject({ code: null, signal, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'isolated-runtime-cleanup', stage: 'complete', runtimeRemoved: true, pgDataRemoved: true }),
    ]));
    expect(runtimeRoot).toBeDefined();
    expect(dataDir).toBeDefined();
    expect(existsSync(runtimeRoot!)).toBe(false);
    expect(existsSync(dataDir!)).toBe(false);
    expect(() => process.kill(workerPid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    // A failed negative control can leave its private PG alive. Its pid file
    // must still name this exact fixture before cleanup may signal it.
    if (dataDir && existsSync(join(dataDir, 'postmaster.pid'))) {
      const [pid, ownedDir] = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
      if (ownedDir === dataDir) {
        try { process.kill(Number(pid), 'SIGINT'); } catch { /* already stopped */ }
        for (let n = 0; n < 100 && existsSync(join(dataDir, 'postmaster.pid')); n++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    }
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, 180_000);

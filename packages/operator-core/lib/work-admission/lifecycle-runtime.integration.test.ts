/** Current-build background acceptance of merged-PR trust controls, private writes and teardown. */
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { resolveTestRunsPgUrl } from '@papercusp/test-config/admin-test-runs-reporter';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(__dirname, '../../../..');
const suite = 'packages/operator-core/lib/work-admission/lifecycle.integration.test.ts';

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('private PG cleanup probe timed out')); });
  });
}

it('reconciles late PR completion in a private background runtime and removes its state', async () => {
  const runId = await recordIsolatedIntegrationProof({
    root, filePath: 'packages/operator-core/lib/work-admission/lifecycle-runtime.integration.test.ts',
    sourcePaths: [suite, 'packages/operator-core/lib/work-admission/lifecycle.ts',
      'packages/operator-core/lib/work-admission/pr-delivery-audit.ts', 'scripts/with-test-pg.mjs'],
    retainedArtifacts: ['phases/execute/background-receipt.json', 'phases/execute/background-sources.json'],
    execute: async (observe, evidenceDir) => {
      const probe = `
        import assert from 'node:assert/strict';
        import { spawnSync } from 'node:child_process';
        import { readFileSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import postgres from 'postgres';
        const e = process.env;
        assert.notEqual(e.HOME, e.TEST_PRIOR_HOME);
        assert.notEqual(e.HARNESS_ADMIN_DATABASE_URL, e.TEST_PRIOR_DB);
        assert.notEqual(e.PAPERCUSP_WORKSPACE_ID, e.TEST_PRIOR_WORKSPACE);
        assert.match(e.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
        assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '1');
        assert.ok(!e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_SPAWNER_IPC_SOCKET);
        const sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
        try {
          await sql.unsafe('CREATE TABLE public.pr_reconciliation_runtime_sentinel (value text NOT NULL)');
          await sql.unsafe("INSERT INTO public.pr_reconciliation_runtime_sentinel VALUES ('private-write')");
          const result = spawnSync(process.execPath, ['scripts/test-files.mjs', ${JSON.stringify(suite)}], {
            cwd: process.cwd(), env: e, encoding: 'utf8', timeout: 240_000, maxBuffer: 20 * 1024 * 1024,
          });
          process.stdout.write(result.stdout ?? '');
          process.stderr.write(result.stderr ?? '');
          assert.equal(result.error, undefined);
          assert.equal(result.status, 0, 'background lifecycle assertion suite must pass');
          const capture = JSON.parse(readFileSync(e.PC_EXECUTED_SOURCE_MAP_OUT, 'utf8'));
          assert.equal(capture.nativeRun.reason, 'passed');
          assert.equal(capture.nativeRun.unhandledErrorCount, 0);
          const file = capture.nativeRun.files.find(row => row.testFile === ${JSON.stringify(suite)});
          assert.ok(file && file.execution.passed > 0);
          assert.equal(file.execution.failed, 0);
          assert.equal(file.execution.skipped, 0);
          for (const scenario of ['merged', 'merged-after-comment', 'wrong-fork', 'wrong-head', 'wrong-base',
            'closed', 'base-already-fixed', 'merge-lacks-fix', 'reopened', 'completion-changed']) {
            assert.ok(file.execution.passedCaseTitles.some(title => title.endsWith(': ' + scenario)), scenario);
          }
          const rows = await sql.unsafe('SELECT value FROM public.pr_reconciliation_runtime_sentinel');
          assert.deepEqual(rows.map(row => row.value), ['private-write']);
          const receipt = { workspace: e.PAPERCUSP_WORKSPACE_ID, home: e.HOME,
            databasePort: Number(new URL(e.HARNESS_ADMIN_DATABASE_URL).port), sentinelPreserved: true,
            passed: file.execution.passed, skipped: file.execution.skipped,
            sourceCapture: join(e.TEST_EVIDENCE_DIR, 'background-sources.json') };
          writeFileSync(join(e.TEST_EVIDENCE_DIR, 'background-receipt.json'), JSON.stringify(receipt));
          console.log('BACKGROUND_PR_RECONCILIATION_RECEIPT ' + JSON.stringify(receipt));
        } finally { await sql.end(); }
      `;
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', TEST_EVIDENCE_DIR: evidenceDir,
        TEST_PRIOR_HOME: process.env.HOME, TEST_PRIOR_DB: process.env.HARNESS_ADMIN_DATABASE_URL,
        TEST_PRIOR_WORKSPACE: process.env.PAPERCUSP_WORKSPACE_ID,
        PAPERCUSP_TEST_RUNS_DB_URL: resolveTestRunsPgUrl(),
        PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/operator-core',
        PC_EXECUTED_SOURCE_MAP_OUT: join(evidenceDir, 'background-sources.json') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
        process.execPath, '--input-type=module', '-e', probe], {
        cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(300_000));
      expect(result, result.output.slice(-6000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const receipt = JSON.parse(readFileSync(join(evidenceDir, 'background-receipt.json'), 'utf8'));
      expect(receipt).toMatchObject({ sentinelPreserved: true, skipped: 0, passed: expect.any(Number) });
      const cleanup = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length))).find(row => row.stage === 'complete');
      expect(cleanup).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      for (const path of [receipt.home, cleanup.runtimeRoot, cleanup.dataDir]) expect(existsSync(path), path).toBe(false);
      expect(await listening(receipt.databasePort)).toBe(false);
    },
  });
  expect(runId).toBeTruthy();
}, 600_000);

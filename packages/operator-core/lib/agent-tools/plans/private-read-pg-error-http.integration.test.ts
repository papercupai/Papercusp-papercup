import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('discloses actual SQLSTATE57014 from the selected private HTTP checkpoint reader and recovers', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/private-read-pg-error-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-read-pg-error-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/work_items/get.ts', 'packages/operator-core/lib/work-item-checkpoint.ts',
      'packages/operator-core/lib/carry-note.ts', 'packages/operator-core/lib/work-items.ts', 'packages/operator-core/lib/pg-read-query.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    retainedArtifacts: ['phases/execute/read-pg-error-pg.ndjson', 'phases/execute/read-pg-error-sqlstate.json'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'private-read-pg-error', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, result.output.slice(-6_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('PRIVATE_READ_PG_ERROR_HTTP_RECEIPT '));
      expect(line, result.output.slice(-6_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PRIVATE_READ_PG_ERROR_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ hostStopped: true, exactReadback: true, remainingWaits: [],
        cancellation: [{ pid: receipt.wait.pid, cancelled: true }],
        healthBefore: { service: 'papercusp-operator' }, healthAfter: { service: 'papercusp-operator' } });
      expect(receipt.wait.blockingPids).toContain(receipt.holderPid);
      // Actual PG log evidence binds the error code to the exact selected PID;
      // a successful pg_cancel_backend call alone does not prove SQLSTATE57014.
      const pgError = result.output.split('\n').find(row => new RegExp(
        `\\[${receipt.wait.pid}\\].*ERROR:\\s+57014:\\s+canceling statement due to user request`).test(row));
      expect(pgError, result.output.slice(-6_000)).toBeTruthy();
      await writeFile(join(evidenceDir, 'read-pg-error-sqlstate.json'), JSON.stringify({
        pid: receipt.wait.pid, sqlstate: '57014', pgError, cancellation: receipt.cancellation,
      }), { flag: 'wx' });
      const diagnostics = (await readFile(join(evidenceDir, 'read-pg-error-pg.ndjson'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      expect(diagnostics.map(row => row.stage)).toEqual(expect.arrayContaining([
        'selected-http-wait', 'selected-pg-cancel-sent', 'http-pg-error-returned', 'post-rollback', 'direct-readback-settled',
      ]));
      expect(diagnostics.find(row => row.stage === 'direct-readback-settled')).toMatchObject({ exactReadback: true });
      console.info('PRIVATE_READ_PG_ERROR_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

/** P-005: original current-build worker, real private writes and retained teardown. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const filePath = 'packages/operator-core/lib/harness/routines/plan-anchor-freshness-background.integration.test.ts';
const assertion = 'packages/operator-core/lib/plan-items/anchor-freshness-sweep.integration.test.ts';
const options = isolatedTestFileWorkerOptions(process.env, 1);

it('runs freshness, grouped default delivery and the active seed in an isolated background worker with cleanup', async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [assertion, 'packages/operator-core/lib/plan-items/anchor-freshness.ts',
      'packages/operator-core/lib/plan-items/anchor-freshness-sweep.ts',
      'packages/operator-core/lib/plan-items/anchor-store.ts', 'packages/operator-core/lib/plan-items/anchors.ts',
      'packages/operator-core/lib/harness/routines/plan-anchor-freshness-action.ts',
      'packages/operator-core/lib/harness/routines/seed-plan-anchor-freshness-routine.ts',
      'packages/operator-core/lib/harness/routines/system-actions.ts',
      'packages/operator-core/lib/workspace-als.ts', 'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/agent-tools/coordination/messages.ts',
      'packages/operator-core/lib/_baseline-coord-fixture.ts', 'packages/operator-core/test/_pg-helpers.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'libs/papercusp/libs/db/sql/1559-plan-item-code-anchors.sql',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/freshness-test-receipts.ndjson'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'freshness-test-receipts.ndjson');
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, resolve(root, 'scripts/test-files.mjs'), assertion], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-runtime-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-runtime-canary.sock' },
      });
      observe(child);
      child.on('message', (message: any) => {
        if (message.kind !== 'isolated-runtime-start') return;
        try {
          const env = Object.fromEntries(readFileSync(`/proc/${message.childPid}/environ`, 'utf8')
            .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
          expect(env).not.toHaveProperty('OPENAI_API_KEY');
          expect(env).not.toHaveProperty('PAPERCUSP_SUBSTRATE_IPC_SOCKET');
          expect(env.HOME).not.toBe(process.env.HOME);
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          environmentObserved = true;
        } catch { environmentError = new Error('private freshness worker environment isolation failed'); }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(environmentError).toBeUndefined();
        expect(environmentObserved).toBe(true);
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(value => value.filePath === assertion);
        expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: 8, failed: 0, skipped: 0, collectionFailed: false } } });
        expect(row.row.executionDetails.passedCaseTitles).toEqual(expect.arrayContaining([
          'default freshness notice delivery on the migrated coordination schema > seeds the declared schedule active by default and preserves an explicit pause on reseed',
          'default freshness notice delivery on the migrated coordination schema > uses the explicit workspace, finds real open holders, persists one coord message and replays its stable id',
        ]));
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

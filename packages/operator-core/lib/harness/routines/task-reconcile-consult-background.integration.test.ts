import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const filePath = 'packages/operator-core/lib/harness/routines/task-reconcile-consult-background.integration.test.ts';
const sourcePaths = [filePath,
  'packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts',
  'packages/operator-core/lib/harness/routines/task-reconcile-action.ts',
  'packages/operator-core/lib/task-manager/reaper.ts'];
const options = isolatedWorkerOptions(450_000);

it('loads current consult posts in an isolated background runtime and persists only a current final-answer settlement', async context => {
  const hashes = Object.fromEntries(sourcePaths.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths,
    execute: async (observe, evidenceDir) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, '--import', 'tsx',
        resolve(root, 'packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          CONSULT_REAPER_SOURCE_HASHES: JSON.stringify(hashes) },
      });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('CONSULT_REAPER_RECEIPT '));
        expect(line, result.output.slice(-8000)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('CONSULT_REAPER_RECEIPT '.length));
        expect(receipt.sourceHashes).toEqual(hashes);
        expect(receipt.workspaceId).toMatch(/^test-runtime-/);
        expect(receipt).toMatchObject({ unfinishedPosts: 3, unfinishedSettlement: null,
          finalPosts: 4, persistedSettlements: 1, finalAnswerAt: '2026-11-05T17:50:00.000Z' });
        console.info('CONSULT_REAPER_VERIFIED ' + JSON.stringify(receipt));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const filePath = 'packages/operator-core/lib/blueprint/operation-completion.runtime.integration.test.ts';
const fixturePath = 'packages/operator-core/test/fixtures/operation-completion-background.ts';
const workerOptions = isolatedWorkerOptions(220_000);
const sourcePaths = [filePath, fixturePath,
  'packages/operator-core/lib/blueprint/operation-service.ts',
  'packages/operator-core/lib/agent-tools/work_items/complete.ts',
  'packages/operator-core/lib/interactive-usage/ingest-claude-transcripts.ts',
  'packages/operator-core/lib/work-items.ts',
  'packages/operator-core/test/isolated-integration-proof.ts',
  'scripts/with-test-pg.mjs',
];

it('settles an admitted isolated background operation only after actual transcript convergence', async context => {
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths,
    execute: async (observe, evidenceDir) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', resolve(root, fixturePath)], {
        cwd: root, detached: true, env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        const detail = result.output.slice(-12_000);
        expect(result, detail).toMatchObject({ code: 0, signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const childHome = result.output.match(/^AI_COMPLETION_HOME (.+)$/m)?.[1];
        expect(childHome, detail).toBeTruthy();
        expect(existsSync(childHome!), 'private HOME must be removed by the maintained launcher').toBe(false);
        const dataDir = result.output.match(/\(datadir ([^)]+)\)/)?.[1];
        expect(dataDir, detail).toBeTruthy();
        expect(existsSync(dataDir!), 'private PG must be removed by the maintained launcher').toBe(false);
        const line = result.output.match(/^AI_COMPLETION_BACKGROUND_PROOF (.+)$/m)?.[1];
        expect(line, detail).toBeTruthy();
        const proof = JSON.parse(line!);
        expect(proof).toMatchObject({ synthetic: true, before: { state: 'open',
          settlement: { pending: 1, completed: 0, errors: [] } }, after: { state: 'done',
          output: { edition: 'immutable-private-edition' } }, ingested: { errors: [] } });
        expect(proof.controls).toEqual(['actor', 'item-stamp', 'claim-stamp', 'pin', 'output-snapshot',
          'deadline', 'model-policy', 'effort-policy']);
        expect(proof.countsAfter).toEqual(proof.countsBefore);
        console.info('AI_COMPLETION_ACCEPTANCE_RECEIPT ' + line);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, workerOptions.testTimeoutMs);

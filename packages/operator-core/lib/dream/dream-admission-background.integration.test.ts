import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const sourcePaths = ['packages/operator-core/test/_dream-admission-background-child.ts',
  'packages/operator-core/lib/dream/dream-cycle-action.ts', 'packages/operator-core/lib/dream/dream-config.ts',
  'packages/operator-core/lib/dream/dream-control-observations.ts', 'packages/operator-core/lib/gym/autoloop-tick.ts',
  'packages/operator-core/lib/harness/routines/gym-actions.ts', 'packages/operator-core/lib/autoloop.ts',
  'packages/operator-core/lib/owner-steering.ts', 'packages/operator-core/lib/serving-host-identity.ts',
  'scripts/with-test-pg.mjs', 'packages/operator-core/test/isolated-integration-proof.ts'];
const options = isolatedWorkerOptions(180_000);

it('observes production Dream/Gym policy refusals, a private write, and original child cleanup', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/dream/dream-admission-background.integration.test.ts', sourcePaths,
    retainedArtifacts: ['phases/execute/admission-receipt.json'],
    execute: async (observe, evidenceDir) => {
      const before = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', resolve(root, 'packages/operator-core/test/_dream-admission-background-child.ts')],
      { cwd: root, detached: true, env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', DREAM_ADMISSION_SOURCE_PATHS: JSON.stringify(sourcePaths) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, options);
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null, timedOut: false,
        exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('DREAM_ADMISSION_BACKGROUND_RECEIPT '));
      expect(line, result.output.slice(-8000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('DREAM_ADMISSION_BACKGROUND_RECEIPT '.length));
      expect(receipt.sourceFiles).toEqual(before);
      expect(receipt.workspace).toMatch(/^test-runtime-/);
      expect(receipt.runtime.processId).toBeTruthy();
      expect(receipt.dream).toMatchObject({ reason: 'owner-idle-disabled', paidCalls: 0, model: null, usage: null, costUsd: 0 });
      expect(receipt.gym).toMatchObject({ gate: 'owner-idle', status: 'refused' });
      expect(receipt.raw.status).toBe('observed');
      expect(receipt.raw.productionAdmission.status).toBe('unknown');
      expect(receipt.noPaidAttempts).toBe(true);
      expect(existsSync(receipt.runtimeRoot)).toBe(false);
      writeFileSync(resolve(evidenceDir, 'admission-receipt.json'), JSON.stringify(receipt));
      console.info('DREAM_ADMISSION_BACKGROUND_VERIFIED ' + JSON.stringify({ runtime: receipt.runtime,
        workspace: receipt.workspace, noPaidAttempts: true, runtimeRemoved: true, sourceFiles: receipt.sourceFiles,
        scope: receipt.scope, journalBoundary: receipt.journalBoundary }));
    } });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

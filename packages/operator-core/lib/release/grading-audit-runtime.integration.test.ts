import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { GradingRuntimeReceipt } from '../../test/grading-audit-runtime-fixture';
import {
  captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

it('retains one real exact-build endpoint, recovers process loss, and retires its last audit reference', async context => {
  const runId = await recordIsolatedIntegrationProof({
    root, filePath: 'packages/operator-core/lib/release/grading-audit-runtime.integration.test.ts',
    sourcePaths: [
      'packages/operator-core/test/grading-audit-runtime-fixture.ts',
      'packages/operator-core/lib/release/grading-audit-runtime.ts',
      'packages/operator-core/lib/release/grading-audit-source-pin.ts',
      'packages/operator-core/lib/task-manager/managed-spawn.ts',
      'packages/operator-core/lib/task-manager/control.ts',
      'packages/operator-core/lib/task-manager/store.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs',
      'apps/operator/bin/bundle-host.sh',
      'apps/operator/bin/bundle-host-common.sh',
    ],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        GRADING_RUNTIME_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'),
        ['--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath, '--import', 'tsx',
          join(root, 'packages/operator-core/test/grading-audit-runtime-fixture.ts')],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('GRADING_RUNTIME_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt: GradingRuntimeReceipt = JSON.parse(line!.slice('GRADING_RUNTIME_RECEIPT '.length));
        expect(receipt).toMatchObject({
          workspace: expect.stringMatching(/^test-runtime-/), reused: true, recovered: true,
          confined: true, exactHealth: true, partialReferenceRetained: true, scopeEmpty: true, pinRemoved: true,
          bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        console.info(line);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await rm(join(evidenceDir, 'node_modules'));
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

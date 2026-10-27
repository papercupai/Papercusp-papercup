import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { GradingKernelReceipt } from '../test/grading-audit-kernel-retirement-fixture';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const filePath = 'packages/operator-core/lib/grading-integrity.kernel-retirement.integration.test.ts';
const fixture = 'packages/operator-core/test/grading-audit-kernel-retirement-fixture.ts';
const options = isolatedWorkerOptions(180_000);

it('retains a real live auditor and terminally reconciles a kernel-ended auditor before routing', async context => {
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths: [fixture,
    'packages/operator-core/lib/grading-integrity.ts',
    'packages/operator-core/lib/task-manager/reconcile-tick.ts',
    'packages/operator-core/lib/task-manager/managed-spawn.ts',
    'packages/operator-core/lib/task-manager/store.ts',
    'packages/operator-core/test/private-http-workspace-preflight.ts', 'scripts/with-test-pg.mjs'],
  execute: async (observe, evidenceDir) => {
    await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
    await mkdir(join(evidenceDir, 'tmp'));
    const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
      GRADING_KERNEL_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
    delete env.PC_HEAVY_PREEMPT_READY_FILE;
    delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
    const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api',
      '--managed-tasks', '--', process.execPath, '--import', 'tsx', join(root, fixture)],
    { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    observe(child);
    try {
      const result = await captureIsolatedWorker(child, evidenceDir, options);
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('GRADING_KERNEL_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt: GradingKernelReceipt = JSON.parse(line!.slice('GRADING_KERNEL_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), outwardLaunches: 0,
        cases: [{ ended: false, routes: 0, notifications: 1 }, { ended: true, routes: 1, notifications: 0 }] });
      console.info(line);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await rm(join(evidenceDir, 'node_modules'));
    }
  } });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

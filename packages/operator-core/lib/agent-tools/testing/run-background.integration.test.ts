import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('accepts one dirty background test over current-build HTTP and retains its terminal source custody', async context => {
  let prepared: { sha256: string; receiptSha256: string };
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/testing/run-background.integration.test.ts',
    sourcePaths: ['packages/operator-core/lib/agent-tools/testing/run.ts',
      'packages/operator-core/lib/agent-tools/testing/run-artifacts.ts',
      'packages/operator-core/lib/testing-run-store.ts',
      'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/testing-background-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'scripts/with-test-pg.mjs'],
    retainedArtifacts: ['phases/execute/background-http-receipt.json',
      'phases/prepare/operator-api-build.log', 'phases/prepare/operator-api-build-result.json',
      'phases/prepare/hono-host.mjs.build-steps.jsonl'],
    prepare: async evidenceDir => {
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } });
    },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'testing-background', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, result.output.slice(-8_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('TESTING_BACKGROUND_HTTP_RECEIPT '));
      expect(line, result.output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('TESTING_BACKGROUND_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ hostStopped: true, executions: 1, cleanupComplete: true,
        accepted: { mode: 'background', status: 'pending', detachedDurable: true }, terminal: { status: 'pass' } });
      console.info('TESTING_BACKGROUND_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

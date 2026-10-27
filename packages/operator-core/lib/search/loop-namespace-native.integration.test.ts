import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

it('retains the canonical bootstrap pin through an actual native loop turn and isolated ingestion', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/search/loop-namespace-native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/loop-namespace-native-scenario.ts',
      'packages/operator-core/test/staging-first-http-fixture.ts', 'packages/operator-core/test/codex-budget-http-scenario.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts',
      'packages/operator-core/lib/search/session-ingest.ts',
      'packages/operator-core/lib/harness/routines/loop-turn-start-stamp.ts',
      'packages/operator-core/lib/harness/routines/loop.ts',
      'packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts',
      'packages/operator-core/lib/inference-gateway/codex-cli-bridge.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, STAGING_FIRST_HTTP_SCENARIO: 'loop-namespace-native' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
        if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line); });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('LOOP_NAMESPACE_NATIVE_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('LOOP_NAMESPACE_NATIVE_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        nativeLaunched: true, providerForwarding: false, hostStopped: true, via: 'loop-turn',
        loopFire: { wakeCount: 3 }, idempotent: true,
        transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      console.info('LOOP_NAMESPACE_NATIVE_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('LOOP_NAMESPACE_NATIVE_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

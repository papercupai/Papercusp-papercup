import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateRosterSocketRoot, preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';
import { verifyPrivateStopCleanup } from '../../../test/private-coord-receipt';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

for (const phase of ['positive', 'misroute'] as const) {
it(`confirmed roster stop through private HTTP and native children: ${phase}`, async context => {
  // it.each supplies only the row arguments; the ordinary callback owns the
  // context needed by the canonical runtime-proof reporter. Check it up front.
  expect(context.task.meta).toBeDefined();
  preparePrivateRosterSocketRoot();
  let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/__tests__/adv-sessions-stop.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/psu-pty-host-canary.mjs',
      'packages/operator-core/test/private-coord-receipt.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/adv-sessions.ts',
      'packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts',
      'packages/operator-core/lib/events/await/psu-pty-discovery.ts', 'apps/operator/scripts/psu-pty-host.mjs',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    // Build before allocating the private runtime so compilation cannot spend
    // the native journey's independent execute deadline.
    prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
      { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_STOP_HTTP_MUTATION: phase === 'misroute' ? phase : '' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
        '--prepared-api-sha=' + preparedApi.sha256, '--prepared-receipt-sha=' + preparedApi.receiptSha256],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
        if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
        exitWaitTimedOut: false, stdioDrainTimedOut: false, code: phase === 'positive' ? 0 : 1 });
      // The expected misroute exit must never hide an additional cleanup failure.
      verifyPrivateStopCleanup(result.output);
      if (phase === 'misroute') expect(result.output).toContain('selected-session receipt correlation');
      else {
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_STOP_HTTP_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('ROSTER_STOP_HTTP_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          selected: { ended: true }, neighbor: { alive: true }, accepted: { status: 200 }, replay: { status: 403 } });
        expect(receipt.selected.id).not.toBe(receipt.neighbor.id);
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ROSTER_STOP_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);
}

import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it('authenticated private HTTP roster delivery preserves exact recipients and denies foreign selections', async context => {
  expect(context.task.meta).toBeDefined();
  preparePrivateRosterSocketRoot();
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/__tests__/coord-roster-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/workspace-registry.ts', 'packages/operator-core/lib/workspace-context-middleware.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/adv-sessions.ts',
      'packages/operator-core/lib/auth.ts', 'packages/operator-core/lib/auth/require-principal.ts',
      'packages/operator-core/lib/auth/principal/from-cookie.ts',
      'packages/operator-core/lib/endpoint-route/routes/admin/coord.ts',
      'packages/operator-core/lib/agent-tools/coordination/messages.ts',
      'packages/operator-core/lib/agent-tools/coordination/recipient-resolve.ts',
      'packages/operator-core/lib/agent-tools/coordination/inbox-wake.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/send.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      delete env.ROSTER_STOP_HTTP_MUTATION;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
        if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
        exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
      expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
      const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('ROSTER_COORD_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        authMethod: 'cookie-session', neighborIsolated: true, positiveControl: 'wrong-recipient rejected',
        denialStatuses: [403, 403, 403, 403, 403] });
      expect(receipt.selected).not.toBe(receipt.neighbor);
      expect(new Set(receipt.selectedMessageIds).size).toBe(2);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ROSTER_COORD_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

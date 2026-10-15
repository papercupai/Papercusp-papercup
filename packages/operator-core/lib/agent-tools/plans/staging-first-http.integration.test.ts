import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('accepts deployment-contract preparation through the current-build HTTP guard while retaining actual release waits', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/staging-first-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/plans/staging-first-activation-guard.ts',
      'packages/operator-core/lib/agent-tools/plans/audit.ts',
      'packages/operator-core/lib/agent-tools/plans/source.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'packages/operator-core/lib/workspace-registry.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      const failures = result.output.split('\n').filter(line => /STAGING_FIRST_HTTP_FAILURE|^Error:|AssertionError|operator-api preflight failed/.test(line));
      expect(result, failures.join('\n') || result.output.slice(-4_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('STAGING_FIRST_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('STAGING_FIRST_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        health: { service: 'papercusp-operator' } });
      expect(receipt.requests.map((request: any) => [request.action, request.status, request.error])).toEqual([
        ...['Finalize', 'Define', 'Specify', 'Select', 'Choose', 'Design'].map(action => [action, 200, 'activation_audit_invalid']),
        ...['main promotion', 'the deployed host', 'green-checkpoint'].map(action => [action, 200, 'staging_first_guard_failed']),
      ]);
      console.info('STAGING_FIRST_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('STAGING_FIRST_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

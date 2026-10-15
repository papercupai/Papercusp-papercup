/** P011: production HTTP acknowledgement while its actual launch lease waits. */
import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

it('reply and decline acknowledge persisted posts before the private production dispatcher acquires its lease', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/consult/consult-cascade-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/consult-cascade-http-fixture.ts',
      'libs/generic/verification-harness/src/evidence-root.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/consult/cascade-core.ts', 'packages/operator-core/lib/consult/consult-dispatch.ts',
      'packages/operator-core/lib/consult/consult-verbs-core.ts',
      'packages/operator-core/lib/consult/relevance-router.ts', 'libs/generic/memory/src/sidecar-embedder.ts',
      'packages/operator-core/lib/consult/get-feedback-prod.ts', 'packages/operator-core/lib/endpoint-route/telemetry.ts',
      'packages/operator-core/lib/agent-tools/consult/reply.ts', 'packages/operator-core/lib/agent-tools/consult/decline.ts',
      'packages/operator-core/lib/agent-tools/index.ts', 'packages/operator-core/lib/agent-tools/agent_tools/list.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        CONSULT_CASCADE_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/consult-cascade-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('CONSULT_CASCADE_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      const errors = result.output.split('\n').filter(line => /CONSULT_CASCADE_HTTP_FAILURE|operator-api preflight failed/.test(line));
      expect(result, errors.join('\n') || result.output.slice(-4000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('CONSULT_CASCADE_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('CONSULT_CASCADE_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' } });
      expect(receipt.catalogNames).toEqual(expect.arrayContaining([
        'consult:get_feedback', 'consult:reply', 'consult:decline', 'consult:close', 'plans:start',
      ]));
      expect(receipt.catalogNames).not.toContain('consult:reconcile');
      expect(receipt.requests.map((request: any) => [request.kind, request.pending, request.leaseWaitObserved,
        request.persistedPosts, request.afterRelease])).toEqual([
        ['reply', true, true, 1, 'no-launch-refusal'], ['decline', true, true, 1, 'no-launch-refusal'],
      ]);
      expect(receipt.diagnosticRequests).toEqual([
        expect.objectContaining({ control: 'healthy', embeddingOutcome: 'returned', embeddingErrorCode: null,
          telemetryMatches: true }),
        expect.objectContaining({ control: 'timeout', embeddingOutcome: 'threw', embeddingErrorCode: 'ABORT_ERR',
          telemetryMatches: true }),
      ]);
      console.info('CONSULT_CASCADE_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('CONSULT_CASCADE_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

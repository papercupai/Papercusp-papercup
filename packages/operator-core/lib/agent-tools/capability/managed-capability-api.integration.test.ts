/** Integration proof: actual HTTP MCP client, private operator identity and PostgreSQL. */
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';

describe('managed capability acceptance over the production HTTP route', () => {
  it('retains kernel/browser state across fresh clients and refuses PTY without a private session bus', async context => {
    const root = resolve(__dirname, '../../../../..');
    let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>>;
    const runId = await recordIsolatedIntegrationProof({
      root, filePath: 'packages/operator-core/lib/agent-tools/capability/managed-capability-api.integration.test.ts',
      sourcePaths: ['packages/operator-core/lib/agent-tools/capability/read-handler.ts',
        'packages/operator-core/lib/agent-tools/capability/patch.ts',
        'packages/operator-core/lib/agent-tools/capability/__fixtures__/managed-api-client.mts',
        'packages/operator-core/lib/agent-tools/capability/__fixtures__/managed-api-result.ts'],
      retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/managed-api-proof.json'],
      prepare: async evidenceDir => {
        prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
          builder: { timeoutMs: 240_000, maxMs: 420_000, env: { ...process.env, VITEST: 'true' } },
        });
      },
      execute: async (observe, evidenceDir) => {
        await symlink(resolve(root, 'node_modules'), resolve(evidenceDir, 'node_modules'), 'dir');
        const childEnv: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir };
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
          'PAPERCUSP_TEST_RUNS_DB_URL']) delete childEnv[key];
        const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
          resolve(__dirname, '__fixtures__/managed-api-client.mts'),
          '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256,
        ], { cwd: root, env: childEnv, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, isolatedTestFileWorkerOptions(childEnv, 1)); }
        finally { await rm(resolve(evidenceDir, 'node_modules')); }
        expect(result.code, result.output).toBe(0);
        const cleanup = result.output.split('\n').find(row => row.startsWith('MANAGED_API_CLEANUP='));
        expect(cleanup, result.output).toBeDefined();
        expect(JSON.parse(cleanup!.slice('MANAGED_API_CLEANUP='.length))).toMatchObject({
          rows: 1, processes: 'gone', browserRoots: 'gone', terminalRecorded: true,
        });
        const line = result.output.split('\n').find(row => row.startsWith('MANAGED_API_PROOF='));
        expect(line, result.output).toBeDefined();
        const proof = JSON.parse(line!.slice('MANAGED_API_PROOF='.length));
        expect(proof).toMatchObject({ transport: 'http', kernel: 'retained-across-clients', browser: 'retained-across-clients',
          image: 'original-raster', patch: 'canonical-peer-lock-and-all-hunks',
          pty: 'refused-without-private-session-bus', foreignHandles: 'refused' });
        await writeFile(resolve(evidenceDir, 'managed-api-proof.json'), JSON.stringify(proof));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_MANAGED_API_PROOF_RUN ' + runId);
  }, 600_000);
});

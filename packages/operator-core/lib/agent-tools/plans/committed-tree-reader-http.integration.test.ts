import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle, withCommittedReaderOriginalPreparation,
  produceCommittedReaderPrivateApiBundle } from '../../../test/private-http-workspace-preflight';
import type { CommittedReaderCallerContract } from '../../../test/private-http-workspace-preflight';

const options = isolatedWorkerOptions(480_000);

/** An admitted caller supplies this typed contract directly. The ordinary test
 * has no original delivery yet and must refuse before any allocation. */
export async function measureCommittedReaderHttp(contract?: CommittedReaderCallerContract) {
  let prepared: ReturnType<typeof preparePrivateOperatorApiBundle> | undefined;
  const filePath = 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader-http.integration.test.ts';
  const sourcePaths = ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/committed-reader-http-scenario.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/_org-test-db.ts',
      'packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts',
      'packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts',
      'packages/operator-core/lib/agent-tools/plans/get-spec-evidence.ts',
      'packages/operator-core/lib/fleet/git-via-sidecar.ts',
      'packages/operator-core/lib/fleet/spawner-ipc-client.ts',
      'packages/operator-core/lib/fleet/spawner-sidecar-server.ts',
      'packages/operator-core/lib/fleet/sidecar-exec-process.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts', 'scripts/source-preview.mjs',
      'packages/operator-core/lib/process-identity.ts'];
  const configPaths = ['package.json', 'packages/operator-core/package.json',
    'packages/operator-core/vitest.integration.config.ts', 'scripts/test-files.mjs'];
  if (contract) {
    assert.equal(contract.testPath, filePath, 'Explicit HTTP test selection differs');
    assert.deepEqual([...new Set(contract.helperPaths)].sort(), [...new Set(sourcePaths)].sort(),
      'Explicit HTTP helper population differs');
    assert.deepEqual([...new Set(contract.configPaths)].sort(), [...new Set(configPaths)].sort(),
      'Explicit HTTP config population differs');
  }
  return withCommittedReaderOriginalPreparation(contract, async preparation => {
    const proofRoot = preparation.root;
    const runId = await recordIsolatedIntegrationProof({ root: proofRoot, filePath, sourcePaths,
      requiredPreparation: preparation.identity, prepare: async evidenceDir => {
        prepared = produceCommittedReaderPrivateApiBundle(proofRoot, evidenceDir, {
          sourceReceiptPath: preparation.sourceReceiptPath, inputReceiptPath: preparation.inputReceiptPath,
          selectedCommit: preparation.selectedCommit,
        });
        return preparation;
      },
      execute: async (observe, evidenceDir) => {
      assert.ok(prepared?.selectedSource, 'Committed reader preparation must precede private runtime allocation');
      await symlink(join(proofRoot, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'committed-reader', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(proofRoot, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(proofRoot, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared.sha256, '--prepared-receipt-sha=' + prepared.receiptSha256],
      { cwd: proofRoot, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
      const line = result.output.split('\n').find(row => row.startsWith('COMMITTED_READER_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('COMMITTED_READER_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' } });
      expect(receipt.requests.map((request: any) => request.action)).toEqual(['cold', 'warm', 'timeout', 'recovery']);
      console.info('COMMITTED_READER_HTTP_VERIFIED ' + JSON.stringify({ workspace: receipt.workspace,
        commit: receipt.commit, actions: receipt.requests.map((request: any) => ({ action: request.action,
          invocationId: request.ledger.id, counters: request.counters })) }));
      },
    });
    return runId;
  });
}

it('refuses the HTTP test before allocation when no original caller contract is provided', async () => {
  await expect(measureCommittedReaderHttp()).rejects.toThrow(
    'Explicit committed reader caller contract is required before allocations');
});

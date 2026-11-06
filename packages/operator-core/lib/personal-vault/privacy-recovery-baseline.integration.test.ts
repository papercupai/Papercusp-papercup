/** P-009 runtime discovery. Timing qualification requires a separate approved profile. */
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000, process.env, 720_000);

it('retains the actual private operator population, signed custody and migrated schema without claiming closure', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/personal-vault/privacy-recovery-baseline.integration.test.ts',
    sourcePaths: ['packages/operator-core/test/vault-runtime-census-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/observability/runtime.ts',
      'packages/operator-core/lib/coverage-census/providers/dbos-workflows.ts',
      'packages/operator-core/lib/dbos/bootstrap.ts',
      'packages/operator-core/lib/dbos/event-reaction-workflow.ts',
      'packages/operator-core/lib/events/registry.ts',
      'packages/operator-core/lib/coverage-census/security-qualification.ts',
      'packages/operator-core/lib/coverage-census/security-manifest-store.ts',
      'packages/operator-core/lib/superuser-token.ts',
      'packages/operator-core/lib/auth/principal/from-superuser-token.ts',
      'packages/operator-core/lib/release/operator-artifact.ts',
      'apps/operator/bin/host-handler.ts', 'apps/operator/bin/host-bootstrap.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'scripts/with-test-pg.mjs'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/vault-runtime-census-fixture.ts')],
      { cwd: root, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          VAULT_CENSUS_EVIDENCE_DIR: evidenceDir } });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('VAULT_CENSUS_STAGE=')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('VAULT_CENSUS_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('VAULT_CENSUS_RECEIPT '.length));
      const build = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
      expect(build.status).toBe(0);
      expect(build.progress.completedSteps).toBeGreaterThan(0);
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        transport: 'mcp', authenticatedActor: expect.stringMatching(/^su-/), unauthenticatedRejected: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        populationComplete: false, closureAccepted: false, qualifyingBaselineAccepted: false,
        backgroundRuntime: 'captured', dbosSchema: 'dbos',
        dbosWorkflowCount: expect.any(Number), reactionCount: expect.any(Number),
        recoveryAdapters: 'not-reconciled' });
      expect(receipt.dbosWorkflowCount).toBeGreaterThan(0);
      expect(receipt.reactionCount).toBeGreaterThan(0);
      const snapshot = JSON.parse(readFileSync(join(evidenceDir, 'runtime-census.json'), 'utf8'));
      expect(snapshot.runtimeIdentity.artifact.bundleSha256).toBe(receipt.bundleSha256);
      expect(snapshot.rows).toHaveLength(receipt.runtimeRows);
      expect(snapshot.rows.some((row: any) => row.basis === 'serving-registry')).toBe(true);
      expect(snapshot.rows.some((row: any) => row.basis === 'declared-route')).toBe(true);
      expect(snapshot.rows.some((row: any) => row.kind === 'dbos-workflow'
        && row.attrs.name === 'eventReaction' && row.attrs.executorLaunched === true)).toBe(true);
      console.info('VAULT_CENSUS_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('VAULT_CENSUS_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

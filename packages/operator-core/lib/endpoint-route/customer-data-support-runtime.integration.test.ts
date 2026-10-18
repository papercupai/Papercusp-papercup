/** P-010: real operator composition, private identities, no shared customer writes. */
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const workerOptions = isolatedWorkerOptions(480_000);

it('exports customer data through the current operator bundle only for scoped staff with live customer consent', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/customer-data-support-runtime.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
      'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/customer-data-support-http-fixture.ts',
      'packages/operator-core/lib/endpoint-route/routes/admin/customer-data.ts',
      'packages/operator-core/lib/endpoint-route/routes/index.ts',
      'packages/operator-core/lib/auth/principal/from-cookie.ts',
      'packages/operator-core/lib/auth.ts',
      'packages/operator-core/lib/auth/hosted/customer-data-map.ts',
      'packages/operator-core/lib/auth/hosted/governance.ts',
      'packages/operator-core/lib/data-governance/hosted-customer-data-support.ts',
      'packages/operator-core/lib/data-governance/organization-data-receipts.ts',
      'libs/papercusp/libs/db/sql/1509-hosted-customer-data-workspace-export.sql',
      'libs/papercusp/libs/db/sql/1513-hosted-customer-deletion-freeze.sql.DRAFT',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        CUSTOMER_DATA_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      try {
        const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
          resolve(root, 'packages/operator-core/test/customer-data-support-http-fixture.ts'),
        ], { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        expect(result, result.output.slice(-12_000)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('CUSTOMER_DATA_HTTP_RECEIPT '));
        expect(line, result.output.slice(-8_000)).toBeTruthy();
        expect(JSON.parse(line!.slice('CUSTOMER_DATA_HTTP_RECEIPT '.length))).toMatchObject({
          exported: true, tenantIsolated: true, wildcardRefused: true, revokedConsentRefused: true,
          revokedSessionRefused: true, auditReceipts: 1, hostStopped: true,
          bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } finally { await rm(join(evidenceDir, 'node_modules'), { force: true }); }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('CUSTOMER_DATA_HTTP_PROOF_RUN ' + runId);
}, workerOptions.testTimeoutMs);

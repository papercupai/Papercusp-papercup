/** P-016 current-build background acceptance. Runs the real action/DBOS suite
 * through the maintained private-runtime supervisor, retaining original child
 * identity and cleanup rather than treating an action unit pass as live proof.
 * Provider responses and alert recipients remain private fixtures.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const filePath = 'packages/operator-core/lib/harness/routines/hosted-billing-background-runtime.integration.test.ts';
const assertion = 'packages/operator-core/lib/harness/routines/hosted-billing-reconcile-action.integration.test.ts';
const options = isolatedTestFileWorkerOptions(process.env, 1);

it('repairs and replays billing with provider and IPC isolation, survives process death and removes its private state', async context => {
  let privateEnvironmentObserved = false;
  let privateEnvironmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({
    root, filePath,
    sourcePaths: [assertion,
      'packages/operator-core/test/_hosted-billing-routine-crash-child.ts',
      'packages/operator-core/test/_org-test-db.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/harness/routines/hosted-billing-reconcile-action.ts',
      'packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts',
      'packages/operator-core/lib/harness/routines/claim.ts',
      'packages/operator-core/lib/harness/routines/system-actions.ts',
      'packages/operator-core/lib/dbos/routines-workflow.ts',
      'packages/operator-core/lib/auth/hosted/billing/billing-store.ts',
      'packages/operator-core/lib/auth/hosted/billing/billing-recovery.ts',
      'packages/operator-core/lib/auth/hosted/billing/stripe-billing-client.ts',
      'packages/operator-core/lib/auth/hosted/billing/stripe-billing-events.ts',
      'libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs',
      'scripts/lib/executed-source-map.mjs', 'scripts/lib/batch-watchdog.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/billing-test-receipts.ndjson'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'billing-test-receipts.ndjson');
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, resolve(root, 'scripts/test-files.mjs'), assertion], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          // Only the test reporter may reach this explicit durable evidence sink.
          // Product database URLs are replaced by the supervisor's private pins.
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          // Canary values prove scrubbing without sending any live credentials.
          OPENAI_API_KEY: 'forbidden-private-runtime-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-runtime-canary.sock',
          PAPERCUSP_BILLING_STRIPE_SECRET_REF: 'forbidden-private-runtime-canary',
        },
      });
      observe(child);
      child.on('message', (message: any) => {
        if (message.kind !== 'isolated-runtime-start') return;
        try {
          const env = Object.fromEntries(readFileSync(`/proc/${message.childPid}/environ`, 'utf8')
            .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
          for (const key of ['OPENAI_API_KEY', 'PAPERCUSP_SUBSTRATE_IPC_SOCKET', 'PAPERCUSP_BILLING_STRIPE_SECRET_REF'])
            expect(env).not.toHaveProperty(key);
          expect(env.HOME).not.toBe(process.env.HOME);
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          privateEnvironmentObserved = true;
        } catch { privateEnvironmentError = new Error('private billing runtime environment isolation failed'); }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(privateEnvironmentError).toBeUndefined();
        expect(privateEnvironmentObserved).toBe(true);
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(value => value.filePath === assertion);
        expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: 5, failed: 0, skipped: 0, collectionFailed: false,
        } } });
        expect(row.row.executionDetails.passedCaseTitles).toContain(
          'hosted billing reconciliation action composition (real Postgres) > recovers the actual durable routine after process death between billing commit and DBOS checkpoint');
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

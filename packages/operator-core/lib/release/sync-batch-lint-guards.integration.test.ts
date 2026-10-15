/** P028 background IO acceptance uses the maintained private runtime/proof harness. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';
import type { SyncLintPrivateReceipt } from '../../test/_sync-batch-lint-guards-child';

const root = resolve(import.meta.dirname, '../../../..');
const filePath = 'packages/operator-core/lib/release/sync-batch-lint-guards.integration.test.ts';
const sourcePaths = [filePath, 'packages/operator-core/test/_sync-batch-lint-guards-child.ts',
  'packages/operator-core/lib/release/sync-batch-lint-guards.ts',
  'packages/operator-core/lib/release/sync-batch-lint-guards-deps.ts',
  'packages/operator-core/lib/release/sync-batch-delta-check-deps.ts',
  'packages/operator-core/lib/release/sync-batch-delta-check.ts',
  'packages/operator-core/lib/agent-tools/work_items/_create-core.ts',
  'packages/operator-core/lib/agent-tools/coordination/messages.ts',
  'packages/operator-core/lib/agent-tools/coordination/inbox-wake.ts',
  'packages/operator-core/lib/events/await/store.ts',
  'packages/operator-core/lib/events/await/engine.ts',
  'packages/operator-core/lib/automation/routine-classification.ts',
  'scripts/check-no-raw-setinterval.mjs', 'scripts/with-test-pg.mjs',
  'packages/operator-core/test/isolated-integration-proof.ts'];
const workerOptions = isolatedWorkerOptions(180_000);

it('runs a real guard child, files its seeded red and queues the ledgered editor wake in private PG', async context => {
  const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths,
    execute: async (observe, evidenceDir) => {
      // The nested isolated child is not a test reporter, so the outer runner's
      // per-process evidence sinks must not leak into it. The mutation probe
      // exports PAPERCUSP_TEST_RUN_RECEIPT_FILE per phase, and with-test-pg
      // --isolated-runtime refuses a receipt sink without a ledger URL. That
      // failed every mutation-probe baseline (WI-6554700010010481).
      const childEnv = { ...process.env };
      delete childEnv.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
      delete childEnv.PC_EXECUTED_SOURCE_MAP_RESULT;
      // Filing would embed the new item, loading the native onnxruntime
      // embedder in this child. Its teardown intermittently aborts with
      // "corrupted double-linked list" (SIGABRT) AFTER the receipt prints, on
      // GPU and on a CPU pin alike (WI-6554700010010481, WI-10005599). The
      // proof is about guard filing and wakes, not embeddings, so disable the
      // embedder as su-session-attached-live.integration.test.ts does.
      childEnv.PAPERCUSP_MEMORY_EMBEDDER = 'disabled';
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', resolve(root, 'packages/operator-core/test/_sync-batch-lint-guards-child.ts')], {
        cwd: root, detached: true, env: { ...childEnv, PC_ISOLATED_RUNTIME_PROOF: '1',
          SYNC_LINT_EXPECTED_SOURCE_HASHES: JSON.stringify(sourceHashes) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        expect(result, result.output.slice(-12_000)).toMatchObject({ code: 0, signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('SYNC_LINT_PRIVATE_RECEIPT '));
        expect(line, result.output.slice(-8000)).toBeTruthy();
        const receipt: SyncLintPrivateReceipt = JSON.parse(line!.slice('SYNC_LINT_PRIVATE_RECEIPT '.length));
        expect(receipt.build.sourceHashes).toEqual(sourceHashes);
        expect(receipt.runtime.workspaceId).toMatch(/^test-runtime-/);
        expect(receipt.elapsedMs).toBeLessThan(15 * 60_000);
        expect(receipt.filing.assignee).toBe('su-11111111-2222-4333-8444-555555555555');
        expect(receipt.filing.conditionKey).toBe('sync-delta-guard:lint:no-raw-setinterval:src/timer.ts');
        expect(receipt.wake).toMatchObject({ queued: true, pickupConfirmed: false,
          eventKey: 'coord:inbox-wake:su-11111111-2222-4333-8444-555555555555' });
        expect(receipt.wake.deliveryId).toBeGreaterThan(0);
        const dataDir = result.output.match(/datadir ([^\)\n]+)/)?.[1];
        expect(dataDir).toBeTruthy();
        expect(existsSync(receipt.runtime.runtimeRoot)).toBe(false);
        expect(existsSync(dataDir!)).toBe(false);
        console.info('SYNC_LINT_PRIVATE_VERIFIED ' + JSON.stringify({ ...receipt,
          cleanup: { runtimeRemoved: true, pgDataRemoved: true } }));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, workerOptions.testTimeoutMs);

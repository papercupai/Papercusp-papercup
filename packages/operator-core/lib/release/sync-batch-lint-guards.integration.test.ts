/** P028 background IO acceptance uses the maintained private runtime/proof harness. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';
import type { SyncLintPrivateReceipt } from '../../test/_sync-batch-lint-guards-child';
import { preflightSyncLintPrivateCompiler } from '../../test/sync-lint-private-compiler';

const root = resolve(import.meta.dirname, '../../../..');
const filePath = 'packages/operator-core/lib/release/sync-batch-lint-guards.integration.test.ts';
const sourcePaths = [filePath, 'packages/operator-core/test/_sync-batch-lint-guards-child.ts',
  'packages/operator-core/test/sync-lint-private-compiler.ts',
  'packages/operator-core/lib/release/sync-batch-lint-guards.ts',
  'packages/operator-core/lib/release/sync-batch-lint-guards-deps.ts',
  'packages/operator-core/lib/release/sync-batch-delta-check-deps.ts',
  'packages/operator-core/lib/release/sync-batch-delta-check.ts',
  'packages/operator-core/lib/agent-tools/work_items/_create-core.ts',
  'packages/operator-core/lib/agent-tools/coordination/messages.ts',
  'packages/operator-core/lib/agent-tools/coordination/inbox-wake.ts',
  'packages/operator-core/lib/events/await/store.ts',
  'packages/operator-core/lib/events/await/engine.ts',
  'packages/operator-core/lib/events/await/interest-watch.ts',
  'packages/operator-core/lib/automation/routine-classification.ts',
  'packages/operator-core/lib/detached-imports/index.ts',
  'packages/operator-core/lib/degradation/fallback-observations.ts',
  'scripts/check-no-raw-setinterval.mjs', 'scripts/with-test-pg.mjs',
  'packages/operator-core/test/isolated-integration-proof.ts'];
const workerOptions = isolatedWorkerOptions(180_000);

it('runs the shared guard/typecheck proof and drains a real in-flight sweep after its body fails in private PG', async context => {
  const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  console.info('SYNC_LINT_COMPILER_PREFLIGHT ' + JSON.stringify(await preflightSyncLintPrivateCompiler(root)));
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths,
    execute: async (observe, evidenceDir) => {
      // The nested isolated child is not a test reporter, so the outer runner's
      // per-process evidence sinks must not leak into it. The mutation probe
      // exports PAPERCUSP_TEST_RUN_RECEIPT_FILE per phase, and with-test-pg
      // --isolated-runtime refuses a receipt sink without a ledger URL. That
      // failed every mutation-probe baseline (WI-6554700010010481).
      const childEnv = { ...process.env };
      childEnv.SYNC_LINT_EVIDENCE_DIR = evidenceDir;
      delete childEnv.PAPERCUSP_TEST_RUN_RECEIPT_FILE;
      delete childEnv.PC_EXECUTED_SOURCE_MAP_RESULT;
      // This proof exercises filing and wakes without embedding. Historical
      // SIGABRTs also occurred with this disabled, so retain native diagnostics
      // and require real lifecycle completion rather than inferring a cause.
      childEnv.PAPERCUSP_MEMORY_EMBEDDER = 'disabled';
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', resolve(root, 'packages/operator-core/test/_sync-batch-lint-guards-child.ts')], {
        cwd: root, detached: true, env: { ...childEnv, PC_ISOLATED_RUNTIME_PROOF: '1',
          SYNC_LINT_EXPECTED_SOURCE_HASHES: JSON.stringify(sourceHashes) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 1, signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(result.output).toContain('SYNC_LINT_PRIVATE_FAILURE AssertionError');
        expect(result.output).toContain('EI260629 deliberate body assertion while interest sweep is blocked');
        expect(result.output.match(/SYNC_LINT_PRIVATE_FAILURE /g)).toHaveLength(1);
        // A failed P037 assertion must not leave the host-owned interest
        // sweeper probing a PG server that teardown is already closing. That
        // race used to emit a late HNSW probe plus lost fallback observations
        // after the worker's own failure had been recorded.
        expect(result.output).not.toContain('[hnsw-iterative-scan] capability probe failed transiently');
        expect(result.output).not.toContain('[fallback-observations] write failed');
        const line = result.output.split('\n').find(row => row.startsWith('SYNC_LINT_PRIVATE_RECEIPT '));
        expect(line, result.output.slice(-8000)).toBeTruthy();
        const receipt: SyncLintPrivateReceipt = JSON.parse(line!.slice('SYNC_LINT_PRIVATE_RECEIPT '.length));
        expect(receipt.build.sourceHashes).toEqual(sourceHashes);
        expect(receipt.runtime.workspaceId).toMatch(/^test-runtime-/);
        expect(receipt.elapsedMs).toBeLessThan(15 * 60_000);
        expect(receipt.lifecycle).toMatchObject({
          detachedRemaining: 0,
          fallbackFailed: 0,
          interestWatchStopRequested: true,
          interestWatchTimerStopped: true,
          stopWaitedForSweep: true,
          sweepPersisted: true,
          order: ['sweep-blocked', 'body-failed', 'stop-requested', 'timer-stopped',
            'sweep-released', 'stop-completed', 'sweep-persisted', 'detached-drained', 'fallback-flushed', 'pools-closed'],
        });
        expect(receipt.filing.assignee).toBe('su-11111111-2222-4333-8444-555555555555');
        expect(receipt.filing.conditionKey).toBe('sync-delta-guard:lint:no-raw-setinterval:src/timer.ts');
        expect(receipt.wake).toMatchObject({ queued: true, pickupConfirmed: false,
          eventKey: 'coord:inbox-wake:su-11111111-2222-4333-8444-555555555555' });
        expect(receipt.wake.deliveryId).toBeGreaterThan(0);
        expect(receipt.typecheck).toMatchObject({ assignee: 'su-22222222-3333-4444-8555-666666666666',
          conditionKey: 'sync-delta-red:src/type-error.ts', firstNotificationError: expect.stringContaining('wake not queued'),
          cursorLeg: 'lint-tsc', confirmations: 2, tscRuns: 2, affectedRuns: 1, gitHead: 'd'.repeat(40) });
        expect(receipt.typecheck.messageId).toBe(`sync-delta-red:${receipt.runtime.workspaceId}:${receipt.typecheck.id}`);
        expect(receipt.typecheck.deliveryId).toBeGreaterThan(0);
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

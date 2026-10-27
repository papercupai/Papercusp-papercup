/** WI-10007331: maintained current-build background route, private writes and teardown. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { captureIsolatedWorker, isolatedIntegrationCases, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workerOptions = isolatedWorkerOptions(390_000);

isolatedIntegrationCases('recovers a guarded partial stage and removes its private runtime (failing exit: %s)', { timeout: workerOptions.testTimeoutMs }, async (failingExit, context) => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/work-items-admission-bulk-dedup-background.integration.test.ts',
    sourcePaths: ['packages/operator-core/lib/work-items-admission-bulk-dedup.ts',
      'packages/operator-core/lib/work-items-admission-promoter.ts',
      'packages/operator-core/test/_bulk-dedup-background-child.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/process-identity.ts', 'scripts/with-test-pg.mjs',
      'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs'],
    execute: async (observe, evidenceDir) => {
  const source = resolve(root, 'packages/operator-core/lib/work-items-admission-bulk-dedup.ts');
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const promoterSourceHash = createHash('sha256').update(readFileSync(resolve(root,
    'packages/operator-core/lib/work-items-admission-promoter.ts'))).digest('hex');
  const child = spawn(process.execPath, [
    resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', resolve(root, 'packages/operator-core/test/_bulk-dedup-background-child.ts'),
  ], { cwd: root, detached: true, env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', BULK_BG_EXPECTED_SOURCE_SHA: sourceHash,
    BULK_BG_EXPECTED_PROMOTER_SHA: promoterSourceHash, BULK_BG_INJECT_FAILURE: failingExit ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  observe(child);
  child.stdout!.on('data', (chunk) => {
    const text = String(chunk);
    for (const line of text.split('\n')) {
      if (line.startsWith('BULK_BACKGROUND_WORKER_PHASE ')) console.info(line);
    }
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
    const output = result.output;
    const code = result.code;
    expect(result, output.slice(-12_000)).toMatchObject({ code: failingExit ? 23 : 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
    if (failingExit) expect(output).toContain('BULK_BACKGROUND_INJECT_FAILURE');
    const line = output.split('\n').find((row) => row.startsWith('BULK_BACKGROUND_RECEIPT '));
    expect(line, output.slice(-8_000)).toBeTruthy();
    const receipt = JSON.parse(line!.slice('BULK_BACKGROUND_RECEIPT '.length));
    expect(receipt.sourceHash).toBe(sourceHash);
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHash);
    expect(receipt.workspace).toMatch(/^test-runtime-/);
    expect(receipt.candidatePairs).toEqual(['a::b', 'c::d']);
    expect(receipt.merged).toBe(1);
    expect(receipt.driftRefusals).toEqual([expect.objectContaining({ itemId: 'b', reason: 'snapshot-drift' })]);
    expect(receipt.digest).toMatchObject({ status: 'complete', coverage: { live: 3, covered: 3, uncovered: 0 } });
    expect(receipt.convergenceReason).toBe('stage-budget');
    expect(receipt.reversal).toMatchObject({ state: 'open', historyPreserved: true, duplicateLinks: 0, adjudicationPreserved: true });
    expect(receipt.liveFire).toMatchObject({ syntheticWorkflow: false, secondEnqueue: 'already_running',
      rearm: 'already_running', controlsPreserved: true, serializedInputsPreserved: true,
      status: 'SUCCESS', executions: 2, terminalReplayWithoutModel: true, merged: 1 });
    expect(receipt.liveFire.workflowId).toBeTruthy();
    expect(receipt.liveFire.durableSteps).toContain('routine-fire-start');
    expect(receipt.liveFire.durableSteps.some((name: string) => name.startsWith('bulk:bulk-grade-live-fire-rehearsal:'))).toBe(true);
    expect(receipt.pinnedRecompute).toEqual({ sourceCensusRunId: 'bulk-background-acceptance-census-0', before: 2, after: 1, retiredByStage: 1 });
    expect(receipt.claimedComparison.sourceHash).toBe(promoterSourceHash);
    expect(receipt.claimedComparison.runtime.processId).toBeTruthy();
    expect(receipt.claimedComparison.runtime.buildSha).toBeTruthy();
    expect(receipt.claimedComparison.cases).toEqual([
      { name: 'unauthenticated', modelCalls: 0, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'distinct', modelCalls: 1, promoted: 1, merged: 0, comparisonPreserved: true },
      { name: 'duplicate-admitted', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'duplicate-pending', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'omitted', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'drift', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
    ]);
    expect(receipt.auditedParkComparison.sourceHash).toBe(promoterSourceHash);
    expect(receipt.auditedParkComparison.runtime).toEqual(receipt.claimedComparison.runtime);
    expect(receipt.auditedParkComparison.cases).toEqual([
      { name: 'unauthenticated', modelCalls: 0, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'distinct-admitted', modelCalls: 1, promoted: 1, merged: 0, comparisonPreserved: true },
      { name: 'distinct-pending', modelCalls: 1, promoted: 1, merged: 0, comparisonPreserved: true },
      { name: 'duplicate', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'omitted', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'missing-audit', modelCalls: 0, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'audit-drift', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
      { name: 'dependency-drift', modelCalls: 1, promoted: 0, merged: 0, comparisonPreserved: true },
    ]);
    expect(existsSync(receipt.runtimeRoot)).toBe(false);
    const dataDir = output.match(/datadir ([^)\n]+)/)?.[1];
    expect(dataDir).toBeTruthy();
    expect(existsSync(dataDir!)).toBe(false);
    console.info('BULK_BACKGROUND_VERIFIED ' + JSON.stringify({ ...receipt, exitCode: code, runtimeRemoved: true, pgDataRemoved: true }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  } });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
});

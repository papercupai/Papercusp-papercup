import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type {} from '../../test/plan-cleanup-http-fixture';
import { preparePrivateOperatorApiBundle } from '../../test/private-http-workspace-preflight';
import {
  captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

it('automatically archives a supported recommendation through current-build HTTP with matching persisted outcome', async context => {
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/plan-cleanup/current-build-http.integration.test.ts',
    sourcePaths: [
      'packages/operator-core/test/plan-cleanup-http-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'scripts/with-test-pg.mjs',
      'packages/operator-core/lib/endpoint-route/routes/admin/plan-cleanup.ts',
      'packages/operator-core/lib/plan-cleanup/start-run.ts',
      'packages/operator-core/lib/plan-cleanup/deterministic-runner.ts',
      'packages/operator-core/lib/plan-cleanup/automation-policy.ts',
      'packages/operator-core/lib/plan-cleanup/action-dispatch.ts',
      'packages/operator-core/lib/plan-cleanup/run-store.ts',
      'packages/operator-core/lib/agent-tools/plans/set-archived.ts',
      'packages/operator-core/lib/attention/automation-policy.ts',
      'apps/operator/bin/bundle-host.sh',
      'apps/operator/bin/hono-host.ts',
    ],
    prepare: async evidenceDir => {
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        builder: { timeoutMs: 240_000, maxMs: 420_000 },
      });
    },
    execute: async (observe, evidenceDir) => {
      expect(prepared).toBeTruthy();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        PLAN_CLEANUP_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/plan-cleanup-http-fixture.ts'),
        `--prepared-api-sha=${prepared!.sha256}`, `--prepared-receipt-sha=${prepared!.receiptSha256}`],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('PLAN_CLEANUP_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('PLAN_CLEANUP_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PLAN_CLEANUP_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        health: { service: 'papercusp-operator' },
        before: [{ plan_slug: 'private-cleanup-selected', archived: false }, { plan_slug: 'private-cleanup-outside', archived: false }],
        after: [{ plan_slug: 'private-cleanup-selected', archived: true }, { plan_slug: 'private-cleanup-outside', archived: false }],
        policy: { minConfidence: 'medium', riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' } },
        request: { status: 200, phase: 'complete', launched: false, resolverNeeded: false },
        outcome: { outcome: 'auto_applied', kind: 'archive-candidate', plan_slug: 'private-cleanup-selected' },
        run: { phase: 'complete', auto_resolved: 1, recommended: 0, failed: 0 },
      });
      console.info('PLAN_CLEANUP_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('PLAN_CLEANUP_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

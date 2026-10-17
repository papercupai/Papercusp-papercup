import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);

it('proves an unrelated checkpoint stays responsive while another item waits on PostgreSQL', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/private-unrelated-write-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-unrelated-write-http-scenario.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/work-item-checkpoint.ts',
      'packages/operator-core/lib/carry-note.ts', 'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts', 'apps/operator/bin/hono-host.ts',
      'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'private-unrelated-write', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      const failures = result.output.split('\n').filter(line => /STAGING_FIRST_HTTP_FAILURE|^Error:|AssertionError|unrelated/.test(line));
      expect(result, failures.join('\n') || result.output.slice(-4_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('PRIVATE_UNRELATED_WRITE_HTTP_RECEIPT '));
      expect(line, result.output.slice(-4_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PRIVATE_UNRELATED_WRITE_HTTP_RECEIPT '.length));
      expect(receipt.observation).toMatchObject({ checkpoint: expect.stringContaining('private unrelated checkpoint'),
        response: { status: 200 }, readback: { checkpoint: expect.stringContaining('private unrelated checkpoint') } });
      expect(receipt.correlation.selectedPid).not.toBe(receipt.correlation.decoyPid);
      expect(Date.parse(receipt.correlation.decoyQueryStart)).toBeLessThanOrEqual(Date.parse(receipt.correlation.selectedQueryStart));
      console.info('PRIVATE_UNRELATED_WRITE_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

it('preserves both same-item HTTP appends queued behind the exact PostgreSQL row lock', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/private-unrelated-write-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-unrelated-write-http-scenario.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/work_items/checkpoint.ts', 'packages/operator-core/lib/work-item-checkpoint.ts',
      'packages/operator-core/lib/carry-note.ts', 'packages/operator-core/lib/work-items.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts', 'apps/operator/bin/hono-host.ts',
      'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_SCENARIO: 'private-same-item-write', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, result.output.slice(-6_000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('PRIVATE_SAME_ITEM_WRITE_HTTP_RECEIPT '));
      expect(line, result.output.slice(-6_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('PRIVATE_SAME_ITEM_WRITE_HTTP_RECEIPT '.length));
      expect(receipt.hostStopped).toBe(true);
      expect(receipt.firstWait.pid).not.toBe(receipt.secondWait.pid);
      expect(receipt.receipts).toHaveLength(2);
      expect(receipt.receipts[1]).toMatchObject({ ok: true, verified: true,
        contentHash: receipt.readbackContentHash });
      expect(receipt.readback).toBe([receipt.baseline, ...receipt.additions].join('\n\n---\n'));
      console.info('PRIVATE_SAME_ITEM_WRITE_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);

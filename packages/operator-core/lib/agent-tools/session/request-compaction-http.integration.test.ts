import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(480_000);
const runtimePaths = ['packages/operator-core/test/staging-first-http-fixture.ts',
  'packages/operator-core/test/compaction-warm-http-scenario.ts'];
type SourceFile = { path: string; sha256: string; gitSha256: string | null };

function verifyRuntimeSource(files: SourceFile[], nodeOptions: string | undefined) {
  if (!nodeOptions?.includes('committed-source-loader.mjs')) return;
  const substitutions = runtimePaths.filter(path => {
    const file = files.find(entry => entry.path === path);
    return !file || file.sha256 !== file.gitSha256;
  });
  expect(substitutions,
    'Compaction HTTP fixture/scenario must be committed before the inherited committed-source loader can execute their current bytes; wait for git-sync publication').toEqual([]);
}

it.each(runtimePaths)('source preflight rejects substituted %s before private runtime allocation', path => {
  const files = runtimePaths.map(path => ({ path, sha256: 'current', gitSha256: 'current' }));
  const inherited = '--import=/repo/scripts/lib/committed-source-loader.mjs';
  expect(() => verifyRuntimeSource(files, inherited)).not.toThrow();
  expect(() => verifyRuntimeSource(files.filter(file => file.path !== path), inherited)).toThrow('must be committed');
  expect(() => verifyRuntimeSource(files.map(file => file.path === path
    ? { ...file, gitSha256: 'older' } : file), inherited)).toThrow('must be committed');
  expect(() => verifyRuntimeSource(files.map(file => file.path === path
    ? { ...file, gitSha256: null } : file), inherited)).toThrow('must be committed');
});

it('source preflight allows worktree execution without the committed-source loader', () => {
  expect(() => verifyRuntimeSource([], undefined)).not.toThrow();
  expect(() => verifyRuntimeSource([], '--max-old-space-size=4096')).not.toThrow();
});

it('refused no-host compaction preserves WARM custody through the current-build HTTP dispatcher', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/compaction-warm-http-scenario.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/agent-tools/session/request-compaction.ts',
      'packages/operator-core/lib/harness/routines/loop.ts', 'packages/operator-core/lib/carry-note.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts'],
    prepare: async evidenceDir => {
      // The child inherits NODE_OPTIONS. Refuse before allocating its private
      // runtime when the loader would silently execute an older scenario.
      const source = JSON.parse(await readFile(join(evidenceDir, 'source.json'), 'utf8'));
      verifyRuntimeSource(source.files, process.env.NODE_OPTIONS);
    },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, STAGING_FIRST_HTTP_SCENARIO: 'compaction-warm',
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('STAGING_FIRST_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('COMPACTION_WARM_HTTP_RECEIPT '));
      const otherReceipts = result.output.split('\n').filter(row => /^[A-Z_]+_HTTP_RECEIPT /.test(row))
        .map(row => row.split(' ')[0]);
      expect(line, 'Missing COMPACTION_WARM_HTTP_RECEIPT; observed receipts: '
        + JSON.stringify(otherReceipts) + '\n' + isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('COMPACTION_WARM_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
        preserved: true, noPendingRespawn: true, carry: 'warm', testedArgs: 4 });
      expect(receipt.requests).toHaveLength(5);
      console.info('COMPACTION_WARM_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('COMPACTION_WARM_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

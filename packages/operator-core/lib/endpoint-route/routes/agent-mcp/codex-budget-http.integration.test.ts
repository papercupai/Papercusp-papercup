import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../../..');
const options = isolatedWorkerOptions(480_000);
const scenarioPaths = ['packages/operator-core/test/staging-first-http-fixture.ts',
  'packages/operator-core/test/codex-budget-http-scenario.ts'];

it('current-build bootstrap preserves registered budgets in its response, native home and CLI argv', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/routes/agent-mcp/codex-budget-http.integration.test.ts',
    sourcePaths: [...scenarioPaths, 'scripts/with-test-pg.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts',
      'packages/operator-core/lib/agent-tools/coordination/presence.ts',
      'packages/operator-core/lib/role-codex-home.ts',
      'apps/operator/scripts/psu-launcher.mjs', 'apps/operator/bin/bundle-host.sh',
      'apps/operator/bin/bundle-host-common.sh', 'apps/operator/bin/hono-host.ts'],
    prepare: async evidenceDir => {
      if (!process.env.NODE_OPTIONS?.includes('committed-source-loader.mjs')) return;
      const source = JSON.parse(await readFile(join(evidenceDir, 'source.json'), 'utf8'));
      expect(scenarioPaths.filter(path => {
        const file = source.files.find((entry: { path: string }) => entry.path === path);
        return !file || file.sha256 !== file.gitSha256;
      }), 'Private runtime must execute the current scenario bytes').toEqual([]);
    },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, STAGING_FIRST_HTTP_SCENARIO: 'codex-budget',
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
      const line = result.output.split('\n').find(row => row.startsWith('CODEX_BUDGET_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('CODEX_BUDGET_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        hostStopped: true, nativeLaunched: false, bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        cases: [
          { name: 'stale-argv', registeredBudget: 225_000, responseBudget: 225_000, configThreshold: 180_000, argvThreshold: 180_000 },
          { name: 'absent-argv', registeredBudget: 225_000, responseBudget: 225_000, configThreshold: 180_000, argvThreshold: 180_000 },
          { name: 'legacy-argv', responseBudget: 250_000, configThreshold: 200_000, argvThreshold: 200_000 },
        ] });
      console.info('CODEX_BUDGET_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('CODEX_BUDGET_HTTP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

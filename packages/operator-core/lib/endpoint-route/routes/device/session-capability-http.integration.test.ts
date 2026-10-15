import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../../..');
const filePath = 'packages/operator-core/lib/endpoint-route/routes/device/session-capability-http.integration.test.ts';
const runtimePaths = ['packages/operator-core/test/staging-first-http-fixture.ts',
  'packages/operator-core/test/session-capability-http-scenario.ts'];

it('a real private paired device defaults to deny, reaches all six granted doors and immediately loses access on revocation', async context => {
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: [...runtimePaths, 'scripts/with-test-pg.mjs',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/device-store.ts', 'packages/operator-core/lib/owner-sessions/device-authority.ts',
      'packages/operator-core/lib/endpoint-route/routes/device/sessions.ts',
      'packages/operator-core/lib/endpoint-route/routes/device/session-capability.ts',
      'packages/operator-core/lib/endpoint-route/routes/device/session-transcript.ts',
      'packages/operator-core/lib/endpoint-route/routes/device/session-messages.ts',
      'packages/operator-core/lib/endpoint-route/routes/device/session-end.ts',
      'packages/operator-core/lib/endpoint-route/routes/device/sync.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-app.ts'],
    prepare: async evidenceDir => {
      const source = JSON.parse(await readFile(join(evidenceDir, 'source.json'), 'utf8'));
      if (process.env.NODE_OPTIONS?.includes('committed-source-loader.mjs')) {
        expect(runtimePaths.filter(path => {
          const row = source.files.find((file: any) => file.path === path);
          return !row || row.sha256 !== row.gitSha256;
        }), 'the private scenario must be committed before its inherited loader runs').toEqual([]);
      }
    },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, STAGING_FIRST_HTTP_SCENARIO: 'session-capability',
        TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(480_000)); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('SESSION_CAPABILITY_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('SESSION_CAPABILITY_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        deviceRevoked: true, bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        health: { service: 'papercusp-operator' },
        checks: { missingJwt: 6, invalidJwt: 6, defaultDenied: 6, granted: 6, revokedCapability: 6 } });
      console.info('SESSION_CAPABILITY_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('SESSION_CAPABILITY_HTTP_PROOF_RUN ' + runId);
}, 540_000);

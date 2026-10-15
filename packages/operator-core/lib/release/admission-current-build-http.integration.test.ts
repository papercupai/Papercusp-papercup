import { execFileSync, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, type TestContext } from 'vitest';
import {
  captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);

async function verifyAdmissionHttp(context: TestContext, ordinary = false) {
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/release/admission-current-build-http.integration.test.ts',
    sourcePaths: [
      'packages/operator-core/test/admission-http-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/task-manager/store.ts',
      'packages/operator-core/lib/task-manager/control.ts',
      'packages/operator-core/lib/task-manager/cgroup-read.ts',
      'packages/operator-core/lib/task-manager/types.ts',
      'packages/operator-core/lib/task-manager/managed-spawn.ts',
      'packages/operator-core/lib/systemd-scope.ts',
      'scripts/with-test-pg.mjs',
      'packages/operator-core/lib/agent-tools/release/repair-queue.ts',
      'packages/operator-core/lib/release/admission-jobs.ts',
      'packages/operator-core/lib/release/admission-offthread.ts',
      'packages/operator-core/lib/release/admission-jobs.worker.ts',
      'packages/operator-core/lib/release/admission-fix-precheck.ts',
      'packages/operator-core/lib/release/admission-fix-precheck-managed.ts',
      'packages/operator-core/lib/release/admission-fix-precheck-worker-bin.ts',
      'packages/operator-core/lib/release/admission-import-completeness.ts',
      'packages/operator-core/lib/release/frozen-candidate-repair-queue.ts',
      'scripts/lib/related-tests.mjs',
      'apps/operator/bin/bundle-host.sh',
      'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts',
    ],
    execute: async (observe, evidenceDir) => {
      if ((process.env.NODE_OPTIONS ?? '').includes('committed-source-loader.mjs')) {
        const fixturePath = 'packages/operator-core/test/admission-http-fixture.ts';
        expect(readFileSync(join(root, fixturePath)), 'publish fixture bytes before allocating the private runtime')
          .toEqual(execFileSync('git', ['show', 'HEAD:' + fixturePath], { cwd: root }));
      }
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        ADMISSION_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
      if (ordinary) env.ADMISSION_HTTP_CASE = 'ordinary';
      else delete env.ADMISSION_HTTP_CASE;
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api',
        ...(ordinary ? ['--managed-tasks'] : []), '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/admission-http-fixture.ts')],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('ADMISSION_HTTP_PHASE ')) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('ADMISSION_HTTP_RECEIPT '));
      expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('ADMISSION_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
        sourceUnchanged: true, bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        workerSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' } });
      if (ordinary) expect(receipt).toMatchObject({ response: { ok: true, admitted: true },
        ordinaryProof: { materialization: 'fixture-tools', noBackgroundPublication: true,
          managedTask: { confined: true, exitCode: 0, scopeEmpty: true },
          admittedPath: 'test/ordinary.test.mjs', precheck: { status: 'passed', verdict: { ok: true, ran: true,
            passing: ['test/ordinary.test.mjs'], failing: [], unmeasured: [] } } } });
      else expect(receipt).toMatchObject({
        queueUnchanged: true, lineageUnchanged: true, sourceUnchanged: true,
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        workerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        response: { ok: false, admitted: false, refused: true, verdict: 'refused',
          reason: 'admission-precheck-unavailable', detail: expect.stringContaining('no discoverable test files') },
        health: { service: 'papercusp-operator' },
      });
      console.info('ADMISSION_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ADMISSION_HTTP_PROOF_RUN ' + runId);
}

it('refuses an undiscoverable gitlink inventory through current-build HTTP without publishing the admission',
  context => verifyAdmissionHttp(context), options.testTimeoutMs);

it('admits an ordinary test file from a linked current-build checkout after its managed precheck passes',
  context => verifyAdmissionHttp(context, true), options.testTimeoutMs);

/** Real current-su launcher, private current-build operator and task container.
 * The only model transport is a local refusal listener with no forwarding code. */
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import type {} from '../../test/current-su-native-http-scenario';
import type {} from '../../test/staging-first-http-fixture';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../../test/private-http-workspace-preflight';
import { CC_HOOK_FILES } from '../desktop-install/papercusp-files';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(480_000);
const hookSources = 'apps/operator/scripts/hooks';
const hookInputs = [...CC_HOOK_FILES.map(name => `${hookSources}/cc/${name}`),
  ...['inject', 'inject/adapters'].flatMap(dir => readdirSync(join(root, hookSources, dir))
    .filter(name => name.endsWith('.mjs')).map(name => `${hookSources}/${dir}/${name}`))];

it('launches autonomous current-su through the native container adapter without provider forwarding', async context => {
  let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>> | undefined;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/external-bench/current-su-native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/staging-first-http-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/current-su-native-http-scenario.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/external-bench/current-su.ts',
      'packages/operator-core/lib/external-bench/frontier-swe-launch-adapter.ts',
      'packages/operator-core/lib/external-bench/frontier-swe-seam.ts',
      'packages/operator-core/lib/external-bench/container-exec-target.ts',
      'packages/operator-core/lib/external-bench/codex-hook-bridge.ts',
      'packages/operator-core/lib/agent-tools/capability/launch-agent.ts',
      'packages/operator-core/lib/console-spawn.ts', 'apps/operator/scripts/psu-launcher.mjs',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'packages/operator-core/lib/desktop-install/papercusp-files.ts',
      'packages/operator-core/lib/role-codex-home.ts', ...hookInputs],
    retainedArtifacts: ['phases/prepare/operator-api-build.log', 'phases/prepare/operator-api-build-result.json',
      'phases/prepare/bundle-restricted-hold-inputs.json',
      'phases/prepare/hono-host.mjs.build-steps.jsonl'],
    prepare: async evidenceDir => {
      // Compilation and every guard must finish before the disposable native
      // runtime/database exists. The worker consumes only these pinned bytes.
      // Completed build steps may renew the stall checkpoint up to the shared
      // absolute ceiling. A stalled build still fails before runtime allocation.
      prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
        builder: { timeoutMs: 240_000, maxMs: 420_000 },
      });
    },
    execute: async (observe, evidenceDir) => {
      expect(prepared, 'Private API preparation must precede runtime allocation').toBeDefined();
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--managed-tasks', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
        '--prepared-api-sha=' + prepared!.sha256, '--prepared-receipt-sha=' + prepared!.receiptSha256],
      { cwd: root, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          STAGING_FIRST_HTTP_SCENARIO: 'current-su-native', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') } });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n'))
          if (/^(CURRENT_SU_NATIVE_PHASE|STAGING_FIRST_HTTP_PHASE) /.test(line)) console.info(line);
      });
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = result.output.split('\n').find(row => row.startsWith('CURRENT_SU_NATIVE_RECEIPT '));
      expect(line, result.output.slice(-4000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('CURRENT_SU_NATIVE_RECEIPT '.length));
      expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
        hostStopped: true, providerForwarding: false, modelRequests: expect.any(Number),
        nativeSessionId: expect.stringMatching(/^[a-f0-9-]{36}$/), autoRegistered: true,
        hooksBridged: true, containerWorkdir: '/app', mcpConfined: true });
      expect(receipt.modelRequests).toBeGreaterThan(0);
      console.info('CURRENT_SU_NATIVE_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('CURRENT_SU_NATIVE_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

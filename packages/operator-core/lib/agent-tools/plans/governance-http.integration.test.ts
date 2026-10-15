import { fork } from 'node:child_process';
import { resolve, join } from 'node:path';
import { symlink, rm, mkdir } from 'node:fs/promises';
import type {} from '../../../test/governance-http-fixture';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../..');
const workerOptions = isolatedWorkerOptions(480_000);

it('ratifies through the production HTTP plans door and executes only the signed bounded action in a private runtime', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/agent-tools/plans/governance-http.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/governance-http-fixture.ts',
      'scripts/lib/with-test-pg-cleanup.mjs',
      'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-event.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-local-action.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-federation.ts',
      'packages/operator-core/lib/sync/hyperbee/local-announce-identity.ts',
      'packages/operator-core/lib/identity/resolve-local-github-identity.ts',
      'packages/operator-core/lib/identity/gh-token.ts',
      'packages/operator-core/lib/identity/octokit-client.ts',
      'packages/operator-core/lib/identity/sign-with-device-key.ts',
      'packages/operator-core/lib/identity/keychain.ts',
      'packages/operator-core/lib/agent-tools/index.ts',
      'packages/operator-core/lib/endpoint-route/routes/admin/plans.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-authentication.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-round.ts',
      'packages/operator-core/lib/agent-tools/plans/governance-voting.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-governance-store.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-certificate-source.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-gate.ts',
      'packages/operator-core/lib/p2p/onchain-governance-bridge.ts',
      'packages/operator-core/lib/p2p/treasury-controls.ts',
      'packages/operator-core/lib/harness-registry.ts',
      'packages/operator-core/lib/hive-federation.ts',
      'packages/operator-core/lib/federated-pot-scope.ts',
      'packages/operator-core/lib/harness/papercusp-workspace.ts',
      'packages/operator-core/lib/agent-tools/plans/source.ts',
      'packages/operator-core/lib/process-identity.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      await mkdir(join(evidenceDir, 'tmp'));
      const environment: Record<string, string | undefined> = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        GOVERNANCE_HTTP_EVIDENCE_DIR: evidenceDir, TMPDIR: join(evidenceDir, 'tmp') };
      delete environment.PC_HEAVY_PREEMPT_READY_FILE;
      delete environment.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        resolve(root, 'packages/operator-core/test/governance-http-fixture.ts'),
      ], { cwd: root, detached: true, env: environment, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      child.stdout!.on('data', chunk => {
        for (const line of String(chunk).split('\n')) {
          if (line.startsWith('[with-test-pg] operator-api stage ') || line.startsWith('GOVERNANCE_HTTP_PHASE ')) console.info(line);
        }
      });
      const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
      const output = result.output;
      await rm(join(evidenceDir, 'node_modules'));
      expect(result, output.slice(-12_000)).toMatchObject({ code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const line = output.split('\n').find(row => row.startsWith('GOVERNANCE_HTTP_RECEIPT '));
      expect(line, output.slice(-8_000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('GOVERNANCE_HTTP_RECEIPT '.length));
      expect(receipt).toMatchObject({ pid: expect.any(Number), workspace: expect.stringMatching(/^test-runtime-/),
        httpRatified: true, forgedRefused: true, foreignRefused: true, conflictRefused: true,
        lateBallotRefused: true, pausedRefused: true, exactActionSubmissions: 1, replayed: true,
        hostPid: expect.any(Number), hostStopped: true, bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        adapter: 'isolated deterministic receipt; no chain transaction' });
      console.info('GOVERNANCE_HTTP_VERIFIED ' + JSON.stringify(receipt));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('GOVERNANCE_HTTP_PROOF_RUN ' + runId);
}, workerOptions.testTimeoutMs);

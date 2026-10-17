/** Opted-in acceptance of the maintained serve.ts bundle, genuine TEST identity and private PG. */
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { assertIsolatedWorkerReaped, captureIsolatedWorker, isolatedWorkerOptions,
  observeIsolatedWorkerLifetime } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const fixture = join(root, 'packages/operator-core/test/hosted-serving-artifact.fixture.ts');

it.runIf(Boolean(process.env.PAPERCUSP_TEST_HOSTED_SERVING_ARTIFACT))(
  'serves authenticated WorkOS TEST sessions and refuses unadmitted provisioning on the actual hosted artifact', async () => {
    // Resolve references in a separate, read-only credential process before private
    // HOME/PG isolation. Its captured stdout never enters logs or evidence.
    const configuration = process.env.HOSTED_SERVING_TEST_CONFIGURATION
      ? JSON.parse(process.env.HOSTED_SERVING_TEST_CONFIGURATION)
      : JSON.parse((await promisify(execFile)(process.execPath,
        ['--import', 'tsx', fixture, '--credentials'], { cwd: root, timeout: 60_000, maxBuffer: 64 * 1024 })).stdout);
    const evidenceDir = await mkdtemp(join(tmpdir(), 'p537-hosted-serving-proof-'));
    console.info('HOSTED_SERVING_ARTIFACT_EVIDENCE ' + evidenceDir);
    const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
      HOSTED_SERVING_TEST_CONFIGURATION: JSON.stringify(configuration),
      HOSTED_SERVING_TEST_ARTIFACT: process.env.PAPERCUSP_TEST_HOSTED_SERVING_ARTIFACT!,
      HOSTED_SERVING_TEST_PORTAL_ROOT: process.env.PAPERCUSP_TEST_HOSTED_SERVING_PORTAL_ROOT
        ?? resolve(root, '../portal'),
      HOSTED_SERVING_TEST_EVIDENCE_DIR: evidenceDir };
    delete env.PC_HEAVY_PREEMPT_READY_FILE;
    delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
    const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', fixture],
    { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const observation = observeIsolatedWorkerLifetime(child, root, evidenceDir);
    const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(300_000));
    expect(result, result.output.slice(-5000)).toMatchObject({ code: 0, signal: null,
      timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(observation.observationError).toBeUndefined();
    expect(observation.lifecycle).toBeTruthy();
    assertIsolatedWorkerReaped(child, observation.ended);
    const line = result.output.split('\n').find(row => row.startsWith('HOSTED_SERVING_ARTIFACT_RECEIPT '));
    expect(line, result.output.slice(-5000)).toBeTruthy();
    const receipt = JSON.parse(line!.slice('HOSTED_SERVING_ARTIFACT_RECEIPT '.length));
    expect(receipt).toMatchObject({ profile: 'hosted-control-plane', authenticatedSession: true,
      organizationMatches: true, closedAdmissionStatus: 403, missingSessionStatus: 401,
      invalidPolicyRefused: true, revokedSessionStatus: 401, testUserCleaned: true, hostStopped: true });
    expect(receipt.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.provisionOperationsCreated).toBe(0);
    console.info('HOSTED_SERVING_ARTIFACT_VERIFIED ' + JSON.stringify({ ...receipt, evidenceDir }));
  }, 420_000,
);

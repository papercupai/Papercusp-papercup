import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { makeCredentialResolver } from '../inference-gateway/credential-store';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  observeIsolatedWorkerLifetime } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(60_000);

it.for([
  { mode: 'primary', exception: false }, { mode: 'primary', exception: true },
  { mode: 'capacity-failover', exception: false }, { mode: 'capacity-failover', exception: true },
])('prepares private routing $mode, exception=$exception with no provider spend',
  { timeout: options.testTimeoutMs }, async ({ mode, exception }) => {
    const evidenceDir = await mkdtemp(join(tmpdir(), 'blueprint-route-setup-'));
    const referenceFile = join(evidenceDir, 'fixture-pool.json');
    const now = Date.now();
    const accounts = ['codex', 'claude'].map(provider => ({ id: `setup-${provider}`, provider,
      credentialRef: `${provider === 'claude' ? 'apikey:' : ''}env:PRIVATE_SETUP_${provider.toUpperCase()}`, boundTo: [], softPin: [], addedAt: now,
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0,
        utilization: 0.1, utilization7d: 0.1, utilizationAt: now,
        windowResetAt: now + 300_000, windowResetAt7d: now + 300_000 } }));
    // Constructor validation reads no credential bytes and must precede private PG allocation.
    for (const account of accounts.filter(row => row.provider === 'claude')) makeCredentialResolver(account.credentialRef);
    await writeFile(referenceFile, JSON.stringify({ accounts, mode, observedAt: now, headroom: [] }));
    const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
      STAGING_FIRST_HTTP_SCENARIO: 'blueprint-account-route-setup' + (exception ? '-exception' : ''),
      STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir, FGR_R6_NO_PROVIDER: '1',
      FGR_R6_ACCOUNT_POOL_REFERENCE_FILE: referenceFile };
    delete env.PC_HEAVY_PREEMPT_READY_FILE;
    delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
    const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
      process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')],
    { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const observation = observeIsolatedWorkerLifetime(child, root, evidenceDir);
    const result = await captureIsolatedWorker(child, evidenceDir, options);
    expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: exception ? 1 : 0,
      signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
    if (exception) expect(result.output).toContain('private routing setup exception control');
    expect(observation.observationError).toBeUndefined();
    expect(observation.ended).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
    const receipt = JSON.parse(await readFile(join(evidenceDir, 'account-route-setup.json'), 'utf8'));
    expect(receipt).toMatchObject({ mode, injectedPrimaryWall: mode === 'capacity-failover',
      requestedBackend: 'codex', codexGatewayPresent: false,
      providerRequests: 0, nativeStarted: false, bundleStarted: false, httpStarted: false });
    expect(receipt.capacity.find((row: { provider: string }) => row.provider === 'codex'))
      .toMatchObject({ atCapacity: mode === 'capacity-failover', unknown: 0 });
    expect(receipt.capacity.find((row: { provider: string }) => row.provider === 'claude'))
      .toMatchObject({ atCapacity: false, serviceable: 1 });
    expect(receipt.backups).toEqual([{ backend: 'claude-code', model: expect.any(String), effort: 'high', account: 'auto' }]);
    expect(result.output).not.toContain('STAGING_FIRST_HTTP_PHASE bundle-start');
  });

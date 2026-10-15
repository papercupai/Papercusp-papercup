/**
 * Live acceptance for plan cupboard-distributable-integrations-2026-10-10, SPEC-R-1-P-011: the Slack
 * and bug-triage packages are listed in the public Cupboard and install from those listings.
 *
 * A private operator (scripts/with-test-pg.mjs --isolated-runtime=operator-api: private Postgres,
 * HOME, PAPERCUSP_HOME and XDG) installs each package through POST /api/cupboard/install-plugin by
 * its public listing id. The hosted Cupboard and the public GitHub mirrors are the real ones, so the
 * test needs network access and is opt-in: PAPERCUSP_TEST_CUPBOARD_LIVE=1. The isolated runtime's
 * retained receipt is tagged on the test so the ledger row carries its runtime identity.
 */
import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(600_000);
const FIXTURE = 'packages/operator-core/test/cupboard-listing-install-http-fixture.ts';

it.runIf(process.env.PAPERCUSP_TEST_CUPBOARD_LIVE === '1')(
  'installs slack and bug-triage from their public Cupboard listings into a private operator', async context => {
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/cupboard/cupboard-listing-install-live.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', FIXTURE, 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/cupboard/install-plugin-core.ts',
        'packages/operator-core/lib/cupboard/plugin-listings.ts',
        'packages/operator-core/lib/cupboard/resolve-listing-by-kind.ts',
        'packages/operator-core/lib/endpoint-route/routes/cupboard-install-plugin.ts',
        'packages/operator-core/lib/endpoint-route/routes/user/ticket-integrations.ts',
        'packages/operator-core/lib/integrations/ticket-integrations.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          CUPBOARD_LISTING_INSTALL_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, FIXTURE)],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => {
          for (const line of String(chunk).split('\n')) if (line.startsWith('CUPBOARD_LISTING_INSTALL_PHASE ')) console.info(line);
        });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        const failures = result.output.split('\n').filter(line => /CUPBOARD_LISTING_INSTALL_FAILURE|^Error:|AssertionError|operator-api preflight failed/.test(line));
        expect(result, failures.join('\n') || isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('CUPBOARD_LISTING_INSTALL_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('CUPBOARD_LISTING_INSTALL_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
          bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' } });
        expect(receipt.installs).toEqual([
          expect.objectContaining({ name: 'slack', listingId: 'ccd90bf0-f04c-486d-93cd-2c84d8241efe', firstStatus: 409,
            secondStatus: 200, source: 'https://github.com/Papercusp/papercusp-slack', providerId: 'slack' }),
          expect.objectContaining({ name: '@papercupai/bug-triage', listingId: '508f85df-cb5a-4e92-9fdb-26c26eafd00f',
            // A provider-free trigger pack has no consent stop: its first call installs it.
            firstStatus: 200, secondStatus: null, source: 'https://github.com/Papercusp/papercusp-bug-triage', triggerPack: true }),
        ]);
        // Settings → Integrations (its overview route) lists neither before the installs and both after,
        // from the same running host: no restart, no app update.
        expect(receipt.integrations.before.providerIds).not.toContain('slack');
        expect(receipt.integrations.before.packNames).not.toContain('@papercupai/bug-triage');
        expect(receipt.integrations.after.providerIds).toContain('slack');
        expect(receipt.integrations.after.packNames).toContain('@papercupai/bug-triage');
        console.info('CUPBOARD_LISTING_INSTALL_VERIFIED ' + JSON.stringify(receipt.installs));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('CUPBOARD_LISTING_INSTALL_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

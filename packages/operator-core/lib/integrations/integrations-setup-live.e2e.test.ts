/**
 * Live acceptance for plan cupboard-distributable-integrations-2026-10-10, R-2 (AUTO-BAR-R-2-P-005):
 * connecting a chat provider, choosing the channels and the destination project, and arming the
 * workflow are all completed with the requests Settings → Integrations sends, with no terminal step,
 * admin route or file edit.
 *
 * A private operator (scripts/with-test-pg.mjs --isolated-runtime=operator-api: private Postgres,
 * HOME, PAPERCUSP_HOME and XDG) runs the journey in packages/operator-core/test/integrations-setup-http-fixture.ts
 * against the committed test packages under packages/operator-core/test/fixtures/integrations-setup-*.
 * The UI half (each control on the page sends exactly these requests) is proven by
 * apps/operator/app/settings/integrations/page.test.tsx and its siblings.
 *
 * Opt-in (PAPERCUSP_TEST_INTEGRATIONS_SETUP_LIVE=1): it bundles and boots a whole private operator,
 * which is minutes of work the unit run must not pay on every collection. The isolated runtime's
 * retained receipt is tagged on the test so the ledger row carries its runtime identity.
 */
import { fork } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const options = isolatedWorkerOptions(600_000);
const FIXTURE = 'packages/operator-core/test/integrations-setup-http-fixture.ts';
const PACKAGES = 'packages/operator-core/test/fixtures';

it.runIf(process.env.PAPERCUSP_TEST_INTEGRATIONS_SETUP_LIVE === '1')(
  'connects a provider, picks channels and a destination project, and arms a pack using only the page routes', async context => {
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/integrations/integrations-setup-live.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', FIXTURE, 'packages/operator-core/test/isolated-integration-proof.ts',
        `${PACKAGES}/integrations-setup-chat/papercusp.json`, `${PACKAGES}/integrations-setup-chat/daemon.mjs`,
        `${PACKAGES}/integrations-setup-triage/papercusp.json`, `${PACKAGES}/integrations-setup-triage/plan.md`,
        'packages/operator-core/lib/cupboard/install-plugin-core.ts',
        'packages/operator-core/lib/cupboard/trigger-pack-lifecycle.ts',
        'packages/operator-core/lib/endpoint-route/routes/cupboard-install-plugin.ts',
        'packages/operator-core/lib/endpoint-route/routes/user/ticket-integrations.ts',
        'packages/operator-core/lib/endpoint-route/routes/user/provider-credentials.ts',
        'packages/operator-core/lib/endpoint-route/routes/user/provider-options.ts',
        'packages/operator-core/lib/integrations/ticket-integrations.ts',
        'packages/operator-core/lib/integrations/provider-credentials.ts',
        'packages/operator-core/lib/integrations/provider-options.ts',
        'apps/operator/app/settings/integrations/ticket-integrations-client.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          INTEGRATIONS_SETUP_EVIDENCE_DIR: evidenceDir, TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, FIXTURE)],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => {
          for (const line of String(chunk).split('\n')) if (line.startsWith('INTEGRATIONS_SETUP_PHASE ')) console.info(line);
        });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        const failures = result.output.split('\n').filter(line => /INTEGRATIONS_SETUP_FAILURE|^Error:|AssertionError|operator-api preflight failed/.test(line));
        expect(result, failures.join('\n') || isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('INTEGRATIONS_SETUP_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('INTEGRATIONS_SETUP_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), hostStopped: true,
          bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/), health: { service: 'papercusp-operator' },
          provider: 'integrations-setup-chat', pack: 'integrations-setup-triage',
          channelChoices: ['C-general', 'C-bugs'], projectChoices: ['PRJ-roadmap', 'PRJ-bugs'],
          inputs: { channels: ['C-bugs'], destination: 'PRJ-bugs' },
          oracle: { installationStatus: 'configured' } });
        expect(receipt.armedBindingIds.length).toBeGreaterThan(0);
        expect(receipt.oracle.armedBindings).toBe(receipt.armedBindingIds.length);
        // Nothing outside the page's own routes took part: no admin route, no other surface.
        expect(receipt.routes.length).toBeGreaterThan(0);
        for (const route of receipt.routes) expect(route).toMatch(/^(GET|POST|PUT) \/api\/(user\/integrations|cupboard)\//);
        console.info('INTEGRATIONS_SETUP_VERIFIED ' + JSON.stringify({ installationId: receipt.installationId, routes: receipt.routes }));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('INTEGRATIONS_SETUP_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

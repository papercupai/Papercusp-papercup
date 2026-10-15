/** P-005 Stats acceptance reuses the disposable roster/API/browser boundary. */
import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateOperatorApiBundle, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateHudReadPolicy, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);
const source = () => preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
const preflight = () => ({ portalSourceRoot: source(), selected: 'stats-preflight-selected', neighbor: 'stats-preflight-neighbor', stats: true });

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Stats and scope graph mount before private allocation', async () => {
    const graph = await buildPortalRosterBrowser(preflight());
    for (const module of ['AdvStatsTab.tsx', 'AdvShell.tsx']) {
      expect([...graph.originals.keys()].some(path => path.endsWith('/' + module))).toBe(true);
    }
    expect(await verifyPrivateWorkspaceBrowserMount(preflight())).toMatchObject({ mounted: true });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Stats retains selected repository measurements across Host denial recovery and reload without writes', async context => {
    preparePrivateRosterSocketRoot(); await verifyPrivateHudReadPolicy();
    const portalSource = source(); await verifyPrivateWorkspaceBrowserMount(preflight());
    let preparedApi: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-stats-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/portal-stats-fixture.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/harness/git-stats.ts', 'packages/operator-core/lib/endpoint-route/routes/harness/git.ts',
        'packages/operator-core/lib/harness-registry.ts', 'apps/operator-vite/src/components/adv/AdvStatsTab.tsx',
        'apps/operator-vite/src/components/adv/AdvShell.tsx', 'apps/operator/bin/hono-host.ts',
        'apps/operator/bin/host-handler.ts', 'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: evidenceDir => { preparedApi = preparePrivateOperatorApiBundle(root, evidenceDir); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(env)) if (/^ROSTER_.*_PROOF$/.test(key)) delete env[key];
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION']) delete env[key];
        Object.assign(env, { PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0', ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir,
          ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_STATS_BROWSER_PROOF: '1' });
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
          '--portal-source=' + portalSource, '--prepared-api-sha=' + preparedApi.sha256],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
        expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        expect(JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length))).toMatchObject({
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-stats-with-cookie',
          initialDenialRecovery: true, staleMeasurementRetained: true, keyboardRefresh: true, scopeReload: true,
          neighborNotGitControl: true, foreignExcluded: true, noProductWrites: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_STATS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

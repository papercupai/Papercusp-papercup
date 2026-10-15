/** WI-10007847: canonical private acceptance for the two project History sources. */
import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateOperatorApiBundle, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateHudReadPolicy, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';
import { verifyPrivateProjectHistorySeedStatus } from '../../../test/portal-project-history-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it('private project History seed rejects work-item terminal states before allocation', () => {
  expect(() => verifyPrivateProjectHistorySeedStatus('done')).toThrow('Invalid private History plan status: done');
  expect(verifyPrivateProjectHistorySeedStatus()).toBe('active');
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal project History browser graph contains archive and live product controls before private allocation', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const graph = await buildPortalRosterBrowser({ portalSourceRoot: portalSource,
      selected: 'history-boundary-selected', neighbor: 'history-boundary-neighbor', projectHistory: true });
    expect(graph.originals.size).toBeGreaterThan(0);
    expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'history-boundary-selected', neighbor: 'history-boundary-neighbor', projectHistory: true })).toMatchObject({ mounted: true });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal project History paginates archive and reloads live selection with scoped reads and denial recovery', async context => {
    verifyPrivateProjectHistorySeedStatus();
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'history-selected', neighbor: 'history-neighbor', projectHistory: true });
    let preparedApi: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-project-history-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/portal-project-history-fixture.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/project-history.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/project-history-source.ts',
        'packages/operator-core/lib/sync-resolver/project-history-events.ts', 'packages/operator-core/lib/sync-resolver/index.ts',
        'apps/operator-vite/src/components/adv/AdvHistoryTab.tsx', 'apps/operator-vite/src/components/adv/AdvShell.tsx',
        'libs/generic/ui-primitives/src/ProjectHistoryView.tsx', 'libs/generic/ui-primitives/src/ActivityTimelineView.tsx',
        'libs/generic/plan-parser/src/parser.ts',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      prepare: evidenceDir => { preparedApi = preparePrivateOperatorApiBundle(root, evidenceDir); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(env)) if (/^ROSTER_.*_PROOF$/.test(key)) delete env[key];
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION']) delete env[key];
        Object.assign(env, { PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0', ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir,
          ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_PROJECT_HISTORY_BROWSER_PROOF: '1' });
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
          '--portal-source=' + portalSource, '--prepared-api-sha=' + preparedApi.sha256],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        child.stdout!.on('data', chunk => { for (const line of String(chunk).split('\n'))
          if (line.startsWith('ROSTER_STOP_HTTP_PHASE ')) console.info(line); });
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, options); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false, code: 0 });
        expect(result.output).toContain('"childrenStopped":true,"apiStopped":true');
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_COORD_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        expect(JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length))).toMatchObject({
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-project-history-with-cookie',
          archivePagination: true, archiveReload: true, liveSelectionReload: true, liveAvoidsArchive: true,
          keyboardControls: true, archiveDenialRecovery: true, liveDenialRecovery: true,
          neighborDistinct: true, foreignExcluded: true, noProductWrites: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_PROJECT_HISTORY_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

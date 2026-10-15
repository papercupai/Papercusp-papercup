/** P-005 Calendar acceptance using the existing private operator and Portal boundary. */
import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateOperatorApiBundle, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateHudReadPolicy, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Calendar browser graph mounts FullCalendar and both occurrence consumers before private allocation', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const input = { portalSourceRoot: portalSource, selected: 'calendar-preflight-selected', neighbor: 'calendar-preflight-neighbor', calendar: true };
    const graph = await buildPortalRosterBrowser(input);
    expect([...graph.originals.keys()].some(path => path.endsWith('/ScheduledRoutinesPane.tsx'))).toBe(true);
    expect(graph.css).toContain('.pc-sched-cal__error');
    expect(await verifyPrivateWorkspaceBrowserMount(input)).toMatchObject({ mounted: true });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Calendar recovers both denied occurrence reads and retains selection on reload without schedule writes', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'calendar-preflight-selected', neighbor: 'calendar-preflight-neighbor', calendar: true });
    let preparedApi: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-calendar-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/portal-calendar-fixture.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/sync-resolver/index.ts', 'packages/operator-core/lib/harness/routines/scheduled-occurrences.ts',
        'packages/operator-core/lib/harness/routines/scheduled-occurrences.test.ts',
        'packages/operator-core/lib/harness/routines/scheduled-occurrences.integration.test.ts',
        'packages/operator-core/lib/connected-apps/pg-dates.ts',
        'packages/operator-core/lib/harness/routines/schedule-next.ts',
        'apps/operator-vite/src/components/adv/ScheduledCalendarTab.tsx',
        'apps/operator-vite/src/components/adv/ScheduledRoutinesPane.tsx', 'apps/operator-vite/src/components/adv/scheduled-calendar.css',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: evidenceDir => { preparedApi = preparePrivateOperatorApiBundle(root, evidenceDir); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(env)) if (/^ROSTER_.*_PROOF$/.test(key)) delete env[key];
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION']) delete env[key];
        Object.assign(env, { PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0', ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir,
          ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_CALENDAR_BROWSER_PROOF: '1' });
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-calendar-with-cookie',
          calendarDenialRecovery: true, routinesDenialRecovery: true, keyboardRetry: true,
          selectedPlanReload: true, neighborPresent: true, foreignExcluded: true, noProductWrites: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_CALENDAR_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser } from '../../../test/portal-roster-browser-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal confirmed stop cancels without dispatch, retains denied selection and stops only the authenticated native target', async context => {
    expect(context.task.meta).toBeDefined();
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor' });
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-stop-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/private-coord-receipt.ts', 'packages/operator-core/test/portal-roster-browser-fixture.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/psu-pty-host-canary.mjs',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/auth.ts',
        'packages/operator-core/lib/adv-sessions.ts', 'packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts',
        'packages/operator-core/lib/events/await/psu-pty-discovery.ts', 'apps/operator/scripts/psu-pty-host.mjs',
        'apps/operator/bin/host-spa.ts', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_STOP_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE',
          'ROSTER_STOP_HTTP_MUTATION', 'ROSTER_COORD_HTTP_PROOF', 'ROSTER_COORD_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource],
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
        const line = result.output.split('\n').find(value => value.startsWith('ROSTER_STOP_BROWSER_RECEIPT '));
        expect(line, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('ROSTER_STOP_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'cookie-session',
          cancelSentNoRequest: true, denialStatus: 403, selectionRetained: true, retryClearedSelection: true,
          selected: { ended: true }, neighbor: { alive: true }, neighborIsolated: true, deepLinkReload: true,
          secondCancelSentNoRequest: true, staleDenialStatus: 403,
          accepted: { status: 200 }, positiveControl: 'wrong-session and replacement-launch rejected' });
        expect(receipt.selected.id).not.toBe(receipt.neighbor.id);
        expect(receipt.requests).toHaveLength(3);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_STOP_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

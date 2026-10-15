/** P-005 actual Git action acceptance uses the maintained disposable runtime. */
import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateOperatorApiBundle, preparePrivateRosterSocketRoot } from '../../../test/private-http-workspace-preflight';
import { verifyPrivateHudReadPolicy } from '../../../test/portal-roster-browser-fixture';
import type { runPrivateGitPage } from '../../../test/portal-git-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Git dock reads, searches, selects and reloads an actual commit with workspace and Host isolation', async context => {
    preparePrivateRosterSocketRoot(); await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    let preparedApi: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-git-actions-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/portal-git-fixture.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/git.ts', 'packages/operator-core/lib/harness-registry.ts',
        'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx', 'apps/operator/app/adv/harnesses/AdvGitWorkspace.tsx',
        'apps/operator/app/adv/harnesses/AdvGitDock.tsx', 'apps/operator/app/adv/harnesses/AdvGitGraphPanel.tsx',
        'libs/generic/git-graph/src/CommitDetail.tsx', 'apps/operator/bin/hono-host.ts',
        'apps/operator/bin/host-handler.ts', 'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: evidenceDir => { preparedApi = preparePrivateOperatorApiBundle(root, evidenceDir); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(env)) if (/^ROSTER_.*_PROOF$/.test(key)) delete env[key];
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION']) delete env[key];
        Object.assign(env, { PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0', ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir,
          ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_GIT_BROWSER_PROOF: '1' });
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length)) as Awaited<ReturnType<typeof runPrivateGitPage>>;
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-git-with-cookie', initialDenialRecovery: true, actualCommitDiff: true,
          commitSha: expect.stringMatching(/^[a-f0-9]{40}$/), patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          dockReload: true, commitReload: true, search: true, neighborNotGitControl: true, foreignExcluded: true, noGitWrites: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_GIT_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

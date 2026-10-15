/** Per-harness Settings coverage in the maintained disposable Portal boundary. */
import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateRosterSocketRoot, preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';
import { preparePortalBrowserSource } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal per-harness Settings graph mounts separately from utility Profile before private allocation', async () => {
    const input = {
      portalSourceRoot: preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]),
      selected: 'settings-preflight-selected', neighbor: 'settings-preflight-neighbor', harnessSettings: true,
    };
    const graph = await buildPortalRosterBrowser(input);
    for (const file of ['AdvHarnessPanelPage.tsx', 'BlueprintSettingsPanel.tsx', 'HarnessSettingsPanel.tsx']) {
      expect([...graph.originals.keys()].some(path => path.endsWith('/' + file))).toBe(true);
    }
    expect(Buffer.from(graph.bundle).toString('utf8')).toContain('Schema-driven per-harness settings');
    expect(await verifyPrivateWorkspaceBrowserMount(input)).toMatchObject({
      mounted: true, settingsBlueprintDefault: true, settingsScopeSwitch: true,
    });
    // This mount uses explicit component responses. Private spec persistence,
    // cookie/Host denials and hosted acceptance need their own journey receipts.
  }, 180_000);

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);
it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private per-harness Settings saves config with denial retry reload and selected scope isolation', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-harness-settings-private.e2e.test.ts',
      retainedArtifacts: ['phases/prepare/operator-api-preflight.json', 'phases/execute/worker-result.json',
        'phases/execute/portal-browser-source.json', 'phases/execute/portal-browser-receipt.json',
        'phases/execute/portal-settings-initial-store.json', 'phases/execute/portal-settings-wire.json',
        'phases/execute/portal-settings-persistence.json'],
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/harness-registry.ts',
        'packages/operator-core/lib/harness-project-files.ts', 'packages/operator-core/lib/endpoint-route/routes/harness/spec.ts',
        'packages/operator-core/lib/sync-resolver/index.ts', 'packages/operator-core/lib/workspace-registry.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/blueprint-params.ts',
        'apps/operator/app/harness/BlueprintSettingsPanel.tsx', 'apps/operator/app/harness/HarnessSettingsPanel.tsx',
        'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: evidenceDir => { preparedApi = preparePrivateOperatorApiBundle(root, evidenceDir); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_HARNESS_SETTINGS_BROWSER_PROOF: '1' };
        for (const key of Object.keys(env)) if ((key.startsWith('ROSTER_') && key.endsWith('_BROWSER_PROOF')
          && !['ROSTER_COORD_BROWSER_PROOF', 'ROSTER_HARNESS_SETTINGS_BROWSER_PROOF'].includes(key))
          || ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION'].includes(key)) delete env[key];
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
          authMethod: 'private-loopback-harness-settings-with-cookie', workspace: expect.stringMatching(/^test-runtime-/),
          schemaDeniedRecovery: true, saveDeniedRetry: true, keyboardSave: true, configPgAgreement: true,
          reloadPersisted: true, unsavedScopeDiscarded: true, neighborIsolated: true, foreignExcluded: true,
          settingsBlueprintDefault: true, shellQueryPreserved: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_HARNESS_SETTINGS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

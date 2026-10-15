/** P-005: catch module/provider failures before private workflow allocation. */
import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePrivateRosterSocketRoot, preparePrivateOperatorApiBundle, preparePrivateWorkerSources } from '../../../test/private-http-workspace-preflight';
import { preparePortalBrowserSource } from '../../../test/private-http-workspace-preflight';
import { verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT)).each([
  ['Conversations aggregate', { conversations: true }],
  ['Plans create dock', { createDock: true }],
] as const)('real Portal %s graph mounts its original component before private allocation', async (_surface, mode) => {
  const portalSourceRoot = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
  expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot,
    selected: 'aggregate-create-preflight-selected', neighbor: 'aggregate-create-preflight-neighbor', ...mode,
  })).toMatchObject({ mounted: true });
}, 180_000);

const root = resolve(import.meta.dirname, '../../../../..');
it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real populated Conversations search and row roles work before private allocation', async () => {
    const portalSourceRoot = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot, conversations: true,
      selected: 'aggregate-role-selected', neighbor: 'aggregate-role-neighbor',
    }, { conversationsRead: true })).toMatchObject({ mounted: true });
  }, 180_000);
const options = isolatedWorkerOptions(360_000);
it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real populated Create Dock selects its neighbor and raw Markdown body before private allocation', async () => {
    const portalSourceRoot = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot, createDock: true,
      selected: 'create-role-selected', neighbor: 'create-role-neighbor',
    }, { createDockRead: true })).toMatchObject({ mounted: true });
  }, 180_000);
function aggregateWorkerEnv(proof: string, evidenceDir: string, ambient: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = { ...ambient, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
    ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', [proof]: '1',
    PAPERCUSP_COMMITTED_SOURCE_AUDIT: join(evidenceDir, 'worker-loaded-source.ndjson') };
  for (const key of Object.keys(env)) if ((key.startsWith('ROSTER_') && key.endsWith('_BROWSER_PROOF')
    && !['ROSTER_COORD_BROWSER_PROOF', proof].includes(key))
    || ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION'].includes(key)) delete env[key];
  return env;
}

it.each(['ROSTER_CONVERSATIONS_BROWSER_PROOF', 'ROSTER_CREATE_DOCK_BROWSER_PROOF'])(
  'aggregate proof environment preserves %s before private allocation', proof => {
    const env = aggregateWorkerEnv(proof, '/private-evidence', {
      ROSTER_GIT_BROWSER_PROOF: '1', ROSTER_STOP_HTTP_MUTATION: 'misroute',
      PC_HEAVY_PREEMPT_READY_FILE: '/enclosing-worker', PATH: '/test-path',
    });
    expect(env[proof]).toBe('1');
    expect(env.ROSTER_COORD_BROWSER_PROOF).toBe('1');
    expect(env.ROSTER_COORD_HTTP_PROOF).toBe('1');
    expect(env.ROSTER_GIT_BROWSER_PROOF).toBeUndefined();
    expect(env.ROSTER_STOP_HTTP_MUTATION).toBeUndefined();
    expect(env.PC_HEAVY_PREEMPT_READY_FILE).toBeUndefined();
    expect(env.PATH).toBe('/test-path');
  });
for (const [_surface, proof, expected] of [
  ['Conversations aggregate', 'ROSTER_CONVERSATIONS_BROWSER_PROOF', {
    authMethod: 'private-loopback-conversations-with-cookie', fourStoreSelection: true, filterReload: true,
    keyboardSelection: true, initialDenialRecovery: true, neighborDistinct: true, foreignExcluded: true, noProductWrites: true,
  }],
  ['Plans create dock', 'ROSTER_CREATE_DOCK_BROWSER_PROOF', {
    authMethod: 'private-loopback-create-dock-with-cookie', actualPlanSelection: true, neighborDistinct: true,
    selectedPlanReload: true, splitterPersisted: true, foreignExcluded: true,
  }],
] as const) it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  `real private ${_surface} persists selection with scoped API and original browser controls`, async context => {
  preparePrivateRosterSocketRoot();
  const workerSource = preparePrivateWorkerSources(root, ['scripts/with-test-pg.mjs',
    'packages/operator-core/test/roster-stop-http-fixture.ts',
    'packages/operator-core/test/portal-roster-browser-fixture.ts',
    'packages/operator-core/test/private-http-workspace-preflight.ts']);
  const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
  if (proof === 'ROSTER_CONVERSATIONS_BROWSER_PROOF') {
    await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource, conversations: true,
      selected: 'aggregate-role-selected', neighbor: 'aggregate-role-neighbor',
    }, { conversationsRead: true });
  } else {
    await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource, createDock: true,
      selected: 'create-role-selected', neighbor: 'create-role-neighbor',
    }, { createDockRead: true });
  }
  let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
  const prefix = proof === 'ROSTER_CONVERSATIONS_BROWSER_PROOF' ? 'portal-conversations' : 'portal-create-dock';
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-aggregate-create-private.e2e.test.ts',
    retainedArtifacts: ['phases/prepare/operator-api-preflight.json', 'phases/prepare/worker-source-preflight.json',
      'phases/execute/worker-loaded-source.ndjson', 'phases/execute/worker-result.json',
      'phases/execute/requested-browser-proof.json',
      'phases/execute/portal-browser-source.json', 'phases/execute/portal-browser-receipt.json',
      `phases/execute/${prefix}-seed.json`, `phases/execute/${prefix}-reads.json`,
      ...(proof === 'ROSTER_CONVERSATIONS_BROWSER_PROOF'
        ? ['phases/execute/portal-conversations-preflight.json', 'phases/execute/portal-conversations-denials.json']
        : ['phases/execute/portal-create-dock-preflight.json', 'phases/execute/portal-create-dock-persistence.json'])],
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
      'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/sync-resolver/index.ts',
      'packages/operator-core/lib/agent-tools/coordination/conversations-store.ts', 'packages/operator-core/lib/dock-layouts.ts',
      'apps/operator-vite/src/components/adv/AdvConversationsTab.tsx',
      'apps/operator-vite/src/components/conversations/unified-conversations.ts', 'apps/operator/app/adv/create/AdvCreateDock.tsx',
      'apps/operator/app/adv/create/PlansListPanel.tsx', 'apps/operator/app/adv/create/MainViewPanel.tsx',
      'apps/operator/app/harness/dock/HarnessDock.tsx', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts'],
    prepare: async evidenceDir => {
      await writeFile(join(evidenceDir, 'worker-source-preflight.json'), JSON.stringify(workerSource, null, 2));
      preparedApi = preparePrivateOperatorApiBundle(root, evidenceDir);
    },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const env = aggregateWorkerEnv(proof, evidenceDir);
      expect(env[proof]).toBe('1');
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
        '--portal-source=' + portalSource, '--prepared-api-sha=' + preparedApi.sha256, '--browser-proof=' + proof],
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
      expect(JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length))).toMatchObject(expected);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ROSTER_AGGREGATE_CREATE_BROWSER_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

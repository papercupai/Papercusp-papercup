import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { preparePortalBrowserSource, preparePrivateDocsBrowserDocuments, preparePrivateRosterSocketRoot, preparePrivateOperatorApiBundle } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, retainPortalResponse, verifyPortalOverviewNavigation, verifyPrivateDocsBrowserMount, verifyPrivateHarnessesBrowserMount, verifyPrivateProfileOriginControl, verifyPrivateHudReadPolicy, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';
import { startPrivateCupboardCatalog } from '../../../test/portal-cupboard-fixture';

const root = resolve(import.meta.dirname, '../../../../..');
const options = isolatedWorkerOptions(360_000);

it('private Health seed and browser readers release their worker database resources', async context => {
  preparePrivateRosterSocketRoot();
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
      'packages/operator-core/lib/pg-listen-hub.ts',
      'packages/operator-core/test/portal-roster-browser-fixture.ts',
      'packages/operator-core/test/isolated-integration-proof.ts'],
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_HEALTH_BROWSER_PROOF: '1' };
      for (const key of Object.keys(env)) if (key.startsWith('ROSTER_') && key.endsWith('_PROOF') &&
        !['ROSTER_COORD_BROWSER_PROOF', 'ROSTER_HEALTH_BROWSER_PROOF'].includes(key)) delete env[key];
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
        '--health-cleanup-proof'],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toContain('ROSTER_HEALTH_CLEANUP_SEEDED ');
      expect(result.output).toContain('"stage":"database-resources-closed","status":"complete"');
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ROSTER_HEALTH_CLEANUP_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

it('private Health HTTP reader observes a shared publication after its acknowledgement tick', async context => {
  preparePrivateRosterSocketRoot();
  let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
      'packages/operator-core/lib/pg-listen-hub.ts', 'packages/operator-core/lib/derived-reads/shared-snapshot.ts',
      'packages/operator-core/lib/system-health/compute.ts', 'packages/operator-core/test/portal-roster-browser-fixture.ts',
      'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
    prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
      { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
    execute: async (observe, evidenceDir) => {
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1',
        ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_HEALTH_BROWSER_PROOF: '1' };
      for (const key of Object.keys(env)) if (key.startsWith('ROSTER_') && key.endsWith('_PROOF') &&
        !['ROSTER_COORD_HTTP_PROOF', 'ROSTER_COORD_BROWSER_PROOF', 'ROSTER_HEALTH_BROWSER_PROOF'].includes(key)) delete env[key];
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
        '--health-publication-proof', '--prepared-api-sha=' + preparedApi.sha256],
      { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
      try { result = await captureIsolatedWorker(child, evidenceDir, options); }
      finally { await rm(join(evidenceDir, 'node_modules')); }
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toContain('ROSTER_HEALTH_PUBLICATION_RECEIPT ');
      const resources = JSON.parse(await readFile(join(evidenceDir, 'roster-stop-resources.json'), 'utf8')) as {
        pgConnections: Array<{ datname: string; application_name: string }>;
        retained: unknown[];
        activeResources: string[];
      };
      // The acknowledgement path opens a separate locks database. Checking
      // only db-org's pools missed the live socket that pinned this worker.
      expect(resources.pgConnections).toEqual(expect.arrayContaining([
        expect.objectContaining({ datname: 'papercusp_su', application_name: expect.stringContaining('su-lock-tx') }),
      ]));
      expect(resources.retained).toEqual([]);
      expect(resources.activeResources.filter(type => type === 'FSEventWrap' || type === 'FSWatcher')).toEqual([]);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ROSTER_HEALTH_PUBLICATION_PROOF_RUN ' + runId);
}, options.testTimeoutMs);

it('private Cupboard catalog preflight executes the maintained listing filters and excludes private rows before PG allocation', async () => {
  const evidence = await mkdtemp(join(tmpdir(), 'cupboard-preflight-'));
  let catalog: Awaited<ReturnType<typeof startPrivateCupboardCatalog>> | undefined;
  try {
    catalog = await startPrivateCupboardCatalog(evidence);
    const response = await fetch(catalog.base + '/listings?kind=pack&claim=unclaimed&q=' + encodeURIComponent(catalog.marker));
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<{ title: string }> };
    expect(body.results.map(row => row.title)).toEqual([catalog.selectedTitle]);
  } finally { await catalog?.close(); await rm(evidence, { recursive: true, force: true }); }
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Testing browser graph compiles through the maintained standalone boundary before private allocation', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const built = await buildPortalRosterBrowser({ portalSourceRoot: portalSource,
      selected: 'testing-boundary-selected', neighbor: 'testing-boundary-neighbor', testing: true });
    expect([...built.originals.keys()]).toContain(join(portalSource, 'apps/host/src/operator-surface-build.mjs'));
    expect([...built.originals.keys()]).toContain(join(root, 'apps/operator/app/adv/harnesses/HarnessTestsView.tsx'));
    expect([...built.originals.keys()].some(path => path.endsWith('/psu-connection-front-controller.mjs'))).toBe(false);
  }, 120_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private ADV Testing scopes registry and files across pot changes, Host denial recovery and reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', testing: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/endpoint-route/routes/harness/testing.ts',
        'packages/operator-core/lib/harness-registry.ts', 'packages/operator-core/lib/testing-domain-glob.ts',
        'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx', 'apps/operator/app/adv/harnesses/HarnessTestsView.tsx',
        'apps/operator/app/adv/harnesses/harness-testing-data-source.ts', 'libs/testing-shell/src/TestingShell.tsx',
        'libs/testing-shell/src/DomainTestPanel.tsx', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_TESTING_BROWSER_PROOF: '1' };
        for (const key of Object.keys(env)) if ((key.startsWith('ROSTER_') && key.endsWith('_BROWSER_PROOF')
          && !['ROSTER_COORD_BROWSER_PROOF', 'ROSTER_TESTING_BROWSER_PROOF'].includes(key))
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-testing-with-cookie',
          scopedFiles: true, keyboardNavigation: true, deepLinkReload: true, oldRegistryDiscarded: true,
          deniedRegistryRecovery: true, foreignExcluded: true, shellQueryPreserved: true, writes: [] });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_TESTING_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Insights panel recovers overview and token reads with exact pot query continuity using explicit component fixtures', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', insights: true }, { insightsRead: true });
    expect(result).toMatchObject({ mounted: true, insightsRead: true, keyboardTabs: true, tokensReload: true,
      coldRetry: true, warmRetry: true, tokenRetry: true, subjectPreserved: true, neighborDistinct: true,
      noOutwardWrites: true, providerUsed: false });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal PR panel filters and reloads exact details with read failure recovery using explicit component fixtures', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', prs: true }, { prsRead: true });
    expect(result).toMatchObject({ mounted: true, prsRead: true, filterKeyboard: true, detailReload: true,
      readRecovery: true, subjectPreserved: true, noOutwardWrites: true, providerUsed: false });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Frames selects and reloads SSE stills, recovers an explicit roster denial and closes streams using component fixtures', async context => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'frames-selected', neighbor: 'frames-neighbor', frames: true }, { framesRead: true });
    expect(result).toMatchObject({ mounted: true, framesRead: true, keyboardSelection: true, stillReload: true,
      rosterDenialRecovery: true, shellQueryPreserved: true, streamsClosed: true, noOutwardWrites: true,
      providerUsed: false, evidence: expect.any(String) });
    Object.assign(context.task.meta, { portalComponentEvidence: result.evidence });
    console.info('PORTAL_FRAMES_COMPONENT_EVIDENCE ' + result.evidence);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Evaluation selects suites, retains URL state and recovers cold and warm denials using component fixtures', async context => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'evals-selected', neighbor: 'evals-neighbor', evals: true }, { evalsRead: true });
    expect(result).toMatchObject({ mounted: true, evalsRead: true, suiteSelection: true, suiteReload: true,
      warmDenialRecovery: true, coldDenialRecovery: true, shellQueryPreserved: true,
      noOutwardWrites: true, providerUsed: false, evidence: expect.any(String) });
    Object.assign(context.task.meta, { portalComponentEvidence: result.evidence });
    console.info('PORTAL_EVALS_COMPONENT_EVIDENCE ' + result.evidence);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Support uses keyboard FAQs and recovers denied chat with streamed fixture response and exact reload scope', async context => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'support-selected', neighbor: 'support-neighbor', support: true }, { supportRead: true });
    expect(result).toMatchObject({ mounted: true, supportRead: true, keyboardFaq: true, denialRecovery: true,
      streamedAnswer: true, sessionScoped: true, humanEvent: true, deepLinkReload: true,
      shellQueryPreserved: true, noOutwardWrites: true, providerUsed: false, evidence: expect.any(String) });
    Object.assign(context.task.meta, { portalComponentEvidence: result.evidence });
    console.info('PORTAL_SUPPORT_COMPONENT_EVIDENCE ' + result.evidence);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Cupboard filters listings with keyboard, reloads URL state and recovers warm and cold fixture denials without installs', async context => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'cupboard-selected', neighbor: 'cupboard-neighbor', cupboard: true }, { cupboardRead: true });
    expect(result).toMatchObject({ mounted: true, cupboardRead: true, keyboardFilters: true, filterReload: true,
      warmDenial: true, coldDenial: true, keyboardRetry: true, shellQueryPreserved: true,
      noOutwardWrites: true, providerUsed: false, evidence: expect.any(String) });
    Object.assign(context.task.meta, { portalComponentEvidence: result.evidence });
    console.info('PORTAL_CUPBOARD_COMPONENT_EVIDENCE ' + result.evidence);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Dev invokes a schema tool with exact workspace context, reloads its deep link and recovers warm and cold fixture denials', async context => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'dev-selected', neighbor: 'dev-neighbor', dev: true }, { devRead: true });
    expect(result).toMatchObject({ mounted: true, devRead: true, keyboardTool: true, schemaInvocation: true,
      deepLinkReload: true, warmDenial: true, coldDenial: true, keyboardRetry: true, shellQueryPreserved: true,
      noOutwardWrites: true, providerUsed: false, evidence: expect.any(String) });
    Object.assign(context.task.meta, { portalComponentEvidence: result.evidence });
    console.info('PORTAL_DEV_COMPONENT_EVIDENCE ' + result.evidence);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Cupboard filters the migrated SQLite catalog through the public proxy and recovers actual Host denials across reload', async context => {
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL, 'private Cupboard requires a durable receipt sink before browser compilation').toBeTruthy();
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const catalogEvidence = await mkdtemp(join(tmpdir(), 'cupboard-preflight-'));
    try { const catalog = await startPrivateCupboardCatalog(catalogEvidence); await catalog.close(); }
    finally { await rm(catalogEvidence, { recursive: true, force: true }); }
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', cupboard: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/portal-cupboard-fixture.ts',
        'packages/operator-core/test/private-http-workspace-preflight.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/endpoint-route/routes/cupboard.ts', 'packages/operator-core/lib/cupboard/base-url.ts',
        'apps/operator-public/src/routes/listings.ts', 'apps/operator-public/src/db.ts',
        'apps/operator-public/src/__tests__/sqlite-d1.ts', 'apps/operator-public/src/__tests__/fake-d1.ts',
        'apps/operator-vite/src/routes/cupboard/index.tsx', 'apps/operator/app/cupboard/CupboardClient.tsx',
        'apps/operator/app/cupboard/CupboardErrorState.tsx', 'apps/operator/bin/hono-host.ts',
        'apps/operator/bin/host-handler.ts', 'apps/operator/bin/host-rebinding-guard.ts', 'apps/operator/bin/bundle-host.sh',
        'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_CUPBOARD_BROWSER_PROOF: '1' };
        for (const key of Object.keys(env)) if ((key.startsWith('ROSTER_') && key.endsWith('_BROWSER_PROOF')
          && !['ROSTER_COORD_BROWSER_PROOF', 'ROSTER_CUPBOARD_BROWSER_PROOF'].includes(key))
          || ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION'].includes(key)) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--', process.execPath,
          '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256], { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
          workspace: expect.stringMatching(/^test-runtime-/), privateSqliteCatalog: true, publicOperatorProxy: true,
          keyboardFilters: true, filterReload: true, warmHostDenialRecovery: true, coldHostDenialRecovery: true,
          hiddenListingExcluded: true, writes: [] });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_CUPBOARD_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Dev reads scoped activity through the catalog schema and recovers actual warm and cold Host denials across reload', async context => {
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL, 'private Dev requires a durable receipt sink before browser compilation').toBeTruthy();
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', dev: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/agent-tools/dev/activity.ts',
        'packages/operator-core/lib/dev-data.ts', 'packages/operator-core/lib/endpoint-route/routes/plugins/tools.ts',
        'packages/operator-core/lib/endpoint-route/routes/agent-tools/catchall.ts',
        'apps/operator-vite/src/routes/dev/index.tsx', 'apps/operator/app/dev/page.tsx',
        'apps/operator/app/dev/_components/ApiTab.tsx', 'apps/operator/app/dev/_components/SchemaForm.tsx',
        'apps/operator/app/dev/_components/WorkspacePicker.tsx', 'apps/operator/bin/hono-host.ts',
        'apps/operator/bin/host-handler.ts', 'apps/operator/bin/host-rebinding-guard.ts', 'apps/operator/bin/bundle-host.sh',
        'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_DEV_BROWSER_PROOF: '1' };
        for (const key of Object.keys(env)) if ((key.startsWith('ROSTER_') && key.endsWith('_BROWSER_PROOF')
          && !['ROSTER_COORD_BROWSER_PROOF', 'ROSTER_DEV_BROWSER_PROOF'].includes(key))
          || ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION'].includes(key)) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--', process.execPath,
          '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256], { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
          workspace: expect.stringMatching(/^test-runtime-/), scopedActivity: true, neighborDistinct: true,
          keyboardTool: true, schemaInvocation: true, deepLinkReload: true, shellQueryPreserved: true,
          warmHostDenialRecovery: true, coldHostDenialRecovery: true, writes: [] });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_DEV_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it('rejects Dev workflow evidence without the actual Dev route before browser allocation', async () => {
  await expect(verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: '/not-used', selected: 'selected', neighbor: 'neighbor' },
    { devRead: true })).rejects.toThrow('Dev workflow requires the actual Dev route');
});

it('retains a browser response rejection while an earlier UI action is still running', async () => {
  const failure = new Error('original browser response deadline');
  const pending = retainPortalResponse(Promise.reject(failure));
  await new Promise(done => setTimeout(done, 20));
  await expect(pending).rejects.toBe(failure);
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Insights reads scoped PG overview and tokens and recovers actual Host denials across reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'insights-selected', neighbor: 'insights-neighbor', insights: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/test/private-coord-receipt.ts',
        'packages/operator-core/lib/harness-insights/load-all.ts',
        'packages/operator-core/lib/harness-insights/load-spend.ts', 'packages/operator-core/lib/harness-insights/load-tokens.ts',
        'packages/operator-core/lib/harness-insights/github-facts.ts', 'packages/operator-core/lib/endpoint-route/routes/harness/insights.ts',
        'packages/operator-core/lib/sync-resolver/index.ts', 'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx',
        'apps/operator/app/harness/insights/InsightsTab.tsx', 'apps/operator/app/harness/insights/TokensView.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts', 'apps/operator/bin/bundle-host.sh',
        'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_INSIGHTS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF',
          'ROSTER_PLANS_BROWSER_PROOF', 'ROSTER_DOCS_BROWSER_PROOF', 'ROSTER_HUD_BROWSER_PROOF',
          'ROSTER_WORK_BROWSER_PROOF', 'ROSTER_HEALTH_BROWSER_PROOF', 'ROSTER_BRAINSTORM_BROWSER_PROOF']) delete env[key];
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-insights-with-cookie',
          overviewPgAgreement: true, tokensPgAgreement: true, keyboardTabs: true, tokensReload: true,
          coldRetry: true, warmRetry: true, tokenRetry: true, shellQueryPreserved: true, neighborDistinct: true,
          foreignExcluded: true, hostDenials: expect.any(Number),
          denialControls: ['cold-overview', 'token-refresh', 'warm-overview'], providerUsed: false });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_INSIGHTS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Brainstorm panel mounts and compiles its editor graph through the maintained standalone boundary', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', brainstorm: true });
    expect(result.mounted).toBe(true);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Brainstorm selected editors wait for Sync and hydrate the saved map and canvas', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const result = await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', brainstorm: true }, { brainstormHydration: true });
    expect(result).toMatchObject({ mounted: true, selectedHydration: true, noPendingWrites: true,
      savedMapRetained: true, savedCanvasRetained: true });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Brainstorm editors persist independent fields and recover from denied writes across reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot: portalSource,
      selected: 'brainstorm-selected', neighbor: 'brainstorm-neighbor', brainstorm: true }, { brainstormHydration: true });
    let preparedApi: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/harness-registry.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/brainstorm.ts', 'packages/operator-core/lib/sync-resolver/index.ts',
        'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx', 'apps/operator/app/harness/harness.css',
        'apps/operator/app/harness/brainstorm/BrainstormFull.tsx', 'apps/operator/app/harness/brainstorm/WriteView.tsx',
        'apps/operator/app/harness/brainstorm/MapView.tsx', 'apps/operator/app/harness/brainstorm/CanvasView.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_BRAINSTORM_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF',
          'ROSTER_PLANS_BROWSER_PROOF', 'ROSTER_DOCS_BROWSER_PROOF', 'ROSTER_HUD_BROWSER_PROOF',
          'ROSTER_WORK_BROWSER_PROOF', 'ROSTER_HEALTH_BROWSER_PROOF']) delete env[key];
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-brainstorm-with-cookie',
          textSaved: true, mapSaved: true, canvasSaved: true, deniedTextNoWrite: true, deniedMapNoWrite: true,
          deniedCanvasNoWrite: true, denialRetry: true, keyboardLayers: true, mapReload: true, canvasReload: true,
          textReload: true, shellQueryPreserved: true, neighborUnchanged: true, foreignUnchanged: true,
          selectedSyncRead: true, apiPgAgreement: true, hostDenials: 3, providerUsed: false });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_BRAINSTORM_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Health preserves drill-down and persists exact acknowledgement recovery across reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'health-selected', neighbor: 'health-neighbor', health: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/derived-reads/shared-snapshot.ts',
        'packages/operator-core/lib/system-health/history.ts', 'packages/operator-core/lib/system-health/acks.ts',
        'packages/operator-core/lib/agent-tools/system-health/ack.ts', 'packages/operator-core/lib/system-health/compute.ts',
        'packages/operator-core/lib/workspace-host/observability-store.ts',
        'packages/operator-core/lib/agent-tools/system-health/unack.ts', 'packages/operator-core/lib/work-items.ts',
        'packages/operator-core/lib/sync-resolver/index.ts', 'apps/operator-vite/src/components/adv/HealthTab.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_HEALTH_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF',
          'ROSTER_PLANS_BROWSER_PROOF', 'ROSTER_DOCS_BROWSER_PROOF', 'ROSTER_HUD_BROWSER_PROOF', 'ROSTER_WORK_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
          '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-health-with-cookie',
          snapshotRead: true, historyRead: true, keyboardExpansion: true, keyboardDrill: true, deepLinkReload: true,
          shellQueryPreserved: true, foreignSeedExcluded: true, denialStatus: 403, deniedAckNoWrite: true,
          denialControlRecovery: true, cancelledAckNoWrite: true, reasonValidation: true,
          acknowledged: true, unacknowledged: true, ackReload: true, unackReload: true, workItemsCollectorNeedsHuman: 1,
          hosted: { healthProducer: true, infraCollector: true, actualQuery: true, populatedView: true,
            failureRecovery: true, sampledApi: true, estimatedPlatformCost: true, customerCostExcluded: true, invoiceUnknown: true } });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_HEALTH_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Work opens the exact member by keyboard and retains scoped dock queries across reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await verifyPrivateHarnessesBrowserMount({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      harnesses: { hive: 'preflight-hive', selected: 'preflight-selected', neighbor: 'preflight-neighbor', foreign: 'preflight-foreign' } });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/harness-registry.ts',
        'packages/operator-core/lib/harness/projects-lite.ts', 'apps/operator/app/adv/harnesses/HarnessesWorkspace.tsx',
        'apps/operator/app/adv/harnesses/PotWorkspaceCards.tsx', 'apps/operator/app/adv/harnesses/PotMemberRail.tsx',
        'apps/operator/app/adv/harnesses/harness-axis.ts', 'apps/operator/app/adv/harnesses/WorkItemsPanel.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_WORK_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF',
          'ROSTER_PLANS_BROWSER_PROOF', 'ROSTER_DOCS_BROWSER_PROOF', 'ROSTER_HUD_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
          '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-work-with-cookie',
          keyboardDrill: true, keyboardMemberSelection: true, deepLinkReload: true, dockQueryRekeyed: true,
          shellQueryPreserved: true, foreignExcluded: true, foreignRegistryControl: true, denialStatus: 403,
          denialTransport: 'actual-private-work-external-host', selectionRetained: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_WORK_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Work browser graph mounts through the maintained standalone boundary', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    expect(await verifyPrivateHarnessesBrowserMount({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      harnesses: { hive: 'preflight-hive', selected: 'preflight-selected', neighbor: 'preflight-neighbor', foreign: 'preflight-foreign' },
    })).toMatchObject({ mounted: true, sourceCount: expect.any(Number) });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal HUD browser graph compiles through the maintained standalone boundary', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const built = await buildPortalRosterBrowser({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', hud: true });
    expect(built.bundle.length).toBeGreaterThan(0);
    expect([...built.originals.keys()].some(path => path.endsWith('/app/adv/hud/HudView.tsx'))).toBe(true);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal HUD filters the intended session and retains its filter across reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', hud: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/adv-roster.ts',
        'packages/operator-core/lib/adv-sessions.ts', 'packages/operator-core/lib/agent-tools/coordination/presence.ts',
        'apps/operator/app/adv/hud/HudView.tsx', 'apps/operator/app/adv/hud/HudBoard.tsx',
        'apps/operator/app/adv/hud/HudSearchBox.tsx', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_HUD_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF',
          'ROSTER_PLANS_BROWSER_PROOF', 'ROSTER_DOCS_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'),
          '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-with-cookie',
          keyboardFilter: true, selectedRetained: true, neighborFiltered: true, filterReset: true,
          deepLinkReload: true, shellQueryPreserved: true, denialStatus: 403,
          scopedWorkspaceArgs: true, foreignExcluded: true, globalForeignControl: true,
          denialTransport: 'actual-private-roster-external-host', retryReload: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_HUD_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Overview reads exact plans, recovers denial and opens its intended plan across reload', async context => {
    preparePrivateRosterSocketRoot();
    await verifyPrivateHudReadPolicy();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', overview: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'apps/operator-vite/src/components/adv/AdvOverviewTab.tsx',
        'apps/operator/app/adv/create/AdvCreateDock.tsx', 'apps/operator/app/admin/plans/plans-api.ts',
        'packages/operator-ui/src/seam.tsx', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_OVERVIEW_BROWSER_PROOF: '1' };
        for (const key of Object.keys(env)) if ((key.startsWith('ROSTER_') && key.endsWith('_BROWSER_PROOF')
          && !['ROSTER_COORD_BROWSER_PROOF', 'ROSTER_OVERVIEW_BROWSER_PROOF'].includes(key))
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
          workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'private-loopback-overview-with-cookie',
          keyboardNavigation: true, deepLinkReload: true, shellQueryPreserved: true,
          privatePlanRead: true, foreignExcluded: true, denialStatus: 403, denialRecovery: 'reload', writes: [] });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_OVERVIEW_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Overview opens its destination by keyboard and preserves it across reload', async () => {
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    expect(await verifyPortalOverviewNavigation(portalSource)).toMatchObject({
      keyboardNavigation: true, deepLinkReload: true, destination: 'create', shellQueryPreserved: true,
    });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private ADV Docs recovers cold and cached reads from Host denials and persists exact manual verification retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    const prepared = await preparePrivateDocsBrowserDocuments(root);
    await verifyPrivateDocsBrowserMount({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      docs: { harness: 'preflight-docs', ...prepared.selection },
      markdownPreflight: { value: prepared.bodies[prepared.selection.selectedDoc], heading: prepared.selection.selectedHeading } });
    await verifyPrivateProfileOriginControl();
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/endpoint-route/routes/harness/docs.ts',
        'packages/operator-core/lib/harness/docs/merged-read.ts', 'packages/operator-core/lib/harness/docs/manual-anchor.ts',
        'packages/operator-core/lib/harness/docs/doc-record.ts', 'packages/operator-core/lib/harness/docs/harness-repo.ts',
        'packages/operator-core/lib/harness-registry.ts', 'packages/operator-core/lib/harness/workspace-for-harness.ts',
        'apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx', 'apps/operator/app/adv/harnesses/AdvDocsTab.tsx',
        ...prepared.sourcePaths,
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_DOCS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF', 'ROSTER_PLANS_BROWSER_PROOF',
          'ROSTER_INSIGHTS_BROWSER_PROOF', 'ROSTER_HUD_BROWSER_PROOF', 'ROSTER_WORK_BROWSER_PROOF',
          'ROSTER_HEALTH_BROWSER_PROOF', 'ROSTER_BRAINSTORM_BROWSER_PROOF']) delete env[key];
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-docs-with-cookie', keyboardSelection: true, deepLinkReload: true,
          shellQueryPreserved: true, denialStatus: 403, articleRetained: true, deniedWriteIsolated: true,
          retryPersisted: true, neighborIsolated: true, denialTransport: 'real-upstream-response-forwarded',
          coldReadRetry: true, warmReadRetry: true, cachedArticleRetained: true, deniedReadNoWrite: true,
          readDenialControls: ['cold-read', 'warm-refresh'] });
        for (const control of receipt.readDenialControls) {
          const denials = receipt.readDenials.filter((row: { control: string }) => row.control === control);
          expect(denials.length).toBeGreaterThan(0);
          for (const denial of denials) expect(denial).toMatchObject({ status: 403,
            url: expect.stringContaining('/api/harness/' + receipt.harness + '/docs?') });
        }
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([403, 200]);
        expect(receipt.writes.map((write: { target: string }) => write.target)).toEqual([receipt.selectedDoc, receipt.selectedDoc]);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_DOCS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Plans filters across reload, cancels without writing and recovers its exact archive from Origin denial', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      plans: { selectedSlug: 'preflight-selected', neighborSlug: 'preflight-neighbor', selectedTitle: 'preflight-selected',
        neighborTitle: 'preflight-neighbor', harness: 'papercusp' } });
    await verifyPrivateProfileOriginControl();
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/agent-tools/plans/set-archived.ts',
        'packages/operator-core/lib/agent-tools/plans/_write-scope.ts', 'packages/operator-core/lib/agent-tools/plans/source.ts',
        'packages/operator-core/lib/agent-tools/plans/_ctx-opts.ts', 'packages/operator-core/lib/agent-tools/plans/list.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/plans.ts',
        'apps/operator/app/_components/plans/PlansPane.tsx', 'apps/operator/app/_components/plans/plans-pane.css',
        'apps/operator/app/harness/useConfirmDialog.tsx', 'apps/operator/app/admin/plans/plans-api.ts',
        'packages/operator-ui/src/surfaces/index.tsx', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_PLANS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-plans-with-cookie', filterKeyboard: true, deepLinkReload: true,
          shellQueryPreserved: true, cancelNoRequest: true, denialStatus: 403, deniedWriteIsolated: true,
          retryPersisted: true, neighborIsolated: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([403, 200]);
        expect(new Set(receipt.writes.map((write: { target: string }) => write.target))).toEqual(new Set([receipt.selectedSlug]));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_PLANS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Inbox retains selected deep links, isolates denied acknowledgment and persists its retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      inbox: { selectedMessageId: 'preflight-selected', neighborMessageId: 'preflight-neighbor',
        selectedTitle: 'preflight-selected', neighborTitle: 'preflight-neighbor' } });
    await verifyPrivateProfileOriginControl();
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/agent-tools/plans/attention.ts',
        'packages/operator-core/lib/agent-tools/plans/read-dispatch.ts',
        'libs/generic/tooldef-http/src/http-projection.ts',
        'packages/operator-core/lib/cache/cached-read.ts', 'packages/operator-core/lib/cache/pg-l2-store.ts',
        'packages/operator-core/lib/cache/l2-tier.ts', 'packages/operator-core/lib/cache/debounced-invalidate.ts',
        'packages/operator-core/lib/events/cache-eca-rule.ts',
        'libs/papercusp/libs/db/sql/1436-emit-change-notify-row-workspace.sql',
        'packages/operator-core/lib/agent-tools/coordination/messages.ts', 'packages/operator-core/lib/attention/adapters.ts',
        'packages/operator-core/lib/attention/terminal-action-dispatch.ts', 'packages/operator-core/lib/endpoint-route/routes/admin/coord.ts',
        'apps/operator/app/_components/inbox/InboxPane.tsx', 'apps/operator/app/_components/inbox/use-inbox-pending.ts',
        'apps/operator/app/admin/plans/PlanOtherList.tsx', 'apps/operator/app/admin/plans/attention-card.ts',
        'apps/operator/app/admin/plans/plans-api.ts', 'packages/operator-ui/src/surfaces/index.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_INBOX_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-inbox-with-cookie', keyboardSelection: true, deepLinkReload: true,
          shellQueryPreserved: true, denialStatus: 403, selectionRetained: true, deniedWriteIsolated: true,
          retryPersisted: true, neighborIsolated: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([403, 200]);
        expect(new Set(receipt.writes.map((write: { target: string }) => write.target)).size).toBe(1);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_INBOX_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Quick Panel prompts persist title and note, retain qp deep links and recover from a denied create', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', prompts: true });
    await verifyPrivateProfileOriginControl();
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/saved-prompts-client.ts',
        'packages/operator-core/lib/saved-prompts-store.ts', 'packages/operator-core/lib/saved-prompts-tree.ts',
        'packages/operator-core/lib/saved-prompts-materialize.ts', 'packages/operator-core/lib/cross-origin-url.ts',
        'packages/operator-core/lib/endpoint-route/routes/agent-mcp/saved-prompts.ts',
        'apps/operator/app/quick-panel/PromptsTab.tsx', 'apps/operator/app/harness/useDebouncedSave.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_PROMPTS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
          'ROSTER_SETTINGS_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-prompts-with-cookie', savedExactValue: true, bodySavedByKeyboard: true,
          deepLinkReload: true, shellQueryPreserved: true, denialStatus: 403, deniedWriteIsolated: true,
          existingOutlineRetained: true, retryPersisted: true, denialTransport: 'real-upstream-response-forwarded' });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([200, 200, 200, 403, 200]);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_PROMPTS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal Settings Profile saves across reload, retains a denied draft and persists its retry', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', settings: true });
    await verifyPrivateProfileOriginControl();
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/session.ts',
        'packages/operator-core/lib/operator-state-pg.ts', 'packages/operator-core/lib/endpoint-route/routes/misc/profile.ts',
        'apps/operator/app/settings/profile/page.tsx', 'apps/operator/lib/forms/useFormWith.ts',
        'apps/operator/lib/forms/FormField.tsx', 'apps/operator/lib/forms/SubmitButton.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_SETTINGS_BROWSER_PROOF: '1' };
        for (const key of ['PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE', 'ROSTER_STOP_HTTP_MUTATION',
          'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          authMethod: 'private-loopback-profile-with-cookie', savedExactValue: true, deepLinkReload: true,
          denialStatus: 403, draftRetained: true, deniedWriteIsolated: true, retryPersisted: true, retryReload: true });
        expect(receipt.writes.map((write: { status: number }) => write.status)).toEqual([200, 403, 200]);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_SETTINGS_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal shortcuts persist a remap across reload, deny a foreign Origin write and restore dispatch on reset', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor', shortcuts: true });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/shortcut-registry.ts',
        'packages/operator-core/lib/shortcut-bus.ts', 'packages/operator-core/lib/profile-pref.ts',
        'packages/operator-core/lib/endpoint-route/routes/misc/profile.ts',
        'apps/operator/app/settings/shortcuts/page.tsx', 'apps/operator/app/_components/GlobalShortcutDispatcher.tsx',
        'apps/operator/lib/hotkeys.ts', 'packages/operator-ui/src/shortcuts/index.tsx',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1',
          ROSTER_SHORTCUT_BROWSER_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        delete env.ROSTER_STOP_HTTP_MUTATION; delete env.ROSTER_HISTORY_BROWSER_PROOF;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
          authMethod: 'private-loopback-profile-with-cookie', remapImmediate: true, remapPersisted: true, deepLinkReload: true,
          resetRestoredDefault: true, denialStatus: 403, deniedWriteIsolated: true, oldChordFalsifier: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_SHORTCUT_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

// Portal is a separately maintained app. Missing source is an explicit skip,
// never a pass; acceptance runs must select its canonical source checkout.
it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal roster browser preserves denied draft, retries the exact private recipient and truthfully renders wake', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor' });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/private-coord-receipt.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/auth.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/coord.ts',
        'apps/operator/bin/host-spa.ts', 'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE; delete env.ROSTER_STOP_HTTP_MUTATION;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
        const receipt = JSON.parse(line!.slice('ROSTER_COORD_BROWSER_RECEIPT '.length));
        expect(receipt).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/), authMethod: 'cookie-session',
          denialStatus: 403, draftRetained: true, retryClearedDraft: true, deepLinkReload: true,
          neighborIsolated: true, positiveControl: 'wrong-recipient rejected' });
        expect(new Set(receipt.selectedMessageIds).size).toBe(2);
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_COORD_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real private Portal roster opens the selected native history and explicitly selects its GUI conversation across reload', async context => {
    preparePrivateRosterSocketRoot();
    const portalSource = preparePortalBrowserSource(['--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT]);
    await buildPortalRosterBrowser({ portalSourceRoot: portalSource, selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      history: { selectedSessionId: 1, neighborSessionId: 2, selectedRolloutId: 'preflight-selected-rollout',
        neighborRolloutId: 'preflight-neighbor-rollout', selectedMarker: 'preflight-selected', neighborMarker: 'preflight-neighbor' } });
    let preparedApi!: ReturnType<typeof preparePrivateOperatorApiBundle>;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/roster-stop-http-fixture.ts',
        'packages/operator-core/test/portal-roster-browser-fixture.ts', 'packages/operator-core/test/private-http-workspace-preflight.ts',
        'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/session-transcript-resolvers.ts',
        'apps/operator/app/adv/sessions/SessionHistoryModal.tsx', 'apps/operator/app/_components/chat/use-owner-session-chat.ts',
        'apps/operator/app/harness/AgentInspectorModal.tsx', 'apps/operator/app/harness/AgentThinkingStream.tsx',
        'packages/operator-core/lib/endpoint-route/routes/harness/streams.ts',
        'apps/operator/bin/hono-host.ts', 'apps/operator/bin/host-handler.ts',
        'apps/operator/bin/bundle-host-common.sh',
        'apps/operator/bin/bundle-host.sh'],
      prepare: async evidenceDir => { preparedApi = await preparePrivateOperatorApiBundle(root, evidenceDir,
        { builder: { timeoutMs: 240_000, maxMs: 420_000 } }); },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          ROSTER_STOP_HTTP_EVIDENCE_DIR: evidenceDir, ROSTER_COORD_HTTP_PROOF: '1', ROSTER_COORD_BROWSER_PROOF: '1', ROSTER_HISTORY_BROWSER_PROOF: '1' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE; delete env.PC_HEAVY_PSI_FINALIZATION_FILE; delete env.ROSTER_STOP_HTTP_MUTATION;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
          process.execPath, '--import', 'tsx', join(root, 'packages/operator-core/test/roster-stop-http-fixture.ts'), '--portal-source=' + portalSource,
          '--prepared-api-sha=' + preparedApi.sha256],
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
          authMethod: 'cookie-session', historyKeptSeparate: true, historyReload: true, explicitGuiSelection: true,
          conversationSelectionReload: true, neighborIsolated: true });
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ROSTER_HISTORY_BROWSER_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);

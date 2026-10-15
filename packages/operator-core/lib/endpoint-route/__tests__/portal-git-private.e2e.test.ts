/** P-005 Git acceptance begins at the actual maintained workspace graph. */
import { expect, it } from 'vitest';
import { preparePortalBrowserSource } from '../../../test/private-http-workspace-preflight';
import { buildPortalRosterBrowser, verifyPrivateWorkspaceBrowserMount } from '../../../test/portal-roster-browser-fixture';

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Git workspace compiles its dock, graph and commit detail before private allocation', async () => {
    const portalSourceRoot = preparePortalBrowserSource([
      '--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT,
    ]);
    const graph = await buildPortalRosterBrowser({ portalSourceRoot,
      selected: 'git-preflight-selected', neighbor: 'git-preflight-neighbor', git: true });
    for (const module of [
      '/apps/host/src/operator-surface-build.mjs',
      '/apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx',
      '/apps/operator/app/adv/harnesses/AdvGitWorkspace.tsx',
      '/apps/operator/app/adv/harnesses/AdvGitDock.tsx',
      '/apps/operator/app/adv/harnesses/AdvGitGraphPanel.tsx',
      '/libs/generic/git-graph/src/CommitDetail.tsx',
    ]) {
      expect([...graph.originals.keys()].some(path => path.endsWith(module)),
        `actual Git route graph must contain ${module}`).toBe(true);
    }
    expect([...graph.originals.keys()].some(path => path.endsWith('/scripts/psu-connection-front-controller.mjs')),
      'the maintained Portal boundary must keep the Node-only launcher outside the browser graph').toBe(false);
    expect(graph.bundle.byteLength).toBeGreaterThan(0);
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Git workspace renders selected commit detail with its root providers before private allocation', async () => {
    const portalSourceRoot = preparePortalBrowserSource([
      '--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT,
    ]);
    expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot,
      selected: 'git-preflight-selected', neighbor: 'git-preflight-neighbor', git: true },
    { gitRead: true })).toMatchObject({ selectedCommitDiff: true, commitReload: true, keyboardClose: true });
  }, 180_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'real Portal Git workspace initializes in the browser before private allocation', async () => {
    const portalSourceRoot = preparePortalBrowserSource([
      '--portal-source=' + process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT,
    ]);
    expect(await verifyPrivateWorkspaceBrowserMount({ portalSourceRoot,
      selected: 'git-preflight-selected', neighbor: 'git-preflight-neighbor', git: true })).toMatchObject({ mounted: true });
  }, 180_000);

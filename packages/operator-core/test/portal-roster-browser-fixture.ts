/** Actual Portal roster controls against the disposable cookie-authenticated API. */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, request as apiRequest, type BrowserContext, type Page } from 'playwright-core';
import { getOrgPg } from '@papercusp/db-org';
import { getMessageById, readAckedMsgIds, readInbox } from '../lib/agent-tools/coordination/messages';
import { verifyPrivateHistoryStreams, verifyPrivateStopReceipt, verifyPrivateInsightsDenialCoverage } from './private-coord-receipt';
import { portalBrowserPackagesPlugin, portalBrowserSurfaceBuild } from './private-http-workspace-preflight';
import type { PrRowData } from '../lib/pr-host/pr-row-data';
import type { PrViewerDetails } from '../lib/pr-host/pr-viewer';
import type { InsightsTabProps, TokensDashboardSnapshot } from '../lib/harness-insights/card-types';
import { runPrivateProjectHistoryPage, type PrivateProjectHistorySeed } from './portal-project-history-fixture';
import { runPrivateCalendarPage, type PrivateCalendarSeed } from './portal-calendar-fixture';
import { runPrivateLearningPage, type PrivateLearningSeed } from './portal-learning-fixture';
import { observeWorkflowDenialCycle, runPrivateWorkflowsPage, type PrivateWorkflowsSeed } from './portal-workflows-fixture';
import { runPrivateStatsPage, type PrivateStatsSeed } from './portal-stats-fixture';
import { runPrivateGitPage, type PrivateGitSeed } from './portal-git-fixture';
import { defaultAdvCreateLayout, defaultAdvGitLayout } from '../lib/dock-layouts';
import { runPrivateCupboardPage } from './portal-cupboard-fixture';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The host rejects this request before the inner auth:loopback route runs. */
export function verifyPrivateHudHostDenial(status: number, body: string) {
  assert.equal(status, 403, 'external Host must be denied by the actual operator host policy');
  assert.equal(JSON.parse(body).error?.code, 'host_not_allowed', 'HUD denial must identify the host guard');
}

/** Other mounted components subscribe to the global roster; arrival order is not scope. */
export function verifyPrivateHudCapturedRoster(reads: Array<Record<string, unknown>>, scope: {
  workspace: string; selected: string; neighbor: string; foreign: string;
}) {
  const read = reads.find(value => value.status === 200 && value.name === 'advRoster.list'
    && typeof value.url === 'string' && typeof value.args === 'string'
    && JSON.parse(value.args).workspaceId === scope.workspace);
  assert.ok(read, 'HUD must read the actual private roster endpoint with its exact workspace');
  const roster = (read.body as { rows: Array<{ active: Array<{ ownerId: string }> }> }).rows[0];
  assert.ok(roster?.active.some(row => row.ownerId === scope.selected), 'scoped roster must contain the selected owner');
  assert.ok(roster.active.some(row => row.ownerId === scope.neighbor), 'scoped roster must contain the neighbor owner');
  assert.equal(roster.active.some(row => row.ownerId === scope.foreign), false, 'scoped roster must exclude the foreign owner');
  return read;
}

/** Pin the measured global-first response shape cheaply before the private worker. */
export function verifyPrivateHudCapturePreflight() {
  const scope = { workspace: 'preflight-workspace', selected: 'selected', neighbor: 'neighbor', foreign: 'foreign' };
  const capture = (workspaceId: string | null, owners: string[]) => ({ status: 200, name: 'advRoster.list',
    url: 'http://127.0.0.1/api/zero-harness/rest-query', args: JSON.stringify({ workspaceId, endedLimit: 50 }),
    body: { rows: [{ active: owners.map(ownerId => ({ ownerId })) }] } });
  const global = capture(null, [scope.foreign, scope.neighbor, scope.selected]);
  const scoped = capture(scope.workspace, [scope.neighbor, scope.selected]);
  assert.equal(verifyPrivateHudCapturedRoster([global, scoped], scope), scoped);
  assert.equal(verifyPrivateHudCapturedRoster([scoped, global], scope), scoped);
  assert.throws(() => verifyPrivateHudCapturedRoster([global], scope), /exact workspace/);
  return { scopedCaptureVerified: true };
}

/** Exercise the production middleware order before allocating a private PG. */
export async function verifyPrivateHudReadPolicy() {
  await verifyPrivateHostHeaderTransport();
  verifyPrivateHudCapturePreflight();
  const { Hono } = await import('hono');
  const { hostRebindingGuard } = await import('../../../apps/operator/bin/host-rebinding-guard');
  const { requireLoopbackOr403 } = await import('../lib/endpoint-route/loopback-guard');
  const app = new Hono();
  let handlerReads = 0;
  // This preflight models the private desktop host, independently of the
  // launching operator's intentional remote-admin/distribution exemptions.
  app.use('/api/*', (c, next) => hostRebindingGuard(c, next, {}));
  app.get('/api/zero-harness/rest-query', c => {
    const refused = requireLoopbackOr403(c.req.raw);
    if (refused) return refused;
    handlerReads++;
    return c.json({ rows: [] });
  });
  const url = 'http://127.0.0.1/api/zero-harness/rest-query?name=advRoster.list';
  for (const token of ['selected-cookie', 'foreign-cookie']) {
    const allowed = await app.request(url, { headers: { host: '127.0.0.1', cookie: `session=${token}` } });
    assert.equal(allowed.status, 200, 'native read authorization is loopback, independently of workspace cookies');
  }
  const denied = await app.request(url, { headers: { host: 'foreign-roster.invalid', cookie: 'session=selected-cookie' } });
  verifyPrivateHudHostDenial(denied.status, await denied.text());
  assert.equal(handlerReads, 2, 'external Host must not reach the native read handler');
  return { denialStatus: 403, denialCode: 'host_not_allowed', allowedReads: 2 };
}

/** Measure the request header on the wire, before trusting a Host falsifier.
 * Node fetch may rewrite Host; the private browser uses Playwright's existing
 * API request context, which carries the explicit denial header unchanged. */
export async function verifyPrivateHostHeaderTransport() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ host: request.headers.host }));
  });
  const context = await apiRequest.newContext();
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', done);
    });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/`;
    const intendedHost = 'foreign-work.invalid';
    const fetchHost = (await (await fetch(url, { headers: { host: intendedHost } })).json()).host;
    const response = await context.get(url, { headers: { host: intendedHost } });
    const actualHost = (await response.json()).host;
    assert.equal(actualHost, intendedHost, 'private denial transport must deliver the intended Host on the wire');
    return { intendedHost, actualHost, fetchHost };
  } finally {
    await context.dispose();
    await new Promise<void>(done => server.close(() => done()));
  }
}
// Reuse the installed version that the actual MarkdownPreview imports. The
// production SPA likewise mounts its package tree at /vditor; Vditor appends
// /dist/js/lute/lute.min.js to that CDN root itself.
const vditorAssets = dirname(createRequire(import.meta.url).resolve('vditor/package.json'));

export interface PrivateConversationRow {
  id: string; title: string; body: string;
  source: 'threads' | 'deliberations' | 'agentchats' | 'messages';
  selection: 'conversation' | 'thread' | 'chat' | 'cmsg'; list: string; detail: string;
}
export interface PrivateConversationsSeed { workspace: string; own: PrivateConversationRow[]; foreign: PrivateConversationRow[] }
export interface PrivateCreateDockSeed {
  workspace: string; harness: string; selectedSlug: string; neighborSlug: string; foreignSlug: string;
}

type PortalRosterBrowserInput = {
  evidence: string; base: string; workspace: string; selected: string; neighbor: string; foreign?: string;
  portalSourceRoot: string;
  cookieName: string; ownToken: string; foreignToken: string;
  shortcuts?: boolean;
  settings?: boolean;
  harnessSettings?: boolean;
  conversations?: boolean;
  createDock?: boolean;
  conversationsSeed?: PrivateConversationsSeed;
  createDockPlans?: PrivateCreateDockSeed;
  settingsHarnesses?: { selected: string; neighbor: string; foreign: string };
  prompts?: boolean;
  overview?: boolean;
  projectHistory?: boolean;
  projectHistorySeed?: PrivateProjectHistorySeed;
  calendar?: boolean;
  learning?: boolean;
  learningSeed?: PrivateLearningSeed;
  workflows?: boolean;
  workflowsSeed?: PrivateWorkflowsSeed;
  stats?: boolean;
  git?: boolean;
  frames?: boolean;
  evals?: boolean;
  support?: boolean;
  cupboard?: boolean;
  cupboardSeed?: { marker: string; selectedTitle: string; neighborTitle: string; hiddenTitle: string };
  dev?: boolean;
  devSeed?: { selectedMarker: string; neighborMarker: string; foreignMarker: string; neighborWorkspace: string };
  statsSeed?: PrivateStatsSeed;
  gitSeed?: PrivateGitSeed;
  calendarSeed?: PrivateCalendarSeed;
  overviewPlans?: { selectedSlug: string; neighborSlug: string; foreignSlug: string; harness: string };
  hud?: boolean;
  health?: boolean;
  brainstorm?: boolean;
  prs?: boolean;
  insights?: boolean;
  testing?: boolean;
  testingHarnesses?: { selected: string; neighbor: string; foreign: string };
  insightsHarnesses?: { selected: string; neighbor: string; foreign: string };
  brainstormHarnesses?: { selected: string; neighbor: string; foreign: string };
  harnesses?: { hive: string; selected: string; neighbor: string; foreign: string };
  docs?: { harness: string; selectedDoc: string; neighborDoc: string; selectedHeading: string; neighborHeading: string };
  markdownPreflight?: { value: string; heading: string };
  plans?: { selectedSlug: string; neighborSlug: string; selectedTitle: string; neighborTitle: string; harness: string };
  inbox?: { selectedMessageId: string; neighborMessageId: string; selectedTitle: string; neighborTitle: string };
  history?: { selectedSessionId: number; neighborSessionId: number; selectedRolloutId: string; neighborRolloutId: string;
    selectedMarker: string; neighborMarker: string };
  verifyReceipt?: (receipt: { status: number; body: any }, summary: string, wake: boolean) => Promise<string>;
  stop?: {
    selected: { id: number; startedAt: string }; neighbor: { id: number; startedAt: string };
    assertChildrenAlive: () => Promise<void>; assertSelectedStopped: () => Promise<void>;
    assertNeighborAlive: () => Promise<void>; invalidateNeighborLaunch: () => Promise<void>;
  };
};

/** Compile the actual component graph without a browser, API or private PG. */
export async function buildPortalRosterBrowser(input: Pick<PortalRosterBrowserInput,
  'portalSourceRoot' | 'selected' | 'neighbor' | 'history' | 'stop' | 'shortcuts' | 'settings' | 'harnessSettings' | 'conversations' | 'createDock' | 'prompts' | 'overview' | 'projectHistory' | 'calendar' | 'learning' | 'workflows' | 'stats' | 'git' | 'frames' | 'evals' | 'support' | 'cupboard' | 'dev' | 'hud' | 'health' | 'brainstorm' | 'prs' | 'insights' | 'testing' | 'harnesses' | 'inbox' | 'plans' | 'docs' | 'markdownPreflight'>) {
  const { selected, neighbor } = input;
  const portal = realpathSync(input.portalSourceRoot);
  const rows = [selected, neighbor].map(ownerId => ({ ownerId, label: ownerId, agent: 'codex', role: 'worker',
    intent: 'Private browser roster canary', feature: null, currentPlanSlug: null, liveness: 'live',
    sessionState: 'live', heartbeatAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    isLocal: true, transcriptFresh: false,
    ...(input.stop ? { managedSessionId: (ownerId === selected ? input.stop.selected : input.stop.neighbor).id,
      launchStartedAt: (ownerId === selected ? input.stop.selected : input.stop.neighbor).startedAt } : {}) }));
  // Only the host geometry and supplied roster population are fixtures. The
  // component's native fetch, callbacks and HTTP receipts stay unmodified.
  const operatorRoot = resolve(import.meta.dirname, '../../../apps/operator');
  // Standalone browser proofs mount the product component directly instead of
  // going through the full SPA root. Keep the same per-window workspace
  // transport seam the real RootSyncProvider installs so query resolvers run
  // under the workspace selected by ?ws= rather than the process-global one.
  const entry = withPrivateBrowserWorkspaceHeader(input.dev ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { Route as DevRoute } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/routes/dev/index.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(DevRoute.options.component))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.cupboard ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { Route as CupboardRoute } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/routes/cupboard/index.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(CupboardRoute.options.component))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.support ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { Route as SupportRoute } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/routes/support.tsx'))};
    const routeTree = createRootRoute({ component: SupportRoute.options.component });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.evals ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import AdvEvalsTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvEvalsTab.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(AdvEvalsTab))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.frames ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider, useSyncQuery } from '@papercusp/sync';
    import AdvFramesTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvFramesTab.tsx'))};
    function Fixture() {
      const [open, setOpen] = React.useState(true);
      const localRoster = useSyncQuery({ queryName: 'desktops.local' });
      const ready = !localRoster.loading && !localRoster.error
        && localRoster.data?.some(row => row.id === 'fixture-local');
      return React.createElement(React.Fragment, null,
        React.createElement('button', { onClick: () => setOpen(!open) }, open ? 'Close Frames' : 'Open Frames'),
        open && ready ? React.createElement(AdvFramesTab) : null);
    }
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(Fixture))));
  ` : input.git ? `
    import * as React from 'react';
    import * as Tooltip from '@radix-ui/react-tooltip';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import AdvHarnessPanelPage from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvHarnessPanelPage.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(Tooltip.Provider,
      { delayDuration: 150, skipDelayDuration: 300 }, React.createElement(NuqsAdapter, null,
        React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
          React.createElement(AdvHarnessPanelPage, { panel: 'git' })))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.stats ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { AdvScopeProvider } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvShell.tsx'))};
    import AdvStatsTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvStatsTab.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(AdvScopeProvider, null, React.createElement(AdvStatsTab)))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.workflows ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { AdvScopeProvider } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvShell.tsx'))};
    import AdvWorkflowsTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvWorkflowsTab.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(AdvScopeProvider, null, React.createElement(AdvWorkflowsTab)))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.learning ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { AdvScopeProvider } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvShell.tsx'))};
    import LearningTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/LearningTab.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(AdvScopeProvider, null, React.createElement(LearningTab)))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.calendar ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import ScheduledCalendarTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/ScheduledCalendarTab.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(ScheduledCalendarTab))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.projectHistory ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { AdvScopeProvider } from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvShell.tsx'))};
    import AdvHistoryTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvHistoryTab.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(AdvScopeProvider, null, React.createElement(AdvHistoryTab)))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.health ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { parseAsString, useQueryState } from 'nuqs';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { configureOperatorUi } from '@papercusp/operator-ui/seam';
    import { ADV_TAB_SURFACE_KINDS } from '@papercusp/operator-ui/adv-navigation';
    import HealthTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/HealthTab.tsx'))};
    configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
    function Fixture() {
      const [app] = useQueryState('app', parseAsString.withDefault('health'));
      return React.createElement(React.Fragment, null,
        app === 'health' ? React.createElement(HealthTab) : null,
        React.createElement('output', { 'data-testid': 'health-destination' }, app));
    }
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(Fixture))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.overview ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { parseAsString, useQueryState } from 'nuqs';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { configureOperatorUi } from '@papercusp/operator-ui/seam';
    import { ADV_TAB_SURFACE_KINDS } from '@papercusp/operator-ui/adv-navigation';
    import AdvOverviewTab from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvOverviewTab.tsx'))};
    import AdvCreateDock from ${JSON.stringify(join(operatorRoot, 'app/adv/create/AdvCreateDock.tsx'))};
    configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
    function Fixture() {
      const [app] = useQueryState('app', parseAsString.withDefault('overview'));
      return React.createElement(React.Fragment, null,
        React.createElement(app === 'overview' ? AdvOverviewTab : AdvCreateDock),
        React.createElement('output', { 'data-testid': 'overview-destination' }, app));
    }
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(Fixture))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.hud ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { parseAsString, useQueryState } from 'nuqs';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import HudView from ${JSON.stringify(join(operatorRoot, 'app/adv/hud/HudView.tsx'))};
    function Fixture() {
      const [workspaceId] = useQueryState('ws', parseAsString);
      if (!workspaceId) throw new Error('Private HUD fixture requires an explicit workspace');
      return React.createElement(HudView, { workspaceId });
    }
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(Fixture))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.harnesses ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { Toaster } from 'sonner';
    import HarnessesWorkspace from ${JSON.stringify(join(operatorRoot, 'app/adv/harnesses/HarnessesWorkspace.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(HarnessesWorkspace), React.createElement(Toaster)))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.docs || input.brainstorm || input.prs || input.insights || input.testing || input.harnessSettings ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { parseAsString, useQueryState } from 'nuqs';
    import { RouterProvider, createRouter, createRootRoute } from '@tanstack/react-router';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import AdvHarnessPanelPage from ${JSON.stringify(resolve(operatorRoot, '../operator-vite/src/components/adv/AdvHarnessPanelPage.tsx'))};
    import { MarkdownPreview } from ${JSON.stringify(join(operatorRoot, 'app/_components/MarkdownEditor.tsx'))};
    const panel = React.createElement(React.Fragment, null,
      React.createElement(AdvHarnessPanelPage, { panel: ${JSON.stringify(input.harnessSettings ? 'settings' : input.testing ? 'testing' : input.insights ? 'insights' : input.prs ? 'prs' : input.brainstorm ? 'brainstorm' : 'docs')} }),
      ${input.brainstorm || input.prs || input.harnessSettings ? 'React.createElement(Toaster)' : 'null'},
      ${input.markdownPreflight ? `React.createElement(MarkdownPreview, { value: ${JSON.stringify(input.markdownPreflight.value)} })` : 'null'});
    function Fixture() {
      const [open, setOpen] = React.useState(true);
      const [, setSlug] = useQueryState('slug', parseAsString);
      return React.createElement(React.Fragment, null,
        ${input.testing ? `React.createElement('button', { 'data-testid': 'testing-switch-pot', onClick: () => setSlug(new URL(location.href).searchParams.get('nextPot')) }, 'Switch test pot'),` : ''}
        ${input.harnessSettings ? `React.createElement('button', { 'data-testid': 'settings-switch-pot', onClick: () => setSlug(new URL(location.href).searchParams.get('nextPot')) }, 'Switch settings pot'),` : ''}
        ${input.insights ? "React.createElement('button', { onClick: () => setOpen(!open) }, open ? 'Close Insights' : 'Open Insights')," : ''}
        open ? panel : null);
    }
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      ${input.brainstorm || input.prs || input.insights || input.testing || input.harnessSettings ? "React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' }, React.createElement(Fixture))" : 'panel'}) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.conversations || input.createDock ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
    import { NuqsAdapter } from 'nuqs/adapters/tanstack-router';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import Workspace from ${JSON.stringify(input.conversations
      ? resolve(operatorRoot, '../operator-vite/src/components/adv/AdvConversationsTab.tsx')
      : join(operatorRoot, 'app/adv/create/AdvCreateDock.tsx'))};
    const routeTree = createRootRoute({ component: () => React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(Workspace), React.createElement(Toaster)))) });
    const router = createRouter({ routeTree });
    createRoot(document.getElementById('root')).render(React.createElement(RouterProvider, { router }));
  ` : input.plans ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import PlansPane from ${JSON.stringify(join(operatorRoot, 'app/_components/plans/PlansPane.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(PlansPane, { layout: 'split' }),
          React.createElement(Toaster)))));
  ` : input.inbox ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import InboxPane from ${JSON.stringify(join(operatorRoot, 'app/_components/inbox/InboxPane.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(InboxPane, { layout: 'split' }),
          React.createElement(Toaster)))));
  ` : input.prompts ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import PromptsTab from ${JSON.stringify(join(operatorRoot, 'app/quick-panel/PromptsTab.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(PromptsTab, { queryPrefix: 'qp' }),
          React.createElement(Toaster)))));
  ` : input.settings ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { Toaster } from 'sonner';
    import ProfilePage from ${JSON.stringify(join(operatorRoot, 'app/settings/profile/page.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(React.Fragment, null, React.createElement(ProfilePage), React.createElement(Toaster))));
  ` : input.shortcuts ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { parseAsString, useQueryState } from 'nuqs';
    import { PortalShortcuts } from './packages/ui/src/portal-shortcuts.tsx';
    import ShortcutsSettingsPage from ${JSON.stringify(join(operatorRoot, 'app/settings/shortcuts/page.tsx'))};
    function Fixture() {
      const [panel, setPanel] = useQueryState('panel', parseAsString);
      const [active, setActive] = useQueryState('app', parseAsString.withDefault('settings'));
      return React.createElement(React.Fragment, null,
        React.createElement(PortalShortcuts, { panel, setPanel, active, setActive,
          railKinds: ['overview', 'plans', 'inbox'], openCreatePot: () => setActive('overview') }),
        React.createElement(ShortcutsSettingsPage),
        React.createElement('output', { 'data-testid': 'private-shortcut-panel' }, panel || 'none'),
        React.createElement('output', { 'data-testid': 'private-shortcut-app' }, active));
    }
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null, React.createElement(Fixture)));
  ` : input.history ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { parseAsString, useQueryState } from 'nuqs';
    import { PortalAgentsPopover, usePortalSessionHistoryActions } from './packages/ui/src/agents-popover.tsx';
    import SessionHistoryModal from ${JSON.stringify(join(operatorRoot, 'app/adv/sessions/SessionHistoryModal.tsx'))};
    function Fixture() {
      const actions = usePortalSessionHistoryActions();
      const [panel] = useQueryState('panel', parseAsString);
      const [conversation] = useQueryState('agentConversation', parseAsString);
      return React.createElement(React.Fragment, null,
        React.createElement(PortalAgentsPopover, {
          agents: ${JSON.stringify(rows)}, open: panel === 'agents', onClose: () => {},
          onInspectSession: actions.inspectAgentSession, onOpenEndedSession: actions.openEndedSession,
          loadEndedSessions: async () => ({ sessions: ${JSON.stringify([{ id: input.history.selectedSessionId,
            agent: 'codex', coordOwnerId: selected, mode: 'console', label: 'Pinned private session',
            startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0 }])}, hasMore: false, nextBefore: null }),
        }),
        React.createElement(SessionHistoryModal),
        React.createElement('output', { 'data-testid': 'private-conversation-selection' }, conversation || 'none'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' }, React.createElement(Fixture))));
  ` : `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PortalAgentsPopover } from './packages/ui/src/agents-popover.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(PortalAgentsPopover, {
      agents: ${JSON.stringify(rows)}, open: true, onClose: () => {},
      loadEndedSessions: async () => ({ sessions: [], hasMore: false, nextBefore: null }),
    }));
  `);
  const originals = new Map<string, { sha256: string; bytes: number }>();
  const standaloneRouter = Boolean(input.docs || input.brainstorm || input.prs || input.insights || input.testing || input.harnessSettings || input.conversations || input.createDock
    || input.overview || input.hud || input.health || input.harnesses || input.projectHistory || input.calendar || input.learning || input.workflows || input.stats || input.git || input.frames || input.evals || input.support || input.cupboard || input.dev);
  const boundary = input.inbox || input.plans || standaloneRouter
    ? await portalBrowserSurfaceBuild(portal, { standaloneRouter }) : undefined;
  if (boundary) {
    const contents = readFileSync(boundary.source);
    originals.set(boundary.source, { sha256: digest(contents), bytes: contents.length });
  }
  // CSS-enabled graphs must also resolve packages' style-conditioned exports.
  // Keep the loader and resolution predicates together as new modes are added.
  const retainBrowserCss = Boolean(input.brainstorm || input.calendar || input.workflows || input.stats || input.git || input.dev || input.conversations || input.createDock);
  const result = await build({ absWorkingDir: portal,
    stdin: { contents: entry, loader: 'ts', resolveDir: portal, sourcefile: 'private-roster-browser-entry.ts' },
    alias: { react: resolve(portal, 'node_modules/react'), 'react-dom': resolve(portal, 'node_modules/react-dom'),
      // The generated entry resolves from Portal, while CommitDetail resolves
      // from the shared tree. Their provider must share the same Radix context.
      ...(input.git ? { '@radix-ui/react-tooltip': dirname(dirname(
        createRequire(join(operatorRoot, 'package.json')).resolve('@radix-ui/react-tooltip'))) } : {}) },
    tsconfigRaw: { compilerOptions: { baseUrl: resolve(import.meta.dirname, '../../..'),
      paths: { '@/*': ['apps/operator/*'], ...boundary?.paths }, jsx: 'react-jsx' } },
    loader: { '.css': retainBrowserCss ? 'css' : 'empty', '.module.css': 'local-css',
      '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    ...(boundary ? { define: { ...boundary.define,
      ...(input.support ? { 'process.env.NEXT_PUBLIC_PAPERCUSP_API_BASE': JSON.stringify('') } : {}) } } : {}),
    // Browser packages may export CSS only under development/production (e.g.
    // Excalidraw). Use the real production export instead of a fixture alias.
    conditions: ['browser', 'production', ...(retainBrowserCss ? ['style'] : [])],
    // The actual noVNC dependency uses top-level await. Preserve its native
    // module semantics instead of stripping or stubbing the live-view graph.
    bundle: true, format: input.frames ? 'esm' : 'iife', platform: 'browser', target: 'es2022', write: false,
    outfile: join(portal, 'private-roster-browser.js'),
    logLevel: 'silent',
    plugins: [portalBrowserPackagesPlugin(portal), ...(boundary ? [boundary.plugin] : []), { name: 'retain-executed-browser-inputs', setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, ({ path }) => {
        const contents = readFileSync(path);
        originals.set(path, { sha256: digest(contents), bytes: contents.length });
        return { contents, loader: path.endsWith('.module.css') ? 'local-css' : retainBrowserCss ? 'css' : 'empty' };
      });
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
        const contents = readFileSync(path);
        originals.set(path, { sha256: digest(contents), bytes: contents.length });
        const extension = extname(path).slice(1);
        return { contents, loader: extension === 'tsx' || extension === 'jsx' ? extension : extension === 'ts' ? 'ts' : 'js' };
      });
    } }],
  });
  const bundle = result.outputFiles.find(file => file.path.endsWith('.js'))!.contents;
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  if (input.brainstorm) {
    for (const selector of ['.excalidraw__canvas', '.react-flow__renderer', '.bn-editor']) {
      assert.ok(css.includes(selector), `Brainstorm editor preflight requires the actual ${selector} stylesheet`);
    }
  }
  for (const [path, identity] of originals) assert.equal(digest(readFileSync(path)), identity.sha256,
    `Browser input changed during build: ${path}`);
  if (input.projectHistory) {
    for (const suffix of ['/apps/operator-vite/src/components/adv/AdvShell.tsx',
      '/libs/generic/ui-primitives/src/ProjectHistoryView.tsx', '/libs/generic/ui-primitives/src/ActivityTimelineView.tsx']) {
      assert.ok([...originals.keys()].some(path => path.endsWith(suffix)), `History browser graph requires ${suffix}`);
    }
  }
  if (input.frames) {
    for (const suffix of ['/apps/operator-vite/src/components/adv/AdvFramesTab.tsx',
      '/apps/operator-vite/src/components/adv/FrameVncView.tsx',
      '/apps/operator-vite/src/components/adv/FrameScreenTrackView.tsx',
      '/node_modules/@novnc/novnc/core/util/browser.js']) {
      assert.ok([...originals.keys()].some(path => path.endsWith(suffix)), `Frames preflight requires native ${suffix}`);
    }
  }
  if (input.support) {
    const routerContexts = [...originals.keys()].filter(path => path.includes('/@tanstack/react-router/')
      && /\/routerContext\.(?:js|cjs)$/.test(path));
    assert.equal(routerContexts.length, 1, 'Support preflight requires one actual router context across entry and route');
    for (const suffix of ['/apps/operator-vite/src/routes/support.tsx',
      '/apps/operator/app/_components/SupportAgentPanel.tsx', '/apps/operator/app/_components/SupportChatButton.tsx']) {
      assert.ok([...originals.keys()].some(path => path.endsWith(suffix)), `Support preflight requires actual ${suffix}`);
    }
  }
  if (input.cupboard) {
    for (const suffix of ['/apps/operator/app/cupboard/CupboardClient.tsx',
      '/apps/operator/app/cupboard/CupboardErrorState.tsx']) {
      assert.ok([...originals.keys()].some(path => path.endsWith(suffix)), `Cupboard browser graph requires ${suffix}`);
    }
  }
  if (input.dev) {
    for (const module of ['ApiTab', 'WorkspacePicker', 'SchemaForm', 'RightRail', 'IpcTab']) {
      assert.ok([...originals.keys()].some(path => path.endsWith(`/app/dev/_components/${module}.tsx`)),
        `Dev browser graph requires actual ${module}`);
    }
    assert.ok([...originals.keys()].some(path => path.endsWith('/apps/operator/app/dev/page.tsx')),
      'Dev browser graph requires the actual page');
    assert.ok([...originals.keys()].some(path => path.endsWith('/packages/operator-core/lib/transport-adapters/index.ts')),
      'Dev browser graph requires the real IPC transport barrel through the maintained prefix alias');
  }
  if (input.conversations || input.createDock) {
    const syncContexts = [...originals.keys()].filter(path => path.endsWith('/sync/src/SyncContext.ts'));
    const selectedSync = createRequire(join(operatorRoot, 'package.json')).resolve('@papercusp/sync');
    assert.deepEqual(syncContexts, [join(dirname(selectedSync), 'SyncContext.ts')],
      'Aggregate browser provider and panels must use one SyncContext from the selected operator checkout');
  }
  assert.ok([...originals.keys()].some(path => path.endsWith(input.dev
    ? '/apps/operator-vite/src/routes/dev/index.tsx' : input.conversations
    ? '/apps/operator-vite/src/components/adv/AdvConversationsTab.tsx' : input.createDock
    ? '/apps/operator/app/adv/create/AdvCreateDock.tsx' : input.cupboard
    ? '/apps/operator-vite/src/routes/cupboard/index.tsx' : input.support
    ? '/apps/operator-vite/src/routes/support.tsx' : input.evals
    ? '/apps/operator-vite/src/components/adv/AdvEvalsTab.tsx' : input.frames
    ? '/apps/operator-vite/src/components/adv/AdvFramesTab.tsx' : input.git
    ? '/apps/operator/app/adv/harnesses/AdvGitWorkspace.tsx' : input.stats
    ? '/apps/operator-vite/src/components/adv/AdvStatsTab.tsx' : input.workflows
    ? '/apps/operator-vite/src/components/adv/AdvWorkflowsTab.tsx' : input.learning
    ? '/apps/operator-vite/src/components/adv/LearningTab.tsx' : input.calendar
    ? '/apps/operator-vite/src/components/adv/ScheduledCalendarTab.tsx' : input.projectHistory
    ? '/apps/operator-vite/src/components/adv/AdvHistoryTab.tsx' : input.health
    ? '/apps/operator-vite/src/components/adv/HealthTab.tsx' : input.overview
    ? '/apps/operator-vite/src/components/adv/AdvOverviewTab.tsx' : input.hud
    ? '/apps/operator/app/adv/hud/HudView.tsx' : input.harnesses
    ? '/apps/operator/app/adv/harnesses/HarnessesWorkspace.tsx' : input.harnessSettings
    ? '/apps/operator-vite/src/components/adv/AdvHarnessPanelPage.tsx' : input.brainstorm
    ? '/apps/operator/app/harness/brainstorm/BrainstormFull.tsx' : input.prs
    ? '/apps/operator/app/harness/PrsTab.tsx' : input.insights
    ? '/apps/operator/app/harness/insights/InsightsTab.tsx' : input.testing
    ? '/apps/operator/app/adv/harnesses/HarnessTestsView.tsx' : input.docs
    ? '/apps/operator/app/adv/harnesses/AdvDocsTab.tsx' : input.plans
    ? '/apps/operator/app/_components/plans/PlansPane.tsx' : input.inbox
    ? '/apps/operator/app/_components/inbox/InboxPane.tsx' : input.prompts
    ? '/apps/operator/app/quick-panel/PromptsTab.tsx' : input.settings
      ? '/apps/operator/app/settings/profile/page.tsx' : input.shortcuts
      ? '/packages/ui/src/portal-shortcuts.tsx' : '/packages/ui/src/agents-popover.tsx')),
    'Executed bundle must contain the actual product control');
  return { portal, entry, bundle, css, originals };
}

/** Keep the real per-window workspace fetch seam ahead of every standalone product entry. */
export function withPrivateBrowserWorkspaceHeader(entry: string): string {
  return `
    import { installWorkspaceHeaderFetch } from '@papercusp/operator-core/lib/transport-adapters/workspace-header-fetch';
    installWorkspaceHeaderFetch();
  ` + entry;
}

/** A failing action must leave its original rendered state before teardown. */
export async function retainPortalBrowserFailure(page: Pick<Page, 'url' | 'content' | 'locator' | 'screenshot'>,
  evidence: string, error: unknown, pageErrors: readonly string[]) {
  const results = await Promise.allSettled([
    page.content(), page.locator('body').innerText({ timeout: 3_000 }), page.locator('button').allTextContents(),
    page.screenshot({ path: join(evidence, 'portal-browser-failure.png'), timeout: 3_000, animations: 'disabled' }),
  ]);
  if (results[0].status === 'fulfilled') writeFileSync(join(evidence, 'portal-browser-failure.html'), results[0].value);
  const snapshot = { url: page.url(), message: error instanceof Error ? error.message : String(error), pageErrors,
    text: results[1].status === 'fulfilled' ? results[1].value : null,
    buttons: results[2].status === 'fulfilled' ? results[2].value : null,
    diagnosticErrors: results.flatMap((result, index) => result.status === 'rejected' ? [{ index, message: String(result.reason) }] : []) };
  writeFileSync(join(evidence, 'portal-browser-failure.json'), JSON.stringify(snapshot, null, 2));
}

/** Start observing a response before driving its UI action. The original
 * rejection still reaches the later await; it cannot kill the worker while
 * Playwright is reporting an earlier action failure. */
export function retainPortalResponse<T>(pending: Promise<T>): Promise<T> {
  void pending.catch(() => {});
  return pending;
}

/** Capture the browser's actual query body while reload is still settling.
 * Waiting for navigation first can leave CDP with an expired response id.
 * Playwright's json() already waits for the response body to finish. */
export async function reloadPrivateHealthSnapshot<T>(page: Pick<Page, 'waitForResponse' | 'reload'>): Promise<{ rows: T[] }> {
  const bodyPromise = retainPortalResponse(page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.status() === 200 && url.searchParams.get('name') === 'health.snapshot';
  }).then(response => response.json() as Promise<{ rows: T[] }>));
  const [body] = await Promise.all([bodyPromise, page.reload()]);
  return body;
}

/** Evaluate the real ADV module graph before allocating a private database. */
export async function verifyPrivateDocsBrowserMount(input: Parameters<typeof buildPortalRosterBrowser>[0]) {
  assert.ok(input.docs, 'Docs preflight requires a Docs surface');
  return verifyPrivateWorkspaceBrowserMount(input);
}

export async function verifyPrivateHarnessesBrowserMount(input: Parameters<typeof buildPortalRosterBrowser>[0]) {
  assert.ok(input.harnesses, 'Harnesses preflight requires the actual Work surface');
  return verifyPrivateWorkspaceBrowserMount(input);
}

function conversationSearchControl(page: Page) {
  return page.getByRole('region', { name: 'Conversation list', exact: true })
    .getByRole('searchbox', { name: 'Search conversations', exact: true });
}

function createDockPlanBody(main: ReturnType<Page['locator']>, body: string) {
  // The real renderer can fall back to a preformatted Markdown document.
  // Scope to the detail pane and accept its surrounding Markdown syntax.
  return main.getByText(body, { exact: false }).first();
}

export async function verifyPrivateWorkspaceBrowserMount(input: Parameters<typeof buildPortalRosterBrowser>[0],
  options: { brainstormHydration?: boolean; prsRead?: boolean; insightsRead?: boolean; workflowsRead?: boolean;
    workflowsDeniedResponseDelayMs?: number; gitRead?: boolean; framesRead?: boolean; evalsRead?: boolean; supportRead?: boolean; cupboardRead?: boolean; devRead?: boolean; conversationsRead?: boolean; createDockRead?: boolean } = {}) {
  assert.ok(!options.brainstormHydration || input.brainstorm, 'Hydration preflight requires Brainstorm');
  assert.ok(!options.prsRead || input.prs, 'PR read preflight requires the PR panel');
  assert.ok(!options.insightsRead || input.insights, 'Insights read preflight requires the Insights panel');
  assert.ok(!options.workflowsRead || input.workflows, 'Workflows read preflight requires Workflows');
  assert.ok(!options.gitRead || input.git, 'Git read preflight requires the Git workspace');
  assert.ok(!options.framesRead || input.frames, 'Frames read preflight requires the Frames panel');
  assert.ok(!options.evalsRead || input.evals, 'Evaluation read preflight requires Evaluation');
  assert.ok(!options.supportRead || input.support, 'Support workflow requires the actual Support route');
  assert.ok(!options.cupboardRead || input.cupboard, 'Cupboard workflow requires the actual Cupboard route');
  assert.ok(!options.devRead || input.dev, 'Dev workflow requires the actual Dev route');
  assert.ok(!options.conversationsRead || input.conversations, 'Conversation controls require the actual aggregate');
  assert.ok(!options.createDockRead || input.createDock, 'Create controls require the actual dock');
  const built = await buildPortalRosterBrowser(input);
  if (options.gitRead) {
    const tooltipPackages = new Set([...built.originals.keys()].filter(path =>
      path.includes('/node_modules/@radix-ui/react-tooltip/')).map(path =>
      path.split('/node_modules/@radix-ui/react-tooltip/')[0]));
    assert.equal(tooltipPackages.size, 1, 'Git provider and consumer must use one Radix tooltip package');
  }
  const browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const writes: Array<{ surface: string; body: any }> = [];
  const reads: Array<{ name: string | null; args: any }> = [];
  let framesDenied = false;
  let evalsDenied = false;
  let evalsDenialPhase: 'warm' | 'cold' | null = null;
  const frameStreams: Array<{ slug: string; closed: Promise<void> }> = [];
  const supportRequests: Array<{ sessionId: string; message: string; surface: string; status: number }> = [];
  const outwardRequests: string[] = [];
  const devInvocations: Array<{ query: Record<string, string>; args: unknown; status: number }> = [];
  const devTool = { name: 'dev:activity', pluginName: 'agent-mcp', description: 'Explicit fixture recent activity read',
    capabilities: [], expose: { http: { path: '/api/agent-tools/dev/activity', methods: ['POST'] } },
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: ['limit'] } };
  let cupboardDenied = false;
  const cupboardRequests: Array<{ query: Record<string, string>; status: number; titles: string[] }> = [];
  const cupboardRows = [
    { id: 901, slug: input.selected, title: input.selected + ' pack', description: 'Explicit selected listing fixture',
      listing_kind: 'pack', claim_status: 'unclaimed', harness_link: '' },
    { id: 902, slug: input.neighbor, title: input.neighbor + ' plugin', description: 'Explicit neighbor listing fixture',
      listing_kind: 'plugin', claim_status: 'claimed', harness_link: '' },
    { id: 903, slug: input.selected + '-stale', title: input.selected + ' stale', description: 'Hidden listing control',
      listing_kind: 'pack', claim_status: 'stale', harness_link: '' },
  ];
  const componentEvidence = options.framesRead || options.evalsRead || options.supportRead || options.cupboardRead || options.devRead
    ? mkdtempSync(join(tmpdir(), options.devRead ? 'dev-component-' : options.cupboardRead ? 'cupboard-component-' : options.supportRead ? 'support-component-' : options.evalsRead ? 'evals-component-' : 'frames-component-')) : null;
  if (componentEvidence) writeFileSync(join(componentEvidence, 'browser-inputs.json'), JSON.stringify({
    browserBundleSha256: digest(built.bundle),
    originals: [...built.originals].map(([path, identity]) => ({ path, ...identity })),
  }, null, 2));
  let workflowsFail = false;
  const workflowsTimeline: Array<{ name: string; atMs: number; status: number }> = [];
  const workflowHarness = 'private-calendar-harness';
  const workflowAt = Date.now() + 3_600_000;
  const workflowSubjects = [input.selected, input.neighbor];
  // These are explicit component fixtures, never provider or private API proof.
  const gitCommit = { sha: 'a'.repeat(40), author: 'preflight-author', email: 'preflight@example.invalid',
    ts: 1_700_000_000, parents: [], refs: [], subject: 'preflight selected commit', body: '',
    patch: 'diff --git a/selected.txt b/selected.txt\nindex 1111111..2222222 100644\n--- a/selected.txt\n+++ b/selected.txt\n@@ -1 +1 @@\n-before\n+after\n' };
  const gitLayout = { workspaceId: 'preflight-workspace', layoutName: `adv-git2:${input.selected}`,
    schemaVersion: 1, layoutJson: defaultAdvGitLayout(input.selected), updatedTs: 1, createdTs: 1 };
  const prRows: PrRowData[] = [
    { remote: 'github.com/preflight/selected', number: 101, title: 'preflight-selected-open', author_login: 'fixture-viewer',
      author_github_id: 101, html_url: 'https://example.invalid/pr/101', state: 'open', review_decision: 'none',
      check_conclusion: 'success', trusted: false, reviewerRoleEnabled: false },
    { remote: 'github.com/preflight/selected', number: 102, title: 'preflight-selected-merged', author_login: 'fixture-neighbor',
      author_github_id: 102, html_url: 'https://example.invalid/pr/102', state: 'merged', review_decision: 'approved',
      check_conclusion: 'success', trusted: false, reviewerRoleEnabled: false },
  ];
  const prDetails: PrViewerDetails = {
    pr: { ref: { remote: prRows[0].remote, number: 101 }, state: 'open', title: prRows[0].title, body: null,
      head_ref: 'fixture-head', base_ref: 'staging', head_sha: 'a'.repeat(40), merge_commit_sha: null,
      author: { github_user_id: 101, github_login: 'fixture-viewer' }, reviewers_requested: [], review_decision: 'none',
      checks_state: 'success', mergeable_state: 'unknown', is_draft: false, url: prRows[0].html_url, updated_at: 1 },
    row: prRows[0], files: [{ filename: 'fixture-selected.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '-fixture-before\n+fixture-after' }], commits: [], checks: [], diff: 'fixture-combined-diff',
    diffTruncated: false, targetSha: 'b'.repeat(40), permissions: { review: false, close: false, sendGreen: false },
    standing: false, mergeTest: null, mergeTestStatus: 'not-tested', mergeBlocker: null,
  };
  let prsFail = false;
  let detailsFail = false;
  const prWrites: string[] = [];
  let insightsFail = true;
  let tokensFail = false;
  const overview = (slug: string): InsightsTabProps => ({
    project: { name: `preflight-${slug}-project`, description: 'Explicit component fixture',
      ownerDisplayName: 'fixture-viewer', claimStatus: 'unclaimed', githubUrl: 'https://example.invalid/fixture' },
    activity: { events: [] }, people: { people: [] },
    yourPlace: { queue: { queued: 0, working: 0, shipped_this_week: 0 },
      role: { pr_reviewer_enabled: false, is_provisional_owner: false, is_claimant: false },
      trust: { trusted_authors_count: 0, trusted_by_count: 0 } },
    howItWorks: { harnessName: slug, config: { has_orchestrator: false, pr_reviewer_role_enabled: false,
      auto_review: false, auto_merge: false, merge_method: 'squash', branch_policy: 'main-fast-forward' } },
    spend: { harnessTotalUsdThisWeek: slug === input.selected ? 1.25 : 9,
      estimatedUsdThisWeek: 0, tokensThisWeek: 42, runsThisWeek: 1 },
  });
  const tokens = (slug: string): TokensDashboardSnapshot => ({ windowMs: 604_800_000,
    totals: { tokens: 42, costUsd: slug === input.selected ? 1.25 : 9, estimatedUsd: 0, runs: 1,
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 25, cacheCreationTokens: 5 },
    byModel: [{ key: `preflight-${slug}-model`, tokens: 42, costUsd: 1.25, runs: 1 }],
    byRole: [], byAccount: [], byDay: [], accountAttributionAvailable: false });
  let releaseHydration!: () => void;
  const hydration = new Promise<void>(done => { releaseHydration = done; });
  const savedMap = 'preflight-saved-map';
  const savedShape = 'preflight-saved-shape';
  const savedRow = { harnessSlug: input.selected, phase: 'staging', content: 'preflight-saved-text', updatedAt: 1,
    mindmap: { nodes: [{ id: 'root', type: 'mind', position: { x: 100, y: 200 },
      data: { text: savedMap, kind: 'idea' } }], edges: [] },
    canvas: { elements: [{ id: savedShape, type: 'rectangle', x: 40, y: 40, width: 90, height: 70,
      angle: 0, strokeColor: '#ffffff', backgroundColor: 'transparent', fillStyle: 'hachure',
      strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
      roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null,
      updated: 1, link: null, locked: false }], appState: {}, files: {} } };
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://preflight.invalid');
    const pathname = requestUrl.pathname;
    if (options.devRead && pathname === '/api/workspaces' && request.method === 'GET') {
      reads.push({ name: 'dev.workspaces', args: null });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ workspaces: [input.selected, input.neighbor].map(id => ({ id, name: id })) }));
    } else if (options.createDockRead && pathname === '/api/dock-layouts/adv-create2') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ workspaceId: 'preflight-workspace', userId: '_local', layoutName: 'adv-create2',
        schemaVersion: 1, layoutJson: defaultAdvCreateLayout(), updatedTs: 1, createdTs: 1 }));
    } else if (options.createDockRead && pathname === '/api/admin/plans/get') {
      const slug = requestUrl.searchParams.get('slug');
      reads.push({ name: 'plans.get', args: { slug } });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, slug, title: slug, status: 'draft',
        harness: input.selected, frontmatter: { slug, title: slug, status: 'draft' },
        raw: `---\nslug: ${slug}\nstatus: draft\n---\n\n## Now\n${slug}-body\n`,
        items: [], decisions: [], sectionIndex: [], counts: { items: 0, decisions: 0 },
        contentHash: 'explicit-component-fixture', version: 1 }));
    } else if ((input.conversations || input.createDock) && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      reads.push({ name, args: JSON.parse(requestUrl.searchParams.get('args') ?? '{}') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rows: options.conversationsRead && name === 'conversations.questionsList'
        ? [input.selected, input.neighbor].map(id => ({ id, kind: 'question', state: 'open', scope: 'workspace',
          harness_slug: null, title: id, asker_id: 'preflight-viewer', topics: [], created_ts: '2026-10-12T00:00:00Z' }))
        : options.createDockRead && name === 'dockLayouts.byName'
          ? [{ workspaceId: 'preflight-workspace', userId: '_local', layoutName: 'adv-create2',
            schemaVersion: 1, layoutJson: defaultAdvCreateLayout(), updatedTs: 1, createdTs: 1 }]
        : options.createDockRead && name === 'plans.list'
          ? [input.selected, input.neighbor].map(slug => ({ slug, title: slug, status: 'draft',
            harness: input.selected, archived: false, isLegacy: false, itemCounts: {}, nextAction: slug + '-body' }))
          : [] }));
    } else if (input.harnessSettings && pathname.endsWith('/blueprint-params')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ blueprintId: 'explicit-settings-component-fixture', params: {} }));
    } else if (input.harnessSettings && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      const args = JSON.parse(requestUrl.searchParams.get('args') ?? '{}');
      reads.push({ name, args });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rows: name === 'harnessProjectFiles.byHarness'
        ? [{ harnessSlug: args.harnessSlug, config: '{}' }] : [] }));
    } else if (options.devRead && pathname === '/api/plugins/tools' && request.method === 'GET') {
      reads.push({ name: 'dev.tools', args: null });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tools: [devTool, { ...devTool, name: 'fixture:neighbor', description: 'Unselected tool control' }] }));
    } else if (options.devRead && pathname === '/api/agent-tools/dev/activity' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += String(chunk);
      // POST invokes a read tool. These are explicit HTTP fixtures, never real dispatcher or provider evidence.
      const status = devInvocations.length % 2 === 0 ? 403 : 200;
      devInvocations.push({ query: Object.fromEntries(requestUrl.searchParams), args: JSON.parse(body), status });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 403 ? { error: 'explicit fixture Dev denial' }
        : { entries: [{ marker: input.selected + '-activity' }], workspace: input.selected }));
    } else if (options.devRead && request.method !== 'GET') {
      writes.push({ surface: pathname, body: { method: request.method } });
      response.writeHead(405); response.end('unexpected Dev mutation');
    } else if (options.cupboardRead && request.method !== 'GET') {
      writes.push({ surface: pathname, body: { method: request.method } });
      response.writeHead(405); response.end('unexpected Cupboard mutation');
    } else if (options.cupboardRead && pathname === '/api/cupboard/listings') {
      const query = Object.fromEntries(requestUrl.searchParams);
      const rows = cupboardRows.filter(row => (!query.kind || row.listing_kind === query.kind)
        && (!query.q || row.title.includes(query.q)) && (!query.claim || row.claim_status === query.claim));
      const status = cupboardDenied ? 403 : 200;
      cupboardRequests.push({ query, status, titles: rows.map(row => row.title) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(cupboardDenied ? { error: 'explicit fixture cupboard denial' }
        : { listings: rows, total: rows.length, next_cursor: null, kind_facets: { pack: 2, plugin: 1 } }));
    } else if (options.cupboardRead && pathname === '/api/zero-harness/rest-query') {
      reads.push({ name: requestUrl.searchParams.get('name'), args: JSON.parse(requestUrl.searchParams.get('args') ?? '{}') });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ rows: [] }));
    } else if (options.supportRead && pathname === '/v1/support/chat' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const args = JSON.parse(body);
      const status = supportRequests.length === 0 ? 403 : 200;
      supportRequests.push({ ...args, status });
      response.writeHead(status, { 'content-type': status === 200 ? 'text/event-stream' : 'text/plain' });
      response.end(status === 403 ? 'explicit fixture support denial'
        : 'event: token\ndata: "Fixture support "\n\nevent: token\ndata: "answer"\n\n'
          + 'event: done\ndata: {"costUsd":0.0123,"capExceeded":false}\n\n');
    } else if (options.supportRead && request.method !== 'GET') {
      writes.push({ surface: pathname, body: 'unexpected Support mutation' });
      response.writeHead(405); response.end('unexpected Support mutation');
    } else if (options.evalsRead && request.method !== 'GET') {
      writes.push({ surface: pathname, body: { method: request.method } });
      response.writeHead(405); response.end();
    } else if (options.evalsRead && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      const args = JSON.parse(requestUrl.searchParams.get('args') ?? '{}');
      const denied = name === 'evals.suites' && evalsDenied;
      reads.push({ name, args: { ...args, denied, denialPhase: denied ? evalsDenialPhase : null } });
      const rows = name === 'evals.suites' ? [input.selected, input.neighbor].map(suite => ({
        suite, runId: 'fixture-' + suite, taskCount: 4, passAt1ByArm: { papercusp: 0.5 },
      })) : [];
      response.writeHead(denied ? 403 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(denied ? { error: 'explicit fixture evaluation denial' } : { rows }));
    } else if (options.framesRead && request.method !== 'GET') {
      writes.push({ surface: pathname, body: null });
      response.writeHead(405); response.end();
    } else if (options.framesRead && pathname === '/api/deploy/frames') {
      reads.push({ name: pathname, args: { denied: framesDenied } });
      response.writeHead(framesDenied ? 403 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(framesDenied ? { error: 'explicit fixture roster denial' } : {
        frames: [input.selected, input.neighbor].map(slug => ({ slug,
          frame: { id: 'fixture-' + slug, target: 'fixture' }, desktop: { displays: 1 } })),
      }));
    } else if (options.framesRead && pathname.endsWith('/frame-view')) {
      const slug = decodeURIComponent(pathname.split('/')[3]);
      assert.ok([input.selected, input.neighbor].includes(slug), 'only listed frame streams may open');
      reads.push({ name: pathname, args: { slug } });
      frameStreams.push({ slug, closed: new Promise<void>(done => response.once('close', done)) });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write('event: status\ndata: ' + JSON.stringify({ slug, state: 'polling', displays: [1] }) + '\n\n');
      response.write('event: thumb\ndata: ' + JSON.stringify({ slug, display: 1,
        jpegBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        capturedAtMs: Date.now(), role: 'fixture-' + slug }) + '\n\n');
    } else if (options.framesRead && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      reads.push({ name, args: JSON.parse(requestUrl.searchParams.get('args') ?? '{}') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rows: name === 'desktops.local' ? [{ id: 'fixture-local' }] : [] }));
    } else if (options.workflowsRead && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name') ?? '';
      const denied = workflowsFail && name === 'plans.scheduledOccurrences';
      workflowsTimeline.push({ name, atMs: Date.now(), status: denied ? 403 : 200 });
      const rows = name === 'plans.list' ? workflowSubjects.map(slug => ({ slug, title: slug, status: 'active',
        harness: workflowHarness, triggered: true, scheduled: true, scheduleActive: true, triggerSources: ['schedule'] }))
        : name === 'plans.schedule' ? workflowSubjects.map(slug => ({ templateSlug: slug, title: slug,
          harnessSlug: workflowHarness, scheduledAt: new Date(workflowAt).toISOString(), scheduleActive: true }))
        : name === 'plans.scheduledOccurrences' ? workflowSubjects.map(slug => ({ templateSlug: slug, title: slug,
          harnessSlug: workflowHarness, occurrenceMs: workflowAt, kind: 'one-shot', scheduleActive: true })) : [];
      response.writeHead(denied ? 403 : 200, { 'content-type': 'application/json' });
      const body = JSON.stringify(denied ? { error: 'fixture occurrence denial' } : { rows });
      if (denied && options.workflowsDeniedResponseDelayMs) {
        setTimeout(() => { if (!response.destroyed) response.end(body); }, options.workflowsDeniedResponseDelayMs);
      } else response.end(body);
    } else if (options.gitRead && pathname === '/api/zero-harness/rest-query') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ rows: requestUrl.searchParams.get('name') === 'dockLayouts.byName' ? [gitLayout] : [] }));
    } else if (options.gitRead && pathname.startsWith('/api/dock-layouts/')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(gitLayout));
    } else if (options.gitRead && pathname.startsWith(`/api/harness/${input.selected}/git/`)) {
      // CommitDetail uses the production sibling-loopback origin helper.
      response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify(pathname.endsWith('/log') ? { commits: [gitCommit] }
        : pathname.endsWith('/worktrees') ? { worktrees: [] } : gitCommit));
    } else if ((options.prsRead || options.insightsRead) && request.method !== 'GET') {
      prWrites.push(pathname); response.writeHead(405); response.end();
    } else if (options.insightsRead && pathname.startsWith('/api/harness/') && pathname.endsWith('/insights')) {
      const slug = decodeURIComponent(pathname.split('/')[3]);
      reads.push({ name: 'insights.overview', args: { harness: slug } });
      response.writeHead(insightsFail ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(insightsFail ? { error: 'fixture Insights read unavailable' } : { insights: overview(slug) }));
    } else if (options.insightsRead && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      const args = JSON.parse(requestUrl.searchParams.get('args') ?? '{}');
      reads.push({ name, args });
      response.writeHead(tokensFail && name === 'insights.tokens' ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(tokensFail && name === 'insights.tokens' ? { error: 'fixture token read unavailable' }
        : { rows: name === 'insights.tokens' ? [tokens(args.harness)] : [] }));
    } else if (options.prsRead && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      const args = JSON.parse(requestUrl.searchParams.get('args') ?? '{}');
      reads.push({ name, args });
      if ((name === 'harnessPrs.byHarness' && prsFail) || (name === 'harnessPrs.detail' && detailsFail)) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture PR read unavailable' })); return;
      }
      const rows = args.harnessSlug !== input.selected ? [] : name === 'harnessPrs.byHarness' ? [{ prs: prRows }]
        : name === 'harnessPrs.detail' && args.number === 101 ? [prDetails]
        : name === 'prReviewerSettings.byHarness' ? [{ viewer: { github_user_id: 101 }, trustList: [],
          settings: { pr_reviewer_role_enabled: false, auto_review: false, auto_merge: false }, autoModeEditable: false }] : [];
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ rows }));
    } else if (pathname.startsWith('/vditor/')) {
      const asset = resolve(vditorAssets, decodeURIComponent(pathname.slice('/vditor/'.length)));
      if (!asset.startsWith(vditorAssets + sep) || !existsSync(asset) || !statSync(asset).isFile()) {
        response.writeHead(404); response.end(); return;
      }
      response.writeHead(200, { 'content-type': asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
      response.end(readFileSync(asset));
    } else if (options.brainstormHydration && pathname === '/api/zero-harness/rest-query') {
      const name = requestUrl.searchParams.get('name');
      const args = JSON.parse(requestUrl.searchParams.get('args') ?? '{}');
      reads.push({ name, args });
      void hydration.then(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ rows: name === 'harnessBrainstorm.byHarness'
          && args.harnessSlug === input.selected ? [savedRow] : [] }));
      });
    } else if (options.brainstormHydration && request.method === 'PUT'
      && pathname.startsWith(`/api/harness/${input.selected}/brainstorm`)) {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const surface = pathname.split('/').at(-1)!;
        const parsed = JSON.parse(body);
        writes.push({ surface, body: parsed });
        if (surface === 'brainstorm-mindmap') savedRow.mindmap = parsed.tree;
        if (surface === 'brainstorm-canvas') savedRow.canvas = parsed.scene;
        if (surface === 'brainstorm') savedRow.content = parsed.content;
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
      });
    } else if (input.stats && pathname.endsWith('/git/stats')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stats: null, notAGitRepo: true }));
    } else if (input.stats && pathname === '/api/zero-harness/rest-query') {
      const rows = requestUrl.searchParams.get('name') === 'harnessProjects.lite'
        ? [input.selected, input.neighbor].map(slug => ({ slug, path: '/preflight/' + slug, hasState: true, hasSpec: false })) : [];
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ rows }));
    } else if (input.harnesses && pathname === '/api/zero-harness/rest-query') {
      const work = input.harnesses;
      const rows = requestUrl.searchParams.get('name') === 'harnessProjects.lite' ? [
        { slug: work.hive, path: '/preflight/hive', harness_kind: 'hive', hasState: true, hasSpec: false },
        ...[work.selected, work.neighbor].map(slug => ({ slug, path: '/preflight/' + slug,
          hive_slug: work.hive, hasState: true, hasSpec: false })),
      ] : [];
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ rows }));
    } else if (pathname === '/favicon.ico') {
      response.writeHead(204); response.end();
    } else if ((options.brainstormHydration || options.workflowsRead || input.git || input.dev || input.conversations || input.createDock) && pathname === '/docs-preflight.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end(readFileSync(join(built.portal, 'app/tokens.css'), 'utf8') + '\n'
        + readFileSync(join(built.portal, 'app/globals.css'), 'utf8') + '\n'
        + readFileSync(resolve(import.meta.dirname, '../../../apps/operator/app/harness/harness.css'), 'utf8')
        + '\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex:1}\n' + built.css);
    } else if (pathname === '/docs-preflight.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(built.bundle);
    } else if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end((options.brainstormHydration || options.workflowsRead || input.git || input.dev || input.conversations || input.createDock ? '<link rel="stylesheet" href="/docs-preflight.css">' : '')
        + '<div id="root"></div><script' + (input.frames ? ' type="module"' : '') + ' src="/docs-preflight.js"></script>');
    } else { response.writeHead(404); response.end(); }
  });
  const errors: string[] = [];
  const failedRequests: string[] = [];
  const gitDetailReads: Array<{ url: string; status: number; allowOrigin: string | undefined }> = [];
  let page: Page | undefined;
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', done);
    });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    if (options.supportRead || options.cupboardRead || options.devRead) {
      await page.route('**/*', route => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === `http://127.0.0.1:${address.port}`) return route.continue();
        outwardRequests.push(requestUrl.href);
        return route.abort('blockedbyclient');
      });
      await page.addInitScript(() => {
        (window as any).__supportOpenCount = 0;
        window.addEventListener('papercusp:open-support', () => (window as any).__supportOpenCount++);
      });
    }
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    // This browser-only preflight has no API. Capture the renderer's handled
    // failures, rather than treating background flag-bootstrap requests as
    // module failures. The private workflow exercises its real API separately.
    page.on('console', message => {
      const gitTransportError = options.gitRead && (/cross-origin|cors|access-control-allow-origin/i.test(message.text())
        || message.location().url.includes('/git/'));
      if (message.type() === 'error' && (message.text().startsWith('[MarkdownPreview]') || gitTransportError)) errors.push(message.text());
    });
    page.on('requestfailed', request => {
      if (options.gitRead) failedRequests.push(`${request.failure()?.errorText} ${request.url()}`);
    });
    page.on('response', response => {
      if (response.status() >= 400) failedRequests.push(`HTTP ${response.status()} ${response.url()}`);
      if (options.gitRead && new URL(response.url()).pathname.includes('/git/show/')) {
        gitDetailReads.push({ url: response.url(), status: response.status(),
          allowOrigin: response.headers()['access-control-allow-origin'] });
      }
    });
    // History-backed query state needs a real origin; about:blank cannot run
    // replaceState even when the component itself initialized correctly.
    const url = new URL(`http://127.0.0.1:${address.port}/${input.harnesses
      ? '?scope=all&app=work&q=preflight-search&ws=preflight-workspace' : ''}`);
    if (options.brainstormHydration || options.prsRead || options.insightsRead) url.searchParams.set('slug', input.selected);
    if (input.harnessSettings) {
      url.searchParams.set('app', 'settings'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('nextPot', input.neighbor); url.searchParams.set('ws', 'preflight-workspace');
    }
    if (input.conversations || input.createDock) {
      url.searchParams.set('app', input.conversations ? 'conversations' : 'create');
      url.searchParams.set('ws', 'preflight-workspace');
      if (options.createDockRead) {
        url.searchParams.set('slug', input.selected); url.searchParams.set('scope', 'all');
        url.searchParams.set('view', 'plans'); url.searchParams.set('plan', input.selected);
      }
    }
    if (input.learning) { url.searchParams.set('lview', 'learnings'); url.searchParams.set('scope', 'all'); }
    if (input.stats) { url.searchParams.set('app', 'stats'); url.searchParams.set('slug', input.selected); }
    if (options.gitRead) {
      url.searchParams.set('app', 'git'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('commit', gitCommit.sha); url.searchParams.set('ws', 'preflight-workspace');
    }
    if (options.prsRead || options.insightsRead) {
      url.searchParams.set('app', options.insightsRead ? 'insights' : 'prs'); url.searchParams.set('q', 'preflight-search');
      url.searchParams.set('ws', 'preflight-workspace');
    }
    if (options.framesRead) {
      url.searchParams.set('app', 'frames'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('q', 'preflight-search'); url.searchParams.set('ws', 'preflight-workspace');
    }
    if (options.evalsRead) {
      url.searchParams.set('app', 'evals'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('q', 'preflight-search'); url.searchParams.set('ws', 'preflight-workspace');
      url.searchParams.set('evalSuite', input.selected); url.searchParams.set('evalRun', 'fixture-drill-in');
      url.searchParams.set('evalView', 'external');
    }
    if (options.supportRead) {
      url.searchParams.set('app', 'support'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('q', 'preflight-search'); url.searchParams.set('ws', 'preflight-workspace');
    }
    if (options.cupboardRead) {
      url.searchParams.set('app', 'cupboard'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('ws', 'preflight-workspace');
    }
    if (options.devRead) {
      url.searchParams.set('app', 'dev'); url.searchParams.set('slug', input.selected);
      url.searchParams.set('ws', 'preflight-workspace'); url.searchParams.set('tab', 'api');
      url.searchParams.set('devWs', input.selected); url.searchParams.set('rail', 'closed');
    }
    await page.goto(url.href);
    if (options.gitRead) {
      await page.waitForFunction(() => document.querySelector('.pc-adv-git')
        || document.body.textContent?.includes('Something went wrong!'));
      assert.equal((await page.locator('body').innerText()).includes('must be used within'), false,
        'Selected Git commit must retain the production root providers: ' + await page.locator('body').innerText());
    }
    try { await (input.conversations ? page.getByRole('region', { name: 'Conversation list', exact: true })
      : input.createDock ? page.locator('.pc-adv-create') : input.dev ? page.locator('.pc-dev-api') : input.cupboard ? page.getByRole('button', { name: 'Refresh', exact: true })
      : input.support ? page.getByRole('heading', { name: 'Support', exact: true })
      : input.evals ? page.getByRole('heading', { name: 'Evaluation', exact: true })
      : input.frames ? page.locator('.pc-frames') : input.git ? page.locator('.pc-adv-git')
      : input.stats ? page.getByRole('heading', { name: 'Git statistics', exact: true })
      : input.workflows ? page.getByTestId('workflows-control-deck')
      : input.learning ? page.getByRole('region', { name: 'Retained ledger', exact: true })
      : input.calendar ? page.locator('.pc-sched-cal .fc') : input.projectHistory ? page.locator('.pc-project-history')
      : input.harnesses ? page.getByTestId('pot-workspace-cards')
      : page.getByRole('region', { name: input.harnessSettings ? 'ADV Settings workspace' : input.insights ? 'ADV Insights workspace' : input.prs ? 'ADV PRs workspace' : input.brainstorm ? 'ADV Brainstorm workspace' : 'ADV Docs workspace' })).waitFor({ timeout: 15_000 }); }
    catch (error) { throw new Error([...errors, ...failedRequests, String(error)].join('\n')); }
    if (input.conversations) {
      if (options.conversationsRead) {
        // Exercise the same accessible control as private acceptance against
        // the real populated aggregate before allocating its database/API.
        const rail = page.getByRole('region', { name: 'Conversation list', exact: true });
        const search = conversationSearchControl(page);
        await search.waitFor();
        await rail.getByRole('button', { name: 'Open ' + input.selected, exact: true }).waitFor();
        await rail.getByRole('button', { name: 'Open ' + input.neighbor, exact: true }).waitFor();
        await search.fill(input.selected);
        await page.waitForURL(value => value.searchParams.get('cq') === input.selected);
        await rail.getByRole('button', { name: 'Open ' + input.neighbor, exact: true }).waitFor({ state: 'detached' });
        await rail.getByRole('button', { name: 'Open ' + input.selected, exact: true }).waitFor();
        await search.fill('');
        await rail.getByRole('button', { name: 'Open ' + input.neighbor, exact: true }).waitFor();
      } else {
        // Empty aggregates omit search; populated controls are checked above.
        await page.getByText('No conversations', { exact: true }).waitFor();
      }
      for (const name of ['conversations.questionsList', 'conversations.deliberationList',
        'conversations.agentChatList', 'conversations.agentMessageList']) {
        assert.ok(reads.some(read => read.name === name), 'Conversations must load each original aggregate source: ' + name);
      }
    } else if (input.createDock) {
      await page.getByRole('navigation', { name: 'Create view', exact: true }).waitFor();
      assert.equal(await page.locator('.pc-adv-create__dock').count(), 1);
      if (options.createDockRead) {
        const dock = page.locator('.pc-adv-create__dock');
        const main = dock.locator('.pc-plans__main');
        await createDockPlanBody(main, input.selected + '-body').waitFor();
        await dock.locator('.pc-plans__list').getByText(input.neighbor, { exact: true }).first().click();
        await createDockPlanBody(main, input.neighbor + '-body').waitFor();
        await page.waitForURL(value => value.searchParams.get('plan') === input.neighbor);
        assert.ok(reads.some(read => read.name === 'plans.list'));
        assert.ok(reads.some(read => read.name === 'plans.get' && read.args.slug === input.neighbor));
      }
    } else if (input.harnessSettings) {
      await page.getByRole('heading', { name: 'Settings — ' + input.selected, exact: true }).waitFor();
      await page.getByText(/Schema-driven per-harness settings/).waitFor();
      await page.getByTestId('settings-switch-pot').click();
      await page.getByRole('heading', { name: 'Settings — ' + input.neighbor, exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('slug'), input.neighbor);
      assert.equal(await page.getByRole('heading', { name: 'Settings — ' + input.selected, exact: true }).count(), 0);
      for (const slug of [input.selected, input.neighbor]) assert.ok(reads.some(read =>
        read.name === 'harnessProjectFiles.byHarness' && read.args.harnessSlug === slug),
      'Settings mount requires a config read for each selected scope');
    }
    if (options.devRead) {
      const filter = () => page!.getByPlaceholder('Filter tools…', { exact: true });
      const invoke = () => page!.getByRole('button', { name: 'Invoke', exact: true });
      const limit = () => page!.locator('.pc-dev-form-row').filter({ hasText: 'limit' }).locator('input');
      const assertScope = () => {
        const params = new URL(page!.url()).searchParams;
        for (const [key, value] of Object.entries({ app: 'dev', slug: input.selected, ws: 'preflight-workspace',
          tab: 'api', devWs: input.selected, rail: 'closed', q: 'dev:activity', tool: 'dev:activity',
          ctxH: input.selected, ctxRole: 'operator', ctxRun: 'fixture-dev-run', ctxSpawn: 'fixture-dev-spawn' })) {
          assert.equal(params.get(key), value, `Dev URL must preserve ${key}`);
        }
      };
      assert.equal(await page.getByRole('checkbox', { name: input.selected, exact: true }).isChecked(), true);
      assert.equal(await page.getByRole('checkbox', { name: input.neighbor, exact: true }).isChecked(), false);
      assert.equal(await page.locator('.pc-dev-right').count(), 0);
      await filter().fill('dev:activity');
      await page.locator('.pc-dev-api-tool').filter({ hasText: 'dev:activity' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'dev:activity', exact: true }).waitFor();
      assert.equal(await page.locator('.pc-dev-api-tool').count(), 1);
      assert.equal(await page.getByLabel('workspace', { exact: true }).inputValue(), input.selected);
      await page.getByLabel('harness', { exact: true }).fill(input.selected);
      await page.getByRole('combobox', { name: 'role', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('option', { name: 'operator', exact: true }).click();
      await page.getByLabel('run', { exact: true }).fill('fixture-dev-run');
      await page.getByLabel('spawn', { exact: true }).fill('fixture-dev-spawn');
      await limit().fill('7');
      await invoke().focus(); await page.keyboard.press('Enter');
      await page.getByText('HTTP 403', { exact: true }).waitFor();
      assert.match(await page.locator('.pc-dev-api-response').innerText(), /explicit fixture Dev denial/);
      await invoke().focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(marker => document.querySelector('.pc-dev-api-response')?.textContent?.includes(marker), input.selected + '-activity');
      assert.equal(await page.getByText('HTTP 403', { exact: true }).count(), 0);
      assertScope();
      await page.reload();
      await page.getByRole('heading', { name: 'dev:activity', exact: true }).waitFor();
      assertScope();
      assert.equal(await filter().inputValue(), 'dev:activity');
      assert.equal(await page.locator('.pc-dev-api-response').count(), 0, 'reload must not pretend a prior invocation ran again');
      await limit().fill('7');
      await invoke().focus(); await page.keyboard.press('Enter');
      await page.getByText('HTTP 403', { exact: true }).waitFor();
      await invoke().focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(marker => document.querySelector('.pc-dev-api-response')?.textContent?.includes(marker), input.selected + '-activity');
      assert.equal(await page.getByText('HTTP 403', { exact: true }).count(), 0);
      assert.equal(devInvocations.length, 4);
      assert.deepEqual(devInvocations.map(r => r.status), [403, 200, 403, 200]);
      for (const invocation of devInvocations) {
        assert.deepEqual(invocation.query, { workspace: input.selected, role: 'operator', run: 'fixture-dev-run',
          spawn: 'fixture-dev-spawn', harness: input.selected });
        assert.deepEqual(invocation.args, { limit: 7 });
      }
      assert.deepEqual(writes, []); assert.deepEqual(outwardRequests, []); assert.deepEqual(errors, []);
      await page.screenshot({ path: join(componentEvidence!, 'verified.png'), fullPage: true });
      writeFileSync(join(componentEvidence!, 'receipt.json'), JSON.stringify({ reads, writes, devInvocations, outwardRequests,
        errors, providerUsed: false, url: page.url(), scope: 'Actual Dev component with explicit local HTTP fixture; no private API, provider or hosted proof' }, null, 2));
    }
    if (options.cupboardRead) {
      const selectedTitle = input.selected + ' pack';
      const assertScope = () => {
        const params = new URL(page!.url()).searchParams;
        assert.equal(params.get('app'), 'cupboard'); assert.equal(params.get('slug'), input.selected);
        assert.equal(params.get('ws'), 'preflight-workspace');
        assert.equal(params.get('q'), input.selected); assert.equal(params.get('kind'), 'pack');
        assert.equal(params.get('claim'), 'unclaimed');
      };
      await page.getByText(selectedTitle, { exact: true }).waitFor();
      await page.getByText(input.neighbor + ' plugin', { exact: true }).waitFor();
      assert.equal(await page.getByText(input.selected + ' stale', { exact: true }).count(), 0);
      const packs = page.getByRole('button', { name: /^Packs\b/ });
      await packs.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('kind') === 'pack');
      await page.getByRole('textbox').fill(input.selected);
      const unclaimed = page.getByRole('button', { name: 'unclaimed', exact: true });
      await unclaimed.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(selected => new URL(location.href).searchParams.get('q') === selected
        && new URL(location.href).searchParams.get('claim') === 'unclaimed', input.selected);
      await page.getByText(selectedTitle, { exact: true }).waitFor();
      assert.equal(await page.getByText(input.neighbor + ' plugin', { exact: true }).count(), 0);
      assertScope();
      await page.reload(); await page.getByText(selectedTitle, { exact: true }).waitFor(); assertScope();
      assert.ok(cupboardRequests.some(r => r.status === 200 && r.query.kind === 'pack'
        && r.query.claim === 'unclaimed' && r.query.q === input.selected && r.query.limit === '100'),
      'Cupboard filter and reload must reach the listing HTTP contract');
      cupboardDenied = true;
      const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
      await refresh.focus(); await page.keyboard.press('Enter');
      await page.getByTestId('cupboard-error-state').getByText("Couldn't load listings (HTTP 403).", { exact: true }).waitFor();
      assert.equal(await page.getByText(selectedTitle, { exact: true }).count(), 0, 'Denied refresh must hide stale cards');
      assertScope();
      await page.reload(); await page.getByTestId('cupboard-error-state').waitFor(); assertScope();
      cupboardDenied = false;
      const retry = page.getByTestId('cupboard-error-retry');
      await retry.focus(); await page.keyboard.press('Enter');
      await page.getByText(selectedTitle, { exact: true }).waitFor();
      assert.equal(await page.getByTestId('cupboard-error-state').count(), 0);
      assertScope();
      assert.ok(cupboardRequests.filter(r => r.status === 403).length >= 2, 'Warm and cold denials must be observed');
      assert.deepEqual(writes, []); assert.deepEqual(outwardRequests, []); assert.deepEqual(errors, []);
      assert.equal(reads.some(r => r.name === 'cupboard.identityOutcomeCosts'), false,
        'Non-identity listing workflow must not fabricate identity evidence');
      writeFileSync(join(componentEvidence!, 'receipt.json'), JSON.stringify({ reads, writes, cupboardRequests,
        outwardRequests, errors, providerUsed: false }, null, 2));
    }
    if (options.supportRead) {
      const assertShell = () => {
        const params = new URL(page!.url()).searchParams;
        assert.equal(params.get('app'), 'support'); assert.equal(params.get('slug'), input.selected);
        assert.equal(params.get('q'), 'preflight-search'); assert.equal(params.get('ws'), 'preflight-workspace');
      };
      const faq = page.locator('.pc-support-faq-summary').first();
      assert.equal(await faq.getAttribute('aria-expanded'), 'false');
      await faq.focus(); await page.keyboard.press('Enter');
      await page.locator('.pc-support-faq-answer').getByText('Install one of the supported agent CLIs globally:', { exact: true }).waitFor();
      assert.equal(await faq.getAttribute('aria-expanded'), 'true');
      await faq.focus(); await page.keyboard.press('Space');
      assert.equal(await faq.getAttribute('aria-expanded'), 'false');
      const ask = page.getByRole('button', { name: 'Ask', exact: true });
      assert.equal(await ask.isDisabled(), true);
      const inputBox = page.getByPlaceholder('How do I set up my first harness?', { exact: true });
      await inputBox.fill('fixture denied question'); await inputBox.press('Enter');
      await page.getByText('❌ explicit fixture support denial', { exact: true }).waitFor();
      await inputBox.fill('fixture recovered question'); await inputBox.press('Enter');
      await page.getByText('Fixture support answer', { exact: true }).waitFor();
      await page.getByText('$0.0123 / $0.50', { exact: true }).waitFor();
      assert.equal(await ask.isDisabled(), true, 'successful send clears input and leaves no invented retry');
      const human = page.getByRole('button', { name: 'Talk to a human via Support', exact: true });
      await human.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window as any).__supportOpenCount === 1);
      assert.equal(supportRequests.length, 2, 'human handoff with empty input must not submit a provider request');
      assert.equal(supportRequests[0].sessionId, supportRequests[1].sessionId);
      assert.match(supportRequests[0].sessionId, /^s_/);
      assert.deepEqual(supportRequests.map(r => [r.message, r.surface, r.status]), [
        ['fixture denied question', 'operator', 403], ['fixture recovered question', 'operator', 200]]);
      assertShell();
      await page.reload();
      await page.getByRole('heading', { name: 'Support', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Ask', exact: true }).isDisabled(), true);
      assert.equal(await page.getByText('Fixture support answer', { exact: true }).count(), 0);
      assert.equal(await faq.getAttribute('aria-expanded'), 'false');
      assertShell();
      assert.deepEqual(writes, []); assert.deepEqual(outwardRequests, []); assert.deepEqual(errors, []);
      writeFileSync(join(componentEvidence!, 'receipt.json'), JSON.stringify({ reads, writes, supportRequests,
        outwardRequests, errors, providerUsed: false }, null, 2));
    }
    if (options.evalsRead) {
      const scoreboard = (suite: string) => page!.getByLabel(`${suite} — pass@1 by arm`, { exact: true });
      await scoreboard(input.selected).waitFor();
      await page.getByRole('combobox', { name: 'Benchmark suite', exact: true }).click();
      await page.getByRole('option', { name: `${input.neighbor} · 4 tasks`, exact: true }).click();
      const assertQuery = async () => {
        await page!.waitForURL(url => url.searchParams.get('evalSuite') === input.neighbor
          && url.searchParams.get('evalRun') === null);
        const params = new URL(page!.url()).searchParams;
        assert.equal(params.get('app'), 'evals'); assert.equal(params.get('slug'), input.selected);
        assert.equal(params.get('q'), 'preflight-search'); assert.equal(params.get('ws'), 'preflight-workspace');
        assert.equal(params.get('evalView'), 'external');
      };
      await scoreboard(input.neighbor).waitFor(); await assertQuery();
      await page.reload(); await scoreboard(input.neighbor).waitFor(); await assertQuery();
      const reload = () => page!.getByRole('button', { name: 'Reload the evaluation data', exact: true });
      const denied = async () => {
        await page!.getByRole('alert').filter({ hasText: /Could not load benchmark suites:.*HTTP 403/ }).waitFor();
        assert.equal(await page!.getByText('No benchmark runs yet', { exact: true }).count(), 0);
        assert.equal(await page!.locator('.pc-evals__scoreboard').count(), 0, 'denied suite read withholds stale scores');
        await assertQuery();
      };
      evalsDenied = true; evalsDenialPhase = 'warm';
      await reload().focus(); await page.keyboard.press('Enter'); await denied();
      evalsDenied = false; evalsDenialPhase = null;
      await reload().focus(); await page.keyboard.press('Enter');
      await scoreboard(input.neighbor).waitFor(); await assertQuery();
      evalsDenied = true; evalsDenialPhase = 'cold';
      await page.reload(); await denied();
      evalsDenied = false; evalsDenialPhase = null;
      await reload().focus(); await page.keyboard.press('Enter');
      await scoreboard(input.neighbor).waitFor(); await assertQuery();
      assert.deepEqual(writes, [], 'Evaluation reads must not launch, grade, export or delete runs');
      assert.ok(reads.some(read => read.name === 'evals.report' && read.args.runId === 'fixture-drill-in'));
      assert.ok(reads.some(read => read.name === 'evals.report' && read.args.runId === 'fixture-' + input.neighbor));
      for (const phase of ['warm', 'cold']) assert.ok(reads.some(read => read.name === 'evals.suites'
        && read.args.denied && read.args.denialPhase === phase), `actual ${phase} denial required`);
      if (componentEvidence) writeFileSync(join(componentEvidence, 'receipt.json'), JSON.stringify({
        reads, writes, providerUsed: false }, null, 2));
    }
    if (options.framesRead) {
      const tile = (slug: string) => page!.getByRole('button', { name: `${slug} :1 — fixture-${slug}`, exact: true });
      await tile(input.selected).waitFor(); await tile(input.neighbor).waitFor();
      await page.getByRole('link', { name: '1 agent desktop on this computer →', exact: true }).waitFor();
      const assertQuery = async (selection: string | null) => {
        // Nuqs emits component state before its throttled history update.
        // A detached panel proves rendering completed, not that the URL did.
        await page!.waitForURL(url => url.searchParams.get('frame') === selection
          && url.searchParams.get('live') === null && url.searchParams.get('drive') === null);
        const params = new URL(page!.url()).searchParams;
        assert.equal(params.get('app'), 'frames'); assert.equal(params.get('slug'), input.selected);
        assert.equal(params.get('q'), 'preflight-search'); assert.equal(params.get('ws'), 'preflight-workspace');
        assert.equal(params.get('frame'), selection); assert.equal(params.get('live'), null); assert.equal(params.get('drive'), null);
      };
      await tile(input.selected).focus(); await page.keyboard.press('Enter');
      await page.getByRole('img', { name: `${input.selected} display :1 (enlarged)`, exact: true }).waitFor();
      await assertQuery(input.selected + ':1');
      await page.reload();
      await page.getByRole('img', { name: `${input.selected} display :1 (enlarged)`, exact: true }).waitFor();
      await assertQuery(input.selected + ':1');
      framesDenied = true;
      await page.reload();
      await page.locator('.pc-frames__state[data-error="true"]').filter({ hasText: 'HTTP 403' }).waitFor();
      assert.equal(await page.locator('.pc-frames__tile').count(), 0, 'denied roster must not invent thumbnails');
      await assertQuery(input.selected + ':1');
      const streamCountAfterDenial = frameStreams.length;
      framesDenied = false;
      await page.reload();
      await tile(input.selected).waitFor(); await tile(input.neighbor).waitFor();
      assert.equal(frameStreams.length, streamCountAfterDenial + 2, 'recovery opens one actual SSE per listed frame');
      await tile(input.neighbor).focus(); await page.keyboard.press('Space');
      await page.getByRole('img', { name: `${input.neighbor} display :1 (enlarged)`, exact: true }).waitFor();
      await assertQuery(input.neighbor + ':1');
      await page.getByRole('button', { name: 'Close live view', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('region', { name: 'Frame live view', exact: true }).waitFor({ state: 'detached' });
      await assertQuery(null);
      await page.getByRole('button', { name: 'Close Frames', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.locator('.pc-frames').waitFor({ state: 'detached' });
      await Promise.all(frameStreams.map(stream => stream.closed));
      // Retain observed traffic even if a population assertion below fails.
      if (componentEvidence) writeFileSync(join(componentEvidence, 'receipt.json'), JSON.stringify({ reads, writes,
        streamCount: frameStreams.length, streamsClosed: true, providerUsed: false }, null, 2));
      assert.deepEqual(writes, [], 'stills selection must not mint VNC sessions, join voice or change the server');
      assert.equal(reads.filter(read => read.name === '/api/deploy/frames').length, 4);
      assert.equal(frameStreams.length, 6, 'denied roster opens no streams; each accepted mount opens exactly two');
      assert.deepEqual(new Set(frameStreams.map(stream => stream.slug)), new Set([input.selected, input.neighbor]));
    }
    if (options.insightsRead) {
      await page.getByRole('alert').filter({ hasText: 'Could not load insights: HTTP 503' }).waitFor();
      insightsFail = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).focus(); await page.keyboard.press('Enter');
      const selectedProject = page.getByTestId('insights-overview').getByText(overview(input.selected).project.name, { exact: true });
      await selectedProject.waitFor();
      const tabs = page.getByRole('tablist', { name: 'Insights view' });
      await tabs.getByRole('tab', { name: 'Tokens', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByTestId('tokens-stat-cost').getByText('$1.3', { exact: true }).waitFor();
      await page.getByText(`preflight-${input.selected}-model`, { exact: true }).waitFor();
      const assertQuery = (slug: string) => {
        const params = new URL(page!.url()).searchParams;
        assert.equal(params.get('app'), 'insights'); assert.equal(params.get('slug'), slug);
        assert.equal(params.get('q'), 'preflight-search'); assert.equal(params.get('ws'), 'preflight-workspace');
        assert.equal(params.get('insightView'), 'tokens');
      };
      assertQuery(input.selected); await page.reload();
      await page.getByTestId('tokens-stat-cost').getByText('$1.3', { exact: true }).waitFor();
      assertQuery(input.selected);
      tokensFail = true;
      await page.getByRole('button', { name: 'Reload token spend' }).focus(); await page.keyboard.press('Enter');
      await page.getByText(/Token spend unavailable:/).waitFor();
      tokensFail = false; await page.getByRole('button', { name: 'Reload token spend' }).click();
      await page.getByTestId('tokens-stat-cost').getByText('$1.3', { exact: true }).waitFor();
      await tabs.getByRole('tab', { name: 'Overview', exact: true }).click(); await selectedProject.waitFor();
      insightsFail = true;
      await page.getByRole('button', { name: 'Close Insights', exact: true }).click();
      await page.getByRole('button', { name: 'Open Insights', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not refresh insights' }).waitFor();
      await selectedProject.waitFor();
      insightsFail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      const neighborUrl = new URL(url); neighborUrl.searchParams.set('slug', input.neighbor);
      neighborUrl.searchParams.set('insightView', 'tokens');
      await page.goto(neighborUrl.href);
      await page.getByTestId('tokens-stat-cost').getByText('$9.0', { exact: true }).waitFor();
      assertQuery(input.neighbor);
      assert.ok(reads.some(r => r.name === 'insights.tokens' && r.args.harness === input.selected));
      assert.ok(reads.some(r => r.name === 'insights.tokens' && r.args.harness === input.neighbor));
      assert.ok(reads.filter(r => ['insights.overview', 'insights.tokens'].includes(r.name ?? ''))
        .every(r => [input.selected, input.neighbor].includes(r.args.harness)), 'Insights reads must use the current pot');
      assert.deepEqual(prWrites, [], 'Insights journey must send no writes');
    }
    if (options.prsRead) {
      await page.getByText(prRows[0].title, { exact: true }).waitFor();
      await page.getByText(prRows[1].title, { exact: true }).waitFor();
      const filters = page.getByRole('tablist', { name: 'PR filters' });
      await filters.getByRole('tab', { name: 'merged', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('prs_filter') === 'merged');
      await page.getByText(prRows[0].title, { exact: true }).waitFor({ state: 'hidden' });
      await filters.getByRole('tab', { name: 'all', exact: true }).click();
      const expand = page.getByRole('button', { name: 'Expand details for PR #101' });
      await expand.focus(); await page.keyboard.press('Enter');
      const details = page.getByRole('region', { name: 'PR #101 details' });
      await details.getByLabel('PR diff', { exact: true }).getByText('fixture-combined-diff', { exact: true }).waitFor();
      const assertQuery = () => {
        const params = new URL(page!.url()).searchParams;
        assert.equal(params.get('app'), 'prs'); assert.equal(params.get('slug'), input.selected);
        assert.equal(params.get('q'), 'preflight-search'); assert.equal(params.get('ws'), 'preflight-workspace');
        assert.equal(params.get('prs_selected'), '101'); assert.equal(params.get('prs_member'), input.selected);
        assert.equal(params.get('prs_report'), 'true');
      };
      assertQuery(); await page.reload(); await details.waitFor(); assertQuery();
      detailsFail = true; await details.getByRole('button', { name: 'Refresh details' }).click();
      await page.getByRole('alert').filter({ hasText: 'Could not load PR details' }).waitFor();
      detailsFail = false; await page.getByRole('button', { name: 'Retry details' }).click(); await details.waitFor();
      prsFail = true; await page.getByRole('button', { name: 'Refresh PRs' }).click();
      await page.locator('.pc-adv-prs__msg--err').waitFor();
      prsFail = false; await page.getByRole('button', { name: 'Refresh PRs' }).click();
      await page.getByText(prRows[0].title, { exact: true }).waitFor();
      assert.ok(reads.some(r => r.name === 'harnessPrs.detail' && r.args.number === 101));
      assert.ok(reads.filter(r => ['harnessPrs.byHarness', 'harnessPrs.detail', 'prReviewerSettings.byHarness'].includes(r.name ?? ''))
        .every(r => r.args.harnessSlug === input.selected), 'PR query subjects must remain the selected harness');
      assert.deepEqual(prWrites, [], 'read-only journey must send no review, merge or settings writes');
      assertQuery();
    }
    if (options.brainstormHydration) {
      // Real SyncProvider, delayed fixture response: pending [] must never
      // become a writable default. This catches the production adapter shape
      // cheaply, before allocating the private API/PG workflow.
      await page.getByText('loading mindmap…', { exact: true }).waitFor({ state: 'attached' });
      await page.getByText('loading canvas…', { exact: true }).waitFor({ state: 'attached' });
      await page.waitForTimeout(1_400); // longer than both actual save debounces
      assert.equal(writes.length, 0, 'no editor may persist before the selected Sync row arrives');
      assert.equal(await page.locator('.excalidraw').count(), 0, 'pending canvas must not mount writable');
      const mapWrite = retainPortalResponse(page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.endsWith('/brainstorm-mindmap')));
      const canvasWrite = retainPortalResponse(page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.endsWith('/brainstorm-canvas')));
      releaseHydration();
      await page.locator('.rf-mind-label').getByText(savedMap, { exact: true }).waitFor({ state: 'attached' });
      await page.locator('.excalidraw').waitFor({ state: 'attached' });
      await Promise.all([mapWrite, canvasWrite]);
      assert.ok(reads.some(read => read.name === 'harnessBrainstorm.byHarness' && read.args.harnessSlug === input.selected));
      for (const write of writes) {
        if (write.surface === 'brainstorm-mindmap') assert.equal(write.body.tree.nodes[0].data.text, savedMap);
        if (write.surface === 'brainstorm-canvas') assert.ok(write.body.scene.elements.some((element: { id: string }) => element.id === savedShape),
          'first writable canvas must retain the saved scene');
      }
      // Match the PG journey's observed initial-save barrier. Normal editor
      // mount measurements must settle before strict field-isolation checks.
      const hydrated = JSON.parse(JSON.stringify(savedRow));
      const textWrite = retainPortalResponse(page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.endsWith('/brainstorm')));
      await page.locator('.h-brainstorm-write [contenteditable="true"]').first().fill('preflight-edited-text');
      assert.equal((await textWrite).status(), 200);
      assert.ok(savedRow.content.includes('preflight-edited-text'));
      assert.deepEqual(savedRow.mindmap, hydrated.mindmap, 'settled text save must preserve the saved map');
      assert.deepEqual(savedRow.canvas, hydrated.canvas, 'settled text save must preserve the saved canvas');
      const mapTab = page.getByRole('tab', { name: 'map', exact: true });
      await mapTab.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('brainstormTab') === 'map');
      const renamedMap = 'preflight-edited-map';
      const editedMapWrite = retainPortalResponse(page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.endsWith('/brainstorm-mindmap')
        && (response.request().postData() ?? '').includes(renamedMap)));
      await page.locator('.rf-mind-node').filter({ has: page.getByText(savedMap, { exact: true }) }).dblclick();
      await page.locator('.rf-mind-input').fill(renamedMap);
      await page.locator('.rf-mind-input').press('Enter');
      assert.equal((await editedMapWrite).status(), 200);
      assert.equal(savedRow.mindmap.nodes[0].data.text, renamedMap);
      assert.ok(savedRow.content.includes('preflight-edited-text'));
      assert.deepEqual(savedRow.canvas, hydrated.canvas);
      const canvasTab = page.getByRole('tab', { name: 'canvas', exact: true });
      await canvasTab.focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('brainstormTab') === 'canvas');
      const canvas = page.locator('.excalidraw__canvas.interactive');
      await canvas.waitFor();
      const box = await canvas.boundingBox();
      assert.ok(box && box.width > 300 && box.height > 250, 'preflight requires usable actual canvas geometry');
      const drawnWrite = retainPortalResponse(page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.endsWith('/brainstorm-canvas')
        && (response.request().postData() ?? '').includes('"type":"ellipse"')));
      await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await page.keyboard.press('o');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 4 });
      await page.mouse.up();
      assert.equal((await drawnWrite).status(), 200);
      assert.ok(savedRow.canvas.elements.some(element => element.type === 'ellipse'));
      assert.equal(savedRow.mindmap.nodes[0].data.text, renamedMap);
    }
    if (input.markdownPreflight) {
      try { await page.getByRole('heading', { name: input.markdownPreflight.heading, exact: true }).waitFor({ timeout: 15_000 }); }
      catch (error) { throw new Error([...errors, ...failedRequests, String(error)].join('\n')); }
    }
    if (input.harnesses) {
      const work = input.harnesses;
      const selected = page.getByTestId('pot-workspace-cards').getByTestId(`hive-member-${work.selected}`);
      await selected.waitFor(); await selected.focus(); await page.keyboard.press('Enter');
      await page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.selected}`).waitFor();
      await page.waitForFunction(slug => new URL(location.href).searchParams.get('harness') === slug, work.selected);
      let params = new URL(page.url()).searchParams;
      assert.equal(params.get('scope'), null, 'Nuqs clears the default expanded scope from the URL');
      assert.equal(params.get('slug'), work.hive);
      assert.equal(params.get('harness'), work.selected);
      const neighbor = page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.neighbor}`);
      await neighbor.focus(); await page.keyboard.press('Space');
      await page.waitForFunction(slug => new URL(location.href).searchParams.get('harness') === slug, work.neighbor);
      await page.reload();
      await page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.neighbor}`).waitFor();
      params = new URL(page.url()).searchParams;
      assert.equal(params.get('harness'), work.neighbor);
      assert.equal(params.get('slug'), work.hive);
      assert.equal(params.get('q'), 'preflight-search');
      assert.equal(params.get('ws'), 'preflight-workspace');
    }
    assert.deepEqual(errors, [], 'actual workspace module initialization must be browser-safe');
    if (input.git) {
      // Module initialization only. The empty selector state does not establish
      // private API, dock hydration, commit selection or diff acceptance.
      if (!options.gitRead) assert.equal(await page.locator('.pc-adv-git__empty').count(), 1);
      assert.ok(built.css.includes('.pc-adv-dock'), 'Git mount must retain its real dock stylesheet');
    }
    if (input.workflows) {
      assert.equal(await page.getByRole('textbox', { name: 'Search workflows', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Refresh workflows', exact: true }).count(), 1);
      if (options.workflowsRead) {
        const selected = page.getByTestId(`wf-row:plan:${workflowHarness}:${input.selected}`);
        const alert = page.getByRole('alert').filter({ hasText: 'Upcoming scheduled runs are unavailable:' });
        await selected.getByText(/^in /).waitFor();
        workflowsFail = true;
        await page.getByRole('button', { name: 'Refresh workflows', exact: true }).focus();
        const refreshAtMs = Date.now();
        const denialCycle = observeWorkflowDenialCycle(page);
        await page.keyboard.press('Enter');
        await denialCycle();
        await alert.waitFor();
        const alertAtMs = Date.now();
        await selected.getByText('Schedule unavailable', { exact: true }).waitFor();
        assert.equal(await selected.getByText(/^in /).count(), 0);
        workflowsFail = false;
        await alert.getByRole('button', { name: 'Retry schedule read', exact: true }).focus();
        await page.keyboard.press('Enter');
        await selected.getByText(/^in /).waitFor();
        await alert.waitFor({ state: 'detached' });
        console.log('WORKFLOWS_REFRESH_PREFLIGHT ' + JSON.stringify({ refreshAtMs, alertAtMs,
          errorDelayMs: alertAtMs - refreshAtMs, requests: workflowsTimeline }));
      }
    } else if (input.learning) {
      assert.equal(await page.getByRole('textbox', { name: 'Filter retained items' }).count(), 1);
    } else if (input.stats) {
      await page.getByText(`${input.selected} is not a Git repository.`, { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Repository summary').count(), 0);
    } else if (input.calendar) {
      assert.equal(await page.getByRole('heading', { name: 'Calendar', exact: true }).count(), 1);
      assert.equal(await page.locator('.pc-sched-cal .fc').count(), 1);
      assert.equal(await page.locator('.pc-routines').count(), 1);
    } else if (input.git) {
      if (options.gitRead) {
        const detail = page.getByLabel('Commit diff');
        await detail.getByText(gitCommit.subject, { exact: true }).waitFor();
        assert.ok(await detail.locator('.h-git-file-head').count() > 0);
        await page.reload();
        await page.getByLabel('Commit diff').getByText(gitCommit.subject, { exact: true }).waitFor();
        assert.ok(gitDetailReads.length >= 2, 'Selected commit and reload must read their actual sibling-origin endpoint');
        assert.ok(gitDetailReads.every(read => new URL(read.url).hostname === 'localhost'
          && read.status === 200 && read.allowOrigin === '*'), 'Git show fixture must preserve the production cross-origin transport');
        const close = page.getByRole('button', { name: 'Close commit detail', exact: true });
        await close.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => !new URL(location.href).searchParams.has('commit'));
        assert.deepEqual(errors, []);
      } else {
        assert.match(await page.locator('.pc-adv-git__empty').innerText(), /Pick a .+ from the selector above\./);
      }
    } else if (input.dev) {
      assert.equal(await page.locator('.pc-dev-shell').count(), 1);
      assert.equal(await page.locator('.pc-dev-api').count(), 1);
      assert.equal(await page.getByRole('heading', { name: 'dev:activity', exact: true }).count(), options.devRead ? 1 : 0);
    } else if (input.cupboard) {
      assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).count(), 1);
    } else if (input.support) {
      assert.equal(await page.locator('.pc-support-shell').count(), 1);
    } else if (input.evals) {
      assert.equal(await page.locator('.pc-evals').count(), 1);
    } else if (input.frames) {
      assert.equal(await page.locator('.pc-frames').count(), options.framesRead ? 0 : 1);
      if (options.framesRead) assert.equal(await page.getByRole('button', { name: 'Open Frames', exact: true }).count(), 1);
    } else if (!input.conversations && !input.createDock && !input.harnessSettings && !input.harnesses && !options.brainstormHydration && !options.prsRead && !options.insightsRead) {
      assert.match(await page.locator('body').innerText(), /Select a /);
    }
    if (input.brainstorm) {
      // Both preflights compile the real lazy editor graph. The selected-row
      // variant supplies an HTTP response, not private API persistence proof.
      for (const module of ['BrainstormFull', 'WriteView', 'MapView', 'CanvasView', 'BrainstormChat']) {
        assert.ok([...built.originals.keys()].some(path => path.endsWith(`/app/harness/brainstorm/${module}.tsx`)),
          `Brainstorm preflight must compile the real ${module} module`);
      }
    }
    return { sourceCount: built.originals.size, mounted: true,
      ...(input.harnessSettings ? { settingsBlueprintDefault: true, settingsScopeSwitch: true } : {}), ...(options.brainstormHydration
      ? { selectedHydration: true, noPendingWrites: true, savedMapRetained: true, savedCanvasRetained: true } : {}),
      ...(options.prsRead ? { prsRead: true, filterKeyboard: true, detailReload: true, readRecovery: true,
        subjectPreserved: true, noOutwardWrites: true, providerUsed: false } : {}),
      ...(options.insightsRead ? { insightsRead: true, keyboardTabs: true, tokensReload: true,
        coldRetry: true, warmRetry: true, tokenRetry: true, subjectPreserved: true,
        neighborDistinct: true, noOutwardWrites: true, providerUsed: false } : {}),
      ...(options.workflowsRead ? { workflowsRead: true, staleNextRunWithheld: true, keyboardRetry: true,
        occurrenceRequests: workflowsTimeline.filter(r => r.name === 'plans.scheduledOccurrences') } : {}),
      ...(options.gitRead ? { selectedCommitDiff: true, commitReload: true, keyboardClose: true } : {}),
      ...(options.framesRead ? { framesRead: true, keyboardSelection: true, stillReload: true,
        rosterDenialRecovery: true, shellQueryPreserved: true, streamsClosed: true, noOutwardWrites: true,
        providerUsed: false, evidence: componentEvidence } : {}),
      ...(options.evalsRead ? { evalsRead: true, suiteSelection: true, suiteReload: true,
        warmDenialRecovery: true, coldDenialRecovery: true, shellQueryPreserved: true,
        noOutwardWrites: true, providerUsed: false, evidence: componentEvidence } : {}),
      ...(options.supportRead ? { supportRead: true, keyboardFaq: true, denialRecovery: true,
        streamedAnswer: true, sessionScoped: true, humanEvent: true, deepLinkReload: true,
        shellQueryPreserved: true, noOutwardWrites: true, providerUsed: false, evidence: componentEvidence } : {}),
      ...(options.cupboardRead ? { cupboardRead: true, keyboardFilters: true, filterReload: true,
        warmDenial: true, coldDenial: true, keyboardRetry: true, shellQueryPreserved: true,
        noOutwardWrites: true, providerUsed: false, evidence: componentEvidence } : {}),
      ...(options.devRead ? { devRead: true, keyboardTool: true, schemaInvocation: true, deepLinkReload: true,
        warmDenial: true, coldDenial: true, keyboardRetry: true, shellQueryPreserved: true,
        noOutwardWrites: true, providerUsed: false, evidence: componentEvidence } : {}) };
  } catch (error) {
    if (componentEvidence) writeFileSync(join(componentEvidence, 'receipt-failure.json'), JSON.stringify({
      reads, writes, errors, supportRequests, cupboardRequests, devInvocations, outwardRequests, providerUsed: false, error: String(error) }, null, 2));
    if (options.workflowsRead) console.log('WORKFLOWS_REFRESH_PREFLIGHT_FAILURE ' + JSON.stringify(workflowsTimeline));
    if (page && (input.conversations || input.createDock || input.harnessSettings || options.brainstormHydration || options.prsRead || options.insightsRead || options.gitRead || options.framesRead || options.evalsRead || options.supportRead || options.cupboardRead || options.devRead)) {
      const evidence = mkdtempSync(join(tmpdir(), 'brainstorm-hydration-'));
      if (input.harnessSettings) writeFileSync(join(evidence, 'settings-mount-reads.json'), JSON.stringify({ reads, failedRequests }, null, 2));
      if (input.conversations || input.createDock) writeFileSync(join(evidence, 'aggregate-create-mount-reads.json'), JSON.stringify({ reads, failedRequests }, null, 2));
      await retainPortalBrowserFailure(page, evidence,
        options.gitRead ? new Error([String(error), ...errors, ...failedRequests].join('\n')) : error, errors);
      console.info('BRAINSTORM_HYDRATION_FAILURE_EVIDENCE ' + evidence);
    }
    throw error;
  } finally {
    releaseHydration();
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
}

/** Actual Overview/Create controls and maintained Portal bundle boundary.
 * Host navigation configuration, empty reads and shell geometry are fixtures;
 * this is navigation evidence, not private API or whole-shell acceptance. */
export async function verifyPortalOverviewNavigation(portalSourceRoot: string) {
  const built = await buildPortalRosterBrowser({ portalSourceRoot, selected: 'overview-selected',
    neighbor: 'overview-neighbor', overview: true });
  const browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const evidence = mkdtempSync(join(tmpdir(), 'overview-navigation-'));
  writeFileSync(join(evidence, 'browser-inputs.json'), JSON.stringify({
    browserBundleSha256: digest(built.bundle), originals: [...built.originals].map(([path, identity]) => ({ path, ...identity })),
  }, null, 2));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://overview.invalid');
    if (url.pathname === '/overview.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(built.bundle);
    } else if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<div id="root"></div><script src="/overview.js"></script>');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(url.pathname.endsWith('/rest-query') ? { rows: [] } : { ok: true }));
    }
  });
  const errors: string[] = [];
  let page: Page | undefined;
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const address = server.address(); assert.ok(address && typeof address === 'object');
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    await page.goto(`http://127.0.0.1:${address.port}/?app=overview&q=retained-shell-search`);
    const button = page.getByRole('button', { name: 'Open Plans', exact: true });
    await button.waitFor({ timeout: 20_000 });
    await button.focus(); await page.keyboard.press('Enter');
    try {
      await page.waitForFunction(() => new URL(location.href).searchParams.get('app') === 'create', undefined, { timeout: 10_000 });
    } catch (error) {
      throw new Error(`Overview navigation failed at ${page.url()}; browser errors=${JSON.stringify(errors)}; ${String(error)}`);
    }
    assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
    assert.equal(await page.locator('.pc-overview').count(), 0, 'Overview must be replaced by the selected destination');
    await page.reload();
    await page.getByTestId('overview-destination').filter({ hasText: /^create$/ }).waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('.pc-overview').count(), 0, 'reload must retain the destination');
    assert.deepEqual(errors, [], 'actual Portal surface graph must stay browser-safe');
    const receipt = { keyboardNavigation: true, deepLinkReload: true, destination: 'create', shellQueryPreserved: true,
      browserBundleSha256: digest(built.bundle), originalSourceCount: built.originals.size, evidence };
    writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.info('OVERVIEW_NAVIGATION_RECEIPT ' + JSON.stringify(receipt));
    return receipt;
  } catch (error) {
    if (page) await retainPortalBrowserFailure(page, evidence, error, errors);
    const snapshot = page ? readFileSync(join(evidence, 'portal-browser-failure.json'), 'utf8') : JSON.stringify(errors);
    throw new Error(`Overview browser evidence ${evidence}: ${snapshot}`);
  } finally {
    await browser.close();
    await new Promise<void>(done => server.close(() => done()));
  }
}

async function runPrivateInsightsPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const { selected, neighbor, foreign } = input.insightsHarnesses!;
  const { workspace, evidence, base } = input;
  let overviewDenied = true;
  let tokensDenied = false;
  let denialControl = 'cold-overview';
  const denials: Array<{ control: string; url: string; status: number; body: string }> = [];
  const retainDenials = () => writeFileSync(join(evidence, 'portal-insights-denials.json'), JSON.stringify(denials, null, 2));
  const refuse = async (route: import('playwright-core').Route) => {
    const control = denialControl;
    const response = await route.fetch({ headers: { ...route.request().headers(), host: 'foreign-insights.invalid' } });
    const body = await response.text();
    denials.push({ control, url: route.request().url(), status: response.status(), body });
    retainDenials();
    verifyPrivateHudHostDenial(response.status(), body);
    await route.fulfill({ response });
  };
  await context.route('**/api/harness/*/insights', route => overviewDenied ? refuse(route) : route.continue());
  await context.route(url => url.pathname === '/api/zero-harness/rest-query', route =>
    tokensDenied && new URL(route.request().url()).searchParams.get('name') === 'insights.tokens'
      ? refuse(route) : route.continue());
  await page.goto(url.href);
  await page.getByRole('alert').filter({ hasText: 'Could not load insights: HTTP 403' }).waitFor();
  overviewDenied = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).focus(); await page.keyboard.press('Enter');
  const project = page.getByTestId('insights-overview').getByText(selected, { exact: true });
  await project.waitFor();
  const overviewRead = await context.request.get(new URL(`/api/harness/${encodeURIComponent(selected)}/insights`, base).href);
  assert.equal(overviewRead.status(), 200);
  const overview = (await overviewRead.json()).insights as InsightsTabProps;
  assert.equal(overview.project.name, selected);
  assert.equal(overview.spend.harnessTotalUsdThisWeek, 1.25, 'overview must exclude neighbor and foreign workspace samples');
  const tabs = page.getByRole('tablist', { name: 'Insights view' });
  await tabs.getByRole('tab', { name: 'Tokens', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByTestId('tokens-stat-cost').getByText('$1.3', { exact: true }).waitFor();
  const tokensUrl = new URL('/api/zero-harness/rest-query', base);
  tokensUrl.searchParams.set('name', 'insights.tokens');
  tokensUrl.searchParams.set('args', JSON.stringify({ harness: selected }));
  tokensUrl.searchParams.set('ws', workspace);
  const response = await context.request.get(tokensUrl.href);
  assert.equal(response.status(), 200);
  const snapshot = (await response.json()).rows[0] as TokensDashboardSnapshot;
  assert.equal(snapshot.totals.costUsd, 1.25);
  assert.equal(snapshot.totals.tokens, 42, 'cache-inclusive tokens must equal all four seeded classes');
  assert.equal(snapshot.totals.runs, 1);
  const assertQuery = (slug: string) => {
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('app'), 'insights'); assert.equal(params.get('slug'), slug);
    assert.equal(params.get('q'), 'retained-shell-search'); assert.equal(params.get('ws'), workspace);
    assert.equal(params.get('insightView'), 'tokens');
  };
  assertQuery(selected); await page.reload();
  await page.getByTestId('tokens-stat-cost').getByText('$1.3', { exact: true }).waitFor(); assertQuery(selected);
  denialControl = 'token-refresh';
  tokensDenied = true; await page.getByRole('button', { name: 'Reload token spend' }).click();
  await page.getByText(/Token spend unavailable:/).waitFor();
  tokensDenied = false; await page.getByRole('button', { name: 'Reload token spend' }).click();
  await page.getByTestId('tokens-stat-cost').getByText('$1.3', { exact: true }).waitFor();
  await tabs.getByRole('tab', { name: 'Overview', exact: true }).click(); await project.waitFor();
  overviewDenied = true;
  denialControl = 'warm-overview';
  await page.getByRole('button', { name: 'Close Insights', exact: true }).click();
  await page.getByRole('button', { name: 'Open Insights', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not refresh insights' }).waitFor(); await project.waitFor();
  overviewDenied = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'detached' });
  const neighborUrl = new URL(url); neighborUrl.searchParams.set('slug', neighbor); neighborUrl.searchParams.set('insightView', 'tokens');
  await page.goto(neighborUrl.href);
  await page.getByTestId('tokens-stat-cost').getByText('$9.0', { exact: true }).waitFor(); assertQuery(neighbor);
  const { sql } = getOrgPg();
  const rows = await sql`SELECT workspace_id, harness_slug, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
    FROM harness_shared.agent_usage_samples WHERE source = 'private-insights-fixture' ORDER BY workspace_id, harness_slug`;
  assert.equal(rows.length, 3);
  assert.equal(Number(rows.find(row => row.workspace_id === workspace && row.harness_slug === selected)?.cost_usd), snapshot.totals.costUsd);
  assert.equal(Number(rows.find(row => row.workspace_id === workspace && row.harness_slug === neighbor)?.cost_usd), 9);
  assert.equal(Number(rows.find(row => row.workspace_id === workspace + '-foreign' && row.harness_slug === foreign)?.cost_usd), 99);
  writeFileSync(join(evidence, 'portal-insights-reads.json'), JSON.stringify({ selected, neighbor, foreign,
    overview, snapshot, denials, samples: rows, denialTransport: 'actual operator Host guard response relayed into native browser reads' }, null, 2));
  const denialCoverage = verifyPrivateInsightsDenialCoverage(denials);
  return { workspace, authMethod: 'private-loopback-insights-with-cookie', selected, neighbor, foreign,
    overviewPgAgreement: true, tokensPgAgreement: true, keyboardTabs: true, tokensReload: true,
    coldRetry: true, warmRetry: true, tokenRetry: true, shellQueryPreserved: true, neighborDistinct: true,
    foreignExcluded: true, ...denialCoverage, providerUsed: false };
}

/** Read the real private plan list before selecting an exact Overview row.
 * Seeded plans are fixture inputs; Host denial is the production API guard. */
async function runPrivateOverviewPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const plans = input.overviewPlans!;
  let denyPlans = true;
  const reads: Array<{ url: string; status: number; body: unknown }> = [];
  const denials: Array<{ url: string; status: number; body: unknown }> = [];
  const writes: string[] = [];
  const pending = new Set<Promise<void>>();
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    if (!new URL(response.url()).searchParams.get('name')?.startsWith('plans.list')) return;
    const task = response.json().then(body => { reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(input.evidence, 'portal-overview-reads.json'), JSON.stringify(reads, null, 2));
    }).catch(error => { throw new Error('Overview plan response could not be retained: ' + String(error)); });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/*rest-query*', async route => {
    if (!denyPlans || !new URL(route.request().url()).searchParams.get('name')?.startsWith('plans.list')) {
      await route.continue(); return;
    }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-overview.invalid' } });
    const body = await upstream.json();
    denials.push({ url: route.request().url(), status: upstream.status(), body });
    writeFileSync(join(input.evidence, 'portal-overview-denials.json'), JSON.stringify(denials, null, 2));
    assert.equal(upstream.status(), 403, 'Overview must exercise the real Host guard');
    await route.fulfill({ response: upstream });
  });
  await page.goto(url.href);
  const tile = page.locator('.pc-overview__tile').filter({ has: page.getByRole('button', { name: 'Open Plans', exact: true }) });
  await tile.locator('[data-error="true"]').waitFor();
  assert.equal(await page.getByRole('button', { name: `Open plan ${plans.selectedSlug}`, exact: true }).count(), 0);
  denyPlans = false;
  await page.reload();
  const selected = page.getByRole('button', { name: `Open plan ${plans.selectedSlug}`, exact: true });
  await selected.waitFor();
  await page.getByRole('button', { name: `Open plan ${plans.neighborSlug}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: `Open plan ${plans.foreignSlug}`, exact: true }).count(), 0);
  await Promise.all([...pending]);
  const successful = reads.find(read => read.status === 200);
  assert.ok(successful, 'Overview must retain its successful real private plan read');
  const response = await context.request.get(successful.url);
  assert.equal(response.status(), 200);
  const body = await response.json();
  const rows = body.rows as Array<{ slug: string }>;
  assert.ok(rows.some(row => row.slug === plans.selectedSlug));
  assert.ok(rows.some(row => row.slug === plans.neighborSlug));
  assert.ok(!rows.some(row => row.slug === plans.foreignSlug), 'foreign workspace plan must not enter the private API response');
  await selected.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(value => value.searchParams.get('app') === 'create' && value.searchParams.get('plan') === plans.selectedSlug);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  assert.equal(await page.locator('.pc-overview').count(), 0);
  await page.reload();
  await page.getByTestId('overview-destination').filter({ hasText: /^create$/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('plan'), plans.selectedSlug);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
  await Promise.all([...pending]);
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const stored = await sql`SELECT workspace_id, harness_slug, plan_slug, status, content_hash FROM harness_shared.harness_plans
    WHERE plan_slug IN (${plans.selectedSlug}, ${plans.neighborSlug}, ${plans.foreignSlug}) ORDER BY plan_slug`;
  assert.equal(stored.length, 3); assert.ok(stored.every(row => row.status === 'active'));
  assert.equal(stored.filter(row => row.workspace_id === input.workspace).length, 2);
  assert.deepEqual(writes, [], 'Overview navigation and reload must make no product writes');
  const receipt = { workspace: input.workspace, plans, authMethod: 'private-loopback-overview-with-cookie',
    selectedPlan: plans.selectedSlug, keyboardNavigation: true, deepLinkReload: true, shellQueryPreserved: true,
    privatePlanRead: true, foreignExcluded: true, denialStatus: 403, denialRecovery: 'reload', writes,
    qualification: 'Seeded plan list and exact navigation only; other Overview tiles, hosted tenant and full shell remain unverified' };
  writeFileSync(join(input.evidence, 'portal-overview-read-receipt.json'), JSON.stringify({ ...receipt, stored, reads, denials }, null, 2));
  return receipt;
}

async function runPrivateDevPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const seed = input.devSeed!;
  url.searchParams.set('tab', 'api'); url.searchParams.set('devWs', input.workspace); url.searchParams.set('rail', 'closed');
  url.searchParams.set('ctxWs', input.workspace); url.searchParams.set('ctxH', 'papercusp');
  url.searchParams.set('ctxRole', 'operator'); url.searchParams.set('ctxRun', 'private-dev'); url.searchParams.set('ctxSpawn', 'private-dev');
  const reads: Array<{ url: string; status: number; args: unknown; body: string }> = [];
  const denials: Array<{ status: number; body: string }> = [];
  const writes: string[] = [];
  const captures = new Set<Promise<void>>();
  let denyNext = false;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET'
      && new URL(request.url()).pathname !== '/api/agent-tools/dev/activity') writes.push(request.url());
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/api/agent-tools/dev/activity') return;
    const capture = response.text().then(body => {
      reads.push({ url: response.url(), status: response.status(), args: response.request().postDataJSON(), body });
      writeFileSync(join(input.evidence, 'portal-dev-reads.json'), JSON.stringify(reads, null, 2));
    });
    captures.add(capture); void capture.catch(() => {});
    void capture.then(() => captures.delete(capture), () => captures.delete(capture));
  });
  await page.route('**/api/agent-tools/dev/activity?*', async route => {
    if (!denyNext) return route.continue();
    denyNext = false;
    const upstream = await context.request.post(route.request().url(), {
      headers: { 'content-type': 'application/json', host: 'foreign-dev.invalid' }, data: route.request().postData()! });
    const body = await upstream.text();
    denials.push({ status: upstream.status(), body });
    writeFileSync(join(input.evidence, 'portal-dev-denials.json'), JSON.stringify(denials, null, 2));
    verifyPrivateHudHostDenial(upstream.status(), body);
    await route.fulfill({ response: upstream, body });
  });
  const filter = () => page.getByPlaceholder('Filter tools…', { exact: true });
  const ids = () => page.locator('.pc-dev-form-row').filter({ hasText: 'workspaceIds' }).locator('textarea');
  const limit = () => page.locator('.pc-dev-form-row').filter({ hasText: 'limit' }).locator('input');
  const invoke = async () => { await page.getByRole('button', { name: 'Invoke', exact: true }).focus(); await page.keyboard.press('Enter'); };
  const fill = async (scope: string) => { await ids().fill(JSON.stringify([scope])); await limit().fill('100'); };
  const assertSelected = async (marker: string, excluded: string[]) => {
    await page.waitForFunction(value => document.querySelector('.pc-dev-api-response')?.textContent?.includes(value), marker);
    const text = await page.locator('.pc-dev-api-response').innerText();
    for (const value of excluded) assert.equal(text.includes(value), false, 'activity UI must exclude ' + value);
    assert.equal(await page.getByText('HTTP 403', { exact: true }).count(), 0);
  };
  const assertScope = () => {
    for (const [key, value] of Object.entries({ app: 'dev', ws: input.workspace, tab: 'api', devWs: input.workspace,
      rail: 'closed', q: 'dev:activity', tool: 'dev:activity', ctxWs: input.workspace, ctxH: 'papercusp',
      ctxRole: 'operator', ctxRun: 'private-dev', ctxSpawn: 'private-dev' }))
      assert.equal(new URL(page.url()).searchParams.get(key), value, 'Dev must preserve ' + key);
  };
  await page.goto(url.href); await filter().fill('dev:activity');
  await page.locator('.pc-dev-api-tool').filter({ hasText: 'dev:activity' }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'dev:activity', exact: true }).waitFor();
  assert.equal(await page.locator('.pc-dev-right').count(), 0);
  await fill(input.workspace); await invoke(); await assertSelected(seed.selectedMarker, [seed.neighborMarker, seed.foreignMarker]);
  await fill(seed.neighborWorkspace); await invoke(); await assertSelected(seed.neighborMarker, [seed.selectedMarker, seed.foreignMarker]);
  await fill(input.workspace); denyNext = true; await invoke();
  await page.getByText('HTTP 403', { exact: true }).waitFor();
  assert.match(await page.locator('.pc-dev-api-response').innerText(), /host_not_allowed/);
  assert.equal((await page.locator('.pc-dev-api-response').innerText()).includes(seed.neighborMarker), false);
  await invoke(); await assertSelected(seed.selectedMarker, [seed.neighborMarker, seed.foreignMarker]); assertScope();
  await page.reload(); await page.getByRole('heading', { name: 'dev:activity', exact: true }).waitFor(); assertScope();
  assert.equal(await page.locator('.pc-dev-api-response').count(), 0, 'reload must not replay a diagnostic invocation');
  await fill(input.workspace); denyNext = true; await invoke(); await page.getByText('HTTP 403', { exact: true }).waitFor();
  await invoke(); await assertSelected(seed.selectedMarker, [seed.neighborMarker, seed.foreignMarker]);
  await Promise.all(captures);
  assert.deepEqual(reads.map(read => read.status), [200, 200, 403, 200, 403, 200]);
  for (const [index, read] of reads.entries()) {
    assert.deepEqual(read.args, { workspaceIds: [index === 1 ? seed.neighborWorkspace : input.workspace], limit: 100 });
    assert.equal(new URL(read.url).searchParams.get('workspace'), input.workspace);
    assert.equal(new URL(read.url).searchParams.get('role'), 'operator');
  }
  assert.deepEqual(writes, []); assert.equal(denials.length, 2);
  await page.screenshot({ path: join(input.evidence, 'portal-dev-verified.png'), fullPage: true });
  return { workspace: input.workspace, authMethod: 'private-native-diagnostic-with-cookie', scopedActivity: true,
    neighborDistinct: true, keyboardTool: true, schemaInvocation: true, deepLinkReload: true, shellQueryPreserved: true,
    warmHostDenialRecovery: true, coldHostDenialRecovery: true, writes,
    scope: 'Actual Dev route and public diagnostic HTTP projection on disposable PG; workspaceIds is a query filter. Host guard is measured; cookie tenant authorization, hosted/provider proof and complete Dev tab coverage remain unverified' };
}

/** Actual config/spec workflow: no synthetic success or denial responses. */
async function runPrivateHarnessSettingsPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const { selected, neighbor, foreign } = input.settingsHarnesses!;
  const reads: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  const captures = new Set<Promise<void>>();
  const retain = () => writeFileSync(join(input.evidence, 'portal-settings-wire.json'),
    JSON.stringify({ reads, writes }, null, 2));
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/harness/${selected}/spec`) {
      writes.push({ url: request.url(), body: request.postDataJSON() }); retain();
    }
  });
  page.on('response', response => {
    const target = new URL(response.url());
    if (!target.pathname.endsWith('/rest-query') || target.searchParams.get('name') !== 'harnessProjectFiles.byHarness') return;
    const capture = response.json().then(body => {
      reads.push({ url: response.url(), args: target.searchParams.get('args'), status: response.status(), body }); retain();
    }, error => { reads.push({ url: response.url(), error: String(error) }); retain(); });
    captures.add(capture); void capture.finally(() => captures.delete(capture));
  });
  const { sql } = getOrgPg();
  const stored = await sql`SELECT harness_slug, workspace_id, config FROM harness_shared.harness_project_files
    WHERE harness_slug IN (${selected}, ${neighbor}, ${foreign}) ORDER BY harness_slug`;
  writeFileSync(join(input.evidence, 'portal-settings-initial-store.json'), JSON.stringify(stored, null, 2));
  const endpoint = (slug: string) => new URL(`/api/harness/${slug}/spec?phase=staging`, input.base).href;
  const readConfig = async (slug: string) => {
    const response = await context.request.get(endpoint(slug));
    assert.equal(response.status(), 200);
    return JSON.parse((await response.json()).config);
  };
  const denials: Array<{ status: number; method: string; url: string }> = [];
  let denyRead = true;
  let denySave = true;
  await context.route('**/api/harness/**', async route => {
    const request = route.request();
    const target = new URL(request.url());
    if (!(denyRead && target.pathname === `/api/harness/${selected}/blueprint-params`)
      && !(denySave && request.method() === 'PUT' && target.pathname === `/api/harness/${selected}/spec`)) {
      await route.continue(); return;
    }
    const response = await context.request.fetch(request, { headers: { host: 'foreign-settings.invalid' } });
    assert.equal(response.status(), 403, 'Settings denial must originate in the actual Host guard');
    denials.push({ status: response.status(), method: request.method(), url: request.url() });
    await route.fulfill({ response });
  });
  url.searchParams.set('app', 'settings'); url.searchParams.set('slug', selected);
  url.searchParams.set('nextPot', neighbor);
  const assertQuery = (slug: string) => {
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('slug'), slug); assert.equal(params.get('ws'), input.workspace);
    assert.equal(params.get('q'), 'retained-shell-search');
  };
  await page.goto(url.href);
  await page.getByRole('alert').filter({ hasText: 'Unable to load settings: HTTP 403' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Private setting', exact: true }).count(), 0);
  denyRead = false;
  await page.getByRole('button', { name: 'Retry settings', exact: true }).focus(); await page.keyboard.press('Enter');
  const setting = () => page.getByRole('checkbox', { name: 'Private setting', exact: true });
  await setting().waitFor(); assert.equal(await setting().isChecked(), false);
  const before = await readConfig(selected);
  await Promise.all([...captures]);
  const initialRead = reads.find(read => read.status === 200
    && JSON.parse(read.args as string).harnessSlug === selected);
  assert.ok(initialRead, 'Settings must retain its selected scoped config query before editing');
  const initialRows = (initialRead.body as { rows: Array<{ config: string }> }).rows;
  assert.deepEqual(initialRows.map(row => JSON.parse(row.config)), [before],
    'Settings sync config must agree with canonical spec before a full-config save');
  await setting().focus(); await page.keyboard.press('Space');
  const save = () => page.getByRole('button', { name: 'Save', exact: true });
  const denied = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === `/api/harness/${selected}/spec`);
  await save().focus(); await page.keyboard.press('Enter'); assert.equal((await denied).status(), 403);
  await page.getByText('Save failed', { exact: true }).waitFor();
  assert.deepEqual(await readConfig(selected), before, 'Denied save must leave the persisted config unchanged');
  assert.equal(await setting().isChecked(), true, 'Denied save must preserve the edit for retry');
  denySave = false;
  const accepted = page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === `/api/harness/${selected}/spec`);
  await save().click(); assert.equal((await accepted).status(), 200);
  await page.getByText('Settings saved', { exact: true }).waitFor();
  assert.deepEqual(await readConfig(selected), { ...before, parity: { enabled: true } });
  assertQuery(selected); await page.reload(); await setting().waitFor();
  assert.equal(await setting().isChecked(), true); assertQuery(selected);
  await setting().click(); // An unsaved selected-pot edit must not cross the switch.
  await page.getByTestId('settings-switch-pot').click();
  await page.getByRole('heading', { name: 'Settings — ' + neighbor, exact: true }).waitFor();
  await setting().waitFor(); assert.equal(await setting().isChecked(), true);
  assert.equal(await save().isEnabled(), false); assertQuery(neighbor);
  const neighborConfig = await readConfig(neighbor);
  assert.equal(neighborConfig.marker, 'neighbor'); assert.equal(neighborConfig.parity.enabled, true);
  const foreignRead = await context.request.get(endpoint(foreign));
  assert.equal(foreignRead.status(), 404, 'Foreign-workspace registry target must be inaccessible');
  const foreignWrite = await context.request.put(endpoint(foreign), { data: { config: '{}' } });
  assert.equal(foreignWrite.status(), 404);
  const { loadProjectFiles } = await import('../lib/harness-project-files');
  const persisted = Object.fromEntries(await Promise.all([selected, neighbor, foreign].map(async slug =>
    [slug, JSON.parse((await loadProjectFiles(slug)).config!)])));
  assert.deepEqual(persisted[selected], { ...before, parity: { enabled: true } });
  assert.deepEqual(persisted[neighbor], neighborConfig);
  assert.deepEqual(persisted[foreign], { parity: { enabled: true }, marker: 'foreign' });
  assert.ok(denials.some(denial => denial.method === 'GET') && denials.some(denial => denial.method === 'PUT'));
  writeFileSync(join(input.evidence, 'portal-settings-persistence.json'), JSON.stringify({ selected, neighbor, foreign,
    before, persisted, denials, foreignStatuses: [foreignRead.status(), foreignWrite.status()] }, null, 2));
  return { authMethod: 'private-loopback-harness-settings-with-cookie', workspace: input.workspace,
    schemaDeniedRecovery: true, saveDeniedRetry: true, keyboardSave: true, configPgAgreement: true,
    reloadPersisted: true, unsavedScopeDiscarded: true, neighborIsolated: true, foreignExcluded: true,
    settingsBlueprintDefault: true, shellQueryPreserved: true };
}

async function runPrivateConversationsPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const seed = input.conversationsSeed!;
  const reads: Array<{ name: string; status: number; body: any; url: string }> = [];
  const denials: Array<{ name: string; status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const writes: string[] = [];
  let denyLists = true;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url()); });
  page.on('response', response => {
    const name = new URL(response.url()).searchParams.get('name');
    if (!name?.startsWith('conversations.')) return;
    const task = response.json().then(body => {
      reads.push({ name, status: response.status(), body, url: response.url() });
      writeFileSync(join(input.evidence, 'portal-conversations-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/zero-harness/rest-query*', async route => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (!denyLists || !seed.own.some(row => row.list === name)) { await route.continue(); return; }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-conversations.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403); assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ name, status: upstream.status(), body });
    writeFileSync(join(input.evidence, 'portal-conversations-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  url.searchParams.set('app', 'conversations'); url.searchParams.set('q', 'retained-shell-search');
  await page.goto(url.href);
  const rail = page.getByRole('region', { name: 'Conversation list', exact: true });
  await rail.getByText("Couldn't load", { exact: true }).waitFor();
  assert.equal(await rail.getByRole('button', { name: /^Open / }).count(), 0);
  denyLists = false;
  await rail.getByRole('button', { name: 'Retry', exact: true }).focus(); await page.keyboard.press('Enter');
  const search = conversationSearchControl(page);
  await search.waitFor();
  for (const row of seed.own.filter(row => row.id.includes('-selected-'))) {
    await search.fill(row.title); await page.waitForURL(value => value.searchParams.get('cq') === row.title);
    const open = rail.getByRole('button', { name: 'Open ' + row.title, exact: true });
    await open.waitFor(); await open.focus(); await page.keyboard.press('Enter');
    await page.waitForURL(value => value.searchParams.get(row.selection) === row.id && value.searchParams.get('conv') === row.source);
    const body = page.locator('.pc-advconv__main').getByText(row.body, { exact: true });
    await body.waitFor();
    await page.reload(); await body.waitFor();
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get(row.selection), row.id); assert.equal(params.get('cq'), row.title);
    assert.equal(params.get('ws'), seed.workspace); assert.equal(params.get('q'), 'retained-shell-search');
    assert.ok(!(await page.locator('body').innerText()).includes(seed.foreign.find(value => value.source === row.source)!.title));
  }
  await search.fill('');
  const neighbor = seed.own.find(row => row.id.includes('-neighbor-') && row.source === 'threads')!;
  await search.fill(neighbor.title); await rail.getByRole('button', { name: 'Open ' + neighbor.title, exact: true }).click();
  await page.locator('.pc-advconv__main').getByText(neighbor.body, { exact: true }).waitFor();
  await Promise.all([...pending]);
  for (const row of seed.own.filter(row => row.id.includes('-selected-'))) {
    assert.ok(reads.some(read => read.name === row.list && read.status === 200));
    assert.ok(reads.some(read => read.name === row.detail && read.status === 200 && JSON.stringify(read.body).includes(row.body)));
    assert.ok(denials.some(read => read.name === row.list));
  }
  assert.deepEqual(writes, [], 'Reading the aggregate must not send conversation mutations');
  return { workspace: seed.workspace, authMethod: 'private-loopback-conversations-with-cookie',
    fourStoreSelection: true, filterReload: true, keyboardSelection: true, initialDenialRecovery: true,
    neighborDistinct: true, foreignExcluded: true, noProductWrites: true };
}

async function runPrivateCreateDockPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const seed = input.createDockPlans!;
  url.searchParams.set('app', 'create'); url.searchParams.set('slug', seed.harness);
  url.searchParams.set('scope', 'self'); url.searchParams.set('view', 'plans');
  url.searchParams.set('plan', seed.selectedSlug); url.searchParams.delete('q');
  const reads: Array<{ url: string; status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  page.on('response', response => {
    if (!response.url().includes('/api/') || !/plans|dock-layouts|dockLayouts/.test(response.url())) return;
    const task = response.json().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(input.evidence, 'portal-create-dock-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await page.goto(url.href);
  const dock = page.locator('.pc-adv-create__dock');
  const main = dock.locator('.pc-plans__main');
  await createDockPlanBody(main, seed.selectedSlug + '-body').waitFor();
  const neighbor = dock.locator('.pc-plans__list').getByText(seed.neighborSlug, { exact: true }).first();
  await neighbor.click(); await createDockPlanBody(main, seed.neighborSlug + '-body').waitFor();
  await page.waitForURL(value => value.searchParams.get('plan') === seed.neighborSlug);
  // Exercise the real splitter and its debounced HTTP persistence, rather
  // than saving a fixture layout directly through the API.
  const sash = dock.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash').first();
  const box = await sash.boundingBox(); assert.ok(box, 'Create must expose its resizable sidebar splitter');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dock-layouts/adv-create2'
    && response.request().method() === 'PUT');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  const save = await saved; assert.equal(save.status(), 200);
  const savedRow = await save.json();
  const endpoint = new URL('/api/dock-layouts/adv-create2', input.base); endpoint.searchParams.set('ws', seed.workspace);
  const persisted = await context.request.get(endpoint.href); assert.equal(persisted.status(), 200);
  const persistedRow = await persisted.json();
  assert.ok(savedRow.layoutJson, 'the canonical save receipt must contain its logical layout');
  assert.deepEqual(persistedRow.layoutJson, savedRow.layoutJson);
  await page.reload(); await createDockPlanBody(main, seed.neighborSlug + '-body').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('plan'), seed.neighborSlug);
  assert.equal(new URL(page.url()).searchParams.get('ws'), seed.workspace);
  assert.ok(!(await dock.innerText()).includes(seed.foreignSlug));
  await Promise.all([...pending]);
  assert.ok(reads.some(read => read.status === 200 && read.url.includes('dockLayouts.byName')));
  writeFileSync(join(input.evidence, 'portal-create-dock-persistence.json'), JSON.stringify({ savedRow, persistedRow }, null, 2));
  return { workspace: seed.workspace, authMethod: 'private-loopback-create-dock-with-cookie',
    actualPlanSelection: true, neighborDistinct: true, selectedPlanReload: true, splitterPersisted: true, foreignExcluded: true };
}

export async function runPortalRosterBrowser(input: PortalRosterBrowserInput) {
  const { evidence, base, workspace, selected, neighbor } = input;
  const { portal, entry, bundle, css, originals } = await buildPortalRosterBrowser(input);
  const spa = join(evidence, 'portal-roster-spa');
  mkdirSync(spa, { recursive: true });
  if (input.docs) symlinkSync(vditorAssets, join(spa, 'vditor'), 'dir');
  writeFileSync(join(spa, 'portal-roster.js'), bundle);
  writeFileSync(join(spa, 'portal-roster.css'), readFileSync(join(portal, 'app/tokens.css'), 'utf8') + '\n'
    + readFileSync(join(portal, 'app/globals.css'), 'utf8')
    + (input.prompts ? '\n' + readFileSync(resolve(import.meta.dirname, '../../../apps/operator/app/quick-panel/quick-panel.css'), 'utf8') : '')
    + (input.plans ? '\n' + ['app/_components/plans/plans-pane.css', 'app/admin/plans/plans.css']
      .map(path => readFileSync(resolve(import.meta.dirname, '../../../apps/operator', path), 'utf8')).join('\n')
      + '\nhtml,body,#root{height:100%;margin:0}#root{display:flex}' : '')
    + (input.inbox ? '\n' + ['app/_components/inbox/inbox-pane.css', 'app/admin/plans/plans.css']
      .map(path => readFileSync(resolve(import.meta.dirname, '../../../apps/operator', path), 'utf8')).join('\n')
      + '\nhtml,body,#root{height:100%;margin:0}#root{display:flex}' : '')
    + (input.brainstorm ? '\n' + readFileSync(resolve(import.meta.dirname, '../../../apps/operator/app/harness/harness.css'), 'utf8')
      + '\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex:1}' : '')
    + (input.harnesses || input.git || input.conversations || input.createDock ? '\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex:1}' : '') + '\n' + css);
  writeFileSync(join(spa, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/portal-roster.css"></head>'
    + '<body><div id="root"></div><script src="/portal-roster.js"></script></body></html>');
  const sourceIdentity = { portal, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: portal, encoding: 'utf8' }).trim(),
    entrySha256: digest(entry), bundleSha256: digest(Buffer.from(bundle)), originals: [...originals].map(([path, identity]) => ({ path, ...identity })),
    scope: 'Exactly the browser bundler inputs read above; no complete native/API bootstrap closure claim' };
  writeFileSync(join(evidence, 'portal-browser-source.json'), JSON.stringify(sourceIdentity, null, 2));
  console.log('ROSTER_STOP_HTTP_PHASE browser-bundle-ready');

  const browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext();
  const cookie = (value: string) => ({ name: input.cookieName, value, url: base, httpOnly: true, sameSite: 'Lax' as const });
  const receipts: Array<{ status: number; body: any }> = [];
  const selectedMessageIds: string[] = [];
  const marker = `private-browser-${process.pid}`;
  const pageErrors: string[] = [];
  const syncReads: Array<Record<string, unknown>> = [];
  const syncReadCaptures = new Set<Promise<void>>();
  let page: Page | undefined;
  try {
    await context.addCookies([cookie(input.ownToken)]);
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
    if (input.inbox || input.plans || input.hud || input.health || input.harnesses || input.brainstorm) page.on('response', response => {
      const url = new URL(response.url());
      const name = url.searchParams.get('name');
      const queryNames = input.brainstorm ? ['harnessBrainstorm.byHarness'] : input.health ? ['health.snapshot', 'health.history'] : input.harnesses ? ['harnessProjects.lite', 'workItems.byHarness']
        : [input.hud ? 'advRoster.list' : input.plans ? 'plans.list' : 'plans.attention'];
      if (!url.pathname.endsWith('/rest-query') || !queryNames.some(query => name?.startsWith(query))) return;
      const observation = { at: new Date().toISOString(), url: response.url(), name, args: url.searchParams.get('args'),
        delta: url.searchParams.get('delta'), status: response.status(),
        requestWorkspace: response.request().headers()['x-papercusp-workspace'] ?? null };
      const capture = response.json().then(body => {
        syncReads.push({ ...observation, body });
      }, error => {
        syncReads.push({ ...observation, error: String(error) });
      }).then(() => {
        writeFileSync(join(evidence, input.brainstorm ? 'portal-brainstorm-reads.json' : input.health ? 'portal-health-reads.json' : input.harnesses ? 'portal-work-reads.json' : input.hud ? 'portal-hud-reads.json' : input.plans ? 'portal-plans-reads.json' : 'portal-inbox-reads.json'),
          JSON.stringify(syncReads, null, 2));
      });
      syncReadCaptures.add(capture);
      void capture.finally(() => syncReadCaptures.delete(capture));
    });
    const url = new URL(input.cupboard ? '/?app=cupboard&q=retained-shell-search'
      : input.dev ? '/?app=dev&q=retained-shell-search'
      : input.workflows ? '/?app=workflows&q=retained-shell-search'
      : input.learning ? '/?app=learning&q=retained-shell-search'
      : input.calendar ? '/?app=calendar&q=retained-shell-search' : input.projectHistory ? '/?app=history&q=retained-shell-search'
      : input.overview ? '/?app=overview&q=retained-shell-search'
      : input.health ? '/?app=health&q=retained-shell-search' : input.hud ? '/?app=hud&hudtab=sessions&hudall=true&q=retained-shell-search'
      : input.testing ? '/?app=testing&q=retained-shell-search'
      : input.harnesses ? '/?app=work&scope=all&q=retained-shell-search'
      : input.brainstorm ? '/?app=brainstorm&q=retained-shell-search'
      : input.insights ? '/?app=insights&q=retained-shell-search'
      : input.docs ? '/?app=docs&q=retained-shell-search'
      : input.plans ? '/?app=plans&q=retained-shell-search'
      : input.inbox ? '/?app=inbox&opci=alerts&opck=coord-message&opcsort=newest&q=retained-shell-search'
      : input.prompts ? '/?app=overview&panel=quick&q=retained-shell-search'
      : input.harnessSettings ? '/?app=settings&q=retained-shell-search'
      : input.settings || input.shortcuts ? '/?app=settings' : '/?panel=agents', base); url.searchParams.set('ws', workspace);
    if (input.docs) {
      url.searchParams.set('slug', input.docs.harness);
      url.searchParams.set('docpath', input.docs.neighborDoc);
    }
    if (input.brainstormHarnesses) url.searchParams.set('slug', input.brainstormHarnesses.selected);
    if (input.insightsHarnesses) url.searchParams.set('slug', input.insightsHarnesses.selected);
    if (input.settingsHarnesses) {
      const receipt = await runPrivateHarnessSettingsPage(page, context, input, url);
      assert.deepEqual(pageErrors, [], 'Actual Settings controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.conversationsSeed || input.createDockPlans) {
      const receipt = input.conversationsSeed ? await runPrivateConversationsPage(page, context, input, url)
        : await runPrivateCreateDockPage(page, context, input, url);
      assert.deepEqual(pageErrors, [], 'Actual aggregate/Create controls must remain browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.cupboardSeed) {
      const receipt = await runPrivateCupboardPage(page, context, { ...input, cupboardSeed: input.cupboardSeed }, url);
      assert.deepEqual(pageErrors, [], 'actual Cupboard controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.devSeed) {
      const receipt = await runPrivateDevPage(page, context, input, url);
      assert.deepEqual(pageErrors, [], 'actual Dev controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.gitSeed) {
      const receipt = await runPrivateGitPage(page, context, input.gitSeed, url, evidence);
      assert.deepEqual(pageErrors, [], 'actual Git dock, graph and detail must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.statsSeed) {
      const receipt = await runPrivateStatsPage(page, context, input.statsSeed, url, evidence);
      assert.deepEqual(pageErrors, [], 'actual Stats controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.testing) {
      const receipt = await runPrivateTestingPage(page, context, input, url);
      assert.deepEqual(pageErrors, [], 'actual Testing registry and domain controls must stay browser-safe');
      return receipt;
    }
    if (input.workflowsSeed) {
      const receipt = await runPrivateWorkflowsPage(page, context, input.workflowsSeed, url, evidence);
      assert.deepEqual(pageErrors, [], 'actual Workflows controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.calendarSeed) {
      const receipt = await runPrivateCalendarPage(page, context, input.calendarSeed, url, evidence);
      assert.deepEqual(pageErrors, [], 'actual Calendar controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.learningSeed) {
      const receipt = await runPrivateLearningPage(page, context, input.learningSeed, url, evidence);
      assert.deepEqual(pageErrors, [], 'actual Learning controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.projectHistorySeed) {
      url.searchParams.set('slug', input.projectHistorySeed.selected);
      const receipt = await runPrivateProjectHistoryPage(page, context, input.projectHistorySeed, url, evidence);
      assert.deepEqual(pageErrors, [], 'actual History archive/live must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.insights) {
      const receipt = await runPrivateInsightsPage(page, context, input, url);
      assert.deepEqual(pageErrors, [], 'real Insights controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.overviewPlans) {
      const receipt = await runPrivateOverviewPage(page, context, input, url);
      assert.deepEqual(pageErrors, [], 'actual Overview and Create controls must stay browser-safe');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    // Observe before navigation; a fast mount can save before its caller
    // starts waiting. The response proves the API applied the initial scene.
    const initialBrainstormSaves = input.brainstormHarnesses ? Promise.all(['brainstorm-mindmap', 'brainstorm-canvas']
      .map(surface => page!.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname === `/api/harness/${input.brainstormHarnesses!.selected}/${surface}`))) : undefined;
    void initialBrainstormSaves?.catch(() => {}); // journey awaits and reports this failure
    await page.goto(url.href);
    if (input.brainstormHarnesses) {
      const receipt = await runPrivateBrainstormPage(page, context, input, syncReads, syncReadCaptures, initialBrainstormSaves!);
      assert.deepEqual(pageErrors, [], 'actual Brainstorm editors must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.health) {
      const receipt = await runPrivateHealthPage(page, context, input, syncReads, syncReadCaptures);
      assert.deepEqual(pageErrors, [], 'actual Health controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.harnesses) {
      const receipt = await runPrivateHarnessesPage(page, context, input, syncReads, syncReadCaptures);
      assert.deepEqual(pageErrors, [], 'actual Work controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.hud) {
      const search = page.getByTestId('hud-session-search');
      await search.waitFor();
      const selectedCard = page.locator('.hud__card').filter({ hasText: `HUD selected ${selected}` });
      const neighborCard = page.locator('.hud__card').filter({ hasText: `HUD neighbor ${neighbor}` });
      assert.ok(input.foreign, 'HUD exclusion control requires a seeded foreign-workspace owner');
      const foreignCard = page.locator('.hud__card').filter({ hasText: `HUD foreign ${input.foreign}` });
      await selectedCard.waitFor();
      await neighborCard.waitFor();
      assert.equal(await foreignCard.count(), 0, 'foreign workspace session must not appear in the scoped HUD');
      await search.focus();
      await search.pressSequentially(selected);
      await page.waitForURL(value => value.searchParams.get('hudsq') === selected);
      await selectedCard.waitFor();
      await neighborCard.waitFor({ state: 'hidden' });
      const filteredUrl = page.url();
      await Promise.all([...syncReadCaptures]);
      const scope = { workspace, selected, neighbor, foreign: input.foreign };
      verifyPrivateHudCapturedRoster(syncReads, scope);
      const readsBeforeReload = syncReads.length;
      await page.reload();
      await selectedCard.waitFor();
      assert.equal(await search.inputValue(), selected);
      assert.equal(await neighborCard.count(), 0);
      assert.equal(page.url(), filteredUrl);
      assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
      await Promise.all([...syncReadCaptures]);
      const read = verifyPrivateHudCapturedRoster(syncReads.slice(readsBeforeReload), scope);
      // This native read seam is auth:loopback, not cookie workspace authorization.
      // The intentionally global query is the positive control for the seeded row.
      const globalUrl = new URL(read.url as string);
      globalUrl.searchParams.set('args', JSON.stringify({ ...JSON.parse(read.args as string), workspaceId: null }));
      const globalRead = await context.request.get(globalUrl.href);
      assert.equal(globalRead.status(), 200);
      const globalRoster = (await globalRead.json()).rows[0];
      assert.ok(globalRoster.active.some((row: { ownerId: string }) => row.ownerId === input.foreign),
        'global control must contain the same foreign owner excluded by the scoped query');
      const deniedHost = 'foreign-roster.invalid';
      const denied = await context.request.get(read.url as string, { headers: { host: deniedHost } });
      const deniedStatus = denied.status();
      const deniedBody = await denied.text();
      writeFileSync(join(evidence, 'portal-hud-denial.json'), JSON.stringify({
        url: read.url, host: deniedHost, status: deniedStatus, body: deniedBody,
        authPlane: 'private-loopback-with-cookie' }, null, 2));
      verifyPrivateHudHostDenial(deniedStatus, deniedBody);
      assert.equal(await search.inputValue(), selected, 'denied read must preserve the selected filter');
      await selectedCard.waitFor();
      await page.reload();
      await selectedCard.waitFor();
      assert.equal(await search.inputValue(), selected);
      await search.fill('');
      await neighborCard.waitFor();
      await selectedCard.waitFor();
      assert.equal(await foreignCard.count(), 0, 'filter reset must retain workspace exclusion');
      assert.deepEqual(pageErrors, [], 'actual HUD session workflow must stay browser-safe');
      const retained = { workspace, authMethod: 'private-loopback-with-cookie', selected, neighbor, foreign: input.foreign,
        keyboardFilter: true, selectedRetained: true, neighborFiltered: true,
        filterReset: true, deepLinkReload: true, shellQueryPreserved: true,
        scopedWorkspaceArgs: true, foreignExcluded: true, globalForeignControl: true,
        denialStatus: deniedStatus, denialTransport: 'actual-private-roster-external-host', retryReload: true,
        browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.docs) {
      const receipt = await runPrivateDocsPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real Docs panel must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.plans) {
      const receipt = await runPrivatePlansPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real Plans controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.inbox) {
      const receipt = await runPrivateInboxPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real inbox controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.prompts) {
      const receipt = await runPrivatePromptsTab(page, context, input);
      assert.deepEqual(pageErrors, [], 'real saved-prompt controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.settings) {
      const receipt = await runPrivateProfilePage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real Profile form must complete without browser errors');
      const result = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(result, null, 2));
      return result;
    }
    if (input.shortcuts) {
      const receipt = await runPrivateShortcutsPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real shortcut settings and dispatcher must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.history) {
      const receipt = await runHistoryPage(page, input);
      assert.deepEqual(pageErrors, [], 'real history components must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    const select = page.getByTestId(`agent-select-${selected}`);
    await select.check();
    assert.equal(await page.getByTestId(`agent-select-${neighbor}`).isChecked(), false);
    if (input.stop) {
      const receipt = await runConfirmedStopPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real stop component must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    assert.ok(input.verifyReceipt, 'coord browser proof requires its persisted receipt verifier');
    await page.getByTestId('agents-bulk-message').click();
    await page.getByTestId('agents-bulk-msg').fill(marker);

    const actionPage = page;
    const send = async (button: string) => {
      const response = actionPage.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/coord/send'
        && response.request().method() === 'POST');
      await actionPage.getByTestId(button).click();
      const observed = await response;
      const receipt = { status: observed.status(), body: await observed.json() };
      receipts.push(receipt); return receipt;
    };
    // An authenticated foreign workspace cookie against a retained own-workspace
    // selection is a real server denial, not a canned UI failure response.
    await context.addCookies([cookie(input.foreignToken)]);
    const denied = await send('agents-bulk-msg-send');
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    await page.getByTestId('agents-bulk-note').filter({ hasText: 'failed' }).waitFor();
    assert.equal(await page.getByTestId('agents-bulk-msg').inputValue(), marker, 'denied draft must survive');
    assert.equal((await readInbox(selected)).some(message => message.summary === marker), false,
      'denial must persist no partial selected delivery');
    assert.equal((await readInbox(neighbor)).some(message => message.summary === marker), false);

    await context.addCookies([cookie(input.ownToken)]);
    const accepted = await send('agents-bulk-msg-send');
    selectedMessageIds.push(await input.verifyReceipt(accepted, marker, false));
    await page.getByTestId('agents-bulk-note').filter({ hasText: 'Sent to 1 agent' }).waitFor();
    assert.equal(await page.getByTestId('agents-bulk-compose').count(), 0);
    const stored = await getMessageById(selectedMessageIds[0]);
    assert.equal(stored?.summary, marker); assert.deepEqual(stored?.to, [selected]);
    // Keep the real private origin, workspace and panel deep link through reload.
    await page.reload();
    assert.equal(page.url(), url.href);
    await page.getByTestId(`agent-select-${selected}`).check();
    assert.equal(await page.getByTestId(`agent-select-${neighbor}`).isChecked(), false);
    const wake = await send('agents-bulk-wake');
    selectedMessageIds.push(await input.verifyReceipt(wake, '(nudge from the portal)', true));
    assert.equal(wake.body.results[0].wake.pickupConfirmed, false);
    const note = await readSettledNote(page);
    assert.match(note, /pickup not confirmed|wake not delivered|message is in inbox/);
    assert.notEqual(selectedMessageIds[0], selectedMessageIds[1]);
    const neighborInbox = await readInbox(neighbor);
    assert.equal(neighborInbox.some(message => selectedMessageIds.includes(message.msg_id)), false);
    // Falsifier: the same durable receipt cannot prove delivery to the neighbor.
    assert.notDeepEqual((await getMessageById(selectedMessageIds[0]))?.to, [neighbor]);
    assert.deepEqual(pageErrors, [], 'real component must complete without browser errors');
    const receipt = { workspace, selected, neighbor, selectedMessageIds, authMethod: 'cookie-session',
      denialStatus: denied.status, draftRetained: true, retryClearedDraft: true, deepLinkReload: true,
      neighborIsolated: true, positiveControl: 'wrong-recipient rejected', receipts, wakeNote: note,
      browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size,
      scope: 'Actual mounted Portal controls and private HTTP/inbox effects; no whole-Portal or parked-turn acceptance' };
    writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    if (page) {
      try { await retainPortalBrowserFailure(page, evidence, error, pageErrors); }
      catch (diagnosticError) { console.error('PORTAL_BROWSER_FAILURE_CAPTURE_ERROR', diagnosticError); }
    }
    throw error;
  } finally {
    await context.close(); await browser.close();
    await Promise.allSettled([...syncReadCaptures]);
  }
}

/** Actual editor events and native HTTP/PG persistence. Shell dimensions are
 * supplied; hosted tenant authorization and provider calls are separate. */
async function runPrivateBrainstormPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput,
  reads: Array<Record<string, unknown>>, captures: Set<Promise<void>>,
  initialSaves: Promise<Awaited<ReturnType<Page['waitForResponse']>>[]>) {
  const scope = input.brainstormHarnesses!;
  const states: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  const snapshot = async (label: string) => {
    const rows = await getOrgPg().sql`SELECT workspace_id, harness_slug, phase, content, canvas, mindmap
      FROM harness_shared.harness_brainstorm WHERE harness_slug IN (${scope.selected}, ${scope.neighbor}, ${scope.foreign})
      ORDER BY harness_slug, phase`;
    states.push({ label, rows });
    writeFileSync(join(input.evidence, 'portal-brainstorm-states.json'), JSON.stringify(states, null, 2));
    return rows;
  };
  const selectedRow = (rows: Awaited<ReturnType<typeof snapshot>>) => {
    const row = rows.find(row => row.harness_slug === scope.selected && row.phase === 'staging');
    assert.ok(row, 'selected brainstorm staging row must exist'); return row;
  };
  const editor = page.locator('.h-brainstorm-write [contenteditable="true"]').first();
  await editor.getByText('private-brainstorm-selected-text', { exact: true }).waitFor();
  await page.locator('.rf-mind-label').getByText('private-brainstorm-selected-map', { exact: true }).waitFor({ state: 'attached' });
  await page.locator('.excalidraw').waitFor({ state: 'attached' });
  for (const response of await initialSaves) {
    assert.equal(response.status(), 200, 'initial editor save must finish before the isolation baseline');
    const body = response.request().postDataJSON();
    if (new URL(response.url()).pathname.endsWith('/brainstorm-mindmap'))
      assert.equal(body.tree.nodes[0].data.text, 'private-brainstorm-selected-map');
    else assert.deepEqual(body.scene.elements, [], 'initial canvas must retain the selected saved scene');
  }
  const initial = await snapshot('initial-editors-hydrated');
  assert.equal(initial.length, 3, 'foreign exclusion requires an actual foreign row');
  const untouched = initial.filter(row => row.harness_slug !== scope.selected);
  assert.equal(untouched.length, 2);
  const endpoint = (surface: string) => input.base + `/api/harness/${scope.selected}/${surface}`;
  const matchingWrite = (surface: string, marker: string) => retainPortalResponse(page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/harness/${scope.selected}/${surface}`
    && response.request().method() === 'PUT' && (response.request().postData() ?? '').includes(marker)));
  const recordWrite = async (response: Awaited<ReturnType<Page['waitForResponse']>>) => {
    const receipt = { url: response.url(), status: response.status(), request: response.request().postDataJSON(), body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-brainstorm-writes.json'), JSON.stringify(writes, null, 2));
    return receipt;
  };
  const deny = async (surface: string, marker: string) => {
    await context.route(`**/api/harness/${scope.selected}/${surface}`, async route => {
      if (route.request().method() !== 'PUT' || !(route.request().postData() ?? '').includes(marker)) return route.continue();
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://foreign-brainstorm.invalid' } });
      assert.equal(response.status(), 403, 'denial must come from the actual private host');
      await route.fulfill({ response });
    });
  };
  const allow = (surface: string) => context.unroute(`**/api/harness/${scope.selected}/${surface}`);
  const deniedText = `private-brainstorm-denied-text-${process.pid}`;
  await deny('brainstorm', deniedText);
  let response = matchingWrite('brainstorm', deniedText);
  await editor.fill(deniedText);
  assert.equal((await recordWrite(await response)).status, 403);
  await page.locator('.h-brainstorm-savehint').getByText('save failed', { exact: true }).waitFor();
  assert.equal(selectedRow(await snapshot('text-denied')).content, selectedRow(initial).content);
  await allow('brainstorm');
  const savedText = `private-brainstorm-saved-text-${process.pid}`;
  response = matchingWrite('brainstorm', savedText);
  await editor.fill(savedText);
  assert.equal((await recordWrite(await response)).status, 200);
  const textSaved = selectedRow(await snapshot('text-saved'));
  assert.ok(textSaved.content.includes(savedText));
  assert.deepEqual(textSaved.mindmap, selectedRow(initial).mindmap, 'text save must preserve the map');

  const mapTab = page.getByRole('tab', { name: 'map', exact: true });
  await mapTab.focus(); await page.keyboard.press('Enter');
  assert.equal(await mapTab.getAttribute('aria-selected'), 'true');
  assert.equal(new URL(page.url()).searchParams.get('brainstormTab'), 'map');
  const deniedMap = `private-brainstorm-denied-map-${process.pid}`;
  await deny('brainstorm-mindmap', deniedMap);
  response = matchingWrite('brainstorm-mindmap', deniedMap);
  await page.locator('.rf-mind-node').filter({ has: page.getByText('private-brainstorm-selected-map', { exact: true }) }).dblclick();
  await page.locator('.rf-mind-input').fill(deniedMap); await page.locator('.rf-mind-input').press('Enter');
  assert.equal((await recordWrite(await response)).status, 403);
  await page.getByText(/Mindmap save failed:/).waitFor();
  assert.deepEqual(selectedRow(await snapshot('map-denied')).mindmap, textSaved.mindmap);
  await allow('brainstorm-mindmap');
  const savedMap = `private-brainstorm-saved-map-${process.pid}`;
  response = matchingWrite('brainstorm-mindmap', savedMap);
  await page.locator('.rf-mind-node').filter({ has: page.getByText(deniedMap, { exact: true }) }).dblclick();
  await page.locator('.rf-mind-input').fill(savedMap); await page.locator('.rf-mind-input').press('Enter');
  assert.equal((await recordWrite(await response)).status, 200);
  const mapSaved = selectedRow(await snapshot('map-saved'));
  assert.equal(mapSaved.mindmap.nodes[0].data.text, savedMap);
  assert.equal(mapSaved.content, textSaved.content);
  const mapUrl = page.url(); await page.reload();
  await page.locator('.rf-mind-label').getByText(savedMap, { exact: true }).waitFor();
  assert.equal(page.url(), mapUrl);

  const canvasTab = page.getByRole('tab', { name: 'canvas', exact: true });
  await canvasTab.focus(); await page.keyboard.press('Space');
  assert.equal(await canvasTab.getAttribute('aria-selected'), 'true');
  assert.equal(new URL(page.url()).searchParams.get('brainstormTab'), 'canvas');
  const drawRectangle = async (offset: number) => {
    const canvas = page.locator('.excalidraw__canvas.interactive');
    await canvas.waitFor(); const box = await canvas.boundingBox();
    assert.ok(box && box.width > 300 && box.height > 250, 'actual canvas needs usable shell dimensions');
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.keyboard.press('r');
    await page.mouse.move(box.x + box.width / 2 + offset, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + offset + 90, box.y + box.height / 2 + 60, { steps: 4 });
    await page.mouse.up();
  };
  await deny('brainstorm-canvas', '"type":"rectangle"');
  response = matchingWrite('brainstorm-canvas', '"type":"rectangle"');
  await drawRectangle(-120);
  assert.equal((await recordWrite(await response)).status, 403);
  await page.getByText(/Canvas save failed:/).waitFor();
  assert.equal(selectedRow(await snapshot('canvas-denied')).canvas.elements.length, 0);
  await allow('brainstorm-canvas');
  response = matchingWrite('brainstorm-canvas', '"type":"rectangle"');
  await drawRectangle(10);
  assert.equal((await recordWrite(await response)).status, 200);
  const canvasSaved = selectedRow(await snapshot('canvas-saved'));
  assert.equal(canvasSaved.canvas.elements.filter((element: { type: string }) => element.type === 'rectangle').length, 2);
  assert.equal(canvasSaved.content, textSaved.content);
  assert.deepEqual(canvasSaved.mindmap, mapSaved.mindmap);
  const canvasUrl = page.url(); await page.reload();
  await page.locator('.excalidraw__canvas.interactive').waitFor();
  assert.equal(page.url(), canvasUrl);
  assert.equal(await canvasTab.getAttribute('aria-selected'), 'true');
  const writeTab = page.getByRole('tab', { name: 'write', exact: true });
  await writeTab.focus(); await page.keyboard.press('Enter');
  await editor.getByText(savedText, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
  assert.equal(new URL(page.url()).searchParams.get('slug'), scope.selected);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  await Promise.all([...captures]);
  const read = reads.find(read => read.status === 200 && JSON.parse(read.args as string).harnessSlug === scope.selected);
  assert.ok(read, 'editors must hydrate through the actual private Sync query');
  const syncRows = (read.body as { rows: Array<{ harnessSlug: string }> }).rows;
  assert.ok(syncRows.some(row => row.harnessSlug === scope.selected));
  assert.equal(syncRows.some(row => row.harnessSlug === scope.neighbor || row.harnessSlug === scope.foreign), false);
  for (const [surface, field, wrapper] of [['brainstorm', 'content', 'content'], ['brainstorm-canvas', 'canvas', 'scene'],
    ['brainstorm-mindmap', 'mindmap', 'tree']]) {
    const fetched = await context.request.get(endpoint(surface)); assert.equal(fetched.status(), 200);
    assert.deepEqual((await fetched.json())[wrapper], canvasSaved[field], `actual ${surface} GET must agree with PG`);
    const hostDenied = await context.request.put(endpoint(surface), { headers: { host: 'foreign-brainstorm.invalid' },
      data: wrapper === 'content' ? { content: 'host-denied' } : { [wrapper]: { marker: 'host-denied' } } });
    verifyPrivateHudHostDenial(hostDenied.status(), await hostDenied.text());
  }
  const final = await snapshot('final-host-denials');
  assert.deepEqual(final.filter(row => row.harness_slug !== scope.selected), untouched);
  assert.deepEqual(selectedRow(final), canvasSaved, 'denied Host writes must leave the selected row unchanged');
  return { workspace: input.workspace, authMethod: 'private-loopback-brainstorm-with-cookie',
    textSaved: true, mapSaved: true, canvasSaved: true, deniedTextNoWrite: true, deniedMapNoWrite: true,
    deniedCanvasNoWrite: true, denialRetry: true, keyboardLayers: true, mapReload: true, canvasReload: true,
    textReload: true, shellQueryPreserved: true, neighborUnchanged: true, foreignUnchanged: true,
    selectedSyncRead: true, apiPgAgreement: true, hostDenials: 3, providerUsed: false };
}

async function runPrivateHarnessesPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput,
  reads: Array<Record<string, unknown>>, pendingReads: Set<Promise<void>>) {
  const work = input.harnesses!;
  const all = page.getByTestId('pot-workspace-cards');
  await all.waitFor();
  const selectedRow = all.getByTestId(`hive-member-${work.selected}`);
  await selectedRow.waitFor();
  await all.getByTestId(`hive-member-${work.neighbor}`).waitFor();
  assert.equal(await all.getByTestId(`hive-card-${work.foreign}`).count(), 0,
    'actual workspace registry must exclude the foreign workspace hive');
  await Promise.allSettled([...pendingReads]);
  const registry = reads.find(value => value.status === 200 && String(value.name).startsWith('harnessProjects.lite'));
  assert.ok(registry, 'Work must read the actual private registry endpoint');
  const registryRows = (registry.body as { rows: Array<{ slug: string }> }).rows;
  assert.ok(registryRows.some(row => row.slug === work.hive));
  assert.ok(registryRows.some(row => row.slug === work.selected));
  assert.equal(registryRows.some(row => row.slug === work.foreign), false);
  const foreignResponse = await context.request.get(String(registry.url), {
    headers: { 'x-papercusp-workspace': input.workspace + '-foreign' },
  });
  assert.equal(foreignResponse.status(), 200);
  const foreignRows = (await foreignResponse.json()).rows as Array<{ slug: string }>;
  assert.ok(foreignRows.some(row => row.slug === work.foreign), 'foreign exclusion needs an actual foreign-registry positive control');
  assert.equal(foreignRows.some(row => row.slug === work.selected), false);
  await selectedRow.focus();
  await page.keyboard.press('Enter');
  const selectedButton = page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.selected}`);
  await selectedButton.waitFor();
  await page.waitForFunction(slug => document.querySelector(`[data-testid="hive-member-${slug}"]`)?.getAttribute('aria-current') === 'true', work.selected);
  const assertSelection = (slug: string) => {
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('slug'), work.hive);
    assert.equal(params.get('harness'), slug);
    assert.equal(params.get('scope') ?? 'expanded', 'expanded');
    assert.equal(params.get('ws'), input.workspace);
    assert.equal(params.get('q'), 'retained-shell-search');
  };
  assertSelection(work.selected);
  const dockRead = (slug: string) => page.waitForResponse(response => {
    const request = new URL(response.url());
    if (response.status() !== 200 || !request.searchParams.get('name')?.startsWith('workItems.byHarness')) return false;
    const args = JSON.parse(request.searchParams.get('args') ?? '{}');
    return args.harnessSlug === slug;
  });
  // A rail highlight alone does not prove the dock resolved the intended member.
  const selectedRead = dockRead(work.selected);
  await page.reload();
  await selectedRead;
  await page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.selected}`).waitFor();
  assertSelection(work.selected);
  const neighborRead = dockRead(work.neighbor);
  const neighborButton = page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.neighbor}`);
  await neighborButton.focus();
  await page.keyboard.press('Space');
  await neighborRead;
  await page.waitForFunction(slug => document.querySelector(`[data-testid="hive-member-${slug}"]`)?.getAttribute('aria-current') === 'true', work.neighbor);
  assertSelection(work.neighbor);
  const denied = await context.request.get(String(registry.url), { headers: { host: 'foreign-work.invalid',
    cookie: `${input.cookieName}=${input.ownToken}` } });
  verifyPrivateHudHostDenial(denied.status(), await denied.text());
  assertSelection(work.neighbor);
  const reloadRead = dockRead(work.neighbor);
  await page.reload();
  await reloadRead;
  await page.getByTestId('pot-member-rail').getByTestId(`hive-member-${work.neighbor}`).waitFor();
  assertSelection(work.neighbor);
  await Promise.allSettled([...pendingReads]);
  return { workspace: input.workspace, authMethod: 'private-loopback-work-with-cookie', ...work,
    keyboardDrill: true, keyboardMemberSelection: true, deepLinkReload: true, dockQueryRekeyed: true,
    shellQueryPreserved: true, foreignExcluded: true, foreignRegistryControl: true,
    denialStatus: denied.status(), denialTransport: 'actual-private-work-external-host', selectionRetained: true,
    scope: 'Actual mounted HarnessesWorkspace and private workspace registry/dock reads; no hosted tenant, full-shell, work-item action or shipment acceptance' };
}

/** Actual Health reads and ack/unack; initial seeded readings are not collector proof. */
async function runPrivateHealthPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput,
  reads: Array<Record<string, unknown>>, pendingReads: Set<Promise<void>>) {
  const card = page.locator('[data-panel="workItems"]');
  await card.getByText('private-health-selected', { exact: true }).waitFor();
  await page.locator('[data-panel="plans"]').getByText('private-health-neighbor', { exact: true }).waitFor();
  assert.equal(await page.getByText('private-health-foreign', { exact: true }).count(), 0);
  const expand = card.getByRole('button', { name: 'Work items', exact: true });
  await expand.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(url => url.searchParams.get('healthPanel') === 'workItems');
  assert.equal(await expand.getAttribute('aria-expanded'), 'true');
  await card.getByText('private-health-transition', { exact: true }).waitFor();
  const selectedUrl = page.url();
  await page.reload();
  await card.getByRole('button', { name: 'Work items', exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Work items', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.equal(page.url(), selectedUrl);
  await Promise.all([...pendingReads]);
  const snapshot = reads.find(read => read.name === 'health.snapshot' && read.status === 200);
  assert.ok(snapshot, 'Health must read the actual private sync endpoint');
  assert.equal(snapshot.requestWorkspace, input.workspace,
    'standalone Health browser must send its selected workspace to the resolver request scope');
  const row = (snapshot.body as { rows: Array<{ workspaceId: string }> }).rows[0];
  assert.equal(row.workspaceId, input.workspace, 'snapshot must belong to the private runtime workspace');
  assert.ok(reads.some(read => read.name === 'health.history' && read.status === 200));
  const states: unknown[] = [];
  const assertUnchanged = async () => {
    const rows = await getOrgPg().sql`SELECT workspace_id, panel, reason FROM harness_shared.system_health_acks
      WHERE workspace_id IN (${input.workspace}, ${input.workspace + '-foreign'}) ORDER BY workspace_id, panel`;
    states.push(rows);
    writeFileSync(join(input.evidence, 'portal-health-ack-states.json'), JSON.stringify(states, null, 2));
    assert.equal(rows.length, 0, 'denied or cancelled acknowledgement must not write either workspace');
  };
  await assertUnchanged();
  await card.getByRole('button', { name: 'acknowledge…', exact: true }).click();
  const reason = card.getByPlaceholder('why is this accepted?');
  await reason.fill('ab');
  const submit = card.getByRole('button', { name: 'acknowledge', exact: true });
  assert.equal(await submit.isEnabled(), false, 'reason validation must prevent a too-short request');
  await reason.fill('private-health-accepted-reason');
  await context.route('**/api/agent-tools/health/ack', async route => {
    const denied = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://foreign-health.invalid' } });
    assert.equal(denied.status(), 403);
    await route.fulfill({ response: denied });
  });
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-tools/health/ack');
  await submit.focus(); await page.keyboard.press('Enter');
  const denied = await responsePromise;
  assert.equal(denied.status(), 403);
  assert.equal(denied.request().postDataJSON().panel, 'workItems');
  await card.locator('.pc-hcard__note').waitFor();
  assert.equal(await submit.isEnabled(), true, 'denied request must restore the control');
  await assertUnchanged();
  await context.unroute('**/api/agent-tools/health/ack');
  await card.getByRole('button', { name: 'cancel', exact: true }).click();
  assert.equal(await reason.count(), 0);
  await assertUnchanged();
  const writes: Array<{ status: number; panel: string; body: unknown }> = [];
  const act = async (mode: 'ack' | 'unack', control: ReturnType<Page['getByRole']>) => {
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-tools/health/' + mode,
      { timeout: 90_000 });
    await control.focus(); await page.keyboard.press('Enter');
    const response = await responsePromise;
    const panel = response.request().postDataJSON().panel;
    writes.push({ status: response.status(), panel, body: await response.json() });
    writeFileSync(join(input.evidence, 'portal-health-writes.json'), JSON.stringify(writes, null, 2));
    assert.equal(response.status(), 200);
    assert.equal(panel, 'workItems');
  };
  await card.getByRole('button', { name: 'acknowledge…', exact: true }).click();
  await reason.fill('private-health-accepted-reason');
  await act('ack', card.getByRole('button', { name: 'acknowledge', exact: true }));
  await card.locator('.pc-hcard__ack').filter({ hasText: 'private-health-accepted-reason' }).waitFor({ timeout: 90_000 });
  const ackRows = await getOrgPg().sql`SELECT workspace_id, panel, status, reason FROM harness_shared.system_health_acks
    WHERE workspace_id IN (${input.workspace}, ${input.workspace + '-foreign'}) ORDER BY workspace_id, panel`;
  states.push(ackRows);
  assert.equal(ackRows.length, 1, 'successful ack must write only the selected workspace and panel');
  assert.equal(ackRows[0].workspace_id, input.workspace);
  assert.equal(ackRows[0].panel, 'workItems');
  assert.equal(ackRows[0].status, 'warn');
  assert.equal(ackRows[0].reason, 'private-health-accepted-reason');
  await page.reload();
  await card.locator('.pc-hcard__ack').filter({ hasText: 'private-health-accepted-reason' }).waitFor();
  assert.equal(page.url(), selectedUrl);
  await Promise.all([...pendingReads]);
  const collectorReading = [...reads].reverse().find(read => read.name === 'health.snapshot' && read.status === 200
    && (read.body as { rows?: Array<{ panels?: { workItems?: { data?: { needsHuman?: number } } } }> }).rows?.[0]?.panels?.workItems?.data?.needsHuman === 1);
  assert.ok(collectorReading, 'positive ack must use the real Work-items collector with the single private needs-human condition');
  await act('unack', card.getByRole('button', { name: 'un-acknowledge', exact: true }));
  await card.locator('.pc-hcard__ack').waitFor({ state: 'hidden', timeout: 90_000 });
  await assertUnchanged();
  await page.reload();
  await card.getByRole('button', { name: 'acknowledge…', exact: true }).waitFor();
  assert.equal(await card.locator('.pc-hcard__ack').count(), 0);
  assert.equal(page.url(), selectedUrl);
  const hostDenied = await context.request.get(input.base + '/api/zero-harness/rest-query?name=health.snapshot&args=%7B%7D',
    { headers: { host: 'foreign-health.invalid' } });
  verifyPrivateHudHostDenial(hostDenied.status(), await hostDenied.text());
  const hosted = await verifyPrivateHostedHealthPage(page, input);
  const link = card.getByRole('link', { name: 'Open Work', exact: true });
  await link.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(url => url.searchParams.get('app') === 'work');
  assert.equal(new URL(page.url()).searchParams.get('tab'), null);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
  assert.equal(new URL(page.url()).searchParams.get('healthPanel'), 'workItems');
  await page.reload();
  await page.getByTestId('health-destination').filter({ hasText: /^work$/ }).waitFor();
  return { workspace: input.workspace, authMethod: 'private-loopback-health-with-cookie',
    snapshotRead: true, historyRead: true, keyboardExpansion: true, keyboardDrill: true, deepLinkReload: true,
    shellQueryPreserved: true, foreignSeedExcluded: true, denialStatus: 403, deniedAckNoWrite: true,
    denialControlRecovery: true, cancelledAckNoWrite: true, reasonValidation: true,
    acknowledged: true, unacknowledged: true, ackReload: true, unackReload: true, workItemsCollectorNeedsHuman: 1,
    hosted,
    scope: 'Actual HealthTab, private shared snapshot/history reads, native Host denial, Origin-denied acknowledgement and successful ack/unack through the maintained Work-items collector; real hosted ledger, health attestation producer and infra collector populate failure/recovery and owned-cost metrics. Initial acknowledgement snapshot/history and destination geometry are supplied; hosted tenant authorization and shipment remain unmeasured' };
}

/** A request worker may retain the previous snapshot until its next shared read.
 * Observe convergence through the actual query; a successful HTTP response alone
 * does not witness the generation just published by the collector. */
export async function waitForPrivateHealthSnapshot<T extends { workspaceId: string }>(
  read: () => Promise<{ rows: T[] }>, workspaceId: string, matches: (row: T) => boolean,
  options: { timeoutMs?: number; now?: () => number; pause?: (ms: number) => Promise<void>;
    observe?: (body: { rows: T[] }) => void | Promise<void> } = {},
): Promise<{ rows: T[] }> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 45_000);
  let last: { rows: T[] };
  do {
    last = await read();
    // Retain mismatched generations before the deadline assertion can fail.
    await options.observe?.(last);
    if (last.rows.length === 1 && last.rows[0].workspaceId === workspaceId && matches(last.rows[0])) return last;
    if (now() >= deadline) break;
    await pause(Math.min(1_000, deadline - now()));
  } while (now() <= deadline);
  assert.fail('private Health query did not converge to the selected workspace collector reading: ' + JSON.stringify(last!));
}

/** Use the existing ledger and whole-health collector, then observe their actual
 * shared-query and DOM output. The initial acknowledgement fixture is not proof
 * of these collectors. All rows here live in the verifier-owned disposable PG. */
async function verifyPrivateHostedHealthPage(page: Page, input: PortalRosterBrowserInput) {
  const { upsertWorkspaceHost, recordWorkspaceHostHealth, readWorkspaceHostReliability } =
    await import('../lib/workspace-host/observability-store');
  const { computeSystemHealth } = await import('../lib/system-health/compute');
  const { writeSharedSnapshot, readSharedSnapshot } = await import('../lib/derived-reads/shared-snapshot');
  const { recordHealthHistory } = await import('../lib/system-health/history');
  const { sql } = getOrgPg();
  const now = Date.now();
  const hostId = 'private-cloud-health-host';
  for (const workspaceId of [input.workspace, input.workspace + '-foreign']) {
    const platform = workspaceId === input.workspace;
    await sql`INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
      VALUES (${workspaceId}, 'private-cloud-health-connection', 'gcp', 'private-health', 'cloudCredentialRef:test', 'degraded')`;
    await upsertWorkspaceHost({ workspaceId, id: hostId, name: hostId,
      connectionId: 'private-cloud-health-connection', target: 'gcp', scopeLabel: 'private-health',
      region: 'us-central1', size: 'e2-standard-4', image: 'private-health', diskGiB: 64, network: 'default',
      desiredState: 'running', observedState: 'running',
      controllerAuthority: { controllerId: 'private-cloud-health', fence: 1 } });
    await recordWorkspaceHostHealth(workspaceId, { hostId, status: 'unreachable',
      observedAt: new Date(now).toISOString(), checks: [] });
    await sql`INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state,
       created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id,
       monthly_lifecycle_budget_cents, lifecycle_budget_period_started_at)
      VALUES (${workspaceId}, 'private-cloud-health-customer', 'private-health-org', ${hostId},
        'private customer content must stay absent', 'active', 'hosted-user', 'private-health-user',
        ${platform ? 'platform' : 'organization'}, 'private-health-billing', 1000, ${new Date(now - 60_000)})`;
    await sql`INSERT INTO harness_shared.workspace_host_operations
      (workspace_id, id, host_id, action, status, created_at, finished_at, customer_workspace_id,
       organization_id, provider_target, billing_owner_kind, billing_owner_id, estimated_cost_cents,
       cost_currency, cost_estimate_source, cost_estimate_ref, cost_estimated_at)
      VALUES (${workspaceId}, 'private-cloud-health-ready', ${hostId}, 'provision', 'succeeded',
        ${new Date(now - 1000)}, ${new Date(now - 750)}, 'private-cloud-health-customer',
        'private-health-org', 'gcp', ${platform ? 'platform' : 'organization'}, 'private-health-billing',
        ${platform ? 2400 : 99999}, 'USD', 'private-controlled-estimate', 'private-estimate', ${new Date(now)})`;
    await sql`INSERT INTO harness_shared.route_invocations (workspace_id, method, path, status, duration_ms, invoked_at)
      VALUES (${workspaceId}, 'GET', '/api/hosted/workspaces/:id', 'ok', 25, ${new Date(now)}),
        (${workspaceId}, 'GET', '/api/hosted/workspaces/:id', 'timeout', 500, ${new Date(now)}),
        (${workspaceId}, 'INTERNAL', 'internal:private-cloud-health', 'error', 9000, ${new Date(now)})`;
  }
  const foreign = await readWorkspaceHostReliability(input.workspace + '-foreign', now);
  assert.equal(foreign.ownedCost?.estimatedUsdCents, null, 'customer-funded spend must not become platform spend');
  const snapshots: Awaited<ReturnType<typeof computeSystemHealth>>[] = [];
  const observations: unknown[] = [];
  const publishAndObserve = async (unhealthy: number) => {
    const snapshot = await computeSystemHealth(input.workspace);
    const hosted = snapshot.panels.infra.data?.hostedControlPlane;
    assert.deepEqual(hosted?.hosts, { expectedRunning: 1, unhealthy, unobserved: 0, platformOwnedRunning: 1 });
    assert.deepEqual(hosted?.lifecycle, { succeeded: 1, failed: 0, queued: 0, running: 0, successP95Ms: 250 });
    assert.deepEqual(hosted?.api, { samples: 2, errors: 1, p95Ms: 25 });
    assert.deepEqual(hosted?.ownedCost, { estimatedUsdCents: 2400, estimates: 1, unpriced: 0, breachedBudgets: 1 });
    assert.equal(JSON.stringify(hosted).includes('private customer content'), false);
    const previous = snapshots.at(-1) ?? snapshot;
    snapshots.push(snapshot);
    await writeSharedSnapshot('system.health', input.workspace, snapshot, 1);
    await recordHealthHistory(previous, snapshot);
    const body = await waitForPrivateHealthSnapshot<Awaited<ReturnType<typeof computeSystemHealth>>>(
      () => reloadPrivateHealthSnapshot(page), input.workspace,
      row => isDeepStrictEqual(row.panels.infra.data?.hostedControlPlane, hosted), {
        observe: async query => {
          const shared = await readSharedSnapshot<Awaited<ReturnType<typeof computeSystemHealth>>>(
            'system.health', input.workspace, 1, 300_000);
          observations.push({ at: Date.now(), expected: hosted,
            shared: shared && { computedAt: shared.computedAt, ageMs: shared.ageMs,
              workspaceId: shared.payload.workspaceId, evaluatedAt: shared.payload.evaluatedAt,
              hosted: shared.payload.panels.infra.data?.hostedControlPlane },
            query: query.rows.map(row => ({ workspaceId: row.workspaceId, evaluatedAt: row.evaluatedAt,
              hosted: row.panels.infra.data?.hostedControlPlane })) });
          writeFileSync(join(input.evidence, 'portal-cloud-health-observations.json'), JSON.stringify({
            snapshots, observations,
            scope: 'Collector publication and actual HTTP generations, retained before convergence or DOM assertions',
          }, null, 2));
        },
      });
    assert.deepEqual(body.rows[0].panels.infra.data?.hostedControlPlane, hosted,
      'actual workspace-scoped HTTP query must return the collector reading');
    const infra = page.locator('[data-panel="infra"]');
    const metric = (label: string) => infra.locator('.pc-hcard__m').filter({ has: page.locator('span', { hasText: label }) }).locator('b');
    const expectMetric = async (label: string, value: string) => {
      await metric(label).waitFor();
      assert.equal(await metric(label).textContent(), value, label);
    };
    await expectMetric('hosted running / unhealthy / unobserved', `1 / ${unhealthy} / 0`);
    await expectMetric('Papercusp-owned running hosts', '1');
    await expectMetric('sampled hosted API errors / samples (1h)', '1 / 2');
    await expectMetric('provision / restore p95 ms (admission to success)', '250');
    await expectMetric('Papercusp-funded lifecycle estimates USD (current budget periods)', '$24.00 (estimated)');
    await expectMetric('provider infrastructure invoices', 'unknown — account access not granted');
    assert.equal((await infra.textContent())?.includes('$999.99'), false, 'foreign customer cost must stay out of this view');
    writeFileSync(join(input.evidence, 'portal-cloud-health-observations.json'), JSON.stringify({
      snapshots, observations, query: body, rendered: await infra.textContent(), foreignCustomerCost: foreign.ownedCost,
      scope: 'Controlled real PG records and actual health producer/collector/query/HealthTab; no provider invoice access or shipment claim',
    }, null, 2));
  };
  await publishAndObserve(1);
  await recordWorkspaceHostHealth(input.workspace, { hostId, status: 'healthy',
    observedAt: new Date().toISOString(), checks: [] });
  await sql`UPDATE harness_shared.workspace_host_connections SET status = 'connected'
    WHERE workspace_id = ${input.workspace} AND id = 'private-cloud-health-connection'`;
  await publishAndObserve(0);
  return { healthProducer: true, infraCollector: true, actualQuery: true, populatedView: true,
    failureRecovery: true, sampledApi: true, estimatedPlatformCost: true, customerCostExcluded: true, invoiceUnknown: true };
}

/** Named slug lookup may cross workspaces; domain/file reads must stay on the
 * exact requested pot. Check the actual receipts, including foreign-domain
 * misses, instead of treating a deliberate registry fallback as a denial. */
export function verifyPrivateTestingReadScopes(
  reads: readonly { url: string; status: number; body: string }[],
  pots: { selected: string; neighbor: string; foreign: string },
) {
  const matching = (slug: string, endpoint: string, domainId?: string) => reads.filter(read => {
    const url = new URL(read.url);
    return url.pathname === `/api/harness/${slug}/testing/${endpoint}`
      && (domainId === undefined || url.searchParams.get('domainId') === domainId);
  });
  for (const role of ['selected', 'neighbor'] as const) {
    const id = `private-${role}-tests`;
    const registries = matching(pots[role], 'domains').filter(read => read.status === 200);
    assert.ok(registries.length, 'each pot requires its actual successful registry response');
    for (const read of registries) assert.deepEqual(JSON.parse(read.body).domains.map((domain: { id: string }) => domain.id),
      [id], 'registry must expose only the requested pot domain');
    const details = matching(pots[role], 'domain-detail', id).filter(read => read.status === 200);
    assert.ok(details.length, 'each pot requires an actual successful scoped domain-detail response');
    for (const read of details) {
      const detail = JSON.parse(read.body);
      assert.equal(detail.id, id, 'domain detail must identify the requested pot domain');
      assert.equal(detail.totalFiles, 1);
      assert.deepEqual(detail.sections.flatMap((section: { files: Array<{ path: string }> }) => section.files.map(value => value.path)),
        [`${role}/${role}.test.ts`], 'domain detail must exclude neighbor and foreign files');
    }
    const misses = matching(pots[role], 'domain-detail', 'private-foreign-tests');
    assert.ok(misses.length, 'each pot requires an actual foreign-domain rejection');
    for (const read of misses) {
      assert.equal(read.status, 404, 'foreign domain must not resolve in the requested pot');
      assert.equal(JSON.parse(read.body).error, 'unknown_domain', 'foreign-domain rejection must have the intended cause');
    }
  }
  const foreign = matching(pots.foreign, 'domains');
  assert.ok(foreign.length, 'named foreign slug lookup must be observed separately');
  for (const read of foreign) {
    assert.equal(read.status, 200, 'named slug resolution intentionally crosses workspace registries');
    assert.deepEqual(JSON.parse(read.body).domains.map((domain: { id: string }) => domain.id), ['private-foreign-tests']);
  }
}

/** Actual Testing controls plus exact private registry and file receipts. */
async function runPrivateTestingPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput, url: URL) {
  const pots = input.testingHarnesses;
  assert.ok(pots, 'Testing journey requires exact private harness identities');
  const selectedId = 'private-selected-tests';
  const neighborId = 'private-neighbor-tests';
  const reads: Array<{ url: string; status: number; body: string }> = [];
  const captures = new Set<Promise<void>>();
  const writes: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/testing/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    if (!response.url().includes('/testing/')) return;
    const capture = response.text().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      // Keep the observed HTTP evidence even when the next UI assertion fails.
      writeFileSync(join(input.evidence, 'portal-testing-reads.json'), JSON.stringify(reads, null, 2));
    });
    captures.add(capture); void capture.catch(() => {});
    void capture.then(() => captures.delete(capture), () => captures.delete(capture));
  });
  const denials: Array<{ url: string; status: number; body: string }> = [];
  let denyNeighbor = true;
  const deniedPath = `/api/harness/${encodeURIComponent(pots.neighbor)}/testing/domains`;
  await page.route('**' + deniedPath + '?*', async route => {
    if (!denyNeighbor) return route.continue();
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-testing.invalid' } });
    const body = await upstream.text();
    // Save the actual refusal before either validation or UI assertions.
    denials.push({ url: route.request().url(), status: upstream.status(), body });
    writeFileSync(join(input.evidence, 'portal-testing-denials.json'), JSON.stringify(denials, null, 2));
    verifyPrivateHudHostDenial(upstream.status(), body);
    await route.fulfill({ response: upstream, body });
  });
  url.searchParams.set('slug', pots.selected);
  url.searchParams.set('nextPot', pots.neighbor);
  url.searchParams.set('testsTab', selectedId);
  const domain = page.locator('.pc-dtp');
  const nav = page.getByRole('navigation', { name: 'Tests tabs' });
  await page.goto(url.href);
  await nav.getByRole('button', { name: 'Selected private tests', exact: false }).waitFor();
  await domain.getByRole('heading', { name: 'Selected private tests', exact: true }).waitFor();
  assert.ok((await domain.innerText()).includes('selected/selected.test.ts'), 'selected registry must glob its own worktree');
  assert.ok(!(await domain.innerText()).includes('neighbor/neighbor.test.ts'), 'selected file population excludes neighbor');
  const changedPotDenial = retainPortalResponse(page.waitForResponse(response =>
    new URL(response.url()).pathname === deniedPath && response.status() === 403));
  await page.getByTestId('testing-switch-pot').focus(); await page.keyboard.press('Enter');
  await changedPotDenial;
  await page.waitForFunction(() => !document.querySelector('.pc-test-left')?.textContent?.includes('Selected private tests'));
  assert.ok(!(await nav.innerText()).includes('Selected private tier'), 'denied changed-pot read must discard old tier labels');
  assert.equal(await nav.getByRole('button', { name: 'Neighbor private tests', exact: false }).count(), 0);
  denyNeighbor = false;
  const neighborUrl = new URL(page.url()); neighborUrl.searchParams.set('testsTab', neighborId);
  await page.goto(neighborUrl.href);
  const neighborButton = nav.getByRole('button', { name: 'Neighbor private tests', exact: false });
  await neighborButton.waitFor(); await neighborButton.focus(); await page.keyboard.press('Enter');
  await domain.getByRole('heading', { name: 'Neighbor private tests', exact: true }).waitFor();
  assert.ok((await domain.innerText()).includes('neighbor/neighbor.test.ts'));
  assert.ok(!(await domain.innerText()).includes('selected/selected.test.ts'));
  await page.reload();
  await domain.getByRole('heading', { name: 'Neighbor private tests', exact: true }).waitFor();
  const after = new URL(page.url());
  assert.equal(after.searchParams.get('slug'), pots.neighbor);
  assert.equal(after.searchParams.get('testsTab'), neighborId);
  assert.equal(after.searchParams.get('q'), 'retained-shell-search');
  assert.equal(after.searchParams.get('ws'), input.workspace);
  const probePaths = [`/api/harness/${encodeURIComponent(pots.foreign)}/testing/domains?phase=staging`,
    ...[pots.selected, pots.neighbor].map(slug =>
      `/api/harness/${encodeURIComponent(slug)}/testing/domain-detail?phase=staging&domainId=private-foreign-tests`)];
  for (const path of probePaths) {
    const response = await context.request.get(new URL(path, input.base).href);
    reads.push({ url: response.url(), status: response.status(), body: await response.text() });
    writeFileSync(join(input.evidence, 'portal-testing-reads.json'), JSON.stringify(reads, null, 2));
  }
  await Promise.all([...captures]);
  verifyPrivateTestingReadScopes(reads, pots);
  assert.ok(denials.length > 0, 'changed-pot denial must come from the actual host');
  assert.deepEqual(writes, [], 'registry/file acceptance must execute no test runners or mutations');
  const receipt = { workspace: input.workspace, pots, authMethod: 'private-loopback-testing-with-cookie',
    scopedFiles: true, keyboardNavigation: true, deepLinkReload: true, oldRegistryDiscarded: true,
    deniedRegistryRecovery: true, foreignExcluded: true, shellQueryPreserved: true, writes, denials, reads,
    namedSlugResolution: 'cross-workspace',
    scope: 'Actual ADV Testing wrapper and shared TestingShell with pot-specific registry/worktree reads and foreign-domain rejection. Named slug resolution deliberately crosses workspace registries. Outer pot-switch control is fixture geometry; no runner execution, hosted tenant authorization, provider or shipment acceptance' };
  writeFileSync(join(input.evidence, 'portal-testing-read-receipt.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

export function privateDocsNavButton(page: Page, docPath: string) {
  const slash = docPath.lastIndexOf('/');
  const dir = slash < 0 ? '/' : docPath.slice(0, slash);
  const name = docPath.slice(slash + 1).replace(/\.(md|mdx)$/, '');
  const directory = page.getByText(dir, { exact: true }).and(page.locator('.pc-adv-docs__navdir'));
  return page.locator('.pc-adv-docs__navgroup').filter({ has: directory })
    .getByRole('button', { name, exact: true });
}

/** Actual ADV panel, merged docs read and anchored manual verification. */
async function runPrivateDocsPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const docs = input.docs!;
  const endpoint = `/api/harness/${encodeURIComponent(docs.harness)}/docs`;
  const article = page.locator('.pc-adv-docs__article');
  const writes: Array<{ status: number; target: string; body: any }> = [];
  const readDenials: Array<{ control: string; url: string; status: number; body: string }> = [];
  let deniedRead: 'cold-read' | 'warm-refresh' | null = 'cold-read';
  const readRoute = (url: URL) => url.pathname === endpoint;
  const states: unknown[] = [];
  const assertState = async (verifiedSha: string | null) => {
    const rows = await getOrgPg().sql<{ doc_id: string; status: string; last_verified_sha: string | null }[]>`
      SELECT doc_id, status, last_verified_sha FROM harness_shared.harness_docs
      WHERE workspace_id = ${input.workspace} AND harness_slug = ${docs.harness}
        AND doc_id IN (${docs.selectedDoc}, ${docs.neighborDoc})`;
    states.push({ verifiedSha, rows });
    writeFileSync(join(input.evidence, 'portal-docs-states.json'), JSON.stringify(states, null, 2));
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.doc_id === docs.selectedDoc)!.last_verified_sha, verifiedSha);
    assert.equal(rows.find(row => row.doc_id === docs.selectedDoc)!.status, verifiedSha ? 'fresh' : 'review');
    assert.equal(rows.find(row => row.doc_id === docs.neighborDoc)!.last_verified_sha, null);
    assert.equal(rows.find(row => row.doc_id === docs.neighborDoc)!.status, 'review');
  };
  await page.getByRole('region', { name: 'ADV Docs workspace' }).waitFor();
  await article.getByRole('heading', { name: docs.neighborHeading, exact: true }).waitFor();
  await assertState(null);
  // Reload starts a new browser realm with no Docs cache. Forward the real
  // private Host refusal, retaining every response before any assertion.
  await context.route(readRoute, async route => {
    const control = deniedRead;
    if (!control) return route.continue();
    const response = await route.fetch({ headers: { ...route.request().headers(), host: 'foreign-docs.invalid' } });
    const body = await response.text();
    readDenials.push({ control, url: route.request().url(), status: response.status(), body });
    writeFileSync(join(input.evidence, 'portal-docs-read-denials.json'), JSON.stringify(readDenials, null, 2));
    verifyPrivateHudHostDenial(response.status(), body);
    await route.fulfill({ response });
  });
  const coldUrl = page.url();
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Could not load docs: HTTP 403' }).waitFor();
  assert.equal(page.url(), coldUrl);
  await assertState(null);
  deniedRead = null;
  await page.getByRole('button', { name: 'Retry', exact: true }).focus(); await page.keyboard.press('Enter');
  await article.getByRole('heading', { name: docs.neighborHeading, exact: true }).waitFor();
  assert.equal(page.url(), coldUrl);
  assert.equal(await page.getByRole('alert').count(), 0);
  const select = privateDocsNavButton(page, docs.selectedDoc);
  await select.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(url => url.searchParams.get('docpath') === docs.selectedDoc);
  await article.getByRole('heading', { name: docs.selectedHeading, exact: true }).waitFor();
  assert.equal(await select.getAttribute('aria-current'), 'page');
  const selectedUrl = page.url();
  assert.equal(new URL(selectedUrl).searchParams.get('q'), 'retained-shell-search');
  await privateDocsNavButton(page, docs.neighborDoc).focus(); await page.keyboard.press('Enter');
  await article.getByRole('heading', { name: docs.neighborHeading, exact: true }).waitFor();
  deniedRead = 'warm-refresh';
  await select.focus(); await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Could not refresh docs: HTTP 403' }).waitFor();
  await article.getByRole('heading', { name: docs.selectedHeading, exact: true }).waitFor();
  assert.equal(page.url(), selectedUrl);
  await assertState(null);
  deniedRead = null;
  await page.getByRole('button', { name: 'Retry', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('alert').waitFor({ state: 'detached' });
  await article.getByRole('heading', { name: docs.selectedHeading, exact: true }).waitFor();
  assert.equal(page.url(), selectedUrl);
  await context.unroute(readRoute);
  for (const control of ['cold-read', 'warm-refresh']) {
    const denials = readDenials.filter(row => row.control === control);
    assert.ok(denials.length > 0, `Docs must retain the actual ${control} refusal`);
    for (const denial of denials) verifyPrivateHudHostDenial(denial.status, denial.body);
  }
  await page.reload();
  await article.getByRole('heading', { name: docs.selectedHeading, exact: true }).waitFor();
  assert.equal(page.url(), selectedUrl);
  await assertState(null);
  const verify = page.getByRole('button', { name: 'Re-verify', exact: true });
  const submit = async (status: number) => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + '/verify'
      && response.request().method() === 'POST');
    await verify.focus(); await page.keyboard.press('Enter');
    const response = await pending;
    const target = response.request().postDataJSON().docId;
    const receipt = { status: response.status(), target, body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-docs-writes.json'), JSON.stringify(writes, null, 2));
    assert.equal(receipt.status, status, JSON.stringify(receipt.body));
    assert.equal(target, docs.selectedDoc);
    return receipt;
  };
  // Forward the actual Origin-gate response; never synthesize a denial body.
  await context.route('**' + endpoint + '/verify', async route => {
    const denied = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://foreign-docs.invalid' } });
    assert.equal(denied.status(), 403);
    await route.fulfill({ response: denied });
  });
  await submit(403);
  await article.getByRole('alert').filter({ hasText: `Could not re-verify ${docs.selectedDoc}: HTTP 403` }).waitFor();
  await article.getByRole('heading', { name: docs.selectedHeading, exact: true }).waitFor();
  await verify.waitFor(); assert.equal(await verify.isEnabled(), true);
  assert.equal(page.url(), selectedUrl);
  await assertState(null);
  await context.unroute('**' + endpoint + '/verify');
  const accepted = await submit(200);
  assert.equal(accepted.body.ok, true);
  assert.match(accepted.body.verifiedSha, /^[a-f0-9]{40}$/);
  await verify.waitFor({ state: 'detached' });
  assert.equal(await article.getByRole('alert').count(), 0);
  await assertState(accepted.body.verifiedSha);
  await page.reload();
  await article.getByRole('heading', { name: docs.selectedHeading, exact: true }).waitFor();
  assert.equal(page.url(), selectedUrl);
  assert.equal(await verify.count(), 0);
  const merged = await page.request.get(input.base + endpoint + '?path=' + encodeURIComponent(docs.selectedDoc) + '&recompute=1');
  assert.equal(merged.status(), 200);
  const body = await merged.json();
  assert.equal(body.activePath, docs.selectedDoc);
  assert.equal(body.activeEntry.source, 'manual');
  assert.equal(body.activeEntry.status, 'fresh');
  assert.equal(body.activeEntry.lastVerifiedSha, accepted.body.verifiedSha);
  writeFileSync(join(input.evidence, 'portal-docs-merged.json'), JSON.stringify(body, null, 2));
  writeFileSync(join(input.evidence, 'portal-docs-dom.html'), await page.content());
  return { workspace: input.workspace, authMethod: 'private-loopback-docs-with-cookie', harness: docs.harness,
    selectedDoc: docs.selectedDoc, neighborDoc: docs.neighborDoc, keyboardSelection: true, deepLinkReload: true,
    shellQueryPreserved: true, denialStatus: 403, articleRetained: true, deniedWriteIsolated: true,
    retryPersisted: true, neighborIsolated: true, verifiedSha: accepted.body.verifiedSha, writes,
    coldReadRetry: true, warmReadRetry: true, cachedArticleRetained: true, deniedReadNoWrite: true,
    readDenialControls: ['cold-read', 'warm-refresh'], readDenials,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual maintained ADV Docs panel and private merged-read/manual-verify API/PG effects, cold realm read recovery and selected-doc cached revalidation recovery; canonical repo read only, no whole Portal, hosted authorization, provider, cross-tab warm-remount or shipment acceptance' };
}

/** Actual workspace prompts outline and its production sync/write clients. */
async function runPrivatePromptsTab(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const endpoint = '/api/agent-mcp/saved-prompts';
  const marker = `private-prompt-${process.pid}`;
  const body = `Saved private prompt body ${process.pid}`;
  const initialUrl = page.url();
  const writes: Array<{ path: string; status: number; body: any }> = [];
  const post = async (path: string, action: () => Promise<unknown>, expectedStatus = 200) => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + path
      && response.request().method() === 'POST');
    await action();
    const response = await pending;
    const receipt = { path, status: response.status(), body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-prompt-writes.json'), JSON.stringify(writes, null, 2));
    assert.equal(receipt.status, expectedStatus, JSON.stringify(receipt.body));
    return receipt;
  };
  const stored = async () => {
    const response = await page.request.get(input.base + endpoint);
    assert.equal(response.status(), 200);
    return (await response.json()).prompts as Array<{ id: string; title: string | null; body: string }>;
  };
  const create = page.getByRole('button', { name: 'New prompt', exact: true });
  await page.getByRole('tree', { name: 'Saved prompts outline' }).waitFor();
  assert.deepEqual(await stored(), [], 'disposable workspace must begin without saved prompts');
  const first = await post('/node', () => create.click());
  const id = first.body.prompt.id as string;
  const title = page.locator('.pc-qp__nodetitle');
  await title.waitFor();
  await post('/node/update', async () => { await title.fill(marker); await title.blur(); });
  assert.equal((await stored()).find(row => row.id === id)?.title, marker);
  await title.press('Shift+Enter');
  const note = page.locator('.pc-qp__note');
  await note.waitFor();
  await post('/node/update', async () => { await note.fill(body); await note.blur(); });
  assert.equal((await stored()).find(row => row.id === id)?.body, body);
  await page.reload();
  await page.getByRole('textbox', { name: `Title of ${marker}`, exact: true }).waitFor();
  assert.equal(await note.inputValue(), body, 'exact saved body must survive reload');
  const filter = page.getByRole('textbox', { name: 'Filter prompts', exact: true });
  await filter.fill(marker);
  await page.waitForFunction(value => new URL(location.href).searchParams.get('qpq') === value, marker);
  const zoom = page.getByRole('button', { name: `Zoom into ${marker} (drag to move)`, exact: true });
  assert.notEqual(await zoom.getAttribute('aria-disabled'), 'true', 'filter disables dragging, not the independent zoom action');
  await zoom.click();
  await page.waitForFunction(value => new URL(location.href).searchParams.get('qpzoom') === value, id);
  const deepLink = page.url();
  await page.reload();
  await page.getByRole('textbox', { name: 'Zoomed node title', exact: true }).waitFor();
  assert.equal(page.url(), deepLink);
  assert.equal(await page.getByRole('textbox', { name: 'Zoomed node title', exact: true }).inputValue(), marker);
  assert.equal(await note.inputValue(), body);
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get('q'), 'retained-shell-search');
  assert.equal(params.get('qpsel'), id);
  assert.equal(params.get('qpq'), marker);
  assert.equal(params.get('ws'), input.workspace);
  assert.equal(params.get('panel'), 'quick');
  await page.goto(initialUrl);
  await page.getByRole('textbox', { name: `Title of ${marker}`, exact: true }).waitFor();
  const beforeDenial = await stored();
  // As with Profile, relay a real upstream Origin denial unchanged. Ordinary
  // positive writes remain the production browser fetch; no fake API result.
  await context.route('**/api/agent-mcp/saved-prompts/node', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await post('/node', () => create.click(), 403);
  await page.getByText(/^Create failed:/).waitFor();
  assert.deepEqual(await stored(), beforeDenial,
    'denied create must preserve exactly the existing prompt');
  assert.equal(await title.inputValue(), marker, 'denied create must preserve the existing outline');
  await context.unroute('**/api/agent-mcp/saved-prompts/node');
  const retry = await post('/node', () => create.click());
  assert.notEqual(retry.body.prompt.id, id);
  const finalRows = await stored();
  assert.equal(finalRows.length, 2);
  assert.equal(finalRows.find(row => row.id === id)?.body, body);
  const result = { workspace: input.workspace, authMethod: 'private-loopback-prompts-with-cookie',
    createdId: id, retryId: retry.body.prompt.id, savedExactValue: true, bodySavedByKeyboard: true,
    deepLinkReload: true, shellQueryPreserved: true, denialStatus: denied.status,
    deniedWriteIsolated: true, existingOutlineRetained: true, retryPersisted: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual qp-prefixed PromptsTab with production polling sync and saved-prompt clients on a disposable private loopback API; exact create/title/note persistence, zoom/filter/selection reload and real upstream Origin-denial recovery. Host panel geometry is supplied; hosted tenant authorization and complete Quick Panel navigation are unmeasured' };
  writeFileSync(join(input.evidence, 'portal-prompts-dom.html'), await page.content());
  return result;
}

/** The same Profile page the maintained Settings surface selects by default. */
async function runPrivateProfilePage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const profile = new URL('/api/profile', input.base).href;
  const name = page.getByPlaceholder('Your name', { exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const marker = `private-settings-${process.pid}`;
  const draft = marker + '-retry';
  const writes: Array<{ status: number; origin: string | undefined; body: unknown }> = [];
  const submit = async (expectedStatus: number) => {
    const pending = page.waitForResponse(r => r.url() === profile && r.request().method() === 'POST');
    await save.click();
    const response = await pending;
    const receipt = { status: response.status(), origin: response.request().headers().origin, body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-profile-writes.json'), JSON.stringify(writes, null, 2));
    assert.equal(receipt.status, expectedStatus, JSON.stringify(receipt.body));
    return receipt;
  };
  await name.waitFor();
  await name.fill(marker);
  await submit(200);
  await page.getByText('Profile saved', { exact: true }).waitFor();
  assert.equal((await (await page.request.get(profile)).json()).display_name, marker,
    'actual Profile submit must persist the exact displayed name');
  const reloadUrl = page.url();
  await page.reload();
  assert.equal(page.url(), reloadUrl);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  assert.equal(new URL(page.url()).searchParams.get('app'), 'settings');
  await name.waitFor();
  assert.equal(await name.inputValue(), marker);
  await name.fill(draft);
  // Chromium synthesizes Origin even after route.continue header overrides.
  // Forward an ACTUAL upstream denied response through the API transport;
  // no status/body is invented. This branch proves form error handling and
  // retry, not a native browser foreign-Origin request. Positive saves remain
  // unmodified browser fetches, and the cheap preflight verifies this seam.
  await context.route('**/api/profile', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await submit(403);
  await page.getByText('save failed: HTTP 403', { exact: true }).waitFor();
  assert.equal(await name.inputValue(), draft, 'denied Profile save must retain the form draft');
  await context.unroute('**/api/profile');
  assert.equal((await (await page.request.get(profile)).json()).display_name, marker,
    'denied Profile save must leave stored state untouched');
  await submit(200);
  assert.equal((await (await page.request.get(profile)).json()).display_name, draft,
    'retry must persist the retained draft');
  await page.reload();
  await name.waitFor();
  assert.equal(await name.inputValue(), draft);
  const result = { workspace: input.workspace, authMethod: 'private-loopback-profile-with-cookie',
    savedExactValue: true, deepLinkReload: true, denialStatus: denied.status, draftRetained: true,
    deniedWriteIsolated: true, retryPersisted: true, retryReload: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual default Settings Profile page, unmodified private loopback save/reload/retry, and form handling of a real upstream Origin denial forwarded by the test proxy; no native-browser foreign-Origin, full Settings navigation or hosted tenant-profile acceptance' };
  writeFileSync(join(input.evidence, 'portal-profile-dom.html'), await page.content());
  return result;
}

/** Real shared split InboxPane and persisted private acknowledgment. */
async function runPrivateInboxPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const inbox = input.inbox!;
  const selectedId = 'coord-message:' + inbox.selectedMessageId;
  const neighborId = 'coord-message:' + inbox.neighborMessageId;
  const selected = page.getByTestId('inbox-row-' + selectedId);
  const neighbor = page.getByTestId('inbox-row-' + neighborId);
  const detail = page.getByTestId('inbox-expanded-' + selectedId);
  const endpoint = new URL('/api/admin/coord/ack', input.base).href;
  const writes: Array<{ status: number; target: string; body: unknown }> = [];
  const cacheStats: Array<{ phase: string; at: string; status: number; body: unknown; l2Rows: unknown }> = [];
  const captureCacheStats = async (phase: string) => {
    const url = new URL('/api/agent-tools/dev/cache_stats', input.base);
    url.searchParams.set('client', 'pc-admin-coord-ui');
    // This read tool accepts the existing private cookie context. Opting into
    // superuser mode would instead require a separate bearer and return401.
    const response = await page.request.post(url.href, { data: { tool: 'plans:attention' },
      headers: { 'x-papercusp-workspace': input.workspace } });
    const l2Rows = await getOrgPg().sql`SELECT workspace_id, cache_key, tags, generation, expires_at,
      jsonb_path_query_array(value, '$.groups[*].items[*].id') AS item_ids
      FROM harness_shared.cache_l2 WHERE cache_key LIKE 'plans:attention|%' LIMIT 10`;
    cacheStats.push({ phase, at: new Date().toISOString(), status: response.status(), body: await response.json(), l2Rows });
    writeFileSync(join(input.evidence, 'portal-inbox-cache-stats.json'), JSON.stringify(cacheStats, null, 2));
    assert.equal(response.status(), 200, 'passive cache diagnostics must return measured counters');
    if (phase === 'before-ack') assert.ok(l2Rows.some(row => row.workspace_id === input.workspace),
      'the warm viewed attention feed must be cached in its concrete workspace');
    assert.equal(l2Rows.some(row => row.workspace_id === '*'), false,
      'private attention reads must not escape scoped PG invalidation through a wildcard cache');
  };
  const assertState = async (acked: boolean) => {
    const ids = await readAckedMsgIds('pc-admin-coord-ui');
    assert.equal(ids.has(inbox.selectedMessageId), acked, 'only the selected acknowledgment may change');
    assert.equal(ids.has(inbox.neighborMessageId), false, 'neighbor acknowledgment must remain untouched');
  };
  await page.locator('[data-testid="inbox-tab"][data-layout="split"]').waitFor();
  await selected.waitFor(); await neighbor.waitFor();
  await assertState(false);
  await selected.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(url => url.searchParams.get('opcis') === selectedId);
  await detail.getByText(inbox.selectedTitle + ' body', { exact: true }).waitFor();
  assert.equal(await detail.getByText(inbox.neighborTitle + ' body', { exact: true }).count(), 0);
  const selectedUrl = page.url();
  await page.reload();
  await detail.getByText(inbox.selectedTitle + ' body', { exact: true }).waitFor();
  assert.equal(page.url(), selectedUrl, 'inbox filters, selection and workspace must survive reload');
  const acknowledge = async () => {
    const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
    await detail.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    const response = await pending;
    const target = response.request().postDataJSON().msg_id;
    assert.equal(target, inbox.selectedMessageId, 'the rendered action must name the selected message');
    const receipt = { status: response.status(), target, body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-inbox-writes.json'), JSON.stringify(writes, null, 2));
    return receipt;
  };
  // Relay a real private API denial. The browser cannot override its own Origin.
  await context.route('**/api/admin/coord/ack', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await acknowledge();
  assert.equal(denied.status, 403);
  await page.getByText('Action failed', { exact: true }).waitFor();
  await assertState(false);
  assert.equal(new URL(page.url()).searchParams.get('opcis'), selectedId);
  await detail.getByRole('button', { name: 'Acknowledge', exact: true }).waitFor();
  await context.unroute('**/api/admin/coord/ack');
  await captureCacheStats('before-ack');
  const accepted = await acknowledge();
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  await assertState(true);
  try { await selected.waitFor({ state: 'detached' }); }
  finally { await captureCacheStats('after-ack-refetch'); }
  await neighbor.waitFor();
  await page.reload();
  await neighbor.waitFor();
  assert.equal(await selected.count(), 0, 'acknowledged message must stay absent after a fresh real feed read');
  await assertState(true);
  const params = new URL(page.url()).searchParams;
  for (const [key, value] of [['app', 'inbox'], ['ws', input.workspace], ['q', 'retained-shell-search'],
    ['opci', 'alerts'], ['opck', 'coord-message'], ['opcsort', 'newest']]) assert.equal(params.get(key), value);
  return { workspace: input.workspace, authMethod: 'private-loopback-inbox-with-cookie', selectedId, neighborId,
    keyboardSelection: true, deepLinkReload: true, shellQueryPreserved: true, denialStatus: denied.status,
    selectionRetained: true, deniedWriteIsolated: true, retryPersisted: true, neighborIsolated: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual utility.inbox shared split InboxPane, attention sync/detail and private coord acknowledgment; two private producer messages, exact reload and real upstream Origin-denial recovery. Portal navigation geometry is supplied; hosted tenant authorization and bulk resolve are unmeasured' };
}

async function runPrivatePlansPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const plans = input.plans!;
  const selected = page.getByTestId('plans-pane-row-' + plans.selectedSlug);
  const neighbor = page.getByTestId('plans-pane-row-' + plans.neighborSlug);
  const archive = page.getByTestId('plans-pane-archive-' + plans.selectedSlug);
  const endpoint = new URL('/api/admin/plans/set-archived', input.base).href;
  const writes: Array<{ status: number; target: string; harness: string; body: unknown }> = [];
  const states: Array<{ at: string; expectedArchived: boolean; rows: unknown }> = [];
  const cacheStats: Array<{ phase: string; at: string; status: number; body: unknown; l2Rows: unknown }> = [];
  const captureCacheStats = async (phase: string) => {
    const url = new URL('/api/agent-tools/dev/cache_stats', input.base);
    url.searchParams.set('client', 'pc-admin-coord-ui');
    const response = await page.request.post(url.href, { data: { tool: 'plans:list' },
      headers: { 'x-papercusp-workspace': input.workspace } });
    const l2Rows = await getOrgPg().sql`SELECT workspace_id, cache_key, tags, generation, expires_at,
      jsonb_path_query_array(value, '$.plans[*].slug') AS plan_slugs,
      jsonb_path_query_array(value, '$.plans[*].archived') AS archived_flags
      FROM harness_shared.cache_l2 WHERE cache_key LIKE 'plans:list|%' LIMIT 10`;
    cacheStats.push({ phase, at: new Date().toISOString(), status: response.status(), body: await response.json(), l2Rows });
    writeFileSync(join(input.evidence, 'portal-plans-cache-stats.json'), JSON.stringify(cacheStats, null, 2));
    assert.equal(response.status(), 200, 'passive Plans cache diagnostics must return measured counters');
    assert.ok(l2Rows.some(row => row.workspace_id === input.workspace),
      'the warm viewed Plans list must be cached in its concrete workspace');
    assert.equal(l2Rows.some(row => row.workspace_id === '*'), false,
      'private Plans reads must not escape scoped PG invalidation through a wildcard cache');
  };
  const assertState = async (archived: boolean) => {
    const rows = await getOrgPg().sql<{ plan_slug: string; archived: boolean }[]>`
      SELECT plan_slug, archived FROM harness_shared.harness_plans
      WHERE workspace_id = ${input.workspace} AND harness_slug = ${plans.harness}
        AND plan_slug IN (${plans.selectedSlug}, ${plans.neighborSlug})`;
    states.push({ at: new Date().toISOString(), expectedArchived: archived, rows });
    writeFileSync(join(input.evidence, 'portal-plans-states.json'), JSON.stringify(states, null, 2));
    assert.equal(rows.length, 2, 'both exact private plan rows must exist');
    assert.equal(rows.find(row => row.plan_slug === plans.selectedSlug)!.archived, archived);
    assert.equal(rows.find(row => row.plan_slug === plans.neighborSlug)!.archived, false,
      'neighbor plan must remain unarchived');
  };
  await page.locator('[data-testid="plans-pane"][data-layout="split"]').waitFor();
  await selected.waitFor(); await neighbor.waitFor(); await archive.waitFor();
  await assertState(false);
  const search = page.getByTestId('plans-pane-search');
  const query = plans.selectedTitle.replace(/-selected$/, '');
  await search.focus(); await page.keyboard.insertText(query);
  await page.waitForURL(url => url.searchParams.get('plq') === query);
  await selected.waitFor(); await neighbor.waitFor();
  const filteredUrl = page.url();
  await page.reload();
  await selected.waitFor(); await neighbor.waitFor();
  assert.equal(await search.inputValue(), query);
  assert.equal(page.url(), filteredUrl, 'private Plans filter URL must survive reload');
  await captureCacheStats('before-archive');
  const openArchive = async () => {
    await archive.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Archive this plan?' });
    await dialog.waitFor();
    await dialog.getByText('“' + plans.selectedTitle + '” will drop out of your plan lists.', { exact: false }).waitFor();
    return dialog;
  };
  let requestCount = 0;
  page.on('request', request => { if (request.url() === endpoint && request.method() === 'POST') requestCount++; });
  const cancel = await openArchive();
  await cancel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await cancel.waitFor({ state: 'detached' });
  assert.equal(requestCount, 0, 'cancel must send no archive request');
  await assertState(false);
  const confirm = async () => {
    const dialog = await openArchive();
    const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    const response = await pending;
    const payload = response.request().postDataJSON();
    assert.equal(payload.slug, plans.selectedSlug, 'archive must name the selected plan');
    assert.equal(payload.harness, plans.harness, 'archive must preserve the selected harness');
    assert.equal(payload.archived, true);
    const receipt = { status: response.status(), target: payload.slug, harness: payload.harness, body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-plans-writes.json'), JSON.stringify(writes, null, 2));
    return receipt;
  };
  await context.route('**/api/admin/plans/set-archived', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await confirm();
  assert.equal(denied.status, 403);
  await page.getByText(/^Could not archive:/).waitFor();
  await assertState(false);
  await selected.waitFor(); await neighbor.waitFor(); await archive.waitFor();
  assert.equal(page.url(), filteredUrl, 'denied archive must retain the exact Plans filter URL');
  await context.unroute('**/api/admin/plans/set-archived');
  const accepted = await confirm();
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.deepEqual(accepted.body, { ok: true, results: [{ ok: true, slug: plans.selectedSlug,
    harnessSlug: plans.harness, archived: true }], counts: { ok: 1, failed: 0 } },
  'HTTP success must include the exact successful plan-archive receipt');
  await assertState(true);
  await captureCacheStats('after-archive');
  await selected.waitFor({ state: 'detached' }); await neighbor.waitFor();
  await page.reload(); await neighbor.waitFor();
  assert.equal(await selected.count(), 0, 'archived selected plan must stay absent after reload');
  await assertState(true);
  const params = new URL(page.url()).searchParams;
  for (const [key, value] of [['app', 'plans'], ['ws', input.workspace], ['q', 'retained-shell-search'], ['plq', query]])
    assert.equal(params.get(key), value);
  assert.equal(requestCount, 2);
  return { workspace: input.workspace, authMethod: 'private-loopback-plans-with-cookie', ...plans,
    filterKeyboard: true, deepLinkReload: true, shellQueryPreserved: true, cancelNoRequest: true,
    denialStatus: denied.status, deniedWriteIsolated: true, retryPersisted: true, neighborIsolated: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual utility.plans shared split PlansPane, real plan list and selected stale-plan archive confirmation; private PG rows, exact filter reload and real Origin-denial recovery. Supplied host geometry; dashboard authoring and hosted tenant authorization remain unmeasured' };
}

/** Browser wire precondition, not product/API authorization evidence. */
export async function verifyPrivateProfileOriginControl() {
  const forbidden = 'https://unapproved.invalid';
  const server = createServer((request, response) => {
    if (request.url === '/api/profile') {
      const origin = request.headers.origin ?? null;
      response.writeHead(origin === forbidden ? 403 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ origin }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<button>Save</button><script>document.querySelector("button").onclick=()=>fetch("/api/profile",{method:"POST",body:"{}"})</script>');
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(base);
    const submit = async () => {
      const pending = page.waitForResponse(response => response.url() === base + '/api/profile');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const response = await pending;
      return { status: response.status(), ...await response.json() };
    };
    await context.setExtraHTTPHeaders({ origin: forbidden });
    const oldControl = await submit();
    await context.setExtraHTTPHeaders({});
    await context.route('**/api/profile', async route => {
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: forbidden } });
      await route.fulfill({ response });
    });
    const continuedControl = await submit();
    assert.equal(continuedControl.origin, forbidden, 'denial input must arrive on the wire');
    assert.equal(continuedControl.status, 403, 'wire control must exercise the denied response');
    const receipt = { base, oldControl, continuedControl, scope: 'Local echo-server browser wire preflight only' };
    console.info('PROFILE_ORIGIN_PREFLIGHT ' + JSON.stringify(receipt));
    return receipt;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}

/** Real settings mutation and shortcut bus; only host navigation geometry is supplied. */
async function runPrivateShortcutsPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const profile = new URL('/api/profile', input.base).href;
  const panel = page.getByTestId('private-shortcut-panel');
  const row = page.locator('.kbd-settings-row').filter({ has: page.getByRole('textbox', {
    name: 'Combo for Open or close the command palette', exact: true }) });
  const combo = row.getByRole('textbox');
  await combo.waitFor();
  const defaultCombo = await combo.inputValue();
  assert.match(defaultCombo, /mod\+k/);
  const writes: Array<{ status: number; body: unknown }> = [];
  const change = async (action: () => Promise<unknown>) => {
    const response = page.waitForResponse(r => r.url() === profile && r.request().method() === 'POST');
    await action();
    const r = await response;
    const receipt = { status: r.status(), body: await r.json() };
    writes.push(receipt);
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  };
  await change(() => combo.fill('alt+k'));
  await page.locator('h1').click();
  await page.keyboard.press('Control+k');
  assert.equal(await panel.innerText(), 'none', 'old default must stop dispatching after remap');
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^launcher$/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('panel'), 'launcher');
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^none$/ }).waitFor();
  const stored = await page.request.get(profile);
  assert.equal(stored.status(), 200);
  const storedBody = await stored.json();
  assert.equal(storedBody.shortcut_overrides['palette.toggle'], 'alt+k', 'real private profile must retain remap');
  const reloadUrl = page.url();
  await page.reload();
  assert.equal(page.url(), reloadUrl);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  await combo.waitFor();
  assert.equal(await combo.inputValue(), 'alt+k');
  await page.locator('h1').click();
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^launcher$/ }).waitFor();
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^none$/ }).waitFor();
  // Profile POST uses the real loopback boundary, not roster cookie auth.
  const denied = await page.request.post(profile, { headers: { origin: 'https://unapproved.invalid' },
    data: { shortcut_overrides: { 'palette.toggle': 'alt+x' } } });
  assert.equal(denied.status(), 403);
  assert.equal((await (await page.request.get(profile)).json()).shortcut_overrides['palette.toggle'], 'alt+k');
  await change(() => row.getByRole('button', { name: 'Reset', exact: true }).click());
  assert.equal(await combo.inputValue(), defaultCombo);
  await page.locator('h1').click();
  await page.keyboard.press('Alt+k');
  assert.equal(await panel.innerText(), 'none', 'reset must retire the customized chord');
  await page.keyboard.press('Control+k');
  await panel.filter({ hasText: /^launcher$/ }).waitFor();
  const reset = await page.request.get(profile);
  assert.equal(reset.status(), 200);
  assert.equal((await reset.json()).shortcut_overrides['palette.toggle'], undefined);
  return { workspace: input.workspace, authMethod: 'private-loopback-profile-with-cookie', remapImmediate: true, remapPersisted: true,
    deepLinkReload: true, resetRestoredDefault: true, denialStatus: denied.status(), deniedWriteIsolated: true,
    oldChordFalsifier: true, writes,
    scope: 'Actual Portal shortcut bindings, shared settings/dispatcher and private loopback profile HTTP with Origin denial; host navigation geometry is a fixture, no hosted tenant-profile or full Portal acceptance' };
}

async function runHistoryPage(page: Page, input: PortalRosterBrowserInput) {
  const history = input.history!;
  const streams: Array<{ url: string; status: number }> = [];
  const requests: string[] = [];
  const expected = {
    selected: { ownerId: input.selected, sessionId: history.selectedSessionId, rolloutId: history.selectedRolloutId },
    neighbor: { ownerId: input.neighbor, sessionId: history.neighborSessionId, rolloutId: history.neighborRolloutId },
  };
  const retainStreams = () => writeFileSync(join(input.evidence, 'portal-history-streams.json'),
    JSON.stringify({ expected, requests, streams }, null, 2));
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/adv/session/thinking') return;
    requests.push(request.url()); retainStreams();
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/api/adv/session/thinking') return;
    streams.push({ url: response.url(), status: response.status() }); retainStreams();
  });
  await page.getByTestId('agent-row-' + input.selected).click();
  await page.waitForURL(url => url.searchParams.get('agentHistory') === input.selected && !url.searchParams.has('panel'));
  assert.equal(new URL(page.url()).searchParams.has('agentConversation'), false, 'history activation must not silently open the HUD conversation');
  await page.getByText(history.selectedMarker, { exact: true }).waitFor();
  assert.equal(await page.getByText(history.neighborMarker, { exact: true }).count(), 0, 'selected history cannot render the neighbor transcript');
  const historyUrl = page.url();
  await page.reload();
  await page.getByText(history.selectedMarker, { exact: true }).waitFor();
  assert.equal(page.url(), historyUrl, 'history selection and workspace must survive reload');
  await page.getByTestId('agent-history-open-conversation').click();
  await page.waitForURL(url => url.searchParams.get('agentConversation') === input.selected
    && url.searchParams.get('hudsession') === input.selected && url.searchParams.get('app') === 'hud'
    && !url.searchParams.has('agentHistory') && !url.searchParams.has('agentHistorySession'));
  assert.equal(await page.getByTestId('private-conversation-selection').innerText(), input.selected);
  const conversationUrl = page.url();
  await page.reload();
  assert.equal(await page.getByTestId('private-conversation-selection').innerText(), input.selected);
  assert.equal(page.url(), conversationUrl);
  retainStreams();
  verifyPrivateHistoryStreams(streams, expected);
  return { workspace: input.workspace, selected: input.selected, neighbor: input.neighbor,
    selectedSessionId: history.selectedSessionId, authMethod: 'cookie-session', historyUrl, conversationUrl,
    historyKeptSeparate: true, historyReload: true, explicitGuiSelection: true, conversationSelectionReload: true,
    neighborIsolated: true, streams,
    scope: 'Actual Portal roster URL action, operator history modal, owner-session resolver and private native transcript SSE; HUD target selection only, no full HUD rendering or parked-turn proof' };
}

async function runConfirmedStopPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const stop = input.stop!;
  const path = '/api/adv/sessions/close-window';
  const requests: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests.push(request.postDataJSON());
  });
  const button = page.getByTestId('agents-bulk-kill');
  const arm = async () => {
    await button.click();
    assert.match(await button.innerText(), /Confirm stop 1/);
  };
  const confirm = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await button.click();
    const observed = await response;
    return { status: observed.status(), body: await observed.json() };
  };
  await arm();
  await page.getByTestId('agents-bulk-kill-cancel').click();
  assert.doesNotMatch(await button.innerText(), /Confirm/);
  await stop.assertChildrenAlive();
  assert.equal(requests.length, 0, 'arming and cancelling must send no stop request');

  const cookie = (value: string) => ({ name: input.cookieName, value, url: input.base, httpOnly: true, sameSite: 'Lax' as const });
  await context.addCookies([cookie(input.foreignToken)]);
  await arm();
  const denied = await confirm();
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  await page.getByTestId('agents-bulk-note').filter({ hasText: /stale|foreign|403/ }).waitFor();
  assert.equal(await page.getByTestId(`agent-select-${input.selected}`).isChecked(), true, 'denial must retain exact selection');
  assert.equal(await page.getByTestId(`agent-select-${input.neighbor}`).isChecked(), false);
  await stop.assertChildrenAlive();

  await context.addCookies([cookie(input.ownToken)]);
  await arm();
  const accepted = await confirm();
  const expected = { ownerId: input.selected, managedSessionId: stop.selected.id, startedAt: stop.selected.startedAt };
  verifyPrivateStopReceipt(accepted, expected);
  // The actual receipt cannot attest a neighbor or a replacement launch.
  assert.throws(() => verifyPrivateStopReceipt(accepted, { ...expected, managedSessionId: stop.neighbor.id }), /selected-session receipt correlation/);
  assert.throws(() => verifyPrivateStopReceipt(accepted, { ...expected, startedAt: stop.neighbor.startedAt + '-replacement' }), /selected-launch stop receipt correlation/);
  await page.getByTestId('agents-bulk-note').filter({ hasText: 'Stop requested for 1 session' }).waitFor();
  assert.equal(await page.getByTestId(`agent-select-${input.selected}`).isChecked(), false);
  assert.deepEqual(requests, [expected, expected].map(target => ({ ownerId: target.ownerId,
    managedSessionId: target.managedSessionId, expectedStartedAt: target.startedAt, confirmed: true })),
  'denial and retry must preserve the same server-resolved launch; no process/window handles');
  await stop.assertSelectedStopped();
  const url = page.url();
  await page.reload();
  assert.equal(page.url(), url);
  await page.getByTestId(`agent-select-${input.neighbor}`).waitFor();
  // A second session remains controllable after the selected stop. Cancelling
  // its confirmation cannot dispatch; an old launch must then be refused.
  await page.getByTestId(`agent-select-${input.neighbor}`).check();
  await arm();
  await page.getByTestId('agents-bulk-kill-cancel').click();
  await stop.assertNeighborAlive();
  assert.equal(requests.length, 2, 'cancelling a second stop must not dispatch');
  await stop.invalidateNeighborLaunch();
  await arm();
  const stale = await confirm();
  assert.equal(stale.status, 403, JSON.stringify(stale.body));
  await page.getByTestId('agents-bulk-note').filter({ hasText: /stale|foreign/ }).waitFor();
  await stop.assertNeighborAlive();
  assert.deepEqual(requests[2], { ownerId: input.neighbor, managedSessionId: stop.neighbor.id,
    expectedStartedAt: stop.neighbor.startedAt, confirmed: true }, 'stale replay must name the original launch');
  assert.equal(requests.length, 3);
  return { workspace: input.workspace, authMethod: 'cookie-session', selected: { owner: input.selected, id: stop.selected.id, ended: true },
    neighbor: { owner: input.neighbor, id: stop.neighbor.id, alive: true }, cancelSentNoRequest: true, denialStatus: denied.status,
    selectionRetained: true, retryClearedSelection: true, deepLinkReload: true, neighborIsolated: true,
    secondCancelSentNoRequest: true, staleDenialStatus: stale.status,
    positiveControl: 'wrong-session and replacement-launch rejected', denied, accepted, stale, requests,
    scope: 'Actual mounted Portal confirmation and private cookie API/native effects; no whole-Portal or shipment acceptance' };
}

async function readSettledNote(page: Page) {
  const note = page.getByTestId('agents-bulk-note');
  await note.waitFor();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await note.innerText();
    if (/pickup not confirmed|wake not delivered|message is in inbox/.test(text)) return text;
    await page.waitForTimeout(50);
  }
  throw new Error('Wake receipt did not settle to a truthful delivery disposition');
}

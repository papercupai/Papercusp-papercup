/** Real Markdown/geometry coverage for the owner-selected Reports refined reader. */
import { test, expect } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { reportFullFixture, reportSummaryFixture } from '../../operator-vite/src/components/reports/reports-test-fixture';
import { captureReportClipboard, configurePublishedReportSession, navigateToPublishedReport, observeReportReadiness, readPublishedReportProof, verifyPublishedReportAndOfflineExport, waitForReportRenderer } from './_reports-proof';
import type { Page } from '@playwright/test';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { POSTHOG_PUBLIC_DEFAULTS } from '../../../packages/operator-core/lib/posthog-public-defaults';

const report = {
  ...reportFullFixture,
  title: 'Reports refined reader browser fixture',
  summary: 'A readable summary appears before the report body.',
  body_md: Array.from({ length: 8 }, (_, i) => `## Finding ${i + 1}\n\n${'Evidence and next steps for this finding. '.repeat(30)}`).join('\n\n'),
};
const previous = { ...report, report_id: 'edition-1', supersedes_report_id: null, title: 'Original reader fixture', body_md: '## Original finding\n\nOriginal evidence.' };
const summary = { ...reportSummaryFixture, title: report.title, summary: report.summary };

const finishReadiness = new WeakMap<Page, () => Promise<void>>();
test.beforeEach(async ({ page }, testInfo) => { finishReadiness.set(page, await observeReportReadiness(page, testInfo)); });
test.afterEach(async ({ page }) => {
  await finishReadiness.get(page)?.();
});

async function stubReportFlags(page: Page) {
  await page.route('**/api/flags/bootstrap', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ flags: { 'papercusp-reports-library': true }, evaluatedAt: Date.now(), source: 'override' }) }));
  await page.route('**/api/flags/stream', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture flags\n\n' }));
  // Fixture traffic never mutates the current user's saved read markers.
  await page.route('**/api/user/preferences', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ contentType: 'application/json', body: '{"payload":{}}' });
    else await route.continue();
  });
}

test.describe('fixture refined reader', () => {
test.beforeEach(async ({ page }) => { await stubReportFlags(page); });

for (const width of [1440, 900, 390]) {
  test(`refined reader remains readable at ${width}px and its outline scrolls the report`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const sync = await stubSyncQueries(page, (name, args) => {
      if (name === 'reports.list') return [summary];
      if (name === 'reports.get') return args.reportId === 'edition-1' ? [previous] : [report];
      if (name === 'reports.lineage') return [{ ...summary, report_id: 'edition-1', published_at: '2026-09-30T12:00:00Z' }, summary];
      if (name === 'userPreferences.current') return [{ payload: {} }];
      return undefined;
    });
    await page.goto('/reports?sel=edition-2');
    await sync.waitForServed(['reports.list', 'reports.get', 'reports.lineage']);
    await expect(page.locator('.reports-article-main > h2')).toHaveText(report.title);
    await waitForReportRenderer(page, testInfo.project.use.navigationTimeout ?? 30_000);
    await expect(page.locator('.reports-body h2').first()).toHaveText('Finding 1');
    await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link')).toHaveCount(8);
    const geometry = await page.locator('.reports-page').evaluate(root => {
      const workspace = root.querySelector('.reports-workspace')!;
      const list = root.querySelector('.reports-list')!;
      const reader = root.querySelector('.reports-reader')!;
      const outline = root.querySelector('.reports-outline')!;
      const listBox = list.getBoundingClientRect(); const readerBox = reader.getBoundingClientRect();
      return { overflow: root.scrollWidth > root.clientWidth + 1,
        columns: getComputedStyle(workspace).gridTemplateColumns.split(' ').length,
        stacked: readerBox.top >= listBox.bottom - 1,
        outlineVisible: outline.getBoundingClientRect().width > 100,
        summaryBeforeBody: !!(root.querySelector('.reports-summary')!.compareDocumentPosition(root.querySelector('.reports-body')!) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    expect(geometry.overflow).toBe(false); expect(geometry.summaryBeforeBody).toBe(true);
    expect(geometry.outlineVisible).toBe(true); expect(geometry.stacked).toBe(width === 390);
    if (width === 1440) expect(geometry.columns).toBe(2);

    const outerScroll = await page.evaluate(() => window.scrollY);
    // dispatch avoids Playwright scrolling the whole page to reach the outline:
    // this assertion isolates what the product click handler itself scrolls.
    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Finding 7', exact: true }).dispatchEvent('click');
    await expect.poll(() => page.locator('.reports-article-main').evaluate(root => root.scrollTop)).toBeGreaterThan(100);
    await expect(page.getByRole('progressbar', { name: 'Reading progress' })).not.toHaveAttribute('value', '0');
    expect(new URL(page.url()).searchParams.get('sel')).toBe('edition-2');
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScroll);
    await page.getByRole('button', { name: 'Compare editions', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Edition comparison' }).getByText('Original evidence.')).toBeVisible();
    await page.getByRole('button', { name: 'Close comparison' }).click();
    await page.locator('.reports-article-main').evaluate(root => { root.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`reports-reader-${width}.png`), fullPage: true });
    sync.assertServed('reports.list', 'reports.get', 'reports.lineage', 'userPreferences.current');
  });
}
});

// With no input this always runs in CI using calibrated sync fixtures. An explicit
// complete reports:get receipt exercises the same instrument against the real reader,
// with no flags or report-data stubs. Select this case alone for a live acceptance run.
test('report clipboard capture initializes without Node transpiler globals', async () => {
  let browserScript: string | undefined;
  await captureReportClipboard({
    addInitScript: async (script: unknown) => {
      expect(typeof script).toBe('string');
      browserScript = script as string;
    },
  });
  const navigator: { clipboard?: { writeText(value: string): Promise<void> } } = {};
  const window: { reportProofMarkdown?: string } = {};
  runInNewContext(browserScript!, { navigator, window });
  const markdown = '# Report\n\nComplete body with $ and literal `code`.';
  await navigator.clipboard!.writeText(markdown);
  expect(window.reportProofMarkdown).toBe(markdown);
});

test('published report session scopes credentials and initializes local machine routing', async ({ page }) => {
  const observed: Array<{ path: string; auth?: string; workspace?: string; client?: string }> = [];
  const operator = createServer((request, response) => {
    if (request.url !== '/favicon.ico') observed.push({ path: request.url || '', auth: request.headers.authorization,
      workspace: request.headers['x-papercusp-workspace'] as string | undefined,
      client: request.headers['x-papercusp-client'] as string | undefined });
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Report authentication control</title>');
  });
  await new Promise<void>(resolve => operator.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(operator.address() as { port: number }).port}`;
  try {
    await configurePublishedReportSession(page, {
      origin, token: 'proof-token', workspaceId: 'proof-workspace', clientId: 'proof-client',
    });
    await page.goto(origin + '/reports');
    await page.evaluate(async () => {
      await (await fetch('/api-other')).text();
      await (await fetch('/api/zero-harness/rest-query?name=reports.get')).text();
    });
    expect(observed).toEqual([
      { path: '/reports', auth: undefined, workspace: undefined, client: undefined },
      { path: '/api-other', auth: undefined, workspace: undefined, client: undefined },
      { path: '/api/zero-harness/rest-query?name=reports.get', auth: 'Bearer proof-token', workspace: 'proof-workspace', client: 'proof-client' },
    ]);
    expect(await page.evaluate(() => sessionStorage.getItem('pc:selected-machine'))).toBe('local');
  } finally {
    operator.closeAllConnections();
    await new Promise<void>(resolve => operator.close(() => resolve()));
  }
});

test('published report session keeps credentials off a redirected foreign origin', async ({ page }) => {
  const observed: Array<string | undefined> = [];
  const receiver = createServer((request, response) => {
    observed.push(request.headers.authorization);
    response.end('redirect target');
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = (receiver.address() as { port: number }).port;
  const operator = createServer((request, response) => {
    if (!request.url?.startsWith('/api/')) { response.end('<!doctype html><title>Redirect control</title>'); return; }
    observed.push(request.headers.authorization);
    response.writeHead(302, { location: `http://127.0.0.1:${receiverPort}/api/report` });
    response.end();
  });
  await new Promise<void>(resolve => operator.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(operator.address() as { port: number }).port}`;
  try {
    await configurePublishedReportSession(page, { origin, token: 'redirect-proof-token', workspaceId: 'proof-workspace', clientId: 'proof-client' });
    await page.goto(`${origin}/reports`);
    expect(await page.evaluate(async () => {
      try { await fetch('/api/report'); return 'followed'; } catch { return 'refused'; }
    })).toBe('refused');
    expect(observed).toEqual(['Bearer redirect-proof-token']);
  } finally {
    operator.closeAllConnections(); receiver.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => operator.close(() => resolve())),
      new Promise<void>(resolve => receiver.close(() => resolve()))]);
  }
});

test('report query readiness uses the navigation budget beyond the action timeout', async ({ page }) => {
  const endpoint = `/api/zero-harness/rest-query?name=reports.get&args=${encodeURIComponent(JSON.stringify({ reportId: report.report_id }))}`;
  await page.route('**/api/zero-harness/rest-query?*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ rows: [report] }),
  }));
  await page.route('**/reports?*', route => route.fulfill({ contentType: 'text/html',
    body: `<script>setTimeout(() => fetch(${JSON.stringify(endpoint)}), 500)</script>`,
  }));
  page.setDefaultTimeout(200);
  await navigateToPublishedReport(page, report, 3_000);
});

test('report query readiness still enforces the navigation deadline', async ({ page }) => {
  await page.route('**/reports?*', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>No selected report query</title>',
  }));
  page.setDefaultTimeout(3_000);
  await expect(navigateToPublishedReport(page, report, 250)).rejects.toThrow('page.waitForResponse: Timeout 250ms');
});

test('report navigation recovers from a connection refusal before the selected report query', async ({ page }) => {
  const endpoint = '/api/zero-harness/rest-query?name=reports.get&args=' +
    encodeURIComponent(JSON.stringify({ reportId: report.report_id }));
  let navigationAttempts = 0;
  await page.route('**/api/zero-harness/rest-query?*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ rows: [report] }),
  }));
  await page.route('**/reports?*', async route => {
    navigationAttempts += 1;
    if (navigationAttempts === 1) {
      await route.abort('connectionrefused');
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body: '<script>setTimeout(() => fetch(' + JSON.stringify(endpoint) + '), 0)</script>',
    });
  });

  const selectedQuery = await navigateToPublishedReport(page, report, 3_000);
  expect(navigationAttempts).toBe(2);
  expect(selectedQuery.ok()).toBe(true);
});

test('report navigation stops repeated connection refusals at its existing deadline', async ({ page }) => {
  let navigationAttempts = 0;
  await page.route('**/reports?*', async route => {
    navigationAttempts += 1;
    await route.abort('connectionrefused');
  });

  await expect(navigateToPublishedReport(page, report, 600))
    .rejects.toThrow(/ERR_CONNECTION_REFUSED|Timeout 600ms/);
  const attemptsAtFailure = navigationAttempts;
  expect(attemptsAtFailure).toBeGreaterThan(1);
  expect(attemptsAtFailure).toBeLessThanOrEqual(3);
  await page.waitForTimeout(250);
  expect(navigationAttempts).toBe(attemptsAtFailure);
});

test('report renderer readiness uses its navigation budget beyond the action timeout', async ({ page }) => {
  await page.route('**/vditor/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/renderer-readiness', route => route.fulfill({ contentType: 'text/html', body: `
    <script>setTimeout(() => {
      for (const id of ['vditorLuteScript', 'vditorI18nScripten_US', 'vditorIconScript']) {
        const script = document.createElement('script');
        script.id = id; script.src = '/vditor/' + id + '.js'; document.head.appendChild(script);
      }
    }, 500);</script>`,
  }));
  page.setDefaultTimeout(200);
  await page.goto('/renderer-readiness');
  await waitForReportRenderer(page, 3_000);
});

test('report renderer readiness still enforces its deadline when a script is missing', async ({ page }) => {
  await page.route('**/vditor/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/renderer-readiness', route => route.fulfill({ contentType: 'text/html', body: `
    <script id="vditorLuteScript" src="/vditor/lute.js"></script>
    <script id="vditorI18nScripten_US" src="/vditor/en_US.js"></script>`,
  }));
  page.setDefaultTimeout(3_000);
  await page.goto('/renderer-readiness');
  await expect(waitForReportRenderer(page, 250)).rejects.toThrow('page.waitForFunction: Timeout 250ms');
});

test.describe('published report proof', () => {
// The real owner session retains its consented first-party flag client. Declare
// that exact maintained origin; fixture runs still forbid every foreign origin.
test.use({ serviceWorkers: 'block', egressAllowedOrigins: process.env.OPERATOR_REPORT_PROOF_JSON
  ? [new URL(POSTHOG_PUBLIC_DEFAULTS.host).origin] : [] });

test('published report text and standalone HTML stay identical', async ({ page }, testInfo) => {
  const input = process.env.OPERATOR_REPORT_PROOF_JSON;
  const expected = input ? await readPublishedReportProof(input) : report;
  await captureReportClipboard(page);
  if (input) {
    const origin = process.env.OPERATOR_E2E_BASE_URL;
    const clientId = process.env.PAPERCUSP_SID;
    if (!origin || !clientId) throw new Error('Live report proof requires OPERATOR_E2E_BASE_URL and PAPERCUSP_SID');
    const token = (await readFile(join(process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'superuser-token'), 'utf8')).trim();
    await configurePublishedReportSession(page, { origin, token, workspaceId: expected.workspace_id, clientId });
  }
  if (!input) {
    await stubReportFlags(page);
    await stubSyncQueries(page, name => {
      if (name === 'reports.list' || name === 'reports.lineage') return [summary];
      if (name === 'reports.get') return [report];
      if (name === 'userPreferences.current') return [{ payload: {} }];
      return undefined;
    });
  }
  const selectedQuery = await navigateToPublishedReport(page, expected, testInfo.project.use.navigationTimeout ?? 30_000);
  if (input) expect(selectedQuery.request().headers()['x-papercusp-machine']).toBe('local');
  await verifyPublishedReportAndOfflineExport(page, expected, testInfo);
});
});

test('report proof rejects a successful HTTP response with an unrelated route', async ({ page }, testInfo) => {
  await page.route('**/reports?*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Operator</title><h1>Accounts</h1>' }));
  const response = await page.goto('/reports?sel=edition-2');
  expect(response?.status()).toBe(200);
  await expect(verifyPublishedReportAndOfflineExport(page, report, testInfo, 250)).rejects.toThrow('The selected Reports reader must mount');
});

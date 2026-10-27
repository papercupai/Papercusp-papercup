/** Maintained browser instrument for published-report and offline-export proof. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Page, TestInfo, Request, Response } from '@playwright/test';
import { expect } from './_egress';

export interface PublishedReportProof {
  report_id: string;
  title: string;
  body_md: string;
  workspace_id: string;
}

export interface PublishedReportSession {
  origin: string;
  token: string;
  workspaceId: string;
  clientId: string;
}

/** Authenticate only this local operator's API, including the selected report query. */
export async function configurePublishedReportSession(
  page: Pick<Page, 'addInitScript'>,
  session: PublishedReportSession,
): Promise<void> {
  const origin = new URL(session.origin).origin;
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      !session.token.trim() || !session.workspaceId || !session.clientId) {
    throw new Error('Published report proof requires an explicit local operator origin, token, workspace and client');
  }
  // Keep HTTP and cancellation in Chromium. Playwright route overrides propagate
  // headers across redirects and race background requests during page teardown.
  await page.addInitScript(`(() => {
    const session = ${JSON.stringify({ ...session, origin })};
    if (location.origin !== session.origin) return;
    window.sessionStorage.setItem('pc:selected-machine', 'local');
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== session.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('authorization', 'Bearer ' + session.token);
      headers.set('x-papercusp-workspace', session.workspaceId);
      headers.set('x-papercusp-client', session.clientId);
      return nativeFetch(input, { ...init, headers, redirect: 'error' });
    };
  })()`);
}

/** Consume the complete reports:get receipt, rather than a hand-copied summary. */
export async function readPublishedReportProof(path: string): Promise<PublishedReportProof> {
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  const report = receipt.results?.[0]?.report;
  if (receipt.ok !== true || receipt.results?.length !== 1 ||
      !report || ['report_id', 'title', 'body_md', 'workspace_id'].some(key => typeof report[key] !== 'string' || !report[key])) {
    throw new Error('Report proof requires one complete successful reports:get receipt');
  }
  return report;
}

/** Capture Copy as Markdown without changing the system clipboard. Install before navigation. */
export async function captureReportClipboard(page: { addInitScript(script: string): Promise<unknown> }): Promise<void> {
  // A serialized TypeScript callback can reference tsx's Node-only __name helper.
  // Send browser JavaScript directly so initialization survives either importer.
  await page.addInitScript(`
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async function(value) { window.reportProofMarkdown = value; },
    } });
  `);
}

/** Keep request completion and renderer progress when a reader assertion fails. */
export async function observeReportReadiness(page: Page, testInfo: TestInfo) {
  const started = Date.now();
  const requests: unknown[] = [];
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const requestInfo = (url: string) => {
    const parsed = new URL(url);
    return { path: parsed.pathname,
      name: parsed.pathname.endsWith('/rest-query') ? parsed.searchParams.get('name') : null };
  };
  const record = (phase: string, info: ReturnType<typeof requestInfo>, extra = {}) => {
    if (requests.length < 100) requests.push({ atMs: Date.now() - started, phase, ...info, ...extra });
  };
  const onRequest = (request: Request) => {
    const info = requestInfo(request.url());
    if (info.path.startsWith('/api/')) record('requested', info);
  };
  const onRequestFailed = (request: Request) => {
    if (failures.length < 100) failures.push({ atMs: Date.now() - started,
      ...requestInfo(request.url()), resourceType: request.resourceType(), error: request.failure()?.errorText });
  };
  const onPageError = (error: Error) => {
    if (failures.length < 100) failures.push({ atMs: Date.now() - started, phase: 'pageerror', error: error.message });
  };
  const onResponse = (response: Response) => {
    const info = requestInfo(response.url());
    if (!info.path.startsWith('/api/')) return;
    record('responded', info, { status: response.status() });
    // Streaming bootstrap endpoints never finish a JSON body. Only report
    // query bodies are needed for exact saved-text readiness.
    if (!info.name?.startsWith('reports.')) return;
    const task = (async () => {
      const status = response.status();
      try {
        const payload = await response.json();
        record('completed', info, { status,
          reportIds: payload.rows?.map((row: { report_id?: string }) => row.report_id) });
      } catch (error) { record('body-failed', info, { status, error: String(error) }); }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  await page.addInitScript(() => {
    const timeline: unknown[] = [];
    (window as unknown as { reportProofTimeline: unknown[] }).reportProofTimeline = timeline;
    let last = '';
    const observer = new MutationObserver(() => {
      const snapshot = {
        readyState: document.readyState,
        status: document.querySelector('[role="status"]')?.textContent?.slice(0, 200),
        title: document.querySelector('.reports-article-main > h2')?.textContent,
        bodyHeadings: document.querySelectorAll('.reports-body h1,.reports-body h2,.reports-body h3').length,
        outlineLinks: document.querySelectorAll('.reports-outline nav a').length,
        comparisonText: document.querySelector('.reports-comparison')?.textContent?.slice(0, 160),
        rendererScripts: Array.from(document.scripts).filter(script => script.src.includes('/vditor/'))
          .map(script => ({ path: new URL(script.src).pathname, loaded: !!script.id })),
      };
      const key = JSON.stringify(snapshot);
      if (key !== last && timeline.length < 100) { timeline.push({ atMs: performance.now(), ...snapshot }); last = key; }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
  });
  return async () => {
    await Promise.allSettled([...pending]);
    const rendering = await page.evaluate(() => {
      const state = window as unknown as { reportProofTimeline?: unknown[];
        __sync_metrics__?: { snapshot(): { scheduler?: unknown }; queries(): unknown[] } };
      return { timeline: state.reportProofTimeline, readyState: document.readyState,
        status: document.querySelector('[role="status"]')?.textContent?.slice(0, 200),
        scheduler: state.__sync_metrics__?.snapshot().scheduler,
        queries: state.__sync_metrics__?.queries().slice(-30) };
    }).catch(error => ({ unavailable: String(error) }));
    page.off('request', onRequest);
    page.off('requestfailed', onRequestFailed);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
    const evidence = JSON.stringify({ requests, failures, rendering }, null, 2);
    await writeFile(testInfo.outputPath('report-readiness.json'), evidence);
    await testInfo.attach('report-readiness', { body: evidence, contentType: 'application/json' });
  };
}

/** Navigation is ready only after the selected report query finishes with exact saved text. */
export async function navigateToPublishedReport(page: Page, report: PublishedReportProof, navigationTimeout: number) {
  // The selected query is navigation readiness, so both waits use the caller's
  // navigation budget rather than inheriting a shorter or longer action timeout.
  const query = page.waitForResponse(response => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith('/rest-query') || url.searchParams.get('name') !== 'reports.get') return false;
    try { return JSON.parse(url.searchParams.get('args') || '{}').reportId === report.report_id; }
    catch { return false; }
  }, { timeout: navigationTimeout });
  const [, response] = await Promise.all([
    page.goto(`/reports?sel=${encodeURIComponent(report.report_id)}&ws=${encodeURIComponent(report.workspace_id)}`, { timeout: navigationTimeout }), query,
  ]);
  expect(response.ok(), 'Selected report query must complete successfully').toBe(true);
  const payload = await response.json();
  expect(payload.rows?.find((row: PublishedReportProof) => row.report_id === report.report_id))
    .toMatchObject({ report_id: report.report_id, title: report.title, body_md: report.body_md });
  return response;
}

/** Vditor assigns these ids only on script load, before resolving preview().
 * Cold asset initialization belongs to navigation readiness, before the short
 * content/geometry assertions. A visible body alone can precede onParsed.
 * Use the navigation deadline so cold assets do not inherit the action timeout.
 */
export async function waitForReportRenderer(page: Page, navigationTimeout: number): Promise<void> {
  await page.waitForFunction(() => [
    'vditorLuteScript', 'vditorI18nScripten_US', 'vditorIconScript',
  ].every(id => {
    const script = document.getElementById(id);
    return script instanceof HTMLScriptElement &&
      new URL(script.src).origin === location.origin &&
      new URL(script.src).pathname.startsWith('/vditor/');
  }), undefined, { timeout: navigationTimeout });
}

export async function verifyPublishedReportAndOfflineExport(
  page: Page, report: PublishedReportProof, testInfo: TestInfo, readerTimeout = 15_000,
) {
  // HTTP status alone cannot prove a route exists: older builds return the Accounts shell.
  await expect(page.locator('.reports-reader'), 'The selected Reports reader must mount').toHaveCount(1, { timeout: readerTimeout });
  expect(new URL(page.url()).searchParams.get('sel')).toBe(report.report_id);
  await expect(page.locator('.reports-article-main > h2')).toHaveText(report.title);
  await waitForReportRenderer(page, testInfo.project.use.navigationTimeout ?? 30_000);
  await expect(page.locator('.reports-body')).toBeVisible();
  await page.getByRole('button', { name: 'Copy as Markdown', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { reportProofMarkdown?: string }).reportProofMarkdown))
    .toBe(`# ${report.title}\n\n${report.body_md}`);

  const live = await page.locator('.reports-body').evaluate(body => ({
    text: body.textContent || '',
    headings: Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'), node => node.textContent || ''),
  }));
  expect(live.text.trim()).not.toBe('');
  await expect(page.getByRole('navigation', { name: 'On this page' }).getByRole('link')).toHaveText(live.headings);

  // Preserve the actual renderer's DOM and styles; do not introduce another Markdown parser.
  const html = await page.evaluate(title => {
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const article = document.createElement('main'); article.className = 'reports-article-main';
    article.append(document.querySelector('.reports-article-main > h2')!.cloneNode(true));
    article.append(document.querySelector('.reports-body')!.cloneNode(true));
    article.querySelectorAll('script,iframe,object,embed').forEach(node => node.remove());
    article.querySelectorAll('*').forEach(node => {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith('on') || attr.name === 'srcset' ||
            (attr.name === 'src' && !attr.value.startsWith('data:'))) node.removeAttribute(attr.name);
      }
    });
    const css = Array.from(document.styleSheets).flatMap(sheet => {
      try { return Array.from(sheet.cssRules, rule => rule.cssText); } catch { return []; }
    }).filter(rule => !/^@(import|font-face)\b/i.test(rule)).join('\n').replace(/url\([^)]*\)/gi, 'none');
    const reset = 'html,body{height:auto;overflow:visible}body{margin:0;padding:2rem}.reports-article-main{height:auto;max-height:none;overflow:visible;max-width:1000px;margin:auto}';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escape(title)}</title><style>${css.replace(/<\/style/gi, '<\\/style')}\n${reset}</style></head><body>${article.outerHTML}</body></html>`;
  }, report.title);
  const exportPath = testInfo.outputPath('published-report.html');
  await writeFile(exportPath, html, 'utf8');
  const offline = await page.context().newPage();
  const requests: string[] = [];
  offline.on('request', request => { if (request.url().startsWith('http:') || request.url().startsWith('https:')) requests.push(request.url()); });
  await offline.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
  try {
    await offline.goto(pathToFileURL(exportPath).href, { waitUntil: 'load' });
    await expect(offline).toHaveTitle(report.title);
    await expect(offline.locator('.reports-article-main > h2')).toHaveText(report.title);
    expect(await offline.locator('.reports-body').textContent()).toBe(live.text);
    await expect(offline.locator('.reports-body').locator('h1,h2,h3,h4,h5,h6')).toHaveText(live.headings);
    await expect(offline.locator('.reports-body')).toBeVisible();
    expect(requests, 'Standalone report must not fetch external resources').toEqual([]);
    await offline.screenshot({ path: testInfo.outputPath('published-report-offline.png'), fullPage: true });
  } finally { await offline.close(); }
  const proof = {
    reportId: report.report_id, title: report.title, headings: live.headings,
    sourceMarkdownSha256: createHash('sha256').update(report.body_md).digest('hex'),
    renderedTextSha256: createHash('sha256').update(live.text).digest('hex'),
    exportSha256: createHash('sha256').update(html).digest('hex'), exportPath, externalRequests: requests,
    scope: 'Selected reader, exact Copy as Markdown, outline, and offline title/headings/rendered text parity only.',
  };
  await testInfo.attach('published-report-proof', { body: JSON.stringify(proof, null, 2), contentType: 'application/json' });
  await testInfo.attach('published-report-html', { path: exportPath, contentType: 'text/html' });
  await writeFile(testInfo.outputPath('published-report-proof.json'), JSON.stringify(proof, null, 2));
  return proof;
}

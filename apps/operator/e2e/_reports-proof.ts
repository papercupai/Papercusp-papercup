/** Maintained browser instrument for published-report and offline-export proof. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from './_egress';

export interface PublishedReportProof {
  report_id: string;
  title: string;
  body_md: string;
  workspace_id: string;
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
  const pending = new Set<Promise<void>>();
  const queryName = (url: string) => {
    const parsed = new URL(url);
    return parsed.pathname.endsWith('/rest-query') ? parsed.searchParams.get('name') : null;
  };
  page.on('request', request => {
    const name = queryName(request.url());
    if (name?.startsWith('reports.') && requests.length < 100) requests.push({ atMs: Date.now() - started, phase: 'requested', name });
  });
  page.on('requestfailed', request => {
    const name = queryName(request.url());
    if (name?.startsWith('reports.') && requests.length < 100) requests.push({ atMs: Date.now() - started, phase: 'failed', name, error: request.failure()?.errorText });
  });
  page.on('response', response => {
    const name = queryName(response.url());
    if (!name?.startsWith('reports.')) return;
    const task = (async () => {
      const status = response.status();
      try {
        const payload = await response.json();
        requests.push({ atMs: Date.now() - started, phase: 'completed', name, status,
          reportIds: payload.rows?.map((row: { report_id?: string }) => row.report_id) });
      } catch (error) { requests.push({ atMs: Date.now() - started, phase: 'body-failed', name, status, error: String(error) }); }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  await page.addInitScript(() => {
    const timeline: unknown[] = [];
    (window as unknown as { reportProofTimeline: unknown[] }).reportProofTimeline = timeline;
    let last = '';
    const observer = new MutationObserver(() => {
      const snapshot = {
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
    const rendering = await page.evaluate(() => (window as unknown as { reportProofTimeline?: unknown[] }).reportProofTimeline).catch(error => ({ unavailable: String(error) }));
    const evidence = JSON.stringify({ requests, rendering }, null, 2);
    await writeFile(testInfo.outputPath('report-readiness.json'), evidence);
    await testInfo.attach('report-readiness', { body: evidence, contentType: 'application/json' });
  };
}

/** Navigation is ready only after the selected report query finishes with exact saved text. */
export async function navigateToPublishedReport(page: Page, report: PublishedReportProof) {
  const query = page.waitForResponse(response => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith('/rest-query') || url.searchParams.get('name') !== 'reports.get') return false;
    try { return JSON.parse(url.searchParams.get('args') || '{}').reportId === report.report_id; }
    catch { return false; }
  });
  const [, response] = await Promise.all([
    page.goto(`/reports?sel=${encodeURIComponent(report.report_id)}&ws=${encodeURIComponent(report.workspace_id)}`), query,
  ]);
  expect(response.ok(), 'Selected report query must complete successfully').toBe(true);
  const payload = await response.json();
  expect(payload.rows?.find((row: PublishedReportProof) => row.report_id === report.report_id))
    .toMatchObject({ report_id: report.report_id, title: report.title, body_md: report.body_md });
}

/** Vditor assigns these ids only on script load, before resolving preview().
 * Cold asset initialization belongs to navigation readiness, before the short
 * content/geometry assertions. A visible body alone can precede onParsed.
 */
export async function waitForReportRenderer(page: Page): Promise<void> {
  await page.waitForFunction(() => [
    'vditorLuteScript', 'vditorI18nScripten_US', 'vditorIconScript',
  ].every(id => {
    const script = document.getElementById(id);
    return script instanceof HTMLScriptElement &&
      new URL(script.src).origin === location.origin &&
      new URL(script.src).pathname.startsWith('/vditor/');
  }));
}

export async function verifyPublishedReportAndOfflineExport(
  page: Page, report: PublishedReportProof, testInfo: TestInfo, readerTimeout = 15_000,
) {
  // HTTP status alone cannot prove a route exists: older builds return the Accounts shell.
  await expect(page.locator('.reports-reader'), 'The selected Reports reader must mount').toHaveCount(1, { timeout: readerTimeout });
  expect(new URL(page.url()).searchParams.get('sel')).toBe(report.report_id);
  await expect(page.locator('.reports-article-main > h2')).toHaveText(report.title);
  await waitForReportRenderer(page);
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

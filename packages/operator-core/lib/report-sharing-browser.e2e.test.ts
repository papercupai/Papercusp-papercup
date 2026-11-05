/** Real Chromium acceptance through the maintained Vitest e2e route. The
 * separate opt-in Pages lifecycle spec owns publication of harmless fixtures. */
import { createServer } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReportViewer } from './report-sharing-viewer';

const id = 'a'.repeat(32);
const fragment = new URLSearchParams({ gist: 'alice/' + id });
const markdown = '# Shared fixture\n\n## Findings\n\n| Item | Result |\n|---|---|\n| browser | passed |\n\n```js\nconst result = true;\n```\n\n## Diagram\n\n```mermaid\ngraph TD; A[Read] --> B[Done]\n```\n\n## Findings\n\n## 日本語';
const envelope = (content = markdown) => ({ id, public: false, owner: { login: 'alice' }, files: { 'report.md': { content } } });
let browser: Browser;
let origin: string;
let assets: Awaited<ReturnType<typeof buildReportViewer>>;
const server = createServer((req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname;
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!Object.hasOwn(assets.files, name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.end(assets.files[name]);
});
beforeAll(async () => {
  assets = await buildReportViewer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing reader fixture address');
  origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
async function ready(page: Page) {
  await page.goto(origin + '/#' + fragment);
  await page.locator('#report:not([hidden])').waitFor();
}

describe('shared report production browser bundle', () => {
  it('renders Markdown and sanitized diagrams, keeps unique Unicode outline links, and fits mobile', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    let tracker = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://tracker.invalid/**', async route => { tracker++; await route.abort(); });
    await page.route('https://api.github.com/gists/**', route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(envelope(markdown + '\n<script>globalThis.canary=1</script><img src="https://tracker.invalid/pixel" onerror="globalThis.canary=2"><iframe srcdoc="bad"></iframe>\n\n[unsafe](javascript:globalThis.canary=3)')) }));
    try {
      await ready(page);
      await page.locator('.diagram svg').waitFor();
      expect(await page.getByRole('table').textContent()).toContain('browser');
      expect(await page.locator('code.language-js').textContent()).toContain('const result');
      const headings = await page.locator('#report h1,#report h2').evaluateAll(nodes => nodes.map(node => node.id));
      expect(new Set(headings).size).toBe(headings.length);
      await page.getByRole('navigation', { name: 'On this page' }).getByText('日本語').click();
      expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('gist')).toBe('alice/' + id);
      await page.reload();
      await page.locator('.diagram svg').waitFor();
      expect(await page.evaluate(() => Reflect.get(globalThis, 'canary'))).toBeUndefined();
      expect(tracker).toBe(0);
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  }, 30_000);

  it('uses fresh canonical anonymous API reads and refuses deletion despite a stale raw CDN response', async () => {
    const reads: string[] = [];
    let deleted = false;
    let rawReads = 0;
    for (const phase of ['before', 'after']) {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const page = await context.newPage();
      await page.route('https://gist.githubusercontent.com/**', async route => { rawReads++; await route.fulfill({ body: markdown }); });
      await page.route('https://api.github.com/gists/**', route => {
        reads.push(route.request().url());
        expect(route.request().headers().authorization).toBeUndefined();
        return route.fulfill({ status: deleted ? 404 : 200, contentType: 'application/json', body: JSON.stringify(deleted ? { message: 'Not Found' } : envelope()) });
      });
      try {
        if (phase === 'before') await ready(page);
        else {
          await page.goto(origin + '/#' + fragment);
          await page.getByRole('alert').waitFor();
          expect(await page.getByRole('alert').textContent()).toMatch(/unavailable|sharing has stopped/);
          expect(await page.locator('#report').isVisible()).toBe(false);
        }
      } finally { await context.close(); }
      deleted = true;
    }
    expect(reads).toHaveLength(2);
    const nonces = reads.map(url => new URL(url).searchParams.get('read'));
    expect(nonces.every(Boolean)).toBe(true);
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(rawReads).toBe(0);
  }, 30_000);

  it.each([
    { label: 'public Gist', status: 200, body: { ...envelope(), public: true }, message: /could not load/i },
    { label: 'wrong owner', status: 200, body: { ...envelope(), owner: { login: 'mallory' } }, message: /could not load/i },
    { label: 'anonymous rate limit', status: 403, body: { message: 'rate limit exceeded' }, message: /limit|retry/i },
  ])('fails closed for $label', async ({ status, body, message }) => {
    const page = await browser.newPage();
    await page.route('https://api.github.com/gists/**', route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
    try {
      await page.goto(origin + '/#' + fragment);
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').textContent()).toMatch(message);
      expect(await page.locator('#report').isVisible()).toBe(false);
    } finally { await page.close(); }
  });
});

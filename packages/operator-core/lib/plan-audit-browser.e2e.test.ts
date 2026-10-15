/** Real Chromium exercises the production shared renderer through HTTP. This
 * registered Vitest e2e check is runnable by the acceptance test router. */
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPlanAuditReport } from './plan-audit-report';
const document = { generatedAt: '2026-10-07T00:00:00Z', rows: Array.from({ length: 95 }, (_, n) => ({ slug: 'plan-' + n, title: 'Plan ' + String(n).padStart(2, '0'), category: n % 2 ? 'Finish' : 'History', status: 'active', provenance: n % 2 ? 'outside-blender' : 'blender', harness: n % 2 ? 'other' : 'papercusp', implementation: 'Built ' + n, citations: [{ path: 'src/' + n + '.ts' }] })) };
let browser: Browser;
let url: string;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Exercise the product's actual isolation boundary, not merely a plain iframe.
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.end(req.url === '/embed' ? '<iframe title="Audit" sandbox="allow-scripts allow-downloads" src="/report"></iframe>' : renderPlanAuditReport(document));
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();if (!address || typeof address === 'string') throw new Error('Missing browser fixture address');
  url = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close();await new Promise<void>(resolve => server.close(() => resolve())); });
describe('audit report browser navigation', () => {
  it('renders and navigates when embedded in the product sandbox', async () => {
    const page = await browser.newPage();const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(url + '/embed');
      const frame = page.frameLocator('iframe');
      await frame.locator('#detail h2').waitFor();
      expect(await frame.locator('#detail').textContent()).toContain('Built 0');
      await frame.getByRole('searchbox').fill('Plan 05');
      expect(await frame.locator('#detail').textContent()).toContain('Built 5');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
  it('retains complete evidence across pagination, filters, deep-link reload and mobile viewport', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(url + '/#plan=plan-94');
      expect(await page.locator('#detail').textContent()).toContain('src/94.ts');
      expect(await page.locator('#results button').count()).toBeLessThanOrEqual(40);
      expect(await page.locator('#audit').evaluate(node => JSON.parse(node.textContent!).rows.length)).toBe(95);
      await page.getByRole('searchbox').fill('Plan 05');
      expect(await page.locator('#shown').textContent()).toBe('1 of 95 records');
      expect(await page.locator('#detail').textContent()).toContain('Built 5');
      await page.reload();expect(await page.locator('#detail').textContent()).toContain('Built 5');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole('searchbox').fill('missing');
      expect(await page.locator('#detail').textContent()).toContain('No matching plans');
      await page.getByRole('button', { name: 'Evidence & limits' }).click();
      expect(await page.locator('dialog').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await page.locator('dialog').isVisible()).toBe(false);
    } finally { await page.close(); }
  });
  it('preserves filter and selection links on reload, exports all evidence and supports keyboard selection', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await page.getByRole('navigation', { name: 'Audit categories' }).getByRole('button', { name: 'Finish 47', exact: true }).click();
      await page.getByRole('combobox', { name: 'Plan source' }).selectOption('outside-blender');
      await page.getByRole('combobox', { name: 'Plan harness' }).selectOption('other');
      await page.getByRole('combobox', { name: 'Sort audit plans' }).selectOption('remaining');
      await page.getByRole('searchbox').fill('Plan 05');
      const result = page.locator('#results button').first();
      await result.focus();await page.keyboard.press('Enter');
      expect(await page.locator('#detail').textContent()).toContain('src/5.ts');
      const selectionUrl = page.url();
      await page.reload();
      expect(page.url()).toBe(selectionUrl);
      expect(await page.getByRole('searchbox').inputValue()).toBe('Plan 05');
      expect(await page.getByRole('combobox', { name: 'Plan source' }).inputValue()).toBe('outside-blender');
      expect(await page.getByRole('combobox', { name: 'Plan harness' }).inputValue()).toBe('other');
      expect(await page.getByRole('combobox', { name: 'Sort audit plans' }).inputValue()).toBe('remaining');
      expect(await page.locator('#shown').textContent()).toBe('1 of 95 records');
      expect(await page.locator('#detail').textContent()).toContain('src/5.ts');
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download full JSON' }).click();
      const stream = await (await downloaded).createReadStream();
      if (!stream) throw new Error('No exported JSON stream');
      const chunks = [];for await (const chunk of stream) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(document);
    } finally { await page.close(); }
  });
});

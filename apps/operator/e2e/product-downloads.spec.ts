import { test, expect, type BrowserContext } from './_egress';
import type { HydratedRelease } from '../lib/release/release-history-page';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const origin = 'https://downloads.papercusp.test';
// The renderer is served entirely by `serve` below, rather than the operator
// configured by the default browser profile. Declare the route-fulfilled origin
// explicitly: the egress destination check also applies to documentOrigin.
// The public demo video is expected page traffic (release-video.ts); serve
// aborts it before any egress.
test.use({ channel: 'chrome', baseURL: origin,
  egressAllowedOrigins: [origin, 'https://clips.papercusp.com'] });
const sha = 'a'.repeat(64);
const products = [
  { product: 'server' as const, platform: 'linux-x86_64', name: 'server.deb' },
  { product: 'gui' as const, platform: 'linux-x86_64', name: 'desktop.deb' },
  { product: 'mobile' as const, platform: 'android-universal', name: 'android.apk' },
  { product: 'mobile' as const, platform: 'ios-arm64', name: 'iphone.ipa' },
];
const release: HydratedRelease = {
  row: { version: '0.0.25', channel: 'alpha', cutAt: new Date('2026-10-12T00:00:00Z'),
    publishedAt: null, gitSha: 'b'.repeat(40), cutBy: 'test', notes: null,
    changelogMd: '', workItemIds: [], planSlugs: [],
    artifacts: products.map(a => ({ ...a, url: `release/${a.name}`, size: 1000, sha256: sha })) },
  items: [], plans: [], internalCount: 0,
};
// Load the actual CommonJS TS renderer inside the ESM worker using the same
// in-process bridge as public-manual-product.spec.ts. Runner-owned setup avoids
// a module-load subprocess with a separate timeout before any test can start.
const root = resolve(import.meta.dirname, '../../..');
let html: string;
test.beforeAll(async () => {
  const imported = await tsImport(pathToFileURL(resolve(root,
    'apps/operator/lib/release/release-history-page.ts')).href, import.meta.url);
  const { renderIndexHtml } = { ...imported.default, ...imported };
  html = renderIndexHtml([release], {
    generatedAt: new Date('2026-10-12T00:00:00Z'), analytics: null, redact: [],
  });
});

async function serve(context: BrowserContext, malicious = false, mac = false) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/pui/latest.json') return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ artifacts: { ...(mac ? Object.fromEntries(['macos-aarch64', 'macos-x86_64'].map(target => [target,
        { target, version: '0.1.0', archiveSha256: sha, archiveUrl: `${origin}/pui/0.1.0/pui-0.1.0-${target}.tar.gz` }])) : {}),
        'linux-x86_64': { target: 'linux-x86_64', version: '0.1.0',
        archiveSha256: sha, archiveUrl: malicious ? 'https://other.test/wrong.tar.gz'
          : `${origin}/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz` } } }) });
    if (url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ status: 404, body: '' });
  });
}

for (const width of [1440, 390]) test(`five download products work by menu and keyboard at ${width}px`, async ({ context, page }, info) => {
  await serve(context);
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/index.html`);
  for (const [id, name] of [['server', 'Desktop Server'], ['gui', 'Desktop GUI'],
    ['psu', 'PSU + PUI'], ['android', 'Android'], ['iphone', 'iPhone']]) {
    await page.locator(`label[for="choose-${id}"]`).click();
    await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
    await expect(page.locator(`#download-${id}`)).toBeVisible();
    await expect(page.locator('.download-panel:visible')).toHaveCount(1);
    if (id !== 'server') {
      await expect(page.getByRole('link', { name: 'server.deb', exact: true })).toHaveCount(0);
      await expect(page.locator('#instructions-body')).toBeHidden();
    }
  }
  await page.locator('#choose-gui').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'PSU + PUI', exact: true })).toBeChecked();
  await expect(page.getByRole('link', { name: /Download Linux x86_64.*PSU \+ PUI/ })).toHaveAttribute('href',
    `${origin}/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz`);
  await expect(page.getByRole('link', { name: /Download Windows \(WSL2\).*PSU \+ PUI/ })).toHaveAttribute('href',
    `${origin}/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz`);
  await expect(page.getByText('Uses the same download as Linux.', { exact: true })).toBeVisible();
  await expect(page.getByText('Apple Silicon: no verified standalone download is published yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('PSU and PUI are included.', { exact: false })).toBeVisible();
  const geometry = await page.evaluate(() => ({ viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('.product-downloads *')].filter(el =>
      el.getBoundingClientRect().right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1)
      .map(el => ({ element: el.id || el.className || el.tagName, width: el.clientWidth,
        scrollWidth: el.scrollWidth, text: el.textContent?.slice(0, 140) })) }));
  await info.attach('download-layout', { contentType: 'application/json', body: Buffer.from(JSON.stringify(geometry)) });
  console.log('DOWNLOAD_LAYOUT', JSON.stringify(geometry));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath(`downloads-${width}.png`), fullPage: true });
});

test('verified macOS packages replace only their unavailable platform messages', async ({ context, page }) => {
  await serve(context, false, true);
  await page.goto(`${origin}/index.html#download-psu`);
  for (const [name, target] of [['macOS Apple Silicon', 'macos-aarch64'], ['macOS Intel', 'macos-x86_64']]) {
    await expect(page.getByRole('link', { name: `Download ${name} — PSU + PUI 0.1.0`, exact: true })).toHaveAttribute('href',
      `${origin}/pui/0.1.0/pui-0.1.0-${target}.tar.gz`);
  }
  await expect(page.locator('#psu-mac-arm')).not.toContainText('not published');
  await expect(page.locator('#psu-mac-intel')).not.toContainText('not published');
});

test('an unexpected PUI archive origin retains the ordinary download link', async ({ context, page }) => {
  await serve(context, true);
  await page.goto(`${origin}/index.html#download-psu`);
  await expect(page.getByRole('radio', { name: 'PSU + PUI', exact: true })).toBeChecked();
  await expect(page.getByRole('link', { name: 'Download PSU bundled with PUI' })).toHaveAttribute('href', 'pui/index.html');
  await expect(page.locator('a[href="https://other.test/wrong.tar.gz"]')).toHaveCount(0);
});

test.describe('without JavaScript', () => {
  // Keep this case in the context watched by the shared egress audit.
  test.use({ javaScriptEnabled: false });
  test('native product tabs and published links work without JavaScript', async ({ context, page }) => {
    await serve(context);
    await page.goto(`${origin}/index.html`);
    await page.locator('label[for="choose-server"]').click();
    await expect(page.locator('#download-server')).toBeVisible();
    await expect(page.getByRole('link', { name: 'server.deb', exact: true }).first()).toBeVisible();
    await page.locator('label[for="choose-psu"]').click();
    await expect(page.getByRole('link', { name: 'Download PSU bundled with PUI' })).toBeVisible();
  });
});

/**
 * Docs HTTP routes — the agent-readable internal-docs surface.
 *
 * The engineering docs are Starlight static output (apps/operator-docs)
 * copied into apps/operator/public/internal/docs/ and served by Next as
 * static assets under `/internal/docs`. next.config.js rewrites bare
 * slugs to their `.html` twin; proxy.ts gates the surface to loopback
 * hosts. Per-page `.md` twins are emitted by
 * apps/operator-docs/scripts/emit-md-twins.ts (using
 * @papercusp/docs-engine's renderMdxToMarkdown) and served via
 * proxy.ts's `Accept: text/markdown` rewrite to <slug>.md.
 *
 *   /internal/docs                                   — docs home (index.html)
 *   /internal/docs/<slug>                            — page (rewritten to <slug>.html)
 *   /internal/docs/<section>/<slug>                  — nested page
 *   /internal/docs/<slug>  (Accept: text/markdown)   — page as clean markdown (.md twin)
 *   /internal/docs/llms.txt                          — sitemap-style index
 *   /internal/docs/llms-full.txt                     — full corpus concatenated
 *   /internal/docs/llms-small.txt                    — abridged corpus
 *
 * The spec runs against a loopback baseURL, so proxy.ts's loopback gate
 * permits every request.
 */
import { test, expect } from './_egress';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('docs routes', () => {
  test.describe.configure({ mode: 'default' });
  test.beforeAll(async ({}, info) => {
    if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return;
    const sourceRoot = process.env.OPERATOR_SOURCE_ROOT;
    expect(sourceRoot, 'Docs fixtures must be generated from the frozen rig source').toBeTruthy();
    // Aggregate corpora are ignored build outputs, so a committed archive has
    // no llms-full/small.txt. Reuse the docs build against this isolated source
    // instead of copying mutable artifacts from the shared checkout.
    info.setTimeout(300_000);
    let output = '';
    try {
      const built = await promisify(execFile)('npm', ['run', 'build:inner', '--workspace=@papercupai/operator-docs'], {
        cwd: sourceRoot, timeout: 280_000, maxBuffer: 8 * 1024 * 1024,
      });
      output = built.stdout + built.stderr;
    } catch (error) {
      const failed = error as Error & { stdout?: string; stderr?: string };
      output = (failed.stdout ?? '') + (failed.stderr ?? '') + '\n' + failed.message;
      throw error;
    } finally {
      if (process.env.VH_PHASE_DIR) await writeFile(join(process.env.VH_PHASE_DIR, 'docs-build.log'), output);
      await info.attach('isolated-docs-build', { body: output, contentType: 'text/plain' });
    }
  });
  test('GET /internal/docs serves the docs home', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });

  test('renders the complete monitoring disclosure in the real documentation reader', async ({ page }, info) => {
    const sourceRoot = process.env.OPERATOR_SOURCE_ROOT ?? resolve(import.meta.dirname, '../../..');
    const documentPath = join(sourceRoot, 'apps/operator-docs/src/content/docs/posthog/index.mdx');
    const source = await readFile(documentPath, 'utf8');
    // The doc-claims suite independently compares these declarations with the
    // exported production schemas; this journey verifies the rendered reader.
    const events = [...new Set(source.match(/cloud_[a-z_]+/g) ?? [])];
    expect(events.length).toBeGreaterThan(0);
    const response = await page.goto(`${baseURL}/internal/docs/posthog`);
    expect(response?.status()).toBe(200);
    const body = page.locator('main');
    await expect(body).toContainText('PostHog');
    for (const event of events) await expect(body).toContainText(event);
    for (const term of ['retention', 'revocation', 'flags.papercuspai.com']) {
      await expect(body).toContainText(new RegExp(term.replaceAll('.', '\\.'), 'i'));
    }
    const html = await response!.text();
    const receipt = { url: page.url(), documentPath, events,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      servedHtmlSha256: createHash('sha256').update(html).digest('hex'),
      renderedText: await body.innerText() };
    await info.attach('monitoring-disclosure-reader', {
      body: JSON.stringify(receipt, null, 2), contentType: 'application/json',
    });
    await info.attach('monitoring-disclosure-reader-screen', {
      body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
    });
    console.info('CLOUD_MONITORING_BROWSER_READER ' + JSON.stringify(receipt));
  });

  test('GET /internal/docs/<slug> serves a rendered page', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/performance`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
    const body = await res.text();
    expect(body).toContain('Papercusp Internal'); // Starlight site title in <title>
  });

  test('GET /internal/docs/<slug>.html (explicit extension) serves the page', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/performance.html`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });

  test('GET /internal/docs/<section>/<slug> serves a nested page', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/endpoint-system/overview`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });

  test('GET /internal/docs/<unknown-slug> returns 404', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/totally-fake-slug-zzz`);
    expect(res.status()).toBe(404);
  });

  test('GET /internal/docs/llms.txt returns a plaintext index', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/llms.txt`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/text\/plain|text\/markdown/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/^# /m); // markdown headings present
  });

  test('GET /internal/docs/llms-full.txt returns the full corpus', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/llms-full.txt`, { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(10_000); // sanity: corpus is many KB
    expect(body).toMatch(/^# /m);
  });

  test('GET /internal/docs/llms-small.txt returns the abridged corpus', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/llms-small.txt`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test('GET /internal/docs/<slug> with Accept: text/markdown returns the .md twin', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/performance`, {
      headers: { Accept: 'text/markdown' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body).toMatch(/^# /m); // markdown title
    expect(body).toContain('URL: /internal/docs/performance'); // withPreamble header
    expect(body).not.toContain('<!DOCTYPE html>'); // definitely not HTML
  });

  test('GET /internal/docs/<slug> with Accept: text/html still returns HTML', async ({ request }) => {
    const res = await request.get(`${baseURL}/internal/docs/performance`, {
      headers: { Accept: 'text/html' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/html/);
  });
});

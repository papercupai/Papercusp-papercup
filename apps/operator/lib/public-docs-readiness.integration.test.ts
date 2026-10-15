import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { servePublicDocs } from '@papercusp/operator-core/lib/public-docs';
import { assertPublicManualFaq, PUBLIC_FAQ_ANCHORS } from '../../papercusp-docs/scripts/source-contract.mjs';

const suppliedRoot = process.env.PAPERCUSP_PUBLIC_DOCS_ROOT
  ? resolve(process.env.PAPERCUSP_PUBLIC_DOCS_ROOT)
  : undefined;
let root = suppliedRoot ?? '';
let buildDirectory: string | undefined;
const origin = process.env.PORTAL_DOCS_BASE_URL?.replace(/\/$/, '');

beforeAll(() => {
  if (suppliedRoot) return;
  // A fresh test invocation must exercise this source's actual Astro output.
  // Build in isolation instead of inheriting an older shared dist directory.
  const manualApp = resolve(import.meta.dirname, '../../papercusp-docs');
  // Keep output under the app's cwd: Astro stages external output elsewhere,
  // while the maintained content loader resolves its source from that cwd.
  const scratch = resolve(manualApp, '.astro');
  mkdirSync(scratch, { recursive: true });
  buildDirectory = mkdtempSync(resolve(scratch, 'public-manual-reader-'));
  root = resolve(buildDirectory, 'dist');
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  // Astro's private-env transform otherwise shadows Vite's computed builtins
  // with the string values inherited from the Vitest worker.
  for (const key of ['DEV', 'PROD', 'SSR', 'MODE', 'BASE_URL']) delete buildEnv[key];
  execFileSync(process.execPath, [
    '--input-type=module', '-e',
    "import { pathToFileURL } from 'node:url'; const { build } = await import(pathToFileURL(process.argv[4]).href); await build({ root: process.argv[1], outDir: process.argv[2], cacheDir: process.argv[3] });",
    manualApp, root, resolve(buildDirectory, 'cache'),
    createRequire(import.meta.url).resolve('astro'),
  ], { cwd: manualApp, env: buildEnv, timeout: 60_000 });
}, 65_000);

afterAll(() => {
  if (buildDirectory) rmSync(buildDirectory, { recursive: true, force: true });
});

async function readPublic(path: string, method = 'GET'): Promise<Response> {
  const request = new Request(`${origin ?? 'https://app.papercusp.com'}${path}`, { method });
  return origin
    ? fetch(request, { signal: AbortSignal.timeout(8_000) })
    : servePublicDocs(request, root);
}

describe('built public manual contract', () => {
  it('serves the FAQ with its published question anchors and working fuller guides', async () => {
    const response = await servePublicDocs(new Request('https://app.papercusp.com/docs/faq'), root);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-pagefind-body');
    expect(html).toContain('id="starlight__search"');
    expect(html).not.toContain('Search is only available in production builds.');
    const renderedAnchors = [...html.matchAll(/<h2\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(renderedAnchors).toEqual(expect.arrayContaining(PUBLIC_FAQ_ANCHORS));
    expect(new Set(renderedAnchors).size).toBe(renderedAnchors.length);
    const source = resolve(import.meta.dirname, '../../papercusp-docs/src/content/docs');
    const faq = assertPublicManualFaq(source);
    for (const link of new Set(faq.entries.flatMap((entry) => entry.guideLinks))) {
      expect(html).toContain(`href="${link}"`);
      expect((await servePublicDocs(new Request(`https://app.papercusp.com${link}`), root)).status, link).toBe(200);
    }
  });
  it('anonymous production reader checks assets, HEAD and private boundaries in bounded batches', async () => {
    const targets = new Set<string>(['/docs', '/docs/pagefind/pagefind.js', '/docs/sitemap-index.xml']);
    for (const file of readdirSync(root).filter((name) => name.endsWith('.html') && name !== '404.html')) {
      targets.add(`/docs/${file}`);
      for (const match of readFileSync(resolve(root, file), 'utf8').matchAll(/(?:href|src)="(\/docs[^"#?]*)/g)) {
        targets.add(match[1]);
      }
    }
    // The older cross-hive reader serially checked every asset twice and used up
    // its total scenario deadline before the private-boundary probe. Bound each
    // request and use four concurrent readers, not a blanket timeout increase.
    const publicPaths = [...targets];
    for (let start = 0; start < publicPaths.length; start += 4) {
      await Promise.all(publicPaths.slice(start, start + 4).map(async (path) => {
        const response = await readPublic(path);
        expect(response.status, path).toBe(200);
        const expected = await servePublicDocs(new Request(`https://app.papercusp.com${path}`), root);
        expect(Buffer.from(await response.arrayBuffer()), `${path}: exact artifact bytes`)
          .toEqual(Buffer.from(await expected.arrayBuffer()));
        const head = await readPublic(path, 'HEAD');
        expect(head.status, `${path}: HEAD`).toBe(200);
        expect(head.headers.get('content-type'), path).toBe(expected.headers.get('content-type'));
        expect((await head.arrayBuffer()).byteLength, path).toBe(0);
      }));
    }
    expect((await readPublic('/docs/zz-no-such-public-doc-78291')).status).toBe(404);
    for (const path of ['/docs/%252e%252e/internal/docs/search-palette.html', '/docs/%2fapi%2fadmin', '/docs/%00']) {
      expect([400, 401, 403, 404], path).toContain((await readPublic(path)).status);
    }
    if (origin) {
      expect([400, 401, 403, 404]).toContain((await readPublic('/internal/docs/search-palette.html')).status);
    }
  });
  it.each(['quickstart', 'plans-and-work', 'agent-modes-and-fleets', 'accounts-and-billing', 'voice'])(
    'serves a new guide as indexed article content: %s', async (slug) => {
      const response = await servePublicDocs(new Request(`https://app.papercusp.com/docs/${slug}`), root);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-pagefind-body');
      expect(html).toContain(`https://app.papercusp.com/docs/${slug}`);
    },
  );
  it('serves every built search resource, including binary formats fetched by JavaScript', async () => {
    const files = readdirSync(resolve(root, 'pagefind'), { recursive: true })
      .filter((name): name is string => typeof name === 'string' && statSync(resolve(root, 'pagefind', name)).isFile());
    expect(files.some((name) => name.endsWith('.pf_index'))).toBe(true);
    for (const name of files) {
      const response = await servePublicDocs(new Request(`https://app.papercusp.com/docs/pagefind/${name}`), root);
      expect(response.status, name).toBe(200);
      if (/\.pf_(meta|index|fragment)$/.test(name)) expect(response.headers.get('content-type'), name).toBe('application/octet-stream');
    }
  });
  it('builds searchable HTML with the public canonical origin', async () => {
    const index = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(index).toContain('https://app.papercusp.com/docs');
    expect(index).not.toContain('href="/docs/docs.html"');
    expect(existsSync(resolve(root, 'pagefind/pagefind.js'))).toBe(true);
    expect(existsSync(resolve(root, 'sitemap-index.xml'))).toBe(true);
    const page = await servePublicDocs(new Request('https://app.papercusp.com/docs'), root);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('public user manual');
  });
  it('built page links and local assets resolve through the actual public reader', async () => {
    const targets = new Set<string>();
    for (const file of readdirSync(root).filter((name) => name.endsWith('.html') && name !== '404.html')) {
      const text = readFileSync(resolve(root, file), 'utf8');
      for (const match of text.matchAll(/(?:href|src)="(\/docs[^"#?]*)/g)) targets.add(match[1]);
    }
    expect(targets.size).toBeGreaterThan(10);
    for (const target of targets) {
      const response = await servePublicDocs(new Request(`https://app.papercusp.com${target}`), root);
      expect(response.status, target).toBe(200);
    }
  });
});

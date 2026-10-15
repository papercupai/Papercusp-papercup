import { it, expect } from 'vitest';
import { chromium, expect as browserExpect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { servePublicDocs } from '@papercusp/operator-core/lib/public-docs';
import { frontmatterDocuments, parseDocumentsField } from '@papercusp/operator-core/lib/harness/docs/subject-ref';

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, '../../..');
const manual = join(repo, 'apps/papercusp-docs');
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Exercise the maintained Astro/Starlight builder, packaging script, public
// reader and browser together. All source mutations and outputs are private;
// this test never rebuilds the operator or replaces its shared public bundle.
it('propagates a manual source revision through packaging and warmed browser Pagefind search', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'public-manual-pagefind-revision-'));
  const app = join(fixture, 'apps/papercusp-docs');
  const publicRoot = join(fixture, 'apps/operator/public/docs');
  const bundledSource = join(fixture, 'apps/operator/public/manual-source');
  const source = join(app, 'src/content/docs/faq.mdx');
  const suffix = randomUUID().replaceAll('-', '');
  const red = `orchardrevisionred${suffix}`;
  const blue = `orchardrevisionblue${suffix}`;
  const evidence: Record<string, unknown> = { id: 'pagefind-manual-revision', modelCalls: 0 };
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: { path: string; status: number }[] = [];
  let stage = 'prepare';
  let passed = false;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await cp(manual, app, { recursive: true, filter: (path) =>
      !relative(manual, path).split('/').some((part) => ['node_modules', '.astro', 'dist', '.git'].includes(part)) });
    await symlink(join(repo, 'node_modules'), join(fixture, 'node_modules'), 'dir');
    // Keep the source-impact contract active in the copied app. Its concrete
    // anchors are real copied files, not symlinks escaping the fixture root.
    const anchors = new Set(['packages/operator-core/lib/harness/docs/subject-ref.ts']);
    for (const file of await readdir(join(app, 'src/content/docs'))) {
      if (!/\.mdx?$/.test(file)) continue;
      const text = await readFile(join(app, 'src/content/docs', file), 'utf8');
      for (const ref of parseDocumentsField(frontmatterDocuments(text))) {
        expect(ref.kind).toBe('path');
        if (ref.kind === 'path') for (const path of ref.globs) anchors.add(path);
      }
    }
    for (const path of anchors) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await cp(join(repo, path), join(fixture, path), { recursive: true });
    }
    const original = await readFile(source, 'utf8');
    evidence.originalFaqSha256 = sha256(original);
    const astroEntry = createRequire(join(manual, 'package.json')).resolve('astro');
    evidence.inheritedBuildEnvironment = Object.fromEntries(
      ['NODE_ENV', 'DEV', 'PROD', 'SSR', 'MODE', 'BASE_URL'].map((key) => [key, process.env[key] ?? null]));
    const buildAndCopy = async (marker: string, nodeEnv = 'production') => {
      stage = nodeEnv === 'test' ? 'build:development-control' : `build:${marker === red ? 'before' : 'after'}`;
      await writeFile(source, `${original}\n\nThe public index revision marker is ${marker}.\n`);
      const buildEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv, PAPERCUSP_LINT_AS_COMMITTED_CLONE: '1' };
      // Vitest mirrors Vite's builtins into process.env. Astro treats those as
      // private string defines before Vite can supply its computed booleans.
      for (const key of ['DEV', 'PROD', 'SSR', 'MODE', 'BASE_URL']) delete buildEnv[key];
      const { stdout } = await run(process.execPath, [
        '--input-type=module', '-e',
        "import { pathToFileURL } from 'node:url'; const before = process.env.NODE_ENV; const { build } = await import(pathToFileURL(process.argv[2]).href); await build({ root: process.argv[1] }); console.log('MANUAL_BUILD_ENV ' + JSON.stringify({ before, after: process.env.NODE_ENV }));",
        app, astroEntry,
      ], { cwd: app, env: buildEnv, timeout: 60_000 });
      expect(stdout).toContain('Pagefind');
      await run('bash', ['scripts/postbuild-copy.sh'], { cwd: app, timeout: 10_000 });
      const canonical = await readFile(source);
      expect(await readFile(join(bundledSource, 'faq.mdx'))).toEqual(canonical);
      const response = await servePublicDocs(new Request('http://localhost/docs/faq'), publicRoot);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      const html = await response.text();
      expect(html).toContain(marker);
      const productionSearch = html.includes('id="starlight__search"');
      const developmentWarning = html.includes('Search is only available in production builds.');
      evidence.lastBuild = { nodeEnv, productionSearch, developmentWarning,
        childEnvironment: stdout.match(/MANUAL_BUILD_ENV (.+)/)?.[1],
        searchMarkup: html.match(/<site-search\b[\s\S]*?<\/site-search>/)?.[0] };
      expect(productionSearch, `${nodeEnv}: production search mount`).toBe(nodeEnv === 'production');
      expect(developmentWarning, `${nodeEnv}: development search warning`).toBe(nodeEnv !== 'production');
      return { nodeEnv, productionSearch, developmentWarning,
        sourceSha256: sha256(canonical), servedHtmlSha256: sha256(html),
        pagefindEntrySha256: sha256(await readFile(join(publicRoot, 'pagefind/pagefind-entry.json'))) };
    };
    // Programmatic Astro builds preserve NODE_ENV. Reproduce the inherited
    // Vitest environment so an index on disk cannot masquerade as a working UI.
    evidence.developmentControl = await buildAndCopy(red, 'test');
    evidence.before = await buildAndCopy(red);
    const resources = new Set<string>();
    server = createServer(async (request, response) => {
      try {
        const path = request.url ?? '/';
        if (path.startsWith('/docs/pagefind/')) resources.add(path);
        const result = await servePublicDocs(new Request(`http://localhost${path}`, { method: request.method }), publicRoot);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        response.writeHead(500); response.end(String(error));
      }
    });
    await new Promise<void>((ok, fail) => {
      server!.once('error', fail); server!.listen(0, '127.0.0.1', ok);
    });
    const address = server.address();
    expect(address && typeof address === 'object').toBe(true);
    const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage();
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('requestfailed', (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', (response) => {
      if (response.status() >= 400) badResponses.push({ path: response.url(), status: response.status() });
    });
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const search = async (marker: string, present: boolean) => {
      stage = `search:${marker === red ? 'red' : 'blue'}:${present ? 'present' : 'absent'}`;
      const dialog = page.getByRole('dialog');
      await browserExpect(dialog).toBeVisible();
      await browserExpect(dialog.locator('input').first()).toBeVisible({ timeout: 10_000 });
      // Exact phrases keep Pagefind's fuzzy fallback for long synthetic tokens
      // from returning unrelated pages and weakening the revision oracle.
      await dialog.locator('input').first().fill(`"${marker}"`, { timeout: 10_000 });
      const faq = dialog.locator('.pagefind-ui__result-link').filter({ hasText: 'Common questions' });
      if (present) {
        await browserExpect(faq.first()).toBeVisible({ timeout: 10_000 });
        await browserExpect(dialog.locator('.pagefind-ui__result-excerpt').first())
          .toContainText(marker, { timeout: 10_000 });
      }
      else {
        await browserExpect(dialog.locator('.pagefind-ui__message')).toContainText('No results', { timeout: 10_000 });
        await browserExpect(faq).toHaveCount(0);
      }
    };
    await page.goto(`${origin}/docs/faq`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await search(red, true);
    // Keep the browser module import out of Vite's SSR transform: a serialized
    // callback with __vite_ssr_dynamic_import__ cannot execute in Chromium.
    evidence.searchCalibration = await page.evaluate(`(async () => {
      const { red, blue, pagefindUrl } = ${JSON.stringify({ red, blue, pagefindUrl: '/docs/pagefind/pagefind.js' })};
      const pagefind = await import(/* @vite-ignore */ pagefindUrl);
      const observations = [];
      for (const query of [red, blue, '"' + blue + '"', 'unfindabletundra']) {
        const result = await pagefind.search(query);
        const hits = await Promise.all(result.results.slice(0, 2).map(async (hit) => {
          const data = await hit.data();
          return { url: data.url, red: data.content.includes(red), blue: data.content.includes(blue) };
        }));
        observations.push({ query, count: result.results.length, hits });
      }
      return observations;
    })()`);
    await search(blue, false);
    evidence.after = await buildAndCopy(blue);
    expect(evidence.after).not.toEqual(evidence.before);
    // Reuse the warmed browser/context and exact URL; a full reader reload
    // must fetch the rebuilt index rather than retain the old search answers.
    await page.reload();
    await browserExpect(page.getByRole('main')).toContainText(blue);
    await browserExpect(page.getByRole('main')).not.toContainText(red);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await search(blue, true);
    await search(red, false);
    expect([...resources].some((path) => /\.pf_index/.test(path))).toBe(true);
    expect([...resources].some((path) => /\.pf_fragment/.test(path))).toBe(true);
    evidence.browser = { sameOrigin: true, reusedContext: true, reload: true,
      before: { red: 'found', blue: 'absent' }, after: { blue: 'found', red: 'absent' },
      resources: [...resources].sort() };
    passed = true;
  } catch (error) {
    evidence.failure = String(error);
    throw error;
  } finally {
    await browser?.close();
    if (server) await new Promise<void>((ok, fail) => {
      server!.close((error) => error ? fail(error) : ok()); server!.closeAllConnections();
    });
    await rm(fixture, { recursive: true, force: true });
    console.log(`PUBLIC_MANUAL_REVISION_EVIDENCE ${JSON.stringify({ ...evidence, passed, stage,
      browserErrors, failedRequests, badResponses, privateCleanup: true })}`);
  }
}, 150_000);

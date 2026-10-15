/**
 * The public manual the product SERVES must contain every page the manual's
 * SOURCE defines (WI-10006957).
 *
 * The operator serves the tracked copy at apps/operator/public/docs/ under
 * /docs (bin/host-docs-public.ts). That copy only changes when someone runs
 * `npm --prefix apps/papercusp-docs run build`, whose postbuild-copy.sh mirrors
 * dist/ into it. Nothing in the pipeline runs that build, so new guides were
 * authored (plan public-manual-expansion-and-freshness-2026-10-03) while /docs
 * kept serving a 2026-08-15 build with 5 of 15 pages. public-manual.spec.ts
 * then failed x6 on every isolated e2e run, and the shipped manual had no
 * quickstart. This guard lives in the docs workspace so editing a guide selects
 * it: a source page with no served page fails here, at the author's commit.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const DOCS_DIR = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIR = join(DOCS_DIR, 'src/content/docs');
const SERVED_DIR = join(DOCS_DIR, '../operator/public/docs');
const BUNDLED_SOURCE_DIR = join(DOCS_DIR, '../operator/public/manual-source');
const REBUILD = 'npm --prefix apps/papercusp-docs run build';

function listSourcePages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourcePages(full));
    else if (/\.mdx?$/.test(name)) out.push(relative(SOURCE_DIR, full));
  }
  return out.sort();
}

/**
 * astro.config's `build: { format: 'file' }` emits `<slug>.html`, and a
 * directory index page becomes its directory's file (`guide/index.mdx` ->
 * `guide.html`). The root index stays `index.html`.
 */
function servedPathFor(sourceRel: string): string {
  const slug = sourceRel.replace(/\.mdx?$/, '').split('\\').join('/');
  if (slug === 'index') return 'index.html';
  return `${slug.replace(/\/index$/, '')}.html`;
}

describe('public manual: served build matches its source (WI-10006957)', () => {
  it('pins the file-format mapping this guard relies on', () => {
    const config = readFileSync(join(DOCS_DIR, 'astro.config.mjs'), 'utf8');
    expect(config).toMatch(/build:\s*\{\s*format:\s*'file'\s*\}/);
    expect(config).toMatch(/base:\s*'\/docs'/);
    expect(servedPathFor('index.mdx')).toBe('index.html');
    expect(servedPathFor('quickstart.mdx')).toBe('quickstart.html');
    expect(servedPathFor('guide/index.mdx')).toBe('guide.html');
    expect(servedPathFor('guide/setup.md')).toBe('guide/setup.html');
  });

  it(`every source page has a served page (fix: ${REBUILD})`, () => {
    const pages = listSourcePages(SOURCE_DIR);
    // Positive control: the walk must see the guides that motivated this
    // guard, or the parity check below passes vacuously.
    expect(pages).toEqual(expect.arrayContaining(['index.mdx', 'quickstart.mdx', 'plans-and-work.mdx']));
    const missing = pages
      .map((page) => ({ page, served: servedPathFor(page) }))
      .filter(({ served }) => !existsSync(join(SERVED_DIR, served)))
      .map(({ page, served }) => `${page} -> apps/operator/public/docs/${served}`);
    expect(missing, `source pages with no served build; run ${REBUILD}`).toEqual([]);
  });

  it(`the served copy carries a search index (fix: ${REBUILD})`, () => {
    expect(existsSync(join(SERVED_DIR, 'pagefind/pagefind.js'))).toBe(true);
  });

  it('the served search assets are complete gzip streams', () => {
    const searchRoot = join(SERVED_DIR, 'pagefind');
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) visit(file);
        else if (/\.(pagefind|pf_fragment|pf_index|pf_meta)$/.test(name)) {
          expect(() => gunzipSync(readFileSync(file)), `incomplete search asset: ${file}`).not.toThrow();
        }
      }
    };
    expect(existsSync(join(searchRoot, 'wasm.unknown.pagefind'))).toBe(true);
    visit(searchRoot);
  });

  it(`the fresh-install retrieval bundle has exactly the canonical public bytes (fix: ${REBUILD})`, () => {
    const pages = listSourcePages(SOURCE_DIR);
    expect(pages).toContain('faq.mdx');
    expect(existsSync(BUNDLED_SOURCE_DIR), `missing public retrieval bundle; run ${REBUILD}`).toBe(true);
    const bundled = readdirSync(BUNDLED_SOURCE_DIR).filter((name) => /\.mdx?$/.test(name)).sort();
    expect(bundled).toEqual(pages);
    for (const page of pages) {
      expect(readFileSync(join(BUNDLED_SOURCE_DIR, page), 'utf8'), `stale bundle: ${page}; run ${REBUILD}`)
        .toBe(readFileSync(join(SOURCE_DIR, page), 'utf8'));
    }
  });
});

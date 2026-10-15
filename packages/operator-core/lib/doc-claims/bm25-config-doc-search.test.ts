/** R-15: exercise the production docs keyword engine on the engineering tree. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { searchDocs, starlightContentAdapter, type DocSource } from '@papercusp/docs-engine';

const REPO = new URL('../../../../', import.meta.url);
const slug = 'agent-insights/pg-textsearch-bm25-configuration';

it('docs search returns the preload page, and a missing-page control cannot satisfy R-15', async () => {
  const source = starlightContentAdapter({
    contentRoot: fileURLToPath(new URL('apps/operator-docs/src/content/docs/', REPO)),
  });
  // Keep the established copy-out seam for semantic document mutations. The
  // ordinary case renders the real source, using the adapter docs:search uses.
  const corpus: DocSource = { ...source,
    getContent: (page, options) => page.slug === slug && process.env.BM25_CONFIG_DOC_PATH
      ? Promise.resolve(readFileSync(process.env.BM25_CONFIG_DOC_PATH, 'utf8'))
      : source.getContent(page, options),
  };
  for (const query of ['pg_textsearch configuration', 'pg_textsearch preload']) {
    const result = await searchDocs(corpus, { query, limit: 8 });
    expect(result.hits.map(hit => hit.slug), query).toContain(slug);
  }
  const page = await corpus.getPage(slug);
  expect(page, 'the returned hit must remain readable').not.toBeNull();
  const body = await corpus.getContent(page!);
  expect(body).toContain('Preload is mandatory');
  expect(body).toContain('shared_preload_libraries');

  // Same engine and corpus, with just the subject removed. This directly
  // exercises the absence falsifier without inventing ranked search results.
  const withoutPage: DocSource = { ...corpus,
    listPages: async () => (await corpus.listPages()).filter(page => page.slug !== slug),
    getPage: candidate => candidate === slug ? Promise.resolve(null) : corpus.getPage(candidate),
  };
  const control = await searchDocs(withoutPage, { query: 'pg_textsearch preload', limit: 8 });
  expect(control.hits.map(hit => hit.slug)).not.toContain(slug);
  expect(await withoutPage.getPage(slug)).toBeNull();
}, 120_000);

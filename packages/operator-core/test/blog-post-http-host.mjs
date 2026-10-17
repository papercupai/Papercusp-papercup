/** Native ESM host for the P024 proof. Built bundles never pass through tsx. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KEY = 'synthetic-blog-request-key';
export const CANONICAL = 'https://papercusp.com/blog/request-proof';
export const PUBLICATION = '0123456789abcdef01234567';

export function spawnBlogPostHttpHost(bundle, options) {
  return spawn(process.execPath, [fileURLToPath(import.meta.url), bundle], {
    ...options, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function serve(bundle) {
  const evidenceDir = process.env.BLOG_POST_EVIDENCE_DIR;
  assert.ok(evidenceDir, 'retained evidence directory required');
  // Intercept only the actual host network boundary, after credential injection.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return originalFetch(input, init);
    assert.ok(['dev.to', 'gql.hashnode.com'].includes(url.hostname), 'unexpected external fetch refused');
    assert.equal(url.protocol, 'https:');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    const devto = url.hostname === 'dev.to';
    assert.equal(url.pathname, devto ? '/api/articles' : '/');
    assert.equal(headers.get(devto ? 'api-key' : 'authorization'), devto ? KEY : `Bearer ${KEY}`);
    const body = JSON.parse(String(init?.body));
    assert.ok(!JSON.stringify(body).includes(KEY), 'credential leaked into provider arguments');
    if (devto) assert.deepEqual(body.article, { title: 'Request proof', body_markdown: '# Synthetic content', published: false, canonical_url: CANONICAL });
    else {
      assert.ok(body.query.includes('CreateDraftInput!') && !body.query.includes('PublishPostInput'));
      assert.deepEqual(body.variables.input, { publicationId: PUBLICATION, title: 'Request proof', contentMarkdown: '# Synthetic content', originalArticleURL: CANONICAL });
    }
    appendFileSync(`${evidenceDir}/vendor-requests.jsonl`, JSON.stringify({ provider: devto ? 'devto' : 'hashnode',
      canonicalUrl: CANONICAL, published: false, credentialHeaderMatched: true, credentialInBody: false }) + '\n');
    return devto ? Response.json({ id: 123, url: 'https://dev.to/synthetic/proof' }, { status: 201 })
      : Response.json({ data: { createDraft: { draft: { id: 'synthetic-draft' } } } });
  };
  await import(pathToFileURL(bundle).href);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await serve(process.argv[2]); }
  catch (error) {
    console.error('BLOG_POST_FAILURE ' + (error instanceof Error ? error.stack : String(error)));
    process.exitCode = 1;
  }
}

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, runProviderConformance, validateProviderDescriptor, type ProviderAdapter, type HostFetch } from '@papercusp/plugin-sdk';

const require = createRequire(import.meta.url);
const publicationId = '0123456789abcdef01234567';
const args = { title: 'Provider packages', markdown: '# A real post\n\nDetails.', canonicalUrl: 'https://papercusp.com/blog/providers' };
const config = { publicationId };
// The maintained mutation runner supplies its frozen copy through {}. Load that
// exact copy during a probe so the normal source guard remains enabled and the
// production checkout stays untouched; ordinary runs use the installed package.
const adapters = Object.fromEntries(['devto', 'hashnode'].map((id) => {
  const entry = id === 'devto' && process.env.PAPERCUSP_MUTATION_PROBE === '1' && process.env.PROBE_FILE
    ? process.env.PROBE_FILE
    : `../../../../../libs/papercusp/plugins/${id}/index.cjs`;
  return [id, require(entry).providerAdapter as ProviderAdapter];
}));
function response(id: string, published = false) {
  return id === 'devto' ? jsonResponse(201, { id: 123, url: 'https://dev.to/papercusp/providers' }) :
    jsonResponse(200, { data: published ? { publishPost: { post: { id: 'post-123', url: 'https://custom-blog.example/providers' } } } : { createDraft: { draft: { id: 'draft-123' } } } });
}
describe.each(['devto', 'hashnode'])('%s publishing package (P024)', (id) => {
  const adapter = adapters[id];
  const invoke = (a = args, fetch: HostFetch = vi.fn(async () => response(id)), capability = 'blog.post') => adapter.invoke({ source: 'source', config, capability, args: a }, { fetch });
  it('declares only blog.post with generic credentials and an honestly empty read surface', async () => {
    const d = await adapter.describe(); expect(validateProviderDescriptor(d)).toEqual([]);
    expect(d).toMatchObject({ id, datatypes: ['blog-post'], capabilities: ['blog.post'], sync: false });
    expect(d.oauth).toBeUndefined(); expect(d.setup?.credentials?.[0].hosts).toEqual(d.egressHosts);
    expect(d.verification?.capabilities).toEqual({ 'blog.post': '2026-10-17' });
    const fetch = vi.fn();
    expect(await adapter.syncPage({ source: 'source', config, cursor: null, mode: 'backfill' }, { fetch })).toMatchObject({ records: [], nextCursor: null, hasMore: false });
    await expect(adapter.syncPage({ source: 'source', config, cursor: 'foreign', mode: 'incremental' }, { fetch })).rejects.toMatchObject({ kind: 'cursor-expired' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('defaults to a draft and maps the canonical URL without exposing a credential', async () => {
    const fetch = vi.fn(async () => response(id)); const result = await invoke(args, fetch);
    expect(result).toMatchObject({ published: false, canonicalUrl: args.canonicalUrl });
    if (id === 'hashnode') expect(result).not.toHaveProperty('url');
    const call = fetch.mock.calls[0] as unknown as Parameters<HostFetch>;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(call[0].source).toBe('source'); expect(call[0].request.headers).not.toHaveProperty('authorization');
    expect(call[0].request.headers).not.toHaveProperty('api-key');
    const body = JSON.parse(call[0].request.body!);
    if (id === 'devto') expect(body).toEqual({ article: { title: args.title, body_markdown: args.markdown, published: false, canonical_url: args.canonicalUrl } });
    else {
      expect(body.query).toContain('CreateDraftInput!'); expect(body.query).toContain('createDraft(input: $input)');
      expect(body.variables.input).toEqual({ publicationId, title: args.title, contentMarkdown: args.markdown, originalArticleURL: args.canonicalUrl });
    }
  });
  it('publishes only explicit true and maps optional tags in the primary API shape', async () => {
    const fetch = vi.fn(async () => response(id, true));
    const result = await invoke({ ...args, published: true, tags: ['typescript', 'api'] } as typeof args, fetch);
    expect(result).toMatchObject({ published: true, canonicalUrl: args.canonicalUrl });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as Parameters<HostFetch>)[0].request.body!);
    if (id === 'devto') expect(body.article).toMatchObject({ published: true, tags: ['typescript', 'api'] });
    else { expect(body.query).toContain('PublishPostInput!'); expect(body.variables.input.tags).toEqual([{ slug: 'typescript' }, { slug: 'api' }]); }
  });
  it.each(['https://other.example/blog', 'https://papercusp.com.evil.test/blog', 'http://papercusp.com/blog',
    'https://secret@papercusp.com/blog', 'https://papercusp.com:444/blog', 'https://papercusp.com/blog#fragment', null])('refuses invalid canonical URL %s before any request', async (canonicalUrl) => {
    const fetch = vi.fn(); await expect(invoke({ ...args, canonicalUrl } as typeof args, fetch)).rejects.toThrow('invalid_canonical_url'); expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses malformed content, publication intent and unsupported capabilities before fetching', async () => {
    const fetch = vi.fn();
    for (const mutation of [{ title: '' }, { title: 'x'.repeat(129) }, { markdown: '' }, { markdown: 'x'.repeat(80001) },
      { published: 'true' }, { tags: ['same', 'same'] }, { tags: ['<bad>'] }]) {
      await expect(invoke({ ...args, ...mutation } as typeof args, fetch)).rejects.toThrow();
    }
    await expect(invoke(args, fetch, 'blog.delete')).rejects.toThrow('capability_unsupported'); expect(fetch).not.toHaveBeenCalled();
  });
  it('surfaces HTTP authentication and throttling without a retry or provider body leak', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limited']] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, { message: 'private vendor detail' }, { 'Retry-After': '7' }));
      const error = await invoke(args, fetch).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind }); expect(String(error)).not.toContain('private vendor detail'); expect(fetch).toHaveBeenCalledTimes(1);
      if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 7 });
    }
  });
  it('preserves ambiguity on network errors, conflict, server errors and incomplete successes', async () => {
    for (const reply of [jsonResponse(409, {}), jsonResponse(503, {}), jsonResponse(id === 'devto' ? 201 : 200, {}),
      { status: id === 'devto' ? 201 : 200, headers: {}, body: '{', bodyEncoding: 'utf8' as const }]) {
      const fetch = vi.fn(async () => reply);
      await expect(invoke(args, fetch)).rejects.toMatchObject({ kind: 'transient', retrySafe: false }); expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => { throw new Error('private transport details'); });
    await expect(invoke(args, fetch)).rejects.toMatchObject({ kind: 'transient', retrySafe: false }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('passes the shared conformance kit with its actual publishing invocation', async () => {
    const report = await runProviderConformance({ adapter, source: 'source', config,
      createFetch: () => async () => response(id), faults: { rateLimited: false, auth: false, serverError: false },
      invocations: [{ capability: 'blog.post', args, check: (r) => (r as { published?: unknown }).published === false ? null : 'draft result required' }] });
    expect(report.failures).toEqual([]); expect(report.ok).toBe(true);
  });
});
it('dev.to refuses YAML front matter rather than letting it override draft/canonical intent', async () => {
  const fetch = vi.fn();
  await expect(adapters.devto.invoke({ source: 'source', config: {}, capability: 'blog.post', args: { ...args, markdown: '---\npublished: true\ncanonical_url: https://other.test\n---\nContent' } }, { fetch })).rejects.toThrow('front_matter_unsupported');
  expect(fetch).not.toHaveBeenCalled();
});
it('Hashnode keeps publication selection in source config and respects the complete JSON body limit', async () => {
  const fetch = vi.fn();
  await expect(adapters.hashnode.invoke({ source: 'source', config: { publicationId: '../../escape' }, capability: 'blog.post', args }, { fetch })).rejects.toThrow('invalid_publication_id');
  await expect(adapters.hashnode.invoke({ source: 'source', config, capability: 'blog.post', args: { ...args, markdown: '\\'.repeat(60000) } }, { fetch })).rejects.toThrow('request_too_large');
  expect(fetch).not.toHaveBeenCalled();
});
it('Hashnode distinguishes permission/Pro and bad input errors while keeping partial mutations ambiguous', async () => {
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'BAD_USER_INPUT', 'INTERNAL_SERVER_ERROR']) {
    const fetch = vi.fn(async () => jsonResponse(200, { errors: [{ message: 'private provider text', extensions: { code } }] }));
    const error = await adapters.hashnode.invoke({ source: 'source', config, capability: 'blog.post', args }, { fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: ['UNAUTHENTICATED', 'FORBIDDEN'].includes(code) ? 'auth' : 'transient' });
    expect(String(error)).not.toContain('private provider text'); expect(fetch).toHaveBeenCalledTimes(1);
  }
  const fetch = vi.fn(async () => jsonResponse(200, { data: { createDraft: { draft: { id: 'created' } } }, errors: [{ extensions: { code: 'FORBIDDEN' } }] }));
  await expect(adapters.hashnode.invoke({ source: 'source', config, capability: 'blog.post', args }, { fetch })).rejects.toMatchObject({ kind: 'transient', retrySafe: false });
});

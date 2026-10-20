/**
 * Behaviour of the firecrawl-bridge `crawl` tool (WI-6554700010012944), run against BOTH the
 * runtime artifact the host loads (index.cjs) and the typed source (index.ts), so the two
 * hand-maintained copies cannot diverge in behaviour without a red test.
 *
 * Contract checked against Firecrawl's v1 OpenAPI (docs.firecrawl.dev, read 2026-10-20):
 * POST /v1/crawl → { success, id }; GET /v1/crawl/{id} → { status: scraping|completed|failed,
 * total, completed, creditsUsed, next, data[] }; DELETE /v1/crawl/{id} cancels.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/plugins/firecrawl-bridge');
const API = 'https://api.firecrawl.dev';

type Handler = (input: unknown, ctx: unknown) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
interface Call { method: string; url: string; body: any; auth: string | null }

const tmpDirs: string[] = [];
function stateDirWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'firecrawl-crawl-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'plugins', '@papercupai_firecrawl-bridge'), { recursive: true });
  writeFileSync(join(dir, 'plugins', '@papercupai_firecrawl-bridge', 'config.json'), JSON.stringify(config));
  return dir;
}

function page(n: number) {
  return { markdown: `# page ${n}`, metadata: { sourceURL: `https://docs.example.com/p${n}`, title: `P${n}`, statusCode: 200 } };
}

/** Routes fetch by method + URL; `statusReplies` are served in order for GET /v1/crawl/c1. */
function stubFirecrawl(opts: { statusReplies: unknown[]; pages?: Record<string, unknown>; startReply?: unknown }) {
  const calls: Call[] = [];
  let statusIdx = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.authorization ?? null });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && url === `${API}/v1/crawl`) return json(opts.startReply ?? { success: true, id: 'c1', url: `${API}/v1/crawl/c1` });
    if (method === 'DELETE' && url === `${API}/v1/crawl/c1`) return json({ status: 'cancelled' });
    if (method === 'GET' && url === `${API}/v1/crawl/c1`) {
      const reply = opts.statusReplies[Math.min(statusIdx, opts.statusReplies.length - 1)];
      statusIdx += 1;
      return json(reply);
    }
    if (method === 'GET' && opts.pages && url in opts.pages) return json(opts.pages[url]);
    return new Response('unexpected request', { status: 599 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function ctxFor(stateDir: string, extra: Record<string, unknown> = {}) {
  return { stateDir, secret: async () => 'fc-test-key', progress: () => {}, ...extra };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

const variants: Array<[string, () => Promise<Record<string, Handler>>]> = [
  ['index.cjs (runtime)', async () => createRequire(import.meta.url)(join(PLUGIN_DIR, 'index.cjs')).tools],
  ['index.ts (source)', async () => (await import(pathToFileURL(join(PLUGIN_DIR, 'index.ts')).href)).tools],
];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(variants)('firecrawl-bridge crawl — %s', (_label, load) => {
  let crawl: Handler;
  beforeAll(async () => {
    crawl = (await load()).crawl!;
  });

  it('is exported as a tool', () => {
    expect(typeof crawl).toBe('function');
  });

  it('starts a bounded crawl, polls to completion, and follows same-origin pagination', async () => {
    const calls = stubFirecrawl({
      statusReplies: [
        { status: 'scraping', total: 3, completed: 1, data: [] },
        { status: 'completed', total: 3, completed: 3, creditsUsed: 3, data: [page(1), page(2)], next: `${API}/v1/crawl/c1?skip=2` },
      ],
      pages: { [`${API}/v1/crawl/c1?skip=2`]: { status: 'completed', data: [page(3)], next: null } },
    });
    const result = await crawl({ url: 'https://docs.example.com', includePaths: ['^/docs/.*'] }, ctxFor(stateDirWith({ crawlPollIntervalMs: 1 })));
    expect(result.isError).toBeFalsy();
    const out = parse(result);
    expect(out).toMatchObject({ id: 'c1', status: 'completed', incomplete: false, total: 3, completed: 3, creditsUsed: 3, pageCount: 3 });
    expect(out.pages.map((p: { url: string }) => p.url)).toEqual([1, 2, 3].map((n) => `https://docs.example.com/p${n}`));
    expect(out.pages[0]).toEqual({ url: 'https://docs.example.com/p1', title: 'P1', statusCode: 200, markdown: '# page 1' });

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/v1/crawl`,
      body: {
        url: 'https://docs.example.com',
        limit: 10,
        maxDepth: 2,
        includePaths: ['^/docs/.*'],
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      },
    });
    expect(calls.every((c) => c.auth === 'Bearer fc-test-key')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('clamps limit and depth so one call cannot run a 10,000-page crawl', async () => {
    const calls = stubFirecrawl({ statusReplies: [{ status: 'completed', total: 0, completed: 0, data: [] }] });
    await crawl({ url: 'https://docs.example.com', limit: 5000, maxDepth: -3 }, ctxFor(stateDirWith({ crawlPollIntervalMs: 1 })));
    expect(calls[0]!.body).toMatchObject({ limit: 100, maxDepth: 0 });
  });

  it('never sends the API key to an off-origin pagination URL', async () => {
    const calls = stubFirecrawl({
      statusReplies: [{ status: 'completed', total: 2, completed: 2, data: [page(1)], next: 'https://evil.example/v1/crawl/c1?skip=1' }],
    });
    const out = parse(await crawl({ url: 'https://docs.example.com' }, ctxFor(stateDirWith({ crawlPollIntervalMs: 1 }))));
    expect(calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
    expect(out.pageCount).toBe(1);
    expect(out.nextRefused).toContain('https://evil.example');
  });

  it('cancels a crawl that outlives the wait budget and returns its partial pages', async () => {
    const calls = stubFirecrawl({ statusReplies: [{ status: 'scraping', total: 50, completed: 1, data: [page(1)] }] });
    const result = await crawl({ url: 'https://docs.example.com' }, ctxFor(stateDirWith({ crawlPollIntervalMs: 50, crawlMaxWaitSec: 1 })));
    expect(result.isError).toBeFalsy();
    const out = parse(result);
    expect(out).toMatchObject({ status: 'timed-out', incomplete: true, cancelled: true, pageCount: 1, total: 50, completed: 1 });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`${API}/v1/crawl/c1`]);
  });

  it('cancels the remote crawl when the caller aborts', async () => {
    const controller = new AbortController();
    stubFirecrawl({ statusReplies: [{ status: 'scraping', total: 5, completed: 0, data: [] }] });
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
    const pending = crawl({ url: 'https://docs.example.com' }, ctxFor(stateDirWith({ crawlPollIntervalMs: 200, crawlMaxWaitSec: 30 }), { signal: controller.signal }));
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    const out = parse(await pending);
    expect(out).toMatchObject({ status: 'aborted', incomplete: true, cancelled: true });
  });

  it('reports a failed crawl as an error', async () => {
    stubFirecrawl({ statusReplies: [{ status: 'failed', total: 4, completed: 1, data: [] }] });
    const result = await crawl({ url: 'https://docs.example.com' }, ctxFor(stateDirWith({ crawlPollIntervalMs: 1 })));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("status 'failed'");
  });

  it('refuses a missing url and a missing API key without calling Firecrawl', async () => {
    const calls = stubFirecrawl({ statusReplies: [] });
    expect((await crawl({}, ctxFor(stateDirWith({})))).isError).toBe(true);
    const noKey = await crawl({ url: 'https://docs.example.com' }, ctxFor(stateDirWith({}), { secret: async () => null }));
    expect(noKey.isError).toBe(true);
    expect(noKey.content[0]!.text).toContain('FIRECRAWL_API_KEY');
    expect(calls).toEqual([]);
  });
});

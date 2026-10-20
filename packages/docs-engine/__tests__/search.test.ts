import { describe, it, expect, vi } from 'vitest';
import { searchDocs, tokenize } from '../src/search';
import { makePage, makeSource } from './_fixture';

describe('tokenize', () => {
  it('lowercases and dedupes', () => {
    expect(tokenize('Foo bar FOO')).toEqual(['foo', 'bar']);
  });
  it('drops short tokens', () => {
    expect(tokenize('a be co')).toEqual(['be', 'co']);
  });
  it('splits on punctuation', () => {
    expect(tokenize('foo, bar; baz')).toEqual(['foo', 'bar', 'baz']);
  });
});

describe('searchDocs', () => {
  const pages = [
    makePage({ slug: 'endpoint-system/overview', title: 'Overview', description: 'endpoint system' }),
    makePage({ slug: 'agents/index', title: 'Agents', description: 'multi-agent harness' }),
    makePage({ slug: 'plugins/repomix', title: 'Repomix', description: 'pack a project' }),
  ];
  const contents = {
    'endpoint-system/overview': 'The endpoint system projects functions onto transports.',
    'agents/index': 'Agents are spawned by the orchestrator.',
    'plugins/repomix': 'Repomix packs the project into one LLM-friendly document.',
  };

  it('returns empty result for empty query', async () => {
    const out = await searchDocs(makeSource({ pages, contents }), { query: 'a' });
    expect(out.hits).toEqual([]);
  });

  it('finds title matches with higher weight', async () => {
    const out = await searchDocs(makeSource({ pages, contents }), { query: 'overview' });
    expect(out.hits[0].slug).toBe('endpoint-system/overview');
  });

  it('finds body matches', async () => {
    const out = await searchDocs(makeSource({ pages, contents }), { query: 'orchestrator' });
    expect(out.hits.map((h) => h.slug)).toContain('agents/index');
  });

  it('respects limit', async () => {
    const out = await searchDocs(makeSource({ pages, contents }), { query: 'project', limit: 1 });
    expect(out.hits).toHaveLength(1);
  });

  it('includes excerpt around match', async () => {
    const out = await searchDocs(makeSource({ pages, contents }), { query: 'orchestrator' });
    expect(out.hits[0].excerpt).toContain('orchestrator');
  });

  it('emits ctx.metadata', async () => {
    const metadata = vi.fn();
    await searchDocs(makeSource({ pages, contents }), { query: 'overview' }, { metadata });
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      query_tokens: 1,
      hit_count: 1,
      returned: 1,
    }));
  });
});

describe('searchDocs — progress + cancellation', () => {
  it('throws on pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const pages = [makePage({ slug: 'a', title: 'A' })];
    await expect(
      searchDocs(makeSource({ pages, contents: { a: 'foo' } }), { query: 'foo' }, { signal: ac.signal }),
    ).rejects.toThrow(/cancelled/);
  });
  it('emits ctx.progress', async () => {
    const progress = vi.fn();
    const pages = [makePage({ slug: 'a', title: 'foo' }), makePage({ slug: 'b', title: 'bar' })];
    await searchDocs(
      makeSource({ pages, contents: { a: 'foo', b: 'bar' } }),
      { query: 'foo' },
      { progress },
    );
    expect(progress).toHaveBeenCalled();
    const calls = progress.mock.calls.map((c) => c[0]);
    expect(Math.min(...calls)).toBeGreaterThanOrEqual(10);
  });
});

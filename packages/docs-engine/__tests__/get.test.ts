import { describe, it, expect, vi } from 'vitest';
import { getDocs, MAX_PAYLOAD_BYTES } from '../src/get';
import { makePage, makeSource } from './_fixture';

describe('getDocs', () => {
  it('returns empty results for empty slugs', async () => {
    const out = await getDocs(makeSource(), { slugs: [] });
    expect(out.results).toEqual([]);
  });

  it('fetches canonical source for an exact slug without listing the corpus', async () => {
    const page = makePage({ slug: 'agent-insights/release-guide', title: 'Release guide' });
    const base = makeSource({ pages: [page] });
    const listPages = vi.fn(async () => { throw new Error('exact lookup must not list every page'); });
    const getPageBySlug = vi.fn(async (slug: string) => slug === page.slug ? page : null);
    const getSource = vi.fn(async () => '---\ntitle: Release guide\n---\n# Repair steps');
    const out = await getDocs({ ...base, listPages, getPageBySlug, getSource }, { slugs: [page.slug], source: true });

    expect(out.results[0]).toMatchObject({ slug: page.slug, found: true, source: true, content: '---\ntitle: Release guide\n---\n# Repair steps' });
    expect(getPageBySlug).toHaveBeenCalledWith(page.slug);
    expect(getSource).toHaveBeenCalledWith(page);
    expect(listPages).not.toHaveBeenCalled();
  });

  it('fetches a single page', async () => {
    const pages = [makePage({ slug: 'a/b', title: 'AB' })];
    const out = await getDocs(makeSource({ pages, contents: { 'a/b': 'body of a/b' } }), {
      slugs: ['a/b'],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ slug: 'a/b', found: true });
    if (out.results[0].found) expect(out.results[0].content).toBe('body of a/b');
  });

  it('returns not_found with suggestions for missing slug', async () => {
    const pages = [makePage({ slug: 'endpoint-system/overview' })];
    const out = await getDocs(makeSource({ pages }), { slugs: ['endpoint-system/overvew'] });
    expect(out.results[0].found).toBe(false);
    if (!out.results[0].found) {
      expect(out.results[0].error).toBe('not_found');
      expect(out.results[0].suggestions).toContain('endpoint-system/overview');
    }
  });

  it('returns per-slug error envelope (mixed batch)', async () => {
    const pages = [makePage({ slug: 'good' })];
    const out = await getDocs(makeSource({ pages, contents: { good: 'ok' } }), {
      slugs: ['good', 'missing'],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0].found).toBe(true);
    expect(out.results[1].found).toBe(false);
  });

  it('resolves a unique bare leaf to its canonical page', async () => {
    const pages = [makePage({ slug: 'agent-insights/testing-await-event-emit-paths' })];
    const out = await getDocs(
      makeSource({
        pages,
        contents: { 'agent-insights/testing-await-event-emit-paths': 'await event guidance' },
      }),
      { slugs: ['testing-await-event-emit-paths'] },
    );

    expect(out.results[0]).toMatchObject({
      slug: 'testing-await-event-emit-paths',
      found: true,
      content: 'await event guidance',
    });
  });

  it('prefers an exact page when a bare leaf also matches a nested page', async () => {
    const pages = [
      makePage({ slug: 'overview' }),
      makePage({ slug: 'agent-insights/overview' }),
    ];
    const out = await getDocs(
      makeSource({
        pages,
        contents: { overview: 'root overview', 'agent-insights/overview': 'insights overview' },
      }),
      { slugs: ['overview'] },
    );

    expect(out.results[0]).toMatchObject({ slug: 'overview', found: true, content: 'root overview' });
  });

  it('keeps an ambiguous bare leaf as not_found', async () => {
    const pages = [
      makePage({ slug: 'agent-insights/overview' }),
      makePage({ slug: 'framework/overview' }),
    ];
    const out = await getDocs(makeSource({ pages }), { slugs: ['overview'] });

    expect(out.results[0]).toMatchObject({ slug: 'overview', found: false, error: 'not_found' });
  });

  it('slices by heading on single-slug calls', async () => {
    const pages = [
      makePage({
        slug: 'a',
        toc: [
          { id: 'first', text: 'First', depth: 2 },
          { id: 'target', text: 'Target', depth: 2 },
        ],
      }),
    ];
    const contents = {
      a: '## First\n\nintro\n\n## Target\n\ntarget body\n',
    };
    const out = await getDocs(makeSource({ pages, contents }), {
      slugs: ['a'],
      heading: 'target',
    });
    expect(out.results[0].found).toBe(true);
    if (out.results[0].found) {
      expect(out.results[0].sliced).toBe(true);
      expect(out.results[0].content).toContain('target body');
      expect(out.results[0].content).not.toContain('intro');
    }
  });

  it('slices by visible heading text when the caller does not pass the anchor id', async () => {
    const pages = [
      makePage({
        slug: 'a',
        toc: [
          { id: 'first', text: 'First', depth: 2 },
          { id: 'target-section', text: 'Target Section', depth: 2 },
        ],
      }),
    ];
    const contents = {
      a: '## First\n\nintro\n\n## Target Section\n\ntarget body\n',
    };
    const out = await getDocs(makeSource({ pages, contents }), {
      slugs: ['a'],
      heading: ' target SECTION ',
    });

    expect(out.results[0]).toMatchObject({
      slug: 'a',
      found: true,
      sliced: true,
      content: expect.stringContaining('target body'),
    });
  });

  it('returns heading_not_found when slice misses', async () => {
    const pages = [
      makePage({
        slug: 'a',
        toc: [{ id: 'intro', text: 'Intro', depth: 2 }],
      }),
    ];
    const out = await getDocs(makeSource({ pages, contents: { a: '## Intro\nbody' } }), {
      slugs: ['a'],
      heading: 'nope',
    });
    expect(out.results[0].found).toBe(false);
    if (!out.results[0].found) expect(out.results[0].error).toBe('heading_not_found');
  });

  it('truncates over 50KB with tail mentioning first h2', async () => {
    const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 1000);
    const pages = [
      makePage({
        slug: 'big',
        toc: [{ id: 'sec', text: 'Sec', depth: 2 }],
      }),
    ];
    const out = await getDocs(makeSource({ pages, contents: { big } }), { slugs: ['big'] });
    expect(out.results[0].found).toBe(true);
    if (out.results[0].found) {
      expect(out.results[0].truncated).toBe(true);
      expect(out.results[0].content).toContain('truncated at');
      expect(out.results[0].content).toContain('sec');
    }
  });

  it('emits ctx.metadata', async () => {
    const metadata = vi.fn();
    const pages = [makePage({ slug: 'good' })];
    await getDocs(
      makeSource({ pages, contents: { good: 'ok' } }),
      { slugs: ['good', 'missing'] },
      { metadata },
    );
    expect(metadata).toHaveBeenCalledOnce();
    expect(metadata.mock.calls[0][0]).toMatchObject({
      requested: 2,
      found: 1,
      not_found: 1,
      truncated: 0,
      sliced: 0,
      has_heading: false,
    });
  });

  it('detects JSX literals in metadata', async () => {
    const metadata = vi.fn();
    const pages = [makePage({ slug: 'p' })];
    await getDocs(
      makeSource({ pages, contents: { p: 'before <Callout type="warn">stuff</Callout> after' } }),
      { slugs: ['p'] },
      { metadata },
    );
    expect(metadata.mock.calls[0][0].jsx_literals_present).toBe(true);
  });
});

describe('getDocs — cancellation', () => {
  it('throws on pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const pages = [makePage({ slug: 'a' })];
    await expect(
      getDocs(makeSource({ pages, contents: { a: 'x' } }), { slugs: ['a'] }, { signal: ac.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});

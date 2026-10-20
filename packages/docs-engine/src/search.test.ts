/**
 * Tests for the search tokenizer (the pure half of searchDocs) and the
 * searchDocs ranking/truncation contract.
 * Run with: npx vitest run packages/docs-engine/src/search.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { searchDocs, tokenize } from './search';
import type { DocPage, DocSource } from './types.js';

/**
 * Minimal in-memory DocSource for ranking tests. Each spec is
 * [slug, title, description, body]; url defaults to `/${slug}`.
 */
type PageSpec = {
  slug: string;
  title?: string;
  description?: string;
  body?: string;
  searchable?: boolean;
};

function makeSource(specs: PageSpec[]): DocSource {
  const bodies = new Map<string, string>();
  const pages: DocPage[] = specs.map((s) => {
    bodies.set(s.slug, s.body ?? '');
    return {
      slug: s.slug,
      slugs: s.slug ? s.slug.split('/') : [],
      url: `/${s.slug}`,
      title: s.title ?? '',
      ...(s.description ? { description: s.description } : {}),
      ...(s.searchable === false ? { searchable: false as const } : {}),
      toc: [],
    };
  });
  return {
    name: 'test-source',
    listPages: async () => pages,
    getPage: async (slug) => pages.find((p) => p.slug === slug) ?? null,
    getContent: async (page) => bodies.get(page.slug) ?? '',
  };
}

describe('tokenize', () => {
  it('lowercases and splits on punctuation/whitespace', () => {
    expect(tokenize('Feature Flags')).toEqual(['feature', 'flags']);
    expect(tokenize('sync,resolver;query.layer')).toEqual(['sync', 'resolver', 'query', 'layer']);
  });

  it('drops tokens shorter than 2 chars', () => {
    expect(tokenize('a I/O x')).toEqual([]);
    expect(tokenize('go to db')).toEqual(['go', 'to', 'db']);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(tokenize('sync sync resolver sync')).toEqual(['sync', 'resolver']);
  });

  it('splits on the full punctuation class', () => {
    expect(tokenize('foo(bar)/baz<qux>')).toEqual(['foo', 'bar', 'baz', 'qux']);
  });

  it('returns [] for an empty or all-stopchar query', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  .,;:  ')).toEqual([]);
  });

  it('splits on hyphens — a kebab-case slug is a compound token, not one giant token (EI-10097)', () => {
    expect(tokenize('su-persona-render-and-edit-path')).toEqual([
      'su',
      'persona',
      'render',
      'and',
      'edit',
      'path',
    ]);
  });
});

describe('searchDocs', () => {
  it('distinguishes page listing, content loading and ranking without retaining query text', async () => {
    vi.useFakeTimers();
    try {
      const base = makeSource([{ slug: 'private-page', body: 'private-query' }]);
      let releasePages!: (pages: DocPage[]) => void;
      let releaseContent!: (body: string) => void;
      const source: DocSource = {
        ...base,
        listPages: () => new Promise(resolve => { releasePages = resolve; }),
        getContent: () => new Promise(resolve => { releaseContent = resolve; }),
      };
      const metadata = vi.fn();
      const pending = searchDocs(source, { query: 'private-query' }, { metadata });
      expect(metadata.mock.lastCall?.[0].docsLexicalTiming.active.phase).toBe('listPages');
      await vi.advanceTimersByTimeAsync(12);
      releasePages(await base.listPages());
      await vi.advanceTimersByTimeAsync(0);
      expect(metadata.mock.lastCall?.[0].docsLexicalTiming).toMatchObject({
        active: { phase: 'getContent' }, completedMs: { listPages: 12 },
        pages: { listed: 1, searchable: 1, loaded: 0 },
      });
      await vi.advanceTimersByTimeAsync(25);
      releaseContent('private-query');
      const result = await pending;
      expect(result.hits[0]?.slug).toBe('private-page');
      expect(metadata.mock.calls.map(([data]) => data.docsLexicalTiming?.active?.phase).filter(Boolean))
        .toEqual(['listPages', 'getContent', 'ranking']);
      const timing = metadata.mock.lastCall?.[0].docsLexicalTiming;
      expect(timing).toMatchObject({
        outcome: 'complete', active: null, totalElapsedMs: 37,
        completedMs: { listPages: 12, getContent: 25, ranking: 0 },
        pages: { listed: 1, searchable: 1, loaded: 1 },
      });
      expect(JSON.stringify(timing)).not.toContain('private');
    } finally { vi.useRealTimers(); }
  });

  it.each(['listPages', 'getContent'] as const)('retains the interrupted %s phase when cancelled', async (phase) => {
    vi.useFakeTimers();
    try {
      const base = makeSource([{ slug: 'a', body: 'foo' }]);
      const pendingForever = () => new Promise<never>(() => undefined);
      const source: DocSource = {
        ...base,
        ...(phase === 'listPages' ? { listPages: pendingForever } : { getContent: pendingForever }),
      };
      const controller = new AbortController();
      const metadata = vi.fn();
      const pending = searchDocs(source, { query: 'foo' }, { metadata, signal: controller.signal });
      const rejection = expect(pending).rejects.toThrow('cancelled');
      await vi.advanceTimersByTimeAsync(17);
      controller.abort();
      await rejection;
      expect(metadata.mock.lastCall?.[0].docsLexicalTiming).toMatchObject({
        outcome: 'cancelled', stoppedIn: phase, active: null,
        completedMs: { [phase]: 17 },
      });
    } finally { vi.useRealTimers(); }
  });

  it('reports partial loaded-page counts while a corpus scan is still pending', async () => {
    const base = makeSource(Array.from({ length: 26 }, (_, i) => ({ slug: String(i), body: 'foo' })));
    const controller = new AbortController();
    const metadata = vi.fn();
    const pending = searchDocs({
      ...base,
      getContent: page => page.slug === '25' ? new Promise(() => undefined) : base.getContent(page),
    }, { query: 'foo' }, { metadata, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(metadata.mock.lastCall?.[0].docsLexicalTiming).toMatchObject({
      outcome: 'running', active: { phase: 'getContent' },
      pages: { listed: 26, searchable: 26, loaded: 25 },
    }));
    controller.abort();
    await rejection;
    expect(metadata.mock.lastCall?.[0].docsLexicalTiming).toMatchObject({
      outcome: 'cancelled', stoppedIn: 'getContent', pages: { loaded: 25 },
    });
  });

  it.each(['listPages', 'getContent'] as const)('records a failed %s source without masking the error or copying it into timing', async phase => {
    const base = makeSource([{ slug: 'a', body: 'foo' }]);
    const failure = new Error('private backend detail');
    const reject = async () => { throw failure; };
    const source: DocSource = { ...base, ...(phase === 'listPages' ? { listPages: reject } : { getContent: reject }) };
    const metadata = vi.fn();
    await expect(searchDocs(source, { query: 'foo' }, { metadata })).rejects.toBe(failure);
    const timing = metadata.mock.lastCall?.[0].docsLexicalTiming;
    expect(timing).toMatchObject({ outcome: 'failed', stoppedIn: phase, active: null });
    expect(JSON.stringify(timing)).not.toContain('private');
  });

  it('reports the full pre-truncation match total in hitCount while truncating hits to limit (Gap 2)', async () => {
    // Contract: hitCount = how many pages matched even if not all are returned,
    // so the model can detect that results were truncated. hits.length is capped
    // at limit; hitCount stays at the full scored.length (5 here, not 2).
    const source = makeSource([
      { slug: 'p1', title: 'foo' },
      { slug: 'p2', title: 'foo' },
      { slug: 'p3', title: 'foo' },
      { slug: 'p4', title: 'foo' },
      { slug: 'p5', title: 'foo' },
    ]);
    const metadata = vi.fn();
    const res = await searchDocs(source, { query: 'foo', limit: 2 }, { metadata });

    expect(res.hitCount).toBe(5); // full match total, NOT truncated
    expect(res.hits).toHaveLength(2); // returned set is capped at limit
    expect(res.hitCount).toBeGreaterThan(res.hits.length); // truncation signal
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ hit_count: 5, returned: 2 }),
    );
  });

  it('breaks score ties by slug ascending, not insertion order (Gap 1)', async () => {
    // Both pages: title 'foo', identical bodies → identical score (4). Inserted
    // z-page first, a-page second. The `|| a.slug.localeCompare(b.slug)` tie-break
    // must sort them slug-ascending → ['a-page', 'z-page']. Dropping the
    // localeCompare leg would leave insertion order and fail this assertion.
    const source = makeSource([
      { slug: 'z-page', title: 'foo', body: 'shared body' },
      { slug: 'a-page', title: 'foo', body: 'shared body' },
    ]);
    const res = await searchDocs(source, { query: 'foo' });

    expect(res.hits.map((h) => h.slug)).toEqual(['a-page', 'z-page']);
    expect(res.hits[0].score).toBe(res.hits[1].score); // genuinely tied on score
  });

  it('weights a title hit above body repetition — body TF saturates and cannot be out-stuffed (Gap 3, EI-10937)', async () => {
    // A title hit scores 4 (1 × 4). The body term is now BM25-saturated, so its
    // per-token contribution is capped near (k1+1)=2.2 no matter how many times
    // the token is repeated. Body stuffing can therefore no longer overtake a
    // genuine title match — which is the ranking inversion EI-10937 was about.
    // Assertions are RELATIVE, deliberately. The previous version of this test
    // pinned exact integers (`[4, 4, 3]`), which asserted the raw-count
    // implementation rather than the intended contract — and absolute score
    // assertions are precisely what made the EI-10937 scoring fix look risky.
    // Score magnitudes are now informativeness-weighted and carry no fixed scale;
    // what must hold is the ORDERING.
    const source = makeSource([
      { slug: 'body3', title: 'nope', body: 'foo foo foo' },
      { slug: 'm-title', title: 'foo', body: 'nope' },
      { slug: 'a-body4', title: 'nope', body: 'foo foo foo foo' },
      // Body stuffing taken to an absurd degree must STILL not beat a title hit —
      // that is the saturation property, and it is what stops a long page from
      // buying rank with repetition.
      { slug: 'z-stuffed', title: 'nope', body: 'foo '.repeat(500) },
    ]);
    const res = await searchDocs(source, { query: 'foo' });

    expect(res.hits[0]?.slug).toBe('m-title');
    const titleScore = res.hits[0]!.score;
    for (const h of res.hits.slice(1)) {
      expect(h.score).toBeLessThan(titleScore);
    }
    // And the 500× stuffed page does not outrank the modest 4× one by anything
    // like 125× — TF is saturated, not linear.
    const stuffed = res.hits.find((h) => h.slug === 'z-stuffed')!;
    const modest = res.hits.find((h) => h.slug === 'a-body4')!;
    expect(stuffed.score / modest.score).toBeLessThan(2);
  });

  it('EXCLUDES pages marked `searchable: false` from results entirely (EI-10937 guard 1)', async () => {
    // Generated navigation aggregators (reference/agent-insights-index, 304KB of
    // every insight's title+description) opt out of the search corpus. They stay
    // reachable via docs:get / the outline — they are simply never an ANSWER.
    const source = makeSource([
      { slug: 'reference/agent-insights-index', title: 'Agent insights index', body: 'flake soak nuqs alias vitest', searchable: false },
      { slug: 'agent-insights/the-real-doc', title: 'the real doc', body: 'flake soak' },
    ]);
    const res = await searchDocs(source, { query: 'flake soak' });

    expect(res.hits.map((h) => h.slug)).toEqual(['agent-insights/the-real-doc']);
    expect(res.hits.some((h) => h.slug.includes('-index'))).toBe(false);
  });

  it('a focused doc OUTRANKS a giant aggregate dump that merely mentions the terms (EI-10937 guard 2)', async () => {
    // THE RECURRENCE GUARD, and the exact bug as measured in production:
    // `reference/agent-insights-index` (304KB) vs the mean 10.1KB doc. Under the
    // old raw-count body scoring, the aggregate accumulated more raw occurrences
    // than any focused page could and took rank #1 for essentially EVERY query —
    // so the correct doc landed at #5 or vanished, and agents concluded the topic
    // was undocumented and re-derived it.
    //
    // Note this aggregate deliberately does NOT set `searchable:false`: guard 1
    // would trivially satisfy this test. This asserts the SCORER itself is sound,
    // so the next unflagged 100KB page cannot become the new black hole.
    //
    // The corpus is modelled on the real one: many ordinary docs, whose combined
    // vocabulary the aggregate carries. That is what makes COMMON query tokens
    // ('url', 'race', 'flush') worthless and the RARE one ('nuqs') decisive — the
    // IDF half of BM25. A 2-page fixture cannot express this, which is exactly why
    // the first version of this fix looked correct and was not.
    const fillers: PageSpec[] = Array.from({ length: 20 }, (_, i) => ({
      slug: `guide/topic-${i}`,
      title: `Topic ${i}: race conditions, url routing and flush semantics`,
      body: `A guide about url handling, race conditions and flush behaviour in subsystem ${i}. `.repeat(12),
    }));

    // The aggregate: one index ROW per doc (title + description), like the real
    // generated index — so it inherits the whole corpus's vocabulary, and mentions
    // the target's rare term exactly once, as its row.
    const aggregateBody =
      fillers.map((f) => `| ${f.title} | a guide about url race flush routing |`).join('\n') +
      '\n| load-sensitive test flakes and the soak lane | nuqs throttled url flush race |';

    const source = makeSource([
      ...fillers,
      { slug: 'reference/big-aggregate', title: 'Everything index', body: aggregateBody },
      {
        slug: 'agent-insights/load-sensitive-test-flakes',
        title: 'load-sensitive test flakes and the soak lane',
        body:
          'The reset path races: nuqs applies a set optimistically but commits the url write on a throttle. ' +
          'A remount inside that nuqs throttled window re-reads a url that never heard about the flush, so the race resolves the losing way. ' +
          'Reproducing the nuqs flush race needs cpu starvation.',
      },
    ]);
    const res = await searchDocs(source, { query: 'nuqs throttled url flush race' }, {});

    const focused = res.hits.find((h) => h.slug === 'agent-insights/load-sensitive-test-flakes');
    const aggregate = res.hits.find((h) => h.slug === 'reference/big-aggregate');

    expect(res.hits[0]?.slug).toBe('agent-insights/load-sensitive-test-flakes');
    expect(focused!.score).toBeGreaterThan(aggregate!.score);
  });

  it('an exact-slug query hard-hits that doc first even when generic tokens favor other pages (EI-10097)', async () => {
    // Reproduces the filed bug shape: the target doc's title/body words
    // ('persona', 'render', 'edit') are common enough that OTHER pages
    // (here, pages stuffed with those same generic words many times) could
    // outscore it on pure token frequency. A query that IS the doc's own
    // slug must still surface it — the slug match dominates.
    const source = makeSource([
      {
        slug: 'agent-insights/su-persona-render-and-edit-path',
        title: 'su persona render and edit path',
        description: 'How the su persona prompt is rendered and where to edit it',
        body: 'layered projected prompt render edit persona',
      },
      {
        slug: 'plans/persona-render-notes',
        title: 'persona render notes',
        body: 'persona render persona render persona render persona render persona render edit edit edit edit edit',
      },
    ]);
    const res = await searchDocs(source, { query: 'su-persona-render-and-edit-path', limit: 8 });

    expect(res.tokenCount).toBe(6); // hyphenated slug now tokenizes, not one dead token
    expect(res.hits[0]?.slug).toBe('agent-insights/su-persona-render-and-edit-path');
  });

  it('slug bonus also fires on the exact final segment, ignoring the section prefix', async () => {
    const source = makeSource([
      { slug: 'agent-insights/two-tier-scheduler-and-timer-visibility', title: 'the scheduler layer model' },
      { slug: 'other/unrelated', title: 'nope' },
    ]);
    const res = await searchDocs(source, { query: 'two-tier-scheduler-and-timer-visibility' });
    expect(res.hits[0]?.slug).toBe('agent-insights/two-tier-scheduler-and-timer-visibility');
  });

  it('a short/generic query gets no slug bonus (guard against over-matching on <3-char normalized queries)', async () => {
    const source = makeSource([{ slug: 'a/b', title: 'ab' }]);
    const res = await searchDocs(source, { query: 'ab' });
    // 'ab' normalizes to a 2-char slug fragment — below the length guard, so it
    // must be scored purely on token match (2, from title ×... actually 'ab' as
    // a token is dropped by tokenize()'s <2-char rule only at 1 char; 'ab' is
    // kept, so this asserts no slug-bonus inflation, not zero-score).
    expect(res.hits[0]?.score).toBeLessThan(1000);
  });

  it('returns promptly on abort while a source content read is still pending', async () => {
    const controller = new AbortController();
    const page: DocPage = { slug: 'slow', slugs: ['slow'], url: '/slow', title: 'Slow', toc: [] };
    let receivedSignal: AbortSignal | undefined;
    const source: DocSource = {
      name: 'slow-source',
      listPages: async () => [page],
      getPage: async () => page,
      getContent: async (_page, options) => {
        receivedSignal = options?.signal;
        return await new Promise<string>(() => undefined);
      },
    };

    const result = searchDocs(source, { query: 'needle' }, { signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(receivedSignal).toBe(controller.signal);

    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
  });
});

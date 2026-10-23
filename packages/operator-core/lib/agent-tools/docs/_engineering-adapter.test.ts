import { describe, expect, it, vi } from 'vitest';
import type { DocListPagesTimingEvent, DocPage, DocSource } from '@papercusp/docs-engine';
import { overlayCanonicalDocs, overlayRequestedCanonicalDocs } from './_engineering-adapter';

const releasePage: DocPage = {
  slug: 'agent-insights/existing',
  slugs: ['agent-insights', 'existing'],
  url: '/internal/docs/agent-insights/existing',
  title: 'Release projection',
  toc: [],
};

function releaseSource(): DocSource & { invalidate: () => void } {
  return {
    name: 'release-rooted-engineering',
    listPages: vi.fn(async () => [releasePage]),
    getPage: vi.fn(async (slug: string) => (slug === releasePage.slug ? releasePage : null)),
    getContent: vi.fn(async () => 'release checkout body'),
    invalidate: vi.fn(),
  };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('overlayCanonicalDocs', () => {
  it('lets a release-rooted reader see a staging-authored page and canonical replacement content', async () => {
    const base = releaseSource();
    const readCanonical = vi.fn(
      async () =>
        new Map([
          [
            'agent-insights/existing.mdx',
            '---\ntitle: Canonical title\ndescription: Canonical description\n---\n# Canonical heading\n\nStaging-authored body',
          ],
          ['agent-insights/new-page.mdx', '---\ntitle: New page\n---\n# New heading\n\nNew body'],
        ]),
    );
    const source = overlayCanonicalDocs(base, readCanonical, 'papercusp');

    const pages = await source.listPages();
    expect(pages.map((page) => page.slug)).toEqual(['agent-insights/existing', 'agent-insights/new-page']);
    expect(pages.find((page) => page.slug === 'agent-insights/existing')?.title).toBe('Canonical title');
    expect(await source.getContent((await source.getPage('agent-insights/existing'))!)).toContain(
      'Staging-authored body',
    );
    expect(await source.getPage('agent-insights/new-page')).toMatchObject({
      slug: 'agent-insights/new-page',
      title: 'New page',
    });
    expect(await source.getContent((await source.getPage('agent-insights/new-page'))!)).toContain('New body');
    expect(readCanonical).toHaveBeenCalledOnce();
    expect(base.getContent).not.toHaveBeenCalled();
  });

  it('drops the canonical cache when docs:author invalidates the shared adapter', async () => {
    const base = releaseSource();
    let contents = new Map<string, string>();
    const readCanonical = vi.fn(async () => contents);
    const source = overlayCanonicalDocs(base, readCanonical, 'papercusp');

    expect(await source.getPage('agent-insights/new-page')).toBeNull();
    contents = new Map([['agent-insights/new-page.mdx', '---\ntitle: Arrived after author\n---\n# Heading\n\nBody']]);
    source.invalidate?.();

    expect(await source.getPage('agent-insights/new-page')).toMatchObject({
      title: 'Arrived after author',
    });
    expect(readCanonical).toHaveBeenCalledTimes(2);
    expect(base.invalidate).toHaveBeenCalledOnce();
  });

  it('lets a separate request worker observe a canonical update without process-local invalidation', async () => {
    const base = releaseSource();
    let body = 'First canonical version';
    const readCanonical = vi.fn(
      async (_harnessSlug: string, docIds: readonly string[]) =>
        new Map(
          docIds.includes('agent-insights/existing.mdx')
            ? [['agent-insights/existing.mdx', `---\ntitle: Canonical title\n---\n# Heading\n\n${body}`]]
            : [],
        ),
    );

    const workerARequest = overlayRequestedCanonicalDocs(base, readCanonical, 'papercusp', ['agent-insights/existing']);
    expect(await workerARequest.getContent((await workerARequest.getPage(releasePage.slug))!)).toContain(
      'First canonical version',
    );

    body = 'Second canonical version';
    // The first request has a deliberate within-request cache. A different
    // worker/request gets a new overlay and must not inherit that old promise.
    expect(await workerARequest.getContent((await workerARequest.getPage(releasePage.slug))!)).toContain(
      'First canonical version',
    );
    const workerBRequest = overlayRequestedCanonicalDocs(base, readCanonical, 'papercusp', ['agent-insights/existing']);
    expect(await workerBRequest.getContent((await workerBRequest.getPage(releasePage.slug))!)).toContain(
      'Second canonical version',
    );
    expect(readCanonical).toHaveBeenCalledTimes(2);
    expect(readCanonical).toHaveBeenLastCalledWith('papercusp', [
      'agent-insights/existing',
      'agent-insights/existing.mdx',
      'agent-insights/existing.md',
    ]);
  });

  it('resolves canonical content stored under its extensionless Starlight slug', async () => {
    const base = releaseSource();
    const docId = 'claude-md';
    const raw = '---\ntitle: Canonical Claude guide\n---\n# Canonical heading\n\nCanonical body';
    const readCanonical = vi.fn(async (_harnessSlug: string, ids: readonly string[]) =>
      new Map(ids.includes(docId) ? [[docId, raw]] : []),
    );
    const source = overlayRequestedCanonicalDocs(base, readCanonical, 'papercusp', [docId]);

    const page = await source.getPage(docId);
    expect(page).toMatchObject({ slug: docId, title: 'Canonical Claude guide' });
    expect(await source.getContent(page!)).toContain('Canonical body');
    expect(readCanonical).toHaveBeenCalledWith('papercusp', [docId, `${docId}.mdx`, `${docId}.md`]);
  });

  it('reports query-free base, canonical-read, and overlay timings', async () => {
    const base = releaseSource();
    const readCanonical = vi.fn(async () => new Map([
      ['agent-insights/new-page.mdx', '---\ntitle: New page\n---\n# Heading\n\nprivate body'],
    ]));
    const source = overlayCanonicalDocs(base, readCanonical, 'papercusp');
    const events: DocListPagesTimingEvent[] = [];

    await source.listPages({ onTiming: (event) => events.push(event) });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'canonical-overlay', phase: 'base-list-pages', state: 'completed', count: 1 }),
      expect.objectContaining({ component: 'canonical-overlay', phase: 'canonical-read', state: 'started' }),
      expect.objectContaining({ component: 'canonical-overlay', phase: 'canonical-read', state: 'completed', count: 1 }),
      expect.objectContaining({ component: 'canonical-overlay', phase: 'overlay', state: 'completed', count: 2 }),
    ]));
    expect(JSON.stringify(events)).not.toContain('private body');
  });

  it('does not let an invalidated in-flight read mark the replacement cache ready', async () => {
    const base = releaseSource();
    const firstRead = signal();
    const secondRead = signal();
    let resolveFirst!: (contents: Map<string, string>) => void;
    let resolveSecond!: (contents: Map<string, string>) => void;
    const first = new Promise<Map<string, string>>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Map<string, string>>((resolve) => { resolveSecond = resolve; });
    let readCount = 0;
    const readCanonical = vi.fn(() => {
      readCount += 1;
      if (readCount === 1) {
        firstRead.resolve();
        return first;
      }
      secondRead.resolve();
      return second;
    });
    const source = overlayCanonicalDocs(base, readCanonical, 'papercusp');

    const firstList = source.listPages();
    await firstRead.promise;
    source.invalidate?.();

    const secondList = source.listPages();
    await secondRead.promise;
    resolveFirst(new Map());
    await firstList;

    const sharedEvents: DocListPagesTimingEvent[] = [];
    const sawShared = signal();
    const thirdList = source.listPages({
      onTiming: (event) => {
        sharedEvents.push(event);
        if (event.phase === 'canonical-read' && event.state === 'shared') sawShared.resolve();
      },
    });
    await sawShared.promise;
    expect(sharedEvents).toContainEqual(expect.objectContaining({ phase: 'canonical-read', state: 'shared' }));

    resolveSecond(new Map());
    await Promise.all([secondList, thirdList]);
    const cachedEvents: DocListPagesTimingEvent[] = [];
    await source.listPages({ onTiming: (event) => cachedEvents.push(event) });
    expect(cachedEvents).toContainEqual(expect.objectContaining({ phase: 'canonical-read', state: 'cached' }));
    expect(readCanonical).toHaveBeenCalledTimes(2);
  });
});

/**
 * WI-1511581 — `getSource` must answer from the CANONICAL ROW, not the file.
 *
 * The overlay is the one place that knows a page has a Postgres row behind it. Its
 * filesystem projection of the same doc carries a generated banner inside the
 * frontmatter and can lag the row (a different checkout, a failed projection
 * write) — close enough to look right, wrong enough to revert a peer's write when
 * an author reads it, edits it and sends it back.
 */
describe('overlayCanonicalDocs — getSource (canonical authoring read)', () => {
  const CANONICAL =
    '---\ntitle: Canonical title\ndescription: Canonical description\n---\n\n' +
    "import { Aside } from '@astrojs/starlight/components';\n\n" +
    '# Canonical heading\n\n<Aside>Staging-authored body</Aside>\n';

  function canonicalOverlay(base: DocSource & { invalidate: () => void }) {
    return overlayCanonicalDocs(base, async () => new Map([['agent-insights/existing.mdx', CANONICAL]]), 'papercusp');
  }

  it('serves the canonical row VERBATIM — frontmatter, import and JSX all intact', async () => {
    const source = canonicalOverlay(releaseSource());
    const page = (await source.getPage(releasePage.slug))!;

    expect(await source.getSource!(page)).toBe(CANONICAL);
  });

  it('CONTROL: getContent on the same page is the lossy projection getSource must not return', async () => {
    const source = canonicalOverlay(releaseSource());
    const page = (await source.getPage(releasePage.slug))!;

    const rendered = await source.getContent(page);
    expect(rendered).not.toBe(CANONICAL);
    expect(rendered).not.toContain('---\ntitle:'); // frontmatter gone
    expect(rendered).not.toContain('<Aside>'); // JSX component rewritten away
  });

  it('does NOT fall back to the base file for a page that HAS a canonical row', async () => {
    const base = releaseSource();
    base.getSource = vi.fn(async () => 'the stale .mdx projection in this checkout');
    const source = canonicalOverlay(base);
    const page = (await source.getPage(releasePage.slug))!;

    expect(await source.getSource!(page)).toBe(CANONICAL);
    expect(base.getSource).not.toHaveBeenCalled();
  });

  it('delegates to the base source for a page with NO canonical row — its file IS its source', async () => {
    const base = releaseSource();
    base.getSource = vi.fn(async () => 'plain file body');
    const source = overlayCanonicalDocs(base, async () => new Map(), 'papercusp');
    const page = (await source.getPage(releasePage.slug))!;

    expect(await source.getSource!(page)).toBe('plain file body');
  });

  it('returns null — not the rendered body — when neither a row nor a base source can answer', async () => {
    const base = releaseSource();
    expect(base.getSource).toBeUndefined();
    const source = overlayCanonicalDocs(base, async () => new Map(), 'papercusp');
    const page = (await source.getPage(releasePage.slug))!;

    // null is what getDocs reports as `source_unavailable`. Returning
    // `getContent`'s output here instead would be the silent corruption.
    expect(await source.getSource!(page)).toBeNull();
    expect(base.getContent).not.toHaveBeenCalled();
  });
});

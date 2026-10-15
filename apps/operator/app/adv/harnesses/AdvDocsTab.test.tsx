// @vitest-environment jsdom
//
// AdvDocsTab — the /adv merged project-docs tab. Real branches: the fetch
// lifecycle (loading → error → unknown_harness → no-docs → populated), the nav
// tree grouped by directory, the source/status badges + freshness dot, the
// human "augmented" overlay, and the gated Regenerate / Re-verify actions
// (their enable predicates + the POST they fire). The fetch is stubbed
// per-call; MarkdownPreview is stubbed to a plain div so we assert AdvDocsTab's
// own logic, not markdown rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { Profiler, type ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string) => key, // passthrough: t('pot') → 'pot'
}));
// MarkdownPreview just echoes its value into the DOM — enough to assert which
// body/overlay AdvDocsTab handed it, without remark/rehype in jsdom.
vi.mock('@/app/_components/MarkdownEditor', () => ({
  MarkdownPreview: ({ value }: { value: string }) => <div data-testid="md">{value}</div>,
}));

import AdvDocsTab from './AdvDocsTab';

function renderTab(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

function entry(over: Record<string, unknown> = {}) {
  return {
    docId: 'guides/setup.md',
    source: 'generated',
    status: 'fresh',
    statusDetail: null,
    subjectLabel: '',
    hasOverlay: false,
    title: null,
    bodyMissing: false,
    tracked: true,
    ...over,
  };
}

/** A MergedDocsResponse with sensible defaults. */
function docsResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    files: ['guides/setup.md'],
    entries: [entry()],
    activePath: null,
    content: null,
    activeEntry: null,
    ...over,
  };
}

/** Stub fetch to resolve every call with `body`. */
function stubFetchOk(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvDocsTab — fetch lifecycle', () => {
  it('shows the loading state before the fetch resolves', () => {
    // A never-resolving fetch keeps data null → the loading branch renders.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderTab(<AdvDocsTab slug="h" />);
    expect(screen.getByText(/Loading docs…/i)).toBeTruthy();
  });

  it('shows the error branch when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    renderTab(<AdvDocsTab slug="h" />);
    await waitFor(() => expect(screen.getByText(/Could not load docs/i)).toBeTruthy());
    expect(screen.getByText(/HTTP 500/i)).toBeTruthy();
  });

  it('renders the empty (no-docs-dir) branch when files is empty', async () => {
    stubFetchOk(docsResponse({ files: [], entries: [] }));
    renderTab(<AdvDocsTab slug="h" />);
    await waitFor(() => expect(screen.getByText(/No project docs yet/i)).toBeTruthy());
  });

  it('renders the unknown_harness branch (lexicon passthrough)', async () => {
    stubFetchOk(docsResponse({ reason: 'unknown_harness', files: [], entries: [] }));
    renderTab(<AdvDocsTab slug="ghost" />);
    // t('pot') is passthrough → "pot"; the slug is interpolated.
    await waitFor(() => expect(screen.getByText(/Unknown pot/i)).toBeTruthy());
    expect(screen.getByText(/ghost/)).toBeTruthy();
  });

  it('with no slug renders the empty state without fetching', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    renderTab(<AdvDocsTab slug="" />);
    await waitFor(() => expect(screen.getByText(/No project docs yet/i)).toBeTruthy());
    expect(f).not.toHaveBeenCalled();
  });
});

describe('AdvDocsTab — read recovery', () => {
  const selectedDocs = (content: string) => docsResponse({
    activePath: 'guides/setup.md',
    content,
    activeEntry: { ...entry({ source: 'manual' }), overlay: null },
  });
  const response = (content: string) => new Response(JSON.stringify(selectedDocs(content)), { status: 200 });

  it('retries a cold failure with the same pot and selected document', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response('recovered-cold-doc'));
    vi.stubGlobal('fetch', fetchMock);
    renderTab(<AdvDocsTab slug="docs-cold-retry" />, '?docpath=guides/setup.md');

    await screen.findByText(/Could not load docs: HTTP 503/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('recovered-cold-doc');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/harness/docs-cold-retry/docs?path=guides%2Fsetup.md&recompute=1', { cache: 'no-store' },
    );
  });

  it('reports a failed warm refresh and retains the selected article throughout retry', async () => {
    let finishRetry!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('cached-warm-doc'))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRetry = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const first = renderTab(<AdvDocsTab slug="docs-warm-retry" />, '?docpath=guides/setup.md');
    await screen.findByText('cached-warm-doc');
    first.unmount();
    renderTab(<AdvDocsTab slug="docs-warm-retry" />, '?docpath=guides/setup.md');

    expect(screen.getByText('cached-warm-doc')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh docs: HTTP 500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('cached-warm-doc')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Refreshing docs');

    await act(async () => finishRetry(response('fresh-warm-doc')));
    await screen.findByText('fresh-warm-doc');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url ===
      '/api/harness/docs-warm-retry/docs?path=guides%2Fsetup.md&recompute=1')).toBe(true);
  });

  it('loads a cold article successfully without an error or retry control', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response('successful-doc-control'));
    vi.stubGlobal('fetch', fetchMock);
    renderTab(<AdvDocsTab slug="docs-success-control" />, '?docpath=guides/setup.md');

    await screen.findByText('successful-doc-control');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AdvDocsTab — nav + article', () => {
  it('shows the cached selected article on the first committed warm mount', async () => {
    stubFetchOk(docsResponse({ activePath: 'guides/setup.md', content: 'warm-private-doc',
      activeEntry: { ...entry({ source: 'manual' }), overlay: null } }));
    const first = renderTab(<AdvDocsTab slug="warm-private-docs" />, '?docpath=guides/setup.md');
    await screen.findByText('warm-private-doc');
    first.unmount();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const commits: string[] = [];
    renderTab(<Profiler id="warm-docs" onRender={() => commits.push(document.body.textContent ?? '')}>
      <AdvDocsTab slug="warm-private-docs" />
    </Profiler>, '?docpath=guides/setup.md');
    expect(commits[0]).toContain('warm-private-doc');
    expect(commits[0]).not.toContain('Loading docs');
  });

  it('renders the directory-grouped nav with one link per file', async () => {
    stubFetchOk(
      docsResponse({
        files: ['README.md', 'guides/setup.md', 'guides/deep.md'],
        entries: [
          entry({ docId: 'README.md' }),
          entry({ docId: 'guides/setup.md' }),
          entry({ docId: 'guides/deep.md' }),
        ],
      }),
    );
    renderTab(<AdvDocsTab slug="h" />);
    // Root group "/" + the guides/ group; basenames are de-extensioned.
    await waitFor(() => expect(screen.getByText('README')).toBeTruthy());
    expect(screen.getByText('setup')).toBeTruthy();
    expect(screen.getByText('deep')).toBeTruthy();
    expect(screen.getByText('guides')).toBeTruthy(); // group dir header
  });

  it('renders the active article head (crumb + source badge) and the body', async () => {
    stubFetchOk(
      docsResponse({
        activePath: 'guides/setup.md',
        content: '# Setup body',
        activeEntry: { ...entry({ source: 'manual' }), overlay: null },
      }),
    );
    renderTab(<AdvDocsTab slug="h" />, '?docpath=guides/setup.md');
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy()); // crumb
    expect(screen.getByText('Manual')).toBeTruthy(); // source badge
    expect(screen.getByText('# Setup body')).toBeTruthy(); // body via MarkdownPreview
  });

  it('renders the human augmented overlay when activeEntry.overlay is present', async () => {
    stubFetchOk(
      docsResponse({
        activePath: 'guides/setup.md',
        content: 'main',
        activeEntry: { ...entry({ source: 'augmented' }), overlay: 'overlay-body-marker' },
      }),
    );
    const { container } = renderTab(<AdvDocsTab slug="h" />, '?docpath=guides/setup.md');
    const q = within(container);
    await waitFor(() => expect(q.getByText(/Human note/i)).toBeTruthy());
    expect(q.getByText('overlay-body-marker')).toBeTruthy();
  });

  it('shows the stale status badge but NOT for a fresh doc', async () => {
    stubFetchOk(
      docsResponse({
        activePath: 'guides/setup.md',
        content: 'x',
        activeEntry: { ...entry({ status: 'stale', statusDetail: 'HEAD moved' }), overlay: null },
      }),
    );
    renderTab(<AdvDocsTab slug="h" />, '?docpath=guides/setup.md');
    await waitFor(() => expect(screen.getByText(/May be out of date/i)).toBeTruthy());
  });
});

describe('AdvDocsTab — actions', () => {
  it('shows Regenerate only for a stale generated/augmented doc, and POSTs on click', async () => {
    const f = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(docsResponse({
      activePath: 'guides/setup.md',
      content: 'x',
      activeEntry: { ...entry({ source: 'generated', status: 'stale' }), overlay: null },
    })), { status: 200 }));
    vi.stubGlobal('fetch', f);
    renderTab(<AdvDocsTab slug="h" />, '?docpath=guides/setup.md');

    const btn = await screen.findByRole('button', { name: 'Regenerate' });
    expect(btn).toBeTruthy();
    f.mockClear();
    fireEvent.click(btn);
    // The action POSTs to .../docs/regenerate, then reloads.
    await waitFor(() =>
      expect(f.mock.calls.some(([url]) => String(url).includes('/docs/regenerate'))).toBe(true),
    );
  });

  it('shows Re-verify only for a manual doc needing review, and POSTs on click', async () => {
    const f = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(docsResponse({
      activePath: 'guides/setup.md',
      content: 'x',
      activeEntry: { ...entry({ source: 'manual', status: 'review' }), overlay: null },
    })), { status: 200 }));
    vi.stubGlobal('fetch', f);
    renderTab(<AdvDocsTab slug="h" />, '?docpath=guides/setup.md');

    const btn = await screen.findByRole('button', { name: 'Re-verify' });
    expect(btn).toBeTruthy();
    f.mockClear();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(f.mock.calls.some(([url]) => String(url).includes('/docs/verify'))).toBe(true),
    );
  });

  it('retains the selected article after a denied action and clears the error after an exact retry', async () => {
    const activeEntry = { ...entry({ source: 'manual', status: 'review' }), overlay: null };
    const initial = docsResponse({ activePath: 'guides/setup.md', content: 'retained-private-doc',
      activeEntry });
    let verified = false;
    let posts = 0;
    const f = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ docId: 'guides/setup.md' });
        posts += 1;
        if (posts === 1) return new Response(JSON.stringify({ ok: false }), { status: 403 });
        verified = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(verified ? { ...initial,
        activeEntry: { ...activeEntry, status: 'fresh' } } : initial), { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    renderTab(<AdvDocsTab slug="denied-private-docs" />, '?docpath=guides/setup.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Re-verify' }));
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 403');
    expect(screen.getByText('retained-private-doc')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-verify' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Re-verify' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Re-verify' })).toBeNull());
    expect(posts).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('retained-private-doc')).toBeTruthy();
  });

  it('shows NO action buttons for a fresh generated doc', async () => {
    stubFetchOk(
      docsResponse({
        activePath: 'guides/setup.md',
        content: 'x',
        activeEntry: { ...entry({ source: 'generated', status: 'fresh' }), overlay: null },
      }),
    );
    renderTab(<AdvDocsTab slug="h" />, '?docpath=guides/setup.md');
    await waitFor(() => expect(screen.getByText('guides/setup.md')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-verify' })).toBeNull();
  });
});

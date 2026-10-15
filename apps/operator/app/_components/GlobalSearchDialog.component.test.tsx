// @vitest-environment jsdom
/**
 * GlobalSearchDialog (Mod+Shift+F global content search) — renders hits from
 * the public fulltext endpoint; the engine's own ts_headline markers become
 * <mark> ELEMENTS (and ONLY them — no raw-HTML injection).
 *
 * The marker is `<mark>`, not ts_headline's `<b>` default: the endpoint's
 * `HEADLINE_OPTS` sets `StartSel=<mark>`. This file used to assert `<b>`, which
 * is how the renderer sat splitting on a marker the engine never sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

// The dialog navigates via the router-compat shim (TanStack useNavigate
// underneath) — mock it so tests don't need a RouterProvider.
const pushMock = vi.fn();
vi.mock('../../lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

import GlobalSearchDialog, { hitHref, renderHighlight } from './GlobalSearchDialog';
// The engine's REAL headline options — imported, never re-typed, so the
// renderer's marker is checked against the source of truth rather than against
// another copy of the same assumption.
import { HEADLINE_OPTS } from '@papercusp/operator-core/lib/agent-tools/search/headline-options';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  pushMock.mockClear();
});

function envelope(results: unknown[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ query: 'voice', scope: ['all'], total_hits: results.length, results }),
          },
        ],
      }),
  } as Response;
}

describe('GlobalSearchDialog', () => {
  it('fetches the fulltext endpoint (debounced) and renders hits with <mark> highlights', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        envelope([
          {
            source: 'plans',
            source_id: 'universal-voice-interface-2026-06-05',
            harness_slug: 'all',
            excerpt: 'the voice bus',
            // `<mark>`, because that is what `HEADLINE_OPTS` makes the endpoint
            // emit. This fixture said `<b>` until 2026-09-04 and so simulated a
            // server that does not exist — which is why every assertion below
            // could be correct while the real dialog highlighted nothing.
            highlight: 'the <mark>voice</mark> bus',
          },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NuqsTestingAdapter searchParams="?gsearch=true&gq=voice">
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );

    const hit = await waitFor(() => screen.getByTestId('gsearch-hit'), { timeout: 3000 });
    expect(hit.textContent).toContain('plans');
    expect(hit.textContent).toContain('the voice bus');
    // The match is a real <mark>, not injected HTML.
    expect(hit.querySelector('mark')?.textContent).toBe('voice');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-tools/search/fulltext',
      expect.objectContaining({ method: 'POST' }),
    );
    const rawInit = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(rawInit.body))).toEqual({ query: 'voice', limit: 10 });
  });

  it('does not fetch while closed or for <2-char queries', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NuqsTestingAdapter searchParams="?gq=voice">
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );
    render(
      <NuqsTestingAdapter searchParams="?gsearch=true&gq=v">
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );
    await new Promise((r) => setTimeout(r, 450));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('renderHighlight', () => {
  /**
   * DRIFT CHECK, and the whole reason this block was rewritten on 2026-09-04.
   *
   * `renderHighlight` split on `<b>` — ts_headline's DEFAULT marker — while the
   * engine has been configured with `StartSel=<mark>`. The split matched
   * nothing, so the dialog rendered every headline as plain text with literal
   * `<mark>` tags showing, and highlighting was dead. It survived because the
   * old test fed it `<b>hit</b>`: the test had copied the same assumption as the
   * code, so the two agreed with each other and neither one measured the engine.
   *
   * Asserting against the real `HEADLINE_OPTS` is what makes that class of
   * failure impossible rather than merely fixed — change `StartSel` without
   * changing the renderer and this fails, instead of highlighting going quiet.
   */
  it('splits on the marker the engine actually emits', () => {
    expect(HEADLINE_OPTS).toContain('StartSel=<mark>');
    expect(HEADLINE_OPTS).toContain('StopSel=</mark>');
  });

  it('renders the engine marker as a real <mark> element', () => {
    const nodes = renderHighlight('a <mark>hit</mark> here');
    const { container } = render(<>{nodes}</>);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('hit');
    // …and the surrounding text is still there — a highlighter that eats the
    // rest of the headline is as broken as one that highlights nothing.
    expect(container.textContent).toBe('a hit here');
  });

  it('leaves every other markup inert, as TEXT rather than elements', () => {
    // No dangerouslySetInnerHTML anywhere on this path, so a corpus that quotes
    // markup cannot produce an element — it must come back as visible text.
    const nodes = renderHighlight('a <mark>hit</mark> & <script>alert(1)</script>');
    const { container } = render(<>{nodes}</>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });

  it('highlights every marked term in a multi-fragment headline', () => {
    // HEADLINE_OPTS sets MaxFragments=2, so two marked terms in one headline is
    // the ordinary case, not an edge one.
    const nodes = renderHighlight('<mark>a</mark> … <mark>b</mark>');
    const { container } = render(<>{nodes}</>);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['a', 'b']);
  });
});

describe('hitHref (source→route map)', () => {
  it('maps the four prose sources; unknown sources stay unlinked', () => {
    expect(hitHref({ source: 'brainstorm', harness_slug: 'papercup' })).toBe(
      '/adv?slug=papercup&tab=brainstorm',
    );
    expect(hitHref({ source: 'escalations', harness_slug: 'papercup' })).toBe(
      '/adv?slug=papercup&tab=overview',
    );
    expect(hitHref({ source: 'decisions', harness_slug: 'pot/a b' })).toBe(
      '/adv?slug=pot%2Fa%20b&tab=overview',
    );
    expect(hitHref({ source: 'turns' })).toBe('/adv?tab=conversations');
    expect(hitHref({ source: 'something-new' })).toBeNull();
  });
});

describe('hit navigation', () => {
  it('clicking a linked hit closes the overlay and routes to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          envelope([
            {
              source: 'brainstorm',
              source_id: 'papercup:staging',
              harness_slug: 'papercup',
              excerpt: 'voice notes',
              highlight: '<b>voice</b> notes',
            },
          ]),
        ),
      ),
    );
    const onUrlUpdate = vi.fn();
    render(
      <NuqsTestingAdapter searchParams="?gsearch=true&gq=voice" onUrlUpdate={onUrlUpdate}>
        <GlobalSearchDialog />
      </NuqsTestingAdapter>,
    );
    const hit = await waitFor(() => screen.getByTestId('gsearch-hit'), { timeout: 3000 });
    fireEvent.click(hit);
    expect(pushMock).toHaveBeenCalledWith('/adv?slug=papercup&tab=brainstorm');
    // The overlay closed itself (gsearch cleared from the URL).
    await waitFor(() => {
      const writes = onUrlUpdate.mock.calls.map((c) => String((c[0] as { search: string }).search));
      expect(writes.some((s) => !s.includes('gsearch=true'))).toBe(true);
    });
  });
});

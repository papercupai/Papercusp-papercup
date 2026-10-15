// @vitest-environment jsdom
/**
 * PrsTab component-level regression test.
 *
 * Guards the render-loop fix: PrsTab is mounted by AdvPrsPanel /
 * AdvHarnessPanelPage as `<PrsTab harnessSlug={slug} />` with NO
 * `trustedAuthorIds` prop, so the default param applied. When that default
 * was `new Set()` (a fresh reference every render) and `load` listed it in its
 * useCallback deps, `useEffect(() => void load(), [load])` re-fired on every
 * render — an infinite reload loop that stormed /api/harness/<slug>/prs (a
 * single mount was observed firing 194 requests) and wedged the webview's
 * connection pool, leaving the panel stuck on "Loading…".
 *
 * The fix decouples fetching (keyed on harnessSlug only) from the per-row
 * trusted/reviewerRoleEnabled enrichment (now a render-time memo). This test
 * asserts a single mount fetches exactly once and a parent re-render does not
 * refetch.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';

beforeAll(() => {
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// nuqs needs an adapter at runtime; stub useQueryState to plain useState so the
// component is testable in isolation (matches the next/navigation mock pattern
// used by the other component tests).
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    ...nuqsParsers,
    useQueryState: (_key: string, parser?: { __default?: unknown }) =>
      React.useState(parser?.__default ?? null),
    parseAsStringLiteral: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
    // P-049 added `prs_settings` via `parseAsBoolean.withDefault(false)`. Unlike
    // parseAsStringLiteral, parseAsBoolean is a bare parser object (not a factory).
    parseAsBoolean: { withDefault: (d: unknown) => ({ __default: d }) },
    // PR-3 added `prs_selected` via bare `parseAsInteger` (no withDefault).
    parseAsInteger: { __default: null },
  };
});

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// Exercise the tab's named-query contract while preserving the existing HTTP
// fixture responses. The production sync transport's cache/SSE has its own suite.
vi.mock('@papercusp/sync', async () => {
  const React = await import('react');
  return {
    onSyncBusEvent: () => () => {},
    useSyncQuery: ({ queryName, args, enabled = true }: { queryName: string; args?: { harnessSlug?: string; scope?: string }; enabled?: boolean }) => {
      const [data, setData] = React.useState<unknown[]>([]);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState<Error | null>(null);
      const [revision, setRevision] = React.useState(0);
      const key = JSON.stringify(args);
      React.useEffect(() => {
        let cancelled = false;
        if (!enabled || !['harnessPrs.byHarness', 'prReviewerSettings.byHarness'].includes(queryName)) {
          setData([]); setLoading(false); return;
        }
        setLoading(true);
        const url = `/api/harness/${args?.harnessSlug}/${queryName === 'harnessPrs.byHarness' ? `prs${args?.scope === 'hive' ? '?scope=hive' : ''}` : 'pr-reviewer-settings'}`;
        void fetch(url).then(async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const row: unknown = await response.json();
          if (!cancelled) { setData([row]); setError(null); }
        }).catch((e: Error) => { if (!cancelled) setError(e); })
          .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, [queryName, key, revision, enabled]);
      const invalidate = React.useCallback(() => setRevision(n => n + 1), []);
      return { data, loading, error, invalidate };
    },
    useSyncMutate: () => ({ mutate: vi.fn(), pending: false }),
  };
});
vi.mock('./PrDetails', () => ({ PrDetails: ({ harnessSlug, number }: { harnessSlug: string; number: number }) =>
  <div data-testid="pr-details">{harnessSlug}:{number}</div> }));

import { PrsTab, rowBelongsToViewedHarness, shouldShowAutoStatus } from './PrsTab';

describe('rowBelongsToViewedHarness — hive-scope auto-status honesty (PR-3 §4)', () => {
  it('single-harness rows (no member_slug) always belong', () => {
    expect(rowBelongsToViewedHarness({}, 'acme')).toBe(true);
    expect(rowBelongsToViewedHarness({ member_slug: undefined }, 'acme')).toBe(true);
  });
  it("a hive-scope row of the viewed harness belongs", () => {
    expect(rowBelongsToViewedHarness({ member_slug: 'acme' }, 'acme')).toBe(true);
  });
  it("a hive-scope row from a DIFFERENT member does NOT belong (suppress its auto-status)", () => {
    expect(rowBelongsToViewedHarness({ member_slug: 'other-member' }, 'acme')).toBe(false);
  });
});

describe('PrsTab — history and member-aware detail selection', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
  function mount() {
    const rows = ['open', 'merged', 'closed'].map((state, i) => ({
      remote: 'github.com/acme/repo', number: 7 + i, title: `${state} combined work`,
      author_login: 'avi', author_github_id: 1, html_url: `https://github.com/acme/repo/pull/${7 + i}`,
      state, review_decision: 'none', check_conclusion: null, trusted: false, reviewerRoleEnabled: false,
    }));
    rows.push({ ...rows[0], title: 'foreign combined work', member_slug: 'other' } as typeof rows[number]);
    const fallback = routedFetch({ autoModeEditable: false });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('/prs')
      ? { ok: true, status: 200, json: async () => ({ prs: rows }) } as Response
      : fallback(url)));
    return render(<PrsTab harnessSlug="acme" />);
  }
  it('shows open, merged and closed history and filters each actual state', async () => {
    const view = mount();
    await view.findByText('closed combined work');
    expect(view.getByText('open combined work')).toBeTruthy();
    expect(view.getByText('merged combined work')).toBeTruthy();
    fireEvent.click(view.getByRole('tab', { name: 'closed' }));
    expect(view.getByText('closed combined work')).toBeTruthy();
    expect(view.queryByText('open combined work')).toBeNull();
    fireEvent.click(view.getByRole('tab', { name: 'open' }));
    expect(view.queryByText('closed combined work')).toBeNull();
    expect(view.getByText('open combined work')).toBeTruthy();
  });
  it('opens details without a report and selects only the matching member for identical PR numbers', async () => {
    const view = mount();
    await view.findByText('foreign combined work');
    const buttons = view.getAllByRole('button', { name: 'Expand details for PR #7' });
    fireEvent.click(buttons[1]);
    expect(view.getAllByTestId('pr-details')).toHaveLength(1);
    expect(view.getByTestId('pr-details').textContent).toBe('other:7');
    fireEvent.click(view.getByRole('button', { name: 'Expand details for PR #7' }));
    expect(view.getAllByTestId('pr-details')).toHaveLength(1);
    expect(view.getByTestId('pr-details').textContent).toBe('acme:7');
  });
});

describe('shouldShowAutoStatus — viewed harness AND open only (PR-3 §4)', () => {
  it('shows for an open PR of the viewed harness', () => {
    expect(shouldShowAutoStatus({ state: 'open' }, 'acme')).toBe(true);
    expect(shouldShowAutoStatus({ member_slug: 'acme', state: 'open' }, 'acme')).toBe(true);
  });
  it('suppresses for non-open PRs (merged/closed/gone) — state badge speaks, no "blocked" noise', () => {
    expect(shouldShowAutoStatus({ state: 'merged' }, 'acme')).toBe(false);
    expect(shouldShowAutoStatus({ state: 'closed' }, 'acme')).toBe(false);
    expect(shouldShowAutoStatus({ state: 'gone' }, 'acme')).toBe(false);
  });
  it('suppresses for a different member even when open (settings not held)', () => {
    expect(shouldShowAutoStatus({ member_slug: 'other', state: 'open' }, 'acme')).toBe(false);
  });
});

function countPrsCalls(spy: ReturnType<typeof vi.fn>): number {
  return spy.mock.calls.filter((c) => String(c[0]).includes('/prs')).length;
}

describe('PrsTab — no render-loop refetch (regression)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ prs: [], pollingFailedAt: null, noRemote: false }),
      }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches /prs exactly once on mount (default trustedAuthorIds does not loop)', async () => {
    render(<PrsTab harnessSlug="acme" />);

    // settle: the empty state replaces "Loading…"
    await waitFor(() => {
      expect(document.body.textContent).toContain('No PRs match this filter.');
    });

    // Give any stray render→effect cycles a chance to fire, then assert it
    // stayed at a single request (the bug fired dozens-to-hundreds here).
    await new Promise((r) => setTimeout(r, 50));
    expect(countPrsCalls(fetchSpy)).toBe(1);
  });

  it('does not refetch when the parent re-renders with a fresh default', async () => {
    const view = render(<PrsTab harnessSlug="acme" />);
    await waitFor(() => expect(document.body.textContent).toContain('No PRs match this filter.'));
    expect(countPrsCalls(fetchSpy)).toBe(1);

    // Re-render the same element — a new render pass (and thus a new default
    // `new Set()`) must NOT trigger another fetch.
    view.rerender(<PrsTab harnessSlug="acme" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(countPrsCalls(fetchSpy)).toBe(1);
  });
});

// ── PR-3: owner-gated auto-mode toggle ────────────────────────────────

/** A fetch mock that routes by URL: /prs (empty), /pr-reviewer-settings (gate),
 *  /claim-status (claim). `autoModeEditable` drives whether the toggle is live. */
function routedFetch(opts: { autoModeEditable: boolean; autoOn?: boolean }) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/pr-reviewer-settings')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          settings: {
            pr_reviewer_role_enabled: !!opts.autoOn,
            auto_review: !!opts.autoOn,
            auto_merge: !!opts.autoOn,
            merge_method: 'squash',
          },
          trustList: [],
          audit: [],
          viewer: { github_user_id: 1, github_login: 'owner' },
          editable: true,
          claimOwner: opts.autoModeEditable,
          autoModeEditable: opts.autoModeEditable,
        }),
      } as unknown as Response;
    }
    if (u.includes('/claim-status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'unclaimed', viewer_can_claim: true, claimants: [] }),
      } as unknown as Response;
    }
    // /prs and anything else
    return {
      ok: true,
      status: 200,
      json: async () => ({ prs: [], pollingFailedAt: null, noRemote: false }),
    } as unknown as Response;
  });
}

describe('PrsTab — auto-mode toggle is claimed-owner gated (PR-3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('a non-owner sees the auto toggle READ-ONLY (disabled)', async () => {
    vi.stubGlobal('fetch', routedFetch({ autoModeEditable: false }));
    const { findByLabelText } = render(<PrsTab harnessSlug="acme" />);
    const toggle = (await findByLabelText('Auto-apply agent recommendations')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
  });

  it('a claimed owner can flip the auto toggle (enabled)', async () => {
    vi.stubGlobal('fetch', routedFetch({ autoModeEditable: true, autoOn: false }));
    const { findByLabelText } = render(<PrsTab harnessSlug="acme" />);
    const toggle = (await findByLabelText('Auto-apply agent recommendations')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reflects auto-mode ON when role + both auto levers are set', async () => {
    vi.stubGlobal('fetch', routedFetch({ autoModeEditable: true, autoOn: true }));
    const { findByLabelText } = render(<PrsTab harnessSlug="acme" />);
    const toggle = (await findByLabelText('Auto-apply agent recommendations')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});

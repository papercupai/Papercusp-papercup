/**
 * @vitest-environment jsdom
 *
 * Cupboard ListingCard — claim-status badge, publisher signal, and per-kind
 * action wiring.
 *
 * Regression guard for the Cupboard browse "provisional tag" gap: an
 * `unclaimed` (provisional) listing must surface the canonical
 * ClaimStatusBadge in its `unclaimed` state rather than render unlabeled.
 * Plus the per-listing action contract (D-005, reframed by
 * comb-retire-per-harness-sharing-2026-06-11): View Hive (hive-bound harness
 * row) / none (legacy harness row — per-harness join retired) / Fork
 * (blueprint) / Install (plugin, pack), driven by `listingActionFor()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';
import type { IdentityOutcomeCost } from '@papercusp/operator-core/lib/cupboard/shadow-metering-reader';

const outcomeSync = vi.hoisted(() => ({ read: vi.fn(), invalidate: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: outcomeSync.read }));
beforeEach(() => {
  outcomeSync.read.mockReset();
  outcomeSync.invalidate.mockReset();
  outcomeSync.read.mockReturnValue({ data: [], loading: false, fetching: false, error: null,
    invalidate: outcomeSync.invalidate });
});

// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the hive→pot
// routed copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@/lib/router-compat/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', async () => {
  const React = await import('react');
  const withDefault = (defaultValue: unknown) => ({ defaultValue });
  return {
    ...nuqsParsers,
    parseAsString: { withDefault },
    parseAsStringEnum: () => ({ withDefault }),
    useQueryState: (_key: string, parser?: { defaultValue?: unknown }) =>
      React.useState(parser && 'defaultValue' in parser ? parser.defaultValue : null),
  };
});

import CupboardClient, { ListingCard, HiveBrowseCard, HiveRollupHeaderCard } from '../CupboardClient';
import { groupHarnessRowsByHive } from '@papercusp/operator-core/lib/cupboard/types';
import type { HarnessListing, ListingKind } from '@papercusp/operator-core/lib/cupboard/types';

afterEach(() => cleanup());

/** Radix Tooltip needs its provider (the SPA root mounts one globally). */
function withTooltips(ui: ReactElement) {
  return render(<RadixTooltip.Provider delayDuration={0}>{ui}</RadixTooltip.Provider>);
}

function listing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return {
    id: 1,
    slug: 'demo',
    title: 'Demo harness',
    description: '',
    harness_link: 'papercusp://harness?topic=abc&github=o/r&repo_id=1',
    github_repository_id: 1,
    github_repo: 'o/r',
    github_repo_must_be_public: true,
    published_by_github_user_id: 10,
    provisional_owner_github_user_id: 10,
    claim_status: 'unclaimed',
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_id: null,
    contributor_count_estimate: 0,
    last_activity_at: null,
    language: null,
    tags: [],
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const HIVE_PK = 'A'.repeat(43) + '=';

describe('CupboardClient — WI-3259 tab switching and loading state', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
        listings: [
          listing({ id: 1, title: 'Harness listing', listing_kind: 'harness', hive_pubkey: HIVE_PK }),
          listing({ id: 2, title: 'Plugin listing', listing_kind: 'plugin' }),
          listing({ id: 3, title: 'Rubric listing', listing_kind: 'rubric' }),
          listing({ id: 4, title: 'Plan listing', listing_kind: 'plan' }),
          listing({ id: 5, title: 'Recipe listing', listing_kind: 'recipe' }),
        ],
        next_cursor: null,
        total: 5,
        kind_facets: { harness: 1, plugin: 1, rubric: 1, plan: 1, recipe: 1 },
      }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('server-filters selected kind tabs instead of filtering page one as a corpus', async () => {
    withTooltips(<CupboardClient />);

    await waitFor(() => expect(screen.getByText('Plugin listing')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/cupboard/listings?limit=100');

    fireEvent.click(screen.getByTestId('cupboard-kind-tab-plugin'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/cupboard/listings?limit=100&kind=plugin');
    expect(screen.getByText('Plugin listing')).toBeTruthy();
    expect(screen.queryByText('Harness listing')).toBeNull();
  });

  it('reads one exact SKU batch for the storefront, hides pending evidence and changes the read key on refresh', async () => {
    const releaseRef = 'identity-release:reviewer@1.0.0';
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ listings: [
      listing({ id: 1, title: 'Reviewer A', listing_kind: 'blueprint', blueprint_kind: 'identity', sku_ref: releaseRef }),
      listing({ id: 2, title: 'Reviewer B', listing_kind: 'blueprint', blueprint_kind: 'identity', sku_ref: releaseRef }),
    ], next_cursor: null, total: 2 }), { status: 200 }));
    const data: IdentityOutcomeCost[] = [{ status: 'verified', basis: 'local-funded-release-usage', currency: 'USD',
      releaseRef, costPerAcceptedOutcomeMicros: '123', totalCostMicros: '123', acceptedOutcomes: 1,
      totalOutcomes: 1, turns: 1, evidenceRefs: ['graded-clause:accepted'] }];
    outcomeSync.read.mockReturnValue({ data, loading: false, fetching: false, error: null, invalidate: outcomeSync.invalidate });
    const view = withTooltips(<CupboardClient />);
    await waitFor(() => expect(screen.getAllByLabelText('Identity outcome cost')).toHaveLength(2));
    expect(screen.getAllByLabelText('Identity outcome cost').every(row => row.textContent?.includes('$0.000123'))).toBe(true);
    const lastQuery = () => outcomeSync.read.mock.calls.at(-1)![0];
    expect(lastQuery()).toMatchObject({ queryName: 'cupboard.identityOutcomeCosts', args: { releaseRefs: [releaseRef] },
      enabled: true, staleTime: 0, pollIntervalMs: 0, persist: false });
    const priorKey = lastQuery().args.readKey;
    outcomeSync.read.mockReturnValue({ data, loading: false, fetching: true, error: null, invalidate: outcomeSync.invalidate });
    view.rerender(<RadixTooltip.Provider delayDuration={0}><CupboardClient /></RadixTooltip.Provider>);
    expect(screen.getAllByLabelText('Identity outcome cost').every(row => row.textContent === 'Cost per accepted outcome: unavailable')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastQuery().args.readKey).not.toBe(priorKey);
    expect(outcomeSync.read.mock.calls.every(([options]) => options.queryName === 'cupboard.identityOutcomeCosts')).toBe(true);
  });

  it('renders and filters the Rubrics, Plans, and Recipes tabs', async () => {
    withTooltips(<CupboardClient />);
    await waitFor(() => expect(screen.getByText('Plugin listing')).toBeTruthy());

    for (const [kind, label, title] of [
      ['rubric', 'Rubrics', 'Rubric listing'],
      ['plan', 'Plans', 'Plan listing'],
      ['recipe', 'Recipes', 'Recipe listing'],
    ] as const) {
      const tab = screen.getByTestId(`cupboard-kind-tab-${kind}`);
      expect(tab.textContent).toContain(label);
      fireEvent.click(tab);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(
        kind === 'rubric' ? 2 : kind === 'plan' ? 3 : 4,
      ));
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.queryByText('Plugin listing')).toBeNull();
    }

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls.slice(1).map((call) => String(call[0]))).toEqual([
      '/api/cupboard/listings?limit=100&kind=rubric',
      '/api/cupboard/listings?limit=100&kind=plan',
      '/api/cupboard/listings?limit=100&kind=recipe',
    ]);
  });

  it('shows an explicit listings loading indicator while the fetch is in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    withTooltips(<CupboardClient />);

    expect(screen.getByTestId('cupboard-loading-indicator').textContent).toContain('Loading');
    expect(screen.getByTestId('cupboard-results').getAttribute('aria-busy')).toBe('true');
  });
});

describe('CupboardClient — corpus pagination and authoritative kind facets', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();
  const firstPage = Array.from({ length: 100 }, (_, i) => listing({
    id: i + 1,
    title: `Harness ${i + 1}`,
    listing_kind: 'harness',
    hive_pubkey: HIVE_PK,
    github_repo: `o/r-${i + 1}`,
  }));
  const deepApp = listing({ id: 101, title: 'Deep page app', listing_kind: 'app' });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('discovers and server-fetches a kind whose only row is beyond page one', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const appSelected = url.includes('kind=app');
      return new Response(JSON.stringify({
        listings: appSelected ? [deepApp] : firstPage,
        next_cursor: appSelected ? null : 'v1:901:h-100',
        total: appSelected ? 1 : 101,
        kind_facets: { harness: 100, app: 1 },
      }), { status: 200 });
    });

    withTooltips(<CupboardClient />);
    await waitFor(() => expect(screen.getByTestId('cupboard-kind-count-all').textContent).toBe('101'));
    expect(screen.getByTestId('cupboard-kind-count-app').textContent).toBe('1');
    expect(screen.queryByText('Deep page app')).toBeNull();

    fireEvent.click(screen.getByTestId('cupboard-kind-tab-app'));
    await waitFor(() => expect(screen.getByText('Deep page app')).toBeTruthy());
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/cupboard/listings?limit=100&kind=app');
  });

  it('keeps the exact corpus total visible when the first page is already exhausted', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      listings: [deepApp],
      next_cursor: null,
      total: 1,
      kind_facets: { app: 1 },
    }), { status: 200 }));

    withTooltips(<CupboardClient />);

    await waitFor(() => {
      expect(screen.getByTestId('cupboard-pagination').textContent).toContain('Showing 1 of 1');
    });
    expect(screen.queryByTestId('cupboard-load-more')).toBeNull();
  });

  it('appends the next page and stops when the server reports exhaustion', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const nextPage = url.includes('cursor=');
      return new Response(JSON.stringify({
        listings: nextPage ? [deepApp] : firstPage,
        next_cursor: nextPage ? null : 'v1:901:h-100',
        total: 101,
        kind_facets: { harness: 100, app: 1 },
      }), { status: 200 });
    });

    withTooltips(<CupboardClient />);
    const loadMore = await screen.findByTestId('cupboard-load-more');
    expect(screen.getByTestId('cupboard-pagination').textContent).toContain('Showing 100 of 101');
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByText('Deep page app')).toBeTruthy());
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=v1%3A901%3Ah-100');
    expect(screen.queryByTestId('cupboard-load-more')).toBeNull();
  });
});

describe('CupboardClient — Pots tab always visible + empty state [owner 2026-07-14]', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // No pot (harness) listings at all — only a plugin. Pre-revival this hid the
    // Pots tab entirely (P-015 "empty tabs hide"); now it must still show.
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ listings: [listing({ id: 2, title: 'Plugin listing', listing_kind: 'plugin' })] }),
      { status: 200 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows the Pots tab even when no pot is published, and its empty state explains + points to publishing', async () => {
    withTooltips(<CupboardClient />);

    await waitFor(() => expect(screen.getByText('Plugin listing')).toBeTruthy());
    // The Pots (harness) tab renders despite zero pot listings.
    const potsTab = screen.getByTestId('cupboard-kind-tab-harness');
    expect(potsTab).toBeTruthy();

    fireEvent.click(potsTab);

    // NB: the lexicon mock echoes t('pot') verbatim (no pluralization), so the
    // live "No shared pots yet" reads "No shared pot yet" under test.
    const empty = screen.getByTestId('cupboard-pots-empty');
    expect(empty.textContent).toMatch(/No shared pot .*yet/i);
    expect(empty.textContent).toMatch(/Publish one of yours/i);
  });
});

describe('CupboardClient — Apps tab always visible + empty state [owner 2026-07-14]', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // No app listings at all — only a plugin. The Apps tab must still show (it is
    // always-visible per the owner directive), and clicking it must explain the
    // feature rather than render a blank grid.
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ listings: [listing({ id: 2, title: 'Plugin listing', listing_kind: 'plugin' })] }),
      { status: 200 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows the Apps tab even when no app is published, with a self-explaining empty state', async () => {
    withTooltips(<CupboardClient />);

    await waitFor(() => expect(screen.getByText('Plugin listing')).toBeTruthy());
    const appsTab = screen.getByTestId('cupboard-kind-tab-app');
    expect(appsTab).toBeTruthy();

    fireEvent.click(appsTab);

    const empty = screen.getByTestId('cupboard-apps-empty');
    expect(empty.textContent).toMatch(/No apps yet/i);
    expect(empty.textContent).toMatch(/built on the platform/i);
  });
});

describe('CupboardClient — EVERY kind tab is visible at count 0 [owner 2026-09-15]', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();

  // The kinds that were INVISIBLE before this change: the worker returns
  // explicit zeros for them, and the old visibleFilters dropped any tab whose
  // count was 0. Publishing a plan/recipe/goal was therefore undiscoverable
  // through the UI — self-perpetuating, since the tab only appeared once
  // someone had already published into it.
  const ZERO_KINDS = ['theme', 'pack', 'knowledge-pack', 'rubric', 'plan', 'recipe', 'goal'] as const;
  // Kinds carrying a real corpus in the same fixture, so a passing assertion
  // cannot come from "every tab renders regardless of the facets payload".
  const NONZERO_KINDS = { blueprint: 17, template: 13, harness: 2, plugin: 1, app: 1 } as const;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders a real 0 counter for every empty kind, and keeps the non-empty counts intact', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      listings: [listing({ id: 2, title: 'Blueprint listing', listing_kind: 'blueprint' })],
      total: 34,
      // The live corpus shape measured 2026-09-15: explicit zeros, not omissions.
      kind_facets: { ...NONZERO_KINDS, ...Object.fromEntries(ZERO_KINDS.map((k) => [k, 0])) },
    }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    withTooltips(<CupboardClient />);
    // The 'all' pill renders the FACET SUM (allKindsTotal), not the `total`
    // field — 17+13+2+1+1, with the seven zero kinds contributing nothing.
    const nonZeroSum = Object.values(NONZERO_KINDS).reduce((a, b) => a + b, 0);
    await waitFor(() => expect(screen.getByTestId('cupboard-kind-count-all').textContent)
      .toBe(String(nonZeroSum)));

    for (const kind of ZERO_KINDS) {
      expect(screen.getByTestId(`cupboard-kind-tab-${kind}`)).toBeTruthy();
      // A real '0', never '—': the dash means "not loaded yet", which is a
      // different fact from "nothing published" and must keep reading so.
      expect(screen.getByTestId(`cupboard-kind-count-${kind}`).textContent).toBe('0');
    }
    for (const [kind, count] of Object.entries(NONZERO_KINDS)) {
      expect(screen.getByTestId(`cupboard-kind-count-${kind}`).textContent).toBe(String(count));
    }
  });

  it('still shows the tabs — with a — placeholder — before the facets have loaded', async () => {
    fetchMock.mockReset();
    // No kind_facets key at all: the pre-load state. Tabs must already be
    // present (so the strip does not reflow as counts arrive) and must NOT
    // claim zero for a corpus nobody has measured yet.
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ listings: [listing({ id: 2, title: 'Blueprint listing', listing_kind: 'blueprint' })] }),
      { status: 200 },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    withTooltips(<CupboardClient />);
    await waitFor(() => expect(screen.getByText('Blueprint listing')).toBeTruthy());

    for (const kind of ZERO_KINDS) {
      expect(screen.getByTestId(`cupboard-kind-tab-${kind}`)).toBeTruthy();
      expect(screen.getByTestId(`cupboard-kind-count-${kind}`).textContent).toBe('—');
    }
  });
});

describe('Cupboard ListingCard — app distribution (P-004)', () => {
  const APP_PLATFORMS = JSON.stringify(['darwin-aarch64', 'linux-x86_64']);

  it('standalone app → download action (link handoff), label falls back to Download for an unknown viewer OS', () => {
    // Stub the UA to an OS the manifest doesn't advertise so the platform-aware
    // label deterministically falls back (the CI host's real UA is Linux, which
    // WOULD match linux-x86_64 — so pin an unknown OS here).
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    const plat = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (compatible; UnknownOS)',
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'platform', { value: 'UnknownOS', configurable: true });
    try {
      render(
        <ListingCard
          listing={listing({ listing_kind: 'app', title: 'Oddsmith', platforms: APP_PLATFORMS })}
          onAction={() => {}}
          onDetail={() => {}}
        />,
      );
      const btn = screen.getByTestId('cupboard-action');
      expect(btn.getAttribute('data-action')).toBe('download');
      expect(btn.textContent).toContain('Download');
      expect(btn.textContent).not.toContain('Get for');
    } finally {
      if (ua) Object.defineProperty(window.navigator, 'userAgent', ua);
      if (plat) Object.defineProperty(window.navigator, 'platform', plat);
    }
  });

  it('a bundle app → install action (Phase 2 delivery)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'app', delivery_type: 'bundle', title: 'Bundle App' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-action').getAttribute('data-action')).toBe('install');
  });

  it('renders the OS-family platform chips from the denormalized platforms JSON', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'app', platforms: APP_PLATFORMS })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const chips = screen.getByTestId('cupboard-app-platforms');
    expect(chips.textContent).toContain('macOS');
    expect(chips.textContent).toContain('Linux');
    // Two distinct OS families, not the raw updater keys.
    expect(chips.textContent).not.toContain('aarch64');
  });

  it('omits the platform chips when platforms is absent/unparseable', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'app', platforms: null })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-app-platforms')).toBeNull();
  });

  it('makes the download CTA platform-aware when the viewer OS matches an available platform', () => {
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });
    try {
      render(
        <ListingCard
          listing={listing({ listing_kind: 'app', platforms: APP_PLATFORMS })}
          onAction={() => {}}
          onDetail={() => {}}
        />,
      );
      expect(screen.getByTestId('cupboard-action').textContent).toContain('Get for macOS');
    } finally {
      if (ua) Object.defineProperty(window.navigator, 'userAgent', ua);
    }
  });

  it('renders an app kind badge', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'app', platforms: APP_PLATFORMS })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-kind-badge').getAttribute('data-kind')).toBe('app');
  });
});

describe('Cupboard ListingCard — claim-status badge', () => {
  it('surfaces the provisional (unclaimed) badge for an unclaimed listing', () => {
    render(
      <ListingCard
        listing={listing({ claim_status: 'unclaimed' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('claim-status-badge-unclaimed')).toBeTruthy();
    expect(screen.queryByTestId('claim-status-badge-claimed')).toBeNull();
  });

  it('shows the claimed badge for a claimed listing', () => {
    render(
      <ListingCard
        listing={listing({ claim_status: 'claimed' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('claim-status-badge-claimed')).toBeTruthy();
    expect(screen.queryByTestId('claim-status-badge-unclaimed')).toBeNull();
  });
});

describe('Cupboard ListingCard — publisher signal', () => {
  it('flags a non-collaborator publisher (read-only perm)', () => {
    render(
      <ListingCard
        listing={listing({ publisher_permission: 'read' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const sig = screen.getByTestId('cupboard-publisher-signal');
    expect(sig.getAttribute('data-collaborator')).toBe('false');
  });

  it('marks a collaborator publisher (write perm)', () => {
    render(
      <ListingCard
        listing={listing({ publisher_permission: 'write' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-publisher-signal').getAttribute('data-collaborator')).toBe('true');
  });

  it('shows no signal when permission is unknown (legacy row)', () => {
    render(
      <ListingCard
        listing={listing({ publisher_permission: null })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-publisher-signal')).toBeNull();
  });
});

describe('Cupboard ListingCard — per-listing action (D-005 / comb-retire)', () => {
  const cases: Array<{ kind: ListingKind; action: string; label: string }> = [
    { kind: 'blueprint', action: 'install', label: 'Install' },
    // ('snapshot → fork' removed — snapshot kind retired by retire-snapshots-instance-spec-2026-06-09 D-005.)
    { kind: 'plugin', action: 'install', label: 'Install' },
    { kind: 'pack', action: 'install', label: 'Install' }, // runtime-less code-tool pack (canonical 'pack', mig 010 / P-003)
    { kind: 'knowledge-pack', action: 'install', label: 'Install' }, // curated hive learnings (knowledge-packs mig 008)
    { kind: 'template', action: 'install', label: 'Install' }, // app/aspect template (cupboard-public-release P-002)
  ];
  for (const c of cases) {
    it(`${c.kind} → ${c.action} action`, () => {
      render(
        <ListingCard
          listing={listing({ listing_kind: c.kind })}
          onAction={() => {}}
          onDetail={() => {}}
        />,
      );
      const btn = screen.getByTestId('cupboard-action');
      expect(btn.getAttribute('data-action')).toBe(c.action);
      expect(btn.textContent).toContain(c.label);
    });
  }

  it('hive-bound harness row → View Hive action (the repo→Hive lookup index)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'harness', hive_pubkey: 'k'.repeat(44), hive_title: 'Demo Hive' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const btn = screen.getByTestId('cupboard-action');
    expect(btn.getAttribute('data-action')).toBe('view-hive');
    // Label routed through the lexicon (echoed key 'pot'), not the hardcoded "Hive".
    expect(btn.textContent).toContain('View pot');
  });

  it('legacy harness row (no hive) → NO primary action (per-harness join retired)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'harness' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-action')).toBeNull();
  });

  it('absent kind ⇒ harness semantics (legacy row, no primary action)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: undefined })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-action')).toBeNull();
  });

  it('renders a kind badge reflecting the listing kind', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'plugin' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-kind-badge').getAttribute('data-kind')).toBe('plugin');
  });

  it('renders a template card without crashing (regression: missing CUPBOARD_LISTING_KIND_TONE[template] threw on tone.fg)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'template', title: 'Agentic Desktop App' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-kind-badge').getAttribute('data-kind')).toBe('template');
    expect(screen.getByTestId('cupboard-action').getAttribute('data-action')).toBe('install');
  });
});

describe('Cupboard ListingCard — D-002 pot-template badge (single Blueprints tab)', () => {
  it('a pot blueprint (blueprint_kind=pot) badges as a "pot template", not a plain blueprint', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint', blueprint_kind: 'pot', title: 'Work Pot' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const badge = screen.getByTestId('cupboard-kind-badge');
    // Kind stays 'blueprint' (data-driven), but it reads + flags as a pot template.
    expect(badge.getAttribute('data-kind')).toBe('blueprint');
    expect(badge.getAttribute('data-pot-template')).toBe('true');
    expect(badge.textContent).toContain('pot template');
  });

  it('the legacy pre-rename value (blueprint_kind=hive) also badges as a pot template', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint', blueprint_kind: 'hive' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-kind-badge').getAttribute('data-pot-template')).toBe('true');
  });

  it('an ordinary role blueprint is NOT flagged as a pot template', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint', blueprint_kind: 'harness', title: 'review' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const badge = screen.getByTestId('cupboard-kind-badge');
    expect(badge.getAttribute('data-pot-template')).toBeNull();
    expect(badge.textContent).toContain('blueprint');
  });

  it('an identity blueprint (blueprint_kind=identity) badges as an identity (portable-identity-packages P-016)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint', blueprint_kind: 'identity', title: 'Reviewer' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    const badge = screen.getByTestId('cupboard-kind-badge');
    expect(badge.getAttribute('data-kind')).toBe('blueprint');
    expect(badge.getAttribute('data-identity')).toBe('true');
    expect(badge.getAttribute('data-pot-template')).toBeNull();
    expect(badge.textContent).toContain('identity');
    // Neither listing activity nor installations establish verified outcomes.
    expect(screen.getByLabelText('Identity outcome cost').textContent).toBe(
      'Cost per accepted outcome: unavailable',
    );
  });

  it.each(['harness', 'pot'] as const)('does not attach identity outcome economics to a %s blueprint', (blueprintKind) => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint', blueprint_kind: blueprintKind, title: 'Other blueprint' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    expect(screen.getByTestId('cupboard-kind-badge')).toBeTruthy();
    expect(screen.queryByLabelText('Identity outcome cost')).toBeNull();
  });

  it('shows exact local funded cost for the matching release, including its accepted denominator', () => {
    const releaseRef = 'identity-release:reviewer@1.0.0';
    render(<ListingCard listing={listing({ listing_kind: 'blueprint', blueprint_kind: 'identity', sku_ref: releaseRef })}
      outcomeCost={{ status: 'verified', basis: 'local-funded-release-usage', currency: 'USD', releaseRef,
        costPerAcceptedOutcomeMicros: '9007199254740993', totalCostMicros: '18014398509481985',
        acceptedOutcomes: 2, totalOutcomes: 3, turns: 4, evidenceRefs: ['graded-clause:accepted'] }}
      onAction={() => {}} onDetail={() => {}} />);
    expect(screen.getByLabelText('Identity outcome cost').textContent).toBe(
      'Cost per accepted outcome: $9007199254.740993 · 2 accepted · local funded usage');
  });

  it.each(['different-release', 'unavailable', 'zero-denominator', 'malformed-cost'])('keeps %s evidence unavailable', reason => {
    const releaseRef = 'identity-release:reviewer@1.0.0';
    const metric = { status: 'verified', basis: 'local-funded-release-usage', currency: 'USD', releaseRef,
      costPerAcceptedOutcomeMicros: '123', totalCostMicros: '123', acceptedOutcomes: 1,
      totalOutcomes: 1, turns: 1, evidenceRefs: ['graded-clause:accepted'] };
    const change = reason === 'different-release' ? { releaseRef: 'identity-release:reviewer@2.0.0' } :
      reason === 'unavailable' ? { status: 'unavailable', costPerAcceptedOutcomeMicros: null, reason: 'grading-unverified' } :
      reason === 'zero-denominator' ? { acceptedOutcomes: 0 } : { costPerAcceptedOutcomeMicros: 'unknown' };
    render(<ListingCard listing={listing({ listing_kind: 'blueprint', blueprint_kind: 'identity', sku_ref: releaseRef })}
      outcomeCost={{ ...metric, ...change } as IdentityOutcomeCost} onAction={() => {}} onDetail={() => {}} />);
    expect(screen.getByLabelText('Identity outcome cost').textContent).toBe('Cost per accepted outcome: unavailable');
  });

  it('renders a repo slug derived from worker fields when github_repo is absent', () => {
    render(
      <ListingCard
        listing={listing({ github_repo: undefined, github_owner: 'acme', github_name: 'widget' })}
        onAction={() => {}}
        onDetail={() => {}}
      />,
    );
    // The external-repo link accessible name carries the derived slug.
    expect(screen.getByRole('link', { name: 'Open github.com/acme/widget' })).toBeTruthy();
  });
});

describe('Cupboard ListingCard — Hive chip (per-Hive rollup, D-005)', () => {
  it('renders a clickable Hive chip when hiveRef + onHive are provided', () => {
    const onHive = vi.fn();
    render(
      <ListingCard
        listing={listing({ project_ref: 'papercupai/demo' })}
        onAction={() => {}}
        onDetail={() => {}}
        hiveRef="papercupai/demo"
        onHive={onHive}
      />,
    );
    const chip = screen.getByTestId('cupboard-hive-chip');
    expect(chip.getAttribute('data-hive')).toBe('papercupai/demo');
    chip.click();
    expect(onHive).toHaveBeenCalledTimes(1);
  });

  it('omits the Hive chip when onHive is not provided (rollup mode)', () => {
    render(
      <ListingCard
        listing={listing({ project_ref: 'papercupai/demo' })}
        onAction={() => {}}
        onDetail={() => {}}
        hiveRef="papercupai/demo"
      />,
    );
    expect(screen.queryByTestId('cupboard-hive-chip')).toBeNull();
  });

  it('omits the Hive chip when hiveRef is empty (ungroupable listing)', () => {
    render(
      <ListingCard
        listing={listing()}
        onAction={() => {}}
        onDetail={() => {}}
        hiveRef=""
        onHive={() => {}}
      />,
    );
    expect(screen.queryByTestId('cupboard-hive-chip')).toBeNull();
  });
});

// ─── comb-hive-native-sharing-2026-06-11 Phase 1 ────────────────────────────

describe('ListingCard — suppressViewHive (rollup mode, P-001)', () => {
  it('hides the redundant View Hive button inside the rollup', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'harness', hive_pubkey: HIVE_PK })}
        onAction={() => {}}
        onDetail={() => {}}
        suppressViewHive
      />,
    );
    expect(screen.queryByTestId('cupboard-action')).toBeNull();
  });

  it('keeps Fork/Install actions in rollup mode (only view-hive is redundant)', () => {
    render(
      <ListingCard
        listing={listing({ listing_kind: 'blueprint' })}
        onAction={() => {}}
        onDetail={() => {}}
        suppressViewHive
      />,
    );
    expect(screen.getByTestId('cupboard-action').getAttribute('data-action')).toBe('install');
  });
});

describe('HiveBrowseCard — hive-first flat browse (P-002)', () => {
  function group() {
    const rows = [
      listing({ id: 1, hive_pubkey: HIVE_PK, hive_title: 'Demo Hive', github_repo: 'o/r1', claim_status: 'claimed' }),
      listing({ id: 2, hive_pubkey: HIVE_PK, github_repo: 'o/r2' }),
    ];
    return groupHarnessRowsByHive(rows).hives[0];
  }

  it('renders ONE card per hive: title, member repos, claim rollup, View Hive CTA', () => {
    const onOpen = vi.fn();
    withTooltips(<HiveBrowseCard group={group()} onOpen={onOpen} />);
    const card = screen.getByTestId('cupboard-hive-card');
    expect(card.getAttribute('data-hive-pubkey')).toBe(HIVE_PK);
    expect(card.textContent).toContain('Demo Hive');
    expect(card.textContent).toContain('o/r1');
    expect(card.textContent).toContain('o/r2');
    expect(screen.getByTestId('cupboard-claim-rollup').textContent).toContain('1/2 claimed');
    fireEvent.click(screen.getByTestId('cupboard-hive-card-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('HiveRollupHeaderCard — the hive as the joinable unit (P-001/P-003)', () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const members = [
    listing({ id: 1, hive_pubkey: HIVE_PK, hive_title: 'Demo Hive', github_repo: 'o/r1' }),
    listing({ id: 2, hive_pubkey: HIVE_PK, github_repo: 'o/r2', claim_status: 'claimed' }),
  ];

  function directoryResponds(rows: unknown[]) {
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/discovery/pots')) {
        return new Response(JSON.stringify({ count: rows.length, rows }), { status: 200 });
      }
      if (u.includes('/api/discovery/join-pot')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { memberLinks?: string[] };
        return new Response(
          JSON.stringify({ ok: true, potSlug: 'demo-hive', members: (body.memberLinks ?? []).map(() => ({ ok: true })) }),
          { status: 200 },
        );
      }
      if (u.includes('/claim')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
  }

  it('resolves the announce by hive_pubkey: title, visibility, Join CTA → join-pot', async () => {
    directoryResponds([
      {
        potId: 'demo', title: 'Demo Hive', description: '', owner: 'alice',
        visibility: 'public', memberLinks: ['papercusp://harness?topic=a', 'papercusp://harness?topic=b'],
        memberCount: 2, hivePubkey: HIVE_PK,
      },
    ]);
    withTooltips(<HiveRollupHeaderCard hiveRef={HIVE_PK} members={members} onClaimed={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-hive-join')).toBeTruthy());
    expect(screen.getByTestId('cupboard-hive-rollup-title').textContent).toBe('Demo Hive');
    expect(screen.getByTestId('cupboard-hive-visibility').getAttribute('data-visibility')).toBe('public');
    fireEvent.click(screen.getByTestId('cupboard-hive-join'));
    await waitFor(() =>
      expect(screen.getByTestId('cupboard-hive-join-msg').textContent).toContain("Joined pot 'demo-hive' — 2/2"),
    );
    const joinCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('join-pot'))!;
    expect(JSON.parse(String((joinCall[1] as RequestInit).body))).toMatchObject({ potId: 'demo' });
  });

  it('honest empty-state + invite-link affordance when no announce resolves', async () => {
    directoryResponds([]);
    withTooltips(<HiveRollupHeaderCard hiveRef={HIVE_PK} members={members} onClaimed={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-hive-join-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('cupboard-hive-join')).toBeNull();
    expect(screen.getByTestId('cupboard-hive-invite-input')).toBeTruthy();
    expect(screen.getByTestId('cupboard-hive-join-unavailable').textContent).toContain("isn't announcing");
  });

  it('claim rollup + Claim CTA drive the loopback claim proxy for unclaimed members (P-003)', async () => {
    directoryResponds([]);
    const onClaimed = vi.fn();
    withTooltips(<HiveRollupHeaderCard hiveRef={HIVE_PK} members={members} onClaimed={onClaimed} />);
    await waitFor(() => expect(screen.getByTestId('cupboard-hive-claim')).toBeTruthy());
    expect(screen.getByTestId('cupboard-claim-rollup').textContent).toContain('1/2 claimed');
    fireEvent.click(screen.getByTestId('cupboard-hive-claim'));
    await waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
    const claimCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/claim'));
    // Only the UNCLAIMED member (id 1) is claimed — id 2 already is.
    expect(claimCalls.map((c) => String(c[0]))).toEqual(['/api/cupboard/listings/1/claim']);
  });
});

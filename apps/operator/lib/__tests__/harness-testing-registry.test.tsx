/**
 * @vitest-environment jsdom
 *
 * Harness Tests tab — P-026 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * Covers the harness registry shape (Built-in generalized + Project
 * acceptance) and that <HarnessTestsView> renders <TestingShell> with those
 * two tiers for a harness slug.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
  ACCEPTANCE_DOMAIN_ID,
} from '@papercusp/operator-core/lib/harness-testing-registry';
import { universalDomains } from '@papercusp/operator-core/lib/testing-domains';
import HarnessTestsView from '../../app/adv/harnesses/HarnessTestsView';

// AcceptancePanel's GET path went through useSyncQuery (data-sync convention,
// AcceptancePanel P-062/P-063 migration off raw fetch) — mock the resolver
// per-test via this mutable slot instead of stubbing global fetch for the GET.
let syncQueryResult: { data: unknown; loading: boolean; error: Error | null } = { data: undefined, loading: true, error: null };
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ ...syncQueryResult, fetching: syncQueryResult.loading, invalidate: vi.fn() }),
}));

import AcceptancePanel from '../../app/adv/harnesses/AcceptancePanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('harnessTestingRegistry', () => {
  it('is the universal domains plus the Acceptance (Project) domain', () => {
    const ids = harnessTestingRegistry.map((d) => d.id);
    for (const g of universalDomains) expect(ids).toContain(g.id);
    expect(ids).toContain(ACCEPTANCE_DOMAIN_ID);
    expect(harnessTestingRegistry.length).toBe(universalDomains.length + 1);

    const acceptance = harnessTestingRegistry.find((d) => d.id === ACCEPTANCE_DOMAIN_ID);
    expect(acceptance?.tier).toBe('project');
    expect(universalDomains.every((d) => d.tier === 'universal')).toBe(true);
  });

  it('maps the two tiers to Universal / This Harness labels', () => {
    expect(HARNESS_TESTING_TIER_LABELS).toEqual({ universal: 'Universal', project: 'This Harness' });
  });
});

describe('<HarnessTestsView>', () => {
  it('renders TestingShell with Universal + This Harness tiers for a harness slug', async () => {
    // Minimal stub so DomainTestPanel's detail fetch resolves; the nav
    // (tier headings + tabs) comes from the registry and renders regardless.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        async json() {
          if (url.includes('/file-status')) return { statuses: {} };
          if (url.includes('/health-strip')) return null;
          return { id: 'routes', label: 'Routes', description: '', tier: 'universal', sections: [], totalFiles: 0 };
        },
      })) as unknown as typeof fetch,
    );

    render(<HarnessTestsView slug="demo" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });

    // Both tiers render in the rail…
    await waitFor(() => screen.getByText('Universal'));
    screen.getByText('This Harness');
    // …and the Acceptance tab is present.
    screen.getByText('Acceptance');
  });
  // (The no-slug empty state now lives in AdvHarnessPanelPage — "Select a
  // harness" — not in HarnessTestsView, which is always given a slug.)
});

describe('<AcceptancePanel> (VAL-* retired — verification-system-improvements-2026-10-10 P-003)', () => {
  // Inline VAL-* assertions are retired: the panel renders a static notice and
  // never reads the removed `testing.assertionsByHarness` query, even when the
  // sync layer would hand it rows.
  it('renders the retirement notice instead of a VAL list, whatever the sync layer holds', () => {
    syncQueryResult = {
      data: [{ val_id: 'VAL-demo-001', plan_slug: 'demo', item_id: 'P-001', verify_text: 'GET /x returns 200', status: 'passed', requires_test: true }],
      loading: false,
      error: null,
    };
    render(<AcceptancePanel slug="demo" />);
    expect(screen.getByTestId('acceptance-retired').textContent).toMatch(/assertions are retired/);
    expect(screen.queryByText('VAL-demo-001')).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

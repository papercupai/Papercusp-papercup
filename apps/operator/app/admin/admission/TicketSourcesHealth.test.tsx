// @vitest-environment jsdom
/**
 * /admin/admission "Ticket sources" (linear-asana-task-sync P-007, D-014.7): one row per connected
 * source from the shared overview, what keeps it from syncing (missing config before the last
 * error), and a deep link to the exact source in Settings → Integrations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const H = vi.hoisted(() => ({
  state: { overview: null as unknown, loadError: null as string | null },
}));

vi.mock('@/app/settings/integrations/ticket-integrations-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/settings/integrations/ticket-integrations-client')>()),
  useTicketIntegrations: () => H.state,
}));

vi.mock('@/app/_components/RouteLink', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import TicketSourcesHealth from './TicketSourcesHealth';

const PROVIDERS = [
  { id: 'linear', displayName: 'Linear' },
  { id: 'asana', displayName: 'Asana' },
];

function source(overrides: Record<string, unknown>) {
  return {
    id: 'src-1',
    provider: 'linear',
    providerAccountId: 'org-1',
    accountLabel: 'Acme',
    status: 'connected',
    lastError: null,
    lastSyncAt: null,
    nextAttemptAt: null,
    failureCount: 0,
    scope: 'personal',
    liveSearch: false,
    config: {},
    missingConfig: [],
    mirrored: 0,
    admitted: 0,
    rules: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  H.state = { overview: null, loadError: null };
});

describe('Ticket sources health', () => {
  it('renders one row per source with what keeps it from syncing and a link to fix it', () => {
    H.state = {
      loadError: null,
      overview: {
        providers: PROVIDERS,
        sources: [
          source({
            id: 'src-1',
            status: 'error',
            missingConfig: ['teamIds', 'harnessSlug'],
            lastError: 'linear_teams_missing',
            failureCount: 3,
          }),
          source({
            id: 'src-2',
            provider: 'asana',
            accountLabel: 'Acme Asana',
            lastError: 'provider_auth: token revoked',
            mirrored: 12,
            admitted: 4,
            rules: [
              { id: 'r-1', enabled: true },
              { id: 'r-2', enabled: false },
            ],
          }),
        ],
      },
    };
    render(<TicketSourcesHealth />);

    const table = screen.getByRole('table');
    expect(within(table).getByText('2 ticket sources')).toBeTruthy();

    const linearRow = within(table).getByText('Linear').closest('tr') as HTMLElement;
    expect(within(linearRow).getByText('error')).toBeTruthy();
    expect(within(linearRow).getByText('never')).toBeTruthy();
    // Missing config is what to fix first, so it wins over the error it causes.
    expect(within(linearRow).getByText('Needs teams and a harness to store tickets in')).toBeTruthy();
    expect(within(linearRow).queryByText('linear_teams_missing')).toBeNull();
    expect(within(linearRow).getByRole('link', { name: 'Configure' }).getAttribute('href')).toBe(
      '/settings/integrations?source=src-1&panel=scope',
    );

    const asanaRow = within(table).getByText('Asana').closest('tr') as HTMLElement;
    expect(within(asanaRow).getByText('Acme Asana')).toBeTruthy();
    expect(within(asanaRow).getByText('12')).toBeTruthy();
    expect(within(asanaRow).getByText('4')).toBeTruthy();
    expect(within(asanaRow).getByText('1 of 2')).toBeTruthy();
    expect(within(asanaRow).getByText('provider_auth: token revoked')).toBeTruthy();
  });

  it('says so when no tracker is connected', () => {
    H.state = { loadError: null, overview: { providers: PROVIDERS, sources: [] } };
    render(<TicketSourcesHealth />);
    expect(screen.getByText('No ticket tracker is connected.')).toBeTruthy();
  });

  it('shows loading, then a load failure, instead of an empty table', () => {
    render(<TicketSourcesHealth />);
    expect(screen.getByRole('status').textContent).toBe('Loading ticket sources…');
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();

    H.state = { overview: null, loadError: 'database unavailable' };
    render(<TicketSourcesHealth />);
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load ticket sources: database unavailable');
  });
});

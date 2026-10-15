// @vitest-environment jsdom
/** Actual Health controls and Nuqs URL adapter; only the health feed is supplied. */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { configureOperatorUi } from '@papercusp/operator-ui/seam';
import { ADV_TAB_SURFACE_KINDS } from '@papercusp/operator-ui/adv-navigation';

const feed = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown> }));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: queryName === 'health.snapshot' ? [feed.snapshot] : [],
    loading: false, error: null, invalidate: vi.fn(),
  }),
}));

import HealthTab from './HealthTab';

afterEach(() => {
  cleanup();
  configureOperatorUi({ advNavigation: undefined });
  window.history.replaceState(null, '', '/');
});

it.each([['harnesses', 'work'], ['plans', 'create'], ['calendar', 'scheduled']])(
  'Portal Health opens %s as %s while retaining workspace, search and expanded panel on remount',
  async (tab, app) => {
    configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
    window.history.replaceState(null, '', '/?app=health&ws=private-health-workspace&q=retained-health-search');
    feed.snapshot = { evaluatedAt: Date.now(), overall: 'warn', panels: {
      plans: { key: 'plans', label: 'Private health panel', status: 'warn',
        summary: 'Private health summary', metrics: [], data: null,
        link: { label: 'Private destination', href: `/adv?tab=${tab}` } },
    } };
    const mount = () => render(<NuqsAdapter><HealthTab /></NuqsAdapter>);
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Private health panel' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('healthPanel')).toBe('plans'));
    expect(screen.getByRole('button', { name: 'Private health panel' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('link', { name: 'Open Private destination' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('app')).toBe(app));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBeNull();
    expect(params.get('ws')).toBe('private-health-workspace');
    expect(params.get('q')).toBe('retained-health-search');
    expect(params.get('healthPanel')).toBe('plans');
    const savedUrl = window.location.href;
    view.unmount();
    mount();
    expect(window.location.href).toBe(savedUrl);
    expect(screen.getByRole('button', { name: 'Private health panel' }).getAttribute('aria-expanded')).toBe('true');
  },
);

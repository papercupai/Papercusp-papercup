/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useSearch } from '@tanstack/react-router';
import { ChatMarkdown } from '@papercusp/operator-ui/papercup-chat';

// Keep the production host configuration, renderer and router real. The root
// barrel's unrelated admin panels and the reference status feed are unnecessary.
vi.mock('@papercusp/operator-ui', async () => {
  const seam = await import('@papercusp/operator-ui/seam');
  return { configureOperatorUi: seam.configureOperatorUi };
});
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [], loading: false, error: null }) }));
import './operator-ui-entry';

afterEach(cleanup);

const reportId = 'rpt_c6a650d3-4b68-4bef-9169-8bf4fe69f998';

it.each([
  [reportId, ''],
  [`/reports?sel=${reportId}&scope=workspace#findings`, 'findings'],
  [`/reports/${reportId}#findings`, 'findings'],
])('opens the selected report inside the app from a plain agent reference: %s', async (reference, hash) => {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <ChatMarkdown content={`Audit complete (${reference}).`} hostTrust="owner" />,
  });
  const reports = createRoute({
    getParentRoute: () => root,
    path: '/reports',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => {
      const search = useSearch({ strict: false });
      return <p>Selected report: {String(search.sel)}</p>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([home, reports]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  const link = await screen.findByRole('link', { name: reference });
  expect(link.getAttribute('target')).toBeNull();
  fireEvent.click(link);
  await screen.findByText(`Selected report: ${reportId}`);
  await waitFor(() => expect(router.state.location.pathname).toBe('/reports'));
  expect(router.state.location.search.sel).toBe(reportId);
  expect(router.state.location.hash).toBe(hash);
  if (reference.includes('scope=')) expect(router.state.location.search.scope).toBe('workspace');
});

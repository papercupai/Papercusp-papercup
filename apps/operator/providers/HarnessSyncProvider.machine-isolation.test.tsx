// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _resetOriginSchedulersForTests, useSyncQuery } from '@papercusp/sync';
import { clearPollingCache } from '../../../libs/generic/sync/src/transports/polling/queryClient';
import { _resetQueryFetchersForTests } from '../../../libs/generic/sync/src/transports/polling/query-fetcher';
import { HarnessSyncProvider } from './HarnessSyncProvider';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { useQueryState } from 'nuqs';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { NuqsAdapter } from '../../operator-vite/src/lib/nuqs-tanstack-router-adapter';

const streams = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock('@papercusp/sse', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  createCrossTabControlStream: (options: Record<string, unknown>) => {
    const stream = { ...options, close: vi.fn(), setUrl: vi.fn(), reconnect: vi.fn(), isOwner: true };
    streams.push(stream);
    return stream;
  },
}));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => false }));
vi.mock('@/app/_components/SetupWizard/tauri-detect', () => ({ isTauri: () => false }));

function select(machine: string) {
  window.history.replaceState(null, '', `/desktops?ws=local-ws&desktopHost=${machine}`);
}

function Identity() {
  const state = useSyncQuery<{ machine: string }>({ queryName: 'instance.identity', staleTime: 60_000 });
  return <output data-testid="instance">{state.data[0]?.machine ?? 'loading'}</output>;
}

function App({ machine, identity = false }: { machine: string; identity?: boolean }) {
  return <NuqsTestingAdapter key={machine} searchParams={`?desktopHost=${machine}`}>
    <HarnessSyncProvider>{identity ? <Identity /> : null}</HarnessSyncProvider>
  </NuqsTestingAdapter>;
}

beforeEach(() => {
  clearPollingCache();
  _resetQueryFetchersForTests();
  _resetOriginSchedulersForTests();
  streams.length = 0;
  vi.stubGlobal('EventSource', class {});
  select('host-a');
});
afterEach(() => {
  cleanup();
  clearPollingCache();
  _resetQueryFetchersForTests();
  _resetOriginSchedulersForTests();
  vi.unstubAllGlobals();
});

it('never paints the old machine cache after the provider remounts for another machine', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    rows: [{ machine: new URL(window.location.href).searchParams.get('desktopHost') }], version: '1',
  })));
  vi.stubGlobal('fetch', fetch);
  const view = render(<App machine="host-a" identity />);
  await waitFor(() => expect(screen.getByTestId('instance').textContent).toBe('host-a'));
  select('host-b');
  view.rerender(<App machine="host-b" identity />);
  expect(screen.getByTestId('instance').textContent).not.toBe('host-a');
  await waitFor(() => expect(screen.getByTestId('instance').textContent).toBe('host-b'));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('scopes stream ownership before opening the selected machine connection', async () => {
  const view = render(<App machine="host-a" />);
  await waitFor(() => expect(streams).toHaveLength(1));
  const first = streams[0]!;
  select('host-b');
  view.rerender(<App machine="host-b" />);
  await waitFor(() => expect(streams).toHaveLength(2));
  expect(first.close).toHaveBeenCalledOnce();
  expect(streams[1]!.channelKey).not.toBe(first.channelKey);
  expect(new URL(String(streams[1]!.url), window.location.href).searchParams.get('desktopHost')).toBe('host-b');
});

it('rebinds cache and closes the old stream on a real router machine change without reloading', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
    rows: [{ machine: new Headers(init?.headers).get('x-papercusp-machine') }], version: '1',
  }))));
  function Switch() {
    const [, setMachine] = useQueryState('desktopHost');
    return <button onClick={() => { void setMachine('host-b'); }}>Choose B</button>;
  }
  const root = createRootRoute({ component: () => <NuqsAdapter><HarnessSyncProvider>
    <Switch /><Outlet />
  </HarnessSyncProvider></NuqsAdapter> });
  const probe = createRoute({ getParentRoute: () => root, path: '/probe', component: Identity });
  const router = createRouter({ routeTree: root.addChildren([probe]),
    history: createMemoryHistory({ initialEntries: ['/probe?desktopHost=host-a'] }) });
  render(<RouterProvider router={router} />);
  await act(async () => { await router.load(); });
  await waitFor(() => expect(screen.getByTestId('instance').textContent).toBe('host-a'));
  const startedAt = performance.timeOrigin;
  const originalStream = streams[0]!;
  fireEvent.click(screen.getByRole('button', { name: 'Choose B' }));
  await waitFor(() => expect(screen.getByTestId('instance').textContent).toBe('host-b'));
  expect(originalStream.close).toHaveBeenCalledOnce();
  expect(router.state.location.search).toMatchObject({ desktopHost: 'host-b' });
  expect(performance.timeOrigin).toBe(startedAt);
});

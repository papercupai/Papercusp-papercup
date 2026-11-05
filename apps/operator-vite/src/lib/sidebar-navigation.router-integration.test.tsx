// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link as RouterLink,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { parseAsBoolean, parseAsString, useQueryStates } from 'nuqs';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it } from 'vitest';
import Link from '@/lib/router-compat/link';
import { useRouter } from '@/lib/router-compat/navigation';
import { NuqsAdapter, sidebarSearchMiddleware } from './nuqs-tanstack-router-adapter';

// The same URL contract as LeftSidebar, OperatorChatSidebar, DevAdminRail and
// PresenceRail. Their component tests cover presentation; this exercises the
// real router + nuqs boundary that a NuqsTestingAdapter-only test cannot cover.
function SidebarControls() {
  const [layout, setLayout] = useQueryStates({
    lsb: parseAsBoolean.withDefault(true),
    chat: parseAsBoolean.withDefault(true),
    lst: parseAsString.withDefault('accounts'),
    opcv: parseAsString.withDefault('chat'),
    devRail: parseAsBoolean.withDefault(false),
    devSec: parseAsString.withDefault('flags'),
    members: parseAsBoolean.withDefault(false),
    pres: parseAsString.withDefault('roster'),
    popup: parseAsString,
  });
  const router = useRouter();
  return (
    <>
      <output data-testid="layout">{JSON.stringify(layout)}</output>
      <button onClick={() => void setLayout({ lsb: false, chat: false })}>Collapse sidebars</button>
      <button onClick={() => void setLayout({
        lsb: true, chat: true, lst: 'accounts', opcv: 'chat',
        devRail: false, devSec: 'flags', members: false, pres: 'roster',
      })}>Reset layout</button>
      <button onClick={() => void setLayout({ popup: null })}>Close popup</button>
      <Link href="/second?filter=new">Compatibility link</Link>
      <RouterLink to="/support">Native link</RouterLink>
      <Link href="/second?lsb=true&chat=true">Expand deep link</Link>
      <button onClick={() => router.push('/second?filter=pushed')}>Push page</button>
      <button onClick={() => router.replace('/support')}>Replace page</button>
    </>
  );
}

async function mountAt(url = '/first') {
  // nuqs has a module-global throttle queue; clear it between independent routers.
  render(<NuqsTestingAdapter>{null}</NuqsTestingAdapter>).unmount();
  const root = createRootRoute({
    search: { middlewares: [sidebarSearchMiddleware] },
    component: () => <NuqsAdapter><SidebarControls /><Outlet /></NuqsAdapter>,
  });
  const children = ['/first', '/second', '/support'].map((path) =>
    createRoute({ getParentRoute: () => root, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: root.addChildren(children),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(<RouterProvider router={router} />);
  await act(async () => { await router.load(); });
  await screen.findByTestId('layout');
  return router;
}

function layout() {
  return JSON.parse(screen.getByTestId('layout').textContent!);
}

afterEach(cleanup);

describe('sidebar layout across page navigation', () => {
  it('keeps both sidebars collapsed through compatibility and native links', async () => {
    const router = await mountAt('/first?lst=pulse&opcv=fleet&filter=old&popup=old');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebars' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ lsb: false, chat: false }));

    fireEvent.click(screen.getByRole('link', { name: 'Compatibility link' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/second'));
    expect(router.state.location.search).toEqual({ lsb: false, chat: false, lst: 'pulse', opcv: 'fleet', filter: 'new' });
    await waitFor(() => expect(layout()).toMatchObject({ lsb: false, chat: false, lst: 'pulse', opcv: 'fleet' }));

    fireEvent.click(screen.getByRole('link', { name: 'Native link' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/support'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: false, chat: false, lst: 'pulse', opcv: 'fleet' }));
    expect(router.state.location.search).not.toHaveProperty('filter');
  });

  it('keeps the layout through programmatic push and replace', async () => {
    const router = await mountAt('/first?lsb=false&chat=false&devRail=true&devSec=run&members=true&pres=activity');
    const expected = { lsb: false, chat: false, devRail: true, devSec: 'run', members: true, pres: 'activity' };
    fireEvent.click(screen.getByRole('button', { name: 'Push page' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/second'));
    await waitFor(() => expect(layout()).toMatchObject(expected));
    fireEvent.click(screen.getByRole('button', { name: 'Replace page' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/support'));
    await waitFor(() => expect(layout()).toMatchObject(expected));
  });

  it('lets an explicit destination override the retained collapsed state', async () => {
    const router = await mountAt('/first?lsb=false&chat=false');
    fireEvent.click(screen.getByRole('link', { name: 'Expand deep link' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/second'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: true, chat: true }));
  });

  it('lets nuqs clear default-valued layout keys without resurrecting their old values', async () => {
    const router = await mountAt('/first?lsb=false&chat=false&lst=pulse&opcv=fleet&devRail=true&devSec=run&members=true&pres=activity');
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(layout()).toMatchObject({
      lsb: true, chat: true, lst: 'accounts', opcv: 'chat',
      devRail: false, devSec: 'flags', members: false, pres: 'roster',
    }));
    expect(router.state.location.search).toEqual({});
    fireEvent.click(screen.getByRole('link', { name: 'Native link' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/support'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: true, chat: true, devRail: false, members: false }));
  });

  it('preserves the layout while nuqs removes an unrelated popup key', async () => {
    const router = await mountAt('/first?lsb=false&chat=false&popup=plan');
    fireEvent.click(screen.getByRole('button', { name: 'Close popup' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('popup'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: false, chat: false }));
  });

  it('keeps independently collapsed sidebars and restores their history entries', async () => {
    const router = await mountAt('/first?lsb=false&chat=true');
    fireEvent.click(screen.getByRole('link', { name: 'Native link' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/support'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: false, chat: true }));
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(router.state.location.pathname).toBe('/first'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: false, chat: true }));
    await act(async () => { router.history.forward(); });
    await waitFor(() => expect(router.state.location.pathname).toBe('/support'));
    await waitFor(() => expect(layout()).toMatchObject({ lsb: false, chat: true }));
  });
});

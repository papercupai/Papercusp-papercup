// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { DaoDirectoryEntry } from './dao-navigation';
import DaoWorkspace from './DaoWorkspace';

let data: DaoDirectoryEntry[] | undefined;
let queryError: unknown = null;
let hostData: unknown[] | undefined = [];
let hostError: unknown = null;
const invalidateHosts = vi.fn();
let initialDao = '';
let initialSection = 'directory';
const invalidate = vi.fn();
const switchWorkspace = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/operator-core/lib/workspaces-tauri', () => ({ switchWorkspace }));
let busListener: ((event: { name: string }) => void) | undefined;
vi.mock('@papercusp/sync', () => ({ useSyncQuery: ({ queryName }: { queryName: string }) => queryName === 'workspaceHosts.control'
  ? { data: hostData, error: hostError, invalidate: invalidateHosts } : { data, error: queryError, invalidate },
  onSyncBusEvent: (listener: typeof busListener) => { busListener = listener; return () => { busListener = undefined; }; } }));
vi.mock('nuqs', async importOriginal => ({
  ...await importOriginal<typeof import('nuqs')>(),
  parseAsString: { withDefault: () => ({}) },
  useQueryState: (key: string) => useState(key === 'dao' ? initialDao : initialSection),
}));
vi.mock('@/app/_components/RouteLink', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
const community: DaoDirectoryEntry = { potId: 'builders', title: 'Builders DAO', description: 'Build public infrastructure', owner: 'Founder', visibility: 'public', memberLinks: ['papercusp://harness?topic=project'], memberTopics: ['project'], memberCount: 1 };
const standalone: DaoDirectoryEntry = { potId: 'workspace:personal', workspaceId: 'personal', title: 'Personal work', description: '', owner: 'Local', visibility: 'invite', source: 'local', memberLinks: [], memberTopics: [], memberCount: 0 };

beforeEach(() => {
  data = [community]; initialDao = ''; initialSection = 'directory'; queryError = null; invalidate.mockReset();
  hostData = []; hostError = null; invalidateHosts.mockReset();
  switchWorkspace.mockReset(); switchWorkspace.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => ({ workspace: { directoryId: new URL(url, 'http://local').searchParams.get('potId'), localHomeSlug: null, status: 'not-joined' } }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DAO Workbench journeys', () => {
  it('opens a discovered DAO and keeps all nineteen interface areas reachable', async () => {
    render(<DaoWorkspace />);
    expect(screen.getByRole('navigation', { name: 'DAO sections' }).querySelectorAll('button')).toHaveLength(19);
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace →' }));
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    expect(screen.getByRole('combobox', { name: 'Choose a DAO' }).textContent).toBe('Builders DAO');
    expect(screen.getByText('Build public infrastructure')).toBeTruthy();
  });
  it('searches published organization information', () => {
    render(<DaoWorkspace />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no matches' } });
    expect(screen.getByRole('heading', { name: 'No matching workspaces' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'infrastructure' } });
    expect(screen.getByRole('heading', { name: 'Builders DAO' })).toBeTruthy();
  });
  it('never treats a load failure as an empty successful directory', () => {
    data = undefined; queryError = new Error('offline');
    render(<DaoWorkspace />);
    expect(screen.getByRole('alert').textContent).toContain('Unable to load');
    expect(screen.queryByText('No workspaces discovered yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('does not claim a saved DAO disappeared before the directory loads', () => {
    data = undefined; initialDao = community.potId; initialSection = 'members';
    render(<DaoWorkspace />);
    expect(screen.getByText('Loading discovered workspaces…')).toBeTruthy();
    expect(screen.queryByText('This organization is not listed in this directory')).toBeNull();
  });
  it('does not present a cached empty directory as a fresh absence after an error', () => {
    data = []; queryError = new Error('offline');
    render(<DaoWorkspace />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No workspaces discovered yet')).toBeNull();
  });
  it('requires explicit membership consent before invoking the composed join', async () => {
    initialDao = community.potId; initialSection = 'join';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, potSlug: 'builders', members: [{ ok: true }] }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<DaoWorkspace />);
    expect((screen.getByRole('button', { name: 'Join organization' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(call => call[0] === '/api/discovery/join-pot')).toHaveLength(1));
    const joinCall = fetchMock.mock.calls.find(call => call[0] === '/api/discovery/join-pot')!;
    expect(JSON.parse(joinCall[1].body)).toEqual({ potId: 'builders', title: 'Builders DAO', memberLinks: community.memberLinks });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Joined builders'));
  });
  it('keeps publisher entries without links ineligible for joining', async () => {
    data = [{ ...community, memberLinks: [] }]; initialDao = community.potId; initialSection = 'join';
    render(<DaoWorkspace />);
    await userEvent.setup().click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: 'Join organization' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('surfaces a failed join and allows a deliberate retry', async () => {
    initialDao = community.potId; initialSection = 'join';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Admission rejected' }) }));
    render(<DaoWorkspace />); await userEvent.setup().click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Join organization' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Admission rejected'));
    expect((screen.getByRole('button', { name: 'Join organization' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('discovers and opens a standalone workspace without treating it as a DAO', async () => {
    data = [community, standalone];
    render(<DaoWorkspace />);
    expect(screen.getByRole('heading', { name: 'Discover workspaces', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Personal work' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Choose a DAO' }));
    expect(screen.queryByRole('option', { name: 'Personal work' })).toBeNull();
    await user.keyboard('{Escape}');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Personal' } });
    expect(screen.queryByRole('heading', { name: 'Builders DAO' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace →' }));
    await waitFor(() => expect(switchWorkspace).toHaveBeenCalledWith('personal'));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Join organization' })).toBeNull();
  });

  it('surfaces a failed standalone workspace switch so it can be retried', async () => {
    data = [standalone]; switchWorkspace.mockRejectedValueOnce(new Error('Workspace is unavailable'));
    render(<DaoWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace →' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Workspace is unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace →' }));
    await waitFor(() => expect(switchWorkspace).toHaveBeenCalledTimes(2));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists cloud workspaces without DAO membership and links to their existing workspace controls', async () => {
    hostData = [{ kind: 'connection', id: 'connection', label: 'Cloud connection' },
      { kind: 'workspace', id: 'studio & research', name: 'Research studio', target: 'gcp', region: 'us-central1' }];
    render(<DaoWorkspace />);
    expect(screen.getByRole('heading', { name: 'Research studio' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Cloud connection' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Choose a DAO' }));
    expect(screen.queryByRole('option', { name: 'Research studio' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('link', { name: 'Open workspace →' }).getAttribute('href')).toBe('/cloud-workspaces?host=studio%20%26%20research');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'us-central1' } });
    expect(screen.getByRole('heading', { name: 'Research studio' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Builders DAO' })).toBeNull();
  });

  it('does not report an empty directory while cloud workspaces are loading or unavailable', () => {
    data = []; hostData = undefined;
    const view = render(<DaoWorkspace />);
    expect(screen.getByRole('status').textContent).toContain('Loading discovered workspaces');
    expect(screen.queryByText('No workspaces discovered yet')).toBeNull();
    hostError = new Error('offline'); view.rerender(<DaoWorkspace />);
    expect(screen.getByRole('alert').textContent).toContain('Unable to load cloud workspaces');
    expect(screen.queryByText('No workspaces discovered yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(invalidateHosts).toHaveBeenCalledOnce();
  });

  it('refreshes both workspace sources', () => {
    render(<DaoWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidateHosts).toHaveBeenCalledOnce();
  });

  it('shows a verified membership roster through the bound organization reader', async () => {
    initialDao = community.potId; initialSection = 'members';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workspace: { directoryId: community.potId, localHomeSlug: 'renamed-home', status: 'connected', members: { status: 'ready', value: [{ id: 1, username: 'person', displayName: 'Contributor', bindingStatus: 'bound', devices: 2 }] } } }) }));
    render(<DaoWorkspace />);
    expect(await screen.findByRole('row', { name: /Contributor.*person.*bound.*2/ })).toBeTruthy();
    expect(screen.getByRole('table').textContent).toContain('bound');
    expect(screen.getByRole('link', { name: 'Open contributor work' }).getAttribute('href')).toContain('slug=renamed-home');
  });

  it('refuses a response for a different DAO instead of leaking its records', async () => {
    initialDao = community.potId; initialSection = 'members';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workspace: { directoryId: 'other', localHomeSlug: 'other-home', status: 'connected' } }) }));
    render(<DaoWorkspace />);
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to read this organization');
    expect(screen.queryByRole('heading', { name: 'People' })).toBeNull();
  });
  it('refreshes bound records on maintained push events without leaving the DAO', async () => {
    initialDao = community.potId; initialSection = 'members';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workspace: { directoryId: community.potId,
      localHomeSlug: 'renamed-home', status: 'connected', members: { status: 'ready', value: [] } } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<DaoWorkspace />);
    await screen.findByText('No current members.');
    act(() => { busListener?.({ name: 'plans.list' }); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('combobox', { name: 'Choose a DAO' }).textContent).toBe('Builders DAO');
    expect(screen.queryByText('Loading organization records…')).toBeNull();
  });
});

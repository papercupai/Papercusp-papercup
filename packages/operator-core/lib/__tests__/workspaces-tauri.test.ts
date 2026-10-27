/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigateClient = vi.fn();
const fetchMock = vi.fn();

vi.mock('../client-navigation', () => ({
  navigateClient: (...args: unknown[]) => navigateClient(...args),
}));

const commands = {
  workspacesList: vi.fn(),
  workspacesCreate: vi.fn(),
  workspacesRename: vi.fn(),
  workspacesDelete: vi.fn(),
  workspacesSwitch: vi.fn(),
  workspacesOpenWindow: vi.fn(),
};

vi.mock('../tauri-bindings', () => ({
  commands,
}));

afterEach(() => {
  navigateClient.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  commands.workspacesList.mockReset();
  commands.workspacesCreate.mockReset();
  commands.workspacesRename.mockReset();
  commands.workspacesDelete.mockReset();
  commands.workspacesSwitch.mockReset();
  commands.workspacesOpenWindow.mockReset();
});

describe('workspaces-tauri', () => {
  it('discovers the selected machine before its URL update has flushed', async () => {
    window.history.replaceState(null, '', '/?desktopHost=machine-a&ws=workspace-a');
    const registry = { current: 'workspace-b', workspaces: [{ id: 'workspace-b', name: 'B' }] };
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true, json: async () => registry }));
    const { installWorkspaceHeaderFetch } = await import('../transport-adapters/workspace-header-fetch');
    installWorkspaceHeaderFetch();
    const { listWorkspaces } = await import('../workspaces-tauri');

    expect(await listWorkspaces('machine-b')).toEqual(registry);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-papercusp-machine')).toBe('machine-b');
    expect(headers.get('x-papercusp-workspace')).toBe('');
    expect(new URL(window.location.href).searchParams.get('desktopHost')).toBe('machine-a');
  });

  it('avoids the local native registry when a remote selection precedes the URL flush', async () => {
    window.history.replaceState(null, '', '/?desktopHost=local&ws=local');
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {},
      location: { href: window.location.href }, sessionStorage: window.sessionStorage });
    commands.workspacesList.mockResolvedValue({ current: 'local', workspaces: [] });
    const remote = { current: 'remote', workspaces: [{ id: 'remote', name: 'Remote' }] };
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true, json: async () => remote }));
    const { listWorkspaces } = await import('../workspaces-tauri');

    expect(await listWorkspaces('machine-b')).toEqual(remote);
    expect(commands.workspacesList).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('x-papercusp-machine')).toBe('machine-b');
  });

  it('discovers a machine registry without sending the previous workspace through the installed fetch adapter', async () => {
    window.history.replaceState(null, '', '/?desktopHost=local&ws=previous-machine-workspace');
    const registry = { current: 'new-workspace', workspaces: [{ id: 'new-workspace', name: 'New' }] };
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true, json: async () => registry }));
    const { installWorkspaceHeaderFetch } = await import('../transport-adapters/workspace-header-fetch');
    installWorkspaceHeaderFetch();
    const { listWorkspaces } = await import('../workspaces-tauri');

    expect(await listWorkspaces()).toEqual(registry);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('x-papercusp-machine')).toBe('local');
    expect(headers.get('x-papercusp-workspace')).toBe('');
    expect(commands.workspacesSwitch).not.toHaveBeenCalled();
  });

  it('uses the selected remote operator for workspace commands even inside a Tauri window', async () => {
    window.history.replaceState(null, '', '/desktops?desktopHost=machine-b&ws=own');
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {},
      location: { href: window.location.href }, sessionStorage: window.sessionStorage });
    commands.workspacesList.mockResolvedValue({ current: 'local', workspaces: [{ id: 'local', name: 'Local' }] });
    const remote = { current: 'remote', workspaces: [{ id: 'remote', name: 'Remote' }] };
    fetchMock.mockResolvedValue({ ok: true, json: async () => remote });
    vi.stubGlobal('fetch', fetchMock);
    const { listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, switchWorkspace } = await import('../workspaces-tauri');

    expect(await listWorkspaces()).toEqual(remote);
    await createWorkspace('Remote');
    await renameWorkspace('remote', 'Renamed');
    await deleteWorkspace('unused');
    await switchWorkspace('remote');

    for (const command of Object.values(commands)) expect(command).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('x-papercusp-machine')).toBe('machine-b');
    }
    expect(navigateClient).toHaveBeenCalledWith('/harness?ws=remote&desktopHost=machine-b', { hard: true });
  });

  it('opens a second window with its own selected machine instead of a local native workspace', async () => {
    window.history.replaceState(null, '', '/desktops?desktopHost=machine-b&ws=own');
    const windowOpen = vi.fn();
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {}, open: windowOpen,
      location: { href: window.location.href }, sessionStorage: window.sessionStorage });
    const { openWorkspaceWindow } = await import('../workspaces-tauri');
    await openWorkspaceWindow('remote');
    expect(windowOpen).toHaveBeenCalledWith('/harness?ws=remote&desktopHost=machine-b', '_blank', 'noopener');
    expect(commands.workspacesOpenWindow).not.toHaveBeenCalled();
  });

  it('builds the default workspace reset path', async () => {
    const { resolveWorkspaceSwitchTarget } = await import('../workspaces-tauri');
    expect(resolveWorkspaceSwitchTarget('alpha')).toBe('/harness?ws=alpha');
    expect(resolveWorkspaceSwitchTarget('alpha', { resetTo: '/support?ws=alpha' })).toBe('/support?ws=alpha');
    expect(resolveWorkspaceSwitchTarget('alpha beta/γ')).toBe('/harness?ws=alpha%20beta%2F%CE%B3');
  });

  it('hard-navigates (full reload) on the web/static path after a successful workspace switch', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
    const { switchWorkspace } = await import('../workspaces-tauri');

    await switchWorkspace('beta', { resetTo: '/harness?ws=beta&panel=overview' });

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/switch', expect.objectContaining({ method: 'POST' }));
    // hard:true forces a document reload so host-spa re-injects __PAPERCUSP_WS__.
    expect(navigateClient).toHaveBeenCalledWith('/harness?ws=beta&panel=overview', { hard: true });
  });

  it('uses the default reset target on the web/static path when resetTo is omitted', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
    const { switchWorkspace } = await import('../workspaces-tauri');

    await switchWorkspace('delta');

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/switch', expect.objectContaining({ method: 'POST' }));
    expect(navigateClient).toHaveBeenCalledWith('/harness?ws=delta', { hard: true });
  });
  it('does not soft-navigate when the web/static workspace switch request fails', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'switch-fail' }) }));
    const { switchWorkspace } = await import('../workspaces-tauri');

    await expect(switchWorkspace('delta')).rejects.toThrow('switch-fail');
    expect(navigateClient).not.toHaveBeenCalled();
  });
  it('persists registry.current then hard-navigates on the desktop path (Phase E P-050 — no restart)', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesSwitch.mockResolvedValue({ status: 'ok' });
    const { switchWorkspace } = await import('../workspaces-tauri');

    await switchWorkspace('gamma', { resetTo: '/harness?ws=gamma' });

    // Desktop persists the registry default via the Tauri command (no
    // app.restart() anymore) and then re-scopes THIS window by navigating.
    expect(commands.workspacesSwitch).toHaveBeenCalledWith('gamma');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigateClient).toHaveBeenCalledWith('/harness?ws=gamma', { hard: true });
  });

  it('surfaces desktop command errors and does not navigate', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesSwitch.mockResolvedValue({ status: 'error', error: 'boom' });
    const { switchWorkspace } = await import('../workspaces-tauri');

    await expect(switchWorkspace('gamma')).rejects.toThrow('boom');
    expect(navigateClient).not.toHaveBeenCalled();
  });

  it('opens an additional window via the desktop command (Phase E P-053)', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesOpenWindow.mockResolvedValue({ status: 'ok' });
    const { openWorkspaceWindow } = await import('../workspaces-tauri');

    await expect(openWorkspaceWindow('beta')).resolves.toBeUndefined();
    expect(commands.workspacesOpenWindow).toHaveBeenCalledWith('beta');
  });

  it('surfaces desktop open-window errors', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesOpenWindow.mockResolvedValue({ status: 'error', error: 'no-window' });
    const { openWorkspaceWindow } = await import('../workspaces-tauri');

    await expect(openWorkspaceWindow('beta')).rejects.toThrow('no-window');
  });

  it('opens a new tab on the web/static path (no multi-window shell)', async () => {
    const windowOpen = vi.fn();
    vi.stubGlobal('window', { ...window, open: windowOpen });
    const { openWorkspaceWindow } = await import('../workspaces-tauri');

    await openWorkspaceWindow('beta');
    expect(windowOpen).toHaveBeenCalledWith('/harness?ws=beta', '_blank', 'noopener');
    expect(commands.workspacesOpenWindow).not.toHaveBeenCalled();
  });
  it('lists workspaces through the desktop command path when Tauri is present', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesList.mockResolvedValue({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    const { listWorkspaces } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).resolves.toEqual({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates, renames, and deletes workspaces through the desktop command path when Tauri is present', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesCreate.mockResolvedValue({ status: 'ok', data: { id: 'beta', name: 'Beta' } });
    commands.workspacesRename.mockResolvedValue({ status: 'ok' });
    commands.workspacesDelete.mockResolvedValue({ status: 'ok' });
    const { createWorkspace, renameWorkspace, deleteWorkspace } = await import('../workspaces-tauri');

    await expect(createWorkspace('Beta')).resolves.toEqual({ id: 'beta', name: 'Beta' });
    await expect(renameWorkspace('beta', 'Beta 2')).resolves.toBeUndefined();
    await expect(deleteWorkspace('beta')).resolves.toBeUndefined();

    expect(commands.workspacesCreate).toHaveBeenCalledWith('Beta');
    expect(commands.workspacesRename).toHaveBeenCalledWith('beta', 'Beta 2');
    expect(commands.workspacesDelete).toHaveBeenCalledWith('beta');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces desktop command errors for list/create/rename/delete', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesList.mockRejectedValue(new Error('list-fail'));
    commands.workspacesCreate.mockResolvedValue({ status: 'error', error: 'create-fail' });
    commands.workspacesRename.mockResolvedValue({ status: 'error', error: 'rename-fail' });
    commands.workspacesDelete.mockResolvedValue({ status: 'error', error: 'delete-fail' });
    const {
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
    } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).rejects.toThrow('list-fail');
    await expect(createWorkspace('Beta')).rejects.toThrow('create-fail');
    await expect(renameWorkspace('beta', 'Beta 2')).rejects.toThrow('rename-fail');
    await expect(deleteWorkspace('beta')).rejects.toThrow('delete-fail');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigateClient).not.toHaveBeenCalled();
  });

  it('uses fetch on the web/static path for list/create/rename/delete', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'beta', name: 'Beta' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const {
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
    } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).resolves.toEqual({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    await expect(createWorkspace('Beta')).resolves.toEqual({ id: 'beta', name: 'Beta' });
    await expect(renameWorkspace('beta', 'Beta 2')).resolves.toBeUndefined();
    await expect(deleteWorkspace('beta')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({
      cache: 'no-store',
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/beta', expect.objectContaining({
      method: 'PATCH',
      cache: 'no-store',
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/beta', expect.objectContaining({
      method: 'DELETE',
      cache: 'no-store',
    }));
    expect(navigateClient).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP path when the desktop command is ACL-denied (WI-2143 — remote-origin, e.g. prod/staging/local, not the dev devUrl)', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesList.mockRejectedValue(new Error('workspaces_list not allowed. Command not found'));
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { listWorkspaces } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).resolves.toEqual({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({ cache: 'no-store' }));
  });

  it('falls back to the HTTP path on ACL-denied desktop errors for create/rename/delete too', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesCreate.mockRejectedValue(new Error('workspaces_create not allowed. Command not found'));
    commands.workspacesRename.mockRejectedValue(new Error('workspaces_rename not allowed. Plugin not found'));
    commands.workspacesDelete.mockRejectedValue(new Error('workspaces_delete not allowed. Command not found'));
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'beta', name: 'Beta' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { createWorkspace, renameWorkspace, deleteWorkspace } = await import('../workspaces-tauri');

    await expect(createWorkspace('Beta')).resolves.toEqual({ id: 'beta', name: 'Beta' });
    await expect(renameWorkspace('beta', 'Beta 2')).resolves.toBeUndefined();
    await expect(deleteWorkspace('beta')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back to the HTTP switch path (and still navigates) when the desktop switch command is ACL-denied', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesSwitch.mockRejectedValue(new Error('workspaces_switch not allowed. Command not found'));
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { switchWorkspace } = await import('../workspaces-tauri');

    await switchWorkspace('gamma', { resetTo: '/harness?ws=gamma' });

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/switch', expect.objectContaining({ method: 'POST' }));
    expect(navigateClient).toHaveBeenCalledWith('/harness?ws=gamma', { hard: true });
  });

  it('surfaces web/static path fetch failures', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    const {
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
    } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).rejects.toThrow('boom');
    await expect(createWorkspace('Beta')).rejects.toThrow('boom');
    await expect(renameWorkspace('beta', 'Beta 2')).rejects.toThrow('boom');
    await expect(deleteWorkspace('beta')).rejects.toThrow('boom');
  });
});

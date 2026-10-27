// @vitest-environment jsdom
//
// WorkspaceSwitcher — the navbar workspace dropdown. The component owns real
// conditional render: returns null until the registry loads / when empty,
// labels the trigger with the active workspace, marks the active row, and
// disables the delete button for the active + default workspaces. A render-smoke
// drives a mocked workspaces-tauri registry to exercise those branches. The
// portaled menu is opened via the ?wsSwitch nuqs param (real testing adapter).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { listWorkspaces } from '@papercusp/operator-core/lib/workspaces-tauri';

const { reg, wsApi, dialogs, toastSpies } = vi.hoisted(() => ({
  reg: {
    current: 'default',
    value: {
      current: 'ws-a',
      workspaces: [
        { id: 'ws-a', name: 'Alpha' },
        { id: 'ws-b', name: 'Bravo' },
      ],
    } as { current: string; workspaces: { id: string; name: string }[] } | null,
  },
  wsApi: {
    // create resolves to the new Workspace (id used to auto-switch into it).
    create: vi.fn(async (name: string) => ({ id: name.toLowerCase(), name })),
    del: vi.fn(async () => {}),
    openWindow: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    switch: vi.fn(async () => {}),
  },
  // Controllable dialog answers: confirm boolean, prompt string|null.
  dialogs: { confirmAnswer: false, promptAnswer: null as string | null },
  toastSpies: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@papercusp/operator-core/lib/workspaces-tauri', () => ({
  listWorkspaces: vi.fn(async () => reg.value),
  createWorkspace: (name: string) => wsApi.create(name as never),
  deleteWorkspace: (id: string) => wsApi.del(id as never),
  openWorkspaceWindow: (id: string) => wsApi.openWindow(id as never),
  renameWorkspace: (id: string, name: string) => wsApi.rename(id as never, name as never),
  switchWorkspace: (id: string, opts?: unknown) => wsApi.switch(id as never, opts as never),
}));

vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  getBrowserWorkspaceId: () => window.__PAPERCUSP_WS__ ?? 'ws-a',
  getBrowserMachineId: () => 'local',
  resolveActiveWorkspaceId: (
    r: { current: string; workspaces: { id: string }[] },
    windowWsId: string,
  ) => {
    const known = (id: string) => r.workspaces.some((w) => w.id === id);
    if (windowWsId && known(windowWsId)) return windowWsId;
    if (r.current && known(r.current)) return r.current;
    return r.workspaces[0]?.id ?? windowWsId;
  },
}));

vi.mock('sonner', () => ({ toast: toastSpies }));
vi.mock('@bprogress/react', () => ({ useProgress: () => ({ start: vi.fn(), stop: vi.fn() }) }));
vi.mock('../harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => dialogs.confirmAnswer, element: null }),
}));
vi.mock('../harness/usePromptDialog', () => ({
  usePromptDialog: () => ({ prompt: async () => dialogs.promptAnswer, element: null }),
}));
vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import WorkspaceSwitcher from './WorkspaceSwitcher';

// Open the menu by clicking the trigger AFTER the registry loads: the menu's
// portal is gated on a menuPos that the layout-effect computes from the button
// rect, and that effect only (re)runs when `open` toggles — so we let the
// registry resolve, then click to open.
async function renderAndOpen() {
  const utils = render(<WorkspaceSwitcher />, {
    wrapper: withNuqsTestingAdapter({ searchParams: '' }),
  });
  const trigger = await screen.findByRole('button', { name: /switch or manage workspaces/i });
  fireEvent.click(trigger);
  return utils;
}

beforeEach(() => {
  delete window.__PAPERCUSP_WS__;
  reg.value = {
    current: 'ws-a',
    workspaces: [
      { id: 'ws-a', name: 'Alpha' },
      { id: 'ws-b', name: 'Bravo' },
    ],
  };
  dialogs.confirmAnswer = false;
  dialogs.promptAnswer = null;
  wsApi.create.mockClear();
  wsApi.del.mockClear();
  wsApi.openWindow.mockClear();
  wsApi.rename.mockClear();
  wsApi.switch.mockClear();
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
});
afterEach(() => { cleanup(); delete window.__PAPERCUSP_WS__; });

describe('<WorkspaceSwitcher />', () => {
  it('binds requests to the authorized workspace when the previous machine workspace is absent', async () => {
    window.__PAPERCUSP_WS__ = 'ws-a';
    reg.value = { current: 'ws-b', workspaces: [{ id: 'ws-b', name: 'Bravo' }] };
    const update = vi.fn();
    render(<WorkspaceSwitcher />, { wrapper: withNuqsTestingAdapter({
      searchParams: '?ws=ws-a&desktopHost=machine-b', onUrlUpdate: update,
    }) });
    await screen.findByRole('button', { name: /switch or manage workspaces/i });
    await waitFor(() => expect(window.__PAPERCUSP_WS__).toBe('ws-b'));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls.at(-1)![0].searchParams.get('ws')).toBe('ws-b');
  });

  it('keeps the current workspace identity when machine discovery is refused', async () => {
    window.__PAPERCUSP_WS__ = 'ws-a';
    vi.mocked(listWorkspaces).mockRejectedValueOnce(new Error('machine offline'));
    render(<WorkspaceSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '?desktopHost=machine-b' }) });
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith('workspaces: machine offline'));
    expect(window.__PAPERCUSP_WS__).toBe('ws-a');
  });

  it('renders nothing while the registry is still loading', () => {
    const { container } = render(<WorkspaceSwitcher />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    // Before the async listWorkspaces() resolves, reg is null → null render.
    expect(container.querySelector('.pc-workspace-switcher')).toBeNull();
  });

  it('renders nothing when the registry has no workspaces', async () => {
    reg.value = { current: '', workspaces: [] };
    const { container } = render(<WorkspaceSwitcher />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    // Give the effect a tick; still nothing rendered.
    await Promise.resolve();
    expect(container.querySelector('.pc-workspace-switcher')).toBeNull();
  });

  it('labels the trigger with the active workspace once loaded', async () => {
    render(<WorkspaceSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    const trigger = await screen.findByRole('button', { name: /switch or manage workspaces/i });
    expect(trigger.textContent).toContain('Alpha');
  });

  it('lists each workspace and marks the active one in the open menu', async () => {
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Alpha')).toBeTruthy();
    expect(within(menu).getByText('Bravo')).toBeTruthy();
    // The active workspace row carries the "active" marker.
    expect(within(menu).getByText('active')).toBeTruthy();
  });

  it('disables the delete button for the active workspace but enables it for others', async () => {
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getByText('Alpha')).toBeTruthy());
    const deleteButtons = [
      within(menu).getByRole('button', { name: 'Delete Alpha' }),
      within(menu).getByRole('button', { name: 'Delete Bravo' }),
    ];
    // Two rows → two delete buttons; ws-a (active) is disabled, ws-b is not.
    expect(deleteButtons).toHaveLength(2);
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('switching to a different workspace (confirm accepted) calls switchWorkspace with the ?ws reset target', async () => {
    dialogs.confirmAnswer = true;
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    // Click the non-active row (Bravo).
    fireEvent.click(within(menu).getByText('Bravo'));
    await waitFor(() => expect(wsApi.switch).toHaveBeenCalledTimes(1));
    expect(wsApi.switch).toHaveBeenCalledWith('ws-b', { resetTo: '/harness?ws=ws-b' });
  });

  it('switching does nothing when the confirm is declined (no switchWorkspace)', async () => {
    dialogs.confirmAnswer = false;
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText('Bravo'));
    await waitFor(() => expect(within(menu).getByText('Bravo')).toBeTruthy());
    expect(wsApi.switch).not.toHaveBeenCalled();
  });

  it('clicking the active workspace row just closes the menu (no confirm, no switch)', async () => {
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    // The active row's button carries the "active" marker; click it.
    fireEvent.click(within(menu).getByText('Alpha'));
    expect(wsApi.switch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('the open-in-new-window action calls openWorkspaceWindow with that id', async () => {
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByLabelText('Open Bravo in a new window'));
    await waitFor(() => expect(wsApi.openWindow).toHaveBeenCalledWith('ws-b'));
  });

  // NOTE on rename coverage: clicking the inline "Rename" (✎) button swaps the
  // row's button for an <input> synchronously *inside* the click dispatch. With
  // the menu portaled to <body>, jsdom re-targets the still-propagating native
  // click onto the trigger (which then toggles the menu shut) — a jsdom/portal
  // event-replay artifact that does not occur in a real browser. So the rename
  // input flow is left to e2e; the rename helpers themselves stay non-portal.

  it('deleting a non-active workspace (confirm accepted) calls deleteWorkspace and toasts success', async () => {
    dialogs.confirmAnswer = true;
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    // ws-b (Bravo) is deletable (not active, not the default reg.current=ws-a).
    fireEvent.click(within(menu).getByRole('button', { name: 'Delete Bravo' }));
    await waitFor(() => expect(wsApi.del).toHaveBeenCalledWith('ws-b'));
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalledWith('deleted "Bravo"'));
  });

  it('creating a workspace auto-switches this window into the new workspace', async () => {
    dialogs.promptAnswer = 'Gamma';
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText(/new workspace/i));
    await waitFor(() => expect(wsApi.create).toHaveBeenCalledWith('Gamma'));
    // After create succeeds the component switches into it (no confirm) — a hard
    // nav to ?ws=<new id> — rather than leaving the user on the old workspace.
    await waitFor(() =>
      expect(wsApi.switch).toHaveBeenCalledWith('gamma', { resetTo: '/harness?ws=gamma' }),
    );
  });

  it('a failed create does not switch and surfaces the error', async () => {
    dialogs.promptAnswer = 'Gamma';
    wsApi.create.mockRejectedValueOnce(new Error('boom'));
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText(/new workspace/i));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith('create failed: boom'));
    expect(wsApi.switch).not.toHaveBeenCalled();
  });

  it('a cancelled create prompt (null) does not call createWorkspace', async () => {
    dialogs.promptAnswer = null;
    await renderAndOpen();
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText(/new workspace/i));
    await waitFor(() => expect(within(menu).getByText('Alpha')).toBeTruthy());
    expect(wsApi.create).not.toHaveBeenCalled();
  });
});

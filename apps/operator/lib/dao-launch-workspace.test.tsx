/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from 'nuqs/adapters/testing';
import { defaultDaoLaunchSections, projectDaoLaunch, type DaoLaunchProjection, type DaoLaunchRecord } from '@papercusp/operator-core/lib/dao-launch';

const sync = vi.hoisted(() => ({ data: [] as DaoLaunchProjection[], loading: false, error: null as Error | null, invalidate: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => sync }));
import { DaoLaunchWorkspace } from '../app/dao/DaoLaunchWorkspace';

function workspace(searchParams = '', onUrlUpdate?: OnUrlUpdateFunction) {
  return <NuqsTestingAdapter searchParams={searchParams} hasMemory onUrlUpdate={onUrlUpdate}><DaoLaunchWorkspace /></NuqsTestingAdapter>;
}
const renderWorkspace = (searchParams = '', onUrlUpdate?: OnUrlUpdateFunction) => render(workspace(searchParams, onUrlUpdate));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function selectOption(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

function draft(): DaoLaunchProjection {
  const sections = defaultDaoLaunchSections('Founder'); sections.purpose = 'Shared software';
  const record: DaoLaunchRecord = { id: 'org-1', name: 'Moss Collective', creatorId: 'user-1', revision: 2, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', reviewedRevision: null, sections };
  return projectDaoLaunch(record);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { sync.data = []; sync.loading = false; sync.error = null; sync.invalidate.mockReset(); });

describe('DAO launch checklist workspace', () => {
  it('shows a useful empty state and creates a persistent organization through the mutation API', async () => {
    const saved = draft(); const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organization: saved }) }); vi.stubGlobal('fetch', fetchMock);
    renderWorkspace();
    expect(screen.getByText('Your DAO starts here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create an organization' }));
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Moss Collective' } });
    fireEvent.change(screen.getByLabelText('Shared purpose'), { target: { value: 'Shared software' } });
    fireEvent.click(screen.getByRole('button', { name: /Create organization draft/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options.body)).toEqual({ name: 'Moss Collective', purpose: 'Shared software' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'From idea to operating DAO.' })).toBeTruthy());
    expect(sync.invalidate).toHaveBeenCalled();
  });
  it('uses real prepared counts, keeps the balance unknown and blocks premature final review', () => {
    sync.data = [draft()]; renderWorkspace();
    expect(screen.getByText(/1 of 5 steps prepared/)).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Open setup/ }).at(-1)!);
    const complete = screen.getByRole('button', { name: /Complete launch preparation/ }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    expect(screen.getByText('Preparation still needed')).toBeTruthy();
  });
  it('saves governance with the original revision and displays stale-write errors without losing the draft', async () => {
    sync.data = [draft()];
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: 'Someone changed this draft. Reload the latest version before saving.' }) }); vi.stubGlobal('fetch', fetchMock);
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /Open governance setup/ }));
    fireEvent.change(screen.getByLabelText('Quorum (%)'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/desktop/dao-launch/org-1');
    expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 2, sections: { governance: { quorumBps: 7500 } } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Someone changed this draft'));
    expect((screen.getByLabelText('Quorum (%)') as HTMLInputElement).value).toBe('75');
  });
  it('keeps invalid funding edits renderable and surfaces a validation error rather than sending them', async () => {
    sync.data = [draft()]; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Money flow' }));
    fireEvent.click(screen.getByRole('button', { name: /Edit funding/ }));
    fireEvent.change(screen.getByLabelText('DAO revenue share (%)'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('lets users discard an edit and reopen the saved configuration', () => {
    sync.data = [draft()]; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /Open governance setup/ }));
    expect(screen.getAllByRole('heading', { name: 'Governance rules' }).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Quorum (%)'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open governance setup/ }));
    expect((screen.getByLabelText('Quorum (%)') as HTMLInputElement).value).toBe('50');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('provides retry instead of presenting a failed read as an empty workspace', () => {
    sync.error = new Error('Connection unavailable'); renderWorkspace();
    expect(screen.getByRole('alert').textContent).toContain('Connection unavailable');
    expect(screen.queryByText('Your DAO starts here.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(sync.invalidate).toHaveBeenCalled();
  });

  it('shows loading until the organization read resolves instead of showing an empty workspace', () => {
    sync.loading = true;
    const view = renderWorkspace();
    expect(screen.getByRole('status').textContent).toContain('Loading your organizations');
    expect(screen.queryByText('Your DAO starts here.')).toBeNull();
    sync.loading = false; sync.data = [draft()];
    view.rerender(workspace());
    expect(screen.queryByText('Loading your organizations…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'From idea to operating DAO.' })).toBeTruthy();
  });

  it('disables duplicate creation while the mutation is pending and clears it only on success', async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetchMock);
    renderWorkspace('?daoNew=true');
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Moss Collective' } });
    fireEvent.change(screen.getByLabelText('Shared purpose'), { target: { value: 'Shared software' } });
    fireEvent.click(screen.getByRole('button', { name: /Create organization draft/ }));
    const button = await screen.findByRole('button', { name: /Creating…/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.setup().click(button);
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ ok: true, json: async () => ({ organization: draft() }) }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('Draft saved.');
    expect(sync.invalidate).toHaveBeenCalledOnce();
  });

  it('keeps the legal editor open and disabled during saving and retains fields after failure', async () => {
    sync.data = [draft()];
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: false, json: async () => ({ message: 'Still unavailable' }) });
    vi.stubGlobal('fetch', fetchMock);
    renderWorkspace('?daoOrg=org-1&daoPanel=legal&daoEdit=legal');
    fireEvent.change(screen.getByLabelText('Country / jurisdiction'), { target: { value: 'CA' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
    const saving = await screen.findByRole('button', { name: /Saving…/ }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Legal preparation' })).toBeTruthy();
    await userEvent.setup().click(saving);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Draft saved/)).toBeNull();
    await act(async () => { pending.resolve({ ok: false, json: async () => ({ message: 'Could not save legal preparation' }) }); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not save legal preparation'));
    expect((screen.getByLabelText('Country / jurisdiction') as HTMLInputElement).value).toBe('CA');
    expect((screen.getByRole('button', { name: /Save preparation/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('parses and writes organization, panel, editor and create URL state and restores it on remount', async () => {
    const second = { ...draft(), id: 'org-2', name: 'River Collective' };
    sync.data = [draft(), second];
    const updates = vi.fn();
    const view = renderWorkspace('?daoOrg=org-2&daoPanel=legal&daoEdit=legal&unrelated=keep', updates);
    expect((screen.getByLabelText('Legal entity name') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('dialog', { name: 'Legal preparation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoEdit')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Money flow' }));
    await waitFor(() => expect(updates).toHaveBeenCalled());
    await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoPanel')).toBe('funding'));
    expect(updates.mock.calls.at(-1)![0].searchParams.get('daoEdit')).toBeNull();
    expect(updates.mock.calls.at(-1)![0].searchParams.get('daoOrg')).toBe('org-2');
    expect(updates.mock.calls.at(-1)![0].searchParams.get('unrelated')).toBe('keep');
    await selectOption('Organization', 'Moss Collective');
    await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoOrg')).toBe('org-1'));
    fireEvent.click(screen.getByRole('button', { name: 'New organization' }));
    await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoNew')).toBe('true'));
    expect(updates.mock.calls.at(-1)![0].options.history).toBe('push');
    const queryString = updates.mock.calls.at(-1)![0].queryString;
    view.unmount();
    renderWorkspace(queryString);
    expect(screen.getByRole('dialog', { name: 'Create an organization' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Money flow' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Organization' }).textContent).toContain('Moss Collective');
  });

  it('does not substitute another organization for an unavailable URL selection', () => {
    sync.data = [draft()];
    renderWorkspace('?daoOrg=missing&daoPanel=legal&daoEdit=legal');
    expect(screen.getByText(/selected organization is unavailable/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Legal & documents' })).toBeNull();
  });

  it('saves both delegation choices through the real shared checkbox and reopens the saved value', async () => {
    sync.data = [draft()];
    let saved = draft();
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      saved = projectDaoLaunch({ ...saved, revision: saved.revision + 1, sections: body.sections });
      return { ok: true, json: async () => ({ organization: saved }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const updates = vi.fn();
    renderWorkspace('?daoOrg=org-1&daoPanel=governance&daoEdit=governance', updates);
    const original = saved.sections.governance.delegation;
    for (const delegation of [!original, original]) {
      const checkbox = screen.getByRole('checkbox', { name: 'Allow vote delegation' });
      expect(checkbox.getAttribute('aria-checked')).toBe(String(!delegation));
      fireEvent.click(checkbox);
      expect(checkbox.getAttribute('aria-checked')).toBe(String(delegation));
      fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoEdit')).toBeNull());
      expect(saved.sections.governance.delegation).toBe(delegation);
      fireEvent.click(screen.getByRole('button', { name: 'Edit governance' }));
      const dialog = await screen.findByRole('dialog', { name: 'Governance rules' });
      await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoEdit')).toBe('governance'));
      expect(within(dialog).getByRole('checkbox', { name: 'Allow vote delegation' }).getAttribute('aria-checked')).toBe(String(delegation));
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { route: 'new', label: 'Prepare a new entity with an advisor', country: 'CA', entityName: 'Maple Cooperative', heading: 'Prepare a new legal entity' },
    { route: 'existing', label: 'Use an existing legal entity', country: 'US', entityName: 'River LLC', heading: 'Connect an existing legal entity' },
  ] as const)('saves $route legal route and $country through real controls, then restores it from the saved fixture on remount', async ({ route, label, country, entityName, heading }) => {
    const initial = draft();
    initial.sections.legal.route = route === 'existing' ? 'new' : 'existing';
    sync.data = [initial];
    let saved = initial;
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      saved = projectDaoLaunch({ ...saved, revision: saved.revision + 1, sections: body.sections });
      return { ok: true, json: async () => ({ organization: saved }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const updates = vi.fn();
    const view = renderWorkspace('?daoOrg=org-1&daoPanel=legal&daoEdit=legal', updates);
    await selectOption('Legal route', label);
    fireEvent.change(screen.getByLabelText('Country / jurisdiction'), { target: { value: country } });
    fireEvent.change(screen.getByLabelText('Legal entity name'), { target: { value: entityName } });
    const referenceLabel = route === 'existing' ? 'Registration reference' : 'Formation application reference';
    fireEvent.change(screen.getByLabelText(referenceLabel), { target: { value: 'reference-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save preparation/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/desktop/dao-launch/org-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(String(options.body))).toMatchObject({ expectedRevision: 2, sections: { legal: { route, country, entityName, registrationReference: 'reference-1' } } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByText(entityName + ' · ' + country)).toBeTruthy();
    expect(saved.fundingActive).toBe(false);
    expect(saved.treasuryBalance).toBeNull();
    await waitFor(() => expect(updates.mock.calls.at(-1)![0].searchParams.get('daoEdit')).toBeNull());
    const queryString = updates.mock.calls.at(-1)![0].queryString;
    sync.data = [saved]; view.unmount();
    renderWorkspace(queryString);
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit legal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Legal preparation' });
    expect(within(dialog).getByRole('combobox', { name: 'Legal route' }).textContent).toContain(label);
    expect((within(dialog).getByLabelText('Country / jurisdiction') as HTMLInputElement).value).toBe(country);
    expect((within(dialog).getByLabelText(referenceLabel) as HTMLInputElement).value).toBe('reference-1');
    expect((within(dialog).getByLabelText('Legal entity name') as HTMLInputElement).value).toBe(entityName);
  });
});

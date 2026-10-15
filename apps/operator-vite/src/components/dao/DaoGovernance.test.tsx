// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import DaoGovernance from './DaoGovernance';
import { workbenchTextField, openWorkbenchSelect, chooseWorkbenchOption, reviewWorkbenchProposal } from '../../../../../scripts/lib/dao-workbench-controls.mts';

const view: DaoWorkspaceView = { directoryId: 'dao', localHomeSlug: 'local-home', status: 'connected',
  projects: { status: 'ready', value: [{ slug: 'project', title: 'Project', plans: [{ slug: 'proposal', title: 'Build the tool', status: 'draft', owner: null, itemCount: 1 }] }] } };
const inspection = { ok: true, planRevisionHash: 'reviewed-hash', actor: { memberId: 'voter', roles: ['vote', 'round-open', 'finalize'] },
  integrityErrors: [], conflictedRoundIds: [], rounds: [{ roundId: 'round', status: 'open', expiresAtMs: Date.now() + 60_000,
    ballots: [], certificate: null }] };
let current = inspection;
let document = { title: 'Build the tool', raw: 'Exact proposal text', contentHash: 'reviewed-hash' };
let actionResponse: Record<string, unknown>;
let creationResponse: Record<string, unknown>;
let readFailure = false;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  current = structuredClone(inspection); document = { title: 'Build the tool', raw: 'Exact proposal text', contentHash: 'reviewed-hash' };
  actionResponse = { ...inspection };
  creationResponse = { ok: true, slug: 'new-proposal-2026-10-08' };
  readFailure = false;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    const args = init?.body ? JSON.parse(String(init.body)) : {};
    // Match the maintained HTTP contract: get is a read verb, never a POST.
    if (path.endsWith('/get') && (readFailure || (init?.method ?? 'GET') !== 'GET'))
      return { ok: false, status: 404, text: async () => "plans write verb 'get' not found" };
    return { ok: true, json: async () => path.endsWith('/get') ? document : path.endsWith('/new') ? creationResponse : args.op === 'inspect' ? current : actionResponse };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function selectOption(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}
async function choose() {
  await selectOption('Review proposal', 'Build the tool · project');
  await screen.findByText('Exact proposal text');
}
describe('DAO member decision actions', () => {
  it('drives scoped native HR selects through the real change event without touching another form', () => {
    const changed = vi.fn();
    render(<><section className="other-form"><label>Candidate<select defaultValue="other"><option value="other">Other</option></select></label></section>
      <section data-testid="dao-workspace"><label>Candidate<select defaultValue="" onChange={event => changed(event.currentTarget.value)}>
        <option value="">Select</option><option value="PER-candidate">Candidate</option></select></label></section></>);
    act(() => { window.eval(workbenchTextField('Candidate', 'PER-candidate', '[data-testid=dao-workspace]')); });
    expect(changed).toHaveBeenCalledWith('PER-candidate');
    expect(screen.getAllByRole('combobox').map(select => (select as HTMLSelectElement).value)).toEqual(['other', 'PER-candidate']);
  });
  it('drives the native verifier through current portaled select and revision checkbox controls', async () => {
    render(<DaoGovernance view={view} />);
    expect(() => window.eval(workbenchTextField('Review proposal', 'project/proposal'))).toThrow('Missing text field');
    act(() => { window.eval(openWorkbenchSelect('Review proposal')); });
    await screen.findByRole('option', { name: 'Build the tool · project' });
    act(() => { window.eval(chooseWorkbenchOption('Build the tool · project')); });
    await screen.findByText('Exact proposal text');
    const open = screen.getByRole('button', { name: 'Open voting round' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    act(() => { window.eval(reviewWorkbenchProposal()); });
    await waitFor(() => expect(open.disabled).toBe(false));
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    act(() => { window.eval(reviewWorkbenchProposal()); });
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(() => window.eval(chooseWorkbenchOption('Missing proposal'))).toThrow('Missing enabled option');
  });
  it('updates controlled proposal fields through the native verifier adapter', async () => {
    render(<DaoGovernance view={view} />);
    act(() => { window.eval(workbenchTextField('Proposal title', 'Native proposal')); });
    expect((screen.getByLabelText('Proposal title') as HTMLInputElement).value).toBe('Native proposal');
    act(() => { window.eval(workbenchTextField('Purpose & scope', 'Persist exact scope')); });
    expect((screen.getByLabelText('Purpose & scope') as HTMLTextAreaElement).value).toBe('Persist exact scope');
  });
  it('loads the exact proposal through the maintained scoped GET reader', async () => {
    render(<DaoGovernance view={view} />); await choose();
    const call = fetchMock.mock.calls.find(([url]) => new URL(url, 'http://localhost').pathname.endsWith('/get'))!;
    const url = new URL(call[0], 'http://localhost');
    expect(call[1]?.method ?? 'GET').toBe('GET');
    expect(call[1]?.body).toBeUndefined();
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(url.searchParams)).toEqual({ slug: 'proposal', mode: 'full', harness: 'project', includeEnrichments: 'false' });
    expect(screen.getByText('Deciding as voter')).toBeTruthy();
  });
  it('keeps a failed proposal read ineligible even when the voting policy loads', async () => {
    readFailure = true; render(<DaoGovernance view={view} />);
    await selectOption('Review proposal', 'Build the tool · project');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("plans write verb 'get' not found"));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).op === 'local-action')).toBe(false);
  });
  it.each([undefined, ''])('refuses a proposal without an exact revision: %s', async contentHash => {
    document.contentHash = contentHash as unknown as string;
    render(<DaoGovernance view={view} />);
    await selectOption('Review proposal', 'Build the tool · project');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('exact revision'));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('requires revision review and sends a scoped signed-device vote action', async () => {
    const onChanged = vi.fn(); render(<DaoGovernance view={view} onChanged={onChanged} />); await choose();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Your approve vote was recorded.');
    const call = fetchMock.mock.calls.find(([, init]) => init?.body && JSON.parse(String(init.body)).op === 'local-action')!;
    expect(JSON.parse(String(call[1].body))).toEqual({ harness: 'project', slug: 'proposal', op: 'local-action',
      expectedRevisionHash: 'reviewed-hash', action: { kind: 'vote', roundId: 'round', choice: 'approve' } });
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it('keeps mismatched document and governance revisions ineligible', async () => {
    document.contentHash = 'newer-hash'; render(<DaoGovernance view={view} />); await choose();
    await userEvent.setup().click(screen.getByRole('checkbox'));
    expect(screen.getByRole('alert').textContent).toContain('changed while loading');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows an eligible reader without granting signing permission', async () => {
    current = { ...current, actor: null as unknown as typeof current.actor };
    render(<DaoGovernance view={view} />); await choose(); await userEvent.setup().click(screen.getByRole('checkbox'));
    expect(screen.getByText(/not enrolled as a signer/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('blocks decisions on conflicted evidence', async () => {
    current = { ...current, conflictedRoundIds: ['round'] as never[] };
    render(<DaoGovernance view={view} />); await choose(); await userEvent.setup().click(screen.getByRole('checkbox'));
    expect(screen.getByRole('alert').textContent).toContain('prevent voting');
    expect((screen.getByRole('button', { name: 'Finalize result' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('surfaces a server-side refusal without claiming the ballot was saved', async () => {
    actionResponse = { ok: false, detail: 'The member key was revoked.' };
    render(<DaoGovernance view={view} />); await choose(); await userEvent.setup().click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('key was revoked'));
    expect(screen.queryByText('Your reject vote was recorded.')).toBeNull();
  });
  it('accepts the canonical dated creation receipt in the explicitly chosen linked project', async () => {
    render(<DaoGovernance view={view} />);
    await selectOption('Project', 'Project');
    fireEvent.change(screen.getByLabelText('Proposal title'), { target: { value: 'New proposal' } });
    fireEvent.change(screen.getByLabelText('Purpose & scope'), { target: { value: 'Build an export' } });
    fireEvent.change(screen.getByLabelText('How members will verify success'), { target: { value: 'The export includes the records' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft proposal' }));
    await screen.findByText(/Proposal saved as a draft/);
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/new'))!;
    const args = JSON.parse(String(call[1].body));
    expect(args).toMatchObject({ harness: 'project', slug: 'new-proposal', title: 'New proposal' });
    expect(args.content).toContain('The export includes the records');
    expect(args.content).toContain('| R-1 | P-001 | tree |');
  });

  it.each([{}, { ok: true, slug: 'another-proposal' }, { ok: true, slug: 'new-proposal-other' },
    { ok: true, slug: 'new-proposal-2026-10-08-other' }])('retains the draft when the server does not confirm its creation: %j', async response => {
    creationResponse = response;
    const onChanged = vi.fn();
    render(<DaoGovernance view={view} onChanged={onChanged} />);
    await selectOption('Project', 'Project');
    fireEvent.change(screen.getByLabelText('Proposal title'), { target: { value: 'New proposal' } });
    fireEvent.change(screen.getByLabelText('Purpose & scope'), { target: { value: 'Build an export' } });
    fireEvent.change(screen.getByLabelText('How members will verify success'), { target: { value: 'The records persist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft proposal' }));
    await screen.findByText(/The server did not confirm/);
    expect((screen.getByLabelText('Proposal title') as HTMLInputElement).value).toBe('New proposal');
    expect(screen.queryByText(/Proposal saved as a draft/)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { HiringView } from '@papercusp/operator-core/lib/dao-hr/hiring';
import HiringViews from './HiringViews';
// Radix primitives portal/hide their native controls; native stand-ins with the same contract keep options + onChange routing assertable.
vi.mock('@/app/harness/Select', () => ({ Select: ({ value, onChange, options, ariaLabel, placeholder }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; ariaLabel?: string; placeholder?: string }) => (
  <select aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)}>{placeholder ? <option value="">{placeholder}</option> : null}{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>) }));
vi.mock('@/app/harness/Checkbox', () => ({ Checkbox: ({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) => (
  <input type="checkbox" aria-label={ariaLabel} checked={checked} onChange={e => onChange(e.target.checked)} />) }));

const view: HiringView = {
  actorPersonId: 'PER-author', nonBinding: true,
  people: [{ personId: 'PER-author', displayName: 'Author' }, { personId: 'PER-candidate', displayName: 'Candidate' }],
  roles: [{ roleId: 'role', title: 'Engineer', level: 'L3', managerPersonId: 'PER-author', exclusive: true, candidates: ['PER-candidate'] }],
  offers: [{ workspaceId: 'ws', daoSlug: 'dao', offerId: 'offer', roleId: 'role', personId: 'PER-candidate', authoredBy: 'PER-author', approvalsRequired: 1, state: 'offered', approvedBy: [],
    terms: { engagementType: 'contractor', jurisdiction: 'US', employmentLike: true, pay: { amount: '5000', currency: 'USD', cadence: 'monthly' }, equity: { shares: 1000, vestingDays: 1460, cliffDays: 365, startRule: 'hire_passed', policyVersion: 2 } },
    preview: { offeredShares: '1000', existingFullyDilutedShares: '9000', proposedFullyDilutedShares: '10000', fullyDilutedPercent: '10.00' } }],
  chain: { blockNumber: '42', issuedShares: '8000', reservedShares: '1000' }, chainError: null,
  history: [{ id: '1', subjectKind: 'offer', subjectId: 'offer', state: 'offered', actorPersonId: 'PER-author', at: '2026-10-11' }],
};
const fetcher = vi.fn();
const response = (hiring = view) => Response.json({ ok: true, hiring });
const show = (params = '?hiringRole=role&hiringOffer=offer') => render(<NuqsTestingAdapter searchParams={params}><HiringViews daoSlug="dao" /></NuqsTestingAdapter>);

describe('Hiring Workbench', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  beforeEach(() => { fetcher.mockReset().mockImplementation(async () => response()); vi.stubGlobal('fetch', fetcher); });
  it('shows chain preview, employment classification, actor history and separate approval', async () => {
    show();
    const detail = await screen.findByRole('article', { name: 'Offer detail' });
    expect(screen.getByText(/Test chain — non-binding/)).toBeTruthy();
    expect(within(detail).getByText(/10.00% of 10000/)).toBeTruthy();
    expect(within(detail).getByRole('alert').textContent).toContain('looks like employment');
    expect(within(detail).getByText(/offered · Author/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve offer' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Another HR admin/)).toBeTruthy();
  });
  it('calibrates the non-binding marker against refreshed issuing entity state', async () => {
    fetcher.mockImplementation(async () => response({ ...view, nonBinding: false }));
    show();
    await screen.findByRole('article', { name: 'Offer detail' });
    expect(screen.queryByText(/Test chain — non-binding/)).toBeNull();

    fetcher.mockImplementation(async () => response(view));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh hiring' }));
    await screen.findByText(/Test chain — non-binding/);

    fetcher.mockImplementation(async () => response({ ...view, nonBinding: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh hiring' }));
    await waitFor(() => expect(screen.queryByText(/Test chain — non-binding/)).toBeNull());
    expect(screen.getByRole('article', { name: 'Offer detail' })).toBeTruthy();
  });
  it('sends the selected existing person and pay/equity terms without an actor or workspace', async () => {
    show('?hiringRole=role');
    const form = await screen.findByRole('form', { name: 'Create offer' });
    fireEvent.change(within(form).getByLabelText('Engagement'), { target: { value: 'contractor' } });
    fireEvent.change(within(form).getByLabelText('Jurisdiction'), { target: { value: 'US' } });
    fireEvent.change(within(form).getByLabelText('Pay amount'), { target: { value: '7000.25' } });
    fireEvent.change(within(form).getByLabelText('Shares override'), { target: { value: '250' } });
    fireEvent.submit(form);
    await waitFor(() => expect(fetcher.mock.calls.some(c => c[1]?.method === 'POST')).toBe(true));
    const call = fetcher.mock.calls.find(c => c[1]?.method === 'POST')!;
    expect(call[0]).toBe('/api/pot/dao/hiring');
    expect(JSON.parse(call[1].body)).toEqual({ action: 'offer', roleId: 'role', personId: 'PER-candidate', engagementType: 'contractor', jurisdiction: 'US', pay: { amount: '7000.25', currency: 'USD', cadence: 'monthly' }, overrides: { shares: 250 } });
    await waitFor(() => expect(fetcher.mock.calls.filter(c => !c[1]).length).toBe(2));
  });
  it('refreshes percentage from the server and never invents missing chain totals', async () => {
    show(); await screen.findByRole('article', { name: 'Offer detail' });
    const changed = { ...view, chain: null, chainError: 'Chain totals unavailable', offers: view.offers.map(o => ({ ...o, preview: null })) };
    fetcher.mockImplementation(async () => response(changed));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh hiring' }));
    await screen.findByText('Chain totals unavailable');
    expect(screen.queryByText(/10.00%/)).toBeNull();
    expect(screen.getByText(/Percentage unavailable/)).toBeTruthy();
  });
  it('keeps authorization and action errors actionable and does not expose stale pay after a refused read', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, message: 'A current DAO HR admin must sign in.' }, { status: 403 }));
    show(); await screen.findByText('A current DAO HR admin must sign in.');
    expect(screen.queryByText(/5000/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('article', { name: 'Offer detail' });
  });
  it('a different admin can approve and the UI reloads the authoritative stage', async () => {
    const reviewer = { ...view, actorPersonId: 'PER-reviewer' };
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => options?.method === 'POST' ? Response.json({ ok: true }) : response(reviewer));
    show(); await screen.findByRole('article', { name: 'Offer detail' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve offer' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(c => !c[1]).length).toBe(2));
    expect(JSON.parse(fetcher.mock.calls.find(c => c[1]?.method === 'POST')![1].body)).toEqual({ action: 'approve', offerId: 'offer' });
  });
  it('creates an amendment referencing the active offer with a preserved vesting schedule', async () => {
    const hired:HiringView={...view,offers:view.offers.map(offer=>({...offer,state:'hired'}))};
    fetcher.mockImplementation(async(url:string,init?:RequestInit)=>url.endsWith('/hiring')?init?Response.json({ok:true}):response(hired):Response.json({ok:false,message:'Fixture only'}));
    show();const form=await screen.findByRole('form',{name:'Create engagement amendment'});
    fireEvent.change(within(form).getByLabelText('Amended pay amount'),{target:{value:'7000'}});
    fireEvent.change(within(form).getByLabelText('Amended total grant shares'),{target:{value:'1500'}});
    fireEvent.submit(form);
    await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(true));
    expect(JSON.parse(fetcher.mock.calls.find(([,init])=>init?.method==='POST')![1].body)).toEqual({action:'offer',roleId:'role',personId:'PER-candidate',amendsOfferId:'offer',
      engagementType:'contractor',jurisdiction:'US',pay:{amount:'7000',currency:'USD',cadence:'monthly'},overrides:{shares:1500,vestingDays:1460,cliffDays:365}});
  });
});

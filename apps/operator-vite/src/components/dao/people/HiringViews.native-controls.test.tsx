// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { HiringView } from '@papercusp/operator-core/lib/dao-hr/hiring';
import { chooseWorkbenchOption, openWorkbenchDisclosure, openWorkbenchSelect, workbenchTextField, clickWorkbenchButton } from '../../../../../../scripts/lib/dao-workbench-controls.mts';
import HiringViews from './HiringViews';
import ContractSigningViews from './ContractSigningViews';

const scope = '[data-testid=dao-workspace]';
const people = [{ personId: 'PER-admin', displayName: 'Native admin' },
  { personId: 'PER-approver', displayName: 'Native approver' }, { personId: 'PER-candidate', displayName: 'Native candidate' }];
const hiring: HiringView = { actorPersonId: 'PER-admin', nonBinding: true, people, roles: [], offers: [], chain: null, chainError: null, history: [] };
const offer: HiringView['offers'][number] = { workspaceId: 'ws', daoSlug: 'dao', offerId: 'offer', roleId: 'role',
  personId: 'PER-candidate', authoredBy: 'PER-admin', approvalsRequired: 1, approvedBy: ['PER-approver'], state: 'approved', preview: null,
  terms: { engagementType: 'employee', jurisdiction: 'US-DE', employmentLike: true,
    pay: { amount: '5000', currency: 'USD', cadence: 'monthly' },
    equity: { shares: 1000, vestingDays: 1460, cliffDays: 365, startRule: 'hire_passed', policyVersion: 2 } } };
const evaluate = (expression: string) => act(() => { window.eval(expression); });
async function select(label: string, option: string) {
  evaluate(openWorkbenchSelect(label, scope));
  await screen.findByRole('option', { name: option });
  evaluate(chooseWorkbenchOption(option));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Native hiring controls with the real shared primitives', () => {
  it('opens role creation before filling and submitting the rendered form, without closing it on a repeated open', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, hiring }));
    vi.stubGlobal('fetch', fetcher);
    render(<NuqsTestingAdapter><section data-testid="dao-workspace"><HiringViews daoSlug="dao" /></section></NuqsTestingAdapter>);
    const summary = await screen.findByText('Create a role', { selector: 'summary' });
    const details = summary.parentElement as HTMLDetailsElement;
    expect(details.open).toBe(false);
    evaluate(openWorkbenchDisclosure('Create a role', scope));
    expect(details.open).toBe(true);
    evaluate(workbenchTextField('Role title', 'Native engineer', scope));
    evaluate(workbenchTextField('Level', 'L3', scope));
    evaluate(openWorkbenchDisclosure('Create a role', scope));
    expect(details.open).toBe(true);
    expect((screen.getByLabelText('Role title') as HTMLInputElement).value).toBe('Native engineer');
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(fetcher.mock.calls.some(call => call.length > 1)).toBe(true));
    expect(fetcher).toHaveBeenCalledWith('/api/pot/dao/hiring', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ action: 'role', title: 'Native engineer', level: 'L3', managerPersonId: null, exclusive: false }) }));
    expect(() => window.eval(openWorkbenchDisclosure('Missing form', scope))).toThrow('Missing disclosure');
  });

  it('selects the candidate through the portaled control and submits its person id', async () => {
    const view = { ...hiring, roles: [{ roleId: 'role', title: 'Native engineer', level: 'L3', managerPersonId: null, exclusive: false, candidates: [] }] };
    const fetcher = vi.fn(async () => Response.json({ ok: true, hiring: view }));
    vi.stubGlobal('fetch', fetcher);
    render(<NuqsTestingAdapter searchParams="?hiringRole=role"><section data-testid="dao-workspace"><HiringViews daoSlug="dao" /></section></NuqsTestingAdapter>);
    const submit = await screen.findByRole('button', { name: 'Add candidate' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await select('Candidate', 'Native candidate');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/pot/dao/hiring', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ action: 'candidate', roleId: 'role', personId: 'PER-candidate' }) })));
  });

  it('opens the offer action when its candidate name also labels the preceding combobox', async () => {
    const view: HiringView = { ...hiring,
      roles: [{ roleId: 'role', title: 'Native engineer', level: 'L3', managerPersonId: null, exclusive: false, candidates: ['PER-candidate'] }],
      offers: [{ ...offer, state: 'offered', approvedBy: [] }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, hiring: view })));
    render(<NuqsTestingAdapter searchParams="?hiringRole=role"><section data-testid="dao-workspace"><HiringViews daoSlug="dao" /></section></NuqsTestingAdapter>);
    await screen.findByRole('combobox', { name: 'Offer candidate' });
    const firstMatch = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Native candidate');
    expect(firstMatch?.getAttribute('role')).toBe('combobox');
    evaluate(clickWorkbenchButton('Native candidate'));
    await screen.findByRole('article', { name: 'Offer detail' });
    expect(screen.getByText('Another HR admin must approve your offer.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve offer' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('selects a company countersigner through the real control before generating a contract', async () => {
    const templates = [{ templateKey: 'employment', documentKind: 'employment-agreement', title: 'Employment' },
      { templateKey: 'equity', documentKind: 'equity-grant-agreement', title: 'Equity' }]
      .map(template => ({ ...template, engagementType: 'employee', jurisdiction: 'US-DE', latestVersion: 1 }));
    const fetcher = vi.fn(async () => Response.json({ ok: true, templates, execution: null }));
    vi.stubGlobal('fetch', fetcher);
    render(<section data-testid="dao-workspace"><ContractSigningViews daoSlug="dao" offer={offer} people={people} onChanged={vi.fn()} /></section>);
    await screen.findByRole('combobox', { name: 'Company countersigner' });
    await select('Company countersigner', 'Native approver');
    evaluate(workbenchTextField('Start date', '2026-11-01', scope));
    fireEvent.click(screen.getByRole('button', { name: 'Generate contract' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/pot/dao/contracts', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ action: 'prepare', offerId: 'offer', companyPersonId: 'PER-approver', startDate: '2026-11-01',
        templates: [{ templateKey: 'employment', version: 1 }, { templateKey: 'equity', version: 1 }] }) })));
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { useState } from 'react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import DaoWorkspaceDetails from './DaoWorkspaceDetails';
vi.mock('@/app/_components/RouteLink', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const view: DaoWorkspaceView = { directoryId: 'published-id', localHomeSlug: 'installed-home', status: 'connected' };

describe('DAO workspace record presentation', () => {
  it('retains integrity failures in the voting view', () => {
    render(<DaoWorkspaceDetails section="vote" view={{ ...view, governance: { status: 'ready', value: { events: [], integrityErrors: ['invalid signature'], conflictedRoundIds: [] } } }} loading={false} error="" />);
    expect(screen.getByRole('alert').textContent).toContain('invalid signature');
    expect(screen.getByRole('link', { name: 'Open proposal and plan workspace' }).getAttribute('href')).toContain('slug=installed-home');
  });
  it('keeps finance account prerequisites explicit and invents no balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (path: string) => ({ ok: true, json: async () => path.endsWith('/finance') ? { ok: true, policyVersion: 0, bindings: {}, treasury: { status: 'not-bound' }, equity: { status: 'not-bound' }, commerce: { status: 'not-bound' }, wallet: { ok: false }, actions: [] } : { ok: true, policy: null, canEdit: false } })));
    render(<DaoWorkspaceDetails section="treasury" view={view} loading={false} error="" />);
    expect(await screen.findByText('No owner-signed account binding is recorded for this area. Configure it in the owner policy.')).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });
  it('renders scoped project and plan records', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workItems: [], total: 0 }) }));
    render(<DaoWorkspaceDetails section="work" view={{ ...view, projects: { status: 'ready', value: [{ slug: 'project-home', title: 'Project', plans: [{ slug: 'proposal', title: 'Build a thing', status: 'active', owner: null, itemCount: 3 }] }] } }} loading={false} error="" />);
    expect(screen.getByRole('link', { name: 'Build a thing' }).getAttribute('href')).toContain('slug=project-home');
    expect(screen.getByText('active')).toBeTruthy();
  });
  it('keeps an unreadable policy distinct from a policy that does not exist', () => {
    render(<DaoWorkspaceDetails section="vote" view={{ ...view, policy: { status: 'error', message: 'Policy read failed' } }} loading={false} error="" />);
    expect(screen.getByRole('alert').textContent).toBe('Policy read failed');
    expect(screen.getByText('Policy unavailable')).toBeTruthy();
    expect(screen.queryByText('No policy recorded')).toBeNull();
    expect(screen.queryByText('Review admission thresholds')).toBeNull();
  });

  it('reproduces the candidate onboarding loss when a challenge refresh changes membership', async () => {
    const connected: DaoWorkspaceView = {
      ...view,
      localHomeSlug: 'installed-home',
      contractHomeSlug: 'installed-home',
      members: { status: 'ready', value: [] },
      people: { status: 'ready', value: [] },
    };
    const notJoined: DaoWorkspaceView = {
      directoryId: 'published-id', localHomeSlug: null, contractHomeSlug: 'installed-home', status: 'not-joined',
      members: { status: 'ready', value: [] },
    };
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => init
      ? { ok: true, json: async () => ({ ok: true, result: { challengeId: 'challenge', message: 'exact message' } }) }
      : { ok: true, json: async () => ({ ok: true, onboarding: {
        offerId: 'offer', state: 'signed', bindingEligible: false, isAdmin: false, isCandidate: true,
        chainError: null, proposalId: null, plan: null,
        checklist: [{ key: 'contract', label: 'Contract', complete: true }, { key: 'membership', label: 'Membership', complete: false }],
      } }) });
    vi.stubGlobal('fetch', fetcher);
    const onChanged = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState(connected);
      return <NuqsTestingAdapter searchParams="?peopleTab=onboarding&onboardingOffer=offer">
        <DaoWorkspaceDetails section="members" view={current} loading={false} error="" onChanged={() => { onChanged(); setCurrent(notJoined); }} />
      </NuqsTestingAdapter>;
    }
    render(<Harness />);
    const onboarding = await screen.findByRole('form', { name: 'Bind onboarding wallet' });
    fireEvent.change(screen.getByLabelText('Wallet address'), { target: { value: '0x' + '11'.repeat(20) } });
    fireEvent.submit(onboarding);
    await waitFor(() => expect(screen.getByRole('form', { name: 'Verify onboarding wallet signature' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Connect to this DAO' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'My signed engagement' })).toBeNull();
    expect(screen.getByLabelText('Wallet signature')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([, init]) => init).map(([, init]) => JSON.parse(init.body))).toEqual([
      { action: 'wallet-challenge', walletAddress: '0x' + '11'.repeat(20), chainId: 1 },
    ]);

    fireEvent.change(screen.getByLabelText('Wallet signature'), { target: { value: '0x' + '22'.repeat(65) } });
    fireEvent.submit(screen.getByRole('form', { name: 'Verify onboarding wallet signature' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Connect to this DAO' })).toBeTruthy());
    expect(screen.getByRole('form', { name: 'Open signed engagement' })).toBeTruthy();
    expect(screen.getByDisplayValue('offer')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Bind onboarding wallet' })).toBeTruthy();
    expect(fetcher.mock.calls.filter(([, init]) => init).map(([, init]) => JSON.parse(init.body))).toEqual([
      { action: 'wallet-challenge', walletAddress: '0x' + '11'.repeat(20), chainId: 1 },
      { action: 'wallet-verify', challengeId: 'challenge', signature: '0x' + '22'.repeat(65) },
    ]);
  });
});

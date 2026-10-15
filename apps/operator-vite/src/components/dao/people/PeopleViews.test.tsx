// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { DaoPerson, DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import PeopleViews from './PeopleViews';
import { reportingForest } from './org-chart';
// The application provides RouteLink's progress/router context; this component
// test exercises real nuqs state and renders the shared navigation seam as a link.
vi.mock('@/app/_components/RouteLink', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

afterEach(cleanup);
const rows: DaoPerson[] = [
  { memberId: 1, personId: 'PER-alice', username: 'alice', displayName: 'Alice', bindingStatus: 'bound', devices: 1, profile: { title: 'Engineer', team: 'Product', managerPersonId: null,
    level: 'L3', startDate: '2026-10-01', engagementType: 'contractor', jurisdiction: 'US', status: 'active' },
    equity: { status: 'ready', value: { wallet: '0x1111111111111111111111111111111111111111', chainId: 1, shares: '1200', issuedShares: '10000', ownershipPercent: '12.00' } } },
  { memberId: 2, personId: null, username: 'bob', displayName: 'Bob', bindingStatus: 'bound', devices: 2, profile: null, equity: { status: 'error', message: 'No verified wallet is linked to this member.' } },
];
const view: DaoWorkspaceView = { directoryId: 'dao', localHomeSlug: 'dao', status: 'connected', people: { status: 'ready', value: rows } };

describe('SPEC-P-009 — current members including unprofiled members', () => {
  it('renders each current member and opens the selected profile', async () => {
    render(<NuqsTestingAdapter><PeopleViews view={view} /></NuqsTestingAdapter>);
    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
    expect(await screen.findByText('No work profile recorded.')).toBeTruthy();
  });
});

describe('SPEC-P-011 / A — cap table and my equity', () => {
  const position = { holderId: '1', wallet: '0x1111111111111111111111111111111111111111', shares: '1200', committed: '2000', earned: '500', claimed: '100', unvested: '1500',
    returnEntitlements: '80', unclaimedReturns: '40', ownershipPercent: '12.00', fullyDilutedPercent: '14.00', grants: [], returns: [], personId: 'PER-alice', displayName: 'Alice equity holder', isSelf: false };
  const capView: DaoWorkspaceView = { ...view, capTable: { status: 'ready', value: { chainId: 1, blockNumber: '42', contractVersion: '2',
    issuedShares: '10000', reservedShares: '10000', fullyDilutedShares: '20000', nonBinding: true,
    positions: [position, { ...position, holderId: '2', personId: null, displayName: 'My equity holder', isSelf: true }] } } };
  it('shows every holder and the non-binding marker, then URL-selected My equity limits only that view', async () => {
    const update = vi.fn();
    render(<NuqsTestingAdapter searchParams="?peopleTab=cap" onUrlUpdate={update}><PeopleViews view={capView} /></NuqsTestingAdapter>);
    expect(screen.getByRole('note').textContent).toBe('test chain - non-binding');
    expect(screen.getByRole('table', { name: 'Cap table positions' })).toBeTruthy();
    expect(screen.getAllByText('Alice equity holder').length).toBeGreaterThan(0);
    expect(screen.getAllByText('My equity holder').length).toBeGreaterThan(0);
    for (const heading of ['Shares owned', 'Grants committed', 'Grants earned', 'Grants claimed', 'Grants unvested', 'Return entitlements', '% fully diluted'])
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: 'My equity' }));
    await waitFor(() => expect(screen.queryByText('Alice equity holder')).toBeNull());
    expect(screen.getAllByText('My equity holder').length).toBeGreaterThan(0);
    await waitFor(() => expect(update.mock.calls.at(-1)![0].searchParams.get('peopleTab')).toBe('my'));
  });
  it('does not present a missing or failed chain read as an empty portfolio', () => {
    const refresh = vi.fn();
    render(<NuqsTestingAdapter searchParams="?peopleTab=my"><PeopleViews view={{ ...view, capTable: { status: 'error', message: 'Chain reader unavailable' } }} onRefresh={refresh} /></NuqsTestingAdapter>);
    expect(screen.getByText('Chain reader unavailable')).toBeTruthy();
    expect(screen.queryByText('No equity position is linked to your verified member wallet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh equity' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('SPEC-P-010 — reporting lines from work profiles', () => {
  const managed = { ...rows[0], profile: { ...rows[0].profile!, managerPersonId: 'PER-manager' } };
  const manager = { ...rows[1], personId: 'PER-manager' };
  it('places a person below their named manager and keeps org/profile selection in the URL', async () => {
    const update = vi.fn();
    render(<NuqsTestingAdapter searchParams="?peopleTab=org" onUrlUpdate={update}>
      <PeopleViews view={{ ...view, people: { status: 'ready', value: [managed, manager] } }} />
    </NuqsTestingAdapter>);
    expect(screen.getByRole('tab', { name: 'Org chart' }).getAttribute('aria-selected')).toBe('true');
    const managerRow = screen.getByRole('listitem', { name: 'Bob reporting line' });
    expect(within(managerRow).getByRole('listitem', { name: 'Alice reporting line' })).toBeTruthy();
    fireEvent.click(within(managerRow).getByRole('button', { name: 'Alice' }));
    expect(await screen.findByRole('article', { name: 'Alice profile' })).toBeTruthy();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls.at(-1)![0].searchParams.get('peopleTab')).toBe('profile');
    expect(update.mock.calls.at(-1)![0].searchParams.get('person')).toBe('PER-alice');
  });
  it('keeps absent managers explicit and renders cyclic members once with their real reports', () => {
    const absent = reportingForest([managed]);
    expect(absent[0].issue).toBe('Manager is not a current member.');
    const cycleManager = { ...manager, profile: { ...managed.profile, managerPersonId: 'PER-alice' } };
    const report = { ...rows[1], memberId: 3, personId: 'PER-report', profile: { ...managed.profile, managerPersonId: 'PER-alice' } };
    const forest = reportingForest([managed, cycleManager, report]);
    expect(forest.map(node => node.person.memberId)).toEqual([1, 2]);
    expect(forest.every(node => node.issue?.startsWith('Reporting cycle'))).toBe(true);
    expect(forest[0].reports.map(node => node.person.memberId)).toEqual([3]);
  });
});
describe('SPEC-P-009-F — URL selection', () => {
  it('restores the tab and canonical person from URL query state and writes the directory transition back', async () => {
    const update = vi.fn();
    render(<NuqsTestingAdapter searchParams="?peopleTab=profile&person=PER-alice" onUrlUpdate={update}>
      <PeopleViews view={view} />
    </NuqsTestingAdapter>);
    expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByText('12.00%')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Pay terms' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const params = update.mock.calls.at(-1)![0].searchParams as URLSearchParams;
    expect(params.get('peopleTab')).toBeNull();
    expect(params.get('person')).toBe('PER-alice');
  });
  it('does not substitute a different person for an unavailable URL selection', () => {
    render(<NuqsTestingAdapter searchParams="?peopleTab=profile&person=PER-missing"><PeopleViews view={view} /></NuqsTestingAdapter>);
    expect(screen.getByText('The selected person is not a current member of this organization.')).toBeTruthy();
    expect(screen.queryByText('1200')).toBeNull();
  });
});

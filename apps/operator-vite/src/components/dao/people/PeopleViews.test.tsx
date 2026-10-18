// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { DaoCapTable, DaoPerson, DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
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
  // Production wire DTO, with hand-calculated economics rather than values from
  // the cap-table implementation: owned 1200 + 8800 = 10000; pending grants
  // (2000 - 100) + (9000 - 1000), plus unclaimed returns 40 + 60 = 10000.
  // Alice's diluted position is (1200 + 1900 + 40) / 20000 = 15.70%.
  // These are component fixtures; chain reads are verified by cap-table.test.ts.
  const snapshot: DaoCapTable = { chainId: 1, blockNumber: '42', contractVersion: '2',
    issuedShares: '10000', reservedShares: '10000', fullyDilutedShares: '20000', nonBinding: true,
    positions: [
      { holderId: '1', wallet: '0x1111111111111111111111111111111111111111', shares: '1200', committed: '2000', earned: '500', claimed: '100', unvested: '1500',
        returnEntitlements: '80', unclaimedReturns: '40', ownershipPercent: '12.00', fullyDilutedPercent: '15.70',
        grants: [{ id: 'alice-grant', committed: '2000', earned: '500', claimed: '100', unvested: '1500', forfeited: '0', stopped: false }],
        returns: [{ id: 'return-claimed', entitled: '40', claimed: true }, { id: 'return-pending', entitled: '40', claimed: false }],
        personId: 'PER-alice', displayName: 'Alice equity holder', isSelf: false },
      { holderId: '2', wallet: '0x2222222222222222222222222222222222222222', shares: '8800', committed: '9000', earned: '2000', claimed: '1000', unvested: '7000',
        returnEntitlements: '160', unclaimedReturns: '60', ownershipPercent: '88.00', fullyDilutedPercent: '84.30',
        grants: [{ id: 'self-grant', committed: '9000', earned: '2000', claimed: '1000', unvested: '7000', forfeited: '0', stopped: false }],
        returns: [{ id: 'return-claimed', entitled: '100', claimed: true }, { id: 'return-pending', entitled: '60', claimed: false }],
        personId: null, displayName: 'My equity holder', isSelf: true },
    ] };
  const capView: DaoWorkspaceView = { ...view, capTable: { status: 'ready', value: snapshot } };
  it('calibrates the public DTO fixture against independent supply, grant and return oracles', () => {
    expect(new Set(snapshot.positions.map(row => row.wallet)).size).toBe(2);
    expect(snapshot.positions.reduce((total, row) => total + BigInt(row.shares), 0n)).toBe(10000n);
    expect(snapshot.positions.map(row => [row.committed, row.earned, row.claimed, row.unvested,
      row.returnEntitlements, row.unclaimedReturns, row.ownershipPercent, row.fullyDilutedPercent])).toEqual([
      ['2000', '500', '100', '1500', '80', '40', '12.00', '15.70'],
      ['9000', '2000', '1000', '7000', '160', '60', '88.00', '84.30'],
    ]);
    let reserved = 0n;
    for (const row of snapshot.positions) {
      for (const key of ['committed', 'earned', 'claimed', 'unvested'] as const)
        expect(row.grants.reduce((total, grant) => total + BigInt(grant[key]), 0n)).toBe(BigInt(row[key]));
      expect(row.returns.reduce((total, entry) => total + BigInt(entry.entitled), 0n)).toBe(BigInt(row.returnEntitlements));
      expect(row.returns.filter(entry => !entry.claimed).reduce((total, entry) => total + BigInt(entry.entitled), 0n)).toBe(BigInt(row.unclaimedReturns));
      reserved += BigInt(row.earned) - BigInt(row.claimed) + BigInt(row.unvested) + BigInt(row.unclaimedReturns);
    }
    expect(reserved).toBe(10000n);
    expect(snapshot.reservedShares).toBe('10000');
    expect(BigInt(snapshot.issuedShares) + reserved).toBe(20000n);
    expect(snapshot.fullyDilutedShares).toBe('20000');
  });
  it.each([true, false])('uses the production nonBinding=%s marker in both equity views', async nonBinding => {
    const update = vi.fn();
    render(<NuqsTestingAdapter searchParams="?peopleTab=cap" onUrlUpdate={update}>
      <PeopleViews view={{ ...capView, capTable: { status: 'ready', value: { ...snapshot, nonBinding } } }} />
    </NuqsTestingAdapter>);
    const checkMarker = () => {
      if (nonBinding) {
        expect(screen.getByRole('note').textContent).toBe('test chain - non-binding');
        expect(screen.queryByText('On-chain register · verify against issuer documents.')).toBeNull();
      } else {
        expect(screen.queryByRole('note')).toBeNull();
        expect(screen.getByText('On-chain register · verify against issuer documents.')).toBeTruthy();
      }
    };
    checkMarker();
    expect(screen.getByText('Chain 1 · block 42 · issued 10000 · reserved 10000 · fully diluted 20000')).toBeTruthy();
    expect(screen.getAllByText('15.70%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('84.30%').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: 'My equity' }));
    await waitFor(() => expect(update.mock.calls.at(-1)![0].searchParams.get('peopleTab')).toBe('my'));
    checkMarker();
    expect(screen.queryByText('15.70%')).toBeNull();
    expect(screen.getAllByText('84.30%').length).toBeGreaterThan(0);
  });
  it('preserves the contributor-work destination through the shared link seam', () => {
    render(<NuqsTestingAdapter searchParams="?peopleTab=cap">
      <PeopleViews view={{ ...capView, localHomeSlug: 'dao / equity & people' }} />
    </NuqsTestingAdapter>);
    expect(screen.getByRole('link', { name: 'Open contributor work' }).getAttribute('href'))
      .toBe('/adv?slug=dao%20%2F%20equity%20%26%20people&tab=harnesses');
  });
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

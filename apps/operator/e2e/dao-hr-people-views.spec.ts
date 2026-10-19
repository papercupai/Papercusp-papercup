/** R-8 browser coverage of the real DAO workspace with explicit read-only wire fixtures.
 * SQL authorization and contract balances are independently covered by people.test.ts
 * and cap-table.test.ts; these fixtures verify their DTOs survive browser navigation.
 */
import { test, expect, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import type { DaoCapTable, DaoPerson, DaoWorkspaceView } from '../../../packages/operator-core/lib/dao-workspace-types';

const directoryId = 'dao-hr-browser-fixture';
const members: DaoPerson[] = [
  { memberId: 1, personId: 'PER-alice', username: 'alice', displayName: 'Alice', bindingStatus: 'bound', devices: 1,
    profile: { title: 'Engineer', team: 'Product', managerPersonId: 'PER-manager', level: 'L3',
      startDate: '2026-10-01', engagementType: 'contractor', jurisdiction: 'US', status: 'active' },
    equity: { status: 'ready', value: { wallet: '0x1111111111111111111111111111111111111111', chainId: 31337,
      shares: '1200', issuedShares: '10000', ownershipPercent: '12.00' } } },
  { memberId: 2, personId: 'PER-manager', username: 'manager', displayName: 'Morgan', bindingStatus: 'bound', devices: 2,
    profile: null, equity: { status: 'error', message: 'No verified wallet is linked to this member.' } },
  { memberId: 3, personId: null, username: 'unprofiled', displayName: 'Unprofiled member', bindingStatus: 'bound', devices: 1,
    profile: null, equity: { status: 'error', message: 'No verified wallet is linked to this member.' } },
];

// Literal economics: 1200+8800 owned; outstanding grants 1900+8000 and
// unclaimed returns 40+60 reserve 10000. Alice's diluted interest is 3140/20000.
const capTable: DaoCapTable = {
  chainId: 31337, blockNumber: '42', contractVersion: '2', issuedShares: '10000', reservedShares: '10000',
  fullyDilutedShares: '20000', nonBinding: true,
  positions: [
    { holderId: '1', wallet: '0x1111111111111111111111111111111111111111', personId: 'PER-alice', displayName: 'Alice', isSelf: false,
      shares: '1200', committed: '2000', earned: '500', claimed: '100', unvested: '1500',
      returnEntitlements: '80', unclaimedReturns: '40', ownershipPercent: '12.00', fullyDilutedPercent: '15.70',
      grants: [{ id: 'alice-grant', committed: '2000', earned: '500', claimed: '100', unvested: '1500', forfeited: '0', stopped: false }],
      returns: [{ id: 'claimed', entitled: '40', claimed: true }, { id: 'pending', entitled: '40', claimed: false }] },
    { holderId: '2', wallet: '0x2222222222222222222222222222222222222222', personId: 'PER-manager', displayName: 'Morgan', isSelf: true,
      shares: '8800', committed: '9000', earned: '2000', claimed: '1000', unvested: '7000',
      returnEntitlements: '160', unclaimedReturns: '60', ownershipPercent: '88.00', fullyDilutedPercent: '84.30',
      grants: [{ id: 'manager-grant', committed: '9000', earned: '2000', claimed: '1000', unvested: '7000', forfeited: '0', stopped: false }],
      returns: [{ id: 'claimed', entitled: '100', claimed: true }, { id: 'pending', entitled: '60', claimed: false }] },
  ],
};

function workspace(): DaoWorkspaceView {
  return structuredClone({ directoryId, localHomeSlug: 'dao-hr-browser', status: 'connected',
    people: { status: 'ready', value: members }, capTable: { status: 'ready', value: capTable } });
}

async function installReads(page: Page, read: () => DaoWorkspaceView) {
  const sync = await stubSyncQueries(page, name => {
    if (name === 'network.hiveDirectory') return [{ potId: directoryId, title: 'HR browser DAO', owner: 'Fixture',
      description: 'Read-only People browser acceptance', visibility: 'invite', memberLinks: [], memberTopics: [], memberCount: 0 }];
    if (name === 'workspaceHosts.control') return [];
    return undefined;
  });
  let workspaceReads = 0;
  await page.route('**/api/discovery/pots?*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('potId') !== directoryId) return route.fallback();
    expect(route.request().method()).toBe('GET');
    expect(url.searchParams.get('includeLocalViews')).toBe('true');
    workspaceReads++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace: read() }) });
  });
  return {
    async open(query = '') {
      await page.goto(`/daos?dao=${directoryId}&daoSection=members${query}`);
      await sync.waitForServed(['network.hiveDirectory', 'workspaceHosts.control']);
      await expect(page.getByRole('tablist', { name: 'People views' })).toBeVisible();
      expect(workspaceReads).toBeGreaterThan(0);
      sync.assertServed('network.hiveDirectory', 'workspaceHosts.control');
    },
    get count() { return workspaceReads; },
  };
}

async function expectSelection(page: Page, tab: string | null, person?: string) {
  await expect.poll(() => new URL(page.url()).searchParams.get('peopleTab')).toBe(tab);
  if (person) await expect.poll(() => new URL(page.url()).searchParams.get('person')).toBe(person);
}

test('R8 directory includes unprofiled members and profile selection survives reload', async ({ page }) => {
  const fixture = await installReads(page, workspace);
  await fixture.open();
  const table = page.getByRole('table', { name: 'People directory' });
  for (const name of ['Alice', 'Morgan', 'Unprofiled member'])
    await expect(table.getByRole('button', { name, exact: true })).toBeVisible();
  await table.getByRole('button', { name: 'Unprofiled member', exact: true }).click();
  await expectSelection(page, 'profile', 'member:3');
  await page.reload();
  const unprofiled = page.getByRole('article', { name: 'Unprofiled member profile' });
  await expect(unprofiled.getByText('No work profile recorded.')).toBeVisible();
  await expect(unprofiled.getByText('No verified wallet is linked to this member.')).toBeVisible();
  await page.getByRole('tab', { name: 'Directory', exact: true }).click();
  await expectSelection(page, null, 'member:3');
  await table.getByRole('button', { name: 'Alice', exact: true }).click();
  const profile = page.getByRole('article', { name: 'Alice profile' });
  await expect(profile.getByText('Engineer', { exact: true })).toBeVisible();
  await expect(profile.getByText('1200', { exact: true })).toBeVisible();
  await expect(profile.getByText('12.00%', { exact: true })).toBeVisible();
  await expect(profile.getByRole('heading', { name: 'Pay terms' })).toHaveCount(0);
});

test('R8 authorized pay DTO renders alongside public equity', async ({ page }) => {
  const view = workspace();
  if (view.people?.status !== 'ready') throw new Error('Fixture requires ready people');
  view.people.value[0].pay = { amount: '50000.00', currency: 'USD', cadence: 'annual' };
  const fixture = await installReads(page, () => view);
  await fixture.open('&peopleTab=profile&person=PER-alice');
  const profile = page.getByRole('article', { name: 'Alice profile' });
  await expect(profile.getByRole('heading', { name: 'Pay terms' })).toBeVisible();
  await expect(profile.getByText('50000.00 USD · annual', { exact: true })).toBeVisible();
  await expect(profile.getByText('1200', { exact: true })).toBeVisible();
  await expect(profile.getByText('12.00%', { exact: true })).toBeVisible();
});

test('R8 reporting hierarchy opens the canonical profile and restores org URL state', async ({ page }) => {
  const fixture = await installReads(page, workspace);
  await fixture.open('&peopleTab=org');
  const manager = page.getByRole('listitem', { name: 'Morgan reporting line', exact: true });
  const report = manager.getByRole('listitem', { name: 'Alice reporting line', exact: true });
  await expect(report).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Unprofiled member reporting line', exact: true })).toBeVisible();
  await report.getByRole('button', { name: 'Alice', exact: true }).click();
  await expectSelection(page, 'profile', 'PER-alice');
  await expect(page.getByRole('article', { name: 'Alice profile' })).toBeVisible();
  await page.getByRole('tab', { name: 'Org chart', exact: true }).click();
  await expectSelection(page, 'org', 'PER-alice');
  await page.reload();
  await expect(report).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Org chart', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('R8 cap table shows other holders and My equity filters only the selected view', async ({ page }) => {
  const fixture = await installReads(page, workspace);
  await fixture.open('&peopleTab=cap');
  const cap = page.getByRole('region', { name: 'Cap table', exact: true });
  const table = cap.getByRole('table', { name: 'Cap table positions' });
  await expect(cap.getByRole('note')).toHaveText('test chain - non-binding');
  await expect(cap.getByText('Chain 31337 · block 42 · issued 10000 · reserved 10000 · fully diluted 20000')).toBeVisible();
  const alice = table.getByRole('row').filter({ hasText: 'Alice' });
  const morgan = table.getByRole('row').filter({ hasText: 'Morgan' });
  for (const value of ['1200', '2000', '500', '100', '1500', '80', '40', '12.00%', '15.70%'])
    await expect(alice.getByText(value, { exact: true })).toBeVisible();
  await expect(morgan.getByText('8800', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'My equity', exact: true }).click();
  await expectSelection(page, 'my');
  await page.reload();
  const mine = page.getByRole('region', { name: 'My equity', exact: true });
  // RichGrid also has an aria-hidden print mirror. Assert the accessible row
  // so hidden print cells cannot satisfy or duplicate the browser assertions.
  const myPosition = mine.getByRole('table', { name: 'My equity positions' })
    .getByRole('row').filter({ hasText: 'Morgan' });
  await expect(myPosition.getByText('Morgan', { exact: true })).toBeVisible();
  await expect(mine.getByText('Alice', { exact: true })).toHaveCount(0);
  await expect(myPosition.getByText('84.30%', { exact: true })).toBeVisible();
  await expect(mine.getByRole('note')).toHaveText('test chain - non-binding');
  await page.getByRole('tab', { name: 'Cap table', exact: true }).click();
  await expectSelection(page, 'cap');
  await expect(alice).toBeVisible();
});

test('R8 unavailable selection and failed chain read stay explicit; refresh re-reads data', async ({ page }) => {
  let view = workspace();
  const fixture = await installReads(page, () => view);
  await fixture.open('&peopleTab=profile&person=PER-missing');
  await expect(page.getByText('The selected person is not a current member of this organization.')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Alice profile' })).toHaveCount(0);
  view = { ...view, capTable: { status: 'error', message: 'Fixture chain reader unavailable' } };
  const reads = fixture.count;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => fixture.count).toBeGreaterThan(reads);
  await page.getByRole('tab', { name: 'My equity', exact: true }).click();
  await expect(page.getByText('Fixture chain reader unavailable', { exact: false })).toBeVisible();
  await expect(page.getByText('No equity position is linked to your verified member wallet.')).toHaveCount(0);
  view = workspace();
  await page.getByRole('button', { name: 'Refresh equity', exact: true }).click();
  await expect(page.getByRole('table', { name: 'My equity positions' })
    .getByRole('row').filter({ hasText: 'Morgan' }).getByText('8800', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture chain reader unavailable', { exact: false })).toHaveCount(0);
});

import { test, expect, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';

// Exercise the shipped MachineSwitcher, Nuqs adapter, browser storage and
// navigation together. Only the read-only inventory wire response is a fixture;
// these tests do not establish remote authorization or customer-local discovery.
const inventoryQuery = 'workspaceHosts.control';
const first = 'instance-selection-home';
const second = 'instance-selection-laptop';
const hosts = [
  { kind: 'workspace', id: first, name: 'Selection home', observedState: 'running' },
  { kind: 'workspace', id: second, name: 'Selection laptop', observedState: 'stopped' },
  { kind: 'workspace', id: 'instance-selection-absent', name: 'Removed host', observedState: 'absent' },
  { kind: 'workspace', id: 'instance-selection-destroying', name: 'Destroying host', observedState: 'destroying' },
];

function machine(page: Page) {
  return page.getByRole('group', { name: 'Machine selection', exact: true })
    .getByRole('combobox', { name: 'Machine', exact: true });
}

async function installInventory(page: Page, read = () => hosts) {
  const sync = await stubSyncQueries(page, name => name === inventoryQuery ? read() : undefined);
  return {
    async open(params: Record<string, string> = {}) {
      await page.goto(`/settings/remote-access?${new URLSearchParams(params)}`);
      await sync.waitForServed([inventoryQuery]);
      await expect(machine(page)).toBeEnabled();
      sync.assertServed(inventoryQuery);
    },
    sync,
  };
}

async function choose(page: Page, label: string) {
  await machine(page).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

async function expectTarget(page: Page, id: string, label: string) {
  await expect.poll(() => new URL(page.url()).searchParams.get('desktopHost')).toBe(id);
  await expect(machine(page)).toContainText(label);
}

test('instance selection routes its visible local default without leaving the current app', async ({ page }) => {
  const fixture = await installInventory(page);
  await fixture.open();
  await expectTarget(page, 'local', 'This computer');
  expect(new URL(page.url()).pathname).toBe('/settings/remote-access');
  await machine(page).click();
  await expect(page.getByRole('option', { name: 'Selection home — running', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Selection laptop — stopped', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Removed host — absent', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Destroying host — destroying', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('instance selection clears the old desktop and restores its target through reload and history', async ({ page }) => {
  const fixture = await installInventory(page);
  await fixture.open({ desktopHost: first, host: first, desktop: 'watch:old', desktopPins: 'old', desktopFilter: 'old' });
  await expectTarget(page, first, 'Selection home');
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
  await choose(page, 'Selection laptop — stopped');
  await expectTarget(page, second, 'Selection laptop');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
  const selected = new URL(page.url());
  expect(selected.pathname).toBe('/desktops');
  expect(selected.searchParams.get('host')).toBe(second);
  for (const key of ['desktop', 'desktopPins', 'desktopFilter']) expect(selected.searchParams.has(key), key).toBe(false);
  await page.reload();
  await expectTarget(page, second, 'Selection laptop');
  await page.goBack();
  await expectTarget(page, first, 'Selection home');
  expect(new URL(page.url()).searchParams.get('desktop')).toBe('watch:old');
  await page.goForward();
  await expectTarget(page, second, 'Selection laptop');
});

test('an unavailable selected instance stays explicit until another machine is chosen', async ({ page }) => {
  let available = hosts;
  const fixture = await installInventory(page, () => available);
  await fixture.open({ desktopHost: first, host: first });
  await expectTarget(page, first, 'Selection home');
  available = hosts.filter(row => row.id !== first);
  await page.reload();
  await expectTarget(page, first, 'Machine unavailable');
  await expect(page.getByRole('status').filter({ hasText: 'Choose another machine' })).toBeVisible();
  await choose(page, 'This computer');
  await expectTarget(page, 'local', 'This computer');
});

test('selecting an instance in one window leaves another window on its own target', async ({ page, context }) => {
  const fixture = await installInventory(page);
  await fixture.open({ desktopHost: first, host: first });
  const other = await context.newPage();
  try {
    const otherFixture = await installInventory(other);
    await otherFixture.open({ desktopHost: first, host: first });
    const original = other.url();
    await choose(page, 'Selection laptop — stopped');
    await expectTarget(page, second, 'Selection laptop');
    await expectTarget(other, first, 'Selection home');
    expect(other.url()).toBe(original);
    await other.reload();
    await expectTarget(other, first, 'Selection home');
    expect(await page.evaluate(() => sessionStorage.getItem('pc:selected-machine'))).toBe(second);
    expect(await other.evaluate(() => sessionStorage.getItem('pc:selected-machine'))).not.toBe(second);
    otherFixture.sync.assertServed(inventoryQuery);
  } finally {
    await other.close();
  }
});

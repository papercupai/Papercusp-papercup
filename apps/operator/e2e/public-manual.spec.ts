import { expect, test, type Page } from './_egress';

// Uses the owning Playwright profile. For exact production proof, set
// OPERATOR_E2E_BASE_URL and OPERATOR_E2E_REUSE_SERVER=1; do not silently
// substitute a development server for the cloud destination.
test.use({ channel: 'chrome' });

const guides = [
  ['quickstart', 'Your first successful task'],
  ['plans-and-work', 'Plans and work'],
  ['agent-modes-and-fleets', 'Agent modes and fleets'],
  ['accounts-and-billing', 'Accounts and billing'],
  ['voice', 'Talking to an agent'],
] as const;

for (const [slug, title] of guides) {
  test(`new public guide is reachable, reloadable and readable on mobile: ${slug}`, async ({ page }) => {
    await page.goto('/docs');
    await page.getByRole('link', { name: title, exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(page.url()).toContain(`/docs/${slug}`);
  });
}

test('account guide separates portal identity, model accounts and organization access', async ({ page }) => {
  await page.goto('/docs/accounts-and-billing');
  const guide = page.getByRole('main');
  await expect(guide.getByRole('heading', { level: 1, name: 'Accounts and billing' })).toBeVisible();
  await expect(guide).toContainText('Portal account');
  await expect(guide).toContainText('navigation rail');
  await expect(guide).toContainText('Status');
  await expect(guide).toContainText(/Accounts sidebar[\s\S]*model accounts/);
  await expect(guide).toContainText('does not show an organization name or selector');
  await expect(guide).toContainText(/administrator to confirm[\s\S]*membership/);
  await expect(guide).not.toContainText(/Open the portal.s Accounts destination to check the signed-in identity/);
});

test('a new guide is present in the actual Pagefind search index', async ({ page }) => {
  await page.goto('/docs');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').first().fill('fleets');
  const result = dialog.locator('.pagefind-ui__result-link')
    .filter({ hasText: 'Agent modes and fleets' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent modes and fleets' })).toBeVisible();
});

test('the first-task guide supports keyboard entry and search without a pointer', async ({ page }) => {
  await page.goto('/docs/quickstart');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#_top$/);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('main').locator('a:focus'))
    .toHaveAttribute('href', '#1-create-an-account-or-sign-in');

  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input').first()).toBeFocused();
  await page.keyboard.type('first successful task');
  const result = dialog.locator('.pagefind-ui__result-link')
    .filter({ hasText: 'Your first successful task' }).first();
  await expect(result).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('the first-task guide remains readable and retains the selected theme after reload', async ({ page }) => {
  await page.goto('/docs/quickstart');
  // Starlight has a hidden mobile duplicate; exercise the visible accessible control.
  const theme = page.getByRole('combobox');
  for (const value of ['dark', 'light']) {
    await theme.selectOption(value);
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await expect(theme).toHaveValue(value);
    await expect(page.getByRole('heading', { level: 1, name: 'Your first successful task' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

async function deferSearchInitialization(page: Page) {
  await page.addInitScript(() => {
    // Starlight mounts Pagefind during idle time. Control that real lifecycle
    // rather than hoping machine timing happens to open the dialog first.
    const callbacks: IdleRequestCallback[] = [];
    window.requestIdleCallback = (callback) => callbacks.push(callback);
    window.addEventListener('manual-test-release-idle', () => {
      for (const callback of callbacks.splice(0)) {
        callback({ didTimeout: false, timeRemaining: () => 50 });
      }
    });
  });
}

test('search focuses its input when opened before Pagefind initializes', async ({ page }) => {
  await deferSearchInitialization(page);
  await page.goto('/docs/quickstart');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('manual-test-release-idle')));
  const input = dialog.locator('input').first();
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.type('first successful task');
  await expect(dialog.locator('.pagefind-ui__result-link')
    .filter({ hasText: 'Your first successful task' }).first()).toBeVisible();
});

test('late search initialization preserves focus when the reader already closed search', async ({ page }) => {
  await deferSearchInitialization(page);
  await page.goto('/docs/quickstart');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  const dialog = page.locator('site-search dialog');
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  const taskLink = page.getByRole('main').locator('a[href="#1-create-an-account-or-sign-in"]').first();
  await taskLink.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('manual-test-release-idle')));
  await expect(dialog.locator('input')).toHaveCount(1);
  await expect(taskLink).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(dialog.locator('input').first()).toBeFocused();
});

for (const [device, viewport] of [
  ['desktop', { width: 1280, height: 720 }],
  ['mobile', { width: 375, height: 812 }],
] as const) {
  test(`Common questions has a reloadable public bookmark and readable answers on ${device}`, async ({ page }) => {
    // Select the reader's layout before navigation; resizing an already-scrolled
    // page preserves a pixel position instead of opening a new mobile bookmark.
    await page.setViewportSize(viewport);
    await page.goto('/docs');
    if (device === 'mobile') {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
    }
    const faqLink = page.getByRole('link', { name: 'Common questions', exact: true }).first();
    await expect(faqLink).toBeVisible();
    await faqLink.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Common questions' })).toBeVisible();
    await expect(page.locator('main h2')).toHaveCount(20);
    // Reload immediately: waiting for the first jump would hide the smooth-scroll
    // race that used to restore the page at the top instead of this answer.
    await page.goto('/docs/faq#where-should-i-enter-credentials');
    await page.reload();
    await expect(page.locator('#where-should-i-enter-credentials')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('main')).toContainText('Do not');
  });
}

test('Common questions is found through alternate wording in the actual Pagefind index', async ({ page }) => {
  for (const query of ['Can I paste an API key into chat', 'Do stopped disks still cost money']) {
    await page.goto('/docs');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill(query);
    const result = dialog.locator('.pagefind-ui__result-link').filter({ hasText: 'Common questions' }).first();
    await expect(result, query).toBeVisible();
    await result.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Common questions' })).toBeVisible();
    expect(page.url()).toContain('/docs/faq');
  }
});

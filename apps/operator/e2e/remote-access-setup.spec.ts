import { test, expect } from './_egress';

// The running product may have telemetry explicitly enabled. Its consented
// PostHog provider uses this Papercusp-owned host; keep every other unexpected
// origin, and the fixture's live sensor control, under the shared assertions.
test.use({ egressAllowedOrigins: ['https://flags.papercuspai.com'] });

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? 3055}`;

test.beforeEach(async ({ page }, testInfo) => {
  // The same maintained flow runs on current builds and the final shipped URL.
  // A release run pins its observed artifact, rather than inferring it from source.
  const expectedSha = process.env.PAPERCUSP_REMOTE_ACCESS_RELEASE_SHA;
  if (expectedSha) {
    const response = await page.request.get(`${baseURL}/api/health`);
    expect(response.ok()).toBe(true);
    const health = await response.json();
    expect(health.sha).toBeTruthy();
    expect(expectedSha.startsWith(health.sha) || health.sha.startsWith(expectedSha)).toBe(true);
    await testInfo.attach('release-identity', { body: JSON.stringify({ baseURL, expectedSha, health }), contentType: 'application/json' });
  }
  await page.goto(`${baseURL}/settings/remote-access`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Connect a computer over SSH', exact: true })).toBeVisible();
});

test('offers the unified methods and actionable SSH key preparation', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What would you like to connect?' })).toBeVisible();
  await page.getByRole('link', { name: 'Set up a computer', exact: true }).press('Enter');
  await expect(page).toHaveURL(/#ssh-setup$/);
  await page.getByText('Prepare the computer you want to reach', { exact: true }).press('Enter');
  await expect(page.locator('#ssh-setup details').first()).toHaveAttribute('open', '');
  await expect(page.locator('#ssh-setup details').first()).toContainText('cat ~/.ssh/id_ed25519.pub');
  await expect(page.locator('#ssh-setup details').first()).toContainText('authorized_keys');
  await page.getByRole('link', { name: 'Choose internet access', exact: true }).press('Enter');
  await expect(page).toHaveURL(/#internet-access$/);
  await page.getByRole('button', { name: 'Set up a phone', exact: true }).press('Enter');
  await expect(page.getByTestId('remote-access-pair-panel')).toBeVisible();
  await page.getByTestId('remote-access-pair-panel').getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Set up an app', exact: true }).press('Enter');
  await expect(page.getByTestId('remote-access-wizard')).toBeVisible();
});

test('generates and copies supported commands while refusing shell-shaped input', async ({ page, context }) => {
  const setup = page.getByTestId('ssh-connection-setup');
  const host = setup.getByRole('textbox', { name: 'Computer address or SSH alias', exact: true });
  await expect(setup.getByRole('textbox', { name: 'Save SSH connection', exact: true })).toHaveCount(0);
  await host.fill('host;unwanted');
  await expect(setup.getByRole('alert')).toBeVisible();
  await expect(setup.locator('textarea')).toHaveCount(0);
  await host.fill('100.64.0.2');
  await setup.getByRole('textbox', { name: 'SSH username (optional)', exact: true }).fill('alice');
  await expect(setup.getByRole('textbox', { name: 'Save SSH connection', exact: true }))
    .toHaveValue('psu --connect-add-ssh=my-computer --connect-host=100.64.0.2 --connect-user=alice');
  await expect(setup.getByRole('textbox', { name: 'Open remote terminal', exact: true })).toHaveValue('psu --connect=my-computer');
  await expect(setup.getByRole('textbox', { name: 'Open Papercusp in your browser', exact: true }))
    .toHaveValue('psu --connect=my-computer --connect-gui');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin });
  const field = setup.getByRole('textbox', { name: 'Save SSH connection', exact: true }).locator('..');
  await field.getByRole('button', { name: 'Copy', exact: true }).press('Enter');
  await expect(field.getByRole('button', { name: 'Copied ✓', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('psu --connect-add-ssh=my-computer --connect-host=100.64.0.2 --connect-user=alice');
});

test('fits the connection choices and SSH form at a 390px viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('textbox', { name: 'Computer address or SSH alias', exact: true }).fill('100.64.0.2');
  const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
  await expect(page.getByRole('textbox', { name: 'Save SSH connection', exact: true })).toBeVisible();
  await testInfo.attach('remote-access-390px', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

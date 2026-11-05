import { expect, test } from './_egress';

// /support intentionally hosts the first-party human-support service, just as
// in find-in-page.spec.ts. The sidebar journey exercises that real page.
test.use({ egressAllowedOrigins: ['https://chat.papercupai.com'] });

test('desktop sidebars keep their layout across page changes and reloads', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/support?lsb=true&chat=true');
  const steering = page.getByTestId('left-sidebar');
  const chat = page.locator('.op-chat-sidebar');
  await expect(steering).toHaveAttribute('data-collapsed', 'false');
  await expect(chat).toHaveAttribute('data-collapsed', 'false');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse Papercup chat', exact: true }).click();
  await expect(steering).toHaveAttribute('data-collapsed', 'true');
  await expect(chat).toHaveAttribute('data-collapsed', 'true');
  await expect(page).toHaveURL((url) => url.searchParams.get('lsb') === 'false' && url.searchParams.get('chat') === 'false');

  await page.locator('.pc-header').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/settings/operator' && url.searchParams.get('lsb') === 'false' && url.searchParams.get('chat') === 'false');
  await expect(steering).toHaveAttribute('data-collapsed', 'true');
  await expect(chat).toHaveAttribute('data-collapsed', 'true');
  await testInfo.attach('collapsed-after-navigation', { body: await page.screenshot(), contentType: 'image/png' });

  await page.reload();
  await expect(steering).toHaveAttribute('data-collapsed', 'true');
  await expect(chat).toHaveAttribute('data-collapsed', 'true');
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Papercup chat', exact: true }).click();
  await expect(steering).toHaveAttribute('data-collapsed', 'false');
  await expect(chat).toHaveAttribute('data-collapsed', 'false');
  await page.locator('.pc-header').getByRole('link', { name: 'Support', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/support');
  await expect(steering).toHaveAttribute('data-collapsed', 'false');
  await expect(chat).toHaveAttribute('data-collapsed', 'false');
  await testInfo.attach('expanded-after-navigation', { body: await page.screenshot(), contentType: 'image/png' });
});

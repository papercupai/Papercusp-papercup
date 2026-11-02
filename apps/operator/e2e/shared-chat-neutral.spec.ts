import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './_egress';
import { root, startDesktopGridFixtureServer as startFixtureServer } from './_desktop-grid-fixture-server';

const entry = 'apps/operator/e2e/__fixtures__/shared-chat-neutral.tsx';
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let sourceFingerprint: string;

test.beforeAll(async () => {
  const hash = createHash('sha256');
  for (const file of [entry, 'apps/operator/e2e/shared-chat-neutral.spec.ts',
    'libs/generic/chat-cards/src/structured-results.tsx',
    'libs/generic/chat-protocol/src/protocol-v1.ts',
    'libs/generic/chat-protocol/src/testing/conformance.ts',
    'libs/generic/chat-protocol/src/testing/neutral-consumer.ts',
    'libs/generic/chat-protocol/src/testing/fakes.ts']) {
    hash.update(file).update(await readFile(path.join(root, file)));
  }
  sourceFingerprint = hash.digest('hex');
  // Optimize MarkdownView's dependency roots and their complete CJS closures.
  // Listing individual leaves misses siblings such as style-to-js and extend.
  fixture = await startFixtureServer(entry, {}, ['react-markdown', 'remark-gfm']);
});
test.afterAll(async () => { await fixture?.server.close(); });
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(fixture.origin);
  try {
    await expect(page.getByRole('heading', { name: 'Neutral shared chat conformance' })).toBeVisible();
  } catch (error) {
    throw new Error(`${String(error)}\nFixture browser errors: ${errors.join('\n')}`);
  }
});
test.afterEach(async ({ page }, info) => {
  await info.attach('neutral-source', { body: JSON.stringify({
    entry, sourceFingerprint, profile: 'in-memory-fixture', productionHostEvidence: false,
  }), contentType: 'application/json' });
  if (info.status === 'passed') await info.attach('neutral-browser', {
    body: await page.screenshot(), contentType: 'image/png',
  });
});

test('P011 neutral browser executes the shared oracle and catches duplicate effects', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Neutral shared chat conformance' })).toBeVisible();
  const result = JSON.parse(await page.getByTestId('protocol').innerText());
  expect(result).toMatchObject({ violations: [], duplicateControlCaught: true,
    futureVersion: 'unsupported-version', futureRefused: true,
    invalidEvents: 0, invalidEffects: 0, invalidDecisions: 0 });
});

test('P011 neutral browser renders inert content and rechecks current action authority', async ({ page }) => {
  const document = page.locator('.structured-result[data-result-id="neutral-document"]');
  await expect(document).toContainText('Shared document reader');
  const safeLink = document.locator('a[href="https://example.com/neutral"]');
  await expect(safeLink).toHaveAttribute('target', '_blank');
  await expect(safeLink).toHaveAttribute('rel', /noopener/);
  await expect(document.locator('script,img,[onclick],[onerror],a[href^="javascript:"],a[href^="data:"]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, '__neutralExecuted') === true)).toBe(false);
  await expect(page.getByText('Foreign secret', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open foreign document' })).toHaveCount(0);
  await expect(page.getByLabel('Executed actions')).toHaveText('0');
  await document.getByRole('button', { name: 'Open document', exact: true }).click();
  await expect(page.getByLabel('Executed actions')).toHaveText('1');
  await page.getByRole('button', { name: 'Revoke document access' }).click();
  await expect(document).toHaveCount(0);
  await expect(page.locator('.structured-results').getByRole('status')).toHaveText([
    'This result is not available to this caller.',
    'This result is not available to this caller.',
  ]);
  await expect(page.getByLabel('Executed actions')).toHaveText('1');
});

test('P011 neutral browser explicitly refuses unsupported restart recovery', async ({ page }) => {
  await expect(page.getByRole('note')).toHaveText('In-memory fixture; restart recovery is unsupported.');
  const result = JSON.parse(await page.getByTestId('protocol').innerText());
  expect(result.restart).toBe('unsupported-capability');
});

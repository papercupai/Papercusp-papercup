import { expect, test } from './_egress';
import { writeFile } from 'node:fs/promises';
import { renderPlanAuditReport } from '../../../packages/operator-core/lib/plan-audit-report';
import { stubSyncQueries } from './_sync-stub';

test.use({ trace: 'retain-on-failure' });
test.afterEach(async ({ page }, testInfo) => {
  const frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), html: await frame.content().catch(error => String(error)) })));
  const file = testInfo.outputPath('frame-diagnostics.json');
  await writeFile(file, JSON.stringify({ url: page.url(), frames }, null, 2));
  await testInfo.attach('frame-diagnostics', { path: file, contentType: 'application/json' });
});

test('sidebar audit opens report, navigates evidence, and reopens history', async ({ page }, testInfo) => {
  const sync = await stubSyncQueries(page, name => {
    if (name === 'plans.list') return [{ slug: 'audit-fixture', harness: 'papercusp', title: 'Audit fixture', status: 'active', archived: false, legacy: false, counts: { todo: 1 }, items: [], decisions: [] }];
    if (name === 'plans.attention' || name === 'planWorkActivity.list') return [];
    if (name === 'advRoster.list') return [{ active: [], ended: [] }];
    return undefined;
  });
  // UI contracts use a controlled HTTP seam; a separate real-PG integration
  // suite proves persistence and workspace isolation (not a mocked database).
  const run = { id: '11111111-1111-4111-8111-111111111111', scope: 'single', planSlugs: ['audit-fixture'], status: 'complete', startedAt: '2026-10-07T00:00:00Z', rowCount: 1 };
  const submissions: unknown[] = [];
  await page.route('**/api/admin/plan-audit**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { run } });
      return;
    }
    if (url.searchParams.get('format') === 'html') {
      // Load the production shared renderer, never a lookalike report fixture.
      await route.fulfill({ contentType: 'text/html', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' }, body: renderPlanAuditReport({ rows: [{ slug: 'audit-fixture', title: 'Audit fixture', status: 'active', category: 'Finish', implementation: 'Verified implementation', recommendation: 'Review evidence', citations: [{ path: 'src/real.ts' }] }] }) });
    } else await route.fulfill({ json: url.searchParams.has('runId') ? { run } : { runs: [run] } });
  });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('plan-audit')) requests.push(request.url()); });
  page.on('requestfailed', request => errors.push(request.url() + ': ' + request.failure()?.errorText));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/adv?opcv=plans&paudit=' + run.id);
  // The root gateway intentionally replaces its search on redirect; audit
  // permalinks must name the maintained app route, not '/'. Fail before looking
  // inside an iframe if the host/URL prerequisite isn't actually established.
  await expect(page).toHaveURL(/paudit=/);
  await expect(page.getByTestId('plan-audit-pane')).toBeVisible();
  await testInfo.attach('app-readiness', { body: JSON.stringify({ url: page.url(), errors, requests, frames: page.frames().map(frame => frame.url()) }), contentType: 'application/json' });
  const frame = page.frameLocator('iframe[title="Plan audit report"]');
  try { await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible(); }
  catch (error) {
    await writeFile(testInfo.outputPath('network-diagnostics.json'), JSON.stringify({ errors, requests, frames: page.frames().map(f => f.url()) }, null, 2));
    throw error;
  }
  await expect(frame.getByText('src/real.ts', { exact: true }).first()).toBeVisible();
  await frame.getByRole('searchbox').fill('not-found');
  await expect(frame.getByText('No matching plans.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Saved audits' }).click();
  await page.getByRole('button', { name: /single audit.*complete/ }).click();
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp('paudit=' + run.id));
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '← Back to plans' })).toBeVisible();
  await expect(frame.getByRole('searchbox')).toBeVisible();
  await page.getByRole('button', { name: '← Back to plans' }).click();
  await expect(page.getByTestId('plan-audit-pane')).toHaveCount(0);
  // Submit through the actual mounted Plans surface, rather than proving only
  // that a hand-authored report URL can open the viewer.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/plans');
  await sync.waitForServed(['plans.list']);
  await expect(page.getByTestId('plans-pane-count-value')).toHaveText('1');
  await page.getByRole('button', { name: 'Audit workspace', exact: true }).click();
  await expect(page.getByTestId('plan-audit-pane')).toBeVisible();
  await expect(page).toHaveURL(new RegExp('paudit=' + run.id));
  expect(submissions).toEqual([{ scope: 'workspace' }]);
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  await page.getByRole('button', { name: '← Back to plans' }).click();
  await page.getByRole('button', { name: 'Audit visible plans', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  await page.getByRole('button', { name: '← Back to plans' }).click();
  await page.getByRole('button', { name: 'Audit plan audit-fixture', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Audit fixture' })).toBeVisible();
  expect(submissions).toEqual([
    { scope: 'workspace' },
    { scope: 'visible', planSlugs: ['audit-fixture'] },
    { scope: 'single', planSlugs: ['audit-fixture'] },
  ]);
  sync.assertServed('plans.list');
  expect(requests.some(url => url.includes('runId=history&format=html'))).toBe(false);
});

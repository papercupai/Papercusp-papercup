import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './_egress';
import { assertPlanAuditReleaseHealth, readPlanAuditReleaseConfig } from './_plan-audit-release-config';

test('promoted release artifact serves a real full-workspace audit and immutable report history', async ({ page, request }, testInfo) => {
  const release = readPlanAuditReleaseConfig();
  const token = readFileSync(join(release.home, 'superuser-token'), 'utf8').trim();
  if (!token) throw new Error('Release operator authentication is unavailable.');
  const headers = { Authorization: `Bearer ${token}`, 'x-papercusp-workspace': release.workspace, 'x-papercusp-client': release.clientId };
  await page.context().setExtraHTTPHeaders(headers);
  const health = async () => {
    const response = await request.get(release.origin + '/api/health', { headers });
    expect(response.status()).toBe(200);
    const body: unknown = await response.json();
    return { sha: assertPlanAuditReleaseHealth(body, release.expectedSha), observedAt: new Date().toISOString() };
  };
  const before = await health();
  const startedAt = new Date().toISOString();
  await page.goto('/adv?opcv=plans');
  const action = page.getByRole('button', { name: 'Audit workspace', exact: true });
  await expect(action).toBeVisible();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/plan-audit');
  await action.click();
  const response = await created;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON()).toEqual({ scope: 'workspace' });
  const { run } = await response.json() as { run: { id: string; startedAt: string; scope: string; workspace: string } };
  expect(run.scope).toBe('workspace');
  expect(run.workspace).toBe(release.workspace);
  expect(run.id).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page).toHaveURL(new RegExp('paudit=' + run.id));
  const frame = page.frameLocator('iframe[title="Plan audit report"]');
  await expect(frame.locator('#detail h2')).toBeVisible({ timeout: 11 * 60_000 });

  const jsonResponse = await request.get(release.origin + '/api/admin/plan-audit?runId=' + run.id + '&format=json', { headers });
  expect(jsonResponse.status()).toBe(200);
  const manifest = await jsonResponse.json() as {
    workspace: string;
    rows: Array<{ archived: boolean; status: string; template: string | null; templateSlug: string | null }>;
    scope: { listedAtSnapshot: number; classifiedRows: number; census: Record<string, { listed: number; included: number; excluded: number }> };
  };
  expect(manifest.workspace).toBe(release.workspace);
  expect(manifest.rows.length).toBeGreaterThan(0);
  expect(manifest.scope.listedAtSnapshot).toBe(manifest.rows.length);
  expect(manifest.scope.classifiedRows).toBe(manifest.rows.length);
  const classes = {
    archived: (row: typeof manifest.rows[number]) => row.archived,
    superseded: (row: typeof manifest.rows[number]) => row.status === 'superseded',
    rubricTemplate: (row: typeof manifest.rows[number]) => row.template === 'rubric',
    scheduledInstance: (row: typeof manifest.rows[number]) => Boolean(row.templateSlug),
  };
  for (const [key, predicate] of Object.entries(classes)) {
    const census = manifest.scope.census[key];
    expect(census.excluded, key).toBe(0);
    expect(census.included, key).toBe(census.listed);
    expect(manifest.rows.filter(predicate).length, key).toBe(census.included);
  }
  const embedded = await frame.locator('#audit').textContent();
  if (!embedded) throw new Error('Report omitted its original JSON evidence.');
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const manifestSha256 = digest(manifest);
  // Hash comparisons retain no private report prose in failure output.
  expect(digest(JSON.parse(embedded))).toBe(manifestSha256);
  await page.screenshot({ path: testInfo.outputPath('report-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Saved audits', exact: true }).click();
  const timestamp = await page.evaluate(iso => new Date(iso).toLocaleString(), run.startedAt);
  const saved = page.getByRole('button').filter({ hasText: 'workspace audit · ' + timestamp });
  await expect(saved.first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('history.png'), fullPage: true });
  await saved.first().click();
  await expect(page).toHaveURL(new RegExp('paudit=' + run.id));
  await expect(frame.locator('#detail h2')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp('paudit=' + run.id));
  await expect(frame.locator('#detail h2')).toBeVisible();
  expect(digest(JSON.parse((await frame.locator('#audit').textContent())!))).toBe(manifestSha256);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.getByRole('searchbox')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('report-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '← Back to plans', exact: true }).click();
  await expect(page.getByTestId('plan-audit-pane')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('back-to-plans.png'), fullPage: true });
  const after = await health();
  expect(after.sha).toBe(before.sha);
  const observations = {
    schemaVersion: 1, kind: 'plan-audit-release-observations', expectedPromotedSha: release.expectedSha,
    promotionReceiptRef: release.receiptRef, origin: release.origin, startedAt, finishedAt: after.observedAt,
    workspace: release.workspace, clientId: release.clientId,
    healthBefore: before, healthAfter: after, auditRunId: run.id, reportId: run.id, rowCount: manifest.rows.length,
    census: manifest.scope.census, manifestSha256,
    checks: ['workspace action', 'full historical census', 'production report JSON parity', 'saved history', 'reload', 'mobile', 'Back', 'same artifact before and after'],
    screenshots: ['report-desktop.png', 'history.png', 'report-mobile.png', 'back-to-plans.png'],
  };
  writeFileSync(testInfo.outputPath('release-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  await testInfo.attach('release-observations', { body: JSON.stringify(observations), contentType: 'application/json' });
});

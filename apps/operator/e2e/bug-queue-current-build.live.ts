import { test, expect } from './_egress';

// Preserve admission evidence on failure: a wire trace cannot measure queue wait.
test.afterEach(async ({ page, request }, info) => {
  const client = await page.evaluate(() => {
    const metrics = (window as unknown as { __sync_metrics__?: { snapshot(): unknown } }).__sync_metrics__;
    return metrics?.snapshot() ?? { status: 'unavailable' };
  }).catch((error) => ({ status: 'unavailable', error: String(error) }));
  const runtime = await request.get('/api/health').then(async (response) => ({
    status: response.status(), body: await response.json(),
  })).catch((error) => ({ status: 'unavailable', error: String(error) }));
  await info.attach('current-build-client-diagnostics', {
    body: JSON.stringify({ at: new Date().toISOString(), client, runtime }),
    contentType: 'application/json',
  });
});

// R5 current-build acceptance. Reads actual enrolled data and actual browser
// subscriptions; no route stubs, synthetic claims, or owner-policy writes.
test('real reserved candidate stays a candidate with unknown execution through reload on the identified build', async ({ page, request }, info) => {
  const expectedSha = process.env.PAPERCUSP_BQL_SHA;
  const itemId = process.env.PAPERCUSP_BQL_ITEM_ID;
  const harness = process.env.PAPERCUSP_BQL_HARNESS;
  expect(expectedSha, 'Supply the independently measured serving SHA').toMatch(/^[a-f0-9]{10,40}$/);
  expect(itemId, 'Supply an enrolled real candidate item').toMatch(/^(WI|EI)-[0-9]+$/);
  expect(harness, 'Supply the concrete harness').toBeTruthy();

  const health = async () => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.sha).toBe(expectedSha);
    expect(body.bundleStale).toBeUndefined();
    return { sha: body.sha, at: new Date().toISOString() };
  };
  const before = await health();
  const args = { harnessSlug: harness, id: itemId };
  const response = await request.get('/api/zero-harness/rest-query', {
    params: { name: 'workItems.detail', args: JSON.stringify(args) },
  });
  expect(response.ok()).toBe(true);
  const rows = (await response.json()).rows;
  expect(rows).toHaveLength(1);
  const initial = rows[0];
  expect(initial.id).toBe(itemId);
  expect(initial.presentation?.stage, 'The enrolled row must still be an unaccepted candidate').toBe('candidate');
  expect(initial.presentation.workEvidence.reservation?.owner).toBeTruthy();
  expect(initial.presentation.workEvidence.nativeAttestation.status).toBe('unknown');

  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.goto(`/adv?tab=harnesses&slug=${encodeURIComponent(harness!)}&scope=self&welcome=0&sel=${encodeURIComponent(itemId!)}`);
  // A real harness restores its existing dock layout, which may select a chat
  // beside Detail. Activate the actual tab as the owner would; deep-linking an
  // item does not imply the persisted dock group's selected tab is Detail.
  const activateDetail = async () => {
    // The dock title gains the selected item id after the detail loads.
    await page.getByText(/^Detail(?: · WI-[0-9]+)?$/).last().click({ timeout: 30_000 });
  };
  await activateDetail();
  const detail = page.locator('.pc-adv-detail').filter({ has: page.locator('.pc-adv-detail__id', { hasText: itemId! }) }).first();
  const assertTruthfulDetail = async () => {
    await expect(detail.locator('.pc-adv-detail__id')).toHaveText(itemId!, { timeout: 30_000 });
    await expect(detail.getByText('Reproduction or review candidates', { exact: true })).toBeVisible();
    const evidence = detail.locator('.pc-adv-detail__field-row').filter({ has: page.getByText('Work evidence', { exact: true }) });
    await expect(evidence).toContainText('Reserved');
    await expect(evidence).toContainText('Work attestation unknown');
    await expect(detail.getByText('Active accepted work', { exact: true })).toHaveCount(0);
    await expect(detail.getByText('Reserved accepted work', { exact: true })).toHaveCount(0);
  };
  await assertTruthfulDetail();

  await page.reload();
  await activateDetail();
  await assertTruthfulDetail();
  // The UI subscription may arrive by SSE or cache. Independently read its
  // actual browser origin rather than demand a particular delivery transport.
  const readback = await page.evaluate(async (args) => {
    const query = new URLSearchParams({ name: 'workItems.detail', args: JSON.stringify(args) });
    const response = await fetch(`/api/zero-harness/rest-query?${query}`);
    return { status: response.status, payload: await response.json() };
  }, args);
  expect(readback.status).toBe(200);
  expect(readback.payload.rows).toHaveLength(1);
  const reloaded = readback.payload.rows[0];
  expect(reloaded.id).toBe(itemId);
  expect(reloaded.presentation.stage).toBe('candidate');
  expect(reloaded.presentation.workEvidence.reservation?.owner).toBe(initial.presentation.workEvidence.reservation.owner);
  expect(reloaded.presentation.workEvidence.nativeAttestation.status).toBe('unknown');
  await assertTruthfulDetail();
  const after = await health();
  await page.screenshot({ path: info.outputPath('real-candidate-detail.png') });
  await info.attach('current-build-real-candidate', {
    body: JSON.stringify({ schemaVersion: 1, harness, itemId, before, after,
      initial: { id: initial.id, state: initial.state, presentation: initial.presentation },
      reloaded: { id: reloaded.id, state: reloaded.state, presentation: reloaded.presentation },
      browserReadbackStatus: readback.status,
      scope: 'One real reserved candidate; no validator-adoption, population, or shipment claim' }),
    contentType: 'application/json',
  });
});

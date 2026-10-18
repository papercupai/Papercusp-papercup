import { test, expect } from './_egress';
import { resolveTestRunWorkspaceId } from '@papercusp/test-config/admin-test-runs-reporter';

type Goal = { id: string; title: string; standing?: boolean };
type Package = { ref: string; title: string; standing: boolean; featured: boolean; activeGoalId: string | null };
type Goals = { goals: Goal[]; goalPackages: Package[] };

test('the explicitly enrolled goal renders its real declared collection through reload on the identified artifact', async ({ page, request }, info) => {
  const workspaceId = resolveTestRunWorkspaceId();
  const goalId = process.env.PAPERCUSP_ONGOING_COLLECTION_GOAL_ID?.trim();
  const expectedSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA?.trim();
  expect(workspaceId, 'Supply the real workspace before reading its enrolled goal').toBeTruthy();
  expect(goalId, 'Supply PAPERCUSP_ONGOING_COLLECTION_GOAL_ID for the existing enrolled goal; package projection may select a different legacy instance').toBeTruthy();
  expect(expectedSha, 'Supply the independently resolved runtime SHA').toMatch(/^[a-f0-9]{10,40}$/);
  const health = await (await request.get('/api/health')).json();
  expect(health.sha).toBe(expectedSha);
  expect(health.bundleStale).toBeUndefined();

  const read = await request.get('/api/zero-harness/rest-query', {
    params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId }) },
  });
  expect(read.ok(), 'The actual enrolled goal must be readable').toBe(true);
  const before = (await read.json()).rows[0];
  expect(before.goal.id).toBe(goalId);
  expect(before.goalData?.collections?.worklist?.selection).toMatchObject({ ok: true, configured: true,
    collection: { source: 'active-workspace-plans', order: 'priority', selectable: true } });
  expect(before.goalData.collections.worklist.rows.length, 'Discovery must supply real plan rows').toBeGreaterThan(0);

  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/admin/goals/')) {
      writes.push(new URL(request.url()).pathname);
    }
  });
  async function navigateToGoal(phase: string, navigate: () => Promise<unknown>) {
    const started = Date.now();
    // The shell can mount while this exact detail read is still queued. Make
    // receipt of its data a prerequisite, then judge the resulting editor.
    const receipt = page.waitForResponse((response) => {
      const url = new URL(response.url());
      if (!url.pathname.endsWith('/rest-query') || url.searchParams.get('name') !== 'goals.detail') return false;
      return JSON.parse(url.searchParams.get('args') ?? '{}').goalId === goalId;
    }, { timeout: 60_000 });
    try {
      const [, response] = await Promise.all([navigate(), receipt]);
      await info.attach(`enrolled-goal-${phase}-timing`, {
        body: JSON.stringify({ goalId, phase, elapsedMs: Date.now() - started, status: response.status() }),
        contentType: 'application/json',
      });
      expect(response.ok(), 'The navigated goal detail must be readable').toBe(true);
      return response;
    } catch (error) {
      await info.attach(`enrolled-goal-${phase}-failure`, {
        body: JSON.stringify({ goalId, phase, elapsedMs: Date.now() - started, url: page.url(),
          error: error instanceof Error ? error.message : String(error) }),
        contentType: 'application/json',
      });
      throw error;
    }
  }
  // This declared worklist opens the dedicated goal console. Exercise its
  // actual editor, including plans hidden by the default empty-plan filter.
  const initial = await navigateToGoal('initial', () => page.goto(
    `/adv?tab=hud&scope=all&hudtab=goals&hudgoal=${encodeURIComponent(goalId!)}&hudwoeempty=true&hudwoesort=rank&welcome=0&ws=${encodeURIComponent(workspaceId!)}`,
    { waitUntil: 'domcontentloaded' },
  ));
  expect((await initial.json()).rows[0].goal.id).toBe(goalId);
  const editor = page.getByTestId('work-on-everything-console');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor.getByRole('heading', { name: before.goal.title, exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Edit priorities', exact: true }).click();
  await expect(editor.getByRole('table', { name: 'Plans', exact: true })).toBeVisible();

  // Await the actual HTTP snapshot after reload. A cached first DOM sample
  // cannot establish the current policy or discovery order.
  const readback = await navigateToGoal('reload', () => page.reload({ waitUntil: 'domcontentloaded' }));
  const after = (await readback.json()).rows[0];
  const collection = after.goalData.collections.worklist;
  expect(collection.selection).toMatchObject({ ok: true, configured: true });
  expect(collection.selection.collection).toEqual(before.goalData.collections.worklist.selection.collection);
  expect(collection.selection.policyVersion).toBe(before.goalData.collections.worklist.selection.policyVersion);
  expect(collection.selection.policy).toEqual(before.goalData.collections.worklist.selection.policy);
  expect(after.goalData.properties).toEqual(before.goalData.properties);
  expect(after.goalData.propertySchema).toEqual(before.goalData.propertySchema);
  expect(after.goal.id).toBe(before.goal.id);
  expect(after.goal.status).toBe(before.goal.status);
  expect(after.launchSettings).toEqual(before.launchSettings);
  expect(collection.rows.map((row: { id: string }) => row.id))
    .toEqual(collection.selection.items.map((row: { id: string }) => row.id));
  await info.attach('real-enrolled-collection-readback', {
    body: JSON.stringify({ workspaceId, goalId, expectedSha,
      policyVersion: collection.selection.policyVersion, rows: collection.rows }),
    contentType: 'application/json',
  });
  // Read the entire population in one browser round trip. Per-row assertions
  // exhaust the fixed journey deadline on a large workspace plan pool.
  const renderedRows = () => editor.getByTestId('ongoing-worklist-row').evaluateAll((nodes) => nodes.map((node) => {
    const action = node.querySelector('button[aria-label^="Add "], button[aria-label^="Remove "]');
    const label = action?.getAttribute('aria-label') ?? '';
    return { id: node.getAttribute('data-worklist-id'), label: label.replace(/^(?:Add|Remove) /, ''),
      selected: label.startsWith('Remove ') };
  }));
  // Compare the complete population independently of the editor's sort for
  // unselected plans; selected rows must retain the saved priority order.
  const byId = (a: { id: string | null }, b: { id: string | null }) => (a.id ?? '').localeCompare(b.id ?? '');
  await expect.poll(async () => (await renderedRows()).sort(byId), { timeout: 15_000 })
    .toEqual(collection.rows.map((row: { id: string; label: string; selected: boolean }) => ({
      id: row.id, label: row.label, selected: row.selected,
    })).sort(byId));
  expect((await renderedRows()).filter((row) => row.selected).map((row) => row.id))
    .toEqual(collection.rows.filter((row: { selected: boolean }) => row.selected).map((row: { id: string }) => row.id));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await editor.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('real-enrolled-collection.png') });
  expect(writes, 'This real-data acceptance journey must preserve the owner policy and lifecycle').toEqual([]);
  const healthAfter = await (await request.get('/api/health')).json();
  expect(healthAfter.sha).toBe(expectedSha);
  expect(healthAfter.bundleStale).toBeUndefined();
  await info.attach('real-enrolled-collection-receipt', {
    body: JSON.stringify({ workspaceId, goalId, expectedSha, actualSha: healthAfter.sha,
      policyVersion: collection.selection.policyVersion, rows: collection.rows, writes }),
    contentType: 'application/json',
  });
});

test('real ongoing goal data reaches featured, compact and worklist detail on the identified artifact', async ({ page, request }, info) => {
  const workspaceId = resolveTestRunWorkspaceId();
  expect(workspaceId, 'The real workspace must be explicit before reading goal data').toBeTruthy();
  const diagnostics: string[] = [];
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message.slice(0, 500)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text().slice(0, 500)}`);
  });
  page.on('requestfailed', (request) => {
    if (['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())) {
      const failure = request.failure()?.errorText ?? 'unknown';
      diagnostics.push(`requestfailed ${request.resourceType()} ${new URL(request.url()).pathname}: ${failure}`);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes('rest-query')) diagnostics.push(`${url.searchParams.get('name')}: ${response.status()}`);
  });
  try {
  const expectedSha = process.env.PAPERCUSP_ONGOING_ACCEPTANCE_SHA?.trim();
  expect(expectedSha, 'Supply the independently resolved runtime SHA; a missing identity cannot certify shipment').toMatch(/^[a-f0-9]{10,40}$/);
  const healthResponse = await request.get('/api/health');
  expect(healthResponse.ok(), 'The selected artifact must answer /api/health').toBe(true);
  const health = await healthResponse.json();
  expect(health.bundleStale, 'A fallback bundle cannot establish the current artifact').toBeUndefined();
  expect(health.sha, `The selected runtime SHA must be ${expectedSha}`).toBe(expectedSha);

  // The maintained REST query reads real data independently of whether the UI's
  // initial delivery came through REST, SSE or its synchronized cache.
  const response = await request.get('/api/zero-harness/rest-query', {
    params: { name: 'goals.list', args: JSON.stringify({ workspaceId }) },
  });
  expect(response.ok(), 'The selected workspace goals query must succeed').toBe(true);
  const payload = (await response.json()).rows[0] as Goals;
  const entry = payload.goalPackages.find((item) => item.ref === 'work-on-everything');
  expect(entry, 'The real workspace must have its existing ongoing package').toBeDefined();
  expect(entry!.standing, 'The existing ongoing package must remain standing').toBe(true);
  expect(entry!.featured, 'The existing ongoing package must retain its featured server projection').toBe(true);
  expect(entry!.activeGoalId, 'The ongoing package must point to an active goal').toBeTruthy();
  const goal = payload.goals.find((item) => item.id === entry!.activeGoalId);
  expect(goal, 'The projected package must resolve to an actual goal row').toBeDefined();
  expect(goal!.standing, 'The introduced standing read-model projection must be present').toBe(true);

  await page.goto(`/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=${encodeURIComponent(workspaceId!)}`);
  try {
    await expect(page.getByRole('tablist', { name: 'HUD board' }), 'The real HUD must mount before judging goal rendering').toBeVisible();
  } catch (error) {
    const observed = diagnostics.slice(-40);
    throw new Error([
      error instanceof Error ? error.message : String(error),
      `Runtime SHA: ${expectedSha}`,
      `Workspace: ${workspaceId}`,
      `Page URL: ${page.url()}`,
      `Browser diagnostics: ${observed.length ? observed.join('\n') : 'no page errors, console errors, failed requests, or rest-query responses observed'}`,
    ].join('\n'));
  }

  // The HUD shell can mount before its separate goals.list subscription supplies
  // the package row; wait on that real-data landmark, not the shell's tablist.
  const featured = page.getByRole('region', { name: `Ongoing work: ${entry!.title}`, exact: true });
  await expect(featured).toBeVisible({ timeout: 15_000 });
  await expect(featured.locator('svg.lucide-infinity')).toHaveCount(1);
  await expect(featured.getByRole('button', { name: 'View ongoing work', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('real-ongoing-featured.png') });

  for (const tab of ['Sessions', 'Plans', 'Work items']) {
    await page.getByRole('tablist', { name: 'HUD board' }).getByRole('tab', { name: tab, exact: true }).click();
    const compact = page.getByRole('region', { name: `Ongoing work: ${entry!.title}`, exact: true });
    await expect(compact).toBeVisible();
    await expect(compact.getByRole('button', { name: 'View work', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('real-ongoing-compact.png') });
  const open = page.getByRole('region', { name: `Ongoing work: ${entry!.title}`, exact: true }).getByRole('button', { name: 'View work', exact: true });
  await open.focus();
  await open.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('hudgoal')).toBe(goal!.id);
  // Package goals use the approved draft/review/apply console. Its modal is
  // distinct from the generic ongoing summary retained for unpackaged goals.
  const detail = page.getByTestId('work-on-everything-console');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute('aria-label', 'Work on everything worklist');
  await expect(detail.getByRole('heading', { name: goal!.title, exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Plan the next pass.', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  // Read the collection's declaration before requiring rows: a retained legacy
  // instance without opt-in must truthfully report unavailability, never drive
  // an empty or silently fabricated draft. This profile performs no policy write.
  const detailResponse = await request.get('/api/zero-harness/rest-query', {
    params: { name: 'goals.detail', args: JSON.stringify({ workspaceId, goalId: goal!.id }) },
  });
  expect(detailResponse.ok(), 'The opened real goal detail must be readable').toBe(true);
  const realDetail = (await detailResponse.json()).rows[0];
  const selection = realDetail.goalData?.collections?.worklist?.selection;
  if (selection?.ok && selection.configured) {
    await expect(detail.getByRole('listbox', { name: 'Worklist draft' })).toBeVisible();
    await expect(detail.getByRole('textbox', { name: 'Search worklist', exact: true })).toBeVisible();
  } else {
    await expect(detail.getByRole('heading', { name: 'Worklist unavailable', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Refresh worklist', exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('real-ongoing-detail.png') });

  const healthAfter = await (await request.get('/api/health')).json();
  expect(healthAfter.sha, 'The runtime must not move during the acceptance journey').toBe(expectedSha);
  expect(healthAfter.bundleStale, 'The runtime must not fall back to a stale bundle during the journey').toBeUndefined();
  await info.attach('ongoing-real-data-receipt', {
    body: JSON.stringify({ expectedSha, actualSha: health.sha, workspaceId, goalId: goal!.id, packageRef: entry!.ref,
      views: ['featured', 'compact', 'worklist-detail'], collectionConfigured: !!(selection?.ok && selection.configured),
      navigationGoalId: new URL(page.url()).searchParams.get('hudgoal') }),
    contentType: 'application/json',
  });
  } finally {
    await info.attach('ongoing-real-data-diagnostics', {
      body: JSON.stringify({ workspaceId, url: page.url(), observations: diagnostics.slice(-40) }),
      contentType: 'application/json',
    });
  }
});

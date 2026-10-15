/** WI-10007847: real private project History data and actual archive/live journey. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { getOrgPg } from '@papercusp/db-org';
import { PLAN_STATUSES, type PlanStatus } from '@papercusp/plan-parser';

const PROJECT_HISTORY_SEED_STATUS: PlanStatus = 'active';

/** Run before private allocation: work-item terminal states are not plan states. */
export function verifyPrivateProjectHistorySeedStatus(status: string = PROJECT_HISTORY_SEED_STATUS) {
  assert.ok((PLAN_STATUSES as readonly string[]).includes(status), `Invalid private History plan status: ${status}`);
  return status;
}

export interface PrivateProjectHistorySeed {
  workspace: string;
  selected: string;
  neighbor: string;
  selectedPlans: string[];
  neighborPlan: string;
  foreignPlan: string;
  selectedItem: string;
  neighborItem: string;
  foreignItem: string;
  selectedTitle: string;
}

export async function seedPrivateProjectHistory(workspace: string, evidence: string, readonlyRepo: string): Promise<PrivateProjectHistorySeed> {
  assert.match(workspace, /^test-runtime-/);
  const status = verifyPrivateProjectHistorySeedStatus();
  const { mutateHarnessRegistry } = await import('../lib/harness-registry');
  const { createWorkItem } = await import('../lib/work-items');
  const { sql } = getOrgPg();
  const stem = `private-project-history-${process.pid}`;
  const selected = stem + '-selected';
  const neighbor = stem + '-neighbor';
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: selected, path: readonlyRepo }, { slug: neighbor, path: readonlyRepo }] }), workspace);
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: selected, path: readonlyRepo }] }), workspace + '-foreign');
  const selectedPlans = Array.from({ length: 21 }, (_, index) => `${selected}-${String(index).padStart(2, '0')}`);
  const neighborPlan = neighbor + '-plan';
  const foreignPlan = stem + '-foreign-plan';
  for (const [index, slug] of [...selectedPlans, neighborPlan, foreignPlan].entries()) {
    const scope = slug === foreignPlan ? workspace + '-foreign' : workspace;
    const harness = slug === neighborPlan ? neighbor : selected;
    const updated = new Date(Date.now() - index * 1_000).toISOString();
    const content = `---\nslug: ${slug}\ntitle: ${slug}\nstatus: ${status}\nupdated: ${updated}\n---\n\n## Now\nPrivate History archive canary.\n`;
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, updated, updated_at)
      VALUES (${scope}, ${harness}, ${slug}, ${slug}, ${status}, ${content},
        ${createHash('sha256').update(content).digest('hex')}, ${updated}, ${updated})`;
  }
  const selectedTitle = stem + '-selected-live';
  const selectedItem = await createWorkItem({ kind: 'feature', title: selectedTitle,
    harness: selected, workspaceId: workspace, createdBy: 'private-project-history-fixture' });
  const neighborItem = await createWorkItem({ kind: 'feature', title: stem + '-neighbor-live',
    harness: neighbor, workspaceId: workspace, createdBy: 'private-project-history-fixture' });
  const foreignItem = await createWorkItem({ kind: 'feature', title: stem + '-foreign-live',
    harness: selected, workspaceId: workspace + '-foreign', createdBy: 'private-project-history-fixture' });
  const seed = { workspace, selected, neighbor, selectedPlans, neighborPlan, foreignPlan,
    selectedItem: selectedItem.id, neighborItem: neighborItem.id, foreignItem: foreignItem.id, selectedTitle };
  writeFileSync(join(evidence, 'portal-project-history-seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export async function preflightPrivateProjectHistory(seed: PrivateProjectHistorySeed, base: string, cookie: string, evidence: string) {
  const archiveUrl = `${base}/api/harness/${seed.selected}/project-history?limit=20&offset=0`;
  const archive = await fetch(archiveUrl, { headers: { cookie }, signal: AbortSignal.timeout(25_000) });
  const archiveBody = await archive.json();
  const liveUrl = new URL('/api/zero-harness/rest-query', base);
  liveUrl.searchParams.set('name', 'projectHistoryEvents.byHarness');
  liveUrl.searchParams.set('args', JSON.stringify({ harnessSlug: seed.selected, limit: 100 }));
  const live = await fetch(liveUrl, { headers: { cookie }, signal: AbortSignal.timeout(25_000) });
  const liveBody = await live.json();
  writeFileSync(join(evidence, 'portal-project-history-preflight.json'), JSON.stringify({
    archive: { url: archiveUrl, status: archive.status, body: archiveBody },
    live: { url: liveUrl.href, status: live.status, body: liveBody } }, null, 2));
  assert.equal(archive.status, 200);
  assert.deepEqual(archiveBody.page, { count: 20, total: 21, offset: 0, limit: 20, hasMore: true });
  assert.deepEqual(archiveBody.plans.map((plan: { slug: string }) => plan.slug), seed.selectedPlans.slice(0, 20));
  assert.equal(live.status, 200);
  assert.ok(liveBody.rows.some((row: { subjectId: string }) => row.subjectId === seed.selectedItem));
  assert.ok(liveBody.rows.every((row: { harnessSlug: string; subjectId: string }) => row.harnessSlug === seed.selected
    && ![seed.neighborItem, seed.foreignItem].includes(row.subjectId)));
  console.log('ROSTER_STOP_HTTP_PHASE project-history-api-preflight-ready');
}

export async function runPrivateProjectHistoryPage(page: Page, context: BrowserContext,
  seed: PrivateProjectHistorySeed, url: URL, evidence: string) {
  const reads: Array<{ url: string; status: number; body: any }> = [];
  const denials: Array<{ surface: string; status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const writes: string[] = [];
  let denyArchive = true;
  let denyLive = false;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    const target = new URL(response.url());
    if (!target.pathname.endsWith('/project-history') && target.searchParams.get('name') !== 'projectHistoryEvents.byHarness') return;
    const task = response.json().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(evidence, 'portal-project-history-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/**', async route => {
    const target = new URL(route.request().url());
    const archive = target.pathname.endsWith('/project-history');
    const live = target.searchParams.get('name') === 'projectHistoryEvents.byHarness';
    if (!(archive && denyArchive) && !(live && denyLive)) { await route.continue(); return; }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-project-history.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403);
    assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ surface: archive ? 'archive' : 'live', status: upstream.status(), body });
    writeFileSync(join(evidence, 'portal-project-history-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  await page.goto(url.href);
  await page.getByRole('alert').filter({ hasText: 'History is unavailable.' }).waitFor();
  assert.equal(await page.locator('.build-plan-card').count(), 0);
  denyArchive = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Showing 20 of 21 plans.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load 1 more', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByText('Showing 21 of 21 plans.', { exact: true }).waitFor();
  await page.waitForURL(value => value.searchParams.get('historyPages') === '2');
  const archiveUrl = page.url();
  await page.reload();
  await page.getByText('Showing 21 of 21 plans.', { exact: true }).waitFor();
  assert.equal(page.url(), archiveUrl);
  assert.equal(await page.getByText(seed.neighborPlan, { exact: true }).count(), 0);
  assert.equal(await page.getByText(seed.foreignPlan, { exact: true }).count(), 0);
  await Promise.all([...pending]);
  const archiveReadsBeforeLive = reads.filter(read => new URL(read.url).pathname.endsWith('/project-history')).length;
  denyLive = true;
  await page.getByRole('tab', { name: 'Live activity', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Live activity is unavailable.' }).waitFor();
  denyLive = false;
  await page.reload();
  const row = page.locator('.atl-row').filter({ hasText: seed.selectedTitle }).first();
  await row.waitFor();
  await row.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(value => Boolean(value.searchParams.get('historyOpen')));
  assert.ok(new URL(page.url()).searchParams.get('historyOpen')!.includes(seed.selectedItem));
  const liveUrl = page.url();
  await page.reload();
  await page.locator('.atl-row[aria-expanded="true"]').filter({ hasText: seed.selectedTitle }).waitFor();
  assert.equal(page.url(), liveUrl);
  await Promise.all([...pending]);
  assert.equal(reads.filter(read => new URL(read.url).pathname.endsWith('/project-history')).length, archiveReadsBeforeLive,
    'switching to live and reloading must not request the archive');
  const liveReads = reads.filter(read => read.status === 200 && new URL(read.url).searchParams.get('name') === 'projectHistoryEvents.byHarness');
  assert.ok(liveReads.length >= 2);
  assert.ok(liveReads.every(read => read.body.rows.some((value: { subjectId: string }) => value.subjectId === seed.selectedItem)
    && read.body.rows.every((value: { harnessSlug: string; subjectId: string }) => value.harnessSlug === seed.selected
      && ![seed.foreignItem, seed.neighborItem].includes(value.subjectId))));
  const neighborUrl = new URL(url); neighborUrl.searchParams.set('slug', seed.neighbor);
  await page.goto(neighborUrl.href);
  await page.getByText('Showing 1 of 1 plan.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: seed.neighborPlan, exact: true }).waitFor();
  await Promise.all([...pending]);
  assert.ok(reads.some(read => read.status === 200 && new URL(read.url).searchParams.get('offset') === '20'
    && read.body.plans.length === 1 && read.body.plans[0].slug === seed.selectedPlans[20]));
  assert.ok(reads.some(read => read.status === 200 && new URL(read.url).searchParams.get('limit') === '40'
    && read.body.plans.length === 21));
  assert.ok(denials.some(value => value.surface === 'archive') && denials.some(value => value.surface === 'live'));
  assert.deepEqual(writes, [], 'history navigation must not write product data');
  assert.equal(new URL(page.url()).searchParams.get('ws'), seed.workspace);
  assert.equal(new URL(page.url()).searchParams.get('q'), 'retained-shell-search');
  return { workspace: seed.workspace, authMethod: 'private-loopback-project-history-with-cookie',
    archivePagination: true, archiveReload: true, liveSelectionReload: true, liveAvoidsArchive: true,
    keyboardControls: true, archiveDenialRecovery: true, liveDenialRecovery: true,
    neighborDistinct: true, foreignExcluded: true, noProductWrites: true,
    scope: 'Actual AdvHistoryTab and AdvScopeProvider with seeded private PG and real archive/sync APIs; Host policy denial, not hosted tenant or provider acceptance' };
}

/** Workflows acceptance reuses Calendar's private plan seed and the roster lifecycle. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { getOrgPg } from '@papercusp/db-org';
import { seedPrivateCalendar, type PrivateCalendarSeed } from './portal-calendar-fixture';

export type PrivateWorkflowsSeed = PrivateCalendarSeed;
const harness = 'private-calendar-harness';
const queryNames = ['plans.list', 'plans.schedule', 'plans.scheduledOccurrences'];
const rowId = (slug: string) => `wf-row:plan:${harness}:${slug}`;

/** The real polling client retries three times before exposing `error`.
 * Observe the completed responses, then give the UI its normal assertion
 * deadline. Request latency must not consume that UI deadline. Register before
 * the action; retain a rejection until the caller awaits it. */
export function observeWorkflowDenialCycle(page: Page): () => Promise<void> {
  let completed = 0;
  const result = page.waitForResponse(response => response.status() === 403
    && new URL(response.url()).searchParams.get('name') === 'plans.scheduledOccurrences'
    && ++completed === 4, { timeout: 45_000 }).then(() => null, error => error);
  return async () => { const error = await result; if (error) throw error; };
}

export async function seedPrivateWorkflows(workspace: string, evidence: string): Promise<PrivateWorkflowsSeed> {
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  const seed = await seedPrivateCalendar(workspace, evidence);
  const { sql } = getOrgPg();
  // Only disposable PG data changes; no scheduler or provider is launched.
  await sql`UPDATE harness_shared.harness_plans SET schedule_active = true
    WHERE workspace_id IN (${workspace}, ${workspace + '-foreign'})
      AND harness_slug = ${harness} AND plan_slug IN (${seed.selected}, ${seed.neighbor}, ${seed.foreign})`;
  writeFileSync(join(evidence, 'portal-workflows-seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export async function preflightPrivateWorkflows(seed: PrivateWorkflowsSeed, base: string, cookie: string, evidence: string) {
  const reads: Array<{ name: string; status: number; body: any }> = [];
  for (const name of queryNames) {
    const url = new URL('/api/zero-harness/rest-query', base);
    url.searchParams.set('name', name);
    url.searchParams.set('args', JSON.stringify(name === 'plans.scheduledOccurrences'
      ? { rangeStartMs: seed.occurrenceMs - 60_000, rangeEndMs: seed.occurrenceMs + 60_000 } : {}));
    const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(25_000) });
    const body = await response.json();
    reads.push({ name, status: response.status, body });
    writeFileSync(join(evidence, 'portal-workflows-preflight.json'), JSON.stringify(reads, null, 2));
    assert.equal(response.status, 200);
    const slugs = body.rows.map((row: { slug?: string; templateSlug?: string }) => row.templateSlug ?? row.slug);
    assert.deepEqual(slugs.sort(), [seed.selected, seed.neighbor].sort(), `${name} must resolve the actual private workspace`);
  }
  console.log('ROSTER_STOP_HTTP_PHASE workflows-api-preflight-ready');
}

export async function runPrivateWorkflowsPage(page: Page, context: BrowserContext,
  seed: PrivateWorkflowsSeed, url: URL, evidence: string) {
  const reads: Array<{ name: string; url: string; status: number; body: any; requestedAtMs: number; receivedAtMs: number }> = [];
  const requestTimes = new WeakMap<object, number>();
  const denials: Array<{ status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const writes: string[] = [];
  const stages: Array<{ stage: string; atMs: number; attached?: boolean; visible?: boolean }> = [];
  const mark = (stage: string, observation: { attached?: boolean; visible?: boolean } = {}) => {
    stages.push({ stage, atMs: Date.now(), ...observation });
    writeFileSync(join(evidence, 'portal-workflows-stages.json'), JSON.stringify(stages, null, 2));
  };
  let deny = true;
  page.on('request', request => {
    requestTimes.set(request, Date.now());
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    const name = new URL(response.url()).searchParams.get('name') ?? '';
    if (!queryNames.includes(name)) return;
    const task = response.json().then(body => {
      reads.push({ name, url: response.url(), status: response.status(), body,
        requestedAtMs: requestTimes.get(response.request()) ?? 0, receivedAtMs: Date.now() });
      writeFileSync(join(evidence, 'portal-workflows-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/**', async route => {
    if (!deny || new URL(route.request().url()).searchParams.get('name') !== 'plans.scheduledOccurrences') {
      await route.continue(); return;
    }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-workflows.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403);
    assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ status: upstream.status(), body });
    writeFileSync(join(evidence, 'portal-workflows-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  mark('navigation');
  const initialDenial = observeWorkflowDenialCycle(page);
  await page.goto(url.href);
  const selected = page.getByTestId(rowId(seed.selected));
  const neighbor = page.getByTestId(rowId(seed.neighbor));
  const alert = page.getByRole('alert').filter({ hasText: 'Upcoming scheduled runs are unavailable:' });
  await initialDenial();
  await alert.waitFor(); await selected.waitFor(); await neighbor.waitFor();
  await selected.getByText('Schedule unavailable', { exact: true }).waitFor();
  mark('initial-denial-visible');
  assert.equal(await page.getByTestId(rowId(seed.foreign)).count(), 0);
  deny = false;
  await alert.getByRole('button', { name: 'Retry schedule read', exact: true }).focus();
  await page.keyboard.press('Enter');
  await selected.getByText(/^in /).waitFor();
  await alert.waitFor({ state: 'detached' });
  mark('initial-retry-recovered');
  await selected.click();
  await page.getByRole('group', { name: 'Filter by kind', exact: true })
    .getByRole('button', { name: /^Triggered/ }).click();
  await page.getByRole('textbox', { name: 'Search workflows', exact: true }).fill(seed.selected);
  await page.waitForFunction(slug => new URL(location.href).searchParams.get('wfQ') === slug, seed.selected);
  const assertSelection = () => {
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('wfSelId'), `plan:${harness}:${seed.selected}`);
    assert.equal(params.get('wfQ'), seed.selected);
    assert.equal(params.get('wfKind'), 'triggered');
    assert.equal(params.get('ws'), seed.workspace);
    assert.equal(params.get('app'), 'workflows');
    assert.equal(params.get('q'), 'retained-shell-search');
  };
  assertSelection();
  await page.reload(); await selected.getByText(/^in /).waitFor(); assertSelection();
  mark('reload-recovered');
  assert.equal(await neighbor.count(), 0, 'workflow search must narrow the ledger');
  deny = true;
  await page.getByRole('button', { name: 'Refresh workflows', exact: true }).focus();
  mark('stale-refresh');
  const staleDenial = observeWorkflowDenialCycle(page);
  await page.keyboard.press('Enter');
  await staleDenial();
  mark('stale-refresh-denial-cycle-completed');
  try { await alert.waitFor(); }
  catch (error) {
    mark('stale-refresh-wait-failed', { attached: await alert.count() > 0, visible: await alert.isVisible() });
    throw error;
  }
  mark('stale-refresh-error-visible');
  await selected.getByText('Schedule unavailable', { exact: true }).waitFor();
  assert.equal(await selected.getByText(/^in /).count(), 0, 'denied refresh must withhold previously successful next-run data');
  assertSelection();
  deny = false;
  await alert.getByRole('button', { name: 'Retry schedule read', exact: true }).focus();
  await page.keyboard.press('Enter');
  await selected.getByText(/^in /).waitFor(); assertSelection();
  mark('stale-refresh-retry-recovered');
  await page.getByRole('textbox', { name: 'Search workflows', exact: true }).fill('');
  await neighbor.waitFor();
  await Promise.all([...pending]);
  assert.ok(denials.length >= 2, 'initial and stale refresh must observe the real Host guard');
  for (const name of queryNames) {
    const success = reads.filter(read => read.name === name && read.status === 200);
    assert.ok(success.length > 0, `actual private ${name} response must be captured`);
    assert.ok(success.every(read => read.body.rows.every((row: { slug?: string; templateSlug?: string }) =>
      [seed.selected, seed.neighbor].includes(row.templateSlug ?? row.slug ?? ''))));
  }
  const occurrenceRead = reads.find(read => read.name === 'plans.scheduledOccurrences' && read.status === 200)!;
  const foreign = await context.request.get(occurrenceRead.url, { headers: { 'x-papercusp-workspace': seed.workspace + '-foreign' } });
  assert.equal(foreign.status(), 200);
  const foreignBody = await foreign.json();
  writeFileSync(join(evidence, 'portal-workflows-foreign-control.json'), JSON.stringify(foreignBody, null, 2));
  assert.deepEqual(foreignBody.rows.map((row: { templateSlug: string }) => row.templateSlug), [seed.foreign]);
  assert.deepEqual(writes, [], 'read/filter/select/reload must not author, arm or fire schedules');
  return { workspace: seed.workspace, authMethod: 'private-loopback-workflows-with-cookie',
    occurrenceDenialRecovery: true, staleNextRunWithheld: true, keyboardRetry: true, keyboardRefresh: true,
    filterAndSelectionReload: true, neighborPresent: true, foreignExcluded: true, foreignWorkspaceControl: true,
    noProductWrites: true };
}

/** Private Calendar data and acceptance; shares the existing operator/browser lifecycle. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { getOrgPg } from '@papercusp/db-org';

export interface PrivateCalendarSeed {
  workspace: string;
  selected: string;
  neighbor: string;
  foreign: string;
  occurrenceMs: number;
}

export async function seedPrivateCalendar(workspace: string, evidence: string): Promise<PrivateCalendarSeed> {
  assert.match(workspace, /^test-runtime-/);
  const stem = `private-calendar-${process.pid}`;
  const seed = { workspace, selected: stem + '-selected', neighbor: stem + '-neighbor',
    foreign: stem + '-foreign', occurrenceMs: Date.now() + 60 * 60_000 };
  const { sql } = getOrgPg();
  for (const slug of [seed.selected, seed.neighbor, seed.foreign]) {
    const scope = slug === seed.foreign ? workspace + '-foreign' : workspace;
    const content = `---\nslug: ${slug}\ntitle: ${slug}\nstatus: active\n---\n\nPrivate disarmed calendar canary.\n`;
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, scheduled_at, schedule_active)
      VALUES (${scope}, 'private-calendar-harness', ${slug}, ${slug}, 'active', ${content},
        ${createHash('sha256').update(content).digest('hex')}, ${new Date(seed.occurrenceMs)}, false)`;
  }
  writeFileSync(join(evidence, 'portal-calendar-seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export async function preflightPrivateCalendar(seed: PrivateCalendarSeed, base: string, cookie: string, evidence: string) {
  const url = new URL('/api/zero-harness/rest-query', base);
  url.searchParams.set('name', 'plans.scheduledOccurrences');
  url.searchParams.set('args', JSON.stringify({ rangeStartMs: seed.occurrenceMs - 60_000, rangeEndMs: seed.occurrenceMs + 60_000 }));
  const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(25_000) });
  const body = await response.json();
  writeFileSync(join(evidence, 'portal-calendar-preflight.json'), JSON.stringify({ status: response.status, body }, null, 2));
  assert.equal(response.status, 200);
  assert.deepEqual(body.rows.map((row: { templateSlug: string }) => row.templateSlug).sort(), [seed.selected, seed.neighbor].sort());
  assert.ok(body.rows.every((row: { scheduleActive: boolean; occurrenceMs: number }) => row.scheduleActive === false
    && row.occurrenceMs === seed.occurrenceMs));
  console.log('ROSTER_STOP_HTTP_PHASE calendar-api-preflight-ready');
}

export async function runPrivateCalendarPage(page: Page, context: BrowserContext,
  seed: PrivateCalendarSeed, url: URL, evidence: string) {
  const reads: Array<{ url: string; status: number; body: any }> = [];
  const denials: Array<{ status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const writes: string[] = [];
  let deny = true;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    if (new URL(response.url()).searchParams.get('name') !== 'plans.scheduledOccurrences') return;
    const task = response.json().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(evidence, 'portal-calendar-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/**', async route => {
    if (!deny || new URL(route.request().url()).searchParams.get('name') !== 'plans.scheduledOccurrences') {
      await route.continue(); return;
    }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-calendar.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403);
    assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ status: upstream.status(), body });
    writeFileSync(join(evidence, 'portal-calendar-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  await page.goto(url.href);
  const calendarAlert = page.getByRole('alert').filter({ hasText: 'Calendar is unavailable.' });
  const routinesAlert = page.getByRole('alert').filter({ hasText: 'Scheduled routines are unavailable.' });
  await calendarAlert.waitFor(); await routinesAlert.waitFor();
  assert.equal(await page.getByLabel('Calendar occurrence summary').count(), 0);
  assert.equal(await page.getByText(/No routines scheduled/).count(), 0);
  deny = false;
  await calendarAlert.getByRole('button', { name: 'Try again', exact: true }).focus();
  await page.keyboard.press('Enter');
  await routinesAlert.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByLabel('Calendar occurrence summary').getByText('2 in view', { exact: true }).waitFor();
  await page.locator('.pc-routines').getByText('2 scheduled', { exact: true }).waitFor();
  const selectedEvent = page.locator('.pc-sched-cal__main .fc-event').filter({ hasText: seed.selected }).first();
  await selectedEvent.click();
  await page.locator('.pc-sched-cal__aside h3').getByText(seed.selected, { exact: true }).waitFor();
  const selectedParams = new URL(page.url()).searchParams;
  assert.equal(selectedParams.get('calPlan'), seed.selected);
  assert.equal(selectedParams.get('app'), 'calendar');
  assert.equal(selectedParams.get('q'), 'retained-shell-search');
  assert.equal(selectedParams.get('ws'), seed.workspace);
  await page.reload();
  await page.locator('.pc-sched-cal__aside h3').getByText(seed.selected, { exact: true }).waitFor();
  await page.locator('.pc-routines').getByText(seed.neighbor, { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.foreign, { exact: true }).count(), 0);
  await Promise.all([...pending]);
  assert.ok(denials.length >= 2, 'both occurrence consumers must observe the actual Host guard');
  const success = reads.filter(read => read.status === 200);
  assert.ok(success.length >= 2, 'both windows must read the actual private API');
  assert.ok(success.every(read => read.body.rows.every((row: { templateSlug: string }) =>
    [seed.selected, seed.neighbor].includes(row.templateSlug))), 'foreign plan must be excluded by workspace resolution');
  assert.deepEqual(writes, [], 'read/select/reload must not author or arm schedules');
  return { workspace: seed.workspace, authMethod: 'private-loopback-calendar-with-cookie',
    calendarDenialRecovery: true, routinesDenialRecovery: true, keyboardRetry: true,
    selectedPlanReload: true, neighborPresent: true, foreignExcluded: true, noProductWrites: true };
}

/** Scoped Retain reads against the existing disposable operator/browser. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { getOrgPg } from '@papercusp/db-org';
import { mutateHarnessRegistry } from '../lib/harness-registry';

export interface PrivateLearningSeed {
  workspace: string; hive: string;
  selected: { id: string; text: string }; neighbor: { id: string; text: string };
  foreign: { id: string; text: string };
}

export async function seedPrivateLearning(workspace: string, evidence: string): Promise<PrivateLearningSeed> {
  assert.match(workspace, /^test-runtime-/);
  const stem = `private-learning-${process.pid}`;
  const seed = { workspace, hive: stem + '-hive',
    selected: { id: randomUUID(), text: stem + ' selected retained memory' },
    neighbor: { id: randomUUID(), text: stem + ' neighbor retained memory' },
    foreign: { id: randomUUID(), text: stem + ' foreign retained memory' } };
  const path = join(evidence, 'learning-hive');
  mkdirSync(join(path, '.papercusp'), { recursive: true });
  await mutateHarnessRegistry(reg => ({ ...reg,
    projects: [...reg.projects, { slug: seed.hive, path, harness_kind: 'hive' }] }), workspace);
  const { sql } = getOrgPg();
  for (const row of [seed.selected, seed.neighbor, seed.foreign]) {
    const foreign = row.id === seed.foreign.id;
    const payload = { data: row.text, user_id: 'hive:' + seed.hive + (foreign ? '-foreign' : ''),
      workspace_id: workspace + (foreign ? '-foreign' : ''), kind: 'learning', created_by: 'private-test' };
    // row_kind is GENERATED from payload (migration 757); writers set base columns only.
    await sql`INSERT INTO harness_shared.memory_canonical (id, payload)
      VALUES (${row.id}::uuid, ${JSON.stringify(payload)}::jsonb)`;
  }
  writeFileSync(join(evidence, 'portal-learning-seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export async function preflightPrivateLearning(seed: PrivateLearningSeed, base: string, cookie: string, evidence: string) {
  const reads: Array<{ name: string; status: number; body: any }> = [];
  for (const [name, args] of [
    ['learning.retainFeed', { hive: seed.hive, tab: 'memories' }],
    ['learning.retainFeed.summary', { hive: seed.hive, tab: 'memories' }],
    ['learning.retainCounts', { hive: seed.hive }],
    ['learning.retainDetail', { hive: seed.hive, kind: 'memory', id: seed.selected.id }],
  ] as const) {
    const url = new URL('/api/zero-harness/rest-query', base);
    url.searchParams.set('name', name); url.searchParams.set('args', JSON.stringify(args));
    const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(25_000) });
    reads.push({ name, status: response.status, body: await response.json() });
    writeFileSync(join(evidence, 'portal-learning-preflight.json'), JSON.stringify(reads, null, 2));
    assert.equal(response.status, 200, name);
  }
  assert.deepEqual(reads[0].body.rows[0].rows.map((row: { id: string }) => row.id).sort(),
    [seed.selected.id, seed.neighbor.id].sort());
  assert.deepEqual(reads[0].body.rows[0].degraded, []);
  assert.equal(reads[1].body.rows[0].total, 2); assert.equal(reads[1].body.rows[0].matched, 2);
  assert.equal(reads[2].body.rows[0].memories, 2);
  const detail = reads[3].body.rows?.[0];
  assert.ok(detail, 'Learning detail prerequisite failed: the selected canonical memory exists in the feed, but detail returned no row; inspect the retained API response and backend-availability log before another private run');
  assert.equal(detail.body, seed.selected.text);
  console.log('ROSTER_STOP_HTTP_PHASE learning-api-preflight-ready');
}

export async function runPrivateLearningPage(page: Page, context: BrowserContext,
  seed: PrivateLearningSeed, url: URL, evidence: string) {
  const reads: Array<{ name: string; url: string; status: number; body: any }> = [];
  const denials: Array<{ name: string; status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const writes: string[] = [];
  let denyFeed = true; let denyDetail = false;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    const name = new URL(response.url()).searchParams.get('name');
    if (!name?.startsWith('learning.retain')) return;
    const task = response.json().then(body => {
      reads.push({ name, url: response.url(), status: response.status(), body });
      writeFileSync(join(evidence, 'portal-learning-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/**', async route => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    if (!(denyFeed && (name === 'learning.retainFeed' || name === 'learning.retainFeed.summary'))
      && !(denyDetail && name === 'learning.retainDetail')) { await route.continue(); return; }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-learning.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403); assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ name, status: upstream.status(), body });
    writeFileSync(join(evidence, 'portal-learning-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  url.searchParams.set('slug', seed.hive); url.searchParams.set('lview', 'learnings');
  url.searchParams.set('rtab', 'memories');
  await page.goto(url.href);
  const ledger = page.getByRole('region', { name: 'Retained ledger', exact: true });
  await ledger.getByText(/Could not load the retained ledger:/).waitFor();
  assert.equal(await ledger.getByText(seed.selected.text, { exact: true }).count(), 0);
  denyFeed = false;
  await ledger.getByRole('button', { name: 'Refresh retained ledger' }).focus(); await page.keyboard.press('Enter');
  await ledger.getByText(seed.selected.text, { exact: true }).waitFor();
  await ledger.getByText(seed.neighbor.text, { exact: true }).waitFor();
  assert.equal(await ledger.getByText(seed.foreign.text, { exact: true }).count(), 0);
  await ledger.getByRole('tab', { name: /^Memories/ }).focus(); await page.keyboard.press('Enter');
  await ledger.getByRole('textbox', { name: 'Filter retained items' }).fill(seed.selected.text);
  await page.waitForURL(value => value.searchParams.get('rq') === seed.selected.text);
  await page.waitForFunction(text => !document.querySelector('.pc-learning__retained')?.textContent?.includes(text), seed.neighbor.text);
  denyDetail = true;
  await ledger.getByText(seed.selected.text, { exact: true }).click();
  await page.getByRole('complementary', { name: 'Retained item detail' }).getByText(/Detail unavailable.*HTTP 403/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('rsel'), 'memory:' + seed.selected.id);
  denyDetail = false;
  await page.reload();
  await page.getByRole('complementary', { name: 'Retained item detail' }).locator('p').getByText(seed.selected.text, { exact: true }).waitFor();
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get('slug'), seed.hive); assert.equal(params.get('lview'), 'learnings');
  assert.equal(params.get('rtab'), 'memories'); assert.equal(params.get('rq'), seed.selected.text);
  assert.equal(params.get('ws'), seed.workspace); assert.equal(params.get('q'), 'retained-shell-search');
  await Promise.all([...pending]);
  for (const name of ['learning.retainFeed', 'learning.retainFeed.summary', 'learning.retainCounts', 'learning.retainDetail'])
    assert.ok(reads.some(read => read.name === name && read.status === 200), 'actual private read: ' + name);
  const filteredSummary = reads.find(read => read.name === 'learning.retainFeed.summary' && read.status === 200
    && JSON.parse(new URL(read.url).searchParams.get('args')!).q === seed.selected.text);
  assert.equal(filteredSummary?.body.rows[0].matched, 1); assert.equal(filteredSummary?.body.rows[0].total, 2);
  assert.ok(denials.some(read => read.name === 'learning.retainFeed'));
  assert.ok(denials.some(read => read.name === 'learning.retainDetail'));
  assert.deepEqual(writes, [], 'Retain browsing must not edit or remove memory');
  return { workspace: seed.workspace, authMethod: 'private-loopback-retain-with-cookie',
    feedDenialRecovery: true, detailDenialRecovery: true, keyboardRefresh: true, filterAndDetailReload: true,
    exactScopedCounts: true, neighborPresent: true, foreignPoolExcluded: true, noProductWrites: true };
}

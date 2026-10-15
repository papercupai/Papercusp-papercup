/** Stats uses the maintained private registry/API/browser lifecycle and read-only repositories. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { mutateHarnessRegistry } from '../lib/harness-registry';
import type { GitStats } from '../lib/harness/git-stats';

export interface PrivateStatsSeed {
  workspace: string; selected: string; neighbor: string; foreign: string; readonlyRepo: string;
}

export async function seedPrivateStats(workspace: string, evidence: string, readonlyRepo: string): Promise<PrivateStatsSeed> {
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  const stem = `private-stats-${process.pid}`;
  const seed = { workspace, selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-foreign', readonlyRepo };
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: seed.selected, path: readonlyRepo }, { slug: seed.neighbor, path: evidence }] }), workspace);
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: seed.foreign, path: readonlyRepo }] }), workspace + '-foreign');
  writeFileSync(join(evidence, 'portal-stats-seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export async function preflightPrivateStats(seed: PrivateStatsSeed, base: string, ownCookie: string,
  foreignCookie: string, evidence: string) {
  const reads: Array<{ slug: string; foreignCookie: boolean; workspaceHeader: string | null; status: number; body: any }> = [];
  // Native loopback Git reads select their workspace through the window
  // header, not through a cookie. Keep the cookie-only foreign denial as a
  // separate control so a process-global fallback cannot look like selection.
  for (const [slug, cookie, workspaceHeader] of [[seed.selected, ownCookie, null], [seed.neighbor, ownCookie, null],
    [seed.foreign, ownCookie, null], [seed.foreign, foreignCookie, seed.workspace + '-foreign'],
    [seed.foreign, foreignCookie, null]] as const) {
    const response = await fetch(new URL(`/api/harness/${slug}/git/stats`, base), {
      headers: { cookie, ...(workspaceHeader ? { 'x-papercusp-workspace': workspaceHeader } : {}) },
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json();
    reads.push({ slug, foreignCookie: cookie === foreignCookie, workspaceHeader, status: response.status, body });
    writeFileSync(join(evidence, 'portal-stats-preflight.json'), JSON.stringify(reads, null, 2));
    if (slug === seed.foreign && !workspaceHeader) { assert.equal(response.status, 404); continue; }
    assert.equal(response.status, 200);
    if (slug === seed.neighbor) { assert.equal(body.notAGitRepo, true); continue; }
    assert.match(body.stats.repository.head, /^[a-f0-9]{40}$/);
    // Validate the actual API's measured commit against its real repository.
    // Git-sync may advance HEAD during the run; the recorded commit remains valid.
    assert.equal(execFileSync('git', ['cat-file', '-t', body.stats.repository.head],
      { cwd: seed.readonlyRepo, encoding: 'utf8', timeout: 15_000 }).trim(), 'commit');
    assert.ok(body.stats.footprint.trackedFiles > 0);
  }
  console.log('ROSTER_STOP_HTTP_PHASE stats-api-preflight-ready');
}

export async function runPrivateStatsPage(page: Page, context: BrowserContext,
  seed: PrivateStatsSeed, url: URL, evidence: string) {
  const reads: Array<{ url: string; status: number; body: any }> = [];
  const denials: Array<{ status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const writes: string[] = [];
  let deny = true;
  const isStats = (value: string) => new URL(value).pathname.endsWith('/git/stats');
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url());
  });
  page.on('response', response => {
    if (!isStats(response.url())) return;
    const task = response.json().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(evidence, 'portal-stats-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/**', async route => {
    if (!deny || !isStats(route.request().url())) { await route.continue(); return; }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-stats.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403); assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ status: upstream.status(), body });
    writeFileSync(join(evidence, 'portal-stats-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  url.searchParams.set('app', 'stats'); url.searchParams.set('slug', seed.selected);
  url.searchParams.set('q', 'retained-shell-search');
  await page.goto(url.href);
  await page.getByText('Could not load Git statistics.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Repository summary').count(), 0);
  deny = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByLabel('Repository summary').waitFor({ timeout: 90_000 });
  await Promise.all([...pending]);
  const first = reads.find(read => read.status === 200 && read.body.stats)?.body.stats as GitStats;
  assert.ok(first?.repository.head);
  await page.getByText(first.repository.head.slice(0, 10), { exact: true }).waitFor();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  deny = true;
  await refresh.focus(); await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Showing the last measurement.' }).waitFor();
  await page.getByText(first.repository.head.slice(0, 10), { exact: true }).waitFor();
  deny = false;
  await refresh.focus(); await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Showing the last measurement.' }).waitFor({ state: 'detached' });
  const query = () => {
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('app'), 'stats'); assert.equal(params.get('slug'), seed.selected);
    assert.equal(params.get('ws'), seed.workspace); assert.equal(params.get('q'), 'retained-shell-search');
  };
  query(); await page.reload(); await page.getByLabel('Repository summary').waitFor({ timeout: 90_000 }); query();
  const neighbor = new URL(page.url()); neighbor.searchParams.set('slug', seed.neighbor);
  await page.goto(neighbor.href);
  await page.getByText(`${seed.neighbor} is not a Git repository.`, { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Repository summary').count(), 0);
  await page.goto(url.href); await page.getByLabel('Repository summary').waitFor({ timeout: 90_000 }); query();
  await Promise.all([...pending]);
  assert.ok(denials.length >= 2);
  assert.ok(reads.some(read => read.status === 200 && new URL(read.url).searchParams.get('refresh') === '1'));
  assert.equal(reads.some(read => new URL(read.url).pathname.includes(seed.foreign)), false);
  assert.deepEqual(writes, []);
  await page.screenshot({ path: join(evidence, 'portal-stats-browser.png'), animations: 'disabled' });
  return { workspace: seed.workspace, authMethod: 'private-loopback-stats-with-cookie',
    initialDenialRecovery: true, staleMeasurementRetained: true, keyboardRefresh: true, scopeReload: true,
    neighborNotGitControl: true, foreignExcluded: true, noProductWrites: true };
}

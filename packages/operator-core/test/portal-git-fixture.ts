/** Git reuses the private registry/API/browser lifecycle with read-only repositories. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { mutateHarnessRegistry } from '../lib/harness-registry';

export interface PrivateGitSeed {
  workspace: string; selected: string; neighbor: string; foreign: string; readonlyRepo: string;
  commit?: { sha: string; subject: string; patchSha256: string };
}

export async function seedPrivateGit(workspace: string, evidence: string, readonlyRepo: string): Promise<PrivateGitSeed> {
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  const stem = `private-git-${process.pid}`;
  const seed = { workspace, selected: stem + '-selected', neighbor: stem + '-neighbor', foreign: stem + '-foreign', readonlyRepo };
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: seed.selected, path: readonlyRepo }, { slug: seed.neighbor, path: evidence }] }), workspace);
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects,
    { slug: seed.foreign, path: readonlyRepo }] }), workspace + '-foreign');
  writeFileSync(join(evidence, 'portal-git-seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export async function preflightPrivateGit(seed: PrivateGitSeed, base: string, ownCookie: string,
  foreignCookie: string, evidence: string) {
  const reads: Array<{ slug: string; workspaceHeader: string | null; path: string; status: number; body: any }> = [];
  const get = async (slug: string, path: string, cookie = ownCookie, workspaceHeader: string | null = null) => {
    const response = await fetch(new URL(`/api/harness/${slug}/git/${path}`, base), {
      headers: { cookie, ...(workspaceHeader ? { 'x-papercusp-workspace': workspaceHeader } : {}) },
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json();
    reads.push({ slug, workspaceHeader, path, status: response.status, body });
    writeFileSync(join(evidence, 'portal-git-preflight.json'), JSON.stringify(reads, null, 2));
    return { status: response.status, body };
  };
  const selected = await get(seed.selected, 'log?limit=100');
  assert.equal(selected.status, 200); assert.ok(selected.body.commits.length > 0);
  for (const commit of selected.body.commits.slice(0, 8)) {
    const shown = await get(seed.selected, 'show/' + commit.sha);
    assert.equal(shown.status, 200); assert.equal(shown.body.sha, commit.sha);
    assert.equal(shown.body.subject, commit.subject);
    assert.equal(execFileSync('git', ['cat-file', '-t', commit.sha],
      { cwd: seed.readonlyRepo, encoding: 'utf8', timeout: 15_000 }).trim(), 'commit');
    if (shown.body.patch.includes('diff --git ') && shown.body.patch.length < 512_000 && !shown.body.patchTruncated) {
      seed.commit = { sha: commit.sha, subject: commit.subject,
        patchSha256: createHash('sha256').update(shown.body.patch).digest('hex') };
      break;
    }
  }
  assert.ok(seed.commit, 'the actual repository must supply a bounded nonempty commit diff before Chrome allocation');
  const worktrees = await get(seed.selected, 'worktrees');
  assert.equal(worktrees.status, 200); assert.ok(worktrees.body.worktrees.length > 0);
  const neighbor = await get(seed.neighbor, 'log');
  assert.equal(neighbor.status, 200); assert.equal(neighbor.body.notAGitRepo, true); assert.deepEqual(neighbor.body.commits, []);
  for (const path of ['log', 'worktrees', 'show/' + seed.commit.sha]) {
    assert.equal((await get(seed.foreign, path)).status, 404);
    assert.equal((await get(seed.foreign, path, foreignCookie)).status, 404);
    assert.equal((await get(seed.foreign, path, foreignCookie, seed.workspace + '-foreign')).status, 200);
  }
  writeFileSync(join(evidence, 'portal-git-seed.json'), JSON.stringify(seed, null, 2));
  console.log('ROSTER_STOP_HTTP_PHASE git-api-preflight-ready');
}

export async function runPrivateGitPage(page: Page, context: BrowserContext, seed: PrivateGitSeed,
  url: URL, evidence: string) {
  assert.ok(seed.commit);
  const commit = seed.commit;
  const reads: Array<{ url: string; status: number; body: any }> = [];
  const denials: Array<{ url: string; status: number; body: any }> = [];
  const pending = new Set<Promise<void>>();
  const gitWrites: string[] = [];
  let deny = true;
  const isGit = (value: string) => new URL(value).pathname.includes('/git/');
  page.on('request', request => { if (isGit(request.url()) && request.method() !== 'GET') gitWrites.push(request.url()); });
  page.on('response', response => {
    if (!isGit(response.url())) return;
    const task = response.json().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(evidence, 'portal-git-reads.json'), JSON.stringify(reads, null, 2));
    });
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
  });
  await context.route('**/api/**', async route => {
    if (!deny || !new URL(route.request().url()).pathname.endsWith('/git/log')) { await route.continue(); return; }
    const upstream = await context.request.get(route.request().url(), { headers: { host: 'foreign-git.invalid' } });
    const body = await upstream.json();
    assert.equal(upstream.status(), 403); assert.equal(body.error?.code, 'host_not_allowed');
    denials.push({ url: route.request().url(), status: upstream.status(), body });
    writeFileSync(join(evidence, 'portal-git-denials.json'), JSON.stringify(denials, null, 2));
    await route.fulfill({ response: upstream });
  });
  url.searchParams.set('app', 'git'); url.searchParams.set('slug', seed.selected);
  url.searchParams.set('q', 'retained-shell-search');
  await page.goto(url.href);
  const graph = page.locator('.pc-adv-gitgrid');
  await graph.locator('.pc-adv-gitgrid__empty--err').waitFor({ timeout: 90_000 });
  assert.equal(await page.getByLabel('Commit diff').count(), 0);
  deny = false;
  await graph.getByRole('button', { name: 'Refresh git log', exact: true }).click();
  const search = graph.getByPlaceholder('Search SHA, message, author, ref…');
  await search.fill(commit.sha);
  const shaCell = graph.locator('.pc-adv-gitgrid__sha').filter({ hasText: commit.sha.slice(0, 8) });
  await shaCell.waitFor({ timeout: 90_000 });
  await shaCell.click();
  const detail = page.getByLabel('Commit diff');
  await detail.getByText(commit.subject, { exact: true }).waitFor({ timeout: 90_000 });
  await Promise.all([...pending]);
  const shown = reads.find(read => read.status === 200 && new URL(read.url).pathname.endsWith('/show/' + commit.sha));
  assert.ok(shown); assert.equal(shown.body.sha, commit.sha);
  assert.equal(createHash('sha256').update(shown.body.patch).digest('hex'), commit.patchSha256);
  assert.ok(await detail.locator('.h-git-file-head').count() > 0, 'actual parsed file diff must render');
  const query = () => {
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('app'), 'git'); assert.equal(params.get('slug'), seed.selected);
    assert.equal(params.get('ws'), seed.workspace); assert.equal(params.get('q'), 'retained-shell-search');
    assert.equal(params.get('commit'), commit.sha);
  };
  query(); await page.reload();
  await page.getByLabel('Commit diff').getByText(commit.subject, { exact: true }).waitFor({ timeout: 90_000 }); query();
  const neighbor = new URL(page.url()); neighbor.searchParams.set('slug', seed.neighbor); neighbor.searchParams.delete('commit');
  await page.goto(neighbor.href);
  await page.locator('.pc-adv-gitgrid').getByText('No commits match this view.', { exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(await page.getByLabel('Commit diff').count(), 0);
  await page.goto(url.href); await page.locator('.pc-adv-gitgrid__search').fill(commit.sha);
  await page.locator('.pc-adv-gitgrid__sha').filter({ hasText: commit.sha.slice(0, 8) }).waitFor({ timeout: 90_000 });
  await Promise.all([...pending]);
  assert.ok(denials.length > 0);
  assert.equal(reads.some(read => new URL(read.url).pathname.includes(seed.foreign)), false);
  assert.deepEqual(gitWrites, []);
  await page.screenshot({ path: join(evidence, 'portal-git-browser.png'), animations: 'disabled' });
  return { workspace: seed.workspace, authMethod: 'private-loopback-git-with-cookie',
    initialDenialRecovery: true, actualCommitDiff: true, commitSha: commit.sha, patchSha256: commit.patchSha256,
    dockReload: true, commitReload: true, search: true, neighborNotGitControl: true, foreignExcluded: true,
    noGitWrites: true };
}

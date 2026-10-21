/**
 * nested-pot-checkouts.integration.test.ts — WI-6554700010018602.
 *
 * A submodule that is ALSO another pot's checkout (with its own git-sync) is published by
 * that pot, never by the enclosing superproject's git-sync. Real bare repos: the
 * superproject's origin and the submodule's origin. The control case runs the identical
 * tick WITHOUT `nestedPotCheckouts` and shows the pre-fix double-publish, so the guard
 * assertions are tied to the config and not to the topology.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectChildOutput } from '../../child-output';
import { runGitSync, type GitSyncConfig, type RunGit } from './run-git-sync';

/** Real git, fleet hooks off; file transport allowed so local submodules can be cloned. */
const testRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    delete env.GIT_CONFIG;
    const child = spawn('git', ['-c', 'core.hooksPath=/nonexistent', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      env,
    });
    const output = collectChildOutput(child);
    child.on('error', (e) => resolve({ code: -1, stdout: output.stdout.text(), stderr: output.stderr.text() + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: output.stdout.text(), stderr: output.stderr.text() }));
  });

async function git(args: string[], cwd: string): Promise<string> {
  const r = await testRunGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'nested-it@example.com'], dir);
  await git(['config', 'user.name', 'nested pot integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

const isAncestor = async (repo: string, ancestor: string, of: string): Promise<boolean> =>
  (await testRunGit(['merge-base', '--is-ancestor', ancestor, of], repo)).code === 0;

let tmpRoot: string;

async function seedBare(name: string, file: string, extra?: (dir: string) => Promise<void>): Promise<string> {
  const bare = join(tmpRoot, `${name}.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], bare);
  const seed = join(tmpRoot, `${name}-seed`);
  await git(['clone', bare, seed], tmpRoot);
  await configRepo(seed);
  await writeFile(join(seed, file), `${name}\n`);
  if (extra) await extra(seed);
  await git(['add', '-A'], seed);
  await git(['commit', '--no-verify', '-m', `seed ${name}`], seed);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], seed);
  return bare;
}

interface Topology {
  superOrigin: string;
  subOrigin: string;
  work: string;
  sub: string;
  pinned: string;
}

/** Superproject with submodule `apps/drill`; the nested pot's checkout sits on `main`. */
async function makeTopology(): Promise<Topology> {
  const subOrigin = await seedBare('sub-origin', 'drill.txt');
  const superOrigin = await seedBare('super-origin', 'app.txt', async (seed) => {
    await git(['submodule', 'add', subOrigin, 'apps/drill'], seed);
  });
  const work = join(tmpRoot, 'work');
  await git(['clone', '--recurse-submodules', superOrigin, work], tmpRoot);
  await configRepo(work);
  const sub = join(work, 'apps/drill');
  await configRepo(sub);
  await git(['checkout', '-B', 'main', 'origin/main'], sub);
  const pinned = await git(['rev-parse', 'HEAD'], sub);
  return { superOrigin, subOrigin, work, sub, pinned };
}

/** The nested pot's OWN git-sync committed a fix locally; nothing published it yet. */
async function nestedPotCommits(t: Topology): Promise<string> {
  await writeFile(join(t.sub, 'fix.txt'), 'nested pot fix\n');
  await git(['add', 'fix.txt'], t.sub);
  await git(['commit', '--no-verify', '-m', 'nested pot fix'], t.sub);
  return git(['rev-parse', 'HEAD'], t.sub);
}

async function tick(t: Topology, nestedPotCheckouts?: string[]) {
  const config: GitSyncConfig = { branch: 'main', push: true, ...(nestedPotCheckouts ? { nestedPotCheckouts } : {}) };
  return runGitSync('enclosing', { runGit: testRunGit, repoPath: t.work, config });
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'nested-pot-it-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('nested pot checkout inside an enclosing git-sync tree (WI-6554700010018602)', () => {
  it('control: WITHOUT nestedPotCheckouts the enclosing tick publishes the nested commit to the submodule origin', async () => {
    const t = await makeTopology();
    const fix = await nestedPotCommits(t);
    const outcome = await tick(t);
    expect(outcome.status).not.toBe('error');
    expect(await isAncestor(t.subOrigin, fix, 'main')).toBe(true);
  });

  it('never pushes, commits or pins the nested checkout while its HEAD is on no origin ref', async () => {
    const t = await makeTopology();
    const fix = await nestedPotCommits(t);
    // An in-flight edit the nested pot has not committed yet.
    await writeFile(join(t.sub, 'wip.txt'), 'nested pot wip\n');
    await writeFile(join(t.work, 'app-fix.txt'), 'enclosing fix\n');
    const subOriginMain = await git(['rev-parse', 'main'], t.subOrigin);

    const outcome = await tick(t, ['apps/drill']);
    expect(outcome.status).not.toBe('error');

    // The submodule origin did not move and never received the nested pot's commit.
    expect(await git(['rev-parse', 'main'], t.subOrigin)).toBe(subOriginMain);
    expect((await testRunGit(['cat-file', '-e', `${fix}^{commit}`], t.subOrigin)).code).not.toBe(0);
    // Inside the nested checkout nothing was committed, merged or reset.
    expect(await git(['rev-parse', 'HEAD'], t.sub)).toBe(fix);
    expect(await git(['status', '--porcelain'], t.sub)).toContain('wip.txt');
    // The enclosing pot still published its OWN change, with the gitlink held at the pin.
    const superMain = await git(['rev-parse', 'main'], t.superOrigin);
    expect(await git(['show', `${superMain}:app-fix.txt`], t.superOrigin)).toBe('enclosing fix');
    expect(await git(['rev-parse', `${superMain}:apps/drill`], t.superOrigin)).toBe(t.pinned);
  });

  it('stages the gitlink once the nested pot’s own route has put its HEAD on origin', async () => {
    const t = await makeTopology();
    const fix = await nestedPotCommits(t);
    // The nested pot's delivery route lands the fix on the submodule origin (a merged PR).
    await git(['push', '--no-verify', 'origin', 'main'], t.sub);
    await git(['fetch', 'origin'], t.sub);

    const outcome = await tick(t, ['apps/drill']);
    expect(outcome.status).not.toBe('error');
    const superMain = await git(['rev-parse', 'main'], t.superOrigin);
    expect(await git(['rev-parse', `${superMain}:apps/drill`], t.superOrigin)).toBe(fix);
  });
});

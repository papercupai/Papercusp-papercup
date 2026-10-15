/**
 * submodule-forks.integration.test.ts — plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08
 * P-014 (decision D-017; WI-10006416): a working copy of a repository WITH submodules.
 *
 * The recurrence guard the plan item names: after a real git-sync tick through the
 * production seam (resolveIntegrationPushRemote → applyIntegrationPushTarget → runGitSync),
 * the gitlink the superproject published to ITS fork resolves on the SUBMODULE'S fork,
 * and neither main repository (superproject nor submodule) moved. Four REAL bare repos:
 * both main repositories and the pot's fork of each.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectChildOutput } from '../../child-output';
import { runGitSync, type GitSyncConfig, type RunGit } from './run-git-sync';
import {
  applyIntegrationPushTarget,
  POT_FORK_REMOTE_NAME,
  resolveIntegrationPushRemote,
  WORKING_COPY_INTEGRATION_BRANCH,
  type PotIntegrationModeRead,
} from './pot-integration-mode';
import { findUnpublishedGitlinks, type SubmoduleForksRead } from './submodule-forks';

/** Real git, fleet hooks off; file transport allowed so local submodules can be cloned. */
const testRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    delete env.GIT_CONFIG;
    const child = spawn('git', ['-c', 'core.hooksPath=/nonexistent', '-c', 'protocol.file.allow=always', ...args], { cwd, env });
    const output = collectChildOutput(child);
    child.on('error', (e) => resolve({ code: -1, stdout: output.stdout.text(), stderr: output.stderr.text() + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: output.stdout.text(), stderr: output.stderr.text() }));
  });

async function git(args: string[], cwd: string): Promise<string> {
  const r = await testRunGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const throwingRunGit = async (args: string[], cwd: string): Promise<{ stdout: string }> => ({ stdout: await git(args, cwd) });

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'sf-it@example.com'], dir);
  await git(['config', 'user.name', 'submodule fork integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

/** Does `repo` hold `sha` as a commit? */
async function hasCommit(repo: string, sha: string): Promise<boolean> {
  return (await testRunGit(['cat-file', '-e', `${sha}^{commit}`], repo)).code === 0;
}

let tmpRoot: string;

interface Topology {
  superUpstream: string;
  superFork: string;
  subUpstream: string;
  subFork: string;
  work: string;
}

async function seedBare(name: string, file: string, extra?: (dir: string) => Promise<void>): Promise<string> {
  const bare = join(tmpRoot, `${name}.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], bare);
  const seed = join(tmpRoot, `${name}-seed`);
  await git(['clone', bare, seed], tmpRoot);
  await configRepo(seed);
  await writeFile(join(seed, file), 'seed\n');
  if (extra) await extra(seed);
  await git(['add', '-A'], seed);
  await git(['commit', '--no-verify', '-m', `seed ${name}`], seed);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], seed);
  await rm(seed, { recursive: true, force: true });
  return bare;
}

async function makeTopology(): Promise<Topology> {
  const subUpstream = await seedBare('sub-upstream', 'lib.txt');
  const superUpstream = await seedBare('super-upstream', 'app.txt', async (seed) => {
    await git(['submodule', 'add', subUpstream, 'libs/sub'], seed);
  });
  const subFork = join(tmpRoot, 'sub-fork.git');
  await git(['clone', '--bare', subUpstream, subFork], tmpRoot);
  const superFork = join(tmpRoot, 'super-fork.git');
  await git(['clone', '--bare', superUpstream, superFork], tmpRoot);
  const work = join(tmpRoot, 'work');
  await git(['clone', '--recurse-submodules', superUpstream, work], tmpRoot);
  await configRepo(work);
  await configRepo(join(work, 'libs/sub'));
  return { superUpstream, superFork, subUpstream, subFork, work };
}

/**
 * The main repositories move on their own: the submodule's main gets a commit writing
 * `file`, and the superproject's main pins it. Returns the new submodule commit.
 */
async function moveUpstreamSubmodulePin(t: Topology, file: string, content: string): Promise<string> {
  const subSeed = await mkdtemp(join(tmpRoot, 'sub-up-'));
  await git(['clone', t.subUpstream, subSeed], tmpRoot);
  await configRepo(subSeed);
  await writeFile(join(subSeed, file), content);
  await git(['add', '-A'], subSeed);
  await git(['commit', '--no-verify', '-m', `upstream ${file}`], subSeed);
  await git(['push', '--no-verify', 'origin', 'main'], subSeed);
  const pinned = await git(['rev-parse', 'HEAD'], subSeed);

  const superSeed = await mkdtemp(join(tmpRoot, 'super-up-'));
  await git(['clone', '--recurse-submodules', t.superUpstream, superSeed], tmpRoot);
  await configRepo(superSeed);
  await git(['fetch', 'origin'], join(superSeed, 'libs/sub'));
  await git(['checkout', '--detach', pinned], join(superSeed, 'libs/sub'));
  await git(['add', 'libs/sub'], superSeed);
  await git(['commit', '--no-verify', '-m', 'upstream bumps libs/sub'], superSeed);
  await git(['push', '--no-verify', 'origin', 'main'], superSeed);
  return pinned;
}

const isAncestor = async (repo: string, ancestor: string, of: string): Promise<boolean> =>
  (await testRunGit(['merge-base', '--is-ancestor', ancestor, of], repo)).code === 0;

const REVIEW: PotIntegrationModeRead = { mode: 'review', source: 'set' };

async function tick(t: Topology, submoduleForks: SubmoduleForksRead) {
  const decision = resolveIntegrationPushRemote({ read: REVIEW, forkRemote: t.superFork, submoduleForks });
  const cfg: GitSyncConfig = { branch: 'main', push: true };
  const commitOnly = await applyIntegrationPushTarget('sf-it', cfg, decision, t.work, {
    setupSubmodules: async (repoPath, forks) =>
      (await import('./submodule-forks')).applySubmoduleForkRemotes(repoPath, forks, {
        runGit: throwingRunGit,
        codeRunGit: testRunGit,
      }),
  });
  const outcome = await runGitSync('sf-it', { runGit: testRunGit, repoPath: t.work, config: cfg });
  return { commitOnly, cfg, outcome };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'submodule-forks-it-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('working copy WITH submodules (P-014 / D-017, WI-10006416)', () => {
  it('the superproject fork’s gitlink resolves on the submodule fork; no main repository moves', async () => {
    const t = await makeTopology();
    const superMain = await git(['rev-parse', 'main'], t.superUpstream);
    const subMain = await git(['rev-parse', 'main'], t.subUpstream);
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix inside the submodule\n');
    await writeFile(join(t.work, 'app-fix.txt'), 'agent fix in the superproject\n');

    const r = await tick(t, { source: 'set', forks: { 'libs/sub': t.subFork } });
    expect(r.commitOnly).toBeNull();
    expect(r.cfg.pushSubmoduleOrigins).toBe(true);
    expect(r.outcome.status).not.toBe('error');

    // The superproject published to ITS fork's integration branch…
    const published = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);
    const gitlink = await git(['rev-parse', `${published}:libs/sub`], t.superFork);
    // …and that gitlink is a real commit on the SUBMODULE fork, carrying the agent's file.
    expect(await hasCommit(t.subFork, gitlink)).toBe(true);
    expect(await git(['show', `${gitlink}:fix.txt`], t.subFork)).toBe('agent fix inside the submodule');
    expect(await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.subFork)).toBe(gitlink);
    // The submodule's own checkout pushes through `pot-fork`, never its origin.
    expect(await git(['remote', 'get-url', POT_FORK_REMOTE_NAME], join(t.work, 'libs/sub'))).toBe(t.subFork);

    // Neither main repository moved, and the submodule's main never received the commit.
    expect(await git(['rev-parse', 'main'], t.superUpstream)).toBe(superMain);
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(subMain);
    expect(await hasCommit(t.subUpstream, gitlink)).toBe(false);
  });

  it('a submodule with no recorded fork makes the tick commit-only: nothing is pushed anywhere', async () => {
    const t = await makeTopology();
    const subMain = await git(['rev-parse', 'main'], t.subUpstream);
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix\n');

    const r = await tick(t, { source: 'absent', forks: {} });
    expect(r.commitOnly).toBe('working_copy_submodule_fork_missing');
    expect(r.cfg.push).toBe(false);
    expect(r.cfg.pushSubmoduleOrigins).toBe(false);
    expect((await testRunGit(['rev-parse', '--verify', 'staging'], t.superFork)).code).not.toBe(0);
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(subMain);
    expect(await git(['for-each-ref', 'refs/heads'], t.subFork)).not.toContain('staging');
  });

  it('an unreadable submodule-fork setting is commit-only too (fail closed)', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix\n');
    const r = await tick(t, { source: 'error', forks: {} });
    expect(r.commitOnly).toBe('working_copy_submodule_forks_unreadable');
    expect(r.cfg.push).toBe(false);
  });

  it('a gitlink stays UNPUBLISHED until its commit reaches the submodule’s main repository', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix inside the submodule\n');
    await tick(t, { source: 'set', forks: { 'libs/sub': t.subFork } });
    const head = await git(['rev-parse', 'HEAD'], t.work);
    const gitlink = await git(['rev-parse', 'HEAD:libs/sub'], t.work);
    await git(['fetch', 'origin', 'main'], t.work);

    const before = await findUnpublishedGitlinks({ repoDir: t.work, commit: head, baseCommit: 'origin/main', runGit: testRunGit });
    expect(before).toEqual({
      ok: true,
      unpublished: [{ path: 'libs/sub', sha: gitlink, url: t.subUpstream, branch: 'main' }],
    });

    // The submodule PR merges (its commit lands on the submodule's main): now published.
    await git(['push', t.subUpstream, `${gitlink}:refs/heads/main`], t.subFork);
    const after = await findUnpublishedGitlinks({ repoDir: t.work, commit: head, baseCommit: 'origin/main', runGit: testRunGit });
    expect(after).toEqual({ ok: true, unpublished: [] });
  });
});

describe('sync-back with submodules (P-014 / D-017 §4)', () => {
  const FORKS = (t: Topology): SubmoduleForksRead => ({ source: 'set', forks: { 'libs/sub': t.subFork } });

  it('absorbs an upstream submodule bump into the diverged submodule, holds the push one tick, then publishes a resolvable gitlink', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix inside the submodule\n');
    await tick(t, FORKS(t));
    const agentPin = await git(['rev-parse', 'HEAD:libs/sub'], t.work);
    const publishedBefore = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);

    const upstreamPin = await moveUpstreamSubmodulePin(t, 'upstream.txt', 'upstream change\n');
    const absorbTick = await tick(t, FORKS(t));
    expect(absorbTick.outcome.syncBack).toMatchObject({ status: 'merged', absorbedSubmodules: ['libs/sub'] });

    // The pin the superproject recorded is exactly what the checkout holds, and it carries both sides.
    const subHead = await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'));
    expect(await git(['rev-parse', 'HEAD:libs/sub'], t.work)).toBe(subHead);
    expect(await isAncestor(join(t.work, 'libs/sub'), agentPin, subHead)).toBe(true);
    expect(await isAncestor(join(t.work, 'libs/sub'), upstreamPin, subHead)).toBe(true);
    expect(await git(['status', '--porcelain'], t.work)).toBe('');
    // Held: the superproject fork did not receive a gitlink its submodule fork cannot resolve.
    expect(await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork)).toBe(publishedBefore);
    expect(await hasCommit(t.subFork, subHead)).toBe(false);

    // Next tick: the submodule fork gets the absorbed commit first, then the superproject publishes.
    await tick(t, FORKS(t));
    const published = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);
    expect(published).toBe(await git(['rev-parse', 'HEAD'], t.work));
    expect(await git(['rev-parse', `${published}:libs/sub`], t.superFork)).toBe(subHead);
    expect(await hasCommit(t.subFork, subHead)).toBe(true);
    // The submodule's main repository still only has its own commit.
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(upstreamPin);
  });

  it('fast-forwards an untouched submodule checkout to the upstream pin', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'app-fix.txt'), 'agent fix in the superproject only\n');
    await tick(t, FORKS(t));

    const upstreamPin = await moveUpstreamSubmodulePin(t, 'upstream.txt', 'upstream change\n');
    const r = await tick(t, FORKS(t));
    expect(r.outcome.syncBack).toMatchObject({ status: 'merged', absorbedSubmodules: ['libs/sub'] });
    expect(await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'))).toBe(upstreamPin);
    expect(await git(['rev-parse', 'HEAD:libs/sub'], t.work)).toBe(upstreamPin);
    expect(await git(['status', '--porcelain'], t.work)).toBe('');
  });

  it('a conflicting upstream submodule change is reported and changes neither repository', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/lib.txt'), 'agent rewrote the seed line\n');
    await tick(t, FORKS(t));
    const superHead = await git(['rev-parse', 'HEAD'], t.work);
    const subHead = await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'));

    await moveUpstreamSubmodulePin(t, 'lib.txt', 'upstream rewrote the seed line\n');
    const r = await tick(t, FORKS(t));
    expect(r.outcome.syncBack).toMatchObject({ status: 'conflict', conflictedFiles: ['libs/sub/lib.txt'] });
    expect(await git(['rev-parse', 'HEAD'], t.work)).toBe(superHead);
    expect(await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'))).toBe(subHead);
    expect(await git(['status', '--porcelain'], t.work)).toBe('');
  });
});

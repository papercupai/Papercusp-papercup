/**
 * Regression coverage for setup-release-checkout.sh `clone_submodule_repo()` —
 * the step-2 primary path that gives the release / green-checkpoint tree REAL
 * submodule repositories instead of extracted plain files (EI-19299565558496583).
 *
 * ## Why this function exists
 * Step 2 used to extract submodule SOURCE with `git archive` + tar. That produces
 * correct CONTENT but no `.git`, so the extracted trees are not submodules to git
 * at all — and `git ls-files --recurse-submodules` then silently returns
 * superproject-only. No error, no warning, just a shorter list. Measured in the
 * gate checkout: 7,526 recursive == 7,526 plain (+0 from recursion), 35/35
 * submodules uninitialized, hiding ~3,500 TS files (~32% of the tree) from every
 * tracked-files guard IN THE GATE. Because the failure mode is silence, a guard
 * that stops seeing a third of the repo still reports ✓.
 *
 * ## What is locked here
 * The two properties that make the fix correct are NOT obvious from reading the
 * function, and both have a tempting "simplification" that silently breaks a
 * different part of the system. They are the reason this file exists:
 *
 *   (a) it must produce a real `.git` DIRECTORY. The obvious alternative —
 *       `git submodule update --init` against a locally-rewritten URL — puts each
 *       gitdir under `git rev-parse --git-common-dir`/modules/<name>, which for a
 *       LINKED WORKTREE (which the release tree is) resolves to the INTEGRATION
 *       repo's own `.git`. That collides with the integration tree's live
 *       submodule gitdirs, i.e. corrupts the tree the whole fleet works in.
 *
 *   (b) it must not write submodule config. `git config` from a linked worktree
 *       writes to the SHARED config — into the integration repo — so registering
 *       `submodule.<name>.url` here would mutate that tree too. It is also
 *       unnecessary: activeness is inherited from the shared config.
 *
 * Plus the invariant the whole deploy rests on: the checkout is pinned to the
 * EXACT gitlink sha, never merely to the source's current HEAD.
 *
 * Same extraction pattern as setup-release-checkout-deps.test.ts — we source just
 * this function out of the live script, so the test tracks shipped logic rather
 * than a copy of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// apps/operator/lib/release → apps/operator/bin/release/setup-release-checkout.sh
const SCRIPT_PATH = join(__dirname, '../../bin/release/setup-release-checkout.sh');

/** Deterministic git identity so these tests never depend on the host's config. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'setup-release-test',
  GIT_AUTHOR_EMAIL: 'setup-release-test@example.invalid',
  GIT_COMMITTER_NAME: 'setup-release-test',
  GIT_COMMITTER_EMAIL: 'setup-release-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Invoke the real `clone_submodule_repo()` out of the shipped script.
 * Returns its exit status — the function's own `return 0` / `return 1` contract,
 * which is what step 2 branches on to decide whether to fall back to `git archive`.
 */
function cloneSubmoduleRepo(
  integrationRoot: string,
  releaseRoot: string,
  relPath: string,
  sha: string,
): number {
  const wrapper = [
    'set -uo pipefail',
    `source <(sed -n '/^filesystem_device()/,/^}/p; /^clone_submodule_repo()/,/^}/p' "$SETUP_SCRIPT")`,
    'clone_submodule_repo "$REL_PATH" "$SHA"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', wrapper], {
    env: {
      ...process.env,
      ...GIT_ENV,
      SETUP_SCRIPT: SCRIPT_PATH,
      INTEGRATION_ROOT: integrationRoot,
      RELEASE_ROOT: releaseRoot,
      REL_PATH: relPath,
      SHA: sha,
    },
    encoding: 'utf8',
  });
  return r.status ?? -1;
}

describe('setup-release-checkout.sh committed gitlink population', () => {
  let scratch: string;
  let repo: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'setup-release-mappings-'));
    repo = join(scratch, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'tracked.txt'), 'source');
    git(repo, 'add', 'tracked.txt');
    git(repo, 'commit', '-qm', 'source');
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  function check(sha = 'HEAD') {
    return spawnSync('bash', ['-c',
      'set -euo pipefail\nsource <(sed -n "/^assert_target_gitlink_mappings()/,/^}/p" "$1")\nassert_target_gitlink_mappings "$2" "$3"',
      'mapping-guard', SCRIPT_PATH, repo, sha],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, timeout: 10_000 });
  }

  function addGitlink(path = 'apps/unmapped app') {
    mkdirSync(join(repo, path), { recursive: true });
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${git(repo, 'rev-parse', 'HEAD')},${path}`);
    git(repo, 'commit', '-qm', 'nested repository');
  }

  it('accepts a source with no gitlinks or .gitmodules', () => {
    expect(check().status).toBe(0);
  });

  it('refuses an unmapped committed gitlink even when ordinary status is empty', () => {
    addGitlink();
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const result = check();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('contains gitlinks without .gitmodules');
  });

  it('uses the selected commit mapping, preserving paths with spaces', () => {
    addGitlink();
    const incompleteSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, '.gitmodules'), '[submodule "app"]\npath = apps/unmapped app\nurl = https://example.invalid/app.git\n');
    git(repo, 'add', '.gitmodules');
    git(repo, 'commit', '-qm', 'register app');
    expect(check().status).toBe(0);
    expect(check(incompleteSha).status).toBe(3);
  });

  it('identifies the omitted path when other mapped gitlinks are present', () => {
    writeFileSync(join(repo, '.gitmodules'), '[submodule "other"]\npath = libs/other\nurl = https://example.invalid/other.git\n');
    git(repo, 'add', '.gitmodules');
    git(repo, 'commit', '-qm', 'other mapping');
    addGitlink();
    const result = check();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('pinned gitlink apps/unmapped app has no .gitmodules mapping');
  });

  it('refuses source-only materialization before creating the release checkout', () => {
    addGitlink();
    const release = join(scratch, 'release');
    const result = spawnSync('bash', [SCRIPT_PATH, '--ref', 'HEAD', '--integration', repo,
      '--release', release, '--source-only', '--source-integrity', 'object-sourced'],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, timeout: 10_000 });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('contains gitlinks without .gitmodules');
    expect(existsSync(release)).toBe(false);
  });

  it('does not mistake SIGPIPE from an early match for a source without gitlinks', () => {
    addGitlink();
    writeFileSync(join(repo, '.gitmodules'), '[submodule "other"]\npath = libs/other\nurl = https://example.invalid/other.git\n');
    git(repo, 'add', '.gitmodules');
    const blob = git(repo, 'rev-parse', 'HEAD:tracked.txt');
    const records = Array.from({ length: 3000 }, (_, i) => `100644 ${blob}\tz-${i}-${'x'.repeat(150)}\n`).join('');
    const staged = spawnSync('git', ['update-index', '--index-info'], {
      cwd: repo, input: records, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, timeout: 10_000,
    });
    expect(staged.status).toBe(0);
    git(repo, 'commit', '-qm', 'large snapshot');
    const result = check();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('pinned gitlink apps/unmapped app has no .gitmodules mapping');
  });
});

describe('setup-release-checkout.sh clone_submodule_repo (EI-19299565558496583)', () => {
  let tmp: string;
  let integrationRoot: string;
  let releaseRoot: string;
  let srcDir: string;
  const REL = 'libs/example-sub';
  let shaV1 = '';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'setup-release-submodule-'));
    integrationRoot = join(tmp, 'integration');
    releaseRoot = join(tmp, 'release');
    srcDir = join(integrationRoot, REL);
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(releaseRoot, { recursive: true });

    // A stand-in for a submodule in the integration tree: two commits, so we can
    // pin the FIRST and prove the checkout follows the pin rather than HEAD.
    git(srcDir, 'init', '-q');
    writeFileSync(join(srcDir, 'pinned.txt'), 'v1');
    git(srcDir, 'add', '-A');
    git(srcDir, 'commit', '-qm', 'v1');
    shaV1 = git(srcDir, 'rev-parse', 'HEAD');

    writeFileSync(join(srcDir, 'pinned.txt'), 'v2');
    writeFileSync(join(srcDir, 'added-later.txt'), 'should not appear at the pin');
    git(srcDir, 'add', '-A');
    git(srcDir, 'commit', '-qm', 'v2');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('produces a real .git DIRECTORY, not a gitdir-pointer file (the isolation property)', () => {
    expect(cloneSubmoduleRepo(integrationRoot, releaseRoot, REL, shaV1)).toBe(0);

    const dotGit = join(releaseRoot, REL, '.git');
    expect(existsSync(dotGit)).toBe(true);
    // A DIRECTORY means the repo is self-contained. A FILE would mean a gitdir
    // pointer into some shared .git/modules — the collision described in (a).
    expect(statSync(dotGit).isDirectory()).toBe(true);
  });

  it('checks out the EXACT pinned sha, not the source repo HEAD', () => {
    expect(cloneSubmoduleRepo(integrationRoot, releaseRoot, REL, shaV1)).toBe(0);

    const dest = join(releaseRoot, REL);
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(shaV1);
    // Content follows the pin: v1, and the later file must be absent.
    expect(readFileSync(join(dest, 'pinned.txt'), 'utf8')).toBe('v1');
    expect(existsSync(join(dest, 'added-later.txt'))).toBe(false);
  });

  it('leaves a CLEAN worktree at the pin (the completeness guarantee)', () => {
    expect(cloneSubmoduleRepo(integrationRoot, releaseRoot, REL, shaV1)).toBe(0);
    // The function itself refuses a dirty result; assert the post-condition holds
    // so a future edit cannot quietly weaken it to "exit code only".
    expect(git(join(releaseRoot, REL), 'status', '--porcelain', '-uno')).toBe('');
  });

  it('returns non-zero for a sha the source does not contain, so step 2 falls back to git archive', () => {
    const absent = '0'.repeat(40);
    expect(cloneSubmoduleRepo(integrationRoot, releaseRoot, REL, absent)).not.toBe(0);
  });

  it('writes NO submodule config into the integration repo (a linked worktree shares config)', () => {
    const before = git(srcDir, 'config', '--local', '--list');
    expect(cloneSubmoduleRepo(integrationRoot, releaseRoot, REL, shaV1)).toBe(0);
    const after = git(srcDir, 'config', '--local', '--list');
    expect(after).toBe(before);
    expect(after).not.toMatch(/^submodule\./m);
  });

  it('replaces an existing destination rather than merging into it', () => {
    const dest = join(releaseRoot, REL);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'stale-debris.txt'), 'left over from a previous run');

    expect(cloneSubmoduleRepo(integrationRoot, releaseRoot, REL, shaV1)).toBe(0);
    // Step 1's clean cannot reach inside a nested repo, so this function owning the
    // rm -rf is what keeps a throwaway tree honest across re-runs.
    expect(existsSync(join(dest, 'stale-debris.txt'))).toBe(false);
  });
});

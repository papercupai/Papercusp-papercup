/**
 * EI-25261145211539591: an unreadable submodule's head-blob reason must name the MEASURED
 * cause. The old reason said "(not initialized in this checkout, or its object store is
 * unreadable)" for every non-complete `git ls-tree`, including a timeout in a tree whose
 * object store held the commit, which sent two investigations to a nonexistent mechanism.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionHeadBlobMap } from './completion-freshness';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

describe('completionHeadBlobMap — unreadable submodule reasons name the measured cause', () => {
  let tmp: string;
  let superRoot: string;
  let subRoot: string;
  let pinnedSha: string;

  /** Superproject whose gitlink `sub` pins `pin`; `sub` is a nested repo. */
  function superprojectPinning(pin: string): string {
    initRepo(superRoot);
    writeFileSync(join(superRoot, 'README.md'), 'super\n');
    git(superRoot, 'add', 'README.md');
    git(superRoot, 'update-index', '--add', '--cacheinfo', `160000,${pin},sub`);
    git(superRoot, 'commit', '-qm', 'pin sub');
    return git(superRoot, 'rev-parse', 'HEAD');
  }

  /** A git wrapper that misbehaves ONLY for `ls-tree` inside the submodule. */
  function lsTreeWrapper(action: string): string {
    const wrapper = join(tmp, 'git-wrapper.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *"${subRoot} ls-tree "*) ${action};; esac\nexec git "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    return wrapper;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ei2526-'));
    superRoot = join(tmp, 'super');
    subRoot = join(superRoot, 'sub');
    initRepo(subRoot);
    writeFileSync(join(subRoot, 'a.ts'), 'export const a = 1;\n');
    git(subRoot, 'add', 'a.ts');
    git(subRoot, 'commit', '-qm', 'sub commit');
    pinnedSha = git(subRoot, 'rev-parse', 'HEAD');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('calibration: a readable submodule resolves the blob (the fixture is sound)', async () => {
    const head = superprojectPinning(pinnedSha);
    const map = await completionHeadBlobMap(superRoot, head, ['sub/a.ts']);
    expect(map?.get('sub/a.ts')).toEqual({ status: 'resolved', sha: git(subRoot, 'rev-parse', 'HEAD:a.ts') });
  });

  it('an ABSENT commit says the object store lacks it', async () => {
    const elsewhere = join(tmp, 'elsewhere');
    initRepo(elsewhere);
    writeFileSync(join(elsewhere, 'b.ts'), 'b\n');
    git(elsewhere, 'add', 'b.ts');
    git(elsewhere, 'commit', '-qm', 'not in sub');
    const absent = git(elsewhere, 'rev-parse', 'HEAD');
    const head = superprojectPinning(absent);

    const resolution = (await completionHeadBlobMap(superRoot, head, ['sub/a.ts']))?.get('sub/a.ts');
    expect(resolution?.status).toBe('unresolvable');
    const reason = (resolution as { reason: string }).reason;
    // complete.ts keys its registered-root retry on this prefix: it must survive.
    expect(reason.startsWith(`submodule 'sub' could not be read at ${absent.slice(0, 12)} `)).toBe(true);
    expect(reason).toContain("the commit is not in this checkout's submodule object store");
    expect(reason).not.toContain('IS present');
  });

  it('a FAILED read of a PRESENT commit says the commit is present (not a missing object)', async () => {
    const head = superprojectPinning(pinnedSha);
    const gitBinary = lsTreeWrapper('exit 1');

    const resolution = (await completionHeadBlobMap(superRoot, head, ['sub/a.ts'], { gitBinary }))?.get('sub/a.ts');
    expect(resolution?.status).toBe('unresolvable');
    const reason = (resolution as { reason: string }).reason;
    expect(reason.startsWith(`submodule 'sub' could not be read at ${pinnedSha.slice(0, 12)} `)).toBe(true);
    expect(reason).toContain('git ls-tree failed although the commit IS present');
    expect(reason).not.toContain('not initialized in this checkout');
  });

  it('a TIMED-OUT read says it timed out and is not evidence of a missing commit', async () => {
    const head = superprojectPinning(pinnedSha);
    const gitBinary = lsTreeWrapper('sleep 3; exit 1');

    const resolution = (
      await completionHeadBlobMap(superRoot, head, ['sub/a.ts'], { gitBinary, timeoutMs: 400 })
    )?.get('sub/a.ts');
    expect(resolution?.status).toBe('unresolvable');
    const reason = (resolution as { reason: string }).reason;
    expect(reason.startsWith(`submodule 'sub' could not be read at ${pinnedSha.slice(0, 12)} `)).toBe(true);
    expect(reason).toContain('git ls-tree timed out after 400ms');
    expect(reason).toContain('NOT evidence');
    expect(reason).not.toContain('not initialized in this checkout');
  }, 15_000);
});

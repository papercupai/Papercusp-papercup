/**
 * `.papercusp/memory/raw.md` must merge with git's built-in `union` driver
 * (EI-26583573652314044).
 *
 * raw.md is an append-only memory log written on every checkout: the canonical
 * tree and every fork/drill pot. Two branches that each append to it touch the
 * same end-of-file region, so an ordinary 3-way merge conflicts on every
 * sync-back. That conflict stalled the P-016 drill pot's upstream sync for three
 * days (the clone fell ~1,356 commits behind origin/staging). The root
 * `.gitattributes` line `.papercusp/memory/raw.md merge=union` keeps both sides'
 * lines, which is safe because entries are timestamped and order-insensitive.
 *
 * git reads `.gitattributes` from the WORKING TREE / index of the side doing the
 * merge, so the attribute only helps once it is COMMITTED on both sides. The
 * first check asks the index (`--cached`), not the working tree: an untracked
 * `.gitattributes` would pass a working-tree check here yet be missing from every
 * clone. The positive control proves the oracle still reports `unspecified` for
 * a path without the attribute, so a broken git call cannot pass vacuously. The
 * behavioural check replays the real failure shape (two concurrent appends) in a
 * throwaway repository that uses this repo's committed `.gitattributes` bytes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');
const RAW_MD = '.papercusp/memory/raw.md';

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'raw-md-guard',
      GIT_AUTHOR_EMAIL: 'raw-md-guard@example.invalid',
      GIT_COMMITTER_NAME: 'raw-md-guard',
      GIT_COMMITTER_EMAIL: 'raw-md-guard@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`);
  return r.stdout;
}

/** The `merge` attribute value git resolves for a path from the INDEX only. */
function committedMergeAttr(repoRelPath: string): string {
  const out = mustGit(REPO_ROOT, ['check-attr', '--cached', 'merge', '--', repoRelPath]).trim();
  // Format: "<path>: merge: <value>"
  const value = out.split(': merge: ')[1];
  if (value === undefined) throw new Error(`unexpected git check-attr output: ${JSON.stringify(out)}`);
  return value;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('raw.md merges with the union driver (EI-26583573652314044)', () => {
  it('positive control: a path without the attribute resolves to unspecified', () => {
    expect(committedMergeAttr('packages/operator-core/package.json')).toBe('unspecified');
  });

  it(`${RAW_MD} resolves merge=union from the committed .gitattributes`, () => {
    expect(committedMergeAttr(RAW_MD)).toBe('union');
  });

  /** Replay the sync-back shape: a fork and upstream each append to raw.md, then the fork merges upstream. */
  function appendRace(attributes: string): { merge: ReturnType<typeof git>; merged: string } {
    const dir = mkdtempSync(join(tmpdir(), 'raw-md-union-'));
    scratch.push(dir);
    mustGit(dir, ['init', '-q', '-b', 'staging']);
    writeFileSync(join(dir, '.gitattributes'), attributes);
    mkdirSync(join(dir, '.papercusp/memory'), { recursive: true });
    writeFileSync(join(dir, RAW_MD), '- 2026-10-01T00:00:00Z base entry\n');
    mustGit(dir, ['add', '-A']);
    mustGit(dir, ['commit', '-q', '-m', 'base']);

    mustGit(dir, ['checkout', '-q', '-b', 'fork']);
    appendFileSync(join(dir, RAW_MD), '- 2026-10-02T00:00:00Z fork-side entry\n');
    mustGit(dir, ['commit', '-q', '-am', 'fork append']);

    mustGit(dir, ['checkout', '-q', 'staging']);
    appendFileSync(join(dir, RAW_MD), '- 2026-10-02T00:00:01Z upstream-side entry\n');
    mustGit(dir, ['commit', '-q', '-am', 'upstream append']);

    mustGit(dir, ['checkout', '-q', 'fork']);
    const merge = git(dir, ['merge', '--no-edit', 'staging']);
    return { merge, merged: readFileSync(join(dir, RAW_MD), 'utf8') };
  }

  it('negative control: without the attribute the same append race conflicts', () => {
    const { merge, merged } = appendRace('');
    expect(merge.status).not.toBe(0);
    expect(merged).toMatch(/^<{7}/m);
  });

  it('two concurrent raw.md appends merge without conflict and keep both entries', () => {
    const attributes = mustGit(REPO_ROOT, ['show', ':.gitattributes']);
    const { merge, merged } = appendRace(attributes);
    expect(merge.status, `merge conflicted: ${merge.stdout}${merge.stderr}`).toBe(0);

    expect(merged).toContain('base entry');
    expect(merged).toContain('fork-side entry');
    expect(merged).toContain('upstream-side entry');
    expect(merged).not.toMatch(/^(<{7}|={7}|>{7})/m);
  });
});

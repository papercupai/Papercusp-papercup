/**
 * WI-10006785 — process roots that SIGKILL their descendants must default
 * GIT_OPTIONAL_LOCKS=0, so a `git status` killed mid-run cannot leave a holderless
 * `.git/index.lock` that freezes every commit in the shared tree.
 *
 * The behavioural half proves the property the fix relies on against REAL git: with the
 * helper's env, `git status` does not rewrite (and so never locks) the index even when the
 * index is stat-dirty; the control (GIT_OPTIONAL_LOCKS=1) proves the same setup DOES make
 * git rewrite it, so the assertion cannot pass vacuously.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyGitOptionalLocksDefault } from '../../../../scripts/lib/git-optional-locks.mjs';

const REPO_ROOT = resolve(__dirname, '../../../..');

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('applyGitOptionalLocksDefault', () => {
  it('defaults an unset or empty value to 0', () => {
    expect(applyGitOptionalLocksDefault({}).GIT_OPTIONAL_LOCKS).toBe('0');
    expect(applyGitOptionalLocksDefault({ GIT_OPTIONAL_LOCKS: '' }).GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('respects an explicit caller value', () => {
    expect(applyGitOptionalLocksDefault({ GIT_OPTIONAL_LOCKS: '1' }).GIT_OPTIONAL_LOCKS).toBe('1');
  });

  it('mutates and returns the env object it was given', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyGitOptionalLocksDefault(env)).toBe(env);
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });
});

describe('real git: the helper env stops `git status` from writing the index', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('leaves a stat-dirty index untouched, while the GIT_OPTIONAL_LOCKS=1 control rewrites it', () => {
    dir = mkdtempSync(join(tmpdir(), 'git-optional-locks-'));
    const base = cleanGitEnv();
    git(dir, ['init', '-q'], base);
    git(dir, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'], base);
    writeFileSync(join(dir, 'a.txt'), 'same content\n');
    git(dir, ['add', 'a.txt'], base);
    git(dir, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'a'], base);

    // Make the cached stat info stale without changing content, so a refreshing
    // `git status` has something to write back.
    const future = new Date(Date.now() + 120_000);
    utimesSync(join(dir, 'a.txt'), future, future);
    const indexPath = join(dir, '.git', 'index');

    const before = statSync(indexPath).ino;
    git(dir, ['status', '--porcelain'], applyGitOptionalLocksDefault({ ...base }));
    expect(statSync(indexPath).ino).toBe(before);

    git(dir, ['status', '--porcelain'], { ...base, GIT_OPTIONAL_LOCKS: '1' });
    expect(statSync(indexPath).ino).not.toBe(before);
  });
});

describe('process roots apply the default at module top level', () => {
  it('the green-checkpoint CLI applies the shared policy before starting its controller', () => {
    const src = readFileSync(join(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');
    const entry = src.slice(src.indexOf('if (require.main === module) {'));
    expect(entry).toMatch(/^ {2}applyGitOptionalLocksDefault\(\);$/m);
    expect(entry.indexOf('applyGitOptionalLocksDefault();')).toBeLessThan(entry.indexOf('releaseConfig('));
  });

  it.each(['scripts/test-files.mjs', 'scripts/affected-tests.mjs'])('%s', (rel) => {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    expect(src).toMatch(/^import \{ applyGitOptionalLocksDefault \} from ["']\.\/lib\/git-optional-locks\.mjs["'];$/m);
    expect(src).toMatch(/^applyGitOptionalLocksDefault\(\);$/m);
  });

  it('apps/operator/bin/host-bootstrap.ts defaults it inside runBootstrap()', () => {
    const src = readFileSync(join(REPO_ROOT, 'apps/operator/bin/host-bootstrap.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function runBootstrap(): void {'));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/^ {2}if \(!process\.env\.GIT_OPTIONAL_LOCKS\) process\.env\.GIT_OPTIONAL_LOCKS = '0';$/m);
  });
});

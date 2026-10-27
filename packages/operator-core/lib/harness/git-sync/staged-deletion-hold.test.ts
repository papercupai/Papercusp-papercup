/**
 * WI-10006352 — a staged module DELETION must not commit while the commit's own tree (the
 * index) still imports it.
 *
 * MEASURED 2026-10-06: git-sync commit e7b60f03fe deleted `agent-tools/gmail/*` while the
 * `agent-tools/index.ts` edit that dropped `import './gmail/create-draft'` was held back as a
 * quarantined importer. The pre-stage deletion guard had judged the importer by its
 * WORKING-TREE text (import gone), so the deletion committed against the importer's HEAD text
 * (import present), and every isolated build of staging failed on the unresolved import.
 *
 * These tests drive real git repositories: the defect lives in the gap between what the
 * working tree says and what the index records, which a scripted `runGit` cannot reproduce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectStagedDeletionsStillImported } from './deletion-import-guard';
import { guardStagedIndexBeforeCommit, holdStagedDeletionsStillImported, type RunGit } from './run-git-sync';

const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

const runGit: RunGit = async (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function write(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

function stagedPaths(repo: string): string[] {
  return git(repo, 'diff', '--cached', '--name-only', '--no-renames').split('\n').filter(Boolean).sort();
}

let repo: string;
const logs: string[] = [];
const log = (m: string) => logs.push(m);

beforeEach(() => {
  logs.length = 0;
  repo = mkdtempSync(join(tmpdir(), 'wi10006352-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** HEAD: an importer of `./gmail/create-draft`; working tree: the module deleted AND the import dropped. */
function seedGmailMove(): void {
  write(repo, 'lib/agent-tools/index.ts', "import './gmail/create-draft';\nimport './plans/restore';\n");
  write(repo, 'lib/agent-tools/gmail/create-draft.ts', 'export const createDraft = 1;\n');
  write(repo, 'lib/agent-tools/plans/restore.ts', 'export const restore = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  rmSync(join(repo, 'lib/agent-tools/gmail/create-draft.ts'));
  write(repo, 'lib/agent-tools/index.ts', "import './plans/restore';\n");
}

describe('WI-10006352: staged deletions the index still imports', () => {
  it.each(['target', '-target'])('scans a staged deletion with a literal basename (%s)', async (name) => {
    const target = `lib/${name}.ts`;
    write(repo, target, 'export const value = 1;\n');
    write(repo, 'lib/consumer.ts', `import { value } from './${name}';\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');
    rmSync(join(repo, target));
    git(repo, 'add', '-A', '--', target);

    expect(await detectStagedDeletionsStillImported({ runGit, repoPath: repo, log })).toEqual({
      ok: true,
      holds: [{ path: target, importedBy: ['lib/consumer.ts'] }],
    });

    // Once the final importer is removed from the index, this deletion must be allowed.
    write(repo, 'lib/consumer.ts', 'export {};\n');
    git(repo, 'add', '--', 'lib/consumer.ts');
    expect(await detectStagedDeletionsStillImported({ runGit, repoPath: repo, log })).toEqual({ ok: true, holds: [] });
  });

  it('holds the deletion when the importer edit that dropped the import is NOT staged (the measured e7b60f03fe shape)', async () => {
    seedGmailMove();
    // The importer is quarantined: only the deletion reaches the index.
    git(repo, 'add', '-A', '--', 'lib/agent-tools/gmail');
    expect(stagedPaths(repo)).toEqual(['lib/agent-tools/gmail/create-draft.ts']);

    const scan = await detectStagedDeletionsStillImported({ runGit, repoPath: repo, log });
    expect(scan).toEqual({
      ok: true,
      holds: [{ path: 'lib/agent-tools/gmail/create-draft.ts', importedBy: ['lib/agent-tools/index.ts'] }],
    });

    const hold = await holdStagedDeletionsStillImported({ runGit, repoPath: repo, scope: 'test', log });
    expect(hold).toEqual({ ok: true, unstaged: ['lib/agent-tools/gmail/create-draft.ts'] });
    // The commit would now carry neither side of the move: HEAD stays resolvable.
    expect(stagedPaths(repo)).toEqual([]);
    // The working tree is untouched — the deletion is deferred, not reverted.
    expect(existsSync(join(repo, 'lib/agent-tools/gmail/create-draft.ts'))).toBe(false);
    expect(logs.join('\n')).toContain('imported by lib/agent-tools/index.ts');
  });

  it('lets the deletion commit when the importer edit is staged with it', async () => {
    seedGmailMove();
    git(repo, 'add', '-A');
    const hold = await holdStagedDeletionsStillImported({ runGit, repoPath: repo, scope: 'test', log });
    expect(hold).toEqual({ ok: true, unstaged: [] });
    expect(stagedPaths(repo)).toEqual(['lib/agent-tools/gmail/create-draft.ts', 'lib/agent-tools/index.ts']);
  });

  it('runs to a fixed point: a held deletion re-enters the index and its HEAD imports hold the next one', async () => {
    write(repo, 'lib/entry.ts', "import './alpha-module';\n");
    write(repo, 'lib/alpha-module.ts', "import './bravo-module';\nexport const a = 1;\n");
    write(repo, 'lib/bravo-module.ts', 'export const b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');
    rmSync(join(repo, 'lib/alpha-module.ts'));
    rmSync(join(repo, 'lib/bravo-module.ts'));
    write(repo, 'lib/entry.ts', 'export {};\n');
    // entry.ts is held back; both deletions are staged.
    git(repo, 'add', '-A', '--', 'lib/alpha-module.ts', 'lib/bravo-module.ts');

    // Round 1 alone sees only alpha: nothing left in the index imports bravo.
    const first = await detectStagedDeletionsStillImported({ runGit, repoPath: repo, log });
    expect(first.ok && first.holds.map((h) => h.path)).toEqual(['lib/alpha-module.ts']);

    const hold = await holdStagedDeletionsStillImported({ runGit, repoPath: repo, scope: 'test', log });
    expect(hold.ok && [...hold.unstaged].sort()).toEqual(['lib/alpha-module.ts', 'lib/bravo-module.ts']);
    expect(stagedPaths(repo)).toEqual([]);
  });

  it('does not hold a deletion whose module path another indexed file still provides (x.js -> x.ts)', async () => {
    write(repo, 'lib/consumer.ts', "import { thing } from './thing-module';\nexport const c = thing;\n");
    write(repo, 'lib/thing-module.js', 'export const thing = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'seed');
    rmSync(join(repo, 'lib/thing-module.js'));
    write(repo, 'lib/thing-module.ts', 'export const thing = 1;\n');
    git(repo, 'add', '-A');

    const hold = await holdStagedDeletionsStillImported({ runGit, repoPath: repo, scope: 'test', log });
    expect(hold).toEqual({ ok: true, unstaged: [] });
    expect(stagedPaths(repo)).toEqual(['lib/thing-module.js', 'lib/thing-module.ts']);
  });

  it('holds a deletion conservatively when the index cannot be scanned for it', async () => {
    const failingGrep: RunGit = async (args) => {
      if (args[0] === 'grep') return { code: 128, stdout: '', stderr: 'fatal: simulated index read failure' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const scan = await detectStagedDeletionsStillImported({
      runGit: failingGrep,
      repoPath: '/repo',
      stagedDeletions: ['lib/agent-tools/gmail/create-draft.ts'],
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.holds).toHaveLength(1);
    expect(scan.holds[0].path).toBe('lib/agent-tools/gmail/create-draft.ts');
    expect(scan.holds[0].scanError).toContain('simulated index read failure');
  });

  it('is wired into guardStagedIndexBeforeCommit, the check that runs before every git-sync commit', async () => {
    seedGmailMove();
    git(repo, 'add', '-A', '--', 'lib/agent-tools/gmail');
    const result = await guardStagedIndexBeforeCommit({
      runGit,
      repoPath: repo,
      scope: 'test',
      readText: async (rel) => {
        try {
          return readFileSync(join(repo, rel), 'utf8');
        } catch {
          return null;
        }
      },
      log,
    });
    expect(result).toEqual({
      ok: true,
      lateLockedHoldings: [],
      drifted: [],
      unstaged: ['lib/agent-tools/gmail/create-draft.ts'],
    });
    expect(stagedPaths(repo)).toEqual([]);
  });
});

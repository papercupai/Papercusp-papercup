/**
 * EI-21230011589307899 — the post-stage guard must not commit a staged blob the pre-stage
 * content guard never judged.
 *
 * MEASURED 2026-10-13: git-sync's content guard (which carries the commit-time `secrets`
 * detector) scans the dirty set BEFORE `git add -A`; the oversized/deletion/import guards
 * and the lock census run in between. A secret-shaped test fixture created in that window
 * was staged by the add, committed unscanned, and the own-head publish guard then froze git
 * egress for the fleet. The post-stage drift check could not see it: the file did not change
 * AFTER the add.
 *
 * These tests drive real git repositories, because the defect is the gap between the dirty
 * set the scan saw and the index the commit records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { guardStagedIndexBeforeCommit, type RunGit } from './run-git-sync';
import { detectContentOffenders, detectUnscannedStagedOffenders } from './content-guard';
import type { ContentDetector } from '../../content-lint/registry';

const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
) as NodeJS.ProcessEnv;

const runGit: RunGit = (args, cwd, options) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { ...GIT_ENV, ...options?.env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, repo);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

async function stagedPaths(repo: string): Promise<string[]> {
  return (await git(repo, 'diff', '--cached', '--name-only', '--no-renames')).split('\n').filter(Boolean).sort();
}

/** Stands in for `secrets`: flags any file carrying the marker. */
const LEAK = 'LEAKED_CREDENTIAL';
const leakDetector: ContentDetector = {
  key: 'fake-secrets',
  glob: '**/*',
  matches: () => true,
  detect: (_file, text) => (text.includes(LEAK) ? 'credential-shaped value' : null),
  fixerRole: 'content-fixer',
};

let repo: string;
const logs: string[] = [];
const log = (m: string) => logs.push(m);
const readText = async (rel: string): Promise<string | null> => {
  try {
    return readFileSync(join(repo, rel), 'utf8');
  } catch {
    return null;
  }
};

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ei899-post-stage-'));
  logs.length = 0;
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'test');
  write(repo, 'src/base.ts', 'export const base = 1;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Pre-stage scan over the dirty set, then a late file, then `git add -A`, then the guard. */
async function raceThenGuard(late: Record<string, string>, opts: { rescan: boolean }) {
  const scanned = new Map<string, string>();
  const pre = await detectContentOffenders({ runGit, repoPath: repo, readText, detectors: [leakDetector], log, scanned });
  // The window between the scan and the add.
  for (const [rel, text] of Object.entries(late)) write(repo, rel, text);
  await git(repo, 'add', '-A');
  const guard = await guardStagedIndexBeforeCommit({
    runGit,
    repoPath: repo,
    scope: 'test',
    readText,
    log,
    ...(opts.rescan
      ? {
          rescanStagedContent: (staged: readonly string[], indexRunGit: RunGit) =>
            detectUnscannedStagedOffenders({
              runGit: indexRunGit,
              repoPath: repo,
              staged,
              scanned,
              detectors: [leakDetector],
              log,
            }),
        }
      : {}),
  });
  return { pre, guard, scanned };
}

describe('post-stage content rescan (EI-21230011589307899)', () => {
  it('holds back a credential-shaped file created between the pre-stage scan and the add', async () => {
    write(repo, 'src/clean.ts', 'export const clean = 2;\n');
    const { pre, guard, scanned } = await raceThenGuard(
      { 'src/late-fixture.test.ts': `const key = '${LEAK}';\n` },
      { rescan: true },
    );

    expect(pre).toEqual([]);
    expect([...scanned.keys()]).toEqual(['src/clean.ts']);
    expect(guard.ok).toBe(true);
    if (!guard.ok) return;
    expect(guard.unstaged).toContain('src/late-fixture.test.ts');
    expect(await stagedPaths(repo)).toEqual(['src/clean.ts']);
    // Held, not discarded: the file stays dirty for the next tick's full pipeline.
    expect(existsSync(join(repo, 'src/late-fixture.test.ts'))).toBe(true);
    expect(logs.join('\n')).toMatch(/content guard \(post-stage\)/);
  });

  it('holds a staged importer of the held file, so the commit never imports a missing module', async () => {
    const { guard } = await raceThenGuard(
      {
        'src/leak.ts': `export const key = '${LEAK}';\n`,
        'src/uses-leak.ts': "import { key } from './leak';\nexport const k = key;\n",
      },
      { rescan: true },
    );
    expect(guard.ok).toBe(true);
    expect(await stagedPaths(repo)).toEqual([]);
  });

  it('keeps a clean late file staged (the rescan judges it rather than deferring it)', async () => {
    const { guard } = await raceThenGuard({ 'src/late-clean.ts': 'export const ok = 3;\n' }, { rescan: true });
    expect(guard.ok).toBe(true);
    expect(await stagedPaths(repo)).toEqual(['src/late-clean.ts']);
  });

  it('CONTROL: without the rescan hook the late credential stays staged — the race this closes', async () => {
    const { guard } = await raceThenGuard(
      { 'src/late-fixture.test.ts': `const key = '${LEAK}';\n` },
      { rescan: false },
    );
    expect(guard.ok).toBe(true);
    expect(await stagedPaths(repo)).toEqual(['src/late-fixture.test.ts']);
  });

  it('FAILS OPEN when the rescan hook throws: the guard logs and does not refuse the commit', async () => {
    write(repo, 'src/clean.ts', 'export const clean = 2;\n');
    await git(repo, 'add', '-A');
    const guard = await guardStagedIndexBeforeCommit({
      runGit,
      repoPath: repo,
      scope: 'test',
      readText,
      log,
      rescanStagedContent: async () => {
        throw new Error('detector registry exploded');
      },
    });
    expect(guard.ok).toBe(true);
    expect(await stagedPaths(repo)).toEqual(['src/clean.ts']);
    expect(logs.join('\n')).toMatch(/post-stage content rescan failed \(fail-open\).*detector registry exploded/);
  });
});

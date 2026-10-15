/**
 * WI-39377 — the wholesale-deletion guard.
 *
 * The bug being pinned: git-sync committed four SideStage submodules down to
 * zero-file trees and pushed them to GitHub, because nothing in the commit path
 * looks at the MAGNITUDE of a deletion set. The most important tests here are the
 * two CONTROLS at the bottom, which prove the guard is falsifiable: without them a
 * detector that returned `[]` unconditionally would pass every positive assertion.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgeDeletionSet,
  detectWholesaleDeletion,
  WHOLESALE_DELETION_RATIO,
  WHOLESALE_DELETION_MIN_TRACKED,
} from './wholesale-deletion-guard';
import type { RunGit } from './run-git-sync';

/** `git status --porcelain -z -uall` payload for a set of deleted paths. */
const porcelainDeleted = (paths: string[]) => paths.map((p) => ` D ${p}`).join('\0') + (paths.length ? '\0' : '');

/** `git ls-tree -r -z --name-only` payload: NUL-terminated raw names. */
const nulList = (paths: string[]) => paths.map((p) => `${p}\0`).join('');

/** A RunGit that answers the three commands the detector issues, and nothing else. */
function fakeGit({
  deleted,
  tracked,
  ignored = () => false,
  statusCode = 0,
  treeCode = 0,
  checkIgnoreCode,
}: {
  deleted: string[];
  tracked: string[];
  /** Stands in for the repo's .gitignore. Default: nothing is ignored. */
  ignored?: (path: string) => boolean;
  statusCode?: number;
  treeCode?: number;
  /** Force a real git failure out of check-ignore (0/1 are both normal answers). */
  checkIgnoreCode?: number;
}): RunGit {
  return async (args) => {
    if (args[0] === 'status') return { code: statusCode, stdout: porcelainDeleted(deleted), stderr: '' };
    if (args[0] === 'ls-tree') return { code: treeCode, stdout: nulList(tracked), stderr: '' };
    if (args[0] === 'check-ignore') {
      if (checkIgnoreCode !== undefined) return { code: checkIgnoreCode, stdout: '', stderr: 'fatal' };
      // Model real Git 2.43, which a lenient fake hid for months (WI-6554700010010783).
      if (args.includes('-z') && !args.includes('--stdin')) {
        return { code: 128, stdout: '', stderr: 'fatal: -z only makes sense with --stdin' };
      }
      const queried = args.slice(args.indexOf('--') + 1);
      const hits = queried.filter(ignored);
      // git exits 1 (not an error) when no queried path is ignored; argv mode prints
      // one matched path per line.
      return { code: hits.length ? 0 : 1, stdout: hits.map((p) => `${p}\n`).join(''), stderr: '' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

describe('judgeDeletionSet — the pure verdict', () => {
  it('calls a 100% deletion a wipe (the exact SideStage shape: 46/46 in libs/sse)', () => {
    const files = Array.from({ length: 46 }, (_, i) => `src/f${i}.ts`);
    const v = judgeDeletionSet(files, 46);
    expect(v.wipe).toBe(true);
    expect(v.ratio).toBe(1);
    expect(v.reason).toContain('46/46');
  });

  it('calls a deletion of the root package.json a wipe REGARDLESS of ratio', () => {
    // 1 of 100 files is 1% — far below the ratio — but losing package.json is what
    // made the submodule unresolvable and let the next sweep commit dist/ as source.
    const v = judgeDeletionSet(['package.json'], 100);
    expect(v.wipe).toBe(true);
    expect(v.packageDefiningDeleted).toEqual(['package.json']);
  });

  it('calls a deletion of the root .gitignore a wipe (that is what let dist/ get committed)', () => {
    const v = judgeDeletionSet(['.gitignore'], 100);
    expect(v.wipe).toBe(true);
    expect(v.packageDefiningDeleted).toEqual(['.gitignore']);
  });

  it('does NOT fire on an ordinary large refactor below the threshold', () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/old${i}.ts`);
    const v = judgeDeletionSet(files, 100); // 50%
    expect(v.wipe).toBe(false);
    expect(v.reason).toContain('below');
  });

  it('does NOT fire on a tiny repo where the ratio is meaningless', () => {
    // 1 of 1 file is 100% and completely ordinary.
    const v = judgeDeletionSet(['only.ts'], 1);
    expect(v.wipe).toBe(false);
    expect(v.trackedCount).toBeLessThan(WHOLESALE_DELETION_MIN_TRACKED);
  });

  it('does not fire when nothing is deleted', () => {
    expect(judgeDeletionSet([], 100).wipe).toBe(false);
  });

  it('treats a nested package.json as ordinary — only the repo ROOT one is decisive', () => {
    // A wipe removes the repo's own package.json at path "package.json". Deleting
    // some fixture's nested package.json must not trip the decisive branch.
    const v = judgeDeletionSet(['test/fixtures/pkg/package.json'], 100);
    expect(v.wipe).toBe(false);
    expect(v.packageDefiningDeleted).toEqual([]);
  });

  it('fires exactly AT the threshold, not just above it', () => {
    const n = Math.ceil(100 * WHOLESALE_DELETION_RATIO);
    const files = Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
    expect(judgeDeletionSet(files, 100).wipe).toBe(true);
  });
});

describe('detectWholesaleDeletion — the detector', () => {
  it('quarantines EVERY deleted path in a wipe, so add -A excludes them all', async () => {
    const tracked = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toHaveLength(21);
    expect(new Set(offenders.map((o) => o.file))).toEqual(new Set(tracked));
    expect(offenders[0].detectorKey).toBe('wholesale-deletion');
    expect(offenders[0].fixerRole).toBe('content-fixer');
    expect(offenders[0].error).toContain('refused to commit this deletion');
  });

  it('reproduces the SideStage wipe end-to-end and refuses it', async () => {
    // libs/dock-workbench: 21 tracked files, all deleted, package.json among them.
    // Before this guard git-sync committed exactly this and pushed a 0-file tree.
    const tracked = ['package.json', '.gitignore', 'src/index.ts', ...Array.from({ length: 18 }, (_, i) => `src/m${i}.ts`)];
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked }),
      repoPath: '/repo/libs/dock-workbench',
    });
    expect(offenders.map((o) => o.file)).toContain('package.json');
    expect(offenders).toHaveLength(tracked.length);
  });

  // ---- CONTROLS: these are what make the assertions above meaningful ----

  it('CONTROL: returns [] for an ordinary partial deletion (guard is not always-on)', async () => {
    const tracked = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked.slice(0, 10), tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });

  it('CONTROL: returns [] when nothing is deleted at all', async () => {
    const tracked = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: [], tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });

  it('FAILS OPEN when git status errors — a guard bug must never wedge the tree', async () => {
    const tracked = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked, statusCode: 128 }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });

  it('FAILS OPEN on an unborn branch (no HEAD to measure against)', async () => {
    const tracked = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: tracked, tracked, treeCode: 128 }),
      repoPath: '/repo',
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * WI-39889 — the guard firing on its own inverse.
 *
 * The 2026-08-15 wipe left `node_modules/` TRACKED in four submodules (the
 * .gitignore was missing from the working tree while a sweep ran, so `git add -A`
 * legitimately swept it in). An ordinary `npm run install:safe` months later turned
 * those into 1,526-file deletion sets — 96% of "tracked" files — and this guard
 * quarantined them on every tick for 33 hours, stalling ALL commits in those repos
 * and stranding real source edits behind build junk.
 *
 * An untracking repair is the OPPOSITE of a wipe, and the two are distinguishable
 * without ambiguity: a wipe deletes the .gitignore, a repair is deleting what the
 * .gitignore says.
 */
describe('WI-39889 — deletions of ignored paths are an untracking repair, not a wipe', () => {
  const nodeModules = (n: number) => Array.from({ length: n }, (_, i) => `node_modules/pkg${i}/index.js`);
  const isNodeModules = (p: string) => p.startsWith('node_modules/');

  it('reproduces libs/ui-primitives exactly: 1526 ignored deletions of 1600 tracked → no opinion', async () => {
    const junk = nodeModules(1526);
    const source = Array.from({ length: 74 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: junk, tracked: [...junk, ...source], ignored: isNodeModules }),
      repoPath: '/repo/libs/ui-primitives',
    });
    // Pre-fix this was 1526 offenders and a 33-hour commit stall.
    expect(offenders).toEqual([]);
  });

  it('does not let ignored junk INFLATE the denominator and hide a real wipe', async () => {
    // 20 source files, ALL deleted, alongside 1000 ignored node_modules files that
    // are NOT deleted. Counting them, the ratio is 20/1020 = 2% — comfortably
    // "fine". Discounting them, it is 20/20 = a wipe, which is the truth.
    const source = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({ deleted: source, tracked: [...source, ...nodeModules(1000)], ignored: isNodeModules }),
      repoPath: '/repo',
    });
    expect(offenders).toHaveLength(20);
  });

  it('still catches a REAL wipe: when .gitignore goes too, nothing reads as ignored', async () => {
    // The actual 2026-08-15 signature — the .gitignore is deleted WITH everything
    // else, so the ignore rules are gone and the discount cannot apply.
    const tracked = ['.gitignore', 'package.json', ...Array.from({ length: 19 }, (_, i) => `src/f${i}.ts`)];
    const offenders = await detectWholesaleDeletion({
      // ignored: () => false — a deleted .gitignore ignores nothing.
      runGit: fakeGit({ deleted: tracked, tracked }),
      repoPath: '/repo',
    });
    expect(offenders).toHaveLength(tracked.length);
  });

  it('a package-defining deletion stays decisive even if an ignore rule covers it', async () => {
    // Defence in depth: a pathological .gitignore must not be able to buy silence
    // on the one signal that is catastrophic independent of ratio.
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({
        deleted: ['package.json'],
        tracked: ['package.json', ...Array.from({ length: 99 }, (_, i) => `src/f${i}.ts`)],
        ignored: (p) => p === 'package.json',
      }),
      repoPath: '/repo',
    });
    expect(offenders.map((o) => o.file)).toEqual(['package.json']);
  });

  it('FAILS OPEN (counts everything) when check-ignore errors — never toward committing a wipe', async () => {
    const junk = nodeModules(1526);
    const source = Array.from({ length: 74 }, (_, i) => `src/f${i}.ts`);
    const offenders = await detectWholesaleDeletion({
      runGit: fakeGit({
        deleted: junk,
        tracked: [...junk, ...source],
        ignored: isNodeModules,
        checkIgnoreCode: 128,
      }),
      repoPath: '/repo',
    });
    // No ignore information ⇒ the pre-WI-39889 behaviour, which quarantines.
    expect(offenders).toHaveLength(1526);
  });

  it('asks check-ignore with --no-index, or every answer would be "not ignored"', async () => {
    // Every path this guard asks about is tracked at HEAD by construction, and
    // WITHOUT --no-index git reports a tracked path as not-ignored. Losing this flag
    // silently reverts the whole fix while every other test still passes.
    const seen: string[][] = [];
    const junk = nodeModules(3);
    await detectWholesaleDeletion({
      runGit: async (args) => {
        if (args[0] === 'status') return { code: 0, stdout: porcelainDeleted(junk), stderr: '' };
        if (args[0] === 'ls-tree') return { code: 0, stdout: nulList([...junk, 'src/a.ts']), stderr: '' };
        seen.push(args);
        return { code: 1, stdout: '', stderr: '' };
      },
      repoPath: '/repo',
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) expect(args).toContain('--no-index');
  });

  it('chunks a huge path set instead of blowing ARG_MAX in one argv', async () => {
    const junk = nodeModules(1526);
    let maxArgv = 0;
    await detectWholesaleDeletion({
      runGit: async (args) => {
        if (args[0] === 'status') return { code: 0, stdout: porcelainDeleted(junk), stderr: '' };
        if (args[0] === 'ls-tree') return { code: 0, stdout: nulList(junk), stderr: '' };
        maxArgv = Math.max(maxArgv, args.length);
        return { code: 1, stdout: '', stderr: '' };
      },
      repoPath: '/repo',
    });
    expect(maxArgv).toBeLessThan(600);
  });
});

/**
 * WI-6554700010010783 — the discount above was dead on real Git.
 *
 * `ignoredSubset` passed `-z` with argv paths. Git 2.43 rejects that without
 * `--stdin`, so every call exited 128, the guard failed open, and the WI-39889
 * discount never applied. The fake RunGit accepted `-z`, which is why every test
 * above stayed green. These tests run the detector against REAL Git.
 */
describe('WI-6554700010010783 — the ignored-path discount works against real Git', () => {
  let repo = '';
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = '';
  });

  // Neutralize the host's global ignore file and signing config so only the repo's
  // own .gitignore decides what is ignored.
  const HERMETIC = ['-c', 'core.excludesFile=/dev/null', '-c', 'commit.gpgsign=false'];
  const git = (...args: string[]) =>
    execFileSync('git', [...HERMETIC, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });

  /** A real RunGit that records every check-ignore exit code it saw. */
  function recordingRealGit(): { runGit: RunGit; checkIgnoreCodes: number[]; calls: string[][] } {
    const checkIgnoreCodes: number[] = [];
    const calls: string[][] = [];
    const runGit: RunGit = async (args, cwd) => {
      const r = spawnSync('git', [...HERMETIC, ...args], { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      const code = r.status ?? -1;
      calls.push([...args]);
      if (args[0] === 'check-ignore') checkIgnoreCodes.push(code);
      return { code, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    };
    return { runGit, checkIgnoreCodes, calls };
  }

  /** 21 force-tracked node_modules files (one non-ASCII), 4 source files, `node_modules/` ignored. */
  function seedRepoWithTrackedNodeModules(): string[] {
    repo = mkdtempSync(join(tmpdir(), 'wholesale-deletion-real-git-'));
    git('init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'package.json'), '{}\n');
    mkdirSync(join(repo, 'src'));
    for (const f of ['a.ts', 'b.ts']) writeFileSync(join(repo, 'src', f), 'x\n');
    const junk: string[] = [];
    for (let i = 0; i < 20; i++) junk.push(`node_modules/pkg${i}/index.js`);
    junk.push('node_modules/ü/index.js'); // C-quoted by Git: exercises the one-path probe
    for (const p of junk) {
      mkdirSync(join(repo, p, '..'), { recursive: true });
      writeFileSync(join(repo, p), 'x\n');
    }
    git('add', '.gitignore', 'package.json', 'src');
    git('add', '-f', 'node_modules');
    git('commit', '-qm', 'seed with node_modules tracked by mistake');
    return junk;
  }

  it('discounts an untracking repair: deleting tracked-but-ignored node_modules is not a wipe', async () => {
    const junk = seedRepoWithTrackedNodeModules();
    rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
    const { runGit, checkIgnoreCodes, calls } = recordingRealGit();

    const offenders = await detectWholesaleDeletion({ runGit, repoPath: repo });

    // 21 of 25 tracked files deleted is 84%: before the fix every check-ignore exited
    // 128, nothing was discounted, and all 21 deletions were quarantined.
    expect(offenders).toEqual([]);
    expect(checkIgnoreCodes.length).toBeGreaterThan(0);
    expect(checkIgnoreCodes.every((code) => code === 0 || code === 1)).toBe(true);
    // Every verbatim name rode ONE batched call; only the C-quoted name was probed alone.
    const checkIgnoreCalls = calls.filter((args) => args[0] === 'check-ignore');
    expect(checkIgnoreCalls).toHaveLength(2);
    expect(checkIgnoreCalls[1]).toEqual(['check-ignore', '--no-index', '--', 'node_modules/ü/index.js']);
    expect(junk.every((p) => checkIgnoreCalls.some((args) => args.includes(p)))).toBe(true);
  });

  it('CONTROL: still quarantines a real wipe on the same repo when .gitignore goes too', async () => {
    seedRepoWithTrackedNodeModules();
    for (const p of ['.gitignore', 'src', 'node_modules']) rmSync(join(repo, p), { recursive: true, force: true });
    const { runGit, checkIgnoreCodes } = recordingRealGit();

    const offenders = await detectWholesaleDeletion({ runGit, repoPath: repo });

    // .gitignore gone, so nothing reads as ignored: 24 of 25 deleted (96%).
    expect(offenders).toHaveLength(24);
    expect(offenders.map((o) => o.file)).toContain('node_modules/ü/index.js');
    expect(checkIgnoreCodes.every((code) => code === 0 || code === 1)).toBe(true);
  });

  it('FAILS OPEN on a failed batch without re-probing every path one by one', async () => {
    const junk = Array.from({ length: 300 }, (_, i) => `node_modules/pkg${i}/index.js`);
    const checkIgnoreCalls: string[][] = [];
    const offenders = await detectWholesaleDeletion({
      runGit: async (args) => {
        if (args[0] === 'status') return { code: 0, stdout: porcelainDeleted(junk), stderr: '' };
        if (args[0] === 'ls-tree') return { code: 0, stdout: nulList([...junk, 'src/a.ts']), stderr: '' };
        checkIgnoreCalls.push(args);
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      },
      repoPath: '/repo',
    });
    expect(offenders).toHaveLength(300); // no ignore information: count everything
    expect(checkIgnoreCalls.length).toBeLessThanOrEqual(2); // batches only, no 301 single probes
  });
});

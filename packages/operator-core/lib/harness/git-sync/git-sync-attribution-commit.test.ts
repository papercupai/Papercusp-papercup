import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAttributedGroups, dirtyFiles, type RunGit } from './run-git-sync';
import type { FileAttribution } from './git-sync-attribution';

type GitResult = { code: number; stdout: string; stderr: string };

/**
 * A scripted git for the attributed-commit plumbing (WI-10006705: private index,
 * write-tree / commit-tree / update-ref CAS, shared-index refresh).
 */
function fakeGit(opts: {
  porcelain?: string;
  addResults?: Array<Partial<GitResult>>;
  /** Results for `commit-tree`; default prints `new-commit`. */
  commitResults?: Array<Partial<GitResult>>;
  /** Results for `update-ref` (the HEAD CAS); default succeeds. */
  updateRefResults?: Array<Partial<GitResult>>;
  /** Results for the shared-index refresh `reset`; default succeeds. */
  resetResults?: Array<Partial<GitResult>>;
  /** WI-38594: stdout for the per-group `git diff --cached --numstat` read. */
  numstat?: string;
  /** The private index's `write-tree`; equal to `tree-base` means nothing to commit. */
  writeTree?: string;
  /** Simulates a wrapping runner that drops `options.env`. */
  ignoreEnv?: boolean;
  /** WI-10006519: answer for `rev-parse --absolute-git-dir` (the stale-lock recovery
   *  looks for `<gitDir>/index.lock`). Defaults to a path that does not exist. */
  gitDir?: string;
}): { runGit: RunGit; calls: string[][]; envs: Array<Readonly<Record<string, string>> | undefined> } {
  const calls: string[][] = [];
  const envs: Array<Readonly<Record<string, string>> | undefined> = [];
  const next = (list: Array<Partial<GitResult>> | undefined, idx: number, dflt: Partial<GitResult>): GitResult => {
    const r = list?.[idx] ?? dflt;
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  let addIdx = 0;
  let commitIdx = 0;
  let updateIdx = 0;
  let resetIdx = 0;
  const runGit: RunGit = async (args, _cwd, options) => {
    calls.push(args);
    envs.push(options?.env);
    if (args[0] === 'status') return { code: 0, stdout: opts.porcelain ?? '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('--absolute-git-dir')) {
      return { code: 0, stdout: `${opts.gitDir ?? '/nonexistent-git-sync-attribution-test/.git'}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args.includes('--git-path')) {
      const index = opts.ignoreEnv ? undefined : options?.env?.GIT_INDEX_FILE;
      return { code: 0, stdout: `${index ?? '.git/index'}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}')) return { code: 0, stdout: 'base-commit\n', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('base-commit^{tree}')) return { code: 0, stdout: 'tree-base\n', stderr: '' };
    if (args[0] === 'read-tree') return { code: 0, stdout: '', stderr: '' };
    // WI-6554700010018197: the vanished-path probe. '/repo' has no files on disk, so every
    // group path reaches this probe; answer as if each is tracked in the private index.
    if (args[0] === 'ls-files' && !args.includes('--stage')) {
      const paths = args.slice(args.indexOf('--') + 1);
      return { code: 0, stdout: paths.map((p) => `${p}\0`).join(''), stderr: '' };
    }
    if (args[0] === 'add') return next(opts.addResults, addIdx++, { code: 0 });
    if (args[0] === 'write-tree') return { code: 0, stdout: `${opts.writeTree ?? 'tree-new'}\n`, stderr: '' };
    if (args[0] === 'diff' && args.includes('--numstat')) return { code: 0, stdout: opts.numstat ?? '', stderr: '' };
    if (args[0] === 'diff' && args.includes('--name-only')) return { code: 0, stdout: 'a.ts\0', stderr: '' };
    if (args.includes('commit-tree')) return next(opts.commitResults, commitIdx++, { code: 0, stdout: 'new-commit\n' });
    if (args[0] === 'update-ref') return next(opts.updateRefResults, updateIdx++, { code: 0 });
    if (args[0] === 'reset') return next(opts.resetResults, resetIdx++, { code: 0 });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runGit, calls, envs };
}

const MSG = 'chore(git-sync): auto-commit papercup [skip ci]';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A real git runner that forwards `options.env`, as the production runners do. */
const realRunGit: RunGit = (args, cwd, options) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options?.env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await realRunGit(args, repo);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with one commit (base.ts), ready for attributed work on top. */
async function seededRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(repo);
  await git(repo, 'init', '-q');
  await writeFile(join(repo, 'base.ts'), 'export const base = 0;\n');
  await git(repo, 'add', 'base.ts');
  await git(repo, ...ID, 'commit', '-qm', 'base');
  return repo;
}

describe('dirtyFiles (-z porcelain parse)', () => {
  it('lists modified/untracked/deleted paths and skips a rename origin', async () => {
    // ` M a.ts` modified, `?? b.ts` untracked, `R  new.ts`\0`old.ts` rename, ` D gone.ts` deleted.
    const porcelain = ' M a.ts\0?? b.ts\0R  new.ts\0old.ts\0 D gone.ts\0';
    const { runGit } = fakeGit({ porcelain });
    expect(await dirtyFiles(runGit, '/repo')).toEqual(['a.ts', 'b.ts', 'new.ts', 'gone.ts']);
  });
});

describe('commitAttributedGroups (P-004 + WI-38594 diff subjects)', () => {
  it('peels per-agent commits (diff subject + [skip ci], intent in the body, Co-Authored-By) after the anonymous residual', async () => {
    const { runGit, calls, envs } = fakeGit({
      porcelain: ' M a.ts\0 M b.ts\0 M c.ts\0',
      numstat: '10\t2\ta.ts\n5\t1\tb.ts\n',
    });
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'fix a' }],
      ['b.ts', { agent: 'ag1', intent: 'fix a' }],
      // c.ts unattributed → the anonymous residual, committed FIRST (0eacc351a9)
    ]);
    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);

    expect(res).toEqual({ committedAny: true, committedCount: 2, agentGroupCount: 1, agentCommitCount: 1 });
    // the residual stages c.ts, then ag1 stages exactly its files (sorted) — each into a PRIVATE index
    const addIdxs = calls.flatMap((c, i) => (c[0] === 'add' ? [i] : []));
    expect(addIdxs.map((i) => calls[i])).toEqual([
      ['add', '--', 'c.ts'],
      ['add', '--', 'a.ts', 'b.ts'],
    ]);
    const addIdx = addIdxs[1]!;
    expect(envs[addIdx]?.GIT_INDEX_FILE).toMatch(/papercusp-git-sync-attributed-.*\.index$/);
    // WI-38594: numstat read is scoped to the group's just-staged files, against the base
    const numstat = calls.find((c) => c[0] === 'diff' && c.includes('--numstat') && c.includes('a.ts'))!;
    expect(numstat).toEqual(['diff', '--cached', '--numstat', 'base-commit', '--', 'a.ts', 'b.ts']);
    // the per-agent commit: DIFF subject WITH the [skip ci] marker, intent line as the
    // first body paragraph, + a Co-Authored-By trailer, parented on the CAS base
    const commits = calls.filter((c) => c.includes('commit-tree'));
    expect(commits).toHaveLength(2);
    expect(commits[0]!.some((a) => a.startsWith('Co-Authored-By:'))).toBe(false); // the residual is anonymous
    const commit = commits[1]!;
    expect(commit).toEqual(expect.arrayContaining(['commit-tree', 'tree-new', '-p', 'base-commit']));
    expect(commit).toContain('sync(root): a.ts, b.ts (2 files, +15/-3) [skip ci]');
    expect(commit).toContain('fix a'); // demoted to the body, not lost
    expect(commit).toContain('Co-Authored-By: ag1 <ag1@agents.papercusp>');
    // WI-10006850: the shared index is refreshed for the committed paths (literally, on the
    // SHARED index) BEFORE the commit is published with a CAS on the base
    const casIdx = calls.findIndex((c) => c[0] === 'update-ref');
    expect(calls[casIdx]!.slice(-3)).toEqual(['HEAD', 'new-commit', 'base-commit']);
    const resetIdx = calls.findIndex((c) => c[0] === 'reset');
    expect(calls[resetIdx]).toEqual(['reset', '-q', 'new-commit', '--', 'a.ts']);
    expect(envs[resetIdx]?.GIT_INDEX_FILE).toBeUndefined();
    expect(envs[resetIdx]?.GIT_LITERAL_PATHSPECS).toBe('1');
    expect(resetIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeLessThan(casIdx);
    // exactly ONE attributed commit (the other is c.ts's anonymous residual)
    expect(commits.filter((c) => c.includes('Co-Authored-By: ag1 <ag1@agents.papercusp>'))).toHaveLength(1);
    // no `git commit` of the shared index at all
    expect(calls.some((c) => c.includes('commit'))).toBe(false);
  });

  it('diffSubjects:false preserves the pre-WI-38594 intent subject byte-identically (kill-switch)', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'fix a' }]]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG, { diffSubjects: false });
    const commit = calls.find((c) => c.includes('commit-tree'))!;
    expect(commit).toContain('fix a [skip ci]');
    // no numstat read, no body demotion on the OFF path
    expect(calls.some((c) => c[0] === 'diff' && c.includes('--numstat'))).toBe(false);
    expect(commit.filter((a) => a === 'fix a')).toHaveLength(0);
  });

  it('is a no-op when nothing is attributed (flag-OFF degradation): no add, no commit', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0 M b.ts\0' });
    const res = await commitAttributedGroups(runGit, '/repo', new Map(), [], MSG);
    expect(res).toEqual({ committedAny: false, committedCount: 0, agentGroupCount: 0, agentCommitCount: 0 });
    expect(calls.some((c) => c[0] === 'add' || c.includes('commit-tree') || c[0] === 'read-tree')).toBe(false);
  });

  it('publishes nothing while the SHARED index.lock is fresh, and never removes that lock', async () => {
    // WI-10006519 + WI-10006705: a fresh lock is a live writer's. The private-index add and
    // commit do not need it; only the shared-index refresh does, and that retries a bounded
    // number of times without ever unlinking the lock. WI-10006850: the refresh runs BEFORE
    // the CAS, so when it fails nothing is published and the phase errors (the caller falls
    // through to the catch-all). Before, the commit landed and the shared index kept the
    // pre-commit blobs under the new HEAD.
    const gitDir = await mkdtemp(join(tmpdir(), 'gs-attr-fresh-'));
    tmpDirs.push(gitDir);
    await writeFile(join(gitDir, 'index.lock'), '');
    const lockErr = { code: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists" };
    const { runGit, calls } = fakeGit({
      porcelain: ' M a.ts\0 M b.ts\0',
      resetResults: Array.from({ length: 8 }, () => lockErr),
      gitDir,
    });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'fix a' }]]);
    const logs: string[] = [];

    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG, { log: (m) => logs.push(m) });

    expect(res.committedAny).toBe(false);
    expect(res.committedCount).toBe(0);
    // WI-6554700010018197: the residual (b.ts) fails first, and ag1 is still attempted.
    expect(res.groupFailures?.map((f) => f.agent)).toEqual([null, 'ag1']);
    expect(res.error).toMatch(/residual catch-all not published: the shared index could not be refreshed/);
    expect(res.error).toMatch(/attributed commit for ag1 not published: the shared index could not be refreshed/);
    expect(calls.filter((c) => c[0] === 'add')).toEqual([['add', '--', 'b.ts'], ['add', '--', 'a.ts']]);
    expect(calls.filter((c) => c[0] === 'reset')).toHaveLength(8); // per group: first try + 3 bounded retries
    expect(calls.some((c) => c[0] === 'update-ref')).toBe(false); // nothing published
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(true);
    expect(logs.some((m) => m.includes('FRESH'))).toBe(true);
  });

  it('a live index.lock leaves HEAD, the lock and the shared index untouched (WI-10006850, real git)', async () => {
    // The recurrence guard on a real repository: a live writer holds the SHARED index.lock
    // while an attributed group commits. Its private index needs no shared lock, so the
    // commit object is built, but the shared-index refresh cannot run and nothing is
    // published.
    const repo = await seededRepo('gs-attr-live-lock-');
    await writeFile(join(repo, 'base.ts'), 'export const base = 1;\n');
    const head = await git(repo, 'rev-parse', 'HEAD');
    const lockPath = join(repo, '.git', 'index.lock');
    await writeFile(lockPath, '');
    const attribution = new Map<string, FileAttribution>([['base.ts', { agent: 'ag1', intent: 'bump base' }]]);
    const logs: string[] = [];

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, { log: (m) => logs.push(m) });

    expect(res.committedAny).toBe(false);
    expect(res.error).toMatch(/not published: the shared index could not be refreshed/);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(lockPath)).toBe(true);
    await rm(lockPath);
    // The shared index still holds HEAD's blob: the edit is an UNSTAGED change, never a staged revert.
    expect(await git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(await git(repo, 'status', '--porcelain', '--', 'base.ts')).toBe('M base.ts');
  });

  it('skips excluded (oversized/content) files even when attributed', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0 M big.bin\0' });
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'work' }],
      ['big.bin', { agent: 'ag1', intent: 'work' }],
    ]);
    await commitAttributedGroups(runGit, '/repo', attribution, ['big.bin'], MSG);
    const add = calls.find((c) => c[0] === 'add')!;
    expect(add).toEqual(['add', '--', 'a.ts']); // big.bin excluded
  });

  it('surfaces a real commit failure as an error, and treats an unchanged tree as nothing to commit', async () => {
    const { runGit } = fakeGit({
      porcelain: ' M a.ts\0',
      commitResults: [{ code: 1, stderr: 'error: gpg failed to sign the data' }],
    });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    expect(res.error).toMatch(/attributed commit for ag1 failed: .*gpg failed/);
    expect(res.groupFailures).toHaveLength(1);

    // The guard held everything back: the private tree equals the base tree.
    const { runGit: g2, calls: calls2 } = fakeGit({ porcelain: ' M a.ts\0', writeTree: 'tree-base' });
    const res2 = await commitAttributedGroups(g2, '/repo', attribution, [], MSG);
    expect(res2).toEqual({ committedAny: false, committedCount: 0, agentGroupCount: 1, agentCommitCount: 0 }); // benign — no error
    expect(calls2.some((c) => c.includes('commit-tree') || c[0] === 'update-ref')).toBe(false);
  });

  it('emits Papercusp-Agent/Work-Item/Session/Plan trailers when the attribution carries them (P-004 attribution)', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'fix a', workItems: ['WI-1', 'WI-2'], sessionId: 'sess-9', planSlug: 'plan-x' }],
    ]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    const commit = calls.find((c) => c.includes('commit-tree'))!;
    expect(commit).toContain('Papercusp-Agent: ag1');
    expect(commit).toContain('Papercusp-Work-Item: WI-1, WI-2');
    expect(commit).toContain('Papercusp-Session: sess-9');
    expect(commit).toContain('Papercusp-Plan: plan-x');
    // still carries a subject (diff-derived; empty numstat → no ±counts), the intent
    // body, + Co-Authored-By
    expect(commit).toContain('sync(root): a.ts (1 file) [skip ci]');
    expect(commit).toContain('fix a');
    expect(commit).toContain('Co-Authored-By: ag1 <ag1@agents.papercusp>');
  });

  it('emits Papercusp-Agent but NO Work-Item/Session/Plan trailers when the attribution lacks them', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    const commit = calls.find((c) => c.includes('commit-tree'))!;
    expect(commit).toContain('Papercusp-Agent: ag1');
    expect(commit.some((a) => a.startsWith('Papercusp-Work-Item:'))).toBe(false);
    expect(commit.some((a) => a.startsWith('Papercusp-Session:'))).toBe(false);
    expect(commit.some((a) => a.startsWith('Papercusp-Plan:'))).toBe(false);
  });

  it('creates separate commits when one agent edited files under different work-items', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M old.ts\0 M new.ts\0' });
    const attribution = new Map<string, FileAttribution>([
      ['old.ts', { agent: 'ag1', intent: 'old lane', workItems: ['WI-40700'] }],
      ['new.ts', { agent: 'ag1', intent: 'new lane', workItems: [] }],
    ]);

    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);

    const commits = calls.filter((c) => c.includes('commit-tree'));
    expect(commits).toHaveLength(2);
    const oldCommit = commits.find((c) => c.includes('old lane'))!;
    const newCommit = commits.find((c) => c.includes('new lane'))!;
    expect(oldCommit).toContain('Papercusp-Work-Item: WI-40700');
    expect(newCommit.some((a) => a.startsWith('Papercusp-Work-Item:'))).toBe(false);
  });
});

describe('commitAttributedGroups private index (WI-10006705)', () => {
  it('refuses the phase, touching no index, when the runner drops GIT_INDEX_FILE', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0', ignoreEnv: true });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    expect(res.committedCount).toBe(0);
    expect(res.error).toMatch(/did not forward GIT_INDEX_FILE/);
    expect(calls.some((c) => ['read-tree', 'add', 'reset', 'update-ref'].includes(c[0]))).toBe(false);
  });

  it('hands the guard the private-index runner', async () => {
    const { runGit } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    // The handed runner injects the private index into whatever runner it wraps.
    const probe: string[] = [];
    await commitAttributedGroups(
      async (args, cwd, options) => {
        if (args[0] === 'diff' && args.includes('--name-only') && args.includes('--cached')) {
          probe.push(options?.env?.GIT_INDEX_FILE ?? 'SHARED');
        }
        return runGit(args, cwd, options);
      },
      '/repo',
      attribution,
      [],
      MSG,
      {
        beforeCommit: async (privateRunGit) => {
          await privateRunGit(['diff', '--cached', '--name-only', '-z'], '/repo');
          return { ok: true };
        },
      },
    );
    expect(probe).toHaveLength(1);
    expect(probe[0]).toMatch(/papercusp-git-sync-attributed-.*\.index$/);
  });

  it('does not carry a path a peer pre-staged in the shared index (real git)', async () => {
    // 84959c3039: a per-agent commit also swept apps/operator/lib/psu-pty-host.integration.test.ts,
    // which something else had staged, because `git commit` records the whole shared index.
    const repo = await seededRepo('gs-attr-foreign-');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'foreign.ts'), 'export const foreign = 1;\n');
    await git(repo, 'add', 'foreign.ts'); // a peer's pre-staged path
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'add a' }]]);

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG);

    // The unattributed foreign.ts is the anonymous residual (committed first, 0eacc351a9);
    // the agent's commit carries only its own file.
    expect(res).toEqual({ committedAny: true, committedCount: 2, agentGroupCount: 1, agentCommitCount: 1 });
    expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.ts');
    expect(await git(repo, 'log', '-1', '--format=%(trailers:key=Papercusp-Agent,valueonly)')).toBe('ag1');
    expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD~1')).toBe('foreign.ts');
    expect(await git(repo, 'log', '-1', '--format=%(trailers:key=Papercusp-Agent,valueonly)', 'HEAD~1')).toBe('');
    // Both are clean in the shared index.
    expect(await git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(await git(repo, 'status', '--porcelain', '--', 'a.ts')).toBe('');
  });

  it('refuses to publish when HEAD moves between the guard and the commit (update-ref CAS, real git)', async () => {
    const repo = await seededRepo('gs-attr-cas-');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'add a' }]]);
    const logs: string[] = [];

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, {
      log: (m) => logs.push(m),
      beforeCommit: async () => {
        await git(repo, ...ID, 'commit', '-q', '--allow-empty', '-m', 'concurrent');
        return { ok: true };
      },
    });

    // The group formed but the CAS refused its publish: agent work, no attributed commit.
    expect(res).toEqual({ committedAny: false, committedCount: 0, agentGroupCount: 1, agentCommitCount: 0 });
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('concurrent');
    expect(await git(repo, 'ls-tree', '--name-only', 'HEAD')).toBe('base.ts');
    // WI-10006850: the shared index was refreshed BEFORE the CAS, so a.ts is staged as the
    // unpublished commit had it. That entry equals the working tree (the catch-all's
    // documented benign case) and the file stays uncommitted for the catch-all / next tick.
    expect(await git(repo, 'status', '--porcelain', '--', 'a.ts')).toBe('A  a.ts');
    expect(await git(repo, 'diff', '--name-only', '--', 'a.ts')).toBe('');
    expect(logs.some((m) => m.includes('update-ref CAS refused'))).toBe(true);
  });

  it('never commits a path the guard held back, even if a peer re-stages it in the shared index (real git)', async () => {
    // The incident: the guard flagged an importer of an untracked module, a concurrent
    // writer changed the shared index between the guard's reads, and the commit carried it.
    const repo = await seededRepo('gs-attr-held-');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'importer.ts'), "import { m } from './untracked-module';\nexport { m };\n");
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'work' }],
      ['importer.ts', { agent: 'ag1', intent: 'work' }],
    ]);

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, {
      beforeCommit: async (privateRunGit) => {
        // The guard holds the importer back in the index it was handed ...
        const held = await privateRunGit(['reset', '-q', 'HEAD', '--', 'importer.ts'], repo);
        if (held.code !== 0) return { ok: false, error: held.stderr };
        // ... and a peer stages it in the SHARED index before the commit.
        await git(repo, 'add', 'importer.ts');
        return { ok: true };
      },
    });

    expect(res).toEqual({ committedAny: true, committedCount: 1, agentGroupCount: 1, agentCommitCount: 1 });
    expect(await git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.ts');
    expect(await git(repo, 'ls-tree', '--name-only', 'HEAD', '--', 'importer.ts')).toBe('');
  });
});

describe('commitAttributedGroups failure isolation (WI-6554700010018197, real git)', () => {
  /** HEAD's agent trailers, newest first, one per commit since `since`. */
  async function agentTrailersSince(repo: string, since: string): Promise<string[]> {
    const out = await git(repo, 'log', '--format=%(trailers:key=Papercusp-Agent,valueonly)%x00', `${since}..HEAD`);
    return out.split('\0').map((s) => s.trim());
  }

  it('a path staged only in the shared index (vanished from the tree) no longer voids every agent commit', async () => {
    // 2026-10-16T17:32Z to 2026-10-20T06:48Z: `.papercusp/dependency-exact-ref/<id>/.live-inputs`
    // was in the shared index (status `AD`) and nowhere else, so the residual group's
    // `git add` failed on every tick and no agent group in the superproject ever ran.
    const repo = await seededRepo('gs-attr-phantom-');
    const base = await git(repo, 'rev-parse', 'HEAD');
    const phantom = '.papercusp/dependency-exact-ref/dfe61ecab92471fe.zptG8U/.live-inputs';
    await mkdir(join(repo, '.papercusp/dependency-exact-ref/dfe61ecab92471fe.zptG8U'), { recursive: true });
    await writeFile(join(repo, phantom), 'tmp\n');
    await git(repo, 'add', phantom);
    await rm(join(repo, '.papercusp'), { recursive: true });
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
    await writeFile(join(repo, 'loose.ts'), 'export const loose = 1;\n');
    expect(await git(repo, 'status', '--porcelain', '--', phantom)).toBe(`AD ${phantom}`);
    // Positive control: the phantom really does fail an add into a HEAD-seeded index.
    const seededIndex = join(repo, '.git', 'probe.index');
    const probeGit: RunGit = (args, cwd) => realRunGit(args, cwd, { env: { GIT_INDEX_FILE: seededIndex } });
    expect((await probeGit(['read-tree', 'HEAD'], repo)).code).toBe(0);
    const control = await probeGit(['add', '--', phantom, 'loose.ts'], repo);
    expect(control.code).not.toBe(0);
    expect(control.stderr).toMatch(/did not match any files/);
    await rm(seededIndex, { force: true });

    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'add a' }],
      ['b.ts', { agent: 'ag2', intent: 'add b' }],
    ]);
    const logs: string[] = [];
    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, { log: (m) => logs.push(m) });

    expect(res).toEqual({ committedAny: true, committedCount: 3, agentGroupCount: 2, agentCommitCount: 2 }); // residual + ag1 + ag2
    expect((await agentTrailersSince(repo, base)).filter(Boolean).sort()).toEqual(['ag1', 'ag2']);
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('a.ts\nb.ts\nbase.ts\nloose.ts');
    expect(logs.some((m) => m.includes('dropped 1 path(s)') && m.includes(phantom))).toBe(true);
  });

  it('keeps a real deletion (gone from the tree, present in HEAD) in its group', async () => {
    const repo = await seededRepo('gs-attr-delete-');
    await rm(join(repo, 'base.ts'));
    const attribution = new Map<string, FileAttribution>([['base.ts', { agent: 'ag1', intent: 'drop base' }]]);

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG);

    expect(res).toEqual({ committedAny: true, committedCount: 1, agentGroupCount: 1, agentCommitCount: 1 });
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
    expect(await git(repo, 'log', '-1', '--format=%(trailers:key=Papercusp-Agent,valueonly)')).toBe('ag1');
  });

  it('a failing group is skipped and reported, and every later group still commits with its trailer', async () => {
    const repo = await seededRepo('gs-attr-isolate-');
    const base = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'loose.ts'), 'export const loose = 1;\n'); // the residual, which runs first
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'add a' }],
      ['b.ts', { agent: 'ag2', intent: 'add b' }],
    ]);

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, {
      // The guard fails the residual group, which used to abort the phase before any agent ran.
      beforeCommit: async (privateRunGit) => {
        const staged = await privateRunGit(['diff', '--cached', '--name-only'], repo);
        return staged.stdout.includes('loose.ts') ? { ok: false, error: 'post-stage guard could not read the index' } : { ok: true };
      },
    });

    expect(res.committedCount).toBe(2);
    expect(res.groupFailures).toEqual([{ agent: null, files: 1, error: 'post-stage guard could not read the index' }]);
    expect(res.error).toBe('1 of 3 group(s) failed: post-stage guard could not read the index');
    expect((await agentTrailersSince(repo, base)).filter(Boolean).sort()).toEqual(['ag1', 'ag2']);
    // The failed group's file stays dirty for the caller's catch-all.
    expect(await git(repo, 'status', '--porcelain', '--', 'loose.ts')).toBe('?? loose.ts');
  });

  it('a failing per-agent group mid-loop does not stop the agent groups after it', async () => {
    const repo = await seededRepo('gs-attr-isolate-agent-');
    const base = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
    await writeFile(join(repo, 'c.ts'), 'export const c = 1;\n');
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'add a' }],
      ['b.ts', { agent: 'ag2', intent: 'add b' }],
      ['c.ts', { agent: 'ag3', intent: 'add c' }],
    ]);

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, {
      beforeCommit: async (privateRunGit) => {
        const staged = await privateRunGit(['diff', '--cached', '--name-only'], repo);
        return staged.stdout.includes('b.ts') ? { ok: false, error: 'ag2 guard refused' } : { ok: true };
      },
    });

    expect(res.committedCount).toBe(2);
    expect(res.groupFailures).toEqual([{ agent: 'ag2', files: 1, error: 'ag2 guard refused' }]);
    // WI-6554700010018198: the tally the zero-attribution detector reads.
    expect({ groups: res.agentGroupCount, commits: res.agentCommitCount }).toEqual({ groups: 3, commits: 2 });
    expect((await agentTrailersSince(repo, base)).filter(Boolean).sort()).toEqual(['ag1', 'ag3']);
    expect(await git(repo, 'status', '--porcelain', '--', 'b.ts')).toBe('?? b.ts');
  });
});

describe('commitAttributedGroups stale index.lock recovery (WI-10006519, real git)', () => {
  it('clears an aged, holderless index.lock and commits the attributed group instead of failing every tick', async () => {
    // 2026-10-06 07:09Z and 08:00Z: a 0-byte index.lock left by a killed git process made
    // the attributed `git add` fail on every git-sync tick. This is that state on disk.
    const repo = await mkdtemp(join(tmpdir(), 'gs-attr-stale-'));
    tmpDirs.push(repo);
    expect((await realRunGit(['init', '-q'], repo)).code).toBe(0);
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const lockPath = join(repo, '.git', 'index.lock');
    await writeFile(lockPath, '');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, tenMinutesAgo, tenMinutesAgo);
    // Positive control: with the orphan in place, a plain add really does fail.
    const plain = await realRunGit(['add', '--', 'src/a.ts'], repo);
    expect(plain.code).not.toBe(0);
    expect(`${plain.stdout}${plain.stderr}`).toMatch(/index\.lock/);

    const attribution = new Map<string, FileAttribution>([['src/a.ts', { agent: 'ag1', intent: 'add a' }]]);
    const logs: string[] = [];
    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, { log: (m) => logs.push(m) });

    expect(res.error).toBeUndefined();
    expect(res.committedCount).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(logs.some((m) => m.includes('cleared STALE index.lock'))).toBe(true);
    const files = await realRunGit(['show', '--name-only', '--format=', 'HEAD'], repo);
    expect(files.stdout.trim()).toBe('src/a.ts');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributionTrailers, commitAttributedGroups, dirtyFiles, guardStagedIndexBeforeCommit, preserveVanishedStagedSources, SOURCE_CUSTODY_REF_PREFIX, type RunGit } from './run-git-sync';
import type { FileAttribution } from './git-sync-attribution';

type GitResult = { code: number; stdout: string; stderr: string };

/** Every message line of a recorded commit-tree argv: the trailers travel as ONE `-m` paragraph. */
const messageLines = (commit: string[]): string[] => commit.flatMap((a) => a.split('\n'));

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

describe('source custody through real attributed commits', () => {
  const source = 'source [literal]\twith\nnewline.ts';
  const original = Buffer.from([0, 255, 128, 65, 10]);
  const owner = new Map<string, FileAttribution>([[source, { agent: 'author', intent: 'preserve source' }]]);

  async function vanished(mode = '100644', format = 'sha1'): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'gs-source-custody-'));
    tmpDirs.push(repo);
    await git(repo, 'init', '-q', `--object-format=${format}`);
    await writeFile(join(repo, 'base.ts'), 'base\n');
    await git(repo, 'add', 'base.ts');
    await git(repo, ...ID, 'commit', '-qm', 'base');
    if (mode === '120000') await symlink('missing-target', join(repo, source));
    else {
      await writeFile(join(repo, source), original);
      if (mode === '100755') await chmod(join(repo, source), 0o755);
    }
    await git(repo, 'add', '--', source);
    await rm(join(repo, source));
    return repo;
  }

  for (const format of ['sha1', 'sha256']) {
    it.each(['100644', '100755', '120000'].flatMap((mode) => ['known', 'unknown'].map((ownership) => [mode, ownership])))(`roots exact bytes, mode, metadata and an idempotent GC-safe receipt (%s, %s owner, ${format})`, async (mode, ownership) => {
      const repo = await vanished(mode, format);
      const attribution = ownership === 'known' ? owner : new Map();
      const before = await git(repo, 'rev-parse', 'HEAD');
      const staged = await git(repo, 'ls-files', '--stage');
      const result = await preserveVanishedStagedSources(realRunGit, repo, attribution);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.protectedPaths).toEqual([source]);
      expect(result.refs).toHaveLength(1);
      const ref = result.refs[0];
      expect(ref).toMatch(/^refs\/papercusp\/source-custody\/[a-f0-9]{64}$/);
      const manifest = JSON.parse(await git(repo, 'show', `${ref}:manifest.json`));
      expect(manifest).toMatchObject({ path: source, owner: ownership === 'known' ? 'author' : 'unknown', mode, base: before });
      expect((await git(repo, 'ls-tree', ref)).split('\n')).toHaveLength(2);
      const expected = mode === '120000' ? Buffer.from('missing-target') : original;
      expect(execFileSync('git', ['cat-file', 'blob', `${ref}:payload`], { cwd: repo })).toEqual(expected);
      expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before);
      expect(await git(repo, 'ls-files', '--stage')).toBe(staged);
      expect(await preserveVanishedStagedSources(realRunGit, repo, attribution)).toEqual(result);
      expect((await git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).split('\n')).toEqual([ref]);
      await git(repo, 'update-index', '--force-remove', '--', source);
      await git(repo, 'reflog', 'expire', '--expire=now', '--all');
      await git(repo, 'gc', '--prune=now');
      expect(execFileSync('git', ['cat-file', 'blob', `${ref}:payload`], { cwd: repo })).toEqual(expected);
      expect(JSON.parse(await git(repo, 'show', `${ref}:manifest.json`))).toEqual(manifest);
    });
  }

  it('preserves unknown ownership while allowing an unrelated attribution group to commit', async () => {
    const repo = await vanished();
    await writeFile(join(repo, 'other.ts'), 'unrelated\n');
    const result = await commitAttributedGroups(realRunGit, repo, new Map([
      ['other.ts', { agent: 'other', intent: 'unrelated' }],
    ]), [], MSG);
    expect(result.error).toBeUndefined();
    expect(result.committedAny).toBe(true);
    expect(await git(repo, 'show', 'HEAD:other.ts')).toBe('unrelated');
    expect((await realRunGit(['cat-file', '-e', `HEAD:${source}`], repo)).code).not.toBe(0);
    const ref = await git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX);
    expect(JSON.parse(await git(repo, 'show', `${ref}:manifest.json`)).owner).toBe('unknown');
  });

  it.each(['blob', 'empty', 'manifest', 'payload', 'tree', 'ref', 'readback', 'env', 'throw'])(
    'refuses the whole attributed phase on %s failure without consuming the shared blob', async (failure) => {
      const repo = await vanished();
      await writeFile(join(repo, 'other.ts'), 'unrelated\n');
      const index = await git(repo, 'ls-files', '--stage');
      const head = await git(repo, 'rev-parse', 'HEAD');
      let hit = false;
      const calls: string[][] = [];
      const injected: RunGit = async (args, cwd, options) => {
        calls.push(args);
        const privateIndex = options?.env?.GIT_INDEX_FILE?.includes('source-custody');
        const fail = failure === 'blob' && args[0] === 'cat-file' && args[1] === '-t'
          || failure === 'empty' && privateIndex && args[0] === 'read-tree'
          || failure === 'manifest' && args[0] === 'hash-object'
          || failure === 'payload' && privateIndex && args[0] === 'update-index'
          || failure === 'tree' && privateIndex && args[0] === 'write-tree'
          || failure === 'ref' && args[0] === 'update-ref' && args[1].startsWith(SOURCE_CUSTODY_REF_PREFIX)
          || failure === 'readback' && args[0] === 'cat-file' && args[1] === 'blob'
          || failure === 'throw' && args[0] === 'cat-file';
        if (fail) {
          hit = true;
          if (failure === 'throw') throw new Error('RAW_SOURCE_MUST_NOT_LEAK');
          return { code: 1, stdout: 'RAW_SOURCE_MUST_NOT_LEAK', stderr: 'RAW_SOURCE_MUST_NOT_LEAK' };
        }
        if (failure === 'env' && options?.env?.GIT_INDEX_FILE) {
          hit = true;
          return realRunGit(args, cwd);
        }
        return realRunGit(args, cwd, options);
      };
      const result = await commitAttributedGroups(injected, repo, owner, [], MSG);
      expect(hit).toBe(true);
      expect(result.custodyFatal).toBe(true);
      expect(result.error).toMatch(/^source-custody-refused:/);
      expect(Buffer.byteLength(result.error!)).toBeLessThanOrEqual(1024);
      expect(result.error).not.toContain('RAW_SOURCE');
      expect(calls.some((args) => args[0] === 'add' || args[0] === 'reset' || args.includes('commit-tree'))).toBe(false);
      expect(await git(repo, 'ls-files', '--stage')).toBe(index);
      expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
    },
  );

  it('refuses a mismatched existing recovery ref instead of overwriting it', async () => {
    const repo = await vanished();
    const result = await preserveVanishedStagedSources(realRunGit, repo, owner);
    if (!result.ok) throw new Error(result.error);
    const wrong = await git(repo, 'rev-parse', 'HEAD^{tree}');
    await git(repo, 'update-ref', result.refs[0], wrong);
    expect(await preserveVanishedStagedSources(realRunGit, repo, owner)).toEqual({ ok: false, error: 'source-custody-refused:existing-ref-mismatch' });
    expect(await git(repo, 'rev-parse', result.refs[0])).toBe(wrong);
  });

  it('refuses a commit object masquerading as the exact custody tree', async () => {
    const repo = await vanished();
    const result = await preserveVanishedStagedSources(realRunGit, repo, owner);
    if (!result.ok) throw new Error(result.error);
    const tree = await git(repo, 'rev-parse', result.refs[0]);
    const commit = await git(repo, ...ID, 'commit-tree', tree, '-p', 'HEAD', '-m', 'wrong object type');
    await git(repo, 'update-ref', result.refs[0], commit);
    expect(await preserveVanishedStagedSources(realRunGit, repo, owner)).toEqual({ ok: false, error: 'source-custody-refused:existing-ref-mismatch' });
    expect(await git(repo, 'rev-parse', result.refs[0])).toBe(commit);
  });

  it.each(['known', 'unknown'].flatMap((ownership) => ['gitlink', 'unmerged'].map((mode) => [ownership, mode])))(
    'refuses %s-owner %s entries before any consuming write', async (ownership, mode) => {
      const repo = await vanished();
      const blob = await git(repo, 'rev-parse', `:${source}`);
      await git(repo, 'update-index', '--force-remove', '--', source);
      if (mode === 'gitlink') {
        await git(repo, 'update-index', '--add', '--cacheinfo', '160000', await git(repo, 'rev-parse', 'HEAD'), source);
      } else {
        execFileSync('git', ['update-index', '-z', '--index-info'], {
          cwd: repo, input: `100644 ${blob} 1\t${source}\0` + `100644 ${blob} 2\t${source}\0` + `100644 ${blob} 3\t${source}\0`,
        });
      }
      const staged = await git(repo, 'ls-files', '--stage', '-z');
      const calls: string[][] = [];
      const runner: RunGit = async (args, cwd, options) => {
        calls.push(args);
        return realRunGit(args, cwd, options);
      };
      const result = await commitAttributedGroups(runner, repo, ownership === 'known' ? owner : new Map(), [], MSG);
      expect(result.custodyFatal).toBe(true);
      expect(result.error).toBe(`source-custody-refused:${mode === 'gitlink' ? 'unsupported-index-mode' : 'unmerged-index-entry'}`);
      expect(calls.some((args) => ['add', 'reset', 'commit-tree'].includes(args[0]))).toBe(false);
      expect(await git(repo, 'ls-files', '--stage', '-z')).toBe(staged);
    },
  );

  it.each(['tracked-deletion', 'generated-phantom', 'no-index-entry'])(
    'keeps the ordinary %s behavior without claiming custody', async (kind) => {
      const repo = await vanished();
      await git(repo, 'update-index', '--force-remove', '--', source);
      const path = kind === 'tracked-deletion' ? 'base.ts'
        : kind === 'generated-phantom' ? '.papercusp/dependency-exact-ref/example/.live-inputs' : source;
      if (kind === 'tracked-deletion') await rm(join(repo, path));
      if (kind === 'generated-phantom') {
        await mkdir(join(repo, '.papercusp/dependency-exact-ref/example'), { recursive: true });
        await writeFile(join(repo, path), 'generated\n');
        await git(repo, 'add', '-f', '--', path);
        await rm(join(repo, path));
      }
      const logs: string[] = [];
      expect(await preserveVanishedStagedSources(realRunGit, repo, new Map([[path, { agent: 'author' }]]), (m) => logs.push(m)))
        .toEqual({ ok: true, protectedPaths: [], refs: [] });
      expect(logs).toEqual([]);
      expect(await git(repo, 'for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
      await writeFile(join(repo, 'other.ts'), 'export const other = true;\n');
      const result = await commitAttributedGroups(realRunGit, repo, new Map([
        [path, { agent: 'author' }], ['other.ts', { agent: 'other' }],
      ]), [], MSG);
      expect(result.error).toBeUndefined();
      expect(result.committedAny).toBe(true);
      expect(await git(repo, 'show', 'HEAD:other.ts')).toBe('export const other = true;');
      if (kind === 'tracked-deletion') expect((await realRunGit(['cat-file', '-e', 'HEAD:base.ts'], repo)).code).not.toBe(0);
    },
  );

  it.each(['wrong-payload', 'unrooted-manifest'])(
    'detects the %s persistence mutation before consuming shared evidence', async (mutation) => {
      const repo = await vanished();
      const staged = await git(repo, 'ls-files', '--stage');
      const wrong = await git(repo, 'rev-parse', 'HEAD:base.ts');
      let hit = false;
      const runner: RunGit = async (args, cwd, options) => {
        if (options?.env?.GIT_INDEX_FILE?.includes('source-custody') && args[0] === 'update-index') {
          hit = true;
          const changed = [...args];
          if (mutation === 'wrong-payload') changed[4] = wrong;
          else changed.splice(6);
          return realRunGit(changed, cwd, options);
        }
        return realRunGit(args, cwd, options);
      };
      const result = await commitAttributedGroups(runner, repo, owner, [], MSG);
      expect(hit).toBe(true);
      expect(result.custodyFatal).toBe(true);
      expect(result.error).toBe('source-custody-refused:recovery-ref-readback');
      expect(await git(repo, 'ls-files', '--stage')).toBe(staged);
    },
  );

  it.each(['same', 'different'].flatMap((kind) => ['deleted-snapshot', 'after-capture'].map((point) => [kind, point])))('leaves a %s-byte %s restoration pending without writing the worktree', async (kind, point) => {
    const repo = await vanished();
    await writeFile(join(repo, 'other.ts'), 'unrelated\n');
    const restored = kind === 'same' ? original : Buffer.from('a peer restored different bytes\n');
    let hit = false;
    const runner: RunGit = async (args, cwd, options) => {
      const r = await realRunGit(args, cwd, options);
      if (!hit && (point === 'after-capture' && args[0] === 'update-ref' && args[1].startsWith(SOURCE_CUSTODY_REF_PREFIX)
        || point === 'deleted-snapshot' && args[0] === 'ls-files' && args.includes('--deleted'))) {
        hit = true;
        await writeFile(join(repo, source), restored);
      }
      return r;
    };
    const result = await commitAttributedGroups(runner, repo, new Map([
      ...owner, ['other.ts', { agent: 'other', intent: 'unrelated' }],
    ]), [], MSG);
    expect(result.error).toBeUndefined();
    expect(hit).toBe(true);
    expect(await readFile(join(repo, source))).toEqual(restored);
    expect(await git(repo, 'status', '--porcelain', '--', source)).not.toBe('');
    expect((await realRunGit(['cat-file', '-e', `HEAD:${source}`], repo)).code).not.toBe(0);
  });
});

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
    expect(messageLines(commits[0]!).some((a) => a.startsWith('Co-Authored-By:'))).toBe(false); // the residual is anonymous
    const commit = commits[1]!;
    expect(commit).toEqual(expect.arrayContaining(['commit-tree', 'tree-new', '-p', 'base-commit']));
    expect(commit).toContain('sync(root): a.ts, b.ts (2 files, +15/-3) [skip ci]');
    expect(commit).toContain('fix a'); // demoted to the body, not lost
    expect(messageLines(commit)).toContain('Co-Authored-By: ag1 <ag1@agents.papercusp>');
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
    expect(commits.filter((c) => messageLines(c).includes('Co-Authored-By: ag1 <ag1@agents.papercusp>'))).toHaveLength(1);
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
    // WI-6554700010029864: ONE final paragraph, so git's trailer parser (last paragraph only) sees all of them.
    expect(commit[commit.length - 1]).toBe(
      [
        'Co-Authored-By: ag1 <ag1@agents.papercusp>',
        'Papercusp-Agent: ag1',
        'Papercusp-Work-Item: WI-1, WI-2',
        'Papercusp-Session: sess-9',
        'Papercusp-Plan: plan-x',
      ].join('\n'),
    );
    expect(commit[commit.length - 2]).toBe('-m');
    // still carries a subject (diff-derived; empty numstat → no ±counts) and the intent body
    expect(commit).toContain('sync(root): a.ts (1 file) [skip ci]');
    expect(commit).toContain('fix a');
  });

  it('emits Papercusp-Agent but NO Work-Item/Session/Plan trailers when the attribution lacks them', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    const commit = calls.find((c) => c.includes('commit-tree'))!;
    const lines = messageLines(commit);
    expect(lines).toContain('Papercusp-Agent: ag1');
    expect(lines.some((a) => a.startsWith('Papercusp-Work-Item:'))).toBe(false);
    expect(lines.some((a) => a.startsWith('Papercusp-Session:'))).toBe(false);
    expect(lines.some((a) => a.startsWith('Papercusp-Plan:'))).toBe(false);
  });

  it('names every author of a multi-author group and the absorbed unattributed files (D-001)', () => {
    const absorbed = Array.from({ length: 22 }, (_, i) => `gen/f${String(i).padStart(2, '0')}.d.mts`);
    expect(
      attributionTrailers({
        agent: 'ag1',
        agents: ['ag1', 'ag2'],
        coAuthor: 'ag1 <ag1@agents.papercusp>',
        coAuthors: ['ag1 <ag1@agents.papercusp>', 'Cup Two <ag2@agents.papercusp>'],
        files: ['a.ts', 'b.ts', ...absorbed],
        subject: 's',
        workItems: ['WI-1', 'WI-2'],
        absorbedUnattributed: absorbed,
      }),
    ).toEqual([
      'Co-Authored-By: ag1 <ag1@agents.papercusp>',
      'Co-Authored-By: Cup Two <ag2@agents.papercusp>',
      'Papercusp-Agent: ag1',
      'Papercusp-Agent: ag2',
      'Papercusp-Work-Item: WI-1, WI-2',
      `Papercusp-Unattributed-Files: ${absorbed.slice(0, 20).join(', ')} (+2 more)`,
    ]);
    // The anonymous residual carries no trailers at all.
    expect(attributionTrailers({ agent: null, files: ['x'], subject: 's', coAuthor: null })).toEqual([]);
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
    expect(messageLines(oldCommit)).toContain('Papercusp-Work-Item: WI-40700');
    expect(messageLines(newCommit).some((a) => a.startsWith('Papercusp-Work-Item:'))).toBe(false);
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

  it('writes trailers git itself parses when Work-Item/Session/Plan follow the agent (real git, WI-6554700010029864)', async () => {
    // Until 2026-10-27 each trailer was its own paragraph and git reads only the last one, so
    // 323 of the last 400 attributed commits read `%(trailers:key=Papercusp-Agent)` as empty.
    const repo = await seededRepo('gs-attr-trailers-');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'add a', workItems: ['WI-1', 'WI-2'], sessionId: 'sess-9', planSlug: 'plan-x' }],
    ]);

    await commitAttributedGroups(realRunGit, repo, attribution, [], MSG);

    const trailer = (key: string) => git(repo, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`);
    expect(await trailer('Papercusp-Agent')).toBe('ag1');
    expect(await trailer('Papercusp-Work-Item')).toBe('WI-1, WI-2');
    expect(await trailer('Papercusp-Session')).toBe('sess-9');
    expect(await trailer('Papercusp-Plan')).toBe('plan-x');
    expect(await trailer('Co-Authored-By')).toBe('ag1 <ag1@agents.papercusp>');
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

  it.each(['shared-index', 'ignore-after-census'] as const)(
    'EI-26936210212113630: ignored positive residual path from %s preserves legitimate work',
    async (origin) => {
      const repo = await seededRepo('gs-attr-ignored-positive-');
      const ignored = '.papercusp/private-desktop-candidates/probe/input.txt';
      await mkdir(join(repo, '.papercusp/private-desktop-candidates/probe'), { recursive: true });
      await writeFile(join(repo, ignored), 'private candidate\n');
      await writeFile(join(repo, 'loose.ts'), 'export const loose = 1;\n');
      await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
      const ignoreRule = '.papercusp/private-desktop-candidates/\n';
      if (origin === 'shared-index') {
        await git(repo, 'add', '--', ignored);
        await writeFile(join(repo, '.gitignore'), ignoreRule);
      }
      let observedCensus = false;
      const runner: RunGit = async (args, cwd, options) => {
        const result = await realRunGit(args, cwd, options);
        if (args[0] === 'status' && !observedCensus) {
          observedCensus = true;
          expect(result.stdout).toContain(ignored);
          if (origin === 'ignore-after-census') await writeFile(join(repo, '.gitignore'), ignoreRule);
        }
        return result;
      };
      const result = await commitAttributedGroups(runner, repo, new Map([
        ['a.ts', { agent: 'ag1', intent: 'add a' }],
      ]), [], MSG);

      expect(observedCensus).toBe(true);
      expect(result.groupFailures).toBeUndefined();
      expect(result.committedCount).toBe(2);
      expect(await git(repo, 'show', 'HEAD:loose.ts')).toBe('export const loose = 1;');
      expect((await realRunGit(['cat-file', '-e', `HEAD:${ignored}`], repo)).code).not.toBe(0);
      expect(await git(repo, 'ls-files', '--', ignored)).toBe(origin === 'shared-index' ? ignored : '');
      expect(await readFile(join(repo, ignored), 'utf8')).toBe('private candidate\n');
    },
  );

  it('EI-26936210212113630: an ignored tracked residual update still commits', async () => {
    const repo = await seededRepo('gs-attr-ignored-tracked-');
    await writeFile(join(repo, '.gitignore'), 'base.ts\n');
    await writeFile(join(repo, 'base.ts'), 'export const base = 2;\n');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    const result = await commitAttributedGroups(realRunGit, repo, new Map([
      ['a.ts', { agent: 'ag1', intent: 'add a' }],
    ]), [], MSG);
    expect(result.groupFailures).toBeUndefined();
    expect(await git(repo, 'show', 'HEAD:base.ts')).toBe('export const base = 2;');
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

describe('commitAttributedGroups import-linked groups (WI-6554700010019415, real git)', () => {
  /** A provider that drops an export its committed importer consumes, plus that importer's
   *  edit away from it, attributed to one agent under two intents. */
  async function splitProviderRepo(prefix: string): Promise<string> {
    const repo = await seededRepo(prefix);
    await writeFile(join(repo, 'provider.ts'), 'export const keep = 1;\nexport const MAX_AGE = 2;\n');
    await writeFile(join(repo, 'importer.ts'), "import { keep, MAX_AGE } from './provider';\nexport const both = keep + MAX_AGE;\n");
    await git(repo, 'add', 'provider.ts', 'importer.ts');
    await git(repo, ...ID, 'commit', '-qm', 'provider + importer');
    await writeFile(join(repo, 'provider.ts'), 'export const keep = 1;\n');
    await writeFile(join(repo, 'importer.ts'), "import { keep } from './provider';\nexport const both = keep;\n");
    return repo;
  }
  const attribution = new Map<string, FileAttribution>([
    ['provider.ts', { agent: 'ag1', intent: 'remove the max-age', editedAtMs: 100 }],
    ['importer.ts', { agent: 'ag1', intent: 'finish removing it', editedAtMs: 200 }],
  ]);
  const guardFor = (repo: string, logs: string[]) => (privateRunGit: RunGit) =>
    guardStagedIndexBeforeCommit({
      runGit: privateRunGit,
      repoPath: repo,
      scope: 'test',
      readText: (rel) => readFile(join(repo, rel), 'utf8').catch(() => null),
      log: (m) => logs.push(m),
    });

  it('control: in two private indexes the post-stage guard holds both halves', async () => {
    const repo = await splitProviderRepo('gs-attr-linked-control-');
    const logs: string[] = [];

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, {
      beforeCommit: guardFor(repo, logs),
      readText: async () => null, // no import edges, so the groups stay split
    });

    expect(res.agentGroupCount).toBe(2);
    expect(res.agentCommitCount).toBe(0);
    expect(await git(repo, 'status', '--porcelain')).toBe('M importer.ts\n M provider.ts');
    expect(logs.some((m) => m.includes("changed tracked module outside this commit's index"))).toBe(true);
    expect(logs.some((m) => m.includes('provider.ts') && m.includes('removes those exports'))).toBe(true);
  });

  it('commits the provider and its importer together in one attributed commit', async () => {
    const repo = await splitProviderRepo('gs-attr-linked-');
    const base = await git(repo, 'rev-parse', 'HEAD');
    const logs: string[] = [];

    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, {
      beforeCommit: guardFor(repo, logs),
      log: (m) => logs.push(m),
    });

    expect(res).toEqual({ committedAny: true, committedCount: 1, agentGroupCount: 1, agentCommitCount: 1 });
    expect(await git(repo, 'status', '--porcelain')).toBe('');
    expect(await git(repo, 'diff', '--name-only', base, 'HEAD')).toBe('importer.ts\nprovider.ts');
    expect(await git(repo, 'log', '-1', '--format=%(trailers:key=Papercusp-Agent,valueonly)')).toBe('ag1');
    expect(logs.some((m) => m.includes('merged import-linked attribution groups (2 -> 1)'))).toBe(true);
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

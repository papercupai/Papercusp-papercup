import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import {
  buildChangeTrail,
  defaultChangeTrailDeps,
  parseBlamePorcelain,
  parseTrailLog,
  resolveOwningRepo,
  siblingTestFile,
  submoduleChain,
  workItemOrigin,
  type ChangeTrailDeps,
  type TrailTestRun,
  type WorkItemOriginRow,
} from './change-trail';

const RS = String.fromCharCode(0x1d);
const FS = String.fromCharCode(0x1f);
const MS = String.fromCharCode(0x1e);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('parseTrailLog', () => {
  it('splits commits and keeps each message between the delimiters', () => {
    const out =
      `${RS}${SHA_A}${FS}2026-10-28T01:00:00Z${FS}first${MS}first\n\nPapercusp-Agent: su-1\n${MS}\n` +
      `${RS}${SHA_B}${FS}2026-10-27T01:00:00Z${FS}second${MS}second\n${MS}\n`;
    const commits = parseTrailLog(out);
    expect(commits.map((c) => c.sha)).toEqual([SHA_A, SHA_B]);
    expect(commits[0].subject).toBe('first');
    expect(commits[0].message).toContain('Papercusp-Agent: su-1');
    expect(commits[1].message).not.toContain('Papercusp-Agent');
  });

  it('skips blocks without a valid sha', () => {
    expect(parseTrailLog(`${RS}not-a-sha${FS}x${FS}y${MS}m${MS}`)).toEqual([]);
    expect(parseTrailLog('')).toEqual([]);
  });
});

describe('parseBlamePorcelain', () => {
  it('reads the commit of the blamed line', () => {
    expect(parseBlamePorcelain(`${SHA_A} 3 3 1\nauthor x\n`)).toEqual({ sha: SHA_A, uncommitted: false });
  });
  it('flags the all-zero sha as uncommitted', () => {
    expect(parseBlamePorcelain(`${'0'.repeat(40)} 1 1 1\n`)).toEqual({ sha: '0'.repeat(40), uncommitted: true });
  });
  it('returns null on unparseable output', () => {
    expect(parseBlamePorcelain('fatal: no such path')).toBeNull();
  });
});

describe('workItemOrigin (D-016 order)', () => {
  const base: WorkItemOriginRow = { id: 'WI-1' };
  it('prefers the plan item, even when a directive is also recorded (blind review G-9)', () => {
    expect(
      workItemOrigin({ ...base, directiveRef: 42, sourcePlanSlug: 'p', sourcePlanItemIds: ['P-010'] }),
    ).toEqual({ kind: 'plan-item', ref: 'p#P-010' });
    expect(workItemOrigin({ ...base, sourcePlanSlug: 'p', sourcePlanItemIds: ['P-010'] })).toEqual({
      kind: 'plan-item',
      ref: 'p#P-010',
    });
  });
  it('falls back to the directive when no plan is recorded', () => {
    expect(workItemOrigin({ ...base, directiveRef: 42 })).toEqual({ kind: 'directive', ref: '#42' });
    expect(workItemOrigin({ ...base, directiveRef: 42, links: [{ rel: 'caused-by', dstKind: 'issue', dstRef: 'EI-9' }] })).toEqual({
      kind: 'directive',
      ref: '#42',
    });
  });
  it('then to the first link', () => {
    expect(workItemOrigin({ ...base, links: [{ rel: 'caused-by', dstKind: 'issue', dstRef: 'EI-9' }] })).toEqual({
      kind: 'link',
      rel: 'caused-by',
      ref: 'issue:EI-9',
    });
  });
  it('and says none when nothing is recorded', () => {
    expect(workItemOrigin(base)).toEqual({ kind: 'none' });
  });
});

describe('siblingTestFile', () => {
  it('maps a source file to its existing sibling test', () => {
    expect(siblingTestFile('lib/x.ts', (p) => p === 'lib/x.test.ts')).toBe('lib/x.test.ts');
    expect(siblingTestFile('lib/x.ts', () => false)).toBeNull();
    expect(siblingTestFile('lib/x.test.ts', () => true)).toBeNull();
  });
});

describe('buildChangeTrail against a real git repo', () => {
  let root: string;
  let shaTrailer: string;
  let shaPlain: string;
  let shaSub: string;
  let shaTestOnly: string;
  let shaSub2: string;
  let shaPin1: string;
  let shaPin2: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

  beforeAll(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'change-trail-'));
    git(root, 'init', '-q');
    fs.mkdirSync(nodePath.join(root, 'src'));
    fs.writeFileSync(nodePath.join(root, 'src/a.ts'), 'one\n');
    fs.writeFileSync(nodePath.join(root, 'src/a.test.ts'), 'test\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'plain commit');
    shaPlain = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(nodePath.join(root, 'src/a.ts'), 'one\ntwo\n');
    git(root, 'add', '.');
    git(
      root,
      'commit',
      '-q',
      '-m',
      'git-sync: sweep\n\nPapercusp-Agent: su-alpha\nPapercusp-Work-Item: WI-1, WI-missing\nPapercusp-Session: sess-1\nPapercusp-Plan: plan-x',
    );
    shaTrailer = git(root, 'rev-parse', 'HEAD');
    // A later commit that touches only the test: runs at it still tested src/a.ts as of shaTrailer.
    fs.writeFileSync(nodePath.join(root, 'src/a.test.ts'), 'test\nmore\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'test-only commit');
    shaTestOnly = git(root, 'rev-parse', 'HEAD');

    // A nested repo stands in for a submodule: the path must resolve to IT, not the superproject.
    fs.mkdirSync(nodePath.join(root, 'sub'));
    git(nodePath.join(root, 'sub'), 'init', '-q');
    fs.writeFileSync(nodePath.join(root, 'sub/x.ts'), 'x\n');
    git(nodePath.join(root, 'sub'), 'add', '.');
    git(nodePath.join(root, 'sub'), 'commit', '-q', '-m', 'sub commit\n\nPapercusp-Agent: su-beta');
    shaSub = git(nodePath.join(root, 'sub'), 'rev-parse', 'HEAD');
    // The superproject pins it as a gitlink, the way it pins libs/papercusp.
    git(root, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub');
    git(root, 'commit', '-q', '-m', 'pin sub');
    shaPin1 = git(root, 'rev-parse', 'HEAD');
    // x.ts changes in the submodule, then a later submodule commit leaves it alone; pin that one.
    fs.writeFileSync(nodePath.join(root, 'sub/x.ts'), 'x\ny\n');
    git(nodePath.join(root, 'sub'), 'add', '.');
    git(nodePath.join(root, 'sub'), 'commit', '-q', '-m', 'sub change');
    shaSub2 = git(nodePath.join(root, 'sub'), 'rev-parse', 'HEAD');
    fs.writeFileSync(nodePath.join(root, 'sub/other.ts'), 'o\n');
    git(nodePath.join(root, 'sub'), 'add', '.');
    git(nodePath.join(root, 'sub'), 'commit', '-q', '-m', 'sub other');
    git(root, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub');
    git(root, 'commit', '-q', '-m', 'pin sub again');
    shaPin2 = git(root, 'rev-parse', 'HEAD');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function deps(
    runs: TrailTestRun[] = [],
  ): ChangeTrailDeps & { asked: { paths?: string[]; ids?: string[]; since?: string } } {
    const asked: { paths?: string[]; ids?: string[]; since?: string } = {};
    return {
      asked,
      git: defaultChangeTrailDeps('ws-test').git,
      async readWorkItems(ids) {
        asked.ids = ids;
        return ids
          .filter((id) => id === 'WI-1')
          .map((id) => ({ id, title: 'Do the thing', state: 'done', sourcePlanSlug: 'plan-x', sourcePlanItemIds: ['P-010'] }));
      },
      async readTestRuns(paths, sinceIso) {
        asked.paths = paths;
        asked.since = sinceIso;
        return runs;
      },
    };
  }

  it('attributes trailer commits and reports untrailered ones as none, newest first', async () => {
    const atTrailer = { file: 'src/a.test.ts', status: 'pass', commitSha: shaTrailer, dirty: false, source: 'ci', finishedAt: null };
    // Recorded at a LATER sha that did not change src/a.ts — it tested the shaTrailer version.
    const atLater = { file: 'src/a.test.ts', status: 'fail', commitSha: shaTestOnly, dirty: false, source: 'ci', finishedAt: null };
    const unknownSha = { file: 'src/a.ts', status: 'pass', commitSha: 'f'.repeat(40), dirty: true, source: 'local', finishedAt: null };
    const d = deps([atTrailer, atLater, unknownSha]);
    const trail = await buildChangeTrail({ repoRoot: root, path: 'src/a.ts' }, d);
    expect(trail.repo).toBe('superproject');
    expect(trail.testFiles).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(d.asked.paths).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(d.asked.since).toBe(trail.commits[trail.commits.length - 1].committedAt);
    expect(trail.commits.map((c) => c.sha)).toEqual([shaTrailer, shaPlain]);
    expect(trail.notes).toEqual([
      '1 run sha(s) could not be resolved to a version of src/a.ts (sha not in this checkout), so their runs are not attributed',
    ]);

    const [attributed, plain] = trail.commits;
    expect(attributed.attributionSource).toBe('trailer');
    expect(attributed.agent).toBe('su-alpha');
    expect(attributed.sessionId).toBe('sess-1');
    expect(attributed.planSlug).toBe('plan-x');
    expect(attributed.workItems).toEqual([
      { id: 'WI-1', found: true, title: 'Do the thing', state: 'done', origin: { kind: 'plan-item', ref: 'plan-x#P-010' } },
      { id: 'WI-missing', found: false, origin: { kind: 'none' } },
    ]);
    expect(attributed.testRuns).toEqual([atTrailer, atLater]);

    expect(plain.attributionSource).toBe('none');
    expect(plain.agent).toBeUndefined();
    expect(plain.workItems).toEqual([]);
    expect(plain.testRuns).toEqual([]);
    expect(trail.truncated).toBe(false);
  });

  it('marks the trail truncated when the limit is reached', async () => {
    const trail = await buildChangeTrail({ repoRoot: root, path: 'src/a.ts', limit: 1 }, deps());
    expect(trail.commits.map((c) => c.sha)).toEqual([shaTrailer]);
    expect(trail.truncated).toBe(true);
  });

  it('attributes a single line through blame', async () => {
    const line1 = await buildChangeTrail({ repoRoot: root, path: 'src/a.ts', line: 1 }, deps());
    expect(line1.blame).toEqual({ sha: shaPlain, uncommitted: false });
    expect(line1.commits.map((c) => [c.sha, c.attributionSource])).toEqual([[shaPlain, 'none']]);
    const line2 = await buildChangeTrail({ repoRoot: root, path: 'src/a.ts', line: 2 }, deps());
    expect(line2.commits.map((c) => [c.sha, c.agent])).toEqual([[shaTrailer, 'su-alpha']]);
  });

  it('reports an uncommitted line instead of guessing an owner', async () => {
    fs.writeFileSync(nodePath.join(root, 'src/a.ts'), 'one\ntwo\nthree\n');
    try {
      const trail = await buildChangeTrail({ repoRoot: root, path: 'src/a.ts', line: 3 }, deps());
      expect(trail.blame?.uncommitted).toBe(true);
      expect(trail.commits).toEqual([]);
      expect(trail.notes.join(' ')).toMatch(/not committed yet/);
    } finally {
      git(root, 'checkout', '--', 'src/a.ts');
    }
  });

  it('runs git inside the repo that owns the path', async () => {
    expect(resolveOwningRepo(root, 'sub/x.ts')).toMatchObject({ repo: 'sub', relPath: 'x.ts', superRelPath: 'sub/x.ts' });
    const trail = await buildChangeTrail({ repoRoot: root, path: 'sub/x.ts' }, deps());
    expect(trail.repo).toBe('sub');
    expect(trail.commits.map((c) => [c.sha, c.agent])).toEqual([
      [shaSub2, undefined],
      [shaSub, 'su-beta'],
    ]);
  });

  it('follows a superproject run sha down the gitlink to the submodule file version it tested', async () => {
    const atPin1 = { file: 'sub/x.ts', status: 'pass', commitSha: shaPin1, dirty: false, source: 'ci', finishedAt: null };
    // shaPin2 pins a submodule commit that did not touch x.ts: it tested the shaSub2 version.
    const atPin2 = { file: 'sub/x.ts', status: 'fail', commitSha: shaPin2, dirty: false, source: 'ci', finishedAt: null };
    // shaPlain predates the gitlink, so it pins no submodule commit at all.
    const beforePin = { file: 'sub/x.ts', status: 'pass', commitSha: shaPlain, dirty: false, source: 'ci', finishedAt: null };
    const d = deps([atPin2, atPin1, beforePin]);
    const trail = await buildChangeTrail({ repoRoot: root, path: 'sub/x.ts' }, d);
    expect(d.asked.paths).toEqual(['sub/x.ts']);
    expect(trail.commits.map((c) => [c.sha, c.testRuns])).toEqual([
      [shaSub2, [atPin2]],
      [shaSub, [atPin1]],
    ]);
    expect(trail.notes).toEqual([
      '1 run sha(s) could not be resolved to a version of sub/x.ts (sha not in this checkout, or sub not pinned at it), so their runs are not attributed',
    ]);
    expect(submoduleChain(root, nodePath.join(root, 'sub'))).toEqual([{ parentDir: nodePath.resolve(root), pathInParent: 'sub' }]);
    expect(submoduleChain(root, root)).toEqual([]);
  });

  it('refuses a path outside the repo root', async () => {
    await expect(buildChangeTrail({ repoRoot: root, path: '../elsewhere.ts' }, deps())).rejects.toThrow(/path_outside_repo/);
  });
});

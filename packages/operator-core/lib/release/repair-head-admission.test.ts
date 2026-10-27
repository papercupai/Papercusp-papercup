/**
 * P-013(a) + P-001 guards (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-002/D-010).
 *
 * These run against a REAL temporary git repository, not a mocked runner: the property under
 * test is what git records, and only git can answer that. The one injected runner is the
 * STRAY-FILE CONTROL — a deliberately-wrong tree builder kept permanently in this file — which
 * proves the diff-tree proof can fail, so a green here is not a proof that never fires.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ADMISSION_GIT_IDENTITY,
  ADMISSION_GIT_DATE,
  admitPathsOntoRepairHead,
  frozenLineageRef,
  normalizeAdmissionPath,
  proveAdmissionDiff,
  realAdmissionGit,
  repairAdmissionSubmoduleRef,
  retractAdmission,
  validateAdmissionPaths,
  type AdmissionGitRunner,
} from './repair-head-admission';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOME = mkdtempSync(join(tmpdir(), 'admit-home-'));
TEMP.push(HOME);
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};

function git(root: string, args: string[]): string {
  // WI-41180 pure-lane ratchet: a sync spawn with no `timeout:` blocks the shared pure-lane
  // fork past vitest's reach; bound it so a wedged git cannot take the whole lane down.
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sweep(root: string, edits: Record<string, string | null>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) {
    if (content === null) rmSync(join(root, rel));
    else write(root, rel, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}
function blobAt(root: string, ref: string, rel: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}:${rel}`]) || null;
  } catch {
    return null;
  }
}
function nameDiff(root: string, a: string, b: string): string[] {
  return git(root, ['diff-tree', '-r', '--name-only', '--no-commit-id', a, b]).split('\n').filter(Boolean).sort();
}
function refAt(root: string, ref: string): string | null {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', ref]) || null;
  } catch {
    return null;
  }
}

/** A repo whose first commit is the frozen candidate; the branch is `staging`, the shared tree. */
function repo(): { root: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'admit-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  write(root, 'lib/a.ts', 'export const a = 1;\n');
  write(root, 'lib/b.ts', 'export const b = 1;\n');
  write(root, 'docs/x.md', '# x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate']);
  return { root, candidate: git(root, ['rev-parse', 'HEAD']) };
}

const T0 = 1_800_000_000_000;
const admit = (
  root: string,
  candidate: string,
  repairHead: string,
  paths: string[],
  extra: Partial<Parameters<typeof admitPathsOntoRepairHead>[0]> = {},
) =>
  admitPathsOntoRepairHead({
    root,
    candidate,
    repairHead,
    paths,
    source: { ref: 'staging' },
    actor: 'su-test',
    nowMs: T0,
    ...extra,
  });

describe('proveAdmissionDiff — the pure proof (D-002)', () => {
  it('refuses a diff that names a path outside the allowlist, naming the stray', () => {
    expect(proveAdmissionDiff({ diff: ['lib/a.ts', 'lib/b.ts'], allowlist: ['lib/a.ts'] })).toEqual({
      ok: false,
      stray: ['lib/b.ts'],
    });
  });
  it('accepts a subset and reports the allowlisted paths that did not change', () => {
    expect(proveAdmissionDiff({ diff: ['lib/b.ts'], allowlist: ['lib/a.ts', 'lib/b.ts'] })).toEqual({
      ok: true,
      admitted: ['lib/b.ts'],
      unchanged: ['lib/a.ts'],
    });
  });
  it('an empty diff is not a stray, it is "nothing admitted"', () => {
    expect(proveAdmissionDiff({ diff: [], allowlist: ['lib/a.ts'] })).toEqual({
      ok: true,
      admitted: [],
      unchanged: ['lib/a.ts'],
    });
  });
});

describe('path validation — an admission is by explicit, well-formed, repo-relative path', () => {
  it.each([
    ['lib/a.ts', 'lib/a.ts'],
    ['./lib/a.ts', 'lib/a.ts'],
    ['lib//a.ts', 'lib/a.ts'],
    [' lib/a.ts ', 'lib/a.ts'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeAdmissionPath(raw)).toBe(expected);
  });
  it.each(['', '/lib/a.ts', '../lib/a.ts', 'lib/../a.ts', 'lib/./a.ts', 'lib/', 'lib\\a.ts'])('rejects %j', (raw) => {
    expect(normalizeAdmissionPath(raw)).toBeNull();
  });
  it('refuses an empty allowlist and dedupes/sorts a valid one', () => {
    expect(validateAdmissionPaths([])).toEqual({ ok: false, invalid: [] });
    expect(validateAdmissionPaths(['lib/b.ts', './lib/a.ts', 'lib/b.ts'])).toEqual({
      ok: true,
      paths: ['lib/a.ts', 'lib/b.ts'],
    });
  });
});

describe('admitPathsOntoRepairHead — real git (P-001)', () => {
  it('admits EXACTLY the named path: the stray edit in the same sweep stays out, parent is repairHead, the lineage ref is published', () => {
    const { root, candidate } = repo();
    const staging = sweep(
      root,
      {
        'lib/a.ts': 'export const a = 2; // fix\n',
        'lib/b.ts': 'export const b = 2; // unrelated\n',
        'lib/new.ts': 'export const n = 1;\n',
      },
      'sweep',
    );

    const out = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(nameDiff(root, candidate, out.commit)).toEqual(['lib/a.ts']);
    expect(blobAt(root, out.commit, 'lib/a.ts')).toBe(blobAt(root, staging, 'lib/a.ts'));
    expect(blobAt(root, out.commit, 'lib/b.ts')).toBe(blobAt(root, candidate, 'lib/b.ts'));
    expect(blobAt(root, out.commit, 'lib/new.ts')).toBeNull();
    expect(git(root, ['rev-parse', `${out.commit}^`])).toBe(candidate);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(out.commit);
    expect(git(root, ['log', '-1', '--format=%an <%ae>', out.commit])).toBe(
      `${ADMISSION_GIT_IDENTITY.name} <${ADMISSION_GIT_IDENTITY.email}>`,
    );
    expect(git(root, ['log', '-1', '--format=%B', out.commit])).toContain('actor: su-test');

    expect(out.entry).toEqual({
      atMs: T0,
      actor: 'su-test',
      source: { ref: 'staging', sha: staging },
      fromRepairHead: candidate,
      toRepairHead: out.commit,
      paths: ['lib/a.ts'],
      unchanged: [],
      blobs: { 'lib/a.ts': blobAt(root, staging, 'lib/a.ts') },
    });
    // The shared checkout's working tree and index are untouched by the plumbing.
    expect(git(root, ['status', '--porcelain'])).toBe('');
    expect(git(root, ['rev-parse', 'staging'])).toBe(staging);
  });

  it('chains: a second admission parents on the new repairHead and advances the lineage ref by CAS', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n', 'lib/new.ts': 'n\n' }, 'sweep');
    const first = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = admit(root, candidate, first.commit, ['lib/new.ts']);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(git(root, ['rev-parse', `${second.commit}^`])).toBe(first.commit);
    expect(nameDiff(root, first.commit, second.commit)).toEqual(['lib/new.ts']);
    expect(nameDiff(root, candidate, second.commit)).toEqual(['lib/a.ts', 'lib/new.ts']);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(second.commit);
  });

  it('admits a deletion when the path is absent at the source', () => {
    const { root, candidate } = repo();
    sweep(root, { 'docs/x.md': null, 'lib/a.ts': 'a2\n' }, 'delete');
    const out = admit(root, candidate, candidate, ['docs/x.md']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(nameDiff(root, candidate, out.commit)).toEqual(['docs/x.md']);
    expect(blobAt(root, out.commit, 'docs/x.md')).toBeNull();
    expect(blobAt(root, out.commit, 'lib/a.ts')).toBe(blobAt(root, candidate, 'lib/a.ts'));
    expect(out.entry.blobs).toEqual({ 'docs/x.md': null });
  });

  it('refuses a never-tracked path absent from the candidate, source, and repairHead', () => {
    const { root, candidate } = repo();
    const path = 'lib/never-existed.ts';
    const out = admit(root, candidate, candidate, [path]);
    expect(out).toMatchObject({
      ok: false,
      code: 'path-not-found',
      detail: expect.stringContaining(path),
    });
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
  });

  it('keeps an already-reflected deletion idempotent', () => {
    const { root, candidate } = repo();
    sweep(root, { 'docs/x.md': null }, 'delete');
    const first = admit(root, candidate, candidate, ['docs/x.md']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = admit(root, candidate, first.commit, ['docs/x.md']);
    expect(again).toMatchObject({ ok: false, code: 'nothing-to-admit' });
    expect(refAt(root, frozenLineageRef(candidate))).toBe(first.commit);
  });

  it('is idempotent: an already-admitted path is nothing-to-admit alone and `unchanged` beside a real change', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n', 'lib/b.ts': 'b2\n' }, 'sweep');
    const first = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = admit(root, candidate, first.commit, ['lib/a.ts']);
    expect(again).toMatchObject({ ok: false, code: 'nothing-to-admit' });
    expect(refAt(root, frozenLineageRef(candidate))).toBe(first.commit);

    const mixed = admit(root, candidate, first.commit, ['lib/a.ts', 'lib/b.ts']);
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.diff).toEqual(['lib/b.ts']);
    expect(mixed.entry.unchanged).toEqual(['lib/a.ts']);
    expect(mixed.entry.paths).toEqual(['lib/b.ts']);
  });

  it('admits a submodule path as the gitlink at the source pin', () => {
    const { root, candidate } = repo();
    // A gitlink entry needs no .gitmodules to be committed; pin it to the candidate sha for a
    // self-contained fixture (any commit sha is a valid gitlink target for the index).
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${candidate},libs/nested`]);
    git(root, ['commit', '-q', '-m', 'gitlink']);
    const out = admit(root, candidate, candidate, ['libs/nested']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(nameDiff(root, candidate, out.commit)).toEqual(['libs/nested']);
    expect(git(root, ['ls-tree', out.commit, '--', 'libs/nested'])).toBe(`160000 commit ${candidate}\tlibs/nested`);
    expect(out.entry.blobs).toEqual({ 'libs/nested': candidate });
  });

  it('refuses a path below a gitlink and reports candidate/source/repairHead pins instead of unchanged null blobs', () => {
    const { root } = repo();
    const candidateSubmoduleCommit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${candidateSubmoduleCommit},libs/nested`]);
    git(root, ['commit', '-q', '-m', 'candidate gitlink']);
    const candidate = git(root, ['rev-parse', 'HEAD']);

    // Stand in for a newer commit inside the submodule, then advance only the superproject's
    // gitlink to it. The nested file cannot be resolved by ls-tree from the superproject.
    const sourceSubmoduleCommit = git(root, [
      'commit-tree',
      `${candidateSubmoduleCommit}^{tree}`,
      '-p',
      candidateSubmoduleCommit,
      '-m',
      'submodule fix',
    ]);
    git(root, ['update-index', '--cacheinfo', `160000,${sourceSubmoduleCommit},libs/nested`]);
    git(root, ['commit', '-q', '-m', 'move gitlink']);

    const innerPath = 'libs/nested/packages/orchestrator/src/fix.test.ts';
    const out = admit(root, candidate, candidate, [innerPath]);
    expect(out).toMatchObject({
      ok: false,
      code: 'path-under-gitlink',
      detail: expect.stringContaining(`candidate libs/nested@${candidateSubmoduleCommit}`),
    });
    if (out.ok) return;
    expect(out.detail).toContain(`source libs/nested@${sourceSubmoduleCommit}`);
    expect(out.detail).toContain(`repairHead libs/nested@${candidateSubmoduleCommit}`);
    expect(out.detail).toContain('paths: ["libs/nested"]');
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
  });

  it('admits a path inside a checked-out submodule narrowly: only that file moves, on the repairHead pin (EI-27153389932897217)', () => {
    const { root } = repo();
    const sub = join(root, 'libs/nested');
    mkdirSync(sub, { recursive: true });
    git(sub, ['init', '-q', '-b', 'main']);
    write(sub, 'src/fix.ts', 'export const fix = 1;\n');
    write(sub, 'src/other.ts', 'export const other = 1;\n');
    git(sub, ['add', '-A']);
    git(sub, ['commit', '-q', '-m', 'pin']);
    const pin = git(sub, ['rev-parse', 'HEAD']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${pin},libs/nested`]);
    git(root, ['commit', '-q', '-m', 'candidate gitlink']);
    const candidate = git(root, ['rev-parse', 'HEAD']);

    // The submodule advances with the fix AND an unrelated change; staging pins that tip.
    write(sub, 'src/fix.ts', 'export const fix = 2;\n');
    write(sub, 'src/other.ts', 'export const other = 2;\n');
    git(sub, ['commit', '-q', '-am', 'fix plus unrelated work']);
    const subTip = git(sub, ['rev-parse', 'HEAD']);
    git(root, ['update-index', '--cacheinfo', `160000,${subTip},libs/nested`]);
    git(root, ['commit', '-q', '-m', 'move gitlink']);

    const preview = admit(root, candidate, candidate, ['libs/nested/src/fix.ts'], { dryRun: true });
    expect(preview).toMatchObject({ ok: true, published: false, diff: ['libs/nested/src/fix.ts'] });
    if (!preview.ok) return;
    const built = git(root, ['ls-tree', preview.commit, '--', 'libs/nested']).split(/\s+/)[2]!;
    // A dry run builds but never pins the submodule commit.
    expect(() => git(sub, ['rev-parse', '--verify', '--quiet', repairAdmissionSubmoduleRef(built)])).toThrow();

    const out = admit(root, candidate, candidate, ['libs/nested/src/fix.ts']);
    expect(out).toMatchObject({ ok: true, published: true, diff: ['libs/nested/src/fix.ts'], unchanged: [] });
    if (!out.ok) return;
    // Superproject: only the gitlink moved. Submodule: built on the repairHead pin, carrying
    // the fix and NOT the unrelated change that rode in the same submodule commit.
    expect(nameDiff(root, candidate, out.commit)).toEqual(['libs/nested']);
    const subCommit = git(root, ['ls-tree', out.commit, '--', 'libs/nested']).split(/\s+/)[2]!;
    expect(subCommit).toBe(built);
    expect(git(sub, ['rev-parse', `${subCommit}^`])).toBe(pin);
    expect(git(sub, ['diff-tree', '-r', '--name-only', '--no-commit-id', pin, subCommit])).toBe('src/fix.ts');
    expect(git(sub, ['show', `${subCommit}:src/fix.ts`])).toBe('export const fix = 2;');
    expect(git(sub, ['show', `${subCommit}:src/other.ts`])).toBe('export const other = 1;');
    expect(git(sub, ['rev-parse', repairAdmissionSubmoduleRef(subCommit)])).toBe(subCommit);
    expect(out.entry.paths).toEqual(['libs/nested/src/fix.ts']);
    expect(out.entry.blobs['libs/nested/src/fix.ts']).toBe(git(sub, ['rev-parse', `${subTip}:src/fix.ts`]));
    expect(refAt(root, frozenLineageRef(candidate))).toBe(out.commit);
  });

  it('refuses naming a submodule pointer together with paths inside it', () => {
    const { root } = repo();
    const sub = join(root, 'libs/nested');
    mkdirSync(sub, { recursive: true });
    git(sub, ['init', '-q', '-b', 'main']);
    write(sub, 'src/fix.ts', 'export const fix = 1;\n');
    git(sub, ['add', '-A']);
    git(sub, ['commit', '-q', '-m', 'pin']);
    const pin = git(sub, ['rev-parse', 'HEAD']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${pin},libs/nested`]);
    git(root, ['commit', '-q', '-m', 'candidate gitlink']);
    const candidate = git(root, ['rev-parse', 'HEAD']);
    const out = admit(root, candidate, candidate, ['libs/nested', 'libs/nested/src/fix.ts']);
    expect(out).toMatchObject({ ok: false, code: 'invalid-paths', paths: ['libs/nested'] });
  });

  it('is source-agnostic: a raw commit sha works as the source and no branch name is consulted', () => {
    const { root, candidate } = repo();
    const fixSha = sweep(root, { 'lib/a.ts': 'a-fix\n' }, 'fix');
    // Move staging PAST the fix; the admission still takes the blob from the named commit.
    sweep(root, { 'lib/a.ts': 'a-later\n' }, 'later');
    const out = admit(root, candidate, candidate, ['lib/a.ts'], { source: { ref: fixSha } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(blobAt(root, out.commit, 'lib/a.ts')).toBe(blobAt(root, fixSha, 'lib/a.ts'));
    expect(out.entry.source).toEqual({ ref: fixSha, sha: fixSha });
  });

  it('can read an immutable source SHA while preserving a reviewed branch-labelled admission identity', () => {
    const { root, candidate } = repo();
    const fixSha = sweep(root, { 'lib/a.ts': 'a-fix\n' }, 'fix');
    const preview = admit(root, candidate, candidate, ['lib/a.ts'], {
      source: { ref: 'staging' },
      reason: 'reviewed exact staging blob',
      dryRun: true,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    sweep(root, { 'lib/a.ts': 'a-later\n' }, 'later');
    const pinned = admit(root, candidate, candidate, ['lib/a.ts'], {
      source: { ref: fixSha, recordAsRef: 'staging' },
      reason: 'reviewed exact staging blob',
      dryRun: true,
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;

    expect(pinned.commit).toBe(preview.commit);
    expect(pinned.tree).toBe(preview.tree);
    expect(pinned.entry.source).toEqual({ ref: 'staging', sha: fixSha });
    expect(blobAt(root, pinned.commit, 'lib/a.ts')).toBe(blobAt(root, fixSha, 'lib/a.ts'));
  });

  it('refuses an unresolvable source and an unresolvable repairHead without touching the ref', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n' }, 'sweep');
    expect(admit(root, candidate, candidate, ['lib/a.ts'], { source: { ref: 'no-such-ref' } })).toMatchObject({
      ok: false,
      code: 'source-unresolvable',
    });
    expect(admit(root, candidate, 'f'.repeat(40), ['lib/a.ts'])).toMatchObject({
      ok: false,
      code: 'repair-head-unresolvable',
    });
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
  });

  it('refuses malformed paths, an empty allowlist, and a directory path — naming each', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n' }, 'sweep');
    expect(admit(root, candidate, candidate, ['../lib/a.ts', 'lib/a.ts'])).toMatchObject({
      ok: false,
      code: 'invalid-paths',
      paths: ['../lib/a.ts'],
    });
    expect(admit(root, candidate, candidate, [])).toMatchObject({ ok: false, code: 'invalid-paths' });
    expect(admit(root, candidate, candidate, ['lib'])).toMatchObject({
      ok: false,
      code: 'invalid-paths',
      paths: ['lib'],
    });
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
  });

  it('CAS: refuses when the lineage ref already points elsewhere than the repairHead admitted onto', () => {
    const { root, candidate } = repo();
    const staging = sweep(root, { 'lib/a.ts': 'a2\n' }, 'sweep');
    git(root, ['update-ref', frozenLineageRef(candidate), staging]);
    const out = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(out).toMatchObject({ ok: false, code: 'lineage-ref-moved' });
    expect(refAt(root, frozenLineageRef(candidate))).toBe(staging);
  });

  /**
   * THE FALSIFIER (P-013(a) stray-file control). A tree builder that "helpfully" carries a
   * second path along with the one it was asked for — exactly the class of bug the diff-tree
   * proof exists to catch. Kept permanently: if this test ever passes without the refusal, the
   * proof has been weakened.
   */
  it('STRAY-FILE CONTROL: a tree builder that smuggles an extra path is REFUSED by the proof and publishes nothing', () => {
    const { root, candidate } = repo();
    const staging = sweep(root, { 'lib/a.ts': 'a2\n', 'lib/b.ts': 'b2 smuggled\n' }, 'sweep');
    const bMode = git(root, ['ls-tree', staging, '--', 'lib/b.ts']).split(' ')[0];
    const bSha = blobAt(root, staging, 'lib/b.ts')!;
    const smuggling: AdmissionGitRunner = (argv, opts) => {
      const r = realAdmissionGit(argv, opts);
      if (
        argv[0] === 'update-index' &&
        argv.includes('--cacheinfo') &&
        String(argv[argv.length - 1]).endsWith(',lib/a.ts')
      ) {
        realAdmissionGit(['update-index', '--add', '--replace', '--cacheinfo', `${bMode},${bSha},lib/b.ts`], opts);
      }
      return r;
    };
    const out = admit(root, candidate, candidate, ['lib/a.ts'], { git: smuggling });
    expect(out).toMatchObject({ ok: false, code: 'stray-paths', stray: ['lib/b.ts'] });
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
    // Calibration: the same fixture through the REAL runner admits cleanly, so the refusal
    // above is the control firing, not a broken fixture.
    const clean = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(nameDiff(root, candidate, clean.commit)).toEqual(['lib/a.ts']);
  });
});

describe('dryRun — the exact verdict confirm would get, without publishing (P-002)', () => {
  it('builds and PROVES the commit, leaves the lineage ref untouched, and a confirmed run then publishes the same tree', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'export const a = 2;\n', 'lib/b.ts': 'export const b = 2;\n' }, 'fix a and b');
    const dry = admit(root, candidate, candidate, ['lib/a.ts'], { dryRun: true });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.published).toBe(false);
    expect(dry.diff).toEqual(['lib/a.ts']);
    expect(dry.unchanged).toEqual([]);
    // The commit exists as an unreferenced object with the right parent and the proved diff,
    // but nothing points at it: the judged lineage did not move.
    expect(git(root, ['rev-parse', `${dry.commit}^`])).toBe(candidate);
    expect(nameDiff(root, candidate, dry.commit)).toEqual(['lib/a.ts']);
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
    // b.ts was NOT carried along (path-exact, never the tip).
    expect(blobAt(root, dry.commit, 'lib/b.ts')).toBe(blobAt(root, candidate, 'lib/b.ts'));

    const real = admit(root, candidate, candidate, ['lib/a.ts'], { nowMs: T0 + 86_400_000 });
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.published).toBe(true);
    expect(real.tree).toBe(dry.tree);
    expect(real.commit).toBe(dry.commit);
    const expectedGitDate = ADMISSION_GIT_DATE.replace(/Z$/, '+00:00');
    expect(git(root, ['show', '-s', '--format=%aI %cI', real.commit])).toBe(`${expectedGitDate} ${expectedGitDate}`);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(real.commit);
  });

  it('a dry run refuses a moved lineage ref exactly as a real run would (it is not a weaker check)', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n' }, 'fix a');
    const first = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    sweep(root, { 'lib/b.ts': 'b2\n' }, 'fix b');
    // Built onto the ORIGINAL candidate while the lineage is already at `first`.
    const stale = admit(root, candidate, candidate, ['lib/b.ts'], { dryRun: true });
    expect(stale).toMatchObject({ ok: false, code: 'lineage-ref-moved' });
    // Positive control: the same dry run onto the current head is fine.
    const fresh = admit(root, candidate, first.commit, ['lib/b.ts'], { dryRun: true });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.published).toBe(false);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(first.commit);
  });
});

describe('retractAdmission — the compensating step when the queue-row write fails after the ref moved', () => {
  it('moves the lineage ref back to the previous head by exact compare-and-swap', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n' }, 'fix a');
    const first = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(refAt(root, frozenLineageRef(candidate))).toBe(first.commit);
    expect(retractAdmission({ root, candidate, published: first.commit, previousRepairHead: candidate })).toBe(true);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(candidate);
    // After retraction the same admission can be re-published onto the same head (idempotent recovery).
    const again = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(again.ok).toBe(true);
    if (again.ok) expect(refAt(root, frozenLineageRef(candidate))).toBe(again.commit);
  });

  it('refuses (and touches nothing) once a later admission has built on the one being retracted', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n' }, 'fix a');
    const first = admit(root, candidate, candidate, ['lib/a.ts']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    sweep(root, { 'lib/b.ts': 'b2\n' }, 'fix b');
    const second = admit(root, candidate, first.commit, ['lib/b.ts']);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(retractAdmission({ root, candidate, published: first.commit, previousRepairHead: candidate })).toBe(false);
    expect(refAt(root, frozenLineageRef(candidate))).toBe(second.commit);
  });
});

describe('preflight — P-004: runs on the PROVED commit, before publish, on dry run and confirm alike', () => {
  type Preflight = NonNullable<Parameters<typeof admitPathsOntoRepairHead>[0]['preflight']>;

  it('a refusing preflight sees the proved commit + admitted set, returns admission-incomplete with that commit, and the lineage ref never moves', () => {
    const { root, candidate } = repo();
    const sourceCommit = sweep(root, { 'lib/a.ts': 'a2\n' }, 'fix a');
    const seen: Parameters<Preflight>[0][] = [];
    const preflight: Preflight = (built) => {
      seen.push(built);
      return {
        code: 'admission-incomplete',
        detail: 'lib/a.ts imports ./b',
        missing: [
          { from: 'lib/a.ts', specifier: './b', wanted: 'lib/b.ts', tried: ['lib/b.ts'], atProbeRef: 'present' },
        ],
      };
    };
    const confirmed = admit(root, candidate, candidate, ['lib/a.ts'], { preflight });
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.code).toBe('admission-incomplete');
    expect(confirmed.missing?.[0]?.wanted).toBe('lib/b.ts');
    expect(confirmed.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.admitted).toEqual(['lib/a.ts']);
    expect(seen[0]?.commit).toBe(confirmed.commit);
    expect(seen[0]?.sourceCommit).toBe(sourceCommit);
    expect(seen[0]?.repairHead).toBe(candidate);
    // Built and proved — the object exists — but unreferenced: ordinary garbage.
    expect(git(root, ['cat-file', '-t', confirmed.commit ?? ''])).toBe('commit');
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();

    const dry = admit(root, candidate, candidate, ['lib/a.ts'], { preflight, dryRun: true });
    expect(dry.ok).toBe(false);
    if (!dry.ok) expect(dry.code).toBe('admission-incomplete');
    expect(seen).toHaveLength(2);
    expect(refAt(root, frozenLineageRef(candidate))).toBeNull();
  });

  it('an accepting preflight (null) publishes exactly as before; a git-failed preflight fails CLOSED and publishes nothing', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': 'a2\n' }, 'fix a');
    const accepted = admit(root, candidate, candidate, ['lib/a.ts'], { preflight: () => null });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(refAt(root, frozenLineageRef(candidate))).toBe(accepted.commit);

    sweep(root, { 'lib/b.ts': 'b2\n' }, 'fix b');
    const broken = admit(root, candidate, accepted.commit, ['lib/b.ts'], {
      preflight: () => ({
        code: 'git-failed',
        step: 'completeness preflight: cat-file --batch-check',
        detail: 'exited 128',
      }),
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok)
      expect(broken).toMatchObject({ code: 'git-failed', step: expect.stringContaining('completeness preflight') });
    expect(refAt(root, frozenLineageRef(candidate))).toBe(accepted.commit);
  });
});

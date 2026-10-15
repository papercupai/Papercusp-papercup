/**
 * P-020 (D-008 layers 2–3) — hunk-exact admission source, against REAL git.
 *
 * The property under test: the synthesised source commit's blob for each path is repairHead's
 * blob + ONLY the caller's ledgered hunks, so a stranger's concurrent edit to the same file
 * on staging never enters the judged lineage — and every refusal names its explicit exit.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMISSION_GIT_DATE, admitPathsOntoRepairHead, realAdmissionGit } from './repair-head-admission';
import type { AdmissionGitRunner } from './repair-head-admission';
import {
  attributeUnledgeredPaths,
  buildCommittedPatchSource,
  buildHunkExactSource,
  findAlreadyAppliedHunks,
  findCarriedLedgerRowIds,
  SOLE_EDITOR_WINDOW_MARGIN_MS,
  summarizeForeignHunks,
  type EditAttributionRow,
} from './hunk-exact-admission';
import type { FrozenRepairEditLedgerRow } from './frozen-repair-edit-ledger';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'hunk-home-'));
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
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000, killSignal: 'SIGKILL' }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sweep(root: string, edits: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}
function show(root: string, ref: string, rel: string): string {
  return execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
}

const BASE_A = 'export const a = 1;\nexport const b = 2;\n';
function repo(): { root: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'hunk-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  write(root, 'lib/a.ts', BASE_A);
  write(root, 'lib/b.ts', 'export const bb = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate']);
  return { root, candidate: git(root, ['rev-parse', 'HEAD']) };
}

const T0 = 1_800_000_000_000;
let seq = 0;
const row = (agent: string, path: string, hunk: FrozenRepairEditLedgerRow['hunk'], atMs = T0 + seq): FrozenRepairEditLedgerRow => {
  seq += 1;
  return { id: seq, candidate: 'c'.repeat(40), agent, path, hunk, atMs, toolUseId: `t${seq}`, editIndex: 0, workItem: null };
};

describe('exact ledger consumption and reviewed source snapshots', () => {
  it('excludes a consumed predecessor and retains edits written during a slow precheck', () => {
    const { root, candidate } = repo();
    const first = { ...row('me', 'lib/a.ts', { kind: 'edit' as const, old: 'a = 1', new: 'a = 10', replaceAll: false }), candidate };
    const second = { ...row('me', 'lib/a.ts', { kind: 'edit' as const, old: 'a = 10', new: 'a = 20', replaceAll: false }), candidate };
    const input = { root, candidate, repairHead: candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0 };
    // Second row exists by publication time, but was not in the reviewed source.
    const snapshot = buildHunkExactSource({ ...input, ledger: [first, second], ledgerRowIds: [first.id] });
    if (!snapshot.ok) throw new Error(snapshot.detail);
    expect(snapshot.ledgerRowIds).toEqual([first.id]);
    expect(show(root, snapshot.sourceCommit, 'lib/a.ts')).toBe(BASE_A.replace('a = 1', 'a = 10'));
    const next = buildHunkExactSource({ ...input, repairHead: snapshot.sourceCommit,
      ledger: [first, second], consumedLedgerRowIds: snapshot.ledgerRowIds });
    if (!next.ok) throw new Error(next.detail);
    expect(next.ledgerRowIds).toEqual([second.id]);
    expect(show(root, next.sourceCommit, 'lib/a.ts')).toBe(BASE_A.replace('a = 1', 'a = 20'));
    // A pre-upgrade admission has a captured count but no ids. The second row
    // arrived BEFORE R6 ended, so an admission-time watermark would lose it.
    const legacy = buildHunkExactSource({ ...input, repairHead: snapshot.sourceCommit,
      ledger: [first, second], admissions: [{ atMs: T0 + 1000, actor: 'me',
        source: { ref: snapshot.sourceCommit, sha: snapshot.sourceCommit },
        fromRepairHead: candidate, toRepairHead: snapshot.sourceCommit,
        paths: ['lib/a.ts'], unchanged: [], blobs: {}, mode: 'hunk-exact',
        hunks: { 'lib/a.ts': { applied: 1, agents: ['me'] } } }] });
    if (!legacy.ok) throw new Error(legacy.detail);
    expect(legacy.ledgerRowIds).toEqual([second.id]);
    expect(show(root, legacy.sourceCommit, 'lib/a.ts')).toBe(BASE_A.replace('a = 1', 'a = 20'));
  });

  it('fails closed on missing, foreign, wrong-candidate, wrong-path, duplicate and consumed selections', () => {
    const { root, candidate } = repo();
    const mine = { ...row('me', 'lib/a.ts', { kind: 'edit' as const, old: 'a = 1', new: 'a = 10', replaceAll: false }), candidate };
    const foreign = { ...mine, id: mine.id + 1, agent: 'peer' };
    const otherCandidate = { ...mine, id: mine.id + 2, candidate: 'f'.repeat(40) };
    const otherPath = { ...mine, id: mine.id + 3, path: 'lib/b.ts' };
    const input = { root, candidate, repairHead: candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0,
      ledger: [mine, foreign, otherCandidate, otherPath] };
    for (const ids of [[999999], [foreign.id], [otherCandidate.id], [otherPath.id], [mine.id, mine.id], []]) {
      expect(buildHunkExactSource({ ...input, ledgerRowIds: ids })).toMatchObject({ ok: false, code: 'invalid-ledger-selection' });
    }
    expect(buildHunkExactSource({ ...input, ledgerRowIds: [mine.id], consumedLedgerRowIds: [mine.id] }))
      .toMatchObject({ ok: false, code: 'invalid-ledger-selection' });
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });
});

describe('committed patch recovery without fabricated hook attribution', () => {
  const build = (root: string, repairHead: string, patchCommit: string, paths = ['lib/a.ts']) =>
    buildCommittedPatchSource({ root, repairHead, patchCommit, paths, integrationRef: 'staging', reason: 'reviewed missing-capture repair' });

  it('replays only the selected delta, excluding earlier/later same-file and other-file edits; leaves checkout/index/refs untouched', () => {
    const { root } = repo();
    const original = 'export const a = 1;\n' + Array.from({ length: 12 }, (_, i) => `// separator ${i}\n`).join('') + 'export const b = 2;\n';
    const candidate = sweep(root, { 'lib/a.ts': original }, 'base');
    const foreign = original.replace('b = 2', 'b = 20');
    const parent = sweep(root, { 'lib/a.ts': foreign }, 'prior peer work');
    const patchCommit = sweep(root, { 'lib/a.ts': foreign.replace('a = 1', 'a = 10'), 'lib/b.ts': 'unrelated sweep\n' }, 'mixed sweep');
    const tip = sweep(root, { 'lib/a.ts': foreign.replace('a = 1', 'a = 100') }, 'later peer work');
    const index = git(root, ['write-tree']);
    write(root, 'lib/a.ts', 'uncommitted peer edit\n');
    const result = build(root, candidate, patchCommit);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(show(root, result.sourceCommit, 'lib/a.ts')).toBe(original.replace('a = 1', 'a = 10'));
    expect(show(root, result.sourceCommit, 'lib/b.ts')).toBe('export const bb = 1;\n');
    expect(result.patch).toEqual({ commit: patchCommit, parent, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(git(root, ['write-tree'])).toBe(index);
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(git(root, ['diff', '--', 'lib/a.ts'])).toContain('uncommitted peer edit');
    expect(build(root, candidate, patchCommit)).toEqual(result);
    const admitted = admitPathsOntoRepairHead({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], source: { ref: result.sourceCommit }, actor: 'me', nowMs: T0, dryRun: true });
    expect(admitted).toMatchObject({ ok: true, diff: ['lib/a.ts'], published: false });
    expect(git(root, ['for-each-ref', '--format=%(refname)', 'refs/papercusp/frozen/'])).toBe('');
  });

  it('refuses a conflicting delta instead of copying its full blob or invoking a merge', () => {
    const { root, candidate } = repo();
    sweep(root, { 'lib/a.ts': BASE_A.replace('a = 1', 'a = 5') }, 'foreign prerequisite');
    const patch = sweep(root, { 'lib/a.ts': BASE_A.replace('a = 1', 'a = 10') }, 'repair');
    expect(build(root, candidate, patch)).toMatchObject({ ok: false, code: 'patch-conflict' });
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  it('rejects mutable, root, merge and non-integration sources', () => {
    const { root, candidate } = repo();
    const patch = sweep(root, { 'lib/a.ts': BASE_A.replace('a = 1', 'a = 10') }, 'repair');
    const tree = git(root, ['rev-parse', `${patch}^{tree}`]);
    const unlanded = git(root, ['commit-tree', tree, '-p', candidate, '-m', 'not landed']);
    const merge = git(root, ['commit-tree', tree, '-p', patch, '-p', unlanded, '-m', 'merge']);
    for (const sha of ['HEAD', candidate, unlanded, merge]) {
      expect(build(root, candidate, sha)).toMatchObject({ ok: false, code: 'invalid-patch-source' });
    }
  });

  it('requires reason and changed literal regular-file paths; supports additions/deletions', () => {
    const { root, candidate } = repo();
    const patch = sweep(root, { 'lib/a.ts': BASE_A.replace('a = 1', 'a = 10'), 'lib/[x].ts': 'literal\n', 'lib/x.ts': 'not selected\n' }, 'repair');
    for (const paths of [[], ['lib'], ['../escape'], ['lib/*.ts'], ['lib/b.ts']]) {
      expect(build(root, candidate, patch, paths).ok).toBe(false);
    }
    expect(buildCommittedPatchSource({ root, repairHead: candidate, patchCommit: patch, paths: ['lib/a.ts'], integrationRef: 'staging', reason: '' })).toMatchObject({ ok: false, code: 'invalid-patch-source' });
    const literal = build(root, candidate, patch, ['lib/[x].ts']);
    if (!literal.ok) throw new Error(literal.detail);
    expect(git(root, ['ls-tree', '--name-only', '-r', literal.sourceCommit])).not.toContain('lib/x.ts');
    expect(show(root, literal.sourceCommit, 'lib/[x].ts')).toBe('literal\n');
    rmSync(join(root, 'lib/a.ts'));
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'delete']);
    expect(build(root, patch, git(root, ['rev-parse', 'HEAD']))).toMatchObject({ ok: true });
  });

  it('rejects non-blob source entries and fails closed if the replay proof sees a stray file', () => {
    const { root, candidate } = repo();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${candidate},submodule`]);
    git(root, ['commit', '-qm', 'gitlink']);
    expect(build(root, candidate, git(root, ['rev-parse', 'HEAD']), ['submodule'])).toMatchObject({ ok: false, code: 'not-a-blob' });
    const patchCommit = sweep(root, { 'lib/a.ts': BASE_A.replace('a = 1', 'a = 10') }, 'repair');
    let committed = false;
    const sabotage: AdmissionGitRunner = (argv, opts) => {
      if (argv[0] === 'commit-tree') committed = true;
      if (argv[0] === 'diff' && argv.includes('--cached')) {
        return { status: 0, stdout: 'lib/a.ts\0foreign.ts\0', stderr: '' };
      }
      return realAdmissionGit(argv, opts);
    };
    expect(buildCommittedPatchSource({ root, repairHead: candidate, patchCommit, paths: ['lib/a.ts'], integrationRef: 'staging', reason: 'reviewed bounded fix', git: sabotage }))
      .toMatchObject({ ok: false, code: 'invalid-paths' });
    expect(committed).toBe(false);
  });
});

describe('buildHunkExactSource — only the caller\'s hunks enter (P-020 / D-008)', () => {
  it('replays the caller\'s hunks onto repairHead\'s blob and leaves a stranger\'s concurrent edit on staging OUT of the lineage', () => {
    const { root, candidate } = repo();
    // Staging moves on: my fix (a = 10) AND a peer's unrelated edit (b = 20) land in the same file.
    sweep(root, { 'lib/a.ts': 'export const a = 10;\nexport const b = 20;\n' }, 'sweep: mine + theirs');
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const a = 1;', new: 'export const a = 10;', replaceAll: false }),
      row('peer', 'lib/a.ts', { kind: 'edit', old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false }),
    ];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.detail);
    expect(show(root, built.sourceCommit, 'lib/a.ts')).toBe('export const a = 10;\nexport const b = 2;\n');
    expect(built.perPath[0]).toMatchObject({ path: 'lib/a.ts', applied: 1, agents: ['me'], foreignHunks: 1, foreignAgents: ['peer'], unchanged: false });
    expect(git(root, ['rev-parse', `${built.sourceCommit}^`])).toBe(candidate);
    // Untouched paths are repairHead's, byte for byte.
    expect(show(root, built.sourceCommit, 'lib/b.ts')).toBe('export const bb = 1;\n');

    // And the P-001 primitive admits from it exactly as from any commit: the lineage gets my hunk only.
    const admitted = admitPathsOntoRepairHead({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], source: { ref: built.sourceCommit }, actor: 'me', nowMs: T0 });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.detail);
    expect(show(root, admitted.commit, 'lib/a.ts')).toBe('export const a = 10;\nexport const b = 2;\n');
    expect(admitted.diff).toEqual(['lib/a.ts']);
  });

  it('uses a stable source message and commit dates, so repeated builds ignore nowMs', () => {
    const { root, candidate } = repo();
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const a = 1;', new: 'export const a = 10;', replaceAll: false }),
    ];
    const first = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    const second = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 + 86_400_000 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.sourceCommit).toBe(first.sourceCommit);
    const expectedGitDate = ADMISSION_GIT_DATE.replace(/Z$/, '+00:00');
    expect(git(root, ['show', '-s', '--format=%aI %cI', first.sourceCommit])).toBe(`${expectedGitDate} ${expectedGitDate}`);
  });

  it('includeHunksFrom replays the named peer\'s hunks too — the explicit widening, never chosen by the tool', () => {
    const { root, candidate } = repo();
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const a = 1;', new: 'export const a = 10;', replaceAll: false }),
      row('peer', 'lib/a.ts', { kind: 'edit', old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false }),
    ];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', includeHunksFrom: ['peer'], nowMs: T0 });
    if (!built.ok) throw new Error(built.detail);
    expect(show(root, built.sourceCommit, 'lib/a.ts')).toBe('export const a = 10;\nexport const b = 20;\n');
    expect(built.perPath[0]).toMatchObject({ applied: 2, agents: ['me', 'peer'], foreignHunks: 0 });
  });

  it('no-ledgered-hunks: a path the caller never ledgered is refused naming the peers who did and BOTH exits', () => {
    const { root, candidate } = repo();
    const ledger = [row('peer', 'lib/a.ts', { kind: 'write', body: 'theirs' })];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    expect(built).toMatchObject({ ok: false, code: 'no-ledgered-hunks', path: 'lib/a.ts', foreignAgents: ['peer'] });
    if (built.ok) throw new Error('unreachable');
    expect(built.exits.some((e) => e.includes('includeHunksFrom:["peer"]'))).toBe(true);
    expect(built.exits.some((e) => e.includes('wholeBlob:true'))).toBe(true);
  });

  it('hunk-conflict: a hunk made on top of a foreign change does not apply to repairHead\'s blob — refused, hunk + peers named', () => {
    const { root, candidate } = repo();
    const ledger = [
      row('peer', 'lib/a.ts', { kind: 'edit', old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false }),
      // My edit anchors on the peer's NEW text — it depends on their change.
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const b = 20;', new: 'export const b = 21;', replaceAll: false }),
    ];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    expect(built).toMatchObject({ ok: false, code: 'hunk-conflict', path: 'lib/a.ts', hunkIndex: 0, foreignAgents: ['peer'] });
    if (built.ok) throw new Error('unreachable');
    expect(built.detail).toContain('hunk #1');
    expect(built.detail).toContain('peer');
  });

  it('path-under-gitlink: a file inside a submodule is refused naming the gitlink and its whole-pointer exit, never replayed onto an empty base (WI-10005976)', () => {
    const { root, candidate: plain } = repo();
    // ls-tree needs no .gitmodules: a 160000 index entry is a gitlink. Point it at any commit.
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${plain},vendor/sub`]);
    git(root, ['commit', '-q', '-m', 'add submodule pointer']);
    const withSub = git(root, ['rev-parse', 'HEAD']);
    const inner = 'vendor/sub/src/x.ts';
    const hunk = { kind: 'edit', old: 'export const x = 1;', new: 'export const x = 2;', replaceAll: false } as const;
    // The gitlink at repairHead, and (second pair) only at the candidate.
    for (const [candidate, repairHead] of [[withSub, withSub], [withSub, plain]] as const) {
      const built = buildHunkExactSource({ root, candidate, repairHead, paths: [inner], ledger: [row('me', inner, hunk)], actor: 'me', nowMs: T0 });
      expect(built).toMatchObject({ ok: false, code: 'path-under-gitlink', path: inner });
      if (built.ok) throw new Error('unreachable');
      expect(built.detail).toContain('vendor/sub');
      expect(built.exits).toEqual([expect.stringContaining("paths:['vendor/sub'], wholeBlob:true")]);
    }
    // Control: a path absent from the tree but NOT under a gitlink still replays (and conflicts) as before.
    const missing = buildHunkExactSource({
      root, candidate: withSub, repairHead: withSub, paths: ['lib/missing.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/missing.ts', hunk)],
    });
    expect(missing).toMatchObject({ ok: false, code: 'hunk-conflict', path: 'lib/missing.ts' });
  });

  it('an oversize (content-less) hunk cannot be replayed; a write creates a path repairHead lacks; replaying to the same bytes reads as unchanged', () => {
    const { root, candidate } = repo();
    const oversize = buildHunkExactSource({
      root, candidate, repairHead: candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/a.ts', { kind: 'oversize', of: 'write', bytes: 9, sha256: 'f'.repeat(64) })],
    });
    expect(oversize).toMatchObject({ ok: false, code: 'oversize' });

    const created = buildHunkExactSource({
      root, candidate, repairHead: candidate, paths: ['lib/new.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/new.ts', { kind: 'write', body: 'export const n = 1;\n' })],
    });
    if (!created.ok) throw new Error(created.detail);
    expect(show(root, created.sourceCommit, 'lib/new.ts')).toBe('export const n = 1;\n');
    expect(created.perPath[0]).toMatchObject({ baseBlob: null, unchanged: false });

    const same = buildHunkExactSource({
      root, candidate, repairHead: candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/a.ts', { kind: 'write', body: BASE_A })],
    });
    if (!same.ok) throw new Error(same.detail);
    expect(same.allUnchanged).toBe(true);
    expect(same.tree).toBe(git(root, ['rev-parse', `${candidate}^{tree}`]));
  });

  it('refuses malformed paths and an unresolvable repairHead without building anything', () => {
    const { root, candidate } = repo();
    expect(buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['../x'], ledger: [], actor: 'me', nowMs: T0 })).toMatchObject({ ok: false, code: 'invalid-paths' });
    expect(buildHunkExactSource({ root, candidate, repairHead: 'f'.repeat(40), paths: ['lib/a.ts'], ledger: [], actor: 'me', nowMs: T0 })).toMatchObject({ ok: false, code: 'repair-head-unresolvable' });
  });
});

describe('hunk-already-applied — a hunk repairHead already carries is never replayed twice (WI-6554700010009955)', () => {
  const INSERT = { kind: 'edit' as const, old: 'export const a = 1;\n', new: 'export const a = 1;\nexport const inserted = 3;\n', replaceAll: false };
  const BUMP_B = { kind: 'edit' as const, old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false };
  const ONCE = 'export const a = 1;\nexport const inserted = 3;\nexport const b = 20;\n';

  it('refuses to re-insert a peer hunk a whole-blob admission already carried, and its exit admits ONLY the new hunk', () => {
    const { root, candidate } = repo();
    // A whole-blob admission carried the peer's insertion onto the lineage; it consumes no ledger rows.
    const repairHead = sweep(root, { 'lib/a.ts': BASE_A.replace('a = 1;\n', 'a = 1;\nexport const inserted = 3;\n') }, 'whole-blob admission carrying the insertion');
    const inserted = { ...row('peer', 'lib/a.ts', INSERT), candidate };
    const bumped = { ...row('peer', 'lib/a.ts', BUMP_B), candidate };
    const input = { root, candidate, repairHead, paths: ['lib/a.ts'], actor: 'me', includeHunksFrom: ['peer'], ledger: [inserted, bumped], nowMs: T0 };
    const built = buildHunkExactSource(input);
    expect(built).toMatchObject({ ok: false, code: 'hunk-already-applied', path: 'lib/a.ts', hunkIndex: 0 });
    if (built.ok) throw new Error('unreachable');
    expect(built.detail).toContain(`row #${inserted.id}`);
    expect(built.exits[0]).toContain(`ledgerRowIds:[${bumped.id}]`);
    expect(built.exits[0]).toContain('includeHunksFrom:["peer"]');
    expect(built.exits.some((e) => e.includes('wholeBlob:true'))).toBe(true);
    // Following the exit: the insertion appears exactly once.
    const narrowed = buildHunkExactSource({ ...input, ledgerRowIds: [bumped.id] });
    if (!narrowed.ok) throw new Error(narrowed.detail);
    expect(show(root, narrowed.sourceCommit, 'lib/a.ts')).toBe(ONCE);
    expect(narrowed.ledgerRowIds).toEqual([bumped.id]);
  });

  it('admit A, then A+B from the same owner never duplicates A: consumed rows skip it, and without that bookkeeping the content guard refuses', () => {
    const { root, candidate } = repo();
    const a = { ...row('me', 'lib/a.ts', INSERT), candidate };
    const b = { ...row('me', 'lib/a.ts', BUMP_B), candidate };
    const input = { root, candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0 };
    const first = buildHunkExactSource({ ...input, repairHead: candidate, ledger: [a] });
    if (!first.ok) throw new Error(first.detail);
    const tracked = buildHunkExactSource({ ...input, repairHead: first.sourceCommit, ledger: [a, b], consumedLedgerRowIds: first.ledgerRowIds });
    if (!tracked.ok) throw new Error(tracked.detail);
    expect(show(root, tracked.sourceCommit, 'lib/a.ts')).toBe(ONCE);
    const untracked = buildHunkExactSource({ ...input, repairHead: first.sourceCommit, ledger: [a, b] });
    expect(untracked).toMatchObject({ ok: false, code: 'hunk-already-applied', path: 'lib/a.ts', hunkIndex: 0 });
    if (untracked.ok) throw new Error('unreachable');
    expect(untracked.exits[0]).toContain(`ledgerRowIds:[${b.id}]`);
    expect(untracked.exits[0]).not.toContain('includeHunksFrom');
  });

  it('a replacement repairHead already carries reads as already-applied, not a misleading hunk-conflict; with nothing left only the whole-blob exit remains', () => {
    const { root, candidate } = repo();
    const repairHead = sweep(root, { 'lib/a.ts': BASE_A.replace('b = 2', 'b = 20') }, 'whole-blob admission carrying the bump');
    const built = buildHunkExactSource({ root, candidate, repairHead, paths: ['lib/a.ts'], actor: 'me', nowMs: T0, ledger: [row('me', 'lib/a.ts', BUMP_B)] });
    expect(built).toMatchObject({ ok: false, code: 'hunk-already-applied', path: 'lib/a.ts' });
    if (built.ok) throw new Error('unreachable');
    expect(built.detail).toContain('nothing to admit');
    expect(built.exits).toEqual([expect.stringContaining('wholeBlob:true')]);
  });

  it('findAlreadyAppliedHunks judges in replay order; replaceAll needs every anchor inside a post-image; an anchor miss, an oversize hunk and writes are left to the replay', () => {
    const ed = (old: string, nu: string, replaceAll = false) => ({ kind: 'edit' as const, old, new: nu, replaceAll });
    expect(findAlreadyAppliedHunks('x\n', [ed('x\n', 'x\ny\n')])).toEqual([]);
    expect(findAlreadyAppliedHunks('x\ny\n', [ed('x\n', 'x\ny\n')])).toEqual([0]);
    expect(findAlreadyAppliedHunks('xy x', [ed('x', 'xy', true)])).toEqual([]);
    expect(findAlreadyAppliedHunks('xy xy', [ed('x', 'xy', true)])).toEqual([0]);
    expect(findAlreadyAppliedHunks('a\n', [ed('gone\n', '')])).toEqual([0]);
    expect(findAlreadyAppliedHunks('seed', [ed('', 'seed')])).toEqual([0]);
    expect(findAlreadyAppliedHunks('a = 2', [ed('a = 1', 'a = 10'), ed('a = 10', 'a = 20')])).toEqual([]);
    expect(findAlreadyAppliedHunks('a = 10', [ed('a = 1', 'a = 10'), ed('a = 10', 'a = 20')])).toEqual([0]);
    expect(findAlreadyAppliedHunks('x', [{ kind: 'oversize', of: 'edit', bytes: 1, sha256: 'f'.repeat(64) }, ed('x', 'xy')])).toEqual([]);
    expect(findAlreadyAppliedHunks('old', [{ kind: 'write', body: 'new' }, ed('new', 'new!')])).toEqual([]);
  });
});

describe('findCarriedLedgerRowIds — the rows a whole-blob / committed-patch admission carries (WI-6554700010009991)', () => {
  const ed = (old: string, nu: string, replaceAll = false) => ({ kind: 'edit' as const, old, new: nu, replaceAll });
  const carried = (content: Record<string, string | null>, ledger: FrozenRepairEditLedgerRow[], consumed: number[] = []) =>
    findCarriedLedgerRowIds({ contentByPath: new Map(Object.entries(content)), ledger, consumedLedgerRowIds: consumed });

  it('names every row whose effect is in the real admitted content, in ledger order and across agents', () => {
    const insert = row('me', 'lib/a.ts', ed('x\n', 'x\ny\n'));
    const replace = row('peer', 'lib/a.ts', ed('a = 1', 'a = 2'));
    const write = row('me', 'lib/b.ts', { kind: 'write', body: 'whole\n' });
    const absent = row('me', 'lib/a.ts', ed('z = 1', 'z = 9'));
    expect(carried({ 'lib/a.ts': 'x\ny\na = 2\nz = 1\n', 'lib/b.ts': 'whole\n' }, [insert, replace, write, absent])).toEqual([
      insert.id,
      replace.id,
      write.id,
    ]);
  });

  it('judges each row alone: an applicable-but-absent row does not make a dependent row look carried', () => {
    // Sequence judgement would apply row 1 to a virtual content and then find row 2's post-image
    // there. The real blob carries neither, so neither may be consumed.
    const first = row('me', 'lib/a.ts', ed('x\n', 'x\ny\n'));
    const second = row('me', 'lib/a.ts', ed('q', 'y'));
    expect(findAlreadyAppliedHunks('x\n', [first.hunk, second.hunk])).toEqual([1]);
    expect(carried({ 'lib/a.ts': 'x\n' }, [first, second])).toEqual([]);
  });

  it('never carries an oversize row, an already-consumed row, or a row on a deleted or unread path', () => {
    const oversize = row('me', 'lib/a.ts', { kind: 'oversize', of: 'edit', bytes: 1, sha256: 'f'.repeat(64) });
    const consumedRow = row('me', 'lib/a.ts', ed('x\n', 'x\ny\n'));
    const onDeleted = row('me', 'lib/gone.ts', ed('x\n', 'x\ny\n'));
    const onUnread = row('me', 'lib/b.ts', ed('x\n', 'x\ny\n'));
    expect(carried({ 'lib/a.ts': 'x\ny\n', 'lib/gone.ts': null }, [oversize, consumedRow, onDeleted, onUnread], [consumedRow.id])).toEqual([]);
  });
});


describe('summarizeForeignHunks — what a whole-blob admission may carry (D-008 layer 3b)', () => {
  it('counts ledgered hunks on the paths by agents other than the actor (∪ include)', () => {
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'write', body: 'x' }),
      row('peer', 'lib/a.ts', { kind: 'write', body: 'y' }),
      row('peer', 'lib/a.ts', { kind: 'write', body: 'z' }),
      row('other', 'lib/b.ts', { kind: 'write', body: 'w' }),
      row('other', 'lib/c.ts', { kind: 'write', body: 'v' }), // not admitted — not counted
    ];
    expect(summarizeForeignHunks(ledger, ['./lib/a.ts', 'lib/b.ts'], 'me')).toEqual({ count: 3, agents: ['other', 'peer'], byPath: { 'lib/a.ts': 2, 'lib/b.ts': 1 } });
    expect(summarizeForeignHunks(ledger, ['lib/a.ts'], 'me', ['peer'])).toEqual({ count: 0, agents: [], byPath: {} });
  });
});

// P-004 (gate-throughput-shift-left-2026-10-06, R-4): attribution when the hunk ledger missed.
describe('attributeUnledgeredPaths — sole post-freeze editor', () => {
  const W = 1_000_000;
  const row = (path: string, agent: string, tsMs = W + 1): EditAttributionRow => ({ path, agent, tsMs });

  it('attributes every path to the caller when the caller is the only recorded editor (the EI-24557368838482892 shape)', () => {
    const v = attributeUnledgeredPaths({
      paths: ['lib/adv-sessions.test.ts', 'lib/queue.test.ts'],
      actor: 'su-me',
      rows: [row('lib/adv-sessions.test.ts', 'su-me'), row('lib/queue.test.ts', 'su-me'), row('lib/queue.test.ts', 'su-me', W + 5)],
      windowStartMs: W,
    });
    expect(v).toEqual({ ok: true, agentsByPath: { 'lib/adv-sessions.test.ts': ['su-me'], 'lib/queue.test.ts': ['su-me'] } });
  });

  it("refuses, naming them, when a peer also edited the path — a peer's concurrent hunk is never admitted", () => {
    const v = attributeUnledgeredPaths({
      paths: ['lib/a.ts'],
      actor: 'su-me',
      rows: [row('lib/a.ts', 'su-me'), row('lib/a.ts', 'su-peer')],
      windowStartMs: W,
    });
    expect(v).toMatchObject({ ok: false, reason: 'peer-edits', path: 'lib/a.ts', peers: ['su-peer'] });
    if (!v.ok) expect(v.detail).toContain('su-peer');
  });

  it('a system writer counts as a peer, and includeHunksFrom widens who counts as the caller', () => {
    expect(
      attributeUnledgeredPaths({ paths: ['lib/a.ts'], actor: 'su-me', rows: [row('lib/a.ts', 'su-me'), row('lib/a.ts', 'system:gen')], windowStartMs: W }),
    ).toMatchObject({ ok: false, reason: 'peer-edits', peers: ['system:gen'] });
    expect(
      attributeUnledgeredPaths({
        paths: ['lib/a.ts'],
        actor: 'su-me',
        includeHunksFrom: ['su-pair'],
        rows: [row('lib/a.ts', 'su-me'), row('lib/a.ts', 'su-pair')],
        windowStartMs: W,
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses no-recorded-edits when nobody is recorded, and ignores edits before the window', () => {
    const v = attributeUnledgeredPaths({
      paths: ['lib/a.ts'],
      actor: 'su-me',
      rows: [row('lib/a.ts', 'su-me', W - 1), row('lib/other.ts', 'su-me')],
      windowStartMs: W,
    });
    expect(v).toMatchObject({ ok: false, reason: 'no-recorded-edits', path: 'lib/a.ts', peers: [] });
  });

  it('one unattributable path refuses the whole admission (no partial widening)', () => {
    const v = attributeUnledgeredPaths({
      paths: ['lib/a.ts', 'lib/b.ts'],
      actor: 'su-me',
      rows: [row('lib/a.ts', 'su-me'), row('lib/b.ts', 'su-peer')],
      windowStartMs: W,
    });
    expect(v).toMatchObject({ ok: false, path: 'lib/b.ts' });
  });

  it('the window opens before the candidate cut by the sweep margin', () => {
    expect(SOLE_EDITOR_WINDOW_MARGIN_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

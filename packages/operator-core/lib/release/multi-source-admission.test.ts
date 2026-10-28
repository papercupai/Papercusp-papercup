/**
 * change-provenance-and-admission-throughput-2026-10-27#P-002 (R-2): one admit, an ordered list of
 * whole-blob and committed-patch sources, ONE synthesized source and ONE built admission commit.
 * Falsifiers covered: a second built commit, a source dropped or applied out of order, a partial
 * admission when one source is refused, and a cohort check that loses the real whole-blob source.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { admitPathsOntoRepairHead } from './repair-head-admission';
import { buildMultiSourceAdmissionSource, normalizeAdmissionSources } from './multi-source-admission';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'multi-source-home-'));
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};
const git = (root: string, args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000, killSignal: 'SIGKILL' }).trim();
const show = (root: string, ref: string, rel: string) =>
  execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
function sweep(root: string, edits: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}

// The peer's drift (last line) sits well outside the reviewed delta's 3-line diff context.
const DRAG_BASE = 'import { a } from "../lib/a";\nexpect(a).toBe(1);\n' + '// pad\n'.repeat(8) + 'const unrelated = 0;\n';
/** candidate → a peer's unrelated drift → wholeBlob fix (lib/a.ts) → a reviewed delta to the dragged test. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'multi-source-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  const candidate = sweep(root, { 'lib/a.ts': 'export const a = 1;\n', 'test/drag.test.ts': DRAG_BASE, 'lib/b.ts': 'b0\n' }, 'candidate');
  sweep(root, { 'test/drag.test.ts': DRAG_BASE.replace('const unrelated = 0;', 'const unrelated = 99;') }, 'peer drift on the dragged test');
  const fixA = sweep(root, { 'lib/a.ts': 'export const a = 2;\n' }, 'fix a');
  // The reviewed delta changes ONLY the assertion line; the peer's drift on line 3 must not ride in.
  const dragFix = sweep(root, { 'test/drag.test.ts': DRAG_BASE.replace('const unrelated = 0;', 'const unrelated = 99;').replace('toBe(1)', 'toBe(2)') }, 'fix drag test');
  const bFix = sweep(root, { 'lib/b.ts': 'b1\n' }, 'b1');
  const bFix2 = sweep(root, { 'lib/b.ts': 'b2\n' }, 'b2');
  return { root, candidate, fixA, dragFix, bFix, bFix2 };
}
const REASON = 'reviewed: leader lands two ready batches';
const sources = (raw: unknown) => {
  const n = normalizeAdmissionSources(raw);
  if (!n.ok) throw new Error(n.detail);
  return n.sources;
};

describe('multi-source admission (R-2)', () => {
  it('applies a whole-blob and a committed-patch source in one synthesized source, and the door builds ONE commit', () => {
    const f = fixture();
    const refsBefore = git(f.root, ['for-each-ref']);
    const built = buildMultiSourceAdmissionSource({
      root: f.root,
      repairHead: f.candidate,
      integrationRef: 'staging',
      reason: REASON,
      sources: sources([{ paths: ['lib/a.ts'], wholeBlob: true }, { paths: ['test/drag.test.ts'], patchCommit: f.dragFix }]),
    });
    if (!built.ok) throw new Error(built.detail);
    expect(built.paths).toEqual(['lib/a.ts', 'test/drag.test.ts']);
    expect(built.applied.map((s) => s.kind)).toEqual(['whole-blob', 'committed-patch']);
    expect(built.cohortSources).toEqual([{ sourceCommit: git(f.root, ['rev-parse', 'staging']), paths: ['lib/a.ts'] }]);
    expect(show(f.root, built.sourceCommit, 'lib/a.ts')).toBe('export const a = 2;\n');
    // Delta only: the assertion moved, the peer's drift on the same file did NOT ride in.
    expect(show(f.root, built.sourceCommit, 'test/drag.test.ts')).toBe(DRAG_BASE.replace('toBe(1)', 'toBe(2)'));
    expect(git(f.root, ['diff', '--name-only', f.candidate, built.sourceCommit]).split('\n')).toEqual(['lib/a.ts', 'test/drag.test.ts']);
    // Nothing published while building.
    expect(git(f.root, ['for-each-ref'])).toBe(refsBefore);

    const admitted = admitPathsOntoRepairHead({
      root: f.root, candidate: f.candidate, repairHead: f.candidate, paths: built.paths,
      source: { ref: built.sourceCommit }, actor: 'leader', reason: REASON, nowMs: 1_800_000_000_000, dryRun: true,
    });
    if (!admitted.ok) throw new Error(admitted.detail);
    expect(admitted.diff).toEqual(['lib/a.ts', 'test/drag.test.ts']);
    // ONE built commit, directly on repairHead.
    expect(git(f.root, ['rev-list', '--parents', '-n', '1', admitted.commit]).split(' ')).toEqual([admitted.commit, f.candidate]);
    expect(git(f.root, ['rev-parse', `${admitted.commit}^{tree}`])).toBe(built.tree);
  });

  it('keeps the given order: dependent deltas across sources apply oldest-first and refuse when reversed', () => {
    const f = fixture();
    const forward = buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: REASON,
      sources: sources([{ paths: ['lib/b.ts'], patchCommit: f.bFix }, { paths: ['lib/b.ts'], patchCommit: f.bFix2 }]),
    });
    if (!forward.ok) throw new Error(forward.detail);
    expect(show(f.root, forward.sourceCommit, 'lib/b.ts')).toBe('b2\n');
    expect(forward.patches.map((p) => p.commit)).toEqual([f.bFix, f.bFix2]);

    const reversed = buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: REASON,
      sources: sources([{ paths: ['lib/b.ts'], patchCommit: f.bFix2 }, { paths: ['lib/b.ts'], patchCommit: f.bFix }]),
    });
    expect(reversed).toMatchObject({ ok: false, code: 'patch-conflict', sourceIndex: 0 });
  });

  it('a patch may layer on an earlier whole-blob path; a whole-blob may not overwrite an earlier source', () => {
    const f = fixture();
    const layered = buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: REASON,
      sources: sources([{ paths: ['lib/b.ts'], wholeBlob: true, sourceCommit: f.bFix }, { paths: ['lib/b.ts'], patchCommit: f.bFix2 }]),
    });
    if (!layered.ok) throw new Error(layered.detail);
    expect(show(f.root, layered.sourceCommit, 'lib/b.ts')).toBe('b2\n');
    expect(normalizeAdmissionSources([{ paths: ['lib/b.ts'], patchCommit: f.bFix }, { paths: ['lib/b.ts'], wholeBlob: true }]))
      .toMatchObject({ ok: false, code: 'invalid-sources', sourceIndex: 1 });
  });

  it('is all-or-nothing: one refused source refuses the call and publishes nothing', () => {
    const f = fixture();
    const refsBefore = git(f.root, ['for-each-ref']);
    // dragFix does not change lib/b.ts → the second source is refused.
    const refused = buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: REASON,
      sources: sources([{ paths: ['lib/a.ts'], wholeBlob: true }, { paths: ['lib/b.ts'], patchCommit: f.dragFix }]),
    });
    expect(refused).toMatchObject({ ok: false, code: 'invalid-paths', sourceIndex: 1 });
    expect(git(f.root, ['for-each-ref'])).toBe(refsBefore);
    expect(git(f.root, ['status', '--porcelain'])).toBe('');
  });

  it('names every distinct whole-blob source for the cohort check, never the synthesized commit', () => {
    const f = fixture();
    const built = buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: REASON,
      sources: sources([
        { paths: ['lib/a.ts'], wholeBlob: true, sourceCommit: f.fixA },
        { paths: ['lib/b.ts'], wholeBlob: true, sourceCommit: f.bFix },
      ]),
    });
    if (!built.ok) throw new Error(built.detail);
    expect(built.cohortSources).toEqual([
      { sourceCommit: f.fixA, paths: ['lib/a.ts'] },
      { sourceCommit: f.bFix, paths: ['lib/b.ts'] },
    ]);
    expect(built.cohortSources.map((c) => c.sourceCommit)).not.toContain(built.sourceCommit);
    // Two whole-blob sources reading the same commit share ONE cohort entry with both paths.
    const shared = buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: REASON,
      sources: sources([
        { paths: ['lib/a.ts'], wholeBlob: true, sourceCommit: f.bFix },
        { paths: ['lib/b.ts'], wholeBlob: true, sourceCommit: f.bFix },
      ]),
    });
    if (!shared.ok) throw new Error(shared.detail);
    expect(shared.cohortSources).toEqual([{ sourceCommit: f.bFix, paths: ['lib/a.ts', 'lib/b.ts'] }]);
    expect(show(f.root, built.sourceCommit, 'lib/b.ts')).toBe('b1\n');
  });

  it('refuses malformed source lists and a missing reason before touching git', () => {
    const sha = 'a'.repeat(40);
    for (const raw of [
      [],
      [{ paths: ['x'], wholeBlob: true, patchCommit: sha }],
      [{ paths: ['x'], patchCommit: sha, sourceCommit: sha }],
      [{ paths: [], wholeBlob: true }],
      [{ paths: ['../escape'], wholeBlob: true }],
      [{ paths: ['x'], patchCommits: [sha, sha] }],
      [{ paths: ['x'], patchCommit: 'abc' }],
    ]) {
      expect(normalizeAdmissionSources(raw)).toMatchObject({ ok: false, code: 'invalid-sources' });
    }
    const f = fixture();
    expect(buildMultiSourceAdmissionSource({
      root: f.root, repairHead: f.candidate, integrationRef: 'staging', reason: 'short',
      sources: sources([{ paths: ['lib/a.ts'], wholeBlob: true }]),
    })).toMatchObject({ ok: false, code: 'reason_required' });
  });
});

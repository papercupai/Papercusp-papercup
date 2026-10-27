import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLEANUP_AGGRESSIVENESS, executorBatchFromTriage, nativeExecutorDeps, nextExecutorStep, validateExecutorChange,
  type CharacterizationRecord, type CleanupAggressiveness, type CoverageView, type ExecutorBatch, type ExecutorDeps,
  type ExecutorMember, type ExecutorStep,
} from './executor';
import type { TriageBatch } from './triage';

const a: ExecutorMember = { path: 'pkg/a.ts', line: 10, endLine: 20, symbol: 'parseA' };
const b: ExecutorMember = { path: 'pkg/b.ts', line: 30, endLine: 40, symbol: 'parseB' };
const key = (m: ExecutorMember) => `${m.path}#${m.symbol}`;

/** A coverage map taken at `commit` (null = unknown) answering from `covered`. Absent members answer []. */
function map(commit: string | null, covered: Record<string, readonly string[] | null>): CoverageView {
  return { takenAt: { commit, observedAt: null }, coveringTests: m => (key(m) in covered ? covered[key(m)]! : []) };
}

/** Commits land in this order; a map at c is "at or after" every commit at or before c. */
const ORDER = ['c0', 'c1', 'c2', 'c3'];
const deps: ExecutorDeps = {
  async coverageTakenAtOrAfter(view, commit) {
    if (!view.takenAt.commit) return null;
    return ORDER.indexOf(view.takenAt.commit) >= ORDER.indexOf(commit);
  },
};

const batch: ExecutorBatch = { id: 'pkg#0', members: [a, b] };
const step = (aggressiveness: CleanupAggressiveness, coverage: CoverageView, characterization?: CharacterizationRecord | null) =>
  nextExecutorStep({ batch, aggressiveness, coverage, characterization }, deps);

const landed = (commit: string | null, testFiles = ['pkg/b.characterization.test.ts']): CharacterizationRecord =>
  ({ batchId: batch.id, members: [b], testFiles, landedCommit: commit });

describe('nextExecutorStep — R-6 sequencing', () => {
  it('a new campaign defaults to safe (D-007)', () => {
    expect(DEFAULT_CLEANUP_AGGRESSIVENESS).toBe('safe');
  });

  it('refactors a batch whose every member the coverage map reports covered, at every aggressiveness', async () => {
    const coverage = map('c0', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.test.ts'] });
    for (const level of ['safe', 'standard', 'thorough'] as const) {
      expect(await step(level, coverage)).toEqual({ kind: 'refactor', batchId: 'pkg#0', members: [a, b] });
    }
  });

  it('under standard, an uncovered member yields a characterization step for that member, never a refactor', async () => {
    const s = await step('standard', map('c0', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: [] }));
    expect(s.kind).toBe('characterize');
    expect(s).toMatchObject({ batchId: 'pkg#0', members: [b] });
  });

  it('thorough sequences an uncovered member exactly like standard', async () => {
    const s = await step('thorough', map('c0', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: [] }));
    expect(s).toMatchObject({ kind: 'characterize', members: [b] });
  });

  it('under safe, the same batch is excluded instead', async () => {
    const s = await step('safe', map('c0', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: [] }));
    expect(s).toMatchObject({ kind: 'exclude', reason: 'uncovered-under-safe', members: [b] });
  });

  it('a member the map cannot answer for (null — no execution evidence) counts as uncovered', async () => {
    const coverage = map('c0', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: null });
    expect((await step('standard', coverage)).kind).toBe('characterize');
    expect((await step('safe', coverage)).kind).toBe('exclude');
  });

  it('waits while the characterization change has not landed', async () => {
    const coverage = map('c3', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'] });
    expect(await step('standard', coverage, landed(null))).toMatchObject({ kind: 'wait', reason: 'characterization-unlanded' });
  });

  it('refuses to proceed on a coverage map older than the characterization change, even one reporting the member covered', async () => {
    const stale = map('c1', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'] });
    const s = await step('standard', stale, landed('c2'));
    expect(s).toMatchObject({ kind: 'wait', reason: 'coverage-map-stale' });
    expect((s as { detail: string }).detail).toContain('predates characterization commit c2');
  });

  it('treats a map it cannot place after the characterization commit as stale', async () => {
    const unplaced = map(null, { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'] });
    expect(await step('standard', unplaced, landed('c2'))).toMatchObject({ kind: 'wait', reason: 'coverage-map-stale' });
  });

  it('refuses when a fresh map still reports the member uncovered', async () => {
    const s = await step('standard', map('c3', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: [] }), landed('c2'));
    expect(s).toMatchObject({ kind: 'refuse', reason: 'characterization-did-not-cover', members: [b] });
  });

  it('refuses when the member is covered only by a test that is not one of the characterization files', async () => {
    const s = await step('standard', map('c3', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/other.test.ts'] }), landed('c2'));
    expect(s).toMatchObject({ kind: 'refuse', reason: 'characterization-did-not-cover' });
  });

  it('refactors once a map taken at or after the characterization commit shows its tests covering the member', async () => {
    const covered = { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'] };
    for (const commit of ['c2', 'c3']) {
      expect(await step('standard', map(commit, covered), landed('c2'))).toMatchObject({ kind: 'refactor', members: [a, b] });
    }
  });

  it('characterizes members the earlier characterization did not include before refactoring', async () => {
    const c: ExecutorMember = { path: 'pkg/c.ts', line: 5, endLine: 9, symbol: 'parseC' };
    const coverage = map('c3', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'], [key(c)]: [] });
    const s = await nextExecutorStep({ batch: { id: 'pkg#0', members: [a, b, c] }, aggressiveness: 'standard', coverage,
      characterization: landed('c2') }, deps);
    expect(s).toMatchObject({ kind: 'characterize', members: [c] });
  });

  it('never emits a refactor before the characterization has landed and a fresh map shows it covering', async () => {
    const seen: ExecutorStep['kind'][] = [];
    const uncoveredMap = map('c0', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: [] });
    seen.push((await step('standard', uncoveredMap)).kind);
    seen.push((await step('standard', uncoveredMap, landed(null))).kind);
    seen.push((await step('standard', map('c1', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'] }), landed('c2'))).kind);
    seen.push((await step('standard', map('c2', { [key(a)]: ['pkg/a.test.ts'], [key(b)]: ['pkg/b.characterization.test.ts'] }), landed('c2'))).kind);
    expect(seen).toEqual(['characterize', 'wait', 'wait', 'refactor']);
  });

  it('rejects a characterization record from another batch', async () => {
    await expect(step('standard', map('c3', {}), { ...landed('c2'), batchId: 'other#1' })).rejects.toThrow(/belongs to batch other#1/);
  });
});

describe('validateExecutorChange — characterization and refactor never share a change', () => {
  const characterize: ExecutorStep = { kind: 'characterize', batchId: 'pkg#0', members: [b], detail: '' };
  const refactor: ExecutorStep = { kind: 'refactor', batchId: 'pkg#0', members: [a, b] };

  it('accepts a characterization change of test files only, and a refactor change of source files only', () => {
    expect(validateExecutorChange(characterize, ['pkg/b.characterization.test.ts'])).toEqual([]);
    expect(validateExecutorChange(refactor, ['pkg/a.ts', 'pkg/b.ts', 'pkg/shared.ts'], landed('c2'))).toEqual([]);
  });

  it('refuses a characterization change that also edits source', () => {
    expect(validateExecutorChange(characterize, ['pkg/b.characterization.test.ts', 'pkg/b.ts']))
      .toEqual(['characterization change touches non-test file pkg/b.ts; the refactor must land in a separate change']);
  });

  it('refuses a refactor change that carries the characterization tests', () => {
    expect(validateExecutorChange(refactor, ['pkg/a.ts', 'pkg/b.characterization.test.ts'], landed('c2'))[0])
      .toContain('also edits characterization test file pkg/b.characterization.test.ts');
  });

  it('refuses a refactor change that edits any covering test', () => {
    expect(validateExecutorChange(refactor, ['pkg/a.ts', 'pkg/a.test.ts'])[0]).toContain('refactor change edits test file pkg/a.test.ts');
  });

  it('a non-landing step lands nothing, and an empty change is refused', () => {
    expect(validateExecutorChange({ kind: 'wait', batchId: 'x', reason: 'coverage-map-stale', detail: '' }, ['pkg/a.ts']))
      .toEqual(["a 'wait' step lands no change"]);
    expect(validateExecutorChange(refactor, [])).toEqual(['the refactor change has no files']);
  });
});

describe('executorBatchFromTriage', () => {
  it('names the batch area#index and lists every family member with its resolved end line', () => {
    const triage: TriageBatch = { area: 'packages/x/lib', index: 2, score: 1, redundantMass: 9, families: [
      { id: 'f1', score: 1, churn: 0, redundantMass: 9, packageDistance: 0, coChange: { minLinkScore: 1, files: 2, basis: 'file' },
        members: [{ path: 'packages/x/lib/a.ts', line: 3, symbol: 'f' }, { path: 'packages/x/lib/b.ts', line: 7, symbol: 'g' }] },
    ] };
    const out = executorBatchFromTriage(triage, m => m.line + 4);
    expect(out).toEqual({ id: 'packages/x/lib#2', members: [
      { path: 'packages/x/lib/a.ts', line: 3, symbol: 'f', endLine: 7 },
      { path: 'packages/x/lib/b.ts', line: 7, symbol: 'g', endLine: 11 },
    ] });
  });
});

describe('nativeExecutorDeps — git-backed ordering', () => {
  const repo = mkdtempSync(join(tmpdir(), 'executor-order-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  const commitAt = (file: string, date: string) => {
    writeFileSync(join(repo, file), file);
    git('add', file);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', file], {
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    return git('rev-parse', 'HEAD');
  };
  const first = commitAt('one.txt', '2026-01-01T00:00:00Z');
  const second = commitAt('two.txt', '2026-01-02T00:00:00Z');
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const native = nativeExecutorDeps(repo);
  const view = (commit: string | null, observedAt: string | null): CoverageView =>
    ({ takenAt: { commit, observedAt }, coveringTests: () => [] });

  it('uses ancestry when the map names its candidate commit', async () => {
    expect(await native.coverageTakenAtOrAfter(view(second, null), first)).toBe(true);
    expect(await native.coverageTakenAtOrAfter(view(second, null), second)).toBe(true);
    expect(await native.coverageTakenAtOrAfter(view(first, null), second)).toBe(false);
  });

  it('falls back to observation time against the commit time', async () => {
    expect(await native.coverageTakenAtOrAfter(view(null, '2026-01-02T12:00:00Z'), second)).toBe(true);
    expect(await native.coverageTakenAtOrAfter(view(null, '2026-01-01T12:00:00Z'), second)).toBe(false);
  });

  it('answers null (stale) when it cannot place the map', async () => {
    expect(await native.coverageTakenAtOrAfter(view(null, null), second)).toBeNull();
    expect(await native.coverageTakenAtOrAfter(view('0'.repeat(40), null), second)).toBeNull();
    expect(await native.coverageTakenAtOrAfter(view(null, '2026-01-02T12:00:00Z'), 'not-a-commit')).toBeNull();
  });
});

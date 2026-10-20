import { describe, expect, it } from 'vitest';
import {
  bisectSelectingCommits,
  compareComposedProofShadow,
  isTestFileId,
  parseCommitPathLog,
  parseRatchetShadowHealth,
  planComposedProofShadow,
  planNewRedEjectionShadow,
  sameTest,
  type RadiusQuery,
} from './ratchet-shadow';
import type { CandidateCommit } from './new-red-ejection';

/** A radius seam over a static path → tests map; counts calls. */
function radiusFrom(map: Record<string, string[]>, opts: { widenOver?: number } = {}) {
  const calls: string[][] = [];
  const query: RadiusQuery = async (paths) => {
    calls.push([...paths]);
    if (opts.widenOver !== undefined && paths.length > opts.widenOver) return null;
    return new Set(paths.flatMap((p) => map[p] ?? []));
  };
  return { query, calls };
}

describe('test identity', () => {
  it('matches repo-relative and workspace-relative spellings, not unrelated suffixes', () => {
    expect(sameTest('packages/x/lib/a.test.ts', 'lib/a.test.ts')).toBe(true);
    expect(sameTest('lib/a.test.ts', 'lib/a.test.ts')).toBe(true);
    expect(sameTest('lib/ba.test.ts', 'a.test.ts')).toBe(false);
  });
  it('treats task ids, lint legs and generator checks as legs', () => {
    expect(isTestFileId('lib/release/a.test.ts')).toBe(true);
    expect(isTestFileId('@papercusp/operator-core :: test')).toBe(false);
    expect(isTestFileId('lint:tsc')).toBe(false);
    expect(isTestFileId('gen:contract:check')).toBe(false);
  });
});

describe('composed proof shadow (P-018, D-025)', () => {
  const changed = [
    { path: 'pkg/src/a.ts', before: 'export const a = 1;', after: 'export const a = 2;' },
    { path: 'pkg/src/types.ts', before: 'export interface T { a: number }', after: 'export interface T { a: string }' },
  ];

  it('skips when the round-1 failing set is capped, because uncarried failures would read as passing', async () => {
    const { query } = radiusFrom({});
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts'], failingCount: 50 },
      changedFiles: changed,
      radius: query,
      nowMs: 1,
    });
    expect(s.record.status).toBe('skipped');
    expect(s.record.reason).toMatch(/capped/);
    expect(s.plan).toBeNull();
  });

  it('re-runs only the radius of runtime-changing files; a type-only file costs no query and carried failures stay', async () => {
    const { query, calls } = radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] });
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['src/a.test.ts', 'pkg/src/other.test.ts', 'lint:tsc'], failingCount: 3 },
      changedFiles: changed,
      radius: query,
      nowMs: 1,
    });
    expect(calls).toEqual([['pkg/src/a.ts']]);
    expect(s.record).toMatchObject({ status: 'planned', mode: 'composed', typeOnlyFileCount: 1, runtimeFileCount: 1 });
    // The workspace-relative round-1 id matches the repo-relative radius entry: re-run, not carried.
    expect(s.record.carriedFailing).toEqual(['pkg/src/other.test.ts']);
    expect(s.record.rerunLegs).toEqual(['lint:tsc']);
  });

  it('plans the full gate when the radius of a runtime change cannot be computed', async () => {
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: [], failingCount: 0 },
      changedFiles: changed,
      radius: async () => null,
      nowMs: 1,
    });
    expect(s.record).toMatchObject({ status: 'planned', mode: 'full-gate' });
    expect(compareComposedProofShadow(s, { green: false, failingTests: ['x.test.ts'] }).comparison?.agree).toBe(true);
  });

  it('agrees when the full run reports exactly the carried failure', async () => {
    const { query } = radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] });
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts', 'pkg/src/other.test.ts'], failingCount: 2 },
      changedFiles: changed,
      radius: query,
      nowMs: 1,
    });
    const r = compareComposedProofShadow(s, { green: false, failingTests: ['pkg/src/other.test.ts'] });
    expect(r.comparison).toMatchObject({ agree: true, composedGreen: false, fullGreen: false, missedByComposed: [], extraInComposed: [] });
  });

  it('records a disagreement when the full run fails a test outside the radius that was not red in round 1', async () => {
    const { query } = radiusFrom({ 'pkg/src/a.ts': ['pkg/src/a.test.ts'] });
    const s = await planComposedProofShadow({
      candidate: 'c1',
      repairHead: 'h1',
      round1: { failingTests: ['pkg/src/a.test.ts'], failingCount: 1 },
      changedFiles: changed,
      radius: query,
      nowMs: 1,
    });
    const r = compareComposedProofShadow(s, { green: false, failingTests: ['pkg/src/elsewhere.test.ts'] });
    expect(r.comparison).toMatchObject({ agree: false, composedGreen: true, missedByComposed: ['pkg/src/elsewhere.test.ts'] });
  });
});

describe('selecting-commit bisection', () => {
  const commits: CandidateCommit[] = Array.from({ length: 8 }, (_, i) => ({ sha: `s${i}`, author: null, paths: [`src/f${i}.ts`] }));

  it('finds the one selecting commit among eight with fewer queries than one per commit', async () => {
    const { query, calls } = radiusFrom({ 'src/f5.ts': ['src/t.test.ts'] });
    const r = await bisectSelectingCommits({ tests: ['src/t.test.ts'], commits, radius: query, maxQueries: 50, budgetMs: 60_000 });
    expect([...(r.selecting.get('src/t.test.ts') ?? [])]).toEqual(['s5']);
    expect(r.unknown.size).toBe(0);
    expect(calls.length).toBeLessThan(8);
  });

  it('splits a widened range instead of giving up, and a widened leaf reads as unknown', async () => {
    const { query } = radiusFrom({ 'src/f2.ts': ['src/t.test.ts'] }, { widenOver: 2 });
    const r = await bisectSelectingCommits({ tests: ['src/t.test.ts'], commits, radius: query, maxQueries: 50, budgetMs: 60_000 });
    expect([...(r.selecting.get('src/t.test.ts') ?? [])]).toEqual(['s2']);
    const leafWidened = await bisectSelectingCommits({
      tests: ['src/t.test.ts'],
      commits: commits.slice(0, 1),
      radius: async () => null,
      maxQueries: 5,
      budgetMs: 60_000,
    });
    expect([...(leafWidened.unknown.get('src/t.test.ts') ?? [])]).toEqual(['s0']);
  });

  it('marks unresolved commits unknown when the query budget runs out, but still counts a direct hit', async () => {
    const withTestEdit = [...commits, { sha: 's8', author: null, paths: ['src/t.test.ts'] }];
    const { query } = radiusFrom({}, { widenOver: 0 });
    const r = await bisectSelectingCommits({ tests: ['src/t.test.ts'], commits: withTestEdit, radius: query, maxQueries: 1, budgetMs: 60_000 });
    expect(r.exhausted).toBe(true);
    expect(r.selecting.get('src/t.test.ts')?.has('s8')).toBe(true);
    expect(r.unknown.get('src/t.test.ts')?.size).toBe(8);
  });
});

describe('new-red ejection shadow (P-007, D-025)', () => {
  const commits: CandidateCommit[] = [
    { sha: 'a', author: null, paths: ['src/a.ts'] },
    { sha: 'b', author: null, paths: ['src/b.ts'] },
    { sha: 'c', author: null, paths: ['src/c.ts'] },
  ];

  it('plans an ejection of the single selecting commit, radius-only (no blame check in shadow)', async () => {
    const { query } = radiusFrom({ 'src/b.ts': ['src/b.test.ts'] });
    const r = await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: ['src/b.test.ts'], commits, radius: query, maxQueries: 20, budgetMs: 60_000 });
    expect(r).toMatchObject({ status: 'planned', plan: 'eject', ejected: ['b'], blameCheck: 'not-run', budgetExhausted: false });
    expect(r.attributions).toEqual([{ test: 'src/b.test.ts', kind: 'attributed', commit: 'b' }]);
  });

  it('freezes when two commits select the failing test', async () => {
    const { query } = radiusFrom({ 'src/a.ts': ['src/x.test.ts'], 'src/c.ts': ['src/x.test.ts'] });
    const r = await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: ['src/x.test.ts'], commits, radius: query, maxQueries: 20, budgetMs: 60_000 });
    expect(r).toMatchObject({ status: 'planned', plan: 'freeze', unattributableByReason: { 'several-commits-select-test': 1 } });
  });

  it('reports nothing-new without file-level failures, and skips an unreadable range', async () => {
    const { query } = radiusFrom({});
    expect((await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: [], commits, radius: query, maxQueries: 5, budgetMs: 1 })).status).toBe('nothing-new');
    const skipped = await planNewRedEjectionShadow({ candidate: 'C', base: 'B', newFailures: ['src/b.test.ts'], commits: null, radius: query, maxQueries: 5, budgetMs: 1 });
    expect(skipped).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/unreadable/) });
  });
});

describe('records', () => {
  it('parses a git log with record separators, oldest first, without authors', () => {
    const log = '\x1eaaaaaaa\n\nsrc/a.ts\nsrc/b.ts\n\x1ebbbbbbb\n\nsrc/c.ts\n';
    expect(parseCommitPathLog(log)).toEqual([
      { sha: 'aaaaaaa', author: null, paths: ['src/a.ts', 'src/b.ts'] },
      { sha: 'bbbbbbb', author: null, paths: ['src/c.ts'] },
    ]);
  });

  it('keeps only well-formed sub-records when re-validating gate_health input', () => {
    expect(parseRatchetShadowHealth(null)).toBeUndefined();
    expect(parseRatchetShadowHealth({ composedProof: { schemaVersion: 2 } })).toBeUndefined();
    const ok = parseRatchetShadowHealth({
      newRedEjection: { schemaVersion: 1, candidate: 'C', status: 'planned', blameCheck: 'not-run' },
      composedProof: { schemaVersion: 1, candidate: 'C', repairHead: 'H', status: 'bogus' },
    });
    expect(ok?.newRedEjection?.candidate).toBe('C');
    expect(ok?.composedProof).toBeUndefined();
  });
});

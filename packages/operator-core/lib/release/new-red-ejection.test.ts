/**
 * R-6 (green-main-ratchet-convergence-2026-10-17 P-007, D-003): blame-checked new-red ejection.
 *
 * FAIL if any is observed: (1) a commit is ejected while the failing test also fails on the base
 * without it; (2) an attributable new failure freezes the candidate instead of ejecting; (3) the
 * ejected red is not routed to the commit author; (4) after ejection the affected radius is not
 * re-tested before promotion.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBlameCheck,
  attributeByRadius,
  decideAfterEjection,
  planEjection,
  runNewRedEjection,
  type CandidateCommit,
  type EjectionRoute,
  type NewRedEjectionDeps,
} from './new-red-ejection';

const A: CandidateCommit = { sha: 'a'.repeat(40), author: 'alice', paths: ['packages/x/lib/a.ts'] };
const B: CandidateCommit = { sha: 'b'.repeat(40), author: 'bob', paths: ['packages/y/lib/b.ts'] };
const C: CandidateCommit = { sha: 'c'.repeat(40), author: null, paths: ['packages/z/lib/c.ts'] };
const CANDIDATE = 'f'.repeat(40);

/** Radius by path prefix: a commit selects the tests under the same package. */
const RADIUS: Record<string, string[]> = {
  [A.sha]: ['packages/x/lib/a.test.ts', 'packages/x/lib/a2.test.ts'],
  [B.sha]: ['packages/y/lib/b.test.ts'],
  [C.sha]: ['packages/z/lib/c.test.ts'],
};
const selectsTest = (c: CandidateCommit, t: string) => (RADIUS[c.sha] ?? []).includes(t);
const radiusOf = (c: CandidateCommit) => RADIUS[c.sha] ?? [];

/** A fake gate: `verdicts[sha][test]`; a sha built by removing commits is `without:<sorted shas>`. */
function fakeDeps(verdicts: Record<string, Record<string, boolean | null>>, opts: { unbuildable?: string[] } = {}) {
  const calls = { built: [] as string[][], ran: [] as Array<{ sha: string; tests: string[] }>, routed: [] as Array<EjectionRoute & { candidate: string; ejectedCandidate: string }> };
  const deps: NewRedEjectionDeps = {
    async buildCandidateWithout(_candidate, commits) {
      calls.built.push([...commits]);
      if (commits.some((c) => opts.unbuildable?.includes(c))) return null;
      return `without:${[...commits].sort().join(',')}`;
    },
    async runTestsAt(sha, tests) {
      calls.ran.push({ sha, tests: [...tests] });
      const row = verdicts[sha] ?? {};
      return new Map(tests.map((t) => [t, t in row ? row[t] : true] as const));
    },
    async routeToAuthor(route) {
      calls.routed.push(route);
      return `WI-route-${route.commit.slice(0, 4)}`;
    },
    log() {},
  };
  return { deps, calls };
}

describe('attributeByRadius', () => {
  it('attributes a failure to the single commit whose radius selects it', () => {
    const out = attributeByRadius({ newFailures: ['packages/x/lib/a.test.ts'], commits: [A, B], selectsTest });
    expect(out).toEqual([{ test: 'packages/x/lib/a.test.ts', kind: 'attributed', commit: A.sha }]);
  });

  it('leaves a failure no commit selects unattributable (the never-ran door)', () => {
    const out = attributeByRadius({ newFailures: ['packages/q/lib/old.test.ts'], commits: [A, B], selectsTest });
    expect(out[0]).toMatchObject({ kind: 'unattributable', reason: 'no-commit-selects-test' });
  });

  it('leaves a failure two commits select unattributable', () => {
    const both = (c: CandidateCommit, t: string) => t === 'shared.test.ts' || selectsTest(c, t);
    const out = attributeByRadius({ newFailures: ['shared.test.ts'], commits: [A, B], selectsTest: both });
    expect(out[0]).toMatchObject({ kind: 'unattributable', reason: 'several-commits-select-test', commits: [A.sha, B.sha] });
  });

  it('fails closed when a radius cannot be computed', () => {
    const unknown = (c: CandidateCommit, t: string) => (c.sha === B.sha ? null : selectsTest(c, t));
    const out = attributeByRadius({ newFailures: ['packages/x/lib/a.test.ts'], commits: [A, B], selectsTest: unknown });
    expect(out[0]).toMatchObject({ kind: 'unattributable', reason: 'radius-unknown' });
  });
});

describe('applyBlameCheck (D-003)', () => {
  const attributed = [{ test: 'packages/x/lib/a.test.ts', kind: 'attributed' as const, commit: A.sha }];

  it('confirms the commit only when the test passes on the candidate without it', () => {
    const out = applyBlameCheck(attributed, new Map([[A.sha, new Map([['packages/x/lib/a.test.ts', true]])]]));
    expect(out[0]).toEqual(attributed[0]);
  });

  it('falsifier (1): a test that also fails without the commit does not confirm it', () => {
    const out = applyBlameCheck(attributed, new Map([[A.sha, new Map([['packages/x/lib/a.test.ts', false]])]]));
    expect(out[0]).toMatchObject({ kind: 'unattributable', reason: 'fails-without-commit', commits: [A.sha] });
  });

  it('an undetermined or unbuildable blame check confirms nothing', () => {
    expect(applyBlameCheck(attributed, new Map([[A.sha, new Map([['packages/x/lib/a.test.ts', null]])]]))[0]).toMatchObject({ reason: 'blame-check-undetermined' });
    expect(applyBlameCheck(attributed, new Map([[A.sha, null]]))[0]).toMatchObject({ reason: 'candidate-without-commit-unbuildable' });
    expect(applyBlameCheck(attributed, new Map())[0]).toMatchObject({ reason: 'candidate-without-commit-unbuildable' });
  });
});

describe('planEjection', () => {
  it('falsifier (2): an attributable failure ejects even when another failure is unattributable', () => {
    const plan = planEjection({
      confirmed: [
        { test: 'packages/x/lib/a.test.ts', kind: 'attributed', commit: A.sha },
        { test: 'packages/q/lib/old.test.ts', kind: 'unattributable', reason: 'no-commit-selects-test', commits: [] },
      ],
      commits: [A, B],
      radiusOf,
    });
    expect(plan.kind).toBe('eject');
    if (plan.kind !== 'eject') throw new Error('unreachable');
    expect(plan.ejected).toEqual([A.sha]);
    expect(plan.unattributable.map((u) => u.test)).toEqual(['packages/q/lib/old.test.ts']);
    // The re-test covers every new failure and the ejected commit's whole radius.
    expect(plan.retestRadius).toEqual(['packages/q/lib/old.test.ts', 'packages/x/lib/a.test.ts', 'packages/x/lib/a2.test.ts']);
  });

  it('only unattributable failures freeze the candidate', () => {
    const plan = planEjection({
      confirmed: [{ test: 't.test.ts', kind: 'unattributable', reason: 'fails-without-commit', commits: [A.sha] }],
      commits: [A],
      radiusOf,
    });
    expect(plan).toMatchObject({ kind: 'freeze' });
  });

  it('falsifier (3): each ejection is routed to its commit author, and an unknown author is reported', () => {
    const plan = planEjection({
      confirmed: [
        { test: 'packages/y/lib/b.test.ts', kind: 'attributed', commit: B.sha },
        { test: 'packages/z/lib/c.test.ts', kind: 'attributed', commit: C.sha },
      ],
      commits: [A, B, C],
      radiusOf,
    });
    if (plan.kind !== 'eject') throw new Error('expected eject');
    expect(plan.routes).toEqual([
      { commit: B.sha, author: 'bob', unattributedAuthor: false, tests: ['packages/y/lib/b.test.ts'] },
      { commit: C.sha, author: null, unattributedAuthor: true, tests: ['packages/z/lib/c.test.ts'] },
    ]);
  });

  it('a commit whose radius is unknown is not ejected; the others still are', () => {
    const plan = planEjection({
      confirmed: [
        { test: 'packages/x/lib/a.test.ts', kind: 'attributed', commit: A.sha },
        { test: 'packages/y/lib/b.test.ts', kind: 'attributed', commit: B.sha },
      ],
      commits: [A, B],
      radiusOf: (c) => (c.sha === B.sha ? null : radiusOf(c)),
    });
    if (plan.kind !== 'eject') throw new Error('expected eject');
    expect(plan.ejected).toEqual([A.sha]);
    expect(plan.unattributable).toEqual([{ test: 'packages/y/lib/b.test.ts', kind: 'unattributable', reason: 'radius-unknown', commits: [B.sha] }]);
  });
});

describe('decideAfterEjection', () => {
  const plan = {
    kind: 'eject' as const,
    ejected: [A.sha],
    routes: [],
    retestRadius: ['packages/x/lib/a.test.ts', 'packages/x/lib/a2.test.ts'],
    unattributable: [],
  };

  it('promotes only when every radius test was measured and none newly fails', () => {
    const ok = decideAfterEjection({ plan, retest: new Map([['packages/x/lib/a.test.ts', true], ['packages/x/lib/a2.test.ts', true]]), failingAtBase: new Set() });
    expect(ok.kind).toBe('promote');
  });

  it('falsifier (4): an unmeasured radius test never promotes', () => {
    const out = decideAfterEjection({ plan, retest: new Map([['packages/x/lib/a.test.ts', true]]), failingAtBase: new Set() });
    expect(out).toMatchObject({ kind: 'freeze', unmeasured: ['packages/x/lib/a2.test.ts'] });
  });

  it('a radius test still failing that was not failing at the previous promotion freezes', () => {
    const out = decideAfterEjection({ plan, retest: new Map([['packages/x/lib/a.test.ts', true], ['packages/x/lib/a2.test.ts', false]]), failingAtBase: new Set() });
    expect(out).toMatchObject({ kind: 'freeze', newFailures: ['packages/x/lib/a2.test.ts'] });
  });

  it('a failure already present at the previous promotion is carried, not new', () => {
    const out = decideAfterEjection({ plan, retest: new Map([['packages/x/lib/a.test.ts', true], ['packages/x/lib/a2.test.ts', false]]), failingAtBase: new Set(['packages/x/lib/a2.test.ts']) });
    expect(out.kind).toBe('promote');
  });
});

describe('runNewRedEjection — the S2 shape end to end', () => {
  const base = {
    candidate: CANDIDATE,
    failingAtBase: new Set<string>(),
    commits: [A, B],
    selectsTest,
    radiusOf,
  };

  it('S2: one commit breaks its test; it is ejected, the radius re-tested, the rest promotes, the author is routed', async () => {
    const { deps, calls } = fakeDeps({
      [`without:${A.sha}`]: { 'packages/x/lib/a.test.ts': true },
    });
    const report = await runNewRedEjection(deps, { ...base, newFailures: ['packages/x/lib/a.test.ts'] });
    expect(report).toMatchObject({ status: 'promotable', ejectedCandidate: `without:${A.sha}`, ejected: [A.sha], retested: 2 });
    // Blame check ran the failing test on the candidate without A before anything was ejected.
    expect(calls.ran[0]).toEqual({ sha: `without:${A.sha}`, tests: ['packages/x/lib/a.test.ts'] });
    // The affected radius was re-tested on the ejected candidate (falsifier 4).
    expect(calls.ran[1]).toEqual({ sha: `without:${A.sha}`, tests: ['packages/x/lib/a.test.ts', 'packages/x/lib/a2.test.ts'] });
    // Routed to the author (falsifier 3).
    expect(calls.routed).toHaveLength(1);
    expect(calls.routed[0]).toMatchObject({ commit: A.sha, author: 'alice', candidate: CANDIDATE, tests: ['packages/x/lib/a.test.ts'] });
  });

  it('control: an unattributable new failure freezes the original candidate and ejects nothing', async () => {
    const { deps, calls } = fakeDeps({});
    const report = await runNewRedEjection(deps, { ...base, newFailures: ['packages/q/lib/old.test.ts'] });
    expect(report).toMatchObject({ status: 'frozen', frozenSha: CANDIDATE });
    expect(calls.built).toEqual([]);
    expect(calls.routed).toEqual([]);
  });

  it('falsifier (1) end to end: the test also fails without the commit, so nothing is ejected', async () => {
    const { deps, calls } = fakeDeps({ [`without:${A.sha}`]: { 'packages/x/lib/a.test.ts': false } });
    const report = await runNewRedEjection(deps, { ...base, newFailures: ['packages/x/lib/a.test.ts'] });
    expect(report.status).toBe('frozen');
    if (report.status !== 'frozen') throw new Error('unreachable');
    expect(report.frozenSha).toBe(CANDIDATE);
    expect(report.unattributable[0]).toMatchObject({ reason: 'fails-without-commit' });
    expect(calls.routed).toEqual([]);
  });

  it('a red found by the radius re-test freezes the EJECTED candidate, and the author is still routed', async () => {
    const { deps, calls } = fakeDeps({
      [`without:${A.sha}`]: { 'packages/x/lib/a.test.ts': true, 'packages/x/lib/a2.test.ts': false },
    });
    const report = await runNewRedEjection(deps, { ...base, newFailures: ['packages/x/lib/a.test.ts'] });
    expect(report).toMatchObject({ status: 'frozen', frozenSha: `without:${A.sha}`, newFailures: ['packages/x/lib/a2.test.ts'] });
    expect(calls.routed.map((r) => r.commit)).toEqual([A.sha]);
  });

  it('a failure that was already red at the previous promotion is not new and triggers nothing', async () => {
    const { deps, calls } = fakeDeps({});
    const report = await runNewRedEjection(deps, { ...base, failingAtBase: new Set(['packages/x/lib/a.test.ts']), newFailures: ['packages/x/lib/a.test.ts'] });
    expect(report.status).toBe('nothing-new');
    expect(calls.built).toEqual([]);
  });

  it('an ejected candidate that cannot be built freezes the original', async () => {
    const { deps } = fakeDeps({ [`without:${A.sha}`]: { 'packages/x/lib/a.test.ts': true } }, { unbuildable: [] });
    // Blame build succeeds for A alone; the combined build (A + B) fails.
    let n = 0;
    const flaky: NewRedEjectionDeps = { ...deps, buildCandidateWithout: async (c, commits) => (++n > 2 ? null : deps.buildCandidateWithout(c, commits)) };
    const report = await runNewRedEjection(flaky, {
      ...base,
      newFailures: ['packages/x/lib/a.test.ts', 'packages/y/lib/b.test.ts'],
    });
    expect(report).toMatchObject({ status: 'frozen', frozenSha: CANDIDATE });
  });
});

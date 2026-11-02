import { describe, expect, it } from 'vitest';
import {
  createNonExecutableRefactorHunkClassifier,
  createRefactorFactsResolver,
  filedFindingFromPayload,
  filedGuardFindingFromPayload,
  findingReportedIn,
  guardFindingReportedInCensus,
  isCloneScannable,
  isCoverableSource,
  parseDiffHunks,
  parseRefactorFinding,
  type FiledRefactorFinding,
  type RefactorFactsIo,
} from './change-kind-refactor-facts';
import { refactorFactGaps, type RefactorRunRow } from './change-kind-refactor-proof';
import { CloneIndex } from './code-intelligence/clone-index';
import { cloneFamilyArea, rankCloneSweep } from './code-intelligence/clone-sweep';

const LANDING = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

/** Large enough to clear CLONE_MIN_MASS, so two copies form a ranked clone family. */
const cloneBody = (name: string) => `export function ${name}(items: number[], limit: number): { total: number; kept: number[] } {
  const kept: number[] = [];
  let total = 0;
  for (const item of items) {
    if (item < 0 || item > limit) continue;
    const scaled = item * 2 + (item % 3 === 0 ? 1 : 0);
    total += scaled;
    if (scaled > limit / 2) kept.push(scaled);
    else if (scaled === 0) kept.unshift(scaled);
  }
  return { total: Math.round(total * 100) / 100, kept: kept.slice(0, 10) };
}
`;

describe('parseDiffHunks', () => {
  it('retains both sides of single-line, multi-line and pure-deletion hunks, and omits deleted files', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -10,2 +10,3 @@ export function f() {',
      '@@ -40 +41 @@',
      '@@ -60,4 +61,0 @@',
      'diff --git a/src/gone.ts b/src/gone.ts',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      'diff --git a/src/new.ts b/src/new.ts',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,20 @@',
    ].join('\n');
    const hunks = parseDiffHunks(diff);
    expect([...hunks.keys()]).toEqual(['src/x.ts', 'src/new.ts']);
    expect(hunks.get('src/x.ts')).toEqual([
      { old: { start: 10, count: 2 }, new: { start: 10, count: 3 }, start: 10, end: 12 },
      { old: { start: 40, count: 1 }, new: { start: 41, count: 1 }, start: 41, end: 41 },
      { old: { start: 60, count: 4 }, new: { start: 61, count: 0 }, start: 61, end: 61 },
    ]);
    expect(hunks.get('src/new.ts')).toEqual([
      { old: { start: 0, count: 0 }, new: { start: 1, count: 20 }, start: 1, end: 20 },
    ]);
  });
});

describe('source-bound non-executable hunk proof', () => {
  const classify = (
    path: string,
    parentSource: string,
    landingSource: string,
    old: { start: number; count: number },
    next: { start: number; count: number },
  ) => createNonExecutableRefactorHunkClassifier({
    path, parentSource, landingSource, parentCommit: PARENT, landingCommit: LANDING,
  })?.({
    old,
    new: next,
    start: Math.max(1, next.start),
    end: next.count === 0 ? Math.max(1, next.start) : next.start + next.count - 1,
  }) ?? null;

  it('proves a comment replacement and erased interface/type annotation changes', () => {
    const comment = classify(
      'src/x.ts',
      'export const value = 1;\n// old note\n',
      'export const value = 1;\n// new note\n',
      { start: 2, count: 1 },
      { start: 2, count: 1 },
    );
    expect(comment).toMatchObject({ classification: 'comment', parentCommit: PARENT, landingCommit: LANDING });

    const annotation = classify(
      'src/x.ts',
      'export const value: string | undefined = "ok";\n',
      'export const value: string = "ok";\n',
      { start: 1, count: 1 },
      { start: 1, count: 1 },
    );
    expect(annotation).toMatchObject({ classification: 'erased-type' });

    const interfaceAddition = classify(
      'src/x.ts',
      'export const value = 1;\n',
      'interface Metadata { value: string; }\nexport const value = 1;\n',
      { start: 0, count: 0 },
      { start: 1, count: 1 },
    );
    expect(interfaceAddition).toMatchObject({ classification: 'erased-type' });
  });

  it('refuses executable edits, executable deletions, imports, directives and parse ambiguity', () => {
    expect(classify('src/x.ts', 'export const value = 1;\n', 'export const value = 2;\n',
      { start: 1, count: 1 }, { start: 1, count: 1 })).toBeNull();
    expect(classify('src/x.ts', 'export const value = 1;\n', '',
      { start: 1, count: 1 }, { start: 0, count: 0 })).toBeNull();
    expect(classify('src/x.ts', 'import { type Alpha } from "./types";\n',
      'import { type Beta } from "./types";\n', { start: 1, count: 1 }, { start: 1, count: 1 })).toBeNull();
    expect(classify('src/x.ts', '// @ts-nocheck\nexport const value = 1;\n',
      '// @ts-check\nexport const value = 1;\n', { start: 1, count: 1 }, { start: 1, count: 1 })).toBeNull();
    expect(classify('src/x.ts', 'export const value: string = "ok";\n',
      'export const value: string = ;\n', { start: 1, count: 1 }, { start: 1, count: 1 })).toBeNull();
  });
});

describe('path filters', () => {
  it('treats code as coverable and tests or generated files as not', () => {
    expect(isCoverableSource('packages/a/lib/x.ts')).toBe(true);
    expect(isCoverableSource('scripts/y.mjs')).toBe(true);
    expect(isCoverableSource('packages/a/lib/x.test.ts')).toBe(false);
    expect(isCoverableSource('packages/a/lib/x.d.ts')).toBe(false);
    expect(isCoverableSource('docs/readme.md')).toBe(false);
  });
  it('scans only the TypeScript the clone sweep indexes', () => {
    expect(isCloneScannable('packages/a/lib/x.ts')).toBe(true);
    expect(isCloneScannable('packages/a/lib/x.tsx')).toBe(true);
    expect(isCloneScannable('scripts/y.mjs')).toBe(false);
    expect(isCloneScannable('packages/a/lib/__tests__/x.ts')).toBe(false);
    expect(isCloneScannable('apps/operator/app/x.ts')).toBe(false);
    expect(isCloneScannable('packages/a/lib/x.gen.ts')).toBe(false);
  });
});

describe('parseRefactorFinding', () => {
  it('accepts only the registered sync-batch guard namespace and safe subject paths', () => {
    const path = 'packages/operator-core/lib/release/orphan.ts';
    const conditionKey = `sync-delta-guard:lint:guard-reachability:${path}`;
    expect(parseRefactorFinding(conditionKey)).toEqual({ kind: 'guard-reachability', conditionKey, path });
    for (const key of ['sync-delta-guard:lint:other:src/x.ts', 'sync-delta-guard:lint:guard-reachability:*',
      'sync-delta-guard:lint:guard-reachability:packages/../secret.ts', 'sync-delta-guard:lint:guard-reachability:/tmp/x.ts']) {
      expect(parseRefactorFinding(key)).toBeNull();
    }
  });
  it('reads area keys, family keys and bare family ids', () => {
    expect(parseRefactorFinding('clone-area:packages/operator-core/lib')).toEqual({ kind: 'area', area: 'packages/operator-core/lib' });
    expect(parseRefactorFinding('clone-family:ts-5:v1:floor-80:renamed:abc123')).toEqual({
      kind: 'family',
      familyId: 'ts-5:v1:floor-80:renamed:abc123',
      fingerprint: 'abc123',
    });
    expect(parseRefactorFinding('ts-5:v1:floor-80:renamed:abc123')).toMatchObject({ fingerprint: 'abc123' });
  });
  it('marks a semantic family as not structurally re-scannable', () => {
    expect(parseRefactorFinding('semantic-code-v1:semantic:ff00')).toEqual({
      kind: 'family',
      familyId: 'semantic-code-v1:semantic:ff00',
      fingerprint: null,
    });
  });
  it('rejects anything that is not a clone finding key', () => {
    expect(parseRefactorFinding('EI-123')).toBeNull();
    expect(parseRefactorFinding('clone-area:')).toBeNull();
    expect(parseRefactorFinding('v1:renamed:')).toBeNull();
  });
});

describe('registered guard finding and census', () => {
  const path = 'packages/operator-core/lib/release/orphan.ts';
  const conditionKey = `sync-delta-guard:lint:guard-reachability:${path}`;
  const finding = { kind: 'guard-reachability' as const, conditionKey, path };
  const payload = { filedBy: 'system:sync-batch-lint-guards', paths: [path], _conditionUpsert: { conditionKey } };
  const census = (dead: boolean) => ({ modules: { measurable: true, population: 1, inventory: [{ module: path, dead }] } });

  it('requires the actual system filed identity, reporter and subject', () => {
    expect(filedGuardFindingFromPayload(payload, finding)?.guard).toEqual({ conditionKey, path });
    for (const malformed of [null, {}, { ...payload, filedBy: 'agent' }, { ...payload, paths: [] },
      { ...payload, _conditionUpsert: { conditionKey: 'other' } }]) {
      expect(filedGuardFindingFromPayload(malformed, finding)).toBeNull();
    }
  });

  it('distinguishes an orphan from a wired subject and a verified deletion', () => {
    expect(guardFindingReportedInCensus(census(true), path, 'export const orphan = 1;')).toBe(true);
    expect(guardFindingReportedInCensus(census(false), path, 'export const wired = 1;')).toBe(false);
    const deleted = { modules: { measurable: true, population: 1, inventory: [{ module: 'packages/a/lib/release/other.ts', dead: false }] } };
    expect(guardFindingReportedInCensus(deleted, path, null)).toBe(false);
    expect(() => guardFindingReportedInCensus(deleted, path, 'present')).toThrow('missing from the detector population');
    expect(() => guardFindingReportedInCensus(census(true), path, null)).toThrow('source changed');
  });

  it('refuses degraded, partial, malformed and duplicate populations', () => {
    for (const bad of [null, {}, { modules: { measurable: false, inventory: [] } },
      { modules: { measurable: true, population: 0, inventory: [] } },
      { modules: { measurable: true, population: 2, inventory: [{ module: path, dead: false }] } },
      { modules: { measurable: true, population: 1, inventory: [{ module: path }] } },
      { modules: { measurable: true, population: 2, inventory: [{ module: path, dead: false }, { module: path, dead: false }] } }]) {
      expect(() => guardFindingReportedInCensus(bad, path, 'present')).toThrow();
    }
  });
});

describe('filedFindingFromPayload', () => {
  const payload = {
    area: 'packages/a',
    families: [
      { id: 'v:renamed:fp1', members: [{ path: 'packages/a/x.ts' }, { path: 'packages/a/y.ts' }] },
      { id: 'v:renamed:fp2', members: [{ path: 'packages/a/z.ts' }] },
    ],
  };
  it('collects every member and fingerprint for an area finding', () => {
    expect(filedFindingFromPayload(payload, { kind: 'area', area: 'packages/a' })).toEqual({
      memberPaths: ['packages/a/x.ts', 'packages/a/y.ts', 'packages/a/z.ts'],
      fingerprints: ['fp1', 'fp2'],
      semanticFamilyIds: [],
    });
  });
  it('keeps only the named family for a family finding', () => {
    expect(filedFindingFromPayload(payload, { kind: 'family', familyId: 'v:renamed:fp2', fingerprint: 'fp2' })).toEqual({
      memberPaths: ['packages/a/z.ts'],
      fingerprints: ['fp2'],
      semanticFamilyIds: [],
    });
  });
  it('flags semantic families and returns null when nothing matches', () => {
    const mixed = { families: [...payload.families, { id: 'semantic-code-v1:semantic:s1', members: [] }] };
    expect(filedFindingFromPayload(mixed, { kind: 'area', area: 'packages/a' })?.semanticFamilyIds).toEqual([
      'semantic-code-v1:semantic:s1',
    ]);
    expect(filedFindingFromPayload(payload, { kind: 'family', familyId: 'v:renamed:other', fingerprint: 'other' })).toBeNull();
    expect(filedFindingFromPayload(null, { kind: 'area', area: 'x' })).toBeNull();
  });
});

describe('findingReportedIn', () => {
  const duplicated = () => {
    const index = new CloneIndex();
    index.update({ path: 'packages/a/lib/one.ts', source: cloneBody('first') });
    index.update({ path: 'packages/a/lib/two.ts', source: cloneBody('second') });
    return index;
  };

  it('reports a family whose filed fingerprint is still ranked, and stops once a copy is gone', () => {
    const [family] = rankCloneSweep(duplicated(), { acceptances: [], genericEvidence: [] });
    expect(family).toBeDefined();
    const fp = family!.family.fingerprint;
    const finding = { kind: 'family' as const, familyId: family!.family.id, fingerprint: fp };
    expect(findingReportedIn(duplicated(), finding, [fp])).toBe(true);

    const fixed = new CloneIndex();
    fixed.update({ path: 'packages/a/lib/one.ts', source: cloneBody('first') });
    fixed.update({ path: 'packages/a/lib/two.ts', source: 'export const second = (items: number[]) => items.length;\n' });
    expect(findingReportedIn(fixed, finding, [fp])).toBe(false);
  });

  it('reports an area while any ranked family still lands in it', () => {
    const [family] = rankCloneSweep(duplicated(), { acceptances: [], genericEvidence: [] });
    const area = cloneFamilyArea(family!.family.members);
    expect(findingReportedIn(duplicated(), { kind: 'area', area }, [])).toBe(true);
    expect(findingReportedIn(duplicated(), { kind: 'area', area: 'packages/elsewhere' }, [])).toBe(false);
  });
});

describe('createRefactorFactsResolver', () => {
  const run = (id: number, commitSha: string, overrides: Partial<RefactorRunRow> = {}): RefactorRunRow => ({
    id,
    filePath: 'src/x.test.ts',
    commitSha,
    status: 'pass',
    worktreeDirty: false,
    ...overrides,
  });
  const DIFF = ['diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -10,2 +10,3 @@'].join('\n');

  function fakeIo(overrides: Partial<RefactorFactsIo> = {}, gitOverrides: Record<string, string | Error> = {}) {
    const calls: { coverage?: { paths: string[]; stale: string[] } } = {};
    const git: Record<string, string | Error> = {
      [`rev-parse --verify --quiet LAND^{commit}`]: `${LANDING}\n`,
      [`rev-parse --verify --quiet ${LANDING}^1^{commit}`]: `${PARENT}\n`,
      [`-c core.quotePath=false diff --name-only --no-renames ${PARENT} ${LANDING}`]: 'src/x.ts\n',
      [`-c core.quotePath=false diff -U0 --no-renames --no-color ${PARENT} ${LANDING}`]: DIFF,
      [`-c core.quotePath=false diff --name-only ${LANDING} -- src/x.ts`]: '',
      ...gitOverrides,
    };
    const filed: FiledRefactorFinding = { memberPaths: ['src/x.ts', 'src/y.ts'], fingerprints: ['fp-gone'], semanticFamilyIds: [] };
    const io: RefactorFactsIo = {
      async git(args) {
        const out = git[args.join(' ')];
        if (out === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
        if (out instanceof Error) throw out;
        return out;
      },
      async readRuns(ids) {
        return ids.map((id) => (id < 100 ? run(id, PARENT) : run(id, LANDING)));
      },
      async coverage(hunks, stale) {
        calls.coverage = { paths: [...hunks.keys()], stale: [...stale] };
        return { members: [{ member: 'src/x.ts:10-12', coveringFiles: ['src/x.test.ts'] }], errors: [] };
      },
      async readFiled() {
        return filed;
      },
      async readSource(path) {
        return path === 'src/y.ts' ? null : 'export const x = 1;\n';
      },
      ...overrides,
    };
    return { io, calls };
  }
  const query = { landingCommit: 'LAND', beforeRunIds: [1], afterRunIds: [101], finding: 'clone-area:src' };
  const evidence = {
    landingCommit: 'LAND',
    beforeRuns: [1],
    afterRuns: [101],
    finding: 'clone-area:src',
    typecheck: 'LINT_TSC_RESULT status=clean',
    behaviouralStrands: 'exit 0, no strands',
  };

  it('resolves every fact for a sound refactor, and the rules accept it', async () => {
    const { io, calls } = fakeIo();
    const facts = await createRefactorFactsResolver(io)(query);
    expect(facts).toMatchObject({
      landingCommit: LANDING,
      landingParent: PARENT,
      changedFiles: ['src/x.ts'],
      touchedMembers: [{ member: 'src/x.ts:10-12', coveringFiles: ['src/x.test.ts'] }],
      findingStillReported: false,
      errors: [],
    });
    expect(calls.coverage).toEqual({ paths: ['src/x.ts'], stale: [] });
    expect(refactorFactGaps(evidence, facts)).toEqual([]);
  });

  it('leaves the landing commit unresolved instead of throwing', async () => {
    const { io } = fakeIo({}, { [`rev-parse --verify --quiet LAND^{commit}`]: new Error('exit 1') });
    const facts = await createRefactorFactsResolver(io)(query);
    expect(facts).toMatchObject({ landingCommit: null, landingParent: null, changedFiles: null, touchedMembers: null, findingStillReported: null });
    expect(refactorFactGaps(evidence, facts)).toContain("the landing commit 'LAND' does not resolve in the repository");
  });

  it('passes files changed after the landing to the coverage reader as stale', async () => {
    const { io, calls } = fakeIo({}, { [`-c core.quotePath=false diff --name-only ${LANDING} -- src/x.ts`]: 'src/x.ts\n' });
    await createRefactorFactsResolver(io)(query);
    expect(calls.coverage?.stale).toEqual(['src/x.ts']);
  });

  it('reports an empty member list when the landing change touched no code', async () => {
    const { io, calls } = fakeIo(
      {},
      {
        [`-c core.quotePath=false diff --name-only --no-renames ${PARENT} ${LANDING}`]: 'docs/a.md\n',
        [`-c core.quotePath=false diff -U0 --no-renames --no-color ${PARENT} ${LANDING}`]:
          'diff --git a/docs/a.md b/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@',
      },
    );
    const facts = await createRefactorFactsResolver(io)(query);
    expect(facts.touchedMembers).toEqual([]);
    expect(calls.coverage).toBeUndefined();
    expect(refactorFactGaps(evidence, facts).some((g) => g.includes('touched no source member'))).toBe(true);
  });

  it('turns a coverage failure into a null fact and an error', async () => {
    const { io } = fakeIo({ coverage: async () => Promise.reject(new Error('db down')) });
    const facts = await createRefactorFactsResolver(io)(query);
    expect(facts.touchedMembers).toBeNull();
    expect(facts.errors).toEqual(['reading the coverage map: db down']);
  });

  it('cannot re-scan a finding no cleanup item names', async () => {
    const { io } = fakeIo({ readFiled: async () => null });
    const facts = await createRefactorFactsResolver(io)(query);
    expect(facts.findingStillReported).toBeNull();
    expect(facts.errors?.[0]).toMatch(/no filed cleanup item names the finding 'clone-area:src'/);
  });

  it('cannot re-scan a semantic family', async () => {
    const { io } = fakeIo({
      readFiled: async () => ({ memberPaths: ['src/x.ts'], fingerprints: [], semanticFamilyIds: ['semantic-code-v1:semantic:s1'] }),
    });
    const facts = await createRefactorFactsResolver(io)(query);
    expect(facts.findingStillReported).toBeNull();
    expect(facts.errors?.[0]).toMatch(/semantic clone family \(semantic-code-v1:semantic:s1\)/);
  });

  it('rejects a finding that is not a clone key', async () => {
    const { io } = fakeIo();
    const facts = await createRefactorFactsResolver(io)({ ...query, finding: 'EI-1' });
    expect(facts.findingStillReported).toBeNull();
    expect(facts.errors).toEqual(["the finding 'EI-1' is not a registered clone or guard-reachability key"]);
  });

  it('still reports a finding whose copies remain in the current tree', async () => {
    const { io } = fakeIo({
      readFiled: async () => ({ memberPaths: ['src/a/one.ts', 'src/a/two.ts'], fingerprints: [], semanticFamilyIds: [] }),
      readSource: async (path) => (path === 'src/a/one.ts' ? cloneBody('first') : path === 'src/a/two.ts' ? cloneBody('second') : null),
    });
    const facts = await createRefactorFactsResolver(io)({ ...query, finding: 'clone-area:src/a' });
    expect(facts.findingStillReported).toBe(true);
    expect(refactorFactGaps({ ...evidence, finding: 'clone-area:src/a' }, facts)).toContain(
      "the targeted finding 'clone-area:src/a' is still reported after the change",
    );
  });

  it('dispatches the registered guard adapter while keeping the same coverage and run facts', async () => {
    const path = 'packages/operator-core/lib/release/orphan.ts';
    const conditionKey = `sync-delta-guard:lint:guard-reachability:${path}`;
    const { io } = fakeIo({
      readFiled: async (f) => filedGuardFindingFromPayload({ filedBy: 'system:sync-batch-lint-guards', paths: [path], _conditionUpsert: { conditionKey } }, f),
      readSource: async () => null,
      guardReachabilityCensus: async () => ({ modules: { measurable: true, population: 1, inventory: [{ module: 'packages/a/lib/release/kept.ts', dead: false }] } }),
    });
    const facts = await createRefactorFactsResolver(io)({ ...query, finding: conditionKey });
    expect(facts.findingStillReported).toBe(false);
    expect(refactorFactGaps({ ...evidence, finding: conditionKey }, facts)).toEqual([]);

    for (const overrides of [
      { guardReachabilityCensus: undefined },
      { guardReachabilityCensus: async () => { throw new Error('detector failed'); } },
      { readSource: async () => { throw new Error('EACCES'); } },
      { readFiled: async () => ({ memberPaths: [path], fingerprints: [], semanticFamilyIds: [] }) },
    ]) {
      const refused = await createRefactorFactsResolver({ ...io, ...overrides })({ ...query, finding: conditionKey });
      expect(refused.findingStillReported).toBeNull();
      expect(refused.errors?.length).toBeGreaterThan(0);
    }
    let reads = 0;
    const drifted = await createRefactorFactsResolver({ ...io, readSource: async () => ++reads === 1 ? null : 'changed' })({ ...query, finding: conditionKey });
    expect(drifted.findingStillReported).toBeNull();
    expect(drifted.errors?.join(' ')).toContain('changed during');
  });
});

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  DEFERRED_SPEND_EVIDENCE_VERSION,
  deferredSpendEvidenceIdentitySchema,
  deferredSpendEvidenceSliceSchema,
  deferredSpendFingerprint,
  evaluateDeferredSpendEvidence,
  readDeferredSpendEvidence,
  type DeferredSpendReadOnlyDependencies,
  type DeferredSpendReadOnlySnapshot,
} from './deferred-spend-acceptance-contract';

type IdentityInput = z.input<typeof deferredSpendEvidenceIdentitySchema>;
type SliceInput = z.input<typeof deferredSpendEvidenceSliceSchema>;
const digest = (character: string) => character.repeat(64);
const provenance = () => ({
  method: 'independent-reviewed-repository-read',
  selector: 'git diff --name-status BASE CANDIDATE; configured production roots',
  evidenceRefs: ['review:independent-selector-receipt'],
});
const selector = (path: string) => ({ path, contentHash: digest('a'), provenance: provenance() });

function identity(): IdentityInput {
  const scope = {
    workspaceId: 'workspace-a', harness: 'papercusp', planSlug: 'deferred-spend',
    rubricRef: 'acceptance-deferred-spend', rubricRevision: 7, criteriaHash: digest('b'),
  };
  const base = 'a'.repeat(40);
  const candidate = 'b'.repeat(40);
  const entries: IdentityInput['censusSelectors']['changedPaths']['entries'] = [
    { status: 'deleted', old: { path: 'src/deleted.ts', contentHash: digest('c') } },
    { status: 'renamed', old: { path: 'src/old.ts', contentHash: digest('c') }, new: { path: 'src/new.ts', contentHash: digest('d') } },
    { status: 'added', new: { path: 'src/unimported.ts', contentHash: digest('e') } },
    { status: 'added', new: { path: 'alias-only/reader.ts', contentHash: digest('e') } },
    { status: 'added', new: { path: 'migrations/001.sql', contentHash: digest('e') } },
    { status: 'modified', old: { path: 'tsconfig.json', contentHash: digest('c') }, new: { path: 'tsconfig.json', contentHash: digest('d') } },
  ];
  return {
    schemaVersion: DEFERRED_SPEND_EVIDENCE_VERSION,
    scope,
    subject: { kind: 'source', ref: `tree:${candidate}` },
    observation: {
      id: 'observation-a', observedAt: '2026-10-25T20:00:02Z',
      window: { startAt: '2026-10-25T19:00:00Z', endAt: '2026-10-25T20:00:00Z' },
      serving: { hostId: 'source-runner-a', processId: 'pid:123', buildId: 'build-a', runtimeGeneration: 'generation-a' },
      snapshot: {
        id: 'snapshot-a', acquiredAt: '2026-10-25T20:00:01Z', scopeHash: deferredSpendFingerprint(scope),
        consistency: 'consistent-read-only', evidenceRefs: ['snapshot:consistent-read-a'],
      },
    },
    sourceManifestHash: digest('f'), configurationHash: digest('a'),
    censusSelectors: {
      base: { revision: base, treeHash: digest('a'), provenance: provenance() },
      candidate: { revision: candidate, treeHash: digest('b'), provenance: provenance() },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: digest('a'), provenance: provenance() },
      projectConfiguration: {
        contentHash: digest('a'), provenance: provenance(),
        tsconfigs: [selector('tsconfig.json')], projectReferences: [selector('packages/reader/tsconfig.json')],
      },
      migrationRegistry: {
        revision: candidate, contentHash: digest('a'), provenance: provenance(), entries: [selector('migrations/registry.json')],
      },
      productionRoots: [selector('src'), selector('alias-only'), selector('migrations')],
      changedPaths: {
        method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate,
        populationHash: deferredSpendFingerprint(entries), provenance: provenance(), entries,
      },
    },
  };
}

function slice(id = 'source-census'): SliceInput {
  return {
    id, verdict: 'pass', evidenceRefs: [`measurement:${id}`], violations: [],
    coverage: {
      state: 'complete', population: ['member-a', 'member-b'], checked: ['member-a', 'member-b'],
      notChecked: [], notApplicable: [], residue: [], gaps: [], snapshotRef: 'snapshot-a',
      pageRefs: ['page:a', 'page:b'], emptyPopulationEvidenceRefs: [],
    },
  };
}

function evaluate(part = slice(), actual = identity(), requiredSlices = ['source-census']) {
  return evaluateDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices }, { identity: actual, slices: [part] });
}

describe('DS-P006-EVIDENCE-IDENTITY', () => {
  it('passes a complete witnessed source observation and preserves non-imported/deleted/renamed/migration population', () => {
    const result = evaluate();
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toEqual([]);
    expect(result.identity?.censusSelectors.changedPaths.entries).toEqual(identity().censusSelectors.changedPaths.entries);
    expect(result.slices[0].coverage.checked).toEqual(['member-a', 'member-b']);
  });

  it('compares canonical object keys but retains population order identity', () => {
    expect(deferredSpendFingerprint({ b: 2, a: 1 })).toBe(deferredSpendFingerprint({ a: 1, b: 2 }));
    expect(deferredSpendFingerprint(['a', 'b'])).not.toBe(deferredSpendFingerprint(['b', 'a']));
  });

  const selectors: [string, (value: IdentityInput) => void][] = [
    ['base revision', (v) => { v.censusSelectors.base.revision = 'c'.repeat(40); v.censusSelectors.changedPaths.baseRevision = 'c'.repeat(40); }],
    ['candidate revision', (v) => { v.censusSelectors.candidate.revision = 'c'.repeat(40); v.censusSelectors.changedPaths.candidateRevision = 'c'.repeat(40); }],
    ['base content identity', (v) => { v.censusSelectors.base.treeHash = digest('c'); }],
    ['repository root', (v) => { v.censusSelectors.roots.repositoryRoot = '/another-repo'; }],
    ['workspace root', (v) => { v.censusSelectors.roots.workspaceRoot = '/another-workspace'; }],
    ['tsconfig selector', (v) => { v.censusSelectors.projectConfiguration.tsconfigs[0].path = 'other/tsconfig.json'; }],
    ['tsconfig bytes', (v) => { v.censusSelectors.projectConfiguration.tsconfigs[0].contentHash = digest('c'); }],
    ['project reference', (v) => { v.censusSelectors.projectConfiguration.projectReferences = []; }],
    ['active migration registry', (v) => { v.censusSelectors.migrationRegistry.revision = 'c'.repeat(40); }],
    ['migration registry entry', (v) => { v.censusSelectors.migrationRegistry.entries = []; }],
    ['production-root selector', (v) => { v.censusSelectors.productionRoots.pop(); }],
    ['reviewed changed-path population', (v) => {
      v.censusSelectors.changedPaths.entries.shift();
      v.censusSelectors.changedPaths.populationHash = deferredSpendFingerprint(v.censusSelectors.changedPaths.entries);
    }],
    ['selector derivation', (v) => { v.censusSelectors.changedPaths.provenance.selector = 'different independent base-to-candidate population'; }],
  ];
  it.each(selectors)('distinguishes the same manifest hash with different %s (D018)', (_name, change) => {
    const actual = identity();
    change(actual);
    expect(actual.sourceManifestHash).toBe(identity().sourceManifestHash);
    // Both identities are structurally valid: mismatch is not merely a parse failure.
    expect(deferredSpendEvidenceIdentitySchema.safeParse(actual).success).toBe(true);
    expect(evaluate(slice(), actual).verdict).toBe('unknown');
  });

  it.each(['base', 'candidate', 'roots', 'projectConfiguration', 'migrationRegistry', 'productionRoots', 'changedPaths'])
    ('cannot substitute a manifest hash for missing %s selectors', (key) => {
      const actual = identity();
      delete (actual.censusSelectors as unknown as Record<string, unknown>)[key];
      expect(evaluate(slice(), actual).verdict).toBe('unknown');
    });

  it.each([
    ['subject', (v: IdentityInput) => { v.subject.ref = 'other-subject'; }],
    ['interval', (v: IdentityInput) => { v.observation.window.startAt = '2026-10-25T18:00:00Z'; }],
    ['loaded build', (v: IdentityInput) => { v.observation.serving.buildId = 'other-build'; }],
    ['runtime generation', (v: IdentityInput) => { v.observation.serving.runtimeGeneration = 'other-generation'; }],
    ['rubric revision', (v: IdentityInput) => { v.scope.rubricRevision++; v.observation.snapshot.scopeHash = deferredSpendFingerprint(v.scope); }],
    ['criteria hash', (v: IdentityInput) => { v.scope.criteriaHash = digest('c'); v.observation.snapshot.scopeHash = deferredSpendFingerprint(v.scope); }],
  ] as const)('rejects a different %s', (_name, change) => {
    const actual = identity(); change(actual);
    expect(evaluate(slice(), actual).verdict).toBe('unknown');
  });

  it('keeps live and source evidence distinct even with otherwise identical identities', () => {
    const live = identity(); live.subject.kind = 'live';
    expect(evaluate(slice(), live).verdict).toBe('unknown');
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: live, requiredSlices: ['source-census'] }, { identity: live, slices: [slice()] }).verdict).toBe('pass');
  });

  it.each([
    ['population hash', (v: IdentityInput) => { v.censusSelectors.changedPaths.populationHash = digest('c'); }],
    ['base/population revision', (v: IdentityInput) => { v.censusSelectors.changedPaths.baseRevision = 'c'.repeat(40); }],
    ['short revision', (v: IdentityInput) => { v.censusSelectors.base.revision = 'abc123'; }],
    ['derivation evidence', (v: IdentityInput) => { v.censusSelectors.changedPaths.provenance.evidenceRefs = []; }],
    ['duplicate selector', (v: IdentityInput) => { v.censusSelectors.productionRoots.push(v.censusSelectors.productionRoots[0]); }],
    ['duplicate changed path', (v: IdentityInput) => {
      v.censusSelectors.changedPaths.entries.push(v.censusSelectors.changedPaths.entries[0]);
      v.censusSelectors.changedPaths.populationHash = deferredSpendFingerprint(v.censusSelectors.changedPaths.entries);
    }],
    ['snapshot scope', (v: IdentityInput) => { v.observation.snapshot.scopeHash = digest('c'); }],
    ['future interval', (v: IdentityInput) => { v.observation.window.endAt = '2026-10-26T20:00:00Z'; }],
    ['reversed interval', (v: IdentityInput) => { v.observation.window.startAt = '2026-10-25T20:00:00Z'; }],
  ] as const)('rejects inconsistent %s even when repeated in the expected identity', (_name, change) => {
    const actual = identity(); change(actual);
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: actual, requiredSlices: ['source-census'] }, { identity: actual, slices: [slice()] }).verdict).toBe('unknown');
  });

  it('returns deeply immutable detached evidence without freezing the caller input', () => {
    const actual = identity(); const part = slice(); const result = evaluate(part, actual);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity?.censusSelectors.changedPaths.entries[0])).toBe(true);
    expect(Object.isFrozen(result.slices[0].coverage.checked)).toBe(true);
    expect(Reflect.set(result.slices[0].coverage.checked, '0', 'rewritten')).toBe(false);
    actual.censusSelectors.base.provenance.evidenceRefs.push('later');
    part.coverage.checked.pop();
    expect(result.identity?.censusSelectors.base.provenance.evidenceRefs).toEqual(['review:independent-selector-receipt']);
    expect(result.slices[0].coverage.checked).toHaveLength(2);
  });
});

describe('DS-P006-UNKNOWN-ON-GAPS', () => {
  it.each([
    ['duplicate population', (v: SliceInput) => { v.coverage.population.push('member-a'); }],
    ['duplicate checked member', (v: SliceInput) => { v.coverage.checked.push('member-a'); }],
    ['overlapping partition', (v: SliceInput) => { v.coverage.notChecked.push('member-a'); }],
    ['omitted member', (v: SliceInput) => { v.coverage.checked.pop(); }],
    ['foreign member', (v: SliceInput) => { v.coverage.checked[0] = 'foreign'; }],
    ['unchecked member', (v: SliceInput) => { v.coverage.checked.pop(); v.coverage.notChecked.push('member-b'); }],
    ['gap', (v: SliceInput) => { v.coverage.gaps.push('page-b unreadable'); }],
    ['residue', (v: SliceInput) => { v.coverage.residue.push('unresolved page-b'); }],
    ['different snapshot', (v: SliceInput) => { v.coverage.snapshotRef = 'snapshot-b'; }],
    ['unwitnessed pages', (v: SliceInput) => { v.coverage.pageRefs = []; }],
    ['unwitnessed measurement', (v: SliceInput) => { v.evidenceRefs = []; }],
    ['partial coverage', (v: SliceInput) => { v.coverage.state = 'partial'; }],
    ['unreadable coverage', (v: SliceInput) => { v.coverage.state = 'unreadable'; }],
  ] as const)('returns unknown for %s instead of a pass', (_name, change) => {
    const part = slice(); change(part);
    const result = evaluate(part);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('accepts an exhaustive applicability partition with independent exclusion evidence', () => {
    const part = slice(); part.coverage.checked.pop();
    part.coverage.notApplicable = [{ member: 'member-b', reason: 'outside the criterion scope', evidenceRefs: ['applicability:b'] }];
    expect(evaluate(part).verdict).toBe('pass');
    part.coverage.notApplicable[0].evidenceRefs = [];
    expect(evaluate(part).verdict).toBe('unknown');
  });

  it('requires explicit census proof for zero, never inventing a zero population', () => {
    const part = slice(); part.coverage.population = []; part.coverage.checked = [];
    expect(evaluate(part).verdict).toBe('unknown');
    part.coverage.emptyPopulationEvidenceRefs = ['query:complete-empty-population'];
    expect(evaluate(part).verdict).toBe('pass');
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices: ['source-census'] }, {}).verdict).toBe('unknown');
  });

  it('requires at least one uniquely selected required slice and exactly one copy of each', () => {
    const expectedIdentity = identity();
    for (const requiredSlices of [[], ['source-census', 'source-census'], ['missing']]) {
      expect(evaluateDeferredSpendEvidence({ expectedIdentity, requiredSlices }, { identity: expectedIdentity, slices: [slice()] }).verdict).toBe('unknown');
    }
    expect(evaluateDeferredSpendEvidence({ expectedIdentity, requiredSlices: ['source-census'] }, { identity: expectedIdentity, slices: [slice(), slice()] }).verdict).toBe('unknown');
  });

  it('preserves a checked violation while another required slice is missing or unreadable', () => {
    const failed = slice(); failed.verdict = 'fail';
    failed.violations = [{ member: 'member-a', reason: 'a forbidden mutation was measured', evidenceRefs: ['measurement:mutation-a'] }];
    failed.coverage.state = 'partial'; failed.coverage.checked.pop(); failed.coverage.notChecked.push('member-b');
    const result = evaluate(failed, identity(), ['source-census', 'routines']);
    expect(result.verdict).toBe('fail');
    expect(result.reasons).toContain('source-census: a forbidden mutation was measured');
    expect(result.reasons).toContain('routines: required slice missing or duplicated');
  });

  it('never treats an unmeasured failure or wrong-identity violation as proof', () => {
    const failed = slice(); failed.verdict = 'fail';
    expect(evaluate(failed).verdict).toBe('unknown');
    failed.violations = [{ member: 'unseen', reason: 'assertion without measurement', evidenceRefs: ['assertion:a'] }];
    expect(evaluate(failed).verdict).toBe('unknown');
    failed.violations[0].member = 'member-a';
    const actual = identity(); actual.observation.serving.buildId = 'unrelated-build';
    expect(evaluate(failed, actual).verdict).toBe('unknown');
  });

  it('requires an explicit reason for unknown', () => {
    const part = slice(); part.verdict = 'unknown'; part.reason = 'measurement incomplete';
    expect(evaluate(part).reasons).toContain('source-census: measurement incomplete');
    delete part.reason;
    expect(evaluate(part).verdict).toBe('unknown');
    expect(evaluate(part).reasons.join(' ')).toContain('explicit unknown reason');
  });
});

describe('read-only injected snapshot', () => {
  it('exposes only snapshot acquisition and bounded reads at the type boundary', () => {
    expectTypeOf<keyof DeferredSpendReadOnlyDependencies>().toEqualTypeOf<'withSnapshot'>();
    expectTypeOf<keyof DeferredSpendReadOnlySnapshot>().toEqualTypeOf<'identity' | 'readSlice'>();
  });

  it('acquires one scoped snapshot before reads and freezes the identity supplied to the adapter', async () => {
    const events: string[] = [];
    const dependencies: DeferredSpendReadOnlyDependencies = {
      withSnapshot: async (wanted, read) => {
        expect(Object.isFrozen(wanted.censusSelectors.projectConfiguration.tsconfigs)).toBe(true);
        events.push('begin');
        const result = await read({ identity: identity(), readSlice: async (id) => {
          events.push(`read:${id}`); return slice(id);
        } });
        events.push('end'); return result;
      },
    };
    const result = await readDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices: ['source-census', 'routines'] }, dependencies);
    expect(result.verdict).toBe('pass');
    expect(events).toEqual(['begin', 'read:source-census', 'read:routines', 'end']);
  });

  it('refuses a mismatched snapshot before issuing any read', async () => {
    let reads = 0;
    const actual = identity(); actual.observation.snapshot.id = 'other-snapshot';
    const dependencies: DeferredSpendReadOnlyDependencies = {
      withSnapshot: async (_wanted, read) => read({ identity: actual, readSlice: async () => { reads++; return slice(); } }),
    };
    expect((await readDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices: ['source-census'] }, dependencies)).verdict).toBe('unknown');
    expect(reads).toBe(0);
  });

  it('keeps read failures unknown and preserves a different measured violation', async () => {
    const failed = slice(); failed.verdict = 'fail';
    failed.violations = [{ member: 'member-a', reason: 'measured violation', evidenceRefs: ['measurement:a'] }];
    const dependencies: DeferredSpendReadOnlyDependencies = {
      withSnapshot: async (_wanted, read) => read({ identity: identity(), readSlice: async (id) => {
        if (id === 'source-census') return failed;
        throw new Error('unreadable page');
      } }),
    };
    expect((await readDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices: ['routines'] }, dependencies)).verdict).toBe('unknown');
    expect((await readDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices: ['source-census', 'routines'] }, dependencies)).verdict).toBe('fail');
  });

  it('fails closed when acquiring a consistent snapshot fails', async () => {
    const dependencies: DeferredSpendReadOnlyDependencies = { withSnapshot: async () => { throw new Error('snapshot unavailable'); } };
    const result = await readDeferredSpendEvidence({ expectedIdentity: identity(), requiredSlices: ['source-census'] }, dependencies);
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toEqual(['consistent read-only snapshot could not be read']);
  });
});

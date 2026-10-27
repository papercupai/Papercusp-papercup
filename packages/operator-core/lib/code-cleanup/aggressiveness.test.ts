import { describe, expect, it } from 'vitest';
import {
  aggressivenessCandidatesFromTriage, resolveCleanupAggressiveness, selectBatchesForAggressiveness,
  type AggressivenessCandidate, type AggressivenessUnit,
} from './aggressiveness';
import { DEFAULT_CLEANUP_AGGRESSIVENESS, type CleanupAggressiveness, type ExecutorMember } from './executor';
import { buildCampaignPlan } from './campaign-plan';
import type { TriageBatch } from './triage';

const member = (path: string, symbol: string, line = 1): ExecutorMember => ({ path, line, symbol });

/** Coverage keyed by `path#symbol`: a list = covering tests, `null` = the map cannot answer. */
function coverageOf(entries: Record<string, readonly string[] | null>) {
  return { coveringTests: (m: ExecutorMember) => {
    const key = `${m.path}#${m.symbol}`;
    return key in entries ? entries[key] : [];
  } };
}

const COVERED = ['lib/a.test.ts'];
const coverage = coverageOf({
  'lib/exact-1.ts#f': COVERED, 'lib/exact-2.ts#f': COVERED,
  'lib/renamed-1.ts#g': COVERED, 'lib/renamed-2.ts#h': COVERED,
  'lib/bare-1.ts#k': COVERED, 'lib/bare-2.ts#k': [],
  'lib/unknown-1.ts#u': COVERED, 'lib/unknown-2.ts#u': null,
  'lib/sem-1.ts#s': COVERED, 'lib/sem-2.ts#t': COVERED,
  'lib/near-1.ts#n': COVERED, 'lib/near-2.ts#n': COVERED,
  'lib/dead.ts#unused': COVERED,
  'lib/hot.ts#tangled': COVERED,
  'lib/anti.ts#pattern': COVERED,
  'lib/nokind-1.ts#q': COVERED, 'lib/nokind-2.ts#q': COVERED,
});

const exact: AggressivenessUnit = { id: 'fam-exact', findingClass: 'clone', cloneKind: 'exact',
  members: [member('lib/exact-1.ts', 'f'), member('lib/exact-2.ts', 'f')] };
const renamed: AggressivenessUnit = { id: 'fam-renamed', findingClass: 'clone', cloneKind: 'renamed',
  members: [member('lib/renamed-1.ts', 'g'), member('lib/renamed-2.ts', 'h')] };
/** One member has no covering test (`[]`). */
const exactUncovered: AggressivenessUnit = { id: 'fam-exact-uncovered', findingClass: 'clone', cloneKind: 'exact',
  members: [member('lib/bare-1.ts', 'k'), member('lib/bare-2.ts', 'k')] };
/** One member the map cannot answer for (`null`). */
const renamedUnknownCoverage: AggressivenessUnit = { id: 'fam-renamed-null-coverage', findingClass: 'clone', cloneKind: 'renamed',
  members: [member('lib/unknown-1.ts', 'u'), member('lib/unknown-2.ts', 'u')] };
const semantic: AggressivenessUnit = { id: 'fam-semantic', findingClass: 'clone', cloneKind: 'semantic',
  members: [member('lib/sem-1.ts', 's'), member('lib/sem-2.ts', 't')] };
const near: AggressivenessUnit = { id: 'fam-near', findingClass: 'clone', cloneKind: 'near',
  members: [member('lib/near-1.ts', 'n'), member('lib/near-2.ts', 'n')] };
const deadExport: AggressivenessUnit = { id: 'dead-unused', findingClass: 'dead-export', members: [member('lib/dead.ts', 'unused')] };
const hotspot: AggressivenessUnit = { id: 'hot-tangled', findingClass: 'complexity-hotspot', members: [member('lib/hot.ts', 'tangled')] };
const antiPattern: AggressivenessUnit = { id: 'anti-pattern', findingClass: 'anti-pattern', members: [member('lib/anti.ts', 'pattern')] };
const noKind: AggressivenessUnit = { id: 'fam-no-kind', findingClass: 'clone',
  members: [member('lib/nokind-1.ts', 'q'), member('lib/nokind-2.ts', 'q')] };

/** A mixed fixture: each batch isolates one dimension so a per-level answer names exactly what it admits. */
const candidates: AggressivenessCandidate[] = [
  { id: 'mechanical#0', units: [exact, renamed] },
  { id: 'uncovered#0', units: [exactUncovered, renamedUnknownCoverage] },
  { id: 'semantic#0', units: [semantic, near] },
  { id: 'findings#0', units: [deadExport, hotspot, antiPattern] },
  { id: 'mixed#0', units: [exact, semantic, exactUncovered] },
  { id: 'unknown#0', units: [noKind] },
];

const select = (level: CleanupAggressiveness) => selectBatchesForAggressiveness(level, candidates, coverage);
const proposedUnits = (level: CleanupAggressiveness) =>
  new Set(select(level).proposed.flatMap(b => b.units.map(u => `${b.candidateId}/${u.id}`)));

describe('resolveCleanupAggressiveness — a new campaign defaults to safe (R-12, D-007)', () => {
  it('returns safe when no level is given', () => {
    expect(DEFAULT_CLEANUP_AGGRESSIVENESS).toBe('safe');
    expect(resolveCleanupAggressiveness()).toBe('safe');
    expect(resolveCleanupAggressiveness(null)).toBe('safe');
    expect(resolveCleanupAggressiveness('')).toBe('safe');
  });

  it('keeps an explicit level and refuses an unknown one rather than running at another risk', () => {
    expect(resolveCleanupAggressiveness('standard')).toBe('standard');
    expect(resolveCleanupAggressiveness('thorough')).toBe('thorough');
    expect(() => resolveCleanupAggressiveness('thoruogh')).toThrow(/unknown cleanup aggressiveness 'thoruogh'/);
  });

  it('a campaign plan built without a level runs at safe', () => {
    const batch: TriageBatch = { area: 'packages/x', index: 0, score: 1, redundantMass: 4, families: [
      { id: 'fam-exact', score: 1, churn: 0, redundantMass: 4, packageDistance: 1, coChange: { minLinkScore: 1, files: 2, basis: 'file' },
        members: [{ path: 'lib/exact-1.ts', line: 1, symbol: 'f' }, { path: 'lib/exact-2.ts', line: 1, symbol: 'f' }] },
    ] };
    expect(buildCampaignPlan({ slug: 'cleanup-default-level', batches: [batch] }).settings.aggressiveness).toBe('safe');
    expect(buildCampaignPlan({ slug: 'cleanup-thorough', batches: [batch], aggressiveness: 'thorough' }).settings.aggressiveness)
      .toBe('thorough');
  });
});

describe('selectBatchesForAggressiveness — safe', () => {
  const result = select('safe');

  it('proposes only fully covered exact and renamed families', () => {
    expect(proposedUnits('safe')).toEqual(new Set(['mechanical#0/fam-exact', 'mechanical#0/fam-renamed', 'mixed#0/fam-exact']));
    expect(result.proposed.every(b => b.uncovered.length === 0)).toBe(true);
  });

  it('withholds a family with an uncovered member, including one the map cannot answer for', () => {
    expect(result.withheld.filter(w => w.reason === 'uncovered-under-safe').map(w => `${w.candidateId}/${w.unitId}`).sort())
      .toEqual(['mixed#0/fam-exact-uncovered', 'uncovered#0/fam-exact-uncovered', 'uncovered#0/fam-renamed-null-coverage']);
    expect(result.dropped).toContain('uncovered#0');
  });

  it('never proposes a semantic family, a near family or an R-13 finding', () => {
    const units = proposedUnits('safe');
    for (const id of ['fam-semantic', 'fam-near', 'dead-unused', 'hot-tangled', 'anti-pattern']) {
      expect([...units].some(u => u.endsWith(`/${id}`))).toBe(false);
    }
    expect(result.dropped).toEqual(expect.arrayContaining(['semantic#0', 'findings#0', 'unknown#0']));
  });
});

describe('selectBatchesForAggressiveness — standard', () => {
  const result = select('standard');

  it('also admits families with uncovered members, reporting them for characterization-first (R-6)', () => {
    expect(proposedUnits('standard')).toEqual(new Set([
      'mechanical#0/fam-exact', 'mechanical#0/fam-renamed',
      'uncovered#0/fam-exact-uncovered', 'uncovered#0/fam-renamed-null-coverage',
      'mixed#0/fam-exact', 'mixed#0/fam-exact-uncovered',
    ]));
    const uncoveredBatch = result.proposed.find(b => b.candidateId === 'uncovered#0');
    expect(uncoveredBatch?.uncovered.map(m => m.path).sort()).toEqual(['lib/bare-2.ts', 'lib/unknown-2.ts']);
    expect(result.proposed.find(b => b.candidateId === 'mechanical#0')?.uncovered).toEqual([]);
  });

  it('still withholds semantic and near families and every R-13 finding class', () => {
    expect(result.withheld.filter(w => w.reason === 'kind-not-admitted').map(w => w.unitId).sort())
      .toEqual(['fam-near', 'fam-semantic', 'fam-semantic']);
    expect(result.withheld.filter(w => w.reason === 'class-not-admitted').map(w => w.unitId).sort())
      .toEqual(['anti-pattern', 'dead-unused', 'hot-tangled']);
    expect(result.dropped.sort()).toEqual(['findings#0', 'semantic#0', 'unknown#0']);
  });
});

describe('selectBatchesForAggressiveness — thorough', () => {
  const result = select('thorough');

  it('also admits semantic families and the R-13 finding classes', () => {
    const units = proposedUnits('thorough');
    for (const u of ['semantic#0/fam-semantic', 'semantic#0/fam-near', 'findings#0/dead-unused',
      'findings#0/hot-tangled', 'findings#0/anti-pattern', 'mixed#0/fam-semantic']) {
      expect(units.has(u)).toBe(true);
    }
  });

  it('admits strictly more than standard, which admits strictly more than safe', () => {
    const safe = proposedUnits('safe'), standard = proposedUnits('standard'), thorough = proposedUnits('thorough');
    for (const u of safe) expect(standard.has(u)).toBe(true);
    for (const u of standard) expect(thorough.has(u)).toBe(true);
    expect(standard.size).toBeGreaterThan(safe.size);
    expect(thorough.size).toBeGreaterThan(standard.size);
  });

  it('withholds a clone family with no known kind at every level', () => {
    expect(result.withheld).toEqual([expect.objectContaining({ unitId: 'fam-no-kind', reason: 'clone-kind-unknown' })]);
    for (const level of ['safe', 'standard'] as const) {
      expect(select(level).withheld.some(w => w.unitId === 'fam-no-kind' && w.reason === 'clone-kind-unknown')).toBe(true);
    }
  });
});

describe('selectBatchesForAggressiveness — batch shape', () => {
  it('narrows a mixed batch to its admitted units instead of dropping it whole', () => {
    const mixed = select('safe').proposed.find(b => b.candidateId === 'mixed#0');
    expect(mixed?.units.map(u => u.id)).toEqual(['fam-exact']);
  });

  it('withholds a unit with no members', () => {
    const r = selectBatchesForAggressiveness('thorough', [{ id: 'empty#0', units: [{ ...exact, members: [] }] }], coverage);
    expect(r.proposed).toEqual([]);
    expect(r.withheld).toEqual([expect.objectContaining({ reason: 'no-members' })]);
  });
});

describe('aggressivenessCandidatesFromTriage', () => {
  const batch: TriageBatch = { area: 'packages/x', index: 2, score: 1, redundantMass: 10, families: [
    { id: 'fam-exact', score: 1, churn: 0, redundantMass: 5, packageDistance: 1, coChange: { minLinkScore: 1, files: 2, basis: 'file' },
      members: [{ path: 'lib/exact-1.ts', line: 1, symbol: 'f' }, { path: 'lib/exact-2.ts', line: 1, symbol: 'f' }] },
    { id: 'fam-missing', score: 1, churn: 0, redundantMass: 5, packageDistance: 1, coChange: { minLinkScore: 1, files: 2, basis: 'file' },
      members: [{ path: 'lib/nokind-1.ts', line: 1, symbol: 'q' }, { path: 'lib/nokind-2.ts', line: 1, symbol: 'q' }] },
  ] };

  it('joins each family kind from the triage input and keys the candidate like the executor', () => {
    const [candidate] = aggressivenessCandidatesFromTriage([batch], [{ id: 'fam-exact', kind: 'exact' }], () => 9);
    expect(candidate.id).toBe('packages/x#2');
    expect(candidate.units.map(u => [u.id, u.findingClass, u.cloneKind])).toEqual([
      ['fam-exact', 'clone', 'exact'], ['fam-missing', 'clone', undefined]]);
    expect(candidate.units[0].members[0]).toEqual({ path: 'lib/exact-1.ts', line: 1, symbol: 'f', endLine: 9 });
  });

  it('a family whose kind did not join is withheld rather than treated as mechanical', () => {
    const candidatesFromTriage = aggressivenessCandidatesFromTriage([batch], [{ id: 'fam-exact', kind: 'exact' }]);
    const r = selectBatchesForAggressiveness('safe', candidatesFromTriage, coverage);
    expect(r.proposed.flatMap(b => b.units.map(u => u.id))).toEqual(['fam-exact']);
    expect(r.withheld).toEqual([expect.objectContaining({ unitId: 'fam-missing', reason: 'clone-kind-unknown' })]);
  });
});

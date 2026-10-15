import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { classifyStewardshipCycle, readGoalRubricStewardship, renderGoalRubricStewardshipBrief, type GoalRubricStewardship, type StewardshipCard, type StewardshipRepair } from './goal-rubric-stewardship';

const readers = vi.hoisted(() => ({
  rubric: vi.fn(), seedableRubric: vi.fn(), cards: vi.fn(),
}));
vi.mock('./rubrics', () => ({
  getRubricWithoutSeeding: readers.rubric,
  getRubric: readers.seedableRubric,
}));
vi.mock('./scorecards', () => ({
  listScorecards: readers.cards,
  settledGradingAuditIsCurrent: () => true,
}));
vi.mock('./work-item-completion-authority', () => ({ isSufficientEvidence: () => true }));
vi.mock('./work-items', () => ({ getWorkItemsByIds: async () => [] }));
vi.mock('./acceptance-author-identity', () => ({ acceptanceLineageClosure: async () => new Set() }));

describe('goal rubric stewardship read-only lookup', () => {
  beforeEach(() => {
    readers.rubric.mockReset().mockResolvedValue(null);
    readers.cards.mockReset().mockResolvedValue([]);
    // In a real cold process, getRubric's missing-row fallback seeds first-party
    // plans. A GUI evidence read must not enter that write path or wait for it.
    readers.seedableRubric.mockReset().mockImplementation(async () => {
      throw new Error('Seedable rubric lookup reached from a read-only goal query');
    });
  });

  it('leaves an absent rubric unmeasured without starting the seedable library read', async () => {
    const sql = vi.fn().mockResolvedValue([]) as unknown as Sql;
    const result = await readGoalRubricStewardship({ workspaceId: 'isolated', goalId: 'empty-goal' }, { sql });

    expect(result.error).toBeNull();
    expect(result.rubricRevision).toBeNull();
    expect(result.cycles).toEqual([]);
    expect(readers.rubric).toHaveBeenCalledWith('work-on-everything-stewardship-health');
    expect(readers.seedableRubric).not.toHaveBeenCalled();
  });

  it('retains the existing rubric revision through the same read-only lookup', async () => {
    readers.rubric.mockResolvedValue({ revision: 47 });
    const sql = vi.fn().mockResolvedValue([]) as unknown as Sql;
    const result = await readGoalRubricStewardship({ workspaceId: 'isolated', goalId: 'empty-goal' }, { sql });

    expect(result.error).toBeNull();
    expect(result.rubricRevision).toBe(47);
    expect(readers.seedableRubric).not.toHaveBeenCalled();
  });

  it('also resolves referenced scorecard rubrics without entering the seedable fallback', async () => {
    readers.cards.mockResolvedValue([baseline()]);
    const sql = vi.fn().mockResolvedValueOnce([{ id: 'EI-1', baseline: null }])
      .mockResolvedValue([]) as unknown as Sql;
    const result = await readGoalRubricStewardship({ workspaceId: 'isolated', goalId: 'goal-with-card' }, { sql });

    expect(result.error).toBeNull();
    expect(result.cycles).toHaveLength(1);
    expect(readers.rubric).toHaveBeenCalledWith('quality');
    expect(readers.seedableRubric).not.toHaveBeenCalled();
  });

  it('reads cycle evidence without awaiting unused background-generation currentness', async () => {
    readers.cards.mockImplementation(async (filter) => {
      if (filter.includeGeneration !== false) {
        throw new Error('Background-generation probe reached from stewardship projection');
      }
      return [baseline()];
    });
    const sql = vi.fn().mockResolvedValueOnce([{ id: 'EI-1', baseline: null }])
      .mockResolvedValue([]) as unknown as Sql;
    const result = await readGoalRubricStewardship({ workspaceId: 'isolated', goalId: 'goal-with-card' }, { sql });

    expect(result.error).toBeNull();
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].scorecardRef).toBe('EI-1');
    expect(readers.rubric).toHaveBeenCalledWith('quality');
  });
});

const baseline = (): StewardshipCard => ({ issueId: 'EI-1', createdAt: '2026-10-09T10:00:00Z', createdBy: 'grader',
  rubricRef: 'quality', rubricRevision: 4, criteriaHash: 'same-criteria', subject: { kind: 'pot', ref: 'target' },
  ratings: { quality: { rating: 'fail', evidence: 'Confirmed failure', remediation: 'WI-12' } },
  settled: true, current: true, requiresIndependentAcceptance: true, acceptanceIndependent: true });
const regrade = (): StewardshipCard => ({ ...baseline(), issueId: 'EI-2', baselineRef: 'EI-1',
  createdAt: '2026-10-09T12:00:00Z', ratings: { quality: { rating: 'pass', evidence: 'Independent rerun passed' } } });
const repair = (): StewardshipRepair => ({ id: 'WI-12', goalId: 'g', owner: 'builder',
  closedAt: '2026-10-09T11:00:00Z', verified: true });
const grade = (after = regrade(), before = baseline(), fixes = [repair()]) =>
  classifyStewardshipCycle('g', after, [before, after], fixes);

describe('goal rubric stewardship brief', () => {
  it('carries responsibilities and bounded assignment controls while missing evidence remains a gap', () => {
    const text = renderGoalRubricStewardshipBrief(null);
    for (const phrase of ['Maintain rubric coverage', 'Improve rubric quality', 'Grade, improve and re-grade',
      'exact target', 'pinned rubric revision', 'goal provenance', 'scope, budget, cadence and exit criterion',
      'baselineRef', 'supersedes corrects', 'independent acceptance', 'Evidence: unavailable']) expect(text).toContain(phrase);
  });
  it('carries the canonical rubric revision and baseline/repair/regrade status without hiding limited or failed reads', () => {
    const evidence: GoalRubricStewardship = { measuredAt: '2026-10-09T12:00:00Z', windowStart: '2026-10-02T12:00:00Z',
      complete: false, rubricRef: 'work-on-everything-stewardship-health', rubricRevision: 47,
      criteria: { 'rubric-coverage-stewardship': null, 'rubric-quality-stewardship': null, 'grading-correction-closure': null },
      cycles: [grade()], error: 'A source is unavailable' };
    const text = renderGoalRubricStewardshipBrief(evidence);
    expect(text).toContain('work-on-everything-stewardship-health@47');
    expect(text).toContain('limited recent page, not a census');
    expect(text).toContain('baseline=EI-1; regrade=EI-2; repairs=WI-12');
    expect(text).toContain('not measured');
    expect(text).toContain('Evidence unavailable: A source is unavailable');
  });
});

describe('goal rubric stewardship: verified improvement', () => {
  it('credits the linked comparable audited re-grade after verified independent repair', () => {
    expect(grade()).toMatchObject({ status: 'verified', baselineRef: 'EI-1', scorecardRef: 'EI-2', repairRefs: ['WI-12'] });
  });
  it.each([
    { rubricRevision: 5 }, { criteriaHash: 'changed' }, { subject: { kind: 'pot' as const, ref: 'other' } },
    { subject: { kind: 'plan' as const, ref: 'target' } }, { rubricRef: 'other' },
  ])('requires a fresh baseline when the comparison identity changes: %j', change => {
    expect(grade({ ...regrade(), ...change }).status).toBe('incomparable');
  });
  it.each([{ settled: false }, { current: false }])('never credits incomplete or stale evidence: %j', change => {
    expect(grade({ ...regrade(), ...change }).status).toBe('unverified');
  });
  it('does not accept foreign-goal, unverified or incorrectly ordered repairs', () => {
    for (const change of [{ goalId: 'foreign' }, { verified: false }, { closedAt: null },
      { closedAt: '2026-10-09T09:00:00Z' }, { closedAt: '2026-10-09T13:00:00Z' }]) {
      expect(grade(regrade(), baseline(), [{ ...repair(), ...change }]).status).toBe('unverified');
    }
  });
  it('requires an independent final grader where the rubric asks for one', () => {
    expect(grade({ ...regrade(), createdBy: 'builder' }).status).toBe('unverified');
    expect(grade({ ...regrade(), createdBy: 'builder-child', acceptanceIndependent: false }).status).toBe('unverified');
    expect(grade({ ...regrade(), acceptanceIndependent: undefined }).status).toBe('unverified');
    expect(grade({ ...regrade(), createdBy: 'builder', requiresIndependentAcceptance: false }).status).toBe('verified');
  });
  it('rejects unreadable chronology instead of treating NaN comparisons as verified order', () => {
    expect(grade({ ...regrade(), createdAt: 'invalid' }).status).toBe('unverified');
    expect(grade(regrade(), { ...baseline(), createdAt: 'invalid' }).status).toBe('unverified');
    expect(grade(regrade(), baseline(), [{ ...repair(), closedAt: 'invalid' }]).status).toBe('unverified');
  });
  it('keeps unresolved and unknown re-grade criteria visible', () => {
    for (const rating of ['fail', 'partial', 'unknown']) {
      expect(grade({ ...regrade(), ratings: { quality: { rating, evidence: 'Measured' } } }).status).toBe('needs-repair');
    }
  });
  it('does not confuse a passing baseline, missing baseline or unlinked repair with improvement', () => {
    expect(classifyStewardshipCycle('g', { ...regrade(), baselineRef: undefined }, [], []).status).toBe('baseline');
    expect(classifyStewardshipCycle('g', regrade(), [], [repair()]).status).toBe('unverified');
    expect(grade(regrade(), { ...baseline(), ratings: { quality: { rating: 'fail', evidence: 'No repair reference' } } }).status)
      .toBe('unverified');
  });
  it('separates repairs still open from verified repairs awaiting re-grade', () => {
    expect(classifyStewardshipCycle('g', baseline(), [], []).status).toBe('needs-repair');
    expect(classifyStewardshipCycle('g', baseline(), [], [repair()]).status).toBe('needs-regrade');
  });
  it('never treats correction lineage as an improvement baseline', () => {
    expect(grade({ ...regrade(), baselineRef: undefined, supersedes: 'EI-1' }).status).toBe('unverified');
    expect(grade({ ...regrade(), supersedes: 'EI-1' }).status).toBe('unverified');
  });
});

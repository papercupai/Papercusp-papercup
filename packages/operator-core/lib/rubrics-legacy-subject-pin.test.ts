import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { legacyRubricTemplateDataMatches } from './rubrics';

// WI-10006667: acceptance-bar-amendment advances barContract.subjectPlanRevision IN PLACE
// at the same rubric version (no BAR meaning change, no revision snapshot). The legacy
// current-version branch of getRubricAtRevision compared snapshot vs row structured data
// with strict deep equality, so `rubrics:get { revision: <current> }` failed closed for
// acceptance-mdenseon-adoption-measurements-2026-10-01 (snapshot pin 4, row pin 20) even
// though nothing about the grading contract had changed.

const criterion = {
  key: 'r-1',
  title: 'Outcome',
  model: 'the measured outcome holds',
  method: 'run the named test',
  driftMarkers: 'any regression',
};
const barContract = {
  schemaVersion: 1,
  cohort: 'post-epoch',
  adoptionEpoch: 1,
  seededAt: '2026-10-01T00:00:00.000Z',
  subjectPlanRevision: 4,
  meaningRevision: 1,
};
const snapshotData = {
  kind: 'acceptance',
  subjectPlan: 'some-plan',
  characteristic: 'acceptance',
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  criteria: [criterion],
  barSetHash: 'abc123',
  barContract,
};
const withContract = (patch: Record<string, unknown>) => ({
  ...snapshotData,
  barContract: { ...barContract, ...patch },
});

describe('legacyRubricTemplateDataMatches (WI-10006667)', () => {
  it('accepts identical structured data', () => {
    expect(legacyRubricTemplateDataMatches(snapshotData, structuredClone(snapshotData))).toBe(true);
  });

  it('accepts drift ONLY in the in-place-advanced barContract.subjectPlanRevision pin', () => {
    const advanced = withContract({ subjectPlanRevision: 20 });
    // Control: the pre-fix comparison (strict deep equality) rejects this exact fixture,
    // so the assertion below is not vacuous.
    expect(isDeepStrictEqual(snapshotData, advanced)).toBe(false);
    expect(legacyRubricTemplateDataMatches(snapshotData, advanced)).toBe(true);
  });

  it('still fails closed on an unrecorded grading change, even alongside a pin advance', () => {
    const methodChanged = {
      ...withContract({ subjectPlanRevision: 20 }),
      criteria: [{ ...criterion, method: 'Unrecorded new instructions' }],
    };
    expect(legacyRubricTemplateDataMatches(snapshotData, methodChanged)).toBe(false);
    expect(legacyRubricTemplateDataMatches(snapshotData, { ...snapshotData, barSetHash: 'other' })).toBe(false);
  });

  it('does not ignore any OTHER barContract field', () => {
    expect(legacyRubricTemplateDataMatches(snapshotData, withContract({ meaningRevision: 2 }))).toBe(false);
    expect(
      legacyRubricTemplateDataMatches(snapshotData, withContract({ subjectPlanRevision: 20, cohort: 'legacy-backfilled' })),
    ).toBe(false);
  });

  it('requires the pin to be present on both sides and integer-valued', () => {
    const { subjectPlanRevision: _omitted, ...pinless } = barContract;
    expect(legacyRubricTemplateDataMatches(snapshotData, { ...snapshotData, barContract: pinless })).toBe(false);
    expect(legacyRubricTemplateDataMatches(snapshotData, withContract({ subjectPlanRevision: '20' }))).toBe(false);
    expect(legacyRubricTemplateDataMatches(withContract({ subjectPlanRevision: 'x' }), withContract({ subjectPlanRevision: 'y' })))
      .toBe(false);
  });

  it('is plain deep equality when there is no barContract', () => {
    const { barContract: _none, ...standard } = snapshotData;
    expect(legacyRubricTemplateDataMatches(standard, structuredClone(standard))).toBe(true);
    expect(legacyRubricTemplateDataMatches(standard, { ...standard, title: 'changed' })).toBe(false);
    expect(legacyRubricTemplateDataMatches(null, null)).toBe(true);
    expect(legacyRubricTemplateDataMatches(standard, null)).toBe(false);
  });
});

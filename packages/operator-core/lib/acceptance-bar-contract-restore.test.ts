import { describe, expect, it } from 'vitest';
import {
  selectOrphanedAcceptanceBarWitness,
  type AcceptanceBarRestoreCandidate,
  type AcceptanceBarSubjectPin,
} from './acceptance-bar-contract-restore';

const RUBRIC = 'acceptance-demo-plan';
const SET_HASH = 'a'.repeat(64);

const pin = (over: Partial<AcceptanceBarSubjectPin> = {}): AcceptanceBarSubjectPin => ({
  rubricSlug: RUBRIC,
  rubricRevision: 9,
  barSetHash: SET_HASH,
  epoch: 1,
  cohort: 'post-epoch',
  seededAt: '2026-10-15T15:56:34Z',
  seededBy: 'su-seeder',
  ...over,
});

const startedData = (over: Record<string, unknown> = {}, contract: Record<string, unknown> = {}) => ({
  kind: 'acceptance',
  subjectPlan: 'demo-plan',
  barSetHash: SET_HASH,
  barContract: { schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 21, ...contract },
  criteria: [{ key: 'r-1', barKey: 'R-1', barHash: 'b'.repeat(64) }],
  ...over,
});

// What a whole-document propose on a stale build left behind: same subject, no contract.
const orphan = { kind: 'acceptance', subjectPlan: 'demo-plan', criteria: [{ key: 'R-1', barHash: 'c'.repeat(64) }] };

const witness = (over: Partial<AcceptanceBarRestoreCandidate> = {}): AcceptanceBarRestoreCandidate => ({
  seq: 10,
  rubricRevision: 9,
  templateData: startedData(),
  ...over,
});

const select = (over: Partial<Parameters<typeof selectOrphanedAcceptanceBarWitness>[0]> = {}) =>
  selectOrphanedAcceptanceBarWitness({
    rubricSlug: RUBRIC,
    currentRevision: 10,
    storedTemplateData: orphan,
    pin: pin(),
    candidates: [witness(), { seq: 11, rubricRevision: 10, templateData: orphan }],
    ...over,
  });

describe('selectOrphanedAcceptanceBarWitness', () => {
  it('selects the single snapshot that names the pinned revision and agrees with the pin', () => {
    const result = select();
    expect(result).toMatchObject({ ok: true, pinnedRevision: 9, witnessSeq: 10, barSetHash: SET_HASH });
    if (result.ok) expect(result.templateData).toEqual(startedData());
  });

  it('refuses a rubric that still carries its contract (the flag is not a general rewrite door)', () => {
    expect(select({ storedTemplateData: startedData() })).toMatchObject({
      ok: false, code: 'acceptance_bar_restore_not_orphaned',
    });
  });

  it('refuses a non-acceptance rubric', () => {
    expect(select({ storedTemplateData: { kind: 'standard', criteria: [] } })).toMatchObject({
      ok: false, code: 'acceptance_bar_restore_not_acceptance',
    });
  });

  it.each([
    ['epoch', { epoch: null }],
    ['zero epoch (cohort backfill without a seed)', { epoch: 0 }],
    ['seed stamp', { seededAt: null }],
    ['seeder', { seededBy: null }],
    ['set hash', { barSetHash: null }],
    ['rubric revision', { rubricRevision: null }],
  ] as const)('refuses a subject that never adopted a contract (missing %s)', (_label, over) => {
    expect(select({ pin: pin(over as Partial<AcceptanceBarSubjectPin>) })).toMatchObject({
      ok: false, code: 'acceptance_bar_restore_subject_not_adopted',
    });
  });

  it('refuses when the subject pins a different rubric', () => {
    expect(select({ pin: pin({ rubricSlug: 'acceptance-other' }) })).toMatchObject({
      ok: false, code: 'acceptance_bar_restore_subject_pins_other_rubric',
    });
  });

  it('refuses when the rubric is not past the pinned revision', () => {
    expect(select({ currentRevision: 9 })).toMatchObject({ ok: false, code: 'acceptance_bar_restore_pin_not_behind' });
  });

  it('never infers a witness: a snapshot without the exact revision marker does not count', () => {
    expect(select({ candidates: [witness({ rubricRevision: undefined })] })).toMatchObject({
      ok: false, code: 'acceptance_bar_restore_witness_missing',
    });
  });

  it('refuses two snapshots that claim the pinned revision', () => {
    expect(select({ candidates: [witness(), witness({ seq: 12 })] })).toMatchObject({
      ok: false, code: 'acceptance_bar_restore_witness_ambiguous',
    });
  });

  it.each([
    ['barSetHash', startedData({ barSetHash: 'd'.repeat(64) })],
    ['subjectPlan', startedData({ subjectPlan: 'other-plan' })],
    ['adoptionEpoch', startedData({}, { adoptionEpoch: 2 })],
    ['cohort', startedData({}, { cohort: 'legacy-backfilled' })],
    ['barContract absent', { ...startedData(), barContract: undefined }],
  ])('refuses a witness that disagrees with the pin on %s', (field, templateData) => {
    const result = select({ candidates: [witness({ templateData })] });
    expect(result).toMatchObject({ ok: false, code: 'acceptance_bar_restore_witness_mismatch' });
    if (!result.ok) expect(result.detail).toContain(field);
  });
});

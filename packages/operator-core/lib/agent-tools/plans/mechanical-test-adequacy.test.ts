import { describe, expect, it } from 'vitest';
import type { MutationDescriptor } from '@papercusp/test-config/mutation-descriptor';
import { evaluateMechanicalTestAdequacy } from './mechanical-test-adequacy';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';

const file = 'src/guard.test.ts';
const clause = { planSlug: 'mechanical', specId: 'R-3', revision: 2, contentHash: 'spec' };
const mutation: MutationDescriptor = {
  schemaVersion: 1, probeInvocationId: 'probe', leg: 'mutant', mode: 'copy-out',
  subjectPath: 'src/guard.ts', mutateExpression: 's/reject/accept/', againstCommit: null,
  subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
  mutantDiff: '-reject\n+accept', mutantDiffTruncated: false,
  testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64),
};

function proof(kind: 'test' | 'mutation', id = kind === 'test' ? 1 : 2): SpecEvidenceForAdequacy {
  return {
    id, workItemId: 'WI-1', planSlug: clause.planSlug, specId: clause.specId,
    specRevision: clause.revision, specFingerprint: clause.contentHash,
    evidenceKind: kind, evidenceRef: `run:${id}`, testRunId: id, coverageEvidenceRef: null,
    fingerprints: { sourceFingerprint: 's', testFingerprint: 't', fixtureFingerprint: null,
      rubricFingerprint: null, environmentFingerprint: null },
    testRunExecution: { status: kind === 'test' ? 'pass' : 'fail', passed: kind === 'test' ? 1 : 0,
      failed: kind === 'test' ? 0 : 1, skipped: 0, collectionFailed: false, filePath: file },
    testRunProvenance: { filePath: file, source: kind === 'test' ? 'local' : 'mutation-probe',
      commitSha: 'e'.repeat(40), worktreeDirty: false,
      ...(kind === 'mutation' ? { mutationPhase: 'mutant', mutation,
        mutationBaseline: { testRunId: 3, status: 'pass', passed: 1, failed: 0, skipped: 0,
          collectionFailed: false, mutation: { ...mutation, leg: 'baseline' } } } : {}) },
    details: { currentMeasurement: { schemaVersion: 1, kind: 'repo-files',
      sourcePaths: ['src/guard.ts'], testPaths: [file] } },
    currentness: { comparisonSupplied: true, provenance: 'server-measured', overall: 'current',
      dimensions: { spec: 'current', source: 'current', test: 'current', fixture: 'not-applicable',
        rubric: 'not-applicable', environment: 'not-applicable', coverageEvidence: 'not-applicable', testRun: 'current' },
      staleReasons: [], unknownReasons: [] },
  };
}

function grade(evidence = [proof('test'), proof('mutation')], files = [file]) {
  return evaluateMechanicalTestAdequacy({ clause, evidence,
    sourceBarTestRequirements: { status: 'required', files } });
}

describe('mechanical test adequacy', () => {
  it('accepts current named passing runs and a calibrated caught mutant without a card', () => {
    expect(grade()).toMatchObject({ applicable: true, verdict: 'pass', gaps: [],
      passingTestBindingIds: { [file]: 1 }, caughtMutantBindingIds: [2] });
  });

  it('requires a passing run for every named file', () => {
    expect(grade(undefined, [file, 'src/other.test.ts'])).toMatchObject({ verdict: 'fail' });
  });

  it('matches a registered sibling test and caught mutant to their harness-qualified requirement', () => {
    const rows = [proof('test'), proof('mutation')];
    for (const row of rows) Object.assign(row.details.currentMeasurement!, { rootHarnessSlug: 'portal' });
    expect(grade(rows, [`portal/${file}`])).toMatchObject({ verdict: 'pass', gaps: [],
      passingTestBindingIds: { [`portal/${file}`]: 1 }, caughtMutantBindingIds: [2] });
  });

  it.each(['test', 'mutation'] as const)('does not cross-credit the same relative %s path from another harness', kind => {
    const rows = [proof('test'), proof('mutation')];
    for (const row of rows) Object.assign(row.details.currentMeasurement!, {
      rootHarnessSlug: row.evidenceKind === kind ? 'other' : 'portal',
    });
    expect(grade(rows, [`portal/${file}`])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['absent', 'malformed'] as const)('does not infer a sibling root from %s measurement metadata', kind => {
    const rows = [proof('test'), proof('mutation')];
    if (kind === 'malformed') for (const row of rows) row.details.currentMeasurement = {
      kind: 'repo-files', rootHarnessSlug: 'portal',
    };
    expect(grade(rows, [`portal/${file}`])).toMatchObject({ verdict: 'fail' });
  });

  it('does not suffix-match an unrelated parent of a registered harness', () => {
    const rows = [proof('test'), proof('mutation')];
    for (const row of rows) Object.assign(row.details.currentMeasurement!, { rootHarnessSlug: 'portal' });
    expect(grade(rows, [`other/portal/${file}`])).toMatchObject({ verdict: 'fail' });
  });

  it('preserves a requirement already relative to the measured checkout', () => {
    const rows = [proof('test'), proof('mutation')];
    for (const row of rows) Object.assign(row.details.currentMeasurement!, { rootHarnessSlug: 'portal' });
    expect(grade(rows)).toMatchObject({ verdict: 'pass' });
  });

  it('requires a caught mutant even when the clause does not request one separately', () => {
    expect(grade([proof('test')])).toMatchObject({ verdict: 'fail', caughtMutantBindingIds: [] });
  });

  it.each(['test', 'mutation'] as const)('rechecks currentness of the %s proof', kind => {
    const rows = [proof('test'), proof('mutation')];
    rows.find(row => row.evidenceKind === kind)!.currentness.overall = 'stale';
    expect(grade(rows)).toMatchObject({ verdict: 'fail' });
  });

  it('rejects caller-replayed freshness instead of treating it as a measured pass', () => {
    const row = proof('test');
    row.currentness.provenance = 'replayed-snapshot';
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['failed', 'skipped', 'collectionFailed'] as const)('rejects a %s named run', defect => {
    const row = proof('test');
    if (defect === 'collectionFailed') row.testRunExecution!.collectionFailed = true;
    else row.testRunExecution![defect] = 1;
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it('accepts filtered runs only when every declared case actually passed', () => {
    const row = proof('test');
    row.testRunExecution!.skipped = 93;
    row.testRunExecution!.passedCaseTitles = ['composer > sends the exact draft'];
    row.details.adequacy = { testCases: ['composer > sends the exact draft'] };
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'pass',
      passingTestBindingIds: { [file]: 1 } });
  });

  it.each([0, 93])('accepts repeated measured case identities with %s skipped cases', skipped => {
    const row = proof('test');
    row.testRunExecution!.passed = 2;
    row.testRunExecution!.skipped = skipped;
    row.testRunExecution!.passedCaseTitles = ['suite > parameterized case'];
    const testCases = ['suite > parameterized case', 'suite > parameterized case'];
    row.details.adequacy = { testCases };
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'pass' });

    testCases.push('suite > missing case');
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['missing', 'different', 'partial', 'malformed'] as const)(
    'rejects filtered runs with %s declared-case proof', defect => {
      const row = proof('test');
      row.testRunExecution!.skipped = 93;
      row.testRunExecution!.passedCaseTitles = ['composer > sends the exact draft'];
      if (defect === 'different') row.details.adequacy = { testCases: ['composer > asks approval'] };
      if (defect === 'partial') row.details.adequacy = {
        testCases: ['composer > sends the exact draft', 'composer > asks approval'],
      };
      if (defect === 'malformed') row.details.adequacy = { testCases: 'composer > sends the exact draft' };
      expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
    },
  );

  it('does not let binder-written passed titles replace the ledger case list', () => {
    const row = proof('test');
    row.testRunExecution!.skipped = 1;
    row.details.adequacy = { testCases: ['required case'], passedCaseTitles: ['required case'] };
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it('does not credit a missing declared case even in a zero-skip run', () => {
    const row = proof('test');
    row.testRunExecution!.passedCaseTitles = ['some other case'];
    row.details.adequacy = { testCases: ['required case'] };
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['baseline', 'copy-baseline'])('accepts an unmutated %s as passing test evidence', leg => {
    const row = proof('test');
    row.testRunProvenance = { ...row.testRunProvenance!, source: 'mutation-probe', mutationPhase: leg,
      mutation: { ...mutation, leg } };
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'pass',
      passingTestBindingIds: { [file]: 1 } });
  });

  it.each(['mutant', 'historical', 'missing-descriptor', 'phase-mismatch'])(
    'rejects %s probe evidence as a passing original test', defect => {
      const row = proof('test');
      row.testRunProvenance = { ...row.testRunProvenance!, source: 'mutation-probe',
        mutationPhase: defect === 'phase-mismatch' ? 'baseline' : defect,
        ...(defect === 'missing-descriptor' ? {} : {
          mutation: { ...mutation, leg: defect === 'phase-mismatch' ? 'mutant' : defect },
        }) };
      expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
    },
  );

  it('still rejects stale filtered calibration proof', () => {
    const row = proof('test');
    row.testRunExecution!.skipped = 93;
    row.testRunExecution!.passedCaseTitles = ['required case'];
    row.details.adequacy = { testCases: ['required case'] };
    row.testRunProvenance = { ...row.testRunProvenance!, source: 'mutation-probe', mutationPhase: 'baseline',
      mutation: { ...mutation, leg: 'baseline' } };
    row.currentness.overall = 'stale';
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['unlinked', 'outside-source', 'uncaught', 'other-file'] as const)('rejects an %s mutant', defect => {
    const row = proof('mutation');
    if (defect === 'unlinked') row.testRunProvenance!.mutationBaseline = null;
    if (defect === 'outside-source') row.details.currentMeasurement = {
      schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/other.ts'], testPaths: [file] };
    if (defect === 'uncaught') Object.assign(row.testRunExecution!, { status: 'pass', passed: 1, failed: 0 });
    if (defect === 'other-file') row.testRunProvenance!.filePath = 'src/other.test.ts';
    expect(grade([proof('test'), row])).toMatchObject({ verdict: 'fail' });
  });

  it.each(['planSlug', 'specId', 'specFingerprint'] as const)('does not cross-credit a different %s', field => {
    const row = proof('test');
    row[field] = 'other';
    expect(grade([row, proof('mutation')])).toMatchObject({ verdict: 'fail' });
  });

  it('keeps non-test checks on the existing evaluator path', () => {
    expect(evaluateMechanicalTestAdequacy({ clause, evidence: [],
      sourceBarTestRequirements: { status: 'not-required' } })).toEqual({ applicable: false });
  });
});

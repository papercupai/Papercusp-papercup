/**
 * EI-25654677494218501: keep the checked-in execution-integrity rubric prose aligned with
 * the evaluator's canonical measured-case-scope predicate. Ordinary runs may report skipped
 * unrelated tests when every case declared for the proof passed in the same ledger run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './corpus-subject';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const compact = (source: string): string => source.replace(/\s+/g, ' ');

describe('spec-test-adequacy execution-integrity rubric stays derived', () => {
  it('documents the measured skip exception implemented by the evaluator', () => {
    const rubric = JSON.parse(read('rubrics/spec-test-adequacy/rubric.json')) as {
      criteria: Array<{ key: string; method: string }>;
    };
    const method = rubric.criteria.find((criterion) => criterion.key === 'execution-integrity')?.method;
    expect(method).toBeDefined();
    expect(method).not.toContain('skipped=0, collectionFailed=false');
    expect(method).toContain(
      'When skipped>0, the run passes only if every declared adequacy.testCases case has an exact or canonical-title match in the same run\'s passedCaseTitles',
    );
    expect(method).toContain('skipped cases outside that declared scope do not invalidate execution-integrity');

    const evaluator = compact(read('packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts'));
    expect(evaluator).toContain(
      'const executed = [...(row.testRunExecution?.passedCaseTitles ?? []), ...(failedCases ?? [])];',
    );
    expect(evaluator).toContain(
      'const unmatched = declared.filter((title) => !hasMatchingDeclaredCaseTitle(title, executed));',
    );
    expect(evaluator).toContain('run.skipped > 0 && !hasMeasuredCaseScope(row)');
  });
});

describe('spec-test-adequacy fixture-calibration rubric stays derived', () => {
  it('requires independent fixture-absence proof for executable evidence', () => {
    const rubric = JSON.parse(read('rubrics/spec-test-adequacy/rubric.json')) as {
      criteria: Array<{ key: string; model: string; method: string }>;
    };
    const criterion = rubric.criteria.find((row) => row.key === 'fixture-calibration');
    expect(criterion).toBeDefined();

    const model = compact(criterion?.model ?? '');
    const method = compact(criterion?.method ?? '');
    expect(model).not.toContain('only adequacy.fixtureFree=true on that exact bound proof permits fixture-free not-applicable');
    expect(method).not.toContain('accept fixture-free only from adequacy.fixtureFree=true on that exact bound proof');
    expect(model).toContain('adequacy.fixtureFree=true alone is binder-authored metadata and cannot establish fixture absence');
    expect(model).toContain('outside-lineage independent-verification of the same measured source, test, run and selected cases');
    expect(model).toContain('fixturePaths');
    expect(model).toContain('fixtureCalibrated=true');
    expect(method).toContain('fixtureAbsenceVerifications');
    expect(method).toContain('fixturePaths');
    expect(method).toContain('fixtureCalibrated=true');

    const evaluator = compact(read('packages/operator-core/lib/agent-tools/plans/spec-test-adequacy.ts'));
    expect(evaluator).toContain('row.fingerprints.fixtureFingerprint === null');
    expect(evaluator).toContain('row.id && fixtureAbsenceVerifications.has(row.id) && !fixtureUseRequired');
    expect(evaluator).toContain('outside-lineage independent-verification of the same measured source, test, run and selected cases');
  });
});

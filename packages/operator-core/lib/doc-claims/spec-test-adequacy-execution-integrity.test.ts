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

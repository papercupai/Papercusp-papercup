/**
 * Resolve a `{ file, testName }` test-case citation against the per-case results ledger
 * (harness_shared.test_case_runs, migration 1478).
 * Plan test-rubric-unification-2026-10-12 P-002 / R-2.
 *
 * ONE resolver serves both citation sites, so the matching rule cannot drift between them:
 *   - a rubric `kind:'tests'` check that names one file plus a `testName`
 *     (rubrics-criterion-checks.ts, grading time);
 *   - a spec evidence binding that declares `details.adequacy.testCases`
 *     (agent-tools/plans/spec-evidence-store.ts, bind time).
 *
 * A filter that matches ZERO recorded cases is REFUSED, never counted as a pass. A renamed
 * or mistyped test name would otherwise keep reading green while proving nothing. The same
 * holds for a file with no recorded cases at all (the run predates 1478, or the reporter
 * never saw the module): unknown is not zero, so it refuses too.
 *
 * Matching (moved here from spec-evidence-store, unchanged): the name matches a recorded
 * case when it equals the case's full describe/it title path, or a complete suffix of that
 * path starting at a ` > ` boundary. So `"refuses a write"` matches
 * `"probe sql > refuses a write"`, and `"probe sql"` matches no case on its own (a describe
 * block is not a case). A substring inside one segment never matches.
 */

/** Same Vitest title when its hierarchy joiner or leading `it.each` string label is rendered differently. */
export function hasSameCaseTitleIdentity(declaredCaseTitle: string, measuredCaseTitle: string): boolean {
  if (declaredCaseTitle === measuredCaseTitle) return true;
  const normalize = (title: string) => title
    .split(' > ')
    .map((segment) => segment.replace(/^'([^'\s]+)'(?=\s)/, '$1'))
    .join(' ');
  return normalize(declaredCaseTitle) === normalize(measuredCaseTitle);
}

/** Match a complete title or a complete suffix at a Vitest hierarchy boundary. */
export function hasMatchingDeclaredCaseTitle(
  declaredCaseTitle: string,
  executedCaseTitles: readonly string[],
): boolean {
  return executedCaseTitles.some((executedCaseTitle) => {
    const hierarchy = executedCaseTitle.split(' > ');
    return hierarchy.some((_part, start) =>
      hasSameCaseTitleIdentity(declaredCaseTitle, hierarchy.slice(start).join(' > ')),
    );
  });
}

export interface TestCaseFilter {
  /** The test file, repo-relative (the identity test_runs.file_path records). */
  file: string;
  /** A describe/it title path, or a complete suffix of one at a ` > ` boundary. */
  testName: string;
}

/** One recorded case (the shape `testing:runs { cases: true }` returns). */
export interface RecordedTestCase {
  caseKey: string;
  occurrence: number;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number | null;
  errorTail?: string | null;
}

export type TestCaseFilterRefusalCode =
  | 'test_case_filter_invalid'
  | 'test_case_filter_no_cases_recorded'
  | 'test_case_filter_zero_match'
  | 'test_case_filter_unexecuted';

export type TestCaseFilterResolution =
  | {
      ok: true;
      verdict: 'pass' | 'fail';
      matched: RecordedTestCase[];
      passed: number;
      failed: number;
      skipped: number;
    }
  | {
      ok: false;
      code: TestCaseFilterRefusalCode;
      file: string;
      testName: string;
      recordedCaseCount: number;
      /** Up to five recorded case keys, so a near-miss name is easy to correct. */
      recordedSample: string[];
      message: string;
    };

const SAMPLE_SIZE = 5;

function refusal(
  code: TestCaseFilterRefusalCode,
  filter: TestCaseFilter,
  cases: readonly RecordedTestCase[],
  message: string,
): TestCaseFilterResolution {
  return {
    ok: false,
    code,
    file: filter.file,
    testName: filter.testName,
    recordedCaseCount: cases.length,
    recordedSample: [...new Set(cases.map((c) => c.caseKey))].slice(0, SAMPLE_SIZE),
    message,
  };
}

/**
 * Resolve one filter against the recorded cases of ONE file (the caller selects the
 * runs of `filter.file`). Pure: no I/O, so both citation sites and the unit test share it.
 */
export function resolveTestCaseFilter(
  filter: TestCaseFilter,
  cases: readonly RecordedTestCase[] | null | undefined,
): TestCaseFilterResolution {
  const testName = typeof filter.testName === 'string' ? filter.testName.trim() : '';
  const file = typeof filter.file === 'string' ? filter.file.trim() : '';
  const normalized = { file, testName };
  const recorded = cases ?? [];
  if (!file || !testName) {
    return refusal('test_case_filter_invalid', normalized, recorded,
      'a test-case citation needs both a file and a non-empty testName.');
  }
  if (recorded.length === 0) {
    return refusal('test_case_filter_no_cases_recorded', normalized, recorded,
      `no per-case results are recorded for ${file} in the run(s) consulted, so testName ` +
        `${JSON.stringify(testName)} cannot be resolved. Unknown is not a pass: re-run the file ` +
        `so the reporter records its cases, then resolve again.`);
  }
  const matched = recorded.filter((c) => hasMatchingDeclaredCaseTitle(testName, [c.caseKey]));
  if (matched.length === 0) {
    return refusal('test_case_filter_zero_match', normalized, recorded,
      `testName ${JSON.stringify(testName)} matches none of the ${recorded.length} recorded case(s) ` +
        `in ${file}. A zero-match citation is refused rather than counted as a pass; correct the ` +
        `name (full describe/it path, or a suffix at a " > " boundary).`);
  }
  const passed = matched.filter((c) => c.status === 'pass').length;
  const failed = matched.filter((c) => c.status === 'fail').length;
  const skipped = matched.filter((c) => c.status === 'skip').length;
  if (passed + failed === 0) {
    return refusal('test_case_filter_unexecuted', normalized, recorded,
      `testName ${JSON.stringify(testName)} matches ${matched.length} case(s) in ${file}, all ` +
        `skipped. A skipped case proves nothing, so the citation is refused rather than passed.`);
  }
  return { ok: true, verdict: failed === 0 ? 'pass' : 'fail', matched, passed, failed, skipped };
}

/** Repo-relative identity for comparing a cited file with a recorded test_runs.file_path. */
export function sameTestFile(cited: string, recorded: string): boolean {
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const a = norm(cited);
  const b = norm(recorded);
  return a === b || b.endsWith('/' + a) || a.endsWith('/' + b);
}

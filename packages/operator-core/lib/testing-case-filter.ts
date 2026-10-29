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
  return normalizedCaseTitle(declaredCaseTitle) === normalizedCaseTitle(measuredCaseTitle);
}

export function normalizedCaseTitle(title: string): string {
  return title
    .split(' > ')
    .map((segment) => segment.replace(/^'([^'\s]+)'(?=\s)/, '$1'))
    .join(' ');
}

type CaseTitleSnapshot = { titles: readonly string[]; identities: Set<string> };
const caseTitleSnapshots = new WeakMap<readonly string[], CaseTitleSnapshot>();

/** Match a complete title or a complete suffix at a Vitest hierarchy boundary. */
export function hasMatchingDeclaredCaseTitle(
  declaredCaseTitle: string,
  executedCaseTitles: readonly string[],
): boolean {
  let snapshot = caseTitleSnapshots.get(executedCaseTitles);
  // Evidence rendering and grading ask many questions of the same ledger array.
  // Normalize its suffix identities once, while retaining mutation semantics for
  // callers that replace an entry or reuse a mutable array. Weak keys keep the
  // index's lifetime bounded by the ledger snapshot rather than the host process.
  if (!snapshot || snapshot.titles.length !== executedCaseTitles.length ||
      snapshot.titles.some((title, index) => title !== executedCaseTitles[index])) {
    const identities = new Set<string>();
    for (const title of executedCaseTitles) {
      const hierarchy = title.split(' > ').map((segment) => segment.replace(/^'([^'\s]+)'(?=\s)/, '$1'));
      for (let start = 0; start < hierarchy.length; start += 1) {
        identities.add(hierarchy.slice(start).join(' '));
      }
    }
    snapshot = { titles: [...executedCaseTitles], identities };
    caseTitleSnapshots.set(executedCaseTitles, snapshot);
  }
  return snapshot.identities.has(normalizedCaseTitle(declaredCaseTitle));
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

/** A frozen acceptance population, independent of the rows a test run happens to emit. */
export interface TestCasePopulationMember extends TestCaseFilter {
  rowId: string;
}

export interface TestCasePopulationReceipt extends RecordedTestCase {
  file: string;
  testRunId: number;
}

/**
 * Post-run exact census. Callers supply completed canonical ledger rows and bind
 * their source/build identity separately. This function neither runs tests nor
 * creates receipts. Unlike a citation, a population requires ONE passing receipt
 * per selector; aggregation must not hide duplicates or collapsed branches.
 */
export function resolveTestCasePopulation(
  expected: readonly TestCasePopulationMember[],
  recorded: readonly TestCasePopulationReceipt[],
  namespacePrefixes: readonly string[],
): {
  ok: boolean;
  matched: Array<{ rowId: string; receipt: TestCasePopulationReceipt }>;
  issues: Array<{ code: string; rowId?: string; file?: string; caseKey?: string }>;
} {
  const issues: Array<{ code: string; rowId?: string; file?: string; caseKey?: string }> = [];
  const matched: Array<{ rowId: string; receipt: TestCasePopulationReceipt }> = [];
  const ids = new Set<string>(), selectors = new Set<string>();
  const consumed = new Set<TestCasePopulationReceipt>();
  const receiptKeys = new Set<string>();
  const fileRuns = new Map<string, Set<number>>();
  if (expected.length === 0) issues.push({ code: 'empty_population' });
  if (namespacePrefixes.length === 0 || namespacePrefixes.some(prefix => !prefix.trim()))
    issues.push({ code: 'invalid_namespace' });
  for (const member of expected) {
    const selector = JSON.stringify([member.file, member.testName]);
    if (!member.rowId.trim() || !member.file.trim() || !member.testName.trim())
      issues.push({ code: 'invalid_member', rowId: member.rowId });
    if (ids.has(member.rowId)) issues.push({ code: 'duplicate_row_id', rowId: member.rowId });
    if (selectors.has(selector)) issues.push({ code: 'duplicate_selector', rowId: member.rowId });
    ids.add(member.rowId); selectors.add(selector);
    const cases = recorded.filter(row => sameTestFile(member.file, row.file) &&
      hasMatchingDeclaredCaseTitle(member.testName, [row.caseKey]));
    if (cases.length !== 1) {
      issues.push({ code: cases.length === 0 ? 'missing_case' : 'duplicate_receipt', rowId: member.rowId });
      continue;
    }
    const receipt = cases[0]!;
    const key = JSON.stringify([receipt.testRunId, receipt.caseKey, receipt.occurrence]);
    if (consumed.has(receipt) || receiptKeys.has(key))
      issues.push({ code: 'collapsed_receipt', rowId: member.rowId });
    consumed.add(receipt); receiptKeys.add(key);
    if (!Number.isSafeInteger(receipt.testRunId) || receipt.testRunId <= 0 || receipt.occurrence !== 1)
      issues.push({ code: 'invalid_receipt_identity', rowId: member.rowId });
    const runs = fileRuns.get(member.file) ?? new Set<number>();
    runs.add(receipt.testRunId); fileRuns.set(member.file, runs);
    if (receipt.status !== 'pass') issues.push({
      code: receipt.status === 'skip' ? 'unexecuted_case' : 'failed_case', rowId: member.rowId,
    });
    matched.push({ rowId: member.rowId, receipt });
  }
  for (const [file, runs] of fileRuns) {
    if (runs.size !== 1) issues.push({ code: 'mixed_file_runs', file });
  }
  for (const receipt of recorded) {
    // Filtered cases are not execution. A skipped EXPECTED member was refused
    // above; an unselected unrelated registration cannot become an extra run.
    if (receipt.status === 'skip' || consumed.has(receipt)) continue;
    if (receipt.caseKey.split(' > ').some(segment => namespacePrefixes.some(prefix => segment.startsWith(prefix))))
      issues.push({ code: 'extra_case', file: receipt.file, caseKey: receipt.caseKey });
  }
  return { ok: issues.length === 0, matched, issues };
}

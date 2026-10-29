// Plan test-rubric-unification-2026-10-12 P-002 / R-2: the {file, testName} resolver shared
// by rubric tests checks and spec evidence bindings. The bar: a citation whose filter matches
// zero recorded cases is refused rather than counted as a pass.
import { describe, expect, it, vi } from 'vitest';
import {
  hasMatchingDeclaredCaseTitle,
  hasSameCaseTitleIdentity,
  resolveTestCaseFilter,
  resolveTestCasePopulation,
  sameTestFile,
  type RecordedTestCase,
  type TestCasePopulationMember,
  type TestCasePopulationReceipt,
} from './testing-case-filter';

const FILE = 'packages/operator-core/lib/rubric-probe-sql.test.ts';

function rc(caseKey: string, status: RecordedTestCase['status'] = 'pass', occurrence = 1): RecordedTestCase {
  return { caseKey, occurrence, status, durationMs: 3, errorTail: status === 'fail' ? 'AssertionError' : null };
}

const RECORDED: RecordedTestCase[] = [
  rc('probe sql > refuses a write'),
  rc('probe sql > runs a read-only select'),
  rc('probe sql > caps rows'),
  rc('probe sql > nested > times out', 'fail'),
  rc('probe sql > is skipped on CI', 'skip'),
];

describe('resolveTestCasePopulation post-run exact census', () => {
  const expected: TestCasePopulationMember[] = [
    { rowId: 'a', file: FILE, testName: 'governed-a refuses substitution' },
    { rowId: 'b', file: FILE, testName: 'governed-b retains the ordinary control' },
  ];
  const receipts = (): TestCasePopulationReceipt[] => expected.map(row => ({
    ...rc(`suite > ${row.testName}`), file: row.file, testRunId: 123,
  }));
  const census = (rows = receipts(), manifest = expected) =>
    resolveTestCasePopulation(manifest, rows, ['governed-']);
  it('retains each uniquely passing canonical receipt instead of an aggregate', () => {
    const rows = receipts(), result = census(rows);
    expect(result).toMatchObject({ ok: true, issues: [] });
    expect(result.matched.map(row => row.rowId)).toEqual(['a', 'b']);
    expect(result.matched[0]!.receipt).toBe(rows[0]);
  });
  it('refuses missing execution even when a source declaration exists', () => {
    expect(census(receipts().slice(1))).toMatchObject({ ok: false,
      issues: [{ code: 'missing_case', rowId: 'a' }] });
  });
  it('refuses duplicate occurrences and repeated receipts', () => {
    for (const occurrence of [1, 2]) {
      const rows = receipts(); rows.push({ ...rows[0]!, occurrence });
      expect(census(rows).issues).toContainEqual({ code: 'duplicate_receipt', rowId: 'a' });
    }
  });
  it.each(['skip', 'fail'] as const)('refuses a mandatory %s row', status => {
    const rows = receipts(); rows[0]!.status = status;
    expect(census(rows)).toMatchObject({ ok: false });
    expect(census(rows).issues).toContainEqual({
      code: status === 'skip' ? 'unexecuted_case' : 'failed_case', rowId: 'a',
    });
  });
  it('refuses executed extras while ignoring filtered registrations and other namespaces', () => {
    const rows = receipts();
    rows.push({ ...rows[0]!, caseKey: 'suite > unrelated control' });
    rows.push({ ...rows[0]!, caseKey: 'suite > governed-filtered registration', status: 'skip' });
    expect(census(rows).ok).toBe(true);
    rows.push({ ...rows[0]!, caseKey: 'suite > governed-extra unexpected branch' });
    expect(census(rows)).toMatchObject({ ok: false,
      issues: [{ code: 'extra_case', file: FILE, caseKey: 'suite > governed-extra unexpected branch' }] });
  });
  it('refuses two distinct expected selectors collapsed onto one executed row', () => {
    const manifest = [expected[0]!, { ...expected[0]!, rowId: 'other', testName: `suite > ${expected[0]!.testName}` }];
    expect(census(receipts().slice(0, 1), manifest).issues)
      .toContainEqual({ code: 'collapsed_receipt', rowId: 'other' });
  });
  it('refuses duplicate row IDs, selectors, and empty populations', () => {
    expect(census(receipts(), [...expected, { ...expected[0]! }]).issues)
      .toEqual(expect.arrayContaining([{ code: 'duplicate_row_id', rowId: 'a' },
        { code: 'duplicate_selector', rowId: 'a' }]));
    expect(census([], []).issues).toContainEqual({ code: 'empty_population' });
  });
  it('refuses mixing runs for one file and invalid receipt identities', () => {
    const rows = receipts(); rows[1]!.testRunId = 124;
    expect(census(rows).issues).toContainEqual({ code: 'mixed_file_runs', file: FILE });
    rows[1]!.testRunId = 123; rows[0]!.testRunId = Number.NaN;
    expect(census(rows).issues).toContainEqual({ code: 'invalid_receipt_identity', rowId: 'a' });
  });
  it('keeps file identity exact enough that another file cannot discharge a row', () => {
    const rows = receipts(); rows[0]!.file = 'other.test.ts';
    expect(census(rows).issues).toContainEqual({ code: 'missing_case', rowId: 'a' });
  });
  it('refuses a governed extra even in an undeclared file', () => {
    const rows = receipts();
    rows.push({ ...rows[0]!, file: 'extra.test.ts', caseKey: 'governed-extra outside the frozen file population' });
    expect(census(rows).issues).toContainEqual({ code: 'extra_case', file: 'extra.test.ts',
      caseKey: 'governed-extra outside the frozen file population' });
  });
  it('requires a nonempty explicit namespace so extra execution cannot be hidden', () => {
    for (const namespace of [[], ['']])
      expect(resolveTestCasePopulation(expected, receipts(), namespace).issues)
        .toContainEqual({ code: 'invalid_namespace' });
  });
});

describe('resolveTestCaseFilter', () => {
  it('refuses a testName that matches zero recorded cases instead of passing', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'accepts an INSERT' }, RECORDED);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('test_case_filter_zero_match');
    expect(r.recordedCaseCount).toBe(5);
    expect(r.recordedSample).toContain('probe sql > refuses a write');
    expect(r.message).toMatch(/refused rather than counted as a pass/);
  });

  it('refuses a substring that only matches inside one title segment', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'a write' }, RECORDED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('test_case_filter_zero_match');
  });

  it('refuses a describe block name on its own, since a describe block is not a case', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'probe sql' }, RECORDED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('test_case_filter_zero_match');
  });

  it('resolves a full title path to a passing verdict', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'probe sql > refuses a write' }, RECORDED);
    expect(r).toMatchObject({ ok: true, verdict: 'pass', passed: 1, failed: 0, skipped: 0 });
  });

  it('resolves a leaf title (suffix at a " > " boundary) without refusing a real citation', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'runs a read-only select' }, RECORDED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched.map((c) => c.caseKey)).toEqual(['probe sql > runs a read-only select']);
  });

  it('reports fail when a matched case failed', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'nested > times out' }, RECORDED);
    expect(r).toMatchObject({ ok: true, verdict: 'fail', failed: 1 });
  });

  it('aggregates every occurrence of a parameterized case', () => {
    const cases = [rc('each > row', 'pass', 1), rc('each > row', 'fail', 2), rc('each > row', 'pass', 3)];
    const r = resolveTestCaseFilter({ file: FILE, testName: 'row' }, cases);
    expect(r).toMatchObject({ ok: true, verdict: 'fail', passed: 2, failed: 1 });
  });

  it('refuses a citation whose every match was skipped', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: 'is skipped on CI' }, RECORDED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('test_case_filter_unexecuted');
  });

  it('refuses when no cases are recorded for the file (unknown is not a pass)', () => {
    for (const cases of [[], null, undefined]) {
      const r = resolveTestCaseFilter({ file: FILE, testName: 'refuses a write' }, cases);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('test_case_filter_no_cases_recorded');
    }
  });

  it('refuses an empty file or testName', () => {
    for (const filter of [{ file: FILE, testName: '  ' }, { file: '', testName: 'refuses a write' }]) {
      const r = resolveTestCaseFilter(filter, RECORDED);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('test_case_filter_invalid');
    }
  });

  it('trims the cited testName before matching', () => {
    const r = resolveTestCaseFilter({ file: FILE, testName: '  caps rows ' }, RECORDED);
    expect(r).toMatchObject({ ok: true, verdict: 'pass' });
  });
});

describe('hasMatchingDeclaredCaseTitle', () => {
  it('matches across an it.each quoted leading label', () => {
    expect(hasMatchingDeclaredCaseTitle("kind 'tests' accepts", ["suite > 'tests' accepts"])).toBe(false);
    expect(hasMatchingDeclaredCaseTitle('tests accepts', ["suite > 'tests' accepts"])).toBe(true);
  });

  it('bounds normalization work across repeated queries of one ledger snapshot', () => {
    const titles = Array.from({ length: 36 }, (_, i) => `suite > group ${i} > 'tests' accepts > case ${i}`);
    const queries = Array.from({ length: 18 }, (_, i) => `missing case ${i}`);
    const countWork = (match: typeof hasMatchingDeclaredCaseTitle) => {
      const split = vi.spyOn(String.prototype, 'split');
      let count: number;
      let results: boolean[];
      try {
        results = queries.map((query) => match(query, titles));
        count = split.mock.calls.filter(([separator]) => String(separator) === ' > ').length;
      } finally {
        split.mockRestore();
      }
      expect(results!).toEqual(queries.map(() => false));
      return count!;
    };
    // Resident negative control: the pre-fix loop repeatedly normalized both sides
    // of every candidate suffix. Count the work, independent of machine speed.
    const legacy: typeof hasMatchingDeclaredCaseTitle = (declared, executed) => executed.some((title) => {
      const hierarchy = title.split(' > ');
      return hierarchy.some((_part, start) =>
        hasSameCaseTitleIdentity(declared, hierarchy.slice(start).join(' > ')),
      );
    });
    const budget = titles.length * 5 + queries.length;
    expect(countWork(legacy)).toBeGreaterThan(budget * 8);
    expect(countWork(hasMatchingDeclaredCaseTitle)).toBeLessThanOrEqual(budget);
  });

  it('observes appended, replaced and removed titles in a reused array', () => {
    const titles = ['suite > original'];
    expect(hasMatchingDeclaredCaseTitle('original', titles)).toBe(true);
    titles[0] = 'suite > replacement';
    expect(hasMatchingDeclaredCaseTitle('original', titles)).toBe(false);
    expect(hasMatchingDeclaredCaseTitle('replacement', titles)).toBe(true);
    titles.push('suite > appended');
    expect(hasMatchingDeclaredCaseTitle('appended', titles)).toBe(true);
    titles.pop();
    expect(hasMatchingDeclaredCaseTitle('appended', titles)).toBe(false);
  });

  it.each([
    ['nested leaf', 'suite > nested > leaf', true],
    ['nested > leaf', 'suite > nested > leaf', true],
    ['leaf', 'suite > nested > leaf', true],
    ['ested leaf', 'suite > nested > leaf', false],
    ['nested', 'suite > nested > leaf', false],
    ['tests accepts', "suite > 'tests' accepts", true],
    ["kind 'tests' accepts", "suite > 'tests' accepts", false],
    ['', 'suite > ', true],
  ])('preserves title identity for %j within %j', (declared, executed, expected) => {
    expect(hasMatchingDeclaredCaseTitle(declared as string, [executed as string])).toBe(expected);
  });
});

describe('sameTestFile', () => {
  it('matches equal, ./-prefixed, and absolute-suffix spellings of one repo path', () => {
    expect(sameTestFile(FILE, FILE)).toBe(true);
    expect(sameTestFile('./' + FILE, FILE)).toBe(true);
    expect(sameTestFile(FILE, '/home/x/papercusp/' + FILE)).toBe(true);
  });

  it('does not match a different file sharing a basename', () => {
    expect(sameTestFile(FILE, 'packages/other/lib/rubric-probe-sql.test.ts')).toBe(false);
  });
});

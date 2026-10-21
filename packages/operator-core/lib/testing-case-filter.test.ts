// Plan test-rubric-unification-2026-10-12 P-002 / R-2: the {file, testName} resolver shared
// by rubric tests checks and spec evidence bindings. The bar: a citation whose filter matches
// zero recorded cases is refused rather than counted as a pass.
import { describe, expect, it, vi } from 'vitest';
import {
  hasMatchingDeclaredCaseTitle,
  hasSameCaseTitleIdentity,
  resolveTestCaseFilter,
  sameTestFile,
  type RecordedTestCase,
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

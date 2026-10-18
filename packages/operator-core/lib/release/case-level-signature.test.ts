/**
 * P-017 (green-main-ratchet-convergence-2026-10-17): case-level failure keys (R-13) and
 * per-error typecheck/lint keys (R-14). Fixtures are real runner output shapes: tsc default
 * and --pretty diagnostics, the tsc-baseline-gate regression row (U+2192 arrow), and ESLint's
 * stylish formatter.
 */
import { describe, expect, it } from 'vitest';
import {
  casesForFile,
  entryCaseKeys,
  newRepairSignatureKeys,
  parseLegErrorKeys,
  repairSignatureCaseKeys,
} from './case-level-signature';
import { attributeRoundReds, nextRepairSignature } from './frozen-candidate-repair-queue';

const TSC_TWO_ERRORS = [
  'lib/release/promotion-ratchet.ts(41,7): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'lib/release/admission-ratchet.ts(12,3): error TS2304: Cannot find name \'foo\'.',
  'Found 2 errors in 2 files.',
].join('\n');

describe('parseLegErrorKeys (R-14)', () => {
  it('keys a typecheck leg with several errors as one entry per error, each with file and TS code', () => {
    expect(parseLegErrorKeys(TSC_TWO_ERRORS)).toEqual([
      'lib/release/promotion-ratchet.ts|TS2322',
      'lib/release/admission-ratchet.ts|TS2304',
    ]);
  });

  it('parses tsc --pretty output with ANSI colour', () => {
    const pretty = '\u001b[96mlib/a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m9\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS7006: \u001b[0mParameter implicitly has an any type.';
    expect(parseLegErrorKeys(pretty)).toEqual(['lib/a.ts|TS7006']);
  });

  it('occurrence-indexes repeats so a second same-code error in a file is a distinct key', () => {
    const out = ['lib/a.ts(1,1): error TS2322: x', 'lib/a.ts(9,1): error TS2322: y'].join('\n');
    expect(parseLegErrorKeys(out)).toEqual(['lib/a.ts|TS2322', 'lib/a.ts|TS2322#2']);
  });

  it('turns each error above a tsc-baseline row into its own key', () => {
    const out = '   packages/operator-core/lib/x.ts: 12 \u2192 14  (+2)\nFix the new errors in the named file(s).';
    expect(parseLegErrorKeys(out)).toEqual([
      'packages/operator-core/lib/x.ts|tsc-baseline',
      'packages/operator-core/lib/x.ts|tsc-baseline#2',
    ]);
  });

  it('keys ESLint stylish rows by file and rule, ignoring warnings', () => {
    const out = [
      '/repo/apps/operator/src/a.tsx',
      '  3:10  error    Unexpected any  @typescript-eslint/no-explicit-any',
      '  8:1   warning  Prefer const    prefer-const',
      '  9:2   error    Missing key     react/jsx-key',
      '',
      '\u2716 3 problems (2 errors, 1 warning)',
    ].join('\n');
    expect(parseLegErrorKeys(out)).toEqual([
      '/repo/apps/operator/src/a.tsx|@typescript-eslint/no-explicit-any',
      '/repo/apps/operator/src/a.tsx|react/jsx-key',
    ]);
  });

  it('returns no keys for output in no recognised format, so the leg stays keyed whole', () => {
    expect(parseLegErrorKeys('npm error code 1\nsomething broke')).toEqual([]);
  });
});

describe('case-level signature keys (R-13)', () => {
  it('keys a test-file entry by file + case and a lint leg by leg + error', () => {
    expect(repairSignatureCaseKeys([
      { kind: 'test-file', id: 'lib/a.test.ts', cases: ['b case', 'a case'] },
      { kind: 'lint-leg', id: 'lint:tsc', errors: ['lib/x.ts|TS2322'] },
    ])).toEqual(['lib/a.test.ts > a case', 'lib/a.test.ts > b case', 'lint:tsc :: lib/x.ts|TS2322']);
  });

  it('keys an entry with no cases on its id alone (collection crash, whole-file red)', () => {
    expect(entryCaseKeys({ kind: 'test-file', id: 'lib/crash.test.ts' })).toEqual(['lib/crash.test.ts']);
  });

  it('detects a new failing case inside an already failing file', () => {
    const prior = [{ kind: 'test-file', id: 'lib/a.test.ts', cases: ['one'] }];
    const next = [{ kind: 'test-file', id: 'lib/a.test.ts', cases: ['one', 'two'] }];
    expect(newRepairSignatureKeys(prior, next)).toEqual(['lib/a.test.ts > two']);
  });

  it('detects a new error inside an already failing leg', () => {
    const prior = [{ kind: 'lint-leg', id: 'lint:tsc', errors: parseLegErrorKeys('lib/a.ts(1,1): error TS2322: x') }];
    const next = [{
      kind: 'lint-leg',
      id: 'lint:tsc',
      errors: parseLegErrorKeys('lib/a.ts(1,1): error TS2322: x\nlib/a.ts(5,1): error TS2322: y'),
    }];
    expect(newRepairSignatureKeys(prior, next)).toEqual(['lint:tsc :: lib/a.ts|TS2322#2']);
  });

  it('treats a prior whole-entry red as covering every case, and a crash after named cases as new', () => {
    expect(newRepairSignatureKeys(
      [{ kind: 'test-file', id: 'lib/a.test.ts' }],
      [{ kind: 'test-file', id: 'lib/a.test.ts', cases: ['x'] }],
    )).toEqual([]);
    expect(newRepairSignatureKeys(
      [{ kind: 'test-file', id: 'lib/a.test.ts', cases: ['x'] }],
      [{ kind: 'test-file', id: 'lib/a.test.ts' }],
    )).toEqual(['lib/a.test.ts']);
  });

  it('matches runner case names to a signature id by exact path or one unambiguous suffix', () => {
    const byFile = new Map([['lib/a.test.ts', ['z', 'y', 'z']], ['other/b.test.ts', ['q']]]);
    expect(casesForFile(byFile, 'packages/operator-core/lib/a.test.ts')).toEqual(['y', 'z']);
    expect(casesForFile({ 'x/c.test.ts': ['1'], 'y/c.test.ts': ['2'] }, 'c.test.ts')).toBeUndefined();
  });
});

describe('frozen repair signature carries cases and errors (R-13, R-14)', () => {
  it('records failed case names on test-file entries and per-error keys on lint legs, uncapped', () => {
    const cases = Array.from({ length: 200 }, (_, i) => `case ${String(i).padStart(3, '0')}`);
    const { signature } = nextRepairSignature([], {
      head: 'h1',
      round: 1,
      failingTests: ['lib/a.test.ts', 'lint:tsc'],
      casesByFile: { 'lib/a.test.ts': cases },
      legErrors: { 'lint:tsc': parseLegErrorKeys(TSC_TWO_ERRORS) },
    });
    const file = signature.find((e) => e.id === 'lib/a.test.ts');
    const leg = signature.find((e) => e.id === 'lint:tsc');
    expect(file?.cases).toHaveLength(200);
    expect(leg?.errors).toEqual(['lib/release/promotion-ratchet.ts|TS2322', 'lib/release/admission-ratchet.ts|TS2304']);
    expect(repairSignatureCaseKeys(signature)).toHaveLength(202);
  });

  it('attributes a new failing case inside an already failing file to the round, keyed by file + case', () => {
    const prior = nextRepairSignature([], {
      head: 'h1', round: 1, failingTests: ['lib/a.test.ts'], casesByFile: { 'lib/a.test.ts': ['old'] },
    }).signature;
    const next = nextRepairSignature(prior, {
      head: 'h2', round: 2, failingTests: ['lib/a.test.ts'], casesByFile: { 'lib/a.test.ts': ['old', 'new'] },
    }).signature;
    const queue = { candidate: 'c0', admissions: [], convergenceRounds: [], signature: prior } as unknown as Parameters<typeof attributeRoundReds>[0];
    const same = nextRepairSignature(prior, {
      head: 'h2', round: 2, failingTests: ['lib/a.test.ts'], casesByFile: { 'lib/a.test.ts': ['old'] },
    }).signature;
    expect(attributeRoundReds(queue, next, 'h2').map((a) => a.entry)).toEqual(['test-file:lib/a.test.ts']);
    expect(attributeRoundReds(queue, same, 'h2')).toEqual([]);
  });

  it('keeps a carried-forward entry\'s cases when the round did not re-measure its kind', () => {
    const first = nextRepairSignature([], {
      head: 'h1', round: 1, failingTests: ['lint:tsc'], legErrors: { 'lint:tsc': ['lib/a.ts|TS2322'] },
    });
    const second = nextRepairSignature(first.signature, {
      head: 'h2', round: 2, failingTests: ['lib/b.test.ts'], measuredKinds: ['test-file'],
      casesByFile: { 'lib/b.test.ts': ['fails'] },
    });
    expect(second.signature.find((e) => e.id === 'lint:tsc')?.errors).toEqual(['lib/a.ts|TS2322']);
    expect(second.signature.find((e) => e.id === 'lib/b.test.ts')?.cases).toEqual(['fails']);
  });

  it('a round that did not measure cases attributes nothing; a measured case-less red is a new (crash) key', () => {
    const prior = nextRepairSignature([], {
      head: 'h1', round: 1, failingTests: ['lib/a.test.ts'], casesByFile: { 'lib/a.test.ts': ['old'] },
    }).signature;
    const queue = { candidate: 'c0', admissions: [], convergenceRounds: [], signature: prior } as unknown as Parameters<typeof attributeRoundReds>[0];
    // A targeted repair-head re-run reports pass/fail only: no casesByFile at all.
    const unmeasured = nextRepairSignature(prior, { head: 'h2', round: 2, failingTests: ['lib/a.test.ts'] }).signature;
    expect(unmeasured.find((e) => e.id === 'lib/a.test.ts')?.cases).toEqual(['old']);
    expect(attributeRoundReds(queue, unmeasured, 'h2')).toEqual([]);
    // The run measured cases and named none for the file: it now fails on its id alone.
    const crashed = nextRepairSignature(prior, { head: 'h2', round: 2, failingTests: ['lib/a.test.ts'], casesByFile: {} }).signature;
    expect(newRepairSignatureKeys(prior, crashed)).toEqual(['lib/a.test.ts']);
  });
});

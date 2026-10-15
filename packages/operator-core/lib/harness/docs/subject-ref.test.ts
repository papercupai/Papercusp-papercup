import { describe, it, expect } from 'vitest';
import {
  parseSubjectRef,
  parseDocumentsField,
  stringifySubjectRef,
  stringifySubjectRefs,
  type SubjectRef,
} from './subject-ref';

describe('parseSubjectRef', () => {
  it('parses feature ids (F-/WI-/EI-, case-insensitive, upcased)', () => {
    expect(parseSubjectRef('F-001')).toEqual({ kind: 'feature', ref: 'F-001' });
    expect(parseSubjectRef('wi-12')).toEqual({ kind: 'feature', ref: 'WI-12' });
    expect(parseSubjectRef('  F-7  ')).toEqual({ kind: 'feature', ref: 'F-7' });
    // EI- is the improvement/issue id family (improvements:capture mints them) and
    // shares one id space with F-/WI-. It was missing from FEATURE_RE, so an EI-
    // citation fell through to the path branch and got filesystem-checked as a file —
    // reporting a valid work-item reference as a stale citation, which was 3 of the 34
    // offenders on the red lint:insight-citations leg (EI-18820414923640246).
    expect(parseSubjectRef('EI-13317')).toEqual({ kind: 'feature', ref: 'EI-13317' });
    expect(parseSubjectRef('ei-18693907749585513')).toEqual({ kind: 'feature', ref: 'EI-18693907749585513' });
  });

  it('parses symbol refs (file :: name, whitespace optional)', () => {
    expect(parseSubjectRef('src/foo.ts::myFn')).toEqual({ kind: 'symbol', file: 'src/foo.ts', name: 'myFn' });
    expect(parseSubjectRef('src/foo.ts :: myFn')).toEqual({ kind: 'symbol', file: 'src/foo.ts', name: 'myFn' });
  });

  it('parses path globs', () => {
    expect(parseSubjectRef('packages/x/**')).toEqual({ kind: 'path', globs: ['packages/x/**'] });
    expect(parseSubjectRef('a/b.ts')).toEqual({ kind: 'path', globs: ['a/b.ts'] });
  });

  // WI-6554700010008908: a scoped plan ref used to fall through to the path branch, so
  // lint:insight-citations filesystem-checked it and reported a valid decision citation
  // as a stale file (security/hosted-workspace-reverse-connector, workspace-host-threat-model).
  it('parses scoped plan item/decision refs as plan, not path', () => {
    expect(parseSubjectRef('byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-143')).toEqual({
      kind: 'plan',
      ref: 'byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-143',
    });
    expect(parseSubjectRef('  some-plan#P-004 ')).toEqual({ kind: 'plan', ref: 'some-plan#P-004' });
    // Not a plan ref: a path with a fragment, an unscoped item id, a bad suffix.
    expect(parseSubjectRef('docs/a.md#P-1')).toEqual({ kind: 'path', globs: ['docs/a.md#P-1'] });
    expect(parseSubjectRef('P-004')).toEqual({ kind: 'path', globs: ['P-004'] });
    expect(parseSubjectRef('some-plan#X-4')).toEqual({ kind: 'path', globs: ['some-plan#X-4'] });
  });

  it('returns null on blank, degrades a malformed `::` to the file part', () => {
    expect(parseSubjectRef('')).toBeNull();
    expect(parseSubjectRef('   ')).toBeNull();
    expect(parseSubjectRef('src/foo.ts::')).toEqual({ kind: 'path', globs: ['src/foo.ts'] });
  });
});

describe('parseDocumentsField', () => {
  it('handles a bare string', () => {
    expect(parseDocumentsField('F-3')).toEqual([{ kind: 'feature', ref: 'F-3' }]);
  });

  it('collapses loose path strings into one path ref, keeps symbol/feature distinct', () => {
    const refs = parseDocumentsField(['src/a.ts', 'src/b.ts', 'src/c.ts::fn', 'F-9']);
    expect(refs).toContainEqual({ kind: 'path', globs: ['src/a.ts', 'src/b.ts'] });
    expect(refs).toContainEqual({ kind: 'symbol', file: 'src/c.ts', name: 'fn' });
    expect(refs).toContainEqual({ kind: 'feature', ref: 'F-9' });
  });

  it('handles structured object entries', () => {
    const refs = parseDocumentsField([
      { feature: 'F-1' },
      { file: 'src/x.ts', name: 'g' },
      { path: 'docs/**' },
      { paths: ['a.ts', 'b.ts'] },
    ]);
    expect(refs).toContainEqual({ kind: 'feature', ref: 'F-1' });
    expect(refs).toContainEqual({ kind: 'symbol', file: 'src/x.ts', name: 'g' });
    expect(refs).toContainEqual({ kind: 'path', globs: ['docs/**', 'a.ts', 'b.ts'] });
  });

  it('keeps plan refs out of the collapsed path globs (string and object forms)', () => {
    const refs = parseDocumentsField(['src/a.ts', 'some-plan#D-12', { plan: 'other-plan#P-003' }]);
    expect(refs).toEqual([
      { kind: 'path', globs: ['src/a.ts'] },
      { kind: 'plan', ref: 'some-plan#D-12' },
      { kind: 'plan', ref: 'other-plan#P-003' },
    ]);
  });

  it('returns [] for null/empty (unanchored)', () => {
    expect(parseDocumentsField(null)).toEqual([]);
    expect(parseDocumentsField(undefined)).toEqual([]);
    expect(parseDocumentsField([])).toEqual([]);
  });
});

describe('stringify round-trips', () => {
  it('round-trips path/symbol/feature', () => {
    const cases: SubjectRef[] = [
      { kind: 'path', globs: ['src/a.ts'] },
      { kind: 'symbol', file: 'src/a.ts', name: 'fn' },
      { kind: 'feature', ref: 'F-1' },
      { kind: 'plan', ref: 'some-plan#D-12' },
    ];
    for (const c of cases) {
      const round = parseSubjectRef(stringifySubjectRef(c));
      expect(round).toEqual(c);
    }
  });

  it('joins multiple refs for display', () => {
    expect(
      stringifySubjectRefs([
        { kind: 'feature', ref: 'F-1' },
        { kind: 'symbol', file: 'a.ts', name: 'g' },
      ]),
    ).toBe('F-1; a.ts :: g');
  });
});

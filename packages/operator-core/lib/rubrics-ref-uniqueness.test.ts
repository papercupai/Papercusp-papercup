/**
 * A rubric ref names ONE rubric row per workspace (WI-6554700010008395,
 * scope-unique-identifiers-2026-07-26). `uniqueRubricRow` is the shared refusal every
 * slug-only rubric read routes through; the real-PG proof lives in
 * rubrics.integration.test.ts ("rubric refs are workspace-unique").
 */
import { describe, expect, it } from 'vitest';
import { RubricRefAmbiguousError, uniqueRubricRow } from './rubrics';

describe('uniqueRubricRow', () => {
  it('returns the single matching row', () => {
    const row = { plan_slug: 'r', harness_slug: 'papercusp', v: 1 };
    expect(uniqueRubricRow([row], 'r')).toBe(row);
  });

  it('returns undefined when nothing matches the slug (fixtures may return wider sets)', () => {
    expect(uniqueRubricRow([{ plan_slug: 'other', harness_slug: 'papercusp' }], 'r')).toBeUndefined();
  });

  it('refuses a slug held by two harnesses and names both, sorted', () => {
    const rows = [
      { plan_slug: 'r', harness_slug: 'zeta' },
      { plan_slug: 'r', harness_slug: 'alpha' },
    ];
    let caught: unknown;
    try {
      uniqueRubricRow(rows, 'r');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RubricRefAmbiguousError);
    const error = caught as RubricRefAmbiguousError;
    expect(error.code).toBe('rubric_ref_ambiguous');
    expect(error.harnesses).toEqual(['alpha', 'zeta']);
    expect(error.message).toContain("rubric 'r' exists in 2 harnesses");
  });

  it('CONTROL: repeated rows from ONE harness are not a twin', () => {
    const rows = [
      { plan_slug: 'r', harness_slug: 'papercusp' },
      { plan_slug: 'r', harness_slug: 'papercusp' },
    ];
    expect(uniqueRubricRow(rows, 'r')).toBe(rows[0]);
  });
});

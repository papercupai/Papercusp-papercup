/**
 * Plan change-kind-declared-proof-2026-10-15, P-001 / R-1: the bundled change-kind catalog.
 */
import { describe, expect, it } from 'vitest';
import {
  CHANGE_KINDS,
  CHANGE_KIND_CATALOG,
  CHANGE_KIND_STEPS,
  changeKindsArg,
  changeKindReasonArg,
  changeKindsProofWeight,
  droppedChangeKinds,
  isChangeKind,
  normalizeChangeKinds,
} from './change-kind-catalog';

describe('change-kind catalog (P-001)', () => {
  it('ships the nine kinds the owner-approved plan names, each with a non-empty proof list', () => {
    expect([...CHANGE_KINDS]).toEqual([
      'ui',
      'service',
      'migration',
      'background-job',
      'logic',
      'docs',
      'config',
      'test-only',
      'no-code-change',
    ]);
    for (const k of CHANGE_KINDS) {
      const spec = CHANGE_KIND_CATALOG[k];
      expect(spec.kind).toBe(k);
      expect(spec.covers.length).toBeGreaterThan(10);
      expect(spec.proof.length).toBeGreaterThan(0);
    }
  });

  it('ui asks for the four ui proofs and is the most expensive kind', () => {
    const ui = CHANGE_KIND_CATALOG.ui;
    expect(ui.proof).toHaveLength(4);
    expect(ui.proof.join(' ')).toMatch(/recorded run of the real app/);
    expect(ui.proof.join(' ')).toMatch(/build the run used contained this change/);
    expect(ui.proof.join(' ')).toMatch(/plausible wrong one/);
    for (const k of CHANGE_KINDS) {
      if (k !== 'ui') expect(CHANGE_KIND_CATALOG[k].proofWeight).toBeLessThan(ui.proofWeight);
    }
    expect(CHANGE_KIND_CATALOG['no-code-change'].proofWeight).toBe(0);
  });

  it('accepts exactly the steps migration 1518 allows', () => {
    expect([...CHANGE_KIND_STEPS]).toEqual(['create', 'claim', 'checkpoint', 'complete']);
  });

  it('isChangeKind recognizes catalog names only', () => {
    expect(isChangeKind('ui')).toBe(true);
    expect(isChangeKind('UI')).toBe(false);
    expect(isChangeKind('frontend')).toBe(false);
    expect(isChangeKind(3)).toBe(false);
  });

  it('normalizes: trims, de-duplicates and sorts into catalog order', () => {
    expect(normalizeChangeKinds([' logic', 'ui', 'logic', 'docs'])).toEqual({
      ok: true,
      kinds: ['ui', 'logic', 'docs'],
    });
  });

  it('refuses an unknown kind and names it', () => {
    expect(normalizeChangeKinds(['ui', 'frontend', 'frontend'])).toEqual({
      ok: false,
      reason: 'unknown-kind',
      unknown: ['frontend'],
    });
  });

  it('refuses an empty set', () => {
    expect(normalizeChangeKinds([])).toEqual({ ok: false, reason: 'empty', unknown: [] });
    expect(normalizeChangeKinds(['  '])).toEqual({ ok: false, reason: 'empty', unknown: [] });
  });

  it('droppedChangeKinds reports the kinds a re-declaration removed', () => {
    expect(droppedChangeKinds(['ui', 'logic'], ['logic'])).toEqual(['ui']);
    expect(droppedChangeKinds(['logic'], ['ui', 'logic'])).toEqual([]);
    expect(droppedChangeKinds(null, ['logic'])).toEqual([]);
  });

  it('changeKindsProofWeight is the most expensive kind in the set', () => {
    expect(changeKindsProofWeight(['docs', 'ui'])).toBe(CHANGE_KIND_CATALOG.ui.proofWeight);
    expect(changeKindsProofWeight(['logic'])).toBe(CHANGE_KIND_CATALOG.logic.proofWeight);
    expect(changeKindsProofWeight([])).toBe(-1);
  });

  it('the shared zod arg refuses unknown kinds and an empty list', () => {
    const schema = changeKindsArg();
    expect(schema.safeParse(['ui', 'logic']).success).toBe(true);
    expect(schema.safeParse(['frontend']).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
    expect(changeKindReasonArg().safeParse('   ').success).toBe(false);
    expect(changeKindReasonArg().safeParse('scope shrank to logic only').success).toBe(true);
  });
});

/**
 * isCodingBlueprint — the single "is this a code harness" predicate
 * (plan-verification-profiles-2026-10-17 R-5). The release gate's default and the
 * plan verification profile's harness default both read it, so these cases pin the
 * one definition both depend on.
 */
import { describe, expect, it } from 'vitest';
import { isCodingBlueprint } from './hive-release-env';

describe('isCodingBlueprint', () => {
  it('treats an unspecified output kind as repo-commit, so a bare blueprint is coding', () => {
    expect(isCodingBlueprint({})).toBe(true);
    expect(isCodingBlueprint({ knobs: {} })).toBe(true);
  });

  it('is coding for an explicit repo-commit output that keeps its repo', () => {
    expect(isCodingBlueprint({ output: { kind: 'repo-commit' }, knobs: { requiresRepo: true } })).toBe(true);
  });

  it('is NOT coding when the blueprint opts out of a repo', () => {
    expect(isCodingBlueprint({ output: { kind: 'repo-commit' }, knobs: { requiresRepo: false } })).toBe(false);
  });

  it('is NOT coding when the output is not a repo commit', () => {
    expect(isCodingBlueprint({ output: { kind: 'document' } })).toBe(false);
    expect(isCodingBlueprint({ output: { kind: 'message' }, knobs: { requiresRepo: true } })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { evaluatePromotionAssertionGate } from './promotion-assertion-gate';

const PLAN = [
  '# Plan',
  'A prose mention of [VAL-anything] is not a block.',
  '- **P-001** `todo` Item with a block.',
  '  - **[VAL-plan-001]**',
  '    - **Verify:** it works',
  '- **P-002** `todo` Item with a malformed block.',
  '  - **[VAL-',
  '- **P-003** `todo` Clean item.',
].join('\n');

describe('evaluatePromotionAssertionGate (VAL-* retirement)', () => {
  it('refuses every VAL block under a promoted item with val-block-retired', () => {
    const r = evaluatePromotionAssertionGate({
      rawPlan: PLAN,
      planStatus: 'active',
      itemIds: new Set(['P-001', 'P-002', 'P-003']),
    });
    expect(r.enforcing).toBe(true);
    expect(r.violations.map((v) => [v.code, v.planItemId, v.sourceValId])).toEqual([
      ['val-block-retired', 'P-001', 'VAL-plan-001'],
      ['val-block-retired', 'P-002', 'VAL-'],
    ]);
    expect(r.itemsWithAssertions).toEqual(['P-001', 'P-002']);
    expect(r.violations[0].message).toContain('requirement-contract clause');
  });

  it('refuses on every lane, including historical and draft plans', () => {
    for (const planStatus of ['draft', 'shipped', 'archived', 'unknown']) {
      const r = evaluatePromotionAssertionGate({
        rawPlan: PLAN,
        planStatus,
        itemIds: new Set(['P-001']),
      });
      expect(r.violations.map((v) => v.code)).toEqual(['val-block-retired']);
    }
  });

  it('passes a promotion with no VAL block and no longer demands one', () => {
    const r = evaluatePromotionAssertionGate({
      rawPlan: PLAN,
      planStatus: 'active',
      itemIds: new Set(['P-003']),
    });
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.itemsMissingAssertions).toEqual([]);
    expect(r.planHasAdoptedAssertions).toBe(false);
  });

  it('does not widen an empty item set to the whole plan', () => {
    const r = evaluatePromotionAssertionGate({ rawPlan: PLAN, planStatus: 'active', itemIds: new Set() });
    expect(r.violations).toEqual([]);
  });
});

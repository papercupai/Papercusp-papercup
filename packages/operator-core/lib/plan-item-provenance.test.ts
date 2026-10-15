import { describe, expect, it } from 'vitest';
import { planItemProvenanceFromRow } from './plan-item-provenance';

/**
 * planItemProvenanceFromRow answers "which plan items was this work-item promoted from?".
 * The live mint path leaves the legacy `source_plan_item_ids` column NULL and records the
 * provenance only as a `payload.plan_item` stamp, so a reader that consults only the
 * column resolves every live row to "no provenance". These tests pin the precedence:
 * column when populated, stamp otherwise. (Moved from harness-test-gate-provenance.test.ts
 * when the legacy VAL test gate was retired by verification-system-improvements-2026-10-10
 * P-003.)
 */

/** A feature row as the mint path actually leaves it: stamp set, legacy column NULL. */
const STAMPED_ROW = {
  source_plan_slug: 'some-plan-2026-08-03',
  source_plan_item_ids: null,
  stamped_plan_slug: 'some-plan-2026-08-03',
  stamped_item_id: 'P-001',
};

describe('planItemProvenanceFromRow precedence', () => {
  it('prefers the legacy column when it is populated', () => {
    expect(
      planItemProvenanceFromRow({ ...STAMPED_ROW, source_plan_item_ids: ['P-007', 'P-008'] }),
    ).toEqual({ planSlug: 'some-plan-2026-08-03', itemIds: ['P-007', 'P-008'], source: 'column' });
  });

  it('falls back to the payload.plan_item stamp — the case the live mint path produces', () => {
    expect(planItemProvenanceFromRow(STAMPED_ROW)).toEqual({
      planSlug: 'some-plan-2026-08-03',
      itemIds: ['P-001'],
      source: 'stamp',
    });
  });

  it('treats an EMPTY column array as absent rather than as an answer', () => {
    // `[]` is non-NULL, so a `WHERE ... IS NOT NULL` style check would accept it and
    // then resolve to zero items.
    expect(planItemProvenanceFromRow({ ...STAMPED_ROW, source_plan_item_ids: [] }).source).toBe(
      'stamp',
    );
  });

  it('recovers the plan slug from the stamp when the column-side slug is missing', () => {
    expect(
      planItemProvenanceFromRow({ ...STAMPED_ROW, source_plan_slug: null }).planSlug,
    ).toBe('some-plan-2026-08-03');
  });

  it('contrast: the OLD column-only rule resolves the live row to NOTHING', () => {
    // The whole defect in two lines, kept executable so the fix cannot be quietly
    // reverted to "read the column" without a red test.
    expect(STAMPED_ROW.source_plan_item_ids ?? []).toEqual([]);
    expect(planItemProvenanceFromRow(STAMPED_ROW).itemIds).toEqual(['P-001']);
  });

  it('reports none for a work-item with no plan provenance at all', () => {
    expect(planItemProvenanceFromRow(null)).toEqual({ planSlug: null, itemIds: [], source: 'none' });
  });
});

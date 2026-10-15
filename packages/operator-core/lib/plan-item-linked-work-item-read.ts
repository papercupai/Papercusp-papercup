/**
 * The IO half of `plan-item-linked-work-item.ts` (scope-unique-identifiers-2026-07-26
 * P-003 / P-004).
 *
 * A plan item's `P-NNN` is an ordinal unique only inside its plan. The id that is unique
 * in the whole workspace is the work-item the item links to. This module reads those
 * links from the coverage rollup (the work→plan_item `implements` edge and the
 * `plan_item` stamp) and folds them through the pure `linkedWorkItemFields` rule.
 *
 * It has exactly two kinds of consumer, and they must agree:
 *  - `plans:items` prints `workItemId` on every row (P-003);
 *  - every renderer of a cross-plan `plan:<slug>#P-NNN` ref appends ` → <workItemId>`
 *    (P-004: coord:dispatch, coord:handoff and carry-brief through
 *    `makePlanItemResolver`).
 * Both go through `linkedFieldsFromCoverage`, so a reader of either surface lands on
 * the same work-item.
 */
import { getAllPlanItemCoverage, STAMP_ONLY_REL, type CoverageWorkLink } from './plan-item-coverage';
import {
  linkedWorkItemFields,
  PLAN_ITEM_IMPLEMENTS_REL,
  type LinkedWorkItemFields,
} from './plan-item-linked-work-item';

/** The coverage rels that make a work-item the implementation of a plan item. A
 *  `fixes` / `relates` / `duplicates` edge is coverage, not identity. */
export const PLAN_ITEM_IDENTITY_RELS: readonly string[] = [PLAN_ITEM_IMPLEMENTS_REL, STAMP_ONLY_REL];

/** Fold one item's coverage links into its linked work-item fields. */
export function linkedFieldsFromCoverage(
  cov: { links: readonly Pick<CoverageWorkLink, 'workItemId' | 'rel' | 'terminal'>[] } | null | undefined,
): LinkedWorkItemFields {
  return linkedWorkItemFields(
    (cov?.links ?? [])
      .filter((link) => PLAN_ITEM_IDENTITY_RELS.includes(link.rel))
      .map((link) => ({ id: link.workItemId, terminal: link.terminal })),
  );
}

/** Read one plan item's linked work-item fields. Throws only if the coverage read does. */
export async function readPlanItemLinkedWorkItem(planSlug: string, itemId: string): Promise<LinkedWorkItemFields> {
  const ref = `${planSlug}#${itemId}`;
  const coverage = await getAllPlanItemCoverage({ planItemRefs: [ref] });
  return linkedFieldsFromCoverage(coverage.get(ref));
}

/**
 * The suffix a cross-plan ref renderer appends after `plan:<slug>#P-NNN [status]`:
 * ` → WI-…` when one work-item resolves the item, ` → one of WI-a, WI-b` when several
 * qualify (report, never guess), and nothing when the item has no linked work-item.
 */
export function renderLinkedWorkItemSuffix(fields: LinkedWorkItemFields): string {
  if (fields.workItemId) return ` → ${fields.workItemId}`;
  if (fields.workItemIds.length > 1) return ` → one of ${fields.workItemIds.join(', ')}`;
  return '';
}

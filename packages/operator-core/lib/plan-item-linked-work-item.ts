/**
 * The work-item a plan item is linked to (scope-unique-identifiers-2026-07-26 P-003).
 *
 * `P-NNN` is an ordinal that is unique only inside one plan, so a plan-item reference that
 * leaves its plan (a coord message, a hydrated ref, cross-plan tooling) cannot be resolved
 * from the string alone. The work-item `plans:start` / convert.ts promotes the item into is
 * a workspace-unique id, so `plans:items` and `plans:get` expose it on every item.
 *
 * A LEAF module: both tools and their unit tests import it without pulling the store chain.
 *
 * THE RULE
 * --------
 * `workItemIds` lists every work-item linked to the item (the `implements` coord_links edge
 * or the `payload.plan_item` stamp / `source_plan_item_ids` provenance), live ones first.
 * `workItemId` is the one id a consumer may resolve the item through:
 *   1. exactly one non-terminal link → that id;
 *   2. no non-terminal link and exactly one terminal link → that id;
 *   3. otherwise null — several candidates are reported in `workItemIds`, never resolved by
 *      a guess (the same report-don't-guess rule as P-013's by-id reads).
 */

/**
 * The coord_links rel convert.ts writes from a promoted work-item to its plan item
 * (`IMPLEMENTS_REL` in plan-items/convert.ts). Restated here so this leaf never pulls
 * convert.ts's store chain into a static import; plan-item-linked-work-item.test.ts pins
 * the two together.
 */
export const PLAN_ITEM_IMPLEMENTS_REL = 'implements';

export interface LinkedWorkItemCandidate {
  id: string;
  /** The linked work-item is in a terminal state (done, dropped, …). */
  terminal: boolean;
}

export interface LinkedWorkItemFields {
  /** The id to resolve the plan item through, or null when none or several qualify. */
  workItemId: string | null;
  /** Every linked work-item id, non-terminal first, each group sorted; empty when unlinked. */
  workItemIds: string[];
}

export const NO_LINKED_WORK_ITEM: LinkedWorkItemFields = Object.freeze({
  workItemId: null,
  workItemIds: [],
}) as LinkedWorkItemFields;

/** Order-independent: the same candidate set always yields the same fields. */
export function linkedWorkItemFields(candidates: readonly LinkedWorkItemCandidate[]): LinkedWorkItemFields {
  const live = new Set<string>();
  const settled = new Set<string>();
  for (const c of candidates) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) continue;
    (c.terminal ? settled : live).add(c.id);
  }
  // An id reported both live and terminal (two rows, two harnesses) counts as live.
  for (const id of live) settled.delete(id);
  const liveIds = [...live].sort();
  const settledIds = [...settled].sort();
  const workItemIds = [...liveIds, ...settledIds];
  if (workItemIds.length === 0) return { workItemId: null, workItemIds: [] };
  const workItemId =
    liveIds.length === 1 ? liveIds[0]! : liveIds.length === 0 && settledIds.length === 1 ? settledIds[0]! : null;
  return { workItemId, workItemIds };
}

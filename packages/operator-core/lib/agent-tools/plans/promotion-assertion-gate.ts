/**
 * Promotion-time gate for inline VAL-* assertion blocks — now a RETIREMENT gate
 * (plan verification-system-improvements-2026-10-10, P-003; decisions D-001, D-008).
 *
 * Promotion used to parse a plan's inline `[VAL-...]` blocks and store them. VAL-*
 * assertions are retired in favour of the requirement contract, so nothing stores
 * them any more. A block left in a promoted item would therefore be silently
 * dropped — the vacuous outcome this gate exists to prevent. Instead, ANY header-
 * shaped VAL block under a promoted item refuses with the typed retirement code
 * `val-block-retired`, on every lane. A block so malformed it would never have
 * parsed is still a header-shaped line, so the old gate's fail-closed property for
 * malformed blocks survives without the old parser.
 *
 * The result keeps the shape `promote.ts` already consumes; `planHasAdoptedAssertions`
 * and `itemsMissingAssertions` are now always false/empty because "missing an
 * assertion" is no longer a defect.
 */

import { laneOf, type ReconciliationLane } from './spec-enforcement-eligibility';
import {
  findValBlocks,
  valRetirementRefusal,
  type ValRetirementRefusalCode,
} from './val-retirement';

/** A single reason promotion refuses. */
export interface PromotionAssertionFinding {
  code: Extract<ValRetirementRefusalCode, 'val-block-retired'>;
  /** The plan item the block sits under. */
  planItemId: string | null;
  /** The VAL id as written. */
  sourceValId: string | null;
  /** 1-based line in the raw plan. */
  line: number;
  message: string;
}

export interface PromotionAssertionGateResult {
  /** Always true: a retired VAL block refuses on every lane. */
  enforcing: boolean;
  lane: ReconciliationLane;
  /** Always false since VAL-* retirement. Kept for the promote payload shape. */
  planHasAdoptedAssertions: boolean;
  /** One finding per VAL block under a promoted item. */
  violations: PromotionAssertionFinding[];
  /** Always empty since VAL-* retirement. */
  warnings: PromotionAssertionFinding[];
  /** Always empty since VAL-* retirement. */
  itemsMissingAssertions: string[];
  /** Promoted items that still carry a VAL block (the items that refuse). */
  itemsWithAssertions: string[];
}

export interface PromotionAssertionGateInput {
  /** Raw plan markdown — the same `planFile.parsed.raw` promotion already holds. */
  rawPlan: string;
  /** The PLAN's status, reported as `lane`; it no longer changes the verdict. */
  planStatus: string;
  /** The plan items being promoted. */
  itemIds: ReadonlySet<string>;
}

/** Evaluate the promotion-time VAL retirement gate. */
export function evaluatePromotionAssertionGate(
  input: PromotionAssertionGateInput,
): PromotionAssertionGateResult {
  const lane = laneOf(input.planStatus);
  const base = {
    enforcing: true,
    lane,
    planHasAdoptedAssertions: false,
    warnings: [] as PromotionAssertionFinding[],
    itemsMissingAssertions: [] as string[],
  };
  // Nothing being promoted means nothing to police; an empty set must not widen
  // the scan to the whole plan.
  if (input.itemIds.size === 0) {
    return { ...base, violations: [], itemsWithAssertions: [] };
  }
  const blocks = findValBlocks(input.rawPlan, input.itemIds);
  const violations: PromotionAssertionFinding[] = blocks.map((b) => ({
    code: 'val-block-retired' as const,
    planItemId: b.planItemId,
    sourceValId: b.valId,
    line: b.line,
    message: valRetirementRefusal(
      'val-block-retired',
      `${b.planItemId ?? 'plan'} line ${b.line} carries ${b.valId}`,
    ).message,
  }));
  const itemsWithAssertions = [
    ...new Set(blocks.map((b) => b.planItemId).filter((id): id is string => id !== null)),
  ].sort();
  return { ...base, violations, itemsWithAssertions };
}

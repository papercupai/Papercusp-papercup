/**
 * The acceptance plan classes: the ONE list every gate, schema and admission check
 * reads (plan-verification-profiles-2026-10-17 P-006).
 *
 * A plan class names the standard-kind CLASS rubric an acceptance rubric builds on
 * (`rubrics/<class>/rubric.json`, seeded into the rubric store at boot) and the
 * change-risk shape spec-quality and spec-test adequacy hold the plan to.
 *
 * D-003: the class sits BENEATH the verification profile rather than beside it.
 * `coding` plans use feature-ship / bugfix / migration; `general` plans use
 * plan-class-general, with investigation as a general sub-class. Every class ref that
 * existed before the general class was added stays valid (R-17).
 *
 * Keep this module a LEAF (type-only imports): the MCP admission hot path imports it,
 * so it must not pull the spec-test-adequacy evaluator into that module graph.
 */
import type { VerificationProfile } from '@papercusp/plan-parser';

export const PLAN_CLASS_RUBRIC_REFS = [
  'plan-class-feature-ship',
  'plan-class-bugfix',
  'plan-class-migration',
  'plan-class-investigation',
  'plan-class-general',
] as const;
export type PlanClassRubricRef = (typeof PLAN_CLASS_RUBRIC_REFS)[number];

export function isPlanClassRubricRef(value: unknown): value is PlanClassRubricRef {
  return typeof value === 'string' && (PLAN_CLASS_RUBRIC_REFS as readonly string[]).includes(value);
}

/** D-003: the plan classes each verification profile admits. Every class belongs to exactly one profile. */
export const PLAN_CLASSES_BY_PROFILE: Readonly<Record<VerificationProfile, readonly PlanClassRubricRef[]>> = {
  coding: ['plan-class-feature-ship', 'plan-class-bugfix', 'plan-class-migration'],
  general: ['plan-class-general', 'plan-class-investigation'],
};

/**
 * Classes whose items may legitimately carry no executable test layer: an
 * investigation's findings and a general plan's non-code deliverables are verified by
 * evidence other than a test run. spec-quality accepts an all-exempt item set for them.
 */
export function planClassAllowsAllExemptItems(classRef: PlanClassRubricRef): boolean {
  return classRef === 'plan-class-investigation' || classRef === 'plan-class-general';
}

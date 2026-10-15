/**
 * plans:audit activation classRef resolution
 * (plan-verification-friction-reduction-2026-10-11 P-003, rubric R-3).
 *
 * An activation audit needs the exact PlanClassRubricRef the plan was spec-quality
 * evaluated under, so the acceptance BAR seed keeps plan-class provenance. Callers used to
 * have to restate it; now a missing classRef is DERIVED from the plan's latest
 * plans:evaluate-spec-quality record (its scorecard subject ref carries the class). Either
 * way — supplied or derived — the class must agree with the plan's persisted acceptance
 * class when one exists, so a wrong class can never seed the BARs silently.
 */
import { getAcceptanceRubricsForPlan } from '../../rubrics';
import { listScorecards } from '../../scorecards';
import { resolvePersistedClassRef } from './plan-spec-quality-gate';
import { SPEC_QUALITY_RUBRIC_REF, specQualitySubjectRef } from './spec-quality';
import { PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './spec-test-adequacy';

export type ActivationClassRefResolution =
  | { ok: true; classRef: PlanClassRubricRef; source: 'supplied' | 'derived'; evaluationScorecardId?: string }
  | { ok: false; code: 'class_ref_required' | 'class_ref_mismatch'; detail: string };

export interface ActivationClassRefDeps {
  listCards?: typeof listScorecards;
  listAcceptanceRubrics?: typeof getAcceptanceRubricsForPlan;
}

/** The plan-scoped tail of every spec-quality subject ref, derived from the one writer. */
function specQualityPlanKey(planSlug: string): string {
  const ref = specQualitySubjectRef(planSlug, PLAN_CLASS_RUBRIC_REFS[0], 'x');
  return ref.slice(ref.lastIndexOf(':') + 1);
}

/** `spec-set:<classRef>:<specSetHash>:<planKey>` → classRef, or null when the ref is not that shape. */
export function classRefFromSpecQualitySubjectRef(ref: unknown, planSlug: string): PlanClassRubricRef | null {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length !== 4 || parts[0] !== 'spec-set' || parts[3] !== specQualityPlanKey(planSlug)) return null;
  const classRef = parts[1];
  return (PLAN_CLASS_RUBRIC_REFS as readonly string[]).includes(classRef ?? '') ? (classRef as PlanClassRubricRef) : null;
}

export async function resolveActivationClassRef(
  input: { planSlug: string; harnessSlug: string; suppliedClassRef?: PlanClassRubricRef },
  deps: ActivationClassRefDeps = {},
): Promise<ActivationClassRefResolution> {
  const listCards = deps.listCards ?? listScorecards;
  const listAcceptanceRubrics = deps.listAcceptanceRubrics ?? getAcceptanceRubricsForPlan;

  let classRef = input.suppliedClassRef;
  let source: 'supplied' | 'derived' = 'supplied';
  let evaluationScorecardId: string | undefined;
  if (!classRef) {
    // The plan key is hex, so the LIKE pattern needs no escaping. Newest first.
    const cards = await listCards({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      subjectRefLike: `spec-set:%:${specQualityPlanKey(input.planSlug)}`,
      limit: 5,
    });
    for (const card of cards) {
      const derived = classRefFromSpecQualitySubjectRef(card.subject?.ref, input.planSlug);
      if (derived) {
        classRef = derived;
        source = 'derived';
        evaluationScorecardId = card.issueId;
        break;
      }
    }
    if (!classRef) {
      return {
        ok: false,
        code: 'class_ref_required',
        detail:
          `Plan '${input.planSlug}' has no plans:evaluate-spec-quality record, so classRef cannot be derived. ` +
          `Run plans:evaluate-spec-quality { slug:'${input.planSlug}' } and emit its scorecard, or pass classRef.`,
      };
    }
  }

  const persisted = resolvePersistedClassRef(
    input.planSlug,
    await listAcceptanceRubrics(input.planSlug, { harnessSlug: input.harnessSlug, strict: true }),
  );
  if (persisted.ok && persisted.classRef !== classRef) {
    return {
      ok: false,
      code: 'class_ref_mismatch',
      detail:
        `The ${source} classRef '${classRef}' differs from plan '${input.planSlug}'s persisted acceptance class ` +
        `'${persisted.classRef}'. Re-run plans:evaluate-spec-quality under the persisted class, or amend the ` +
        'acceptance rubric class first.',
    };
  }
  return { ok: true, classRef, source, ...(evaluationScorecardId ? { evaluationScorecardId } : {}) };
}

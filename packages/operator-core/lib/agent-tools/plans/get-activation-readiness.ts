import { getBuildInfo } from '../../build-info';
import { recordExpertiseRoutingInvocation } from '../../endpoint-route/telemetry';
import { CONSULT_DEFAULT_POLICY } from '../../consult/selection-policies';
import { previewProductShaping } from './product-shaping';
import {
  evaluateActivationDeclarations,
  type ActivationDeclarationBlocker,
  type DeclarationStatus,
  type PlanDeclarationDiagnostic,
} from './plan-declarations';

export interface ActivationDeclarationReadiness {
  /** False only when the activation audit would refuse plan_declarations_invalid. */
  ready: boolean;
  /** False for an active/shipped plan, which the gate does not retrofit. */
  applies: boolean;
  reuse: DeclarationStatus;
  libraries: DeclarationStatus;
  blockers: ActivationDeclarationBlocker[];
  diagnostics: PlanDeclarationDiagnostic[];
}

/**
 * Readiness view of the declaration gate (R-3): the same verdict plans:audit
 * phase:activation enforces, so a missing section shows up as a blocker before
 * the audit is attempted. Pure; no consult, no database.
 */
export function activationDeclarationReadiness(
  planContent: string,
  planStatus: string | null | undefined,
): ActivationDeclarationReadiness {
  const gate = evaluateActivationDeclarations(planContent, planStatus);
  return {
    ready: gate.ok,
    applies: gate.applies,
    reuse: gate.preview.reuse.status,
    libraries: gate.preview.libraries.status,
    blockers: gate.applies ? gate.blockers : [],
    diagnostics: gate.preview.diagnostics,
  };
}

/**
 * Side-effect-free activation-readiness consult preview.
 *
 * `plans:start` keeps its existing nudge semantics, but callers need the same
 * candidate selection before they commit an activation audit or freeze
 * first-class clauses. The heavyweight embedder/liveness wiring lives here so
 * the read surfaces can opt in without opening a consult thread or changing
 * start's write path.
 */
import type { PlanStartConsultOutcome } from '../../consult/plan-start-consult';

export type PlanActivationConsultPreview = (
  | PlanStartConsultOutcome
  | {
      outcome: 'unavailable';
      error: 'consult_preview_unavailable';
      message: string;
    }) & { productShaping?: ReturnType<typeof previewProductShaping> };

export async function previewPlanStartConsult(params: {
  workspaceId: string;
  requesterId: string;
  planSlug: string;
  planContent: string;
}): Promise<PlanActivationConsultPreview> {
  try {
    const [
      { getOrgPg },
      { routeConsult },
      { buildQueryEmbedderResolved },
      { resolveProseProfileSelection },
      { resolveSessionStates },
      consult,
    ] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/relevance-router'),
      import('../search/embedder'),
      import('../../search/prose-vector-dims'),
      import('../coordination/liveness-oracle'),
      import('../../consult/plan-start-consult'),
    ]);
    const resolved = await buildQueryEmbedderResolved();
    const embeddingProfile = resolved
      ? resolveProseProfileSelection(resolved.mode, resolved.profile)
      : null;
    const outcome = await consult.planStartConsult(
      params,
      {
        route: (routeParams) =>
          routeConsult({ ...routeParams, telemetry: {
            caller: 'plans:activation-preview', policy: CONSULT_DEFAULT_POLICY, buildSha: getBuildInfo().sha,
          } }, {
            recordTelemetry: receipt => recordExpertiseRoutingInvocation(receipt, getOrgPg().sql),
            getSql: () => getOrgPg().sql,
            embed: resolved?.embed ?? null,
            embeddingProfile,
            embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
            getLiveness: async (ownerIds) => {
              const verdicts = await resolveSessionStates(
                ownerIds.map((ownerId) => ({ ownerId })),
                { hydratePerId: true },
              );
              return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, v.sessionState]));
            },
          }),
        getExcerpts: (refs) => consult.fetchTurnExcerpts(getOrgPg().sql, params.workspaceId, refs),
      },
    );
    return { ...outcome, productShaping: previewProductShaping(params.planContent) };
  } catch (error) {
    // A preview is advisory. Preserve the distinction between an honest empty
    // route and an instrument failure, while never making activation depend on
    // the embedder or liveness service.
    return {
      outcome: 'unavailable',
      error: 'consult_preview_unavailable',
      message: `Consult candidate preview could not be evaluated (${error instanceof Error ? error.message : String(error)}).`,
      productShaping: previewProductShaping(params.planContent),
    };
  }
}

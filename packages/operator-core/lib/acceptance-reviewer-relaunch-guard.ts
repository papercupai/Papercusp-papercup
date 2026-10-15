/**
 * Reviewer-relaunch guard (EI-25876555362728602).
 *
 * WHY. Evaluator independence is computed from durable identity edges
 * (acceptance-author-identity.ts `identityEdges`), and every `adv_sessions` row
 * an identity owns contributes its own `launch_parent_owner → coord_owner_id`
 * edge. `capability:launch-agent` stamps the CALLER as `launchedBy` on every
 * launch, including an in-place resume or a same-identity successor. So when a
 * plan's implementer "recovers" a stalled acceptance reviewer by resuming it,
 * the implementer becomes that reviewer's ancestor FOREVER, and every grade or
 * evidence binding the reviewer records afterwards is refused as
 * `independent_verification_missing`.
 *
 * Observed 2026-10-13: su-090d3775 (launched by system:acceptance-grading-sweep)
 * was resumed in place at 10:23Z and given a successor at 14:37Z, both by the
 * implementer su-bf7f9022. Its R-007/R-008 bindings on
 * workspace-host-deferred-spend-reconciliation-2026-09-07 then failed
 * independence. The edge semantics are correct: the implementer did author the
 * successor's brief. What was missing is a refusal at the launch, before the
 * irreversible edge is written.
 *
 * RULE. A resume, fork or successor sourced from reviewer identity R, launched by an
 * agent caller C (C ≠ R, C not a `system:*` actor), is refused when either:
 *   1. R is (or was) a reviewer on a non-terminal acceptance review-target
 *      reservation for plan P, and C, or an ancestor of C, is one of P's
 *      implementer identities. A new edge C → R makes R a descendant of C and of
 *      every ancestor of C, so this is exactly the set that would become
 *      related. C's own descendants become R's siblings, which is not lineage.
 *      That is why a fleet leader whose OTHER children implement P is still
 *      allowed to relaunch R.
 *   2. R was first launched by a `system:acceptance-*` recruiter, and no
 *      reservation names the plan R reviews. Independence cannot be proved, so
 *      the guard fails closed.
 * Recovery belongs to the recruiter: `plans:set-plan-status { status:'shipped' }`
 * re-routes or mints a lineage-safe judge, and the grading sweep re-recruits.
 *
 * Read failures propagate (fail closed). An unreadable independence population
 * must not read as an empty one.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { ACCEPTANCE_REVIEW_TARGET_NAMESPACE } from './coord/condition-upsert';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { acceptanceLineageAncestors, resolvePlanImplementerIdentities } from './acceptance-author-identity';

/** Launcher prefix the acceptance recruiters stamp (grading sweep, grader recruiter, amendment review). */
export const ACCEPTANCE_RECRUITER_PREFIX = 'system:acceptance-';

export interface ReviewerReservationRef {
  reservationId: string;
  planSlug: string;
}

export interface ReviewerRelaunchGuardDeps {
  /** Non-terminal review-target reservations R holds, released, or appears in the claim history of. */
  reviewerReservations(ownerId: string, workspaceId: string): Promise<ReviewerReservationRef[]>;
  /** First session launcher, falling back to exact-owner task provenance when missing. */
  firstLauncher(ownerId: string, workspaceId: string): Promise<string | null>;
  /** C plus every identity C descends from. */
  ancestors(ownerId: string, workspaceId: string): Promise<Set<string>>;
  /** Plan implementer identities (acceptance-author-identity semantics). */
  implementers(planSlug: string, workspaceId: string): Promise<string[]>;
}

export type ReviewerRelaunchConflict =
  | {
      kind: 'implementer-relaunches-reviewer';
      reviewerOwnerId: string;
      launcherOwnerId: string;
      planSlug: string;
      reservationId: string;
      /** The implementer identity that is C or an ancestor of C. */
      implementer: string;
    }
  | {
      kind: 'recruited-reviewer-unprovable';
      reviewerOwnerId: string;
      launcherOwnerId: string;
      recruiter: string;
    };

export interface ReviewerRelaunchGuardInput {
  workspaceId: string;
  /** The caller (C). */
  launcherOwnerId: string | null | undefined;
  /** The source reviewer identity (R), including forks; null for fresh launches. */
  retainedOwnerId: string | null | undefined;
}

export function reviewerRelaunchSqlDeps(sql: Sql): ReviewerRelaunchGuardDeps {
  return {
    async reviewerReservations(ownerId, workspaceId) {
      const rows = await sql<Array<{ feature_id: string; plan_slug: string | null }>>`
        SELECT feature_id, payload -> 'acceptanceReviewTarget' ->> 'planSlug' AS plan_slug
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND condition_key LIKE ${`${ACCEPTANCE_REVIEW_TARGET_NAMESPACE}:%`}
           AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
           AND (
                 taken_by = ${ownerId}
              OR last_released_by = ${ownerId}
              OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(
                            CASE WHEN jsonb_typeof(worked_by_history::jsonb) = 'array'
                                 THEN worked_by_history::jsonb ELSE '[]'::jsonb END) AS entry
                    WHERE (CASE WHEN jsonb_typeof(entry) = 'string' THEN entry #>> '{}'
                                ELSE COALESCE(entry ->> 'owner', entry ->> 'ownerId', entry ->> 'agent', entry ->> 'by') END)
                          = ${ownerId})
           )
         ORDER BY feature_id`;
      return rows
        .filter((row): row is { feature_id: string; plan_slug: string } => Boolean(row.plan_slug?.trim()))
        .map((row) => ({ reservationId: row.feature_id, planSlug: row.plan_slug.trim() }));
    },
    async firstLauncher(ownerId, workspaceId) {
      // A rejected first turn can register a session before its launch_spec is
      // populated. The managed task already records the recruiter and answering
      // owner; missing session provenance must not turn that reviewer into an
      // ordinary worker (EI-25972280994890936).
      const rows = await sql<Array<{ launch_parent_owner: string | null }>>`
        SELECT COALESCE(
          (SELECT NULLIF(trim(launch_parent_owner), '')
             FROM harness_shared.adv_sessions
            WHERE workspace_id = ${workspaceId}
              AND coord_owner_id = ${ownerId}
            ORDER BY id ASC
            LIMIT 1),
          (SELECT NULLIF(trim(launched_by), '')
             FROM harness_shared.task_ledger
            WHERE workspace_id = ${workspaceId}
              AND class = 'agent-session'
              AND detail ->> 'coordOwnerId' = ${ownerId}
            ORDER BY created_at ASC, task_id ASC
            LIMIT 1)
        ) AS launch_parent_owner`;
      return rows[0]?.launch_parent_owner?.trim() || null;
    },
    ancestors: (ownerId, workspaceId) => acceptanceLineageAncestors(ownerId, { sql, workspaceId }),
    implementers: (planSlug, workspaceId) => resolvePlanImplementerIdentities(planSlug, { sql, workspaceId }),
  };
}

/**
 * Returns the conflict that makes recovery of this reviewer unsafe for
 * acceptance independence, or null when it is safe (or has no reviewer source).
 */
export async function findReviewerRelaunchConflict(
  input: ReviewerRelaunchGuardInput,
  deps: ReviewerRelaunchGuardDeps = reviewerRelaunchSqlDeps(getOrgPg().sql),
): Promise<ReviewerRelaunchConflict | null> {
  const launcher = input.launcherOwnerId?.trim() ?? '';
  const reviewer = input.retainedOwnerId?.trim() ?? '';
  const workspaceId = input.workspaceId.trim();
  if (!launcher || !reviewer || !workspaceId) return null;
  if (launcher === reviewer) return null;
  // A system actor (a recruiter re-launching its own reviewer) is not a plan party.
  if (launcher.startsWith('system:')) return null;

  const [reservations, recruiter] = await Promise.all([
    deps.reviewerReservations(reviewer, workspaceId),
    deps.firstLauncher(reviewer, workspaceId),
  ]);
  const recruited = recruiter?.startsWith(ACCEPTANCE_RECRUITER_PREFIX) ? recruiter : null;
  if (reservations.length === 0 && !recruited) return null;

  if (reservations.length === 0 && recruited) {
    return { kind: 'recruited-reviewer-unprovable', reviewerOwnerId: reviewer, launcherOwnerId: launcher, recruiter: recruited };
  }

  const launcherAncestry = await deps.ancestors(launcher, workspaceId);
  launcherAncestry.add(launcher);
  const seenPlans = new Set<string>();
  for (const reservation of reservations) {
    if (seenPlans.has(reservation.planSlug)) continue;
    seenPlans.add(reservation.planSlug);
    const implementers = await deps.implementers(reservation.planSlug, workspaceId);
    const implementer = implementers.find((id) => launcherAncestry.has(id));
    if (implementer) {
      return {
        kind: 'implementer-relaunches-reviewer',
        reviewerOwnerId: reviewer,
        launcherOwnerId: launcher,
        planSlug: reservation.planSlug,
        reservationId: reservation.reservationId,
        implementer,
      };
    }
  }
  return null;
}

/** The refusal text `capability:launch-agent` returns for a conflict. */
export function renderReviewerRelaunchRefusal(conflict: ReviewerRelaunchConflict): string {
  const recovery =
    'Recover a stalled reviewer through the recruiter, not by relaunching it: ' +
    "`plans:set-plan-status { slug, status:'shipped' }` re-routes the review or mints a lineage-safe judge, " +
    'and the acceptance grading sweep re-recruits stalled graders.';
  if (conflict.kind === 'implementer-relaunches-reviewer') {
    const via =
      conflict.implementer === conflict.launcherOwnerId
        ? `${conflict.launcherOwnerId} implemented it`
        : `${conflict.launcherOwnerId} descends from its implementer ${conflict.implementer}`;
    return (
      `reviewer_relaunch_breaks_independence: ${conflict.reviewerOwnerId} reviews plan ${conflict.planSlug} ` +
      `(reservation ${conflict.reservationId}) and ${via}. This launch would record ${conflict.launcherOwnerId} ` +
      'as the reviewer\'s launcher, which permanently puts the reviewer in the implementer\'s lineage; every grade or ' +
      `evidence binding it records afterwards would then fail independence (EI-25876555362728602). ${recovery}`
    );
  }
  return (
    `reviewer_relaunch_breaks_independence: ${conflict.reviewerOwnerId} was recruited by ${conflict.recruiter} as an ` +
    'acceptance reviewer, and no open review-target reservation names the plan it reviews, so this launch cannot be ' +
    `shown to keep ${conflict.launcherOwnerId} out of that plan's implementer lineage (EI-25876555362728602). ${recovery}`
  );
}

/**
 * Agent-review lifecycle over the existing work-item queue + Blender ledger.
 *
 * `scout_routed_ideas` remains the sole grade authority. The work-item payload stores
 * routing state only; comments preserve round history.
 *
 * WHAT IS AND IS NOT RETRYABLE (WI-41691). `reconcileAgentReviewGrade` below is itself
 * convergent: it re-reads the standing ledger grade, recomputes the target status, and
 * dedupes its own side effects (`changed`, `ensureComment`), so re-invoking it after an
 * applied transition is a no-op and after a PARTIAL one completes the residue. That
 * property is NOT reachable through the supported surface. `blender:grade-idea` runs
 * `preflightAgentReviewGrade` first and returns `applied:false` with
 * `reason:'agent-review-not-pending'` — before the ledger write and before reconcile —
 * as soon as the payload has left 'pending', which a partial write is exactly what makes
 * it do. So a retry THROUGH THE TOOL cannot converge a partially-applied transition;
 * only a direct call to `reconcileAgentReviewGrade` can. That refusal is deliberate
 * (grade-idea.ts D-003/P-004: a non-pending regrade must not re-decide a settled round),
 * not an oversight — the claim that stood here until WI-41691 described the function and
 * silently promised the same of the tool.
 *
 * The gap is narrower than it was, on two counts. WI-41687 removed the dominant
 * partial-write path (the revision transfer no longer throws when the submitter's session
 * has been reaped). WI-41689 then answered the product question this paragraph used to
 * park: a settled row MAY be re-driven, but only FORWARD through `resubmitAgentReview`,
 * which returns it to 'pending' and re-enters review — never by re-deciding a settled
 * round in place through `blender:grade-idea`. Resubmit no longer requires the original
 * submitter to still exist: when the shared liveness oracle reports that session PROVABLY
 * gone, another agent may adopt the row (the orphan-rebind branch below).
 *
 * `ensureComment` or `deliverRevision` throwing after `mergeWorkItemPayload` has committed
 * still leaves partial-write residue, and only a direct `reconcileAgentReviewGrade` call
 * converges that.
 *
 * Pinned by lib/doc-claims/agent-review-retry-convergence.test.ts — if the pending guard
 * is ever relaxed to admit a converging regrade, that test fails and forces this
 * paragraph to be corrected in the same change.
 */
import { isDeepStrictEqual } from 'node:util';

import { getOrgPg } from '@papercusp/db-org';
import { AGENT_REVIEW_ROUND_COMMENT_MARKER, agentReviewRoundComment } from './flow-metrics';
import {
  claimWorkItem,
  commentWorkItem,
  depsBlockedExclusionSql,
  getWorkItem,
  getWorkItemDetail,
  mergeWorkItemPayload,
  releaseWorkItem,
  isClaimHoldParked,
  claimHoldExclusionSql,
  type WorkItem,
} from '../../work-items';
import { activeWorkspaceId } from '../../workspace-registry';
import { selfHealOwnNodeOriginIfStranded } from '../../work-items-admission';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { corroborationReportersSql, VERIFICATION_SUBJECT_ID_SQL } from './corroboration';
import {
  agentReviewEligibility,
  agentReviewPendingSelectorSql,
  acceptanceSourceRevision,
  createImplementationReadiness,
  evaluateImplementationAcceptance,
  type ImplementationAcceptanceContract,
  readImplementationAcceptanceProposal,
  sealImplementationAcceptance,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  mintAgentReviewClaimAdmission,
  mintAgentReviewRevisionAdoptionAdmission,
  readAgentReviewState,
  readImplementationReadiness,
  type AgentReviewState,
  type ImplementationReadinessState,
  STRANDED_SWEEP_OWNER,
  verificationConflict,
  verificationConflictSql,
  verificationParties,
  verificationTaskConflictSql,
  verificationTaskConflict,
  readVerificationTask,
  type VerificationConflictRole,
} from './agent-review-policy';
import {
  parseBugReproductionReceipt,
  readBornVerifiedReproduction,
  readBugReproductionReceipt,
  isAcceptedReproductionStatus,
  verifyCurrentBugReproductionReceipt,
  type BugReproductionReceipt,
  type ReproductionVerification,
} from '../../attention/bug-reproduction';
import { INTAKE_EXECUTION_SCHEMA_VERSION, type IntakeReproductionRecord } from '../../attention/intake-promotion';
// The canonical "this session can still act" set, IMPORTED rather than re-derived.
// Deliberately not a delegation to `rebindIdentity` itself: that migrates ~16 ownerId-keyed
// surfaces (loop, presence, fleet membership, claims, facts, watermarks) from one sid to
// another, whereas the orphan rebind below re-points ONE payload field on ONE work item —
// delegating would move a dead submitter's entire coordination identity onto whoever
// resubmits. The two also sit on OPPOSITE sides of the unknown-verdict question, which is
// why only the constant is shared: `rebindIdentity` fails OPEN on an unmeasured verdict
// (an explicit caller has asserted the death and its surfaces are idempotent), while this
// guard must fail CLOSED (nobody asserted anything — the code is inferring the death).
import { REBIND_BLOCKING_SESSION_STATES } from '../../agent-tools/coordination/rebind-identity';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';
import { effectiveReporter, storedReporter } from './provenance';
import type { FilterNode } from '../../scheduler/claim-spec';
import { compileFilter } from '../../scheduler/get-next';
import { claimSpecSubjectFromWorkItem, matchesClaimSpecFilter } from '../../scheduler/claim-spec-match';

export const AGENT_REVIEW_MAX_REVISION_GRADE = 3;

export interface AgentReviewLedgerGrade {
  ideaId: string;
  workItemId: string;
  grade: number | null;
  feedback: string | null;
  gradedBy: string | null;
}

/**
 * The liveness facts the orphan-rebind guard acts on — a projection of the shared oracle's
 * verdict, deliberately narrowed to the one field the guard is allowed to reason about.
 */
export interface SubmitterLivenessVerdict {
  sessionState: SessionState;
}

export interface AgentReviewDeps {
  verifyReproduction?: (receipt: BugReproductionReceipt, workItem: WorkItem) => Promise<ReproductionVerification>;
  getWorkItem: typeof getWorkItem;
  getWorkItemDetail: typeof getWorkItemDetail;
  mergeWorkItemPayload: typeof mergeWorkItemPayload;
  releaseWorkItem: typeof releaseWorkItem;
  claimWorkItem: typeof claimWorkItem;
  commentWorkItem: typeof commentWorkItem;
  recordRoutedIdea: typeof recordRoutedIdea;
  resolveLedgerIdeaId: (workItemId: string) => Promise<string>;
  readLedgerGrade: (ideaId: string) => Promise<AgentReviewLedgerGrade | null>;
  /** Clear a prior non-owner review grade when a new content round is resubmitted. */
  clearLedgerGrade?: (ideaId: string, workItemId: string) => Promise<void>;
  deliverRevision: (input: {
    to: string;
    workItemId: string;
    round: number;
    grade: number;
    feedback: string;
    gradedBy: string;
  }) => Promise<{ woken: number }>;
  /**
   * Can this agent-review submitter still act? Resolved through THE shared liveness oracle
   * so the answer cannot drift from what coord:presence / fleet:status report for the same
   * agent (presence-derivation-unification-2026-07-17 D-001: one derivation, many lenses).
   *
   * `null` is the oracle's IN-BAND unknown folded into "no reading" — NOT a state. The
   * caller MUST fail closed on it; see the orphan-rebind branch.
   */
  resolveSubmitterLiveness: (
    ownerId: string,
    hints: { claimsHeld: boolean },
  ) => Promise<SubmitterLivenessVerdict | null>;
  /** Exact signed-spawn alias from persisted dispatcher provenance; never a prefix guess. */
  resolveVerifiedSubmitterAlias?: (ownerId: string) => Promise<string | null>;
  /**
   * WI-10006314: flip an own-node row's stranded `origin='remote'` to 'local'. The heal's WHERE
   * clause IS the identity check (WI-10003565), so a foreign remote row is never touched.
   */
  healOwnNodeOrigin: typeof selfHealOwnNodeOriginIfStranded;
}

async function readLedgerGrade(ideaId: string): Promise<AgentReviewLedgerGrade | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{
    idea_id: string;
    routed_ref: string;
    human_grade: number | null;
    human_feedback: string | null;
    graded_by: string | null;
  }[]>`
    SELECT idea_id, routed_ref, human_grade, human_feedback, graded_by
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id = ${ideaId}`;
  const row = rows[0];
  if (!row?.routed_ref.startsWith('wi:')) return null;
  return {
    ideaId: row.idea_id,
    workItemId: row.routed_ref.slice(3),
    grade: row.human_grade == null ? null : Number(row.human_grade),
    feedback: row.human_feedback,
    gradedBy: row.graded_by,
  };
}

/**
 * A review grade belongs to one content round. Resubmission advances the work-item round, so
 * retaining the old ledger grade/feedback lets a reviewer or reconciliation path replay the
 * previous verdict instead of requiring a fresh grade (WI-10005365). Owner grades are sovereign
 * and remain untouched; ordinary reviewer grades are cleared while the round history remains in
 * the work-item comments.
 */
async function clearLedgerGrade(ideaId: string, workItemId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.scout_routed_ideas
       SET human_grade = NULL,
           human_feedback = NULL,
           graded_by = NULL,
           graded_at = NULL
     WHERE idea_id = ${ideaId}
       AND routed_ref = ${`wi:${workItemId}`}
       AND graded_by IS DISTINCT FROM 'owner'`;
}

/**
 * Preserve a pre-existing same-id Blender row when it belongs to another
 * artifact. D-004 reserves exactly one deterministic fallback so migration
 * retries converge and payload.agentReview can point at the real grade authority.
 */
export async function resolveLedgerIdeaId(workItemId: string): Promise<string> {
  const { sql } = getOrgPg();
  const fallback = `agent-review:${workItemId}`;
  const rows = await sql<{ idea_id: string; routed_ref: string }[]>`
    SELECT idea_id, routed_ref
      FROM harness_shared.scout_routed_ideas
     WHERE idea_id IN (${workItemId}, ${fallback})`;
  const byId = new Map(rows.map((row) => [row.idea_id, row.routed_ref]));
  const routedRef = `wi:${workItemId}`;
  const primary = byId.get(workItemId);
  if (primary == null || primary === routedRef) return workItemId;
  const fallbackRoute = byId.get(fallback);
  if (fallbackRoute == null || fallbackRoute === routedRef) return fallback;
  throw new Error(
    `agent review ledger collision: '${workItemId}' and '${fallback}' both route to other artifacts`,
  );
}

export interface PreserveAgentReviewAuthorityResult {
  preserved: boolean;
  ledgerIdeaId?: string;
  reason?: 'not-found' | 'not-agent-review' | 'already-independent';
}

/**
 * Preserve agent-review's grade authority before blender:route-idea reuses the
 * work-item id as the plan-learning row's primary key.
 *
 * Enrollment already chooses `agent-review:<WI>` when the bare id is occupied at
 * enrollment time. The inverse ordering was still unsafe: a feature could enter
 * review first (so its payload + `wi:<WI>` ledger row both used the bare id), then
 * a later plan route would upsert that same row to `plan:<slug>`. The payload kept
 * pointing at the overwritten row, so review pickup remained pending forever while
 * every grade was treated as an ordinary plan-learning grade.
 *
 * Lock the work item and both possible ledger rows, materialize the deterministic
 * fallback, and repoint payload.agentReview in ONE transaction. A normal first
 * route clones the review row (including any standing grade); a retry against the
 * already-overwritten incident shape creates a clean review row instead of copying
 * the unrelated plan grade. The caller may then safely upsert the bare id onto the
 * plan rail. Retries converge once the payload points at the fallback.
 */
export async function preserveAgentReviewAuthorityBeforePlanRoute(input: {
  workItemId: string;
  workspaceId?: string;
}): Promise<PreserveAgentReviewAuthorityResult> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const fallback = `agent-review:${input.workItemId}`;
  const reviewRef = `wi:${input.workItemId}`;
  const now = Date.now();

  return boundedOrgTxn(async (tx) => {
    const workItems = await tx<{ payload: unknown; harness_slug: string; title: string }[]>`
      SELECT payload, harness_slug, title
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${input.workItemId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task', 'feature'])
       FOR UPDATE`;
    const workItem = workItems[0];
    if (!workItem) return { preserved: false, reason: 'not-found' };

    const review = readAgentReviewState(workItem.payload);
    if (!review) return { preserved: false, reason: 'not-agent-review' };
    if (review.ledgerIdeaId !== input.workItemId) {
      return { preserved: false, ledgerIdeaId: review.ledgerIdeaId, reason: 'already-independent' };
    }

    const ledgerRows = await tx<{ idea_id: string; routed_ref: string }[]>`
      SELECT idea_id, routed_ref
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id IN (${input.workItemId}, ${fallback})
       FOR UPDATE`;
    const byId = new Map(ledgerRows.map((row) => [row.idea_id, row.routed_ref]));
    const fallbackRef = byId.get(fallback);
    if (fallbackRef != null && fallbackRef !== reviewRef) {
      throw new Error(
        `agent review ledger collision: fallback '${fallback}' routes to '${fallbackRef}', not '${reviewRef}'`,
      );
    }

    if (fallbackRef == null) {
      const primaryIsReviewAuthority = byId.get(input.workItemId) === reviewRef;
      if (primaryIsReviewAuthority) {
        await tx`
          INSERT INTO harness_shared.scout_routed_ideas
            (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
             lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
             outcome, outcome_checked_at, human_grade, human_feedback, graded_by,
             graded_at, origin, created_by, model_spec, model_config)
          SELECT ${fallback}, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
                 lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
                 outcome, outcome_checked_at, human_grade, human_feedback, graded_by,
                 graded_at, origin, created_by, model_spec, model_config
            FROM harness_shared.scout_routed_ideas
           WHERE idea_id = ${input.workItemId}
          ON CONFLICT (idea_id) DO NOTHING`;
      } else {
        // Retry/repair after the bare row has already become plan provenance: do
        // not copy that row's plan grade into a review round that never received it.
        await tx`
          INSERT INTO harness_shared.scout_routed_ideas
            (idea_id, workspace_id, harness_slug, source_hive, target_hive, cycle_id,
             lens, rail, routed_ref, title, addresses_pattern_refs, routed_at,
             outcome, outcome_checked_at, human_grade, human_feedback, graded_by,
             graded_at, origin, created_by, model_spec, model_config)
          VALUES
            (${fallback}, ${workspaceId}, ${workItem.harness_slug}, ${workItem.harness_slug},
             NULL, NULL, 'agent-review', 'improvement', ${reviewRef}, ${workItem.title},
             NULL, ${now}, NULL, NULL, NULL, NULL, NULL, NULL, 'agent-review',
             ${review.submittedBy}, NULL, NULL)
          ON CONFLICT (idea_id) DO NOTHING`;
      }
    }

    const fallbackRows = await tx<{ routed_ref: string }[]>`
      SELECT routed_ref
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id = ${fallback}`;
    if (fallbackRows[0]?.routed_ref !== reviewRef) {
      throw new Error(`agent review authority migration could not establish '${fallback}' -> '${reviewRef}'`);
    }

    const updated = await tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               COALESCE(payload, '{}'::jsonb),
               '{agentReview,ledgerIdeaId}',
               to_jsonb(${fallback}::text),
               true
             ),
             updated_ts = ${now}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${input.workItemId}
         AND payload #>> '{agentReview,ledgerIdeaId}' = ${input.workItemId}
      RETURNING feature_id`;
    if (!updated[0]) {
      throw new Error(`agent review authority migration lost work-item '${input.workItemId}'`);
    }
    return { preserved: true, ledgerIdeaId: fallback };
  });
}

async function deliverRevision(input: {
  to: string;
  workItemId: string;
  round: number;
  grade: number;
  feedback: string;
  gradedBy: string;
}): Promise<{ woken: number }> {
  const [{ sendMessage }, { wakeRecipients }] = await Promise.all([
    import('../../agent-tools/coordination/messages'),
    import('../../agent-tools/coordination/inbox-wake'),
  ]);
  const summary = `Agent review round ${input.round} requests revision on ${input.workItemId}`;
  const body =
    `${input.gradedBy} graded ${input.workItemId} ${input.grade}/5.\n\n${input.feedback}\n\n` +
    `Revise the same work item, then call improvements:agent-review { mode:'resubmit', id:'${input.workItemId}' }.`;
  await sendMessage(
    {
      ownerId: 'agent-review-revision',
      ownerLabel: 'agent review',
      source: 'static-client' as const,
      workspaceId: null,
      userId: null,
    },
    { to: [input.to], summary, body },
  );
  try {
    return await wakeRecipients([input.to], { summary, source: 'agent-review-revision' });
  } catch {
    return { woken: 0 };
  }
}

/**
 * Default submitter-liveness resolution. The oracle is reached by DYNAMIC import on
 * purpose: it statically pulls presence.ts, adv-sessions and psu-pty-discovery, and this
 * module is imported by hermetic unit tests. Same keep-it-off-the-static-graph discipline
 * `rebindIdentity.defaultResolveLiveness` uses for the same dependency.
 *
 * `hydratePerId` fills heartbeat/stale/host/pid/source from the subject's own presence
 * row, which is what enables the oracle's pid probe — without it a reaped session can
 * resolve to a weaker verdict than the evidence supports.
 */
async function resolveSubmitterLiveness(
  ownerId: string,
  hints: { claimsHeld: boolean },
): Promise<SubmitterLivenessVerdict | null> {
  const { resolveSessionStates } = await import('../../agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates([{ ownerId, claimsHeld: hints.claimsHeld }], {
    hydratePerId: true,
  });
  const v = verdicts.get(ownerId);
  // `sessionState: null` is the oracle's in-band unknown. Fold it into "no reading" here
  // so the single `null` the caller sees always means NOT MEASURED, and it cannot be
  // mistaken for a measured absence.
  return v && v.sessionState != null ? { sessionState: v.sessionState } : null;
}

async function resolveVerifiedSubmitterAlias(ownerId: string): Promise<string | null> {
  if (!ownerId.startsWith('system:')) return null;
  const { sql } = getOrgPg();
  // Reuse the same authenticated telemetry and exact signed-client agreement as
  // the session timeline. The caller identity alone is not evidence of an alias.
  const rows = await sql<{ role: string; client: string }[]>`
    SELECT role, metadata_json->'requestOrigin'->'query'->>'client' AS client
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${activeWorkspaceId()}
       AND coord_owner_id = ${ownerId}
       AND principal_kind = 'harness'
       AND principal_auth_method = 'spawn-url'
       AND principal_trust = 'trusted'
       AND coord_owner_id = ('system:' || role || '/' || (metadata_json->'requestOrigin'->'query'->>'client'))
     ORDER BY invoked_at DESC, id DESC LIMIT 1`;
  if (!rows[0]) return null;
  const { verifiedSpawnSessionAlias } = await import('../../agent-tools/coordination/identity');
  return verifiedSpawnSessionAlias({
    principal: { slug: `system:${rows[0].role}`, authMethod: 'spawn-url', trust: 'trusted' },
    uiClientId: rows[0].client,
  }, ownerId);
}

const defaultDeps: AgentReviewDeps = {
  getWorkItem,
  getWorkItemDetail,
  mergeWorkItemPayload,
  releaseWorkItem,
  claimWorkItem,
  commentWorkItem,
  recordRoutedIdea,
  resolveLedgerIdeaId,
  readLedgerGrade,
  clearLedgerGrade,
  deliverRevision,
  resolveSubmitterLiveness,
  resolveVerifiedSubmitterAlias,
  healOwnNodeOrigin: selfHealOwnNodeOriginIfStranded,
};

/**
 * WI-10006314 — heal an own-node row stranded at `origin='remote'` BEFORE the eligibility check.
 *
 * `agentReviewEligibility` is pure and reads the raw `origin` column, but `origin` records how a
 * row ARRIVED, not who wrote it (WI-10003565): the claim gate (`issueOwnAuthorWhereSql`) and the
 * write path (`setWorkItemState`) already treat an own-author row as ours. Without this the review
 * doors were the one place that disagreed — they refused such a row as 'remote-owned', and only the
 * failure stamp's write healed it as a side effect, so it entered review on a LATER attempt
 * (measured 2026-10-06: 3 of 601 rows in the P-003 stranded sweep). Healing first also matters for
 * what follows the check: the `engineer_issues` view trigger no-ops writes while origin='remote'.
 *
 * A foreign row is untouched (the heal's WHERE is the identity check) and stays refused. Any heal
 * failure FAILS CLOSED: the row is returned unchanged, so the refusal stands as before.
 */
async function healOwnNodeRemoteOrigin(
  workItem: WorkItem,
  deps: AgentReviewDeps,
  scope: { harnessSlug?: string; workspaceId?: string },
): Promise<WorkItem> {
  if (workItem.origin !== 'remote') return workItem;
  try {
    const healed = await deps.healOwnNodeOrigin(
      scope.workspaceId ?? activeWorkspaceId(),
      workItem.id,
      scope.harnessSlug ?? workItem.harness ?? null,
    );
    if (!healed) return workItem;
    return (await deps.getWorkItem(workItem.id, scope.harnessSlug)) ?? { ...workItem, origin: 'local' };
  } catch {
    return workItem;
  }
}

function reviewImplementationReadiness(
  payload: unknown,
  input: {
    status: ImplementationReadinessState['status'];
    reason: string;
    submittedBy: string;
    round: number;
    reviewer?: string;
    grade?: number;
    /** Sealed contract written by an approval; other transitions carry the unsealed proposal. */
    acceptance?: Partial<ImplementationAcceptanceContract>;
  },
): ImplementationReadinessState {
  const existing = readImplementationReadiness(payload);
  const review = existing?.evidence?.review;
  // P-005: never drop a producer's acceptance proposal across review transitions.
  // A previously sealed contract is carried as its proposal fields only, so a
  // re-review judges it afresh rather than inheriting the old authority.
  const proposal = readImplementationAcceptanceProposal(payload);
  const acceptance = input.acceptance ?? (Object.keys(proposal).length > 0 ? proposal : undefined);
  if (
    existing?.source === 'agent-review' &&
    existing.status === input.status &&
    existing.reason === input.reason &&
    review?.submittedBy === input.submittedBy &&
    review.round === input.round &&
    review.reviewer === input.reviewer &&
    review.grade === input.grade &&
    // Order-insensitive: the stored side came back through jsonb, which reorders keys.
    isDeepStrictEqual(existing.evidence?.acceptance ?? null, acceptance ?? null)
  ) {
    return existing;
  }
  return createImplementationReadiness({
    status: input.status,
    source: 'agent-review',
    reason: input.reason,
    evidence: {
      review: {
        submittedBy: input.submittedBy,
        round: input.round,
        ...(input.reviewer ? { reviewer: input.reviewer } : {}),
        ...(input.grade == null ? {} : { grade: input.grade }),
      },
      ...(acceptance ? { acceptance } : {}),
    },
  });
}

/**
 * Approval is the independent-review authority (R-20). It seals the producer's
 * proposal into a qualifying contract bound to the revision the reviewer judged;
 * an incomplete proposal is NOT defaulted — the approval stays a bare `ready`
 * that the intake-stage derivation keeps in intake (R-4).
 */
export function approvalAcceptance(
  workItem: Pick<WorkItem, 'kind' | 'title' | 'summary' | 'payload'>,
  input: { reviewer: string; submittedBy: string; round: number; grade: number },
): ImplementationAcceptanceContract | undefined {
  const authority = {
    kind: 'agent-review',
    reviewer: input.reviewer,
    submittedBy: input.submittedBy,
    round: input.round,
  } as const;
  const reason = `agent-review-approved (grade ${input.grade}/5)`;
  const source = { kind: workItem.kind, title: workItem.title, summary: workItem.summary ?? null };
  // Convergence: a retried approval of the same round must not re-seal (a fresh
  // acceptedAt would rewrite readiness on every retry). Reuse the standing contract
  // when it is still qualifying for this exact authority, grade and revision.
  const standing = evaluateImplementationAcceptance(workItem.payload, source);
  if (
    standing.state === 'qualifying' &&
    standing.contract?.reason === reason &&
    isDeepStrictEqual(standing.contract.authority, authority)
  ) {
    return standing.contract;
  }
  const sealed = sealImplementationAcceptance({
    proposal: readImplementationAcceptanceProposal(workItem.payload),
    authority,
    reason,
    source,
    // P-006 (D-019): the seal is the one verification stage. A bug is accepted only
    // with its reproduction receipt — the born-verified filing receipt (D-024) or the
    // one recorded at intake (D-023); without one the approval stays a bare `ready`.
    reproduction: workItem.kind === 'bug' ? approvalReproduction(workItem.payload) : undefined,
  });
  return sealed.ok ? sealed.contract : undefined;
}

function approvalReproduction(payload: unknown): unknown {
  const intake = record(record(payload).intakeReproduction);
  // D-006: a validator's receipt is recorded BECAUSE the earlier one was refused on the
  // current build, so it must outrank a born-verified filing receipt. Preferring the filing
  // receipt here would re-verify the stale receipt every round and refuse forever.
  if (intake.origin === 'validation' && intake.receipt) return intake.receipt;
  const bornVerified = readBornVerifiedReproduction(payload);
  if (bornVerified) return bornVerified;
  return intake.receipt;
}

/**
 * Parse a receipt a validator supplies on resubmit (D-006). `encounter` is a FILING-time
 * kind (D-024) and is refused here: validation means reproducing on the current build.
 */
function parseValidationReceipt(raw: unknown):
  | { ok: true; receipt: BugReproductionReceipt }
  | { ok: false; reason: string } {
  const parsed = parseBugReproductionReceipt(raw);
  if (!parsed.ok) return { ok: false, reason: `validation-receipt-invalid: ${parsed.error}` };
  if (parsed.receipt.kind === 'encounter') {
    return {
      ok: false,
      reason:
        'validation-receipt-invalid: encounter is a filing-time receipt; validation needs failing-test, scripted-repro or current-build-observation',
    };
  }
  return { ok: true, receipt: parsed.receipt };
}

export interface EnterAgentReviewInput {
  id: string;
  submittedBy: string;
  harnessSlug?: string;
  workspaceId?: string;
}

export async function enterAgentReview(
  input: EnterAgentReviewInput,
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ entered: boolean; state?: AgentReviewState; reason?: string }> {
  const found = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!found) return { entered: false, reason: 'not-found' };
  const workItem = await healOwnNodeRemoteOrigin(found, deps, input);
  const eligibility = agentReviewEligibility(workItem);
  if (!eligibility.eligible) return { entered: false, reason: eligibility.reason };

  const existing = readAgentReviewState(workItem.payload);
  if (existing?.status === 'approved') return { entered: false, state: existing, reason: 'already-approved' };
  const ledgerIdeaId = existing?.ledgerIdeaId ?? await deps.resolveLedgerIdeaId(workItem.id);
  const next: AgentReviewState = existing?.status === 'pending'
    ? existing
    : {
        status: 'pending',
        submittedBy: existing?.submittedBy ?? input.submittedBy,
        ledgerIdeaId,
        round: existing ? existing.round + 1 : 1,
        timing: { round: existing ? existing.round + 1 : 1, enteredAt: new Date().toISOString() },
      };

  const harnessSlug = input.harnessSlug ?? workItem.harness;
  if (!harnessSlug) throw new Error(`enterAgentReview: work item '${workItem.id}' has no harness`);
  await deps.recordRoutedIdea({
    ideaId: next.ledgerIdeaId,
    lens: 'agent-review',
    rail: 'improvement',
    routedRef: `wi:${workItem.id}`,
    harnessSlug,
    title: workItem.title,
    origin: 'agent-review',
    createdBy: next.submittedBy,
    preserveExisting: true,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  const merged = await deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      implementationReadiness: reviewImplementationReadiness(workItem.payload, {
        status: 'unknown',
        reason: 'awaiting-agent-review',
        submittedBy: next.submittedBy,
        round: next.round,
      }),
    },
    {
      harness: harnessSlug,
      unset: ['needsHuman', 'needsOwnerAction'],
    },
  );
  if (!merged) throw new Error(`enterAgentReview: work item '${workItem.id}' disappeared during enrollment`);
  if (workItem.assignee) {
    const released = await deps.releaseWorkItem(workItem.id, {
      harness: harnessSlug,
      expectedAssignee: workItem.assignee,
    });
    if (!released) throw new Error(`enterAgentReview: could not release submitter claim on '${workItem.id}'`);
  }
  return { entered: !existing || existing.status !== 'pending', state: next };
}

/**
 * Who a revision-requested row really belongs to. Shared by the resubmit path and the
 * adoption door (bug-queue-legitimacy D-008) so the authority proof is computed once.
 */
interface RevisionAuthority {
  legacySubmitter: string | null;
  signedSubmitter: string | null;
  effectiveSubmitter: string;
  isProvenanceRepair: boolean;
  submitterHolds: boolean;
}

async function resolveRevisionAuthority(
  workItem: WorkItem,
  current: AgentReviewState,
  deps: AgentReviewDeps,
): Promise<RevisionAuthority> {
  const legacySubmitter = readLegacySyntheticSubmitter(workItem, current);
  const signedSubmitter = current.status === 'revision-requested' && !legacySubmitter && current.submittedBy.startsWith('system:')
    ? await (deps.resolveVerifiedSubmitterAlias ?? resolveVerifiedSubmitterAlias)(current.submittedBy)
    : null;
  const effectiveSubmitter = legacySubmitter ?? signedSubmitter ?? current.submittedBy;
  return {
    legacySubmitter,
    signedSubmitter,
    effectiveSubmitter,
    isProvenanceRepair: legacySubmitter !== null || signedSubmitter !== null,
    submitterHolds: workItem.assignee === effectiveSubmitter ||
      (signedSubmitter !== null && workItem.assignee === current.submittedBy),
  };
}

export type OrphanAdoptionRefusal =
  | 'not-submitter'
  | 'not-submitter:authority-unknown'
  | 'not-submitter:liveness-unknown'
  | 'orphan-revision-held-by-other';

/**
 * The ORPHAN proof (WI-41689): may `caller` take a revision-requested row whose effective
 * submitter is someone else? Callers check `status === 'revision-requested'` and that the
 * caller is not the effective submitter first. Age, grade and a synthetic identity grant
 * nothing here; only a measured, non-blocking liveness verdict for a KNOWN submitter does.
 */
async function orphanAdoptionProof(
  workItem: WorkItem,
  current: AgentReviewState,
  authority: RevisionAuthority,
  caller: string,
  deps: AgentReviewDeps,
): Promise<{ ok: true; sessionState: SessionState } | { ok: false; reason: OrphanAdoptionRefusal }> {
  // A synthetic submitter whose real reporter cannot be recovered has no liveness to
  // measure: its authority is UNKNOWN, never presumed dead.
  if (authority.legacySubmitter === null && current.submittedBy.startsWith('system:') && authority.signedSubmitter === null) {
    return { ok: false, reason: 'not-submitter:authority-unknown' };
  }
  const verdict = await deps.resolveSubmitterLiveness(authority.effectiveSubmitter, {
    claimsHeld: authority.submitterHolds,
  });
  // FAIL CLOSED on an unmeasured verdict. `null` means the oracle had no signal, not
  // that the submitter is absent, and collapsing the two would quietly turn this into
  // "adopt whenever we cannot see the submitter" — a different, much weaker rule
  // wearing this one's clothes. A DISTINCT reason keeps that diagnosable instead of
  // indistinguishable from a live-submitter refusal.
  if (!verdict) return { ok: false, reason: 'not-submitter:liveness-unknown' };
  if ((REBIND_BLOCKING_SESSION_STATES as readonly SessionState[]).includes(verdict.sessionState)) {
    return { ok: false, reason: 'not-submitter' };
  }
  // The submitter is gone, but the ROW may still be someone else's: adopting it out from
  // under a third agent would trade this bug for a claim-steal. Unheld, held by the gone
  // submitter, or held by the caller are all adoptable; anything else is not ours to take.
  if (workItem.assignee != null && !authority.submitterHolds && workItem.assignee !== caller) {
    return { ok: false, reason: 'orphan-revision-held-by-other' };
  }
  return { ok: true, sessionState: verdict.sessionState };
}

export type AdoptAgentReviewReason =
  | OrphanAdoptionRefusal
  | 'not-found'
  | 'not-open'
  | 'not-agent-review'
  | `not-revision-requested:${string}`
  | 'reproduction-validation-route'
  | 'legacy-revision-claimable'
  | 'claim-refused'
  | 'state-changed';

/** What the adopter now holds: report revision, never implementation (D-008 ruling 5). */
export interface RevisionAdoptionBrief {
  lane: 'revision-adoption';
  round: number;
  previousSubmitter: string;
  next: string[];
}

export interface AdoptAgentReviewResult {
  adopted: boolean;
  workItem: WorkItem | null;
  state?: AgentReviewState;
  reason?: AdoptAgentReviewReason;
  /** The caller already was the effective submitter: claimed, nothing rebound. */
  alreadySubmitter?: boolean;
  brief?: RevisionAdoptionBrief;
}

function revisionAdoptionBrief(id: string, round: number, previousSubmitter: string): RevisionAdoptionBrief {
  return {
    lane: 'revision-adoption',
    round,
    previousSubmitter,
    next: [
      `Read round ${round}'s review feedback: work_items:get { id: '${id}' } (the review round comment).`,
      'Revise the report so it addresses that feedback (title, body, evidence) — this is report revision, not implementation; readiness stays not-ready.',
      `Resubmit for the next independent review: improvements:agent-review { mode:'resubmit', id: '${id}' }.`,
      'If revising shows the report is invalid or a duplicate, close it with that evidence instead of resubmitting.',
    ],
  };
}

/**
 * REVISION ADOPTION (bug-queue-legitimacy D-008). A content revision whose submitter is
 * provably gone is otherwise unclaimable forever: the intake-stage floor keeps
 * revision-requested rows off every ordinary claim door, and only resubmit could move
 * one. This claims ONE such row for `adopter` under exactly resubmit's orphan proof,
 * then rebinds the revision to the adopter, who revises and resubmits as its submitter.
 *
 * Order matters: the CAS claim lands first (a concurrent adopter loses there), the review
 * snapshot is re-verified after it (release + 'state-changed' on drift), and only then is
 * the payload rebound — so a refused caller never leaves a rebound row behind.
 */
export async function adoptAgentReviewRevision(
  input: { id: string; adopter: string; harnessSlug: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AdoptAgentReviewResult> {
  const workItem = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!workItem || workItem.harness !== input.harnessSlug) {
    return { adopted: false, workItem: null, reason: 'not-found' };
  }
  if (workItem.state !== 'open') return { adopted: false, workItem: null, reason: 'not-open' };
  const current = readAgentReviewState(workItem.payload);
  if (!current) return { adopted: false, workItem: null, reason: 'not-agent-review' };
  if (current.status !== 'revision-requested') {
    return { adopted: false, workItem: null, state: current, reason: `not-revision-requested:${current.status}` };
  }
  // Reproduction-only revisions are validation work the ordinary claim doors already
  // admit (D-006); legacy-seeded revisions are released to normal implementation.
  if (current.revisionKind === 'reproduction') {
    return { adopted: false, workItem: null, state: current, reason: 'reproduction-validation-route' };
  }
  if (current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER) {
    return { adopted: false, workItem: null, state: current, reason: 'legacy-revision-claimable' };
  }
  const authority = await resolveRevisionAuthority(workItem, current, deps);
  const alreadySubmitter = authority.effectiveSubmitter === input.adopter;
  let sessionState: SessionState | null = null;
  if (!alreadySubmitter) {
    const proof = await orphanAdoptionProof(workItem, current, authority, input.adopter, deps);
    if (!proof.ok) return { adopted: false, workItem: null, state: current, reason: proof.reason };
    sessionState = proof.sessionState;
  }
  if (workItem.assignee !== input.adopter) {
    // Replace a holder only when the proof above established it is the gone submitter;
    // an unheld row needs no expected holder. Anything else fails the CAS.
    const goneHolder = !alreadySubmitter && workItem.assignee != null && authority.submitterHolds
      ? workItem.assignee
      : null;
    // The issue intake floor admits a revision-requested row only for its CURRENT payload
    // submitter, and the rebind below happens after this claim. Without this admission the
    // shared writer refuses every adoption (measured: adopt-next 0/25, 16 claim-refused).
    // Keyed on the payload submitter, not alreadySubmitter: an effective submitter behind
    // a synthetic payload submitter is also not the payload submitter.
    const revisionAdoptionAdmission = current.submittedBy !== input.adopter
      ? mintAgentReviewRevisionAdoptionAdmission({
          itemId: workItem.id,
          adopter: input.adopter,
          harnessSlug: input.harnessSlug,
          review: current,
        })
      : null;
    const claimed = await deps.claimWorkItem(workItem.id, input.adopter, {
      harness: input.harnessSlug,
      ...(goneHolder ? { expectedAssignee: goneHolder } : {}),
      ...(revisionAdoptionAdmission ? { revisionAdoptionAdmission } : {}),
    });
    if (!claimed) return { adopted: false, workItem: null, state: current, reason: 'claim-refused' };
  }
  const after = await deps.getWorkItem(workItem.id, input.harnessSlug);
  const afterReview = after ? readAgentReviewState(after.payload) : null;
  if (
    !after || after.assignee !== input.adopter || !afterReview ||
    afterReview.status !== 'revision-requested' ||
    afterReview.round !== current.round ||
    afterReview.submittedBy !== current.submittedBy
  ) {
    if (after?.assignee === input.adopter && workItem.assignee !== input.adopter) {
      await deps.releaseWorkItem(workItem.id, { harness: input.harnessSlug, expectedAssignee: input.adopter });
    }
    return { adopted: false, workItem: null, state: afterReview ?? current, reason: 'state-changed' };
  }
  if (alreadySubmitter) {
    return {
      adopted: true,
      alreadySubmitter: true,
      workItem: after,
      state: afterReview,
      brief: revisionAdoptionBrief(workItem.id, current.round, current.submittedBy),
    };
  }
  const next: AgentReviewState = { ...afterReview, submittedBy: input.adopter };
  const merged = await deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      agentReviewAdoption: {
        from: current.submittedBy,
        effectiveSubmitter: authority.effectiveSubmitter,
        sessionState,
        round: current.round,
        adoptedBy: input.adopter,
        at: new Date().toISOString(),
      },
    },
    { harness: input.harnessSlug },
  );
  if (!merged) throw new Error(`adoptAgentReviewRevision: work item '${workItem.id}' disappeared`);
  await ensureComment(
    after,
    `Revision round ${current.round} adopted by ${input.adopter}: the original submitter ${authority.effectiveSubmitter} is ${sessionState} (orphan proof, D-008). The adopter revises this report and resubmits it for independent review.`,
    input.adopter,
    deps,
  );
  return {
    adopted: true,
    workItem: merged,
    state: next,
    brief: revisionAdoptionBrief(workItem.id, current.round, authority.effectiveSubmitter),
  };
}

export interface AdoptNextAgentReviewResult extends AdoptAgentReviewResult {
  /** Candidates examined, and why each one that was not adopted was refused. */
  scanned: number;
  refusals: Partial<Record<AdoptAgentReviewReason, number>>;
}

/** Payload key recording a STABLE adoption refusal for one review round (D-011 C). */
export const AGENT_REVIEW_ADOPTION_PROBE_KEY = 'agentReviewAdoptionProbe';

/** How long a stable refusal keeps a row out of the adopt-next window before it is re-probed. */
export const AGENT_REVIEW_ADOPTION_PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Refusals that cannot change while the review round stays the same, so re-measuring them on
 * every scan only re-proves the answer (D-011 C). `authority-unknown` is a synthetic submitter
 * with no recoverable reporter; `liveness-unknown` is a submitter the oracle has no signal for.
 * The 24h TTL bounds the second: an oracle that later learns the submitter re-qualifies the row.
 * Every OTHER refusal (a live submitter, a third-party holder, a lost CAS, a drifted snapshot)
 * is transient and records nothing.
 */
const STABLE_ADOPTION_REFUSALS: ReadonlySet<AdoptAgentReviewReason> = new Set([
  'not-submitter:authority-unknown',
  'not-submitter:liveness-unknown',
]);

/**
 * Queue-order discovery for {@link adoptAgentReviewRevision}: oldest adoptable content
 * revision first, in one concrete harness, bounded to 25 candidates per call. Submitter
 * liveness is an oracle verdict, not a SQL fact, so it is measured per candidate here
 * rather than approximated in the query (an age proxy is exactly what D-008 forbids).
 *
 * `filter` scopes discovery to a claim spec's `view.filter` (D-011 B: the scheduler's
 * `revisionAdoption:'first'` leg), compiled into the SQL and re-checked on the fetched row,
 * the verifier lane's pattern. CONVERGENCE (D-011 C): the window is the 25 OLDEST candidates,
 * so a run of rows that can never be adopted at the head of the queue would pin it forever
 * and stop all adoption once the adoptable head was consumed. A stable refusal therefore
 * stamps the row, and the query skips a row stamped for the SAME round within the TTL.
 */
export async function adoptNextAgentReviewRevision(
  input: { adopter: string; harnessSlug: string; workspaceId?: string; filter?: FilterNode; signal?: AbortSignal },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AdoptNextAgentReviewResult> {
  input.signal?.throwIfAborted();
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  // ISO-8601 from toISOString() sorts lexicographically, so the cutoff compares as TEXT. A
  // timestamptz cast would throw on a malformed stamp and take the whole scan down with it.
  const probeCutoff = new Date(Date.now() - AGENT_REVIEW_ADOPTION_PROBE_TTL_MS).toISOString();
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${ws}
       AND harness_slug = ${input.harnessSlug}
       AND status = 'open'
       AND item_kind IN ('bug', 'change', 'task', 'feature')
       AND ${depsBlockedExclusionSql(sql)}
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'status' = 'revision-requested'
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'revisionKind' IS DISTINCT FROM 'reproduction'
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM ${LEGACY_AGENT_REVIEW_SUBMITTER}
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM ${input.adopter}
       -- COALESCE(..., false): an absent probe yields NULL, and NOT NULL would drop the row.
       AND NOT COALESCE((
         COALESCE(payload, '{}'::jsonb) -> ${AGENT_REVIEW_ADOPTION_PROBE_KEY} ->> 'round'
           = COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'round'
         AND COALESCE(payload, '{}'::jsonb) -> ${AGENT_REVIEW_ADOPTION_PROBE_KEY} ->> 'at' >= ${probeCutoff}
       ), false)
       AND ${compileFilter(sql, input.filter)}
     ORDER BY created_ts ASC
     LIMIT 25`;
  const refusals: Partial<Record<AdoptAgentReviewReason, number>> = {};
  let scanned = 0;
  for (const row of rows) {
    input.signal?.throwIfAborted();
    scanned += 1;
    if (input.filter) {
      const found = await deps.getWorkItem(row.feature_id, input.harnessSlug);
      if (!found || !matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(found), input.filter)) continue;
    }
    const result = await adoptAgentReviewRevision(
      { id: row.feature_id, adopter: input.adopter, harnessSlug: input.harnessSlug },
      deps,
    );
    if (result.adopted) return { ...result, scanned, refusals };
    if (result.reason) refusals[result.reason] = (refusals[result.reason] ?? 0) + 1;
    if (result.reason && STABLE_ADOPTION_REFUSALS.has(result.reason) && result.state) {
      await recordAdoptionProbe(row.feature_id, input.harnessSlug, result.reason, result.state.round, deps);
    }
  }
  return { adopted: false, workItem: null, scanned, refusals };
}

/**
 * Stamp a stable refusal so the next scan's window moves past this row (D-011 C).
 * Best-effort by design: a failed stamp costs one wasted re-probe on the next scan, never the
 * scan itself, so it must not turn a refusal into an error for the caller.
 */
async function recordAdoptionProbe(
  id: string,
  harnessSlug: string,
  reason: AdoptAgentReviewReason,
  round: number,
  deps: AgentReviewDeps,
): Promise<void> {
  try {
    await deps.mergeWorkItemPayload(
      id,
      { [AGENT_REVIEW_ADOPTION_PROBE_KEY]: { reason, round, at: new Date().toISOString() } },
      { harness: harnessSlug },
    );
  } catch {
    /* best-effort: the row is re-probed on the next scan */
  }
}

export async function resubmitAgentReview(
  input: {
    id: string;
    submittedBy: string;
    /**
     * D-006 (P-002 Left#1): the current-build reproduction receipt a validator obtained
     * `{ kind, ref, buildSha }`. Accepted ONLY on a bug whose revision was requested for its
     * reproduction receipt; recorded on the row in the same write that resubmits it, and
     * verified against the current build by the next review round — never by this call.
     */
    reproduction?: unknown;
  },
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ resubmitted: boolean; state?: AgentReviewState; reason?: string }> {
  const workItem = await deps.getWorkItem(input.id);
  if (!workItem) return { resubmitted: false, reason: 'not-found' };
  const current = readAgentReviewState(workItem.payload);
  if (!current) return { resubmitted: false, reason: 'not-agent-review' };
  let suppliedReceipt: BugReproductionReceipt | null = null;
  if (input.reproduction !== undefined) {
    if (workItem.kind !== 'bug' || current.status !== 'revision-requested' || current.revisionKind !== 'reproduction') {
      return { resubmitted: false, state: current, reason: 'reproduction-not-applicable' };
    }
    const parsed = parseValidationReceipt(input.reproduction);
    if (!parsed.ok) return { resubmitted: false, state: current, reason: parsed.reason };
    suppliedReceipt = parsed.receipt;
  }
  const authority = await resolveRevisionAuthority(workItem, current, deps);
  const { effectiveSubmitter, isProvenanceRepair, submitterHolds } = authority;
  const isLegacyRebind = current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER;
  if (isLegacyRebind && workItem.assignee !== input.submittedBy) {
    return { resubmitted: false, state: current, reason: 'legacy-revision-not-claimant' };
  }
  // VALIDATION REBIND (bug-queue-legitimacy D-006/D-007). A revision requested ONLY for a
  // missing/unaccepted reproduction receipt is admitted to ordinary claimers by the intake
  // floor, so — like a legacy rebind — its CLAIMANT may resubmit it without proving the
  // original submitter gone. Anyone else falls through to the submitter/orphan path below,
  // so the holder fence is unchanged. Resubmitting with no receipt on the row would only buy
  // another review round that refuses for the same reason, so that is refused up front;
  // whether the receipt VERIFIES on the current build stays the reviewer round's job.
  const isValidationRebind = !isLegacyRebind &&
    current.status === 'revision-requested' &&
    current.revisionKind === 'reproduction' &&
    effectiveSubmitter !== input.submittedBy &&
    workItem.assignee === input.submittedBy;
  if (isValidationRebind && !suppliedReceipt && !readBugReproductionReceipt(approvalReproduction(workItem.payload))) {
    return { resubmitted: false, state: current, reason: 'validation-receipt-missing' };
  }
  // ORPHAN REBIND (WI-41689). A 'revision-requested' row can only leave that state through
  // this function, and until now only its ORIGINAL submitter could call it. That submitter
  // is routinely gone by review time — a session that filed a report hours earlier is
  // reaped — which left the row excluded from the claim floor by
  // `agentReviewPendingSelectorSql` with nobody alive able to release it. Permanently
  // unclaimable, and invisible as a blocker.
  //
  // So: when the original submitter is PROVABLY gone, another agent may adopt the row.
  // "Provably" is doing real work in that sentence — see orphanAdoptionProof, which the
  // adoption door (adoptAgentReviewRevision, D-008) shares so the two cannot drift.
  let isOrphanRebind = false;
  if (!isLegacyRebind && !isValidationRebind && effectiveSubmitter !== input.submittedBy) {
    // A row that is not resubmittable anyway refuses on identity exactly as before,
    // rather than spending an oracle read to reach the same answer by a new name.
    if (current.status !== 'revision-requested') {
      return { resubmitted: false, state: current, reason: 'not-submitter' };
    }
    const proof = await orphanAdoptionProof(workItem, current, authority, input.submittedBy, deps);
    if (!proof.ok) return { resubmitted: false, state: current, reason: proof.reason };
    isOrphanRebind = true;
  }
  // A provenance-checked legacy service row can be repaired by its real reporter without
  // going through the orphan branch above. Keep the same holder fence here, before the
  // payload write, so a reporter cannot rebind a synthetic row held by a third party.
  if (
    isProvenanceRepair &&
    workItem.assignee != null &&
    !submitterHolds &&
    workItem.assignee !== input.submittedBy
  ) {
    return { resubmitted: false, state: current, reason: 'orphan-revision-held-by-other' };
  }
  if (current.status !== 'revision-requested') {
    return { resubmitted: false, state: current, reason: `not-revision-requested:${current.status}` };
  }
  // A pending round carries no revision kind; the next grade stamps a fresh one.
  const {
    revisionKind: _resolvedRevisionKind,
    reviewedSourceRevision: _previousReviewedSourceRevision,
    ...currentWithoutKind
  } = current;
  const next: AgentReviewState = {
    ...currentWithoutKind,
    status: 'pending',
    submittedBy: isLegacyRebind || isOrphanRebind || isProvenanceRepair || isValidationRebind
      ? input.submittedBy
      : current.submittedBy,
    round: current.round + 1,
    timing: { round: current.round + 1, enteredAt: new Date().toISOString() },
  };
  // Clear the prior reviewer verdict before publishing the new pending round. If this write
  // fails, leave the item revision-requested rather than admitting a round that can replay stale
  // feedback. The comment history is the durable record of the prior grade.
  await (deps.clearLedgerGrade ?? clearLedgerGrade)(current.ledgerIdeaId, workItem.id);
  const merged = await deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      // Recorded only after every identity/holder fence above passed, in the same write
      // as the resubmit, so a refused caller never leaves a receipt behind.
      ...(suppliedReceipt
        ? {
            intakeReproduction: {
              schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION,
              receipt: suppliedReceipt,
              origin: 'validation',
              decidedBy: input.submittedBy,
              recordedAt: new Date().toISOString(),
            } satisfies IntakeReproductionRecord,
          }
        : {}),
      implementationReadiness: reviewImplementationReadiness(workItem.payload, {
        status: 'unknown',
        reason: 'agent-review-resubmitted',
        submittedBy: next.submittedBy,
        round: next.round,
      }),
    },
    {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      unset: ['needsHuman', 'needsOwnerAction'],
    },
  );
  if (!merged) throw new Error(`resubmitAgentReview: work item '${workItem.id}' disappeared`);
  if (workItem.assignee) {
    // `expectedAssignee` is a CAS (work-items.ts: `taken_by IS NULL OR taken_by =
    // expectedAssignee`), so it must name the CURRENT holder, not the caller. On an orphan
    // rebind the holder is the gone submitter — passing the caller here would match zero
    // rows and throw "held by another agent" about a row whose only holder is a dead
    // session, re-stranding exactly the case this branch exists to rescue. The guard above
    // has already established the holder is adoptable.
    const released = await deps.releaseWorkItem(workItem.id, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      expectedAssignee: isOrphanRebind || isProvenanceRepair ? workItem.assignee : input.submittedBy,
    });
    if (!released) throw new Error(`resubmitAgentReview: '${workItem.id}' is held by another agent`);
  }
  return { resubmitted: true, state: next };
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Triage writers that enrolled review under their own `by` label instead of the reporter.
 * triage-core passed `submittedBy: by` until 0be339d360 (2026-10-10) switched it to
 * `effectiveReporter(issue).id ?? by`; rows enrolled before then still carry the label.
 * 'improvement-retriage' is the retriage-all batch pass (agent-tools/improvements/triage.ts),
 * which writes the same triaged/gate lifecycle markers as 'improvement-triage'
 * (bug-queue-legitimacy D-008 residue: 243 open revision rows carried it on 2026-10-11).
 */
const LEGACY_TRIAGE_SUBMITTERS: ReadonlySet<string> = new Set(['improvement-triage', 'improvement-retriage', 'Queen']);

/**
 * Recover the reporter on rows enrolled by known service writers. Their own persisted
 * routing markers must prove the enrollment, and creation/reporter identities must
 * agree. This only selects whose liveness to measure; it does not authorize adoption.
 * Other synthetic identities, missing markers and non-agent reporters stay unknown.
 */
function readLegacySyntheticSubmitter(workItem: WorkItem, current: AgentReviewState): string | null {
  const payload = record(workItem.payload);
  const dated = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (current.submittedBy === STRANDED_SWEEP_OWNER) {
    const marker = record(payload.strandedToolFailureSweep);
    if (marker.owner !== STRANDED_SWEEP_OWNER || marker.outcome !== 'review' || !dated(marker.at)) return null;
  } else if (LEGACY_TRIAGE_SUBMITTERS.has(current.submittedBy)) {
    const lifecycle = record(payload.ideaLifecycle);
    const screen = record(payload.deploymentStalenessScreen);
    const reviewedPlace = lifecycle.triageDecision === 'place' && screen.screened === true &&
      screen.state === 'unknown' && screen.divert === false && dated(screen.at);
    if (lifecycle.state !== 'triaged' || !dated(lifecycle.triagedAt) ||
      (lifecycle.triageDecision !== 'gate' && !reviewedPlace)) return null;
  } else {
    return null;
  }

  const createdBy = workItem.createdBy;
  if (!createdBy || record(payload._ei).created_by !== createdBy) return null;
  const stamped = storedReporter(payload);
  if (payload.reporter != null && !stamped) return null;
  const reporter = stamped ?? effectiveReporter(workItem);
  if (reporter.kind !== 'agent' || reporter.id !== createdBy) return null;
  return createdBy;
}

export interface AgentReviewGradePreflight {
  applicable: boolean;
  workItemId?: string;
  state?: AgentReviewState;
  /** True only when an exact repeated critique needed and received explicit justification. */
  repeatJustificationAccepted?: boolean;
  refusal?:
    | 'agent-review-feedback-required'
    | 'agent-review-not-pending'
    | 'agent-review-source-revision-unbound'
    | 'agent-review-source-revision-stale'
    | 'agent-review-reviewer-mismatch'
    | 'agent-review-repeat-feedback-justification-required';
}

interface PriorAgentReviewGrade {
  reviewer: string;
  grade: number;
  feedback: string;
  reviewedSourceRevision?: string;
}

/**
 * Read the immediately prior revision-requested round from the durable round comment.
 * The versioned marker already records the claimed source revision, reviewer and grade;
 * older markers predate the explicit feedback field, so recover it from their comment body.
 */
async function readPriorAgentReviewGrade(
  workItem: WorkItem,
  current: AgentReviewState,
  deps: AgentReviewDeps,
): Promise<PriorAgentReviewGrade | null> {
  if (current.round <= 1) return null;
  const detail = await deps.getWorkItemDetail(workItem.id, workItem.harness ?? undefined);
  const posts = record(detail).posts;
  if (!Array.isArray(posts)) return null;
  let prior: PriorAgentReviewGrade | null = null;
  for (const rawPost of posts) {
    const post = record(rawPost);
    const body = typeof post.body === 'string' ? post.body : '';
    const markerAt = body.indexOf(AGENT_REVIEW_ROUND_COMMENT_MARKER);
    if (markerAt < 0) continue;
    try {
      const snapshot = record(JSON.parse(body.slice(markerAt + AGENT_REVIEW_ROUND_COMMENT_MARKER.length)));
      const review = readAgentReviewState({ agentReview: snapshot.review });
      const author = post.author_id ?? post.authorId ?? post.author;
      if (
        snapshot.id !== workItem.id || (snapshot.harness ?? null) !== (workItem.harness ?? null) ||
        !review || review.status !== 'revision-requested' || review.round !== current.round - 1 ||
        snapshot.reviewer !== author || typeof snapshot.reviewer !== 'string' ||
        typeof snapshot.grade !== 'number' || !Number.isSafeInteger(snapshot.grade) ||
        snapshot.grade < 1 || snapshot.grade > AGENT_REVIEW_MAX_REVISION_GRADE
      ) continue;
      const summary = body.slice(0, markerAt);
      const prefix = `Agent review round ${review.round}: revision requested by ${snapshot.reviewer} (grade ${snapshot.grade}/5).\n\n`;
      const feedback = typeof snapshot.feedback === 'string'
        ? snapshot.feedback
        : summary.startsWith(prefix) ? summary.slice(prefix.length) : null;
      if (feedback === null) continue;
      prior = {
        reviewer: snapshot.reviewer,
        grade: snapshot.grade,
        feedback,
        ...(review.reviewedSourceRevision ? { reviewedSourceRevision: review.reviewedSourceRevision } : {}),
      };
    } catch {
      // A malformed history post is not evidence for a repeated critique.
    }
  }
  return prior;
}

export async function preflightAgentReviewGrade(
  input: { ideaId: string; grade: number; gradedBy: string; feedback?: string; repeatJustification?: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<AgentReviewGradePreflight> {
  const ledger = await deps.readLedgerGrade(input.ideaId);
  if (!ledger) return { applicable: false };
  const workItem = await deps.getWorkItem(ledger.workItemId);
  const state = workItem ? readAgentReviewState(workItem.payload) : null;
  if (!state || state.ledgerIdeaId !== input.ideaId) return { applicable: false };
  if (state.status !== 'pending') {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-not-pending' };
  }
  if (!state.reviewedSourceRevision) {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-source-revision-unbound' };
  }
  if (workItem!.assignee !== input.gradedBy) {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-reviewer-mismatch' };
  }
  if (acceptanceSourceRevision(workItem!) !== state.reviewedSourceRevision) {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-source-revision-stale' };
  }
  const feedback = input.feedback?.trim() ?? '';
  if (input.grade <= AGENT_REVIEW_MAX_REVISION_GRADE && !feedback) {
    return { applicable: true, workItemId: workItem!.id, state, refusal: 'agent-review-feedback-required' };
  }
  let repeatJustificationAccepted = false;
  if (input.grade <= AGENT_REVIEW_MAX_REVISION_GRADE) {
    const prior = await readPriorAgentReviewGrade(workItem!, state, deps);
    if (
      prior && prior.reviewer === input.gradedBy && prior.feedback.trim() === feedback &&
      (!prior.reviewedSourceRevision || prior.reviewedSourceRevision !== state.reviewedSourceRevision)
    ) {
      if (!input.repeatJustification?.trim()) {
        return {
          applicable: true,
          workItemId: workItem!.id,
          state,
          refusal: 'agent-review-repeat-feedback-justification-required',
        };
      }
      repeatJustificationAccepted = true;
    }
  }
  return {
    applicable: true,
    workItemId: workItem!.id,
    state,
    ...(repeatJustificationAccepted ? { repeatJustificationAccepted: true } : {}),
  };
}

function revisionComment(round: number, grade: number, feedback: string, gradedBy: string, repeatJustification?: string): string {
  const summary = `Agent review round ${round}: revision requested by ${gradedBy} (grade ${grade}/5).\n\n${feedback}`;
  return repeatJustification
    ? `${summary}\n\nRepeat justification: ${repeatJustification}`
    : summary;
}

function approvalComment(round: number, grade: number, gradedBy: string): string {
  return `Agent review round ${round}: approved by ${gradedBy} (grade ${grade}/5). Implementation is re-admitted; this approval does not close the work item.`;
}

async function ensureComment(
  workItem: WorkItem,
  body: string,
  author: string,
  deps: AgentReviewDeps,
): Promise<boolean> {
  const detail = await deps.getWorkItemDetail(workItem.id, workItem.harness ?? undefined);
  if (detail?.posts.some((post) => post.body === body)) return false;
  const written = await deps.commentWorkItem(
    workItem.id,
    body,
    author,
    workItem.harness ? { harness: workItem.harness } : {},
  );
  if (!written) throw new Error(`agent review could not persist round history on '${workItem.id}'`);
  return true;
}

export interface AgentReviewReconcileOutcome {
  workItemId: string;
  status: 'revision-requested' | 'approved';
  round: number;
  changed: boolean;
  woken?: number;
  /** Per-operation wall-clock measurements for the grade→review reconciliation seam. */
  diagnostics?: AgentReviewReconcileDiagnostics;
  /** Whether the row ended up held by its effective submitter. */
  returnedToSubmitter?: boolean;
  /** True when an un-actionable submitter left the existing reviewer claim in place. */
  reviewerRetained?: boolean;
}

export type AgentReviewReconcilePhase =
  | 'readLedgerGrade'
  | 'getWorkItem'
  | 'resolveVerifiedSubmitterAlias'
  | 'resolveSubmitterLiveness'
  | 'mergeWorkItemPayload'
  | 'ensureComment'
  | 'transferClaim'
  | 'releaseClaim'
  | 'verifyReproduction'
  | 'deliverRevision';

export interface AgentReviewReconcileDiagnostics {
  schemaVersion: 'agent-review-grade-reconcile-v1';
  unit: 'ms';
  elapsedMs: number;
  phases: Partial<Record<AgentReviewReconcilePhase, { startedAt: string; elapsedMs: number; status: 'in-progress' | 'ok' | 'error' }>>;
}

export async function reconcileAgentReviewGrade(
  input: { ideaId: string; gradedBy: string; repeatJustification?: string },
  deps: AgentReviewDeps = defaultDeps,
  options: { onDiagnostics?: (diagnostics: AgentReviewReconcileDiagnostics) => void } = {},
): Promise<AgentReviewReconcileOutcome | null> {
  const diagnostics: AgentReviewReconcileDiagnostics | null = options.onDiagnostics
    ? { schemaVersion: 'agent-review-grade-reconcile-v1', unit: 'ms', elapsedMs: 0, phases: {} }
    : null;
  const overallStartedAt = diagnostics ? performance.now() : 0;
  const measure = async <T>(
    phase: AgentReviewReconcilePhase,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (!diagnostics) return action();
    const startedAt = performance.now();
    const startedAtIso = new Date().toISOString();
    let status: 'ok' | 'error' = 'error';
    diagnostics.phases[phase] = { startedAt: startedAtIso, elapsedMs: 0, status: 'in-progress' };
    try { options.onDiagnostics?.({ ...diagnostics, phases: { ...diagnostics.phases } }); } catch { /* Never affect reconciliation. */ }
    try {
      const result = await action();
      status = 'ok';
      return result;
    } finally {
      diagnostics.phases[phase] = { startedAt: startedAtIso, elapsedMs: Math.max(0, performance.now() - startedAt), status };
      diagnostics.elapsedMs = Math.max(0, performance.now() - overallStartedAt);
      try { options.onDiagnostics?.({ ...diagnostics, phases: { ...diagnostics.phases } }); } catch { /* Never affect reconciliation. */ }
    }
  };
  const withDiagnostics = <T extends AgentReviewReconcileOutcome>(outcome: T): T => {
    if (!diagnostics) return outcome;
    diagnostics.elapsedMs = Math.max(0, performance.now() - overallStartedAt);
    try { options.onDiagnostics?.({ ...diagnostics, phases: { ...diagnostics.phases } }); } catch { /* Never affect reconciliation. */ }
    return { ...outcome, diagnostics: { ...diagnostics, phases: { ...diagnostics.phases } } };
  };
  const ledger = await measure('readLedgerGrade', () => deps.readLedgerGrade(input.ideaId));
  if (!ledger) return null;
  const workItem = await measure('getWorkItem', () => deps.getWorkItem(ledger.workItemId));
  if (!workItem) return null;
  const current = readAgentReviewState(workItem.payload);
  if (!current || current.ledgerIdeaId !== input.ideaId) return null;
  if (ledger.grade == null) throw new Error(`agent review ledger '${input.ideaId}' has no standing grade`);

  const grade = ledger.grade;
  // `gradedBy` is ATTRIBUTION only (comments, the revision notice). The ledger's standing
  // grade may be authored by someone who never held the work item — an owner-sovereign grade
  // on a pre-existing su-ideate row that agent review enrolled with `preserveExisting`
  // (EI-24720168531118378, EI-21887295701926471). Every CAS release/transfer below therefore
  // targets the CURRENT claim holder (`workItem.assignee`), never `ledger.gradedBy`: releasing
  // with `expectedAssignee:'owner'` against a row held by the reviewer session always lost the
  // CAS, threw 'could not release reviewer claim' AFTER the approval payload had committed,
  // and the row stayed held until a manual `work_items:release`.
  const gradedBy = ledger.gradedBy ?? input.gradedBy;
  if (grade <= AGENT_REVIEW_MAX_REVISION_GRADE) {
    const feedback = ledger.feedback?.trim();
    if (!feedback) throw new Error('agent-review-feedback-required');
    const next: AgentReviewState = {
      ...current,
      status: 'revision-requested',
      // D-006/D-007: a failed grade is a CONTENT revision — never validation work, even
      // when an earlier round of this row was refused only for its reproduction receipt.
      revisionKind: 'content',
      ...(current.timing ? { timing: {
        ...current.timing,
        decidedAt: current.status === 'revision-requested' ? current.timing.decidedAt : new Date().toISOString(),
      } } : {}),
    };
    const changed = current.status !== next.status;
    // The claim store can persist an ended session id as an assignee. Resolve signed
    // system identities to their verified submitter first, then measure that person's
    // liveness before the ledger-derived transition. An unverified system identity has no
    // revision target; a confirmed dead session must not be selected either. A thrown
    // oracle failure happens before any transition write, and an in-band unknown still
    // lets the claim store validate an ordinary submitter transfer.
    const submitterIsSynthetic = current.submittedBy.startsWith('system:');
    const revisionSubmitter = current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER
      ? null
      : submitterIsSynthetic
        ? await measure('resolveVerifiedSubmitterAlias', () =>
            (deps.resolveVerifiedSubmitterAlias ?? resolveVerifiedSubmitterAlias)(current.submittedBy))
        : current.submittedBy;
    const submitterLiveness = changed && revisionSubmitter
      ? await measure('resolveSubmitterLiveness', () => deps.resolveSubmitterLiveness(revisionSubmitter, {
          claimsHeld: workItem.assignee === revisionSubmitter ||
            (submitterIsSynthetic && workItem.assignee === current.submittedBy),
        }))
      : null;
    const submitterEnded = submitterLiveness?.sessionState === 'ended';
    const merged = await measure('mergeWorkItemPayload', () => deps.mergeWorkItemPayload(
      workItem.id,
      {
        agentReview: next,
        implementationReadiness: reviewImplementationReadiness(workItem.payload, {
          status: 'not-ready',
          reason: 'agent-review-revision-requested',
          submittedBy: current.submittedBy,
          reviewer: gradedBy,
          round: current.round,
          grade,
        }),
      },
      {
        ...(workItem.harness ? { harness: workItem.harness } : {}),
        unset: ['needsHuman', 'needsOwnerAction'],
      },
    ));
    if (!merged) throw new Error(`agent review could not persist revision state on '${workItem.id}'`);
    const repeatJustification = input.repeatJustification?.trim() || undefined;
    const commentAdded = await measure('ensureComment', () => ensureComment(
      workItem,
      agentReviewRoundComment(
        revisionComment(current.round, grade, feedback, gradedBy, repeatJustification),
        workItem,
        next,
        grade,
        gradedBy,
        { feedback, ...(repeatJustification ? { repeatJustification } : {}) },
      ),
      gradedBy,
      deps,
    ));
    if (current.submittedBy === LEGACY_AGENT_REVIEW_SUBMITTER) {
      const holder = workItem.assignee;
      if (changed && holder) {
        const released = await measure('releaseClaim', () => deps.releaseWorkItem(workItem.id, {
          ...(workItem.harness ? { harness: workItem.harness } : {}),
          expectedAssignee: holder,
        }));
        if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
      }
      return withDiagnostics({ workItemId: workItem.id, status: 'revision-requested', round: current.round, changed });
    }
    let returnedToSubmitter = revisionSubmitter !== null && workItem.assignee === revisionSubmitter;
    let reviewerRetained = false;
    if (changed) {
      const currentHolderIsSubmitter = workItem.assignee !== null && (
        workItem.assignee === current.submittedBy || workItem.assignee === revisionSubmitter
      );
      if (!revisionSubmitter || submitterEnded) {
        returnedToSubmitter = false;
        reviewerRetained = workItem.assignee !== null && !currentHolderIsSubmitter;
        if (workItem.assignee && currentHolderIsSubmitter) {
          // A prior partial transition may already have left the stale submitter holding
          // the row. Drop only that expected holder; when the reviewer holds it, preserve
          // the claim so they can apply the recorded verdict (for example, close an item
          // whose reported defect was already fixed).
          const expectedAssignee = workItem.assignee;
          await measure('releaseClaim', () => deps.releaseWorkItem(workItem.id, {
            ...(workItem.harness ? { harness: workItem.harness } : {}),
            expectedAssignee,
          }));
        }
      } else if (!returnedToSubmitter) {
        const transferred = await measure('transferClaim', () => deps.claimWorkItem(workItem.id, revisionSubmitter, {
          ...(workItem.harness ? { harness: workItem.harness } : {}),
          ...(workItem.assignee ? { fromHolder: workItem.assignee } : {}),
        }));
        returnedToSubmitter = Boolean(transferred);
        // If the expected transfer did not land, keep the current reviewer claim. The
        // grade and revision request are already durable, and the reviewer may need to
        // dispose of work that the submitter cannot revise.
        reviewerRetained = !transferred && workItem.assignee !== null && !currentHolderIsSubmitter;
      }
    }
    let woken: number | undefined;
    if ((changed || commentAdded) && revisionSubmitter && !submitterEnded && returnedToSubmitter) {
      woken = (await measure('deliverRevision', () => deps.deliverRevision({
        to: revisionSubmitter,
        workItemId: workItem.id,
        round: current.round,
        grade,
        feedback,
        gradedBy,
      }))).woken;
    }
    return withDiagnostics({
      workItemId: workItem.id,
      status: 'revision-requested',
      round: current.round,
      changed,
      returnedToSubmitter,
      ...(reviewerRetained ? { reviewerRetained: true } : {}),
      ...(woken === undefined ? {} : { woken }),
    });
  }

  const reproduction = workItem.kind === 'bug' ? readBugReproductionReceipt(approvalReproduction(workItem.payload)) : null;
  let reproductionRefusal: string | null = null;
  if (workItem.kind === 'bug') {
    if (!reproduction) reproductionRefusal = 'Record a current-build reproduction receipt before fixing this bug.';
    else {
      const verify = deps.verifyReproduction ?? (async (receipt: BugReproductionReceipt, item: WorkItem) => {
        const { currentIntakeTargetBuild, defaultReproductionLedgerDeps } = await import('../../attention/intake-promotion');
        return verifyCurrentBugReproductionReceipt(
          receipt, await currentIntakeTargetBuild(`harness:${item.harness ?? ''}`), defaultReproductionLedgerDeps(),
        );
      });
      const result = await measure('verifyReproduction', () => verify(reproduction, workItem));
      if (!isAcceptedReproductionStatus(result.status)) reproductionRefusal = result.detail;
    }
  }
  // D-006/D-007: the grade passed, so a refusal here is ONLY the reproduction receipt —
  // validation work the intake floor admits for the drain lane. An approval drops the kind.
  const { revisionKind: _priorRevisionKind, ...currentWithoutKind } = current;
  const next: AgentReviewState & { status: AgentReviewReconcileOutcome['status'] } = {
    ...currentWithoutKind,
    status: reproductionRefusal ? 'revision-requested' : 'approved',
    ...(reproductionRefusal ? { revisionKind: 'reproduction' as const } : {}),
    ...(current.timing ? { timing: {
      ...current.timing,
      decidedAt: current.status === (reproductionRefusal ? 'revision-requested' : 'approved')
        ? current.timing.decidedAt : new Date().toISOString(),
    } } : {}),
  };
  const changed = current.status !== next.status;
  const merged = await measure('mergeWorkItemPayload', () => deps.mergeWorkItemPayload(
    workItem.id,
    {
      agentReview: next,
      implementationReadiness: reviewImplementationReadiness(workItem.payload, {
        status: reproductionRefusal ? 'not-ready' : 'ready',
        reason: reproductionRefusal ? 'agent-review-revision-requested' : 'agent-review-approved',
        submittedBy: current.submittedBy,
        reviewer: gradedBy,
        round: current.round,
        grade,
        acceptance: reproductionRefusal ? undefined : approvalAcceptance(workItem, {
          reviewer: gradedBy,
          submittedBy: current.submittedBy,
          round: current.round,
          grade,
        }),
      }),
    },
    {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      unset: ['needsHuman', 'needsOwnerAction'],
    },
  ));
  if (!merged) throw new Error(`agent review could not persist approval state on '${workItem.id}'`);
  await measure('ensureComment', () => ensureComment(workItem,
    agentReviewRoundComment(reproductionRefusal
      ? `Agent review round ${current.round}: independent grade ${grade}/5 by ${gradedBy}; fixing remains gated. ${reproductionRefusal}`
      : approvalComment(current.round, grade, gradedBy), workItem, next, grade, gradedBy),
    gradedBy, deps));
  const reviewerHolder = workItem.assignee;
  if (reviewerHolder) {
    const released = await measure('releaseClaim', () => deps.releaseWorkItem(workItem.id, {
      ...(workItem.harness ? { harness: workItem.harness } : {}),
      expectedAssignee: reviewerHolder,
    }));
    if (!released) throw new Error(`agent review could not release reviewer claim on '${workItem.id}'`);
  }
  if (reproductionRefusal && changed && current.submittedBy !== LEGACY_AGENT_REVIEW_SUBMITTER) {
    await measure('deliverRevision', () => deps.deliverRevision({ to: current.submittedBy, workItemId: workItem.id, round: current.round, grade, feedback: reproductionRefusal, gradedBy }));
  }
  return withDiagnostics({ workItemId: workItem.id, status: next.status, round: current.round, changed });
}

export type ClaimAgentReviewReason =
  | 'not-found'
  | 'not-open'
  | 'not-review-kind'
  | 'remote-owned'
  | 'observation'
  | 'owner-capability'
  | 'agent-review-not-pending'
  | 'own-submission'
  /** P-007: the reviewer filed or reported the subject. */
  | 'reporter-conflict'
  /** P-007: the reviewer implemented the subject (terminal owner or a recorded implementer). */
  | 'implementer-conflict'
  | 'claim-conflict'
  | 'claim-not-claimable';

function conflictReason(role: VerificationConflictRole | null): ClaimAgentReviewReason | null {
  if (role === 'reporter') return 'reporter-conflict';
  if (role === 'implementer') return 'implementer-conflict';
  return null;
}

export interface ClaimAgentReviewResult {
  claimed: boolean;
  workItem: WorkItem | null;
  reason?: ClaimAgentReviewReason;
  claimConflict?: {
    workItemId: string;
    holder: string;
    source: 'work_items.assignee';
    assignedBy: string | null;
  };
}

/**
 * Directed reviewer pickup for one known work item.
 *
 * This is deliberately separate from claimNextAgentReview: a review request naming
 * WI-B must never consume older WI-A merely because WI-A sorts first in the shared
 * review queue. Identity remains caller-derived at the public door. The pre-claim
 * checks provide useful refusal reasons; the returned row is checked again after
 * claimWorkItem's CAS so a concurrent lifecycle transition cannot leave the reviewer
 * holding work that is no longer pending or is their own submission.
 */
export async function claimAgentReview(
  input: { id: string; reviewer: string; harnessSlug: string },
  deps: AgentReviewDeps = defaultDeps,
): Promise<ClaimAgentReviewResult> {
  let workItem = await deps.getWorkItem(input.id, input.harnessSlug);
  if (!workItem) {
    return { claimed: false, workItem: null, reason: 'not-found' };
  }

  // EI-26300262181842808: issue-family EI ids are workspace-unique, so getWorkItem
  // may resolve the canonical row from another harness even when the caller supplied
  // an ambient portal harness. Use the row's harness for all write-side admission and
  // healing; treating the resolved row's different harness as "not found" stranded
  // valid directed reviews behind a misleading scope mismatch.
  let resolvedHarness = workItem.harness ?? input.harnessSlug;
  workItem = await healOwnNodeRemoteOrigin(workItem, deps, { harnessSlug: resolvedHarness });
  resolvedHarness = workItem.harness ?? resolvedHarness;

  if (workItem.state !== 'open') {
    return { claimed: false, workItem: null, reason: 'not-open' };
  }
  const eligibility = agentReviewEligibility(workItem);
  if (!eligibility.eligible) {
    return { claimed: false, workItem: null, reason: eligibility.reason };
  }
  const current = readAgentReviewState(workItem.payload);
  if (current?.status !== 'pending') {
    return { claimed: false, workItem: null, reason: 'agent-review-not-pending' };
  }
  if (current.submittedBy === input.reviewer) {
    return { claimed: false, workItem: null, reason: 'own-submission' };
  }
  const parties = verificationParties(workItem);
  const conflict = conflictReason(verificationConflict(parties, input.reviewer));
  if (conflict) return { claimed: false, workItem: null, reason: conflict };

  const agentReviewAdmission = mintAgentReviewClaimAdmission({
    itemId: workItem.id,
    reviewer: input.reviewer,
    harnessSlug: resolvedHarness,
    review: current,
    source: workItem,
    parties,
  });
  if (!agentReviewAdmission) {
    return { claimed: false, workItem: null, reason: 'claim-not-claimable' };
  }

  const claimed = await deps.claimWorkItem(workItem.id, input.reviewer, {
    ...(resolvedHarness ? { harness: resolvedHarness } : {}),
    agentReviewAdmission,
  });
  if (!claimed) {
    const latest = await deps.getWorkItem(input.id, input.harnessSlug);
    if (!latest) {
      return { claimed: false, workItem: null, reason: 'not-found' };
    }
    if (latest.state !== 'open') {
      return { claimed: false, workItem: null, reason: 'not-open' };
    }
    const latestEligibility = agentReviewEligibility(latest);
    if (!latestEligibility.eligible) {
      return { claimed: false, workItem: null, reason: latestEligibility.reason };
    }
    const latestReview = readAgentReviewState(latest.payload);
    if (latestReview?.status !== 'pending') {
      return { claimed: false, workItem: null, reason: 'agent-review-not-pending' };
    }
    if (latestReview.submittedBy === input.reviewer) {
      return { claimed: false, workItem: null, reason: 'own-submission' };
    }
    const latestConflict = conflictReason(verificationConflict(verificationParties(latest), input.reviewer));
    if (latestConflict) return { claimed: false, workItem: null, reason: latestConflict };
    const holder = latest.assignee?.trim();
    if (holder && holder !== input.reviewer) {
      return {
        claimed: false,
        workItem: null,
        reason: 'claim-conflict',
        claimConflict: {
          workItemId: latest.id,
          holder,
          source: 'work_items.assignee',
          assignedBy: latest.assignedBy ?? null,
        },
      };
    }
    return { claimed: false, workItem: null, reason: 'claim-not-claimable' };
  }

  const claimedState = readAgentReviewState(claimed.payload);
  const postClaimReason: ClaimAgentReviewReason | null =
    claimedState?.status !== 'pending'
      ? 'agent-review-not-pending'
      : claimedState.submittedBy === input.reviewer
        ? 'own-submission'
        : conflictReason(verificationConflict(verificationParties(claimed), input.reviewer));
  if (postClaimReason) {
    const released = await deps.releaseWorkItem(claimed.id, {
      ...(claimed.harness ? { harness: claimed.harness } : {}),
      expectedAssignee: input.reviewer,
    });
    if (!released) {
      throw new Error(`claimAgentReview: could not release invalidated claim on '${claimed.id}'`);
    }
    return { claimed: false, workItem: null, reason: postClaimReason };
  }
  return { claimed: true, workItem: claimed };
}

interface VerificationPickupScope {
  filter?: FilterNode;
  workspaceId?: string;
  signal?: AbortSignal;
}

type VerificationClaimDeps = Pick<AgentReviewDeps, 'claimWorkItem' | 'getWorkItem' | 'releaseWorkItem'>;

/** A failed/aborted writer is never a queue miss: reconcile its holder, then propagate. */
async function claimVerificationCandidate(
  itemId: string,
  actor: string,
  harness: string | undefined,
  scope: VerificationPickupScope,
  deps: VerificationClaimDeps,
  claim: () => Promise<WorkItem | null>,
  eligible: (item: WorkItem) => boolean,
): Promise<WorkItem | null> {
  scope.signal?.throwIfAborted();
  const releaseOwned = async () => {
    const latest = await deps.getWorkItem(itemId, harness);
    if (latest?.assignee !== actor) return;
    const released = await deps.releaseWorkItem(itemId, {
      ...(harness ? { harness } : {}), expectedAssignee: actor, announceClaimable: false,
    });
    if (!released || released.assignee === actor) {
      throw new Error(`verification pickup: could not reconcile invalidated claim on '${itemId}'`);
    }
  };
  let claimed: WorkItem | null;
  try {
    claimed = await claim();
  } catch (error) {
    // The write may have committed before a transport/deadline error. A fresh read
    // plus expected-holder CAS releases only our claim, never a concurrent peer's.
    await releaseOwned();
    throw error;
  }
  if (scope.signal?.aborted || (claimed && (
    claimed.assignee !== actor || !eligible(claimed)
    || !matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(claimed), scope.filter)
  ))) {
    await releaseOwned();
    scope.signal?.throwIfAborted();
    return null;
  }
  return claimed;
}

export type AgentReviewClaimNextMeasuredPhase =
  | 'getWorkItem'
  | 'healOwnNodeRemoteOrigin'
  | 'readLedgerGrade'
  | 'reconcileAgentReviewGrade'
  | 'claimVerificationCandidate';

export interface AgentReviewClaimNextPhaseTiming {
  elapsedMs: number;
  status: 'ok' | 'error';
}

export interface AgentReviewClaimNextCandidateTiming {
  name: 'candidate';
  candidateIndex: number;
  outcome: string;
  phases: Partial<Record<AgentReviewClaimNextMeasuredPhase, AgentReviewClaimNextPhaseTiming>>;
  failedPhase?: AgentReviewClaimNextMeasuredPhase;
}

export interface AgentReviewClaimNextDiagnostics {
  schemaVersion: 'agent-review-claim-next-v1';
  unit: 'ms';
  elapsedMs: number;
  candidateLimit: 25;
  candidateCount: number | null;
  candidatesProcessed: number;
  stages: Array<
    | { name: 'candidateLookup'; elapsedMs: number; status: 'ok' | 'error'; candidateCount: number | null }
    | AgentReviewClaimNextCandidateTiming
  >;
}

/** Reviewer pickup over the unified queue; direct claims still use claimWorkItem's CAS. */
export async function claimNextAgentReview(
  input: {
    reviewer: string;
    harnessSlug?: string;
    onDiagnostics?: (diagnostics: AgentReviewClaimNextDiagnostics) => void;
  } & VerificationPickupScope,
  deps: AgentReviewDeps = defaultDeps,
): Promise<WorkItem | null> {
  input.signal?.throwIfAborted();
  if (!input.reviewer.trim()) return null;
  const diagnostics: AgentReviewClaimNextDiagnostics | null = input.onDiagnostics
    ? {
        schemaVersion: 'agent-review-claim-next-v1',
        unit: 'ms',
        elapsedMs: 0,
        candidateLimit: 25,
        candidateCount: null,
        candidatesProcessed: 0,
        stages: [],
      }
    : null;
  const overallStartedAt = diagnostics ? performance.now() : 0;
  const emitDiagnostics = () => {
    if (!diagnostics || !input.onDiagnostics) return;
    diagnostics.elapsedMs = Math.max(0, performance.now() - overallStartedAt);
    try {
      input.onDiagnostics(diagnostics);
    } catch {
      /* Diagnostic delivery must never change claim completion or its error. */
    }
  };
  const measureCandidatePhase = async <T>(
    candidate: AgentReviewClaimNextCandidateTiming,
    phase: AgentReviewClaimNextMeasuredPhase,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (!diagnostics) return action();
    const startedAt = performance.now();
    let status: 'ok' | 'error' = 'error';
    try {
      const value = await action();
      status = 'ok';
      return value;
    } finally {
      candidate.phases[phase] = {
        elapsedMs: Math.max(0, performance.now() - startedAt),
        status,
      };
      if (status === 'error') {
        candidate.outcome = 'error';
        candidate.failedPhase = phase;
      }
      emitDiagnostics();
    }
  };
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  let rows: { feature_id: string }[] = [];
  let lookupStatus: 'ok' | 'error' = 'error';
  const lookupStartedAt = diagnostics ? performance.now() : 0;
  try {
    rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${ws}
       AND status = 'open'
       AND item_kind IN ('bug', 'change', 'task', 'feature')
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND ${depsBlockedExclusionSql(sql)}
       AND ${agentReviewPendingSelectorSql(sql)}
       AND ${claimHoldExclusionSql(sql, 'wi.payload')}
       AND COALESCE(payload, '{}'::jsonb) -> 'agentReview' ->> 'submittedBy' IS DISTINCT FROM ${input.reviewer}
       AND NOT ${verificationConflictSql(sql, input.reviewer, { payload: 'wi.payload', terminalOwner: 'wi.terminal_owner' })}
       AND ${input.harnessSlug ? sql`harness_slug = ${input.harnessSlug}` : sql`TRUE`}
       AND ${compileFilter(sql, input.filter)}
     -- P-012 (D-049): an authored order stays first; within it, more independent
     -- reporters are reviewed sooner. Ordering only: claimWorkItem still admits.
     ORDER BY feature_order ASC NULLS LAST, ${corroborationReportersSql(sql)} DESC, created_ts ASC
     LIMIT 25`;
    lookupStatus = 'ok';
  } finally {
    if (diagnostics) {
      diagnostics.candidateCount = lookupStatus === 'ok' ? rows.length : null;
      diagnostics.stages.push({
        name: 'candidateLookup',
        elapsedMs: Math.max(0, performance.now() - lookupStartedAt),
        status: lookupStatus,
        candidateCount: diagnostics.candidateCount,
      });
      emitDiagnostics();
    }
  }
  for (const row of rows) {
    input.signal?.throwIfAborted();
    const stage: AgentReviewClaimNextCandidateTiming | null = diagnostics
      ? { name: 'candidate', candidateIndex: diagnostics.candidatesProcessed + 1, outcome: 'in-progress', phases: {} }
      : null;
    if (stage && diagnostics) {
      diagnostics.stages.push(stage);
      diagnostics.candidatesProcessed += 1;
    }
    const measure = <T>(phase: AgentReviewClaimNextMeasuredPhase, action: () => Promise<T>) =>
      stage ? measureCandidatePhase(stage, phase, action) : action();
    const found = await measure('getWorkItem', () => deps.getWorkItem(row.feature_id, input.harnessSlug));
    if (!found) {
      if (stage) stage.outcome = 'missing';
      emitDiagnostics();
      continue;
    }
    if (isClaimHoldParked(found.payload)) {
      if (stage) stage.outcome = 'claim-held';
      emitDiagnostics();
      continue;
    }
    if (!matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(found), input.filter)) {
      if (stage) stage.outcome = 'filtered';
      emitDiagnostics();
      continue;
    }
    const workItem = await measure(
      'healOwnNodeRemoteOrigin',
      () => healOwnNodeRemoteOrigin(found, deps, { harnessSlug: input.harnessSlug, workspaceId: ws }),
    );
    if (!agentReviewEligibility(workItem).eligible) {
      if (stage) stage.outcome = 'ineligible';
      emitDiagnostics();
      continue;
    }
    const review = readAgentReviewState(workItem.payload);
    if (review?.status !== 'pending' || review.submittedBy === input.reviewer) {
      if (stage) stage.outcome = 'not-pending';
      emitDiagnostics();
      continue;
    }
    const parties = verificationParties(workItem);
    if (verificationConflict(parties, input.reviewer)) {
      if (stage) stage.outcome = 'conflict';
      emitDiagnostics();
      continue;
    }
    // A 'pending' round whose ledger row ALREADY carries a standing grade is not reviewable:
    // `enterAgentReview` enrolls with `preserveExisting`, so a pre-existing su-ideate row that
    // the owner had already graded keeps that sovereign grade while the payload starts at
    // 'pending' — and nothing reconciles the two until someone grades. Handing it out made the
    // reviewer burn a review on a foregone conclusion (their grade cannot displace the owner's
    // and is refused or ignored). Converge it here from the standing grade instead, then move
    // on. Best-effort: a row that cannot converge (e.g. a low grade with no feedback) is
    // skipped, never handed out. (EI-24720168531118378)
    //
    // ROUND 1 ONLY. A standing grade is sovereign only when it pre-dates enrollment, which is
    // round 1. Resubmit and re-entry advance the round without clearing the ledger row, so in
    // round >= 2 the standing grade is the one that ALREADY decided an earlier round.
    // Converging from it replays the old grade and feedback as the new round, bounces the
    // item back to its submitter, and no reviewer ever sees the revision (WI-10005365).
    // A fresh grade in round >= 2 arrives through blender:grade-idea, which reconciles it itself.
    const standing = review.round === 1
      ? await measure('readLedgerGrade', () => deps.readLedgerGrade(review.ledgerIdeaId))
      : null;
    if (standing && standing.grade != null && standing.workItemId === workItem.id) {
      try {
        await measure('reconcileAgentReviewGrade', () => reconcileAgentReviewGrade(
          { ideaId: review.ledgerIdeaId, gradedBy: standing.gradedBy ?? input.reviewer },
          deps,
        ));
        if (stage) stage.outcome = 'standing-grade-reconciled';
      } catch {
        if (stage) stage.outcome = 'standing-grade-reconcile-failed';
        emitDiagnostics();
        // leave it for a direct regrade / the next pickup; never hand out a settled row
      }
      continue;
    }
    const agentReviewAdmission = workItem.harness
      ? mintAgentReviewClaimAdmission({
          itemId: workItem.id,
          reviewer: input.reviewer,
          harnessSlug: workItem.harness,
          review,
          source: workItem,
          parties,
        })
      : null;
    const claimed = await measure('claimVerificationCandidate', () => claimVerificationCandidate(
      workItem.id, input.reviewer, workItem.harness ?? undefined, input, deps,
      () => deps.claimWorkItem(workItem.id, input.reviewer, {
        ...(workItem.harness ? { harness: workItem.harness } : {}),
        ...(agentReviewAdmission ? { agentReviewAdmission } : {}),
      }),
      (item) => readAgentReviewState(item.payload)?.status === 'pending'
        && !isClaimHoldParked(item.payload)
        && !verificationConflict(verificationParties(item), input.reviewer),
    ));
    if (claimed) {
      if (stage) stage.outcome = 'claimed';
      emitDiagnostics();
      return claimed;
    }
    if (stage) stage.outcome = 'claim-missed';
    emitDiagnostics();
  }
  emitDiagnostics();
  return null;
}

/**
 * P-007 Phase B (D-027): the verification-task leg of the verifier lane. A verification
 * task (payload.verification, stamped by `investigate`) is an ordinary ready row, so it is
 * claimed through claimWorkItem, the by-id writer that enforces the D-021 conflict rule,
 * the floors and admission. The SQL only orders candidates and applies the self-select
 * dependency floor; it admits nothing the writer would refuse.
 */
export async function claimNextVerificationTask(
  input: { verifier: string; harnessSlug?: string } & VerificationPickupScope,
  deps: VerificationClaimDeps = defaultDeps,
): Promise<WorkItem | null> {
  input.signal?.throwIfAborted();
  const verifier = input.verifier.trim();
  if (!verifier) return null;
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ feature_id: string; harness_slug: string | null }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.work_items wi
     WHERE workspace_id = ${ws}
       AND status = 'open'
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND jsonb_typeof(COALESCE(payload, '{}'::jsonb) -> 'verification') = 'object'
       ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
       AND ${depsBlockedExclusionSql(sql)}
       AND NOT ${verificationTaskConflictSql(sql, verifier, 'wi.payload')}
       AND ${compileFilter(sql, input.filter)}
     -- P-012 (D-049): the subject with more independent reporters is verified first.
     ORDER BY ${corroborationReportersSql(sql, VERIFICATION_SUBJECT_ID_SQL)} DESC, created_ts ASC, feature_id ASC
     LIMIT 20`;
  for (const row of rows) {
    input.signal?.throwIfAborted();
    const found = await deps.getWorkItem(row.feature_id, row.harness_slug ?? undefined);
    if (!found || !matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(found), input.filter)) continue;
    if (verificationTaskConflict(found.payload, verifier)) continue;
    const claimed = await claimVerificationCandidate(
      row.feature_id, verifier, row.harness_slug ?? undefined, input, deps,
      () => deps.claimWorkItem(row.feature_id, verifier, row.harness_slug ? { harness: row.harness_slug } : {}),
      (item) => readVerificationTask(item.payload) !== null && !verificationTaskConflict(item.payload, verifier),
    );
    if (claimed) return claimed;
  }
  return null;
}

export type VerificationWorkKind = 'agent-review' | 'verification-task';

/** P-007 Phase B (D-027): one verifier-lane pull. Pending reviews first, then verification tasks. */
export async function claimNextVerificationWork(
  input: { verifier: string; harnessSlug?: string } & VerificationPickupScope,
  deps: AgentReviewDeps = defaultDeps,
): Promise<{ workItem: WorkItem; kind: VerificationWorkKind } | null> {
  const review = await claimNextAgentReview({ ...input, reviewer: input.verifier }, deps);
  if (review) return { workItem: review, kind: 'agent-review' };
  const task = await claimNextVerificationTask(input, deps);
  return task ? { workItem: task, kind: 'verification-task' } : null;
}

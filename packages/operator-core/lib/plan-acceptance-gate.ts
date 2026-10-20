/**
 * plan-acceptance-gate — the plan-completion acceptance gate
 * (acceptance-rubrics-on-every-plan-2026-08-11 P-004/P-005).
 *
 * Owner-ruled model (D-007/D-008, [owner 2026-08-11]): every plan carries a gradeable
 * definition-of-done as an ACCEPTANCE-kind rubric (kind:'acceptance', subjectPlan =
 * the plan), authored AFTER implementation — better informed, and no tokens wasted on
 * criteria a mid-implementation redesign would invalidate. The single enforcement
 * point is COMPLETION: plan → shipped refuses unless the rubric exists AND a
 * NON-implementer graded it (grader ≠ rubric author, mirroring blender:grade-idea's
 * self-grade refusal). There is deliberately no gate at plans:new / plans:start.
 *
 * The VETTING check (consult-min-max-and-rubric-vetting-2026-08-17 P-004) sits inside
 * the rubric family: before the work is graded, the rubric AUTHOR vets the RUBRIC
 * against the meta-rubric (META_ACCEPTANCE_RUBRIC_ID), informed by a get_feedback
 * consult — the gate refuses (acceptance_rubric_unvetted) unless the CURRENT rubric
 * revision carries a complete meta-scorecard with a linked consult.
 *
 * This module exists (rather than inlining in set-plan-status.ts) because rubrics.ts
 * cannot import scorecards.ts (scorecards already imports rubrics — a cycle), and any
 * future completion surface (a work-items completion audit, a plans:complete verb)
 * should read the SAME verdict rather than re-derive it.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { SelectionVia } from '@papercusp/ranked-selection';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from './workspace-registry';
import { PLAN_CLASS_RUBRIC_REFS } from './plan-class-refs';
import { RUBRIC_TEMPLATE_NAME } from './agent-tools/plans/rubric-template';
import {
  classifyRubricEvidenceCurrentness,
  getAcceptanceRubricsForPlan,
  getRetiredAcceptanceRubricsForPlan,
  getRubric,
  META_ACCEPTANCE_RUBRIC_ID,
  readRubricPlanRevision,
} from './rubrics';
import { listScorecards, ratingVerdict } from './scorecards';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { rubricVettingConsultHint } from './consult/selection-policies';
import {
  getAcceptanceRubricVettingStatus,
  type GradingAuditDispatchSuppression,
} from './acceptance-rubric-vetting';
// EI-20249725405239230: the no-claim FACT is single-sourced beside the grader
// briefs so the author-facing refusal and the grader-facing copy cannot drift
// into two different statements of what scorecards:emit actually requires.
// `grading-cascade` is pure (type-only imports), so this adds no runtime edge.
import { ACCEPTANCE_GRADING_NO_CLAIM_FACT } from './consult/grading-cascade';
import {
  gradingAuthorityAdmits,
  gradingViaOf,
  isOwnerFiledGrading,
  pickAuthoritativeGrading,
  readGraderSelectionVia,
  rubricGradingAuthority,
} from './acceptance-grading-authority';
import { ADMIN_COORD_UI_OWNER } from './agent-tools/coordination/identity';
import {
  evaluatePlanSpecCoverageGate,
  type PlanSpecCoverageGateVerdict,
} from './agent-tools/plans/plan-spec-coverage-gate';
import {
  citationBlobSha,
  getEffectiveItemAudits,
  getLatestActivationAudit,
  getLatestPlanAudit,
  getPlanItemStatuses,
  isRepoFileCitation,
  isVerifyingCitation,
  isCitationContextFailure,
  loadGenericCitationLookupForWorkspace,
  planItemTextHash,
  planItemTextHashCandidates,
  repoCitationContextForHarness,
  measureCitationBlobsAtHead,
  resolveCitation,
  UNFINISHED_ITEM_STATUSES,
} from './plan-audits';
import {
  describeUnrealized,
  deriveNonCodeExemptionProofs,
  judgeRequirementRealization,
  type DroppedTarget,
  type ExemptMapping,
  type NonCodeItemProof,
} from './plan-requirement-realization';
import {
  describeVerificationProfile,
  isReasonedNonCodeAudit,
  resolveVerification,
  unfinishedItemsAreAuditedNonCode,
} from './plan-verification-profile';
import { describeNonCodeDeliverableCodeEvidence, readNonCodeDeliverableShipEvidence } from './plan-verification-escape';
import { genericCitationStaleReason, isGenericCitationKind, resolveGenericCitation } from './plan-audits-generic-citations';
import { listSpecClauses } from './agent-tools/plans/spec-clauses-store';
import { detectEphemeralDeliverableReferences, type EphemeralDeliverableReference } from './turn-end-tracking';
import { citationDeploymentForPaths, type CitationDeployment } from './deployment-position';
import { readAndEvaluateAcceptanceBarLifecycle, type AcceptanceBarLifecycleVerdict } from './acceptance-bar-lifecycle-evaluator';
import type { AcceptanceBarContractSnapshot } from './acceptance-bar-contract-snapshot';
import { splitPlanSections } from './agent-tools/plans/plan-sections';
import { planDesignEvidenceGate } from './agent-tools/work_items/design-evidence-gate';
import { evaluateIndependentVerificationGate } from './independent-verification-gate';
import { evaluateBlindReviewGate } from './blind-review-gate';
import { getBuildInfo, type BuildInfo } from './build-info';
import { beginPlanClosureObservation, isCanonicalClosureGateCall } from './goals/plan-closure-observations';

export type { CitationDeployment };

/** A route, not permission to write. Only nextVerb has complete, executable args. */
export interface PlanAcceptanceRepairAction {
  kind: 'diagnostic' | 'contract-repair' | 'rubric-vetting' | 'independent-grading'
    | 'author-verdict' | 'evidence-repair' | 'shipment' | 'terminal';
  nextVerb: { name: string; args: Record<string, unknown> } | null;
  /** The eventual write needs authored evidence/arguments; never execute this as a call. */
  repairVerb?: string;
  instruction: string;
}

export type PlanAcceptanceGateCode =
  | 'acceptance_rubric_missing'
  | 'acceptance_rubric_ambiguous'
  // consult-min-max-and-rubric-vetting-2026-08-17 P-004 — the vetting check.
  | 'acceptance_rubric_unvetted'
  // EI-21827040531672903 — the two ways the vetting check used to pass without
  // having established anything: an unreadable revision (was: fail-open) and an
  // attestation that post-dates the grading it was supposed to precede.
  | 'acceptance_rubric_revision_unreadable'
  | 'acceptance_rubric_vetted_after_grading'
  | 'acceptance_ungraded'
  | 'self_graded_only'
  | 'acceptance_lineage_unreadable'
  | 'acceptance_bar_not_met'
  | 'acceptance_bar_contract_not_ready'
  | 'acceptance_not_recorded'
  | 'acceptance_rejected'
  // WI-10004135 — 'accept-pending-delivery' on a plan outside the acceptance-BAR contract.
  | 'acceptance_pending_delivery'
  // plan-completion-audit-and-acceptance-verdict-2026-08-13 — the code-truth family.
  | 'plan_items_unfinished'
  | 'acceptance_unaudited'
  | 'audit_coverage_stale'
  | 'audit_citations_unresolved'
  // plan-verification-profiles-2026-10-17 P-004 (R-11, D-009) — a code deliverable, in either
  // profile, whose effective audit carries no code/test citation that resolves against the tree.
  | 'code_deliverable_unverified'
  // design-to-code-coverage-seam-2026-09-02 P-014 — the activation↔completion JOIN.
  // The two audits were both present and never compared, so a requirement could be
  // recorded `covered` while its plan item was audited with no verifying citation.
  | 'requirement_unrealized'
  // plan-verification-profiles-2026-10-17 P-005 (R-15, D-008) — a closed work item carries
  // code-change evidence while its plan item now resolves to a non-code deliverable, and the
  // read that checks it. Neither is waived by force: a waiver would re-open the escape.
  | 'non_code_deliverable_code_evidence'
  | 'non_code_deliverable_check_unavailable'
  // A plan cannot ship a report that exists only in a session/account-local
  // presentation surface. The URL/path detector is shared with the advisory
  // turn-end warnings; this code is the completion-time enforcement leg.
  | 'ephemeral_deliverable_unbacked'
  // first-class-spec-clauses-…-2026-08-20 P-008 — the spec-proof half of code truth.
  | 'spec_proof_stale'
  // …P-013 widened it: a clause with NO evidence at any revision now refuses too. Both
  // codes are carried through from the census verbatim so the author is told which of the
  // two actually happened — re-prove a stale binding, or bind one that never existed.
  | 'spec_clause_unproven'
  | 'design_evidence_unsatisfied'
  | 'design_evidence_unavailable'
  // WI-10004178 / p2p-public-release-endgame D-095 — this node is a federated RECEIVER
  // of the plan's acceptance rubric, so its revision counter is not the one the
  // authoring node's cards were graded against. Ship and grade from the authoring node.
  | 'acceptance_authored_on_other_node'
  // verification-system-improvements-2026-10-10 P-008 (D-005, D-015 pt4) — a live/deployed
  // mandatory outcome bar with no binding from outside the implementer lineage.
  | 'independent_verification_missing'
  // The same door could not READ its scope, bindings or lineage, and refused rather than guess.
  | 'independent_verification_unavailable'
  // verification-system-improvements-2026-10-10 P-006 (D-006, D-039) — no counted blind gap
  // review for the plan's latest activation audit, or a counted review's gap is undispositioned.
  | 'blind_review_missing'
  | 'blind_review_gap_undispositioned'
  // The blind-review door could not read its inputs and refused rather than guess.
  | 'blind_review_unavailable'
  /** Never accompanies a refusal (the census degrades to report-only), carried for the union's honesty. */
  | 'spec_coverage_unavailable';

/** Codes that can be recorded in forcedPast. BAR lifecycle codes remain
 * distinct from the gate's top-level refusal-code vocabulary. */
export type PlanAcceptanceGateWaivedCheck =
  | PlanAcceptanceGateCode
  | 'bar_snapshot_proof_inadequate'
  | 'bar_snapshot_proof_stale';

/**
 * One failing gate check with its own repair route
 * (plan-verification-friction-reduction-2026-10-11 P-001, R-1).
 */
export interface PlanAcceptanceGateBlocker {
  code: PlanAcceptanceGateCode;
  message?: string;
  repairAction: PlanAcceptanceRepairAction;
}

export interface PlanAcceptanceGateVerdict {
  /** The loaded operator build that produced this time-sensitive verdict. */
  buildProvenance: BuildInfo;
  satisfied: boolean;
  /**
   * P-001 (plan-verification-friction-reduction-2026-10-11, R-1): every failing check on a
   * refusal, primary (`code`) first. Present on every refusal.
   *
   * With `collectAllBlockers` the gate keeps evaluating the independent pre-grading checks
   * after the first failure: BAR contract, deliverable durability, items, code-truth audit,
   * spec proof, independent verification, blind review, design evidence, and rubric
   * existence and vetting. The grading-phase checks still run only once all of those pass,
   * because a grading obligation cannot be worked before them.
   *
   * Without that option it has one entry, the first failure, as before. Measured over 14
   * days before this: 865 ship attempts across 86 plans, because each refusal revealed only
   * the next blocker.
   */
  blockers?: PlanAcceptanceGateBlocker[];
  /**
   * Why the gate did not apply (satisfied:true without a graded rubric).
   *
   * `already-shipped` (EI-22078741539479611): the plan is ALREADY terminal, so the
   * pre-ship question has nothing left to decide. Its acceptance rubric retired WITH
   * the ship (one-shot, by design); re-asking the question would read that retirement
   * as `acceptance_rubric_missing` and any later peer edit to a cited file as
   * `audit_coverage_stale` — both prescribing a repair (author a rubric / re-audit)
   * that re-opens a settled gate.
   */
  skipped?: 'flag-off' | 'rubric-template-plan' | 'template-instance' | 'already-shipped';
  /**
   * P-015 / D-035: realizing requirement mappings judged by NOTHING — every target they
   * named is a `D-NNN` or `section:…`, which has no completion-audit counterpart. Present
   * on a SATISFIED verdict, because it is deliberately NOT a refusal: a requirement whose
   * honest home is a decision or a section is a legitimate and common outcome, and P-015's
   * proposed refusal was rejected (D-035) after it was measured to block this very plan
   * over turns like "explain this more?".
   *
   * It is reported because the alternative is worse than either: `judgeRequirementRealization`
   * already computed this exemption and the gate silently DISCARDED it, so the module's own
   * stated guarantee — "surfaced so a vacuous pass is never mistaken for a verified one" —
   * was not delivered to anyone. Omitted entirely when there are none, so its presence always
   * means there is something to look at.
   */
  requirementExemptions?: ExemptMapping[];
  /**
   * P-016 / D-040: realizing requirement mappings routed to a plan item that is still
   * present but `dropped`. Present on a SATISFIED verdict, and deliberately not a
   * refusal: dropping is the recorded exit D-002 provides, and a mapping naming several
   * targets can be genuinely absorbed by a live sibling.
   *
   * What it exists to make visible is the pairing the gate could not see before —
   * `vouchedByStaleAudit`, a dropped item whose PRE-DROP verifying citation is still
   * carried forward by the all-passes audit fold and is still satisfying the coverage
   * claim. Measured 2026-09-03: 28 of 83 dropped targets fleet-wide. Omitted entirely
   * when there are none, so its presence always means there is something to look at.
   */
  requirementDroppedTargets?: DroppedTarget[];
  /** Why the gate refused (satisfied:false). */
  code?: PlanAcceptanceGateCode;
  /** On `acceptance_authored_on_other_node`: the node that must ship and grade this plan. */
  authoringNode?: AcceptanceAuthoringNode;
  /** Preserve the SAME lifecycle observation that refused; do not re-read to explain it. */
  acceptanceBarLifecycle?: Omit<AcceptanceBarLifecycleVerdict, 'nonCodeItemProofs'>;
  /**
   * P-038 (review-system-rework-reduction-2026-09-23, R-9): the lifecycle PHASE whose
   * obligations actually block, and that phase's own verdict. The ship-phase
   * `acceptanceBarLifecycle` lists every code owed by ship time — including grading and
   * author-verdict codes that cannot be worked yet — so on its own it hides the one repair
   * that unblocks. When the ship door defers to pre-grading and pre-grading fails, the
   * repair belongs to pre-grading; `blockingPhaseLifecycle.nextRepair` is it.
   */
  blockingPhase?: AcceptanceBarLifecycleVerdict['phase'];
  blockingPhaseLifecycle?: Omit<AcceptanceBarLifecycleVerdict, 'nonCodeItemProofs'>;
  /** Exact authoritative grading to read before recording an author verdict. */
  gradingRef?: string;
  /** On `self_graded_only` or `acceptance_rubric_vetted_after_grading`: the independent
   * scorecard the gate excluded. The recruiter excludes it from its settlement read, so the
   * fresh grading this refusal asks for is actually dispatched (WI-10003286). */
  staleGradingScorecardId?: string;
  /** EVERY independent scorecard this gate excluded as cohort- or ordering-stale —
   * the named card above plus each older independent card that
   * predates it. The recruiter must exclude the whole set: handing it only the named
   * id lets its settlement read fall back to an older, equally excluded card and
   * report "settled", so the fresh grading is never dispatched (WI-10003286). */
  staleGradingScorecardIds?: string[];
  repairAction?: PlanAcceptanceRepairAction;
  /** Teaching message for the refusal — the authoring/grading nudge (P-004). */
  message?: string;
  /** Optional target-owner pause read, used by the ship writer to name a blocked grade audit. */
  gradingAuditDispatchSuppressed?: GradingAuditDispatchSuppression;
  /** The acceptance rubric involved, when one exists. */
  rubricId?: string;
  /** The independent grader satisfying the gate, when satisfied by a grading. */
  gradedBy?: string | null;
  /**
   * Criterion keys whose authoritative grading explicitly recorded `unknown`.
   * `unknown` is a valid categorical rating and therefore does not change the
   * process-gate decision, but it is not evidence that the criterion was verified.
   */
  unknownRatedCriteria?: string[];
  /**
   * WI-10004135 — on an `acceptance_pending_delivery` refusal, the rubric criteria whose
   * `evidencePlane` is deployed/live and whose independent rating is not pass-equivalent:
   * the delivery evidence the author's pending-delivery verdict is still waiting on.
   */
  pendingDeliveryCriteria?: string[];
  /**
   * EI-22181490624100467 — the DEPLOYMENT POSITION of the code/test citations this
   * plan's code-truth audit rests on. Present only when `probeCitationDeployment`
   * asked for it (the ship write); absent means NOT MEASURED, never "deployed".
   *
   * WHY THIS EXISTS. Plan completion requires a per-item code-truth audit whose only
   * VERIFYING citations are `code`/`test` blobs, and acceptance criteria are then
   * graded against those citations. A blob citation is BLIND TO DEPLOYMENT by
   * construction: a grader opens the cited file, reads a correct and even falsifiable
   * fix, and rates PASS — while the live surface still exhibits the very defect the
   * item claims closed, because the fix is committed but `main` has not fast-forwarded.
   * The card then records a pass that means less than its wording claims, and nothing
   * in the artifact says so. That is the platform's own `silent-wrong-answers` class
   * reproduced inside the acceptance instrument.
   *
   * WHY IT RECORDS AND NEVER REFUSES. Two independent reasons, either sufficient:
   * (1) the same D-002 rule the audit verdicts follow — evidence RECORDS, the item's
   * own status is the ship-blocking question; and (2) deployment is not the author's
   * to control. When the green-checkpoint gate is red nothing reaches `main` for
   * ANYONE, so refusing here would freeze every plan completion fleet-wide on an
   * outage the author cannot clear — converting a reporting gap into an outage
   * amplifier. The defect being fixed is SILENCE, not permissiveness.
   *
   * Read `undeployedPaths` as the direct answer to "was this graded against code that
   * is not live?", and `unknownPaths` as "the probe could not say" — never as a pass.
   *
   * `newerCommitPaths` is the THIRD state and is neither of those: the probe measured
   * `deployed:false` but disclaimed it, because on this whole-tree-swept checkout the
   * newest commit touching a cited file is routinely a PEER'S, so the `false` is about
   * that commit rather than about the cited change. It is not evidence in either
   * direction; settling one needs a marker literal the cited change introduced.
   */
  citationDeployment?: CitationDeployment;
  /**
   * HOW that grader was selected, read from the durable grading-cascade row
   * (unified-responder-selection-critique-and-grading-2026-08-30 P-004):
   * `'floor'` = cleared the relevance floor; `'minimum'` = a below-floor
   * minimum-fill (D-002); `null` = not attributable to a cascade selection
   * (owner-filed, hand-dispatched, predating the cascade, or a row that could
   * not be read) — which ranks AS floor but is not asserted to be it.
   *
   * Carried on the satisfied verdict for the reason `vettedUnderWaiver` is:
   * D-002 accepts knowingly that where no above-floor grader exists a
   * minimum-fill one grades anyway, and states that cost is not to be
   * rediscovered as a surprise. A reader of a successful ship is entitled to
   * see that the grading behind it came from a peer the router did not match.
   */
  gradedVia?: SelectionVia | null;
  /** Set when an explicit reasoned `force` waived the code-truth checks (D-003). The
   *  caller stamps this on the plan so the waiver is permanent and visible, never a
   *  silent bypass — a force that is easy to hide is worth very little. */
  forcedPast?: { reason: string; checks: PlanAcceptanceGateWaivedCheck[] };
  /** EI-20821478338037350: the vetting attestation that satisfied the gate was made
   *  over a consult NOBODY critiqued, under an explicit recorded waiver. The ship is
   *  allowed (a dead reviewer pool is a real condition), but for the same reason
   *  `forcedPast` exists it must not be silent: this rubric received no external
   *  critique, and a reader of the verdict is entitled to know that. */
  vettedUnderWaiver?: { consultId: string; reason?: string };
  /**
   * P-008's structured spec-coverage aggregate — current clauses, adequacy scorecards,
   * exemptions and proof freshness — carried on BOTH the refusal it produces and the
   * satisfied verdict, so a reader of a successful ship can still see what was proven
   * and what merely went unreported. Absent when its own flag is off, when the plan is
   * exempt, and on the refusals that precede it (the item/audit family) or that follow
   * it on a different axis entirely (the rubric family's ceremony checks).
   *
   * ⚠ Its `reports` are ADVISORY: an enforceable clause with no evidence at all is
   * named there and deliberately does NOT refuse (D-018). A caller rendering `reports`
   * as a failure has imported P-013's enforcement early.
   */
  specCoverage?: PlanSpecCoverageGateVerdict;
}

type PlanAcceptanceGateVerdictWithoutBuildProvenance = Omit<PlanAcceptanceGateVerdict, 'buildProvenance'>;

/**
 * P-038 (review-system-rework-reduction-2026-09-23, R-9): the ship refusal when the ship door
 * deferred to pre-grading (grading missing/stale) and pre-grading itself fails. Keeps the
 * ship-phase lifecycle (every code owed by ship time) but names the phase that ACTUALLY blocks,
 * carries its verdict, and leads the message with that phase's single next repair.
 *
 * Measured 2026-09-23 (Avi #302): an agent shipping consult-expert-routing-2026-09-22 was
 * refused with six codes and had to re-probe by hand to learn only bar_snapshot_vetting_missing
 * blocked — the gate had computed exactly that verdict here and thrown it away. Pure.
 */
export function preGradingBlockedRefusal(
  shipRefusal: PlanAcceptanceGateVerdictWithoutBuildProvenance,
  preGrading: AcceptanceBarLifecycleVerdict,
): PlanAcceptanceGateVerdictWithoutBuildProvenance {
  const { nonCodeItemProofs: _omit, ...phaseVerdict } = preGrading;
  const repair = preGrading.nextRepair;
  const lead =
    `BLOCKED AT PRE-GRADING (${preGrading.codes.length} code(s): ${preGrading.codes.join(', ') || 'none'}). ` +
    (repair
      ? `NEXT REPAIR${repair.barKey ? ` (${repair.barKey})` : ''}: ${repair.action}. `
      : '') +
    'Grading and author-verdict codes in the ship list cannot be worked until this phase passes.';
  return {
    ...shipRefusal,
    blockingPhase: 'pre-grading',
    blockingPhaseLifecycle: phaseVerdict,
    message: shipRefusal.message ? `${lead}\n${shipRefusal.message}` : lead,
  };
}

export interface PlanAcceptanceGateOpts {
  readCurrentCritique?: import('./acceptance-rubric-vetting').AcceptanceRubricVettingDeps['readCurrentCritique'];
  /** Subject harness, distinct from the acceptance rubric's storage harness. */
  harnessSlug?: string;
  /** Freshly measured fingerprints for the original requirements' bound proof. */
  current?: import('./agent-tools/plans/spec-evidence-store').EvidenceCurrentInput[];
  /**
   * Internal read-path seam: the sync resolver may already have an in-flight BAR
   * snapshot. Sharing it keeps the resolver, ship phase, and deferred pre-grading
   * phase on one immutable observation instead of repeating the bounded join.
   */
  acceptanceBarContractSnapshot?: AcceptanceBarContractSnapshot | Promise<AcceptanceBarContractSnapshot>;
  /**
   * An explicit, reasoned override of the CODE-TRUTH family only —
   * `plan_items_unfinished`, `acceptance_unaudited`, `audit_coverage_stale`,
   * `audit_citations_unresolved` (plan D-003/D-005).
   *
   * It deliberately does NOT waive the rubric family. Those three refusals encode a
   * different owner ruling (an acceptance rubric, graded by someone other than its
   * author) and widening force to cover them would collapse two independent guards
   * into one switch. When `acceptanceBarProofMetadata` is true, the reason is instead
   * confined to the two explicitly listed BAR proof metadata codes and does not
   * activate this code-truth waiver.
   */
  force?: { reason: string; acceptanceBarProofMetadata?: boolean };
  /**
   * Read the gate for GRADER RECRUITMENT rather than shipment. The real ship gate
   * remains strict: every plan item must be terminal. Recruitment may look past an
   * unfinished tail only when every such item is already audited `not-code` — the
   * acceptance-ceremony item whose own completion requires the independent grade.
   * Missing/stale audit evidence fails toward the ordinary unfinished-item refusal.
   */
  gradingRecruitment?: boolean;
  /** Review-only selection; final ship lifecycle always evaluates the original proof. */
  pendingDeliveryBarKeys?: string[];
  /**
   * EI-22181490624100467 — resolve the DEPLOYMENT POSITION of the code/test
   * citations this plan's code-truth audit rests on, returned as report-only
   * `citationDeployment`. Never refuses; see that field for why.
   *
   * OPT-IN BECAUSE THE PROBE IS EXPENSIVE AND THIS GATE IS A HOT READ. Each
   * probed path forks git and may probe systemd + an HTTP health endpoint, while
   * `evaluatePlanAcceptanceGate` is called per plan by the `planAcceptanceGateVerdict`
   * SYNC RESOLVER (every UI read) and by the acceptance-grading sweep routine.
   * Turning this on unconditionally would put a capped-but-real fan-out of forked
   * git reads on a render path — the repo's A1-class perf anti-pattern. Only the
   * SHIP write (`plans:set-plan-status`) sets it, which is both rare and the exact
   * moment the record needs to be permanent.
   */
  probeCitationDeployment?: boolean;
  /**
   * P-001 (plan-verification-friction-reduction-2026-10-11): keep evaluating the independent
   * pre-grading checks after the first failure and report each one in `blockers`. The
   * primary `code`/`message` are unchanged, so grader recruitment and the closure observation
   * read the same verdict either way.
   *
   * Opt-in for the reason `probeCitationDeployment` is: a refused plan would otherwise run
   * every later check (including forked git blob measurement in the audit leg) on the sync
   * resolver's per-plan hot read. Only the ship door (`plans:set-plan-status`) sets it.
   */
  collectAllBlockers?: boolean;
  /**
   * Census-only (plan-verification-profiles-2026-10-17 P-002, R-6): run the full pre-ship gate
   * for a plan that is ALREADY shipped instead of returning the `already-shipped` skip, so a
   * before/after census can compare RE-EVALUATED ship verdicts. Without it every shipped plan
   * reads satisfied and the census measures nothing. Never set on the ship write or a UI read:
   * post-ship the rubric family reads missing by design (see the skip's comment). A call with
   * it set is not canonical, so it records no closure observation.
   */
  reevaluateShipped?: boolean;
  /** Read whether a pending meta-scorecard's owner is paused before dispatch can settle it. */
  readGradingAuditDispatchSuppression?: (targetOwnerId?: string | null) => Promise<GradingAuditDispatchSuppression | null>;
}

/**
 * D-001's one-time compatibility boundary. Scorecards created before the verdict
 * write surface existed had no way to carry `acceptance`; a qualifying legacy
 * independent grading therefore counts as accepted. Newer gradings must complete
 * the explicit implementer-verdict leg.
 */
export const ACCEPTANCE_VERDICT_REQUIRED_AFTER = '2026-08-21T00:00:00.000Z';

/**
 * EI-21827040531672903's compatibility boundary, mirroring the constant above for the
 * same reason: the vetting-BEFORE-grading ordering was documented as the flow's intent
 * from the start (see the vetting block's header) but never enforced, so gradings
 * already exist that were emitted before their rubric was vetted. Enforcing
 * retroactively would refuse plans whose work is done and whose rubric IS now vetted —
 * a paperwork-ordering refusal against already-graded work, with no way to comply
 * except re-grading. A qualifying grading created before this boundary therefore
 * satisfies the ordering leg; newer gradings must genuinely follow their attestation.
 */
export const VETTING_PRECEDES_GRADING_REQUIRED_AFTER = '2026-08-31T00:00:00.000Z';

/**
 * Labels used when a plan records where the durable copy of a delivered report
 * lives. A bare Artifact URL is deliberately insufficient: the independent
 * acceptance grader must have a repository/PG work-item reference it can
 * resolve after the publishing session or account-local presentation expires.
 */
const DURABLE_COMPANION_LABEL_RE =
  /(?:durable\s+(?:companion|source)|source(?:\s+path)?|persisted\s+(?:at|in)|stored\s+(?:at|in)|committed\s+(?:at|in)|repository\s+(?:path|file)|work[- ]item(?:\s+(?:record|comment|source))?)\s*[:=]?\s*(?:`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|([^\s,;)>]+))/gi;

/**
 * plan-verification-profiles P-003 (R-9): a report in the report library (`rpt_…`) or a
 * PG-canonical doc (`doc:<id>`) is held by the platform, so it is a durable companion —
 * but only once the gate has confirmed it exists (`evaluateEphemeralDeliverableDurabilityInStore`).
 */
export function isPlatformArtifactCompanion(candidate: string): boolean {
  return /^rpt_[A-Za-z0-9_-]+$/.test(candidate) || /^doc:\S+$/.test(candidate);
}

/**
 * Extract explicit durable companion references from plan prose. This is
 * intentionally narrower than “does the plan contain any repo path?” — code
 * citations elsewhere in a plan do not prove that the cited deliverable was
 * persisted. The marker must name the companion/source itself, and the value
 * must not be another ephemeral reference.
 */
export function findDurableDeliverableCompanions(content: string): string[] {
  const companions: string[] = [];
  const seen = new Set<string>();
  DURABLE_COMPANION_LABEL_RE.lastIndex = 0;
  for (const match of String(content ?? '').matchAll(DURABLE_COMPANION_LABEL_RE)) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim().replace(/[.!?]+$/, '');
    if (!candidate || detectEphemeralDeliverableReferences(candidate).length > 0) continue;
    // A companion must identify a resolvable path or durable record, not a
    // sentence fragment such as “source: verified” or another presentation URL.
    const isDurableLocator =
      candidate.startsWith('WI-') ||
      candidate.startsWith('EI-') ||
      candidate.startsWith('plan:') ||
      candidate.includes('/') ||
      candidate.includes('\\') ||
      isPlatformArtifactCompanion(candidate) ||
      /\.(?:md|mdx|html?|csv|txt|pdf)$/i.test(candidate);
    if (!isDurableLocator) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companions.push(candidate);
  }
  return companions;
}

/** The completion-time durability check, kept pure for focused gate tests. */
export function evaluateEphemeralDeliverableDurability(content: string): {
  references: EphemeralDeliverableReference[];
  companions: string[];
  satisfied: boolean;
} {
  const references = detectEphemeralDeliverableReferences(content);
  const companions = findDurableDeliverableCompanions(content);
  return { references, companions, satisfied: references.length === 0 || companions.length > 0 };
}

/**
 * R-9 — the gate's durability check. Platform-held companions (`rpt_…`, `doc:<id>`) count
 * only when they resolve in the store (a live, non-retired row in this workspace); one that
 * does not is reported in `unresolvedCompanions` and does not satisfy the check. Every other
 * companion keeps the pure rule above.
 */
export async function evaluateEphemeralDeliverableDurabilityInStore(
  content: string,
  workspaceId: string | null,
  load: typeof loadGenericCitationLookupForWorkspace = loadGenericCitationLookupForWorkspace,
): Promise<ReturnType<typeof evaluateEphemeralDeliverableDurability> & { unresolvedCompanions: string[] }> {
  const pure = evaluateEphemeralDeliverableDurability(content);
  const platform = pure.companions.filter(isPlatformArtifactCompanion);
  if (pure.references.length === 0 || platform.length === 0) return { ...pure, unresolvedCompanions: [] };
  const citations = platform.map((ref) => ({ kind: 'artifact' as const, ref }));
  const lookup = await load(citations, workspaceId).catch(() => new Map());
  const unresolvedCompanions = platform.filter((ref) => !resolveGenericCitation({ kind: 'artifact', ref }, lookup).ok);
  const companions = pure.companions.filter((companion) => !unresolvedCompanions.includes(companion));
  return { references: pure.references, companions, unresolvedCompanions, satisfied: companions.length > 0 };
}

/**
 * Add source coordinates to the gate's refusal without changing the shared
 * detector's public reference shape. References are found in scan order, so a
 * repeated path is paired with its next occurrence in the plan body.
 */
function locateEphemeralDeliverableReferences(
  content: string,
  references: EphemeralDeliverableReference[],
): string[] {
  const nextSearchOffset = new Map<string, number>();
  return references.map(({ kind, reference }) => {
    const key = `${kind}:${reference.toLowerCase()}`;
    const from = nextSearchOffset.get(key) ?? 0;
    const offset = content.indexOf(reference, from);
    if (offset < 0) return `${kind} '${reference}' (location unavailable)`;
    nextSearchOffset.set(key, offset + reference.length);

    const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
    const lineNumber = content.slice(0, offset).split('\n').length;
    const columnNumber = offset - lineStart + 1;
    return `${kind} '${reference}' (line ${lineNumber}, column ${columnNumber})`;
  });
}

/**
 * WI-10004178 / p2p-public-release-endgame-2026-09-01 D-095 — in v1, grading and
 * shipping a federated plan are acts of the node that AUTHORED its acceptance rubric.
 *
 * The rubric row federates, but its `version` is a machine-local counter: a receiver's
 * copy lands at 0 and every remote apply bumps it. Cards graded on the authoring node
 * name the authoring node's counter, and `plan_revisions` does not federate, so on a
 * receiver the rubric-family checks compare two unrelated counters and answer with a
 * plausible-looking `acceptance_ungraded` (which would then recruit a grader HERE) or a
 * revision mismatch. Neither is a verdict this node can compute (D-089's principle), so
 * the gate says so instead, and names the node that can.
 *
 * Receiver evidence is BOTH of:
 * - the subject plan's machine-local `acceptance_bar_verified_revision` is set. Only the
 *   federated-receiver seed writes it (acceptance-bar-receiver-seed.ts); every
 *   author-side writer (seed, amendment, rubric write) clears it; it never federates.
 * - the governing acceptance rubric row is `origin='remote'`: its current content was
 *   written by another node. A local content write resets origin to 'local'
 *   (stamp_local_federated_write), and `version` is in that trigger's mask, so the
 *   receiver seed's own counter bump does not.
 * Neither is enough alone. The authoring node can hold a remote-origin rubric (a peer's
 * supersede federating back; measured live 2026-09-30, several shipped plans here), and
 * the receiver seed can run on the authoring node after a peer's plan write federates
 * back. The conjunction is what only a receiver holds.
 */
export interface AcceptanceAuthoringNode {
  /** The acceptance rubric whose revision counter belongs to the authoring node. */
  rubricId: string;
  /** The device pubkey the federated rows carried for their author, when they carried one. */
  pubkey: string | null;
  /** Renderable name of the authoring node. Never invented: see `labelSource`. */
  label: string;
  /**
   * `pot-member`: the pubkey resolved to a verified pot member's handle.
   * `pubkey`: a pubkey was carried but binds to no member; the label is its short form.
   * `unresolved`: the federation op carried no author key, so this node cannot name it.
   */
  labelSource: 'pot-member' | 'pubkey' | 'unresolved';
  /** The agent that proposed the rubric on the authoring node — a locating hint, not a node. */
  proposedBy: string | null;
  /** This node's machine-local BAR verification revision: the receiver evidence. */
  verifiedRevision: number;
}

export interface ReceiverHeldAcceptanceInput {
  planSlug: string;
  /** harness_plans.acceptance_bar_verified_revision of the subject plan on THIS node. */
  verifiedRevision: number | null;
  /** The single governing acceptance rubric row on this node, or null if not exactly one. */
  rubric: {
    rubricId: string;
    origin: string | null;
    authorPubkey: string | null;
    proposedBy: string | null;
  } | null;
  /** Fallback author key: the subject plan row's owner_author_pubkey. */
  planOwnerPubkey?: string | null;
  /** The pot-member handle `pubkey` resolved to, when it resolved to a verified member. */
  memberHandle?: string | null;
}

function shortAuthoringPubkey(pubkey: string): string {
  return pubkey.length > 12 ? `${pubkey.slice(0, 12)}…` : pubkey;
}

/** PURE: the receiver-node refusal, or null when this node may evaluate the gate. */
export function receiverHeldAcceptanceRefusal(
  input: ReceiverHeldAcceptanceInput,
): PlanAcceptanceGateVerdictWithoutBuildProvenance | null {
  if (input.verifiedRevision == null || !input.rubric || input.rubric.origin !== 'remote') return null;
  const pubkey = input.rubric.authorPubkey || input.planOwnerPubkey || null;
  const labelSource: AcceptanceAuthoringNode['labelSource'] = !pubkey
    ? 'unresolved'
    : input.memberHandle ? 'pot-member' : 'pubkey';
  const label = labelSource === 'pot-member'
    ? `${input.memberHandle} (device ${shortAuthoringPubkey(pubkey!)})`
    : labelSource === 'pubkey'
      ? `device ${shortAuthoringPubkey(pubkey!)}`
      : 'the node that authored it (its federated rows carry no author key, so this node cannot name it)';
  const authoringNode: AcceptanceAuthoringNode = {
    rubricId: input.rubric.rubricId,
    pubkey,
    label,
    labelSource,
    proposedBy: input.rubric.proposedBy,
    verifiedRevision: input.verifiedRevision,
  };
  const proposer = input.rubric.proposedBy ? `, proposed there by ${input.rubric.proposedBy}` : '';
  return {
    satisfied: false,
    code: 'acceptance_authored_on_other_node',
    authoringNode,
    message:
      `Ship from the authoring node ${label}. Plan '${input.planSlug}' and its acceptance rubric ` +
      `'${input.rubric.rubricId}' were authored on another node${proposer}; this node holds a federated ` +
      `copy (BAR verified at local revision ${input.verifiedRevision}). In v1, grading and shipping a ` +
      `federated plan are authoring-node acts (p2p-public-release-endgame-2026-09-01 D-095): rubric ` +
      `revisions are node-local counters, so this node cannot tell whether the authoring node's cards ` +
      `grade the current revision. Run plans:set-plan-status and any acceptance grading on the ` +
      `authoring node. Do NOT recruit a grader or author a rubric here — both would mint a competing ` +
      `verdict. Not waivable by force.`,
  };
}

/**
 * Read the receiver evidence for `planSlug` and resolve the authoring node's name.
 * Only called once `acceptance_bar_verified_revision` is set, so the authoring node
 * never pays for it. Best-effort: an unreadable rubric leaves the ordinary checks in charge.
 */
async function readReceiverHeldAcceptanceRefusal(input: {
  planSlug: string;
  harnessSlug: string | null;
  verifiedRevision: number;
  planOwnerPubkey: string | null;
}): Promise<PlanAcceptanceGateVerdictWithoutBuildProvenance | null> {
  let rubrics: Array<{ plan_slug: string; origin: string | null; author_pubkey: string | null; proposed_by: string | null }>;
  try {
    const { sql } = getOrgPg();
    // Same discovery predicate as the receiver seed, so both agree on which rubric governs.
    rubrics = await sql<typeof rubrics>`
      SELECT plan_slug, origin, author_pubkey, template_data->>'proposedBy' AS proposed_by
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND template = 'rubric'
         AND template_slug IS NULL
         AND archived = false
         AND status IN ('active', 'ready')
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' = ${input.planSlug}
         AND (${input.harnessSlug}::text IS NULL
           OR template_data->>'subjectHarnessSlug' = ${input.harnessSlug}
           OR template_data->>'subjectHarnessSlug' IS NULL)
       LIMIT 2`;
  } catch {
    return null;
  }
  const rubric = rubrics.length === 1 ? rubrics[0]! : null;
  const base: ReceiverHeldAcceptanceInput = {
    planSlug: input.planSlug,
    verifiedRevision: input.verifiedRevision,
    rubric: rubric
      ? { rubricId: rubric.plan_slug, origin: rubric.origin, authorPubkey: rubric.author_pubkey, proposedBy: rubric.proposed_by }
      : null,
    planOwnerPubkey: input.planOwnerPubkey,
  };
  if (!receiverHeldAcceptanceRefusal(base)) return null;
  const pubkey = rubric?.author_pubkey || input.planOwnerPubkey;
  let memberHandle: string | null = null;
  if (pubkey) {
    try {
      const { resolvePlanAuthorIdentities, planAuthorKey } = await import('./identity/resolve-plan-author-identity');
      const resolved = (await resolvePlanAuthorIdentities(activeWorkspaceId(), [{ kind: 'pubkey', value: pubkey }]))
        .get(planAuthorKey('pubkey', pubkey));
      if (resolved?.verified) memberHandle = resolved.handle;
    } catch {
      // Best-effort naming: the refusal still stands with the device key.
    }
  }
  return receiverHeldAcceptanceRefusal({ ...base, memberHandle });
}

/**
 * Evaluate the acceptance gate for a plan about to be marked shipped/complete.
 * Never throws — an infrastructure failure inside a check degrades toward the
 * feature's default posture for that check (the flag read fails toward ON;
 * the exemption read fails toward "not exempt").
 */
async function evaluatePlanAcceptanceGateWithoutBuildProvenance(
  planSlug: string,
  opts: PlanAcceptanceGateOpts = {},
  subject: { status?: string | null; harnessSlug?: string } = {},
): Promise<PlanAcceptanceGateVerdictWithoutBuildProvenance> {
  // Each family reads its OWN flag, below, rather than one early return for all of
  // them: the code-truth checks and the rubric checks are independently killable, so
  // rolling back one must not silently disable the other.
  const rubricGate = await getFlag(FLAGS.ACCEPTANCE_RUBRIC_COMPLETION_GATE, 'system').catch(() => true);
  const forcedChecks: PlanAcceptanceGateWaivedCheck[] = [];
  let deferredBarShipRefusal: PlanAcceptanceGateVerdictWithoutBuildProvenance | undefined;
  // WI-10004135: whether the acceptance-BAR contract governs this plan's ship. Only
  // then do deployed/live BARs block on their own codes; outside that contract an
  // author's 'accept-pending-delivery' verdict is the ONLY record that delivery is
  // outstanding, so the verdict itself must block (see acceptance_pending_delivery).
  let barContractApplicable = false;
  // A BAR can already have a complete grading that belongs to an older rubric
  // revision.  That is still a grader gap, but the ordinary rubric-family read
  // includes scorecard history.  Remember the stale reading so the recruitment
  // path cannot mistake the historical card for a current independent grade.
  let requireCurrentBarGrading = false;
  // WI-10002509: the id of the card the BAR itself judged stale. `requireCurrentBarGrading`
  // alone only licenses the rubric-revision test below, which a card graded against an
  // UNCHANGED rubric passes even after the evidence cohort moved under it — leaving the
  // deferred refusal permanent and the re-grade unrecruitable. Carry the BAR's verdict
  // rather than re-deriving the cohort fingerprint here, so there is one staleness judgment.
  let barStaleGradingScorecardId: string | null = null;
  // P-001 (plan-verification-friction-reduction-2026-10-11): refusals from the independent
  // pre-grading checks, in the gate's advertised order, so the first stays the primary
  // `code`. `refuse` records one and answers whether to stop now (the default first-failure
  // mode) or keep evaluating (`collectAllBlockers`).
  const preGradingRefusals: PlanAcceptanceGateVerdictWithoutBuildProvenance[] = [];
  const refuse = (verdict: PlanAcceptanceGateVerdictWithoutBuildProvenance): boolean => {
    preGradingRefusals.push(verdict);
    return opts.collectAllBlockers !== true;
  };
  const collectedRefusal = (): PlanAcceptanceGateVerdictWithoutBuildProvenance =>
    withPreGradingBlockers(planSlug, preGradingRefusals, opts, subject);
  const gradingRefusal = (verdict: PlanAcceptanceGateVerdictWithoutBuildProvenance) => {
    refuse(verdict);
    return collectedRefusal();
  };

  // Exemptions: a rubric-template plan does not get an acceptance rubric of its own
  // (infinite regress), and a scheduled template INSTANCE is an auto-generated
  // recurrence, not authored work (disclosed in the plan's D-008 discussion).
  // Read once, for two purposes: the exemption test below, and the harness slug the
  // spec-coverage census needs to scope its clause read (P-008).
  let planHarnessSlug: string | null = null;
  let planContent: string | null = null;
  // P-004 (D-009): the stamped profile the code-deliverable ship check resolves items under.
  let planVerification: { verificationProfile: string | null; verificationProfileSource: string | null } = {
    verificationProfile: null,
    verificationProfileSource: null,
  };
  let nonCodeItemProofs: NonCodeItemProof[] = [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      {
        plan_slug: string;
        harness_slug: string | null;
        template: string | null;
        template_slug: string | null;
        content: string | null;
        status: string | null;
        acceptance_bar_epoch: number | string | null;
        acceptance_bar_verified_revision?: number | string | null;
        owner_author_pubkey?: string | null;
        verification_profile?: string | null;
        verification_profile_source?: string | null;
      }[]
    >`
        SELECT plan_slug, harness_slug, template, template_slug, content, status, acceptance_bar_epoch,
               acceptance_bar_verified_revision, owner_author_pubkey,
               verification_profile, verification_profile_source
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
         AND (${opts.harnessSlug ?? null}::text IS NULL OR harness_slug = ${opts.harnessSlug ?? null})
       LIMIT 2`;
    const subjects = rows.filter((r) => r.plan_slug === planSlug &&
      (!opts.harnessSlug || r.harness_slug === opts.harnessSlug));
    if (subjects.length > 1 || (opts.harnessSlug && subjects.length === 0)) {
      return {
        satisfied: false, code: 'acceptance_bar_contract_not_ready',
        message: `plan '${planSlug}' subject identity is ${subjects.length > 1 ? 'ambiguous; supply its harness' : 'unavailable in the requested harness'}. No acceptance contract was selected.`,
      };
    }
    const row = subjects[0];
    // Capture only a positively selected subject from THIS evaluation. Repair
    // routes need its CAS/scope; a second read could describe a different state.
    if (row) {
      subject.status = row.status;
      subject.harnessSlug = row.harness_slug ?? undefined;
    }
    planHarnessSlug = row?.harness_slug ?? null;
    planContent = row?.content ?? null;
    planVerification = {
      verificationProfile: row?.verification_profile ?? null,
      verificationProfileSource: row?.verification_profile_source ?? null,
    };
    if (row?.template === RUBRIC_TEMPLATE_NAME) return { satisfied: true, skipped: 'rubric-template-plan' };
    if (row?.template_slug) return { satisfied: true, skipped: 'template-instance' };
    // EI-22078741539479611: a plan that is ALREADY shipped is past this gate. Every
    // check below is a PRE-ship question, and asked post-ship each answers wrongly:
    // shipping auto-retires the acceptance rubric (retireAcceptanceRubricForPlan), so
    // the rubric family reads `acceptance_rubric_missing`; any later peer edit to a
    // cited file reads `audit_coverage_stale`. Both say "cannot be marked shipped"
    // about a plan that IS shipped, and both prescribe a repair — author a rubric,
    // re-audit — that re-opens a settled gate. Measured live 2026-09-01: a duplicate
    // acceptance rubric was authored, a BLOCKING grading request went to a peer who
    // had already graded 7/7, and three successive sessions were told to "carry the
    // plan to shipped". The write path is unaffected: set-plan-status evaluates this
    // gate only while the plan is NOT yet shipped (shouldEvaluateAcceptanceGate), so
    // the early exit cannot weaken a real ship — it only stops the read from lying.
    if (row?.status === 'shipped' && !opts.reevaluateShipped) {
      const retired = await getRetiredAcceptanceRubricsForPlan(planSlug, {
        ...(planHarnessSlug ? { harnessSlug: planHarnessSlug } : {}),
      });
      const rubricId = retired[0]?.rubricId;
      return {
        satisfied: true,
        skipped: 'already-shipped',
        ...(rubricId ? { rubricId } : {}),
        message:
          `plan '${planSlug}' is already shipped — the ship gate is a pre-ship question and does not apply ` +
          `to a terminal plan. ` +
          (rubricId
            ? `Its acceptance rubric '${rubricId}' was retired WITH the ship (one-shot, by design), so ` +
              `"no active acceptance rubric" here means validated-and-closed, not unvalidated. `
            : `No acceptance rubric is on record for it (it may predate the gate or have shipped under a waiver). `) +
          `Do NOT author a replacement acceptance rubric or re-audit to "reconcile" this read — nothing is ` +
          `pending. To re-validate deliberately, move the plan off shipped first (plans:set-plan-status); ` +
          `the gate then applies again in full.`,
      };
    }

    // P-003: the terminal ship door consumes the same bounded BAR snapshot used
    // by start and scorecard grading. Keep this before the legacy family joins so
    // a post-epoch BAR-only, divergent, unreadable, or wrong-plane contract cannot
    // be mistaken for an ordinary rubric/acceptance verdict.
    if (rubricGate) {
      // WI-10004178 / endgame D-095: a federated RECEIVER cannot compute this verdict,
      // so it must not show one — and it must not show a grader gap, which would recruit
      // a grader here. Checked before every rubric-family read for exactly that reason.
      if (row?.acceptance_bar_verified_revision != null) {
        const receiverRefusal = await readReceiverHeldAcceptanceRefusal({
          planSlug,
          harnessSlug: planHarnessSlug,
          verifiedRevision: Number(row.acceptance_bar_verified_revision),
          planOwnerPubkey: row.owner_author_pubkey ?? null,
        });
        if (receiverRefusal) return receiverRefusal;
      }
      // A historical plan may predate the adoption marker and still contain
      // promises. Its as-built rubric must not silently replace those promises
      // with a checklist of tested seams. Require explicit contract adoption at
      // ship; empty/absent Requirements retain their existing legacy behavior.
      const hasRequirements = splitPlanSections(planContent ?? '').some(
        (section) => section.heading.trim().toLowerCase() === 'requirements' && section.body.trim().length > 0,
      );
      const expectedApplicable = hasRequirements || row?.acceptance_bar_epoch != null;
      const barLifecycle = await readAndEvaluateAcceptanceBarLifecycle(planSlug, 'ship', {
        expectedApplicable,
        ...(planHarnessSlug ? { harnessSlug: planHarnessSlug } : {}),
        ...(opts.current ? { current: opts.current } : {}),
        ...(opts.acceptanceBarContractSnapshot ? { snapshot: opts.acceptanceBarContractSnapshot } : {}),
      });
      nonCodeItemProofs = barLifecycle.nonCodeItemProofs ?? [];
      barContractApplicable = barLifecycle.applicable;
      if (expectedApplicable && !barLifecycle.applicable) {
        if (refuse({
          satisfied: false, code: 'acceptance_bar_contract_not_ready',
          acceptanceBarLifecycle: barLifecycle,
          message: `plan '${planSlug}' has original requirements but no verifiable requirement contract. ` +
            'Adopt the complete original requirement set and its work mappings before shipment; an as-built rubric or disclosure cannot replace it. This is not waived by force.',
        })) return collectedRefusal();
      } else {
      const proofMetadataCodes = opts.force?.acceptanceBarProofMetadata
        ? barLifecycle.codes.filter((code): code is 'bar_snapshot_proof_inadequate' | 'bar_snapshot_proof_stale' =>
            code === 'bar_snapshot_proof_inadequate' || code === 'bar_snapshot_proof_stale')
        : [];
      const proofMetadataOnlyFailure =
        !barLifecycle.satisfied &&
        barLifecycle.applicable &&
        barLifecycle.codes.length > 0 &&
        proofMetadataCodes.length === barLifecycle.codes.length;
      if (proofMetadataOnlyFailure) forcedChecks.push(...proofMetadataCodes);
      if (!barLifecycle.satisfied && !proofMetadataOnlyFailure) {
        const refusal: PlanAcceptanceGateVerdictWithoutBuildProvenance = {
          satisfied: false,
          code: 'acceptance_bar_contract_not_ready',
          acceptanceBarLifecycle: barLifecycle,
          blockingPhase: 'ship',
          message:
            barLifecycle.message ?? `plan '${planSlug}' cannot be marked shipped: acceptance BAR contract is not ready`,
        };
        const gradingMissing = barLifecycle.codes.includes('bar_snapshot_grading_missing');
        const gradingStale = barLifecycle.codes.includes('bar_snapshot_grading_stale');
        if (!gradingMissing && !gradingStale) {
          if (refuse(refusal)) return collectedRefusal();
        } else {
        // A missing OR stale grading recruits an independent grader. Let it run
        // only after the BAR's pre-grading obligations pass, while retaining this
        // ship refusal through every later success path. In the stale case the
        // rubric-family read below must ignore historical-revision cards, or the
        // sweep sees acceptance_bar_contract_not_ready forever and never recruits
        // the re-grade the BAR lifecycle explicitly asks for.
        // In particular, a card arriving between reads cannot waive live proof.
        deferredBarShipRefusal = refusal;
        const preGrading = await readAndEvaluateAcceptanceBarLifecycle(planSlug, 'pre-grading', {
          expectedApplicable: true,
          ...(planHarnessSlug ? { harnessSlug: planHarnessSlug } : {}),
          ...(opts.current ? { current: opts.current } : {}),
          ...(opts.pendingDeliveryBarKeys ? { pendingDeliveryBarKeys: opts.pendingDeliveryBarKeys } : {}),
          ...(opts.acceptanceBarContractSnapshot ? { snapshot: opts.acceptanceBarContractSnapshot } : {}),
        });
        // P-038: the pre-grading verdict IS the explanation of this refusal — the ship-phase
        // codes include grading/author-verdict obligations nobody can work yet. Return it
        // instead of discarding it, and lead the message with the repair that unblocks.
        if (!preGrading.satisfied) {
          // The ship refusal deferred above is a grading-phase obligation; it no longer
          // applies once pre-grading itself refuses, which is what this records.
          deferredBarShipRefusal = undefined;
          if (refuse(preGradingBlockedRefusal(refusal, preGrading))) return collectedRefusal();
        } else {
          requireCurrentBarGrading = gradingStale;
          if (gradingStale) barStaleGradingScorecardId = barLifecycle.staleGradingScorecardId;
        }
        }
      }
      }
    }
  } catch (error) {
    // An unreadable original contract is not evidence of a fulfilled promise.
    // Falling through used to let later rubric success erase this failure.
    if (rubricGate) return {
      satisfied: false, code: 'acceptance_bar_contract_not_ready',
      message: `plan '${planSlug}' requirement contract could not be verified: ${error instanceof Error ? error.message : String(error)}. Retry the contract read before shipment; force cannot establish fulfillment.`,
    };
  }

  // ── the CODE-TRUTH family (plan-completion-audit-…-2026-08-13) ───────────────
  // Ordered cheapest-to-understand first, and ahead of the rubric checks because the
  // audit is authored BEFORE the rubric (D-004): refusing on a missing rubric while
  // the plan still has unbuilt items would send the agent to the wrong repair.
  // D-035: collected in the nested code-truth block below and read at the final return,
  // so it is declared at function scope alongside forcedChecks for the same reason.
  let requirementExemptions: ExemptMapping[] = [];
  // P-016/D-040: same reason as requirementExemptions above — collected in the nested
  // code-truth block and read at the final return.
  let requirementDroppedTargets: DroppedTarget[] = [];
  /**
   * EI-22181490624100467 — repo-relative paths of the code/test citations the
   * code-truth audit actually rests on, collected as they are re-resolved below so
   * the deployment probe measures the SAME evidence the gate just checked rather
   * than a separately-derived path list that could drift from it.
   */
  const citedEvidencePaths = new Set<string>();
  // Setting the BAR metadata option selects its narrow waiver lane: the reason
  // must not also activate the separate code-truth waiver.
  const force = opts.force?.acceptanceBarProofMetadata === true ? undefined : opts.force;

  // A plan's Now/decision prose is the durable hand-off read by the independent
  // grader. Refuse a ship when it cites only a scratch path, loopback preview, or
  // Claude Artifact URL and never names the durable companion that survives that
  // presentation surface. This is intentionally NOT part of `force`: force is
  // scoped to code-truth evidence waivers, while this guard protects the grader's
  // ability to inspect the promised deliverable at all.
  const deliverableDurability = await evaluateEphemeralDeliverableDurabilityInStore(planContent ?? '', activeWorkspaceId());
  if (!deliverableDurability.satisfied) {
    const listed = locateEphemeralDeliverableReferences(planContent ?? '', deliverableDurability.references).join(', ');
    const unresolved = deliverableDurability.unresolvedCompanions.length > 0
      ? ` The cited platform artifact(s) ${deliverableDurability.unresolvedCompanions.join(', ')} do not exist ` +
        `(or are retired) in this workspace.`
      : '';
    if (refuse({
      satisfied: false,
      code: 'ephemeral_deliverable_unbacked',
      message:
        `plan '${planSlug}' cannot be marked shipped: its content cites ${listed} without an explicit durable ` +
        `companion/source reference.${unresolved} Persist the report in committed repository, plan, or work-item ` +
        `storage, or publish it with reports:publish, then record it in the plan as \`durable source: <path>\`, ` +
        `\`durable source: rpt_…\` (or \`work-item: EI-/WI-id\`). An Artifact URL, scratch path, or loopback preview ` +
        `alone is not a grader-readable deliverable. This refusal is not waived by force: { reason }.`,
    })) return collectedRefusal();
  }

  const itemGate = await getFlag(FLAGS.PLAN_ITEM_COMPLETION_GATE, 'system').catch(() => true);
  const gradingRecruitmentTail = new Set<string>();
  if (itemGate) {
    // planHarnessSlug is the positively selected plan row's own harness (ambiguity is
    // refused above), so it is safe to scope the per-(harness, slug) item rows to it.
    const items = await getPlanItemStatuses(planSlug, { harnessSlug: planHarnessSlug });
    const unfinished = items.filter((i) => (UNFINISHED_ITEM_STATUSES as readonly string[]).includes(i.status));
    if (unfinished.length > 0) {
      const recruitmentTail =
        opts.gradingRecruitment && unfinishedItemsAreAuditedNonCode(
          unfinished, await getEffectiveItemAudits(planSlug),
          // P-004: resolve each verdict under the plan's stamped profile and declared deliverable.
          { verificationProfile: planVerification.verificationProfile },
        );
      if (recruitmentTail) {
        for (const item of unfinished) gradingRecruitmentTail.add(item.itemId);
      }
      if (!recruitmentTail) {
        if (force) {
          forcedChecks.push('plan_items_unfinished');
        } else {
          const list = unfinished.map((i) => `${i.itemId} (${i.status})`).join(', ');
          if (refuse({
            satisfied: false,
            code: 'plan_items_unfinished',
            message:
              `plan '${planSlug}' cannot be marked shipped: ${unfinished.length} item(s) are still unfinished — ` +
              `${list}. Finish them, or — if the work went elsewhere and that was deliberate — DROP each one ` +
              `with a reason: plans:set-status { slug:'${planSlug}', item:'<P-NNN>', status:'dropped', ` +
              `note:'<why this was departed from>' }. Departing from the plan is legitimate; departing from it ` +
              `silently is what this refuses. To ship anyway, pass force:{ reason } — it is recorded on the plan.`,
          })) return collectedRefusal();
        }
      }
    }
  }

  const auditGate = await getFlag(FLAGS.PLAN_CODE_AUDIT_GATE, 'system').catch(() => true);
  if (auditGate) {
    const audit = await getLatestPlanAudit(planSlug);
    if (!audit) {
      if (force) {
        forcedChecks.push('acceptance_unaudited');
      } else if (refuse({
          satisfied: false,
          code: 'acceptance_unaudited',
          message:
            `plan '${planSlug}' cannot be marked shipped: it has no code-truth audit. Compare every item to ` +
            `the ACTUAL CODE — not the plan text, not the work-item records, not your memory of writing it — ` +
            `then file what you found: plans:audit { slug:'${planSlug}', items:[{ itemId, verdict, citations }] }. ` +
            `Citations are resolved against the real tree, so a path that does not exist is refused. Gaps inside ` +
            `the plan's scope get fixed or dropped with a reason; bugs outside it go in \`findings\` with a filed ` +
            `work-item ref. To ship without one, pass force:{ reason } — it is recorded on the plan.`,
        })) {
        return collectedRefusal();
      }
    } else {
      // D-006/D-007: a pass is NOT a full-plan snapshot. Resolve the latest entry
      // per item across every pass, then compare only that item's requirement and
      // evidence with the current tree. A narrow re-audit therefore cannot make all
      // the unchanged items disappear, and carrying an item cannot re-stamp it.
      const [items, effectiveAudits] = await Promise.all([
        getPlanItemStatuses(planSlug, { harnessSlug: planHarnessSlug }),
        getEffectiveItemAudits(planSlug),
      ]);
      const effectiveByItem = new Map(effectiveAudits.map((entry) => [entry.entry.itemId, entry]));
      const stale: string[] = [];
      const broken: string[] = [];
      const codeUnverified: string[] = [];
      const hasRepoFileCitations = effectiveAudits.some(({ entry }) =>
        entry.citations.some(isRepoFileCitation),
      );
      const citationContextResult = hasRepoFileCitations
        ? await repoCitationContextForHarness(
            audit.harnessSlug,
            effectiveAudits.flatMap(({ entry }) => entry.citations),
          )
        : null;
      const citationContext =
        citationContextResult && !isCitationContextFailure(citationContextResult) ? citationContextResult : null;

      if (hasRepoFileCitations && !citationContext) {
        if (isCitationContextFailure(citationContextResult)) {
          broken.push(
            ...citationContextResult.citations.map(
              (citation) => `${citation.path ?? '(no path)'} (${citation.reason})`,
            ),
          );
        } else {
          broken.push(`audit harness '${audit.harnessSlug}' has no registered canonical source root`);
        }
      }

      // P-019 (proof-freshness-pinned-candidate-2026-10-06 D-001): compare audited blobs
      // with the COMMITTED bytes at one measurement commit M per repository, not the
      // shared working tree, so a peer's uncommitted edit to a cited file cannot stale a
      // shipped audit. A committed change still reads stale. Citations M cannot measure
      // keep the working-tree fingerprint.
      const measurement = citationContext
        ? await measureCitationBlobsAtHead(
            effectiveAudits.flatMap(({ entry }) => entry.citations),
            citationContext.deps,
          ).catch(() => null)
        : null;
      // plan-verification-profiles P-003 (R-8): a generic citation is fresh only while its
      // target still hashes to the value plans:audit stamped. Same loader as the audit, so
      // both hashes come from one query. A failed load leaves every target unmeasured,
      // which reads stale, never fresh.
      const genericLookup = await loadGenericCitationLookupForWorkspace(
        effectiveAudits.flatMap(({ entry }) => entry.citations),
        activeWorkspaceId(),
      ).catch(() => new Map());

      for (const item of items) {
        // A deliberate drop is the recorded exit supplied by D-002. It does not need
        // code evidence and must not be resurrected as an audit obligation.
        if (item.status === 'dropped') continue;

        const effective = effectiveByItem.get(item.itemId);
        if (!effective) {
          stale.push(`${item.itemId}: no audit entry`);
          continue;
        }

        const reasons: string[] = [];
        const { entry, auditSeq } = effective;
        if (
          (UNFINISHED_ITEM_STATUSES as readonly string[]).includes(item.status) &&
          !gradingRecruitmentTail.has(item.itemId)
        ) {
          reasons.push(`status '${item.status}' is unfinished/reopened since audit #${auditSeq}`);
        }
        if (!entry.itemTextHash) {
          reasons.push(`item-text fingerprint is missing from audit #${auditSeq}`);
        } else if (!planItemTextHashCandidates(item.itemText).includes(entry.itemTextHash)) {
          reasons.push(`item text changed since audit #${auditSeq}`);
        }

        for (const citation of entry.citations) {
          if (!isGenericCitationKind(citation.kind)) continue;
          const staleReason = genericCitationStaleReason(citation, genericLookup, auditSeq);
          if (staleReason) reasons.push(staleReason);
        }

        // P-004 (R-11, D-009): whether this entry carries a code/test citation that RESOLVES
        // against the tree. Set below, only after a citation passes resolution.
        let hasResolvingCodeCitation = false;
        if (citationContext) {
          for (const citation of entry.citations) {
            // D-008: only code/test citations constitute verification. A path-backed doc
            // gets resolution and freshness checks, but never becomes code-truth evidence.
            if (!isRepoFileCitation(citation)) continue;
            const resolution = resolveCitation(citation, citationContext.deps);
            if (!resolution.ok) {
              broken.push(
                `${item.itemId} (audit #${auditSeq}) → ${citation.path ?? '(no path)'} (${resolution.reason})`,
              );
              continue;
            }

            // Collect only RESOLVED code/test citations: an unresolvable path is
            // already reported as `broken` and has no deployment position to ask about.
            if (isVerifyingCitation(citation) && citation.path?.trim()) {
              citedEvidencePaths.add(citation.path.trim());
              hasResolvingCodeCitation = true;
            }

            const rel = citation.path?.trim() ?? '';
            const measuredAt = measurement?.commits.get(rel);
            const currentBlobSha = measuredAt
              ? (measurement!.blobs.get(rel) ?? null)
              : citationBlobSha(citation, citationContext.deps);
            const at = measuredAt ? ` at commit ${measuredAt.slice(0, 12)}` : '';
            if (!citation.blobSha) {
              reasons.push(`${citation.path ?? '(no path)'} has no audit-time blob fingerprint (audit #${auditSeq})`);
            } else if (!currentBlobSha) {
              reasons.push(
                measuredAt
                  ? `${citation.path ?? '(no path)'} is not a committed file${at} (audit #${auditSeq})`
                  : `${citation.path ?? '(no path)'} cannot be fingerprinted now (audit #${auditSeq})`,
              );
            } else if (currentBlobSha !== citation.blobSha) {
              reasons.push(`${citation.path ?? '(no path)'} changed since audit #${auditSeq}${at}`);
            }
          }
        }

        if (reasons.length > 0) stale.push(`${item.itemId}: ${reasons.join('; ')}`);

        // P-004 (R-11, D-009): resolve under the declarations in force NOW (plan profile,
        // declared deliverable, effective verdict), the same rule as the R-15 ship check.
        const verification = resolveVerification(
          { verificationProfile: planVerification.verificationProfile },
          { deliverable: item.deliverable ?? null, auditVerdict: entry.verdict },
        );
        if (verification.codeDeliverable && !hasResolvingCodeCitation) {
          codeUnverified.push(
            `${item.itemId} (deliverable 'code' from ${verification.deliverableSource}; audit #${auditSeq} ` +
            `verdict '${entry.verdict}')`,
          );
        }
      }

      // Keep the advertised refusal order: coverage/text/blob drift first, broken
      // citations second, and both ahead of rubric ceremony. A force records every
      // check it waived instead of hiding later failures behind the first one.
      if (stale.length > 0) {
        if (force) {
          forcedChecks.push('audit_coverage_stale');
        } else if (refuse({
            satisfied: false,
            code: 'audit_coverage_stale',
            message:
              `plan '${planSlug}' cannot be marked shipped: ${stale.length} item audit(s) are missing or stale — ` +
              `${stale.join('; ')}. Re-run plans:audit for ONLY the listed items. Every unlisted item carries ` +
              `forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. ` +
              `If no items are listed on a future check, no new audit pass is required. To ship anyway, pass ` +
              `force:{ reason }.`,
          })) {
          return collectedRefusal();
        }
      }

      if (broken.length > 0) {
        if (force) {
          forcedChecks.push('audit_citations_unresolved');
        } else if (refuse({
            satisfied: false,
            code: 'audit_citations_unresolved',
            message:
              `plan '${planSlug}' cannot be marked shipped: ${broken.length} effective audit citation(s) no ` +
              `longer resolve against the tree — ${broken.slice(0, 5).join('; ')}` +
              `${broken.length > 5 ? ` (+${broken.length - 5} more)` : ''}. Re-run plans:audit for ONLY the ` +
              `listed items; all other item audits carry forward unchanged. To ship anyway, pass force:{ reason }.`,
          })) {
          return collectedRefusal();
        }
      }

      // ── REQUIREMENT REALIZATION (design-to-code-coverage-seam-2026-09-02 P-014) ──
      // Join the ACTIVATION audit to the COMPLETION audit. Both datasets already
      // existed, both are keyed by plan_slug, and nothing had ever compared them — so
      // a requirement could be dispositioned `covered` while the plan item it was
      // routed to carried no verifying citation. The activation audit then asserts the
      // requirement was absorbed while the completion audit records that nothing was
      // proven. Each half is individually valid; only the join sees the disagreement.
      //
      // Placed last in the code-truth family and still ahead of rubric ceremony, for
      // the same reason as its siblings: a plan whose requirements are not realized
      // must be sent to realize them. A generic code-truth waiver cannot make a
      // missing requirement true or authorize a leader to move it to a later plan.
      //
      // KNOWN LIMIT, stated rather than left to be discovered later:
      // getLatestActivationAudit swallows read errors and returns null, so "no
      // activation audit exists" — common and legitimate, since plans predating the
      // activation-audit regime have none — is indistinguishable here from "the
      // activation audit could not be READ". Both skip the join, so this is a
      // fail-OPEN. It is accepted only because it exactly preserves pre-P-014
      // behaviour: a plan with no readable activation audit was already shippable, so
      // the join can never make a plan LESS safe than it was. Tightening it means
      // giving that reader a distinguishable failure result — the same repair the
      // rubric family already made with `acceptance_rubric_revision_unreadable`
      // (EI-21827040531672903) — which is a separate item, not this one.
      const activationAudit = await getLatestActivationAudit(planSlug);
      const activationMappings = activationAudit?.activation?.mappings ?? [];
      if (activationMappings.length > 0) {
        // The BAR projection census cannot see non-behavioral inventory clauses.
        // Resolve that existing exemption contract only for reasoned not-code items;
        // a failed clause read leaves the requirement unproven.
        const nonCodeItems = items.filter((item) => item.status === 'done' &&
          isReasonedNonCodeAudit(effectiveByItem.get(item.itemId)?.entry));
        const exemptionProofs = nonCodeItems.length && planHarnessSlug
          ? await listSpecClauses({
              planSlug, harnessSlug: planHarnessSlug, workspaceId: activeWorkspaceId(),
              planItemIds: nonCodeItems.map((item) => item.itemId),
            }).then((clauses) => deriveNonCodeExemptionProofs({ planSlug, clauses, planItems: nonCodeItems }))
              .catch(() => [])
          : [];
        const realization = judgeRequirementRealization({
          mappings: activationMappings,
          itemAudits: effectiveAudits,
          nonCodeItemProofs: [...nonCodeItemProofs, ...exemptionProofs],
          // P-016 / D-040: without this the judge resolves every `P-NNN` target against
          // the folded audit alone, which spans all passes and is never filtered by the
          // plan's current items — so an item deleted from the plan keeps vouching for
          // the requirement routed to it. `items` is the same list the drift loop above
          // used, and its empty-on-read-failure case is handled inside the judge.
          planItems: items,
        });
        // D-035: capture the exemption BEFORE the refusal branch. These mappings are not
        // violations and must never gate — but they were previously computed and dropped,
        // so nothing ever saw the population that passed by not being judged at all.
        requirementExemptions = realization.exemptMappings;
        // P-016 / D-040: likewise captured before the refusal branch — a dropped target is
        // reported, never a violation, so it must survive a SATISFIED verdict.
        requirementDroppedTargets = realization.droppedTargets;
        if (!realization.ok) {
            const lines = realization.unrealized.map(describeUnrealized);
            if (refuse({
              satisfied: false,
              code: 'requirement_unrealized',
              message:
                `plan '${planSlug}' cannot be marked shipped: ${realization.unrealized.length} requirement(s) ` +
                `the activation audit dispositioned covered/repaired never reached a VERIFIED plan item — ` +
                `${lines.slice(0, 5).join('; ')}${lines.length > 5 ? ` (+${lines.length - 5} more)` : ''}. ` +
                `Each names a requirement the plan claims it absorbed. Code verification requires code/test ` +
                `citations (D-008); a completed, reasoned not-code outcome instead requires exact current ` +
                `operational/check BAR proof or a current explicit non-behavioral exemption. ` +
                `Doc/none citations alone prove neither. Audit the named ` +
                `item(s) against real code or bind current proof for the non-code outcome; if the requirement was not ` +
                `absorbed — correct its disposition to 'rejected'/'open' via plans:audit { phase:'activation' } ` +
                `so the record stops claiming otherwise. Unfulfilled requirements are not waived by force; ` +
                `a follow-on task or disclosure is not fulfillment of the original promise.`,
            })) return collectedRefusal();
        }
      }

      // P-004 (R-11, SPEC-P-004, D-009): a code deliverable keeps the code module's
      // code-truth check in EITHER profile. Evidence, not the verdict, decides, so the
      // completion audit's "verdicts record" rule holds. After the realization join, so its
      // more specific requirement refusal leads in first-failure mode. Force-waivable like
      // its code-truth siblings: a code item in a general plan gets what a coding plan gives it.
      if (codeUnverified.length > 0) {
        if (force) {
          forcedChecks.push('code_deliverable_unverified');
        } else if (refuse({
            satisfied: false,
            code: 'code_deliverable_unverified',
            message:
              `plan '${planSlug}' cannot be marked shipped: ${codeUnverified.length} code deliverable(s) have no ` +
              `code/test citation that resolves against the tree — ${codeUnverified.slice(0, 5).join('; ')}` +
              `${codeUnverified.length > 5 ? ` (+${codeUnverified.length - 5} more)` : ''}. ` +
              `${describeVerificationProfile(planVerification)}; failing verification module 'code' ` +
              `(check 'code-truth-audit'). A code deliverable keeps full code verification in any profile: ` +
              `re-run plans:audit for the listed item(s) citing the code/test files that implement them. If an ` +
              `item's deliverable is genuinely not source, audit it 'not-code' with a note (undeclared deliverable ` +
              `only), or lower its declared deliverable with a recorded plan Decision and a fresh activation audit. ` +
              `To ship anyway, pass force:{ reason }.`,
          })) {
          return collectedRefusal();
        }
      }
    }
  }

  // ── R-15 at ship (plan-verification-profiles-2026-10-17 P-005, D-008) ────────
  // Completion refuses a non-code deliverable whose close carries code-change evidence, but
  // it judges the declaration in force AT CLOSE. Lowering an item's deliverable (or the plan
  // profile) after its code completion would let that code skip the code module, so ship
  // re-runs the same check against the declarations in force now. Not waived by force, like
  // requirement_unrealized: a waiver would re-open exactly the escape this closes. An
  // unreadable check refuses rather than passing silently.
  if (planHarnessSlug) {
    let shipHits: Awaited<ReturnType<typeof readNonCodeDeliverableShipEvidence>> | null = null;
    let shipReadError: string | null = null;
    try {
      shipHits = await readNonCodeDeliverableShipEvidence({
        workspaceId: activeWorkspaceId(),
        harnessSlug: planHarnessSlug,
        planSlug,
      });
    } catch (error) {
      shipReadError = error instanceof Error ? error.message : String(error);
    }
    if (shipReadError !== null) {
      if (refuse({
        satisfied: false,
        code: 'non_code_deliverable_check_unavailable',
        message:
          `plan '${planSlug}' cannot be marked shipped: the check that each non-code deliverable's closed work ` +
          `items carry no code-change evidence could not read its inputs (${shipReadError}). Retry the ship; ` +
          `this refusal is not waived by force.`,
      })) return collectedRefusal();
    } else if (shipHits && shipHits.length > 0) {
      const lines = shipHits.map((hit) =>
        describeNonCodeDeliverableCodeEvidence(`work item ${hit.workItemId}`, `${planSlug}#${hit.itemId}`, hit.evidence));
      if (refuse({
        satisfied: false,
        code: 'non_code_deliverable_code_evidence',
        message:
          `plan '${planSlug}' cannot be marked shipped: ${shipHits.length} closed work item(s) carry code-change ` +
          `evidence under a non-code deliverable. ${lines.slice(0, 3).join(' ')}` +
          `${lines.length > 3 ? ` (+${lines.length - 3} more)` : ''} This refusal is not waived by force.`,
      })) return collectedRefusal();
    }
  }

  // ── the SPEC-PROOF check (first-class-spec-clauses-…-2026-08-20 P-008) ───────
  // Last of the code-truth family and still ahead of rubric ceremony, for the reason
  // the audit checks are: a plan whose promises are no longer proven should be sent to
  // re-prove them, not to author a rubric. The audit asks whether the CODE still matches
  // what was claimed; this asks whether the PROMISE is still proven at the revision that
  // is actually in force — a clause revised after its evidence was recorded has green
  // proof for a promise nobody makes any more.
  //
  // Independently flagged, and `force`-waivable like its code-truth siblings: it is an
  // evidence-truth check, not the separate owner ruling the rubric family encodes.
  let specCoverage: PlanSpecCoverageGateVerdict | undefined;
  const specCoverageGate = await getFlag(FLAGS.PLAN_SPEC_COVERAGE_GATE, 'system').catch(() => true);
  if (specCoverageGate) {
    specCoverage = await evaluatePlanSpecCoverageGate({
      ...(planHarnessSlug ? { harnessSlug: planHarnessSlug } : {}),
      planSlug,
    });
    if (!specCoverage.satisfied) {
      // ⚠ Carry the census's OWN code through rather than hardcoding one. This said
      // `spec_proof_stale` on both legs, which was true while that was the only refusal
      // this gate could produce. P-013 added `spec_clause_unproven`, and a hardcoded code
      // would have reported "proven only at a superseded revision" for a clause that has
      // no proof at all — telling the author to re-bind evidence that was never there.
      // A misdiagnosis is worse than a bare refusal: it sends someone to fix the wrong
      // thing and reads as authoritative while doing it.
      const code = specCoverage.code ?? 'spec_proof_stale';
      if (force) {
        forcedChecks.push(code);
      } else if (refuse({
          satisfied: false,
          code,
          message: specCoverage.message ?? `plan '${planSlug}' has spec clauses proven only at a superseded revision.`,
          specCoverage,
        })) {
        return collectedRefusal();
      }
    }
  }

  // ── INDEPENDENT VERIFICATION (verification-system-improvements-2026-10-10 P-008) ──
  // A live/deployed mandatory outcome bar must carry a binding from OUTSIDE the
  // implementers' lineage that re-observed the implementer's evidence (D-005). Placed
  // after spec proof (no point asking for re-observation of unproven clauses) and NOT
  // waivable by force: it is an independence check, the same class as independent
  // grading, which force never waives.
  if (planHarnessSlug) {
    const independentVerification = await evaluateIndependentVerificationGate({
      planSlug,
      harnessSlug: planHarnessSlug,
    });
    if (!independentVerification.satisfied && refuse({
      satisfied: false,
      code: independentVerification.code ?? 'independent_verification_missing',
      message: independentVerification.message ?? `plan '${planSlug}' lacks independent verification of live evidence.`,
    })) {
      return collectedRefusal();
    }
  }

  // ── BLIND GAP REVIEW (verification-system-improvements-2026-10-10 P-006) ──────────
  // The awaiting-acceptance writers already require it (D-006 (1)); the ship door
  // re-checks it for the revision being shipped, because a plan can be re-activated
  // after its review or reach ship without passing through awaiting-acceptance.
  // Not waivable by force (D-039 (5)): an independence check, like the door above.
  if (planHarnessSlug) {
    const blindReview = await evaluateBlindReviewGate({ planSlug, harnessSlug: planHarnessSlug });
    if (!blindReview.satisfied && refuse({
      satisfied: false,
      code: blindReview.code ?? 'blind_review_missing',
      message: blindReview.message ?? `plan '${planSlug}' has no blind gap review for its current revision.`,
    })) {
      return collectedRefusal();
    }
  }

  // Re-read every design obligation at shipment. An earlier item completion or
  // passing rubric is not current evidence for a changed source/build.
  if (planHarnessSlug) {
    try {
      const outcomes = await planDesignEvidenceGate(planSlug, planHarnessSlug);
      const blocked = outcomes.filter(outcome =>
        (outcome.status === 'unsatisfied' || outcome.status === 'unavailable') && outcome.enforced);
      if (blocked.length && refuse({
        satisfied: false,
        code: blocked.some(row => row.status === 'unsatisfied') ? 'design_evidence_unsatisfied' : 'design_evidence_unavailable',
        message: blocked.map(row => row.status === 'not-applicable' ? '' : row.report).join('\n\n'),
      })) return collectedRefusal();
    } catch (error) {
      if (refuse({ satisfied: false, code: 'design_evidence_unavailable', message: `Design shipment proof could not be read: ${error instanceof Error ? error.message : String(error)}` })) {
        return collectedRefusal();
      }
    }
  }

  // ── the RUBRIC family (acceptance-rubrics-on-every-plan-2026-08-11) ──────────
  // Independently flagged, and NOT waivable by `force` (D-005): it encodes a separate
  // owner ruling, and collapsing both families into one switch would make the override
  // far broader than the one that was actually authorised.
  if (!rubricGate) {
    if (preGradingRefusals.length > 0) return collectedRefusal();
    return {
      satisfied: true,
      skipped: 'flag-off',
      ...(specCoverage ? { specCoverage } : {}),
      ...(forcedChecks.length > 0 && opts.force ? { forcedPast: { reason: opts.force.reason, checks: forcedChecks } } : {}),
    };
  }

  const rubrics = await getAcceptanceRubricsForPlan(planSlug, {
    ...(planHarnessSlug ? { harnessSlug: planHarnessSlug } : {}),
  });
  // Rubric existence/uniqueness: every later check needs exactly ONE rubric, so collect
  // mode records the refusal and stops here with everything gathered so far.
  if (rubrics.length === 0) {
    refuse({
      satisfied: false,
      code: 'acceptance_rubric_missing',
      message:
        `plan '${planSlug}' cannot be marked shipped: it has no acceptance rubric ` +
        `(acceptance-rubrics-on-every-plan-2026-08-11). Author it NOW, post-implementation (D-007 — it is ` +
        `better informed against the as-built work): rubrics:propose { kind:'acceptance', subjectPlan:'${planSlug}', ` +
        `classRef:'<${PLAN_CLASS_RUBRIC_REFS.join('|')}>', ` +
        `criteria:[3–7 outcomes tracing to the plan's goal + Decisions — never merely describing the diff] } ` +
        `(a pure investigation may pass classRef:'plan-class-investigation' with criteria:[] — D-009). ` +
        `It activates immediately (no ratification); then a ` +
        `NON-implementer grades it (scorecards:emit) and the ship succeeds.`,
    });
    return collectedRefusal();
  }
  if (rubrics.length > 1) {
    refuse({
      satisfied: false,
      code: 'acceptance_rubric_ambiguous',
      message:
        `plan '${planSlug}' cannot be marked shipped: it has multiple active acceptance rubrics ` +
        `(${rubrics.map((candidate) => `'${candidate.rubricId}'`).join(', ')}). ` +
        'Retire all but one contract before shipping; the gate fails closed when one subject plan has competing rubrics.',
    });
    return collectedRefusal();
  }
  const rubric = rubrics[0];

  // ── the VETTING check (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──
  // Ordered BEFORE the grading checks because it is the earlier step of the flow: the
  // rubric AUTHOR vets the RUBRIC (informed by a get_feedback consult whose responder
  // bound is the `rubric-vetting` selection policy — never a count written here)
  // before a non-implementer grades the WORK against it. The pass is the
  // vetting agent's ATTESTATION — a complete meta-scorecard on the CURRENT rubric
  // revision with a linked consult; deliberately NO mechanical score floor (D-001 §3),
  // so the ratings' values are never inspected here. Independently flagged and, like
  // the sibling rubric checks, NOT waivable by `force` (D-005).
  const vettingGate = await getFlag(FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE, 'system').catch(() => true);
  // EI-20821478338037350: carried out of the vetting block so the SATISFIED verdict can
  // report a no-critique waiver. Set only when the attesting card says so explicitly.
  let vettedUnderWaiver: { consultId: string; reason?: string } | undefined;
  // EI-21827040531672903: the attesting card's timestamp, carried out of the vetting
  // block so the grading checks below can enforce that vetting PRECEDED grading. Left
  // undefined when the vetting gate did not run (flag off, criteria:[] investigation
  // rubric, no registered meta-rubric) — the ordering leg then has nothing to order
  // against and is correctly skipped rather than guessed at.
  let vettingAttestedAt: string | undefined;
  let gradingInputsAvailable = true;
  // Exempt: a criteria:[] investigation rubric (D-009 — nothing to vet) and the
  // meta-rubric itself (kind:'standard' so it can never be a plan's acceptance rubric,
  // but the guard is cheap and the regress would be infinite).
  if (vettingGate && rubric.criteria.length > 0 && rubric.rubricId !== META_ACCEPTANCE_RUBRIC_ID) {
    // Prerequisite: a REGISTERED meta-rubric, any status — 'proposed' counts, because
    // ratification governs content authority, not gate mechanics; a workspace with no
    // meta-rubric at all cannot run the flow, so the check disables rather than
    // deadlocking every ship on a missing prerequisite (recorded as a plan Decision).
    const metaRubric = await getRubric(META_ACCEPTANCE_RUBRIC_ID);
    // EI-21827040531672903: a FAILED revision read must not be spelled the same way
    // as "no revision". The old `currentRevision == null || …` short-circuited TRUE
    // on the null a transient DB error produced, silently widening the check from
    // "attested at the CURRENT revision" to "any vetted card that ever existed" and
    // rendering no refusal, so nothing recorded the degradation. Refuse instead: an
    // unreadable revision is a retryable infrastructure fault, not a pass. In collect
    // mode the vetting evaluation is skipped (it needs the revision) and the barrier
    // below stops before grading.
    const revisionRead = metaRubric ? await readRubricPlanRevision(rubric.rubricId) : null;
    if (revisionRead && !revisionRead.ok) gradingInputsAvailable = false;
    if (revisionRead && !revisionRead.ok && refuse({
      satisfied: false,
      code: 'acceptance_rubric_revision_unreadable',
      rubricId: rubric.rubricId,
      message:
        `plan '${planSlug}' cannot be marked shipped right now: the current revision of acceptance rubric ` +
        `'${rubric.rubricId}' could not be read, so the gate cannot confirm the vetting attestation covers ` +
        `what ships. This is an infrastructure fault, not a missing step — nothing about the plan is wrong. ` +
        `Retry the ship; if it persists, the rubric plan-row read is failing and that is the thing to fix.`,
    })) return collectedRefusal();
    if (metaRubric && revisionRead?.ok) {
      const currentRevision = revisionRead.revision;
      // Keep the ship-time gate on the same vetting policy as rubrics:get,
      // scorecards:emit, and bind. Reuse the already-read meta-rubric and revision
      // so this gate's unreadable-revision refusal remains authoritative.
      const vettingStatus = await getAcceptanceRubricVettingStatus(rubric, {
        vettingGateEnabled: true,
        getRubric: async () => metaRubric,
        getRubricPlanRevision: async () => currentRevision,
        listScorecards,
        readCurrentCritique: opts.readCurrentCritique,
        ...(opts.readGradingAuditDispatchSuppression
          ? { readGradingAuditDispatchSuppression: opts.readGradingAuditDispatchSuppression }
          : {}),
      });
      const current = vettingStatus.candidates.find((candidate) => candidate.rejectedBy === null);
      if (vettingStatus.required && !vettingStatus.satisfied) {
        const vettedRevisions = vettingStatus.attestedRevisions;
        const stale = vettingStatus.reason === 'stale-attestation';
        // A subject-less historical meta-card cannot be returned by the
        // subjectRef-filtered read above, but it is still useful diagnostic
        // evidence: it explains how an emitter could believe vetting happened
        // while the gate correctly found no card bound to this rubric. Keep the
        // note explicitly unattributed rather than guessing which rubric the
        // malformed card intended to attest.
        const unboundMetaCards = stale
          ? []
          : (await listScorecards({ rubricRef: META_ACCEPTANCE_RUBRIC_ID, limit: 50 })).filter(
              (s) => s.rubricResolved && s.missingKeys.length === 0 && !s.synthesized && !s.subject,
            );
        const unboundIds = unboundMetaCards.slice(0, 3).map((s) => s.issueId);
        const unboundDiagnostic =
          unboundIds.length > 0
            ? ` A subject-less meta-scorecard exists in history (${unboundIds.join(', ')}${
                unboundMetaCards.length > unboundIds.length ? ', …' : ''
              }), but it names no acceptance rubric and cannot establish current critique.`
            : '';
        const candidateDiagnostic = vettingStatus.diagnosis
          ? ` Candidate diagnostics: ${vettingStatus.diagnosis}.`
          : '';
        if (refuse({
          satisfied: false,
          code: 'acceptance_rubric_unvetted',
          rubricId: rubric.rubricId,
          message: (stale
            ? `plan '${planSlug}' cannot be marked shipped: acceptance rubric '${rubric.rubricId}' was vetted at ` +
              `revision ${vettedRevisions.join('/') || '(unrecorded)'} but the rubric identity now in force is ` +
              `revision ${currentRevision ?? '(unrecorded)'}, criteriaHash ${rubric.criteriaHash ?? '(unrecorded)'}. ` +
              `The graded criteria or method changed after vetting, or the recorded/live identity is incomplete; ` +
              `Obtain independent critique of '${rubric.rubricId}' naming current criteriaHash ` +
              `'${rubric.criteriaHash ?? '(unrecorded)'}' or revision ${currentRevision ?? '(unrecorded)'}. ` +
              `The consult or review work-item records satisfy vetting directly.${candidateDiagnostic}`
            : `plan '${planSlug}' cannot be marked shipped: its acceptance rubric '${rubric.rubricId}' has not ` +
              `been VETTED against the meta-rubric (consult-min-max-and-rubric-vetting-2026-08-17). The rubric ` +
              `AUTHOR vets it BEFORE a non-implementer grades the work: (1) consult:get_feedback for external ` +
              `critique of the rubric — ${rubricVettingConsultHint()}. Name '${rubric.rubricId}' and current ` +
              `criteriaHash '${rubric.criteriaHash ?? '(unrecorded)'}' or revision ${currentRevision ?? '(unrecorded)'} ` +
              `in the opening request; (2) improve the rubric from the critique as needed. ` +
              `Current independent critique is read directly; no attestation card or attestation audit is required. ` +
              `${unboundDiagnostic ? unboundDiagnostic.slice(1) : ''}` +
              `${candidateDiagnostic}`),
          ...(vettingStatus.gradingAuditDispatchSuppressed
            ? { gradingAuditDispatchSuppressed: vettingStatus.gradingAuditDispatchSuppressed }
            : {}),
        })) return collectedRefusal();
      } else if (vettingStatus.required && (current || vettingStatus.critique)) {
        vettingAttestedAt = vettingStatus.critique?.createdAt ?? current?.createdAt;
        if (vettingStatus.vettedUnderWaiver) vettedUnderWaiver = vettingStatus.vettedUnderWaiver;
      }
    }
  }

  // A known rubric permits independent grading checks even when earlier proof is
  // blocked. Unknown revision inputs cannot support grading-currentness conclusions.
  if (!gradingInputsAvailable) return collectedRefusal();

  // A qualifying grading: complete (every criterion rated), agent-emitted (synthesized
  // floors are excluded by listScorecards' default), against THIS rubric.
  // Read the audit lineage as well as the standing cards. New writers refuse an
  // acceptance-author verdict that `supersedes` its independent grading, because
  // both halves must remain independently visible. Older deployed writers briefly
  // allowed that shape, though, and the default read then hides the predecessor —
  // stranding an otherwise-valid plan at `self_graded_only` forever. Below we admit
  // only that one legacy edge: the direct predecessor named by a STANDING author
  // acceptance card. Arbitrary superseded history remains ineligible.
  const scorecards = await listScorecards({ rubricRef: rubric.rubricId, limit: 50, includeSuperseded: true });
  const allComplete = scorecards.filter(
    (s) =>
      s.rubricResolved &&
      s.missingKeys.length === 0 &&
      !s.synthesized &&
      (!requireCurrentBarGrading ||
        (classifyRubricEvidenceCurrentness(
          {
            revision: s.rubricRevision,
            criteriaHash: s.criteriaHash,
            meaningRevision: s.rubricMeaningRevision,
          },
          {
            revision: rubric.revision,
            criteriaHash: rubric.criteriaHash,
            meaningRevision: rubric.barContract?.meaningRevision,
          },
        ).state === 'current' &&
          // WI-10002509: the rubric-revision test above cannot see a cohort-only
          // staleness — the card was graded against THIS revision, so it reads
          // current while the evidence it judged has since moved. The BAR already
          // made that call; honour it here or the deferred ship refusal is permanent
          // and the re-grade it defers for is never recruited.
          s.issueId !== barStaleGradingScorecardId)),
  );
  // WI-2141007: `createdBy` FIRST, matching `scorecards:emit` and
  // `grader-eligibility.ts`. This file previously read `proposedBy ?? createdBy`
  // — the OPPOSITE precedence. For a rubric whose later revision was
  // repair-proposed by a different agent, emit demanded the verdict come from
  // `createdBy` while this gate measured independence against `proposedBy`, so
  // the writer and the gate disagreed about who the author even was. They must
  // agree, or a seat succession stamped against emit's author is not recognized
  // here and the plan stays unshippable for a different reason than before.
  const implementer = rubric.createdBy ?? rubric.proposedBy ?? null;
  // `implementer` is the acceptance-author/seat identity and must stay separate
  // from the principal identities that actually implemented the subject plan.
  // The latter only widen the independent-grader exclusion population.
  let principalImplementers: string[];
  try {
    principalImplementers = await resolvePlanImplementerIdentities(rubric.subjectPlan ?? planSlug, {
      workspaceId: rubric.workspaceId,
    });
  } catch (error) {
    return gradingRefusal({
      satisfied: false,
      code: 'acceptance_lineage_unreadable',
      rubricId: rubric.rubricId,
      message:
        `plan '${planSlug}' cannot be marked shipped: the complete implementer/auditor lineage for ` +
        `acceptance rubric '${rubric.rubricId}' could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}). The gate refuses rather than ` +
        'shrinking the exclusion set and admitting a related grader; repair/retry the lineage read.',
    });
  }
  const principalImplementerIdentities = new Set(principalImplementers);
  const implementerIdentities = new Set<string>();
  if (implementer) {
    implementerIdentities.add(implementer);
  }
  const candidateIds = [...new Set(allComplete.map((s) => s.createdBy).filter((id): id is string => id != null))];
  await Promise.all(
    candidateIds.map(async (candidateId) => {
      if (
        implementer &&
        (await areAcceptanceLineageRelated(implementer, candidateId, { workspaceId: rubric.workspaceId }))
      ) {
        implementerIdentities.add(candidateId);
      }
      const principalRelated = await Promise.all(
        principalImplementers.map((principal) =>
          areAcceptanceLineageRelated(principal, candidateId, { workspaceId: rubric.workspaceId }),
        ),
      );
      if (principalRelated.some(Boolean)) principalImplementerIdentities.add(candidateId);
    }),
  );
  const isImplementerScorecard = (scorecard: (typeof allComplete)[number]) =>
    scorecard.createdBy != null && implementerIdentities.has(scorecard.createdBy);
  const isPlanImplementerScorecard = (scorecard: (typeof allComplete)[number]) =>
    scorecard.createdBy != null && principalImplementerIdentities.has(scorecard.createdBy);
  /**
   * WI-2141007: a verdict recorded by a SUCCESSOR to a dead rubric author holds
   * author authority even though its `createdBy` is, by construction, outside the
   * author's lineage. The `seat` stamp is written server-side by `scorecards:emit`
   * (`acceptance` is a `.strict()` zod object, so a caller cannot forge it), and
   * is honoured only when it names THIS rubric's author of record.
   *
   * Without this the repair would be self-defeating: the successor's card would
   * satisfy emit and then be misread here as an INDEPENDENT grading, leaving the
   * plan at `acceptance_not_recorded` — and, worse, letting that card stand in as
   * the independent grading it is not.
   */
  const isSeatSuccessorVerdict = (scorecard: (typeof allComplete)[number]) => {
    const seat = scorecard.acceptance?.seat;
    return seat != null && implementer != null && seat.succeededFrom === implementer;
  };
  /** Holds author authority: by identity/lineage, or by audited seat succession. */
  const holdsAuthorAuthority = (scorecard: (typeof allComplete)[number]) =>
    isImplementerScorecard(scorecard) || isSeatSuccessorVerdict(scorecard);
  const standingAuthorVerdicts = new Map(
    allComplete
      .filter(
        (s) => !s.supersededBy && holdsAuthorAuthority(s) && s.acceptance != null && typeof s.supersedes === 'string',
      )
      .map((s) => [s.issueId, s.supersedes!] as const),
  );
  const complete = allComplete.filter(
    (s) =>
      !s.supersededBy ||
      (standingAuthorVerdicts.get(s.supersededBy) === s.issueId &&
        // A legacy author verdict may restore only an INDEPENDENT predecessor.
        // Keeping this guard here prevents an author-authored correction chain
        // from manufacturing its own independent grader. A successor's verdict
        // counts as author-side here too (WI-2141007), or the same chain could be
        // manufactured one seat along.
        !holdsAuthorAuthority(s) &&
        !isPlanImplementerScorecard(s)),
  );
  if (complete.length === 0) {
    return gradingRefusal({
      satisfied: false,
      code: 'acceptance_ungraded',
      rubricId: rubric.rubricId,
      message:
        `plan '${planSlug}' cannot be marked shipped: its acceptance rubric '${rubric.rubricId}' has no complete ` +
        `grading. A NON-implementer${implementer ? ` (someone other than '${implementer}')` : ''} grades it — ` +
        `scorecards:emit { rubricRef:'${rubric.rubricId}', ratings:{ <every criterion key> } } with concrete ` +
        `evidence per rating — then the ship succeeds (grader ≠ implementer, plan D-005). ` +
        `${ACCEPTANCE_GRADING_NO_CLAIM_FACT} Say so when you ask: a peer declining on claim-scope grounds is ` +
        `declining on a constraint that does not exist (EI-20249725405239230).`,
    });
  }
  // ── the authoritative grading among several (P-004) ──
  // Grading is a CASCADE of up to two graders since D-003 [owner], and D-002
  // [owner] allows the second to be a BELOW-FLOOR minimum-fill. A plain
  // `sort(desc createdAt)[0]` was inert while grading was n=1; with a menu it
  // would hand the verdict to whoever happened to file last, which under those
  // two rulings together can be the party the router did NOT match. So rank by
  // selection authority first — `outranks('floor','minimum')` — and only then
  // by recency, which stays the tie-break that makes latest-wins coherent
  // between two equally-qualified graders (D-003: grader 2 holds grader 1's
  // card, so the later card is the better-informed one).
  //
  // The `via` comes from the DURABLE cascade row, not from the lifecycle return
  // value (D-006), and a card with no cascade provenance ranks as floor rather
  // than being demoted — see acceptance-grading-authority.ts for both.
  // ── who may grade THIS plan: asked of the RUBRIC, never inferred here (D-002) ──
  // generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 D-002 makes the
  // rubric the authority boundary, and D-001 forbids a per-goal branch. Before this the
  // filter below was the gate's ONLY branch, so `independent` was correct by accident
  // (it was the sole possibility) and `owner-authorized` could not be expressed at all.
  //
  // `owner-authorized` WIDENS and never replaces: the independence predicate is applied
  // unchanged, so every plan that shipped before this keeps shipping for the same reason.
  // What it adds is the case an independence-only gate can never satisfy — a plan the
  // OWNER drove themselves, where the owner is inside the implementer lineage and so is
  // correctly excluded by `isPlanImplementerScorecard`/`holdsAuthorAuthority`.
  const authority = rubricGradingAuthority(rubric);
  const isIndependentCard = (s: (typeof complete)[number]) =>
    !isPlanImplementerScorecard(s) && (!implementer || (s.createdBy != null && !holdsAuthorAuthority(s)));
  // WI-10003434: `allComplete` drops exactly the card the BAR named cohort-stale, but an
  // OLDER independent card at the same rubric revision predates the cohort move too — it
  // was graded before the stale card was, so it is at least as stale. Left in, it is
  // promoted to authoritative below, its (older, usually worse) ratings return the
  // NON-recruiting `acceptance_bar_not_met`, and the WI-10002509 re-grade path is dead
  // for every plan graded more than once at its current revision (measured on
  // identities-v1-2026-08-30: a 09-24 card's R-3/R-4/R-7 'partial' resurfaced after the
  // 09-27 card they had been re-rated past went cohort-stale). Author cards are NOT
  // excluded here: they are never independent, and the stale-wording branch needs them.
  const barStaleGradedAtMs = (() => {
    if (barStaleGradingScorecardId == null) return Number.NaN;
    const staleCard = scorecards.find((s) => s.issueId === barStaleGradingScorecardId);
    return staleCard ? Date.parse(staleCard.createdAt) : Number.NaN;
  })();
  const predatesCohortStaleCard = (s: (typeof complete)[number]) =>
    Number.isFinite(barStaleGradedAtMs) && Date.parse(s.createdAt) <= barStaleGradedAtMs;
  const isCohortStaleIndependent = (s: (typeof complete)[number]) =>
    isIndependentCard(s) && predatesCohortStaleCard(s);
  // WI-10003286: the exact set excluded here is what the recruiter must exclude too.
  const cohortStaleIndependentIds = complete.filter(isCohortStaleIndependent).map((s) => s.issueId);
  const independentCards = complete.filter((s) =>
    !isCohortStaleIndependent(s) &&
    gradingAuthorityAdmits({
      authority,
      isIndependent: isIndependentCard(s),
      // Tool-layer-VERIFIED owner provenance (identity.ts) — resolveAgentIdentity ties
      // this ownerId to the admin route's synthesized client id, which an ordinary agent
      // context cannot supply, so it is not a forgeable caller claim.
      isOwnerFiled: isOwnerFiledGrading(s, ADMIN_COORD_UI_OWNER),
    }),
  );
  const graderVia = await readGraderSelectionVia(rubric.workspaceId, rubric.rubricId);
  const independent = pickAuthoritativeGrading(independentCards, (s) => gradingViaOf(s, graderVia));
  const independentVia = independent ? gradingViaOf(independent, graderVia) : null;
  const unknownRatedCriteria = independent
    ? rubric.criteria
        .filter((criterion) => independent.ratings[criterion.key]?.rating.trim().toLowerCase() === 'unknown')
        .map((criterion) => criterion.key)
    : [];
  if (!independent) {
    const principalLabel =
      principalImplementers.length > 0 ? ` or a principal plan implementer (${principalImplementers.join(', ')})` : '';
    // Two very different states reach `!independent`, and the self-graded wording is
    // only true of one. When the card the BAR judged cohort-stale WAS an independent
    // grading, saying "only graded by its own author" is flatly false — a non-author
    // did grade it — and it hides the actual repair (refresh a stale grade, not
    // recruit a first one). Measured cost of the ambiguity: an agent read this
    // message, concluded no independent grader had ever looked at the plan, and
    // nearly filed a defect against the correctly-settled grading recruiter.
    const staleIndependent =
      barStaleGradingScorecardId == null
        ? undefined
        : scorecards.find(
            (s) =>
              s.issueId === barStaleGradingScorecardId &&
              !isPlanImplementerScorecard(s) &&
              !holdsAuthorAuthority(s),
          );
    const staleGradingScorecardIds = [
      ...new Set([...(staleIndependent ? [staleIndependent.issueId] : []), ...cohortStaleIndependentIds]),
    ];
    return gradingRefusal({
      satisfied: false,
      code: 'self_graded_only',
      rubricId: rubric.rubricId,
      ...(staleIndependent ? { staleGradingScorecardId: staleIndependent.issueId } : {}),
      ...(staleGradingScorecardIds.length > 0 ? { staleGradingScorecardIds } : {}),
      message: staleIndependent
        ? `plan '${planSlug}' cannot be marked shipped: acceptance rubric '${rubric.rubricId}' HAS an independent ` +
          `grading (scorecard ${staleIndependent.issueId}, by '${staleIndependent.createdBy}'), but the acceptance BAR ` +
          `judged it stale — the evidence cohort moved since it was graded — so it no longer counts. This is NOT a ` +
          `self-graded plan: what remains after excluding it is only the rubric author ('${implementer}')` +
          `${principalLabel}. The repair is a FRESH independent grading, not a first one. ` +
          `${ACCEPTANCE_GRADING_NO_CLAIM_FACT} Say so when you ask: a peer declining on claim-scope grounds is ` +
          `declining on a constraint that does not exist (EI-20249725405239230).`
        : `plan '${planSlug}' cannot be marked shipped: acceptance rubric '${rubric.rubricId}' is only graded by its ` +
          `own author ('${implementer}')${principalLabel} — grader ≠ implementer (plan D-005, the self-graded-homework guard). A ` +
          `different agent or the owner must file the grading scorecard. ` +
          `${ACCEPTANCE_GRADING_NO_CLAIM_FACT} Say so when you ask: a peer declining on claim-scope grounds is ` +
          `declining on a constraint that does not exist (EI-20249725405239230).`,
    });
  }

  // requirements-with-teeth-bar-before-method-2026-09-04 P-013 (landed early to
  // close P-012's deliberately committed red baseline): an author's acceptance
  // verdict is a process decision, never a waiver over the independently measured
  // outcome. Legacy criteria carry no structural bar policy and retain their prior
  // behavior; the lifecycle gate added by this plan separately makes that metadata
  // mandatory for the post-adoption cohort.
  const unmetMandatoryOutcomeBars = rubric.criteria.flatMap((criterion) => {
    const policy = criterion as typeof criterion & {
      role?: 'outcome' | 'disclosure';
      mandatory?: boolean;
      passRatings?: string[];
      barKey?: string;
    };
    if (policy.role !== 'outcome' || policy.mandatory !== true) return [];

    const rating = independent.ratings[criterion.key]?.rating?.trim() ?? null;
    const explicitPassRatings = (policy.passRatings ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
    const passes =
      rating != null &&
      (explicitPassRatings.length > 0
        ? explicitPassRatings.includes(rating.toLowerCase())
        : ratingVerdict(rating) === 'pass');
    return passes
      ? []
      : [
          {
            criterionKey: criterion.key,
            barKey: policy.barKey ?? criterion.key,
            rating,
          },
        ];
  });
  if (unmetMandatoryOutcomeBars.length > 0) {
    const detail = unmetMandatoryOutcomeBars
      .map(
        ({ criterionKey, barKey, rating }) =>
          `'${criterionKey}' (bar '${barKey}', rating ${rating == null ? 'missing' : `'${rating}'`})`,
      )
      .join(', ');
    if (refuse({
      satisfied: false,
      code: 'acceptance_bar_not_met',
      rubricId: rubric.rubricId,
      gradedBy: independent.createdBy ?? null,
      gradedVia: independentVia,
      ...(unknownRatedCriteria.length > 0 ? { unknownRatedCriteria } : {}),
      message:
        `plan '${planSlug}' cannot be marked shipped: mandatory outcome bar(s) are not met in the ` +
        `authoritative independent grading: ${detail}. Every mandatory outcome needs a current ` +
        `pass-equivalent rating; a disclosure criterion or the rubric author's acceptance verdict ` +
        `cannot substitute for the outcome.`,
    })) return collectedRefusal();
  }
  // ── vetting PRECEDED grading (EI-21827040531672903) ──
  // The vetting block above established only that an attestation exists at the current
  // revision — never that it came FIRST, which is the whole point of vetting: the
  // critique is meant to improve the rubric BEFORE anyone grades work against it. A
  // rubric vetted afterwards was, at grading time, unvetted, and an all-pass card
  // emitted against it shipped clean. This mirrors the verdict-ordering comparison
  // below rather than introducing new machinery, and is grandfathered on the grading's
  // timestamp for the reason recorded on the constant.
  const gradingPredatesOrderRule =
    Date.parse(independent.createdAt) < Date.parse(VETTING_PRECEDES_GRADING_REQUIRED_AFTER);
  if (
    vettingAttestedAt &&
    !gradingPredatesOrderRule &&
    Date.parse(vettingAttestedAt) > Date.parse(independent.createdAt)
  ) {
    if (refuse({
      satisfied: false,
      code: 'acceptance_rubric_vetted_after_grading',
      rubricId: rubric.rubricId,
      gradingRef: independent.issueId,
      staleGradingScorecardId: independent.issueId,
      staleGradingScorecardIds: [...new Set([
        ...cohortStaleIndependentIds,
        ...independentCards
          .filter((card) => Date.parse(card.createdAt) < Date.parse(vettingAttestedAt))
          .map((card) => card.issueId),
      ])],
      gradedBy: independent.createdBy ?? null,
      gradedVia: independentVia,
      ...(unknownRatedCriteria.length > 0 ? { unknownRatedCriteria } : {}),
      message:
        `plan '${planSlug}' cannot be marked shipped: acceptance rubric '${rubric.rubricId}' was vetted at ` +
        `${vettingAttestedAt}, AFTER the independent grading at ${independent.createdAt} — so the grading was ` +
        `emitted against a rubric no one had critiqued yet, which is the step vetting exists to put first. The ` +
        `attestation is not in doubt; its ORDER is. Have a non-implementer re-grade against the now-vetted ` +
        `rubric: scorecards:emit { rubricRef:'${rubric.rubricId}', ratings:{ <every criterion key> } } with ` +
        `concrete evidence per rating, then record the implementer's acceptance verdict on that newer grading.`,
    })) return collectedRefusal();
  }

  const explicitVerdicts = implementer ? complete.filter((s) => holdsAuthorAuthority(s) && s.acceptance) : [];
  // listScorecards is newest-first, but sort defensively because tests/injected
  // readers are not required to preserve the storage ordering contract.
  const latestVerdict = explicitVerdicts.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const verdictFollowsLatestIndependent = latestVerdict
    ? Date.parse(independent.createdAt) <= Date.parse(latestVerdict.createdAt)
    : false;
  const latestIndependentIsLegacy = Date.parse(independent.createdAt) < Date.parse(ACCEPTANCE_VERDICT_REQUIRED_AFTER);
  if (!verdictFollowsLatestIndependent && !latestIndependentIsLegacy) {
    if (refuse({
      satisfied: false,
      code: 'acceptance_not_recorded',
      rubricId: rubric.rubricId,
      gradingRef: independent.issueId,
      gradedBy: independent.createdBy ?? null,
      gradedVia: independentVia,
      ...(unknownRatedCriteria.length > 0 ? { unknownRatedCriteria } : {}),
      message:
        `plan '${planSlug}' has a complete independent grading by '${independent.createdBy ?? 'unknown'}', but ` +
        `its implementer${implementer ? ` ('${implementer}')` : ''} has not recorded the post-grading acceptance ` +
        `call. After reading that grading, the rubric author must run scorecards:emit ` +
        `{ rubricRef:'${rubric.rubricId}', acceptanceOf:'${independent.issueId}', ` +
        `acceptance:{ verdict:'accept'|'accept-pending-delivery'|'reject', reasoning:'<why this grading is acceptable or not>' } }. ` +
        `The referenced independent grade supplies the ratings; record only the verdict and reason. ` +
        `Use 'accept-pending-delivery' when the grading is accepted and the ONLY outstanding obligation is evidence on a ` +
        `delivery plane you cannot reach (a deployed/live BAR behind a gate, or a deploy another agent owns): 'accept' ` +
        `would overclaim delivery and 'reject' would be false. It does not block this gate, and it does not waive the ` +
        `delivery-plane evidence, which keeps blocking on its own code.`,
    })) return collectedRefusal();
  }
  if (verdictFollowsLatestIndependent && latestVerdict?.acceptance?.verdict === 'reject') {
    if (refuse({
      satisfied: false,
      code: 'acceptance_rejected',
      rubricId: rubric.rubricId,
      gradingRef: independent.issueId,
      gradedBy: independent.createdBy ?? null,
      gradedVia: independentVia,
      ...(unknownRatedCriteria.length > 0 ? { unknownRatedCriteria } : {}),
      message:
        `plan '${planSlug}' cannot be marked shipped: implementer '${implementer}' recorded REJECT — ` +
        `${latestVerdict.acceptance.reasoning}. Address the grading, then record a newer acceptance verdict with ` +
        `scorecards:emit; the latest implementer verdict is authoritative.`,
    })) return collectedRefusal();
  }
  // WI-10004135 — 'accept-pending-delivery' promises that the delivery-plane evidence
  // "keeps blocking on its own code". Inside the acceptance-BAR contract it does: the
  // snapshot's deployed/live BARs refuse above. A plan OUTSIDE that contract has no such
  // code, so this gate shipped straight past the author's own declaration that delivery
  // was outstanding (measured on p2p-work-distribution-2026-07-02: satisfied:true while
  // its live criterion was rated unknown). There the verdict itself blocks, until the
  // author re-records 'accept' once the delivery evidence exists.
  if (
    verdictFollowsLatestIndependent &&
    latestVerdict?.acceptance?.verdict === 'accept-pending-delivery' &&
    !barContractApplicable
  ) {
    const pendingDeliveryCriteria = rubric.criteria
      .filter((criterion) => {
        const plane = (criterion as typeof criterion & { evidencePlane?: string | null }).evidencePlane;
        if (plane !== 'deployed' && plane !== 'live') return false;
        const rating = independent.ratings[criterion.key]?.rating?.trim() ?? null;
        return rating == null || ratingVerdict(rating) !== 'pass';
      })
      .map((criterion) => criterion.key);
    if (refuse({
      satisfied: false,
      code: 'acceptance_pending_delivery',
      rubricId: rubric.rubricId,
      gradingRef: independent.issueId,
      gradedBy: independent.createdBy ?? null,
      gradedVia: independentVia,
      ...(unknownRatedCriteria.length > 0 ? { unknownRatedCriteria } : {}),
      ...(pendingDeliveryCriteria.length > 0 ? { pendingDeliveryCriteria } : {}),
      message:
        `plan '${planSlug}' cannot be marked shipped: implementer '${implementer}' recorded ` +
        `'accept-pending-delivery' — delivery-plane evidence is still outstanding` +
        (pendingDeliveryCriteria.length > 0
          ? ` (deployed/live criteria not passing in the independent grading: ${pendingDeliveryCriteria.join(', ')})`
          : '') +
        `. This plan is outside the acceptance-BAR contract, so no BAR blocks on that evidence; the verdict ` +
        `itself does. Bank the delivery evidence, then record a newer acceptance verdict with scorecards:emit ` +
        `{ rubricRef:'${rubric.rubricId}', acceptanceOf:'${independent.issueId}', acceptance:{ verdict:'accept', ` +
        `reasoning:'<the delivery evidence>' } } — or have the grading refreshed first if it rated that evidence unknown.`,
    })) return collectedRefusal();
  }
  if (deferredBarShipRefusal) {
    if (!opts.collectAllBlockers) return deferredBarShipRefusal;
    refuse(deferredBarShipRefusal);
  }
  if (preGradingRefusals.length > 0) return collectedRefusal();

  // EI-22181490624100467 — the ship is going to happen; record WHAT the graded
  // evidence's deployment position actually was, so the shipped artifact cannot
  // imply more than it verified. Fail-soft by contract (the probe swallows its own
  // errors), and only when the caller opted in: see `probeCitationDeployment`.
  const citationDeployment =
    opts.probeCitationDeployment && citedEvidencePaths.size > 0
      ? await citationDeploymentForPaths([...citedEvidencePaths])
      : undefined;

  return {
    satisfied: true,
    rubricId: rubric.rubricId,
    ...(vettedUnderWaiver ? { vettedUnderWaiver } : {}),
    ...(specCoverage ? { specCoverage } : {}),
    ...(requirementExemptions.length > 0 ? { requirementExemptions } : {}),
    ...(requirementDroppedTargets.length > 0 ? { requirementDroppedTargets } : {}),
    gradedBy: independent.createdBy ?? null,
    gradedVia: independentVia,
    ...(unknownRatedCriteria.length > 0 ? { unknownRatedCriteria } : {}),
    ...(citationDeployment ? { citationDeployment } : {}),
    ...(forcedChecks.length > 0 && opts.force ? { forcedPast: { reason: opts.force.reason, checks: forcedChecks } } : {}),
  };
}

/** Route the observed refusal; never parse a prose hint into executable arguments. */
export function planAcceptanceRepairAction(
  planSlug: string,
  verdict: PlanAcceptanceGateVerdictWithoutBuildProvenance,
  opts: PlanAcceptanceGateOpts = {},
  observedStatus?: string | null,
): PlanAcceptanceRepairAction {
  const scope = { slug: planSlug, ...(opts.harnessSlug ? { harness: opts.harnessSlug } : {}) };
  const proof = opts.current ? { current: opts.current } : {};
  const diagnostic = {
    name: 'plans:get',
    args: { ...scope, mode: 'meta', shipReadiness: true, ...proof },
  };
  const ship = {
    name: 'plans:set-plan-status',
    // D-021's carry CAS applies when the same read observed that lifecycle.
    // Legacy ready/active plans must not receive an invented precondition.
    args: {
      ...scope, status: 'shipped', ...proof,
      ...(observedStatus === 'awaiting-acceptance' ? { expectedCurrent: 'awaiting-acceptance' } : {}),
    },
  };
  const instruction = verdict.message ?? 'Read the current scoped acceptance gate before choosing a repair.';
  if (verdict.satisfied) {
    return verdict.skipped === 'already-shipped'
      ? { kind: 'terminal', nextVerb: null, instruction: 'Already shipped; do not reopen acceptance.' }
      : {
          kind: 'shipment', nextVerb: ship,
          instruction: 'The gate permits a ship attempt, not a completed shipment. Keep acceptance accountability until the lifecycle write succeeds. Preserve any skipped/waiver disclosures.',
        };
  }
  if (verdict.code === 'acceptance_ungraded' || verdict.code === 'self_graded_only') {
    // EI-24032136322947460: this gate cannot see whether the acceptance-grading-sweep
    // is armed, so it must not promise the sweep recovers a stall — it sat paused for
    // days while this text said it did. plans:set-plan-status reads the sweep and, when
    // recovery is not automatic, replaces this with acceptanceGrader.recovery's route.
    return {
      kind: 'independent-grading', nextVerb: ship,
      instruction: 'Retry plans:set-plan-status: each call re-runs the idempotent grader recruiter. Read its acceptanceGrader result for the dispatch state; acceptanceGrader.recovery is present when stalled gradings are NOT recovered automatically and names the manual route. Do not self-grade or launch a parallel reviewer.',
    };
  }
  if (
    verdict.code === 'acceptance_not_recorded' ||
    verdict.code === 'acceptance_rejected' ||
    verdict.code === 'acceptance_pending_delivery'
  ) {
    return {
      kind: 'author-verdict',
      nextVerb: verdict.gradingRef ? { name: 'scorecards:get', args: { issueId: verdict.gradingRef } } : diagnostic,
      repairVerb: 'scorecards:emit',
      instruction: `${instruction} Read the authoritative grading first, then supply acceptanceOf and an authored acceptance verdict/reasoning; never invent ratings or supersede the independent card.`,
    };
  }
  if (verdict.code === 'acceptance_rubric_unvetted') {
    return {
      kind: 'rubric-vetting',
      nextVerb: verdict.rubricId ? { name: 'rubrics:get', args: { rubricRef: verdict.rubricId } } : diagnostic,
      repairVerb: 'consult:get_feedback',
      instruction,
    };
  }
  if (verdict.code === 'acceptance_bar_contract_not_ready') {
    // D-022: this code ALSO means identity/read/adoption failure. Neither its
    // spelling nor prose is evidence that the rubric needs mutation.
    const lifecycle = verdict.acceptanceBarLifecycle;
    const repair = lifecycle?.nextRepair;
    const code = repair && lifecycle.codes.includes(repair.code) ? repair.code : undefined;
    const context = code ? repair!.action : instruction;
    if (code === 'bar_snapshot_vetting_missing' || code === 'bar_snapshot_vetting_stale') {
      return { kind: 'rubric-vetting', nextVerb: diagnostic, repairVerb: 'consult:get_feedback', instruction: context };
    }
    if (code === 'bar_snapshot_author_verdict_missing' || code === 'bar_snapshot_author_verdict_stale' ||
        code === 'bar_snapshot_author_rejected') {
      return { kind: 'author-verdict', nextVerb: diagnostic, repairVerb: 'scorecards:emit', instruction: context };
    }
    if (code && [
      'bar_snapshot_method_missing', 'bar_snapshot_falsifier_missing', 'bar_snapshot_check_missing',
      'bar_snapshot_check_invalid', 'bar_snapshot_role_invalid', 'bar_snapshot_mandatory_invalid',
      'bar_snapshot_scope_invalid', 'bar_snapshot_pass_ratings_invalid', 'bar_snapshot_coverage_invalid',
    ].includes(code)) {
      return {
        kind: 'contract-repair', nextVerb: diagnostic, repairVerb: 'rubrics:amend',
        instruction: `${context} Inspect the canonical contract, author the measured BAR/METHOD/check correction, then use rubrics:amend dryRun and its approval/apply flow. No replacement text or approval is inferred.`,
      };
    }
    // A proof/grading/read failure never becomes an amendment or grader launch
    // just because it shares the umbrella contract code.
    return { kind: 'diagnostic', nextVerb: diagnostic, instruction: context };
  }
  if (verdict.code === 'acceptance_rubric_missing') {
    return { kind: 'contract-repair', nextVerb: diagnostic, repairVerb: 'rubrics:propose', instruction };
  }
  if (['acceptance_unaudited', 'audit_coverage_stale', 'audit_citations_unresolved', 'code_deliverable_unverified',
    'requirement_unrealized'].includes(verdict.code ?? '')) {
    return { kind: 'evidence-repair', nextVerb: diagnostic, repairVerb: 'plans:audit', instruction };
  }
  return { kind: 'diagnostic', nextVerb: diagnostic, instruction };
}

/**
 * P-001 (plan-verification-friction-reduction-2026-10-11): the primary refusal (the first
 * collected, so `code`/`message` match first-failure mode) carrying every collected
 * refusal as a blocker with its own repair route. Pure apart from the repair router.
 */
function withPreGradingBlockers(
  planSlug: string,
  refusals: readonly PlanAcceptanceGateVerdictWithoutBuildProvenance[],
  opts: PlanAcceptanceGateOpts,
  subject: { status?: string | null; harnessSlug?: string },
): PlanAcceptanceGateVerdictWithoutBuildProvenance {
  const [primary] = refusals;
  if (!primary) throw new Error('withPreGradingBlockers: no refusal was collected');
  const repairOpts = { ...opts, harnessSlug: subject.harnessSlug ?? opts.harnessSlug };
  return {
    ...primary,
    blockers: refusals.flatMap((refusal) => refusal.code
      ? [{
          code: refusal.code,
          ...(refusal.message ? { message: refusal.message } : {}),
          repairAction: planAcceptanceRepairAction(planSlug, refusal, repairOpts, subject.status),
        }]
      : []),
  };
}

/**
 * P-001: the ship door's response message — the primary message, followed by one line
 * naming every other failing check, so a caller reading only `message` still learns that
 * the plan has more than one blocker. The gate's own `message` is left unchanged for the
 * closure observation.
 */
export function messageWithAdditionalBlockers(
  message: string | undefined,
  blockers: readonly { code: string }[] | undefined,
): string | undefined {
  const rest = (blockers ?? []).slice(1);
  if (rest.length === 0) return message;
  const tail =
    `ALSO FAILING: ${rest.length} more independent check(s) — ${rest.map((b) => b.code).join(', ')}. ` +
    'Each is listed with its own message and repairAction in blockers[]; repair them together before retrying.';
  return message ? `${message}\n\n${tail}` : tail;
}

export async function evaluatePlanAcceptanceGate(
  planSlug: string,
  opts: PlanAcceptanceGateOpts = {},
): Promise<PlanAcceptanceGateVerdict> {
  const subject: { status?: string | null; harnessSlug?: string } = {};
  // D-032: this is the ONE writer of the persisted closure verdict the goal portfolio
  // read serves (goals/plan-closure-observations.ts). Only a canonical call is
  // recorded, since force/gradingRecruitment/caller fingerprints change the answer.
  // The fingerprint is read BEFORE evaluation starts, never beside it.
  const observation = isCanonicalClosureGateCall(opts) ? await beginPlanClosureObservation(planSlug) : null;
  const verdict = await evaluatePlanAcceptanceGateWithoutBuildProvenance(planSlug, opts, subject);
  const repairAction = planAcceptanceRepairAction(
    planSlug, verdict, { ...opts, harnessSlug: subject.harnessSlug ?? opts.harnessSlug }, subject.status,
  );
  const result: PlanAcceptanceGateVerdict = {
    ...verdict,
    repairAction,
    // P-001: every refusal names its blockers; a first-failure refusal has exactly one.
    ...(!verdict.satisfied && !verdict.blockers && verdict.code
      ? { blockers: [{ code: verdict.code, ...(verdict.message ? { message: verdict.message } : {}), repairAction }] }
      : {}),
    buildProvenance: getBuildInfo(),
  };
  await observation?.record(subject.harnessSlug, result);
  return result;
}

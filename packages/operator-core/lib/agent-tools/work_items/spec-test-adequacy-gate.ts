/** Current, per-clause test-adequacy gate used before a work-item close is written. */
import { listScorecards, settledGradingAuditIsCurrent, type ScorecardRow } from '../../scorecards';
import {
  listSpecEvidence,
  listWorkItemSpecRevisionEdges,
  type EvidenceCurrentInput,
} from '../plans/spec-evidence-store';
import { listSpecClauses, type SpecClauseRevision } from '../plans/spec-clauses-store';
import { resolveEvaluatorClassRef } from '../plans/evaluate-spec-test-adequacy';
import {
  enforcedClausesOf,
  ENFORCEABLE_LIFECYCLE_STATUSES,
  planStampOf,
  resolveWorkItemBehaviorContract,
  type ResolveBehaviorContractDeps,
  type WorkItemBehaviorContract,
  type WorkItemForContract,
} from '../plans/behavior-contract-resolver';
import type { EnforcementEligibility } from '../plans/spec-enforcement-eligibility';
import { isNonAutomatedBehaviorClass, isNonCodeWorkItemKind } from '../../plan-verification-profile';
import { clauseDeliverableKey, readClauseCodeDeliverables } from '../../plan-verification-escape';
import {
  adequacyCardRevisionDisposition,
  activeSpecEvidence,
  evaluateSpecTestAdequacy,
  requiredProofFloor,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
  specTestAdequacySubjectRef,
  type PlanClassRubricRef,
  type SpecTestAdequacyResult,
  type SpecEvidenceForAdequacy,
} from '../plans/spec-test-adequacy';
import {
  resolveSourceBarTestRequirements,
  type SourceBarRubricCache,
} from '../plans/source-bar-test-requirements';
import { evaluateMechanicalTestAdequacy } from '../plans/mechanical-test-adequacy';
import type { RequirementClosureDeclaration } from '../../spec-conformance/closure-guard';
import { resolveItemCloseContributions, type ContributionDeferralDeps, type DeferredContribution } from './item-close-contributions';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

export interface SpecAdequacyCompletionAttestation {
  classRef?: PlanClassRubricRef;
  /**
   * Exact immutable proof identities to grade. Historical bindings remain in the
   * ledger, but a caller can exclude superseded run-specific refs just as
   * plans:evaluate-spec-test-adequacy already permits.
   */
  evidenceRefs?: string[];
  /** Immutable clause pin copied from the evaluator rerun recipe being replayed. */
  specRevision?: number;
  specFingerprint?: string;
  /** Preserve the evaluator's prior server-measured currentness snapshot. */
  replaySnapshot?: boolean;
  current?: EvidenceCurrentInput[];
}

/**
 * `impactReport` is the ADVISORY half of D-013 and is never a verdict. P-016 reports
 * what the universal resolver newly makes visible — standalone behavior-changing work
 * with no resolved clause, clauses reached only through a cross-namespace edge, and
 * edges pinned to superseded revisions — while P-013 owns turning that same reconciled
 * condition into a refusal. It is therefore populated independently of `ok`: a caller
 * that treats a populated report as a failure has imported P-013's enforcement early.
 */
/**
 * WI-10002055: `exempted` names the clauses this gate CONSIDERED and deliberately
 * did not enforce, each with the reason it was excused.
 *
 * It exists because an exempted clause and a clause that was never considered used
 * to render identically — both as `checked: []` — so "discharged" and "never looked
 * at" were the same observable state, and zero enforcement became the silent default
 * resting state rather than a decision anyone could audit.
 *
 * This is REPORTING only. It deliberately does NOT re-impose a proof floor: the
 * EI-23396502901266480 fix (an explicitly manual BAR must not be forced to fabricate
 * automated proof) is preserved exactly, and `ok` is unchanged in every path. The two
 * states differ by NAME now, not by outcome.
 */
/**
 * WI-10002063: a resolvable pointer from a failed-audit refusal to its findings.
 *
 * `issueId` is the GRADED card (what `failedGradingAuditTargetIds` already carries);
 * `auditIssueId` is the AUDIT card, which is the only id that resolves to why the
 * audit failed. `auditIssueId` stays optional because `ScorecardGradingAudit` only
 * populates it "once audited" — a card can be stamped `failed` by the identity-reopen
 * path without one, and reporting its absence honestly beats inventing a handle.
 */
export interface CarriedAdequacyCard {
  label: string;
  issueId: string | null;
  recordedRevision: number;
  currentRevision: number;
}

/**
 * P-043: name WHY no card matched when a live card exists. A rule-revision bump that changed a
 * verdict says so (and which criteria), instead of the generic mismatch that sent the peer in the
 * measured case to re-emit and re-audit on unchanged evidence without knowing the rule had moved.
 */
function verdictChangeDetail(cards: ScorecardRow[], result: SpecTestAdequacyResult): string | null {
  const live = cards.find((card) => !card.supersededBy && !card.retracted);
  if (!live) return null;
  const disposition = adequacyCardRevisionDisposition({
    recordedRevision: live.rerunRecipe?.evaluator === 'plans:evaluate-spec-test-adequacy'
      ? live.rerunRecipe.evaluatorRevision : undefined,
    recordedRatings: live.ratings,
    liveRatings: result.ratings,
  });
  if (disposition.state !== 'verdict-changed') return null;
  const moves = disposition.changed
    .map((entry) => `${entry.criterion}: ${entry.recorded ?? 'absent'}→${entry.current ?? 'absent'}`)
    .join(', ');
  const cause = !live.rerunRecipe
    ? `card ${live.issueId ?? '(unrecorded)'} records no evaluator rerun recipe, and the stored evidence now grades ${moves}`
    : disposition.recordedRevision < disposition.currentRevision
      ? `the evaluator rule moved from revision ${disposition.recordedRevision} to ${disposition.currentRevision} since card ${live.issueId ?? '(unrecorded)'} was graded, and it changed ${moves}`
      : `card ${live.issueId ?? '(unrecorded)'} was graded under the current evaluator revision ${disposition.currentRevision}, but the stored evidence now grades ${moves}`;
  return `${cause}; only these changed verdicts need a re-emitted card and a new audit`;
}

export interface FailedGradingAudit {
  issueId: string;
  auditIssueId?: string;
  auditor?: string;
  auditedAt?: string;
}

export type SpecAdequacyCompletionGateResult = (
  | { ok: true; applicable: false; checked: []; exempted?: string[]; impactReport?: string }
  | {
      ok: true;
      applicable: true;
      checked: string[];
      exempted?: string[];
      impactReport?: string;
      /**
       * P-043: clauses whose admitting card was graded under an OLDER evaluator rule revision,
       * re-evaluated from its stored bindings with every verdict unchanged — the card and its
       * settled audit were accepted as-is, with no re-emission or re-audit.
       */
      carriedAcrossEvaluatorRevision?: CarriedAdequacyCard[];
    }
  | {
      ok: false;
      applicable: true;
      retryable: true;
      reason: string;
      checked: string[];
      exempted?: string[];
      impactReport?: string;
      pendingGradingAuditTargetIds?: string[];
      failedGradingAuditTargetIds?: string[];
      /**
       * WI-10002063: the resolvable handle for each FAILED grading audit.
       *
       * `failedGradingAuditTargetIds` carries the GRADED card's id, which does not
       * resolve to why the audit failed: `ScorecardGradingAudit` deliberately stores no
       * reason/findings field, because the findings live in the AUDIT scorecard addressed
       * by `auditIssueId`. Dropping that handle made the refusal a closed loop — the gate
       * refused, the refusal would not say why, and the only field that could say why was
       * discarded before the caller saw it. Added as a PARALLEL field so the existing
       * `failedGradingAuditTargetIds` contract stays intact for current readers.
       */
      failedGradingAudits?: FailedGradingAudit[];
    }) & { deferredContributions?: DeferredContribution[] };

/**
 * P-016: `planStampOf` moved to the universal contract resolver, which is the more
 * general home — under D-013 provenance is one INPUT to resolution rather than its
 * precondition. Imported rather than re-declared so the two cannot drift.
 */
type WorkItemForSpecGate = WorkItemForContract;

/**
 * A file suffix is only a contradiction signal; it never grants an exemption by itself.
 * Scope authority comes from a current, registered INVENTORY-P-NNN clause below.
 */
function isExecutableSourcePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|rs|py|go|sh|bash|zsh|sql|css|s[ac]ss|less|html?|vue|svelte|c|cc|cpp|cxx|h|hpp|java|kt|kts|swift|rb|php|ex|exs|erl|hs|lua|pl|ps1|bat|cmd)$/i
    .test(path.trim());
}

function isDocumentationInventoryPath(path: string): boolean {
  const segments = path.trim().replaceAll('\\', '/').split('/');
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return false;
  }
  return segments[0] === 'docs' ||
    (segments[0] === 'apps' && segments[1] === 'operator-docs' && segments[2] === 'src' &&
      segments[3] === 'content' && segments[4] === 'docs');
}

function isPlanDecisionRef(value: string, planSlug: string): boolean {
  const prefix = `${planSlug}#`;
  return value.startsWith(prefix) && /^D-\d{3,}$/.test(value.slice(prefix.length));
}

function isRegisteredInventoryExemption(
  clause: SpecClauseRevision,
  planSlug: string,
  planItemId: string,
): boolean {
  const provenance = typeof clause.exemption?.provenance === 'string'
    ? clause.exemption.provenance.trim()
    : '';
  const justification = typeof clause.exemption?.justification === 'string'
    ? clause.exemption.justification.trim()
    : '';
  return clause.planSlug === planSlug &&
    clause.planItemId === planItemId &&
    clause.specId === `INVENTORY-${planItemId}` &&
    clause.currentRevision === clause.revision &&
    clause.sourceValId === null &&
    clause.sourceBar == null &&
    clause.behavior.trim().length > 0 &&
    isNonAutomatedBehaviorClass(clause.behaviorClass) &&
    clause.requiredEvidence.length === 0 &&
    clause.requiredTestLayers.length === 0 &&
    !clause.mutationRequired &&
    clause.lifecycleStatus === 'exempt' &&
    clause.falsifier == null &&
    Boolean(justification) &&
    isPlanDecisionRef(provenance, planSlug) &&
    clause.acceptanceRef === provenance;
}

/** Resolve a current inventory exemption only when it owns the whole enforced item scope. */
function registeredInventoryExemptionFor(
  workItem: WorkItemForSpecGate,
  contract: WorkItemBehaviorContract,
  enforcedClauses: readonly SpecClauseRevision[],
): SpecClauseRevision | undefined {
  if (workItem.kind?.trim().toLowerCase() !== 'feature') return undefined;
  const stamp = planStampOf(workItem);
  if (!stamp || stamp.planItemIds.length !== 1) return undefined;
  const [planItemId] = stamp.planItemIds;
  if (enforcedClauses.some((clause) => clause.planSlug !== stamp.planSlug || clause.planItemId !== planItemId)) {
    return undefined;
  }
  const group = contract.groups.find((candidate) =>
    candidate.planSlug === stamp.planSlug && candidate.eligibility.enforcing,
  );
  if (!group) return undefined;
  return group.clauses.find((clause) =>
    isRegisteredInventoryExemption(clause, stamp.planSlug, planItemId),
  );
}

/**
 * Re-exported from the resolver rather than re-declared. This was a local
 * `new Set(['active', 'accepted'])` — a second copy of the resolver's own
 * ENFORCEABLE_LIFECYCLE_STATUSES, silently ordered differently, which is precisely the
 * shape that drifts without any test noticing.
 */
const ENFORCEABLE_LIFECYCLE = new Set<string>(ENFORCEABLE_LIFECYCLE_STATUSES);

/**
 * Human-readable gloss for each machine-readable eligibility reason.
 *
 * Keyed by `EnforcementEligibility['reason']` so a new reason cannot be added there and
 * silently render as `undefined` here — the `satisfies` makes tsc demand this entry.
 */
type NotEnforcedReason = Extract<EnforcementEligibility, { enforcing: false }>['reason'];

const NOT_ENFORCED_BECAUSE = {
  historical: 'the plan already shipped, so its clauses are carried for visibility and never block — no action needed',
  'pre-enforcement': 'the plan is still a draft, so its clauses are candidate inputs until it is promoted (D-012)',
  'not-yet-reconciled':
    'the plan is active but has not adopted behavior clauses yet — reconcile that plan to enforce them',
} satisfies Record<NotEnforcedReason, string>;

/**
 * Build the advisory report (D-013). Returns undefined when there is nothing to say, so
 * a caller can treat a populated string as "worth surfacing" without inferring a verdict
 * from its mere presence.
 *
 * Everything named here is deliberately OUTSIDE the enforced set: these are the
 * obligations that were invisible before P-016 resolved applicability across plan
 * namespaces. Naming them without acting on them is exactly the split D-013 assigns.
 */
function advisoryImpactReport(contract: WorkItemBehaviorContract): string | undefined {
  const parts: string[] = [];
  // The resolver's own report: a behavior-changing item that resolved no clause at all.
  if (contract.impact.report) parts.push(contract.impact.report);

  // Clauses this item genuinely owns that are nonetheless NOT enforced, grouped by WHY.
  //
  // P-013 moved the boundary this report describes. Under P-016 the unenforced set was
  // "every namespace but the stamped one", because cross-namespace resolution was
  // reported-only; that is no longer true — a cross-namespace clause in an eligible plan
  // now refuses. The remaining unenforced set is exactly the plans that are not yet
  // ELIGIBLE, so the report must name the eligibility reason rather than repeat the old
  // provenance split. Reporting the reason is also P-013's own scope line ("instrument
  // gate reasons"): `historical` is a correct permanent exemption and needs no follow-up,
  // while `not-yet-reconciled` is a migration TODO on that plan. A bare "not enforced"
  // collapses the two, and they want opposite action.
  const byReason = new Map<NotEnforcedReason, string[]>();
  for (const group of contract.groups) {
    if (group.eligibility.enforcing) continue;
    const labels = group.clauses
      .filter((clause) => ENFORCEABLE_LIFECYCLE.has(clause.lifecycleStatus))
      .map((clause) => `${group.planSlug}/${clause.specId}@${clause.revision}`);
    if (labels.length === 0) continue;
    const bucket = byReason.get(group.eligibility.reason);
    if (bucket) bucket.push(...labels);
    else byReason.set(group.eligibility.reason, [...labels]);
  }
  for (const [reason, labels] of byReason) {
    parts.push(
      `resolved ${labels.length} active clause(s) that are NOT enforced (${NOT_ENFORCED_BECAUSE[reason]}): ` +
        `${labels.join(', ')}. Reported, not enforced.`,
    );
  }

  // A stale edge is a coverage claim against a promise that has since been revised.
  const stale = contract.groups.flatMap((group) =>
    group.staleEdges.map(
      (edge) => `${group.planSlug}/${edge.specId} edge@${edge.edgeRevision} vs current@${edge.currentRevision}`,
    ),
  );
  if (stale.length) {
    parts.push(`coverage edges pinned to superseded revisions: ${stale.join(', ')}. Reported, not enforced.`);
  }

  return parts.length ? parts.join(' | ') : undefined;
}

function acceptedRating(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rating = (value as { rating?: unknown }).rating;
  return typeof rating === 'string' && ['pass', 'waived', 'not-applicable'].includes(rating.toLowerCase());
}

function ratingVerdictsMatch(card: ScorecardRow, result: SpecTestAdequacyResult): boolean {
  const expected = Object.entries(result.ratings);
  if (Object.keys(card.ratings).length !== expected.length) return false;
  return expected.every(([key, value]) => {
    const actual = card.ratings[key];
    return (
      actual &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      (actual as { rating?: unknown }).rating === value.rating
    );
  });
}

/** Keep independent prose review separate from the identity of the proof it
 * reviewed. Enriching a criterion explanation may change the card fingerprint,
 * but a new binding or a changed source/test hash needs a new audit. */
function scorecardProofCohortMatches(
  card: ScorecardRow,
  result: SpecTestAdequacyResult,
  evidence: SpecEvidenceForAdequacy[],
): boolean {
  const recipe = card.rerunRecipe?.evaluator === 'plans:evaluate-spec-test-adequacy' ? card.rerunRecipe : undefined;
  if (card.rerunRecipe && !recipe) return false;
  const recorded = recipe?.current;
  if (!recorded?.supplied) return true; // pre-fingerprint legacy cards keep their existing admission rule
  const proofKey = (row: { evidenceKind: string; evidenceRef: string }) =>
    `${row.evidenceKind}\0${row.evidenceRef}`;
  const selected = result.scorecardDraft.rerunRecipe.selection.evidence;
  const selectedKeys = new Set(selected.map(proofKey));
  const recordedKeys = recipe?.selection.evidence.map(proofKey) ?? [];
  if (JSON.stringify([...selectedKeys].sort()) !== JSON.stringify([...recordedKeys].sort())) return false;
  const tuple = (row: {
    planSlug?: string; specId?: string; specRevision?: number; specFingerprint?: string;
    evidenceKind: string; evidenceRef: string; sourceFingerprint: string;
    testFingerprint?: string | null; fixtureFingerprint?: string | null;
    rubricFingerprint?: string | null; environmentFingerprint?: string | null;
  }) => [
    row.planSlug ?? null, row.specId ?? null, row.specRevision ?? null, row.specFingerprint ?? null,
    row.evidenceKind, row.evidenceRef, row.sourceFingerprint,
    row.testFingerprint ?? null, row.fixtureFingerprint ?? null,
    row.rubricFingerprint ?? null, row.environmentFingerprint ?? null,
  ];
  const live = activeSpecEvidence(evidence.filter((row) =>
    row.planSlug === result.planSlug && row.specId === result.specId &&
    row.specRevision === result.specRevision && row.specFingerprint === result.specFingerprint,
  )).filter((row) => selectedKeys.has(proofKey(row))).map((row) => tuple({
    planSlug: row.planSlug, specId: row.specId, specRevision: row.specRevision,
    specFingerprint: row.specFingerprint, evidenceKind: row.evidenceKind,
    evidenceRef: row.evidenceRef, ...row.fingerprints,
  }));
  const prior = recorded.fingerprints.map(tuple);
  // Several scenario targets may cite one receipt with identical fingerprints.
  // Their obligations remain separate in the evaluator; the audited fingerprint
  // cohort records each proof identity once. Keep differing fingerprints distinct.
  const cohort = (rows: (string | number | null)[][]) =>
    [...new Set(rows.map((row) => JSON.stringify(row)))].sort();
  const liveCohort = cohort(live);
  return liveCohort.length === selectedKeys.size &&
    JSON.stringify(liveCohort) === JSON.stringify(cohort(prior));
}

function scorecardMatches(
  card: ScorecardRow,
  result: SpecTestAdequacyResult,
  evidence: SpecEvidenceForAdequacy[],
): boolean {
  const expectedSubjectRef = specTestAdequacySubjectRef(result.planSlug, result.specId, result.specRevision);
  return (
    card.subject?.kind === 'plan' &&
    card.subject.ref === expectedSubjectRef &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    card.extraKeys.length === 0 &&
    card.provisional === undefined &&
    settledGradingAuditIsCurrent(card) &&
    // The evaluator owns the criterion verdicts, while the independent grading audit
    // owns whether each evidence explanation is complete and re-runnable. Requiring the
    // entire scorecard fingerprint here coupled those two responsibilities: enriching a
    // terse evaluator explanation with the probe demanded by grading-integrity changed
    // the fingerprint and made the two gates impossible to satisfy simultaneously.
    // Match criterion verdicts and the proof cohort independently. Currentness
    // above proves the new binding; it does not prove an older card audited it.
    ratingVerdictsMatch(card, result) &&
    scorecardProofCohortMatches(card, result, evidence) &&
    Object.values(card.ratings).every(acceptedRating)
  );
}

/**
 * Legacy settled stamps created before rubric identity stamping cannot be
 * admitted, but they are repairable when scorecards:list resolved the current
 * meta-rubric identity. Route them through the same pending-audit dispatcher as
 * an ordinary pending stamp; a real current failed audit remains a failure.
 */
function gradingAuditNeedsIdentityReopen(card: ScorecardRow): boolean {
  const currentness = card.gradingAuditCurrentness;
  return Boolean(
    card.gradingAudit &&
    card.gradingAudit.state !== 'pending' &&
    currentness?.state === 'unknown' &&
    currentness.reason === 'recorded-identity-missing' &&
    currentness.currentRevision != null &&
    currentness.currentCriteriaHash != null,
  );
}

/**
 * Keep the machine-readable would-block list, but do not throw away the evaluator's
 * criterion evidence. In particular, `unknown [freshness]` is not actionable when the
 * actual cause is an omitted `testFingerprint`/`fixtureFingerprint`/other dimension.
 * Bound the appended prose because evidence refs are caller-controlled and the evaluator
 * may have selected many historical bindings.
 */
const FINGERPRINT_FIELD_BY_DIMENSION = {
  source: 'sourceFingerprint',
  test: 'testFingerprint',
  fixture: 'fixtureFingerprint',
  rubric: 'rubricFingerprint',
  environment: 'environmentFingerprint',
} as const;

function humanizeFreshnessEvidence(evidence: string): string {
  return evidence.replace(
    /\b(source|test|fixture|rubric|environment)(-current-fingerprint-not-supplied|-stale|_fingerprint_absent|_fingerprint_mismatch)\b/g,
    (_match, dimension: keyof typeof FINGERPRINT_FIELD_BY_DIMENSION, reason: string) => {
      const field = FINGERPRINT_FIELD_BY_DIMENSION[dimension];
      return reason === '-stale' || reason === '_fingerprint_mismatch' ? `${field} mismatched` : `${field} omitted`;
    },
  );
}

function adequacyFailureReason(label: string, result: SpecTestAdequacyResult): string {
  const blockers = result.wouldBlock.join(', ') || 'no passing verdict';
  const freshness = result.wouldBlock.includes('freshness') ? result.ratings.freshness : undefined;
  const details = freshness ? `freshness: ${humanizeFreshnessEvidence(freshness.evidence)}` : '';
  const boundedDetails = details.length > 2_000 ? `${details.slice(0, 1_997)}…` : details;
  // P-019: name the rows that drag each blocking criterion, so the repair is a targeted
  // retract / supersede instead of a hunt through plans:get-spec-evidence.
  const dragging = Object.entries(result.draggingBindingIds ?? {})
    .map(([criterion, ids]) => `${criterion}←${(ids ?? []).join('/')}`)
    .join(', ');
  const draggingDetail = dragging
    ? ` — dragging bindings: ${dragging} (withdraw with plans:bind-spec-evidence retract, or re-bind sufficient proof with supersedeAtRevision:true)`
    : '';
  return `${label}: ${result.verdict} [${blockers}]${draggingDetail}${boundedDetails ? ` — ${boundedDetails}` : ''}`;
}

/**
 * Keep unknown ratings separate from ordinary verdict refusals so completion cannot
 * dispatch grading-integrity auditors for an unmeasurable criterion. An unknown rating
 * does not identify a build or capability cause; preserve criterion-level diagnostics.
 */
function evaluatorUnknownFailureReason(label: string, result: SpecTestAdequacyResult): string | undefined {
  const unknownRatings = Object.entries(result.ratings).filter(([, value]) => value.rating === 'unknown');
  if (unknownRatings.length === 0) return undefined;

  const criteria = unknownRatings.map(([criterion, value]) => {
    const evidence = humanizeFreshnessEvidence(value.evidence);
    const boundedEvidence = evidence.length > 600 ? `${evidence.slice(0, 597)}…` : evidence;
    return `${criterion} (${boundedEvidence})`;
  });
  const detail = `${label}: ${unknownRatings.length} criterion(s) rated unknown: ${criteria.join(', ')}. ` +
    'An unknown rating does not establish a build or evaluator-capability problem. ' +
    'Review the criterion-specific evidence details and run plans:evaluate-spec-test-adequacy for each blocked reason to identify the required evidence and producer.';
  return `${detail} ${adequacyFailureReason(label, result)} ` +
    'This is not repairable by a grading-integrity audit; no pendingGradingAuditTargetIds were produced.';
}

/**
 * WI-10002335: the caller-facing remedy offered when a spec-test-adequacy attestation is
 * missing. It is a named export rather than an inline literal ONLY so the recurrence guard
 * (`spec-adequacy-refusal-prescribes-workable-remedy.test.ts`) can assert against the real
 * runtime string instead of re-parsing this source file — do not re-inline it.
 *
 * This text used to end "with `classRef` and current evidence fingerprints", instructing
 * callers to hand-author fingerprints the gate resolves ITSELF. Measured cost on plan
 * turn-start-memory-two-class-2026-09-21: it became plan Decision D-038 ("fingerprints you
 * COPY from the evaluator") and cost several agents a rebind cycle each, because a refusal
 * naming a specific laborious remedy is obeyed at exactly the moment the caller is most
 * willing to comply. A message that prescribes a remedy must prescribe one that WORKS —
 * i.e. one the attestation's own schema (`specAdequacyCompletionSpec`) actually accepts.
 */
export const SPEC_ADEQUACY_ATTESTATION_GUIDANCE =
  'pass a TOP-LEVEL `specAdequacy` argument to work_items:complete — a SIBLING of ' +
  '`completion`, never nested inside it (`completion.specAdequacy` is rejected). ' +
  '`specAdequacy:{}` derives the persisted subject plan class; `classRef` alone is sufficient when it matches, while ad-hoc scopes require explicit class attestation. Once evidence is ' +
  'ready — the gate resolves the governing clauses, the bound evidence and every fingerprint ' +
  'dimension itself. Do NOT hand-author fingerprints: `current` and `evidenceRefs` are optional ' +
  'and exist only to NARROW the graded selection or REPLAY a persisted evaluator snapshot. ' +
  'If it still refuses WITH `classRef` supplied, the blocker is UPSTREAM of this payload and no ' +
  'attestation shape will fix it — check, in order: (1) the clause evaluates verdict=pass via ' +
  'plans:evaluate-spec-test-adequacy. Test-checked requirements use current passing named tests ' +
  'and a caught calibrated mutation probe directly, without a judge card. For other checks, ' +
  '(2) an evaluator scorecard is filed for that clause, ' +
  "(3) that scorecard's gradingAudit.state is 'passed' rather than 'pending'";

export async function specTestAdequacyCompletionGate(
  input: {
    workItem: WorkItemForSpecGate;
    attestation?: SpecAdequacyCompletionAttestation;
    /** Actual changed AND deleted paths from the completion, not prose in its title. */
    changedPaths?: readonly string[];
    workspaceId?: string;
    completion?: RequirementClosureDeclaration;
    /** Share the dispatch tracker so a stalled read remains observable before settlement. */
    phases?: Pick<NonNullable<UnifiedToolContext['phases']>, 'track'>;
  },
  deps: {
    listClauses?: typeof listSpecClauses;
    listEdges?: typeof listWorkItemSpecRevisionEdges;
    listEvidence?: typeof listSpecEvidence;
    listCards?: typeof listScorecards;
    /**
     * Forwarded to the contract resolver, which needs plan status to decide eligibility.
     * Exposed here rather than left to the resolver's default so this gate stays fully
     * injectable — a unit test that could not stub it would open a real database.
     */
    listPlanStatuses?: ResolveBehaviorContractDeps['listPlanStatuses'];
    resolveSourceBarTestRequirements?: typeof resolveSourceBarTestRequirements;
    /** P-004: whether each clause's plan item resolves to a code deliverable. */
    readCodeDeliverables?: typeof readClauseCodeDeliverables;
    contributionDeferral?: ContributionDeferralDeps;
  } = {},
): Promise<SpecAdequacyCompletionGateResult> {
  const track = <T>(phase: string, work: () => Promise<T>): Promise<T> =>
    input.phases ? input.phases.track(`completion:spec:${phase}`, work) : work();
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listEdges = deps.listEdges ?? listWorkItemSpecRevisionEdges;
  const listEvidence = deps.listEvidence ?? listSpecEvidence;
  const listCards = deps.listCards ?? listScorecards;
  const listPlanStatuses = deps.listPlanStatuses;
  const resolvePinnedSourceBarTestRequirements = deps.resolveSourceBarTestRequirements ?? resolveSourceBarTestRequirements;
  const sourceBarRubricCache: SourceBarRubricCache = new Map();

  // D-012/D-013: applicability is BEHAVIOR-owned, not plan-owned. Resolve the item's
  // whole contract across plan namespaces FIRST. Before P-016 this function opened with
  // `const stamp = planStampOf(item); if (!stamp) return { applicable: false }` and then
  // read edges scoped to `stamp.planSlug`, so (i) a STANDALONE bug/change resolved
  // nothing at all and (ii) an edge into another plan's namespace was invisible. Both
  // are resolvable states now, which is the gap D-012 exists to close.
  const contract = await track('behavior-contract', () => resolveWorkItemBehaviorContract(input.workItem, {
    listEdges,
    listClauses,
    listPlanStatuses,
  }));
  const stamp = planStampOf(input.workItem);
  const impactReport = advisoryImpactReport(contract);
  const withReport = <T extends object>(result: T): T & { impactReport?: string } =>
    impactReport ? { ...result, impactReport } : result;
  if (input.completion?.contributesTo?.some((key) => input.completion?.discharges?.includes(key))) {
    return withReport({ ok: false, applicable: true, retryable: true, checked: [],
      reason: 'A requirement cannot be both discharged and contributed to in one completion.' });
  }

  // WI-10002055: name a clause this gate excused, and why. See the `exempted` field
  // doc on SpecAdequacyCompletionGateResult — an empty `checked` could not previously
  // distinguish "considered and discharged" from "never considered".
  const exemptionLabel = (clause: { specId: string; revision: number | string }, reason: string): string =>
    `${clause.specId}@${clause.revision} — exempt (${reason})`;

  // P-013 CLOSES the D-013 split this block used to hold open. P-016 resolved clauses
  // across plan namespaces but deliberately enforced only the stamped namespace's, so a
  // cross-namespace obligation was visible and toothless; that half-state was always
  // meant to end here.
  //
  // The enforced set is now every ELIGIBLE namespace's clauses — eligibility being the
  // single predicate in `spec-enforcement-eligibility.ts`, computed once by the resolver
  // so this gate and the sync-resolver view that renders it cannot drift. That predicate
  // is what keeps the widening from refusing fleet-wide: a shipped plan (historical), a
  // draft (pre-enforcement), and an active-but-unreconciled plan all stay report-only, so
  // enforcement arrives per plan as each is reconciled — "new and explicitly reconciled
  // plans, then migrate active plans individually", which is this item's scope line.
  //
  // The `!stamp` early return is GONE with it, and that is a behavior change worth naming:
  // a standalone bug/change whose edges reach an eligible plan's clauses is now enforced.
  // Keeping that return would have re-created the D-012 gap one level down — an item
  // escaping its own resolved obligations purely by carrying no plan provenance.
  const { planSlugs: enforcedPlanSlugs, clauses } = enforcedClausesOf(contract);
  if (clauses.length === 0) return withReport({ ok: true, applicable: false, checked: [] });

  const changedPaths = input.changedPaths ?? [];
  const executableSourceChanges = changedPaths.filter(isExecutableSourcePath);
  const documentationInventoryChanges = changedPaths.length > 0 &&
    changedPaths.every(isDocumentationInventoryPath) && executableSourceChanges.length === 0;
  const inventoryExemption = registeredInventoryExemptionFor(input.workItem, contract, clauses);
  if (inventoryExemption && !input.attestation && documentationInventoryChanges) {
    const inventoryRef = `${inventoryExemption.specId}@${inventoryExemption.revision}`;
    return withReport({
      ok: true,
      applicable: false,
      checked: [],
      exempted: clauses.map((clause) =>
        exemptionLabel(
          clause,
          `registered non-code inventory scope ${inventoryRef}; item completion only, final shipment BAR proof remains required`,
        ),
      ),
    });
  }

  const classes = new Map<string, PlanClassRubricRef>();
  if (input.attestation) {
    const subjectHarness = stamp?.harnessSlug ?? input.workItem.harness?.trim();
    if (!subjectHarness) return withReport({ ok: false, applicable: true, retryable: true, checked: [], reason: 'plan_class_unresolved: the subject harness is unavailable' });
    for (const planSlug of enforcedPlanSlugs) {
      const classRef = input.attestation.classRef;
      const resolution = await track('evaluator-class', () => resolveEvaluatorClassRef(planSlug, subjectHarness, {
        classRef,
        workItemIds: [input.workItem.id],
      }));
      if (!resolution.ok || (input.attestation.classRef !== undefined && input.attestation.classRef !== resolution.classRef)) {
        return withReport({ ok: false, applicable: true, retryable: true, checked: [],
          reason: !resolution.ok ? resolution.message : `plan_class_mismatch: '${planSlug}' requires ${resolution.classRef}, not ${input.attestation.classRef}` });
      }
      classes.set(planSlug, resolution.classRef);
    }
  }
  const classFor = (clause: SpecClauseRevision): PlanClassRubricRef => {
    const value = classes.get(clause.planSlug);
    if (!value) throw new Error(`plan_class_unresolved: ${clause.planSlug}`);
    return value;
  };

  // P-004: the code module's executable-proof floor applies only to CODE deliverables, in
  // any profile (D-001). Resolve each clause's plan item through the verification resolver
  // (the plan's stamped profile + the item's declared deliverable). A failed or partial read
  // leaves a clause absent, and absent stays code, so this can only ever lower a floor on a
  // positive non-code resolution (D-005 fails safe to coding).
  const deliverableHarness = stamp?.harnessSlug ?? input.workItem.harness?.trim();
  let codeDeliverables = new Map<string, boolean>();
  if (deliverableHarness) {
    try {
      codeDeliverables = await track('code-deliverables', () => (deps.readCodeDeliverables ?? readClauseCodeDeliverables)({
        harnessSlug: deliverableHarness,
        clauses,
      }));
    } catch {
      codeDeliverables = new Map();
    }
  }
  const codeDeliverableOf = (clause: SpecClauseRevision): boolean | undefined =>
    codeDeliverables.get(clauseDeliverableKey(clause.planSlug, clause.planItemId));
  const floorOf = (clause: SpecClauseRevision) =>
    requiredProofFloor(clause, classFor(clause), undefined, codeDeliverableOf(clause));
  const floorExemptionReason = (clause: SpecClauseRevision): string =>
    codeDeliverableOf(clause) === false
      ? `non-code deliverable for plan item ${clause.planItemId}; the code module does not apply`
      : 'proof floor none — non-automated with no required test layer';

  // `task` is the canonical non-code kind (research was folded into it). A plan may
  // still carry projected clauses for a task deliverable, but executable L3/L4 proof
  // is not a meaningful completion obligation for that item. Resolve the contract first
  // so cross-plan diagnostics remain available, then bypass the proof gate before an
  // absent attestation can make the non-code item structurally uncloseable.
  if (isNonCodeWorkItemKind(input.workItem.kind)) {
    // EI-22802366925712878: pickup's generic `task` default is not an
    // authority-grade non-code classification. These are positive contradictions,
    // not a title/verb heuristic: executable source changes or an explicit proof
    // submission against test-requiring clauses. Refuse and require an intentional
    // re-kind; silently relabelling only the evaluator input would hide the bad
    // execution record and leave every other kind-sensitive gate exempt.
    const sourceChanges = executableSourceChanges;
    const submitsExecutableProof = input.attestation && clauses.some((clause) => floorOf(clause) !== 'none');
    if (sourceChanges.length > 0 || submitsExecutableProof) {
      return withReport({
        ok: false,
        applicable: true,
        retryable: true,
        checked: [],
        reason:
          `task-kind completion for '${input.workItem.id}' claims executable changes or proof` +
          `${sourceChanges.length ? ` (${sourceChanges.slice(0, 5).join(', ')})` : ''}; ` +
          'task is the non-code kind. Use work_items:update to set the appropriate code kind ' +
          '(change, bug, or feature), re-claim the current item, then retry with current spec evidence and independently ' +
          'settled grading audits. No proof exemption can be inferred from the task label.',
      });
    }
    return withReport({
      ok: true,
      applicable: false,
      checked: [],
      exempted: clauses.map((clause) => exemptionLabel(clause, 'non-code work-item kind')),
    });
  }

  if (!input.attestation) {
    // WI-10002066 (decided 2026-09-20 on measurement): a PURE non-automated clause
    // (behaviorClass 'non-automated', no requiredTestLayers, no mutationRequired) is
    // deliberately NOT refused at this door. It is named in `exempted` and enforced at the
    // SHIP door, where `bar_snapshot_proof_missing` fires outside the `automatedProofRequired`
    // branch and so applies to every behaviour class.
    //
    // Do NOT "close the gap" by refusing item completion while such a clause has no bound
    // evidence. The clause is by construction unsatisfiable by automated proof, so the only
    // move that clears such a refusal is a hand-written attestation with no verifier attached
    // — the fabrication pressure EI-23396502901266480 was filed to stop. The ship door demands
    // the same attestation at the one door that HAS a verifier (grading + vetting + author
    // verdict). This is enforcement sited at the reader, not enforcement skipped.
    //
    // The blast-radius argument is separately false and should not be revived as the reason:
    // measured 2026-09-20, the entire active population was 6 clauses across 3 plans (2 live,
    // 4 in a superseded plan), all at zero bound evidence. Smallness is not why this declines
    // — the missing verifier is.
    //
    // A manual clause that genuinely should not gate has an existing home: lifecycle_status
    // 'exempt' (40 clauses already use it). Reach for that, not a new clause state.
    // P-004: a clause whose plan item resolves to a non-code deliverable carries no
    // executable-proof floor, so it needs no adequacy attestation either.
    const potentiallyTestRequiring = clauses.filter(
      (clause) =>
        codeDeliverableOf(clause) !== false &&
        (!isNonAutomatedBehaviorClass(clause.behaviorClass) || clause.requiredTestLayers.length > 0 || clause.mutationRequired),
    );
    if (potentiallyTestRequiring.length === 0)
      return withReport({
        ok: true,
        applicable: false,
        checked: [],
        exempted: clauses.map((clause) =>
          exemptionLabel(
            clause,
            codeDeliverableOf(clause) === false
              ? floorExemptionReason(clause)
              : 'non-automated clause declaring no required test layer',
          ),
        ),
      });
    return withReport({
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason:
        `current spec-test-adequacy attestation required for ${potentiallyTestRequiring
          .map((clause) => `${clause.specId}@${clause.revision}`)
          .join(', ')}; ${SPEC_ADEQUACY_ATTESTATION_GUIDANCE}`,
    });
  }

  const relevant = clauses.filter((clause) => floorOf(clause) !== 'none');
  // WI-10002055: the complement of `relevant` is the excused set. Computed once so every
  // exit below can name it — including the MIXED case, where some clauses are enforced and
  // others excused in the same completion and the excused ones would otherwise vanish
  // behind a populated `checked`.
  const exempted = clauses
    .filter((clause) => floorOf(clause) === 'none')
    .map((clause) => exemptionLabel(clause, floorExemptionReason(clause)));
  if (relevant.length === 0) return withReport({ ok: true, applicable: false, checked: [], exempted });
  // ⚠ The evidence read is scoped by the SAME namespaces as the enforced clause set, and
  // that coupling is not optional. This was `planSlug: stamp.planSlug` — a single-plan
  // read. Widening the enforced set above while leaving this read single-plan would make
  // every cross-namespace clause find ZERO evidence and refuse spuriously: the gate would
  // demand proof it had just made itself unable to see. `listSpecEvidence` takes
  // `planSlugs` for exactly this reason, and it is ONE query, not an N-plan fan-out, so
  // the 1000-row safety limit below still caps the whole selection.
  //
  // Evidence is not cross-credited between namespaces despite the wider read:
  // `evaluateSpecTestAdequacy` matches each row on `planSlug` AND `specId`, so two plans
  // sharing a spec id cannot satisfy each other's clause.
  const harnessSlug = stamp?.harnessSlug ?? input.workItem.harness?.trim() ?? undefined;
  const attestation = input.attestation;
  const evidence = await track('evidence', () => listEvidence({
    harnessSlug,
    planSlugs: enforcedPlanSlugs,
    workItemIds: [input.workItem.id],
    specIds: relevant.map((clause) => clause.specId),
    evidenceRefs: attestation.evidenceRefs,
    specRevision: attestation.specRevision,
    specFingerprint: attestation.specFingerprint,
    replaySnapshot: attestation.replaySnapshot === true,
    // Same rail as the evaluator: a replayed snapshot is a caller-supplied tuple,
    // never server proof. Closing a work-item must not be able to buy a
    // 'server-measured' freshness verdict by passing replaySnapshot:true.
    ...(attestation.replaySnapshot === true && attestation.current !== undefined
      ? { currentProvenance: 'replayed-snapshot' as const }
      : {}),
    current: attestation.current,
    limit: 1000,
  }));
  if (evidence.length >= 1000) {
    return withReport({
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason: 'spec evidence selection hit the 1000-row safety limit; narrow or consolidate bindings before retrying',
    });
  }

  const deferredContributions = await track('contributions', () => resolveItemCloseContributions({
    workItem: input.workItem, workspaceId: input.workspaceId ?? '', completion: input.completion,
    clauses: relevant, evidence, codeDeliverable: codeDeliverableOf,
  }, deps.contributionDeferral));
  const clauseKey = (clause: SpecClauseRevision) => `${clause.planSlug}/${clause.specId}@${clause.revision}:${clause.contentHash}`;
  const deferredKeys = new Set(deferredContributions.map((entry) =>
    `${entry.projection.planSlug}/${entry.projection.specId}@${entry.projection.revision}:${entry.projection.contentHash}`));
  const proven = new Set<string>();
  const checked: string[] = [];
  const carriedAcrossEvaluatorRevision: CarriedAdequacyCard[] = [];
  const failures: string[] = [];
  const pendingGradingAuditTargetIds = new Set<string>();
  const failedGradingAuditTargetIds = new Set<string>();
  const failedGradingAudits: FailedGradingAudit[] = [];
  for (const clause of relevant) {
    if (deferredKeys.has(clauseKey(clause))) continue;
    const certificates = deferredContributions.filter(entry =>
      `${entry.covering.planSlug}/${entry.covering.specId}@${entry.covering.revision}:${entry.covering.contentHash}` === clauseKey(clause));
    if (new Set(certificates.map(entry => JSON.stringify(entry.proofCohort))).size > 1) {
      failures.push(`${clause.specId}@${clause.revision}: contribution certificates disagree on the admitted proof cohort`);
      continue;
    }
    // Grade exactly the independently certified immutable cohort. An inadequate
    // row A may not borrow adequacy from an unreviewed row/cohort B.
    const certifiedIds = certificates[0] && new Set(certificates[0].proofCohort.map(pin => pin.bindingId));
    const clauseEvidence = certifiedIds ? evidence.filter(row => row.id != null && certifiedIds.has(row.id)) : evidence;
    const sourceBarTestRequirements = await track('source-bar', () => resolvePinnedSourceBarTestRequirements(
      clause.sourceBar,
      sourceBarRubricCache,
    ));
    const label = `${clause.specId}@${clause.revision}`;
    const mechanical = evaluateMechanicalTestAdequacy({ clause, evidence: clauseEvidence, sourceBarTestRequirements });
    if (mechanical.applicable) {
      if (mechanical.verdict === 'pass') { checked.push(label); proven.add(clauseKey(clause)); }
      else failures.push(`${label}: mechanical test adequacy failed — ${mechanical.gaps.join('; ')}`);
      continue;
    }
    const result = evaluateSpecTestAdequacy({
      clause,
      evidence: clauseEvidence,
      classRef: classFor(clause),
      harness: harnessSlug,
      workItemKind: input.workItem.kind,
      codeDeliverable: codeDeliverableOf(clause),
      sourceBarTestRequirements,
    });
    const evaluatorUnknownFailure = evaluatorUnknownFailureReason(label, result);
    if (evaluatorUnknownFailure) {
      // Stop before inspecting any scorecards. A prior clause may have exposed a
      // pending audit, but once any clause is unmeasurable that audit cannot unblock
      // this completion; returning now guarantees the caller never dispatches it.
      return withReport({
        ok: false,
        applicable: true,
        retryable: true,
        checked: [],
        reason: evaluatorUnknownFailure,
      });
    }
    if (result.verdict !== 'pass') {
      failures.push(adequacyFailureReason(label, result));
      continue;
    }
    const subjectRef = specTestAdequacySubjectRef(result.planSlug, result.specId, result.specRevision);
    const cards = await track('scorecards', () => listCards({
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      subjectRef,
      limit: 20,
    }));
    if (!cards.some((card) => scorecardMatches(card, result, clauseEvidence))) {
      const failedAuditsForLabel: FailedGradingAudit[] = [];
      const pendingAuditsForLabel: string[] = [];
      for (const card of cards) {
        // A clause can retain audits of earlier evidence. Only the selected
        // proof cohort can explain or unblock this completion attempt.
        if (!scorecardProofCohortMatches(card, result, clauseEvidence)) continue;
        const needsIdentityReopen = gradingAuditNeedsIdentityReopen(card);
        if (
          (card.gradingAudit?.state === 'pending' || card.gradingAudit?.state === 'failed' || needsIdentityReopen) &&
          !card.supersededBy &&
          !card.retracted &&
          card.issueId
        ) {
          if (card.gradingAudit?.state === 'pending' || needsIdentityReopen) {
            pendingGradingAuditTargetIds.add(card.issueId);
            pendingAuditsForLabel.push(card.issueId);
          } else {
            failedGradingAuditTargetIds.add(card.issueId);
            // WI-10002063 (1/2): carry the handle that actually reaches the findings.
            const audit = card.gradingAudit;
            failedAuditsForLabel.push({
              issueId: card.issueId,
              ...(audit?.auditIssueId ? { auditIssueId: audit.auditIssueId } : {}),
              ...(audit?.auditor ? { auditor: audit.auditor } : {}),
              ...(audit?.auditedAt ? { auditedAt: audit.auditedAt } : {}),
            });
          }
        }
      }
      failedGradingAudits.push(...failedAuditsForLabel);
      // WI-10002063 (2/2): a FAILED audit is not a scorecard MISMATCH, and saying so
      // matters more than it sounds. The generic wording below describes a MATCHING
      // problem, so an agent whose evidence matched fine reasonably concludes their
      // scorecard/verdict shape is wrong and goes off re-emitting cards — when the real
      // state is "a non-author auditor failed your grading". The wrong diagnosis is not
      // merely unhelpful, it is actively expensive. Branch on which one actually happened.
      failures.push(
        failedAuditsForLabel.length
          ? `${label}: grading audit FAILED — the evidence matched, but a non-author auditor failed the grading. ` +
              `Read the audit scorecard(s) for the findings: ${failedAuditsForLabel
                .map((entry) =>
                  entry.auditIssueId
                    ? entry.auditIssueId
                    : `(no audit card recorded for graded card ${entry.issueId})`,
                )
                .join(', ')}`
          : pendingAuditsForLabel.length
            ? `${label}: current proof cohort is awaiting a settled independent grading audit: ${pendingAuditsForLabel.join(', ')}`
            : (() => {
                const movedCohort = cards.some((card) =>
                  card.rerunRecipe?.evaluator === 'plans:evaluate-spec-test-adequacy' &&
                  card.rerunRecipe.current.supplied && ratingVerdictsMatch(card, result) &&
                  !scorecardProofCohortMatches(card, result, clauseEvidence));
                const detail = verdictChangeDetail(cards, result);
                return movedCohort
                  ? `${label}: audited scorecard proof cohort differs from current bound evidence; certify the current cohort and settle its independent audit`
                  : `${label}: no current terminal complete scorecard matches the exact evaluator verdicts${detail ? ` — ${detail}` : ''}`;
              })(),
      );
      continue;
    }
    // Only an evaluator-minted card (it carries a rerun recipe) has a grading revision to
    // report; a recipe without the stamp predates it and reads as revision 1.
    const admitting = cards.find((card) => scorecardMatches(card, result, clauseEvidence))!;
    const disposition = admitting.rerunRecipe?.evaluator === 'plans:evaluate-spec-test-adequacy'
      ? adequacyCardRevisionDisposition({
          recordedRevision: admitting.rerunRecipe.evaluatorRevision,
          recordedRatings: admitting.ratings,
          liveRatings: result.ratings,
        })
      : null;
    if (disposition?.state === 'carried') {
      carriedAcrossEvaluatorRevision.push({
        label,
        issueId: admitting.issueId ?? null,
        recordedRevision: disposition.recordedRevision,
        currentRevision: disposition.currentRevision,
      });
    }
    checked.push(label);
    proven.add(clauseKey(clause));
  }
  for (const entry of deferredContributions) {
    const pin = entry.covering;
    if (!proven.has(`${pin.planSlug}/${pin.specId}@${pin.revision}:${pin.contentHash}`)) {
      failures.push(`${entry.projection.specId}@${entry.projection.revision}: covering item contract was not proven`);
    }
  }
  if (failures.length) {
    return withReport({
      ok: false,
      applicable: true,
      retryable: true,
      checked,
      reason: failures.join('; '),
      ...(exempted.length ? { exempted } : {}),
      ...(pendingGradingAuditTargetIds.size ? { pendingGradingAuditTargetIds: [...pendingGradingAuditTargetIds] } : {}),
      ...(failedGradingAuditTargetIds.size ? { failedGradingAuditTargetIds: [...failedGradingAuditTargetIds] } : {}),
      ...(failedGradingAudits.length ? { failedGradingAudits: [...failedGradingAudits] } : {}),
    });
  }
  return withReport({
    ok: true,
    applicable: true,
    checked,
    ...(exempted.length ? { exempted } : {}),
    ...(deferredContributions.length ? { deferredContributions } : {}),
    ...(carriedAcrossEvaluatorRevision.length ? { carriedAcrossEvaluatorRevision } : {}),
  });
}

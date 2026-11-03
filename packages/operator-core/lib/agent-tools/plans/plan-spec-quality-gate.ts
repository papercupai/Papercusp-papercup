/** Exact specSetHash gate shared by plans:start and direct plan-item promotion (P-004). */
import {
  listScorecards,
  scorecardEvidenceFingerprint,
  settledGradingAuditIsCurrent,
  type ScorecardRow,
} from '../../scorecards';
import { scorecardGradingAuditKey } from '../../scorecard-emitted-events';
import { listTasks } from '../../task-manager/store';
import type { TaskRow } from '../../task-manager/types';
import { getAcceptanceRubricsForPlan } from '../../rubrics';
import { listSpecClauses } from './spec-clauses-store';
import {
  evaluatePlanSpecQuality,
  specQualityEvidenceWithoutReplay,
  SPEC_QUALITY_RUBRIC_REF,
  type PlanSpecQualityResult,
  type SpecQualityPlanItem,
} from './spec-quality';
import { PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from './spec-test-adequacy';

export type PlanSpecQualityGateCode =
  | 'spec_quality_failed'
  | 'spec_quality_scorecard_missing'
  | 'spec_quality_scorecard_grading_audit_pending'
  | 'spec_quality_scorecard_grading_audit_failed'
  | 'spec_quality_class_missing'
  | 'spec_quality_class_ambiguous'
  | 'spec_quality_class_invalid'
  | 'spec_quality_unavailable';

export interface PlanSpecQualityGateVerdict {
  satisfied: boolean;
  applicable: boolean;
  mode: 'report-only' | 'enforced';
  planSlug: string;
  specSetHash: string | null;
  classRef?: PlanClassRubricRef;
  scorecardId?: string;
  code?: PlanSpecQualityGateCode;
  message?: string;
  wouldBlock: string[];
  scorecardDiagnostics?: Array<{
    issueId: string;
    failedChecks: string[];
    differingCriteria: string[];
  }>;
  candidates?: Array<{
    classRef: PlanClassRubricRef;
    verdict: PlanSpecQualityResult['verdict'];
    wouldBlock: string[];
    subjectRef: string;
  }>;
}

type AcceptanceRubricRef = { rubricId?: string; classRef?: string | null };

type GateDeps = {
  listClauses?: typeof listSpecClauses;
  listCards?: typeof listScorecards;
  listTasks?: typeof listTasks;
  listAcceptanceRubrics?: (planSlug: string, options: { harnessSlug: string; strict: true }) => Promise<ReadonlyArray<AcceptanceRubricRef>>;
};

type ClassResolution =
  | { ok: true; classRef: PlanClassRubricRef }
  | {
      ok: false;
      code: Extract<
        PlanSpecQualityGateCode,
        'spec_quality_class_missing' | 'spec_quality_class_ambiguous' | 'spec_quality_class_invalid'
      >;
      wouldBlock: string[];
      message: string;
    };

function isPlanClassRubricRef(value: unknown): value is PlanClassRubricRef {
  return typeof value === 'string' && (PLAN_CLASS_RUBRIC_REFS as readonly string[]).includes(value);
}

export function resolvePersistedClassRef(planSlug: string, rubrics: readonly AcceptanceRubricRef[]): ClassResolution {
  if (rubrics.length === 0) {
    return {
      ok: false,
      code: 'spec_quality_class_missing',
      wouldBlock: ['acceptance-rubric-class-missing'],
      message:
        `Plan '${planSlug}' adopted first-class clauses but has no active acceptance rubric from which to resolve ` +
        'the authoritative plan class. Create an acceptance rubric with `rubrics:propose` (kind:"acceptance", ' +
        `subjectPlan:"${planSlug}", classRef:"<plan-class>"), then evaluate spec quality. ` +
        'Do not write classRef to the subject plan with plans:set-template-data; that plan may intentionally have no schema.',
    };
  }
  if (rubrics.length > 1) {
    return {
      ok: false,
      code: 'spec_quality_class_ambiguous',
      wouldBlock: ['acceptance-rubric-class-ambiguous'],
      message:
        `Plan '${planSlug}' has ${rubrics.length} active acceptance rubrics, so its authoritative plan class is ` +
        'ambiguous. Retire the competing rubric(s) and leave exactly one active acceptance rubric.',
    };
  }

  const classRef = rubrics[0]?.classRef;
  if (typeof classRef !== 'string' || classRef.length === 0) {
    return {
      ok: false,
      code: 'spec_quality_class_missing',
      wouldBlock: ['acceptance-rubric-class-missing'],
      message:
        `Plan '${planSlug}' has an active acceptance rubric, but its persisted template_data.classRef is missing. ` +
        `Bind it on the acceptance rubric with rubrics:amend { rubricRef:"${rubrics[0]?.rubricId ?? '<acceptance-rubric-ref>'}", ` +
        `classRef:"<plan-class>" }; use exactly one of ${PLAN_CLASS_RUBRIC_REFS.join(', ')}. ` +
        'Do not use plans:set-template-data on the subject plan: its missing schema correctly yields no_template. ' +
        'Caller-supplied subject refs are not authoritative.',
    };
  }
  if (!isPlanClassRubricRef(classRef)) {
    return {
      ok: false,
      code: 'spec_quality_class_invalid',
      wouldBlock: ['acceptance-rubric-class-invalid'],
      message:
        `Plan '${planSlug}' has an invalid persisted acceptance-rubric classRef '${classRef}'. ` +
        `Use exactly one of ${PLAN_CLASS_RUBRIC_REFS.join(', ')}; arbitrary rubric or subject refs cannot select the class.`,
    };
  }
  return { ok: true, classRef };
}

function acceptedRating(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rating = (value as { rating?: unknown }).rating;
  return typeof rating === 'string' && ['pass', 'waived', 'not-applicable'].includes(rating.toLowerCase());
}

/**
 * EI-22759986393772535: the draft-provenance correction briefly also reworded
 * ALL-ACTIVE evidence, without changing its assertion. Preserve that exact
 * published variant, not arbitrary prose or verdict drift. Mixed sets never
 * have this all-provenance suffix, so their old misleading evidence still fails.
 * Keep the general scorecard/audit fingerprint untouched.
 */
function matchesSpecQualityEvidence(card: ScorecardRow, evaluation: PlanSpecQualityResult): boolean {
  const fingerprint = (ratings: ScorecardRow['ratings']) => scorecardEvidenceFingerprint({
    rubricRef: SPEC_QUALITY_RUBRIC_REF,
    ratings,
    instrumentSnapshots: card.instrumentSnapshots,
  });
  // A stored fingerprint must first attest to the actual stored ratings, not
  // merely to what the current evaluator would have emitted.
  if (card.evidenceFingerprint !== fingerprint(card.ratings)) return false;
  const currentFindings = Object.fromEntries(Object.entries(card.ratings).map(([key, entry]) => [key, {
    ...entry, evidence: specQualityEvidenceWithoutReplay(entry.evidence, evaluation),
  }]));
  if (fingerprint(currentFindings) === fingerprint(evaluation.ratings)) return true;

  const identity = evaluation.ratings['stable-revision-identity'];
  const allActiveSuffix =
    ` ${evaluation.clauseCount} current clause(s) have unique identities, content hashes, and acceptance provenance.`;
  if (identity.rating !== 'pass' || !identity.evidence.endsWith(allActiveSuffix)) return false;
  const interimRatings = {
    ...evaluation.ratings,
    'stable-revision-identity': {
      ...identity,
      evidence: identity.evidence.slice(0, -allActiveSuffix.length)
        + allActiveSuffix.replace(' current clause(s)', ' active/accepted current clause(s)'),
    },
  };
  return fingerprint(currentFindings) === fingerprint(interimRatings);
}

/**
 * Every scorecard test EXCEPT the P-013 grade-the-grader audit stamp — deliberately
 * split from {@link scorecardMatches} so a card that fails ONLY on a pending/failed
 * audit can still be recognised and reported precisely, instead of collapsing into
 * the same "no scorecard was ever emitted" verdict as a card that never existed
 * (EI-22068670622018218: the two look identical to a caller once merged).
 */
function scorecardStructurallyExact(card: ScorecardRow, evaluation: PlanSpecQualityResult): boolean {
  return (
    card.rubricRef === SPEC_QUALITY_RUBRIC_REF &&
    card.subject?.kind === 'plan' &&
    card.subject.ref === evaluation.scorecardDraft.subject.ref &&
    card.rubricResolved &&
    card.missingKeys.length === 0 &&
    card.extraKeys.length === 0 &&
    !card.synthesized &&
    !card.retracted &&
    !card.supersededBy &&
    card.provisional === undefined &&
    matchesSpecQualityEvidence(card, evaluation) &&
    Object.values(card.ratings).every(acceptedRating)
  );
}

function scorecardMatches(card: ScorecardRow, evaluation: PlanSpecQualityResult): boolean {
  return (
    scorecardStructurallyExact(card, evaluation) &&
    settledGradingAuditIsCurrent(card)
  );
}

/** Keep rejected evidence addressable instead of describing an existing card as absent. */
function rejectedScorecardDiagnostic(card: ScorecardRow, evaluation: PlanSpecQualityResult) {
  const checks: Record<string, boolean> = {
    rubric: card.rubricRef === SPEC_QUALITY_RUBRIC_REF,
    subject: card.subject?.kind === 'plan' && card.subject.ref === evaluation.scorecardDraft.subject.ref,
    completeness: card.rubricResolved && card.missingKeys.length === 0 && card.extraKeys.length === 0,
    organic: !card.synthesized,
    current: !card.retracted && !card.supersededBy && card.provisional === undefined,
    evidence: matchesSpecQualityEvidence(card, evaluation),
    ratings: Object.values(card.ratings).every(acceptedRating),
    audit: settledGradingAuditIsCurrent(card),
  };
  const differingCriteria = [...new Set([...Object.keys(card.ratings), ...Object.keys(evaluation.ratings)])]
    .filter((key) => {
      const stored = card.ratings[key];
      const current = Object.entries(evaluation.ratings).find(([criterion]) => criterion === key)?.[1];
      return !stored || !current || stored.rating !== current.rating ||
        specQualityEvidenceWithoutReplay(stored.evidence, evaluation) !== current.evidence;
    }).sort();
  return { issueId: card.issueId, failedChecks: Object.keys(checks).filter((key) => !checks[key]), differingCriteria };
}

async function reservedGradingAuditorGuidance(
  card: ScorecardRow,
  readTasks: typeof listTasks,
): Promise<string | null> {
  const reservation = card.gradingAudit?.dispatchReservation;
  if (!reservation) return null;

  const expectedKey = `grading-audit:${card.issueId}`;
  const reservationDescription = `The grading-audit dispatch reservation was recorded at '${reservation.reservedAt}'.`;
  if (reservation.key !== expectedKey || !reservation.reservedAt.trim()) {
    return `${reservationDescription} Its lease does not match this scorecard, so do not emit another audit; retry only after the current audit state is checked.`;
  }

  let tasks: TaskRow[];
  try {
    tasks = await readTasks({
      states: ['pending', 'running'],
      labelPrefix: expectedKey,
      limit: 10,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${reservationDescription} The live auditor-task lookup failed (${reason}), so its assignee could not be confirmed. Do not emit another audit or file a duplicate request; retry plans:start after this audit settles. No grading-audit await key is available.`;
  }

  const auditors = tasks.filter((task) => {
    const label = typeof task.detail?.label === 'string' ? task.detail.label : '';
    return task.class === 'agent-session' &&
      (task.state === 'pending' || task.state === 'running') &&
      (label === expectedKey || label.startsWith(`${expectedKey}:`)) &&
      (task.workItemId == null || task.workItemId === card.issueId);
  });
  const taskDescriptions = auditors.map((task) => {
    const owner = typeof task.detail?.coordOwnerId === 'string' ? task.detail.coordOwnerId.trim() : '';
    return owner ? `task '${task.taskId}' (owner '${owner}')` : `task '${task.taskId}'`;
  });
  const auditorDescription = taskDescriptions.length === 1
    ? `The already-reserved auditor is ${taskDescriptions[0]}.`
    : taskDescriptions.length > 1
      ? `The reservation currently matches multiple live auditor tasks: ${taskDescriptions.join(', ')}.`
      : 'No live auditor task row is currently visible for this reservation.';

  const settlementKey = scorecardGradingAuditKey(card.issueId);
  return `${reservationDescription} ${auditorDescription} Do not emit another audit or file a duplicate request. ` +
    `To wait for settlement, use events:await { event:'${settlementKey}' } and retry plans:start after it fires. ` +
    `If the auditor's first turn failed or the card stays pending without progress, run ` +
    `scorecards:repair { targetIds:['${card.issueId}'] } to reconcile this exact pending audit. ` +
    `Repair preserves an auditor that is still viable or whose state is unknown.`;
}

/**
 * Legacy/no-clause plans are report-only so rollout cannot freeze the existing
 * queue. A plan becomes enforcement-eligible by adopting any first-class clause;
 * from that point incomplete clauses, uncovered items, and stale scorecards fail
 * closed before promotion.
 */
export async function evaluatePlanSpecQualityGate(
  input: {
    harnessSlug: string;
    planSlug: string;
    planItemIds: readonly string[];
    planItems?: readonly SpecQualityPlanItem[];
  },
  deps: GateDeps = {},
): Promise<PlanSpecQualityGateVerdict> {
  const listClauses = deps.listClauses ?? listSpecClauses;
  const listCards = deps.listCards ?? listScorecards;
  const readTasks = deps.listTasks ?? listTasks;
  const listAcceptanceRubrics = deps.listAcceptanceRubrics ?? getAcceptanceRubricsForPlan;
  let clauses;
  try {
    clauses = await listClauses({ harnessSlug: input.harnessSlug, planSlug: input.planSlug });
  } catch (error) {
    return {
      satisfied: false,
      applicable: false,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: null,
      code: 'spec_quality_unavailable',
      wouldBlock: ['spec-quality-read-unavailable'],
      message:
        `Spec-quality report could not read first-class clauses (${error instanceof Error ? error.message : String(error)}). ` +
        'The clause store is unavailable, not empty. Refusing promotion until the current contract can be checked; successfully read no-clause plans remain report-only.',
    };
  }
  if (clauses.length === 0) {
    return {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: input.planSlug,
      specSetHash: null,
      wouldBlock: ['no-first-class-spec-clauses'],
      message:
        'Report-only: this plan has not adopted first-class clauses. Once any clause exists, exact spec-quality scorecards become fail-closed for start/promotion.',
    };
  }

  let acceptanceRubrics;
  try {
    acceptanceRubrics = await listAcceptanceRubrics(input.planSlug, { harnessSlug: input.harnessSlug, strict: true });
  } catch (error) {
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: null,
      code: 'spec_quality_unavailable',
      wouldBlock: ['acceptance-rubric-class-read-unavailable'],
      message:
        `Plan '${input.planSlug}' adopted first-class clauses, but its authoritative acceptance-rubric class ` +
        `could not be read (${error instanceof Error ? error.message : String(error)}). Refusing promotion fail-closed; retry after the rubric store is healthy.`,
    };
  }

  const classResolution = resolvePersistedClassRef(input.planSlug, acceptanceRubrics);
  if (!classResolution.ok) {
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: null,
      code: classResolution.code,
      wouldBlock: classResolution.wouldBlock,
      message: classResolution.message,
    };
  }

  const evaluation = evaluatePlanSpecQuality({
    planSlug: input.planSlug,
    harnessSlug: input.harnessSlug,
    planItemIds: input.planItemIds,
    planItems: input.planItems,
    clauses,
    classRef: classResolution.classRef,
  });
  const candidates = [
    {
      classRef: evaluation.classRef,
      verdict: evaluation.verdict,
      wouldBlock: [...evaluation.wouldBlock],
      subjectRef: evaluation.scorecardDraft.subject.ref,
    },
  ];
  if (evaluation.verdict !== 'pass') {
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: evaluation.specSetHash,
      classRef: evaluation.classRef,
      code: 'spec_quality_failed',
      wouldBlock: [...evaluation.wouldBlock],
      candidates,
      message:
        `Plan '${input.planSlug}' fails spec quality for its persisted plan class ${evaluation.classRef}. ` +
        `It would block on: ${evaluation.wouldBlock.join(', ')}. ` +
        `Run plans:evaluate-spec-quality { slug:'${input.planSlug}', classRef:'${evaluation.classRef}' } for exact per-criterion reasons, repair the clauses/exemptions, then emit the returned scorecard.`,
    };
  }

  let scorecardDiagnostics: PlanSpecQualityGateVerdict['scorecardDiagnostics'] = [];
  try {
    const cards = await listCards({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      subjectRef: evaluation.scorecardDraft.subject.ref,
      limit: 20,
      // This gate compares the live clause/rubric identity and settled audit.
      // Host-generation telemetry is not part of that contract, and measuring
      // it here adds a systemd lookup to every implementation-authority check.
      includeGeneration: false,
    });
    const matching = cards.find((card) => scorecardMatches(card, evaluation));
    if (matching) {
      return {
        satisfied: true,
        applicable: true,
        mode: 'enforced',
        planSlug: input.planSlug,
        specSetHash: evaluation.specSetHash,
        classRef: evaluation.classRef,
        scorecardId: matching.issueId,
        wouldBlock: [],
        candidates,
      };
    }
    // Not accepted — but distinguish "exact card exists, still audit-pending/failed"
    // from "no exact card was ever emitted" so the refusal can name the real next
    // step instead of pointing back at scorecards:emit, which the caller already ran.
    const pendingAudit = cards.find(
      (card) => scorecardStructurallyExact(card, evaluation) && card.gradingAudit?.state === 'pending',
    );
    if (pendingAudit) {
      const reservationGuidance = await reservedGradingAuditorGuidance(pendingAudit, readTasks);
      return {
        satisfied: false,
        applicable: true,
        mode: 'enforced',
        planSlug: input.planSlug,
        specSetHash: evaluation.specSetHash,
        classRef: evaluation.classRef,
        scorecardId: pendingAudit.issueId,
        code: 'spec_quality_scorecard_grading_audit_pending',
        wouldBlock: ['exact-specSetHash-scorecard-grading-audit-pending'],
        candidates,
        message: reservationGuidance
          ?
          `Plan '${input.planSlug}' has an exact terminal ${SPEC_QUALITY_RUBRIC_REF} scorecard ` +
          `(${pendingAudit.issueId}) for exact specSetHash ${evaluation.specSetHash}, but it ` +
          "does not yet satisfy this gate: P-013 grade-the-grader stamps every terminal standard-rubric card " +
          "'gradingAudit.state: pending' until a NON-AUTHOR independently audits it, and this gate only accepts " +
          `an audited (or audit-exempt) card. ${reservationGuidance}`
          :
          `Plan '${input.planSlug}' has an exact terminal ${SPEC_QUALITY_RUBRIC_REF} scorecard ` +
          `(${pendingAudit.issueId}) for exact specSetHash ${evaluation.specSetHash}, but it ` +
          "does not yet satisfy this gate: P-013 grade-the-grader stamps every terminal standard-rubric card " +
          "'gradingAudit.state: pending' until a NON-AUTHOR independently audits it, and this gate only accepts " +
          'an audited (or audit-exempt) card. Have a DIFFERENT agent settle it — ' +
          `scorecards:emit { rubricRef:'grading-integrity', terminal:true, subject:{ kind:'scorecard', ` +
          `ref:'${pendingAudit.issueId}' }, ratings:{...} } — then retry plans:start. Re-running ` +
          'plans:evaluate-spec-quality / scorecards:emit yourself files a duplicate pending card and does not ' +
          'settle this one (self-audits are refused).',
      };
    }
    const failedAudit = cards.find(
      (card) => scorecardStructurallyExact(card, evaluation) && card.gradingAudit?.state === 'failed',
    );
    if (failedAudit) {
      return {
        satisfied: false,
        applicable: true,
        mode: 'enforced',
        planSlug: input.planSlug,
        specSetHash: evaluation.specSetHash,
        classRef: evaluation.classRef,
        scorecardId: failedAudit.issueId,
        code: 'spec_quality_scorecard_grading_audit_failed',
        wouldBlock: ['exact-specSetHash-scorecard-grading-audit-failed'],
        candidates,
        message:
          `Plan '${input.planSlug}' has an exact terminal ${SPEC_QUALITY_RUBRIC_REF} scorecard ` +
          `(${failedAudit.issueId}) for exact specSetHash ${evaluation.specSetHash}, but its ` +
          'independent P-013 grading-integrity audit FAILED it, so it cannot satisfy this gate. ' +
          // WI-10002063 (sibling of the spec-test-adequacy defect): telling an agent to "repair
          // whatever the audit flagged" while handing back only the GRADED card's id leaves the
          // findings unreachable — the graded card does not contain them, the AUDIT card does.
          (failedAudit.gradingAudit?.auditIssueId
            ? `Read the audit card ${failedAudit.gradingAudit.auditIssueId} for the findings. Then re-run `
            : '(No audit card id was recorded on the graded card, so the findings are not directly ' +
              'reachable from here.) Re-run ') +
          `plans:evaluate-spec-quality { slug:'${input.planSlug}', classRef:'${evaluation.classRef}' }, ` +
          'repair whatever the audit flagged, then emit a fresh scorecard through scorecards:emit for a new ' +
          'grading-integrity audit.',
      };
    }
    scorecardDiagnostics = cards.map((card) => rejectedScorecardDiagnostic(card, evaluation));
  } catch (error) {
    return {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: input.planSlug,
      specSetHash: evaluation.specSetHash,
      code: 'spec_quality_unavailable',
      wouldBlock: ['scorecard-read-unavailable'],
      candidates,
      message:
        `Plan '${input.planSlug}' is enforcement-eligible, but the exact spec-quality scorecard read failed ` +
        `(${error instanceof Error ? error.message : String(error)}). Refusing promotion fail-closed; retry after the scorecard store is healthy.`,
    };
  }

  return {
    satisfied: false,
    applicable: true,
    mode: 'enforced',
    planSlug: input.planSlug,
    specSetHash: evaluation.specSetHash,
    classRef: evaluation.classRef,
    code: 'spec_quality_scorecard_missing',
    wouldBlock: ['exact-specSetHash-scorecard-missing'],
    candidates,
    scorecardDiagnostics,
    message:
      `Plan '${input.planSlug}' has structurally passing clauses but no current complete terminal ` +
      `${SPEC_QUALITY_RUBRIC_REF} scorecard for exact specSetHash ${evaluation.specSetHash} under persisted ` +
      `class ${evaluation.classRef}. ` +
      `Run plans:evaluate-spec-quality { slug:'${input.planSlug}', classRef:'${evaluation.classRef}' }, ` +
      'emit its scorecardDraft through scorecards:emit, then retry. Any clause revision changes the hash and invalidates older cards.',
  };
}

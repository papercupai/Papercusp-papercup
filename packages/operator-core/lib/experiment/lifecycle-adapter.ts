/**
 * Common lifecycle adapters for Blender learning producers (P-011).
 *
 * Scout, Gym, calibration, transfer, regret, and Red Queen each have useful
 * domain-specific stores.  This module gives their outputs one typed boundary
 * before a decision or activation is allowed: candidate → experiment → typed
 * evidence → spend → decision → activation/outcomes.  The adapters are pure;
 * callers supply the already-recorded source evidence and remain responsible
 * for their existing stores and governor reservations.
 *
 * Legacy writers are intentionally not removed here.  `evaluateLifecycleParity`
 * and `canRetireLegacyWriter` make the retirement condition explicit and
 * testable, so a source can be retired only after its evidence is represented
 * in the common contract and no legacy rows remain to drain.
 */

import {
  validateLearningContract,
  type LearningActivation,
  type LearningActor,
  type LearningCandidate,
  type LearningContract,
  type LearningDecision,
  type LearningEvidence,
  type LearningEvidenceKind,
  type LearningExperiment,
  type LearningOutcome,
  type LearningSpend,
} from './types';
import { createHash } from 'node:crypto';

export const LEARNING_PRODUCERS = ['scout', 'gym', 'calibration', 'transfer', 'regret', 'red-queen'] as const;
export type LearningProducer = (typeof LEARNING_PRODUCERS)[number];

export type ProducerVerdict = 'accept' | 'reject' | 'inconclusive';

export interface ProducerLifecycleInput {
  candidate: LearningCandidate;
  experiment: LearningExperiment;
  evidence: readonly LearningEvidence[];
  spend: LearningSpend;
  verdict: ProducerVerdict;
  authority: LearningActor;
  reason: string;
  decidedAt: string;
  activation?: LearningActivation;
  outcomes?: readonly LearningOutcome[];
}

export interface LifecycleAdapterResult {
  producer: LearningProducer;
  contract: LearningContract;
  validation: ReturnType<typeof validateLearningContract>;
}

const verdictMap: Record<ProducerVerdict, LearningDecision['verdict']> = {
  accept: 'accepted',
  reject: 'rejected',
  inconclusive: 'inconclusive',
};

/** Freeze the detached JSON receipt, including evidence and inherited decisions. */
function freezeReceipt<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeReceipt(child);
  }
  return value;
}

/** Build the one common contract from any producer's already-recorded output. */
export function buildProducerLifecycleContract(
  producer: LearningProducer,
  input: ProducerLifecycleInput,
): LifecycleAdapterResult {
  // Validate and retain the same snapshot; caller mutation cannot change the
  // evidence behind an already-computed verdict, and callers stay writable.
  input = structuredClone(input);
  const decision: LearningDecision = {
    verdict: verdictMap[input.verdict],
    authority: input.authority,
    reason: input.reason,
    evidenceIds: input.evidence.map((evidence) => evidence.id),
    decidedAt: input.decidedAt,
  };
  const contract: LearningContract = {
    contractVersion: '1',
    candidate: input.candidate,
    experiment: input.experiment,
    evidence: input.evidence,
    spend: input.spend,
    decision,
    ...(input.activation ? { activation: input.activation } : {}),
    outcomes: input.outcomes ?? [],
  };
  return freezeReceipt({ producer, contract, validation: validateLearningContract(contract) });
}

/** Discovery and domain verdicts are observations until the complete contract exists. */
export interface ProducerObservationInput {
  stage: 'observation';
  workspaceId: string;
  sourceRef: string;
  recordedAt: string;
  /** The actual persisted row, including its original verdict/provenance. */
  source: Record<string, unknown>;
  /** Actual producer evaluation, including partial/unknown pins. It remains
   * evidence on an observation and never implies contract acceptance. */
  evaluation?: unknown;
  /** Supplied only by a producer's evaluated decision path. */
  contract?: LearningContract;
}

export interface ProducerLifecycleObservation {
  receiptVersion: '1';
  stage: ProducerLifecycleStage;
  producer: LearningProducer;
  workspaceId: string;
  sourceRef: string;
  sourceHash: string;
  source: Record<string, unknown>;
  recordedAt: string;
  contract: LearningContract | null;
  promotionAllowed: boolean;
  validation?: ReturnType<typeof validateLearningContract>;
  /** Immutable evaluated decisions survive subsequent native observations. */
  decisions?: readonly { contract: LearningContract; sourceHash: string; recordedAt: string }[];
  /** Added on read; an unadapted later source update is visibly stale. */
  sourceCurrent?: boolean;
  /** Missing full-contract sections; no synthetic pins, actors or zero-dollar spend. */
  missing: readonly string[];
  evaluation?: unknown;
  evaluationSourceHash?: string;
  evaluationCurrent?: boolean;
  /**
   * The source-linked common lifecycle projection. It is deliberately partial:
   * native producer rows often do not carry every execution pin or a settled
   * reservation. Unknowns stay null/missing here and never become promotion
   * authority. `contract` remains the stricter, validated decision contract.
   */
  lifecycle: ProducerLifecycleSnapshot;
}

export type ProducerLifecycleStage = 'observation' | 'candidate' | 'experiment' | 'evidence' | 'spend' | 'decision' | 'activation' | 'outcome';
export type LifecycleSectionStatus = 'measured' | 'partial' | 'unknown' | 'not-applicable';

type Observed<T> = T extends readonly (infer U)[]
  ? readonly Observed<U>[]
  : T extends object
    ? { readonly [K in keyof T]?: Observed<T[K]> | null }
    : T | null;

export interface LifecycleSection<T extends object> {
  status: LifecycleSectionStatus;
  value: Observed<T> | null;
  missingFields: readonly string[];
}

export interface LifecycleListSection<T extends object> {
  status: LifecycleSectionStatus;
  values: readonly Observed<T>[];
  missingFields: readonly string[];
}

export interface ProducerLifecycleSnapshot {
  schemaVersion: '1';
  producer: LearningProducer;
  sourceRef: string;
  sourceHash: string;
  stage: ProducerLifecycleStage;
  candidate: LifecycleListSection<LearningCandidate>;
  experiment: LifecycleSection<LearningExperiment>;
  evidence: LifecycleListSection<LearningEvidence>;
  spend: LifecycleSection<LearningSpend>;
  decision: LifecycleSection<LearningDecision>;
  activation: LifecycleSection<LearningActivation>;
  outcomes: LifecycleListSection<LearningOutcome>;
  missing: readonly string[];
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function sourceId(sourceRef: string): string {
  const separator = sourceRef.indexOf(':');
  return separator < 0 ? sourceRef : sourceRef.slice(separator + 1);
}

function hashedText(value: unknown): string | null {
  return typeof value === 'string'
    ? createHash('sha256').update(value).digest('hex')
    : null;
}

function lifecycleSection<T extends object>(
  value: Observed<T> | null,
  missingFields: readonly string[],
  notApplicable = false,
): LifecycleSection<T> {
  if (notApplicable) return { status: 'not-applicable', value: null, missingFields: [] };
  if (!value) return { status: 'unknown', value: null, missingFields };
  return { status: missingFields.length ? 'partial' : 'measured', value, missingFields };
}

function lifecycleList<T extends object>(
  values: readonly Observed<T>[],
  missingFields: readonly string[],
  notApplicable = false,
): LifecycleListSection<T> {
  if (notApplicable) return { status: 'not-applicable', values: [], missingFields: [] };
  if (values.length === 0) return { status: 'unknown', values, missingFields };
  return { status: missingFields.length ? 'partial' : 'measured', values, missingFields };
}

const contractMissingFields = {
  candidate: ['id', 'version', 'parentVersion', 'variantHash', 'actor', 'potScope', 'createdAt'],
  experiment: ['batteryId', 'testId', 'baselineId', 'challengerId', 'taskHash', 'modelHash', 'promptHash', 'rubricHash', 'codeHash', 'repeats', 'startedAt'],
  spend: ['requestedUsd', 'reservedUsd', 'usedUsd', 'unsettledUsd', 'settledAt'],
  decision: ['verdict', 'authority', 'reason', 'evidenceIds', 'decidedAt'],
  activation: ['version', 'parentVersion', 'rollbackVersion', 'exposure', 'activatedAt'],
} as const;

function contractLifecycle(
  producer: LearningProducer,
  sourceRef: string,
  sourceHash: string,
  contract: LearningContract,
): Omit<ProducerLifecycleSnapshot, 'stage' | 'missing'> {
  const validation = validateLearningContract(contract);
  const errorsFor = (prefix: string) => validation.errors.filter((error) => error.startsWith(prefix));
  const evidenceErrors = validation.errors.filter((error) => error.startsWith('evidence ') || error.startsWith('decision references'));
  return {
    schemaVersion: '1', producer, sourceRef, sourceHash,
    candidate: lifecycleList([contract.candidate as Observed<LearningCandidate>], errorsFor('candidate.')),
    experiment: lifecycleSection(contract.experiment as Observed<LearningExperiment>, errorsFor('experiment.')),
    evidence: lifecycleList(contract.evidence as readonly Observed<LearningEvidence>[], evidenceErrors),
    spend: lifecycleSection(contract.spend as Observed<LearningSpend>, errorsFor('spend.')),
    decision: lifecycleSection(contract.decision as Observed<LearningDecision>,
      validation.errors.filter((error) => error.startsWith('decision ') || error.startsWith('accepted decision'))),
    activation: lifecycleSection(contract.activation as Observed<LearningActivation> | undefined ?? null,
      errorsFor('activation.'), !contract.activation),
    outcomes: lifecycleList(contract.outcomes as readonly Observed<LearningOutcome>[], []),
  };
}

/** Preserve only producer facts already present in its source row/evaluation. */
function buildProducerLifecycleSnapshot(input: {
  producer: LearningProducer;
  sourceRef: string;
  sourceHash: string;
  source: Record<string, unknown>;
  evaluation?: unknown;
  contract?: LearningContract | null;
}): ProducerLifecycleSnapshot {
  const { producer, sourceRef, sourceHash, source } = input;
  const rowId = sourceId(sourceRef);
  const evaluation = objectValue(input.evaluation);
  const common = input.contract
    ? contractLifecycle(producer, sourceRef, sourceHash, input.contract)
    : null;

  let candidate: LifecycleListSection<LearningCandidate> = lifecycleList([], ['source candidate identity']);
  let experiment: LifecycleSection<LearningExperiment> = lifecycleSection(null, ['execution and evaluation pins']);
  let evidence: LifecycleListSection<LearningEvidence> = lifecycleList([], ['source-linked measured evidence']);
  let spend: LifecycleSection<LearningSpend> = lifecycleSection(null, ['governor reservation and settlement']);
  let decision: LifecycleSection<LearningDecision> = lifecycleSection(null, ['native decision and authority']);
  let activation: LifecycleSection<LearningActivation> = lifecycleSection(null, ['activation and rollback evidence']);
  let outcomes: LifecycleListSection<LearningOutcome> = lifecycleList([], ['measured outcome']);

  if (common) {
    ({ candidate, experiment, evidence, spend, decision, activation, outcomes } = common);
  } else if (producer === 'scout') {
    const candidateValue: Observed<LearningCandidate> = {
      id: rowId,
      version: null,
      parentVersion: null,
      variantHash: null,
      actor: null,
      potScope: { workspaceId: stringValue(source.workspace_id), potId: null },
      createdAt: isoValue(source.routed_at),
    };
    candidate = lifecycleList([candidateValue], ['version', 'parentVersion', 'variantHash', 'actor', 'potScope.potId']);
    experiment = lifecycleSection(null, ['Scout routes are not controlled evaluation runs'], true);
    decision = lifecycleSection(null, ['Scout routes have no native acceptance decision'], true);
    activation = lifecycleSection(null, ['Scout routes do not activate a candidate'], true);
    const grade = numberValue(source.human_grade);
    if (grade !== null) {
      outcomes = lifecycleList([{
        status: 'matured', measuredAt: isoValue(source.graded_at), value: grade, artifactRefs: [sourceRef],
      }], source.graded_at == null ? ['measuredAt'] : []);
    } else {
      outcomes = lifecycleList([], ['human grade or terminal route outcome']);
    }
  } else if (producer === 'gym') {
    const verdict = objectValue(source.candidate_verdict);
    const hashes = objectValue(verdict.hashes);
    const proposedHash = stringValue(hashes.variantHash) ?? hashedText(source.proposed_md);
    const parentHash = stringValue(hashes.parentHash) ?? hashedText(source.original_md);
    const cvCandidate = stringValue(verdict.candidateId) ?? stringValue(source.variant_id) ?? rowId;
    candidate = lifecycleList([{
      id: cvCandidate, version: null, parentVersion: stringValue(verdict.parentId) ?? parentHash,
      variantHash: proposedHash, actor: null,
      potScope: { workspaceId: stringValue(source.workspace_id), potId: null },
      createdAt: isoValue(source.created_at),
    }], [
      'version', 'actor', 'potScope.potId',
      ...(stringValue(verdict.parentId) || parentHash ? [] : ['parentVersion']),
      ...(proposedHash ? [] : ['variantHash']),
      ...(isoValue(source.created_at) ? [] : ['createdAt']),
    ]);
    const evaluationValue = objectValue(verdict.evaluation);
    const experimentValue: Observed<LearningExperiment> = {
      batteryId: null,
      testId: null,
      baselineId: stringValue(verdict.parentId),
      challengerId: stringValue(verdict.candidateId),
      taskHash: stringValue(hashes.taskHash),
      modelHash: null,
      promptHash: null,
      rubricHash: stringValue(hashes.rubricHash),
      codeHash: stringValue(hashes.codeHash),
      repeats: null,
      startedAt: null,
      completedAt: isoValue(verdict.recordedAt),
    };
    experiment = lifecycleSection(experimentValue, [
      ...(!stringValue(verdict.parentId) ? ['baselineId'] : []),
      ...(!stringValue(verdict.candidateId) ? ['challengerId'] : []),
      ...(!stringValue(hashes.taskHash) ? ['taskHash'] : []),
      'batteryId', 'testId', 'modelHash', 'promptHash',
      ...(!stringValue(hashes.rubricHash) ? ['rubricHash'] : []),
      ...(!stringValue(hashes.codeHash) ? ['codeHash'] : []), 'repeats', 'startedAt',
    ]);
    const gateRows = arrayValue(verdict.gateResults).map(objectValue);
    const gateEvidence = gateRows.map((gate, index): Observed<LearningEvidence> => {
      const gateName = stringValue(gate.gate) ?? `gate-${index + 1}`;
      const gateStatus = gate.status === 'pass' || gate.status === 'fail' || gate.status === 'not-measured'
        ? gate.status : 'not-measured';
      const details = objectValue(gate.evidence);
      const coverage = objectValue(details.coverage);
      const refs = arrayValue(details.artifacts).filter((ref): ref is string => typeof ref === 'string');
      const kind = /probe/i.test(gateName) ? 'probe'
        : /cost/i.test(gateName) ? 'cost'
          : /regress|anchor/i.test(gateName) ? 'regression' : 'objective';
      return {
        id: `${sourceRef}:${gateName}`, kind, status: gateStatus,
        coverage: { required: numberValue(coverage.required) ?? 1,
          measured: numberValue(coverage.measured) ?? (gateStatus === 'not-measured' ? 0 : 1) },
        artifactRefs: refs.length ? refs : [sourceRef], recordedAt: isoValue(verdict.recordedAt),
      };
    });
    evidence = lifecycleList(gateEvidence, gateEvidence.length ? [] : ['candidate_verdict.gateResults']);
    const nativeStatus = source.status;
    if (nativeStatus === 'accepted' || nativeStatus === 'rejected') {
      const evidenceIds = gateEvidence.map((item) => String(item.id));
      decision = lifecycleSection({
        verdict: nativeStatus === 'accepted' ? 'accepted' : 'rejected',
        authority: null, reason: null, evidenceIds, decidedAt: isoValue(source.decided_at),
      }, [
        'authority (not persisted on gym_proposals)', 'reason (decision rationale is not persisted separately)',
        ...(isoValue(source.decided_at) ? [] : ['decidedAt']),
      ]);
    } else {
      decision = lifecycleSection(null, ['Gym proposal remains pending or has no terminal acceptance/rejection'], true);
    }
    // Gym evaluation costs are reported by its domain evaluator; they are not a
    // governor reservation/settlement and therefore cannot populate LearningSpend.
    spend = lifecycleSection(null, evaluationValue ? ['governor reservation and settlement (reported evaluation cost is not settlement)'] : ['governor reservation and settlement']);
    activation = source.status === 'accepted'
      ? lifecycleSection({ version: proposedHash, parentVersion: parentHash, rollbackVersion: null,
          exposure: null, activatedAt: isoValue(source.decided_at) }, ['rollbackVersion', 'exposure'])
      : lifecycleSection(null, ['proposal has not been activated'], true);
    outcomes = lifecycleList([], ['post-acceptance outcome window has not produced a measured outcome']);
  } else if (producer === 'calibration') {
    candidate = lifecycleList([], [], true);
    experiment = lifecycleSection(null, [], true);
    const scored = source.outcome === true || source.outcome === false;
    const resolvedAt = isoValue(source.resolved_at);
    evidence = lifecycleList([{
      id: `calibration:${rowId}`, kind: 'objective',
      status: scored ? (source.outcome === true ? 'pass' : 'fail') : 'not-measured',
      coverage: { required: 1, measured: scored ? 1 : 0 }, artifactRefs: [sourceRef],
      recordedAt: resolvedAt ?? isoValue(source.created_at),
    }], []);
    decision = lifecycleSection(null, [], true);
    activation = lifecycleSection(null, [], true);
    outcomes = lifecycleList([{
      status: resolvedAt ? (scored ? 'matured' : 'right-censored') : 'pending',
      measuredAt: resolvedAt, value: scored ? (source.outcome === true ? 1 : 0) : null,
      artifactRefs: [sourceRef],
    }], []);
  } else if (producer === 'transfer') {
    const transferEvaluation = objectValue(input.evaluation);
    const reservation = objectValue(transferEvaluation.reservation);
    const signature = stringValue(source.signature);
    const pot = stringValue(source.pot_slug);
    candidate = lifecycleList([{
      id: rowId, version: null, parentVersion: null, variantHash: signature, actor: null,
      potScope: { workspaceId: stringValue(source.workspace_id), potId: pot }, createdAt: isoValue(source.created_at),
    }], [
      'version', 'parentVersion', 'actor', ...(signature ? [] : ['variantHash']),
      ...(pot ? [] : ['potScope.potId']), ...(isoValue(source.created_at) ? [] : ['createdAt']),
    ]);
    const exp = objectValue(transferEvaluation.experiment);
    experiment = Object.keys(exp).length
      ? lifecycleSection(exp as Observed<LearningExperiment>, [
          ...contractMissingFields.experiment.filter((key) => exp[key] == null),
        ])
      : lifecycleSection(null, ['evaluation experiment pins']);
    const outcomesValue = arrayValue(transferEvaluation.outcomes);
    outcomes = lifecycleList(outcomesValue.map((cell): Observed<LearningOutcome> => {
      const row = objectValue(cell);
      const scored = row.status === 'scored' && row.replayed === true;
      return { status: scored ? 'matured' : 'right-censored', measuredAt: null,
        value: numberValue(row.composite), artifactRefs: stringValue(row.runId) ? [`replay-run:${String(row.runId)}`] : [sourceRef] };
    }), outcomesValue.length ? [] : ['replay outcomes']);
    const reservationKnown = Object.keys(reservation).length > 0;
    spend = reservationKnown
      ? lifecycleSection({
          requestedUsd: numberValue(reservation.requestedUsd), reservedUsd: numberValue(reservation.reservedUsd),
          usedUsd: numberValue(reservation.usedUsd), unsettledUsd: numberValue(reservation.unsettledUsd),
          settledAt: isoValue(reservation.settledAt),
        }, ['requestedUsd', 'reservedUsd', 'usedUsd', 'unsettledUsd', 'settledAt'].filter((key) => reservation[key] == null))
      : lifecycleSection(null, ['governor reservation and settlement']);
    evidence = lifecycleList([], ['full evidence contract']);
    const nativeVerdict = source.tier === 'validated' ? 'accepted'
      : source.tier === 'retired' ? 'rejected'
        : 'inconclusive';
    decision = lifecycleSection({ verdict: nativeVerdict, authority: null, reason: null,
      evidenceIds: [], decidedAt: isoValue(source.last_tested_at) }, [
        'authority (not persisted on transfer_lessons)', 'reason (native tier has no decision rationale)',
        ...(isoValue(source.last_tested_at) ? [] : ['decidedAt']),
      ]);
    activation = stringValue(source.memory_id) || stringValue(source.pack_candidate_id)
      ? lifecycleSection({ version: signature, parentVersion: null, rollbackVersion: null,
          exposure: null, activatedAt: isoValue(source.updated_at) }, ['parentVersion', 'rollbackVersion', 'exposure'])
      : lifecycleSection(null, [], true);
  } else if (producer === 'regret') {
    const changes = arrayValue(source.candidate_changes).map(objectValue);
    const scores = arrayValue(source.replay_scores).map(objectValue);
    candidate = lifecycleList(changes.map((change): Observed<LearningCandidate> => {
      const id = stringValue(change.id) ?? '';
      return { id, version: null, parentVersion: null, variantHash: hashedText(change.promptDelta), actor: null,
        potScope: { workspaceId: stringValue(source.workspace_id), potId: null }, createdAt: isoValue(source.mined_at) };
    }), changes.length ? ['version', 'parentVersion', 'actor', 'potScope.potId'] : ['candidate_changes']);
    experiment = lifecycleSection(null, scores.length ? ['battery and execution pins are not persisted with regret scores'] : ['replay execution pins']);
    evidence = lifecycleList(scores.map((score, index): Observed<LearningEvidence> => {
      const candidateId = stringValue(score.candidateId) ?? `score-${index + 1}`;
      const improvement = numberValue(score.improvementScore);
      return { id: `${sourceRef}:${candidateId}`, kind: 'objective',
        status: improvement === null ? 'not-measured' : improvement > 0 ? 'pass' : 'fail',
        coverage: { required: 1, measured: improvement === null ? 0 : 1 }, artifactRefs: [sourceRef],
        recordedAt: isoValue(source.updated_at) };
    }), scores.length ? [] : ['replay_scores']);
    spend = lifecycleSection(null, scores.length
      ? ['governor reservation and settlement (candidate costUsd is reported evaluator cost)']
      : ['governor reservation and settlement']);
    decision = lifecycleSection(null, ['regret replay produces comparative scores, not a promotion decision'], true);
    activation = lifecycleSection(null, ['regret findings do not activate candidates'], true);
    outcomes = lifecycleList(scores.map((score): Observed<LearningOutcome> => ({
      status: 'matured', measuredAt: isoValue(source.updated_at), value: numberValue(score.improvementScore),
      artifactRefs: [sourceRef],
    })), scores.length ? [] : ['replay_scores']);
  } else if (producer === 'red-queen') {
    candidate = lifecycleList([], [], true);
    experiment = lifecycleSection({ batteryId: rowId, testId: stringValue(source.drill_class),
      startedAt: isoValue(source.planted_at), completedAt: isoValue(source.resolved_at) },
      ['baselineId', 'challengerId', 'taskHash', 'modelHash', 'promptHash', 'rubricHash', 'codeHash', 'repeats']);
    const status = source.status;
    const detectedAt = isoValue(source.detected_at);
    const expectedKey = stringValue(source.expected_watchdog_key);
    const actualKey = stringValue(source.detected_watchdog_key);
    const detectionStatus = detectedAt
      ? (expectedKey && actualKey && expectedKey === actualKey ? 'pass' : 'fail')
      : (status === 'failed' || status === 'expired' ? 'fail' : 'not-measured');
    const leakPassed = source.leak_check_passed === true;
    const leakFailed = source.leak_check_passed === false;
    const expectedDecision = stringValue(source.expected_decision);
    const actualDecision = stringValue(source.triaged_decision);
    const probeEvidence: Observed<LearningEvidence>[] = [
      { id: `${sourceRef}:detection`, kind: 'probe', status: detectionStatus,
        coverage: { required: 1, measured: detectedAt ? 1 : 0 }, artifactRefs: [sourceRef], recordedAt: detectedAt },
      { id: `${sourceRef}:leak-check`, kind: 'regression',
        status: leakPassed ? 'pass' : leakFailed ? 'fail' : 'not-measured',
        coverage: { required: 1, measured: leakPassed || leakFailed ? 1 : 0 }, artifactRefs: [sourceRef],
        recordedAt: isoValue(source.resolved_at) },
      ...(expectedDecision ? [{ id: `${sourceRef}:triage`, kind: 'judgment' as const,
        status: actualDecision ? (actualDecision === expectedDecision ? 'pass' as const : 'fail' as const) : 'not-measured' as const,
        coverage: { required: 1, measured: actualDecision ? 1 : 0 }, artifactRefs: [sourceRef],
        recordedAt: isoValue(source.triaged_at) }] : []),
    ];
    evidence = lifecycleList(probeEvidence, []);
    spend = lifecycleSection(null, ['drill cost reservation and settlement are not stored'], false);
    decision = lifecycleSection(null, [], true);
    activation = lifecycleSection(null, [], true);
    const totalMs = numberValue(source.mttsh_total_ms);
    outcomes = status === 'resolved' && totalMs !== null
      ? lifecycleList([{ status: 'matured', measuredAt: isoValue(source.resolved_at), value: totalMs, artifactRefs: [sourceRef] }], [])
      : lifecycleList([], [status === 'failed' || status === 'expired' ? 'right-censored drill outcome' : 'resolved MTTSH outcome']);
  }

  const stage: ProducerLifecycleStage = activation.status !== 'unknown' && activation.status !== 'not-applicable'
    ? 'activation'
    : decision.status !== 'unknown' && decision.status !== 'not-applicable' ? 'decision'
      : outcomes.values.length ? 'outcome'
        : evidence.values.length ? 'evidence'
          : experiment.status !== 'unknown' && experiment.status !== 'not-applicable' ? 'experiment'
            : candidate.values.length ? 'candidate' : 'observation';
  const missing = [
    ...candidate.missingFields.map((field) => `candidate.${field}`),
    ...experiment.missingFields.map((field) => `experiment.${field}`),
    ...evidence.missingFields.map((field) => `evidence.${field}`),
    ...spend.missingFields.map((field) => `spend.${field}`),
    ...decision.missingFields.map((field) => `decision.${field}`),
    ...activation.missingFields.map((field) => `activation.${field}`),
    ...outcomes.missingFields.map((field) => `outcomes.${field}`),
  ];
  return { schemaVersion: '1', producer, sourceRef, sourceHash, stage, candidate, experiment,
    evidence, spend, decision, activation, outcomes, missing };
}

function adaptProducerObservation(producer: LearningProducer, input: ProducerObservationInput): ProducerLifecycleObservation {
  input = structuredClone(input);
  if (!input.workspaceId.trim() || !input.sourceRef.trim() || !Number.isFinite(Date.parse(input.recordedAt))) {
    throw new Error('producer observation requires workspace, source identity and a valid recording time');
  }
  // Exclude our receipt to avoid recursively hashing a previous snapshot.
  const { learning_lifecycle: previousValue, ...fields } = input.source;
  const source = canonical(fields) as Record<string, unknown>;
  const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const decodedPrevious = typeof previousValue === 'string' ? JSON.parse(previousValue) : previousValue;
  const previous = decodedPrevious && typeof decodedPrevious === 'object'
    ? decodedPrevious as Partial<ProducerLifecycleObservation> : undefined;
  const evaluation = input.evaluation === undefined ? previous?.evaluation : input.evaluation;
  const evaluationSourceHash = input.evaluation === undefined ? previous?.evaluationSourceHash : sourceHash;
  const contract = input.contract ?? null;
  const validation = contract ? validateLearningContract(contract) : undefined;
  const bound = input.sourceRef === `${producer}:${contract?.candidate.id}` &&
    contract?.candidate.potScope.workspaceId === input.workspaceId &&
    contract.evidence.some((item) => item.artifactRefs.includes(input.sourceRef));
  const decisions = [...(previous?.decisions ?? [])];
  if (contract) {
    const prior = decisions.find((item) => item.contract.experiment.batteryId === contract.experiment.batteryId);
    if (prior && JSON.stringify(canonical(prior.contract)) !== JSON.stringify(canonical(contract))) {
      throw new Error(`producer common decision is immutable: ${contract.experiment.batteryId}`);
    }
    if (!prior) decisions.push({ contract, sourceHash, recordedAt: input.recordedAt });
  }
  const lifecycle = buildProducerLifecycleSnapshot({ producer, sourceRef: input.sourceRef, sourceHash,
    source, evaluation, contract });
  return freezeReceipt({
    receiptVersion: '1', stage: lifecycle.stage, producer,
    workspaceId: input.workspaceId, sourceRef: input.sourceRef,
    sourceHash,
    source, recordedAt: input.recordedAt, contract,
    promotionAllowed: !!(validation?.ok && bound && contract?.decision.verdict === 'accepted' &&
      contract.spend.unsettledUsd === 0 && contract.spend.settledAt),
    ...(validation ? { validation } : {}),
    ...(decisions.length ? { decisions } : {}),
    missing: lifecycle.missing,
    ...(evaluation === undefined ? {} : { evaluation, evaluationSourceHash, evaluationCurrent: evaluationSourceHash === sourceHash }),
    lifecycle,
  });
}

interface ProducerAdapter {
  (input: ProducerLifecycleInput): LifecycleAdapterResult;
  (input: ProducerObservationInput): ProducerLifecycleObservation;
}

function producerAdapter(producer: LearningProducer): ProducerAdapter {
  return ((input: ProducerLifecycleInput | ProducerObservationInput) =>
    'stage' in input ? adaptProducerObservation(producer, input) : buildProducerLifecycleContract(producer, input)) as ProducerAdapter;
}

/** All production writers and complete-contract callers share these entry points. */
export const adaptScoutOutput = producerAdapter('scout');
export const adaptGymOutput = producerAdapter('gym');
export const adaptCalibrationOutput = producerAdapter('calibration');
export const adaptTransferOutput = producerAdapter('transfer');
export const adaptRegretOutput = producerAdapter('regret');
export const adaptRedQueenOutput = producerAdapter('red-queen');

export interface LifecycleParityInput {
  producer: LearningProducer;
  contract: LearningContract;
  /** Legacy row/artifact references that must be visible in common evidence. */
  legacyArtifactRefs: readonly string[];
  /** Evidence kinds emitted by the legacy source and required for parity. */
  requiredEvidenceKinds?: readonly LearningEvidenceKind[];
}

export interface LifecycleParityResult {
  producer: LearningProducer;
  validContract: boolean;
  missingArtifactRefs: string[];
  missingEvidenceKinds: LearningEvidenceKind[];
  ok: boolean;
}

/**
 * Check that an adapter preserved legacy source evidence before retiring its
 * writer.  This intentionally checks artifact references, not just counts:
 * two rows can have the same count while dropping the source identity.
 */
export function evaluateLifecycleParity(input: LifecycleParityInput): LifecycleParityResult {
  const validation = validateLearningContract(input.contract);
  const artifactRefs = new Set(input.contract.evidence.flatMap((evidence) => evidence.artifactRefs));
  const missingArtifactRefs = input.legacyArtifactRefs.filter((ref) => !artifactRefs.has(ref));
  const kinds = new Set(input.contract.evidence.map((evidence) => evidence.kind));
  const missingEvidenceKinds = (input.requiredEvidenceKinds ?? []).filter((kind) => !kinds.has(kind));
  return {
    producer: input.producer,
    validContract: validation.ok,
    missingArtifactRefs,
    missingEvidenceKinds,
    ok: validation.ok && missingArtifactRefs.length === 0 && missingEvidenceKinds.length === 0,
  };
}

/**
 * The alternate writer may be retired only when parity is proven and its
 * backlog has drained.  A positive parity result alone is insufficient: rows
 * written by the old path still need a migration/drain pass.
 */
export function canRetireLegacyWriter(input: { parity: LifecycleParityResult; remainingLegacyWrites: number }): boolean {
  return input.parity.ok && Number.isInteger(input.remainingLegacyWrites) && input.remainingLegacyWrites === 0;
}

/** Return the source identities represented by a common contract. */
export function contractArtifactRefs(contract: LearningContract): string[] {
  return [...new Set(contract.evidence.flatMap((evidence) => evidence.artifactRefs))].sort();
}

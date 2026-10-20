/** Per-clause spec-test-adequacy evaluator (P-006 / D-004..D-006, D-009). */
import { getBuildInfo } from '../../build-info';
import { EXECUTABLE_PROOF_CRITERIA, executableProofExemption } from '../../plan-verification-profile';
import type { PlanClassRubricRef } from '../../plan-class-refs';
import {
  hasMatchingDeclaredCaseTitle,
  hasSameCaseTitleIdentity,
  readSpecEvidencePlane,
  repoFilesEvidenceMeasurementSchema,
  SPEC_EVIDENCE_KINDS,
} from './spec-evidence-store';
import { readMeasurementPin } from './evidence-measurement-pin';
import {
  SPEC_PROOF_OBLIGATION_ID_RE,
  SPEC_TARGET_ID_RE,
  type SpecBehaviorClass,
  type SpecClauseRevision,
} from './spec-clauses-store';
import type {
  EvidenceCurrentInput,
  EvidenceCurrentness,
  ProvisionalScorecardProof,
  SpecEvidenceKind,
} from './spec-evidence-store';
import { evidenceCurrentInputKey } from './spec-evidence-store';
import type {
  SpecTestAdequacyCurrentFingerprint,
  SpecTestAdequacyRerunRecipe,
} from '../../harness/improvements/observation-types';
import type { SourceBarTestRequirements } from './source-bar-test-requirements';
import {
  isRecordedCaseTitle,
  isRecordedTestLayer,
  MAX_RECORDED_PASSED_CASES,
  passedCaseTitlesIncomplete,
} from '@papercusp/test-config/execution-details';
import { CALIBRATION_LEGS, type MutationDescriptor } from '@papercusp/test-config/mutation-descriptor';

export const SPEC_TEST_ADEQUACY_RUBRIC_REF = 'spec-test-adequacy';

/**
 * Keep persisted judge replays within the critical-pressure admission budget.
 * The evaluator's general default is intentionally larger, but generated
 * scorecard recipes must carry an explicit bounded page so the exact replay can
 * pass the MCP recovery allowlist when the operator is saturated.
 */
export const SPEC_TEST_ADEQUACY_REPLAY_LIMIT = 25;

/**
 * The evidence-row limit a persisted rerun recipe pins (WI-6554700010010541).
 *
 * The evaluator refuses with `evidence_selection_hit_limit` once the rows it
 * loads reach the limit, and the exact replay loads at least every binding the
 * card graded. A fixed 25 therefore made every clause with 25 or more bindings
 * permanently uncertifiable: `scorecards:emit` replays the recipe and is
 * refused every time (measured 2026-10-13 on
 * green-main-cycle-time-2026-10-08#AUTO-BAR-R-11-P-007@3, 31 bindings).
 *
 * A cohort that fits keeps the critical-pressure budget. A larger cohort pins
 * exactly one row more than its largest loaded population, so the replay stays
 * bounded and can still load both selected and clause-wide disclosure bindings.
 * Its judge replay is refused admission under critical
 * pressure (a transient wait), rather than the card being impossible.
 */
export function specTestAdequacyReplayLimit(gradedRows: number): number {
  const rows = Number.isSafeInteger(gradedRows) && gradedRows > 0 ? gradedRows : 0;
  return rows < SPEC_TEST_ADEQUACY_REPLAY_LIMIT ? SPEC_TEST_ADEQUACY_REPLAY_LIMIT : rows + 1;
}

// The class list is owned by the leaf ../../plan-class-refs (single source, also read by
// MCP admission); re-exported here so every existing importer keeps working.
export { PLAN_CLASS_RUBRIC_REFS, type PlanClassRubricRef } from '../../plan-class-refs';

export const ADEQUACY_CRITERIA = [
  'traceability',
  'fixture-calibration',
  'falsifiability',
  'correct-layer',
  'oracle-independence',
  'execution-integrity',
  'freshness',
  'plan-class-risk-floor',
  'disclosed-gap',
] as const;
export type AdequacyCriterion = (typeof ADEQUACY_CRITERIA)[number];
export type AdequacyRating = 'pass' | 'fail' | 'unknown' | 'waived' | 'not-applicable';

// The subset of ADEQUACY_CRITERIA that only EXECUTABLE proof can satisfy is
// EXECUTABLE_PROOF_CRITERIA, owned by the verification resolver
// (../../plan-verification-profile.ts). A new criterion above that needs a ledger
// row or a repo file belongs in that list too.

export interface AdequacyRatingEntry {
  rating: AdequacyRating;
  evidence: string;
  suggestion?: string;
  /**
   * EI-23958122348412546: this verdict is a 'fail' that means ABSENCE of executable
   * proof, not evidence that positively reports something bad. The two are otherwise
   * indistinguishable once a branch has collapsed to the bare string 'fail', which is
   * what made the requiredProofFloor='none' exemption below unreachable for exactly
   * the non-code work it was written for: honest `manual` evidence produced zero
   * executable rows, rated 'fail', and was skipped by an exemption that only ever
   * downgraded 'unknown' — while a WEAKER binding (one executable-kind row with
   * author-attested booleans and no ledger anchor) rated 'unknown' and WAS exempted.
   *
   * Only absence-shaped verdicts carry this. A 'fail' from falsifiable=false, a
   * failed/skipped/unexecuted outcome, or a stale binding must never set it: that
   * fail is real information about real evidence and keeps blocking, exemption or not.
   */
  absenceOnly?: boolean;
}

export interface SpecEvidenceForAdequacy {
  id?: number;
  workItemId: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidenceKind: SpecEvidenceKind;
  evidenceRef: string;
  fingerprints: {
    sourceFingerprint: string;
    testFingerprint: string | null;
    fixtureFingerprint: string | null;
    rubricFingerprint: string | null;
    environmentFingerprint: string | null;
  };
  coverageEvidenceRef: number | null;
  testRunId: number | null;
  /** Store-owned citation and author, never details supplied by a binder. */
  verifiesBindingId?: number;
  createdBy?: string;
  /** Certified by the shared reader from stored citations, pins and lineage. */
  fixtureAbsenceVerification?: { verifierBindingIds: number[] };
  /** Canonical ledger attributes, independent of author-written evidenceRef prose. */
  testRunProvenance?: {
    filePath: string;
    /** Canonical runner framework; an LLM scenario is never inferred from binder metadata. */
    framework?: string | null;
    /** Server-owned test_runs.source, independent of details written by the binding author. */
    source?: string | null;
    /** Server-parsed phase from test_runs.execution_details. */
    mutationPhase?: string | null;
    /** Reporter-written descriptor and its server-read calibration row, never binder metadata. */
    mutation?: MutationDescriptor;
    mutationBaseline?: {
      testRunId: number;
      status: string | null;
      mutation: MutationDescriptor;
      passed: number;
      failed: number;
      skipped: number;
      collectionFailed: boolean;
      /** Canonical calibration-row identities, independent of binder declarations. */
      passedCaseTitles?: string[];
      passedCaseTitlesIncomplete?: boolean;
    } | null;
    commitSha: string | null;
    worktreeDirty: boolean | null;
    /**
     * Server-derived failure lines of a failed mutation-probe test run, in the ledger reporter's
     * `<case full name>: <message>` format (admin-test-runs-reporter `buildOutputTail`, one line
     * per failed case). A declared `adequacy.testCases` entry is a measured failed case only when
     * a line starts with exactly `<entry>: ` — never parsed out of free text (WI-10006745).
     */
    mutationFailureLines?: string[];
    /**
     * The failed mutant run's recorded failed-case identities (execution_details.failedCaseTitles,
     * TestCase.fullName). When present, a declared case is measured only by EXACT membership —
     * prefix-matching `mutationFailureLines` would let `suite > a` claim a failed `suite > a: b`
     * (WI-10006753). Absent on legacy rows, which keep the line-prefix fallback.
     */
    mutationFailedCaseTitles?: string[];
  } | null;
  /** Server-parsed counters for the bound test_runs row; null means its details were absent or invalid. */
  testRunExecution?: {
    status?: string | null;
    passed: number;
    failed: number;
    skipped: number;
    collectionFailed: boolean;
    testLayer?: string;
    passedCaseTitles?: string[];
    /** Derived from the explicit marker or the legacy 64-title/count signal. */
    passedCaseTitlesIncomplete?: boolean;
    /** Retained from the canonical LLM recorder, not converted into Vitest titles. */
    scenarioId?: string;
    filePath?: string;
  } | null;
  details: Record<string, unknown>;
  observedAt?: string;
  createdAt?: string;
  currentness: EvidenceCurrentness;
  /** True when evidenceRef resolves to a provisional scorecard working note. */
  provisionalProofBase?: boolean;
  provisionalScorecard?: ProvisionalScorecardProof;
  /** Binding rows whose same-proof coverage metadata was preserved on this active row. */
  supportingBindingIds?: number[];
}

function logicalEvidenceReferenceKey(row: SpecEvidenceForAdequacy): string {
  return JSON.stringify([row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef]);
}

function proofIdentity(row: SpecEvidenceForAdequacy): string {
  return JSON.stringify([
    row.testRunId ?? null,
    row.coverageEvidenceRef ?? null,
    row.fingerprints.sourceFingerprint ?? null,
    row.fingerprints.testFingerprint ?? null,
    row.fingerprints.fixtureFingerprint ?? null,
    row.fingerprints.rubricFingerprint ?? null,
    row.fingerprints.environmentFingerprint ?? null,
  ]);
}

function hasTestAttemptReference(row: SpecEvidenceForAdequacy): boolean {
  const execution = row.details.testExecution as { schemaVersion?: unknown; originRunId?: unknown } | undefined;
  return (
    execution?.schemaVersion === 1 &&
    typeof execution.originRunId === 'string' &&
    row.evidenceRef.startsWith(`test-run-group:${execution.originRunId}:`)
  );
}

/**
 * Bindings are immutable history, but adequacy grades the active VERSION of a
 * logical evidence reference. A corrected re-bind must not remain poisoned by
 * an older incomplete row for the same plan/spec/revision/kind/ref.
 *
 * The binder is deliberately NOT part of that identity. `evidenceRef` names the
 * PROOF; `workItemId` names whoever happened to append the row. Keying on the
 * binder splits one logical reference into per-work-item lineages, so a later
 * ledger-backed re-bind filed under a different work item cannot supersede an
 * earlier incomplete row — it lands beside it, and the stale row keeps dragging
 * every criterion that reads it (execution-integrity to 'unknown' via the
 * any-drags rule, plus falsifiability/correct-layer/oracle-independence) with no
 * reachable repair, because the table is append-only by design. That is the exact
 * poisoning this function exists to prevent, so the binder must not key it.
 */
export function latestLogicalEvidence<T extends SpecEvidenceForAdequacy>(rows: readonly T[]): T[] {
  const selected = new Map<string, { row: T; index: number }>();
  // A logical correction is a newer APPEND, not a later claimed observation.
  // `observedAt` is caller-authored evidence metadata and may be skewed or even
  // future-dated; letting it order versions makes an old row permanently poison
  // every later correction. `createdAt` is server-authored, with the immutable DB
  // id and input order as deterministic fallbacks for legacy/test rows.
  const appendTimestamp = (row: SpecEvidenceForAdequacy): number => {
    const value = Date.parse(row.createdAt ?? '');
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  const keyOf = (row: T): string => {
    // A mutation target is a distinct claim even when bindings cite the same
    // mutant run. Keep each target so measured failed cases can corroborate them
    // independently instead of letting the newest target replace its sibling.
    const targeted = row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample'
      ? detailsOf(row).targeted ?? null
      : null;
    return JSON.stringify([row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef, targeted]);
  };
  const newer = (row: T, index: number, prior: { row: T; index: number }): boolean => {
    const rowTs = appendTimestamp(row);
    const priorTs = appendTimestamp(prior.row);
    const rowId = row.id ?? Number.NEGATIVE_INFINITY;
    const priorId = prior.row.id ?? Number.NEGATIVE_INFINITY;
    return rowTs > priorTs || (rowTs === priorTs && (rowId > priorId || (rowId === priorId && index > prior.index)));
  };
  // Only the server-attributed backfill writer gets this exception. It may have
  // loaded its ledger snapshot before an explicit calibrated proof was bound.
  // Preserve the LATEST explicit correction, never an older richer annotation,
  // and never transplant calibration across different receipts/fingerprints.
  // Keep this identity literal here to avoid the autobind -> binder -> adequacy cycle.
  const automatic = (row: T) => row.evidenceKind === 'test' && row.createdBy === 'system:spec-evidence-autobind';
  const explicit = new Map<string, { row: T; index: number }>();
  rows.forEach((row, index) => {
    if (automatic(row)) return;
    const key = keyOf(row);
    const prior = explicit.get(key);
    if (!prior || newer(row, index, prior)) explicit.set(key, { row, index });
  });
  rows.forEach((row, index) => {
    const key = keyOf(row);
    const correction = explicit.get(key)?.row;
    if (automatic(row) && row.testRunId != null && correction?.testRunId != null &&
      correction.testRunId >= row.testRunId) return;
    const prior = selected.get(key);
    if (!prior) {
      selected.set(key, { row, index });
      return;
    }
    if (newer(row, index, prior)) {
      selected.set(key, { row, index });
    }
  });
  return [...selected.values()].sort((a, b) => a.index - b.index).map(({ row }) => row);
}

/**
 * Different run ids are attempts, not obligations that remain relied on forever.
 * Only the existing prepare/finish protocol can identify equivalent attempts:
 * require its original pending append, exact proof identity, and equal-or-wider
 * source scope. Order by that server-assigned registration id, NEVER outcome,
 * observedAt, ledger completion order, or a late adequacy annotation.
 *
 * This is a read projection: no historical binding is modified or deleted.
 * Legacy/unstructured proof and changed layer/scenario/causal/filter obligations
 * stay separate. A newer pending/unknown/failing attempt wins just like a pass.
 */
export function activeSpecEvidence<T extends SpecEvidenceForAdequacy>(rows: readonly T[]): T[] {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const identity = (row: T) => {
    const execution = object(row.details.testExecution);
    const binding = object(execution?.binding);
    const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
    if (
      !execution ||
      !hasTestAttemptReference(row) ||
      !binding ||
      !measurement.success ||
      binding.specId !== row.specId ||
      binding.specRevision !== row.specRevision ||
      measurement.data.testPaths?.length !== 1 ||
      binding.testPath !== measurement.data.testPaths[0] ||
      !isRecordedTestLayer(binding.testLayer)
    )
      return null;
    const strings = (value: unknown): string[] | null =>
      Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
        ? [...new Set(value as string[])].sort()
        : null;
    const sources = strings(binding.sourcePaths);
    if (!sources || JSON.stringify(sources) !== JSON.stringify([...new Set(measurement.data.sourcePaths)].sort()))
      return null;
    const details = detailsOf(row);
    if (details.contractMetadataIssues?.length || details.testLayer !== binding.testLayer) return null;
    const scenarios = binding.scenarioIds === undefined ? [] : strings(binding.scenarioIds);
    const pairs = binding.causalPairId === undefined ? [] : [binding.causalPairId];
    if (
      !scenarios ||
      JSON.stringify(scenarios) !== JSON.stringify(details.scenarioIds ?? []) ||
      JSON.stringify(pairs) !== JSON.stringify(details.causalPairIds ?? [])
    )
      return null;
    const counterexample = object(binding.counterexample);
    if (
      binding.counterexample !== undefined &&
      (!counterexample || typeof counterexample.test !== 'string' || typeof counterexample.messageIncludes !== 'string')
    )
      return null;
    const registrationKey = JSON.stringify([
      row.workItemId,
      row.planSlug,
      row.specId,
      row.specRevision,
      row.specFingerprint,
      row.evidenceKind,
      measurement.data.rootHarnessSlug ?? null,
      binding.testPath,
      binding.testLayer,
      scenarios,
      pairs,
      counterexample ? [counterexample.test, counterexample.messageIncludes] : null,
      row.fingerprints.fixtureFingerprint,
      row.fingerprints.rubricFingerprint,
      row.fingerprints.environmentFingerprint,
    ]);
    // Plane review and the executed filter are recorded at finish/review, not at
    // prepare. They distinguish attempts, but cannot change registration order.
    const plane = readSpecEvidencePlane(row.details) ?? null;
    const key = JSON.stringify([registrationKey, execution.testNamePattern ?? null]);
    return { key, registrationKey, plane, sources, execution };
  };
  const logicalKey = (row: T) =>
    JSON.stringify([row.workItemId, row.planSlug, row.specId, row.specRevision, row.evidenceKind, row.evidenceRef]);
  const anchors = new Map<string, { id: number; scope: NonNullable<ReturnType<typeof identity>> }>();
  for (const row of rows) {
    const scope = identity(row);
    if (
      !scope ||
      scope.execution.phase !== 'pending' ||
      row.testRunId !== null ||
      !Number.isSafeInteger(row.id) ||
      row.id! <= 0
    )
      continue;
    const key = logicalKey(row);
    const previous = anchors.get(key);
    if (!previous || row.id! < previous.id) anchors.set(key, { id: row.id!, scope });
  }
  const latest = latestLogicalEvidence(rows);
  const byReference = new Map<string, T[]>();
  for (const row of rows) {
    const key = logicalEvidenceReferenceKey(row);
    const bucket = byReference.get(key) ?? [];
    bucket.push(row);
    byReference.set(key, bucket);
  }
  // Scenario, causal-pair, and test-case ids are set-valued coverage metadata. When a re-bind
  // changes only that metadata, the newest immutable row must retain the union from
  // earlier rows for the same proof; otherwise latestLogicalEvidence silently hides
  // coverage the unchanged run already established. A new run or changed fingerprint
  // remains a new proof identity and starts a new metadata set.
  const reconciled = latest.map((row) => {
    const rawAdequacy = row.details.adequacy;
    if (
      rawAdequacy !== undefined &&
      (!rawAdequacy || typeof rawAdequacy !== 'object' || Array.isArray(rawAdequacy))
    ) return row;
    const adequacy = (rawAdequacy ?? {}) as Record<string, unknown>;
    const ownDetails = detailsOf(row);
    const sameProofRows = (byReference.get(logicalEvidenceReferenceKey(row)) ?? [row])
      .filter((candidate) => proofIdentity(candidate) === proofIdentity(row) &&
        // Shared mutant runs carry separate target claims. A sibling target's
        // case must not become an invented association through metadata union.
        ((row.evidenceKind !== 'mutation' && row.evidenceKind !== 'counterexample') ||
          detailsOf(candidate).targeted === ownDetails.targeted));
    const mergedAdequacy = { ...adequacy };
    let changed = false;
    for (const key of ['scenarioIds', 'causalPairIds', 'testCases'] as const) {
      if (ownDetails.contractMetadataIssues?.includes(`${key}:invalid`)) continue;
      const values = [...new Set(sameProofRows.flatMap((candidate) => {
        const details = detailsOf(candidate);
        return details.contractMetadataIssues?.includes(`${key}:invalid`) ? [] : details[key] ?? [];
      }))].sort((a, b) => a.localeCompare(b));
      const own = ownDetails[key] ?? [];
      if (JSON.stringify(values) === JSON.stringify(own)) continue;
      if (values.length === 0) continue;
      mergedAdequacy[key] = values;
      changed = true;
    }
    if (!changed) return row;
    const supportingBindingIds = [...new Set(sameProofRows
      .map((candidate) => candidate.id)
      .filter((id): id is number => Number.isSafeInteger(id) && id! > 0))].sort((a, b) => a - b);
    return {
      ...row,
      details: { ...row.details, adequacy: mergedAdequacy },
      ...(supportingBindingIds.length > 1 ? { supportingBindingIds } : {}),
    };
  });
  const candidates = reconciled.map((row) => {
    const scope = identity(row);
    const anchor = anchors.get(logicalKey(row));
    // An annotation cannot change the registered proof's identity or source scope.
    return scope &&
      anchor &&
      scope.registrationKey === anchor.scope.registrationKey &&
      JSON.stringify(scope.sources) === JSON.stringify(anchor.scope.sources)
      ? { row, scope, order: anchor.id }
      : null;
  });
  const superseded = new Set<T>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      candidates.some(
        (newer) =>
          newer &&
          newer.order > candidate.order &&
          newer.scope.key === candidate.scope.key &&
          (candidate.scope.plane === null || candidate.scope.plane === newer.scope.plane) &&
          candidate.scope.sources.every((path) => newer.scope.sources.includes(path)),
      )
    )
      superseded.add(candidate.row);
  }
  return reconciled.filter((row) => !superseded.has(row));
}

export type SpecEvidenceLineage = 'durable' | 'ephemeral' | 'unknown';

export interface SpecEvidenceLineageAssessment {
  lineage: SpecEvidenceLineage;
  reason: string;
}

interface AdequacyDetails {
  fixtureCalibrated?: boolean;
  fixtureFree?: boolean;
  falsifiable?: boolean;
  testLayer?: string;
  pathReachable?: boolean;
  oracleIndependent?: boolean;
  collected?: boolean;
  skipped?: boolean;
  executed?: boolean;
  outcome?: string;
  targeted?: boolean | string;
  coverageRungs?: Partial<Record<'l1' | 'l2' | 'l3' | 'l4', boolean>>;
  scenarioIds?: string[];
  causalPairIds?: string[];
  testCases?: string[];
  contractMetadataIssues?: string[];
  provisionalProofBase?: boolean;
  /**
   * Author-recorded holes in this proof. A disclosure is an admission that the
   * bound evidence does NOT fully establish the clause, so it must never be able
   * to coexist with a machine PASS: `disclosed-gap` fails whenever this is
   * non-empty, and the gap text is named in the would-block reason.
   */
  disclosedGap?: string[];
}

interface L4Waiver {
  justification: string;
  approvalRef: string;
  expiresAt?: string;
}

export interface SpecTestAdequacyResult {
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  planItemId: string;
  classRef: PlanClassRubricRef;
  behaviorClass: SpecBehaviorClass;
  evidenceRefs: string[];
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>;
  requiredProofFloor: 'none' | 'l3' | 'l4';
  verdict: 'pass' | 'fail' | 'unknown';
  wouldBlock: string[];
  /**
   * P-019 (review-system-rework-reduction-2026-09-23): for each blocking criterion, the
   * ids of the bound rows that DRAG it — the rows whose own content makes the criterion
   * fail or read unknown. The any-drags rules (freshness, execution-integrity,
   * traceability, disclosed-gap, the explicit-false boolean criteria) grade EVERY live
   * binding at the clause revision, so one old row fails a clause whose newer proof is
   * sufficient. Without the ids the fix was a hand hunt through plans:get-spec-evidence;
   * with them it is one `plans:bind-spec-evidence { supersedeAtRevision:true }` or a
   * targeted `retract`. A criterion blocked by ABSENCE (nothing bound) names no binding
   * and is omitted. Kept beside `ratings`, not inside each entry, so the scorecard rating
   * shape the completion gate matches on is unchanged.
   */
  draggingBindingIds: Partial<Record<AdequacyCriterion, number[]>>;
  scorecardDraft: {
    rubricRef: typeof SPEC_TEST_ADEQUACY_RUBRIC_REF;
    subject: { kind: 'plan'; ref: string };
    title: string;
    body: string;
    ratings: Record<AdequacyCriterion, AdequacyRatingEntry>;
    rerunRecipe: SpecTestAdequacyRerunRecipe;
    terminal: true;
  };
}

/** Independently observed candidate identities, not caller-supplied freshness overrides. */
export interface SpecEvidenceMatrixIdentity {
  sourceSha: string | null;
  testFile: string | null;
  testBlob: string | null;
  /** null is an explicit not-applicable declaration; incomplete objects remain unknown. */
  artifact: { buildId: string | null; sha256: string | null } | null;
}

export interface SpecEvidenceMatrixRequirement {
  rowId: string;
  clause: SpecClauseRevision;
  scenarioId: string;
  caseTitle: string;
  candidate: SpecEvidenceMatrixIdentity;
  evidencePlane: 'tree' | 'live';
}

export interface SpecEvidenceMatrixObservation {
  rowId: string;
  evidence: SpecEvidenceForAdequacy;
  observed: SpecEvidenceMatrixIdentity;
  evidencePlane: 'tree' | 'live';
  claimsShipment: boolean;
  setupOnly: boolean;
}

/**
 * Compare an independently enumerated journey inventory with reader/ledger observations.
 * Iterate REQUIREMENTS so absent proof cannot shrink the population. Reuse the clause
 * evaluator for binding, execution and freshness; identity equality never upgrades an
 * attestation to server measurement. This checks coverage/identity, not journey behavior
 * or shipment approval. A synthetic positive control is calibration, not plan acceptance.
 */
export function evaluateSpecEvidenceMatrix(input: {
  required: readonly SpecEvidenceMatrixRequirement[];
  observed: readonly SpecEvidenceMatrixObservation[];
  classRef: PlanClassRubricRef;
}) {
  const byId = new Map<string, SpecEvidenceMatrixObservation[]>();
  for (const row of input.observed) {
    byId.set(row.rowId, [...(byId.get(row.rowId) ?? []), row]);
  }
  const requiredIds = new Set(input.required.map((row) => row.rowId));
  const extraRowIds = [...byId.keys()].filter((id) => !requiredIds.has(id));
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const rows = input.required.map((required) => {
    const rules: string[] = [];
    if (!nonempty(required.rowId) || !nonempty(required.scenarioId) || !nonempty(required.caseTitle)) {
      rules.push('incomplete-required-row');
    }
    if (input.required.filter((row) => row.rowId === required.rowId).length !== 1) {
      rules.push('duplicate-required-row');
    }
    const matches = byId.get(required.rowId) ?? [];
    if (matches.length !== 1) {
      rules.push(matches.length === 0 ? 'missing-required-row' : 'duplicate-observed-row');
      return { rowId: required.rowId, rules };
    }
    const row = matches[0]!;
    const proof = row.evidence;
    if (proof.planSlug !== required.clause.planSlug || proof.specId !== required.clause.specId ||
        proof.specRevision !== required.clause.revision || proof.specFingerprint !== required.clause.contentHash) {
      rules.push('clause-identity-mismatch');
    }
    if (!Number.isSafeInteger(proof.id) || proof.id! <= 0) rules.push('missing-immutable-binding');
    for (const field of ['sourceSha', 'testFile', 'testBlob'] as const) {
      if (!nonempty(required.candidate[field]) || !nonempty(row.observed[field]) ||
          required.candidate[field] !== row.observed[field]) rules.push(`${field}-identity-mismatch`);
    }
    const candidateArtifact = required.candidate.artifact;
    const observedArtifact = row.observed.artifact;
    if (candidateArtifact === null ? observedArtifact !== null :
        !candidateArtifact || !observedArtifact ||
        !nonempty(candidateArtifact.buildId) || !nonempty(candidateArtifact.sha256) ||
        candidateArtifact.buildId !== observedArtifact.buildId || candidateArtifact.sha256 !== observedArtifact.sha256) {
      rules.push('artifact-identity-mismatch');
    }
    if (proof.testRunProvenance?.filePath !== required.candidate.testFile ||
        !proof.testRunExecution?.passedCaseTitles?.includes(required.caseTitle)) {
      rules.push('unmatched-executed-case');
    }
    if (row.setupOnly !== false) rules.push('setup-only-or-unknown');
    if (readSpecEvidencePlane(proof.details) !== row.evidencePlane) rules.push('binding-plane-mismatch');
    if (row.evidencePlane !== required.evidencePlane) rules.push('evidence-plane-mismatch');
    if (row.claimsShipment && row.evidencePlane !== 'live') rules.push('tree-evidence-claimed-as-shipment');
    if (proof.currentness.provenance !== 'server-measured') rules.push('identity-not-server-measured');
    const evaluated = evaluateSpecTestAdequacy({
      clause: required.clause, evidence: [proof], classRef: input.classRef,
    });
    for (const criterion of ['traceability', 'execution-integrity', 'freshness'] as const) {
      if (evaluated.ratings[criterion].rating !== 'pass') rules.push(criterion);
    }
    return { rowId: required.rowId, rules };
  });
  return {
    healthy: rows.length > 0 && extraRowIds.length === 0 && rows.every((row) => row.rules.length === 0),
    requiredRowCount: input.required.length,
    observedRowCount: input.observed.length,
    rows,
    extraRowIds,
  };
}

const HIGH_RISK_BEHAVIOR_CLASSES = new Set<SpecBehaviorClass>([
  'authorization',
  'concurrency',
  'lifecycle',
  'migration-data-integrity',
]);

// The mutation probe reports a detected mutant as `caught`; mutation-report
// storage may call the same result `killed`. Both are successful negative
// proof, while only the ordinary test outcomes below count as repaired proof.
const SUCCESS_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded', 'killed', 'caught']);
const REPAIRED_OUTCOMES = new Set(['pass', 'passed', 'success', 'succeeded']);
const EXECUTABLE_EVIDENCE_KINDS = new Set<SpecEvidenceKind>([
  'test',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'operational',
]);

/**
 * P-019: the repair for an any-drags criterion whose clause ALSO carries sufficient proof.
 * Bindings are append-only and every live row at the revision is graded, so an older
 * weak/stale/failing row keeps a criterion blocked beside newer proof until it is withdrawn.
 */
export const SUPERSEDE_DRAGGING_SUGGESTION =
  "The dragging binding ids are listed in this row's draggingBindingIds (beside ratings, keyed by criterion). If newer bound proof already establishes this clause, " +
  're-bind that proof with plans:bind-spec-evidence { supersedeAtRevision:true } (retracts only same-kind rows of the ' +
  "same test file that claim no other target or causal pair; other files' and seams' rows stay live and are listed in " +
  'supersession[].kept) or retract the named ids with a reason; otherwise re-run the proof.';
// EI-25220306060165214 / review-system-rework-reduction-2026-09-23#D-046: supersession is scoped
// to the superseding row's proof subject, so this advice can no longer cost a sibling file's proof.

/**
 * EI-25215634977268694: the freshness repair when current proof sits beside the stale rows but
 * NONE of it may supersede them. `supersedeAtRevision` retracts only rows of the superseding
 * binding's own evidenceKind, and only a successful ledger-backed executable binding may
 * supersede (`supersedeEligibilityGaps`, D-011). Offering it for, e.g., live operational
 * evidence with no testRunId sends the binder into a call whose `supersession[]` comes back
 * `refused` while the clause stays blocked — measured on P-011's R-34..R-37, where every
 * re-bind returned ok and freshness still failed until an explicit retract.
 */
export const RETRACT_DRAGGING_SUGGESTION =
  "The dragging binding ids are listed in this row's draggingBindingIds.freshness (beside ratings). The current proof " +
  "beside them cannot supersede them: supersedeAtRevision retracts only rows of the superseding binding's own evidenceKind, " +
  'and only a successful ledger-backed executable binding (testRunId or coverageEvidenceRef) may supersede. Withdraw the ' +
  'stale ids with plans:bind-spec-evidence { retract:[{ bindingId, reason }] }, or re-run the stale proof with a ledger reference.';

/**
 * P-019: make the ledger requirement discoverable where the refusal lands. falsifiability,
 * execution-integrity and traceability cannot pass without a real ledger row, and a
 * mutation probe's row is recorded with source='mutation-probe', which testing:runs row
 * listings hide unless that source is passed explicitly.
 */
export const LEDGER_PROOF_HINT =
  'Ledger row required: testing:run { files, harness, evidence } records and binds a testRunId; ' +
  'scripts/mutation-probe.sh with PAPERCUSP_TEST_RUN_HARNESS set records source=mutation-probe rows ' +
  "(listed only by testing:runs { source:'mutation-probe' }).";

/**
 * A work-item id anchors a binding only when it IS the reference: its first
 * token, optionally after a typed-prefix chain (`scorecard:EI-…`,
 * `testing:run :: WI-…`), a tool-call verb (`work_items:get WI-…`), or a
 * hyphen-joined kind (`work-item-thread-WI-…#post-…`). An id mentioned inside
 * prose (`LIVE PLANE RE-VERIFICATION … (su-…, WI-…)`) names who did the work,
 * not where the proof can be re-run, and must not make the row durable
 * (WI-10005325).
 */
const DURABLE_WORK_ITEM_REF_RE =
  /^(?:[a-z][\w-]*\s*:{1,2}\s*)*(?:[a-z][\w-]*:[a-z][\w-]*\s+)?(?:[a-z][a-z-]*-)?(?:WI|EI|F)-\d+\b/i;
/**
 * Directories whose files another evaluator cannot find again: every plain
 * directory the repo-root .gitignore ignores, plus nested scratch and temp
 * roots. PINNED: spec-test-adequacy.test.ts fails when .gitignore ignores a
 * plain directory missing from this list, so a new ignored root cannot
 * silently grade durable. Shared by the relative and absolute file rules so one
 * spelling of a path is never durable while the other is not.
 */
export const EPHEMERAL_EVIDENCE_ROOTS: readonly string[] = [
  '.papercusp/scratch', 'var/tmp', 'tmp', 'node_modules', 'scratch', 'scratchpad', 'coverage', 'test-results',
  'design-evidence-report', '.tmp', '.vitest-tmp', '.vitest-tmpdir', '.tsx-tmp', '.agent-tmp', '.tmp-claude',
  '.content-fixer-tmp', '.papercusp-tmp', '.papercusp-pinned-deps', '.papercusp-smoke-snapshots', '.next',
  '.next-prod', '.next-build-cache', '.source', '.astro', '.playwright-mcp', '.rig-sidecar-current', '.gitnexus',
];
/** .gitignore glob roots (`/scratch-*`, `coverage-*`) the literal list above cannot express. */
const EPHEMERAL_GLOB_ROOTS = [String.raw`scratch-[^\/\s]*`, String.raw`coverage-[^\/\s]*`];
const EPHEMERAL_FILE_ROOT = `(?:${[
  ...EPHEMERAL_EVIDENCE_ROOTS.map((root) => root.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
  ...EPHEMERAL_GLOB_ROOTS,
].join('|')})\\/`;
/**
 * A repo-relative file path. Durability is DERIVED, not hand-listed
 * (WI-6554700010008517): any relative path is a rerun anchor unless it sits
 * under an ephemeral root, the same rule DURABLE_ABSOLUTE_FILE_REF_RE applies
 * to absolute paths. The old allowlist (apps|packages|libs|scripts|src|lib|
 * test|tests|bin|docs|rubrics) graded a committed `reports/…` or
 * `papercusp-desktop/…` file 'unknown' while the same file spelled absolutely
 * graded 'durable'. A leading all-digit segment is refused so `host:3170/x.json`
 * is not read as a path.
 */
const REPO_RELATIVE_FILE = String.raw`(?:\.\.\/|\.\/)?(?!${EPHEMERAL_FILE_ROOT})(?!\d+\/)[a-z0-9_@.][\w.@-]*\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)`;
/**
 * A repo file that LEADS the reference is a rerun anchor even when prose
 * follows it (`apps/…/x.test.ts — 21 passed @ b97d892c71`). DURABLE_FILE_REF_RE
 * already accepts a path followed by `#`/`:` and any text; this accepts the
 * same path followed by whitespace, `,` or `;`.
 */
const DURABLE_LEADING_FILE_REF_RE = new RegExp(
  String.raw`^(?:(?:file|path|repo-file):(?:\/\/)?)?${REPO_RELATIVE_FILE}(?=[\s,;#:]|$)`,
  'i',
);
const DURABLE_ARTIFACT_REF_RE =
  /\b(?:artifact|artifact[-_ ]?ref|artifact[-_ ]?id)\s*(?:[:/#=]|\s+)\s*[a-z0-9][^\s,;]*/i;
const DURABLE_TEST_RUN_REF_RE =
  /\b(?:test[-_ ]?run|testing[-_ ]?run)(?:[-_ ]?id)?\s*(?:[-:/#=]|\s+)\s*[a-z0-9][^\s,;]*/i;
const DURABLE_COVERAGE_REF_RE = /\bcoverage(?:[-_ ]?(?:evidence|run))(?:[-_ ]?id)?\s*[:/#=]\s*\d+\b/i;
const DURABLE_FILE_REF_RE = new RegExp(
  String.raw`(?:^|[\s:(])(?:(?:file|path|repo-file):(?:\/\/)?)?${REPO_RELATIVE_FILE}(?:[#:].*)?$`,
  'i',
);
const DURABLE_ABSOLUTE_FILE_REF_RE = new RegExp(
  String.raw`^(?!\/?(?:tmp|var\/tmp)(?:\/|$))(?![^\s,;]*\/${EPHEMERAL_FILE_ROOT})\/[^\s,;]+\.(?:[cm]?[jt]sx?|json|sql|rs|mdx?|sh)(?:[#:].*)?$`,
  'i',
);

function ephemeralEvidenceRefReason(evidenceRef: string): string | null {
  const normalized = evidenceRef.trim().replaceAll('\\', '/');
  if (/(^|\/)(?:tmp|var\/tmp)(?:\/|$)/i.test(normalized)) return 'temporary filesystem path';
  if (/(?:^|[\s:/#])bash(?:$|[\s:/#])/i.test(normalized)) return 'bash/session-local command reference';
  if (/\bsession[-_ ]local\b/i.test(normalized)) return 'session-local reference';
  if (/\bephemeral\b/i.test(normalized)) return 'ephemeral reference';
  return null;
}

/**
 * A binding row is durable only when its proof can be found again by another
 * evaluator. The work-item/spec edge itself is deliberately not an anchor:
 * every binding has one, and it does not identify a rerunnable proof.
 */
export function classifySpecEvidenceLineage(
  evidence: Pick<SpecEvidenceForAdequacy, 'evidenceRef' | 'coverageEvidenceRef' | 'testRunId'>,
): SpecEvidenceLineageAssessment {
  const evidenceRef = evidence.evidenceRef.trim();
  const ephemeralReason = ephemeralEvidenceRefReason(evidenceRef);
  const hasCoverageId = Number.isSafeInteger(evidence.coverageEvidenceRef) && evidence.coverageEvidenceRef! > 0;
  const hasTestRunId = Number.isSafeInteger(evidence.testRunId) && evidence.testRunId! > 0;
  if (hasTestRunId) return { lineage: 'durable', reason: 'durable testRunId' };
  if (hasCoverageId) return { lineage: 'durable', reason: 'durable coverageEvidenceRef' };
  if (
    DURABLE_WORK_ITEM_REF_RE.test(evidenceRef) ||
    DURABLE_ARTIFACT_REF_RE.test(evidenceRef) ||
    DURABLE_TEST_RUN_REF_RE.test(evidenceRef) ||
    DURABLE_COVERAGE_REF_RE.test(evidenceRef) ||
    DURABLE_FILE_REF_RE.test(evidenceRef) ||
    DURABLE_LEADING_FILE_REF_RE.test(evidenceRef) ||
    DURABLE_ABSOLUTE_FILE_REF_RE.test(evidenceRef)
  ) {
    return { lineage: 'durable', reason: 'explicit durable evidence reference' };
  }
  if (ephemeralReason) return { lineage: 'ephemeral', reason: ephemeralReason };
  return { lineage: 'unknown', reason: 'no durable rerun anchor' };
}

/**
 * Normalize an author-recorded disclosure into a list of non-empty gap strings.
 * Accepts a bare string or an array of strings; anything else is ignored.
 */
function disclosedGapList(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const EXPLICIT_COVERAGE_LIMITATION_PATTERNS = [
  /\b(?:leg|portion|part|subset|subsection|path|scenario)\b[^.;]{0,60}(?<!\b(?:read|write|append|ledger)-)\b(?:only|just)\b/i,
  // A mutation can change only the coverage result/field without limiting the
  // proof. Keep the noun "coverage" restrictive when it describes the proof,
  // while leaving separate omitted-behavior statements and explicit gap fields
  // enforceable even when they accompany technical field descriptions.
  // Qualified test nouns (test/fixture, test\\fixture, test.ts) in an input
  // inventory are not testing verbs. Real coverage statements beside them
  // still match, and explicit disclosedGap fields bypass this heuristic.
  // A durable test-run reference (for example, test-run20987792) is likewise
  // evidence bookkeeping, even when a scope note says it resolved an old gap.
  // Technical modifiers such as read-only and ledger-only describe the mechanism,
  // not an outstanding proof limitation. Separate scope claims in the same prose
  // and explicit gap fields must still be enforced (EI-25719594988320201).
  /(?<!\b(?:read|write|append|ledger)-)\b(?:only|just|partially)\b[^.;]{0,100}\b(?:cover(?:s|ed)?|test(?:s|ed|ing)?(?![/\\]|\.[A-Za-z]|-run)|exercise(?:s|d)?|verify|validate|address(?:es|ed)?|include(?:s|d)?|coverage(?!\s+(?:result|field|flag|value|record|metadata)\b))\b/i,
  /\b(?:does not|doesn't|did not|didn't|has not|hasn't|is not|isn't|are not|aren't)\b[^.;]{0,60}\b(?:cover|test|exercise|verify|validate|address|include)\b/i,
  /\b(?:outside|out of)\s+(?:the\s+)?(?:scope|coverage)\b|\bnot\s+(?:covered|tested|exercised|verified|validated|addressed)\b/i,
  /\b(?:remains?|is|are)\s+(?:a\s+)?separate\s+(?:requirement|integration|validation|work|proof)\b/i,
  /\b(?:remaining|other|rest|cutover)\b[^.;]{0,100}\b(?:mapped|assigned|tracked|covered|handled|addressed)\b[^.;]{0,60}\b(?:P-\d{3,}|[A-Z][A-Z0-9-]*-\d+)\b/i,
  /\bnot\s+(?:the\s+)?whole\b[^.;]{0,60}\b(?:proof|behavior|coverage|operational adoption)\b/i,
  /\b(?:behavior|scope parity|cancellation|retirement|proposal routing)\b[^.;]{0,100}\b(?:requires?|needs?)\b[^.;]{0,60}\b(?:proof|bindings)\b/i,
  // Provisional component notes can explicitly leave the composite proof pending
  // without using "only" or "not covered". Parent shipment bookkeeping is a
  // separate plane; require proof/coverage or clause/composite acceptance here.
  /\b(?:proof|coverage|(?:clause|composite)\s+acceptance)\b[^.;]{0,60}\b(?:remains?|is|are)\s+(?:pending|incomplete|unproven|unverified)\b/i,
  /\bdisclosures?\b[^.;]{0,40}\b(?:remains?|is|are)\s+(?:live|open|unresolved)\b/i,
];

// CLI switches are often hyphenated (`--materialize-only`, `--dry-run-only`).
// Strip the token before applying the prose heuristic so its flag suffix cannot
// be mistaken for the coverage phrase "only ... test/cover".
const CLI_FLAG_TOKEN_PATTERN = /--[a-z0-9][a-z0-9-]*/gi;

// Evidence-ledger replacement scope is operational bookkeeping, not a claim about
// which behavior the proof covers. Strip only that clause before applying the broad
// prose heuristic so a separate proof limitation in the same note remains visible.
const EVIDENCE_SUPERSESSION_SCOPE_PATTERN =
  /\b(?:replace|replaces|replaced|replacing|supersede|supersedes|superseded|superseding|rebind|rebinds|rebound|retract|retracts|retracted|retracting)\b[^.;]{0,120}\b(?:only|just)\b[^.;]{0,100}\b(?:in|within|on|at)\s+(?:the\s+)?same\s+test\s+subject\b/gi;

// "Links only when the tested diff contains the fix" describes a production
// safety condition, not a restriction on which cases were tested. Remove only
// the logical qualifier after a behavior verb; other limitations in the same
// observation and explicit disclosedGap fields still participate normally.
const BEHAVIOR_GUARD_CONDITION_PATTERN =
  /(\b(?:links?|admits?|merges?|allows?|permits?|publishes?|dispatch(?:es)?|accepts?|rejects?)\b[^.;]{0,100}\b)only(\s+(?:when|if)\b)/gi;

/** Only observations with explicit coverage-boundary language count as disclosures. */
function explicitCoverageLimitations(value: unknown): string[] {
  const raw = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? ['scope', 'proofScope', 'notes'].flatMap((key) => {
            const entry = (value as Record<string, unknown>)[key];
            return typeof entry === 'string' || Array.isArray(entry) ? (Array.isArray(entry) ? entry : [entry]) : [];
          })
        : [];
  return [
    ...new Set(
      raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => {
          if (entry.length === 0) return false;
          const coverageProse = entry
            .replace(CLI_FLAG_TOKEN_PATTERN, ' ')
            .replace(EVIDENCE_SUPERSESSION_SCOPE_PATTERN, ' ')
            .replace(BEHAVIOR_GUARD_CONDITION_PATTERN, '$1$2');
          return EXPLICIT_COVERAGE_LIMITATION_PATTERNS.some((pattern) => pattern.test(coverageProse));
        }),
    ),
  ];
}

/** Free-form metadata cannot hide a live proof gap by moving it out of scopeNote. */
function metadataCoverageLimitations(details: Record<string, unknown>): string[] {
  const gaps: string[] = [];
  const pending: Array<{ value: unknown; disclosure: boolean; explicitGap: boolean }> = [
    { value: details, disclosure: false, explicitGap: false },
  ];
  const seen = new WeakMap<object, number>();
  while (pending.length > 0) {
    const { value, disclosure, explicitGap } = pending.pop()!;
    if (typeof value === 'string') {
      if (explicitGap) gaps.push(...disclosedGapList(value));
      else if (disclosure) gaps.push(...explicitCoverageLimitations(value));
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const mode = explicitGap ? 2 : disclosure ? 1 : 0;
    if ((seen.get(value) ?? -1) >= mode) continue;
    seen.set(value, mode);
    for (const [key, child] of Object.entries(value)) {
      pending.push({ value: child,
        disclosure: disclosure || /disclos|boundary|gap|limitation/i.test(key),
        explicitGap: explicitGap || /^(?:disclosedGap|limitation|limitations)$/i.test(key) });
    }
  }
  return [...new Set(gaps)];
}

function detailsOf(evidence: SpecEvidenceForAdequacy): AdequacyDetails {
  const nested = evidence.details.adequacy;
  // A disclosure is read from BOTH the nested adequacy block and the top level.
  // `plans:bind-spec-evidence` accepts a free-form `details` object, so an author
  // who writes `details.disclosedGap` gets no error — reading only the nested
  // spelling would silently drop exactly the disclosure this criterion exists to
  // catch (EI-22953893504383574 is the same trap for the other adequacy keys).
  const topLevelDetails = evidence.details as Record<string, unknown>;
  // details is free-form, so explicit limitation fields are author disclosures too.
  const topLevelGap = [
    ...disclosedGapList(topLevelDetails.disclosedGap),
    ...disclosedGapList(topLevelDetails.limitation),
    ...disclosedGapList(topLevelDetails.limitations),
  ];
  const observationGaps = [
    ...explicitCoverageLimitations(topLevelDetails.observations),
    ...explicitCoverageLimitations(topLevelDetails.scopeNote),
    ...metadataCoverageLimitations(topLevelDetails),
  ];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    const disclosedGap = [...new Set([...topLevelGap, ...observationGaps])];
    return disclosedGap.length > 0 ? { disclosedGap } : {};
  }
  const raw = nested as Record<string, unknown>;
  const disclosedGap = [...new Set([...topLevelGap, ...disclosedGapList(raw.disclosedGap), ...observationGaps])];
  const bool = (key: string): boolean | undefined =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : undefined;
  const coverageRaw = raw.coverageRungs;
  const coverage =
    coverageRaw && typeof coverageRaw === 'object' && !Array.isArray(coverageRaw)
      ? (coverageRaw as Record<string, unknown>)
      : null;
  const contractMetadataIssues: string[] = [];
  const idList = (key: 'scenarioIds' | 'causalPairIds'): string[] | undefined => {
    if (!(key in raw)) return undefined;
    const value = raw[key];
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((id) => typeof id !== 'string' || !SPEC_PROOF_OBLIGATION_ID_RE.test(id.trim())) ||
      new Set(value.map((id) => (typeof id === 'string' ? id.trim() : ''))).size !== value.length
    ) {
      contractMetadataIssues.push(`${key}:invalid`);
      return undefined;
    }
    return value.map((id) => id.trim()).sort();
  };
  const scenarioIds = idList('scenarioIds');
  const causalPairIds = idList('causalPairIds');
  let testCases: string[] | undefined;
  if (raw.testCases !== undefined) {
    if (
      Array.isArray(raw.testCases) &&
      raw.testCases.length <= MAX_RECORDED_PASSED_CASES &&
      raw.testCases.every(isRecordedCaseTitle) &&
      new Set(raw.testCases).size === raw.testCases.length
    ) {
      testCases = [...raw.testCases];
    } else {
      contractMetadataIssues.push('testCases:invalid');
    }
  }
  const targeted =
    typeof raw.targeted === 'boolean'
      ? raw.targeted
      : typeof raw.targeted === 'string' && SPEC_TARGET_ID_RE.test(raw.targeted.trim())
        ? raw.targeted.trim()
        : undefined;
  if (raw.targeted !== undefined && targeted === undefined) contractMetadataIssues.push('targeted:invalid');
  return {
    ...(bool('fixtureCalibrated') !== undefined ? { fixtureCalibrated: bool('fixtureCalibrated') } : {}),
    ...(bool('fixtureFree') !== undefined ? { fixtureFree: bool('fixtureFree') } : {}),
    ...(bool('falsifiable') !== undefined ? { falsifiable: bool('falsifiable') } : {}),
    ...(typeof raw.testLayer === 'string' ? { testLayer: raw.testLayer } : {}),
    ...(bool('pathReachable') !== undefined ? { pathReachable: bool('pathReachable') } : {}),
    ...(bool('oracleIndependent') !== undefined ? { oracleIndependent: bool('oracleIndependent') } : {}),
    ...(bool('collected') !== undefined ? { collected: bool('collected') } : {}),
    ...(bool('skipped') !== undefined ? { skipped: bool('skipped') } : {}),
    ...(bool('executed') !== undefined ? { executed: bool('executed') } : {}),
    ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome } : {}),
    ...(targeted !== undefined ? { targeted } : {}),
    ...(coverage
      ? {
          coverageRungs: Object.fromEntries(
            ['l1', 'l2', 'l3', 'l4']
              .filter((key) => typeof coverage[key] === 'boolean')
              .map((key) => [key, coverage[key]]),
          ) as AdequacyDetails['coverageRungs'],
        }
      : {}),
    ...(scenarioIds ? { scenarioIds } : {}),
    ...(causalPairIds ? { causalPairIds } : {}),
    ...(testCases ? { testCases } : {}),
    ...(contractMetadataIssues.length > 0 ? { contractMetadataIssues } : {}),
    ...(evidence.provisionalProofBase === true || raw.provisionalProofBase === true
      ? { provisionalProofBase: true }
      : {}),
    ...(disclosedGap.length > 0 ? { disclosedGap } : {}),
  };
}

function normalizedLayer(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

/** Older accepted bars used these provenance labels for canonical operational evidence. */
function canonicalRequiredLayer(value: string): string {
  const layer = normalizedLayer(value);
  return layer === 'behavioral' || layer === 'manual-provenance' ? 'operational' : layer;
}

function clauseIdentity(clause: SpecClauseRevision): string {
  return `${clause.planSlug}/${clause.specId}@${clause.revision} (${clause.contentHash})`;
}

/**
 * Layer coverage is clause-scoped proof. The canonical binding row identifies the
 * selected clause by plan/spec/revision/fingerprint; its author-supplied target must
 * independently name that exact spec. A title that happens to match a case in a
 * different clause is not a substitute for this target.
 */
function bindingIdentityMatchesClause(row: SpecEvidenceForAdequacy, clause: SpecClauseRevision): boolean {
  return row.planSlug === clause.planSlug &&
    row.specId === clause.specId &&
    row.specRevision === clause.revision &&
    row.specFingerprint === clause.contentHash;
}

/**
 * The `adequacy.targeted` spellings that name a clause ITSELF: its specId, or that id
 * lowercased (the long-standing binder convention). ONE set for every rater: the layer,
 * coverage-census and mutation-target rules all read it, so a binding can never target the
 * clause for falsifiability and miss it for correct-layer (WI-6554700010008391: the exact
 * `=== clause.specId` here rated a lowercase-targeted proof `unknown` that
 * mutationTargetRequirement accepted).
 */
export function clauseSelfTargetIds(clause: { specId: string }): string[] {
  return [...new Set([clause.specId, clause.specId.toLowerCase()])];
}

/**
 * BAR-generated test titles sometimes carry the immutable clause id in their name
 * (for example `AUTO-BAR-R-03-P-008: ...`). When a binding targets a different
 * clause, that selected case is proof for the named sibling even though the
 * binding row's spec identity was rewritten to the target clause. Keep this
 * check deliberately narrow: free-form case titles without an embedded BAR id
 * remain valid and are still corroborated by the test-run ledger.
 */
const EMBEDDED_BAR_CLAUSE_ID_RE = /\bAUTO-BAR(?:-[A-Z0-9]+)+-P-\d{3,}\b/gi;

function embeddedBarClauseIds(caseTitle: string): string[] {
  return [...new Set(caseTitle.match(EMBEDDED_BAR_CLAUSE_ID_RE) ?? [])];
}

function clauseCaseTargetMismatches(
  row: SpecEvidenceForAdequacy,
  clause: SpecClauseRevision,
): Array<{ caseTitle: string; embeddedIds: string[] }> {
  if (!/^AUTO-BAR(?:-[A-Z0-9]+)+-P-\d{3,}$/i.test(clause.specId)) return [];
  const target = clause.specId.toLowerCase();
  return (detailsOf(row).testCases ?? []).flatMap((caseTitle) => {
    const embeddedIds = embeddedBarClauseIds(caseTitle);
    return embeddedIds.length > 0 && !embeddedIds.some((id) => id.toLowerCase() === target)
      ? [{ caseTitle, embeddedIds }]
      : [];
  });
}

/** True only when every declared case explicitly names a different BAR clause. */
function bindingHasOnlyMismatchedClauseCases(row: SpecEvidenceForAdequacy, clause: SpecClauseRevision): boolean {
  const declaredCases = detailsOf(row).testCases ?? [];
  const mismatches = clauseCaseTargetMismatches(row, clause);
  return declaredCases.length > 0 && mismatches.length === declaredCases.length;
}

function clauseCaseTargetMismatchSummary(
  rows: readonly SpecEvidenceForAdequacy[],
  clause: SpecClauseRevision,
): string {
  const entries = rows.flatMap((row) => clauseCaseTargetMismatches(row, clause).map(({ caseTitle, embeddedIds }) =>
    `binding ${row.id ?? '?'} declares ${JSON.stringify(caseTitle)} for ${embeddedIds.join(', ')} but targets ${clause.specId}`,
  ));
  const shown = entries.slice(0, 3);
  return `${shown.join('; ')}${entries.length > shown.length ? `; +${entries.length - shown.length} more` : ''}`;
}

function bindingTargetsClause(row: SpecEvidenceForAdequacy, clause: SpecClauseRevision): boolean {
  const targeted = detailsOf(row).targeted;
  return (
    bindingIdentityMatchesClause(row, clause) &&
    typeof targeted === 'string' &&
    clauseSelfTargetIds(clause).includes(targeted) &&
    !bindingHasOnlyMismatchedClauseCases(row, clause)
  );
}

function clauseProbe(clause: SpecClauseRevision, harness?: string): string {
  const args = JSON.stringify({
    ...(harness !== undefined ? { harness } : {}),
    slug: clause.planSlug,
    specIds: [clause.specId],
  });
  return (
    `Probe plans:get-spec-evidence with args=${args}. ` +
    `This selects the canonical current revision for ${clause.specId}@${clause.revision} ` +
    `(fingerprint ${JSON.stringify(clause.contentHash)}); the read has no direct revision or fingerprint selector.`
  );
}

function clauseDeclarationProbe(clause: SpecClauseRevision, harness?: string): string {
  const args = JSON.stringify({
    ...(harness !== undefined ? { harness } : {}),
    slug: clause.planSlug,
    specIds: [clause.specId],
  });
  return (
    `Probe plans:get-specs with args=${args}; inspect specs[0].requiredTestLayers. ` +
    `This reads the canonical declared test-layer requirement for ${clauseIdentity(clause)} ` +
    `(expected ${JSON.stringify(clause.requiredTestLayers)}).`
  );
}

const MAX_RENDERED_ADEQUACY_CASES = 8;

function renderedTestRunExecution(row: SpecEvidenceForAdequacy, details: Pick<AdequacyDetails, 'testCases'>) {
  const execution = row.testRunExecution;
  if (!execution) return null;

  const passedCaseTitles = execution.passedCaseTitles ?? [];
  const declaredCases = Array.isArray(details.testCases)
    ? [...new Set(details.testCases.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
    : [];
  const corroborates = (caseTitle: string) => execution.testLayer === 'llm'
    ? hasPassingLlmScenarioCase(row, caseTitle)
    : hasMatchingDeclaredCaseTitle(caseTitle, passedCaseTitles);
  const passedDeclaredCases = declaredCases.filter(corroborates);
  const missingDeclaredCases = declaredCases.filter((caseTitle) => !corroborates(caseTitle));
  const caseIdentityIncomplete = execution.testLayer !== 'llm' && execution.passedCaseTitlesIncomplete === true;
  const unknownDeclaredCases = caseIdentityIncomplete ? missingDeclaredCases : [];
  const confirmedMissingDeclaredCases = caseIdentityIncomplete ? [] : missingDeclaredCases;
  const adequacyTestCases = declaredCases.length === 0
    ? undefined
    : declaredCases.length <= MAX_RENDERED_ADEQUACY_CASES
      ? {
          declared: declaredCases,
          passed: passedDeclaredCases,
          missing: confirmedMissingDeclaredCases,
          ...(unknownDeclaredCases.length > 0 ? { unknown: unknownDeclaredCases } : {}),
        }
      : {
          declaredCount: declaredCases.length,
          passedCount: passedDeclaredCases.length,
          missingCount: confirmedMissingDeclaredCases.length,
          ...(unknownDeclaredCases.length > 0 ? { unknownCount: unknownDeclaredCases.length } : {}),
          declaredExamples: declaredCases.slice(0, MAX_RENDERED_ADEQUACY_CASES),
          passedExamples: passedDeclaredCases.slice(0, MAX_RENDERED_ADEQUACY_CASES),
          missingExamples: confirmedMissingDeclaredCases.slice(0, MAX_RENDERED_ADEQUACY_CASES),
          ...(unknownDeclaredCases.length > 0
            ? { unknownExamples: unknownDeclaredCases.slice(0, MAX_RENDERED_ADEQUACY_CASES) }
            : {}),
          examplesTruncated: true,
        };

  return {
    status: execution.status ?? null,
    passed: execution.passed,
    failed: execution.failed,
    skipped: execution.skipped,
    collectionFailed: execution.collectionFailed,
    testLayer: execution.testLayer ?? null,
    passedCaseTitleCount: passedCaseTitles.length,
    ...(caseIdentityIncomplete ? { passedCaseTitlesIncomplete: true } : {}),
    ...(execution.scenarioId !== undefined ? { scenarioId: execution.scenarioId } : {}),
    ...(adequacyTestCases ? { adequacyTestCases } : {}),
  };
}

function bindingDescription(row: SpecEvidenceForAdequacy): string {
  const details = detailsOf(row);
  const evidencePlane = readSpecEvidencePlane(row.details);
  const lineage = classifySpecEvidenceLineage(row);
  // An authored reference can outlive the run it described. A dirty run cannot
  // substantiate a claim about the committed HEAD, so omit that stale clause.
  const evidenceRef = row.testRunProvenance?.worktreeDirty === true
    ? row.evidenceRef.replace(/\s*,?\s*at current HEAD\.?$/i, '')
    : row.evidenceRef;
  const measurementPin = readMeasurementPin(row.details);
  const renderedMeasurementPin = measurementPin
    ? `measurementPin=${JSON.stringify({
        repos: measurementPin.repos.map(({ repo, rootHarnessSlug, head, gitlink }) => ({
          repo, ...(rootHarnessSlug ? { rootHarnessSlug } : {}), head, gitlink,
        })),
        files: measurementPin.files.map(({ path, repo, rootHarnessSlug }) => ({
          repositoryPath: repo,
          path: repo !== '.' && path.startsWith(`${repo}/`) ? path.slice(repo.length + 1) : path,
          ...(rootHarnessSlug ? { rootHarnessSlug } : {}),
        })),
      })}`
    : null;
  const fields = [
    // P-019: lead with the row id so a reader can act on THIS row (retract it, or re-bind
    // over it with supersedeAtRevision) without a separate plans:get-spec-evidence hunt.
    Number.isSafeInteger(row.id) ? `id=${row.id}` : null,
    row.supportingBindingIds && row.supportingBindingIds.length > 1
      ? `sameProofMetadataBindingIds=${JSON.stringify(row.supportingBindingIds)}`
      : null,
    `kind=${row.evidenceKind}`,
    `ref=${JSON.stringify(evidenceRef)}`,
    `lineage=${lineage.lineage}`,
    `lineageReason=${JSON.stringify(lineage.reason)}`,
    details.provisionalProofBase ? 'provisionalProofBase=true' : null,
    row.provisionalScorecard ? `provisionalScorecard=${JSON.stringify(row.provisionalScorecard)}` : null,
    `currentness=${row.currentness.overall}`,
    `currentnessProvenance=${row.currentness.provenance ?? 'legacy-implicit'}`,
    `sourceFingerprint=${JSON.stringify(row.fingerprints.sourceFingerprint)}`,
    row.fingerprints.testFingerprint ? `testFingerprint=${JSON.stringify(row.fingerprints.testFingerprint)}` : null,
    row.fingerprints.fixtureFingerprint
      ? `fixtureFingerprint=${JSON.stringify(row.fingerprints.fixtureFingerprint)}`
      : null,
    row.fingerprints.rubricFingerprint
      ? `rubricFingerprint=${JSON.stringify(row.fingerprints.rubricFingerprint)}`
      : null,
    row.fingerprints.environmentFingerprint
      ? `environmentFingerprint=${JSON.stringify(row.fingerprints.environmentFingerprint)}`
      : null,
    row.coverageEvidenceRef !== null ? `coverageEvidenceRef=${row.coverageEvidenceRef}` : null,
    row.testRunId !== null ? `testRunId=${row.testRunId}` : null,
    row.testRunId !== null && row.testRunExecution === null ? 'testRunLedgerExecution=unavailable' : null,
    row.testRunId !== null && row.testRunExecution != null
      ? 'testRunLedgerExecution=' + JSON.stringify(renderedTestRunExecution(row, details))
      : null,
    row.testRunProvenance
      ? `testRunLedgerFile=${JSON.stringify(row.testRunProvenance.filePath)}, ` +
        `testRunLedgerCommit=${JSON.stringify(row.testRunProvenance.commitSha)}, ` +
        `testRunLedgerWorktreeDirty=${row.testRunProvenance.worktreeDirty ?? 'unknown'}`
      : null,
    renderedMeasurementPin,
    ...mutationProvenanceDescription(row),
    details.fixtureCalibrated !== undefined ? `fixtureCalibrated=${details.fixtureCalibrated}` : null,
    details.fixtureFree !== undefined ? `fixtureFree=${details.fixtureFree}` : null,
    details.falsifiable !== undefined ? `falsifiable=${details.falsifiable}` : null,
    details.testLayer !== undefined ? `testLayer=${JSON.stringify(details.testLayer)}` : null,
    typeof evidencePlane === 'string' ? `evidencePlane=${JSON.stringify(evidencePlane)}` : null,
    details.pathReachable !== undefined ? `pathReachable=${details.pathReachable}` : null,
    details.oracleIndependent !== undefined ? `oracleIndependent=${details.oracleIndependent}` : null,
    details.collected !== undefined ? `collected=${details.collected}` : null,
    details.skipped !== undefined ? `skipped=${details.skipped}` : null,
    details.executed !== undefined ? `executed=${details.executed}` : null,
    details.outcome !== undefined ? `outcome=${JSON.stringify(details.outcome)}` : null,
    details.targeted !== undefined ? `targeted=${details.targeted}` : null,
    details.coverageRungs
      ? `coverageRungs=${(['l1', 'l2', 'l3', 'l4'] as const)
          .filter((rung) => details.coverageRungs?.[rung] !== undefined)
          .map((rung) => `${rung}:${details.coverageRungs?.[rung]}`)
          .join('|')}`
      : null,
    details.scenarioIds ? `scenarioIds=${JSON.stringify(details.scenarioIds)}` : null,
    details.causalPairIds ? `causalPairIds=${JSON.stringify(details.causalPairIds)}` : null,
    details.contractMetadataIssues ? `contractMetadataIssues=${JSON.stringify(details.contractMetadataIssues)}` : null,
    row.currentness.staleReasons.length > 0 ? `staleReasons=${JSON.stringify(row.currentness.staleReasons)}` : null,
    row.currentness.unknownReasons.length > 0
      ? `unknownReasons=${JSON.stringify(row.currentness.unknownReasons)}`
      : null,
  ].filter((field): field is string => field !== null);
  return fields.join(', ');
}

function bindingSummary(rows: SpecEvidenceForAdequacy[]): string {
  const ordered = [...rows].sort((a, b) =>
    `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`),
  );
  if (ordered.length === 0) {
    return '(no bound evidence rows; probe plans:get-spec-evidence for the exact clause)';
  }
  const maxRows = 6;
  const shown = ordered.slice(0, maxRows).map(bindingDescription).join('; ');
  const omitted = ordered.slice(maxRows).map((row) =>
    Number.isSafeInteger(row.id) ? `id=${row.id}` : `${row.evidenceKind}:${row.evidenceRef}`,
  );
  return omitted.length > 0
    ? `${shown}; +${omitted.length} more binding(s) omitted: ${omitted.join(', ')}`
    : shown;
}

function fixtureCalibrationBindingSummary(rows: SpecEvidenceForAdequacy[]): string {
  const ordered = [...rows].sort((a, b) =>
    `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`),
  );
  const shown = ordered.slice(0, 6).map((row) => {
    const identity = Number.isSafeInteger(row.id) ? `id=${row.id}` : `${row.evidenceKind}:${row.evidenceRef}`;
    const fixtureCalibrated = detailsOf(row).fixtureCalibrated;
    return `${identity} fixtureCalibrated=${fixtureCalibrated ?? 'unattested'}`;
  }).join('; ');
  const omitted = Math.max(0, ordered.length - 6);
  return omitted > 0 ? `${shown}; +${omitted} more binding(s) omitted` : shown;
}

function noteExcerpt(note: string, maxChars = 500): string {
  if (note.length <= maxChars) return note;
  const marker = '…[truncated]';
  const budget = Math.max(1, maxChars - marker.length);
  const candidate = note.slice(0, budget).trimEnd();
  const boundary = candidate.lastIndexOf(' ');
  const readable = boundary > Math.floor(budget / 2) ? candidate.slice(0, boundary).trimEnd() : candidate;
  return readable + marker;
}

function bindingNotesSummary(
  rows: SpecEvidenceForAdequacy[],
  selectedRows: readonly SpecEvidenceForAdequacy[] = [],
): string {
  const selectedIds = new Set(
    selectedRows
      .map((row) => row.id)
      .filter((id): id is number => Number.isSafeInteger(id)),
  );
  const selectedKeys = new Set(selectedRows.map(logicalEvidenceReferenceKey));
  const notes = rows
    .map((row) => {
      const note = typeof row.details.note === 'string' ? row.details.note.trim() : '';
      if (note.length === 0) return null;
      const excerpt = noteExcerpt(note);
      const id = Number.isSafeInteger(row.id) ? 'id=' + row.id + ' ' : '';
      const selected = Number.isSafeInteger(row.id)
        ? selectedIds.has(row.id!)
        : selectedKeys.has(logicalEvidenceReferenceKey(row));
      return id + `scope=${selected ? 'selected' : 'other-current'} ` + 'note=' + JSON.stringify(excerpt);
    })
    .filter((note): note is string => note !== null);
  if (notes.length === 0) return '';
  const maxNotes = 6;
  const shown = notes.slice(0, maxNotes).join('; ');
  const omitted = notes.length > maxNotes ? '; +' + (notes.length - maxNotes) + ' more note(s)' : '';
  return (
    ' Free-form binding notes are visible for review but are not interpreted as disclosures: ' +
    shown +
    omitted +
    '.'
  );
}

function evidenceWithBindings(statement: string, rows: SpecEvidenceForAdequacy[]): string {
  return `${statement} Bound evidence: ${bindingSummary(rows)}.`;
}

/** Card prose points into one shared binding table; evaluator diagnostics stay detailed. */
function scorecardBindingEvidence(
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>,
  rows: SpecEvidenceForAdequacy[],
  rerunRecipe: SpecTestAdequacyRerunRecipe,
): { ratings: typeof ratings; table: string } {
  // One immutable binding can reach this presentation layer through multiple
  // evidence projections. Their rendered descriptions may differ, but they must
  // still share one B label in the scorecard.
  const entries = uniqueBindingRows(rows)
    .map((row) => [bindingDescription(row), row] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const references = entries.map(([description, row], index) => ({
    description,
    ref: Number.isSafeInteger(row.id) ? `id=${row.id}, binding=B${index + 1}` : `binding=B${index + 1}`,
  }));
  return {
    ratings: Object.fromEntries(Object.entries(ratings).map(([criterion, rating]) => [criterion, {
      ...rating,
      evidence: references.reduce(
        (text, binding) => text.replaceAll(binding.description, binding.ref),
        rating.evidence,
      ).replace(
        ratingRerunProbeText(criterion as AdequacyCriterion, rerunRecipe),
        ratingRerunProbeReference(criterion as AdequacyCriterion, rerunRecipe),
      ),
    }])) as typeof ratings,
    table: references.length > 0
      ? '\n\nShared binding evidence (criterion references B1, B2, ... resolve here):\n' +
        references.map((binding) => `${binding.ref}: ${binding.description}`).join('\n')
      : '',
  };
}

type CorrectLayerEvidencePart = {
  rating: AdequacyRating;
  evidence: string;
  statement: string;
  bindingRows: SpecEvidenceForAdequacy[];
  suggestion?: string;
};

function plainCorrectLayerPart(
  rating: AdequacyRating,
  evidence: string,
  suggestion?: string,
): CorrectLayerEvidencePart {
  return {
    rating,
    evidence,
    statement: evidence,
    bindingRows: [],
    ...(suggestion ? { suggestion } : {}),
  };
}

function boundCorrectLayerPart(
  rating: AdequacyRating,
  statement: string,
  bindingRows: SpecEvidenceForAdequacy[],
  suggestion?: string,
  suffix = '',
): CorrectLayerEvidencePart {
  return {
    rating,
    evidence: evidenceWithBindings(statement, bindingRows) + suffix,
    statement: statement + suffix,
    bindingRows,
    ...(suggestion ? { suggestion } : {}),
  };
}

function bindingIdentity(row: SpecEvidenceForAdequacy): string {
  return Number.isSafeInteger(row.id)
    ? 'id:' + row.id
    : 'ref:' + logicalEvidenceReferenceKey(row);
}

function uniqueBindingRows(rows: SpecEvidenceForAdequacy[]): SpecEvidenceForAdequacy[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = bindingIdentity(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function correctLayerMutationExclusion(
  evidence: SpecEvidenceForAdequacy[],
  layerBindings: SpecEvidenceForAdequacy[],
): string {
  const included = new Set(layerBindings.map(bindingIdentity));
  const excludedMutations = uniqueBindingRows(
    evidence.filter((row) => row.evidenceKind === 'mutation' && !included.has(bindingIdentity(row))),
  );
  if (excludedMutations.length === 0) return '';
  const labels = excludedMutations
    .map((row) => Number.isSafeInteger(row.id) ? 'id=' + row.id : 'ref=' + JSON.stringify(row.evidenceRef))
    .join(', ');
  return ' Mutation binding(s) ' + labels +
    ' are excluded because mutation outcomes establish falsifiability, not correct-layer path reachability.';
}

/**
 * Presence-and-sign ONLY, deliberately — this is not where fakery is stopped.
 *
 * REFERENTIAL EXISTENCE IS ENFORCED IN POSTGRES, at bind time, by the
 * `spec_evidence_bindings_validate_refs` BEFORE INSERT trigger installed in
 * migration 855 (`harness_shared.validate_spec_evidence_binding_refs`). It
 * rejects a `test_run_id` / `coverage_evidence_ref` that does not resolve with
 * ERRCODE 23503, and matches on `workspace_id` AND `harness_slug`, so a
 * fabricated or cross-tenant id can never reach a row this function ever sees.
 *
 * Read this predicate on its own and `execution-integrity` looks trivially
 * fakeable (`testRunId: 1` would satisfy it). That reading is wrong, and it has
 * cost a bogus bug filing at least once — EI-22684973731417610, filed against
 * this exact function and retracted after the trigger was verified live via
 * pg_trigger + pg_get_functiondef. Audit the DB before concluding the ledger
 * reference is unchecked.
 *
 * Corollary worth knowing: because the trigger matches harness_slug exactly, a
 * test run recorded under a DIFFERENT harness than the binding (or with the
 * NULL scope that CI/dogfood-reporter rows carry by design) cannot be bound as
 * evidence at all.
 */
function hasExecutionLedgerReference(row: SpecEvidenceForAdequacy): boolean {
  return (
    (Number.isSafeInteger(row.testRunId) && row.testRunId! > 0) ||
    (Number.isSafeInteger(row.coverageEvidenceRef) && row.coverageEvidenceRef! > 0)
  );
}

/**
 * Binding details and evidenceRef are claims about identity; the joined test_runs row is the
 * authority. Older rows can predate the write-schema guard, so every executable verdict checks
 * that these identities still name the canonical id and file.
 */
function canonicalTestRunIdentityGaps(row: SpecEvidenceForAdequacy): string[] {
  const gaps: string[] = [];
  const evidenceRef = typeof row.evidenceRef === 'string' ? row.evidenceRef : '';
  const detailsRunValue = row.details.testRun;
  const detailsRun = detailsRunValue !== null && typeof detailsRunValue === 'object' && !Array.isArray(detailsRunValue)
    ? detailsRunValue as Record<string, unknown>
    : null;
  const hasDetailsRun = detailsRunValue !== undefined;
  const runReference = /^test-run\s+(\d+)\b/.exec(evidenceRef);
  const pathReference = /^test-run:(\d+):(.+)$/.exec(evidenceRef);
  const canonicalPath = row.testRunProvenance?.filePath ?? row.testRunExecution?.filePath ?? null;
  if (pathReference && row.testRunId != null && Number(pathReference[1]) !== row.testRunId) {
    gaps.push('evidenceRef testRunId=' + pathReference[1] + ' differs from canonical testRunId=' + row.testRunId);
  }
  if (runReference && row.testRunId != null && Number(runReference[1]) !== row.testRunId) {
    gaps.push(`evidenceRef testRunId=${runReference[1]} differs from canonical testRunId=${row.testRunId}`);
  }
  if (hasDetailsRun) {
    if (!detailsRun) {
      gaps.push('details.testRun is not an identity object');
    } else if (row.testRunId != null && detailsRun.id != null && detailsRun.id !== row.testRunId) {
      gaps.push(`details.testRun.id=${String(detailsRun.id ?? 'missing')} differs from canonical testRunId=${row.testRunId ?? 'missing'}`);
    }
    const declaredPath = typeof detailsRun?.filePath === 'string' ? detailsRun.filePath.trim() : '';
    if (declaredPath && !canonicalPath) {
      gaps.push('canonical test-run file path is unavailable');
    } else if (declaredPath && canonicalPath && !testFilePathMatches(declaredPath, canonicalPath)) {
      const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
      const cargoSourceMatches = canonicalPath.includes('::') && measurement.success &&
        measurement.data.testPaths?.some((path) => testFilePathMatches(declaredPath, path));
      if (!cargoSourceMatches) {
        gaps.push(`details.testRun.filePath=${JSON.stringify(declaredPath)} differs from canonical test-run file=${JSON.stringify(canonicalPath)}`);
      }
    }
    if (row.testRunId != null && row.evidenceKind !== 'test') {
      const referencePath = evidenceRef.replaceAll('\\', '/');
      if (runReference && (Number(runReference[1]) !== row.testRunId || !referencePath.includes(declaredPath.replaceAll('\\', '/')))) {
        gaps.push('run-derived evidenceRef does not identify details.testRun');
      }
    }
  }
  if (row.testRunId != null && row.evidenceKind === 'test' && pathReference) {
    const referencePath = pathReference[2]!;
    if (!canonicalPath) {
      gaps.push('canonical test-run file path is unavailable');
    } else if (!testFilePathMatches(referencePath, canonicalPath)) {
      gaps.push(`test evidenceRef=${JSON.stringify(referencePath)} differs from canonical test-run file=${JSON.stringify(canonicalPath)}`);
    }
  }
  return [...new Set(gaps)];
}

/** A binder's case list is corroborated by an exact or runner-prefix-suffixed case in a passing ledger row. */
function hasPassingLedgerCase(row: SpecEvidenceForAdequacy, caseTitle: string): boolean {
  const run = row.testRunExecution;
  return row.testRunId !== null &&
    canonicalTestRunIdentityGaps(row).length === 0 &&
    run != null &&
    run.status?.toLowerCase() === 'pass' &&
    run.passed > 0 &&
    run.failed === 0 &&
    run.collectionFailed === false &&
    hasMatchingDeclaredCaseTitle(caseTitle, run.passedCaseTitles ?? []);
}

/** Mutation and counterexample baselines must remain test-run evidence. */
function hasPassingTestBaselineCase(row: SpecEvidenceForAdequacy, caseTitle: string): boolean {
  return row.evidenceKind === 'test' && hasPassingLedgerCase(row, caseTitle);
}

/** A live LLM case is identified by its exact recorded scenario, framework and executed file. */
function hasPassingLlmScenarioCase(row: SpecEvidenceForAdequacy, scenarioId: string): boolean {
  const run = row.testRunExecution;
  const provenance = row.testRunProvenance;
  return row.evidenceKind === 'test' && row.testRunId !== null &&
    canonicalTestRunIdentityGaps(row).length === 0 &&
    run != null && run.testLayer === 'llm' &&
    run.status?.toLowerCase() === 'pass' && run.passed > 0 &&
    run.failed === 0 && run.skipped === 0 && run.collectionFailed === false &&
    typeof run.scenarioId === 'string' && run.scenarioId.length > 0 &&
    run.scenarioId === scenarioId &&
    provenance?.framework === 'llm-test' && provenance.worktreeDirty === false &&
    typeof run.filePath === 'string' && run.filePath.length > 0 &&
    run.filePath === provenance.filePath;
}

/** LLM scenarios and operational adapters retain their own canonical execution identities. */
function hasPassingRequiredLayerCase(row: SpecEvidenceForAdequacy, caseTitle: string): boolean {
  if (row.testRunExecution?.testLayer === 'llm') return hasPassingLlmScenarioCase(row, caseTitle);
  return hasPassingTestBaselineCase(row, caseTitle) ||
    (row.evidenceKind === 'operational' &&
      row.testRunExecution?.testLayer === 'operational' &&
      hasPassingLedgerCase(row, caseTitle));
}

function hasUnmatchedPassingCaseDeclaration(row: SpecEvidenceForAdequacy): boolean {
  if (!['test', 'operational'].includes(row.evidenceKind) || row.testRunExecution?.status?.toLowerCase() !== 'pass') {
    return false;
  }
  return (detailsOf(row).testCases ?? []).some((caseTitle) => !hasPassingRequiredLayerCase(row, caseTitle));
}

type MeasuredExecutionVerdict = 'pass' | 'fail' | 'unknown';

/**
 * A descriptor-bearing catch must be calibrated by this invocation's measured pass.
 * Exported for mechanical test adequacy (agent-paperwork-and-restart-tax-reduction-2026-10-15
 * P-003), which must accept exactly the mutants this evaluator accepts as causally linked.
 */
export function hasLinkedMutationBaseline(row: SpecEvidenceForAdequacy): boolean {
  const provenance = row.testRunProvenance;
  const mutation = provenance?.mutation;
  const baseline = provenance?.mutationBaseline;
  const measurement = mutation === undefined
    ? null
    : repoFilesEvidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
  // Descriptors use the subject's own Git root, while a multi-repository
  // measurement uses workspace paths. Resolve only one pinned source whose
  // repository and exact bytes agree; a suffix or fixture match is insufficient.
  // This normalizes identity only: the independent freshness verdict still applies.
  const pin = readMeasurementPin(row.details);
  const nestedSubjects = mutation !== undefined && measurement?.success
    ? pin?.files.filter(file => file.dimension === 'source' && !file.rootHarnessSlug &&
      file.repo !== '.' && file.path === `${file.repo}/${mutation.subjectPath}` &&
      file.sha256 === mutation.subjectBeforeSha256 &&
      measurement.data.sourcePaths.includes(file.path) &&
      pin.repos.some(repo => repo.repo === file.repo && !repo.rootHarnessSlug && repo.gitlink !== null)) ?? []
    : [];
  const mutationSubjectMeasured =
    mutation !== undefined &&
    measurement !== null &&
    measurement.success &&
    (measurement.data.sourcePaths.includes(mutation.subjectPath) || nestedSubjects.length === 1);
  const declaredCases = detailsOf(row).testCases ?? [];
  // A focused runner counts filtered-out cases as skipped. Credit only cases the
  // calibration row actually measured passing; an incomplete list never proves
  // an omitted case passed, and binder-written passed titles cannot qualify it.
  const baselineScopePassed = baseline != null && (baseline.skipped === 0 ||
    (declaredCases.length > 0 && declaredCases.every(caseTitle =>
      hasMatchingDeclaredCaseTitle(caseTitle, baseline.passedCaseTitles ?? []))));
  return mutation !== undefined && mutationSubjectMeasured && mutation.leg === 'mutant' &&
    provenance?.source === 'mutation-probe' && provenance.mutationPhase === 'mutant' &&
    baseline != null && baseline.testRunId !== row.testRunId &&
    baseline.status === 'pass' && baseline.passed > 0 && baseline.failed === 0 &&
    baselineScopePassed && baseline.collectionFailed === false &&
    CALIBRATION_LEGS.includes(baseline.mutation.leg) &&
    baseline.mutation.probeInvocationId === mutation.probeInvocationId &&
    baseline.mutation.subjectBeforeSha256 === mutation.subjectBeforeSha256;
}

function mutationProvenanceDescription(row: SpecEvidenceForAdequacy): string[] {
  if (row.evidenceKind !== 'mutation' && !isCanonicalMutantCounterexample(row)) return [];
  const provenance = row.testRunProvenance;
  const mutation = provenance?.mutation;
  const reaim = row.details.reaim;
  const measuredFields = [
    `mutationLeg=${JSON.stringify(mutation?.leg ?? provenance?.mutationPhase ?? null)}`,
    `mutationFailedCaseTitles=${JSON.stringify(provenance?.mutationFailedCaseTitles ?? [])}`,
    `mutationReaim=${JSON.stringify(reaim ?? null)}`,
    'mutationReaimCoverage=ledgered-mutant-leg-rows-only',
  ];
  if (!mutation) {
    // A mutation-probe row with a recorded phase was produced by the current
    // probe writer but lost its descriptor before persistence. Keep the
    // historical label for rows that predate the phase marker; calling a
    // fresh unlinked row "legacy" hides a live provenance gap.
    const linkage = provenance?.source === 'mutation-probe' &&
      typeof provenance.mutationPhase === 'string' && provenance.mutationPhase.trim().length > 0
      ? 'unverified-current'
      : 'unverified-legacy';
    return [`mutationLinkage=${linkage}`, ...measuredFields];
  }
  return [
    `mutationLinkage=${hasLinkedMutationBaseline(row) ? 'verified' : 'unverified'}`,
    ...measuredFields,
    `probeInvocationId=${JSON.stringify(mutation.probeInvocationId)}`,
    `mutationSubjectPath=${JSON.stringify(mutation.subjectPath)}`,
    `mutationExpression=${JSON.stringify(mutation.mutateExpression)}`,
    `mutationAgainstCommit=${JSON.stringify(mutation.againstCommit)}`,
    `mutationSubjectBeforeSha256=${mutation.subjectBeforeSha256}`,
    `mutationBaselineTestRunId=${provenance?.mutationBaseline?.testRunId ?? 'unavailable'}`,
  ];
}

/** Only canonical ledger provenance can identify a counterexample mutant run. */
function isCanonicalMutantCounterexample(row: SpecEvidenceForAdequacy): boolean {
  return row.testRunId !== null &&
    canonicalTestRunIdentityGaps(row).length === 0 &&
    row.testRunProvenance?.source === 'mutation-probe' &&
    row.testRunProvenance.mutationPhase === 'mutant';
}

/** Every declared case must have a measured outcome; mutant scopes must include a failed case. */
function hasMeasuredCaseScope(row: SpecEvidenceForAdequacy, failedCases?: string[]): boolean | undefined {
  const declared = detailsOf(row).testCases ?? [];
  if (declared.length === 0) return false;
  const executed = [...(row.testRunExecution?.passedCaseTitles ?? []), ...(failedCases ?? [])];
  const unmatched = declared.filter((title) => !hasMatchingDeclaredCaseTitle(title, executed));
  if (unmatched.length > 0) {
    return row.testRunExecution?.passedCaseTitlesIncomplete === true ? undefined : false;
  }
  return failedCases === undefined || declared.some((title) => hasMatchingDeclaredCaseTitle(title, failedCases));
}

/** Run-backed proof takes its execution verdict from test_runs, never copied binder booleans. */
function measuredExecutionVerdict(row: SpecEvidenceForAdequacy): MeasuredExecutionVerdict {
  if (row.testRunId === null) return 'unknown';
  if (canonicalTestRunIdentityGaps(row).length > 0) return 'unknown';
  const run = row.testRunExecution;
  const status = run?.status?.toLowerCase();
  if (!run || !status || status === 'running' || status === 'error') return 'unknown';
  if (status === 'skipped' || status === 'cancelled' || status === 'canceled') return 'fail';

  if ((row.evidenceKind === 'mutation' || isCanonicalMutantCounterexample(row)) &&
      row.testRunProvenance?.mutation) {
    const outcome = detailsOf(row).outcome?.toLowerCase();
    if (!hasLinkedMutationBaseline(row) ||
        !row.testRunProvenance.mutationFailedCaseTitles?.length ||
        (outcome !== undefined && outcome !== 'caught' && outcome !== 'killed') || status !== 'fail') return 'unknown';
  }

  if (row.evidenceKind === 'mutation') {
    if (status === 'pass') return 'fail';
    if (status !== 'fail' || run.collectionFailed || run.failed < 1) return 'unknown';
    if (run.skipped > 0 && !hasMeasuredCaseScope(row, row.testRunProvenance?.mutationFailedCaseTitles ?? [])) return 'unknown';
    // The evidence reader exposes these lines only for a failed mutation-probe row;
    // the paired test binding must also match this canonical file.
    return row.testRunProvenance?.mutationFailureLines?.length ? 'pass' : 'unknown';
  }

  if (row.evidenceKind === 'counterexample') {
    const rawMutant = isCanonicalMutantCounterexample(row);
    if (rawMutant) {
      if (status === 'pass') return 'fail';
      if (status !== 'fail' || run.collectionFailed || run.failed < 1) return 'unknown';
      if (run.skipped > 0 && !hasMeasuredCaseScope(row, row.testRunProvenance?.mutationFailedCaseTitles ?? [])) return 'unknown';
      return row.testRunProvenance?.mutationFailureLines?.length || row.testRunProvenance?.mutationFailedCaseTitles?.length
        ? 'pass'
        : 'unknown';
    }
    if (status === 'pass') return 'unknown';
    if (status !== 'fail') return 'unknown';
    return 'fail';
  }

  if (status === 'fail') return 'fail';
  if (status !== 'pass') return 'unknown';
  return run.collectionFailed || run.failed > 0 || run.passed < 1 ||
    (run.skipped > 0 && !hasMeasuredCaseScope(row))
    ? 'fail'
    : 'pass';
}

function executionFailureDetails(row: SpecEvidenceForAdequacy): string {
  const run = row.testRunExecution;
  const status = run?.status?.toLowerCase();
  const predicates: string[] = [];
  if (!run) {
    predicates.push('canonical execution_details are unavailable');
  } else {
    if (status === 'skipped' || status === 'cancelled' || status === 'canceled') {
      predicates.push('predicate=status is skipped or cancelled');
    }
    if (run.collectionFailed) predicates.push('predicate=collectionFailed=true');
    if (run.failed > 0) predicates.push('predicate=failed>0 (' + run.failed + ')');
    if (run.passed < 1) predicates.push('predicate=passed<1 (' + run.passed + ')');
    if (run.skipped > 0) {
      const failedCases = row.evidenceKind === 'mutation' || isCanonicalMutantCounterexample(row)
        ? row.testRunProvenance?.mutationFailedCaseTitles
        : undefined;
      if (hasMeasuredCaseScope(row, failedCases) !== true) {
        predicates.push(
          'predicate=skipped>0 without complete measured case scope (skipped=' + run.skipped +
            ', declaredCaseCount=' + (detailsOf(row).testCases?.length ?? 0) +
            ', passedCaseTitleCount=' + (run.passedCaseTitles ?? []).length + ')',
        );
      }
    }
    if ((row.evidenceKind === 'mutation' || isCanonicalMutantCounterexample(row)) && status === 'pass') {
      predicates.push('predicate=mutant run passed instead of killing the mutant');
    } else if (status === 'fail' && row.evidenceKind !== 'mutation' && !isCanonicalMutantCounterexample(row)) {
      predicates.push('predicate=status=fail');
    }
  }

  if (predicates.length === 0) predicates.push('predicate=measured-execution-verdict-fail');
  const bindingId = Number.isSafeInteger(row.id) ? String(row.id) : 'unknown';
  const runId = row.testRunId ?? 'unknown';
  const measurements = run
    ? [
        'status=' + (run.status ?? 'unset'),
        'passed=' + run.passed,
        'failed=' + run.failed,
        'skipped=' + run.skipped,
        'collectionFailed=' + run.collectionFailed,
        'passedCaseTitleCount=' + (run.passedCaseTitles ?? []).length,
        'worktreeDirty=' + (row.testRunProvenance?.worktreeDirty ?? 'unknown'),
      ].join(', ')
    : 'executionDetails=unavailable';
  return 'binding ' + bindingId + ' / run ' + runId + ': ' +
    predicates.join('; ') + '; measured ' + measurements;
}

function executionFailureSuggestion(rows: SpecEvidenceForAdequacy[]): string {
  const suggestions = new Set<string>();
  for (const row of rows) {
    const run = row.testRunExecution;
    const status = run?.status?.toLowerCase();
    if (run && run.skipped > 0) {
      suggestions.add('Re-run the full test file without a test-name filter (remove -t), then bind the passing run.');
    }
    if (status === 'skipped' || status === 'cancelled' || status === 'canceled') {
      suggestions.add('Resolve the skipped or cancelled run, then re-run the proof and bind the passing result.');
    }
    if (run?.collectionFailed) {
      suggestions.add('Fix test collection errors, then re-run the full file and bind the passing run.');
    }
    if (run && (run.failed > 0 || status === 'fail')) {
      suggestions.add('Fix the failing test case(s), then re-run the full file and bind the passing run.');
    } else if (run && run.passed < 1) {
      suggestions.add('Ensure the proof run executes at least one passing case, then bind that run.');
    }
    if (row.testRunProvenance?.worktreeDirty === true) {
      suggestions.add('Re-run on a clean worktree at the intended source revision and bind that result.');
    }
    if ((row.evidenceKind === 'mutation' || isCanonicalMutantCounterexample(row)) && status === 'pass') {
      suggestions.add('Correct the mutant or probe so the intended behavior is caught, then bind the measured result.');
    }
  }
  if (suggestions.size === 0) {
    suggestions.add('Correct the measured execution failure, then re-run the proof and bind the passing result.');
  }
  return [...suggestions].join(' ');
}

function isSuccessfulExecutableEvidence(row: SpecEvidenceForAdequacy): boolean {
  if (!EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind) || !hasExecutionLedgerReference(row)) return false;
  // A coverage-evidence reference is useful traceability, but it does not carry the
  // canonical test_runs status/count verdict. Binder booleans cannot stand in for that row.
  return row.testRunId !== null && measuredExecutionVerdict(row) === 'pass';
}

// EI-23756870948948211: when a row FAILS isSuccessfulExecutableEvidence, callers need to know
// WHICH conjunct was unmet — otherwise a refusal names a cause it never tested and the reader
// goes hunting the wrong layer. A normally-authored binding sets evidenceKind + a ledger ref +
// outcome and omits details.collected/skipped/executed, so those three are the usual culprits,
// and `unset` is reported distinctly from an explicit `false` because the two are fixed by
// different edits.
function executableEvidenceGaps(row: SpecEvidenceForAdequacy): string[] {
  const details = detailsOf(row);
  const show = (value: boolean | undefined): string => (value === undefined ? 'unset' : String(value));
  const gaps: string[] = [];
  if (!EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind)) {
    gaps.push(`evidenceKind=${row.evidenceKind} is not executable`);
  }
  if (!hasExecutionLedgerReference(row)) {
    gaps.push('no testRunId/coverageEvidenceRef ledger reference');
  }
  gaps.push(...canonicalTestRunIdentityGaps(row));
  if (row.testRunId === null) {
    gaps.push('no canonical test-run execution verdict');
  } else if (measuredExecutionVerdict(row) !== 'pass') {
    const run = row.testRunExecution;
    gaps.push(
      run
        ? `canonical execution=${measuredExecutionVerdict(row)} for ${row.evidenceKind}: status=${run.status ?? 'unset'}, passed=${run.passed}, failed=${run.failed}, skipped=${run.skipped}, collectionFailed=${run.collectionFailed}` +
          (row.evidenceKind === 'mutation' ? `, measuredMutationFailure=${Boolean(row.testRunProvenance?.mutationFailureLines?.length)}` : '')
        : 'canonical test-run execution details unavailable',
    );
  }
  if (details.collected !== true) {
    gaps.push(`collected=${show(details.collected)}`);
  }
  if (details.skipped !== false) {
    gaps.push(`skipped=${show(details.skipped)}`);
  }
  if (details.executed !== true) {
    gaps.push(`executed=${show(details.executed)}`);
  }
  if (!SUCCESS_OUTCOMES.has(details.outcome?.toLowerCase() ?? '')) {
    gaps.push(`outcome=${details.outcome === undefined ? 'unset' : JSON.stringify(details.outcome)}`);
  }
  return gaps;
}

function summarizeExecutableEvidenceGaps(rows: SpecEvidenceForAdequacy[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const gap of executableEvidenceGaps(row)) {
      counts.set(gap, (counts.get(gap) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return 'no unmet conjunct identified';
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([gap, count]) => (rows.length > 1 ? `${gap} on ${count}` : gap))
    .join(', ');
}

/**
 * P-019: why a binding may NOT supersede its siblings at a clause revision (empty = it
 * may). `plans:bind-spec-evidence { supersedeAtRevision:true }` retracts the other live
 * rows of the same kind at that revision, so the superseding row must itself be proof the
 * evaluator would accept on its own: successful ledger-backed executable evidence, with no
 * explicit falsifiable=false and no author-disclosed gap. Anything weaker would let a
 * binder shed adverse evidence by binding a weaker row over it — the evidence-shedding
 * D-011 forbids. Reuses the evaluator's own conjuncts so the two cannot drift.
 */
export function supersedeEligibilityGaps(binding: {
  evidenceKind: SpecEvidenceKind;
  testRunId?: number | null;
  coverageEvidenceRef?: number | null;
  testRunExecution?: SpecEvidenceForAdequacy['testRunExecution'];
  testRunProvenance?: SpecEvidenceForAdequacy['testRunProvenance'];
  details?: Record<string, unknown>;
}): string[] {
  const row = {
    evidenceKind: binding.evidenceKind,
    testRunId: binding.testRunId ?? null,
    coverageEvidenceRef: binding.coverageEvidenceRef ?? null,
    ...(binding.testRunExecution !== undefined ? { testRunExecution: binding.testRunExecution } : {}),
    ...(binding.testRunProvenance !== undefined ? { testRunProvenance: binding.testRunProvenance } : {}),
    details: binding.details ?? {},
  } as SpecEvidenceForAdequacy;
  const details = detailsOf(row);
  return [
    ...executableEvidenceGaps(row),
    ...(details.falsifiable === false ? ['falsifiable=false'] : []),
    ...(details.disclosedGap?.length ? ['an author-disclosed gap is recorded'] : []),
  ];
}

/**
 * EI-25215634977268694: the repair to name when stale rows drag freshness. Supersession
 * clears a stale row only when a CURRENT sibling of the SAME evidenceKind may itself
 * supersede — the exact rule `plans:bind-spec-evidence` enforces via
 * `supersedeEligibilityGaps`, reused here so the advice and the verb cannot drift. When any
 * stale row lacks such a sibling, supersession would be refused for it, so the honest
 * remedy is an explicit retract (which works for every row).
 */
function freshnessDragSuggestion(evidence: SpecEvidenceForAdequacy[]): string {
  const current = evidence.filter((row) => row.currentness.overall === 'current');
  if (current.length === 0) {
    return 'Re-run the stale proof (testing:run with evidence) so the server re-measures it against current source.';
  }
  const supersedingKinds = new Set(
    current.filter((row) => supersedeEligibilityGaps(row).length === 0).map((row) => row.evidenceKind),
  );
  const everyStaleRowSupersedable = evidence
    .filter((row) => row.currentness.overall === 'stale')
    .every((row) => supersedingKinds.has(row.evidenceKind));
  return everyStaleRowSupersedable ? SUPERSEDE_DRAGGING_SUGGESTION : RETRACT_DRAGGING_SUGGESTION;
}

function isSuccessfulRepairedEvidence(row: SpecEvidenceForAdequacy): boolean {
  const details = detailsOf(row);
  return isSuccessfulExecutableEvidence(row) && REPAIRED_OUTCOMES.has(details.outcome?.toLowerCase() ?? '');
}

function testFilePathMatches(required: string, measured: string): boolean {
  const normalize = (value: string) => value.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  const expected = normalize(required);
  const actual = normalize(measured);
  return expected === actual || actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
}

function distinctTestRunRows(rows: SpecEvidenceForAdequacy[]): SpecEvidenceForAdequacy[] {
  const seenRuns = new Set<number>();
  const seenRefs = new Set<string>();
  return rows.filter((row) => {
    if (row.testRunId !== null) {
      if (seenRuns.has(row.testRunId)) return false;
      seenRuns.add(row.testRunId);
      return true;
    }
    const key = `${row.evidenceKind}\0${row.evidenceRef}`;
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  });
}

function sourceBarTestSuiteRating(
  clause: SpecClauseRevision,
  evidence: SpecEvidenceForAdequacy[],
  requirements: SourceBarTestRequirements | undefined,
): CorrectLayerEvidencePart | null {
  const resolved = requirements ?? (clause.sourceBar
    ? { status: 'unavailable' as const, reason: 'the pinned source BAR requirements were not resolved by the caller' }
    : { status: 'not-required' as const });
  if (resolved.status === 'not-required') return null;
  if (resolved.status === 'unavailable') {
    return plainCorrectLayerPart(
      'unknown',
      `Source BAR registered test files are unknown for ${clauseIdentity(clause)}: ${resolved.reason}.`,
      'Resolve the exact pinned source rubric revision and BAR identity before grading this clause.',
    );
  }

  const requiredFiles = [...new Set(resolved.files.map((file) => file.trim()).filter(Boolean))].sort();
  if (requiredFiles.length === 0) {
    return plainCorrectLayerPart(
      'unknown',
      `The pinned source BAR test-file list is empty for ${clauseIdentity(clause)}.`,
      'Repair the source BAR check.files list before grading this clause.',
    );
  }

  // A source BAR may explicitly require shared named cases. Credit those only
  // for suite coverage; clause path, targeting and mutation raters remain strict.
  const selectorsForFile = (file: string) => (resolved.cases ?? []).filter((selector) => selector.file === file);
  const declaresSelector = (row: SpecEvidenceForAdequacy, testName: string) =>
    hasMatchingDeclaredCaseTitle(testName, detailsOf(row).testCases ?? []);
  const relevantEvidence = evidence.filter((row) => {
    if (!bindingHasOnlyMismatchedClauseCases(row, clause)) return true;
    const measuredPath = row.testRunProvenance?.filePath ?? row.testRunExecution?.filePath;
    return typeof measuredPath === 'string' && requiredFiles.some((file) =>
      testFilePathMatches(file, measuredPath) && selectorsForFile(file).some(({ testName }) => declaresSelector(row, testName)),
    );
  });

  const rowsByFile = new Map<string, SpecEvidenceForAdequacy[]>();
  const ambiguousFiles = new Set<string>();
  for (const row of relevantEvidence) {
    if (row.evidenceKind !== 'test') continue;
    const measuredPath = row.testRunProvenance?.filePath ?? row.testRunExecution?.filePath;
    if (typeof measuredPath !== 'string' || measuredPath.trim().length === 0) continue;
    const matches = requiredFiles.filter((file) => testFilePathMatches(file, measuredPath));
    if (matches.length > 1) {
      for (const file of matches) ambiguousFiles.add(file);
      continue;
    }
    if (matches.length !== 1) continue;
    const rows = rowsByFile.get(matches[0]!) ?? [];
    rows.push(row);
    rowsByFile.set(matches[0]!, rows);
  }

  const failed: Array<{ file: string; rows: SpecEvidenceForAdequacy[] }> = [];
  const missing: string[] = [];
  const uncertain: string[] = [];
  const citedRows: SpecEvidenceForAdequacy[] = [];
  for (const file of requiredFiles) {
    const rows = distinctTestRunRows(rowsByFile.get(file) ?? []);
    const currentRows = rows.filter((row) => row.currentness.overall === 'current');
    const failedRows = currentRows.filter(
      (row) => row.testRunId !== null && measuredExecutionVerdict(row) === 'fail',
    );
    if (failedRows.length > 0) {
      failed.push({ file, rows: failedRows });
      citedRows.push(...failedRows);
      continue;
    }
    const passingRows = currentRows.filter(isSuccessfulExecutableEvidence);
    const selectorsPassed = selectorsForFile(file).every(({ testName }) => passingRows.some((row) =>
      declaresSelector(row, testName) && hasPassingLedgerCase(row, testName),
    ));
    if (passingRows.length > 0 && selectorsPassed && !ambiguousFiles.has(file)) {
      citedRows.push(...passingRows);
      continue;
    }
    if (rows.length === 0) missing.push(file);
    else uncertain.push(file);
    citedRows.push(...rows);
  }

  if (failed.length > 0) {
    return boundCorrectLayerPart(
      'fail',
      `Current source BAR suite run(s) fail for ${clauseIdentity(clause)}: ${failed.map(({ file }) => file).join(', ')}.`,
      distinctTestRunRows(citedRows),
      'Re-run each failing registered source BAR file against the current source and bind its measured passing result.',
    );
  }
  if (missing.length > 0 || uncertain.length > 0 || ambiguousFiles.size > 0) {
    const unresolved = [...new Set([
      ...missing,
      ...uncertain,
      ...[...ambiguousFiles].map((file) => `${file} (ambiguous measured path)`),
    ])].sort();
    return boundCorrectLayerPart(
      'unknown',
      `Current passing bindings are not established for every registered source BAR file and required named case for ${clauseIdentity(clause)}: ${unresolved.join(', ')}.`,
      distinctTestRunRows(citedRows),
      'Bind a current, ledger-backed passing test result for every registered source BAR file and named selector; missing, stale, unexecuted cases and ambiguous paths remain unknown.',
    );
  }
  return boundCorrectLayerPart(
    'pass',
    `Every registered source BAR test file has a current passing binding for ${clauseIdentity(clause)}: ${requiredFiles.join(', ')}.`,
    distinctTestRunRows(citedRows),
  );
}

function booleanRating(
  evidence: SpecEvidenceForAdequacy[],
  pick: (details: AdequacyDetails) => boolean | undefined,
  labels: { pass: string; fail: string; unknown: string },
): AdequacyRatingEntry {
  const evaluated = evidence
    .map((row) => ({ row, value: pick(detailsOf(row)) }))
    .filter((entry): entry is { row: SpecEvidenceForAdequacy; value: boolean } => entry.value !== undefined);
  const inspected = evaluated.length > 0 ? evaluated.map(({ row }) => row) : evidence;
  const passing = evaluated.filter(({ value }) => value).map(({ row }) => row);
  const failing = evaluated.filter(({ value }) => !value).map(({ row }) => row);
  if (passing.length > 0) return { rating: 'pass', evidence: evidenceWithBindings(labels.pass, passing) };
  if (failing.length > 0) return { rating: 'fail', evidence: evidenceWithBindings(labels.fail, failing) };
  return { rating: 'unknown', evidence: evidenceWithBindings(labels.unknown, inspected) };
}

function l4WaiverOf(exemption: Record<string, unknown> | null, now: Date): L4Waiver | null {
  const root = exemption?.testAdequacyWaivers;
  const raw = root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>).l4 : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const waiver = raw as Record<string, unknown>;
  if (typeof waiver.justification !== 'string' || waiver.justification.trim().length < 12) return null;
  if (typeof waiver.approvalRef !== 'string' || waiver.approvalRef.trim().length === 0) return null;
  if (waiver.expiresAt !== undefined) {
    if (typeof waiver.expiresAt !== 'string') return null;
    const expiry = new Date(waiver.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) return null;
  }
  return {
    justification: waiver.justification.trim(),
    approvalRef: waiver.approvalRef.trim(),
    ...(typeof waiver.expiresAt === 'string' ? { expiresAt: waiver.expiresAt } : {}),
  };
}

export function requiredProofFloor(
  clause: SpecClauseRevision,
  classRef: PlanClassRubricRef,
  workItemKind?: string | null,
): 'none' | 'l3' | 'l4' {
  // The task-kind and non-automated-clause exemptions are decided by the verification
  // resolver (plan-verification-profile.ts), in the same order as before.
  if (executableProofExemption({
    workItemKind,
    behaviorClass: clause.behaviorClass,
    requiredTestLayers: clause.requiredTestLayers,
  })) return 'none';
  if (classRef === 'plan-class-migration' || classRef === 'plan-class-bugfix') return 'l4';
  if (clause.mutationRequired || HIGH_RISK_BEHAVIOR_CLASSES.has(clause.behaviorClass)) return 'l4';
  if (classRef === 'plan-class-investigation' && clause.requiredTestLayers.length === 0) return 'none';
  return 'l3';
}

function riskFloorRating(
  clause: SpecClauseRevision,
  classRef: PlanClassRubricRef,
  evidence: SpecEvidenceForAdequacy[],
  now: Date,
  harness?: string,
  workItemKind?: string | null,
): { floor: 'none' | 'l3' | 'l4'; rating: AdequacyRatingEntry } {
  const floor = requiredProofFloor(clause, classRef, workItemKind);
  if (floor === 'none') {
    return {
      floor,
      rating: {
        rating: 'not-applicable',
        evidence: `Clause ${clauseIdentity(clause)} is non-automated and declares no required test layer. ${clauseProbe(clause, harness)}`,
      },
    };
  }
  const detailRows = evidence.map((row) => ({ row, details: detailsOf(row) }));
  const isMutation = (row: SpecEvidenceForAdequacy) =>
    row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample';
  const isCoverageCensusProof = (row: SpecEvidenceForAdequacy) =>
    row.evidenceKind === 'coverage-census' && row.coverageEvidenceRef !== null;
  const hasCoverageRung = (
    { row, details }: (typeof detailRows)[number],
    rung: 'l3' | 'l4',
  ): boolean =>
    isCoverageCensusProof(row) &&
    details.coverageRungs?.[rung] === true &&
    bindingTargetsClause(row, clause);
  const coverageRowsWithoutExactTarget = (rung: 'l3' | 'l4') => detailRows
    .filter(({ row, details }) =>
      isCoverageCensusProof(row) &&
      details.coverageRungs?.[rung] !== undefined &&
      bindingIdentityMatchesClause(row, clause) &&
      !bindingTargetsClause(row, clause),
    )
    .map(({ row }) => row);
  const hasClauseBoundMutationProof = (row: SpecEvidenceForAdequacy) =>
    isClauseBoundMutationProof(clause, row, evidence);
  const isL4Proof = ({ row, details }: (typeof detailRows)[number]): boolean =>
    isMutation(row) ? hasClauseBoundMutationProof(row) : hasCoverageRung({ row, details }, 'l4');
  const l4ProofRows = detailRows.filter(isL4Proof);
  const isL3Proof = ({ row, details }: (typeof detailRows)[number]): boolean =>
    isL4Proof({ row, details }) ||
    hasCoverageRung({ row, details }, 'l3');
  const meetsL3 = detailRows.some(isL3Proof);
  const meetsL3Rows = detailRows.filter(isL3Proof);
  const proofBindings = (rows: typeof detailRows) =>
    [...new Set(rows.flatMap(({ row }) => {
      const pairedTest = isMutation(row) ? clauseBoundMutationTest(clause, row, evidence) : null;
      return pairedTest ? [row, pairedTest] : [row];
    }))];
  if (floor === 'l4') {
    if (l4ProofRows.length > 0) {
      const proofBasis = [
        l4ProofRows.some(({ row, details }) => hasCoverageRung({ row, details }, 'l4'))
          ? 'targeted L4 coverage-census evidence'
          : null,
        l4ProofRows.some(({ row }) => isMutation(row) && hasClauseBoundMutationProof(row))
          ? 'clause-bound mutation/counterexample evidence with a passing baseline case'
          : null,
      ].filter((entry): entry is string => entry !== null).join(' and ');
      return {
        floor,
        rating: {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `The ${clauseIdentity(clause)} L4 risk floor is met via ${proofBasis}.`,
            proofBindings(l4ProofRows),
          ),
        },
      };
    }
    const waiver = l4WaiverOf(clause.exemption, now);
    if (waiver) {
      return {
        floor,
        rating: {
          rating: 'waived',
          evidence:
            `L4 for ${clauseIdentity(clause)} is explicitly waived by approvalRef=${waiver.approvalRef}: ` +
            `${waiver.justification}${waiver.expiresAt ? ` (expires ${waiver.expiresAt})` : ''}. ${clauseProbe(clause, harness)}`,
        },
      };
    }
    const hasExplicitL4Miss = detailRows.some(
      ({ row, details }) =>
        isCoverageCensusProof(row) && details.coverageRungs?.l4 === false && bindingTargetsClause(row, clause),
    );
    const untargetedL4Rows = coverageRowsWithoutExactTarget('l4');
    return {
      floor,
      rating: {
        rating: hasExplicitL4Miss ? 'fail' : 'unknown',
        evidence: hasExplicitL4Miss
          ? evidenceWithBindings(
              `Bound coverage explicitly reports L4=false for ${clauseIdentity(clause)} and no current approved waiver exists.`,
              detailRows
                .filter(({ row, details }) => isCoverageCensusProof(row) && details.coverageRungs?.l4 === false)
                .map(({ row }) => row),
            )
          : untargetedL4Rows.length > 0
            ? evidenceWithBindings(
                `L4 coverage is present, but its binding target does not identify the exact clause ${clauseIdentity(clause)}.`,
                untargetedL4Rows,
              )
            : `${evidenceWithBindings(
                `No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for ${clauseIdentity(clause)}.`,
                evidence,
              )} ${clauseProbe(clause, harness)}`,
        suggestion:
          untargetedL4Rows.length > 0
            ? `Bind L4 coverage to ${clause.planSlug}/${clause.planItemId}/${clause.specId}@${clause.revision} with adequacy.targeted=${JSON.stringify(clause.specId)}.`
            : 'Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision.',
      },
    };
  }
  const hasExplicitL3Miss = detailRows.some(
    ({ row, details }) =>
      isCoverageCensusProof(row) && details.coverageRungs?.l3 === false && bindingTargetsClause(row, clause),
  );
  const untargetedL3Rows = coverageRowsWithoutExactTarget('l3');
  return {
    floor,
    rating: meetsL3
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            `Targeted L3 or stronger proof meets the ${clauseIdentity(clause)} floor.`,
            proofBindings(meetsL3Rows),
          ),
        }
      : {
          rating: hasExplicitL3Miss ? 'fail' : 'unknown',
          evidence: hasExplicitL3Miss
            ? evidenceWithBindings(
                `Bound coverage explicitly reports L3=false for ${clauseIdentity(clause)}.`,
                detailRows
                  .filter(({ row, details }) => isCoverageCensusProof(row) && details.coverageRungs?.l3 === false)
                  .map(({ row }) => row),
              )
          : untargetedL3Rows.length > 0
            ? evidenceWithBindings(
                `L3 coverage is present, but its binding target does not identify the exact clause ${clauseIdentity(clause)}.`,
                untargetedL3Rows,
              )
            : `${evidenceWithBindings(
                `No explicit meets_l3 result is bound for ${clauseIdentity(clause)}; depth or a generic passing test is not a rung verdict.`,
                evidence,
              )} ${clauseProbe(clause, harness)}`,
          suggestion:
            untargetedL3Rows.length > 0
              ? `Bind L3 coverage to ${clause.planSlug}/${clause.planItemId}/${clause.specId}@${clause.revision} with adequacy.targeted=${JSON.stringify(clause.specId)}.`
              : 'Bind a current coverage-census row whose independent meets_l3 flag and adequacy.targeted identify this exact clause.',
        },
  };
}

/**
 * Return the stable subject reference used by every spec-test-adequacy surface.
 * Keep the truncation deterministic so the write boundary and completion gate
 * cannot disagree about a long plan/spec identifier.
 */
export function specTestAdequacySubjectRef(planSlug: string, specId: string, revision: number): string {
  const exact = `${planSlug}#${specId}@${revision}`;
  return exact.length <= 200 ? exact : `${planSlug.slice(0, 120)}#${specId.slice(0, 60)}@${revision}`;
}

function rerunRecipeFor(
  clause: SpecClauseRevision,
  evidence: SpecEvidenceForAdequacy[],
  current: EvidenceCurrentInput[] | undefined,
  harness: string | undefined,
  classRef: PlanClassRubricRef,
  selection: { workItemIds?: string[]; evidenceRefs?: string[]; bindingIds?: number[]; planItemIds?: string[] } | undefined,
  loadedClauseRows: number,
): SpecTestAdequacyRerunRecipe {
  const evaluatorBuild = getBuildInfo();
  const selectedEvidence = [
    ...new Map(
      evidence.map((row) => [
        evidenceCurrentInputKey(row),
        {
          evidenceKind: row.evidenceKind,
          evidenceRef: row.evidenceRef,
        },
      ]),
    ).values(),
  ].sort((a, b) => `${a.evidenceKind}\0${a.evidenceRef}`.localeCompare(`${b.evidenceKind}\0${b.evidenceRef}`));
  const selectedEvidenceRefs = [...new Set(selectedEvidence.map((row) => row.evidenceRef))].sort((a, b) =>
    a.localeCompare(b),
  );
  // Preserve an explicit caller selector even when the in-memory evidence rows
  // are empty for this clause (for example, an uncovered or legacy binding).
  // Omitting it would widen the persisted recipe into an unfiltered replay.
  const replayEvidenceRefs =
    selectedEvidenceRefs.length > 0
      ? selectedEvidenceRefs
      : [...new Set(selection?.evidenceRefs ?? [])].sort((a, b) => a.localeCompare(b));
  const replayBindingIds =
    evidence.length > 0 && evidence.every((row) => Number.isSafeInteger(row.id) && row.id! > 0)
      ? [
          ...new Set(
            evidence.flatMap((row) => [
              ...(row.supportingBindingIds ?? [row.id!]),
              // A certified fixture-free proof cites an independent verifier that
              // may not be in the selected evidence cohort. Keep that verifier in
              // the replay population or the reader cannot reconstruct the
              // certificate and fixture-calibration degrades from N/A to unknown.
              ...(row.fixtureAbsenceVerification?.verifierBindingIds ?? []),
            ]),
          ),
        ].sort((a, b) => a - b)
      : selection?.bindingIds !== undefined
        ? [...new Set(selection.bindingIds)].sort((a, b) => a - b)
        // An empty graded population is still an exact selection. Leaving the selector
        // omitted would let a later binding silently enter this scorecard's rerun.
        : evidence.length === 0
          ? []
          : undefined;
  const currentByKey = new Map((current ?? []).map((row) => [evidenceCurrentInputKey(row), row]));
  const currentForEvidence = (row: SpecEvidenceForAdequacy): EvidenceCurrentInput | undefined => {
    const scopedCurrentKey = evidenceCurrentInputKey({
      planSlug: row.planSlug,
      specId: row.specId,
      specRevision: row.specRevision,
      specFingerprint: row.specFingerprint,
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
    });
    const legacyCurrentKey = evidenceCurrentInputKey({
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
    });
    return currentByKey.get(scopedCurrentKey) ?? currentByKey.get(legacyCurrentKey);
  };
  const fingerprints: SpecTestAdequacyCurrentFingerprint[] = [
    ...new Map(
      evidence
        .map(currentForEvidence)
        .filter((row): row is EvidenceCurrentInput => row !== undefined)
        .map((row) => [evidenceCurrentInputKey(row), row] as const),
    ).values(),
  ]
    .map((row) => ({
      ...(row.planSlug !== undefined &&
      row.specId !== undefined &&
      row.specRevision !== undefined &&
      row.specFingerprint !== undefined
        ? {
            planSlug: row.planSlug,
            specId: row.specId,
            specRevision: row.specRevision,
            specFingerprint: row.specFingerprint,
          }
        : {}),
      evidenceKind: row.evidenceKind,
      evidenceRef: row.evidenceRef,
      sourceFingerprint: row.sourceFingerprint,
      testFingerprint: row.testFingerprint ?? null,
      fixtureFingerprint: row.fixtureFingerprint ?? null,
      rubricFingerprint: row.rubricFingerprint ?? null,
      environmentFingerprint: row.environmentFingerprint ?? null,
    }))
    .sort((a, b) => evidenceCurrentInputKey(a).localeCompare(evidenceCurrentInputKey(b)));
  return {
    schemaVersion: 1,
    evaluator: 'plans:evaluate-spec-test-adequacy',
    evaluatorBuild: {
      sha: evaluatorBuild.sha,
      version: evaluatorBuild.version,
    },
    evaluatorRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION,
    classRef,
    // Submittable as-is. `selection` below spells planSlug/specId/specRevision/
    // specFingerprint, none of which the evaluator accepts — it takes slug/specIds and
    // REQUIRES classRef. Emitting only `selection` made every card's rerun recipe fail
    // its own evaluator with `invalid_args`, leaving a re-runner to guess classRef and
    // silently move plan-class-risk-floor.
    args: {
      ...(harness !== undefined ? { harness } : {}),
      slug: clause.planSlug,
      classRef,
      evaluatorBuild: {
        sha: evaluatorBuild.sha,
        version: evaluatorBuild.version,
      },
      specIds: [clause.specId],
      ...(selection?.workItemIds?.length ? { workItemIds: [...selection.workItemIds] } : {}),
      // The recipe must replay the exact evidence population the evaluator graded,
      // even when the caller selected it indirectly through a work item or plan
      // item. Reusing only the caller's optional evidenceRefs would let later
      // bindings silently widen a persisted scorecard's replay.
      ...(replayEvidenceRefs.length ? { evidenceRefs: replayEvidenceRefs } : {}),
      ...(replayBindingIds !== undefined ? { bindingIds: replayBindingIds } : {}),
      ...(selection?.planItemIds?.length ? { planItemIds: [...selection.planItemIds] } : {}),
      includeDraft: true,
      limit: specTestAdequacyReplayLimit(Math.max(loadedClauseRows, evidence.length, replayBindingIds?.length ?? 0)),
      // Replay the exact immutable clause snapshot that produced this grade. The pin
      // fixes WHICH clause revision is graded; it does not freeze freshness — the
      // server re-measures each binding's persisted recipe, so this card replays
      // 'pass' only while the proven code is unchanged (WI-10002320).
      specRevision: clause.revision,
      specFingerprint: clause.contentHash,
      replaySnapshot: true,
      // Fingerprints classify the selected bindings; the selectors above define
      // the population. Keeping those roles separate prevents a partial current[]
      // input from silently excluding an unmeasured historical binding.
      ...(current !== undefined ? { current: fingerprints } : {}),
    },
    selection: {
      planSlug: clause.planSlug,
      specId: clause.specId,
      specRevision: clause.revision,
      specFingerprint: clause.contentHash,
      evidence: selectedEvidence,
      ...(replayBindingIds !== undefined ? { bindingIds: replayBindingIds } : {}),
    },
    current: {
      supplied: current !== undefined,
      fingerprints,
    },
    derivation: {
      kind: 'listSpecEvidence.currentness',
      classifier: 'classifySpecEvidenceCurrentness',
      unknownWhenMissing: true,
    },
  };
}

export function crossGenerationAuditProbeArgs(rerunRecipe: SpecTestAdequacyRerunRecipe) {
  // Keep this named export for persisted/test callers, but the criterion-local
  // probe must be the SAME immutable replay as the card-level recipe. A reduced
  // compatibility subset silently widens an exact evidenceRefs selection to
  // historical bindings; a non-author can then execute the stated probe and get
  // ratings that contradict the card even though the persisted recipe passes.
  // An older evaluator that cannot parse this contract is an explicit generation
  // mismatch, not permission to substitute a different evidence population.
  return { ...rerunRecipe.args };
}

function ratingRerunProbeText(
  criterion: AdequacyCriterion,
  rerunRecipe: SpecTestAdequacyRerunRecipe,
): string {
  return (
    `Replay the shared scorecard rerunRecipe (${rerunRecipe.evaluator}) once with its stored args; ` +
    `inspect rows[0].ratings[${JSON.stringify(criterion)}] against the current evidence state. ` +
    'This replay remeasures currentness at replay time, so freshness-dependent ratings may differ from the emitted card after evidence changes. ' +
    'It is not a historical as-of replay; grading-integrity audits reconstruct the emitted card using its creation-time snapshot.'
  );
}

function ratingRerunProbeReference(
  criterion: AdequacyCriterion,
  rerunRecipe: SpecTestAdequacyRerunRecipe,
): string {
  // A shared recipe alone is not an executable criterion-local probe. Reuse the
  // judge-readable evidence instrument with the SAME immutable row selectors,
  // rather than repeating the large replay fingerprint payload in every rating.
  const { harness, slug, specIds, bindingIds, evidenceRefs } = rerunRecipe.args;
  const args = {
    ...(harness !== undefined ? { harness } : {}),
    slug,
    specIds,
    ...(bindingIds !== undefined
      ? { bindingIds, ...(bindingIds.length > 0 ? { includeRetracted: true } : {}) }
      : { evidenceRefs }),
    detail: 'full',
    limit: 1_000,
  };
  return (
    `Evidence probe: plans:get-spec-evidence ${JSON.stringify(args)}. ` +
    `Inspect evidence[] at specRevision=${rerunRecipe.selection.specRevision}, ` +
    `specFingerprint=${JSON.stringify(rerunRecipe.selection.specFingerprint)}; ` +
    'compare details, fingerprints, currentness, testRunExecution and testRunProvenance with this criterion\'s claim. ' +
    'Require bounded.truncatedByLimit=false before treating the read as complete. ' +
    `Replay result: rows[0].ratings[${JSON.stringify(criterion)}] via rerunRecipe.`
  );
}

function appendRatingRerunProbes(
  ratings: Record<AdequacyCriterion, AdequacyRatingEntry>,
  rerunRecipe: SpecTestAdequacyRerunRecipe,
): void {
  for (const criterion of ADEQUACY_CRITERIA) {
    const rating = ratings[criterion];
    ratings[criterion] = {
      ...rating,
      evidence: `${rating.evidence} ${ratingRerunProbeText(criterion, rerunRecipe)}`,
    };
  }
}

/**
 * P-043 (review-system-rework-reduction-2026-09-23): the evaluator RULE revision stamped on
 * every adequacy card's rerun recipe. BUMP IT whenever a change here can alter a criterion
 * verdict for unchanged evidence (a new/tightened rule, a moved threshold) — not for prose,
 * refactors or new diagnostics. `evaluatorBuild` cannot serve: it moves on every deploy.
 *   1 — cards minted before the stamp existed (absent field reads as 1).
 *   2 — the a49fca9b96 scenario-scoped falsifiability target + the WI-10002724 own-specId
 *       fallback (D-009), which the stamp was introduced alongside.
 *   3 — correct-layer requires the declared live/deployed evidence plane on a current binding.
 *   4 — a mutation/counterexample target must be corroborated by successful current test evidence
 *       for its canonical test file on the same clause revision.
 *   5 — a mutation's measured failed case must exactly appear in that test binding's adequacy.testCases.
 *   6 — canonical test-run status/counts and exact passed-case identities corroborate positive binder claims;
 *       correct-layer reads the runtime-measured layer and rejects a contradictory binder layer.
 *   7 — a null fixture fingerprint no longer proves fixture-free evidence; executable bindings must
 *       explicitly attest fixtureFree=true before fixture calibration is not-applicable.
 *   8 — pair Cargo case receipts by canonical source and measurement root, preserving exact case checks.
 *   9 — recognize canonical operational adapter layers without extending recorded runner layers.
 *  10 — map legacy behavioral requirements only to passing canonical operational case evidence.
 *  11 — require each executable binding to attest fixture-free status or carry fingerprinted calibration.
 *  12 — corroborate live LLM reachability with exact canonical scenario, framework and executed-file receipts.
 *  13 — an ordinary passing test run rebound as a counterexample no longer establishes falsifiability.
 *  14 — risk-floor rung metadata is accepted only from a current clause-bound coverage census or clause-bound mutation proof.
 *  15 — structured observations.scope/proofScope/notes disclosures are extracted and block a machine PASS.
 *  16 — explicit scopeNote coverage gaps are extracted too, including same-proof rebinds.
 *  17 — technical coverage result/field mechanics do not imply incomplete proof; genuine gaps still block.
 *  18 — map legacy manual-provenance requirements only to canonical measured operational cases.
 *  19 — pending clause/composite proof and unresolved disclosure scope notes block a machine PASS.
 *  20 — disclosure-bearing metadata is scanned recursively, preserving gaps moved outside scopeNote.
 *  21 — passing selected scopes tolerate unrelated skips only when every declared case canonically passed.
 *  22 — qualified test nouns in input inventories do not imply a coverage limitation.
 *  23 — descriptor-bearing catches require invocation-linked calibration and named failures;
 *       grader evidence exposes the descriptor, linkage and ledger-only re-aim coverage.
 *  24 — technical compound modifiers do not turn negative-control observations into proof gaps.
 *  25 — execution verdicts reconcile explicit nested and structured test-run IDs/files to the joined ledger row.
 *  26 — shared mutant runs preserve distinct targets and require a measured case for each target.
 *  28 — binder-authored fixtureFree=true no longer establishes fixture absence for test-backed evidence without a fixture fingerprint.
 *  29 — outside-lineage re-observations can establish fixture absence for the same measured executable proof and selected cases.
 *  30 — shared mutation metadata stays target-scoped; unambiguous explicit measured-case associations need no title convention.
 *  31 — a requiredEvidence:'tree' declaration requires a current tree-plane binding; binder-authored targeting cannot substitute for it.
 *  33 — nested adequacy planes participate in required-plane checks, attempt identity, traceability and runtime freshness.
 *  34 — durable test-run references in resolved-gap notes do not imply a live limitation.
 *  35 — late automatic same/older receipts cannot hide the latest explicit proof correction.
 *  36 — explicitly registered source BAR named cases can establish shared suite coverage only.
 */
export const SPEC_TEST_ADEQUACY_EVALUATOR_REVISION = 36;

/**
 * EI-25889625242363568: a null fixture fingerprint proves nothing by itself.
 * Reuse the independently authored, source-pinned re-observation of the SAME
 * executable proof to establish fixture absence. Lineage is resolved by the
 * server; metadata written by the implementer alone remains insufficient.
 */
export async function resolveFixtureAbsenceVerifications(
  rows: readonly SpecEvidenceForAdequacy[],
  isIndependent: (reviewer: string, citedAuthor: string, planSlug: string) => Promise<boolean>,
): Promise<Map<number, number[]>> {
  const verified = new Map<number, number[]>();
  const measured = (row: SpecEvidenceForAdequacy) =>
    row.currentness?.overall === 'current' && row.currentness.provenance === 'server-measured';
  for (const review of rows) {
    if (review.evidenceKind !== 'independent-verification' || !review.id ||
        !review.verifiesBindingId || !review.createdBy || !measured(review) ||
        detailsOf(review).fixtureFree !== true) continue;
    const cited = rows.find(row => row.id === review.verifiesBindingId);
    if (!cited?.id || !cited.createdBy || cited.createdBy === review.createdBy ||
        !EXECUTABLE_EVIDENCE_KINDS.has(cited.evidenceKind) || !measured(cited) ||
        detailsOf(cited).fixtureFree !== true ||
        cited.planSlug !== review.planSlug || cited.specId !== review.specId ||
        cited.specRevision !== review.specRevision || cited.specFingerprint !== review.specFingerprint ||
        !cited.testRunId || cited.testRunId !== review.testRunId ||
        !cited.fingerprints.testFingerprint ||
        cited.fingerprints.sourceFingerprint !== review.fingerprints.sourceFingerprint ||
        cited.fingerprints.testFingerprint !== review.fingerprints.testFingerprint ||
        cited.fingerprints.environmentFingerprint !== review.fingerprints.environmentFingerprint ||
        cited.fingerprints.fixtureFingerprint !== null || review.fingerprints.fixtureFingerprint !== null) continue;
    const cases = detailsOf(cited).testCases ?? [];
    const reviewedCases = new Set(detailsOf(review).testCases ?? []);
    if (cases.length === 0 || cases.some(title => !reviewedCases.has(title))) continue;
    try {
      if (!(await isIndependent(review.createdBy, cited.createdBy, cited.planSlug))) continue;
    } catch {
      // An unreadable lineage is uncertainty, never proof of independence.
      continue;
    }
    verified.set(cited.id, [...(verified.get(cited.id) ?? []), review.id]);
  }
  return verified;
}

type MutationTargetClause = Pick<SpecClauseRevision, 'specId' | 'falsifier'>;

/**
 * The falsifiability TARGETING rule, shared by the evaluator and plans:bind-spec-evidence so a
 * binding the evaluator will reject is refused at bind (P-043) rather than discovered after its
 * audit passed. A clause that declares falsifier.requiredScenarios accepts only those scenario
 * ids. WI-10002724 / D-009: a clause that declares NONE has no scenario id to name, so under the
 * scenario-only rule its falsifiability could never pass (4,026 of 4,136 active clauses on
 * 2026-09-23); the clause itself is the case, so a target naming its own specId qualifies.
 * Keep the clause's exact ID (platform-generated IDs can be uppercase) and accept the historical
 * lowercase form for compatibility. Scenario targets remain exact and case-sensitive. A boolean
 * target, or one naming a sibling spec or scenario, never qualifies.
 */
export function mutationTargetRequirement(clause: MutationTargetClause): {
  acceptedTargets: string[];
  selfTarget: string | null;
  requirement: string;
} {
  const scenarios = [...new Set(clause.falsifier?.requiredScenarios ?? [])];
  const selfTarget = scenarios.length === 0 ? clause.specId : null;
  const acceptedSelfTargets = selfTarget === null ? scenarios : clauseSelfTargetIds(clause);
  return {
    acceptedTargets: acceptedSelfTargets,
    selfTarget,
    requirement:
      selfTarget !== null
        ? `this clause's own specId (adequacy.targeted = '${selfTarget}'; it declares no falsifier.requiredScenarios)`
        : "a scenario id in this clause's falsifier.requiredScenarios",
  };
}

export function isAcceptedMutationTarget(clause: MutationTargetClause, targeted: unknown): boolean {
  return typeof targeted === 'string' && mutationTargetRequirement(clause).acceptedTargets.includes(targeted);
}

/**
 * `adequacy.targeted` is caller-authored metadata. A mutation probe is clause-scoped only when
 * its canonical test file also has successful, current test evidence bound to the same immutable
 * clause revision. This prevents a killed mutant from a sibling clause's test suite from
 * satisfying falsifiability or the proof floor by naming this clause in its own binding.
 */
function clauseBoundCurrentTest(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): SpecEvidenceForAdequacy | null {
  return clauseBoundCurrentTests(clause, mutation, evidence)[0] ?? null;
}

/** Cargo's case identity is not a file. Legacy crate receipts resolve only through the
 * persisted, server-measured single test source inside that crate. Include the checkout root
 * so equal relative paths in independently registered checkouts cannot corroborate each other. */
function canonicalTestSourceKey(row: SpecEvidenceForAdequacy): string | null {
  const recorded = row.testRunProvenance?.filePath;
  if (!recorded?.trim()) return null;
  const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
  const root = measurement.success ? measurement.data.rootHarnessSlug ?? null : null;
  const at = recorded.indexOf('::');
  let filePath = recorded;
  if (at > 0) {
    const prefix = recorded.slice(0, at);
    if (prefix.endsWith('.rs')) filePath = prefix;
    else if (measurement.success && measurement.data.testPaths?.length === 1) {
      const source = measurement.data.testPaths[0];
      if (source.endsWith('.rs') && source.startsWith(`${prefix}/`)) filePath = source;
    }
  }
  return JSON.stringify([root, filePath]);
}

function clauseBoundCurrentTests(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): SpecEvidenceForAdequacy[] {
  const sourceKey = canonicalTestSourceKey(mutation);
  if (!sourceKey) return [];
  return evidence.filter(
    (row) =>
      row.evidenceKind === 'test' &&
      row.planSlug === clause.planSlug &&
      row.specId === clause.specId &&
      row.specRevision === clause.revision &&
      row.specFingerprint === clause.contentHash &&
      canonicalTestSourceKey(row) === sourceKey &&
      row.currentness.overall === 'current' &&
      !bindingHasOnlyMismatchedClauseCases(row, clause) &&
      isSuccessfulRepairedEvidence(row),
  );
}

function isWellFormedCaseTitle(title: unknown): title is string {
  if (typeof title !== 'string' || title.length === 0 || title.trim() !== title) return false;
  for (const character of title) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * True when the failed mutant run measured `caseTitle` as a failed case. The ledger reporter
 * writes one `<case full name>: <message>` line per failed case, so the declared title must be a
 * whole line prefix ending at the reporter's `: ` separator. WI-10006745: deriving one title by
 * splitting the tail on ' — ' matched no reporter output (a describe title may itself contain an
 * em dash), so every mutation binding failed this check.
 */
export function mutationMeasuredFailedCase(mutation: SpecEvidenceForAdequacy, caseTitle: unknown): boolean {
  if (!isWellFormedCaseTitle(caseTitle)) return false;
  // Preserve WI-10006753's exact-identity rule while accepting Vitest's full-title joiner spelling.
  const recordedTitles = mutation.testRunProvenance?.mutationFailedCaseTitles;
  if (recordedTitles !== undefined) {
    return recordedTitles.some((recordedTitle) => hasSameCaseTitleIdentity(caseTitle, recordedTitle));
  }
  const prefix = `${caseTitle}: `;
  return (mutation.testRunProvenance?.mutationFailureLines ?? []).some((line) => {
    if (line.startsWith(prefix)) return true;
    const separatorIndex = line.indexOf(': ');
    return separatorIndex >= 0 &&
      line.indexOf(': ', separatorIndex + 2) < 0 &&
      hasSameCaseTitleIdentity(caseTitle, line.slice(0, separatorIndex));
  });
}

/** A shared mutant run must have a measured failing case for each claimed scenario target. */
function mutationTargetMatchesMeasuredCase(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  caseTitle: string,
  evidence: readonly SpecEvidenceForAdequacy[],
): boolean {
  const target = detailsOf(mutation).targeted;
  if (typeof target !== 'string') return false;
  const sameRun = (row: SpecEvidenceForAdequacy) =>
    (row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') &&
    row.testRunId === mutation.testRunId &&
    row.evidenceRef === mutation.evidenceRef;
  const targetRequirement = mutationTargetRequirement(clause);
  // Exact and historical lowercase self-clause IDs name one target. Scenario
  // IDs remain case-sensitive, so distinct scenarios need distinct failed cases.
  const normalizedTarget = (value: string) =>
    targetRequirement.selfTarget !== null && targetRequirement.acceptedTargets.includes(value)
      ? targetRequirement.selfTarget
      : value;
  const sameRunRows = evidence.filter(sameRun);
  const targetsOnRun = new Set(sameRunRows
    .map((row) => detailsOf(row).targeted)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalizedTarget));
  if (targetsOnRun.size <= 1) return true;

  const declaredCases = detailsOf(mutation).testCases;
  if (declaredCases !== undefined) {
    if (!declaredCases.some((title) => hasSameCaseTitleIdentity(title, caseTitle))) return false;
    // Ambiguous explicit associations fail closed, including titles that would
    // otherwise match the legacy colon convention below.
    return !sameRunRows.some((row) => {
      const details = detailsOf(row);
      return typeof details.targeted === 'string' && normalizedTarget(details.targeted) !== normalizedTarget(target) &&
        (details.testCases ?? []).some((title) => hasSameCaseTitleIdentity(title, caseTitle));
    });
  }

  const separator = caseTitle.lastIndexOf(' > ');
  const scenarioCase = separator >= 0 ? caseTitle.slice(separator + 3) : caseTitle;
  const labelEnd = scenarioCase.indexOf(': ');
  const measuredScenario = labelEnd >= 0 ? scenarioCase.slice(0, labelEnd).trim() : '';
  return measuredScenario.length > 0 &&
    (clause.falsifier?.requiredScenarios ?? []).includes(measuredScenario) &&
    measuredScenario === target;
}

function summarizeMutationFailedCaseTitles(mutations: readonly SpecEvidenceForAdequacy[]): string {
  const lines = mutations
    .flatMap((mutation) => mutation.testRunProvenance?.mutationFailureLines ?? [])
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));
  const distinctLines = [...new Set(lines)].sort((a, b) => a.localeCompare(b)).slice(0, 5);
  return distinctLines.length > 0
    ? `Measured failing case line(s), reporter format "<case full name>: <message>" — declare the part before ": " exactly: ${distinctLines.map((line) => JSON.stringify(line)).join(', ')}.`
    : 'No measured failing case line is available for the mutation run.';
}

function clauseBoundMutationTest(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): SpecEvidenceForAdequacy | null {
  if (mutation.evidenceKind !== 'mutation' && mutation.evidenceKind !== 'counterexample') {
    return clauseBoundCurrentTest(clause, mutation, evidence);
  }
  // Any successful current same-clause same-file test binding may carry the exact measured case.
  // Checking only the first row let an older binding without testCases shadow a newer match.
  return clauseBoundCurrentTests(clause, mutation, evidence).find((testBinding) =>
    (detailsOf(testBinding).testCases ?? []).some((caseTitle) =>
      mutationMeasuredFailedCase(mutation, caseTitle) &&
      mutationTargetMatchesMeasuredCase(clause, mutation, caseTitle, evidence) &&
      hasPassingTestBaselineCase(testBinding, caseTitle),
    ),
  ) ?? null;
}

function isClauseBoundMutationTest(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): boolean {
  return clauseBoundMutationTest(clause, mutation, evidence) !== null;
}

function isClauseBoundMutationProof(
  clause: SpecClauseRevision,
  mutation: SpecEvidenceForAdequacy,
  evidence: readonly SpecEvidenceForAdequacy[],
): boolean {
  return isSuccessfulExecutableEvidence(mutation) &&
    isAcceptedMutationTarget(clause, detailsOf(mutation).targeted) &&
    isClauseBoundMutationTest(clause, mutation, evidence);
}

export type AdequacyCardRevisionDisposition = {
  recordedRevision: number;
  currentRevision: number;
  /**
   * current  — graded under the current rule revision and every verdict still matches.
   * carried  — graded under an OLDER rule revision, re-evaluated from the stored runs, and
   *            every verdict is unchanged: the card and its settled audit stay valid.
   * verdict-changed — at least one criterion verdict differs; only this needs a new card
   *            and a new audit.
   */
  state: 'current' | 'carried' | 'verdict-changed';
  changed: Array<{ criterion: string; recorded: string | null; current: string | null }>;
};

/**
 * P-043: decide whether a stored adequacy card survives re-evaluation under the live rule.
 * Pure: the caller supplies the live ratings recomputed from the card's stored bindings. The
 * verdict comparison is per criterion and exact, so the rule is never lowered — a card only
 * carries when EVERY live verdict equals the recorded one.
 */
export function adequacyCardRevisionDisposition(input: {
  recordedRevision: number | undefined;
  recordedRatings: Record<string, unknown>;
  liveRatings: Record<string, { rating: string }>;
  currentRevision?: number;
}): AdequacyCardRevisionDisposition {
  const recordedRevision = input.recordedRevision ?? 1;
  const currentRevision = input.currentRevision ?? SPEC_TEST_ADEQUACY_EVALUATOR_REVISION;
  const ratingOf = (value: unknown): string | null =>
    value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { rating?: unknown }).rating === 'string'
      ? (value as { rating: string }).rating
      : null;
  const criteria = [...new Set([...Object.keys(input.recordedRatings), ...Object.keys(input.liveRatings)])].sort();
  const changed = criteria
    .map((criterion) => ({
      criterion,
      recorded: ratingOf(input.recordedRatings[criterion]),
      current: input.liveRatings[criterion]?.rating ?? null,
    }))
    .filter((entry) => entry.recorded !== entry.current);
  return {
    recordedRevision,
    currentRevision,
    changed,
    state: changed.length > 0 ? 'verdict-changed' : recordedRevision < currentRevision ? 'carried' : 'current',
  };
}

/** Grade one clause/evidence row into the exact ratings map accepted by scorecards:emit. */
export function evaluateSpecTestAdequacy(input: {
  clause: SpecClauseRevision;
  evidence: SpecEvidenceForAdequacy[];
  classRef: PlanClassRubricRef;
  /** Exact files from the clause's immutable source BAR check, when one is pinned. */
  sourceBarTestRequirements?: SourceBarTestRequirements;
  /** Resolved harness scope to persist for operator-scope reruns. */
  harness?: string;
  /** The caller-attested current fingerprints used by listSpecEvidence. */
  current?: EvidenceCurrentInput[];
  /** Exact caller selectors that constrain the evidence population on replay. */
  rerunSelection?: { workItemIds?: string[]; evidenceRefs?: string[]; bindingIds?: number[]; planItemIds?: string[] };
  /** Full active clause population for the rubric's universal disclosed-gap check. */
  disclosedGapEvidence?: SpecEvidenceForAdequacy[];
  /** Server-resolved outside-lineage re-observations, scoped to the selected proof. */
  fixtureAbsenceVerifications?: ReadonlyMap<number, readonly number[]>;
  /** Work-item classification; `task` is the canonical non-code kind. */
  workItemKind?: string | null;
  now?: Date;
}): SpecTestAdequacyResult {
  const { clause, classRef } = input;
  const fixtureAbsenceVerifications = new Map<number, readonly number[]>(input.fixtureAbsenceVerifications);
  for (const row of input.evidence) {
    if (row.id && row.currentness?.overall === 'current' && row.currentness.provenance === 'server-measured' &&
        row.fixtureAbsenceVerification?.verifierBindingIds.length) {
      fixtureAbsenceVerifications.set(row.id, row.fixtureAbsenceVerification.verifierBindingIds);
    }
  }
  const belongsToClause = (row: SpecEvidenceForAdequacy) =>
    row.planSlug === clause.planSlug &&
    row.specId === clause.specId &&
    row.specRevision === clause.revision &&
    row.specFingerprint === clause.contentHash;
  // WI-10002082: keep the pre-projection selector match addressable. A binding can satisfy every
  // clause selector and still be dropped by `activeSpecEvidence` (it carries no test-execution
  // identity, or a later attempt superseded it). Without this population the falsifiability refusal
  // below reports a FALSE ABSENCE — "no binding is bound" — while a live, fingerprint-matching
  // binding sits in the table, which drives binders to stack redundant re-bindings on one clause.
  const exactSelectorMatches = input.evidence.filter(belongsToClause);
  const exactEvidence = activeSpecEvidence(exactSelectorMatches);
  const exactDisclosedGapMatches = (input.disclosedGapEvidence ?? input.evidence).filter(belongsToClause);
  const activeDisclosedGapEvidence = activeSpecEvidence(exactDisclosedGapMatches);
  const activeDisclosedGapByLogicalReference = new Map(
    activeDisclosedGapEvidence.map((row) => [logicalEvidenceReferenceKey(row), row]),
  );
  const currentEvidence = exactEvidence.filter(
    (row) =>
      row.currentness.overall === 'current' ||
      (row.currentness.overall === 'unknown' && row.currentness.provenance === 'attested-current'),
  );
  // A caller-supplied `current[]` is a per-binding comparison input, not a population
  // selector. Keep every exact binding in that case so an omitted fingerprint remains
  // visible as unknown instead of silently disappearing from the graded population. The
  // historical current-cohort behavior is retained only for internally/server-classified
  // evidence when no caller comparison input was supplied.
  const evidence =
    input.current !== undefined
      ? exactEvidence
      : currentEvidence.length > 0
        ? exactEvidence.filter(
            (row) =>
              currentEvidence.includes(row) ||
              // An active registered attempt whose freshness is unknown/stale cannot disappear
              // merely because another test in this clause is current and passing.
              hasTestAttemptReference(row),
          )
        : exactEvidence;
  const ratings = {} as Record<AdequacyCriterion, AdequacyRatingEntry>;

  const caseTargetMismatchEvidence = evidence.filter((row) => bindingHasOnlyMismatchedClauseCases(row, clause));
  const traceabilityEvidence = evidence.filter((row) => !bindingHasOnlyMismatchedClauseCases(row, clause));
  const caseTargetMismatchNote = caseTargetMismatchEvidence.length > 0
    ? ` Explicitly clause-labeled case(s) were excluded from this clause's traceability cohort because they name a sibling clause: ${clauseCaseTargetMismatchSummary(caseTargetMismatchEvidence, clause)}.`
    : '';
  const lineageAssessments = traceabilityEvidence.map((row) => ({ row, assessment: classifySpecEvidenceLineage(row) }));
  const ephemeralEvidence = lineageAssessments
    .filter(({ assessment }) => assessment.lineage === 'ephemeral')
    .map(({ row }) => row);
  const unknownLineageEvidence = lineageAssessments
    .filter(({ assessment }) => assessment.lineage === 'unknown')
    .map(({ row }) => row);
  ratings.traceability = !traceabilityEvidence.length
    ? caseTargetMismatchEvidence.length > 0
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            `No declared case in the active evidence cohort identifies ${clauseIdentity(clause)}; ${clauseCaseTargetMismatchSummary(caseTargetMismatchEvidence, clause)}.`,
            caseTargetMismatchEvidence,
          ),
          suggestion: 'Bind a test run whose declared adequacy.testCases identify this clause, or remove the sibling-clause case selection.',
        }
      : {
          rating: 'fail',
          evidence: `No immutable evidence binding resolves ${clauseIdentity(clause)}. ${clauseProbe(clause, input.harness)}`,
          suggestion: 'Bind the work item and proof through plans:bind-spec-evidence.',
        }
    : ephemeralEvidence.length > 0
      ? {
          rating: 'fail',
          evidence: evidenceWithBindings(
            `Ephemeral-only evidence cannot establish independently rerunnable traceability for ${clauseIdentity(clause)}.${caseTargetMismatchNote}`,
            ephemeralEvidence,
          ),
          suggestion:
            'Attach a durable testRunId, coverageEvidenceRef, work-item/artifact/test-run reference, or durable file probe.',
        }
      : unknownLineageEvidence.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Evidence lineage is not anchored to a durable rerunnable record for ${clauseIdentity(clause)}.${caseTargetMismatchNote}`,
              unknownLineageEvidence,
            ),
            suggestion:
              'Attach a durable testRunId, coverageEvidenceRef, work-item/artifact/test-run reference, or durable file probe.',
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `${new Set(traceabilityEvidence.map((row) => row.testRunId !== null
                ? `test-run:${row.testRunId}`
                : row.coverageEvidenceRef !== null
                  ? `coverage:${row.coverageEvidenceRef}`
                  : `${row.evidenceKind}:${row.evidenceRef}`)).size} distinct immutable proof record(s) have durable rerunnable lineage for ${clauseIdentity(clause)}.${caseTargetMismatchNote}`,
              traceabilityEvidence,
            ),
          };

  // `evidence` is the current grading cohort when a current row exists. It is
  // intentionally narrower than the exact clause population, so use the latter
  // for existence/applicability claims. Otherwise an unknown historical fixture
  // binding can be hidden by a current test binding and reported as absent.
  const fixtureBindings = exactEvidence.filter(
    (row) => row.evidenceKind === 'fixture' || row.fingerprints.fixtureFingerprint !== null,
  );
  const fixtureOutsideCurrent = fixtureBindings.filter((row) => !evidence.includes(row));
  const clauseDeclaresFixtureUse = [
    clause.behavior,
    clause.falsifier?.observation,
    clause.falsifier?.probeMethod,
  ].some((text) => /\bfixtures?\b/i.test(text ?? ''));
  const fixtureUseRequired =
    clause.requiredEvidence.some((entry) => /fixture/i.test(entry)) || clauseDeclaresFixtureUse;
  const executableFixtureFreeProof = exactEvidence.filter(
    (row) => EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind) && detailsOf(row).fixtureFree === true,
  );
  const fixtureUseAttested = exactEvidence.some((row) => detailsOf(row).fixtureFree === false);
  // Binder-authored fixtureFree cannot establish fixture absence for test-backed evidence.
  // Operational work-item evidence has no test bytes whose fixture use could contradict it.
  const unresolvedFixtureProof = exactEvidence.filter(
    (row) =>
      row.evidenceKind !== 'operational' &&
      EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind) &&
      row.fingerprints.fixtureFingerprint === null &&
      !(row.id && fixtureAbsenceVerifications.has(row.id) && !fixtureUseRequired),
  );
  const fixtureFreeAttestationUnverified = unresolvedFixtureProof.some(
    (row) => detailsOf(row).fixtureFree === true,
  );
  const fixtureFreeConflicts = exactEvidence.filter(
    (row) =>
      detailsOf(row).fixtureFree === true &&
        (row.evidenceKind === 'fixture' || row.fingerprints.fixtureFingerprint !== null),
  );
  const fixtureApplicable =
    fixtureUseRequired ||
    fixtureBindings.length > 0 ||
    fixtureUseAttested ||
    unresolvedFixtureProof.length > 0;
  const fixtureProofEvidence = evidence.filter(
    (row) => row.evidenceKind === 'fixture' || row.fingerprints.fixtureFingerprint !== null,
  );
  const fixtureCurrentNotCalibrated = fixtureProofEvidence.filter(
    (row) => detailsOf(row).fixtureCalibrated !== true,
  );
  const fixtureCurrentNotCalibratedSummary = fixtureCalibrationBindingSummary(fixtureCurrentNotCalibrated);
  const fixtureOutsideCurrentSummary = fixtureCalibrationBindingSummary(fixtureOutsideCurrent);
  // Keep ratings scoped to the current cohort, but show both non-passing current rows and
  // exact fixture rows outside it so a pass cannot hide uncalibrated evidence.
  const fixtureOutsideCurrentNote = fixtureOutsideCurrent.length > 0
    ? `${fixtureOutsideCurrent.length} exact fixture binding(s) are outside the current grading cohort; this cohort narrowing does not establish spec-scoped fixture absence. Excluded binding calibration: ${fixtureOutsideCurrentSummary}.`
    : null;
  const fixtureRating: AdequacyRatingEntry = fixtureFreeConflicts.length > 0
    ? {
        rating: 'fail',
        evidence: evidenceWithBindings(
          `Binding(s) claim fixtureFree=true while also carrying fixture evidence for ${clauseIdentity(clause)}.`,
          fixtureFreeConflicts,
        ),
        suggestion: 'Remove the contradictory fixture-free attestation or bind the fixture evidence under a separate row.',
      }
    : unresolvedFixtureProof.length > 0
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            (fixtureFreeAttestationUnverified
              ? fixtureUseRequired
                ? 'The clause declares fixture use, so binder-authored fixtureFree=true cannot replace calibration evidence for '
                : 'Binder-authored fixtureFree=true does not establish fixture absence for '
              : fixtureUseRequired || fixtureBindings.length > 0 || fixtureUseAttested
                ? 'A fixture is required or used, but no fixture fingerprint or calibration evidence is bound for '
                : 'A null fixtureFingerprint does not establish fixture-free proof; fixture absence is not independently measured for ') +
              clauseIdentity(clause) + '.',
            unresolvedFixtureProof,
          ),
          suggestion: fixtureFreeAttestationUnverified
            ? fixtureUseRequired
              ? 'Bind a measured fixture fingerprint and calibration proof; fixtureFree=true cannot override fixture use declared by the clause.'
              : 'Fixture-free status needs independent measurement: an outside-lineage independent-verification of the same measured source, test, run and selected cases; fixtureFree=true alone is binder-authored metadata.'
            : fixtureUseRequired || fixtureBindings.length > 0 || fixtureUseAttested
              ? 'Bind a measured fixture fingerprint and calibration proof before rating fixture calibration.'
              : 'Fixture absence is not independently measured; bind a measured fixture fingerprint and calibration proof or provide independent fixture-absence evidence.',
        }
      : fixtureApplicable
    ? booleanRating(fixtureProofEvidence, (d) => d.fixtureCalibrated, {
        pass: 'An applicable binding explicitly attests fixtureCalibrated=true.',
        fail: 'Applicable binding metadata explicitly attests fixtureCalibrated=false.',
        unknown: 'A fixture is required or used, but no binding attests fixtureCalibrated=true/false.',
      })
    : {
        rating: 'not-applicable',
        evidence: executableFixtureFreeProof.length > 0
          ? evidenceWithBindings(
              executableFixtureFreeProof.some(row => row.id && fixtureAbsenceVerifications.has(row.id))
                ? `Fixture absence for ${clauseIdentity(clause)} is independently verified for the selected measured executable binding(s); fixture calibration is not applicable. Verification citations: ${JSON.stringify(executableFixtureFreeProof.flatMap(row => row.id ? fixtureAbsenceVerifications.get(row.id) ?? [] : []))}.`
                : `Executable binding(s) explicitly attest fixtureFree=true for ${clauseIdentity(clause)}; fixture calibration is not applicable.`,
              executableFixtureFreeProof,
            )
          : `No fixture-dependent proof is bound for ${clauseIdentity(clause)}; the exact bindings inspected were ${bindingSummary(exactEvidence)}.`,
      };
  const fixtureCurrentNotCalibratedNote = fixtureRating.rating === 'pass' && fixtureCurrentNotCalibrated.length > 0
    ? `Current fixture bindings not attesting calibration: ${fixtureCurrentNotCalibratedSummary}.`
    : null;
  const fixtureEvidenceNotes = [fixtureCurrentNotCalibratedNote, fixtureOutsideCurrentNote]
    .filter((note): note is string => note !== null)
    .join(' ');
  ratings['fixture-calibration'] = fixtureEvidenceNotes
    ? { ...fixtureRating, evidence: `${fixtureRating.evidence} ${fixtureEvidenceNotes}` }
    : fixtureRating;

  // EI-22128161413448729: a self-attested `adequacy.falsifiable=true` flag is a WEAKER claim
  // than an actually-bound mutation/counterexample row with a killed/survived outcome — the two
  // must never share one evidence sentence, or an auditor reads "bound negative control" when
  // only an attestation exists. Branch the template on which basis is actually present.
  const boundMutationOrCounterexample = evidence.filter((row) => {
    return (
      (row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') && isSuccessfulExecutableEvidence(row)
    );
  });
  // The targeting rule (scenario ids, or the WI-10002724 own-specId fallback) lives in
  // mutationTargetRequirement. A syntactically valid target remains a claim until the
  // mutation run's canonical test file has its own successful test binding to this clause.
  const { selfTarget: clauseSelfTarget, requirement: clauseTargetRequirement } = mutationTargetRequirement(clause);
  const clauseScopedMutationOrCounterexample = boundMutationOrCounterexample.filter((row) =>
    isClauseBoundMutationProof(clause, row, evidence),
  );
  const targetedMutationWithoutTestBinding = boundMutationOrCounterexample.filter(
    (row) =>
      isAcceptedMutationTarget(clause, detailsOf(row).targeted) &&
      !clauseBoundCurrentTest(clause, row, evidence),
  );
  const targetedMutationWithoutMatchingCase = boundMutationOrCounterexample.filter(
    (row) =>
      isAcceptedMutationTarget(clause, detailsOf(row).targeted) &&
      clauseBoundCurrentTest(clause, row, evidence) !== null &&
      !isClauseBoundMutationTest(clause, row, evidence),
  );
  const clauseScopedProofBindings = [
    ...new Set(
      clauseScopedMutationOrCounterexample.flatMap((row) => [
        row,
        clauseBoundMutationTest(clause, row, evidence)!,
      ]),
    ),
  ];
  const exactMutationOrCounterexample = exactEvidence.filter(
    (row) => row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample',
  );
  // EI-23756870948948211: `exactMutationOrCounterexample` is filtered by evidenceKind ALONE, so a
  // non-empty result says nothing about WHY the row failed to bind. The refusal below used it to
  // assert one untested cause — "outside the current grading cohort" — when the far more common
  // case is a row sitting INSIDE the cohort that fails isSuccessfulExecutableEvidence (usually
  // details.collected/skipped/executed left unset by a normally-authored binding). Worse, when the
  // caller supplies `current[]` then `evidence === exactEvidence`, so NOTHING can be outside the
  // cohort and the asserted cause is impossible while still being printed. Split the populations by
  // real membership — the same test the fixture branch already uses for `fixtureOutsideCurrent` —
  // and report the conjunct that actually failed.
  const mutationOutsideCohort = exactMutationOrCounterexample.filter((row) => !evidence.includes(row));
  const mutationInCohortNotExecutable = exactMutationOrCounterexample.filter(
    (row) => evidence.includes(row) && !isSuccessfulExecutableEvidence(row),
  );
  // WI-10002082, RETRACTED — recorded here so the "fix" below is not re-attempted. It LOOKS as
  // though a binding could match every clause selector, be removed by the `activeSpecEvidence` read
  // projection, reach NONE of the populations above, and fall through to "no binding is bound": a
  // false absence printed while a selector-matching binding sits in the table. It cannot happen, and
  // a branch reporting it is unreachable — one was added here and removed after a calibration
  // assertion proved it never fires.
  //
  // The projection drops a row by exactly two routes, and BOTH PRESERVE `evidenceKind`:
  // `latestLogicalEvidence` keys on [workItemId, planSlug, specId, specRevision, evidenceKind,
  // evidenceRef], and attempt-supersession requires `newer.scope.key === candidate.scope.key`, whose
  // `registrationKey` carries `row.evidenceKind`. So a dropped mutation/counterexample row ALWAYS
  // leaves a surviving same-kind superseder in `exactEvidence` — hence in
  // `exactMutationOrCounterexample` — so either `mutationInCohortNotExecutable` or
  // `mutationOutsideCohort` is non-empty and reports first, or the survivor grades and falsifiability
  // passes outright. The bare-absence fall-through below is therefore TRUE whenever it prints.
  // 'projection supersession cannot strand a mutation binding' in the sibling test pins that
  // invariant: make supersession kind-agnostic and it fails, and this branch must come back.
  const attestedFalsifiableOnly = evidence.filter((row) => detailsOf(row).falsifiable === true);
  const unboundMutationReason =
    mutationInCohortNotExecutable.length > 0
      ? `${mutationInCohortNotExecutable.length} mutation or counterexample binding(s) are in the current grading cohort for ${clauseIdentity(clause)} but do not qualify as successful executable evidence (${summarizeExecutableEvidenceGaps(mutationInCohortNotExecutable)}).`
      : mutationOutsideCohort.length > 0
        ? `${mutationOutsideCohort.length} mutation or counterexample binding(s) exist in the exact clause population but are outside the current grading cohort for ${clauseIdentity(clause)}.`
      : targetedMutationWithoutTestBinding.length > 0
        ? `${targetedMutationWithoutTestBinding.length} successful mutation or counterexample binding(s) name ${clauseIdentity(clause)} but their canonical test file is not also bound as a successful current test for this clause.`
        : targetedMutationWithoutMatchingCase.length > 0
          ? targetedMutationWithoutMatchingCase.length +
            ' successful mutation or counterexample binding(s) name ' +
            clauseIdentity(clause) +
            ', but the measured failed case is missing or is not an exact member of the successful current same-clause adequacy.testCases binding. ' +
            summarizeMutationFailedCaseTitles(targetedMutationWithoutMatchingCase)
        : boundMutationOrCounterexample.length > 0
          ? clauseSelfTarget !== null
            ? `Successful mutation or counterexample binding(s) for ${clauseIdentity(clause)} do not target this clause's own specId.`
            : `Successful mutation or counterexample binding(s) for ${clauseIdentity(clause)} do not name a scenario declared in falsifier.requiredScenarios.`
          : `no mutation or counterexample binding is bound for ${clauseIdentity(clause)}.`;
  ratings.falsifiability =
    clauseScopedMutationOrCounterexample.length > 0
      ? {
          rating: 'pass',
          evidence: evidenceWithBindings(
            clauseSelfTarget !== null
              ? `A bound mutation or counterexample targets ${clauseIdentity(clause)} itself, which declares no structured falsifier.requiredScenarios list; its canonical test file is separately bound as a successful current test for this clause.`
              : `A bound mutation or counterexample targets a declared falsifier scenario for ${clauseIdentity(clause)}; its canonical test file is separately bound as a successful current test for this clause.`,
            clauseScopedProofBindings,
          ),
        }
      : boundMutationOrCounterexample.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Successful mutation or counterexample binding(s) do not establish clause-scoped falsifiability for ${clauseIdentity(clause)}; ${unboundMutationReason}`,
              boundMutationOrCounterexample,
            ),
            suggestion:
              targetedMutationWithoutTestBinding.length > 0
                ? `Bind a successful test result for the mutation run's canonical test file to ${clauseIdentity(clause)}; adequacy.targeted alone cannot establish that link.`
                : targetedMutationWithoutMatchingCase.length > 0
                  ? 'Add the exact measured failed case title from the mutation run to adequacy.testCases on the successful current same-clause test binding; missing or mismatched case identity cannot establish falsifiability.'
                : `Set adequacy.targeted to ${clauseTargetRequirement}; a boolean or sibling-case target is insufficient.`,
          }
      : attestedFalsifiableOnly.length > 0
        ? {
            rating: 'unknown',
            evidence: evidenceWithBindings(
              `Binder-attested falsifiable=true on ${attestedFalsifiableOnly.length} binding(s) is insufficient to demonstrate red capability for ${clauseIdentity(clause)}; ${unboundMutationReason}`,
              attestedFalsifiableOnly,
            ),
            suggestion:
              mutationInCohortNotExecutable.length > 0
                ? `Complete the existing mutation or counterexample binding so it qualifies as successful executable evidence (unmet: ${summarizeExecutableEvidenceGaps(mutationInCohortNotExecutable)}); falsifiable=true metadata alone is insufficient.`
                : 'Bind a successful ledger-backed mutation or counterexample result; falsifiable=true metadata alone is insufficient.',
          }
        : booleanRating(evidence, (d) => d.falsifiable, {
            pass: `A bound proof explicitly demonstrates falsifiability for ${clauseIdentity(clause)}.`,
            fail: `Bound metadata explicitly reports falsifiable=false for ${clauseIdentity(clause)}.`,
            unknown:
              exactMutationOrCounterexample.length > 0
                ? `A mutation or counterexample binding exists in the exact clause population, but no current-cohort binding demonstrates how ${clauseIdentity(clause)} fails when behavior is wrong.`
                : // A projection-dropped binding cannot reach here while this population is empty —
                  // see the retracted-WI-10002082 note above for why the two are inseparable.
                  `No bound evidence demonstrates how ${clauseIdentity(clause)} fails when behavior is wrong.`,
          });

  let layerRating: CorrectLayerEvidencePart;
  if (clause.requiredTestLayers.length === 0) {
    layerRating = boundCorrectLayerPart(
      'not-applicable',
      `The clause ${clauseIdentity(clause)} declares no required test layer; layer reachability is not evaluated. ${clauseDeclarationProbe(clause, input.harness)}`,
      evidence.filter((row) => row.evidenceKind !== 'mutation'),
    );
  } else {
    const legacyOperationalRequired = clause.requiredTestLayers.find((layer) =>
      ['behavioral', 'manual-provenance'].includes(normalizedLayer(layer)));
    const required = [...new Set(clause.requiredTestLayers.map(canonicalRequiredLayer))];
    const displayLayer = (layer: string) =>
      legacyOperationalRequired && layer === 'operational'
        ? `${normalizedLayer(legacyOperationalRequired)} (canonical operational adapter)` : layer;
    const present = new Map<string, boolean | undefined>();
    const targetMismatchRows = new Map<string, SpecEvidenceForAdequacy[]>();
    const targetMatchedLayers = new Set<string>();
    const contradictoryLayerRows: SpecEvidenceForAdequacy[] = [];
    for (const row of evidence) {
      const details = detailsOf(row);
      const claimedLayer = typeof details.testLayer === 'string' ? normalizedLayer(details.testLayer) : undefined;
      const measuredLayer = row.testRunExecution?.testLayer;
      const measuredCases = (details.testCases ?? []).filter((caseTitle) => hasPassingRequiredLayerCase(row, caseTitle));
      if (
        row.testRunId === null ||
        row.testRunExecution?.status?.toLowerCase() !== 'pass' ||
        row.testRunExecution.failed !== 0 ||
        row.testRunExecution.collectionFailed !== false ||
        // Operational is derived by the canonical evidence adapter, not a
        // Vitest/Playwright recorded runner layer. Keep those vocabularies
        // separate while accepting the adapter's measured case provenance.
        (!isRecordedTestLayer(measuredLayer) && measuredLayer !== 'operational') ||
        measuredCases.length === 0
      ) {
        // Preserve an author claim as unresolved so an unmeasured positive cannot
        // be mistaken for either proof or a measured contradiction.
        const unresolvedLayer = claimedLayer ? canonicalRequiredLayer(claimedLayer) : undefined;
        if (unresolvedLayer && required.includes(unresolvedLayer) && !present.has(unresolvedLayer)) {
          present.set(unresolvedLayer, undefined);
        }
        continue;
      }
      const layer = normalizedLayer(measuredLayer);
      const relevantLayers = [...new Set([
        canonicalRequiredLayer(layer),
        ...(claimedLayer ? [canonicalRequiredLayer(claimedLayer)] : []),
      ])].filter((requiredLayer) => required.includes(requiredLayer));
      // Evidence belonging to another canonical clause is outside this clause's
      // population. For a row bound to this exact revision, however, an absent or
      // sibling adequacy.targeted is unresolved target evidence, not layer coverage.
      if (!bindingIdentityMatchesClause(row, clause)) continue;
      if (!bindingTargetsClause(row, clause)) {
        for (const requiredLayer of relevantLayers) {
          const rows = targetMismatchRows.get(requiredLayer) ?? [];
          rows.push(row);
          targetMismatchRows.set(requiredLayer, rows);
        }
        continue;
      }
      for (const requiredLayer of relevantLayers) targetMatchedLayers.add(requiredLayer);
      const legacyOperationalClaim =
        legacyOperationalRequired &&
        row.evidenceKind === 'operational' &&
        (claimedLayer === 'behavioral' || claimedLayer === 'manual-provenance') &&
        layer === 'operational';
      if (claimedLayer && claimedLayer !== layer && !legacyOperationalClaim) {
        if (required.includes(canonicalRequiredLayer(claimedLayer)) || required.includes(layer)) {
          contradictoryLayerRows.push(row);
          const claimedRequirement = canonicalRequiredLayer(claimedLayer);
          if (required.includes(claimedRequirement)) present.set(claimedRequirement, false);
          if (required.includes(layer)) present.set(layer, false);
        }
        continue;
      }
      if (!required.includes(layer)) continue;
      const prior = present.get(layer);
      present.set(layer, prior === true || details.pathReachable === true ? true : details.pathReachable);
    }
    const unresolvedTarget = required.filter(
      (layer) => targetMismatchRows.has(layer) && !targetMatchedLayers.has(layer),
    );
    const missing = required.filter((layer) => !present.has(layer) && !unresolvedTarget.includes(layer));
    const unreachable = required.filter((layer) => present.get(layer) === false);
    const unresolved = required.filter(
      (layer) => present.get(layer) === undefined || unresolvedTarget.includes(layer),
    );
    layerRating =
      contradictoryLayerRows.length || missing.length || unreachable.length
        ? boundCorrectLayerPart(
            'fail',
            `Required layer/path gaps for ${clauseIdentity(clause)}: ${[
              ...contradictoryLayerRows.map((row) => {
                const details = detailsOf(row);
                return `testLayer-claim-mismatch:${String(details.testLayer)}!=${String(row.testRunExecution?.testLayer)}`;
              }),
              ...missing.map((layer) => `${displayLayer(layer)}:missing`),
              ...unreachable.map((layer) => `${displayLayer(layer)}:unreachable`),
            ].join(', ')}.`,
            [...new Set([...contradictoryLayerRows, ...evidence])],
            'Bind passing measured evidence for every requiredTestLayer; its canonical layer and exact passing case or LLM scenario must match the binding, with path reachability attested.',
            ` ${clauseDeclarationProbe(clause, input.harness)}`,
          )
        : unresolvedTarget.length > 0
          ? boundCorrectLayerPart(
              'unknown',
              `Required layer(s) have passing case evidence whose binding target does not identify the exact clause ${clause.planItemId}/${clauseIdentity(clause)}: ${unresolvedTarget.map(displayLayer).join(', ')}.`,
              unresolvedTarget.flatMap((layer) => targetMismatchRows.get(layer) ?? []),
              `Bind passing measured evidence to ${clause.planSlug}/${clause.planItemId}/${clause.specId}@${clause.revision} ` +
                `(${clause.contentHash}) with adequacy.targeted=${JSON.stringify(clause.specId)}; missing, boolean, and sibling-clause targets remain unknown.`,
            )
          : unresolved.length
            ? boundCorrectLayerPart(
                'unknown',
                `Required layer(s) are represented but path reachability is unverified for ${clauseIdentity(clause)}: ${unresolved.map(displayLayer).join(', ')}.`,
                evidence.filter((row) => {
                  const details = detailsOf(row);
                  const measuredLayer = row.testRunExecution?.testLayer;
                  return (
                    (typeof details.testLayer === 'string' && unresolved.includes(canonicalRequiredLayer(details.testLayer))) ||
                    (isRecordedTestLayer(measuredLayer) && unresolved.includes(normalizedLayer(measuredLayer)))
                  );
                }),
                `Rebind passing measured evidence whose server-measured testLayer is one of the required layers (${unresolved.map(displayLayer).join(', ')}), ` +
                  'whose exact passedCaseTitles (or canonical llm-test scenarioId and executed file) corroborate adequacy.testCases, and whose adequacy.testLayer claim matches the measured layer; binder-only layer/path claims remain unknown.',
              )
            : boundCorrectLayerPart(
                'pass',
                `Every required layer reaches the claimed path for ${clauseIdentity(clause)}: ${required.map(displayLayer).join(', ')}.`,
                evidence.filter((row) => {
                  const details = detailsOf(row);
                  const measuredLayer = row.testRunExecution?.testLayer;
                  const measuredRecordedLayer = isRecordedTestLayer(measuredLayer);
                  const measuredOperationalLayer =
                    row.evidenceKind === 'operational' && measuredLayer === 'operational';
                  const operationalCompatibilityClaim =
                    legacyOperationalRequired &&
                    measuredOperationalLayer &&
                    typeof details.testLayer === 'string' &&
                    ['behavioral', 'manual-provenance'].includes(normalizedLayer(details.testLayer));
                  const claimMatchesMeasurement =
                    details.testLayer === undefined ||
                    (typeof details.testLayer === 'string' &&
                      ((measuredRecordedLayer && normalizedLayer(details.testLayer) === normalizedLayer(measuredLayer)) ||
                        operationalCompatibilityClaim));
                  return (
                    row.testRunId !== null &&
                    ((row.evidenceKind === 'test' && measuredRecordedLayer) || measuredOperationalLayer) &&
                    bindingTargetsClause(row, clause) &&
                    required.includes(normalizedLayer(measuredLayer)) &&
                    claimMatchesMeasurement &&
                    (details.testCases ?? []).some((caseTitle) => hasPassingRequiredLayerCase(row, caseTitle)) &&
                    details.pathReachable === true
                  );
                }),
              );
  }

  const requiredScenarios = [...new Set(clause.falsifier?.requiredScenarios ?? [])].sort();
  let scenarioRating: CorrectLayerEvidencePart | null = null;
  if (requiredScenarios.length > 0) {
    const malformedScenarioRows = evidence.filter((row) =>
      detailsOf(row).contractMetadataIssues?.includes('scenarioIds:invalid'),
    );
    const successfulScenarioRows = evidence.filter(
      (row) => isSuccessfulExecutableEvidence(row) && detailsOf(row).pathReachable === true,
    );
    const covered = new Set(successfulScenarioRows.flatMap((row) => detailsOf(row).scenarioIds ?? []));
    const missing = requiredScenarios.filter((scenario) => !covered.has(scenario));
    scenarioRating =
      missing.length > 0
        ? boundCorrectLayerPart(
            'fail',
            `Canonical acceptance scenario(s) are not covered by successful ledger-backed path proof for ${clauseIdentity(clause)}: ${missing.join(', ')}. Required scenarios: ${requiredScenarios.join(', ')}.`,
            successfulScenarioRows,
            'Bind successful executed proof whose adequacy.scenarioIds cover every falsifier.requiredScenarios id.',
          )
        : malformedScenarioRows.length > 0
          ? boundCorrectLayerPart(
              'unknown',
              `All named scenarios are represented, but malformed scenarioIds metadata prevents a complete scenario-cohort verdict for ${clauseIdentity(clause)}.`,
              malformedScenarioRows,
              'Supersede malformed bindings with schema-valid adequacy.scenarioIds.',
            )
          : boundCorrectLayerPart(
              'pass',
              `Every canonical acceptance scenario has successful ledger-backed path proof for ${clauseIdentity(clause)}: ${requiredScenarios.join(', ')}.`,
              successfulScenarioRows.filter((row) =>
                (detailsOf(row).scenarioIds ?? []).some((scenario) => requiredScenarios.includes(scenario)),
              ),
            );
  }
  // Required evidence strings are generally descriptive, but exact canonical evidence-kind
  // tokens are executable requirements. Check them against the active rows for this pinned
  // revision so a declared kind cannot disappear behind unrelated passing evidence.
  // `fixture` has its own fixture-calibration path below and is intentionally excluded here.
  const requiredEvidenceKinds = [...new Set(clause.requiredEvidence
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is SpecEvidenceKind =>
      entry !== 'fixture' && SPEC_EVIDENCE_KINDS.includes(entry as SpecEvidenceKind),
    ))];
  const boundEvidenceKinds = new Set(exactEvidence.map((row) => row.evidenceKind));
  const missingEvidenceKinds = requiredEvidenceKinds.filter((kind) => !boundEvidenceKinds.has(kind));
  const evidenceKindRating: CorrectLayerEvidencePart | null = requiredEvidenceKinds.length === 0 ? null
    : missingEvidenceKinds.length > 0
      ? plainCorrectLayerPart(
          'fail',
          `Required evidence kind(s) are absent from active bindings for ${clauseIdentity(clause)} at revision ${clause.revision}: ${missingEvidenceKinds.join(', ')}.`,
          'Bind active evidence of each required evidence kind to this exact clause revision.',
        )
      : plainCorrectLayerPart(
          'pass',
          `Active bindings at revision ${clause.revision} cover the required evidence kind(s) for ${clauseIdentity(clause)}: ${requiredEvidenceKinds.join(', ')}.`,
        );
  // A standalone clause can require a tree, live, or deployed observation without a source BAR.
  // The BAR ship gate checks its own evidence plane, but cannot cover such a clause.
  // Inspect only current-cohort bindings and use the same explicit plane metadata as
  // the BAR snapshot; a binding from another plane cannot satisfy the declared requirement.
  const requiredPlanes = [...new Set(clause.requiredEvidence
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === 'tree' || entry === 'live' || entry === 'deployed'))];
  const planeBindings = currentEvidence.filter((row) => {
    const plane = readSpecEvidencePlane(row.details);
    return typeof plane === 'string' && requiredPlanes.some((requiredPlane) => requiredPlane === plane.trim().toLowerCase());
  });
  const presentPlanes = new Set(planeBindings.flatMap((row) => {
    const plane = readSpecEvidencePlane(row.details);
    return typeof plane === 'string' ? [plane.trim().toLowerCase()] : [];
  }));
  const missingPlanes = requiredPlanes.filter((plane) => !presentPlanes.has(plane));
  const planeBlockerRows = missingPlanes.length === 0 ? [] : exactEvidence.filter((row) => {
    const plane = readSpecEvidencePlane(row.details);
    const normalizedPlane = typeof plane === 'string' ? plane.trim().toLowerCase() : null;
    const recognizedPlane = normalizedPlane === 'live' || normalizedPlane === 'deployed' ? normalizedPlane : null;
    const planeMatchesMissingRequirement = recognizedPlane !== null && missingPlanes.includes(recognizedPlane);
    const evidenceKindCanSatisfyPlane = ['manual', 'operational', 'independent-verification'].includes(row.evidenceKind);
    const isNotCurrent = !currentEvidence.includes(row);
    return (
      (planeMatchesMissingRequirement && isNotCurrent) ||
      (evidenceKindCanSatisfyPlane && (recognizedPlane === null || !requiredPlanes.includes(recognizedPlane)))
    );
  });
  const planeRating: CorrectLayerEvidencePart | null = requiredPlanes.length === 0 ? null : missingPlanes.length > 0
    ? boundCorrectLayerPart(
        'fail',
        `Required evidence plane(s) are absent from current bindings for ${clauseIdentity(clause)}: ${missingPlanes.join(', ')}. ` +
          (planeBlockerRows.length > 0
            ? 'Non-current or plane-mismatched manual/operational binding(s) are listed below for inspection.'
            : 'No current binding declares one of the required planes.'),
        planeBlockerRows,
        'Bind a current row with details.evidencePlane matching each requiredEvidence plane (for example, details: { evidencePlane: "live" }); live/deployed evidence also needs environmentFingerprint, or a validated ledger-only currentMeasurement, so environment currentness is known.',
      )
    : boundCorrectLayerPart(
        'pass',
        `Current bindings cover the required evidence plane(s) for ${clauseIdentity(clause)}: ${requiredPlanes.join(', ')}.`,
        planeBindings,
      );
  const parts = [
    layerRating,
    sourceBarTestSuiteRating(clause, evidence, input.sourceBarTestRequirements),
    scenarioRating,
    evidenceKindRating,
    planeRating,
  ]
    .filter((part): part is CorrectLayerEvidencePart => part !== null);
  const combinedRating: AdequacyRating = parts.some((part) => part.rating === 'fail')
    ? 'fail'
    : parts.some((part) => part.rating === 'unknown')
      ? 'unknown'
      : parts.every((part) => part.rating === 'not-applicable')
        ? 'not-applicable'
        : 'pass';
  ratings['correct-layer'] = {
    rating: combinedRating,
    evidence:
      evidenceWithBindings(
        parts.map((part) => part.statement).join(' '),
        uniqueBindingRows(parts.flatMap((part) => part.bindingRows)),
      ) + correctLayerMutationExclusion(
        evidence,
        uniqueBindingRows(parts.flatMap((part) => part.bindingRows)),
      ),
    ...((parts.map((part) => part.suggestion).filter(Boolean).length > 0)
      ? { suggestion: parts.map((part) => part.suggestion).filter(Boolean).join(' ') }
      : {}),
  };

  ratings['oracle-independence'] = booleanRating(evidence, (d) => d.oracleIndependent, {
    pass: `A bound proof explicitly uses an implementation-independent oracle for ${clauseIdentity(clause)}.`,
    fail: `Bound metadata explicitly reports oracleIndependent=false for ${clauseIdentity(clause)}.`,
    unknown: `No bound evidence establishes oracle independence for ${clauseIdentity(clause)}.`,
  });

  const executable = evidence.filter((row) => EXECUTABLE_EVIDENCE_KINDS.has(row.evidenceKind));
  const unbackedExecution = executable.filter((row) => !hasExecutionLedgerReference(row));
  const unmeasuredTestRunExecution = executable.filter(
    (row) => row.testRunId !== null && row.testRunExecution === null,
  );
  const explicitBadExecutionRows = executable.filter((row) => measuredExecutionVerdict(row) === 'fail');
  const explicitBadExecution = explicitBadExecutionRows.length > 0;
  const successfulExecution = executable.some((row) => measuredExecutionVerdict(row) === 'pass');
  const incompleteMeasuredExecution = executable.filter((row) => measuredExecutionVerdict(row) === 'unknown');
  const executionRating: AdequacyRatingEntry = explicitBadExecution
    ? {
        rating: 'fail',
        evidence: evidenceWithBindings(
          'Canonical test_runs execution-integrity predicates failed for ' + clauseIdentity(clause) + ': ' +
            explicitBadExecutionRows.map(executionFailureDetails).join('; ') + '.',
          explicitBadExecutionRows,
        ),
        // P-019: bindings are append-only, so an older failing attempt keeps failing this
        // criterion beside a newer passing one until it is withdrawn.
        ...(successfulExecution
          ? { suggestion: SUPERSEDE_DRAGGING_SUGGESTION }
          : { suggestion: executionFailureSuggestion(explicitBadExecutionRows) }),
      }
    : unbackedExecution.length > 0
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            `Executable binding(s) attest execution details but have no durable ledger reference for ${clauseIdentity(clause)}; author-attested booleans cannot establish execution-integrity.`,
            unbackedExecution,
          ),
          suggestion:
            'Bind a recorded testRunId with valid test_runs status and execution_details; binding metadata alone is insufficient.',
        }
        : unmeasuredTestRunExecution.length > 0
          ? {
              rating: 'unknown',
              evidence: evidenceWithBindings(
                `Bound testRunId(s) have absent or invalid execution_details, so canonical status, counts, and case identities cannot be verified for ${clauseIdentity(clause)}.`,
                unmeasuredTestRunExecution,
              ),
              suggestion: 'Re-record the test run with valid test_runs status and execution_details before relying on it.',
            }
          : incompleteMeasuredExecution.length > 0
            ? {
                rating: 'unknown',
                evidence: evidenceWithBindings(
                  `Executable bindings have no complete canonical test_runs status/count verdict for ${clauseIdentity(clause)}.`,
                  incompleteMeasuredExecution,
                ),
                suggestion: 'Attach a testRunId whose canonical status and execution_details establish a passing run (or a measured killed mutation).',
            }
            : successfulExecution
              ? {
                  rating: 'pass',
                  evidence: [
                    evidenceWithBindings(
                      `Canonical test_runs status/counts and selected case identities show the bound proof scope was collected, not skipped, executed, and successful for ${clauseIdentity(clause)}.`,
                      executable.filter((row) => measuredExecutionVerdict(row) === 'pass'),
                    ),
                    ...(executable.some((row) => measuredExecutionVerdict(row) === 'pass' && hasUnmatchedPassingCaseDeclaration(row))
                      ? [
                          'Unmatched adequacy.testCases labels remain visible in the per-run detail but do not invalidate execution-integrity for a non-skipped passing run, which measures canonical runner status/counts; a skipped ordinary run requires every declared case to have canonically passed. correct-layer separately checks required-layer reachability using at least one corroborated declared case per required layer.',
                        ]
                      : []),
                  ].join(' '),
                }
              : {
                  rating: executable.length ? 'unknown' : 'fail',
                  evidence: executable.length
                    ? evidenceWithBindings(
                        `Executable bindings exist for ${clauseIdentity(clause)}, but collection/skip/execution/outcome metadata is incomplete.`,
                        executable,
                      )
                    : `No executable test/check/mutation/counterexample/coverage/operational proof is bound for ${clauseIdentity(clause)}. ${clauseProbe(clause, input.harness)}`,
                  // EI-23958122348412546: with zero executable rows this 'fail' reports ABSENCE,
                  // not bad evidence — the non-code exemption below must be able to reach it.
                  ...(executable.length ? {} : { absenceOnly: true }),
                };

  let causalPairRating: AdequacyRatingEntry | null = null;
  if (clause.falsifier?.causalPairing === 'one-to-one') {
    const canonicalPairIds = [...new Set(clause.falsifier.requiredScenarios ?? [])].sort();
    const malformedPairRows = evidence.filter((row) =>
      detailsOf(row).contractMetadataIssues?.includes('causalPairIds:invalid'),
    );
    const negativeRows = evidence.filter(
      (row) => row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample',
    );
    const recurrenceRows = evidence.filter(
      (row) =>
        row.evidenceKind !== 'mutation' &&
        row.evidenceKind !== 'counterexample' &&
        detailsOf(row).causalPairIds !== undefined,
    );
    const violations: string[] = [];
    const negativeByPair = new Map<string, SpecEvidenceForAdequacy[]>();
    const recurrenceByPair = new Map<string, SpecEvidenceForAdequacy[]>();
    const add = (target: Map<string, SpecEvidenceForAdequacy[]>, pairId: string, row: SpecEvidenceForAdequacy) =>
      target.set(pairId, [...(target.get(pairId) ?? []), row]);

    for (const row of malformedPairRows) violations.push(`${row.evidenceRef}:malformed causalPairIds`);
    if (negativeRows.length === 0) violations.push('no mutation/counterexample binding declares the original failure');
    for (const row of negativeRows) {
      const details = detailsOf(row);
      if (details.contractMetadataIssues?.includes('causalPairIds:invalid')) {
        violations.push(`${row.evidenceRef}:malformed causalPairIds`);
        continue;
      }
      if (details.causalPairIds?.length !== 1) {
        violations.push(`${row.evidenceRef}:expected exactly one causalPairId on the negative binding`);
        continue;
      }
      add(negativeByPair, details.causalPairIds[0]!, row);
    }
    for (const row of recurrenceRows) {
      const details = detailsOf(row);
      if (details.contractMetadataIssues?.includes('causalPairIds:invalid')) {
        violations.push(`${row.evidenceRef}:malformed causalPairIds`);
        continue;
      }
      if (details.causalPairIds?.length !== 1) {
        violations.push(`${row.evidenceRef}:expected exactly one causalPairId on the recurrence binding`);
        continue;
      }
      add(recurrenceByPair, details.causalPairIds[0]!, row);
    }
    const pairIds = [...new Set([...negativeByPair.keys(), ...recurrenceByPair.keys()])].sort();
    if (canonicalPairIds.length > 0) {
      const missingCanonicalPairs = canonicalPairIds.filter((pairId) => !pairIds.includes(pairId));
      const unexpectedPairs = pairIds.filter((pairId) => !canonicalPairIds.includes(pairId));
      if (missingCanonicalPairs.length > 0) {
        violations.push(`canonical causalPairId(s) missing: ${missingCanonicalPairs.join(', ')}`);
      }
      if (unexpectedPairs.length > 0) {
        violations.push(`causalPairId(s) not named by requiredScenarios: ${unexpectedPairs.join(', ')}`);
      }
    }
    for (const pairId of pairIds) {
      const negatives = negativeByPair.get(pairId) ?? [];
      const recurrences = recurrenceByPair.get(pairId) ?? [];
      if (negatives.length !== 1) violations.push(`${pairId}:expected 1 negative binding, found ${negatives.length}`);
      if (recurrences.length !== 1)
        violations.push(`${pairId}:expected 1 recurrence binding, found ${recurrences.length}`);
      if (negatives.length === 1 && !isSuccessfulExecutableEvidence(negatives[0]!)) {
        violations.push(`${pairId}:negative binding is not successful ledger-backed counterexample proof`);
      }
      if (recurrences.length === 1 && !isSuccessfulRepairedEvidence(recurrences[0]!)) {
        violations.push(`${pairId}:recurrence binding is not successful ledger-backed repaired proof`);
      }
    }
    causalPairRating =
      violations.length > 0
        ? {
            rating: 'fail',
            evidence: evidenceWithBindings(
              `The canonical one-to-one causal-pair contract is incomplete for ${clauseIdentity(clause)}: ${violations.join('; ')}.`,
              [...negativeRows, ...recurrenceRows],
            ),
            suggestion:
              'Bind exactly one successful ledger-backed mutation/counterexample row and one successful repaired row for each stable adequacy.causalPairIds id.',
          }
        : {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every original failure has exactly one successful ledger-backed negative and repaired recurrence binding for ${clauseIdentity(clause)}: ${pairIds.join(', ')}.`,
              [...negativeRows, ...recurrenceRows],
            ),
          };
  }
  if (causalPairRating === null) {
    ratings['execution-integrity'] = executionRating;
  } else {
    const combinedRating: AdequacyRating =
      executionRating.rating === 'fail' || causalPairRating.rating === 'fail'
        ? 'fail'
        : executionRating.rating === 'unknown' || causalPairRating.rating === 'unknown'
          ? 'unknown'
          : 'pass';
    ratings['execution-integrity'] = {
      rating: combinedRating,
      evidence: `${executionRating.evidence} Causal pairing: ${causalPairRating.evidence}`,
      ...([executionRating.suggestion, causalPairRating.suggestion].filter(Boolean).length > 0
        ? { suggestion: [executionRating.suggestion, causalPairRating.suggestion].filter(Boolean).join(' ') }
        : {}),
    };
  }

  const freshnessStates = evidence.map((row) => row.currentness.overall);
  ratings.freshness = freshnessStates.includes('stale')
    ? {
        rating: 'fail',
        evidence: evidenceWithBindings(
          `Stale binding(s) invalidate freshness for ${clauseIdentity(clause)}.`,
          evidence.filter((row) => row.currentness.overall === 'stale'),
        ),
        // P-019: a stale row drags this criterion even when a current sibling proves the clause.
        // EI-25215634977268694: name supersession only when it would actually clear the rows.
        suggestion: freshnessDragSuggestion(evidence),
      }
    : freshnessStates.includes('unknown')
      ? {
          rating: 'unknown',
          evidence: evidenceWithBindings(
            (() => {
              const unknownEvidence = evidence.filter((row) => row.currentness.overall === 'unknown');
              const refs = unknownEvidence.map((row) => row.evidenceRef).join(', ');
              const callerOmittedCurrent = unknownEvidence.some((row) => !row.currentness.comparisonSupplied);
              const callerAttestedCurrent = unknownEvidence.some(
                (row) => row.currentness.provenance === 'attested-current',
              );
              // A replayed tuple matched its stored values and is capped at `unknown`
              // BECAUSE it matched — nothing is missing and nothing is stale. Without
              // this arm the chain fell through to "Current fingerprints are missing",
              // which states the opposite of what happened and sends the reader hunting
              // for absent evidence (WI-10002320). The two arms above exist for exactly
              // this reason on their own provenances.
              const callerReplayedCurrent = unknownEvidence.some(
                (row) => row.currentness.provenance === 'replayed-snapshot',
              );
              const partiallyServerMeasured = unknownEvidence.filter(
                (row) => row.currentness.provenance === 'partially-server-measured',
              );
              return partiallyServerMeasured.length > 0
                ? `Repository fingerprints were server-measured, but applicable non-repository dimensions ` +
                    `were only caller-attested and cannot establish freshness for: ${partiallyServerMeasured
                      .map((row) => row.evidenceRef)
                      .join(', ')}.`
                : callerAttestedCurrent
                  ? `Current fingerprints were caller-supplied and are labeled attested-current; matching stored values cannot establish independently measured freshness, so freshness is unknown for this replay input. Missing comparison for: ${refs}.`
                  : callerReplayedCurrent
                    ? `Current fingerprints were supplied by a replayed snapshot and MATCHED the stored values; a replayed tuple is not an independent measurement, so freshness is unknown for this replay input—nothing is missing and nothing is stale. Re-run so the server measures each binding's own persisted measurement basis. Awaiting independent measurement for: ${refs}.`
                    : callerOmittedCurrent
                      ? `Current fingerprints were not supplied by this call (current[] was omitted), so freshness is unknown for this replay input—not evidence that stored bindings are stale. If replaying a rerunRecipe, pass rerunRecipe.current.fingerprints. Missing comparison for: ${refs}.`
                      : `Current fingerprints are missing for: ${refs}.`;
            })(),
            evidence.filter((row) => row.currentness.overall === 'unknown'),
          ),
        }
      : evidence.length
        ? {
            rating: 'pass',
            evidence: evidenceWithBindings(
              `Every bound proof dimension is current for ${clauseIdentity(clause)}.`,
              evidence,
            ),
          }
        : {
            rating: 'fail',
            evidence: `No evidence exists whose freshness can be established for ${clauseIdentity(clause)}. ${clauseProbe(clause, input.harness)}`,
            // EI-23958122348412546: absence of any measurable binding, not a stale one.
            absenceOnly: true,
          };

  const risk = riskFloorRating(clause, classRef, evidence, input.now ?? new Date(), input.harness, input.workItemKind);
  ratings['plan-class-risk-floor'] = risk.rating;

  // EI-23793489732627099: the non-code exemption reached ONLY plan-class-risk-floor.
  // requiredProofFloor's own doc comment promises that "executable test-proof floors
  // do not apply to a task", but the promise was kept at the floor and nowhere else,
  // so a clause describing non-code work (a triage-to-disposition item, a
  // measurement/investigation item) could never reach an all-pass verdict by ANY
  // route — binding, re-kind, re-class, or the l4 waiver, which is itself consumed
  // inside riskFloorRating and so cleared only the floor too. Each criterion below
  // structurally demands an artifact non-code work cannot produce: falsifiability
  // needs a ledger-backed mutation/counterexample row, execution-integrity needs a
  // ledger testRunId or coverage row, and freshness needs a details.currentMeasurement
  // whose kind is the literal 'repo-files'. The clause sat in wouldBlock forever and
  // blocked plan ship with no reachable repair.
  //
  // Only 'unknown' is downgraded, and that boundary is the whole safety argument:
  // 'unknown' means "this cannot be established", which for non-code work is
  // structural and expected. A 'fail' means the bound evidence positively reports
  // something bad — falsifiable=false, a failed outcome, a stale binding — which is
  // real information about real evidence and must keep blocking, exemption or not.
  // EI-23958122348412546: the exemption originally downgraded ONLY 'unknown', which left it
  // unreachable for the canonical non-code case. Evidence declared honestly as `manual` is not
  // an EXECUTABLE_EVIDENCE_KIND, so it produces ZERO executable rows, so execution-integrity
  // rated a bare 'fail' and was skipped here — the clause blocked ship with no reachable repair,
  // which is verbatim the failure the block above says it fixed. Worse, the incentive inverted:
  // binding one executable-kind row with author-attested booleans and NO ledger anchor rated
  // 'unknown' and WAS exempted, so weaker evidence passed where honest evidence failed.
  //
  // An absence-shaped 'fail' is now downgraded alongside 'unknown'. The safety boundary is
  // unchanged and is carried by `absenceOnly`, not by the rating: a 'fail' that reports
  // something POSITIVELY bad (falsifiable=false, a failed/skipped/unexecuted outcome, a stale
  // binding) never sets that flag and therefore still blocks, exemption or not.
  if (risk.floor === 'none') {
    for (const criterion of EXECUTABLE_PROOF_CRITERIA) {
      const current = ratings[criterion];
      const exemptible = current.rating === 'unknown' || (current.rating === 'fail' && current.absenceOnly === true);
      if (!exemptible) continue;
      ratings[criterion] = {
        rating: 'not-applicable',
        evidence:
          `${clauseIdentity(clause)} carries no executable proof floor (requiredProofFloor='none'), so ` +
          `${criterion} is not applicable to it: the criterion can only be satisfied by ledger- or ` +
          `repo-backed executable proof that non-code work cannot produce. Rated '${current.rating}'` +
          `${current.absenceOnly === true ? ' (absence of executable proof, not adverse evidence)' : ''} before the ` +
          `exemption was applied — ${current.evidence}`,
      };
    }
  }

  // A DISCLOSURE IS NOT A MITIGATION. Before this criterion existed, an author
  // could record a known hole in the proof on the binding and still collect a
  // machine PASS, because no evaluator field read the disclosure — so the gap
  // travelled with the evidence while the verdict said the clause was proven.
  // Re-binding the same immutable proof can also append a newer metadata row
  // without the disclosure. Keep that gap attached to the active logical
  // reference while its run/fingerprints are unchanged, and until changed proof
  // is server-current. A stale or unknown replacement has not closed the gap.
  const disclosedGapRows = exactDisclosedGapMatches.filter((row) => {
    if ((detailsOf(row).disclosedGap ?? []).length === 0) return false;
    const active = activeDisclosedGapByLogicalReference.get(logicalEvidenceReferenceKey(row));
    if (!active) return false;
    return proofIdentity(row) === proofIdentity(active) || active.currentness.overall !== 'current';
  });
  // Keep review-only notes on the same active logical population as the count above.
  // The append-only store can contain older rows for the same proof; quoting those
  // alongside the active count makes a pinned diagnostic look like it checked fewer
  // bindings than it rendered. Selected/other-current labels preserve the universal
  // disclosed-gap census without hiding notes from unselected active bindings.
  const freeFormNoteRows = activeDisclosedGapEvidence.filter((row) => {
    const note = row.details.note;
    if (typeof note !== 'string' || note.trim().length === 0) return false;
    return true;
  });
  const noDisclosureStatement =
    'No bound proof for ' +
    clauseIdentity(clause) +
    ` records a structured author-disclosed gap. Checked ${activeDisclosedGapEvidence.length} active binding(s) for the clause.` +
    bindingNotesSummary(freeFormNoteRows, evidence) +
    (freeFormNoteRows.length > 0
      ? ' Record any coverage limitation under details.adequacy.disclosedGap so machine grading blocks it.'
      : '');
  ratings['disclosed-gap'] =
    disclosedGapRows.length > 0
      ? {
          rating: 'fail',
          evidence: evidenceWithBindings(
            `Bound proof for ${clauseIdentity(clause)} records an author-disclosed gap, so it cannot be read as a machine PASS. Disclosed: ${[
              ...new Set(disclosedGapRows.flatMap((row) => detailsOf(row).disclosedGap ?? [])),
            ].join(' | ')}.`,
            disclosedGapRows,
          ),
          suggestion:
            'Close the disclosed gap and re-bind, or supersede the binding with proof carrying no disclosure. A disclosure cannot be graded away while it stands.',
        }
      : {
          rating: 'not-applicable',
          // Still routed through evidenceWithBindings when bindings exist: every
          // criterion's evidence string must surface the bound proof base (a
          // provisional one especially), including the criteria that found nothing.
          evidence:
            evidence.length > 0
              ? evidenceWithBindings(noDisclosureStatement, evidence)
              : noDisclosureStatement,
        };

  // P-019: surface the ledger requirement on every ledger-gated criterion that is still
  // short of proof, where the binder reads the refusal, not in a doc they must find first.
  const executionNeedsLedgerHint =
    executable.length === 0 ||
    (explicitBadExecutionRows.length === 0 &&
      (unbackedExecution.length > 0 || incompleteMeasuredExecution.some((row) => row.testRunId === null)));
  for (const criterion of ['falsifiability', 'execution-integrity', 'traceability'] as const) {
    const current = ratings[criterion];
    if (current.rating !== 'fail' && current.rating !== 'unknown') continue;
    if (criterion === 'execution-integrity' && !executionNeedsLedgerHint) continue;
    ratings[criterion] = {
      ...current,
      suggestion: current.suggestion ? `${current.suggestion} ${LEDGER_PROOF_HINT}` : LEDGER_PROOF_HINT,
    };
  }

  // Store ceilings apply before logical evidence consolidation, and replay also
  // loads the unselected clause bindings for its universal disclosure check.
  // Preserve headroom for both reads without widening the exact binding selector.
  const rerunRecipe = rerunRecipeFor(
    clause, evidence, input.current, input.harness, classRef, input.rerunSelection,
    Math.max(exactSelectorMatches.length, exactDisclosedGapMatches.length),
  );
  appendRatingRerunProbes(ratings, rerunRecipe);

  const wouldBlock = ADEQUACY_CRITERIA.filter((key) => ['fail', 'unknown'].includes(ratings[key].rating));
  // P-019: name the rows that DRAG each blocking criterion. Each list is the population
  // the criterion's own branch above judged adverse or incomplete; a criterion blocked by
  // absence has no such row and is omitted rather than reported with an empty list.
  const draggingRows: Partial<Record<AdequacyCriterion, SpecEvidenceForAdequacy[]>> = {
    traceability: ephemeralEvidence.length > 0 ? ephemeralEvidence : unknownLineageEvidence,
    'fixture-calibration': [
      ...evidence.filter((row) => {
        const details = detailsOf(row);
        return details.fixtureCalibrated === false || details.fixtureFree === false;
      }),
      ...unresolvedFixtureProof,
    ],
    falsifiability: [
      ...evidence.filter((row) => detailsOf(row).falsifiable === false),
      ...mutationInCohortNotExecutable,
    ],
    'correct-layer': [
      ...evidence.filter((row) => detailsOf(row).pathReachable === false),
      ...planeBlockerRows,
    ],
    'oracle-independence': evidence.filter((row) => detailsOf(row).oracleIndependent === false),
    'execution-integrity': explicitBadExecution
      ? explicitBadExecutionRows
      : unbackedExecution.length > 0
        ? unbackedExecution
        : unmeasuredTestRunExecution.length > 0
          ? unmeasuredTestRunExecution
          : incompleteMeasuredExecution.length > 0
            ? incompleteMeasuredExecution
            : successfulExecution
              ? []
              : executable,
    freshness: evidence.some((row) => row.currentness.overall === 'stale')
      ? evidence.filter((row) => row.currentness.overall === 'stale')
      : evidence.filter((row) => row.currentness.overall === 'unknown'),
    'disclosed-gap': disclosedGapRows,
  };
  const draggingBindingIds: Partial<Record<AdequacyCriterion, number[]>> = {};
  for (const criterion of ADEQUACY_CRITERIA) {
    if (!wouldBlock.includes(criterion)) continue;
    const ids = [
      ...new Set(
        (draggingRows[criterion] ?? []).flatMap((row) => (Number.isSafeInteger(row.id) ? [row.id!] : [])),
      ),
    ].sort((a, b) => a - b);
    if (ids.length > 0) draggingBindingIds[criterion] = ids;
  }
  const verdict = wouldBlock.some((key) => ratings[key].rating === 'fail')
    ? 'fail'
    : wouldBlock.length > 0
      ? 'unknown'
      : 'pass';
  const evidenceRefs = [...new Set(evidence.map((row) => row.evidenceRef))].sort();
  const subjectRef = specTestAdequacySubjectRef(
    rerunRecipe.selection.planSlug,
    rerunRecipe.selection.specId,
    rerunRecipe.selection.specRevision,
  );
  const rawRefs = evidenceRefs.join(', ') || '(none)';
  const bodyRefs =
    rawRefs.length <= 7_000 ? rawRefs : `${rawRefs.slice(0, 6_980)}… (see evidenceRefs for the full set)`;
  const cardEvidence = scorecardBindingEvidence(ratings, [
    ...exactEvidence,
    ...disclosedGapRows,
    ...freeFormNoteRows,
  ], rerunRecipe);
  const replayInstructions =
    `Replay instructions: execute the card-level rerunRecipe (${rerunRecipe.evaluator}) once with its stored args. ` +
    'Compare each returned criterion rating with this card and the current evidence. Replay remeasures currentness at replay time, so freshness-dependent ratings can differ after evidence changes. ' +
    'It is not a historical as-of replay; grading-integrity audits reconstruct this card from its creation-time snapshot.';
  const cardBody = `Exact clause ${clause.planSlug}/${clause.specId}@${clause.revision}; fingerprint ${clause.contentHash}; work item evidence refs: ${bodyRefs}.\n\n${replayInstructions}`;
  // emit caps body at 8,000 characters. Keep the full shared proof in an existing
  // uncapped criterion evidence field when it cannot fit, with an explicit pointer
  // for every B reference. This changes presentation only, never evaluator ratings.
  const tableInBody = cardBody.length + cardEvidence.table.length <= 8_000;
  if (!tableInBody) {
    cardEvidence.ratings.traceability = {
      ...cardEvidence.ratings.traceability,
      evidence: cardEvidence.ratings.traceability.evidence + cardEvidence.table,
    };
  }
  return {
    planSlug: clause.planSlug,
    specId: clause.specId,
    specRevision: clause.revision,
    specFingerprint: clause.contentHash,
    planItemId: clause.planItemId,
    classRef,
    behaviorClass: clause.behaviorClass,
    evidenceRefs,
    ratings,
    requiredProofFloor: risk.floor,
    verdict,
    wouldBlock,
    draggingBindingIds,
    scorecardDraft: {
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      subject: { kind: 'plan', ref: subjectRef },
      title: `${clause.specId}@${clause.revision} test adequacy`,
      body: tableInBody
        ? cardBody + cardEvidence.table
        : cardBody + '\n\nShared binding evidence (B1, B2, ...) resolves in the traceability criterion evidence.',
      ratings: cardEvidence.ratings,
      rerunRecipe,
      terminal: true,
    },
  };
}

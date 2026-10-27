/**
 * scorecard-ledger-fill.ts — plan test-rubric-unification-2026-10-12 P-007 (R-7, D-004 rule 2).
 *
 * `scorecards:emit { fromLedger: true }` rates every EXECUTABLE criterion from its latest
 * results-ledger row and asks the grader only about the rest. "Executable" means the criterion
 * carries a check that writes ledger rows (P-006): a typed probe check, or an instrument check
 * bound to a command or opt-in scheduled platform evaluator in the registry. Manual (`none`),
 * subject-only platform and test/cargo checks are not ledger-backed here.
 *
 * Rules (each pinned by scorecard-ledger-fill.test.ts and emit-from-ledger.integration.test.ts):
 *   - only the LATEST row per check counts (readLatestRubricCheckResults orders by finished_at);
 *   - the criterion's CURRENT threshold is re-applied to the stored value (instrument `expect`,
 *     probe predicate), so a rubric edited after the row was recorded is judged by today's bar;
 *   - an executable criterion with no ledger result (or a row for a different unit) rates
 *     `unknown` with a reason and a next action, and is not asked of the grader;
 *   - a hand-typed rating for a ledger-owned criterion is accepted only when it agrees with the
 *     ledger (it may add remediation/disregard/suggestion); a disagreeing one is refused;
 *   - a poor ledger result is routed with a rating-free disposition (`dispositions`), so the
 *     grader never retypes a rating to satisfy the poor-rating disposition gate;
 *   - a manual criterion is never auto-rated: when its rating is missing the emit is refused with
 *     the exact keys to ask about.
 *
 * Pure: the ledger read is the caller's (emit injects it), so this module never touches a DB.
 */
import {
  OBSERVATION_RATING_SCALE,
  type ObservationLedgerResult,
  type ObservationRatingEntry,
  type ObservationRatings,
} from './harness/improvements/observation-types';
import {
  instrumentCheckId,
  meetsExpect,
  probeCheckId,
  probeCheckUnit,
  type LatestRubricCheckResult,
} from './check-results-ledger';
import { evaluateContinuityPredicate, type ContinuityPredicate } from './continuity-probes';
import { getRegisteredInstrument, isManualInstrumentKey } from './rubric-instrument-registry';
import { measurementProvenanceStatus } from './measurement-provenance';

export interface LedgerFillCriterion {
  key: string;
  check?: unknown;
  ratingScale?: string[];
}

export interface LedgerRatingBand {
  rating: string;
  expect: { op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number };
}

/** One ledger-backed check of a criterion: its ledger id and how to re-judge a stored value. */
export interface LedgerCheckBinding {
  id: string;
  kind: 'probe' | 'instrument';
  /** Probe: the child's current predicate. */
  predicate?: ContinuityPredicate;
  /** Instrument: the current threshold, in the instrument's unit. */
  expect?: { op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq'; value: number };
  /** Ordered intermediate ratings evaluated against the same stored numeric value. */
  ratingBands?: LedgerRatingBand[];
  /**
   * The unit a row must carry to describe this check: an instrument's registered unit, or the
   * unit a probe check declares (absent when it declares none).
   */
  unit?: string;
  /**
   * A scheduled platform instrument whose resolver reaches only a verdict records value
   * true/false with unit null instead of a quantity in `unit`; such a row still describes this check.
   */
  verdictRows?: boolean;
}

/** Whether a stored row describes this binding (its unit, or a platform verdict row). */
export function ledgerRowMatchesBinding(binding: LedgerCheckBinding, row: LatestRubricCheckResult): boolean {
  if (binding.unit === undefined || row.check.unit === binding.unit) return true;
  return binding.verdictRows === true && row.check.unit === null && typeof row.check.value === 'boolean';
}

type Verdict = 'pass' | 'fail' | 'error';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function ratingBandsOf(check: Record<string, unknown>): LedgerRatingBand[] | undefined {
  if (!Array.isArray(check.ratingBands)) return undefined;
  const bands = check.ratingBands.flatMap((value): LedgerRatingBand[] => {
    const band = record(value);
    const expect = record(band?.expect);
    if (
      typeof band?.rating !== 'string' ||
      typeof expect?.op !== 'string' ||
      !['lt', 'lte', 'gt', 'gte', 'eq'].includes(expect.op) ||
      typeof expect.value !== 'number' ||
      !Number.isFinite(expect.value)
    ) return [];
    return [{ rating: band.rating, expect: { op: expect.op as LedgerRatingBand['expect']['op'], value: expect.value } }];
  });
  return bands.length === check.ratingBands.length ? bands : undefined;
}

/**
 * The ledger checks a criterion executes, or null when it has none (manual, subject-only platform,
 * tests/cargo, or no check). Mirrors which checks P-006 writes rows for.
 */
export function ledgerCheckBindings(criterion: LedgerFillCriterion): LedgerCheckBinding[] | null {
  const check = record(criterion.check);
  if (!check) return null;
  const ratingBands = ratingBandsOf(check);
  if (check.kind === 'probe') {
    const children = Array.isArray(check.all) ? check.all : check.probe !== undefined ? [check.probe] : [];
    if (children.length === 0) return null;
    const unit = probeCheckUnit(check);
    return children.map((child, index) => {
      const expect = record(record(child)?.expect);
      return {
        id: probeCheckId(criterion.key, index),
        kind: 'probe' as const,
        ...(ratingBands ? { ratingBands } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(expect && typeof expect.op === 'string' && typeof expect.path === 'string'
          ? { predicate: expect as unknown as ContinuityPredicate }
          : {}),
      };
    });
  }
  if (check.kind === 'instrument') {
    const key = typeof check.instrumentKey === 'string' ? check.instrumentKey : null;
    if (!key || isManualInstrumentKey(key)) return null;
    const instrument = getRegisteredInstrument(key);
    if (!instrument || (instrument.evaluator !== 'command' &&
        !(instrument.evaluator === 'platform' && instrument.rescore))) return null;
    const expect = record(check.expect);
    return [{
      id: instrumentCheckId(criterion.key),
      kind: 'instrument',
      unit: instrument.evaluator === 'command' ? instrument.unit : instrument.rescore!.unit,
      ...(instrument.evaluator === 'platform' ? { verdictRows: true } : {}),
      ...(ratingBands ? { ratingBands } : {}),
      ...(expect && typeof expect.op === 'string' && typeof expect.value === 'number'
        ? { expect: { op: expect.op as NonNullable<LedgerCheckBinding['expect']>['op'], value: expect.value } }
        : {}),
    }];
  }
  return null;
}

/** Re-judge one stored row against the binding's CURRENT threshold. */
export function judgeLedgerRow(binding: LedgerCheckBinding, row: LatestRubricCheckResult): Verdict {
  if (row.status === 'error') return 'error';
  const value = row.check.value;
  if (binding.kind === 'instrument') {
    // A platform verdict row carries no quantity to re-apply a threshold to: its verdict stands.
    if (typeof value === 'boolean') return row.status;
    if (typeof value !== 'number') return 'error';
    return binding.expect ? (meetsExpect(value, binding.expect) ? 'pass' : 'fail') : row.status;
  }
  // A probe row stores the observed scalar at the predicate path (null when it was not scalar).
  // Re-apply the current predicate at the root of that scalar; a null value cannot be re-judged,
  // so the verdict recorded when the probe ran stands.
  if (binding.predicate && value !== null) {
    return evaluateContinuityPredicate({ ...binding.predicate, path: '$' }, value).matches ? 'pass' : 'fail';
  }
  return row.status;
}

function scaleOf(criterion: LedgerFillCriterion, rubricScale: readonly string[] | undefined): readonly string[] {
  const scale = criterion.ratingScale?.length ? criterion.ratingScale : rubricScale?.length ? rubricScale : OBSERVATION_RATING_SCALE;
  return scale;
}

/** Best level for a pass, worst non-unknown level for a fail (scales are ordered best-first). */
export function ledgerRatingLevel(verdict: 'pass' | 'fail', scale: readonly string[]): string {
  const levels = scale.filter((level) => level !== 'unknown');
  if (levels.length === 0) return verdict === 'pass' ? 'healthy' : 'broken';
  return verdict === 'pass' ? levels[0]! : levels[levels.length - 1]!;
}

function invalidRatingBands(bindings: readonly LedgerCheckBinding[], scale: readonly string[]): string | null {
  const levels = scale.filter((level) => level !== 'unknown');
  for (const binding of bindings) {
    const bands = binding.ratingBands;
    if (!bands?.length) continue;
    const seen = new Set<string>();
    let previousIndex = 0;
    for (const band of bands) {
      const index = levels.indexOf(band.rating);
      if (index <= 0 || index >= levels.length - 1 || seen.has(band.rating)) {
        return `rating band '${band.rating}' must name a unique intermediate level in the criterion's best-to-worst rating scale`;
      }
      if (index <= previousIndex) {
        return `rating bands for '${binding.id}' must be listed in the criterion's best-to-worst rating-scale order`;
      }
      seen.add(band.rating);
      previousIndex = index;
    }
  }
  return null;
}

function rateLedgerRow(
  binding: LedgerCheckBinding,
  row: LatestRubricCheckResult,
  scale: readonly string[],
): { verdict: Verdict; rating: string } {
  const verdict = judgeLedgerRow(binding, row);
  if (verdict === 'error') return { verdict, rating: 'unknown' };
  if (verdict === 'pass') return { verdict, rating: ledgerRatingLevel('pass', scale) };
  const value = row.check.value;
  if (typeof value === 'number') {
    const matched = binding.ratingBands?.find((band) => meetsExpect(value, band.expect));
    if (matched) return { verdict, rating: matched.rating };
  }
  return { verdict, rating: ledgerRatingLevel('fail', scale) };
}

/** How much of a row's measured detail ledger-filled evidence quotes. */
export const LEDGER_EVIDENCE_DETAIL_CHARS = 600;

function describeRow(binding: LedgerCheckBinding, row: LatestRubricCheckResult, verdict: Verdict, rating?: string): string {
  const unit = row.check.unit ? ` ${row.check.unit}` : '';
  const shown = typeof row.check.value === 'boolean'
    ? `verdict ${row.check.value ? 'pass' : 'fail'}`
    : `${JSON.stringify(row.check.value)}${unit}`;
  const rated = rating && rating !== verdict ? `; scorecard rating ${rating}` : '';
  // A non-passing row's measured detail is the evidence a reader checks the verdict against.
  const detail = verdict !== 'pass' && row.detail
    ? `; measured: ${row.detail.length > LEDGER_EVIDENCE_DETAIL_CHARS ? `${row.detail.slice(0, LEDGER_EVIDENCE_DETAIL_CHARS)}…` : row.detail}`
    : '';
  const p = row.check.provenance;
  const context = p
    ? `; provenance ${measurementProvenanceStatus(p)}, original window ${p.startedAt}..${p.finishedAt}, procedure sha256 ${p.procedure.sha256}${p.transactionAt ? `, transaction ${p.transactionAt}` : ''}`
    : '; provenance legacy-missing (original diagnostics/window not retained)';
  return `${binding.id}=${shown} → ${verdict}${rated} (test_runs #${row.testRunId}, ${row.finishedAt})${detail}${context}`;
}

function ledgerResultOf(row: LatestRubricCheckResult): ObservationLedgerResult {
  return { testRunId: row.testRunId, value: row.check.value, unit: row.check.unit,
    ...(row.check.provenance ? { provenance: row.check.provenance } : {}),
    provenanceStatus: measurementProvenanceStatus(row.check.provenance) };
}

/** Grader-owned fields a caller may add to a ledger-filled rating that agrees with the ledger. */
const GRADER_ANNOTATIONS = ['remediation', 'disregard', 'suggestion', 'attribution'] as const;

/**
 * The routing a grader owns for a ledger-rated criterion, supplied WITHOUT a rating: a poor
 * ledger result still needs an owned remediation or disregard, but never a retyped rating.
 */
export type LedgerDisposition = Partial<Pick<ObservationRatingEntry, (typeof GRADER_ANNOTATIONS)[number]>>;

function applyAnnotations(entry: ObservationRatingEntry, source: Partial<ObservationRatingEntry> | undefined): void {
  if (!source) return;
  for (const field of GRADER_ANNOTATIONS) {
    if (source[field] !== undefined) (entry as unknown as Record<string, unknown>)[field] = source[field];
  }
}

export type LedgerFillOutcome =
  | {
      ok: true;
      ratings: ObservationRatings;
      /** Criterion keys rated from a ledger row. */
      ledgerFilled: string[];
      /** Executable criteria with no usable ledger result, rated unknown and not asked. */
      unrecorded: string[];
    }
  | {
      ok: false;
      error: 'ledger_rating_contradicted' | 'manual_rating_missing' | 'ledger_disposition_unowned' | 'ledger_rating_bands_invalid';
      criterionKeys: string[];
      detail: string;
    };

export function fillRatingsFromLedger(input: {
  criteria: ReadonlyArray<LedgerFillCriterion>;
  rubricRatingScale?: readonly string[];
  /** The caller's ratings: required for manual criteria, optional (must agree) for executable ones. */
  callerRatings: Readonly<Record<string, ObservationRatingEntry>> | undefined;
  /** Latest ledger row per check id, from readLatestRubricCheckResults. */
  latest: ReadonlyMap<string, LatestRubricCheckResult>;
  /** Rating-free routing (remediation/disregard/…) for ledger-rated criteria. */
  dispositions?: Readonly<Record<string, LedgerDisposition>>;
}): LedgerFillOutcome {
  const caller = input.callerRatings ?? {};
  const dispositions = input.dispositions ?? {};
  // A disposition can only route a criterion the ledger rates; anywhere else it would be dropped.
  const unowned = Object.keys(dispositions).filter((key) => {
    const criterion = input.criteria.find((c) => c.key === key);
    return !criterion || ledgerCheckBindings(criterion) === null;
  });
  if (unowned.length > 0) {
    return {
      ok: false,
      error: 'ledger_disposition_unowned',
      criterionKeys: unowned,
      detail:
        `ledgerDispositions routes only criteria the results ledger rates; ${unowned.join(', ')} ` +
        'is not one. Put remediation/disregard for a manual criterion on its rating instead.',
    };
  }
  const ratings: ObservationRatings = {};
  const ledgerFilled: string[] = [];
  const unrecorded: string[] = [];
  const contradicted: string[] = [];
  const contradictions: string[] = [];
  const missingManual: string[] = [];

  for (const criterion of input.criteria) {
    const bindings = ledgerCheckBindings(criterion);
    if (!bindings) {
      const supplied = caller[criterion.key];
      if (supplied) ratings[criterion.key] = supplied;
      else missingManual.push(criterion.key);
      continue;
    }
    const ratingScale = scaleOf(criterion, input.rubricRatingScale);
    const invalidBands = invalidRatingBands(bindings, ratingScale);
    if (invalidBands) {
      return {
        ok: false,
        error: 'ledger_rating_bands_invalid',
        criterionKeys: [criterion.key],
        detail: `fromLedger cannot apply the ratingBands for '${criterion.key}': ${invalidBands}.`,
      };
    }
    const rows = bindings.map((binding) => {
      const row = input.latest.get(binding.id);
      // A row recorded under a different unit describes a different instrument binding.
      const usable = row && ledgerRowMatchesBinding(binding, row) ? row : undefined;
      return { binding, row: usable };
    });
    let entry: ObservationRatingEntry;
    if (rows.some((r) => r.row === undefined)) {
      const missing = rows.filter((r) => r.row === undefined).map((r) => r.binding.id);
      unrecorded.push(criterion.key);
      entry = {
        rating: 'unknown',
        unknownReason: 'not-exercised',
        evidence: `fromLedger: no ledger result for ${missing.join(', ')}; the criterion is executable, so it is not asked of the grader.`,
        nextEvidenceAction: `Run the criterion's check so it records a results-ledger row (${missing.join(', ')}), then re-emit with fromLedger.`,
      };
    } else {
      const judged = rows.map((r) => ({ ...r, row: r.row!, ...rateLedgerRow(r.binding, r.row!, ratingScale) }));
      const decidingError = judged.find((j) => j.verdict === 'error');
      const deciding = decidingError ?? judged.reduce((worst, current) => {
        const levels = ratingScale.filter((level) => level !== 'unknown');
        return levels.indexOf(current.rating) > levels.indexOf(worst.rating) ? current : worst;
      });
      const evidence = `fromLedger: ${judged.map((j) => describeRow(j.binding, j.row, j.verdict, j.rating)).join('; ')}`;
      const provenance = {
        ratedFrom: 'ledger' as const,
        ledgerResult: ledgerResultOf(deciding.row),
        evidenceRef: `test_runs:${deciding.row.testRunId}`,
        evidenceKind: 'test-run',
      };
      entry = deciding.verdict === 'error'
        ? {
            rating: 'unknown',
            unknownReason: 'instrument-unavailable',
            attribution: 'instrument',
            evidence,
            nextEvidenceAction: `Repair the measurement for ${deciding.binding.id} (its latest ledger row measured nothing) and re-run it.`,
            ...provenance,
          }
        : { rating: deciding.rating, evidence, ...provenance };
      ledgerFilled.push(criterion.key);
    }
    const supplied = caller[criterion.key];
    if (supplied) {
      if (supplied.rating.trim().toLowerCase() !== entry.rating.toLowerCase()) {
        contradicted.push(criterion.key);
        contradictions.push(`'${criterion.key}' rated '${supplied.rating}' but its ledger result rates '${entry.rating}'`);
        continue;
      }
      applyAnnotations(entry, supplied);
    }
    applyAnnotations(entry, dispositions[criterion.key]);
    ratings[criterion.key] = entry;
  }

  if (contradicted.length > 0) {
    return {
      ok: false,
      error: 'ledger_rating_contradicted',
      criterionKeys: contradicted,
      detail:
        `fromLedger rates executable criteria from their latest ledger result; ${contradictions.join('; ')}. ` +
        'Drop those hand ratings (or match the ledger), or re-run the check if the ledger is stale.',
    };
  }
  if (missingManual.length > 0) {
    return {
      ok: false,
      error: 'manual_rating_missing',
      criterionKeys: missingManual,
      detail:
        `fromLedger filled ${ledgerFilled.length} executable criteria; rate the remaining manual criteria ` +
        `yourself: ${missingManual.join(', ')}.`,
    };
  }
  return { ok: true, ratings, ledgerFilled, unrecorded };
}

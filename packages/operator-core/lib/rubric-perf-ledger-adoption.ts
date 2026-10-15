/**
 * Pure oracle for test-rubric-unification-2026-10-12 AUTO-BAR-R-10 (P-010):
 * "In the newest ledger-filled papercusp-app-performance scorecard, every criterion that
 * baseline EI-25797437572523561 measured by SQL or an instrument is rated from its latest
 * ledger check result recorded after the baseline."
 *
 * It lives in its own module, not in the test file, so a mutation of the oracle is a change
 * to SOURCE that the always-run controls in rubric-perf-ledger-adoption.live.test.ts must
 * catch (scripts/mutation-probe.sh). While the oracle sat inside the test file, no source
 * mutant could reach it and the bar had no clause-bound mutation proof.
 *
 * Population (fixed before counting): the ratings of the baseline scorecard whose rating is a
 * measurement — anything except `unknown` / `not-assessed`. N is reported, never hard-coded;
 * an empty population FAILS rather than passing vacuously.
 *
 * Property, per census criterion (each violation is named):
 *   rated        the subject card rates the criterion
 *   fromLedger   the rating says `ratedFrom: 'ledger'` and cites `ledgerResult.testRunId`
 *   real         that test_runs row exists, is a rubric check row for this rubric + criterion,
 *                and was recorded after the baseline card
 *   latest       no newer check row for the same criterion existed when the card was filed
 *   compared     the baseline entry and the ledger value + unit are both present, so the
 *                comparison table is complete for every census criterion
 */

export const PERF_RUBRIC_REF = 'papercusp-app-performance';
export const PERF_BASELINE_CARD = 'EI-25797437572523561';
const UNMEASURED_RATINGS = new Set(['unknown', 'not-assessed', 'not_assessed']);

export interface BaselineEntry {
  rating: string;
  evidence: string;
}

export interface LedgerRating {
  rating: string;
  ratedFrom?: string;
  ledgerResult?: { testRunId?: number | string; value?: unknown; unit?: string };
}

export interface CheckRow {
  testRunId: string;
  rubricRef: string;
  criterionKey: string;
  recordedAt: string;
  value: unknown;
  unit: string | null;
}

export interface AdoptionInput {
  baseline: { createdAt: string; ratings: Record<string, BaselineEntry> };
  subject: { id: string; createdAt: string; ratings: Record<string, LedgerRating> } | null;
  /** Every rubric check row for the rubric, any age. */
  checkRows: CheckRow[];
}

export interface AdoptionViolation {
  criterionKey: string;
  rule: 'population' | 'subject' | 'rated' | 'fromLedger' | 'real' | 'latest' | 'compared';
  detail: string;
}

export interface ComparisonRow {
  criterionKey: string;
  baselineRating: string;
  baselineEvidence: string;
  ledgerRating: string;
  ledgerValue: unknown;
  ledgerUnit: string | null;
}

/** The census population: baseline entries that carry a measurement. */
export function censusKeys(baseline: AdoptionInput['baseline']): string[] {
  return Object.entries(baseline.ratings)
    .filter(([, entry]) => !UNMEASURED_RATINGS.has(String(entry.rating).trim().toLowerCase()))
    .map(([key]) => key)
    .sort();
}

/** Pure oracle: every violation of the R-10 property, plus the baseline comparison table. */
export function checkLedgerAdoption(input: AdoptionInput): {
  population: string[];
  violations: AdoptionViolation[];
  comparison: ComparisonRow[];
} {
  const population = censusKeys(input.baseline);
  const violations: AdoptionViolation[] = [];
  const comparison: ComparisonRow[] = [];
  if (population.length === 0) {
    violations.push({ criterionKey: '*', rule: 'population', detail: 'the baseline census is empty' });
    return { population, violations, comparison };
  }
  const subject = input.subject;
  if (!subject) {
    violations.push({ criterionKey: '*', rule: 'subject', detail: 'no ledger-filled scorecard exists after the baseline' });
    return { population, violations, comparison };
  }
  const baselineAt = Date.parse(input.baseline.createdAt);
  const subjectAt = Date.parse(subject.createdAt);
  for (const key of population) {
    const base = input.baseline.ratings[key];
    const rating = subject.ratings[key];
    if (!rating) {
      violations.push({ criterionKey: key, rule: 'rated', detail: `${subject.id} does not rate ${key}` });
      continue;
    }
    const runId = rating.ledgerResult?.testRunId;
    if (rating.ratedFrom !== 'ledger' || runId === undefined || runId === null || String(runId) === '') {
      violations.push({
        criterionKey: key,
        rule: 'fromLedger',
        detail: `rating is not ledger-filled (ratedFrom=${String(rating.ratedFrom)}, testRunId=${String(runId)})`,
      });
      continue;
    }
    const rows = input.checkRows.filter((r) => r.rubricRef === PERF_RUBRIC_REF && r.criterionKey === key);
    const row = rows.find((r) => String(r.testRunId) === String(runId));
    if (!row) {
      violations.push({ criterionKey: key, rule: 'real', detail: `test_runs row ${String(runId)} is not a check row for ${key}` });
      continue;
    }
    const rowAt = Date.parse(row.recordedAt);
    if (!(rowAt > baselineAt)) {
      violations.push({ criterionKey: key, rule: 'real', detail: `check row ${row.testRunId} (${row.recordedAt}) predates the baseline` });
      continue;
    }
    const newer = rows.find((r) => {
      const at = Date.parse(r.recordedAt);
      return at > rowAt && at <= subjectAt;
    });
    if (newer) {
      violations.push({
        criterionKey: key,
        rule: 'latest',
        detail: `rated from ${row.testRunId} but ${newer.testRunId} (${newer.recordedAt}) was newer when the card was filed`,
      });
      continue;
    }
    if (row.value === null || row.value === undefined || !row.unit || !base?.evidence) {
      violations.push({ criterionKey: key, rule: 'compared', detail: 'baseline evidence or ledger value/unit missing' });
      continue;
    }
    comparison.push({
      criterionKey: key,
      baselineRating: base.rating,
      baselineEvidence: base.evidence.slice(0, 160),
      ledgerRating: rating.rating,
      ledgerValue: row.value,
      ledgerUnit: row.unit,
    });
  }
  return { population, violations, comparison };
}

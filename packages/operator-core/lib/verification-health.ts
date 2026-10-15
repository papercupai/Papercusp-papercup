/**
 * verification-system-improvements-2026-10-10 P-002 — the verification-health read.
 *
 * One read answers "is the verification system being used, and where is it failing?"
 * without anyone hand-writing SQL: contract coverage by cohort, the share of active
 * clauses with bound evidence, uncovered active plans (+ triage closures missing a
 * reason), the age histogram of the awaiting-acceptance backlog, forced ships and
 * VAL-* usage. It backs the `verification.health` state cell (cell-registrations.ts).
 *
 * SHAPE OF THE CODE (the acceptance-bar-census split, on purpose):
 *   - the SQL returns per-plan / per-group ROWS, never pre-aggregated numbers;
 *   - {@link buildVerificationHealth} is a PURE aggregation over those rows.
 * That is what makes the clause falsifier ("changing the fixture row behind any one
 * metric leaves that metric's reading unchanged") testable at the unit layer: a test
 * edits one fixture row and asserts exactly one metric moves.
 *
 * THE LANE-2 METRICS ARE NOT COMPUTED HERE (plan Decision D-018): uncoveredActivePlans,
 * uncoveredActivePlansRaw, closureReasonMissing, triageGaps and unreachablePlans come from
 * P-004's measureContractTriage, and the four staleAcceptance* counts (including
 * staleAcceptanceScopeExcluded) from P-005's measureStaleAcceptance. unreachablePlans and
 * staleAcceptanceScopeExcluded are pass-throughs with no threshold (D-033): they hold the
 * plans D-030 and D-029 (2) move OUT of the two probe readings, so dropping them would let
 * those plans vanish from the one-read surface. The storage behind them belongs to that lane, so this module
 * takes them as injected measures and never re-derives their SQL — two copies of a
 * definition (the 24h grace window, the 3-day surfacing grace) would drift.
 *
 * NEVER-NULL COUNTS (SPEC-P-002-VALUE-SHAPE): every count this module computes from its
 * own rows is an integer, including when no plan matches. The nullable values are:
 *   - `evidenceBoundShare` (no answer over zero active clauses — a vacuous 0/0 must not
 *     render as 0% or 100%) and `valLastWriteAt` (no rows, no time);
 *   - the two LIVE PROBE readings, D-019: `triageGaps` is null when the triage measure
 *     threw or examined zero active plans (`activePlansConsidered` 0 or not reported),
 *     and `staleAcceptanceUndispositioned` is null when the stale-acceptance measure threw
 *     or examined zero plans (`acceptancePlansConsidered` 0 or not reported). R-4/R-5
 *     probe these with `eq 0`, so a dead or misfiltered measurement must fail the probe
 *     instead of defaulting to a passing 0;
 *   - every lane-2 count when its measure THREW (`measurementErrors` names which): a
 *     measurement that did not happen has no value, and 0 would be a fabricated one.
 */

/** The minimal SQL surface this module needs; a postgres.js `Sql`/`TransactionSql` satisfies it. */
export interface VerificationHealthSql {
  unsafe<T = unknown>(query: string, values?: readonly unknown[]): Promise<T>;
}

export interface VerificationHealthOptions {
  workspaceId: string;
  /** Narrow to one harness. Omitted ⇒ the whole workspace (the default for the cell). */
  harnessSlug?: string | null;
  now?: Date;
}

/**
 * P-004 (lane 2) — measureContractTriage's contract, D-013/D-018/D-019. The denominator
 * is optional in the TYPE only so an older measure still plugs in; absent, the probe
 * reading is reported as unmeasured (null), never as a 0.
 */
export interface ContractTriageMeasure {
  uncoveredActivePlans: number;
  uncoveredActivePlansRaw: number;
  closureReasonMissing: number;
  triageGaps: number;
  /**
   * D-030/D-033: uncovered active plans whose harness has no Hive plan scope. They are moved
   * OUT of triageGaps, so the cell must carry them or they vanish from the one-read surface.
   */
  unreachablePlans: number;
  activePlansConsidered?: number;
}

/** P-005 (lane 2) — measureStaleAcceptance's contract, D-015/D-018/D-019 (denominator: as above). */
export interface StaleAcceptanceMeasure {
  staleAcceptanceSurfaced: number;
  staleAcceptanceNeverSurfaced: number;
  staleAcceptanceUndispositioned: number;
  /**
   * D-029 (2)/D-033: stale plans outside the workspace work-scope policy. Never a stall and
   * left out of staleAcceptanceUndispositioned, so the cell must carry them to stay visible.
   */
  staleAcceptanceScopeExcluded: number;
  acceptancePlansConsidered?: number;
}

const TRIAGE_COUNT_KEYS = [
  'uncoveredActivePlans',
  'uncoveredActivePlansRaw',
  'closureReasonMissing',
  'triageGaps',
  'unreachablePlans',
] as const;
const STALE_COUNT_KEYS = [
  'staleAcceptanceSurfaced',
  'staleAcceptanceNeverSurfaced',
  'staleAcceptanceUndispositioned',
  'staleAcceptanceScopeExcluded',
] as const;

export interface VerificationHealthMeasureArgs {
  workspaceId: string;
  harnessSlug?: string;
  now?: Date;
}

/** The lane-2 measurement functions, injected (D-018). `S` is whatever SQL handle the caller holds. */
export interface VerificationHealthMeasures<S = unknown> {
  measureContractTriage(sql: S, args: VerificationHealthMeasureArgs): Promise<ContractTriageMeasure>;
  measureStaleAcceptance(sql: S, args: VerificationHealthMeasureArgs): Promise<StaleAcceptanceMeasure>;
}

/** One non-archived plan, as returned by {@link VERIFICATION_HEALTH_PLANS_QUERY}. */
export interface VerificationHealthPlanRow {
  harness_slug: string;
  plan_slug: string;
  status: string | null;
  template: string | null;
  acceptance_bar_cohort: string | null;
  has_contract: boolean;
  forced: boolean;
  has_val_block: boolean;
  updated_at: Date | string | null;
  active_clauses: number | string | null;
  bound_clauses: number | string | null;
}

export const VERIFICATION_HEALTH_COHORTS = ['post-epoch', 'legacy-backfilled', 'none'] as const;
export type VerificationHealthCohort = (typeof VERIFICATION_HEALTH_COHORTS)[number];

/** Awaiting-acceptance backlog buckets, by days since the plan last changed. */
export const ACCEPTANCE_AGE_BUCKETS = [
  { key: 'd0to7', minDays: 0, maxDays: 7 },
  { key: 'd7to14', minDays: 7, maxDays: 14 },
  { key: 'd14to21', minDays: 14, maxDays: 21 },
  { key: 'd21to28', minDays: 21, maxDays: 28 },
  { key: 'd28plus', minDays: 28, maxDays: Number.POSITIVE_INFINITY },
] as const;
export type AcceptanceAgeBucket = (typeof ACCEPTANCE_AGE_BUCKETS)[number]['key'];

/**
 * Threshold alerts. A metric BREACHES when its value is strictly greater than the
 * threshold. Each one is the live bar of this plan: R-4 probes triageGaps, R-5
 * staleAcceptanceUndispositioned, SPEC-P-003-VAL-LIVE-CENSUS valBlockPlans — all `eq 0`.
 */
export const VERIFICATION_HEALTH_THRESHOLDS = {
  triageGaps: 0,
  staleAcceptanceUndispositioned: 0,
  valBlockPlans: 0,
} as const;
export type VerificationHealthBreachCode = keyof typeof VERIFICATION_HEALTH_THRESHOLDS;

export interface CohortCoverage {
  activePlans: number;
  withContract: number;
}

export interface VerificationHealth {
  /** Active plans per acceptance-bar cohort, and how many of them carry a requirement contract. */
  coverageByCohort: Record<VerificationHealthCohort, CohortCoverage>;
  activePlans: number;
  activePlansWithContract: number;
  /** Clauses whose current revision is active, on non-archived plans. */
  activeClauses: number;
  /** Of those, clauses with at least one unretracted evidence binding for the current revision. */
  activeClausesEvidenceBound: number;
  /** activeClausesEvidenceBound / activeClauses; NULL when activeClauses is 0 (no vacuous ratio). */
  evidenceBoundShare: number | null;
  /** Lane-2 triage counts (D-018); null only when measureContractTriage threw. */
  uncoveredActivePlans: number | null;
  uncoveredActivePlansRaw: number | null;
  closureReasonMissing: number | null;
  /** R-4 probe reading (D-019): null when the measure threw or examined zero active plans. */
  triageGaps: number | null;
  /** D-019 denominator: active plans the triage measurement examined; null when not reported. */
  activePlansConsidered: number | null;
  /**
   * D-030/D-033: uncovered active plans with no Hive plan scope (outside triageGaps). Not a
   * threshold of its own; null only when measureContractTriage threw.
   */
  unreachablePlans: number | null;
  awaitingAcceptancePlans: number;
  awaitingAcceptanceAgeDays: Record<AcceptanceAgeBucket, number>;
  /** Lane-2 stale-acceptance counts (D-018); null only when measureStaleAcceptance threw. */
  staleAcceptanceSurfaced: number | null;
  staleAcceptanceNeverSurfaced: number | null;
  /** R-5 probe reading (D-019): null when the measure threw or examined zero plans. */
  staleAcceptanceUndispositioned: number | null;
  /** D-019 denominator: in-scope plans the stale-acceptance measurement examined; null when not reported. */
  acceptancePlansConsidered: number | null;
  /**
   * D-029 (2)/D-033: stale plans excluded by the work-scope policy (a policy count the owner
   * changes by widening scope). Not a threshold; null only when measureStaleAcceptance threw.
   */
  staleAcceptanceScopeExcluded: number | null;
  /** Lane-2 measures that threw, with their messages. Empty when both ran. */
  measurementErrors: Array<{ measure: 'measureContractTriage' | 'measureStaleAcceptance'; message: string }>;
  /** Shipped plans that were force-shipped past a gate (harness_plans.forced_past set). */
  forcedShips: number;
  /**
   * VAL-* usage: non-archived plans whose content still carries an inline `[VAL-` block.
   * The retired VAL row store is deliberately NOT read here (R-3: no non-test reader).
   */
  valBlockPlans: number;
  /** Number of breached thresholds (the cell headline). */
  breaches: number;
  breachCodes: VerificationHealthBreachCode[];
  /** Thresholded metrics whose reading is null, so no breach verdict exists for them. */
  unmeasuredCodes: VerificationHealthBreachCode[];
}

/** `unmeasured`: nothing breached, but at least one thresholded reading is null. */
export type VerificationHealthAssessment = 'healthy' | 'breached' | 'unmeasured';

/**
 * The `verification.health` cell's assessment, pure over the two readings it decides on.
 * A breach outranks an unmeasured reading: a known-bad threshold is actionable even while
 * another reading is missing. Exported so cell-assessment-reality.test.ts drives the REAL
 * assessor through its control table instead of a hand-copied expression.
 */
export function assessVerificationHealth(
  health: Pick<VerificationHealth, 'breaches' | 'unmeasuredCodes'>,
): VerificationHealthAssessment {
  if (health.breaches > 0) return 'breached';
  return health.unmeasuredCodes.length > 0 ? 'unmeasured' : 'healthy';
}

export interface VerificationHealthReport {
  health: VerificationHealth;
  assessments: { verificationHealth: VerificationHealthAssessment };
  thresholds: typeof VERIFICATION_HEALTH_THRESHOLDS;
  scope: { workspaceId: string; harnessSlug: string | null };
  measuredAt: string;
}

/**
 * A `[VAL-` assertion BLOCK is a list-item header line (`  - **[VAL-<id>]**`), the same
 * grammar val-assertions.ts parses. Prose that merely mentions the token (this plan's own
 * text, retirement pointers) is not a block, so a raw `LIKE '%[VAL-%'` could never read 0.
 * POSIX ARE without the newline flag: `^` is string start, so `(^|\n)` anchors each line.
 */
export const VAL_BLOCK_HEADER_PG_PATTERN = '(^|\\n)[ \\t]{1,8}-[ \\t]+\\*{0,2}\\[VAL-';

/**
 * Per-plan rows. `has_contract` = at least one clause whose CURRENT revision is not
 * retired/exempt (the acceptance-bar-census definition of a contract). Clause counts
 * use lifecycle_status = 'active' on the current revision, and a binding counts only
 * when it targets that same revision and is not retracted.
 */
export const VERIFICATION_HEALTH_PLANS_QUERY = `
SELECT p.harness_slug, p.plan_slug, p.status, p.template, p.acceptance_bar_cohort,
       (p.forced_past IS NOT NULL) AS forced,
       (p.content ~ '${VAL_BLOCK_HEADER_PG_PATTERN}') AS has_val_block,
       p.updated_at,
       COALESCE(cl.contract_clauses, 0) > 0 AS has_contract,
       COALESCE(cl.active_clauses, 0) AS active_clauses,
       COALESCE(cl.bound_clauses, 0) AS bound_clauses
  FROM harness_shared.harness_plans p
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE rev.lifecycle_status NOT IN ('retired', 'exempt')) AS contract_clauses,
           count(*) FILTER (WHERE rev.lifecycle_status = 'active') AS active_clauses,
           count(*) FILTER (
             WHERE rev.lifecycle_status = 'active'
               AND EXISTS (
                 SELECT 1 FROM harness_shared.spec_evidence_bindings b
                  WHERE b.workspace_id = clause.workspace_id
                    AND b.harness_slug = clause.harness_slug
                    AND b.plan_slug = clause.plan_slug
                    AND b.spec_id = clause.spec_id
                    AND b.spec_revision = clause.current_revision
                    AND b.retracted_at IS NULL)
           ) AS bound_clauses
      FROM harness_shared.plan_spec_clauses clause
      JOIN harness_shared.plan_spec_clause_revisions rev
        ON rev.workspace_id = clause.workspace_id
       AND rev.harness_slug = clause.harness_slug
       AND rev.plan_slug = clause.plan_slug
       AND rev.spec_id = clause.spec_id
       AND rev.revision = clause.current_revision
     WHERE clause.workspace_id = p.workspace_id
       AND clause.harness_slug = p.harness_slug
       AND clause.plan_slug = p.plan_slug
  ) cl ON true
 WHERE p.workspace_id = $1
   AND ($2::text IS NULL OR p.harness_slug = $2)
   AND p.archived = false
 ORDER BY p.harness_slug, p.plan_slug`;

const DAY_MS = 86_400_000;

function toInt(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`verification-health: non-numeric count ${String(value)}`);
  return Math.trunc(n);
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function cohortOf(row: VerificationHealthPlanRow): VerificationHealthCohort {
  return row.acceptance_bar_cohort === 'post-epoch' || row.acceptance_bar_cohort === 'legacy-backfilled'
    ? row.acceptance_bar_cohort
    : 'none';
}

function ageBucket(ageDays: number): AcceptanceAgeBucket {
  for (const bucket of ACCEPTANCE_AGE_BUCKETS) {
    if (ageDays >= bucket.minDays && ageDays < bucket.maxDays) return bucket.key;
  }
  return 'd0to7'; // negative age (clock skew): newest bucket, never dropped
}

/**
 * Validates the DECLARED count keys only — a measure may carry extra metadata (lane 2's
 * measureStaleAcceptance also returns its `thresholds` object), which is not a count.
 */
function assertMeasureInts(label: string, measure: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = measure[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`verification-health: ${label}.${key} is not an integer (${String(value)}) — refusing to report it`);
    }
  }
}

/** A reported denominator: a non-negative integer, else null (absent or malformed is unmeasured). */
function denominatorOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** D-019: a probe reading over an empty or unreported population is null, never a passing 0. */
function probeReading(value: number, considered: number | null): number | null {
  return considered == null || considered === 0 ? null : value;
}

/**
 * Pure aggregation over the query rows plus the injected lane-2 measures. A measure is
 * passed as `null` when it threw; its counts then read null (see the module header).
 */
export function buildVerificationHealth(input: {
  plans: readonly VerificationHealthPlanRow[];
  triage: ContractTriageMeasure | null;
  staleAcceptance: StaleAcceptanceMeasure | null;
  measurementErrors?: VerificationHealth['measurementErrors'];
  now: Date;
}): VerificationHealth {
  const triage = input.triage;
  const stale = input.staleAcceptance;
  if (triage) assertMeasureInts('measureContractTriage', { ...triage }, TRIAGE_COUNT_KEYS);
  if (stale) assertMeasureInts('measureStaleAcceptance', { ...stale }, STALE_COUNT_KEYS);
  const activePlansConsidered = triage ? denominatorOf(triage.activePlansConsidered) : null;
  const acceptancePlansConsidered = stale ? denominatorOf(stale.acceptancePlansConsidered) : null;
  const triageGaps = triage ? probeReading(triage.triageGaps, activePlansConsidered) : null;
  const staleAcceptanceUndispositioned = stale
    ? probeReading(stale.staleAcceptanceUndispositioned, acceptancePlansConsidered)
    : null;

  const coverageByCohort = Object.fromEntries(
    VERIFICATION_HEALTH_COHORTS.map((c) => [c, { activePlans: 0, withContract: 0 }]),
  ) as Record<VerificationHealthCohort, CohortCoverage>;
  const awaitingAcceptanceAgeDays = Object.fromEntries(
    ACCEPTANCE_AGE_BUCKETS.map((b) => [b.key, 0]),
  ) as Record<AcceptanceAgeBucket, number>;

  let activePlans = 0;
  let activePlansWithContract = 0;
  let activeClauses = 0;
  let activeClausesEvidenceBound = 0;
  let awaitingAcceptancePlans = 0;
  let forcedShips = 0;
  let valBlockPlans = 0;
  const nowMs = input.now.getTime();

  for (const row of input.plans) {
    if (row.has_val_block) valBlockPlans += 1;
    // Rubric rows are graded instruments, not plans under a contract.
    if (row.template === 'rubric') continue;
    activeClauses += toInt(row.active_clauses);
    activeClausesEvidenceBound += toInt(row.bound_clauses);
    if (row.status === 'active') {
      activePlans += 1;
      const cohort = coverageByCohort[cohortOf(row)];
      cohort.activePlans += 1;
      if (row.has_contract) {
        activePlansWithContract += 1;
        cohort.withContract += 1;
      }
    } else if (row.status === 'awaiting-acceptance') {
      awaitingAcceptancePlans += 1;
      const updated = toTime(row.updated_at);
      const ageDays = updated == null ? Number.POSITIVE_INFINITY : (nowMs - updated) / DAY_MS;
      awaitingAcceptanceAgeDays[ageBucket(ageDays)] += 1;
    } else if (row.status === 'shipped' && row.forced) {
      forcedShips += 1;
    }
  }

  const metricValues: Record<VerificationHealthBreachCode, number | null> = {
    triageGaps,
    staleAcceptanceUndispositioned,
    valBlockPlans,
  };
  const thresholdCodes = Object.keys(VERIFICATION_HEALTH_THRESHOLDS) as VerificationHealthBreachCode[];
  const breachCodes = thresholdCodes.filter((code) => {
    const value = metricValues[code];
    return value != null && value > VERIFICATION_HEALTH_THRESHOLDS[code];
  });
  const unmeasuredCodes = thresholdCodes.filter((code) => metricValues[code] == null);

  return {
    coverageByCohort,
    activePlans,
    activePlansWithContract,
    activeClauses,
    activeClausesEvidenceBound,
    evidenceBoundShare: activeClauses === 0 ? null : activeClausesEvidenceBound / activeClauses,
    uncoveredActivePlans: triage ? triage.uncoveredActivePlans : null,
    uncoveredActivePlansRaw: triage ? triage.uncoveredActivePlansRaw : null,
    closureReasonMissing: triage ? triage.closureReasonMissing : null,
    triageGaps,
    activePlansConsidered,
    unreachablePlans: triage ? triage.unreachablePlans : null,
    awaitingAcceptancePlans,
    awaitingAcceptanceAgeDays,
    staleAcceptanceSurfaced: stale ? stale.staleAcceptanceSurfaced : null,
    staleAcceptanceNeverSurfaced: stale ? stale.staleAcceptanceNeverSurfaced : null,
    staleAcceptanceUndispositioned,
    acceptancePlansConsidered,
    staleAcceptanceScopeExcluded: stale ? stale.staleAcceptanceScopeExcluded : null,
    measurementErrors: input.measurementErrors ?? [],
    forcedShips,
    valBlockPlans,
    breaches: breachCodes.length,
    breachCodes,
    unmeasuredCodes,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Runs the two queries and the two lane-2 measures, then aggregates. The module's OWN
 * queries are total — if either fails the whole read throws (no default can stand in).
 * A lane-2 measure that throws is isolated: its readings go null and the error is named
 * in `measurementErrors` (D-019), so one dead measure cannot blank the other metrics.
 */
export async function runVerificationHealth<S extends VerificationHealthSql>(
  sql: S,
  options: VerificationHealthOptions,
  measures: VerificationHealthMeasures<S>,
): Promise<VerificationHealthReport> {
  const now = options.now ?? new Date();
  const harnessSlug = options.harnessSlug ?? null;
  const measureArgs: VerificationHealthMeasureArgs = {
    workspaceId: options.workspaceId,
    ...(harnessSlug ? { harnessSlug } : {}),
    now,
  };
  const [plans, triageResult, staleResult] = await Promise.all([
    sql.unsafe<VerificationHealthPlanRow[]>(VERIFICATION_HEALTH_PLANS_QUERY, [options.workspaceId, harnessSlug]),
    measures.measureContractTriage(sql, measureArgs).then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    ),
    measures.measureStaleAcceptance(sql, measureArgs).then(
      (value) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    ),
  ]);
  const measurementErrors: VerificationHealth['measurementErrors'] = [];
  if (!triageResult.ok) measurementErrors.push({ measure: 'measureContractTriage', message: errorMessage(triageResult.reason) });
  if (!staleResult.ok) measurementErrors.push({ measure: 'measureStaleAcceptance', message: errorMessage(staleResult.reason) });
  const health = buildVerificationHealth({
    plans,
    triage: triageResult.ok ? triageResult.value : null,
    staleAcceptance: staleResult.ok ? staleResult.value : null,
    measurementErrors,
    now,
  });
  return {
    health,
    assessments: { verificationHealth: assessVerificationHealth(health) },
    thresholds: VERIFICATION_HEALTH_THRESHOLDS,
    scope: { workspaceId: options.workspaceId, harnessSlug },
    measuredAt: now.toISOString(),
  };
}

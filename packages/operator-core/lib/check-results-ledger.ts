/**
 * check-results-ledger — every executed rubric probe or instrument check gets one row in the
 * same results ledger that holds test-file and test-case rows (harness_shared.test_runs).
 *
 * Plan test-rubric-unification-2026-10-12 P-006 (R-6), bound by D-004 rule 1:
 *   - framework = 'rubric-check' (no new table; the row sits beside vitest rows and their
 *     test_case_runs children, so a check has the same history surface a test has);
 *   - execution_details.check = { id, rubricRef, criterionKey, kind, value, unit[, expect] },
 *     parsed by the shared strict reader in @papercusp/test-config/execution-details;
 *   - file_path = `rubric-check/<rubricRef>/<check id>`, so latest-per-file reads give the
 *     latest result per CHECK, and a check's history is one file_path's rows.
 *
 * Status mapping: a probe predicate match or an instrument reading inside its threshold is
 * 'pass'; outside it, 'fail'; an instrument that measured nothing (command failed, output did
 * not parse) is 'error' with value null — never a silent 0. An instrument without a declared
 * threshold records its reading as 'pass' with no `expect`: executed, nothing asserted. The
 * ledger-filled scorecard path (P-007) treats that row as measured-but-unjudged.
 *
 * A scheduled platform instrument records the quantity its resolver measured, in the
 * instrument's declared unit. A resolver that only reaches a verdict records value true/false
 * with unit null. A pass bit stored as 0/1 under a quantity unit read as the opposite of the
 * measurement (224 stranded read as "0 count"), so it is never written that way
 * (WI-6554700010018719).
 *
 * Reuse: the probe results come from evaluateCriterionProbeChecks' existing check runs, and the
 * instrument readings from rubric-instrument-registry's runInstrument (P-005). This module adds
 * only the mapping, the insert, and the latest-result read.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  RUBRIC_CHECK_FRAMEWORK,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  parseRecordedRubricCheck,
  parseTestRunExecutionDetails,
  type RecordedRubricCheck,
  type RecordedRubricCheckExpect,
  type TestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';
import type { ScorecardProbeCheckRun } from './harness/improvements/observation-types';
import {
  getRegisteredInstrument,
  isManualInstrumentKey,
  runInstrument,
  type InstrumentReading,
  type PlatformInstrument,
} from './rubric-instrument-registry';

export { RUBRIC_CHECK_FRAMEWORK };

type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

export type RubricCheckVerdict = 'pass' | 'fail' | 'error';

export interface RubricCheckResult {
  check: RecordedRubricCheck;
  verdict: RubricCheckVerdict;
  /** ISO instant the value was measured. */
  measuredAt: string;
  durationMs: number | null;
  /** Why nothing was measured (verdict 'error'), or what a 'fail' observed. */
  detail?: string;
}

export interface RubricCheckLedgerScope {
  workspaceId: string | null;
  harnessSlug: string | null;
  /** Checkout root the check ran from; execution_details requires one. Defaults to process.cwd(). */
  root?: string;
  runGroupId?: string | null;
  commitSha?: string | null;
}

/** One ledger "file" per check, so latest-per-file is latest-per-check. */
export function rubricCheckLedgerPath(rubricRef: string, checkId: string): string {
  return `rubric-check/${rubricRef}/${checkId}`;
}

export function probeCheckId(criterionKey: string, childIndex: number): string {
  return `${criterionKey}:${childIndex}`;
}

/**
 * The unit a probe check declares for the scalar its probes read (rubric-template probe check
 * `unit`), or undefined when it declares none. Shared by the ledger writer and the ledger judge so
 * a row and the check it describes agree on the unit.
 */
export function probeCheckUnit(check: unknown): string | undefined {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return undefined;
  const c = check as { kind?: unknown; unit?: unknown };
  if (c.kind !== 'probe' || typeof c.unit !== 'string') return undefined;
  const unit = c.unit.trim();
  return unit.length > 0 ? unit : undefined;
}

export function instrumentCheckId(criterionKey: string): string {
  return `${criterionKey}:instrument`;
}

/** Judge a reading against a threshold in the reading's own unit. */
export function meetsExpect(value: number, expect: RecordedRubricCheckExpect): boolean {
  switch (expect.op) {
    case 'lt': return value < expect.value;
    case 'lte': return value <= expect.value;
    case 'gt': return value > expect.value;
    case 'gte': return value >= expect.value;
    case 'eq': return value === expect.value;
  }
}

/** Predicate ops that compare a reading against a threshold; a NULL reading cannot be compared. */
const ORDERING_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

/** The predicate op of one executed probe child (its `probe.expect.op`), or null when absent. */
function probePredicateOp(child: { probe?: unknown }): string | null {
  const probe = child.probe;
  if (!probe || typeof probe !== 'object') return null;
  const expect = (probe as { expect?: unknown }).expect;
  if (!expect || typeof expect !== 'object') return null;
  const op = (expect as { op?: unknown }).op;
  return typeof op === 'string' ? op : null;
}

function scalarOrNull(value: unknown): string | number | boolean | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

/**
 * Map scorecards:emit's executed probe check runs (keyed by criterion) to ledger results — one
 * per executed probe, so a grouped `all` check yields one result per child.
 */
export function probeCheckResults(
  rubricRef: string,
  checkRuns: Readonly<Record<string, { kind: string }>>,
  criteria: ReadonlyArray<{ key: string; check?: unknown }> = [],
): RubricCheckResult[] {
  const out: RubricCheckResult[] = [];
  const unitByKey = new Map(criteria.map((c) => [c.key, probeCheckUnit(c.check)]));
  for (const [criterionKey, run] of Object.entries(checkRuns)) {
    if (run.kind !== 'probe') continue;
    const probeRun = run as ScorecardProbeCheckRun;
    const children = 'all' in probeRun ? probeRun.all : [probeRun];
    const unit = unitByKey.get(criterionKey) ?? null;
    children.forEach((child, childIndex) => {
      const value = scalarOrNull(child.observed);
      // An ordering comparison (gt/gte/lt/lte) against a missing, NULL or boolean reading measured
      // nothing: the probe ran, but there was no value to compare. Record it as 'error' (unknown),
      // the same as an instrument reading of null, never as a 'fail', which grades the criterion at
      // its WORST level for a window in which the measured thing simply did not happen.
      const op = probePredicateOp(child);
      if (child.verdict === 'fail' && op !== null && ORDERING_OPS.has(op) && (value === null || typeof value === 'boolean')) {
        out.push({
          check: { id: probeCheckId(criterionKey, childIndex), rubricRef, criterionKey, kind: 'probe', value, unit },
          verdict: 'error',
          measuredAt: child.measuredAt,
          durationMs: null,
          detail: `probe measured nothing: '${op}' needs a number or string, observed ${JSON.stringify(child.observed ?? null)}`,
        });
        return;
      }
      out.push({
        check: { id: probeCheckId(criterionKey, childIndex), rubricRef, criterionKey, kind: 'probe', value, unit },
        verdict: child.verdict,
        measuredAt: child.measuredAt,
        durationMs: null,
        ...(child.verdict === 'fail' ? { detail: `probe predicate did not match (observed ${JSON.stringify(value)})` } : {}),
      });
    });
  }
  return out;
}

/** Map one instrument reading to a ledger result, judged against the criterion's threshold. */
export function instrumentCheckResult(input: {
  rubricRef: string;
  criterionKey: string;
  reading: InstrumentReading;
  expect?: RecordedRubricCheckExpect;
  durationMs?: number | null;
}): RubricCheckResult {
  const { reading, expect } = input;
  const check: RecordedRubricCheck = {
    id: instrumentCheckId(input.criterionKey),
    rubricRef: input.rubricRef,
    criterionKey: input.criterionKey,
    kind: 'instrument',
    value: reading.value,
    unit: reading.unit,
    ...(expect ? { expect: { op: expect.op, value: expect.value } } : {}),
  };
  const base = { check, measuredAt: reading.measuredAt, durationMs: input.durationMs ?? null };
  if (reading.value === null) {
    return { ...base, verdict: 'error', detail: `instrument '${reading.key}' measured nothing: ${reading.error ?? 'no value'}` };
  }
  if (!expect || meetsExpect(reading.value, expect)) return { ...base, verdict: 'pass' };
  return {
    ...base,
    verdict: 'fail',
    detail: `instrument '${reading.key}' read ${reading.value}${reading.unit}, expected ${expect.op} ${expect.value}${reading.unit}`,
  };
}

interface InstrumentCheckedCriterion {
  key: string;
  check?: { kind: string; instrumentKey?: string; expect?: RecordedRubricCheckExpect } | null;
}

/**
 * Execute command checks and opt-in scheduled platform checks. Subject-only platform
 * instruments stay with scorecards:emit; a scheduled resolver requires canonical workspace scope.
 */
export async function runInstrumentChecks(input: {
  rubricRef: string;
  criteria: ReadonlyArray<InstrumentCheckedCriterion>;
  run?: (key: string) => Promise<InstrumentReading>;
  now?: () => number;
  workspaceId?: string | null;
  harnessSlug?: string | null;
  resolvePlatform?: NonNullable<PlatformInstrument['rescore']>['resolve'];
}): Promise<RubricCheckResult[]> {
  const run = input.run ?? ((key: string) => runInstrument(key));
  const now = input.now ?? Date.now;
  const out: RubricCheckResult[] = [];
  const windowEndMs = now();
  for (const criterion of input.criteria) {
    const check = criterion.check;
    if (check?.kind !== 'instrument' || !check.instrumentKey || isManualInstrumentKey(check.instrumentKey)) continue;
    const instrument = getRegisteredInstrument(check.instrumentKey);
    if (!instrument) continue;
    if (instrument.evaluator === 'platform' && instrument.rescore) {
      const started = now();
      const measuredAt = new Date(windowEndMs).toISOString();
      const window = {
        workspaceId: input.workspaceId ?? '',
        ...(input.harnessSlug?.trim() ? { harnessSlug: input.harnessSlug.trim() } : {}),
        windowStart: new Date(windowEndMs - instrument.rescore.windowMs).toISOString(),
        windowEnd: measuredAt,
      };
      let verdict: RubricCheckVerdict = 'error';
      let detail = 'A canonical workspace and any required rubric harness are required for a scheduled platform instrument.';
      let value: number | boolean | null = null;
      let unit: string | null = instrument.rescore.unit;
      if (window.workspaceId.trim() && (instrument.rescore.scope !== 'harness' || window.harnessSlug)) {
        try {
          const result = await (input.resolvePlatform ?? instrument.rescore.resolve)(window);
          verdict = result.verdict === 'unknown' ? 'error' : result.verdict;
          detail = result.detail;
          if (verdict !== 'error') {
            if (typeof result.value === 'number' && Number.isFinite(result.value)) {
              value = result.value;
            } else {
              // Verdict only: record the verdict itself, never a 0/1 under a quantity unit.
              value = verdict === 'pass';
              unit = null;
            }
          }
        } catch (error) {
          detail = `Scheduled instrument unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      out.push({
        check: { id: instrumentCheckId(criterion.key), rubricRef: input.rubricRef,
          criterionKey: criterion.key, kind: 'instrument', value, unit,
          ...(check.expect ? { expect: check.expect } : {}) },
        verdict, measuredAt, durationMs: Math.max(0, now() - started), detail,
      });
      continue;
    }
    if (instrument.evaluator !== 'command') continue;
    const started = now();
    let reading: InstrumentReading;
    try {
      reading = await run(check.instrumentKey);
    } catch (error) {
      reading = {
        key: instrument.key, unit: instrument.unit, argv: instrument.argv, value: null,
        measuredAt: new Date(now()).toISOString(), error: error instanceof Error ? error.message : String(error),
      };
    }
    out.push(instrumentCheckResult({
      rubricRef: input.rubricRef,
      criterionKey: criterion.key,
      reading,
      ...(check.expect ? { expect: check.expect } : {}),
      durationMs: Math.max(0, now() - started),
    }));
  }
  return out;
}

export interface RubricCheckLedgerRow {
  filePath: string;
  framework: typeof RUBRIC_CHECK_FRAMEWORK;
  status: RubricCheckVerdict;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string;
  outputTail: string | null;
  runGroupId: string | null;
  commitSha: string | null;
  harnessSlug: string | null;
  workspaceId: string | null;
  executionDetails: TestRunExecutionDetails;
}

/** Build the test_runs row for one check result. Throws if the details would not read back. */
export function buildRubricCheckLedgerRow(result: RubricCheckResult, scope: RubricCheckLedgerScope): RubricCheckLedgerRow {
  const filePath = rubricCheckLedgerPath(result.check.rubricRef, result.check.id);
  const finishedAt = result.measuredAt;
  const startedAt = result.durationMs === null
    ? finishedAt
    : new Date(Date.parse(finishedAt) - result.durationMs).toISOString();
  const executionDetails: TestRunExecutionDetails = {
    schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
    root: scope.root ?? process.cwd(),
    filePath,
    runGroupId: scope.runGroupId ?? null,
    workspaceId: scope.workspaceId,
    harnessSlug: scope.harnessSlug,
    testNamePattern: null,
    passed: result.verdict === 'pass' ? 1 : 0,
    failed: result.verdict === 'pass' ? 0 : 1,
    skipped: 0,
    collectionFailed: false,
    mutationPhase: null,
    commitSha: scope.commitSha ?? null,
    worktreeDirty: false,
    check: result.check,
  };
  // The reader is strict: refuse to write a row testing:runs would report as unreadable.
  if (!parseTestRunExecutionDetails(executionDetails) || !parseRecordedRubricCheck(result.check)) {
    throw new Error(`rubric check '${result.check.id}' of '${result.check.rubricRef}' does not form a readable ledger row`);
  }
  return {
    filePath,
    framework: RUBRIC_CHECK_FRAMEWORK,
    status: result.verdict,
    durationMs: result.durationMs,
    startedAt,
    finishedAt,
    outputTail: result.verdict === 'pass' ? null : (result.detail ?? null),
    runGroupId: scope.runGroupId ?? null,
    commitSha: scope.commitSha ?? null,
    harnessSlug: scope.harnessSlug,
    workspaceId: scope.workspaceId,
    executionDetails,
  };
}

/**
 * Write one ledger row per result; returns the test_runs ids in result order. Rows are written
 * individually (the result set is small: one per executed check) so each id pairs with its check.
 */
export async function recordRubricCheckResults(
  results: ReadonlyArray<RubricCheckResult>,
  scope: RubricCheckLedgerScope,
  sql: SqlLike = getOrgPg().sql as unknown as SqlLike,
): Promise<number[]> {
  const rows = results.map((result) => buildRubricCheckLedgerRow(result, scope));
  const ids: number[] = [];
  for (const row of rows) {
    const inserted = (await sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id,
         source, commit_sha, harness_slug, workspace_id, worktree_dirty, execution_details)
      VALUES
        (${row.filePath}, ${row.framework}, ${row.status}, ${row.durationMs}, ${row.startedAt}, ${row.finishedAt},
         ${row.outputTail}, ${row.runGroupId}, 'local', ${row.commitSha}, ${row.harnessSlug}, ${row.workspaceId},
         false, ${row.executionDetails as unknown as Record<string, unknown>})
      RETURNING id
    `) as Array<{ id: number | string }>;
    ids.push(Number(inserted[0]!.id));
  }
  return ids;
}

/** What a caller reports after trying to record executed checks: ids, or why nothing was written. */
export type CheckLedgerOutcome =
  | { recorded: number; testRunIds: number[] }
  | { recorded: 0; error: string };

/**
 * Record executed checks without letting a ledger fault change the caller's verdict: the check
 * already ran and its result is already in hand, so a failed write is REPORTED (error), not thrown.
 */
export async function recordCheckResultsReported(
  results: ReadonlyArray<RubricCheckResult>,
  scope: RubricCheckLedgerScope,
  record: typeof recordRubricCheckResults = recordRubricCheckResults,
): Promise<CheckLedgerOutcome | null> {
  if (results.length === 0) return null;
  try {
    const testRunIds = await record(results, scope);
    return { recorded: testRunIds.length, testRunIds };
  } catch (error) {
    return { recorded: 0, error: `results-ledger write failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface LatestRubricCheckResult {
  testRunId: number;
  check: RecordedRubricCheck;
  status: RubricCheckVerdict;
  finishedAt: string;
  /**
   * The row's output_tail: what a non-passing check measured (a platform resolver's detail, an
   * instrument's out-of-threshold reading). readLatestRubricCheckResults always sets it; null on
   * a passing row. Ledger-filled evidence quotes it so a verdict row still shows the measurement.
   */
  detail?: string | null;
}

/**
 * The latest ledger row for every check of a rubric in one workspace, keyed by check id. Rows
 * whose details no longer parse are skipped rather than guessed at.
 */
export async function readLatestRubricCheckResults(
  input: { rubricRef: string; workspaceId: string | null },
  sql: SqlLike = getOrgPg().sql as unknown as SqlLike,
): Promise<Map<string, LatestRubricCheckResult>> {
  const prefix = `rubric-check/${input.rubricRef}/`;
  const rows = (await sql`
    SELECT DISTINCT ON (file_path) id, file_path, status, finished_at, output_tail, execution_details
      FROM harness_shared.test_runs
     WHERE framework = ${RUBRIC_CHECK_FRAMEWORK}
       AND workspace_id IS NOT DISTINCT FROM ${input.workspaceId}
       AND left(file_path, ${prefix.length}) = ${prefix}
       AND status IN ('pass', 'fail', 'error')
     ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
  `) as Array<{
    id: number | string; file_path: string; status: string; finished_at: Date | string | null;
    output_tail: string | null; execution_details: unknown;
  }>;
  const out = new Map<string, LatestRubricCheckResult>();
  for (const row of rows) {
    const check = parseTestRunExecutionDetails(row.execution_details)?.check;
    if (!check || check.rubricRef !== input.rubricRef) continue;
    out.set(check.id, {
      testRunId: Number(row.id),
      check,
      status: row.status as RubricCheckVerdict,
      finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at),
      detail: typeof row.output_tail === 'string' && row.output_tail.length > 0 ? row.output_tail : null,
    });
  }
  return out;
}

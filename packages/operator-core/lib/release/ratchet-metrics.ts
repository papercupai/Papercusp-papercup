/**
 * RATCHET METRICS AND ALARM (green-main-ratchet-convergence-2026-10-17 P-010, R-9; owner R7).
 *
 * The ratchet (P-004) lets a failing test stop blocking main only through an owned downgrade.
 * That is debt, and it must stay visible. Over a trailing window (24h) this module reports:
 *   - downgraded tests currently failing (active downgrade rows whose test is red now);
 *   - downgrades and flaky quarantines created in the window (per day);
 *   - failures introduced vs fixed in the window: a test red at the end and not red at the
 *     start is introduced; red at the start and green at the end is fixed. Comparing the
 *     window's two end states (not every transition) keeps a flapping test from counting
 *     as many introductions.
 * and it ALARMS when any of these holds:
 *   - introductions exceed fixes over the window;
 *   - the active downgrade count grew over the window (downgrade debt grows);
 *   - the downgraded-failing count grew over the window.
 *
 * The alarm is a rubric check: `RATCHET_METRICS_INSTRUMENT_KEY` is a scheduled platform
 * instrument (rubric-instrument-registry.ts), so the rubric-rescore routine measures it and
 * writes the verdict to the results ledger (check-results-ledger.ts, harness_shared.test_runs)
 * — `fail` is the alarm. `recordRatchetMetrics` records one result directly for callers that
 * measure outside the rescore loop.
 *
 * Data. Test verdicts are the gate's own clean-tree rows (`test_runs`, source 'ci', no dirty
 * tree) under the install's checkpoint tree (`<slug>-checkpoint`, sibling-tree-root.ts), so
 * agents' local runs never move the metric. Downgrades come from harness_shared.test_downgrades.
 */

export const RATCHET_METRICS_INSTRUMENT_KEY = 'release:ratchet-metrics';
export const RATCHET_METRICS_WINDOW_MS = 24 * 60 * 60_000;

export interface RatchetTestRun {
  /** Repo-relative test file. */
  file: string;
  atMs: number;
  /** false = fail or error, true = pass. Skips are not verdicts and are left out by the reader. */
  pass: boolean;
}

export interface RatchetDowngradeRow {
  kind: 'downgrade' | 'flaky-quarantine';
  testFile: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

export type RatchetAlarm = 'introductions-exceed-fixes' | 'downgrade-debt-grew' | 'downgraded-failing-grew';

export interface RatchetMetrics {
  windowStartMs: number;
  windowEndMs: number;
  /** Active downgrades (both kinds) whose test file is red at the window end. */
  downgradedFailing: number;
  downgradedFailingAtStart: number;
  activeDowngrades: number;
  activeDowngradesAtStart: number;
  downgradesInWindow: number;
  quarantinesInWindow: number;
  /** Scaled to a 24h day so a non-24h window still reads per day. */
  downgradesPerDay: number;
  introduced: string[];
  fixed: string[];
  /** Test files with any verdict at or before the window end: the measured population. */
  measuredFiles: number;
  alarms: RatchetAlarm[];
  verdict: 'pass' | 'fail' | 'unknown';
  detail: string;
}

/** Latest verdict per file at or before `atMs`; a file with no run by then is absent. */
function stateAt(runs: readonly RatchetTestRun[], atMs: number): Map<string, boolean> {
  const latest = new Map<string, { atMs: number; pass: boolean }>();
  for (const r of runs) {
    if (r.atMs > atMs) continue;
    const prev = latest.get(r.file);
    // Same instant: a red reading wins, so a tie never hides a failure.
    if (!prev || r.atMs > prev.atMs || (r.atMs === prev.atMs && !r.pass)) latest.set(r.file, { atMs: r.atMs, pass: r.pass });
  }
  return new Map([...latest].map(([f, v]) => [f, v.pass] as const));
}

function activeAt(rows: readonly RatchetDowngradeRow[], atMs: number): RatchetDowngradeRow[] {
  return rows.filter((r) => r.createdAtMs <= atMs && (r.revokedAtMs === null || r.revokedAtMs > atMs));
}

function downgradedFailingAt(rows: readonly RatchetDowngradeRow[], state: ReadonlyMap<string, boolean>, atMs: number): number {
  const files = new Set(activeAt(rows, atMs).map((r) => r.testFile));
  let n = 0;
  for (const f of files) if (state.get(f) === false) n += 1;
  return n;
}

export function computeRatchetMetrics(input: {
  nowMs: number;
  windowMs?: number;
  runs: readonly RatchetTestRun[];
  downgrades: readonly RatchetDowngradeRow[];
}): RatchetMetrics {
  const windowMs = input.windowMs ?? RATCHET_METRICS_WINDOW_MS;
  const end = input.nowMs;
  const start = end - windowMs;
  const before = stateAt(input.runs, start);
  const after = stateAt(input.runs, end);
  const introduced: string[] = [];
  const fixed: string[] = [];
  for (const [file, pass] of after) {
    const was = before.get(file);
    if (!pass && was !== false) introduced.push(file);
    if (pass && was === false) fixed.push(file);
  }
  introduced.sort();
  fixed.sort();
  const inWindow = input.downgrades.filter((r) => r.createdAtMs > start && r.createdAtMs <= end);
  const downgradesInWindow = inWindow.filter((r) => r.kind === 'downgrade').length;
  const quarantinesInWindow = inWindow.filter((r) => r.kind === 'flaky-quarantine').length;
  const activeDowngrades = activeAt(input.downgrades, end).length;
  const activeDowngradesAtStart = activeAt(input.downgrades, start).length;
  const downgradedFailing = downgradedFailingAt(input.downgrades, after, end);
  const downgradedFailingAtStart = downgradedFailingAt(input.downgrades, before, start);

  const alarms: RatchetAlarm[] = [];
  if (introduced.length > fixed.length) alarms.push('introductions-exceed-fixes');
  if (activeDowngrades > activeDowngradesAtStart) alarms.push('downgrade-debt-grew');
  if (downgradedFailing > downgradedFailingAtStart) alarms.push('downgraded-failing-grew');

  const measuredFiles = after.size;
  const perDay = (n: number) => Math.round((n * (24 * 60 * 60_000) / windowMs) * 100) / 100;
  const base = {
    windowStartMs: start,
    windowEndMs: end,
    downgradedFailing,
    downgradedFailingAtStart,
    activeDowngrades,
    activeDowngradesAtStart,
    downgradesInWindow,
    quarantinesInWindow,
    downgradesPerDay: perDay(downgradesInWindow + quarantinesInWindow),
    introduced,
    fixed,
    measuredFiles,
    alarms,
  };
  const summary =
    `introduced ${introduced.length} vs fixed ${fixed.length}; downgraded-failing ${downgradedFailingAtStart}->${downgradedFailing}; ` +
    `active downgrades ${activeDowngradesAtStart}->${activeDowngrades}; created ${downgradesInWindow} downgrade(s) + ${quarantinesInWindow} quarantine(s)`;
  // No gate verdict in the window and none before it: nothing was measured, so no verdict.
  if (measuredFiles === 0) {
    return { ...base, verdict: 'unknown', detail: `no gate test verdicts at or before the window end; ${summary}` };
  }
  return {
    ...base,
    verdict: alarms.length > 0 ? 'fail' : 'pass',
    detail: alarms.length > 0 ? `ALARM ${alarms.join(', ')}: ${summary}` : summary,
  };
}

type SqlLike = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

/** The checkpoint-tree root pattern for an install: `<slug>-checkpoint`, a sibling or relocated
 *  (`<outer>-<slug>-checkpoint`) tree, plus its submodule sub-roots. */
export function checkpointRootPattern(harnessSlug: string): string {
  const slug = harnessSlug.trim().replace(/[^a-z0-9-]/gi, '');
  return `/(?:[^/]*-)?${slug}-checkpoint(/|$)`;
}

/** Repo-relative test path from a ledger row: the sub-root below the checkpoint tree + the row's file. */
export function repoRelativeTestPath(root: string, filePath: string, harnessSlug: string): string {
  const m = new RegExp(`^.*/(?:[^/]*-)?${harnessSlug.replace(/[^a-z0-9-]/gi, '')}-checkpoint/?(.*)$`).exec(root);
  const sub = m ? m[1].replace(/\/+$/, '') : '';
  return sub ? `${sub}/${filePath}` : filePath;
}

/** Read the window's inputs and compute the metrics for one install. */
export async function measureRatchetMetrics(
  sql: SqlLike,
  scope: { workspaceId: string; harnessSlug: string; windowStart: string; windowEnd: string },
): Promise<RatchetMetrics> {
  const pattern = checkpointRootPattern(scope.harnessSlug);
  const runRows = (await sql`
    WITH scoped AS (
      SELECT execution_details->>'root' AS root, file_path, status, finished_at
        FROM harness_shared.test_runs
       WHERE source = 'ci' AND worktree_dirty = false
         AND status IN ('pass', 'fail', 'error')
         AND (execution_details->>'root') ~ ${pattern}
         AND finished_at <= ${scope.windowEnd}::timestamptz
         AND finished_at > ${scope.windowStart}::timestamptz - interval '30 days'
    ),
    prior AS (
      SELECT DISTINCT ON (root, file_path) root, file_path, status, finished_at
        FROM scoped WHERE finished_at <= ${scope.windowStart}::timestamptz
       ORDER BY root, file_path, finished_at DESC
    )
    SELECT root, file_path, status, finished_at FROM prior
    UNION ALL
    SELECT root, file_path, status, finished_at FROM scoped WHERE finished_at > ${scope.windowStart}::timestamptz
  `) as Array<{ root: string; file_path: string; status: string; finished_at: string | Date }>;
  const downgradeRows = (await sql`
    SELECT kind, test_file, created_at, revoked_at
      FROM harness_shared.test_downgrades
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND created_at <= ${scope.windowEnd}::timestamptz
  `) as Array<{ kind: string; test_file: string; created_at: string | Date; revoked_at: string | Date | null }>;
  const ms = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));
  return computeRatchetMetrics({
    nowMs: Date.parse(scope.windowEnd),
    windowMs: Date.parse(scope.windowEnd) - Date.parse(scope.windowStart),
    runs: runRows.map((r) => ({ file: repoRelativeTestPath(r.root, r.file_path, scope.harnessSlug), atMs: ms(r.finished_at), pass: r.status === 'pass' })),
    downgrades: downgradeRows.map((r) => ({
      kind: r.kind === 'flaky-quarantine' ? 'flaky-quarantine' : 'downgrade',
      testFile: r.test_file,
      createdAtMs: ms(r.created_at),
      revokedAtMs: r.revoked_at === null ? null : ms(r.revoked_at),
    })),
  });
}

/** The instrument's scheduled verdict (rubric-rescore): pass / fail (the alarm) / unknown. */
export function ratchetMetricsVerdict(metrics: RatchetMetrics): { verdict: 'pass' | 'fail' | 'unknown'; detail: string } {
  return { verdict: metrics.verdict, detail: JSON.stringify({ detail: metrics.detail, alarms: metrics.alarms, downgradedFailing: metrics.downgradedFailing, downgradesPerDay: metrics.downgradesPerDay, introduced: metrics.introduced.slice(0, 20), fixed: metrics.fixed.slice(0, 20) }) };
}

/**
 * Record one measured result to the results ledger. The check row carries the alarm count as
 * its value, expected `lte 0`, so the ledger row is `pass` with no alarm and `fail` with one.
 */
export async function recordRatchetMetrics(input: {
  rubricRef: string;
  criterionKey: string;
  metrics: RatchetMetrics;
  scope: { workspaceId: string | null; harnessSlug: string | null; root?: string; commitSha?: string | null };
  record?: (
    results: ReadonlyArray<import('../check-results-ledger').RubricCheckResult>,
    scope: import('../check-results-ledger').RubricCheckLedgerScope,
  ) => Promise<number[]>;
}): Promise<number[]> {
  const { instrumentCheckResult, recordRubricCheckResults } = await import('../check-results-ledger');
  const value = input.metrics.verdict === 'unknown' ? null : input.metrics.alarms.length;
  const result = instrumentCheckResult({
    rubricRef: input.rubricRef,
    criterionKey: input.criterionKey,
    reading: {
      key: RATCHET_METRICS_INSTRUMENT_KEY,
      unit: 'count',
      argv: [],
      value,
      measuredAt: new Date(input.metrics.windowEndMs).toISOString(),
      ...(value === null ? { error: input.metrics.detail } : {}),
    },
    expect: { op: 'lte', value: 0 },
  });
  return (input.record ?? recordRubricCheckResults)([{ ...result, detail: input.metrics.detail }], input.scope);
}

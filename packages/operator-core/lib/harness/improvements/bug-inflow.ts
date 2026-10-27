/**
 * bug-inflow.ts — the stored daily inflow-vs-closes rollup behind the
 * `work.bugInflow` state cell and the fleet leader brief
 * (bug-inflow-one-problem-one-row-2026-10-18 P-007 / R-6, owner directive #1990).
 *
 * R-6: "The inflow state cell returns filed-per-day by source and closed-per-day
 * from stored values without a live aggregate query." So the work is split:
 *
 *   WRITE  refreshBugInflowDaily — the improvement-watchdog tick recomputes the
 *          current and previous UTC day for one workspace (two bounded index
 *          range scans over work_items) and upserts harness_shared.bug_inflow_daily
 *          (migration 1535). A finished day is final after the next day's first tick.
 *   READ   readBugInflowDaily — a plain SELECT of the stored rows. It never
 *          aggregates work_items, so a read is cheap and cannot time out on the
 *          fleet's hot table.
 *
 * Reuse note: work_items:burn_down already measures created/closed, but it is a
 * live, fleet-attributed census with no reporter dimension; this is the stored,
 * per-source daily series the brief needs. Nothing existing stored it.
 *
 * Population: issue family minus cleanup (bug | change | task), lane distinct from
 * 'observation'. Source = payload.source, else 'watchdog' when reporterKinds
 * names it, else 'role:<filedByRole>', else reporterKinds[0], else 'unattributed'.
 */
import { getOrgPg } from '@papercusp/db-org';

import { CLEANUP_ITEM_KIND } from '../../code-cleanup/cleanup-item-kind';
import { ISSUE_FAMILY_ROUTE_KINDS } from '../../work-nature/agent-work-predicate';
type Sql = ReturnType<typeof getOrgPg>['sql'];

const DAY_MS = 86_400_000;
/**
 * The issue family MINUS 'cleanup' (code-cleanup-campaigns-2026-10-26 P-003, R-3): cleanup
 * work is issue-family for routing but is excluded from bug/change backlog rollups; it
 * has its own backlog read (issues:list { kinds:['cleanup'] }).
 */
export const BUG_INFLOW_KINDS = ISSUE_FAMILY_ROUTE_KINDS.filter((k) => k !== CLEANUP_ITEM_KIND);
/** The writer recomputes this many UTC days per tick (today + yesterday). */
export const BUG_INFLOW_REFRESH_DAYS = 2;
export const BUG_INFLOW_DEFAULT_DAYS = 7;
export const BUG_INFLOW_MAX_DAYS = 30;
/** The watchdog ticks every few minutes; a newest row older than this means the writer stopped. */
export const BUG_INFLOW_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const BUG_INFLOW_TABLE = 'harness_shared.bug_inflow_daily';

/** Reporter bucket for a work_items row aliased `w`. */
export const BUG_INFLOW_SOURCE_SQL = `coalesce(
    nullif(w.payload->>'source', ''),
    CASE WHEN jsonb_typeof(w.payload->'reporterKinds') = 'array' AND w.payload->'reporterKinds' ? 'watchdog' THEN 'watchdog' END,
    'role:' || nullif(w.payload->>'filedByRole', ''),
    CASE WHEN jsonb_typeof(w.payload->'reporterKinds') = 'array' THEN nullif(w.payload->'reporterKinds'->>0, '') END,
    'unattributed')`;

const POPULATION_SQL = `w.workspace_id = $1
    AND w.item_kind IN (${BUG_INFLOW_KINDS.map((k) => `'${k}'`).join(', ')})
    AND w.lane IS DISTINCT FROM 'observation'`;

/** Matches work_items_issue_created_at_idx's expression so the range is an index scan. */
const CREATED_AT_SQL = `to_timestamp(((w.created_ts)::numeric / 1000.0)::double precision)`;

export const BUG_INFLOW_REFRESH_SQL = `
WITH days AS (
  SELECT d::date AS day FROM generate_series($2::date, $3::date - 1, interval '1 day') AS d
),
filed AS (
  SELECT (${CREATED_AT_SQL} AT TIME ZONE 'UTC')::date AS day, ${BUG_INFLOW_SOURCE_SQL} AS source, count(*)::int AS n
    FROM harness_shared.work_items w
   WHERE ${POPULATION_SQL}
     AND ${CREATED_AT_SQL} >= ($2::date)::timestamp AT TIME ZONE 'UTC'
     AND ${CREATED_AT_SQL} <  ($3::date)::timestamp AT TIME ZONE 'UTC'
   GROUP BY 1, 2
),
closed AS (
  SELECT (to_timestamp(w.closed_ts / 1000.0) AT TIME ZONE 'UTC')::date AS day, w.status AS status, count(*)::int AS n
    FROM harness_shared.work_items w
   WHERE ${POPULATION_SQL}
     AND w.closed_ts >= $4::bigint AND w.closed_ts < $5::bigint
   GROUP BY 1, 2
)
INSERT INTO ${BUG_INFLOW_TABLE} AS t
  (workspace_id, day, filed_total, filed_by_source, closed_total, closed_by_status, computed_at)
SELECT $1, d.day,
       coalesce((SELECT sum(f.n) FROM filed f WHERE f.day = d.day), 0)::int,
       coalesce((SELECT jsonb_object_agg(f.source, f.n) FROM filed f WHERE f.day = d.day), '{}'::jsonb),
       coalesce((SELECT sum(c.n) FROM closed c WHERE c.day = d.day), 0)::int,
       coalesce((SELECT jsonb_object_agg(c.status, c.n) FROM closed c WHERE c.day = d.day), '{}'::jsonb),
       now()
  FROM days d
ON CONFLICT (workspace_id, day) DO UPDATE
   SET filed_total = EXCLUDED.filed_total, filed_by_source = EXCLUDED.filed_by_source,
       closed_total = EXCLUDED.closed_total, closed_by_status = EXCLUDED.closed_by_status,
       computed_at = EXCLUDED.computed_at
RETURNING day`;

export const BUG_INFLOW_READ_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, filed_total, filed_by_source, closed_total, closed_by_status, computed_at
  FROM ${BUG_INFLOW_TABLE}
 WHERE workspace_id = $1 AND day >= $2::date AND day <= $3::date
 ORDER BY day DESC`;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function clampDays(days: number | undefined, fallback: number): number {
  const n = Math.trunc(Number.isFinite(days) ? (days as number) : fallback);
  return Math.min(Math.max(1, n), BUG_INFLOW_MAX_DAYS);
}

/** Recompute + upsert the last `days` UTC days (default today + yesterday). Returns the days written. */
export async function refreshBugInflowDaily(
  workspaceId: string,
  opts: { now?: Date; days?: number; sql?: Sql } = {},
): Promise<{ days: string[] }> {
  const sql = opts.sql ?? getOrgPg().sql;
  const days = clampDays(opts.days, BUG_INFLOW_REFRESH_DAYS);
  const endMs = Date.parse(`${utcDay((opts.now ?? new Date()).getTime())}T00:00:00Z`) + DAY_MS;
  const startMs = endMs - days * DAY_MS;
  const rows = await sql.unsafe(BUG_INFLOW_REFRESH_SQL, [
    workspaceId, utcDay(startMs), utcDay(endMs), startMs, endMs,
  ]) as unknown as Array<{ day: Date | string }>;
  return { days: rows.map((r) => (r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day))) };
}

export interface BugInflowRow {
  day: string;
  filed_total: number;
  filed_by_source: Record<string, number> | null;
  closed_total: number;
  closed_by_status: Record<string, number> | null;
  computed_at: Date | string;
}

export interface BugInflowDay {
  day: string;
  filedTotal: number;
  filedBySource: Record<string, number>;
  closedTotal: number;
  closedByStatus: Record<string, number>;
  /** filed − closed: positive means the backlog grew that day. */
  net: number;
}

export type BugInflowAssessment = 'measured' | 'stale' | 'unmeasured';

export interface BugInflowReading {
  assessment: BugInflowAssessment;
  /** Why the assessment is not 'measured' (empty when it is). */
  reasons: string[];
  windowDays: number;
  /** Newest first; a day with no stored row is listed in missingDays, never as a zero. */
  days: BugInflowDay[];
  missingDays: string[];
  totals: {
    filed: number;
    closed: number;
    net: number;
    filedBySource: Record<string, number>;
    closedByStatus: Record<string, number>;
  };
  /** computed_at of the newest stored day; its age is what staleness is judged on. */
  computedAt: string | null;
  ageMs: number | null;
  storage: typeof BUG_INFLOW_TABLE;
}

function addInto(acc: Record<string, number>, part: Record<string, number> | null | undefined): void {
  for (const [k, v] of Object.entries(part ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
}

/** Pure: stored rows → the reading the cell and the brief serve. */
export function shapeBugInflow(
  rows: readonly BugInflowRow[],
  opts: { now: Date; windowDays: number },
): BugInflowReading {
  const nowMs = opts.now.getTime();
  const today = utcDay(nowMs);
  const window = Array.from({ length: opts.windowDays }, (_, i) => utcDay(nowMs - i * DAY_MS));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: BugInflowDay[] = [];
  const totals = { filed: 0, closed: 0, net: 0, filedBySource: {} as Record<string, number>, closedByStatus: {} as Record<string, number> };
  for (const day of window) {
    const r = byDay.get(day);
    if (!r) continue;
    const d: BugInflowDay = {
      day,
      filedTotal: Number(r.filed_total) || 0,
      filedBySource: { ...(r.filed_by_source ?? {}) },
      closedTotal: Number(r.closed_total) || 0,
      closedByStatus: { ...(r.closed_by_status ?? {}) },
      net: (Number(r.filed_total) || 0) - (Number(r.closed_total) || 0),
    };
    days.push(d);
    totals.filed += d.filedTotal;
    totals.closed += d.closedTotal;
    addInto(totals.filedBySource, d.filedBySource);
    addInto(totals.closedByStatus, d.closedByStatus);
  }
  totals.net = totals.filed - totals.closed;
  const missingDays = window.filter((d) => !byDay.has(d));
  const newest = rows.find((r) => r.day === days[0]?.day);
  const computedAt = newest ? new Date(newest.computed_at).toISOString() : null;
  const ageMs = computedAt ? Math.max(0, nowMs - Date.parse(computedAt)) : null;
  const reasons: string[] = [];
  if (days.length === 0) reasons.push(`no stored row in ${BUG_INFLOW_TABLE} for the last ${opts.windowDays} day(s); the improvement-watchdog writer has not run`);
  else {
    if (!byDay.has(today)) reasons.push(`no stored row for today (${today}); the writer has not run since UTC midnight`);
    if (ageMs !== null && ageMs > BUG_INFLOW_STALE_AFTER_MS) reasons.push(`newest row computed ${Math.round(ageMs / 60_000)}m ago (> ${BUG_INFLOW_STALE_AFTER_MS / 60_000}m)`);
  }
  const assessment: BugInflowAssessment = days.length === 0 ? 'unmeasured' : reasons.length ? 'stale' : 'measured';
  return { assessment, reasons, windowDays: opts.windowDays, days, missingDays, totals, computedAt, ageMs, storage: BUG_INFLOW_TABLE };
}

/** Read the stored series. A SELECT on bug_inflow_daily only — never an aggregate over work_items. */
export async function readBugInflowDaily(
  workspaceId: string,
  opts: { days?: number; now?: Date; sql?: Sql } = {},
): Promise<BugInflowReading> {
  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? new Date();
  const windowDays = clampDays(opts.days, BUG_INFLOW_DEFAULT_DAYS);
  const rows = await sql.unsafe(BUG_INFLOW_READ_SQL, [
    workspaceId, utcDay(now.getTime() - (windowDays - 1) * DAY_MS), utcDay(now.getTime()),
  ]) as unknown as BugInflowRow[];
  return shapeBugInflow(rows, { now, windowDays });
}

/** One line for the fleet brief: "inflow 7d: filed 812 (watchdog 530, role:su 190, …) vs closed 640 (done 410, dropped 230) · net +172". */
export function formatBugInflowLine(r: BugInflowReading, topSources = 4): string {
  if (r.assessment === 'unmeasured') return `bug inflow: unmeasured — ${r.reasons[0] ?? 'no stored rows'}`;
  const top = (o: Record<string, number>, n: number) => Object.entries(o)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
    .map(([k, v]) => `${k} ${v}`).join(', ');
  const today = r.days[0];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const stale = r.assessment === 'stale' ? ` ⚠ stale: ${r.reasons.join('; ')}` : '';
  return `bug inflow ${r.days.length}d: filed ${r.totals.filed} (${top(r.totals.filedBySource, topSources)}) vs closed ${r.totals.closed} (${top(r.totals.closedByStatus, 3)}) · net ${sign(r.totals.net)}`
    + (today ? ` · ${today.day}: filed ${today.filedTotal} / closed ${today.closedTotal}` : '') + stale;
}

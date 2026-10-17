/** P015/R15–16: repeatable native-context measurements; see plan D004.
 * Extends the existing platform-instrument seam and existing transcript/lifecycle tables.
 * Transcript spans are lower bounds, not launcher lifetimes (a launcher survives carry).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export const WORK_OVERHEAD_VERSION = 3;
export const WORK_OVERHEAD_INSTRUMENT_KEYS = Object.freeze({
  acceptanceShare: 'agents:acceptance-machinery-share',
  sessionMinutes: 'agents:native-session-minutes',
} as const);
export type WorkOverheadCriterion = keyof typeof WORK_OVERHEAD_INSTRUMENT_KEYS;
export const WORK_OVERHEAD_IDLE_MS = 5 * 60_000;
export const WORK_OVERHEAD_MAX_ROWS = 100_000;
export const WORK_OVERHEAD_QUERY_REF = 'packages/operator-core/lib/agent-work-overhead-metrics.ts#WORK_OVERHEAD_SQL';
export interface WorkOverheadWindow {
  workspaceId: string;
  harnessSlug: string;
  windowStart: string;
  windowEnd: string;
}

/** Parameter order: workspace, harness, inclusive start, exclusive end, row limit + sentinel.
 * The faithful-parts writer uses workspace default. Concrete tenant membership is supplied by
 * launch bindings or historical self-authored plan declarations, never the default partition.
 * A resumed launch row describes its current incarnation; append-only intent intervals retain
 * earlier plan work and explicitly end at clears/moves. No native context is merged.
 * Tool-use selection uses the existing (owner,ts) partial index; full spans use the session PK.
 */
export const WORK_OVERHEAD_SQL = `
WITH membership AS MATERIALIZED (
  SELECT s.coord_owner_id AS owner, s.session_id, s.started_at, s.ended_at
    FROM harness_shared.adv_sessions s
    JOIN harness_shared.harness_plans h
      ON h.workspace_id = s.workspace_id AND h.plan_slug = s.plan_slug
   WHERE s.workspace_id = $1 AND h.harness_slug = $2
     AND s.plan_slug IS NOT NULL AND s.coord_owner_id IS NOT NULL
     AND s.started_at < $4::timestamptz
     AND (s.ended_at IS NULL OR s.ended_at >= $3::timestamptz)
), intent_history AS MATERIALIZED (
  SELECT e.body->>'from' AS owner, e.body->>'plan_slug' AS plan_slug,
    e.body->>'harness_slug' AS harness_slug, e.ts AS started_at,
    lead(e.ts) OVER (PARTITION BY e.body->>'from' ORDER BY e.ts, e.id) AS ended_at
    FROM harness_shared.coord_event_log e
   WHERE e.workspace_id = $1 AND e.surface = 'messages'
     AND e.body->>'lifecycle' = 'intent' AND e.body->>'from' = e.writer_key
     AND e.ts < $4::timestamptz
), declared_membership AS MATERIALIZED (
  SELECT i.owner, i.started_at, i.ended_at
    FROM intent_history i JOIN harness_shared.harness_plans h
      ON h.workspace_id = $1 AND h.harness_slug = $2
     AND h.plan_slug = i.plan_slug AND h.harness_slug = i.harness_slug
   WHERE i.ended_at IS NULL OR i.ended_at > $3::timestamptz
), candidates AS MATERIALIZED (
  SELECT DISTINCT p.source_kind, p.session_id, p.owner
    FROM harness_shared.session_turn_parts p
   WHERE p.owner IN (SELECT owner FROM membership UNION SELECT owner FROM declared_membership)
     AND p.workspace_id IN ('default', $1)
     AND p.speaker = 'assistant' AND p.part_kind = 'tool_use'
     AND p.ts >= $3::timestamptz AND p.ts < $4::timestamptz
     AND (EXISTS (SELECT 1 FROM declared_membership m WHERE m.owner = p.owner
       AND p.ts >= m.started_at AND (m.ended_at IS NULL OR p.ts < m.ended_at))
       OR (EXISTS (SELECT 1 FROM membership m WHERE m.owner = p.owner
         AND p.ts >= m.started_at AND (m.ended_at IS NULL OR p.ts <= m.ended_at))
         AND NOT EXISTS (SELECT 1 FROM intent_history i WHERE i.owner = p.owner AND i.started_at <= p.ts)))
), identity_history AS MATERIALIZED (
  SELECT e.id, e.owner_id AS owner, e.adv_session_id, e.native_session_id,
    e.source, e.transition_id, e.recorded_at
    FROM harness_shared.session_identity_activation_events e
   WHERE e.workspace_id = $1 AND e.phase = 'applied'
     AND e.native_session_id IS NOT NULL AND e.recorded_at <= $4::timestamptz
     AND e.owner_id IN (SELECT owner FROM candidates)
), native_closures AS MATERIALIZED (
  -- recordSessionIdentityReanchor links the superseded event in :after:<id>.
  -- An arbitrary identity-span end (e.g. a mode change) is not native closure.
  SELECT p.owner, p.native_session_id, r.recorded_at AS closed_at
    FROM identity_history p JOIN identity_history r
      ON p.id::text = substring(r.transition_id FROM ':after:([0-9]+)$')
     AND r.owner = p.owner AND r.adv_session_id = p.adv_session_id
     AND r.source = 'reanchor' AND r.native_session_id <> p.native_session_id
     AND (r.recorded_at, r.id) > (p.recorded_at, p.id)
   WHERE NOT EXISTS (SELECT 1 FROM identity_history reopened
     WHERE reopened.owner = p.owner AND reopened.native_session_id = p.native_session_id
       AND (reopened.recorded_at, reopened.id) > (r.recorded_at, r.id))
), spans AS MATERIALIZED (
  SELECT c.*, v.first_at, v.last_at, v.missing_timestamps,
    (EXISTS (SELECT 1 FROM membership m WHERE m.owner = c.owner
      AND m.session_id = c.session_id AND m.ended_at <= $4::timestamptz)
     OR EXISTS (SELECT 1 FROM native_closures n WHERE n.owner = c.owner
       AND n.native_session_id = c.session_id AND n.closed_at >= v.last_at)) AS closed
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT min(p.ts) AS first_at,
        max(p.ts) FILTER (WHERE p.ts < $4::timestamptz) AS last_at,
        count(*) FILTER (WHERE p.ts IS NULL AND p.speaker = 'assistant'
          AND p.part_kind = 'tool_use') AS missing_timestamps
        FROM harness_shared.session_turn_parts p
       WHERE p.workspace_id IN ('default', $1) AND p.source_kind = c.source_kind
         AND p.session_id = c.session_id AND p.owner = c.owner
    ) v
)
SELECT DISTINCT ON (p.source_kind, p.session_id, p.part_idx)
  p.source_kind, p.session_id, p.owner, p.part_idx, p.ts::text,
  p.tool_name, left(p.text, 16000) AS payload, length(p.text) > 16000 AS payload_truncated,
  s.first_at::text, s.last_at::text, s.missing_timestamps::int, s.closed
  FROM spans s JOIN harness_shared.session_turn_parts p
    ON p.source_kind = s.source_kind AND p.session_id = s.session_id AND p.owner = s.owner
 WHERE p.workspace_id IN ('default', $1) AND p.speaker = 'assistant'
   AND p.part_kind = 'tool_use' AND p.ts >= $3::timestamptz AND p.ts < $4::timestamptz
 ORDER BY p.source_kind, p.session_id, p.part_idx, p.workspace_id DESC
 LIMIT $5`;

export interface WorkOverheadEvent {
  source_kind: string;
  session_id: string;
  owner: string;
  part_idx: number;
  ts: string;
  tool_name: string | null;
  payload: string;
  payload_truncated: boolean;
  first_at: string;
  last_at: string;
  missing_timestamps: number;
  closed: boolean;
}

type TimeClass = 'acceptance' | 'other' | 'unknown';
const acceptancePlanVerbs = new Set([
  'audit', 'bind-spec-evidence', 'spec-evidence', 'spec-clauses', 'evaluate-spec-test-adequacy',
  'vet-acceptance-rubric', 'acceptance-bar-census', 'set-plan-status',
]);
const wrappers = new Set(['functions.exec', 'functions.wait', 'write_stdin', 'code:run', 'tools:invoke', 'capability:bash',
  'capability:terminal', 'exec_command', 'functions.exec_command', 'Bash']);

function normalizeTool(name: string): string {
  const native = name.match(/mcp__papercusp(?:_su)?__(.+)$/)?.[1];
  if (!native) return name;
  const ns = native.startsWith('work_items_') ? 'work_items' : native.split('_')[0]!;
  return `${ns}:${native.slice(ns.length + 1).replaceAll('_', '-')}`;
}
function directClass(name: string): TimeClass {
  if (wrappers.has(name)) return 'unknown';
  const [ns, verb] = name.split(':');
  return ns === 'rubrics' || ns === 'scorecards' ||
    (ns === 'plans' && acceptancePlanVerbs.has(verb ?? '')) || name === 'work_items:complete'
    ? 'acceptance' : 'other';
}

/** Pure wrappers count only when every observed nested operation agrees. Mixed/opaque calls
 * remain unknown and are charged to acceptance in the pass upper bound. No JSON casts.
 */
export function classifyAcceptanceTime(name: string | null, payload = '', truncated = false): TimeClass {
  if (!name) return 'unknown';
  const canonical = normalizeTool(name);
  if (!wrappers.has(canonical)) return directClass(canonical);
  if (truncated) return 'unknown';
  const refs = new Set<string>();
  for (const m of payload.matchAll(/\b([a-z][a-z0-9_]*):([a-z][a-z0-9_-]*)\b/g)) refs.add(`${m[1]}:${m[2]}`);
  for (const m of payload.matchAll(/mcp__papercusp(?:_su)?__([a-z][a-z0-9_]*)/g)) refs.add(normalizeTool(m[0]));
  for (const m of payload.matchAll(/tools\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_-]*)/g)) refs.add(`${m[1]}:${m[2]!.replaceAll('_', '-')}`);
  for (const m of payload.matchAll(/tools\.(exec_command|write_stdin|apply_patch|view_image)\b/g)) {
    refs.add(m[1] === 'exec_command' ? 'shell:exec' : m[1]!);
  }
  // Transport wrappers can be resolved by their nested calls. A wait with no causal
  // operation identity cannot: retain its uncertainty even beside an ordinary call.
  const classes = [...refs].filter(ref => !wrappers.has(ref) || ref === 'write_stdin').map(directClass);
  if (!classes.length) return canonical === 'capability:bash' || canonical.endsWith('exec_command') || canonical === 'Bash'
    ? 'other' : 'unknown';
  return classes.every(c => c === 'acceptance') ? 'acceptance'
    : classes.every(c => c === 'other') ? 'other' : 'unknown';
}

export interface WorkOverheadMetrics {
  version: number;
  window: WorkOverheadWindow;
  queryRef: string;
  population: { sessions: number; boundarySessions: number; censoredSessions: number;
    missingTimestampSessions: number; clients: Record<string, number>; toolCalls: number };
  time: { activeMs: number; acceptanceMs: number; unknownMs: number; excludedIdleMs: number;
    acceptanceShare: number | null; acceptanceShareUpper: number | null };
  medianObservedSessionMinutes: number | null;
  unavailableReason: string | null;
}

export function summarizeWorkOverhead(window: WorkOverheadWindow, events: readonly WorkOverheadEvent[]): WorkOverheadMetrics {
  const result: WorkOverheadMetrics = { version: WORK_OVERHEAD_VERSION, window, queryRef: WORK_OVERHEAD_QUERY_REF,
    population: { sessions: 0, boundarySessions: 0, censoredSessions: 0, missingTimestampSessions: 0,
      clients: {}, toolCalls: 0 },
    time: { activeMs: 0, acceptanceMs: 0, unknownMs: 0, excludedIdleMs: 0,
      acceptanceShare: null, acceptanceShareUpper: null }, medianObservedSessionMinutes: null,
    unavailableReason: events.length > WORK_OVERHEAD_MAX_ROWS ? 'row-limit-exceeded' : null };
  const start = Date.parse(window.windowStart), end = Date.parse(window.windowEnd);
  if (!window.workspaceId || window.workspaceId === 'default' || !window.harnessSlug ||
      !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 7 * 86400_000) {
    return { ...result, unavailableReason: 'invalid-window-or-scope' };
  }
  if (result.unavailableReason) return result;
  const sessions = new Map<string, WorkOverheadEvent[]>();
  for (const e of events) {
    const key = JSON.stringify([e.source_kind, e.session_id]);
    const rows = sessions.get(key) ?? [];
    rows.push(e);
    sessions.set(key, rows);
  }
  const spans: number[] = [];
  const addTime = (from: number, to: number, kind: TimeClass) => {
    const ms = Math.max(0, to - from);
    if (ms > WORK_OVERHEAD_IDLE_MS) { result.time.excludedIdleMs += ms; return; }
    result.time.activeMs += ms;
    if (kind === 'acceptance') result.time.acceptanceMs += ms;
    if (kind === 'unknown') result.time.unknownMs += ms;
  };
  for (const rows of sessions.values()) {
    const first = Date.parse(rows[0]!.first_at), last = Date.parse(rows[0]!.last_at);
    if (first < start) { result.population.boundarySessions++; continue; }
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first || last >= end ||
        rows.some(r => r.missing_timestamps > 0 || !Number.isFinite(Date.parse(r.ts)) ||
          Date.parse(r.ts) < first || Date.parse(r.ts) > last)) {
      result.population.missingTimestampSessions++;
      continue;
    }
    result.population.sessions++;
    if (!rows[0]!.closed) result.population.censoredSessions++;
    const client = rows[0]!.source_kind;
    result.population.clients[client] = (result.population.clients[client] ?? 0) + 1;
    spans.push((last - first) / 60_000);
    rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.part_idx - b.part_idx);
    addTime(first, Date.parse(rows[0]!.ts), 'unknown');
    result.population.toolCalls += rows.length;
    rows.forEach((row, i) => addTime(Date.parse(row.ts),
      i + 1 < rows.length ? Date.parse(rows[i + 1]!.ts) : last,
      classifyAcceptanceTime(row.tool_name, row.payload, row.payload_truncated)));
  }
  if (result.population.missingTimestampSessions) result.unavailableReason ??= 'incomplete-timestamps';
  if (result.time.activeMs > 0) {
    result.time.acceptanceShare = result.time.acceptanceMs / result.time.activeMs;
    result.time.acceptanceShareUpper = (result.time.acceptanceMs + result.time.unknownMs) / result.time.activeMs;
  }
  spans.sort((a, b) => a - b);
  if (spans.length) result.medianObservedSessionMinutes = (spans[Math.floor((spans.length - 1) / 2)]! + spans[Math.floor(spans.length / 2)]!) / 2;
  return result;
}

export function workOverheadCriterionForInstrument(key: string): WorkOverheadCriterion | null {
  return (Object.keys(WORK_OVERHEAD_INSTRUMENT_KEYS) as WorkOverheadCriterion[])
    .find(k => WORK_OVERHEAD_INSTRUMENT_KEYS[k] === key) ?? null;
}

export function rateWorkOverhead(m: WorkOverheadMetrics): Record<WorkOverheadCriterion, { verdict: 'pass' | 'fail' | 'unknown'; reason: string }> {
  const unknown = (reason: string) => ({ verdict: 'unknown' as const, reason });
  if (m.unavailableReason || !m.population.sessions) {
    const rating = unknown(m.unavailableReason ?? 'No plan-associated native sessions began in this window.');
    return { acceptanceShare: rating, sessionMinutes: rating };
  }
  const lower = m.time.acceptanceShare, upper = m.time.acceptanceShareUpper;
  const acceptanceShare = lower === null || upper === null ? unknown('No active tool intervals were observed.')
    : lower >= 0.1 ? { verdict: 'fail' as const, reason: `Acceptance time share ${lower * 100}% is at least 10%.` }
    : upper < 0.1 ? { verdict: 'pass' as const, reason: `Acceptance time share upper bound ${upper * 100}% is below 10%.` }
    : unknown(`Acceptance share lies in [${lower * 100}%, ${upper * 100}%]; opaque/mixed intervals prevent a verdict.`);
  const median = m.medianObservedSessionMinutes;
  const sessionMinutes = median === null ? unknown('No native-session spans were observed.')
    : median > 45 ? { verdict: 'pass' as const, reason: `Median observed native-session lower bound ${median}min exceeds 45min.` }
    : m.population.censoredSessions > 0 ? unknown(`Median lower bound ${median}min; ${m.population.censoredSessions} contexts remain censored.`)
    : { verdict: 'fail' as const, reason: `Median completed native-session span ${median}min is at most 45min.` };
  return { acceptanceShare, sessionMinutes };
}

export async function measureWorkOverheadWindow(window: WorkOverheadWindow, sql?: Sql): Promise<WorkOverheadMetrics> {
  const validation = summarizeWorkOverhead(window, []);
  if (validation.unavailableReason) return validation;
  const db = sql ?? getOrgPg().sql;
  const rows = await db.unsafe<WorkOverheadEvent[]>(WORK_OVERHEAD_SQL,
    [window.workspaceId, window.harnessSlug, window.windowStart, window.windowEnd, WORK_OVERHEAD_MAX_ROWS + 1]);
  return summarizeWorkOverhead(window, rows);
}

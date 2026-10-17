/**
 * fallback-observations — the durable record of fail-open / fallback decisions
 * (degradation-signals-on-condition-rail-2026-10-11 P-002, BAR R-1, D-001;
 * table: migration 1458 `harness_shared.fallback_observations`).
 *
 * A mechanism that can quietly fall back — the gate's pass-reuse selector, a
 * retrieval leg, a transport, a self-healing watchdog — calls
 * `observeFallback(mechanism, { eligible, applied, reason })` once per decision
 * batch: how many units COULD have taken the primary path, how many DID, and
 * why. The generic degradation watchdog (P-003) reads a trailing window with
 * `readFallbackWindow` and raises `degraded:<mechanism>:<reason>` when the
 * applied rate collapses.
 *
 * Why Postgres and not the per-process leg-health ring (D-001): the gate's
 * reuse decisions run in CHILD processes, so an in-memory ring there is
 * invisible to the watchdog. Gate run 762a13a6 reused 0 of ~7,689 eligible
 * tasks and nothing alarmed, because the only signal was a log line.
 *
 * Identical decisions coalesce (WI-6554700010009713): two observations with the
 * same workspace, mechanism, reason, scope and process tag, no correlation id,
 * and event times within {@link FALLBACK_COALESCE_SPAN_MS} of each other become
 * ONE row whose eligible/applied are the sums and whose `samples` counts them
 * (migration 1489). Per-call mechanisms (an L2 cache get, a sidecar exec) used to
 * write one row each, ~12.5M rows/day; readers count batches as sum(samples).
 *
 * Writes are best-effort and batched: `observeFallback` only enqueues, never
 * throws and never awaits, so a hot path is not slowed and a database outage
 * cannot fail the caller. A short-lived process (a script, a gate child) must
 * `await flushFallbackObservations()` before it exits; a `beforeExit` hook
 * covers processes that end by draining their event loop.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';

/** One decision batch, as reported by the mechanism. */
export interface FallbackDecision {
  /** Units that could have taken the primary (non-fallback) path. */
  eligible: number;
  /** Units that actually took it. `eligible - applied` units fell back. */
  applied: number;
  /** False when cardinality is unmeasured; such batches carry zero counts. Defaults to true. */
  populationKnown?: boolean;
  /** Why the batch went the way it did (e.g. `applied`, `proofs-unavailable`). */
  reason: string;
  /** Optional sub-scope (a gate run id, a pool name) for drill-down. */
  scope?: string | null;
}

export interface ObserveFallbackOptions {
  /** Postgres handle; defaults to the operator admin pool at flush time. */
  sql?: Sql;
  /** Defaults to `PAPERCUSP_WORKSPACE_ID`, else `'default'`. */
  workspaceId?: string;
  /** Free-form tag naming the writing process (e.g. `gate-cli`). */
  processTag?: string;
  /** Event time; defaults to now. */
  observedAt?: Date;
  /** Optional exact per-call join key; does not affect scope-based aggregation. */
  correlationId?: string | null;
}

/** Per-reason aggregate over a window — the reader's row shape. */
export interface FallbackReasonAggregate {
  reason: string;
  samples: number;
  eligible: number;
  applied: number;
  /** Unknown-cardinality decision batches, never eligible file units. */
  unknownSamples?: number;
}

export interface FallbackReasonSummary extends FallbackReasonAggregate {
  unknownSamples: number;
  /** Units that fell back under this reason (`eligible - applied`). */
  fellBack: number;
}

export interface FallbackWindow {
  mechanism: string;
  windowMs: number;
  /** Decision batches in the window. */
  samples: number;
  eligible: number;
  applied: number;
  /** Fraction over measured units only, even when other batches are unknown. */
  knownAppliedRate: number | null;
  /** Unknown-cardinality batches, including ambiguous historical zero-count gate rows. */
  unknownSamples: number;
  /** A nonempty measured file population without unknown-cardinality batches. */
  populationComplete: boolean;
  /** Overall qualified fraction; null for empty or incompletely measured windows. */
  appliedRate: number | null;
  /** Sorted by fallen-back units, then samples, then reason. */
  reasons: FallbackReasonSummary[];
  /** The reason that accounts for the most fallen-back units; null when none fell back. */
  dominantReason: string | null;
  /** That reason's share of all fallen-back units; null when none fell back. */
  dominantShare: number | null;
}

export const FALLBACK_NAME_MAX_CHARS = 200;
export const FALLBACK_SCOPE_MAX_CHARS = 500;
/** Rows per INSERT; also the buffer length that triggers an immediate flush. */
export const FALLBACK_FLUSH_BATCH = 50;
/** Debounce before a partial batch is flushed. */
export const FALLBACK_FLUSH_DELAY_MS = 2_000;
/** Hard cap on unflushed rows; beyond it the OLDEST are dropped and counted. */
export const FALLBACK_BUFFER_MAX = 2_000;
/** Max event-time distance between observations folded into one row. */
export const FALLBACK_COALESCE_SPAN_MS = FALLBACK_FLUSH_DELAY_MS;
/** The eligible/applied/samples columns are int4; a fold never crosses this. */
const INT4_MAX = 2_147_483_647;
/** Default retention for {@link pruneFallbackObservations}. */
export const FALLBACK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const WARN_WINDOW_MS = 10 * 60 * 1000;

interface PendingRow {
  sql: Sql | undefined;
  workspace_id: string;
  mechanism: string;
  eligible: number;
  applied: number;
  population_known: boolean;
  reason: string;
  scope: string | null;
  process_tag: string | null;
  correlation_id: string | null;
  observed_at: Date;
  /** Decisions this row stands for (identical ones coalesce; see the module doc). */
  samples: number;
}

interface WriterState {
  pending: PendingRow[];
  /**
   * Coalescing index: per handle, coalesce key -> the still-unflushed row new
   * identical observations fold into. Cleared whenever a flush takes the buffer,
   * so a row is never mutated after it was handed to a write.
   */
  open: Map<Sql | undefined, Map<string, PendingRow>>;
  /** Observations folded into an existing row instead of adding one (lifetime). */
  totalCoalesced: number;
  /** Observations dropped since the last flush report (buffer overflow). */
  dropped: number;
  /** Rows refused at observe time since the last flush report (invalid input). */
  rejected: number;
  totalDropped: number;
  totalRejected: number;
  /** Rows lost to a failed write (no handle, or the INSERT rejected). */
  totalFailed: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<FlushResult> | null;
  exitHookInstalled: boolean;
  lastWarnedAt: number;
  suppressedSinceWarn: number;
}

const state = pinModuleState<WriterState>('@papercusp/operator-core.fallback-observations', () => ({
  pending: [],
  open: new Map(),
  totalCoalesced: 0,
  dropped: 0,
  rejected: 0,
  totalDropped: 0,
  totalRejected: 0,
  totalFailed: 0,
  timer: null,
  flushing: null,
  exitHookInstalled: false,
  lastWarnedAt: 0,
  suppressedSinceWarn: 0,
}));

export interface FlushResult {
  written: number;
  failed: number;
  dropped: number;
  rejected: number;
}

function warnThrottled(message: string, err?: unknown): void {
  state.suppressedSinceWarn += 1;
  const now = Date.now();
  if (now - state.lastWarnedAt < WARN_WINDOW_MS) return;
  const also = state.suppressedSinceWarn - 1;
  console.warn(
    `[fallback-observations] ${message}` +
      (also > 0 ? ` (+${also} more since last warn)` : '') +
      (err ? `: ${(err as Error)?.message ?? String(err)}` : ''),
  );
  state.lastWarnedAt = now;
  state.suppressedSinceWarn = 0;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0 || t.length > FALLBACK_NAME_MAX_CHARS) return null;
  return t;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Validate one decision. Returns a reason string when it is refused, else null.
 * Exported for tests and for callers that want to assert their own inputs.
 */
export function fallbackDecisionProblem(mechanism: unknown, d: Partial<FallbackDecision> | null | undefined): string | null {
  if (!cleanName(mechanism)) return `mechanism must be a non-empty string of at most ${FALLBACK_NAME_MAX_CHARS} chars`;
  if (!d || typeof d !== 'object') return 'decision must be an object';
  if (!isCount(d.eligible)) return 'eligible must be a non-negative integer';
  if (!isCount(d.applied)) return 'applied must be a non-negative integer';
  if (d.applied > d.eligible) return `applied (${d.applied}) exceeds eligible (${d.eligible})`;
  if (d.populationKnown !== undefined && typeof d.populationKnown !== 'boolean') return 'populationKnown must be a boolean';
  if (d.populationKnown === false && (d.eligible !== 0 || d.applied !== 0)) return 'unknown population must carry zero eligible/applied counts';
  if (!cleanName(d.reason)) return `reason must be a non-empty string of at most ${FALLBACK_NAME_MAX_CHARS} chars`;
  if (d.scope != null && (typeof d.scope !== 'string' || d.scope.length > FALLBACK_SCOPE_MAX_CHARS)) {
    return `scope must be a string of at most ${FALLBACK_SCOPE_MAX_CHARS} chars`;
  }
  return null;
}

function installExitHook(): void {
  if (state.exitHookInstalled || typeof process === 'undefined' || typeof process.once !== 'function') return;
  state.exitHookInstalled = true;
  process.once('beforeExit', () => {
    if (state.pending.length > 0) void flushFallbackObservations();
  });
}

function scheduleFlush(): void {
  if (state.pending.length >= FALLBACK_FLUSH_BATCH) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    // One flush at a time: an in-flight flush re-checks the buffer when it
    // finishes, so a burst never queues one waiting flush per observation.
    if (!state.flushing) void flushFallbackObservations();
    return;
  }
  if (state.timer || state.flushing) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushFallbackObservations();
  }, FALLBACK_FLUSH_DELAY_MS);
  // Never keep a process alive just to flush telemetry; beforeExit covers drain.
  (state.timer as { unref?: () => void }).unref?.();
}

/**
 * Record one fallback decision batch. Enqueue-only: never throws, never awaits.
 * Returns false when the input was refused (it is counted and warned, not raised).
 */
export function observeFallback(mechanism: string, decision: FallbackDecision, opts: ObserveFallbackOptions = {}): boolean {
  const problem = fallbackDecisionProblem(mechanism, decision);
  if (problem) {
    state.rejected += 1;
    state.totalRejected += 1;
    warnThrottled(`refused observation for '${String(mechanism).slice(0, 80)}': ${problem}`);
    return false;
  }
  if (opts.correlationId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.correlationId)) {
    state.rejected += 1;
    state.totalRejected += 1;
    warnThrottled('refused observation with an invalid correlation id');
    return false;
  }
  const row: PendingRow = {
    sql: opts.sql,
    workspace_id: opts.workspaceId?.trim() || process.env.PAPERCUSP_WORKSPACE_ID?.trim() || 'default',
    mechanism: mechanism.trim(),
    eligible: decision.eligible,
    applied: decision.applied,
    population_known: decision.populationKnown ?? true,
    reason: decision.reason.trim(),
    scope: decision.scope ?? null,
    process_tag: opts.processTag ?? null,
    correlation_id: opts.correlationId ?? null,
    observed_at: opts.observedAt ?? new Date(),
    samples: 1,
  };
  if (!coalesceInto(row)) {
    if (state.pending.length >= FALLBACK_BUFFER_MAX) {
      const oldest = state.pending.shift()!;
      forgetOpen(oldest);
      state.dropped += oldest.samples;
      state.totalDropped += oldest.samples;
      warnThrottled(`buffer full (${FALLBACK_BUFFER_MAX}); dropped the oldest unflushed observation`);
    }
    state.pending.push(row);
    rememberOpen(row);
  }
  installExitHook();
  scheduleFlush();
  return true;
}

/** Coalesce key, or null when the row must stay its own row (an exact join key). */
function coalesceKey(row: PendingRow): string | null {
  if (row.correlation_id != null) return null;
  return JSON.stringify([row.workspace_id, row.mechanism, row.reason, row.scope, row.process_tag, row.population_known]);
}

/** Fold `row` into an identical unflushed row; false when there is none to fold into. */
function coalesceInto(row: PendingRow): boolean {
  const key = coalesceKey(row);
  if (key === null) return false;
  const open = state.open.get(row.sql)?.get(key);
  if (!open) return false;
  if (Math.abs(row.observed_at.getTime() - open.observed_at.getTime()) > FALLBACK_COALESCE_SPAN_MS) return false;
  if (open.eligible + row.eligible > INT4_MAX || open.samples + row.samples > INT4_MAX) return false;
  open.eligible += row.eligible;
  open.applied += row.applied;
  open.samples += row.samples;
  state.totalCoalesced += row.samples;
  return true;
}

function rememberOpen(row: PendingRow): void {
  const key = coalesceKey(row);
  if (key === null) return;
  let byKey = state.open.get(row.sql);
  if (!byKey) {
    byKey = new Map();
    state.open.set(row.sql, byKey);
  }
  byKey.set(key, row);
}

function forgetOpen(row: PendingRow): void {
  const key = coalesceKey(row);
  if (key === null) return;
  const byKey = state.open.get(row.sql);
  if (byKey?.get(key) === row) byKey.delete(key);
}

async function writeBatch(sql: Sql, rows: PendingRow[]): Promise<void> {
  const values = rows.map(({ sql: _ignored, ...r }) => r);
  await sql`
    INSERT INTO harness_shared.fallback_observations
      ${sql(values, 'workspace_id', 'mechanism', 'eligible', 'applied', 'reason', 'scope', 'process_tag', 'correlation_id', 'observed_at', 'samples', 'population_known')}
  `;
}

async function flushOnce(defaultSql: Sql | undefined): Promise<FlushResult> {
  const batch = state.pending.splice(0, state.pending.length);
  // These rows now belong to this write: later observations must start new rows.
  state.open.clear();
  const result: FlushResult = { written: 0, failed: 0, dropped: state.dropped, rejected: state.rejected };
  state.dropped = 0;
  state.rejected = 0;
  if (batch.length === 0) return result;
  // Group by handle so an explicit per-call `sql` is honoured.
  const groups = new Map<Sql | undefined, PendingRow[]>();
  for (const row of batch) {
    const key = row.sql ?? defaultSql;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  for (const [handle, rows] of groups) {
    let sql: Sql;
    try {
      sql = handle ?? getOrgPg().sql;
    } catch (err) {
      result.failed += rows.length;
      state.totalFailed += rows.length;
      warnThrottled(`no Postgres handle; ${rows.length} observation(s) lost`, err);
      continue;
    }
    for (let i = 0; i < rows.length; i += FALLBACK_FLUSH_BATCH) {
      const chunk = rows.slice(i, i + FALLBACK_FLUSH_BATCH);
      try {
        await writeBatch(sql, chunk);
        result.written += chunk.length;
      } catch (err) {
        result.failed += chunk.length;
        state.totalFailed += chunk.length;
        warnThrottled(`write failed; ${chunk.length} observation(s) lost`, err);
      }
    }
  }
  return result;
}

/**
 * Write every buffered observation now. Never throws; reports what happened.
 * Concurrent callers share one in-flight flush, then a follow-up flush picks up
 * anything enqueued meanwhile.
 */
export async function flushFallbackObservations(opts: { sql?: Sql } = {}): Promise<FlushResult> {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  while (state.flushing) await state.flushing;
  const p = flushOnce(opts.sql);
  state.flushing = p;
  try {
    return await p;
  } finally {
    state.flushing = null;
    // Pick up whatever was enqueued while this flush was writing.
    if (state.pending.length > 0) scheduleFlush();
  }
}

/** Lifetime counters since process start (or the last test reset). */
export function fallbackObservationCounters(): { dropped: number; rejected: number; failed: number; coalesced: number } {
  return {
    dropped: state.totalDropped,
    rejected: state.totalRejected,
    failed: state.totalFailed,
    coalesced: state.totalCoalesced,
  };
}

/** Pure: fold per-reason aggregates into a window summary. */
export function summarizeFallbackWindow(
  mechanism: string,
  windowMs: number,
  aggregates: readonly FallbackReasonAggregate[],
): FallbackWindow {
  const byReason = new Map<string, Required<FallbackReasonAggregate>>();
  for (const a of aggregates) {
    const prev = byReason.get(a.reason);
    if (prev) {
      prev.samples += a.samples;
      prev.eligible += a.eligible;
      prev.applied += a.applied;
      prev.unknownSamples += a.unknownSamples ?? 0;
    } else {
      byReason.set(a.reason, { reason: a.reason, samples: a.samples, eligible: a.eligible, applied: a.applied, unknownSamples: a.unknownSamples ?? 0 });
    }
  }
  const reasons: FallbackReasonSummary[] = [...byReason.values()]
    .map((r) => ({ ...r, fellBack: Math.max(0, r.eligible - r.applied) }))
    .sort((a, b) => b.fellBack - a.fellBack || b.samples - a.samples || a.reason.localeCompare(b.reason));
  let samples = 0;
  let eligible = 0;
  let applied = 0;
  let fellBack = 0;
  let unknownSamples = 0;
  for (const r of reasons) {
    samples += r.samples;
    eligible += r.eligible;
    applied += r.applied;
    fellBack += r.fellBack;
    unknownSamples += r.unknownSamples;
  }
  const top = fellBack > 0 ? reasons[0] : undefined;
  const knownAppliedRate = eligible > 0 ? applied / eligible : null;
  const populationComplete = eligible > 0 && unknownSamples === 0;
  return {
    mechanism,
    windowMs,
    samples,
    eligible,
    applied,
    knownAppliedRate,
    unknownSamples,
    populationComplete,
    appliedRate: populationComplete ? knownAppliedRate : null,
    reasons,
    dominantReason: top ? top.reason : null,
    dominantShare: top ? top.fellBack / fellBack : null,
  };
}

/**
 * Aggregate one mechanism's observations over the trailing `windowMs`.
 * Without `workspaceId`, every workspace's rows are included.
 */
export async function readFallbackWindow(
  mechanism: string,
  windowMs: number,
  opts: { sql?: Sql; workspaceId?: string; processTag?: string; now?: Date } = {},
): Promise<FallbackWindow> {
  const sql = opts.sql ?? getOrgPg().sql;
  const since = new Date((opts.now ?? new Date()).getTime() - windowMs);
  const ws = opts.workspaceId ?? null;
  const processTag = opts.processTag ?? null;
  const rows = await sql<Array<{ reason: string; samples: number | string; eligible: number | string; applied: number | string; unknown_samples: number | string }>>`
    SELECT reason,
           sum(samples)::bigint  AS samples,
           sum(eligible)::bigint AS eligible,
           sum(applied)::bigint  AS applied,
           sum(CASE WHEN population_known IS FALSE OR
             (population_known IS NULL AND mechanism = 'gate-pass-reuse' AND eligible = 0)
             THEN samples ELSE 0 END)::bigint AS unknown_samples
      FROM harness_shared.fallback_observations
     WHERE mechanism = ${mechanism.trim()}
       AND observed_at >= ${since}
       AND (${ws}::text IS NULL OR workspace_id = ${ws}::text)
       AND (${processTag}::text IS NULL OR process_tag = ${processTag}::text)
     GROUP BY reason
  `;
  return summarizeFallbackWindow(
    mechanism.trim(),
    windowMs,
    rows.map((r) => ({ reason: r.reason, samples: Number(r.samples), eligible: Number(r.eligible), applied: Number(r.applied), unknownSamples: Number(r.unknown_samples) })),
  );
}

/** One scope's window: `scope` is null for observations recorded without one. */
export interface ScopedFallbackWindow {
  scope: string | null;
  window: FallbackWindow;
}

/**
 * Like {@link readFallbackWindow}, but one window PER SCOPE — for a mechanism whose
 * observations carry a meaningful sub-scope (the gate's pass reuse records one per task,
 * BAR R-3), where a collapse in one scope must not be averaged away by healthy siblings.
 * Sorted by scope (nulls first) so callers get a stable order.
 */
export async function readFallbackWindowsByScope(
  mechanism: string,
  windowMs: number,
  opts: { sql?: Sql; workspaceId?: string; processTag?: string; now?: Date } = {},
): Promise<ScopedFallbackWindow[]> {
  const sql = opts.sql ?? getOrgPg().sql;
  // Half-open windows make two adjacent reads disjoint: [now - windowMs, now).
  // Without the upper bound, a boundary observation appears in both the current
  // and previous windows and can soften a real yield drop.
  const until = opts.now ?? new Date();
  const since = new Date(until.getTime() - windowMs);
  const ws = opts.workspaceId ?? null;
  const processTag = opts.processTag ?? null;
  const name = mechanism.trim();
  const rows = await sql<Array<{ scope: string | null; reason: string; samples: number | string; eligible: number | string; applied: number | string; unknown_samples: number | string }>>`
    SELECT scope,
           reason,
           sum(samples)::bigint  AS samples,
           sum(eligible)::bigint AS eligible,
           sum(applied)::bigint  AS applied,
           sum(CASE WHEN population_known IS FALSE OR
             (population_known IS NULL AND mechanism = 'gate-pass-reuse' AND eligible = 0)
             THEN samples ELSE 0 END)::bigint AS unknown_samples
      FROM harness_shared.fallback_observations
     WHERE mechanism = ${name}
       AND observed_at >= ${since}
       AND observed_at < ${until}
       AND (${ws}::text IS NULL OR workspace_id = ${ws}::text)
       AND (${processTag}::text IS NULL OR process_tag = ${processTag}::text)
     GROUP BY scope, reason
  `;
  const byScope = new Map<string | null, FallbackReasonAggregate[]>();
  for (const r of rows) {
    const key = r.scope ?? null;
    const agg = { reason: r.reason, samples: Number(r.samples), eligible: Number(r.eligible), applied: Number(r.applied), unknownSamples: Number(r.unknown_samples) };
    const list = byScope.get(key);
    if (list) list.push(agg);
    else byScope.set(key, [agg]);
  }
  return [...byScope.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([scope, aggs]) => ({ scope, window: summarizeFallbackWindow(name, windowMs, aggs) }));
}

/**
 * Delete observations older than `retentionMs`, in bounded batches so a large
 * backlog never becomes one long-running DELETE. Returns rows deleted.
 */
export async function pruneFallbackObservations(
  opts: { sql?: Sql; retentionMs?: number; batchSize?: number; maxBatches?: number; now?: Date } = {},
): Promise<number> {
  const sql = opts.sql ?? getOrgPg().sql;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.retentionMs ?? FALLBACK_RETENTION_MS));
  const batchSize = Math.max(1, opts.batchSize ?? 5_000);
  const maxBatches = Math.max(1, opts.maxBatches ?? 20);
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = await sql`
      DELETE FROM harness_shared.fallback_observations
       WHERE id IN (
         SELECT id FROM harness_shared.fallback_observations
          WHERE observed_at < ${cutoff}
          ORDER BY observed_at
          LIMIT ${batchSize}
       )
    `;
    const n = res.count ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

/** Test hook: number of buffered, unflushed observations. */
export function _pendingFallbackObservationCount(): number {
  return state.pending.length;
}

/** Test hook: clear the buffer, counters, timer and warn throttle. */
export function _resetFallbackObservationsForTests(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.pending = [];
  state.open = new Map();
  state.totalCoalesced = 0;
  state.dropped = 0;
  state.rejected = 0;
  state.totalDropped = 0;
  state.totalRejected = 0;
  state.totalFailed = 0;
  state.flushing = null;
  state.lastWarnedAt = 0;
  state.suppressedSinceWarn = 0;
}

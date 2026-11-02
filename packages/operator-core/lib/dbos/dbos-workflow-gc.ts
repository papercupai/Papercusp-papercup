/**
 * dbos-workflow-gc — prune old TERMINAL DBOS system rows
 * (infra-self-healing-supervision-2026-06-19, R4-5; EI-1607 defense-in-depth).
 *
 * `dbos.workflow_status` grew to 325k+ rows (operation_outputs 484k) with NO retention —
 * every completed workflow accrues forever, bloating the system DB and slowing the
 * scheduler/recovery scans that walk it (a contributor to routinesTick latency). DBOS
 * 4.18 ships no built-in GC, so this mirrors the codebase's existing hand-rolled GC
 * workflows (coordNotifyGc, outboxBackstopGc): delete workflows in a TERMINAL status
 * older than a generous retention window, plus their operation_outputs.
 *
 * SAFETY: only the terminal statuses are ever matched — PENDING / ENQUEUED (in-flight)
 * rows are NEVER touched, so DBOS recovery (which resumes only non-terminal workflows)
 * is unaffected. operation_outputs are deleted FIRST (FK order). Batched (LIMIT) to
 * bound the transaction/lock. DEFAULT-ON + 2d retention (owner durable-stability
 * directive, 2026-06-19): VALIDATED live on 2026-06-19 — this GC drained workflow_status
 * 253MB→3MB and immediately un-froze the routine engine. It MUST run recurring or the
 * table re-bloats; disable only with PAPERCUSP_DBOS_WORKFLOW_GC=0. Retention is env-tunable
 * (PAPERCUSP_DBOS_WORKFLOW_GC_DAYS, default 2 — half-hourly bounded passes keep the
 * table far under the ~300k freeze threshold).
 *
 * ROOT CAUSE (corrected 2026-06-19): the freeze WAS the workflow_status bloat — 328k rows
 * (325k terminal SUCCESS) made every DBOS executor dequeue scan 253MB, starving routinesTick
 * → hive-wake never fired → Queen frozen. The bloat SOURCE is ~8 ephemeral high-freq checks
 * persisted as durable DBOS workflows (~200k rows/day); the SOURCE fix (run them as in-process
 * intervals) is EI-1622 — this GC is the BACKSTOP. NOTE on the EI-1607 "bounded catch-up"
 * half: DBOS `skip-missed` did NOT prevent a missed-cron PENDING pile (~2380 stale scheduled
 * instances observed re-piling mid-incident), so singleton-routinesTick (an EI-1622 sibling)
 * is the real catch-up source-fix; bounded-catch-up is the maintenance backstop.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_ALARM_ESCALATION_COOLDOWN_MS, escalateAlarm, resolveAlarm,
  type AlarmAttentionDeps } from '../alarm-attention';

export const DBOS_TERMINAL_STATUSES = [
  'SUCCESS',
  'ERROR',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  'CANCELLED',
] as const;

// An exactly hourly slot leaves no room for varying dequeue/entry delays:
// consecutive actual starts can exceed one hour despite no missed slot.
// Keep 30 minutes of dispatch headroom and avoid the top-of-hour stampede.
export const DBOS_WORKFLOW_GC_CRONTAB = '0 15,45 * * * *';
const DEFAULT_RETENTION_DAYS = 2; // Tune via PAPERCUSP_DBOS_WORKFLOW_GC_DAYS.
const DEFAULT_BATCH_LIMIT = 5000;
/**
 * Per-invocation maintenance budget. This is a liveness policy, not a
 * productive-capacity ceiling: each DELETE remains a small committed batch,
 * and a later routine tick resumes where this one stopped.  The old
 * MAX_BATCHES constant encoded an arbitrary 10M-row throughput ceiling and
 * silently left terminal rows behind once it was reached.
 */
const DEFAULT_TIME_BUDGET_MS = 30_000;
const TERMINAL_TIME_BOUND_MS = 60_000;

export function dbosWorkflowGcEnabled(): boolean {
  // DEFAULT-ON (owner durable-stability directive, 2026-06-19): the GC MUST run
  // recurring or workflow_status re-bloats (325k SUCCESS → DBOS scheduler scans
  // saturate the loop → routine-engine freeze — the live incident). Validated live
  // tonight (253MB→3MB, terminal-only, cascade-clean). Disable with
  // PAPERCUSP_DBOS_WORKFLOW_GC=0.
  return process.env.PAPERCUSP_DBOS_WORKFLOW_GC !== '0';
}

export function dbosWorkflowGcRetentionDays(): number {
  const d = Number(process.env.PAPERCUSP_DBOS_WORKFLOW_GC_DAYS);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_RETENTION_DAYS;
}

export const DBOS_HISTORY_CEILING_CONDITION_KEY = 'alarm:dbos-workflow-history-ceiling';
const DEFAULT_HISTORY_CEILING_ROWS = 300_000;

/** Extend the existing GC environment knobs; this threshold is rows, not bytes. */
export function dbosWorkflowHistoryCeiling(): number {
  const rows = Number(process.env.PAPERCUSP_DBOS_WORKFLOW_HISTORY_CEILING);
  return Number.isSafeInteger(rows) && rows > 0 ? rows : DEFAULT_HISTORY_CEILING_ROWS;
}

export interface DbosHistoryAlarmDeps extends AlarmAttentionDeps {
  readCount?: () => Promise<number>;
}

/** Direct PG observation and the shared attention rail; no DBOS executor is needed. */
export async function runDbosWorkflowHistoryAlarmOnce(opts: {
  ceilingRows?: number;
  deps?: DbosHistoryAlarmDeps;
} = {}): Promise<{ count: number; ceilingRows: number; breached: boolean }> {
  const ceilingRows = opts.ceilingRows ?? dbosWorkflowHistoryCeiling();
  if (!Number.isSafeInteger(ceilingRows) || ceilingRows <= 0) throw new Error('Invalid DBOS history row ceiling');
  const deps = opts.deps ?? {};
  const count = await (deps.readCount ?? (async () => {
    const rows = await getOrgPg().sql<Array<{ n: number | string }>>`
      SELECT count(*)::bigint AS n FROM dbos.workflow_status`;
    return Number(rows[0]?.n);
  }))();
  // A failed/unreadable measurement must never be interpreted as zero or recovery.
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid DBOS history row count');
  const breached = count > ceilingRows;
  if (breached) {
    await escalateAlarm({
      title: 'DBOS workflow history exceeds its row ceiling',
      body: `Workflow history has ${count} rows, above its ${ceilingRows}-row ceiling. Check cleanup progress and high-volume producers.`,
      source: 'dbos-history-ceiling',
      conditionKey: DBOS_HISTORY_CEILING_CONDITION_KEY,
      cooldownMs: DEFAULT_ALARM_ESCALATION_COOLDOWN_MS,
      data: { rowCount: count, ceilingRows },
    }, deps);
  } else {
    await resolveAlarm(DBOS_HISTORY_CEILING_CONDITION_KEY, 'dbos-history-ceiling', deps);
  }
  return { count, ceilingRows, breached };
}

/** Injectable query seams (sql-backed in production; faked in tests). */
export interface DbosGcDeps {
  /** Terminal workflow_uuids with updated_at < cutoff, oldest created_at/uuid first. */
  selectTerminalVictims: (cutoffMs: number, limit: number, signal?: AbortSignal) => Promise<string[]>;
  /** Delete operation_outputs for these workflow_uuids; returns rows deleted. */
  deleteOutputs: (ids: string[], signal?: AbortSignal) => Promise<number>;
  /** Delete workflow_status for these workflow_uuids; returns rows deleted. */
  deleteWorkflows: (ids: string[], signal?: AbortSignal) => Promise<number>;
}

export interface DbosWorkflowGcResult {
  skipped: boolean;
  deletedWorkflows: number;
  deletedOutputs: number;
  cutoffMs: number | null;
  batches: number;
  budgetExhausted?: boolean;
  durationMs: number;
}

type SqlLike = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<T> & { cancel?: () => void };

/** Forward the pass deadline to postgres.js, so a failed pass leaves no live SQL behind. */
async function gcQuery<T>(query: PromiseLike<T> & { cancel?: () => void }, signal?: AbortSignal): Promise<T> {
  const cancel = () => query.cancel?.();
  if (signal?.aborted) {
    cancel();
    throw signal.reason;
  }
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await query;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Build the production sql-backed query seams. */
export function dbosWorkflowGcSqlDeps(sql: SqlLike): DbosGcDeps {
  const statuses = [...DBOS_TERMINAL_STATUSES];
  return {
    selectTerminalVictims: async (cutoffMs, limit, signal) => {
      const rows = await gcQuery(sql<Array<{ workflow_uuid: string }>>`
        SELECT workflow_uuid FROM dbos.workflow_status
         WHERE status = ANY(${statuses})
           AND updated_at < ${cutoffMs}
         ORDER BY created_at ASC, workflow_uuid ASC
         LIMIT ${limit}`, signal);
      return rows.map((r) => r.workflow_uuid);
    },
    deleteOutputs: async (ids, signal) => {
      if (ids.length === 0) return 0;
      const rows = await gcQuery(sql<Array<{ n: number }>>`
        WITH d AS (DELETE FROM dbos.operation_outputs WHERE workflow_uuid = ANY(${ids}) RETURNING 1)
        SELECT count(*)::int AS n FROM d`, signal);
      return rows[0]?.n ?? 0;
    },
    deleteWorkflows: async (ids, signal) => {
      if (ids.length === 0) return 0;
      const rows = await gcQuery(sql<Array<{ n: number }>>`
        WITH d AS (DELETE FROM dbos.workflow_status WHERE workflow_uuid = ANY(${ids}) RETURNING 1)
        SELECT count(*)::int AS n FROM d`, signal);
      return rows[0]?.n ?? 0;
    },
  };
}

/**
 * Prune old terminal DBOS rows. No-op (skipped) unless armed. Batched to bound the
 * lock; deletes operation_outputs before workflow_status; never matches in-flight rows.
 */
export async function runDbosWorkflowGcOnce(
  opts: {
    enabled?: boolean;
    retentionDays?: number;
    batchLimit?: number;
    timeBudgetMs?: number;
    nowMs?: number;
    nowClockMs?: () => number;
    deps?: DbosGcDeps;
  } = {},
): Promise<DbosWorkflowGcResult> {
  const nowClockMs = opts.nowClockMs ?? Date.now;
  const startedAtMs = nowClockMs();
  const finish = (result: Omit<DbosWorkflowGcResult, 'durationMs'>): DbosWorkflowGcResult => {
    const measured = { ...result, durationMs: Math.max(0, nowClockMs() - startedAtMs) };
    console.log(`[dbos-workflow-gc] ${JSON.stringify(measured)}`);
    return measured;
  };
  const enabled = opts.enabled ?? dbosWorkflowGcEnabled();
  if (!enabled) return finish({ skipped: true, deletedWorkflows: 0, deletedOutputs: 0, cutoffMs: null, batches: 0, budgetExhausted: false });

  const days = opts.retentionDays ?? dbosWorkflowGcRetentionDays();
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const nowMs = opts.nowMs ?? Date.now();
  const timeBudgetMs = Math.min(opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS, DEFAULT_TIME_BUDGET_MS);
  const cutoffMs = nowMs - days * 86_400_000;

  let deletedWorkflows = 0;
  let deletedOutputs = 0;
  let batches = 0;
  let budgetExhausted = false;
  const control = new AbortController();
  const deadlineError = new Error(`DBOS workflow GC exceeded its ${TERMINAL_TIME_BOUND_MS}ms terminal deadline`);
  let terminalTimer: ReturnType<typeof setTimeout> | undefined;
  const terminal = new Promise<never>((_resolve, reject) => {
    terminalTimer = setTimeout(() => {
      reject(deadlineError);
      control.abort(deadlineError);
    }, Math.max(0, TERMINAL_TIME_BOUND_MS - (nowClockMs() - startedAtMs)));
  });
  const run = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (control.signal.aborted || nowClockMs() - startedAtMs >= TERMINAL_TIME_BOUND_MS) {
      control.abort(deadlineError);
      throw deadlineError;
    }
    const result = await Promise.race([operation(control.signal), terminal]);
    if (nowClockMs() - startedAtMs >= TERMINAL_TIME_BOUND_MS) {
      control.abort(deadlineError);
      throw deadlineError;
    }
    return result;
  };
  try {
    const deps = opts.deps ?? dbosWorkflowGcSqlDeps(getOrgPg().sql as SqlLike);
    while (true) {
      if (nowClockMs() - startedAtMs >= timeBudgetMs) {
        budgetExhausted = true;
        break;
      }
      const ids = await run(signal => deps.selectTerminalVictims(cutoffMs, batchLimit, signal));
      // Selection can consume the remaining budget. Leave those victims for
      // the next pass rather than starting deletion after the liveness window.
      if (nowClockMs() - startedAtMs >= timeBudgetMs) {
        budgetExhausted = true;
        break;
      }
      if (ids.length === 0) break;
      batches += 1;
      // operation_outputs first (FK order), then the workflow rows.
      deletedOutputs += await run(signal => deps.deleteOutputs(ids, signal));
      const removed = await run(signal => deps.deleteWorkflows(ids, signal));
      deletedWorkflows += removed;
      if (removed === 0) throw new Error('DBOS workflow GC made no deletion progress for selected eligible rows');
      // Finish the committed batch, then yield before admitting another.
      if (nowClockMs() - startedAtMs >= timeBudgetMs) {
        budgetExhausted = true;
        break;
      }
      if (ids.length < batchLimit) break;
    }
  } catch (error) {
    console.error(`[dbos-workflow-gc] ${JSON.stringify({
      skipped: false, deletedWorkflows, deletedOutputs, cutoffMs, batches,
      budgetExhausted, durationMs: Math.max(0, nowClockMs() - startedAtMs),
      error: error instanceof Error ? error.message : String(error),
    })}`);
    throw error; // Preserve DBOS failure/retry semantics after recording partial progress.
  } finally {
    clearTimeout(terminalTimer);
  }
  return finish({ skipped: false, deletedWorkflows, deletedOutputs, cutoffMs, batches, budgetExhausted });
}

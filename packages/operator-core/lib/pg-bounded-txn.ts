/**
 * pg-bounded-txn — a bounded transaction on the operator admin pool.
 *
 * WHY (reliability): getOrgPg() (the `harness_admin` pool) carries a role-default
 * `lock_timeout` (15s) + `idle_in_transaction_session_timeout` (60s) but DELIBERATELY
 * NO `statement_timeout` — migrations + long maintenance tooling run on this same
 * pool and must be allowed to run unbounded. The cost of that omission: an
 * INTERACTIVE write tool that runs raw queries on this pool (e.g. work_items:comment
 * → commentIssue → getOrCreateThread/addPost) has NO per-statement bound. A query
 * that stalls for any NON-lock reason — a CPU-starved backend, a slow scan, a buffer
 * wait — runs UNBOUNDED and HANGS the MCP call until the client transport gives up.
 *
 * Crucially, a JS-level watchdog cannot rescue it: postgres-js does NOT cancel an
 * in-flight query when an AbortController fires, so the route-stack 30s abort only
 * yields a 408 once the handler finally returns. The ONLY thing that actually
 * unblocks a wedged query is a DB-side statement_timeout. (Root cause of the
 * reported "work_items:comment hung, then timed out on a bounded retry.")
 *
 * boundedOrgTxn wraps admin-pool work in ONE transaction with a
 * SET LOCAL statement_timeout + lock_timeout, so the work is:
 *   - ATOMIC  — partial writes can't half-land and a post-stall retry can't
 *               duplicate (every statement commits together or not at all); and
 *   - BOUNDED — a stall surfaces as a fast, typed OrgTxnTimeoutError (mapped from
 *               PG 57014 statement_timeout / 55P03 lock_timeout) that the caller
 *               turns into a clean { ok:false, error } result (runBulk does this
 *               for the bulk tools), instead of an indefinite hang.
 *
 * It is the interactive transaction counterpart to pg-read-query's bounded READ ONLY txn,
 * and a deliberately lighter sibling of locks/inWorkspaceTxn: NO per-workspace
 * advisory lock (a coordination append must not serialize the entire workspace).
 * Migrations + long tooling keep calling getOrgPg() directly and stay unbounded.
 */

import {
  DEFAULT_TX_ACQUIRE_DEADLINE_MS,
  DbCallDeadlineError,
  getOrgPg,
  retryBeforeCallbackStarts,
  retryOnRetryableDbDeadline,
  withAcquisitionDeadline,
} from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';

/** The postgres-js client type the org handle exposes (same alias pg-read-query uses). */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

type CancelableQuery = {
  cancel?: () => void | Promise<unknown>;
  /** postgres.js Query objects expose these; test doubles may omit them. */
  executed?: boolean;
  active?: boolean;
  catch?: (onRejected: (reason: unknown) => void) => Promise<unknown>;
};

/**
 * Wrap a postgres-js transaction client so an abandoned caller can cancel every
 * query it has started. `withBoundedTimeout` deliberately races the caller's
 * promise instead of awaiting it after the deadline; without this bridge the
 * transaction would keep its connection busy until PostgreSQL eventually
 * finished it (EI-23070293747146376).
 */
function cancellableTransaction(
  tx: OrgSql,
  signal?: AbortSignal,
): {
  tx: OrgSql;
  assertNotAborted: () => void;
  abort: Promise<never> | undefined;
  cleanup: () => void;
} {
  if (!signal) {
    return { tx, assertNotAborted: () => undefined, abort: undefined, cleanup: () => undefined };
  }

  const active = new Set<CancelableQuery>();
  let cancelled = signal.aborted;
  let removeAbortListener: (() => void) | undefined;
  const abortReason = () => signal.reason ?? Object.assign(new Error('boundedOrgTxn aborted'), { name: 'AbortError' });
  const cancelQuery = (query: CancelableQuery) => {
    // postgres.js returns a lazy Query for BOTH executable statements and SQL
    // fragments. Cancelling an unexecuted fragment rejects its own promise with
    // 57014 even though nobody awaited it; that unhandled rejection killed the
    // operator host. A completed query also has nothing left to cancel.
    if (query.executed === false || query.active === false) return;
    try {
      // Query.cancel() returns void: it is the original Query promise, not the
      // return value of cancel(), that rejects when PostgreSQL acknowledges the
      // cancellation. Observe it before sending the cancellation request.
      void query.catch?.(() => undefined);
      void Promise.resolve(query.cancel?.()).catch(() => undefined);
    } catch {
      // Cancellation is best-effort; the original abort/error remains authoritative.
    }
  };
  const cancelActive = () => {
    cancelled = true;
    for (const query of active) {
      cancelQuery(query);
    }
  };
  const assertNotAborted = () => {
    if (cancelled || signal.aborted) throw abortReason();
  };
  const track = <T>(query: T): T => {
    const candidate = query as T & CancelableQuery;
    if (!candidate || typeof candidate.cancel !== 'function') return query;
    // postgres.js uses the same thenable Query object for a top-level query and
    // for a SQL fragment. Assimilating it here with Promise.resolve(query)
    // executes a fragment as a standalone statement. That produced parser
    // errors such as `syntax error at or near "last_released_by"` from the
    // scheduler's release-floor fragment. Keep the object in the cancellation
    // set without observing its then/finally methods; postgres.js will execute
    // it only when the caller awaits the completed outer query.
    active.add(candidate);
    if (cancelled) {
      cancelQuery(candidate);
    }
    return query;
  };
  const invoke = (...args: unknown[]) => {
    assertNotAborted();
    return track(Reflect.apply(tx as unknown as (...input: unknown[]) => unknown, tx, args));
  };
  const wrapped = Object.assign(invoke, tx) as unknown as OrgSql;
  const unsafe = (tx as unknown as { unsafe?: (...args: unknown[]) => unknown }).unsafe;
  if (unsafe) {
    Object.defineProperty(wrapped, 'unsafe', {
      configurable: true,
      value: (...args: unknown[]) => {
        assertNotAborted();
        return track(Reflect.apply(unsafe, tx, args));
      },
    });
  }

  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => {
      cancelActive();
      reject(abortReason());
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
  });
  // A pre-aborted signal rejects `abort` synchronously, while the transaction
  // callback still throws from `assertNotAborted()` before it reaches the
  // Promise.race below. Observe the promise now so that early assertion errors
  // cannot leave this sibling rejection unhandled; the original rejected
  // promise remains the one raced when the callback reaches that path.
  void abort.catch(() => undefined);
  return {
    tx: wrapped,
    assertNotAborted,
    abort,
    cleanup: () => {
      removeAbortListener?.();
      active.clear();
    },
  };
}

export type CandidateWaitSample =
  | {
      status: 'sampled';
      targetPid: number;
      waitEventType: string | null;
      waitEvent: string | null;
      blockingPids: number[];
    }
  | { status: 'no-active'; targetPid: number }
  | {
      status: 'unavailable';
      targetPid?: number;
      reason: 'cancelled' | 'deadline' | 'query-error';
      /** Where this observer failed; absent on historical diagnostic packets. */
      phase?: 'acquire' | 'setup' | 'sample' | 'settle';
    };

export type CandidateWaitSnapshot = CandidateWaitSample & {
  statementCapMs: number;
  sampleAfterMs: number;
};

const CANDIDATE_WAIT_OBSERVER_TIMEOUT_MS = 100;

/**
 * Take one bounded, PID-and-query-start-targeted pg_stat_activity sample.
 * This is an instantaneous observation, not evidence about the full duration
 * of the target statement. The caller owns cancellation when that statement settles.
 */
export async function sampleCandidateWaitOnce(
  client: OrgSql,
  targetPid: number,
  targetQueryStartedAfter: Date,
  signal: AbortSignal,
): Promise<CandidateWaitSample> {
  type WaitRow = {
    waitEventType: string | null;
    waitEvent: string | null;
    blockingPids: number[];
  };
  let phase: 'acquire' | 'setup' | 'sample' | 'settle' = 'acquire';

  try {
    const rows = await withAcquisitionDeadline(
      ({ disarm, expired }) =>
        client.begin(async (rawTx) => {
          // A timed-out begin can complete late. Never run even the timeout setup
          // after its acquisition deadline or after the target statement settled.
          if (expired() || signal.aborted) throw new Error('candidate wait observer cancelled before begin');
          const cancellation = cancellableTransaction(rawTx as unknown as OrgSql, signal);
          try {
            cancellation.assertNotAborted();
            phase = 'setup';
            await cancellation.tx`SELECT set_config('lock_timeout', ${`${CANDIDATE_WAIT_OBSERVER_TIMEOUT_MS}ms`}, true),
                                        set_config('statement_timeout', ${`${CANDIDATE_WAIT_OBSERVER_TIMEOUT_MS}ms`}, true)`;
            if (expired()) throw new Error('candidate wait observer acquisition deadline expired');
            cancellation.assertNotAborted();
            disarm();
            phase = 'sample';
            const query = cancellation.tx<WaitRow[]>`
              SELECT a.wait_event_type AS "waitEventType",
                     a.wait_event AS "waitEvent",
                     pg_blocking_pids(a.pid) AS "blockingPids"
                FROM pg_stat_activity a
               WHERE a.datname = current_database()
                 AND a.pid = ${targetPid}
                 AND a.query_start >= ${targetQueryStartedAfter}
                 AND a.state = 'active'
               LIMIT 1`;
            const rows = await (cancellation.abort ? Promise.race([query, cancellation.abort]) : query);
            phase = 'settle';
            return rows;
          } finally {
            cancellation.cleanup();
          }
        }),
      {
        ms: CANDIDATE_WAIT_OBSERVER_TIMEOUT_MS,
        label: 'scheduler:get_next:candidate-wait-observer',
      },
    );
    const row = rows[0];
    if (!row) return { status: 'no-active', targetPid };
    return {
      status: 'sampled',
      targetPid,
      waitEventType: row.waitEventType,
      waitEvent: row.waitEvent,
      blockingPids: row.blockingPids ?? [],
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return {
      status: 'unavailable',
      targetPid,
      phase,
      reason: signal.aborted
        ? 'cancelled'
        : error instanceof DbCallDeadlineError || code === '57014' || code === '55P03'
          ? 'deadline'
          : 'query-error',
    };
  }
}

/**
 * Thrown when a bounded admin-pool txn can't finish in time: a statement exceeds
 * `statement_timeout` (PG `57014`) or a lock wait exceeds `lock_timeout` (PG `55P03`).
 * Callers map this to a structured busy result instead of leaking a raw postgres
 * error. The originating PG error is preserved on `.cause` / `.pgCode`.
 *
 * EI-19404770733829453: a bare "canceling statement due to lock timeout" names no
 * cause, so every caller who hits it either retries blindly or goes hand-querying
 * `pg_stat_activity`. When `blockerHint` is available (best-effort — see
 * `describeContentionAtFailure` below), it is retained as a separately labeled
 * snapshot. That diagnostic uses a fresh connection and does not establish which
 * backend, if any, blocked the timed-out operation.
 */
export class OrgTxnTimeoutError extends Error {
  readonly pgCode: string;
  /** Caller-safe summary that excludes the fresh-connection global blocker snapshot. */
  readonly messageWithoutBlockerHint: string;
  /** Best-effort fresh-connection snapshot; it does not prove this operation waited on that backend. */
  readonly blockerHint?: string;
  /** One instantaneous, target-PID sample captured for scheduler candidate-tier diagnostics. */
  candidateWaitSnapshot?: CandidateWaitSnapshot;
  /**
   * EI-21831306274538775 — did PostgreSQL actually raise this SQLSTATE (`'pg'`), or did a
   * caller SYNTHESIZE the same typed error to report exhausting its own wall-clock budget
   * (`'caller-budget'`)?
   *
   * Callers deliberately synthesize a 57014 so an expired budget cannot be mistaken for
   * "nothing matched" — correct, but it left the two causes INDISTINGUISHABLE downstream
   * while the message asserted "the database stalled", which for a synthesized one is
   * simply untrue. Measured cost: `scheduler:get_next`'s claim ladder raises exactly this,
   * and the resulting `pgCode: '57014'` was reported twice as reproduced PostgreSQL
   * contention — sending triage to the connection pool for a budget that ran out inside the
   * scheduler. A retryable-timeout contract for the caller does not require lying about
   * which clock expired.
   *
   * Defaults to `'pg'` so every existing raise site keeps its meaning; only a caller that
   * knows it is synthesizing passes `'caller-budget'`.
   */
  readonly timeoutSource: 'pg' | 'caller-budget';
  constructor(
    pgCode: string,
    cause: unknown,
    blockerHint?: string,
    timeoutSource: 'pg' | 'caller-budget' = 'pg',
    operation: 'read' | 'write' = 'write',
    phase?: string,
  ) {
    const subject = operation === 'read' ? 'operator read query' : 'operator write';
    const baseMessage =
      timeoutSource === 'caller-budget'
        ? `${subject} was abandoned after exceeding the CALLER's own time budget (reported as pg ${pgCode} so it is never mistaken for "nothing matched"; PostgreSQL itself did not time out) — retry shortly`
        : pgCode === '55P03'
          ? `${subject} timed out waiting for a row/advisory lock (pg 55P03 lock_timeout) — retry shortly`
          : `${subject} exceeded its time budget (pg 57014 statement_timeout) — retry shortly`;
    const base = phase ? `[phase: ${phase}] ${baseMessage}` : baseMessage;
    super(
      blockerHint
        ? `${base} — separate-connection blocker snapshot (not confirmed to block this operation): ${blockerHint}`
        : base,
    );
    this.name = 'OrgTxnTimeoutError';
    this.pgCode = pgCode;
    this.messageWithoutBlockerHint = base;
    this.cause = cause;
    this.blockerHint = blockerHint;
    this.timeoutSource = timeoutSource;
  }
}

/** PG SQLSTATEs that mean "couldn't finish in time": statement_timeout + lock_timeout. */
const CONTENTION_CODES = new Set(['57014', '55P03']);

/**
 * Add a stable operation phase to PG timeouts raised by a post-transaction step.
 * `boundedOrgTxn` labels errors while its callback is active; callers use this
 * wrapper for awaited work after that transaction has committed. Keep an inner
 * label when one already exists so the most specific phase survives.
 */
export async function withOrgTxnTimeoutPhase<T>(
  phase: string,
  operation: () => Promise<T>,
  timeoutOperation: 'read' | 'write' = 'write',
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OrgTxnTimeoutError) {
      if (error.messageWithoutBlockerHint.startsWith('[phase: ')) throw error;
      throw new OrgTxnTimeoutError(
        error.pgCode,
        error.cause,
        error.blockerHint,
        error.timeoutSource,
        timeoutOperation,
        phase,
      );
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !CONTENTION_CODES.has(code)) throw error;
    throw new OrgTxnTimeoutError(code, error, undefined, 'pg', timeoutOperation, phase);
  }
}

/** Bound on the diagnostic query itself — this must never be the thing that hangs
 *  while we're trying to explain why something else hung. */
const BLOCKER_DIAGNOSIS_TIMEOUT_MS = 2_000;

/**
 * Best-effort: after a contention timeout, look up who's currently holding up
 * `pg_stat_activity` and summarize the oldest non-blocked "head blocker" — the
 * backend everyone else's `pg_blocking_pids()` chain bottoms out at. This is run
 * on a FRESH connection (the failing txn's own connection already aborted), so it
 * cannot prove it was OUR specific wait's blocker, only what's blocking *something*
 * right now — which on this system is normally the same one or two backends
 * (confirmed live 2026-08-03: 20/25 sampled backends blocked, 12 of them on both of
 * two head pids). The query text is the blocker's current/last statement; a
 * transaction-held lock may have been taken by an earlier statement in that
 * transaction. Never throws — a diagnostic that itself fails must not mask the real
 * OrgTxnTimeoutError; returns undefined on any error or empty result.
 */
async function describeContentionAtFailure(client: OrgSql, pool?: string): Promise<string | undefined> {
  try {
    // This is a best-effort follow-up to a bounded write, but it still acquires a
    // fresh pool connection. Without an acquisition deadline, a saturated or
    // disconnected pool can leave the original checkpoint call pending until its
    // MCP transport gives up with an unknown outcome (EI-21568779068866915).
    const rows = (await withAcquisitionDeadline(
      ({ disarm, expired }) =>
        client.begin(async (tx) => {
          // Promise.race does not cancel a late begin. If acquisition loses the
          // deadline race, do not run the diagnostic query after the caller has
          // already received the typed timeout result.
          if (expired()) {
            throw new DbCallDeadlineError(
              'boundedOrgTxn:blocker-diagnosis',
              BLOCKER_DIAGNOSIS_TIMEOUT_MS,
              BLOCKER_DIAGNOSIS_TIMEOUT_MS,
              pool,
            );
          }
          disarm();
          await tx.unsafe(`SET LOCAL statement_timeout = ${BLOCKER_DIAGNOSIS_TIMEOUT_MS}`);
          return tx.unsafe(
            `SELECT a.pid,
                    EXTRACT(EPOCH FROM (now() - a.xact_start))::int AS age_s,
                    left(regexp_replace(a.query, '\\s+', ' ', 'g'), 160) AS q,
                    cardinality(pg_blocking_pids(a.pid)) = 0 AS unblocked
               FROM pg_stat_activity a
              WHERE a.datname = current_database()
                AND a.state <> 'idle' AND a.pid <> pg_backend_pid()
                AND (a.wait_event_type = 'Lock' OR EXISTS (
                      SELECT 1 FROM pg_stat_activity b
                       WHERE b.datname = current_database()
                         AND b.pid <> a.pid
                         AND a.pid = ANY (pg_blocking_pids(b.pid))
                    ))
              ORDER BY a.xact_start NULLS LAST
              LIMIT 25`,
          );
        }),
      { ms: BLOCKER_DIAGNOSIS_TIMEOUT_MS, label: 'boundedOrgTxn:blocker-diagnosis', pool },
    )) as unknown as Array<{ pid: number; age_s: number | null; q: string | null; unblocked: boolean }>;
    // The head blocker: itself not waiting on anyone (unblocked), oldest xact first.
    const head = rows.find((r) => r.unblocked);
    if (!head) return undefined;
    const age = head.age_s == null ? 'unknown age' : `${head.age_s}s`;
    const q = (head.q ?? '').trim() || '(query text unavailable)';
    const blockedCount = rows.filter((r) => !r.unblocked).length;
    return (
      `observed head blocker pid ${head.pid} (running ${age}; current/last statement — ` +
      `lock may have been taken by an earlier statement in this transaction): ${q}` +
      (blockedCount > 0 ? ` — ${blockedCount} other backend(s) also waiting` : '')
    );
  } catch {
    return undefined;
  }
}

/** Per-statement cap for an interactive coordination write. Generous enough that a
 *  healthy sub-second write NEVER trips it, tight enough that a wedged query dies
 *  well under the route-stack 30s budget (so the agent gets a typed error, not a
 *  408). Override via PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS. */
export const ORG_TXN_DEFAULT_STATEMENT_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS) || 15_000,
);
/** Per-lock-wait cap. Override via PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS. */
export const ORG_TXN_DEFAULT_LOCK_TIMEOUT_MS = Math.max(
  100,
  Number(process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS) || 8_000,
);

export interface BoundedOrgTxnOptions {
  /**
   * Acquisition-phase cap (connect + BEGIN + the SET LOCAL statements), ms.
   * Defaults to the shared DB transaction acquisition deadline. The caller's
   * `fn` is deliberately outside this cap and remains bounded only by the
   * transaction's statement/lock timeouts.
   */
  acquireTimeoutMs?: number;
  /** Additional retries after the first measured acquisition deadline; defaults to two. */
  acquireRetries?: number;
  /** Additional retries for classified BEGIN/setup failures before the caller starts; defaults to two. */
  connectionSetupRetries?: number;
  /** Linear backoff base for pre-callback connection/setup retries; defaults to 150ms. */
  connectionSetupBackoffMs?: number;
  /** Per-statement cap (PG statement_timeout), ms. Default ORG_TXN_DEFAULT_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
  /** Per-lock-wait cap (PG lock_timeout), ms. Default ORG_TXN_DEFAULT_LOCK_TIMEOUT_MS. */
  lockTimeoutMs?: number;
  /** Stable caller phase included in a propagated PG timeout; may change inside fn. */
  phase?: string | (() => string);
  /** Start the transaction READ ONLY before applying its local timeouts. */
  readOnly?: boolean;
  /** Inject the sql client (tests / a non-default backend). Default getOrgPg().sql. */
  client?: OrgSql;
  /** Attribute an injected production client's acquisition to its existing pool registry. */
  acquirePool?: string;
  /** Cancel in-flight postgres-js queries when the caller abandons this transaction. */
  signal?: AbortSignal;
}

/**
 * Run `fn` inside ONE bounded admin-pool transaction. `fn` receives the
 * transaction-scoped sql handle — every query it runs is in the same txn and
 * under the SET LOCAL timeouts. Classified connection/setup failures may retry
 * before `fn` starts; once it starts, errors propagate unchanged so a partial
 * write is never replayed. A contention timeout (PG 57014 / 55P03) is mapped to
 * OrgTxnTimeoutError.
 *
 * The `tx` is typed as OrgSql so store helpers that take a single `Sql` can be
 * constructed against it (e.g. `new PgThreadStore({ ...opts, getSql: () => tx })`).
 */
export async function boundedOrgTxn<T>(fn: (tx: OrgSql) => Promise<T>, opts: BoundedOrgTxnOptions = {}): Promise<T> {
  const sql = opts.client ?? getOrgPg().sql;
  // Workspace dispatch supplies TransactionSql, which has savepoint but no
  // begin. Keep its RLS identity and atomicity instead of acquiring another pool.
  const transaction = sql as unknown as Partial<TransactionSql>;
  const nested = typeof sql.begin !== 'function' && typeof transaction.savepoint === 'function';
  if (nested && opts.readOnly) {
    throw new Error('boundedOrgTxn cannot change transaction read-only mode inside a savepoint');
  }
  const begin = nested
    ? (work: (tx: OrgSql) => Promise<unknown>) => transaction.savepoint!(async rawTx => {
      const tx = rawTx as unknown as OrgSql;
      const [before] = await tx`SELECT current_setting('lock_timeout') AS lock_timeout,
        current_setting('statement_timeout') AS statement_timeout`;
      const value = await work(tx);
      // RELEASE SAVEPOINT preserves SET LOCAL. Restore successful scopes so a
      // search cannot change its dispatcher's remaining statement budget. On
      // failure PostgreSQL restores these settings with ROLLBACK TO SAVEPOINT.
      await tx`SELECT set_config('lock_timeout', ${before.lock_timeout}, true),
        set_config('statement_timeout', ${before.statement_timeout}, true)`;
      return value;
    })
    : (work: (tx: OrgSql) => Promise<unknown>) => sql.begin(tx => work(tx as unknown as OrgSql));
  const stmtMs = Math.max(100, Math.trunc(opts.statementTimeoutMs ?? ORG_TXN_DEFAULT_STATEMENT_TIMEOUT_MS));
  const lockMs = Math.max(100, Math.trunc(opts.lockTimeoutMs ?? ORG_TXN_DEFAULT_LOCK_TIMEOUT_MS));
  // Injected clients are test/non-pool backends, so they must not be counted
  // against the process's org-admin acquisition registry. Production calls use
  // getOrgPg() and therefore share the same measured queue-pressure signal as
  // the other admin-pool callers.
  const acquirePool = opts.acquirePool ?? (opts.client ? undefined : 'org-admin');
  const acquireMs = opts.acquireTimeoutMs ?? DEFAULT_TX_ACQUIRE_DEADLINE_MS;
  let result: unknown;
  try {
    // P-022 / D-020: bound the phase before the caller's handler starts. A
    // postgres-js pool can queue forever before BEGIN when its client pool is
    // saturated, so statement_timeout/lock_timeout alone cannot protect this
    // path. The expired() guard is required because Promise.race cannot cancel
    // a late sql.begin; it rolls that late transaction back without invoking fn.
    result = await retryOnRetryableDbDeadline(() => {
      // This deadline covers BEGIN and transaction setup. Keep the measured
      // stage in the existing error label; a setup stall must not look like a
      // physical connection acquisition. Each retry owns its label so a late
      // callback from an expired attempt cannot relabel the next attempt.
      let acquireLabel = 'boundedOrgTxn:begin(admin)';
      return withAcquisitionDeadline(
        ({ disarm, expired }) =>
          retryBeforeCallbackStarts(
            (markStarted) =>
              begin(async (rawTx) => {
                const assertWithinAcquisitionDeadline = () => {
                  if (expired()) {
                    throw new DbCallDeadlineError(acquireLabel, acquireMs, acquireMs, acquirePool);
                  }
                };
                // Promise.race does not cancel a late sql.begin callback. Check at
                // entry so a BEGIN that resolves after the caller timed out rolls
                // back without issuing transaction setup SQL.
                assertWithinAcquisitionDeadline();
                const cancellation = cancellableTransaction(rawTx as unknown as OrgSql, opts.signal);
                try {
                  cancellation.assertNotAborted();
                  // SET TRANSACTION must precede the first query in this transaction.
                  // Bounded search reads use this option to preserve the read-only
                  // contract while still receiving the same per-statement bounds.
                  if (opts.readOnly) {
                    acquireLabel = 'boundedOrgTxn:setup-read-only(admin)';
                    await cancellation.tx`SET TRANSACTION READ ONLY`;
                    assertWithinAcquisitionDeadline();
                  }
                  // set_config(name, value, is_local=true) == SET LOCAL, but binds the value
                  // as a parameter (a bare `SET` cannot). Mirrors locks/inWorkspaceTxn.
                  // WI-10003631: one round trip for both transaction-local settings.
                  acquireLabel = 'boundedOrgTxn:setup-timeouts(admin)';
                  await cancellation.tx`SELECT set_config('lock_timeout', ${`${lockMs}ms`}, true),
                                               set_config('statement_timeout', ${`${stmtMs}ms`}, true)`;
                  assertWithinAcquisitionDeadline();
                  // The caller's work may legitimately run longer than acquisition;
                  // stop the phase clock immediately before entering it. Mark the
                  // retry boundary at the same point: any later error may follow a
                  // partial write and must never replay fn.
                  disarm();
                  const work = Promise.resolve().then(() => {
                    cancellation.assertNotAborted();
                    markStarted();
                    return fn(cancellation.tx);
                  });
                  // If cancellation wins the race, the transaction callback returns early while
                  // the late `fn` promise is still observed and its rejection is suppressed.
                  work.catch(() => undefined);
                  return await Promise.race(cancellation.abort ? [work, cancellation.abort] : [work]);
                } finally {
                  cancellation.cleanup();
                }
              }),
            {
              retries: opts.connectionSetupRetries,
              backoffMs: opts.connectionSetupBackoffMs,
              pool: acquirePool,
            },
          ),
        // The guard reads this getter when the deadline fires, after the
        // callback may have progressed from BEGIN to a setup statement.
        { ms: acquireMs, get label() { return acquireLabel; }, pool: acquirePool, signal: opts.signal },
      );
    }, { retries: opts.acquireRetries });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (typeof code === 'string' && CONTENTION_CODES.has(code)) {
      // Best-effort attribution (EI-19404770733829453) — the failing txn's own
      // connection already aborted, so this runs on a fresh one and must never be
      // allowed to throw or hang in place of the real error.
      const blockerHint = await describeContentionAtFailure(sql, acquirePool).catch(() => undefined);
      const phase = typeof opts.phase === 'function' ? opts.phase() : opts.phase;
      throw new OrgTxnTimeoutError(code, err, blockerHint, 'pg', opts.readOnly ? 'read' : 'write', phase);
    }
    throw err;
  }
  return result as T;
}

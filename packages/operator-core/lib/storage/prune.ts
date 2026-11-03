/**
 * Safe prune-by-category-and-age executor (storage-settings-page-2026-06-15
 * P-003, D-003). Default keep-all: nothing here ever auto-fires — only an
 * explicit user (or agent) trim runs it.
 *
 * Invariants:
 *   • Federated categories are REFUSED (fail-safe — trimming changes what peers
 *     see; D-002/D-003). Only `sync:'none'` PG + local disk stores trim.
 *   • PG deletes are CHUNKED (ctid batches) so a multi-million-row trim never
 *     takes a long lock; a bloat-queue table (substrate_outbox) then gets a
 *     VACUUM FULL to actually return disk, coordinated via the `db-schema`
 *     exclusive resource lock with drain (the plan's lock requirement).
 *   • Disk session-dir trims reuse the audited session-dir-gc planner with a
 *     FAIL-CLOSED protected set (a live/resumable session is never collected),
 *     floored at the category's minOlderThanDays. Plain stores exclude entries
 *     written in the last minute.
 *
 * Server-only.
 */
import { rmSync } from 'node:fs';
import {
  getStorageCategory,
  isTrimmable,
  type PgStorageCategory,
  type DiskStorageCategory,
} from './categories';
import { dirSizeBytes, gatherProtectedSessionIdentity, listDiskEntries } from './disk';
import {
  defaultSessionDirRoots,
  discoverSessionDirCandidates,
  findUnarchivedSessionDirs,
  planSessionDirGc,
} from '../session-dir-gc';
import { readRegistryAsync } from '../workspace-registry';
import { RETENTION_MS, runScratchGc } from '../scratch-gc';

export interface PruneRequest {
  categoryId: string;
  /** delete rows/entries strictly older than this many days; null = ALL. */
  olderThanDays: number | null;
  /** preview only — count + estimate, no deletion. */
  dryRun: boolean;
  /** workspace for the VACUUM resource-lock coordination domain. */
  workspaceId: string;
  signal?: AbortSignal;
  /** Test-only seam for the foreground scratch-scan budget; omitted in production calls. */
  scanBudgetMs?: number;
  /**
   * Wall-time budget (ms) for the chunked PG delete loop (EI-11379). When the
   * budget is hit mid-drain, the loop stops and returns a continuation instead
   * of running past the caller's transport envelope (the ~55s MCP cap) — which
   * used to commit part of the delete and then time out with NO usable result.
   * Default {@link DEFAULT_TIME_BUDGET_MS}. `0` = stop after the first chunk
   * (one bounded step per call — used to force small continuation steps).
   */
  timeBudgetMs?: number;
}

export interface PruneResult {
  ok: boolean;
  categoryId: string;
  dryRun: boolean;
  /** rows deleted (pg) or paths removed (disk). */
  removed: number;
  /** reclaimed bytes — measured for bloat (VACUUM FULL) / disk; estimated for
   *  ordinary PG (logical delete returns space for reuse, not to the OS). */
  reclaimedBytes: number;
  reclaimEstimated: boolean;
  vacuumed: boolean;
  reason?: string;
  note?: string;
  /** PG: a per-call row/time ceiling was hit and eligible rows still remain;
   *  replay to continue (see {@link continuation}). */
  partial?: boolean;
  /** PG execute: rows still matching the trim after this call (0 when complete). */
  totalRemaining?: number;
  /** PG execute: true iff no eligible rows remain — the trim is finished. */
  complete?: boolean;
  /**
   * PG execute: replay these EXACT args to continue a partial trim (EI-11379).
   * Safe + idempotent — each call deletes only still-eligible rows (the age
   * WHERE clause) and reports only what IT removed, so re-running never
   * double-counts. Present only while `complete` is false.
   */
  continuation?: { categoryId: string; olderThanDays: number | null };
}

/** chunked-delete batch size + per-call ceiling (rerun to continue past it). */
const CHUNK = 10_000;
const MAX_ROWS_PER_CALL = 20_000_000;
/**
 * Default wall-time budget (ms) for the chunked delete loop. Keep this well
 * below the observed ~34s MCP request window, leaving headroom to measure
 * `totalRemaining` and serialize the continuation before the caller's
 * envelope elapses (EI-11379, EI-23178687033301213).
 */
const DEFAULT_TIME_BUDGET_MS = 20_000;
/** plain-disk-store guard: never remove an entry touched within this window. */
const PLAIN_DISK_FLOOR_MS = 60_000;

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}
function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

type Sql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

function validDays(d: number | null): boolean {
  return d === null || (Number.isInteger(d) && d >= 0);
}

/** The WHERE clause for a PG trim (trusted identifiers + integer days). */
function pgWhere(cat: PgStorageCategory, olderThanDays: number | null): string {
  const conds: string[] = [];
  if (cat.drainedGuard) conds.push('drained_at IS NOT NULL');
  if (olderThanDays != null && cat.ageColumn && cat.ageColumnType) {
    const col = ident(cat.ageColumn);
    conds.push(
      cat.ageColumnType === 'timestamptz'
        ? `${col} < now() - make_interval(days => ${olderThanDays})`
        : `${col} < (extract(epoch from now()) * 1000)::bigint - ${olderThanDays}::bigint * 86400000`,
    );
  }
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

async function relationStats(sql: Sql, schema: string, table: string): Promise<{ bytes: number; rows: number }> {
  const rows = await sql`
    SELECT pg_total_relation_size(c.oid)::bigint AS b,
           GREATEST(c.reltuples, 0)::bigint      AS r
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind = 'r' LIMIT 1`;
  return { bytes: num(rows[0]?.b), rows: num(rows[0]?.r) };
}

/**
 * Keep the preview read below the MCP transport envelope. A dry-run is read-only,
 * but its exact COUNT(*) can still scan a multi-million-row telemetry table; an
 * unbounded scan leaves the caller with an opaque upstream reset instead of a
 * result it can act on.
 */
const DRY_RUN_STATEMENT_TIMEOUT_MS = 15_000;

function isStatementTimeout(error: unknown): boolean {
  const value = error as { code?: unknown; pgCode?: unknown; message?: unknown } | null;
  const code = value?.code ?? value?.pgCode;
  return code === '57014' || /statement timeout|canceling statement/i.test(String(value?.message ?? error));
}

async function boundedRead<T>(sql: Sql, timeoutMs: number, run: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
    return run(tx);
  });
}

async function prunePg(sql: Sql, cat: PgStorageCategory, req: PruneRequest): Promise<PruneResult> {
  const result: PruneResult = {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: true,
    vacuumed: false,
  };
  const t = `${ident(cat.schema)}.${ident(cat.table)}`;
  const where = pgWhere(cat, req.olderThanDays);

  if (req.dryRun) {
    try {
      const preview = await boundedRead(sql, DRY_RUN_STATEMENT_TIMEOUT_MS, async (tx) => {
        const { bytes: sizeBefore, rows: rowsBefore } = await relationStats(tx, cat.schema, cat.table);
        const rows = await tx.unsafe(`SELECT count(*)::bigint AS n FROM ${t} ${where}`);
        return { sizeBefore, rowsBefore, matched: num(rows[0]?.n) };
      });
      const perRow = preview.rowsBefore > 0 ? preview.sizeBefore / preview.rowsBefore : 0;
      result.removed = preview.matched;
      result.reclaimedBytes = Math.round(perRow * preview.matched);
      result.reclaimEstimated = true;
      return result;
    } catch (error) {
      if (isStatementTimeout(error)) {
        return {
          ...result,
          ok: false,
          reason: 'dry_run_timed_out',
          note: `dry-run count exceeded the ${DRY_RUN_STATEMENT_TIMEOUT_MS / 1000}s read budget; no rows were deleted — use storage:usage for a bounded estimate or retry with a narrower age window`,
        };
      }
      throw error;
    }
  }

  const { bytes: sizeBefore, rows: rowsBefore } = await relationStats(sql, cat.schema, cat.table);
  const perRow = rowsBefore > 0 ? sizeBefore / rowsBefore : 0;

  // Execute — chunked deletes so no single statement takes a long lock, under a
  // wall-time budget (EI-11379): a multi-million-row trim must return a
  // continuation BEFORE the caller's transport envelope (the ~55s MCP cap)
  // rather than committing part of the delete and then timing out with no
  // usable result. Each chunk is its own committed DELETE keyed on the age
  // WHERE clause, so a replay is idempotent — it deletes only rows STILL
  // eligible and reports only what THIS call removed.
  const budgetMs = req.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startMs = Date.now();
  let removed = 0;
  let stoppedEarly = false;
  for (;;) {
    if (req.signal?.aborted) {
      stoppedEarly = true;
      break;
    }
    const rows = await sql.unsafe(`
      WITH del AS (
        DELETE FROM ${t}
         WHERE ctid IN (SELECT ctid FROM ${t} ${where} LIMIT ${CHUNK})
        RETURNING 1
      ) SELECT count(*)::int AS n FROM del`);
    const n = num(rows[0]?.n);
    removed += n;
    if (n < CHUNK) break; // drained the eligible set
    if (removed >= MAX_ROWS_PER_CALL) {
      stoppedEarly = true;
      break;
    }
    if (Date.now() - startMs >= budgetMs) {
      stoppedEarly = true;
      break;
    }
  }
  result.removed = removed;

  // Continuation contract: on an early stop, measure what still matches so the
  // caller knows whether to replay; a clean drain is complete with nothing left.
  if (stoppedEarly) {
    const remRows = await sql.unsafe(`SELECT count(*)::bigint AS n FROM ${t} ${where}`);
    const remaining = num(remRows[0]?.n);
    result.totalRemaining = remaining;
    result.complete = remaining === 0;
    result.partial = !result.complete;
    if (!result.complete) {
      result.continuation = { categoryId: cat.id, olderThanDays: req.olderThanDays };
      result.note = `partial: ${removed} row(s) deleted this call, ${remaining} still match — re-run with the same { category, olderThanDays } to continue`;
    }
  } else {
    result.totalRemaining = 0;
    result.complete = true;
  }

  // Bloat-queue: logical delete does not return disk → VACUUM FULL under the
  // db-schema exclusive lock with drain (the plan's coordination requirement).
  // Skipped while the trim is still partial — VACUUM FULL is a long, locking op
  // that would itself blow the budget; it runs on the final draining call.
  if (cat.bloats && removed > 0 && result.complete) {
    try {
      const { guardResource } = await import('../agent-tools/locks/resource-lock-guard');
      const outcome = await guardResource(
        {
          coordinationDomain: req.workspaceId,
          ownerId: 'storage-prune',
          ownerLabel: 'storage:prune',
          coordIdentity: {
            ownerId: 'storage-prune',
            ownerLabel: 'storage:prune',
            source: 'static-client',
            workspaceId: req.workspaceId,
            userId: null,
          },
          resource: 'db-schema',
          mode: 'exclusive',
          maxDrainSec: 30,
          reason: `VACUUM FULL ${cat.table} (storage trim)`,
        },
        async () => {
          // VACUUM cannot run in a txn block; postgres-js sends a bare query (no
          // implicit BEGIN), so this is safe outside .begin().
          await sql.unsafe(`VACUUM (FULL, ANALYZE) ${t}`);
          return true;
        },
      );
      result.vacuumed = outcome.acquired === true;
      if (!result.vacuumed) {
        result.note = `rows deleted; VACUUM FULL skipped (db-schema ${outcome.acquired === false ? outcome.reason : 'busy'}) — space is freed for reuse, but relation/OS bytes are not guaranteed to shrink without a table rewrite or truncation`;
      }
    } catch (err) {
      result.note = `rows deleted; VACUUM FULL failed: ${(err as Error)?.message ?? 'error'}`;
    }
  }

  if (result.vacuumed) {
    const { bytes: sizeAfter } = await relationStats(sql, cat.schema, cat.table);
    result.reclaimedBytes = Math.max(0, sizeBefore - sizeAfter);
    result.reclaimEstimated = false;
  } else {
    // Logical delete: space is freed for reuse within the relation. Ordinary
    // DELETE/autovacuum does not guarantee relation-file shrink or OS-visible
    // free bytes, so report the proportional estimate, not measured OS shrink.
    result.reclaimedBytes = Math.round(perRow * removed);
    result.reclaimEstimated = true;
    result.note =
      result.note ?? `${removed} rows deleted; space freed for reuse (relation/OS bytes are not guaranteed to shrink without a table rewrite or truncation)`;
  }
  return result;
}

async function pruneDiskSessions(
  sql: Sql,
  cat: DiskStorageCategory,
  req: PruneRequest,
): Promise<PruneResult> {
  const result: PruneResult = {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: false,
    vacuumed: false,
  };
  const gather = await gatherProtectedSessionIdentity(sql);
  if (!gather.ok) {
    return { ...result, ok: false, reason: 'protected_set_unavailable' };
  }
  const days = Math.max(req.olderThanDays ?? 0, cat.minOlderThanDays ?? 0);
  const candidates = discoverSessionDirCandidates(defaultSessionDirRoots());
  const provisional = planSessionDirGc({
    candidates,
    protectedIdentity: gather.identity,
    nowMs: Date.now(),
    retentionMs: days * 86400000,
  });
  const unarchivedPaths = await findUnarchivedSessionDirs(provisional.remove);
  const plan = planSessionDirGc({
    candidates,
    protectedIdentity: gather.identity,
    nowMs: Date.now(),
    retentionMs: days * 86400000,
    unarchivedPaths,
  });
  for (const c of plan.remove) {
    const size = dirSizeBytes(c.path);
    if (!req.dryRun) {
      try {
        rmSync(c.path, { recursive: true, force: true });
      } catch {
        continue; // best-effort per dir
      }
    }
    result.removed += 1;
    result.reclaimedBytes += size;
  }
  if (days > (req.olderThanDays ?? 0)) {
    result.note = `floored to ${days}d (live/resumable sessions are always protected)`;
  }
  return result;
}

function pruneDiskPlain(cat: DiskStorageCategory, req: PruneRequest): PruneResult {
  const result: PruneResult = {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: false,
    vacuumed: false,
  };
  const now = Date.now();
  // Two floors, and the STRICTER of them always wins:
  //   • PLAIN_DISK_FLOOR_MS — never remove an entry touched in the last minute
  //     (likely in-flight). This used to apply ONLY when olderThanDays was null,
  //     which inverted the safety: an explicit `olderThanDays: 0` was less
  //     protected than the delete-everything path and could unlink a spill written
  //     milliseconds earlier, for a live recipient that had not yet read it.
  //   • cat.minOlderThanDays — the category's declared retention floor. The module
  //     contract says disk trims are floored at it, but only pruneDiskGc read it;
  //     a floor declared on a plain store was silently decorative until now.
  const requestedMs = req.olderThanDays == null ? 0 : req.olderThanDays * 86400000;
  const floorMs = Math.max(requestedMs, (cat.minOlderThanDays ?? 0) * 86400000, PLAIN_DISK_FLOOR_MS);
  const cutoff = now - floorMs;
  for (const e of listDiskEntries(cat)) {
    if (e.mtimeMs >= cutoff) continue;
    if (!req.dryRun) {
      try {
        rmSync(e.path, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
    result.removed += 1;
    result.reclaimedBytes += e.sizeBytes;
  }
  // Say so when the floor overrode what the caller asked for: a trim that quietly
  // kept entries the caller expected gone is indistinguishable from one that found
  // nothing to remove.
  if (floorMs > requestedMs) {
    const floorDays = floorMs / 86400000;
    result.note =
      floorDays >= 1
        ? `floored to ${floorDays}d by the category retention floor`
        : `floored to the ${PLAIN_DISK_FLOOR_MS / 1000}s in-flight guard`;
  }
  return result;
}

/** Keep a foreground scratch preview well below the MCP transport deadline. */
const SCRATCH_PRUNE_SCAN_BUDGET_MS = 20_000;

/** Scratch entries are workspace trees, not independent disposable top-level directories. */
async function pruneScratch(cat: DiskStorageCategory, req: PruneRequest): Promise<PruneResult> {
  const scanBudgetMs = req.scanBudgetMs ?? SCRATCH_PRUNE_SCAN_BUDGET_MS;
  const requestedMs = req.olderThanDays == null ? 0 : req.olderThanDays * 86400000;
  const categoryFloorMs = (cat.minOlderThanDays ?? 0) * 86400000;
  const retentionMs = Math.max(RETENTION_MS, categoryFloorMs, requestedMs);
  const workspaceRegistry = (await readRegistryAsync()).workspaces.map((workspace) => workspace.id);
  const gc = await runScratchGc({
    workspaceRegistry,
    dryRun: req.dryRun,
    retentionMs,
    quietMs: retentionMs,
    enforceQuota: false,
    maxDurationMs: scanBudgetMs,
  });
  const removed = gc.retentionEvictions + gc.deadWorkspaces;
  const notes: string[] = [];
  if (retentionMs > requestedMs) {
    notes.push(`scratch run retention floored to ${Math.ceil(retentionMs / 86400000)}d by scratch GC`);
  }
  if (gc.unprovenEntries > 0) notes.push(`kept ${gc.unprovenEntries} unproven top-level scratch entr${gc.unprovenEntries === 1 ? 'y' : 'ies'}`);
  if (gc.deadWorkspacesDeferred.length > 0) {
    notes.push(`kept ${gc.deadWorkspacesDeferred.length} marked workspace root(s) without complete quiet/open-writer proof`);
  }
  if (gc.truncated) {
    notes.push(`scratch scan budget of ${scanBudgetMs}ms exhausted; this result is partial — re-run with the same arguments to continue`);
  }
  return {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed,
    reclaimedBytes: gc.retentionEvictedBytes + gc.deadWorkspaceBytes,
    reclaimEstimated: Boolean(gc.truncated && req.dryRun),
    vacuumed: false,
    ...(gc.truncated
      ? {
          partial: true,
          complete: false,
          continuation: { categoryId: cat.id, olderThanDays: req.olderThanDays },
        }
      : {}),
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

/**
 * Prune one category by age (or all). Refuses federated categories and invalid
 * day values; never auto-fires (only an explicit call runs it).
 */
export async function pruneStorageCategory(req: PruneRequest): Promise<PruneResult> {
  const base = (reason: string): PruneResult => ({
    ok: false,
    categoryId: req.categoryId,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: true,
    vacuumed: false,
    reason,
  });

  const cat = getStorageCategory(req.categoryId);
  if (!cat) return base('unknown_category');
  if (!isTrimmable(cat)) return base('federated_not_trimmable');
  if (!validDays(req.olderThanDays)) return base('invalid_older_than_days');

  try {
    if (cat.kind === 'disk' && cat.store === 'scratch') return await pruneScratch(cat, req);
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql as unknown as Sql;
    if (cat.kind === 'pg') return await prunePg(sql, cat, req);
    if (cat.store === 'session-dirs') return await pruneDiskSessions(sql, cat, req);
    return pruneDiskPlain(cat, req);
  } catch (err) {
    return base(`prune_failed: ${(err as Error)?.message ?? 'error'}`);
  }
}

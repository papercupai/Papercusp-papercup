/**
 * BM25 index maintenance (plan bm25-lexical-search-evoke-adoption-2026-10-10, P-006).
 *
 * Runs from the `bm25Maintenance` DBOS scheduled workflow in `dbos/periodic-workflows.ts`.
 * There is no timer here. Each run does four bounded things, in this order:
 *
 *  1. ENSURE. `harness_shared.bm25_ensure_indexes()` (migration 1447) creates the
 *     extension and reports every missing index as `deferred:build-concurrently`: the run
 *     passes a row threshold below any table's estimate, so ensure never builds inline.
 *     Inline builds all run inside ensure's ONE function call, so every table's ShareLock
 *     lasts until the LAST build commits: on 2026-10-11 that blocked harness_plans INSERTs
 *     for ~170 s while documents_bm25 (678 MB) built (EI-25667725192013388). Only the
 *     migration's own call builds inline, at boot, before the host serves writes.
 *  2. BUILD. At most ONE deferred or invalid index per run is built with
 *     CREATE INDEX CONCURRENTLY (`bm25_index_ddl(name, true)`). One per run keeps a host
 *     from running two concurrent builds and spreads several large tables across ticks.
 *     An INVALID index (a CONCURRENTLY build that died) is dropped first, because the DDL
 *     is `IF NOT EXISTS` and would otherwise skip it forever. CONCURRENTLY cannot run in a
 *     transaction block or a pipeline, so it runs on a reserved connection, never in
 *     `sql.begin`. Before it, step 2a drops the INVALID `_ccnew` / `_ccold` copies a dead
 *     REINDEX CONCURRENTLY left behind (`dropOrphanedRebuilds`).
 *  3. COMPACT. Indexes are created with `compaction = 'manual'`, so pg_textsearch never
 *     compacts on its own. For each live bm25 index, `bm25_needs_compaction(idx)` decides,
 *     and `bm25_compact_step(idx)` runs one pass per statement (each its own transaction),
 *     at most `maxCompactionSteps` passes per index per run. pg_textsearch's managed
 *     background compaction is not used: it would be a second scheduler (plan P-006).
 *  4. RECLAIM (plan decision D-010). Compaction merges segments but never shrinks the
 *     index FILE: the merged segment is written to new pages and the old segments' pages
 *     are recycled, not returned. Measured on pg_textsearch 1.5.1: a churned index sat at
 *     11.36 MB against a 2.55 MB REINDEX, 4.5x. So an index that no longer needs
 *     compaction, is at least `reclaimMinBytes` on disk, and whose file exceeds
 *     `maxBloatRatio` times its live data (segment pages x alive/docs, from
 *     `bm25_summarize_index`) is rebuilt with REINDEX INDEX CONCURRENTLY. At most ONE per
 *     run, never in a run that already built one, under a session advisory lock so two
 *     overlapping ticks cannot both rebuild.
 *  5. RETIRE (plan decisions D-011, D-012). `harness_shared.bm25_retire_legacy_columns()`
 *     (migration 1452) swaps each legacy stored tsvector column whose corpus now has a
 *     valid BM25 index for a same-named VIRTUAL generated column, which drops its GIN
 *     index. It skips a busy table after a 1 s lock_timeout and reports one row per corpus;
 *     only rows that did something or failed are kept. Before migration 1452 is armed the
 *     function does not exist and the step reports nothing.
 *
 * It runs whether or not the BM25_LEXICAL_RANKING flag is on. The flag picks the ranker
 * per query; the indexes still take every write, and keeping them compacted means
 * flipping the flag back on does not land on a degraded index.
 *
 * Errors never escape: a failing step is recorded in `errors` and the next tick retries.
 * A throw out of a DBOS step would exhaust maxRecoveryAttempts and stop the schedule.
 */
import type { Sql } from 'postgres';
import { createDedicatedOrgPg } from '@papercusp/db-org';
import { BACKUP_MIGRATION_ADVISORY_LOCK_KEY } from '@papercusp/backup/application-names';
import { readBm25Indexes, resetBm25Availability } from './rank';

/** Outcomes of `bm25_ensure_indexes()` that mean "build this one concurrently". */
const BUILD_OUTCOMES = new Set(['deferred:build-concurrently', 'invalid']);

/**
 * Session lock_timeout for the CONCURRENTLY builds, rebuilds and drops in steps 2 and 4.
 * CREATE / REINDEX / DROP INDEX CONCURRENTLY wait for every transaction that holds a
 * conflicting lock on the table or an older snapshot, and those waits are lock waits, so
 * they obey lock_timeout. The live pool role sets lock_timeout = 15s (measured on the dev
 * box, 2026-10-11, `harness_admin` rolconfig). On a fleet database some transaction on a
 * hot table is nearly always older than that, so every build of work_items_bm25 was
 * cancelled with "canceling statement due to lock timeout" and left an INVALID index that
 * the next run dropped and retried, forever.
 *
 * A host pg_dump is a distinct case: it holds the shared backup rendezvous while its
 * snapshot keeps AccessShareLock on every relation it has visited. Starting concurrent
 * DDL while that lock is held creates a PostgreSQL lock queue; ordinary writes then queue
 * behind the waiting DDL even though the DDL itself is "concurrent". The DDL paths below
 * therefore try-acquire the same rendezvous and skip before issuing any DDL when a host
 * dump is active. This four-hour bound remains for other, non-backup old snapshots after
 * the admission check has succeeded.
 */
export const CONCURRENT_DDL_LOCK_TIMEOUT = '4h';

/**
 * The indexes step 2 should build, in the order to try them: never-attempted builds
 * (`deferred:build-concurrently`) before indexes whose earlier build died (`invalid`).
 * Step 2 builds one per run, so with a fixed order one index that keeps failing would
 * starve every index behind it; on the dev box session_turns_bm25 and
 * coord_thread_posts_bm25 were never attempted while work_items_bm25 failed each run.
 * The sort is stable, so ties keep ensure's order.
 */
export function orderBuildCandidates(rows: readonly Bm25EnsureRow[]): Bm25EnsureRow[] {
  const rank = (outcome: string) => (outcome === 'invalid' ? 1 : 0);
  return rows
    .filter(r => r.corpusIndex && BUILD_OUTCOMES.has(r.outcome))
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row.outcome) - rank(b.row.outcome) || a.i - b.i)
    .map(x => x.row);
}

export interface Bm25EnsureRow {
  corpusIndex: string | null;
  outcome: string;
}

export interface Bm25MaintenanceReport {
  /** Every row `bm25_ensure_indexes()` returned, verbatim. */
  ensure: Bm25EnsureRow[];
  /** Engine-level skip (`skipped:library-not-preloaded` etc.); null when the engine is usable. */
  engineSkipped: string | null;
  /** The index built concurrently this run, if any. */
  built: string | null;
  /** True when `built` replaced an INVALID index. */
  rebuiltInvalid: boolean;
  /** INVALID `_ccnew` / `_ccold` leftovers of a dead REINDEX CONCURRENTLY dropped this run (step 2a). */
  droppedOrphans: string[];
  /** Deferred or invalid indexes left for later runs. */
  pendingBuilds: string[];
  /** Compaction passes run per index (only indexes that needed compaction appear). */
  compacted: Array<{ index: string; steps: number; stillNeeds: boolean }>;
  /** The index rebuilt this run because its file outgrew its live data (step 4). */
  reclaimed: Bm25Reclaim | null;
  /** Bloated indexes left for later runs (one rebuild per run). */
  pendingReclaims: string[];
  /**
   * Rows from `bm25_retire_legacy_columns()` (step 5) that retired a column or could not:
   * outcome `retired` or `skipped:lock-timeout` / `skipped:error`. Gate skips and
   * `already-retired` rows are left out.
   */
  retired: Bm25RetireRow[];
  errors: string[];
}

export interface Bm25RetireRow {
  table: string;
  column: string;
  outcome: string;
  detail: string | null;
  /** The GIN index bytes freed at commit (null when nothing was dropped). */
  freedIndexBytes: number | null;
  /** pg_stats avg_width x reltuples: a floor, reclaimed only as rows are rewritten. */
  estColumnBytes: number | null;
}

/** Retire outcomes that are reported; the rest are the availability gate or a no-op. */
const REPORTED_RETIRE_OUTCOMES = new Set(['retired', 'skipped:lock-timeout', 'skipped:error']);

export interface Bm25Reclaim {
  index: string;
  beforeBytes: number;
  afterBytes: number;
  /** On-disk bytes over estimated live bytes, measured before the rebuild. */
  ratio: number;
}

export interface Bm25MaintenanceOptions {
  /** Row estimate above which ensure defers a build (passed to bm25_ensure_indexes). */
  largeTableRows?: number;
  /** Compaction passes per index per run. */
  maxCompactionSteps?: number;
  /** Rebuild an index whose file exceeds this multiple of its estimated live bytes. */
  maxBloatRatio?: number;
  /** Never rebuild an index smaller than this on disk. */
  reclaimMinBytes?: number;
}

export const BM25_MAINTENANCE_DEFAULT_STEPS = 4;
/**
 * Row threshold that makes `bm25_ensure_indexes` defer every build to CONCURRENTLY: it
 * defers when `reltuples > threshold`, and reltuples is -1 for a table never analyzed.
 */
export const ENSURE_DEFER_EVERY_BUILD = -2;
/** Under R-7's 1.5x bar, so a rebuilt index lands near 1.0x of a fresh build. */
export const BM25_MAX_BLOAT_RATIO = 1.4;
/** D013 covers every index; the ratio and one-rebuild budget bound churn. */
export const BM25_RECLAIM_MIN_BYTES = 8192;
const PAGE_BYTES = 8192;
// pg_textsearch 1.5.x segment.c/write_page_index_internal: 24-byte PG
// page header, 16-byte TpPageIndexSpecial, and 4-byte BlockNumber entries.
const BM25_PAGE_MAP_ENTRIES = (PAGE_BYTES - 24 - 16) / 4;
/**
 * Session advisory lock held around every CONCURRENTLY build (step 2) and rebuild (step 4),
 * so two overlapping maintenance runs on any host of one database never run DDL on the same
 * index at once. Without it, a run that read an in-progress build as `invalid` could wait
 * that build out and then drop the index it had just made valid.
 */
const RECLAIM_LOCK = 'bm25-maintenance:concurrent-ddl';

/**
 * Admit BM25 concurrent DDL only when the host backup/migration rendezvous is free.
 *
 * The host pg_dump holds this session advisory lock for each database dump. A failed
 * try-lock is an intentional deferral: waiting here would let the subsequent DDL enter
 * PostgreSQL's lock queue behind the dump and turn unrelated writes into convoy waiters.
 */
export async function tryAcquireBackupRendezvous(conn: Sql): Promise<boolean> {
  const [row] = await conn<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY})) AS locked`;
  return row?.locked === true;
}

async function releaseBackupRendezvous(conn: Sql): Promise<void> {
  await conn`
    SELECT pg_advisory_unlock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
}

/** Segment totals from the `Total:` line of `bm25_summarize_index` (pg_textsearch 1.5.x). */
export interface Bm25SegmentTotals {
  segments: number;
  pages: number;
  docs: number;
  alive: number;
}

/**
 * Parses `Total: 6 segments, 740 pages (5.8MB), 72780 terms, 31372 docs (alive=26143, dead=5229)`.
 * The alive/dead part is absent when no segment holds a dead doc. An explicitly empty
 * segment section with zero persisted docs has zero totals, even if the memtable has
 * documents. Null for incomplete, contradictory or unrecognised output.
 */
export function parseBm25SegmentTotals(summary: string): Bm25SegmentTotals | null {
  const m = /Total:\s*(\d+)\s+segments?,\s*(\d+)\s+pages?\b[^\n]*?\b(\d+)\s+docs\b(?:\s*\(alive=(\d+),\s*dead=\d+\))?/.exec(summary);
  if (!m) {
    // pg_textsearch 1.5.x omits Total entirely when no segments have been flushed.
    // Require both explicit witnesses: a missing Total alone is still unreadable.
    const persisted = /^[ \t]*docs_persisted:[ \t]*(\d+)[ \t]*\r?$/m.exec(summary);
    const emptySegments = /^Segments:\r?\n[ \t]*\(none\)[ \t]*\r?\n(?:[ \t]*\r?\n)*Index Size:/m.test(summary);
    return persisted?.[1] === '0' && emptySegments
      ? { segments: 0, pages: 0, docs: 0, alive: 0 }
      : null;
  }
  const docs = Number(m[3]);
  return { segments: Number(m[1]), pages: Number(m[2]), docs, alive: m[4] === undefined ? docs : Number(m[4]) };
}

/**
 * Estimated fresh-build bytes: whole live data pages plus required metapage
 * and page-map storage. Segment Total pages exclude those metadata blocks;
 * omitting them labels a fresh one-page segment as 3x bloated.
 */
export function estimateBm25LiveBytes(t: Bm25SegmentTotals): number {
  if (t.docs <= 0) return 0;
  const livePages = Math.ceil(t.pages * (t.alive / t.docs));
  const pageMapPages = Math.ceil(livePages / BM25_PAGE_MAP_ENTRIES);
  return (livePages + pageMapPages + 1) * PAGE_BYTES;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Production tick: session locks and SET/RESET must bypass transaction pooling. */
export async function runOrgBm25Maintenance(): Promise<Bm25MaintenanceReport> {
  const { sql } = createDedicatedOrgPg('bm25-maintenance', { max: 1, sessionAffinity: true });
  try {
    return await runBm25Maintenance(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * One maintenance run against `sql`, which must be a pool or a reservable handle,
 * never a transaction or a transaction-pooling proxy (step 2 needs session
 * affinity and CREATE INDEX CONCURRENTLY). Production uses runOrgBm25Maintenance.
 */
export async function runBm25Maintenance(
  sql: Sql,
  opts: Bm25MaintenanceOptions = {},
): Promise<Bm25MaintenanceReport> {
  const maxSteps = Math.max(0, opts.maxCompactionSteps ?? BM25_MAINTENANCE_DEFAULT_STEPS);
  const report: Bm25MaintenanceReport = {
    ensure: [],
    engineSkipped: null,
    built: null,
    rebuiltInvalid: false,
    droppedOrphans: [],
    pendingBuilds: [],
    compacted: [],
    reclaimed: null,
    pendingReclaims: [],
    retired: [],
    errors: [],
  };

  // 1. ENSURE (never builds inline from here; see the header)
  try {
    const threshold = opts.largeTableRows ?? ENSURE_DEFER_EVERY_BUILD;
    const rows = await sql<{ corpus_index: string | null; outcome: string }[]>`
      SELECT corpus_index, outcome FROM harness_shared.bm25_ensure_indexes(${threshold}::bigint)`;
    report.ensure = rows.map(r => ({ corpusIndex: r.corpus_index, outcome: r.outcome }));
  } catch (err) {
    report.errors.push(`ensure: ${message(err)}`);
    return report;
  }
  const engineRow = report.ensure.find(r => r.corpusIndex === null);
  if (engineRow) {
    report.engineSkipped = engineRow.outcome;
    return report;
  }
  if (report.ensure.some(r => r.outcome === 'created')) resetBm25Availability();

  // 2a. ORPHANS (leftovers of a REINDEX CONCURRENTLY that died)
  await dropOrphanedRebuilds(sql, report);

  // 2. BUILD (at most one per run)
  const toBuild = orderBuildCandidates(report.ensure);
  const next = toBuild[0];
  report.pendingBuilds = toBuild.slice(1).map(r => r.corpusIndex as string);
  if (next?.corpusIndex) {
    const name = next.corpusIndex;
    const conn = await sql.reserve();
    let locked = false;
    let backupLocked = false;
    try {
      [{ locked }] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${RECLAIM_LOCK})) AS locked`;
      // Another run holds the DDL lock: it may be building this very index, which reads as
      // `invalid` until it finishes. Leave it to that run.
      if (!locked) {
        report.pendingBuilds.unshift(name);
      } else if (!(backupLocked = await tryAcquireBackupRendezvous(conn))) {
        // A host pg_dump owns AccessShareLock on every relation in its snapshot.
        // Do not start concurrent DDL and enter the lock queue behind it.
        report.pendingBuilds.unshift(name);
      } else {
        const [state] = await conn<{ valid: boolean }[]>`
          SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'harness_shared' AND c.relname = ${name}`;
        if (!state?.valid) {
          // Session-scoped: a big build must not hit the pool's statement_timeout, and its
          // waits for older transactions must not hit the pool's lock_timeout.
          await conn`SET statement_timeout = 0`;
          await conn.unsafe(`SET lock_timeout = '${CONCURRENT_DDL_LOCK_TIMEOUT}'`);
          // Re-read under the lock: an index that was invalid when ensure ran may have been
          // finished by a run that has since released the lock.
          if (state) {
            await conn`DROP INDEX CONCURRENTLY IF EXISTS ${conn(`harness_shared.${name}`)}`;
            report.rebuiltInvalid = true;
          }
          const [{ ddl }] = await conn<{ ddl: string }[]>`SELECT harness_shared.bm25_index_ddl(${name}, true) AS ddl`;
          await conn.unsafe(ddl);
          report.built = name;
          resetBm25Availability();
        }
      }
    } catch (err) {
      report.errors.push(`build ${name}: ${message(err)}`);
      report.pendingBuilds.unshift(name);
    } finally {
      try {
        await conn`RESET statement_timeout`;
        await conn`RESET lock_timeout`;
        if (backupLocked) await releaseBackupRendezvous(conn);
        if (locked) await conn`SELECT pg_advisory_unlock(hashtext(${RECLAIM_LOCK}))`;
      } catch { /* connection may be broken; release anyway */ }
      conn.release();
    }
  }

  // 3. COMPACT
  let live: ReadonlySet<string>;
  try {
    live = await readBm25Indexes(sql);
  } catch (err) {
    report.errors.push(`list indexes: ${message(err)}`);
    return report;
  }
  // readBm25Indexes returns bare relnames from harness_shared; qualify them so the
  // ::regclass casts do not depend on search_path.
  for (const name of [...live].sort()) {
    const qualified = `harness_shared.${name}`;
    try {
      let steps = 0;
      let needs = await needsCompaction(sql, qualified);
      while (needs && steps < maxSteps) {
        await sql`SELECT public.bm25_compact_step(${qualified}::regclass)`;
        steps += 1;
        needs = await needsCompaction(sql, qualified);
      }
      if (steps > 0 || needs) report.compacted.push({ index: qualified, steps, stillNeeds: needs });
    } catch (err) {
      report.errors.push(`compact ${qualified}: ${message(err)}`);
    }
  }

  // 4. RECLAIM (at most one per run, and only in a run that built nothing)
  await reclaim(sql, live, opts, report);

  // 5. RETIRE
  await retireLegacyColumns(sql, report);
  return report;
}

/**
 * Relnames REINDEX CONCURRENTLY gives its transient copies: `<index>_ccnew` for the new
 * build and `<index>_ccold` for the old one after the swap, with a digit suffix when the
 * name is taken.
 */
const REBUILD_LEFTOVER_PATTERN = '_cc(new|old)[0-9]*$';

/**
 * Step 2a. A REINDEX CONCURRENTLY that dies (a lock_timeout, a cancel, a restart) leaves its
 * transient copy behind as an INVALID index. It is still `indisready`, so it takes every
 * write to its table and holds its file, but nothing reads it, and nothing drops it unless
 * step 4 happens to rebuild the same index again. On the dev box (2026-10-11 08:55Z)
 * carry_notes_bm25_ccnew sat invalid beside a valid carry_notes_bm25 that step 4 had no
 * reason to rebuild.
 *
 * Every invalid bm25 index in the schema whose name matches the pattern is dropped, under
 * the DDL advisory lock: every maintenance rebuild holds that lock, so while this run holds
 * it no maintenance rebuild has a live `_ccnew`. When another run holds it, the sweep
 * waits for the next tick. A rebuild started by hand outside maintenance would make this
 * DROP wait for its table lock and then report an error; that is acceptable.
 */
async function dropOrphanedRebuilds(sql: Sql, report: Bm25MaintenanceReport): Promise<void> {
  let orphans: string[];
  try {
    orphans = (await sql<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am a ON a.oid = c.relam
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.amname = 'bm25' AND n.nspname = 'harness_shared'
         AND NOT i.indisvalid AND c.relname ~ ${REBUILD_LEFTOVER_PATTERN}
       ORDER BY 1`).map(r => r.name);
  } catch (err) {
    report.errors.push(`orphans: ${message(err)}`);
    return;
  }
  if (orphans.length === 0) return;
  const conn = await sql.reserve();
  let locked = false;
  let backupLocked = false;
  try {
    [{ locked }] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${RECLAIM_LOCK})) AS locked`;
    if (!locked) return;
    backupLocked = await tryAcquireBackupRendezvous(conn);
    if (!backupLocked) return;
    await conn`SET statement_timeout = 0`;
    await conn.unsafe(`SET lock_timeout = '${CONCURRENT_DDL_LOCK_TIMEOUT}'`);
    for (const name of orphans) {
      const qualified = `harness_shared.${name}`;
      try {
        await conn`DROP INDEX CONCURRENTLY IF EXISTS ${conn(qualified)}`;
        report.droppedOrphans.push(qualified);
      } catch (err) {
        report.errors.push(`drop orphan ${qualified}: ${message(err)}`);
      }
    }
  } catch (err) {
    report.errors.push(`orphans: ${message(err)}`);
  } finally {
    try {
      await conn`RESET statement_timeout`;
      await conn`RESET lock_timeout`;
      if (backupLocked) await releaseBackupRendezvous(conn);
      if (locked) await conn`SELECT pg_advisory_unlock(hashtext(${RECLAIM_LOCK}))`;
    } catch { /* connection may be broken; release anyway */ }
    conn.release();
  }
}

async function retireLegacyColumns(sql: Sql, report: Bm25MaintenanceReport): Promise<void> {
  try {
    const [{ defined }] = await sql<{ defined: boolean }[]>`
      SELECT to_regprocedure('harness_shared.bm25_retire_legacy_columns(boolean)') IS NOT NULL AS defined`;
    if (!defined) return;
    const rows = await sql<{
      table_name: string | null; column_name: string | null; outcome: string; detail: string | null;
      freed_index_bytes: string | null; est_column_bytes: string | null;
    }[]>`SELECT * FROM harness_shared.bm25_retire_legacy_columns()`;
    report.retired = rows
      .filter(r => r.table_name !== null && REPORTED_RETIRE_OUTCOMES.has(r.outcome))
      .map(r => ({
        table: r.table_name as string,
        column: r.column_name as string,
        outcome: r.outcome,
        detail: r.detail,
        freedIndexBytes: r.freed_index_bytes === null ? null : Number(r.freed_index_bytes),
        estColumnBytes: r.est_column_bytes === null ? null : Number(r.est_column_bytes),
      }));
  } catch (err) {
    report.errors.push(`retire: ${message(err)}`);
  }
}

async function reclaim(
  sql: Sql,
  live: ReadonlySet<string>,
  opts: Bm25MaintenanceOptions,
  report: Bm25MaintenanceReport,
): Promise<void> {
  // Compaction debt and physical bloat are independent. A busy index can
  // exhaust every run's step budget; excluding it here hides the reclaim
  // backlog forever. The concurrent rebuild replaces its segments safely
  // after this run's compaction statements, under the existing DDL lock.
  const candidates = [...live].sort();
  const bloated = await findBloated(sql, candidates, opts, report.errors);
  if (bloated.length === 0) return;
  if (report.built) {
    report.pendingReclaims = bloated.map(b => `harness_shared.${b.name}`);
    return;
  }
  report.pendingReclaims = bloated.slice(1).map(b => `harness_shared.${b.name}`);
  const target = bloated[0]!;
  const qualified = `harness_shared.${target.name}`;
  const conn = await sql.reserve();
  let locked = false;
  let backupLocked = false;
  try {
    [{ locked }] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${RECLAIM_LOCK})) AS locked`;
    if (!locked) {
      report.pendingReclaims.unshift(qualified);
    } else if (!(backupLocked = await tryAcquireBackupRendezvous(conn))) {
      // Keep the target queued without issuing REINDEX while the host dump owns
      // the snapshot rendezvous; otherwise PostgreSQL queues ordinary writes
      // behind this waiting concurrent DDL.
      report.pendingReclaims.unshift(qualified);
    } else {
      await conn`SET statement_timeout = 0`;
      await conn.unsafe(`SET lock_timeout = '${CONCURRENT_DDL_LOCK_TIMEOUT}'`);
      // A REINDEX CONCURRENTLY that died leaves an INVALID <name>_ccnew. Only maintenance
      // rebuilds these indexes and it holds the lock, so one that exists now is a leftover.
      await conn`DROP INDEX CONCURRENTLY IF EXISTS ${conn(`harness_shared.${target.name}_ccnew`)}`;
      await conn`REINDEX INDEX CONCURRENTLY ${conn(qualified)}`;
      const [{ bytes }] = await conn<{ bytes: string }[]>`SELECT pg_relation_size(${qualified}::regclass) AS bytes`;
      report.reclaimed = { index: qualified, beforeBytes: target.bytes, afterBytes: Number(bytes), ratio: target.ratio };
      resetBm25Availability();
    }
  } catch (err) {
    report.errors.push(`reclaim ${qualified}: ${message(err)}`);
    report.pendingReclaims.unshift(qualified);
  } finally {
    try {
      await conn`RESET statement_timeout`;
      await conn`RESET lock_timeout`;
      if (backupLocked) await releaseBackupRendezvous(conn);
      if (locked) await conn`SELECT pg_advisory_unlock(hashtext(${RECLAIM_LOCK}))`;
    } catch { /* connection may be broken; release anyway */ }
    conn.release();
  }
}

interface BloatedIndex {
  name: string;
  bytes: number;
  ratio: number;
}

/** Indexes over the reclaim floor whose file exceeds maxBloatRatio x live bytes, most wasted first. */
async function findBloated(
  sql: Sql,
  names: string[],
  opts: Bm25MaintenanceOptions,
  errors: string[],
): Promise<BloatedIndex[]> {
  if (names.length === 0) return [];
  const maxRatio = opts.maxBloatRatio ?? BM25_MAX_BLOAT_RATIO;
  const minBytes = opts.reclaimMinBytes ?? BM25_RECLAIM_MIN_BYTES;
  let sizes: Array<{ name: string; bytes: string }>;
  try {
    sizes = await sql<{ name: string; bytes: string }[]>`
      SELECT c.relname AS name, pg_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relname = ANY(${names})`;
  } catch (err) {
    errors.push(`reclaim sizes: ${message(err)}`);
    return [];
  }
  const out: Array<BloatedIndex & { waste: number }> = [];
  for (const { name, bytes: raw } of sizes) {
    const bytes = Number(raw);
    if (bytes < minBytes) continue;
    const qualified = `harness_shared.${name}`;
    try {
      const [{ summary }] = await sql<{ summary: string }[]>`SELECT public.bm25_summarize_index(${qualified}) AS summary`;
      const totals = parseBm25SegmentTotals(summary);
      if (!totals) {
        errors.push(`reclaim ${qualified}: bm25_summarize_index has no parsable Total line`);
        continue;
      }
      const liveBytes = Math.max(estimateBm25LiveBytes(totals), PAGE_BYTES);
      const ratio = bytes / liveBytes;
      if (ratio > maxRatio) out.push({ name, bytes, ratio, waste: bytes - liveBytes });
    } catch (err) {
      errors.push(`reclaim ${qualified}: ${message(err)}`);
    }
  }
  return out.sort((a, b) => b.waste - a.waste).map(({ name, bytes, ratio }) => ({ name, bytes, ratio }));
}

async function needsCompaction(sql: Sql, qualified: string): Promise<boolean> {
  const [row] = await sql<{ needs: boolean }[]>`SELECT public.bm25_needs_compaction(${qualified}::regclass) AS needs`;
  return row?.needs === true;
}

/** One log line per run; quiet when there was nothing to do. */
export function formatBm25MaintenanceReport(
  r: Bm25MaintenanceReport,
  interval?: { startedAtMs: number; finishedAtMs: number; durationMs: number },
): string | null {
  const parts: string[] = [];
  if (r.engineSkipped) parts.push(`engine ${r.engineSkipped}`);
  const created = r.ensure.filter(e => e.outcome === 'created').map(e => e.corpusIndex);
  if (created.length) parts.push(`created ${created.join(',')}`);
  if (r.droppedOrphans.length) parts.push(`dropped orphan ${r.droppedOrphans.join(',')}`);
  if (r.built) parts.push(`built${r.rebuiltInvalid ? ' (replaced invalid)' : ''} ${r.built}`);
  if (r.pendingBuilds.length) parts.push(`pending ${r.pendingBuilds.join(',')}`);
  for (const c of r.compacted) parts.push(`compacted ${c.index} x${c.steps}${c.stillNeeds ? ' (more needed)' : ''}`);
  if (r.reclaimed) {
    const mb = (b: number) => (b / 1048576).toFixed(1);
    parts.push(`reclaimed ${r.reclaimed.index} ${mb(r.reclaimed.beforeBytes)}MB->${mb(r.reclaimed.afterBytes)}MB (was ${r.reclaimed.ratio.toFixed(2)}x live)`);
  }
  if (r.pendingReclaims.length) parts.push(`reclaim pending ${r.pendingReclaims.join(',')}`);
  for (const t of r.retired) {
    const freed = t.freedIndexBytes === null ? '' : ` freed ${(t.freedIndexBytes / 1048576).toFixed(1)}MB index`;
    parts.push(`retire ${t.table}.${t.column} ${t.outcome}${freed}${t.outcome === 'retired' ? '' : ` (${t.detail ?? ''})`}`);
  }
  if (r.errors.length) parts.push(`errors: ${r.errors.join(' | ')}`);
  if (!parts.length) return null;
  const line = `[bm25-maintenance] ${parts.join('; ')}`;
  if (!interval) return line;
  return `${line}; startedAt=${new Date(interval.startedAtMs).toISOString()} finishedAt=${new Date(interval.finishedAtMs).toISOString()} durationMs=${interval.durationMs}`;
}

/**
 * Live storage usage introspection (storage-settings-page-2026-06-15 P-003,
 * D-003). Reuses the audit's introspection: PG table sizes from the catalog
 * (instant) + a bounded age-distribution count, and `du` of the on-disk stores.
 *
 * Shape per category: total size + a cumulative "older than N days" distribution
 * the page turns into per-option projected reclaim. The bucket counts run under a
 * short statement_timeout so a huge table (route_invocations is ~26M rows) can
 * never wedge a settings read — on timeout the row still returns its size with an
 * empty distribution + a note, and the UI falls back to "trim all" / a server
 * dry-run. Server-only.
 */
import {
  STORAGE_CATEGORIES,
  isTrimmable,
  type AgeColumnType,
  type StorageCategory,
  type StorageFederation,
} from './categories';
import { listDiskEntriesAsync, type DiskWalkBudget } from './disk';

/** The fixed "trim older than" thresholds (days) the page offers + projects. */
export const TRIM_THRESHOLD_DAYS = [30, 90, 365] as const;

/** Statement-timeout cap for each bounded storage query (ms). */
const QUERY_TIMEOUT_CAP_MS = 4000;

/**
 * Aggregate wall-clock budget for the direct `storage:usage` read path. The
 * composed `code:run` foreground budget is 50s; leave room for dispatch and
 * shaping while still allowing several slow-but-useful catalog reads.
 */
export const STORAGE_READ_BUDGET_MS = 30_000;

/**
 * The budget used when this runs OFF the read path — from the
 * `system:precompute-derived-reads` routine, where nobody is waiting on the
 * result (precompute-derived-sync-reads-2026-07-19 P-003).
 *
 * Deliberately NOT unbounded. The plan item said to delete the budget outright
 * now that the walk is off the read path, but EI-6045's budget guards the EVENT
 * LOOP, not just read latency — a recursive walk that blocks for minutes is just
 * as harmful inside a routine as inside a resolver, it merely stalls the operator
 * instead of one panel. Raising it (rather than removing it) buys complete,
 * accurate sizes on a large store while keeping the stall bounded.
 */
const STORAGE_PRECOMPUTE_BUDGET_MS = 120_000;

class StorageReadDeadlineExceeded extends Error {
  constructor(phase: string) {
    super(`storage usage read deadline exhausted before ${phase}`);
    this.name = 'StorageReadDeadlineExceeded';
  }
}

function queryTimeoutMs(budget: DiskWalkBudget, phase: string): number {
  const remaining = budget.deadlineMs - Date.now();
  if (remaining <= 0) {
    budget.truncated = true;
    throw new StorageReadDeadlineExceeded(phase);
  }
  return Math.max(1, Math.min(QUERY_TIMEOUT_CAP_MS, remaining));
}

/** Run one storage query under the remaining aggregate read deadline. */
async function runBoundedStorageQuery<T>(
  sql: Sql,
  budget: DiskWalkBudget,
  phase: string,
  run: (tx: Sql) => Promise<T>,
): Promise<T> {
  const timeoutMs = queryTimeoutMs(budget, phase);
  return sql.begin(async (tx) => {
    // statement_timeout bounds server execution. The deadline check above
    // bounds how much of the aggregate budget this phase may consume.
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return run(tx);
  });
}

function storageReadNote(err: unknown, fallback: string): string {
  return err instanceof StorageReadDeadlineExceeded ? err.message : fallback;
}

/** A cumulative slice: rows/entries strictly older than `olderThanDays`. A null
 *  threshold is the TOTAL (everything — the "trim all" target). */
export interface StorageAgeBucket {
  olderThanDays: number | null;
  rows: number;
  bytes: number;
}

export interface StorageUsageRow {
  id: string;
  label: string;
  kind: 'pg' | 'disk';
  federation: StorageFederation;
  /** false → read-only (federated); the page disables trim + warns. */
  trimmable: boolean;
  /** logical delete needs a VACUUM FULL to return disk (substrate_outbox). */
  bloats: boolean;
  /** null when the size could not be measured completely; zero is a real size. */
  totalBytes: number | null;
  /** pg row estimate / disk top-level entry count. null when unknown. */
  totalRows: number | null;
  /** cumulative older-than distribution (incl. a null=total bucket). Empty for
   *  federated categories or when the measurement is incomplete. */
  ageBuckets: StorageAgeBucket[];
  ageColumnType?: AgeColumnType;
  minOlderThanDays?: number;
  description: string;
  note?: string;
}

/** Sum only complete category sizes; an unknown row makes the aggregate unknown. */
export function sumStorageUsageTotalBytes(
  rows: readonly Pick<StorageUsageRow, 'totalBytes'>[],
): number | null {
  let total = 0;
  for (const row of rows) {
    if (row.totalBytes === null) return null;
    total += row.totalBytes;
  }
  return total;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

type Sql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Catalog size — instant (no row scan). Returns 0 bytes for a missing table. */
async function catalogSize(
  sql: Sql,
  schema: string,
  table: string,
  budget: DiskWalkBudget,
): Promise<{ totalBytes: number; rowsEstimate: number }> {
  const rows = await runBoundedStorageQuery(
    sql,
    budget,
    `catalog sizing for ${table}`,
    (tx) => tx`
      SELECT pg_total_relation_size(c.oid)::bigint AS total_bytes,
             GREATEST(c.reltuples, 0)::bigint       AS rows_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind = 'r'
       LIMIT 1`,
  );
  const r = rows[0];
  return { totalBytes: num(r?.total_bytes), rowsEstimate: num(r?.rows_estimate) };
}

/** The age-distribution SQL for one table (trusted identifiers from the taxonomy). */
function bucketSql(
  schema: string,
  table: string,
  ageColumn: string,
  ageColumnType: AgeColumnType,
  drainedGuard: boolean,
): string {
  const t = `${ident(schema)}.${ident(table)}`;
  const col = ident(ageColumn);
  const cond = (days: number): string =>
    ageColumnType === 'timestamptz'
      ? `${col} < now() - make_interval(days => ${days})`
      : `${col} < (extract(epoch from now()) * 1000)::bigint - ${days}::bigint * 86400000`;
  const where = drainedGuard ? 'WHERE drained_at IS NOT NULL' : '';
  const filters = TRIM_THRESHOLD_DAYS.map((d) => `count(*) FILTER (WHERE ${cond(d)})::bigint AS d${d}`).join(
    ',\n         ',
  );
  return `
    SELECT count(*)::bigint AS total,
           ${filters}
      FROM ${t}
      ${where}`;
}

async function computePgUsage(
  sql: Sql,
  cat: StorageCategory & { kind: 'pg' },
  opts: { sizesOnly?: boolean; budget: DiskWalkBudget; base?: StorageUsageRow },
): Promise<StorageUsageRow> {
  const base: StorageUsageRow = opts.base
    ? { ...opts.base }
    : {
        id: cat.id,
        label: cat.label,
        kind: 'pg',
        federation: cat.federation,
        trimmable: isTrimmable(cat),
        bloats: Boolean(cat.bloats),
        totalBytes: null,
        totalRows: null,
        ageBuckets: [],
        ageColumnType: cat.ageColumnType,
        description: cat.description,
      };
  if (!opts.base) {
    try {
      const { totalBytes, rowsEstimate } = await catalogSize(sql, cat.schema, cat.table, opts.budget);
      base.totalBytes = totalBytes;
      base.totalRows = rowsEstimate;
    } catch (err) {
      base.note = storageReadNote(err, `size unavailable: ${(err as Error)?.message ?? 'error'}`);
      return base;
    }
  }

  // sizesOnly (storage-growth-alarm P-017): the catalog size is all the caller
  // needs — skip the bounded age-distribution scan entirely (no per-table SQL).
  if (opts.sizesOnly || base.totalBytes === null) return base;

  // Federated / no age column → read-only, no distribution.
  if (!base.trimmable || !cat.ageColumn || !cat.ageColumnType) return base;

  try {
    const q = bucketSql(cat.schema, cat.table, cat.ageColumn, cat.ageColumnType, Boolean(cat.drainedGuard));
    const rows = await runBoundedStorageQuery(sql, opts.budget, `age distribution for ${cat.table}`, (tx) =>
      tx.unsafe(q),
    );
    const r = rows[0] ?? {};
    const total = num(r.total);
    const perRow = total > 0 ? base.totalBytes / total : 0;
    const buckets: StorageAgeBucket[] = TRIM_THRESHOLD_DAYS.map((d) => {
      const olderRows = num(r[`d${d}`]);
      return { olderThanDays: d, rows: olderRows, bytes: Math.round(perRow * olderRows) };
    });
    // The total bucket: for a drained-guarded queue the "all" target is the drained
    // subset (`total`), not the whole table — so its bytes are the proportional
    // estimate, not the full relation size.
    const totalBytes = cat.drainedGuard ? Math.round(perRow * total) : base.totalBytes;
    buckets.push({ olderThanDays: null, rows: total, bytes: totalBytes });
    base.ageBuckets = buckets;
  } catch (err) {
    base.note = storageReadNote(
      err,
      `age distribution unavailable (table too large to scan in ${QUERY_TIMEOUT_CAP_MS}ms)`,
    );
    void err;
  }
  return base;
}

async function computeDiskUsage(
  cat: StorageCategory & { kind: 'disk' },
  budget?: DiskWalkBudget,
): Promise<StorageUsageRow> {
  const entries = await listDiskEntriesAsync(cat, budget);
  const now = Date.now();
  const totalBytes = entries.reduce((a, e) => a + e.sizeBytes, 0);
  const complete = !budget?.truncated;
  const buckets: StorageAgeBucket[] = complete
    ? TRIM_THRESHOLD_DAYS.map((d) => {
        const cutoff = now - d * 86400000;
        const older = entries.filter((e) => e.mtimeMs < cutoff);
        return {
          olderThanDays: d,
          rows: older.length,
          bytes: older.reduce((a, e) => a + e.sizeBytes, 0),
        };
      })
    : [];
  if (complete) buckets.push({ olderThanDays: null, rows: entries.length, bytes: totalBytes });
  return {
    id: cat.id,
    label: cat.label,
    kind: 'disk',
    federation: cat.federation,
    trimmable: true,
    bloats: false,
    totalBytes: complete ? totalBytes : null,
    totalRows: complete ? entries.length : null,
    ageBuckets: buckets,
    minOlderThanDays: cat.minOlderThanDays,
    description: cat.description,
    // The traversal may have partial entries, but an incomplete total is null.
    note: budget?.truncated ? `disk sizes are partial (sizing budget exceeded on a large store)` : undefined,
  };
}

/** Compute usage for every category. Sequential (gentle on the DB); a failing
 *  category yields an explicit unknown size and note rather than failing the page. */
export async function computeStorageUsage(
  opts: { sizesOnly?: boolean; offReadPath?: boolean; deadlineMs?: number; categoryId?: string } = {},
): Promise<StorageUsageRow[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql as unknown as Sql;
  const out = new Map<string, StorageUsageRow>();
  const selectedCategories = opts.categoryId
    ? STORAGE_CATEGORIES.filter((cat) => cat.id === opts.categoryId)
    : STORAGE_CATEGORIES;
  if (opts.categoryId && selectedCategories.length === 0) {
    throw new Error('Unknown storage category: ' + opts.categoryId);
  }
  // One shared wall-clock budget spans catalog sizing, age distributions, and
  // disk sizing. Previously the per-query PG caps and disk cap were independent,
  // so seven sequential age scans could consume the entire code:run foreground
  // budget before the caller received even a partial result. Over-budget rows
  // remain in the response with an explicit note.
  const budgetMs = opts.offReadPath ? STORAGE_PRECOMPUTE_BUDGET_MS : STORAGE_READ_BUDGET_MS;
  const diskBudget: DiskWalkBudget = { deadlineMs: opts.deadlineMs ?? Date.now() + budgetMs };
  const pgCategories = selectedCategories.filter(
    (cat): cat is Extract<StorageCategory, { kind: 'pg' }> => cat.kind === 'pg',
  );
  const diskCategories = selectedCategories.filter(
    (cat): cat is Extract<StorageCategory, { kind: 'disk' }> => cat.kind === 'disk',
  );

  const measureDiskCategory = async (cat: Extract<StorageCategory, { kind: 'disk' }>): Promise<StorageUsageRow> => {
    if (diskBudget.deadlineMs <= Date.now()) {
      diskBudget.truncated = true;
      return {
        id: cat.id,
        label: cat.label,
        kind: 'disk',
        federation: cat.federation,
        trimmable: true,
        bloats: false,
        totalBytes: null,
        totalRows: null,
        ageBuckets: [],
        minOlderThanDays: cat.minOlderThanDays,
        description: cat.description,
        note: `storage usage read deadline exhausted before disk sizing for ${cat.id}`,
      };
    }
    try {
      return await computeDiskUsage(cat, diskBudget);
    } catch (err) {
      return {
        id: cat.id,
        label: cat.label,
        kind: 'disk',
        federation: cat.federation,
        trimmable: true,
        bloats: false,
        totalBytes: null,
        totalRows: null,
        ageBuckets: [],
        minOlderThanDays: cat.minOlderThanDays,
        description: cat.description,
        note: `disk scan unavailable: ${(err as Error)?.message ?? 'error'}`,
      };
    }
  };

  // Measure cheap PG catalog totals before any disk walk or age-distribution
  // scan can consume the shared deadline. The old sequential order let a large
  // on-disk store exhaust the budget before PG sizing began, making every PG
  // total unknown even when its catalog query was available.
  for (const cat of pgCategories) {
    out.set(cat.id, await computePgUsage(sql, cat, { sizesOnly: true, budget: diskBudget }));
  }

  // Scratch remains the first disk category because it is the most time-sensitive
  // local pressure signal, while the PG totals are now already protected.
  const scratch = diskCategories.find((cat) => cat.id === 'scratch');
  if (scratch) out.set(scratch.id, await measureDiskCategory(scratch));

  for (const cat of diskCategories) {
    if (cat.id === scratch?.id) continue;
    out.set(cat.id, await measureDiskCategory(cat));
  }

  // Age distributions are useful but can scan large tables. Run them only after
  // every category's size has had a chance to use the shared deadline.
  if (!opts.sizesOnly) {
    for (const cat of pgCategories) {
      const measured = out.get(cat.id)!;
      if (measured.totalBytes === null) continue;
      out.set(cat.id, await computePgUsage(sql, cat, { budget: diskBudget, base: measured }));
    }
  }
  return selectedCategories.map((cat) => out.get(cat.id)!);
}

/* ─────────────────────── Disk consumer census (pure half) ───────────────────────
 *
 * disk-headroom-standing-reclaim-2026-10-12 P-001 (R-1). The categories above
 * answer "how big is each store Papercusp REGISTERED"; the census answers the
 * device-level question the 2026-10-12 / incident needed and nothing could
 * answer: what is filling each watched device, and what grew in the last 24h.
 *
 * This half is pure (attribution of one `du` tree + the 24h growth join) so it
 * is unit-tested here; the I/O half — running du, sizing PG and docker through
 * their own APIs, writing/reading the census tables, the schedule — lives in
 * ./disk-consumer-census.ts.
 */

export type CensusConsumerKind = 'dir' | 'files' | 'file' | 'postgres' | 'docker' | 'unattributed';

export interface CensusConsumer {
  /** Absolute path for du-measured rows; a `postgres:` / `docker:` key for API-sized stores. */
  consumer: string;
  kind: CensusConsumerKind;
  /** Path depth below the device mount point (0 = the mount point). API rows use 0. */
  depth: number;
  bytes: number;
}

/** A consumer is listed when it holds at least this many bytes. */
export const CENSUS_FLOOR_BYTES = 1024 ** 3;
/** du is asked for directories down to this depth below the mount point. */
export const CENSUS_MAX_DEPTH = 6;
/** R-1 falsifier: a consumer above this size the census does not list. Unattributed
 *  bytes at or above it mean such a consumer can exist — the read flags a coverage gap. */
export const CENSUS_COVERAGE_GAP_BYTES = 10 * 1024 ** 3;

/**
 * I/O class for the census du: best-effort, lowest level — never the idle class (-c3).
 * / sits on an mq-deadline queue, which honours I/O classes and dispatches an idle
 * request only when no best-effort request is waiting. Measured 2026-10-12 (bpftrace
 * block_rq_insert -> block_rq_issue on nvme0n1, 30 s): the idle-class census du waited
 * 2.58 ms per request in the scheduler against 0.43 ms for all other I/O — 26.4 s of
 * every 30 s queued — and its walk of / was unfinished after 55 min of a 90 min cap.
 */
export const CENSUS_IONICE_ARGS = ['-c2', '-n7'] as const;

/**
 * argv for one read-only census subprocess (du, find, or the resolved expiry
 * worker): best-effort I/O + nice 19 CPU, each only when available. With `bins.sudo` the
 * whole command runs as root through `sudo -n --` (never prompts), so root-owned trees
 * (/var/lib/postgresql, /var/lib/docker, backup repos on /mnt/data) are measured instead
 * of being lost to "Permission denied" — the R-1 falsifier is a consumer above 10 GiB the
 * census does not list, and an unreadable tree hides exactly those. The workers are
 * read-only (metadata only); the precedent is fleet-logs-gc's sudo census.
 */
export function censusCommand(
  program: string,
  programArgs: readonly string[],
  bins: { ionice: string | null; nice: string | null; sudo?: string | null },
): [string, string[]] {
  const niced = bins.nice ? [bins.nice, '-n', '19', program, ...programArgs] : [program, ...programArgs];
  const prioritized = bins.ionice ? [bins.ionice, ...CENSUS_IONICE_ARGS, ...niced] : niced;
  const argv = bins.sudo ? [bins.sudo, '-n', '--', ...prioritized] : prioritized;
  return [argv[0]!, argv.slice(1)];
}

/**
 * find arguments listing `dir`'s immediate regular files as NUL-terminated
 * `<512-byte blocks> <path>` records. `%b` is the ALLOCATED size — du's unit — so
 * attributeOwnFiles' remainder stays exact. There is deliberately no `-size` prefilter:
 * `-size` tests the APPARENT size, and an allocation can exceed it (XFS speculative
 * preallocation, fallocate KEEP_SIZE), which would drop a file at or above the floor.
 *
 * One subprocess per directory replaces a per-entry lstat awaited on the operator's event
 * loop, which ran at ~106 entries/s on bg-host: a 427,868-file directory on /mnt/data took
 * ~67 min that way and 15 s through find (measured 2026-10-12, WI-6554700010009487).
 * Ignore a child disappearing after readdir, while retaining errors for an unavailable
 * starting directory and permission/I/O failures (EI-26770034992506271).
 */
export function censusOwnFilesArgs(dir: string): string[] {
  return [dir, '-maxdepth', '1', '-ignore_readdir_race', '-type', 'f', '-printf', '%b %p\\0'];
}

/** Parse one censusOwnFilesArgs record (`<blocks> <path>`); null when malformed. */
export function parseOwnFilesRecord(record: string): { path: string; bytes: number } | null {
  const sp = record.indexOf(' ');
  if (sp <= 0) return null;
  const blocks = record.slice(0, sp);
  const path = record.slice(sp + 1);
  if (!/^\d+$/.test(blocks) || !path) return null;
  return { path, bytes: Number(blocks) * 512 };
}

/** Depth of `path` below `mountRoot`: 0 for the root itself, null when outside it. */
export function censusDepth(mountRoot: string, path: string): number | null {
  const root = mountRoot.length > 1 ? mountRoot.replace(/\/+$/, '') : mountRoot;
  if (path === root) return 0;
  const prefix = root === '/' ? '/' : `${root}/`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split('/').filter(Boolean).length;
}

function censusParent(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** Directory a census row's own-files residual is keyed under (`/home/x/*`). */
export function censusFilesKey(dir: string): string {
  return dir === '/' ? '/*' : `${dir}/*`;
}

export interface DuTreeSummary {
  /** du's total for the mount point, or null when du never printed it (killed/failed). */
  rootBytes: number | null;
  /** Every directory at or above the floor, down to the max depth. */
  consumers: CensusConsumer[];
  /** Directories (above the max depth) whose OWN files — not subdirectories — reach the floor. */
  ownFiles: Array<{ dir: string; depth: number; bytes: number }>;
  /** Records accepted (inside the mount root). */
  records: number;
}

/**
 * Streams `du -x -0 -B1 --max-depth=N <root>` records into a consumer tree.
 * du prints a directory after all of its children, so when a directory's own
 * record arrives the sum of its child directories is already known and its
 * own-files residual (`size - Σ children`) is exact. Memory stays bounded: a
 * directory's child sum is dropped as soon as the directory itself is printed.
 */
export class DuTreeAccumulator {
  private readonly childSum = new Map<string, number>();
  private readonly consumers: CensusConsumer[] = [];
  private readonly ownFiles: DuTreeSummary['ownFiles'] = [];
  private rootBytes: number | null = null;
  private records = 0;

  constructor(
    private readonly mountRoot: string,
    private readonly opts: { floorBytes: number; maxDepth: number } = {
      floorBytes: CENSUS_FLOOR_BYTES,
      maxDepth: CENSUS_MAX_DEPTH,
    },
  ) {}

  /** One `<bytes>\t<path>` record (du -0 output split on NUL). Malformed records are ignored. */
  addRecord(record: string): void {
    const tab = record.indexOf('\t');
    if (tab <= 0) return;
    const bytes = Number(record.slice(0, tab));
    const path = record.slice(tab + 1).replace(/\n$/, '');
    if (!Number.isFinite(bytes) || bytes < 0 || !path) return;
    this.add(bytes, path);
  }

  add(bytes: number, path: string): void {
    const depth = censusDepth(this.mountRoot, path);
    if (depth === null) return;
    this.records += 1;
    if (depth === 0) this.rootBytes = bytes;
    else {
      const parent = censusParent(path);
      this.childSum.set(parent, (this.childSum.get(parent) ?? 0) + bytes);
    }
    if (bytes >= this.opts.floorBytes) this.consumers.push({ consumer: path, kind: 'dir', depth, bytes });
    if (depth < this.opts.maxDepth) {
      const own = bytes - (this.childSum.get(path) ?? 0);
      this.childSum.delete(path);
      if (own >= this.opts.floorBytes) this.ownFiles.push({ dir: path, depth, bytes: own });
    }
  }

  result(): DuTreeSummary {
    return { rootBytes: this.rootBytes, consumers: [...this.consumers], ownFiles: [...this.ownFiles], records: this.records };
  }
}

/**
 * Split a directory's own-files residual into the large files that make it up
 * (each its own `file` row) and the remainder (one `files` row). `files` are the
 * directory's immediate regular files with ALLOCATED sizes (st_blocks × 512), the
 * same unit du reports, so the remainder is exact.
 */
export function attributeOwnFiles(
  own: { dir: string; depth: number; bytes: number },
  files: ReadonlyArray<{ path: string; bytes: number }>,
  floorBytes: number = CENSUS_FLOOR_BYTES,
): CensusConsumer[] {
  const big = files.filter((f) => f.bytes >= floorBytes).sort((a, b) => b.bytes - a.bytes);
  const out: CensusConsumer[] = big.map((f) => ({ consumer: f.path, kind: 'file', depth: own.depth + 1, bytes: f.bytes }));
  const rest = own.bytes - big.reduce((a, f) => a + f.bytes, 0);
  if (rest >= floorBytes) out.push({ consumer: censusFilesKey(own.dir), kind: 'files', depth: own.depth + 1, bytes: rest });
  return out;
}

export interface CensusGrowthRow extends CensusConsumer {
  /** Size in the baseline run (≈24h earlier); null when the consumer was not listed then. */
  baselineBytes: number | null;
  /** bytes − baselineBytes; null without a baseline row (new, or under the floor 24h ago). */
  growth24hBytes: number | null;
}

/** Join the latest run's consumers with the baseline run's on the consumer key. */
export function joinCensusGrowth(
  latest: readonly CensusConsumer[],
  baseline: readonly CensusConsumer[] | null,
): CensusGrowthRow[] {
  const before = new Map((baseline ?? []).map((c) => [c.consumer, c.bytes]));
  return latest.map((c) => {
    const b = before.get(c.consumer);
    return { ...c, baselineBytes: b ?? null, growth24hBytes: b === undefined ? null : c.bytes - b };
  });
}

/** Largest first, or fastest-growing first (rows without a baseline last, then by size). */
export function sortCensusRows(rows: readonly CensusGrowthRow[], orderBy: 'bytes' | 'growth' = 'bytes'): CensusGrowthRow[] {
  const copy = [...rows];
  if (orderBy === 'growth') {
    return copy.sort((a, b) => {
      if (a.growth24hBytes === null && b.growth24hBytes === null) return b.bytes - a.bytes;
      if (a.growth24hBytes === null) return 1;
      if (b.growth24hBytes === null) return -1;
      return b.growth24hBytes - a.growth24hBytes;
    });
  }
  return copy.sort((a, b) => b.bytes - a.bytes);
}

/** One mount from /proc/self/mountinfo. */
export interface MountInfoEntry {
  /** `major:minor` of the backing device. */
  majorMinor: string;
  /** Path inside the filesystem that is mounted here (`/` for the filesystem root). */
  root: string;
  mountPoint: string;
}

const unescapeMountField = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

export function parseMountInfo(text: string): MountInfoEntry[] {
  const out: MountInfoEntry[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5 || !/^\d+:\d+$/.test(f[2] ?? '')) continue;
    out.push({ majorMinor: f[2]!, root: unescapeMountField(f[3]!), mountPoint: unescapeMountField(f[4]!) });
  }
  return out;
}

/** The mount point that shows a device's WHOLE filesystem (root `/`), so a bind
 *  mount of a subdirectory (e.g. /tmp on the /mnt/data disk) resolves to the
 *  real root and the census walks the entire device. Null when none is visible. */
export function deviceMountRoot(entries: readonly MountInfoEntry[], majorMinor: string): string | null {
  const whole = entries.filter((e) => e.majorMinor === majorMinor && e.root === '/');
  if (whole.length === 0) return null;
  return whole.map((e) => e.mountPoint).sort((a, b) => a.length - b.length)[0]!;
}

/** Linux st_dev → `major:minor` (glibc gnu_dev_major/minor encoding). */
export function devToMajorMinor(dev: number | bigint): string {
  const d = BigInt(dev);
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
  const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}

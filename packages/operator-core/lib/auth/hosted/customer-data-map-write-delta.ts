/**
 * Live write-delta instrument for SPEC-P-001 (cloud-portal-public-release-2026-10-13#P-001).
 *
 * Claim under test: the customer data map ({@link ./customer-data-map}) names every table that
 * one hosted signup journey writes. Falsifier: a `pg_stat_user_tables` write delta captured
 * across one signup journey shows a written table the map does not name.
 *
 * The dev database is shared with the agent fleet, and every process connects as the same role,
 * so the counters cannot be split by writer. Attribution is therefore by time: the signup and
 * cleanup windows are compared against baseline windows of the same length, taken before and
 * after the journey with no signup in flight. Two rules keep that attribution honest:
 *
 *  1. A table written in ANY baseline window is fleet noise and cannot, by itself, falsify the
 *     claim. More baseline windows make this stricter, not looser: noise is absorbed only when
 *     it is actually observed.
 *  2. A table in a hosted customer schema (`papercusp_auth`) is never excused as noise. If the
 *     journey window writes it, the map must name it.
 *  3. Sporadic fleet writers (a scheduled backup, a usage scanner) can fire inside the journey
 *     window and in no baseline. Such a table is excused only by ROW-LEVEL attribution: a
 *     declared {@link FleetWriterProbe} reads the rows written inside the journey window and
 *     must find at least one, all matching that writer. A table with no probe stays falsifying
 *     (fail-closed), and no probe can excuse a customer-schema table.
 *  4. The journey can be repeated. A non-customer table falsifies only if EVERY journey wrote
 *     it: a journey's own writes recur on each repetition, a sporadic fleet writer does not.
 *     (Three live runs flagged three disjoint sets of sporadic fleet tables.)
 *
 * This module is pure: the caller injects the snapshot source, the journey, the clock and the
 * sleep. The live runner wires `pg_stat_user_tables` and the portal hosted test-user kit.
 */
import {
  customerDataTable,
  dataMapNamesTable,
  HOSTED_CUSTOMER_SCHEMAS,
} from './customer-data-map';

export interface WriteCounts {
  readonly ins: number;
  readonly upd: number;
  readonly del: number;
}

/** Qualified table name (`schema.table`) to cumulative write counters. */
export type WriteSnapshot = Readonly<Record<string, WriteCounts>>;

/** Parse `psql -At -F '\t'` output of `SELECT schemaname, relname, n_tup_ins, n_tup_upd, n_tup_del`. */
export function parsePgStatUserTables(tsv: string): WriteSnapshot {
  const out: Record<string, WriteCounts> = {};
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length !== 5) throw new Error(`pg_stat_user_tables row has ${cols.length} columns, expected 5: ${line}`);
    const [schema, rel, ins, upd, del] = cols;
    const counts = { ins: Number(ins), upd: Number(upd), del: Number(del) };
    if (!Number.isFinite(counts.ins) || !Number.isFinite(counts.upd) || !Number.isFinite(counts.del)) {
      throw new Error(`pg_stat_user_tables row has a non-numeric counter: ${line}`);
    }
    out[`${schema}.${rel}`] = counts;
  }
  return out;
}

export const PG_STAT_USER_TABLES_SQL = 'SELECT schemaname, relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables';

/** Tables whose counters moved between two snapshots. A table absent from `before` counts from zero. */
export function writeDelta(before: WriteSnapshot, after: WriteSnapshot): WriteSnapshot {
  const out: Record<string, WriteCounts> = {};
  for (const [table, b] of Object.entries(after)) {
    const a = before[table] ?? { ins: 0, upd: 0, del: 0 };
    const d = { ins: b.ins - a.ins, upd: b.upd - a.upd, del: b.del - a.del };
    if (d.ins || d.upd || d.del) out[table] = d;
  }
  return out;
}

export interface DataMapLookup {
  names(qualified: string): boolean;
  isCustomerTable(qualified: string): boolean;
  customerSchemas: readonly string[];
}

export const LIVE_DATA_MAP: DataMapLookup = {
  names: dataMapNamesTable,
  isCustomerTable: (q) => Boolean(customerDataTable(q)),
  customerSchemas: HOSTED_CUSTOMER_SCHEMAS,
};

/**
 * Row-level proof that a table's writes inside the journey windows came from a known fleet
 * writer rather than the journey. Produced by running a {@link FleetWriterProbe} over the
 * journey windows; never hand-declared.
 */
export interface WriterAttribution {
  readonly table: string;
  readonly writer: string;
  /** Rows the probe saw written inside the journey windows, by any writer. */
  readonly rowsInWindow: number;
  /** Of those, rows the declared writer's predicate does NOT match. */
  readonly rowsNotFromWriter: number;
}

/** An attribution excuses a table only when it saw rows and every one of them matches the writer. */
export function attributionHolds(a: WriterAttribution | undefined): a is WriterAttribution {
  return Boolean(a && a.rowsInWindow > 0 && a.rowsNotFromWriter === 0);
}

export interface ClassifiedWrite extends WriteCounts {
  readonly table: string;
  readonly namedByMap: boolean;
  readonly customerTable: boolean;
  readonly inCustomerSchema: boolean;
  readonly writtenInBaseline: boolean;
  /** The fleet writer that row-level attribution assigned these writes to, if any. */
  readonly attributedToWriter: string | null;
  /** How many of the run's journeys wrote this table (in their signup or cleanup window). */
  readonly journeysWritten: number;
  /**
   * True when this write falsifies the claim: the map does not name it, and it is either in a
   * customer schema (never excusable) or written by EVERY journey while seen in no baseline and
   * not row-attributed to a known fleet writer.
   */
  readonly falsifies: boolean;
}

export interface WriteDeltaVerdict {
  readonly passed: boolean;
  readonly journeyCount: number;
  readonly signup: readonly ClassifiedWrite[];
  readonly cleanup: readonly ClassifiedWrite[];
  readonly baselineWindowCount: number;
  readonly baselineTables: readonly string[];
  /** Tables (deduplicated, sorted) that falsify the claim. Empty means the map held. */
  readonly falsifyingTables: readonly string[];
  /** Unnamed tables excused because a baseline window also wrote them. */
  readonly excusedAsNoise: readonly string[];
  /** Unnamed tables excused by row-level attribution to a fleet writer, with that attribution. */
  readonly attributedToFleetWriter: readonly WriterAttribution[];
  /** Attributions that were offered but did not hold (saw no rows, or saw rows from another writer). */
  readonly rejectedAttributions: readonly WriterAttribution[];
  readonly customerSchemaTablesWritten: readonly string[];
}

function inSchema(table: string, schemas: readonly string[]): boolean {
  return schemas.some((s) => table.startsWith(`${s}.`));
}

function classify(
  window: WriteSnapshot,
  baseline: ReadonlySet<string>,
  map: DataMapLookup,
  attributions: ReadonlyMap<string, WriterAttribution>,
  journeysWritten: ReadonlyMap<string, number>,
  journeyCount: number,
): ClassifiedWrite[] {
  return Object.entries(window)
    .map(([table, d]) => {
      const namedByMap = map.names(table);
      const inCustomerSchema = inSchema(table, map.customerSchemas);
      const writtenInBaseline = baseline.has(table);
      const attribution = attributions.get(table);
      const attributed = !inCustomerSchema && attributionHolds(attribution);
      const written = journeysWritten.get(table) ?? 0;
      return {
        table,
        ...d,
        namedByMap,
        customerTable: map.isCustomerTable(table),
        inCustomerSchema,
        writtenInBaseline,
        attributedToWriter: attributed ? attribution!.writer : null,
        journeysWritten: written,
        falsifies: !namedByMap && (inCustomerSchema || (!writtenInBaseline && !attributed && written === journeyCount)),
      };
    })
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Sum several deltas into one (a table's counters add across windows). */
function sumDeltas(windows: readonly WriteSnapshot[]): WriteSnapshot {
  const out: Record<string, WriteCounts> = {};
  for (const w of windows) {
    for (const [t, d] of Object.entries(w)) {
      const p = out[t] ?? { ins: 0, upd: 0, del: 0 };
      out[t] = { ins: p.ins + d.ins, upd: p.upd + d.upd, del: p.del + d.del };
    }
  }
  return out;
}

export interface JourneyWindows {
  readonly signup: WriteSnapshot;
  readonly cleanup: WriteSnapshot;
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * Judge one journey. `baselineWindows` are deltas over journey-free windows; `signup` and
 * `cleanup` are deltas over the journey's own windows. Refuses to judge with no baseline,
 * because with none every fleet write would be attributed to the journey.
 */
export function evaluateWriteDelta(input: {
  baselineWindows: readonly WriteSnapshot[];
  /** The first journey's windows. */
  signup: WriteSnapshot;
  cleanup: WriteSnapshot;
  /** Further repetitions of the same journey. Signup and cleanup lists report the sum over all journeys. */
  repeatJourneys?: readonly JourneyWindows[];
  map?: DataMapLookup;
  writerAttributions?: readonly WriterAttribution[];
}): WriteDeltaVerdict {
  if (input.baselineWindows.length === 0) throw new Error('evaluateWriteDelta needs at least one baseline window');
  const map = input.map ?? LIVE_DATA_MAP;
  const baseline = new Set(input.baselineWindows.flatMap((w) => Object.keys(w)));
  const attributions = new Map((input.writerAttributions ?? []).map((a) => [a.table, a] as const));
  const journeys: JourneyWindows[] = [{ signup: input.signup, cleanup: input.cleanup }, ...(input.repeatJourneys ?? [])];
  const journeysWritten = new Map<string, number>();
  for (const j of journeys) {
    for (const t of new Set([...Object.keys(j.signup), ...Object.keys(j.cleanup)])) journeysWritten.set(t, (journeysWritten.get(t) ?? 0) + 1);
  }
  const signup = classify(sumDeltas(journeys.map((j) => j.signup)), baseline, map, attributions, journeysWritten, journeys.length);
  const cleanup = classify(sumDeltas(journeys.map((j) => j.cleanup)), baseline, map, attributions, journeysWritten, journeys.length);
  const all = [...signup, ...cleanup];
  const falsifyingTables = sortedUnique(all.filter((r) => r.falsifies).map((r) => r.table));
  const usedAttribution = new Set(all.filter((r) => r.attributedToWriter && !r.namedByMap && !r.writtenInBaseline).map((r) => r.table));
  return {
    passed: falsifyingTables.length === 0,
    journeyCount: journeys.length,
    signup,
    cleanup,
    baselineWindowCount: input.baselineWindows.length,
    baselineTables: sortedUnique(baseline),
    falsifyingTables,
    excusedAsNoise: sortedUnique(all.filter((r) => !r.namedByMap && !r.falsifies && r.writtenInBaseline).map((r) => r.table)),
    attributedToFleetWriter: [...attributions.values()].filter((a) => usedAttribution.has(a.table)).sort((a, b) => a.table.localeCompare(b.table)),
    rejectedAttributions: [...attributions.values()]
      .filter((a) => !attributionHolds(a) || inSchema(a.table, map.customerSchemas))
      .sort((a, b) => a.table.localeCompare(b.table)),
    customerSchemaTablesWritten: sortedUnique(all.filter((r) => r.inCustomerSchema).map((r) => r.table)),
  };
}

/** The journey windows' bounds, as wall-clock times and (for id-keyed probes) id high-water marks. */
export interface ProbeWindow {
  readonly start: string;
  readonly end: string;
  /** Per probe table: greatest id at `start` and at `end`. */
  readonly idHighWater: Readonly<Record<string, { readonly start: number; readonly end: number }>>;
}

/**
 * A declared fleet writer for one non-customer table. `sql` must return ONE row of two integers:
 * rows written inside the window by anyone, and how many of those the writer's predicate does
 * not match. Fail-closed: a table with no probe stays falsifying.
 */
export interface FleetWriterProbe {
  readonly table: string;
  readonly writer: string;
  /** Present when the table has no write timestamp and inserts are found by id range. */
  readonly idColumn?: string;
  sql(w: ProbeWindow): string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function lit(ts: string): string {
  if (!ISO.test(ts)) throw new Error(`probe window bound is not an ISO-8601 UTC timestamp: ${ts}`);
  return `'${ts}'::timestamptz`;
}
function idRange(w: ProbeWindow, table: string): { start: number; end: number } {
  const r = w.idHighWater[table];
  if (!r || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end)) throw new Error(`no id high-water for ${table}`);
  return r;
}

const BACKUP_WRITER = 'scheduled workspace backup (backup_snapshots.trigger_reason = interval)';
const USAGE_SCANNER = 'interactive transcript usage scanner (agent_usage_samples.source = interactive)';

/**
 * Fleet writers observed writing during a live SPEC-P-001 journey window on the shared dev
 * database (2026-10-14, attempt p001-datamap-56a11cb1). Each probe checks the rows themselves.
 */
export const FLEET_WRITER_PROBES: readonly FleetWriterProbe[] = [
  {
    table: 'harness_shared.backup_snapshots',
    writer: BACKUP_WRITER,
    sql: (w) => `SELECT count(*), count(*) FILTER (WHERE trigger_reason IS DISTINCT FROM 'interval')
      FROM harness_shared.backup_snapshots
      WHERE (started_at > ${lit(w.start)} AND started_at <= ${lit(w.end)})
         OR (finished_at > ${lit(w.start)} AND finished_at <= ${lit(w.end)})`,
  },
  {
    table: 'harness_shared.backup_events',
    writer: BACKUP_WRITER,
    sql: (w) => `SELECT count(*), count(*) FILTER (WHERE s.trigger_reason IS DISTINCT FROM 'interval')
      FROM harness_shared.backup_events e LEFT JOIN harness_shared.backup_snapshots s ON s.id = e.snapshot_id
      WHERE e.at > ${lit(w.start)} AND e.at <= ${lit(w.end)}`,
  },
  {
    table: 'harness_shared.agent_usage_samples',
    writer: USAGE_SCANNER,
    idColumn: 'id',
    sql: (w) => {
      const r = idRange(w, 'harness_shared.agent_usage_samples');
      return `SELECT count(*), count(*) FILTER (WHERE source IS DISTINCT FROM 'interactive')
        FROM harness_shared.agent_usage_samples WHERE id > ${r.start} AND id <= ${r.end}`;
    },
  },
  {
    table: 'harness_shared.interactive_usage_files',
    writer: USAGE_SCANNER,
    // Sole source writer: lib/interactive-usage/ingest-claude-transcripts.ts, which tracks byte
    // offsets into local agent transcript files.
    sql: (w) => `SELECT count(*), count(*) FILTER (WHERE NOT (file_path LIKE '/home/%/.papercusp/%' OR file_path LIKE '/home/%/.claude/%'))
      FROM harness_shared.interactive_usage_files
      WHERE updated_at > ${lit(w.start)} AND updated_at <= ${lit(w.end)}`,
  },
];

/** Parse a probe's `psql -At -F '\t'` output: one row, two integers. */
export function parseProbeResult(probe: FleetWriterProbe, tsv: string): WriterAttribution {
  const [inWindow, notFromWriter] = tsv.trim().split('\t').map(Number);
  if (!Number.isSafeInteger(inWindow) || !Number.isSafeInteger(notFromWriter)) {
    throw new Error(`probe for ${probe.table} returned an unparseable row: ${tsv}`);
  }
  return { table: probe.table, writer: probe.writer, rowsInWindow: inWindow, rowsNotFromWriter: notFromWriter };
}

export interface JourneyHandle<Meta> {
  readonly meta: Meta;
  cleanup(): Promise<void>;
}

export interface WriteDeltaRunDeps<Meta> {
  /** Counter snapshot; `label` names the mark it is taken at (journey bounds are `pre<N>` and `cleanupSnapshot`). */
  snapshot(label: string): Promise<WriteSnapshot>;
  startJourney(): Promise<JourneyHandle<Meta>>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /** Length of every window, baseline and journey alike. */
  windowMs: number;
  /** Baseline windows taken before the first journey and again after the last one. */
  baselineWindowsEachSide: number;
  /**
   * How many times to repeat the journey (default 1). A non-customer table falsifies only if
   * EVERY journey writes it, so a sporadic fleet writer that happens to fire in one journey's
   * window cannot pose as a journey write.
   */
  journeys?: number;
  /** Baseline windows between consecutive journeys (default `baselineWindowsEachSide`). */
  baselineWindowsBetween?: number;
  map?: DataMapLookup;
  /**
   * Row-level attribution for the first-pass falsifying candidates outside the customer schema.
   * Called once with those tables and the journey window marks; its results are re-judged.
   */
  attribute?(candidates: readonly string[], window: { startMark: string; endMark: string }): Promise<readonly WriterAttribution[]>;
}

export interface WriteDeltaRun<Meta> {
  /** The first journey's metadata (all journeys: `metas`). */
  readonly meta: Meta;
  readonly metas: readonly Meta[];
  readonly marks: Readonly<Record<string, string>>;
  readonly cleanupError: string | null;
  /** The journey windows' bounding marks (first-pass candidates are probed over this span). */
  readonly journeyWindow: { readonly startMark: string; readonly endMark: string };
  /** Tables that falsified before row-level attribution; empty when the first pass held. */
  readonly firstPassFalsifying: readonly string[];
  readonly verdict: WriteDeltaVerdict;
}

/**
 * Run one journey between baseline windows. The journey's cleanup is unconditional: it runs
 * even when the post-signup snapshot throws, and a cleanup failure is reported, not swallowed.
 */
export async function runWriteDelta<Meta>(deps: WriteDeltaRunDeps<Meta>): Promise<WriteDeltaRun<Meta>> {
  if (!(deps.baselineWindowsEachSide >= 1)) throw new Error('runWriteDelta needs baselineWindowsEachSide >= 1');
  const marks: Record<string, string> = {};
  const mark = (k: string) => {
    marks[k] = deps.now().toISOString();
  };
  const baselineWindows: WriteSnapshot[] = [];

  const baselineRun = async (prefix: string, start: WriteSnapshot, count: number): Promise<WriteSnapshot> => {
    let prev = start;
    for (let i = 0; i < count; i += 1) {
      await deps.sleep(deps.windowMs);
      mark(`${prefix}${i + 1}`);
      const next = await deps.snapshot(`${prefix}${i + 1}`);
      baselineWindows.push(writeDelta(prev, next));
      prev = next;
    }
    return prev;
  };

  mark('pre0');
  const beforeJourney = await baselineRun('pre', await deps.snapshot('pre0'), deps.baselineWindowsEachSide);
  const startMark = `pre${deps.baselineWindowsEachSide}`;

  const journeyCount = deps.journeys ?? 1;
  if (!(journeyCount >= 1)) throw new Error('runWriteDelta needs journeys >= 1');
  const windows: JourneyWindows[] = [];
  const metas: Meta[] = [];
  const cleanupErrors: string[] = [];
  let prev = beforeJourney;
  let endMark = 'cleanupSnapshot';
  for (let j = 1; j <= journeyCount; j += 1) {
    const sfx = j === 1 ? '' : String(j);
    mark(`journeyStart${sfx}`);
    const journey = await deps.startJourney();
    metas.push(journey.meta);
    mark(`journeyStarted${sfx}`);
    let afterSignup: WriteSnapshot;
    try {
      await deps.sleep(deps.windowMs);
      mark(`signupSnapshot${sfx}`);
      afterSignup = await deps.snapshot(`signupSnapshot${sfx}`);
    } finally {
      try {
        await journey.cleanup();
      } catch (e) {
        cleanupErrors.push(`journey ${j}: ${String((e as Error)?.stack ?? e)}`);
      }
    }
    mark(`cleanupEnd${sfx}`);
    await deps.sleep(deps.windowMs);
    endMark = `cleanupSnapshot${sfx}`;
    mark(endMark);
    const afterCleanup = await deps.snapshot(endMark);
    windows.push({ signup: writeDelta(prev, afterSignup), cleanup: writeDelta(afterSignup, afterCleanup) });
    prev = j < journeyCount ? await baselineRun(`mid${j}_`, afterCleanup, deps.baselineWindowsBetween ?? deps.baselineWindowsEachSide) : afterCleanup;
  }
  await baselineRun('post', prev, deps.baselineWindowsEachSide);
  const cleanupError = cleanupErrors.length ? cleanupErrors.join('\n') : null;

  const judged = {
    baselineWindows,
    signup: windows[0].signup,
    cleanup: windows[0].cleanup,
    repeatJourneys: windows.slice(1),
    map: deps.map,
  };
  const journeyWindow = { startMark, endMark };
  const firstPass = evaluateWriteDelta(judged);
  const map = deps.map ?? LIVE_DATA_MAP;
  const candidates = firstPass.falsifyingTables.filter((t) => !inSchema(t, map.customerSchemas));
  const verdict =
    candidates.length > 0 && deps.attribute
      ? evaluateWriteDelta({ ...judged, writerAttributions: await deps.attribute(candidates, journeyWindow) })
      : firstPass;
  return { meta: metas[0], metas, marks, cleanupError, journeyWindow, firstPassFalsifying: firstPass.falsifyingTables, verdict };
}

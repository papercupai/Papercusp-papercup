/**
 * Same-input inflow replay for repeated-tool-error rows
 * (bug-inflow-one-problem-one-row-2026-10-18, R-9 / D-009).
 *
 * A live before/after drop in filed rows cannot be attributed to this plan (D-009 Finding 1):
 * the capture path's serving build and the tool-failure volume both moved in the same days. So
 * R-9 is measured on the SAME input. Take the rows that were actually filed before the change,
 * and ask how many rows the current build's one-problem-one-row policy would file for them.
 *
 * Per row, in filing order:
 *   1. Re-key it with the production deriver (`deriveToolErrorWatchdogKey`, D-004 key shape;
 *      caller keyed once per tool per D-010). `errorCode` is the invocation-ledger error code
 *      for the row's (tool, sample), the same lookup `recompute-watchdog-keys` uses.
 *   2. A key already filed earlier in the replay is a counted repeat, not a new row.
 *   3. A volume-gated class (transient / rate-limit, `isVolumeGatedToolErrorClass`) is counted on
 *      its probation row and files only when the invocation watchdog's own bar fired for it.
 *      `watchdogPromoted` records that verdict as it was observed on the original row.
 *
 * The watchdog's per-tool daily mint cap (`capToolErrorMintsPerTool`) is NOT applied: the cap
 * defers a mint and never drops it, so counting every deferred mint as filed can only over-count.
 */
import type { ImprovementCandidate } from './policy';
import { isVolumeGatedToolErrorClass } from './tool-error-volume-gate';
import { deriveToolErrorWatchdogKey, parseRepeatedToolErrorKey } from './watchdog-key-migration';

export interface InflowReplayRow {
  id: string;
  /** Filing time, epoch milliseconds (work_items.created_ts). */
  createdTs: number;
  /** The watchdog key the row was filed under. */
  watchdogKey: string;
  /** Row body; only its trailing `Sample:` line is read, so a fixture may keep just that line. */
  body?: string | null;
  /** Invocation-ledger error_code for this row's (tool, sample), or null when unknown. */
  errorCode?: string | null;
  /** The improvement watchdog itself promoted this row (its count/rate/hours bar fired). */
  watchdogPromoted?: boolean;
}

export interface InflowReplayDay {
  before: number;
  after: number;
}

export interface InflowReplayResult {
  /** Rows actually filed (the replay input). */
  before: number;
  /** Rows the current build would file for the same input. */
  after: number;
  /** after / before; null when the input is empty. */
  ratio: number | null;
  /** Per UTC day (YYYY-MM-DD) of the input rows. */
  perDay: Record<string, InflowReplayDay>;
  /** Filed rows by the class of the current key ('unparsed' when the key does not parse). */
  afterByClass: Record<string, number>;
  /** Distinct current keys seen in the input. */
  distinctKeys: number;
}

function currentKey(row: InflowReplayRow): string {
  const candidate = { id: row.id, body: row.body ?? undefined, watchdogKey: row.watchdogKey } as ImprovementCandidate;
  return deriveToolErrorWatchdogKey(candidate, () => row.errorCode ?? null) ?? row.watchdogKey;
}

export function replayToolErrorInflow(rows: readonly InflowReplayRow[]): InflowReplayResult {
  const ordered = [...rows].sort((a, b) => a.createdTs - b.createdTs || a.id.localeCompare(b.id));
  const keyed = ordered.map((row) => ({ row, key: currentKey(row) }));
  const watchdogFiledKeys = new Set(keyed.filter((k) => k.row.watchdogPromoted).map((k) => k.key));

  const perDay: Record<string, InflowReplayDay> = {};
  const afterByClass: Record<string, number> = {};
  const filed = new Set<string>();
  const seen = new Set<string>();
  let after = 0;
  for (const { row, key } of keyed) {
    const day = new Date(row.createdTs).toISOString().slice(0, 10);
    const bucket = (perDay[day] ??= { before: 0, after: 0 });
    bucket.before++;
    seen.add(key);
    if (filed.has(key)) continue;
    const klass = parseRepeatedToolErrorKey(key)?.klass;
    if (isVolumeGatedToolErrorClass(klass) && !watchdogFiledKeys.has(key)) continue;
    filed.add(key);
    bucket.after++;
    after++;
    const label = klass ?? 'unparsed';
    afterByClass[label] = (afterByClass[label] ?? 0) + 1;
  }
  return {
    before: ordered.length,
    after,
    ratio: ordered.length === 0 ? null : after / ordered.length,
    perDay,
    afterByClass,
    distinctKeys: seen.size,
  };
}

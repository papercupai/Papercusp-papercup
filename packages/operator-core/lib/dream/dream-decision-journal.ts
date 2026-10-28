/**
 * Precomputed Dream/Gym decision journal — WI-6554700010030749.
 *
 * `learning.dream { view: 'observations' }` used to run `journalctl` inline on
 * the sync-resolver read path (the WI-5460 class the
 * no-heavy-io-on-read-path guard exists for): a subprocess per read, which
 * also FAILS outright on a host with no journald. The scan now runs in the
 * `learning.dreamDecisionJournal` derived-read producer
 * (derived-reads/producers.ts), and the resolver serves a requested window out
 * of that snapshot through {@link sliceDecisionJournal}.
 *
 * This module is deliberately PURE: it imports journal-read for TYPES only, so
 * nothing reachable from the resolver can spawn a process.
 *
 * Honesty rule (inherited from the inline read it replaces): a window the
 * snapshot cannot answer EXACTLY is reported as a journal error — UNKNOWN to
 * the observation assessors — never as an empty log. That covers a unit the
 * producer does not scan, a window outside the snapshot's coverage (including
 * one ending after the last scan), a failed scan, and a collapsed run of
 * identical lines that straddles a window boundary.
 */
import type { JournalEntry, JournalReadResult } from '../journal-read';

export const DREAM_DECISION_JOURNAL_KEY = 'learning.dreamDecisionJournal';

/** How far back each scan reaches. Older windows report not-covered. */
export const DREAM_DECISION_JOURNAL_LOOKBACK_MS = 6 * 60 * 60_000;

/**
 * Lines logged in the last moments before a scan may not have reached the
 * journal yet; the snapshot only claims coverage up to this far before the scan
 * began.
 */
export const DREAM_DECISION_JOURNAL_FLUSH_MARGIN_MS = 2_000;

/**
 * The unit whose journal carries both decision prefixes. Same convention as
 * system-health/single-primary-check.ts. The only caller
 * (dream-control-live-instrument.ts) pins this exact unit for both sources.
 */
export function dreamDecisionJournalUnits(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.PAPERCUSP_BACKGROUND_SYSTEMD_UNIT ?? 'papercusp-bg-host.service'];
}

/** One snapshot row per scanned unit. */
export interface DreamDecisionJournalRow {
  unit: string;
  /** ISO. The earliest instant this scan answers exactly. */
  coveredSince: string;
  /** ISO. The latest instant this scan answers exactly. */
  coveredUntil: string;
  scan: JournalReadResult;
}

export type DreamDecisionJournalSlice = JournalReadResult & {
  /** Which precomputed scan served this window (null when none could). */
  precomputed: { key: string; unit: string; coveredSince: string | null; coveredUntil: string | null };
};

/**
 * Build a snapshot row from one scan. When the scan hit its row cap, the
 * newest lines were kept, so coverage starts just after the oldest retained
 * line rather than at the requested lookback.
 */
export function buildDreamDecisionJournalRow(
  unit: string,
  scan: JournalReadResult,
  startedAtMs: number,
  lookbackMs: number = DREAM_DECISION_JOURNAL_LOOKBACK_MS,
): DreamDecisionJournalRow {
  const requestedSince = startedAtMs - lookbackMs;
  const oldest = scan.entries.length > 0 ? Date.parse(scan.entries[0].ts) : null;
  const coveredSinceMs = scan.truncated && oldest !== null && Number.isFinite(oldest)
    ? Math.max(requestedSince, oldest + 1)
    : requestedSince;
  return {
    unit,
    coveredSince: new Date(coveredSinceMs).toISOString(),
    coveredUntil: new Date(startedAtMs - DREAM_DECISION_JOURNAL_FLUSH_MARGIN_MS).toISOString(),
    scan,
  };
}

export interface DreamDecisionJournalRequest {
  unit: string;
  /** ISO window, exactly as the observation scope carries it. */
  since: string;
  until: string;
  /** Message substring selecting this source's decision lines. */
  prefix: string;
  /** Row cap for this source; the newest lines are kept. */
  limit: number;
}

function failed(base: JournalReadResult | null, request: DreamDecisionJournalRequest, error: string,
  row: DreamDecisionJournalRow | null): DreamDecisionJournalSlice {
  const sinceMs = Date.parse(request.since);
  const untilMs = Date.parse(request.until);
  return {
    entries: [],
    matched: null,
    collapsed: 0,
    truncated: false,
    window: { since: `@${sinceMs / 1000}`, until: `@${untilMs / 1000}`, resolved: null },
    units: [request.unit],
    journalAvailable: base?.journalAvailable ?? false,
    backend: base?.backend ?? 'none',
    journalError: error,
    unitsUnknown: base?.unitsUnknown ?? [],
    windowOutsideJournal: null,
    command: base?.command ?? '',
    precomputed: { key: DREAM_DECISION_JOURNAL_KEY, unit: request.unit,
      coveredSince: row?.coveredSince ?? null, coveredUntil: row?.coveredUntil ?? null },
  };
}

/**
 * Serve one source's window out of the precomputed rows. Never reads the
 * journal itself.
 */
export function sliceDecisionJournal(
  rows: readonly DreamDecisionJournalRow[],
  request: DreamDecisionJournalRequest,
): DreamDecisionJournalSlice {
  const sinceMs = Date.parse(request.since);
  const untilMs = Date.parse(request.until);
  const row = rows.find(candidate => candidate.unit === request.unit) ?? null;
  if (!row) return failed(null, request, `journal-unit-not-precomputed:${request.unit}`, null);
  const scan = row.scan;
  if (scan.journalError || scan.matched === null) {
    return failed(scan, request, scan.journalError ?? 'precomputed-journal-scan-failed', row);
  }
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
    return failed(scan, request, 'invalid-journal-window', row);
  }
  if (sinceMs < Date.parse(row.coveredSince) || untilMs > Date.parse(row.coveredUntil)) {
    // Includes a window that ends after the last scan: the snapshot refreshes
    // on read once stale, so a later read can answer it.
    return failed(scan, request,
      `journal-snapshot-does-not-cover-window:covered=${row.coveredSince}..${row.coveredUntil}`, row);
  }

  const inWindow: JournalEntry[] = [];
  for (const entry of scan.entries) {
    const first = Date.parse(entry.ts);
    const last = entry.repeat > 1 && entry.lastTs ? Date.parse(entry.lastTs) : first;
    if (last < sinceMs || first > untilMs) continue;
    if (first < sinceMs || last > untilMs) {
      // A collapsed run counts every line as one row; part of it lies outside
      // the window, so no exact count exists for this window.
      return failed(scan, request, 'collapsed-journal-run-straddles-window', row);
    }
    inWindow.push(entry);
  }

  const matching = inWindow.filter(entry => entry.message.includes(request.prefix));
  const matched = matching.reduce((count, entry) => count + entry.repeat, 0);
  const entries = matching.slice(-request.limit);
  return {
    ...scan,
    entries,
    matched,
    collapsed: entries.reduce((count, entry) => count + entry.repeat - 1, 0),
    truncated: matched > request.limit,
    window: {
      since: `@${sinceMs / 1000}`,
      until: `@${untilMs / 1000}`,
      resolved: scan.window.resolved
        ? { ...scan.window.resolved, sinceUtc: new Date(sinceMs).toISOString(),
          untilUtc: new Date(untilMs).toISOString(), untilRequested: true, invertedHint: null }
        : null,
    },
    units: [request.unit],
    windowOutsideJournal: null,
    // The scan read both prefixes at once. A clipped message may hide the other
    // prefix after the cut, so neither source may infer absence from it.
    journalError: inWindow.some(entry => entry.clipped) ? 'shared-journal-message-clipped' : null,
    precomputed: { key: DREAM_DECISION_JOURNAL_KEY, unit: request.unit,
      coveredSince: row.coveredSince, coveredUntil: row.coveredUntil },
  };
}

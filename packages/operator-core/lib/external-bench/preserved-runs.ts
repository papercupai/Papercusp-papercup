import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * Preserved external-bench run reader (impartial-benchmark-suite — Evaluation
 * "Preserved runs" surface).
 *
 * The fleet-arm runners (hive-backlog.ts et al.) write a per-run snapshot to
 * `~/.papercusp/bench-results/<id>/` when a real benchmark pass is preserved for
 * reproducibility — the arm generation record (`<arm>.json`) plus the OFFICIAL
 * grader's per-instance verdict map (`grade-<arm>/out/eval_results.json`). The
 * first preserved run is `m3-realqueen-2026-06-16` (the M3 real-Queen
 * SWE-bench Pro pass: 6/11 = 54.5% resolved, graded by the official grader).
 *
 * This module is the PURE read + merge layer behind the REST route
 * (`/external-bench/runs`): it lists run dirs, reads one run's arm JSON + grade
 * map, joins the per-instance `resolved` verdict onto each `perTask` row, and
 * computes the headline summary (resolved/taskCount, totals, coordEvents count).
 * No HTTP, no DB — the disk is the source of truth for a preserved run, and the
 * merge is unit-tested against a fixture. The route is a thin wrapper.
 *
 * Shape note: the preserved snapshot is NOT `HiveBacklogResult` — it is the
 * recovered/flattened form the arm runner persists (`perTask` rows with
 * `instanceId`/`disposition`/`stopReason`/`costUsd`/`turns`/`diffBytes`, plus
 * `totals`, `nonEmptyDiffs`, `recovered`, an ISO `startedAt`, and a `coordEvents`
 * trace). We read it as a lenient shape so additive fields never break the read.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CoordEvent } from '@papercusp/bench-metrics';
import { substrateSignalRates } from '@papercusp/bench-metrics';
import { isScoredStopReason } from './types';

/** Default base dir for preserved runs (`~/.papercusp/bench-results`). */
export function defaultBenchResultsDir(): string {
  return papercuspPath('bench-results');
}

/** One per-task row as persisted by the arm runner (lenient — additive fields ignored). */
export interface PreservedPerTask {
  instanceId: string;
  taskStatus?: string;
  cupId?: string;
  disposition?: string;
  stopReason?: string;
  generationError?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  turns?: number;
  wallClockMs?: number;
  diffBytes?: number;
  armMeta?: Record<string, unknown>;
}

/** The arm-run snapshot on disk (`<arm>.json`). */
export interface PreservedArmRun {
  arm: string;
  /** Execution identity belongs to the archive; missing legacy fields stay unknown. */
  model?: string;
  suite?: string;
  taskSetId?: string;
  config?: Record<string, unknown>;
  runId?: string;
  runError?: string | null;
  startedAt?: string;
  finishedAt?: string;
  wallMs?: number;
  peakConcurrentBees?: number;
  taskCount?: number;
  nonEmptyDiffs?: number;
  totals?: { costUsd?: number; tokensIn?: number; tokensOut?: number };
  perTask?: PreservedPerTask[];
  coordEvents?: CoordEvent[];
  recovered?: boolean;
}

/** A `perTask` row with the grader's `resolved` verdict merged in. */
export interface ResolvedPerTask extends PreservedPerTask {
  /** Official grader verdict for this instance; null when the grade map has no entry. */
  resolved: boolean | null;
}

/** Headline rollup for a preserved run. */
export interface PreservedRunSummary {
  arm: string;
  /** Tasks SCORED — the grader returned a verdict AND generation was not an external/transient/infra failure. */
  gradedCount: number;
  /** Tasks marked resolved (true) by the grader (among the SCORED tasks). */
  resolvedCount: number;
  /** Assigned task population, including tasks that produced no row. */
  taskCount: number;
  attemptedCount?: number;
  absentCount?: number;
  missingGradeCount?: number;
  measurementComplete?: boolean;
  /** Secondary quality among completed, officially graded submissions. */
  conditionalResolvedPct?: number | null;
  /**
   * Tasks EXCLUDED from the resolved% denominator because generation was an external/transient/infra
   * failure (stopReason ∈ {error, timeout, infra-failed} or a generationError) — never a capability fail.
   * The fairness count (mirrors bench-metrics' `infraErrors`).
   */
  infraExcluded: number;
  /** Primary resolved / assigned; null while a submission lacks a grader measurement. */
  resolvedPct: number | null;
  /** Summed cost across the run (prefer the snapshot `totals`, else sum perTask). */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Wall-clock window in ms (0 for a recovered run with no preserved timing). */
  wallMs: number;
  peakConcurrentBees: number;
  /** Tasks whose generated diff was non-empty (a real patch was produced). */
  nonEmptyDiffs: number;
  /** Total coordination events in the trace. */
  coordEventCount: number;
  /** This snapshot was reconstructed from recovered fleet state (vs a clean live run). */
  recovered: boolean;
}

/** One available preserved run (a dir under the bench-results base). */
export interface PreservedRunListEntry {
  id: string;
  /** The arm json file basename if exactly one resolves (e.g. `hive-realqueen`); null otherwise. */
  arm: string | null;
  /** mtime (ms epoch) of the run dir — for recency sort. */
  mtimeMs: number;
}

/** The fully-merged detail one run renders from. */
export interface PreservedRunDetail {
  id: string;
  run: PreservedArmRun;
  perTask: ResolvedPerTask[];
  summary: PreservedRunSummary;
  /** The objective substrate-signal rates over the coordEvents trace (feeds MastBreakdown). */
  coordRates: ReturnType<typeof substrateSignalRates>;
}

/** Reject ids that could escape the base dir (path traversal / absolute paths). */
export function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/**
 * The single arm json inside a run dir. A preserved run dir holds one
 * `<arm>.json` at its top level (siblings are `grade-<arm>/`, `diffs-<arm>/`,
 * `tasks-sample.jsonl`, `README.md`). Returns the arm basename, or null if zero
 * or more-than-one `*.json` arm file is present (ambiguous — caller degrades).
 */
export function resolveArmFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const armJsons = entries.filter(
    (f) => f.endsWith('.json') && f !== 'package.json' && !f.startsWith('.'),
  );
  return armJsons.length === 1 ? armJsons[0].replace(/\.json$/, '') : null;
}

/** List the available preserved run dirs under `baseDir`, newest first. */
export function listPreservedRuns(baseDir = defaultBenchResultsDir()): PreservedRunListEntry[] {
  let names: string[];
  try {
    names = readdirSync(baseDir);
  } catch {
    return [];
  }
  const out: PreservedRunListEntry[] = [];
  for (const id of names) {
    if (!isSafeRunId(id)) continue;
    const dir = join(baseDir, id);
    let mtimeMs = 0;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    out.push({ id, arm: resolveArmFile(dir), mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Read the grader's per-instance verdict map (`grade-<arm>/out/eval_results.json`). */
export function readGradeMap(dir: string, arm: string): Record<string, boolean> | null {
  const gradePath = join(dir, `grade-${arm}`, 'out', 'eval_results.json');
  if (!existsSync(gradePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(gradePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Object.values(parsed).some((value) => typeof value !== 'boolean')) return null;
    return parsed as Record<string, boolean>;
  } catch {
    return null;
  }
}

/** Import time is not execution time. Derive an end only from measured, unrecovered timing. */
export function preservedExecutionTimes(run: PreservedArmRun): {
  startedAt: string | null;
  finishedAt: string | null;
} {
  const timestamp = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const startedAt = timestamp(run.startedAt);
  const explicitEnd = timestamp(run.finishedAt);
  let measuredEnd: string | null = null;
  if (startedAt && !run.recovered && typeof run.wallMs === 'number' &&
      Number.isFinite(run.wallMs) && run.wallMs > 0) {
    const end = new Date(Date.parse(startedAt) + run.wallMs);
    if (Number.isFinite(end.getTime())) measuredEnd = end.toISOString();
  }
  const finishedAt = explicitEnd ?? measuredEnd;
  return {
    startedAt,
    finishedAt: finishedAt && (!startedAt || Date.parse(finishedAt) >= Date.parse(startedAt))
      ? finishedAt : null,
  };
}

/**
 * Merge the grade map's per-instance `resolved` verdict onto each perTask row.
 * Pure — the heart of the surface, unit-tested against a fixture. A row with no
 * grade-map entry gets `resolved: null` (excluded from accuracy, per the locked
 * scoring rule), NOT a silent `false`.
 */
export function mergeResolved(
  perTask: readonly PreservedPerTask[],
  grade: Record<string, boolean> | null,
): ResolvedPerTask[] {
  return perTask.map((t) => ({
    ...t,
    resolved: grade && t.instanceId in grade ? grade[t.instanceId] : null,
  }));
}

/**
 * Compute the headline summary from the merged rows + the run snapshot.
 *
 * Assignment is the primary denominator. Generation failures and non-attempts
 * remain outcomes; quality conditional on a measured submission is secondary.
 * A missing official grader measurement makes the primary score inconclusive.
 */
export function summarizePreservedRun(
  run: PreservedArmRun,
  merged: readonly ResolvedPerTask[],
): PreservedRunSummary {
  let gradedCount = 0;
  let resolvedCount = 0;
  let infraExcluded = 0;
  let attemptedCount = 0;
  let missingGradeCount = 0;
  for (const t of merged) {
    if (t.taskStatus === 'todo' || t.taskStatus === 'in_progress') continue;
    attemptedCount += 1;
    // NON-SCORED: an external/transient/infra failure (by stopReason or a generationError) is excluded
    // from the denominator even if the grade map carries a verdict for it (it never produced a real,
    // fairly-given submission). Count it separately.
    const infra = !isScoredStopReason(t.stopReason) || (t.generationError != null && t.generationError !== '');
    if (infra) {
      infraExcluded += 1;
      continue;
    }
    if (t.resolved == null) {
      missingGradeCount += 1;
      continue;
    }
    gradedCount += 1;
    if (t.resolved) resolvedCount += 1;
  }
  // Prefer the snapshot's preserved totals; fall back to summing perTask.
  const summedCost = merged.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const summedIn = merged.reduce((a, t) => a + (t.tokensIn ?? 0), 0);
  const summedOut = merged.reduce((a, t) => a + (t.tokensOut ?? 0), 0);
  const assignedIds = Array.isArray(run.config?.taskIds)
    ? new Set(run.config.taskIds.filter((id): id is string => typeof id === 'string')).size : 0;
  const declaredCount = Number.isSafeInteger(run.taskCount) && run.taskCount! >= 0 ? run.taskCount! : 0;
  const taskCount = Math.max(declaredCount, assignedIds, merged.length);
  return {
    arm: run.arm,
    gradedCount,
    resolvedCount,
    infraExcluded,
    taskCount,
    attemptedCount,
    absentCount: taskCount - attemptedCount,
    missingGradeCount,
    measurementComplete: missingGradeCount === 0,
    resolvedPct: taskCount > 0 && missingGradeCount === 0 ? resolvedCount / taskCount : null,
    conditionalResolvedPct: gradedCount > 0 ? resolvedCount / gradedCount : null,
    costUsd: run.totals?.costUsd ?? summedCost,
    tokensIn: run.totals?.tokensIn ?? summedIn,
    tokensOut: run.totals?.tokensOut ?? summedOut,
    wallMs: run.wallMs ?? 0,
    peakConcurrentBees: run.peakConcurrentBees ?? 0,
    nonEmptyDiffs:
      run.nonEmptyDiffs ?? merged.filter((t) => (t.diffBytes ?? 0) > 0).length,
    coordEventCount: run.coordEvents?.length ?? 0,
    recovered: run.recovered ?? false,
  };
}

/**
 * Read + merge one preserved run by id. Returns null when the dir / arm json is
 * missing or unreadable (the route maps that to a 404). `baseDir` is injectable
 * for tests; production resolves it server-side (NEVER from a request param).
 */
export type PreservedRunInspection =
  | { kind: 'valid'; detail: PreservedRunDetail }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'invalid'; reason: string };

/** Distinguish invalid archive content from unavailable evidence before repairing stored history. */
export function inspectPreservedRun(
  id: string,
  baseDir = defaultBenchResultsDir(),
): PreservedRunInspection {
  if (!isSafeRunId(id)) return { kind: 'unavailable', reason: 'unsafe_run_id' };
  const dir = join(baseDir, id);
  const arm = resolveArmFile(dir);
  if (!arm) return { kind: 'unavailable', reason: 'missing_or_ambiguous_arm_file' };
  const armPath = join(dir, `${arm}.json`);
  if (!existsSync(armPath)) return { kind: 'unavailable', reason: 'missing_arm_file' };
  let raw: string;
  try {
    raw = readFileSync(armPath, 'utf8');
  } catch {
    return { kind: 'unavailable', reason: 'unreadable_arm_file' };
  }
  let run: PreservedArmRun;
  try {
    run = JSON.parse(raw) as PreservedArmRun;
  } catch {
    return { kind: 'invalid', reason: 'invalid_arm_json' };
  }
  // A dataset, summary or settings JSON is not an executed arm. Validate before
  // metrics are computed or a directory can become a completed database run.
  if (!run || typeof run !== 'object' || Array.isArray(run) ||
      !Array.isArray(run.perTask) || run.perTask.length === 0) {
    return { kind: 'invalid', reason: 'no_task_submission_records' };
  }
  const taskIds = new Set<string>();
  for (const task of run.perTask) {
    if (!task || typeof task !== 'object' || Array.isArray(task) ||
        typeof task.instanceId !== 'string' || !task.instanceId.trim() ||
        taskIds.has(task.instanceId)) {
      return { kind: 'invalid', reason: 'invalid_or_duplicate_task_identity' };
    }
    taskIds.add(task.instanceId);
  }
  const grade = readGradeMap(dir, arm);
  const perTask = mergeResolved(run.perTask ?? [], grade);
  const summary = summarizePreservedRun(run, perTask);
  const coordRates = substrateSignalRates(run.coordEvents ?? [], perTask.length);
  return { kind: 'valid', detail: { id, run, perTask, summary, coordRates } };
}

export function readPreservedRun(id: string, baseDir = defaultBenchResultsDir()): PreservedRunDetail | null {
  const inspection = inspectPreservedRun(id, baseDir);
  return inspection.kind === 'valid' ? inspection.detail : null;
}

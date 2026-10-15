/**
 * Benchmark report BUILDER (plan benchmark-report-portable-trace-2026-06-17).
 *
 * Two jobs:
 *   1. `buildReportHtml(bundle)` — inject a {@link BenchReportBundle} into the dependency-free
 *      `report-viewer.html` template as `window.__BENCH_REPORT__`, yielding ONE self-contained,
 *      double-clickable `report-<runId>.html` (no server, no network, works offline anywhere).
 *   2. `bundleFromRollouts(...)` — assemble the SHARED core of a bundle from the data the system
 *      already records (RolloutRecord[] + TaskRunResult[] + optional coord/spawn/call-log). Per-suite
 *      callers attach `suiteData` (AgentsNet graph, PaperBench rubric, TheAgentCompany checkpoints, …).
 *
 * This file maps existing records → the report projection; it does not collect new data. The call-log
 * (the replay-grade audit) is sourced from the defineTool audit layer as that lands — pass it in.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costAccuracyFrontier, summarizeAssignedOutcomes } from '@papercusp/bench-metrics';
import { armContamination } from '../contamination';
import {
  BENCH_REPORT_SCHEMA_VERSION,
  type BenchReportArmSummary,
  type BenchReportBundle,
  type BenchReportCall,
  type BenchReportCoordEvent,
  type BenchReportCostComparison,
  type BenchReportRollout,
  type BenchReportSpawnNode,
} from './report-schema';

/** Minimal shapes we read — kept structural so callers can pass RolloutRecord / TaskRunResult directly. */
interface RolloutLike {
  rolloutId: string;
  taskId: string;
  arm: string;
  seed: number;
  modelId: string;
  modelVersion?: string | null;
  harnessVersion: string;
  harnessGitSha?: string | null;
  configSnapshot?: Record<string, unknown> | null;
  envFingerprint?: Record<string, unknown> | null;
  graderFamily?: string;
  graderVersion?: string;
  rawGraderOutput?: string | null;
  graderOutput?: unknown;
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
}
interface RunResultLike {
  taskId: string;
  arm: string;
  seed: number;
  resolved: boolean | null;
  score?: number | null;
  graderStatus: string;
  generationStatus?: string;
  generationError?: string | null;
  stopReason?: string;
  costUsd: number;
  armMeta?: Record<string, unknown> | null;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  wallClockMs: number;
  turns?: number;
  failToPass?: Array<{ test: string; passed: boolean }> | null;
  passToPass?: Array<{ test: string; passed: boolean }> | null;
}

function key(taskId: string, arm: string, seed: number): string {
  return `${arm}::${taskId}::${seed}`;
}

/** Unknown telemetry retains its known subtotal, never a measured zero.
 * Preserve the same explicit missing-measurement convention as bench-metrics. */
function recordedCosts(rows: readonly RunResultLike[]) {
  const subtotal = rows.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : 0), 0);
  const costUsdMeasurementMissing = !rows.length || !Number.isFinite(subtotal) || rows.some(r =>
    !Number.isFinite(r.costUsd) || r.costUsd < 0 ||
    r.armMeta?.costUsdMeasurementMissing !== undefined && r.armMeta.costUsdMeasurementMissing !== false);
  const bases = new Set(rows.map(r => (r.armMeta?.nativeCostAccounting as { basis?: unknown } | undefined)?.basis ===
    'frozen-normalized-native-source' ? 'frozen-normalized-native-source' : 'recorded'));
  return { costUsd: costUsdMeasurementMissing ? null : subtotal,
    costKnownSubtotalUsd: Number.isFinite(subtotal) ? subtotal : null, costUsdMeasurementMissing,
    costBasis: bases.size === 1 ? [...bases][0] : 'mixed' };
}

/**
 * Assemble the shared core of a report bundle. Joins each TaskRunResult to its RolloutRecord (by
 * task×arm×seed) so a rollout row carries BOTH the score/cost AND the replay fingerprint
 * (config/version/sha/env/submission/grader-output/trajectory). Computes per-arm rollups.
 */
export function bundleFromRollouts(input: {
  runId: string;
  suite: string;
  label?: string;
  createdAt: string;
  arms: string[];
  models: Record<string, string>;
  prereg?: { hash: string; config?: Record<string, unknown>; gitCommitSha?: string | null };
  harnessGitSha?: string | null;
  envFingerprint?: Record<string, unknown> | null;
  runResults: RunResultLike[];
  assignedTaskIds?: readonly string[];
  assignedSeeds?: readonly number[];
  rollouts?: RolloutLike[];
  coordTrace?: BenchReportCoordEvent[];
  spawnTree?: BenchReportSpawnNode[];
  callLog?: BenchReportCall[];
  concurrencyTimeline?: Record<string, Array<{ tMs: number; live: number }>>;
  suiteData?: Record<string, unknown>;
  /** taskId → task creation date (ISO). A task absent here is undated, so its arm cannot be labelled clean. */
  taskCreatedAt?: Readonly<Record<string, string | null | undefined>>;
  /** modelId → pinned training-data cutoff (`null` = explicitly unknown). Absent ids use MODEL_TRAINING_CUTOFFS. */
  trainingCutoffs?: Readonly<Record<string, string | null>>;
}): BenchReportBundle {
  if (input.runResults.some(row => !input.arms.includes(row.arm))) {
    throw new Error('benchmark report: result outside frozen arm assignment');
  }
  const assignedTaskIds = input.assignedTaskIds ?? [...new Set(input.runResults.map(row => row.taskId))];
  const rolloutByKey = new Map<string, RolloutLike>();
  for (const r of input.rollouts ?? []) rolloutByKey.set(key(r.taskId, r.arm, r.seed), r);

  const rollouts: BenchReportRollout[] = input.runResults.map((rr) => {
    const ro = rolloutByKey.get(key(rr.taskId, rr.arm, rr.seed));
    return {
      rolloutId: ro?.rolloutId ?? key(rr.taskId, rr.arm, rr.seed),
      taskId: rr.taskId,
      arm: rr.arm,
      seed: rr.seed,
      resolved: rr.resolved,
      score: rr.score ?? null,
      graderStatus: rr.graderStatus,
      stopReason: rr.stopReason ?? rr.generationStatus ?? 'unknown',
      generationError: rr.generationError ?? null,
      ...recordedCosts([rr]),
      armMeta: rr.armMeta ?? null,
      tokensIn: rr.tokensIn,
      tokensOut: rr.tokensOut,
      tokensTotal: rr.tokensTotal,
      wallMs: rr.wallClockMs,
      turns: rr.turns,
      modelId: ro?.modelId ?? input.models[rr.arm] ?? 'unknown',
      modelVersion: ro?.modelVersion ?? null,
      harnessVersion: ro?.harnessVersion ?? 'unknown',
      harnessGitSha: ro?.harnessGitSha ?? input.harnessGitSha ?? null,
      configSnapshot: ro?.configSnapshot ?? null,
      envFingerprint: ro?.envFingerprint ?? input.envFingerprint ?? null,
      submission: ro?.submission ?? null,
      rawGraderOutput: ro?.rawGraderOutput ?? null,
      failToPass: rr.failToPass ?? null,
      passToPass: rr.passToPass ?? null,
      trajectoryRef: ro?.trajectoryRef ?? null,
      trajectoryKind: ro?.trajectoryKind ?? null,
    };
  });

  // per-arm rollups
  const arms: BenchReportArmSummary[] = input.arms.map((arm) => {
    const rows = input.runResults.filter((r) => r.arm === arm);
    const outcome = summarizeAssignedOutcomes(rows, { assignedTaskIds, assignedSeeds: input.assignedSeeds });
    const costs = recordedCosts(rows);
    return {
      arm,
      resolved: outcome.resolved,
      scored: outcome.gradedAttempts,
      meanScore: rows.some(row => row.score != null) ? outcome.conditionalMeanScore : null,
      assignedTasks: outcome.assignedTasks,
      assignedAttempts: outcome.assignedAttempts,
      attempts: outcome.attempts,
      absentAttempts: outcome.absentAttempts,
      missingMeasurements: outcome.missingMeasurements,
      outcomes: outcome.outcomes,
      measurementComplete: outcome.measurementComplete,
      primaryResolvedPct: outcome.primaryResolvedPct,
      primaryMeanScore: outcome.primaryMeanScore,
      conditionalResolvedPct: outcome.conditionalResolvedPct,
      assignmentSource: input.assignedTaskIds && input.assignedSeeds ? 'frozen' : 'observed',
      infraExcluded: rows.length - outcome.gradedAttempts,
      ...costs,
      costPerAssignedTaskUsd: input.assignedTaskIds && input.assignedSeeds &&
        outcome.assignedTasks > 0 && outcome.absentAttempts === 0 && costs.costUsd !== null
        ? costs.costUsd / outcome.assignedTasks : null,
      tokensTotal: rows.reduce((s, r) => s + (r.tokensTotal || 0), 0),
      concurrency: summarizeConcurrency(input.concurrencyTimeline?.[arm]),
      contamination: armContamination({
        modelId: input.models[arm] ?? 'unknown',
        assignedTaskIds,
        assignedSeeds: input.assignedSeeds,
        rows,
        taskCreatedAt: input.taskCreatedAt,
        trainingCutoffOverride: pinnedCutoff(input.trainingCutoffs, input.models[arm]),
      }),
    };
  });

  const totals = {
    tasks: assignedTaskIds.length,
    ...recordedCosts(input.runResults),
    tokensIn: input.runResults.reduce((s, r) => s + (r.tokensIn || 0), 0),
    tokensOut: input.runResults.reduce((s, r) => s + (r.tokensOut || 0), 0),
    wallMs: input.runResults.reduce((m, r) => Math.max(m, r.wallClockMs || 0), 0),
  };

  return {
    schemaVersion: BENCH_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      runId: input.runId,
      suite: input.suite,
      label: input.label,
      createdAt: input.createdAt,
      arms: input.arms,
      models: input.models,
      prereg: input.prereg,
      harnessGitSha: input.harnessGitSha ?? null,
      envFingerprint: input.envFingerprint ?? null,
      totals,
    },
    arms,
    rollouts,
    costComparison: costComparison(input, arms, assignedTaskIds),
    coordTrace: input.coordTrace,
    spawnTree: input.spawnTree,
    callLog: input.callLog,
    concurrencyTimeline: input.concurrencyTimeline,
    suite: input.suite,
    suiteData: input.suiteData,
  };
}

/** Reuse the common Pareto core, with eligibility from the frozen assigned denominator.
 * Never place a partial-cost subtotal or conditional graded quality on the efficiency frontier. */
function costComparison(input: {
  runResults: RunResultLike[]; assignedTaskIds?: readonly string[]; assignedSeeds?: readonly number[];
}, arms: readonly BenchReportArmSummary[], assignedTaskIds: readonly string[]): BenchReportCostComparison {
  const partialCredit = input.runResults.some(row => typeof row.score === 'number' && Number.isFinite(row.score));
  const metric = partialCredit ? 'assigned-mean-score' : 'assigned-resolved-rate';
  const bases = new Set(arms.filter(arm => arm.costPerAssignedTaskUsd != null).map(arm => arm.costBasis));
  const points: BenchReportCostComparison['points'] = arms.map(arm => {
    const value = (partialCredit ? arm.primaryMeanScore : arm.primaryResolvedPct) ?? null;
    const excludedReasons: string[] = [];
    if (arm.assignmentSource !== 'frozen') excludedReasons.push('unfrozen-assignment');
    if (value === null || !arm.measurementComplete) excludedReasons.push('missing-grade');
    if (arm.absentAttempts) excludedReasons.push('absent-attempts');
    if (arm.costUsd === null) excludedReasons.push('incomplete-cost');
    if (arm.costPerAssignedTaskUsd === null) excludedReasons.push('cost-per-task-unavailable');
    if (arm.costBasis === 'mixed' || bases.size > 1) excludedReasons.push('incompatible-cost-bases');
    return { arm: arm.arm, value, costPerTaskUsd: arm.costPerAssignedTaskUsd ?? null,
      onFrontier: null, excludedReasons };
  });
  const eligible = points.filter(point => !point.excludedReasons.length)
    .map(point => ({ arm: point.arm, accuracy: point.value!, cost: point.costPerTaskUsd! }));
  const frontier = new Set(costAccuracyFrontier(eligible).map(point => point.arm));
  for (const point of points) if (!point.excludedReasons.length) point.onFrontier = frontier.has(point.arm);

  const taskWinners: BenchReportCostComparison['taskWinners'] = assignedTaskIds.map(taskId => {
    const candidates = arms.map(arm => {
      const rows = input.runResults.filter(row => row.arm === arm.arm && row.taskId === taskId);
      const outcome = summarizeAssignedOutcomes(rows, { assignedTaskIds: [taskId], assignedSeeds: input.assignedSeeds });
      const costs = recordedCosts(rows);
      return { arm: arm.arm, value: (partialCredit ? outcome.primaryMeanScore : outcome.primaryResolvedPct),
        complete: outcome.measurementComplete && arm.assignmentSource === 'frozen',
        costUsd: outcome.absentAttempts ? null : costs.costUsd, costBasis: costs.costBasis,
        tokensTotal: rows.reduce((sum, row) => sum + (row.tokensTotal || 0), 0) };
    });
    const incompleteArms = candidates.filter(candidate => !candidate.complete || candidate.value === null)
      .map(candidate => candidate.arm);
    const value = !incompleteArms.length && candidates.length ? Math.max(...candidates.map(candidate => candidate.value!)) : null;
    // A zero-outcome tie has no successful winner. Retain all ties at a positive outcome, with their full task cost.
    const winners = value !== null && value > 0 ? candidates.filter(candidate => candidate.value === value)
      .map(({ arm, costUsd, costBasis, tokensTotal }) => ({ arm, costUsd, costBasis, tokensTotal })) : [];
    return { taskId, value, incompleteArms, winners };
  });
  return { metric, points, taskWinners };
}

/** A caller-pinned cutoff for `modelId`: `undefined` when none was pinned (use the curated table). */
function pinnedCutoff(
  pins: Readonly<Record<string, string | null>> | undefined,
  modelId: string | undefined,
): string | null | undefined {
  if (!pins || !modelId || !Object.prototype.hasOwnProperty.call(pins, modelId)) return undefined;
  return pins[modelId];
}

function summarizeConcurrency(
  samples: Array<{ tMs: number; live: number }> | undefined,
): { avg: number; peak: number } | undefined {
  if (!samples || !samples.length) return undefined;
  const peak = samples.reduce((m, s) => Math.max(m, s.live), 0);
  const avg = samples.reduce((s, x) => s + x.live, 0) / samples.length;
  return { avg, peak };
}

function viewerTemplatePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'report-viewer.html');
}

/**
 * Inject `bundle` into the dependency-free viewer template → a self-contained HTML string. The viewer
 * reads `window.__BENCH_REPORT__` first (report-viewer.html `loadBundle`), so we splice a script setting
 * it in just before the viewer's own `<script>`. JSON is `<`-escaped so it can't break out of the tag.
 */
export function buildReportHtml(bundle: BenchReportBundle, templatePath = viewerTemplatePath()): string {
  const template = readFileSync(templatePath, 'utf8');
  const json = JSON.stringify(bundle).replace(/</g, '\\u003c');
  const inject = `<script>window.__BENCH_REPORT__=${json};</script>\n<script>`;
  const marker = '<script>\n"use strict";';
  if (template.includes(marker)) return template.replace(marker, inject + '\n"use strict";');
  // Fallback: inject before the first <script> tag.
  return template.replace('<script>', inject);
}

/** Write a portable `report-<runId>.html` for `bundle`. Returns the path written. */
export function writeReportHtml(bundle: BenchReportBundle, outPath: string): string {
  writeFileSync(outPath, buildReportHtml(bundle), 'utf8');
  return outPath;
}

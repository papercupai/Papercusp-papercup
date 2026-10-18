import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * PG-source report builder (plan benchmark-report-portable-trace-2026-06-17, P-001).
 *
 * Assembles a {@link BenchReportBundle} for a `runId` from the LIVE recorded data — the
 * `benchmark_run_result` rows (listRunResults → TaskRunResult), their Rollout Cards (getRollout →
 * the replay fingerprint), and the bench-run detail (getBenchRunDetail → coordination events +
 * per-task bee ids) — then reuses the pure {@link bundleFromRollouts} core. The result feeds
 * {@link buildReportHtml}/{@link writeReportHtml} → a portable `report-<runId>.html`.
 *
 * The store readers are INJECTED (default to the real `reproducibility/store` + `run-store`) so this
 * is unit-testable with fakes — NO PG. Every section degrades gracefully: if the rollout/detail reads
 * return nothing, the bundle still carries the scoreable rows + rollups (the viewer hides empty tabs).
 * The defineTool call-log (replay-grade audit) is NOT sourced here — it rides
 * [[route-everything-through-definetool-2026-06-17]]; pass it via `extraCallLog` when available.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchReportBundle, BenchReportCall, BenchReportCoordEvent, BenchReportSpawnNode } from './report-schema';
import { bundleFromRollouts, writeReportHtml } from './report-builder';
import type { DbScope } from '../reproducibility/db';
import type { PreregRecord } from '../reproducibility/schema';
import { resolveRunReportAssignment } from '../reproducibility/store';

/** Structural shapes of the store reads we consume (kept loose so real types satisfy them). */
interface TaskRunResultRow {
  runId: string;
  suite: string;
  taskId: string;
  arm: string;
  seed: number;
  resolved: boolean | null;
  score?: number | null;
  graderStatus: string;
  generationStatus?: string;
  generationError?: string | null;
  rolloutId?: string;
  modelId?: string;
  preregHash?: string;
  tokensCacheWrite?: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  costUsd: number;
  armMeta?: Record<string, unknown> | null;
  wallClockMs: number;
  turns?: number;
  failToPass?: Array<{ test: string; passed: boolean }> | null;
  passToPass?: Array<{ test: string; passed: boolean }> | null;
  createdAt?: string;
}
interface RolloutRow {
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
  rawGraderOutput?: string | null;
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
  createdAt?: string;
}
interface RunDetail {
  /** The task set the bench run drew from — resolves each task's creation date (D-007). */
  taskSetId?: string | null;
  coordEvents?: Array<{ ts?: number; kind?: string; agent?: string; taskId?: string | null; detail?: string }>;
  perTask?: Array<{ instanceId: string; cupId?: string; stopReason?: string; costUsd?: number }>;
}

export interface PgReportReaders {
  getPrereg?: (runId: string) => Promise<PreregRecord | null>;
  listRunResults: (opts: { runId: string }) => Promise<TaskRunResultRow[]>;
  getRollout: (rolloutId: string) => Promise<RolloutRow | null>;
  getBenchRunDetail?: (id: string) => Promise<RunDetail | null>;
  /**
   * Task creation dates (ISO-8601) by task id, from the corpus the run drew from (plan
   * benchmark-coverage-frontierswe-v2-2026-10-10 D-007). A task the corpus does not date maps to null,
   * and the contamination policy reads it as unknown.
   */
  getTaskCreatedAt?: (taskSetId: string, taskIds: readonly string[]) => Promise<Record<string, string | null>>;
}

/** Default {@link PgReportReaders.getTaskCreatedAt}: the run's task set, loaded the same way the launcher loads it. */
async function taskCreatedAtFromTaskSet(taskSetId: string, taskIds: readonly string[]): Promise<Record<string, string | null>> {
  const { loadBenchTaskSet } = await import('../task-sets');
  const tasks = await loadBenchTaskSet(taskSetId, [...taskIds]);
  const out: Record<string, string | null> = {};
  for (const t of tasks) out[t.instanceId] = t.createdAt ?? null;
  return out;
}

/** Default readers — the real store functions (lazy-imported so a pure-fake test never loads PG). */
async function defaultReaders(scope: { workspace?: string } = {}): Promise<PgReportReaders> {
  const [store, runStore] = await Promise.all([import('../reproducibility/store'), import('../run-store')]);
  const ws: DbScope = scope.workspace ? { workspaceId: scope.workspace } : {};
  return {
    getPrereg: (runId) => store.getPrereg({ runId }, ws),
    listRunResults: (opts) => store.listRunResults({ ...opts, ...ws }) as unknown as Promise<TaskRunResultRow[]>,
    getRollout: (id) => store.getRollout(id, ws) as unknown as Promise<RolloutRow | null>,
    getBenchRunDetail: (id) => runStore.getBenchRunDetail(id, ws) as unknown as Promise<RunDetail | null>,
    getTaskCreatedAt: taskCreatedAtFromTaskSet,
  };
}

function toCoordTrace(detail: RunDetail | null | undefined): BenchReportCoordEvent[] | undefined {
  if (!detail?.coordEvents?.length) return undefined;
  return detail.coordEvents.map((e) => ({
    ts: e.ts != null ? new Date(e.ts).toISOString() : '',
    kind: e.kind ?? 'event',
    from: e.agent,
    summary: e.detail,
    taskId: e.taskId ?? undefined,
  }));
}

function toSpawnTree(detail: RunDetail | null | undefined): BenchReportSpawnNode[] | undefined {
  if (!detail?.perTask?.length) return undefined;
  const nodes = detail.perTask
    .filter((t) => t.cupId)
    .map((t) => ({ spawnId: t.cupId as string, parentSpawnId: null, role: 'cup', taskId: t.instanceId, status: t.stopReason, costUsd: t.costUsd }));
  return nodes.length ? nodes : undefined;
}

/**
 * Build a report bundle for `runId` from the live store. Returns null if the run has no run_result
 * rows. `extraCallLog` lets a caller attach the defineTool call-log when the audit layer can supply it.
 */
export async function buildBundleFromPg(
  runId: string,
  opts: { workspace?: string; readers?: PgReportReaders; extraCallLog?: BenchReportCall[] } = {},
): Promise<BenchReportBundle | null> {
  const readers = opts.readers ?? (await defaultReaders({ workspace: opts.workspace }));
  const [runResults, prereg] = await Promise.all([
    readers.listRunResults({ runId }), readers.getPrereg ? readers.getPrereg(runId) : null,
  ]);
  const assignment = resolveRunReportAssignment(runResults.map(row => ({
    runId: row.runId, suite: row.suite, arm: row.arm, preregHash: row.preregHash ?? '',
    modelId: row.modelId ?? 'unknown', tokensCacheWrite: row.tokensCacheWrite,
  })), prereg);
  if (!runResults.length && !assignment.assignedTaskIds) return null;

  const rolloutIds = Array.from(new Set(runResults.map((r) => r.rolloutId).filter((x): x is string => !!x)));
  const rolloutList = (
    await Promise.all(rolloutIds.map((id) => readers.getRollout(id).catch(() => null)))
  ).filter((r): r is RolloutRow => !!r);

  const detail = readers.getBenchRunDetail ? await readers.getBenchRunDetail(runId).catch(() => null) : null;

  const arms = [...(assignment.assignedArms ?? new Set(runResults.map((r) => r.arm)))];
  const models: Record<string, string> = {};
  if (prereg && Array.isArray(prereg.config.arms)) for (const arm of prereg.config.arms) {
    if (arm && typeof arm === 'object' && typeof arm.id === 'string' && typeof arm.model === 'string') models[arm.id] = arm.model;
  }
  for (const ro of rolloutList) if (!models[ro.arm]) models[ro.arm] = ro.modelId;
  for (const rr of runResults) if (!models[rr.arm] && rr.modelId) models[rr.arm] = rr.modelId;

  // D-007: an undatable corpus (no reader, no task set, a load failure) leaves taskCreatedAt undefined, which the
  // contamination policy reports as 'contamination-unknown' — the honest reading, never a silent 'post-cutoff'.
  const taskIds = [...new Set([...(assignment.assignedTaskIds ?? []), ...runResults.map((r) => r.taskId)])];
  const taskCreatedAt = detail?.taskSetId && readers.getTaskCreatedAt && taskIds.length
    ? await readers.getTaskCreatedAt(detail.taskSetId, taskIds).catch(() => undefined)
    : undefined;

  return bundleFromRollouts({
    taskCreatedAt,
    runId,
    suite: assignment.suite ?? runResults[0].suite,
    createdAt: rolloutList[0]?.createdAt ?? runResults[0]?.createdAt ?? prereg?.createdAt ?? new Date().toISOString(),
    arms,
    models,
    prereg: prereg ? { hash: prereg.preregHash, config: prereg.config, gitCommitSha: prereg.gitCommitSha } : undefined,
    assignedTaskIds: assignment.assignedTaskIds,
    assignedSeeds: assignment.assignedSeeds,
    runResults: runResults.map((rr) => ({
      taskId: rr.taskId,
      arm: rr.arm,
      seed: rr.seed,
      resolved: rr.resolved,
      score: rr.score ?? null,
      graderStatus: rr.graderStatus,
      generationStatus: rr.generationStatus,
      generationError: rr.generationError ?? null,
      stopReason: rr.generationStatus,
      costUsd: rr.costUsd,
      armMeta: rr.armMeta ?? null,
      tokensIn: rr.tokensIn,
      tokensOut: rr.tokensOut,
      tokensTotal: rr.tokensTotal,
      wallClockMs: rr.wallClockMs,
      turns: rr.turns,
      failToPass: rr.failToPass ?? null,
      passToPass: rr.passToPass ?? null,
    })),
    rollouts: rolloutList.map((ro) => ({
      rolloutId: ro.rolloutId,
      taskId: ro.taskId,
      arm: ro.arm,
      seed: ro.seed,
      modelId: ro.modelId,
      modelVersion: ro.modelVersion ?? null,
      harnessVersion: ro.harnessVersion,
      harnessGitSha: ro.harnessGitSha ?? null,
      configSnapshot: ro.configSnapshot ?? null,
      envFingerprint: ro.envFingerprint ?? null,
      rawGraderOutput: ro.rawGraderOutput ?? null,
      submission: ro.submission ?? null,
      trajectoryRef: ro.trajectoryRef ?? null,
      trajectoryKind: ro.trajectoryKind ?? null,
    })),
    coordTrace: toCoordTrace(detail),
    spawnTree: toSpawnTree(detail),
    callLog: opts.extraCallLog,
  });
}

/**
 * Build + write a portable `report-<runId>.html` for a completed run. Best-effort emit primitive:
 * returns the path written, or null if the run has no result rows (nothing to report — e.g. an id that
 * isn't a run_result.run_id). Default out dir: ~/.papercusp/bench-results/reports/.
 */
export async function emitReport(
  runId: string,
  opts: { workspace?: string; outDir?: string; readers?: PgReportReaders; extraCallLog?: BenchReportCall[] } = {},
): Promise<string | null> {
  const bundle = await buildBundleFromPg(runId, opts);
  if (!bundle) return null;
  const dir = opts.outDir ?? papercuspPath('bench-results', 'reports');
  mkdirSync(dir, { recursive: true });
  return writeReportHtml(bundle, join(dir, `report-${runId}.html`));
}

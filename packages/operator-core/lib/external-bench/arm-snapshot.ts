/**
 * arm-snapshot.ts — the PER-TASK-IDEMPOTENT fleet-arm result snapshot writer
 * (benchmark-fairness-fix, Priority 2).
 *
 * The fleet-arm launchers (`_xbench_su_compare.ts`, `_xbench_realqueen_compare.ts`, …) write each arm's
 * run to `<out>/<arm>.json` — a {@link ArmSnapshot} with a `perTask[]` keyed by `instanceId`. The bug the
 * audit found: an isolated `XBENCH_ONLY_IID` rerun (re-run EXACTLY one task) wrote a snapshot holding ONLY
 * that one task and OVERWROTE the whole file, CLOBBERING every sibling task's already-collected result. A
 * per-task rerun must MERGE into the existing snapshot, not replace it — exactly the read-modify-write
 * `run_minisweagent.py:update_preds` does for the mini-swe predictions JSON, and exactly what the PG
 * `upsertBenchRunTask` already does (ON CONFLICT (run_id, instance_id) DO UPDATE) for the live store. This
 * mirrors that idempotency for the FILE snapshot.
 *
 * The merge is pure + unit-tested (no disk in the core); the launchers call {@link writeArmSnapshotMerged},
 * which read-modify-writes the file.
 *
 * MODEL PIN (WI-10008259, R-9): every arm snapshot records the model-registry snapshot its model was resolved
 * from and the evaluated model itself. The write refuses a snapshot without that pin, and a merge refuses to
 * combine two runs pinned to DIFFERENT registry snapshots: a per-task rerun after the registry moved on would
 * otherwise mix results from two models under one arm.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CoordEvent } from '@papercusp/bench-metrics';
import {
  assertModelInSnapshot,
  assertModelRegistrySnapshot,
  type EvaluatedModel,
  type ModelRegistrySnapshot,
} from './model-registry-snapshot';

/** One per-task row in an arm snapshot (the launcher-persisted shape; lenient — additive fields kept). */
export interface ArmSnapshotPerTask {
  instanceId: string;
  cupId?: string | null;
  disposition?: string | null;
  stopReason?: string | null;
  generationError?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  turns?: number | null;
  wallClockMs?: number | null;
  diffBytes?: number | null;
  armMeta?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** The arm-run snapshot the launchers write to `<out>/<arm>.json`. */
export interface ArmSnapshot {
  arm: string;
  runId?: string;
  runError?: string | null;
  startedAt?: string;
  wallMs?: number;
  peakConcurrentBees?: number;
  taskCount?: number;
  nonEmptyDiffs?: number;
  totals?: { costUsd: number; tokensIn: number; tokensOut: number };
  perTask: ArmSnapshotPerTask[];
  coordEvents?: CoordEvent[];
  /** The model-registry snapshot this arm's model was resolved from (R-9). Required by the writer. */
  modelRegistry?: ModelRegistrySnapshot;
  /** The model this arm evaluated, resolved from {@link ArmSnapshot.modelRegistry}. Required by the writer. */
  evaluatedModel?: EvaluatedModel;
  [k: string]: unknown;
}

/**
 * Refuse an arm snapshot that is not pinned to a verified registry snapshot, or whose evaluated model was not
 * resolved from that snapshot. Returns the snapshot unchanged so callers can chain it.
 */
export function assertArmModelPin(snapshot: ArmSnapshot, where = `arm ${snapshot.arm}`): ArmSnapshot {
  const registry = assertModelRegistrySnapshot(snapshot.modelRegistry, where);
  const model = snapshot.evaluatedModel;
  if (!model || typeof model.modelId !== 'string' || !model.modelId) {
    throw new Error(`${where}: arm snapshot has no evaluatedModel; resolve it with pinEvaluatedModel() before writing`);
  }
  if (model.snapshotId !== registry.snapshotId) {
    throw new Error(
      `${where}: evaluatedModel was resolved from registry snapshot ${model.snapshotId}, not the pinned ${registry.snapshotId}`,
    );
  }
  assertModelInSnapshot(model, registry, where);
  return snapshot;
}

/**
 * MERGE a freshly-collected snapshot into an existing one, keyed by `instanceId` — the idempotent
 * read-modify-write (mirrors `update_preds` / the PG `upsertBenchRunTask`).
 *
 * Behavior:
 *  - perTask: union by `instanceId`. A task present in `incoming` REPLACES that task's prior row (the
 *    rerun's result wins for the tasks it re-ran); a task present ONLY in `existing` is PRESERVED untouched
 *    (the sibling-clobber fix). Order is "existing order, then any new instances appended" — stable.
 *  - totals / taskCount / nonEmptyDiffs: RECOMPUTED from the merged perTask set (so the rollup stays
 *    consistent with the merged rows, not the rerun's one-task totals).
 *  - run-level fields (runId/startedAt/wallMs/peakConcurrentBees/coordEvents/runError): taken from
 *    `incoming` (the latest run is authoritative for the whole-run window/trace); when `incoming` omits one,
 *    the prior value is kept.
 *
 * Pure — no disk. {@link writeArmSnapshotMerged} wraps it with the file read/write.
 */
export function mergeArmSnapshot(existing: ArmSnapshot | null, incoming: ArmSnapshot): ArmSnapshot {
  const priorPin = existing?.modelRegistry?.snapshotId;
  const newPin = incoming.modelRegistry?.snapshotId;
  if (priorPin && newPin && priorPin !== newPin) {
    throw new Error(
      `mergeArmSnapshot: arm ${incoming.arm} is pinned to model-registry snapshot ${priorPin}; ` +
        `a rerun resolved against ${newPin} would mix two models in one arm. Rerun with the existing pin or start a new output dir.`,
    );
  }
  const priorModel = existing?.evaluatedModel?.modelId;
  const newModel = incoming.evaluatedModel?.modelId;
  if (priorModel && newModel && priorModel !== newModel) {
    throw new Error(`mergeArmSnapshot: arm ${incoming.arm} evaluated ${priorModel}; a rerun on ${newModel} cannot merge into it`);
  }
  const byId = new Map<string, ArmSnapshotPerTask>();
  for (const t of existing?.perTask ?? []) byId.set(t.instanceId, t);
  for (const t of incoming.perTask) byId.set(t.instanceId, t); // incoming wins for re-run instances

  const perTask = [...byId.values()];
  const totalCost = perTask.reduce((s, t) => s + (t.costUsd || 0), 0);
  const totalTokIn = perTask.reduce((s, t) => s + (t.tokensIn || 0), 0);
  const totalTokOut = perTask.reduce((s, t) => s + (t.tokensOut || 0), 0);
  const nonEmptyDiffs = perTask.filter((t) => (t.diffBytes ?? 0) > 0).length;

  // Run-level fields: prefer incoming (the latest run), fall back to the prior snapshot when omitted.
  const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => (a !== undefined ? a : b);

  return {
    ...existing,
    ...incoming,
    arm: incoming.arm,
    runError: pick(incoming.runError, existing?.runError) ?? null,
    startedAt: pick(incoming.startedAt, existing?.startedAt),
    wallMs: pick(incoming.wallMs, existing?.wallMs),
    peakConcurrentBees: pick(incoming.peakConcurrentBees, existing?.peakConcurrentBees),
    coordEvents: pick(incoming.coordEvents, existing?.coordEvents),
    modelRegistry: pick(incoming.modelRegistry, existing?.modelRegistry),
    evaluatedModel: pick(incoming.evaluatedModel, existing?.evaluatedModel),
    taskCount: perTask.length,
    nonEmptyDiffs,
    totals: { costUsd: totalCost, tokensIn: totalTokIn, tokensOut: totalTokOut },
    perTask,
  };
}

/** Read the existing `<path>` arm snapshot (null if absent/unreadable). */
export function readArmSnapshot(path: string): ArmSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ArmSnapshot;
    if (!parsed || !Array.isArray(parsed.perTask)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * READ-MODIFY-WRITE the arm snapshot at `path`: merge `incoming` into whatever is already on disk (by
 * `instanceId`), then write the merged result. So a `XBENCH_ONLY_IID` rerun updates ONLY its task(s) and
 * leaves every sibling intact — the file mirror of the PG `upsertBenchRunTask` idempotency. Returns the
 * merged snapshot that was written (so the caller can log/print it).
 */
export function writeArmSnapshotMerged(path: string, incoming: ArmSnapshot): ArmSnapshot {
  const merged = assertArmModelPin(mergeArmSnapshot(readArmSnapshot(path), incoming), `${path}`);
  writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

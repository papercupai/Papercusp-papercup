/**
 * FrontierSWE arm-wiring (plan benchmark-suite-frontier-swe-2026-06-18 P-008 + P-010) — the thin glue that
 * plugs FrontierSWE into su-37e53a76's shared topology RUN DRIVER (`runTopology`, run-topology.ts). FrontierSWE
 * supplies only: (1) its task-set (`loadFrontierSweTaskSet`), (2) its `CloneGradeSeam`
 * (`makeFrontierSweCloneGradeSeam`), and (3) the FrontierSWE-stamped row metadata. The driver owns the topology
 * enactment (teams / directives / iso-budget / TaskRunResult emission); we do NOT re-roll it (D-007).
 *
 *   runFrontierSweArm        — one arm × one seed over a task-set → TopologyRunResult (rows).
 *   runFrontierSweResilient  — the P-010 self-healing wrapper: across k seeds, run ONLY the missing
 *                              (task, seed) trials (durable results.jsonl), so an interrupted ultra-long-horizon
 *                              run resumes without redoing completed trials.
 *
 * `runAgent` (the actual in-container agent drive) is INJECTED — fleet-spawn-backed live, a fake in tests — so
 * this wiring is unit-testable with NO Docker / NO fleet / NO spend. The live run itself stays owner-gated
 * (dedicated volume + ghcr + GB pulls + 4–20h/task; 5 tasks need B200/H100) — see FRONTIER-SWE-PILOT.md.
 */
import type { CoordinationSpec, IsoBudget } from './coordination-topology';
import type { AgentRunOutput, EnsembleSelector, RunAgentInput, TopologyRowMeta, TopologyRunResult } from './run-topology';
import { runTopology } from './run-topology';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import type { ProcExec } from './grader/swe-bench-pro';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle } from './frontier-swe-seam';
import { loadFrontierSweTaskSet } from './task-sets';
import type { BenchTask } from './types';
import { appendRunResult, missingTrials, readRunResults } from './frontier-swe-resume';
import { startFrontierSweLaunchAdapter, type FrontierSweLaunchAdapterConfig } from './frontier-swe-launch-adapter';
import {
  buildCampaignBundle, campaignEntriesFromFrontierSweResults, writeCampaignBundle, type CampaignMissing,
} from './reproducibility/campaign-bundle';

const GRADER_FAMILY = 'frontier-swe';
const SUITE = 'frontier-swe';

/** Current protocol arms: the maintained native launch adapter is owned for the whole run.
 * The historical injected runAgent surface below remains for recorded historical arms/tests.
 */
export async function runFrontierSweCurrentArm(
  deps: Omit<FrontierSweArmDeps, 'runAgent' | 'seamExec'> & { launch: FrontierSweLaunchAdapterConfig; backlog?: readonly BenchTask[] },
): Promise<TopologyRunResult> {
  if (!['papercusp', 'baseline'].includes(deps.spec.arm) || deps.launch.runId !== deps.runId) {
    throw new Error('Current FrontierSWE arm requires a supported native arm and its exact run id.');
  }
  const now = deps.now ?? Date.now;
  const backlog = deps.backlog ?? loadFrontierSweTaskSet(deps.taskSetId ?? 'frontier-swe-v2-cpu', deps.taskIds);
  const adapter = await startFrontierSweLaunchAdapter(deps.launch);
  const result: TopologyRunResult = { arm: deps.spec.arm, runId: deps.runId,
    startedAtMs: now(), finishedAtMs: now(), rows: [], modelCallsSpent: 0, tokensSpent: 0, costUsdSpent: 0,
    budgetExhausted: false, attemptedTaskIds: [], skippedTaskIds: [] };
  try {
    // Current protocols freeze caps PER assignment. One shared adapter owns the
    // run; each task gets its own topology pass. The lifetime governor owns the
    // aggregate cap across tasks, seeds and arms.
    for (const task of backlog) {
      if (deps.launch.signal?.aborted) { result.skippedTaskIds.push(task.instanceId); continue; }
      const pass = await runTopology<FrontierSweEnvHandle>({ ...deps, backlog: [task], cap: 1,
        seam: adapter.seam, rowMeta: frontierSweRowMeta(deps.rowMeta), now, runAgent: adapter.runAgent });
      result.rows.push(...pass.rows); result.attemptedTaskIds.push(...pass.attemptedTaskIds);
      result.skippedTaskIds.push(...pass.skippedTaskIds); result.modelCallsSpent += pass.modelCallsSpent;
      result.tokensSpent += pass.tokensSpent; result.costUsdSpent += pass.costUsdSpent;
      result.budgetExhausted ||= pass.budgetExhausted;
    }
    result.finishedAtMs = now();
    return result;
  } finally {
    const report = await adapter.stop();
    if (report.errors.length) throw new Error(`FrontierSWE run cleanup incomplete: ${report.errors.join('; ')}`);
  }
}

/** The FrontierSWE-specific run-level row metadata (the rest comes from the caller for pre-registration). */
export interface FrontierSweRowMetaInput {
  /** Grader version pin (repo commit / image-set tag). */
  version: string;
  modelId: string;
  harnessVersion: string;
  preregHash: string;
  rolloutId: string;
  priceTableVersion?: string;
}

export function frontierSweRowMeta(m: FrontierSweRowMetaInput): TopologyRowMeta {
  return {
    suite: SUITE,
    modelId: m.modelId,
    harnessVersion: m.harnessVersion,
    preregHash: m.preregHash,
    rolloutId: m.rolloutId,
    graderFamily: GRADER_FAMILY,
    graderVersion: m.version,
    priceTableVersion: m.priceTableVersion ?? 'price-table-v1',
  };
}

export interface FrontierSweArmDeps {
  /** The topology arm's coordination spec (caller resolves it from a blueprint via resolveCoordinationSpec). */
  spec: CoordinationSpec;
  /** Task-set id (default 'frontier-swe-cpu' — the GPU-free subset runnable without B200/H100). */
  taskSetId?: string;
  taskIds?: string[];
  /** The actual agent invocation — INJECTED. Live: a fleet-spawn-backed drive of an agent INSIDE the task
   *  container (docker exec) routed through the inference gateway. Fake in tests. */
  runAgent: (input: RunAgentInput<FrontierSweEnvHandle>) => Promise<AgentRunOutput>;
  /** The iso-budget cap applied UNIFORMLY across arms (C3) — incl. maxWallMs (load-bearing for 4–20h tasks). */
  budget: IsoBudget;
  seed: number;
  runId: string;
  rowMeta: FrontierSweRowMetaInput;
  cap?: number;
  ensembleSize?: number;
  /** Required for an ensemble (aggregate:'judge-best') spec; runTopology refuses without it. */
  ensembleSelector?: EnsembleSelector;
  now?: () => number;
  onResult?: (r: TaskRunResult) => void | Promise<void>;
  /** Inject a fake docker exec in tests; live defaults to the seam's shell-free execFile binding. */
  seamExec?: ProcExec;
}

/** Run ONE FrontierSWE topology arm × one seed over a task-set. Thin: builds the seam + rowMeta, calls runTopology. */
export function runFrontierSweArm(deps: FrontierSweArmDeps): Promise<TopologyRunResult> {
  if (deps.spec.arm === 'papercusp') {
    throw new Error('The current Papercusp FrontierSWE arm requires runFrontierSweCurrentArm; legacy runAgent injection is retired.');
  }
  const backlog = loadFrontierSweTaskSet(deps.taskSetId ?? 'frontier-swe-cpu', deps.taskIds);
  const seam = makeFrontierSweCloneGradeSeam({ version: deps.rowMeta.version, exec: deps.seamExec });
  return runTopology<FrontierSweEnvHandle>({
    spec: deps.spec,
    backlog,
    seam,
    budget: deps.budget,
    rowMeta: frontierSweRowMeta(deps.rowMeta),
    runId: deps.runId,
    seed: deps.seed,
    now: deps.now ?? (() => Date.now()),
    runAgent: deps.runAgent,
    cap: deps.cap,
    ensembleSize: deps.ensembleSize,
    ensembleSelector: deps.ensembleSelector,
    onResult: deps.onResult,
  });
}

export interface FrontierSweResilientDeps extends Omit<FrontierSweArmDeps, 'seed' | 'runId' | 'onResult'> {
  /** Trials per task (the FrontierSWE protocol = 5). */
  k: number;
  /** Durable per-task results.jsonl — read on start (skip done trials), appended as each row settles. */
  resultsPath: string;
  /** Base run id; each seed runs as `${runIdBase}-seed<N>`. */
  runIdBase: string;
  /** Optional extra per-row hook (the durable append is automatic). */
  onResult?: (r: TaskRunResult) => void | Promise<void>;
  /** P-022 / D-010: where each completed campaign pass writes its dated bundle
   *  (`<bundleDir>/benchmarks/campaigns/<UTC date>-<campaignId>/`). */
  bundleDir: string;
  /** Bundle campaign id (default `runIdBase`). */
  campaignId?: string;
}

/** The dated bundle a campaign pass wrote, with its completeness verdict (D-009 item 3). */
export interface FrontierSweCampaignBundleResult {
  root: string;
  complete: boolean;
  missing: CampaignMissing[];
  /** Repo-relative paths written under `bundleDir`. */
  written: string[];
}

/**
 * P-010 self-healing wrapper: run the FrontierSWE arm across `k` seeds, executing ONLY the (task, seed) trials
 * still missing from `resultsPath` (an infra row from a prior run is re-run; a scored row is skipped). Every
 * settled row is durably appended, so an interrupted ultra-long-horizon run resumes where it left off. Returns
 * the per-seed driver results + whether everything was already complete (a no-op resume).
 */
export async function runFrontierSweResilient(
  deps: FrontierSweResilientDeps,
): Promise<{ perSeed: TopologyRunResult[]; rows: TaskRunResult[]; alreadyComplete: boolean; bundle: FrontierSweCampaignBundleResult }> {
  const backlog = loadFrontierSweTaskSet(deps.taskSetId ?? 'frontier-swe-cpu', deps.taskIds);
  const allIds = backlog.map((t) => t.instanceId);
  const arm = deps.spec.arm;
  const existing = readRunResults(deps.resultsPath);

  // Invert missingTrials (per-task → missing seeds) into per-seed → missing taskIds.
  const tasksForSeed = new Map<number, string[]>();
  for (const { instanceId, seeds } of missingTrials(allIds, deps.k, existing, arm)) {
    for (const s of seeds) {
      const arr = tasksForSeed.get(s) ?? [];
      arr.push(instanceId);
      tasksForSeed.set(s, arr);
    }
  }

  const perSeed: TopologyRunResult[] = [];
  const rows: TaskRunResult[] = [];
  for (let s = 0; s < deps.k; s++) {
    const ids = tasksForSeed.get(s);
    if (!ids || ids.length === 0) continue; // this seed already complete
    const res = await runFrontierSweArm({
      spec: deps.spec,
      taskSetId: 'frontier-swe-custom',
      taskIds: ids,
      runAgent: deps.runAgent,
      budget: deps.budget,
      seed: s,
      runId: `${deps.runIdBase}-seed${s}`,
      rowMeta: deps.rowMeta,
      cap: deps.cap,
      ensembleSize: deps.ensembleSize,
      now: deps.now,
      seamExec: deps.seamExec,
      onResult: async (r) => {
        appendRunResult(deps.resultsPath, {
          instanceId: r.taskId,
          seed: r.seed,
          arm: r.arm,
          score: r.score ?? null,
          resolved: r.resolved,
          graderStatus: r.graderStatus,
          ...(r.graderDetail !== undefined ? { graderDetail: r.graderDetail } : {}),
          ...(r.traceRefs && r.traceRefs.length > 0 ? { traceRefs: r.traceRefs } : {}),
        });
        rows.push(r);
        await deps.onResult?.(r);
      },
    });
    perSeed.push(res);
  }

  // P-022 / D-010: the campaign pass is complete — write its dated bundle from the FULL durable record (latest row
  // per attempt, so a resumed campaign's earlier trials are included). Gaps stay visible in the manifest.
  const entries = campaignEntriesFromFrontierSweResults(readRunResults(deps.resultsPath), SUITE, arm);
  const built = buildCampaignBundle({
    campaignId: deps.campaignId ?? deps.runIdBase,
    completedAt: new Date((deps.now ?? Date.now)()),
    entries,
  });
  const written = writeCampaignBundle(built, deps.bundleDir);
  const bundle = { root: built.root, complete: built.manifest.complete, missing: built.manifest.missing, written };
  return { perSeed, rows, alreadyComplete: perSeed.length === 0, bundle };
}

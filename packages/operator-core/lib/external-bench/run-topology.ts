/**
 * run-topology — THE RUN DRIVER for the coordination-TOPOLOGY benchmark study
 * (benchmark-coordination-topologies). It enacts a {@link CoordinationSpec} over a backlog under one
 * shared iso-budget and emits `@papercusp/bench-metrics` {@link TaskRunResult} rows — the same row
 * contract every consumer (su-a2b66 SWE-Pro / su-7e0d2 FrontierSWE) reports through
 * buildCapabilityAttribution + buildFairnessAudit.
 *
 * The driver is the GLUE between three pieces that already exist:
 *   - {@link coordinationSpawnPlans} (coordination-runtime) — spec + backlog → per-team spawn plans
 *     (which tasks a team owns + the worker DIRECTIVE + the forbidden coord/* tools).
 *   - {@link CloneGradeSeam} (coordination-topology) — the per-BENCHMARK clone/grade (C5: identical
 *     across arms). The driver NEVER authors clone/grade — it calls the consumer's seam.
 *   - {@link RunAgentInput}/{@link AgentRunOutput} ({@link TopologyRunDeps.runAgent}) — the actual agent
 *     invocation, INJECTED so the driver's orchestration logic is unit-testable with a fake agent + a
 *     fake seam. The live path supplies a runAgent backed by cup:spawn.
 *
 * Topology shapes the driver runs (all from the one spec):
 *   - distributed / huddle / central (team:per-backlog|per-repo, aggregate:none) → ONE worker per task,
 *     carrying its team's coordination directive (the agents enact broadcast/blackboard/peer-review
 *     themselves via their coord/* tools). N concurrent workers = the bounded pool.
 *   - ensemble (aggregate:'judge-best') → N INDEPENDENT solvers per task (each its own clone), then a
 *     judge picks the best; the picked solver's environment is graded.
 *   - pair (team:per-task, review:'peer') → a driver + a navigator collaborate on ONE clone → one graded
 *     attempt; both agents' usage is summed.
 *
 * FAIRNESS (C1 same-denominator): the driver emits rows ONLY for tasks it actually ran. Tasks skipped
 * because the iso-budget was exhausted get NO row — buildCapabilityAttribution counts a task with no
 * row as `false` under its default sameDenominator policy (capability-attribution.ts §"NO row → false"),
 * so a less-efficient arm that completes fewer tasks is correctly penalised, never flattered by
 * exclusion. The skipped ids are reported on {@link TopologyRunResult.skippedTaskIds} for the C6
 * coverage table; the report's task UNIVERSE is the full backlog.
 */
import {
  mergeCapabilityEvidence, readCapabilityEvidence, withCapabilityEvidence,
  type BenchSuite, type CapabilityExerciseEvidence, type GenerationStatus, type GraderStatus, type TaskRunResult,
} from '@papercusp/bench-metrics';
import type { CloneGradeSeam, CoordinationSpec, IsoBudget } from './coordination-topology';
import { coordinationSpawnPlans, leadDirective, teamTopic, type TeamSpawnPlan } from './coordination-runtime';
import type { BenchTask } from './types';

/** The role an agent plays in a topology. `worker` = a plain distributed/huddle/central bee; `solver`/
 *  `judge` = ensemble; `driver`/`navigator` = pair. The live runAgent uses it to pick the spawn persona. */
export type TopologyRole = 'worker' | 'solver' | 'judge' | 'driver' | 'navigator' | 'lead';

/** What the driver hands the (injected) agent invocation per attempt. */
export interface RunAgentInput<H = unknown> {
  task: BenchTask;
  /** The prepared environment this agent works in (worktree for `diff`, container for `in-container`). */
  handle: H;
  role: TopologyRole;
  arm: string;
  teamKey: string;
  /** The team's broadcast/blackboard topic (distributed arms publish findings here). */
  topic: string;
  /** Coordination instructions injected into the agent prompt (from {@link coordinationDirective}). */
  directive: string;
  /** coord/* tools this agent may NOT use (e.g. ['coord:send'] enforces blackboard-only). */
  forbidTools: string[];
  /** The remaining iso-budget headroom (advisory ceiling for this attempt; the live runAgent enforces). */
  attemptBudget: IsoBudget;
  /** Judge/navigator only: the candidate submissions to choose among / review. */
  candidates?: Array<{ index: number; submission: unknown }>;
}

/** The usage an agent run reports — summed into the run's iso-budget spend. */
export interface AgentRunUsage {
  /** Model invocations (the iso-budget PRIMARY axis — owner chose model-call count). */
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** When present, these are separate from tokensIn (which is uncached input). */
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costUsd: number;
  /** Agent steps / turns (→ TaskRunResult.turns). */
  turns: number;
}

/** What the (injected) agent invocation returns. */
export interface AgentRunOutput extends AgentRunUsage {
  /** Opaque submission handed to the seam / the judge (a diff string, a container marker, …). */
  submission: unknown;
  /** GENERATION outcome — 'completed' = produced a submission (graded normally); error/timeout = infra. */
  status: GenerationStatus;
  /** Did this attempt terminate at its budget ceiling? (a capped attempt ≠ a genuine fail). */
  capped?: boolean;
  /** Judge only: which candidate index it picked (the winning solver). */
  pickIndex?: number;
  /**
   * C4 EVIDENCE — the count of COORDINATION tool calls this agent actually made (coord:send / topic
   * broadcast / peer-review ask / work_items:claim_next / blackboard write — whatever the topology uses).
   * The runAgent reports it from telemetry. The driver sums it per task onto `armMeta.coordCalls` so the
   * fairness audit can FLAG a coordination arm whose agents never coordinated (`coordCalls ≈ 0`) — then the
   * topology was NOT exercised and any "delta" is variance, not capability (the C4 trap that sank a peer's
   * tau2 +memory "lift": a discretionary capability the agent simply never invoked). A `worker` in a
   * central/no-coord arm legitimately reports 0. */
  coordCalls?: number;
  /** Native driver identity, accounting and context evidence, retained on the result row. */
  armMeta?: Record<string, unknown>;
  error?: string | null;
  /**
   * P-022 / D-010: pointer to THIS agent run's transcript (e.g. its session JSONL path), reported by the live
   * runAgent. The driver collects every contributing run's pointer onto `TaskRunResult.traceRefs` (graded agent
   * first) so a campaign bundle holds each task's trace. Absent = not captured: the bundle shows the gap, never
   * an invented pointer.
   */
  traceRef?: string | null;
  /**
   * BM-P-004-exercise-evidence: this agent's observed capability availability / delivery / use, from its
   * telemetry. The driver merges every contributing agent's list per task onto `armMeta.capabilityEvidence`
   * (mergeCapabilityEvidence: an unreported contributor makes that count unknown). Absent = unmeasured,
   * never zero.
   */
  capabilityEvidence?: CapabilityExerciseEvidence[] | null;
  /**
   * benchmark-coverage-frontierswe-v2 D-033: the execution path that ran this agent (the live FrontierSWE
   * Papercusp arm reports 'modernization-launch-adapter'). The driver stamps the distinct reported values on
   * `armMeta.executionPath` via {@link withExecutionPath}. Absent = unreported, never inferred.
   */
  executionPath?: string | null;
}

/**
 * D-033: stamp the execution paths that contributing agents reported onto a row's armMeta, merged with any the
 * row already carries. One distinct value is stamped as a string, several as an array. When at least one agent
 * reported, `executionPathUnreported` counts the contributors that did not, so a partial report never reads as a
 * uniform one. When none reported, armMeta is returned without either key.
 */
export function withExecutionPath(
  armMeta: Record<string, unknown>,
  outputs: ReadonlyArray<Pick<AgentRunOutput, 'executionPath'>>,
): Record<string, unknown> {
  const { executionPath: prior, executionPathUnreported: priorUnreported, ...rest } = armMeta;
  const isPath = (p: unknown): p is string => typeof p === 'string' && p.length > 0;
  const reported = [
    ...(isPath(prior) ? [prior] : Array.isArray(prior) ? prior.filter(isPath) : []),
    ...outputs.map((o) => o.executionPath).filter(isPath),
  ];
  const unreported = (typeof priorUnreported === 'number' ? priorUnreported : 0)
    + outputs.filter((o) => !isPath(o.executionPath)).length;
  const distinct = [...new Set(reported)];
  if (distinct.length === 0) return armMeta;
  return {
    ...rest,
    executionPath: distinct.length === 1 ? distinct[0] : distinct,
    ...(unreported > 0 ? { executionPathUnreported: unreported } : {}),
  };
}

/** The declared ensemble selector (frozen in the protocol as `control.ensemble.selector`). */
export interface EnsembleSelector {
  id: string;
  kind: 'judge-agent' | 'visible-test-verifier';
}

/**
 * How the graded ensemble candidate was chosen, stamped on `armMeta.selector`. `declared-fallback` is the
 * frozen `onUnavailable: 'first-candidate'` policy, used when the selector could not run or returned no
 * valid candidate; `reason` says which.
 */
export interface EnsembleSelectorReceipt extends EnsembleSelector {
  via: 'judge' | 'sole-candidate' | 'declared-fallback';
  pickIndex: number;
  candidateIndices: number[];
  reason?: string;
}

/** Keep only real trace pointers, in order (a run that captured none contributes nothing). */
function traceList(refs: ReadonlyArray<string | null | undefined>): string[] {
  return refs.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
}

/** The fixed, run-level row fields the driver stamps onto EVERY {@link TaskRunResult} (not per-task). */
export interface TopologyRowMeta {
  suite: BenchSuite;
  modelId: string;
  /** Blueprint version + git sha of the topology harness. */
  harnessVersion: string;
  preregHash: string;
  rolloutId: string;
  graderFamily: string;
  graderVersion: string;
  priceTableVersion: string;
}

/** Deps for {@link runTopology}. */
export interface TopologyRunDeps<H = unknown> {
  spec: CoordinationSpec;
  backlog: readonly BenchTask[];
  seam: CloneGradeSeam<H>;
  /** The iso-budget cap applied UNIFORMLY across every arm (C3). */
  budget: IsoBudget;
  rowMeta: TopologyRowMeta;
  runId: string;
  /** Independent-attempt ordinal stamped on every row (≥3 distinct per task×arm across runs). */
  seed: number;
  now: () => number;
  /** The actual agent invocation — INJECTED (fake in tests; cup:spawn-backed live). */
  runAgent: (input: RunAgentInput<H>) => Promise<AgentRunOutput>;
  /** Concurrent task-units in flight; default 2 (the benchmark's task-concurrency cap). */
  cap?: number;
  /** N independent solvers per ensemble task (aggregate:'judge-best'); default 3. */
  ensembleSize?: number;
  /** REQUIRED when `spec.aggregate` is 'judge-best': there is no implicit, unreceipted candidate pick. */
  ensembleSelector?: EnsembleSelector;
  /** Fired the instant each row settles → durability (a partial/killed run still banks its rows). */
  onResult?: (r: TaskRunResult) => void | Promise<void>;
}

/** The driver's run-level result. `rows` are the emitted {@link TaskRunResult}s; `skippedTaskIds` are
 *  tasks the iso-budget couldn't reach (counted `false` under same-denominator at report time). */
export interface TopologyRunResult {
  arm: string;
  runId: string;
  startedAtMs: number;
  finishedAtMs: number;
  rows: TaskRunResult[];
  modelCallsSpent: number;
  tokensSpent: number;
  costUsdSpent: number;
  /** True if any iso-budget dimension was reached (so some tasks went un-attempted). */
  budgetExhausted: boolean;
  attemptedTaskIds: string[];
  skippedTaskIds: string[];
}

// `satisfies Record<GraderStatus, true>` forces this list to grow with the union: a canonical status
// missing here would coerce to 'error' and lose its meaning (e.g. 'invalid' — D-008 of plan
// benchmark-coverage-frontierswe-v2-2026-10-10 — would persist indistinguishable from a grader fault).
const GRADER_STATUS_SET = { passed: true, failed: true, error: true, timeout: true, invalid: true } satisfies Record<GraderStatus, true>;
const GRADER_STATUSES = Object.keys(GRADER_STATUS_SET) as readonly GraderStatus[];
function coerceGraderStatus(s: string): GraderStatus {
  return (GRADER_STATUSES as readonly string[]).includes(s) ? (s as GraderStatus) : 'error';
}

/**
 * Run a coordination topology over a backlog under one iso-budget; emit one {@link TaskRunResult} per
 * attempted task. Once running it never throws (a per-task failure lands an infra-error row; the seam
 * teardown always runs); the only throw is a configuration refusal before any spend. The iso-budget is a
 * HARD ceiling checked before each task-unit dispatches — with concurrency
 * `cap`, at most `cap` units may be in flight when the budget is hit (a bounded ≤cap overshoot, since a
 * unit's model-call cost is only known after it runs).
 */
export async function runTopology<H = unknown>(deps: TopologyRunDeps<H>): Promise<TopologyRunResult> {
  const { spec, seam, budget, rowMeta, now } = deps;
  if (spec.aggregate === 'judge-best' && !deps.ensembleSelector) {
    throw new Error(`runTopology: ensemble arm ${spec.arm} requires a declared ensembleSelector; refusing before any spend.`);
  }
  const cap = Math.max(1, deps.cap ?? 2);
  const ensembleSize = Math.max(1, deps.ensembleSize ?? 3);
  const startedAtMs = now();

  const spent = { calls: 0, tokens: 0, costUsd: 0 };
  const addUsage = (u: AgentRunUsage): void => {
    spent.calls += u.modelCalls;
    spent.tokens += u.tokensIn + u.tokensOut + (u.tokensCacheRead ?? 0) + (u.tokensCacheWrite ?? 0);
    spent.costUsd += u.costUsd;
  };
  const exhausted = (): boolean => {
    if (budget.maxModelCalls != null && spent.calls >= budget.maxModelCalls) return true;
    if (budget.maxTokens != null && spent.tokens >= budget.maxTokens) return true;
    if (budget.maxCostUsd != null && spent.costUsd >= budget.maxCostUsd) return true;
    if (budget.maxWallMs != null && now() - startedAtMs >= budget.maxWallMs) return true;
    return false;
  };
  const remaining = (): IsoBudget => ({
    maxModelCalls: budget.maxModelCalls != null ? Math.max(0, budget.maxModelCalls - spent.calls) : undefined,
    maxTokens: budget.maxTokens != null ? Math.max(0, budget.maxTokens - spent.tokens) : undefined,
    maxCostUsd: budget.maxCostUsd != null ? Math.max(0, budget.maxCostUsd - spent.costUsd) : undefined,
    maxWallMs: budget.maxWallMs != null ? Math.max(0, budget.maxWallMs - (now() - startedAtMs)) : undefined,
  });

  // ── row builder ────────────────────────────────────────────────────────────
  const buildRow = (args: {
    task: BenchTask;
    usage: AgentRunUsage;
    grade: { resolved: boolean | null; score?: number | null; graderStatus: string; detail?: unknown };
    status: GenerationStatus;
    capped: boolean;
    generationError?: string | null;
    wallClockMs: number;
    armMeta?: Record<string, unknown> | null;
    /** Contributing agent runs' trace pointers, graded agent first (P-022 / D-010). */
    traceRefs?: ReadonlyArray<string | null | undefined>;
  }): TaskRunResult => ({
    runId: deps.runId,
    suite: rowMeta.suite,
    modality: seam.modality,
    taskId: args.task.instanceId,
    arm: spec.arm,
    seed: deps.seed,
    resolved: args.grade.resolved,
    graderStatus: coerceGraderStatus(args.grade.graderStatus),
    graderFamily: rowMeta.graderFamily,
    graderVersion: rowMeta.graderVersion,
    score: args.grade.score ?? null,
    // P-022 / D-009: keep the seam's scorer output (e.g. the D-008 integrity verdict) for campaign bundles.
    ...(args.grade.detail !== undefined ? { graderDetail: args.grade.detail } : {}),
    ...(traceList(args.traceRefs ?? []).length > 0 ? { traceRefs: traceList(args.traceRefs ?? []) } : {}),
    tokensIn: args.usage.tokensIn,
    tokensOut: args.usage.tokensOut,
    tokensTotal: args.usage.tokensIn + args.usage.tokensOut + (args.usage.tokensCacheRead ?? 0) + (args.usage.tokensCacheWrite ?? 0),
    ...(args.usage.tokensCacheRead !== undefined ? { tokensCacheRead: args.usage.tokensCacheRead } : {}),
    ...(args.usage.tokensCacheWrite !== undefined ? { tokensCacheWrite: args.usage.tokensCacheWrite } : {}),
    costUsd: args.usage.costUsd,
    priceTableVersion: rowMeta.priceTableVersion,
    wallClockMs: args.wallClockMs,
    turns: args.usage.turns,
    budgetTokens: budget.maxTokens ?? null,
    capped: args.capped,
    generationStatus: args.status,
    generationError: args.generationError ?? null,
    armMeta: args.armMeta ?? null,
    modelId: rowMeta.modelId,
    harnessVersion: rowMeta.harnessVersion,
    preregHash: rowMeta.preregHash,
    rolloutId: rowMeta.rolloutId,
    createdAt: new Date(now()).toISOString(),
  });

  const infraGrade = { resolved: null as boolean | null, graderStatus: 'error', score: null as number | null };
  const ZERO: AgentRunUsage = { modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 };
  const sumUsage = (a: AgentRunUsage, b: AgentRunUsage): AgentRunUsage => ({
    modelCalls: a.modelCalls + b.modelCalls,
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    ...(a.tokensCacheRead !== undefined || b.tokensCacheRead !== undefined
      ? { tokensCacheRead: (a.tokensCacheRead ?? 0) + (b.tokensCacheRead ?? 0) } : {}),
    ...(a.tokensCacheWrite !== undefined || b.tokensCacheWrite !== undefined
      ? { tokensCacheWrite: (a.tokensCacheWrite ?? 0) + (b.tokensCacheWrite ?? 0) } : {}),
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
  });
  /** Attach the merged capability evidence of every agent that ran for this task unit. */
  const withEvidence = (armMeta: Record<string, unknown>, outputs: ReadonlyArray<AgentRunOutput>) =>
    withExecutionPath(withCapabilityEvidence({
      ...(outputs.length === 1 ? outputs[0].armMeta :
        outputs.some(output => output.armMeta) ? { agentExecutions: outputs.map(output => output.armMeta ?? null) } : {}),
      ...armMeta,
    }, mergeCapabilityEvidence(outputs.map((o) => o.capabilityEvidence))) ?? armMeta, outputs);

  // ── per-topology task execution ──────────────────────────────────────────────
  /** distributed / huddle / central: ONE worker per task carrying its team's coordination directive. */
  async function runWorker(task: BenchTask, plan: TeamSpawnPlan, unitStart: number): Promise<TaskRunResult> {
    let handle: H | undefined;
    try {
      handle = await seam.clone(task);
    } catch (e) {
      return buildRow({ task, usage: ZERO, grade: infraGrade, status: 'error', capped: false, generationError: `clone: ${errMsg(e)}`, wallClockMs: now() - unitStart });
    }
    try {
      const out = await deps.runAgent({
        task, handle, role: 'worker', arm: spec.arm, teamKey: plan.teamKey,
        topic: teamTopic(spec, plan.teamKey), directive: plan.directive, forbidTools: plan.forbidTools,
        attemptBudget: remaining(),
      });
      addUsage(out);
      const grade = out.status === 'completed' ? await seam.grade(task, handle) : infraGrade;
      return buildRow({ task, usage: out, grade, status: out.status, capped: !!out.capped, generationError: out.error, wallClockMs: now() - unitStart, traceRefs: [out.traceRef], armMeta: withEvidence({ coordCalls: out.coordCalls ?? 0 }, [out]) });
    } finally {
      await safeTeardown(handle);
    }
  }

  /** ensemble: N independent solvers (each its own clone), then a judge picks the best → grade it. */
  async function runEnsemble(task: BenchTask, plan: TeamSpawnPlan, unitStart: number): Promise<TaskRunResult> {
    const handles: H[] = [];
    const candidates: Array<{ index: number; submission: unknown }> = [];
    /** Solver trace pointers, indexed like `handles` (P-022 / D-010). */
    const solverTraces: Array<string | null | undefined> = [];
    /** Every agent that ran for this task (solvers, then the selector) — the evidence contributors. */
    const outputs: AgentRunOutput[] = [];
    const selector = deps.ensembleSelector!;
    let usage = ZERO;
    let coordCalls = 0;
    try {
      for (let i = 0; i < ensembleSize; i++) {
        if (i > 0 && exhausted()) break; // always run at least one solver; stop spending past the cap
        let h: H;
        try {
          h = await seam.clone(task);
        } catch {
          continue; // a failed clone drops that solver; the ensemble proceeds with the rest
        }
        handles.push(h);
        const out = await deps.runAgent({
          task, handle: h, role: 'solver', arm: spec.arm, teamKey: plan.teamKey,
          topic: teamTopic(spec, plan.teamKey), directive: plan.directive, forbidTools: plan.forbidTools,
          attemptBudget: remaining(),
        });
        addUsage(out); usage = sumUsage(usage, out); coordCalls += out.coordCalls ?? 0;
        outputs.push(out);
        solverTraces[handles.length - 1] = out.traceRef;
        if (out.status === 'completed') candidates.push({ index: handles.length - 1, submission: out.submission });
      }

      if (candidates.length === 0) {
        return buildRow({ task, usage, grade: infraGrade, status: 'error', capped: false, generationError: 'ensemble: no solver produced a submission', wallClockMs: now() - unitStart, traceRefs: solverTraces, armMeta: withEvidence({ ensembleSize, solvers: handles.length, coordCalls }, outputs) });
      }

      const candidateIndices = candidates.map((c) => c.index);
      const fallback = (reason: string): EnsembleSelectorReceipt =>
        ({ ...selector, via: 'declared-fallback', pickIndex: candidateIndices[0], candidateIndices, reason });
      let receipt: EnsembleSelectorReceipt;
      let judgeTrace: string | null | undefined;
      if (candidates.length === 1) {
        receipt = { ...selector, via: 'sole-candidate', pickIndex: candidateIndices[0], candidateIndices };
      } else if (exhausted()) {
        receipt = fallback('budget exhausted before selection');
      } else {
        const judge = await deps.runAgent({
          task, handle: handles[candidateIndices[0]], role: 'judge', arm: spec.arm, teamKey: plan.teamKey,
          topic: teamTopic(spec, plan.teamKey), directive: plan.directive, forbidTools: plan.forbidTools,
          attemptBudget: remaining(), candidates,
        });
        addUsage(judge); usage = sumUsage(usage, judge); coordCalls += judge.coordCalls ?? 0;
        outputs.push(judge);
        judgeTrace = judge.traceRef;
        receipt = judge.status !== 'completed' ? fallback(`selector ${judge.status}`)
          : judge.pickIndex == null ? fallback('selector returned no pick')
          : !candidateIndices.includes(judge.pickIndex) ? fallback(`selector picked non-candidate ${judge.pickIndex}`)
          : { ...selector, via: 'judge', pickIndex: judge.pickIndex, candidateIndices };
      }
      const pickIndex = receipt.pickIndex;
      const grade = await seam.grade(task, handles[pickIndex]);
      // Graded solver first, then the other solvers in order, then the judge.
      const traceRefs = [solverTraces[pickIndex], ...solverTraces.filter((_, i) => i !== pickIndex), judgeTrace];
      return buildRow({ task, usage, grade, status: 'completed', capped: exhausted(), wallClockMs: now() - unitStart, traceRefs, armMeta: withEvidence({ ensembleSize, solvers: handles.length, candidates: candidates.length, pickIndex, coordCalls, selector: receipt }, outputs) });
    } finally {
      for (const h of handles) await safeTeardown(h);
    }
  }

  /** pair: a driver + a navigator collaborate on ONE clone → one graded attempt; usage summed. */
  async function runPair(task: BenchTask, plan: TeamSpawnPlan, unitStart: number): Promise<TaskRunResult> {
    let handle: H | undefined;
    try {
      handle = await seam.clone(task);
    } catch (e) {
      return buildRow({ task, usage: ZERO, grade: infraGrade, status: 'error', capped: false, generationError: `clone: ${errMsg(e)}`, wallClockMs: now() - unitStart });
    }
    try {
      const drv = await deps.runAgent({
        task, handle, role: 'driver', arm: spec.arm, teamKey: plan.teamKey,
        topic: teamTopic(spec, plan.teamKey), directive: plan.directive, forbidTools: plan.forbidTools,
        attemptBudget: remaining(),
      });
      addUsage(drv);
      let usage = drv as AgentRunUsage;
      let coordCalls = drv.coordCalls ?? 0;
      let navTrace: string | null | undefined;
      const outputs: AgentRunOutput[] = [drv];
      if (drv.status === 'completed' && !exhausted()) {
        const nav = await deps.runAgent({
          task, handle, role: 'navigator', arm: spec.arm, teamKey: plan.teamKey,
          topic: teamTopic(spec, plan.teamKey), directive: plan.directive, forbidTools: plan.forbidTools,
          attemptBudget: remaining(), candidates: [{ index: 0, submission: drv.submission }],
        });
        addUsage(nav); usage = sumUsage(usage, nav); coordCalls += nav.coordCalls ?? 0;
        outputs.push(nav);
        navTrace = nav.traceRef;
      }
      const grade = drv.status === 'completed' ? await seam.grade(task, handle) : infraGrade;
      return buildRow({ task, usage, grade, status: drv.status, capped: !!drv.capped || exhausted(), generationError: drv.error, wallClockMs: now() - unitStart, traceRefs: [drv.traceRef, navTrace], armMeta: withEvidence({ pair: true, coordCalls }, outputs) });
    } finally {
      await safeTeardown(handle);
    }
  }

  async function safeTeardown(h: H | undefined): Promise<void> {
    if (h === undefined) return;
    try { await seam.teardown(h); } catch { /* never-throw teardown */ }
  }

  function runUnit(task: BenchTask, plan: TeamSpawnPlan): Promise<TaskRunResult> {
    if (spec.aggregate === 'judge-best') return runEnsemble(task, plan, now());
    if (spec.team === 'per-task' && spec.review === 'peer') return runPair(task, plan, now());
    return runWorker(task, plan, now());
  }

  // ── the bounded budget-gated pool: drain a unit list, decorate + collect each row ──
  const rows: TaskRunResult[] = [];
  const attemptedTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];

  const drainUnits = async (
    units: Array<{ task: BenchTask; plan: TeamSpawnPlan }>,
    decorate: (r: TaskRunResult) => TaskRunResult,
  ): Promise<void> => {
    let cursor = 0;
    const poolWorker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= units.length) return;
        const { task, plan } = units[i];
        if (exhausted()) { skippedTaskIds.push(task.instanceId); continue; }
        attemptedTaskIds.push(task.instanceId);
        let row: TaskRunResult;
        try {
          row = await runUnit(task, plan);
        } catch (e) {
          row = buildRow({ task, usage: ZERO, grade: infraGrade, status: 'error', capped: false, generationError: errMsg(e), wallClockMs: 0 });
        }
        row = decorate(row);
        rows.push(row);
        await Promise.resolve(deps.onResult?.(row)).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, units.length || 1)) }, poolWorker));
  };

  const identity = (r: TaskRunResult): TaskRunResult => r;

  if (spec.coordinator === 'elected-lead') {
    // HIERARCHICAL: per team, a LEAD runs ONE coordination pass (charged to the iso-budget), then the
    // workers execute under it. The lead's coordCalls are attached to the team's rows as `leadCoordCalls`
    // (the C4 evidence that the in-team coordinator actually coordinated).
    for (const plan of coordinationSpawnPlans(spec, deps.backlog)) {
      let leadCoordCalls = 0;
      let leadTrace: string | null | undefined;
      let leadOutput: AgentRunOutput | undefined;
      if (!exhausted() && plan.tasks.length > 0) {
        let leadHandle: H | undefined;
        try { leadHandle = await seam.clone(plan.tasks[0]); } catch { leadHandle = undefined; }
        if (leadHandle !== undefined) {
          try {
            const lead = await deps.runAgent({
              task: plan.tasks[0], handle: leadHandle, role: 'lead', arm: spec.arm, teamKey: plan.teamKey,
              topic: teamTopic(spec, plan.teamKey), directive: leadDirective(spec, plan.teamKey, plan.tasks.length),
              forbidTools: plan.forbidTools, attemptBudget: remaining(),
              candidates: plan.tasks.map((t, i) => ({ index: i, submission: t.instanceId })),
            });
            addUsage(lead);
            leadOutput = lead;
            leadCoordCalls = lead.coordCalls ?? 0;
            leadTrace = lead.traceRef;
          } finally {
            await safeTeardown(leadHandle);
          }
        }
      }
      // The team lead's trace belongs to every row of its team, after the row's own agents (P-022 / D-010).
      const leadRefs = traceList([leadTrace]);
      // The lead is a contributor to every row of its team: merge its evidence with the row's own.
      const leadEvidence = (r: TaskRunResult, armMeta: Record<string, unknown>) => leadOutput === undefined
        ? armMeta
        : withExecutionPath(
          withCapabilityEvidence(armMeta, mergeCapabilityEvidence([readCapabilityEvidence(r), leadOutput.capabilityEvidence])) ?? armMeta,
          [leadOutput],
        );
      await drainUnits(
        plan.tasks.map((task) => ({ task, plan })),
        (r) => ({
          ...r,
          armMeta: leadEvidence(r, { ...(r.armMeta ?? {}), leadCoordCalls }),
          ...(leadRefs.length > 0 ? { traceRefs: [...(r.traceRefs ?? []), ...leadRefs] } : {}),
        }),
      );
    }
  } else {
    // flat: every team's tasks in one shared pool (workers self-organize via the directive).
    const units = coordinationSpawnPlans(spec, deps.backlog).flatMap((plan) => plan.tasks.map((task) => ({ task, plan })));
    await drainUnits(units, identity);
  }

  return {
    arm: spec.arm,
    runId: deps.runId,
    startedAtMs,
    finishedAtMs: now(),
    rows,
    modelCallsSpent: spent.calls,
    tokensSpent: spent.tokens,
    costUsdSpent: spent.costUsd,
    budgetExhausted: exhausted(),
    attemptedTaskIds,
    skippedTaskIds,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

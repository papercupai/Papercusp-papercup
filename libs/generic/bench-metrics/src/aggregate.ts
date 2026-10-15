/**
 * The report builder: folds `TaskRunResult[]` → per-arm `ArmReport`s and a full
 * `SuiteReport` (cost/accuracy Pareto + Papercusp-vs-baseline deltas). This is
 * the importable surface the Evaluation UI (P-020) and the methodology doc
 * (P-016) consume — `buildSuiteReport` is the one call that produces everything
 * the surface renders.
 *
 * Statistics (plan "Statistics" + "same pass@k protocol"):
 *  - pass@1 = mean over TASKS of (resolved-rate over that task's seeds), so every
 *    task is weighted equally regardless of how many seeds it has.
 *  - Primary intervals resample paired task means or whole frozen repositories.
 *  - pass@k / pass^k use the SAME k's for every arm (`protocolKs`).
 *  - Absent/generation-failed assignments are zero outcomes; grader outages are
 *    missing measurements and suppress primary estimates and intervals.
 */

import type {
  TaskRunResult,
  ArmReport,
  SuiteReport,
  ArmDelta,
  ParetoPoint,
  ArmId,
  BenchSuite,
  PassAtKPoint,
} from './schema';
import { meanPassAtK } from './pass-k';
import { wilsonInterval, pairedBootstrapCI } from './intervals';
import { accountTokens, verifyIsoBudget, isScored } from './cost';
import { costAccuracyFrontier } from './pareto';
import type { PriceTable } from './pricing';
import { DEFAULT_PRICE_TABLE } from './pricing';

export interface AggregateOpts {
  /** Frozen task/seed assignment; tasks absent from every arm still count. */
  assignedTaskIds?: readonly string[];
  assignedSeeds?: readonly number[];
  assignedArms?: readonly ArmId[];
  /** Identity for a frozen run whose attempts are all absent. */
  runId?: string;
  suite?: BenchSuite;
  priceTable?: PriceTable;
  /** The k's the pass@k / pass^k protocol reports (same for every arm). Default [1, 3]. */
  protocolKs?: number[];
  /** Two-sided confidence level for all intervals. Default 0.95. */
  ci?: number;
  /** Deterministic bootstrap seed (so CIs reproduce). Default 0xBE0C. */
  bootstrapSeed?: number;
  /** Bootstrap resamples. Default 10000. */
  bootstrapIterations?: number;
  /** Frozen task -> repository mapping; whole repositories are resampled. */
  repositoryByTask?: Readonly<Record<string, string>>;
  /** Current protocols lacking a frozen policy remain readable but inconclusive. */
  requireRegisteredSampling?: boolean;
  /** The treatment arm the deltas are computed against. Default 'papercusp' (SWE
   *  pilot); other benchmarks name their own (e.g. 'hive' for tau2's hive-vs-su). */
  treatmentArm?: ArmId;
}

const DEFAULT_KS = [1, 3];
const DEFAULT_SEED = 0xbe0c;

function reportSampling(taskIds: readonly string[], opts: AggregateOpts): SuiteReport['sampling'] {
  const repositories = opts.repositoryByTask;
  if (repositories && (Object.keys(repositories).length !== taskIds.length ||
      taskIds.some(id => !Object.hasOwn(repositories, id) || typeof repositories[id] !== 'string' || !repositories[id].trim()))) {
    throw new Error('benchmark report: repository mapping must cover exactly the assigned tasks');
  }
  const unit = repositories ? 'repository' : opts.requireRegisteredSampling ? 'unregistered' : 'task';
  return { unit, taskPairs: taskIds.length,
    independentUnits: repositories ? new Set(taskIds.map(id => repositories[id])).size : unit === 'task' ? taskIds.length : null,
    seedPolicy: 'collapse-within-task', assignedSeeds: opts.assignedSeeds ? [...opts.assignedSeeds] : null,
    ci: opts.ci ?? 0.95, bootstrapSeed: opts.bootstrapSeed ?? DEFAULT_SEED,
    bootstrapIterations: opts.bootstrapIterations ?? 10_000,
    repositoryByTask: repositories ? { ...repositories } : null };
}

function pairedInterval(a: number[], b: number[], taskIds: readonly string[], sampling: SuiteReport['sampling']) {
  if (sampling.independentUnits === null || sampling.independentUnits < 2) return null;
  return pairedBootstrapCI(a, b, { ci: sampling.ci, seed: sampling.bootstrapSeed,
    iterations: sampling.bootstrapIterations,
    clusterIds: sampling.repositoryByTask ? taskIds.map(id => sampling.repositoryByTask![id]) : undefined }).delta;
}

/** The persisted row fields the outcome projection reads (a {@link TaskRunResult} satisfies it). */
export interface AssignedOutcomeRow {
  taskId: string; seed: number; resolved: boolean | null; score?: number | null;
  generationStatus?: string; generationError?: string | null; graderStatus: string;
  /** Generation stopped at its iso-budget ceiling but still produced a graded end state. */
  capped?: boolean;
}

/**
 * The four-way outcome of one attempt (plan benchmark-coverage-frontierswe-v2-2026-10-10 D-008), beside the
 * pre-existing generation-failure class. `scored` and `budget_exhausted` are MEASURED outcomes (a budget-capped
 * attempt is graded on its end state and counts with that score); `invalid` (integrity check found protected
 * paths changed) and `grader_error` are MISSING measurements, disclosed as separate counts; `generation_failed`
 * produced no submission and stays in the primary denominator as 0. {@link summarizeAssignedOutcomes} counts
 * through this function, so the classification and the denominator cannot drift apart.
 */
export type AttemptOutcome = 'scored' | 'budget_exhausted' | 'invalid' | 'grader_error' | 'generation_failed';

const isValidScore = (score: number | null | undefined): score is number =>
  typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1;

export function classifyAttemptOutcome(row: AssignedOutcomeRow): AttemptOutcome {
  if (row.generationStatus === 'error' || row.generationStatus === 'timeout' || !!row.generationError) {
    return 'generation_failed';
  }
  if (row.graderStatus === 'invalid') return 'invalid';
  const scoreValid = isValidScore(row.score);
  const gradeMissing = row.graderStatus === 'error' || row.graderStatus === 'timeout' ||
    (row.resolved == null && !scoreValid) || (row.score != null && !scoreValid);
  if (gradeMissing) return 'grader_error';
  return row.capped ? 'budget_exhausted' : 'scored';
}

/** Per-arm disclosure of {@link AttemptOutcome} counts over the OBSERVED attempts (absent ones are not attempts). */
export interface AttemptOutcomeCounts {
  scored: number; budgetExhausted: number; invalid: number; graderError: number; generationFailed: number;
}

const OUTCOME_COUNT_KEY = {
  scored: 'scored', budget_exhausted: 'budgetExhausted', invalid: 'invalid',
  grader_error: 'graderError', generation_failed: 'generationFailed',
} as const satisfies Record<AttemptOutcome, keyof AttemptOutcomeCounts>;

/** Shared outcome-only projection; no pricing or statistical resampling is needed for exports. */
export function summarizeAssignedOutcomes(rows: readonly AssignedOutcomeRow[],
  opts: Pick<AggregateOpts, 'assignedTaskIds' | 'assignedSeeds'> = {}) {
  const assignedIds = [...new Set(opts.assignedTaskIds ?? rows.map(row => row.taskId))];
  const assignedSeeds = opts.assignedSeeds ? new Set(opts.assignedSeeds) : null;
  if (opts.assignedTaskIds && (assignedIds.length !== opts.assignedTaskIds.length ||
      assignedIds.some(id => !id.trim())) || assignedSeeds && (!assignedSeeds.size ||
      assignedSeeds.size !== opts.assignedSeeds!.length || [...assignedSeeds].some(seed => !Number.isSafeInteger(seed) || seed < 0))) {
    throw new Error('aggregateArm: invalid frozen task/seed assignment');
  }
  if (rows.some(row => !assignedIds.includes(row.taskId) || (assignedSeeds && !assignedSeeds.has(row.seed)))) {
    throw new Error('aggregateArm: result outside frozen task/seed assignment');
  }
  const byTask = new Map(assignedIds.map(id => [id, { n: assignedSeeds?.size ?? 0, c: 0, scoreSum: 0, observed: 0 }]));
  const conditional = new Map<string, { n: number; c: number; scoreSum: number }>();
  let missingMeasurements = 0;
  const outcomes: AttemptOutcomeCounts = { scored: 0, budgetExhausted: 0, invalid: 0, graderError: 0, generationFailed: 0 };
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = JSON.stringify([row.taskId, row.seed]);
    if (seen.has(identity)) throw new Error('aggregateArm: duplicate task/seed result');
    seen.add(identity);
    const task = byTask.get(row.taskId)!;
    task.observed += 1;
    if (!assignedSeeds) task.n += 1;
    const outcome = classifyAttemptOutcome(row);
    outcomes[OUTCOME_COUNT_KEY[outcome]] += 1;
    if (outcome === 'generation_failed') continue;
    if (outcome === 'invalid' || outcome === 'grader_error') { missingMeasurements += 1; continue; }
    const c = row.resolved === true ? 1 : 0;
    const score = isValidScore(row.score) ? row.score : c;
    task.c += c;
    task.scoreSum += score;
    const measured = conditional.get(row.taskId) ?? { n: 0, c: 0, scoreSum: 0 };
    measured.n += 1; measured.c += c; measured.scoreSum += score;
    conditional.set(row.taskId, measured);
  }
  const counts = [...byTask.values()].map(task => ({ ...task, n: Math.max(task.n, 1) }));
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const conditionalCounts = [...conditional.values()];
  const assignedAttempts = counts.reduce((sum, task) => sum + task.n, 0);
  return { counts, conditionalCounts, assignedTasks: counts.length, assignedAttempts,
    attempts: rows.length, absentAttempts: assignedAttempts - rows.length,
    absentTasks: counts.filter(task => !task.observed).length,
    gradedAttempts: conditionalCounts.reduce((sum, task) => sum + task.n, 0),
    resolved: counts.reduce((sum, task) => sum + task.c, 0), missingMeasurements, outcomes,
    measurementComplete: missingMeasurements === 0,
    primaryResolvedPct: missingMeasurements ? null : mean(counts.map(task => task.c / task.n)),
    primaryMeanScore: missingMeasurements ? null : mean(counts.map(task => task.scoreSum / task.n)),
    conditionalResolvedPct: mean(conditionalCounts.map(task => task.c / task.n)),
    conditionalMeanScore: mean(conditionalCounts.map(task => task.scoreSum / task.n)) };
}

/** Aggregate ONE arm on ONE suite. `rows` must already be filtered to that (suite, arm). */
export function aggregateArm(
  rows: readonly TaskRunResult[],
  suite: BenchSuite,
  arm: ArmId,
  opts: AggregateOpts = {},
): ArmReport {
  const ks = opts.protocolKs ?? DEFAULT_KS;
  const ci = opts.ci ?? 0.95;
  const outcomes = summarizeAssignedOutcomes(rows, opts);
  const { counts, missingMeasurements } = outcomes;
  const conditionalPassAt1 = outcomes.conditionalResolvedPct ?? 0;
  const taskIds = opts.assignedTaskIds ?? [...new Set(rows.map(row => row.taskId))];
  const sampling = reportSampling(taskIds, opts);

  // pass@1 = mean over tasks of c/n (== meanPassAtK at k=1); CI bootstrapped over tasks.
  const perTaskPass1 = counts.map((t) => t.c / t.n);
  const passAt1 = missingMeasurements > 0 ? null
    : perTaskPass1.length === 0 ? 0 : perTaskPass1.reduce((a, b) => a + b, 0) / perTaskPass1.length;
  const passAt1Ci = missingMeasurements ? null
    : pairedInterval(perTaskPass1.map(() => 0), perTaskPass1, taskIds, sampling);

  // Pooled resolved-rate Wilson interval (cross-check on the raw Bernoulli stream).
  const pooledN = counts.reduce((a, t) => a + t.n, 0);
  const pooledC = counts.reduce((a, t) => a + t.c, 0);
  const resolvedRateWilson = missingMeasurements ? null : wilsonInterval(pooledC, pooledN, ci);

  const passAtK: PassAtKPoint[] = ks.map((k) => ({ k, ...meanPassAtK(counts, k) }));
  // pass^k (reliability) reuses meanPass over a "success = all k succeed" estimator.
  const passHatK: PassAtKPoint[] = ks.map((k) => ({ k, ...meanPassHatK(counts, k) }));

  const cost = accountTokens(rows, { priceTable: opts.priceTable ?? DEFAULT_PRICE_TABLE, resolvedCount: pooledC });

  // budgetTokens for the report: the single cap these rows share, or null if mixed/uncapped.
  const budgets = new Set(rows.map((r) => r.budgetTokens ?? null));
  const budgetTokens = budgets.size === 1 ? [...budgets][0] : null;

  return {
    arm,
    suite,
    tasks: counts.length,
    attempts: rows.length,
    gradedAttempts: outcomes.gradedAttempts,
    absentTasks: outcomes.absentTasks,
    missingMeasurements,
    conditionalPassAt1,
    infraErrors: rows.filter((r) => !isScored(r)).length,
    cappedRuns: rows.filter((r) => r.capped).length,
    budgetTokens,
    passAt1,
    passAt1Ci,
    resolvedRateWilson,
    passAtK,
    passHatK,
    cost,
  };
}

/** Mean pass^k across tasks (uses the passHatK estimator; same skip semantics as meanPassAtK). */
function meanPassHatK(
  tasks: ReadonlyArray<{ n: number; c: number }>,
  k: number,
): { value: number; tasksUsed: number; skipped: number } {
  // Imported lazily to keep the pure estimator in pass-k.ts; re-derive here.
  let sum = 0;
  let used = 0;
  let skipped = 0;
  for (const t of tasks) {
    if (t.n < k) {
      skipped++;
      continue;
    }
    // pass^k = C(c,k)/C(n,k); reuse the closed form.
    if (t.c < k) {
      used++;
      continue; // contributes 0
    }
    let prod = 1;
    for (let i = 0; i < k; i++) prod *= (t.c - i) / (t.n - i);
    sum += prod;
    used++;
  }
  return { value: used === 0 ? 0 : sum / used, tasksUsed: used, skipped };
}

const PAPERCUSP: ArmId = 'papercusp';

/**
 * Build the full per-suite report: an `ArmReport` per arm, the cost/accuracy
 * Pareto across arms, Papercusp-vs-each-baseline deltas, and the iso-budget
 * invariant check. `rows` is every run-result for the suite (all arms × seeds).
 */
export function buildSuiteReport(rows: readonly TaskRunResult[], opts: AggregateOpts = {}): SuiteReport {
  if (rows.length === 0 && (!opts.runId || !opts.suite || !opts.assignedTaskIds?.length ||
      !opts.assignedSeeds?.length || !opts.assignedArms?.length)) {
    throw new Error('buildSuiteReport: no rows');
  }
  const suite = opts.suite ?? rows[0].suite;
  const runId = opts.runId ?? rows[0].runId;
  if (rows.some(row => row.suite !== suite || row.runId !== runId)) {
    throw new Error('buildSuiteReport: mixed run or suite identity');
  }
  const ks = opts.protocolKs ?? DEFAULT_KS;

  const armIds = [...new Set(opts.assignedArms ?? rows.map((r) => r.arm))];
  if (rows.some(row => !armIds.includes(row.arm))) {
    throw new Error('buildSuiteReport: result outside frozen arm assignment');
  }
  const assignedTaskIds = opts.assignedTaskIds ?? [...new Set(rows.map(row => row.taskId))];
  const sampling = reportSampling(assignedTaskIds, opts);
  const arms = armIds.map((arm) =>
    aggregateArm(
      rows.filter((r) => r.arm === arm),
      suite,
      arm,
      { ...opts, assignedTaskIds },
    ),
  );

  // Cost/accuracy Pareto: accuracy = pass@1, cost = mean $ per task-attempt.
  const rawPoints = arms.filter((a) => a.passAt1 != null && a.attempts > 0 && !a.cost.missingMeasurements).map((a) => ({
    arm: a.arm,
    accuracy: a.passAt1!,
    cost: a.attempts === 0 ? 0 : a.cost.costUsd / a.attempts,
    costPerResolved: a.cost.costPerResolved,
  }));
  const frontierArms = new Set(costAccuracyFrontier(rawPoints).map((p) => p.arm));
  const frontier: ParetoPoint[] = rawPoints.map((p) => ({ ...p, onFrontier: frontierArms.has(p.arm) }));

  // treatment − each baseline. The treatment arm defaults to 'papercusp' (the
  // SWE pilot); other benchmarks (tau2 etc.) name their own via opts.treatmentArm.
  const treatmentArm = opts.treatmentArm ?? PAPERCUSP;
  const byArm = new Map(arms.map((a) => [a.arm, a]));
  const treatment = byArm.get(treatmentArm);
  const deltas: ArmDelta[] = [];
  if (treatment) {
    const tPoint = rawPoints.find((p) => p.arm === treatmentArm);
    const tOutcomes = summarizeAssignedOutcomes(rows.filter(row => row.arm === treatmentArm), { ...opts, assignedTaskIds });
    for (const a of arms) {
      if (a.arm === treatmentArm) continue;
      const bPoint = rawPoints.find((p) => p.arm === a.arm);
      const bOutcomes = summarizeAssignedOutcomes(rows.filter(row => row.arm === a.arm), { ...opts, assignedTaskIds });
      const missingMeasurements = tOutcomes.missingMeasurements + bOutcomes.missingMeasurements;
      const status = missingMeasurements ? 'missing-grade' : sampling.unit === 'unregistered' ? 'unregistered-policy'
        : sampling.independentUnits! < 2 ? 'insufficient-independent-units' : 'measured';
      const efficiencyMeasured = !!tPoint && !!bPoint;
      deltas.push({
        suite,
        treatment: treatmentArm,
        baseline: a.arm,
        accuracyDelta: treatment.passAt1 === null || a.passAt1 === null ? null : treatment.passAt1 - a.passAt1,
        accuracyDeltaCi: status === 'measured' ? pairedInterval(
          bOutcomes.counts.map(task => task.c / task.n), tOutcomes.counts.map(task => task.c / task.n), assignedTaskIds, sampling) : null,
        uncertainty: { status, taskPairs: assignedTaskIds.length, independentUnits: sampling.independentUnits,
          missingMeasurements, baselineObservedAttempts: a.attempts, treatmentObservedAttempts: treatment.attempts,
          baselineAbsentAttempts: bOutcomes.absentAttempts, treatmentAbsentAttempts: tOutcomes.absentAttempts },
        efficiencyMeasured,
        costRatio:
          efficiencyMeasured && treatment.cost.costPerResolved !== null && a.cost.costPerResolved !== null && a.cost.costPerResolved !== 0
            ? treatment.cost.costPerResolved / a.cost.costPerResolved
            : null,
        costFraction: !efficiencyMeasured || bPoint!.cost === 0 ? null : tPoint!.cost / bPoint!.cost,
        paretoDominates: efficiencyMeasured && treatment.passAt1! >= a.passAt1! && tPoint!.cost <= bPoint!.cost &&
          (treatment.passAt1! > a.passAt1! || tPoint!.cost < bPoint!.cost),
      });
    }
  }

  const iso = verifyIsoBudget(rows);

  return {
    runId,
    suite,
    assignment: {
      basis: opts.assignedTaskIds && opts.assignedSeeds && opts.assignedArms ? 'frozen' : 'observed',
      taskIds: [...assignedTaskIds],
      seeds: opts.assignedSeeds ? [...opts.assignedSeeds] : null,
      arms: armIds,
    },
    arms,
    frontier,
    deltas,
    isoBudget: { ok: iso.ok, budgetTokens: iso.budgetTokens, violations: iso.violations },
    protocolKs: ks,
    sampling,
  };
}

/**
 * FrontierSWE report transform (plan benchmark-suite-frontier-swe-2026-06-18 P-016; v2 rules from plan
 * benchmark-coverage-frontierswe-v2-2026-10-10 P-003 / D-003): fold graded run rows (`suite='frontier-swe'`) into
 * the `suiteData['frontier-swe']` payload the Evaluation UI renders — per-arm mean@5 / best@5 + AVG-RANK + dominance
 * (overall + per bucket), plus the mandatory caveats and the excluded (infra-non-completion) count. Pure:
 * `TaskRunResult[]` in → a plain object out (no DB, no run). The report builder / run path attaches the result under
 * `BenchReportBundle.suiteData['frontier-swe']`.
 *
 * Denominator discipline (C1/C6): a genuine capability outcome (a numeric `score`, incl. 0) COUNTS; an infra
 * non-completion (generation/grader error/timeout) is EXCLUDED + surfaced via `excludedCount`, never scored 0.
 *
 * Comparability (R-1 / C5): the report REFUSES (throws {@link FrontierSweReportRefusal}) rather than fold
 *  - rows graded against BOTH corpus versions — v1 is history and never aggregates with v2; and
 *  - one task scored by DIFFERENT scorers — a v2 grader version pins the corpus commit AND the verifier image
 *    digest, so two pins on one task mean the arms (or trials) were not graded by the same verifier.
 * Every count it reports (tasks, per-bucket tasks, the small-N caveat) is derived from the rows, never restated.
 */
import type { ArmTaskTrials, FrontierArmSummary, Interval, PairedComparison, TaskRunResult } from '@papercusp/bench-metrics';
import { bootstrapMeanCI, frontierRankReport, pairedBootstrapCI } from '@papercusp/bench-metrics';
import { frontierSweGraderCorpusVersion } from '../grader/frontier-swe';

/** Coarse buckets in their reporting order; any other bucket a corpus carries sorts after these. */
const BUCKET_ORDER = ['implementation', 'performance', 'research'] as const;

export type FrontierSweCorpusVersion = 'v1' | 'v2';

export type FrontierSweReportRefusalCode = 'mixed-corpus-versions' | 'scorer-mismatch' | 'duplicate-trial';

/** Why a FrontierSWE report cannot be built from these rows. The rows are not comparable; nothing was folded. */
export class FrontierSweReportRefusal extends Error {
  readonly code: FrontierSweReportRefusalCode;
  readonly detail: Record<string, unknown>;
  constructor(code: FrontierSweReportRefusalCode, message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'FrontierSweReportRefusal';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The mandatory FrontierSWE reporting caveats (plan D-002 / D-003 / C6 / C8), shown with every number. The small-N
 * caveat names the task count and corpus version of THIS report (derived), and a v1 report says it is history.
 */
export function frontierSweCaveats(input: { corpusVersion: FrontierSweCorpusVersion | null; taskCount: number }): string[] {
  const n = input.taskCount;
  const scope =
    input.corpusVersion === null
      ? `${n} task${n === 1 ? '' : 's'} scored`
      : `${n} task${n === 1 ? '' : 's'} scored from the FrontierSWE ${input.corpusVersion} corpus`;
  const caveats = [
    'Absolute AVG RANK / dominance are illustrative only unless the full FrontierSWE competitor pool was run — ' +
      'the defensible signal is the within-pool coordination-topology comparison on the same tasks + iso-budget (D-002).',
    `FrontierSWE is ultra-long-horizon and small-N (${scope}) — always report trials/seeds; a single-run gap inside ` +
      'the noise band is not significant (C8).',
    'Infra non-completions are EXCLUDED (not scored 0) and disclosed symmetrically across arms (C6) — see excludedCount.',
  ];
  if (input.corpusVersion === 'v1') {
    caveats.push(
      'These are FrontierSWE v1 HISTORY rows: v1 never aggregates or compares with v2 results ' +
        '(plan benchmark-coverage-frontierswe-v2-2026-10-10 R-1).',
    );
  }
  return caveats;
}

export interface FrontierSweSuiteData {
  k: number;
  /** The corpus every graded row was scored against; null when no row carries a scorer pin. */
  corpusVersion: FrontierSweCorpusVersion | null;
  /** Distinct scorer pins (`graderVersion`) of the scored rows, sorted. One per task by construction. */
  graderVersions: string[];
  /** Distinct tasks with ≥1 scored row. */
  taskCount: number;
  /** Scored rows folded in (a numeric score). */
  trialCount: number;
  /** frontier-swe rows dropped as infra non-completions (generation/grader error/timeout) — surfaced, not scored 0. */
  excludedCount: number;
  /** Scored tasks per bucket, derived from the rows + `taskBucket` (tasks with no bucket are not counted). */
  bucketTaskCounts: Record<string, number>;
  /** Per-arm rollup: v2 sorts by mean@k descending; v1 keeps historical AVG RANK. */
  arms: FrontierArmSummary[];
  /** Per-bucket per-arm rollups, one per bucket in `bucketTaskCounts`. */
  perBucket: Record<string, FrontierArmSummary[]>;
  /** Explicit primary/secondary labels, so historical rank cannot become a v2 headline. */
  headlineMetric: string;
  secondaryMetrics: string[];
  /** An incomplete arm has no headline value; its conditional rollup remains in `arms`. */
  headline: Record<string, { value: number | null; interval: Interval | null; taskIds: string[] }>;
  incompleteTasks: Record<string, string[]>;
  /** Pairwise differences resample complete TASK means, never individual seed rows. */
  pairedComparisons: Array<{
    armA: string; armB: string; taskIds: string[]; excludedTaskIds: string[]; comparison: PairedComparison | null;
  }>;
  /** Upstream suite categories may overlap; overall task weighting remains unchanged. */
  perCategory: Record<string, FrontierArmSummary[]>;
  categoryTaskCounts: Record<string, number>;
  uncategorizedTaskIds: string[];
  caveats: readonly string[];
}

/** True iff a row was genuinely graded (a numeric capability score), not an infra non-completion. */
function isScoredFrontierRow(r: TaskRunResult): boolean {
  return (
    r.generationStatus === 'completed' &&
    (r.graderStatus === 'passed' || r.graderStatus === 'failed') &&
    typeof r.score === 'number' &&
    Number.isFinite(r.score)
  );
}

/** The row's scorer pin; '' when it has none (an ungraded placeholder carries '' — adapter `ungradedPlaceholder`). */
function scorerPin(r: TaskRunResult): string {
  return typeof r.graderVersion === 'string' ? r.graderVersion : '';
}

function bucketRank(b: string): number {
  const i = (BUCKET_ORDER as readonly string[]).indexOf(b);
  return i === -1 ? BUCKET_ORDER.length : i;
}

/** Refuse rows graded against both corpus versions. Unpinned rows ('' — never graded) name no corpus. */
function assertOneCorpusVersion(rows: readonly TaskRunResult[]): FrontierSweCorpusVersion | null {
  const byVersion = new Map<FrontierSweCorpusVersion, TaskRunResult[]>();
  for (const r of rows) {
    const pin = scorerPin(r);
    if (!pin) continue;
    const v = frontierSweGraderCorpusVersion(pin);
    byVersion.set(v, [...(byVersion.get(v) ?? []), r]);
  }
  if (byVersion.size > 1) {
    const sample = (v: FrontierSweCorpusVersion) =>
      (byVersion.get(v) ?? []).slice(0, 3).map((r) => `${r.arm}/${r.taskId}#${r.seed} (${scorerPin(r)})`);
    const counts = { v1: byVersion.get('v1')?.length ?? 0, v2: byVersion.get('v2')?.length ?? 0 };
    throw new FrontierSweReportRefusal(
      'mixed-corpus-versions',
      `FrontierSWE report refused: rows are graded against both corpus versions (v1: ${counts.v1}, v2: ${counts.v2} ` +
        `row(s)) — v1 is history and never aggregates with v2 (plan benchmark-coverage-frontierswe-v2-2026-10-10 ` +
        `R-1). Report each version from its own rows. v1 e.g. ${sample('v1').join(', ')}; v2 e.g. ${sample('v2').join(', ')}.`,
      { counts, v1Sample: sample('v1'), v2Sample: sample('v2') },
    );
  }
  return byVersion.keys().next().value ?? null;
}

/** Refuse a task whose scored rows carry more than one scorer pin — the arms were not graded by one verifier. */
function assertOneScorerPerTask(scored: readonly TaskRunResult[]): void {
  const byTask = new Map<string, Map<string, Set<string>>>(); // taskId → scorer pin → arms
  for (const r of scored) {
    const pins = byTask.get(r.taskId) ?? new Map<string, Set<string>>();
    const arms = pins.get(scorerPin(r)) ?? new Set<string>();
    arms.add(r.arm);
    pins.set(scorerPin(r), arms);
    byTask.set(r.taskId, pins);
  }
  const conflicts = [...byTask]
    .filter(([, pins]) => pins.size > 1)
    .map(([taskId, pins]) => ({
      taskId,
      scorers: [...pins].map(([pin, arms]) => ({ graderVersion: pin || '(unpinned)', arms: [...arms].sort() })),
    }));
  if (conflicts.length > 0) {
    const first = conflicts[0];
    const shown = first.scorers.map((s) => `${s.graderVersion} ← ${s.arms.join('+')}`).join(' vs ');
    throw new FrontierSweReportRefusal(
      'scorer-mismatch',
      `FrontierSWE report refused: ${conflicts.length} task(s) were scored by different scorers, so their scores are ` +
        `not comparable (C5). Task '${first.taskId}': ${shown}. Re-grade every arm of a task with one pinned verifier.`,
      { conflicts },
    );
  }
}

/**
 * Build the `frontier-swe` suiteData from run rows. `k` defaults to 5 (the FrontierSWE trial protocol).
 * `taskBucket` maps taskId → coarse bucket (from the corpus graderMeta.bucket) to enable per-bucket reporting;
 * omit it and `perBucket` / `bucketTaskCounts` are empty (overall still computed).
 * @throws FrontierSweReportRefusal when the rows mix corpus versions or a task mixes scorers.
 */
export function buildFrontierSweSuiteData(
  rows: readonly TaskRunResult[],
  opts: {
    k?: number;
    taskBucket?: Record<string, string>;
    taskCategories?: Record<string, readonly string[]>;
    /** Frozen assignment scope, when available, exposes entirely absent tasks/arms too. */
    assignedTaskIds?: readonly string[];
    assignedArms?: readonly string[];
  } = {},
): FrontierSweSuiteData {
  const k = opts.k ?? 5;
  const fsRows = rows.filter((r) => r.suite === 'frontier-swe');
  const corpusVersion = assertOneCorpusVersion(fsRows);
  if (corpusVersion === 'v2') {
    const seen = new Set<string>();
    for (const row of fsRows) {
      const key = JSON.stringify([row.taskId, row.arm, row.seed]);
      if (seen.has(key)) {
        throw new FrontierSweReportRefusal('duplicate-trial',
          `FrontierSWE v2 report refused: duplicate trial ${row.arm}/${row.taskId}#${row.seed}; select one settled attempt per seed.`,
          { taskId: row.taskId, arm: row.arm, seed: row.seed });
      }
      seen.add(key);
    }
  }
  const scored = fsRows.filter(isScoredFrontierRow);
  assertOneScorerPerTask(scored);
  const excludedCount = fsRows.length - scored.length;

  // taskId → arm → trial scores
  const byTask = new Map<string, Map<string, number[]>>();
  for (const r of scored) {
    const arms = byTask.get(r.taskId) ?? new Map<string, number[]>();
    const arr = arms.get(r.arm) ?? [];
    arr.push(r.score as number);
    arms.set(r.arm, arr);
    byTask.set(r.taskId, arms);
  }

  const tasks: ArmTaskTrials[] = [];
  for (const [taskId, arms] of byTask) {
    const trials: Record<string, number[]> = {};
    for (const [arm, scores] of arms) trials[arm] = scores;
    tasks.push({ taskId, tier: opts.taskBucket?.[taskId], trials });
  }

  const bucketTaskCounts: Record<string, number> = {};
  const buckets = [...new Set(tasks.flatMap((t) => (t.tier ? [t.tier] : [])))].sort(
    (a, b) => bucketRank(a) - bucketRank(b) || a.localeCompare(b),
  );
  for (const b of buckets) bucketTaskCounts[b] = tasks.filter((t) => t.tier === b).length;

  const ranking = corpusVersion === 'v2' ? 'mean' as const : 'avg-rank' as const;
  const report = frontierRankReport(tasks, k, { ranking });
  const perBucket: Record<string, FrontierArmSummary[]> = {};
  for (const b of buckets) perBucket[b] = frontierRankReport(tasks, k, { tierFilter: b, ranking }).arms;

  const taskIds = [...new Set([...(opts.assignedTaskIds ?? []), ...fsRows.map(r => r.taskId)])].sort();
  const armIds = [...new Set([...(opts.assignedArms ?? []), ...fsRows.map(r => r.arm)])].sort();
  const means = new Map(report.perTaskMeanAtK.map(t => [t.taskId, t.scores]));
  const incompleteTasks: Record<string, string[]> = {};
  const headline: FrontierSweSuiteData['headline'] = {};
  for (const arm of armIds) {
    const completeIds = taskIds.filter(id => means.get(id)?.[arm] !== undefined);
    incompleteTasks[arm] = taskIds.filter(id => means.get(id)?.[arm] === undefined);
    const values = completeIds.map(id => means.get(id)![arm]);
    const complete = incompleteTasks[arm].length === 0 && values.length > 0;
    headline[arm] = {
      value: complete
        ? corpusVersion === 'v2' ? values.reduce((a, b) => a + b, 0) / values.length : report.arms.find(a => a.arm === arm)?.avgRank ?? null
        : null,
      interval: corpusVersion === 'v2' && complete && values.length >= 2 ? bootstrapMeanCI(values) : null,
      taskIds: completeIds,
    };
  }
  const pairedComparisons: FrontierSweSuiteData['pairedComparisons'] = [];
  for (let i = 0; i < armIds.length; i++) {
    for (let j = i + 1; j < armIds.length; j++) {
      const armA = armIds[i];
      const armB = armIds[j];
      const pairedIds = taskIds.filter(id => means.get(id)?.[armA] !== undefined && means.get(id)?.[armB] !== undefined);
      pairedComparisons.push({
        armA, armB, taskIds: pairedIds, excludedTaskIds: taskIds.filter(id => !pairedIds.includes(id)),
        comparison: pairedIds.length >= 2
          ? pairedBootstrapCI(pairedIds.map(id => means.get(id)![armA]), pairedIds.map(id => means.get(id)![armB]))
          : null,
      });
    }
  }
  const categories = [...new Set(tasks.flatMap(t => opts.taskCategories?.[t.taskId] ?? []))].sort();
  const perCategory: FrontierSweSuiteData['perCategory'] = {};
  const categoryTaskCounts: Record<string, number> = {};
  for (const category of categories) {
    const members = tasks.filter(t => opts.taskCategories?.[t.taskId]?.includes(category));
    categoryTaskCounts[category] = members.length;
    perCategory[category] = frontierRankReport(members, k, { ranking }).arms;
  }

  return {
    k,
    corpusVersion,
    graderVersions: [...new Set(scored.map(scorerPin).filter(Boolean))].sort(),
    taskCount: byTask.size,
    trialCount: scored.length,
    excludedCount,
    bucketTaskCounts,
    arms: report.arms,
    perBucket,
    headlineMetric: corpusVersion === 'v2' ? `mean@${k}` : 'avg-rank',
    secondaryMetrics: corpusVersion === 'v2' ? [`best@${k}`, 'avg-rank', 'dominance'] : [`mean@${k}`, `best@${k}`, 'dominance'],
    headline,
    incompleteTasks,
    pairedComparisons,
    perCategory,
    categoryTaskCounts,
    uncategorizedTaskIds: taskIds.filter(id => !opts.taskCategories?.[id]?.length),
    caveats: frontierSweCaveats({ corpusVersion, taskCount: byTask.size }),
  };
}

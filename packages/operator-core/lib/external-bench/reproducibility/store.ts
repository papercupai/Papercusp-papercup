/**
 * Read side (BRIEF 8 / P-010) — the snake_case(PG) → camelCase(TS) seam. Returns
 * P-011's canonical `TaskRunResult` directly so buildSuiteReport() and the P-020
 * Evaluation UI consume one type with no per-caller mapping. Also reads the
 * rollout cards + prereg rows (P-010-owned artifacts).
 */
import { buildSuiteReport, type AggregateOpts, type SuiteReport, type TaskRunResult, type TestOutcome } from '@papercusp/bench-metrics';
import type { PreregRecord, RolloutRecord } from './schema';
import { currentProtocolFromConfig, currentProtocolPriceTable } from './schema';
import { resolveDb, type DbScope } from './db';
import { z } from 'zod';
import { computePreregHash } from './prereg';
import { canonicalJson } from './canonical-json';
import { evaluateManagedCapabilityEffectiveness, type ManagedTrialRun } from '../../../../../libs/papercusp/packages/orchestrator/src/managed-capability-effectiveness';
import { MANAGED_CAPABILITY_FAMILY_IDS } from '../../../../../libs/papercusp/packages/orchestrator/src/managed-capability-contract';

const trialClient = z.enum(['claude', 'codex', 'omp']);
const trialAssignment = z.object({
  client: trialClient, clientVersion: z.string().min(1), modelId: z.string().min(1),
  taskId: z.string().min(1), seed: z.number().int().nonnegative(),
  planSlug: z.string().min(1), itemId: z.string().regex(/^P-\d{3,}$/),
  preImplementationCommit: z.string().regex(/^[a-f0-9]{40}$/),
  graderTestPaths: z.array(z.string().min(1)).min(1),
  families: z.array(z.enum(MANAGED_CAPABILITY_FAMILY_IDS)).min(1),
});
const trialConfig = z.object({
  sharedCheckoutRealpath: z.string().min(1), assignments: z.array(trialAssignment).min(1),
});
const trialWitness = z.object({
  client: trialClient, clientVersion: z.string().min(1), toolMode: z.enum(['native', 'managed-only']),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), checkoutRealpath: z.string().min(1),
  environmentHash: z.string().min(1), startedAt: z.string().datetime(),
  graderTestPaths: z.array(z.string().min(1)).min(1),
  toolCalls: z.number().int().nonnegative(), errors: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(), refusals: z.number().int().nonnegative(),
});

/** R-17 reuses the benchmark preregistration, result and rollout stores.
 * config.managedCapabilityTrial extends the frozen config with assignments;
 * envFingerprint retains the execution witness. Never infer a corpus from the
 * surviving results. A live pilot remains separate evidence.
 */
export async function getManagedCapabilityEffectiveness(runId: string, opts: DbScope = {}) {
  const unknown = (issue: string): ReturnType<typeof evaluateManagedCapabilityEffectiveness> =>
    ({ verdict: 'unknown', issues: [issue], clients: [] });
  const prereg = await getPrereg({ runId }, opts);
  if (!prereg || !prereg.gitCommitted || !prereg.gitCommitSha ||
      computePreregHash(prereg.config) !== prereg.preregHash ||
      canonicalJson(prereg.suites) !== canonicalJson(['harness-bench']))
    return unknown('preregistration-unverified');
  const config = trialConfig.safeParse(prereg.config.managedCapabilityTrial);
  if (!config.success) return unknown('trial-assignment-unmeasured');
  const results = await listRunResults({ ...opts, runId, suite: 'harness-bench' });
  const runs: ManagedTrialRun[] = [];
  for (const result of results) {
    const rollout = await getRollout(result.rolloutId, opts);
    const witness = trialWitness.safeParse(rollout?.envFingerprint);
    if (!rollout || !witness.success || rollout.runId !== runId ||
        rollout.preregHash !== prereg.preregHash || rollout.suite !== result.suite ||
        rollout.taskId !== result.taskId || rollout.arm !== result.arm || rollout.seed !== result.seed ||
        rollout.modelId !== result.modelId || rollout.graderFamily !== result.graderFamily ||
        rollout.graderVersion !== result.graderVersion || !rollout.rawGraderOutput?.trim() ||
        result.rawGraderOutputRef !== `rollout:${rollout.rolloutId}#grader` ||
        canonicalJson(rollout.configSnapshot?.managedCapabilityTrial ?? null) !==
          canonicalJson(prereg.config.managedCapabilityTrial))
      return unknown(`rollout-witness-unverified:${result.rolloutId}`);
    runs.push({ result, witness: witness.data });
  }
  return evaluateManagedCapabilityEffectiveness({ ...config.data,
    runId, preregHash: prereg.preregHash, registeredAt: prereg.createdAt,
    registrationCommit: prereg.gitCommitSha }, runs);
}

/** bigint/numeric columns arrive as strings from postgres.js — coerce to number. */
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * jsonb columns come back as STRINGS under the production-faithful client
 * (prepare:false; see libs/papercusp/libs/db/src/connection.ts) — parse them.
 * Tolerates an already-parsed object too, so it's correct under any client.
 */
function asJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToTaskRunResult(r: any): TaskRunResult {
  return {
    runId: r.run_id,
    suite: r.suite,
    modality: r.modality,
    taskId: r.task_id,
    arm: r.arm,
    seed: Number(r.seed),
    resolved: r.resolved === null || r.resolved === undefined ? null : Boolean(r.resolved),
    score: numOrNull(r.score),
    graderStatus: r.grader_status,
    graderFamily: r.grader_family,
    graderVersion: r.grader_version,
    failToPass: asJson<TestOutcome[]>(r.fail_to_pass),
    passToPass: asJson<TestOutcome[]>(r.pass_to_pass),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    tokensTotal: num(r.tokens_total),
    tokensCacheRead: numOrNull(r.tokens_cache_read),
    tokensCacheWrite: numOrNull(r.tokens_cache_write),
    costUsd: num(r.cost_usd),
    priceTableVersion: r.price_table_version,
    wallClockMs: num(r.wall_clock_ms),
    turns: num(r.turns),
    budgetTokens: numOrNull(r.budget_tokens),
    capped: Boolean(r.capped),
    generationStatus: r.generation_status,
    generationError: r.generation_error ?? null,
    armMeta: asJson<Record<string, unknown>>(r.arm_meta),
    modelId: r.model_id,
    harnessVersion: r.harness_version,
    preregHash: r.prereg_hash,
    rolloutId: r.rollout_id,
    rawGraderOutputRef: r.raw_grader_output_ref ?? null,
    submissionRef: r.submission_ref ?? null,
    createdAt: toIso(r.created_at),
  };
}

function rowToRollout(r: any): RolloutRecord {
  return {
    rolloutId: r.rollout_id,
    runId: r.run_id,
    preregHash: r.prereg_hash,
    suite: r.suite,
    taskId: r.task_id,
    arm: r.arm,
    seed: Number(r.seed),
    configSnapshot: asJson<Record<string, unknown>>(r.config_snapshot),
    modelId: r.model_id,
    modelVersion: r.model_version ?? null,
    harnessVersion: r.harness_version,
    harnessGitSha: r.harness_git_sha ?? null,
    envFingerprint: asJson<Record<string, unknown>>(r.env_fingerprint),
    graderFamily: r.grader_family,
    graderVersion: r.grader_version,
    graderOutput: asJson(r.grader_output),
    rawGraderOutput: r.raw_grader_output ?? null,
    submission: r.submission ?? null,
    trajectoryRef: r.trajectory_ref ?? null,
    trajectoryKind: r.trajectory_kind ?? null,
    createdAt: toIso(r.created_at),
  };
}

function rowToPrereg(r: any): PreregRecord {
  return {
    preregHash: r.prereg_hash,
    runId: r.run_id,
    label: r.label ?? null,
    suites: asJson<PreregRecord['suites']>(r.suites) ?? [],
    config: asJson<Record<string, unknown>>(r.config) ?? {},
    filePath: r.file_path,
    gitCommitted: Boolean(r.git_committed),
    gitCommitSha: r.git_commit_sha ?? null,
    createdAt: toIso(r.created_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The per-(task × arm × seed) rows for a run (and optionally one suite), as TaskRunResult[]. */
export async function listRunResults(
  opts: { runId?: string; suite?: string } & DbScope = {},
): Promise<TaskRunResult[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_run_result
     WHERE workspace_id = ${ws}
       ${opts.runId ? sql`AND run_id = ${opts.runId}` : sql``}
       ${opts.suite ? sql`AND suite = ${opts.suite}` : sql``}
     ORDER BY suite, task_id, arm, seed
  `;
  return rows.map(rowToTaskRunResult);
}

/** Resolve the same immutable population for canonical and portable reports. */
export function resolveRunReportAssignment(rows: readonly Pick<TaskRunResult,
  'runId' | 'suite' | 'arm' | 'preregHash' | 'modelId' | 'tokensCacheWrite'>[], prereg: PreregRecord | null): AggregateOpts {
  let assignment: AggregateOpts = {};
  // Current protocols freeze structured execution controls per arm. Validate
  // the complete contract even if the task roster is missing; old string
  // rosters retain their original report semantics.
  const currentProtocol = prereg ? currentProtocolFromConfig(prereg.config) : null;
  if (currentProtocol && currentProtocol.runId !== prereg!.runId) {
    throw new Error('benchmark report: current protocol differs from frozen run identity');
  }
  if (prereg?.config.taskIds !== undefined) {
    const { taskIds, seeds, arms, arm } = prereg.config;
    const stringRoster = (value: unknown, label: string): string[] => {
      if (!Array.isArray(value) || value.length === 0 ||
          value.some(v => typeof v !== 'string' || !v.trim()) || new Set(value).size !== value.length) {
        throw new Error(`benchmark report: invalid frozen ${label} roster`);
      }
      return value as string[];
    };
    const assignedTaskIds = stringRoster(taskIds, 'task');
    const assignedArms = stringRoster(currentProtocol?.arms.map(value => value.id) ??
      arms ?? (typeof arm === 'string' ? [arm] : undefined), 'arm');
    const assignedSeeds = typeof seeds === 'number' && Number.isSafeInteger(seeds) && seeds > 0 && seeds <= 10000
      ? Array.from({ length: seeds }, (_, i) => i) : seeds;
    if (!Array.isArray(assignedSeeds) || assignedSeeds.length === 0 ||
        assignedSeeds.some(seed => !Number.isSafeInteger(seed) || seed < 0) ||
        new Set(assignedSeeds).size !== assignedSeeds.length) {
      throw new Error('benchmark report: invalid frozen seed roster');
    }
    // Existing taskIds is a flat roster; it cannot truthfully describe multiple suites.
    if (prereg.suites.length !== 1 || rows.some(row => row.runId !== prereg.runId || row.suite !== prereg.suites[0])) {
      throw new Error('benchmark report: frozen assignment has ambiguous run or suite identity');
    }
    assignment = { assignedTaskIds, assignedArms, assignedSeeds, runId: prereg.runId, suite: prereg.suites[0] };
    if (currentProtocol) {
      const models = new Map(currentProtocol.arms.map(value => [value.id, value.model]));
      for (const row of rows) {
        if (row.preregHash !== prereg.preregHash || row.modelId !== models.get(row.arm)) {
          throw new Error('benchmark report: result model or preregistration differs from frozen current protocol');
        }
      }
      assignment.priceTable = currentProtocolPriceTable(currentProtocol, rows);
      assignment.requireRegisteredSampling = true;
      if (currentProtocol.sampling) {
        const sampling = currentProtocol.sampling;
        assignment.repositoryByTask = Object.fromEntries(assignedTaskIds.map(id => [id, sampling.taskRepositories[id]]));
        assignment.ci = sampling.ci;
        assignment.bootstrapSeed = sampling.bootstrapSeed;
        assignment.bootstrapIterations = sampling.bootstrapIterations;
      }
    }
  }
  return assignment;
}

/** Use the existing immutable preregistration, never an observed-row task roster. */
export function buildRunReports(rows: TaskRunResult[], prereg: PreregRecord | null): SuiteReport[] {
  const assignment = resolveRunReportAssignment(rows, prereg);
  const bySuite = new Map<string, TaskRunResult[]>();
  for (const row of rows) {
    const group = bySuite.get(row.suite) ?? [];
    group.push(row);
    bySuite.set(row.suite, group);
  }
  if (assignment.suite && !bySuite.has(assignment.suite)) bySuite.set(assignment.suite, []);
  return [...bySuite.values()].map(group => {
    const report = buildSuiteReport(group, assignment);
    if (assignment.priceTable) report.priceTableVersion = assignment.priceTable.version;
    if (prereg) report.assignment = {
      ...report.assignment!, preregHash: prereg.preregHash, protocolCommitted: prereg.gitCommitted,
    };
    return report;
  });
}

export async function getRunReports(runId: string, opts: { suite?: string } & DbScope = {}): Promise<SuiteReport[]> {
  const [rows, prereg] = await Promise.all([
    listRunResults({ ...opts, runId, suite: undefined }), getPrereg({ runId }, opts),
  ]);
  return buildRunReports(rows, prereg).filter(report => !opts.suite || report.suite === opts.suite);
}

export interface SuiteSummary {
  suite: string;
  runs: number;
  attempts: number;
  resolved: number;
  /** Attempts excluded from accuracy (resolved IS NULL — generation/grader infra). */
  infra: number;
  latestAt: string | null;
}

/** Suite scoreboard for the Evaluation UI's "External benchmarks" tab. */
export async function listSuites(opts: { runId?: string } & DbScope = {}): Promise<SuiteSummary[]> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<
    {
      suite: string;
      runs: number;
      attempts: number;
      resolved: number;
      infra: number;
      latest_at: Date | null;
    }[]
  >`
    SELECT suite,
           count(DISTINCT run_id)::int AS runs,
           count(*)::int AS attempts,
           count(*) FILTER (WHERE resolved IS TRUE)::int AS resolved,
           count(*) FILTER (WHERE resolved IS NULL)::int AS infra,
           max(created_at) AS latest_at
      FROM harness_shared.benchmark_run_result
     WHERE workspace_id = ${ws}
       ${opts.runId ? sql`AND run_id = ${opts.runId}` : sql``}
     GROUP BY suite
     ORDER BY suite
  `;
  return rows.map((r) => ({
    suite: r.suite,
    runs: r.runs,
    attempts: r.attempts,
    resolved: r.resolved,
    infra: r.infra,
    latestAt: r.latest_at ? toIso(r.latest_at) : null,
  }));
}

/** The full Rollout Card for one rollout (the published repro artifact). */
export async function getRollout(rolloutId: string, opts: DbScope = {}): Promise<RolloutRecord | null> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_rollout
     WHERE rollout_id = ${rolloutId} AND workspace_id = ${ws} LIMIT 1
  `;
  return rows.length ? rowToRollout(rows[0]) : null;
}

/** The pre-registration row, by hash or by run id. */
export async function getPrereg(
  by: { preregHash?: string; runId?: string },
  opts: DbScope = {},
): Promise<PreregRecord | null> {
  const { sql, ws } = resolveDb(opts);
  if (!by.preregHash && !by.runId) return null;
  const rows = await sql`
    SELECT * FROM harness_shared.benchmark_prereg
     WHERE workspace_id = ${ws}
       ${by.preregHash ? sql`AND prereg_hash = ${by.preregHash}` : sql``}
       ${by.runId ? sql`AND run_id = ${by.runId}` : sql``}
     LIMIT 1
  `;
  return rows.length ? rowToPrereg(rows[0]) : null;
}

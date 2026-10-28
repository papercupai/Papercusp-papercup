/**
 * `system:sql-read-census` — the nightly SQL-read census
 * (plan `sql-escape-tool-routing-2026-08-12`, P-008).
 *
 * The recurring half of the raw-SQL escape-hatch work. Every night it reads the
 * `dev:pg_query` corpus, folds it into (relation, claiming intent) clusters,
 * writes one row per cluster to `harness_shared.sql_read_census`, and wakes an
 * agent ONLY when a threshold moves. The judgement lives entirely in
 * `bash-substitution/sql-census.ts` as pure functions; this file is the seam that
 * reads, writes, debounces and escalates.
 *
 * Config (routine `trigger_config`):
 *   - `window_days`        — corpus lookback (default 7).
 *   - `agent_threshold`    — (a) uncovered-demand floor in distinct agents.
 *   - `grace_days`         — (c) days after ship before the check applies.
 *   - `required_fall_pct`  — (c) fraction of pre-ship agents that must go away.
 *
 * Env kill switches (the `<=0` convention the sibling watchdog floors use, so a
 * noisy leg can be silenced without a code change or a deploy):
 *   - PAPERCUSP_SQL_CENSUS_AGENT_THRESHOLD  <= 0 disables (a).
 *   - PAPERCUSP_SQL_CENSUS_REQUIRED_FALL_PCT <= 0 disables (c).
 *
 * ⚠ THE WRITE IS IDEMPOTENT ON PURPOSE — `SET = EXCLUDED`, never `+= EXCLUDED`.
 * The census re-reads a trailing window every night, so accumulating would
 * inflate a cluster by roughly `window_days` within a week. This is the exact
 * semantic difference that disqualified reusing `tool_usage_rollup`, whose writer
 * is an incremental ingester that never re-reads bytes (migration 811).
 */
import { getOrgPg } from '@papercusp/db-org';
import { createHmac } from 'node:crypto';
import { getDbEncryptionKey } from '../../db-encryption';
import { mineSqlCandidateSlice, purgeSqlCandidateData, readSqlCandidates, type SqlMiningDeps, type SqlMiningOptions,
  type SqlMiningResult } from '../../bash-substitution/sql-tool-candidates';
import { rankSqlToolCandidates, SQL_DEMAND_SCORE_VERSION } from '../../sql-tool-candidate-score';
import { submitSqlCandidateReview, submitMonitoredCandidateReview } from '../../sql-tool-candidate-review';
import { recordSqlCandidateFeedback } from '../../sql-tool-candidate-feedback';
import type { SqlRepairMeasurement } from '../../bash-substitution/sql-census';
import { miningFailureReason } from '../../agent-opportunities/pipeline';
import { runMonitoredCensus } from '../../agent-opportunities/census';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { fetchSqlCorpusAtoms } from '../../bash-substitution/sql-corpus';
import { SQL_READ_NO_PAIR_DECISIONS, SQL_READ_PAIRS } from '../../bash-substitution/pairs';
import {
  buildCensusEscalation,
  computeSqlCensus,
  evaluateDeliberateNoPairDrift,
  evaluateNoFallAfterShip,
  evaluateUncoveredDemand,
  evaluateVerdictDrift,
  type CensusCluster,
  type PriorCensusRow,
} from '../../bash-substitution/sql-census';
import { recentWatchdogFires, recordFire } from '../../pot/watchdog';
import { openEscalation } from '../../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** Corpus lookback when the routine row does not say. */
export const DEFAULT_CENSUS_WINDOW_DAYS = 7;

/** How far back the (c) check reads census history. Must exceed grace_days comfortably. */
export const CENSUS_HISTORY_DAYS = 120;

/** How long one alarm CLASS stays debounced. A gap that persists is not new news nightly. */
export const CENSUS_DEBOUNCE_HOURS = 7 * 24;

/**
 * (a)'s floor in DISTINCT AGENTS over the window. Default 10, the owner's proposed
 * N. `<=0` disables the leg.
 */
export function censusAgentThreshold(fallback = 10): number {
  const raw = process.env.PAPERCUSP_SQL_CENSUS_AGENT_THRESHOLD;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** (c)'s required fall as a fraction of pre-ship agents. Default 0.3; `<=0` disables the leg. */
export function censusRequiredFallPct(fallback = 0.3): number {
  const raw = process.env.PAPERCUSP_SQL_CENSUS_REQUIRED_FALL_PCT;
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Synthetic identity for the background census escalation (mirrors the sibling watchdogs'). */
const CENSUS_IDENTITY: AgentIdentity = {
  ownerId: 'sql-read-census',
  ownerLabel: 'system · sql-read-census',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** UTC calendar date, which is the grain `ran_on` is keyed on. */
export function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface CensusRunResult {
  outcome: 'wrote' | 'alerted' | 'debounced' | 'empty' | 'error';
  ranOn: string;
  clusters: number;
  uncovered: number;
  drift: number;
  noFall: number;
  deliberateNoPairDrift: number;
  reason?: string;
}

export interface SqlReadCensusDeps {
  fetchAtoms?: typeof fetchSqlCorpusAtoms;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/** Persist tonight's clusters. Idempotent per (night, relation, intent). */
async function writeCensus(
  workspaceId: string,
  ranOn: string,
  windowDays: number,
  clusters: readonly CensusCluster[],
): Promise<void> {
  if (clusters.length === 0) return;
  const { sql } = getOrgPg();
  for (const c of clusters) {
    await sql`
      INSERT INTO harness_shared.sql_read_census (
        workspace_id, ran_on, window_days, relation, intent_label, relation_has_pairs,
        deliberately_unpaired, deliberate_decision_ref,
        deliberate_baseline_window_days, deliberate_baseline_calls,
        deliberate_baseline_atoms, deliberate_baseline_distinct_agents,
        covering_tool, equivalence_verdict, distinct_agents, calls,
        relation_distinct_agents, relation_calls, sample_atom
      ) VALUES (
        ${workspaceId}, ${ranOn}::date, ${windowDays}, ${c.relation}, ${c.intentLabel},
        ${c.relationHasPairs}, ${c.deliberatelyUnpaired},
        ${c.deliberateNoPairDecision?.decisionRef ?? null},
        ${c.deliberateNoPairDecision?.baseline.windowDays ?? null},
        ${c.deliberateNoPairDecision?.baseline.calls ?? null},
        ${c.deliberateNoPairDecision?.baseline.atoms ?? null},
        ${c.deliberateNoPairDecision?.baseline.distinctAgents ?? null},
        ${c.coveringTool}, ${c.equivalenceVerdict},
        ${c.distinctAgents}, ${c.calls}, ${c.relationDistinctAgents}, ${c.relationCalls},
        ${c.sampleAtom}
      )
      ON CONFLICT (workspace_id, ran_on, relation, (COALESCE(intent_label, ''))) DO UPDATE SET
        window_days              = EXCLUDED.window_days,
        relation_has_pairs       = EXCLUDED.relation_has_pairs,
        deliberately_unpaired    = EXCLUDED.deliberately_unpaired,
        deliberate_decision_ref = EXCLUDED.deliberate_decision_ref,
        deliberate_baseline_window_days = EXCLUDED.deliberate_baseline_window_days,
        deliberate_baseline_calls = EXCLUDED.deliberate_baseline_calls,
        deliberate_baseline_atoms = EXCLUDED.deliberate_baseline_atoms,
        deliberate_baseline_distinct_agents = EXCLUDED.deliberate_baseline_distinct_agents,
        covering_tool            = EXCLUDED.covering_tool,
        equivalence_verdict      = EXCLUDED.equivalence_verdict,
        distinct_agents          = EXCLUDED.distinct_agents,
        calls                    = EXCLUDED.calls,
        relation_distinct_agents = EXCLUDED.relation_distinct_agents,
        relation_calls           = EXCLUDED.relation_calls,
        sample_atom              = EXCLUDED.sample_atom,
        computed_at              = now()
    `;
  }
}

/** Census history STRICTLY BEFORE tonight — tonight's own rows are the `tonight` argument. */
async function readHistory(workspaceId: string, ranOn: string): Promise<PriorCensusRow[]> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT ran_on::text AS ran_on, relation, intent_label, covering_tool,
           equivalence_verdict, distinct_agents, relation_distinct_agents
      FROM harness_shared.sql_read_census
     WHERE workspace_id = ${workspaceId}
       AND ran_on < ${ranOn}::date
       -- The ::integer cast is LOAD-BEARING, not decoration. Without it Postgres
       -- resolves the untyped bind against 'date - date -> integer' rather than
       -- 'date - integer -> date', and the whole predicate fails at runtime with
       -- "operator does not exist: date >= integer". Caught only by the live run --
       -- the pure tests never reach SQL (WI-38296).
       AND ran_on >= ${ranOn}::date - ${CENSUS_HISTORY_DAYS}::integer
     ORDER BY ran_on
  `) as unknown as Array<{
    ran_on: string;
    relation: string;
    intent_label: string | null;
    covering_tool: string | null;
    equivalence_verdict: string | null;
    distinct_agents: number;
    relation_distinct_agents: number;
  }>;
  return rows.map((r) => ({
    ranOn: r.ran_on,
    relation: r.relation,
    intentLabel: r.intent_label,
    coveringTool: r.covering_tool,
    equivalenceVerdict: (r.equivalence_verdict as PriorCensusRow['equivalenceVerdict']) ?? null,
    distinctAgents: Number(r.distinct_agents),
    relationDistinctAgents: Number(r.relation_distinct_agents),
  }));
}

/**
 * One census run.
 *
 * Fail-soft end to end: a census that throws must not fail the routines tick it
 * rides in, and an escalation that fails must not lose the measurement — so the
 * WRITE happens before the alarms are evaluated. That ordering matters more than
 * it looks: the row written tonight is the pre-ship baseline some future night's
 * (c) check reads, and losing it because a coord write failed would silently
 * blind the only alarm that reports a failed repair.
 */
export async function runSqlReadCensus(
  opts: { workspaceId?: string; installSlug?: string; windowDays?: number; agentThreshold?: number; graceDays?: number; requiredFallPct?: number } = {},
  deps: SqlReadCensusDeps = {},
): Promise<CensusRunResult> {
  const now = deps.now ?? Date.now();
  const ranOn = utcDate(now);
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const installSlug = opts.installSlug?.trim() || operatorHomeHarnessSlug();
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? DEFAULT_CENSUS_WINDOW_DAYS));
  const base: CensusRunResult = {
    outcome: 'empty',
    ranOn,
    clusters: 0,
    uncovered: 0,
    drift: 0,
    noFall: 0,
    deliberateNoPairDrift: 0,
  };

  try {
    const atoms = await (deps.fetchAtoms ?? fetchSqlCorpusAtoms)({ workspaceId, windowDays });
    const clusters = computeSqlCensus(atoms, SQL_READ_PAIRS, SQL_READ_NO_PAIR_DECISIONS);
    if (clusters.length === 0) {
      return { ...base, reason: 'corpus held no plain single-relation reads' };
    }
    await writeCensus(workspaceId, ranOn, windowDays, clusters);

    const history = await readHistory(workspaceId, ranOn);
    const uncovered = evaluateUncoveredDemand(clusters, censusAgentThreshold(opts.agentThreshold ?? 10));
    const drift = evaluateVerdictDrift(clusters, history);
    const deliberateNoPairDrift = evaluateDeliberateNoPairDrift(clusters);
    const noFall = evaluateNoFallAfterShip(clusters, history, {
      today: ranOn,
      graceDays: opts.graceDays,
      requiredFallPct: censusRequiredFallPct(opts.requiredFallPct ?? 0.3),
    });

    const counts = {
      ...base,
      clusters: clusters.length,
      uncovered: uncovered.length,
      drift: drift.length,
      noFall: noFall.length,
      deliberateNoPairDrift: deliberateNoPairDrift.length,
    };

    const escalation = buildCensusEscalation({ uncovered, drift, noFall, deliberateNoPairDrift }, windowDays);
    if (!escalation) return { ...counts, outcome: 'wrote' };

    // Debounce per ALARM CLASS, not per run: a gap that persists for a fortnight is
    // not new news every night, but a NEW class crossing must not be suppressed by
    // an older one still inside its window — which is the failure the rubric
    // watchdog had to fix (EI-16071) when its key was source-only.
    const scopeKey = escalation.scopeKeys.join('+');
    const firedRecently =
      (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
        workspaceId,
        installSlug,
        CENSUS_DEBOUNCE_HOURS,
        'sql-read-census',
        scopeKey,
      )) > 0;
    if (firedRecently) return { ...counts, outcome: 'debounced', reason: `fires-ledger debounce (${scopeKey})` };

    await (deps.recordFire ?? recordFire)({
      workspaceId,
      installSlug,
      source: 'sql-read-census',
      reason: `${escalation.summary} [${scopeKey}]`,
      wakeAt: null,
    });
    await (deps.openEscalation ?? openEscalation)(CENSUS_IDENTITY, {
      severity: 'advisory',
      summary: escalation.summary,
      body: escalation.body,
    });
    return { ...counts, outcome: 'alerted', reason: escalation.summary };
  } catch (e) {
    return { ...base, outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Same production cadence; source dispatch has no dependency on this background path. */
export interface SqlIntentCensusDeps extends SqlMiningDeps {
  review?: typeof submitSqlCandidateReview;
  monitoredReview?: typeof submitMonitoredCandidateReview;
  feedback?: typeof recordSqlCandidateFeedback;
  /** Trusted exposure/coverage adapter; absence is explicitly UNKNOWN in the ledger. */
  repairMeasurement?: (review: Awaited<ReturnType<typeof submitSqlCandidateReview>>) => Promise<SqlRepairMeasurement | null>;
}
export const SQL_CENSUS_REVIEW_LIMIT = 10;
export function censusMiningOptions(opts: Omit<SqlMiningOptions, 'scope' | 'authorize'> &
  Partial<Pick<SqlMiningOptions, 'scope' | 'authorize'>>): SqlMiningOptions {
  const epoch = new Date(opts.now ?? Date.now()).toISOString().slice(0, 7);
  return { ...opts, scope: opts.scope ?? { workspaceId: opts.workspaceId, sourceBoundary: 'authorized-tool-ledger', epoch,
    key: createHmac('sha256', getDbEncryptionKey()).update(`sql-intent-mining-v1:${epoch}`).digest() },
  authorize: opts.authorize ?? (async () => true) };
}

/** Same trusted production scope and cadence for every family; no separate routine or opt-in flag. */
export async function runSqlOpportunityCensus(opts: Parameters<typeof censusMiningOptions>[0] & {
  routineId?: string; workflowId?: string;
}, deps: SqlIntentCensusDeps = {}) {
  let sqlResult: Awaited<ReturnType<typeof runSqlIntentCensus>> = {
    status: 'UNKNOWN', stage: 'source', reason: 'sql_mining_source_missing', rows: 0 };
  let sqlWork: Promise<typeof sqlResult> | undefined;
  try {
    const miningOpts = censusMiningOptions(opts);
    // Existing SQL mining/intake must keep running even if the new monitoring
    // tables are unavailable. Share one promise: no second SQL slice on failure.
    sqlWork = runSqlIntentCensus(miningOpts, deps);
    const monitored = await runMonitoredCensus({ ...miningOpts, routineId: opts.routineId, workflowId: opts.workflowId },
      async () => { sqlResult = await sqlWork!; return sqlResult; });
    sqlResult = await sqlWork;
    // The existing reservation/intake workflow owns all families. Diagnostics
    // choose a bounded batch; only a fresh canonical evidence read admits it.
    const candidates = monitored.families.filter(f => f.family !== 'sql').flatMap(f =>
      (f.diagnostics.candidates as Array<{ id: string; reviewEligible: boolean }> ?? [])
        .filter(c => c.reviewEligible).map(c => ({ family: f.family as Exclude<typeof f.family, 'sql'>, id: c.id })))
      .sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
    const selected = candidates.slice(0, SQL_CENSUS_REVIEW_LIMIT);
    const reviews = [];
    for (const candidate of selected) {
      try {
        const review = await (deps.monitoredReview ?? submitMonitoredCandidateReview)({ ...miningOpts,
          runId: monitored.runId, family: candidate.family, candidateId: candidate.id,
          submittedBy: 'system:sql-read-census', contractRef: 'monitored-review-demand-v1' }, { client: opts.client });
        reviews.push({ family: candidate.family, candidateId: candidate.id, ...review });
      } catch (error) {
        reviews.push({ family: candidate.family, candidateId: candidate.id, status: 'UNKNOWN' as const,
          stage: 'review' as const, reason: miningFailureReason(error) });
      }
    }
    // Retain review-stage failures with the same normalized family run. These
    // are opaque links/statuses; fresh evidence reads still guard every intake.
    const client = opts.client ?? getOrgPg().sql;
    const reviewFields = new Set(['family', 'candidateId', 'lifecycleId', 'editionId', 'workItemId', 'status', 'stage', 'reason']);
    for (const family of new Set(selected.map(c => c.family))) {
      // Current ownership is read from the canonical review item on demand;
      // never retain an actor identity in the minimized 120-day family rows.
      const links = reviews.filter(r => r.family === family).map(r => Object.fromEntries(
        Object.entries(r).filter(([key]) => reviewFields.has(key))));
      await client`UPDATE harness_shared.sql_intent_family_runs
        SET diagnostics=jsonb_set(diagnostics,'{reviewIntake}',${JSON.stringify(links)}::jsonb)
        WHERE workspace_id=${opts.workspaceId} AND run_id=${monitored.runId}::uuid AND family=${family}`;
    }
    return { sql: sqlResult, monitored, monitoredReviewIntake: {
      selected: selected.length, outsideBatch: candidates.length - selected.length, reviews } };
  } catch (error) {
    if (sqlWork) sqlResult = await sqlWork;
    return { sql: sqlResult, monitored: null, reason: miningFailureReason(error) };
  }
}
export async function runSqlIntentCensus(
  opts: Omit<SqlMiningOptions, 'scope' | 'authorize'> & Partial<Pick<SqlMiningOptions, 'scope' | 'authorize'>>,
  deps: SqlIntentCensusDeps = {},
): Promise<SqlMiningResult & { purgeBreach?: boolean; reviewIntake?: { selected: number; outsideBatch: number } }> {
  let purgeBreach = false;
  let reviewIntake: { selected: number; outsideBatch: number } | undefined;
  try {
    const purge = await purgeSqlCandidateData(opts);
    purgeBreach = purge.breach;
  } catch {
    // Mining may still advance. Expiry is enforced by reads even with a failed purge worker.
    purgeBreach = true;
  }
  try {
    // Host-key custody stays outside the repo. Exposed reads still require current ACL callbacks.
    const miningOpts = censusMiningOptions(opts), scope = miningOpts.scope;
    const result = await mineSqlCandidateSlice(miningOpts, { ...deps, alert: async packet => {
      // This callback runs only after summary+cursor commit, and remains pending on failure.
      // The bounded top-ranked intake is advisory review demand, never a new-tool verdict.
      const snapshots = await readSqlCandidates({ ...miningOpts, ranOn: packet.ranOn,
        authorizeSource: async () => miningOpts.authorize({ workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug, sourceBoundary: scope.sourceBoundary }) });
      if (snapshots.length !== 1) throw new Error('sql_candidate_review_source_unavailable');
      for (const snapshot of snapshots) {
        const candidates = rankSqlToolCandidates(snapshot.summary).candidates.filter(c => c.eligible);
        const selected = candidates.slice(0, SQL_CENSUS_REVIEW_LIMIT);
        reviewIntake = { selected: selected.length, outsideBatch: candidates.length - selected.length };
        for (const candidate of selected) {
          const reviewed = await (deps.review ?? submitSqlCandidateReview)({
            workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
            submittedBy: 'system:sql-read-census', candidate,
            sourceRef: { scopeId: packet.scopeId, ranOn: packet.ranOn },
            contractRef: `sql-review-demand-v1:${candidate.parserVersion}:${SQL_DEMAND_SCORE_VERSION}`,
          }, { client: opts.client });
          if (reviewed.status === 'UNKNOWN') throw new Error('sql_candidate_review_unavailable');
          await (deps.feedback ?? recordSqlCandidateFeedback)({ workspaceId: opts.workspaceId,
            harnessSlug: opts.harnessSlug, review: reviewed,
            sourceRef: { scopeId: packet.scopeId, ranOn: packet.ranOn },
            repair: reviewed.status === 'accepted' ? await deps.repairMeasurement?.(reviewed) ?? null : null,
          // The results-ledger seam intentionally types bind values as unknown;
          // postgres.Sql's overload accepts only driver values. Same adapter as its default client.
          }, { client: opts.client as unknown as NonNullable<Parameters<typeof recordSqlCandidateFeedback>[1]>['client'] });
        }
      }
      await deps.alert?.(packet);
    } });
    return { ...result, purgeBreach, ...(reviewIntake ? { reviewIntake } : {}) };
  } catch (error) {
    return { status: 'UNKNOWN', stage: 'source', reason: miningFailureReason(error), rows: 0, purgeBreach };
  }
}

registerSystemAction('sql-read-census', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const [result, opportunities] = await Promise.all([runSqlReadCensus({
    workspaceId: ctx.workspaceId,
    windowDays: num(cfg.window_days),
    agentThreshold: num(cfg.agent_threshold),
    graceDays: num(cfg.grace_days),
    requiredFallPct: num(cfg.required_fall_pct),
  }), runSqlOpportunityCensus({ workspaceId: ctx.workspaceId, harnessSlug: ctx.installSlug,
    routineId: ctx.routineId, workflowId: ctx.workflowId,
    rowBudget: num(cfg.intent_row_budget), timeBudgetMs: num(cfg.intent_time_budget_ms) })]);
  const intents = opportunities.sql;
  const line =
    `[sql-read-census] ${ctx.workspaceId} ${result.ranOn}: ${result.outcome} — ` +
    `${result.clusters} cluster(s), uncovered ${result.uncovered}, drift ${result.drift}, ` +
    `no-pair drift ${result.deliberateNoPairDrift}, no-fall ${result.noFall}` +
    (result.reason ? ` (${result.reason})` : '');
  if (result.outcome === 'error' || result.outcome === 'alerted') console.warn(line);
  else console.log(line);
  if (intents.status === 'UNKNOWN' || intents.purgeBreach)
    console.warn(`[sql-intent-census] ${ctx.workspaceId}: ${intents.status} stage=${intents.stage} reason=${intents.reason ?? 'none'} purgeBreach=${intents.purgeBreach}`);
  return { diagnostics: { sqlRead: result, sqlIntent: intents, opportunities: opportunities.monitored },
    ...(intents.status === 'UNKNOWN' || intents.purgeBreach || !opportunities.monitored
      ? { softError: `sql-intent-census ${intents.status} stage=${intents.stage} reason=${intents.reason ?? 'none'} purgeBreach=${intents.purgeBreach}` }
      : {}) };
});

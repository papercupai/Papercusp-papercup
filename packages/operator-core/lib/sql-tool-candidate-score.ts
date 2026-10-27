/** P-003: deterministic, passive ranking of the P-002 corpus. Never executes SQL. */
import type { SqlDemandAggregate, SqlDemandCoverage, SqlDemandStatus } from './bash-substitution/sql-intent-corpus';
import { compareDemandRank, explainDemandScore, linearDemandScore, logDemandScore, type DemandScoreComponent } from './demand-score';

export const SQL_DEMAND_SCORE_VERSION = 'sql-demand-score-v1';
export const SQL_DEMAND_SCORE_POLICY = Object.freeze({
  minSuccessfulCalls: 10, minVerifiedAgents: 3, minActiveDays: 2,
  frequencySaturation: 20, breadthSaturation: 5, daySaturation: 7,
  /** Mean successful dispatch wall-time. No token, model-cost or savings estimate. */
  costSaturationMs: 1000,
});
export type SqlDemandScorePolicy = { -readonly [K in keyof typeof SQL_DEMAND_SCORE_POLICY]: number };
export interface SqlToolCandidateScore {
  id: string;
  workspaceToken: string;
  harnessToken: string;
  boundaryToken: string;
  fingerprint: string;
  parserVersion: string;
  policyVersion: typeof SQL_DEMAND_SCORE_VERSION;
  eligible: boolean;
  reasons: string[];
  score: number;
  components: DemandScoreComponent[];
  counts: Record<SqlDemandStatus, number>;
  verifiedAgents: number;
  activeDays: string[];
  observedCost: { measuredCalls: number; totalMs: number; meanMs: number | null; unit: 'dispatch-wall-ms' };
}

/** Floors may be configured, weights and their meaning are fixed by the version. */
export function rankSqlToolCandidates(
  aggregate: SqlDemandAggregate,
  overrides: Partial<SqlDemandScorePolicy> = {},
): { candidates: SqlToolCandidateScore[]; coverage: SqlDemandCoverage; policy: SqlDemandScorePolicy; residue: {
  unknownIdentityRows: number; unknownParseOperations: number; collisions: number; excludedCalls: number;
} } {
  const policy = { ...SQL_DEMAND_SCORE_POLICY, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0 || (!key.endsWith('Ms') && !Number.isInteger(value)))
      throw new Error(`invalid_sql_demand_policy:${key}`);
  }
  const groups = new Map<string, { candidate: SqlToolCandidateScore; agents: Set<string>; days: Set<string> }>();
  let excludedCalls = 0;
  for (const row of aggregate.daily) {
    // No recipe tool-count/cohesion gate: a useful SQL abstraction can be one tool.
    if (row.origin !== 'agent' || row.agentTokens.length === 0) { excludedCalls += row.logicalCalls; continue; }
    const id = JSON.stringify([row.workspaceToken, row.harnessToken, row.boundaryToken, row.version, row.fingerprint]);
    let group = groups.get(id);
    if (!group) {
      group = { candidate: { id, workspaceToken: row.workspaceToken, harnessToken: row.harnessToken,
        boundaryToken: row.boundaryToken, fingerprint: row.fingerprint, parserVersion: row.version,
        policyVersion: SQL_DEMAND_SCORE_VERSION, eligible: false, reasons: [], score: 0, components: [],
        counts: { ok: 0, error: 0, refused: 0, unknown: 0 }, verifiedAgents: 0, activeDays: [],
        observedCost: { measuredCalls: 0, totalMs: 0, meanMs: null, unit: 'dispatch-wall-ms' } },
      agents: new Set(), days: new Set() };
      groups.set(id, group);
    }
    const candidate = group.candidate;
    candidate.counts[row.status] += row.logicalCalls;
    if (row.status === 'ok') {
      for (const actor of row.agentTokens) group.agents.add(actor);
      group.days.add(row.day);
      candidate.observedCost.measuredCalls += row.duration.measured;
      candidate.observedCost.totalMs += row.duration.totalMs;
    }
  }
  const uncertain = aggregate.coverage.status !== 'complete' || aggregate.coverage.retention !== 'complete'
    || aggregate.unknownIdentityRows > 0 || aggregate.unknownParseOperations > 0 || aggregate.collisions > 0;
  const candidates = [...groups.values()].map(({ candidate, agents, days }) => {
    candidate.verifiedAgents = agents.size;
    candidate.activeDays = [...days].sort();
    if (candidate.counts.ok < policy.minSuccessfulCalls) candidate.reasons.push('successful-call-floor');
    if (agents.size < policy.minVerifiedAgents) candidate.reasons.push('verified-agent-floor');
    if (days.size < policy.minActiveDays) candidate.reasons.push('active-day-floor');
    if (uncertain) candidate.reasons.push('incomplete-evidence');
    candidate.eligible = candidate.reasons.length === 0;
    const cost = candidate.observedCost;
    cost.meanMs = cost.measuredCalls ? cost.totalMs / cost.measuredCalls : null;
    const total = Object.values(candidate.counts).reduce((sum, count) => sum + count, 0);
    const explanation = explainDemandScore([
      { key: 'breadth', value: linearDemandScore(agents.size, policy.breadthSaturation), weight: .35 },
      { key: 'dayRecurrence', value: linearDemandScore(days.size, policy.daySaturation), weight: .25 },
      { key: 'logFrequency', value: logDemandScore(candidate.counts.ok, policy.frequencySaturation), weight: .20 },
      { key: 'successStability', value: total ? candidate.counts.ok / total : 0, weight: .10 },
      { key: 'observedCost', value: cost.meanMs === null ? 0 : logDemandScore(cost.meanMs, policy.costSaturationMs), weight: .10 },
    ]);
    return { ...candidate, ...explanation };
  }).sort(compareDemandRank);
  return { candidates, coverage: { ...aggregate.coverage, providers: [...aggregate.coverage.providers].sort() }, policy,
    residue: { unknownIdentityRows: aggregate.unknownIdentityRows, unknownParseOperations: aggregate.unknownParseOperations,
      collisions: aggregate.collisions, excludedCalls } };
}

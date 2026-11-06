import { expect, it } from 'vitest';
import { aggregateSqlDemand, observeSqlDemand, type SqlDemandOrigin, type SqlDemandStatus } from './bash-substitution/sql-intent-corpus';
import type { SqlIntentScope } from './bash-substitution/sql-intent-fingerprint';
import { rankSqlToolCandidates, SQL_DEMAND_SCORE_VERSION } from './sql-tool-candidate-score';

const scope: SqlIntentScope = { workspaceId: 'score-test', sourceBoundary: 'sql-ledger', epoch: '2026-10',
  key: new Uint8Array(32).fill(23) };
const coverage = { status: 'complete' as const, scannedRows: 100, cap: 1000,
  retention: 'complete' as const, providers: ['ledger'] };

function observations(opts: { calls?: number; agents?: number; days?: number; origin?: SqlDemandOrigin;
  status?: SqlDemandStatus; durationMs?: number | null; prefix?: string; projection?: string } = {}) {
  return Array.from({ length: opts.calls ?? 10 }, (_, i) => observeSqlDemand({
    workspaceId: scope.workspaceId, harnessSlug: 'alpha', namespace: 'invocations',
    callId: `${opts.prefix ?? 'call'}-${i}`, resultCallId: `${opts.prefix ?? 'call'}-${i}`,
    identityAuthority: 'ledger', provider: 'ledger', actor: `agent-${i % (opts.agents ?? 3)}`, verifiedAgent: true,
    at: `2026-10-${String(20 + i % (opts.days ?? 2)).padStart(2, '0')}T12:00:00Z`,
    origin: opts.origin ?? 'agent', status: opts.status ?? 'ok', durationMs: opts.durationMs === undefined ? 100 : opts.durationMs,
    sql: `SELECT ${opts.projection ?? 'id'} FROM jobs WHERE owner_id='entity-${i}'`, sourceComplete: true,
    copyRef: `${opts.prefix ?? 'call'}-copy-${i}`,
  }, scope));
}
const corpus = (opts: Parameters<typeof observations>[0] = {}) => aggregateSqlDemand(observations(opts), coverage);
const first = (opts: Parameters<typeof observations>[0] = {}) => rankSqlToolCandidates(corpus(opts)).candidates[0]!;

it('R3-CONTRACT', () => {
  const atFloor = first();
  expect(atFloor.eligible).toBe(true);
  expect(atFloor.reasons).toEqual([]);
  expect(atFloor.counts.ok).toBe(10);
  expect(atFloor.verifiedAgents).toBe(3);
  expect(atFloor.activeDays).toHaveLength(2);
  for (const [opts, reason] of [
    [{ calls: 9 }, 'successful-call-floor'], [{ agents: 2 }, 'verified-agent-floor'],
    [{ days: 1 }, 'active-day-floor'],
  ] as const) expect(first(opts)).toMatchObject({ eligible: false, reasons: [reason] });
  expect(first({ calls: 100, agents: 1, days: 7, durationMs: 1_000_000 }))
    .toMatchObject({ eligible: false, reasons: ['verified-agent-floor'] });
  expect(first({ calls: 1, agents: 1, days: 1 }).eligible).toBe(false);
  // A single SQL operation is eligible: no multi-tool/recipe cohesion requirement.
  expect(atFloor.components.map(c => c.key)).toEqual(['breadth', 'dayRecurrence', 'logFrequency', 'successStability', 'observedCost']);
  expect(atFloor.components.map(c => c.weight)).toEqual([.35, .25, .20, .10, .10]);
  expect(atFloor.components.every(c => c.value >= 0 && c.value <= 1)).toBe(true);
  expect(atFloor.score).toBe(atFloor.components.reduce((sum, c) => sum + c.contribution, 0));
  expect(atFloor.policyVersion).toBe(SQL_DEMAND_SCORE_VERSION);
  expect(atFloor.observedCost).toEqual({ measuredCalls: 10, totalMs: 1000, meanMs: 100, unit: 'dispatch-wall-ms' });
  const configured = rankSqlToolCandidates(corpus({ calls: 9, agents: 2, days: 1 }),
    { minSuccessfulCalls: 9, minVerifiedAgents: 2, minActiveDays: 1 });
  expect(configured.candidates[0]!.eligible).toBe(true);
});

it('ranks deduplicated corpus outcomes and exposes unknown residue OUTCOME-P-003', () => {
  const rows = observations();
  const mixed = aggregateSqlDemand([
    ...rows, ...rows.map(r => ({ ...r, sourceToken: `copy-${r.sourceToken}` })),
    ...observations({ prefix: 'poll', origin: 'polling', calls: 100, durationMs: 1_000_000 }),
    ...observations({ prefix: 'fixture', origin: 'fixture', calls: 100 }),
    ...observations({ prefix: 'error', status: 'error', calls: 2 }),
    ...observations({ prefix: 'refused', status: 'refused', calls: 1 }),
    ...observations({ prefix: 'unknown', status: 'unknown', calls: 1 }),
  ], coverage);
  const result = rankSqlToolCandidates(mixed);
  const candidate = result.candidates[0]!;
  expect(candidate.counts).toEqual({ ok: 10, error: 2, refused: 1, unknown: 1 });
  expect(candidate.eligible).toBe(true);
  expect(candidate.components.find(c => c.key === 'successStability')!.value).toBe(10 / 14);
  expect(candidate.observedCost.totalMs).toBe(1000);
  expect(result.residue.excludedCalls).toBe(200);
  const unknown = rankSqlToolCandidates({ ...mixed, unknownIdentityRows: 1,
    coverage: { ...coverage, retention: 'unknown' } });
  expect(unknown.candidates[0]).toMatchObject({ eligible: false, reasons: ['incomplete-evidence'] });
  expect(unknown.residue.unknownIdentityRows).toBe(1);
  const serialized = JSON.stringify(result);
  for (const raw of ['SELECT ', 'entity-', 'score-test', 'agent-0', 'jobs']) expect(serialized).not.toContain(raw);
  expect(serialized).not.toMatch(/tokenSavings|modelSavings|savedTokens/);
});

it('R10 failed replay lowers reliability evidence', () => {
  const successful = observations();
  const rank = (rows: ReturnType<typeof observations>) => rankSqlToolCandidates(aggregateSqlDemand(rows, coverage)).candidates[0]!;
  const before = rank(successful);
  const after = rank([...successful, ...observations({ prefix: 'failed-retry', status: 'error', calls: 1 })]);
  expect(after.counts).toEqual({ ok: 10, error: 1, refused: 0, unknown: 0 });
  expect(after.components.find(c => c.key === 'successStability')!.value).toBe(10 / 11);
  expect(after.score).toBeLessThan(before.score);
  expect(after.observedCost).toEqual(before.observedCost);
  expect(after.verifiedAgents).toBe(before.verifiedAgents);
  const copies = rank([...successful, ...successful, ...observations({ prefix: 'failed-retry', status: 'error', calls: 1 })]);
  expect(copies).toEqual(after);
});

it('is invariant to source order and breaks equal-score ties by scoped identity', () => {
  const rows = [...observations({ prefix: 'left' }), ...observations({ prefix: 'right', projection: 'name' })];
  const forward = rankSqlToolCandidates(aggregateSqlDemand(rows, coverage));
  const reverse = rankSqlToolCandidates(aggregateSqlDemand([...rows].reverse(), coverage));
  expect(reverse).toEqual(forward);
  expect(forward.candidates).toHaveLength(2);
  expect(forward.candidates[0]!.score).toBe(forward.candidates[1]!.score);
  expect(forward.candidates.map(c => c.id)).toEqual(forward.candidates.map(c => c.id).sort());
  const otherBoundary = rows.map(r => ({ ...r, boundaryToken: 'other-boundary' }));
  expect(rankSqlToolCandidates(aggregateSqlDemand([...rows, ...otherBoundary], coverage)).candidates).toHaveLength(4);
});

it('keeps failed demand, missing cost and incomplete scans out of success evidence', () => {
  expect(first({ status: 'error', calls: 30 }).eligible).toBe(false);
  expect(first({ durationMs: null }).observedCost.meanMs).toBeNull();
  expect(first({ durationMs: null }).components.find(c => c.key === 'observedCost')!.value).toBe(0);
  for (const status of ['unknown', 'truncated'] as const) {
    expect(rankSqlToolCandidates({ ...corpus(), coverage: { ...coverage, status } }).candidates[0]!.eligible).toBe(false);
  }
  for (const key of ['unknownParseOperations', 'collisions'] as const)
    expect(rankSqlToolCandidates({ ...corpus(), [key]: 1 }).candidates[0]!.reasons).toContain('incomplete-evidence');
  expect(rankSqlToolCandidates(corpus({ origin: 'system' })).candidates).toEqual([]);
  for (const value of [0, -1, NaN, Infinity, 1.5])
    expect(() => rankSqlToolCandidates(corpus(), { minSuccessfulCalls: value })).toThrow('invalid_sql_demand_policy');
});

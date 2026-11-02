import { expect, it, vi } from 'vitest';
import { aggregateSqlDemand, observeSqlDemand, type SqlDemandObservation } from './sql-intent-corpus';
import { mineSqlCandidateSlice, type SqlMiningOptions } from './sql-tool-candidates';
import { sqlCandidateReviewIdentity, type SqlCandidateReviewInput } from '../sql-tool-candidate-review';
import { rankSqlToolCandidates } from '../sql-tool-candidate-score';
const scope = { workspaceId: 'test', sourceBoundary: 'ledger', epoch: 'one', key: new Uint8Array(32).fill(71) };
const row = (): SqlDemandObservation => observeSqlDemand({ workspaceId: 'test', harnessSlug: 'h', namespace: 'ledger',
  callId: '1', resultCallId: '1', identityAuthority: 'ledger', provider: 'ledger', actor: 'su-actor', verifiedAgent: true,
  at: '2026-10-24T00:00:00Z', origin: 'agent', status: 'ok', durationMs: 3, sql: 'SELECT id FROM jobs',
  sourceComplete: true, copyRef: '1' }, scope);
const coverage = { status: 'complete' as const, scannedRows: 1, cap: 1, retention: 'complete' as const, providers: ['ledger'] };
it('stable review identity excludes volume and changes only material editions R5-CONTRACT OUTCOME-P-006', () => {
  const candidate = rankSqlToolCandidates(aggregateSqlDemand([row()], coverage)).candidates[0]!;
  const input: SqlCandidateReviewInput = { workspaceId: 'test', harnessSlug: 'h',
    submittedBy: 'su-filer', candidate, contractRef: 'contract-v1' };
  const first = sqlCandidateReviewIdentity(input);
  expect(sqlCandidateReviewIdentity({ ...input, candidate: { ...candidate, score: 1,
    counts: { ...candidate.counts, ok: 1000 }, activeDays: ['2026-10-25'] } })).toEqual(first);
  const changed = sqlCandidateReviewIdentity({ ...input, contractRef: 'contract-v2' });
  expect(changed.lifecycleId).toBe(first.lifecycleId);
  expect(changed.editionId).not.toBe(first.editionId);
  expect(sqlCandidateReviewIdentity({ ...input, workspaceId: 'other' }).lifecycleId).not.toBe(first.lifecycleId);
});
it('R19-RESUME', () => {
  const one = aggregateSqlDemand([row()], coverage), replay = aggregateSqlDemand([row(), row()], coverage);
  expect(replay.logicalCalls).toBe(one.logicalCalls); expect(replay.daily).toEqual(one.daily);
});
it('R6-CONTRACT', () => {
  expect(aggregateSqlDemand([], coverage)).toMatchObject({ logicalCalls: 0, daily: [], distinctAgents: 0 });
});
it('OUTCOME-P-004', async () => {
  const observation = row();
  let cursor: { at: string; id: string } | null = null;
  const tx = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('');
    if (query.includes('SELECT to_char(cursor_at')) return [{ cursor_at: cursor?.at ?? null, cursor_id: cursor?.id ?? null, pending_until: null }];
    if (query.includes('SELECT observation')) return [{ observation, source_id: '1', source_token: observation.sourceToken }];
    if (query.includes('UPDATE harness_shared.sql_intent_progress')) cursor = { at: values[0] as string, id: values[1] as string };
    return [];
  });
  const client = Object.assign(vi.fn(async () => []), {
    begin: async (body: (t: unknown) => Promise<unknown>) => {
      const committed = cursor;
      try { return await body(tx); } catch (e) { cursor = committed; throw e; }
    },
  });
  const opts: SqlMiningOptions = { workspaceId: 'test', harnessSlug: 'h', scope, authorize: async () => true,
    now: Date.parse('2026-10-25T00:00:00Z'), client: client as unknown as SqlMiningOptions['client'] };
  const fetch = vi.fn(async (_opts: unknown) => ({ observations: [observation], coverage, next: null,
    last: { at: '2026-10-24T00:00:00Z', id: '1' }, sources: [{ token: observation.sourceToken, id: '1' }] }));
  expect(await mineSqlCandidateSlice(opts, { fetch, beforeCommit: async () => { throw new Error('persistence failure'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(cursor).toBeNull();
  expect(await mineSqlCandidateSlice(opts, { fetch })).toMatchObject({ status: 'ok', cursor: { id: '1' } });
  expect(fetch.mock.calls[1]![0]).toMatchObject({ after: undefined });
});
it('persists a full census page with bounded bulk statements', async () => {
  const observations = Array.from({ length: 250 }, (_, index) => {
    const id = String(index + 1);
    return observeSqlDemand({ workspaceId: 'test', harnessSlug: 'h', namespace: 'ledger', callId: id,
      resultCallId: id, identityAuthority: 'ledger', provider: 'ledger', actor: 'su-actor', verifiedAgent: true,
      at: '2026-10-24T00:00:00Z', origin: 'agent', status: 'ok', durationMs: 3,
      sql: 'SELECT id FROM jobs', sourceComplete: true, copyRef: `tool-invocation:${id}` }, scope);
  });
  const persisted = observations.map((observation, index) => ({ observation,
    source_id: String(index + 1), source_token: observation.sourceToken }));
  const tx = vi.fn(async (parts: TemplateStringsArray, ..._values: unknown[]) => {
    const query = parts.join('');
    if (query.includes('SELECT to_char(cursor_at'))
      return [{ cursor_at: null, cursor_id: null, pending_until: null }];
    if (query.includes('SELECT observation')) return persisted;
    return [];
  });
  const client = Object.assign(vi.fn(async () => []), {
    begin: async (body: (t: unknown) => Promise<unknown>) => body(tx),
  });
  const opts: SqlMiningOptions = { workspaceId: 'test', harnessSlug: 'h', scope, authorize: async () => true,
    now: Date.parse('2026-10-25T00:00:00Z'), rowBudget: 250, timeBudgetMs: 30_000,
    client: client as unknown as SqlMiningOptions['client'] };
  const fetch = vi.fn(async () => ({ observations, coverage: { ...coverage, scannedRows: 250, cap: 250 }, next: null,
    last: { at: '2026-10-24T00:00:00Z', id: '250' },
    sources: observations.map((observation, index) => ({ token: observation.sourceToken, id: String(index + 1) })) }));

  expect(await mineSqlCandidateSlice(opts, { fetch })).toMatchObject({ status: 'ok', rows: 250, cursor: { id: '250' } });
  const operationWrites = tx.mock.calls.filter(([parts]) => parts.join('').includes('INSERT INTO harness_shared.sql_intent_operations'));
  expect(operationWrites).toHaveLength(1);
  const batch = operationWrites[0]!.find(value => typeof value === 'string' && value.startsWith('['));
  expect(JSON.parse(batch as string)).toHaveLength(250);
  const exampleWrites = tx.mock.calls.filter(([parts]) => parts.join('').includes('INSERT INTO harness_shared.sql_intent_examples'));
  expect(exampleWrites).toHaveLength(1);
  const exampleBatch = exampleWrites[0]!.find(value => typeof value === 'string' && value.startsWith('['));
  expect(JSON.parse(exampleBatch as string)).toHaveLength(250);
});
it('R17-DURABLE', async () => {
  const events: string[] = [], observation = row();
  const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
    if (parts.join('').includes('SELECT observation')) return [{ observation, source_id: '1', source_token: observation.sourceToken }];
    return [];
  }), {});
  const client = Object.assign(vi.fn(async () => [{ pending: true }]), {
    begin: async (body: (t: unknown) => Promise<unknown>) => { const r = await body(tx); events.push('committed'); return r; },
  });
  const opts: SqlMiningOptions = { workspaceId: 'test', harnessSlug: 'h', scope, authorize: async () => true,
    now: Date.parse('2026-10-25T00:00:00Z'), client: client as unknown as SqlMiningOptions['client'] };
  const fetch = vi.fn(async () => ({ observations: [observation], coverage, next: null,
    last: { at: '2026-10-24T00:00:00Z', id: '1' }, sources: [{ token: observation.sourceToken, id: '1' }] }));
  const alert = vi.fn(async () => { expect(events).toEqual(['committed']); events.push('alerted'); });
  expect(await mineSqlCandidateSlice(opts, { fetch, alert })).toMatchObject({ status: 'ok' });
  expect(events).toEqual(['committed', 'alerted']);
  events.length = 0; alert.mockClear();
  expect(await mineSqlCandidateSlice(opts, { fetch, alert, beforeCommit: async () => { throw new Error('commit aborted'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(alert).not.toHaveBeenCalled(); expect(events).toEqual([]);
});

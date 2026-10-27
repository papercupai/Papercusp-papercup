import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sqlMiningFixture } from '../../../test/_sql-mining-fixture';
import { runSqlIntentCensus } from './sql-read-census-action';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { f = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
it('R6-CONTRACT', async () => {
  await f.seed(); await f.seed(); await f.seed();
  expect(await runSqlIntentCensus(f.opts())).toMatchObject({ status: 'ok', rows: 2, more: true });
  expect(await runSqlIntentCensus(f.opts())).toMatchObject({ status: 'ok', rows: 1, more: false, logicalCalls: 3 });
});
it('OUTCOME-P-004', async () => {
  const id = await f.seed();
  expect(await runSqlIntentCensus(f.opts(), { beforeCommit: async () => { throw new Error('persistence failure'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(await runSqlIntentCensus(f.opts())).toMatchObject({ status: 'ok', rows: 1, logicalCalls: 1, cursor: { id } });
  const [stored] = await f.db.adminSql`SELECT count(*)::int AS n FROM harness_shared.sql_intent_operations`;
  expect(stored!.n).toBe(1);
});
it('R17-DURABLE', async () => {
  await f.seed();
  const alert = vi.fn(async () => {
    const [stored] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
    expect(stored!.summary.logicalCalls).toBe(1); // visible from another connection only AFTER commit
  });
  expect(await runSqlIntentCensus(f.opts(), { alert, beforeCommit: async () => { throw new Error('rollback'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(alert).not.toHaveBeenCalled();
  expect(await runSqlIntentCensus(f.opts(), { alert })).toMatchObject({ status: 'ok' });
  expect(await runSqlIntentCensus(f.opts(), { alert })).toMatchObject({ status: 'ok' });
  expect(alert).toHaveBeenCalledTimes(1);
});
it('reviews eligible committed demand once and never reviews a rolled-back slice R5-CONTRACT', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed('SELECT id FROM jobs', i % 2 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-agent-' + i % 3}
      WHERE id=${id}::bigint`;
  }
  const review = vi.fn(async (input: Parameters<NonNullable<import('./sql-read-census-action').SqlIntentCensusDeps['review']>>[0]) => {
    const [stored] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
    expect(stored!.summary.logicalCalls).toBe(12);
    expect(input).toMatchObject({ workspaceId: 'sql-mining-test', harnessSlug: 'mining-test',
      submittedBy: 'system:sql-read-census', candidate: { eligible: true, verifiedAgents: 3 } });
    return { status: 'pending' as const, lifecycleId: 'opaque', editionId: 'edition',
      workItemId: 'EI-1', owner: null, queue: 'agent-review' as const };
  });
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  expect(await runSqlIntentCensus(opts, { review, beforeCommit: async () => { throw new Error('rollback'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  expect(review).not.toHaveBeenCalled();
  expect(await runSqlIntentCensus(opts, { review }))
    .toMatchObject({ status: 'ok', reviewIntake: { selected: 1, outsideBatch: 0 } });
  expect(await runSqlIntentCensus(opts, { review })).toMatchObject({ status: 'ok' });
  expect(review).toHaveBeenCalledTimes(1);
});
it('failed review delivery keeps the durable callback pending for retry R5-CONTRACT', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await f.seed('SELECT id FROM jobs', i % 2 ? '2026-10-23T12:00:00Z' : '2026-10-24T12:00:00Z');
    await f.db.adminSql`UPDATE harness_shared.tool_invocations SET coord_owner_id=${'su-agent-' + i % 3}
      WHERE id=${id}::bigint`;
  }
  const opts = f.opts({ rowBudget: 100, timeBudgetMs: 30_000 });
  const review = vi.fn(async () => { throw new Error('review unavailable'); });
  expect(await runSqlIntentCensus(opts, { review })).toMatchObject({ status: 'UNKNOWN', stage: 'alert' });
  const [history] = await f.db.adminSql`SELECT alerted_revision FROM harness_shared.sql_intent_history`;
  expect(history!.alerted_revision).toBeNull();
  expect(await runSqlIntentCensus(opts, { review })).toMatchObject({ status: 'UNKNOWN', stage: 'alert' });
  expect(review).toHaveBeenCalledTimes(2);
});

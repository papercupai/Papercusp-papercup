/** P-002 real migrated PG: source isolation, stable bounded cursor, and logical demand. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { aggregateSqlDemand, fetchSqlIntentCorpus, type SqlIntentCorpusOptions } from './sql-intent-corpus';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice } from './sql-tool-candidates';

let mining: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { mining = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await mining?.cleanup(); });
beforeEach(async () => { await mining.clear(); });

it('R6-CONTRACT', async () => {
  await mining.seed(); await mining.seed(); await mining.seed();
  const first = await mineSqlCandidateSlice(mining.opts());
  expect(first).toMatchObject({ status: 'ok', rows: 2, more: true, logicalCalls: 2 });
  const second = await mineSqlCandidateSlice(mining.opts());
  expect(second).toMatchObject({ status: 'ok', rows: 1, more: false, logicalCalls: 3 });
  await mining.clear();
  expect(await mineSqlCandidateSlice(mining.opts())).toMatchObject({ status: 'ok', rows: 0, logicalCalls: 0 });
});
it('R19-RESUME', async () => {
  const ids = [await mining.seed(), await mining.seed(), await mining.seed()];
  expect(await mineSqlCandidateSlice(mining.opts())).toMatchObject({ cursor: { id: ids[1] } });
  const aborted = await mineSqlCandidateSlice(mining.opts(), { beforeCommit: async () => { throw new Error('injected rollback'); } });
  expect(aborted).toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  const [old] = await mining.db.adminSql`SELECT cursor_id::text FROM harness_shared.sql_intent_progress`;
  expect(old!.cursor_id).toBe(ids[1]);
  expect(await mineSqlCandidateSlice(mining.opts())).toMatchObject({ status: 'ok', logicalCalls: 3, cursor: { id: ids[2] } });
  // Deliberately overlapping/concurrent retries replace prior contributions rather than adding counts.
  await Promise.all([mineSqlCandidateSlice(mining.opts({ rowBudget: 10 })), mineSqlCandidateSlice(mining.opts({ rowBudget: 10 }))]);
  const [stored] = await mining.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
  expect(stored!.summary.logicalCalls).toBe(3);
  const [count] = await mining.db.adminSql`SELECT count(*)::int AS n FROM harness_shared.sql_intent_operations`;
  expect(count!.n).toBe(3);
});
it('OUTCOME-P-004', async () => {
  const id = await mining.seed();
  expect(await mineSqlCandidateSlice(mining.opts(), { beforeCommit: async () => { throw new Error('persistence failure'); } }))
    .toMatchObject({ status: 'UNKNOWN', stage: 'commit' });
  const [before] = await mining.db.adminSql`SELECT count(*)::int AS n FROM harness_shared.sql_intent_operations`;
  expect(before!.n).toBe(0);
  expect(await mineSqlCandidateSlice(mining.opts())).toMatchObject({ status: 'ok', rows: 1, logicalCalls: 1, cursor: { id } });
});

describe('SQL intent corpus (real PG)', () => {
  let db: OrgTestDb;
  const workspaceId = 'sql-intent-corpus-test', harnessSlug = 'corpus-test';
  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.tool_invocations`; });
  const opts = (over: Partial<SqlIntentCorpusOptions> = {}): SqlIntentCorpusOptions => ({
    workspaceId, harnessSlug, scope: { workspaceId, sourceBoundary: 'authorized-sql', epoch: '2026-10',
      key: new Uint8Array(32).fill(37) }, since: '2026-10-24T00:00:00Z', until: '2026-10-26T00:00:00Z',
    retainedFrom: '2026-10-01T00:00:00Z', authorize: async () => true, client: db.adminSql, ...over,
  });
  async function seed(over: { workspace?: string; harness?: string; tool?: string; args?: unknown;
    status?: string; origin?: string; actor?: string; at?: string; meta?: unknown; role?: string } = {}) {
    const tool = over.tool ?? 'dev:pg_query';
    const [row] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
         coord_owner_id,args_json,transport,call_origin,call_origin_source,duration_ms,metadata_json)
      VALUES (${over.workspace ?? workspaceId},${over.harness ?? harnessSlug},'agent-mcp',${tool},${over.role ?? 'operator'},
        'one-request','test',${over.at ?? '2026-10-24T12:00:00.123456Z'}::timestamptz,${over.status ?? 'ok'},
        ${over.actor ?? 'su-corpus-a'},${JSON.stringify(over.args ?? { sql: "SELECT id FROM jobs WHERE id='one'" })}::jsonb,
        'mcp',${over.origin ?? 'agent'},'declared',20,${JSON.stringify(over.meta ?? {})}::jsonb)
      RETURNING id::text`;
    return row!.id;
  }

  it('counts one parent and SQL child, and keeps distinct same-request calls OUTCOME-P-002', async () => {
    const meta = { requestOrigin: { mcpRequestTraceId: 'same-request' } };
    await seed({ meta });
    await seed({ tool: 'tools:invoke', args: { name: 'dev:pg_query', args: { sql: "SELECT id FROM jobs WHERE id='one'" } }, meta });
    const page = await fetchSqlIntentCorpus(opts());
    expect(page.coverage).toMatchObject({ status: 'complete', scannedRows: 2 });
    const result = aggregateSqlDemand(page.observations, page.coverage);
    expect(result.logicalCalls).toBe(1);
    expect(result.daily[0]).toMatchObject({ logicalCalls: 1, status: 'ok' });
    // Counterexample: a second SQL call in the SAME request is not the same operation.
    await seed({ meta });
    const next = await fetchSqlIntentCorpus(opts());
    expect(aggregateSqlDemand(next.observations, next.coverage).logicalCalls).toBe(2);
  });

  it('pairs interleaved same-actor outcomes only by settled ledger identity R21-PAIRING', async () => {
    const meta = { requestOrigin: { mcpRequestTraceId: 'shared-burst' } };
    const ids = [await seed({ status: 'ok', meta }), await seed({ status: 'error', meta }),
      await seed({ status: 'quota-exceeded', meta }),
      await seed({ args: { _truncated: true, sql: 'SELECT id FROM jobs' }, meta })];
    const page = await fetchSqlIntentCorpus(opts());
    expect(page.observations.map(row => row.status)).toEqual(['ok', 'error', 'refused', 'unknown']);
    expect(new Set(page.observations.map(row => row.operationToken)).size).toBe(ids.length);
    const result = aggregateSqlDemand(page.observations, page.coverage);
    expect(result.daily.map(row => row.status).sort()).toEqual(['error', 'ok', 'refused']);
    expect(result.unknownParseOperations).toBe(1);
  });

  it('collapses replayed pages while retaining distinct same-text ledger calls R22-DEDUP', async () => {
    // The SELECT projects id::text; ordering by that alias sorts 10 before 8/9.
    // Pin this boundary so even an isolated run detects cursor/order disagreement.
    await db.adminSql`SELECT setval(pg_get_serial_sequence('harness_shared.tool_invocations', 'id'), 7)`;
    const ids = [await seed(), await seed(), await seed()];
    const first = await fetchSqlIntentCorpus(opts({ limit: 2 }));
    expect(first.next).toEqual({ id: ids[1], at: '2026-10-24T12:00:00.123456Z' });
    const remaining = await db.adminSql<{ id: string }[]>`SELECT id::text FROM harness_shared.tool_invocations
      WHERE (invoked_at, id) > (${first.next!.at}::timestamptz, ${first.next!.id}::bigint)
      ORDER BY invoked_at, tool_invocations.id`;
    expect(remaining.map(row => row.id)).toEqual([ids[2]]);
    const second = await fetchSqlIntentCorpus(opts({ limit: 2, after: first.next! }));
    const observations = [...first.observations, ...second.observations];
    expect(first.observations).toHaveLength(2);
    expect(second.observations).toHaveLength(1);
    const once = aggregateSqlDemand(observations, first.coverage);
    const replayed = aggregateSqlDemand([...observations, ...observations], first.coverage);
    expect(once.logicalCalls).toBe(3);
    expect(once.copiesCollapsed).toBe(0);
    expect(replayed.logicalCalls).toBe(3);
    expect(replayed.copiesCollapsed).toBe(3);
    expect(replayed.daily).toEqual(once.daily);
    expect(replayed.daily[0]!.duration.measured).toBe(3);
  });

  it('pages equal microsecond timestamps stably and reports cap/retention gaps R2-CONTRACT', async () => {
    const ids = [await seed(), await seed(), await seed()];
    const first = await fetchSqlIntentCorpus(opts({ limit: 2 }));
    expect(first.coverage).toMatchObject({ status: 'truncated', scannedRows: 2, cap: 2 });
    expect(first.next).toEqual({ id: ids[1], at: '2026-10-24T12:00:00.123456Z' });
    const second = await fetchSqlIntentCorpus(opts({ limit: 2, after: first.next! }));
    expect(second.observations).toHaveLength(1);
    expect(second.next).toBeNull();
    expect(second.coverage.status).toBe('truncated'); // last page is still only a page
    expect(new Set([...first.observations, ...second.observations].map(r => r.operationToken)).size).toBe(3);
    expect((await fetchSqlIntentCorpus(opts({ retainedFrom: undefined }))).coverage).toMatchObject({ status: 'unknown', retention: 'unknown' });
    expect((await fetchSqlIntentCorpus(opts({ retainedFrom: '2026-10-25T00:00:00Z' }))).coverage.retention).toBe('gap');
  });

  it('isolates workspace/harness before reading and denies unauthorized sources R2-CONTRACT', async () => {
    await seed(); await seed({ workspace: 'foreign-workspace' }); await seed({ harness: 'foreign-harness' });
    const page = await fetchSqlIntentCorpus(opts());
    expect(page.observations).toHaveLength(1);
    await expect(fetchSqlIntentCorpus(opts({ authorize: async () => false,
      client: (() => { throw new Error('must-not-touch-db'); }) as unknown as SqlIntentCorpusOptions['client'] })))
      .rejects.toThrow('sql_corpus_source_denied');
    await expect(fetchSqlIntentCorpus(opts({ until: '2027-01-01T00:00:00Z' }))).rejects.toThrow('invalid_sql_corpus_window');
  });

  it('separates errors, refusal, polling, replay, system and incomplete SQL without executing it R2-CONTRACT', async () => {
    await seed(); await seed({ status: 'error' }); await seed({ status: 'quota-exceeded' });
    await seed({ origin: 'hook' }); await seed({ actor: 'system:nightly', origin: 'system' });
    await seed({ role: 'replay' }); await seed({ args: { _truncated: true, sql: 'SELECT id FROM jobs' } });
    await seed({ args: { sql: "SELECT set_config('sql_intent_test_effect','executed',false)" } });
    const page = await fetchSqlIntentCorpus(opts());
    const result = aggregateSqlDemand(page.observations, page.coverage);
    expect(result).toMatchObject({ logicalCalls: 3, distinctAgents: 1, unknownParseOperations: 2 });
    expect(result.daily.filter(r => r.origin === 'agent').map(r => r.status).sort()).toEqual(['error', 'ok', 'refused']);
    for (const origin of ['polling', 'system', 'replay']) expect(result.daily.some(r => r.origin === origin)).toBe(true);
    const [effect] = await db.adminSql`SELECT current_setting('sql_intent_test_effect', true) AS value`;
    expect(effect!.value).toBeNull();
    expect(JSON.stringify(page)).not.toContain('SELECT');
  });
});

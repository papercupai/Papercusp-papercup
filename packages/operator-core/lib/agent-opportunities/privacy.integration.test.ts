import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { mineSqlCandidateSlice, purgeSqlCandidateData, readSqlCandidates } from '../bash-substitution/sql-tool-candidates';
import { EXAMPLE_LIFETIME_MS, EXAMPLE_PURGE_GRACE_MS } from './privacy';
let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
beforeAll(async () => { f = await sqlMiningFixture(); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
beforeEach(async () => { await f.clear(); });
const read = (now = f.now, authorizeSource = async (_id: string) => true) =>
  readSqlCandidates({ ...f.opts({ now }), authorizeSource });
it('R14-CONTRACT', async () => {
  await f.seed("SELECT private_field FROM private_relation WHERE password='credential' AND status='tiny-private-enum'");
  expect(await mineSqlCandidateSlice(f.opts())).toMatchObject({ status: 'ok', logicalCalls: 1 });
  const [data] = await f.db.adminSql`SELECT observation FROM harness_shared.sql_intent_operations`;
  const [example] = await f.db.adminSql`SELECT example FROM harness_shared.sql_intent_examples`;
  const bytes = JSON.stringify([data, example]);
  for (const secret of ['private-actor', 'credential', 'private_field', 'private_relation', 'tiny-private-enum'])
    expect(bytes).not.toContain(secret);
  const different = { ...f.opts().scope, sourceBoundary: 'another-authority' };
  expect(await readSqlCandidates({ ...f.opts({ scope: different }), authorizeSource: async () => true })).toEqual([]);
  const rotated = { ...f.opts().scope, epoch: 'rotated' };
  expect(await readSqlCandidates({ ...f.opts({ scope: rotated }), authorizeSource: async () => true })).toEqual([]);
});
it('R16-CONTRACT', async () => {
  await f.seed(); await mineSqlCandidateSlice(f.opts());
  const expiry = f.now + EXAMPLE_LIFETIME_MS;
  expect((await read(expiry - 1))[0]!.examples).toHaveLength(1);
  // No cleanup runs: persistence-backed reads still enforce the exact boundary.
  expect((await read(expiry))[0]!.examples).toEqual([]);
  expect((await read(expiry + 1))[0]!.examples).toEqual([]);
  const [physical] = await f.db.adminSql`SELECT count(*)::int AS n FROM harness_shared.sql_intent_examples`;
  expect(physical!.n).toBe(1);
});
it('R16-DST uses elapsed lifetime across timezone clock changes', async () => {
  await f.db.adminSql.begin(async tx => {
    await tx`SET LOCAL TIME ZONE 'America/New_York'`;
    for (const captured of ['2026-10-25T12:00:00Z', '2026-03-01T12:00:00Z']) {
      const expiry = new Date(Date.parse(captured) + EXAMPLE_LIFETIME_MS).toISOString();
      await tx`INSERT INTO harness_shared.sql_intent_examples
        (workspace_id,scope_id,source_token,captured_at,expires_at,example)
        VALUES ('sql-mining-test','dst',${captured},${captured}::timestamptz,${expiry}::timestamptz,'{}'::jsonb)`;
    }
  });
  const rows = await f.db.adminSql`SELECT extract(epoch FROM expires_at-captured_at)::int AS seconds
    FROM harness_shared.sql_intent_examples WHERE scope_id='dst'`;
  expect(rows.map(r => r.seconds)).toEqual([EXAMPLE_LIFETIME_MS / 1000, EXAMPLE_LIFETIME_MS / 1000]);
});
it('R23-DERIVED-ACL', async () => {
  const ids = [await f.seed(), await f.seed()]; await mineSqlCandidateSlice(f.opts());
  expect(await read()).toHaveLength(1);
  expect(await read(f.now, async id => id !== ids[1])).toEqual([]);
  expect(await read(f.now, async () => { throw new Error('unavailable'); })).toEqual([]);
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${ids[0]!}::bigint`;
  expect(await read()).toEqual([]);
});
it('R24-PURGE', async () => {
  await f.seed(); await mineSqlCandidateSlice(f.opts());
  const now = f.now + EXAMPLE_LIFETIME_MS + EXAMPLE_PURGE_GRACE_MS;
  expect(await purgeSqlCandidateData({ ...f.opts(), now })).toEqual({ purged: 1, breach: true });
  const [physical] = await f.db.adminSql`SELECT count(*)::int AS n FROM harness_shared.sql_intent_examples`;
  expect(physical!.n).toBe(0);
  const [alarm] = await f.db.adminSql`SELECT status,reason FROM harness_shared.sql_intent_stages WHERE stage='purge'`;
  expect(alarm).toMatchObject({ status: 'UNKNOWN', reason: 'example-purge-deadline-breached' });
  const [history] = await f.db.adminSql`SELECT summary FROM harness_shared.sql_intent_history`;
  expect(history).toBeDefined(); expect(JSON.stringify(history)).not.toContain('canonical');
});

import { existsSync, readFileSync } from 'node:fs';
import { createOrgTestDb } from './_org-test-db';
import type { SqlMiningOptions } from '../lib/bash-substitution/sql-tool-candidates';

export async function sqlMiningFixture() {
  const db = await createOrgTestDb();
  const migration = new URL('../../../libs/papercusp/libs/db/sql/1577-sql-intent-candidate-history.sql', import.meta.url);
  await db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
  const now = Date.parse('2026-10-25T12:00:00Z');
  const opts = (over: Partial<SqlMiningOptions> = {}): SqlMiningOptions => ({
    workspaceId: 'sql-mining-test', harnessSlug: 'mining-test',
    scope: { workspaceId: 'sql-mining-test', sourceBoundary: 'tool-ledger', epoch: 'test-1', key: new Uint8Array(32).fill(79) },
    client: db.adminSql, authorize: async () => true, now, rowBudget: 2, timeBudgetMs: 10_000,
    retainedFrom: '2026-10-01T00:00:00Z', ...over,
  });
  const seed = async (query = "SELECT id FROM jobs WHERE id='private-one'", at = '2026-10-24T12:00:00.123456Z') => {
    const [r] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
       coord_owner_id,args_json,transport,call_origin,call_origin_source,duration_ms)
      VALUES ('sql-mining-test','mining-test','agent-mcp','dev:pg_query','operator','test-request','test',
        ${at}::timestamptz,'ok','su-private-actor',${JSON.stringify({ sql: query })}::jsonb,'mcp','agent','declared',12)
      RETURNING id::text`;
    return r!.id;
  };
  const clear = async () => {
    await db.adminSql`TRUNCATE harness_shared.sql_intent_progress,harness_shared.sql_intent_operations,
      harness_shared.sql_intent_examples,harness_shared.sql_intent_history,harness_shared.sql_intent_stages`;
    await db.adminSql`DELETE FROM harness_shared.tool_invocations`;
  };
  return { db, now, opts, seed, clear, cleanup: () => db.cleanup() };
}

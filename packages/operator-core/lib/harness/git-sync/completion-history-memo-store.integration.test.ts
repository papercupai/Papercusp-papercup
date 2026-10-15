/**
 * WI-10005560: the Postgres store for the settlement history search memo, against the real
 * migration 1344. Unit tests cover the memo; this pins the SQL: upsert by pair, newest-first
 * load, workspace scoping, and 14-day pruning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { pgCompletionHistoryMemoStore } from './completion-history-memo-store';
import type { CompletionHistoryMemoRecord } from '../../agent-tools/work_items/completion-freshness';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(64);

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('chsm');
  await applyMigrationsForTest(db.sql, ['1344-completion-history-search-memo.sql'], {
    runtimeTables: ['harness_shared.completion_history_search_memo'],
  });
}, 120_000);
afterAll(async () => {
  await db?.cleanup();
});

const record = (path: string, value: CompletionHistoryMemoRecord['value']): CompletionHistoryMemoRecord => ({
  repositoryRoot: '/repo',
  fromHeadSha: A,
  path,
  blobSha: B,
  value,
});

describe('pgCompletionHistoryMemoStore (real PG, migration 1344)', () => {
  it('upserts by pair, loads newest first within the workspace, and prunes stale rows', async () => {
    // postgres.js Sql vs the getOrgPg Sql type: same runtime client.
    const sql = db.sql as unknown as Parameters<typeof pgCompletionHistoryMemoStore>[0];
    const store = pgCompletionHistoryMemoStore(sql, 'ws-1');
    const other = pgCompletionHistoryMemoStore(sql, 'ws-2');
    const at = { repositoryRoot: '/repo', fromCommitSha: A };

    await store.save([
      record('x.ts', { ...at, path: 'x.ts', searchedThrough: A }),
      record('y.ts', { ...at, path: 'y.ts', foundThrough: C }),
    ]);
    await other.save([record('x.ts', { ...at, path: 'x.ts', foundThrough: A })]);
    // A later verdict for the same pair replaces the earlier one (and flips its kind).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save([record('x.ts', { ...at, path: 'x.ts', foundThrough: B })]);

    expect(await store.load(10)).toEqual([
      record('x.ts', { ...at, path: 'x.ts', foundThrough: B }),
      record('y.ts', { ...at, path: 'y.ts', foundThrough: C }),
    ]);
    expect(await store.load(1)).toHaveLength(1);
    expect(await other.load(10)).toEqual([record('x.ts', { ...at, path: 'x.ts', foundThrough: A })]);

    await db.sql`
      UPDATE harness_shared.completion_history_search_memo
         SET updated_at = now() - interval '15 days'
       WHERE workspace_id = 'ws-1' AND path = 'y.ts'`;
    expect((await store.load(10)).map((row) => row.path)).toEqual(['x.ts']);
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.completion_history_search_memo WHERE path = 'y.ts'`;
    expect(n).toBe(0);
  });

  it('writes more records than one statement holds', async () => {
    const sql = db.sql as unknown as Parameters<typeof pgCompletionHistoryMemoStore>[0];
    const store = pgCompletionHistoryMemoStore(sql, 'ws-batch');
    const records = Array.from({ length: 1_203 }, (_, index) =>
      record(`f${index}.ts`, { repositoryRoot: '/repo', fromCommitSha: A, path: `f${index}.ts`, searchedThrough: B }),
    );
    await store.save(records);
    expect(await store.load(5_000)).toHaveLength(1_203);
  });
});

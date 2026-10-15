import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { loadCapturedProofRows } from '../../../../scripts/lib/pure-lane-proof-capture.mjs';

describe('capture proof archive — actual Postgres identities', () => {
  let db: FreshPgDb;
  const sha = 'a'.repeat(40);
  const startedAt = Date.parse('2026-10-05T10:00:00Z');
  const file = 'packages/operator-core/lib/a.test.ts';
  beforeAll(async () => {
    db = await createFreshPgDb('captureproof');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.test_executed_sources (
        workspace_name text, test_file text, recorded_sha text, run_group_id text,
        recorded_at timestamptz, runner_identity text, run_context text
      );
      CREATE TABLE harness_shared.test_runs (
        id bigserial PRIMARY KEY, file_path text, commit_sha text, run_group_id text,
        source text, status text, worktree_dirty boolean, finished_at timestamptz
      );
    `);
  });
  afterAll(async () => { await db?.cleanup(); });

  it('keeps only matching source=local pass/proof rows, excluding old, dirty and foreign evidence', async () => {
    await db.sql`INSERT INTO harness_shared.test_executed_sources
      VALUES ('@papercusp/operator-core', ${file}, ${sha}, 'capture',
        ${new Date(startedAt + 1000)}, 'runner', 'green-checkpoint')`;
    const add = async (group: string, source: string, dirty: boolean, at: number, status = 'pass') => {
      await db.sql`INSERT INTO harness_shared.test_runs
        (file_path, commit_sha, run_group_id, source, status, worktree_dirty, finished_at)
        VALUES (${file}, ${sha}, ${group}, ${source}, ${status}, ${dirty}, ${new Date(at)})`;
    };
    const read = () => loadCapturedProofRows({ client: {
      query: async (text: string, values: unknown[]) => ({ rows: await db.sql.unsafe(text, values as never[]) }),
    }, sha, runGroupId: 'capture', files: [file], sinceMs: startedAt });
    await add('foreign', 'local', false, startedAt + 2000);
    await add('capture', 'ci', false, startedAt + 2000);
    await add('capture', 'local', true, startedAt + 2000);
    await add('capture', 'local', false, startedAt - 1);
    await add('foreign', 'local', false, startedAt + 2000, 'fail');
    expect(await read()).toEqual([]);
    await add('capture', 'local', false, startedAt + 3000);
    expect(await read()).toEqual([{ file, testRunId: '6', recordedAtMs: startedAt + 1000,
      runnerIdentity: 'runner', runContext: 'green-checkpoint', runGroupId: 'capture', source: 'local' }]);
    await add('capture', 'local', false, startedAt + 4000, 'fail');
    expect(await read()).toEqual([]);
    await db.sql`DELETE FROM harness_shared.test_runs WHERE status = 'fail'`;
    await db.sql`UPDATE harness_shared.test_executed_sources SET run_group_id = 'foreign'`;
    expect(await read()).toEqual([]);
  });
});

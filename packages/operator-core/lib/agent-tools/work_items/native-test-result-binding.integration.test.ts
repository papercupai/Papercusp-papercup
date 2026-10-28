/** EI-27059565065683551: execute the real selector SQL, including its ordering and fences. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));
const { latestTestingRunForOwner, testRunLedgerRowsInWindow } = await import('./complete');
const { testResultContradictedByRun } = await import('./test-result-binding');
let db: FreshPgDb;
const scope = ['agent-a', 'EI-123', 'ws-native', 'repo'] as const;

beforeAll(async () => {
  db = await createFreshPgDb('native-completion-binding');
  h.sql = db.sql;
  await db.sql.unsafe(`CREATE TABLE harness_shared.tool_invocations (
    invoked_at timestamptz, duration_ms integer, args_json jsonb, coord_owner_id text,
    tool_name text, workspace_id text, harness_slug text
  ); CREATE TABLE harness_shared.test_runs (
    file_path text, status text, run_group_id text, source text, execution_details jsonb,
    workspace_id text, harness_slug text, started_at timestamptz, finished_at timestamptz,
    is_scratch_config boolean DEFAULT false
  )`);
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.tool_invocations, harness_shared.test_runs');
  await db.sql`INSERT INTO harness_shared.tool_invocations VALUES
    (now() - interval '2 minutes', 1000, ${db.sql.json({ files: ['a.test.ts'], work_item_id: 'EI-123' })},
     'agent-a', 'testing:run', 'ws-native', 'repo')`;
  await db.sql`INSERT INTO harness_shared.test_runs
    (file_path, status, run_group_id, source, started_at, finished_at) VALUES
    ('a.test.ts', 'fail', 'old-red', 'local', now() - interval '121 seconds', now() - interval '120 seconds')`;
});

async function native(status = 'pass', ownerId = 'agent-a', workItemId = 'EI-123', group = 'native') {
  const details = { schemaVersion: 1, runGroupId: group, attribution: { ownerId, workItemId } };
  await db.sql`INSERT INTO harness_shared.test_runs
    (file_path, status, run_group_id, source, execution_details, workspace_id, harness_slug, started_at, finished_at)
    VALUES ('a.test.ts', ${status}, ${group}, 'local', ${db.sql.json(details)},
      'ws-native', 'repo', now() - interval '20 seconds', now() - interval '10 seconds')`;
}

async function contradiction() {
  return testResultContradictedByRun({ testsRun: 'native test:file', testResult: 'passed', verifiedHow: 'unit' },
    'EI-123', { latestTestingRun: () => latestTestingRunForOwner(...scope),
      ledgerRowsInWindow: testRunLedgerRowsInWindow });
}

describe('native completion evidence SQL', () => {
  it('replaces an older tool red with exact native green and ignores a concurrent foreign red', async () => {
    await native();
    await native('fail', 'peer', 'EI-other', 'peer-red');
    const selected = await latestTestingRunForOwner(...scope);
    expect(selected).toMatchObject({ runGroupId: 'native', files: ['a.test.ts'], workItemId: 'EI-123' });
    expect(typeof selected?.durationMs).toBe('number');
    expect(await contradiction()).toBeUndefined();
  });
  it('reports a newer own native red', async () => {
    await native('fail');
    expect(await contradiction()).toMatchObject({ runGroupId: 'native', failingFiles: ['a.test.ts'] });
  });
  it.each(['foreign-owner', 'foreign-item', 'unattributed', 'scratch', 'mutation', 'wrong-scope'])(
    'keeps the old red when the newer result is %s', async kind => {
      await native('pass', kind === 'foreign-owner' ? 'peer' : 'agent-a',
        kind === 'foreign-item' ? 'EI-other' : 'EI-123');
      if (kind === 'unattributed') await db.sql`UPDATE harness_shared.test_runs SET execution_details = NULL WHERE run_group_id = 'native'`;
      if (kind === 'scratch') await db.sql`UPDATE harness_shared.test_runs SET is_scratch_config = true WHERE run_group_id = 'native'`;
      if (kind === 'mutation') await db.sql`UPDATE harness_shared.test_runs SET source = 'mutation-probe' WHERE run_group_id = 'native'`;
      if (kind === 'wrong-scope') await db.sql`UPDATE harness_shared.test_runs SET workspace_id = 'other' WHERE run_group_id = 'native'`;
      expect(await contradiction()).toMatchObject({ runGroupId: 'old-red' });
    });
});

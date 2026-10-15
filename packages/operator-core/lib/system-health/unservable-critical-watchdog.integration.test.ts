import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { runUnservableCriticalSweepOnce } from './unservable-critical-watchdog';

const oracle = vi.hoisted(() => vi.fn());
vi.mock('../work-items', () => ({ explainIssueClaimFloors: oracle }));

const NOW = 1_800_000_000_000;
const OLD = new Date(NOW - 30 * 86_400_000);
let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('unservable-critical-recovery');
  await db.sql`CREATE TABLE harness_shared.unservable_fixture (
    issue_id text, workspace_id text, scope text, title text, severity text, state text,
    created_at timestamptz, updated_at timestamptz, last_progress_at timestamptz)`;
  await db.sql`CREATE VIEW harness_shared.engineer_issues AS SELECT * FROM harness_shared.unservable_fixture`;
});
afterEach(async () => { await db.sql`DELETE FROM harness_shared.unservable_fixture`; });
afterAll(async () => { await db?.cleanup(); });

function fixture() {
  const open = new Set<string>();
  const resolved: string[] = [];
  oracle.mockImplementation(async (_harness: string, ids: string[]) =>
    ids.map(id => ({ id, refusedBy: 'claim-hold' })));
  const deps = { now: () => NOW, flagEnabled: async () => true, escalate: async () => {},
    readOpenConditionKeys: async () => [...open], rail: {
      broadcast: async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); return true; },
      resolve: async (event: { conditionKey: string }) => {
        if (!open.delete(event.conditionKey)) return false;
        resolved.push(event.conditionKey); return true;
      },
    } };
  return { open, resolved, deps };
}
async function insert(workspace = 'ws-exact', harness = 'harness-exact') {
  await db.sql`INSERT INTO harness_shared.unservable_fixture
    (issue_id, workspace_id, scope, title, severity, state, created_at, updated_at)
    VALUES ('WI-exact', ${workspace}, ${'harness:' + harness}, 'Stranded', 'critical', 'open', ${OLD}, ${OLD})`;
}

describe('unservable-critical exact current-row recovery — real PostgreSQL', () => {
  it('binds JSON identities, isolates workspace/harness, and preserves a deleted row after a new sweep', async () => {
    const f = fixture();
    await insert(); await insert('ws-other'); await insert('ws-exact', 'harness-other');
    await runUnservableCriticalSweepOnce(db.sql, f.deps); expect(f.open.size).toBe(3);
    await db.sql`DELETE FROM harness_shared.unservable_fixture WHERE workspace_id = 'ws-other'`;
    await db.sql`UPDATE harness_shared.unservable_fixture SET updated_at = ${new Date(NOW)}
      WHERE workspace_id = 'ws-exact' AND scope = 'harness:harness-exact'`;
    await runUnservableCriticalSweepOnce(db.sql, { ...f.deps });
    expect(f.open.size).toBe(2); expect(f.resolved).toHaveLength(1);
    expect(JSON.parse(decodeURIComponent(f.resolved[0].split('alarm:unservable-critical:')[1])))
      .toEqual(['ws-exact', 'harness-exact', 'WI-exact']);
  });

  it.each(['terminal', 'demoted'])('reads recovery outside the normal candidate set: %s', async kind => {
    const f = fixture(); await insert();
    await runUnservableCriticalSweepOnce(db.sql, f.deps); expect(f.open.size).toBe(1);
    if (kind === 'terminal') await db.sql`UPDATE harness_shared.unservable_fixture SET state = 'done'`;
    else await db.sql`UPDATE harness_shared.unservable_fixture SET severity = 'minor'`;
    oracle.mockRejectedValue(new Error('claim oracle unavailable'));
    await runUnservableCriticalSweepOnce(db.sql, { ...f.deps });
    expect(f.open.size).toBe(0); expect(f.resolved).toHaveLength(1);
  });
});

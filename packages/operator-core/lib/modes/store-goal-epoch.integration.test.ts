/**
 * WI-10005240 — a GOAL lease epoch must never be re-issued after its holder exits.
 *
 * The election minted `MAX(goal_lease_epoch) + 1` over LIVE agent_modes rows only.
 * When the highest-epoch holder exited, its row was deleted, and the next election
 * re-issued that same epoch to another owner (measured 2026-10-02 on goal 60d3a8:
 * epoch 5 went to su-ce50c06d, then again to su-9ec5d030). The fix records each
 * minted epoch on the election's agent_mode_changes row and elects
 * GREATEST(live, history) + 1.
 *
 * This runs against the REAL head schema (createOrgTestDb applies every migration,
 * including 1331), because store.test.ts fakes SQL by text match and so cannot
 * observe what the next_epoch CTE actually reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { GOAL_MODE } from './goal-session';
import { setMode } from './store';

const WS = 'ws-wi-10005240';
const GOAL = 'goal-epoch-reuse';
const A = 'su-epoch-a';
const B = 'su-epoch-b';
const C = 'su-epoch-c';

let db: OrgTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
}, 300_000);

// Dropping the throwaway database terminates other backends first; under fleet
// load that has exceeded Vitest's default hook timeout (EI-23128538923529753).
afterAll(async () => {
  await db?.cleanup();
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.agent_modes, harness_shared.agent_mode_changes`;
});

async function enter(ownerId: string, over: Partial<Parameters<typeof setMode>[0]> = {}) {
  return setMode({
    workspaceId: WS,
    ownerId,
    modeId: GOAL_MODE,
    enabled: true,
    reason: `test: ${ownerId} holds ${GOAL}`,
    setBy: ownerId,
    subject: GOAL,
    sql,
    ...over,
  });
}

async function exit(ownerId: string) {
  const res = await setMode({
    workspaceId: WS,
    ownerId,
    modeId: GOAL_MODE,
    enabled: false,
    reason: `test: ${ownerId} exits ${GOAL}`,
    setBy: ownerId,
    sql,
  });
  expect(res.ok).toBe(true);
}

async function liveEpochs(): Promise<Array<{ owner_id: string; goal_lease_epoch: number }>> {
  return sql`
    SELECT owner_id, goal_lease_epoch::int AS goal_lease_epoch
      FROM harness_shared.agent_modes
     WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${GOAL}
     ORDER BY goal_lease_epoch`;
}

describe('GOAL lease epoch high-water (WI-10005240)', () => {
  it('a recovery election after the top-epoch holder exits does not re-issue its epoch', async () => {
    expect((await enter(A)).goalElection?.epoch).toBe(1);
    // A hands off to B; A's row stays behind with epoch 1 (as in the incident).
    expect((await enter(B, { setBy: A })).goalElection?.epoch).toBe(2);
    await exit(B);
    expect(await liveEpochs()).toEqual([{ owner_id: A, goal_lease_epoch: 1 }]);

    // A recovery lease against the surviving live predecessor. Live rows alone
    // say MAX = 1, so the old election minted 2 — B's epoch, a second time.
    const recovered = await enter(C, { goalElectionExpectation: { ownerId: A, epoch: 1 } });
    expect(recovered.ok).toBe(true);
    expect(recovered.goalElection?.epoch).toBe(3);
  });

  it('an election after every holder row is gone continues the sequence instead of restarting at 1', async () => {
    expect((await enter(A)).goalElection?.epoch).toBe(1);
    expect((await enter(B, { setBy: A })).goalElection?.epoch).toBe(2);
    // A reaper (or any non-setMode path) removes every live holder row.
    await sql`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND subject = ${GOAL}`;
    expect(await liveEpochs()).toEqual([]);

    expect((await enter(C)).goalElection?.epoch).toBe(3);
  });

  it('records each minted epoch on exactly one audit row, scoped to its subject', async () => {
    await enter(A);
    await enter(B, { setBy: A });
    const rows = await sql<Array<{ owner_id: string; subject: string; goal_lease_epoch: number }>>`
      SELECT owner_id, subject, goal_lease_epoch::int AS goal_lease_epoch
        FROM harness_shared.agent_mode_changes
       WHERE workspace_id = ${WS} AND goal_lease_epoch IS NOT NULL
       ORDER BY goal_lease_epoch`;
    expect(rows).toEqual([
      { owner_id: A, subject: GOAL, goal_lease_epoch: 1 },
      { owner_id: B, subject: GOAL, goal_lease_epoch: 2 },
    ]);
  });

  it('keeps independent sequences per goal subject', async () => {
    expect((await enter(A)).goalElection?.epoch).toBe(1);
    expect((await enter(B, { subject: 'another-goal' })).goalElection?.epoch).toBe(1);
  });
});

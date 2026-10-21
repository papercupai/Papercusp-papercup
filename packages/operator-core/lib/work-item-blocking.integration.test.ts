import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { reconcileClearedDependencyBlockedState } from './work-item-blocking';
import type { WorkItem } from './work-items';

let db: OrgTestDb;
let sql: NonNullable<NonNullable<Parameters<typeof reconcileClearedDependencyBlockedState>[2]>['sql']>;
const WS = 'ws-dependency-clear';
const HARNESS = 'dependency-clear';
const actorTime = '2026-10-07T00:00:00.000Z';

/** Seed the state these cases exercise: a row still `blocked` after its dependency cleared.
 * Migration 1474/1477 lets a row ENTER `blocked` only while it names its blocker, so reach the
 * state the way production does — block it behind a scaffold edge, then remove the edge. The
 * payload stays exactly as given: planDependencyBlockedClear deep-compares it with the snapshot. */
async function seed(id: string, payload: Record<string, unknown> = {}, kind = 'bug'): Promise<WorkItem> {
  const blockedKind = kind === 'feature' ? 'feature' : 'issue';
  const blockedRef = kind === 'feature' ? `${HARNESS}#${id}` : id;
  await sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, ${blockedKind}, ${blockedRef}, 'issue', 'WI-SEED-SCAFFOLD', 'blocks')`;
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, origin, created_ts, updated_ts, payload)
    VALUES (${WS}, ${HARNESS}, ${id}, ${kind}, ${id}, 'blocked', 'local', 10, 10,
            ${sql.json(payload as Parameters<typeof sql.json>[0])})`;
  await sql`
    DELETE FROM harness_shared.work_item_deps
     WHERE workspace_id = ${WS} AND blocked_kind = ${blockedKind} AND blocked_ref = ${blockedRef}
       AND blocker_ref = 'WI-SEED-SCAFFOLD'`;
  return { id, harness: HARNESS, family: kind === 'feature' ? 'feature' : 'issue', state: 'blocked',
    origin: 'local', assignee: null, payload, updatedAt: new Date(10).toISOString() } as WorkItem;
}

async function read(id: string) {
  const rows = await sql<Array<{ status: string; payload: Record<string, unknown>; taken_by: string | null }>>`
    SELECT status, payload, taken_by FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = ${id}`;
  return rows[0]!;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql as unknown as typeof sql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('dependency clear restores persisted queue state', () => {
  it.each(['bug', 'feature'])('restores %s state and records proof without deleting review requirements', async (kind) => {
    const id = `WI-RESTORE-${kind}`;
    const payload = { _claimHold: true, held_open_by: 'su-old', held_open_reason: 'blocked',
      agentReview: { status: 'pending' }, implementationReadiness: { status: 'unknown' } };
    const item = await seed(id, payload, kind);
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-ROOT', { sql, workspaceId: WS })).toBe('cleared');
    expect(await read(id)).toMatchObject({ status: 'open', payload: {
      agentReview: { status: 'pending' }, implementationReadiness: { status: 'unknown' },
    } });
    expect((await read(id)).payload).not.toHaveProperty('_claimHold');
    const audit = await sql<Array<{ details: { clearedById: string } }>>`
      SELECT details FROM harness_shared.audit_log
       WHERE workspace_id = ${WS} AND subject = ${id} AND action = 'work_items:state:unblocked'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details.clearedById).toBe('WI-ROOT');
  });

  it('uses success satisfaction rather than treating an abandoned prerequisite as successful', async () => {
    const item = await seed('WI-SUCCESS-DEP');
    await seed('WI-ABANDONED');
    await sql`UPDATE harness_shared.work_items SET status = 'dropped'
               WHERE workspace_id = ${WS} AND feature_id = 'WI-ABANDONED'`;
    await sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction)
      VALUES ('default', 'issue', 'WI-SUCCESS-DEP', 'issue', 'WI-ABANDONED', 'blocks', 'success')`;
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-OTHER', { sql, workspaceId: WS })).toBe('live-dependency');
    expect((await read(item.id)).status).toBe('blocked');
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS} AND feature_id = 'WI-ABANDONED'`;
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-ABANDONED', { sql, workspaceId: WS })).toBe('cleared');
  });

  it('preserves an active credential blocker after the dependency clears', async () => {
    const item = await seed('WI-CREDENTIAL', { externalBlockers: [{ kind: 'human', ref: 'key',
      capability: 'credential', status: 'active', summary: 'Supply the key', createdAt: actorTime,
      updatedAt: actorTime, createdBy: 'su-1' }] });
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-ROOT', { sql, workspaceId: WS })).toBe('external-blocker');
    expect((await read(item.id)).status).toBe('blocked');
  });

  it('preserves a durable park while removing its coexisting generated blocked lease', async () => {
    const item = await seed('WI-PARK', { _claimHold: true, held_open_by: 'su-lease', held_open_reason: 'blocked',
      claim_hold_by: 'su-parker', claim_hold_reason: 'device', claim_hold_release: { condition: 'device connected' } });
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-ROOT', { sql, workspaceId: WS })).toBe('cleared');
    expect(await read(item.id)).toMatchObject({ status: 'open', payload: {
      _claimHold: true, claim_hold_by: 'su-parker', claim_hold_reason: 'device',
      claim_hold_release: { condition: 'device connected' },
    } });
    expect((await read(item.id)).payload).not.toHaveProperty('held_open_by');
  });

  it('does not change a row claimed after the event snapshot', async () => {
    const item = await seed('WI-CLAIM-RACE');
    await sql`UPDATE harness_shared.work_items SET taken_by = 'su-new', updated_ts = 20
               WHERE workspace_id = ${WS} AND feature_id = ${item.id}`;
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-ROOT', { sql, workspaceId: WS })).toBe('stale-control');
    expect(await read(item.id)).toMatchObject({ status: 'blocked', taken_by: 'su-new' });
  });

  it('does not change controls written after the event snapshot', async () => {
    const item = await seed('WI-CONTROL-RACE');
    await sql`UPDATE harness_shared.work_items SET payload = '{"needsOwnerAction":true}'::jsonb
               WHERE workspace_id = ${WS} AND feature_id = ${item.id}`;
    expect(await reconcileClearedDependencyBlockedState(item, 'WI-ROOT', { sql, workspaceId: WS })).toBe('stale-control');
    expect((await read(item.id)).status).toBe('blocked');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { applyMissionEvent, applyMissionEventInTransaction, readSessionMission, updateMissionOutboxInTransaction } from './session-brief-mission';
import type { MissionParent, MissionEvent } from './mission-continuity';
import { applySessionTaskOp, readSessionTasks, type SessionTaskOpArgs } from './session-tasks';
import { commitMissionTaskTransition } from './mission-continuity-task-acceptance';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, '../../../libs/papercusp/libs/db/sql');
let db: FreshPgDb;
const scope = (ownerId: string) => ({ ownerId, workspaceId: 'mission-test' });
const parent = (ownerId: string): MissionParent => ({
  assignmentRef: 'plan:main', ownerDirectiveRef: 'order:1', objectiveRefs: ['plan:main'],
  completionCriteriaRefs: ['plan:main#Requirements'], accountableOwner: ownerId, custodyGeneration: 1,
  assignmentRevision: 1, authorityRef: 'plan-start:1', disposition: 'ready', blockerRef: null, nextActionRef: 'P-002',
});
const select: MissionEvent = { id: 'select:repair', kind: 'activity-accepted', activity: {
  selectedRef: 'WI-repair', acceptedOperationRef: 'operation:repair', accepted: true, changesFocus: true,
  displacedContinuationRef: 'WI-step', relationship: 'blocking-repair', selectionRevision: 1,
} };
const done: MissionEvent = { id: 'done:repair', kind: 'child-ended', childRef: 'WI-repair', terminal: true };

async function seed(ownerId: string) {
  const p = parent(ownerId);
  await applyMissionEvent(scope(ownerId), { id: 'bind', kind: 'assignment-accepted', binding: p, currentWorkRef: 'WI-step' },
    async () => p, { sql: db.sql, nowMs: 1_000 });
  await applyMissionEvent(scope(ownerId), select, async () => p, { sql: db.sql, nowMs: 2_000 });
  return p;
}

beforeAll(async () => {
  db = await createFreshPgDb('mission-continuity');
  await applyMigrationForTest(db.sql, resolve(migrations, '322-session-briefs-ei1742.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '1618-session-brief-mission-continuity.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '981-session-task-engine.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '982-session-task-work-item-links.sql'));
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.owner_directives(id bigint PRIMARY KEY,workspace_id text,
      source_turn_ref text,captured_by_hook boolean,disposition_status text);
    CREATE TABLE harness_shared.work_items(feature_id text,harness_slug text,workspace_id text,
      source_plan_slug text,taken_by text,taken_at timestamptz,status text,directive_ref bigint,goal_id text);
    CREATE TABLE harness_shared.harness_plans(workspace_id text,harness_slug text,plan_slug text,
      status text,op_status text,execution_start_revision_seq integer);
    CREATE TABLE harness_shared.plan_revisions(workspace_id text,harness_slug text,plan_slug text,
      seq integer,content_snapshot text);
  `).simple();
  await db.sql`INSERT INTO harness_shared.owner_directives VALUES(31,'mission-test','owner-turn:31',true,null)`;
  await db.sql`INSERT INTO harness_shared.harness_plans VALUES('mission-test','eng','root','ready','started',7)`;
  await db.sql`INSERT INTO harness_shared.plan_revisions VALUES('mission-test','eng','root',7,
    ${JSON.stringify({schema:'plan-execution-start-v1',scope:{workspaceId:'mission-test',harnessSlug:'eng',planSlug:'root'},body:'accepted mission'})})`;
}, 90_000);
afterAll(async () => db?.cleanup());



async function seedTaskAuthority(ownerId: string, id: string, plan = 'root') {
  await db.sql`INSERT INTO harness_shared.work_items VALUES(${id},'eng','mission-test',${plan},${ownerId},
    '2026-11-06T00:00:00Z','open',31,null)`;
}
async function taskOp(ownerId: string, args: SessionTaskOpArgs, workItemId?: string, crash = false) {
  return db.sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    return applySessionTaskOp(tx, { ...args,workspaceId:'mission-test',sessionId:ownerId,
      idFactory:()=>{throw new Error('test task ids must be explicit');},now:'2026-11-06T00:00:00.000Z',
      bridge:{
        seedWorkItem:workItemId?{workItemId,workItemHarness:'eng',relation:'for'}:null,
        async commitTransition(port,before,result) {
          await commitMissionTaskTransition(port,scope(ownerId),ownerId,before,result,1_000);
          if(crash) throw new Error('injected acceptance commit crash');
        },
      },
    });
  });
}
async function mission(ownerId:string) {
  const result=await readSessionMission(scope(ownerId),db.sql);
  if(result.availability!=='available') throw new Error('missing mission');
  return result.envelope;
}
async function initTask(ownerId:string,id:string,workItemId:string) {
  await seedTaskAuthority(ownerId,workItemId);
  await taskOp(ownerId,{op:'append',tasks:[{id,content:'canonical step'}]},workItemId);
}

describe('canonical accepted task operations compose with retained mission state',()=>{
  it('binds automatically at acceptance and keeps the plan open after a child completes',async()=>{
    const owner='su-task-root';
    await initTask(owner,'a','WI-task-a');
    await initTask(owner,'b','WI-task-b');
    expect((await readSessionMission(scope(owner),db.sql)).availability).toBe('absent');
    await taskOp(owner,{op:'start',taskId:'a'});
    const first=await mission(owner);
    expect(first.state.binding).toMatchObject({assignmentRef:'plan:eng:root',ownerDirectiveRef:'order:31',
      assignmentRevision:7,accountableOwner:owner,completionCriteriaRefs:['plan:eng:root#Requirements']});
    expect(first.state.currentWorkRef).toBe('session-task:'+owner+':a');
    await taskOp(owner,{op:'done',taskId:'a'});
    expect((await mission(owner)).state.disposition).toBe('ready');
    await taskOp(owner,{op:'start',taskId:'b'});
    const second=await mission(owner);
    expect(second.state.binding?.assignmentRef).toBe('plan:eng:root');
    expect(second.state.selectionRevision).toBeGreaterThan(first.state.selectionRevision);
    expect(second.state.frames).toEqual([]);
    const revision=second.revision;
    await Promise.all([taskOp(owner,{op:'start',taskId:'b'}),taskOp(owner,{op:'start',taskId:'b'})]);
    expect((await mission(owner)).revision).toBe(revision);
  });

  it('rolls back both accepted focus and binding when continuation persistence fails',async()=>{
    const owner='su-task-rollback';
    await initTask(owner,'a','WI-task-rollback');
    await expect(taskOp(owner,{op:'start',taskId:'a'},undefined,true)).rejects.toThrow('acceptance commit crash');
    expect((await readSessionTasks(db.sql,'mission-test',owner))[0].status).toBe('pending');
    expect((await readSessionMission(scope(owner),db.sql)).availability).toBe('absent');
    await taskOp(owner,{op:'start',taskId:'a'});
    expect((await mission(owner)).state.currentWorkRef).toBe('session-task:'+owner+':a');
  });

  it('keeps ambiguous displacement unknown and can accept later same-root progress at the same clock',async()=>{
    const owner='su-task-unknown';
    await initTask(owner,'a','WI-task-known');
    await taskOp(owner,{op:'append',tasks:[{id:'unlinked',content:'unrecorded purpose'}]});
    await taskOp(owner,{op:'start',taskId:'a'});
    await taskOp(owner,{op:'start',taskId:'unlinked'});
    const unknown=await mission(owner);
    expect(unknown.state.stateAvailability).toBe('unknown');
    expect(unknown.state.binding?.assignmentRef).toBe('plan:eng:root');
    expect(unknown.state.frames).toEqual([]);
    await taskOp(owner,{op:'start',taskId:'a'});
    const restored=await mission(owner);
    expect(restored.state.stateAvailability).toBe('available');
    expect(restored.state.selectionRevision).toBeGreaterThan(unknown.state.selectionRevision);
    expect(new Set(restored.state.processedEvents).size).toBe(restored.state.processedEvents.length);
  });

  it('invalidates stale return authority after an actual custody transfer',async()=>{
    const owner='su-task-transfer';
    await initTask(owner,'a','WI-task-transfer');
    await taskOp(owner,{op:'start',taskId:'a'});
    await db.sql`UPDATE harness_shared.work_items SET taken_by='su-peer',taken_at=now() WHERE feature_id='WI-task-transfer'`;
    await taskOp(owner,{op:'done',taskId:'a'});
    const transferred=await mission(owner);
    expect(transferred.state.disposition).toBe('transferred');
    expect(transferred.state.nextActionRef).toBeNull();
    expect(transferred.outbox).toEqual([]);
  });

  it('does not turn an agent-authored directive into owner authority',async()=>{
    const owner='su-task-untrusted';
    await initTask(owner,'a','WI-task-untrusted');
    await db.sql`INSERT INTO harness_shared.owner_directives VALUES(32,'mission-test','agent-turn:32',false,null)`;
    await db.sql`UPDATE harness_shared.work_items SET directive_ref=32 WHERE feature_id='WI-task-untrusted'`;
    await taskOp(owner,{op:'start',taskId:'a'});
    const unknown=await mission(owner);
    expect(unknown.state.binding).toBeNull();
    expect(unknown.state.stateAvailability).toBe('unknown');
  });
});


describe('retained mission state and atomic consequence intent on Postgres', () => {
  it('retains the root and deadlines across recovery and current-activity changes', async () => {
    const p = await seed('su-recover');
    await db.sql`UPDATE harness_shared.session_briefs SET current_plan_slug='other-activity', intent='a short question' WHERE owner_id='su-recover'`;
    const recovered = await applyMissionEvent(scope('su-recover'), { id: 'recover', kind: 'recovered' }, async () => p,
      { sql: db.sql, nowMs: 500_000 });
    expect(recovered.state.binding?.assignmentRef).toBe('plan:main');
    expect(recovered.state.frames[0].absoluteDeadline).toBe(2_000 + 30 * 60_000);
    expect(recovered.consequences).toEqual([]);
  });

  it('commits child mutation, frame closure and pending intent together before enqueue', async () => {
    const p = await seed('su-commit');
    await db.sql`CREATE TABLE harness_shared.mission_child_fixture (id text PRIMARY KEY, state text)`;
    await db.sql`INSERT INTO harness_shared.mission_child_fixture VALUES ('WI-repair','open')`;
    await db.sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_child_fixture SET state='done' WHERE id='WI-repair'`;
      await applyMissionEventInTransaction(tx, scope('su-commit'), done, async () => p, 3_000);
    });
    const stored = await readSessionMission(scope('su-commit'), db.sql);
    if (stored.availability !== 'available') throw new Error('missing committed mission');
    expect(stored.envelope.state.frames).toEqual([]);
    expect(stored.envelope.state.disposition).toBe('ready');
    expect(stored.envelope.outbox).toMatchObject([{ status: 'pending', consequence: { continuationRef: 'P-002' } }]);
    expect((await db.sql`SELECT state FROM harness_shared.mission_child_fixture WHERE id='WI-repair'`)[0].state).toBe('done');
  });

  it('rolls back completion and intent at the business-commit crash window', async () => {
    const p = await seed('su-rollback');
    await db.sql`CREATE TABLE harness_shared.mission_rollback_fixture (state text)`;
    await db.sql`INSERT INTO harness_shared.mission_rollback_fixture VALUES ('open')`;
    await expect(db.sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_rollback_fixture SET state='done'`;
      await applyMissionEventInTransaction(tx, scope('su-rollback'), done, async () => p, 3_000);
      throw new Error('injected crash before business commit');
    })).rejects.toThrow('injected crash');
    const stored = await readSessionMission(scope('su-rollback'), db.sql);
    if (stored.availability !== 'available') throw new Error('lost retained state');
    expect(stored.envelope.state.frames).toHaveLength(1);
    expect(stored.envelope.outbox).toEqual([]);
    expect((await db.sql`SELECT state FROM harness_shared.mission_rollback_fixture`)[0].state).toBe('open');
  });

  it('serializes concurrent completions and preserves terminal receipts on late acknowledgement', async () => {
    const p = await seed('su-concurrent');
    const receipts = await Promise.all([1, 2].map(() => applyMissionEvent(scope('su-concurrent'), done, async () => p,
      { sql: db.sql, nowMs: 3_000 })));
    expect(receipts.flatMap(receipt => receipt.consequences)).toHaveLength(1);
    const stored = await readSessionMission(scope('su-concurrent'), db.sql);
    if (stored.availability !== 'available') throw new Error('missing concurrent receipt');
    expect(stored.envelope.outbox).toHaveLength(1);
    const id = stored.envelope.outbox[0].consequence.id;
    await db.sql.begin(tx => updateMissionOutboxInTransaction(tx as unknown as Sql, scope('su-concurrent'), id,
      { status: 'settled', workflowId: id, admissionError: null, resolution: 'delivered' }));
    await db.sql.begin(tx => updateMissionOutboxInTransaction(tx as unknown as Sql, scope('su-concurrent'), id,
      { status: 'enqueued', workflowId: id, admissionError: null, resolution: null }));
    const replayed = await readSessionMission(scope('su-concurrent'), db.sql);
    if (replayed.availability !== 'available') throw new Error('missing terminal receipt');
    expect(replayed.envelope.outbox[0].status).toBe('settled');
  });

  it('preserves pending intent and refuses to overwrite malformed persisted state', async () => {
    const p = await seed('su-malformed');
    await applyMissionEvent(scope('su-malformed'), done, async () => p, { sql: db.sql, nowMs: 3_000 });
    const stored = await readSessionMission(scope('su-malformed'), db.sql);
    if (stored.availability !== 'available') throw new Error('missing pending intent');
    expect(stored.envelope.outbox[0].status).toBe('pending');
    await db.sql`UPDATE harness_shared.session_briefs SET mission_continuity='{"schemaVersion":99}'::jsonb WHERE owner_id='su-malformed'`;
    expect((await readSessionMission(scope('su-malformed'), db.sql)).availability).toBe('unknown');
    await expect(applyMissionEvent(scope('su-malformed'), { id: 'recover', kind: 'recovered' }, async () => p,
      { sql: db.sql, nowMs: 4_000 })).rejects.toThrow('mission-state-invalid');
    expect((await db.sql`SELECT mission_continuity FROM harness_shared.session_briefs WHERE owner_id='su-malformed'`)[0].mission_continuity).toEqual({ schemaVersion: 99 });
  });

  it('fences workspace and owner mismatches', async () => {
    const p = await seed('su-scope');
    await expect(applyMissionEvent({ ownerId: 'su-scope', workspaceId: 'foreign' }, { id: 'recover', kind: 'recovered' },
      async () => p, { sql: db.sql, nowMs: 3_000 })).rejects.toThrow('mission-session-scope-conflict');
    await expect(applyMissionEvent(scope('su-scope'), { id: 'foreign-bind', kind: 'assignment-accepted', binding: parent('su-peer'), currentWorkRef: null },
      async () => p, { sql: db.sql, nowMs: 3_000 })).rejects.toThrow('mission-owner-mismatch');
  });
});

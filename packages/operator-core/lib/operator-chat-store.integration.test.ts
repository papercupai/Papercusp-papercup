import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { restoreRawJsonbSerializer } from '@papercusp/db-org';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { TurnRecovery, type TurnIdentity } from '@papercusp/chat-protocol/recovery';
import { InteractionResolver, type InteractionRecord, type InteractionScope } from '@papercusp/chat-protocol/interactions';
import type { ChatEventEnvelope } from '@papercusp/chat-protocol';
import { openRun, registerCard, _resetCardCorrelatorForTests, _resetStateChannelForTests } from '@papercusp/agent-mcp';
import { OperatorChatStore, operatorChatChildAuthority, operatorChatParentAuthority,
  operatorChatSessionAuthority, operatorChatTurnWorkflow, operatorChatTurnChannel, operatorChatWorkspaceChannel } from './operator-chat-store';
import { admitConverseTurn, findConverseTurn, watchConverseTurn } from './agent-tools/operator/converse-turn';
import { createConverseCard, findConverseCard, findConverseRunCards, snapshotConverseCards } from './agent-tools/operator/converse-card';

let first: postgres.Sql;
let second: postgres.Sql;
let turn: TurnIdentity;
let databaseUrl: string;
const workspaceId = 'p010-workspace';
const scope: InteractionScope = { principalId: 'owner', tenantId: 'tenant',
  customerId: 'customer', publicOwnerId: 'public-owner' };
const capabilities = { connectionReplay: true, persistedHistory: true, persistedInteractionDecisions: true,
  completedToolCheckpoints: true, interruptedTurnRecovery: true };
const migration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1569-operator-chat-durable-state.sql', import.meta.url));

beforeAll(async () => {
  const uri = await getTestPg();
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  const dbName = `p010_chat_${randomBytes(5).toString('hex')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(uri);
  url.pathname = `/${dbName}`;
  databaseUrl = url.toString();
  first = postgres(url.toString(), { max: 3, onnotice: () => {} });
  second = postgres(url.toString(), { max: 1, onnotice: () => {} });
  // Match buildClient's protected raw JSON boundary before Drizzle initializes
  // the client; keep the second worker plain to exercise both configurations.
  restoreRawJsonbSerializer(first);
  drizzle(first);
  await first.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.operator_conversations (id uuid PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE harness_shared.operator_turns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
      workspace_id text NOT NULL, tools jsonb NOT NULL DEFAULT '[]', seq integer NOT NULL DEFAULT 0,
      role text NOT NULL DEFAULT 'assistant', text text NOT NULL DEFAULT '', source text,
      created_at bigint, report jsonb, UNIQUE(conversation_id,seq));
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY, workspace_id text NOT NULL,
      user_id text NOT NULL, expires_at timestamptz NOT NULL, capabilities jsonb NOT NULL DEFAULT '["*"]');
    CREATE TABLE harness_shared.users (id text PRIMARY KEY, username text NOT NULL DEFAULT 'default', is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE harness_shared.system_principals (workspace_id text NOT NULL, name text NOT NULL,
      bearer_hash text NOT NULL, capabilities jsonb NOT NULL, PRIMARY KEY(workspace_id,name));
    CREATE TABLE harness_shared.pi_sessions (workspace_id text NOT NULL, session_id text NOT NULL,
      bearer_hash text NOT NULL, capabilities jsonb NOT NULL, allowed_tools jsonb,
      ended_at timestamptz, expires_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,session_id));
    CREATE TABLE harness_shared.token_index (token text PRIMARY KEY, kind text NOT NULL,
      harness_slug text NOT NULL, workspace_id text NOT NULL);
  `);
  // Apply the exact additive migration twice: legacy turn bytes remain untouched.
  await first.unsafe(readFileSync(migration, 'utf8'));
  await first.unsafe(readFileSync(migration, 'utf8'));
}, 90_000);
afterAll(async () => { await Promise.all([first?.end({ timeout: 5 }), second?.end({ timeout: 5 })]); });
beforeEach(async () => {
  await first.unsafe('TRUNCATE harness_shared.operator_turns, harness_shared.operator_conversations, harness_shared.user_sessions, harness_shared.users, harness_shared.system_principals, harness_shared.pi_sessions, harness_shared.token_index');
  turn = { conversationId: randomUUID(), turnId: randomUUID() };
  await first.unsafe('INSERT INTO harness_shared.operator_conversations VALUES ($1,$2)', [turn.conversationId, workspaceId]);
  await first.unsafe('INSERT INTO harness_shared.operator_turns (id,conversation_id,workspace_id) VALUES ($1,$2,$3)',
    [turn.turnId, turn.conversationId, workspaceId]);
  await first.unsafe("INSERT INTO harness_shared.user_sessions (token,workspace_id,user_id,expires_at) VALUES ('current',$1,$2,clock_timestamp()+interval '1 hour')",
    [workspaceId, scope.principalId]);
  await first.unsafe('INSERT INTO harness_shared.users (id) VALUES ($1)', [scope.principalId]);
});

function store(sql = first, overrides: Partial<ConstructorParameters<typeof OperatorChatStore>[0]> = {}) {
  return new OperatorChatStore({ sql, workspaceId, turn, scope, replayLimit: 4,
    // This fixture uses PG session rows and a real authority lock. The production
    // route must supply its own current principal/ACL resolver at this port.
    async authorize(tx) {
      const rows = await tx.unsafe(`SELECT token FROM harness_shared.user_sessions
        WHERE token='current' AND workspace_id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE`,
      [workspaceId, scope.principalId]);
      return rows.length === 1;
    }, ...overrides });
}
function worker(s = store()) {
  return new TurnRecovery({ capabilities, store: s, authorize: async () => true,
    replay: (identity, after) => s.replay(identity, after), abortExecution: async () => {} });
}
function record(correlationId = 'choice'): InteractionRecord {
  return { schemaVersion: 1, conversationId: turn.conversationId, correlationId, scope, revision: 0,
    schema: { id: 'choice-schema', revision: 1 }, spec: { prompt: 'Proceed?', allowDecline: true },
    expiresAt: Date.now() + 60_000, status: 'pending' };
}
function resolver(s: OperatorChatStore, failAdvance = false) {
  const port = s.interactions(async (tx, next) => {
    // Stand in for the existing persisted host workflow, in the SAME PG tx.
    // A worker recovering the decision never calls this transition again.
    await tx.unsafe('UPDATE harness_shared.operator_turns SET tools=tools || $1::jsonb WHERE id=$2',
      [tx.json([next.decision] as unknown as postgres.JSONValue), turn.turnId]);
    if (failAdvance) throw new Error('workflow-write-failed');
  });
  return { port, make: (storage = port) => new InteractionResolver({ store: storage,
    validate: async (schema, value) => schema.id === 'choice-schema' && schema.revision === 1
      && Object.keys(value).length === 1 && value.pick === 'yes' ? { ok: true, value } : { ok: false } }) };
}
const answer = (submissionId: string) => ({ submissionId, revision: 0,
  response: { action: 'submit', correlationId: 'choice', value: { pick: 'yes' } } });
const envelope = (sequence: number): ChatEventEnvelope => ({ schemaVersion: 1, ...turn,
  eventId: `event-${sequence}`, sequence, event: { type: 'delta', text: `delta-${sequence}` } });

describe('P010 durable PG turn ports (independent connections; no actual-host claim)', () => {
  async function concreteCard() {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const parentBearer = 'concrete-parent-credential';
    const childBearer = 'concrete-child-credential';
    const authority = { kind: 'system' as const, principalId: 'system:parent',
      credentialSha256: createHash('sha256').update(parentBearer).digest('hex') };
    const binding = { dispatchCallId: 'concrete-dispatch', childRunId: 'concrete-child-run',
      credentialSha256: createHash('sha256').update(childBearer).digest('hex') };
    await first.unsafe(`INSERT INTO harness_shared.system_principals VALUES ($1,'parent',$2,'["chat:write"]');`,
      [workspaceId, authority.credentialSha256]);
    await first.unsafe(`INSERT INTO harness_shared.pi_sessions
      (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
      VALUES ($1,'concrete-child',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`,
    [workspaceId, binding.credentialSha256]);
    await first.unsafe("INSERT INTO harness_shared.token_index VALUES ($1,'system','system:parent',$3),($2,'pi','pi:concrete-child',$3)",
      [parentBearer, childBearer, workspaceId]);
    const boundScope = { principalId: authority.principalId, tenantId: workspaceId,
      customerId: authority.principalId, publicOwnerId: authority.principalId };
    const s = store(first, { scope: boundScope });
    await s.beginTurn('concrete-parent-run', 'text_typed', authority);
    const parent = { workspaceId, ...turn, runId: 'concrete-parent-run', authority };
    const options = [{ id: 'yes', label: 'Proceed' }, { id: 'no', label: 'Stop' }];
    const tool = { name: 'chat:ask_choice', callId: binding.dispatchCallId,
      input: { question: 'Proceed?', options } };
    const spec = { prompt: 'Proceed?', presentation: { kind: 'radio' as const, options },
      dataSchema: z.object({ picks: z.tuple([z.enum(['yes', 'no'])]) }) };
    const info = { correlationId: 'concrete-card', runId: binding.childRunId, workspaceId };
    const card = createConverseCard({ sql: first, parent, binding, tool });
    const hooks = card.hooks(spec);
    await hooks.beforeCard!(info, new AbortController().signal);
    return { card, hooks, parent, binding, tool, spec, info, boundScope, s };
  }

  it('hydrates a scoped durable card from a different worker with no local run', async () => {
    const { info, spec } = await concreteCard();
    const result = await snapshotConverseCards({ sql: second, workspaceId, live: [], authorizeAdditional: async () => true });
    expect(result.snapshots).toMatchObject([{ workspaceId, runId: info.runId,
      snapshot: { openCards: [{ correlationId: info.correlationId, conversationId: turn.conversationId,
        prompt: spec.prompt, presentation: spec.presentation }] } }]);
    expect(result.nextExpiryAt).toBeGreaterThan(Date.now());
    expect((await snapshotConverseCards({ sql: second, workspaceId: 'foreign', live: [],
      authorizeAdditional: async () => true })).snapshots).toEqual([]);
    await expect(snapshotConverseCards({ sql: second, workspaceId, live: [],
      authorizeAdditional: async () => false })).rejects.toThrow('unauthorized');
  });

  it('suppresses stale local cards after durable decisions, expiry and authority revocation', async () => {
    const { info, card, spec } = await concreteCard();
    const live = [{ runId: info.runId, workspaceId, version: 90, snapshot: { openCards: [{
      correlationId: info.correlationId, prompt: spec.prompt, dataSchemaJson: {}, createdAt: 1 }] } }];
    const load = () => snapshotConverseCards({ sql: second, workspaceId, live, authorizeAdditional: async () => true });
    expect((await load()).snapshots[0].snapshot.openCards).toHaveLength(1);
    await first.unsafe("UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp()");
    expect((await load()).snapshots[0].snapshot.openCards).toEqual([]);
    await first.unsafe('UPDATE harness_shared.pi_sessions SET ended_at=NULL');
    expect((await load()).snapshots[0].snapshot.openCards).toHaveLength(1);
    await first.unsafe(`UPDATE harness_shared.operator_turns SET chat_state=jsonb_set(chat_state,
      '{interactions,concrete-card,expiresAt}',to_jsonb(1::bigint)) WHERE id=$1`, [turn.turnId]);
    expect((await load()).snapshots[0].snapshot.openCards).toEqual([]);
    await first.unsafe(`UPDATE harness_shared.operator_turns SET chat_state=jsonb_set(chat_state,
      '{interactions,concrete-card,expiresAt}',to_jsonb((EXTRACT(EPOCH FROM clock_timestamp())*1000+60000)::bigint)) WHERE id=$1`, [turn.turnId]);
    await card.commitResponse({ action: 'submit', payload: { picks: ['yes'] } }, info, 'response');
    expect((await load()).snapshots[0].snapshot.openCards).toEqual([]);
  });

  it('notifies workspace snapshot readers only after the durable transaction commits', async () => {
    const { card, info } = await concreteCard();
    const notifications: string[] = [];
    const listener = await second.listen(operatorChatWorkspaceChannel(workspaceId), value => notifications.push(value));
    try {
      await card.commitResponse({ action: 'submit', payload: { picks: ['yes'] } }, info, 'response');
      await expect.poll(() => notifications.length).toBeGreaterThan(0);
      expect(notifications.every(value => value === 'changed')).toBe(true);
      expect((await snapshotConverseCards({ sql: first, workspaceId, live: [],
        authorizeAdditional: async () => true })).snapshots).toEqual([]);
    } finally { await listener.unlisten(); }
  });

  it('refuses an incomplete durable binding rather than returning its stale local card', async () => {
    const { info } = await concreteCard();
    await first.unsafe("UPDATE harness_shared.operator_turns SET chat_state=chat_state-'interactionBindings' WHERE id=$1", [turn.turnId]);
    await expect(snapshotConverseCards({ sql: second, workspaceId, live: [{ runId: info.runId,
      workspaceId, version: 1, snapshot: { openCards: [{ correlationId: info.correlationId,
        prompt: 'stale', createdAt: 1, dataSchemaJson: {} }] } }], authorizeAdditional: async () => true }))
      .rejects.toThrow('needs-reconciliation');
  });

  it('resolves a pending card after native finalization from another worker without losing its exact workflow', async () => {
    const { card, parent, tool, info, s } = await concreteCard();
    await card.associateNative('native-finalized');
    await s.finalizeTurn({ runId: parent.runId, status: 'completed', text: 'Choose',
      tools: [{ ...tool, callId: 'native-finalized' }] });
    const recovered = await findConverseCard({ sql: second, workspaceId, conversationId: turn.conversationId,
      correlationId: info.correlationId, authorizeAdditional: async () => true });
    expect(recovered).not.toBeNull();
    const picked = { action: 'submit' as const, payload: { picks: ['yes'] } };
    expect(await recovered!.commitResponse(picked, recovered!.info(), 'response')).toEqual({ accepted: true, response: picked });
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([{ ...tool, callId: 'native-finalized',
      answered: { picks: [{ option_id: 'yes', label: 'Proceed' }], at: expect.any(Number) } }]);
    const users = await first.unsafe("SELECT text FROM harness_shared.operator_turns WHERE role='user'");
    expect(users).toEqual([{ text: 'Proceed' }]);
    expect(await recovered!.commitResponse(picked, recovered!.info(), 'response')).toEqual({ accepted: false, response: picked });
    expect(await first.unsafe("SELECT text FROM harness_shared.operator_turns WHERE role='user'")).toEqual(users);
  });

  it('adapts exact host card preparation, decision and late native association through the real PG ports', async () => {
    const { card, hooks, parent, binding, tool, info, s } = await concreteCard();
    expect(await card.read()).toMatchObject({ ok: true, value: { status: 'pending', revision: 0 } });
    const picked = { action: 'submit' as const, payload: { picks: ['yes'] } };
    expect(await hooks.commitResponse!(picked, info, 'response')).toEqual({ accepted: true, response: picked });
    expect(await hooks.commitResponse!({ action: 'submit', payload: { picks: ['no'] } }, info, 'response'))
      .toEqual({ accepted: false, response: picked });
    const recovered = createConverseCard({ sql: second, parent, binding, tool, correlationId: info.correlationId });
    expect(await recovered.read()).toMatchObject({ ok: true, value: { status: 'resolved', revision: 1 } });
    expect(await recovered.associateNative('late-native')).toBe(true);
    await s.finalizeTurn({ runId: parent.runId, status: 'completed', text: 'Proceed', tools: [{ ...tool, callId: 'late-native' }] });
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([{ ...tool, callId: 'late-native', answered: {
      picks: [{ option_id: 'yes', label: 'Proceed' }], at: expect.any(Number) } }]);
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
  });

  it('keeps host card reads and decisions bound to exact dispatch child parent and additional responder authority', async () => {
    const { card, hooks, parent, binding, tool, info } = await concreteCard();
    const mutable = { sql: second, parent, binding, tool, correlationId: info.correlationId,
      authorizeAdditional: async () => false };
    const captured = createConverseCard(mutable);
    mutable.authorizeAdditional = async () => true;
    const refused = [
      captured,
      createConverseCard({ sql: second, parent, binding: { ...binding, dispatchCallId: 'other-dispatch' }, tool, correlationId: info.correlationId }),
      createConverseCard({ sql: second, parent, binding: { ...binding, childRunId: 'other-child-run' }, tool, correlationId: info.correlationId }),
      createConverseCard({ sql: second, parent: { ...parent, runId: 'other-parent-run' }, binding, tool, correlationId: info.correlationId }),
      createConverseCard({ sql: second, parent, binding, tool, correlationId: info.correlationId, authorizeAdditional: async () => false }),
    ];
    for (const foreign of refused) expect(await foreign.read()).toEqual({ ok: false, code: 'unauthorized' });
    await expect(hooks.commitResponse!({ action: 'submit', payload: { picks: ['no'] } },
      { ...info, runId: 'other-run' }, 'response')).rejects.toThrow('unauthorized');
    await first.unsafe("UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp() WHERE session_id='concrete-child'");
    expect(await card.read()).toEqual({ ok: false, code: 'unauthorized' });
    await expect(hooks.commitResponse!({ action: 'cancel' }, info, 'timeout')).rejects.toThrow('unauthorized');
    await first.unsafe("UPDATE harness_shared.pi_sessions SET ended_at=NULL WHERE session_id='concrete-child'");
    await first.unsafe("UPDATE harness_shared.system_principals SET capabilities='[]' WHERE name='parent'");
    expect(await card.read()).toEqual({ ok: false, code: 'unauthorized' });
    const rows = await second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].chat_state.interactions[info.correlationId].status).toBe('pending');
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
  });

  it('recovers and commits an exact scoped card on another worker without a local waiter', async () => {
    const { info, parent, binding } = await concreteCard();
    const authorizeAdditional = operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
      credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const input = { sql: second, workspaceId, conversationId: turn.conversationId,
      correlationId: info.correlationId, authorizeAdditional };
    const found = await OperatorChatStore.findInteraction({ ...input, authorize: authorizeAdditional });
    expect(found).toMatchObject({ parent, binding });
    const recovered = await findConverseCard(input);
    expect(recovered).not.toBeNull();
    expect(await recovered!.commitResponse({ action: 'submit', payload: { picks: ['no'] } }, info, 'response'))
      .toEqual({ accepted: true, response: { action: 'submit', payload: { picks: ['no'] } } });
    expect(await first.unsafe("SELECT text FROM harness_shared.operator_turns WHERE role='user'"))
      .toEqual([{ text: 'Stop' }]);
    expect(await findConverseCard({ ...input, conversationId: randomUUID() })).toBeNull();
    expect(await findConverseCard({ ...input, correlationId: 'foreign' })).toBeNull();
    expect(await findConverseCard({ ...input, workspaceId: 'foreign' })).toBeNull();
  });

  it.each(['session', 'capability', 'user'] as const)('rechecks responder %s after lookup before deciding', async revoke => {
    const { info } = await concreteCard();
    const authorizeAdditional = operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
      credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const recovered = await findConverseCard({ sql: second, workspaceId, conversationId: turn.conversationId,
      correlationId: info.correlationId, authorizeAdditional });
    expect(recovered).not.toBeNull();
    if (revoke === 'session') await first.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    if (revoke === 'capability') await first.unsafe("UPDATE harness_shared.user_sessions SET capabilities='[]' WHERE token='current'");
    if (revoke === 'user') await first.unsafe('UPDATE harness_shared.users SET is_active=false');
    await expect(recovered!.commitResponse({ action: 'submit', payload: { picks: ['yes'] } }, info, 'response'))
      .rejects.toThrow('unauthorized');
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
    const state = (await first.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0].chat_state;
    expect(state.interactions[info.correlationId].status).toBe('pending');
  });

  it('fences trusted desktop decisions by the current active seeded account', async () => {
    const { info } = await concreteCard();
    const authorizeAdditional = operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
      credential: { kind: 'local-desktop', userId: scope.principalId },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const input = { sql: second, workspaceId, conversationId: turn.conversationId,
      correlationId: info.correlationId, authorizeAdditional };
    const recovered = await findConverseCard(input);
    expect(await recovered!.read()).toMatchObject({ ok: true, value: { status: 'pending' } });
    await first.unsafe("UPDATE harness_shared.users SET username='other'");
    await expect(recovered!.commitResponse({ action: 'submit', payload: { picks: ['yes'] } }, info, 'response'))
      .rejects.toThrow('unauthorized');
    await first.unsafe("UPDATE harness_shared.users SET username='default'");
    expect(await recovered!.commitResponse({ action: 'submit', payload: { picks: ['yes'] } }, info, 'response'))
      .toMatchObject({ accepted: true });
    expect(await first.unsafe("SELECT text FROM harness_shared.operator_turns WHERE role='user'"))
      .toEqual([{ text: 'Proceed' }]);
  });

  it('publishes scoped decision wakes only after commit and never after workflow rollback', async () => {
    const s = store();
    const ports = resolver(s);
    await s.seedInteraction(record());
    const channel = operatorChatTurnChannel(workspaceId, turn);
    expect(channel).not.toBe(operatorChatTurnChannel('foreign', turn));
    expect(channel).not.toBe(operatorChatTurnChannel(workspaceId, { ...turn, turnId: randomUUID() }));
    const wakes: string[] = [];
    let wake!: () => void;
    const notified = new Promise<void>(resolve => { wake = resolve; });
    const listener = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const handle = await listener.listen(channel, payload => { wakes.push(payload); wake(); });
    try {
      // Fail at COMMIT, after save has actually queued NOTIFY. A failure in
      // advance before save would not exercise PG's notification boundary.
      await first.unsafe(`CREATE FUNCTION harness_shared.reject_chat_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'reject-chat-commit'; END $$;
        CREATE CONSTRAINT TRIGGER reject_chat_commit AFTER UPDATE ON harness_shared.operator_turns
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_chat_commit()`);
      expect(await ports.make().resolve(record(), scope, answer('rollback')))
        .toEqual({ ok: false, code: 'needs-reconciliation' });
      expect(await ports.make().read(record(), scope)).toMatchObject({ ok: true, value: { status: 'pending' } });
      await first.unsafe('DROP TRIGGER reject_chat_commit ON harness_shared.operator_turns; DROP FUNCTION harness_shared.reject_chat_commit()');
      expect(await resolver(store(second)).make().resolve(record(), scope, answer('commit')))
        .toMatchObject({ ok: true });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([notified, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('committed notification missing')), 5000);
      })]); } finally { clearTimeout(timeout); }
      expect(wakes).toEqual(['changed']);
    } finally {
      await first.unsafe('DROP TRIGGER IF EXISTS reject_chat_commit ON harness_shared.operator_turns; DROP FUNCTION IF EXISTS harness_shared.reject_chat_commit()');
      await handle.unlisten(); await listener.end({ timeout: 5 });
    }
  });

  it('recovers cancellation by exact parent or child run within the authenticated conversation', async () => {
    const { info, parent, binding } = await concreteCard();
    const authorizeAdditional = operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
      credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const input = { sql: second, workspaceId, conversationId: turn.conversationId, authorizeAdditional };
    expect(await findConverseRunCards({ ...input, runId: 'foreign-run' })).toBeNull();
    expect(await findConverseRunCards({ ...input, runId: binding.childRunId, conversationId: randomUUID() })).toBeNull();
    const child = await findConverseRunCards({ ...input, runId: binding.childRunId });
    const original = await findConverseRunCards({ ...input, runId: parent.runId });
    expect(child?.map(card => card.info())).toEqual([info]);
    expect(original?.map(card => card.info())).toEqual([info]);
    expect(await child![0].commitResponse({ action: 'cancel' }, child![0].info(), 'run-end'))
      .toEqual({ accepted: true, response: { action: 'cancel' } });
    expect(await original![0].read()).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
  });

  it.each(['registration-gap', 'reconnect', 'publication-gap'] as const)(
    'reauthorizes and delivers the durable winner after a %s without replaying a decision', async gap => {
      const { card, hooks, parent, binding, tool, info, spec } = await concreteCard();
      _resetCardCorrelatorForTests();
      _resetStateChannelForTests();
      let reconnect!: () => void;
      let stopped = false;
      const errors: unknown[] = [];
      const picked = { action: 'submit' as const, payload: { picks: ['yes'] } };
      const other = createConverseCard({ sql: second, parent, binding, tool, correlationId: info.correlationId });
      openRun({ workspaceId, runId: binding.childRunId });
      const register = () => registerCard({ workspaceId, runId: binding.childRunId,
        correlationId: info.correlationId, spec: { ...spec, ...hooks } });
      let registered = gap === 'publication-gap' ? undefined : register();
      const watcher = await card.listen(error => { errors.push(error); }, async (channel, _notify, onListen) => {
        expect(channel).toBe(operatorChatTurnChannel(workspaceId, turn));
        reconnect = onListen!;
        if (gap === 'registration-gap') await other.commitResponse(picked, info, 'response');
        return () => { stopped = true; };
      });
      try {
        if (gap !== 'registration-gap') {
          await other.commitResponse(picked, info, 'response');
          if (gap === 'publication-gap') registered = register();
          else reconnect();
          await watcher.refresh();
        }
        expect(await registered!.result).toEqual(picked);
        await watcher.refresh();
        expect(errors).toEqual([]);
        expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
      } finally {
        watcher.stop();
        expect(stopped).toBe(true);
        _resetCardCorrelatorForTests();
        _resetStateChannelForTests();
      }
    });

  it('validates persisted choice schema and cancels expiry without advancing the host answer workflow', async () => {
    const { card, hooks, info, spec } = await concreteCard();
    expect(() => card.hooks({ ...spec, prompt: 'Substituted question' })).toThrow('interaction-binding-conflict');
    for (const picks of [['foreign'], ['yes', 'yes'], ['yes', 'no'], []]) {
      await expect(hooks.commitResponse!({ action: 'submit', payload: { picks } }, info, 'response'))
        .rejects.toThrow('invalid-answer');
    }
    await first.unsafe("UPDATE harness_shared.operator_turns SET chat_state=jsonb_set(chat_state,ARRAY['interactions',$2,'expiresAt'],'0') WHERE id=$1",
      [turn.turnId, info.correlationId]);
    expect(await hooks.commitResponse!({ action: 'cancel' }, info, 'timeout'))
      .toEqual({ accepted: true, response: { action: 'cancel' } });
    expect(await card.read()).toMatchObject({ ok: true, value: { status: 'cancelled', revision: 1 } });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools[0].answered).toBeUndefined();
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
  });

  it('persists expired cancellation across connections without invoking the answer workflow', async () => {
    const s = store();
    const expired = { ...record(), expiresAt: 0 };
    await s.seedInteraction(expired);
    const make = (s: OperatorChatStore) => new InteractionResolver({
      store: s.interactions(async () => { throw new Error('cancellation-must-not-advance'); }),
      validate: async () => { throw new Error('cancellation-must-not-validate'); },
    });
    const identity = { conversationId: turn.conversationId, correlationId: 'choice' };
    const [a, b] = await Promise.all([make(s).cancel(identity, scope, 0), make(store(second)).cancel(identity, scope, 0)]);
    expect(a).toMatchObject({ ok: true, value: { status: 'cancelled', revision: 1 } });
    expect(b).toEqual(a);
    expect(await make(store(second)).read(identity, scope)).toEqual(a);
    const rows = await first.unsafe('SELECT tools,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].chat_state.interactions.choice).toEqual({ ...expired, status: 'cancelled', revision: 1 });
    expect(rows[0].tools).toEqual([]);
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
  });

  it('serializes an answer against cancellation and keeps the winning transition intact', async () => {
    await store().seedInteraction(record());
    const a = resolver(store()).make();
    const b = resolver(store(second)).make();
    const identity = { conversationId: turn.conversationId, correlationId: 'choice' };
    const [answerResult, cancelResult] = await Promise.all([
      a.resolve(identity, scope, answer('racing-answer')), b.cancel(identity, scope, 0),
    ]);
    const state = await a.read(identity, scope);
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error('unreadable-state');
    if (state.value.status === 'resolved') {
      expect(answerResult.ok).toBe(true);
      expect(cancelResult).toEqual({ ok: false, code: 'already-decided' });
      expect((await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0].tools)
        .toHaveLength(1);
    } else {
      expect(state.value.status).toBe('cancelled');
      expect(cancelResult.ok).toBe(true);
      expect(answerResult).toEqual({ ok: false, code: 'cancelled' });
      expect((await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0].tools)
        .toEqual([]);
    }
    expect(state.value.revision).toBe(1);
  });

  it('rechecks live session authority before cancellation and rolls back cancelled state on storage failure', async () => {
    await store().seedInteraction(record());
    const identity = { conversationId: turn.conversationId, correlationId: 'choice' };
    await first.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    expect(await resolver(store()).make().cancel(identity, scope, 0)).toEqual({ ok: false, code: 'unauthorized' });
    const pending = (await second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0];
    expect(pending.chat_state.interactions.choice.status).toBe('pending');
    await first.unsafe("INSERT INTO harness_shared.user_sessions (token,workspace_id,user_id,expires_at) VALUES ('current',$1,$2,clock_timestamp()+interval '1 hour')",
      [workspaceId, scope.principalId]);
    await first.unsafe("ALTER TABLE harness_shared.operator_turns ADD CONSTRAINT cancellation_fault CHECK (chat_state->'interactions'->'choice'->>'status' != 'cancelled')");
    try {
      expect(await resolver(store()).make().cancel(identity, scope, 0)).toEqual({ ok: false, code: 'needs-reconciliation' });
      expect(await resolver(store(second)).make().read(identity, scope))
        .toMatchObject({ ok: true, value: { status: 'pending', revision: 0 } });
    } finally { await first.unsafe('ALTER TABLE harness_shared.operator_turns DROP CONSTRAINT cancellation_fault'); }
  });

  async function boundChoice() {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const authority = { kind: 'system' as const, principalId: 'system:owner', credentialSha256: 'a'.repeat(64) };
    const boundScope = { ...scope, principalId: authority.principalId };
    const s = store(first, { scope: boundScope });
    await s.beginTurn('parent-run', 'text_typed', authority);
    const parent = { workspaceId, ...turn, runId: 'parent-run', authority };
    const binding = { dispatchCallId: 'dispatch-choice', childRunId: 'child-run', credentialSha256: 'b'.repeat(64) };
    const tool = { name: 'chat:ask_choice', callId: binding.dispatchCallId,
      input: { question: 'Proceed?', options: [{ id: 'yes', label: 'Proceed' }] } };
    const pending = { ...record(), scope: boundScope };
    return { s, parent, binding, tool, pending, boundScope };
  }

  it('atomically prepares the exact dispatch binding, card and history before publication', async () => {
    const { s, parent, binding, tool, pending, boundScope } = await boundChoice();
    expect(await s.prepareInteraction({ record: pending, parent, binding, tool })).toBe(true);
    const other = store(second, { scope: boundScope });
    expect(await other.prepareInteraction({ record: pending, parent, binding, tool })).toBe(false);
    const row = (await second.unsafe('SELECT tools,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0];
    expect(row.tools).toEqual([tool]);
    expect(row.chat_state.interactions.choice).toEqual(pending);
    expect(row.chat_state.interactionBindings.choice).toEqual(binding);
    await expect(other.prepareInteraction({ record: pending, parent, binding,
      tool: { ...tool, input: { question: 'A different payload' } } })).rejects.toThrow('interaction-binding-conflict');
    await expect(other.prepareInteraction({ record: { ...pending, correlationId: 'non-json' }, parent,
      binding: { ...binding, dispatchCallId: 'non-json-dispatch' },
      tool: { ...tool, callId: 'non-json-dispatch', input: { value: NaN } } })).rejects.toThrow('invalid-state');
    for (const invalid of [{ ...binding, childRunId: 'foreign' }, { ...binding, credentialSha256: 'c'.repeat(64) },
      { ...binding, dispatchCallId: 'other-call' }]) {
      await expect(other.prepareInteraction({ record: pending, parent, binding: invalid,
        tool: { ...tool, callId: invalid.dispatchCallId } })).rejects.toThrow('interaction-binding-conflict');
    }
    await expect(other.prepareInteraction({ record: { ...pending, correlationId: 'foreign-parent' },
      parent: { ...parent, runId: 'foreign' }, binding, tool })).rejects.toThrow('unauthorized');
    // Equal names and arguments do not join two calls. Only exact host IDs do.
    const nextBinding = { ...binding, dispatchCallId: 'second-dispatch' };
    expect(await other.prepareInteraction({ record: { ...pending, correlationId: 'second-card' }, parent,
      binding: nextBinding, tool: { ...tool, callId: nextBinding.dispatchCallId } })).toBe(true);
    await expect(other.prepareInteraction({ record: { ...pending, correlationId: 'aliased-card' }, parent,
      binding, tool })).rejects.toThrow('interaction-binding-conflict');
    expect((await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0].tools)
      .toEqual([tool, { ...tool, callId: 'second-dispatch' }]);
  });

  it('rolls back the card and binding when the prepared history write fails', async () => {
    const { s, parent, binding, tool, pending } = await boundChoice();
    await first.unsafe("ALTER TABLE harness_shared.operator_turns ADD CONSTRAINT preparation_fault CHECK (jsonb_array_length(tools)=0)");
    try {
      await expect(s.prepareInteraction({ record: pending, parent, binding, tool })).rejects.toMatchObject({ code: '23514' });
      const row = (await second.unsafe('SELECT tools,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0];
      expect(row.tools).toEqual([]);
      expect(row.chat_state.interactions).toEqual({});
      expect(row.chat_state.interactionBindings ?? {}).toEqual({});
    } finally { await first.unsafe('ALTER TABLE harness_shared.operator_turns DROP CONSTRAINT preparation_fault'); }
    expect(await s.prepareInteraction({ record: pending, parent, binding, tool })).toBe(true);
  });

  it('associates a late native call explicitly and preserves the committed answer at finalization', async () => {
    const { s, parent, binding, tool, pending, boundScope } = await boundChoice();
    await s.prepareInteraction({ record: pending, parent, binding, tool });
    const other = store(second, { scope: boundScope });
    const resolver = new InteractionResolver({ store: other.interactions(operatorChatTurnWorkflow({ workspaceId, turn })),
      validate: async (_schema, value) => ({ ok: true, value }) });
    expect(await resolver.resolve({ conversationId: turn.conversationId, correlationId: 'choice' }, boundScope,
      { submissionId: 'pick', revision: 0, response: { action: 'submit', correlationId: 'choice', value: { picks: ['yes'] } } }))
      .toMatchObject({ ok: true });
    const terminal = { runId: 'parent-run', status: 'completed' as const, text: 'Proceed',
      tools: [{ ...tool, callId: 'native-call' }] };
    await expect(s.finalizeTurn(terminal)).rejects.toThrow('interaction-call-unassociated');
    const association = { ...binding, parent, correlationId: 'choice', nativeCallId: 'native-call' };
    for (const invalid of [{ ...association, childRunId: 'foreign' },
      { ...association, credentialSha256: 'c'.repeat(64) }, { ...association, dispatchCallId: 'foreign' },
      { ...association, parent: { ...parent, runId: 'foreign' } }]) {
      await expect(other.associateInteractionCall(invalid)).rejects.toThrow('unauthorized');
    }
    expect(await other.associateInteractionCall(association)).toBe(true);
    expect(await s.associateInteractionCall(association)).toBe(false);
    await expect(s.associateInteractionCall({ ...association, nativeCallId: 'other-native' }))
      .rejects.toThrow('interaction-binding-conflict');
    await expect(s.finalizeTurn({ ...terminal, tools: [...terminal.tools, { name: 'read', callId: 'native-call' }] }))
      .rejects.toThrow('invalid-turn-result');
    await expect(s.finalizeTurn({ ...terminal, tools: [{ ...tool, callId: 'native-call', input: { foreign: true } }] }))
      .rejects.toThrow('turn-result-conflict');
    await s.finalizeTurn(terminal);
    const row = (await second.unsafe('SELECT tools,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0];
    expect(row.tools).toEqual([{ ...tool, callId: 'native-call', answered: {
      picks: [{ option_id: 'yes', label: 'Proceed' }], at: expect.any(Number) } }]);
    expect(row.chat_state.interactionBindings.choice.nativeCallId).toBe('native-call');
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
    await s.finalizeTurn(terminal);
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
  });

  it('serializes competing native associations without joining identical tool inputs', async () => {
    const { s, parent, binding, tool, pending, boundScope } = await boundChoice();
    await s.prepareInteraction({ record: pending, parent, binding, tool });
    const secondBinding = { ...binding, dispatchCallId: 'second-dispatch' };
    await s.prepareInteraction({ record: { ...pending, correlationId: 'second-card' }, parent,
      binding: secondBinding, tool: { ...tool, callId: secondBinding.dispatchCallId } });
    const other = store(second, { scope: boundScope });
    const results = await Promise.allSettled([
      s.associateInteractionCall({ ...binding, parent, correlationId: 'choice', nativeCallId: 'same-native' }),
      other.associateInteractionCall({ ...secondBinding, parent, correlationId: 'second-card', nativeCallId: 'same-native' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value === true)).toHaveLength(1);
    const loser = results.find(result => result.status === 'rejected');
    expect(loser).toMatchObject({ status: 'rejected', reason: new Error('interaction-binding-conflict') });
    const state = (await second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0].chat_state;
    expect(Object.values(state.interactionBindings).filter((value: any) => value.nativeCallId === 'same-native')).toHaveLength(1);
    expect(Object.keys(state.interactions)).toEqual(['choice', 'second-card']);
  });

  it.each(['failed', 'cancelled'] as const)('retains prepared identity and closes pending cards when %s precedes a native completion', async status => {
    const { s, parent, binding, tool, pending } = await boundChoice();
    await s.prepareInteraction({ record: pending, parent, binding, tool });
    const receipt = await s.finalizeTurn({ runId: 'parent-run', status, text: 'Partial', tools: [] });
    expect(receipt).toMatchObject(turn);
    const row = (await second.unsafe('SELECT tools,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0];
    expect(row.tools).toEqual([tool]);
    expect(row.chat_state.interactions.choice.status).toBe('cancelled');
    expect(row.chat_state.interactionBindings.choice).toEqual(binding);
    await expect(s.associateInteractionCall({ ...binding, parent, correlationId: 'choice', nativeCallId: 'late-native' }))
      .rejects.toThrow('turn-result-conflict');
    await s.finalizeTurn({ runId: 'parent-run', status, text: 'Partial', tools: [] });
  });

  it('persists original parent authority and fences card registration against a different run or credential', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const authority = { kind: 'system' as const, principalId: 'system:owner',
      credentialSha256: createHash('sha256').update('original-parent').digest('hex') };
    const boundScope = { ...scope, principalId: authority.principalId };
    const pending = (id: string) => ({ ...record(id), scope: boundScope });
    const s = store(first, { scope: boundScope });
    await s.beginTurn('parent-run', 'text_typed', authority);
    const parent = { workspaceId, ...turn, runId: 'parent-run', authority };
    const rows = await second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].chat_state.execution.parentAuthority).toEqual(authority);
    expect(JSON.stringify(rows)).not.toContain('original-parent');
    const other = store(second, { scope: boundScope });
    await expect(other.seedInteraction(pending('missing-parent'))).rejects.toThrow('unauthorized');
    for (const invalid of [{ ...parent, runId: 'child-run' }, { ...parent, turnId: randomUUID() },
      { ...parent, workspaceId: 'foreign' },
      { ...parent, authority: { ...authority, credentialSha256: 'a'.repeat(64) } }]) {
      await expect(other.seedInteraction(pending('foreign-binding'), invalid)).rejects.toThrow('unauthorized');
    }
    expect(await other.seedInteraction(pending('authorized'), parent)).toBe(true);
    expect(await other.seedInteraction(pending('authorized'), parent)).toBe(false);
    const state = (await second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]))[0].chat_state;
    expect(Object.keys(state.interactions)).toEqual(['authorized']);
    await expect(other.beginTurn('parent-run', 'text_typed', { ...authority, credentialSha256: 'b'.repeat(64) }))
      .rejects.toThrow('turn-run-conflict');
    expect(await other.beginTurn('parent-run', 'text_typed', authority)).toBe(false);
  });

  it.each(['system', 'pi'] as const)('P010 converse adapter admits and finalizes with current %s authority, denying duplicate launch and revoked finalization', async kind => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const bearer = `adapter-${kind}-credential`;
    const hash = createHash('sha256').update(bearer).digest('hex');
    const principalId = `${kind}:adapter`;
    if (kind === 'system') {
      await first.unsafe(`INSERT INTO harness_shared.system_principals VALUES ($1,'adapter',$2,'["chat:write"]')`, [workspaceId, hash]);
    } else {
      await first.unsafe(`INSERT INTO harness_shared.pi_sessions
        (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
        VALUES ($1,'adapter',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`, [workspaceId, hash]);
    }
    await first.unsafe('INSERT INTO harness_shared.token_index VALUES ($1,$2,$3,$4)', [bearer, kind, principalId, workspaceId]);
    const args = { options: { sql: first, workspaceId, turn, scope: { ...scope, principalId } },
      credential: kind === 'system' ? { kind, name: 'adapter', bearer } : { kind, sessionId: 'adapter', bearer },
      capability: 'chat:write', toolName: 'chat:ask_choice', runId: 'adapter-run', source: 'text_typed' as const };
    const admitted = await admitConverseTurn(args);
    await expect(admitConverseTurn({ ...args, options: { ...args.options, sql: second } })).rejects.toThrow('needs-reconciliation');
    expect(await second.unsafe('SELECT id FROM harness_shared.operator_turns')).toHaveLength(1);
    await admitted.finalize({ status: 'completed', text: 'Durable reply', tools: [{ name: 'read', callId: 'call-a' }] });
    expect((await second.unsafe('SELECT text,chat_state FROM harness_shared.operator_turns'))[0]).toMatchObject({
      text: 'Durable reply', chat_state: { scope: { principalId }, execution: { runId: 'adapter-run', status: 'completed' } } });
    await first.unsafe('DELETE FROM harness_shared.token_index WHERE token=$1', [bearer]);
    await expect(admitted.finalize({ status: 'completed', text: 'Durable reply', tools: [{ name: 'read', callId: 'call-a' }] }))
      .rejects.toThrow('unauthorized');
    await expect(admitConverseTurn({ ...args, options: { ...args.options, turn: { ...turn, turnId: randomUUID() } } }))
      .rejects.toThrow('unauthorized');
    expect(await second.unsafe('SELECT id FROM harness_shared.operator_turns')).toHaveLength(1);
  });

  async function publisher(replayLimit = 4) {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const bearer = 'publisher-credential';
    const principalId = 'system:publisher';
    await first.unsafe(`INSERT INTO harness_shared.system_principals VALUES ($1,'publisher',$2,'["chat:write"]')`,
      [workspaceId, createHash('sha256').update(bearer).digest('hex')]);
    await first.unsafe('INSERT INTO harness_shared.token_index VALUES ($1,$2,$3,$4)',
      [bearer, 'system', principalId, workspaceId]);
    const publisherScope = { principalId, tenantId: workspaceId, customerId: principalId, publicOwnerId: principalId };
    const admitted = await admitConverseTurn({ options: { sql: first, workspaceId, turn,
      scope: publisherScope, replayLimit }, credential: { kind: 'system', name: 'publisher', bearer },
      capability: 'chat:write', toolName: 'chat:ask_choice', runId: 'publisher-run', source: 'text_typed' });
    return { admitted, replacement: store(second, { scope: publisherScope, replayLimit,
      authorize: operatorChatSessionAuthority({ workspaceId, principalId,
        credential: { kind: 'system', name: 'publisher', bearer }, capability: 'chat:write', toolName: 'chat:ask_choice' }) }) };
  }

  it('P010 publisher commits ordered bounded events before observers and retains replay after completion', async () => {
    const { admitted, replacement } = await publisher(2);
    const observations: Array<Promise<unknown>> = [];
    const emitted: ChatEventEnvelope[] = [];
    const emit = (event: ChatEventEnvelope) => {
      emitted.push(event);
      observations.push(second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId])
        .then(rows => expect(rows[0].chat_state.events).toContainEqual(event)));
    };
    // Generator backpressure plus a synchronous native observer use one order.
    await Promise.all([admitted.publish({ type: 'delta', text: 'one' }, emit),
      admitted.publish({ type: 'delta', text: 'two' }, emit)]);
    await Promise.all(observations);
    await admitted.publish({ type: 'delta', text: 'three' }, emit);
    await Promise.all(observations);
    await admitted.finalize({ status: 'completed', text: 'onetwothree' });
    expect(emitted.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(new Set(emitted.map(event => event.eventId)).size).toBe(3);
    expect(await replacement.replay(turn, 1)).toEqual({ firstAvailableSequence: 2, lastSequence: 3,
      events: emitted.slice(1) });
    const saved = await replacement.read(turn);
    expect(saved?.state.capabilities).toMatchObject({ connectionReplay: true,
      completedToolCheckpoints: false, interruptedTurnRecovery: false });
    await expect(admitted.publish({ type: 'delta', text: 'late' }, emit)).rejects.toThrow('turn-result-conflict');
  });

  it('P010 publisher latches a lost commit acknowledgement without publishing or retrying uncertain bytes', async () => {
    const { admitted, replacement } = await publisher();
    const append = admitted.store.appendEvent.bind(admitted.store);
    let writes = 0, publications = 0;
    admitted.store.appendEvent = async event => {
      writes++;
      await append(event);
      throw new Error('commit-ack-lost');
    };
    await expect(admitted.publish({ type: 'delta', text: 'committed' }, () => { publications++; }))
      .rejects.toThrow('commit-ack-lost');
    await expect(admitted.publish({ type: 'delta', text: 'must-not-jump' }, () => { publications++; }))
      .rejects.toThrow('commit-ack-lost');
    await expect(admitted.finalize({ status: 'completed', text: 'committed' })).rejects.toThrow('commit-ack-lost');
    expect({ writes, publications }).toEqual({ writes: 1, publications: 0 });
    expect(await replacement.replay(turn, 0)).toMatchObject({ lastSequence: 1,
      events: [{ sequence: 1, event: { type: 'delta', text: 'committed' } }] });
    expect((await replacement.read(turn))?.state.phase).toBe('running');
  });

  it('P010 publisher and replay recheck revoked authority without leaking or advancing an event', async () => {
    const { admitted, replacement } = await publisher();
    let publications = 0;
    await admitted.publish({ type: 'delta', text: 'authorized' }, () => { publications++; });
    await second.unsafe("UPDATE harness_shared.system_principals SET capabilities='[]' WHERE name='publisher'");
    await expect(admitted.publish({ type: 'delta', text: 'refused' }, () => { publications++; }))
      .rejects.toThrow('unauthorized');
    await expect(replacement.replay(turn, 0)).rejects.toThrow('unauthorized');
    await expect(admitted.finalize({ status: 'completed', text: 'refused' })).rejects.toThrow('unauthorized');
    expect(publications).toBe(1);
    const rows = await second.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].chat_state.checkpoint.state.lastSequence).toBe(1);
    expect(rows[0].chat_state.execution.status).toBe('running');
  });

  it('P010 replacement worker reopens the exact turn, fences cancellation before late publication and wakes the producer', async () => {
    const { admitted } = await publisher();
    await admitted.publish({ type: 'delta', text: 'Partial' }, () => {});
    const input = { sql: second, workspaceId, identity: turn, authorizeAdditional: async () => true };
    const recovered = await findConverseTurn(input);
    expect(recovered).not.toBeNull();
    expect(await recovered!.recovery.replay(turn, 0)).toMatchObject({ ok: true,
      value: [{ sequence: 1, event: { type: 'delta', text: 'Partial' } }] });
    await expect(findConverseTurn({ ...input, expectedPrincipalId: 'pi:foreign' })).rejects.toThrow('unauthorized');
    await expect(findConverseTurn({ ...input, authorizeAdditional: async () => false })).rejects.toThrow('unauthorized');
    expect(await findConverseTurn({ ...input, identity: { ...turn, turnId: randomUUID() } })).toBeNull();
    const listener = postgres(databaseUrl, { max: 1 });
    let cancelled = false;
    let unlistening: Promise<unknown> | undefined;
    const errors: unknown[] = [];
    const watch = await watchConverseTurn({ store: admitted.store, workspaceId, identity: turn,
      onChange: checkpoint => { cancelled ||= checkpoint.state.phase === 'cancelled'; },
      onError: error => errors.push(error) }, async (channel, nudge, onListen) => {
      const subscription = await listener.listen(channel, nudge, onListen);
      return () => { unlistening = subscription.unlisten(); };
    });
    try {
      expect((await recovered!.recovery.cancel(turn)).ok).toBe(true);
      await expect.poll(() => cancelled, { timeout: 5000 }).toBe(true);
      await expect(admitted.publish({ type: 'delta', text: 'late' }, () => { throw new Error('must not publish'); }))
        .rejects.toThrow('cancelled');
      expect(await recovered!.store.admitDispatch(turn, 'late-effect', 1, async () => 'must-not-run'))
        .toEqual({ admitted: false, reason: 'cancelled' });
      await admitted.finalize({ status: 'cancelled', text: 'Partial' });
      await expect(admitted.finalize({ status: 'completed', text: 'Resurrected' })).rejects.toThrow();
      expect(errors).toEqual([]);
      const rows = await second.unsafe('SELECT text,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
      expect(rows[0]).toMatchObject({ text: 'Partial', chat_state: { execution: { status: 'cancelled' },
        checkpoint: { state: { phase: 'cancelled', lastSequence: 1 } } } });
      expect(await second.unsafe('SELECT id FROM harness_shared.operator_turns')).toHaveLength(1);
    } finally {
      watch.stop();
      await unlistening;
      await listener.end({ timeout: 5 });
    }
  });

  it('P010 pre-stream admission reserves one scoped row and never grants a duplicate provider launch', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const runId = randomUUID();
    expect(runId).not.toBe(turn.turnId);
    const admissions = await Promise.all([store().beginTurn(runId, 'text_typed'), store(second).beginTurn(runId, 'text_typed')]);
    expect(admissions.sort()).toEqual([false, true]);
    const rows = await second.unsafe('SELECT id,seq,text,chat_state FROM harness_shared.operator_turns');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: turn.turnId, seq: 0, text: '',
      chat_state: { execution: { runId, status: 'running', finalDigest: null }, scope } });
    await expect(store(second).beginTurn(randomUUID(), 'text_typed')).rejects.toThrow('turn-run-conflict');
    await expect(store().beginTurn(runId, 'voice_tts')).rejects.toThrow('turn-run-conflict');
  });

  it('P010 admission denies revoked credentials, foreign conversations and existing legacy rows', async () => {
    await expect(store().beginTurn('run', 'text_typed')).rejects.toThrow('turn-run-conflict');
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    await expect(store(first, { workspaceId: 'other-workspace' }).beginTurn('run', 'text_typed'))
      .rejects.toThrow('unauthorized');
    await first.unsafe('DELETE FROM harness_shared.user_sessions');
    await expect(store().beginTurn('run', 'text_typed')).rejects.toThrow('unauthorized');
    expect(await first.unsafe('SELECT id FROM harness_shared.operator_turns')).toHaveLength(0);
  });

  it('P010 terminal ack loss reconciles on a fresh connection without erasing a later card answer', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const runId = randomUUID();
    await store().beginTurn(runId, 'text_typed');
    expect((await worker().start(turn, ['provider'])).ok).toBe(true);
    const result = { runId, status: 'completed' as const, text: 'Choose next',
      tools: [{ name: 'chat:ask_choice', callId: 'stable-call', input: { a: 1, b: 2 } }] };
    // Lose the acknowledgement after the real commit, then replace the worker.
    await expect((async () => { await store().finalizeTurn(result); throw new Error('ack-lost'); })()).rejects.toThrow('ack-lost');
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=jsonb_set(tools,'{0,answered}','{"picks":[]}'::jsonb) WHERE id=$1`, [turn.turnId]);
    await store(second).finalizeTurn({ ...result, tools: [{ ...result.tools[0], input: { b: 2, a: 1 } }] });
    expect(await store(second).beginTurn(runId, 'text_typed')).toBe(false);
    const rows = await second.unsafe('SELECT text,tools,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0]).toMatchObject({ text: 'Choose next', tools: [{ answered: { picks: [] } }],
      chat_state: { execution: { status: 'completed' }, checkpoint: { state: { phase: 'completed' } } } });
    await expect(store(second).finalizeTurn({ ...result, text: 'Different' })).rejects.toThrow('turn-result-conflict');
    await expect(store(second).finalizeTurn({ ...result, runId: 'other-run' })).rejects.toThrow('turn-run-conflict');
  });

  it('P010 competing final results admit one exact winner and preserve its text', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    await store().beginTurn('run', 'voice_tts');
    const results = await Promise.allSettled([
      store().finalizeTurn({ runId: 'run', status: 'completed', text: 'First' }),
      store(second).finalizeTurn({ runId: 'run', status: 'completed', text: 'Second' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const rows = await first.unsafe('SELECT text FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(['First', 'Second']).toContain(rows[0].text);
  });

  it('P010 finalization preserves an answer committed before stream completion and rejects replacing its call', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const s = store();
    await s.beginTurn('run', 'text_typed');
    const tool = { name: 'chat:ask_choice', callId: 'choice', input: { prompt: 'Pick', options: [{ id: 'yes', label: 'Yes' }] } };
    await first.unsafe('UPDATE harness_shared.operator_turns SET tools=$1::jsonb WHERE id=$2',
      [first.json([tool]), turn.turnId]);
    await s.seedInteraction({ ...record(), schema: { id: 'choice-schema', revision: 1 } });
    const port = s.interactions(operatorChatTurnWorkflow({ workspaceId, turn }));
    const choice = new InteractionResolver({ store: port,
      validate: async (_schema, value) => ({ ok: true, value }) });
    expect((await choice.resolve({ conversationId: turn.conversationId, correlationId: 'choice' }, scope,
      { submissionId: 'answer', revision: 0,
        response: { action: 'submit', correlationId: 'choice', value: { picks: ['yes'] } } })).ok).toBe(true);
    await expect(s.finalizeTurn({ runId: 'run', status: 'completed', text: 'Changed',
      tools: [{ ...tool, input: { ...tool.input, prompt: 'Other' } }] })).rejects.toThrow('turn-result-conflict');
    await s.finalizeTurn({ runId: 'run', status: 'completed', text: 'Done', tools: [tool] });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools[0].answered.picks).toEqual([{ option_id: 'yes', label: 'Yes' }]);
    expect(await second.unsafe("SELECT id FROM harness_shared.operator_turns WHERE source='card_pick'")).toHaveLength(1);
    expect(await s.seedInteraction(record('late'))).toBe(false);
    expect(await s.compareAndSwap(turn, null, { state: { schemaVersion: 1, ...turn, revision: 0,
      phase: 'running', lastSequence: 0, capabilities }, effects: {} })).toBe(false);
  });

  it.each(['cancelled', 'failed'] as const)('P010 %s finalization preserves partial output and fences pending cards and dispatch', async status => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    const s = store();
    await s.beginTurn('run', 'text_typed');
    await worker(s).start(turn, ['effect']);
    await s.seedInteraction(record());
    await s.finalizeTurn({ runId: 'run', status, text: 'Partial' });
    expect((await s.read(turn))?.state.phase).toBe(status);
    const rows = await first.unsafe('SELECT text,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0]).toMatchObject({ text: 'Partial', chat_state: { interactions: { choice: { status: 'cancelled' } } } });
    expect((await s.admitDispatch(turn, 'effect', 0, async () => 'must not launch')).admitted).toBe(false);
    await expect(s.finalizeTurn({ runId: 'run', status: 'completed', text: 'Resurrected' })).rejects.toThrow('turn-result-conflict');
  });

  it('P010 finalization rechecks current authority and rejects lossy JSON before any history mutation', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    await store().beginTurn('run', 'text_typed');
    await expect(store().finalizeTurn({ runId: 'run', status: 'completed', text: 'Lost',
      tools: [{ name: 'read', input: { count: NaN } }] })).rejects.toThrow('invalid-turn-result');
    await first.unsafe('DELETE FROM harness_shared.user_sessions');
    await expect(store(second).finalizeTurn({ runId: 'run', status: 'completed', text: 'Forbidden' }))
      .rejects.toThrow('unauthorized');
    const rows = await first.unsafe('SELECT text,chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0]).toMatchObject({ text: '', chat_state: { execution: { status: 'running', finalDigest: null } } });
  });

  it('P010 terminal digest distinguishes parsed prototype-looking tool payloads', async () => {
    await first.unsafe('DELETE FROM harness_shared.operator_turns');
    await store().beginTurn('run', 'text_typed');
    const input = JSON.parse('{"__proto__":{"value":"one"},"safe":1}');
    const changed = JSON.parse('{"__proto__":{"value":"two"},"safe":1}');
    const result = { runId: 'run', status: 'completed' as const, text: 'Done', tools: [{ name: 'read', input }] };
    await store().finalizeTurn(result);
    await expect(store(second).finalizeTurn({ ...result, tools: [{ name: 'read', input: changed }] }))
      .rejects.toThrow('turn-result-conflict');
    await store(second).finalizeTurn(result);
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools[0].input).toEqual(input);
  });

  it('P010 durable worker recovery reads a completed tool without re-execution on a new connection', async () => {
    const a = worker();
    const dispatch = () => Promise.resolve({ ref: 'document:retained', text: 'Stored result' });
    expect((await a.start(turn, ['read'])).ok).toBe(true);
    expect((await a.runEffect(turn, 'read', dispatch, new AbortController().signal)).ok).toBe(true);
    const b = worker(store(second));
    let redispatches = 0;
    expect(await b.runEffect(turn, 'read', async () => { redispatches++; }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { source: 'checkpoint', result: { ref: 'document:retained' } } });
    expect(redispatches).toBe(0);
  });

  it('P010 two-worker terminal CAS admits one effect and preserves unrelated turn bytes', async () => {
    const other = randomUUID();
    await first.unsafe('INSERT INTO harness_shared.operator_turns (id,conversation_id,workspace_id,seq) VALUES ($1,$2,$3,1)',
    [other, turn.conversationId, workspaceId]);
    const a = worker(), b = worker(store(second));
    await a.start(turn, ['effect']);
    let effects = 0;
    const dispatch = async () => ++effects;
    const results = await Promise.all([a.runEffect(turn, 'effect', dispatch, new AbortController().signal),
      b.runEffect(turn, 'effect', dispatch, new AbortController().signal)]);
    expect(results.some(result => result.ok)).toBe(true);
    expect(effects).toBe(1);
    const rows = await first.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [other]);
    expect(rows[0].chat_state).toBeNull();
  });

  it('cancellation wins its PG fence before admission and prevents dispatch', async () => {
    const s = store();
    const original = s.compareAndSwap.bind(s);
    const b = worker(store(second));
    s.compareAndSwap = async (identity, revision, next) => {
      const result = await original(identity, revision, next);
      if (result && next.effects.read?.status === 'dispatching') expect((await b.cancel(turn)).ok).toBe(true);
      return result;
    };
    const a = worker(s);
    await a.start(turn, ['read']);
    let effects = 0;
    expect(await a.runEffect(turn, 'read', async () => ++effects, new AbortController().signal))
      .toEqual({ ok: false, code: 'cancelled' });
    expect(effects).toBe(0);
  });

  it('authority revoked at effect admission returns a typed refusal before launching', async () => {
    const s = store();
    await worker(s).start(turn, ['read']);
    const claimed = (await s.read(turn))!;
    claimed.state.revision++;
    claimed.effects.read = { status: 'dispatching', claimRevision: claimed.state.revision, admitted: false };
    expect(await s.compareAndSwap(turn, 0, claimed)).toBe(true);
    await second.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    let effects = 0;
    expect(await s.admitDispatch(turn, 'read', 1, async () => ++effects))
      .toEqual({ admitted: false, reason: 'unauthorized' });
    expect(effects).toBe(0);
    await second.unsafe("INSERT INTO harness_shared.user_sessions (token,workspace_id,user_id,expires_at) VALUES ('current',$1,$2,clock_timestamp()+interval '1 hour')",
      [workspaceId, scope.principalId]);
    const allowed = await s.admitDispatch(turn, 'read', 1, async () => ++effects);
    expect(allowed.admitted).toBe(true);
    if (allowed.admitted) expect(await allowed.result).toBe(1);
    expect(effects).toBe(1);
  });

  it('P010 durable result references survive replay retention and worker replacement without dispatch', async () => {
    const s = store();
    expect(await worker(s).start(turn, ['read'])).toMatchObject({ ok: true });
    const block = { id: 'document-one', kind: 'document' as const, title: 'First title',
      sources: [{ ref: 'document:one' }], actions: [{ id: 'open', kind: 'open', label: 'Open', ref: 'document:one' }] };
    await s.appendEvent({ ...envelope(1), event: { type: 'result', blocks: [block] } });
    for (let i = 2; i <= 6; i++) await s.appendEvent(envelope(i));
    expect((await store(second).replay(turn, 2)).events.some(event =>
      (event as ChatEventEnvelope).event.type === 'result')).toBe(false);
    let rows = await second.unsafe<{ results: unknown }[]>(
      "SELECT chat_state->'results' AS results FROM harness_shared.operator_turns WHERE id=$1", [turn.turnId]);
    expect(rows[0].results).toEqual([block]);
    await store(second).appendEvent({ ...envelope(7), event: { type: 'result', blocks: [{ ...block, title: 'Current title' }] } });
    rows = await first.unsafe("SELECT chat_state->'results' AS results FROM harness_shared.operator_turns WHERE id=$1", [turn.turnId]);
    expect(rows[0].results).toEqual([{ ...block, title: 'Current title' }]);
    await first.unsafe("UPDATE harness_shared.operator_turns SET chat_state=jsonb_set(chat_state,'{results}', $1::jsonb) WHERE id=$2",
      [first.json([{ ...block, sources: [] }]), turn.turnId]);
    await expect(store(second).replay(turn, 2)).rejects.toThrow('invalid-state');
  });

  it('bounded PG replay keeps the stable cursor and reconciles duplicate event acknowledgement', async () => {
    const s = store();
    await worker(s).start(turn, ['read']);
    for (let i = 1; i <= 5; i++) await s.appendEvent(envelope(i));
    const replacement = store(second);
    expect(await replacement.appendEvent(envelope(5))).toEqual(envelope(5));
    expect(await replacement.replay(turn, 2)).toMatchObject({ firstAvailableSequence: 2, lastSequence: 5,
      events: [envelope(3), envelope(4), envelope(5)] });
    expect(await worker(replacement).replay(turn, 0)).toEqual({ ok: false, code: 'replay-expired' });
    await expect(replacement.appendEvent(envelope(1))).rejects.toThrow('replay-expired');
    await expect(replacement.appendEvent({ ...envelope(5), event: { type: 'delta', text: 'competing bytes' } }))
      .rejects.toThrow('event-conflict');
  });

  it('foreign workspace, conversation and principal scopes cannot read a persisted checkpoint', async () => {
    await worker().start(turn, ['read']);
    await expect(store(second, { workspaceId: 'foreign' }).read(turn)).rejects.toThrow('unauthorized');
    await expect(store(second).read({ ...turn, conversationId: randomUUID() })).rejects.toThrow('unauthorized');
    for (const key of ['principalId', 'tenantId', 'customerId', 'publicOwnerId'] as const) {
      await expect(store(second, { scope: { ...scope, [key]: `foreign-${key}` } }).read(turn))
        .rejects.toThrow('unauthorized');
    }
    expect((await store(second).read(turn))?.state.phase).toBe('running');
  });

  it('future persisted versions and state/transient frames refuse without mutation', async () => {
    await first.unsafe('UPDATE harness_shared.operator_turns SET chat_state=$1::jsonb WHERE id=$2',
      [first.json({ schemaVersion: 2, sentinel: 'unchanged' }), turn.turnId]);
    await expect(store().read(turn)).rejects.toThrow('invalid-state');
    await expect(store().appendEvent({ ...envelope(1), event: { type: 'navigate', href: '/reports' } }))
      .rejects.toThrow('invalid-frame');
    const rows = await first.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].chat_state).toEqual({ schemaVersion: 2, sentinel: 'unchanged' });
  });

  it('P010 two-worker terminal CAS commits one decision and one workflow transition', async () => {
    const a = store(), b = store(second);
    expect(await a.seedInteraction(record())).toBe(true);
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    const results = await Promise.all([resolver(a).make().resolve(id, scope, answer('a')),
      resolver(b).make().resolve(id, scope, answer('b'))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toHaveLength(1);
    expect((await resolver(store(second)).make().read(id, scope))).toMatchObject({ ok: true, value: { status: 'resolved' } });
  });

  it('a workflow storage failure rolls back the decision and never acknowledges success', async () => {
    const s = store();
    await s.seedInteraction(record());
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect(await resolver(s, true).make().resolve(id, scope, answer('a')))
      .toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(await resolver(store(second)).make().read(id, scope)).toMatchObject({ ok: true, value: { status: 'pending' } });
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
    expect((await resolver(s).make().resolve(id, scope, answer('b'))).ok).toBe(true);
  });

  it('commit-success acknowledgement loss reconciles the exact durable decision without another transition', async () => {
    const s = store();
    await s.seedInteraction(record());
    const { port, make } = resolver(s);
    let lost = false;
    const resolved = make({ transact: async (identity, caller, decide) => {
      let changed = false;
      const result = await port.transact(identity, caller, current => {
        const mutation = decide(current); changed = !!mutation.next; return mutation;
      });
      if (changed && !lost) { lost = true; throw new Error('commit-ack-lost'); }
      return result;
    } });
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect(await resolved.resolve(id, scope, answer('same-submission'))).toMatchObject({ ok: true,
      value: { submissionId: 'same-submission', revision: 1 } });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toHaveLength(1);
  });

  it('current authority revoked after render prevents both reads and decisions', async () => {
    const s = store();
    await s.seedInteraction(record());
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect((await resolver(s).make().read(id, scope)).ok).toBe(true);
    await second.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    expect(await resolver(s).make().read(id, scope)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await resolver(s).make().resolve(id, scope, answer('revoked'))).toEqual({ ok: false, code: 'unauthorized' });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
  });

  it('an unpersistable completed result refuses acknowledgement and cannot be redispatched', async () => {
    const a = worker();
    await a.start(turn, ['read']);
    let effects = 0;
    expect(await a.runEffect(turn, 'read', async () => { effects++; return { count: Number.NaN }; },
      new AbortController().signal)).toEqual({ ok: false, code: 'checkpoint-write-failed' });
    expect(await worker(store(second)).runEffect(turn, 'read', async () => ++effects,
      new AbortController().signal)).toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(effects).toBe(1);
  });

  it('cancelling a turn durably closes pending decisions before a late answer', async () => {
    const s = store();
    const a = worker(s);
    await a.start(turn, ['read']);
    await s.seedInteraction(record());
    expect((await a.cancel(turn)).ok).toBe(true);
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect(await resolver(store(second)).make().resolve(id, scope, answer('late')))
      .toEqual({ ok: false, code: 'cancelled' });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
  });

  it('a genuinely fresh Node process recovers the committed result from existing PG rows', async () => {
    const a = worker();
    await a.start(turn, ['read']);
    expect((await a.runEffect(turn, 'read', async () => ({ ref: 'document:fresh-process' }),
      new AbortController().signal)).ok).toBe(true);
    const script = `
      import postgres from 'postgres';
      import { OperatorChatStore } from './packages/operator-core/lib/operator-chat-store.ts';
      import { TurnRecovery } from '@papercusp/chat-protocol/recovery';
      const sql = postgres(process.env.P010_CHAT_TEST_DSN, { max: 1 });
      const turn = JSON.parse(process.env.P010_CHAT_TEST_IDENTITY);
      const scope = JSON.parse(process.env.P010_CHAT_TEST_SCOPE);
      try {
        const store = new OperatorChatStore({ sql, workspaceId: 'p010-workspace', turn, scope, replayLimit: 4,
          async authorize(tx) {
            const rows = await tx.unsafe("SELECT token FROM harness_shared.user_sessions WHERE token='current' AND user_id=$1 AND workspace_id='p010-workspace' AND expires_at>clock_timestamp() FOR SHARE", [scope.principalId]);
            return rows.length === 1;
          } });
        const worker = new TurnRecovery({ capabilities: ${JSON.stringify(capabilities)}, store,
          authorize: async () => true, replay: (id, after) => store.replay(id, after), abortExecution: async () => {} });
        process.stdout.write(JSON.stringify(await worker.recover(turn, 'read')));
      } finally { await sql.end({ timeout: 5 }); }
    `;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 30_000, maxBuffer: 16_384,
      env: { ...process.env, P010_CHAT_TEST_DSN: databaseUrl,
        P010_CHAT_TEST_IDENTITY: JSON.stringify(turn), P010_CHAT_TEST_SCOPE: JSON.stringify(scope) },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true,
      value: { source: 'checkpoint', result: { ref: 'document:fresh-process' } } });
  }, 40_000);
});

describe('P010 production session authority and existing persisted card workflow', () => {
  it('resolves a signed owner child against the live SU token file without borrowing a token_index identity', async () => {
    const priorHome = process.env.PAPERCUSP_HOME;
    const home = mkdtempSync(join(tmpdir(), 'p010-child-authority-'));
    const bearer = 'owned-fixture-superuser-credential';
    process.env.PAPERCUSP_HOME = home;
    try {
      writeFileSync(join(home, 'superuser-token'), bearer, { mode: 0o600 });
      const input = { workspaceId, credentialSha256: createHash('sha256').update(bearer).digest('hex'),
        capability: 'chat:write', toolName: 'chat:ask_choice' };
      const authorize = operatorChatChildAuthority(input);
      expect(await first.begin(tx => authorize(tx))).toBe(true);
      expect(await first.unsafe('SELECT token FROM harness_shared.token_index')).toHaveLength(0);
      // The same closure must observe rotation at the same path immediately.
      writeFileSync(join(home, 'superuser-token'), 'rotated-fixture-superuser-credential');
      expect(await first.begin(tx => authorize(tx))).toBe(false);
      writeFileSync(join(home, 'superuser-token'), bearer);
      expect(await first.begin(tx => authorize(tx))).toBe(true);
      for (const invalid of [{ ...input, workspaceId: '*' }, { ...input, credentialSha256: 'malformed' },
        { ...input, capability: '' }, { ...input, toolName: '' }]) {
        expect(await first.begin(tx => operatorChatChildAuthority(invalid)(tx))).toBe(false);
      }
      rmSync(join(home, 'superuser-token'));
      expect(await first.begin(tx => authorize(tx))).toBe(false);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rechecks a signed PI child capability, allowlist and identity under the current session lock', async () => {
    const bearer = 'mounted-child-pi-credential';
    const fingerprint = createHash('sha256').update(bearer).digest('hex');
    await first.unsafe(`INSERT INTO harness_shared.pi_sessions
      (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
      VALUES ($1,'child',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`,
    [workspaceId, fingerprint]);
    await first.unsafe("INSERT INTO harness_shared.token_index VALUES ($1,'pi','pi:child',$2)", [bearer, workspaceId]);
    const authorize = operatorChatChildAuthority({ workspaceId, credentialSha256: fingerprint,
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    expect(await first.begin(async tx => {
      const allowed = await authorize(tx);
      for (const mutation of ["UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp()",
        "DELETE FROM harness_shared.token_index WHERE kind='pi'"]) {
        await expect(second.begin(async other => {
          await other.unsafe("SET LOCAL lock_timeout='30ms'");
          await other.unsafe(mutation);
        })).rejects.toMatchObject({ code: '55P03' });
      }
      return allowed;
    })).toBe(true);
    for (const mutation of ["UPDATE harness_shared.pi_sessions SET allowed_tools='[\"chat:*\"]'",
      "UPDATE harness_shared.pi_sessions SET capabilities='[]'", "UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp()",
      "UPDATE harness_shared.pi_sessions SET bearer_hash='rotated'", "DELETE FROM harness_shared.token_index WHERE kind='pi'"]) {
      await first.unsafe(mutation);
      expect(await first.begin(tx => authorize(tx))).toBe(false);
      await first.unsafe(`UPDATE harness_shared.pi_sessions SET allowed_tools='["chat:ask_choice"]',
        capabilities='["chat:write"]',ended_at=NULL,bearer_hash=$1`, [fingerprint]);
    }
  });

  const cookie = () => operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
    credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
    capability: 'chat:write', toolName: 'chat:ask_choice' });

  it('rechecks cookie expiry, active user, capability and workspace without trusting the rendered scope', async () => {
    const s = store(first, { authorize: cookie() });
    expect(await s.read(turn)).toBeNull();
    for (const mutation of ["UPDATE harness_shared.user_sessions SET expires_at=clock_timestamp()-interval '1 second'",
      'UPDATE harness_shared.users SET is_active=false',
      "UPDATE harness_shared.user_sessions SET capabilities='[\"chat:*\"]'",
      "UPDATE harness_shared.user_sessions SET workspace_id='foreign'"]) {
      await first.unsafe(mutation);
      await expect(s.read(turn)).rejects.toThrow('unauthorized');
      await first.unsafe("UPDATE harness_shared.user_sessions SET expires_at=clock_timestamp()+interval '1 hour', capabilities='[\"chat:write\"]',workspace_id=$1", [workspaceId]);
      await first.unsafe('UPDATE harness_shared.users SET is_active=true');
      expect(await s.read(turn)).toBeNull();
    }
    const foreign = operatorChatSessionAuthority({ workspaceId, principalId: 'foreign',
      credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    await expect(store(first, { authorize: foreign }).read(turn)).rejects.toThrow('unauthorized');
  });

  it('holds the real session and user revocation fence until the chat transaction finishes', async () => {
    for (const mutation of ["DELETE FROM harness_shared.user_sessions WHERE token='current'",
      'UPDATE harness_shared.users SET is_active=false']) {
      let checked = false;
      const s = store(first, { authorize: async tx => {
        const allowed = await cookie()(tx);
        await expect(second.begin(async other => {
          await other.unsafe("SET LOCAL lock_timeout='30ms'");
          await other.unsafe(mutation);
        })).rejects.toMatchObject({ code: '55P03' });
        checked = true;
        return allowed;
      } });
      expect(await s.read(turn)).toBeNull();
      expect(checked).toBe(true);
    }
    await second.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    await expect(store(first, { authorize: cookie() }).read(turn)).rejects.toThrow('unauthorized');
  });

  it('PI reads require the current bearer, exact tool allowlist, scope, expiry and unended session', async () => {
    const bearer = 'fixture-pi-secret';
    const hash = createHash('sha256').update(bearer).digest('hex');
    await first.unsafe(`INSERT INTO harness_shared.pi_sessions
      (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
      VALUES ($1,'public-chat',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`, [workspaceId, hash]);
    await first.unsafe("INSERT INTO harness_shared.token_index VALUES ($1,'pi','pi:public-chat',$2)", [bearer, workspaceId]);
    const make = (token = bearer, ws = workspaceId, principalId = 'pi:public-chat') => store(first, {
      scope: { ...scope, principalId }, authorize: operatorChatSessionAuthority({ workspaceId: ws, principalId,
        credential: { kind: 'pi', bearer: token, sessionId: 'public-chat' }, capability: 'chat:write', toolName: 'chat:ask_choice' }),
    });
    expect(await make().read(turn)).toBeNull();
    for (const denied of [make('wrong-secret'), make(bearer, 'foreign'), make(bearer, workspaceId, 'pi:other')]) {
      await expect(denied.read(turn)).rejects.toThrow('unauthorized');
    }
    for (const mutation of ["UPDATE harness_shared.pi_sessions SET allowed_tools='[\"chat:*\"]'",
      "UPDATE harness_shared.pi_sessions SET capabilities='[]'", 'UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp()',
      "UPDATE harness_shared.pi_sessions SET expires_at=clock_timestamp()-interval '1 second'"]) {
      await first.unsafe(mutation);
      await expect(make().read(turn)).rejects.toThrow('unauthorized');
      await first.unsafe(`UPDATE harness_shared.pi_sessions SET allowed_tools='["chat:ask_choice"]',
        capabilities='["chat:write"]',ended_at=NULL,expires_at=clock_timestamp()+interval '1 hour'`);
      expect(await make().read(turn)).toBeNull();
    }
  });

  it('system reads recheck the stored credential and capability after rotation', async () => {
    const bearer = 'fixture-system-secret';
    const hash = createHash('sha256').update(bearer).digest('hex');
    await first.unsafe(`INSERT INTO harness_shared.system_principals VALUES ($1,'operator',$2,'["*"]')`, [workspaceId, hash]);
    await first.unsafe("INSERT INTO harness_shared.token_index VALUES ($1,'system','system:operator',$2)", [bearer, workspaceId]);
    const s = store(first, { scope: { ...scope, principalId: 'system:operator' },
      authorize: operatorChatSessionAuthority({ workspaceId, principalId: 'system:operator',
        credential: { kind: 'system', bearer, name: 'operator' }, capability: 'operator:converse', toolName: 'operator:converse' }) });
    expect(await s.read(turn)).toBeNull();
    await second.unsafe("UPDATE harness_shared.system_principals SET bearer_hash='rotated'");
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
    await second.unsafe('UPDATE harness_shared.system_principals SET bearer_hash=$1', [hash]);
    expect(await s.read(turn)).toBeNull();
  });

  it.each(['system', 'pi'] as const)('parent %s revocation refuses a still-valid child and keeps the existing authority locks', async kind => {
    const bearer = `parent-${kind}-credential`;
    const hash = createHash('sha256').update(bearer).digest('hex');
    const principalId = `${kind}:parent`;
    if (kind === 'system') {
      await first.unsafe("INSERT INTO harness_shared.system_principals VALUES ($1,'parent',$2,'[\"chat:write\"]')", [workspaceId, hash]);
    } else {
      await first.unsafe(`INSERT INTO harness_shared.pi_sessions
        (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
        VALUES ($1,'parent',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`, [workspaceId, hash]);
    }
    const child = 'independently-valid-child';
    await first.unsafe(`INSERT INTO harness_shared.pi_sessions
      (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
      VALUES ($1,'child',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`,
    [workspaceId, createHash('sha256').update(child).digest('hex')]);
    await first.unsafe('INSERT INTO harness_shared.token_index VALUES ($1,$2,$3,$4),($5,\'pi\',\'pi:child\',$4)',
      [bearer, kind, principalId, workspaceId, child]);
    const authority = { kind, principalId, credentialSha256: hash };
    const parent = operatorChatParentAuthority({ workspaceId, authority, capability: 'chat:write', toolName: 'chat:ask_choice' });
    const childAuthority = operatorChatSessionAuthority({ workspaceId, principalId: 'pi:child',
      credential: { kind: 'pi', sessionId: 'child', bearer: child }, capability: 'chat:write', toolName: 'chat:ask_choice' });
    const s = store(first, { scope: { ...scope, principalId }, authorize: parent });
    expect(await s.read(turn)).toBeNull();
    expect(await first.begin(tx => childAuthority(tx))).toBe(true);
    const guarded = store(first, { scope: { ...scope, principalId }, authorize: async tx => {
      const allowed = await parent(tx);
      await expect(second.begin(async other => {
        await other.unsafe("SET LOCAL lock_timeout='30ms'");
        await other.unsafe('DELETE FROM harness_shared.token_index WHERE token=$1', [bearer]);
      })).rejects.toMatchObject({ code: '55P03' });
      return allowed;
    } });
    expect(await guarded.read(turn)).toBeNull();
    if (kind === 'system') await second.unsafe("UPDATE harness_shared.system_principals SET bearer_hash='rotated' WHERE name='parent'");
    else await second.unsafe("UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp() WHERE session_id='parent'");
    expect(await first.begin(tx => childAuthority(tx))).toBe(true);
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
  });

  it.each(['system', 'pi'] as const)('bearer identity %s must still exist and stay locked in the current transaction', async kind => {
    const bearer = `fixture-${kind}-identity`;
    const hash = createHash('sha256').update(bearer).digest('hex');
    const principalId = `${kind}:chat`;
    if (kind === 'system') {
      await first.unsafe("INSERT INTO harness_shared.system_principals VALUES ($1,'chat',$2,'[\"chat:write\"]')", [workspaceId, hash]);
    } else {
      await first.unsafe(`INSERT INTO harness_shared.pi_sessions
        (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
        VALUES ($1,'chat',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`, [workspaceId, hash]);
    }
    const credential = kind === 'system' ? { kind, bearer, name: 'chat' } : { kind, bearer, sessionId: 'chat' };
    const authorize = operatorChatSessionAuthority({ workspaceId, principalId, credential,
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const s = store(first, { scope: { ...scope, principalId }, authorize });
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
    await first.unsafe('INSERT INTO harness_shared.token_index VALUES ($1,$2,$3,$4)', [bearer, kind, principalId, workspaceId]);
    expect(await s.read(turn)).toBeNull();
    for (const mutation of ["UPDATE harness_shared.token_index SET kind='foreign'",
      "UPDATE harness_shared.token_index SET harness_slug='pi:foreign'",
      "UPDATE harness_shared.token_index SET workspace_id='foreign'"]) {
      await first.unsafe(mutation);
      await expect(s.read(turn)).rejects.toThrow('unauthorized');
      await first.unsafe('UPDATE harness_shared.token_index SET kind=$1,harness_slug=$2,workspace_id=$3', [kind, principalId, workspaceId]);
    }
    const guarded = store(first, { scope: { ...scope, principalId }, authorize: async tx => {
      const allowed = await authorize(tx);
      await expect(second.begin(async other => {
        await other.unsafe("SET LOCAL lock_timeout='30ms'");
        await other.unsafe('DELETE FROM harness_shared.token_index WHERE token=$1', [bearer]);
      })).rejects.toMatchObject({ code: '55P03' });
      return allowed;
    } });
    expect(await guarded.read(turn)).toBeNull();
    await second.unsafe('DELETE FROM harness_shared.token_index WHERE token=$1', [bearer]);
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
  });

  async function productionDecision(sql = first) {
    const s = store(sql, { authorize: cookie() });
    const workflow = operatorChatTurnWorkflow({ workspaceId, turn });
    const errors: string[] = [];
    return { s, errors, resolver: new InteractionResolver({ store: s.interactions(async (tx, next) => {
      try { await workflow(tx, next); }
      catch (error) { errors.push(String(error)); throw error; }
    }),
      validate: async (_schema, value) => ({ ok: true, value }) }) };
  }
  async function seedChoice() {
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=$1::jsonb WHERE id=$2`,
      [first.json([{ name: 'chat_ask_choice', callId: 'choice', input: {
        options: JSON.stringify([{ id: 'YES', label: 'Proceed' }, { id: 'no', label: 'Stop' }]),
      } }, { name: 'read', callId: 'unrelated', input: { ref: 'retained' } }]), turn.turnId]);
    const { s } = await productionDecision();
    await s.seedInteraction(record());
    return { conversationId: turn.conversationId, correlationId: 'choice' };
  }
  const pick = (submissionId: string, ids = ['yes']) => ({ submissionId, revision: 0,
    response: { action: 'submit', correlationId: 'choice', value: { picks: ids } } });

  it('two workers commit one real answered marker and card_pick turn, preserving unrelated tools', async () => {
    const identity = await seedChoice();
    const a = await productionDecision(), b = await productionDecision(second);
    const results = await Promise.all([a.resolver.resolve(identity, scope, pick('a')),
      b.resolver.resolve(identity, scope, pick('b'))]);
    expect([...a.errors, ...b.errors]).toEqual([]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const rows = await first.unsafe('SELECT role,text,source,tools,created_at FROM harness_shared.operator_turns ORDER BY seq');
    expect(rows).toHaveLength(2);
    expect(rows[0].tools).toEqual([{ name: 'chat_ask_choice', callId: 'choice', input: {
      options: JSON.stringify([{ id: 'YES', label: 'Proceed' }, { id: 'no', label: 'Stop' }]),
    }, answered: { picks: [{ option_id: 'yes', label: 'Proceed' }], at: expect.any(Number) } },
    { name: 'read', callId: 'unrelated', input: { ref: 'retained' } }]);
    expect(rows[1]).toMatchObject({ role: 'user', text: 'Proceed', source: 'card_pick' });
    expect(Number(rows[1].created_at)).toBe(Math.trunc(rows[0].tools[0].answered.at));
    const winner = results.find(result => result.ok)!;
    expect(winner.ok).toBe(true);
    if (winner.ok) {
      expect(await b.resolver.resolve(identity, scope, pick(winner.value.submissionId)))
        .toEqual({ ok: false, code: 'already-decided' });
      expect(await b.resolver.read(identity, scope)).toMatchObject({ ok: true, value: { decision: winner.value } });
    }
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
  });

  it('missing tool binding and invalid option rolls back the decision; valid retry commits once', async () => {
    const identity = await seedChoice();
    const { resolver: resolve } = await productionDecision();
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=jsonb_set(tools,'{0,callId}','"foreign"') WHERE id=$1`, [turn.turnId]);
    expect(await resolve.resolve(identity, scope, pick('wrong-binding'))).toEqual({ ok: false, code: 'needs-reconciliation' });
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=jsonb_set(tools,'{0,callId}','"choice"') WHERE id=$1`, [turn.turnId]);
    for (const ids of [['invented'], ['yes','no'], ['yes','yes']]) {
      expect(await resolve.resolve(identity, scope, pick('bad-picks', ids))).toEqual({ ok: false, code: 'needs-reconciliation' });
    }
    expect(await resolve.read(identity, scope)).toMatchObject({ ok: true, value: { status: 'pending' } });
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
    expect((await resolve.resolve(identity, scope, pick('valid'))).ok).toBe(true);
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
  });
});

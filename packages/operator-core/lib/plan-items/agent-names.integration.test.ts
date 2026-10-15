/**
 * agent-names.integration.test.ts — the stable agent-NAME registry + per-session
 * adoption (migration 140), against a real Postgres (testcontainer).
 *
 * The behaviors a fake-sql unit test can't prove, all upsert-shaped:
 *  - registerAgentName is IDEMPOTENT — ON CONFLICT (workspace, agent_name) DO
 *    UPDATE updated_at keeps ONE row (created_at stable), never a duplicate.
 *  - adoptAgentName enforces ONE NAME PER SESSION — ON CONFLICT (workspace,
 *    session_owner_id) DO UPDATE agent_name = EXCLUDED overwrites a prior binding,
 *    so re-adopting a different name re-points the session (D-006).
 * Mirrors curation-state.integration.test.ts's harness.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// agent-names imports these but the store functions under test take workspaceId
// directly and never call them — stub to keep the import light.
vi.mock('../agent-tools/coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { ownerId?: string }) => ({ ownerId: ctx?.ownerId ?? 'sess', userId: undefined }),
}));
vi.mock('../agent-tools/plans/source', () => ({ resolvePlanScope: async () => ({ workspaceId: 'ws' }) }));

const {
  registerAgentName,
  adoptAgentName,
  resolveAdoptedName,
  agentNameOwner,
  listNamesForOwner,
  listSessionsForAgentName,
} = await import('./agent-names');

const WS = 'ws-names';
const TRANSFER_WS = 'ws-names-owner-transfer';
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `an_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // agent_names + agent_name_sessions, faithful to migration 140 (PKs + nonempty CHECKs).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_names (
      workspace_id text NOT NULL,
      agent_name text NOT NULL,
      owner_user text NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      CONSTRAINT agent_names_pkey PRIMARY KEY (workspace_id, agent_name),
      CONSTRAINT agent_names_name_nonempty CHECK (agent_name <> ''),
      CONSTRAINT agent_names_owner_nonempty CHECK (owner_user <> '')
    )
  `);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_name_sessions (
      workspace_id text NOT NULL,
      session_owner_id text NOT NULL,
      agent_name text NOT NULL,
      owner_user text NOT NULL,
      adopted_at timestamptz DEFAULT now() NOT NULL,
      CONSTRAINT agent_name_sessions_pkey PRIMARY KEY (workspace_id, session_owner_id),
      CONSTRAINT agent_name_sessions_name_nonempty CHECK (agent_name <> '')
    )
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('agent-names registry (PG)', () => {
  it('agentNameOwner is null for an unregistered name', async () => {
    expect(await agentNameOwner(WS, 'ghost')).toBeNull();
  });

  it('re-adopting a name under a different owner transfers durable ownership', async () => {
    const first = await adoptAgentName(TRANSFER_WS, 'su-owner-a', 'handoff-name', 'alice');
    const second = await adoptAgentName(TRANSFER_WS, 'su-owner-b', 'handoff-name', 'bob');

    expect(first.ownerUser).toBe('alice');
    expect(second.ownerUser).toBe('bob');
    expect(await agentNameOwner(TRANSFER_WS, 'handoff-name')).toBe('bob');
    expect((await listNamesForOwner(TRANSFER_WS, 'alice')).some((name) => name.agentName === 'handoff-name')).toBe(false);
    expect((await listNamesForOwner(TRANSFER_WS, 'bob')).some((name) => name.agentName === 'handoff-name')).toBe(true);
  });

  it('registerAgentName is idempotent — re-registering keeps ONE row with a stable created_at', async () => {
    const first = await registerAgentName(WS, 'builder-1', 'alice');
    expect(first).toMatchObject({ agentName: 'builder-1', ownerUser: 'alice' });
    const second = await registerAgentName(WS, 'builder-1', 'alice');
    expect(second.createdAt).toEqual(first.createdAt); // not recreated — same created_at (Date value-equal)
    const mine = await listNamesForOwner(WS, 'alice');
    expect(mine.filter((n) => n.agentName === 'builder-1')).toHaveLength(1); // upsert, not duplicate
    expect(await agentNameOwner(WS, 'builder-1')).toBe('alice');
  });

  it('listNamesForOwner returns only that owner, ordered by agent_name', async () => {
    await registerAgentName(WS, 'builder-3', 'alice');
    await registerAgentName(WS, 'builder-2', 'alice');
    await registerAgentName(WS, 'other-1', 'bob');
    expect((await listNamesForOwner(WS, 'alice')).map((n) => n.agentName)).toEqual([
      'builder-1',
      'builder-2',
      'builder-3',
    ]);
    expect((await listNamesForOwner(WS, 'bob')).map((n) => n.agentName)).toEqual(['other-1']);
  });

  it('adoptAgentName binds a session to a name (and registers it), resolveAdoptedName reads it back', async () => {
    expect(await resolveAdoptedName(WS, 'su-aaa')).toBeNull();
    const row = await adoptAgentName(WS, 'su-aaa', 'queen-9', 'alice');
    expect(row).toMatchObject({ sessionOwnerId: 'su-aaa', agentName: 'queen-9', ownerUser: 'alice' });
    expect(await resolveAdoptedName(WS, 'su-aaa')).toBe('queen-9');
    expect(await agentNameOwner(WS, 'queen-9')).toBe('alice'); // adoption registered the name too
  });

  it('one name per session — re-adopting a DIFFERENT name overwrites the binding', async () => {
    await adoptAgentName(WS, 'su-bbb', 'builder-1', 'alice');
    expect(await resolveAdoptedName(WS, 'su-bbb')).toBe('builder-1');
    await adoptAgentName(WS, 'su-bbb', 'builder-2', 'alice'); // same session, new name
    expect(await resolveAdoptedName(WS, 'su-bbb')).toBe('builder-2'); // re-pointed, not a second binding
  });

  it('lists the sessions that adopted one stable name without leaking other names', async () => {
    await adoptAgentName(WS, 'su-name-a', 'email-agent', 'alice');
    await adoptAgentName(WS, 'su-name-b', 'email-agent', 'alice');
    await adoptAgentName(WS, 'su-other', 'calendar-agent', 'alice');

    const sessions = await listSessionsForAgentName(WS, 'email-agent');
    expect(sessions.map((row) => row.sessionOwnerId).sort()).toEqual(['su-name-a', 'su-name-b']);
    expect(sessions.every((row) => row.agentName === 'email-agent')).toBe(true);
  });

  it('a name is scoped to its workspace — same name in another workspace is independent', async () => {
    await registerAgentName('ws-other', 'builder-1', 'carol');
    expect(await agentNameOwner('ws-other', 'builder-1')).toBe('carol');
    expect(await agentNameOwner(WS, 'builder-1')).toBe('alice'); // unaffected
  });
});

/** The original census reads exact durable episode owners after their status changes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { identityActivationConditionKey, runUnappliedActivationCensusOnce } from './wedged-identity-activation-watchdog';

const store = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: store.sql }),
}));
vi.mock('../workspace-registry', async (original) => ({
  ...(await original<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'identity-rail-pg',
}));

let db: FreshPgDb;
const WS = 'identity-rail-pg', OWNER = 'identity-pg-owner';
const pair = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-a' };
const activation = (applied: boolean) => ({ schemaVersion: 1,
  attribution: { actorId: OWNER, principalId: 'system:superuser', sessionId: OWNER },
  desired: pair, prepared: applied ? null : pair, applied: applied ? pair : null,
  status: applied ? 'applied' : 'prepared' });
const key = identityActivationConditionKey('unapplied', WS, OWNER);
let open: Set<string>;
const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
  expect(event.oneShot).toBe(true); open.add(event.conditionKey!); return true;
});
const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
const pass = () => runUnappliedActivationCensusOnce({
  rail: { broadcast, resolve }, readOpenConditions: async () => [...open],
  loadPositiveControl: async () => ({ recentBriefs: 1, recentJournalTurns: 2 }),
  resolveLiveness: async ids => new Map(ids.map(id => [id, 'live' as const])),
  escalateUnapplied: async () => { expect(open.has(key)).toBe(true); },
  escalateNotMeasured: async () => {},
});

beforeAll(async () => {
  db = await createFreshPgDb('identity-rail'); store.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (owner_id text, workspace_id text, control_state jsonb);
    CREATE TABLE harness_shared.session_identity_activation_events
      (id integer, owner_id text, workspace_id text, phase text, recorded_at timestamptz);
    CREATE TABLE harness_shared.session_turn_journal (owner_id text, workspace_id text, created_at timestamptz);`);
}, 120_000);
afterAll(async () => { store.sql = null; await db?.cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks(); open = new Set();
  await db.sql`TRUNCATE harness_shared.session_briefs, harness_shared.session_identity_activation_events,
    harness_shared.session_turn_journal`;
  await db.sql`INSERT INTO harness_shared.session_briefs VALUES
    (${OWNER}, ${WS}, ${db.sql.json({ activation: activation(false) })})`;
  await db.sql`INSERT INTO harness_shared.session_identity_activation_events VALUES
    (1, ${OWNER}, ${WS}, 'prepared', now() - interval '1 hour')`;
  await db.sql`INSERT INTO harness_shared.session_turn_journal VALUES
    (${OWNER}, ${WS}, now() - interval '30 minutes'), (${OWNER}, ${WS}, now() - interval '10 minutes')`;
});

describe('original identity census durable recovery SQL', () => {
  it('opens from journaled turns, reloads a now-applied owner, resolves, and rearms', async () => {
    expect((await pass()).verdict).toBe('unapplied'); expect(open.has(key)).toBe(true);
    await db.sql`UPDATE harness_shared.session_briefs SET control_state =
      ${db.sql.json({ activation: activation(true) })} WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
    expect((await pass()).verdict).toBe('clean'); expect(open.size).toBe(0);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
    await db.sql`UPDATE harness_shared.session_briefs SET control_state =
      ${db.sql.json({ activation: activation(false) })} WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
    await pass(); expect(open.has(key)).toBe(true);
  });

  it('preserves missing, foreign, malformed and unreadable registrations', async () => {
    await pass();
    await db.sql`UPDATE harness_shared.session_briefs SET control_state =
      ${db.sql.json({ activation: activation(true) })}, workspace_id = 'foreign'`;
    await pass(); expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    await db.sql`UPDATE harness_shared.session_briefs SET workspace_id = ${WS}, control_state = '{}'::jsonb`;
    await pass(); expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    await db.sql`DELETE FROM harness_shared.session_briefs`;
    await pass(); expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    await db.sql`ALTER TABLE harness_shared.session_briefs RENAME TO briefs_unreadable`;
    try {
      expect((await pass()).verdict).toBe('not-measured');
      expect(open.has(key)).toBe(true); expect(resolve).not.toHaveBeenCalled();
    } finally { await db.sql`ALTER TABLE harness_shared.briefs_unreadable RENAME TO session_briefs`; }
  });
});

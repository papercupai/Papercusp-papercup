import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readWorkspaceOwnerIdentity } from './store';

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('owner-identity');
  await db.sql.unsafe(`CREATE TABLE harness_shared.agent_facts (
    id bigserial PRIMARY KEY, workspace_id text, scope text, key text, claim jsonb,
    source_hive text, superseded_at timestamptz, retracted_at timestamptz,
    expires_at timestamptz NOT NULL DEFAULT 'infinity')`);
}, 60_000);
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.agent_facts`; });
afterAll(async () => { await db?.cleanup(); });

describe('exact workspace owner identity', () => {
  it('reads an old authoritative identity despite hundreds of newer facts and another workspace', async () => {
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, scope, key, claim)
      VALUES ('fixture', 'workspace', 'owner-identity', ${db.sql.json({ displayName: 'Fixture owner' })}),
             ('other', 'workspace', 'owner-identity', ${db.sql.json({ displayName: 'Wrong owner' })})`;
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, scope, key)
      SELECT 'fixture', 'workspace', 'newer-' || n FROM generate_series(1, 250) n`;
    expect(await readWorkspaceOwnerIdentity('fixture', db.sql)).toEqual({
      status: 'known', displayName: 'Fixture owner', sourceRef: expect.any(String),
    });
  });

  it('never guesses absent, expired, foreign or malformed identity records', async () => {
    expect(await readWorkspaceOwnerIdentity('fixture', db.sql)).toMatchObject({ status: 'unknown', reason: 'not-recorded' });
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, scope, key, claim, expires_at, source_hive)
      VALUES ('fixture', 'workspace', 'owner-identity', '{"displayName":"Expired"}', now() - interval '1 day', NULL),
             ('fixture', 'workspace', 'owner-identity', '{"displayName":"Foreign"}', 'infinity', 'peer')`;
    expect(await readWorkspaceOwnerIdentity('fixture', db.sql)).toMatchObject({ status: 'unknown', reason: 'not-recorded' });
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, scope, key, claim)
      VALUES ('fixture', 'workspace', 'owner-identity', '{"displayName":"<instructions>"}')`;
    expect(await readWorkspaceOwnerIdentity('fixture', db.sql)).toMatchObject({ status: 'unknown', reason: 'invalid-record' });
  });

  it('reports conflicting live records instead of silently choosing one', async () => {
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, scope, key, claim)
      VALUES ('fixture', 'workspace', 'owner-identity', '{"displayName":"First"}'),
             ('fixture', 'workspace', 'owner-identity', '{"displayName":"Second"}')`;
    expect(await readWorkspaceOwnerIdentity('fixture', db.sql)).toMatchObject({ status: 'unknown', displayName: null, reason: 'conflicting-records' });
  });
});

/**
 * feedback.integration.test.ts — memory-feedback signal capture
 * (memory_feedback, 000-baseline), against a real Postgres.
 *
 * The module talks to mem0's PG via a raw `pg` Client built from
 * pgClientFields(); we mock that to a per-test DB, and mock activeWorkspaceId().
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - recordFeedback INSERTs the row with the active workspace_id + null-coalesced
 *    optional columns;
 *  - it is BEST-EFFORT: when mem0 is unconfigured (pgClientFields → null) it is a
 *    silent no-op (never throws into the user-facing API);
 *  - loadFeedbackStats counts edits, folds delete + forget_all into total_deletes
 *    (TEETHED), returns recent rows newest-first, and is user-scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ conn: '', fieldsNull: false, ws: 'ws-mf' }));
vi.mock('./mem0-connection', () => ({ pgClientFields: async () => (h.fieldsNull ? null : { connectionString: h.conn }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const { recordFeedback, loadFeedbackStats } = await import('./feedback');

let rootSql: postgres.Sql;
const USER = randomUUID();
const OTHER = randomUUID();

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `mf_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  h.conn = u.toString();
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to 000-baseline (uuid user_id + the action CHECK).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.memory_feedback (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      mem_id text NOT NULL, user_id uuid NOT NULL, workspace_id text NOT NULL,
      action text NOT NULL, kind text, prior_text text, new_text text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT memory_feedback_action_check CHECK (action = ANY (ARRAY['edit','delete','forget_all']))
    )`);
  hb_seed();
}, 90_000);

function hb_seed() {
  h.fieldsNull = false;
  h.ws = 'ws-mf';
}

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.memory_feedback`;
  hb_seed();
});

describe('memory-feedback capture (PG)', () => {
  it('recordFeedback INSERTs with the active workspace + null-coalesced columns', async () => {
    await recordFeedback({ memId: 'm1', userId: USER, action: 'edit', priorText: 'old', newText: 'new' });
    const row = (await rootSql`SELECT mem_id, workspace_id, action, kind, prior_text, new_text FROM harness_shared.memory_feedback`)[0]!;
    expect(row).toMatchObject({ mem_id: 'm1', workspace_id: 'ws-mf', action: 'edit', kind: null, prior_text: 'old', new_text: 'new' });
  });

  it('is BEST-EFFORT — an unconfigured mem0 (pgClientFields → null) is a silent no-op', async () => {
    h.fieldsNull = true;
    await expect(recordFeedback({ memId: 'm2', userId: USER, action: 'delete' })).resolves.toBeUndefined(); // no throw
    expect(await rootSql`SELECT 1 FROM harness_shared.memory_feedback`).toHaveLength(0); // nothing written
  });

  it('loadFeedbackStats folds delete + forget_all into total_deletes, user-scoped, newest-first', async () => {
    await recordFeedback({ memId: 'a', userId: USER, action: 'edit' });
    await recordFeedback({ memId: 'b', userId: USER, action: 'edit' });
    await recordFeedback({ memId: 'c', userId: USER, action: 'delete' });
    await recordFeedback({ memId: 'd', userId: USER, action: 'forget_all' });
    await recordFeedback({ memId: 'z', userId: OTHER, action: 'delete' }); // another user — invisible

    const stats = (await loadFeedbackStats(USER))!;
    expect(stats.total_edits).toBe(2);
    expect(stats.total_deletes).toBe(2); // delete (1) + forget_all (1) — the combined rollup
    expect(stats.recent.map((r) => r.mem_id)).toEqual(['d', 'c', 'b', 'a']); // created_at DESC, OTHER's row excluded
  });

  it('loadFeedbackStats respects recentLimit', async () => {
    for (const m of ['a', 'b', 'c']) await recordFeedback({ memId: m, userId: USER, action: 'edit' });
    const stats = (await loadFeedbackStats(USER, 2))!;
    expect(stats.total_edits).toBe(3); // counts are not limited…
    expect(stats.recent).toHaveLength(2); // …but the recent feed is
  });
});

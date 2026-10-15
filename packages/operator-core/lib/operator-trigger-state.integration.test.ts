/**
 * operator-trigger-state.integration.test.ts — readTriggerState, the idle
 * short-circuit digest, against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - unconsumedEvents counts ONLY pending_events with consumed_at IS NULL (a
 *    consumed backlog must not block idle);
 *  - operatorInboxCount joins message_recipients↔messages for dept
 *    'system:operator' + status 'pending' (cross-schema);
 *  - the best-effort inbox/perHarness reads degrade to 0/undefined when a table
 *    is absent (try/catch), never throwing;
 *  - fingerprint() is pure and EXCLUDES the cosmetic perHarness (so display
 *    tweaks don't churn the idle cache).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-trig';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { readTriggerState, fingerprint } = await import('./operator-trigger-state');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `trig_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`CREATE SCHEMA papercusp_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.pending_events (
      id text NOT NULL, consumed_at timestamptz, source_id text,
      workspace_id text NOT NULL,
      CONSTRAINT pending_events_workspace_nonempty CHECK (workspace_id <> '')
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.projects (
      status text NOT NULL, slug text, workspace_id text NOT NULL,
      CONSTRAINT projects_workspace_nonempty CHECK (workspace_id <> '')
    )`);
  await rootSql.unsafe(`CREATE TABLE papercusp_shared.messages (id text PRIMARY KEY, status text NOT NULL)`);
  await rootSql.unsafe(`CREATE TABLE papercusp_shared.message_recipients (message_id text NOT NULL, dept_slug text NOT NULL)`);
  // audit_log intentionally NOT created → perHarness degrades to undefined via try/catch.
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.pending_events, harness_shared.projects, papercusp_shared.messages, papercusp_shared.message_recipients`;
});

describe('readTriggerState (PG, cross-schema)', () => {
  it('counts only UNCONSUMED events, lists projects, and counts the operator inbox', async () => {
    await rootSql`INSERT INTO harness_shared.pending_events (id, consumed_at, workspace_id) VALUES
      ('e1', NULL, ${WS}), ('e2', NULL, ${WS}), ('e3', now(), ${WS})`; // e3 consumed
    await rootSql`INSERT INTO harness_shared.projects (status, slug, workspace_id) VALUES
      ('active', 'web', ${WS}), ('paused', 'api', ${WS})`;
    await rootSql`INSERT INTO papercusp_shared.messages (id, status) VALUES ('m1','pending'), ('m2','pending'), ('m3','done')`;
    await rootSql`INSERT INTO papercusp_shared.message_recipients (message_id, dept_slug) VALUES
      ('m1','system:operator'), ('m2','some-harness'), ('m3','system:operator')`; // m2 not operator; m3 done

    const s = await readTriggerState();
    expect(s.unconsumedEvents).toBe(2); // e3 (consumed) excluded
    expect(s.projects).toEqual([{ slug: 'api', status: 'paused' }, { slug: 'web', status: 'active' }]); // ORDER BY slug
    expect(s.operatorInboxCount).toBe(1); // only m1 (operator + pending)
    expect(s.perHarness).toBeUndefined(); // audit_log absent → best-effort omitted, no throw
  });

  it('returns zeros for an empty workspace (no throw)', async () => {
    const s = await readTriggerState();
    expect(s).toMatchObject({ unconsumedEvents: 0, projects: [], operatorInboxCount: 0 });
  });
});

describe('fingerprint (pure)', () => {
  it('is a 16-hex hash that EXCLUDES the cosmetic perHarness but tracks events/projects/inbox', () => {
    const base = { unconsumedEvents: 2, projects: [{ slug: 'a', status: 'x' }], operatorInboxCount: 1 };
    const withPh = fingerprint({ ...base, perHarness: [{ slug: 'a', status: 'x', lastTouched: 't' }] });
    const noPh = fingerprint({ ...base, perHarness: undefined });
    expect(withPh).toMatch(/^[0-9a-f]{16}$/);
    expect(withPh).toBe(noPh); // perHarness does NOT affect the fingerprint
    expect(fingerprint({ ...base, unconsumedEvents: 3 })).not.toBe(noPh); // events DO
    expect(fingerprint({ ...base, operatorInboxCount: 9 })).not.toBe(noPh); // inbox DOES
  });
});

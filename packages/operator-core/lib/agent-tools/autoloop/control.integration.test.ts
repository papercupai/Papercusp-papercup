/**
 * control.integration.test.ts — the autoloop:control MCP tool handler (pause/
 * resume path), against a real Postgres. tool.handler called directly; getOrgPg
 * bound to the testcontainer; resetFireErrors (the reset-errors forward) mocked.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - pause/resume flips `active` ONLY for the harness's `bp-schedule-*` routines —
 *    the `name LIKE 'bp-schedule-%'` filter must NOT touch other routines
 *    (git-sync, etc.) or routines of OTHER harnesses;
 *  - it returns the affected routine names, and a note when there are none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../autoloop', () => ({ resetFireErrors: vi.fn(async () => 0) })); // reset-errors path forwards here — out of scope

const controlTool = (await import('./control')).default;
const call = (op: string, harness = 'web') => controlTool.handler({ op, harness } as never, {} as never) as Promise<{ content: { text: string }[] }>;

let rootSql: postgres.Sql;
const activeOf = async (id: string) => (await rootSql<{ active: boolean }[]>`SELECT active FROM harness_shared.routines WHERE id=${id}`)[0]?.active;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ac_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, install_slug text NOT NULL, name text NOT NULL,
      trigger_kind text NOT NULL, trigger_config jsonb NOT NULL, target_role text NOT NULL,
      active boolean DEFAULT true NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
      workspace_id text NOT NULL,
      CONSTRAINT routines_install_slug_name_key UNIQUE (install_slug, name)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines`;
  await rootSql`INSERT INTO harness_shared.routines (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id) VALUES
    ('r1','web','bp-schedule-daily',  'schedule', '{}'::jsonb, 'worker', true, 'ws1'),
    ('r2','web','bp-schedule-weekly', 'schedule', '{}'::jsonb, 'worker', true, 'ws1'),
    ('r3','web','git-sync',           'schedule', '{}'::jsonb, 'worker', true, 'ws1'),
    ('r4','api','bp-schedule-daily',  'schedule', '{}'::jsonb, 'worker', true, 'ws1')`;
});

describe('autoloop:control pause/resume (PG)', () => {
  it('pause flips ONLY the harness bp-schedule-* routines; git-sync + other harnesses untouched', async () => {
    const res = await call('pause', 'web');
    expect(await activeOf('r1')).toBe(false); // bp-schedule-daily paused
    expect(await activeOf('r2')).toBe(false); // bp-schedule-weekly paused
    expect(await activeOf('r3')).toBe(true);  // git-sync NOT touched (LIKE filter)
    expect(await activeOf('r4')).toBe(true);  // other harness NOT touched (install_slug filter)
    expect(JSON.parse(res.content[0]!.text).routines.sort()).toEqual(['bp-schedule-daily', 'bp-schedule-weekly']);
  });

  it('resume flips them back to active', async () => {
    await call('pause', 'web');
    await call('resume', 'web');
    expect(await activeOf('r1')).toBe(true);
    expect(await activeOf('r2')).toBe(true);
  });

  it('returns a note when the harness has no bp-schedule-* routines', async () => {
    const res = await call('pause', 'no-such-harness');
    const out = JSON.parse(res.content[0]!.text);
    expect(out.routines).toEqual([]);
    expect(out.note).toMatch(/no bp-schedule/);
  });
});

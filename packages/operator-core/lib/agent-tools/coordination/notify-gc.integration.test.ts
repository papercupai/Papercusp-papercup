/**
 * notify-gc.integration.test.ts — gcOldNotifies, the notify-firehose GC over
 * coord_event_log, against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove (it's a 3-predicate DELETE):
 *  - it deletes ONLY rows that are surface='messages' AND body->>'kind'='notify'
 *    AND older than retentionDays — so a recent notify, a NON-notify message (a
 *    real coord message!), and a notify on another surface all SURVIVE;
 *  - retentionDays controls the age cutoff;
 *  - it returns the deleted count.
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

const { gcOldNotifies } = await import('./notify-gc');

let rootSql: postgres.Sql;
const remainingIds = async () => (await rootSql<{ msg_id: string }[]>`SELECT msg_id FROM harness_shared.coord_event_log ORDER BY msg_id`).map((r) => r.msg_id);

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ngc_${randomBytes(5).toString('hex')}`;
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
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      surface text NOT NULL, writer_key text, msg_id text NOT NULL,
      body jsonb NOT NULL, ts timestamptz DEFAULT now() NOT NULL
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_event_log RESTART IDENTITY`;
});

async function ins(msgId: string, surface: string, kind: string, ageDays: number) {
  await rootSql`INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts)
                VALUES (${surface}, ${msgId}, ${rootSql.json({ kind })}, now() - make_interval(days => ${ageDays}))`;
}

describe('gcOldNotifies (PG)', () => {
  it('deletes ONLY old notify-messages; recent notify / non-notify message / other-surface notify survive', async () => {
    await ins('old-notify-1', 'messages', 'notify', 5);
    await ins('old-notify-2', 'messages', 'notify', 5);
    await ins('recent-notify', 'messages', 'notify', 0);   // within retention → kept
    await ins('old-message', 'messages', 'message', 5);     // a REAL coord message, old → kept (kind filter)
    await ins('old-notify-presence', 'presence', 'notify', 5); // other surface → kept
    const n = await gcOldNotifies(3);
    expect(n).toBe(2); // both old-notify-* deleted
    expect(await remainingIds()).toEqual(['old-message', 'old-notify-presence', 'recent-notify']); // the 3 survivors
  });

  it('retentionDays controls the age cutoff', async () => {
    await ins('age2', 'messages', 'notify', 2);
    expect(await gcOldNotifies(3)).toBe(0); // 2 days < 3-day retention → kept
    expect(await gcOldNotifies(1)).toBe(1); // 2 days > 1-day retention → deleted
  });
});

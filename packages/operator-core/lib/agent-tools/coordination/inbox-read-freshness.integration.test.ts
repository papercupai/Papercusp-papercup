/**
 * lastInboxReadAtBatch against real PostgreSQL — which tool_invocations rows count
 * as "read my coord mail" (WI-6554700010009285).
 *
 * Measured 2026-10-12: a relaunched CLI's SessionStart lifecycle report
 * (activity:report, kind=lifecycle, no hook_bundle) at 17:18:47Z was counted as an
 * inbox read, so the wake engine retired a message-less inbox-wake that no turn
 * ever saw. Only an activity:report carrying hook_bundle folds the inbox.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { lastInboxReadAtBatch } from './inbox-read-freshness';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `irf_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  // Only the columns lastInboxReadAtBatch reads (the real table has many more).
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.tool_invocations (
      id bigserial PRIMARY KEY,
      coord_owner_id text,
      tool_name text NOT NULL,
      invoked_at timestamptz NOT NULL,
      args_json jsonb
    );`);
  const rows: Array<[string, string, string, unknown]> = [
    // su-a: a bundled hook read at 10:00, then only a lifecycle "session started" at 10:05.
    ['su-a', 'activity:report', '2026-10-12T10:00:00Z', { tool_name: 'Bash', hook_bundle: { generation: 'g1' } }],
    ['su-a', 'activity:report', '2026-10-12T10:05:00Z', { kind: 'lifecycle', summary: '▶ session started' }],
    // su-b: an explicit coord:inbox read, then an unbundled pre-tool report.
    ['su-b', 'coord:inbox', '2026-10-12T11:00:00Z', {}],
    ['su-b', 'activity_report', '2026-10-12T11:10:00Z', { tool_name: 'Read' }],
    // su-c: never folded the inbox at all.
    ['su-c', 'activity:report', '2026-10-12T12:00:00Z', { kind: 'lifecycle', summary: '▶ session started' }],
    // Not a read for anyone.
    ['su-a', 'coord:send', '2026-10-12T13:00:00Z', {}],
  ];
  for (const [owner, tool, at, args] of rows) {
    await sql`INSERT INTO harness_shared.tool_invocations (coord_owner_id, tool_name, invoked_at, args_json)
              VALUES (${owner}, ${tool}, ${at}, ${sql.json(args as postgres.JSONValue)})`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('lastInboxReadAtBatch', () => {
  it('foldedOnly: a lifecycle or unbundled activity:report is not a read', async () => {
    const reads = await lastInboxReadAtBatch(['su-a', 'su-b', 'su-c'], { foldedOnly: true, sql: sql as never });
    expect(reads.get('su-a')).toBe('2026-10-12T10:00:00.000Z');
    expect(reads.get('su-b')).toBe('2026-10-12T11:00:00.000Z');
    expect(reads.has('su-c')).toBe(false);
  });

  it('default (deafness detection) still credits every activity:report', async () => {
    const reads = await lastInboxReadAtBatch(['su-a', 'su-b', 'su-c'], { sql: sql as never });
    expect(reads.get('su-a')).toBe('2026-10-12T10:05:00.000Z');
    expect(reads.get('su-b')).toBe('2026-10-12T11:10:00.000Z');
    expect(reads.get('su-c')).toBe('2026-10-12T12:00:00.000Z');
  });
});

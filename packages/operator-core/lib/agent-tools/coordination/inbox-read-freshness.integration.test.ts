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

  it('finds the latest qualifying read without scanning an owner’s retained history', async () => {
    await sql`
      INSERT INTO harness_shared.tool_invocations (coord_owner_id, tool_name, invoked_at, args_json)
      SELECT 'su-history', 'coord:inbox',
             '2026-10-01T00:00:00Z'::timestamptz + n * interval '1 second', '{}'::jsonb
        FROM generate_series(1, 8000) AS n
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations (coord_owner_id, tool_name, invoked_at, args_json)
      VALUES ('su-history', 'coord_orient', '2026-10-12T14:00:00Z', '{}'::jsonb),
             ('su-history', 'coord:send', '2026-10-12T15:00:00Z', '{}'::jsonb)
    `;
    // Match the maintained production index, without adding a new access path.
    await sql`CREATE INDEX tool_invocations_coord_owner_idx
                ON harness_shared.tool_invocations (coord_owner_id, invoked_at DESC)
                WHERE coord_owner_id IS NOT NULL`;
    await sql`ANALYZE harness_shared.tool_invocations`;

    type PlanNode = {
      'Relation Name'?: string;
      'Actual Rows'?: number;
      'Rows Removed by Filter'?: number;
      Plans?: PlanNode[];
    };
    let plan: PlanNode | undefined;
    // Explain the actual function's parameterized query, then execute that same
    // query for the result assertion. This guards work performed, not wall time.
    const explainedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        return (async () => {
          const parts = [...args[0] as TemplateStringsArray];
          parts[0] = 'EXPLAIN (ANALYZE, FORMAT JSON) ' + parts[0];
          Object.defineProperty(parts, 'raw', { value: [...parts] });
          const explained = await Reflect.apply(target, thisArg, [parts, ...args.slice(1)]);
          plan = explained[0]['QUERY PLAN'][0].Plan;
          return Reflect.apply(target, thisArg, args);
        })();
      },
    });
    const reads = await lastInboxReadAtBatch(['su-history', 'su-history', 'su-absent'], {
      foldedOnly: true,
      sql: explainedSql as never,
    });
    expect([...reads]).toEqual([['su-history', '2026-10-12T14:00:00.000Z']]);
    expect(plan).toBeDefined();
    const examinedRows = (node: PlanNode): number =>
      (node['Relation Name'] === 'tool_invocations'
        ? (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)
        : 0) + (node.Plans ?? []).reduce((sum, child) => sum + examinedRows(child), 0);
    expect(examinedRows(plan!)).toBeLessThan(64);
  });
});

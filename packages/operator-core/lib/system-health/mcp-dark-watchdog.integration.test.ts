import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readInteractiveToolFreeTurns } from './mcp-dark-watchdog';

const START = Date.parse('2026-10-23T00:00:00Z');
const NOW = START + 24 * 60 * 60_000;
let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dark_turns_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const uri = new URL(adminUri);
  uri.pathname = `/${dbName}`;
  sql = postgres(uri.toString(), { max: 2, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.tool_invocations (
      coord_owner_id text, invoked_at timestamptz NOT NULL,
      tool_name text NOT NULL, call_origin text
    );
    CREATE INDEX tool_invocations_coord_owner_idx
      ON harness_shared.tool_invocations (coord_owner_id, invoked_at DESC)
      WHERE coord_owner_id IS NOT NULL;
    CREATE TABLE harness_shared.session_turns (
      workspace_id text, owner text, speaker text, ts timestamptz
    );
  `);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('interactive watchdog assistant-turn query', () => {
  it('keeps origin classification, host-start cutoff and assistant-turn bounds', async () => {
    const invocations: Array<[string, number, string, string | null]> = [
      ['explicit', 1, 'coord:send', 'unknown'],
      ['explicit', 2, 'coord:inbox', 'agent'],
      ['explicit', 3, 'coord:send', 'hook'],
      ['explicit', 4, 'coord:send', 'ui'],
      ['explicit', 5, 'coord:send', 'system'],
      ['explicit', 6, 'coord:send', 'invalid'],
      ['explicit', 7, 'coord:inbox', null],
      ['legacy', 2, 'coord:send', null],
      ['legacy', 3, 'coord:inbox', null],
      ['unknown', 2, 'coord:inbox', 'unknown'],
      ['unknown', 3, 'coord:send', 'hook'],
      ['pre-start', -1, 'coord:send', 'agent'],
      ['at-start', 0, 'coord:send', 'agent'],
    ];
    for (const [owner, minute, tool, origin] of invocations) {
      await sql`INSERT INTO harness_shared.tool_invocations VALUES
        (${owner}, ${new Date(START + minute * 60_000)}, ${tool}, ${origin})`;
    }
    for (const minute of [1, 2, 3, 4]) {
      await sql`INSERT INTO harness_shared.session_turns VALUES
        ('default', 'explicit', 'assistant', ${new Date(START + minute * 60_000)})`;
    }
    await sql`INSERT INTO harness_shared.session_turns VALUES
      ('other', 'explicit', 'assistant', ${new Date(NOW)}),
      ('default', 'explicit', 'user', ${new Date(NOW)}),
      ('default', 'explicit', 'assistant', ${new Date(NOW + 1)}),
      ('default', 'pre-start', 'assistant', ${new Date(START - 1)}),
      ('default', 'pre-start', 'assistant', ${new Date(START)})`;
    const rows = await readInteractiveToolFreeTurns(sql,
      ['explicit', 'legacy', 'unknown', 'pre-start', 'at-start', 'absent']
        .map(ownerId => ({ ownerId, startedAt: START })),
      NOW, 2);
    const byOwner = new Map(rows.map(row => [row.owner_id, row]));
    expect(Number(byOwner.get('explicit')?.last_agent_call_ms)).toBe(START + 2 * 60_000);
    expect(Number(byOwner.get('explicit')?.assistant_turn_count)).toBe(2);
    expect(Number(byOwner.get('explicit')?.last_assistant_turn_ms)).toBe(START + 4 * 60_000);
    expect(Number(byOwner.get('legacy')?.last_agent_call_ms)).toBe(START + 2 * 60_000);
    expect(Number(byOwner.get('unknown')?.last_agent_call_ms)).toBe(START + 2 * 60_000);
    expect(byOwner.get('pre-start')?.last_agent_call_ms).toBeNull();
    expect(Number(byOwner.get('pre-start')?.assistant_turn_count)).toBe(1);
    expect(Number(byOwner.get('at-start')?.last_agent_call_ms)).toBe(START);
    expect(byOwner.get('absent')?.last_agent_call_ms).toBeNull();
    expect(Number(byOwner.get('absent')?.assistant_turn_count)).toBe(0);
    expect(byOwner.get('absent')?.last_assistant_turn_ms).toBeNull();
  });

  it('does no database work with no live hosts', async () => {
    expect(await readInteractiveToolFreeTurns(null as never, [], NOW, 3)).toEqual([]);
  });

  it('seeks the latest qualifying call without scanning retained agent history', async () => {
    await sql`INSERT INTO harness_shared.tool_invocations
      SELECT 'history', ${new Date(START)}::timestamptz + n * interval '1 second', 'coord:send', 'agent'
        FROM generate_series(1, 8000) AS n`;
    await sql`INSERT INTO harness_shared.tool_invocations VALUES
      ('history', ${new Date(START + 8001_000)}, 'coord:send', 'hook')`;
    await sql`ANALYZE harness_shared.tool_invocations`;
    type PlanNode = {
      'Relation Name'?: string;
      'Actual Rows'?: number;
      'Actual Loops'?: number;
      'Rows Removed by Filter'?: number;
      Plans?: PlanNode[];
    };
    let plan: PlanNode | undefined;
    const explainedSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        if (!args[0][0].includes('WITH live_hosts')) return Reflect.apply(target, thisArg, args);
        return (async () => {
          const parts = [...args[0] as TemplateStringsArray];
          parts[0] = 'EXPLAIN (ANALYZE, FORMAT JSON) ' + parts[0];
          Object.defineProperty(parts, 'raw', { value: [...parts] });
          const result = await Reflect.apply(target, thisArg, [parts, ...args.slice(1)]);
          plan = result[0]['QUERY PLAN'][0].Plan;
          return Reflect.apply(target, thisArg, args);
        })();
      },
    });
    const rows = await readInteractiveToolFreeTurns(explainedSql,
      [{ ownerId: 'history', startedAt: START }], NOW, 3);
    expect(Number(rows[0].last_agent_call_ms)).toBe(START + 8000_000);
    expect(plan).toBeDefined();
    const examinedRows = (node: PlanNode): number =>
      (node['Relation Name'] === 'tool_invocations'
        ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1)
        : 0) + (node.Plans ?? []).reduce((sum, child) => sum + examinedRows(child), 0);
    const examined = examinedRows(plan!);
    console.info(`WATCHDOG_LATEST_AGENT_PLAN examinedRows=${examined} retainedAgentRows=8000`);
    expect(examined).toBeLessThan(64);
  });
});

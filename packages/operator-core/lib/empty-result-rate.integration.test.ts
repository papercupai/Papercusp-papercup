// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { EMPTY_RESULT_RATE_SQL, gradeEmptyResultRate, readEmptyResultRate } from './empty-result-rate';

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../libs/papercusp/libs/db/sql/1576-code-run-rollup-time-index.sql',
);
const INDEX = 'tool_invocations_code_run_time_idx';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}
interface Explanation { Plan: PlanNode; 'Execution Time': number }

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}
function buffers(plan: PlanNode): number {
  return (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
}
function removed(plan: PlanNode): number {
  return nodes(plan).reduce((sum, node) =>
    sum + (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1), 0);
}

let db: FreshPgDb;
let sql: Sql;
let baseline: Explanation;
let baselineRows: unknown[];

async function explain(): Promise<Explanation> {
  const rows = await sql.unsafe<{ 'QUERY PLAN': Explanation[] }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${EMPTY_RESULT_RATE_SQL}`, [7],
  );
  return rows[0]!['QUERY PLAN'][0]!;
}

beforeAll(async () => {
  db = await createFreshPgDb('empty-result-rate-index');
  sql = db.sql;
  await sql.unsafe(`
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'test-workspace',
      harness_slug text NOT NULL DEFAULT 'papercusp',
      tool_name text NOT NULL,
      coord_owner_id text,
      invoked_at timestamptz NOT NULL,
      metadata_json jsonb
    );
    CREATE INDEX tool_invocations_telemetry_idx ON harness_shared.tool_invocations
      (workspace_id, harness_slug, invoked_at DESC);
    CREATE INDEX tool_invocations_invoked_at_cov_idx ON harness_shared.tool_invocations
      (invoked_at DESC) INCLUDE (tool_name);
    INSERT INTO harness_shared.tool_invocations
      (id, tool_name, coord_owner_id, invoked_at, metadata_json)
    SELECT g, CASE WHEN g % 80 = 0 THEN 'code:run' ELSE 'other:tool' END,
      'noise-' || (g % 7), now() - interval '1 day',
      jsonb_build_object('payload', repeat(md5(g::text), 24)) ||
        CASE WHEN g % 800 = 0 THEN '{"emptyMapping":true}'::jsonb ELSE '{}'::jsonb END
    FROM generate_series(1, 80000) g;
    INSERT INTO harness_shared.tool_invocations
      (id, tool_name, coord_owner_id, invoked_at, metadata_json) VALUES
      (90001, 'code:run', 'owner-a', now(), '{"emptyMapping":false}'),
      (90002, 'code:run', 'owner-a', now(), '{}'),
      (90003, 'code:run', 'owner-a', now() - interval '8 days', '{"emptyMapping":true}'),
      (90004, 'other:tool', 'owner-a', now(), '{"emptyMapping":true}'),
      (90005, 'code:run', 'owner-b', now(), '{"emptyMapping":null}'),
      (90006, 'code:run', NULL, now(), '{"emptyMapping":true}'),
      (90007, 'code:run', 'clean-owner', now(), '{}');
  `);
  await sql.unsafe('VACUUM ANALYZE harness_shared.tool_invocations');
  baselineRows = await sql.unsafe(EMPTY_RESULT_RATE_SQL, [7]);
  baseline = await explain();
  await applyMigrationForTest(sql, MIGRATION);
}, 60_000);

afterAll(async () => { await db?.cleanup(); });

describe('empty-result rollup selective time index', () => {
  it('preserves the existing owner counts, marker-presence semantics and window', async () => {
    const rollup = await readEmptyResultRate(async <T>(query: string, params: unknown[]) =>
      await sql.unsafe(query, params as never) as unknown as T[]);
    expect(rollup.byOwner.find(row => row.ownerId === 'owner-a')).toMatchObject({ emptyRuns: 1, totalRuns: 2 });
    expect(rollup.byOwner.find(row => row.ownerId === 'owner-b')).toMatchObject({ emptyRuns: 1, totalRuns: 1 });
    expect(rollup.byOwner.find(row => row.ownerId === null)).toMatchObject({ emptyRuns: 1, totalRuns: 1 });
    expect(rollup.byOwner.find(row => row.ownerId === 'clean-owner')).toMatchObject({ emptyRuns: 0, totalRuns: 1 });
    const rows = await sql.unsafe(EMPTY_RESULT_RATE_SQL, [7]);
    const byOwner = (values: unknown[]) => [...values].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(byOwner(rows)).toEqual(byOwner(baselineRows));
  });

  it('avoids scanning unrelated tools and reduces buffer work without planner forcing', async () => {
    const optimized = await explain();
    expect(nodes(optimized.Plan).some(node => node['Index Name'] === INDEX)).toBe(true);
    expect(removed(baseline.Plan)).toBeGreaterThan(70_000);
    expect(removed(optimized.Plan)).toBeLessThan(100);
    expect(buffers(optimized.Plan)).toBeLessThan(buffers(baseline.Plan) / 3);
    // Buffer work is the gate; elapsed time varies with cache warmth/scheduling.
    console.info('EMPTY_RESULT_INDEX_PROOF', JSON.stringify({
      baselineBuffers: buffers(baseline.Plan), optimizedBuffers: buffers(optimized.Plan),
      baselineMs: baseline['Execution Time'], optimizedMs: optimized['Execution Time'],
    }));
  });

  it('applies idempotently and stores no metadata payload in the index', async () => {
    await applyMigrationForTest(sql, MIGRATION);
    const [row] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'harness_shared' AND indexname = ${INDEX}`;
    expect(row?.indexdef).toContain("WHERE (tool_name = 'code:run'::text)");
    expect(row?.indexdef).not.toContain('metadata_json');
  });
});

describe('empty-result fleet denominator', () => {
  let denominatorDb: FreshPgDb;
  let denominatorSql: Sql;

  beforeAll(async () => {
    denominatorDb = await createFreshPgDb('empty-result-denominator');
    denominatorSql = denominatorDb.sql;
    await denominatorSql.unsafe(`CREATE TABLE harness_shared.tool_invocations (
      tool_name text NOT NULL,
      coord_owner_id text,
      invoked_at timestamptz NOT NULL,
      metadata_json jsonb
    )`);
  });
  beforeEach(async () => { await denominatorSql.unsafe('TRUNCATE harness_shared.tool_invocations'); });
  afterAll(async () => { await denominatorDb?.cleanup(); });

  const read = () => readEmptyResultRate(async <T>(query: string, params: unknown[]) =>
    await denominatorSql.unsafe(query, params as never) as unknown as T[]);

  it('includes clean named and null owners in a mixed fleet denominator', async () => {
    await denominatorSql.unsafe(`
      INSERT INTO harness_shared.tool_invocations
      SELECT 'code:run', 'affected-owner', now(),
        CASE WHEN g = 1 THEN '{"emptyMapping":true}'::jsonb ELSE '{}'::jsonb END
      FROM generate_series(1, 20) g;
      INSERT INTO harness_shared.tool_invocations
      SELECT 'code:run', 'clean-owner', now(), '{}'::jsonb FROM generate_series(1, 100);
      INSERT INTO harness_shared.tool_invocations
      SELECT 'code:run', NULL, now(), NULL FROM generate_series(1, 50);
      INSERT INTO harness_shared.tool_invocations VALUES
        ('code:run', 'old-owner', now() - interval '8 days', '{"emptyMapping":true}'),
        ('other:tool', 'other-owner', now(), '{"emptyMapping":true}');
    `);
    const rollup = await read();
    expect(rollup).toMatchObject({ totalEmptyRuns: 1, totalRuns: 170, pctEmpty: 1 });
    expect(rollup.byOwner).toEqual([
      { ownerId: 'affected-owner', emptyRuns: 1, totalRuns: 20, lastSeen: expect.anything() },
      { ownerId: null, emptyRuns: 0, totalRuns: 50, lastSeen: null },
      { ownerId: 'clean-owner', emptyRuns: 0, totalRuns: 100, lastSeen: null },
    ]);
    expect(gradeEmptyResultRate(rollup).rating).toBe('healthy');
  });

  it('grades a sufficiently populated entirely clean fleet healthy', async () => {
    await denominatorSql.unsafe(`
      INSERT INTO harness_shared.tool_invocations
      SELECT 'code:run', CASE WHEN g <= 20 THEN 'clean-owner' END, now(), '{}'::jsonb
      FROM generate_series(1, 40) g;
    `);
    const rollup = await read();
    expect(rollup).toMatchObject({ totalEmptyRuns: 0, totalRuns: 40, pctEmpty: 0 });
    expect(rollup.byOwner).toHaveLength(2);
    expect(gradeEmptyResultRate(rollup).rating).toBe('healthy');
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { pgReadQuery } from './pg-read-query';
import { retainedSqlCaptureExpression, compileRetainedSql, SQL_INPUT_COLUMN } from './retained-sql';
import { continuityProbeRevision, retainedProbeProcedure, replayRetainedSqlProbe, runContinuityProbeBatch, type ContinuityProbe } from './continuity-probes';
import { retainMeasurementProvenance } from './measurement-provenance';

// The production runner validates the pinned projected contract before dispatch.
await import('./agent-tools/dev/pg_query');

let db: FreshPgDb;
const clock = '2026-11-03T00:00:00.000Z';
const query = `SELECT count(*)::float8 n,max(id)::text largest,sum(duration_ms)::float8 total,
  CASE WHEN count(*)>=2 THEN avg(duration_ms)::float8 END budget
  FROM harness_shared.replay_rows WHERE workspace_id='private'
  AND measured_at>now()-interval '1 hour'`;

beforeAll(async () => {
  expect(continuityProbeRevision('dev:pg_query'), 'production SQL tool must be registered before probe execution').toBeTruthy();
  db = await createFreshPgDb('retained-sql');
  await db.sql`CREATE TABLE harness_shared.replay_rows
    (workspace_id text,id bigint,duration_ms float8,measured_at timestamptz)`;
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.replay_rows`;
  await db.sql`INSERT INTO harness_shared.replay_rows VALUES
    ('private',9007199254740993,10,now()),('private',9007199254740994,30,now()),
    ('foreign',1,999,now()),('private',2,999,now()-interval '2 hours')`;
});

async function capture(sql = query) {
  const expression = retainedSqlCaptureExpression(sql);
  expect(expression).not.toBeNull();
  const result = await pgReadQuery(`SELECT __pc_data.*,transaction_timestamp()::text measured_at,
    ${expression} AS "${SQL_INPUT_COLUMN}" FROM (${sql}) __pc_data`, { client: db.sql });
  const row = result.rows[0]!;
  return { row, inputs: row[SQL_INPUT_COLUMN], transactionAt: String(row.measured_at) };
}

describe('bounded historical SQL source replay (real PostgreSQL)', () => {
  it('captures source rows through the production probe runner and replays after source mutation', async () => {
    const probe: ContinuityProbe = { kind: 'sql', sql: query, maxRows: 5,
      schemaRevision: continuityProbeRevision('dev:pg_query')!,
      expect: { path: '$.rows[0].budget', op: 'lte', value: 25 } };
    const batch = await runContinuityProbeBatch([{
      source: { kind: 'work-item', id: 'WI-retained-sql-test', harness: 'papercusp' },
      checkIndex: 0, check: { id: 'sql', claim: 'original budget', recheck: 'SQL', probe },
    }], { retainMeasurement: true, dispatchTool: async (_name, args) => ({
      data: await pgReadQuery(String(args.sql), { client: db.sql }),
    }) });
    const reading = batch.results[0]!;
    expect(reading, JSON.stringify(reading.diagnostic)).toMatchObject({ status: 'fresh', observed: 20, provenance: { gaps: [] } });
    expect(JSON.parse(reading.provenance!.procedure.snapshot)).toMatchObject({ sqlInputs: {
      relation: '"harness_shared"."replay_rows"', truncated: false,
      rows: [{ id: '9007199254740993' }, { id: '9007199254740994' }],
    } });
    expect(reading.provenance!.diagnostics.some(d => d.path.includes('__papercusp_measurement'))).toBe(false);
    await db.sql`UPDATE harness_shared.replay_rows SET duration_ms=10000`;
    expect(await replayRetainedSqlProbe({ value: 20, unit: 'ms', provenance: reading.provenance },
      (sql, opts) => pgReadQuery(sql, { ...opts, client: db.sql })))
      .toMatchObject({ scope: 'sql-query', status: 'reproduced', value: 20, verdict: 'pass' });
  });

  it('recomputes from original scoped inputs after the live source is deleted', async () => {
    const captured = await capture();
    expect(captured.inputs).toMatchObject({ truncated: false, rows: [
      { workspace_id: 'private', id: '9007199254740993', duration_ms: '10' },
      { workspace_id: 'private', id: '9007199254740994', duration_ms: '30' },
    ] });
    const compiled = compileRetainedSql(query, captured.inputs, captured.transactionAt)!;
    expect(compiled).not.toContain('FROM harness_shared');
    await db.sql`DROP TABLE harness_shared.replay_rows`;
    try {
      const replay = await pgReadQuery(compiled, { client: db.sql });
      expect(replay.rows[0]).toEqual({ n: 2, largest: '9007199254740994', total: 40, budget: 20 });
    } finally {
      await db.sql`CREATE TABLE harness_shared.replay_rows
        (workspace_id text,id bigint,duration_ms float8,measured_at timestamptz)`;
    }
  });

  it('retains typed original inputs through the shared provenance policy and reports mismatch honestly', async () => {
    const c = await capture();
    const probe: ContinuityProbe = { kind: 'sql', sql: query, maxRows: 50, schemaRevision: 'historical',
      expect: { path: '$.rows[0].budget', op: 'lte', value: 25 } };
    const { [SQL_INPUT_COLUMN]: _inputs, measured_at: _clock, ...original } = c.row;
    const provenance = retainMeasurementProvenance({ procedure: retainedProbeProcedure(probe, c.inputs),
      result: { rows: [original], truncated: false }, startedAt: clock, finishedAt: new Date().toISOString(), transactionAt: c.transactionAt });
    expect(provenance.gaps).toEqual([]);
    const read: typeof pgReadQuery = (sql, opts) => pgReadQuery(sql, { ...opts, client: db.sql });
    await db.sql`UPDATE harness_shared.replay_rows SET duration_ms=10000`;
    expect(await replayRetainedSqlProbe({ value: 20, unit: 'ms', provenance }, read))
      .toMatchObject({ scope: 'sql-query', status: 'reproduced', value: 20, verdict: 'pass' });
    expect(await replayRetainedSqlProbe({ value: 999, unit: 'ms', provenance }, read))
      .toMatchObject({ status: 'mismatch', value: 20 });
  });

  it('marks row overflow unavailable without changing the measured aggregate', async () => {
    await db.sql`INSERT INTO harness_shared.replay_rows SELECT 'private',i,50,now() FROM generate_series(1,40) i`;
    const c = await capture();
    expect(c.row.n).toBe(42);
    expect(c.inputs).toMatchObject({ truncated: true });
    expect(compileRetainedSql(query, c.inputs, c.transactionAt)).toBeNull();
  });

  it('captures an empty source as a real empty population', async () => {
    await db.sql`TRUNCATE harness_shared.replay_rows`;
    const c = await capture();
    const compiled = compileRetainedSql(query, c.inputs, c.transactionAt);
    expect(compiled).not.toBeNull();
    expect((await pgReadQuery(compiled!, { client: db.sql })).rows[0]).toMatchObject({ n: 0, budget: null });
  });

  it('refuses unsupported queries, forged input shape and missing historical inputs before any SQL runs', async () => {
    for (const sql of [
      'SELECT * FROM unscoped', 'SELECT * FROM a.b JOIN a.c ON true',
      'WITH x AS (SELECT * FROM a.b) SELECT * FROM x',
      'SELECT pg_sleep(1) FROM a.b', 'SELECT private.fn() FROM a.b',
      'SELECT (SELECT count(*) FROM a.c) FROM a.b',
      'SELECT id::private.secret FROM a.b', 'DELETE FROM a.b RETURNING *',
      'SELECT * FROM a.b LIMIT 1', 'SELECT current_user FROM a.b',
    ]) expect(retainedSqlCaptureExpression(sql)).toBeNull();
    const c = await capture();
    expect(compileRetainedSql(query, { ...(c.inputs as object), relation: 'foreign.source' }, c.transactionAt)).toBeNull();
    const read = vi.fn<typeof pgReadQuery>();
    expect(await replayRetainedSqlProbe({ value: 20, unit: 'ms' }, read)).toMatchObject({ status: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
  });
});

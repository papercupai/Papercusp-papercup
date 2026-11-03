/**
 * EI-27740004761558804: satisfiability controls for the nine downgrades on
 * EI-27736757841457894. SQL and predicates are verbatim revision-14 snapshots,
 * except the explicit float8 correction to operation-outcomes below. The old
 * numeric-string result is retained as a regression control.
 * These are synthetic budget controls, NOT measurements of application speed.
 * Tool rows live in a disposable database. Only pg_stat_statements readers,
 * clock_timestamp and pg_sleep are substituted for the counter-interval check;
 * its SQL, reset guards, interval arithmetic and predicate remain unchanged.
 * No production schema, statistics, clock, sleep or application data is touched.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { assertSingleReadStatement } from './pg-read-query';
import { evaluateContinuityPredicate, type ContinuityPredicate } from './continuity-probes';

type Criterion = { key: string; check: { probe: { sql: string; expect: ContinuityPredicate } } };
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/performance-rubric-rev14.json', import.meta.url), 'utf8')) as {
  rubricRef: string; revision: number; criteria: Criterion[];
};
const originalOutcome = fixture.criteria.find(c => c.key === 'operation-outcomes')!;
const outcomeSql = originalOutcome.check.probe.sql.replace(' END non_success_pct', ' END::float8 non_success_pct');
const criteria = fixture.criteria.map(c => c !== originalOutcome ? c : {
  ...c, check: { ...c.check, probe: { ...c.check.probe, sql: outcomeSql } },
});
const interval = criteria.find(c => c.key === 'pg-statement-load')!;
const tools = criteria.filter(c => c !== interval);
const latency = tools.filter(c => c.key.endsWith('-latency'));
let db: FreshPgDb;

async function seed(options: { n?: number; scale?: number; failures?: boolean; phases?: boolean } = {}) {
  const { n = 200, scale = 1, failures = false, phases = true } = options;
  await db.sql`TRUNCATE harness_shared.tool_invocations`;
  await db.sql`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id,tool_name,duration_ms,status,invoked_at,args_json,metadata_json,
       serving_host,serving_process_id,serving_build_sha)
    SELECT 'papercusp-workspace', tool, ms * ${scale},
      CASE WHEN ${failures} AND i <= 20 THEN 'error' ELSE 'ok' END,
      now() - interval '1 minute', '{}'::jsonb,
      CASE WHEN ${phases} THEN '{"handlerPhases":{"elapsedMs":100,"attributedMs":95}}'::jsonb ELSE '{}'::jsonb END,
      'private-control',42,'fixture-build'
    FROM (VALUES
      ('coord:orient',1500),('scheduler:get_next',1500),('fleet:assignments',1000),
      ('work_items:list',500),('coord:presence',4000),('coord:inbox',1500),
      ('state:read',150),('dev:pipeline_position',500),('work_items:get',100),('work_items:claim',100)
    ) tools(tool,ms) CROSS JOIN generate_series(1,${n}::int) samples(i)
  `;
}

async function measure(c: Criterion) {
  assertSingleReadStatement(c.check.probe.sql);
  const rows = await db.sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    // Explicit pg_catalog placement makes only this private counter source use
    // the fixture clock/sleep. now() still uses the real transaction clock.
    await tx`SET LOCAL search_path TO performance_controls, pg_catalog, public`;
    await tx`SELECT set_config('performance_controls.phase','before',true)`;
    await tx`SELECT set_config('statement_timeout','4000',true)`;
    return tx.unsafe(c.check.probe.sql);
  });
  return { rows };
}

function verdict(c: Criterion, result: unknown) {
  return evaluateContinuityPredicate(c.check.probe.expect, result);
}

beforeAll(async () => {
  db = await createFreshPgDb('performance-budget-controls');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.tool_invocations (
      workspace_id text, tool_name text, duration_ms float8, status text, invoked_at timestamptz,
      args_json jsonb, metadata_json jsonb, serving_host text, serving_process_id int, serving_build_sha text
    );
    CREATE SCHEMA performance_controls;
    CREATE TABLE performance_controls.counters (
      cores float8 NOT NULL, reset_changed boolean NOT NULL DEFAULT false,
      dealloc_changed boolean NOT NULL DEFAULT false, regressed boolean NOT NULL DEFAULT false,
      zero_interval boolean NOT NULL DEFAULT false
    );
    INSERT INTO performance_controls.counters (cores) VALUES (2.5);
    CREATE FUNCTION performance_controls.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$
        SELECT '2026-11-03T00:00:00Z'::timestamptz +
          CASE WHEN current_setting('performance_controls.phase',true)='after' AND NOT zero_interval
            THEN interval '20 seconds' ELSE interval '0 seconds' END
        FROM performance_controls.counters
      $$;
    CREATE FUNCTION performance_controls.pg_sleep(double precision) RETURNS void
      LANGUAGE plpgsql VOLATILE AS $$ BEGIN
        PERFORM set_config('performance_controls.phase','after',true);
      END $$;
    CREATE VIEW performance_controls.pg_stat_statements AS
      SELECT true toplevel,
        CASE WHEN current_setting('performance_controls.phase',true)='after' THEN
          CASE WHEN regressed THEN 99 ELSE 200 END ELSE 100 END::bigint calls,
        CASE WHEN current_setting('performance_controls.phase',true)='after' THEN
          100000 + cores * 20000 ELSE 100000 END::float8 total_exec_time,
        CASE WHEN current_setting('performance_controls.phase',true)='after' THEN 30000000 ELSE 10000000 END::numeric wal_bytes
      FROM performance_controls.counters;
    CREATE VIEW performance_controls.pg_stat_statements_info AS
      SELECT '2026-11-02T00:00:00Z'::timestamptz +
        CASE WHEN reset_changed AND current_setting('performance_controls.phase',true)='after'
          THEN interval '1 second' ELSE interval '0 seconds' END stats_reset,
        CASE WHEN dealloc_changed AND current_setting('performance_controls.phase',true)='after'
          THEN 2 ELSE 1 END::bigint dealloc
      FROM performance_controls.counters;
  `).simple();
}, 120_000);

afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await seed();
  await db.sql`UPDATE performance_controls.counters SET cores=2.5,reset_changed=false,
    dealloc_changed=false,regressed=false,zero_interval=false`;
});

describe('revision-14 performance budget controls (private synthetic PostgreSQL)', () => {
  it('covers exactly the nine audited downgrades with the original predicate paths', () => {
    expect(fixture.rubricRef).toBe('papercusp-app-performance');
    expect(fixture.revision).toBe(14);
    expect(fixture.criteria.map(c => c.key).sort()).toEqual([
      'wake-orient-latency','claim-next-latency','fleet-assignments-latency','work-items-list-latency',
      'coord-read-tail-latency','high-volume-read-latency','wake-path-attribution','pg-statement-load','operation-outcomes',
    ].sort());
    expect(latency).toHaveLength(6);
  });

  it('pins the correction to one SQL output cast without changing the population or predicate', () => {
    expect(outcomeSql).not.toBe(originalOutcome.check.probe.sql);
    expect(outcomeSql.replace(' END::float8 non_success_pct', ' END non_success_pct')).toBe(originalOutcome.check.probe.sql);
  });
  it('retains the revision-14 defect: numeric-string zero fails the numeric predicate', async () => {
    const result = verdict(originalOutcome, await measure(originalOutcome));
    expect(result).toEqual({ matches: false, actual: '0.00000000000000000000' });
  });

  for (const c of criteria) {
    it(`${c.key}: SQL and predicate accept a concrete passing population`, async () => {
      const result = await measure(c);
      const checked = verdict(c, result);
      expect(checked.actual).not.toBeNull();
      expect(checked.matches).toBe(true);
      if (c.key.endsWith('-latency')) expect(checked.actual).toBe(50);
      if (c.key === 'pg-statement-load') expect(checked.actual).toBe(2.5);
      if (c.key === 'wake-path-attribution') expect(checked.actual).toBe(100);
      if (c.key === 'operation-outcomes') expect(Number(checked.actual)).toBe(0);
    });
  }

  for (const c of latency) {
    it(`${c.key}: rejects a four-times-slower population without changing the budget`, async () => {
      await seed({ scale: 4 });
      expect(verdict(c, await measure(c))).toEqual({ matches: false, actual: 200 });
    });
    it(`${c.key}: incomplete sample populations stay unavailable`, async () => {
      await seed({ n: 19 });
      expect(verdict(c, await measure(c))).toEqual({ matches: false, actual: null });
    });
  }

  it('wake-path-attribution: missing phases fail the coverage bar', async () => {
    await seed({ phases: false });
    const c = tools.find(c => c.key === 'wake-path-attribution')!;
    expect(verdict(c, await measure(c))).toEqual({ matches: false, actual: 0 });
  });
  it('operation-outcomes: errors remain in the denominator and breach the 1% bar', async () => {
    await seed({ failures: true });
    const c = tools.find(c => c.key === 'operation-outcomes')!;
    const result = verdict(c, await measure(c));
    expect(Number(result.actual)).toBe(10);
    expect(result.matches).toBe(false);
  });
  it('operation-outcomes: an absent required cohort cannot pass', async () => {
    await db.sql`DELETE FROM harness_shared.tool_invocations WHERE tool_name='work_items:claim'`;
    const c = tools.find(c => c.key === 'operation-outcomes')!;
    expect(verdict(c, await measure(c))).toEqual({ matches: false, actual: null });
  });
  it('pg-statement-load: a 200000ms execution delta over 20s breaches the 5-core bar', async () => {
    await db.sql`UPDATE performance_controls.counters SET cores=10`;
    expect(verdict(interval, await measure(interval))).toEqual({ matches: false, actual: 10 });
  });
  it.each(['reset_changed','dealloc_changed','regressed','zero_interval'] as const)(
    'pg-statement-load: %s invalidates the interval rather than passing', async column => {
      await db.sql`UPDATE performance_controls.counters SET ${db.sql(column)}=true`;
      expect(verdict(interval, await measure(interval))).toEqual({ matches: false, actual: null });
    },
  );
});

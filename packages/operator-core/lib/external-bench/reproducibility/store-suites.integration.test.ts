/**
 * store-suites.integration.test.ts — listSuites over benchmark_run_result
 * (migration 291), against a real Postgres. sql is injected via DbScope.sql.
 *
 * Behaviors a fake-sql unit test can't prove — the FILTER aggregate splits the
 * THREE resolved states correctly:
 *  - resolved IS TRUE  → a solved task (counted in `resolved`);
 *  - resolved IS NULL  → an INFRA failure (run never produced a verdict) (`infra`);
 *  - resolved IS FALSE → attempted-but-unsolved — counted in `attempts` but NEITHER
 *    resolved NOR infra (the discriminating case; TEETHED on the infra IS NULL filter);
 *  plus runs = DISTINCT run_id, latestAt = max(created_at), grouped+ordered by suite,
 *  workspace- and runId-scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const { listSuites } = await import('./store');

const WS = 'ws-suites';
let rootSql: postgres.Sql;
const scope = () => ({ sql: rootSql as never, workspaceId: WS });

// Insert a run_result row touching only the columns listSuites reads.
async function ins(over: { suite: string; runId: string; resolved: boolean | null; createdAt?: string; ws?: string }) {
  await rootSql`
    INSERT INTO harness_shared.benchmark_run_result (workspace_id, run_id, suite, resolved, created_at)
    VALUES (${over.ws ?? WS}, ${over.runId}, ${over.suite}, ${over.resolved}, ${over.createdAt ?? '2026-01-01T00:00:00Z'})`;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `suites_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // The columns listSuites reads (faithful subset of mig 291's benchmark_run_result).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.benchmark_run_result (
      workspace_id text NOT NULL, run_id text NOT NULL, suite text NOT NULL,
      resolved boolean, created_at timestamptz NOT NULL DEFAULT now()
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.benchmark_run_result`;
});

describe('listSuites aggregate (PG)', () => {
  it('splits the three resolved states: TRUE→resolved, NULL→infra, FALSE→neither', async () => {
    // suite "swe": 1 run, 4 attempts — 2 solved, 1 failed (FALSE), 1 infra (NULL)
    await ins({ suite: 'swe', runId: 'r1', resolved: true });
    await ins({ suite: 'swe', runId: 'r1', resolved: true });
    await ins({ suite: 'swe', runId: 'r1', resolved: false }); // attempted, unsolved
    await ins({ suite: 'swe', runId: 'r1', resolved: null }); // infra failure
    const [s] = await listSuites(scope());
    expect(s).toMatchObject({ suite: 'swe', runs: 1, attempts: 4, resolved: 2, infra: 1 });
    // the FALSE row is the discriminator: it's in attempts but neither resolved nor infra
    expect(s.attempts - s.resolved - s.infra).toBe(1);
  });

  it('runs = DISTINCT run_id, latestAt = max(created_at), grouped + ordered by suite', async () => {
    await ins({ suite: 'rubric', runId: 'rA', resolved: true, createdAt: '2026-02-01T00:00:00Z' });
    await ins({ suite: 'rubric', runId: 'rB', resolved: true, createdAt: '2026-05-01T00:00:00Z' }); // newest
    await ins({ suite: 'aaa', runId: 'rA', resolved: false, createdAt: '2026-01-01T00:00:00Z' });
    const suites = await listSuites(scope());
    expect(suites.map((x) => x.suite)).toEqual(['aaa', 'rubric']); // ORDER BY suite
    const rubric = suites.find((x) => x.suite === 'rubric')!;
    expect(rubric.runs).toBe(2); // DISTINCT run_id
    expect(rubric.latestAt).toBe('2026-05-01T00:00:00.000Z'); // max(created_at)
  });

  it('is workspace-scoped and runId-filterable', async () => {
    await ins({ suite: 'swe', runId: 'r1', resolved: true });
    await ins({ suite: 'swe', runId: 'r2', resolved: true });
    await ins({ suite: 'swe', runId: 'r1', resolved: true, ws: 'other-ws' }); // invisible
    expect((await listSuites(scope()))[0]!.runs).toBe(2); // other-ws excluded
    expect((await listSuites({ ...scope(), runId: 'r1' }))[0]!.attempts).toBe(1); // runId filter
  });
});

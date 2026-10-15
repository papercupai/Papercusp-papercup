/**
 * Migration 1398 (plan unified-bug-pipeline-and-honest-queue-2026-10-05 P-008 / D-038, SPEC-P-008):
 * retiring the probation and freshness readiness reasons must leave no non-terminal row carrying
 * either one, must keep every rewritten row's prior readiness in
 * payload.implementationReadinessHistory, and must not touch terminal rows or other reasons.
 *
 * Applies the REAL migration file to a throwaway database. The fixture table models only the
 * columns the migration reads or writes (feature_id, status, payload, updated_ts).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

import { HOLD_REGISTRY } from '../../hold-registry';

// MIGRATION_1398_PATH lets scripts/mutation-probe.sh point this guard at a mutated COPY outside
// the tree (copy-out mode), so proving the guard falsifiable never dirties the shared checkout.
const MIGRATION = readFileSync(
  process.env.MIGRATION_1398_PATH ??
    join(__dirname, '../../../../../libs/papercusp/libs/db/sql/1398-retire-probation-freshness-readiness-reasons.sql'),
  'utf8',
);

const PROBATION = 'corroborated-tool-failure-awaiting-review';
const FRESHNESS = 'deployment-freshness-unknown';
const STAGE_REASON = 'awaiting-agent-review';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `rr1398_${randomBytes(5).toString('hex')}`;
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
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY,
      status     text NOT NULL,
      payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_ts bigint NOT NULL DEFAULT 0
    )`);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql.unsafe('TRUNCATE harness_shared.work_items');
});

function readiness(reason: string, status = 'unknown', extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'implementation-readiness-v1',
    status,
    source: 'capture-policy',
    reason,
    updatedAt: '2026-10-01T00:00:00.000Z',
    evidence: { deployment: { state: 'unknown' } },
    ...extra,
  };
}

async function seed(id: string, status: string, payload: Record<string, unknown>, updatedTs = 1000) {
  await sql`
    INSERT INTO harness_shared.work_items (feature_id, status, payload, updated_ts)
    VALUES (${id}, ${status}, ${sql.json(payload as postgres.JSONValue)}, ${updatedTs})`;
}

async function payloadOf(id: string): Promise<Record<string, any>> {
  const [row] = await sql<{ payload: Record<string, any> }[]>`
    SELECT payload FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return row.payload;
}

async function updatedTsOf(id: string): Promise<number> {
  const [row] = await sql<{ updated_ts: string }[]>`
    SELECT updated_ts FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return Number(row.updated_ts);
}

describe('migration 1398: retire the probation and freshness readiness reasons', () => {
  it('rewrites an open probation row to the stage reason and appends the prior readiness to history', async () => {
    const prior = readiness(PROBATION);
    await seed('EI-PROBATION', 'open', { implementationReadiness: prior, other: 'kept' });

    const result = await sql.unsafe(MIGRATION);
    expect(result.count).toBe(1);

    const after = await payloadOf('EI-PROBATION');
    expect(after.implementationReadiness.reason).toBe(STAGE_REASON);
    expect(after.implementationReadiness.status).toBe('unknown');
    expect(after.implementationReadiness.source).toBe('capture-policy');
    expect(after.implementationReadiness.evidence).toEqual(prior.evidence);
    expect(after.implementationReadiness.updatedAt).not.toBe(prior.updatedAt);
    expect(after.other).toBe('kept');

    expect(after.implementationReadinessHistory).toHaveLength(1);
    const [archived] = after.implementationReadinessHistory;
    expect(archived).toMatchObject(prior);
    expect(archived.retiredBy).toBe('1398-retire-probation-freshness-readiness-reasons');
    expect(Date.parse(archived.retiredAt)).not.toBeNaN();
    expect(await updatedTsOf('EI-PROBATION')).toBeGreaterThan(1000);
  });

  it('keeps an existing readiness history and appends to it (freshness row)', async () => {
    const earlier = { status: 'not-ready', reason: 'agent-review-revision-requested' };
    await seed('EI-FRESHNESS', 'blocked', {
      implementationReadiness: readiness(FRESHNESS),
      implementationReadinessHistory: [earlier],
    });

    await sql.unsafe(MIGRATION);

    const after = await payloadOf('EI-FRESHNESS');
    expect(after.implementationReadiness.reason).toBe(STAGE_REASON);
    expect(after.implementationReadinessHistory).toHaveLength(2);
    expect(after.implementationReadinessHistory[0]).toEqual(earlier);
    expect(after.implementationReadinessHistory[1].reason).toBe(FRESHNESS);
  });

  it('leaves terminal rows, other reasons and non-unknown verdicts untouched', async () => {
    const untouched: Array<[string, string, Record<string, unknown>]> = [
      ['EI-DONE', 'done', { implementationReadiness: readiness(PROBATION) }],
      ['EI-RESOLVED', 'resolved', { implementationReadiness: readiness(FRESHNESS) }],
      ['EI-PASSED', 'passed', { implementationReadiness: readiness(PROBATION) }],
      ['EI-OTHER-REASON', 'open', { implementationReadiness: readiness(STAGE_REASON) }],
      ['EI-READY', 'open', { implementationReadiness: readiness(PROBATION, 'ready') }],
      ['EI-NO-READINESS', 'open', { title: 'no readiness at all' }],
    ];
    for (const [id, status, payload] of untouched) await seed(id, status, payload);

    const result = await sql.unsafe(MIGRATION);
    expect(result.count).toBe(0);

    for (const [id, , payload] of untouched) {
      expect(await payloadOf(id), id).toEqual(payload);
      expect(await updatedTsOf(id), id).toBe(1000);
    }
  });

  it('is idempotent: a second run matches no rows and does not grow the history', async () => {
    await seed('EI-TWICE', 'open', { implementationReadiness: readiness(PROBATION) });

    expect((await sql.unsafe(MIGRATION)).count).toBe(1);
    expect((await sql.unsafe(MIGRATION)).count).toBe(0);
    expect((await payloadOf('EI-TWICE')).implementationReadinessHistory).toHaveLength(1);
  });

  it('covers every readiness reason the hold registry retires under D-038', async () => {
    const retired = HOLD_REGISTRY.filter(
      (e) => e.domain === 'readiness' && e.retired?.by.includes('D-038'),
    ).map((e) => e.key);
    expect(retired.length).toBeGreaterThan(0);
    for (const [i, reason] of retired.entries()) {
      await seed(`EI-RETIRED-${i}`, 'open', { implementationReadiness: readiness(reason) });
    }

    await sql.unsafe(MIGRATION);

    const left = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.work_items
       WHERE payload -> 'implementationReadiness' ->> 'reason' = ANY(${retired})`;
    expect(Number(left[0].n)).toBe(0);
  });
});

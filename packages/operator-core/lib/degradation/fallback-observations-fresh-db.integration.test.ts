/**
 * WI-6554700010013241 — createFreshPgDb must provision a fallback_observations sink the
 * flush writer accepts.
 *
 * Any production path under test may call observeFallback(). Its debounced flush (2s,
 * unref'd timer) writes through whatever handle the test mocked getOrgPg to. When the
 * fixture DB had no such table, that flush console.warned "relation
 * harness_shared.fallback_observations does not exist", and vitest-fail-on-console failed
 * whichever unrelated case was running when the timer fired: a timing-dependent red that
 * recurred file by file (WI-10005130, WI-6554700010008895, WI-6554700010013241).
 *
 * This pins the fixture to the writer. If writeBatch starts inserting a column that
 * FALLBACK_OBSERVATIONS_MIN_DDL lacks, or createFreshPgDb stops provisioning the sink,
 * the flush below reports failed:1 and this file goes red here, not in a random case.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  _resetFallbackObservationsForTests,
  flushFallbackObservations,
  observeFallback,
} from './fallback-observations';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('fallback-fresh-db');
}, 90_000);

afterAll(async () => {
  _resetFallbackObservationsForTests();
  await db?.cleanup?.();
});

beforeEach(() => {
  _resetFallbackObservationsForTests();
});

describe('createFreshPgDb provisions the fallback-observations sink (WI-6554700010013241)', () => {
  it('accepts a correlated observation flushed through the fixture handle', async () => {
    const correlationId = randomUUID();
    const accepted = observeFallback(
      'fresh-db.sink-probe',
      { eligible: 2, applied: 1, reason: 'probe', scope: 'fixture' },
      { sql: db.sql, workspaceId: 'ws-fresh-db', correlationId },
    );
    expect(accepted).toBe(true);

    const result = await flushFallbackObservations({ sql: db.sql });
    expect(result).toMatchObject({ written: 1, failed: 0 });

    const rows = await db.sql`
      SELECT mechanism, eligible, applied, reason, scope,
             correlation_id::text AS correlation_id, samples
        FROM harness_shared.fallback_observations
       WHERE workspace_id = 'ws-fresh-db'`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      {
        mechanism: 'fresh-db.sink-probe',
        eligible: 2,
        applied: 1,
        reason: 'probe',
        scope: 'fixture',
        correlation_id: correlationId,
        samples: 1,
      },
    ]);
  });
});

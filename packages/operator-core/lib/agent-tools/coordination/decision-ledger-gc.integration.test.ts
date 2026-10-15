/**
 * decision-ledger-gc.integration.test.ts — gcOldDecisionLedgerRows (WI-417) against a
 * real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - it deletes ONLY rows older than retentionDays (a recent row survives);
 *  - retentionDays controls the age cutoff;
 *  - batchLimit bounds a single run;
 *  - it returns the deleted count;
 *  - the graduation-lookback floor guard refuses a too-short retentionDays instead of
 *    silently under-retaining.
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

const {
  gcOldDecisionLedgerRows,
  DECISION_LEDGER_GC_RETENTION_DAYS,
  DECISION_LEDGER_GRADUATION_LOOKBACK_FLOOR_DAYS,
} = await import('./decision-ledger-gc');

let rootSql: postgres.Sql;
const remainingActions = async () =>
  (await rootSql<{ action: string }[]>`SELECT action FROM harness_shared.decision_ledger ORDER BY action`).map(
    (r) => r.action,
  );

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dlgc_${randomBytes(5).toString('hex')}`;
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
  // Minimal column subset — only what the GC touches (id, ts) + `action` for readable
  // test assertions. The real DDL has many more NOT-NULL columns (260-decision-ledger.sql);
  // this throwaway schema only needs to prove the GC predicate + count, not the full shape.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.decision_ledger (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      action text NOT NULL,
      ts timestamptz DEFAULT now() NOT NULL
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.decision_ledger RESTART IDENTITY`;
});

async function ins(action: string, ageDays: number) {
  await rootSql`INSERT INTO harness_shared.decision_ledger (action, ts)
                VALUES (${action}, now() - make_interval(days => ${ageDays}))`;
}

describe('gcOldDecisionLedgerRows (PG)', () => {
  it('deletes ONLY rows older than retentionDays; a recent row survives', async () => {
    await ins('old-1', 200);
    await ins('old-2', 200);
    await ins('recent', 10);
    const n = await gcOldDecisionLedgerRows(150, 20000);
    expect(n).toBe(2);
    expect(await remainingActions()).toEqual(['recent']);
  });

  it('retentionDays controls the age cutoff', async () => {
    await ins('age100', 100);
    expect(await gcOldDecisionLedgerRows(150, 20000)).toBe(0); // 100d < 150d retention → kept
    expect(await gcOldDecisionLedgerRows(90, 20000)).toBe(1); // 100d > 90d retention → deleted
  });

  it('batchLimit bounds a single run — a second run drains the rest', async () => {
    for (let i = 0; i < 5; i++) await ins(`old-${i}`, 200);
    const first = await gcOldDecisionLedgerRows(150, 3);
    expect(first).toBe(3);
    expect((await remainingActions()).length).toBe(2);
    const second = await gcOldDecisionLedgerRows(150, 3);
    expect(second).toBe(2);
    expect(await remainingActions()).toEqual([]);
  });

  it('refuses a retentionDays below the queen-autonomy graduation lookback floor', async () => {
    await ins('old', 200);
    await expect(gcOldDecisionLedgerRows(DECISION_LEDGER_GRADUATION_LOOKBACK_FLOOR_DAYS - 1)).rejects.toThrow(
      /below the 90d queen-autonomy graduation lookback floor/,
    );
    // the row was never touched by the refused call
    expect(await remainingActions()).toEqual(['old']);
  });

  it('the default retention is comfortably above the graduation floor', () => {
    expect(DECISION_LEDGER_GC_RETENTION_DAYS).toBeGreaterThanOrEqual(DECISION_LEDGER_GRADUATION_LOOKBACK_FLOOR_DAYS);
  });
});

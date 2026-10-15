/**
 * curation-state.integration.test.ts — the per-workspace curation cadence store
 * (curator-operator-2026-06-04 P0), against a real Postgres (testcontainer).
 *
 * The behavior that a fake-sql unit test can't prove is the UPSERT: writeCuration-
 * State's `ON CONFLICT (workspace_id) DO UPDATE … COALESCE(<patch>, <existing>)`
 * means a PARTIAL patch updates only the provided fields and PRESERVES the rest.
 * Get that wrong (drop the COALESCE) and every write silently resets the loop's
 * interval/backoff. Mirrors autoloop-state.integration.test.ts's harness.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-curtest';
const BASE = 900; // stand-in for BASE_INTERVAL_SECONDS (curation-loop mocked to avoid its heavy deps)

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql),
    getOrgPg: () => ({ sql: h.sql }),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('./curation-loop', () => ({ BASE_INTERVAL_SECONDS: BASE }));

const { readCurationState, writeCurationState } = await import('./curation-state');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `cur_${randomBytes(5).toString('hex')}`;
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
  // The operator_curation_state shape (migration 151) — PK on workspace_id (the upsert conflict target).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_curation_state (
      workspace_id text PRIMARY KEY,
      last_run_at timestamptz,
      last_digest_at timestamptz,
      current_interval_seconds integer,
      consecutive_quiet integer,
      last_surfaced_count integer,
      updated_at timestamptz DEFAULT now() NOT NULL
    )
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('curation-state store (PG)', () => {
  it('readCurationState returns DEFAULT_STATE when the workspace has no row', async () => {
    expect(await readCurationState()).toEqual({
      lastRunAtMs: null,
      lastDigestAtMs: null,
      currentIntervalSeconds: BASE,
      consecutiveQuiet: 0,
      lastSurfacedCount: 0,
    });
  });

  it('writeCurationState upserts a full state that reads back (timestamps round-trip to epoch ms)', async () => {
    const lastRun = 1_716_000_000_000;
    const lastDigest = 1_716_000_500_000;
    await writeCurationState({
      lastRunAtMs: lastRun,
      lastDigestAtMs: lastDigest,
      currentIntervalSeconds: 600,
      consecutiveQuiet: 3,
      lastSurfacedCount: 5,
    });
    expect(await readCurationState()).toEqual({
      lastRunAtMs: lastRun,
      lastDigestAtMs: lastDigest,
      currentIntervalSeconds: 600,
      consecutiveQuiet: 3,
      lastSurfacedCount: 5,
    });
  });

  it('a PARTIAL patch updates only the provided field — COALESCE preserves the rest (the upsert invariant)', async () => {
    await writeCurationState({ consecutiveQuiet: 9 }); // bump ONLY this
    const s = await readCurationState();
    expect(s.consecutiveQuiet).toBe(9); // updated
    expect(s.currentIntervalSeconds).toBe(600); // preserved — NOT reset to BASE
    expect(s.lastSurfacedCount).toBe(5); // preserved
    expect(s.lastRunAtMs).toBe(1_716_000_000_000); // preserved
  });
});

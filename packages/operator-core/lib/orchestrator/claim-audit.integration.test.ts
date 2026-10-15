/**
 * claim-audit.integration.test.ts — the local PG claim-attempt audit log
 * (claim_audit), against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - recordClaimAttempt's `to_timestamp(attempt_ts / 1000.0)` epoch-MS conversion
 *    (vs now() when omitted);
 *  - recentClaimAttempts: workspace+harness (+optional feature) scoping, newest-
 *    first ordering, clamped LIMIT;
 *  - the JS field validation (throws ClaimAuditValidationError before touching PG).
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

const { recordClaimAttempt, recentClaimAttempts, ClaimAuditValidationError } = await import('./claim-audit');

const base = { workspaceId: 'ws-1', harnessSlug: 'web', feature_id: 'F-1', claimer_pubkey: 'pk-aaa', outcome: 'won' as const };
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ca_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to baseline: id has a sequence (bigserial), attempt_ts timestamptz, outcome CHECK.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.claim_audit (
      workspace_id text DEFAULT '' NOT NULL,
      id bigserial,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      claimer_pubkey text NOT NULL,
      attempt_ts timestamptz DEFAULT now() NOT NULL,
      outcome text NOT NULL,
      detail text,
      CONSTRAINT claim_audit_outcome_check CHECK (outcome IN ('won','lost','timeout','error'))
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.claim_audit`;
});

describe('recordClaimAttempt (PG)', () => {
  it('records an attempt with the epoch-ms attempt_ts and round-trips it', async () => {
    await recordClaimAttempt({ ...base, attempt_ts: 1_716_000_000_000, detail: 'lease race' });
    const [row] = await recentClaimAttempts({ workspaceId: 'ws-1', harnessSlug: 'web' });
    expect(row).toMatchObject({ feature_id: 'F-1', claimer_pubkey: 'pk-aaa', outcome: 'won', detail: 'lease race' });
    expect((row!.attempt_ts as Date).getTime()).toBe(1_716_000_000_000); // to_timestamp(ms/1000) round-trips
  });

  it('defaults attempt_ts to now() when omitted', async () => {
    const before = Date.now();
    await recordClaimAttempt({ ...base });
    const [row] = await recentClaimAttempts({ workspaceId: 'ws-1', harnessSlug: 'web' });
    expect((row!.attempt_ts as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('validates fields BEFORE touching PG (throws ClaimAuditValidationError)', async () => {
    await expect(recordClaimAttempt({ ...base, workspaceId: '' })).rejects.toBeInstanceOf(ClaimAuditValidationError);
    await expect(recordClaimAttempt({ ...base, feature_id: '' })).rejects.toBeInstanceOf(ClaimAuditValidationError);
    await expect(recordClaimAttempt({ ...base, outcome: 'bogus' as never })).rejects.toBeInstanceOf(ClaimAuditValidationError);
    expect(await rootSql`SELECT count(*)::int AS c FROM harness_shared.claim_audit`).toMatchObject([{ c: 0 }]); // nothing written
  });
});

describe('recentClaimAttempts (PG)', () => {
  it('is newest-first, scoped to workspace+harness, and filterable by feature', async () => {
    await recordClaimAttempt({ ...base, feature_id: 'F-1', outcome: 'lost', attempt_ts: 1000 });
    await recordClaimAttempt({ ...base, feature_id: 'F-1', outcome: 'won', attempt_ts: 3000 }); // newest
    await recordClaimAttempt({ ...base, feature_id: 'F-2', outcome: 'won', attempt_ts: 2000 });
    await recordClaimAttempt({ ...base, harnessSlug: 'api', feature_id: 'F-1', outcome: 'won', attempt_ts: 9000 }); // other harness

    const all = await recentClaimAttempts({ workspaceId: 'ws-1', harnessSlug: 'web' });
    expect(all.map((r) => r.outcome)).toEqual(['won', 'won', 'lost']); // attempt_ts DESC: 3000, 2000, 1000
    expect(all.every((r) => r.harness_slug === 'web')).toBe(true); // 'api' excluded

    const justF1 = await recentClaimAttempts({ workspaceId: 'ws-1', harnessSlug: 'web', feature_id: 'F-1' });
    expect(justF1.map((r) => r.outcome)).toEqual(['won', 'lost']); // only F-1, newest-first
  });

  it('clamps the limit', async () => {
    for (let i = 0; i < 5; i++) await recordClaimAttempt({ ...base, attempt_ts: 1000 + i });
    expect(await recentClaimAttempts({ workspaceId: 'ws-1', harnessSlug: 'web', limit: 2 })).toHaveLength(2);
  });
});

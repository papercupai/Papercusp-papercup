/**
 * learning-targets.integration.test.ts — registerLearningGymTargets, the
 * self-learning gym-target seeder over gym_autoloop_config (mig 110), against a
 * real Postgres. registerLearningGymTargets takes sql directly (injectable).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - only the 'prompt-override' target (implement-worker) gets an autoloop row;
 *    the queen-persona/code-constructed targets are SKIPPED with a reason;
 *  - a created row is DARK (enabled:false, budget null);
 *  - IDEMPOTENCY (the headline invariant): re-seeding NEVER mutates an existing
 *    row, so an owner's enable+budget (their P-001 arming) SURVIVES re-seeding;
 *  - no implement-runner configured → the target is skipped, no row created.
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

const { registerLearningGymTargets } = await import('./learning-targets');

const WS = 'ws-gym';
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gym_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 110: budget_usd double precision nullable, updated_at bigint, PK.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_autoloop_config (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      budget_usd double precision,
      spent_usd double precision NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'idle',
      last_cycle integer, last_cycle_at bigint,
      updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.gym_autoloop_config`;
});

describe('registerLearningGymTargets (PG)', () => {
  it('creates a DARK autoloop row only for the prompt-override target; skips the others', async () => {
    const res = await registerLearningGymTargets(rootSql, { workspaceId: WS, implementRunnerSlug: 'runner-web' });
    expect(res.created).toEqual(['implement-worker']);
    expect(res.existing).toEqual([]);
    expect(res.skipped.map((s) => s.key).sort()).toEqual(['scout-ideators', 'triage-classifier']); // non-prompt-override
    const row = (await rootSql<{ enabled: boolean; budget_usd: number | null }[]>`
      SELECT enabled, budget_usd FROM harness_shared.gym_autoloop_config WHERE harness_slug='runner-web'`)[0]!;
    expect(row.enabled).toBe(false); // DARK
    expect(row.budget_usd).toBeNull(); // unbudgeted
  });

  it("IDEMPOTENT: re-seeding does NOT mutate an existing row — the owner's arming survives", async () => {
    await registerLearningGymTargets(rootSql, { workspaceId: WS, implementRunnerSlug: 'runner-web' });
    // owner arms the lane at P-001: enable + set the governor budget.
    await rootSql`UPDATE harness_shared.gym_autoloop_config SET enabled=true, budget_usd=50 WHERE harness_slug='runner-web'`;
    const res = await registerLearningGymTargets(rootSql, { workspaceId: WS, implementRunnerSlug: 'runner-web' }); // re-seed
    expect(res.created).toEqual([]);
    expect(res.existing).toEqual(['implement-worker']);
    const row = (await rootSql<{ enabled: boolean; budget_usd: number }[]>`
      SELECT enabled, budget_usd FROM harness_shared.gym_autoloop_config WHERE harness_slug='runner-web'`)[0]!;
    expect(row.enabled).toBe(true); // NOT reset to dark
    expect(Number(row.budget_usd)).toBe(50); // budget preserved
  });

  it('no implement-runner configured → the target is skipped, no row created', async () => {
    const res = await registerLearningGymTargets(rootSql, { workspaceId: WS, implementRunnerSlug: null });
    expect(res.created).toEqual([]);
    expect(res.skipped.some((s) => s.key === 'implement-worker')).toBe(true);
    expect(await rootSql`SELECT 1 FROM harness_shared.gym_autoloop_config`).toHaveLength(0);
  });
});

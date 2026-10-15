/**
 * gen-loop.integration.test.ts — the LIVE (default) `generationExists` query in
 * `runIqBatteryGen` against real Postgres (EI-13049 recurrence guard).
 *
 * cadence-tick.test.ts / gen-loop.test.ts only exercise the INJECTED
 * `generationExists` fake — they never touch the real SQL. This file proves the
 * production query itself: a `cup_keeper_instances` row with ZERO linked
 * `cup_keeper_runs` (a runner that died before its first `startRun` — crash, OOM,
 * a killed process) must NOT satisfy the dedupe gate, or a generation that failed
 * before recording a single run is PERMANENTLY unretryable at that code SHA (the
 * exact bug: bp-singleton-iq-battery-0's 2026-07-01 fire).
 *
 * Table shapes mirror migration 180 (faithfully copied from
 * beekeeper-store-pg.integration.test.ts's fixture).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

// Imported AFTER the mock so the module binds the mocked getOrgPg.
const { runIqBatteryGen } = await import('./gen-loop');

const WS = 'ws-gl';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gl_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  h.sql = sql;
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_instances (
      instance_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      code_sha TEXT NOT NULL,
      genome_id TEXT,
      memory_snapshot_id TEXT,
      battery_slice_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, code_sha, genome_id)
    )`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.cup_keeper_runs (
      run_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES harness_shared.cup_keeper_instances(instance_id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      case_variant TEXT NOT NULL,
      case_title TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      elapsed_ms BIGINT,
      terminal_state TEXT,
      deterministic_signals JSONB,
      trace_ref TEXT,
      UNIQUE (instance_id, case_id)
    )`);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const deps = (over: Record<string, unknown> = {}) => ({
  currentCodeSha: () => 'sha-empty',
  runBattery: vi.fn(async () => {}),
  log: vi.fn(),
  notifyOutcome: vi.fn(async () => {}),
  ...over,
});

describe('runIqBatteryGen — live generationExists (EI-13049)', () => {
  it('an instance row with ZERO linked runs does NOT satisfy the dedupe gate — retry proceeds (ran)', async () => {
    await sql`
      INSERT INTO harness_shared.cup_keeper_instances (instance_id, workspace_id, code_sha, genome_id)
      VALUES ('gen0-sha-empty-ws-gl', ${WS}, 'sha-empty', NULL)`;

    const out = await runIqBatteryGen(
      { workspaceId: WS, installSlug: 'inst-1', payload: { budgetUsd: 10 } },
      deps({ currentCodeSha: () => 'sha-empty' }),
    );
    expect(out).toMatchObject({ action: 'ran', codeSha: 'sha-empty' });
  });

  it('an instance row WITH ≥1 linked run DOES satisfy the dedupe gate — skipped', async () => {
    await sql`
      INSERT INTO harness_shared.cup_keeper_instances (instance_id, workspace_id, code_sha, genome_id)
      VALUES ('gen0-sha-run-ws-gl', ${WS}, 'sha-run', NULL)`;
    await sql`
      INSERT INTO harness_shared.cup_keeper_runs (run_id, instance_id, case_id, case_variant)
      VALUES ('run-1', 'gen0-sha-run-ws-gl', 'case-1', 'v1')`;

    const out = await runIqBatteryGen(
      { workspaceId: WS, installSlug: 'inst-1', payload: { budgetUsd: 10 } },
      deps({ currentCodeSha: () => 'sha-run' }),
    );
    expect(out).toMatchObject({ action: 'skipped', codeSha: 'sha-run' });
  });

  it('no instance row at all — dedupe gate open, ran', async () => {
    const out = await runIqBatteryGen(
      { workspaceId: WS, installSlug: 'inst-1', payload: { budgetUsd: 10 } },
      deps({ currentCodeSha: () => 'sha-never-seen' }),
    );
    expect(out).toMatchObject({ action: 'ran', codeSha: 'sha-never-seen' });
  });
});

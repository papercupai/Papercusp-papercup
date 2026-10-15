/**
 * control-state.integration.test.ts — the persisted Start/Pause-Overwatch state +
 * wake cadence over the operator_settings KV, against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the KV upsert (ON CONFLICT (key)) for started/cadence — one row per key,
 *    re-writes overwrite;
 *  - getOverwatchStarted defaults false (born paused); cadence defaults to 600
 *    when unset, and stored values are clamped on the way in AND read back;
 *  - listStartedOverwatches returns ONLY value='true' keys and parses
 *    workspace:install off the FIRST colon.
 * clampOverwatchCadenceSec is pure and tested directly.
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

const cs = await import('./control-state');
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ow_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to baseline: key PK, value NOT NULL, updated_at bigint (Date.now() epoch-ms),
  // workspace_id NOT NULL (mig 453 — every write stamps activeWorkspaceId()).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_settings (
      key text NOT NULL,
      value text NOT NULL,
      description text,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text NOT NULL,
      CONSTRAINT operator_settings_pkey PRIMARY KEY (key)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.operator_settings`;
});

describe('clampOverwatchCadenceSec (pure)', () => {
  it('clamps to [60, 3600], rounds, and defaults non-finite to 600', () => {
    expect(cs.clampOverwatchCadenceSec(30)).toBe(60); // floor (anti-spin)
    expect(cs.clampOverwatchCadenceSec(5000)).toBe(3600); // ceiling
    expect(cs.clampOverwatchCadenceSec(600)).toBe(600);
    expect(cs.clampOverwatchCadenceSec(123.7)).toBe(124); // rounded
    expect(cs.clampOverwatchCadenceSec(NaN)).toBe(cs.DEFAULT_OVERWATCH_CADENCE_SEC);
    expect(cs.clampOverwatchCadenceSec(Infinity)).toBe(cs.DEFAULT_OVERWATCH_CADENCE_SEC);
  });
});

describe('started state (PG KV)', () => {
  it('defaults false (born paused) and round-trips via the ON CONFLICT upsert', async () => {
    expect(await cs.getOverwatchStarted('ws1', 'web')).toBe(false); // unset → false
    await cs.setOverwatchStarted('ws1', 'web', true);
    expect(await cs.getOverwatchStarted('ws1', 'web')).toBe(true);
    await cs.setOverwatchStarted('ws1', 'web', false); // re-write same key
    expect(await cs.getOverwatchStarted('ws1', 'web')).toBe(false);
    expect(await rootSql`SELECT 1 FROM harness_shared.operator_settings WHERE key='overwatch_started:ws1:web'`).toHaveLength(1); // one row, upserted
  });
});

describe('cadence (PG KV)', () => {
  it('defaults to 600 unset; stores + reads the CLAMPED value', async () => {
    expect(await cs.getOverwatchCadenceSec('ws1', 'web')).toBe(600); // unset → default
    expect(await cs.setOverwatchCadenceSec('ws1', 'web', 30)).toBe(60); // clamped on write, returned
    expect(await cs.getOverwatchCadenceSec('ws1', 'web')).toBe(60); // and read back clamped
    expect(await cs.setOverwatchCadenceSec('ws1', 'web', 99999)).toBe(3600);
    expect(await cs.getOverwatchCadenceSec('ws1', 'web')).toBe(3600);
  });
});

describe('listStartedOverwatches (PG)', () => {
  it('returns ONLY started (value=true) keys, parsing workspace:install off the first colon', async () => {
    await cs.setOverwatchStarted('ws1', 'web', true);
    await cs.setOverwatchStarted('ws1', 'api', false); // paused
    await cs.setOverwatchStarted('ws2', 'web-thing', true);
    const list = await cs.listStartedOverwatches();
    const sorted = list.map((x) => `${x.workspaceId}/${x.installSlug}`).sort();
    // K1 workspace-scoped-coordination (P-004/D-006, flag ON by default): a start
    // writes BOTH the workspace-sentinel row (the install dimension collapses to
    // the workspace id → 'ws2/ws2') and the legacy per-install row; pausing ANY
    // install converges every started row in that workspace to false — so ws1
    // (web started, then api paused) vanishes entirely.
    expect(sorted).toEqual(['ws2/web-thing', 'ws2/ws2']);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { StartupActivityFeature } from './schedule-inventory';

const state = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, workspace: 'policy-a' }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: state.sql }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => state.workspace }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn().mockResolvedValue(undefined) }));
import { setPaused, setResumed, setBackgroundActivityAutomatic, isPaused } from './device-operator-actions';
import { savedStartupActivityPolicy } from './startup-activity';

let admin: postgres.Sql;
let database: string;
const featureId = `activity-${'a'.repeat(64)}`;
const initial = () => ({ paused: false, futureRoot: { keep: true }, backgroundActivity: {
  version: 1, revision: 10, automatic: true, pausedUntil: null, futurePolicy: 'keep', features: {
    [featureId]: { automatic: false, paused: false, pausedUntil: null, revision: 7, futureFeature: 'keep' },
  },
} });
const feature: StartupActivityFeature = {
  id: featureId, name: 'Optional work', purpose: 'Test optional work', trigger: 'timer', origin: 'routines',
  entrypointIds: ['routine-dispatch'], scope: { kind: 'workspace', id: 'policy-a' }, dependencies: [],
  desired: { automatic: true, pausedUntil: null, revision: null }, observed: 'idle', network: 'local', spend: 'none',
  resources: { cpuUsec: null, rssBytes: null, costCents: null },
};
const readRow = async () => (await state.sql<{ payload: ReturnType<typeof initial> }[]>`
  SELECT payload FROM harness_shared.operator_paused WHERE workspace_id = ${state.workspace}`)[0]!.payload;
const seed = async () => { await state.sql`
  INSERT INTO harness_shared.operator_paused (workspace_id, payload, updated_at)
  VALUES (${state.workspace}, ${JSON.stringify(initial())}::text::jsonb, 0)`; };

beforeAll(async () => {
  const url = await getTestPg();
  database = `background_policy_${randomBytes(5).toString('hex')}`;
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await markManagedTestDatabase(admin, database);
  const target = new URL(url); target.pathname = `/${database}`;
  state.sql = postgres(target.toString(), { max: 4, onnotice: () => {} });
  await state.sql`CREATE SCHEMA harness_shared`;
  await state.sql`CREATE TABLE harness_shared.operator_paused (
    workspace_id text PRIMARY KEY, payload jsonb NOT NULL, updated_at bigint NOT NULL)`;
});
afterAll(async () => {
  await state.sql?.end({ timeout: 5 });
  if (database) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});
beforeEach(async () => { state.workspace = 'policy-a'; await state.sql`TRUNCATE harness_shared.operator_paused`; });

describe('durable background activity policy lifecycle', () => {
  it('serializes simultaneous first pause and disable writes under the existing row lock', async () => {
    await Promise.all([setPaused('settings'), setBackgroundActivityAutomatic(false)]);
    const row = await readRow();
    expect(row).toMatchObject({ paused: true, backgroundActivity: { version: 1, revision: 2, automatic: false } });
  });

  it('preserves feature disables and unknown newer fields through concurrent writes and resume', async () => {
    await seed();
    await Promise.all([setPaused('settings'), setBackgroundActivityAutomatic(false)]);
    await setResumed(12);
    const row = await readRow();
    expect(row).toMatchObject({ ...initial(), backgroundActivity: { ...initial().backgroundActivity, revision: 13, automatic: false } });
    expect(savedStartupActivityPolicy(feature, row, state.workspace)).toMatchObject({ automatic: false, paused: false, revision: 13 });
  });

  it('rejects stale resume after a committed disable and leaves the exact row unchanged', async () => {
    await seed();
    await setPaused('settings', null, 10);
    await setBackgroundActivityAutomatic(false, 11);
    const before = await readRow();
    await expect(setResumed(11)).rejects.toThrow('Startup policy changed');
    expect(await readRow()).toEqual(before);
  });

  it('evaluates offline expiry from persisted state without enabling explicitly disabled activity', async () => {
    await seed();
    const deadline = Date.now() + 60_000;
    await setPaused('settings', new Date(deadline).toISOString(), 10);
    const row = await readRow();
    expect(savedStartupActivityPolicy(feature, row, state.workspace, deadline - 1)).toMatchObject({ automatic: false, paused: true });
    expect(savedStartupActivityPolicy(feature, row, state.workspace, deadline)).toMatchObject({ automatic: false, paused: false });
    expect(await readRow()).toEqual(row);
  });

  it('keeps writes in the trusted workspace and refuses an unknown policy format', async () => {
    await seed();
    state.workspace = 'policy-b';
    await setPaused('settings');
    state.workspace = 'policy-a';
    expect(await readRow()).toEqual(initial());
    await state.sql`UPDATE harness_shared.operator_paused
      SET payload = jsonb_set(payload, '{backgroundActivity,version}', '2') WHERE workspace_id = ${state.workspace}`;
    const before = await readRow();
    await expect(setResumed()).rejects.toThrow();
    expect(await readRow()).toEqual(before);
    // A newer format cannot be interpreted as permission to execute.
    await expect(isPaused()).rejects.toThrow();
  });
});

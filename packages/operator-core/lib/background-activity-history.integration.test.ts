import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { StartupActivityHistoryEntry } from './schedule-inventory';

const state = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, workspace: 'startup-a' }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: state.sql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => state.workspace }));
import { readStartupActivityHistory, recordStartupActivityHistory } from './startup-activity';

let admin: postgres.Sql;
let database: string;
const featureId = `activity-${'a'.repeat(64)}`;
const event = (over: Partial<StartupActivityHistoryEntry> = {}): StartupActivityHistoryEntry => ({
  featureId, operation: 'policy-change', status: 'completed', at: new Date().toISOString(),
  actor: 'ignored-at-write', trigger: 'settings', source: 'settings', reason: 'user-choice',
  previous: { automatic: true, pausedUntil: null, revision: 1 },
  resulting: { automatic: false, pausedUntil: null, revision: 2 }, ...over,
});

beforeAll(async () => {
  const url = await getTestPg();
  database = `startup_history_${randomBytes(5).toString('hex')}`;
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await markManagedTestDatabase(admin, database);
  const target = new URL(url); target.pathname = `/${database}`;
  state.sql = postgres(target.toString(), { max: 2, onnotice: () => {} });
  await state.sql`CREATE SCHEMA harness_shared`;
  // Exact existing audit_log columns used by the production reader and writer.
  await state.sql`CREATE TABLE harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, action text NOT NULL,
    subject text NOT NULL, details jsonb NOT NULL, workspace_id text NOT NULL)`;
});
afterAll(async () => {
  await state.sql?.end({ timeout: 5 });
  if (database) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});
beforeEach(async () => { state.workspace = 'startup-a'; await state.sql`TRUNCATE harness_shared.audit_log`; });

describe('scoped startup activity audit history', () => {
  it('records actor reason and previous preference', async () => {
    const entry = event();
    await recordStartupActivityHistory({ ...entry, secret: 'credential=private' } as StartupActivityHistoryEntry, 'credential=private');
    const rows = await readStartupActivityHistory([featureId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ previous: entry.previous, resulting: entry.resulting, source: 'settings', reason: 'user-choice' });
    expect(rows[0]!.actor).toMatch(/^user:[a-f0-9]{64}$/);
    const stored = await state.sql`SELECT details, actor FROM harness_shared.audit_log`;
    expect(JSON.stringify(stored)).not.toContain('credential');
    expect(JSON.stringify(stored)).not.toContain('secret');
  });

  it('records actual-start causal codes and pending failed or draining outcomes without assuming cancellation', async () => {
    for (const status of ['pending', 'running', 'draining', 'failed'] as const)
      await recordStartupActivityHistory(event({ operation: 'start', status, trigger: 'timer', source: 'timer', reason: 'automatic-start', previous: null, resulting: null }), 'timer-owner', 'system');
    const rows = await readStartupActivityHistory([featureId]);
    expect(rows.map(row => row.status).sort()).toEqual(['draining', 'failed', 'pending', 'running']);
    expect(rows.every(row => row.trigger === 'timer' && row.reason === 'automatic-start')).toBe(true);
    expect(rows.every(row => row.actor.startsWith('system:'))).toBe(true);
  });

  it('excludes another workspace and foreign feature even when both contain valid records', async () => {
    await recordStartupActivityHistory(event(), 'user-a');
    state.workspace = 'startup-b';
    await recordStartupActivityHistory(event(), 'user-b');
    await recordStartupActivityHistory(event({ featureId: `activity-${'b'.repeat(64)}` }), 'user-b');
    expect(await readStartupActivityHistory([featureId])).toHaveLength(1);
    state.workspace = 'startup-a';
    const result = await readStartupActivityHistory([featureId]);
    expect(result).toHaveLength(1);
    expect(result[0]!.actor).not.toBe((await state.sql`SELECT actor FROM harness_shared.audit_log WHERE workspace_id='startup-b' LIMIT 1`)[0]!.actor);
  });

  it('bounds pages to 100 and excludes records older than 30 days or in the future', async () => {
    const now = Date.now();
    for (let i = 0; i < 103; i++) await recordStartupActivityHistory(event({ at: new Date(now - i).toISOString() }), 'user');
    await recordStartupActivityHistory(event({ at: new Date(now - 31 * 86_400_000).toISOString() }), 'old');
    await recordStartupActivityHistory(event({ at: new Date(now + 86_400_000).toISOString() }), 'future');
    expect(await readStartupActivityHistory([featureId], 1000)).toHaveLength(100);
    expect(await readStartupActivityHistory([featureId], 2)).toHaveLength(2);
    expect(await readStartupActivityHistory([featureId], Number.NaN)).toHaveLength(100);
  });

  it('strips undeclared fields on read, rejects unsafe codes on write and fails closed on malformed stored history', async () => {
    await recordStartupActivityHistory(event(), 'user');
    await state.sql`UPDATE harness_shared.audit_log SET details = jsonb_set(details, '{startupActivity,private}', '"token"')`;
    expect(JSON.stringify(await readStartupActivityHistory([featureId]))).not.toContain('token');
    await expect(recordStartupActivityHistory(event({ reason: 'secret' as never }), 'user')).rejects.toThrow();
    await expect(recordStartupActivityHistory(event({ trigger: 'https://private.example' }), 'user')).rejects.toThrow();
    await expect(recordStartupActivityHistory(event(), '')).rejects.toThrow('actor identity');
    await expect(recordStartupActivityHistory(event({ previous: null }), 'user')).rejects.toThrow('previous and resulting');
    await expect(recordStartupActivityHistory(event({ resulting: { automatic: true, pausedUntil: null, revision: 1 } }), 'user')).rejects.toThrow('previous and resulting');
    await state.sql`UPDATE harness_shared.audit_log SET details = jsonb_set(details, '{startupActivity,actor}', '"credential"')`;
    await expect(readStartupActivityHistory([featureId])).rejects.toThrow('record unavailable');
    state.workspace = '';
    await expect(readStartupActivityHistory([featureId])).rejects.toThrow('workspace identity');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { recordSpawnAccountRoute, recordSpawnFirstGatewayRequest,
  type SpawnAccountRoute, type SpawnFirstGatewayRequest } from './spawn-tree';

let db: MigratedTestDb;
let sql: Sql;
const route: SpawnAccountRoute = {
  ownerId: 's-primary', accountRoute: 'auto', requestedBackend: 'codex',
  requestedModel: 'gpt-5.4', requestedEffort: 'high', launchedBackend: 'codex',
  launchedModel: 'gpt-5.4', launchedEffort: 'high', resolvedAccountIds: ['pool-a'],
};
const request: SpawnFirstGatewayRequest = {
  ownerId: 's-primary', requestId: 'gateway:1', requestOrdinal: 1, provider: 'codex',
  protocol: 'openai-responses', model: 'gpt-5.4', effort: 'high', servingAccountId: 'pool-a',
  outcome: 'upstream-429', finalStatus: 429, startedAt: 100,
};

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'spawnroute', provision: async url => {
    const setup = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await setup.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
      await setup.unsafe('CREATE TABLE harness_shared.spawned_agents (spawn_id text PRIMARY KEY)');
      const migration = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql/1494-spawn-account-route-evidence.sql');
      const draft = migration + '.DRAFT';
      const { existsSync } = await import('node:fs');
      await setup.unsafe(readFileSync(existsSync(migration) ? migration : draft, 'utf8'));
      await setup`INSERT INTO harness_shared.spawned_agents (spawn_id) VALUES ('s-primary'), ('s-neighbor')`;
    } finally { await setup.end({ timeout: 5 }); }
  } });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 60_000);
afterAll(async () => { await sql?.end({ timeout: 5 }); await db?.drop(); });

describe('spawn account route persistence', () => {
  it('primary spawn persists resolved route and stable owner correlation', async () => {
    await recordSpawnAccountRoute(sql, 's-primary', route);
    const [row] = await sql`SELECT account_route FROM harness_shared.spawned_agents WHERE spawn_id = 's-primary'`;
    expect(row!.account_route).toEqual(route);
    await expect(recordSpawnAccountRoute(sql, 's-neighbor', route)).rejects.toThrow(/owner/);
    await expect(recordSpawnAccountRoute(sql, 's-primary', { ...route, requestedModel: '' })).rejects.toThrow(/backend\/model/);
  });
  it('matches exact owner keys, preserves failed first requests and handles reversed completion order', async () => {
    expect(await recordSpawnFirstGatewayRequest(sql, { ...request, ownerId: 's-neighbor' })).toBe(false);
    expect(await recordSpawnFirstGatewayRequest(sql, { ...request, requestId: 'gateway:2', requestOrdinal: 2,
      startedAt: 101, outcome: 'ok', finalStatus: 200 })).toBe(true);
    expect(await recordSpawnFirstGatewayRequest(sql, request)).toBe(true);
    expect(await recordSpawnFirstGatewayRequest(sql, { ...request, requestId: 'gateway:3', requestOrdinal: 3,
      outcome: 'ok', finalStatus: 200 })).toBe(false);
    const rows = await sql`SELECT spawn_id, first_gateway_request FROM harness_shared.spawned_agents ORDER BY spawn_id`;
    expect(rows.find(row => row.spawn_id === 's-primary')!.first_gateway_request).toEqual(request);
    expect(rows.find(row => row.spawn_id === 's-neighbor')!.first_gateway_request).toBeNull();
  });
});

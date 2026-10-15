/**
 * state-store.integration.test.ts
 *
 * Proves the PG-backed provision state store (migration 026;
 * harness_shared.provision_state) against a real Postgres testcontainer:
 * empty-state reads, write/read round-trips, appendWalEntry's
 * (kind, externalId) dedupe + recordedAt preservation, appendStateOutput
 * merging, clearState, and workspace scoping. The old file-era suite
 * (WAL folding, compaction, .tmp+rename) tested concepts the PG impl
 * deliberately dropped — the row IS the authoritative state.
 *
 * Mirrors operator-conversation-compaction.integration.test.ts's setup
 * (getOrgPg → drizzle over a per-test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
  ws: 'ws-provision-state-test',
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => h.ws };
});

const { readState, writeState, appendWalEntry, appendStateOutput, clearState } = await import(
  './state-store'
);

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ps_${randomBytes(5).toString('hex')}`;
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
  // Baseline shape (000-baseline.sql ~:2337) — verbatim.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.provision_state (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      payload jsonb NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      CONSTRAINT provision_state_pkey PRIMARY KEY (workspace_id, harness_slug, plugin_slug)
    );
  `);
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  h.ws = 'ws-provision-state-test';
  await rootSql`DELETE FROM harness_shared.provision_state`;
});

describe('provision state store (PG)', () => {
  it('returns empty state when no row exists', async () => {
    const s = await readState('h', 'p');
    expect(s.createdResources).toEqual([]);
    expect(s.outputs).toEqual({});
    expect(s.hashes).toBeNull();
    expect(s.setupFailed).toBe(false);
    expect(s.lastSetupAt).toBeNull();
  });

  it('writes and reads state round-trip', async () => {
    await writeState('h', 'p', {
      schemaVersion: 1,
      hashes: { configHash: 'c', scriptHash: 's', pluginVersion: '1.0.0' },
      createdResources: [
        { kind: 'aws.iam.role', externalId: 'arn:1', recordedAt: '2026-05-01T00:00:00Z' },
      ],
      outputs: { lambdaArn: 'arn:fn' },
      lastSetupAt: '2026-05-01T00:00:00Z',
      lastVerifyAt: null,
      setupFailed: false,
    });
    const s = await readState('h', 'p');
    expect(s.hashes).toEqual({ configHash: 'c', scriptHash: 's', pluginVersion: '1.0.0' });
    expect(s.outputs.lambdaArn).toBe('arn:fn');
    expect(s.createdResources).toHaveLength(1);
    expect(s.lastSetupAt).toBe('2026-05-01T00:00:00Z');
  });

  it('writeState upserts — second write replaces the row, not duplicates it', async () => {
    const base = await readState('h', 'p');
    await writeState('h', 'p', { ...base, outputs: { v: 1 } });
    await writeState('h', 'p', { ...base, outputs: { v: 2 } });
    const rows = await rootSql`
      SELECT payload FROM harness_shared.provision_state
       WHERE workspace_id = ${h.ws} AND harness_slug = 'h' AND plugin_slug = 'p'
    `;
    expect(rows).toHaveLength(1);
    expect((await readState('h', 'p')).outputs.v).toBe(2);
  });

  it('appendWalEntry records resources into createdResources', async () => {
    await appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: '2026-05-01T00:00:00Z',
    });
    await appendWalEntry('h', 'p', {
      kind: 'aws.lambda.function',
      externalId: 'arn:fn:1',
      recordedAt: '2026-05-01T00:00:01Z',
    });
    const s = await readState('h', 'p');
    expect(s.createdResources.map((r) => r.kind).sort()).toEqual([
      'aws.iam.role',
      'aws.lambda.function',
    ]);
  });

  it('dedupes on (kind, externalId): merges metadata, keeps the original recordedAt', async () => {
    await appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: '2026-05-01T00:00:00Z',
    });
    await appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: '2026-05-01T00:00:05Z',
      metadata: { updated: true },
    });
    const s = await readState('h', 'p');
    expect(s.createdResources).toHaveLength(1);
    expect(s.createdResources[0].metadata?.updated).toBe(true);
    expect(s.createdResources[0].recordedAt).toBe('2026-05-01T00:00:00Z');
  });

  it('appendStateOutput merges keys and overwrites repeats', async () => {
    await appendStateOutput('h', 'p', 'a', 1);
    await appendStateOutput('h', 'p', 'b', 'two');
    await appendStateOutput('h', 'p', 'a', 3);
    const s = await readState('h', 'p');
    expect(s.outputs).toEqual({ a: 3, b: 'two' });
  });

  it('serializes concurrent resource and output mutations without losing updates', async () => {
    await Promise.all([
      appendWalEntry('h', 'p', { kind: 'aws.iam.role', externalId: 'arn:role:concurrent', recordedAt: 'now' }),
      appendWalEntry('h', 'p', { kind: 'aws.lambda.function', externalId: 'arn:fn:concurrent', recordedAt: 'now' }),
    ]);
    await Promise.all([
      appendStateOutput('h', 'p', 'first', 1),
      appendStateOutput('h', 'p', 'second', 2),
    ]);

    const s = await readState('h', 'p');
    expect(s.createdResources.map((r) => r.externalId).sort()).toEqual(['arn:fn:concurrent', 'arn:role:concurrent']);
    expect(s.outputs).toMatchObject({ first: 1, second: 2 });
  });

  it('clearState drops the row', async () => {
    await appendWalEntry('h', 'p', { kind: 'k', externalId: 'i', recordedAt: 'now' });
    await clearState('h', 'p');
    const s = await readState('h', 'p');
    expect(s.createdResources).toEqual([]);
    const rows = await rootSql`SELECT 1 FROM harness_shared.provision_state`;
    expect(rows).toHaveLength(0);
  });

  it('rows are scoped to the active workspace', async () => {
    await appendStateOutput('h', 'p', 'mine', true);
    h.ws = 'ws-someone-else';
    const other = await readState('h', 'p');
    expect(other.outputs).toEqual({});
    h.ws = 'ws-provision-state-test';
    expect((await readState('h', 'p')).outputs.mine).toBe(true);
  });
});

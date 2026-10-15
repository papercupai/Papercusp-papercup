/**
 * device-pair-store.integration.test.ts — the mobile pair-token store
 * (mobile_pair_tokens, migration 031, drizzle), against a real Postgres.
 *
 * The behavior a fake-db unit test can't prove is the ATOMIC single-use consume:
 * `UPDATE … SET consumed=true WHERE pair_token=? AND consumed=false AND
 * expires_at_ms>=now RETURNING` — a replay (second consume) finds no unconsumed
 * row and gets null, so a token can be used exactly once; an expired token is
 * never consumable; and mint allows MULTIPLE concurrent unconsumed tokens (the
 * fix for "pair token rejected" when two surfaces minted at once).
 *
 * Reuses the drizzle harness: `generated` stays real, drizzle(rootSql) injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db }) };
});

const { mintPairToken, consumePairToken, newDeviceId } = await import('./device-pair-store');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dp_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 031: pair_token PK, expires_at_ms/created_at_ms bigint, consumed bool default false.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.mobile_pair_tokens (
      pair_token text NOT NULL,
      workspace_id text NOT NULL,
      user_email text,
      desktop_host text NOT NULL,
      expires_at_ms bigint NOT NULL,
      consumed boolean DEFAULT false NOT NULL,
      created_at_ms bigint DEFAULT 0 NOT NULL,
      CONSTRAINT mobile_pair_tokens_pkey PRIMARY KEY (pair_token)
    )`);
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.mobile_pair_tokens`;
});

describe('device-pair-store (drizzle, PG)', () => {
  it('mint → consume round-trips the pending pair', async () => {
    const { pairToken, expiresAt } = await mintPairToken({ workspaceId: 'ws-1', desktopHost: 'host-a', userEmail: 'u@x.com' });
    expect(pairToken).toBeTruthy();
    expect(expiresAt).toBeGreaterThan(Date.now());
    const pair = await consumePairToken(pairToken);
    expect(pair).toMatchObject({ pairToken, workspaceId: 'ws-1', desktopHost: 'host-a', userEmail: 'u@x.com' });
    expect(pair!.expiresAt).toBe(expiresAt);
  });

  it('is SINGLE-USE — a second consume of the same token returns null (replay defeated)', async () => {
    const { pairToken } = await mintPairToken({ workspaceId: 'ws-1', desktopHost: 'host-a' });
    expect(await consumePairToken(pairToken)).not.toBeNull(); // first wins
    expect(await consumePairToken(pairToken)).toBeNull(); // replay: consumed=true, no row matches
  });

  it('returns null for an unknown token', async () => {
    expect(await consumePairToken('nope-not-a-token')).toBeNull();
  });

  it('never consumes an EXPIRED token (expires_at_ms < now)', async () => {
    await rootSql`INSERT INTO harness_shared.mobile_pair_tokens (pair_token, workspace_id, desktop_host, expires_at_ms, consumed, created_at_ms)
                  VALUES ('expired-tok', 'ws-1', 'host-a', ${Date.now() - 1000}, false, ${Date.now() - 60000})`;
    expect(await consumePairToken('expired-tok')).toBeNull();
    // and it stays UNconsumed (the guard rejected it, didn't flip it)
    const row = (await rootSql<{ consumed: boolean }[]>`SELECT consumed FROM harness_shared.mobile_pair_tokens WHERE pair_token='expired-tok'`)[0]!;
    expect(row.consumed).toBe(false);
  });

  it('mint allows MULTIPLE concurrent unconsumed tokens (no prior-token invalidation)', async () => {
    const a = await mintPairToken({ workspaceId: 'ws-1', desktopHost: 'host-a' });
    const b = await mintPairToken({ workspaceId: 'ws-1', desktopHost: 'host-a' });
    expect(a.pairToken).not.toBe(b.pairToken);
    expect(await rootSql`SELECT 1 FROM harness_shared.mobile_pair_tokens WHERE consumed=false`).toHaveLength(2);
    expect(await consumePairToken(a.pairToken)).not.toBeNull(); // both independently consumable
    expect(await consumePairToken(b.pairToken)).not.toBeNull();
  });

  it('newDeviceId returns a unique uuid each call', () => {
    expect(newDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newDeviceId()).not.toBe(newDeviceId());
  });
});

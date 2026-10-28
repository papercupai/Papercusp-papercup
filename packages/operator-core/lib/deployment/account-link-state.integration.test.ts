/** Real PG transactions: first-write races, recovery CAS, fencing and RLS. No real logins. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFile } from 'node:fs/promises';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: null as Sql | null, workspace: 'link-test' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql! }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.workspace }));
vi.mock('../db-encryption', () => ({ ENCRYPTED_TABLES: new Set(), getDbEncryptionKey: () => 'unused' }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

import {
  createStoredCliLink, readStoredCliLink, finishStoredCliLink, claimStoredCliLink,
  newLinkOwner, linkOwnerLiveness, type StoredCliLink,
} from './account-link-state';

let db: MigratedTestDb;
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'accountlink' });
  h.sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  await h.sql.unsafe(`CREATE SCHEMA harness_shared;
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero') THEN CREATE ROLE harness_zero; END IF;
    END $roles$; GRANT USAGE ON SCHEMA harness_shared TO harness_app;`);
  // Both draft iteration and armed CI execute exactly the migration shipped with the feature.
  const url = new URL('../../../../libs/papercusp/libs/db/sql/1609-operator-account-link-state.sql', import.meta.url);
  const migration = await readFile(url, 'utf8').catch(() => readFile(new URL(`${url.href}.DRAFT`), 'utf8'));
  await h.sql.unsafe(migration);
  await h.sql.unsafe(migration); // boot replay must be idempotent
}, 120_000);
beforeEach(async () => {
  h.workspace = 'link-test';
  await h.sql!`DELETE FROM harness_shared.operator_account_link_state`;
});
afterAll(async () => {
  try { await h.sql?.end({ timeout: 5 }); }
  finally { await db?.drop(); }
});

function row(linkId = 'test-link', overrides: Partial<StoredCliLink> = {}): StoredCliLink {
  return {
    linkId, scope: '/isolated/credentials', accountId: 'test-account', provider: 'codex',
    configDir: '/isolated/credentials/.codex-setup-test-a1', owner: newLinkOwner(),
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, retainUntil: Date.now() + 86_400_000,
    ...overrides,
  };
}

describe('durable account-link custody', () => {
  it('preserves simultaneous first writers through the maintained operator-state transaction', async () => {
    await Promise.all([createStoredCliLink(row('first')), createStoredCliLink(row('second'))]);
    expect(await readStoredCliLink('first', '/isolated/credentials')).toMatchObject({ linkId: 'first' });
    expect(await readStoredCliLink('second', '/isolated/credentials')).toMatchObject({ linkId: 'second' });
  });

  it('survives a new DB connection with terminal state intact and status reads do not write', async () => {
    const original = row();
    await createStoredCliLink(original);
    expect(await finishStoredCliLink(original.linkId, original.scope, original.owner.nonce, 'completed')).toBe(true);
    const before = await h.sql!`SELECT payload, updated_at FROM harness_shared.operator_account_link_state`;
    await h.sql!.end({ timeout: 5 });
    h.sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
    expect(await readStoredCliLink(original.linkId, original.scope)).toMatchObject({ outcome: 'completed' });
    expect(await h.sql`SELECT payload, updated_at FROM harness_shared.operator_account_link_state`).toEqual(before);
  });

  it('CAS admits one recovery and fences the dead custodian and a competing recoverer', async () => {
    const original = row();
    original.owner.processIdentity = 'prior-boot-or-reused-pid';
    await createStoredCliLink(original);
    expect(linkOwnerLiveness(original.owner)).toBe('dead');
    const claimed = await Promise.all([
      claimStoredCliLink(original, newLinkOwner()), claimStoredCliLink(original, newLinkOwner()),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(await finishStoredCliLink(original.linkId, original.scope, original.owner.nonce, 'completed')).toBe(false);
    const winner = claimed.find(Boolean)!;
    expect(linkOwnerLiveness(winner.owner)).toBe('alive');
    expect(await claimStoredCliLink(winner, newLinkOwner())).toBeNull();
    expect(await finishStoredCliLink(winner.linkId, winner.scope, winner.owner.nonce, 'completed')).toBe(true);
  });

  it('does not steal live, foreign-host or unverified owners even after the login TTL', async () => {
    for (const variant of ['live', 'foreign', 'unverified']) {
      const original = row(variant, { expiresAt: Date.now() - 60_000 });
      if (variant === 'foreign') original.owner.host += '-remote';
      if (variant === 'unverified') original.owner.processIdentity = null;
      await createStoredCliLink(original);
      expect(await claimStoredCliLink(original, newLinkOwner())).toBeNull();
    }
  });

  it('enforces credential scope, workspace isolation and row-level policy', async () => {
    const original = row();
    await createStoredCliLink(original);
    expect(await readStoredCliLink(original.linkId, '/another/install')).toBeNull();
    h.workspace = 'foreign-workspace';
    expect(await readStoredCliLink(original.linkId, original.scope)).toBeNull();
    const visible = await h.sql!.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      await tx`SELECT set_config('app.workspace_id', ${h.workspace}, true)`;
      return tx`SELECT * FROM harness_shared.operator_account_link_state`;
    });
    expect(visible).toHaveLength(0);
  });

  it('expires retained metadata and prunes it only on a write', async () => {
    const expired = row('expired', { retainUntil: Date.now() - 1 });
    await createStoredCliLink(expired);
    expect(await readStoredCliLink(expired.linkId, expired.scope)).toBeNull();
    expect(await claimStoredCliLink(expired, newLinkOwner(), () => 'dead')).toBeNull();
    await createStoredCliLink(row('fresh'));
    const [stored] = await h.sql!`SELECT payload FROM harness_shared.operator_account_link_state`;
    expect(stored.payload).not.toHaveProperty('expired');
    expect(stored.payload).toHaveProperty('fresh');
  });
});

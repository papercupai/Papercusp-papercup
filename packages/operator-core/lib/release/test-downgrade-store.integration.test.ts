/**
 * P-002 (green-main-ratchet-convergence-2026-10-17, R-1): real-Postgres regression for the test
 * downgrade STORE over `harness_shared.test_downgrades` (migration 1530).
 *
 * Record validation, the verb and the blocking rule are unit-tested in
 * `test-downgrade-store.test.ts` against a mocked SQL client. What only a real database can pin:
 *   - the schema itself refuses an incomplete record (reason, owner, bug id, author) and a
 *     critical-area row without a risk acknowledgement, even if a caller skips validation;
 *   - the partial unique index allows exactly one ACTIVE downgrade per file + case, and a revoked
 *     row frees the case for a new downgrade;
 *   - the daily digest query sees today's rows, revoked or not;
 *   - every read is scoped by workspace and harness;
 *   - the `harness_app` role holds the table and sequence grants the store needs.
 *
 * Run: npm run test:file -- packages/operator-core/lib/release/test-downgrade-store.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  isTestBlocking,
  pgTestDowngradeStore,
  startOfUtcDay,
  type NewTestDowngrade,
  type TestDowngradeStore,
} from './test-downgrade-store';

const WS = 'ws-test-downgrade-store';
const OTHER_WS = 'ws-test-downgrade-store-other';
const HARNESS = 'papercusp';
const FILE = 'packages/operator-core/lib/release/example.test.ts';
const CASE = 'example suite > keeps the gate honest';

let org: OrgTestDb;
let admin: Sql;
let store: TestDowngradeStore;

function record(overrides: Partial<NewTestDowngrade> = {}): NewTestDowngrade {
  return {
    testFile: FILE,
    testCase: CASE,
    reason: 'flaky under host load; fix tracked',
    owner: 'su-owner',
    bugId: 'EI-1',
    author: 'su-author',
    criticalArea: null,
    riskAcknowledgement: null,
    ...overrides,
  };
}

/** Insert a raw row as the superuser, bypassing the store's validation. */
async function rawInsert(columns: Record<string, string | null>): Promise<unknown> {
  const row = {
    workspace_id: WS,
    harness_slug: HARNESS,
    test_file: FILE,
    test_case: CASE,
    reason: 'r',
    owner: 'o',
    bug_id: 'b',
    author: 'a',
    ...columns,
  };
  const keys = Object.keys(row);
  return admin.unsafe(
    `INSERT INTO harness_shared.test_downgrades (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return String((error as { code?: unknown }).code ?? 'unknown');
  }
}

beforeAll(async () => {
  org = await createOrgTestDb();
  admin = org.adminSql;
  // The store runs as harness_app, so the migration's table + sequence grants are exercised.
  store = pgTestDowngradeStore(org.appSql, { workspaceId: WS, harnessSlug: HARNESS });
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await admin`DELETE FROM harness_shared.test_downgrades WHERE workspace_id IN (${WS}, ${OTHER_WS})`;
});

describe('test downgrade store — real Postgres (migration 1530)', () => {
  it('stores a complete record and lists it as active and in today’s digest', async () => {
    const stored = await store.insert(record());
    if ('conflict' in stored) throw new Error('unexpected conflict');
    expect(stored).toMatchObject({ testFile: FILE, testCase: CASE, reason: 'flaky under host load; fix tracked', owner: 'su-owner', bugId: 'EI-1', author: 'su-author', revokedAt: null });
    expect(Date.parse(stored.createdAt)).not.toBeNaN();

    const active = await store.listActive();
    expect(active.map((row) => row.id)).toEqual([stored.id]);
    expect(isTestBlocking(active, FILE, CASE)).toBe(false);

    const digest = await store.listCreatedSince(startOfUtcDay(new Date()));
    expect(digest.map((row) => row.id)).toContain(stored.id);
  });

  it('refuses incomplete records at the schema, even when a caller skips validation', async () => {
    expect(await sqlState(rawInsert({ reason: '  ' }))).toBe('23514');
    expect(await sqlState(rawInsert({ owner: '' }))).toBe('23514');
    expect(await sqlState(rawInsert({ bug_id: ' ' }))).toBe('23514');
    expect(await sqlState(rawInsert({ author: '' }))).toBe('23514');
    expect(await sqlState(rawInsert({ reason: null }))).toBe('23502');
    expect(await sqlState(rawInsert({ critical_area: 'migrations', risk_acknowledgement: null }))).toBe('23514');
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM harness_shared.test_downgrades WHERE workspace_id = ${WS}`;
    expect(n).toBe(0);
  });

  it('allows one active downgrade per file and case; a revoke restores blocking and frees the case', async () => {
    const first = await store.insert(record());
    if ('conflict' in first) throw new Error('unexpected conflict');
    const second = await store.insert(record({ reason: 'another reason' }));
    expect(second).toEqual({ conflict: expect.objectContaining({ id: first.id }) });

    const otherCase = await store.insert(record({ testCase: 'example suite > a sibling case' }));
    expect('conflict' in otherCase).toBe(false);

    const revoked = await store.revoke(first.id, 'su-reviewer', 'bug fixed');
    expect(revoked?.revokedAt).not.toBeNull();
    expect(await store.revoke(first.id, 'su-reviewer', 'twice')).toBeNull();

    const active = await store.listActive();
    expect(active.map((row) => row.id)).not.toContain(first.id);
    expect(isTestBlocking(active, FILE, CASE)).toBe(true);

    const digest = await store.listCreatedSince(startOfUtcDay(new Date()));
    expect(digest.map((row) => row.id)).toContain(first.id);

    const again = await store.insert(record());
    expect('conflict' in again).toBe(false);
  });

  it('requires a revoker, and stores the critical-area acknowledgement and owner notice', async () => {
    const stored = await store.insert(
      record({ criticalArea: 'migrations', riskAcknowledgement: 'migrations: main may ship a broken schema change' }),
    );
    if ('conflict' in stored) throw new Error('unexpected conflict');
    expect(stored).toMatchObject({ criticalArea: 'migrations', riskAcknowledgement: 'migrations: main may ship a broken schema change', ownerNotifiedAt: null });

    const at = new Date('2026-10-17T12:00:00.000Z');
    await store.markOwnerNotified(stored.id, at);
    const [row] = await store.listActive();
    expect(row.ownerNotifiedAt).toBe(at.toISOString());

    expect(
      await sqlState(admin`UPDATE harness_shared.test_downgrades SET revoked_at = now() WHERE id = ${stored.id}`),
    ).toBe('23514');
  });

  it('scopes every read and write by workspace and harness', async () => {
    await rawInsert({ workspace_id: OTHER_WS });
    await rawInsert({ harness_slug: 'another-harness' });
    expect(await store.listActive()).toEqual([]);
    expect(await store.listCreatedSince(new Date(0))).toEqual([]);

    const [foreign] = await admin<[{ id: string }]>`SELECT id FROM harness_shared.test_downgrades WHERE workspace_id = ${OTHER_WS}`;
    expect(await store.revoke(Number(foreign.id), 'su-reviewer', 'not ours')).toBeNull();

    const mine = await store.insert(record());
    expect('conflict' in mine).toBe(false);
  });
});

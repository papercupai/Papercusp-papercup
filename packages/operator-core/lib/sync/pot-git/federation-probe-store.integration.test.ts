/**
 * Captured-only federation-probe persistence guards (WI-3962).
 *
 * Applies the historical creation migration plus the contract-repair migration
 * against real PG. The resulting table may record only accepted local capture
 * (`acked`) or a loud pre-capture refusal (`refused`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../../test/_pg-helpers';
import { getProbe, insertProbe, insertRefusedProbe, listRecentProbes } from './federation-probe-store';
import { stampProbe } from './federation-probe';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');
const CREATION_MIGRATION = join(SQL_DIR, '544-federation-probes.sql');
// Armed under WI-6554700010008620; the .DRAFT fallback keeps the test valid in a checkout cut before arming.
const CAPTURED_ONLY_MIGRATION_ARMED = join(SQL_DIR, '917-federation-probes-captured-only-contract.sql');
const CAPTURED_ONLY_MIGRATION = existsSync(CAPTURED_ONLY_MIGRATION_ARMED)
  ? CAPTURED_ONLY_MIGRATION_ARMED
  : `${CAPTURED_ONLY_MIGRATION_ARMED}.DRAFT`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('federation-probe-store');
  await applyMigrationForTest(db.sql, CREATION_MIGRATION);
  await applyMigrationForTest(db.sql, CAPTURED_ONLY_MIGRATION);
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.federation_probes');
});

function stamp(overrides: Partial<Parameters<typeof stampProbe>[0]> = {}) {
  const result = stampProbe({
    workspaceId: 'ws-int',
    harnessSlug: 'papercusp',
    emittedBy: 'su-int-test',
    harnessIsFederated: true,
    nowMs: Date.now(),
    ...overrides,
  });
  if (!result.ok) throw new Error(`unexpected refusal in test setup: ${result.reason}`);
  return result.stamped;
}

describe('captured-only probe store', () => {
  it('inserts an accepted probe already acked with only captured stamped', async () => {
    const receipt = await insertProbe(stamp(), db.sql);
    expect(receipt.status).toBe('acked');
    expect(receipt.hops).toEqual({ captured: expect.any(Number) });
  });

  it('refuses a probe_key collision loudly instead of silently overwriting', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    await expect(insertProbe(stamped, db.sql)).rejects.toThrow(/already exists \(collision\)/);
  });

  it('round-trips and lists newest first within workspace+harness', async () => {
    const a = stamp({ nowMs: 1000 });
    const b = stamp({ nowMs: 2000 });
    await insertProbe(a, db.sql);
    await insertProbe(b, db.sql);

    const got = await getProbe(a.probeKey, db.sql);
    expect(got).toMatchObject({ probeKey: a.probeKey, harnessSlug: 'papercusp', status: 'acked' });

    const list = await listRecentProbes('ws-int', 'papercusp', 10, db.sql);
    expect(list.map((receipt) => receipt.probeKey)).toEqual([b.probeKey, a.probeKey]);
  });

  it('persists a refused probe with no captured hop', async () => {
    await insertRefusedProbe(
      {
        workspaceId: 'ws-int',
        harnessSlug: 'papercusp',
        emittedBy: 'su-int-test',
        probeKey: 'papercusp:v2t:refused-1',
        reason: 'harness_not_federated',
        nowMs: Date.now(),
      },
      db.sql,
    );
    const got = await getProbe('papercusp:v2t:refused-1', db.sql);
    expect(got).toMatchObject({
      status: 'refused',
      refusalReason: 'harness_not_federated',
      hops: {},
    });
  });
});

describe('migration 917 captured-only contract schema', () => {
  it('drops every synthetic post-capture field and the permissive status default', async () => {
    const columns = await db.sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'federation_probes'
       ORDER BY ordinal_position`;
    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'workspace_id',
      'harness_slug',
      'probe_key',
      'emitted_by',
      'emitted_at',
      'captured_at',
      'status',
      'refusal_reason',
    ]);
    expect(columns.find((column) => column.column_name === 'status')?.column_default).toBeNull();
  });

  it('enforces acked=captured and refused=uncaptured-with-reason', async () => {
    const baseValues = ['ws-int', 'papercusp', 'su-int-test'] as const;
    await expect(db.sql`
      INSERT INTO harness_shared.federation_probes
        (workspace_id, harness_slug, probe_key, emitted_by, captured_at, status)
      VALUES (${baseValues[0]}, ${baseValues[1]}, 'bad-pending', ${baseValues[2]}, now(), 'pending')
    `).rejects.toThrow();
    await expect(db.sql`
      INSERT INTO harness_shared.federation_probes
        (workspace_id, harness_slug, probe_key, emitted_by, status)
      VALUES (${baseValues[0]}, ${baseValues[1]}, 'bad-acked', ${baseValues[2]}, 'acked')
    `).rejects.toThrow();
    await expect(db.sql`
      INSERT INTO harness_shared.federation_probes
        (workspace_id, harness_slug, probe_key, emitted_by, captured_at, status, refusal_reason)
      VALUES (${baseValues[0]}, ${baseValues[1]}, 'bad-refused', ${baseValues[2]}, now(), 'refused', 'no')
    `).rejects.toThrow();
  });

  it('converts legacy captured pending/timed_out rows to acked', async () => {
    const legacyDb = await createFreshPgDb('federation-probe-store-legacy');
    try {
      await applyMigrationForTest(legacyDb.sql, CREATION_MIGRATION);
      await legacyDb.sql`
        INSERT INTO harness_shared.federation_probes
          (workspace_id, harness_slug, probe_key, emitted_by, captured_at, status)
        VALUES
          ('ws-int', 'papercusp', 'legacy-pending', 'su-int-test', now(), 'pending'),
          ('ws-int', 'papercusp', 'legacy-timeout', 'su-int-test', now(), 'timed_out')`;
      await applyMigrationForTest(legacyDb.sql, CAPTURED_ONLY_MIGRATION);
      const rows = await legacyDb.sql<Array<{ probe_key: string; status: string }>>`
        SELECT probe_key, status
          FROM harness_shared.federation_probes
         ORDER BY probe_key`;
      expect(rows).toEqual([
        { probe_key: 'legacy-pending', status: 'acked' },
        { probe_key: 'legacy-timeout', status: 'acked' },
      ]);
    } finally {
      await legacyDb?.cleanup();
    }
  });
});

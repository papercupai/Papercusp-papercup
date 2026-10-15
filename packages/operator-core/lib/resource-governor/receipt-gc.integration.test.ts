/** Real-PostgreSQL recurrence coverage for dedicated admission-ledger retention. */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql'),
  'utf8',
);

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

// scripts/mutation-probe.sh points this at a mutated copy (an ABSOLUTE path); unset, it is the real module.
const SUBJECT = process.env.RECEIPT_GC_PROBE_SUBJECT ?? './receipt-gc';
const { gcGovernorReceipts, GOVERNOR_RECEIPT_RETENTION_HOURS } = (await import(SUBJECT)) as typeof import('./receipt-gc');

let rootSql: postgres.Sql;

const NOW = 1_800_000_000_000; // fixed epoch ms so every cutoff is deterministic
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `grgc_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.operator_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      description text,
      updated_at bigint NOT NULL DEFAULT 0,
      workspace_id text
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      feature_id text NOT NULL,
      payload jsonb,
      PRIMARY KEY (workspace_id, feature_id)
    );
  `);
  await rootSql.unsafe(MIGRATION).simple();
  h.sql = rootSql;
});

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

let receiptSequence = 0;

function nextReceiptId(): string {
  const suffix = (++receiptSequence).toString(16).padStart(12, '0');
  return `RG-00000000-0000-4000-8000-${suffix}`;
}

/** Insert one schema-valid ledger receipt whose terminal clock is `ageHours` old. */
async function receipt(
  idempotencyKey: string,
  state: string,
  ageHours: number,
  workspaceId = 'workspace-a',
  options: { enqueuedAgeHours?: number; receiptId?: string } = {},
): Promise<void> {
  const updatedAtMs = NOW - ageHours * HOUR;
  const enqueuedAtMs = NOW - (options.enqueuedAgeHours ?? ageHours + 1) * HOUR;
  const activeLease = state === 'leased' || state === 'running';
  const record = {
    schemaVersion: 1,
    namespace: 'agent-process',
    idempotencyKey,
    requestFingerprint: `fingerprint:${workspaceId}:${idempotencyKey}`,
    admissionClass: 'process',
    state,
    priority: 1,
    enqueuedAtMs,
    updatedAtMs,
    deadlineAtMs: null,
    decision: { generation: 1, atMs: updatedAtMs, reason: `fixture-${state}` },
    ...(activeLease
      ? {
          lease: {
            leaseId: `lease:${idempotencyKey}`,
            owner: 'fixture-owner',
            generation: 1,
            expiresAtMs: NOW + HOUR,
          },
        }
      : {}),
  };
  await rootSql`
    INSERT INTO harness_shared.resource_governor_admissions
      (workspace_id, receipt_id, record, created_at)
    VALUES (
      ${workspaceId},
      ${options.receiptId ?? nextReceiptId()},
      ${rootSql.json(record)},
      to_timestamp(${enqueuedAtMs / 1_000})
    )`;
}

async function realWorkItem(id: string, workspaceId = 'workspace-a'): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.work_items (workspace_id, feature_id, payload)
    VALUES (${workspaceId}, ${id}, ${rootSql.json({ _ei: { severity: 'major' } })})`;
}

async function surviving(): Promise<string[]> {
  const rows = await rootSql<Array<{ idempotency_key: string }>>`
    SELECT idempotency_key
      FROM harness_shared.resource_governor_admissions
     ORDER BY idempotency_key`;
  return rows.map((row) => row.idempotency_key);
}

beforeEach(async () => {
  receiptSequence = 0;
  await rootSql`
    TRUNCATE harness_shared.resource_governor_admissions,
             harness_shared.operator_settings,
             harness_shared.work_items`;
});

describe('gcGovernorReceipts', () => {
  it('deletes ONLY aged terminal receipts, and returns the count', async () => {
    await receipt('OLD-COMPLETED', 'completed', 10);
    await receipt('OLD-CANCELLED', 'cancelled', 10);
    await receipt('OLD-EXPIRED', 'expired', 10);
    await receipt('OLD-SUPERSEDED', 'superseded', 10);

    await realWorkItem('WI-REAL-ANCIENT');
    await receipt('OLD-RUNNING', 'running', 10);
    await receipt('OLD-LEASED', 'leased', 10);
    await receipt('OLD-QUEUED', 'queued', 10);
    await receipt('OLD-ELIGIBLE', 'eligible', 10);
    await receipt('NEW-COMPLETED', 'completed', 0);

    const { deleted } = await gcGovernorReceipts({ nowMs: NOW });

    expect(deleted).toBe(4);
    expect(await surviving()).toEqual(['NEW-COMPLETED', 'OLD-ELIGIBLE', 'OLD-LEASED', 'OLD-QUEUED', 'OLD-RUNNING']);
    await expect(rootSql`SELECT feature_id FROM harness_shared.work_items`).resolves.toEqual([
      { feature_id: 'WI-REAL-ANCIENT' },
    ]);
  });

  it('CONTROL: work_items is outside the retention delete path', async () => {
    await realWorkItem('WI-REAL-OLD');
    await receipt('RECEIPT-OLD', 'completed', 10_000);

    expect((await gcGovernorReceipts({ nowMs: NOW })).deleted).toBe(1);
    expect(await surviving()).toEqual([]);
    await expect(rootSql`SELECT feature_id FROM harness_shared.work_items`).resolves.toEqual([
      { feature_id: 'WI-REAL-OLD' },
    ]);
  });

  it('CONTROL: an ACTIVE receipt is never aged out, however old', async () => {
    // Deleting a leased/running receipt destroys LIVE admission state, not history.
    await receipt('RUNNING-ANCIENT', 'running', 10_000);

    expect((await gcGovernorReceipts({ nowMs: NOW })).deleted).toBe(0);
    expect(await surviving()).toEqual(['RUNNING-ANCIENT']);
  });

  it('matches the composite workspace/receipt key during deletion', async () => {
    const sharedReceiptId = nextReceiptId();
    await receipt('COLLIDING-KEY', 'completed', 10, 'workspace-a', { receiptId: sharedReceiptId });
    await receipt('COLLIDING-KEY', 'running', 10, 'workspace-b', { receiptId: sharedReceiptId });

    expect((await gcGovernorReceipts({ nowMs: NOW })).deleted).toBe(1);
    const rows = await rootSql<Array<{ workspace_id: string; receipt_id: string; state: string }>>`
      SELECT workspace_id, receipt_id, state
        FROM harness_shared.resource_governor_admissions
       ORDER BY workspace_id`;
    expect(rows).toEqual([{ workspace_id: 'workspace-b', receipt_id: sharedReceiptId, state: 'running' }]);
  });

  it('honours the retention window boundary', async () => {
    await receipt('JUST-INSIDE', 'completed', GOVERNOR_RECEIPT_RETENTION_HOURS - 0.5);
    await receipt('JUST-OUTSIDE', 'completed', GOVERNOR_RECEIPT_RETENTION_HOURS + 0.5);

    expect((await gcGovernorReceipts({ nowMs: NOW })).deleted).toBe(1);
    expect(await surviving()).toEqual(['JUST-INSIDE']);
  });

  it('starts retention at the terminal transition, not admission creation', async () => {
    await receipt('LONG-RUN-RECENTLY-COMPLETED', 'completed', 0.5, 'workspace-a', {
      enqueuedAgeHours: 100,
    });

    expect((await gcGovernorReceipts({ nowMs: NOW })).deleted).toBe(0);
    expect(await surviving()).toEqual(['LONG-RUN-RECENTLY-COMPLETED']);
  });

  it('retentionHours widens or narrows what is due', async () => {
    await receipt('FIVE-HOURS', 'completed', 5);
    expect((await gcGovernorReceipts({ nowMs: NOW, retentionHours: 24 })).deleted).toBe(0);
    expect((await gcGovernorReceipts({ nowMs: NOW, retentionHours: 1 })).deleted).toBe(1);
  });

  it('batchLimit bounds one STATEMENT, not one run: a run drains every due batch', async () => {
    // The regression: inflow (52k/h) outgrew a per-RUN cap (50k/tick), so each
    // hourly run deleted exactly one batch and the backlog grew without bound.
    await receipt('AGE-9', 'completed', 9);
    await receipt('AGE-8', 'completed', 8);
    await receipt('AGE-7', 'completed', 7);
    await receipt('AGE-6', 'completed', 6);
    await receipt('AGE-5', 'completed', 5);
    await receipt('FRESH', 'completed', 0);

    expect(await gcGovernorReceipts({ nowMs: NOW, batchLimit: 2 })).toEqual({
      deleted: 5,
      batches: 3,
      exhausted: false,
    });
    expect(await surviving()).toEqual(['FRESH']);
  });

  it('a spent budget stops after a full batch, oldest first, and reports exhausted', async () => {
    await receipt('AGE-9', 'completed', 9);
    await receipt('AGE-8', 'completed', 8);
    await receipt('AGE-7', 'completed', 7);

    let t = 0;
    const elapsedClock = () => (t += 1_000);
    expect(await gcGovernorReceipts({ nowMs: NOW, batchLimit: 2, budgetMs: 1_000, elapsedClock })).toEqual({
      deleted: 2,
      batches: 1,
      exhausted: true,
    });
    expect(await surviving()).toEqual(['AGE-7']);

    // A later run picks up the remainder; a short batch is never "exhausted".
    expect(await gcGovernorReceipts({ nowMs: NOW, batchLimit: 2 })).toEqual({
      deleted: 1,
      batches: 1,
      exhausted: false,
    });
  });

  it('is a no-op when nothing is due', async () => {
    await receipt('FRESH', 'completed', 0);
    expect((await gcGovernorReceipts({ nowMs: NOW })).deleted).toBe(0);
  });
});

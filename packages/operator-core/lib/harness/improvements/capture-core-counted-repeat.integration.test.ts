/**
 * bug-inflow-one-problem-one-row-2026-10-18 R-11: a repeat is a count, not a row.
 *
 * A second report of an open tool-error row's key increments that row's occurrence
 * count (payload.repeatCount) and creates no work-item row. Driven on a fully migrated
 * Postgres through the two production doors that report repeated tool errors:
 *
 *  - captureToolInvocationFriction, the invocation-ledger watchdog's door (observation
 *    lane, probation): the same structural failure reported twice. A complete report
 *    keys its row `tool-failure-signature:…` (D-010);
 *  - captureImprovement with a `repeated-tool-error:…` watchdogKey on the work lane, a
 *    keyed detector re-fire (the open exact-key coalesce, capture-core.ts openKeyPrior).
 *
 * Falsifier: a second row exists on the key, or the count is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement, captureToolInvocationFriction } = await import('./capture-core');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

async function rowsOnKey(watchdogKey: string) {
  return db.adminSql<{ feature_id: string; status: string; payload: Record<string, unknown> }[]>`
    SELECT feature_id, status, payload
      FROM harness_shared.work_items
     WHERE payload->>'watchdogKey' = ${watchdogKey}`;
}

describe('R-11: a second report of an open repeated-tool-error key is a count, not a row', () => {
  it('the ledger watchdog reporting the same structural failure twice leaves one row at repeatCount 2', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const report = (invokedAt: string) => ({
      ownerId: 'su-r11-reporter',
      workspaceId: 'default',
      harnessSlug: '*',
      invokedAt,
      failure: {
        toolName: `r11_tool_${suffix.replace(/[^a-z0-9]/gi, '_')}`,
        errorCode: 'handler_error',
        status: 'error',
        message: "TypeError: Cannot read properties of undefined (reading 'items')",
        schemaRevision: 'rev-1',
        fieldPath: 'items',
        runtimeVersion: '0.0.0',
      },
    });

    const first = await captureToolInvocationFriction(report('2026-10-20T10:00:00.000Z'));
    expect(first).toMatchObject({ ok: true, created: true });
    // A complete ledger report keys its row by the build-independent signature (D-010).
    const key = (first!.issue!.payload as Record<string, unknown>).watchdogKey as string;
    expect(key).toMatch(/^tool-failure-signature:/);
    expect(await rowsOnKey(key)).toHaveLength(1);

    const second = await captureToolInvocationFriction(report('2026-10-20T10:05:00.000Z'));
    expect(second).toMatchObject({ ok: true, created: false, issue: { id: first!.issue!.id } });

    const rows = await rowsOnKey(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].feature_id).toBe(first!.issue!.id);
    expect(rows[0].status).toBe('open');
    expect(rows[0].payload.repeatCount).toBe(2);
  });

  it('a keyed watchdog re-fire on the work lane coalesces onto the open row at repeatCount 2', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const watchdogKey = `repeated-tool-error:r11_tool_${suffix.replace(/[^a-z0-9]/gi, '_')}:structural:handler_error:items`;
    const fire = (title: string) =>
      captureImprovement({
        title,
        body: `Repeated structural failure.\n\nSample error: TypeError: reading 'items' (${suffix})`,
        kind: 'bug',
        scope: 'operator',
        watchdogKey,
        createdBy: 'system:improvement-watchdog',
      });

    const first = await fire(`r11 repeated tool error ${suffix}`);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(await rowsOnKey(watchdogKey)).toHaveLength(1);

    const second = await fire(`r11 repeated tool error ${suffix} (newer reading)`);
    expect(second).toMatchObject({ ok: true, created: false, reason: 'coalesced', issue: { id: first.issue!.id } });

    const rows = await rowsOnKey(watchdogKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].payload.repeatCount).toBe(2);
  });
});

/**
 * flag-audit.integration.test.ts — EI-293 regression guard.
 *
 * Proves, against a real Postgres (testcontainer) with the baseline audit_log
 * shape (NOT-NULL id + workspace_id, no defaults, the workspace_id <> '' CHECK):
 *   1. recordFlagAudit lands a complete, queryable `flag:set` row.
 *   2. The row carries the full column set — the exact gap that made the old
 *      MCP inline INSERT (omitting id + workspace_id) silently fail every time.
 *
 * Mirrors the testcontainer + getOrgPg-mock setup of harness-issues.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'test-ws' };
});

import { recordFlagAudit } from './flag-audit';

let adminUrl: string;
let dbName: string;
let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `flagaudit_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  adminUrl = adminUri.replace(/\/[^/]+$/, `/${dbName}`);
  sql = postgres(adminUrl, { max: 4, onnotice: () => {} });
  // Baseline-faithful audit_log: NOT-NULL id + workspace_id, no defaults, the CHECK.
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.audit_log (
      id           text NOT NULL,
      ts           bigint NOT NULL,
      actor        text NOT NULL DEFAULT 'user',
      action       text NOT NULL,
      subject      text NOT NULL,
      details      jsonb,
      workspace_id text NOT NULL,
      CONSTRAINT audit_log_pkey PRIMARY KEY (id),
      CONSTRAINT audit_workspace_nonempty CHECK ((workspace_id <> ''))
    )`);
  h.sql = sql;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('recordFlagAudit (EI-293)', () => {
  it('lands a complete flag:set row (id + workspace_id + details all populated)', async () => {
    await recordFlagAudit('papercusp-inference-gateway', true, 'su-tester', {
      reason: 'load test passed',
      backend: 'pg-override',
    });

    const rows = await sql`
      SELECT id, ts, actor, action, subject, details, workspace_id
      FROM harness_shared.audit_log WHERE action = 'flag:set'`;
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.id).toBeTruthy();              // NOT-NULL id the old MCP insert omitted
    expect(r.workspace_id).toBe('test-ws'); // NOT-NULL workspace_id it also omitted
    expect(r.actor).toBe('su-tester');
    expect(r.subject).toBe('papercusp-inference-gateway');
    const details = typeof r.details === 'string' ? JSON.parse(r.details) : r.details;
    expect(details).toMatchObject({ enabled: true, reason: 'load test passed', backend: 'pg-override' });
    expect(Number.isFinite(Number(r.ts))).toBe(true);
  });

  it('never throws even if the write fails (best-effort contract)', async () => {
    // Point the mock at a closed connection — recordFlagAudit must swallow it.
    // The best-effort catch logs a warning; silence it so the
    // fail-on-console rule doesn't flag the EXPECTED failure path.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dead = postgres(adminUrl, { max: 1 });
    await dead.end({ timeout: 1 });
    const prev = h.sql;
    h.sql = dead;
    await expect(recordFlagAudit('papercusp-testing', false, 'x')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith('[flags] audit write failed:', expect.any(String));
    h.sql = prev;
    warnSpy.mockRestore();
  });
});

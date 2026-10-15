/**
 * tool-authz-audit.integration.test.ts — the tool resource-authorization audit
 * sink (tool_authz_log, migration 090), against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the `to_timestamp(ts / 1000.0)` epoch-MS → timestamptz conversion (a bare
 *    to_timestamp(ts) would land the row ~50,000 years in the future);
 *  - the event→column mapping with nullish-coalesced optionals (principal/resource/
 *    reason all absent → NULL columns);
 *  - an allow/deny/bypass all land as append-only rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { recordToolAuthzEvent } = await import('./tool-authz-audit');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `authz_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`); // gen_random_uuid()
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 090: ts timestamptz, tool/action/decision/gate NOT NULL.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.tool_authz_log (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      ts timestamptz DEFAULT now() NOT NULL,
      workspace_id text, principal_slug text,
      tool text NOT NULL, action text NOT NULL,
      resource_type text, resource_id text,
      decision text NOT NULL, gate text NOT NULL, reason text
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.tool_authz_log`;
});

const ev = (over: Record<string, unknown> = {}) => ({
  ts: 1_716_000_000_000,
  principal: { workspaceId: 'ws-1', slug: 'builder-1' },
  tool: 'Bash', action: 'execute',
  resource: { type: 'file', id: '/etc/x' },
  decision: 'allow', gate: 'policy', reason: 'ok',
  ...over,
}) as never;

describe('recordToolAuthzEvent (PG)', () => {
  it('maps every field and converts ts (epoch ms) to a timestamptz row', async () => {
    await recordToolAuthzEvent(ev());
    const row = (await rootSql<{ workspace_id: string; principal_slug: string; tool: string; action: string; resource_type: string; resource_id: string; decision: string; gate: string; reason: string; ms: string }[]>`
      SELECT workspace_id, principal_slug, tool, action, resource_type, resource_id, decision, gate, reason,
             (extract(epoch from ts) * 1000)::bigint AS ms
        FROM harness_shared.tool_authz_log`)[0]!;
    expect(row).toMatchObject({
      workspace_id: 'ws-1', principal_slug: 'builder-1', tool: 'Bash', action: 'execute',
      resource_type: 'file', resource_id: '/etc/x', decision: 'allow', gate: 'policy', reason: 'ok',
    });
    expect(Number(row.ms)).toBe(1_716_000_000_000); // ts round-trips → epoch-ms preserved (the /1000.0 conversion)
  });

  it('nullish-coalesces absent principal / resource / reason to NULL columns', async () => {
    await recordToolAuthzEvent(ev({ principal: undefined, resource: undefined, reason: undefined }));
    const row = (await rootSql<{ workspace_id: string | null; principal_slug: string | null; resource_type: string | null; resource_id: string | null; reason: string | null }[]>`
      SELECT workspace_id, principal_slug, resource_type, resource_id, reason FROM harness_shared.tool_authz_log`)[0]!;
    expect(row).toEqual({ workspace_id: null, principal_slug: null, resource_type: null, resource_id: null, reason: null });
  });

  it('appends one row per event (allow / deny / bypass)', async () => {
    await recordToolAuthzEvent(ev({ decision: 'allow' }));
    await recordToolAuthzEvent(ev({ decision: 'deny', reason: 'no perms' }));
    await recordToolAuthzEvent(ev({ decision: 'allow', gate: 'GateBypass.policy' }));
    const rows = await rootSql<{ decision: string; gate: string }[]>`SELECT decision, gate FROM harness_shared.tool_authz_log ORDER BY ts`;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.decision)).toContain('deny');
    expect(rows.map((r) => r.gate)).toContain('GateBypass.policy');
  });
});

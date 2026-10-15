/**
 * P-008a (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-6554700010011903, D-017) over real
 * Postgres: the redacted SIEM export traces accepted AND denied actions end to end by one correlation
 * key (`ti:<tool_invocations.id>`) through identity, authorization, the governance policy in effect at
 * the event's time, resource metadata and result — and only an authorized human administrator of the
 * workspace may read it.
 *
 * Fixture: org-acme > dept-a > ws-a, org-acme > dept-b > ws-b. admin:dept-a holds approve on dept-a,
 * su-agent-1 (a service identity) holds prepare on org-acme. The tool_invocations table is built FROM
 * the drizzle schema (never by hand), so it cannot drift from the real one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { generated } from '@papercusp/db-org';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { grantDelegation, recordBootstrapDelegation } from '../governance-policy/authority';
import { listVersions, upsertLayer, type UpsertLayerInput } from '../governance-policy/store';
import {
  SIEM_WITHHELD_CREDENTIAL,
  SiemExportAccessError,
  exportSiemPage,
  siemPseudonym,
  verifySiemBatchJsonl,
  type ExportSiemPageInput,
  type SiemBatch,
} from './siem-export';

const SQL_DIR = '../../../../libs/papercusp/libs/db/sql/';
// governance_delegations is created by 1498, so both governance migrations are needed.
const MIGRATIONS = ['1497-governance-policy-layers.sql', '1498-governance-sensitive-actions.sql'].map((f) =>
  fileURLToPath(new URL(`${SQL_DIR}${f}`, import.meta.url)),
);
const HOUR = 60 * 60_000;
const KEY = randomBytes(32);
// Credential-SHAPED canaries assembled at runtime: no secret-shaped literal enters the tree.
const BEARER_SECRET = 'abcdefghijklmnopqrstuvwxyz0123';
const BEARER = ['Bearer', BEARER_SECRET].join(' ');
const SK_SECRET = 'CANARYABCDEFGHIJ1234';
const SK = ['sk', 'canary', SK_SECRET].join('_');
const JSONB = new Set(['args_json', 'metadata_json']);

let sql: postgres.Sql;
let clock: Date;

function toolInvocationsDdl(): string {
  const cfg = getTableConfig(generated.toolInvocationsInHarnessShared);
  const cols = cfg.columns.map((c) => `"${c.name}" ${c.getSQLType()}${c.notNull ? ' NOT NULL' : ''}`);
  return `CREATE TABLE "${cfg.schema ?? 'harness_shared'}"."${cfg.name}" (${cols.join(', ')})`;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `siemexport_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  for (const file of MIGRATIONS) await sql.unsafe(readFileSync(file, 'utf8'));
  await sql.unsafe(toolInvocationsDdl());
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function layer(over: Partial<UpsertLayerInput> & Pick<UpsertLayerInput, 'layerId' | 'level' | 'scopeRef'>): UpsertLayerInput {
  return { parentLayerId: null, rules: {}, exceptions: [], actor: 'admin:root', reason: 'pilot baseline', ...over };
}

async function grant(principal: string, layerId: string, capabilities: string[]) {
  return grantDelegation(
    { grantor: 'admin:root', principal, layerId, capabilities, reason: 'pilot administration', expiresAt: new Date(clock.getTime() + 24 * HOUR), now: clock },
    sql,
  );
}

async function invocation(over: Record<string, unknown>): Promise<void> {
  const row: Record<string, unknown> = {
    workspace_id: 'ws-a',
    harness_slug: 'papercusp',
    plugin_name: 'core',
    tool_name: 'work_items:get',
    role: 'operator',
    spawn_id: 'spawn-1',
    window_key: 'w',
    status: 'ok',
    transport: 'mcp',
    principal_kind: 'human',
    principal_auth_method: 'bearer',
    principal_trust: 'owner',
    coord_owner_id: 'admin:alice',
    args_json: { id: 'WI-1' },
    ...over,
  };
  const cols = Object.keys(row);
  const params = cols.map((c) => (JSONB.has(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
  await sql.unsafe(
    `INSERT INTO harness_shared.tool_invocations (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map((c, i) => `$${i + 1}${JSONB.has(c) ? '::jsonb' : ''}`).join(', ')})`,
    params as never[],
  );
}

beforeEach(async () => {
  clock = new Date();
  await sql.unsafe(`TRUNCATE harness_shared.tool_invocations, harness_shared.governance_delegations,
    harness_shared.governance_policy_layer_versions, harness_shared.governance_policy_layers CASCADE`);
  await upsertLayer(layer({ layerId: 'org-acme', level: 'organization', scopeRef: 'acme' }), sql);
  await upsertLayer(layer({ layerId: 'dept-a', level: 'department', scopeRef: 'a', parentLayerId: 'org-acme' }), sql);
  await upsertLayer(layer({ layerId: 'dept-b', level: 'department', scopeRef: 'b', parentLayerId: 'org-acme' }), sql);
  await upsertLayer(layer({ layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-a' }), sql);
  await upsertLayer(layer({ layerId: 'ws-b', level: 'workspace', scopeRef: 'ws-b', parentLayerId: 'dept-b' }), sql);
  await recordBootstrapDelegation(sql, { principal: 'admin:root', layerId: 'org-acme', now: clock });
  await grant('admin:dept-a', 'dept-a', ['prepare', 'approve']);
  await grant('su-agent-1', 'org-acme', ['prepare']);
});

const page = (over: Partial<ExportSiemPageInput> & Pick<ExportSiemPageInput, 'now'>): Promise<SiemBatch> =>
  exportSiemPage({ principal: 'admin:dept-a', workspaceId: 'ws-a', afterId: '0', prevHead: null, limit: 100, key: KEY, sql, ...over });

interface Ev {
  status_id: number;
  severity_id: number;
  status_detail: unknown;
  metadata: { uid: string; correlation_uid: string; tenant_uid: unknown };
  actor: { user: { uid: unknown; type: unknown }; authorizations: Array<{ decision: string; policy?: { uid: string; version: string } }> };
  api: { operation: unknown; request: { uid: string }; response: { code: unknown; error: unknown } };
  unmapped: { papercusp_source: Record<string, unknown>; papercusp_policy_chain: Array<{ layer_id: string; version: number }> };
}

function events(batch: SiemBatch, startAfter: SiemBatch['manifest']['head'] | null): Ev[] {
  const v = verifySiemBatchJsonl(batch.jsonl, { startAfter });
  if (!v.ok) throw new Error(`batch failed verification: ${v.reason}`);
  return v.events as unknown as Ev[];
}
const chainOf = (e: Ev) => e.unmapped.papercusp_policy_chain.map((r) => `${r.layer_id}@${r.version}`);

describe('ENT-P-008a: redacted, tamper-evident SIEM export traced by one correlation key', () => {
  it('follows accepted and denied actions end to end, across a policy change, in a verifiable continuing stream', async () => {
    const t1 = Date.parse((await listVersions('ws-a', 5, sql))[0]!.recordedAt);
    await new Promise((r) => setTimeout(r, 25));
    await upsertLayer(
      layer({ layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-a', rules: { tools: { deny: ['processes:kill'] } }, reason: 'lock process control' }),
      sql,
    );
    const v2 = (await listVersions('ws-a', 5, sql))[0]!;
    expect(v2.version).toBe(2);
    const t2 = Date.parse(v2.recordedAt);
    expect(t2).toBeGreaterThan(t1 + 10);
    const exportNow = new Date(t2 + HOUR);

    await invocation({ id: 101, invoked_at: new Date(t1 + 5) });
    await invocation({
      id: 102,
      invoked_at: new Date(t1 + 8),
      tool_name: 'processes:kill',
      status: 'error',
      error_code: 'authorization_denied',
      principal_kind: 'service',
      coord_owner_id: 'su-agent-1',
    });
    await invocation({
      id: 103,
      invoked_at: new Date(t2 + 1000),
      status: 'error',
      error_code: SK,
      error_message: `request failed: ${BEARER}`,
      args_json: { authorization: BEARER, note: `token=${SK}` },
      metadata_json: { auth: BEARER },
    });
    await invocation({ id: 104, invoked_at: new Date(t2 + 2000) });
    await invocation({ id: 105, invoked_at: new Date(t2 + 2500), workspace_id: 'ws-b' });
    await invocation({ id: 106, invoked_at: new Date(exportNow.getTime() - 60_000) });

    // Page 1: a rooted chain over the first two settled rows.
    const p1 = await page({ now: exportNow, limit: 2 });
    expect(p1.manifest).toMatchObject({ cursorFrom: '0', cursorTo: '102', length: 2, startAfter: null });
    const [accepted, denied] = events(p1, null);

    expect(accepted).toMatchObject({
      status_id: 1,
      severity_id: 1,
      metadata: { uid: 'ti:101', correlation_uid: 'ti:101', tenant_uid: 'ws-a' },
      actor: { user: { uid: siemPseudonym(KEY, 'admin:alice'), type: 'human' }, authorizations: [{ decision: 'Allowed', policy: { uid: 'ws-a', version: '1' } }] },
      api: { operation: 'work_items:get', request: { uid: 'ti:101' }, response: { code: 'ok' } },
      unmapped: { papercusp_source: { id: '101', principal_auth_method: 'bearer', principal_trust: 'owner', transport: 'mcp' } },
    });
    expect(chainOf(accepted!)).toEqual(['org-acme@1', 'dept-a@1', 'ws-a@1']);

    expect(denied).toMatchObject({
      status_id: 2,
      severity_id: 3,
      status_detail: 'authorization_denied',
      metadata: { uid: 'ti:102' },
      actor: { user: { uid: siemPseudonym(KEY, 'su-agent-1'), type: 'service' }, authorizations: [{ decision: 'Denied' }] },
      api: { operation: 'processes:kill', response: { code: 'error', error: 'authorization_denied' } },
    });

    // Page 2 continues the stream; the fresh row (106) is not settled yet, the ws-b row never appears.
    const p2 = await page({ now: exportNow, afterId: p1.manifest.cursorTo, prevHead: p1.head });
    expect(p2.manifest).toMatchObject({ cursorFrom: '102', cursorTo: '104', length: 2, startAfter: p1.manifest.head });
    expect(verifySiemBatchJsonl(p2.jsonl, { startAfter: null }).ok).toBe(false);
    const [canary, after] = events(p2, p1.manifest.head);
    expect(canary!.status_detail).toBe(SIEM_WITHHELD_CREDENTIAL);
    expect(chainOf(after!)).toEqual(['org-acme@1', 'dept-a@1', 'ws-a@2']);
    expect(after!.actor.authorizations[0]!.policy).toMatchObject({ uid: 'ws-a', version: '2' });

    // Redaction holds over the real read path.
    for (const jsonl of [p1.jsonl, p2.jsonl]) {
      for (const leaked of [BEARER_SECRET, SK_SECRET, 'request failed', 'token=', 'admin:alice', 'su-agent-1', 'ti:105', 'ws-b']) {
        expect(jsonl).not.toContain(leaked);
      }
    }

    // A redelivery of the same range over the same head is byte-identical (SIEM de-duplicates it).
    const replay = await page({ now: exportNow, afterId: p1.manifest.cursorTo, prevHead: p1.head });
    expect(replay.jsonl).toBe(p2.jsonl);
    expect(replay.manifest.idempotencyKey).toBe(p2.manifest.idempotencyKey);

    // Nothing settled yet: an empty segment that still verifies after the head and keeps it.
    const p3 = await page({ now: exportNow, afterId: p2.manifest.cursorTo, prevHead: p2.head });
    expect(p3.manifest).toMatchObject({ length: 0, cursorFrom: '104', cursorTo: '104', head: p2.manifest.head });
    expect(events(p3, p2.manifest.head)).toEqual([]);

    // Time moves on: the fresh row settles and continues the same chain.
    const p4 = await page({ now: new Date(exportNow.getTime() + HOUR), afterId: p3.manifest.cursorTo, prevHead: p3.head });
    expect(events(p4, p3.manifest.head).map((e) => e.metadata.uid)).toEqual(['ti:106']);
  });
});

describe('ENT-P-008a: only an authorized human administrator of the workspace may export', () => {
  async function refusal(principal: string, workspaceId: string): Promise<SiemExportAccessError> {
    await invocation({ id: 201, workspace_id: workspaceId, invoked_at: new Date(clock.getTime() - HOUR) });
    try {
      await page({ principal, workspaceId, now: clock });
    } catch (error) {
      expect(error).toBeInstanceOf(SiemExportAccessError);
      return error as SiemExportAccessError;
    }
    throw new Error(`export by ${principal} on ${workspaceId} was not refused`);
  }

  it('positive control: the department administrator exports its own workspace', async () => {
    await invocation({ id: 201, invoked_at: new Date(clock.getTime() - HOUR) });
    const batch = await page({ now: clock });
    expect(events(batch, null).map((e) => e.metadata.uid)).toEqual(['ti:201']);
  });

  it('refuses a service principal even when it holds governance authority', async () => {
    expect((await refusal('su-agent-1', 'ws-a')).message).toMatch(/only a human principal/);
  });

  it('refuses a human with no delegation', async () => {
    expect((await refusal('admin:mallory', 'ws-a')).message).toMatch(/lacks approve over ws-a/);
  });

  it('refuses a cross-workspace read: dept-a administrator on ws-b', async () => {
    expect((await refusal('admin:dept-a', 'ws-b')).message).toMatch(/lacks approve over ws-b/);
  });

  it('refuses a workspace with no governance chain', async () => {
    expect((await refusal('admin:dept-a', 'ws-unknown')).message).toMatch(/no valid governance chain/);
  });
});

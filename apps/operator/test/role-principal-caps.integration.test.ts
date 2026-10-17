/**
 * role-principal-caps.integration.test.ts
 *
 * Covers the least-privilege capability loader behind the fix for built-in
 * tools failing `requires authenticated request (bearer + workspace tx)` when
 * called by a signed role-scoped (non-superuser) MCP agent (found in
 * harness_shared.tool_invocations, 2026-05-31).
 *
 * Contract: provisioned grants compose with the role baseline, tool discovery,
 * native-tool replacements and derived read grants. Provisioned capabilities
 * remain workspace-isolated; an unprovisioned worker gets no workflow grants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  loadRoleCapabilities,
  dispatchNeedsTx,
  synthesizeDispatchPrincipal,
  BLUEPRINT_ROLE_CAPS,
} from '@papercusp/operator-core/lib/endpoint-route/routes/transport/role-principal-caps';

// loadRoleCapabilities unions a role's workspace-AGNOSTIC blueprint baseline
// (BLUEPRINT_ROLE_CAPS — autoloop-pot-operator-rebuild P-004 added the pot's
// `operator` set) on top of its provisioned (per-workspace) caps. Assert against
// the source of truth so an operator-cap change doesn't drift this test again.
const OP_BASELINE = BLUEPRINT_ROLE_CAPS.operator ?? [];
const SEEDED_OPERATOR = ['harness:read', 'audit:read', 'chat:write'];
// Every role-scoped caller also gets the universal read-only tool-discovery cap:
// agent_tools:list is declared ALL_ROLES + requirePrincipal:false and every
// pipeline-role persona instructs calling `agent_tools:list { asRole }`. See the
// grant in role-principal-caps.ts (loadRoleCapabilities).
const UNIVERSAL_CAPS = ['agent_tools:read'];
// Independent oracle for the signed-principal half of the native-tool cutover.
// Keep exact membership checks: an extra workflow/administrative grant must fail.
const NATIVE_REPLACEMENT_CAPS = ['capability:bash', 'capability:fs-read', 'capability:fs-write', 'capability:git', 'capability:net'];
const EXPECTED_WORKER = [...UNIVERSAL_CAPS, ...NATIVE_REPLACEMENT_CAPS].sort();
const EXPECTED_DEFAULT_OPERATOR = [...new Set([
  ...SEEDED_OPERATOR, ...OP_BASELINE, ...UNIVERSAL_CAPS, ...NATIVE_REPLACEMENT_CAPS,
  'memory:search:read', // Derived from the operator baseline's memory:read.
])].sort();

let sql: postgres.Sql;
let dbName: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `rpc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });

  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE harness_shared.system_principals (
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      capabilities JSONB NOT NULL,
      bearer_hash  TEXT,
      PRIMARY KEY (workspace_id, name)
    )`);
  const ins = async (ws: string, name: string, caps: string[]) => {
    await sql`INSERT INTO harness_shared.system_principals (workspace_id, name, capabilities)
              VALUES (${ws}, ${name}, ${sql.json(caps)})`;
  };
  await ins('default', 'operator', ['harness:read', 'audit:read', 'chat:write']);
  await ins('default', 'oracle', ['harness:read', 'docs:read']);
  await ins('other', 'operator', ['harness:read']);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('loadRoleCapabilities (least-privilege)', () => {
  it('returns the provisioned caps UNIONED with the operator blueprint baseline (P-004)', async () => {
    const caps = await loadRoleCapabilities(sql, 'default', 'operator');
    // The 3 provisioned caps…
    for (const c of SEEDED_OPERATOR) expect(caps.has(c)).toBe(true);
    // …plus the workspace-agnostic pot/operator blueprint baseline (P-004).
    for (const c of OP_BASELINE) expect(caps.has(c)).toBe(true);
    expect([...caps].sort()).toEqual(EXPECTED_DEFAULT_OPERATOR);
  });

  it('returns exactly discovery and native-tool replacement caps for an unprovisioned worker', async () => {
    const caps = await loadRoleCapabilities(sql, 'default', 'worker');
    expect([...caps].sort()).toEqual(EXPECTED_WORKER);
  });

  it('does not grant native replacements to an unknown role', async () => {
    const caps = await loadRoleCapabilities(sql, 'default', 'unprovisioned-unknown');
    expect([...caps].sort()).toEqual(UNIVERSAL_CAPS);
  });

  it('is workspace-isolated — the PROVISIONED delta does not leak across workspaces', async () => {
    // Both workspaces' operators share the workspace-agnostic blueprint baseline;
    // the isolation point is the PROVISIONED caps. 'default' provisions
    // audit:read + chat:write; 'other' provisions only harness:read.
    const caps = await loadRoleCapabilities(sql, 'default', 'operator');
    const otherCaps = await loadRoleCapabilities(sql, 'other', 'operator');
    expect(caps.has('audit:read')).toBe(true);
    expect(caps.has('chat:write')).toBe(true);
    // 'other' did NOT provision those, and they are not in the baseline → absent.
    expect(otherCaps.has('audit:read')).toBe(false);
    expect(otherCaps.has('chat:write')).toBe(false);
    // …but 'other' still gets the shared baseline (e.g. work_items:read).
    for (const c of OP_BASELINE) expect(otherCaps.has(c)).toBe(true);
  });
});

// The #1 handler-path decision+synthesis (the wiring in _mcp-handler.ts that
// the cap-loader alone didn't cover). These are the exact functions the tools/
// call handler now calls.
describe('dispatchNeedsTx', () => {
  it('a concrete workspace needs a principal + tx', () => {
    expect(dispatchNeedsTx({ workspaceId: 'default' })).toBe(true);
  });
  it("'*' (superuser, no workspace chosen) does NOT — caller must pass ?workspace", () => {
    expect(dispatchNeedsTx({ workspaceId: '*' })).toBe(false);
  });
  it('an empty workspace does NOT', () => {
    expect(dispatchNeedsTx({ workspaceId: '' })).toBe(false);
  });
});

describe('synthesizeDispatchPrincipal', () => {
  it('role-scoped (non-superuser) gets its provisioned caps + system:<role> slug', async () => {
    const p = await synthesizeDispatchPrincipal(sql, { workspaceId: 'default', role: 'operator', isSuperuser: false });
    expect(p.slug).toBe('system:operator');
    expect(p.workspaceId).toBe('default');
    // Provisioned caps ∪ the operator blueprint baseline (P-004).
    expect([...p.capabilities].sort()).toEqual(EXPECTED_DEFAULT_OPERATOR);
  });

  it('an unprovisioned worker gets exactly discovery and native replacements without workflow grants', async () => {
    const p = await synthesizeDispatchPrincipal(sql, { workspaceId: 'default', role: 'worker', isSuperuser: false });
    expect(p.slug).toBe('system:worker');
    expect([...p.capabilities].sort()).toEqual(EXPECTED_WORKER);
  });

  it('superuser keeps an empty cap-set (it relies on gateBypass.capability, not loaded caps)', async () => {
    const p = await synthesizeDispatchPrincipal(sql, { workspaceId: 'default', role: 'operator', isSuperuser: true });
    expect(p.slug).toBe('system:operator');
    expect(p.capabilities.size).toBe(0); // not 3 — superuser does NOT load role caps
  });
});

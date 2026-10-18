/** Owned child of customer-data-support-runtime.integration.test.ts. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, stopPrivateOperatorHost,
  waitForPrivateOperator } from './private-http-workspace-preflight';
import { readProcessIdentity } from '../lib/process-identity';

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const evidenceDir = e.CUSTOMER_DATA_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir);
  const { sql } = getOrgPg();
  let host: ChildProcess | undefined;
  let hostIdentity: string | null | undefined;
  try {
    // The migration remains DRAFT; only this owned disposable DB exercises it.
    for (const name of ['1509-hosted-customer-data-workspace-export', '1513-hosted-customer-deletion-freeze']) {
      const url = new URL(`../../../libs/papercusp/libs/db/sql/${name}.sql`, import.meta.url);
      await sql.unsafe(readFileSync(existsSync(url) ? url : new URL(`${url.href}.DRAFT`), 'utf8'));
    }
    const organizationId = randomUUID(), foreignOrg = randomUUID(), userId = randomUUID(), foreignUser = randomUUID();
    const grantId = randomUUID(), token = randomUUID(), wildcardToken = randomUUID();
    const [staff] = await sql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
      VALUES (${`support-runtime-${randomUUID()}`}, 'Private support fixture') RETURNING id`;
    assert.ok(staff);
    for (const [id, tenant] of [[userId, organizationId], [foreignUser, foreignOrg]]) {
      await sql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name, status)
        VALUES (${tenant}::uuid, ${`runtime-${tenant}`}, 'Private support tenant', 'active')`;
      await sql`INSERT INTO papercusp_auth.hosted_users (id, primary_email, status)
        VALUES (${id}::uuid, ${`${id}@example.test`}, 'active')`;
      await sql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
        VALUES (${tenant}::uuid, ${id}::uuid, 'owner', 'organization_bootstrap')`;
    }
    await sql`INSERT INTO papercusp_auth.support_access_grants
      (id, organization_id, staff_principal_id, granted_by_user_id, purpose, scopes, banner_message, starts_at, expires_at)
      VALUES (${grantId}::uuid, ${organizationId}::uuid, ${staff.id}, ${userId}::uuid, 'Private current-build export',
        ${['customer-data:export']}, 'Private support export', now() - interval '1 minute', now() + interval '1 hour')`;
    for (const [value, scopes] of [[token, ['customer-data:export']], [wildcardToken, ['*']]] as const) {
      await sql`INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, workspace_id, capabilities)
        VALUES (${value}, ${staff.id}::uuid, now() + interval '1 hour', ${workspace}, ${[...scopes]})`;
    }
    const root = resolve(import.meta.dirname, '../../..');
    const { path: bundle, sha256: bundleSha256 } = await buildPrivateOperatorApiBundle(root, evidenceDir,
      { timeoutMs: 240_000, maxMs: 420_000 });
    const hostEnv = privateBundleRuntimeEnv({ ...e, PAPERCUSP_HOSTED_SUPPORT_STAFF_PRINCIPAL_IDS: staff.id });
    host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', chunk => process.stdout.write(chunk));
    host.stderr!.on('data', chunk => process.stderr.write(chunk));
    hostIdentity = readProcessIdentity(host.pid!);
    assert.ok(hostIdentity);
    await waitForPrivateOperator({ host, base, evidenceDir, hostIdentity, environment: hostEnv });
    const post = (value = token, tenant = organizationId) => fetch(`${base}/api/admin/customer-data/export`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base,
        ...(value ? { cookie: `papercusp_session=${value}` } : {}) },
      body: JSON.stringify({ organizationId: tenant, grantId }), signal: AbortSignal.timeout(30_000),
    });
    const response = await post();
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { result: { receiptId: string; stores: { store: string; rows: { id: string }[] }[] } };
    assert.deepEqual(body.result.stores.find(row => row.store === 'papercusp_auth.hosted_users')?.rows.map(row => row.id), [userId]);
    assert.ok(!JSON.stringify(body).includes(foreignUser));
    assert.ok(!JSON.stringify(body).includes(foreignOrg));
    assert.equal((await post(token, foreignOrg)).status, 403);
    assert.equal((await post(wildcardToken)).status, 403);
    await sql`UPDATE papercusp_auth.support_access_grants SET revoked_at = now(), revoked_by_user_id = ${userId}::uuid,
      revocation_reason = 'Private fixture revocation' WHERE id = ${grantId}::uuid`;
    assert.equal((await post()).status, 403);
    await sql`DELETE FROM harness_shared.user_sessions WHERE token = ${token}`;
    assert.equal((await post()).status, 403);
    const receipts = await sql`SELECT actor_kind, actor_id, purpose FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${organizationId}::uuid AND action = 'organization.data.export'`;
    assert.deepEqual([...receipts], [{ actor_kind: 'staff_admin', actor_id: staff.id, purpose: 'Private current-build export' }]);
    await stopPrivateOperatorHost(host);
    assert.notEqual(readProcessIdentity(host.pid!), hostIdentity);
    console.log('CUSTOMER_DATA_HTTP_RECEIPT ' + JSON.stringify({ exported: true, tenantIsolated: true,
      wildcardRefused: true, revokedConsentRefused: true, revokedSessionRefused: true,
      auditReceipts: receipts.length, hostStopped: true, bundleSha256 }));
  } finally {
    try { if (host) await stopPrivateOperatorHost(host); }
    finally { await sql.end({ timeout: 1 }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

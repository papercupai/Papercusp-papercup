/** P-010: internal support HTTP uses persisted cookies and real service RLS. */
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';

// Redirect only the database acquisition seam. Cookie parsing, persisted
// session validation, route authorization and the support service remain real.
const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'control' }));
vi.mock('./telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../coverage-census/attribution/sink', () => ({ recordHttpTraffic: vi.fn() }));

import { createCustomerDataSupportRoutes } from './routes/admin/customer-data';
import { registerRoute } from './define-route';
import { principalFromCookie } from '../auth/principal/from-cookie';
import { CUSTOMER_DATA_EXPORT_SCOPE, PostgresHostedCustomerDataSupport } from '../data-governance/hosted-customer-data-support';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  // Draft schema is exercised only in this disposable database; promotion
  // remains gated independently by the migration approval process.
  for (const name of ['1509-hosted-customer-data-workspace-export', '1513-hosted-customer-deletion-freeze']) {
    const url = new URL(`../../../../libs/papercusp/libs/db/sql/${name}.sql`, import.meta.url);
    await db.adminSql.unsafe(readFileSync(existsSync(url) ? url : new URL(`${url.href}.DRAFT`), 'utf8'));
  }
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

it('exports support data over private HTTP only with a persisted scoped staff cookie and current customer consent', async () => {
  const organizationId = randomUUID(), foreignOrg = randomUUID(), userId = randomUUID(), foreignUser = randomUUID();
  const grantId = randomUUID(), token = randomUUID(), wildcardToken = randomUUID();
  const [staff] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`support-http-${randomUUID()}`}, 'Private support fixture') RETURNING id`;
  const staffId = staff!.id;
  for (const [id, tenant] of [[userId, organizationId], [foreignUser, foreignOrg]]) {
    await db.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name, status)
      VALUES (${tenant}::uuid, ${`http-${tenant}`}, 'Private support tenant', 'active')`;
    await db.adminSql`INSERT INTO papercusp_auth.hosted_users (id, primary_email, status)
      VALUES (${id}::uuid, ${`${id}@example.test`}, 'active')`;
    await db.adminSql`INSERT INTO papercusp_auth.organization_memberships (organization_id, user_id, role, created_via)
      VALUES (${tenant}::uuid, ${id}::uuid, 'owner', 'organization_bootstrap')`;
  }
  await db.adminSql`INSERT INTO papercusp_auth.support_access_grants
    (id, organization_id, staff_principal_id, granted_by_user_id, purpose, scopes, banner_message, starts_at, expires_at)
    VALUES (${grantId}::uuid, ${organizationId}::uuid, ${staffId}, ${userId}::uuid, 'Customer requested HTTP export',
      ${[CUSTOMER_DATA_EXPORT_SCOPE]}, 'Private support export', now() - interval '1 minute', now() + interval '1 hour')`;
  for (const [value, scopes] of [[token, [CUSTOMER_DATA_EXPORT_SCOPE]], [wildcardToken, ['*']]] as const) {
    await db.adminSql`INSERT INTO harness_shared.user_sessions (token, user_id, expires_at, workspace_id, capabilities)
      VALUES (${value}, ${staffId}::uuid, now() + interval '1 hour', 'control', ${[...scopes]})`;
  }
  const runService: HostedServiceContextRunner = fn => db.appSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as ReturnType<typeof fn>;
  const recoverCustomerDeletion = vi.fn(async () => { throw new Error('export must not invoke DBOS'); });
  const support = new PostgresHostedCustomerDataSupport({ runService, client: { recoverCustomerDeletion } });
  const staffIds = new Set([staffId]);
  const app = new Hono();
  for (const route of createCustomerDataSupportRoutes({ support, staffPrincipalIds: () => staffIds })) registerRoute(app, route);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('private support HTTP address unavailable');
    const post = (value = token, tenant = organizationId) => fetch(`http://127.0.0.1:${address.port}/admin/customer-data/export`, {
      method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json',
        ...(value ? { cookie: `papercusp_session=${value}` } : {}) },
      body: JSON.stringify({ organizationId: tenant, grantId }),
    });
    const response = await post();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { result: { receiptId: string; stores: { store: string; rows: { id: string }[] }[] } };
    expect(body.result.stores.find(row => row.store === 'papercusp_auth.hosted_users')?.rows.map(row => row.id)).toEqual([userId]);
    expect(JSON.stringify(body)).not.toContain(foreignUser);
    expect(JSON.stringify(body)).not.toContain(foreignOrg);
    expect(await db.adminSql`SELECT actor_kind, actor_id, purpose FROM papercusp_auth.organization_audit_events
      WHERE id = ${body.result.receiptId}::uuid`).toEqual([
      expect.objectContaining({ actor_kind: 'staff_admin', actor_id: staffId, purpose: 'Customer requested HTTP export' }),
    ]);
    expect((await post(token, foreignOrg)).status).toBe(403);
    expect((await post(wildcardToken)).status).toBe(403);
    staffIds.clear();
    expect((await post()).status).toBe(403);
    staffIds.add(staffId);
    await db.adminSql`UPDATE papercusp_auth.support_access_grants SET revoked_at = now(), revoked_by_user_id = ${userId}::uuid,
      revocation_reason = 'Customer revoked HTTP export' WHERE id = ${grantId}::uuid`;
    expect((await post()).status).toBe(403);
    await db.adminSql`DELETE FROM harness_shared.user_sessions WHERE token = ${token}`;
    expect(await principalFromCookie(new Headers({ cookie: `papercusp_session=${token}` }))).toBeNull();
    // The local operator resolves an unverified loopback principal after a
    // cookie miss. The mounted route's verified-trust guard rejects it
    // before the support service can run.
    for (const value of [token, '']) {
      const denied = await post(value);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: {
        code: 'forbidden', message: 'trust unverified-loopback not in allowlist',
      } });
    }
    expect(recoverCustomerDeletion).not.toHaveBeenCalled();
    expect(await db.adminSql`SELECT id FROM papercusp_auth.organization_audit_events
      WHERE organization_id = ${organizationId}::uuid AND action = 'organization.data.export'`).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

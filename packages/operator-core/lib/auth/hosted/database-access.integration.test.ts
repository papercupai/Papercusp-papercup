/** Real Postgres session + durable governance receipts; no mocked SQL. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';
import { DATABASE_SUPPORT_SCOPE, HOSTED_OPS_ROLE, PostgresAuditedDatabaseAccess } from './database-access';

let pg: DedicatedNativePg;
let admin: Sql;
let audit: Sql;
let createdOpsAsNoLogin = false;
let auditedMigrationSql: string;
const clients: Sql[] = [];
const organizationId = randomUUID();
const staffPrincipalId = 'staff:case-p013';
const userId = randomUUID();

function connect(role: string): Sql {
  const url = new URL(pg.getConnectionUri());
  url.pathname = '/papercusp_hosted'; url.username = role; url.password = '';
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  clients.push(sql);
  return sql;
}

const run: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>) =>
  audit.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
const access = new PostgresAuditedDatabaseAccess(run);

async function grant(overrides: { scope?: string; staff?: string; expired?: boolean; revoked?: boolean; workspace?: string } = {}) {
  const id = randomUUID();
  await admin`
    INSERT INTO papercusp_auth.support_access_grants
      (id, organization_id, workspace_id, staff_principal_id, granted_by_user_id, purpose, scopes,
       banner_message, starts_at, expires_at, revoked_at, revoked_by_user_id, revocation_reason)
    VALUES (${id}::uuid, ${organizationId}::uuid, ${overrides.workspace ?? null}::uuid,
      ${overrides.staff ?? staffPrincipalId}, ${userId}::uuid, 'Investigate case P013',
      ${[overrides.scope ?? DATABASE_SUPPORT_SCOPE]}, 'Temporary database support access',
      now() - interval '1 hour', ${overrides.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 60_000)},
      ${overrides.revoked ? new Date() : null}, ${overrides.revoked ? userId : null}::uuid,
      ${overrides.revoked ? 'Case closed' : null})`;
  return { grantId: id, organizationId, staffPrincipalId };
}

async function receipts(grantId: string) {
  return admin<Array<{ action: string; target_id: string; actor_id: string; metadata: Record<string, unknown> }>>`
    SELECT action, target_id, actor_id, metadata FROM papercusp_auth.organization_audit_events
     WHERE metadata->>'grantId' = ${grantId} ORDER BY recorded_at, id`;
}

beforeAll(async () => {
  pg = await startDedicatedNativePg();
  const root = postgres(pg.getConnectionUri(), { onnotice: () => {} }); clients.push(root);
  await root.unsafe('CREATE DATABASE papercusp_hosted');
  for (const role of ['harness_app', 'harness_admin']) {
    await root.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  for (const role of ['hosted_app', 'hosted_service', 'hosted_owner', 'harness_zero']) {
    await root.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  await root.unsafe('GRANT hosted_service TO harness_app WITH INHERIT FALSE');
  admin = connect('postgres');
  await admin.unsafe(readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/907-hosted-governance.sql', import.meta.url), 'utf8'));
  await admin.unsafe(`
    CREATE TABLE public.p013_probe (marker text PRIMARY KEY);
    INSERT INTO public.p013_probe VALUES ('visible');
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.customer_workspaces (id uuid PRIMARY KEY, organization_id uuid, marker text);
    GRANT USAGE ON SCHEMA papercusp_auth, harness_shared TO hosted_owner, hosted_service;
    ALTER TABLE papercusp_auth.support_access_grants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE papercusp_auth.support_access_grants FORCE ROW LEVEL SECURITY;
  `);
  await admin`INSERT INTO harness_shared.customer_workspaces VALUES (${randomUUID()}::uuid, ${organizationId}::uuid, 'visible')`;
  await admin.unsafe(readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/1473-hosted-directory-binding-audit.sql', import.meta.url), 'utf8'));
  const exportMigration = new URL('../../../../../libs/papercusp/libs/db/sql/1509-hosted-customer-data-workspace-export.sql', import.meta.url);
  await admin.unsafe(readFileSync(existsSync(exportMigration) ? exportMigration : new URL(`${exportMigration.href}.DRAFT`), 'utf8'));
  const auditedMigration = new URL('../../../../../libs/papercusp/libs/db/sql/1511-hosted-audited-database-reads.sql', import.meta.url);
  auditedMigrationSql = readFileSync(existsSync(auditedMigration) ? auditedMigration : new URL(`${auditedMigration.href}.DRAFT`), 'utf8');
  await admin.unsafe(auditedMigrationSql);
  const [opsRole] = await admin`SELECT rolcanlogin FROM pg_roles WHERE rolname = ${HOSTED_OPS_ROLE}`;
  createdOpsAsNoLogin = opsRole.rolcanlogin === false;
  // Only this isolated fixture activates the login; production provisioning
  // and Secret Manager/IAM admission are a separate release step.
  await admin.unsafe(`ALTER ROLE ${HOSTED_OPS_ROLE} LOGIN`);
  audit = connect('harness_app');
}, 120_000);

afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end({ timeout: 5 })));
  await pg?.stop();
});

describe('audited break-glass database sessions', () => {
  it('creates ops without login and reapplying the migration preserves its limited grants', async () => {
    expect(createdOpsAsNoLogin).toBe(true);
    await admin.unsafe(auditedMigrationSql);
    const [role] = await admin`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = ${HOSTED_OPS_ROLE}`;
    expect(role).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
  });
  it('uses the existing scoped reader without granting the service direct consent access', async () => {
    await expect(run((sql) => sql`SELECT id FROM papercusp_auth.support_access_grants`)).rejects.toThrow(/permission denied/);
    await expect(run((sql) => sql`SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
      'papercusp_auth.support_access_grants', ${organizationId})`)).rejects.toThrow(/scope is invalid/);
  });
  it('commits an open receipt before exposing a real read-only session and closes it afterwards', async () => {
    const input = await grant();
    const result = await access.withSession(input, async () => connect(HOSTED_OPS_ROLE), async (tx, sessionId) => {
      const events = await receipts(input.grantId);
      expect(events.map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.opened']);
      expect(await access.readCustomerRows(tx, input, sessionId, 'harness_shared.customer_workspaces'))
        .toEqual([expect.objectContaining({ marker: 'visible' })]);
      const [mode] = await tx`SHOW transaction_read_only`;
      expect(mode.transaction_read_only).toBe('on');
      return 'observed';
    });
    expect(result.value).toBe('observed');
    const events = await receipts(input.grantId);
    expect(events.map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.opened', 'database.break_glass.closed']);
    expect(events.every((e) => e.target_id === result.sessionId && e.actor_id === staffPrincipalId)).toBe(true);
    expect(events[2].metadata).toMatchObject({ opened: true, outcome: 'succeeded', role: HOSTED_OPS_ROLE });
    await expect(admin`DELETE FROM papercusp_auth.organization_audit_events WHERE target_id = ${result.sessionId}`).rejects.toThrow(/append-only/);
  });

  it.each([
    { expired: true }, { revoked: true }, { staff: 'staff:someone-else' },
    { scope: 'workspace:read' }, { workspace: randomUUID() },
  ])('refuses inactive, wrong-principal, wrong-scope or workspace-only consent: %j', async (overrides) => {
    const input = await grant(overrides);
    let connected = false;
    await expect(access.withSession(input, async () => { connected = true; return connect(HOSTED_OPS_ROLE); }, async () => null))
      .rejects.toThrow('database_access_grant_inactive');
    expect(connected).toBe(false);
    expect(await receipts(input.grantId)).toEqual([]);
  });

  it('checks organization binding without opening a connection', async () => {
    const input = await grant(); let connected = false;
    await expect(access.withSession({ ...input, organizationId: randomUUID() }, async () => {
      connected = true; return connect(HOSTED_OPS_ROLE);
    }, async () => null)).rejects.toThrow('database_access_grant_inactive');
    expect(connected).toBe(false);
  });

  it('records close after a failed read-only transaction without storing SQL or error text', async () => {
    const input = await grant();
    await expect(access.withSession(input, async () => connect(HOSTED_OPS_ROLE), async (tx) => {
      await tx`INSERT INTO p013_probe VALUES ('customer-sensitive-value')`;
    })).rejects.toThrow(/read-only/);
    const events = await receipts(input.grantId);
    expect(events.map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.opened', 'database.break_glass.closed']);
    expect(events[2].metadata).toMatchObject({ opened: true, outcome: 'failed' });
    expect(JSON.stringify(events)).not.toContain('customer-sensitive-value');
  });

  it('refuses a privileged connection before the callback and records its closure', async () => {
    const input = await grant(); let used = false;
    await expect(access.withSession(input, async () => connect('postgres'), async () => { used = true; }))
      .rejects.toThrow('database_access_ops_identity_required');
    expect(used).toBe(false);
    expect((await receipts(input.grantId)).map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.closed']);
  });

  it('rechecks revocation after connection acquisition', async () => {
    const input = await grant(); let used = false;
    await expect(access.withSession(input, async () => {
      await admin`UPDATE papercusp_auth.support_access_grants SET revoked_at = now(), revoked_by_user_id = ${userId}::uuid,
        revocation_reason = 'Withdrawn', updated_at = now() WHERE id = ${input.grantId}::uuid`;
      return connect(HOSTED_OPS_ROLE);
    }, async () => { used = true; })).rejects.toThrow('database_access_grant_inactive');
    expect(used).toBe(false);
    expect((await receipts(input.grantId)).map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.closed']);
  });

  it('never opens a connection when the initial audit insert fails', async () => {
    const input = await grant(); let connected = false;
    await admin.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
    try {
      await expect(access.withSession(input, async () => { connected = true; return connect(HOSTED_OPS_ROLE); }, async () => null))
        .rejects.toThrow(/permission denied/);
      expect(connected).toBe(false);
    } finally {
      await admin.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service');
    }
  });

  it('reports failed acquisition as a failed, unopened session', async () => {
    const input = await grant();
    await expect(access.withSession(input, async () => { throw new Error('connection unavailable'); }, async () => null))
      .rejects.toThrow('connection unavailable');
    expect((await receipts(input.grantId)).at(-1)?.metadata).toMatchObject({ opened: false, outcome: 'failed' });
  });

  it('fails closed if the open receipt cannot commit, and never exposes the session', async () => {
    const input = await grant(); let used = false;
    try {
      await expect(access.withSession(input, async () => {
        await admin.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
        return connect(HOSTED_OPS_ROLE);
      }, async () => { used = true; })).rejects.toThrow('database_access_session_failed');
      expect(used).toBe(false);
      expect((await receipts(input.grantId)).map((e) => e.action)).toEqual(['database.break_glass.requested']);
    } finally {
      await admin.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service');
    }
  });

  it('does not report success when the close receipt cannot commit', async () => {
    const input = await grant();
    try {
      await expect(access.withSession(input, async () => connect(HOSTED_OPS_ROLE), async () => {
        await admin.unsafe('REVOKE INSERT ON papercusp_auth.organization_audit_events FROM hosted_service');
        return 'read completed';
      })).rejects.toThrow(/permission denied/);
      expect((await receipts(input.grantId)).map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.opened']);
    } finally {
      await admin.unsafe('GRANT INSERT ON papercusp_auth.organization_audit_events TO hosted_service');
    }
  });

  it('refuses a direct ops connection with no matching audit receipt', async () => {
    const input = await grant(); const ops = connect(HOSTED_OPS_ROLE);
    await expect(ops.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true),
                      set_config('app.organization_id', ${organizationId}, true)`;
      return access.readCustomerRows(tx as unknown as Sql, input, randomUUID(), 'harness_shared.customer_workspaces');
    })).rejects.toThrow(/no matching open receipt/);
    await expect(ops`SELECT * FROM harness_shared.customer_workspaces`).rejects.toThrow(/permission denied/);
  });

  it('rejects replay of a valid receipt on another connection and after closure', async () => {
    const input = await grant();
    const result = await access.withSession(input, async () => connect(HOSTED_OPS_ROLE), async (_tx, sessionId) => {
      const other = connect(HOSTED_OPS_ROLE);
      await expect(other.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true),
                        set_config('app.organization_id', ${organizationId}, true)`;
        return access.readCustomerRows(tx as unknown as Sql, input, sessionId, 'harness_shared.customer_workspaces');
      })).rejects.toThrow(/no matching open receipt/);
      return null;
    });
    const other = connect(HOSTED_OPS_ROLE);
    await expect(other.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true),
                      set_config('app.organization_id', ${organizationId}, true)`;
      return access.readCustomerRows(tx as unknown as Sql, input, result.sessionId, 'harness_shared.customer_workspaces');
    })).rejects.toThrow(/no matching open receipt/);
  });

  it('enforces a revocation made after the session opened at the next data read', async () => {
    const input = await grant();
    await expect(access.withSession(input, async () => connect(HOSTED_OPS_ROLE), async (tx, sessionId) => {
      await admin`UPDATE papercusp_auth.support_access_grants SET revoked_at = now(), revoked_by_user_id = ${userId}::uuid,
        revocation_reason = 'Withdrawn after open', updated_at = now() WHERE id = ${input.grantId}::uuid`;
      return access.readCustomerRows(tx, input, sessionId, 'harness_shared.customer_workspaces');
    })).rejects.toThrow(/consent is inactive/);
    expect((await receipts(input.grantId)).at(-1)?.metadata).toMatchObject({ opened: true, outcome: 'failed' });
  });
});

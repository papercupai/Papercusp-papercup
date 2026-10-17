/** Real Postgres session + durable governance receipts; no mocked SQL. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';
import { DATABASE_SUPPORT_SCOPE, HOSTED_OPS_ROLE, PostgresAuditedDatabaseAccess } from './database-access';

let pg: DedicatedNativePg;
let admin: Sql;
let audit: Sql;
let createdOpsAsNoLogin = false;
let auditedMigrationSql: string;
const clients: Sql[] = [];
const GCP_SECRET_REF_PREFIX = ['gcp', 'secret'].join('-') + ':';
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

async function grant(overrides: { organization?: string; scope?: string; staff?: string; expired?: boolean; revoked?: boolean; workspace?: string } = {}) {
  const id = randomUUID();
  const org = overrides.organization ?? organizationId;
  await admin`
    INSERT INTO papercusp_auth.support_access_grants
      (id, organization_id, workspace_id, staff_principal_id, granted_by_user_id, purpose, scopes,
       banner_message, starts_at, expires_at, revoked_at, revoked_by_user_id, revocation_reason)
    VALUES (${id}::uuid, ${org}::uuid, ${overrides.workspace ?? null}::uuid,
      ${overrides.staff ?? staffPrincipalId}, ${userId}::uuid, 'Investigate case P013',
      ${[overrides.scope ?? DATABASE_SUPPORT_SCOPE]}, 'Temporary database support access',
      now() - interval '1 hour', ${overrides.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 60_000)},
      ${overrides.revoked ? new Date() : null}, ${overrides.revoked ? userId : null}::uuid,
      ${overrides.revoked ? 'Case closed' : null})`;
  return { grantId: id, organizationId: org, staffPrincipalId };
}

async function independentOrganization(): Promise<string> {
  const id = randomUUID();
  await admin`INSERT INTO papercusp_auth.organizations
    (id, identity_provider, external_organization_id, display_name)
    VALUES (${id}::uuid, 'fixture', ${`p013-${id}`}, 'P013 freeze fixture')`;
  return id;
}

async function freezeReceipt(org: string): Promise<void> {
  // Exact P010 immutable tombstone shape; no production deletion or purge.
  await admin`INSERT INTO papercusp_auth.organization_audit_events
    (organization_id, actor_kind, actor_id, action, purpose, target_type, target_id, metadata)
    VALUES (${org}::uuid, 'system', 'customer-deletion', 'organization.data.deletion.access-frozen',
      'Freeze fixture', 'organization', ${org},
      ${JSON.stringify({ snapshot: { request: { target: { kind: 'organization' } }, users: [] } })}::text::jsonb)`;
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
  await admin.unsafe(readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/903-customer-organization-boundary.sql', import.meta.url), 'utf8'));
  await admin.unsafe(readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/907-hosted-governance.sql', import.meta.url), 'utf8'));
  await admin.unsafe(`
    CREATE TABLE public.p013_probe (marker text PRIMARY KEY);
    INSERT INTO public.p013_probe VALUES ('visible');
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.customer_workspaces (id uuid PRIMARY KEY, organization_id uuid, marker text);
    GRANT USAGE ON SCHEMA papercusp_auth, harness_shared TO hosted_owner, hosted_service;
    ALTER TABLE papercusp_auth.support_access_grants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE papercusp_auth.support_access_grants FORCE ROW LEVEL SECURITY;
    GRANT SELECT ON papercusp_auth.organizations TO hosted_service, hosted_owner;
    ALTER TABLE papercusp_auth.organizations OWNER TO hosted_owner;
    ALTER TABLE papercusp_auth.organizations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE papercusp_auth.organizations FORCE ROW LEVEL SECURITY;
    CREATE POLICY organizations_service_select ON papercusp_auth.organizations
      FOR SELECT TO hosted_service USING (true);
  `);
  await admin`INSERT INTO papercusp_auth.organizations
    (id, identity_provider, external_organization_id, display_name, status)
    VALUES (${organizationId}::uuid, 'fixture', ${`p013-${organizationId}`}, 'P013 fixture', 'active')`;
  await admin`INSERT INTO harness_shared.customer_workspaces VALUES (${randomUUID()}::uuid, ${organizationId}::uuid, 'visible')`;
  await admin.unsafe(readFileSync(new URL('../../../../../libs/papercusp/libs/db/sql/1473-hosted-directory-binding-audit.sql', import.meta.url), 'utf8'));
  const exportMigration = new URL('../../../../../libs/papercusp/libs/db/sql/1509-hosted-customer-data-workspace-export.sql', import.meta.url);
  await admin.unsafe(readFileSync(existsSync(exportMigration) ? exportMigration : new URL(`${exportMigration.href}.DRAFT`), 'utf8'));
  const auditedMigration = new URL('../../../../../libs/papercusp/libs/db/sql/1511-hosted-audited-database-reads.sql', import.meta.url);
  auditedMigrationSql = readFileSync(existsSync(auditedMigration) ? auditedMigration : new URL(`${auditedMigration.href}.DRAFT`), 'utf8');
  await admin.unsafe(auditedMigrationSql);
  // Load the EXACT maintained P010 predicate and its ACL, without the
  // unrelated activation triggers (covered by P010's full-schema suite).
  const freezeMigration = new URL('../../../../../libs/papercusp/libs/db/sql/1513-hosted-customer-deletion-freeze.sql', import.meta.url);
  const freezeSql = readFileSync(existsSync(freezeMigration) ? freezeMigration : new URL(`${freezeMigration.href}.DRAFT`), 'utf8');
  const predicate = freezeSql.split('CREATE OR REPLACE FUNCTION papercusp_auth.enforce_hosted_customer_deletion_freeze()');
  if (predicate.length !== 2) throw new Error('P010 freeze predicate fixture boundary changed');
  await admin.unsafe(predicate[0]);
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

  it('refuses a pre-existing support grant once organization deletion/offboarding freezes access', async () => {
    const input = await grant(); let connected = false;
    await admin`UPDATE papercusp_auth.organizations
      SET status = 'offboarding', offboarding_at = now(), updated_at = now()
      WHERE id = ${organizationId}::uuid`;
    try {
      await expect(access.withSession(input, async () => {
        connected = true;
        return connect(HOSTED_OPS_ROLE);
      }, async () => null)).rejects.toThrow('database_access_organization_inactive');
      expect(connected).toBe(false);
      expect(await receipts(input.grantId)).toEqual([]);
    } finally {
      await admin`UPDATE papercusp_auth.organizations
        SET status = 'active', offboarding_at = NULL, updated_at = now()
        WHERE id = ${organizationId}::uuid`;
    }
  });

  it('keeps support access frozen when organization status still reads active', async () => {
    const org = await independentOrganization();
    const input = await grant({ organization: org }); let connected = false;
    await freezeReceipt(org);
    await expect(access.withSession(input, async () => {
      connected = true; return connect(HOSTED_OPS_ROLE);
    }, async () => null)).rejects.toThrow('database_access_organization_inactive');
    expect(connected).toBe(false);
    expect(await receipts(input.grantId)).toEqual([]);
  });

  it('rechecks organization lifecycle after acquiring the connection', async () => {
    const org = await independentOrganization();
    const input = await grant({ organization: org }); let used = false;
    await expect(access.withSession(input, async () => {
      await admin`UPDATE papercusp_auth.organizations SET status = 'offboarding', offboarding_at = now()
        WHERE id = ${org}::uuid`;
      return connect(HOSTED_OPS_ROLE);
    }, async () => { used = true; })).rejects.toThrow('database_access_organization_inactive');
    expect(used).toBe(false);
    expect((await receipts(input.grantId)).map(e => e.action))
      .toEqual(['database.break_glass.requested', 'database.break_glass.closed']);
  });

  it.each(['offboarding', 'freeze-receipt'] as const)(
    'blocks the next SQL read when an opened session is frozen: %s', async (freeze) => {
      const org = await independentOrganization();
      const input = await grant({ organization: org });
      await expect(access.withSession(input, async () => connect(HOSTED_OPS_ROLE), async (tx, sessionId) => {
        expect(await access.readCustomerRows(tx, input, sessionId, 'harness_shared.customer_workspaces')).toEqual([]);
        if (freeze === 'offboarding') {
          await admin`UPDATE papercusp_auth.organizations SET status = 'offboarding', offboarding_at = now()
            WHERE id = ${org}::uuid`;
        } else {
          await freezeReceipt(org);
        }
        return access.readCustomerRows(tx, input, sessionId, 'harness_shared.customer_workspaces');
      })).rejects.toThrow(/organization is inactive/);
      expect((await receipts(input.grantId)).at(-1)?.metadata).toMatchObject({ opened: true, outcome: 'failed' });
    },
  );

  it('installs and reapplies the draft guard as the non-superuser production migration role', async () => {
    // Isolated fixture only: model D-010's schema owner and inherited role
    // membership. Production provisions harness_ops before migrations run.
    await admin.unsafe(`
      ALTER ROLE harness_admin CREATEROLE;
      ALTER ROLE harness_admin SET createrole_self_grant = 'set, inherit';
      ALTER SCHEMA papercusp_auth OWNER TO harness_admin;
      GRANT USAGE, CREATE ON SCHEMA papercusp_auth TO hosted_owner;
      GRANT hosted_owner TO harness_admin WITH INHERIT TRUE, SET TRUE;
    `);
    const migrator = connect('harness_admin');
    const [identity] = await migrator`
      SELECT rolsuper, rolcreaterole, rolbypassrls, current_setting('createrole_self_grant') AS self_grant
        FROM pg_roles WHERE rolname = current_user`;
    expect(identity).toEqual({ rolsuper: false, rolcreaterole: true, rolbypassrls: false, self_grant: 'set, inherit' });
    // Prove creation as well as replacement; superuser creation would conceal
    // missing schema CREATE/role membership on the owner-transfer path.
    await migrator.unsafe('DROP FUNCTION papercusp_auth.read_hosted_customer_export_rows_audited(text, text, uuid, text, uuid)');
    await migrator.unsafe(auditedMigrationSql);
    await migrator.unsafe(auditedMigrationSql);
    const [guard] = await admin`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef,
             has_function_privilege('harness_ops', oid, 'EXECUTE') AS ops_execute,
             has_function_privilege('hosted_service', oid, 'EXECUTE') AS service_execute
        FROM pg_proc WHERE oid = 'papercusp_auth.read_hosted_customer_export_rows_audited(text,text,uuid,text,uuid)'::regprocedure`;
    expect(guard).toEqual({ owner: 'hosted_owner', prosecdef: true, ops_execute: true, service_execute: false });
    const input = await grant();
    const result = await access.withSession(input, async () => connect(HOSTED_OPS_ROLE), (tx, sessionId) =>
      access.readCustomerRows(tx, input, sessionId, 'harness_shared.customer_workspaces'));
    expect(result.value).toEqual([expect.objectContaining({ marker: 'visible' })]);
    expect((await receipts(input.grantId)).map((event) => event.action))
      .toEqual(['database.break_glass.requested', 'database.break_glass.opened', 'database.break_glass.closed']);
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

  const managedReference = `${GCP_SECRET_REF_PREFIX}projects/123456789/locations/us-central1/secrets/test-cloudsql-harness-ops-url/versions/1`;
  const managedConfig = { urlReference: managedReference, expectedHost: '10.20.30.40' };
  const managedUrl = 'postgresql://harness_ops:fixture-secret@10.20.30.40:5432/papercusp_hosted?sslmode=require';
  const staff = (overrides: Partial<Principal> = {}): Principal => ({
    kind: 'user', slug: staffPrincipalId, workspaceId: 'hosted-control-plane-service',
    trust: 'verified', authMethod: 'cookie-session', roles: new Set(['staff']),
    capabilities: new Set([DATABASE_SUPPORT_SCOPE]), ...overrides,
  });

  it('derives the consent/audit actor from staff authentication and opens a dedicated managed connection', async () => {
    const input = await grant();
    let resolved = false; let connected = false;
    const managed = new PostgresAuditedDatabaseAccess(run, {
      resolveSecret: async (reference) => {
        resolved = true;
        expect(reference).toBe(managedReference);
        expect((await receipts(input.grantId)).map((e) => e.action)).toEqual(['database.break_glass.requested']);
        return managedUrl;
      },
      connect: (url, options) => {
        connected = true;
        expect(url).toBe(managedUrl);
        expect(options).toEqual({ max: 1, ssl: 'require', connect_timeout: 10 });
        // Only this isolated fixture replaces TLS/network with native PG.
        return connect(HOSTED_OPS_ROLE);
      },
    });
    const result = await managed.readManagedCustomerRows(staff(), {
      ...input, staffPrincipalId: 'staff:forged-request-actor', store: 'harness_shared.customer_workspaces',
    } as typeof input & { store: string }, managedConfig);
    expect(resolved && connected).toBe(true);
    expect(result.value).toEqual([expect.objectContaining({ marker: 'visible' })]);
    const events = await receipts(input.grantId);
    expect(events.map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.opened', 'database.break_glass.closed']);
    expect(events.every((e) => e.actor_id === staffPrincipalId && e.target_id === result.sessionId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
  });

  it.each([
    { roles: undefined }, { roles: new Set(['admin']) }, { capabilities: new Set(['*']) },
    { trust: 'unverified-loopback' as const }, { kind: 'system' as const, trust: 'trusted' as const },
    { authMethod: 'jwt' as const }, { slug: '' },
  ])('rejects missing staff admission or transport authentication before secret/DB access: %j', async (overrides) => {
    const input = await grant(); let resolved = false;
    const managed = new PostgresAuditedDatabaseAccess(run, {
      resolveSecret: async () => { resolved = true; throw new Error('must not resolve'); },
    });
    await expect(managed.readManagedCustomerRows(staff(overrides), {
      ...input, store: 'harness_shared.customer_workspaces',
    }, managedConfig)).rejects.toThrow('database_access_staff_identity_required');
    expect(resolved).toBe(false);
    expect(await receipts(input.grantId)).toEqual([]);
  });

  it('rejects staff impersonation and wrong-organization consent before secret resolution', async () => {
    const input = await grant(); let resolved = false;
    const managed = new PostgresAuditedDatabaseAccess(run, {
      resolveSecret: async () => { resolved = true; return managedUrl; },
    });
    for (const [principal, organization] of [[staff({ slug: 'staff:someone-else' }), organizationId], [staff(), randomUUID()]] as const) {
      await expect(managed.readManagedCustomerRows(principal, {
        grantId: input.grantId, organizationId: organization, store: 'harness_shared.customer_workspaces',
      }, managedConfig)).rejects.toThrow('database_access_managed_read_failed');
    }
    expect(resolved).toBe(false);
    expect(await receipts(input.grantId)).toEqual([]);
  });

  it.each(['env:OPS_URL', 'file:/tmp/ops-url', managedReference.replace('/versions/1', '/versions/latest')])(
    'rejects local or floating connection references before an audit request: %s', async (urlReference) => {
      const input = await grant(); let resolved = false;
      const managed = new PostgresAuditedDatabaseAccess(run, {
        resolveSecret: async () => { resolved = true; return managedUrl; },
      });
      await expect(managed.readManagedCustomerRows(staff(), {
        ...input, store: 'harness_shared.customer_workspaces',
      }, { ...managedConfig, urlReference })).rejects.toThrow('database_access_managed_config_invalid');
      expect(resolved).toBe(false);
      expect(await receipts(input.grantId)).toEqual([]);
    },
  );

  it.each([
    managedUrl.replace('harness_ops', 'harness_admin'), managedUrl.replace('papercusp_hosted', 'portal'),
    managedUrl.replace('10.20.30.40', '10.20.30.41'), managedUrl.replace('sslmode=require', 'sslmode=disable'),
    managedUrl + '&options=-c%20role%3Dharness_admin', managedUrl + '&sslmode=disable',
  ])('rejects credential target/TLS/options drift without opening a DB connection: %s', async (url) => {
    const input = await grant(); let connected = false;
    const managed = new PostgresAuditedDatabaseAccess(run, {
      resolveSecret: async () => url,
      connect: () => { connected = true; return connect(HOSTED_OPS_ROLE); },
    });
    await expect(managed.readManagedCustomerRows(staff(), {
      ...input, store: 'harness_shared.customer_workspaces',
    }, managedConfig)).rejects.toThrow('database_access_managed_read_failed');
    expect(connected).toBe(false);
    const events = await receipts(input.grantId);
    expect(events.map((e) => e.action)).toEqual(['database.break_glass.requested', 'database.break_glass.closed']);
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
  });

  it('preserves the SQL store allowlist and redacts a provider failure while recording closure', async () => {
    const input = await grant();
    const managed = new PostgresAuditedDatabaseAccess(run, {
      resolveSecret: async () => managedUrl, connect: () => connect(HOSTED_OPS_ROLE),
    });
    await expect(managed.readManagedCustomerRows(staff(), { ...input, store: 'public.p013_probe' }, managedConfig))
      .rejects.toThrow('database_access_managed_read_failed');
    expect((await receipts(input.grantId)).at(-1)?.metadata).toMatchObject({ opened: true, outcome: 'failed' });
    const failedInput = await grant();
    const broken = new PostgresAuditedDatabaseAccess(run, {
      resolveSecret: async () => { throw new Error(managedUrl); },
    });
    await expect(broken.readManagedCustomerRows(staff(), {
      ...failedInput, store: 'harness_shared.customer_workspaces',
    }, managedConfig)).rejects.toThrow(/^database_access_managed_read_failed$/);
    const events = await receipts(failedInput.grantId);
    expect(events.at(-1)?.metadata).toMatchObject({ opened: false, outcome: 'failed' });
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
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
    }, async () => null)).rejects.toThrow('database_access_organization_inactive');
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

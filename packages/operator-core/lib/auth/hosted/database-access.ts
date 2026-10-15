/** Internal break-glass session lifecycle (cloud release P-013).
 *
 * The caller authenticates the staff identity and supplies a DEDICATED ops
 * connection. Customer consent remains in support_access_grants; receipts stay
 * in organization_audit_events. This is not a public SQL endpoint or an IAM
 * grant. Production role provisioning/admission must use this boundary too.
 */
import { randomUUID } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Principal } from '@papercusp/agent-mcp';
import postgres, { type Sql } from 'postgres';
import { assertPinnedGcpSecretReference, createSecretRefResolver } from '../../inference-gateway/egress-providers/secret-ref';
import { appendOrganizationAuditEvent } from './governance';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';

export const HOSTED_OPS_ROLE = 'harness_ops';
export const DATABASE_SUPPORT_SCOPE = 'database:read';

export interface AuditedDatabaseSessionInput {
  organizationId: string;
  grantId: string;
  /** Authenticated by the internal entry point, never a customer-supplied id. */
  staffPrincipalId: string;
}

export interface AuditedDatabaseSessionResult<T> {
  sessionId: string;
  value: T;
}

/** Server-owned configuration, never fields accepted from a customer request. */
export interface ManagedDatabaseAccessConfig {
  /** Pinned Secret Manager version returned by readHostedOpsUrlReference. */
  urlReference: string;
  /** Exact private database host from the admitted production instance. */
  expectedHost: string;
}

export interface ManagedDatabaseAccessDependencies {
  resolveSecret?: (reference: string) => Promise<string>;
  connect?: (url: string, options: { max: 1; ssl: 'require' | 'verify-full'; connect_timeout: number }) => Sql;
}

export class PostgresAuditedDatabaseAccess {
  constructor(
    private readonly run: HostedServiceContextRunner = withHostedServiceContext,
    private readonly managed: ManagedDatabaseAccessDependencies = {},
  ) {}

  /**
   * Internal managed-secret consumer: no SQL, connection URL or staff id is
   * accepted from the request. The host must supply a transport-authenticated
   * principal with explicit staff admission; a cookie alone is insufficient.
   * Customer consent and the SQL reader's store allowlist still apply.
   * This does not grant a staff role, install a route, or admit production IAM.
   */
  async readManagedCustomerRows(
    principal: Principal | null,
    input: Pick<AuditedDatabaseSessionInput, 'organizationId' | 'grantId'> & { store: string },
    config: ManagedDatabaseAccessConfig,
  ): Promise<AuditedDatabaseSessionResult<Record<string, unknown>[]>> {
    if (!principal || principal.kind !== 'user' || principal.trust !== 'verified' ||
        principal.authMethod !== 'cookie-session' || !principal.slug.trim() ||
        !principal.roles?.has('staff') || !principal.capabilities.has(DATABASE_SUPPORT_SCOPE)) {
      throw new Error('database_access_staff_identity_required');
    }
    // Snapshot the authenticated identity/config before awaiting any work.
    const sessionInput: AuditedDatabaseSessionInput = {
      organizationId: input.organizationId, grantId: input.grantId, staffPrincipalId: principal.slug,
    };
    const { store } = input;
    const { urlReference, expectedHost } = config;
    try {
      assertPinnedGcpSecretReference(urlReference);
      if (!expectedHost.trim()) throw new Error('host_required');
    } catch {
      throw new Error('database_access_managed_config_invalid');
    }
    // Force the existing resolver's attached-VM identity path (D-011); never
    // fall through to a dev-box ADC login or private key for production ops.
    const resolve = this.managed.resolveSecret ?? createSecretRefResolver({
      env: { ...process.env, PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production' },
    });
    try {
      return await this.withSession(sessionInput, async () => {
        // withSession commits consent + request receipt BEFORE accessing the
        // secret. No credential read is attempted for unauthorized consent.
        const value = await resolve(urlReference);
        const url = new URL(value);
        const ssl = url.searchParams.get('sslmode');
        if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
            url.username !== HOSTED_OPS_ROLE || !url.password ||
            url.hostname !== expectedHost || (url.port && url.port !== '5432') ||
            url.pathname !== '/papercusp_hosted' || url.hash ||
            (ssl !== 'require' && ssl !== 'verify-full') ||
            [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
            url.searchParams.getAll('sslmode').length !== 1) {
          throw new Error('ops_url_invalid');
        }
        // A dedicated single-connection client, never the ambient app/admin
        // pool. The lifecycle additionally verifies the actual DB/role.
        const options: { max: 1; ssl: 'require' | 'verify-full'; connect_timeout: number } = {
          max: 1, ssl, connect_timeout: 10,
        };
        return this.managed.connect ? this.managed.connect(value, options) : postgres(value, options);
      }, (tx, sessionId) => this.readCustomerRows(tx, sessionInput, sessionId, store));
    } catch {
      // URL parsing, drivers, and providers can embed the secret or SQL in an
      // exception. Expose a fixed code without retaining a credential-bearing cause.
      throw new Error('database_access_managed_read_failed');
    }
  }

  async withSession<T>(
    input: AuditedDatabaseSessionInput,
    connect: () => Promise<Sql>,
    use: (transaction: Sql, sessionId: string) => Promise<T>,
  ): Promise<AuditedDatabaseSessionResult<T>> {
    const sessionId = randomUUID();
    // The request receipt commits before any connection is opened. A failed
    // audit write therefore cannot accidentally grant unaudited access.
    const grant = await this.run(async (sql) => {
      const row = await this.activeGrant(sql, input);
      await this.receipt(sql, input, sessionId, row.purpose, 'requested');
      return row;
    });

    let connection: Sql | undefined;
    let value!: T;
    const failures: unknown[] = [];
    let opened = false;
    let disconnected = false;
    try {
      connection = await connect();
      value = await connection.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION READ ONLY');
        const [identity] = await tx<Array<{
          role: string; database: string; privileged: boolean; memberships: boolean;
          backend_pid: number; transaction_started_at: string; server_started_at: string;
        }>>`
          SELECT session_user::text AS role, current_database() AS database,
                 (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS privileged,
                 EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) AS memberships,
                 pg_backend_pid() AS backend_pid,
                 extract(epoch FROM transaction_timestamp())::text AS transaction_started_at,
                 extract(epoch FROM pg_postmaster_start_time())::text AS server_started_at
            FROM pg_roles WHERE rolname = session_user`;
        if (!identity || identity.role !== HOSTED_OPS_ROLE || identity.database !== 'papercusp_hosted' ||
            identity.privileged || identity.memberships) {
          throw new Error('database_access_ops_identity_required');
        }
        // Re-read consent after connecting, and commit the open receipt on the
        // independent audit connection. Query failure/rollback cannot erase it.
        const remainingMs = await this.run(async (sql) => {
          const active = await this.activeGrant(sql, input);
          await this.receipt(sql, input, sessionId, grant.purpose, 'opened', {
            backendPid: identity.backend_pid, transactionStartedAt: identity.transaction_started_at,
            serverStartedAt: identity.server_started_at,
          });
          return Math.min(active.remaining_ms, 900_000);
        });
        opened = true;
        // PG18 production: bound the WHOLE transaction, including idle time,
        // rather than just the duration of each individual statement.
        await tx`SELECT set_config('transaction_timeout', ${String(remainingMs)}, true),
                        set_config('statement_timeout', ${String(remainingMs)}, true),
                        set_config('idle_in_transaction_session_timeout', ${String(remainingMs)}, true),
                        set_config('app.workspace_id', 'hosted-control-plane-service', true),
                        set_config('app.organization_id', ${input.organizationId}, true)`;
        return use(tx as unknown as Sql, sessionId);
      }) as T;
    } catch (error) {
      failures.push(error);
    } finally {
      if (connection) {
        try {
          await connection.end({ timeout: 5 });
          disconnected = true;
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await this.run((sql) => this.receipt(sql, input, sessionId, grant.purpose,
          connection && !disconnected ? 'close_failed' : 'closed', {
            opened, outcome: failures.length ? 'failed' : 'succeeded',
          }));
      } catch (error) {
        failures.push(error);
      }
    }
    // Do not copy SQL, error text, connection URLs or result data into audit
    // metadata. They can contain credentials or customer data.
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'database_access_session_failed');
    return { sessionId, value };
  }

  private async activeGrant(sql: Sql, input: AuditedDatabaseSessionInput) {
    // P010's scoped SECURITY DEFINER bridge already reads consent. Do not give
    // hosted_service ambient SELECT/UPDATE privileges over customer grants.
    await sql`SELECT set_config('app.organization_id', ${input.organizationId}, true)`;
    // Customer deletion/offboarding freezes support access before revoking the
    // grant. Re-check the authoritative organization lifecycle on every
    // request so a grant that was valid before the freeze cannot open a new
    // break-glass session during or after offboarding.
    const [organization] = await sql<Array<{ status: string; frozen: boolean }>>`
      SELECT status, papercusp_auth.hosted_customer_deletion_frozen(id::text, NULL) AS frozen
        FROM papercusp_auth.organizations
       WHERE id = ${input.organizationId}::uuid`;
    if (!organization || organization.status !== 'active' || organization.frozen !== false) {
      throw new Error('database_access_organization_inactive');
    }
    const [grant] = await sql<Array<{ purpose: string; remaining_ms: number }>>`
      SELECT data->>'purpose' AS purpose,
             least(900000, floor(extract(epoch FROM
               ((data->>'expires_at')::timestamptz - clock_timestamp())) * 1000))::int AS remaining_ms
        FROM papercusp_auth.read_hosted_customer_export_rows(
          'papercusp_auth.support_access_grants', ${input.organizationId})
       WHERE (data->>'id')::uuid = ${input.grantId}::uuid
         AND (data->>'organization_id')::uuid = ${input.organizationId}::uuid
         AND data->>'staff_principal_id' = ${input.staffPrincipalId}
         AND data->>'workspace_id' IS NULL
         AND data->'scopes' @> jsonb_build_array(${DATABASE_SUPPORT_SCOPE}::text)
         AND (data->>'starts_at')::timestamptz <= clock_timestamp()
         AND (data->>'expires_at')::timestamptz > clock_timestamp()
         AND data->>'revoked_at' IS NULL`;
    if (!grant || grant.remaining_ms < 1) throw new Error('database_access_grant_inactive');
    return grant;
  }

  /** Customer reads use 1509's allowlist through 1511's audit/consent guard. */
  async readCustomerRows(
    tx: Sql, input: AuditedDatabaseSessionInput, sessionId: string, store: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await tx<Array<{ data: Record<string, unknown> }>>`
      SELECT data FROM papercusp_auth.read_hosted_customer_export_rows_audited(
        ${store}, ${input.organizationId}, ${sessionId}::uuid,
        ${input.staffPrincipalId}, ${input.grantId}::uuid)`;
    return rows.map((row) => row.data);
  }

  private receipt(
    sql: Sql, input: AuditedDatabaseSessionInput, sessionId: string, purpose: string,
    phase: 'requested' | 'opened' | 'closed' | 'close_failed',
    metadata: Record<string, string | number | boolean> = {},
  ): Promise<string> {
    return appendOrganizationAuditEvent({
      organizationId: input.organizationId, actorKind: 'staff_admin', actorId: input.staffPrincipalId,
      action: `database.break_glass.${phase}`, purpose, targetType: 'database_session', targetId: sessionId,
      metadata: { grantId: input.grantId, database: 'papercusp_hosted', role: HOSTED_OPS_ROLE, ...metadata },
    }, sql);
  }
}

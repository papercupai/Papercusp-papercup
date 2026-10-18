/**
 * D-008 / P-030 assembled hosted-system acceptance.
 *
 * The leaf suites prove individual policies and adapters. This suite is the
 * maintained cross-component gate: the production hosted composition runs on a
 * real Postgres database with two deliberately similar tenants, and requests
 * cross the same auth, RLS, browser, connector, relay, and delegation seams the
 * deployed control plane uses.
 */
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { WORKSPACE_HOST_CANARY_TAG_KEYS } from '@papercusp/deployment-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  deriveTenantContext,
  type VerifiedTenantServerContext,
} from '@papercusp/db-org';
import { HOSTED_SESSION_COOKIE, type HostedSession } from '../auth/hosted-session';
import { createHostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import { createHostedCustomerDeletionRequester } from '../data-governance/hosted-customer-data';
import type { HostedCustomerDeletionPolicy, HostedCustomerDeletionRequest } from '../data-governance/hosted-customer-deletion';
import type { OrganizationDataExport } from '../data-governance/organization-data-receipts';
import type { HostedUsageRecord, HostedUsageStatement } from '../auth/hosted/billing/usage-statement';
import { PostgresHostedUsageStore } from '../auth/hosted/billing/usage-store';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { HostedTenantContextRunner } from '../auth/hosted/service-adapters';
import type { SyncEvent } from '../sync-sse';
import { readWorkspaceHostControl } from '../workspace-host/observability-store';
import type {
  HostedDelegationOrganization,
  HostedProviderDelegationAdapter,
} from '../workspace-host/hosted-provider-delegation';
import {
  HOSTED_BROWSER_QUERY_NAME,
  HOSTED_BROWSER_PROVISION_PATH,
  HOSTED_BROWSER_REST_QUERY_PATH,
  HOSTED_BROWSER_SSE_PATH,
  HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH,
  HOSTED_BROWSER_USER_EXPORT_PATH,
  HOSTED_BROWSER_ORGANIZATION_DELETE_PATH,
  HOSTED_BROWSER_USER_DELETE_PATH,
} from './hosted-browser';
import type { AssembledHostedControlPlane } from './hosted-control-plane';
import { createHostedRuntime, type HostedRuntimeDependencies } from './hosted-runtime';
import { createHostedBillingRuntime } from './hosted-billing-runtime';
import {
  HostedWorkspaceSessionBroker,
  type HostedWorkspaceRelaySocket,
} from './hosted-workspace-session';
import {
  authenticateHostedConnectorSocket,
} from './routes/hosted-workspace-connector';
import { createHostedHandler } from '../../../../apps/operator/bin/hosted-handler';

const ORIGIN = 'https://app.papercusp.com';
const CONTROL = 'p030-control-plane';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const HOST_A = 'host-tenant-a';
const HOST_B = 'host-tenant-b';
const CONNECTION_A = 'connection-tenant-a';
const CONNECTION_B = 'connection-tenant-b';

const CONFIGURATION = {
  publicOrigin: ORIGIN,
  controlPlaneWorkspaceId: CONTROL,
  hostedSessionCookieSecretRef: 'test:hosted-cookie',
  workosClientId: 'client_test_p030',
  workosApiKeyRef: 'test:workos-api-key',
  workosCookiePasswordRef: 'test:workos-cookie-password',
  workosWebhookSecretRef: 'test:workos-webhook-secret',
} as const;

async function seedTenants(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES
      (${USER_A}::uuid, 'same@example.test', 'Same display name'),
      (${USER_B}::uuid, 'same+tenant-b@example.test', 'Same display name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organizations
      (id, external_organization_id, display_name)
    VALUES
      (${ORG_A}::uuid, 'workos-org-a', 'Same organization name'),
      (${ORG_B}::uuid, 'workos-org-b', 'Same organization name')
  `;
  await sql`
    INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, status, authority, created_via)
    VALUES
      (${ORG_A}::uuid, ${USER_A}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap'),
      (${ORG_B}::uuid, ${USER_B}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
    VALUES
      (${CONTROL}, ${CONNECTION_A}, 'gcp', 'Same cloud connection', 'delegation://tenant-a/gcp', 'connected'),
      (${CONTROL}, ${CONNECTION_B}, 'gcp', 'Same cloud connection', 'delegation://tenant-b/gcp', 'connected')
  `;
  await sql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region,
       size, image, disk_gib, network, desired_state, observed_state)
    VALUES
      (${CONTROL}, ${HOST_A}, 'Same workspace name', ${CONNECTION_A}, 'gcp', 'project-a',
       'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running'),
      (${CONTROL}, ${HOST_B}, 'Same workspace name', ${CONNECTION_B}, 'gcp', 'project-b',
       'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')
  `;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES
      (${CONTROL}, ${WORKSPACE_A}, ${ORG_A}, ${HOST_A}, 'Same workspace name',
       'active', 'user', ${USER_A}),
      (${CONTROL}, ${WORKSPACE_B}, ${ORG_B}, ${HOST_B}, 'Same workspace name',
       'active', 'user', ${USER_B})
  `;
}

function serviceRunner(sql: Sql): HostedServiceContextRunner {
  return async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      // Match withHostedServiceContext: SECURITY DEFINER export reads require
      // the server-owned workspace marker as well as the service role.
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
}

function tenantRunner(sql: Sql): HostedTenantContextRunner {
  return async <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>): Promise<T> => {
    const tenant = deriveTenantContext(context);
    return sql.begin(async (tx) => {
      await tx`
        SELECT
          set_config('app.user_id', ${tenant.userId}, true),
          set_config('app.organization_id', ${tenant.organizationId}, true),
          set_config('app.workspace_id', ${tenant.workspaceId ?? ''}, true)
      `;
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  };
}

function delegationAdapters(): Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>> {
  const adapter: HostedProviderDelegationAdapter = {
    async verify(record) {
      return {
        identity: `${record.provider}:${record.connectionId}`,
        evidenceRef: `acceptance://${record.workspaceId}/${record.connectionId}/${record.generation}/verified`,
      };
    },
    async revoke(record) {
      return {
        evidenceRef: `acceptance://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked`,
      };
    },
  };
  return { gcp: adapter, aws: adapter, azure: adapter };
}

// Stands in for the organization's GCP identity account (D-397), which production creates
// through the IAM API on first use.
function delegationOrganization(organizationId: string): HostedDelegationOrganization {
  const email = `pco-${organizationId}@papercusp-org-identities.iam.gserviceaccount.com`;
  return {
    organizationId,
    gcpTrustedPrincipal: async () => `serviceAccount:${email}`,
    gcpPapercuspHosting: async () => ({ projectId: 'papercusp-hosting', serviceAccountEmail: email }),
    awsTrustedPrincipal: async () => ({
      principalArn: `arn:aws:iam::999999999999:role/papercusp/orgs/pco-${organizationId}`,
      externalIdRef: `resolver://aws-external-id/${organizationId}`,
    }),
    awsPapercuspHosting: async () => {
      throw new Error('aws_papercusp_hosting_not_exercised_by_this_acceptance');
    },
  };
}

function fakeSecrets(reference: string): Promise<string> {
  const values: Record<string, string> = {
    'test:hosted-cookie': 'p030-hosted-cookie-secret-is-longer-than-thirty-two-bytes',
    'test:workos-api-key': 'sk_test_p030_not_a_real_secret',
    'test:workos-cookie-password': 'p030-workos-cookie-password-is-thirty-two-bytes',
    'test:workos-webhook-secret': 'whsec_p030_not_a_real_secret',
  };
  const value = values[reference];
  if (!value) throw new Error(`unexpected secret reference ${reference}`);
  return Promise.resolve(value);
}

function tenantContext(session: HostedSession): VerifiedTenantServerContext {
  return {
    principal: {
      kind: 'user',
      profile: 'hosted',
      authMethod: 'cookie-session',
      trust: 'verified',
      slug: session.userId,
      workspaceId: CONTROL,
      userId: session.userId,
      activeOrganizationId: session.organizationId,
      selectedWorkspaceId: session.workspaceId ?? undefined,
      sessionId: session.id,
      sessionVersion: session.permissionVersion,
    },
    selectedWorkspace: session.workspaceId
      ? { id: session.workspaceId, organizationId: session.organizationId }
      : undefined,
  };
}

function cookie(plane: AssembledHostedControlPlane, session: HostedSession): string {
  const encoded = plane.components.sessionCookieCodec.encode(session.id);
  return `${HOSTED_SESSION_COOKIE}=${encodeURIComponent(encoded)}`;
}

async function request(
  plane: AssembledHostedControlPlane,
  pathname: string,
  session?: HostedSession,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session) headers.set('cookie', cookie(plane, session));
  return plane.app.request(new Request(new URL(`/api${pathname}`, ORIGIN), { ...init, headers }));
}

async function createSession(
  plane: AssembledHostedControlPlane,
  userId: string,
  organizationId: string,
  workspaceId: string,
  suffix: string,
): Promise<HostedSession> {
  const authority = await plane.components.membershipAuthority.resolveActive({ userId, organizationId });
  if (!authority) throw new Error(`missing acceptance authority for ${suffix}`);
  return plane.components.sessionStore.create({
    userId,
    organizationId,
    workspaceId,
    permissionVersion: authority.permissionVersion,
    upstreamProvider: 'workos',
    upstreamSessionId: `workos-session-${suffix}`,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (let read = 0; read < 8 && !predicate(text); read += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

class FakeSocket extends EventEmitter implements HostedWorkspaceRelaySocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];
  readonly closed: Array<[number | undefined, string | undefined]> = [];

  send(data: string | Buffer): void {
    this.sent.push(JSON.parse(data.toString()));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closed.push([code, reason]);
    this.emit('close');
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

let db: OrgTestDb;
let sql: Sql;
let runService: HostedServiceContextRunner;
let runTenant: HostedTenantContextRunner;
let plane: AssembledHostedControlPlane;
let sessionA: HostedSession;
let sessionB: HostedSession;
const backfillEvents: SyncEvent[] = [
  { id: 1, ts: 1001, name: HOSTED_BROWSER_QUERY_NAME, args: { workspaceId: WORKSPACE_A }, data: [{ secret: 'tenant-a-row' }] },
  { id: 2, ts: 1002, name: HOSTED_BROWSER_QUERY_NAME, args: { workspaceId: WORKSPACE_B }, data: [{ secret: 'tenant-b-row' }] },
];

function runtimeDependencies(): HostedRuntimeDependencies {
  return {
    resolveSecret: fakeSecrets,
    runService,
    runTenant,
    providerDelegationAdapters: delegationAdapters(),
    delegationOrganization,
    hostedBrowser: {
      runTenant,
      backfillSince: () => backfillEvents,
      subscribe: async (listener) => ({ send: listener, close: () => {} }),
      // Boundary probes owe a synchronous refusal; reaching a provision start
      // is a failure. Keep them off the shared controller and paid backends.
      provisioningAvailable: () => true,
      startProvisioning: async () => { throw new Error('unpaid boundary probe reached provisioning'); },
    },
  };
}

beforeAll(async () => {
  // Clone the maintained production schema instead of a hand-picked migration
  // subset that misses fields read by the current hosted routes.
  db = await createOrgTestDb({ adminPoolMax: 8 });
  sql = db.adminSql;
  await seedTenants(sql);
  runService = serviceRunner(sql);
  runTenant = tenantRunner(sql);
  plane = await createHostedRuntime(CONFIGURATION, runtimeDependencies());
  sessionA = await createSession(plane, USER_A, ORG_A, WORKSPACE_A, 'a');
  sessionB = await createSession(plane, USER_B, ORG_B, WORKSPACE_B, 'b');
}, 180_000);

afterAll(async () => {
  await db?.cleanup().catch(() => {});
});

describe.sequential('assembled hosted two-tenant acceptance', () => {
  it('keeps tenant reads usable when the optional connector ledger is outside the tenant role', async () => {
    await runTenant(tenantContext(sessionA), async tx => {
      const [{ allowed }] = await tx<{ allowed: boolean }[]>`SELECT has_table_privilege(
        current_user, 'papercusp_auth.hosted_workspace_connectors', 'SELECT') AS allowed`;
      expect(allowed).toBe(false);
      const rows = await readWorkspaceHostControl(CONTROL, tx) as Array<{
        kind: string; id: string; hostedConnector?: unknown;
      }>;
      expect(rows.find(row => row.kind === 'workspace' && row.id === HOST_A)).toMatchObject({
        id: HOST_A, hostedConnector: undefined,
      });
      expect(rows.some(row => row.id === HOST_B)).toBe(false);
      // This real query fails with 25P02 if a caught optional SELECT poisoned
      // the transaction. The role and its original RLS scope must also survive.
      expect(await tx`SELECT current_user AS role, current_setting('app.organization_id') AS organization_id`)
        .toEqual([{ role: 'hosted_app', organization_id: ORG_A }]);
    });
  });

  it('exports customer data over private HTTP using persisted cookies and server-derived tenant and user scope', async () => {
    // A role-only fixture must fail the same SQL guard that caused the HTTP
    // exporter to return 503. Keep that guard intact while using the full
    // production service context for the assembled HTTP proof below.
    await expect(sql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      await tx`SELECT set_config('app.organization_id', ${ORG_A}, true)`;
      return tx`SELECT data FROM papercusp_auth.read_hosted_customer_export_rows(
        'harness_shared.customer_workspaces', ${ORG_A})`;
    })).rejects.toMatchObject({ code: '42501', message: 'hosted customer export service scope is invalid' });
    const session = await createSession(plane, USER_A, ORG_A, WORKSPACE_A, 'data-export');
    const server = serve({ fetch: plane.app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private customer-data HTTP address unavailable');
      const base = `http://127.0.0.1:${address.port}/api`;
      const post = (path: string, value: HostedSession | null = session, extra: Record<string, string> = {}) => fetch(base + path, {
        method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json',
          ...(value ? { cookie: cookie(plane, value) } : {}), ...extra },
        // Scope fields supplied by the browser must never replace cookie authority.
        body: JSON.stringify({ organizationId: ORG_B, userId: USER_B, workspaceId: WORKSPACE_B }),
      });
      for (const [path, filename] of [[HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH, 'organization'],
        [HOSTED_BROWSER_USER_EXPORT_PATH, 'user']] as const) {
        const response = await post(path);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filename}-data.json"`);
        const exported = await response.json() as OrganizationDataExport;
        expect(exported.stores.find(store => store.store === 'papercusp_auth.hosted_users')?.rows.map(row => row.id)).toEqual([USER_A]);
        expect(JSON.stringify(exported)).not.toContain(USER_B);
        expect(JSON.stringify(exported)).not.toContain(ORG_B);
        const receipts = await sql`SELECT organization_id, actor_id, metadata FROM papercusp_auth.organization_audit_events
          WHERE id = ${exported.receiptId}::uuid`;
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ organization_id: ORG_A, actor_id: USER_A,
          metadata: { operation: 'export', executor: 'hosted-control-plane',
            ...(filename === 'user' ? { userId: USER_A } : {}) } });
      }
      const foreign = await post(HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH, sessionB);
      expect(foreign.status, await foreign.clone().text()).toBe(200);
      expect(JSON.stringify(await foreign.json())).not.toContain(USER_A);
      expect((await post(HOSTED_BROWSER_USER_EXPORT_PATH, null)).status).toBe(401);
      expect((await post(HOSTED_BROWSER_USER_EXPORT_PATH, session, { origin: 'https://foreign.example' })).status).toBe(403);
      expect((await post(HOSTED_BROWSER_USER_EXPORT_PATH, session, { 'x-papercusp-workspace': WORKSPACE_B })).status).toBe(403);
      await plane.components.sessionStore.revoke(session.id, 'customer-data acceptance');
      expect((await post(HOSTED_BROWSER_USER_EXPORT_PATH)).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('admits deletion over private HTTP only after server policy approval and commits immutable authority before enqueue', async () => {
    let policy: HostedCustomerDeletionPolicy | null = null;
    const enqueued: HostedCustomerDeletionRequest[] = [];
    const enqueue = vi.fn(async (input: HostedCustomerDeletionRequest) => {
      // This separate connection cannot see an uncommitted admission. No provider
      // is invoked here; the real DBOS executor has its own isolated SDK proof.
      const admissions = await sql`SELECT organization_id, actor_id, metadata FROM papercusp_auth.organization_audit_events
        WHERE action = 'organization.data.deletion.requested' AND metadata->>'operationId' = ${input.operationId}`;
      expect(admissions).toHaveLength(1);
      expect(admissions[0]).toMatchObject({ organization_id: ORG_A, actor_id: USER_A,
        metadata: { kind: 'organization', policy: { approvalRef: 'fixture:approved-retention', stripe: 'retain', consent: 'retain' } } });
      enqueued.push(input);
      return { operationId: input.operationId };
    });
    const deletionPlane = await createHostedRuntime(CONFIGURATION, { ...runtimeDependencies(),
      hostedBrowser: { ...runtimeDependencies().hostedBrowser,
        requestCustomerDeletion: createHostedCustomerDeletionRequester({ runService,
          resolveApprovedPolicy: async () => policy, enqueueCustomerDeletion: enqueue }) },
    });
    const session = await createSession(deletionPlane, USER_A, ORG_A, WORKSPACE_A, 'data-deletion');
    const server = serve({ fetch: deletionPlane.app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private deletion HTTP address unavailable');
      const base = `http://127.0.0.1:${address.port}/api`;
      const post = (path: string, confirmation: string, extra: Record<string, string> = {}) => fetch(base + path, {
        method: 'POST', headers: { origin: ORIGIN, cookie: cookie(deletionPlane, session), 'content-type': 'application/json', ...extra },
        body: JSON.stringify({ confirmation, organizationId: ORG_B, userId: USER_B, operationId: 'caller-chosen',
          policy: { approvalRef: 'untrusted-browser-policy', stripe: 'delete', consent: 'delete' } }),
      });
      const pending = await post(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'DELETE ORGANIZATION');
      expect(pending.status).toBe(409);
      expect(await pending.json()).toMatchObject({ error: 'retention_policy_pending' });
      expect(enqueue).not.toHaveBeenCalled();
      policy = { approvalRef: 'fixture:approved-retention', stripe: 'retain', consent: 'retain' };
      expect((await post(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'wrong confirmation')).status).toBe(400);
      expect((await post(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'DELETE ORGANIZATION', { origin: 'https://foreign.example' })).status).toBe(403);
      expect((await post(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'DELETE ORGANIZATION', { 'x-papercusp-workspace': WORKSPACE_B })).status).toBe(403);
      expect(enqueue).not.toHaveBeenCalled();
      const accepted = await post(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'DELETE ORGANIZATION');
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      expect(accepted.headers.get('cache-control')).toBe('no-store');
      const result = await accepted.json() as { operationId: string };
      expect(enqueued).toEqual([{ operationId: result.operationId, organizationId: ORG_A, requestedBy: USER_A,
        target: { kind: 'organization' }, policy }]);
      expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
      const orphan = await post(HOSTED_BROWSER_USER_DELETE_PATH, 'DELETE MY ACCOUNT');
      expect(orphan.status).toBe(409);
      expect(await orphan.json()).toMatchObject({ error: 'transfer_organization_ownership_required' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      await deletionPlane.components.sessionStore.revoke(session.id, 'customer-deletion acceptance');
      expect((await post(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'DELETE ORGANIZATION')).status).toBe(401);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('serves persisted-session billing usage over private HTTP with tenant isolation, replay and durable corrections', async () => {
    const now = Date.UTC(2026, 9, 2);
    const records: HostedUsageRecord[] = [
      { controlWorkspaceId: CONTROL, organizationId: ORG_A, customerWorkspaceId: WORKSPACE_A,
        provider: 'cloud-billing-fixture', recordId: 'cloud-billing-a-1', usageId: 'cloud-billing-a', revision: 1,
        category: 'compute', payer: 'consumption', occurredAtMs: now - 1, observedAtMs: now,
        quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 20_003,
        sourceRef: 'fixture:cloud-billing-a-1' },
      { controlWorkspaceId: CONTROL, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B,
        provider: 'cloud-billing-fixture', recordId: 'cloud-billing-b-1', usageId: 'cloud-billing-b', revision: 1,
        category: 'compute', payer: 'consumption', occurredAtMs: now - 1, observedAtMs: now,
        quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 90_011,
        sourceRef: 'fixture:cloud-billing-b-1' },
    ];
    // Persist both tenants before the first HTTP read: isolation must hold even
    // when the foreign receipt is already present in the real service ledger.
    const usageStore = new PostgresHostedUsageStore(runService);
    for (const record of records) expect(await usageStore.append(record)).toBe('recorded');
    const collectorRead = vi.fn(async (input: { scope: HostedUsageStatement['scope']; month: string }) => ({
      scope: input.scope, month: input.month, complete: false, observedAtMs: now,
      evidenceRef: 'fixture:cloud-billing-census',
      records: records.filter(record => record.organizationId === input.scope.organizationId
        && (input.scope.customerWorkspaceId === null || record.customerWorkspaceId === input.scope.customerWorkspaceId)),
    }));
    const billing = await createHostedBillingRuntime({ publicOrigin: ORIGIN,
      stripeSecretKeyRef: null, stripeWebhookSecretRef: null, plans: [],
    }, { runService, clock: () => new Date(now),
      resolvePrincipal: createHostedPrincipalResolver({ ...plane.components, controlPlaneWorkspaceId: CONTROL }),
      usageCollectors: [{ id: 'cloud-billing-fixture', provider: 'cloud-billing-fixture',
        categories: ['compute'], read: collectorRead }],
    });
    const server = serve({ fetch: billing.app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private billing HTTP address unavailable');
      const base = `http://127.0.0.1:${address.port}/api/hosted/billing/usage?month=2026-10`;
      const read = (session: HostedSession, query = '') => fetch(base + query, { headers: { cookie: cookie(plane, session) } });
      const statement = async (session: HostedSession) => {
        const response = await read(session);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return (await response.json() as { statement: HostedUsageStatement }).statement;
      };
      const first = await statement(sessionA);
      expect(first.scope).toEqual({ controlWorkspaceId: CONTROL, organizationId: ORG_A, customerWorkspaceId: null });
      expect(first.consumptionBilled).toMatchObject({ micros: 20_003, wholeCents: 2, roundingMicros: 3 });
      expect(first.history.map(row => row.usageId)).toEqual(['cloud-billing-a']);
      expect(first.settlementEligible).toBe(false);
      expect(first.gaps).toContain('incomplete-source');
      expect((await statement(sessionB)).consumptionBilled.micros).toBe(90_011);
      // Retry reads append duplicate observations; they never duplicate a bill.
      expect((await statement(sessionA)).consumptionBilled.micros).toBe(20_003);
      records[0] = { ...records[0]!, recordId: 'cloud-billing-a-2', revision: 2,
        costMicros: 30_007, sourceRef: 'fixture:cloud-billing-a-2' };
      const corrected = await statement(sessionA);
      expect(corrected.consumptionBilled).toMatchObject({ micros: 30_007, wholeCents: 3, roundingMicros: 7 });
      expect(corrected.lines).toHaveLength(1);
      expect(corrected.lines[0]?.usages).toBe(1);
      expect(corrected.history[0]?.revisions.map(row => [row.recordId, row.revision, row.costMicros]))
        .toEqual([['cloud-billing-a-1', 1, 20_003], ['cloud-billing-a-2', 2, 30_007]]);
      expect((await statement(sessionA)).consumptionBilled.micros).toBe(30_007);
      expect((await statement(sessionB)).consumptionBilled.micros).toBe(90_011);
      const foreign = await read(sessionA, `&workspaceId=${WORKSPACE_B}`);
      expect(foreign.status).toBe(200);
      const foreignBody = await foreign.json() as { statement: HostedUsageStatement };
      expect(foreignBody.statement.history).toEqual([]);
      expect(foreignBody.statement.consumptionBilled.micros).toBe(0);
      expect(foreignBody.statement.settlementEligible).toBe(false);
      const calls = collectorRead.mock.calls.length;
      for (const query of [`&organizationId=${ORG_B}`, '&controlWorkspaceId=foreign-control', '&complete=true']) {
        const denied = await read(sessionA, query);
        expect(denied.status).toBe(400);
        await denied.arrayBuffer();
      }
      expect(collectorRead).toHaveBeenCalledTimes(calls);
      expect(await runService(tx => tx`SELECT record_id, revision FROM papercusp_auth.hosted_usage_receipts
        WHERE control_workspace_id = ${CONTROL} AND provider = 'cloud-billing-fixture' ORDER BY record_id`))
        .toEqual([{ record_id: 'cloud-billing-a-1', revision: 1 },
          { record_id: 'cloud-billing-a-2', revision: 2 }, { record_id: 'cloud-billing-b-1', revision: 1 }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
    }
  });

  it('redacts failed billing collectors over private HTTP and recovers without changing another tenant or duplicating receipts', async () => {
    const now = Date.UTC(2026, 8, 2);
    const provider = 'cloud-billing-recovery-fixture';
    const records: HostedUsageRecord[] = [
      { controlWorkspaceId: CONTROL, organizationId: ORG_A, customerWorkspaceId: WORKSPACE_A,
        provider, recordId: 'billing-recovery-a-1', usageId: 'billing-recovery-a', revision: 1,
        category: 'compute', payer: 'consumption', occurredAtMs: now - 1, observedAtMs: now,
        quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 21_007,
        sourceRef: 'fixture:billing-recovery-a-1' },
      { controlWorkspaceId: CONTROL, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B,
        provider, recordId: 'billing-recovery-b-1', usageId: 'billing-recovery-b', revision: 1,
        category: 'compute', payer: 'consumption', occurredAtMs: now - 1, observedAtMs: now,
        quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 81_011,
        sourceRef: 'fixture:billing-recovery-b-1' },
    ];
    const usageStore = new PostgresHostedUsageStore(runService);
    for (const record of records) expect(await usageStore.append(record)).toBe('recorded');
    let failure: 'outage' | 'foreign' | null = 'outage';
    const collectorRead = vi.fn(async (input: { scope: HostedUsageStatement['scope']; month: string }) => {
      if (input.scope.organizationId === ORG_A && failure === 'outage') {
        throw new Error('synthetic-provider-secret=redaction-canary; upstream account tenant-b');
      }
      return { scope: input.scope, month: input.month, complete: false, observedAtMs: now,
        evidenceRef: 'fixture:billing-recovery-census',
        records: records.filter(record => record.organizationId ===
          (input.scope.organizationId === ORG_A && failure === 'foreign' ? ORG_B : input.scope.organizationId)) };
    });
    const billing = await createHostedBillingRuntime({ publicOrigin: ORIGIN,
      stripeSecretKeyRef: null, stripeWebhookSecretRef: null, plans: [],
    }, { runService, clock: () => new Date(now),
      resolvePrincipal: createHostedPrincipalResolver({ ...plane.components, controlPlaneWorkspaceId: CONTROL }),
      usageCollectors: [{ id: provider, provider, categories: ['compute'], read: collectorRead }],
    });
    const server = serve({ fetch: billing.app.fetch, hostname: '127.0.0.1', port: 0 });
    const persisted = () => runService(tx => tx`SELECT record_id, revision, cost_micros
      FROM papercusp_auth.hosted_usage_receipts WHERE control_workspace_id = ${CONTROL}
        AND provider = ${provider} ORDER BY record_id`);
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private billing HTTP address unavailable');
      const url = `http://127.0.0.1:${address.port}/api/hosted/billing/usage?month=2026-09`;
      const read = (session: HostedSession) => fetch(url, { headers: { cookie: cookie(plane, session) } });
      const statement = async (session: HostedSession) => {
        const response = await read(session);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return (await response.json() as { statement: HostedUsageStatement }).statement;
      };
      const original = await persisted();
      for (const state of ['outage', 'foreign'] as const) {
        failure = state;
        const response = await read(sessionA);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ok: false,
          error: { code: 'usage_unavailable', safeMessage: 'Usage could not be read.' } });
        expect(await persisted()).toEqual(original);
        const unaffected = await statement(sessionB);
        expect(unaffected.scope.organizationId).toBe(ORG_B);
        expect(unaffected.consumptionBilled.micros).toBe(81_011);
        expect(unaffected.history.map(row => row.usageId)).toEqual(['billing-recovery-b']);
      }
      failure = null;
      records[0] = { ...records[0]!, recordId: 'billing-recovery-a-2', revision: 2,
        costMicros: 31_003, sourceRef: 'fixture:billing-recovery-a-2' };
      for (let retry = 0; retry < 2; retry++) {
        const recovered = await statement(sessionA);
        expect(recovered.scope.organizationId).toBe(ORG_A);
        expect(recovered.consumptionBilled.micros).toBe(31_003);
        expect(recovered.history.map(row => row.usageId)).toEqual(['billing-recovery-a']);
        expect(recovered.history[0]?.revisions.map(row => [row.recordId, row.revision, row.costMicros]))
          .toEqual([['billing-recovery-a-1', 1, 21_007], ['billing-recovery-a-2', 2, 31_003]]);
        expect(recovered.settlementEligible).toBe(false);
        expect((await statement(sessionB)).consumptionBilled.micros).toBe(81_011);
      }
      expect((await persisted()).map(row => [row.record_id, row.revision]))
        .toEqual([['billing-recovery-a-1', 1], ['billing-recovery-a-2', 2], ['billing-recovery-b-1', 1]]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
    }
  });

  it('denies anonymous and persistently revoked billing sessions before the collector while another tenant survives', async () => {
    const session = await createSession(plane, USER_A, ORG_A, WORKSPACE_A, 'billing-revocation');
    const now = Date.UTC(2026, 9, 2);
    const collectorRead = vi.fn(async (input: { scope: HostedUsageStatement['scope']; month: string }) => ({
      scope: input.scope, month: input.month, complete: false, observedAtMs: now,
      evidenceRef: 'fixture:cloud-billing-empty-census', records: [],
    }));
    const billing = await createHostedBillingRuntime({ publicOrigin: ORIGIN,
      stripeSecretKeyRef: null, stripeWebhookSecretRef: null, plans: [],
    }, { runService, clock: () => new Date(now),
      resolvePrincipal: createHostedPrincipalResolver({ ...plane.components, controlPlaneWorkspaceId: CONTROL }),
      usageCollectors: [{ id: 'cloud-billing-fixture', provider: 'cloud-billing-fixture',
        categories: ['compute'], read: collectorRead }],
    });
    const read = (value?: HostedSession) => billing.app.request('/api/hosted/billing/usage?month=2026-10',
      value ? { headers: { cookie: cookie(plane, value) } } : {});
    expect((await read(session)).status).toBe(200);
    expect(collectorRead).toHaveBeenCalledTimes(1);
    await plane.components.sessionStore.revoke(session.id);
    expect(await plane.components.sessionStore.resolve(session.id)).toBeNull();
    expect((await read(session)).status).toBe(401);
    expect((await read()).status).toBe(401);
    expect(collectorRead).toHaveBeenCalledTimes(1);
    expect((await read(sessionB)).status).toBe(200);
    expect(collectorRead).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['role change', 401],
    ['membership revocation', 403],
  ] as const)('rejects retained billing cookies after persisted %s over HTTP before collection', async (ending, status) => {
    // Keep the original cookie and session row alive. Only the authoritative
    // membership changes; a cached session grant must not authorize billing.
    const userId = randomUUID();
    await sql`
      INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
      VALUES (${userId}::uuid, ${`${userId}@example.test`}, 'Billing authority probe')
    `;
    await sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, status, authority, created_via)
      VALUES (${ORG_A}::uuid, ${userId}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')
    `;
    const session = await createSession(plane, userId, ORG_A, WORKSPACE_A, `billing-${ending}`);
    const retainedCookie = cookie(plane, session);
    // Durable reads include all providers in a month, so independent cases
    // need disjoint months as well as different receipt identifiers.
    const month = ending === 'role change' ? '2026-08' : '2026-07';
    const now = Date.UTC(2026, ending === 'role change' ? 7 : 6, 2);
    const provider = ending === 'role change' ? 'billing-authority-role-fixture' : 'billing-authority-revocation-fixture';
    const records: HostedUsageRecord[] = [
      { controlWorkspaceId: CONTROL, organizationId: ORG_A, customerWorkspaceId: WORKSPACE_A,
        provider, recordId: `${provider}-a-1`, usageId: `${provider}-a`, revision: 1,
        category: 'compute', payer: 'consumption', occurredAtMs: now - 1, observedAtMs: now,
        quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 11_003,
        sourceRef: 'fixture:billing-authority-a' },
      { controlWorkspaceId: CONTROL, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B,
        provider, recordId: `${provider}-b-1`, usageId: `${provider}-b`, revision: 1,
        category: 'compute', payer: 'consumption', occurredAtMs: now - 1, observedAtMs: now,
        quantity: 60, unit: 'seconds', costSource: 'provider-billed', costMicros: 77_009,
        sourceRef: 'fixture:billing-authority-b' },
    ];
    const usageStore = new PostgresHostedUsageStore(runService);
    for (const record of records) expect(await usageStore.append(record)).toBe('recorded');
    const collectorRead = vi.fn(async (input: { scope: HostedUsageStatement['scope']; month: string }) => ({
      scope: input.scope, month: input.month, complete: false, observedAtMs: now,
      evidenceRef: 'fixture:billing-authority-census',
      records: records.filter(record => record.organizationId === input.scope.organizationId),
    }));
    const billing = await createHostedBillingRuntime({ publicOrigin: ORIGIN,
      stripeSecretKeyRef: null, stripeWebhookSecretRef: null, plans: [],
    }, { runService, clock: () => new Date(now),
      resolvePrincipal: createHostedPrincipalResolver({ ...plane.components, controlPlaneWorkspaceId: CONTROL }),
      usageCollectors: [{ id: provider, provider, categories: ['compute'], read: collectorRead }],
    });
    const persisted = () => runService(tx => tx`SELECT record_id, revision, cost_micros
      FROM papercusp_auth.hosted_usage_receipts WHERE control_workspace_id = ${CONTROL}
        AND provider = ${provider} ORDER BY record_id`);
    const server = serve({ fetch: billing.app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private billing HTTP address unavailable');
      const url = `http://127.0.0.1:${address.port}/api/hosted/billing/usage?month=${month}`;
      const read = (value: string) => fetch(url, { headers: { cookie: value } });
      const before = await read(retainedCookie);
      expect(before.status, await before.clone().text()).toBe(200);
      expect((await before.json() as { statement: HostedUsageStatement }).statement.consumptionBilled.micros).toBe(11_003);
      expect(collectorRead).toHaveBeenCalledTimes(1);
      const original = await persisted();
      if (ending === 'role change') {
        expect(await sql`UPDATE papercusp_auth.organization_memberships
          SET role = 'member', updated_at = updated_at + interval '2 seconds'
          WHERE organization_id = ${ORG_A}::uuid AND user_id = ${userId}::uuid RETURNING user_id`)
          .toEqual([{ user_id: userId }]);
      } else {
        expect(await sql`UPDATE papercusp_auth.organization_memberships
          SET status = 'revoked', revoked_at = now(), updated_at = updated_at + interval '2 seconds'
          WHERE organization_id = ${ORG_A}::uuid AND user_id = ${userId}::uuid RETURNING user_id`)
          .toEqual([{ user_id: userId }]);
      }
      expect(await plane.components.sessionStore.resolve(session.id)).toMatchObject({ id: session.id,
        permissionVersion: session.permissionVersion, revokedAt: null });
      const denied = await read(retainedCookie);
      expect(denied.status).toBe(status);
      const deniedBody = await denied.text();
      for (const secret of [session.id, userId, retainedCookie, records[0]!.recordId, records[1]!.recordId]) {
        expect(deniedBody).not.toContain(secret);
      }
      expect(collectorRead).toHaveBeenCalledTimes(1);
      expect(await persisted()).toEqual(original);
      const survivor = await read(cookie(plane, sessionB));
      expect(survivor.status, await survivor.clone().text()).toBe(200);
      const statement = (await survivor.json() as { statement: HostedUsageStatement }).statement;
      expect(statement.scope.organizationId).toBe(ORG_B);
      expect(statement.consumptionBilled.micros).toBe(77_009);
      expect(statement.history.map(row => row.usageId)).toEqual([`${provider}-b`]);
      expect(collectorRead).toHaveBeenCalledTimes(2);
      expect(await persisted()).toEqual(original);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
    }
  });

  it('serves the hosted tenant API on a private HTTP target and refuses unpaid provisioning attacks', async () => {
    // Use the production composition and persisted hosted sessions above, on an
    // ephemeral loopback listener. This never borrows the shared controller or
    // starts a provider operation: every write below must stop before enqueue.
    const server = serve({ fetch: plane.app.fetch, hostname: '127.0.0.1', port: 0 });
    const query = `/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}&args=%7B%7D`;
    const provision = `/api${HOSTED_BROWSER_PROVISION_PATH}`;
    const headers = { cookie: cookie(plane, sessionA), 'content-type': 'application/json', origin: ORIGIN };
    const body = { connectionId: CONNECTION_A, name: 'Unpaid boundary probe', desired: { hostId: HOST_A, target: 'gcp' } };
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private hosted HTTP address unavailable');
      const base = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);
      await health.arrayBuffer();
      const visible = await fetch(`${base}${query}`, { headers: { cookie: headers.cookie } });
      expect(visible.status).toBe(200);
      const rows = (await visible.json() as { rows: Array<{ id: string }> }).rows;
      expect(rows.map((row) => row.id)).toEqual([CONNECTION_A, HOST_A]);

      const unauthenticatedHeaders: Record<string, string>[] = [
        {}, { cookie: `${HOSTED_SESSION_COOKIE}=invalid-cookie` },
      ];
      for (const authHeaders of unauthenticatedHeaders) {
        const denied = await fetch(`${base}${provision}`, {
          method: 'POST', headers: { ...authHeaders, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(denied.status).toBe(401);
        await denied.arrayBuffer();
      }
      for (const origin of [undefined, 'https://other.example.test']) {
        const denied = await fetch(`${base}${provision}`, {
          method: 'POST', headers: { cookie: headers.cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
          body: JSON.stringify(body),
        });
        expect(denied.status).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({ error: 'cross_origin_blocked' });
      }
      const foreignWorkspace = await fetch(`${base}${provision}`, {
        method: 'POST', headers: { ...headers, 'x-papercusp-workspace': WORKSPACE_B }, body: JSON.stringify(body),
      });
      expect(foreignWorkspace.status).toBe(403);
      await expect(foreignWorkspace.json()).resolves.toMatchObject({ error: 'workspace_binding_mismatch' });

      const malformed = await fetch(`${base}${provision}`, { method: 'POST', headers, body: '{' });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ error: 'invalid json' });
      const foreignHost = await fetch(`${base}${provision}`, {
        method: 'POST', headers, body: JSON.stringify({ ...body, desired: { ...body.desired, hostId: HOST_B } }),
      });
      expect(foreignHost.status, await foreignHost.clone().text()).toBe(403);
      await expect(foreignHost.json()).resolves.toMatchObject({ error: 'workspace_host_not_bound' });
      const forgedCanary = await fetch(`${base}${provision}`, {
        method: 'POST', headers,
        body: JSON.stringify({ ...body, desired: { ...body.desired, labels: { [WORKSPACE_HOST_CANARY_TAG_KEYS.runId]: 'forged' } } }),
      });
      expect(forgedCanary.status).toBe(422);
      await expect(forgedCanary.json()).resolves.toMatchObject({ error: 'workspace-host provisioning request rejected' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('limits beginner workspace selection to the persisted tenant even when a foreign target has the same name', async () => {
    // The authorized and foreign rows both exist, with identical display names
    // and running lifecycle states. A missing fixture cannot explain exclusion.
    const server = serve({ fetch: plane.app.fetch, hostname: '127.0.0.1', port: 0 });
    const query = `/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}`;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private hosted HTTP address unavailable');
      const base = `http://127.0.0.1:${address.port}`;
      const read = (session: HostedSession, args: Record<string, string> = {}) =>
        fetch(`${base}${query}&args=${encodeURIComponent(JSON.stringify(args))}`, {
          headers: { cookie: cookie(plane, session) },
        });
      for (const [session, visibleHost, foreignHost] of [
        [sessionA, HOST_A, HOST_B],
        [sessionB, HOST_B, HOST_A],
      ] as const) {
        const response = await read(session);
        expect(response.status).toBe(200);
        const rows = (await response.json() as { rows: Array<{ kind: string; id: string; name?: string }> }).rows;
        const workspaces = rows.filter(row => row.kind === 'workspace');
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0]).toMatchObject({ id: visibleHost, name: 'Same workspace name' });
        expect(workspaces.map(row => row.id)).not.toContain(foreignHost);
      }
      // Naming B in a request authenticated as A cannot change the server's
      // tenant binding. Both supported scope inputs are refused explicitly.
      const argsAttack = await read(sessionA, { workspaceId: WORKSPACE_B });
      expect(argsAttack.status).toBe(400);
      await expect(argsAttack.json()).resolves.toMatchObject({ error: 'query_args_not_supported' });
      const headerAttack = await fetch(`${base}${query}&args=%7B%7D`, {
        headers: { cookie: cookie(plane, sessionA), 'x-papercusp-workspace': WORKSPACE_B },
      });
      expect(headerAttack.status).toBe(403);
      await expect(headerAttack.json()).resolves.toMatchObject({ error: 'workspace_binding_mismatch' });
      // Verify the authenticated A read still works after both denials.
      const retained = await read(sessionA, { workspaceId: WORKSPACE_A });
      expect(retained.status).toBe(200);
      const rows = (await retained.json() as { rows: Array<{ kind: string; id: string }> }).rows;
      expect(rows.filter(row => row.kind === 'workspace').map(row => row.id)).toEqual([HOST_A]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['expired', 'revoked'] as const)('rejects a %s persisted session over HTTP while the other tenant remains live', async (state) => {
    const dependencies = runtimeDependencies();
    const startProvisioning = vi.fn(dependencies.hostedBrowser!.startProvisioning!);
    const authenticationPlane = await createHostedRuntime(CONFIGURATION, {
      ...dependencies,
      hostedBrowser: { ...dependencies.hostedBrowser, startProvisioning },
    });
    const session = await createSession(authenticationPlane, USER_A, ORG_A, WORKSPACE_A, `http-${state}`);
    const retainedCookie = cookie(authenticationPlane, session);
    const server = serve({ fetch: authenticationPlane.app.fetch, hostname: '127.0.0.1', port: 0 });
    const query = `/api${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}&args=%7B%7D`;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private hosted HTTP address unavailable');
      const base = `http://127.0.0.1:${address.port}`;
      const before = await fetch(`${base}${query}`, { headers: { cookie: retainedCookie } });
      expect(before.status).toBe(200);
      const beforeRows = (await before.json() as { rows: Array<{ id: string }> }).rows;
      expect(beforeRows.map(({ id }) => id)).toEqual([CONNECTION_A, HOST_A]);

      if (state === 'expired') {
        // Advance the persisted timestamps into the past, preserving the real
        // schema's expiry-after-creation constraint and the original cookie.
        const expired = await sql<Array<{ id: string }>>`
          UPDATE papercusp_auth.hosted_sessions
             SET created_at = now() - interval '2 hours',
                 expires_at = now() - interval '1 hour'
           WHERE id = ${session.id}
          RETURNING id
        `;
        expect(expired).toEqual([{ id: session.id }]);
      } else {
        expect(await authenticationPlane.components.sessionStore.revoke(session.id, 'acceptance_logout')).toBe(true);
      }

      const read = await fetch(`${base}${query}`, { headers: { cookie: retainedCookie } });
      expect(read.status).toBe(401);
      const deniedBody = await read.text();
      expect(deniedBody).not.toContain(session.id);
      expect(deniedBody).not.toContain(CONNECTION_A);
      expect(deniedBody).not.toContain(CONNECTION_B);
      const write = await fetch(`${base}/api${HOSTED_BROWSER_PROVISION_PATH}`, {
        method: 'POST',
        headers: { cookie: retainedCookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONNECTION_A, name: 'Invalidated session probe', desired: { hostId: HOST_A, target: 'gcp' } }),
      });
      expect(write.status).toBe(401);
      await write.arrayBuffer();
      expect(startProvisioning).not.toHaveBeenCalled();

      const otherTenant = await fetch(`${base}${query}`, { headers: { cookie: cookie(authenticationPlane, sessionB) } });
      expect(otherTenant.status).toBe(200);
      const otherRows = (await otherTenant.json() as { rows: Array<{ id: string }> }).rows;
      expect(otherRows.map(({ id }) => id)).toEqual([CONNECTION_B, HOST_B]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('distinguishes a missing fixture column from a foreign-host authorization refusal', async () => {
    const tenantErrors: unknown[] = [];
    const dependencies = runtimeDependencies();
    const diagnosticPlane = await createHostedRuntime(CONFIGURATION, {
      ...dependencies,
      hostedBrowser: {
        ...dependencies.hostedBrowser,
        runTenant: async (context, fn) => {
          try {
            return await runTenant(context, fn);
          } catch (error) {
            tenantErrors.push(error);
            throw error;
          }
        },
      },
    });
    const foreignHostRequest = () => request(diagnosticPlane, HOSTED_BROWSER_PROVISION_PATH, sessionA, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        connectionId: CONNECTION_A,
        name: 'Foreign host fixture control',
        desired: { hostId: HOST_B, target: 'gcp' },
      }),
    });

    // Recreate only the old fixture's missing column. Keep the repaired route,
    // principal, session, tenants and request unchanged between both controls.
    await sql`ALTER TABLE harness_shared.customer_workspaces RENAME COLUMN kind TO acceptance_fixture_kind`;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const missingColumn = await foreignHostRequest();
      expect(missingColumn.status, await missingColumn.text()).toBe(500);
      expect(tenantErrors).toHaveLength(1);
      expect(tenantErrors[0]).toMatchObject({ code: '42703' });
      expect((tenantErrors[0] as Error).message).toContain('kind');
    } finally {
      consoleError.mockRestore();
      await sql`ALTER TABLE harness_shared.customer_workspaces RENAME COLUMN acceptance_fixture_kind TO kind`;
    }

    const restoredSchema = await foreignHostRequest();
    expect(restoredSchema.status, await restoredSchema.text()).toBe(403);
    expect(tenantErrors).toHaveLength(1);
  });

  it('isolates HTTP, SSE, MCP mount, and direct SQL under overlapping tenant names', async () => {
    const rlsFacts = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{
        current_user: string;
        session_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        organization_id: string;
        workspace_id: string;
      }>>`
        SELECT current_user,
               session_user,
               role_row.rolsuper,
               role_row.rolbypassrls,
               current_setting('app.organization_id', true) AS organization_id,
               current_setting('app.workspace_id', true) AS workspace_id
          FROM pg_roles role_row
         WHERE role_row.rolname = current_user
      `,
    );
    expect(rlsFacts).toHaveLength(1);
    expect(rlsFacts[0]).toMatchObject({
      current_user: 'hosted_app',
      rolsuper: false,
      rolbypassrls: false,
      organization_id: ORG_A,
      workspace_id: WORKSPACE_A,
    });
    expect(rlsFacts[0]?.session_user).toBeTruthy();
    const scopeFacts = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{ id: string; allowed: boolean }>>`
        SELECT id,
               harness_shared.workspace_host_scope_allows(workspace_id, id) AS allowed
          FROM harness_shared.workspace_hosts
         ORDER BY id
      `,
    );
    expect(scopeFacts).toEqual([
      { id: HOST_A, allowed: true },
    ]);

    const queryPath = `${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}&args=%7B%7D`;
    const [responseA, responseB] = await Promise.all([
      request(plane, queryPath, sessionA),
      request(plane, queryPath, sessionB),
    ]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    const identities = (body: unknown) => {
      const rows = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { rows?: unknown }).rows
        : null;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
        const { kind, id } = row as { kind?: unknown; id?: unknown };
        return typeof kind === 'string' && typeof id === 'string' ? [{ kind, id }] : [];
      });
    };
    // Compare authoritative row identities, never serialized substrings. The
    // public acceptance deliberately reuses display names across tenants, and
    // a display name is allowed to equal another row's opaque id.
    expect(identities(await responseA.json())).toEqual([
      { kind: 'connection', id: CONNECTION_A },
      { kind: 'workspace', id: HOST_A },
    ]);
    expect(identities(await responseB.json())).toEqual([
      { kind: 'connection', id: CONNECTION_B },
      { kind: 'workspace', id: HOST_B },
    ]);

    const headerAttack = await request(plane, queryPath, sessionA, {
      headers: { 'x-papercusp-workspace': WORKSPACE_B },
    });
    expect(headerAttack.status).toBe(403);
    await expect(headerAttack.json()).resolves.toMatchObject({ error: 'workspace_binding_mismatch' });

    const directRows = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{ id: string }>>`
        SELECT id FROM harness_shared.workspace_hosts ORDER BY id
      `,
    );
    expect(directRows.map(({ id }) => id)).toEqual([HOST_A]);
    const directMutation = await runTenant(tenantContext(sessionA), (tx) =>
      tx<Array<{ id: string }>>`
        UPDATE harness_shared.workspace_hosts
           SET name = 'cross-tenant-write'
         WHERE id = ${HOST_B}
        RETURNING id
      `,
    );
    expect(directMutation).toEqual([]);

    const localMcp = await request(plane, '/mcp', sessionA, { method: 'POST' });
    expect(localMcp.status).toBe(404);

    const abort = new AbortController();
    const sse = await request(plane, HOSTED_BROWSER_SSE_PATH, sessionA, {
      headers: { 'last-event-id': '0' },
      signal: abort.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    const replay = await readSseUntil(reader, (text) => text.includes('"tsMs":1001'));
    expect(replay).toContain('"tsMs":1001');
    expect(replay).not.toContain('1002');
    expect(replay).not.toContain('tenant-a-row');
    expect(replay).not.toContain('tenant-b-row');
    abort.abort();
    await reader.cancel();
  });

  it('admits a one-time socket ticket exactly once across concurrent control-plane instances', async () => {
    const restarted = await createHostedRuntime(CONFIGURATION, runtimeDependencies());
    const gateway = plane.components.connectorGateway!;
    const restartedGateway = restarted.components.connectorGateway!;
    expect(restartedGateway).not.toBe(gateway);
    expect(restartedGateway.store).not.toBe(gateway.store);

    const tenants = [
      { session: sessionA, workspaceId: WORKSPACE_A, hostId: HOST_A, routeLabel: 'duplicate-tenant-a' },
      { session: sessionB, workspaceId: WORKSPACE_B, hostId: HOST_B, routeLabel: 'duplicate-tenant-b' },
    ] as const;
    for (const tenant of tenants) {
      const enrollment = await request(plane, `/hosted/workspaces/${tenant.workspaceId}/connectors/enroll`, tenant.session, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: tenant.hostId, routeLabel: tenant.routeLabel, transport: 'websocket' }),
      });
      expect(enrollment.status).toBe(200);
      const { ticket } = await enrollment.json() as { ticket: string };
      const registration = await request(restarted, `/hosted/connectors/register?ticket=${ticket}`, undefined, { method: 'POST' });
      expect(registration.status).toBe(200);
    }

    const issueUpgrade = async (tenant: typeof tenants[number]): Promise<Request> => {
      const response = await request(plane, `/hosted/workspaces/${tenant.workspaceId}/connectors/session-ticket`, tenant.session, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: tenant.hostId, routeLabel: tenant.routeLabel, transport: 'websocket', audience: 'workspace-operator' }),
      });
      expect(response.status).toBe(200);
      const { ticket } = await response.json() as { ticket: string };
      return new Request(`https://${tenant.routeLabel}.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${ticket}`);
    };
    const expectedAdmission = (tenant: typeof tenants[number]) => ({
      role: 'browser',
      binding: {
        organizationId: tenant.session.organizationId,
        customerWorkspaceId: tenant.workspaceId,
        hostId: tenant.hostId,
        userId: tenant.session.userId,
        hostedSessionId: tenant.session.id,
      },
    });

    // Independent production stores share only PostgreSQL. Launch both consumes
    // before awaiting either; a process-local replay cache cannot arbitrate them.
    const upgrade = await issueUpgrade(tenants[0]);
    const attempts = await Promise.all([
      authenticateHostedConnectorSocket(gateway, upgrade),
      authenticateHostedConnectorSocket(restartedGateway, upgrade),
    ]);
    expect(attempts.filter((attempt) => attempt !== null)).toEqual([
      expect.objectContaining({ role: 'browser', binding: expect.objectContaining(expectedAdmission(tenants[0]).binding) }),
    ]);
    expect(attempts.filter((attempt) => attempt === null)).toHaveLength(1);
    await expect(authenticateHostedConnectorSocket(gateway, upgrade)).resolves.toBeNull();
    await expect(authenticateHostedConnectorSocket(restartedGateway, upgrade)).resolves.toBeNull();

    // Consuming one ticket must preserve its connector and the other tenant.
    for (const tenant of tenants) {
      const freshUpgrade = await issueUpgrade(tenant);
      await expect(authenticateHostedConnectorSocket(restartedGateway, freshUpgrade)).resolves.toMatchObject(expectedAdmission(tenant));
      await expect(authenticateHostedConnectorSocket(gateway, freshUpgrade)).resolves.toBeNull();
    }
  });

  it.each(['disconnect', 'rotation', 'session-expiry', 'session-revocation', 'role-change', 'membership-revocation'] as const)('keeps native WebSocket relay tenant-bound through %s with persisted credentials', async (ending) => {
    // Compose the actual HTTP upgrade handler with the migrated two-tenant
    // runtime. Provider classification is synthetic; auth, ticket consumption,
    // relay frames and close handshakes cross real PostgreSQL and loopback TCP.
    const hosted = createHostedHandler(plane, new Hono(), {
      controlPlaneWorkspaceId: CONTROL,
      resolveWorkspaceHosting: async () => 'papercusp',
      resolveCustomerWorkspaceHosting: async () => 'papercusp',
    });
    const server = serve({ fetch: hosted.handler, hostname: '127.0.0.1', port: 0 });
    const upgradeErrors: unknown[] = [];
    server.on('upgrade', (request, socket, head) => {
      void hosted.upgrade(request, socket, head).then((handled) => {
        if (!handled) socket.destroy();
      }).catch((error) => { upgradeErrors.push(error); socket.destroy(); });
    });
    const peers: Array<{ socket: WebSocket; frames: Record<string, unknown>[]; close: { code: number; reason: string } | null }> = [];
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('private hosted WebSocket address unavailable');
      const base = `http://127.0.0.1:${address.port}`;
      const socketUrl = `ws://127.0.0.1:${address.port}/api/hosted/connectors/socket`;
      const post = async (path: string, session: HostedSession | undefined, body?: unknown) => {
        const response = await fetch(`${base}/api${path}`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', ...(session ? { cookie: cookie(plane, session) } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        return response.json();
      };
      const dial = async (url: string, routeLabel: string, bearer?: string) => {
        const socket = new WebSocket(url, {
          headers: { host: `${routeLabel}.workspaces.papercusp.com`, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        });
        const peer: typeof peers[number] = { socket, frames: [], close: null };
        peers.push(peer);
        socket.on('message', (data) => peer.frames.push(JSON.parse(data.toString())));
        socket.on('close', (code, reason) => { peer.close = { code, reason: reason.toString() }; });
        // The open wait sees connection errors; retain later transport errors as
        // assertions instead of letting them become unhandled process errors.
        socket.on('error', (error) => upgradeErrors.push(error));
        await once(socket, 'open');
        return peer;
      };
      const rechecksAuthority = ending !== 'disconnect' && ending !== 'rotation';
      let channelSession = sessionA;
      if (rechecksAuthority) {
        // Change a dedicated membership, so the shared A fixture and later
        // acceptance cases retain their original permission-version binding.
        const userId = randomUUID();
        await sql`
          INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
          VALUES (${userId}::uuid, ${`${userId}@example.test`}, 'Channel authority probe')
        `;
        await sql`
          INSERT INTO papercusp_auth.organization_memberships
            (organization_id, user_id, role, status, authority, created_via)
          VALUES (${ORG_A}::uuid, ${userId}::uuid, 'owner', 'active', 'papercusp', 'organization_bootstrap')
        `;
        channelSession = await createSession(plane, userId, ORG_A, WORKSPACE_A, ending);
      }
      const tenants = [
        { session: channelSession, workspaceId: WORKSPACE_A, hostId: HOST_A, routeLabel: `network-a-${ending}` },
        { session: sessionB, workspaceId: WORKSPACE_B, hostId: HOST_B, routeLabel: `network-b-${ending}` },
      ];
      const connections = [];
      for (const tenant of tenants) {
        const binding = { hostId: tenant.hostId, routeLabel: tenant.routeLabel, transport: 'websocket' };
        const enrollment = await post(`/hosted/workspaces/${tenant.workspaceId}/connectors/enroll`, tenant.session, binding) as { ticket: string };
        const credential = await post(`/hosted/connectors/register?ticket=${enrollment.ticket}`, undefined) as { bearer: string };
        const host = await dial(socketUrl, tenant.routeLabel, credential.bearer);
        await vi.waitFor(() => expect(host.frames).toContainEqual(expect.objectContaining({
          type: 'bound', role: 'connector', binding: expect.objectContaining({
            organizationId: tenant.session.organizationId, customerWorkspaceId: tenant.workspaceId, hostId: tenant.hostId,
          }),
        })));
        const issueTicket = async () => (await post(`/hosted/workspaces/${tenant.workspaceId}/connectors/session-ticket`, tenant.session,
          { ...binding, audience: 'workspace-operator' }) as { ticket: string }).ticket;
        const ticket = await issueTicket();
        const browser = await dial(`${socketUrl}?ticket=${ticket}${rechecksAuthority ? '&kind=operator-http' : ''}`, tenant.routeLabel);
        await vi.waitFor(() => expect(browser.frames).toContainEqual(expect.objectContaining({
          type: 'session.bound', binding: expect.objectContaining({
            organizationId: tenant.session.organizationId, customerWorkspaceId: tenant.workspaceId, hostedSessionId: tenant.session.id,
          }),
        })));
        const channelId = browser.frames.find((frame) => frame.type === 'session.bound')!.channelId as string;
        await vi.waitFor(() => expect(host.frames).toContainEqual(expect.objectContaining({ type: 'relay.open', channelId })));
        connections.push({ tenant, host, browser, channelId, ticket, credential, issueTicket });
      }
      const [a, b] = connections;
      const authorize = async (connection: typeof a) => {
        const requestId = randomUUID();
        // Subject-shaped fields from the connector must never become authority.
        // Only the server's consumed ticket and current persisted records may.
        connection.host.socket.send(JSON.stringify({ type: 'session.authorize', channelId: connection.channelId, requestId,
          userId: USER_B, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B,
          hostedSessionId: sessionB.id, permissions: ['*'] }));
        await vi.waitFor(() => expect(connection.host.frames).toContainEqual(expect.objectContaining({
          type: 'session.authorized', channelId: connection.channelId, requestId,
        })));
        return connection.host.frames.find((frame) => frame.type === 'session.authorized' && frame.requestId === requestId)!.authority;
      };
      const expectBoundAuthority = (authority: unknown, connection: typeof a) => {
        expect(authority).toEqual({
          userId: connection.tenant.session.userId, sessionId: connection.tenant.session.id,
          sessionVersion: connection.tenant.session.permissionVersion,
          controlPlaneWorkspaceId: CONTROL, organizationId: connection.tenant.session.organizationId,
          customerWorkspaceId: connection.tenant.workspaceId,
          permissions: expect.arrayContaining(['workspace:operate']),
        });
        expect((authority as { permissions: string[] }).permissions).not.toContain('*');
      };
      if (rechecksAuthority) {
        const foreignRequestId = randomUUID();
        b.host.socket.send(JSON.stringify({ type: 'session.authorize', channelId: a.channelId, requestId: foreignRequestId }));
        // The valid same-socket exchange is a processing barrier: a foreign
        // channel is silently refused, rather than yielding an authority grant.
        expectBoundAuthority(await authorize(b), b);
        expect(b.host.frames.some((frame) => frame.requestId === foreignRequestId)).toBe(false);
        expectBoundAuthority(await authorize(a), a);
      }
      const replay = new WebSocket(`${socketUrl}?ticket=${a.ticket}`, { headers: { host: `${a.tenant.routeLabel}.workspaces.papercusp.com` } });
      const replayResult = new Promise<number>((resolve, reject) => {
        replay.once('unexpected-response', (_request, response) => {
          response.resume();
          response.once('end', () => { replay.terminate(); resolve(response.statusCode!); });
        });
        replay.once('open', () => { replay.terminate(); reject(new Error('replayed browser ticket upgraded')); });
        replay.on('error', () => {});
      });
      try { expect(await replayResult).toBe(401); } finally { replay.terminate(); }

      const input = rechecksAuthority
        ? { type: 'http.request', requestId: randomUUID(), method: 'GET', path: '/api/health' }
        : { type: 'pty.input', data: 'dGVuYW50LWE=' };
      a.browser.socket.send(JSON.stringify(input));
      await vi.waitFor(() => expect(a.host.frames).toContainEqual({ type: 'relay', channelId: a.channelId, payload: input }));
      const outputA = { type: rechecksAuthority ? 'http.response' : 'pty.output', data: 'cmVzcG9uc2UtYQ==' };
      a.host.socket.send(JSON.stringify({ type: 'relay', channelId: a.channelId, payload: outputA }));
      await vi.waitFor(() => expect(a.browser.frames).toContainEqual(outputA));

      // A same-socket valid response is a processing barrier for the preceding
      // forged cross-tenant channel id, so absence is not a timing-only check.
      const foreignOutput = { type: rechecksAuthority ? 'http.response' : 'pty.output', data: 'Zm9yZWlnbi1zZWNyZXQ=' };
      b.host.socket.send(JSON.stringify({ type: 'relay', channelId: a.channelId, payload: foreignOutput }));
      const outputB = { type: rechecksAuthority ? 'http.response' : 'pty.output', data: 'cmVzcG9uc2UtYg==' };
      b.host.socket.send(JSON.stringify({ type: 'relay', channelId: b.channelId, payload: outputB }));
      await vi.waitFor(() => expect(b.browser.frames).toContainEqual(outputB));
      expect(a.browser.frames).not.toContainEqual(foreignOutput);
      expect(b.host.frames).not.toContainEqual({ type: 'relay', channelId: a.channelId, payload: input });

      if (ending === 'disconnect') {
        a.browser.socket.close();
        await vi.waitFor(() => expect(a.host.frames).toContainEqual(expect.objectContaining({ type: 'relay.close', channelId: a.channelId })));
        const reconnected = await dial(`${socketUrl}?ticket=${await a.issueTicket()}`, a.tenant.routeLabel);
        await vi.waitFor(() => expect(reconnected.frames).toContainEqual(expect.objectContaining({ type: 'session.bound', role: 'controller' })));
        a.host.socket.close();
        await vi.waitFor(() => expect(reconnected.close).toEqual({ code: 4412, reason: 'connector_disconnected' }));
      } else if (ending === 'rotation') {
        await post(`/hosted/workspaces/${WORKSPACE_A}/connectors/rotate`, sessionA,
          { hostId: HOST_A, routeLabel: `network-a-${ending}-next`, transport: 'websocket' });
        await vi.waitFor(() => {
          expect(a.browser.close).toEqual({ code: 4001, reason: 'connector_rotated' });
          expect(a.host.close).toEqual({ code: 4001, reason: 'connector_rotated' });
        });
      } else {
        if (ending === 'session-expiry') {
          const expired = await sql<Array<{ id: string }>>`
            UPDATE papercusp_auth.hosted_sessions
               SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
             WHERE id = ${channelSession.id}
            RETURNING id
          `;
          expect(expired).toEqual([{ id: channelSession.id }]);
        } else if (ending === 'session-revocation') {
          expect(await plane.components.sessionStore.revoke(channelSession.id, 'channel_acceptance_logout')).toBe(true);
        } else if (ending === 'role-change') {
          const changed = await sql<Array<{ user_id: string }>>`
            UPDATE papercusp_auth.organization_memberships
               SET role = 'member', updated_at = updated_at + interval '2 seconds'
             WHERE organization_id = ${ORG_A}::uuid AND user_id = ${channelSession.userId}::uuid
            RETURNING user_id
          `;
          expect(changed).toEqual([{ user_id: channelSession.userId }]);
        } else {
          const revoked = await sql<Array<{ user_id: string }>>`
            UPDATE papercusp_auth.organization_memberships
               SET status = 'revoked', revoked_at = now(), updated_at = updated_at + interval '2 seconds'
             WHERE organization_id = ${ORG_A}::uuid AND user_id = ${channelSession.userId}::uuid
            RETURNING user_id
          `;
          expect(revoked).toEqual([{ user_id: channelSession.userId }]);
        }
        // Keep the already-open channel and original consumed ticket. A fresh
        // request must re-read authority, rather than reuse the prior grant.
        expect(await authorize(a)).toBeNull();
        expectBoundAuthority(await authorize(b), b);
        expect(a.browser.socket.readyState).toBe(WebSocket.OPEN);
        expect(a.host.socket.readyState).toBe(WebSocket.OPEN);
      }
      const survivor = { type: rechecksAuthority ? 'http.response' : 'pty.output', data: 'c3Vydml2b3I=' };
      b.host.socket.send(JSON.stringify({ type: 'relay', channelId: b.channelId, payload: survivor }));
      await vi.waitFor(() => expect(b.browser.frames).toContainEqual(survivor));
      expect(b.browser.socket.readyState).toBe(WebSocket.OPEN);
      expect(b.host.socket.readyState).toBe(WebSocket.OPEN);
      expect(upgradeErrors).toEqual([]);
    } finally {
      hosted.relay.dispose();
      for (const peer of peers) peer.socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('binds WS/PTY/file/MCP relay tickets to one tenant and rejects replay, rotation and revocation residue', async () => {
    const crossTenantEnroll = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_B}/connectors/enroll`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST_B, routeLabel: 'tenant-b', transport: 'websocket' }),
      },
    );
    expect(crossTenantEnroll.status, await crossTenantEnroll.clone().text()).toBe(403);

    const enrollment = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/connectors/enroll`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST_A, routeLabel: 'tenant-a', transport: 'websocket' }),
      },
    );
    expect(enrollment.status, await enrollment.clone().text()).toBe(200);
    const enrollmentBody = await enrollment.json() as { ticket: string };
    const registered = await request(plane, `/hosted/connectors/register?ticket=${enrollmentBody.ticket}`, undefined, {
      method: 'POST',
    });
    expect(registered.status).toBe(200);
    const credential = await registered.json() as { bearer: string };

    const issueTicket = () => request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/connectors/session-ticket`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostId: HOST_A,
          routeLabel: 'tenant-a',
          transport: 'websocket',
          audience: 'workspace-operator',
        }),
      },
    );

    const oneTime = await issueTicket();
    expect(oneTime.status).toBe(200);
    const oneTimeBody = await oneTime.json() as { ticket: string };
    const upgrade = new Request(
      `https://tenant-a.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${oneTimeBody.ticket}`,
    );
    const accepted = await authenticateHostedConnectorSocket(plane.components.connectorGateway!, upgrade);
    expect(accepted).toMatchObject({
      role: 'browser',
      binding: {
        organizationId: ORG_A,
        customerWorkspaceId: WORKSPACE_A,
        hostId: HOST_A,
        userId: USER_A,
        hostedSessionId: sessionA.id,
      },
    });
    await expect(
      authenticateHostedConnectorSocket(plane.components.connectorGateway!, upgrade),
    ).resolves.toBeNull();

    const relayTicketResponse = await issueTicket();
    const relayTicket = await relayTicketResponse.json() as { ticket: string };
    const relayAuth = await authenticateHostedConnectorSocket(
      plane.components.connectorGateway!,
      new Request(`https://tenant-a.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${relayTicket.ticket}`),
    );
    if (!relayAuth || relayAuth.role !== 'browser') throw new Error('expected a browser relay binding');
    const connectorBinding = await plane.components.connectorGateway!.authenticate(credential.bearer);
    if (!connectorBinding) throw new Error('expected an active connector binding');

    const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'p030-channel' });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    const foreignBrowser = new FakeSocket();
    broker.attachConnector(connectorBinding, host);
    broker.attachBrowser(relayAuth.binding, browser);
    broker.attachBrowser({ ...relayAuth.binding, organizationId: ORG_B, customerWorkspaceId: WORKSPACE_B }, foreignBrowser);
    browser.message({ type: 'pty.input', data: 'aGVsbG8=' });
    browser.message({ type: 'file.write', requestId: 'file-1', path: 'proof.txt', data: 'cHJvb2Y=' });
    browser.message({ type: 'mcp.call', requestId: 'mcp-1', method: 'tools/list' });
    expect(host.sent).toContainEqual({
      type: 'relay',
      channelId: 'p030-channel',
      payload: { type: 'pty.input', data: 'aGVsbG8=' },
    });
    expect(host.sent).toContainEqual(expect.objectContaining({
      type: 'relay',
      payload: expect.objectContaining({ type: 'file.write', requestId: 'file-1' }),
    }));
    expect(host.sent).toContainEqual(expect.objectContaining({
      type: 'relay',
      payload: expect.objectContaining({ type: 'mcp.call', requestId: 'mcp-1' }),
    }));
    expect(foreignBrowser.closed).toContainEqual([4411, 'connector_unavailable']);

    const staleTicketResponse = await issueTicket();
    const staleTicket = await staleTicketResponse.json() as { ticket: string };
    const rotated = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/connectors/rotate`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: HOST_A, routeLabel: 'tenant-a-next', transport: 'websocket' }),
      },
    );
    expect(rotated.status).toBe(200);
    await expect(plane.components.connectorGateway!.authenticate(credential.bearer)).resolves.toBeNull();
    await expect(
      authenticateHostedConnectorSocket(
        plane.components.connectorGateway!,
        new Request(`https://tenant-a.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${staleTicket.ticket}`),
      ),
    ).resolves.toBeNull();

    // Register the new generation before revoking it: the same bearer and
    // unconsumed ticket must work while authorized and fail after revocation.
    const rotation = await rotated.json() as { ticket: string };
    const nextRegistration = await request(
      plane, `/hosted/connectors/register?ticket=${rotation.ticket}`, undefined, { method: 'POST' },
    );
    expect(nextRegistration.status).toBe(200);
    const nextCredential = await nextRegistration.json() as { bearer: string };
    const nextBinding = { hostId: HOST_A, routeLabel: 'tenant-a-next', transport: 'websocket' };
    const nextTicket = await request(
      plane, `/hosted/workspaces/${WORKSPACE_A}/connectors/session-ticket`, sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nextBinding) },
    );
    expect(nextTicket.status).toBe(200);
    const beforeRevocationTicket = await nextTicket.json() as { ticket: string };
    const connectorUpgrade = new Request(
      'https://tenant-a-next.workspaces.papercusp.com/api/hosted/connectors/socket',
      { headers: { authorization: `Bearer ${nextCredential.bearer}` } },
    );
    await expect(authenticateHostedConnectorSocket(plane.components.connectorGateway!, connectorUpgrade))
      .resolves.toMatchObject({ role: 'connector', binding: { state: 'active', routeLabel: 'tenant-a-next' } });

    const revoked = await request(
      plane, `/hosted/workspaces/${WORKSPACE_A}/connectors/revoke`, sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nextBinding) },
    );
    expect(revoked.status).toBe(200);
    await expect(authenticateHostedConnectorSocket(plane.components.connectorGateway!, connectorUpgrade))
      .resolves.toBeNull();
    await expect(authenticateHostedConnectorSocket(
      plane.components.connectorGateway!,
      new Request(`https://tenant-a-next.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${beforeRevocationTicket.ticket}`),
    )).resolves.toBeNull();
    const afterRevocationTicket = await request(
      plane, `/hosted/workspaces/${WORKSPACE_A}/connectors/session-ticket`, sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nextBinding) },
    );
    expect(afterRevocationTicket.status).toBe(409);
    const revokedHeartbeat = await request(
      plane, '/hosted/connectors/heartbeat', undefined,
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nextCredential.bearer}` },
        body: JSON.stringify({ transport: 'websocket' }) },
    );
    expect(revokedHeartbeat.status).toBe(401);
  });

  it('keeps delegation and session authority tenant-bound across a control-plane restart and revocation', async () => {
    const body = {
      connectionId: CONNECTION_A,
      label: 'Same cloud connection',
      credentialRef: 'delegation://tenant-a/gcp/connection-tenant-a/1',
      configuration: {
        provider: 'gcp',
        source: {
          method: 'service-account-impersonation',
          projectId: 'tenant-a-project',
          serviceAccountEmail: 'runtime@tenant-a-project.iam.gserviceaccount.com',
          trustedPrincipal: 'principal://papercusp/tenant-a',
        },
      },
    };
    const foreign = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_B}/provider-delegations/onboard`,
      sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    expect(foreign.status, await foreign.clone().text()).toBe(403);

    const onboard = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/provider-delegations/onboard`,
      sessionA,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    expect(onboard.status, await onboard.clone().text()).toBe(201);
    const verify = await request(
      plane,
      `/hosted/workspaces/${WORKSPACE_A}/provider-delegations/verify`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONNECTION_A }),
      },
    );
    expect(verify.status).toBe(200);

    const restarted = await createHostedRuntime(CONFIGURATION, runtimeDependencies());
    const resolverProbe = `${HOSTED_BROWSER_REST_QUERY_PATH}?name=${HOSTED_BROWSER_QUERY_NAME}&args=%7B%7D`;
    const sessionAfterRestart = await request(restarted, resolverProbe, sessionA);
    expect(sessionAfterRestart.status, await sessionAfterRestart.clone().text()).toBe(200);
    const verifyAfterRestart = await request(
      restarted,
      `/hosted/workspaces/${WORKSPACE_A}/provider-delegations/verify`,
      sessionA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONNECTION_A }),
      },
    );
    expect(verifyAfterRestart.status).toBe(200);

    const oldVersion = sessionA.permissionVersion;
    await sql`
      UPDATE papercusp_auth.organization_memberships
         SET role = 'member', updated_at = updated_at + interval '2 seconds'
       WHERE organization_id = ${ORG_A}::uuid AND user_id = ${USER_A}::uuid
    `;
    const revokedAt = Date.now();
    const staleSession = await request(restarted, resolverProbe, sessionA);
    expect(staleSession.status).toBe(401);
    expect(Date.now() - revokedAt).toBeLessThan(60_000);
    expect(sessionA.permissionVersion).toBe(oldVersion);
    await expect(
      runService((tx) =>
        tx`
          UPDATE papercusp_auth.organization_memberships
             SET role = 'owner', updated_at = updated_at + interval '2 seconds'
           WHERE organization_id = ${ORG_A}::uuid AND user_id = ${USER_A}::uuid
        `,
      ),
    ).rejects.toThrow(/hosted_service may only reduce membership lifecycle state/);

    const liveTenantB = await request(restarted, resolverProbe, sessionB);
    expect(liveTenantB.status).toBe(200);
    await sql`
      UPDATE papercusp_auth.organization_memberships
         SET status = 'revoked', revoked_at = now(), updated_at = updated_at + interval '2 seconds'
       WHERE organization_id = ${ORG_B}::uuid AND user_id = ${USER_B}::uuid
    `;
    const revokedSession = await request(restarted, resolverProbe, sessionB);
    expect(revokedSession.status).toBe(403);
  });

  it('keeps support grants scoped, expiring, revoke-only, and unable to widen customer RLS', async () => {
    const [grant] = await sql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.support_access_grants
        (organization_id, workspace_id, staff_principal_id, granted_by_user_id,
         purpose, scopes, banner_message, starts_at, expires_at)
      VALUES
        (${ORG_A}::uuid, ${WORKSPACE_A}::uuid, 'staff-p030', ${USER_A}::uuid,
         'P-030 acceptance', ARRAY['workspace.view'], 'Support access active',
         now() - interval '1 minute', now() + interval '5 minutes')
      RETURNING id::text AS id
    `;
    const foreignRows = await runTenant(tenantContext(sessionB), (tx) =>
      tx<Array<{ id: string }>>`SELECT id FROM harness_shared.workspace_hosts ORDER BY id`,
    );
    expect(foreignRows.map(({ id }) => id)).toEqual([HOST_B]);

    await sql`
      UPDATE papercusp_auth.support_access_grants
         SET revoked_at = now(), revoked_by_user_id = ${USER_A}::uuid,
             revocation_reason = 'acceptance complete', updated_at = now()
       WHERE id = ${grant.id}::uuid
    `;
    await expect(
      sql<Array<{ id: string }>>`
        UPDATE papercusp_auth.support_access_grants
           SET revoked_at = now(), revoked_by_user_id = ${USER_A}::uuid,
               revocation_reason = 'second attempt', updated_at = now()
         WHERE id = ${grant.id}::uuid
         RETURNING id::text AS id
      `,
    ).rejects.toThrow(/revocation is immutable/);

    const [expired] = await sql<Array<{ id: string }>>`
      INSERT INTO papercusp_auth.support_access_grants
        (organization_id, workspace_id, staff_principal_id, granted_by_user_id,
         purpose, scopes, banner_message, starts_at, expires_at)
      VALUES
        (${ORG_A}::uuid, ${WORKSPACE_A}::uuid, 'staff-p030-expired', ${USER_A}::uuid,
         'Expired P-030 acceptance', ARRAY['workspace.view'], 'Expired support access',
         now() - interval '2 minutes', now() - interval '1 minute')
      RETURNING id::text AS id
    `;
    expect(expired.id).toBeTruthy();
  });
});

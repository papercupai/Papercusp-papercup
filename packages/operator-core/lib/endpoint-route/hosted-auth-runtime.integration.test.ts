/** P-537: the production callback composes real identity, session and trial stores. */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createFakeHostedIdentityProvider } from '../auth/hosted/fake-provider';
import type { HostedIdentityProvider } from '../auth/hosted/provider';
import { PostgresHostedSelfSignupAdmission, HOSTED_SELF_SIGNUP_TERMS_VERSION,
  HOSTED_SELF_SIGNUP_PRIVACY_VERSION } from '../auth/hosted/self-signup';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { readHostedEntitlementAuthority, writeHostedEntitlementAuthority,
  type HostedTrialEntitlementPolicy } from '../auth/hosted-entitlement-store';
import { createHostedAuthRuntime } from './hosted-auth-runtime';
import { createHostedRuntime, type HostedRuntimeDependencies } from './hosted-runtime';
import { createHostedHandlerFromEnvironment, type HostedHandler } from '../../../../apps/operator/bin/hosted-handler';
import { HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV } from '../auth/hosted/first-workspace-dependencies';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult } from './routes/hosted-auth/flow';
import { HOSTED_AUTH_FLOW_COOKIE } from './routes/hosted-auth';
import { HOSTED_SESSION_COOKIE } from '../auth/hosted-session';
import { HOSTED_BROWSER_FIRST_WORKSPACE_PATH } from './hosted-browser';
import { createHostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import { PostgresHostedBillingStore } from '../auth/hosted/billing/billing-store';
import { parseHostedPaidEntitlementBundle } from '../auth/hosted/billing/entitlement-seam';
import { computeStripeSignature } from '../cupboard/payment-adapters/stripe';
import { createHostedBillingRuntime } from './hosted-billing-runtime';
import { firstWorkspaceIdentity } from '../auth/hosted/first-workspace';
import { launchWithHostedAgentSlot, reserveHostedAgentSlot } from '../workspace-host/hosted-agent-admission-client';
import { admitHostedLifecycleJob, recordHostedPoolActivity,
  type AdmitHostedLifecycleJobInput } from '../workspace-host/hosted-lifecycle-store';

const h = vi.hoisted(() => ({ provider: undefined as unknown as HostedIdentityProvider,
  sql: null as unknown as Sql, adminSql: null as unknown as Sql, admissionErrors: [] as string[] }));
// Keep the production reservation path intact, retaining its otherwise hidden
// failure only in this test process. Public HTTP errors remain content-free.
vi.mock('../workspace-host/hosted-agent-admission', async original => {
  const actual = await original<typeof import('../workspace-host/hosted-agent-admission')>();
  return { ...actual, createHostedPoolAgentReservations: (...args: Parameters<typeof actual.createHostedPoolAgentReservations>) => {
    const reserve = actual.createHostedPoolAgentReservations(...args);
    return async (...input: Parameters<typeof reserve>) => {
      try { return await reserve(...input); }
      catch (error) {
        const value = error as Error & { code?: string; cause?: unknown };
        h.admissionErrors.push(`${input[0]}: ${value.name}: ${value.message}; code=${value.code ?? ''}; cause=${String(value.cause ?? '')}`);
        throw error;
      }
    };
  } };
});
// Keep the workspace transaction and harness_app RLS, selecting this test's DB.
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  // The production agent HTTP route resolves its canonical admin ledger here.
  // Select the same isolated PG as the role-scoped workspace/service clients.
  getOrgPg: () => ({ sql: h.adminSql }),
  withWorkspace: <T>(workspaceId: string, run: (tx: Sql) => Promise<T>) => h.sql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return run(tx as unknown as Sql);
  }),
}));
// Provider catalog and release discovery are the external seams. Admission,
// delegation persistence, resource quotas and enqueue ordering remain real.
vi.mock('../workspace-host/gcp-provider', () => ({ createConfiguredGcpWorkspaceHostProvider: () => ({
  listSizes: async () => [{ id: 'e2-standard-4', available: true, cpuCount: 4, memoryMiB: 16384, architectures: ['x86_64'] }],
  listImages: async () => [{ id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918', architecture: 'x86_64' }],
  estimatePrice: async () => ({ monthlyAmount: 50, hourlyAmount: 50 / 730,
    currency: 'USD', confidence: 'high', observedAt: new Date().toISOString() }),
}) }));
vi.mock('../workspace-host/provisioning-runner', async original => ({
  ...(await original<typeof import('../workspace-host/provisioning-runner')>()),
  resolveControllerWorkspaceHostBootstrap: async () => ({ runtimeRelease: { bundleSha256: 'a'.repeat(64) } }),
}));
vi.mock('../sync-sse', async original => ({
  ...(await original<typeof import('../sync-sse')>()), notifySyncInvalidate: vi.fn(),
}));
// Replace the upstream IdP and OAuth nonce storage only. The actual callback,
// membership binder, hosted roles, session persistence and entitlement store run.
vi.mock('../auth/hosted/workos-provider', () => ({ createWorkOSHostedIdentityProvider: () => h.provider }));
vi.mock('../cloud-telemetry-posthog', () => ({ deliverCloudPosthog: async () => undefined }));
vi.mock('./routes/hosted-auth/flow', () => ({
  OAuthHostedAuthFlowStore: class {
    private readonly flows = new Map<string, HostedAuthFlow>();
    async create(flow: HostedAuthFlow) { const id = randomUUID(); this.flows.set(id, flow); return id; }
    async consume(id: string): Promise<HostedAuthFlowConsumeResult> {
      const flow = this.flows.get(id); this.flows.delete(id);
      return flow ? { ok: true, flow } : { ok: false, error: 'already-consumed' };
    }
  },
}));

const configuration = {
  publicOrigin: 'https://app.papercusp.com', controlPlaneWorkspaceId: 'hosted-control-plane',
  hostedSessionCookieSecretRef: 'env:COOKIE', workosClientId: 'client-test',
  workosApiKeyRef: 'env:KEY', workosCookiePasswordRef: 'env:PASSWORD',
};
function policy(cpuMillicores = 4000): HostedTrialEntitlementPolicy {
  return { assignmentDurationMs: 86_400_000, bundle: {
    schemaVersion: 1, bundleId: 'callback-trial-fixture', bundleVersion: 1,
    record: { source: 'trial', actor: { kind: 'service', principalId: 'service:trial-policy' },
      auditReceiptId: 'trial-policy:callback-fixture', effectiveFrom: new Date('2020-01-01'), effectiveUntil: null },
    entitlements: { allowedProviders: ['gcp'], limits: { workspaces: 1, members: 1 },
      browserAccess: { pty: true, files: true }, supportTier: 'trial',
      quotas: { 'pool.agents': 50, 'pool.hosts': 1, 'pool.cpu-millicores': cpuMillicores,
        'pool.memory-mib': 16384, 'pool.db-gib': 256, 'pool.workspace-gib': 100 },
      budgets: { 'pool.cost.usd.minor': 10000 }, rolloutFlags: {} },
  } };
}

describe.each(['auth-only', 'full-control-plane', 'environment-handler'] as const)('configured hosted authentication trial rollout (%s, real PG + HTTP)', runtimeKind => {
  let db: OrgTestDb;
  const servers = new Set<ReturnType<typeof serve>>();
  const handlers = new Set<HostedHandler>();
  const pending = new Set<Promise<unknown>>();
  const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
    const task = db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
    pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.appSql;
    h.adminSql = db.adminSql;
    let billingMigration: string;
    try {
      billingMigration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql.DRAFT', import.meta.url), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      billingMigration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(billingMigration);
    await db.adminSql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1524-hosted-entitlement-authority.sql', import.meta.url), 'utf8'));
  }, 180_000);
  afterAll(async () => {
    await Promise.all([...servers].map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    })));
    for (const handler of handlers) handler.relay.dispose();
    await Promise.allSettled([...pending]); await db?.cleanup();
  });

  async function requestFor(app: Pick<Hono, 'fetch'>) {
    const server = serve({ fetch: request => {
      // Native fetch rewrites Host to the loopback URL in this runtime. Fail
      // before product routing if the test transport loses the public hostname.
      expect(new URL(request.url).hostname).toBe(new URL(configuration.publicOrigin).hostname);
      return app.fetch(request);
    }, hostname: '127.0.0.1', port: 0 });
    servers.add(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('private hosted HTTP listener unavailable');
    return (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      // Exercise production hostname authentication over an owned local socket.
      headers.set('host', new URL(configuration.publicOrigin).host);
      if (init?.body != null && typeof init.body !== 'string') throw new Error('private hosted HTTP body must be text');
      return new Promise<Response>((resolve, reject) => {
        const outgoing = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
          method: init?.method ?? 'GET', headers: Object.fromEntries(headers), agent: false,
        }, incoming => {
          const chunks: Buffer[] = [];
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
          incoming.on('error', reject);
          incoming.on('end', () => {
            const received = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
              received.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            }
            const status = incoming.statusCode!;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: received }));
          });
        });
        outgoing.on('error', reject);
        outgoing.end(init?.body ?? undefined);
      });
    };
  }

  async function fixture(trialEntitlementPolicy?: HostedTrialEntitlementPolicy, pooled = false, expectedRevision = 1) {
    const identity = { externalUserId: `callback-${randomUUID()}`, primaryEmail: `${randomUUID()}@example.test`,
      emailVerified: true as const, displayName: 'Callback Member' };
    const admitted = await new PostgresHostedSelfSignupAdmission(runService).complete({
      attemptId: randomUUID(), providerId: 'workos', identity, upstreamSessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 3_600_000), acceptedAt: new Date(),
      termsVersion: HOSTED_SELF_SIGNUP_TERMS_VERSION, privacyVersion: HOSTED_SELF_SIGNUP_PRIVACY_VERSION,
    });
    if (!admitted.ok) throw new Error(`fixture admission failed: ${admitted.code}`);
    const createdAt = new Date(Date.now() - 3_600_000);
    await db.adminSql`UPDATE papercusp_auth.hosted_entitlements SET created_at = ${createdAt}
      WHERE organization_id = ${admitted.binding.organizationId}::uuid`;
    const provider = createFakeHostedIdentityProvider({ providerId: 'workos', nowMs: Date.now(),
      session: { externalSessionId: randomUUID(), identity, issuedAtMs: Date.now() - 1000,
        authenticatedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 3_600_000,
        authenticationMethods: ['pwd'], mfaVerified: false } });
    h.provider = provider;
    const enqueue = vi.fn(async (input: { operationId?: string }) => {
      if (!input.operationId) throw new Error('first-workspace must commit an operation before enqueue');
      const rows = await db.adminSql`SELECT admission_receipt FROM harness_shared.workspace_host_operations
        WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND id = ${input.operationId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].admission_receipt.result.resourceAdmission.authorityRevision).toBe(expectedRevision);
      return { workflowId: `fixture:${input.operationId}` };
    });
    const adapter = { verify: async () => ({ identity: 'gcp:fixture', evidenceRef: 'fixture:verified-delegation' }),
      revoke: async () => ({ evidenceRef: 'fixture:revoked-delegation' }) };
    const dependencies: HostedRuntimeDependencies = {
      runService, resolveSecret: async () => 'callback-fixture-cookie-secret-at-least-32-bytes',
      ...(pooled ? {
        providerDelegationAdapters: { gcp: adapter, aws: adapter, azure: adapter },
        delegationOrganization: (organizationId: string) => ({ organizationId,
          gcpTrustedPrincipal: async () => `serviceAccount:pco-${organizationId}@fixture.iam.gserviceaccount.com`,
          gcpPapercuspHosting: async () => ({ projectId: 'fixture-hosting',
            serviceAccountEmail: `pco-${organizationId}@fixture.iam.gserviceaccount.com` }),
          awsTrustedPrincipal: async () => { throw new Error('unexpected AWS delegation'); },
          awsPapercuspHosting: async () => { throw new Error('unexpected AWS hosting'); },
        }),
        hostedBrowser: { provisioning: { enqueue } },
      } : {}),
    };
    // The production entrypoint must parse the policy and allowlist itself,
    // then serve its final restricted handler rather than the runtime's app.
    const handler = runtimeKind === 'environment-handler'
      ? await createHostedHandlerFromEnvironment({
          PAPERCUSP_HOSTED_PUBLIC_ORIGIN: configuration.publicOrigin,
          PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: configuration.controlPlaneWorkspaceId,
          PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: configuration.hostedSessionCookieSecretRef,
          WORKOS_CLIENT_ID: configuration.workosClientId,
          WORKOS_API_KEY_REF: configuration.workosApiKeyRef,
          WORKOS_COOKIE_PASSWORD_REF: configuration.workosCookiePasswordRef,
          WORKOS_WEBHOOK_SECRET_REF: 'env:WEBHOOK',
          ...(trialEntitlementPolicy ? { PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT: JSON.stringify(trialEntitlementPolicy) } : {}),
          ...(pooled ? { [HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV]: admitted.binding.organizationId } : {}),
        }, dependencies)
      : undefined;
    if (handler) handlers.add(handler);
    const runtime = handler?.plane ?? (runtimeKind === 'auth-only'
      ? await createHostedAuthRuntime({ ...configuration, trialEntitlementPolicy }, dependencies)
      : await createHostedRuntime({ ...configuration, workosWebhookSecretRef: 'env:WEBHOOK',
          trialEntitlementPolicy, ...(pooled ? { firstWorkspaceOrganizations: new Set([admitted.binding.organizationId]) } : {}) }, dependencies));
    const request = await requestFor(handler?.app ?? runtime.app);
    async function callback(invalidState = false, intent: 'sign-in' | 'sign-up' = 'sign-in') {
      h.provider = provider;
      const start = await request(`/api/hosted/auth/sign-in?returnTo=%2Fworkspaces&intent=${intent}`);
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const cookie = start.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_AUTH_FLOW_COOKIE}=([^;,]+)`))![1];
      const response = await request(`/api/hosted/auth/callback?code=valid&state=${invalidState ? randomUUID() : state}`, {
        headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${cookie}` },
      });
      // onSessionEstablished is intentionally a nonblocking metadata observer.
      // Drain its actual service transaction, rather than assuming a redirect is proof.
      await Promise.all([...pending]);
      return response;
    }
    const stored = async () => (await db.adminSql`SELECT authority, authority_revision
      FROM papercusp_auth.hosted_entitlements WHERE organization_id = ${admitted.binding.organizationId}::uuid`)[0]!;
    return { ...admitted.binding, createdAt, callback, stored, provider, runtime, request, enqueue };
  }

  if (runtimeKind !== 'auth-only') it('admits a configured trial from callback through first-workspace HTTP before enqueue', async () => {
    const f = await fixture(policy(), true);
    const signedIn = await f.callback();
    const sessionCookie = signedIn.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_SESSION_COOKIE}=([^;,]+)`))![1];
    const response = await f.request(`/api${HOSTED_BROWSER_FIRST_WORKSPACE_PATH}`, {
      method: 'POST', headers: { origin: configuration.publicOrigin, 'content-type': 'application/json',
        cookie: `${HOSTED_SESSION_COOKIE}=${sessionCookie}` },
      body: JSON.stringify({ attemptKey: 'attempt-0123456789abcdef', displayName: 'Trial workspace',
        label: 'Trial hosting', hosting: 'papercusp', organizationId: randomUUID(),
        quotas: { 'pool.db-gib': 100000 }, resourceAdmission: { allowed: true } }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    const [operation] = await db.adminSql`SELECT admission_receipt FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND id = ${result.provisionOperationId}`;
    expect(operation.admission_receipt.result).toMatchObject({ organizationId: f.organizationId,
      resourceAdmission: { authorityRevision: 1, storage: { capacity: { dbGiB: 8, workspaceGiB: 2 } } } });
    const [host] = await db.adminSql`SELECT desired_spec FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND id = ${operation.admission_receipt.result.hostId}`;
    expect(host.desired_spec.data.allocation.dbGiB + host.desired_spec.data.allocation.workspaceGiB)
      .toBe(host.desired_spec.data.volumeGiB);
  });

  if (runtimeKind !== 'auth-only') it('protects an actual native child and viewer from idle stop, then fences new starts', async () => {
    const base = policy();
    const trial = { ...base, bundle: { ...base.bundle, entitlements: { ...base.bundle.entitlements,
      quotas: { ...base.bundle.entitlements.quotas, 'pool.agents': 1, 'pool.idle-stop-minutes': 5 } } } };
    const f = await fixture(trial, true);
    const signedIn = await f.callback();
    const cookie = signedIn.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_SESSION_COOKIE}=([^;,]+)`))![1];
    const first = await f.request(`/api${HOSTED_BROWSER_FIRST_WORKSPACE_PATH}`, {
      method: 'POST', headers: { origin: configuration.publicOrigin, 'content-type': 'application/json',
        cookie: `${HOSTED_SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify({ attemptKey: 'native-attempt-0123456789abcdef',
        displayName: 'Native trial workspace', label: 'Native hosting', hosting: 'papercusp' }),
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const result = await first.json();
    const ws = configuration.controlPlaneWorkspaceId;
    const [operation] = await db.adminSql`SELECT admission_receipt FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${ws} AND id = ${result.provisionOperationId}`;
    const { hostId, customerWorkspaceId } = operation.admission_receipt.result;
    const [host] = await db.adminSql`SELECT host_generation, controller_fence, desired_revision
      FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} AND id = ${hostId}`;
    // Provider completion is the external seam: no cloud VM is purchased by
    // this test. The HTTP/runtime, RLS, connector and admission ledger stay real.
    await db.adminSql`UPDATE harness_shared.workspace_host_operations SET status = 'succeeded'
      WHERE workspace_id = ${ws} AND id = ${result.provisionOperationId}`;
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'active'
      WHERE workspace_id = ${ws} AND id = ${customerWorkspaceId} AND state = 'provisioning'`;
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET observed_state = 'running',
      observed_revision = desired_revision, pool_observation = ${JSON.stringify({
        generation: Number(host.host_generation), controllerFence: Number(host.controller_fence),
        desiredRevision: Number(host.desired_revision), observedAtMs: Date.now(),
      })}::jsonb WHERE workspace_id = ${ws} AND id = ${hostId}`;
    if (!('connectorGateway' in f.runtime.components) || !f.runtime.components.connectorGateway) {
      throw new Error('full hosted runtime must compose its production connector gateway');
    }
    const gateway = f.runtime.components.connectorGateway;
    const enrollment = await gateway.enroll({ controlPlaneWorkspaceId: ws,
      organizationId: f.organizationId, customerWorkspaceId, hostId,
      routeLabel: 'native-trial', transport: 'websocket' });
    const registered = await f.request('/api/hosted/connectors/register', {
      method: 'POST', headers: { 'x-papercusp-connector-ticket': enrollment.ticket },
    });
    expect(registered.status, await registered.clone().text()).toBe(200);
    const credential = await registered.json();
    const binding = { ...credential.binding, hosting: 'papercusp' as const };
    // Preflight every prerequisite before launching a native child. Earlier
    // attempts exposed an incomplete provider-completion fixture and an opaque
    // HTTP refusal; neither should require another full run to distinguish.
    const [readyCustomer] = await db.adminSql`SELECT state, workspace_host_id FROM harness_shared.customer_workspaces
      WHERE workspace_id = ${ws} AND id = ${customerWorkspaceId}`;
    expect(readyCustomer).toMatchObject({ state: 'active', workspace_host_id: hostId });
    const [readyHost] = await db.adminSql`SELECT observed_state, observed_revision, desired_revision, pool_observation,
      host_generation, controller_fence FROM harness_shared.workspace_hosts WHERE workspace_id = ${ws} AND id = ${hostId}`;
    expect(readyHost.observed_state).toBe('running');
    expect(readyHost.observed_revision).toBe(readyHost.desired_revision);
    expect(readyHost.pool_observation).toMatchObject({ generation: Number(readyHost.host_generation),
      controllerFence: Number(readyHost.controller_fence), desiredRevision: Number(readyHost.desired_revision) });
    expect(await gateway.authenticate(credential.bearer)).toMatchObject({ state: 'active',
      customerWorkspaceId, hostId, organizationId: f.organizationId, generation: binding.generation });
    const authority = await runService(sql => readHostedEntitlementAuthority(sql, f.organizationId));
    expect(authority).toMatchObject({ ok: true, authorityRevision: 1, resolution: { quotas: { 'pool.agents': 1 } } });
    const env = { PAPERCUSP_SID: `native-test-${randomUUID()}`,
      PAPERCUSP_HOSTED_CONNECTOR_BEARER: credential.bearer,
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: configuration.publicOrigin };
    h.admissionErrors.length = 0;
    const actions: Array<{ action: string; status: number; receiptId?: string; state?: string; body: string }> = [];
    const http: typeof fetch = async (url, init) => {
      const response = await f.request(new URL(String(url)).pathname, init);
      const body = await response.clone().text();
      const value = JSON.parse(body);
      actions.push({ action: JSON.parse(String(init!.body)).action, status: response.status,
        receiptId: value.receiptId, state: value.state, body });
      return response;
    };
    const reserve = async (key: string, childEnv?: NodeJS.ProcessEnv) => {
      try { return await reserveHostedAgentSlot(key, childEnv, http); }
      catch (error) {
        throw new Error(`${(error as Error).message}; HTTP=${JSON.stringify(actions)}; reservation=${JSON.stringify(h.admissionErrors)}`, { cause: error });
      }
    };
    const stop: AdmitHostedLifecycleJobInput = {
      workspaceId: ws, customerWorkspaceId, hostId, providerTarget: 'gcp', action: 'stop',
      actorId: 'service:idle-sweep', operationId: `idle-${randomUUID()}`, idleStop: true,
      billingOwner: { kind: 'organization', id: f.organizationId },
      riskTier: 'low', approvalStatus: 'not-required',
      estimate: { cents: 0, currency: 'USD', source: 'fixture-provider', evidenceRef: 'fixture:stop',
        estimatedAt: new Date().toISOString() }, request: { hostId, action: 'stop' },
    };
    const ageActivity = () => db.adminSql`UPDATE harness_shared.customer_workspaces
      SET last_activity_at = now() - interval '1 hour' WHERE workspace_id = ${ws} AND id = ${customerWorkspaceId}`;
    const receipts = () => db.adminSql`SELECT receipt_id, state, record FROM harness_shared.resource_governor_admissions
      WHERE workspace_id = ${ws} AND record->'metadata'->>'hostedCustomerWorkspaceId' = ${customerWorkspaceId}`;
    expect(await recordHostedPoolActivity(binding, { activeCommands: 0, attachedViewers: 0 })).toBe(true);
    await ageActivity();
    let child: ChildProcess | undefined;
    let settled: Promise<void> | undefined;
    try {
      await launchWithHostedAgentSlot(env, finish => {
        child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
          { stdio: ['pipe', 'ignore', 'ignore'] });
        settled = (async () => { const [code] = await once(child!, 'exit'); expect(code).toBe(0); await finish(); })();
      }, reserve);
      expect(child?.pid).toBeGreaterThan(0);
      expect(actions.map(x => [x.action, x.status, x.state])).toEqual([
        ['reserve', 200, 'queued'], ['start', 200, 'running'],
      ]);
      expect(await receipts()).toMatchObject([{ state: 'running', record: { metadata: {
        hostedOrganizationId: f.organizationId, hostedHostId: hostId, hostedConnectorGeneration: binding.generation,
      } } }]);
      const refusedSpawn = vi.fn();
      await expect(launchWithHostedAgentSlot({ ...env, PAPERCUSP_HOSTED_NATIVE_SLOT: '' }, refusedSpawn, reserve))
        .rejects.toThrow('hosted_pool_agent_admission_refused');
      expect(refusedSpawn).not.toHaveBeenCalled();
      // Even a fresh zero-work report cannot erase a real running receipt.
      await expect(admitHostedLifecycleJob(stop)).rejects.toThrow('hosted_pool_idle_active_work');
      expect(child?.exitCode).toBeNull();
    } finally {
      child?.stdin?.end();
      await settled;
    }
    expect(actions.at(-1)).toMatchObject({ action: 'finish', status: 200, state: 'cancelled',
      receiptId: actions[0].receiptId });
    expect(await receipts()).toMatchObject([{ state: 'cancelled' }]);
    expect(await recordHostedPoolActivity(binding, { activeCommands: 0, attachedViewers: 1 })).toBe(true);
    await ageActivity();
    await expect(admitHostedLifecycleJob(stop)).rejects.toThrow('hosted_pool_idle_active_work');
    expect(await recordHostedPoolActivity(binding, { activeCommands: 0, attachedViewers: 0 })).toBe(true);
    await ageActivity();
    await db.adminSql`UPDATE harness_shared.workspace_hosts
      SET pool_observation = jsonb_set(pool_observation, '{workload,observedAtMs}',
        ${JSON.stringify(Date.now() - 90_000)}::jsonb) WHERE workspace_id = ${ws} AND id = ${hostId}`;
    await expect(admitHostedLifecycleJob(stop)).rejects.toThrow('hosted_pool_idle_workload_unverified');
    expect(await recordHostedPoolActivity(binding, { activeCommands: 0, attachedViewers: 0 })).toBe(true);
    const stopped = await admitHostedLifecycleJob(stop);
    expect(stopped).toMatchObject({ created: true, action: 'stop', idleStop: {
      authorityRevision: 1, idleStopAfterMinutes: 5, connectorGeneration: binding.generation,
      hostGeneration: Number(host.host_generation), controllerFence: Number(host.controller_fence),
    } });
    const fencedSpawn = vi.fn();
    await expect(launchWithHostedAgentSlot({ ...env, PAPERCUSP_HOSTED_NATIVE_SLOT: '' }, fencedSpawn, reserve))
      .rejects.toThrow('hosted_pool_agent_admission_refused');
    expect(fencedSpawn).not.toHaveBeenCalled();
    expect(await receipts()).toMatchObject([{ state: 'cancelled' }]);
  }, 30_000);

  if (runtimeKind !== 'auth-only') it('uses signed configured billing authority for paid admission and revokes it without deleting retained state', async () => {
    const f = await fixture(policy(2000), true, 2);
    const signedIn = await f.callback();
    expect(signedIn.status).toBe(303);
    const sessionCookie = signedIn.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_SESSION_COOKIE}=([^;,]+)`))![1];
    const headers = { origin: configuration.publicOrigin, 'content-type': 'application/json',
      cookie: `${HOSTED_SESSION_COOKIE}=${sessionCookie}` };
    const attemptKey = 'paid-attempt-0123456789abcdef';
    const identity = firstWorkspaceIdentity(f.organizationId, attemptKey);
    const firstWorkspace = () => f.request(`/api${HOSTED_BROWSER_FIRST_WORKSPACE_PATH}`, {
      method: 'POST', headers, body: JSON.stringify({ attemptKey, displayName: 'Paid workspace',
        label: 'Paid hosting', hosting: 'papercusp',
        quotas: { 'pool.cpu-millicores': 100000 }, resourceAdmission: { allowed: true } }),
    });
    async function rejectedFirstWorkspace() {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await firstWorkspace();
        expect(log).toHaveBeenCalledExactlyOnceWith(
          `[hosted-first-workspace] admission failed for host ${identity.hostId}`,
          { code: 'provisioning_failure', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
        );
        return response;
      } finally {
        log.mockRestore();
      }
    }
    const trial = await f.stored();
    const denied = await rejectedFirstWorkspace();
    expect(denied.status).toBe(500);
    expect(await denied.json()).toMatchObject({ ok: false, error: 'workspace_admission_failed' });
    expect(f.enqueue).not.toHaveBeenCalled();
    // Admission creates a draft directory/binding before checking the pool.
    // Rejection must leave no operation, cloud resource or dispatched work.
    expect(await db.adminSql`SELECT id FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND host_id = ${identity.hostId}`).toHaveLength(0);
    expect(await db.adminSql`SELECT 1 FROM harness_shared.workspace_host_resources
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND host_id = ${identity.hostId}`).toHaveLength(0);
    expect(await db.adminSql`SELECT id FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND id = ${identity.hostId}`).toHaveLength(1);

    const other = await fixture(policy());
    expect((await other.callback()).status).toBe(303);
    const otherTrial = await other.stored();
    const customerId = `cus_${randomUUID().replaceAll('-', '')}`;
    const subscriptionId = `sub_${randomUUID().replaceAll('-', '')}`;
    // Checkout's external customer-creation boundary is seeded; policy projection
    // and webhook persistence use the runtime's default production store.
    await new PostgresHostedBillingStore(runService).recordCustomer({
      organizationId: f.organizationId, stripeCustomerId: customerId, livemode: false,
    });
    const paidPolicy = policy().bundle;
    const bundle = parseHostedPaidEntitlementBundle({ ...paidPolicy, bundleId: 'paid-http-fixture',
      record: { ...paidPolicy.record, source: 'billing', auditReceiptId: 'paid-policy:http-fixture' },
      entitlements: { ...paidPolicy.entitlements, limits: { workspaces: 2, members: 1 }, supportTier: 'paid',
        quotas: { ...paidPolicy.entitlements.quotas, 'pool.hosts': 2, 'pool.reserved-hosts': 1,
          'pool.cpu-millicores': 8000 } },
    });
    const webhookSecret = 'whsec_PaidHttpFixture';
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('paid fixture must not contact Stripe'); });
    const billing = await createHostedBillingRuntime({ publicOrigin: configuration.publicOrigin,
      stripeSecretKeyRef: 'env:PAID_TEST_KEY', stripeWebhookSecretRef: 'env:PAID_TEST_WEBHOOK',
      plans: [{ planKey: 'paid-fixture', priceId: 'price_PaidFixture', label: 'Paid fixture', description: null, entitlementBundle: bundle }],
    }, { runService, fetchImpl,
      resolveSecret: async reference => reference === 'env:PAID_TEST_KEY' ? 'sk_test_PaidHttpFixture' : webhookSecret,
      resolvePrincipal: createHostedPrincipalResolver({ ...f.runtime.components,
        controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId }),
    });
    expect(billing.configured).toBe(true);
    const billingRequest = await requestFor(billing.app);
    const at = Math.floor(Date.now() / 1000);
    const event = (id: string, status: 'active' | 'canceled', created: number) => JSON.stringify({
      id, type: status === 'active' ? 'customer.subscription.updated' : 'customer.subscription.deleted',
      created, livemode: false, data: { object: { id: subscriptionId, customer: customerId, status,
        cancel_at_period_end: false, canceled_at: status === 'canceled' ? created : null,
        metadata: { organizationId: f.organizationId },
        items: { data: [{ price: { id: 'price_PaidFixture' }, current_period_end: at + 86_400 }] } } },
    });
    const active = event(`evt_${randomUUID().replaceAll('-', '')}`, 'active', at);
    const webhook = (body: string, signature?: string) => billingRequest('/api/hosted/billing/webhook', {
      method: 'POST', body, headers: { 'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'stripe-signature': signature }) },
    });
    const signedWebhook = (body: string) => webhook(body, `t=${at},v1=${computeStripeSignature(webhookSecret, at, body)}`);
    expect((await webhook(active)).status).toBe(400);
    expect((await webhook(active, `t=${at},v1=${'0'.repeat(64)}`)).status).toBe(400);
    expect(await f.stored()).toEqual(trial);
    const upgraded = await signedWebhook(active);
    expect(upgraded.status, await upgraded.clone().text()).toBe(200);
    expect(await upgraded.json()).toMatchObject({ ok: true, outcome: 'applied' });
    const paid = await f.stored();
    expect(Number(paid.authority_revision)).toBe(2);
    expect(await runService(tx => readHostedEntitlementAuthority(tx, f.organizationId)))
      .toMatchObject({ ok: true, authorityRevision: 2, resolution: { bundleId: bundle.bundleId,
        quotas: { 'pool.cpu-millicores': 8000, 'pool.reserved-hosts': 1 } } });
    expect(await (await signedWebhook(active)).json()).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(await f.stored()).toEqual(paid);
    expect(await other.stored()).toEqual(otherTrial);
    const admitted = await firstWorkspace();
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    const result = await admitted.json();
    expect(result).toMatchObject({ ok: true, workspaceId: identity.workspaceId });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    const [operation] = await db.adminSql`SELECT admission_receipt FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND id = ${result.provisionOperationId}`;
    expect(operation.admission_receipt.result).toMatchObject({ organizationId: f.organizationId,
      resourceAdmission: { authorityRevision: 2, bundleId: bundle.bundleId, priority: { guaranteed: true },
        storage: { capacity: { dbGiB: 8, workspaceGiB: 2 } } } });
    const retainedHost = async () => (await db.adminSql`SELECT desired_spec FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND id = ${identity.hostId}`)[0];
    const host = await retainedHost();
    expect(host).toBeDefined();
    const canceled = await signedWebhook(event(`evt_${randomUUID().replaceAll('-', '')}`, 'canceled', at + 1));
    expect(canceled.status, await canceled.clone().text()).toBe(200);
    expect(await canceled.json()).toMatchObject({ ok: true, outcome: 'applied' });
    expect(Number((await f.stored()).authority_revision)).toBe(3);
    expect(await runService(tx => readHostedEntitlementAuthority(tx, f.organizationId)))
      .toEqual({ ok: false, reason: 'no_active_assignment' });
    expect(await retainedHost()).toEqual(host);
    const signedInAgain = await f.callback();
    expect(signedInAgain.status).toBe(303);
    headers.cookie = `${HOSTED_SESSION_COOKIE}=${signedInAgain.headers.get('set-cookie')!
      .match(new RegExp(`${HOSTED_SESSION_COOKIE}=([^;,]+)`))![1]}`;
    expect(Number((await f.stored()).authority_revision)).toBe(3);
    expect(await runService(tx => readHostedEntitlementAuthority(tx, f.organizationId)))
      .toEqual({ ok: false, reason: 'no_active_assignment' });
    // An already-admitted operation remains replayable for durable enqueue
    // recovery. It must neither mint another reservation nor restore authority.
    const replay = await firstWorkspace();
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(await replay.json()).toMatchObject({ provisionOperationId: result.provisionOperationId });
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    expect(await db.adminSql`SELECT id FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${configuration.controlPlaneWorkspaceId} AND host_id = ${identity.hostId}`).toHaveLength(1);
    expect(Number((await f.stored()).authority_revision)).toBe(3);
    expect(await runService(tx => readHostedEntitlementAuthority(tx, f.organizationId)))
      .toEqual({ ok: false, reason: 'no_active_assignment' });
    expect(await retainedHost()).toEqual(host);
    expect(await other.stored()).toEqual(otherTrial);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('backfills the authenticated organization from its original grant and never renews on sign-in', async () => {
    const f = await fixture(policy());
    const response = await f.callback();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.papercusp.com/workspaces');
    const cookie = response.headers.get('set-cookie')!.match(new RegExp(`${HOSTED_SESSION_COOKIE}=([^;,]+)`))![1];
    const sessionId = f.runtime.components.sessionCookieCodec.decode(decodeURIComponent(cookie));
    expect(sessionId).toMatch(/^hs_/);
    expect(await f.runtime.components.sessionStore.resolve(sessionId!))
      .toMatchObject({ userId: f.userId, organizationId: f.organizationId });
    const stored = await f.stored();
    expect(Number(stored.authority_revision)).toBe(1);
    expect(stored.authority.assignments[0]).toMatchObject({ organizationId: f.organizationId,
      record: { effectiveFrom: f.createdAt.toISOString(),
        effectiveUntil: new Date(f.createdAt.getTime() + 86_400_000).toISOString() } });
    expect(await runService(tx => readHostedEntitlementAuthority(tx, f.organizationId)))
      .toMatchObject({ ok: true, grantUserId: f.userId, resolution: { quotas: { 'pool.db-gib': 256, 'pool.agents': 50 } } });
    await f.callback();
    expect(await f.stored()).toEqual(stored);
    await writeHostedEntitlementAuthority({ organizationId: f.organizationId, userId: f.userId,
      kind: 'hosted-free', expectedRevision: 1, authority: null }, runService);
    await f.callback();
    expect(await f.stored()).toMatchObject({ authority: null, authority_revision: 2 });
  });

  it('does not grant allowances without server policy or before callback authentication', async () => {
    const unconfigured = await fixture();
    expect((await unconfigured.callback()).status).toBe(303);
    expect(await unconfigured.stored()).toMatchObject({ authority: null, authority_revision: 0 });
    const configured = await fixture(policy());
    const response = await configured.callback(true);
    expect(response.headers.get('location')).not.toBe('https://app.papercusp.com/workspaces');
    expect(configured.provider.calls.exchangeCallback).toHaveLength(0);
    expect(await configured.stored()).toMatchObject({ authority: null, authority_revision: 0 });
  });

  it('routes returning signup through canonical admission without replacing or renewing the trial', async () => {
    const f = await fixture(policy());
    expect((await f.callback(false, 'sign-up')).headers.get('location'))
      .toBe('https://app.papercusp.com/workspaces');
    const original = await f.stored();
    expect(Number(original.authority_revision)).toBe(1);
    expect(original.authority.assignments[0].record).toMatchObject({
      effectiveFrom: f.createdAt.toISOString(),
      effectiveUntil: new Date(f.createdAt.getTime() + 86_400_000).toISOString(),
    });
    expect((await f.callback(false, 'sign-up')).status).toBe(303);
    expect(await f.stored()).toEqual(original);
  });
});

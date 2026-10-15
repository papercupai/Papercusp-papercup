/**
 * P-012: the real hosted signup transaction must cross only reviewed error and
 * telemetry boundaries.  This intentionally uses the migrated Postgres schema
 * instead of a memory-only admission, then drives the callback's failure log
 * with a post-admission fault containing the signup values.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatWithOptions } from 'node:util';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';
import {
  HostedSessionCookieCodec,
  type CreateHostedSessionInput,
  type HostedSession,
} from '../hosted-session';
import { createFakeHostedIdentityProvider } from './fake-provider';
import type { HostedAuthFlow, HostedAuthFlowConsumeResult, HostedAuthFlowStore } from '../../endpoint-route/routes/hosted-auth/flow';
import {
  HOSTED_AUTH_CALLBACK_PATH,
  HOSTED_AUTH_FLOW_COOKIE,
  createHostedAuthRoutes,
  type HostedAuthSessionStore,
} from '../../endpoint-route/routes/hosted-auth';
import { PostgresHostedSelfSignupAdmission, type HostedSelfSignupSuccess } from './self-signup';
import { deliverCloudTelemetry, safeCloudError } from '../../cloud-telemetry';
import { createHostedPrincipal } from '../hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '../../telemetry-kinds';
import { CUSTOMER_DATA_CLASSES, HOSTED_CUSTOMER_DATA_TABLES } from './customer-data-map';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

const ORIGIN = 'https://app.papercusp.com';
const COOKIE_SECRET = 'p012-log-redaction-cookie-secret-is-at-least-32-bytes';

class MemoryFlowStore implements HostedAuthFlowStore {
  private readonly flows = new Map<string, HostedAuthFlow>();

  async create(flow: HostedAuthFlow): Promise<string> {
    const state = `p012-state-${randomUUID()}`;
    this.flows.set(state, flow);
    return state;
  }

  async consume(state: string): Promise<HostedAuthFlowConsumeResult> {
    const flow = this.flows.get(state);
    if (!flow) return { ok: false, error: 'already-consumed' };
    this.flows.delete(state);
    return { ok: true, flow };
  }
}

class FailingSessionStore implements HostedAuthSessionStore {
  async create(_input: CreateHostedSessionInput): Promise<HostedSession> {
    throw new Error('session store is not used after a successful self-signup admission');
  }
  async resolve(_id: string): Promise<HostedSession | null> { return null; }
  async revoke(_id: string, _reason?: string, _at?: Date): Promise<boolean> { return false; }
}

function responseCookie(response: Response, name: string): string {
  const value = response.headers.get('set-cookie')?.match(new RegExp(`${name}=([^;,]+)`))?.[1];
  if (!value) throw new Error(`missing ${name} cookie`);
  return decodeURIComponent(value);
}

function capturedConsole() {
  const lines: string[] = [];
  const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(formatWithOptions({ depth: null, colors: false }, ...args));
    }));
  return { lines, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

describe('hosted signup log redaction (real migrated schema)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it.each([false, true])('keeps real signup logs private with a post-admission fault=%s', async (failAfterAdmission) => {
    const email = `p012-${randomUUID()}@example.test`;
    const displayName = `P012 Private ${randomUUID()}`;
    const providerSubject = `p012-subject-${randomUUID()}`;
    const upstreamSessionId = `p012-upstream-${randomUUID()}`;
    const credential = `p012-provider-credential-${randomUUID()}`;
    const privacyColumns = HOSTED_CUSTOMER_DATA_TABLES.flatMap(table =>
      CUSTOMER_DATA_CLASSES.filter(cls => cls === 'pii' || cls === 'secret')
        .flatMap(cls => table.columns[cls].map(column => `${table.schema}.${table.table}.${column}`)));
    expect(privacyColumns.length).toBeGreaterThan(0);
    expect(new Set(privacyColumns).size).toBe(privacyColumns.length);
    const privacyValues = privacyColumns.map((column, index) => `${column.replaceAll('.', '_')}-private-${index}`);
    const cause = Object.assign(
      new Error([email, displayName, credential, ...privacyValues].join(' ')),
      { detail: Object.fromEntries(privacyColumns.map((column, index) => [column, privacyValues[index]])) },
    );

    const runService = async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      const result = await fn(tx as unknown as Sql);
      await tx.unsafe('RESET ROLE');
      return result;
    }) as Promise<T>;
    const realAdmission = new PostgresHostedSelfSignupAdmission(runService);
    const provider = createFakeHostedIdentityProvider({
      session: {
        externalSessionId: upstreamSessionId,
        identity: {
          externalUserId: providerSubject,
          primaryEmail: email,
          emailVerified: true,
          displayName,
        },
        issuedAtMs: Date.now() - 1_000,
        authenticatedAtMs: Date.now() - 1_000,
        expiresAtMs: Date.now() + 3_600_000,
        authenticationMethods: ['pwd'],
        mfaVerified: false,
      },
    });
    let admitted: HostedSelfSignupSuccess | null = null;
    const selfSignup = {
      complete: async (input: Parameters<typeof realAdmission.complete>[0]) => {
        const result = await realAdmission.complete(input);
        if (result.ok) {
          admitted = result;
          if (failAfterAdmission) throw cause;
        }
        return result;
      },
    };
    const routes = createHostedAuthRoutes({
      provider,
      flowStore: new MemoryFlowStore(),
      sessionStore: new FailingSessionStore(),
      sessionCookieCodec: new HostedSessionCookieCodec(COOKIE_SECRET),
      bindIdentity: async () => null,
      selfSignup,
      publicOrigin: ORIGIN,
      clock: () => new Date(),
      randomBytes: size => new Uint8Array(size).fill(7),
    });
    const signIn = routes.find(route => route.method === 'GET' && route.path === '/hosted/auth/sign-in')!;
    const callback = routes.find(route => route.method === 'GET' && route.path === '/hosted/auth/callback')!;
    const captured = capturedConsole();
    try {
      const started = await signIn.handler(
        new Request(`${ORIGIN}/api/hosted/auth/sign-in?intent=sign-up&returnTo=%2F`), {} as never,
      );
      const location = new URL(started.headers.get('location')!);
      const state = location.searchParams.get('state')!;
      const flowCookie = responseCookie(started, HOSTED_AUTH_FLOW_COOKIE);
      const response = await callback.handler(
        new Request(`${ORIGIN}${HOSTED_AUTH_CALLBACK_PATH}?code=${encodeURIComponent(credential)}&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `${HOSTED_AUTH_FLOW_COOKIE}=${encodeURIComponent(flowCookie)}` },
        }), {} as never,
      );
      expect(response.status).toBe(failAfterAdmission ? 503 : 303);
      expect(admitted).not.toBeNull();

      const persisted = await db.adminSql<Array<{ primary_email: string; display_name: string }>>`
        SELECT primary_email, display_name FROM papercusp_auth.hosted_users WHERE primary_email = ${email}
      `;
      expect(persisted).toEqual([{ primary_email: email, display_name: displayName }]);
      const logs = captured.lines.join('\n');
      const localSession = (admitted as HostedSelfSignupSuccess | null)?.session;
      expect(localSession?.id).toMatch(/^hs_/);
      for (const value of [email, displayName, providerSubject, upstreamSessionId, credential,
        state, flowCookie, localSession!.id, ...privacyValues]) {
        expect(logs).not.toContain(value);
      }
      if (failAfterAdmission) {
        expect(logs).toContain('signup_unavailable');
        expect(logs).toContain(safeCloudError('request_failure', cause).fingerprint);
        expect(await response.text()).not.toContain(email);
      } else {
        expect(response.headers.get('set-cookie')).toContain('__Host-papercusp_session=');
      }

      // The same reviewed error boundary feeds cloud analytics.
      const safe = safeCloudError('request_failure', cause);
      expect(Object.keys(safe).sort()).toEqual(['code', 'fingerprint']);
      expect(JSON.stringify(safe)).not.toContain(email);
      expect(JSON.stringify(safe)).not.toContain(displayName);
    } finally {
      captured.restore();
    }

  });

  it('refuses each mapped PII/secret key at the final analytics writer and pseudonymizes accepted identifiers', async () => {
    const organizationId = randomUUID(), userId = randomUUID(), sessionId = randomUUID();
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: organizationId,
      userId, sessionId, sessionVersion: 1, permissions: ['workspace:view'] });
    const context = { principal, environment: 'staging' as const, release: 'abcdef1234567',
      origin: 'control-plane' as const, hostingMode: 'managed' as const };
    const consent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT,
      analytics: { enabled: true, since: '2000-01-01T00:00:00Z' } };
    const event = { event: 'cloud_portal_session', operation_id: randomUUID(), properties: { action: 'signed_in' } };
    const envelopes: unknown[] = [];
    const send = vi.fn(async (envelope: unknown) => { envelopes.push(envelope); });
    const dependencies = { readConsent: async () => consent, send };
    expect(await deliverCloudTelemetry(event, context, dependencies)).toEqual({ delivered: true });
    const positive = envelopes[0] as { distinct_id: string; properties: { organization_id: string; operation_id: string } };
    for (const value of [positive.distinct_id, positive.properties.organization_id, positive.properties.operation_id]) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
    const serialized = JSON.stringify(positive);
    for (const value of [organizationId, userId, sessionId, event.operation_id]) expect(serialized).not.toContain(value);

    const privateKeys = new Set(HOSTED_CUSTOMER_DATA_TABLES.flatMap(table =>
      [...table.columns.pii, ...table.columns.secret]));
    expect(privateKeys.has('primary_email')).toBe(true);
    expect(privateKeys.has('upstream_session_id')).toBe(true);
    for (const key of privateKeys) {
      const value = `p012-forbidden-${key}`;
      expect(await deliverCloudTelemetry({ ...event, [key]: value }, context, dependencies), key)
        .toEqual({ delivered: false, code: 'invalid_cloud_event' });
      expect(await deliverCloudTelemetry({ ...event, properties: { ...event.properties, [key]: value } }, context, dependencies), key)
        .toEqual({ delivered: false, code: 'invalid_cloud_event' });
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(envelopes)).not.toContain('p012-forbidden-');
  });
});

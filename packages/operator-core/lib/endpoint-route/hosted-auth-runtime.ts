/**
 * Narrow production composition for browser identity at app.papercusp.com.
 *
 * This is intentionally smaller than `hosted-runtime.ts`: consumers that need
 * only sign-in/callback/logout/session must not import the complete operator
 * route registry, connector plane, cloud SDKs, agent tools, and voice graph.
 * The runtime still uses the exact canonical WorkOS provider, opaque hosted
 * session store/cookie, identity binder, live membership authority, RLS
 * contexts, and hosted principal resolver.
 */

import { withHostedServiceContext, withTenantContext } from '@papercusp/db-org/tenant-context';
import { Hono } from 'hono';
import type { RefusalContract } from '../capability-envelope/refusal-contract-types';
import { createHostedIdentityBinder } from '../auth/hosted-identity-binding';
import { PostgresHostedSelfSignupAdmission } from '../auth/hosted/self-signup';
import { backfillHostedTrialEntitlementAuthority, parseHostedTrialEntitlementPolicy,
  type HostedTrialEntitlementPolicy } from '../auth/hosted-entitlement-store';
import {
  createHostedPrincipalResolver,
  type HostedPrincipalDenialReason,
  type HostedPrincipalResolver,
} from '../auth/hosted-principal-resolver';
import { HostedSessionCookieCodec } from '../auth/hosted-session';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { readCloudTelemetryConsent } from '../cloud-telemetry';
import { getBuildInfo } from '../build-info';
import { createHash } from 'node:crypto';
import {
  HostedRuntimeMembershipAuthority,
  HostedServiceIdentityDirectory,
  HostedServiceSessionStore,
  assertHostedServicePosture,
  serviceWorkOSSessionVault,
  type HostedTenantContextRunner,
} from '../auth/hosted/service-adapters';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { createWorkOSHostedIdentityProvider } from '../auth/hosted/workos-provider';
import { resolveSecretRef } from '../inference-gateway/egress-providers/secret-ref';
import {
  HOSTED_AUTH_ROUTES,
  createHostedAuthRoutes,
} from './routes/hosted-auth';
import { createHostedTutorialProgressRoutes } from './routes/hosted-tutorial-progress-routes';
import { createHostedTutorialAssistanceRoutes, HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, HOSTED_BROWSER_TUTORIAL_VOICE_TOKEN_PATH, type TutorialAssistanceDependencies } from './routes/hosted-tutorial-progress';

// The billing runtime rides in this module's portal prebundle (one bundle, one
// dynamic import). It mounts its own pinned surface; the four auth routes below
// stay exactly as pinned (stripe-subscription-signup-2026-10-01 P-005).
export {
  createHostedBillingRuntime,
  readHostedBillingRuntimeConfiguration,
  type HostedBillingRuntime,
  type HostedBillingRuntimeDependencies,
} from './hosted-billing-runtime';

export const HOSTED_AUTH_RUNTIME_MOUNTED_ROUTE_KEYS = HOSTED_AUTH_ROUTES.map(
  (route) => `${route.method} ${route.path}`,
);

export interface HostedAuthRuntimeConfiguration {
  readonly publicOrigin: string;
  readonly controlPlaneWorkspaceId: string;
  readonly hostedSessionCookieSecretRef: string;
  readonly workosClientId: string;
  readonly workosApiKeyRef: string;
  readonly workosCookiePasswordRef: string;
  /** Explicit server-authored bundle and trial lifetime; absent grants no pool allowances. */
  readonly trialEntitlementPolicy?: HostedTrialEntitlementPolicy;
}

export type HostedAuthRuntimeSecretResolver = (reference: string) => Promise<string>;

export interface HostedAuthRuntimeDependencies {
  readonly resolveSecret?: HostedAuthRuntimeSecretResolver;
  readonly runService?: HostedServiceContextRunner;
  readonly runTenant?: HostedTenantContextRunner;
  readonly tutorialAssistance?: TutorialAssistanceDependencies;
}

export interface HostedAuthRuntime {
  readonly app: Hono;
  /** Canonical guide preferences and explicit Help, with the same session authority. */
  readonly tutorial: Hono;
  readonly tutorialMounted: readonly { method: string; path: string }[];
  readonly mounted: readonly { method: string; path: string }[];
  readonly resolvePrincipal: HostedPrincipalResolver;
  readonly components: {
    readonly sessionStore: HostedServiceSessionStore;
    readonly sessionCookieCodec: HostedSessionCookieCodec;
    readonly membershipAuthority: HostedRuntimeMembershipAuthority;
    readonly identityDirectory: HostedServiceIdentityDirectory;
  };
}

function requiredConfiguration(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_024) {
    throw new TypeError(`hosted_auth_runtime_configuration_missing:${name}`);
  }
  return value.trim();
}

export function readHostedAuthRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): HostedAuthRuntimeConfiguration {
  return {
    publicOrigin: requiredConfiguration(env.PAPERCUSP_HOSTED_PUBLIC_ORIGIN, 'PAPERCUSP_HOSTED_PUBLIC_ORIGIN'),
    controlPlaneWorkspaceId: requiredConfiguration(
      env.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID,
      'PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID',
    ),
    hostedSessionCookieSecretRef: requiredConfiguration(
      env.PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF,
      'PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF',
    ),
    workosClientId: requiredConfiguration(env.WORKOS_CLIENT_ID, 'WORKOS_CLIENT_ID'),
    workosApiKeyRef: requiredConfiguration(env.WORKOS_API_KEY_REF, 'WORKOS_API_KEY_REF'),
    workosCookiePasswordRef: requiredConfiguration(env.WORKOS_COOKIE_PASSWORD_REF, 'WORKOS_COOKIE_PASSWORD_REF'),
    ...(env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT?.trim() ? {
      trialEntitlementPolicy: parseHostedTrialEntitlementPolicy(JSON.parse(env.PAPERCUSP_HOSTED_TRIAL_ENTITLEMENT)),
    } : {}),
  };
}

const DENIAL_STATUS: Readonly<Record<HostedPrincipalDenialReason, 401 | 403 | 503>> = {
  session_cookie_missing: 401,
  session_not_found: 401,
  membership_not_active: 403,
  session_organization_mismatch: 403,
  session_permission_version_stale: 401,
  workspace_not_in_organization: 403,
  authority_unavailable: 503,
};

function denial(reason: HostedPrincipalDenialReason): Response {
  const status = DENIAL_STATUS[reason];
  return Response.json({
    error: {
      code: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authority_unavailable',
      message: reason,
    },
  }, { status });
}

/** Mount only the four pinned canonical hosted-auth routes on `/api`. */
function createHostedAuthApp(
  routes: ReturnType<typeof createHostedAuthRoutes>,
  resolvePrincipal: HostedPrincipalResolver,
): Hono {
  const mounted = routes.map((route) => `${route.method} ${route.path}`);
  if (
    mounted.length !== HOSTED_AUTH_RUNTIME_MOUNTED_ROUTE_KEYS.length
    || mounted.some((key, index) => key !== HOSTED_AUTH_RUNTIME_MOUNTED_ROUTE_KEYS[index])
  ) throw new Error(`hosted_auth_runtime_surface_mismatch:${JSON.stringify(mounted)}`);

  const app = new Hono().basePath('/api');
  for (const route of routes) {
    if (route.auth !== 'public') {
      const required = typeof route.auth === 'object' ? route.auth.capabilities ?? [] : [];
      if (required.length === 0 || required.includes('*')) {
        throw new Error(`hosted_auth_runtime_invalid_authority:${route.method} ${route.path}`);
      }
    }
    app.on(route.method, route.path, async (context) => {
      let principal = null;
      if (route.auth !== 'public') {
        const resolution = await resolvePrincipal(context.req.raw.headers);
        if (!resolution.ok) return denial(resolution.reason);
        const required = typeof route.auth === 'object' ? route.auth.capabilities ?? [] : [];
        if (required.some((permission) => !resolution.principal.capabilities.has(permission as never))) {
          return Response.json({
            error: {
              code: 'forbidden',
              message: 'permission_missing',
              refusal: {
                observed: { route: `${route.method} ${route.path}`, required: required.join(',') },
                liftsWhen:
                  'the session principal holds every capability the route requires (a hosted-membership role ' +
                  'change by the organization owner/admin; the session then re-resolves on its next request). ' +
                  'Retrying the same session without the capability changes nothing',
                whoCanMakeItTrue: ['owner'],
              } satisfies RefusalContract,
            },
          }, { status: 403 });
        }
        principal = resolution.principal;
      }
      return route.handler(context.req.raw, { principal } as never);
    });
  }
  return app;
}

export async function createHostedAuthRuntime(
  configuration: HostedAuthRuntimeConfiguration,
  dependencies: HostedAuthRuntimeDependencies = {},
): Promise<HostedAuthRuntime> {
  const runService = dependencies.runService ?? withHostedServiceContext;
  await assertHostedServicePosture(runService);

  // Default = the generic env:/file: resolver ONLY. This module is esbuild-
  // prebundled by the portal (PORTAL_HOSTED_AUTH_RUNTIME_PACKAGE_ROOT); importing
  // the encrypted-store resolver (auth/hosted/secret-ref.ts → integration-
  // credentials → operator-state-pg → sync/events engine) here grew that cone
  // from 596 to 9,087 modules and broke every standalone build
  // (EI-22091008218242870). A composition that wants `integration:NAME`
  // references injects resolveHostedSecretRef via dependencies.resolveSecret —
  // see apps/operator/bin/hosted-handler.ts. hosted-auth-runtime.bundle-cone.test.ts
  // guards the cone.
  const resolveSecret = dependencies.resolveSecret ?? resolveSecretRef;
  const runTenant = dependencies.runTenant ?? withTenantContext;
  const sessionCookieSecret = await resolveSecret(configuration.hostedSessionCookieSecretRef);
  const sessionStore = new HostedServiceSessionStore(runService);
  const membershipAuthority = new HostedRuntimeMembershipAuthority(runService, runTenant);
  const identityDirectory = new HostedServiceIdentityDirectory(runService);
  const sessionCookieCodec = new HostedSessionCookieCodec(sessionCookieSecret);
  const provider = createWorkOSHostedIdentityProvider({
    configuration: {
      clientId: configuration.workosClientId,
      apiKeyRef: configuration.workosApiKeyRef,
      cookiePasswordRef: configuration.workosCookiePasswordRef,
    },
    resolveSecret: (reference) => resolveSecret(reference),
    sessionVault: serviceWorkOSSessionVault(runService),
  });
  const bindIdentity = createHostedIdentityBinder({ directory: identityDirectory, membershipAuthority });
  const selfSignup = new PostgresHostedSelfSignupAdmission(runService, { trialPolicy: configuration.trialEntitlementPolicy });
  const resolvePrincipal = createHostedPrincipalResolver({
    sessionCookieCodec,
    sessionStore,
    membershipAuthority,
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
  });
  const mounted = createHostedAuthRoutes({
    provider,
    bindIdentity,
    selfSignup,
    sessionStore,
    sessionCookieCodec,
    publicOrigin: configuration.publicOrigin,
    onSessionEstablished: async session => {
      if (configuration.trialEntitlementPolicy) await runService(tx =>
        backfillHostedTrialEntitlementAuthority(tx, {
          organizationId: session.organizationId, policy: configuration.trialEntitlementPolicy!,
        }));
      const principal = createHostedPrincipal({ workspaceId: configuration.controlPlaneWorkspaceId,
        activeOrganizationId: session.organizationId, userId: session.userId, sessionId: session.id,
        sessionVersion: session.permissionVersion, selectedWorkspaceId: session.workspaceId ?? undefined, permissions: [] });
      const digest = createHash('sha256').update(session.id).digest('hex');
      const operation_id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const { deliverCloudPosthog } = await import('../cloud-telemetry-posthog');
      return deliverCloudPosthog({ event: 'cloud_portal_session', operation_id, properties: { action: 'signed_in' } },
        { principal, origin: 'control-plane', hostingMode: 'byoc', release: getBuildInfo().sha ?? '',
          environment: process.env.PORT === '3170' ? 'staging' : process.env.NODE_ENV === 'production' ? 'production' : 'development',
          observedAt: session.createdAt.toISOString() },
        () => runTenant({ principal: { kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified',
          slug: session.userId, workspaceId: configuration.controlPlaneWorkspaceId, userId: session.userId,
          activeOrganizationId: session.organizationId, sessionId: session.id, sessionVersion: session.permissionVersion } },
        tx => readCloudTelemetryConsent(tx, principal)));
    },
  });
  const app = createHostedAuthApp(mounted, resolvePrincipal);
  // Reuse exact hosted leaves and the same tenant/session authority. The Help
  // route loads the existing tool-less lesson brain only for an explicit ask.
  const tutorialRouteOptions = { origin: configuration.publicOrigin,
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId, runTenant };
  const tutorialMounted = [
    ...createHostedTutorialProgressRoutes(tutorialRouteOptions),
    ...createHostedTutorialAssistanceRoutes({ ...tutorialRouteOptions, dependencies: dependencies.tutorialAssistance })
      .filter(route => route.path === HOSTED_BROWSER_TUTORIAL_HELP_PATH
        || (route.path === HOSTED_BROWSER_TUTORIAL_SPEECH_PATH && dependencies.tutorialAssistance?.speech)
        || (route.path === HOSTED_BROWSER_TUTORIAL_VOICE_TOKEN_PATH && dependencies.tutorialAssistance?.voiceToken)),
  ];
  const tutorial = new Hono().basePath('/api');
  for (const route of tutorialMounted) {
    tutorial.on(route.method, route.path, async context => {
      const resolution = await resolvePrincipal(context.req.raw.headers);
      if (!resolution.ok) return denial(resolution.reason);
      return route.handler(context.req.raw, { principal: resolution.principal } as never);
    });
  }

  return {
    app,
    tutorial,
    tutorialMounted,
    mounted,
    resolvePrincipal,
    components: { sessionStore, sessionCookieCodec, membershipAuthority, identityDirectory },
  };
}

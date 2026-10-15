/**
 * Compiler boundary for the existing hosted-auth server prebundle.
 * Runtime resolution still selects hosted-auth-runtime.ts. Keep this contract
 * equal to that implementation; hosted-auth-runtime.types.test.ts checks it.
 * Importing the implementation here would reopen the lazy tutorial brain graph
 * in consumers such as the Portal's Next compiler.
 */
import type { Hono } from 'hono';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedSessionCookieCodec } from '../auth/hosted-session';
import type {
  HostedRuntimeMembershipAuthority,
  HostedServiceIdentityDirectory,
  HostedServiceSessionStore,
  HostedTenantContextRunner,
} from '../auth/hosted/service-adapters';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import type { TutorialAssistanceDependencies } from './routes/hosted-tutorial-progress';

export {
  createHostedBillingRuntime,
  readHostedBillingRuntimeConfiguration,
  type HostedBillingRuntime,
  type HostedBillingRuntimeDependencies,
} from './hosted-billing-runtime';

export declare const HOSTED_AUTH_RUNTIME_MOUNTED_ROUTE_KEYS: string[];

export interface HostedAuthRuntimeConfiguration {
  readonly publicOrigin: string;
  readonly controlPlaneWorkspaceId: string;
  readonly hostedSessionCookieSecretRef: string;
  readonly workosClientId: string;
  readonly workosApiKeyRef: string;
  readonly workosCookiePasswordRef: string;
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

export declare function readHostedAuthRuntimeConfiguration(
  env?: NodeJS.ProcessEnv,
): HostedAuthRuntimeConfiguration;

export declare function createHostedAuthRuntime(
  configuration: HostedAuthRuntimeConfiguration,
  dependencies?: HostedAuthRuntimeDependencies,
): Promise<HostedAuthRuntime>;

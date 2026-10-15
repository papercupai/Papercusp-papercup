import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readSuperuserToken, superuserTokenPath } from '../superuser-token';
import type { Sql } from 'postgres';
import type { IncomingMessage } from 'node:http';
import { withTimeout } from '../../../../libs/testing-shell/src/llm/runner';
import { missingPlaywrightBrowsers } from '../../../../scripts/ensure-playwright-browsers.mjs';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationSqlRunner,
} from '../workspace-host/hosted-provider-delegation';

/** Mirror the hosted socket authority at an explicitly private fixture ingress. */
export function publicManualHostedUpgradeHeaders(
  request: Pick<IncomingMessage, 'url' | 'headers'>, publicOrigin: string,
): IncomingMessage['headers'] {
  const origin = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('hosted_fixture_upgrade_origin_not_loopback');
  // This is only the fixture's connector ingress. HTTP cookie/origin checks,
  // foreign authorities and every other upgrade retain their original headers.
  if (request.url?.split('?')[0] !== '/api/hosted/connectors/socket'
    || request.headers.host !== origin.host) return request.headers;
  return { ...request.headers, host: 'app.papercusp.com' };
}

/** Persist the active phase before starting work that may never settle. */
export function publicManualHostedPhaseRecorder(persist: (phase: {
  stage: string; state: 'running' | 'complete' | 'failed'; startedAt: string; errorCode?: string;
}) => void) {
  return async <T>(stage: string, operation: () => Promise<T>, readOnlyTimeoutMs?: number): Promise<T> => {
    const startedAt = new Date().toISOString();
    persist({ stage, state: 'running', startedAt });
    try {
      // Only read-only work may race a timer. Admission and cleanup must settle
      // so their resource owner cannot disappear behind a rejected promise.
      const pending = operation();
      const result = readOnlyTimeoutMs === undefined ? await pending
        : await withTimeout(pending, readOnlyTimeoutMs, `hosted_fixture_phase:${stage}`);
      persist({ stage, state: 'complete', startedAt });
      return result;
    } catch (error) {
      persist({ stage, state: 'failed', startedAt, errorCode: 'hosted_fixture_phase_failed' });
      throw error;
    }
  };
}

/** Refuse fixture creation when its serving runtime cannot cover work AND cleanup. */
export function assertPublicManualHostedRuntimeBudget(
  deadlines: Array<string | undefined>, now = Date.now(), workMs = 90_000, cleanupMs = 20_000,
) {
  const values = deadlines.filter((value): value is string => value !== undefined);
  if (!values.length || values.length !== deadlines.length || values.some(value => !/^\d+$/.test(value)
    || !Number.isSafeInteger(Number(value)))) throw new Error('hosted_fixture_runtime_deadline_required');
  const remainingMs = Math.min(...values.map(Number)) - now;
  if (remainingMs < workMs + cleanupMs) throw new Error('hosted_fixture_runtime_budget_insufficient');
  return { remainingMs, workMs, cleanupMs };
}

/** Transport the supervisor's private filesystem bindings before admission or locks. */
export function publicManualHostedRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) throw new Error('hosted_fixture_private_home_required');
  let canonicalHome: string;
  try { canonicalHome = realpathSync(home); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('hosted_fixture_runtime_removed', { cause });
    throw cause;
  }
  const runtimeRoot = dirname(canonicalHome);
  if (!/^papercusp-test-runtime-[^/]+$/.test(basename(runtimeRoot))
    || resolve(home) !== join(runtimeRoot, 'home') || canonicalHome !== resolve(home))
    throw new Error('hosted_fixture_private_home_mismatch');
  const bindings = {
    HOME: join(runtimeRoot, 'home'),
    TMPDIR: join(runtimeRoot, 'tmp'),
    PAPERCUSP_HOME: join(runtimeRoot, 'home/.papercusp'),
    PAPERCUSP_WORKSPACES_ROOT: join(runtimeRoot, 'workspaces'),
  };
  for (const [key, expected] of Object.entries(bindings)) {
    const supplied = environment[key];
    const ownedRegistryAlias = key === 'PAPERCUSP_WORKSPACES_ROOT' && supplied !== undefined
      && resolve(supplied) === join(bindings.HOME, '.papercusp-workspaces')
      && realpathSync(supplied) === expected;
    if ((supplied !== undefined && resolve(supplied) !== expected && !ownedRegistryAlias)
      || realpathSync(expected) !== expected || lstatSync(expected).isSymbolicLink())
      throw new Error(`hosted_fixture_private_binding_mismatch:${key}`);
  }
  const workspace = environment.PAPERCUSP_WORKSPACE;
  if (!workspace || !/^test-runtime-[a-zA-Z0-9-]+$/.test(workspace)
    || (environment.PAPERCUSP_WORKSPACE_ID !== undefined && environment.PAPERCUSP_WORKSPACE_ID !== workspace)
    || (environment.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID !== undefined
      && environment.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID !== workspace))
    throw new Error('hosted_fixture_private_workspace_mismatch');
  const registryPath = join(bindings.PAPERCUSP_WORKSPACES_ROOT, 'registry.json');
  if (realpathSync(registryPath) !== registryPath || !lstatSync(registryPath).isFile())
    throw new Error('hosted_fixture_private_registry_mismatch');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry.current !== workspace || !Array.isArray(registry.workspaces)
    || !registry.workspaces.some((entry: { id?: string }) => entry.id === workspace))
    throw new Error('hosted_fixture_private_registry_mismatch');
  const source = environment.PAPERCUSP_TEST_OPERATOR_SOURCE_ROOT;
  if (!source || !isAbsolute(source)) throw new Error('hosted_fixture_operator_source_required');
  const integrationRoot = realpathSync(source);
  if (!existsSync(join(integrationRoot, 'apps/operator/bin/hono-host.ts'))
    || (environment.PAPERCUSP_INTEGRATION_ROOT !== undefined
      && realpathSync(environment.PAPERCUSP_INTEGRATION_ROOT) !== integrationRoot))
    throw new Error('hosted_fixture_operator_source_mismatch');
  if (!environment.PAPERCUSP_SID) throw new Error('hosted_fixture_session_required');
  assertPublicManualHostedRuntimeBudget([environment.PAPERCUSP_TEST_HOSTED_RUNTIME_DEADLINE_EPOCH_MS]);
  // A private native model acceptance must exercise the account pool. Its
  // disposable HOME can still borrow an exhausted default CLI login, so
  // private filesystem/PG custody alone does not establish inference routing.
  // Keep no-model readiness available without creating an inference mission.
  if (environment.PAPERCUSP_TEST_PUBLIC_CHAT === '1') {
    if (environment.PAPERCUSP_CODEX_GATEWAY !== '1')
      throw new Error('hosted_fixture_model_gateway_required');
    if (environment.PAPERCUSP_ACCOUNT_ID?.trim())
      throw new Error('hosted_fixture_model_account_pool_required');
    const port = environment.PAPERCUSP_GATEWAY_PORT;
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
      throw new Error('hosted_fixture_model_gateway_port_invalid');
  }
  return { ...environment, ...bindings,
    PAPERCUSP_WORKSPACES_ROOT: environment.PAPERCUSP_WORKSPACES_ROOT ?? bindings.PAPERCUSP_WORKSPACES_ROOT,
    PAPERCUSP_WORKSPACE_ID: workspace,
    PAPERCUSP_INTEGRATION_ROOT: integrationRoot };
}

/** Keep maintained browser assets explicit when the selected HOME is disposable. */
export function publicManualHostedBrowserCache(environment: NodeJS.ProcessEnv) {
  const cacheDir = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (!cacheDir || !isAbsolute(cacheDir)) throw new Error('hosted_fixture_browser_cache_required');
  const missing = missingPlaywrightBrowsers({ env: { ...environment,
    PLAYWRIGHT_BROWSERS: 'chromium,chromium-headless-shell,ffmpeg' } });
  if (missing.length) throw new Error(`hosted_fixture_browser_install_missing:${missing.join(',')}`);
  return { cacheDir };
}

/** Create only this verified TEST runtime's credential; never borrow a live token. */
export function preparePublicManualHostedRuntime() {
  const environment = publicManualHostedRuntimeEnvironment(process.env);
  // The supervisor registry is a sibling of HOME. Give its exact bytes the
  // conventional private-HOME spelling supported by the existing lock API.
  // Neither the operator registry nor any lock authorization is changed.
  const registryRoot = realpathSync(environment.PAPERCUSP_WORKSPACES_ROOT!);
  const registryAlias = join(environment.HOME!, '.papercusp-workspaces');
  try { symlinkSync(registryRoot, registryAlias, 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(registryAlias).isSymbolicLink() || realpathSync(registryAlias) !== registryRoot)
    throw new Error('hosted_fixture_private_registry_alias_mismatch');
  Object.assign(process.env, environment, { PAPERCUSP_WORKSPACES_ROOT: registryAlias });
  const tokenPath = superuserTokenPath();
  if (dirname(tokenPath) !== environment.PAPERCUSP_HOME)
    throw new Error('hosted_fixture_private_token_path_mismatch');
  let tokenCreated = false;
  try {
    const fd = openSync(tokenPath, 'wx', 0o600);
    try { writeFileSync(fd, randomUUID(), 'utf8'); tokenCreated = true; }
    finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(tokenPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
    || (process.getuid && stat.uid !== process.getuid()) || !readSuperuserToken())
    throw new Error('hosted_fixture_private_token_invalid');
  // The receipt deliberately contains only custody, never the bearer value.
  return { tokenPath, tokenCreated };
}

export interface PublicManualHostedFixtureBinding {
  controlPlaneWorkspaceId: string;
  organizationId: string;
  customerWorkspaceId: string;
  hostId: string;
  connectionId: string;
}

/** Health and a source SHA cannot establish that the selected migrations
 * supplied the schema used by session startup. Probe the real consumer columns
 * before declaring a private host ready or creating delegation records. */
export async function assertPublicManualHostedRuntimeSchema(
  run: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
) {
  try {
    await run(sql => sql`SELECT retired_at, retired_by, retired_reason
      FROM harness_shared.adv_sessions LIMIT 0`);
  } catch (cause) {
    throw new Error('hosted_fixture_session_retirement_schema_missing', { cause });
  }
}

/** A private test host is verified by its own HTTP response, never by a cloud claim. */
export async function preparePublicManualHostedDelegation(
  binding: PublicManualHostedFixtureBinding,
  run: HostedProviderDelegationSqlRunner,
  operatorOrigin: string,
  expectedSha: string,
) {
  const origin = new URL(operatorOrigin);
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || origin.username || origin.password) throw new Error('hosted_fixture_operator_not_loopback');
  if (!/^[a-f0-9]{10,40}$/.test(expectedSha)) throw new Error('hosted_fixture_operator_sha_required');
  await assertPublicManualHostedRuntimeSchema(run);
  const unsupported = async (): Promise<never> => { throw new Error('hosted_fixture_cloud_provider_not_permitted'); };
  const organization: HostedDelegationOrganization = {
    organizationId: binding.organizationId,
    gcpTrustedPrincipal: unsupported,
    awsTrustedPrincipal: unsupported,
    awsPapercuspHosting: unsupported,
    gcpPapercuspHosting: async hostId => {
      if (hostId !== binding.hostId) throw new Error('hosted_fixture_reserved_host_mismatch');
      return { projectId: 'public-manual-private-fixture',
        serviceAccountEmail: 'private-fixture@public-manual-private-fixture.iam.gserviceaccount.com' };
    },
  };
  const adapter: HostedProviderDelegationAdapter = {
    verify: async record => {
      if (record.workspaceId !== binding.customerWorkspaceId || record.connectionId !== binding.connectionId
        || record.organizationId !== binding.organizationId || record.configuration.provider !== 'gcp'
        || record.configuration.source.method !== 'papercusp-hosted'
        || record.configuration.source.hostId !== binding.hostId) throw new Error('hosted_fixture_delegation_binding_mismatch');
      const response = await fetch(new URL('/api/health', origin), {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      const health = await response.json();
      if (!response.ok || typeof health.sha !== 'string'
        || !expectedSha.startsWith(health.sha) || health.sha.length < 10)
        throw new Error('hosted_fixture_operator_health_mismatch');
      return { identity: `private-loopback:${binding.hostId}`,
        evidenceRef: `fixture://loopback-health/${binding.hostId}/${health.sha}` };
    },
    revoke: async () => ({ evidenceRef: `fixture://delegation-revoked/${binding.hostId}` }),
  };
  const manager = new HostedProviderDelegationManager(
    new PostgresHostedProviderDelegationStore(run, binding.controlPlaneWorkspaceId),
    { gcp: adapter, aws: adapter, azure: adapter }, organization,
  );
  await manager.onboardPapercuspHosted({ workspaceId: binding.customerWorkspaceId,
    connectionId: binding.connectionId, label: 'Disposable private manual operator',
    credentialRef: `delegation://private-fixture/${binding.hostId}` }, binding.hostId);
  const record = await manager.verify(binding.customerWorkspaceId, binding.connectionId);
  return { record, close: () => manager.revoke(binding.customerWorkspaceId, binding.connectionId) };
}

/** Production keeps revoked audit records; a disposable TEST workspace must remove its own. */
export async function purgePublicManualHostedConnector(
  run: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  binding: Omit<PublicManualHostedFixtureBinding, 'connectionId'> & { routeLabel: string },
) {
  return run(sql => sql`
    DELETE FROM papercusp_auth.hosted_workspace_connectors
    WHERE control_workspace_id=${binding.controlPlaneWorkspaceId} AND organization_id=${binding.organizationId}
      AND customer_workspace_id=${binding.customerWorkspaceId} AND host_id=${binding.hostId}
      AND route_label=${binding.routeLabel}
  `);
}

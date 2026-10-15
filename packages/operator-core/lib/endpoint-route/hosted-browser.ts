/**
 * The explicit browser boundary for the hosted operator SPA.
 *
 * The local `/zero-harness/*` and `/workspace-hosts/*` routes are intentionally
 * not reusable internet endpoints: they rely on loopback/process-global scope.
 * This module gives the hosted static SPA a small, reviewed surface instead.
 * Authentication is still supplied by the hosted route stack; this leaf adds
 * the selected-customer-workspace binding, tenant transaction, exact-origin
 * write check, and the query allowlist.
 */
import { randomUUID } from 'node:crypto';
import { defineTool, type RouteContext, type RouteDefinition } from '@papercusp/agent-mcp';
import { withTenantContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { parseLastEventId, sseResponse, type SyncSseEventVocabulary } from '@papercusp/sse';
import { backfillSince, subscribe, type SyncEvent, type SubscribeHandle } from '../sync-sse';
import { isHostedPrincipal, type HostedPrincipal } from '../auth/hosted-principal';
import type { HostedTenantContextRunner } from '../auth/hosted/service-adapters';
import {
  listLiveWorkspaceHostIdsOnConnection,
  readWorkspaceHostConnection,
  readWorkspaceHostIdSpent,
  readWorkspaceHostControl,
  readWorkspaceHostDestroyTarget,
  upsertWorkspaceHostConnection,
  type StoredWorkspaceHostConnection,
  type StoredWorkspaceHostDestroyTarget,
  type WorkspaceHostConnectionInput,
} from '../workspace-host/observability-store';
import {
  createWorkspaceHostConnectionRoute,
  inspectWorkspaceHostConnection,
  type WorkspaceHostConnectionInspection,
  type WorkspaceHostConnectionRouteDependencies,
} from './routes/workspace-hosts/connection';
import {
  createWorkspaceHostProvisionRoute,
  type WorkspaceHostProvisionRouteDependencies,
} from './routes/workspace-hosts/provision';
import {
  createWorkspaceHostActionRoute,
  type WorkspaceHostActionRouteDependencies,
} from './routes/workspace-hosts/action';
import {
  isWorkspaceHostProvisioningDedupConflict,
  startWorkspaceHostDestroyWorkflow,
  startWorkspaceHostLifecycleWorkflow,
  startWorkspaceHostProvisioningWorkflow,
  WorkspaceHostProvisioningConflictError,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
  type StartWorkspaceHostProvisioningInput,
} from '../dbos/workspace-host-provision-workflow';
import type {
  WorkspaceHostOperationEnqueuer,
  WorkspaceHostProvisioningEnqueuer,
} from '../dbos/workspace-host-provision-client';
import type { WorkspaceHostOperationAcceptance } from '../workspace-host/admission-window';
import { dbosStarted } from '../dbos/bootstrap';
import {
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  hostedBringUpSupportsHost,
  type WorkspaceHostBringUp,
} from '../workspace-host/hosted-bring-up';
import type { HostedFirstWorkspace } from '../auth/hosted/first-workspace';
import { createHostedTutorialProgressRoutes, HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, type TutorialAssistanceDependencies } from './routes/hosted-tutorial-progress';
import { createHostedTutorialAssistanceRoutes } from './routes/hosted-tutorial-assistance-runtime';
import { exactOriginOr403, jsonError, selectedHostedPrincipal, tenantContext, workspaceHeaderMismatch, type HostedPrincipalSelection } from './hosted-browser-context';
import { acceptSyncTransportObservation } from './routes/desktop/telemetry-report';
import { createHostedCloudMonitoringRoutes, HOSTED_BROWSER_MONITORING_PATH, HOSTED_BROWSER_MONITORING_EVENT_PATH } from './routes/hosted-cloud-monitoring';
import { cloudProvisioningObservation, readCloudTelemetryConsent } from '../record-telemetry';
import { getBuildInfo } from '../build-info';
import { HostedCustomerDataAuthorizationError, HostedCustomerDeletionAdmissionError } from '../data-governance/hosted-customer-data';
import type { OrganizationDataExport } from '../data-governance/organization-data-receipts';
export { HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH } from './routes/hosted-tutorial-progress';

export const HOSTED_BROWSER_REST_QUERY_PATH = '/hosted/browser/rest-query' as const;
export const HOSTED_BROWSER_SSE_PATH = '/hosted/browser/sse' as const;
export const HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH = '/hosted/browser/fallback-observation' as const;
export const HOSTED_BROWSER_CONNECTION_PATH = '/hosted/browser/workspace-hosts/connection' as const;
export const HOSTED_BROWSER_PROVISION_PATH = '/hosted/browser/workspace-hosts/provision' as const;
export const HOSTED_BROWSER_ACTION_PATH = '/hosted/browser/workspace-hosts/action' as const;
/** The ONE hosted browser route reachable without a selected workspace (D-384). */
export const HOSTED_BROWSER_FIRST_WORKSPACE_PATH = '/hosted/browser/onboarding/first-workspace' as const;
/** Selects the organization's existing workspace for a session that holds none. */
export const HOSTED_BROWSER_SELECT_WORKSPACE_PATH = '/hosted/browser/onboarding/select-workspace' as const;
export const HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH = '/hosted/browser/data/organization/export' as const;
export const HOSTED_BROWSER_USER_EXPORT_PATH = '/hosted/browser/data/user/export' as const;
export const HOSTED_BROWSER_ORGANIZATION_DELETE_PATH = '/hosted/browser/data/organization/delete' as const;
export const HOSTED_BROWSER_USER_DELETE_PATH = '/hosted/browser/data/user/delete' as const;

export const HOSTED_BROWSER_QUERY_NAME = 'workspaceHosts.control' as const;

/** Stable manifest consumed by the hosted runtime composition root. */
export const HOSTED_BROWSER_ROUTE_ALLOWLIST = [
  { method: 'GET', path: HOSTED_BROWSER_REST_QUERY_PATH, access: 'authenticated' },
  { method: 'GET', path: HOSTED_BROWSER_SSE_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_CONNECTION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_PROVISION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_ACTION_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_FIRST_WORKSPACE_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_SELECT_WORKSPACE_PATH, access: 'authenticated' },
  { method: 'POST', path: HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_USER_EXPORT_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_USER_DELETE_PATH, access: 'session' },
  { method: 'GET', path: HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_TUTORIAL_HELP_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, access: 'session' },
  { method: 'GET', path: HOSTED_BROWSER_MONITORING_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_MONITORING_PATH, access: 'session' },
  { method: 'POST', path: HOSTED_BROWSER_MONITORING_EVENT_PATH, access: 'session' },
] as const;

const HOSTED_VIEW_AUTH = {
  capabilities: ['workspace:view'],
  kind: ['user'],
  trust: ['verified'],
} as const;
const HOSTED_OPERATE_AUTH = {
  capabilities: ['workspace:operate'],
  kind: ['user'],
  trust: ['verified'],
} as const;
const HOSTED_CONNECTION_AUTH = {
  capabilities: ['cloud-connection:manage'],
  kind: ['user'],
  trust: ['verified'],
} as const;
const HOSTED_FIRST_WORKSPACE_AUTH = {
  capabilities: ['cloud-connection:manage', 'workspace:operate'],
  kind: ['user'],
  trust: ['verified'],
} as const;

type AnyRoute = RouteDefinition<any>;

export interface HostedBrowserRouteDependencies {
  /** Same strict recorder as desktop ingress; payloads cannot choose storage scope. */
  readonly recordTransportFallback?: Parameters<typeof acceptSyncTransportObservation>[1];
  /** Injectable in route tests; production uses the canonical tenant wrapper. */
  readonly runTenant?: HostedTenantContextRunner;
  /** Revalidates membership/session and exports through the hosted service transaction. */
  readonly exportOrganizationData?: (principal: HostedPrincipal) => Promise<OrganizationDataExport>;
  readonly exportUserData?: (principal: HostedPrincipal) => Promise<OrganizationDataExport>;
  /** Service-transaction admission, followed by durable enqueue. Tenant and policy are server-owned. */
  readonly requestCustomerDeletion?: (principal: HostedPrincipal, input: {
    kind: 'organization' | 'user'; confirmation: string;
  }) => Promise<{ operationId: string }>;
  readonly readControl?: (workspaceId: string, tx?: Sql) => Promise<unknown[]>;
  readonly deliverCloudTelemetry?: typeof import('../telemetry-flush')['deliverCloudPosthog'];
  readonly readConnection?: (
    workspaceId: string,
    connectionId: string,
    tx?: Sql,
  ) => Promise<StoredWorkspaceHostConnection | null>;
  readonly upsertConnection?: (input: WorkspaceHostConnectionInput, tx?: Sql) => Promise<void>;
  readonly inspectConnection?: WorkspaceHostConnectionRouteDependencies['inspectConnection'];
  readonly readTarget?: (
    workspaceId: string,
    hostId: string,
    tx?: Sql,
  ) => Promise<StoredWorkspaceHostDestroyTarget | null>;
  readonly provisioningAvailable?: () => boolean;
  /**
   * The DBOS-client enqueuer for a process that does not run DBOS (the hosted control plane).
   * Present ⇒ provisioning is available here by construction and is ENQUEUED onto the
   * executor's queue with the server-derived fields (actor, D-015 bring-up) intact. Without it
   * the route forwards the raw request body to the controller's loopback route, which cannot
   * know the selected workspace, so a hosted retry silently loses its bring-up.
   */
  readonly provisioning?: WorkspaceHostProvisioningEnqueuer;
  /**
   * The same DBOS-client enqueuer, for lifecycle actions and destroy (WI-10005363). Present ⇒ the
   * action route admits and ENQUEUES here with the actor intact and answers 202 at once, instead
   * of forwarding the raw body to the controller (no actor, and a false 504 while it waits).
   */
  readonly operations?: WorkspaceHostOperationEnqueuer;
  /** The host the selected customer workspace is bound to, read under tenant RLS. */
  readonly readBoundHostId?: (
    controlPlaneWorkspaceId: string,
    customerWorkspaceId: string,
    tx?: Sql,
  ) => Promise<string | null>;
  /** The selected customer workspace's lifecycle state, read under tenant RLS (D-015 bring-up). */
  readonly readBoundWorkspaceState?: (
    controlPlaneWorkspaceId: string,
    customerWorkspaceId: string,
    tx?: Sql,
  ) => Promise<string | null>;
  /** Live hosts on one connection, for the per-connection instance cap, read under tenant RLS. */
  readonly listLiveHostIds?: (workspaceId: string, connectionId: string, tx?: Sql) => Promise<string[]>;
  /** The spent-host-id admission refusal (WI-10006929), read under tenant RLS. */
  readonly readSpentHostId?: typeof readWorkspaceHostIdSpent;
  readonly startProvisioning?: (
    input: StartWorkspaceHostProvisioningInput,
  ) => ReturnType<typeof startWorkspaceHostProvisioningWorkflow>;
  readonly startDestroy?: (
    input: StartWorkspaceHostDestroyInput,
  ) => ReturnType<typeof startWorkspaceHostDestroyWorkflow>;
  readonly startLifecycle?: (
    input: StartWorkspaceHostLifecycleInput,
  ) => ReturnType<typeof startWorkspaceHostLifecycleWorkflow>;
  readonly subscribe?: typeof subscribe;
  readonly backfillSince?: typeof backfillSince;
  /**
   * First-workspace bootstrap (D-384). Absent ⇒ the route answers 501, never a silent
   * fallback onto a workspace-scoped path.
   */
  readonly firstWorkspace?: HostedFirstWorkspace;
  /** Serializes the rotated hosted session cookie after the new workspace is selected. */
  readonly issueSessionCookie?: (sessionId: string, expiresAt: Date) => string;
  readonly tutorialAssistance?: TutorialAssistanceDependencies;
}

export interface HostedBrowserRouteConfiguration {
  readonly publicOrigin: string;
  /** The fixed operator workspace, never a customer-selected workspace. */
  readonly controlPlaneWorkspaceId: string;
  readonly dependencies?: HostedBrowserRouteDependencies;
}

export interface HostedBrowserRoutes {
  readonly routes: ReadonlyArray<AnyRoute>;
  readonly allowlist: typeof HOSTED_BROWSER_ROUTE_ALLOWLIST;
}

function exactHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('hosted_browser_public_origin_must_be_an_exact_https_origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('hosted_browser_public_origin_must_be_an_exact_https_origin');
  }
  return parsed.origin;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The bootstrap sibling of `selectedHostedPrincipal`: identical checks EXCEPT that it
 * requires the ABSENCE of a selected workspace. It is used by exactly one route and does
 * not widen any workspace-scoped route — a principal that already holds a workspace is
 * refused here, so this door cannot be used to act beside an existing tenant binding.
 */
function bootstrapHostedPrincipal(ctx: RouteContext, controlPlaneWorkspaceId: string): HostedPrincipalSelection {
  if (!ctx.principal || !isHostedPrincipal(ctx.principal)) {
    return { ok: false, response: jsonError('hosted_principal_required', 401) };
  }
  if (ctx.principal.workspaceId !== controlPlaneWorkspaceId) {
    return { ok: false, response: jsonError('control_plane_binding_mismatch', 403) };
  }
  if (ctx.principal.selectedWorkspaceId) {
    return { ok: false, response: jsonError('workspace_already_selected', 409) };
  }
  return { ok: true, principal: ctx.principal };
}

function parseQueryArgs(request: Request, selectedWorkspaceId: string): Response | null {
  const raw = new URL(request.url).searchParams.get('args') ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return jsonError('invalid_query_args', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonError('invalid_query_args', 400);
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  // The query currently has no caller-controlled arguments. Accepting the
  // selected workspace as a redundant assertion is useful to older clients,
  // but never use it as the authority.
  if (keys.length === 0) return null;
  if (keys.length === 1 && record.workspaceId === selectedWorkspaceId) return null;
  return jsonError('query_args_not_supported', 400);
}

function eventScope(event: SyncEvent): string | undefined {
  const args = event.args;
  if (!args) return undefined;
  for (const key of [
    'customerWorkspaceId',
    'customer_workspace_id',
    'selectedWorkspaceId',
    'selected_workspace_id',
    'workspaceId',
    'workspace_id',
  ]) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Hosted SSE carries invalidation metadata only, never rows. A scoped source
 * event is forwarded only to its customer (or the fixed control-plane source);
 * an unscoped invalidation is safe because the browser must re-read through the
 * tenant transaction and no cross-tenant payload is sent over the stream.
 */
function eventBelongsTo(event: SyncEvent, principal: HostedPrincipal): boolean {
  if (event.name !== HOSTED_BROWSER_QUERY_NAME) return false;
  const scope = eventScope(event);
  return scope === undefined || scope === principal.selectedWorkspaceId || scope === principal.workspaceId;
}

function hostedInvalidatePayload(event: SyncEvent): SyncSseEventVocabulary['invalidate'] {
  return { name: event.name, tsMs: event.ts };
}

function wrapTenantRead<T>(
  principal: HostedPrincipal,
  runTenant: HostedTenantContextRunner,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return runTenant(tenantContext(principal), fn);
}

function localConnectionRoute(
  config: HostedBrowserRouteConfiguration,
  principal: HostedPrincipal,
  deps: HostedBrowserRouteDependencies,
  runTenant: HostedTenantContextRunner,
) {
  const readConnection = deps.readConnection ?? readWorkspaceHostConnection;
  const upsertConnection = deps.upsertConnection ?? upsertWorkspaceHostConnection;
  const inspectConnection = deps.inspectConnection ?? inspectWorkspaceHostConnection;
  return createWorkspaceHostConnectionRoute({
    // Workspace-host rows keep the fixed control-plane workspace as their
    // Stage-A key.  `runTenant` below supplies the selected customer scope;
    // migration 979's hosted_app policy joins that key to the selected
    // customer workspace instead of rewriting the row key.
    activeWorkspaceId: () => config.controlPlaneWorkspaceId,
    readConnection: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) => readConnection(workspaceId, connectionId, tx)),
    upsertConnection: (input) => wrapTenantRead(principal, runTenant, (tx) => upsertConnection(input, tx)),
    inspectConnection,
  });
}

async function readCustomerWorkspaceHostId(
  controlPlaneWorkspaceId: string,
  customerWorkspaceId: string,
  tx?: Sql,
): Promise<string | null> {
  if (!tx) throw new Error('readCustomerWorkspaceHostId requires the tenant transaction');
  const rows = await tx<Array<{ workspace_host_id: string }>>`
    SELECT workspace_host_id
      FROM harness_shared.customer_workspaces
     WHERE workspace_id = ${controlPlaneWorkspaceId}
       AND id = ${customerWorkspaceId}
       AND state <> 'deleted'
       -- A relay-linked install (EAA D-031) has only a synthetic host id; it is never provisioned.
       AND kind = 'hosted'
  `;
  return rows[0]?.workspace_host_id ?? null;
}

async function readCustomerWorkspaceState(
  controlPlaneWorkspaceId: string,
  customerWorkspaceId: string,
  tx?: Sql,
): Promise<string | null> {
  if (!tx) throw new Error('readCustomerWorkspaceState requires the tenant transaction');
  const rows = await tx<Array<{ state: string }>>`
    SELECT state
      FROM harness_shared.customer_workspaces
     WHERE workspace_id = ${controlPlaneWorkspaceId}
       AND id = ${customerWorkspaceId}
       AND kind = 'hosted'
  `;
  return rows[0]?.state ?? null;
}

/**
 * aws-byoc-gcp-parity D-015: a hosted provision of the host bound to a customer workspace that
 * is still 'provisioning' owes that workspace its D-401 bring-up (initialize -> desktop pack ->
 * connector -> active). Without it a RETRY of a failed first provision ends at the bare machine
 * and the workspace stays 'provisioning' forever, Papercusp-hosted and BYOC alike.
 *
 * Derived on the server only. The caller has already been authorized for exactly this host (the
 * one bound to the selected workspace), and a workspace in any other state gets none: the
 * bring-up's empty-source initialize must never run against a host that already serves a
 * workspace. Only for a host the bring-up builder supports (GCP project / AWS account, D-015 rule 3).
 */
export async function hostedProvisionBringUp(
  input: StartWorkspaceHostProvisioningInput,
  customerWorkspaceId: string | undefined,
  readState: (customerWorkspaceId: string) => Promise<string | null>,
): Promise<WorkspaceHostBringUp | undefined> {
  if (!customerWorkspaceId) return undefined;
  if (!hostedBringUpSupportsHost(input.desired)) return undefined;
  if ((await readState(customerWorkspaceId)) !== 'provisioning') return undefined;
  return { customerWorkspaceId, requestedAgents: PAPERCUSP_HOSTED_BRING_UP_AGENTS };
}

/**
 * Provisioning through the DBOS-client enqueuer, answered as an acceptance: the workflow runs on
 * the executor, so this process can only report that it is queued. The operation id is fixed
 * before enqueueing so the acceptance names the exact workflow, and a duplicate enqueue maps to
 * the same typed conflict the in-process start raises.
 */
function enqueuedProvisioning(enqueuer: WorkspaceHostProvisioningEnqueuer) {
  return async (input: StartWorkspaceHostProvisioningInput): Promise<WorkspaceHostOperationAcceptance> => {
    const operationId = input.operationId ?? randomUUID();
    try {
      await enqueuer.enqueue({ ...input, operationId });
    } catch (error) {
      if (isWorkspaceHostProvisioningDedupConflict(error)) {
        throw new WorkspaceHostProvisioningConflictError(input.desired.hostId);
      }
      throw error;
    }
    return { status: 'accepted', operationId, hostId: input.desired.hostId };
  };
}

function localProvisionRoute(
  config: HostedBrowserRouteConfiguration,
  principal: HostedPrincipal,
  deps: HostedBrowserRouteDependencies,
  runTenant: HostedTenantContextRunner,
) {
  const readConnection = deps.readConnection ?? readWorkspaceHostConnection;
  const readBoundHostId = deps.readBoundHostId ?? readCustomerWorkspaceHostId;
  return createWorkspaceHostProvisionRoute({
    // Provisioning writes the same control-plane-keyed host graph.  The
    // selected tenant is enforced by the transaction/RLS context, not by
    // trusting a browser-supplied workspace id.
    activeWorkspaceId: () => config.controlPlaneWorkspaceId,
    provisioningAvailable: deps.provisioningAvailable ?? (deps.provisioning ? () => true : dbosStarted),
    // One workspace, one host (D-397): a customer may (re)provision only the host its
    // selected workspace is bound to — never mint another, never name someone else's.
    authorizeHost: async (hostId) => {
      const customerWorkspaceId = principal.selectedWorkspaceId;
      if (!customerWorkspaceId) return false;
      const bound = await wrapTenantRead(principal, runTenant, (tx) =>
        readBoundHostId(config.controlPlaneWorkspaceId, customerWorkspaceId, tx));
      return bound === hostId;
    },
    readConnection: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) => readConnection(workspaceId, connectionId, tx)),
    // The per-connection instance cap reads under the same tenant transaction as the
    // connection itself, so it can only ever count this tenant's hosts.
    listLiveHostIds: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) =>
        (deps.listLiveHostIds ?? listLiveWorkspaceHostIdsOnConnection)(workspaceId, connectionId, tx)),
    // The spent-id admission check reads the host's operation history under the same tenant
    // transaction, so it can only ever see the host this tenant is bound to.
    readSpentHostId: (workspaceId, hostId, request) =>
      wrapTenantRead(principal, runTenant, (tx) =>
        (deps.readSpentHostId ?? readWorkspaceHostIdSpent)(workspaceId, hostId, request, tx)),
    startProvisioning: async (input) => {
      const readState = deps.readBoundWorkspaceState ?? readCustomerWorkspaceState;
      const bringUp = await hostedProvisionBringUp(input, principal.selectedWorkspaceId ?? undefined, (customerWorkspaceId) =>
        wrapTenantRead(principal, runTenant, (tx) => readState(config.controlPlaneWorkspaceId, customerWorkspaceId, tx)));
      const start = deps.startProvisioning
        ?? (deps.provisioning ? enqueuedProvisioning(deps.provisioning) : startWorkspaceHostProvisioningWorkflow);
      return start({
        ...input,
        actorId: principal.userId,
        ...(bringUp ? { bringUp } : {}),
      });
    },
  });
}

function localActionRoute(
  config: HostedBrowserRouteConfiguration,
  principal: HostedPrincipal,
  deps: HostedBrowserRouteDependencies,
  runTenant: HostedTenantContextRunner,
) {
  const readTarget = deps.readTarget ?? readWorkspaceHostDestroyTarget;
  const readConnection = deps.readConnection ?? readWorkspaceHostConnection;
  const operations = deps.operations;
  return createWorkspaceHostActionRoute({
    // Lifecycle rows are likewise keyed by the fixed control-plane workspace;
    // the selected customer binding is carried only by `runTenant` + RLS.
    activeWorkspaceId: () => config.controlPlaneWorkspaceId,
    provisioningAvailable: deps.provisioningAvailable ?? (operations ? () => true : dbosStarted),
    readTarget: (workspaceId, hostId) =>
      wrapTenantRead(principal, runTenant, (tx) => readTarget(workspaceId, hostId, tx)),
    readConnection: (workspaceId, connectionId) =>
      wrapTenantRead(principal, runTenant, (tx) => readConnection(workspaceId, connectionId, tx)),
    startDestroy: (input) =>
      (deps.startDestroy ?? (operations ? enqueuedDestroy(operations) : startWorkspaceHostDestroyWorkflow))({
        ...input,
        actorId: principal.userId,
      }),
    startLifecycle: (input) =>
      (deps.startLifecycle ?? (operations ? enqueuedLifecycle(operations) : startWorkspaceHostLifecycleWorkflow))({
        ...input,
        actorId: principal.userId,
      }),
  });
}

/** A lifecycle action through the DBOS-client enqueuer, answered as an acceptance (WI-10005363). */
function enqueuedLifecycle(enqueuer: WorkspaceHostOperationEnqueuer) {
  return async (input: StartWorkspaceHostLifecycleInput): Promise<WorkspaceHostOperationAcceptance> => {
    try {
      const { operationId } = await enqueuer.enqueueLifecycle(input);
      return { status: 'accepted', operationId, hostId: input.hostId };
    } catch (error) {
      if (isWorkspaceHostProvisioningDedupConflict(error)) throw new WorkspaceHostProvisioningConflictError(input.hostId);
      throw error;
    }
  };
}

/** A destroy through the DBOS-client enqueuer, answered as an acceptance (WI-10005363). */
function enqueuedDestroy(enqueuer: WorkspaceHostOperationEnqueuer) {
  return async (input: StartWorkspaceHostDestroyInput): Promise<WorkspaceHostOperationAcceptance> => {
    try {
      const { operationId } = await enqueuer.enqueueDestroy(input);
      return { status: 'accepted', operationId, hostId: input.hostId };
    } catch (error) {
      if (isWorkspaceHostProvisioningDedupConflict(error)) throw new WorkspaceHostProvisioningConflictError(input.hostId);
      throw error;
    }
  };
}

function destroyPermissionDenied(request: Request, principal: HostedPrincipal): Promise<Response | null> {
  return request
    .clone()
    .json()
    .then((body: unknown) => {
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        (body as Record<string, unknown>).action === 'destroy'
      ) {
        if (!principal.capabilities.has('workspace:destroy')) return jsonError('permission_missing', 403);
      }
      return null;
    })
    .catch(() => null);
}

/** Compose the five routes that are reachable by the hosted static SPA. */
export function createHostedBrowserRoutes(configuration: HostedBrowserRouteConfiguration): HostedBrowserRoutes {
  const origin = exactHttpsOrigin(configuration.publicOrigin);
  const controlPlaneWorkspaceId = configuration.controlPlaneWorkspaceId.trim();
  if (!controlPlaneWorkspaceId) throw new TypeError('hosted_browser_requires_a_control_plane_workspace_id');
  const normalizedConfiguration: HostedBrowserRouteConfiguration = {
    ...configuration,
    publicOrigin: origin,
    controlPlaneWorkspaceId,
  };
  const deps = configuration.dependencies ?? {};
  const runTenant = deps.runTenant ?? withTenantContext;
  const readControl = deps.readControl ?? readWorkspaceHostControl;
  const subscribeEvents = deps.subscribe ?? subscribe;
  const backfill = deps.backfillSince ?? backfillSince;

  const exportRoute = (path: string, userOnly: boolean, read: HostedBrowserRouteDependencies['exportOrganizationData']) => defineTool({
    method: 'POST', path,
    auth: { capabilities: [], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const mismatch = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (mismatch) return mismatch;
      if (!principal.permissions.has(userOnly ? 'workspace:view' : 'members:manage')) return jsonError('customer_data_forbidden', 403);
      if (!read) return jsonError('customer_data_unavailable', 503);
      try {
        // No caller-supplied scope, user id or purpose is read.
        const exported = await read(principal);
        return Response.json(exported, { headers: {
          'cache-control': 'no-store', 'content-disposition': `attachment; filename="${userOnly ? 'user' : 'organization'}-data.json"`,
          'x-content-type-options': 'nosniff',
        } });
      } catch (error) {
        return error instanceof HostedCustomerDataAuthorizationError
          ? jsonError('customer_data_forbidden', 403) : jsonError('customer_data_unavailable', 503);
      }
    },
  });

  const organizationExport = exportRoute(HOSTED_BROWSER_ORGANIZATION_EXPORT_PATH, false, deps.exportOrganizationData);
  const userExport = exportRoute(HOSTED_BROWSER_USER_EXPORT_PATH, true, deps.exportUserData);

  const deleteRoute = (path: string, kind: 'organization' | 'user') => defineTool({
    method: 'POST', path, auth: { capabilities: [], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const csrf = exactOriginOr403(request, origin); if (csrf) return csrf;
      const mismatch = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId); if (mismatch) return mismatch;
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || typeof (body as { confirmation?: unknown }).confirmation !== 'string') return jsonError('confirmation_required', 400);
      const confirmation = (body as { confirmation: string }).confirmation;
      if (confirmation !== (kind === 'user' ? 'DELETE MY ACCOUNT' : 'DELETE ORGANIZATION')) return jsonError('confirmation_required', 400);
      if (!deps.requestCustomerDeletion) return jsonError('customer_deletion_unavailable', 503);
      try {
        // Read only the confirmation. Caller scope, policy, actor and workflow id are ignored.
        const result = await deps.requestCustomerDeletion(principal, { kind, confirmation });
        return Response.json({ status: 'accepted', operationId: result.operationId }, {
          status: 202, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        });
      } catch (error) {
        if (error instanceof HostedCustomerDataAuthorizationError) return jsonError('customer_data_forbidden', 403);
        if (error instanceof HostedCustomerDeletionAdmissionError) return jsonError(error.code,
          error.code === 'retention_policy_pending' ? 409 : error.code === 'confirmation_required' ? 400 : 409);
        return jsonError('customer_deletion_unavailable', 503);
      }
    },
  });
  const organizationDelete = deleteRoute(HOSTED_BROWSER_ORGANIZATION_DELETE_PATH, 'organization');
  const userDelete = deleteRoute(HOSTED_BROWSER_USER_DELETE_PATH, 'user');

  const fallbackObservation = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_FALLBACK_OBSERVATION_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const headerError = workspaceHeaderMismatch(request, selection.principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      return noStore(acceptSyncTransportObservation(await request.json().catch(() => null), deps.recordTransportFallback));
    },
  });

  const query = defineTool({
    method: 'GET',
    path: HOSTED_BROWSER_REST_QUERY_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const url = new URL(request.url);
      const name = url.searchParams.get('name');
      if (name !== HOSTED_BROWSER_QUERY_NAME) {
        return jsonError(name ? 'query_not_allowlisted' : 'missing_query_name', 400, { name });
      }
      const argsError = parseQueryArgs(request, principal.selectedWorkspaceId!);
      if (argsError) return argsError;
      const startedAt = Date.now();
      try {
        const rows = await wrapTenantRead(principal, runTenant, (tx) => readControl(controlPlaneWorkspaceId, tx));
        if (rows.some(row => row && typeof row === 'object' && 'operation' in row)) {
          // The primary read has already succeeded. Optional analytics neither
          // delays nor changes its response; every asynchronous delivery still
          // revalidates this user's current tenant/session and consent.
          void (async () => {
            const [hostId, state] = await wrapTenantRead(principal, runTenant, tx => Promise.all([
              (deps.readBoundHostId ?? readCustomerWorkspaceHostId)(controlPlaneWorkspaceId, principal.selectedWorkspaceId!, tx),
              (deps.readBoundWorkspaceState ?? readCustomerWorkspaceState)(controlPlaneWorkspaceId, principal.selectedWorkspaceId!, tx),
            ]));
            if (!hostId) return;
            const deliver = deps.deliverCloudTelemetry ?? (await import('../telemetry-flush')).deliverCloudPosthog;
            for (const row of rows) {
              if (!row || typeof row !== 'object' || !('id' in row) || row.id !== hostId) continue;
              const observation = cloudProvisioningObservation(row, state);
              if (!observation) continue;
              await deliver(observation.event, { principal, origin: 'control-plane', hostingMode: 'byoc',
                environment: process.env.PORT === '3170' ? 'staging' : process.env.NODE_ENV === 'production' ? 'production' : 'development',
                release: getBuildInfo().sha ?? '', observedAt: observation.observedAt },
              () => wrapTenantRead(principal, runTenant, tx => readCloudTelemetryConsent(tx, principal)));
            }
          })().catch(() => {});
        }
        const completedAt = Date.now();
        return new Response(
          JSON.stringify({
            rows,
            version: String(completedAt),
            timing: {
              unit: 'ms',
              resolverStartedAtMs: startedAt,
              resolverCompletedAtMs: completedAt,
              resolverMs: Math.max(0, completedAt - startedAt),
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      } catch {
        return jsonError('hosted_query_failed', 500, { name });
      }
    },
  });

  const sse = defineTool({
    method: 'GET',
    path: HOSTED_BROWSER_SSE_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    timeoutSec: null,
    sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const lastEventId = parseLastEventId(request);
      return sseResponse<SyncSseEventVocabulary>({
        signal: request.signal,
        lastEventId,
        heartbeatMs: 15_000,
        initialHeartbeat: true,
        replay: () =>
          backfill(lastEventId ?? 0)
            .filter((event) => eventBelongsTo(event, principal))
            .map((event) => ({
              name: 'invalidate' as const,
              data: hostedInvalidatePayload(event),
              id: event.id,
            })),
        setup: async (sink) => {
          const handle: SubscribeHandle = await subscribeEvents((event) => {
            if (!eventBelongsTo(event, principal) || sink.closed) return;
            // Never forward `event.data`: a full row payload would bypass the
            // tenant transaction that protects the REST read.
            sink.event('invalidate', hostedInvalidatePayload(event), { id: event.id });
          });
          sink.onClose(handle.close);
        },
        headers: { 'cache-control': 'no-store' },
      });
    },
  });

  const connection = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_CONNECTION_PATH,
    auth: HOSTED_CONNECTION_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      return noStore(
        await localConnectionRoute(normalizedConfiguration, principal, deps, runTenant).handler(request, ctx),
      );
    },
  });

  const provision = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_PROVISION_PATH,
    auth: HOSTED_OPERATE_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      return noStore(
        await localProvisionRoute(normalizedConfiguration, principal, deps, runTenant).handler(request, ctx),
      );
    },
  });

  const action = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_ACTION_PATH,
    auth: HOSTED_OPERATE_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const permission = await destroyPermissionDenied(request, principal);
      if (permission) return permission;
      return noStore(await localActionRoute(normalizedConfiguration, principal, deps, runTenant).handler(request, ctx));
    },
  });

  const firstWorkspace = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_FIRST_WORKSPACE_PATH,
    auth: HOSTED_FIRST_WORKSPACE_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      const selection = bootstrapHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      if (!deps.firstWorkspace || !deps.issueSessionCookie) return jsonError('first_workspace_unavailable', 501);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonError('invalid_json', 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('invalid_request', 400);
      const fields = body as Record<string, unknown>;
      // Only display text, the attempt key, the hosting choice, which of Papercusp's clouds
      // (Papercusp hosting only, aws-byoc-gcp-parity D-017) and (bring-your-own-cloud only) the
      // delegation configuration are read from the body. Tenant and identifier fields
      // (organization, workspace, host, connection, credential reference) come from the
      // verified session or are server-derived; first-workspace validates `provider`.
      const result = await deps.firstWorkspace.run({
        organizationId: principal.activeOrganizationId,
        userId: principal.userId,
        sessionId: principal.sessionId,
        sessionVersion: principal.sessionVersion,
        attemptKey: fields.attemptKey as string,
        displayName: fields.displayName as string,
        label: fields.label as string,
        hosting: fields.hosting as never,
        ...(fields.provider !== undefined ? { provider: fields.provider as never } : {}),
        // WI-10006498: the workspace's agent count sizes its VM; first-workspace validates it.
        ...(fields.expectedAgents !== undefined ? { expectedAgents: fields.expectedAgents as number } : {}),
        configuration: fields.configuration as never,
      });
      if (!result.ok) {
        return jsonError(result.code, result.status, {
          retryable: result.retryable,
          ...(result.template ? { template: result.template } : {}),
          ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        });
      }
      return Response.json(
        {
          ok: true,
          workspaceId: result.workspaceId,
          connectionId: result.connectionId,
          provisionOperationId: result.provisionOperationId,
        },
        {
          status: 201,
          headers: {
            'cache-control': 'no-store',
            'set-cookie': deps.issueSessionCookie(result.sessionId, result.sessionExpiresAt),
          },
        },
      );
    },
  });

  const selectWorkspace = defineTool({
    method: 'POST',
    path: HOSTED_BROWSER_SELECT_WORKSPACE_PATH,
    auth: HOSTED_VIEW_AUTH,
    cors: { origins: [origin] },
    async handler(request, ctx) {
      // Same door as first-workspace: only a session that holds NO workspace, so this can
      // never move a session off a workspace it already has.
      const selection = bootstrapHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      if (!deps.firstWorkspace || !deps.issueSessionCookie) return jsonError('first_workspace_unavailable', 501);
      // Nothing is read from the body: the organization comes from the verified session.
      const result = await deps.firstWorkspace.selectExisting({
        organizationId: principal.activeOrganizationId,
        sessionId: principal.sessionId,
        sessionVersion: principal.sessionVersion,
      });
      if (!result.ok) return jsonError(result.code, result.status, { retryable: result.retryable });
      return Response.json(
        { ok: true, workspaceId: result.workspaceId },
        {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'set-cookie': deps.issueSessionCookie(result.sessionId, result.sessionExpiresAt),
          },
        },
      );
    },
  });

  const tutorialProgress = createHostedTutorialProgressRoutes({ origin, controlPlaneWorkspaceId, runTenant,
    deliver: deps.deliverCloudTelemetry });
  const monitoring = createHostedCloudMonitoringRoutes({ origin, controlPlaneWorkspaceId, runTenant });
  const tutorialAssistance = createHostedTutorialAssistanceRoutes({ origin, controlPlaneWorkspaceId, runTenant, dependencies: deps.tutorialAssistance });
  return {
    routes: [query, sse, fallbackObservation, connection, provision, action, firstWorkspace, selectWorkspace, organizationExport, userExport, organizationDelete, userDelete, ...tutorialProgress, ...tutorialAssistance, ...monitoring],
    allowlist: HOSTED_BROWSER_ROUTE_ALLOWLIST,
  };
}

export default createHostedBrowserRoutes;

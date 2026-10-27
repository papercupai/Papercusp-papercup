/** Local GUI -> the existing customer-authorized operator-http connector.
 * Saved psu sign-ins supply identity; every request rechecks live membership,
 * inventory and a single-use ticket. No controller SSH/admin identity is lent
 * to a cloud customer, and a refusal never falls through to this machine. */
import { createHash, randomUUID } from 'node:crypto';
import { loadPsuConnectionStore } from '../../../../apps/operator/scripts/psu-connection-front-controller.mjs';
import { isLoopbackRequest } from '../superuser-token';
import { activeWorkspaceId, isKnownWorkspace } from '../workspace-registry';
import type { WorkspaceContextTransport } from '../workspace-context-middleware';
import { OperatorRelayChannel, OperatorRelayError, type RelaySocketFactory } from './operator-relay-client';
import { HOSTED_PRINCIPAL_USER_HEADER } from './hosted-operator-http';
import { HOSTED_CONNECTOR_LIVENESS_FRESH_MS } from '../endpoint-route/hosted-workspace-connector';

interface HostedSignIn {
  kind: string;
  origin: string;
  accessToken: string;
  expiresAt: string;
}
interface HostedMachine {
  id: string;
  hostId: string;
  displayName: string;
  reachable: boolean;
  state: string;
  connector?: {
    state: string; routeLabel: string; transport: string; generation: number; lastSeenAt: string | null;
  } | null;
}
export interface LocalMachineOperatorTransportOptions {
  readProfiles?: () => HostedSignIn[];
  fetch?: typeof fetch;
  socketFactory?: RelaySocketFactory;
  isLocalWorkspace?: (id: string) => boolean;
  readLocalControl?: () => Promise<unknown[]>;
}

export interface LocalMachineOperatorTransport extends WorkspaceContextTransport {
  mergeControlRows(request: Request, rows: unknown[]): Promise<unknown[]>;
}

async function localOwner(request: Request): Promise<boolean> {
  const headers = new Headers(request.headers);
  // A hosted request can arrive over loopback too. Its ticket grants only its
  // bound customer workspace, never this process owner's saved sign-ins.
  if (headers.has(HOSTED_PRINCIPAL_USER_HEADER)) return false;
  const url = new URL(request.url);
  if (!headers.has('host')) headers.set('host', url.host);
  if (!isLoopbackRequest(headers)) return false;
  const origin = headers.get('origin');
  if (!origin || origin === url.origin || [
    'http://localhost:1420', 'http://tauri.localhost', 'https://tauri.localhost',
  ].includes(origin)) return true;
  const { configuredLocalBrowserOrigins } = await import('../endpoint-route/route-stack');
  return configuredLocalBrowserOrigins().has(origin);
}
const refusal = (error: string, status: number) => Response.json({ ok: false, error }, { status });

export function createLocalMachineOperatorTransport(options: LocalMachineOperatorTransportOptions = {}): LocalMachineOperatorTransport {
  const fetchImpl = options.fetch ?? fetch;
  const localWorkspace = options.isLocalWorkspace ?? isKnownWorkspace;
  const readProfiles = options.readProfiles ?? (() => loadPsuConnectionStore().profiles as HostedSignIn[]);
  async function control(profile: HostedSignIn, path: string, init: RequestInit = {}) {
    // The maintained store validates production origins as HTTPS. Do not accept
    // redirect locations as authority or forward the bearer to a second origin.
    const response = await fetchImpl(`${profile.origin}/api${path}`, {
      ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${profile.accessToken}`, 'content-type': 'application/json' },
    });
    if (!response.ok) throw new OperatorRelayError('machine_authority_refused', response.status);
    return await response.json();
  }
  async function inventory(signal: AbortSignal) {
    const profiles = readProfiles().filter(p => p.kind === 'papercusp-hosted'
      && Date.parse(p.expiresAt) > Date.now());
    const rows = await Promise.all(profiles.map(async profile => {
      const result = await control(profile, '/hosted/cli/workspaces', { signal });
      if (result.ok !== true || !Array.isArray(result.workspaces))
        throw new OperatorRelayError('machine_inventory_invalid', 502);
      return result.workspaces.filter((row: HostedMachine) => typeof row?.id === 'string'
        && typeof row.hostId === 'string').map((workspace: HostedMachine) => ({ profile, workspace }));
    }));
    return rows.flat();
  }
  async function mergeControlRows(request: Request, rows: unknown[]): Promise<unknown[]> {
    if (!await localOwner(request)) return rows;
    const authorized = await inventory(request.signal);
    const existing = new Set(rows.map(row => (row as { id?: string })?.id));
    const machines = new Map<string, HostedMachine>();
    for (const { workspace } of authorized) {
      if (!existing.has(workspace.hostId)) machines.set(workspace.hostId, workspace);
    }
    return [...rows, ...[...machines.values()].map(workspace => ({
      kind: 'workspace', id: workspace.hostId, name: workspace.displayName,
      connectionId: '', target: 'papercusp-hosted', scopeLabel: 'Signed-in workspace',
      region: '', size: '', image: '', diskGiB: 0, network: '',
      desiredState: 'running', observedState: workspace.reachable ? 'running' : 'degraded',
      recoverability: { kind: 'none', label: 'Managed by workspace' }, capabilities: {},
      ...(workspace.connector ? { tunnel: { hostedConnector: {
        routeLabel: workspace.connector.routeLabel, transport: workspace.connector.transport,
      } }, hostedConnector: {
        ...workspace.connector, customerWorkspaceId: workspace.id,
        liveUntil: workspace.reachable && workspace.connector.lastSeenAt
          ? Date.parse(workspace.connector.lastSeenAt) + HOSTED_CONNECTOR_LIVENESS_FRESH_MS : null,
      } } : {}),
    }))];
  }
  return {
    mergeControlRows,
    async forwardMachineRequest(request, machine) {
      if (!await localOwner(request)) return refusal('local_machine_selection_requires_local_owner', 403);
      try {
        const url = new URL(request.url);
        // The selector's inventory belongs to this GUI's control plane even
        // while its other queries are pointed at a remote machine.
        if (request.method === 'GET' && url.pathname === '/api/zero-harness/rest-query'
          && url.searchParams.get('name') === 'workspaceHosts.control') {
          const rows = options.readLocalControl ? await options.readLocalControl()
            : await (await import('./observability-store')).readWorkspaceHostControl(activeWorkspaceId());
          return Response.json({ rows: await mergeControlRows(request, rows), version: String(Date.now()) });
        }
        const authorized = await inventory(request.signal);
        const matches = authorized.filter(row => row.workspace.hostId === machine);
        if (matches.length !== 1) return refusal(matches.length ? 'machine_signin_ambiguous' : 'machine_signin_required', 403);
        const { profile, workspace } = matches[0]!;
        if (!workspace.reachable) return refusal('selected_machine_unavailable', 503);
        if (request.method === 'GET' && url.pathname === '/api/hosted/auth/session') {
          return Response.json({ ok: true, session: { workspaceId: workspace.id } });
        }
        if (request.method === 'POST' && /^\/api\/hosted\/workspaces\/[^/]+\/connectors\/session-ticket$/.test(url.pathname)) {
          const body = await request.json();
          if (url.pathname !== `/api/hosted/workspaces/${encodeURIComponent(workspace.id)}/connectors/session-ticket`
            || body.hostId !== machine || body.routeLabel !== workspace.connector?.routeLabel
            || body.transport !== 'websocket' || body.audience !== 'workspace-operator')
            return refusal('machine_workspace_mismatch', 403);
          // Reuse one customer terminal across reconnects. This key is scoped by
          // the CLI token on the control plane and by workspace on the host.
          const session = `gui-${createHash('sha256').update(workspace.id).digest('hex').slice(0, 24)}`;
          const opened = await control(profile,
            `/hosted/cli/workspaces/${encodeURIComponent(workspace.id)}/terminal`, {
              method: 'POST', body: JSON.stringify({ session }), signal: request.signal,
            });
          const ticket = new URL(opened.socketUrl).searchParams.get('ticket');
          if (opened.ok !== true || !ticket || !/^ht_[A-Za-z0-9_-]{43}$/.test(ticket))
            return refusal('machine_ticket_invalid', 502);
          return Response.json({ ok: true, ticket, socketOrigin: new URL(profile.origin).origin });
        }
        const requestedWorkspace = request.headers.get('x-papercusp-workspace') ?? url.searchParams.get('ws');
        if (requestedWorkspace && requestedWorkspace !== workspace.id && !localWorkspace(requestedWorkspace))
          return refusal('machine_workspace_mismatch', 403);
        // A hosted machine owns one customer workspace. Return the membership-
        // authorized binding, never the service account's registry on that host.
        if (url.pathname === '/api/workspaces' && request.method === 'GET') {
          return Response.json({ current: workspace.id, workspaces: [{
            id: workspace.id, name: workspace.displayName, createdAt: 0,
          }] });
        }
        if (url.pathname === '/api/workspaces/switch' && request.method === 'POST') {
          const body = await request.json();
          return body.id === workspace.id ? Response.json({ ok: true, id: workspace.id })
            : refusal('machine_workspace_mismatch', 403);
        }
        // This is the existing CLI's membership-checked ticket door. Selecting
        // operator-http redeems it as HTTP; no terminal or agent is started.
        const opened = await control(profile,
          `/hosted/cli/workspaces/${encodeURIComponent(workspace.id)}/terminal`, {
            method: 'POST', body: JSON.stringify({ session: `gui-${randomUUID()}` }), signal: request.signal,
          });
        const ticket = new URL(opened.socketUrl).searchParams.get('ticket');
        if (opened.ok !== true || !ticket || !/^ht_[A-Za-z0-9_-]{43}$/.test(ticket))
          return refusal('machine_ticket_invalid', 502);
        const origin = new URL(profile.origin);
        const channel = await OperatorRelayChannel.open({ controlPlaneOrigin: origin.origin,
          publicOrigin: origin.origin, publicHost: origin.host }, ticket, options.socketFactory);
        try {
          url.searchParams.delete('desktopHost');
          if (url.searchParams.has('ws')) url.searchParams.set('ws', workspace.id);
          const headers: Record<string, string> = { 'x-papercusp-workspace': workspace.id };
          for (const name of ['content-type', 'accept', 'last-event-id', 'if-match']) {
            const value = request.headers.get(name);
            if (value) headers[name] = value;
          }
          const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
          const response = await channel.fetch(url.pathname + url.search, {
            method: request.method, headers, body, signal: request.signal,
          });
          if (!response.body) { channel.close(); return response; }
          const reader = response.body.getReader();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) { channel.close(); controller.close(); }
                else controller.enqueue(next.value);
              } catch (error) { channel.close(); controller.error(error); }
            },
            async cancel(reason) { channel.close(); await reader.cancel(reason); },
          });
          return new Response(stream, { status: response.status, headers: response.headers });
        } catch (error) { channel.close(); throw error; }
      } catch (error) {
        return refusal(error instanceof OperatorRelayError ? error.code : 'selected_machine_transport_failed',
          error instanceof OperatorRelayError ? error.status : 503);
      }
    },
  };
}

/** Extend the existing local named query; no saved credential is serialized. */
export function mergeLocalMachineControlRows(request: Request, rows: unknown[]): Promise<unknown[]> {
  return createLocalMachineOperatorTransport().mergeControlRows(request, rows);
}

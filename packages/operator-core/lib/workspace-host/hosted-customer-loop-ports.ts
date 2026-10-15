/** Private owned-loop ports. Reuse the projected dispatcher and the pinned
 * customer command transport; this source composition does not enable routes.
 * Model admission remains a separate authenticated, host-owned factory. */
import { posix } from 'node:path';
import { dispatchProjectedTool, lookupByMcpName, type DispatchProjectedDeps,
  type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { MODEL_PROVIDER_REQUEST_CAPTURE, captureModelProviderRequest,
  type ModelPort, type ModelRequest } from '../agent-loop/model-port';
import { createRoutedModelPort, type RoutedModelPortOptions } from '../agent-loop/provider-router';
import { isHostedPrincipal } from '../auth/hosted-principal';
import type { HostedBillingRuntime } from '../endpoint-route/hosted-billing-runtime';
import { capabilityToolset, type ToolDispatcher, type DispatchResult } from '../agent-loop/capability-toolset';
import { createOperatorOwnedLoopPort, type OperatorOwnedLoopPortOptions } from '../agent-loop/headless-invoke';
import type { HostedWorkspaceHostSessionAdapter, HostedCustomerOperatorHttpHandler } from './hosted-session-host';
import { awaitHostedCustomerOperation, bindHostedCustomerCommandExecutor, type HostedCustomerCommandDependencies,
  type HostedCustomerSessionBinding } from './hosted-customer-command';

export interface HostedCustomerLoopPortDependencies extends HostedCustomerCommandDependencies {
  /** Real host gating/telemetry deps; the customer override replaces any ambient handler override. */
  readonly dispatchDeps: DispatchProjectedDeps;
  /** Invocation lifetime from the private host, never a JSON tool argument. */
  readonly signal: AbortSignal;
  /** Test registry seam. Production resolves the existing capability:bash definition. */
  readonly lookupTool?: (name: string) => ProjectedTool | undefined;
  /** Required, independently authenticated model/budget host. Never ambient routing. */
  readonly createModelPort: (session: HostedCustomerSessionBinding,
    signal?: AbortSignal) => ModelPort | Promise<ModelPort>;
}

const SHELL_TOOL = 'capability:bash';

/** Prepare a private model factory using the existing router and billing
 * admission continuation. This installs no native route, credential, funding
 * reader or commercial policy. All of those remain independent host authority.
 * Subscription/direct-key routes cannot bypass the supplied paid admission. */
export function createHostedCustomerModelPortFactory(deps: {
  readonly billing: Pick<HostedBillingRuntime, 'openRouterRequestCapture'>;
  readonly resolvePrincipal: (signal: AbortSignal) => ReturnType<HostedCustomerCommandDependencies['resolvePrincipal']>;
  readonly openRouterAccounts: NonNullable<RoutedModelPortOptions['openRouterAccounts']>;
  readonly catalog?: RoutedModelPortOptions['catalog'];
  readonly createLanguageModel?: RoutedModelPortOptions['createLanguageModel'];
}): HostedCustomerLoopPortDependencies['createModelPort'] {
  const resolve = deps.resolvePrincipal;
  const capture = deps.billing.openRouterRequestCapture.bind(deps.billing);
  const options = { catalog: deps.catalog ?? null, openRouterAccounts: deps.openRouterAccounts,
    createLanguageModel: deps.createLanguageModel };
  const identityKeys = ['workspaceId', 'userId', 'activeOrganizationId', 'selectedWorkspaceId',
    'sessionId', 'sessionVersion'] as const;
  return (session, signal) => {
    if (!(signal instanceof AbortSignal) || signal.aborted) throw new Error('hosted_customer_model_unavailable');
    const expected = Object.freeze({ ...session });
    return { async *stream(input) {
      const { signal: callerSignal, account: _account, ownerId: _ownerId, ...body } = input;
      const request = structuredClone(body);
      const streamSignal = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
      // Check the immutable request before selecting any credential or provider.
      if (typeof request.model !== 'string' || !request.model.startsWith('openrouter/')) {
        throw new Error('hosted_customer_model_unavailable');
      }
      const readPrincipal = async () => {
        try {
          const result = await awaitHostedCustomerOperation(() => resolve(streamSignal), streamSignal);
          if (!result.ok || !isHostedPrincipal(result.principal)
            || !result.principal.permissions.has('workspace:operate') || !expected.selectedWorkspaceId
            || identityKeys.some(key => result.principal[key] !== expected[key])) return { ok: false } as const;
          return result;
        } catch { return { ok: false } as const; }
      };
      // A request's labels never select a tenant/account. Re-read again through
      // the billing continuation before admission, after credential selection.
      if (!(await readPrincipal()).ok) throw new Error('hosted_customer_model_unavailable');
      const port = createRoutedModelPort({ ...options, env: {}, credentials: async () => ({}),
        openRouterRequestCapture: capture(readPrincipal, streamSignal) });
      const iterator = port.stream({ ...request, signal: streamSignal, ownerId: expected.userId })[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await awaitHostedCustomerOperation(() => iterator.next(), streamSignal);
          if (next.done) break;
          const event = next.value;
          // Both the next pull (catalog/credential/model reads) and the private
          // admission continuation obey invocation cancellation even if a host
          // reader ignores its signal. Late admission still sees the aborted
          // signal; no canceled consumer can resume the router onto the wire.
          yield event.type === 'provider_request' ? { ...event,
            [MODEL_PROVIDER_REQUEST_CAPTURE]: () => awaitHostedCustomerOperation(
              () => captureModelProviderRequest(event), streamSignal) } : event;
        }
      } finally {
        const closing = iterator.return?.();
        // An async generator queues return behind a pending reader. Request
        // cleanup, but never wait indefinitely for it after cancellation.
        if (streamSignal.aborted) void closing?.catch(() => {});
        else await closing;
      }
    } };
  };
}

/** Prepare the existing native chat turn door on the VM's PRIVATE relay path.
 * Production does not install this callback until model/budget and customer OS
 * acceptance exists; the public/default HTTP native guard remains in force.
 * The route adapter owns prompt/persistence semantics and receives a port bound
 * to this exact request. JSON/header/account labels cannot create that port. */
export function createHostedCustomerChannelHttpHandler(
  deps: Omit<HostedCustomerLoopPortDependencies, 'resolvePrincipal' | 'sessionHeaders' | 'signal'> & {
    readonly workspaceId: string;
    readonly flushTelemetry?: OperatorOwnedLoopPortOptions['flushTelemetry'];
    readonly handleNativeRequest?: (request: Request,
      port: ReturnType<typeof createOperatorOwnedLoopPort>,
      execution: NonNullable<OperatorOwnedLoopPortOptions['customerExecution']>) => Promise<Response>;
  },
): HostedCustomerOperatorHttpHandler {
  const { handleNativeRequest: suppliedHandler, ...ports } = { ...deps };
  const handleNativeRequest: NonNullable<typeof suppliedHandler> = suppliedHandler ?? (async (request, _port, execution) => {
    const match = /^\/api\/harness\/([^/]+)\/agent-chats\/([^/]+)\/messages$/.exec(new URL(request.url).pathname);
    if (!match) throw new Error('hosted_customer_execution_denied');
    // Invoke the existing route privately; its default public mount is still
    // guarded. Keep structured history, PG session/approval state and the
    // transcript-before-done ordering rather than rebuilding a one-shot chat.
    const { createAgentChatMessagesRoute } = await import('../endpoint-route/routes/agent-chats');
    return createAgentChatMessagesRoute(execution).handler(request, {
      params: { slug: decodeURIComponent(match[1]), chatId: decodeURIComponent(match[2]) },
      principal: null, input: undefined, signal: request.signal, log: () => {},
    }) as Promise<Response>;
  });
  return async (request, { sessionHost, channelId }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !/^\/api\/harness\/[^/]+\/agent-chats\/[^/]+\/messages$/.test(path)) return undefined;
    let body: unknown;
    try { body = await request.clone().json(); } catch { return undefined; }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body as Record<string, unknown>).engine !== 'loop') return undefined;
    try {
      // Capture request lifetime before constructing a reusable invocation port.
      // Even a caller omitting invoke.signal remains bound to this request.
      const signal = sessionHost.customerInvocationSignal(channelId, request.signal);
      if (signal.aborted) throw new Error('hosted_customer_execution_denied');
      const requestHost: typeof sessionHost = Object.freeze({
        customerInvocationSignal: (id, callerSignal) => {
          if (id !== channelId || signal.aborted) throw new Error('hosted_customer_execution_denied');
          return sessionHost.customerInvocationSignal(id,
            callerSignal ? AbortSignal.any([signal, callerSignal]) : signal);
        },
        resolveCustomerPrincipal: (id, callerSignal) => {
          if (id !== channelId || signal.aborted) return Promise.resolve({ ok: false });
          return sessionHost.resolveCustomerPrincipal(id,
            callerSignal ? AbortSignal.any([signal, callerSignal]) : signal);
        },
      });
      const execution = customerChannelExecution({ ...ports, sessionHost: requestHost, channelId });
      const port = createOperatorOwnedLoopPort({ ...(ports.flushTelemetry ? { flushTelemetry: ports.flushTelemetry } : {}),
        customerExecution: execution });
      const response = await awaitHostedCustomerOperation(() => handleNativeRequest(request, port, execution), signal);
      if (!(response instanceof Response)) throw new Error('hosted_customer_execution_denied');
      return response;
    } catch {
      return Response.json({ error: 'hosted_native_loop_unavailable' }, { status: 403 });
    }
  };
}

/** Compose the existing one-shot native host on the customer VM. The local
 * workspace pin is distinct from the control-plane customer-workspace id.
 * No route installs this factory until independent acceptance is available. */
export function createHostedCustomerChannelOwnedLoopPort(
  deps: Omit<HostedCustomerLoopPortDependencies, 'resolvePrincipal' | 'sessionHeaders' | 'signal'> & {
    readonly workspaceId: string;
    readonly sessionHost: Pick<HostedWorkspaceHostSessionAdapter,
      'resolveCustomerPrincipal' | 'customerInvocationSignal'>;
    readonly channelId: string;
    readonly flushTelemetry?: OperatorOwnedLoopPortOptions['flushTelemetry'];
  },
): ReturnType<typeof createOperatorOwnedLoopPort> {
  return createOperatorOwnedLoopPort({ ...(deps.flushTelemetry ? { flushTelemetry: deps.flushTelemetry } : {}),
    customerExecution: customerChannelExecution(deps) });
}

function customerChannelExecution(
  deps: Parameters<typeof createHostedCustomerChannelOwnedLoopPort>[0],
): NonNullable<OperatorOwnedLoopPortOptions['customerExecution']> {
  const { workspaceId, sessionHost, channelId, flushTelemetry: _flushTelemetry, ...ports } = { ...deps };
  return { workspaceId, projectDir: ports.projectDir,
      async bind(callerSignal) {
        const signal = sessionHost.customerInvocationSignal(channelId, callerSignal);
        if (signal.aborted) throw new Error('hosted_customer_execution_denied');
        const bound = await bindHostedCustomerChannelLoopPorts({ ...ports, sessionHost, channelId, signal });
        const lookup = ports.lookupTool ?? lookupByMcpName;
        const tools = capabilityToolset({ dispatch: bound.dispatch, names: bound.toolNames, prefixes: [],
          registry: () => bound.toolNames.map(name => lookup(name)).filter((tool): tool is ProjectedTool => !!tool) });
        return { modelPort: bound.modelPort, tools, signal };
      },
  };
}

/** Compose privately on the customer VM. The host channel owns authentication;
 * request headers/account labels supply no authority. Route guard stays in place
 * until real customer process/model/current-build acceptance is available. */
export function bindHostedCustomerChannelLoopPorts(
  deps: Omit<HostedCustomerLoopPortDependencies, 'resolvePrincipal' | 'sessionHeaders'> & {
    readonly sessionHost: Pick<HostedWorkspaceHostSessionAdapter, 'resolveCustomerPrincipal'>;
    readonly channelId: string;
  },
): ReturnType<typeof bindHostedCustomerLoopPorts> {
  const { sessionHost, channelId, ...ports } = deps;
  return bindHostedCustomerLoopPorts({ ...ports, sessionHeaders: new Headers(),
    resolvePrincipal: () => sessionHost.resolveCustomerPrincipal(channelId, ports.signal) });
}
const refused = (): DispatchResult => ({ isError: true,
  content: [{ type: 'text', text: 'hosted_customer_tool_unavailable' }] });

export async function bindHostedCustomerLoopPorts(deps: HostedCustomerLoopPortDependencies): Promise<{
  readonly dispatch: ToolDispatcher;
  readonly modelPort: ModelPort;
  readonly toolNames: readonly string[];
}> {
  const command = await bindHostedCustomerCommandExecutor(deps);
  const lookup = deps.lookupTool ?? lookupByMcpName;
  const tool = lookup(SHELL_TOOL);
  // Pin the known command door, not capabilities from an arbitrary installation.
  if (!tool || tool.capabilities.length !== 1 || tool.capabilities[0] !== SHELL_TOOL
    || tool.needsWorkspaceTx) throw new Error('hosted_customer_tool_unavailable');
  const projectDir = deps.projectDir;
  const signal = deps.signal;
  if (!(signal instanceof AbortSignal)) throw new Error('hosted_customer_execution_denied');
  const createModelPort = deps.createModelPort;
  if (typeof createModelPort !== 'function') throw new Error('hosted_customer_model_unavailable');
  const dispatchDeps: DispatchProjectedDeps = { ...deps.dispatchDeps,
    overrideTool: async (name, input, ctx) => {
      // Never PASS_THROUGH to the operator-local handler, even for an unknown door.
      if (name !== SHELL_TOOL || !input || typeof input !== 'object') return refused() as never;
      const args = input as Record<string, unknown>;
      const unsupported = Object.keys(args).some(key =>
        !['command', 'cmd', 'cwd', 'timeout', 'run_in_background'].includes(key));
      if (unsupported || args.run_in_background === true || (args.command && args.cmd && args.command !== args.cmd)) {
        return refused() as never;
      }
      const text = args.command ?? args.cmd;
      if (typeof text !== 'string' || !text.trim()
        || (args.cwd !== undefined && typeof args.cwd !== 'string')) return refused() as never;
      const cwd = typeof args.cwd === 'string' ? posix.resolve(projectDir, args.cwd) : projectDir;
      const result = await command.run({ command: text, cwd, signal: ctx.signal,
        ...(args.timeout === undefined ? {} : { timeoutMs: args.timeout as number }) });
      return { content: [{ type: 'text', text: JSON.stringify({ output: result.stdout,
        stderr: result.stderr, exit_code: result.exitCode, signal: result.signal,
        task_id: result.taskId, task_enrolled: result.taskEnrolled }) }] };
    },
  };
  const dispatch: ToolDispatcher = async (name, input) => {
    if (name !== SHELL_TOOL) return refused();
    // Snapshot untrusted arguments before any asynchronous authorization read.
    let args: Record<string, unknown>;
    try { args = structuredClone(input); } catch { return refused(); }
    const session = await command.authorize(signal);
    const principal = { kind: 'user' as const, slug: session.userId, workspaceId: session.workspaceId,
      authMethod: 'cookie-session' as const, trust: 'verified' as const,
      capabilities: new Set([SHELL_TOOL]), allowedTools: new Set([SHELL_TOOL]) };
    const ctx = { principal, workspaceId: session.workspaceId, role: 'worker',
      projectDir, signal, quotaSubject: `hosted-session:${session.sessionId}`,
      log: () => {}, progress: () => {}, emit: () => {},
      spawn: async () => { throw new Error('hosted_customer_tool_unavailable'); },
      secret: async () => null } as UnifiedToolContext;
    const result = await dispatchProjectedTool(tool, name, args, ctx, dispatchDeps);
    if (!result.ok || !result.result) return { isError: true,
      content: [{ type: 'text', text: result.error?.code ?? 'hosted_customer_tool_unavailable' }] };
    return result.result as DispatchResult;
  };
  return { dispatch, toolNames: Object.freeze([SHELL_TOOL]), modelPort: {
    async *stream(input: ModelRequest) {
      // Account/owner labels from a loop request are not model admission authority.
      const { signal: requestSignal, account: _account, ownerId: _ownerId, ...body } = input;
      const streamSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const request = structuredClone(body);
      const session = await command.authorize(streamSignal);
      let port: ModelPort;
      try { port = await awaitHostedCustomerOperation(
        () => Promise.resolve(createModelPort(session, streamSignal)), streamSignal); }
      catch { throw new Error('hosted_customer_model_unavailable'); }
      await command.authorize(streamSignal);
      if (typeof port?.stream !== 'function') throw new Error('hosted_customer_model_unavailable');
      yield* port.stream({ ...request, signal: streamSignal, ownerId: session.userId });
    },
  } };
}

/**
 * Operator host for orchestrator's injected owned-loop execution port
 * (own-tui-full-divorce-2026-08-24 P-010).
 *
 * Dependency direction is deliberate: orchestrator declares the structural
 * port and knows nothing about operator-core; this module imports that type,
 * binds the real ModelPort + principal-aware capability dispatcher, and emits
 * the same bounded LoopEvent wire objects the interactive chat lane uses.
 * invoke.ts serializes those objects as NDJSON and owns run-output persistence.
 */
import {
  dispatchProjectedTool,
  lookupByMcpName,
} from '@papercusp/agent-mcp';
import type { OwnedLoopInvokePort } from '@papercusp/orchestrator';
import '../agent-tools/index';
import {
  capabilityToolset,
  type DispatchResult,
  type ToolDispatcher,
} from './capability-toolset';
import { runLoopChatTurn } from './chat-engine';
import type { ModelPort } from './model-port';
import type { ApprovalPort, LoopTool, LoopProviderRequestInfo } from './loop';
import { customerAgentExecutionRequired } from '../auth/loopback-peer-trust';
import {
  flushPendingTelemetry,
  PROJECTED_DEPS,
} from '../projected-tool-deps';

export interface OperatorOwnedLoopPortOptions {
  /** Private customer-VM composition. The host pins local workspace/cwd and
   * supplies BOTH model and tool authority from one authenticated channel.
   * This is not an invocation argument; labels in input cannot install it. */
  customerExecution?: {
    readonly workspaceId: string;
    readonly projectDir: string;
    readonly bind: (signal?: AbortSignal) => Promise<{
      readonly modelPort: ModelPort;
      readonly tools: LoopTool[];
      readonly signal: AbortSignal;
    }>;
  };
  /** A fixed port, or a trusted host factory evaluated anew for each invocation.
   * The factory closes over authenticated host/session state and receives only
   * cancellation; run/workspace/account labels are not billing authority.
   * An absent port uses createRoutedModelPort inside chat-engine. */
  modelPort?: ModelPort | ((signal?: AbortSignal) => ModelPort | Promise<ModelPort>);
  /** Test/specialized-host seam; production derives capability:* tools. */
  tools?: LoopTool[];
  /** Test seam. Production flushes the shared deferred tool ledger once/turn. */
  flushTelemetry?: () => Promise<void>;
  /** Trusted host composition, never an agent-supplied billing writer. */
  onProviderRequest?(info: LoopProviderRequestInfo,
    context: Readonly<{ runId: string; workspaceId: string; harnessSlug: string }>): Promise<void>;
}

const unattendedApprovalPort: ApprovalPort = {
  async requestApproval() {
    // Headless fleet workers have no interactive responder. Tool confinement,
    // role gates, quota, and telemetry remain enforced by dispatchProjectedTool;
    // HITL is an interactive policy layer, not the security boundary (D-011).
    return { approved: true, reason: 'headless owned-loop execution' };
  },
};

function buildCapabilityTools(
  request: Parameters<OwnedLoopInvokePort['invoke']>[0],
): LoopTool[] {
  const dispatchCtx = {
    workspaceId: request.workspaceId,
    harnessSlug: request.harnessSlug,
    role: request.role,
    runId: request.runId,
    spawnId: (process.env.PAPERCUSP_SPAWN_ID ?? '').trim() || `agent-loop-${request.runId}`,
    featureId: request.featureId,
    chunkId: request.chunkId,
    log: () => { /* */ },
    progress: () => { /* */ },
    emit: () => { /* */ },
    signal: request.signal,
    spawn: async () => {
      throw new Error('spawn not available inside the owned loop');
    },
    secret: async () => null,
    // A chunk implementation runs in its scratch cwd; capability:bash/edit/
    // write must resolve there, not in the harness's canonical project root.
    projectDir: request.cwd,
    stateDir: request.stateDir,
  };
  const dispatch: ToolDispatcher = async (name, args) => {
    const tool = lookupByMcpName(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      };
    }
    // The direct in-process host must carry the SAME dispatch deps as MCP/HTTP.
    // Passing `{}` here used to execute the tool successfully while silently
    // skipping tool_invocations telemetry, making D-015's MCP gate impossible.
    const result = await dispatchProjectedTool(
      tool,
      name,
      args,
      dispatchCtx as never,
      PROJECTED_DEPS,
    );
    if (!result.ok || !result.result) {
      return {
        isError: true,
        content: [{ type: 'text', text: result.error?.message ?? `dispatch of ${name} failed` }],
      };
    }
    return result.result as DispatchResult;
  };
  return capabilityToolset({ dispatch });
}

/** Build the operator-owned implementation of orchestrator's one-shot port. */
export function createOperatorOwnedLoopPort(
  options: OperatorOwnedLoopPortOptions = {},
): OwnedLoopInvokePort {
  const customerExecution = options.customerExecution && Object.freeze({ ...options.customerExecution });
  return {
    async invoke(input) {
      const request = Object.freeze({ ...input });
      const flushTelemetry = options.flushTelemetry ?? flushPendingTelemetry;
      const captureContext = Object.freeze({ runId: request.runId,
        workspaceId: request.workspaceId, harnessSlug: request.harnessSlug });
      const capture = options.onProviderRequest;
      const configuredModelPort = options.modelPort;
      try {
        if (request.signal?.aborted) return { exitCode: 130, stderr: 'owned-loop turn aborted' };
        // This operator-owned host cannot supply customer OS/tool authority.
        // A model factory alone never authorizes the ambient capability doors.
        if (customerAgentExecutionRequired() && !customerExecution) {
          return { exitCode: 1, stderr: 'owned-loop customer execution host unavailable' };
        }
        if (customerExecution && (!customerExecution.workspaceId.trim()
          || request.workspaceId !== customerExecution.workspaceId
          || request.cwd !== customerExecution.projectDir
          || request.projectDir !== customerExecution.projectDir)) {
          return { exitCode: 1, stderr: 'owned-loop customer execution host unavailable' };
        }
        let modelPort: ModelPort | undefined;
        let customerTools: LoopTool[] | undefined;
        let executionSignal = request.signal;
        let onAbort: (() => void) | undefined;
        try {
          if (customerExecution || typeof configuredModelPort === 'function') {
            const pending = Promise.resolve().then(async () => {
              if (!customerExecution) return (configuredModelPort as (signal?: AbortSignal) => ModelPort | Promise<ModelPort>)(request.signal);
              const bound = await customerExecution.bind(request.signal);
              if (typeof bound?.modelPort?.stream !== 'function' || !Array.isArray(bound.tools)
                || !(bound.signal instanceof AbortSignal)) throw new Error('invalid customer host');
              customerTools = bound.tools;
              executionSignal = request.signal ? AbortSignal.any([request.signal, bound.signal]) : bound.signal;
              return bound.modelPort;
            });
            const aborted = request.signal ? new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(new Error('aborted'));
              request.signal!.addEventListener('abort', onAbort, { once: true });
            }) : undefined;
            modelPort = await (aborted ? Promise.race([pending, aborted]) : pending);
          } else modelPort = configuredModelPort;
          // A supplied factory must not silently fall back to ambient routing.
          if ((customerExecution || configuredModelPort) && typeof modelPort?.stream !== 'function') throw new Error('invalid host port');
        } catch {
          if (request.signal?.aborted) return { exitCode: 130, stderr: 'owned-loop turn aborted' };
          return { exitCode: 1, stderr: customerExecution
            ? 'owned-loop customer execution host unavailable' : 'owned-loop model host unavailable' };
        } finally {
          if (onAbort) request.signal!.removeEventListener('abort', onAbort);
        }
        if (executionSignal?.aborted) return { exitCode: 130, stderr: 'owned-loop turn aborted' };
        const tools = customerExecution ? customerTools! : options.tools ?? buildCapabilityTools(request);
        const result = await runLoopChatTurn({
          chatId: request.runId,
          workspaceId: request.workspaceId,
          // invoke.ts's assembled prompt is already the subprocess USER message
          // (persona + runtime context + task). Keep that priority unchanged.
          system: '',
          transcript: [{
            role: 'user',
            content: request.prompt,
            ts: new Date().toISOString(),
          }],
          sink: {
            event(_name, data) {
              request.emit(data);
            },
          },
          model: request.model,
          ownerId: captureContext.runId,
          ...(executionSignal !== undefined ? { signal: executionSignal } : {}),
          tools,
          approvals: unattendedApprovalPort,
          ...(modelPort ? { port: modelPort } : {}),
          ...(capture ? { onProviderRequest: (info: LoopProviderRequestInfo) => capture(info, captureContext) } : {}),
        });

        if (result.errorMessage) {
          return { exitCode: 1, stderr: result.errorMessage };
        }
        if (result.stopReason === 'aborted') {
          return { exitCode: 130, stderr: 'owned-loop turn aborted' };
        }
        return { exitCode: 0 };
      } finally {
        // The writer is deferred per tool for latency; the one-shot worker
        // boundary is the honest place to make its whole run durable.
        await flushTelemetry();
      }
    },
  };
}

/** Shared, bounded correlation contract for the local MCP proxy → operator hop. */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import { headersFromExtra, urlFromExtra } from '@papercusp/tooldef-mcp';
import type { ScratchWriteProgress, ScratchWriteTimings } from './scratch-gc';

export const MCP_REQUEST_TRACE_HEADER = 'x-papercusp-mcp-trace-id';
export const MAX_MCP_REQUEST_TRACE_ID_CHARS = 36;

/**
 * Proxy-owned signal that the local MCP data plane recently retried or failed an
 * upstream hop. The proxy overwrites/removes any client value before forwarding,
 * so the operator can safely use it as a non-authoritative diagnostic hint.
 */
export const MCP_DATA_PLANE_DEGRADED_AT_HEADER = 'x-papercusp-mcp-data-plane-degraded-at';

export type McpRequestTraceStage =
  | 'request_started'
  | 'inner_dispatch_started'
  | 'inner_dispatch_settled'
  | 'deadline'
  | 'scratch_write_progress'
  | 'scratch_write_settled'
  | 'tools_list_completed'
  | 'proxy_response_finished'
  | 'stale_contract_rejected';

export type McpPreDispatchPhaseName =
  | 'operatorToolsLoad'
  | 'spawnContext'
  | 'transportScopeSetup'
  | 'toolContextBuild'
  | 'idempotencyReplayLookup'
  | 'dispatchPreflight';

export type McpReplayLookupPhaseName = 'pool_acquisition' | 'statement';

export interface McpReplayLookupPhaseError {
  name: string;
  code?: string;
}

export interface McpReplayLookupPhaseEvent {
  phase: McpReplayLookupPhaseName;
  state: 'started' | 'finished';
  elapsedMs?: number;
  error?: McpReplayLookupPhaseError;
}

export interface McpReplayLookupPhaseTimingsMs {
  poolAcquisitionMs: number | null;
  statementMs: number | null;
  activePhase: McpReplayLookupPhaseName | null;
  errors?: Partial<Record<McpReplayLookupPhaseName, McpReplayLookupPhaseError>>;
}

export interface McpPreDispatchPhaseTimingsMs extends Record<McpPreDispatchPhaseName, number | null> {
  /** Wall time before inner dispatch that these measured phases did not explain. */
  unattributedMs: number;
}

export type McpSessionBaselineObservation = 'recorded' | 'unavailable' | 'missing' | 'current' | 'stale';

export interface McpRequestTraceEvent {
  traceId: string;
  toolName: string;
  stage: McpRequestTraceStage;
  elapsedMs: number;
  deadlineMs?: number;
  phase?: 'pre_dispatch' | 'inner_dispatch';
  outcome?: 'success' | 'tool_error' | 'rejected';
  /** HTTP status when the proxy has finished flushing the response; not client receipt. */
  httpStatus?: number;
  /** Bounded local evidence captured when the proxy observed an incomplete upstream response. */
  upstreamResponseLifecycle?: {
    responseComplete: boolean;
    responseAborted: boolean;
    responseDestroyed: boolean;
    socketDestroyed: boolean | null;
    responseErrorCode: string | null;
    socketErrorCode: string | null;
  };
  afterDeadline?: boolean;
  /** Await durations from request entry through the inner-dispatch boundary. */
  preDispatchPhaseTimingsMs?: McpPreDispatchPhaseTimingsMs;
  /** The phase still awaiting when a pre-dispatch deadline fired. */
  preDispatchActivePhase?: McpPreDispatchPhaseName;
  /** Per-request subphases inside the idempotency replay lookup. */
  idempotencyReplayPhaseTimingsMs?: McpReplayLookupPhaseTimingsMs;
  /** One-shot phase snapshot when a result-door scratch spill exceeds five seconds. */
  scratchWriteProgress?: ScratchWriteProgress;
  /** Final per-write timing emitted if a spill settles after its dispatch trace. */
  scratchWriteTimings?: ScratchWriteTimings;
  /** Hashes only; never persist the protocol/native session identifiers themselves. */
  mcpSessionKeyFingerprint?: string | null;
  wireMcpSessionIdFingerprint?: string | null;
  nativeSessionClaimFingerprint?: string | null;
  nativeSessionCarrier?: 'header' | 'query' | 'none';
  sessionBaseline?: McpSessionBaselineObservation;
  servingGeneration?: string;
  previousGeneration?: string;
  declaredGeneration?: string;
  /** Bounded durations carried by `inner_dispatch_settled` to locate post-dispatch waits. */
  phaseTimingsMs?: {
    postDispatchToSettlement: number | null;
    resultDoor: number | null;
    advisory: number | null;
    advisoryFlagReads: number;
    /** Cumulative phases across this request's spill writes; concurrent writes may overlap. */
    scratchWrites?: ScratchWriteTimings & { count: number };
    /**
     * Request-correlated async PSU host-discovery operation totals. Function totals are
     * nested and overlap (for example findLiveHostAsync includes pathExistsAsync), so
     * they are attribution counters, not additive partitions of request time.
     */
    operationTimings?: McpRequestOperationTimings;
  };
}

export type McpRequestTraceOperation =
  | 'findLiveHostAsync'
  | 'listLiveHostsAsync'
  | 'pidIsPsuHostAsync'
  | 'pathExistsAsync';

export interface McpRequestOperationCounter {
  count: number;
  totalMs: number;
  maxMs: number;
}

export type McpRequestOperationTimings = Partial<Record<McpRequestTraceOperation, McpRequestOperationCounter>>;

export interface McpRequestTraceExecutionContext {
  operationTimings: McpRequestOperationTimings;
}

const mcpRequestTraceExecution = pinModuleState(
  '@papercusp/operator-core.mcp-request-trace.execution',
  () => new AsyncLocalStorage<McpRequestTraceExecutionContext>(),
);

export function createMcpRequestTraceExecutionContext(): McpRequestTraceExecutionContext {
  return { operationTimings: {} };
}

export function runWithMcpRequestTraceExecution<T>(
  context: McpRequestTraceExecutionContext,
  work: () => T,
): T {
  return mcpRequestTraceExecution.run(context, work);
}

/** Record one awaited-operation boundary under the active MCP request, when present. */
export function recordMcpRequestTraceOperation(
  operation: McpRequestTraceOperation,
  elapsedMs: number,
): void {
  try {
    const context = mcpRequestTraceExecution.getStore();
    if (!context) return;
    const duration = Number.isFinite(elapsedMs) ? Math.round(Math.max(0, elapsedMs) * 1000) / 1000 : 0;
    const counter = context.operationTimings[operation] ??= { count: 0, totalMs: 0, maxMs: 0 };
    counter.count += 1;
    counter.totalMs = Math.round((counter.totalMs + duration) * 1000) / 1000;
    counter.maxMs = Math.max(counter.maxMs, duration);
  } catch {
    // Instrumentation must never change the traced operation's result.
  }
}

export function mcpRequestTraceOperationTimings(
  context: McpRequestTraceExecutionContext,
): McpRequestOperationTimings | undefined {
  try {
    if (Object.keys(context.operationTimings).length === 0) return undefined;
    return Object.fromEntries(
      Object.entries(context.operationTimings).map(([operation, counter]) => [operation, { ...counter }]),
    ) as McpRequestOperationTimings;
  } catch {
    return undefined;
  }
}

type McpSessionSurfaceTraceInput = Pick<
  McpRequestTraceEvent,
  'traceId' | 'toolName' | 'stage' | 'elapsedMs'
> & {
  extra: unknown;
  sessionKey: string | null;
  sessionBaseline: McpSessionBaselineObservation;
  servingGeneration: string;
  previousGeneration?: string;
  declaredGeneration?: string;
  phase?: McpRequestTraceEvent['phase'];
  outcome?: McpRequestTraceEvent['outcome'];
};

function fingerprintSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/** Build bounded lifecycle evidence that distinguishes protocol and native sessions. */
export function buildMcpSessionSurfaceTraceEvent(input: McpSessionSurfaceTraceInput): McpRequestTraceEvent {
  let wireMcpSessionId: string | null = null;
  let nativeHeader = '';
  let nativeQuery = '';
  try {
    const headers = headersFromExtra(input.extra);
    wireMcpSessionId = headers.get('mcp-session-id');
    nativeHeader = (headers.get('x-papercusp-native-session') ?? '').trim();
  } catch {
    // Diagnostic identity extraction must never change the MCP response.
  }
  try {
    nativeQuery = (urlFromExtra(input.extra)?.searchParams.get('native_session') ?? '').trim();
  } catch {
    // An incomplete request envelope simply leaves the query identity absent.
  }
  const nativeClaim = nativeHeader || nativeQuery;
  return {
    traceId: input.traceId,
    toolName: input.toolName.slice(0, 120),
    stage: input.stage,
    elapsedMs: Math.max(0, input.elapsedMs),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    mcpSessionKeyFingerprint: fingerprintSessionId(input.sessionKey),
    wireMcpSessionIdFingerprint: fingerprintSessionId(wireMcpSessionId),
    nativeSessionClaimFingerprint: fingerprintSessionId(nativeClaim),
    nativeSessionCarrier: nativeHeader ? 'header' : nativeQuery ? 'query' : 'none',
    sessionBaseline: input.sessionBaseline,
    servingGeneration: input.servingGeneration,
    ...(input.previousGeneration ? { previousGeneration: input.previousGeneration } : {}),
    ...(input.declaredGeneration ? { declaredGeneration: input.declaredGeneration } : {}),
  };
}

/** Emit bounded, argument-free MCP handler evidence without changing request behavior. */
export function logMcpRequestTrace(event: McpRequestTraceEvent): void {
  try {
    console.info(`[mcp-request-trace] ${JSON.stringify(event)}`);
  } catch {
    // Diagnostics must never change the request result.
  }
}

/** Accept only the fixed UUID shape minted by the proxy; reject arbitrary client input. */
export function mcpTraceIdFromExtra(extra: unknown): string | null {
  const value = headersFromExtra(extra).get(MCP_REQUEST_TRACE_HEADER)?.trim() ?? '';
  if (value.length > MAX_MCP_REQUEST_TRACE_ID_CHARS) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

// One server-minted fallback per request object. Pinned so a split module
// record cannot hand two readers of the same request different ids.
const mintedTraceIds = pinModuleState('@papercusp/operator-core.mcp-request-trace.minted', () => ({
  byRequest: new WeakMap<object, string>(),
}));

/**
 * The request's trace id: the proxy-minted header when present, otherwise ONE
 * server-minted UUID per request `extra` (direct callers such as
 * `scripts/mcp-call.mjs` against :3170 bypass the proxy). Every reader of the
 * same request — the recorded `requestOrigin`, the settlement backfill keyed on
 * it, deadline and trace logs — must use this, never an independent
 * `mcpTraceIdFromExtra(extra) ?? randomUUID()`: two derivations gave a direct
 * call two different ids, so its settlement could never find its invocation
 * row (WI-6554700010008586).
 */
export function resolveMcpRequestTraceId(extra: unknown): string {
  const supplied = mcpTraceIdFromExtra(extra);
  if (supplied) return supplied;
  if (extra === null || typeof extra !== 'object') return globalThis.crypto.randomUUID();
  const existing = mintedTraceIds.byRequest.get(extra);
  if (existing) return existing;
  const minted = globalThis.crypto.randomUUID();
  mintedTraceIds.byRequest.set(extra, minted);
  return minted;
}

/** Accept only a bounded integer millisecond timestamp minted by the local proxy. */
export function mcpDataPlaneDegradedAtFromExtra(extra: unknown): number | null {
  const value = headersFromExtra(extra).get(MCP_DATA_PLANE_DEGRADED_AT_HEADER)?.trim() ?? '';
  if (!/^\d{1,16}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null;
}

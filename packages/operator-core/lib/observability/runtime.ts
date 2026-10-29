/** Owning-process composition. Portable helpers never configure export. */
import { pinModuleState } from '@papercusp/module-singleton';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { context, trace, TraceFlags } from '@opentelemetry/api';
import type { ExecutionBoundaryReceipt } from '@papercusp/test-config/execution-details';
import type { DispatchProjectedDeps } from '@papercusp/agent-mcp';
import type { GatewayRequestTimeline } from '../inference-gateway/request-stage-telemetry';
import { createTracing } from './tracing';
import { PosthogSpanExporter } from './posthog-exporter';
import { measureBootOperatorArtifact, type OperatorArtifactIdentity,
  type OperatorArtifactParentExpectation } from '../release/operator-artifact';
import { getBuildInfo } from '../build-info';
import { resolveConcreteHarnessSlug } from '../agent-tools/_harness-scope';

type DispatchStart = Parameters<NonNullable<DispatchProjectedDeps['onDispatchStart']>>[0];
type InvokeRequest = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
type Invocation = Parameters<NonNullable<DispatchProjectedDeps['recordInvocation']>>[0];

interface BoundaryContext { callId: string; workspaceId: string; harness: string; tool: string;
  receipts: ExecutionBoundaryReceipt[] }

/** Hash the actual loaded function body. Reading its source file here would
 * race a working-tree edit and could label old compiled code with new bytes. */
export function loadedHandlerFingerprint(handler: (...args: never[]) => unknown): string | null {
  try { return createHash('sha256').update(Function.prototype.toString.call(handler)).digest('hex'); } catch { return null; }
}

/** A parent dispatch span or request trace ID cannot create this child receipt. */
export async function observeEngineeringBoundary<T>(sourceFingerprint: string | null, work: () => Promise<T>):
Promise<{ result: T; boundaryObservation?: ExecutionBoundaryReceipt; boundaryObservationGap?: string }> {
  const current = state.boundaryContext.getStore();
  const parent = current && state.runtime?.current(current.callId);
  if (!current || current.tool !== 'graph:query' || !parent || !sourceFingerprint
    || current.receipts.length >= 8) return { result: await work(), boundaryObservationGap:
      !current || !parent ? 'trace-unavailable' : !sourceFingerprint ? 'source-unavailable'
        : current.receipts.length >= 8 ? 'boundary-limit' : 'instrumentation-context-unavailable' };
  let span: ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>;
  try { span = state.runtime!.provider.getTracer('papercusp.runtime', '1').startSpan('papercusp.engineering-evidence'); }
  catch { state.observerFailures++; return { result: await work(), boundaryObservationGap: 'trace-observer-failed' }; }
  const identity = span.spanContext();
  const startedAt = Date.now();
  let outcome: 'ok' | 'error' = 'ok';
  let observation: ExecutionBoundaryReceipt | undefined;
  let result: T;
  const recording = span.isRecording() && Boolean(identity.traceFlags & TraceFlags.SAMPLED);
  try { result = await context.with(trace.setSpan(context.active(), span), work); }
  catch (error) { outcome = 'error'; throw error; }
  finally {
    try {
      span.end();
      if (recording) {
        const sha = getBuildInfo().sha;
        const buildSha = sha && /^[a-f0-9]{10,64}$/.test(sha) ? sha : null;
        observation = { boundary: 'graph:query:evidence', callId: current.callId,
          workspaceId: current.workspaceId, harness: current.harness,
          traceId: identity.traceId, spanId: identity.spanId, traceFlags: identity.traceFlags,
          parentSpanId: parent.spanId, startedAt, endedAt: Date.now(), outcome, sourceFingerprint, buildSha,
          artifactFingerprint: state.artifact?.status === 'measured' ? state.artifact.bundleSha256 : null,
          environmentFingerprint: createHash('sha256').update(JSON.stringify({ node: process.version,
            platform: process.platform, arch: process.arch, processId: process.pid, buildSha })).digest('hex'),
          workflowId: null };
        current.receipts.push(observation);
      }
    } catch { state.observerFailures++; }
  }
  return { result, ...(observation ? { boundaryObservation: observation } : {
    boundaryObservationGap: identity.traceFlags & TraceFlags.SAMPLED ? 'trace-not-recording' : 'trace-sampled-out' }) };
}

export async function runtimeTraceDeliveryConfig() {
  const [{ resolveTelemetryConfig }, { customerAgentExecutionRequired }] = await Promise.all([
    import('../telemetry-flush'), import('../auth/loopback-peer-trust'),
  ]);
  const config = await resolveTelemetryConfig();
  return {
    allowed: process.env.NODE_ENV === 'production' && !customerAgentExecutionRequired() && (config.optedIn || config.internalBuild),
    host: config.host ?? '', projectKey: config.projectKey ?? '', distinctId: config.distinctId,
    consentSince: config.consentSince,
  };
}

const state = pinModuleState('@papercusp/operator-core.otel-runtime', () => ({
  runtime: null as ReturnType<typeof createTracing> | null,
  exporter: null as PosthogSpanExporter | null,
  observerFailures: 0,
  artifact: null as OperatorArtifactIdentity | null,
  artifactParent: undefined as string | undefined,
  registration: null as ReturnType<ReturnType<typeof createTracing>['register']> | null,
  boundaryContext: new AsyncLocalStorage<BoundaryContext>(),
  boundaryReceipts: new Map<string, ExecutionBoundaryReceipt[]>(),
}));
// An already running development host can retain the pre-extension singleton.
state.boundaryContext ??= new AsyncLocalStorage<BoundaryContext>();
state.boundaryReceipts ??= new Map<string, ExecutionBoundaryReceipt[]>();

function runtime() {
  if (!state.runtime) {
    state.exporter = new PosthogSpanExporter(runtimeTraceDeliveryConfig);
    state.runtime = createTracing({ exporter: state.exporter });
    state.registration = state.runtime.register();
  }
  return state.runtime;
}

/** Called during host boot before DBOS can install a competing global provider. */
export function initializeRuntimeObservability(parent?: OperatorArtifactParentExpectation): void {
  const parentPin = parent === undefined ? undefined : JSON.stringify(parent);
  // A later invocation cannot relabel an already initialized legacy process or
  // replace the original inherited input. Qualification belongs to fresh boot.
  if (state.artifact && state.artifactParent !== parentPin) throw Error('BG boot parent expectation changed');
  if (!state.artifact) {
    const artifact = measureBootOperatorArtifact(process.argv[1] ?? '', getBuildInfo().sha, undefined, parent);
    if (parent !== undefined && artifact.status !== 'measured') throw Error('BG boot parent artifact unqualified');
    state.artifact = artifact;
    state.artifactParent = parentPin;
  }
  try { runtime(); } catch { state.observerFailures++; }
}

export function beginToolTrace(event: DispatchStart): void {
  try {
    // Hosted customers have a separate verified tenant/consent transaction.
    if (!event.callId || (event.ctx.principal as { profile?: string } | undefined)?.profile === 'hosted') return;
    runtime().begin(event.callId, 'papercusp.tool', {
      'papercusp.call_id': event.callId, 'papercusp.tool': event.toolName,
      'papercusp.workspace_id': event.ctx.workspaceId,
      'papercusp.harness': event.ctx.harnessSlug,
      'papercusp.request_id': event.ctx.requestOrigin?.mcpRequestTraceId,
    }, event.ctx.requestOrigin?.headers);
  } catch { state.observerFailures++; }
}

export function runToolTrace(request: InvokeRequest, invoke: () => ReturnType<InvokeRequest['invoke']>) {
  // Never retry a handler after a tracing failure: it might already have committed.
  if (!state.runtime) return invoke();
  const receipts: ExecutionBoundaryReceipt[] = [];
  if (state.boundaryReceipts.size < 1024) state.boundaryReceipts.set(request.callId, receipts);
  return state.runtime.run(request.callId, () => state.boundaryContext.run({ callId: request.callId,
    // A receipt's harness is an identity: the operator `'*'` scope is not one, so it stays ''
    // (receipt validation then rejects it, exactly as the consumer's scope check did for '*').
    workspaceId: request.ctx.workspaceId ?? '', harness: resolveConcreteHarnessSlug(undefined, request.ctx) ?? '',
    tool: request.toolName, receipts }, invoke));
}

export function finishToolTrace(input: Invocation) {
  const boundaryObservations = input.callId ? state.boundaryReceipts.get(input.callId) : undefined;
  if (input.callId) state.boundaryReceipts.delete(input.callId);
  try {
    const correlation = input.callId ? state.runtime?.finish(input.callId, input.status, input.errorCode ?? undefined) : undefined;
    return correlation ? { ...correlation, callId: input.callId,
      ...(boundaryObservations?.length ? { boundaryObservations } : {}) } : undefined;
  }
  catch { state.observerFailures++; return undefined; }
}

/** Only the maintained transport supplies this; caller metadata is overwritten
 * by finishToolTrace at the invocation writer. Ordinary tools imply no model. */
export function expectSuccessfulToolModelTrace(requestId?: string | null): void {
  try { state.runtime?.expectModel(requestId); } catch { state.observerFailures++; }
}

export function beginGatewayTrace(key: string, provider: string, headers: Record<string, string>) {
  try { runtime().begin(key, 'papercusp.model', { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider,
    'papercusp.request_id': key }, headers); }
  catch { state.observerFailures++; }
}

export function finishGatewayTrace(key: string, timeline: GatewayRequestTimeline): void {
  try {
    const r = state.runtime;
    if (!r) return;
    r.attributes(key, {
      'gen_ai.request.model': timeline.model ?? undefined,
      'gen_ai.usage.input_tokens': timeline.cache.inputTokens ?? undefined,
      'gen_ai.usage.cache_read.input_tokens': timeline.cache.cacheReadTokens ?? undefined,
      'papercusp.request_ordinal': timeline.requestId,
      'papercusp.attempts': timeline.attempts,
      'papercusp.queue_wait_ms': timeline.durationsMs.queueWait,
      'papercusp.provider_wait_ms': timeline.durationsMs.upstreamTtfb,
    });
    r.finish(key, timeline.outcome, timeline.outcome === 'ok' ? undefined : 'provider_error');
  } catch { state.observerFailures++; }
}

export function runtimeObservabilityHealth() {
  return { initialized: state.runtime !== null, observerFailures: state.observerFailures,
    artifact: state.artifact,
    globalProviderRegistered: state.registration?.registered ?? false,
    tracing: state.runtime?.health() ?? null, posthog: state.exporter?.health() ?? null };
}

export async function flushRuntimeObservability(): Promise<void> { await state.runtime?.flush(); }

export async function shutdownRuntimeObservability(): Promise<void> {
  state.registration?.disable();
  await state.runtime?.shutdown();
  state.runtime = null;
  state.exporter = null;
  state.registration = null;
  state.boundaryReceipts.clear();
}

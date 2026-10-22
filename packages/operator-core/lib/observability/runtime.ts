/** Owning-process composition. Portable helpers never configure export. */
import { pinModuleState } from '@papercusp/module-singleton';
import type { DispatchProjectedDeps } from '@papercusp/agent-mcp';
import type { GatewayRequestTimeline } from '../inference-gateway/request-stage-telemetry';
import { createTracing, enableTracingContext } from './tracing';
import { PosthogSpanExporter } from './posthog-exporter';

type DispatchStart = Parameters<NonNullable<DispatchProjectedDeps['onDispatchStart']>>[0];
type InvokeRequest = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
type Invocation = Parameters<NonNullable<DispatchProjectedDeps['recordInvocation']>>[0];

export async function runtimeTraceDeliveryConfig() {
  const [{ resolveTelemetryConfig }, { customerAgentExecutionRequired }] = await Promise.all([
    import('../telemetry-flush'), import('../auth/loopback-peer-trust'),
  ]);
  const config = await resolveTelemetryConfig();
  return {
    allowed: process.env.NODE_ENV === 'production' && !customerAgentExecutionRequired() && (config.optedIn || config.internalBuild),
    host: config.host ?? '', projectKey: config.projectKey ?? '', distinctId: config.distinctId,
  };
}

const state = pinModuleState('@papercusp/operator-core.otel-runtime', () => ({
  runtime: null as ReturnType<typeof createTracing> | null,
  exporter: null as PosthogSpanExporter | null,
  observerFailures: 0,
}));

function runtime() {
  if (!state.runtime) {
    enableTracingContext();
    state.exporter = new PosthogSpanExporter(runtimeTraceDeliveryConfig);
    state.runtime = createTracing({ exporter: state.exporter });
  }
  return state.runtime;
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
  return state.runtime ? state.runtime.run(request.callId, invoke) : invoke();
}

export function finishToolTrace(input: Invocation) {
  try { return input.callId ? state.runtime?.finish(input.callId, input.status, input.errorCode ?? undefined) : undefined; }
  catch { state.observerFailures++; return undefined; }
}

export function beginGatewayTrace(key: string, provider: string, headers: Record<string, string>) {
  try { runtime().begin(key, 'papercusp.model', { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': provider }, headers); }
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
    tracing: state.runtime?.health() ?? null, posthog: state.exporter?.health() ?? null };
}

export async function flushRuntimeObservability(): Promise<void> { await state.runtime?.flush(); }

/** Live OTel correlation. Existing invocation/workflow records remain authoritative. */
import { context, trace, ROOT_CONTEXT, SpanStatusCode, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';

export const TRACE_ATTRIBUTE_KEYS = new Set([
  'service.name', 'papercusp.workspace_id', 'papercusp.harness', 'papercusp.tool',
  'papercusp.call_id', 'papercusp.request_id', 'papercusp.session_id',
  'papercusp.outcome', 'papercusp.error_code', 'papercusp.request_ordinal',
  'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.usage.input_tokens',
  'gen_ai.usage.cache_read.input_tokens', 'gen_ai.operation.name',
  'papercusp.queue_wait_ms', 'papercusp.provider_wait_ms', 'papercusp.attempts',
]);

/** Strict, scalar-only export vocabulary: no args, exceptions, URLs or content. */
export function safeTraceAttributes(input: Attributes): Attributes {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    TRACE_ATTRIBUTE_KEYS.has(key) && (typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value) ||
      typeof value === 'string' && value.length <= 200 && !/[\r\n\u0000]/.test(value))));
}

const getter = { keys: (carrier: Record<string, string>) => Object.keys(carrier),
  get: (carrier: Record<string, string>, key: string) => carrier[key] };
const setter = { set: (carrier: Record<string, string>, key: string, value: string) => { carrier[key] = value; } };
const propagator = new W3CTraceContextPropagator();

export function extractTraceContext(carrier: Record<string, string> = {}, parent = ROOT_CONTEXT): Context {
  // Propagate trace identity only. Baggage is deliberately not accepted across trust boundaries.
  const traceparent = carrier.traceparent;
  return propagator.extract(parent, typeof traceparent === 'string' && traceparent.length <= 512 ? { traceparent } : {}, getter);
}

export function injectTraceContext(parent = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagator.inject(parent, carrier, setter);
  return carrier;
}

export function createTracing(options: { exporter?: SpanExporter; processor?: SpanProcessor; service?: string; maxActive?: number } = {}) {
  const processors = options.processor ? [options.processor] : options.exporter ? [new BatchSpanProcessor(options.exporter, {
    maxQueueSize: 2048, maxExportBatchSize: 64, scheduledDelayMillis: 5_000, exportTimeoutMillis: 3_000,
  })] : [];
  const provider = new BasicTracerProvider({ spanProcessors: processors,
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 200, eventCountLimit: 0, linkCountLimit: 8 } });
  const tracer = provider.getTracer('papercusp.runtime', '1');
  const active = new Map<string, { span: Span; context: Context }>();
  let skipped = 0;
  return {
    provider,
    begin(callId: string, name: string, attributes: Attributes, carrier?: Record<string, string>, startTime?: number) {
      if (active.has(callId) || active.size >= (options.maxActive ?? 1024)) { skipped++; return undefined; }
      const parent = carrier?.traceparent ? extractTraceContext(carrier) : context.active();
      const span = tracer.startSpan(name, { attributes: safeTraceAttributes({ 'service.name': options.service ?? 'papercusp-operator', ...attributes }), startTime }, parent);
      const executionContext = trace.setSpan(parent, span);
      active.set(callId, { span, context: executionContext });
      return span.spanContext();
    },
    async run<T>(callId: string, work: () => Promise<T>): Promise<T> {
      const entry = active.get(callId);
      return entry ? context.with(entry.context, work) : work();
    },
    attributes(callId: string, attributes: Attributes) {
      active.get(callId)?.span.setAttributes(safeTraceAttributes(attributes));
    },
    current(callId: string) {
      const span = active.get(callId)?.span;
      if (!span) return undefined;
      const { traceId, spanId, traceFlags } = span.spanContext();
      return { traceId, spanId, traceFlags };
    },
    finish(callId: string, outcome: string, errorCode?: string, endTime?: number) {
      const entry = active.get(callId);
      if (!entry) return undefined;
      const correlation = this.current(callId);
      active.delete(callId);
      entry.span.setAttributes(safeTraceAttributes({ 'papercusp.outcome': outcome, ...(errorCode ? { 'papercusp.error_code': errorCode } : {}) }));
      entry.span.setStatus({ code: outcome === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      entry.span.end(endTime);
      return correlation;
    },
    health: () => ({ active: active.size, skipped, maxActive: options.maxActive ?? 1024 }),
    flush: () => provider.forceFlush(),
    async shutdown() {
      for (const id of active.keys()) this.finish(id, 'shutdown');
      await provider.shutdown();
    },
  };
}

/** Register once in the owning runtime, never from the browser or portable worker. */
export function enableTracingContext(): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

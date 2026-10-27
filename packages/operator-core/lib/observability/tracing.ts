/** Live OTel correlation. Existing invocation/workflow records remain authoritative. */
import { context, trace, propagation, createContextKey, ROOT_CONTEXT, SpanStatusCode, TraceFlags, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { TracerProvider, BatchSpanProcessor, type SpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

export const TRACE_ATTRIBUTE_KEYS = new Set([
  'service.name', 'papercusp.workspace_id', 'papercusp.harness', 'papercusp.tool',
  'papercusp.call_id', 'papercusp.request_id', 'papercusp.session_id',
  'papercusp.outcome', 'papercusp.error_code', 'papercusp.request_ordinal',
  'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens', 'gen_ai.operation.name',
  'papercusp.queue_wait_ms', 'papercusp.provider_wait_ms', 'papercusp.attempts',
  'dbos.operation.workflow_id', 'operationUUID',
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
const invocationAttributes = createContextKey('papercusp.invocation.attributes');
export const MODEL_REQUEST_ID_HEADER = 'x-papercusp-model-request-id';
export const MAX_EXPECTED_MODEL_REQUESTS = 64;
export function isModelRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[1-9][0-9]{0,15}$/.test(value);
}

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

export function createTracing(options: { exporter?: SpanExporter; processor?: SpanProcessor; service?: string; maxActive?: number; maxQueued?: number; maxDurationMs?: number; now?: () => number } = {}) {
  const maxQueued = options.maxQueued ?? 2048;
  let queuedSpans = 0;
  let queueDroppedSpans = 0;
  let drained = Promise.resolve();
  let resolveDrained = () => {};
  const trackedExporter: SpanExporter | undefined = options.exporter ? {
    export(spans, callback) {
      options.exporter!.export(spans, result => {
        queuedSpans -= spans.length;
        if (queuedSpans === 0) resolveDrained();
        callback(result);
      });
    },
    shutdown: () => options.exporter!.shutdown(),
  } : undefined;
  const processors = options.processor ? [options.processor] : trackedExporter ? [new BatchSpanProcessor({ exporter: trackedExporter,
    maxQueueSize: maxQueued, maxExportBatchSize: Math.min(64, maxQueued), scheduledDelayMillis: 5_000, exportTimeoutMillis: 3_000,
  })] : [];
  const inheritingProcessor: SpanProcessor = {
    onStart(span, parent) {
      const attributes = parent.getValue(invocationAttributes) as Attributes | undefined;
      if (attributes) span.setAttributes(safeTraceAttributes(attributes));
      for (const processor of processors) processor.onStart(span, parent);
    },
    onEnd(span) {
      if (trackedExporter && !options.processor && (span.spanContext().traceFlags & TraceFlags.SAMPLED)) {
        // Include in-flight exports in the cap. Account for loss before the SDK's
        // internal queue can silently drop a span.
        if (queuedSpans >= maxQueued) { queueDroppedSpans++; return; }
        if (queuedSpans === 0) drained = new Promise<void>(resolve => { resolveDrained = resolve; });
        queuedSpans++;
      }
      for (const processor of processors) processor.onEnd(span);
    },
    async forceFlush() { await Promise.all(processors.map(p => p.forceFlush())); },
    async shutdown() { await Promise.all(processors.map(p => p.shutdown())); },
  };
  const provider = new TracerProvider({ spanProcessors: [inheritingProcessor],
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 200, eventCountLimit: 0, linkCountLimit: 8 } });
  const tracer = provider.getTracer('papercusp.runtime', '1');
  const active = new Map<string, { span: Span; context: Context; startedAt: number; expectedModel: boolean;
    expectedModelRequestIds: string[]; modelExpectationsIncomplete: boolean }>();
  const now = options.now ?? Date.now;
  let skipped = 0;
  let expired = 0;
  const expire = () => {
    for (const [id, entry] of active) {
      if (now() - entry.startedAt < (options.maxDurationMs ?? 30 * 60_000)) continue;
      active.delete(id);
      entry.span.setAttribute('papercusp.outcome', 'expired');
      entry.span.setStatus({ code: SpanStatusCode.ERROR });
      entry.span.end();
      expired++;
    }
  };
  return {
    provider,
    register() {
      enableTracingContext();
      const registered = trace.setGlobalTracerProvider(provider);
      propagation.setGlobalPropagator(propagator);
      // Only instrument requests with a tracked parent. Inbound HTTP is handled
      // by the authorized dispatch boundary, including its hosted-customer fence.
      const instrumentations = [
        new UndiciInstrumentation({ requireParentforSpans: true }),
        new HttpInstrumentation({ disableIncomingRequestInstrumentation: true, requireParentforOutgoingSpans: true }),
      ];
      for (const instrumentation of instrumentations) instrumentation.setTracerProvider(provider);
      return { registered, disable: () => instrumentations.forEach(i => i.disable()) };
    },
    begin(callId: string, name: string, attributes: Attributes, carrier?: Record<string, string>, startTime?: number) {
      expire();
      if (active.has(callId) || active.size >= (options.maxActive ?? 1024)) { skipped++; return undefined; }
      const parent = carrier?.traceparent ? extractTraceContext(carrier) : context.active();
      const span = tracer.startSpan(name, { attributes: safeTraceAttributes({ 'service.name': options.service ?? 'papercusp-operator', ...attributes }), startTime }, parent);
      const executionContext = trace.setSpan(parent, span).setValue(invocationAttributes, safeTraceAttributes(attributes));
      active.set(callId, { span, context: executionContext, startedAt: now(), expectedModel: false,
        expectedModelRequestIds: [], modelExpectationsIncomplete: false });
      return span.spanContext();
    },
    async run<T>(callId: string, work: () => Promise<T>): Promise<T> {
      const entry = active.get(callId);
      return entry ? context.with(entry.context, work) : work();
    },
    attributes(callId: string, attributes: Attributes) {
      active.get(callId)?.span.setAttributes(safeTraceAttributes(attributes));
    },
    /** The maintained model transport calls this on a successful response.
     * It is local invocation evidence, independent of the export queue/project. */
    expectModel(requestId?: string | null) {
      const attributes = context.active().getValue(invocationAttributes) as Attributes | undefined;
      const callId = attributes?.['papercusp.call_id'];
      const entry = typeof callId === 'string' ? active.get(callId) : undefined;
      if (entry) {
        entry.expectedModel = true;
        if (!isModelRequestId(requestId) || entry.expectedModelRequestIds.length >= MAX_EXPECTED_MODEL_REQUESTS ||
          entry.expectedModelRequestIds.includes(requestId)) entry.modelExpectationsIncomplete = true;
        else entry.expectedModelRequestIds.push(requestId);
      }
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
      return correlation ? { ...correlation, expectedModel: entry.expectedModel,
        expectedModelRequestIds: entry.expectedModelRequestIds,
        modelExpectationsIncomplete: entry.modelExpectationsIncomplete } : undefined;
    },
    health: () => ({ active: active.size, skipped, expired, maxActive: options.maxActive ?? 1024,
      queuedSpans, queueDroppedSpans, maxQueued }),
    async flush() {
      await provider.forceFlush();
      // SDK forceFlush may finish while a previously triggered batch is still
      // exporting. Join that batch too, without extending the delivery budget.
      if (!queuedSpans) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([drained, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('trace_flush_timeout')), 3_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
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

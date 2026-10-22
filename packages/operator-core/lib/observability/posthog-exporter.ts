/** OTel SpanExporter using the existing PostHog capture endpoint, not a new service. */
import { createHash } from 'node:crypto';
import { context, SpanStatusCode } from '@opentelemetry/api';
import { suppressTracing, ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { safeTraceAttributes } from './tracing';

export interface TraceDeliveryConfig {
  allowed: boolean;
  host: string;
  projectKey: string;
  distinctId: string;
  /** Collection must have occurred after the latest opt-in; revocation drops queued spans. */
  consentSince?: number;
}
export interface TraceCaptureEvent { event: string; timestamp: string; uuid: string; properties: Record<string, unknown> }
const millis = (time: [number, number]) => time[0] * 1000 + time[1] / 1e6;

export function spanCaptureEvents(span: ReadableSpan, distinctId: string): TraceCaptureEvent[] {
  const attributes = safeTraceAttributes(span.attributes);
  const sc = span.spanContext();
  const parent = span.parentSpanContext?.spanId;
  const generation = attributes['gen_ai.operation.name'] === 'chat';
  const properties: Record<string, unknown> = {
    ...attributes, distinct_id: distinctId,
    $ai_trace_id: sc.traceId, $ai_span_id: sc.spanId,
    ...(parent ? { $ai_parent_id: parent } : {}),
    $ai_span_name: generation ? 'papercusp.model' : 'papercusp.tool',
    $ai_latency: Math.max(0, millis(span.duration) / 1000),
    $ai_is_error: span.status.code === SpanStatusCode.ERROR,
    $process_person_profile: false,
    ...(generation ? { $ai_provider: attributes['gen_ai.provider.name'], $ai_model: attributes['gen_ai.request.model'],
      $ai_input_tokens: attributes['gen_ai.usage.input_tokens'],
      $ai_output_tokens: attributes['gen_ai.usage.output_tokens'],
      $ai_cache_read_input_tokens: attributes['gen_ai.usage.cache_read.input_tokens'] } : {}),
  };
  const make = (event: string, props: Record<string, unknown>): TraceCaptureEvent => {
    // SDK/capture UUID, stable per span/event; retrying does not invent a new event identity.
    const hex = createHash('sha256').update(`${sc.traceId}:${sc.spanId}:${event}`).digest('hex');
    return { event, timestamp: new Date(millis(span.startTime)).toISOString(),
      uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
      properties: props };
  };
  const events = [make(generation ? '$ai_generation' : parent ? '$ai_span' : '$ai_trace', properties)];
  if (span.status.code === SpanStatusCode.ERROR) {
    const code = attributes['papercusp.error_code'];
    const errorCode = typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : 'execution_error';
    events.push(make('$exception', { ...properties,
      $exception_list: [{ type: 'PapercuspExecutionError', value: errorCode }],
      $exception_fingerprint: ['papercusp', String(attributes['papercusp.tool'] ?? 'model'), errorCode] }));
  }
  return events;
}

export class PosthogSpanExporter implements SpanExporter {
  private closed = false;
  private readonly counters = { exportedSpans: 0, failedSpans: 0, consentDroppedSpans: 0, batches: 0 };
  constructor(private readonly readConfig: () => Promise<TraceDeliveryConfig>, private readonly send: typeof fetch = fetch) {}
  health() { return { ...this.counters, closed: this.closed }; }
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    void this.deliver(spans).then(() => callback({ code: ExportResultCode.SUCCESS }), () => {
      this.counters.failedSpans += spans.length;
      // No raw endpoint error/response body: those can contain secrets or user content.
      callback({ code: ExportResultCode.FAILED, error: new Error('posthog_trace_export_failed') });
    });
  }
  private async deliver(spans: ReadableSpan[]) {
    if (this.closed) throw new Error('exporter_closed');
    const config = await this.readConfig();
    const allowed = config.allowed ? spans.filter(span => !config.consentSince || millis(span.startTime) >= config.consentSince) : [];
    this.counters.consentDroppedSpans += spans.length - allowed.length;
    if (!allowed.length) return;
    const url = new URL('/batch/', config.host);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('insecure_export_host');
    if (url.username || url.password) throw new Error('invalid_export_host');
    // The exporter itself must never create another observation/export cycle.
    const response = await context.with(suppressTracing(context.active()), () => this.send(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: config.projectKey, batch: allowed.flatMap(span => spanCaptureEvents(span, config.distinctId)) }),
      signal: AbortSignal.timeout(2_000) }));
    if (!response.ok) throw new Error('capture_rejected');
    this.counters.exportedSpans += allowed.length;
    this.counters.batches++;
  }
  async shutdown() { this.closed = true; }
}

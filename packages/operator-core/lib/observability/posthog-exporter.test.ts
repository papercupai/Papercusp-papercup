import { describe, expect, it, vi } from 'vitest';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { PosthogSpanExporter, spanCaptureEvents, type TraceDeliveryConfig } from './posthog-exporter';

function span(error = false): ReadableSpan {
  const out = new InMemorySpanExporter();
  const p = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(out)] });
  const s = p.getTracer('test').startSpan('arbitrary secret span name', { attributes: {
    'papercusp.tool': 'test:tool', 'papercusp.call_id': 'call-1', 'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'test', 'gen_ai.request.model': 'model-test', 'gen_ai.usage.input_tokens': 10,
    prompt: 'SECRET', 'gen_ai.prompt': 'SECRET', authorization: 'SECRET' } });
  if (error) { s.setStatus({ code: SpanStatusCode.ERROR, message: 'SECRET' }); s.recordException(new Error('SECRET')); }
  s.end();
  return out.getFinishedSpans()[0]!;
}
const config: TraceDeliveryConfig = { allowed: true, host: 'http://127.0.0.1:1234', projectKey: 'test-key', distinctId: 'test-install' };
const exportSpans = (exporter: PosthogSpanExporter, spans: ReadableSpan[]) => new Promise<{ code: number }>(resolve => exporter.export(spans, resolve));

describe('safe PostHog OpenTelemetry delivery', () => {
  it('maps model/error observations with stable trace references without exporting content', () => {
    const s = span(true);
    const events = spanCaptureEvents(s, 'install');
    expect(events.map(e => e.event)).toEqual(['$ai_generation', '$exception']);
    expect(events[0]!.properties).toMatchObject({ $ai_trace_id: s.spanContext().traceId, $ai_span_id: s.spanContext().spanId, $ai_input_tokens: 10, 'papercusp.call_id': 'call-1' });
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(events[0]!.uuid).toBe(spanCaptureEvents(s, 'install')[0]!.uuid);
  });
  it('rechecks consent and excludes spans captured before the current opt-in', async () => {
    let allowed = false;
    const send = vi.fn<typeof fetch>();
    const exporter = new PosthogSpanExporter(async () => ({ ...config, allowed }), send);
    const s = span();
    expect((await exportSpans(exporter, [s])).code).toBe(0);
    allowed = true;
    const revoked = new PosthogSpanExporter(async () => ({ ...config, consentSince: Date.now() + 1000 }), send);
    await exportSpans(revoked, [s]);
    expect(send).not.toHaveBeenCalled();
    expect(exporter.health().consentDroppedSpans).toBe(1);
    expect(revoked.health().consentDroppedSpans).toBe(1);
  });
  it('reports rejected and failed delivery while keeping export asynchronous', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    const exporter = new PosthogSpanExporter(async () => config, send);
    expect((await exportSpans(exporter, [span()])).code).toBe(1);
    expect(exporter.health().failedSpans).toBe(1);
    send.mockRejectedValueOnce(new Error('SECRET'));
    expect((await exportSpans(exporter, [span()])).code).toBe(1);
    send.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect((await exportSpans(exporter, [span()])).code).toBe(0);
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: 'error' });
    expect(exporter.health().exportedSpans).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { SpanStatusCode } from '@opentelemetry/api';
import { PosthogSpanExporter, spanCaptureEvents, type TraceDeliveryConfig } from './posthog-exporter';

function span(error = false, model = true): ReadableSpan {
  const out = new InMemorySpanExporter();
  const p = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: out })] });
  const s = p.getTracer('test').startSpan('arbitrary secret span name', { attributes: {
    'papercusp.tool': 'test:tool', 'papercusp.call_id': 'call-1', ...(model ? { 'gen_ai.operation.name': 'chat' } : {}),
    'gen_ai.provider.name': 'test', 'gen_ai.request.model': 'model-test', 'gen_ai.usage.input_tokens': 10,
    prompt: 'SECRET', 'gen_ai.prompt': 'SECRET', authorization: 'SECRET',
    response: 'SECRET response', 'gen_ai.completion': 'SECRET completion',
    'tool.arguments': JSON.stringify({ nested: { password: 'SECRET password', token: 'SECRET token', customer: 'SECRET customer' } }),
    'http.request.header.authorization': 'SECRET credential', baggage: 'SECRET baggage' } });
  if (error) { s.setStatus({ code: SpanStatusCode.ERROR, message: 'SECRET' }); s.recordException(new Error('SECRET')); }
  s.end();
  return out.getFinishedSpans()[0]!;
}
const config: TraceDeliveryConfig = { allowed: true, host: 'http://127.0.0.1:1234', projectKey: 'test-key', distinctId: 'test-install' };
const exportSpans = (exporter: PosthogSpanExporter, spans: ReadableSpan[]) => new Promise<{ code: number }>(resolve => exporter.export(spans, resolve));

describe('safe PostHog OpenTelemetry delivery', () => {
  it('excludes observations in the grant millisecond and admits the following millisecond', async () => {
    const consentSince = 1_700_000_000_000;
    const timed = (milliseconds: number) => Object.create(span(), { startTime: { value: [Math.floor(milliseconds / 1000), Math.round(milliseconds % 1000 * 1e6)] } }) as ReadableSpan;
    const beforeOrDuringGrant = timed(consentSince + 0.75);
    const afterGrant = timed(consentSince + 1.25);
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new PosthogSpanExporter(async () => ({ ...config, consentSince }), send);
    await exportSpans(exporter, [beforeOrDuringGrant, afterGrant]);
    const wire = JSON.parse(String(send.mock.calls[0]![1]!.body));
    expect(wire.batch.map((e: { properties: { $ai_span_id: string } }) => e.properties.$ai_span_id)).toEqual([afterGrant.spanContext().spanId]);
    expect(exporter.health()).toMatchObject({ consentDroppedSpans: 1, exportedSpans: 1 });
  });
  it('checks the grant at the submission barrier and excludes old observations after regrant', async () => {
    let current = { ...config, allowed: false, consentSince: 0 };
    let requested!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { requested = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new PosthogSpanExporter(async () => { requested(); await barrier; return current; }, send);
    const beforeGrant = span();
    const queued = exportSpans(exporter, [beforeGrant]);
    await ready;
    current = { ...current, allowed: true, consentSince: Date.now() + 1 };
    release();
    await queued;
    expect(send).not.toHaveBeenCalled();
    current = { ...current, allowed: false };
    const revoked = span();
    await exportSpans(exporter, [revoked]);
    expect(send).not.toHaveBeenCalled();
    current = { ...current, allowed: true, consentSince: Date.now() + 1 };
    // Wait for collection to be observably newer than the grant, rather than assuming clock precision.
    await vi.waitUntil(() => Date.now() > current.consentSince, { interval: 1 });
    const fresh = span();
    await exportSpans(exporter, [beforeGrant, revoked, fresh]);
    expect(send).toHaveBeenCalledOnce();
    const wire = JSON.parse(String(send.mock.calls[0]![1]!.body));
    expect(wire.batch.map((e: { properties: { $ai_span_id: string } }) => e.properties.$ai_span_id)).toEqual([fresh.spanContext().spanId]);
    expect(JSON.stringify(wire)).not.toContain('SECRET');
    expect(exporter.health()).toMatchObject({ exportedSpans: 1, consentDroppedSpans: 4 });
  });
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
  it('sends model and tool errors to the configured project and capture destination', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new PosthogSpanExporter(async () => ({ ...config, host: 'https://capture.example.test/a/path' }), send);
    const model = span();
    const toolError = span(true, false);
    expect((await exportSpans(exporter, [model, toolError])).code).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    const [destination, request] = send.mock.calls[0]!;
    expect(String(destination)).toBe('https://capture.example.test/batch/');
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(String(request!.body));
    expect(body.api_key).toBe(config.projectKey);
    expect(body.batch.map((event: { event: string }) => event.event)).toEqual(['$ai_generation', '$ai_trace', '$exception']);
    expect(body.batch[0].properties).toMatchObject({ distinct_id: config.distinctId, $ai_trace_id: model.spanContext().traceId });
    expect(body.batch[2].properties).toMatchObject({ $ai_trace_id: toolError.spanContext().traceId,
      $ai_span_id: toolError.spanContext().spanId, 'papercusp.call_id': 'call-1', $ai_is_error: true });
    expect(JSON.stringify(body)).not.toContain('SECRET');
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

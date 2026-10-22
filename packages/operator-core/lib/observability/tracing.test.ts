import { beforeAll, describe, expect, it } from 'vitest';
import { context, trace, propagation } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace';
import { createTracing, enableTracingContext, extractTraceContext, injectTraceContext, safeTraceAttributes } from './tracing';

beforeAll(enableTracingContext);
describe('runtime OpenTelemetry correlation', () => {
  it('preserves inbound W3C parentage across concurrent nested tool work', async () => {
    const exporter = new InMemorySpanExporter();
    const runtime = createTracing({ processor: new SimpleSpanProcessor({ exporter }) });
    const parent = '00-12345678901234567890123456789012-1234567890123456-01';
    runtime.begin('a', 'tool.a', { 'papercusp.tool': 'test:a' }, { traceparent: parent });
    runtime.begin('b', 'tool.b', { 'papercusp.tool': 'test:b' });
    await Promise.all(['a', 'b'].map(id => runtime.run(id, async () => {
      await Promise.resolve();
      runtime.begin(id + '.child', 'child', {});
      runtime.finish(id + '.child', 'ok');
    })));
    const a = runtime.finish('a', 'ok')!;
    const b = runtime.finish('b', 'error', 'handler_error')!;
    await runtime.flush();
    const spans = exporter.getFinishedSpans();
    expect(a.traceId).toBe('12345678901234567890123456789012');
    expect(b.traceId).not.toBe(a.traceId);
    expect(spans.find(s => s.name === 'tool.a')?.parentSpanContext?.spanId).toBe('1234567890123456');
    expect(spans.filter(s => s.name === 'child').map(s => s.parentSpanContext?.spanId).sort()).toEqual([a.spanId, b.spanId].sort());
    expect(runtime.health().active).toBe(0);
    await runtime.shutdown();
  });
  it('does not turn the legacy UUID into a trace and never propagates baggage', () => {
    const extracted = extractTraceContext({ traceparent: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4', baggage: 'secret=payload' });
    expect(context.with(extracted, () => injectTraceContext())).toEqual({});
    const valid = '00-12345678901234567890123456789012-1234567890123456-01';
    expect(injectTraceContext(extractTraceContext({ traceparent: valid, baggage: 'secret=payload' }))).toEqual({ traceparent: valid });
  });
  it('bounds in-flight work and exports only scalar allowlisted attributes', async () => {
    const runtime = createTracing({ maxActive: 1 });
    expect(runtime.begin('a', 'tool', {})).toBeDefined();
    expect(runtime.begin('b', 'tool', {})).toBeUndefined();
    expect(runtime.health()).toMatchObject({ active: 1, skipped: 1 });
    expect(safeTraceAttributes({ prompt: 'private', password: 'private', 'papercusp.tool': 'test:ok', 'gen_ai.usage.input_tokens': NaN })).toEqual({ 'papercusp.tool': 'test:ok' });
    await runtime.shutdown();
    expect(runtime.health().active).toBe(0);
  });
  it('reclaims abandoned spans before they permanently fill the bounded active set', async () => {
    let now = 0;
    const runtime = createTracing({ maxActive: 1, maxDurationMs: 10, now: () => now });
    runtime.begin('orphan', 'tool', {});
    now = 11;
    expect(runtime.begin('next', 'tool', {})).toBeDefined();
    expect(runtime.health()).toMatchObject({ active: 1, expired: 1, skipped: 0 });
    await runtime.shutdown();
  });
  it('registers the standard tracer and propagates an asynchronous child invocation', async () => {
    const exporter = new InMemorySpanExporter();
    const runtime = createTracing({ processor: new SimpleSpanProcessor({ exporter }) });
    const registration = runtime.register();
    try {
      expect(registration.registered).toBe(true);
      const parent = runtime.begin('request', 'tool', { 'papercusp.call_id': 'request' })!;
      await runtime.run('request', async () => {
        await Promise.resolve();
        const child = trace.getTracer('standard-application-child').startSpan('child');
        child.end();
      });
      runtime.finish('request', 'ok');
      expect(exporter.getFinishedSpans().find(s => s.name === 'child')).toMatchObject({
        parentSpanContext: { spanId: parent.spanId }, attributes: { 'papercusp.call_id': 'request' },
      });
    } finally {
      registration.disable();
      trace.disable();
      propagation.disable();
      await runtime.shutdown();
    }
  });
  it('bounds a stalled export queue and makes dropped observations explicit', async () => {
    const exporter = new InMemorySpanExporter();
    let stalled = true;
    const pending: Array<() => void> = [];
    const delayed: SpanExporter = {
      export(spans, callback) {
        const deliver = () => exporter.export(spans, callback);
        if (stalled) pending.push(deliver); else deliver();
      },
      shutdown: () => exporter.shutdown(),
    };
    const runtime = createTracing({ exporter: delayed, maxQueued: 2 });
    for (let i = 0; i < 10; i++) { runtime.begin(String(i), 'tool', {}); runtime.finish(String(i), 'ok'); }
    expect(runtime.health()).toMatchObject({ queuedSpans: 2, queueDroppedSpans: 8 });
    stalled = false;
    for (const deliver of pending) deliver();
    await runtime.flush();
    expect(runtime.health().queuedSpans).toBe(0);
    expect(exporter.getFinishedSpans()).toHaveLength(2);
    await runtime.shutdown();
  });
});

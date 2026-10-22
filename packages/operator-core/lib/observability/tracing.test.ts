import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createTracing, enableTracingContext, extractTraceContext, injectTraceContext, safeTraceAttributes } from './tracing';

beforeAll(enableTracingContext);
afterEach(() => {});
describe('runtime OpenTelemetry correlation', () => {
  it('preserves inbound W3C parentage across concurrent nested tool work', async () => {
    const exporter = new InMemorySpanExporter();
    const runtime = createTracing({ processor: new SimpleSpanProcessor(exporter) });
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
});

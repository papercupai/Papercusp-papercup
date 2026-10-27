import { beforeAll, describe, expect, it } from 'vitest';
import { context, trace, propagation } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace';
import { createTracing, enableTracingContext, extractTraceContext, injectTraceContext, safeTraceAttributes, MAX_EXPECTED_MODEL_REQUESTS } from './tracing';

beforeAll(enableTracingContext);
describe('runtime OpenTelemetry correlation', () => {
  it('keeps the default active and queued observation limits at 1024 and 2048', async () => {
    const runtime = createTracing();
    try {
      expect(runtime.health()).toMatchObject({ maxActive: 1024, maxQueued: 2048 });
    } finally { await runtime.shutdown(); }
  });

  it('records successful model expectations independently of delivery without leaking across concurrent invocations', async () => {
    const runtime = createTracing();
    try {
      runtime.begin('model', 'papercusp.tool', { 'papercusp.call_id': 'model' });
      runtime.begin('ordinary', 'papercusp.tool', { 'papercusp.call_id': 'ordinary' });
      await Promise.all([
        runtime.run('model', async () => {
          await Promise.resolve();
          runtime.expectModel('11111111-1111-4111-8111-111111111111:1');
          runtime.expectModel('11111111-1111-4111-8111-111111111111:2');
        }),
        runtime.run('ordinary', async () => { await Promise.resolve(); }),
      ]);
      expect(runtime.finish('model', 'error')).toMatchObject({ expectedModel: true, modelExpectationsIncomplete: false,
        expectedModelRequestIds: ['11111111-1111-4111-8111-111111111111:1', '11111111-1111-4111-8111-111111111111:2'] });
      expect(runtime.finish('ordinary', 'ok')).toMatchObject({ expectedModel: false, expectedModelRequestIds: [] });
    } finally { await runtime.shutdown(); }
  });
  it.each(['missing', 'duplicate', 'overflow'])('marks %s model identities incomplete without replacing prior expectations', async fault => {
    const runtime = createTracing();
    try {
      runtime.begin('tool', 'papercusp.tool', { 'papercusp.call_id': 'tool' });
      await runtime.run('tool', async () => {
        const id = '11111111-1111-4111-8111-111111111111:1';
        runtime.expectModel(id);
        if (fault === 'overflow') for (let i = 2; i <= MAX_EXPECTED_MODEL_REQUESTS + 1; i++) {
          runtime.expectModel('11111111-1111-4111-8111-111111111111:' + i);
        }
        else runtime.expectModel(fault === 'duplicate' ? id : null);
      });
      const result = runtime.finish('tool', 'ok')!;
      expect(result.modelExpectationsIncomplete).toBe(true);
      expect(result.expectedModelRequestIds[0]).toBe('11111111-1111-4111-8111-111111111111:1');
      expect(result.expectedModelRequestIds).toHaveLength(fault === 'overflow' ? MAX_EXPECTED_MODEL_REQUESTS : 1);
    } finally { await runtime.shutdown(); }
  });
  it.each([undefined, 'malformed', '00-00000000000000000000000000000000-1234567890123456-01'])('creates a valid root for absent or invalid inbound parent %s', async parent => {
    const exporter = new InMemorySpanExporter();
    const runtime = createTracing({ processor: new SimpleSpanProcessor({ exporter }) });
    try {
      const root = runtime.begin('root', 'root', { 'papercusp.call_id': 'root' }, parent ? { traceparent: parent } : {})!;
      runtime.finish('root', 'ok');
      await runtime.flush();
      expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(root.traceId).not.toBe('00000000000000000000000000000000');
      expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(exporter.getFinishedSpans()[0]).toMatchObject({ parentSpanContext: undefined, attributes: { 'papercusp.call_id': 'root' } });
    } finally { await runtime.shutdown(); }
  });
  it('keeps standard tracer children isolated across barrier-interleaved inbound parents', async () => {
    const exporter = new InMemorySpanExporter();
    const runtime = createTracing({ processor: new SimpleSpanProcessor({ exporter }) });
    const registration = runtime.register();
    const requests = [
      { id: 'left', traceId: '11111111111111111111111111111111', parent: '1111111111111111' },
      { id: 'right', traceId: '22222222222222222222222222222222', parent: '2222222222222222' },
    ];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    try {
      expect(registration.registered).toBe(true);
      const roots = requests.map(r => runtime.begin(r.id, r.id, { 'papercusp.call_id': r.id }, { traceparent: `00-${r.traceId}-${r.parent}-01` })!);
      await Promise.all(requests.map(r => runtime.run(r.id, async () => {
        if (++entered === requests.length) release();
        await barrier;
        await Promise.resolve();
        trace.getTracer('application').startSpan(r.id + '.child').end();
      })));
      requests.forEach(r => runtime.finish(r.id, 'ok'));
      await runtime.flush();
      const spans = exporter.getFinishedSpans();
      requests.forEach((r, i) => {
        const root = spans.find(s => s.name === r.id)!;
        const child = spans.find(s => s.name === r.id + '.child')!;
        expect(root.spanContext().traceId).toBe(r.traceId);
        expect(root.parentSpanContext?.spanId).toBe(r.parent);
        expect(child.spanContext().traceId).toBe(r.traceId);
        expect(child.parentSpanContext?.spanId).toBe(roots[i]!.spanId);
        expect(child.attributes['papercusp.call_id']).toBe(r.id);
      });
    } finally { registration.disable(); trace.disable(); propagation.disable(); await runtime.shutdown(); }
  });
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

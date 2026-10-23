/** Production dispatch hooks, invocation sink, W3C propagation and capture transport. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { trace, propagation } from '@opentelemetry/api';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const fixture = vi.hoisted(() => ({ host: '', consent: true, since: 0, db: null as OrgTestDb | null }));
vi.mock('../operator-state-pg', async original => ({
  ...(await original<object>()),
  readOperatorState: async () => ({ telemetry_enabled: fixture.consent, telemetry_consent_since: fixture.since }),
  updateOperatorState: async (_key: string, _fallback: unknown, mutate: (state: Record<string, unknown>) => Record<string, unknown>) => {
    const next = mutate({ step_status: {}, telemetry_enabled: fixture.consent, telemetry_consent_since: fixture.since });
    fixture.consent = Boolean(next.telemetry_enabled);
    fixture.since = Number(next.telemetry_consent_since ?? 0);
    return next;
  },
}));
vi.mock('../setup-wizard-install-id', async original => ({ ...(await original<object>()), ensureInstallId: async () => 'synthetic-install' }));
vi.mock('../posthog-config', async original => ({
  ...(await original<object>()),
  getPosthogConfigWithSource: () => ({ config: { host: fixture.host, projectKey: 'synthetic-key' }, source: 'test' }),
}));
vi.mock('@papercusp/flags/server', async original => ({ ...(await original<object>()), getFlag: vi.fn(async () => false) }));
vi.mock('@papercusp/testing-shell/llm', async original => ({ ...(await original<object>()), getOverride: vi.fn(() => undefined) }));
vi.mock('../decision-ledger/emit', async original => ({ ...(await original<object>()), recordDecisionLedger: vi.fn() }));
vi.mock('../agent-tools/coordination/dispatch-heartbeat', async original => ({ ...(await original<object>()), maybeBeatPresenceOnDispatch: vi.fn() }));
vi.mock('../agent-tools/coordination/identity', async original => ({
  ...(await original<object>()), resolveAgentIdentity: () => ({ ownerId: 'su-observability-fixture', ownerLabel: 'synthetic' }),
}));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: fixture.db!.adminSql }),
}));

import { PROJECTED_DEPS, flushPendingTelemetry } from '../projected-tool-deps';
import { beginGatewayTrace, finishGatewayTrace, flushRuntimeObservability,
  beginToolTrace, finishToolTrace, initializeRuntimeObservability, runtimeObservabilityHealth, shutdownRuntimeObservability } from './runtime';
import { mergeSetupWizardState } from '../endpoint-route/routes/desktop/setup-wizard-state';
import type { GatewayRequestTimeline } from '../inference-gateway/request-stage-telemetry';

describe('production observability composition', () => {
  let server: http.Server;
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const outboundParents: string[] = [];
  const modelParents = new Map<string, string>();
  let modelBarrier: (() => Promise<void>) | undefined;
  let captureMode: 'ok' | 'reject' | 'stall' = 'ok';
  let onCapture: (() => void) | undefined;
  const captureCloseDurations: number[] = [];
  const stalledResponses = new Set<http.ServerResponse>();
  const ctx = { workspaceId: 'synthetic-workspace', harnessSlug: 'papercusp', role: 'worker',
    spawnId: 'synthetic-session', log: vi.fn(), requestOrigin: { headers: {
      traceparent: '00-12345678901234567890123456789012-1234567890123456-01',
      baggage: 'private=SECRET',
    } } };

  beforeAll(async () => {
    fixture.db = await createOrgTestDb();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAPERCUSP_INTERNAL_BUILD', 'false');
    vi.stubEnv('PAPERCUSP_POSTHOG_HOST', '');
    vi.stubEnv('PAPERCUSP_POSTHOG_KEY', '');
    server = http.createServer(async (req, res) => {
      const modelUrl = new URL(req.url!, 'http://localhost');
      if (modelUrl.pathname === '/model') {
        const modelRequestId = modelUrl.searchParams.get('request') ?? 'synthetic-model';
        outboundParents.push(String(req.headers.traceparent));
        modelParents.set(modelRequestId, String(req.headers.traceparent));
        expect(req.headers.baggage).toBeUndefined();
        beginGatewayTrace(modelRequestId, 'synthetic-provider', { traceparent: String(req.headers.traceparent) });
        await modelBarrier?.();
        finishGatewayTrace(modelRequestId, { model: 'synthetic-model', requestId: 1, attempts: 1,
          cache: { inputTokens: 10, cacheReadTokens: 2 }, durationsMs: { queueWait: 0, upstreamTtfb: 1 },
          outcome: 'ok' } as GatewayRequestTimeline);
        res.end('model-ok');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captured.push(...JSON.parse(Buffer.concat(chunks).toString()).batch);
      onCapture?.();
      if (captureMode === 'stall') {
        const started = performance.now();
        stalledResponses.add(res);
        res.once('close', () => { stalledResponses.delete(res); captureCloseDurations.push(performance.now() - started); });
        return;
      }
      if (captureMode === 'reject') res.statusCode = 503;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    fixture.host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    initializeRuntimeObservability();
  }, 120_000);
  afterAll(async () => {
    await shutdownRuntimeObservability();
    trace.disable(); propagation.disable();
    vi.unstubAllEnvs();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await fixture.db?.cleanup();
  });

  async function invoke(callId: string, fail: boolean | Error = false, options: {
    requestContext?: typeof ctx; enter?: () => Promise<void>; modelRequestId?: string; windowKey?: string;
  } = {}) {
    const requestContext = options.requestContext ?? ctx;
    PROJECTED_DEPS.onDispatchStart!({ ctx: requestContext, toolName: 'synthetic:observe', pluginName: 'synthetic', callId } as never);
    const handler = vi.fn(async () => {
      await options.enter?.();
      await Promise.resolve();
      const child = trace.getTracer('application').startSpan('SECRET child name', { attributes: { prompt: 'SECRET' } });
      child.end();
      const query = options.modelRequestId ? `?request=${encodeURIComponent(options.modelRequestId)}` : '';
      const response = await fetch(`${fixture.host}/model${query}`, { headers: { authorization: 'SECRET' } });
      if (fail) throw fail instanceof Error ? fail : new Error('SECRET');
      return response.text();
    });
    let result: unknown;
    const handlerStarted = performance.now();
    try {
      result = await PROJECTED_DEPS.aroundInvoke!({ tool: { pluginName: 'synthetic' }, toolName: 'synthetic:observe',
        input: { prompt: 'SECRET' }, ctx: requestContext, callId, invoke: handler } as never);
    } catch (error) { result = error; }
    expect(performance.now() - handlerStarted).toBeLessThan(2_000);
    await PROJECTED_DEPS.recordInvocation!({ ctx: requestContext, callId, toolName: 'synthetic:observe', pluginName: 'synthetic',
      windowKey: options.windowKey ?? 'synthetic-window', status: fail ? 'error' : 'ok', durationMs: 1, args: { prompt: 'SECRET' },
      ...(fail ? { errorCode: 'handler_error' } : {}) } as never);
    await flushPendingTelemetry();
    expect(handler).toHaveBeenCalledOnce();
    return result;
  }

  it('connects real hooks, standard child spans, outgoing HTTP, model completion and invocation metadata', async () => {
    expect(await invoke('synthetic-success')).toBe('model-ok');
    await flushRuntimeObservability();
    expect(runtimeObservabilityHealth()).toMatchObject({ globalProviderRegistered: true, tracing: { active: 0 } });
    const tool = captured.find(e => e.properties['papercusp.call_id'] === 'synthetic-success' && e.properties.$ai_span_name === 'papercusp.tool');
    const model = captured.find(e => e.event === '$ai_generation');
    expect(tool).toBeDefined(); expect(model).toBeDefined();
    expect(model!.properties.$ai_trace_id).toBe(tool!.properties.$ai_trace_id);
    expect(outboundParents[0]).toMatch(/^00-12345678901234567890123456789012-[0-9a-f]{16}-01$/);
    expect(model!.properties.$ai_parent_id).toBe(outboundParents[0]!.split('-')[2]);
    expect(model!.properties['papercusp.request_id']).toBe('synthetic-model');
    const rows = await fixture.db!.adminSql`
      SELECT metadata_json FROM harness_shared.tool_invocations
      WHERE workspace_id = 'synthetic-workspace' AND tool_name = 'synthetic:observe'
      ORDER BY id DESC LIMIT 1`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata_json).toMatchObject({ otel: { traceId: tool!.properties.$ai_trace_id } });
    expect(JSON.stringify(captured)).not.toContain('SECRET');
    const before = captured.length;
    await flushRuntimeObservability();
    expect(captured).toHaveLength(before); // capture requests do not recursively export
  });
  it('keeps two barrier-interleaved production tool, HTTP, model and PostgreSQL journeys isolated', async () => {
    const journeys = [
      { callId: 'concurrent-left', traceId: '11111111111111111111111111111111', parentId: '1111111111111111' },
      { callId: 'concurrent-right', traceId: '22222222222222222222222222222222', parentId: '2222222222222222' },
    ];
    const barrier = () => {
      let entered = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      return async () => { if (++entered === journeys.length) release(); await ready; };
    };
    const enter = barrier();
    modelBarrier = barrier();
    const before = captured.length;
    try {
      const results = await Promise.all(journeys.map(journey => invoke(journey.callId, false, {
        requestContext: { ...ctx, requestOrigin: { headers: {
          traceparent: `00-${journey.traceId}-${journey.parentId}-01`, baggage: 'private=SECRET',
        } } },
        enter, modelRequestId: journey.callId + '-model', windowKey: journey.callId,
      })));
      expect(results).toEqual(['model-ok', 'model-ok']);
      await flushRuntimeObservability();
      const events = captured.slice(before);
      const rows = await fixture.db!.adminSql`
        SELECT window_key, metadata_json FROM harness_shared.tool_invocations
        WHERE workspace_id = 'synthetic-workspace' AND tool_name = 'synthetic:observe'
          AND window_key IN ('concurrent-left', 'concurrent-right')`;
      expect(rows).toHaveLength(2);
      const toolSpanIds: unknown[] = [];
      for (const journey of journeys) {
        const own = events.filter(e => e.properties.$ai_trace_id === journey.traceId);
        const tool = own.filter(e => e.properties['papercusp.call_id'] === journey.callId &&
          e.properties.$ai_parent_id === journey.parentId);
        const model = own.filter(e => e.event === '$ai_generation' &&
          e.properties['papercusp.request_id'] === journey.callId + '-model');
        expect(tool).toHaveLength(1);
        expect(model).toHaveLength(1);
        const toolSpanId = tool[0]!.properties.$ai_span_id;
        toolSpanIds.push(toolSpanId);
        const outbound = modelParents.get(journey.callId + '-model')!;
        expect(outbound).toMatch(new RegExp(`^00-${journey.traceId}-[0-9a-f]{16}-01$`));
        const httpSpanId = outbound.split('-')[2];
        expect(model[0]!.properties.$ai_parent_id).toBe(httpSpanId);
        const httpSpan = own.filter(e => e.properties.$ai_span_id === httpSpanId);
        expect(httpSpan).toHaveLength(1);
        expect(httpSpan[0]!.properties).toMatchObject({
          'papercusp.call_id': journey.callId, $ai_parent_id: toolSpanId,
        });
        expect(own.some(e => e.properties['papercusp.call_id'] &&
          e.properties['papercusp.call_id'] !== journey.callId)).toBe(false);
        const row = rows.filter(row => row.window_key === journey.callId);
        expect(row).toHaveLength(1);
        expect(row[0]!.metadata_json).toMatchObject({ otel: { traceId: journey.traceId, spanId: toolSpanId } });
      }
      expect(new Set(toolSpanIds).size).toBe(2);
      expect(events.filter(e => e.event === '$ai_generation')).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain('SECRET');
      expect(runtimeObservabilityHealth().tracing).toMatchObject({ active: 0, queuedSpans: 0 });
    } finally { modelBarrier = undefined; }
  });
  it('keeps handler errors intact, exports a sanitized exception, and drops queued spans after revocation', async () => {
    expect(await invoke('synthetic-error', true)).toMatchObject({ message: 'SECRET' });
    await flushRuntimeObservability();
    expect(captured.some(e => e.event === '$exception' && e.properties['papercusp.call_id'] === 'synthetic-error')).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('SECRET');
    const before = captured.length;
    await invoke('synthetic-revoked');
    fixture.consent = false;
    await flushRuntimeObservability();
    expect(captured).toHaveLength(before);
    expect(runtimeObservabilityHealth().posthog!.consentDroppedSpans).toBeGreaterThan(0);
  });
  it.each(['reject', 'stall'] as const)('preserves handler outcomes and drains bounded export state when capture will %s', async mode => {
    fixture.consent = true;
    captureMode = mode;
    const error = new Error('SECRET original handler failure');
    const failedBefore = runtimeObservabilityHealth().posthog!.failedSpans;
    const closeCount = captureCloseDurations.length;
    const captureStarted = new Promise<void>(resolve => { onCapture = resolve; });
    try {
      // The application finishes before waiting on capture; invoke also asserts one handler call.
      expect(await invoke(`synthetic-${mode}`, mode === 'stall' ? error : false)).toBe(mode === 'stall' ? error : 'model-ok');
      // Flush may report exporter failure; attaching the handler immediately also prevents
      // a fast rejection from becoming an unhandled promise while awaiting the receiver.
      const flushed = flushRuntimeObservability().then(() => [], failure => Array.isArray(failure) ? failure : [failure]);
      await captureStarted;
      // A scheduled batch may have reported its failure before this explicit flush.
      for (const failure of await flushed) expect(failure).toMatchObject({ message: 'posthog_trace_export_failed' });
      expect(runtimeObservabilityHealth().posthog!.failedSpans).toBeGreaterThan(failedBefore);
      expect(runtimeObservabilityHealth().tracing).toMatchObject({ active: 0, queuedSpans: 0 });
      if (mode === 'stall') {
        await vi.waitUntil(() => captureCloseDurations.length > closeCount);
        expect(captureCloseDurations.slice(closeCount).every(ms => ms < 3_000)).toBe(true);
      }
      expect(JSON.stringify(captured)).not.toContain('SECRET');
      captureMode = 'ok';
      onCapture = undefined;
      const exportedBefore = runtimeObservabilityHealth().posthog!.exportedSpans;
      expect(await invoke(`synthetic-${mode}-recovered`)).toBe('model-ok');
      await flushRuntimeObservability();
      expect(runtimeObservabilityHealth().posthog!.exportedSpans).toBeGreaterThan(exportedBefore);
    } finally {
      captureMode = 'ok';
      onCapture = undefined;
      for (const response of stalledResponses) response.destroy();
      stalledResponses.clear();
    }
  }, 20_000);
  it('uses the real grant producer to exclude pregrant and revoked work while delivering fresh regrant work', async () => {
    await mergeSetupWizardState({ telemetry_enabled: false });
    const begin = (callId: string) => beginToolTrace({ ctx, callId, toolName: 'synthetic:consent', pluginName: 'synthetic' } as never);
    const finish = (callId: string) => finishToolTrace({ ctx, callId, status: 'ok' } as never);
    begin('consent-pregrant');
    await mergeSetupWizardState({ telemetry_enabled: true });
    const firstGrant = fixture.since;
    finish('consent-pregrant');
    await flushRuntimeObservability();
    expect(captured.some(e => e.properties['papercusp.call_id'] === 'consent-pregrant')).toBe(false);
    begin('consent-revoked');
    await mergeSetupWizardState({ telemetry_enabled: false });
    finish('consent-revoked');
    await flushRuntimeObservability();
    expect(captured.some(e => e.properties['papercusp.call_id'] === 'consent-revoked')).toBe(false);
    await vi.waitUntil(() => Date.now() > firstGrant, { interval: 1 });
    await mergeSetupWizardState({ telemetry_enabled: true });
    expect(fixture.since).toBeGreaterThan(firstGrant);
    await vi.waitUntil(() => Date.now() > fixture.since, { interval: 1 });
    begin('consent-fresh'); finish('consent-fresh');
    await flushRuntimeObservability();
    expect(captured.some(e => e.properties['papercusp.call_id'] === 'consent-fresh')).toBe(true);
    expect(captured.some(e => ['consent-pregrant', 'consent-revoked'].includes(String(e.properties['papercusp.call_id'])))).toBe(false);
  });
  it('executes a handler exactly once with its original result while the export queue is saturated', async () => {
    const before = runtimeObservabilityHealth().tracing!;
    for (let i = 0; i <= before.maxQueued; i++) {
      const callId = 'saturation-' + i;
      beginToolTrace({ ctx, callId, toolName: 'synthetic:saturation', pluginName: 'synthetic' } as never);
      finishToolTrace({ ctx, callId, status: 'ok' } as never);
    }
    expect(runtimeObservabilityHealth().tracing).toMatchObject({ queuedSpans: before.maxQueued, queueDroppedSpans: before.queueDroppedSpans + 1 });
    const original = { result: 'unchanged' };
    const handler = vi.fn(async () => original);
    const started = performance.now();
    expect(await PROJECTED_DEPS.aroundInvoke!({ tool: { pluginName: 'synthetic' }, toolName: 'synthetic:saturation',
      input: {}, ctx, callId: 'full-queue-handler', invoke: handler } as never)).toBe(original);
    expect(handler).toHaveBeenCalledOnce();
    expect(performance.now() - started).toBeLessThan(2_000);
    await flushRuntimeObservability();
    expect(runtimeObservabilityHealth().tracing).toMatchObject({ active: 0, queuedSpans: 0 });
  }, 20_000);
});

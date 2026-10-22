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
  initializeRuntimeObservability, runtimeObservabilityHealth, shutdownRuntimeObservability } from './runtime';
import type { GatewayRequestTimeline } from '../inference-gateway/request-stage-telemetry';

describe('production observability composition', () => {
  let server: http.Server;
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const outboundParents: string[] = [];
  const ctx = { workspaceId: 'synthetic-workspace', harnessSlug: 'papercusp', role: 'worker',
    spawnId: 'synthetic-session', log: vi.fn(), requestOrigin: { headers: {
      traceparent: '00-12345678901234567890123456789012-1234567890123456-01',
      baggage: 'private=SECRET',
    } } } as never;

  beforeAll(async () => {
    fixture.db = await createOrgTestDb();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAPERCUSP_INTERNAL_BUILD', 'false');
    vi.stubEnv('PAPERCUSP_POSTHOG_HOST', '');
    vi.stubEnv('PAPERCUSP_POSTHOG_KEY', '');
    server = http.createServer(async (req, res) => {
      if (req.url === '/model') {
        outboundParents.push(String(req.headers.traceparent));
        expect(req.headers.baggage).toBeUndefined();
        beginGatewayTrace('synthetic-model', 'synthetic-provider', { traceparent: String(req.headers.traceparent) });
        finishGatewayTrace('synthetic-model', { model: 'synthetic-model', requestId: 1, attempts: 1,
          cache: { inputTokens: 10, cacheReadTokens: 2 }, durationsMs: { queueWait: 0, upstreamTtfb: 1 },
          outcome: 'ok' } as GatewayRequestTimeline);
        res.end('model-ok');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captured.push(...JSON.parse(Buffer.concat(chunks).toString()).batch);
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

  async function invoke(callId: string, fail = false) {
    PROJECTED_DEPS.onDispatchStart!({ ctx, toolName: 'synthetic:observe', pluginName: 'synthetic', callId } as never);
    const handler = vi.fn(async () => {
      await Promise.resolve();
      const child = trace.getTracer('application').startSpan('SECRET child name', { attributes: { prompt: 'SECRET' } });
      child.end();
      const response = await fetch(`${fixture.host}/model`, { headers: { authorization: 'SECRET' } });
      if (fail) throw new Error('SECRET');
      return response.text();
    });
    let result: unknown;
    try {
      result = await PROJECTED_DEPS.aroundInvoke!({ tool: { pluginName: 'synthetic' }, toolName: 'synthetic:observe',
        input: { prompt: 'SECRET' }, ctx, callId, invoke: handler } as never);
    } catch (error) { result = error; }
    await PROJECTED_DEPS.recordInvocation!({ ctx, callId, toolName: 'synthetic:observe', pluginName: 'synthetic',
      windowKey: 'synthetic-window', status: fail ? 'error' : 'ok', durationMs: 1, args: { prompt: 'SECRET' },
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
});

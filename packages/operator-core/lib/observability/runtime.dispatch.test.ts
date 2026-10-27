import { afterEach, expect, it, vi } from 'vitest';
import { propagation, trace } from '@opentelemetry/api';

vi.mock('../telemetry-flush', async original => ({
  ...(await original<object>()),
  resolveTelemetryConfig: async () => ({ optedIn: true, internalBuild: false,
    host: 'https://capture.example.test', projectKey: 'synthetic-project',
    distinctId: 'synthetic-install', consentSince: 0 }),
}));
vi.mock('../auth/loopback-peer-trust', async original => ({
  ...(await original<object>()), customerAgentExecutionRequired: () => false,
}));
vi.mock('../agent-tools/coordination/dispatch-heartbeat', async original => ({
  ...(await original<object>()), maybeBeatPresenceOnDispatch: vi.fn(),
}));

import { PROJECTED_DEPS } from '../projected-tool-deps';
import { endInFlightCall } from '../in-flight-calls';
import { finishToolTrace, flushRuntimeObservability, initializeRuntimeObservability,
  shutdownRuntimeObservability } from './runtime';

afterEach(async () => {
  await shutdownRuntimeObservability();
  trace.disable();
  propagation.disable();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('preserves a throwing production dispatch handler and exports its correlated sanitized exception', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', send);
  vi.stubEnv('NODE_ENV', 'production');
  initializeRuntimeObservability();
  const callId = 'synthetic-dispatch-error';
  const toolName = 'synthetic:observe';
  const ctx = { role: 'worker', workspaceId: 'synthetic-dispatch', harnessSlug: 'papercusp' };
  const originalError = new Error('SECRET original handler error');
  const handler = vi.fn(async () => { throw originalError; });
  PROJECTED_DEPS.onDispatchStart!({ ctx, toolName, pluginName: 'synthetic', callId } as never);
  try {
    await expect(PROJECTED_DEPS.aroundInvoke!({
      tool: { pluginName: 'synthetic' }, toolName, input: { prompt: 'SECRET arguments' },
      ctx, callId, invoke: handler,
    } as never)).rejects.toBe(originalError);
    expect(handler).toHaveBeenCalledOnce();
    const correlation = finishToolTrace({ callId, status: 'error', errorCode: 'handler_error' } as never);
    expect(correlation).toMatchObject({ callId, traceId: expect.any(String), spanId: expect.any(String) });
    await flushRuntimeObservability();
    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(send.mock.calls[0]![1]!.body));
    const exception = payload.batch.find((event: { event: string }) => event.event === '$exception');
    expect(exception).toBeDefined();
    expect(exception.properties).toMatchObject({
      $ai_trace_id: correlation!.traceId, $ai_span_id: correlation!.spanId,
      'papercusp.call_id': callId, 'papercusp.tool': toolName, $ai_is_error: true,
      $exception_list: [{ type: 'PapercuspExecutionError', value: 'handler_error' }],
    });
    expect(JSON.stringify(payload)).not.toContain('SECRET');
  } finally { endInFlightCall(callId); }
});

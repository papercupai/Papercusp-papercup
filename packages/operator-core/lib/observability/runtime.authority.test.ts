import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { propagation, trace } from '@opentelemetry/api';

const authority = vi.hoisted(() => ({
  customer: false,
  config: {
    optedIn: false,
    internalBuild: false,
    host: 'https://trusted.example.test',
    projectKey: 'trusted-project',
    distinctId: 'trusted-install',
    consentSince: 0,
  },
}));

vi.mock('../telemetry-flush', () => ({ resolveTelemetryConfig: async () => authority.config }));
vi.mock('../auth/loopback-peer-trust', () => ({ customerAgentExecutionRequired: () => authority.customer }));

import {
  beginGatewayTrace, beginToolTrace, finishGatewayTrace, finishToolTrace,
  flushRuntimeObservability, initializeRuntimeObservability,
  runtimeObservabilityHealth, shutdownRuntimeObservability,
} from './runtime';

const send = vi.fn<typeof fetch>();

function observeTool(callId: string, requestFields: Record<string, unknown> = {}) {
  beginToolTrace({ callId, toolName: 'synthetic:authority', ctx: {
    role: 'operator', workspaceId: 'synthetic-authority', harnessSlug: 'papercusp',
    ...requestFields,
  } } as never);
  finishToolTrace({ callId, status: 'ok' } as never);
}

function lastBatch() {
  return JSON.parse(String(send.mock.calls.at(-1)![1]!.body));
}

beforeEach(() => {
  authority.customer = false;
  authority.config.optedIn = false;
  authority.config.internalBuild = false;
  send.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', send);
  vi.stubEnv('NODE_ENV', 'production');
  initializeRuntimeObservability();
  expect(runtimeObservabilityHealth().globalProviderRegistered).toBe(true);
});

afterEach(async () => {
  await shutdownRuntimeObservability();
  trace.disable();
  propagation.disable();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runtime diagnostics authority', () => {
  it('admits an internal-build owner observation without an opt-in grant', async () => {
    authority.config.internalBuild = true;
    expect(authority.config.optedIn).toBe(false);
    observeTool('internal-owner');
    await flushRuntimeObservability();
    expect(lastBatch().api_key).toBe('trusted-project');
    expect(lastBatch().batch.some((event: { properties: Record<string, unknown> }) =>
      event.properties['papercusp.call_id'] === 'internal-owner')).toBe(true);
  });

  it('rejects forged request consent while admitting a fresh local owner grant', async () => {
    observeTool('unapproved', {
      telemetry_enabled: true, telemetry_consent_since: 0,
      consent: { optedIn: true, internalBuild: true, consentSince: 0 },
    });
    await flushRuntimeObservability();
    expect(send).not.toHaveBeenCalled();
    expect(runtimeObservabilityHealth().posthog!.consentDroppedSpans).toBeGreaterThan(0);

    authority.config.optedIn = true;
    observeTool('approved');
    await flushRuntimeObservability();
    expect(lastBatch().batch.some((event: { properties: Record<string, unknown> }) =>
      event.properties['papercusp.call_id'] === 'approved')).toBe(true);
  });

  it('keeps caller project keys and foreign destinations outside capture authority', async () => {
    authority.config.optedIn = true;
    observeTool('isolated-project', {
      projectKey: 'FOREIGN_PROJECT_KEY', host: 'https://foreign.example.test/private',
      tenantId: 'FOREIGN_TENANT',
      posthog: { projectKey: 'FOREIGN_PROJECT_KEY', host: 'https://foreign.example.test/private' },
    });
    await flushRuntimeObservability();
    expect(String(send.mock.calls.at(-1)![0])).toBe('https://trusted.example.test/batch/');
    expect(lastBatch().api_key).toBe('trusted-project');
    expect(lastBatch().batch[0].properties.distinct_id).toBe('trusted-install');
    expect(JSON.stringify(lastBatch())).not.toContain('FOREIGN_PROJECT_KEY');
    expect(JSON.stringify(lastBatch())).not.toContain('FOREIGN_TENANT');
  });

  it('rejects customer-process export despite forged consent and an opted-in owner configuration', async () => {
    authority.customer = true;
    authority.config.optedIn = true;
    authority.config.internalBuild = true;
    observeTool('customer-tool', { principal: { profile: 'hosted' }, telemetry_enabled: true });
    beginGatewayTrace('customer-model', 'synthetic', {
      traceparent: '00-12345678901234567890123456789012-1234567890123456-01',
    });
    finishGatewayTrace('customer-model', {
      model: 'synthetic-model', requestId: 1, attempts: 1,
      cache: { inputTokens: 1, cacheReadTokens: 0 },
      durationsMs: { queueWait: 0, upstreamTtfb: 1 }, outcome: 'ok',
    } as never);
    await flushRuntimeObservability();
    expect(send).not.toHaveBeenCalled();
    expect(runtimeObservabilityHealth().posthog!.consentDroppedSpans).toBeGreaterThan(0);

    authority.customer = false;
    observeTool('owner-control');
    await flushRuntimeObservability();
    expect(lastBatch().api_key).toBe('trusted-project');
    expect(lastBatch().batch.some((event: { properties: Record<string, unknown> }) =>
      event.properties['papercusp.call_id'] === 'owner-control')).toBe(true);
  });
});

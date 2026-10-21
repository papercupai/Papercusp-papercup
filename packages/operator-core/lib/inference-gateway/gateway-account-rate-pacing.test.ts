import { describe, expect, it, beforeEach } from 'vitest';
import { governorForBackend, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { executeGatewayRequestKernel } from './request-kernel';
import { makeGatewayLaneRegistry } from './provider-adapters';
import { GatewayRequestTelemetry } from './request-stage-telemetry';
import type { AccountPool } from './provider-contracts';

const unusedPool = { active: () => null, onExhausted: () => null } as unknown as AccountPool;

const lane = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
}).openaiResponses;

beforeEach(() => resetGovernorRegistry());

describe('shared Codex account pacing', () => {
  it('keeps transient feedback isolated to the affected account bucket', () => {
    const accountA = governorForBackend('codex', 'gpt-5.6-sol', undefined, 'codex-a');
    const accountB = governorForBackend('codex', 'gpt-5.6-sol', undefined, 'codex-b');

    accountA.penalize({ rateLimited: true });

    expect(accountA.state.rpmFactor).toBeLessThan(1);
    expect(accountB.state.rpmFactor ?? 1).toBe(1);
    expect(accountA).not.toBe(accountB);
  });

  it('paces each attempt before upstream execution and releases the permit after it settles', async () => {
    const events: string[] = [];
    const telemetry = new GatewayRequestTelemetry();

    await executeGatewayRequestKernel({
      request: {
        lane,
        body: (async function* () { yield Buffer.from('{"model":"gpt-5.6-sol"}'); })(),
        ownerId: 'pacing-test',
      },
      policy: {
        maxBodyBytes: 1024,
        bodyReadTimeoutMs: 100,
        requestCeilingMs: 500,
        ttfbTimeoutMs: 100,
        bodyIdleTimeoutMs: 100,
        downstreamIdleTimeoutMs: 100,
        maxAttempts: 1,
      },
      telemetry,
      admission: {
        run: async (_context, task) => task(),
        acquireAttempt: async () => {
          events.push('acquire');
          return () => events.push('release');
        },
      },
      adapter: {
        selectInitial: async () => ({
          key: 'codex:account-a',
          accountId: 'account-a',
          transport: lane.transports[0]!.id,
          value: {},
        }),
        selectFailover: async () => null,
        prepareAttempt: async () => {
          events.push('prepare');
          return {};
        },
        executeAttempt: async () => {
          events.push('execute');
          return { status: 200, streaming: false, transport: lane.transports[0]!.id, metadata: {}, body: null };
        },
      },
      inFlight: { register: async () => ({ unregister: () => undefined }) },
      downstream: {
        start: async () => undefined,
        write: async () => undefined,
        end: async () => undefined,
      },
    });

    expect(events).toEqual(['prepare', 'acquire', 'execute', 'release']);
  });
});

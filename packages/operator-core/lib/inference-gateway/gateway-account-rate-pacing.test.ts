import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { governorForBackend, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { executeGatewayRequestKernel } from './request-kernel';
import { makeGatewayLaneRegistry } from './provider-adapters';
import { GatewayRequestTelemetry } from './request-stage-telemetry';
import type { AccountPool } from './provider-contracts';
import { createInferenceGateway, ACCOUNT_HEADER } from './gateway';
import { createFailoverPool } from './account-failover';
import { parseCodexRateReset } from './codex-oauth-proxy';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGatewayRequestOutcomeStore, InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore } from './gateway-request-outcome-store';

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

describe('production gateway account-governor wiring', () => {
  const model = 'gpt-6.1-sol';
  let gateway: ReturnType<typeof createInferenceGateway> | undefined;
  const homes: string[] = [];

  beforeEach(() => configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore()));
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
    vi.restoreAllMocks();
    resetGatewayRequestOutcomeStore();
  });

  function accounts() {
    return createFailoverPool(['account-a', 'account-b'].map(accountId => ({
      accountId, token: async () => `token-${accountId}`,
    })));
  }

  function response() {
    return Response.json({ id: 'resp_pacing', object: 'response', status: 'completed', output: [] });
  }

  async function send(path = '/v1/responses', bodyModel = model) {
    const port = await gateway!.listen(0);
    const result = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'account-a' },
      body: JSON.stringify({ model: bodyModel, input: [], messages: [], max_tokens: 8, stream: false }),
    });
    await result.text();
    return result;
  }

  it('admits the real Codex bearer attempt through the shared governor before upstream fetch', async () => {
    const codex = governorForBackend('codex', model, undefined, 'account-a');
    const claude = governorForBackend('claude-code', 'claude-opus-4', undefined, 'account-a');
    const acquire = vi.spyOn(codex, 'acquire');
    const fetchImpl = vi.fn(async () => {
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(codex.state.smoothRpm).toBe(true);
      return response();
    }) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, smoothRpm: true, selfHeal: { enabled: false } });
    expect((await send()).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith({}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(Object.getPrototypeOf(codex)).toBe(Object.getPrototypeOf(claude));
    // The production stats path resolves the Claude bucket through the same
    // factory and applies the gateway smoothing policy to both providers.
    gateway.stats();
    expect(claude.state.smoothRpm).toBe(codex.state.smoothRpm);
  });

  it('routes a real transient 429 into only the emitting account governor', async () => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    const sibling = governorForBackend('codex', model, undefined, 'account-b');
    const otherProvider = governorForBackend('claude-code', 'claude-opus-4', undefined, 'account-a');
    const acquireA = vi.spyOn(affected, 'acquire');
    const acquireB = vi.spyOn(sibling, 'acquire');
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      routed.push(auth);
      return routed.length === 1
        ? Response.json({ error: { message: 'temporary burst throttle', type: 'rate_limit_error' } },
          { status: 429, headers: { 'retry-after': '0.01' } })
        : response();
    }) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, selfHeal: { enabled: false } });
    expect((await send()).status).toBe(200);
    expect(routed[0]).toContain('token-account-a');
    expect(affected.state.rpmFactor).toBeLessThan(1);
    expect(sibling.state.rpmFactor ?? 1).toBe(1);
    expect(otherProvider.state.rpmFactor ?? 1).toBe(1);
    expect(acquireA).toHaveBeenCalled();
    expect(routed.length).toBeGreaterThan(1);
    expect(acquireA.mock.calls.length + acquireB.mock.calls.length).toBe(routed.length);
  });

  it.each(['oauth', 'cli'] as const)('uses the same shared governor on the production %s transport', async transport => {
    const home = await fs.mkdtemp(join(tmpdir(), 'account-pacing-'));
    homes.push(home);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
    await fs.writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: token, refresh_token: 'fixture-refresh', account_id: 'account-a',
    } }));
    const governor = governorForBackend('codex', model, undefined, 'account-a');
    const acquire = vi.spyOn(governor, 'acquire');
    const execute = vi.fn(() => {
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(governor.state.smoothRpm).toBe(true);
    });
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexCliAccounts: () => [{ accountId: 'account-a', home }],
      codexOAuthProxy: transport === 'oauth', smoothRpm: true, selfHeal: { enabled: false },
      codexCliRun: async () => {
        execute();
        return { text: 'paced', inputTokens: 1, outputTokens: 1 };
      },
      fetchImpl: (async () => {
        execute();
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: {
          id: 'resp_paced_oauth', model, status: 'completed', output: [],
        } }) + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch,
    });
    expect((await send()).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  const nonRateCases: Array<{ name: string; status: number; headers: Record<string, string> }> = [
    { name: 'quota exhaustion', status: 429, headers: {
      'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '60' } },
    { name: 'authentication', status: 401, headers: {} },
    { name: 'upstream overload', status: 503, headers: {} },
  ];
  it.each(nonRateCases)('does not lower learned RPM for $name through production feedback', async ({ status, headers }) => {
    // A zero/absent window length is an inactive meter, not a quota wall.
    expect(parseCodexRateReset(headers).transient).toBe(status !== 429);
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    const sibling = governorForBackend('codex', model, undefined, 'account-b');
    let calls = 0;
    const fetchImpl = vi.fn(async () => ++calls === 1
      ? Response.json({ error: { message: 'provider refusal' } }, { status, headers })
      : response()) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, selfHeal: { enabled: false } });
    await send();
    expect(fetchImpl).toHaveBeenCalled();
    expect(affected.state.rpmFactor ?? 1).toBe(1);
    expect(sibling.state.rpmFactor ?? 1).toBe(1);
  });
});

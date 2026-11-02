import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { governorForBackend, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { executeGatewayRequestKernel } from './request-kernel';
import { makeGatewayLaneRegistry } from './provider-adapters';
import { GatewayRequestTelemetry } from './request-stage-telemetry';
import type { AccountPool } from './provider-contracts';
import { createInferenceGateway, ACCOUNT_HEADER, ACCOUNT_PIN_HEADER, PRIORITY_HEADER } from './gateway';
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
  let gatewayPort: number | undefined;
  const homes: string[] = [];

  beforeEach(() => configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore()));
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    gatewayPort = undefined;
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

  async function send(path = '/v1/responses', bodyModel = model, headers: Record<string, string> = {}, input = 'Reply briefly.') {
    const port = gatewayPort ??= await gateway!.listen(0);
    const result = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'account-a', ...headers },
      body: JSON.stringify({ model: bodyModel, input, max_tokens: 8, stream: false }),
    });
    const responseBody = await result.text();
    return { status: result.status, body: responseBody };
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

  it('orders account starts by priority without letting later arrivals race a paced request', async () => {
    const governor = governorForBackend('codex', model, undefined, 'account-a');
    const originalAcquire = governor.acquire.bind(governor);
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    vi.spyOn(governor, 'acquire').mockImplementation(async (...args) => {
      if (first) { first = false; entered(); await blocked; }
      return originalAcquire(...args);
    });
    const order: string[] = [];
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), smoothRpm: false, selfHeal: { enabled: false },
      fetchImpl: (async (_url, init) => {
        order.push(JSON.parse(typeof init?.body === 'string' ? init.body :
          Buffer.from(init?.body as Uint8Array).toString()).input);
        return response();
      }) as typeof fetch,
    });
    const pinned = { [ACCOUNT_PIN_HEADER]: 'hard' };
    const one = send('/v1/responses', model, pinned, 'first');
    await waiting;
    const background = send('/v1/responses', model, pinned, 'background');
    await vi.waitFor(() => expect(gateway!.stats().codexAdmission.running).toBeGreaterThanOrEqual(2));
    const interactive = send('/v1/responses', model, { ...pinned, [PRIORITY_HEADER]: 'mug' }, 'interactive');
    try {
      await vi.waitFor(() => expect(gateway!.stats().codexAdmission.running).toBeGreaterThanOrEqual(3));
      expect(order).toEqual([]);
    } finally { unblock(); }
    const results = await Promise.all([one, background, interactive]);
    expect(results.map(x => x.status), JSON.stringify(results)).toEqual([200, 200, 200]);
    expect(order).toEqual(['first', 'interactive', 'background']);
  });

  it.each(['bearer', 'oauth'] as const)('reports local %s account pacing exhaustion as throttling without blaming the upstream', async transport => {
    const governor = governorForBackend('codex', model, undefined, 'account-a');
    vi.spyOn(governor, 'acquire').mockResolvedValue(null);
    const fetchImpl = vi.fn(async () => response()) as typeof fetch;
    const home = await fs.mkdtemp(join(tmpdir(), 'account-pacing-'));
    homes.push(home);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
    await fs.writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: token, refresh_token: 'fixture-refresh', account_id: 'account-a',
    } }));
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      ...(transport === 'oauth' ? { codexCliAccounts: () => [{ accountId: 'account-a', home }], codexOAuthProxy: true }
        : { codexPool: accounts() }), fetchImpl, selfHeal: { enabled: false } });
    const result = await send();
    expect(result.status, result.body).toBe(429);
    expect(result.body).toContain('pacing wait exceeded');
    expect(result.body).not.toContain('upstream failed');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(governor.state.rpmFactor ?? 1).toBe(1);
    expect(gateway.stats().codex.errors).toBe(0);
    expect(gateway.stats().requestStages!.outcomes.shed).toBe(1);
    expect(gateway.stats().requestStages!.outcomes['upstream-429']).toBe(0);
  });

  it('routes a soft pin around a live governor pause even when the pool and durable hints call it healthy', async () => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    affected.state.pausedUntil = Date.now() + 60_000;
    const routed: string[] = [];
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), maxQueueWaitMs: 100, selfHeal: { enabled: false },
      fetchImpl: (async (_url, init) => {
        routed.push(new Headers(init?.headers).get('authorization') ?? '');
        return response();
      }) as typeof fetch,
    });
    const result = await send();
    expect(result.status, result.body).toBe(200);
    expect(routed).toEqual(['Bearer token-account-b']);
    expect(affected.state.reqInWindow).toBe(0);
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
    // One successful destination response earns one independent upward probe.
    expect(sibling.state.rpmFactor).toBeCloseTo(1 + 1 / sibling.state.limits.rpm!);
    expect(otherProvider.state.rpmFactor ?? 1).toBe(1);
    expect(acquireA).toHaveBeenCalled();
    expect(routed.length).toBeGreaterThan(1);
    expect(acquireA.mock.calls.length + acquireB.mock.calls.length).toBe(routed.length);
  });

  // WI-6554700010029423: a burst 429's retry-after is not enforced upstream (measured 42-570s on
  // gpt-6.1-sol; the same accounts served every request started inside it). The account-wide
  // governor pause is bounded to the bare-429 failover backoff, not the retry-after or 2-min cap.
  it('bounds a transient 429 account pause to the bare-429 failover backoff, not its retry-after', async () => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    let calls = 0;
    const fetchImpl = vi.fn(async () => ++calls === 1
      ? Response.json({ error: { message: 'temporary burst throttle', type: 'rate_limit_error' } },
        { status: 429, headers: { 'retry-after': '570' } })
      : response()) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, bare429FailoverBackoffMs: 1_000, selfHeal: { enabled: false } });
    const before = Date.now();
    expect((await send()).status).toBe(200);
    expect(affected.state.pausedUntil).toBeGreaterThan(before);
    expect(affected.state.pausedUntil).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it.each(['bearer', 'oauth', 'cli'] as const)(
    'reselects before %s dispatch when the selected account pauses during permit acquisition', async transport => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    const originalAcquire = affected.acquire.bind(affected);
    vi.spyOn(affected, 'acquire').mockImplementationOnce(async (...args) => {
      affected.penalize({ resetAt: Date.now() + 60_000 });
      return originalAcquire(...args);
    });
    const pool = accounts();
    const routed: string[] = [];
    const cliAccounts = await Promise.all(['account-a', 'account-b'].map(async accountId => {
      const home = await fs.mkdtemp(join(tmpdir(), 'account-reselection-'));
      homes.push(home);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
      await fs.writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
        access_token: token, refresh_token: 'fixture-refresh', account_id: accountId,
      } }));
      return { accountId, home };
    }));
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      ...(transport === 'bearer' ? { codexPool: pool } : {
        codexCliPool: pool, codexCliAccounts: () => cliAccounts, codexOAuthProxy: transport === 'oauth',
        codexCliRun: async ({ home }) => {
          routed.push(cliAccounts.find(account => account.home === home)!.accountId);
          return { text: 'reselected', inputTokens: 1, outputTokens: 1 };
        },
      }),
      maxQueueWaitMs: 100, selfHeal: { enabled: false },
      fetchImpl: (async (_url, init) => {
        const headers = new Headers(init?.headers);
        routed.push(transport === 'bearer' ? headers.get('authorization')! : headers.get('chatgpt-account-id')!);
        return transport === 'bearer' ? response() : new Response('data: ' + JSON.stringify({
          type: 'response.completed', response: { id: 'resp_reselected', model, status: 'completed', output: [] },
        }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch,
    });
    const result = await send();
    expect(result.status, result.body).toBe(200);
    expect(routed).toEqual([transport === 'bearer' ? 'Bearer token-account-b' : 'account-b']);
    expect(pool.parkState?.('account-a')).toBeUndefined();
    expect(affected.state.reqInWindow).toBe(0);
    expect(affected.state.inFlight).toBe(0);
    expect(affected.state.rpmFactor ?? 1).toBe(1);
    expect(gateway.stats().codex.upstream429).toBe(0);
    expect(gateway.stats().codex.errors).toBe(0);
  });

  it('cancels an active pacing sleep on a new account pause and retains hard pins', async () => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    affected.state.lastAcquireAt = Date.now();
    const originalAcquire = affected.acquire.bind(affected);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const acquire = vi.spyOn(affected, 'acquire').mockImplementationOnce(async (...args) => {
      const pending = originalAcquire(...args);
      entered();
      return pending;
    });
    const routed: string[] = [];
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), smoothRpm: true, maxQueueWaitMs: 5_000, selfHeal: { enabled: false },
      fetchImpl: (async (_url, init) => {
        routed.push(new Headers(init?.headers).get('authorization') ?? '');
        return response();
      }) as typeof fetch,
    });
    const pending = send();
    await waiting;
    affected.penalize({ resetAt: Date.now() + 60_000 });
    expect((await pending).status).toBe(200);
    expect(acquire.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(routed).toEqual(['Bearer token-account-b']);
    expect(affected.state.inFlight).toBe(0);

    const hardPinned = await send('/v1/responses', model, { [ACCOUNT_PIN_HEADER]: 'hard' });
    expect(hardPinned.status).toBe(429);
    expect(routed).toEqual(['Bearer token-account-b']);
    expect(gateway.stats().requestStages!.outcomes.shed).toBe(1);
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
    const result = await send();
    expect(result.status, result.body).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('keeps a hard-pinned transient 429 on its original account', async () => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    const sibling = governorForBackend('codex', model, undefined, 'account-b');
    const acquireB = vi.spyOn(sibling, 'acquire');
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      routed.push(new Headers(init?.headers).get('authorization') ?? '');
      return routed.length === 1
        ? Response.json({ error: { message: 'burst throttle' } }, { status: 429, headers: { 'retry-after': '0.01' } })
        : response();
    }) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, selfHeal: { enabled: false } });
    const result = await send('/v1/responses', model, { [ACCOUNT_PIN_HEADER]: 'hard' });
    expect([200, 429]).toContain(result.status);
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every(auth => auth.includes('token-account-a'))).toBe(true);
    expect(acquireB).not.toHaveBeenCalled();
    expect(affected.state.rpmFactor).toBeLessThan(1);
  });

  it('releases an acquired permit exactly once on client cancellation without lowering learned RPM', async () => {
    const affected = governorForBackend('codex', model, undefined, 'account-a');
    const originalAcquire = affected.acquire.bind(affected);
    const released = vi.fn();
    const acquire = vi.spyOn(affected, 'acquire').mockImplementation(async (...args) => {
      const permit = await originalAcquire(...args);
      return permit ? () => { released(); permit(); } : null;
    });
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const aborted = new Promise<void>(resolve => { markAborted = resolve; });
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        markAborted();
        reject(new DOMException('cancelled upstream', 'AbortError'));
      }, { once: true });
      markStarted();
    })) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, selfHeal: { enabled: false } });
    const port = await gateway.listen(0);
    const controller = new AbortController();
    const result = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'account-a' },
      body: JSON.stringify({ model, input: 'Reply briefly.', stream: false }),
    }).then(() => 'completed', (error: Error) => error.name);
    await started;
    expect(acquire).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await result).toBe('AbortError');
    await aborted;
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(affected.state.rpmFactor ?? 1).toBe(1);
  });

  it('cancels a real governor waiter before any upstream send without leaking a permit or timeout feedback', async () => {
    const governor = governorForBackend('codex', model, undefined, 'account-a');
    const originalAcquire = governor.acquire.bind(governor);
    let entered!: () => void;
    let settled!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const finished = new Promise<void>(resolve => { settled = resolve; });
    const acquire = vi.spyOn(governor, 'acquire').mockImplementation(async (...args) => {
      // Create a real, bounded governor wait after routing has selected this account.
      governor.state.pausedUntil = Date.now() + 250;
      entered();
      try { return await originalAcquire(...args); }
      finally { settled(); }
    });
    const fetchImpl = vi.fn(async () => response()) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, upstreamHeadersTimeoutMs: 25, selfHeal: { enabled: false } });
    const port = await gateway.listen(0);
    const controller = new AbortController();
    const result = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'account-a' },
      body: JSON.stringify({ model, input: 'Reply briefly.', stream: false }),
    }).then(() => 'completed', (error: Error) => error.name);
    await waiting;
    controller.abort();
    expect(await result).toBe('AbortError');
    await finished;
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(governor.state.inFlight).toBe(0);
    expect(governor.state.rpmFactor ?? 1).toBe(1);
    await vi.waitFor(() => expect(gateway!.stats().requestStages?.recent.at(-1)?.outcome).toBe('cancelled'));
    expect(gateway!.stats().requestStages?.recent.at(-1)?.events.some(event => event.stage === 'upstreamTtfb')).toBe(false);
  });

  it('paces the first and destination retry accounts outside their upstream TTFB deadlines', async () => {
    const events: string[] = [];
    const waits: number[] = [];
    const governors = ['account-a', 'account-b'].map(accountId => {
      const governor = governorForBackend('codex', model, undefined, accountId);
      const originalAcquire = governor.acquire.bind(governor);
      vi.spyOn(governor, 'acquire').mockImplementation(async (...args) => {
        events.push(`wait:${accountId}`);
        governor.state.pausedUntil = Date.now() + 120;
        const startedAt = Date.now();
        const release = await originalAcquire(...args);
        waits.push(Date.now() - startedAt);
        events.push(`admit:${accountId}`);
        return release ? () => { events.push(`release:${accountId}`); release(); } : null;
      });
      return governor;
    });
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const accountId = auth.includes('token-account-a') ? 'account-a' : 'account-b';
      events.push(`send:${accountId}`);
      expect(events.at(-2)).toBe(`admit:${accountId}`);
      return accountId === 'account-a'
        ? Response.json({ error: { message: 'temporary burst throttle', type: 'rate_limit_error' } },
          { status: 429, headers: { 'retry-after': '1' } })
        : response();
    }) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'account-a', token: async () => 'claude-token',
      codexPool: accounts(), fetchImpl, upstreamHeadersTimeoutMs: 25, selfHeal: { enabled: false } });
    const result = await send();
    expect(result.status, result.body).toBe(200);
    expect(events).toEqual([
      'wait:account-a', 'admit:account-a', 'send:account-a', 'release:account-a',
      'wait:account-b', 'admit:account-b', 'send:account-b', 'release:account-b',
    ]);
    // Each real local wait exceeds the upstream deadline; both sends still succeed.
    expect(waits).toHaveLength(2);
    expect(waits.every(wait => wait >= 100)).toBe(true);
    expect(governors.map(governor => governor.state.inFlight)).toEqual([0, 0]);
    expect(governors[0]!.state.rpmFactor).toBeLessThan(1);
    expect(governors[1]!.state.rpmFactor).toBeCloseTo(1 + 1 / governors[1]!.state.limits.rpm!);
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
    const result = await send();
    expect(fetchImpl).toHaveBeenCalled();
    expect(affected.state.rpmFactor ?? 1).toBe(1);
    expect(sibling.state.rpmFactor ?? 1).toBeCloseTo(result.status === 200
      ? 1 + 1 / sibling.state.limits.rpm! : 1);
  });
});

import { createHash } from 'node:crypto';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import type { ModelPort, ModelRequest, ModelStreamEvent } from './model-port';
import { captureModelProviderRequest } from './model-port';
import { curateOpenRouterCatalog, type ModelsDevCatalog } from './model-selection';
import type { AccountPool, ActiveAccount } from '../inference-gateway/provider-contracts';
import { createRoutedModelPort, type ProviderFactoryArgs } from './provider-router';

const catalog: ModelsDevCatalog = {
  anthropic: {
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-sonnet-current': {
        id: 'claude-sonnet-current',
        family: 'claude-sonnet',
        release_date: '2026-08-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  openai: {
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  google: {
    env: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    models: {
      'gemini-test': { id: 'gemini-test', reasoning: false },
    },
  },
};

const request = (modelSpec: string): ModelRequest => ({
  model: modelSpec,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  priority: 'operator',
});

function model(parts: LanguageModelV3StreamPart[] = [{
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
}], observe?: (options: Parameters<LanguageModelV3['doStream']>[0]) => void): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake',
    supportedUrls: {},
    async doGenerate() { throw new Error('unused'); },
    async doStream(options) {
      observe?.(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

async function collect(port: ModelPort, req: ModelRequest): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of port.stream(req)) {
    if (event.type === 'provider_request') await captureModelProviderRequest(event);
    events.push(event);
  }
  return events;
}

function openRouterPool(account: ActiveAccount): AccountPool {
  return {
    active: vi.fn(() => account),
    select: vi.fn((id) => id === account.accountId ? account : null),
    onExhausted: vi.fn(() => null),
  };
}

const openRouterAccount = (): ActiveAccount => ({
  accountId: 'customer-openrouter-test', authMode: 'api-key',
  token: vi.fn(async () => ' customer-openrouter-test-key '),
});

describe('createRoutedModelPort', () => {
  it('awaits private admission before dispatch and binding before the next stream pull', async () => {
    const order: string[] = [];
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let wireCalls = 0;
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model([
        { type: 'response-metadata', id: 'gen-private-capture', modelId: 'vendor/model' },
        { type: 'error', error: 'provider failed' },
      ], () => { wireCalls++; order.push('wire'); }),
      openRouterRequestCapture: context => {
        expect(context).toEqual({ modelId: 'vendor/model', servedAccount: 'customer-openrouter-test',
          credentialSha256: createHash('sha256').update('customer-openrouter-test-key').digest('hex') });
        expect(Object.isFrozen(context)).toBe(true);
        return async observation => {
          expect(Object.isFrozen(observation)).toBe(true);
          order.push(observation.response?.id ? 'bind' : 'admit');
          if (!observation.response) await gate;
        };
      } });
    const pending = collect(port, request('openrouter/vendor/model'));
    await vi.waitFor(() => expect(order).toEqual(['admit']));
    expect(wireCalls).toBe(0);
    resume();
    const events = await pending;
    expect(order).toEqual(['admit', 'wire', 'bind']);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(JSON.stringify(events)).not.toMatch(/credentialSha256|customer-openrouter-test-key|budgetGrant/);
  });

  it('creates an independent private handler for each request and snapshots the host factory', async () => {
    const captures: string[][] = [];
    const factory = vi.fn(() => { const seen: string[] = []; captures.push(seen);
      return async (observation: { response?: { id?: string } }) => { seen.push(observation.response?.id ?? 'intent'); }; });
    const options = { catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model(), openRouterRequestCapture: factory };
    const port = createRoutedModelPort(options);
    options.openRouterRequestCapture = vi.fn(() => { throw new Error('mutated factory'); });
    await collect(port, request('openrouter/vendor/model'));
    await collect(port, request('openrouter/vendor/model'));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(captures).toEqual([['intent'], ['intent']]);
  });

  it('retains the selected local account across an asynchronous credential read', async () => {
    const account = openRouterAccount();
    account.token = async () => { account.accountId = 'later-local-label'; return 'actual-execution-key'; };
    const contexts: unknown[] = [];
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(account),
      createLanguageModel: async () => model(), openRouterRequestCapture: context => {
        contexts.push(context); return async () => {};
      } });
    const events = await collect(port, { ...request('openrouter/vendor/model'), account: 'customer-openrouter-test' });
    expect(contexts).toEqual([{ modelId: 'vendor/model', servedAccount: 'customer-openrouter-test',
      credentialSha256: createHash('sha256').update('actual-execution-key').digest('hex') }]);
    expect(events.at(-1)).toMatchObject({ type: 'stop', servedAccount: 'customer-openrouter-test' });
  });

  it('refuses an unawaited private dispatch continuation without making a wire call', async () => {
    const wire = vi.fn();
    const capture = vi.fn(async () => {});
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model(undefined, wire), openRouterRequestCapture: () => capture });
    const iterator = port.stream(request('openrouter/vendor/model'))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'provider_request' });
    await expect(iterator.next()).rejects.toThrow('capture was not awaited');
    expect(capture).not.toHaveBeenCalled(); expect(wire).not.toHaveBeenCalled();
  });

  it('does not let a consumer rewrite the identity captured before the next pull', async () => {
    const seen: unknown[] = [];
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model([{ type: 'response-metadata', id: 'gen-original', modelId: 'vendor/model' },
        { type: 'error', error: 'failed' }]), openRouterRequestCapture: () => async value => { seen.push(value); } });
    for await (const event of port.stream(request('openrouter/vendor/model'))) {
      if (event.type === 'provider_request') {
        if (event.request.response) event.request.response.id = 'gen-mutated';
        await captureModelProviderRequest(event);
        await captureModelProviderRequest(event); // Same continuation is idempotent.
      }
    }
    expect(seen).toEqual([{ provider: 'openrouter', modelId: 'vendor/model' },
      { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-original', modelId: 'vendor/model' } }]);
  });

  it('sanitizes capture failure and stops before provider dispatch, including overlapping abort', async () => {
    const wire = vi.fn(); const abort = new AbortController();
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model(undefined, wire), openRouterRequestCapture: () => async () => {
        abort.abort(); throw new Error('private credential or SQL grant detail');
      } });
    await expect(collect(port, { ...request('openrouter/vendor/model'), signal: abort.signal }))
      .rejects.toThrow('request capture failed; reservation remains unresolved');
    expect(wire).not.toHaveBeenCalled();
  });

  async function selectedEstimate(pricing: Record<string, unknown>, modelId = 'openai/gpt-5.5:free', write = 0) {
    const selected = curateOpenRouterCatalog({ data: [{ id: modelId, pricing }] }, [modelId], 123);
    const port = createRoutedModelPort({ catalog: selected,
      openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model([{ type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' }, usage: {
          inputTokens: { total: 1_000_000, noCache: 800_000, cacheRead: 200_000, cacheWrite: write },
          outputTokens: { total: 100_000, text: 80_000, reasoning: 20_000 },
        } }]),
    });
    const events = await collect(port, request('openrouter/' + modelId));
    const stop = events.at(-1);
    if (stop?.type !== 'stop') throw new Error('missing stop');
    return stop.usage;
  }

  const tokenPrices = { prompt: '0.000002', completion: '0.000003', input_cache_read: '0.0000005', input_cache_write: '0.000004' };

  it('composes exact selected OpenRouter rates through canonical token arithmetic', async () => {
    expect((await selectedEstimate(tokenPrices, 'openai/gpt-5.5:free', 100_000))?.costUsd).toBeCloseTo(2.2);
  });

  it('preserves a genuinely free exact catalog variant', async () => {
    expect((await selectedEstimate({ prompt: '0', completion: '0', input_cache_read: '0' }))?.costUsd).toBe(0);
  });

  it.each([
    { ...tokenPrices, overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000004' }] },
    { ...tokenPrices, request: '0.01' },
    { ...tokenPrices, image: '0.01' },
    { ...tokenPrices, web_search: '0.01' },
    { ...tokenPrices, internal_reasoning: '0.000001' },
    { ...tokenPrices, future_charge: '0' },
    { ...tokenPrices, input_cache_read: undefined },
    { ...tokenPrices, completion: '-1' },
    { ...tokenPrices, image: '-1' },
  ])('keeps conditional, extra, invalid or unknown charges unpriced: %j', async (pricing) => {
    expect(await selectedEstimate(pricing)).not.toHaveProperty('costUsd');
  });

  it('does not infer missing or unreported write-TTL prices', async () => {
    expect(await selectedEstimate({ prompt: '0.000002', completion: '0.000003', input_cache_read: '0.0000005' },
      'openai/gpt-5.5:free', 100_000)).not.toHaveProperty('costUsd');
    expect(await selectedEstimate({ ...tokenPrices, input_cache_write_1h: '0.000008' },
      'openai/gpt-5.5:free', 100_000)).not.toHaveProperty('costUsd');
  });

  it('accepts explicitly zero extra charges without adding arbitrary multipliers', async () => {
    expect((await selectedEstimate({ ...tokenPrices, request: '0', image: '0', web_search: '0' }))?.costUsd)
      .toBeCloseTo(2);
  });

  it.each([0, 100_000, undefined])('prices maintained SDK cache-write report %s without borrowing noCache semantics', async (writes) => {
    const modelId = 'openai/gpt-5.5:free';
    const selected = curateOpenRouterCatalog({ data: [{ id: modelId, pricing: tokenPrices }] }, [modelId], 123);
    // The display projection is advisory; raw exact scoped rates remain the source.
    selected.openrouter.models[modelId].cost = { input: 99, output: 99, cache_read: 99, cache_write: 99 };
    const chunk = { id: 'gen-cache-estimate', object: 'chat.completion.chunk', created: 1, model: modelId,
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000,
        prompt_tokens_details: { cached_tokens: 200_000, ...(writes !== undefined ? { cache_write_tokens: writes } : {}) },
        cost: 1.25 } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } },
    ));
    try {
      const port = createRoutedModelPort({ catalog: selected, openRouterAccounts: openRouterPool(openRouterAccount()) });
      const events = await collect(port, request('openrouter/' + modelId));
      const stop = events.at(-1);
      if (stop?.type !== 'stop') throw new Error('missing stop');
      expect(stop.providerResponse).toMatchObject({ provider: 'openrouter', id: 'gen-cache-estimate', reportedCostUsd: 1.25 });
      expect(stop.usage?.inputTokens).toBe(1_000_000);
      if (writes === undefined) expect(stop.usage).not.toHaveProperty('costUsd');
      else expect(stop.usage?.costUsd).toBeCloseTo(writes === 0 ? 2 : 2.2);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally { fetchSpy.mockRestore(); }
  });

  it('refuses a catalog entry whose stored id differs from the exact selected key', async () => {
    const modelId = 'openai/gpt-5.5:free';
    const selected = curateOpenRouterCatalog({ data: [{ id: modelId, pricing: tokenPrices }] }, [modelId], 123);
    selected.openrouter.models[modelId].id = 'openai/gpt-5.5';
    const port = createRoutedModelPort({ catalog: selected, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => model() });
    const stop = (await collect(port, request('openrouter/' + modelId))).at(-1);
    expect(stop?.type === 'stop' && stop.usage).not.toHaveProperty('costUsd');
  });

  it('captures selected price rates before asynchronous model creation', async () => {
    const modelId = 'openai/gpt-5.5:free';
    const selected = curateOpenRouterCatalog({ data: [{ id: modelId, pricing: tokenPrices }] }, [modelId], 123);
    const port = createRoutedModelPort({ catalog: selected, openRouterAccounts: openRouterPool(openRouterAccount()),
      createLanguageModel: async () => {
        selected.openrouter.models[modelId].pricing!.rates.prompt = '999';
        return model([{ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
          inputTokens: { total: 1_000_000, noCache: 800_000, cacheRead: 200_000, cacheWrite: 100_000 },
          outputTokens: { total: 100_000, text: 100_000, reasoning: 0 },
        } }]);
      } });
    const stop = (await collect(port, request('openrouter/' + modelId))).at(-1);
    expect(stop?.type === 'stop' && stop.usage?.costUsd).toBeCloseTo(2.2);
  });

  it('requires an injected OpenRouter account pool even when env and remote metadata name keys', async () => {
    const createLanguageModel = vi.fn(async () => model());
    const credentials = vi.fn(async () => ({ openai_api_key: 'unrelated-store-test-key' }));
    const port = createRoutedModelPort({
      catalog: { openrouter: { env: ['UNRELATED_PROVIDER_SECRET'], models: {} } },
      env: { OPENROUTER_API_KEY: 'ambient-test-key', UNRELATED_PROVIDER_SECRET: 'foreign-test-key' },
      credentials, createLanguageModel,
    });
    expect(await collect(port, request('openrouter/vendor/model-test'))).toEqual([
      { type: 'error', message: expect.stringContaining('OpenRouter account pool') },
    ]);
    expect(credentials).not.toHaveBeenCalled();
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it.each([undefined, 'auto', 'default'])('selects OpenRouter from its supplied pool for account %s', async (account) => {
    const pool = openRouterPool(openRouterAccount());
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool, createLanguageModel });
    expect((await collect(port, { ...request('openrouter/vendor/model-test:high'), account })).at(-1))
      .toMatchObject({ type: 'stop', reason: 'end_turn', servedAccount: 'customer-openrouter-test' });
    expect(pool.active).toHaveBeenCalledOnce();
    expect(pool.select).not.toHaveBeenCalled();
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'customer-openrouter-test-key',
      selection: { spec: 'openrouter/vendor/model-test:high', provider: 'openrouter',
        modelId: 'vendor/model-test', effort: 'high', metadata: null, providerMetadata: null },
    }));
  });

  it('preserves the selected local account on dispatch and early failed-generation observations', async () => {
    const pool = openRouterPool(openRouterAccount());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool, createLanguageModel: async () => model([
      { type: 'response-metadata', id: 'gen-routed-failure', modelId: 'vendor/model-test' },
      { type: 'error', error: 'lost finish' },
    ]) });
    const events = await collect(port, { ...request('openrouter/vendor/model-test'), account: 'customer-openrouter-test' });
    expect(events.slice(0, 2)).toEqual([
      { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model-test' }, servedAccount: 'customer-openrouter-test' },
      { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model-test',
        response: { id: 'gen-routed-failure', modelId: 'vendor/model-test' } }, servedAccount: 'customer-openrouter-test' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(JSON.stringify(events)).not.toContain('customer-openrouter-test-key');
    expect(events.some(e => 'providerResponse' in e)).toBe(false);
  });

  it.each(['error', 'eof', 'abort'] as const)('retains maintained SDK SSE identity on %s without a completed charge', async ending => {
    const abort = new AbortController();
    let cancelled = false;
    const bytes = new TextEncoder();
    const chunk = { id: 'gen-sdk-incomplete', object: 'chat.completion.chunk', created: 1, model: 'vendor/model-test',
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] };
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (ending === 'error') controller.enqueue(bytes.encode('data: {"error":{"message":"failed","code":500}}\n\n'));
      if (ending !== 'abort') controller.close();
    }, cancel() { cancelled = true; } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    try {
      const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()) });
      const events: ModelStreamEvent[] = [];
      for await (const event of port.stream({ ...request('openrouter/vendor/model-test'), signal: abort.signal })) {
        events.push(event);
        if (ending === 'abort' && event.type === 'provider_request' && event.request.response?.id) abort.abort();
      }
      expect(events.find(e => e.type === 'provider_request' && e.request.response?.id)).toMatchObject({
        request: { response: { id: 'gen-sdk-incomplete' } }, servedAccount: 'customer-openrouter-test' });
      expect(events.at(-1)).toMatchObject(ending === 'abort' ? { type: 'stop', reason: 'aborted' } : { type: 'error' });
      expect(events.some(e => 'providerResponse' in e)).toBe(false);
      if (ending === 'abort') await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally { fetchSpy.mockRestore(); }
  });

  it('honors the explicit OpenRouter account pin without selecting another account', async () => {
    const pool = openRouterPool(openRouterAccount());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool,
      createLanguageModel: async () => model() });
    expect((await collect(port, { ...request('openrouter/vendor/model-test'), account: 'customer-openrouter-test' })).at(-1))
      .toMatchObject({ type: 'stop', servedAccount: 'customer-openrouter-test' });
    expect(pool.select).toHaveBeenCalledWith('customer-openrouter-test');
    expect(pool.active).not.toHaveBeenCalled();
  });

  it('refuses an unavailable OpenRouter account pin without pool fallback', async () => {
    const pool = openRouterPool(openRouterAccount());
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool, createLanguageModel });
    expect(await collect(port, { ...request('openrouter/vendor/model-test'), account: 'foreign-account' }))
      .toEqual([{ type: 'error', message: expect.stringContaining('account pin is unavailable') }]);
    expect(pool.active).not.toHaveBeenCalled();
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('rejects a pool returning a different account for an explicit OpenRouter pin', async () => {
    const pool = openRouterPool(openRouterAccount());
    pool.select = vi.fn(() => openRouterAccount());
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool, createLanguageModel });
    expect(await collect(port, { ...request('openrouter/vendor/model-test'), account: 'foreign-account' }))
      .toEqual([{ type: 'error', message: expect.stringContaining('account pin is unavailable') }]);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('does not disclose a failed OpenRouter token read or fall back to ambient credentials', async () => {
    const secret = 'dummy-sensitive-token-error';
    const account = { ...openRouterAccount(), token: async () => { throw new Error(secret); } };
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(account),
      env: { OPENROUTER_API_KEY: 'ambient-test-key' }, createLanguageModel });
    const events = await collect(port, request('openrouter/vendor/model-test'));
    expect(events).toEqual([{ type: 'error', message: 'failed to read OpenRouter account credentials' }]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it.each([undefined, 'customer-openrouter-test'])('does not disclose failed account selection for %s', async (account) => {
    const secret = 'dummy-sensitive-account-store-error';
    const pool = openRouterPool(openRouterAccount());
    pool.active = vi.fn(() => { throw new Error(secret); });
    pool.select = vi.fn(() => { throw new Error(secret); });
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool,
      env: { OPENROUTER_API_KEY: 'ambient-test-key' }, createLanguageModel });
    const events = await collect(port, { ...request('openrouter/vendor/model-test'), account });
    expect(events).toEqual([{ type: 'error', message: 'failed to select OpenRouter account' }]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('streams the maintained OpenRouter SDK through ModelPort with a pooled key and native wire options', async () => {
    const chunks = [
      { id: 'gen-openrouter-test', object: 'chat.completion.chunk', created: 1, model: 'vendor/model-test',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'sdk hello' }, finish_reason: null }] },
      { id: 'gen-openrouter-test', object: 'chat.completion.chunk', created: 1, model: 'vendor/model-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0125,
          cost_details: { upstream_inference_cost: 100 } } },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    try {
      const port = createRoutedModelPort({ catalog: null, openRouterAccounts: openRouterPool(openRouterAccount()) });
      const events = await collect(port, { ...request('openrouter/vendor/model-test:high'), maxTokens: 32,
        tools: [{ name: 'files:read', inputSchema: { type: 'object' } }] });
      expect(events).toContainEqual({ type: 'text_delta', text: 'sdk hello' });
      expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 2 }, servedAccount: 'customer-openrouter-test',
        providerResponse: { provider: 'openrouter', id: 'gen-openrouter-test',
          modelId: 'vendor/model-test', reportedCostUsd: 0.0125 } });
      expect(JSON.stringify(events)).not.toContain('upstreamInferenceCost');
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer customer-openrouter-test-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'vendor/model-test',
        reasoning: { effort: 'high' }, max_tokens: 32, stream: true,
        tools: [{ type: 'function', function: { name: expect.stringMatching(/^pc_files_read_[a-f0-9]{12}$/) } }] });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    { authMode: 'oauth' as const, token: async (): Promise<string> => 'oauth-test-token' },
    { authMode: undefined, token: async (): Promise<string> => 'unclassified-test-token' },
    { authMode: 'api-key' as const, token: async (): Promise<string> => '   ' },
  ])('refuses invalid OpenRouter account credentials before constructing a provider: %j', async (invalid) => {
    const createLanguageModel = vi.fn(async () => model());
    const pool = openRouterPool({ ...openRouterAccount(), ...invalid });
    const port = createRoutedModelPort({ catalog: null, openRouterAccounts: pool, createLanguageModel });
    expect(await collect(port, request('openrouter/vendor/model-test'))).toEqual([
      { type: 'error', message: expect.stringContaining('OpenRouter account') },
    ]);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('keeps bare Claude aliases on the native subscription gateway', async () => {
    const seen: ModelRequest[] = [];
    const native: ModelPort = {
      async *stream(req) {
        seen.push(req);
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog, anthropicPort: native, createLanguageModel });

    expect(await collect(port, { ...request('sonnet:xhigh'), account: 'acct-anthropic' })).toEqual([
      { type: 'stop', reason: 'end_turn' },
    ]);
    expect(seen[0].model).toBe('claude-sonnet-current');
    expect(seen[0].account).toBe('acct-anthropic');
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('routes bare OpenAI ids through the Codex subscription gateway with effort and priority', async () => {
    const calls: ProviderFactoryArgs[] = [];
    const callOptions: Parameters<LanguageModelV3['doStream']>[0][] = [];
    const port = createRoutedModelPort({
      catalog,
      gatewayBaseUrl: 'http://gateway.test/v1',
      createLanguageModel: async (args) => {
        calls.push(args);
        return model(undefined, (options) => callOptions.push(options));
      },
    });

    const events = await collect(port, {
      ...request('gpt-5.4:high'),
      account: 'acct-codex',
      maxTokens: 32,
    });
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({
      type: 'stop',
      reason: 'end_turn',
    });
    expect(calls[0]).toMatchObject({
      selection: { provider: 'gateway-codex', modelId: 'gpt-5.4', effort: 'high' },
      gatewayBaseUrl: 'http://gateway.test/v1',
    });
    expect(callOptions[0]).toMatchObject({
      headers: {
        'x-papercusp-priority': 'operator',
        'x-papercusp-account': 'acct-codex',
      },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    expect(callOptions[0]).not.toHaveProperty('maxOutputTokens');
  });

  it('uses a stored OpenAI key for explicitly provider-qualified API calls', async () => {
    const calls: ProviderFactoryArgs[] = [];
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => ({ openai_api_key: 'stored-openai-key' }),
      env: {},
      createLanguageModel: async (args) => {
        calls.push(args);
        return model();
      },
    });

    await collect(port, request('openai/gpt-5.4:high'));
    expect(calls[0]).toMatchObject({
      apiKey: 'stored-openai-key',
      selection: { provider: 'openai', modelId: 'gpt-5.4', effort: 'high' },
    });
  });

  it('fails before provider creation when an API-key provider has no credential', async () => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => ({}),
      env: {},
      createLanguageModel,
    });

    expect(await collect(port, request('google/gemini-test'))).toEqual([
      expect.objectContaining({
        type: 'error',
        message: expect.stringMatching(/GOOGLE_GENERATIVE_AI_API_KEY/),
      }),
    ]);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('surfaces credential-store failure as a ModelPort error event', async () => {
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => { throw new Error('store unavailable'); },
      env: {},
    });
    expect(await collect(port, request('openai/gpt-5.4'))).toEqual([
      {
        type: 'error',
        message: 'failed to read provider credentials: store unavailable',
      },
    ]);
  });

  const apiProviders = [
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['mistral', 'MISTRAL_API_KEY'],
    ['groq', 'GROQ_API_KEY'],
    ['xai', 'XAI_API_KEY'],
  ] as const;
  const redirectedCatalog = (provider: string): ModelsDevCatalog => ({
    [provider]: {
      env: ['UNRELATED_PROVIDER_SECRET'],
      models: { 'model-test': { id: 'model-test' } },
    },
  });

  it.each(apiProviders)('does not send a catalog-selected foreign secret to %s', async (provider, keyName) => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog: redirectedCatalog(provider),
      credentials: async () => ({}),
      env: { UNRELATED_PROVIDER_SECRET: 'foreign-test-secret' },
      createLanguageModel,
    });

    expect(await collect(port, request(`${provider}/model-test`))).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining(keyName) }),
    ]);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it.each(apiProviders)('uses the locally configured %s key despite catalog env metadata', async (provider, keyName) => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog: redirectedCatalog(provider),
      credentials: async () => ({}),
      env: { [keyName]: ' intended-test-key ', UNRELATED_PROVIDER_SECRET: 'foreign-test-secret' },
      createLanguageModel,
    });

    expect((await collect(port, request(`${provider}/model-test`))).at(-1)).toMatchObject({
      type: 'stop', reason: 'end_turn',
    });
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'intended-test-key' }));
  });

  it.each(apiProviders)('names only local credential configuration when %s has no key', async (provider, keyName) => {
    const port = createRoutedModelPort({
      catalog: redirectedCatalog(provider),
      credentials: async () => ({}),
      env: {},
    });

    const events = await collect(port, request(`${provider}/model-test`));
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining(keyName) }),
    ]);
    expect(JSON.stringify(events)).not.toContain('UNRELATED_PROVIDER_SECRET');
  });

  it('retains the local Google key alias when catalog metadata omits it', async () => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => ({}),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: '  ', GOOGLE_API_KEY: 'google-alias-test-key' },
      createLanguageModel,
    });

    expect((await collect(port, request('google/gemini-test'))).at(-1)).toMatchObject({ type: 'stop' });
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'google-alias-test-key' }));
  });

  it('keeps known subscription families working when models.dev is unavailable', async () => {
    const native: ModelPort = {
      async *stream(req) {
        yield { type: 'error', message: req.model };
      },
    };
    const port = createRoutedModelPort({
      loadCatalog: async () => { throw new Error('offline'); },
      anthropicPort: native,
    });
    expect(await collect(port, request('claude-sonnet-4-6'))).toEqual([
      { type: 'error', message: 'claude-sonnet-4-6' },
    ]);
  });
});

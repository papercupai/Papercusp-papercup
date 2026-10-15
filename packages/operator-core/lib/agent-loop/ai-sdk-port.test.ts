import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import {
  aiSdkWireToolName,
  buildAiSdkCallOptions,
  createAiSdkPort,
  effortProviderOptions,
  toAiSdkPrompt,
  type AiSdkPortModel,
} from './ai-sdk-port';
import type { ModelMessage, ModelRequest } from './model-port';

type SdkUsage = Extract<LanguageModelV3StreamPart, { type: 'finish' }>['usage'];
function sdkUsage(input: Partial<SdkUsage['inputTokens']> = {}, output: Partial<SdkUsage['outputTokens']> = {}): SdkUsage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined, ...input },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined, ...output },
  };
}

function stream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function fakeModel(
  parts: LanguageModelV3StreamPart[],
  observe?: (options: LanguageModelV3CallOptions) => void,
): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'openai.responses',
    modelId: 'gpt-5.4',
    supportedUrls: {},
    async doStream(options) {
      observe?.(options);
      return { stream: stream(parts) };
    },
    async doGenerate() {
      throw new Error('not used');
    },
  };
}

const messages: ModelMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'inspect it' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_call', id: 'call-1', name: 'files:read', input: { path: 'a.ts' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 'call-1', content: { ok: true } }],
  },
];

describe('AI SDK v6 prompt mapping', () => {
  it.each([undefined, '', ' '])('refuses a missing provider terminal reason %j even if SDK emits finish', async raw => {
    const events = [];
    const port = createAiSdkPort({ resolveModel: () => ({ provider: 'openrouter', modelId: 'vendor/model', model: fakeModel([
      { type: 'response-metadata', id: 'gen-unfinished' },
      { type: 'finish', finishReason: { unified: 'other', raw }, usage: sdkUsage() },
    ]) }) });
    for await (const event of port.stream({ model: 'm', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'OpenRouter stream ended without a provider finish reason' });
    expect(events.some(e => 'providerResponse' in e)).toBe(false);
  });
  it.each(['error', 'eof', 'throw'] as const)('preserves an early generation before a %s without inventing completion', async (ending) => {
    const model = fakeModel([]);
    model.doStream = async () => ({ stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'response-metadata', id: 'gen-early', modelId: 'vendor/model' });
        if (ending === 'error') { controller.enqueue({ type: 'error', error: new Error('failed') }); controller.close(); }
        else if (ending === 'eof') controller.close();
      },
      pull(controller) { if (ending === 'throw') controller.error(new Error('read failed')); },
    }) });
    const events = [];
    for await (const event of createAiSdkPort({ resolveModel: () => ({ model, provider: 'openrouter', modelId: 'vendor/model' }) })
      .stream({ model: 'openrouter/vendor/model', messages: [] })) events.push(event);
    expect(events.slice(0, 2)).toEqual([
      { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model' } },
      { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model',
        response: { id: 'gen-early', modelId: 'vendor/model' } } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.some(e => e.type === 'stop')).toBe(false);
    expect(events.some(e => 'providerResponse' in e)).toBe(false);
  });

  it('records dispatch intent when doStream rejects before returning an id', async () => {
    const model = fakeModel([]);
    model.doStream = async () => { throw new Error('response lost'); };
    const events = [];
    for await (const event of createAiSdkPort({ resolveModel: () => ({ model, provider: 'openrouter', modelId: 'vendor/model' }) })
      .stream({ model: 'openrouter/vendor/model', messages: [] })) events.push(event);
    expect(events).toEqual([
      { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model' } },
      { type: 'error', message: 'response lost' },
    ]);
  });

  it('retains conflicting valid generation observations and marks ambiguity without copying invalid raw values', async () => {
    const events = [];
    const port = createAiSdkPort({ resolveModel: () => ({ provider: 'openrouter', modelId: 'vendor/model', model: fakeModel([
      { type: 'response-metadata', id: 'gen-first' },
      { type: 'response-metadata', id: 'gen-first' },
      { type: 'response-metadata', id: 'gen-second' },
      { type: 'response-metadata', id: 'secret\ninvalid' },
      { type: 'error', error: 'failed' },
    ]) }) });
    for await (const event of port.stream({ model: 'openrouter/vendor/model', messages: [] })) events.push(event);
    expect(events.filter(e => e.type === 'provider_request').map(e => e.request)).toEqual([
      { provider: 'openrouter', modelId: 'vendor/model' },
      { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-first' } },
      { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-second' }, identityUncertain: true },
      { provider: 'openrouter', modelId: 'vendor/model', identityUncertain: true },
    ]);
    expect(JSON.stringify(events.filter(e => e.type === 'provider_request'))).not.toContain('secret');
  });

  it('cancels a stalled reader on abort and retains the generation already emitted', async () => {
    const abort = new AbortController();
    let cancelled = 0;
    const model = fakeModel([]);
    model.doStream = async () => ({ stream: new ReadableStream({
      start(controller) { controller.enqueue({ type: 'response-metadata', id: 'gen-aborted' }); },
      cancel() { cancelled++; },
    }) });
    const events = [];
    for await (const event of createAiSdkPort({ resolveModel: () => ({ model, provider: 'openrouter', modelId: 'vendor/model' }) })
      .stream({ model: 'openrouter/vendor/model', messages: [], signal: abort.signal })) {
      events.push(event);
      if (event.type === 'provider_request' && event.request.response?.id) abort.abort();
    }
    expect(cancelled).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'aborted' });
    expect(events.some(e => 'providerResponse' in e)).toBe(false);
  });

  it('cancels transport when the consumer returns after an early generation', async () => {
    let cancelled = 0;
    const model = fakeModel([]);
    model.doStream = async () => ({ stream: new ReadableStream({
      start(controller) { controller.enqueue({ type: 'response-metadata', id: 'gen-returned' }); },
      cancel() { cancelled++; },
    }) });
    const iterator = createAiSdkPort({ resolveModel: () => ({ model, provider: 'openrouter', modelId: 'vendor/model' }) })
      .stream({ model: 'openrouter/vendor/model', messages: [] })[Symbol.asyncIterator]();
    await iterator.next(); await iterator.next(); await iterator.return?.();
    expect(cancelled).toBe(1);
  });

  it('does not dispatch a pre-aborted request', async () => {
    const abort = new AbortController(); abort.abort();
    let dispatched = false;
    const events = [];
    for await (const event of createAiSdkPort({ resolveModel: () => ({ provider: 'openrouter', modelId: 'vendor/model',
      model: fakeModel([], () => { dispatched = true; }) }) }).stream({ model: 'm', messages: [], signal: abort.signal })) events.push(event);
    expect(events).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(dispatched).toBe(false);
  });
  it('keeps provider types behind ModelPort and preserves tool correlation', () => {
    expect(toAiSdkPrompt('system', messages)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'inspect it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'files:read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'files:read',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ]);
  });

  it('maps effort onto each provider native option without changing the public spec', () => {
    expect(effortProviderOptions('openai', 'xhigh')).toEqual({ openai: { reasoningEffort: 'xhigh' } });
    expect(effortProviderOptions('anthropic', 'high')).toEqual({ anthropic: { effort: 'high' } });
    expect(effortProviderOptions('openrouter', 'high')).toEqual({
      openrouter: { provider: { zdr: true }, reasoning: { effort: 'high' } },
    });
    expect(effortProviderOptions('google', 'medium')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'medium' } },
    });
  });

  it('encodes namespaced projected-tool names into stable provider-safe aliases', () => {
    const encoded = aiSdkWireToolName('capability:read');
    expect(encoded).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(encoded).not.toBe('capability:read');
    expect(aiSdkWireToolName('capability:read')).toBe(encoded);
    expect(aiSdkWireToolName('capability_read')).toBe('capability_read');
    expect(aiSdkWireToolName('capability:write')).not.toBe(encoded);
  });

  it('builds tools, abort, headers, and effort on the provider-spec call', () => {
    const signal = new AbortController().signal;
    const req: ModelRequest = {
      model: 'openai/gpt-5.4:high',
      system: 'system',
      messages,
      tools: [{ name: 'files:read', inputSchema: { type: 'object' } }],
      maxTokens: 123,
      signal,
    };
    expect(buildAiSdkCallOptions(req, {
      model: fakeModel([]),
      provider: 'openai',
      modelId: 'gpt-5.4',
      effort: 'high',
      headers: { 'x-test': 'yes' },
    })).toMatchObject({
      maxOutputTokens: 123,
      abortSignal: signal,
      headers: { 'x-test': 'yes' },
      providerOptions: { openai: { reasoningEffort: 'high' } },
      tools: [{
        type: 'function',
        name: aiSdkWireToolName('files:read'),
        inputSchema: { type: 'object' },
      }],
      toolChoice: { type: 'auto' },
    });
  });
});

describe('OpenRouter request privacy', () => {
  it.each([
    { modelId: 'qwen/qwen3-coder', effort: undefined },
    { modelId: 'anthropic/claude-sonnet-4.6', effort: 'high' },
  ])('requires ZDR on the SDK wire for $modelId without relying on account defaults', async ({ modelId, effort }) => {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
    const bodies: Record<string, unknown>[] = [];
    const model = createOpenRouter({
      apiKey: 'test-openrouter-key',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const chunks = [
          { id: 'gen-zdr-test', model: modelId, created: 1,
            choices: [{ index: 0, delta: { content: 'accepted' }, finish_reason: null }] },
          { id: 'gen-zdr-test', model: modelId, created: 1,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      },
    }).chat(modelId, { provider: { zdr: false } });
    const port = createAiSdkPort({ resolveModel: () => ({ provider: 'openrouter', modelId, effort, model }) });
    const events = [];
    for await (const event of port.stream({ model: `openrouter/${modelId}`, messages: [
      { role: 'user', content: [{ type: 'text', text: 'inspect this fixture repository' }] },
    ] })) events.push(event);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: modelId, stream: true, provider: { zdr: true } });
    if (effort) expect(bodies[0]).toMatchObject({ reasoning: { effort } });
    else expect(bodies[0]).not.toHaveProperty('reasoning');
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end_turn' });
  });

  it('surfaces an unavailable ZDR endpoint without relaxing privacy or changing the model', async () => {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
    const bodies: Record<string, unknown>[] = [];
    const modelId = 'qwen/qwen3-coder';
    const model = createOpenRouter({ apiKey: 'test-openrouter-key', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { code: 404, message: 'No eligible ZDR endpoint' } }),
        { status: 404, headers: { 'content-type': 'application/json' } });
    } }).chat(modelId);
    const port = createAiSdkPort({ resolveModel: () => ({ provider: 'openrouter', modelId, model }) });
    const events = [];
    for await (const event of port.stream({ model: `openrouter/${modelId}`, messages: [] })) events.push(event);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: modelId, provider: { zdr: true } });
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('No eligible ZDR endpoint') });
    expect(events.some(event => event.type === 'stop')).toBe(false);
  });
});

describe('createAiSdkPort', () => {
  async function estimatedUsage(
    input: Partial<SdkUsage['inputTokens']>,
    resolved: Omit<AiSdkPortModel, 'model'>,
  ) {
    const port = createAiSdkPort({ resolveModel: () => ({ ...resolved, model: fakeModel([
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: sdkUsage(input, { total: 100_000, text: 80_000, reasoning: 20_000 }) },
    ]) }) });
    const events = [];
    for await (const event of port.stream({ model: resolved.modelId, messages: [] })) events.push(event);
    const stop = events.at(-1);
    if (stop?.type !== 'stop') throw new Error('missing stop');
    return stop.usage;
  }

  const scoped = (price: NonNullable<AiSdkPortModel['pricing']>['price']) => ({
    provider: 'openrouter' as const, modelId: 'openai/gpt-5.5:free',
    pricing: { provider: 'openrouter' as const, modelId: 'openai/gpt-5.5:free', price },
  });

  it('does not borrow a direct-provider price for an OpenRouter model', async () => {
    expect(await estimatedUsage({ total: 10, cacheRead: 0, cacheWrite: 0 }, {
      provider: 'openrouter', modelId: 'openai/gpt-5.5:free',
    })).not.toHaveProperty('costUsd');
  });

  it('retains an exact free variant price instead of its paid base', async () => {
    expect(await estimatedUsage({ total: 10, cacheRead: 0, cacheWrite: 0 }, scoped({ in: 0, out: 0 })))
      .toHaveProperty('costUsd', 0);
  });

  it('subtracts cache reads AND writes from total even when OpenRouter SDK noCache includes writes', async () => {
    const u = await estimatedUsage({ total: 1_000_000, noCache: 800_000,
      cacheRead: 200_000, cacheWrite: 100_000 }, scoped({ in: 2, out: 3, cacheRead: 0.5, cacheWrite: 4 }));
    expect(u).toMatchObject({ inputTokens: 1_000_000, cacheReadTokens: 200_000, cacheCreationTokens: 100_000 });
    expect(u?.costUsd).toBeCloseTo(2.2);
  });

  it('uses cache-inclusive request size for long-context tier selection', async () => {
    const u = await estimatedUsage({ total: 250_000, noCache: 50_000, cacheRead: 200_000, cacheWrite: 0 },
      scoped({ in: 2, out: 3, cacheRead: 0.5,
        longContext: { above: 200_000, inputMultiplier: 2, outputMultiplier: 1.5 } }));
    expect(u?.costUsd).toBeCloseTo(0.85);
  });

  it('includes writes in public input total when only uncached components are reported', async () => {
    const u = await estimatedUsage({ noCache: 100, cacheRead: 20, cacheWrite: 30 }, {
      provider: 'openai', modelId: 'gpt-5.5',
    });
    expect(u?.inputTokens).toBe(150);
  });

  it.each([
    { total: 10, cacheRead: 11, cacheWrite: 0 },
    { total: 10, cacheRead: -1, cacheWrite: 0 },
    { total: 10, cacheRead: 0 },
    { total: 10, cacheWrite: 0 },
    { total: Infinity, cacheRead: 0, cacheWrite: 0 },
    { total: 10.5, cacheRead: 0, cacheWrite: 0 },
    {},
  ])('keeps unreconciled or incomplete cache usage unpriced: %j', async (input) => {
    expect(await estimatedUsage(input, scoped({ in: 2, out: 3, cacheRead: 0.5, cacheWrite: 4 })))
      .not.toHaveProperty('costUsd');
  });

  it('refuses a scoped price bound to a different model id', async () => {
    const resolved = scoped({ in: 2, out: 3 });
    resolved.pricing.modelId = 'openai/gpt-5.5';
    expect(await estimatedUsage({ total: 10, cacheRead: 0, cacheWrite: 0 }, resolved))
      .not.toHaveProperty('costUsd');
  });

  it('retains direct-provider cache pricing with uncached input and a full request discriminator', async () => {
    const u = await estimatedUsage({ total: 1_000_000, noCache: 700_000, cacheRead: 200_000, cacheWrite: 100_000 }, {
      provider: 'openai', modelId: 'gpt-5.5',
    });
    // gpt-5.5 table: $2.50/$20, cached read $0.25/write $2.50 per million.
    expect(u?.costUsd).toBeCloseTo(4.05);
  });

  it('refuses a contradictory direct-provider noCache count', async () => {
    expect(await estimatedUsage({ total: 100, noCache: 100, cacheRead: 10, cacheWrite: 0 }, {
      provider: 'openai', modelId: 'gpt-5.5',
    })).not.toHaveProperty('costUsd');
  });

  it('reconstructs OpenRouter total without double-counting SDK noCache writes', async () => {
    const u = await estimatedUsage({ noCache: 800_000, cacheRead: 200_000, cacheWrite: 100_000 },
      scoped({ in: 2, out: 3, cacheRead: 0.5, cacheWrite: 4 }));
    expect(u?.inputTokens).toBe(1_000_000);
    expect(u?.costUsd).toBeCloseTo(2.2);
  });

  it('does not apply the requested model price to a different served model', async () => {
    const port = createAiSdkPort({ resolveModel: () => ({ ...scoped({ in: 2, out: 3 }), model: fakeModel([
      { type: 'response-metadata', id: 'gen-different-served-model', modelId: 'vendor/other-model' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: sdkUsage({ total: 10, cacheRead: 0, cacheWrite: 0 }, { total: 4 }),
        providerMetadata: { openrouter: { usage: { cost: 1.25 } } } },
    ]) }) });
    const events = [];
    for await (const event of port.stream({ model: 'openrouter/openai/gpt-5.5:free', messages: [] })) events.push(event);
    const stop = events.at(-1);
    if (stop?.type !== 'stop') throw new Error('missing stop');
    expect(stop.usage).not.toHaveProperty('costUsd');
    expect(stop.providerResponse).toMatchObject({ modelId: 'vendor/other-model', reportedCostUsd: 1.25 });
  });

  it('preserves OpenRouter generation and reported charge separately from token pricing', async () => {
    const port = createAiSdkPort({ resolveModel: () => ({
      model: fakeModel([
        { type: 'response-metadata', id: 'gen-reported-1' },
        { type: 'response-metadata', modelId: 'vendor/served-model' },
        { type: 'response-metadata', id: 'gen-reported-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
          usage: sdkUsage({ total: 10 }, { total: 4 }),
          providerMetadata: { openrouter: { usage: { cost: 0.00000001,
            costDetails: { upstreamInferenceCost: 50 } }, secret: 'never-copy-this' } } },
      ]), provider: 'openrouter', modelId: 'gpt-5.4',
    }) });
    const events = [];
    for await (const event of port.stream({ model: 'openrouter/vendor/model', messages: [] })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'stop', providerResponse: {
      provider: 'openrouter', id: 'gen-reported-1', modelId: 'vendor/served-model', reportedCostUsd: 0.00000001,
    } });
    expect(JSON.stringify(events)).not.toContain('never-copy-this');
    expect(JSON.stringify(events)).not.toContain('upstreamInferenceCost');
    const stop = events.at(-1);
    expect(stop?.type === 'stop' && stop.usage?.costUsd).not.toBe(0.00000001);
  });

  it.each([0, 0.25])('retains a valid reported charge %s without inventing an id', async (cost) => {
    const port = createAiSdkPort({ resolveModel: () => ({ model: fakeModel([
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: sdkUsage(), providerMetadata: { openrouter: { usage: { cost } } } },
    ]), provider: 'openrouter', modelId: 'vendor/unpriced-model' }) });
    const events = [];
    for await (const event of port.stream({ model: 'openrouter/vendor/unpriced-model', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 },
      providerResponse: { provider: 'openrouter', reportedCostUsd: cost } });
  });

  it.each([undefined, null, '0.25', -1, Number.NaN, Number.POSITIVE_INFINITY, 1e20])(
    'does not invent a provider charge from invalid or missing metadata %s', async (cost) => {
      const port = createAiSdkPort({ resolveModel: () => ({ model: fakeModel([
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
          usage: sdkUsage(),
          providerMetadata: { openrouter: { usage: { cost: cost as never } } } },
      ]), provider: 'openrouter', modelId: 'vendor/unpriced-model' }) });
      const events = [];
      for await (const event of port.stream({ model: 'openrouter/vendor/unpriced-model', messages: [] })) events.push(event);
      expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });
    },
  );

  it.each([
    { ids: ['gen-first', 'gen-different'] }, { ids: ['gen-first', '../secret'] },
    { ids: ['../secret', 'gen-later'] }, { ids: ['gen-first', ''] }, { ids: ['gen-' + 'a'.repeat(125)] },
  ])('omits an invalid or ambiguous generation sequence $ids', async ({ ids }) => {
    const port = createAiSdkPort({ resolveModel: () => ({ model: fakeModel([
      ...ids.map((id) => ({ type: 'response-metadata' as const, id })),
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: sdkUsage() },
    ]), provider: 'openrouter', modelId: 'vendor/unpriced-model' }) });
    const events = [];
    for await (const event of port.stream({ model: 'openrouter/vendor/unpriced-model', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it.each([
    { models: ['vendor/first', 'vendor/different'] }, { models: ['vendor/valid', ' bad-model'] },
    { models: ['bad\nmodel', 'vendor/later'] }, { models: ['vendor/' + 'a'.repeat(256)] },
  ])('omits an invalid or ambiguous served model $models while retaining the generation', async ({ models }) => {
    const port = createAiSdkPort({ resolveModel: () => ({ model: fakeModel([
      { type: 'response-metadata', id: 'gen-valid' },
      ...models.map((modelId) => ({ type: 'response-metadata' as const, modelId })),
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: sdkUsage() },
    ]), provider: 'openrouter', modelId: 'vendor/unpriced-model' }) });
    const events = [];
    for await (const event of port.stream({ model: 'openrouter/vendor/unpriced-model', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 },
      providerResponse: { provider: 'openrouter', id: 'gen-valid' } });
  });

  it('does not turn an incomplete generation into a completed provider report', async () => {
    const port = createAiSdkPort({ resolveModel: () => ({ model: fakeModel([
      { type: 'response-metadata', id: 'gen-incomplete', modelId: 'vendor/model' },
      { type: 'error', error: new Error('transport failed') },
    ]), provider: 'openrouter', modelId: 'vendor/unpriced-model' }) });
    const events = [];
    for await (const event of port.stream({ model: 'openrouter/vendor/unpriced-model', messages: [] })) events.push(event);
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ type: 'provider_request', request: { provider: 'openrouter',
      modelId: 'vendor/unpriced-model', response: { id: 'gen-incomplete', modelId: 'vendor/model' } } });
    expect(events[2]).toMatchObject({ type: 'error', message: 'transport failed' });
    expect(events.every(e => !('providerResponse' in e))).toBe(true);
  });

  it('retains early identity but refuses completion when SDK reports an error finish', async () => {
    const events = [];
    const port = createAiSdkPort({ resolveModel: () => ({ provider: 'openrouter', modelId: 'vendor/model', model: fakeModel([
      { type: 'response-metadata', id: 'gen-error-finish' },
      { type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage: sdkUsage({ total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, { total: 1 }),
        providerMetadata: { openrouter: { usage: { cost: 1 } } } },
    ]) }) });
    for await (const event of port.stream({ model: 'm', messages: [] })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(events.some(e => 'providerResponse' in e || 'usage' in e)).toBe(false);
    expect(events.find(e => e.type === 'provider_request' && e.request.response?.id)).toMatchObject({ request: { response: { id: 'gen-error-finish' } } });
  });

  it('ignores OpenRouter-shaped metadata returned on another provider route', async () => {
    const port = createAiSdkPort({ resolveModel: () => ({ model: fakeModel([
      { type: 'response-metadata', id: 'gen-wrong-route', modelId: 'vendor/model' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: sdkUsage(), providerMetadata: { openrouter: { usage: { cost: 0.25 } } } },
    ]), provider: 'openai', modelId: 'unpriced-model' }) });
    const events = [];
    for await (const event of port.stream({ model: 'openai/unpriced-model', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('maps v3 text/reasoning/tool/finish stream parts onto ModelStreamEvent', async () => {
    let observed: LanguageModelV3CallOptions | null = null;
    const model = fakeModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'reasoning-delta', id: 'reason-1', delta: 'think' },
      {
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: aiSdkWireToolName('files:read'),
        input: '{"path":"b.ts"}',
      },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 1 },
          outputTokens: { total: 4, text: 3, reasoning: 1 },
        },
      },
    ], (options) => { observed = options; });
    const port = createAiSdkPort({
      resolveModel: () => ({ model, provider: 'openai', modelId: 'gpt-5.4', effort: 'high' }),
    });

    const events = [];
    for await (const event of port.stream({
      model: 'openai/gpt-5.4:high',
      messages,
      tools: [{ name: 'files:read', inputSchema: { type: 'object' } }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'reasoning_delta', text: 'think' },
      { type: 'tool_call', id: 'call-2', name: 'files:read', input: { path: 'b.ts' } },
      expect.objectContaining({
        type: 'stop',
        reason: 'tool_use',
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
        }),
      }),
    ]);
    expect(observed).toMatchObject({ providerOptions: { openai: { reasoningEffort: 'high' } } });
    expect(observed).toMatchObject({
      tools: [{ name: aiSdkWireToolName('files:read') }],
    });
  });

  it('surfaces a truncated provider stream as an error instead of inventing a stop', async () => {
    const port = createAiSdkPort({
      resolveModel: () => ({
        model: fakeModel([{ type: 'text-delta', id: 't', delta: 'partial' }]),
        provider: 'openai',
        modelId: 'gpt-5.4',
      }),
    });
    const events = [];
    for await (const event of port.stream({ model: 'openai/gpt-5.4', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'AI SDK provider stream ended without a finish event',
    });
  });
});

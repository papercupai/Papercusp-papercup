import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLoopModelSpec,
  curateOpenRouterCatalog,
  loadModelsDevCatalog,
  resetModelsDevCatalogCache,
  resolveLoopModelSpec,
  type ModelsDevCatalog,
} from './model-selection';

const catalog: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    npm: '@ai-sdk/anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-sonnet-old': {
        id: 'claude-sonnet-old',
        family: 'claude-sonnet',
        release_date: '2025-01-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      'claude-sonnet-new': {
        id: 'claude-sonnet-new',
        family: 'claude-sonnet',
        release_date: '2026-08-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  openai: {
    id: 'openai',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-test': {
        id: 'gpt-test',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
  google: {
    id: 'google',
    npm: '@ai-sdk/google',
    env: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    models: {
      'gemini-test': {
        id: 'gemini-test',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
};

afterEach(() => {
  resetModelsDevCatalogCache();
  vi.restoreAllMocks();
});

describe('resolveLoopModelSpec', () => {
  it('resolves psu Claude aliases to the newest models.dev family member and preserves effort', () => {
    expect(resolveLoopModelSpec('sonnet[1m]:xhigh', catalog)).toMatchObject({
      modelId: 'claude-sonnet-new',
      effort: 'xhigh',
      provider: 'gateway-anthropic',
    });
  });

  it('maps psu Codex aliases onto the subscription gateway', () => {
    expect(resolveLoopModelSpec('terra:max', catalog)).toMatchObject({
      modelId: 'gpt-5.6-terra',
      effort: 'max',
      provider: 'gateway-codex',
    });
  });

  it('uses explicit AI SDK providers for API-key models', () => {
    expect(resolveLoopModelSpec('google/gemini-test:high', catalog)).toMatchObject({
      modelId: 'gemini-test',
      effort: 'high',
      provider: 'google',
    });
  });

  it('preserves the nested OpenRouter model id and effort without requiring a catalog', () => {
    expect(resolveLoopModelSpec('openrouter/vendor/model-v2:high', null)).toMatchObject({
      provider: 'openrouter', modelId: 'vendor/model-v2', effort: 'high', metadata: null,
    });
  });

  it('only peels a recognized effort suffix, preserving colon-bearing model ids', () => {
    expect(resolveLoopModelSpec('openai/vendor:model-v2:0', catalog)).toMatchObject({
      modelId: 'vendor:model-v2:0',
      effort: null,
      provider: 'openai',
    });
  });

  it('refuses an unsupported effort instead of silently lowering it', () => {
    expect(() => resolveLoopModelSpec('openai/gpt-test:max', catalog)).toThrow(
      /allowed effort values: low\|high.*Refusing to silently lower/s,
    );
  });

  it('fails closed for an unknown unqualified provider id', () => {
    expect(() => resolveLoopModelSpec('mystery-model', null)).toThrow(/use <provider>\/<model>/);
  });
});

describe('classifyLoopModelSpec', () => {
  it('marks subscription gateway and AI SDK provider specs executable without a catalog', () => {
    expect(classifyLoopModelSpec('sonnet[1m]:high')).toEqual({
      executable: true,
      provider: 'gateway-anthropic',
    });
    expect(classifyLoopModelSpec('openai/gpt-5.4:max')).toEqual({
      executable: true,
      provider: 'openai',
    });
  });

  it('marks OpenRouter syntax executable without choosing an account or model default', () => {
    expect(classifyLoopModelSpec('openrouter/stealth/ox-alpha:max')).toEqual({
      executable: true,
      provider: 'openrouter',
    });
  });

  it('fails closed for unknown bare ids instead of guessing a provider', () => {
    const capability = classifyLoopModelSpec('mystery-model');
    expect(capability.executable).toBe(false);
    if (!capability.executable) expect(capability.reason).toMatch(/use <provider>\/\<model>/);
  });
});

describe('loadModelsDevCatalog', () => {
  it('deduplicates concurrent fetches and caches the validated object', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    const [a, b] = await Promise.all([
      loadModelsDevCatalog({ fetchImpl, now: () => 1 }),
      loadModelsDevCatalog({ fetchImpl, now: () => 1 }),
    ]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await loadModelsDevCatalog({ fetchImpl, now: () => 2 })).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }));
    await expect(loadModelsDevCatalog({ fetchImpl, now: () => 1 })).rejects.toThrow(/HTTP 503/);
    await expect(loadModelsDevCatalog({ fetchImpl, now: () => 2 })).resolves.toEqual(catalog);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('curateOpenRouterCatalog', () => {
  const row = () => ({
    id: 'vendor/nested/model:free', name: 'Selected model',
    supported_parameters: ['tools', 'temperature', 'reasoning'],
    reasoning: { supported_efforts: ['low', 'high', 'max'] },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    context_length: 200_000,
    top_provider: { context_length: 128_000, max_completion_tokens: 32_000 },
    pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002',
      input_cache_write: '0.0000025', request: '0', web_search: '0.01' },
    env: ['UNRELATED_SECRET'], apiKey: 'must-not-copy', description: 'untrusted prose',
  });
  const selected = ['vendor/nested/model:free'];
  const curate = (r: unknown = row()) => curateOpenRouterCatalog({ data: [r] }, selected, 123);

  it('projects only explicitly selected exact ids into the existing catalog', () => {
    const r = curateOpenRouterCatalog({ data: [row(), { id: 'other/model', apiKey: 'secret' }],
      total_count: 900, links: { next: 'https://untrusted.example/next' } }, selected, 123);
    expect(Object.keys(r.openrouter.models)).toEqual(selected);
    expect(r.openrouter.env).toBeUndefined();
    expect(r.openrouter.models[selected[0]]).toMatchObject({
      id: selected[0], tool_call: true, temperature: true, reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 128_000, output: 32_000 },
      cost: { input: 2, output: 10, cache_write: 2.5 },
      pricing: { source: 'openrouter-models', observedAtMs: 123, conditional: false,
        rates: { prompt: '0.000002', request: '0', web_search: '0.01' } },
    });
    expect(r.openrouter.models[selected[0]].cost?.cache_read).toBeCloseTo(0.2, 14);
    const encoded = JSON.stringify(r);
    for (const value of ['UNRELATED_SECRET', 'must-not-copy', 'untrusted prose', 'untrusted.example']) {
      expect(encoded).not.toContain(value);
    }
    expect(resolveLoopModelSpec('openrouter/vendor/nested/model:free:max', r)).toMatchObject({
      provider: 'openrouter', modelId: selected[0], effort: 'max',
    });
    expect(() => resolveLoopModelSpec('openrouter/vendor/nested/model:free:xhigh', r))
      .toThrow(/allowed effort values: low\|high\|max/);
  });

  it('requires every selected model even when the supplied body is only one page', () => {
    expect(() => curateOpenRouterCatalog({ data: [row()], total_count: 900,
      links: { next: '/api/v1/models?offset=1' } }, [...selected, 'other/model'], 123))
      .toThrow(/selected model is missing/);
  });

  it('refuses duplicate selected rows and does not normalize a paid variant onto a free id', () => {
    expect(() => curateOpenRouterCatalog({ data: [row(), row()] }, selected, 123)).toThrow(/duplicate/);
    expect(() => curateOpenRouterCatalog({ data: [row()] }, ['vendor/nested/model'], 123))
      .toThrow(/selected model is missing/);
  });

  it('does not invent per-model efforts from reasoning support alone', () => {
    const model = curate({ ...row(), reasoning: { mandatory: true, default_effort: 'high' } })
      .openrouter.models[selected[0]];
    expect(model.reasoning).toBe(true);
    expect(model.reasoning_options).toBeUndefined();
  });

  it('distinguishes explicit absent support from missing or malformed capability metadata', () => {
    expect(curate({ ...row(), supported_parameters: [] }).openrouter.models[selected[0]])
      .toMatchObject({ tool_call: false, temperature: false, reasoning: false });
    for (const supported_parameters of [undefined, null, ['tools', 1], 'tools']) {
      const model = curate({ ...row(), supported_parameters, reasoning: undefined })
        .openrouter.models[selected[0]];
      expect(model.tool_call).toBeUndefined();
      expect(model.temperature).toBeUndefined();
      expect(model.reasoning).toBeUndefined();
    }
  });

  it('retains conditional and additional rates without pretending they are all-in token prices', () => {
    const r = curate({ ...row(), pricing: { prompt: '0.000002', completion: '0.00001',
      web_search: '0.01', input_cache_write_1h: '0.000004',
      overrides: [{ min_prompt_tokens: 272_000, prompt: '0.000004' }], future_unit: '1' } });
    expect(r.openrouter.models[selected[0]].pricing).toMatchObject({
      conditional: true, unrecognizedFields: true,
      rates: { input_cache_write_1h: '0.000004', web_search: '0.01' },
    });
    expect(r.openrouter.models[selected[0]].cost).toEqual({ input: 2, output: 10 });
  });

  it.each([
    { rate: '-1' }, { rate: '' }, { rate: ' ' }, { rate: 'NaN' }, { rate: 'Infinity' },
    { rate: '1e400' }, { rate: '0x10' }, { rate: null }, { rate: true }, { rate: 0 },
    { rate: '9007199254740992' }, { rate: '1e-400' },
  ])('keeps invalid or unavailable prices unknown ($rate)', ({ rate }) => {
    const model = curate({ ...row(), pricing: { prompt: rate, completion: '0' } })
      .openrouter.models[selected[0]];
    expect(model.cost?.input).toBeUndefined();
    expect(model.cost?.output).toBe(0);
    expect(model.pricing?.rates.prompt).toBeUndefined();
    expect(model.pricing?.unpricedFields).toContain('prompt');
    expect(model.cost?.cache_read).toBeUndefined();
    expect(model.cost?.cache_write).toBeUndefined();
  });

  it('keeps real zero and submicro rates, with no inferred cache discounts', () => {
    const model = curate({ ...row(), pricing: { prompt: '0', completion: '1e-9' } })
      .openrouter.models[selected[0]];
    expect(model.cost).toEqual({ input: 0, output: 0.001 });
    expect(model.pricing?.rates).toEqual({ prompt: '0', completion: '1e-9' });
  });

  it.each([{ body: null }, { body: [] }, { body: {} }, { body: { data: {} } }])
    ('refuses a malformed page ($body)', ({ body }) => {
      expect(() => curateOpenRouterCatalog(body, selected, 123)).toThrow(/catalog data/);
    });

  it.each([{ timestamp: NaN }, { timestamp: -1 }, { timestamp: Infinity }, { timestamp: 1.5 }])
    ('requires a measured integer observation time ($timestamp)', ({ timestamp }) => {
      expect(() => curateOpenRouterCatalog({ data: [row()] }, selected, timestamp)).toThrow(/observation time/);
    });

  it('refuses invalid or duplicate selections and permits an explicitly empty candidate set', () => {
    expect(() => curateOpenRouterCatalog({ data: [row()] }, ['invalid model'], 123)).toThrow(/selection/);
    expect(() => curateOpenRouterCatalog({ data: [row()] }, [...selected, ...selected], 123)).toThrow(/selection/);
    expect(curateOpenRouterCatalog({ data: [row()] }, [], 123).openrouter.models).toEqual({});
  });

  it('does not mutate input rows or alias mutable metadata into the snapshot', () => {
    const r = row();
    const original = JSON.stringify(r);
    const model = curate(r).openrouter.models[selected[0]];
    model.modalities!.input!.push('audio');
    model.reasoning_options![0].values!.push('xhigh');
    model.supported_parameters!.push('seed');
    model.pricing!.rates.prompt = '50';
    expect(JSON.stringify(r)).toBe(original);
  });

  it('keeps unreported limits/modalities and a missing price table unknown', () => {
    const model = curate({ id: selected[0], context_length: 0, top_provider: {
      context_length: Infinity, max_completion_tokens: -1 } }).openrouter.models[selected[0]];
    expect(model.limit).toBeUndefined();
    expect(model.modalities).toBeUndefined();
    expect(model.cost).toBeUndefined();
    expect(model.pricing).toMatchObject({ rates: {}, unpricedFields: ['prompt', 'completion'] });
  });
});

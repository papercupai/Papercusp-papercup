import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const embed = vi.fn(async () => [1, 2, 3]);
  return {
    embed,
    configureMemory: vi.fn(),
    getHarnessAdminUrl: vi.fn(() => 'postgres://bench-host'),
    buildLocalEmbedder: vi.fn(async () => embed),
    buildGemmaEmbedder: vi.fn(() => embed),
    buildHarrierEmbedder: vi.fn(() => embed),
    buildSidecarFirstEmbedder: vi.fn((options: { fallback: () => unknown }) => options.fallback()),
  };
});

vi.mock('@papercusp/memory', () => ({
  buildLocalEmbedder: mocks.buildLocalEmbedder,
  buildGemmaEmbedder: mocks.buildGemmaEmbedder,
  buildHarrierEmbedder: mocks.buildHarrierEmbedder,
  buildSidecarFirstEmbedder: mocks.buildSidecarFirstEmbedder,
  configureMemory: mocks.configureMemory,
  EMBEDDER_DIM_SPECS: {
    openai: { targetDims: 1536 },
    local: { targetDims: 384 },
    gemma: { targetDims: 768 },
    harrier: { targetDims: 768 },
  },
}));
vi.mock('../../embedded-pg-discovery', () => ({ getHarnessAdminUrl: mocks.getHarnessAdminUrl }));

import {
  configurePrecisionBenchMemoryHost,
  createPrecisionBenchMemoryHost,
  PRECISION_BENCH_EMBEDDER_MODE_ENV,
} from './precision-bench-host';

describe('precision bench host bootstrap', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('builds the resolved embedder from host-free primitives and reads credentials from the worker env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-test');
    const host = createPrecisionBenchMemoryHost('gemma');
    expect(host.schema).toBe('harness_shared');
    expect(host.defaultDbName).toBe('papercusp');
    expect(host.localStoreDir).toBeNull();
    expect(host.backend).toBe('mem0');
    expect(host.getAdminUrl()).toBe('postgres://bench-host');
    expect(await host.getCredentials()).toEqual({
      openai_api_key: 'openai-test',
      anthropic_api_key: 'anthropic-test',
    });
    expect(await host.resolveEmbedder()).toMatchObject({
      mode: 'gemma',
      dims: 768,
      profile: { targetDims: 768 },
      embed: mocks.embed,
    });
    expect(mocks.buildSidecarFirstEmbedder).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemma', kind: 'document' }));
    expect(mocks.buildGemmaEmbedder).toHaveBeenCalledWith({ kind: 'document' });
    expect(await host.buildEmbedderForMode('local')).toBe(mocks.embed);
    expect(mocks.buildLocalEmbedder).toHaveBeenCalledOnce();
  });

  it('installs the host only when the child received the resolved mode', () => {
    configurePrecisionBenchMemoryHost('local');
    expect(mocks.configureMemory).toHaveBeenCalledWith(expect.objectContaining({ schema: 'harness_shared' }));
    expect(() => configurePrecisionBenchMemoryHost(undefined)).toThrow(PRECISION_BENCH_EMBEDDER_MODE_ENV);
    expect(() => createPrecisionBenchMemoryHost('auto')).toThrow(/resolved embedder mode/);
  });
});

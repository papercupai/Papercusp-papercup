import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aggregateByClass: vi.fn(),
  latencyStats: vi.fn(),
  runGoldSet: vi.fn(),
  seedCorpus: vi.fn(),
  seedFailureReason: vi.fn(),
  pushSearchFloors: vi.fn(),
  loadCorpusFixture: vi.fn(),
  loadGoldSetFixture: vi.fn(),
  makeHybridBackendCtx: vi.fn(),
}));

vi.mock('@papercusp/memory/bench', () => ({
  aggregateByClass: mocks.aggregateByClass,
  latencyStats: mocks.latencyStats,
  runGoldSet: mocks.runGoldSet,
  seedCorpus: mocks.seedCorpus,
  seedFailureReason: mocks.seedFailureReason,
}));
vi.mock('../push-search-floors', () => ({ pushSearchFloors: mocks.pushSearchFloors }));
vi.mock('./corpus', () => ({ loadCorpusFixture: mocks.loadCorpusFixture }));
vi.mock('./gold-set', () => ({ loadGoldSetFixture: mocks.loadGoldSetFixture }));
vi.mock('./precision-hybrid-backend', () => ({
  BENCH_SCOPE: 'bench',
  makeHybridBackendCtx: mocks.makeHybridBackendCtx,
}));

import { benchMemoryPrecision, type PrecisionBenchProgress } from './precision-bench-core';

describe('benchMemoryPrecision progress', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadCorpusFixture.mockReturnValue([{ id: 'fresh-seed' }]);
    mocks.loadGoldSetFixture.mockReturnValue({ version: 'gold-v1', queries: [{ id: 'q1', query: 'query' }] });
    mocks.makeHybridBackendCtx.mockResolvedValue({
      backend: { name: 'hybrid' },
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    mocks.seedCorpus.mockResolvedValue({});
    mocks.seedFailureReason.mockReturnValue(null);
    mocks.pushSearchFloors.mockReturnValue({ minScore: 0.45, minLexScore: 0.4, fusionMode: 'cosine-gated' });
    mocks.runGoldSet.mockResolvedValue({
      byClass: { 'hard-negative': { fpAt5: 0.1 } },
      overall: { r10: 0.8, p5: 0.9, mrr: 0.75, medianTopScore: 0.85 },
      latency: { p50: 12 },
      perQuery: [{ id: 'q1' }],
    });
  });

  it('reports phase transitions and confirms fresh seed rows only after the seed guard passes', async () => {
    const progress: PrecisionBenchProgress[] = [];
    await benchMemoryPrecision({ onProgress: (event) => progress.push(event) });

    expect(progress.map(({ phase, status }) => `${phase}:${status}`)).toEqual([
      'load-fixtures:started',
      'load-fixtures:completed',
      'create-backend:started',
      'create-backend:completed',
      'seed-corpus:started',
      'seed-corpus:completed',
      'retrieve-gold-set:started',
      'retrieve-gold-set:completed',
      'cleanup:started',
      'cleanup:completed',
    ]);
    expect(progress.find(({ phase, status }) => phase === 'seed-corpus' && status === 'started'))
      .toMatchObject({ expectedRows: 1 });
    expect(progress.find(({ phase, status }) => phase === 'seed-corpus' && status === 'completed'))
      .toMatchObject({ verifiedRows: 1 });
  });
});

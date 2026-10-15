/**
 * The BM25 lexical-search health probe (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * P-004 / R-4). The database side (bm25Health, measureBm25Latency against a real
 * pg_textsearch server, with and without the preload) is covered in
 * search/lexical/bm25-health.integration.test.ts and bm25-latency.integration.test.ts; this file
 * covers the probe's mapping, its fail-soft read and its latency re-measure window.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BM25_LATENCY_REMEASURE_MS,
  PORTLESS_PROBE_NAME_SET,
  __resetBm25LatencyForTests,
  evaluateBm25Health,
  probeBm25Lexical,
} from './service-health';
import { BM25_P95_BUDGET_MS, percentileMs, type Bm25Health, type Bm25Latency } from './search/lexical/rank';

function health(over: Partial<Bm25Health> = {}): Bm25Health {
  return {
    status: 'ok', flagOn: true, libraryLoaded: true, extensionInstalled: true,
    missingIndexes: [], presentIndexes: ['work_items_bm25', 'code_recipes_bm25'], latency: null, reason: null,
    ...over,
  };
}

function latency(p95Ms: number, measuredAt: number): Bm25Latency {
  return { corpusIndex: 'work_items_bm25', samplesMs: [p95Ms], p50Ms: p95Ms, p95Ms, budgetMs: BM25_P95_BUDGET_MS, measuredAt };
}

describe('evaluateBm25Health', () => {
  it('is a registered portless probe name', () => {
    expect(PORTLESS_PROBE_NAME_SET.has('bm25-lexical')).toBe(true);
  });

  it('reports not-present (no alert) when the flag is off', () => {
    const r = evaluateBm25Health(health({ status: 'off', flagOn: false }), 3);
    expect(r).toMatchObject({ name: 'bm25-lexical', up: true, present: false });
  });

  it('reports DOWN with the reason when BM25 is degraded, e.g. the library is not preloaded', () => {
    const r = evaluateBm25Health(health({ status: 'degraded', libraryLoaded: false, reason: 'pg_textsearch is not in shared_preload_libraries' }), 3);
    expect(r.up).toBe(false);
    expect(r.present).not.toBe(false);
    expect(r.note).toContain('pg_textsearch is not in shared_preload_libraries');
  });

  it('reports UP with the index count and the measured p95 when healthy', () => {
    const r = evaluateBm25Health(health({ latency: latency(12.34, 0) }), 3);
    expect(r.up).toBe(true);
    expect(r.note).toContain('2 index(es)');
    expect(r.note).toContain('p95 12.3ms');
    expect(r.note).not.toContain('p95 canary');
  });

  it('attributes a degraded p95 to its fixed canary and measurement time', () => {
    const samplesMs = [4, 1, 7, 2, 11, 3, 9, 6];
    const measuredAt = 1_000_000;
    const measured: Bm25Latency = {
      corpusIndex: 'work_items_bm25',
      samplesMs,
      p50Ms: percentileMs(samplesMs, 50),
      p95Ms: percentileMs(samplesMs, 95),
      budgetMs: BM25_P95_BUDGET_MS,
      measuredAt,
    };
    const r = evaluateBm25Health(health({
      status: 'degraded',
      reason: 'work-item p95 exceeds budget',
      latency: measured,
    }), 3);

    expect(r.up).toBe(false);
    expect(r.note).toContain('p95 canary "migration index": 11.0ms at 1970-01-01T00:16:40.000Z');
  });
});

describe('probeBm25Lexical', () => {
  beforeEach(() => __resetBm25LatencyForTests());

  it('is fail-soft: a failed read is present:false, never a fabricated DOWN', async () => {
    const r = await probeBm25Lexical({ read: async () => { throw new Error('pool exhausted'); } });
    expect(r).toMatchObject({ name: 'bm25-lexical', up: true, present: false });
  });

  it('reuses a measurement inside the window and re-measures after it', async () => {
    let clock = 1_000_000;
    const seen: Array<Bm25Latency | null> = [];
    const read = async (cached: Bm25Latency | null) => {
      seen.push(cached);
      const l = cached ?? latency(7, clock);
      return { health: health({ latency: l }), latency: l };
    };
    const now = () => clock;
    await probeBm25Lexical({ read, now });
    clock += BM25_LATENCY_REMEASURE_MS - 1;
    await probeBm25Lexical({ read, now });
    clock += 2;
    await probeBm25Lexical({ read, now });
    expect(seen[0]).toBeNull();
    expect(seen[1]?.measuredAt).toBe(1_000_000);
    expect(seen[2]).toBeNull();
  });
});

describe('percentileMs', () => {
  it('uses nearest rank, so the p95 of eight samples is the slowest one', () => {
    expect(percentileMs([5, 1, 3, 2, 8, 4, 7, 6], 95)).toBe(8);
    expect(percentileMs([5, 1, 3, 2, 8, 4, 7, 6], 50)).toBe(4);
  });

  it('is 0 for no samples', () => {
    expect(percentileMs([], 95)).toBe(0);
  });
});

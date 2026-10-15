/**
 * EI-10793's deferred detector: a precision-bench run whose corpus did not seed
 * must HARD-FAIL, never record a zero row.
 *
 * ⚠ WHY THIS FILE EXISTS SEPARATELY FROM precision-monitor.test.ts — read before
 * adding cases. That suite injects `deps.runBench`, replacing the ENTIRE bench with
 * fixed metrics. It therefore proves the orchestration (flag → record → invalidate →
 * escalate) but can never reach `benchMemoryPrecision`'s own body, which is where the
 * seed manifest was being discarded. That blind spot is precisely how three
 * consecutive all-zero runs shipped while the suite stayed green: the corpus failed
 * to seed (bench_memory.memory_vec_harrier missing), every gold query searched an
 * empty pool, and r@10=0 was written to harness_shared.memory_precision_bench as a
 * legitimate measurement of production recall.
 *
 * So these cases drive the REAL `benchMemoryPrecision` / `runMemoryPrecisionMonitor`
 * path with only the outermost seams (the embedder + PG backend, the corpus/gold
 * fixtures) mocked — pinning that the guard is actually CALLED, not merely that it
 * would work if called. Testing the assertion in isolation would repeat the same
 * mistake one layer down.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/bench/precision-seed-guard.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SeedManifest } from '@papercusp/memory/bench';

const seedCorpusMock = vi.hoisted(() => vi.fn());
const runGoldSetMock = vi.hoisted(() => vi.fn());
const cleanupMock = vi.hoisted(() => vi.fn(async () => {}));

// Keep the REAL pure helpers (seedFailureReason builds the refusal message);
// replace only the two calls that would touch a backend.
vi.mock('@papercusp/memory/bench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/memory/bench')>()),
  seedCorpus: seedCorpusMock,
  runGoldSet: runGoldSetMock,
}));
vi.mock('./precision-hybrid-backend', () => ({
  BENCH_SCOPE: 'bench-scope',
  makeHybridBackendCtx: vi.fn(async () => ({ backend: { name: 'hybrid' }, cleanup: cleanupMock })),
}));
// 3-entry corpus / 2-query gold set — the exact counts are what the guard compares.
vi.mock('./corpus', () => ({
  loadCorpusFixture: () => [
    { key: 'a', text: 'alpha' },
    { key: 'b', text: 'bravo' },
    { key: 'c', text: 'charlie' },
  ],
}));
vi.mock('./gold-set', () => ({
  loadGoldSetFixture: () => ({ version: 'v1', queries: [{ q: 'one' }, { q: 'two' }] }),
}));

import { assertCorpusSeeded, benchMemoryPrecision, runMemoryPrecisionMonitor } from './precision-monitor';
import { MEMORY_INJECTION_COSINE_FLOOR, MEMORY_INJECTION_LEX_FLOOR } from '../injection';

/** A manifest whose `ids` covers `seeded` corpus keys and whose `failed` lists the rest. */
const manifest = (
  seeded: string[],
  failed: string[] = [],
  errors: Record<string, string> = {},
): SeedManifest => ({
  backend: 'hybrid',
  scope: 'bench-scope',
  // Real seedCorpus records `ids[key] = []` for a FAILED key too — mirror that, so
  // the "0/N seeded" count is asserted against the shape production produces.
  ids: Object.fromEntries([...seeded.map((k) => [k, [`id-${k}`]]), ...failed.map((k) => [k, []])]),
  failed,
  errors,
  rememberMs: [],
  totalChars: 0,
});

const HEALTHY_RETRIEVAL = {
  overall: { r10: 0.82, p5: 0.9, mrr: 0.7, medianTopScore: 0.6 },
  byClass: { 'hard-negative': { fpAt5: 0.17 } },
  latency: { p50: 12 },
};

beforeEach(() => {
  vi.clearAllMocks();
  runGoldSetMock.mockResolvedValue(HEALTHY_RETRIEVAL);
});

describe('assertCorpusSeeded', () => {
  it('passes a fully-seeded corpus', () => {
    expect(() => assertCorpusSeeded(manifest(['a', 'b', 'c']), 3)).not.toThrow();
  });

  it('throws on a TOTAL seed failure (the EI-10793 case: 0/N seeded)', () => {
    expect(() => assertCorpusSeeded(manifest([], ['a', 'b', 'c']), 3)).toThrow(/0\/3 seeded, 3 failed/);
  });

  it('throws on a PARTIAL seed — a missing doc silently understates r@10, faking a regression', () => {
    expect(() => assertCorpusSeeded(manifest(['a', 'b'], ['c']), 3)).toThrow(/2\/3 seeded, 1 failed/);
  });

  it('quotes the first remember() ERROR, so the refusal names the cause (WI-10004107)', () => {
    const errors = { a: 'null value in column "row_kind" of relation "memory_vec_harrier" violates not-null constraint' };
    expect(() => assertCorpusSeeded(manifest([], ['a', 'b', 'c'], errors), 3)).toThrow(
      /first error \(a\): null value in column "row_kind"/,
    );
  });

  it('explains that the zero is an INFRASTRUCTURE failure, not a recall measurement', () => {
    expect(() => assertCorpusSeeded(manifest([], ['a', 'b', 'c']), 3)).toThrow(/INFRASTRUCTURE/);
  });
});

describe('benchMemoryPrecision — the guard is actually reached (delivery half)', () => {
  it('throws instead of returning zero metrics when the corpus did not seed', async () => {
    seedCorpusMock.mockResolvedValue(manifest([], ['a', 'b', 'c']));
    await expect(benchMemoryPrecision()).rejects.toThrow(/corpus seed incomplete/);
  });

  it('does not even RUN the gold set against an unseeded corpus (no point measuring an empty pool)', async () => {
    seedCorpusMock.mockResolvedValue(manifest([], ['a', 'b', 'c']));
    await expect(benchMemoryPrecision()).rejects.toThrow();
    expect(runGoldSetMock).not.toHaveBeenCalled();
  });

  it('still tears the bench schema down when the seed guard trips', async () => {
    seedCorpusMock.mockResolvedValue(manifest([], ['a', 'b', 'c']));
    await expect(benchMemoryPrecision()).rejects.toThrow();
    expect(cleanupMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds normally on a full seed', async () => {
    seedCorpusMock.mockResolvedValue(manifest(['a', 'b', 'c']));
    const m = await benchMemoryPrecision();
    expect(m.rAt10).toBe(0.82);
    expect(m.fpAt5).toBe(0.17);
    expect(runGoldSetMock).toHaveBeenCalledTimes(1);
  });
});

describe('benchMemoryPrecision — WI-7179: admission shape must come from pushSearchFloors(), not a copy', () => {
  // Regression guard for the defect this item fixed: the monitor imported the
  // right floor CONSTANTS but hardcoded `fusionMode: 'floored-union'` two lines
  // under a comment claiming it measures "the EXACT production push floor" —
  // while the live push path had moved to `cosine-gated` (D-010). Asserting the
  // literal 'cosine-gated' here (the current production default) is deliberate:
  // it is what pins a re-introduced hardcoded 'floored-union' as a failure,
  // where comparing against `pushSearchFloors()`'s own output could not.
  it('calls runGoldSet with the LIVE push-path fusion mode (cosine-gated), not a hardcoded floored-union', async () => {
    seedCorpusMock.mockResolvedValue(manifest(['a', 'b', 'c']));
    await benchMemoryPrecision();
    expect(runGoldSetMock).toHaveBeenCalledTimes(1);
    const [, , opts] = runGoldSetMock.mock.calls[0]!;
    expect(opts.fusionMode).toBe('cosine-gated');
  });

  it('measures at the LIVE cosine/lexical floors (MEMORY_INJECTION_COSINE_FLOOR / _LEX_FLOOR)', async () => {
    seedCorpusMock.mockResolvedValue(manifest(['a', 'b', 'c']));
    await benchMemoryPrecision();
    const [, , opts] = runGoldSetMock.mock.calls[0]!;
    expect(opts.minScore).toBe(MEMORY_INJECTION_COSINE_FLOOR);
    expect(opts.minLexScore).toBe(MEMORY_INJECTION_LEX_FLOOR);
  });

  it('records the measured floors and tags the row with the admission shape it was measured under', async () => {
    seedCorpusMock.mockResolvedValue(manifest(['a', 'b', 'c']));
    const m = await benchMemoryPrecision();
    expect(m.floorCosine).toBe(MEMORY_INJECTION_COSINE_FLOOR);
    expect(m.floorLex).toBe(MEMORY_INJECTION_LEX_FLOOR);
    // WI-7179: a zero-migration traceability tag so a future reader (human or
    // the recall-drop canary's triager) can tell a pre-fix (floored-union,
    // untagged) row from a post-fix one when interpreting a baseline jump.
    expect(m.notes).toBe('fusionMode:cosine-gated');
  });
});

describe('runMemoryPrecisionMonitor — a failed seed writes NO row and fires NO alarm', () => {
  const deps = () => ({
    flag: async () => true,
    // This suite deliberately exercises the in-process core so its seed guard
    // is reached; the scheduled default worker route is covered separately in
    // precision-monitor.test.ts.
    runBench: benchMemoryPrecision,
    record: vi.fn(async () => 99),
    escalateRecall: vi.fn(async () => {}),
    history: async () => [],
    invalidate: vi.fn(),
    log: () => {},
  });

  it('degrades to { ran: false, skipReason: "failed" } — the poisoned zero row is never recorded', async () => {
    seedCorpusMock.mockResolvedValue(manifest([], ['a', 'b', 'c']));
    const d = deps();
    const outcome = await runMemoryPrecisionMonitor({ workspaceId: 'ws', installSlug: 'papercusp' }, d);

    expect(outcome.ran).toBe(false);
    expect(outcome).toMatchObject({ skipReason: 'failed' });
    // THE REGRESSION THIS FILE EXISTS FOR: before the guard, these three both fired —
    // a zero row landed in memory_precision_bench and the canary escalated a
    // critical-floor "recall collapse" that was really a missing bench table.
    expect(d.record).not.toHaveBeenCalled();
    expect(d.escalateRecall).not.toHaveBeenCalled();
  });

  it('records + escalates as normal when the corpus DID seed (the guard is not over-broad)', async () => {
    seedCorpusMock.mockResolvedValue(manifest(['a', 'b', 'c']));
    const d = deps();
    const outcome = await runMemoryPrecisionMonitor({ workspaceId: 'ws', installSlug: 'papercusp' }, d);

    expect(outcome.ran).toBe(true);
    expect(d.record).toHaveBeenCalledTimes(1);
    expect(d.escalateRecall).toHaveBeenCalledTimes(1);
  });
});

/**
 * semantic-dupe-guard.coverage.test — WI-9393 consumer A.
 *
 * The dupe guard queries `harness_shared.work_items.embedding` and, until now, said
 * nothing about how much of that column is actually populated. The load-bearing case is
 * the EMPTY `hard`+`soft` result: on its own it cannot distinguish "no duplicate exists"
 * from "the duplicate exists but is not embedded, so this query could never have seen
 * it" — and a miss here CREATES the duplicate the guard exists to prevent.
 *
 * These tests pin three things a future edit could quietly break:
 *   1. coverage rides on a NON-NULL result, the empty one included;
 *   2. it degrades to `unknown` — never to healthy, and never to a null verdict — when
 *      the coverage read is unavailable or throws;
 *   3. the surface asked about is the one the guard actually reads.
 */
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  findSemanticDupes,
  SEMANTIC_DUPE_GUARD_BUDGET_MS,
  type SemanticDupeCandidate,
  type SemanticDupeDeps,
} from './semantic-dupe-guard';
// Import both contracts rather than restating a number: a width change or a floor
// re-tune then moves these fixtures automatically instead of stranding them.
import { PROSE_VECTOR_DIMS } from '../../search/prose-vector-dims';
import { TOTAL_COVERAGE_FLOOR } from '../../search/embed-coverage';
import type { CoverageSnapshot } from '../../search/coverage-gate';

/** The one vector surface `queryCandidatesReal`'s SQL reads. */
const SURFACE = 'harness_shared.work_items.embedding';

const snapshot = (pct: number, opts: { stale?: boolean } = {}): CoverageSnapshot =>
  new Map([
    [
      SURFACE,
      {
        surface: SURFACE,
        observedAt: new Date(),
        eligibleRows: 1000,
        embeddedRows: Math.round(pct * 1000),
        pct,
        recentPct: null,
        stale: opts.stale ?? false,
        ageMs: 0,
      },
    ],
  ]);

const cand = (id: string, similarity: number): SemanticDupeCandidate => ({
  id,
  title: `title of ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
});

const deps = (
  candidates: SemanticDupeCandidate[],
  loadCoverage?: () => Promise<CoverageSnapshot>,
): SemanticDupeDeps => ({
  resolveEmbedder: async () => ({
    mode: 'gemma',
    dims: PROSE_VECTOR_DIMS,
    profile: EMBEDDER_DIM_SPECS.gemma,
    embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1),
  }),
  queryCandidates: async () => candidates,
  ...(loadCoverage ? { loadCoverage } : {}),
});

// Comfortably either side of the floor, expressed relative to it so a re-tune moves
// both fixtures together.
const ABOVE_FLOOR = Math.min(0.999, TOTAL_COVERAGE_FLOOR + (1 - TOTAL_COVERAGE_FLOOR) / 2);
const BELOW_FLOOR = TOTAL_COVERAGE_FLOOR / 2;

describe('coverage attaches to a verdict', () => {
  it('reports healthy when the queried surface is above the floor', async () => {
    const r = await findSemanticDupes(
      { title: 't', summary: 's' },
      deps([cand('EI-1', 0.95)], async () => snapshot(ABOVE_FLOOR)),
    );
    expect(r).not.toBeNull();
    expect(r!.hard.map((c) => c.id)).toEqual(['EI-1']);
    expect(r!.coverage?.verdict).toBe('healthy');
    expect(r!.coverage?.coverage).toBeCloseTo(ABOVE_FLOOR, 3);
  });

  // THE case this whole wiring exists for.
  it('reports DEGRADED on an EMPTY hard+soft result — "no dupe" vs "not embedded"', async () => {
    const r = await findSemanticDupes(
      { title: 't' },
      deps([], async () => snapshot(BELOW_FLOOR)),
    );
    expect(r).not.toBeNull();
    expect(r!.hard).toEqual([]);
    expect(r!.soft).toEqual([]);
    expect(r!.coverage?.verdict).toBe('degraded');
    // The note is what an agent or human actually reads off the empty result.
    expect(r!.coverage?.note).toMatch(/floor/i);
  });

  it('names the surface the guard actually queries, not a search-source key', async () => {
    const r = await findSemanticDupes({ title: 't' }, deps([], async () => new Map()));
    expect(r!.coverage?.unknownSurfaces).toEqual([SURFACE]);
    expect(r!.coverage?.source).toBe('work_items:semantic-dupe-guard');
  });
});

describe('coverage never costs a verdict', () => {
  it('an unsampled surface renders unknown, not healthy', async () => {
    const r = await findSemanticDupes({ title: 't' }, deps([], async () => new Map()));
    expect(r!.coverage?.verdict).toBe('unknown');
    expect(r!.coverage?.coverage).toBeNull();
  });

  it('a STALE sample renders unknown, not the stale percentage', async () => {
    const r = await findSemanticDupes(
      { title: 't' },
      deps([], async () => snapshot(ABOVE_FLOOR, { stale: true })),
    );
    expect(r!.coverage?.verdict).toBe('unknown');
  });

  it('a THROWING coverage read still returns the dupe verdict, degraded to unknown', async () => {
    const r = await findSemanticDupes(
      { title: 't' },
      deps([cand('EI-9', 0.99)], async () => {
        throw new Error('coverage table unreachable');
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.hard.map((c) => c.id)).toEqual(['EI-9']);
    expect(r!.coverage?.verdict).toBe('unknown');
  });

  it('returns the semantic verdict within its budget when the optional coverage read hangs', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = findSemanticDupes(
        { title: 't' },
        deps([cand('EI-COVERAGE-HUNG', 0.99)], () => new Promise<CoverageSnapshot>(() => {})),
      ).then((result) => {
        settled = true;
        return result;
      });

      // Let classification finish and the independent coverage read start, then
      // exhaust the shared prescreen budget without ever resolving that read.
      await vi.advanceTimersByTimeAsync(SEMANTIC_DUPE_GUARD_BUDGET_MS + 1);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result?.hard.map((candidate) => candidate.id)).toEqual(['EI-COVERAGE-HUNG']);
      expect(result?.coverage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // Pins the deliberate inertness, not an accident: without an injected seam the real
  // loader reaches for the org PG pool, so under vitest the guard attaches NOTHING
  // rather than opening a connection in an unrelated tool test. If this ever starts
  // returning a verdict, something is talking to Postgres from a unit test.
  it('attaches no coverage under vitest when no seam is injected', async () => {
    const r = await findSemanticDupes({ title: 't' }, deps([cand('EI-1', 0.99)]));
    expect(r).not.toBeNull();
    expect(r!.hard.map((c) => c.id)).toEqual(['EI-1']);
    expect(r!.coverage).toBeUndefined();
    expect(Object.keys(r!)).not.toContain('coverage');
  });

  it('does not read coverage at all when there is no verdict to attach it to', async () => {
    let reads = 0;
    const r = await findSemanticDupes(
      { title: 't' },
      {
        resolveEmbedder: async () => ({ mode: 'disabled', reason: 'off' }),
        queryCandidates: async () => [],
        loadCoverage: async () => {
          reads += 1;
          return new Map();
        },
      },
    );
    expect(r).toBeNull();
    expect(reads).toBe(0);
  });
});

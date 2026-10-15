/**
 * P-009 — runtime honesty for the semantic leg.
 *
 * The property under test is narrow and load-bearing: **absence of evidence
 * must never render as health.** Most of these cases exist to pin that one
 * rule from a different direction (missing sample, stale sample, unmapped
 * source, failed read), because the bug this item removes was not a wrong
 * number — it was a confident answer where there was no evidence at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SEARCH_SOURCE_SURFACES,
  COVERAGE_SAMPLE_MAX_AGE_MS,
  assessSourceCoverage,
  assessSearchCoverage,
  loadCoverageSnapshot,
  loadCoverageSnapshotCached,
  resetCoverageSnapshotCache,
  type CoverageSnapshot,
  type SurfaceReading,
} from './coverage-gate';
import { TOTAL_COVERAGE_FLOOR, surfaceKey, coverageTargets } from './embed-coverage';
import { TARGETS } from './embed-backfill';
import { SEARCH_SOURCES } from '../agent-tools/search/sources';

const NOW = new Date('2026-08-03T18:00:00.000Z');

it('cold coverage reads do not initialize the background embedding monitor', async () => {
  vi.resetModules();
  vi.doMock('./embed-coverage', () => { throw new Error('background monitor loaded on query path'); });
  try {
    const gate = await import('./coverage-gate');
    const snapshot = await gate.loadCoverageSnapshot({ unsafe: async () => [] }, 'cold-query', NOW);
    expect(gate.assessSourceCoverage('work_item', snapshot).verdict).toBe('unknown');
  } finally {
    vi.doUnmock('./embed-coverage');
    vi.resetModules();
  }
});

function reading(surface: string, embedded: number, eligible: number, opts: {
  ageMs?: number;
  recentEligible?: number;
  recentEmbedded?: number;
} = {}): SurfaceReading {
  const ageMs = opts.ageMs ?? 60_000;
  return {
    surface,
    observedAt: new Date(NOW.getTime() - ageMs),
    eligibleRows: eligible,
    embeddedRows: embedded,
    pct: eligible > 0 ? embedded / eligible : null,
    recentPct:
      opts.recentEligible && opts.recentEmbedded !== undefined
        ? opts.recentEmbedded / opts.recentEligible
        : null,
    stale: ageMs > COVERAGE_SAMPLE_MAX_AGE_MS,
    ageMs,
  };
}

const snap = (...rs: SurfaceReading[]): CoverageSnapshot =>
  new Map(rs.map((r) => [r.surface, r]));

const TURNS = 'harness_shared.operator_turns.text_embedding';
const SESSION_TURNS = 'harness_shared.session_turns.text_embedding';
const SESSION_CHUNKS = 'harness_shared.session_turn_chunks.embedding';

describe('SEARCH_SOURCE_SURFACES exhaustiveness', () => {
  // The whole point of the mapping is that omitting an entry is LOUD. If this
  // test did not exist, a new search source would silently report `unknown`
  // forever — the same class of failure as an unenumerated vector column.
  it('covers every registered SearchSource', () => {
    const missing = SEARCH_SOURCES.map((s) => s.name).filter(
      (n) => SEARCH_SOURCE_SURFACES[n] === undefined,
    );
    expect(missing, `sources with no coverage mapping: ${missing.join(', ')}`).toEqual([]);
  });

  it('maps no source that does not exist', () => {
    const names = new Set(SEARCH_SOURCES.map((s) => s.name));
    const extra = Object.keys(SEARCH_SOURCE_SURFACES).filter((k) => !names.has(k));
    expect(extra, `mapping entries with no SearchSource: ${extra.join(', ')}`).toEqual([]);
  });

  // The highest-value guard in this file. Every surface string here must be a
  // surface the backfill ACTUALLY produces — the same `surfaceKey(target)` the
  // alarm persists. A typo, or a table/column rename, would otherwise make the
  // lookup miss forever and report `unknown` for a perfectly healthy index:
  // silent, permanent, and indistinguishable from "the alarm stopped running".
  // Structural rather than data-driven on purpose, so it does not depend on
  // what happens to have been sampled recently.
  it('references only surfaces the embed-backfill actually produces', () => {
    const real = new Set(coverageTargets().map((t) => surfaceKey(t)));
    const bogus = Object.entries(SEARCH_SOURCE_SURFACES).flatMap(([source, surfaces]) =>
      surfaces.filter((s) => !real.has(s)).map((s) => `${source} → ${s}`),
    );
    expect(bogus, `surfaces no backfill TARGET produces: ${bogus.join('; ')}`).toEqual([]);

    // CONTROL — without these the assertion above passes vacuously if TARGETS
    // is ever empty or the mapping is emptied, which is exactly the state a
    // refactor-gone-wrong would leave behind.
    expect(real.size).toBeGreaterThan(5);
    expect(real.has('harness_shared.not_a_real_table.embedding')).toBe(false);
  });

  it('declares an embedding leg exactly when the source implements one', () => {
    for (const src of SEARCH_SOURCES) {
      const declared = (SEARCH_SOURCE_SURFACES[src.name] ?? []).length > 0;
      const actual = typeof src.embedding === 'function';
      expect(declared, `${src.name}: mapping says semantic=${declared}, source says ${actual}`).toBe(
        actual,
      );
    }
  });
});

describe('assessSourceCoverage — absence of evidence is not health', () => {
  it('reports unknown (NOT healthy) when the surface has no sample at all', () => {
    const a = assessSourceCoverage('turns', snap());
    expect(a.verdict).toBe('unknown');
    expect(a.coverage).toBeNull();
    expect(a.note).toMatch(/not the same as healthy/i);
  });

  it('reports unknown (NOT healthy) when the only sample is STALE', () => {
    const stale = reading(TURNS, 100, 100, { ageMs: COVERAGE_SAMPLE_MAX_AGE_MS + 1 });
    const a = assessSourceCoverage('turns', snap(stale));
    // 100% coverage, but nobody has looked recently — that is not evidence.
    expect(a.verdict).toBe('unknown');
    // Every turns surface is unknown: the stale operator_turns column and, since
    // generic-rag-chunking P-010, the shared chunk column its chunks live in (unsampled).
    expect(a.unknownSurfaces).toContain(TURNS);
    expect(a.unknownSurfaces).toEqual(SEARCH_SOURCE_SURFACES.turns);
  });

  it('a sample one millisecond INSIDE the window still counts (boundary)', () => {
    const fresh = reading(TURNS, 100, 100, { ageMs: COVERAGE_SAMPLE_MAX_AGE_MS - 1 });
    expect(assessSourceCoverage('turns', snap(fresh)).verdict).toBe('healthy');
  });

  it('reports unknown for a source with no mapping entry', () => {
    const a = assessSourceCoverage('a_source_that_does_not_exist', snap());
    expect(a.verdict).toBe('unknown');
    expect(a.note).toMatch(/no coverage mapping/i);
  });
});

describe('assessSourceCoverage — verdicts', () => {
  it('flags degraded below the floor', () => {
    const a = assessSourceCoverage('turns', snap(reading(TURNS, 720, 1000)));
    expect(a.verdict).toBe('degraded');
    expect(a.coverage).toBeCloseTo(0.72, 5);
    expect(a.note).toMatch(/PARTIAL index/);
  });

  it('passes at or above the floor', () => {
    const at = Math.ceil(TOTAL_COVERAGE_FLOOR * 1000);
    expect(assessSourceCoverage('turns', snap(reading(TURNS, at, 1000))).verdict).toBe('healthy');
    expect(assessSourceCoverage('turns', snap(reading(TURNS, 1000, 1000))).verdict).toBe('healthy');
  });

  // The BM25-only exemplar is `coord_message`, not `work_item`: P-005 gave
  // `work_item` a real embedding leg, so it is no longer a source with an empty
  // surface list. `coord_message` still is (120k+ envelope rows deliberately
  // unembedded), which is what these three cases actually need.
  it('distinguishes BM25-only sources from unknown ones', () => {
    const a = assessSourceCoverage('coord_message', snap());
    expect(a.verdict).toBe('not-semantic');
    // Must NOT be conflated with `unknown`: one is "does not apply", the other
    // is "we do not know", and only the latter is a warning.
    expect(a.verdict).not.toBe('unknown');
  });

  it('names the historical-backlog case when recent rows are healthy', () => {
    const a = assessSourceCoverage(
      'session_turn',
      snap(reading(SESSION_TURNS, 255_303, 354_408, { recentEligible: 21_758, recentEmbedded: 21_706 })),
    );
    expect(a.verdict).toBe('degraded');
    expect(a.note).toMatch(/historical backlog/i);
  });
});

describe('assessSourceCoverage — multi-leg union (P-034 parent + chunks)', () => {
  it('takes the BEST known leg, since either leg makes a row findable', () => {
    const a = assessSourceCoverage(
      'session_turn',
      snap(reading(SESSION_TURNS, 720, 1000), reading(SESSION_CHUNKS, 1000, 1000)),
    );
    expect(a.coverage).toBe(1);
    expect(a.verdict).toBe('healthy');
  });

  it('still reports on the parent leg when the chunk leg has no sample yet', () => {
    // Exactly the live state after P-034 shipped but before bg-host restarted:
    // chunk rows exist but the sweep has never sampled them.
    const a = assessSourceCoverage('session_turn', snap(reading(SESSION_TURNS, 720, 1000)));
    expect(a.verdict).toBe('degraded');
    expect(a.coverage).toBeCloseTo(0.72, 5);
    expect(a.unknownSurfaces).toEqual([SESSION_CHUNKS]);
    expect(a.note).toMatch(/Partial view/);
  });

  it('is unknown only when EVERY leg is unknown', () => {
    expect(assessSourceCoverage('session_turn', snap()).verdict).toBe('unknown');
  });
});

describe('assessSearchCoverage — rollup', () => {
  it('returns no warning when every scoped source is healthy or non-semantic', () => {
    const r = assessSearchCoverage(['turns', 'coord_message'], snap(reading(TURNS, 1000, 1000)));
    expect(r.degraded).toBe(false);
    expect(r.warning).toBeNull();
  });

  it('warns on a degraded source and names it', () => {
    const r = assessSearchCoverage(['turns'], snap(reading(TURNS, 720, 1000)));
    expect(r.degraded).toBe(true);
    expect(r.degradedSources).toEqual(['turns']);
    expect(r.warning).toMatch(/DEGRADED/);
  });

  it('warns on an unknown source separately from a degraded one', () => {
    const r = assessSearchCoverage(['turns', 'decisions'], snap(reading(TURNS, 720, 1000)));
    expect(r.degradedSources).toEqual(['turns']);
    expect(r.unknownSources).toEqual(['decisions']);
    expect(r.warning).toMatch(/DEGRADED/);
    expect(r.warning).toMatch(/UNKNOWN/);
  });

  it('a BM25-only source never raises a warning on its own', () => {
    const r = assessSearchCoverage(['coord_message'], snap());
    expect(r.degraded).toBe(false);
    expect(r.warning).toBeNull();
  });
});

describe('loadCoverageSnapshot', () => {
  beforeEach(() => resetCoverageSnapshotCache());

  it('parses bigint-as-string columns and computes staleness', async () => {
    const sql = {
      unsafe: async () => [
        {
          surface: TURNS,
          observed_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          eligible_rows: '1000',
          embedded_rows: '720',
          recent_eligible: '500',
          recent_embedded: '500',
        },
      ],
    };
    const s = await loadCoverageSnapshot(sql, 'ws', NOW);
    const r = s.get(TURNS)!;
    // Postgres returns bigint as a STRING; a naive read would make pct NaN.
    expect(r.pct).toBeCloseTo(0.72, 5);
    expect(r.recentPct).toBe(1);
    expect(r.stale).toBe(false);
  });

  it('suppresses recentPct below MIN_RECENT_SAMPLE rather than reporting a noisy ratio', async () => {
    const sql = {
      unsafe: async () => [
        {
          surface: TURNS,
          observed_at: NOW.toISOString(),
          eligible_rows: '1000',
          embedded_rows: '1000',
          recent_eligible: '3',
          recent_embedded: '1',
        },
      ],
    };
    const s = await loadCoverageSnapshot(sql, 'ws', NOW);
    expect(s.get(TURNS)!.recentPct).toBeNull();
  });

  it('a FAILED read degrades to unknown — never to healthy, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = { unsafe: async () => { throw new Error('pg is down'); } };
      const s = await loadCoverageSnapshotCached(sql, 'ws', NOW);
      expect(s.size).toBe(0);
      // The whole failure mode this item exists to kill: an outage must not
      // read as a clean bill of health.
      expect(assessSourceCoverage('turns', s).verdict).toBe('unknown');
      // The degradation must be visible in the log, not swallowed silently —
      // a silent fallback is how the original bug stayed invisible.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/snapshot read failed/);
    } finally {
      warn.mockRestore();
    }
  });

  it('a handle with no unsafe() resolves to unknown SILENTLY (not a failure to shout about)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = await loadCoverageSnapshotCached((() => {}) as never, 'ws', NOW);
      expect(s.size).toBe(0);
      expect(assessSourceCoverage('turns', s).verdict).toBe('unknown');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // This gate sits on the claim/injection path (assessCorpusGate), so ANY rig
  // test that claims a work-item runs it. A partial test schema — or a deploy
  // that has not yet run migration 746 — makes the read throw "does not exist",
  // and a console.warn there is turned into a FAILURE by vitest-fail-on-console.
  // That red 4 unrelated integration suites (claim-next-co-location,
  // work-items-tools, spawn-child, grade-idea) while this gate was behaving
  // exactly as designed. The verdict still has to degrade to `unknown` — the
  // suppression is of the LOG, never of the signal.
  it('a MISSING coverage table degrades to unknown SILENTLY (a partial schema is not a surprise)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const sql = {
        unsafe: async () => {
          calls += 1;
          // The verbatim message observed from postgres.js in the run that
          // caught this (migration 746's table absent from a rig schema).
          throw new Error('relation "harness_shared.embed_coverage_samples" does not exist');
        },
      };
      const s = await loadCoverageSnapshotCached(sql, 'ws', NOW);
      expect(s.size).toBe(0);
      expect(assessSourceCoverage('turns', s).verdict).toBe('unknown');
      expect(warn).not.toHaveBeenCalled();
      // Still memoised: silence must not buy a re-read on every query.
      await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 1_000));
      expect(calls).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a pool torn down mid-read degrades to unknown SILENTLY (rig teardown, not a surprise)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const err of [
        Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' }),
        Object.assign(new Error('boom'), { code: 'CONNECTION_DESTROYED' }),
      ]) {
        resetCoverageSnapshotCache();
        const s = await loadCoverageSnapshotCached(
          { unsafe: async () => { throw err; } },
          'ws',
          NOW,
        );
        expect(s.size).toBe(0);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not re-read (or re-log) on EVERY query while a failure persists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const sql = { unsafe: async () => { calls += 1; throw new Error('pg is down'); } };
      // Three queries inside one TTL window: the failure is memoised, so the
      // hottest path in the tool does not turn a degraded signal into a flood.
      await loadCoverageSnapshotCached(sql, 'ws', NOW);
      await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 1_000));
      await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 2_000));
      expect(calls).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('throttles the failure warning across TTL windows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = { unsafe: async () => { throw new Error('pg is down'); } };
      await loadCoverageSnapshotCached(sql, 'ws', NOW);
      // Past the snapshot TTL (so it retries) but inside the warn throttle.
      await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 2 * 60_000));
      expect(warn).toHaveBeenCalledTimes(1);
      // Past the throttle — the problem is still real, so say so again.
      await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 6 * 60_000));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('memoises within the TTL and re-reads after it', async () => {
    let calls = 0;
    const sql = {
      unsafe: async () => {
        calls += 1;
        return [{
          surface: TURNS,
          observed_at: NOW.toISOString(),
          eligible_rows: '10',
          embedded_rows: '10',
          recent_eligible: null,
          recent_embedded: null,
        }];
      },
    };
    await loadCoverageSnapshotCached(sql, 'ws', NOW);
    await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 1_000));
    expect(calls).toBe(1);
    await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 120_000));
    expect(calls).toBe(2);
  });

  it('does not serve one workspace a different workspace cached snapshot', async () => {
    let calls = 0;
    const sql = { unsafe: async () => { calls += 1; return []; } };
    await loadCoverageSnapshotCached(sql, 'ws-a', NOW);
    await loadCoverageSnapshotCached(sql, 'ws-b', NOW);
    expect(calls).toBe(2);
  });
});

describe('falsifiability controls', () => {
  // A guard that has never failed is a guard nobody has tested. These are
  // deliberately-wrong implementations kept as permanent controls: if the real
  // `assessSourceCoverage` ever starts agreeing with them, the property has
  // been broken. Paired with a calibration case so the controls cannot pass
  // merely because the assertions are vacuous.
  const missingReadsAsHealthy = (source: string, s: CoverageSnapshot) =>
    s.size === 0 ? 'healthy' : assessSourceCoverage(source, s).verdict;

  it('CONTROL: the "missing ⇒ healthy" implementation is what we must NOT do', () => {
    const empty = snap();
    expect(missingReadsAsHealthy('turns', empty)).toBe('healthy');
    expect(assessSourceCoverage('turns', empty).verdict).toBe('unknown');
    expect(assessSourceCoverage('turns', empty).verdict).not.toBe(
      missingReadsAsHealthy('turns', empty),
    );
  });

  it('CALIBRATION: the two agree when evidence IS present', () => {
    const good = snap(reading(TURNS, 1000, 1000));
    expect(assessSourceCoverage('turns', good).verdict).toBe('healthy');
    expect(missingReadsAsHealthy('turns', good)).toBe('healthy');
  });
});

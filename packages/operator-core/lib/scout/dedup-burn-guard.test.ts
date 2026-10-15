/**
 * dedup-burn-guard tests (blender-loop-repair-and-opus5-xhigh-2026-08-16 P-007
 * / WI-39479): the consecutive-cycle saturation assessment, the novelty-band
 * widening, the config application, the fail-open ledger read, and the
 * renderDigest saturation rendering (the "refresh the digest" lever).
 *
 * Run from inside the package: `cd packages/operator-core && npx vitest run lib/scout/dedup-burn-guard`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assessDedupBurn,
  widenNoveltyBand,
  applyDedupBurnToConfig,
  readDedupBurnVerdict,
  DEFAULT_DEDUP_BURN_OPTIONS,
  type DedupBurnTick,
} from './dedup-burn-guard';
import { DEFAULT_SCOUT_CONFIG } from './config';
import { renderDigest } from './lenses';
import type { CorpusDigest } from './types';

vi.mock('./tick-ledger', () => ({ readScoutTicks: vi.fn() }));
vi.mock('../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

function ran(generated: number, deduped: number, routed = 0): DedupBurnTick {
  return { status: 'ran', ideasGenerated: generated, ideasDeduped: deduped, ideasRouted: routed };
}

const GATED: DedupBurnTick = { status: 'gated' };
const ERRORED: DedupBurnTick = { status: 'error' };

/* ── assessDedupBurn (pure) ───────────────────────────────────────────── */

describe('assessDedupBurn', () => {
  it('returns unsaturated on an empty window', () => {
    const v = assessDedupBurn([]);
    expect(v.saturated).toBe(false);
    expect(v.consecutiveSaturated).toBe(0);
    expect(v.wideningSteps).toBe(0);
  });

  it('one saturated cycle is below the default trigger of 2', () => {
    const v = assessDedupBurn([ran(10, 9)]);
    expect(v.saturated).toBe(false);
    expect(v.consecutiveSaturated).toBe(1);
    expect(v.lastRatio).toBe(0.9);
    expect(v.wideningSteps).toBe(0);
  });

  it('two consecutive saturated cycles trigger with one widening step', () => {
    const v = assessDedupBurn([ran(10, 9), ran(12, 10)]);
    expect(v.saturated).toBe(true);
    expect(v.consecutiveSaturated).toBe(2);
    expect(v.wideningSteps).toBe(1);
    expect(v.reason).toContain('2 consecutive');
  });

  it('widening grows one step per cycle past the trigger, capped at maxWideningSteps', () => {
    expect(assessDedupBurn([ran(10, 9), ran(10, 9), ran(10, 9)]).wideningSteps).toBe(2);
    const six = Array.from({ length: 6 }, () => ran(10, 9));
    expect(assessDedupBurn(six).wideningSteps).toBe(DEFAULT_DEDUP_BURN_OPTIONS.maxWideningSteps);
  });

  it('gated and error ticks are skipped, not streak-breaking', () => {
    const v = assessDedupBurn([ran(10, 9), GATED, ERRORED, ran(10, 10)]);
    expect(v.saturated).toBe(true);
    expect(v.consecutiveSaturated).toBe(2);
  });

  it('a healthy ran-cycle (ratio below threshold) breaks the streak', () => {
    const v = assessDedupBurn([ran(10, 9), ran(10, 3), ran(10, 9)]);
    expect(v.saturated).toBe(false);
    expect(v.consecutiveSaturated).toBe(1);
  });

  it('a sub-minimum ran-cycle carries no evidence either way', () => {
    // 2 ideas both burned: too small to count toward OR break the streak.
    const v = assessDedupBurn([ran(10, 9), ran(2, 2), ran(10, 9)]);
    expect(v.saturated).toBe(true);
    expect(v.consecutiveSaturated).toBe(2);
    // …and a tiny HEALTHY cycle does not break it either.
    const v2 = assessDedupBurn([ran(10, 9), ran(2, 0), ran(10, 9)]);
    expect(v2.consecutiveSaturated).toBe(2);
  });

  it('the threshold boundary is inclusive (ratio == threshold counts)', () => {
    const v = assessDedupBurn([ran(10, 8), ran(10, 8)]);
    expect(v.saturated).toBe(true);
  });

  it('calibration: the 08-06/07 incident shape (all burned, 0 routed) triggers', () => {
    // ~428 ideas over consecutive cycles, everything deduped, nothing routed.
    const v = assessDedupBurn([ran(214, 214, 0), ran(214, 214, 0)]);
    expect(v.saturated).toBe(true);
    expect(v.lastRatio).toBe(1);
  });

  it('control: a healthy history never triggers (falsifiability of the trigger)', () => {
    const v = assessDedupBurn([ran(10, 2, 5), ran(12, 4, 6), ran(8, 1, 4)]);
    expect(v.saturated).toBe(false);
    expect(v.consecutiveSaturated).toBe(0);
  });

  it('honors custom thresholds', () => {
    const v = assessDedupBurn([ran(10, 6)], { dedupRatioThreshold: 0.5, consecutiveCycles: 1 });
    expect(v.saturated).toBe(true);
    expect(v.wideningSteps).toBe(1);
  });
});

/* ── widenNoveltyBand ─────────────────────────────────────────────────── */

describe('widenNoveltyBand', () => {
  it('0 steps returns the floor unchanged', () => {
    expect(widenNoveltyBand(0.34, 0)).toBe(0.34);
  });

  it('lowers one step at a time', () => {
    expect(widenNoveltyBand(0.34, 1)).toBe(0.28);
    expect(widenNoveltyBand(0.34, 2)).toBe(0.22);
  });

  it('clamps at minNoveltyFloor', () => {
    expect(widenNoveltyBand(0.34, 5)).toBe(DEFAULT_DEDUP_BURN_OPTIONS.minNoveltyFloor);
  });
});

/* ── applyDedupBurnToConfig ───────────────────────────────────────────── */

describe('applyDedupBurnToConfig', () => {
  const saturatedVerdict = {
    saturated: true,
    consecutiveSaturated: 2,
    lastRatio: 0.9,
    wideningSteps: 1,
    reason: 'test',
  };

  it('returns the SAME reference for an unsaturated verdict', () => {
    const v = { ...saturatedVerdict, saturated: false, wideningSteps: 0 };
    expect(applyDedupBurnToConfig(DEFAULT_SCOUT_CONFIG, v)).toBe(DEFAULT_SCOUT_CONFIG);
  });

  it('widens only buckets.noveltyFloor, leaving everything else untouched', () => {
    const out = applyDedupBurnToConfig(DEFAULT_SCOUT_CONFIG, saturatedVerdict);
    expect(out).not.toBe(DEFAULT_SCOUT_CONFIG);
    expect(out.buckets.noveltyFloor).toBe(0.28);
    expect(out.buckets.feasibilityFloor).toBe(DEFAULT_SCOUT_CONFIG.buckets.feasibilityFloor);
    expect(out.buckets.moonshotNoveltyFloor).toBe(DEFAULT_SCOUT_CONFIG.buckets.moonshotNoveltyFloor);
    expect(out.novelty).toBe(DEFAULT_SCOUT_CONFIG.novelty);
    expect(out.lenses).toBe(DEFAULT_SCOUT_CONFIG.lenses);
  });

  it('returns the SAME reference when the floor is already at the clamp', () => {
    const atMin = {
      ...DEFAULT_SCOUT_CONFIG,
      buckets: {
        ...DEFAULT_SCOUT_CONFIG.buckets,
        noveltyFloor: DEFAULT_DEDUP_BURN_OPTIONS.minNoveltyFloor,
      },
    };
    expect(applyDedupBurnToConfig(atMin, saturatedVerdict)).toBe(atMin);
  });
});

/* ── readDedupBurnVerdict (fail-open PG edge) ─────────────────────────── */

describe('readDedupBurnVerdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('assesses ledger rows (newest first) into a verdict', async () => {
    const { readScoutTicks } = await import('./tick-ledger');
    vi.mocked(readScoutTicks).mockResolvedValue([
      { status: 'ran', ideasGenerated: 10, ideasDeduped: 9, ideasRouted: 0, tickAt: 't1' },
      { status: 'gated', tickAt: 't2' },
      { status: 'ran', ideasGenerated: 10, ideasDeduped: 10, ideasRouted: 0, tickAt: 't3' },
    ]);
    const v = await readDedupBurnVerdict({ workspaceId: 'ws', installSlug: 'papercusp' });
    expect(v.saturated).toBe(true);
    expect(v.consecutiveSaturated).toBe(2);
    expect(vi.mocked(readScoutTicks)).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', installSlug: 'papercusp' }),
    );
  });

  it('fails OPEN: a throwing ledger read yields an unsaturated verdict', async () => {
    const { readScoutTicks } = await import('./tick-ledger');
    vi.mocked(readScoutTicks).mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const v = await readDedupBurnVerdict({});
      expect(v.saturated).toBe(false);
      expect(v.wideningSteps).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

/* ── renderDigest saturation rendering (the digest-refresh lever) ─────── */

describe('renderDigest under dedupSaturation', () => {
  function digestWith(over: Partial<CorpusDigest>): CorpusDigest {
    return {
      recurringFriction: [{ summary: 'fresh pattern', ref: 'wi:F-1' }],
      timeTokenSinks: [{ summary: 'standing pattern', ref: 'wi:F-2' }],
      chronicDeferrals: [],
      capabilityGaps: [],
      previousCycleRefs: ['wi:F-2'],
      ...over,
    };
  }

  it('drops the standing section and leads with the banner when fresh signal exists', () => {
    const out = renderDigest(
      digestWith({ dedupSaturation: { consecutiveSaturated: 3, wideningSteps: 2 } }),
    );
    expect(out).toContain('CORPUS SATURATED');
    expect(out).toContain('last 3 cycle(s)');
    expect(out).toContain('fresh pattern');
    expect(out).not.toContain('## Standing patterns');
    expect(out).not.toContain('(ref: wi:F-2)');
  });

  it('keeps the standing section (plus banner) when there is NO fresh signal', () => {
    const out = renderDigest(
      digestWith({
        // Both patterns already seen last cycle — nothing fresh to ground on.
        previousCycleRefs: ['wi:F-1', 'wi:F-2'],
        dedupSaturation: { consecutiveSaturated: 2, wideningSteps: 1 },
      }),
    );
    expect(out).toContain('CORPUS SATURATED');
    expect(out).toContain('## Standing patterns');
    expect(out).toContain('standing pattern');
  });

  it('control: without the stamp the standing section renders as before', () => {
    const out = renderDigest(digestWith({}));
    expect(out).not.toContain('CORPUS SATURATED');
    expect(out).toContain('## Standing patterns');
    expect(out).toContain('standing pattern');
  });
});

/**
 * Pure coverage for the recency-walk slice tiler (plan session-transcript-exact-fuzzy-search-2026-09-14,
 * WI-10005294 / D-015: a near-ubiquitous literal must return the newest matches inside the exact-tier
 * deadline instead of `status=deadline` with zero hits).
 *
 * The walk's COMPLETENESS claim ("every match with ts >= completeSince is returned") is only sound if the
 * slices tile all of time with no gap and no overlap — a turn in a gap is silently never walked, a turn in an
 * overlap is returned twice. So the tiling is the property under test, not an incidental detail.
 */
import { describe, expect, it } from 'vitest';
import { SESSION_TURN_LITERAL_POLICY, recencySlices, type RecencySlice } from './session-turn-literal';

const MIN = 60_000;
const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-10-02T05:00:00Z');

/** Number of slices that contain `ts` (exactly one for a sound tiling). */
const containing = (slices: readonly RecencySlice[], ts: number): number =>
  slices.filter((s) => (s.loMs === null || ts >= s.loMs) && (s.hiMs === null || ts < s.hiMs)).length;

const POLICY_SLICES = recencySlices(
  NOW,
  SESSION_TURN_LITERAL_POLICY.recencyFirstSliceMs,
  SESSION_TURN_LITERAL_POLICY.recencySliceGrowth,
);

describe('recencySlices — tiles all of time, newest first', () => {
  it('is open above on the first slice and open below on the last', () => {
    expect(POLICY_SLICES[0]!.hiMs).toBeNull();
    expect(POLICY_SLICES[POLICY_SLICES.length - 1]!.loMs).toBeNull();
  });

  it('abuts exactly: each slice ends where the previous one starts (no gap, no overlap)', () => {
    for (let i = 1; i < POLICY_SLICES.length; i++) {
      expect(POLICY_SLICES[i]!.hiMs, `slice ${i} hi`).toBe(POLICY_SLICES[i - 1]!.loMs);
    }
    for (const s of POLICY_SLICES.slice(1, -1)) expect(s.loMs! < s.hiMs!).toBe(true);
  });

  it('the newest slice spans exactly the configured first-slice width', () => {
    expect(NOW - POLICY_SLICES[0]!.loMs!).toBe(SESSION_TURN_LITERAL_POLICY.recencyFirstSliceMs);
  });

  it('each older slice is wider than the one before it (geometric growth bounds total work)', () => {
    const interior = POLICY_SLICES.slice(1, -1);
    for (let i = 1; i < interior.length; i++) {
      const prev = interior[i - 1]!.hiMs! - interior[i - 1]!.loMs!;
      const cur = interior[i]!.hiMs! - interior[i]!.loMs!;
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it('reaches the 400-day horizon in a handful of slices, not hundreds', () => {
    expect(POLICY_SLICES.length).toBeLessThan(20);
    // The slice that WOULD cross the horizon becomes the open-below slice, so its upper bound is inside it.
    const lastBound = POLICY_SLICES[POLICY_SLICES.length - 1]!.hiMs!;
    expect(NOW - lastBound).toBeLessThan(400 * DAY);
    expect(NOW - lastBound).toBeGreaterThan(0);
  });

  it.each([
    ['a future-dated (clock-skewed) turn', NOW + 5 * DAY],
    ['right now', NOW],
    ['a boundary instant between the first two slices', POLICY_SLICES[0]!.loMs!],
    ['five minutes ago', NOW - 5 * MIN],
    ['a day ago', NOW - DAY],
    ['a year ago', NOW - 365 * DAY],
    ['beyond the horizon (five years ago)', NOW - 5 * 365 * DAY],
    ['the epoch', 0],
  ])('places %s in exactly ONE slice', (_label, ts) => {
    expect(containing(POLICY_SLICES, ts)).toBe(1);
  });

  it('terminates and still tiles for degenerate inputs (zero width, sub-1.5 growth)', () => {
    for (const [first, growth] of [[0, 1], [-5, 0], [1, 1.1], [MIN, 1.5], [90 * DAY, 4]] as const) {
      const s = recencySlices(NOW, first, growth);
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(s.length).toBeLessThan(10_000);
      for (let i = 1; i < s.length; i++) expect(s[i]!.hiMs).toBe(s[i - 1]!.loMs);
      expect(containing(s, NOW - 3 * DAY)).toBe(1);
    }
  });
});

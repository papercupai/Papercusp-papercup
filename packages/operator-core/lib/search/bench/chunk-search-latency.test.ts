import { describe, expect, it } from 'vitest';
import {
  CHUNK_SEARCH_LATENCY_QUERIES,
  D024_BASELINE_P95_MS,
  D024_LOADAVG_START,
  D024_QUERY_SET_HASH,
  d024LoadMatch,
  percentile,
  querySetHash,
  r33Verdicts,
  summariseSite,
  type LatencySample,
} from './chunk-search-latency';

describe('chunk-search latency bench (R-33, D-024)', () => {
  it('replays the exact 30-query set D-024 recorded its baseline with', () => {
    expect(CHUNK_SEARCH_LATENCY_QUERIES).toHaveLength(30);
    expect(new Set(CHUNK_SEARCH_LATENCY_QUERIES).size).toBe(30);
    expect(querySetHash()).toBe(D024_QUERY_SET_HASH);
  });

  it('control: changing one query or the order moves the hash', () => {
    const edited = [...CHUNK_SEARCH_LATENCY_QUERIES];
    edited[0] = `${edited[0]} `;
    expect(querySetHash(edited)).not.toBe(D024_QUERY_SET_HASH);
    const swapped = [...CHUNK_SEARCH_LATENCY_QUERIES];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(querySetHash(swapped)).not.toBe(D024_QUERY_SET_HASH);
  });

  it('percentile is nearest-rank and empty input has no percentile', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile(xs, 50)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('failed calls count as errors and stay out of the percentiles', () => {
    const samples: LatencySample[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ round: 0, q: i, ms: 100, ok: true, degraded: false })),
      ...Array.from({ length: 10 }, (_, i) => ({ round: 1, q: i, ms: 200, ok: true, degraded: i === 0 })),
      { round: 1, q: 10, ms: 99_999, ok: false, degraded: false, retries: 2, error: 'ECONNRESET' },
    ];
    const s = summariseSite(samples, 2);
    expect(s).toMatchObject({ n: 21, ok: 20, errors: 1, degraded: 1, transportRetries: 2, max: 200 });
    expect(s.p95).toBe(200);
    expect(s.perRoundP95).toEqual([100, 200]);
    expect(s.firstErrors).toEqual(['ECONNRESET']);
  });

  it('R-33 verdict: at the bound passes, over it fails, no sample is not a pass', () => {
    const at = (p95: number | null) => ({ ...summariseSite([], 1), p95 });
    const v = r33Verdicts({
      plans: at(D024_BASELINE_P95_MS.plans * 1.25),
      turns: at(D024_BASELINE_P95_MS.turns * 1.25 + 1),
      work_item: at(null),
    });
    const bySite = Object.fromEntries(v.map((x) => [x.site, x]));
    expect(bySite.plans.withinBound).toBe(true);
    expect(bySite.turns.withinBound).toBe(false);
    expect(bySite.work_item.withinBound).toBeNull();
    expect(bySite.consult.withinBound).toBeNull();
    expect(bySite.work_items_search.bound).toBe(500);
    expect(bySite.consult.bound).toBe(17.5);
  });

  describe('D-038 load match: all three averages within 20% of D-024 at start and end', () => {
    const IN_BAND = [72, 78, 92];

    it('derives the band from D-024s start triple 69.9 / 75.9 / 90.2', () => {
      expect(D024_LOADAVG_START).toEqual([69.9, 75.9, 90.2]);
      const { band } = d024LoadMatch(IN_BAND, IN_BAND);
      expect(band).toEqual({
        '1m': { min: 55.9, max: 83.9 },
        '5m': { min: 60.7, max: 91.1 },
        '15m': { min: 72.2, max: 108.2 },
      });
    });

    it('matches when every average is in band at both ends', () => {
      const m = d024LoadMatch(IN_BAND, [80, 85, 100]);
      expect(m.matched).toBe(true);
      expect(m.outOfBand).toEqual([]);
    });

    it('rejects attempt 5 (1-min in the old 57..86 band, 5/15-min far above)', () => {
      // Recorded loadavgStart/End of .papercusp/scratch/rag-carry/r33-attempts/attempt-5-021058Z.json.
      const m = d024LoadMatch([85.45, 110.13, 128.41], [103.46, 113.6, 121.77]);
      expect(m.matched).toBe(false);
      expect(m.outOfBand).toContain('start 5m 110.1 > 91.1');
      expect(m.outOfBand).toContain('start 15m 128.4 > 108.2');
      expect(m.outOfBand).toContain('end 1m 103.5 > 83.9');
    });

    it('rejects a run that leaves the band only at the end', () => {
      const m = d024LoadMatch(IN_BAND, [70, 95, 100]);
      expect(m.matched).toBe(false);
      expect(m.outOfBand).toEqual(['end 5m 95 > 91.1']);
    });

    it('rejects load below the band and a missing average', () => {
      const m = d024LoadMatch([40, 78, 92], [72, 78]);
      expect(m.matched).toBe(false);
      expect(m.outOfBand).toEqual(['start 1m 40 < 55.9', 'end 15m missing']);
    });
  });
});

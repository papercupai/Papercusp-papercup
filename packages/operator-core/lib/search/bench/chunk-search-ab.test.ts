import { describe, expect, it } from 'vitest';
import { D024_BASELINE_P95_MS } from './chunk-search-latency';
import {
  D024_LOAD_1MIN,
  R33_AB_ARMS,
  R33_AB_LOAD_BAND,
  R33_AB_NOISE_FLOOR_MS,
  R33_AB_NULL_RUNS,
  R33_AB_SITES,
  armOrder,
  inR33AbLoadBand,
  r33AbBudgetMs,
  r33AbLoadCheck,
  r33AbNoiseFloorMs,
  r33AbNullSpreads,
  r33AbPasses,
  r33AbVerdicts,
  summarisePaired,
  type PairedSample,
  type PairedSummary,
  type R33AbSite,
} from './chunk-search-ab';

/** 20 pairs: A takes aMs, B takes bMs, both return `rows` rows. */
function pairs(aMs: number, bMs: number, rows = 30, round = 0): PairedSample[] {
  return Array.from({ length: 20 }, (_, q) => ({ round, q, aMs, bMs, aRows: rows, bRows: rows }));
}

describe('chunk-search same-time A/B (R-33, D-040)', () => {
  it('budgets are max(0.25 x the D-024 baseline p95, the site D-042 noise floor)', () => {
    for (const site of R33_AB_SITES) {
      const quarter = Math.round(0.25 * D024_BASELINE_P95_MS[site] * 10) / 10;
      expect(r33AbBudgetMs(site)).toBe(Math.max(quarter, R33_AB_NOISE_FLOOR_MS[site] ?? 0));
    }
    // The 0.25x part, which D-042 keeps unchanged from D-040.
    expect(Object.fromEntries(R33_AB_SITES.map((s) => [s, Math.round(0.25 * D024_BASELINE_P95_MS[s] * 10) / 10]))).toEqual({
      plans: 413,
      turns: 348,
      work_item: 402.3,
      work_items_search: 100,
      consult: 3.5,
    });
  });

  it('D-042 withdrew the fixed 10 ms floor: every floor is a measured, positive per-site value', () => {
    for (const [site, floor] of Object.entries(R33_AB_NOISE_FLOOR_MS)) {
      expect(R33_AB_SITES as readonly string[]).toContain(site);
      expect(Number.isFinite(floor) && (floor as number) > 0).toBe(true);
    }
    // A pinned table covers every site or none: a partial table would mean a site skipped its null runs.
    expect([0, R33_AB_SITES.length]).toContain(Object.keys(R33_AB_NOISE_FLOOR_MS).length);
  });

  it('D-043 pins the floors measured by the 5 null runs, and they leave every budget at 0.25x', () => {
    // The per-run spreads recorded in p016-r33-null-runs.json, reduced by D-042's rule.
    const spreads: Record<string, number[]> = {
      plans: [1.7, 0.7, 0.4, 0.4, 1.3],
      turns: [4.5, 4, 14.5, 4.3, 15.9],
      work_item: [1, 1.1, 0.8, 2.5, 4.6],
      work_items_search: [1, 1.5, 1.2, 0.4, 0.9],
      consult: [0.2, 0.3, 0.2, 0.1, 1.9],
    };
    expect(Object.fromEntries(R33_AB_SITES.map((s) => [s, r33AbNoiseFloorMs(spreads[s])]))).toEqual(R33_AB_NOISE_FLOOR_MS);
    expect(R33_AB_NOISE_FLOOR_MS).toEqual({ plans: 1.7, turns: 15.9, work_item: 4.6, work_items_search: 1.5, consult: 1.9 });
    expect(Object.fromEntries(R33_AB_SITES.map((s) => [s, r33AbBudgetMs(s)]))).toEqual({
      plans: 413,
      turns: 348,
      work_item: 402.3,
      work_items_search: 100,
      consult: 3.5,
    });
  });

  describe('noise floor (D-042)', () => {
    it('is the largest absolute spread over exactly R33_AB_NULL_RUNS runs, rounded up to 0.1 ms', () => {
      expect(R33_AB_NULL_RUNS).toBe(5);
      expect(r33AbNoiseFloorMs([1.2, -3.41, 0.3, 2, 3.4])).toBe(3.5);
      expect(r33AbNoiseFloorMs([0.1, 0.2, 0.1 * 3, 0, 0])).toBe(0.3);
      expect(r33AbNoiseFloorMs([6.3, 1, 1, 1, 1])).toBe(6.3);
    });

    it('refuses any other number of runs, or a non-finite spread', () => {
      expect(() => r33AbNoiseFloorMs([1, 2, 3, 4])).toThrow(/exactly 5/);
      expect(() => r33AbNoiseFloorMs([1, 2, 3, 4, 5, 6])).toThrow(/exactly 5/);
      expect(() => r33AbNoiseFloorMs([1, 2, 3, 4, Number.NaN])).toThrow(/finite/);
    });

    it('a null run reports |p95(A2) - p95(A1)| per site and voids an invalid site', () => {
      const ok = (aMs: number, a2Ms: number) => summarisePaired(pairs(aMs, a2Ms));
      const errored = summarisePaired([
        ...pairs(10, 11),
        { round: 1, q: 0, aMs: 1, bMs: 1, aRows: 1, bRows: 1, bError: 'statement timeout' },
      ]);
      const spreads = r33AbNullSpreads({
        plans: ok(100, 103),
        turns: ok(100, 96.5),
        work_item: ok(50, 50),
        work_items_search: errored,
        consult: ok(14, 14.4),
      });
      expect(spreads.map((s) => [s.site, s.spread])).toEqual([
        ['plans', 3],
        ['turns', 3.5],
        ['work_item', 0],
        ['work_items_search', null],
        ['consult', 0.4],
      ]);
      expect(spreads[3].invalidReason).toContain('statement timeout');
    });
  });

  it('every site has a baseline, a budget and a described A and B arm', () => {
    for (const site of R33_AB_SITES) {
      expect(D024_BASELINE_P95_MS[site]).toBeGreaterThan(0);
      expect(R33_AB_ARMS[site].a.length).toBeGreaterThan(0);
      expect(R33_AB_ARMS[site].b.length).toBeGreaterThan(0);
    }
    expect(Object.keys(R33_AB_ARMS).sort()).toEqual([...R33_AB_SITES].sort());
  });

  it('arm order alternates per pair, so each arm goes first in half the pairs', () => {
    let aFirst = 0;
    for (let r = 0; r < 3; r++) for (let q = 0; q < 30; q++) if (armOrder(r, q)[0] === 'A') aFirst++;
    expect(aFirst).toBe(45);
    expect(armOrder(0, 0)).toEqual(['A', 'B']);
    expect(armOrder(0, 1)).toEqual(['B', 'A']);
    // A new round flips the order a query saw in the previous round.
    expect(armOrder(1, 0)).toEqual(['B', 'A']);
  });

  it('the reading is B p95 minus A p95, with paired median delta and ratio', () => {
    const samples = [...pairs(10, 16), ...pairs(20, 30, 30, 1)];
    const s = summarisePaired(samples);
    expect(s).toMatchObject({ n: 40, pairs: 40, aErrors: 0, bErrors: 0, bEmptyWhereAHadRows: 0 });
    expect(s.a.p95).toBe(20);
    expect(s.b.p95).toBe(30);
    expect(s.addedP95).toBe(10);
    // Deltas are 6 x20 and 10 x20; nearest-rank median picks the 20th of 40.
    expect(s.pairedMedianDeltaMs).toBe(6);
    expect(s.pairedMedianRatio).toBe(1.5);
  });

  it('an errored pair stays out of the percentiles and is counted per arm', () => {
    const samples: PairedSample[] = [
      ...pairs(10, 12),
      { round: 1, q: 0, aMs: 9_000, bMs: 1, aRows: 0, bRows: 0, bError: 'connection reset' },
    ];
    const s = summarisePaired(samples);
    expect(s).toMatchObject({ n: 21, pairs: 20, aErrors: 0, bErrors: 1 });
    expect(s.a.max).toBe(10);
    expect(s.firstErrors).toEqual(['B: connection reset']);
  });

  it('top-hit agreement counts only pairs that recorded both tops', () => {
    const samples = pairs(10, 12).map((p, i) => ({
      ...p,
      ...(i < 10 ? { aTop: `x${i}`, bTop: i < 7 ? `x${i}` : 'other' } : {}),
    }));
    samples[0] = { ...samples[0], aTop: null, bTop: null }; // both empty agree
    expect(summarisePaired(samples).topHitAgreement).toEqual({ compared: 10, same: 7 });
    expect(summarisePaired(pairs(1, 1)).topHitAgreement).toEqual({ compared: 0, same: 0 });
  });

  it('counts pairs where B came back empty but A had rows', () => {
    const samples = pairs(10, 2);
    samples[3] = { ...samples[3], bRows: 0 };
    samples[4] = { ...samples[4], aRows: 0, bRows: 0 }; // both empty: not a B failure
    expect(summarisePaired(samples).bEmptyWhereAHadRows).toBe(1);
  });

  describe('verdicts', () => {
    const at = (addedP95: number): PairedSummary => {
      const s = summarisePaired(pairs(100, 100 + addedP95));
      expect(s.addedP95).toBe(addedP95);
      return s;
    };
    const valid = (over: Partial<Record<R33AbSite, PairedSummary>>) => ({
      plans: at(6),
      turns: at(47),
      work_item: at(9),
      work_items_search: at(67),
      consult: at(6.3),
      ...over,
    });

    it('judges the D-040 measurements against the current budgets', () => {
      const v = r33AbVerdicts(valid({}));
      const consultBudget = r33AbBudgetMs('consult');
      expect(v.map((x) => x.withinBudget)).toEqual([true, true, true, true, 6.3 <= consultBudget]);
      expect(r33AbPasses(v)).toBe(6.3 <= consultBudget);
    });

    it('at the budget passes; one tenth of a millisecond over fails', () => {
      const v = r33AbVerdicts(valid({ consult: at(r33AbBudgetMs('consult')), plans: at(413.1) }));
      const bySite = Object.fromEntries(v.map((x) => [x.site, x]));
      expect(bySite.consult.withinBudget).toBe(true);
      expect(bySite.plans.withinBudget).toBe(false);
      expect(r33AbPasses(v)).toBe(false);
    });

    it('a missing site, an errored call or a silently empty B arm is invalid, never a pass', () => {
      const errored = summarisePaired([
        ...pairs(10, 11),
        { round: 1, q: 0, aMs: 1, bMs: 1, aRows: 1, bRows: 0, aError: 'statement timeout' },
      ]);
      const emptyB = summarisePaired(pairs(10, 1).map((p, i) => (i === 0 ? { ...p, bRows: 0 } : p)));
      const { consult: _omit, ...withoutConsult } = valid({ turns: errored, work_item: emptyB });
      const v = r33AbVerdicts(withoutConsult);
      const bySite = Object.fromEntries(v.map((x) => [x.site, x]));
      expect(bySite.consult).toMatchObject({ withinBudget: null, invalidReason: 'no completed pair' });
      expect(bySite.turns.withinBudget).toBeNull();
      expect(bySite.turns.invalidReason).toContain('statement timeout');
      expect(bySite.work_item.withinBudget).toBeNull();
      expect(bySite.work_item.invalidReason).toContain('B returned no rows in 1 pair');
      expect(bySite.plans.withinBudget).toBe(true);
      expect(r33AbPasses(v)).toBe(false);
    });
  });

  describe('load band (D-041)', () => {
    it('is +/-20% of the 1-min load D-024 was measured at', () => {
      expect(D024_LOAD_1MIN).toBe(69.9);
      expect(R33_AB_LOAD_BAND).toEqual({ low: 55.9, high: 83.9 });
    });

    it('is two-sided: a box quieter than D-024 does not count either', () => {
      expect(inR33AbLoadBand(55.9)).toBe(true);
      expect(inR33AbLoadBand(83.9)).toBe(true);
      expect(inR33AbLoadBand(55.8)).toBe(false);
      expect(inR33AbLoadBand(84)).toBe(false);
      expect(inR33AbLoadBand(Number.NaN)).toBe(false);
    });

    it('gates the 1-min average at both ends of the rounds, ignoring the 5- and 15-min ones', () => {
      expect(r33AbLoadCheck([70, 140, 140], [80, 140, 140]).matched).toBe(true);
      // Run 1 (2026-10-02 11:15Z): in band at neither end.
      const run1 = r33AbLoadCheck([93.65, 93.28, 87.35], [130.89, 104.26, 91.69]);
      expect(run1.matched).toBe(false);
      expect(run1.reason).toMatch(/start 93\.65/);
      const endOut = r33AbLoadCheck([70, 70, 70], [90, 70, 70]);
      expect(endOut.matched).toBe(false);
      expect(endOut.reason).toMatch(/end 90/);
      expect(r33AbLoadCheck([], []).matched).toBe(false);
    });
  });
});

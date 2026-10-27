/**
 * WI-41147 — burn-rate governor: retention (account-pool `history7d`), the pure rate
 * estimator, and the verdict ladder. All pure; no IO.
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_7D_MAX_SAMPLES,
  HISTORY_7D_MIN_SPACING_MS,
  accountBurnAction,
  accountGatewayBurnAction,
  accountBurnTransition,
  accountBurnVerdict,
  appendUtilization7dSample,
  recordAccountWindow,
  registerAccount,
  selectAccountForSpawn,
  type AccountPool,
} from '../deployment/account-pool';
import {
  BURN_EXHAUSTED_UTIL,
  DEFAULT_BURN_POLICY,
  accountBurnSamples,
  aggregatePoolBurn,
  renderPoolBurnLabel,
  estimateBurnRatePerHr,
  evaluateAccountBurn,
  evaluateBurn,
  renderBurnVerdictLabel,
  type BurnSample,
} from './burn-governor';
import { accountLoadKey } from './account-failover';

const T0 = 1_800_000_000_000; // fixed epoch base
const MIN = 60_000;
const HR = 60 * MIN;

function samplesAt(pairs: [offsetMs: number, u: number][]): BurnSample[] {
  return pairs.map(([off, u]) => ({ at: T0 + off, u }));
}

// ── Retention: appendUtilization7dSample ─────────────────────────────────────

describe('appendUtilization7dSample', () => {
  it('appends a first sample to an undefined history', () => {
    expect(appendUtilization7dSample(undefined, { at: T0, u: 0.5 })).toEqual([{ at: T0, u: 0.5 }]);
  });

  it('appends when spacing >= HISTORY_7D_MIN_SPACING_MS', () => {
    const h = [{ at: T0, u: 0.5 }];
    const next = appendUtilization7dSample(h, { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.51 });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.51 });
  });

  it('skips a sample closer than the spacing floor (keeps the OLD point — freshest lives on the rate fields)', () => {
    const h = [{ at: T0, u: 0.5 }];
    const next = appendUtilization7dSample(h, { at: T0 + HISTORY_7D_MIN_SPACING_MS - 1, u: 0.9 });
    expect(next).toEqual([{ at: T0, u: 0.5 }]);
  });

  it('skips an out-of-order (clock-skew) sample', () => {
    const h = [{ at: T0, u: 0.5 }];
    expect(appendUtilization7dSample(h, { at: T0 - HR, u: 0.4 })).toEqual([{ at: T0, u: 0.5 }]);
  });

  it('caps at HISTORY_7D_MAX_SAMPLES, trimming the OLDEST', () => {
    let h: BurnSample[] | undefined;
    const n = HISTORY_7D_MAX_SAMPLES + 10;
    for (let i = 0; i < n; i++) {
      h = appendUtilization7dSample(h, { at: T0 + i * HISTORY_7D_MIN_SPACING_MS, u: i / n });
    }
    expect(h).toHaveLength(HISTORY_7D_MAX_SAMPLES);
    expect(h![0]!.at).toBe(T0 + 10 * HISTORY_7D_MIN_SPACING_MS); // oldest 10 trimmed
    expect(h![h!.length - 1]!.at).toBe(T0 + (n - 1) * HISTORY_7D_MIN_SPACING_MS);
  });

  it('drops non-finite junk from a hand-edited persisted row', () => {
    const junk = [
      { at: Number.NaN, u: 0.5 },
      { at: T0, u: Number.POSITIVE_INFINITY },
      { at: T0, u: 0.5 },
      null as unknown as BurnSample,
    ];
    const next = appendUtilization7dSample(junk, { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.6 });
    expect(next).toEqual([
      { at: T0, u: 0.5 },
      { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.6 },
    ]);
  });

  it('refuses a non-finite NEW sample (returns the cleaned history unchanged)', () => {
    const h = [{ at: T0, u: 0.5 }];
    expect(appendUtilization7dSample(h, { at: T0 + HR, u: Number.NaN })).toEqual(h);
  });
});

// ── Retention: recordAccountWindow wiring ────────────────────────────────────

describe('recordAccountWindow history7d retention', () => {
  function poolWithOne(): AccountPool {
    return registerAccount({ accounts: [] }, { id: 'a1', credentialRef: 'cred-a1' }, T0 - HR);
  }

  it('a 7d observation appends to history7d', () => {
    let pool = poolWithOne();
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.45 }, T0 + HISTORY_7D_MIN_SPACING_MS);
    expect(pool.accounts[0]!.rate.history7d).toEqual([
      { at: T0, u: 0.4 },
      { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.45 },
    ]);
  });

  it('a 5h-only observation leaves history7d untouched (no stale-value flattening)', () => {
    let pool = poolWithOne();
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4 }, T0);
    pool = recordAccountWindow(pool, 'a1', { utilization: 0.7 }, T0 + HR);
    expect(pool.accounts[0]!.rate.history7d).toEqual([{ at: T0, u: 0.4 }]);
    // ...while the freshest-stamp still advances (existing behavior, unchanged):
    expect(pool.accounts[0]!.rate.utilizationAt).toBe(T0 + HR);
  });

  it('unknown id is a no-op (existing contract preserved)', () => {
    const pool = poolWithOne();
    expect(recordAccountWindow(pool, 'nope', { utilization7d: 0.4 }, T0)).toEqual(pool);
  });
});

// ── Estimator ────────────────────────────────────────────────────────────────

describe('estimateBurnRatePerHr', () => {
  const now = T0 + 2 * HR;

  it('null on undefined / empty / single-sample history', () => {
    expect(estimateBurnRatePerHr(undefined, now)).toBeNull();
    expect(estimateBurnRatePerHr([], now)).toBeNull();
    expect(estimateBurnRatePerHr(samplesAt([[0, 0.5]]), now)).toBeNull();
  });

  it('two clean points an hour apart → exact slope', () => {
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [0, 0.5],
        [HR, 0.6],
      ]),
      now,
    );
    expect(rate).toBeCloseTo(0.1, 10);
  });

  it('least-squares over noisy points recovers the underlying trend', () => {
    // 0.05/hr underlying with ±0.005 alternating noise across 2h of 15-min samples.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const at = i * 15 * MIN;
      pts.push([at, 0.5 + (0.05 * at) / HR + (i % 2 === 0 ? 0.005 : -0.005)]);
    }
    const rate = estimateBurnRatePerHr(samplesAt(pts), now);
    expect(rate).toBeGreaterThan(0.045);
    expect(rate).toBeLessThan(0.055);
  });

  it('negative slope (decaying window) is returned as-is, not clamped', () => {
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [0, 0.6],
        [HR, 0.5],
      ]),
      now,
    );
    expect(rate).toBeCloseTo(-0.1, 10);
  });

  it('null when the usable span is below minSpanMs', () => {
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [0, 0.5],
        [DEFAULT_BURN_POLICY.minSpanMs - 1, 0.6],
      ]),
      T0 + DEFAULT_BURN_POLICY.minSpanMs,
    );
    expect(rate).toBeNull();
  });

  it('samples outside the lookback are excluded (stale trend cannot leak in)', () => {
    // Two old points showing a huge slope + one fresh point: only ≥2 in-lookback samples count.
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [-30 * HR, 0.1],
        [-29 * HR, 0.9],
        [0, 0.5],
      ]),
      T0,
    );
    expect(rate).toBeNull(); // one usable sample after lookback filtering
  });

  it('future-dated and non-finite samples are dropped', () => {
    const rate = estimateBurnRatePerHr(
      [
        { at: T0, u: 0.5 },
        { at: T0 + HR, u: 0.6 },
        { at: now + HR, u: 0.99 }, // future — dropped
        { at: Number.NaN, u: 0.7 }, // junk — dropped
        { at: T0 + 30 * MIN, u: Number.NaN }, // junk — dropped
      ],
      now,
    );
    expect(rate).toBeCloseTo(0.1, 10);
  });

  it('duplicate timestamps are collapsed (freshest reading re-appended over its retained twin)', () => {
    const rate = estimateBurnRatePerHr(
      [
        { at: T0, u: 0.5 },
        { at: T0 + HR, u: 0.6 },
        { at: T0 + HR, u: 0.6 },
      ],
      now,
    );
    expect(rate).toBeCloseTo(0.1, 10);
  });
});

// ── accountBurnSamples ───────────────────────────────────────────────────────

describe('accountBurnSamples', () => {
  it('appends the freshest reading the spacing floor skipped', () => {
    const s = accountBurnSamples({
      history7d: [{ at: T0, u: 0.5 }],
      utilization7d: 0.52,
      utilizationAt: T0 + 2 * MIN, // closer than the floor — lives only on the rate fields
    });
    expect(s).toEqual([
      { at: T0, u: 0.5 },
      { at: T0 + 2 * MIN, u: 0.52 },
    ]);
  });

  it('tolerates a partially-hydrated row (no history, no reading)', () => {
    expect(accountBurnSamples({})).toEqual([]);
    expect(accountBurnSamples({ utilization7d: 0.5 })).toEqual([]); // no utilizationAt stamp → unusable
  });
});

// ── Verdict ladder ───────────────────────────────────────────────────────────

describe('evaluateBurn', () => {
  const now = T0;

  it('no reading → none, headroom null, reason names the gap', () => {
    const v = evaluateBurn({ utilization7d: undefined, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('none');
    expect(v.headroomFraction).toBeNull();
    expect(v.projectedExhaustionAt).toBeNull();
    expect(v.reason).toMatch(/no 7d utilization reading/);
  });

  it('already at the wall (u = 1.0) → shed, projectedExhaustionAt = now', () => {
    const v = evaluateBurn({ utilization7d: 1.0, windowResetAt7d: now + 24 * HR, burnRatePerHr: null, now });
    expect(v.action).toBe('shed');
    expect(v.projectedExhaustionAt).toBe(now);
    expect(v.headroomFraction).toBe(0);
    expect(v.reason).toMatch(/already exhausted/);
  });

  it('over the wall (u > 1.0) with unknown reset → shed, reason says reset unknown', () => {
    const v = evaluateBurn({ utilization7d: 1.05, burnRatePerHr: 0.2, now });
    expect(v.action).toBe('shed');
    expect(v.exhaustsBeforeReset).toBe(false);
    expect(v.reason).toMatch(/reset unknown/);
  });

  it('insufficient history (rate null) → none, never act on missing data', () => {
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: null, now });
    expect(v.action).toBe('none');
    expect(v.burnRatePerHr).toBeNull();
    expect(v.reason).toMatch(/insufficient burn history/);
  });

  it('zero rate → none (flat)', () => {
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: 0, now });
    expect(v.action).toBe('none');
    expect(v.projectedExhaustionAt).toBeNull();
  });

  it('negative rate (decaying) → none, rate reported unclamped', () => {
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: -0.05, now });
    expect(v.action).toBe('none');
    expect(v.burnRatePerHr).toBe(-0.05);
    expect(v.reason).toMatch(/flat or decaying/);
  });

  it('exhausts BEFORE reset, beyond the imminent horizon → throttle', () => {
    // u=0.5, rate=0.1/hr → exhausts in 5h; reset in 24h; horizon 2h.
    const v = evaluateBurn({ utilization7d: 0.5, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('throttle');
    expect(v.exhaustsBeforeReset).toBe(true);
    expect(v.projectedExhaustionAt).toBeCloseTo(now + 5 * HR, -3);
    expect(v.reason).toMatch(/BEFORE the window resets/);
  });

  it('exhausts BEFORE reset AND inside the imminent horizon → shed', () => {
    // u=0.9, rate=0.1/hr → exhausts in 1h; reset in 24h; horizon 2h.
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('shed');
    expect(v.exhaustsBeforeReset).toBe(true);
    expect(v.reason).toMatch(/imminent horizon/);
  });

  it('exhausts AFTER the reset → none (the reset relieves first)', () => {
    // u=0.9, rate=0.05/hr → exhausts in 2h; reset in 1h.
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: 0.05, now });
    expect(v.action).toBe('none');
    expect(v.exhaustsBeforeReset).toBe(false);
    expect(v.reason).toMatch(/AFTER the window resets/);
  });

  it('reset in the PAST is stale → not exhaustsBeforeReset; imminent projection still throttles', () => {
    // u=0.9, rate=0.1/hr → exhausts in 1h (imminent); observed reset is behind the clock.
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now - HR, burnRatePerHr: 0.1, now });
    expect(v.exhaustsBeforeReset).toBe(false);
    expect(v.action).toBe('throttle');
    expect(v.reason).toMatch(/in the past — stale/);
  });

  it('reset never observed + imminent projection → throttle, reason says never observed', () => {
    const v = evaluateBurn({ utilization7d: 0.9, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('throttle');
    expect(v.reason).toMatch(/never observed/);
  });

  it('reset never observed + far-off projection → none', () => {
    // u=0.2, rate=0.01/hr → exhausts in 80h.
    const v = evaluateBurn({ utilization7d: 0.2, burnRatePerHr: 0.01, now });
    expect(v.action).toBe('none');
    expect(v.reason).toMatch(/outside the .* imminent horizon/);
  });

  it('every verdict carries a non-empty reason (never silent)', () => {
    const cases = [
      { utilization7d: undefined, burnRatePerHr: null, now },
      { utilization7d: 1.2, burnRatePerHr: null, now },
      { utilization7d: 0.5, burnRatePerHr: null, now },
      { utilization7d: 0.5, burnRatePerHr: -0.1, now },
      { utilization7d: 0.5, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now },
      { utilization7d: 0.99, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.5, now },
    ];
    for (const c of cases) expect(evaluateBurn(c).reason.length).toBeGreaterThan(10);
  });
});

// ── End-to-end pure composition ──────────────────────────────────────────────

describe('evaluateAccountBurn (composition over a rate-shaped row)', () => {
  it('incident replay: steady 2h climb toward the wall with a far reset → shed before the wall', () => {
    // 0.80 → 0.92 over 2h (0.06/hr) with the freshest reading only on the rate fields;
    // reset 30h out. Time to exhaustion ≈ 1.33h < 2h horizon → shed. This is the verdict
    // that did NOT exist during the 2026-08-23 exhaustion incident.
    const now = T0 + 2 * HR + 2 * MIN;
    const v = evaluateAccountBurn(
      {
        history7d: [
          { at: T0, u: 0.8 },
          { at: T0 + 40 * MIN, u: 0.84 },
          { at: T0 + 80 * MIN, u: 0.88 },
          { at: T0 + 2 * HR, u: 0.92 },
        ],
        utilization7d: 0.921,
        utilizationAt: now - MIN,
        windowResetAt7d: T0 + 30 * HR,
      },
      now,
    );
    expect(v.action).toBe('shed');
    expect(v.exhaustsBeforeReset).toBe(true);
    expect(v.burnRatePerHr).toBeGreaterThan(0.05);
  });

  it('healthy account: slow climb, reset well before projection → none', () => {
    const now = T0 + 2 * HR;
    const v = evaluateAccountBurn(
      {
        history7d: [
          { at: T0, u: 0.3 },
          { at: T0 + HR, u: 0.31 },
          { at: T0 + 2 * HR, u: 0.32 },
        ],
        utilization7d: 0.32,
        utilizationAt: now,
        windowResetAt7d: now + 20 * HR,
      },
      now,
    );
    expect(v.action).toBe('none');
  });

  it('no history at all → none (insufficient), matching BURN_EXHAUSTED_UTIL wall override', () => {
    const now = T0;
    expect(evaluateAccountBurn({ utilization7d: 0.5, utilizationAt: now }, now).action).toBe('none');
    // ...but a walled reading sheds even with zero history:
    expect(evaluateAccountBurn({ utilization7d: BURN_EXHAUSTED_UTIL, utilizationAt: now }, now).action).toBe('shed');
  });
});

// ── Stale gate + selection wiring (WI-41147 legs a/d) ────────────────────────

describe('accountBurnVerdict stale gate', () => {
  it('never-observed reading → none, governor stands down', () => {
    const v = accountBurnVerdict({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 }, T0);
    expect(v.action).toBe('none');
    expect(v.reason).toMatch(/never observed/);
  });

  it('stale reading (past DRAIN_UTIL_STALE_MS) → none even on an alarming trajectory', () => {
    const rate = {
      pausedUntil: 0,
      lastPenaltyAt: 0,
      penaltyCount: 0,
      windowStartedAt: 0,
      history7d: [
        { at: T0 - 2 * HR, u: 0.9 },
        { at: T0 - HR, u: 0.98 },
      ],
      utilization7d: 0.98,
      utilizationAt: T0 - HR, // 1h old ≫ 10min staleness window
      windowResetAt7d: T0 + 24 * HR,
    };
    const v = accountBurnVerdict(rate, T0);
    expect(v.action).toBe('none');
    expect(v.reason).toMatch(/stale/);
    // ...while the SAME row with a fresh stamp sheds:
    expect(accountBurnVerdict({ ...rate, utilizationAt: T0 }, T0).action).toBe('shed');
  });
});

// ── P-001: the DISPOSITION — a pacing projection is not a measured wall ──────

describe('burn verdict disposition (P-001)', () => {
  const now = T0;

  it('a wall the provider METERED is disposition measured-wall, with the reading echoed', () => {
    const v = evaluateBurn({ utilization7d: 1.0, windowResetAt7d: now + 24 * HR, burnRatePerHr: null, now });
    expect(v.action).toBe('shed');
    expect(v.disposition).toBe('measured-wall');
    expect(v.utilization7d).toBe(1.0);
    expect(renderBurnVerdictLabel(v)).toBe('USAGE-WALLED (measured; util7d 1.00)');
  });

  it('a shed derived from the PROJECTION is disposition pacing-projection, and says so', () => {
    const v = evaluateBurn({ utilization7d: 0.99, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.5, now });
    expect(v.action).toBe('shed');
    expect(v.disposition).toBe('pacing-projection');
    const label = renderBurnVerdictLabel(v);
    expect(label).toContain('pacing projection, not a measured wall');
    expect(label).toContain('util7d 0.99');
    expect(label).toContain('projected exhaustion before reset');
    expect(label).not.toContain('USAGE-WALLED');
  });

  it('a throttle beyond the imminent horizon is also a pacing projection', () => {
    const v = evaluateBurn({ utilization7d: 0.58, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('throttle');
    expect(v.disposition).toBe('pacing-projection');
    expect(renderBurnVerdictLabel(v)).toContain('THROTTLE (pacing projection, not a measured wall; util7d 0.58');
  });

  it('a throttle with no usable reset names THAT basis instead of the reset', () => {
    const v = evaluateBurn({ utilization7d: 0.9, burnRatePerHr: 0.5, now });
    expect(v.action).toBe('throttle');
    expect(v.disposition).toBe('pacing-projection');
    expect(renderBurnVerdictLabel(v)).toContain('no usable window reset');
  });

  it('no action asserted → no-verdict, and the label says no wall was asserted', () => {
    const noReading = evaluateBurn({ utilization7d: undefined, burnRatePerHr: 0.1, now });
    expect(noReading.disposition).toBe('no-verdict');
    expect(noReading.utilization7d).toBeNull();
    expect(renderBurnVerdictLabel(noReading)).toBe('NONE (no wall asserted; util7d unknown)');

    const decaying = evaluateBurn({ utilization7d: 0.5, burnRatePerHr: -0.1, now });
    expect(decaying.disposition).toBe('no-verdict');
    expect(decaying.utilization7d).toBe(0.5); // the reading is still echoed
  });

  it('every verdict on the ladder carries a disposition (the class cannot silently return)', () => {
    const cases = [
      { utilization7d: undefined, burnRatePerHr: null, now },
      { utilization7d: 1.2, burnRatePerHr: null, now },
      { utilization7d: 0.5, burnRatePerHr: null, now },
      { utilization7d: 0.5, burnRatePerHr: -0.1, now },
      { utilization7d: 0.5, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now },
      { utilization7d: 0.99, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.5, now },
      { utilization7d: 0.9, burnRatePerHr: 0.5, now },
      { utilization7d: 0.5, windowResetAt7d: now + 10 * MIN, burnRatePerHr: 0.01, now },
    ];
    for (const c of cases) {
      const v = evaluateBurn(c);
      expect(['measured-wall', 'pacing-projection', 'no-verdict']).toContain(v.disposition);
      // A verdict that ACTS always states which of the two it rests on.
      if (v.action !== 'none') expect(v.disposition).not.toBe('no-verdict');
      expect(renderBurnVerdictLabel(v).length).toBeGreaterThan(10);
    }
  });

  it('THE FALSIFIER: a STALE reading at/over the wall is no-verdict, NOT measured-wall', () => {
    // This is why `disposition` is stamped at the deciding branch and never re-derived by a
    // reader from `utilization7d >= 1`: the stale gate stands the governor DOWN while still
    // carrying a reading of 1.00. A derived predicate would report a measured wall here — the
    // exact confident-but-wrong capacity claim P-001 exists to stop.
    const walled = {
      pausedUntil: 0,
      lastPenaltyAt: 0,
      penaltyCount: 0,
      windowStartedAt: 0,
      utilization7d: 1.0,
      utilizationAt: T0 - HR, // ≫ DRAIN_UTIL_STALE_MS
      windowResetAt7d: T0 + 24 * HR,
    };
    const stale = accountBurnVerdict(walled, T0);
    expect(stale.action).toBe('none');
    expect(stale.utilization7d).toBe(1.0); // the reading IS carried…
    expect(stale.disposition).toBe('no-verdict'); // …but no wall is asserted from it
    expect(renderBurnVerdictLabel(stale)).not.toContain('USAGE-WALLED');

    // The SAME row, freshly stamped, is a measured wall.
    const fresh = accountBurnVerdict({ ...walled, utilizationAt: T0 }, T0);
    expect(fresh.disposition).toBe('measured-wall');
    expect(renderBurnVerdictLabel(fresh)).toBe('USAGE-WALLED (measured; util7d 1.00)');
  });

  it('a transition carries the disposition + label of the verdict it transitioned TO', () => {
    const before = registerAccount({ accounts: [] }, { id: 'a1', credentialRef: 'c1' }, T0 - HR);
    const seeded = recordAccountWindow(before, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    const after = recordAccountWindow(seeded, 'a1', { utilization7d: 0.7 }, T0 + HR);
    const t = accountBurnTransition(seeded, after, 'a1', T0 + HR);
    expect(t).not.toBeNull();
    expect(t!.disposition).toBe('pacing-projection');
    expect(t!.label).toContain('pacing projection, not a measured wall');
    expect(t!.label).toContain('util7d 0.70');
  });
});

describe('selectAccountForSpawn burn wiring', () => {
  // Build a 2-account pool: `bad` has MORE 5h headroom (would win the drain) but a burn
  // trajectory; `ok` is flat. Selection at T0+35min keeps the last reading fresh (<10min).
  const SEL_NOW = T0 + 35 * MIN;

  function poolWith(badTrajectory: { u0: number; u1: number; resetAt?: number }): AccountPool {
    let pool: AccountPool = { accounts: [] };
    pool = registerAccount(pool, { id: 'bad', credentialRef: 'cred-bad' }, T0 - HR);
    pool = registerAccount(pool, { id: 'ok', credentialRef: 'cred-ok' }, T0 - HR);
    // `bad`: low 5h util (drain-attractive), climbing 7d util.
    pool = recordAccountWindow(
      pool,
      'bad',
      { utilization: 0.1, utilization7d: badTrajectory.u0, windowResetAt7d: badTrajectory.resetAt },
      T0,
    );
    pool = recordAccountWindow(pool, 'bad', { utilization: 0.1, utilization7d: badTrajectory.u1 }, T0 + 30 * MIN);
    // `ok`: higher 5h util (drain-unattractive), flat 7d.
    pool = recordAccountWindow(pool, 'ok', { utilization: 0.5, utilization7d: 0.5, windowResetAt7d: T0 + 24 * HR }, T0);
    pool = recordAccountWindow(pool, 'ok', { utilization: 0.5, utilization7d: 0.5 }, T0 + 30 * MIN);
    return pool;
  }

  it('a SHED-trajectory account is refused the hard pin — at LOW absolute utilization, where the drain selector alone would still pick it', () => {
    // 0.31 → 0.45 in 30min = 0.28/hr → exhausts in ~1.96h (imminent), reset 24h out → shed.
    // Effective drain util for `bad` = max(0.1, 0.45) = 0.45 < `ok`'s 0.5, so WITHOUT the
    // governor the drain would pick `bad` (the flag-off test below proves that) — this is the
    // trajectory-not-threshold case the governor exists for.
    const pool = poolWith({ u0: 0.31, u1: 0.45, resetAt: T0 + 24 * HR });
    expect(accountBurnAction(pool.accounts[0]!, SEL_NOW)).toBe('shed');
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBe('ok');
  });

  // WI-6554700010029796: the gateway was handed the SPAWN action, so a pacing-projection shed scored
  // Infinity in accountLoadKey and the gateway 429'd every request for a model only those accounts
  // serve, while the provider returned zero 429s. The gateway form must keep serving on a projection.
  it('GATEWAY: a pacing-projection shed ranks as throttle (finite, behind healthy peers) — it still refuses only the spawn pin', () => {
    const pool = poolWith({ u0: 0.31, u1: 0.45, resetAt: T0 + 24 * HR });
    const bad = pool.accounts[0]!;
    expect(accountBurnVerdict(bad.rate, SEL_NOW).disposition).toBe('pacing-projection');
    expect(accountBurnAction(bad, SEL_NOW)).toBe('shed');
    expect(accountGatewayBurnAction(bad, SEL_NOW)).toBe('throttle');
    const projected = accountLoadKey({ burnAction: accountGatewayBurnAction(bad, SEL_NOW) });
    const healthy = accountLoadKey({ burnAction: accountGatewayBurnAction(pool.accounts[1]!, SEL_NOW) });
    expect(Number.isFinite(projected)).toBe(true);
    expect(projected).toBeGreaterThan(healthy);
  });

  it('GATEWAY: a measured-wall shed (7d utilization at the wall) stays out of the gateway race', () => {
    const pool = poolWith({ u0: 0.98, u1: 1.0, resetAt: T0 + 24 * HR });
    const walled = pool.accounts[0]!;
    expect(accountBurnVerdict(walled.rate, SEL_NOW).disposition).toBe('measured-wall');
    expect(accountGatewayBurnAction(walled, SEL_NOW)).toBe('shed');
    expect(accountLoadKey({ burnAction: accountGatewayBurnAction(walled, SEL_NOW) })).toBe(Infinity);
  });

  it('GATEWAY: throttle and none pass through unchanged', () => {
    const throttled = poolWith({ u0: 0.3, u1: 0.4, resetAt: T0 + 24 * HR });
    expect(accountGatewayBurnAction(throttled.accounts[0]!, SEL_NOW)).toBe('throttle');
    expect(accountGatewayBurnAction(throttled.accounts[1]!, SEL_NOW)).toBe('none');
  });

  it('a THROTTLE-trajectory account yields to a non-throttled peer (first-pass preference) despite better drain', () => {
    // 0.30 → 0.40 in 30min = 0.2/hr → exhausts in ~3h (not imminent) BEFORE the 24h reset → throttle.
    // Effective drain util for `bad` = 0.40 < `ok`'s 0.5 — drain alone would pick `bad`.
    const pool = poolWith({ u0: 0.3, u1: 0.4, resetAt: T0 + 24 * HR });
    expect(accountBurnAction(pool.accounts[0]!, SEL_NOW)).toBe('throttle');
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBe('ok');
  });

  it('when EVERY candidate is throttled the second pass still serves one (graceful, never bricks the pool)', () => {
    let pool = poolWith({ u0: 0.5, u1: 0.55, resetAt: T0 + 24 * HR });
    // Make `ok` throttled too.
    pool = {
      accounts: pool.accounts.map((a) =>
        a.id === 'ok'
          ? {
              ...a,
              rate: {
                ...a.rate,
                history7d: [
                  { at: T0, u: 0.5 },
                  { at: T0 + 30 * MIN, u: 0.56 },
                ],
                utilization7d: 0.56,
                windowResetAt7d: T0 + 24 * HR,
              },
            }
          : a,
      ),
    };
    expect(accountBurnAction(pool.accounts[1]!, SEL_NOW)).toBe('throttle');
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBeDefined(); // still serves — throttle is a preference, not a wall
  });

  it('all-shed pool → no hard pin (the gateway unpinned failover path takes over)', () => {
    let pool = poolWith({ u0: 0.9, u1: 0.95, resetAt: T0 + 24 * HR });
    pool = {
      accounts: pool.accounts.map((a) =>
        a.id === 'ok'
          ? {
              ...a,
              rate: {
                ...a.rate,
                history7d: [
                  { at: T0, u: 0.88 },
                  { at: T0 + 30 * MIN, u: 0.94 },
                ],
                utilization7d: 0.94,
                windowResetAt7d: T0 + 24 * HR,
              },
            }
          : a,
      ),
    };
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBeUndefined();
  });

  it('burnGovernor: false restores pre-governor selection (the shed-trajectory account wins on drain again)', () => {
    // Same low-absolute-util shed trajectory as above: effective drain util 0.45 vs 0.5 means
    // pre-governor drain picks `bad` — proving the governor (not the existing 7d wall ranking)
    // is what flipped the choice in the shed test.
    const pool = poolWith({ u0: 0.31, u1: 0.45, resetAt: T0 + 24 * HR });
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0, burnGovernor: false });
    expect(sel.accountId).toBe('bad'); // kill-switch semantics: byte-identical to pre-governor
  });

  it('a sticky prior account with a shed trajectory is evacuated', () => {
    const pool = poolWith({ u0: 0.9, u1: 0.95, resetAt: T0 + 24 * HR });
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0, priorAccountId: 'bad' });
    expect(sel.accountId).toBe('ok'); // sticky would have kept 'bad'; shed breaks the pin
  });

  it('a sticky prior account with only a THROTTLE trajectory keeps the pin (cache affinity dominates)', () => {
    const pool = poolWith({ u0: 0.5, u1: 0.55, resetAt: T0 + 24 * HR });
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0, priorAccountId: 'bad' });
    expect(sel.accountId).toBe('bad');
    expect(sel.pinSource).toBe('sticky');
  });
});

describe('lastBurnAction stamping + accountBurnTransition — the leg-c write seam', () => {
  function poolWith(id: string): AccountPool {
    return registerAccount({ accounts: [] }, { id, credentialRef: `cred-${id}` }, T0 - HR);
  }

  it('recordAccountWindow stamps the verdict action the fresh reading implies', () => {
    let pool = poolWith('a1');
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    expect(pool.accounts[0]!.rate.lastBurnAction).toBe('none'); // one sample — no rate yet
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.7 }, T0 + HR);
    // +0.3/hr at u=0.7 → exhausts in ~1h, before the reset and inside the imminent horizon.
    expect(pool.accounts[0]!.rate.lastBurnAction).toBe('shed');
  });

  it('first-ever stamp of none is NOT a transition; an escalation is, with the reason', () => {
    const before = poolWith('a1'); // unstamped → reads as none
    const flat = recordAccountWindow(before, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    expect(accountBurnTransition(before, flat, 'a1', T0)).toBeNull();
    const burning = recordAccountWindow(flat, 'a1', { utilization7d: 0.7 }, T0 + HR);
    const tr = accountBurnTransition(flat, burning, 'a1', T0 + HR);
    expect(tr).toEqual(expect.objectContaining({ accountId: 'a1', from: 'none', to: 'shed' }));
    expect(tr!.reason).toContain('exhausts');
  });

  it('unchanged action and unknown ids → null', () => {
    let pool = poolWith('a1');
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    const again = recordAccountWindow(pool, 'a1', { utilization7d: 0.4 }, T0 + HR); // flat — none→none
    expect(accountBurnTransition(pool, again, 'a1', T0 + HR)).toBeNull();
    expect(accountBurnTransition(pool, again, 'ghost', T0 + HR)).toBeNull();
  });

  it('a decaying reading transitions shed → none (recovery edge)', () => {
    let pool = poolWith('a1');
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.7 }, T0 + HR); // shed
    const recovered = recordAccountWindow(pool, 'a1', { utilization7d: 0.3 }, T0 + 2 * HR); // decay outpaces spend
    expect(accountBurnTransition(pool, recovered, 'a1', T0 + 2 * HR)).toEqual(
      expect.objectContaining({ from: 'shed', to: 'none' }),
    );
  });
});

describe('aggregatePoolBurn — the pool verdict for the concurrency lever (leg b)', () => {
  /** A burning account whose verdict rests on a MEASURED provider wall. */
  const walled = { action: 'shed' as const, disposition: 'measured-wall' as const };
  /** A burning account the governor is PACING off a projection — it still serves. */
  const pacedShed = { action: 'shed' as const, disposition: 'pacing-projection' as const };
  const pacedThrottle = { action: 'throttle' as const, disposition: 'pacing-projection' as const };
  const healthy = { action: 'none' as const, disposition: 'no-verdict' as const };

  it('empty pool → none (never act on missing data)', () => {
    const agg = aggregatePoolBurn([]);
    expect(agg.action).toBe('none');
    expect(agg.total).toBe(0);
    expect(agg.reason).toContain('no accounts');
    expect(agg.disposition).toBe('no-verdict');
  });

  it('all shed → shed (nowhere to route)', () => {
    const agg = aggregatePoolBurn([pacedShed, pacedShed, pacedShed]);
    expect(agg.action).toBe('shed');
    expect(agg.counts).toEqual({ none: 0, throttle: 0, shed: 3 });
    expect(agg.reason).toContain('nowhere to route');
  });

  it('every account throttle-or-shed (zero none) → throttle (spreading cannot relieve)', () => {
    const agg = aggregatePoolBurn([pacedThrottle, pacedShed, pacedThrottle]);
    expect(agg.action).toBe('throttle');
    expect(agg.counts).toEqual({ none: 0, throttle: 2, shed: 1 });
    expect(agg.reason).toContain('slow the fleet');
  });

  it('all throttle → throttle', () => {
    const agg = aggregatePoolBurn([pacedThrottle, pacedThrottle]);
    expect(agg.action).toBe('throttle');
    expect(agg.counts).toEqual({ none: 0, throttle: 2, shed: 0 });
  });

  it('a single none account stands the lever down — even beside universal shed', () => {
    const agg = aggregatePoolBurn([pacedShed, pacedShed, healthy]);
    expect(agg.action).toBe('none');
    expect(agg.reason).toContain('route around');
    expect(agg.counts).toEqual({ none: 1, throttle: 0, shed: 2 });
  });

  describe('disposition — what the POOL verdict rests on (P-005)', () => {
    it('an all-projection pool says so: SHED that is not a measured wall', () => {
      // The reading the fleet-concurrency lever's log line used to destroy. Every account is
      // still serving; the governor is pacing us, and reporting this as "at capacity" is the
      // exact misread D-001 forbids.
      const agg = aggregatePoolBurn([pacedShed, pacedShed]);
      expect(agg.disposition).toBe('pacing-projection');
      expect(agg.dispositionCounts).toEqual({
        'measured-wall': 0,
        'pacing-projection': 2,
        'no-verdict': 0,
      });
      expect(agg.label).toContain('not a measured wall');
      expect(agg.label).toContain('SHED');
    });

    it('one measured wall beside projections wins — strongest, never a majority vote', () => {
      // Softening this to 'pacing-projection' because most siblings are projections would tell a
      // reader to keep sending traffic at an account whose window is genuinely exhausted.
      const agg = aggregatePoolBurn([walled, pacedShed, pacedShed]);
      expect(agg.disposition).toBe('measured-wall');
      expect(agg.dispositionCounts).toEqual({
        'measured-wall': 1,
        'pacing-projection': 2,
        'no-verdict': 0,
      });
      // The mix survives the collapse — the strongest-wins answer never destroys the counts.
      expect(agg.label).toContain('1 account(s) measured-walled');
      expect(agg.label).toContain('2 pacing projection(s)');
    });

    it('a healthy account casts no vote on what the burn rests on', () => {
      // 'no-verdict' is the ABSENCE of an assertion; counting it would dilute a real wall toward
      // "nothing is measured".
      const agg = aggregatePoolBurn([walled, walled, healthy, healthy]);
      expect(agg.action).toBe('none'); // a route with headroom stands the lever down
      expect(agg.disposition).toBe('no-verdict'); // ...and nothing is being asserted
      expect(agg.dispositionCounts).toEqual({
        'measured-wall': 0,
        'pacing-projection': 0,
        'no-verdict': 0,
      });
      expect(agg.label).toBe('NONE (no wall asserted)');
    });

    it('every branch stamps a disposition — including the ones that assert nothing', () => {
      for (const rows of [[], [healthy], [pacedShed, pacedShed], [walled, pacedThrottle]]) {
        const agg = aggregatePoolBurn(rows);
        expect(agg.disposition).toBeTruthy();
        expect(agg.label).toBe(renderPoolBurnLabel(agg));
      }
    });
  });
});

describe('renderPoolBurnLabel — the ONE pool-verdict rendering (P-005)', () => {
  it('leads with the disposition, like its per-account sibling', () => {
    expect(
      renderPoolBurnLabel({
        action: 'shed',
        disposition: 'pacing-projection',
        dispositionCounts: { 'measured-wall': 0, 'pacing-projection': 3, 'no-verdict': 0 },
      }),
    ).toBe('SHED (pacing projection, not a measured wall; 3 account(s) projected, 0 measured)');
  });

  it('never renders an ACTION beside "no wall asserted" — it says the basis is missing', () => {
    // Not reachable from evaluateBurn (action and disposition are stamped at one branch), but a
    // hand-built aggregate can express it, and "SHED (no wall asserted)" states the opposite of
    // the action it leads with. An honest fallback beats a fluent contradiction.
    expect(
      renderPoolBurnLabel({
        action: 'shed',
        disposition: 'no-verdict',
        dispositionCounts: { 'measured-wall': 0, 'pacing-projection': 0, 'no-verdict': 0 },
      }),
    ).toBe('SHED (disposition unavailable)');
  });

  it('names the measured half AND the projected half when they are mixed', () => {
    expect(
      renderPoolBurnLabel({
        action: 'throttle',
        disposition: 'measured-wall',
        dispositionCounts: { 'measured-wall': 2, 'pacing-projection': 1, 'no-verdict': 0 },
      }),
    ).toBe('THROTTLE (measured wall; 2 account(s) measured-walled, 1 pacing projection(s))');
  });
});

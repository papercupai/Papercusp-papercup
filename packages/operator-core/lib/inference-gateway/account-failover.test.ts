import { describe, it, expect } from 'vitest';
import {
  createFailoverPool,
  accountLoadKey,
  ACCOUNT_INFLIGHT_LOAD_WEIGHT,
  BURN_THROTTLE_LOAD_BUCKET,
  SOFT_PIN_AFFINITY_CREDIT,
} from './account-failover';
import type { ActiveAccount } from './provider-contracts';

const acct = (id: string): ActiveAccount => ({
  accountId: id,
  token: async () => `${id}-tok`,
  invalidateToken: () => {},
});

describe('createFailoverPool (EI-535) — load distribution', () => {
  it('throws with an empty account list', () => {
    expect(() => createFailoverPool([])).toThrow(/at least one account/);
  });

  it('round-robins active() across the whole pool so unpinned egress spreads (2026-06-18 concentration bug)', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    // Successive unpinned requests cycle through every account instead of pinning to one.
    expect(p.active().accountId).toBe('a');
    expect(p.active().accountId).toBe('b');
    expect(p.active().accountId).toBe('c');
    expect(p.active().accountId).toBe('a');
  });

  it('uses a caller-supplied health key without collapsing equal-health round-robin fairness', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    const scores: Record<string, number> = { a: 10, b: 0, c: 0 };
    expect(p.active((a) => scores[a.accountId]!).accountId).toBe('b');
    // The next seed is b, so an equal score keeps b rather than collapsing every pick onto array index 0.
    expect(p.active((a) => scores[a.accountId]!).accountId).toBe('b');
    // Plain active() is still the original cursor-based round robin.
    expect(p.active().accountId).toBe('c');
  });

  it('a single-account pool always returns that account', () => {
    const p = createFailoverPool([acct('solo')]);
    expect(p.active().accountId).toBe('solo');
    expect(p.active().accountId).toBe('solo');
  });

  it('active() SKIPS an exhausted account so load only spreads across accounts with budget', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    p.onExhausted('b', t + 3_600_000); // b out of rotation
    const seen = new Set([p.active().accountId, p.active().accountId, p.active().accountId, p.active().accountId]);
    expect(seen.has('b')).toBe(false);
    expect(seen.has('a')).toBe(true);
    expect(seen.has('c')).toBe(true);
  });
});

describe('createFailoverPool — msSinceReadmit (cold-rest causation probe, WI-3151)', () => {
  it('undefined for an account that was never exhausted (never cold-rested)', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    t = 5000;
    expect(p.msSinceReadmit!('a')).toBeUndefined();
  });

  it('undefined while an account is still paused (not yet a rejoin)', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 60_000); // paused until t=61000
    t = 30_000; // still inside the pause
    expect(p.msSinceReadmit!('a')).toBeUndefined();
  });

  it('after a NATURAL expiry, reports ms since the pause boundary (exhaustedUntil retains the past reset)', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 60_000); // reset boundary = 61000
    t = 61_000 + 4_000; // 4s past the boundary → back in rotation (rejoin is implicit via available())
    expect(p.msSinceReadmit!('a')).toBe(4_000);
  });

  it('after an EARLY readmit(), reports ms since the readmit moment', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // long pause
    t = 10_000;
    p.readmit!('a'); // proxy recovered → rejoin at t=10000
    t = 12_500; // 2.5s later
    expect(p.msSinceReadmit!('a')).toBe(2_500);
  });

  it('a re-exhaustion drops the stale readmit stamp — the next rejoin measures from the NEW pause', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 30_000);
    t = 30_500;
    p.readmit!('a'); // early readmit at 30500 (stamps readmittedAt)
    p.onExhausted('a', t + 60_000); // immediately re-exhausted at 30500 → boundary now 90500, stamp cleared
    t = 90_500 + 1_000; // 1s past the NEW boundary
    expect(p.msSinceReadmit!('a')).toBe(1_000);
  });
});

describe('accountLoadKey — load-aware selection (load-aware-routing-2026-06-29)', () => {
  it('an idle, clean, fresh-proxy account scores 0 (the happy path — the proactive walk skips it)', () => {
    expect(accountLoadKey({})).toBe(0);
    expect(accountLoadKey({ inFlight: 0, utilization: 0 })).toBe(0);
  });

  it('paused or exhausted ⇒ Infinity (out of the race entirely)', () => {
    expect(accountLoadKey({ paused: true })).toBe(Infinity);
    expect(accountLoadKey({ exhausted: true })).toBe(Infinity);
    // exhausted dominates even an otherwise-idle account (an exhausted account is UNUSABLE, not "slightly worse").
    expect(accountLoadKey({ exhausted: true, inFlight: 0, utilization: 1 })).toBe(Infinity);
  });

  it('among accounts with headroom, the LEAST-LOADED (fewest in-flight) wins — in-flight is the primary term', () => {
    // One extra in-flight request must outweigh the ENTIRE utilization range, so a busier-but-emptier
    // account ranks WORSE than a quieter-but-fuller one.
    const busyButEmpty = accountLoadKey({ inFlight: 1, utilization: 0.0 });
    const quietButFull = accountLoadKey({ inFlight: 0, utilization: 0.95 });
    expect(quietButFull).toBeLessThan(busyButEmpty);
  });

  it('utilization breaks ties between equally-loaded accounts (residual budget)', () => {
    const emptier = accountLoadKey({ inFlight: 2, utilization: 0.2 });
    const fuller = accountLoadKey({ inFlight: 2, utilization: 0.8 });
    expect(emptier).toBeLessThan(fuller);
    expect(fuller - emptier).toBeCloseTo(0.6, 6);
  });

  it('a flaky proxy is bucketed BEHIND every clean account but AHEAD of a paused/exhausted one', () => {
    const flakyIdle = accountLoadKey({ flaky: true, inFlight: 0, utilization: 0 });
    const cleanSlammed = accountLoadKey({ inFlight: 50, utilization: 1 });
    expect(cleanSlammed).toBeLessThan(flakyIdle); // any clean account beats a flaky one…
    expect(flakyIdle).toBeLessThan(Infinity); // …but a flaky account still beats a paused/exhausted one
  });

  it('the in-flight weight ≥ 1 so a single concurrent request overcomes the affinity credit (a pin yields)', () => {
    // A pinned account at in-flight 1 vs an idle sibling at the same utilization: the sibling is better by
    // ~ACCOUNT_INFLIGHT_LOAD_WEIGHT, which must exceed the affinity credit so the soft pin spreads.
    expect(ACCOUNT_INFLIGHT_LOAD_WEIGHT).toBeGreaterThan(SOFT_PIN_AFFINITY_CREDIT);
    const pin = accountLoadKey({ inFlight: 1, utilization: 0.3 });
    const idleSibling = accountLoadKey({ inFlight: 0, utilization: 0.3 });
    expect(idleSibling + SOFT_PIN_AFFINITY_CREDIT).toBeLessThan(pin); // sibling wins the yield decision
  });

  it('a sequential pin (in-flight 0) at the SAME utilization as a sibling is KEPT (affinity tiebreak)', () => {
    const pin = accountLoadKey({ inFlight: 0, utilization: 0.3 });
    const sibling = accountLoadKey({ inFlight: 0, utilization: 0.3 });
    expect(sibling + SOFT_PIN_AFFINITY_CREDIT).not.toBeLessThan(pin); // sibling NOT better-by-credit → pin holds
  });

  it('non-finite / out-of-range inputs degrade gracefully (fail-soft)', () => {
    expect(accountLoadKey({ inFlight: NaN, utilization: NaN })).toBe(0);
    expect(accountLoadKey({ inFlight: -5, utilization: -1 })).toBe(0); // clamped to 0
    expect(accountLoadKey({ inFlight: 0, utilization: 5 })).toBe(1); // utilization clamped to 1
  });

  it('folds every active capacity window and expires a window exactly at its reset', () => {
    const now = 1_000_000;
    expect(
      accountLoadKey({
        now,
        capacityWindows: [
          { utilization: 0.15, resetAt: now + 60_000 },
          { utilization: 0.85, resetAt: now + 7 * 86_400_000 },
        ],
      }),
    ).toBeCloseTo(0.85, 6);
    expect(
      accountLoadKey({
        now,
        capacityWindows: [
          { utilization: 0.99, resetAt: now },
          { utilization: 0.25, resetAt: now + 60_000 },
        ],
      }),
    ).toBeCloseTo(0.25, 6);
  });

  it('treats an active full window, SHED, or unavailable transport as unusable', () => {
    const now = 1_000_000;
    expect(accountLoadKey({ now, capacityWindows: [{ utilization: 0.99, resetAt: now + 1 }] })).toBe(Infinity);
    expect(accountLoadKey({ burnAction: 'shed' })).toBe(Infinity);
    expect(accountLoadKey({ transportHealth: 'unavailable' })).toBe(Infinity);
  });

  it('ranks burn THROTTLE behind healthy capacity but ahead of a degraded transport', () => {
    const healthy = accountLoadKey({ utilization: 0.9 });
    const burning = accountLoadKey({ burnAction: 'throttle', utilization: 0.1 });
    const degraded = accountLoadKey({ transportHealth: 'degraded' });
    expect(burning).toBe(BURN_THROTTLE_LOAD_BUCKET + 0.1);
    expect(healthy).toBeLessThan(burning);
    expect(burning).toBeLessThan(degraded);
  });
});

describe('createFailoverPool — onExhausted failover', () => {
  it('returns the next DIFFERENT account that still has budget', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    const next = p.onExhausted('a', t + 3_600_000);
    expect(next?.accountId).toBe('b');
  });

  it('chooses the healthiest available replacement when a key is supplied', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    const next = p.onExhausted('a', t + 3_600_000, (a) => ({ b: 5, c: 1 })[a.accountId] ?? 0);
    expect(next?.accountId).toBe('c');
  });

  it('never returns the exhausted account itself', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    for (let i = 0; i < 6; i++) {
      const next = p.onExhausted('a', t + 3_600_000);
      expect(next?.accountId).not.toBe('a');
    }
  });

  it('returns null when ALL OTHER accounts are exhausted', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000);
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull(); // a still exhausted → none other available
  });

  it('an exhausted account rejoins rotation once its reset passes', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 1000); // a exhausted until t+1000
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull(); // a not yet recovered, b just exhausted
    t += 2000; // advance past a's reset
    expect(p.onExhausted('b', t + 3_600_000)?.accountId).toBe('a'); // recovered a is picked
  });

  it('defaults to a 5h window when the reset is missing / already past', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', 0); // past reset → 5h default
    t += 60_000; // a minute later, a is still inside its 5h window
    expect(p.onExhausted('b', t + 100)).toBeNull(); // b exhausted, a not recovered → none available
  });
});

describe('createFailoverPool — select() header-pinned routing (x-papercusp-account)', () => {
  it('returns the named pool entry without disturbing the round-robin cursor', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    expect(p.select!('b')?.accountId).toBe('b');
    expect(p.select!('c')?.accountId).toBe('c');
    // select is a pure lookup — it does not advance the round-robin cursor.
    expect(p.active().accountId).toBe('a');
  });

  it('returns null for an unknown account id (the gateway then falls back to active())', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(p.select!('ghost')).toBeNull();
  });

  it('keeps a header-pinned request on its OWN credential regardless of rotation/exhaustion', () => {
    const t = 1_000_000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // 5h-exhaust 'a'
    // A request still header-pinned to 'a' routes to a's credential (cache affinity is per-credential),
    // independent of rotation/exhaustion — that is the whole point of select().
    expect(p.select!('a')?.accountId).toBe('a');
    expect(p.select!('b')?.accountId).toBe('b');
  });
});

describe('createFailoverPool — reload() hot-swap (B-HOT-1)', () => {
  it('atomically swaps the live entries — active()/select() reflect the new pool, same object identity', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(p.active().accountId).toBe('a');
    p.reload!([acct('x'), acct('y'), acct('z')]);
    // Every subsequent active() comes from the NEW set; the OLD accounts are gone.
    const seen = new Set([p.active().accountId, p.active().accountId, p.active().accountId, p.active().accountId]);
    expect([...seen].every((id) => ['x', 'y', 'z'].includes(id))).toBe(true);
    expect(p.select!('a')).toBeNull(); // departed account no longer selectable
    expect(p.select!('y')?.accountId).toBe('y'); // new account present
  });

  it('throws on an empty reload — the gateway must always have ≥1 egress account', () => {
    const p = createFailoverPool([acct('a')]);
    expect(() => p.reload!([])).toThrow(/at least one account/);
  });

  it('a still-present paused account KEEPS its pause across the swap; a departed one is pruned', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // pause 'a' for ~1h
    p.onExhausted('b', t + 3_600_000); // pause 'b' for ~1h
    p.reload!([acct('a'), acct('c')]); // KEEP a (paused) + c; DROP b (its pause is pruned)
    // 'a' is still paused → active() skips it and serves 'c'.
    const seen = new Set([p.active().accountId, p.active().accountId, p.active().accountId]);
    expect(seen.has('a')).toBe(false);
    expect(seen.has('c')).toBe(true);
    // Once a's reset passes, it rejoins rotation (its pause was preserved, not reset, by the swap).
    t += 3_600_001;
    expect(new Set([p.active().accountId, p.active().accountId]).has('a')).toBe(true);
  });
});

describe('createFailoverPool — readmit() (egress-circuit half-open recovery)', () => {
  it('clears an account pause AHEAD of its reset so it rejoins rotation immediately', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // a out of rotation for ~1h
    // a is skipped while paused
    expect(new Set([p.active().accountId, p.active().accountId]).has('a')).toBe(false);
    p.readmit!('a'); // a half-open egress probe confirmed a's proxy recovered
    // a is back in rotation immediately — well before its 1h reset would have passed
    expect(new Set([p.active().accountId, p.active().accountId]).has('a')).toBe(true);
  });

  it('is a no-op for an account that is not paused (or unknown) — never throws, never disturbs rotation', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(() => p.readmit!('a')).not.toThrow(); // a was never paused
    expect(() => p.readmit!('ghost')).not.toThrow(); // not even in the pool
    // rotation cursor untouched by the no-op readmit
    expect(p.active().accountId).toBe('a');
    expect(p.active().accountId).toBe('b');
  });
});

describe('createFailoverPool — deeper edges (depth pass, su-7f3e0376)', () => {
  it('when EVERY account is exhausted, active() still returns something (round-robin over paused) so egress never starves', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000);
    p.onExhausted('b', t + 3_600_000); // whole pool out of budget
    const picks = [p.active().accountId, p.active().accountId, p.active().accountId, p.active().accountId];
    // never undefined / never throws — the gateway still picks SOMETHING; the governor/retry loop paces it.
    expect(picks.every((id) => id === 'a' || id === 'b')).toBe(true);
    expect(picks).toContain('a');
    expect(picks).toContain('b'); // the fallback still spreads across the (paused) pool, not pinning one
  });

  it('a SINGLE exhausted account: onExhausted returns null, yet active() still serves it (governor-paced)', () => {
    const t = 1000;
    const p = createFailoverPool([acct('solo')], { now: () => t });
    expect(p.onExhausted('solo', t + 3_600_000)).toBeNull(); // no other account to fail over to
    // ...but the one account must still egress — the gateway cannot refuse all traffic.
    expect(p.active().accountId).toBe('solo');
    expect(p.active().accountId).toBe('solo');
  });

  it('re-exhausting an already-paused account REFRESHES (extends) its reset — idempotent, not additive', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', 5_000); // a paused until 5000
    p.onExhausted('a', 20_000); // re-exhaust → its reset is refreshed out to 20000
    t = 6_000; // past the ORIGINAL 5000 reset, before the refreshed 20000
    // a is still paused (the refresh extended it), so failing 'b' over finds NO available account.
    // Had the reset NOT refreshed, a would have recovered at 5000 and this would return 'a' instead of null.
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull();
  });

  it('reload() to a SMALLER pool clamps the round-robin cursor and serves only the new set', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    p.active(); // rrIdx → 1
    p.active(); // rrIdx → 2 (near the end of the old 3-account pool)
    p.reload!([acct('solo')]); // shrink to 1 — the cursor must clamp (2 % 1 = 0), no out-of-range read
    expect(p.active().accountId).toBe('solo');
    expect(p.active().accountId).toBe('solo');
    expect(p.select!('a')).toBeNull(); // departed accounts are gone
  });

  it('healthyCount(extra) — the optional predicate narrows the serviceable count to what the gateway will actually serve (Fix 2, 2026-06-23)', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c'), acct('d')], { now: () => t });
    expect(p.healthyCount!()).toBe(4); // no predicate → all in rotation (pool-available)
    p.onExhausted('a', t + 3_600_000); // a hard-paused (exhaustedUntil) → drops out of the pool-available set
    expect(p.healthyCount!()).toBe(3);
    // The gateway passes a governor-not-paused predicate: 'b'/'c' are predictively governor-paused (near their
    // rolling cap) though the pool still has them available — WITHOUT the predicate they'd be miscounted as
    // healthy (the over-report that masks a thundering herd). WITH it, only 'd' is truly serviceable.
    const govPaused = new Set(['b', 'c']);
    expect(p.healthyCount!((id) => !govPaused.has(id))).toBe(1); // only 'd' (a pool-exhausted, b/c gov-paused)
  });

  it('peek() returns the current-best WITHOUT advancing the round-robin cursor (H3, 2026-06-23)', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    expect(p.peek!().accountId).toBe('a');
    expect(p.peek!().accountId).toBe('a'); // idempotent — a read never advances the cursor
    expect(p.active().accountId).toBe('a'); // active() returns the same current-best…
    expect(p.active().accountId).toBe('b'); // …but DID advance, so the next active() rotates
    expect(p.peek!().accountId).toBe('c'); // peek reflects the advanced cursor, still no advance
    expect(p.peek!().accountId).toBe('c');
  });
});

describe('createFailoverPool — recovery horizon + bounded readmit (codex-auto-route-all-walled-fail-fast-2026-09-05)', () => {
  const T = 1_000_000;

  it('earliestAvailableAt() is 0 while any account is unparked and serviceable', () => {
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => T });
    expect(p.earliestAvailableAt!()).toBe(0);
    p.onExhausted('a', T + 3_600_000);
    expect(p.earliestAvailableAt!()).toBe(0); // b still serves
  });

  it('an all-parked pool reports the EARLIEST park expiry', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => T });
    p.onExhausted('a', T + 3 * 3_600_000);
    p.onExhausted('b', T + 7 * 24 * 3_600_000);
    p.onExhausted('c', T + 90_000);
    expect(p.earliestAvailableAt!()).toBe(T + 90_000);
  });

  it('keyOf Infinity makes an unparked account NOT serviceable; recoverAtOf supplies its horizon', () => {
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => T });
    p.onExhausted('a', T + 3_600_000);
    // b is not parked by the pool, but the durable rate hints say its 7d window is full until T+2h.
    const horizon = p.earliestAvailableAt!({
      keyOf: (e) => (e.accountId === 'b' ? Infinity : 0),
      recoverAtOf: (e) => (e.accountId === 'b' ? T + 2 * 3_600_000 : undefined),
    });
    expect(horizon).toBe(T + 3_600_000); // a's park (1h) is sooner than b's window reset (2h)
  });

  it('recoverAtOf RAISES a parked account\'s horizon past its park when the external reset is later', () => {
    const p = createFailoverPool([acct('a')], { now: () => T });
    p.onExhausted('a', T + 60_000); // a short pool park…
    // …but the store knows the weekly window is walled for another 2 days.
    expect(p.earliestAvailableAt!({ recoverAtOf: () => T + 2 * 86_400_000 })).toBe(T + 2 * 86_400_000);
  });

  it('is Infinity when every account is out and none has a known recovery instant', () => {
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => T });
    expect(p.earliestAvailableAt!({ keyOf: () => Infinity })).toBe(Infinity);
  });

  it('honours an explicit `now` and treats an expired park as serviceable', () => {
    const p = createFailoverPool([acct('a')], { now: () => T });
    p.onExhausted('a', T + 10_000);
    expect(p.earliestAvailableAt!({ now: T + 5_000 })).toBe(T + 10_000);
    expect(p.earliestAvailableAt!({ now: T + 10_000 })).toBe(0);
  });

  it('parkState() reports when the park began and until when; undefined once cleared or expired', () => {
    let t = T;
    const p = createFailoverPool([acct('a')], { now: () => t });
    expect(p.parkState!('a')).toBeUndefined();
    p.onExhausted('a', T + 30_000);
    expect(p.parkState!('a')).toEqual({ parkedAt: T, until: T + 30_000 });
    t = T + 30_000;
    expect(p.parkState!('a')).toBeUndefined(); // expired
  });

  it('readmit() returns true and clears the park; false for an account that is not parked', () => {
    const p = createFailoverPool([acct('a')], { now: () => T });
    expect(p.readmit!('a')).toBe(false);
    p.onExhausted('a', T + 30_000);
    expect(p.readmit!('a', { reason: 'store' })).toBe(true);
    expect(p.parkState!('a')).toBeUndefined();
    expect(p.earliestAvailableAt!()).toBe(0);
  });

  it('preserves the park cause until recovery and drops it on readmission/reload', () => {
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => T });
    p.onExhausted('a', T + 30_000, undefined, { cause: 'cooldown' });
    expect(p.parkState!('a')).toEqual({ parkedAt: T, until: T + 30_000, cause: 'cooldown' });
    p.readmit!('a', { reason: 'admin' });
    p.onExhausted('a', T + 60_000);
    expect(p.parkState!('a')).toEqual({ parkedAt: T, until: T + 60_000 });
    p.reload!([acct('b')]);
    p.reload!([acct('a'), acct('b')]);
    expect(p.parkState!('a')).toBeUndefined();
  });

  it.each(['quota', 'auth', undefined] as const)('a concurrent cooldown cannot weaken a %s park', cause => {
    const p = createFailoverPool([acct('a')], { now: () => T });
    p.onExhausted('a', T + 3600_000, undefined, { cause });
    p.onExhausted('a', T + 15_000, undefined, { cause: 'cooldown' });
    expect(p.parkState!('a')).toEqual({ parkedAt: T, until: T + 3600_000, ...(cause ? { cause } : {}) });
    expect(p.healthyCount!()).toBe(0);
  });

  it('a quota refusal supersedes a pending cooldown without shortening its park', () => {
    const p = createFailoverPool([acct('a')], { now: () => T });
    p.onExhausted('a', T + 30_000, undefined, { cause: 'cooldown' });
    p.onExhausted('a', T + 10_000, undefined, { cause: 'quota' });
    expect(p.parkState!('a')?.cause).toBe('quota');
    expect(p.parkState!('a')?.until).toBe(T + 30_000);
  });

  it('a transport readmit bounded by maxParkMs REFUSES a park longer than the transport horizon (a usage wall)', () => {
    const logs: string[] = [];
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => T, log: (_l, m) => logs.push(m) });
    p.onExhausted('a', T + 7 * 24 * 3_600_000); // a measured 7d wall
    p.onExhausted('b', T + 60_000); // a short transport-circuit-sized park
    expect(p.readmit!('a', { reason: 'transport', maxParkMs: 300_000 })).toBe(false);
    expect(p.parkState!('a')).toBeDefined(); // the wall survives
    expect(logs.some((m) => /readmit \(transport\) REFUSED/.test(m))).toBe(true);
    expect(p.readmit!('b', { reason: 'transport', maxParkMs: 300_000 })).toBe(true);
    expect(p.parkState!('b')).toBeUndefined();
    // An admin readmit carries no bound and clears even the wall.
    expect(p.readmit!('a', { reason: 'admin' })).toBe(true);
    expect(p.parkState!('a')).toBeUndefined();
  });

  it('reload() prunes the park stamp of an account that left the pool', () => {
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => T });
    p.onExhausted('a', T + 30_000);
    p.reload!([acct('b')]);
    expect(p.parkState!('a')).toBeUndefined();
    expect(p.earliestAvailableAt!()).toBe(0);
  });
});

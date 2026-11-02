/** Tests for the StallWaker decision logic (gateway-rate-limit-stall-autowake P-003/P-004; 2026-08-17
 *  mass-interrupt hardening). Deps-injected + an injectable clock, so the confirm-wait-wake state machine
 *  is exercised with no gateway/DB/clock. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { StallWaker, type StallEvent, type StallWakerDeps, type StallWakerOptions } from './stall-waker';

function harness(opts: StallWakerOptions = {}) {
  // lastAct defaults to 60s BEFORE t0: the owner is idle (past idleSilenceMs) and its activity
  // PRE-dates any stall pushed at t0 — the "plausibly wedged" baseline.
  const state = { t: 1_000_000, lastAct: 940_000, capBack: true, woken: 1, wakeTimedOut: false, unwedgeOk: true, unwedgeExpected: false };
  const queue: StallEvent[] = [];
  const logs: Array<{ level: 'info' | 'warn'; msg: string }> = [];
  const calls = { fetch: 0, wake: [] as string[], cap: 0, unwedge: [] as string[] };
  const deps: StallWakerDeps = {
    fetchStalls: async (since) => {
      calls.fetch++;
      return { now: state.t, stalls: queue.filter((s) => s.at > since) };
    },
    ownerLastActivityAt: async () => state.lastAct,
    capacityBack: async () => {
      calls.cap++;
      return state.capBack;
    },
    wake: async (ownerId) => {
      calls.wake.push(ownerId);
      return { woken: state.woken, timedOut: state.wakeTimedOut };
    },
    unwedge: async (ownerId) => {
      calls.unwedge.push(ownerId);
      return { ok: state.unwedgeOk, expected: state.unwedgeExpected };
    },
    now: () => state.t,
    log: (level, msg) => logs.push({ level, msg }),
  };
  const w = new StallWaker(deps, opts);
  return {
    w,
    calls,
    state,
    logs,
    advance: (ms: number) => {
      state.t += ms;
    },
    pushStall: (e: Partial<StallEvent> = {}) =>
      queue.push({ ownerId: 'bee-1', accountId: 'acct-A', soonestResetAt: state.t + 60_000, at: state.t, ...e }),
  };
}

test('happy path — confirmed-idle bee, after reset + capacity back → woken once', async () => {
  const h = harness();
  h.pushStall({ soonestResetAt: h.state.t + 60_000 });
  let r = await h.w.tick(); // pulled, idle, but reset not reached → wait
  assert.equal(r.pulled, 1);
  assert.deepEqual(r.woken, []);
  assert.equal(h.w.pendingCount, 1);
  h.advance(61_000); // past the reset
  r = await h.w.tick();
  assert.deepEqual(r.woken, ['bee-1'], 'woken once capacity is back');
  assert.equal(h.w.pendingCount, 0, 'cleared after a successful wake');
  assert.equal(h.calls.wake.length, 1);
});

test('23 concurrent poll ticks share one pass and cannot duplicate the same wake', async () => {
  const h = harness({ wakeCooldownMs: 0 });
  h.pushStall({ soonestResetAt: h.state.t - 1 });

  const results = await Promise.all(Array.from({ length: 23 }, () => h.w.tick()));

  assert.equal(h.calls.fetch, 1, 'overlapping poll callbacks share one fetch and pending-state pass');
  assert.deepEqual(h.calls.wake, ['bee-1'], 'one pending stall produces one wake attempt');
  assert.deepEqual(results[0].woken, ['bee-1']);
  assert.ok(results.every((result) => result === results[0]), 'all coalesced callers observe the same pass');
});

test('FALSE-POSITIVE guard — an owner that keeps acting after its stall (recovered) is dropped, never woken or ESC\'d', async () => {
  const h = harness({ confirmWindowMs: 30_000 });
  h.state.lastAct = h.state.t; // active at stall time — recovered on its own CLI retry
  h.pushStall();
  let r = await h.w.tick();
  assert.equal(h.w.pendingCount, 1, 'kept within the confirm window');
  assert.deepEqual(r.woken, []);
  h.advance(31_000);
  h.state.lastAct = h.state.t; // still acting — activity now POST-dates the stall
  r = await h.w.tick();
  assert.deepEqual(r.dropped, ['bee-1'], 'dropped: demonstrably active after the stall');
  assert.equal(h.w.pendingCount, 0);
  assert.deepEqual(h.calls.wake, [], 'a self-recovered bee is NEVER woken');
  assert.deepEqual(h.calls.unwedge, [], '…and NEVER force-ESC\'d');
});

test('2026-08-17 REGRESSION — activity AFTER the stall (a successful retry, a coord call) drops the owner before any ESC', async () => {
  // The mass-interrupt shape: an agent whose single inference request got shed one 429, whose CLI
  // retried fine, and which then went >idleSilenceMs quiet inside a long tool call. The old bare
  // 30s-silence heuristic ESC'd its healthy turn; the recovered check must drop it instead.
  const h = harness();
  h.pushStall(); // stall at t0
  h.advance(40_000);
  h.state.lastAct = 1_010_000; // acted 10s AFTER the stall, then went quiet (long Bash call)
  const r = await h.w.tick();
  assert.deepEqual(r.dropped, ['bee-1'], 'post-stall activity ⇒ the turn survived ⇒ dropped');
  assert.deepEqual(h.calls.unwedge, [], 'no ESC at a turn that provably survived its stall');
  assert.deepEqual(h.calls.wake, []);
  assert.equal(h.w.pendingCount, 0);
});

test('2026-08-17 REGRESSION — a CLI retry-train (stall stream still flowing) is never declared dead mid-backoff', async () => {
  // The gateway records a stall per shed request and every request bumps the owner ledger, so an
  // alive CLI in 429 backoff keeps refreshing BOTH signals. deadQuietMs must hold the ESC until
  // the train has actually stopped — the old code fired after any 30s gap, i.e. inside a backoff.
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 300_000 });
    h.state.lastAct = h.state.t; // the shed's own ledger bump — same instant as the stall
    h.advance(60_000);
    await h.w.tick();
  }
  assert.deepEqual(h.calls.unwedge, [], 'no ESC while the stall stream is alive (deadQuietMs not met)');
  h.state.capBack = false; // keep the wake path out of the way
  h.advance(121_000); // train stopped; quiet past deadQuietMs
  const r = await h.w.tick();
  assert.deepEqual(r.unwedged, ['bee-1'], 'exactly one ESC once the death is corroborated');
  assert.equal(h.calls.unwedge.length, 1);
});

test('waits for capacity — past the reset but pool still throttled → no wake until capacity returns', async () => {
  const h = harness();
  h.state.capBack = false;
  h.pushStall({ soonestResetAt: h.state.t + 1000 });
  h.advance(2000); // past the reset, but capacity not back
  let r = await h.w.tick();
  assert.deepEqual(r.woken, [], 'capacity not back → wait, do not wake into a throttled pool');
  assert.equal(h.w.pendingCount, 1);
  h.state.capBack = true;
  r = await h.w.tick();
  assert.deepEqual(r.woken, ['bee-1']);
});

test('bee gone — wake fires but nobody is watching (woken:0) → dropped, not retried', async () => {
  const h = harness();
  h.state.woken = 0; // no watching session — the bee process exited
  h.pushStall({ soonestResetAt: h.state.t + 1000 });
  h.advance(2000);
  const r = await h.w.tick();
  assert.deepEqual(r.woken, [], 'woken:0 is not a successful wake');
  assert.deepEqual(h.calls.wake, ['bee-1'], 'it DID attempt the wake');
  assert.equal(h.w.pendingCount, 0, 'dropped — a gone bee is not retried');
});

test('wake timeout is unknown delivery, not a confirmed no-listener miss', async () => {
  const h = harness();
  h.state.woken = 0;
  h.state.wakeTimedOut = true;
  h.pushStall({ soonestResetAt: h.state.t + 1000 });
  h.advance(2000);

  await h.w.tick();

  assert.equal(h.w.pendingCount, 0, 'unknown delivery is not retried');
  assert.ok(h.logs.some((entry) => /wake timed out — delivery unknown/.test(entry.msg)));
  assert.ok(!h.logs.some((entry) => /nobody home/.test(entry.msg)), 'a timeout is not evidence that the listener is absent');
});

test('de-dup — many stalls for one bee → a single pending + a single wake (latest reset wins)', async () => {
  const h = harness();
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 1000 });
  h.advance(10);
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 5000 }); // later stall pushes the wait out
  const r1 = await h.w.tick();
  assert.equal(r1.pulled, 2);
  assert.equal(h.w.pendingCount, 1, 'collapsed to one bee');
  h.advance(3000); // past the FIRST reset but not the SECOND (de-dup took the max)
  const r2 = await h.w.tick();
  assert.deepEqual(r2.woken, [], 'still waiting on the later reset');
  h.advance(3000);
  const r3 = await h.w.tick();
  assert.deepEqual(r3.woken, ['bee-1']);
  assert.equal(h.calls.wake.length, 1, 'woken exactly once');
});

test('ROLE-AGNOSTIC — an su/psu session (not a bee spawn) is woken identically to a bee (2026-06-22)', async () => {
  const h = harness();
  // An autonomous su/psu engineer session — NOT a harness bee. The waker must treat it the same: confirm idle
  // (the role-agnostic ownerLastActivityAt dep), wait the reset, then wake. (The role-specific gap su-b813f
  // hit was in the DEPS impl, now fixed to read coord_presence + the gateway ledger for any role.)
  h.pushStall({ ownerId: 'su-b813f856-99a1-494d-b92e-ae4b81343394' });
  let r = await h.w.tick();
  assert.equal(r.pulled, 1);
  h.advance(61_000);
  r = await h.w.tick();
  assert.deepEqual(r.woken, ['su-b813f856-99a1-494d-b92e-ae4b81343394'], 'an su/psu session is auto-woken just like a bee');
});

test('FAST UN-WEDGE — held until deadQuietMs, then ESC\'d BEFORE the capacity gate', async () => {
  const h = harness();
  h.state.capBack = false; // capacity NOT back — the capacity-gated wake must NOT fire
  h.pushStall({ soonestResetAt: h.state.t + 60_000 });
  let r = await h.w.tick();
  assert.deepEqual(r.unwedged, [], 'no ESC yet — the death is not corroborated (deadQuietMs)');
  h.advance(121_000); // quiet past deadQuietMs (and past the reset — capacity still walled)
  r = await h.w.tick();
  assert.deepEqual(r.unwedged, ['bee-1'], 'ESC-unwedged once corroborated, regardless of capacity');
  assert.deepEqual(r.woken, [], 'but NOT woken — capacity not back, so it is not pushed back into a throttled pool');
  assert.deepEqual(h.calls.unwedge, ['bee-1']);
  assert.equal(h.w.pendingCount, 1, 'still pending for the capacity-gated resume');
});

test('FAST UN-WEDGE — ONE ESC per stall episode; only a NEWER stall re-arms it (2026-08-17 hammering fix)', async () => {
  // The old code re-ESC'd every unwedgeCooldownMs for up to pendingTtlMs while capacity stayed walled
  // — a live agent resuming after the first ESC was ESC'd again a minute later, over and over.
  const h = harness({ unwedgeCooldownMs: 30_000 });
  h.state.capBack = false;
  h.pushStall({ soonestResetAt: h.state.t + 300_000 });
  h.advance(121_000);
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 1, 'first ESC lands');
  h.advance(60_000); // well past the cooldown — still pending, still idle
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 1, 'NO repeat ESC for the same episode');
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 300_000 }); // fresh death evidence
  await h.w.tick(); // pulls the new stall (resets the latch; deadQuiet restarts)
  h.advance(121_000);
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 2, 'a strictly newer stall re-arms exactly one more ESC');
});

test('FAST UN-WEDGE — a REFUSED/failed ESC (e.g. storm-guard rate_limited) is NOT success and IS retried after the cooldown', async () => {
  const h = harness({ unwedgeCooldownMs: 30_000 });
  h.state.capBack = false;
  h.state.unwedgeOk = false; // a GENUINE refusal — NOT the expected no-live-session case
  h.pushStall({ soonestResetAt: h.state.t + 300_000 });
  h.advance(121_000);
  const r = await h.w.tick();
  assert.deepEqual(h.calls.unwedge, ['bee-1'], 'the attempt happened');
  assert.deepEqual(r.unwedged, [], 'a refused/failed ESC must NOT be reported as unwedged');
  assert.ok(
    h.logs.some((l) => l.level === 'warn' && /did NOT land/.test(l.msg)),
    'a failed ESC is logged as a warning, not silently swallowed',
  );
  h.advance(10_000); // within cooldown
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 1, 'no re-ESC within the cooldown');
  h.advance(21_000); // past cooldown — refusal did NOT latch the episode
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 2, 'a refusal is retried after the cooldown');
  assert.equal(h.w.pendingCount, 1, 'still pending — not dropped just because the ESC failed');
});

test('FAST UN-WEDGE — an EXPECTED no-live-session ESC is a silent non-event AND latches (no per-cooldown re-attempts)', async () => {
  // The dominant real-world outcome: the "stalled" owner has no live turn to ESC — it isn't wedged.
  // Must not warn (was ~27×/15min host-log spam), must not count as success, and must NOT be re-attempted
  // every cooldown: a stale pending entry re-trying the keystroke forever is a standing threat to the
  // owner's NEXT live turn.
  const h = harness({ unwedgeCooldownMs: 30_000 });
  h.state.capBack = false;
  h.state.unwedgeOk = false;
  h.state.unwedgeExpected = true; // no live interruptible session — expected, non-actionable
  h.pushStall({ soonestResetAt: h.state.t + 300_000 });
  h.advance(121_000);
  const r = await h.w.tick();
  assert.deepEqual(h.calls.unwedge, ['bee-1'], 'the ESC attempt still happens once');
  assert.deepEqual(r.unwedged, [], 'an expected no-op ESC is NOT reported as unwedged');
  assert.ok(
    !h.logs.some((l) => /did NOT land|refused|no live interruptible session/.test(l.msg)),
    'an EXPECTED no-live-session ESC must produce NO warn/log line',
  );
  h.advance(60_000); // well past the cooldown
  await h.w.tick();
  assert.equal(h.calls.unwedge.length, 1, 'latched — no re-attempt for the same episode');
  assert.equal(h.w.pendingCount, 1, 'still pending — the capacity-gated wake path still owns the resume');
});

test('wake cap — a bee that keeps stalling is given up after maxWakesPerBee', async () => {
  const h = harness({ maxWakesPerBee: 2, wakeCooldownMs: 0 });
  h.state.woken = 1;
  // Each round: a fresh stall, advance past reset, tick → wake. The 3rd should be capped.
  for (let i = 0; i < 2; i++) {
    h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 100 });
    h.advance(200);
    await h.w.tick();
  }
  assert.equal(h.calls.wake.length, 2, 'woke up to the cap');
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 100 });
  h.advance(200);
  const r = await h.w.tick();
  assert.equal(h.calls.wake.length, 2, 'no further wakes past the cap');
  assert.deepEqual(r.dropped, ['bee-1']);
});

test('WI-1582: breadcrumbs (lastWokeAt/lastUnwedgeAt/wakeCount) are bounded — swept once long-idle and not pending', async () => {
  const h = harness({ breadcrumbTtlMs: 1000 });
  h.pushStall({ soonestResetAt: h.state.t + 100 });
  h.advance(200);
  await h.w.tick(); // wakes bee-1 → pending cleared, but breadcrumbs (lastWokeAt, wakeCount) persist
  assert.equal(h.w.pendingCount, 0);
  assert.equal(h.w.breadcrumbCount, 1, 'the wake breadcrumb is tracked once woken');

  // Well within the TTL: a routine tick with nothing new must NOT sweep it yet.
  h.advance(500);
  await h.w.tick();
  assert.equal(h.w.breadcrumbCount, 1, 'not yet stale — kept');

  // Past the TTL with no further activity for this owner → swept.
  h.advance(600); // total 1100ms since last wake, past breadcrumbTtlMs=1000
  await h.w.tick();
  assert.equal(h.w.breadcrumbCount, 0, 'long-silent owner is reclaimed');
});

test('WI-1582: a CURRENTLY-PENDING owner is never swept, even past breadcrumbTtlMs (would reset its wake cap mid-episode)', async () => {
  // deadQuietMs: 0 so the un-wedge (and its breadcrumb) fires on the first idle tick, as the
  // original episode shape did — the subject here is the sweep, not the ESC gating.
  const h = harness({ breadcrumbTtlMs: 1000, maxWakesPerBee: 1, wakeCooldownMs: 0, deadQuietMs: 0 });
  h.state.capBack = false; // stays pending — never reaches the reset/capacity gate again
  h.pushStall({ soonestResetAt: h.state.t + 100 });
  h.advance(200);
  await h.w.tick(); // reset passed, capacity NOT back → stays pending, no wake yet
  assert.equal(h.w.pendingCount, 1);
  assert.equal(h.w.breadcrumbCount, 1, 'the unwedge breadcrumb is tracked, but the owner stays pending');

  h.advance(2000); // well past breadcrumbTtlMs, but the owner is still pending throughout
  const r = await h.w.tick();
  assert.equal(h.w.pendingCount, 1, 'still pending — capacity never came back');
  assert.deepEqual(r.dropped, [], 'sweepBreadcrumbs must not touch a pending owner');
});

test("WI-1582: sweeping resets the wake cap for a bee that stalls again long after its session ended (doesn't permanently ban a NEW session's owner id)", async () => {
  const h = harness({ maxWakesPerBee: 1, wakeCooldownMs: 0, breadcrumbTtlMs: 1000 });
  h.pushStall({ soonestResetAt: h.state.t + 100 });
  h.advance(200);
  await h.w.tick();
  assert.equal(h.calls.wake.length, 1, 'first wake attempt used the cap');

  h.advance(1100); // past breadcrumbTtlMs with no activity → wakeCount reclaimed
  await h.w.tick(); // a no-op tick (no pending stall) still runs the sweep
  assert.equal(h.w.breadcrumbCount, 0);

  // A fresh stall for the SAME ownerId, long after the fact, gets a clean cap again —
  // sweeping did not permanently ban a bee that merely went quiet for a day.
  h.pushStall({ at: h.state.t, soonestResetAt: h.state.t + 100 });
  h.advance(200);
  const r = await h.w.tick();
  assert.deepEqual(r.woken, ['bee-1'], 'the cap reset after the long-idle sweep');
  assert.equal(h.calls.wake.length, 2);
});

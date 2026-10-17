/**
 * Regression tests for the B-GW-EGRESS transport-failure EGRESS CIRCUIT-BREAKER (2026-06-20 dead-proxy
 * wedge). A dead/half-dead egress proxy (a Rayobyte squid that CONNECT-hangs ~60s) makes the upstream
 * fetch STALL/abort or fail to connect — which never reaches Anthropic, so it carries NO HTTP status
 * and (before this fix) fed NO account-health signal. The router therefore scored the dead-egress
 * account "healthiest", routed the MOST traffic to it, and overrode session pins onto it → the whole
 * gateway wedged into a restart storm (aviynw6/216.41.233.249).
 *
 * The fix (gateway.ts proxy() catch): a transport failure now feeds the SAME `gov.pausedUntil` lever a
 * 429 hard-cap uses (so the existing pin-yield + cross-account selector route around the account),
 * ROTATES + retries instead of 502-ing the bee, and OPENS a longer circuit on a consecutive streak —
 * with a streak reset on any successful response (natural half-open via pause-expiry). The headline
 * invariant proven here: a dead proxy on ONE account is dropped WITHOUT wedging the request.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createInferenceGateway } from './gateway';
import type { ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

/**
 * A pool account whose bearer token === its id (so the mock fetch can tell which account egressed) and
 * which routes through an http egress PROXY — the circuit-breaker is scoped to proxy-egress accounts
 * (a no-proxy transport failure is an Anthropic-side stall, not a dead proxy). The proxy URL is never
 * actually dialed: `egressFetch` is the injected upstream and ignores the dispatcher.
 */
const acct = (id: string): ActiveAccount => ({
  accountId: id,
  token: async () => id,
  invalidateToken: () => {},
  egress: { proxyUrl: `http://proxy-${id}.test:3128` },
});

/**
 * A mock `fetch` standing in for the per-account egress. The upstream call for an account currently in
 * `deadIds` REJECTS — a dead/hanging proxy (the gateway's stall-guard aborts a real 60s CONNECT-hang
 * into this same reject; we reject directly so the test is fast + deterministic). A healthy account
 * returns a 200. The account is identified by the `Authorization: Bearer <id>` the gateway injects.
 */
function egressFetch(deadIds: Set<string>, onCall?: (id: string) => void): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const id = auth.replace(/^Bearer\s+/i, '');
    onCall?.(id);
    if (deadIds.has(id)) throw new Error(`connect ECONNREFUSED (simulated dead egress proxy for '${id}')`);
    return new Response(JSON.stringify({ ok: true, servedBy: id }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const MSG = { model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };

/**
 * The absorb tests' slot-hold deadline: short enough that the scripted 429/529s exhaust it and hand the
 * caller to the absorb rung, long enough that attempt 1 is dispatched at all. It must be positive: since
 * WI-6554700010011504 a deadline already spent before an attempt is a SHED with no upstream call, so a
 * 0 here would test "no attempt can start" instead of the absorb (WI-6554700010012381).
 */
const SHORT_RETRY_DEADLINE_MS = 50;

const post = (extraHeaders: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(MSG),
  });

test('a zero retry budget sheds without dispatching or re-acquiring even when absorb is enabled', async () => {
  let calls = 0;
  const { governorFor, counts } = perAccountGovernors();
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A')]),
    fetchImpl: (async () => { calls++; return new Response('{}'); }) as typeof fetch,
    governorFor,
    selfHeal: { enabled: false },
    internalRetryDeadlineMs: 0,
    requestAbsorbMs: 8000,
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('x-should-retry'), 'false');
  assert.equal(calls, 0, 'no attempt can start with a zero budget');
  assert.equal(counts.acquires, 1, 'refreshing a zero budget cannot make progress and must not loop');
});

test('a dead/hanging egress proxy on one account FAILS OVER to a healthy account → 200, never a 502 wedge', async () => {
  const calls: string[] = [];
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD'), acct('OK')]),
    fetchImpl: egressFetch(new Set(['DEAD']), (id) => calls.push(id)),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
  });
  port = await gw.listen(0);
  // Pin to DEAD so the gateway egresses through the dead proxy FIRST — proving the transport-failure
  // failover (without the fix this returns 502; with it, the request rotates to OK and returns 200).
  const res = await post({ 'x-papercusp-account': 'DEAD' });
  assert.equal(res.status, 200, 'transport failure on the dead-proxy account fails over to the healthy account → 200 (NOT a 502)');
  const body = (await res.json()) as { servedBy: string };
  assert.equal(body.servedBy, 'OK', 'the healthy account actually served the request');
  assert.equal(res.headers.get('x-papercusp-routed-account'), 'OK', 'routed-account header names the survivor (the failover is visible, not silent)');
  assert.ok(calls.includes('DEAD'), 'the dead account was attempted first');
  assert.ok(calls.includes('OK'), 'then the request rotated to the healthy account');
  // Volume-fair rate: DEAD failed its single attempt (1/1 = 1.0); OK served its single attempt (0/1 = 0.0). The
  // rate is per-account-denominated, so a dead proxy reads 1.0 even on tiny traffic and a healthy one reads 0.0 —
  // exactly the signal a raw count buries when one proxy is busier than another.
  const s = gw.stats();
  assert.equal(s.egressAttemptsByAccount.DEAD, 1, 'DEAD got one egress attempt (the denominator)');
  assert.equal(s.egressAttemptsByAccount.OK, 1, 'OK got one egress attempt');
  assert.equal(s.egressFailRateByAccount.DEAD, 1, 'DEAD: 1 fail / 1 attempt = 1.0');
  assert.equal(s.egressFailRateByAccount.OK, 0, 'OK: 0 fail / 1 attempt = 0.0 (served), even though it carried the same traffic');
  const proxyAttemptsByAccount = s.egressProxyAttemptsByAccount;
  const proxyFailsByAccount = s.egressProxyFailsByAccount;
  const proxyFailRateByAccount = s.egressProxyFailRateByAccount;
  assert.ok(proxyAttemptsByAccount, 'stats exposes proxy-only attempt counts');
  assert.ok(proxyFailsByAccount, 'stats exposes proxy-only failure counts');
  assert.ok(proxyFailRateByAccount, 'stats exposes proxy-only failure rates');
  assert.equal(proxyAttemptsByAccount.DEAD, 1, 'proxy-only denominator records the dead proxy route');
  assert.equal(proxyFailsByAccount.DEAD, 1, 'proxy-only failures record the dead proxy route');
  assert.equal(proxyFailRateByAccount.DEAD, 1, 'proxy-only rate preserves the dead-proxy signal');
});

test('N consecutive transport failures OPEN the egress circuit (account paused + stat) and return a retryable 503 — never a wedge', async () => {
  const governor = new RateLimitGovernor({ maxConcurrent: 20 });
  gw = createInferenceGateway({
    // Single-account pool → no failover target, so every request actually hits the dead account and
    // accumulates its consecutive transport-failure streak.
    pool: createFailoverPool([acct('DEAD')]),
    fetchImpl: egressFetch(new Set(['DEAD'])),
    governorFor: () => governor,
    selfHeal: { enabled: false },
    maxQueueWaitMs: 3000, // > the pre-circuit pace, so each request waits the prior pace out + re-attempts
  });
  port = await gw.listen(0);
  // EGRESS_FAIL_CIRCUIT_THRESHOLD defaults to 3. Each failing request must be a RETRYABLE 503 (not a
  // terminal 502, not a hang), and the threshold'th failure opens the circuit.
  for (let i = 1; i <= 3; i++) {
    const res = await post();
    assert.equal(res.status, 503, `request ${i}: dead-proxy account with no failover target → retryable 503 (not 502/terminal, not a wedge)`);
    assert.equal(res.headers.get('retry-after'), '5', `request ${i}: carries a retry-after for the bee's CLI`);
  }
  const s = gw.stats();
  assert.ok(s.egressCircuitOpens >= 1, `the egress circuit opened after the consecutive-failure threshold (egressCircuitOpens=${s.egressCircuitOpens})`);
  assert.ok(
    governor.state.pausedUntil > Date.now(),
    'the dead account governor is PAUSED — the same lever as the 429 hard-cap, so the selector routes around it (no longer scored "healthiest")',
  );
  // Normalized egress-failure RATE (2026-06-22 audit): every one of DEAD's 3 attempts transport-failed, so its
  // rate is 1.0 over 3 attempts — the volume-fair "this proxy is dead" signal, not just a raw count.
  assert.equal(s.egressAttemptsByAccount.DEAD, 3, 'every attempt on DEAD is counted as the rate denominator');
  assert.equal(s.egressFailsByAccount.DEAD, 3, 'all 3 attempts transport-failed');
  assert.equal(s.egressFailRateByAccount.DEAD, 1, 'egressFailRateByAccount = fails/attempts = 3/3 = 1.0 (dead proxy)');
});

/**
 * A per-ACCOUNT caching governor factory — the faithful test double for the gateway's default
 * `governorForBackend('claude-code', model, undefined, accountId)`, which is likewise keyed by account.
 *
 * EI-2648. This exists because `governorFor: () => new RateLimitGovernor(...)` — a factory returning a
 * NEW instance on every `governorForAccount()` call — silently destroys the property most absorb tests
 * think they are asserting: an account penalty (`pausedUntil`) written by attempt N is thrown away
 * before attempt N+1, so no account is ever actually paused, every re-acquire succeeds instantly, and
 * "waits out a penalty" degrades into "retries and happens to succeed". Prefer this helper for any test
 * whose subject is pacing, penalties, pauses, or the absorb.
 *
 * It also instruments `acquire()` so a test can PROVE the slot was handed back mid-wait rather than held
 * across it — the actual contract of the extended absorb.
 */
function perAccountGovernors(limits: { maxConcurrent: number } = { maxConcurrent: 20 }) {
  const byAccount = new Map<string, RateLimitGovernor>();
  const counts = { acquires: 0, releases: 0 };
  const governorFor = (_model: string, accountId: string): RateLimitGovernor => {
    let g = byAccount.get(accountId);
    if (!g) {
      g = new RateLimitGovernor({ ...limits });
      const inner = g.acquire.bind(g);
      g.acquire = async (...args: Parameters<RateLimitGovernor['acquire']>) => {
        const release = await inner(...args);
        if (!release) return null;
        counts.acquires += 1;
        return () => {
          counts.releases += 1;
          release();
        };
      };
      byAccount.set(accountId, g);
    }
    return g;
  };
  return { governorFor, byAccount, counts };
}

test('EXTENDED ABSORB (requestAbsorbMs) — RELEASES the slot, WAITS OUT a still-in-force account penalty, re-acquires and SUCCEEDS (EI-2648)', async () => {
  // EI-2648 — what this test is FOR, and what it used to (not) prove.
  //
  // It previously passed `governorFor: () => new RateLimitGovernor(...)`, so every governorForAccount()
  // call handed back a fresh, un-penalized governor. The retry-after penalty therefore never survived to
  // the next iteration: the absorb's re-acquire always met a clean governor and returned immediately. The
  // test asserted only status 200 + calls>=3, both of which a plain recover-on-retry satisfies — so it
  // passed identically whether or not the absorb's real behaviour (release the slot, WAIT OUT a penalty
  // that is STILL IN FORCE, re-acquire, retry) worked at all.
  //
  // Two changes make it faithful:
  //  1. a per-ACCOUNT governor cache (see perAccountGovernors), matching the production keying, so a
  //     penalty PERSISTS for the account that earned it;
  //  2. BOTH pool accounts get penalized, so there is no healthy sibling to rotate to and the absorb has
  //     no option but to wait. With the old fresh-per-call factory neither account is ever paused, so
  //     the elapsed-time and slot-release assertions below are unsatisfiable — they are what pins the fix.
  //
  // Timing robustness (the second half of EI-2648: this test flaked once on a cold isolated run). Every
  // timing assertion here is a LOWER bound on elapsed time, which a slow or loaded process can only make
  // MORE true — the old flake was the opposite shape (finishing too fast because the absorb never
  // engaged). The absorb budget is sized 8× the penalty so a cold start cannot exhaust it.
  const PENALTY_MS = 1000; // retry-after:1 ⇒ a ~1s account pause (retry-after is seconds; 1 is its floor)
  const ABSORB_MS = 8000; // 8× headroom over PENALTY_MS so a loaded box still comfortably out-waits it
  let calls = 0;
  const penalizedAccounts: string[] = [];
  // Observed at fetch time: was the OTHER account still paused when this attempt went out? This is the
  // direct evidence that a penalty persisted across iterations rather than evaporating with the governor.
  let sawPersistingPenalty = false;
  const { governorFor, byAccount, counts } = perAccountGovernors();
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const id = ((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer\s+/i, '');
    if ([...byAccount.values()].some((g) => g.state.pausedUntil > Date.now())) sawPersistingPenalty = true;
    // The first attempt on EACH account 429s with a short retry-after, penalizing that account for
    // ~PENALTY_MS. Once both are penalized there is nowhere left to rotate, so the next attempt can only
    // proceed after a real wait. Everything after that succeeds.
    if (calls <= 2) {
      penalizedAccounts.push(id);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'true', 'retry-after': '1' },
      });
    }
    return new Response(JSON.stringify({ ok: true, servedBy: id }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A'), acct('B')]), // 2 accounts → the first 429 ROTATES, the second leaves none healthy
    fetchImpl,
    governorFor,
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    // A SHORT slot-hold deadline, so the 429s exhaust it and reach the absorb path. Not 0: since
    // WI-6554700010011504 a spent budget sheds BEFORE attempt 1 (no upstream call at all), so 0 now
    // means "no attempt can ever start" rather than "absorb on the first 429" (WI-6554700010012381).
    internalRetryDeadlineMs: SHORT_RETRY_DEADLINE_MS,
    requestAbsorbMs: ABSORB_MS, // ENABLE extended absorption (off by default)
  });
  port = await gw.listen(0);
  const startedMs = Date.now();
  const res = await post();
  const elapsedMs = Date.now() - startedMs;

  assert.equal(res.status, 200,
    `absorb-retry held the caller through the transient 429s (calls=${calls}, elapsed=${elapsedMs}, acquires=${counts.acquires}, releases=${counts.releases}, response=${res.status === 200 ? 'ok' : await res.text()})`);
  assert.ok(calls >= 3, `it kept re-acquiring + retrying through the 429s until the 200 (calls=${calls})`);

  // THE ASSERTIONS THE OLD FRESH-GOVERNOR VERSION COULD NOT MAKE:
  assert.equal(byAccount.size, 2, 'both pool accounts got their own persistent governor (per-account keying, as in production)');
  assert.deepEqual([...new Set(penalizedAccounts)].sort(), ['A', 'B'], 'the 429s landed on DIFFERENT accounts (the request rotated), so both were penalized');
  assert.ok(sawPersistingPenalty, 'a penalty written by an earlier attempt was STILL IN FORCE on a later one — i.e. it persisted across the retry instead of dying with a throwaway governor');
  assert.ok(
    elapsedMs >= PENALTY_MS * 0.9,
    `the caller was held for at least the penalty (~${PENALTY_MS}ms) — proof the absorb WAITED the pause out rather than re-acquiring instantly (elapsed=${elapsedMs}ms)`,
  );
  assert.ok(
    counts.releases >= 2,
    `the slot was RELEASED before each re-acquire rather than held across the wait — the absorb's actual contract (acquires=${counts.acquires}, releases=${counts.releases})`,
  );
  assert.ok(counts.acquires >= 3, `and re-acquired each time it retried (acquires=${counts.acquires})`);
});

test('EXTENDED ABSORB — a FRESH-per-call governor factory cannot hold a penalty (the anti-pattern EI-2648 fixed; pins why the test above uses a per-account cache)', async () => {
  // Guard against silently drifting back to `governorFor: () => new RateLimitGovernor(...)` in tests whose
  // subject is penalties/pacing. This asserts the DIFFERENCE directly: with a throwaway governor per call,
  // no account is ever observed paused, so a test written this way cannot distinguish "the absorb waited a
  // real penalty out" from "the upstream simply recovered". Documenting it as an executable fact is safer
  // than a comment — and safer than proving it by temporarily editing source, which on this shared tree
  // git-sync would commit (EI-19447067535467975).
  let calls = 0;
  const issuedByAccount = new Map<string, RateLimitGovernor[]>();
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'true', 'retry-after': '1' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A'), acct('B')]),
    fetchImpl,
    governorFor: (_model: string, accountId: string) => {
      const g = new RateLimitGovernor({ maxConcurrent: 20 }); // the anti-pattern: a NEW governor every call
      const seen = issuedByAccount.get(accountId) ?? [];
      seen.push(g);
      issuedByAccount.set(accountId, seen);
      return g;
    },
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: SHORT_RETRY_DEADLINE_MS,
    requestAbsorbMs: 8000,
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 200, 'it still succeeds — which is exactly the problem: success here proves nothing about the absorb');

  // The defect, stated deterministically: the SAME account is handed multiple DISTINCT governors, so a
  // penalty recorded on one instance is invisible to the instance the next acquire consults. No timing is
  // involved, so this cannot flake under load.
  const reused = [...issuedByAccount.entries()].filter(([, gs]) => gs.length > 1);
  assert.ok(
    reused.length > 0,
    `at least one account was issued MULTIPLE distinct governors (per-account counts: ${JSON.stringify(
      Object.fromEntries([...issuedByAccount].map(([k, v]) => [k, v.length])),
    )}) — a faithful per-account factory would issue exactly one each`,
  );
  // And the abandonment is load-bearing: an instance that actually recorded a penalty was then discarded
  // in favour of a fresh, un-penalized one for the same account. That is precisely why the wait-out path
  // was unreachable through this seam.
  const abandonedPenalty = reused.some(([, gs]) => gs.slice(0, -1).some((g) => g.state.pausedUntil > 0) && gs[gs.length - 1]!.state.pausedUntil === 0);
  assert.ok(
    abandonedPenalty,
    'a governor that had recorded a real penalty was replaced, for the same account, by a fresh un-penalized one — the penalty died with the throwaway instance, so no pause was ever in force when the absorb re-acquired',
  );
});

test('EXTENDED ABSORB — also holds the caller through a 529 SERVER-OVERLOAD (not just rate-429s) until it clears (2026-06-22)', async () => {
  let calls = 0;
  // A 529 overloaded_error (Anthropic server-side) on the first attempts, then a 200. A 529 is NOT a per-account
  // rate penalty (the account isn't paused), so the absorb backs off OVERLOAD_529_BACKOFF (1s) before each
  // re-acquire rather than hammering the overload. A single account suffices (the 529 path retries in place).
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A')]),
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: SHORT_RETRY_DEADLINE_MS, // exhausted by the 529s → each reaches the forward-absorb
    requestAbsorbMs: 8000, // > 2 × OVERLOAD_529_BACKOFF (1s) so the absorb out-waits the overload
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 200, 'absorb held the caller through the 529 overload + returned the eventual 200');
  assert.ok(calls >= 3, `it backed off + re-acquired through the 529s until the 200 (calls=${calls})`);
});

test('STALL ABSORB (#2, su-3650b) — a MULTI-account transport-stall storm is held + succeeds instead of a 503 (2026-06-23)', async () => {
  let calls = 0;
  // Both proxy accounts transport-FAIL (stall/dead-proxy) the first few calls — the Anthropic-wide storm — then
  // recover (200). The request rotates A→B (everRotated) so the stall-absorb is eligible; it releases the slot +
  // re-acquires (waiting out the short transport pause) + retries instead of sheding the retryable 503.
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 3) throw new Error('socket hang up'); // transport failure
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A'), acct('B')]), // 2 proxy accounts → ROTATES → stall-absorb eligible
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: 50,
    requestAbsorbMs: 8000, // absorb on
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 200, 'stall-absorb held the caller through the transport storm + returned the 200, not a 503');
  assert.ok(calls >= 4, `it re-acquired + retried through the stalls until recovery (calls=${calls})`);
});

test('STALL ABSORB — a LONE dead proxy (no rotation alternative) still sheds FAST (no 60s hold) — the everRotated guard', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error('socket hang up'); // permanently dead — never recovers
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD')]), // single account → never rotates → everRotated false → no stall-absorb
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: 50,
    requestAbsorbMs: 8000, // absorb ON — but the guard must keep it from holding through a dead proxy
  });
  port = await gw.listen(0);
  const t0 = Date.now();
  const res = await post();
  assert.equal(res.status, 503, 'a lone dead proxy sheds a retryable 503 fast, NOT held for the absorb budget');
  assert.ok(Date.now() - t0 < 4000, `shed fast (no multi-second absorb hold): ${Date.now() - t0}ms`);
});

test('INTERACTIVE fail-fast — a human-labeled caller caps its absorb + sheds fast, while an autonomous role holds the full budget (no-pin-hang follow-up #2, 2026-06-23)', async () => {
  // A never-recovering 529 storm. An AUTONOMOUS caller (x-papercusp-priority: queen) absorbs — releasing the
  // slot + re-acquiring through OVERLOAD_529_BACKOFF (1s) each iteration — for the full requestAbsorbMs budget
  // before shedding. A HUMAN-facing caller (x-papercusp-priority: interactive) must shed FAST: its absorb is
  // capped at interactiveAbsorbMs, so a person at a prompt gets a quick retryable error instead of a multi-
  // second hang. We count upstream attempts: the capped human makes strictly fewer than the full-budget hold.
  const run = async (priority: string, closeAfter: boolean) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
        { status: 529, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    gw = createInferenceGateway({
      pool: createFailoverPool([acct('A')]), // single account → the 529 path retries in place
      fetchImpl,
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      selfHeal: { enabled: false },
      maxQueueWaitMs: 50,
      internalRetryDeadlineMs: SHORT_RETRY_DEADLINE_MS, // exhausted by the 529s → each reaches the absorb
      requestAbsorbMs: 3500, // autonomous hold budget (> several OVERLOAD_529_BACKOFF of 1s)
      interactiveAbsorbMs: 20, // human cap: shed almost immediately
    });
    port = await gw.listen(0);
    const res = await post({ 'x-papercusp-priority': priority });
    const status = res.status;
    await res.text();
    if (closeAfter) await gw.close();
    return { calls, status };
  };

  const human = await run('interactive', true); // capped → sheds/forwards after ~1 attempt
  const auto = await run('mug', false); // full budget → absorbs through several attempts (afterEach closes it)
  // The human gets a FAST response (a forwarded 529 overload or a shed 503/429 — all retryable), NOT a hold:
  // the proof is that it made far fewer upstream attempts than the autonomous 'mug' that held the full budget.
  assert.ok(human.status >= 400, `human interactive got a client-visible retryable error fast (got ${human.status})`);
  assert.ok(
    auto.calls > human.calls,
    `the capped human shed fast (${human.calls} attempt(s)) while the autonomous 'mug' absorbed through more (${auto.calls})`,
  );
});

test('GET /admin/route?owner — reports the account that served an identified owner\'s most-recent turn (routed-account visibility, 2026-06-22)', async () => {
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('OK')]),
    fetchImpl: egressFetch(new Set()), // OK is healthy → serves 200
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
  });
  port = await gw.listen(0);
  // Unknown owner before any request → account null (never falsely attributed).
  const before = (await (await fetch(`http://127.0.0.1:${port}/admin/route?owner=su-xyz`)).json()) as { account: string | null };
  assert.equal(before.account, null, 'no route recorded yet for an unseen owner');
  // An IDENTIFIED request (x-papercusp-owner) served by OK records the route.
  const res = await post({ 'x-papercusp-owner': 'su-xyz' });
  assert.equal(res.status, 200, 'the request is served');
  const after = (await (await fetch(`http://127.0.0.1:${port}/admin/route?owner=su-xyz`)).json()) as { account: string | null; owner: string | null };
  assert.equal(after.account, 'OK', 'the served account is reported back for the owner (what the statusline shows)');
  assert.equal(after.owner, 'su-xyz', 'the queried owner is echoed');
});

test('a bee-facing egress-exhausted 503 RECORDS a stall for an IDENTIFIED bee (autowake coverage, 2026-06-22)', async () => {
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD')]), // single dead account, no failover target → bee-facing 503
    fetchImpl: egressFetch(new Set(['DEAD'])),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 3000,
  });
  port = await gw.listen(0);
  const before = gw.stats().stallsRecorded;
  // An IDENTIFIED bee (x-papercusp-owner) that egress-exhausts must record a stall, so the stall-waker can
  // re-wake it when the account recovers — instead of the bee just dying on the retryable 503 with no retry.
  const res = await post({ 'x-papercusp-owner': 'bee-xyz' });
  assert.equal(res.status, 503, 'egress-exhausted with no failover target → retryable 503');
  assert.ok(gw.stats().stallsRecorded > before, 'a stall was recorded for the identified bee (the autowake gap fix)');
  // An UNIDENTIFIED request (no owner header) records NO stall — there is nothing to wake.
  const before2 = gw.stats().stallsRecorded;
  await post();
  assert.equal(gw.stats().stallsRecorded, before2, 'no x-papercusp-owner → no stall recorded (nothing to re-wake)');
});

test('a successful response RESETS the streak — a flapping proxy that recovers does not accumulate toward the circuit', async () => {
  const dead = new Set<string>(['FLAP']);
  gw = createInferenceGateway({
    // Single-account pool: the account must recover in place (no failover to mask it).
    pool: createFailoverPool([acct('FLAP')]),
    fetchImpl: egressFetch(dead),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 3000,
  });
  port = await gw.listen(0);
  // Two failures — below the threshold of 3, so no circuit yet.
  await post();
  await post();
  assert.equal(gw.stats().egressCircuitOpens, 0, 'two failures (< threshold) have not opened a circuit');
  // The proxy recovers; a 200 must reset the streak.
  dead.clear();
  const ok = await post();
  assert.equal(ok.status, 200, 'the recovered proxy serves a 200');
  // One MORE failure must NOT open the circuit: the success reset the streak, so this is streak 1, not 3.
  dead.add('FLAP');
  await post();
  assert.equal(
    gw.stats().egressCircuitOpens,
    0,
    'the successful response RESET the transport-failure streak — a single post-recovery failure does not re-open the circuit',
  );
});

// WI-6554700010009426 (2026-10-12 mass-resume collapse): an ADMITTED attempt that dies on the wire spent
// its slot and produced nothing. Before the fix only a mid-relay death contracted the claude lane, so a
// herd of TTFB/transport failures left the window wide open and every abort re-uploaded its whole body
// onto a saturated uplink. The window must contract on the transport failure itself — and must NOT
// contract when the same traffic is clean (the control, so this cannot pass vacuously).
// WI-6554700010011426 (plan gateway-admission-congestion-only-2026-10-13 P-002) replaced
// WI-6554700010009426's "an admitted transport failure CONTRACTS the window" contract:
// one request's transport failure is one unit of pressure, and the window contracts
// only when that pressure is sustained across distinct requests.
test('a lone admitted transport failure does NOT contract the claude admission window', async () => {
  const dead = new Set<string>(['DEAD']);
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD'), acct('OK')]),
    fetchImpl: egressFetch(dead),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
  });
  port = await gw.listen(0);
  const initial = gw.stats().admission.maxConcurrent;
  const clean = await post({ 'x-papercusp-account': 'OK' });
  assert.equal(clean.status, 200);
  assert.equal(gw.stats().admission.maxConcurrent, initial, 'a clean success does not contract the window');
  const res = await post({ 'x-papercusp-account': 'DEAD' });
  assert.equal(res.status, 200, 'the request still fails over and is served');
  assert.ok(Object.keys(gw.stats().egressFailsByAccount ?? {}).length > 0, 'CALIBRATION: the transport failure happened');
  assert.equal(gw.stats().admission.maxConcurrent, initial, 'one slow request cannot shrink the lane');
});

test('admitted transport failures still reach the claude window once pressure is sustained (herd guard wiring)', async () => {
  const dead = new Set<string>(['DEAD']);
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD'), acct('OK')]),
    fetchImpl: egressFetch(dead),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
    // A threshold of one distinct request makes the herd guard observable with one request.
    aimd: { decreaseThreshold: 1 },
  });
  port = await gw.listen(0);
  const initial = gw.stats().admission.maxConcurrent;
  const res = await post({ 'x-papercusp-account': 'DEAD' });
  assert.equal(res.status, 200, 'the request still fails over and is served');
  assert.ok(
    gw.stats().admission.maxConcurrent < initial,
    `the transport failure reached the claude window (${initial} → ${gw.stats().admission.maxConcurrent})`,
  );
});

// gateway-admission-congestion-only-2026-10-13 R-5 / P-004: one request cannot burn every account.
// A very large uncached prompt that is slow to start times out on first byte on EVERY account. Before
// P-004 each timeout failed over to the next account (up to the six-attempt budget) and the stall
// absorb then re-entered the whole ladder, re-uploading the same prompt each time. The request must
// now stop after the TTFB bound (two attempts) and return an error, even with more healthy-looking
// accounts left and the absorb budget still open.
test('a request that times out on first byte on every account is attempted on at most two accounts (R-5)', async () => {
  const calls: string[] = [];
  const stallingFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    calls.push(auth.replace(/^Bearer\s+/i, ''));
    // Headers never arrive; only the gateway's TTFB deadline (an abort) ends the wait.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A1'), acct('A2'), acct('A3'), acct('A4')]),
    fetchImpl: stallingFetch,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
    upstreamHeadersTimeoutMs: 40,
    // An open absorb budget: without the bound, the stall absorb would re-enter the ladder.
    requestAbsorbMs: 3000,
  });
  port = await gw.listen(0);

  const res = await post();
  await res.arrayBuffer();

  assert.ok(res.status >= 500, `the request fails rather than hanging (status ${res.status})`);
  assert.equal(calls.length, 2, `attempted on ${calls.length} account(s): ${calls.join(', ')}`);
  assert.equal(new Set(calls).size, 2, 'the two attempts went to two different accounts');
});

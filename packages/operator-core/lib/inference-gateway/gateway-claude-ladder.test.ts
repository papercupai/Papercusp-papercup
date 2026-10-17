/**
 * gateway-claude-ladder.test.ts — CHARACTERIZATION goldens for the Claude lane's
 * attempt ladder (`proxy`, the `/v1/messages` route), written for P-006 of plan
 * gateway-kernel-adoption-2026-08-29 BEFORE that lane moves onto
 * `executeGatewayRequestKernel`.
 *
 * WHY A SEPARATE FILE. gateway.test.ts already covers this lane broadly (157
 * tests) and remains the acceptance bar, but it runs ~102s, which makes it a poor
 * loop to iterate a migration against. The repo already splits focused gateway
 * concerns out this way (gateway-egress-circuit.test.ts,
 * gateway-egress-false-recovery.test.ts); this follows that precedent rather than
 * forking a parallel suite.
 *
 * WHAT THESE PIN, AND WHY THESE FOUR. A kernel migration re-expresses the ladder's
 * retry DECISIONS as adapter hooks, so the failures it can introduce silently are
 * ordering and budget failures — not the individual outcomes gateway.test.ts
 * already asserts. Each golden below targets one such seam, and each is the
 * behaviour a plan Decision says must survive:
 *
 *   1. ORDER — a same-account sibling-egress retry is tried BEFORE any
 *      cross-account rotation. gateway.test.ts:2990 proves the sibling rotate
 *      happens, but its pool holds ONE account, so it cannot distinguish "tried
 *      the sibling first" from "had nowhere else to go". D-011 / D-012.
 *   2. HARD PIN — that same sibling retry is still permitted under a hard pin.
 *      gateway.test.ts:1239 proves a hard pin never FAILS OVER; nothing proved it
 *      still REATTEMPTS. This is precisely D-011's reason for existing: the kernel
 *      returned null for a hard pin before consulting the adapter, so a naive
 *      migration turns this recovered 200 into a forwarded 429.
 *   3. FALLTHROUGH — with no sibling IP available, the SAME failure does rotate
 *      accounts. Read with #1 this is what actually establishes the ordering
 *      rather than merely asserting one branch.
 *   4. FAILOVER ACCOUNTING — a sibling-IP retry is NOT counted as a failover.
 *      The egress key changes on such a retry, so a migration that counts
 *      failovers by ROUTE KEY (as the bearer lane legitimately does) silently
 *      inflates this lane's count on every sibling retry. D-011.
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createInferenceGateway, ACCOUNT_HEADER, ACCOUNT_PIN_HEADER, ROUTED_ACCOUNT_HEADER } from './gateway';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { RateLimitGovernor, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import {
  configureGatewayRequestOutcomeStore,
  InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
} from './gateway-request-outcome-store';

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let port = 0;
const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

// Owner reports include durable outcomes; unit fixtures must not query PostgreSQL.
beforeEach(() => configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore()));

afterEach(async () => {
  await gw?.close();
  gw = undefined;
  resetGovernorRegistry();
  resetGatewayRequestOutcomeStore();
});

/** A BARE burst 429: rate_limit_error with NO anthropic-ratelimit-* / retry-after headers. */
const bare429 = () =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
const ok200 = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

/** An account with `ips` distinct egress entries, so sibling-IP rotation is available. */
function acct(id: string, ips: number): ActiveAccount {
  return {
    accountId: id,
    token: async () => `${id}-tok`,
    egressPool: Array.from({ length: ips }, (_, i) => ({ proxyUrl: `http://127.0.0.1:${3200 + i}` })),
  } as ActiveAccount;
}

const messagesBody = JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
const post = (extraHeaders: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...extraHeaders },
  body: messagesBody,
});

test('EI-25729445450023140: failed absorb reacquire attributes the forwarded response to its upstream account', async () => {
  const A = acct('A', 0);
  const B = acct('B', 0);
  const owner = 'su-absorb-response-account';
  const upstreamAccounts: string[] = [];
  const governorA = new RateLimitGovernor({ maxConcurrent: 20 });
  const governorB = new RateLimitGovernor({ maxConcurrent: 20 });
  // Candidate B never gets a slot, so it cannot have produced an upstream response.
  const reacquire = vi.spyOn(governorB, 'acquire').mockResolvedValue(null);
  const fetchImpl = (async (_url: string, init: { headers?: Record<string, string> }) => {
    upstreamAccounts.push(init.headers?.authorization ?? init.headers?.Authorization ?? '');
    return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"account A quota"}}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '3600', 'x-should-retry': 'true' },
    });
  }) as unknown as typeof fetch;
  const pool: AccountPool = {
    // A supplies the response; the absorb rung subsequently chooses B.
    active: () => upstreamAccounts.length ? B : A,
    onExhausted: () => null,
    select: (id) => id === 'A' ? A : id === 'B' ? B : null,
  };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: (_model, account) => account === 'A' ? governorA : governorB,
    maxQueueWaitMs: 200,
    requestAbsorbMs: 30_000,
  });
  port = await gw.listen(0);

  const response = await ask('/v1/messages', {
    ...post({ 'x-papercusp-owner': owner }),
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(upstreamAccounts, ['Bearer A-tok'], 'B was only an admission candidate, never an upstream attempt');
  assert.equal(reacquire.mock.calls.length, 1, 'the absorb rung tried and failed to acquire B');
  assert.equal(response.headers.get(ROUTED_ACCOUNT_HEADER), 'A');
  assert.equal(response.headers.get('x-should-retry'), 'false', 'the exhausted response remains terminal');
  assert.match(await response.text(), /account A quota/, 'the forwarded body still belongs to A');
  const report = await (await ask(`/admin/owner-report?owner=${owner}`)).json() as {
    ledger: { lastAccount: string; lastStatus: number; recent: Array<{ kind: string; account: string }> };
    lastRoute: { account: string };
  };
  assert.equal(report.ledger.lastAccount, 'A', 'the outcome ledger must name the account that supplied the response');
  assert.equal(report.ledger.lastStatus, 429);
  assert.equal(report.ledger.recent.at(-1)?.kind, 'upstream_429');
  assert.equal(report.ledger.recent.at(-1)?.account, 'A');
  assert.equal(report.lastRoute.account, 'A', 'session affinity must retain the actual response account');
});

test('[P-006 golden] a bare-burst 429 retries a SIBLING egress IP on the SAME account BEFORE rotating accounts (ordering, D-011/D-012)', async () => {
  resetGovernorRegistry();
  // TWO healthy accounts, each with TWO egress IPs. gateway.test.ts:2990 proves the sibling rotate with a
  // ONE-account pool, which cannot separate "sibling first" from "nothing else available". Here account B is
  // fully healthy and reachable, so rotating to it is a live option the ladder must NOT take first.
  const seen: { dispatcher?: unknown; token: string }[] = [];
  const A = acct('A', 2);
  const B = acct('B', 2);
  let onExhaustedCalls = 0;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown; headers?: Record<string, string> }) => {
    const auth = (init.headers?.authorization ?? init.headers?.Authorization ?? '') as string;
    seen.push({ dispatcher: init.dispatcher, token: auth });
    return seen.length === 1 ? bare429() : ok200();
  }) as unknown as typeof fetch;

  const pool: AccountPool = {
    active: () => A,
    onExhausted: () => {
      onExhaustedCalls += 1;
      return B;
    },
    select: (id: string) => (id === 'A' ? A : id === 'B' ? B : null),
  };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
    bare429FailoverBackoffMs: 50,
  });
  port = await gw.listen(0);

  const r = await ask('/v1/messages', post());

  assert.equal(r.status, 200, 'the bare-burst 429 was recovered, not forwarded');
  assert.equal(seen.length, 2, 'exactly two upstream attempts');
  assert.notEqual(seen[0].dispatcher, seen[1].dispatcher, 'the retry used a DIFFERENT egress IP');
  assert.ok(
    seen[1].token.includes('A-tok'),
    'the retry stayed on account A’s credential — a sibling-IP retry, NOT a rotation to the healthy account B',
  );
  assert.equal(
    onExhaustedCalls,
    0,
    'pool.onExhausted was never consulted: the cheap same-account retry is tried BEFORE any cross-account rotation',
  );
  resetGovernorRegistry();
});

test('[P-006 golden] a HARD PIN still permits the same-account sibling-IP retry (D-011 — reattempt is consulted even under a hard pin)', async () => {
  resetGovernorRegistry();
  // The exact shape that made D-011 necessary on the oauth lane: the kernel returned null for a hard pin
  // BEFORE consulting the adapter, so a naive migration converts this recovered 200 into a forwarded 429.
  // A hard pin forbids changing ACCOUNT; it does not forbid changing egress IP on that same account.
  const seen: { dispatcher?: unknown }[] = [];
  const A = acct('A', 2);
  const B = acct('B', 2);
  let onExhaustedCalls = 0;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    seen.push({ dispatcher: init.dispatcher });
    return seen.length === 1 ? bare429() : ok200();
  }) as unknown as typeof fetch;

  const pool: AccountPool = {
    active: () => A,
    onExhausted: () => {
      onExhaustedCalls += 1;
      return B;
    },
    select: (id: string) => (id === 'A' ? A : id === 'B' ? B : null),
  };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
    bare429FailoverBackoffMs: 50,
  });
  port = await gw.listen(0);

  const r = await ask('/v1/messages', post({ [ACCOUNT_HEADER]: 'A', [ACCOUNT_PIN_HEADER]: 'hard' }));

  assert.equal(r.status, 200, 'the hard-pinned request still recovered via its sibling egress IP');
  assert.equal(seen.length, 2, 'the hard pin did not suppress the same-account retry');
  assert.notEqual(seen[0].dispatcher, seen[1].dispatcher, 'the retry used a different egress IP on the pinned account');
  assert.equal(onExhaustedCalls, 0, 'a hard pin never rotates accounts');
  resetGovernorRegistry();
});

test('[P-006 golden] with NO sibling egress IP the same bare-burst 429 DOES rotate accounts (the fallthrough half of the ordering)', async () => {
  resetGovernorRegistry();
  // The complement of golden #1. Same stimulus, same pool shape, one variable changed: account A now has a
  // SINGLE egress IP, so the cheap same-account retry is unavailable. Read together, the pair establishes the
  // ORDER (sibling first, rotate second) rather than asserting one branch in isolation.
  const seen: { token: string }[] = [];
  const A = acct('A', 1);
  const B = acct('B', 1);
  let onExhaustedCalls = 0;
  const fetchImpl = (async (_url: string, init: { headers?: Record<string, string> }) => {
    const auth = (init.headers?.authorization ?? init.headers?.Authorization ?? '') as string;
    seen.push({ token: auth });
    return seen.length === 1 ? bare429() : ok200();
  }) as unknown as typeof fetch;

  const pool: AccountPool = {
    active: () => A,
    onExhausted: () => {
      onExhaustedCalls += 1;
      return B;
    },
    select: (id: string) => (id === 'A' ? A : id === 'B' ? B : null),
  };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
    bare429FailoverBackoffMs: 50,
  });
  port = await gw.listen(0);

  const r = await ask('/v1/messages', post());

  assert.equal(r.status, 200, 'the request recovered by rotating to the healthy account');
  assert.equal(seen.length, 2, 'exactly two upstream attempts');
  assert.equal(
    onExhaustedCalls,
    1,
    'pool.onExhausted was consulted EXACTLY ONCE — it both parks and returns the next account, so a second call site would leak a parked account per retry (D-012 constraint 2)',
  );
  assert.ok(seen[1].token.includes('B-tok'), 'the retry ran on the rotated-to account B');
  resetGovernorRegistry();
});

test('[P-006 golden] a sibling-IP retry is NOT counted as a failover (count by ACCOUNT change, not route key — D-011)', async () => {
  resetGovernorRegistry();
  // The bearer lane (P-003) legitimately counts failovers by ROUTE-KEY change, because rotation is the only
  // thing that changes a bearer key there. Copying that here would inflate this lane's failover count on every
  // sibling-IP retry, because such a retry changes the egress key while deliberately keeping the account.
  // /stats is the observable surface, so pin it rather than an internal counter.
  const seen: unknown[] = [];
  const A = acct('A', 2);
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    seen.push(init.dispatcher);
    return seen.length === 1 ? bare429() : ok200();
  }) as unknown as typeof fetch;

  const pool: AccountPool = {
    active: () => A,
    onExhausted: () => null,
    select: (id: string) => (id === 'A' ? A : null),
  };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
    bare429FailoverBackoffMs: 50,
  });
  port = await gw.listen(0);

  const r = await ask('/v1/messages', post());
  assert.equal(r.status, 200, 'recovered on the sibling IP');
  assert.equal(seen.length, 2, 'two attempts: throttled IP, then sibling IP');

  const stats = (await (await ask('/stats')).json()) as { failovers?: number };
  assert.equal(
    stats.failovers ?? 0,
    0,
    'a same-account sibling-IP retry must NOT increment failovers — the account never changed',
  );
  resetGovernorRegistry();
});

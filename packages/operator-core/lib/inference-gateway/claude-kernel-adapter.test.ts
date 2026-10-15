/**
 * P-006 (plan `gateway-kernel-adoption-2026-08-29`) — the Claude
 * (`anthropic-messages` / `oauth-http`) adapter driven through the REAL
 * `executeGatewayRequestKernel` with NO gateway wiring, exactly as P-002/P-004
 * did for the bearer and codex-oauth lanes.
 *
 * Each test names the `proxy` behaviour it pins. The ones that matter most are the
 * SAME-ACCOUNT re-attempts (D-011) — a bare-burst 429 or transport failure retries
 * the same account on a sibling egress IP, and a 529 backs off on the same account
 * — because none is gated on the hard pin in the live handler and none is counted
 * as a failover. The complementary `gateway-claude-ladder.test.ts` goldens pin the
 * same seams end-to-end through the live handler; these pin them at the adapter.
 */
import { describe, expect, it } from 'vitest';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import {
  createClaudeKernelAdapter,
  type ClaudeAdapterOptions,
  type ClaudeChunk,
  type ClaudeFetchResponse,
  type ClaudePreparedAttempt,
  type ClaudeResponseClassification,
  type ClaudeResponseMetadata,
  type ClaudeRouteValue,
} from './claude-kernel-adapter';
import {
  executeGatewayRequestKernel,
  GatewayRequestKernelError,
  type ExecuteGatewayRequestKernelOptions,
  type GatewayKernelAccountPin,
  type GatewayKernelPolicy,
} from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

const POLICY: GatewayKernelPolicy = {
  maxBodyBytes: 4096,
  bodyReadTimeoutMs: 2_000,
  requestCeilingMs: 10_000,
  ttfbTimeoutMs: 2_000,
  bodyIdleTimeoutMs: 2_000,
  downstreamIdleTimeoutMs: 2_000,
  maxAttempts: 4,
};

const unusedPool: AccountPool = {
  active: () => {
    throw new Error('unused pool');
  },
  onExhausted: () => null,
  select: () => null,
};

const laneRegistry = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
});
const lane = laneRegistry.anthropicMessages;

const acct = (accountId: string): ActiveAccount =>
  ({ accountId, token: async () => `${accountId}-tok` }) as ActiveAccount;

function res(status: number, headers: Record<string, string> = {}): ClaudeFetchResponse {
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    body: status === 200 ? (async function* () { yield Buffer.from('{"ok":true}'); })() : null,
  };
}

/** A response carrying a real error BODY, split across several chunks so the
 *  classification peek has to reassemble it — and so the replay is proven to
 *  restore the whole stream, not just the first chunk. */
function errorRes(status: number, body: string, headers: Record<string, string> = {}): ClaudeFetchResponse {
  const chunks = body.match(/[\s\S]{1,8}/g) ?? [];
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    body: (async function* () {
      for (const c of chunks) yield Buffer.from(c);
    })(),
  };
}

/** Stands in for the caller's Anthropic predicates (`classifyHttpError`,
 *  `parseUsageReset`, `ORG_DISALLOWED_RE`), which stay in gateway.ts under D-013.
 *  Deliberately reads the BODY, which is the whole point: status and headers
 *  cannot separate these shapes. */
const CAP_RESET_AT = 4_000_000_000_000;
function classifier(input: { status: number; headers: Record<string, string>; body: string }) {
  if (input.status === 429 && /session limit/i.test(input.body))
    return { kind: 'usage-cap' as const, resetAt: CAP_RESET_AT };
  if (input.status === 429 && (input.headers['retry-after'] || input.headers['anthropic-ratelimit-unified-reset']))
    return { kind: 'rate-429' as const };
  if (input.status === 429) return { kind: 'bare-429' as const };
  if (input.status === 529) return { kind: 'overload' as const };
  if (input.status === 403 && /disallowed|not allowed/i.test(input.body))
    return { kind: 'org-disallowed' as const, resetAt: CAP_RESET_AT };
  return { kind: 'forward' as const };
}

/** A pool whose rotation sequence is scripted, recording every onExhausted call so
 *  the D-012 "exactly one call site" constraint is directly observable. */
function makePool(rotation: (ActiveAccount | null)[]) {
  const calls: { id: string; resetAt: number }[] = [];
  let cursor = 0;
  const pool: AccountPool = {
    active: () => {
      // D-010: the adapter must NEVER call active() — it would advance the
      // round-robin a second time for one request.
      throw new Error('adapter called pool.active() — D-010 violation');
    },
    select: () => null,
    onExhausted: (id: string, resetAt: number) => {
      calls.push({ id, resetAt });
      return (rotation[cursor++] ?? null) as ReturnType<AccountPool['onExhausted']>;
    },
  };
  return { pool, calls };
}

interface Overrides {
  accounts?: ActiveAccount[];
  pool?: AccountPool;
  pin?: GatewayKernelAccountPin | null;
  siblingEgressAvailable?: ClaudeAdapterOptions['siblingEgressAvailable'];
  pickEgress?: ClaudeAdapterOptions['pickEgress'];
  canRotate?: ClaudeAdapterOptions['canRotate'];
  classifyResponse?: ClaudeAdapterOptions['classifyResponse'];
  retryBudgetExhausted?: ClaudeAdapterOptions['retryBudgetExhausted'];
  policy?: Partial<GatewayKernelPolicy>;
}

function harness(fetchImpl: ClaudeAdapterOptions['fetch'], overrides: Overrides = {}) {
  const telemetry = new GatewayRequestTelemetry();
  const prepared: ClaudePreparedAttempt[] = [];
  const routeKeys: string[] = [];
  const routeDelays: number[] = [];
  const forwarded: Buffer[] = [];
  const observedClassifications: (ClaudeResponseClassification | null)[] = [];
  const observedErrors: string[] = [];
  const accounts = overrides.accounts ?? [acct('A')];
  let egressSeq = 0;

  const adapter = createClaudeKernelAdapter({
    initialAccount: accounts[0]!,
    pool: overrides.pool,
    upstreamUrl: 'https://anthropic.test/v1/messages',
    method: 'POST',
    baseHeaders: { 'content-type': 'application/json' },
    body: null,
    streaming: true,
    tokenTimeoutMs: 1_000,
    failoverBackoffMs: 5_000,
    // D-018: DISTINCT and SMALL. Distinct so a test can tell which option a route's
    // pace was read from (production ships 1000 / 400, and two equal numbers would
    // pass even if the adapter used the wrong one); small because the kernel really
    // sleeps them, and this suite exercises the retry ladder dozens of times.
    overloadBackoffMs: 30,
    transientBackoffMs: 20,
    // Each pick returns a DISTINCT key, mirroring a real egress pool round-robin —
    // which is exactly why failovers must not be counted by route key.
    pickEgress:
      overrides.pickEgress ??
      ((account) => ({ entry: undefined, key: `${account.accountId}:ip${++egressSeq}` })),
    siblingEgressAvailable: overrides.siblingEgressAvailable ?? (() => false),
    dispatcherFor: () => undefined,
    fetch: fetchImpl,
    rateReset: () => ({ resetAt: null, retryAfterMs: null }),
    canRotate: overrides.canRotate,
    classifyResponse: overrides.classifyResponse,
    retryBudgetExhausted: overrides.retryBudgetExhausted,
    peekBytes: 4096,
    peekTimeoutMs: 1_000,
  });

  const observed: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      routeKeys.push(context.route.key);
      routeDelays.push(context.route.delayMs ?? 0);
      const result = await adapter.prepareAttempt(context);
      prepared.push(result);
      return result;
    },
  };

  async function* body() {
    yield Buffer.from('{"model":"claude-opus-4"}');
  }

  const options: ExecuteGatewayRequestKernelOptions<
    ClaudeRouteValue,
    ClaudePreparedAttempt,
    ClaudeChunk,
    ClaudeResponseMetadata
  > = {
    request: {
      lane,
      body: body(),
      ownerId: 'su-claude-adapter',
      correlationId: 'claude-adapter-test',
      pin: overrides.pin ?? null,
    },
    policy: { ...POLICY, ...overrides.policy },
    telemetry,
    admission: {
      async run(_context, task) {
        return task();
      },
      // The caller's real side-effect seam (D-012 constraint 1). Recording what it
      // SEES is how we prove the body-derived classification actually reaches the
      // hook that fires gov.penalize / cooldowns / alerts.
      observeAttempt: ({ response, error }) => {
        observedClassifications.push(response?.metadata?.classification ?? null);
        if (error) observedErrors.push(error.message);
      },
    },
    adapter: observed,
    downstream: {
      start: () => undefined,
      write: (chunk) => {
        forwarded.push(Buffer.from(chunk));
      },
      end: () => undefined,
    },
    inFlight: { register: () => ({ unregister: () => undefined }) },
  };

  return {
    options,
    prepared,
    routeKeys,
    /** D-018: the pace each attempt's route carried, in attempt order. Index 0 is the
     *  INITIAL attempt and must always be 0 — a request never waits before its first
     *  upstream call. */
    routeDelays,
    /** Bytes actually relayed downstream — proves a peeked body is replayed whole. */
    forwardedBody: () => Buffer.concat(forwarded).toString('utf8'),
    observedClassifications,
    /** Per-attempt failure messages, as `observeAttempt` saw them. The kernel's
     *  TTFB error NAMES the deadline it armed, which is how the per-attempt cap
     *  below is observed without reaching into kernel internals. */
    observedErrors,
  };
}

describe('claude kernel adapter', () => {
  it('replays the caller-resolved account and never calls pool.active() (D-010)', async () => {
    const { pool } = makePool([]);
    const { options, prepared } = harness(async () => res(200), { accounts: [acct('A')], pool });
    // makePool's active() throws, so a passing run is itself the assertion.
    await executeGatewayRequestKernel(options);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.accountId).toBe('A');
  });

  it('preserves a typed authorization refusal without retrying a provider route', async () => {
    const refusal = new GatewayRequestKernelError('private reservation refused', {
      code: 'invalid-route', outcome: 'gateway-error', status: 403, retryable: false,
    });
    let sends = 0;
    const { options, prepared } = harness(async (_target, init) => {
      sends++; expect(init.diagnosticAccountId).toBe('A'); throw refusal;
    });
    await expect(executeGatewayRequestKernel(options)).rejects.toBe(refusal);
    expect(sends).toBe(1); expect(prepared).toHaveLength(1);
  });

  it('preserves undici fetch diagnostics and the original cause on transport failure', async () => {
    const fetchFailure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'read ECONNRESET' },
    });
    const { options } = harness(async () => { throw fetchFailure; }, { policy: { maxAttempts: 1 } });
    const error = await executeGatewayRequestKernel(options).then(
      () => { throw new Error('expected upstream failure'); },
      (reason: unknown) => reason as { code: string; message: string; cause?: unknown },
    );

    expect(error).toMatchObject({
      code: 'upstream-error',
      message: 'inference-gateway: claude upstream failed: fetch failed (ECONNRESET: read ECONNRESET)',
    });
    expect(error.cause).toBe(fetchFailure);
  });

  it('retries a SIBLING egress IP on the SAME account for a bare-burst 429, without consulting the pool (D-011)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a same-account sibling retry must not park or rotate the account').toHaveLength(0);
  });

  it('rotates accounts when NO sibling egress IP is available, calling onExhausted EXACTLY once (D-012 constraint 2)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe('A');
  });

  it('backs off and retries the SAME account on a 529, never rotating (server overload is not an account signal)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(529) : res(200)), {
      accounts: [acct('A')],
      pool,
      // Even with a sibling available, a 529 takes the same-account backoff branch.
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a 529 must never park a healthy account for the upstream’s outage').toHaveLength(0);
  });

  it('retries a 529 at most ONCE per account, then stops re-attempting it', async () => {
    const { pool, calls } = makePool([]);
    const { options, prepared } = harness(async () => res(529), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options).catch(() => undefined);
    // one initial + exactly one overload-backoff re-attempt; never an unbounded spin
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls).toHaveLength(0);
  });

  it('HARD PIN: the sibling-egress re-attempt still happens, while account rotation stays suppressed (D-011)', async () => {
    // The exact shape D-011 exists for. The kernel declines selectFailover under a
    // hard pin BEFORE consulting the adapter, but selectReattempt is still consulted
    // — so a naive migration turns this recovered 200 into a forwarded 429.
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      pin: { accountId: 'A', mode: 'hard' },
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a hard pin never rotates').toHaveLength(0);
  });

  it('declines rotation WITHOUT consulting the pool when canRotate() is false (fleet-wide bare-burst, G1)', async () => {
    // onExhausted both PARKS and returns, so checking the veto after calling it
    // would park an account for nothing. The veto must come first.
    const { pool, calls } = makePool([acct('B')]);
    const { options, prepared } = harness(async () => res(429), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
      canRotate: () => false,
    });
    await executeGatewayRequestKernel(options).catch(() => undefined);
    expect(prepared.map((p) => p.accountId)).toEqual(['A']);
    expect(calls, 'the suppressed rotate must not park an account as a side effect').toHaveLength(0);
  });

  it('never rotates back to an account already tried', async () => {
    // The pool offers A again after B; the adapter's triedAccounts guard declines.
    const { pool } = makePool([acct('B'), acct('A')]);
    const { options, prepared } = harness(async () => res(429), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options).catch(() => undefined);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
  });

  it('gives every same-account re-attempt a DISTINCT route key (the kernel’s route-cycle guard)', async () => {
    // A repeated key is rejected as a cycle, which is the easiest way to break a
    // D-011 re-attempt silently — so the key carries a monotonic sequence.
    const { pool } = makePool([]);
    let n = 0;
    const { options, routeKeys } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(routeKeys).toHaveLength(2);
    expect(new Set(routeKeys).size, 'route keys must be unique across same-account re-attempts').toBe(2);
    expect(routeKeys[0]).toContain('claude:A:initial');
    expect(routeKeys[1]).toContain('claude:A:sibling-egress');
  });

  it('resolves the token PER ATTEMPT, so a rotated-to account presents its OWN bearer', async () => {
    const { pool } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared[0]!.headers.authorization).toBe('Bearer A-tok');
    expect(prepared[1]!.headers.authorization, 'the rotation must re-auth, not reuse A’s bearer').toBe('Bearer B-tok');
  });

  it('retries a sibling egress IP on a bare TRANSPORT failure (no response at all)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () => {
        if (++n === 1) throw new Error('ECONNRESET');
        return res(200);
      },
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls).toHaveLength(0);
  });

  // ─── D-013: retry branches decided from the response BODY ──────────────────
  //
  // Each of these is INVISIBLE to status + headers alone, which is the whole
  // reason the classification cannot live in the caller's observeAttempt hook.
  // The matched pair is #1/#2: the SAME 429 status, the same available sibling
  // egress IP, opposite routing — the only difference is the body text.

  it('USAGE CAP: a 429 whose BODY names a session limit rotates the account, even though a sibling egress IP is free', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () =>
        ++n === 1
          ? errorRes(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}')
          : res(200),
      {
        accounts: [acct('A')],
        pool,
        // Deliberately TRUE: a cap is an ACCOUNT wall, so the sibling-IP retry
        // that a bare-burst would take must NOT be taken here.
        siblingEgressAvailable: () => true,
        classifyResponse: classifier,
      },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId), 'a capped account must be left, not retried on a new IP').toEqual([
      'A',
      'B',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resetAt, "the cap's own reset must park the account, not the short failover backoff").toBe(
      CAP_RESET_AT,
    );
  });

  it('BARE BURST: the same 429 status with a bare body retries the SAME account on a sibling IP (the matched control)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () => (++n === 1 ? errorRes(429, '{"error":{"message":"rate_limit_error"}}') : res(200)),
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a per-IP edge throttle must never park the account').toHaveLength(0);
  });

  it('RATE 429: a windowed 429 rotates instead of taking the sibling IP a bare burst would take', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () =>
        ++n === 1 ? errorRes(429, '{"error":{"message":"rate_limit_error"}}', { 'retry-after': '30' }) : res(200),
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(calls).toHaveLength(1);
  });

  it('ORG-DISALLOWED 403 rotates, while a PLAIN 403 is forwarded unretried (same status, different body)', async () => {
    const disallowed = makePool([acct('B')]);
    let n = 0;
    const rotated = harness(
      async () => (++n === 1 ? errorRes(403, '{"error":{"message":"OAuth is disallowed for this org"}}') : res(200)),
      { accounts: [acct('A')], pool: disallowed.pool, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(rotated.options);
    expect(rotated.prepared.map((p) => p.accountId)).toEqual(['A', 'B']);

    const plain = makePool([acct('B')]);
    const forwardedRes = harness(async () => errorRes(403, '{"error":{"message":"invalid_request"}}'), {
      accounts: [acct('A')],
      pool: plain.pool,
      classifyResponse: classifier,
    });
    await executeGatewayRequestKernel(forwardedRes.options);
    expect(forwardedRes.prepared.map((p) => p.accountId), 'an ordinary 403 is the caller’s to see').toEqual(['A']);
    expect(plain.calls).toHaveLength(0);
  });

  /**
   * D-018 — the inter-attempt PACE.
   *
   * The live ladder set `internalRetry.backoffMs` per 429 branch and slept it once
   * before `continue`. The first kernel wiring dropped it: `overloadBackoffMs` was
   * passed to the adapter and never read, and the transient-429 pace was not passed
   * at all. Nothing typechecked wrong and no adapter test failed — the only symptom
   * was the WI-673 rig going from 8 upstream 429s to 9, because a rotate fired
   * ~100ms after the 429 and landed inside the destination's own burst window.
   *
   * These assert the pace as ROUTE DATA (exact ms, read off each attempt's route)
   * rather than as elapsed wall time, so they are exact and cost nothing. That the
   * kernel actually SLEEPS a route's `delayMs` is the kernel's own contract and is
   * guarded in request-kernel.test.ts — one claim per suite, neither assumed.
   */
  it('D-018: a transient 429 rotate carries the TRANSIENT pace, and the initial attempt never waits', async () => {
    const { pool } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared, routeDelays } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(routeDelays, 'the destination may still be inside the window this account just tripped').toEqual([0, 20]);
  });

  it('D-018: a 529 overload re-attempt carries the OVERLOAD pace, never the transient one', async () => {
    const { pool } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared, routeDelays } = harness(async () => (++n === 1 ? res(529) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    // 30, not 20: a backoff branch that re-asks instantly is not a backoff, and the
    // two options are distinct here precisely so a mixed-up read cannot pass.
    expect(routeDelays).toEqual([0, 30]);
  });

  it('D-018: a sibling-egress re-attempt carries NO pace — the cooled IP is the fix, not a wait', async () => {
    const { pool } = makePool([]);
    let n = 0;
    const { options, prepared, routeDelays } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(routeDelays).toEqual([0, 0]);
  });

  it('D-018: an ACCOUNT-WALL rotate carries NO pace — the matched control for the transient rotate', async () => {
    // Same 429 STATUS and the same rotate decision as the transient case above; only
    // the body differs. A capped account is walled for hours, so pausing before
    // leaving it buys nothing and costs the bee latency — the live handler set
    // `backoffMs: 0` on exactly these two branches.
    const capped = makePool([acct('B')]);
    let n = 0;
    const cap = harness(
      async () =>
        ++n === 1
          ? errorRes(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}')
          : res(200),
      { accounts: [acct('A')], pool: capped.pool, siblingEgressAvailable: () => false, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(cap.options);
    expect(cap.prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(cap.routeDelays, 'a usage cap must not pay the transient pace').toEqual([0, 0]);

    const org = makePool([acct('B')]);
    let m = 0;
    const disallowed = harness(
      async () => (++m === 1 ? errorRes(403, '{"error":{"message":"OAuth is disallowed for this org"}}') : res(200)),
      { accounts: [acct('A')], pool: org.pool, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(disallowed.options);
    expect(disallowed.prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(disallowed.routeDelays).toEqual([0, 0]);

    // …and the POSITIVE control on the same seam: a WINDOWED 429 is transient, so it
    // does pay. Without this arm, an adapter that paced nothing at all would pass
    // both assertions above.
    const windowed = makePool([acct('B')]);
    let k = 0;
    const rate = harness(
      async () =>
        ++k === 1 ? errorRes(429, '{"error":{"message":"rate_limit_error"}}', { 'retry-after': '30' }) : res(200),
      {
        accounts: [acct('A')],
        pool: windowed.pool,
        siblingEgressAvailable: () => true,
        classifyResponse: classifier,
      },
    );
    await executeGatewayRequestKernel(rate.options);
    expect(rate.prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(rate.routeDelays).toEqual([0, 20]);
  });

  it('a plain 5xx is FORWARDED unretried — `proxy` has no 5xx retry branch, only 429/529, 403 and 401', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () => {
        n++;
        return errorRes(500, '{"error":{"message":"internal"}}');
      },
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A']);
    expect(n).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('REPLAYS the peeked body downstream byte-for-byte, so classification never truncates a forwarded error', async () => {
    // Longer than one chunk AND longer than the peek would consume in one pull,
    // so a lost-remainder bug cannot hide behind a short body.
    const payload = `{"error":{"message":"invalid_request","detail":"${'x'.repeat(200)}"}}`;
    const { pool } = makePool([]);
    const { options, forwardedBody } = harness(async () => errorRes(403, payload), {
      accounts: [acct('A')],
      pool,
      classifyResponse: classifier,
    });
    await executeGatewayRequestKernel(options);
    expect(forwardedBody()).toBe(payload);
  });

  it('carries the classification into admission.observeAttempt, where the caller fires its penalties (D-012 c1)', async () => {
    const { pool } = makePool([acct('B')]);
    let n = 0;
    const { options, observedClassifications } = harness(
      async () =>
        ++n === 1 ? errorRes(429, '{"error":{"message":"You have hit your session limit"}}') : res(200),
      { accounts: [acct('A')], pool, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(observedClassifications[0]).toEqual({ kind: 'usage-cap', resetAt: CAP_RESET_AT });
    // A 2xx is never peeked, so the success attempt classifies as nothing at all.
    expect(observedClassifications[1], 'the hot path must stay unpeeked').toBeNull();
  });

  // ── D-014: the wedge-prevention retry DEADLINE ────────────────────────────
  // `proxy` stops retrying at `retryDeadlineAt` and sheds, so the slot frees
  // before the 75s self-heal valve / 120s watchdog reclaims it. An attempt COUNT
  // is not a substitute for that wall-clock bound, so it is expressed twice: as
  // a gate on the adapter's selection hooks, and as a per-attempt TTFB cap.

  it('D-014: an exhausted retry budget blocks the sibling-egress re-attempt (gateway.ts:4213)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    // IDENTICAL to the passing bare-429 sibling-retry test above in every respect
    // — same status, same available sibling — except the budget. So the retry
    // this suppresses is one that demonstrably WOULD have happened.
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
      retryBudgetExhausted: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId), 'the 429 is shed, not retried').toEqual(['A']);
    expect(n).toBe(1);
    expect(calls, 'and the deadline must not park an account on the way out').toHaveLength(0);
  });

  it('D-014: an exhausted retry budget blocks the rotate WITHOUT consulting the pool (gateway.ts:4266)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
      retryBudgetExhausted: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A']);
    // The load-bearing half: `onExhausted` both PARKS and returns, so a budget
    // check placed AFTER it would park an account for a rotation that never
    // happens — accounts going mysteriously cold under exactly the storm the
    // deadline exists for.
    expect(calls, 'onExhausted must not be reached once the budget is spent').toHaveLength(0);
  });

  it('D-014: the TTFB cap is applied PER ATTEMPT, so a stall storm cannot multiply the slot-hold budget', async () => {
    // The regression this pins: `ttfbTimeoutMs` resolves ONCE before the attempt
    // loop, so without a per-attempt cap every one of maxAttempts gets the FULL
    // deadline — 6 × 300s where the live handler bounds the whole ladder to 60s.
    const budgetMs = 200;
    const deadlineAt = Date.now() + budgetMs;
    const { pool } = makePool([]);
    const { options, observedErrors } = harness(
      // Never resolves; the kernel's own TTFB deadline is what ends each attempt.
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      {
        accounts: [acct('A')],
        pool,
        // A TTFB timeout is a transport failure, which is sibling-eligible — so
        // the kernel really does take a second attempt to measure.
        siblingEgressAvailable: () => true,
        policy: { ttfbTimeoutMs: 60_000, ttfbCapMs: () => deadlineAt - Date.now(), maxAttempts: 2 },
      },
    );
    await expect(executeGatewayRequestKernel(options)).rejects.toThrow(/TTFB exceeded/);

    // The kernel's error names the deadline it actually armed.
    const armed = observedErrors.map((m) => Number(/TTFB exceeded (\d+)ms/.exec(m)?.[1]));
    expect(armed).toHaveLength(2);
    // Never the raw 60s deadline: the budget is what binds.
    expect(armed[0]).toBeLessThanOrEqual(budgetMs);
    // THE ASSERTION: attempt 2 gets only what the budget has LEFT. Under the
    // once-resolved behaviour both attempts arm the identical value, so this
    // comparison is what fails against it.
    expect(armed[1]).toBeLessThan(armed[0]!);
    // And the floor holds — an at-deadline retry gets a brief attempt, never a
    // 0ms abort (the `Math.max(1, …)` at gateway.ts:4144).
    expect(armed[1]).toBeGreaterThanOrEqual(1);
  });

  it('D-014: a lane that passes NO cap is unaffected — the deadline stays the resolved one', async () => {
    const { pool } = makePool([]);
    const { options, observedErrors } = harness(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      { accounts: [acct('A')], pool, policy: { ttfbTimeoutMs: 40, maxAttempts: 1 } },
    );
    await expect(executeGatewayRequestKernel(options)).rejects.toThrow(/TTFB exceeded 40ms/);
    expect(observedErrors[0]).toContain('TTFB exceeded 40ms');
  });

  it('never peeks or classifies a 2xx — the hot path pays nothing for this machinery', async () => {
    let classified = 0;
    const { pool } = makePool([]);
    const { options } = harness(async () => res(200), {
      accounts: [acct('A')],
      pool,
      classifyResponse: (input) => {
        classified++;
        return classifier(input);
      },
    });
    await executeGatewayRequestKernel(options);
    expect(classified).toBe(0);
  });
});

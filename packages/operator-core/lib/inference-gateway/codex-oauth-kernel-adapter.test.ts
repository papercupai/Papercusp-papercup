/**
 * P-004 (plan `gateway-kernel-adoption-2026-08-29`) — the Codex ChatGPT-OAuth
 * adapter driven through the REAL `executeGatewayRequestKernel` with NO gateway
 * wiring, exactly as P-002 did for the bearer lane.
 *
 * Each test names the `serveCodexOAuthProxy` behaviour it pins. The ones that
 * matter most are the SAME-ACCOUNT re-attempts (D-011): a 401 refreshes the
 * token and retries the same account, and a transport failure or 429 retries the
 * same account on a sibling egress IP before the account is parked. Neither is
 * gated on the hard pin in the live handler, and neither is counted as a
 * failover — so both are asserted here in their own right.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import type { CodexCliAccount } from './codex-cli-bridge';
import type { CodexAuth } from './codex-oauth-proxy';
import {
  createCodexOAuthKernelAdapter,
  type CodexOAuthAdapterOptions,
  type CodexOAuthChunk,
  type CodexOAuthEgressPick,
  type CodexOAuthFetchResponse,
  type CodexOAuthPreparedAttempt,
  type CodexOAuthResponseMetadata,
  type CodexOAuthRouteValue,
  type CodexOAuthStreamObservation,
} from './codex-oauth-kernel-adapter';
import {
  executeGatewayRequestKernel,
  GatewayRequestKernelError,
  type ExecuteGatewayRequestKernelOptions,
  type GatewayKernelAccountPin,
  type GatewayKernelPolicy,
} from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

const STRIP_REQUEST = new Set(['host', 'authorization', 'content-length', 'connection']);

const POLICY: GatewayKernelPolicy = {
  maxBodyBytes: 4096,
  bodyReadTimeoutMs: 2_000,
  requestCeilingMs: 10_000,
  ttfbTimeoutMs: 2_000,
  bodyIdleTimeoutMs: 2_000,
  downstreamIdleTimeoutMs: 2_000,
  maxAttempts: 3,
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
const lane = laneRegistry.openaiResponses;

const cli = (accountId: string): CodexCliAccount => ({ accountId, home: `/tmp/${accountId}` });

const authFor = (accountId: string, token: string): CodexAuth => ({
  authMode: 'chatgpt',
  accessToken: token,
  refreshToken: `refresh-${accountId}`,
  accountId,
  idToken: null,
  lastRefresh: null,
});

function sseBody(...chunks: string[]): CodexOAuthFetchResponse['body'] {
  const body = {
    cancelled: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
    async cancel() {
      body.cancelled++;
    },
  };
  return body as unknown as CodexOAuthFetchResponse['body'];
}

function upstream(
  status: number,
  headers: Record<string, string>,
  body: CodexOAuthFetchResponse['body'],
): CodexOAuthFetchResponse {
  return {
    status,
    headers: {
      forEach(callback) {
        for (const [key, value] of Object.entries(headers)) callback(value, key);
      },
    },
    body,
  };
}

/**
 * Rotation pool scripted by the test, mirroring how the live `codexCliPool`
 * parks the failing account and hands back the next. `active()` THROWS: the
 * adapter must never call it (D-010 — `proxyOpenAi` already spent this
 * request's one `active()` call above the kernel cut).
 */
function makePool(rotation: Array<{ accountId: string } | null>) {
  const exhaustedCalls: Array<{ id: string; resetAt: number }> = [];
  const parkCauses: Array<'cooldown' | 'quota' | 'auth' | undefined> = [];
  let cursor = 0;
  const pool: AccountPool & { exhaustedCalls: typeof exhaustedCalls; parkCauses: typeof parkCauses } = {
    exhaustedCalls,
    parkCauses,
    active: () => {
      throw new Error('the OAuth adapter must never advance the pool (D-010)');
    },
    select: () => null,
    onExhausted: (exhaustedId: string, resetAt: number, _keyOf, park) => {
      exhaustedCalls.push({ id: exhaustedId, resetAt });
      parkCauses.push(park?.cause);
      return (rotation[cursor++] ?? null) as ReturnType<AccountPool['onExhausted']>;
    },
  };
  return pool;
}

interface HarnessOverrides {
  accounts?: CodexCliAccount[];
  pool?: ReturnType<typeof makePool>;
  pin?: GatewayKernelAccountPin | null;
  streaming?: boolean;
  requestHeaders?: Record<string, string | string[] | undefined>;
  resolveAccessToken?: CodexOAuthAdapterOptions['resolveAccessToken'];
  refreshAccessToken?: CodexOAuthAdapterOptions['refreshAccessToken'];
  pickEgress?: CodexOAuthAdapterOptions['pickEgress'];
  siblingEgressAvailable?: CodexOAuthAdapterOptions['siblingEgressAvailable'];
  dispatcherFor?: CodexOAuthAdapterOptions['dispatcherFor'];
  rateReset?: CodexOAuthAdapterOptions['rateReset'];
  /** WI-10003306 model-refusal wiring (model / onModelRefused / onModelServed / selectAlternate). */
  extra?: Partial<CodexOAuthAdapterOptions>;
}

function harness(fetchImpl: CodexOAuthAdapterOptions['fetch'], overrides: HarnessOverrides = {}) {
  const telemetry = new GatewayRequestTelemetry();
  const written: string[] = [];
  const started: Array<{ status: number; metadata: CodexOAuthResponseMetadata; streaming: boolean }> = [];
  const prepared: CodexOAuthPreparedAttempt[] = [];
  const cooled: Array<{ key: string; ms: number }> = [];
  const accounts = overrides.accounts ?? [cli('chatgpt-a')];
  const tokens = new Map<string, string>(accounts.map((a) => [a.accountId, `${a.accountId}-tok`]));

  const resolveAccessToken =
    overrides.resolveAccessToken ??
    (async (home: string) => {
      const account = accounts.find((a) => a.home === home);
      if (!account) throw new Error(`no auth.json at ${home}`);
      return authFor(account.accountId, tokens.get(account.accountId)!);
    });
  const refreshAccessToken =
    overrides.refreshAccessToken ??
    (async (home: string, current: CodexAuth) => {
      const account = accounts.find((a) => a.home === home)!;
      return authFor(account.accountId, `${current.accessToken}-refreshed`);
    });

  const adapter = createCodexOAuthKernelAdapter({
    initialAccount: accounts[0]!,
    accounts: () => accounts,
    pool: overrides.pool,
    upstreamUrl: 'https://chatgpt.test/backend-api/codex/responses',
    method: 'POST',
    requestHeaders: overrides.requestHeaders ?? { 'content-type': 'application/json', host: 'gateway.local' },
    stripRequestHeaders: STRIP_REQUEST,
    streaming: overrides.streaming ?? true,
    tokenTimeoutMs: 1_000,
    authQuarantineMs: 15 * 60 * 1000,
    failoverBackoffMs: 5_000,
    ipCooldownMaxMs: 60_000,
    transportCooldownMs: 30_000,
    resolveAccessToken,
    refreshAccessToken,
    buildHeaders: ({ base, accessToken, accountId }) => ({
      ...base,
      authorization: `Bearer ${accessToken}`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      'accept-encoding': 'identity',
    }),
    pickEgress: overrides.pickEgress ?? ((account) => ({ entry: undefined, key: `${account.accountId}:default` })),
    siblingEgressAvailable: overrides.siblingEgressAvailable ?? (() => false),
    coolIp: (key, ms) => cooled.push({ key, ms }),
    dispatcherFor: overrides.dispatcherFor ?? (() => undefined),
    fetch: fetchImpl,
    rateReset: overrides.rateReset ?? (() => ({ resetAt: null, retryAfterMs: null })),
    ...overrides.extra,
  });

  const observedAdapter: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      const result = await adapter.prepareAttempt(context);
      prepared.push(result);
      return result;
    },
  };

  async function* body() {
    yield Buffer.from('{"model":"gpt-5.5","stream":true}');
  }

  const options: ExecuteGatewayRequestKernelOptions<
    CodexOAuthRouteValue,
    CodexOAuthPreparedAttempt,
    CodexOAuthChunk,
    CodexOAuthResponseMetadata
  > = {
    request: {
      lane,
      body: body(),
      ownerId: 'su-codex-oauth-adapter',
      correlationId: 'codex-oauth-adapter-test',
      pin: overrides.pin ?? null,
    },
    policy: POLICY,
    telemetry,
    admission: {
      async run(_context, task) { return task(); },
      observeAttempt: ({ context, error }) => {
        if (error) adapter.noteRefreshFailure(context, error);
      },
    },
    adapter: observedAdapter,
    downstream: {
      start: (response) => {
        started.push({ status: response.status, metadata: response.metadata, streaming: response.streaming });
      },
      write: (chunk) => {
        written.push(Buffer.from(chunk).toString());
      },
      end: () => undefined,
    },
    inFlight: { register: () => ({ unregister: () => undefined }) },
  };

  return { options, written, started, prepared, cooled };
}

it.each(['cancelled', 'ttfb-timeout'] as const)(
  'attributes a native AbortError from %s before cooling the OAuth egress',
  async code => {
    const controller = new AbortController();
    const failed = vi.fn();
    let entered!: () => void;
    const attemptStarted = new Promise<void>(resolve => { entered = resolve; });
    const { options, cooled } = harness(async (_url, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('fixture aborted', 'AbortError'));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    }, { pin: { accountId: 'chatgpt-a', mode: 'hard' }, extra: { onEgressFailure: failed } });
    options.request.signal = controller.signal;
    options.policy = { ...POLICY, ttfbTimeoutMs: code === 'ttfb-timeout' ? 80 : 2_000 };
    const pending = executeGatewayRequestKernel(options).catch(error => error);
    await attemptStarted;
    if (code === 'cancelled') controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(GatewayRequestKernelError);
    expect(error.code).toBe(code);
    if (code === 'cancelled') {
      expect(cooled).toEqual([]);
      expect(failed).not.toHaveBeenCalled();
    } else {
      expect(cooled).toEqual([{ key: 'chatgpt-a:default', ms: 30_000 }]);
      expect(failed).toHaveBeenCalledExactlyOnceWith('chatgpt-a', expect.anything(), undefined);
    }
  },
);

describe('codex OAuth kernel adapter — happy path and header discipline', () => {
  it('serves the resolved account, reporting it and the egress key on the metadata', async () => {
    const { options, started, written } = harness(async () => upstream(200, {}, sseBody('data: hi\n\n')));

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 1, failovers: 0 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(started[0]?.metadata.egressKey).toBe('chatgpt-a:default');
    expect(started[0]?.metadata.pinYieldedFrom).toBeNull();
    expect(written.join('')).toBe('data: hi\n\n');
  });

  it('strips hop-by-hop/downstream credentials and injects the OAuth bearer + account id', async () => {
    const { options, prepared } = harness(async () => upstream(200, {}, sseBody('ok')), {
      requestHeaders: {
        host: 'gateway.local',
        authorization: 'Bearer downstream-secret',
        'content-length': '33',
        'content-type': 'application/json',
        'x-forwarded-multi': ['a', 'b'],
      },
    });

    await executeGatewayRequestKernel(options);

    const headers = prepared[0]!.headers;
    expect(headers.host).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    expect(headers.authorization).toBe('Bearer chatgpt-a-tok');
    expect(headers['chatgpt-account-id']).toBe('chatgpt-a');
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers['x-forwarded-multi']).toBe('a, b');
  });

  it('reports the REQUEST-derived streaming flag, not the response content type', async () => {
    // An error response to a streaming request is still a streaming request.
    const { options, started } = harness(async () => upstream(200, { 'content-type': 'application/json' }, sseBody('{}')), {
      streaming: true,
    });

    await executeGatewayRequestKernel(options);

    expect(started[0]?.streaming).toBe(true);
  });
});

describe('codex OAuth kernel adapter — 401 refresh is a re-attempt, not a failover (D-011)', () => {
  it('refreshes the token and retries the SAME account without counting a failover', async () => {
    const seen: string[] = [];
    const { options, started } = harness(async (_url, init) => {
      seen.push(init.headers.authorization!);
      return seen.length === 1
        ? upstream(401, {}, sseBody('{"error":"expired"}'))
        : upstream(200, {}, sseBody('{"ok":true}'));
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    expect(seen).toEqual(['Bearer chatgpt-a-tok', 'Bearer chatgpt-a-tok-refreshed']);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
  });

  it('passes the selected egress dispatcher into the OAuth refresh callback', async () => {
    const dispatcher = { egress: 'chatgpt-a:ip1' };
    const refreshDispatchers: unknown[] = [];
    const { options } = harness(
      async () =>
        refreshDispatchers.length === 0
          ? upstream(401, {}, sseBody('{"error":"expired"}'))
          : upstream(200, {}, sseBody('{"ok":true}')),
      {
        pickEgress: () => ({ entry: 'egress-entry', key: 'chatgpt-a:ip1' }),
        dispatcherFor: async (_account, entry) => {
          expect(entry).toBe('egress-entry');
          return dispatcher;
        },
        refreshAccessToken: async (_home, current, selectedDispatcher) => {
          refreshDispatchers.push(selectedDispatcher);
          return authFor('chatgpt-a', `${current.accessToken}-refreshed`);
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    expect(refreshDispatchers).toEqual([dispatcher]);
  });

  it('refreshes even when the account is HARD-pinned — a re-auth does not leave the account', async () => {
    // The live 401 path is not gated on `routing.hardPin`, unlike `rotateCli`.
    const seen: string[] = [];
    const { options } = harness(
      async (_url, init) => {
        seen.push(init.headers.authorization!);
        return seen.length === 1 ? upstream(401, {}, sseBody('nope')) : upstream(200, {}, sseBody('ok'));
      },
      { pin: { accountId: 'chatgpt-a', mode: 'hard' } },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    expect(seen[1]).toBe('Bearer chatgpt-a-tok-refreshed');
  });

  it('forwards a persistent 401 after exactly ONE refresh instead of rotating or looping', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seen: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        seen.push(init.headers.authorization!);
        return upstream(401, {}, sseBody('{"error":"still bad"}'));
      },
      { accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(401);
    expect(seen).toHaveLength(2);
    // A 401 is recoverable only by refresh — it must not park the account.
    expect(pool.exhaustedCalls).toEqual([]);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
  });

  it('WI-10004561: redacts the presented OAuth access token from the forwarded 401 body', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    // The upstream echoes the BARE access token it was sent on each attempt; the forwarded
    // body is the post-refresh attempt's, so its token is the refreshed one.
    const { options, started, written } = harness(
      async (_url, init) => {
        const presented = String(init.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        return upstream(401, {}, sseBody(`{"error":"token ${presented} rejected"}`));
      },
      { accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(401);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    const relayed = written.join('');
    expect(relayed).toContain('rejected');
    expect(relayed).not.toContain('chatgpt-a-tok');
  });

  it('quarantines an invalidated refresh token and fails over without retrying a sibling egress', async () => {
    const now = 1_800_000_000_000;
    const quarantineMs = 15 * 60 * 1000;
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seenAccounts: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        const accountId = init.headers['chatgpt-account-id']!;
        seenAccounts.push(accountId);
        return accountId === 'chatgpt-a'
          ? upstream(401, {}, sseBody('expired'))
          : upstream(200, {}, sseBody('ok'));
      },
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        siblingEgressAvailable: () => true,
        refreshAccessToken: async () => {
          throw new Error('codex-oauth-proxy: token refresh failed 401; code=refresh_token_invalidated');
        },
        extra: { authQuarantineMs: quarantineMs, now: () => now },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 3, failovers: 1 });
    expect(seenAccounts).toEqual(['chatgpt-a', 'chatgpt-b']);
    expect(pool.exhaustedCalls).toEqual([{ id: 'chatgpt-a', resetAt: now + quarantineMs }]);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
  });

  it('does not park or rotate an invalid refresh credential under a hard account pin', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seenAccounts: string[] = [];
    const { options } = harness(
      async (_url, init) => {
        seenAccounts.push(init.headers['chatgpt-account-id']!);
        return upstream(401, {}, sseBody('expired'));
      },
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        pin: { accountId: 'chatgpt-a', mode: 'hard' },
        siblingEgressAvailable: () => true,
        refreshAccessToken: async () => {
          throw new Error('codex-oauth-proxy: token refresh failed 401; code=refresh_token_invalidated');
        },
      },
    );

    await expect(executeGatewayRequestKernel(options)).rejects.toMatchObject({ status: 502 });
    expect(seenAccounts).toEqual(['chatgpt-a']);
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('rotates when the REFRESH itself fails, matching the live handler', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seen: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        seen.push(init.headers['chatgpt-account-id']!);
        return seen.length === 1 ? upstream(401, {}, sseBody('nope')) : upstream(200, {}, sseBody('ok'));
      },
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        refreshAccessToken: async () => {
          throw new Error('refresh grant rejected');
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
  });
});

describe('codex OAuth kernel adapter — sibling-egress re-attempt precedes rotation (D-011)', () => {
  it('retries the SAME account on a sibling IP after a transport failure, without a failover', async () => {
    const keys = ['chatgpt-a:ip1', 'chatgpt-a:ip2'];
    let pick = 0;
    const attempts: string[] = [];
    const { options, cooled, started } = harness(
      async () => {
        attempts.push('call');
        if (attempts.length === 1) throw new Error('proxy unreachable');
        return upstream(200, {}, sseBody('ok'));
      },
      {
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pickEgress: () => ({ entry: undefined, key: keys[Math.min(pick++, keys.length - 1)]! }),
        siblingEgressAvailable: () => true,
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    // The failed IP is cooled, and the retry stayed on the same account.
    expect(cooled).toEqual([{ key: 'chatgpt-a:ip1', ms: 30_000 }]);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(started[0]?.metadata.egressKey).toBe('chatgpt-a:ip2');
  });

  it('preserves undici fetch diagnostics and the original cause on transport failure', async () => {
    const fetchFailure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'read ECONNRESET' },
    });
    const { options } = harness(async () => { throw fetchFailure; });
    options.policy = { ...options.policy, maxAttempts: 1 };
    const error = await executeGatewayRequestKernel(options).then(
      () => { throw new Error('expected upstream failure'); },
      (reason: unknown) => reason as { code: string; message: string; cause?: unknown },
    );

    expect(error).toMatchObject({
      code: 'upstream-error',
      message: 'inference-gateway: codex OAuth upstream failed: fetch failed (ECONNRESET: read ECONNRESET)',
    });
    expect(error.cause).toBe(fetchFailure);
  });

  it('rotates the account when no sibling IP is available', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seen: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        seen.push(init.headers['chatgpt-account-id']!);
        if (seen.length === 1) throw new Error('proxy unreachable');
        return upstream(200, {}, sseBody('ok'));
      },
      { accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool, siblingEgressAvailable: () => false },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
    expect(pool.exhaustedCalls[0]?.id).toBe('chatgpt-a');
  });

  it('WI-10007199: reports the transport error and every HTTP response, so reachability is separable from capacity', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const dnsFailure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND chatgpt.com' },
    });
    const failed = vi.fn();
    const responded = vi.fn();
    let calls = 0;
    const { options } = harness(
      async () => {
        calls += 1;
        if (calls === 1) throw dnsFailure;
        return upstream(429, {}, sseBody('walled'));
      },
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        siblingEgressAvailable: () => false,
        extra: { onEgressFailure: failed, onUpstreamResponse: responded },
      },
    );
    options.policy = { ...options.policy, maxAttempts: 2 };

    await executeGatewayRequestKernel(options).catch(() => undefined);

    // The failure carries the fetch rejection itself (the gateway classifies it: DNS here).
    expect(failed).toHaveBeenCalledWith('chatgpt-a', dnsFailure, undefined);
    // A 429 is still an HTTP response: the network path works, whatever the account's capacity.
    expect(responded).toHaveBeenCalledWith('chatgpt-b', 429);
    expect(responded).not.toHaveBeenCalledWith('chatgpt-a', expect.anything());
  });

  it('cools the throttled IP from the rate-reset header on a 429 before re-attempting', async () => {
    let pick = 0;
    const keys = ['chatgpt-a:ip1', 'chatgpt-a:ip2'];
    const calls: number[] = [];
    const { options, cooled } = harness(
      async () => {
        calls.push(1);
        return calls.length === 1
          ? upstream(429, { 'retry-after': '12' }, sseBody('{"error":"rate"}'))
          : upstream(200, {}, sseBody('ok'));
      },
      {
        pickEgress: () => ({ entry: undefined, key: keys[Math.min(pick++, keys.length - 1)]! }),
        siblingEgressAvailable: () => true,
        rateReset: () => ({ resetAt: null, retryAfterMs: 12_000 }),
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 0 });
    expect(cooled).toEqual([{ key: 'chatgpt-a:ip1', ms: 12_000 }]);
  });

  it('caps a 429 IP cooldown at the configured maximum', async () => {
    let pick = 0;
    const keys = ['chatgpt-a:ip1', 'chatgpt-a:ip2'];
    const calls: number[] = [];
    const { options, cooled } = harness(
      async () => {
        calls.push(1);
        return calls.length === 1 ? upstream(429, {}, sseBody('rate')) : upstream(200, {}, sseBody('ok'));
      },
      {
        pickEgress: () => ({ entry: undefined, key: keys[Math.min(pick++, keys.length - 1)]! }),
        siblingEgressAvailable: () => true,
        rateReset: () => ({ resetAt: null, retryAfterMs: 999_999_999 }),
      },
    );

    await executeGatewayRequestKernel(options);

    expect(cooled).toEqual([{ key: 'chatgpt-a:ip1', ms: 60_000 }]);
  });
});

describe('codex OAuth kernel adapter — rotation, credentials, and pool discipline', () => {
  it('NEVER advances the pool for initial selection (D-010)', async () => {
    // `makePool().active()` throws. The adapter takes the account the caller
    // already resolved, so a double-advance is structurally impossible.
    const { options, started } = harness(async () => upstream(200, {}, sseBody('ok')), {
      pool: makePool([]),
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(200);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
  });

  it('rotates on a token-resolve failure and reports the pin yield', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const { options, started } = harness(async () => upstream(200, {}, sseBody('ok')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool,
      pin: { accountId: 'chatgpt-a', mode: 'soft' },
      resolveAccessToken: async (home: string) => {
        if (home === '/tmp/chatgpt-a') throw new Error('no usable auth.json');
        return authFor('chatgpt-b', 'chatgpt-b-tok');
      },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
    expect(started[0]?.metadata.pinYieldedFrom).toBe('chatgpt-a');
    expect(pool.parkCauses).toEqual(['auth']);
  });

  it.each([
    { status: 503, transient: true, cause: 'cooldown' },
    { status: 429, transient: true, cause: 'cooldown' },
    { status: 429, transient: false, cause: 'quota' },
  ])('records $cause for a $status failover (transient: $transient)', async ({ status, transient, cause }) => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const h = harness(async (_url, init) => init.diagnosticAccountId === 'chatgpt-a'
      ? upstream(status, {}, sseBody('temporarily unavailable'))
      : upstream(200, {}, sseBody('ok')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool,
      rateReset: () => ({ resetAt: Date.now() + 15_000, retryAfterMs: 15_000, transient }),
    });
    expect((await executeGatewayRequestKernel(h.options)).status).toBe(200);
    expect(pool.parkCauses).toEqual([cause]);
  });

  // WI-6554700010029423: a burst 429's retry-after (measured 42-570s on gpt-6.1-sol) is not enforced
  // upstream, so parking the account for all of it idled serviceable accounts. The park is bounded
  // to the failover backoff (5s in this harness); a quota wall keeps its real reset.
  it.each([
    { transient: true, retryAfterMs: 570_000, maxParkMs: 5_000 },
    { transient: undefined, retryAfterMs: 570_000, maxParkMs: 5_000 },
    { transient: false, retryAfterMs: 3_600_000, maxParkMs: 3_600_000 },
  ])('bounds the failover park of a 429 (transient: $transient) to $maxParkMs ms', async ({ transient, retryAfterMs, maxParkMs }) => {
    const t0 = 1_800_000_000_000;
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const h = harness(async (_url, init) => init.diagnosticAccountId === 'chatgpt-a'
      ? upstream(429, { 'retry-after': String(retryAfterMs / 1000) }, sseBody('{"error":"rate"}'))
      : upstream(200, {}, sseBody('ok')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool,
      rateReset: () => ({ resetAt: t0 + retryAfterMs, retryAfterMs, transient }),
      extra: { now: () => t0 },
    });
    expect((await executeGatewayRequestKernel(h.options)).status).toBe(200);
    expect(pool.exhaustedCalls).toEqual([{ id: 'chatgpt-a', resetAt: t0 + maxParkMs }]);
  });

  it('surfaces a 503 when no account can produce a token', async () => {
    const { options } = harness(async () => upstream(200, {}, sseBody('ok')), {
      resolveAccessToken: async () => {
        throw new Error('no usable auth.json');
      },
    });

    await expect(executeGatewayRequestKernel(options)).rejects.toMatchObject({
      code: 'upstream-error',
      status: 503,
    });
  });

  it('does not rotate back to an account it already tried', async () => {
    // The kernel throws `route-cycle` on a repeated KEY, but this adapter's keys
    // carry a sequence number, so the account-level guard must be explicit.
    const pool = makePool([{ accountId: 'chatgpt-b' }, { accountId: 'chatgpt-a' }]);
    const { options } = harness(async () => upstream(500, {}, sseBody('boom')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool,
    });

    const result = await executeGatewayRequestKernel(options);

    // a -> b, then the pool offers `a` again; the adapter declines and the 500 is
    // forwarded rather than cycling.
    expect(result).toMatchObject({ status: 500, failovers: 1 });
  });

  it('forwards a hard-pinned 429 rather than rotating off the pinned account', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const { options, started } = harness(async () => upstream(429, {}, sseBody('{"error":"rate"}')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool,
      pin: { accountId: 'chatgpt-a', mode: 'hard' },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(429);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(pool.exhaustedCalls).toEqual([]);
  });
});

/**
 * WI-10003306 — a ChatGPT account that refuses the request MODEL. The live incident: two
 * subscriptions answered every premium model with this 400 while four siblings served it, the
 * gateway forwarded the 400 as final, and sessions failed "intermittently, on all models".
 */
describe('codex OAuth kernel adapter — model refusal fails over without parking (WI-10003306)', () => {
  const REFUSAL = `{"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}`;
  const byAccount =
    (responses: Record<string, () => CodexOAuthFetchResponse>): CodexOAuthAdapterOptions['fetch'] =>
    async (_url, init) =>
      responses[init.diagnosticAccountId ?? '']!();

  it('moves the SAME request to a non-refusing account, records the refusal, and never parks the refuser', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const refused: Array<{ accountId: string; model: string; status: number }> = [];
    const served: Array<{ accountId: string; model: string }> = [];
    const excludes: string[][] = [];
    const { options, started, written } = harness(
      byAccount({
        'chatgpt-a': () => upstream(400, { 'content-type': 'application/json' }, sseBody(REFUSAL)),
        'chatgpt-b': () => upstream(200, {}, sseBody('data: ok\n\n')),
      }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        extra: {
          model: 'gpt-6-sol',
          onModelRefused: ({ accountId, model, status }) => refused.push({ accountId, model, status }),
          onModelServed: (info) => served.push(info),
          selectAlternate: (exclude) => {
            excludes.push([...exclude]);
            return { accountId: 'chatgpt-b' };
          },
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started).toHaveLength(1);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
    expect(written.join('')).toBe('data: ok\n\n');
    expect(refused).toEqual([{ accountId: 'chatgpt-a', model: 'gpt-6-sol', status: 400 }]);
    expect(served).toEqual([{ accountId: 'chatgpt-b', model: 'gpt-6-sol' }]);
    expect(excludes).toEqual([['chatgpt-a']]);
    // A model refusal says nothing about capacity for OTHER models: the refuser is not parked.
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('forwards the truthful 400 (body intact) when no account can serve the model', async () => {
    const refused: string[] = [];
    const { options, started, written } = harness(
      byAccount({ 'chatgpt-a': () => upstream(400, {}, sseBody(REFUSAL)) }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        extra: {
          model: 'gpt-6-sol',
          onModelRefused: ({ accountId }) => refused.push(accountId),
          selectAlternate: () => null,
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(400);
    expect(started[0]?.metadata).toMatchObject({ accountId: 'chatgpt-a', modelRefusal: expect.stringContaining('gpt-6-sol') });
    expect(written.join('')).toBe(REFUSAL);
    expect(refused).toEqual(['chatgpt-a']);
  });

  it('keeps a hard pin strict: the refusal is recorded and forwarded, never rotated', async () => {
    const selectAlternate = vi.fn(() => ({ accountId: 'chatgpt-b' }));
    const refused: string[] = [];
    const { options, started } = harness(
      byAccount({
        'chatgpt-a': () => upstream(400, {}, sseBody(REFUSAL)),
        'chatgpt-b': () => upstream(200, {}, sseBody('ok')),
      }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        pin: { accountId: 'chatgpt-a', mode: 'hard' },
        extra: { model: 'gpt-6-sol', onModelRefused: ({ accountId }) => refused.push(accountId), selectAlternate },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(400);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(selectAlternate).not.toHaveBeenCalled();
    expect(refused).toEqual(['chatgpt-a']);
  });

  it('does not treat an ordinary 400 (a malformed request) as a model refusal', async () => {
    const selectAlternate = vi.fn(() => ({ accountId: 'chatgpt-b' }));
    const onModelRefused = vi.fn();
    const { options, written } = harness(
      byAccount({ 'chatgpt-a': () => upstream(400, {}, sseBody('{"detail":"Input must be a list"}')) }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        extra: { model: 'gpt-6-sol', onModelRefused, selectAlternate },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 400, failovers: 0 });
    expect(written.join('')).toBe('{"detail":"Input must be a list"}');
    expect(onModelRefused).not.toHaveBeenCalled();
    expect(selectAlternate).not.toHaveBeenCalled();
  });

  it('without a request model keeps the legacy behaviour: the refusal is forwarded as final', async () => {
    const selectAlternate = vi.fn(() => ({ accountId: 'chatgpt-b' }));
    const { options } = harness(byAccount({ 'chatgpt-a': () => upstream(400, {}, sseBody(REFUSAL)) }), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool: makePool([{ accountId: 'chatgpt-b' }]),
      extra: { selectAlternate },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(400);
    expect(selectAlternate).not.toHaveBeenCalled();
  });
});

describe('Codex OAuth quota errors inside successful HTTP streams', () => {
  it('rotates an account-wide usage wall before spending the retry budget on sibling IPs', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const h = harness(async (_url, init) => init.diagnosticAccountId === 'chatgpt-a'
      ? upstream(429, {}, sseBody('usage exhausted'))
      : upstream(200, {}, sseBody('healthy-account-success')), {
      accounts, pool, siblingEgressAvailable: () => true,
      rateReset: () => ({ resetAt: Date.now() + 3600_000, retryAfterMs: null, transient: false }),
    });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a', 'chatgpt-b']);
    expect(h.started[0]!.status).toBe(200);
    expect(h.written.join('')).toBe('healthy-account-success');
    expect(h.cooled).toEqual([]);
  });

  const quota = { code: 'usage_limit_reached', message: "You've hit your usage limit", resets_at: 2_000_000_000 };
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const failed = (kind: 'error' | 'response.failed') => kind === 'error'
    ? { type: kind, error: quota }
    : { type: kind, response: { id: 'failed-a', error: quota } };

  it.each([undefined, ''])('inspects streaming quota frames when upstream Content-Type is %s', async (contentType) => {
    // WI-10007298: real OAuth SSE can arrive without a Content-Type header.
    // Header absence must not bypass the existing pre-commit quota failover.
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const success = frame({ type: 'response.completed', response: { id: 'healthy', status: 'completed' } });
    const h = harness(async (_url, init) => init.diagnosticAccountId === 'chatgpt-a'
      ? upstream(200, contentType === undefined ? {} : { 'content-type': contentType }, sseBody(frame(failed('response.failed'))))
      : upstream(200, { 'content-type': 'text/event-stream' }, sseBody(success)), { accounts, pool });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a', 'chatgpt-b']);
    expect(h.written.join('')).toBe(success);
    expect(pool.exhaustedCalls.map((p) => p.id)).toEqual(['chatgpt-a']);
  });

  it('preserves a healthy headerless SSE stream without interpreting quota-looking model text', async () => {
    const wire = frame({ type: 'response.output_text.delta', delta: "You've hit your usage limit" })
      + frame({ type: 'response.completed', response: { id: 'healthy', status: 'completed' } });
    const h = harness(async () => upstream(200, {}, sseBody(wire)));
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared).toHaveLength(1);
    expect(h.written.join('')).toBe(wire);
  });

  it.each(['completed', 'incomplete', 'iterator-error', 'wrong-mime', 'opaque', 'empty'] as const)(
    'retains bounded %s protocol evidence without changing bytes or mistaking HTTP 200 for completion', async mode => {
      const observed: CodexOAuthStreamObservation[] = [];
      const privateText = 'PRIVATE_OUTPUT_MUST_NOT_BE_RETAINED';
      const created = frame({ type: 'response.created', response: { id: 'resp_fixture' } });
      const delta = frame({ type: 'response.output_text.delta', delta: privateText });
      const complete = frame({ type: 'response.completed', response: { id: 'resp_fixture' } });
      const wire = mode === 'empty' ? '' : mode === 'wrong-mime' ? JSON.stringify({ content: privateText })
        : mode === 'opaque' ? frame({ padding: privateText.repeat(4_000), type: 'response.completed' })
        : created + delta + (mode === 'completed' ? complete : '');
      const source = sseBody(wire)!;
      const originalError = new Error(privateText);
      const body = mode === 'iterator-error' ? {
        async *[Symbol.asyncIterator]() { yield Buffer.from(wire); throw originalError; },
        cancel: vi.fn(),
      } : source;
      const h = harness(async () => upstream(200, {
        'content-type': mode === 'wrong-mime' ? 'application/json; private=' + privateText : 'text/event-stream',
      }, body), { extra: { onStreamObservation: x => observed.push(x) } });
      const result = await executeGatewayRequestKernel(h.options).catch(e => e);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ requestedStream: true, upstreamStatus: 200,
        bytesRead: Buffer.byteLength(wire), termination: mode === 'iterator-error' ? 'threw' : 'done' });
      expect(JSON.stringify(observed)).not.toContain(privateText);
      if (mode === 'wrong-mime') {
        expect(observed[0]).toMatchObject({ contentType: 'json', inspected: false,
          sawResponseEvent: null, sawTerminal: null });
      } else {
        expect(observed[0]).toMatchObject({ inspected: true,
          sawTerminal: mode === 'completed', opaqueLargeFrame: mode === 'opaque' });
      }
      if (mode === 'incomplete' || mode === 'iterator-error') expect(result).toBeInstanceOf(GatewayRequestKernelError);
      else expect(result.status).toBe(200);
      expect(h.written.join('')).toBe(wire);
    },
  );

  it('emits cancellation once and preserves original body cancellation without diagnostic exceptions escaping', async () => {
    const observed: CodexOAuthStreamObservation[] = [];
    const source = sseBody(frame({ type: 'response.output_text.delta', delta: 'visible' }))!;
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, source), {
      extra: { onStreamObservation: x => { observed.push(x); throw new Error('private diagnostic failure'); } },
    });
    h.options.downstream.write = () => { throw new Error('downstream rejected output'); };
    await expect(executeGatewayRequestKernel(h.options)).rejects.toBeInstanceOf(GatewayRequestKernelError);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ termination: 'cancelled', sawTerminal: false });
    expect((source as unknown as { cancelled: number }).cancelled).toBe(1);
  });

  it.each(['flat', 'nested', 'response'] as const)('distinguishes the %s error envelope without retaining its content', async envelope => {
    const observed: CodexOAuthStreamObservation[] = [];
    const privateCode = 'PRIVATE_ERROR_CODE';
    const error = { code: privateCode, message: 'PRIVATE_MESSAGE context length exceeded' };
    const event = envelope === 'flat' ? { type: 'error', ...error } : envelope === 'nested'
      ? { type: 'error', error } : { type: 'response.failed', response: { error } };
    const wire = frame(event);
    const h = harness(async () => upstream(200, {}, sseBody(wire)), {
      extra: { onStreamObservation: x => observed.push(x) },
    });
    await executeGatewayRequestKernel(h.options);
    if (envelope === 'response') expect(h.written.join('')).toBe(wire);
    else expect(JSON.parse(h.written.join('')).error.code).toBe(privateCode);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ errorEnvelope: envelope, errorCode: 'other',
      errorCodeSha256: createHash('sha256').update(privateCode).digest('hex'), errorMessageClass: 'context-limit' });
    expect(JSON.stringify(observed)).not.toMatch(/PRIVATE_/);
  });

  it('rejects EOF after Responses preludes before committing a false successful head', async () => {
    const h = harness(async () => upstream(200, {}, sseBody(frame({ type: 'response.created' }))));
    await expect(executeGatewayRequestKernel(h.options)).rejects.toMatchObject({
      code: 'upstream-error', status: 502,
      message: expect.stringContaining('EOF before a Responses terminal event'),
    });
    expect(h.started).toEqual([]);
  });

  it('rejects incomplete EOF after visible output without replaying that output on another account', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const wire = frame({ type: 'response.created', response: { id: 'resp_incomplete' } })
      + frame({ type: 'response.output_text.delta', delta: 'already visible' });
    const h = harness(async () => upstream(200, {}, sseBody(wire)), { accounts, pool });
    await expect(executeGatewayRequestKernel(h.options)).rejects.toMatchObject({
      code: 'upstream-error', status: 502,
      cause: { protocol: 'openai-responses', responseId: 'resp_incomplete', lastEventType: 'response.output_text.delta' },
    });
    expect(h.prepared).toHaveLength(1);
    expect(h.written.join('')).toBe(wire);
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('does not invent a response id from model text or malformed provider metadata', async () => {
    const wire = frame({ type: 'response.created', response: { id: 123 } })
      + frame({ type: 'response.output_text.delta', delta: '{"response":{"id":"model-text-not-a-provider-id"}}' });
    const h = harness(async () => upstream(200, {}, sseBody(wire)));
    await expect(executeGatewayRequestKernel(h.options)).rejects.toMatchObject({
      cause: { protocol: 'openai-responses', responseId: null },
    });
  });

  it.each(['response.failed', 'response.incomplete', 'error'])('preserves an explicit %s terminal instead of misclassifying it as bare EOF', async (type) => {
    const wire = frame({ type, error: { code: 'context_length_exceeded', message: 'original failure' },
      response: { status: type === 'response.incomplete' ? 'incomplete' : 'failed', error: { code: 'context_length_exceeded' } } });
    const h = harness(async () => upstream(200, {}, sseBody(wire)));
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared).toHaveLength(1);
    if (type === 'error') {
      expect(h.started[0]?.status).toBe(400);
      expect(JSON.parse(h.written.join('')).error).toMatchObject({ code: 'context_length_exceeded' });
    } else expect(h.written.join('')).toBe(wire);
  });

  it.each(['flat', 'nested'] as const)('surfaces a %s context error before output without rotating or retiring accounts', async envelope => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const error = { code: 'context_length_exceeded', message: 'context window exceeded' };
    const wire = frame(envelope === 'flat' ? { type: 'error', ...error } : { type: 'error', error });
    const h = harness(async () => upstream(200, {}, sseBody(wire)), { accounts, pool });
    const result = await executeGatewayRequestKernel(h.options);
    expect(result.status).toBe(400);
    expect(h.prepared).toHaveLength(1);
    expect(JSON.parse(h.written.join('')).error).toMatchObject(error);
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('preserves a late context error in the failure cause, scrubbing credentials and never replaying output', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const output = frame({ type: 'response.output_text.delta', delta: 'visible once' });
    const wire = output + frame({ type: 'error', error: { code: 'context_length_exceeded',
      message: 'context window exceeded; chatgpt-a-tok' } });
    const h = harness(async () => upstream(200, {}, sseBody(output, wire.slice(output.length))), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool,
    });
    const error = await executeGatewayRequestKernel(h.options).catch(e => e);
    expect(error).toMatchObject({ code: 'upstream-error', status: 400, retryable: false,
      cause: { protocol: 'openai-responses', error: { code: 'context_length_exceeded' } } });
    expect(JSON.stringify(error.cause)).not.toContain('chatgpt-a-tok');
    expect(h.written.join('')).toBe(output);
    expect(h.written.join('')).not.toContain('chatgpt-a-tok');
    expect(h.prepared).toHaveLength(1);
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('does not accept an unterminated final SSE frame as a Responses completion', async () => {
    const wire = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'truncated' } })}`;
    const h = harness(async () => upstream(200, {}, sseBody(wire)));
    await expect(executeGatewayRequestKernel(h.options)).rejects.toMatchObject({ code: 'upstream-error', status: 502 });
  });

  it.each([
    { type: 'error', code: 'server_error' },
    { type: 'response.failed', code: 'server_error' },
    { type: 'error', code: 'server_overloaded' },
    { type: 'response.failed', code: 'server_overloaded' },
  ] as const)('fails over a $type $code overload inside HTTP 200 before exposing a failed response', async ({ type, code }) => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const error = { code, message: code === 'server_overloaded'
      ? 'Selected model is at capacity. Please try a different model.'
      : 'We are currently experiencing high demand' };
    const failure = frame(type === 'error' ? { type, error } : { type, response: { error } });
    const success = frame({ type: 'response.completed', response: { id: 'healthy', status: 'completed' } });
    const h = harness(async (_url, init) => upstream(200, { 'content-type': 'text/event-stream' },
      sseBody(init.diagnosticAccountId === 'chatgpt-a' ? failure : success)), { accounts, pool });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a', 'chatgpt-b']);
    expect(h.started.map((s) => s.metadata.accountId)).toEqual(['chatgpt-b']);
    expect(h.written.join('')).toBe(success);
    expect(pool.exhaustedCalls.map((p) => p.id)).toEqual(['chatgpt-a']);
  });

  it('benches a late overload briefly without replaying visible output or adopting a quota reset', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const output = frame({ type: 'response.output_text.delta', delta: 'already visible' });
    const failure = frame({ type: 'response.failed', response: {
      error: { code: 'server_error', message: 'high demand', resets_at: 2_000_000_000 },
    } });
    const now = Date.now();
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, sseBody(output, failure)),
      { accounts, pool, extra: { now: () => now } });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared).toHaveLength(1);
    expect(h.written.join('')).toBe(output + failure);
    expect(pool.exhaustedCalls).toEqual([{ id: 'chatgpt-a', resetAt: now + 5000 }]);
    expect(pool.parkCauses).toEqual(['cooldown']);
  });

  it('keeps a hard-pinned account on an overload and returns the truthful failure', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const failure = frame({ type: 'error', error: { code: 'server_error', message: 'high demand' } });
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, sseBody(failure)),
      { accounts, pool, pin: { accountId: 'chatgpt-a', mode: 'hard' } });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared).toHaveLength(1);
    expect(h.started[0]?.status).toBe(503);
    expect(h.written.join('')).toContain('high demand');
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('preserves an oversized valid terminal frame split across chunks without widening the quota buffer', async () => {
    const wire = frame({ type: 'response.output_text.delta', delta: 'start' })
      + frame({ type: 'response.completed', response: { id: 'large', output: ['x'.repeat(100_000)] } });
    const h = harness(async () => upstream(200, {}, sseBody(wire.slice(0, 75_000), wire.slice(75_000))));
    await executeGatewayRequestKernel(h.options);
    expect(h.written.join('')).toBe(wire);
    expect(h.prepared).toHaveLength(1);
  });

  it('still detects EOF after an oversized output delta rather than inventing a completion', async () => {
    const wire = frame({ type: 'response.output_text.delta', delta: 'x'.repeat(100_000) });
    const h = harness(async () => upstream(200, {}, sseBody(wire.slice(0, 75_000), wire.slice(75_000))));
    await expect(executeGatewayRequestKernel(h.options)).rejects.toMatchObject({ code: 'upstream-error', status: 502 });
    expect(h.prepared).toHaveLength(1);
    expect(h.written.join('')).toBe(wire);
  });

  it('calibrates quota and non-quota fixtures against native Codex response.failed classifications', async () => {
    // Pinned native protocol controls, rather than assuming every error means quota:
    // https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/codex-api/src/sse/responses.rs
    // Native quota_exceeded_error_is_fatal and context_window_error_is_fatal use this envelope.
    for (const code of ['insufficient_quota', 'context_length_exceeded']) {
      const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
      const pool = makePool([{ accountId: 'chatgpt-b' }]);
      const errorWire = frame({ type: 'response.failed', response: {
        id: 'native-protocol-control', status: 'failed', error: { code, message: code },
      } });
      const h = harness(async (_url, init) => upstream(200, { 'content-type': 'text/event-stream' },
        sseBody(init.diagnosticAccountId === 'chatgpt-a' ? errorWire : 'healthy-account-success')),
      { accounts, pool });
      await executeGatewayRequestKernel(h.options);
      expect(h.prepared.map((p) => p.accountId)).toEqual(code === 'insufficient_quota'
        ? ['chatgpt-a', 'chatgpt-b'] : ['chatgpt-a']);
      expect(h.written.join('')).toBe(code === 'insufficient_quota' ? 'healthy-account-success' : errorWire);
      expect(pool.exhaustedCalls.map((p) => p.id)).toEqual(code === 'insufficient_quota' ? ['chatgpt-a'] : []);
    }
  });

  it('preserves sibling-IP recovery for a transient rate_limit_exceeded SSE response', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    let calls = 0;
    const h = harness(async () => ++calls === 1
      ? upstream(200, { 'content-type': 'text/event-stream', 'retry-after': '1' }, sseBody(frame({
          type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'retry in 1 second' } },
        })))
      : upstream(200, {}, sseBody('same-account-success')), {
      accounts, pool, siblingEgressAvailable: () => true,
      rateReset: () => ({ resetAt: Date.now() + 1000, retryAfterMs: 1000, transient: true }),
    });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a', 'chatgpt-a']);
    expect(h.written.join('')).toBe('same-account-success');
    expect(pool.exhaustedCalls).toEqual([]);
    expect(h.cooled).toHaveLength(1);
  });

  it('looks past harmless response preludes before quota exhaustion without relaying the failed response', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const h = harness(async (_url, init) => init.diagnosticAccountId === 'chatgpt-a'
      ? upstream(200, { 'content-type': 'Text/Event-Stream' }, sseBody(
          frame({ type: 'response.created' }), frame({ type: 'response.in_progress' }), frame(failed('response.failed'))))
      : upstream(200, {}, sseBody('healthy-account-success')), { accounts, pool });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a', 'chatgpt-b']);
    expect(h.written.join('')).toBe('healthy-account-success');
  });

  it('replays a pending read exactly once when the prelude lookahead expires', async () => {
    const prelude = frame({ type: 'response.created' });
    const output = frame({ type: 'response.output_text.delta', delta: 'slow first token' })
      + frame({ type: 'response.completed', response: { id: 'completed' } });
    const body = { async *[Symbol.asyncIterator]() {
      yield Buffer.from(prelude);
      await new Promise((resolve) => setTimeout(resolve, 250));
      yield Buffer.from(output);
    } };
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, body));
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared).toHaveLength(1);
    expect(h.written.join('')).toBe(prelude + output);
  });

  it.each(['error', 'response.failed'] as const)('fails over a %s quota event before committing any failed response', async (kind) => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const wire = frame({ type: 'response.completed', response: { id: 'ok-b', output: [] } });
    const h = harness(async (_url, init) => init.diagnosticAccountId === 'chatgpt-a'
      ? upstream(200, { 'content-type': 'text/event-stream' }, sseBody(frame(failed(kind)).slice(0, 17), frame(failed(kind)).slice(17)))
      : upstream(200, { 'content-type': 'text/event-stream' }, sseBody(wire)), { accounts, pool });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a', 'chatgpt-b']);
    expect(h.started.map((s) => s.metadata.accountId)).toEqual(['chatgpt-b']);
    expect(h.written.join('')).toBe(wire);
    expect(pool.exhaustedCalls.map((p) => p.id)).toEqual(['chatgpt-a']);
  });

  it('does not leave an explicit hard pin when its stream reports quota exhaustion', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, sseBody(frame(failed('error')))),
      { accounts, pool, pin: { accountId: 'chatgpt-a', mode: 'hard' } });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a']);
    expect(h.started[0]!.status).toBe(429);
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('cools only the egress for a late transient throttle without replaying output or retiring the account', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const output = frame({ type: 'response.output_text.delta', delta: 'already visible' });
    const throttle = frame({ type: 'response.failed', response: {
      error: { code: 'rate_limit_exceeded', message: 'retry in 1 second' },
    } });
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, sseBody(output, throttle)), {
      accounts, pool,
      rateReset: () => ({ resetAt: Date.now() + 1000, retryAfterMs: 1000, transient: true }),
    });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared.map((p) => p.accountId)).toEqual(['chatgpt-a']);
    expect(h.written.join('')).toBe(output + throttle);
    expect(pool.exhaustedCalls).toEqual([]);
    expect(h.cooled).toEqual([{ key: 'chatgpt-a:default', ms: 1000 }]);
  });

  it('preserves non-quota errors and never replays already-visible output', async () => {
    const accounts = [cli('chatgpt-a'), cli('chatgpt-b')];
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const output = frame({ type: 'response.output_text.delta', delta: "You've hit your usage limit" });
    const wire = output + frame(failed('error'));
    const h = harness(async () => upstream(200, { 'content-type': 'text/event-stream' }, sseBody(output, frame(failed('error')))),
      { accounts, pool });
    await executeGatewayRequestKernel(h.options);
    expect(h.prepared).toHaveLength(1);
    expect(h.written.join('')).toBe(wire);
    // The failed account must yield on the next request in this SAME session, without replaying emitted content.
    expect(pool.exhaustedCalls.map((p) => p.id)).toEqual(['chatgpt-a']);
  });
});

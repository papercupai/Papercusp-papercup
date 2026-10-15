/**
 * P-002 (plan `gateway-kernel-adoption-2026-08-29`) — falsification test for
 * plan D-001 ("the kernel is adoptable as-built").
 *
 * These tests drive the REAL `executeGatewayRequestKernel` with the Codex
 * bearer adapter and NO gateway wiring. If the kernel cannot express a
 * behaviour the live `proxyOpenAi` ladder has, that shows up here as a
 * failing test BEFORE any live handler is touched — which is the whole point
 * of sequencing P-002 ahead of P-003.
 *
 * Each test names the `proxyOpenAi` behaviour it pins.
 */
import { describe, expect, it } from 'vitest';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { rewriteOpenAiCacheBody, shardedCacheKey } from './cache-policy';
import {
  createCodexBearerKernelAdapter,
  parseCodexRequestShape,
  type CodexRequestShape,
  type CodexBearerAdapterOptions,
  type CodexBearerChunk,
  type CodexBearerFetchResponse,
  type CodexBearerResponseMetadata,
  type CodexBearerPreparedAttempt,
  type CodexBearerRouteValue,
} from './codex-bearer-kernel-adapter';
import {
  executeGatewayRequestKernel,
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

interface FakeAccount extends ActiveAccount {
  invalidated: number;
}

function account(id: string, token: () => Promise<string> = async () => `${id}-token`): FakeAccount {
  const acc: FakeAccount = {
    accountId: id,
    token,
    invalidated: 0,
    invalidateToken() {
      acc.invalidated++;
    },
  };
  return acc;
}

/**
 * Pool fake whose rotation is scripted by the test: `rotation` is consumed in
 * order by `onExhausted`, mirroring how the live `codexPool.onExhausted` parks
 * the failing account and hands back the next one.
 */
function makePool(
  accounts: FakeAccount[],
  rotation: Array<FakeAccount | null>,
): AccountPool & { exhaustedCalls: Array<{ id: string; resetAt: number }> } {
  const exhaustedCalls: Array<{ id: string; resetAt: number }> = [];
  let cursor = 0;
  return {
    exhaustedCalls,
    active: () => accounts[0]!,
    select: (accountId: string) => accounts.find((a) => a.accountId === accountId) ?? null,
    onExhausted: (exhaustedId: string, resetAt: number) => {
      exhaustedCalls.push({ id: exhaustedId, resetAt });
      return rotation[cursor++] ?? null;
    },
  };
}

function sseBody(...chunks: string[]): CodexBearerFetchResponse['body'] {
  const body = {
    cancelled: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
    async cancel() {
      body.cancelled++;
    },
  };
  return body as unknown as CodexBearerFetchResponse['body'];
}

function upstream(
  status: number,
  headers: Record<string, string>,
  body: CodexBearerFetchResponse['body'],
): CodexBearerFetchResponse {
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

/** Unused by these tests; the lane registry only needs a shape here. */
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
  codexCliAccountCount: () => 0,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
});
const lane = laneRegistry.openaiResponses;

interface HarnessOverrides {
  pin?: GatewayKernelAccountPin | null;
  requestHeaders?: Record<string, string | string[] | undefined>;
  rateResetAt?: CodexBearerAdapterOptions['rateResetAt'];
  /** Downstream request body. Defaults to a non-streaming request. */
  requestBody?: string;
  shapeRequestBody?: CodexBearerAdapterOptions['shapeRequestBody'];
  onRequestShape?: CodexBearerAdapterOptions['onRequestShape'];
  now?: () => number;
}

function harness(
  pool: ReturnType<typeof makePool>,
  fetchImpl: CodexBearerAdapterOptions['fetch'],
  overrides: HarnessOverrides = {},
) {
  const telemetry = new GatewayRequestTelemetry();
  const written: string[] = [];
  const started: Array<{ status: number; metadata: CodexBearerResponseMetadata; streaming: boolean }> = [];
  const prepared: CodexBearerPreparedAttempt[] = [];

  const adapter = createCodexBearerKernelAdapter({
    pool,
    upstreamBase: 'https://openai.test',
    urlPath: '/v1/responses',
    method: 'POST',
    requestHeaders: overrides.requestHeaders ?? { 'content-type': 'application/json', host: 'gateway.local' },
    stripRequestHeaders: STRIP_REQUEST,
    tokenTimeoutMs: 1_000,
    failoverBackoffMs: 5_000,
    fetch: fetchImpl,
    rateResetAt: overrides.rateResetAt,
    shapeRequestBody: overrides.shapeRequestBody,
    onRequestShape: overrides.onRequestShape,
    now: overrides.now,
  });

  // Wrap prepareAttempt so tests can assert on constructed headers without
  // reaching into the adapter's internals.
  const observedAdapter: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      const result = await adapter.prepareAttempt(context);
      prepared.push(result);
      return result;
    },
  };

  async function* body() {
    yield Buffer.from(overrides.requestBody ?? '{"model":"gpt-5.6"}');
  }

  const options: ExecuteGatewayRequestKernelOptions<
    CodexBearerRouteValue,
    CodexBearerPreparedAttempt,
    CodexBearerChunk,
    CodexBearerResponseMetadata
  > = {
    request: {
      lane,
      body: body(),
      ownerId: 'su-codex-adapter',
      correlationId: 'codex-adapter-test',
      pin: overrides.pin ?? null,
    },
    policy: POLICY,
    telemetry,
    admission: {
      async run(_context, task) {
        return task();
      },
    },
    adapter: observedAdapter,
    downstream: {
      start(response) {
        started.push({ status: response.status, metadata: response.metadata, streaming: response.streaming });
      },
      write(chunk) {
        written.push(Buffer.from(chunk).toString('utf8'));
      },
      end() {
        /* no-op */
      },
    },
    inFlight: {
      register: () => ({ unregister: () => undefined }),
    },
  };

  return { options, written, started, prepared };
}

describe('codex bearer kernel adapter', () => {
  it('serves a single-account success and reports the routed account', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, written, started } = harness(pool, async () =>
      upstream(200, { 'content-type': 'application/json' }, sseBody('{"ok":true}')),
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.failovers).toBe(0);
    expect(started[0]?.metadata.accountId).toBe('codex-a');
    expect(written.join('')).toBe('{"ok":true}');
  });

  it('builds upstream headers exactly as proxyOpenAi does: strip, bearer auth, identity encoding', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, prepared } = harness(
      pool,
      async () => upstream(200, {}, sseBody('ok')),
      {
        requestHeaders: {
          host: 'gateway.local',
          authorization: 'Bearer downstream-secret',
          'content-length': '19',
          'content-type': 'application/json',
          'x-forwarded-multi': ['a', 'b'],
        },
      },
    );

    await executeGatewayRequestKernel(options);

    const headers = prepared[0]!.headers;
    // Stripped hop-by-hop / downstream credentials never reach upstream.
    expect(headers.host).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    // The downstream Authorization is REPLACED by the pool token, not forwarded.
    expect(headers.authorization).toBe('Bearer codex-a-token');
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers['content-type']).toBe('application/json');
    // Array-valued headers are joined, matching the live handler.
    expect(headers['x-forwarded-multi']).toBe('a, b');
  });

  it('rotates to another account on a 429 and discards the throttled body', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    const throttled = sseBody('{"error":"rate"}') as unknown as { cancelled: number };
    const calls: string[] = [];
    const { options, started } = harness(pool, async (_url, init) => {
      calls.push(init.headers.authorization!);
      return calls.length === 1
        ? upstream(429, { 'x-ratelimit-reset': '30' }, throttled as never)
        : upstream(200, {}, sseBody('{"ok":true}'));
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(200);
    expect(result.failovers).toBe(1);
    expect(result.attempts).toBe(2);
    expect(started[0]?.metadata.accountId).toBe('codex-b');
    // The kernel's discard() hook is what releases the throttled socket.
    expect(throttled.cancelled).toBe(1);
    expect(pool.exhaustedCalls[0]?.id).toBe('codex-a');
  });

  it('uses the parsed rate-reset instant when parking a throttled account', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    let call = 0;
    const { options } = harness(
      pool,
      async () => (++call === 1 ? upstream(429, { 'x-ratelimit-reset': '30' }, sseBody('x')) : upstream(200, {}, sseBody('ok'))),
      { rateResetAt: () => 1_700_000_000_000, now: () => 1_000 },
    );

    await executeGatewayRequestKernel(options);

    // Not the now()+backoff fallback — the header-derived instant wins.
    expect(pool.exhaustedCalls[0]?.resetAt).toBe(1_700_000_000_000);
  });

  it('falls back to now()+backoff when no rate-reset header is parseable', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    let call = 0;
    const { options } = harness(
      pool,
      async () => (++call === 1 ? upstream(429, {}, sseBody('x')) : upstream(200, {}, sseBody('ok'))),
      { rateResetAt: () => null, now: () => 1_000 },
    );

    await executeGatewayRequestKernel(options);

    expect(pool.exhaustedCalls[0]?.resetAt).toBe(6_000);
  });

  it('rotates on a transport failure and invalidates the failed account token', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    let call = 0;
    const { options, started } = harness(pool, async () => {
      if (++call === 1) throw new Error('ECONNRESET');
      return upstream(200, {}, sseBody('{"ok":true}'));
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(200);
    expect(result.failovers).toBe(1);
    expect(started[0]?.metadata.accountId).toBe('codex-b');
    expect(a.invalidated).toBe(1);
  });

  it('preserves undici fetch diagnostics and the original cause on transport failure', async () => {
    const fetchFailure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'read ECONNRESET' },
    });
    const { options } = harness(makePool([account('codex-a')], []), async () => { throw fetchFailure; });
    options.policy = { ...options.policy, maxAttempts: 1 };
    const error = await executeGatewayRequestKernel(options).then(
      () => { throw new Error('expected upstream failure'); },
      (reason: unknown) => reason as { code: string; message: string; cause?: unknown },
    );

    expect(error).toMatchObject({
      code: 'upstream-error',
      message: 'inference-gateway: Codex upstream failed: fetch failed (ECONNRESET: read ECONNRESET)',
    });
    expect(error.cause).toBe(fetchFailure);
  });

  it('rotates when the token read fails, before any upstream call is made', async () => {
    const a = account('codex-a', async () => {
      throw new Error('keyring unavailable');
    });
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    const seen: string[] = [];
    const { options, started } = harness(pool, async (_url, init) => {
      seen.push(init.headers.authorization!);
      return upstream(200, {}, sseBody('{"ok":true}'));
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(200);
    expect(result.failovers).toBe(1);
    // The failed account never reached the transport.
    expect(seen).toEqual(['Bearer codex-b-token']);
    expect(started[0]?.metadata.accountId).toBe('codex-b');
  });

  it('forwards the 429 when no rotation target remains, instead of failing the request', async () => {
    const a = account('codex-a');
    const pool = makePool([a], [null]);
    const { options, started } = harness(pool, async () => upstream(429, {}, sseBody('{"error":"rate"}')));

    const result = await executeGatewayRequestKernel(options);

    // proxyOpenAi falls through and forwards the throttle to the caller.
    expect(result.status).toBe(429);
    expect(result.failovers).toBe(0);
    expect(started[0]?.status).toBe(429);
  });

  it('WI-10004561: redacts the presented pool credential from a forwarded upstream error body', async () => {
    const a = account('codex-a');
    const pool = makePool([a], [null]);
    // The upstream echoes the BARE credential it was sent (no "Bearer " prefix), which the
    // shape-only scrub cannot see; only exact-value redaction of the presented header catches it.
    const { options, written, started } = harness(pool, async (_url, init) => {
      const presented = String(init.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      return upstream(401, { 'content-type': 'application/json' }, sseBody(`{"error":"invalid key ${presented}"}`));
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(401);
    expect(started[0]?.status).toBe(401);
    const relayed = written.join('');
    expect(relayed).toContain('invalid key');
    expect(relayed).not.toContain('codex-a-token');
  });

  it('WI-10004561: leaves a successful body untouched even when it contains the credential text', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, written } = harness(pool, async () =>
      upstream(200, { 'content-type': 'application/json' }, sseBody('{"echo":"codex-a-token"}')),
    );

    await executeGatewayRequestKernel(options);

    // Calibration: the scrub is scoped to error bodies, so a 2xx relays byte-for-byte.
    expect(written.join('')).toBe('{"echo":"codex-a-token"}');
  });

  it('declines a rotation back onto an already-tried account rather than tripping route-cycle', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    // Second rotation hands back codex-a, which attempt 1 already used.
    const pool = makePool([a, b], [b, a]);
    const { options, started } = harness(pool, async () => upstream(429, {}, sseBody('{"error":"rate"}')));

    const result = await executeGatewayRequestKernel(options);

    // The kernel THROWS route-cycle if an adapter returns a tried route, so
    // declining is what keeps this a forwarded 429. rotateCodex compared only
    // against the CURRENT account and so could have looped a->b->a.
    expect(result.status).toBe(429);
    expect(result.failovers).toBe(1);
    expect(started[0]?.metadata.accountId).toBe('codex-b');
  });

  it('suppresses failover under a hard pin and forwards the 429', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    const { options, started } = harness(pool, async () => upstream(429, {}, sseBody('{"error":"rate"}')), {
      pin: { accountId: 'codex-a', mode: 'hard' },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(429);
    expect(result.failovers).toBe(0);
    expect(started[0]?.metadata.accountId).toBe('codex-a');
    // The hard pin is enforced by the kernel before the adapter is consulted,
    // so the pool is never asked to rotate.
    expect(pool.exhaustedCalls).toHaveLength(0);
  });

  it('records a soft-pin yield on the response metadata', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    let call = 0;
    const { options, started } = harness(
      pool,
      async () => (++call === 1 ? upstream(429, {}, sseBody('x')) : upstream(200, {}, sseBody('ok'))),
      { pin: { accountId: 'codex-a', mode: 'soft' } },
    );

    await executeGatewayRequestKernel(options);

    expect(started[0]?.metadata.accountId).toBe('codex-b');
    expect(started[0]?.metadata.pinYieldedFrom).toBe('codex-a');
  });

  /**
   * D-007. `proxyOpenAi` parses `stream:true` out of the REQUEST body
   * (gateway.ts, the `isStream` block before the attempt loop) and uses that
   * single fact for both its TTFB choice and `stageSpan.setStreaming`. This
   * pins the source, not just the value.
   */
  it('marks a stream:true REQUEST as streaming, as proxyOpenAi does', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, started, written } = harness(
      pool,
      async () => upstream(200, { 'content-type': 'text/event-stream' }, sseBody('data: 1\n\n', 'data: 2\n\n')),
      { requestBody: '{"model":"gpt-5.6","stream":true}' },
    );

    await executeGatewayRequestKernel(options);

    expect(started[0]?.streaming).toBe(true);
    expect(written).toEqual(['data: 1\n\n', 'data: 2\n\n']);
  });

  /**
   * The half of D-007 that the P-002 suite could not see. These two cases are
   * exactly where request-derived and response-derived streaming DISAGREE, so
   * together they falsify the D-006 implementation rather than merely passing
   * alongside it.
   */
  it('D-007: a streaming request whose upstream answers with a JSON error is still streaming', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, started } = harness(
      pool,
      async () => upstream(429, { 'content-type': 'application/json' }, sseBody('{"error":"rate"}')),
      { requestBody: '{"model":"gpt-5.6","stream":true}' },
    );

    await executeGatewayRequestKernel(options);

    // Response content-type says application/json; the REQUEST said stream.
    expect(started[0]?.streaming).toBe(true);
  });

  it('D-007: a non-streaming request is not streaming even when the upstream sends event-stream', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, started } = harness(pool, async () =>
      upstream(200, { 'content-type': 'text/event-stream' }, sseBody('data: 1\n\n')),
    );

    await executeGatewayRequestKernel(options);

    expect(started[0]?.streaming).toBe(false);
  });

  it('reports the request-derived model and streaming shape exactly once', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    const shapes: CodexRequestShape[] = [];
    let call = 0;
    const { options } = harness(
      pool,
      async () =>
        call++ === 0
          ? upstream(429, {}, sseBody('{"error":"rate"}'))
          : upstream(200, {}, sseBody('{"ok":true}')),
      { requestBody: '{"model":"gpt-5.6","stream":true}', onRequestShape: (shape) => shapes.push(shape) },
    );

    await executeGatewayRequestKernel(options);

    // Two attempts, ONE shape report — the live handler derives these before
    // its loop, so a failover must not re-emit them.
    expect(shapes).toEqual([{ model: 'gpt-5.6', streaming: true }]);
  });

  it('treats a non-JSON body as non-streaming with no model, like the live catch', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const shapes: CodexRequestShape[] = [];
    const { options, started } = harness(pool, async () => upstream(200, {}, sseBody('ok')), {
      requestBody: 'not json at all',
      onRequestShape: (shape) => shapes.push(shape),
    });

    await executeGatewayRequestKernel(options);

    expect(shapes).toEqual([{ model: null, streaming: false }]);
    expect(started[0]?.streaming).toBe(false);
  });

  it('shapes the request body ONCE and re-sends the shaped bytes on every attempt', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    const shapeCalls: Array<{ accountId: string; ownerId: string | null }> = [];
    let call = 0;
    const { options, prepared } = harness(
      pool,
      async () =>
        call++ === 0
          ? upstream(429, {}, sseBody('{"error":"rate"}'))
          : upstream(200, {}, sseBody('{"ok":true}')),
      {
        shapeRequestBody: (body, context) => {
          shapeCalls.push(context);
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          parsed.prompt_cache_key = `psu-${context.ownerId ?? context.accountId}`;
          return Buffer.from(JSON.stringify(parsed), 'utf8');
        },
      },
    );

    await executeGatewayRequestKernel(options);

    // Shaped once, against the INITIAL account — matching the live handler,
    // whose shardSeed is `owner || active.accountId` before the loop.
    expect(shapeCalls).toEqual([{ accountId: 'codex-a', ownerId: 'su-codex-adapter' }]);
    expect(prepared).toHaveLength(2);
    for (const attempt of prepared) {
      expect(JSON.parse(Buffer.from(attempt.body!).toString('utf8'))).toMatchObject({
        model: 'gpt-5.6',
        prompt_cache_key: 'psu-su-codex-adapter',
      });
    }
  });

  it('forwards the body unchanged when no shaper is supplied', async () => {
    const a = account('codex-a');
    const pool = makePool([a], []);
    const { options, prepared } = harness(pool, async () => upstream(200, {}, sseBody('{"ok":true}')));

    await executeGatewayRequestKernel(options);

    expect(Buffer.from(prepared[0]!.body!).toString('utf8')).toBe('{"model":"gpt-5.6"}');
  });

  /**
   * ORDERING GUARD for `shapeRequestBody`'s documented boundary.
   *
   * The kernel resolves its D-007 TTFB deadline from the PRE-shape buffer, so
   * shaping is only safe while it cannot change the fields that deadline is
   * derived from. That is a property of the REAL cache-policy rewrite, not an
   * assumption, so assert it against the real function: if a future cache
   * policy starts touching `stream`, this fails and sends the reader to the
   * ordering note rather than letting a silent TTFB mismatch ship.
   */
  it('GUARD: the real cache-policy rewrite never changes the request-derived shape', () => {
    for (const raw of [
      '{"model":"gpt-5.6","stream":true}',
      '{"model":"gpt-4.1","stream":false}',
      '{"model":"gpt-5.6"}',
      '{"stream":true}',
    ]) {
      const before = parseCodexRequestShape(Buffer.from(raw));
      const after = parseCodexRequestShape(
        rewriteOpenAiCacheBody(Buffer.from(raw), { cacheKey: shardedCacheKey('psu', 'seed', 8) }).body,
      );
      expect(after).toEqual(before);
    }
  });

  /**
   * FALSIFIABILITY CONTROL (CLAUDE.md § "Proving a guard is falsifiable", the
   * "a MODULE you import" tier). A deliberately-wrong adapter kept permanently
   * in the test file, so the suite above is demonstrably capable of failing
   * rather than merely never having failed.
   *
   * The wrong implementation is precisely `rotateCodex`'s weaker guard: it
   * compares the rotation target against the CURRENT account only, never
   * against the tried set. Under the kernel that is not a silent a->b->a
   * re-try as it was in `proxyOpenAi` — it is a hard `route-cycle` throw. This
   * control both proves the real adapter's `triedRouteKeys` check is
   * load-bearing and pins the behaviour difference P-003 must carry.
   */
  it('CONTROL: an adapter using rotateCodex\'s current-account-only guard trips route-cycle', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b, a]);
    const { options } = harness(pool, async () => upstream(429, {}, sseBody('{"error":"rate"}')));

    // Downgrade ONLY the tried-set check, leaving everything else real.
    const real = options.adapter;
    options.adapter = {
      ...real,
      selectFailover(context) {
        const current = context.currentRoute?.value.account.accountId;
        if (!current) return null;
        const next = pool.onExhausted(current, 0);
        if (!next || next.accountId === current) return null;
        return { key: `bearer:${next.accountId}`, accountId: next.accountId, transport: 'bearer-http', value: { account: next } };
      },
    };

    await expect(executeGatewayRequestKernel(options)).rejects.toThrow(/already-tried route/);
  });

  it('CONTROL: an adapter that omits retryable on a 429 never rotates', async () => {
    const a = account('codex-a');
    const b = account('codex-b');
    const pool = makePool([a, b], [b]);
    const { options, started } = harness(pool, async () => upstream(429, {}, sseBody('{"error":"rate"}')));

    const real = options.adapter;
    options.adapter = {
      ...real,
      async executeAttempt(prepared, context) {
        const response = await real.executeAttempt(prepared, context);
        return { ...response, retryable: false };
      },
    };

    const result = await executeGatewayRequestKernel(options);

    // Proves the rotate-on-429 tests above are actually driven by the
    // adapter's `retryable` normalization, not by kernel defaults.
    expect(result.failovers).toBe(0);
    expect(started[0]?.metadata.accountId).toBe('codex-a');
  });

  it('surfaces a typed unavailability error when no bearer account resolves', async () => {
    const pool: AccountPool = {
      active: () => {
        throw new Error('no codex accounts configured');
      },
      onExhausted: () => null,
      select: () => null,
    };
    const { options } = harness(pool as ReturnType<typeof makePool>, async () => upstream(200, {}, sseBody('ok')));

    // The CLI-bridge fallback is a different transport chosen before the
    // kernel is entered, so unavailability surfaces rather than substituting.
    await expect(executeGatewayRequestKernel(options)).rejects.toThrow(/no Codex bearer account available/);
  });
});

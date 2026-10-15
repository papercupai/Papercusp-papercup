/**
 * P-007 (anthropic-credits-gateway-2026-09-30) — billing-state parsing + credit-exhaustion walls.
 * Header and body shapes are the documented / CLI-observed ones (see anthropic-billing.ts header comment).
 */
import { describe, expect, it } from 'vitest';
import {
  CREDIT_WALL_DEFAULT_PAUSE_MS,
  classifyClaudeCreditWall,
  classifyClaudeCreditWallResponse,
  parseClaudeBillingState,
} from './anthropic-billing';
import {
  createClaudeKernelAdapter,
  type ClaudeChunk,
  type ClaudeClassifyInput,
  type ClaudeFetchResponse,
  type ClaudePreparedAttempt,
  type ClaudeResponseClassification,
  type ClaudeResponseMetadata,
  type ClaudeRouteValue,
} from './claude-kernel-adapter';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { executeGatewayRequestKernel, type ExecuteGatewayRequestKernelOptions } from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

const errBody = (type: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'error', error: { type, message, ...extra } });

describe('P-007 — subscription billing state from unified headers', () => {
  it('R-15: unified-status allowed with no overage in use parses to included', () => {
    expect(
      parseClaudeBillingState({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'false',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      }),
    ).toEqual({ state: 'included', claim: 'five_hour' });
    expect(parseClaudeBillingState({ 'anthropic-ratelimit-unified-status': 'allowed_warning' })?.state).toBe('included');
  });

  it('R-16: overage in use parses to usage-credits', () => {
    const s = parseClaudeBillingState({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
      'anthropic-ratelimit-unified-overage-reset': '1790900000',
    });
    expect(s).toEqual({ state: 'usage-credits', resetAt: 1790900000 * 1000 });
    // Overage in use wins even if the unified status still reads allowed on this response.
    expect(
      parseClaudeBillingState({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      })?.state,
    ).toBe('usage-credits');
  });

  it('R-16 (edge): allowance exhausted but overage allowed parses to usage-credits', () => {
    expect(
      parseClaudeBillingState({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-overage-status': 'allowed_warning',
      })?.state,
    ).toBe('usage-credits');
  });

  it('R-17: unified-status rejected + overage-status rejected parses to walled', () => {
    const s = parseClaudeBillingState({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1790810000',
    });
    expect(s?.state).toBe('walled');
    expect(s?.resetAt).toBe(1790810000 * 1000);
  });

  it('R-18: a walled state carries the overage-disabled-reason header value as its reason', () => {
    const s = parseClaudeBillingState({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    });
    expect(s).toMatchObject({ state: 'walled', reason: 'out_of_credits' });
  });

  it('a response with no unified-status header has no billing state (unknown is not included)', () => {
    expect(parseClaudeBillingState({})).toBeNull();
    expect(parseClaudeBillingState({ 'retry-after': '5' })).toBeNull();
    expect(parseClaudeBillingState({ 'anthropic-ratelimit-unified-status': '  ' })).toBeNull();
  });
});

describe('P-007 — API-key credit walls', () => {
  it('R-19: a 402 billing_error classifies as a credit wall', () => {
    expect(
      classifyClaudeCreditWall({
        status: 402,
        headers: {},
        body: errBody('billing_error', 'Your credit balance is too low to access the Anthropic API.'),
      }),
    ).toEqual({ cause: 'billing-error' });
    // An empty peek (timed out) is still Payment Required.
    expect(classifyClaudeCreditWall({ status: 402, headers: {}, body: '' })?.cause).toBe('billing-error');
  });

  it('R-20: a 429 whose error code is enforced_spend_limit_reached classifies as a credit wall', () => {
    const body = errBody('rate_limit_error', 'You have reached your spend limit.', {
      details: { error_code: 'enforced_spend_limit_reached' },
    });
    expect(classifyClaudeCreditWall({ status: 429, headers: {}, body })).toEqual({ cause: 'spend-limit' });
    // A truncated (non-JSON) peek still names the code.
    expect(classifyClaudeCreditWall({ status: 429, headers: {}, body: body.slice(0, -3) })?.cause).toBe('spend-limit');
  });

  it('R-21: a 400 stating the specified API usage limits were reached classifies as a credit wall', () => {
    const wall = classifyClaudeCreditWall({
      status: 400,
      headers: {},
      body: errBody(
        'invalid_request_error',
        'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
      ),
    });
    expect(wall).toEqual({ cause: 'api-usage-limit', resetAt: Date.parse('2026-10-01T00:00:00Z') });
    expect(
      classifyClaudeCreditWall({
        status: 400,
        headers: {},
        body: errBody('invalid_request_error', 'You have reached your specified workspace API usage limits.'),
      })?.cause,
    ).toBe('api-usage-limit');
  });

  it('R-21: a 400 credit-balance-low response classifies as a billing wall', () => {
    expect(
      classifyClaudeCreditWall({
        status: 400,
        headers: {},
        body: errBody('invalid_request_error', 'Credit balance is too low'),
      }),
    ).toEqual({ cause: 'billing-error' });
    expect(
      classifyClaudeCreditWall({
        status: 400,
        headers: {},
        body: errBody('billing_error', 'Your credit balance is too low to access the Anthropic API.'),
      }),
    ).toEqual({ cause: 'billing-error' });
  });

  it('R-21 (negative): an ordinary 400 is not a credit wall', () => {
    expect(
      classifyClaudeCreditWall({ status: 400, headers: {}, body: errBody('invalid_request_error', 'max_tokens: must be positive') }),
    ).toBeNull();
  });

  it('R-22: an api-key 429 with retry-after and no spend-limit code is not a credit wall', () => {
    expect(
      classifyClaudeCreditWall({
        status: 429,
        headers: { 'retry-after': '12' },
        body: errBody('rate_limit_error', 'This request would exceed the rate limit for your organization of 50 requests per minute.'),
      }),
    ).toBeNull();
  });

  it('non-billing statuses never classify as credit walls', () => {
    for (const status of [200, 401, 403, 500, 529]) {
      expect(classifyClaudeCreditWall({ status, headers: {}, body: errBody('billing_error', 'x') })).toBeNull();
    }
    expect(CREDIT_WALL_DEFAULT_PAUSE_MS).toBeGreaterThan(0);
  });
});

/**
 * R-23 — the real Claude kernel adapter, a two-account pool, and the SAME credit-wall classification
 * gateway.ts returns (`classifyClaudeCreditWallResponse`); every other failure is forwarded, which is
 * what makes the plain-400 case below a matched control.
 */
describe('R-23 — a credit wall makes the Claude adapter fail over to another pool account', () => {
  const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
  const lane = makeGatewayLaneRegistry({
    claudePool: {
      active: () => {
        throw new Error('unused pool');
      },
      onExhausted: () => null,
      select: () => null,
    },
    codexPool: null,
    codexCliAccountCount: () => 1,
    anthropicUpstreamBase: 'https://anthropic.test',
    openaiUpstreamBase: 'https://openai.test',
  }).anthropicMessages;
  const acct = (accountId: string): ActiveAccount =>
    ({ accountId, token: async () => `${accountId}-tok` }) as ActiveAccount;
  const upstream = (status: number, body: string): ClaudeFetchResponse => ({
    status,
    headers: { forEach: () => undefined },
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  });
  const classify = (input: ClaudeClassifyInput): ClaudeResponseClassification =>
    classifyClaudeCreditWallResponse(input, NOW) ?? { kind: 'forward' };

  /** Account A answers `first`; every later attempt is served 200 by whichever account it lands on. */
  async function drive(first: ClaudeFetchResponse) {
    const parked: { id: string; resetAt: number }[] = [];
    const pool: AccountPool = {
      active: () => {
        throw new Error('adapter called pool.active()');
      },
      select: () => null,
      onExhausted: (id: string, resetAt: number) => {
        parked.push({ id, resetAt });
        return (id === 'A' ? acct('B') : null) as ReturnType<AccountPool['onExhausted']>;
      },
    };
    const attempts: string[] = [];
    const classifications: (ClaudeResponseClassification | null)[] = [];
    const forwarded: Buffer[] = [];
    let n = 0;
    let fetches = 0;
    const adapter = createClaudeKernelAdapter({
      initialAccount: acct('A'),
      pool,
      upstreamUrl: 'https://anthropic.test/v1/messages',
      method: 'POST',
      baseHeaders: { 'content-type': 'application/json' },
      body: null,
      streaming: true,
      tokenTimeoutMs: 1_000,
      failoverBackoffMs: 5_000,
      overloadBackoffMs: 30,
      transientBackoffMs: 20,
      pickEgress: (account) => ({ entry: undefined, key: `${account.accountId}:ip${++n}` }),
      // TRUE on purpose: a credit wall is an ACCOUNT wall, so a same-account retry on a fresh IP is wrong.
      siblingEgressAvailable: () => true,
      dispatcherFor: () => undefined,
      fetch: async () => (++fetches === 1 ? first : upstream(200, '{"ok":true}')),
      rateReset: () => ({ resetAt: null, retryAfterMs: null }),
      classifyResponse: classify,
      peekBytes: 4096,
      peekTimeoutMs: 1_000,
    });
    const options: ExecuteGatewayRequestKernelOptions<
      ClaudeRouteValue,
      ClaudePreparedAttempt,
      ClaudeChunk,
      ClaudeResponseMetadata
    > = {
      request: {
        lane,
        body: (async function* () {
          yield Buffer.from('{"model":"claude-opus-4"}');
        })(),
        ownerId: 'su-r23',
        correlationId: 'r23',
        pin: null,
      },
      policy: {
        maxBodyBytes: 4096,
        bodyReadTimeoutMs: 2_000,
        requestCeilingMs: 10_000,
        ttfbTimeoutMs: 2_000,
        bodyIdleTimeoutMs: 2_000,
        downstreamIdleTimeoutMs: 2_000,
        maxAttempts: 4,
      },
      telemetry: new GatewayRequestTelemetry(),
      admission: {
        run: async (_context, task) => task(),
        observeAttempt: ({ response }) => {
          classifications.push(response?.metadata?.classification ?? null);
        },
      },
      adapter: {
        ...adapter,
        async prepareAttempt(context) {
          const prepared = await adapter.prepareAttempt(context);
          attempts.push(prepared.accountId);
          return prepared;
        },
      },
      downstream: {
        start: () => undefined,
        write: (chunk) => {
          forwarded.push(Buffer.from(chunk));
        },
        end: () => undefined,
      },
      inFlight: { register: () => ({ unregister: () => undefined }) },
    };
    await executeGatewayRequestKernel(options);
    return { attempts, parked, classifications, forwardedBody: Buffer.concat(forwarded).toString('utf8') };
  }

  const REGAIN_AT = Date.UTC(2026, 9, 1, 0, 0, 0);
  const walls: { name: string; response: () => ClaudeFetchResponse; resetAt: number }[] = [
    {
      name: '402 billing_error (empty Console balance)',
      response: () => upstream(402, errBody('billing_error', 'Your credit balance is too low to access the Anthropic API.')),
      resetAt: NOW + CREDIT_WALL_DEFAULT_PAUSE_MS,
    },
    {
      name: '429 enforced_spend_limit_reached',
      response: () =>
        upstream(
          429,
          errBody('rate_limit_error', 'You have reached your spend limit.', {
            details: { error_code: 'enforced_spend_limit_reached' },
          }),
        ),
      resetAt: NOW + CREDIT_WALL_DEFAULT_PAUSE_MS,
    },
    {
      name: '400 specified API usage limits (named reset)',
      response: () =>
        upstream(
          400,
          errBody(
            'invalid_request_error',
            'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
          ),
        ),
      resetAt: REGAIN_AT,
    },
    {
      name: '400 credit balance is too low',
      response: () => upstream(400, errBody('invalid_request_error', 'Credit balance is too low')),
      resetAt: NOW + CREDIT_WALL_DEFAULT_PAUSE_MS,
    },
  ];

  for (const wall of walls) {
    it(`R-23: ${wall.name} on account A is served by account B, and A is parked until its reset`, async () => {
      const { attempts, parked, classifications, forwardedBody } = await drive(wall.response());
      expect(attempts, 'the walled account must be left, not retried (even on a fresh egress IP)').toEqual(['A', 'B']);
      expect(classifications[0]?.kind).toBe('credit-wall');
      expect(parked, 'the pool parks A exactly once, until the wall resets').toEqual([{ id: 'A', resetAt: wall.resetAt }]);
      expect(forwardedBody, 'the caller gets B’s answer, never the wall').toBe('{"ok":true}');
    });
  }

  it('R-23 control: a plain 400 on the same pool is forwarded on account A, with no failover', async () => {
    const { attempts, parked, forwardedBody } = await drive(
      upstream(400, errBody('invalid_request_error', 'max_tokens: must be positive')),
    );
    expect(attempts).toEqual(['A']);
    expect(parked).toEqual([]);
    expect(forwardedBody).toContain('max_tokens: must be positive');
  });
});

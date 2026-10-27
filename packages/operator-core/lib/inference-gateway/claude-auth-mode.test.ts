/**
 * anthropic-credits-gateway-2026-09-30 P-006 — the Claude credential SHAPE is chosen per
 * ATTEMPT from the account the attempt lands on:
 *   - subscription (oauth) account → `authorization: Bearer` + the `oauth-2025-04-20` beta;
 *   - Console API-key account      → `x-api-key`, no `authorization`, no subscription identity
 *                                     betas or CLI user-agent; feature betas kept.
 * A request that hits a usage cap on a subscription account can rotate onto an API-key account
 * inside the same request, so the second attempt must switch shape (R-13). A caller can never
 * inject its own credential upstream (R-14).
 *
 * The attempts are driven through the REAL Claude kernel adapter + request kernel (not a copy of
 * the header rule), so a regression in `prepareAttempt`'s wiring fails here, not only a
 * regression in the helper.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../deployment/account-pool';
import { classifyClaudeCreditWallResponse } from './anthropic-billing';
import { probeAccountCapacity } from './capacity-probe';
import {
  createClaudeKernelAdapter,
  type ClaudeAdapterOptions,
  type ClaudeFetchResponse,
} from './claude-kernel-adapter';
import {
  CLAUDE_CONTEXT_1M_BETA,
  CLAUDE_CODE_BETA,
  CLAUDE_OAUTH_BETA,
  claudeAttemptHeaders,
  claudeAuthModeForRef,
  withClientBetas,
} from './credential-store';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { executeGatewayRequestKernel, type GatewayKernelPolicy } from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

// Built at runtime so no key-shaped literal sits in the tree (the secrets guard is right to flag one).
const API_KEY = ['sk', 'ant', 'api03', 'fixture'].join('-');
const OAUTH_TOKEN = ['sk', 'ant', 'oat01', 'fixture'].join('-');
const OTHER_BETA = 'fine-grained-tool-streaming-2025-05-14';

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
const lane = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
}).anthropicMessages;

const oauthAccount = (accountId = 'sub'): ActiveAccount =>
  ({ accountId, authMode: 'oauth', token: async () => OAUTH_TOKEN }) as ActiveAccount;
const apiKeyAccount = (accountId = 'console'): ActiveAccount =>
  ({ accountId, authMode: 'api-key', token: async () => API_KEY }) as ActiveAccount;

function res(status: number, body = '{"ok":true}'): ClaudeFetchResponse {
  return {
    status,
    headers: { forEach: () => undefined },
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  };
}

/**
 * Mirrors gateway.ts's Claude classifier order for the shapes these tests need: the REAL credit-wall
 * classifier first (an API-key account's way out of the pool), then the subscription usage-cap shape.
 */
function classifier(input: { status: number; headers: Record<string, string>; body: string }) {
  const creditWall = classifyClaudeCreditWallResponse(input);
  if (creditWall) return creditWall;
  if (input.status === 429 && /session limit/i.test(input.body))
    return { kind: 'usage-cap' as const, resetAt: 4_000_000_000_000 };
  return { kind: 'forward' as const };
}

/** Run one request through the real adapter + kernel; return the headers each attempt SENT. */
async function runAttempts(opts: {
  initial: ActiveAccount;
  rotation?: ActiveAccount[];
  baseHeaders?: Record<string, string>;
  body?: Uint8Array;
  responses?: ClaudeFetchResponse[];
}): Promise<{ sent: Record<string, string>[]; accountIds: string[]; bodies: Array<Uint8Array | null> }> {
  const sent: Record<string, string>[] = [];
  const bodies: Array<Uint8Array | null> = [];
  const accountIds: string[] = [];
  const responses = [...(opts.responses ?? [])];
  let rotationCursor = 0;
  const pool: AccountPool = {
    active: () => {
      throw new Error('adapter must not call pool.active()');
    },
    select: () => null,
    onExhausted: () => (opts.rotation?.[rotationCursor++] ?? null) as ReturnType<AccountPool['onExhausted']>,
  };
  const fetchImpl: ClaudeAdapterOptions['fetch'] = async (_url, init) => {
    sent.push({ ...(init.headers as Record<string, string>) });
    bodies.push(init.body);
    return responses.shift() ?? res(200);
  };
  const adapter = createClaudeKernelAdapter({
    initialAccount: opts.initial,
    pool,
    upstreamUrl: 'https://anthropic.test/v1/messages',
    method: 'POST',
    baseHeaders: opts.baseHeaders ?? { 'content-type': 'application/json' },
    body: opts.body ?? null,
    streaming: true,
    tokenTimeoutMs: 1_000,
    failoverBackoffMs: 5_000,
    overloadBackoffMs: 10,
    transientBackoffMs: 10,
    pickEgress: (account) => ({ entry: undefined, key: `${account.accountId}:ip` }),
    siblingEgressAvailable: () => false,
    dispatcherFor: () => undefined,
    fetch: fetchImpl,
    rateReset: () => ({ resetAt: null, retryAfterMs: null }),
    classifyResponse: classifier,
    peekBytes: 4096,
    peekTimeoutMs: 1_000,
  });
  const observed: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      const prepared = await adapter.prepareAttempt(context);
      accountIds.push(prepared.accountId);
      return prepared;
    },
  };
  await executeGatewayRequestKernel({
    request: {
      lane,
      body: (async function* () {
        yield Buffer.from('{"model":"claude-opus-4"}');
      })(),
      ownerId: 'su-claude-auth-mode',
      correlationId: 'claude-auth-mode-test',
      pin: null,
    },
    policy: POLICY,
    telemetry: new GatewayRequestTelemetry(),
    admission: {
      async run(_context, task) {
        return task();
      },
      observeAttempt: () => undefined,
    },
    adapter: observed,
    downstream: { start: () => undefined, write: () => undefined, end: () => undefined },
    inFlight: { register: () => ({ unregister: () => undefined }) },
  });
  return { sent, accountIds, bodies };
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const betas = (h: Record<string, string>) =>
  (lower(h)['anthropic-beta'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

describe('P-006 — Claude credential shape per attempt', () => {
  it('R-7: an attempt on an api-key account sends the account key in x-api-key', async () => {
    const { sent } = await runAttempts({ initial: apiKeyAccount() });
    expect(sent).toHaveLength(1);
    expect(lower(sent[0]!)['x-api-key']).toBe(API_KEY);
  });

  it('R-8: an attempt on an api-key account sends no Authorization header, yet still carries its credential', async () => {
    const { sent } = await runAttempts({ initial: apiKeyAccount() });
    const h = lower(sent[0]!);
    expect(Object.keys(h)).not.toContain('authorization');
    // Dropping the Bearer must not leave the attempt credential-less (vetting E3).
    expect(h['x-api-key']).toBe(API_KEY);
  });

  it('R-9: an attempt on an api-key account omits the oauth-2025-04-20 beta flag', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': `${CLAUDE_OAUTH_BETA},${OTHER_BETA}` },
    });
    expect(betas(sent[0]!)).not.toContain(CLAUDE_OAUTH_BETA);
  });

  it('R-10: an attempt on an api-key account keeps active feature betas', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: {
        'content-type': 'application/json',
        'anthropic-beta': `${CLAUDE_CONTEXT_1M_BETA}, ${OTHER_BETA},${CLAUDE_OAUTH_BETA}`,
      },
    });
    expect(betas(sent[0]!)).toEqual([CLAUDE_CONTEXT_1M_BETA, OTHER_BETA]);
  });

  it('R-10b: an API-key fallback strips Claude Code framing, which Anthropic rejects as a credit error', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: {
        'content-type': 'application/json',
        'anthropic-beta': `${CLAUDE_CODE_BETA},${CLAUDE_CONTEXT_1M_BETA}`,
      },
    });
    expect(betas(sent[0]!)).toEqual([CLAUDE_CONTEXT_1M_BETA]);
  });

  it('sends GA effort without the retired beta header or any request-body change', async () => {
    const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 128,
      output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'Solve the task.' }] }));
    const { sent, bodies } = await runAttempts({ initial: apiKeyAccount(), body,
      baseHeaders: { 'Anthropic-Beta': `${CLAUDE_CODE_BETA},${CLAUDE_OAUTH_BETA},effort-2025-11-24`,
        'anthropic-beta': ' effort-2025-11-24 ', 'anthropic-version': '2023-06-01' } });
    expect(betas(sent[0]!)).toEqual([]);
    expect(lower(sent[0]!)['anthropic-version']).toBe('2023-06-01');
    expect(bodies).toEqual([body]);
    expect(JSON.parse(Buffer.from(bodies[0]!).toString()).output_config.effort).toBe('high');
  });

  it('normalizes retired effort only on the API-key rotation while preserving active and unknown betas', async () => {
    const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 128,
      output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'Solve the task.' }] }));
    const { sent, bodies } = await runAttempts({ initial: oauthAccount(), rotation: [apiKeyAccount()], body,
      baseHeaders: { 'anthropic-beta': `effort-2025-11-24,${CLAUDE_CONTEXT_1M_BETA},unknown-feature-2099-01-01` },
      responses: [res(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}'), res(200)] });
    expect(betas(sent[0]!)).toContain('effort-2025-11-24');
    expect(betas(sent[1]!)).toEqual([CLAUDE_CONTEXT_1M_BETA, 'unknown-feature-2099-01-01']);
    expect(bodies).toEqual([body, body]);
  });

  it('R-10c: an API-key fallback strips the Claude CLI user-agent, which Anthropic treats as subscription traffic', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: {
        'content-type': 'application/json',
        'user-agent': 'claude-cli/2.1.119 (external, cli)',
      },
    });
    expect(Object.keys(lower(sent[0]!))).not.toContain('user-agent');
  });

  it('OAuth to API-key rotation preserves CLI identity on the subscription attempt and strips it on fallback', async () => {
    const { sent } = await runAttempts({
      initial: oauthAccount('sub'),
      rotation: [apiKeyAccount('console')],
      baseHeaders: {
        'content-type': 'application/json',
        'User-Agent': 'claude-cli/2.1.119 (external, cli)',
        'anthropic-beta': `${CLAUDE_CODE_BETA},${CLAUDE_CONTEXT_1M_BETA}`,
      },
      responses: [res(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}'), res(200)],
    });
    expect(lower(sent[0]!)['user-agent']).toBe('claude-cli/2.1.119 (external, cli)');
    expect(betas(sent[0]!)).toContain(CLAUDE_CODE_BETA);
    expect(lower(sent[1]!)['user-agent']).toBeUndefined();
    expect(betas(sent[1]!)).toEqual([CLAUDE_CONTEXT_1M_BETA]);
  });

  it('an API-key attempt preserves a user-agent without Claude CLI identity', async () => {
    const { sent } = await runAttempts({ initial: apiKeyAccount(), baseHeaders: { 'user-agent': 'service-client/1.0' } });
    expect(lower(sent[0]!)['user-agent']).toBe('service-client/1.0');
  });

  it('OAuth/API-key rotation translates only the subscription billing block and preserves the original for OAuth', async () => {
    const payload = {
      model: 'claude-opus-5-5',
      max_tokens: 16,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli;' },
        { type: 'text', text: 'Keep the actual instructions.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: 'Continue.' }],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const { bodies } = await runAttempts({
      initial: oauthAccount('sub'), rotation: [apiKeyAccount('console'), oauthAccount('next-sub')], body,
      responses: [res(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}'),
        res(402, '{"error":{"type":"billing_error","message":"credit balance too low"}}'), res(200)],
    });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe(body);
    expect(JSON.parse(Buffer.from(bodies[1]!).toString())).toEqual({ ...payload, system: [
      { ...payload.system[0], text: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=sdk-cli;' }, payload.system[1],
    ] });
    expect(bodies[2]).toBe(body);
    expect(JSON.parse(body.toString())).toEqual(payload);
  });

  it('R-10 (edge): an api-key attempt whose only client beta was the oauth flag sends no anthropic-beta header', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': CLAUDE_OAUTH_BETA },
    });
    expect(Object.keys(lower(sent[0]!))).not.toContain('anthropic-beta');
  });

  it('R-11: an attempt on an oauth account sends Authorization Bearer with the account token', async () => {
    const { sent } = await runAttempts({ initial: oauthAccount() });
    const h = lower(sent[0]!);
    expect(h.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(Object.keys(h)).not.toContain('x-api-key');
  });

  it('R-11 (default): an account with no recorded auth mode is treated as a subscription account', async () => {
    const legacy = { accountId: 'legacy', token: async () => OAUTH_TOKEN } as ActiveAccount;
    const { sent } = await runAttempts({ initial: legacy });
    expect(lower(sent[0]!).authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(betas(sent[0]!)).toContain(CLAUDE_OAUTH_BETA);
  });

  it('R-12: an attempt on an oauth account carries the oauth-2025-04-20 beta flag (client betas kept)', async () => {
    const { sent } = await runAttempts({
      initial: oauthAccount(),
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': OTHER_BETA },
    });
    expect(betas(sent[0]!)).toEqual([OTHER_BETA, CLAUDE_OAUTH_BETA]);
  });

  it('R-13: a usage cap on the oauth account rotates to the api-key account, whose attempt carries api-key headers', async () => {
    const { sent, accountIds } = await runAttempts({
      initial: oauthAccount('sub'),
      rotation: [apiKeyAccount('console')],
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': CLAUDE_CONTEXT_1M_BETA },
      responses: [res(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}'), res(200)],
    });
    expect(accountIds).toEqual(['sub', 'console']);
    expect(sent).toHaveLength(2);
    // First attempt: subscription shape.
    expect(lower(sent[0]!).authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(betas(sent[0]!)).toContain(CLAUDE_OAUTH_BETA);
    // Second attempt, same request: api-key shape, nothing of the subscription credential left over.
    const second = lower(sent[1]!);
    expect(second['x-api-key']).toBe(API_KEY);
    expect(Object.keys(second)).not.toContain('authorization');
    expect(betas(sent[1]!)).toEqual([CLAUDE_CONTEXT_1M_BETA]);
  });

  it('R-13 (reverse): a credit wall on the api-key account rotates to the oauth account, whose attempt carries subscription headers', async () => {
    const { sent, accountIds } = await runAttempts({
      initial: apiKeyAccount('console'),
      rotation: [oauthAccount('sub')],
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': CLAUDE_CONTEXT_1M_BETA },
      responses: [res(402, '{"type":"error","error":{"type":"billing_error","message":"credit balance too low"}}'), res(200)],
    });
    expect(accountIds).toEqual(['console', 'sub']);
    expect(sent).toHaveLength(2);
    // First attempt: api-key shape.
    expect(lower(sent[0]!)['x-api-key']).toBe(API_KEY);
    // Second attempt, same request: subscription shape, nothing of the api-key credential left over.
    const second = lower(sent[1]!);
    expect(second.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(Object.keys(second)).not.toContain('x-api-key');
    expect(betas(sent[1]!)).toEqual(expect.arrayContaining([CLAUDE_OAUTH_BETA, CLAUDE_CONTEXT_1M_BETA]));
  });

  it('R-14: a caller-supplied x-api-key header is never forwarded on an oauth attempt', async () => {
    const { sent } = await runAttempts({
      initial: oauthAccount(),
      baseHeaders: {
        'content-type': 'application/json',
        'X-Api-Key': 'caller-injected-key',
        Authorization: 'Bearer caller-injected-token',
      },
    });
    const h = lower(sent[0]!);
    expect(Object.keys(h)).not.toContain('x-api-key');
    expect(Object.values(sent[0]!)).not.toContain('caller-injected-key');
    expect(h.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    // Exactly one authorization header survives — the caller's differently-cased one is gone.
    expect(Object.keys(sent[0]!).filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('R-14 (api-key side): a caller x-api-key cannot override the account key on an api-key attempt', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: { 'content-type': 'application/json', 'x-api-key': 'caller-injected-key' },
    });
    expect(lower(sent[0]!)['x-api-key']).toBe(API_KEY);
    expect(Object.keys(sent[0]!).filter((k) => k.toLowerCase() === 'x-api-key')).toHaveLength(1);
  });
});

describe('P-006 — supporting surfaces', () => {
  it('sends the selected account workspace and rejects caller workspace injection', async () => {
    const { sent } = await runAttempts({
      initial: { ...apiKeyAccount('scoped-api'), anthropicWorkspaceId: 'wrkspc_account' },
      baseHeaders: { 'Anthropic-Workspace-Id': 'wrkspc_caller' },
    });
    expect(lower(sent[0]!)['anthropic-workspace-id']).toBe('wrkspc_account');
    const base = { 'anthropic-workspace-id': 'wrkspc_previous' };
    expect(claudeAttemptHeaders(base, 'api-key', API_KEY)).not.toHaveProperty('anthropic-workspace-id');
    expect(claudeAttemptHeaders(base, 'oauth', OAUTH_TOKEN, 'wrkspc_api')).not.toHaveProperty('anthropic-workspace-id');
  });

  it('claudeAuthModeForRef reads the mode from the ref alone', () => {
    expect(claudeAuthModeForRef('apikey:env:ANTHROPIC_API_KEY')).toBe('api-key');
    expect(claudeAuthModeForRef('apikey:credentials')).toBe('api-key');
    expect(claudeAuthModeForRef('token:/tmp/x')).toBe('oauth');
    expect(claudeAuthModeForRef('env:CLAUDE_CODE_OAUTH_TOKEN')).toBe('oauth');
  });

  it('the gateway request-level beta value carries client betas without the oauth flag', () => {
    expect(withClientBetas(`${OTHER_BETA},${CLAUDE_OAUTH_BETA}`)).toBe(OTHER_BETA);
    expect(withClientBetas(null, true)).toBe(CLAUDE_CONTEXT_1M_BETA);
    expect(withClientBetas(CLAUDE_OAUTH_BETA)).toBeUndefined();
  });

  it('claudeAttemptHeaders leaves non-auth headers untouched', () => {
    const out = claudeAttemptHeaders({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, 'api-key', API_KEY);
    expect(out['content-type']).toBe('application/json');
    expect(out['anthropic-version']).toBe('2023-06-01');
  });

  it('the capacity probe authenticates an api-key account with x-api-key and no oauth beta', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const account = {
      id: 'console',
      credentialRef: 'apikey:env:ANTHROPIC_API_KEY',
      anthropicWorkspaceId: 'wrkspc_probe',
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
    } as ClaudeAccount;
    await probeAccountCapacity(account, { fetchImpl: f, resolveToken: async () => API_KEY, buildDispatcher: async () => undefined }, 0.97);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = lower(init.headers as Record<string, string>);
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-workspace-id']).toBe('wrkspc_probe');
    expect(Object.keys(headers)).not.toContain('authorization');
    expect(headers['anthropic-beta'] ?? '').not.toContain(CLAUDE_OAUTH_BETA);
  });
});

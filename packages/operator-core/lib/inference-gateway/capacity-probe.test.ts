/**
 * capacity-probe tests (plan gateway-clamp-advisory-capacity-probe-2026-07-09, P-001).
 *
 * The probe's whole job is to be TRUSTWORTHY EVIDENCE for an unwall (plan D-001), so the tests pin the
 * two ways it could lie:
 *   - a FAILED probe must never look like an unwall (that would strand the fleet on a capped account);
 *   - a 429 must still be read as signal (it carries the real reset), not thrown away as an error.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS,
  CAPACITY_PROBE_NOT_STARTED_ERROR,
  CAPACITY_PROBE_TIMEOUT_ERROR,
  CAPACITY_PROBE_REFUSAL_MAX_BYTES,
  CAPACITY_PROBE_REFUSAL_TIMEOUT_MS,
  parseCapacityHeaders,
  provesUnwall,
  storedWindows,
  isWalledCandidate,
  probeEgressFor,
  probeAccountCapacity,
  probeCapacityForAccounts,
  probeCodexAccountCapacity,
  UNWALL_EPSILON,
} from './capacity-probe';
import type { ClaudeAccount } from '../deployment/account-pool';

const FULL = 0.97;

const acct = (id: string, rate: Partial<ClaudeAccount['rate']> = {}, extra: Partial<ClaudeAccount> = {}): ClaudeAccount =>
  ({
    id,
    credentialRef: `token:/tmp/${id}`,
    rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, ...rate },
    ...extra,
  }) as ClaudeAccount;

/** A fetch stub returning the given headers + status, with a drainable body. */
const fakeFetch = (headers: Record<string, string>, status = 200) =>
  vi.fn(async () => new Response('{}', { status, headers })) as unknown as typeof fetch;

const okDeps = (headers: Record<string, string>, status = 200) => ({
  fetchImpl: fakeFetch(headers, status),
  resolveToken: async () => 'tok',
  buildDispatcher: async () => undefined,
});

afterEach(() => vi.useRealTimers());

describe('parseCapacityHeaders', () => {
  it('maps the unified 5h + 7d headers into the projection shape', () => {
    expect(
      parseCapacityHeaders({
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1783639800',
        'anthropic-ratelimit-unified-7d-utilization': '0.19',
        'anthropic-ratelimit-unified-7d-reset': '1784048400',
      }),
    ).toEqual({
      utilization: 0.42,
      windowResetAt: 1783639800_000,
      utilization7d: 0.19,
      windowResetAt7d: 1784048400_000,
    });
  });

  it('returns an EMPTY projection when no unified header is present (the "no signal" case)', () => {
    expect(parseCapacityHeaders({ 'retry-after': '30', 'content-type': 'application/json' })).toEqual({});
  });
});

describe('provesUnwall', () => {
  it('a Luna reserve-meter reading NEVER unwalls a premium wall — different meter (EI-22103680502746318)', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, { utilization7d: 0.04, bucket: 'base_model_inference' }, FULL)).toBe(false);
    // The same numbers on the PREMIUM meter still unwall — the guard is about the meter, not the value.
    expect(provesUnwall({ utilization7d: 1.0 }, { utilization7d: 0.04, bucket: 'premium' }, FULL)).toBe(true);
  });

  it('is TRUE when a stored 7d wall reads materially lower upstream', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, { utilization7d: 0.05 }, FULL)).toBe(true);
  });

  it('is FALSE when upstream CONFIRMS the wall (a real 1.0)', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, { utilization7d: 1.0 }, FULL)).toBe(false);
  });

  it('is FALSE when the account was never walled (nothing to unwall)', () => {
    expect(provesUnwall({ utilization7d: 0.2 }, { utilization7d: 0.05 }, FULL)).toBe(false);
  });

  it('is FALSE when there is no fresh reading at all — a failed probe must never unwall', () => {
    expect(provesUnwall({ utilization7d: 1.0 }, {}, FULL)).toBe(false);
  });

  it('ignores a move smaller than the epsilon (header jitter is not a reset)', () => {
    const before = { utilization7d: 1.0 };
    expect(provesUnwall(before, { utilization7d: 1.0 - UNWALL_EPSILON / 2 }, FULL)).toBe(false);
    expect(provesUnwall(before, { utilization7d: 1.0 - UNWALL_EPSILON * 2 }, FULL)).toBe(true);
  });

  it('a freed 5h window also unwalls a 5h-walled account', () => {
    expect(provesUnwall({ utilization: 0.99 }, { utilization: 0.01 }, FULL)).toBe(true);
  });
});

describe('isWalledCandidate', () => {
  it('selects accounts at/over the full-utilization threshold in EITHER window', () => {
    expect(isWalledCandidate(acct('a', { utilization7d: 1.0 }), FULL)).toBe(true);
    expect(isWalledCandidate(acct('b', { utilization: 0.98 }), FULL)).toBe(true);
    expect(isWalledCandidate(acct('c', { utilization: 0.5, utilization7d: 0.2 }), FULL)).toBe(false);
    expect(isWalledCandidate(acct('d'), FULL)).toBe(false); // never observed
  });
});

describe('probeEgressFor', () => {
  it('prefers the egressPool head (the gateway rotation head) over the legacy singular egress', () => {
    const a = acct('a', {}, { egress: { proxyUrl: 'http://legacy:3128' }, egressPool: [{ proxyUrl: 'http://head:3128' }, {}] });
    expect(probeEgressFor(a)).toEqual({ proxyUrl: 'http://head:3128' });
  });

  it('falls back to the singular egress when no pool is configured', () => {
    expect(probeEgressFor(acct('a', {}, { egress: { proxyUrl: 'http://only:3128' } }))).toEqual({ proxyUrl: 'http://only:3128' });
  });

  it('is undefined (box-default IP) when neither is set', () => {
    expect(probeEgressFor(acct('a'))).toBeUndefined();
  });
});

describe('storedWindows', () => {
  it('projects the stored rate windows, preserving `undefined` for never-observed', () => {
    expect(storedWindows(acct('a', { utilization7d: 1, windowResetAt7d: 5 }))).toEqual({
      utilization: undefined,
      windowResetAt: undefined,
      utilization7d: 1,
      windowResetAt7d: 5,
    });
  });
});

describe('probeAccountCapacity', () => {
  const refusalDeps = (response: Response, token = 'test-presented-credential-123456') => ({
    fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
    resolveToken: async () => token,
    buildDispatcher: async () => undefined,
  });

  it('retains a structured HTTP refusal without inventing capacity or exposing credentials', async () => {
    const token = 'test-presented-credential-123456';
    const response = new Response(JSON.stringify({
      error: { type: 'invalid_request_error', code: 'invalid_model', message: `Rejected ${token}\nmodel request` },
      request_id: 'req_body', ignored: token,
    }), { status: 400, headers: { 'request-id': 'req_header' } });
    const deps = refusalDeps(response, token);
    const result = await probeAccountCapacity(acct('refused', { utilization7d: 1 }, { credentialRef: 'apikey:env:TEST_API_KEY' }), deps, FULL);
    expect(result).toMatchObject({
      ok: false, status: 400, windows: {}, unwalls: false,
      httpRefusal: { status: 400, bodyState: 'parsed', errorType: 'invalid_request_error', errorCode: 'invalid_model', requestId: 'req_header' },
    });
    expect(result.httpRefusal?.message).toContain('[redacted]');
    expect(result.httpRefusal?.message).not.toContain('\n');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(response.bodyUsed).toBe(true);
    const [, init] = vi.mocked(deps.fetchImpl).mock.calls[0];
    expect(new Headers(init?.headers).get('x-api-key')).toBe(token);
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
  });

  it('bounds and sanitizes a complete malformed refusal body', async () => {
    const token = 'test-presented-credential-123456';
    const result = await probeAccountCapacity(acct('malformed'), refusalDeps(new Response(
      `bad payload ${token}\u001b${'x'.repeat(700)}`, { status: 502 },
    ), token), FULL);
    expect(result.httpRefusal?.bodyState).toBe('unstructured');
    expect(result.httpRefusal?.message?.length).toBe(512);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.httpRefusal?.message).not.toContain('\u001b');
  });

  it('cancels an oversized refusal without retaining a partial secret or body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(CAPACITY_PROBE_REFUSAL_MAX_BYTES + 1))); },
      cancel,
    }), { status: 400 });
    const result = await probeAccountCapacity(acct('oversized'), refusalDeps(response), FULL);
    expect(result.httpRefusal).toEqual({ status: 400, bodyState: 'truncated' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('times out and cancels a never-ending refusal body within the diagnostic budget', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 400 });
    const pending = probeAccountCapacity(acct('hung-body'), refusalDeps(response), FULL);
    await vi.advanceTimersByTimeAsync(CAPACITY_PROBE_REFUSAL_TIMEOUT_MS);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: 400, unwalls: false, httpRefusal: { bodyState: 'timed-out' } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('retains HTTP status when a refusal body cannot be read', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('body failed')); } }), { status: 401 });
    const result = await probeAccountCapacity(acct('unreadable'), refusalDeps(response), FULL);
    expect(result).toMatchObject({ ok: false, status: 401, httpRefusal: { bodyState: 'unavailable' } });
  });

  it('limits refusal reading to the remaining account deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 400 });
    const pending = probeAccountCapacity(acct('short-deadline'), {
      ...refusalDeps(response), deadlineAt: Date.now() + 25,
    }, FULL);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ ok: false, status: 400, httpRefusal: { bodyState: 'timed-out' } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accepts authoritative headers without waiting for a hanging HTTP error body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 429, headers: { 'anthropic-ratelimit-unified-7d-utilization': '1' },
    });
    const result = await probeAccountCapacity(acct('quota'), refusalDeps(response), FULL);
    expect(result).toMatchObject({ ok: true, status: 429, windows: { utilization7d: 1 }, unwalls: false });
    expect(result.httpRefusal).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves explicit Codex credits=true on a 429 response', async () => {
    const result = await probeAccountCapacity(
      acct('codex-credits'),
      okDeps({
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-credits-has-credits': 'True',
        'x-codex-credits-balance': '50000',
      }, 429),
      FULL,
    );
    expect(result).toMatchObject({
      ok: true,
      status: 429,
      windows: {
        utilization7d: 1,
        usageCreditsAvailable: true,
        creditBalance: { amount: 50000, unit: 'credits', source: 'codex', unlimited: false },
      },
      unwalls: false,
    });
  });

  it('continues to sibling egress after a bounded refusal and discards it on success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'route refused' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.1' } }));
    const result = await probeAccountCapacity(acct('sibling', { utilization7d: 1 }, { egressPool: [{}, {}] }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveToken: async () => 'test-credential-12345', buildDispatcher: async () => undefined,
    }, FULL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, status: 200, unwalls: true });
    expect(result.httpRefusal).toBeUndefined();
  });

  it('bounds a hanging credential resolution to the account deadline', async () => {
    vi.useFakeTimers();
    const pending = probeAccountCapacity(
      acct('hung-credential', { utilization7d: 1.0 }),
      {
        resolveToken: () => new Promise<string>(() => undefined),
        buildDispatcher: async () => undefined,
      },
      FULL,
    );

    await vi.advanceTimersByTimeAsync(CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      accountId: 'hung-credential',
      attempted: true,
      ok: false,
      windows: {},
      unwalls: false,
    });
    expect(result.error).toBe(`${CAPACITY_PROBE_TIMEOUT_ERROR} during credential resolution`);
  });

  it('bounds a hanging dispatcher construction to the remaining account deadline', async () => {
    vi.useFakeTimers();
    const pending = probeAccountCapacity(
      acct('hung-dispatcher', { utilization7d: 1.0 }),
      {
        resolveToken: async () => 'tok',
        buildDispatcher: () => new Promise<undefined>(() => undefined),
      },
      FULL,
    );

    await vi.advanceTimersByTimeAsync(CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      accountId: 'hung-dispatcher',
      attempted: true,
      ok: false,
      windows: {},
      unwalls: false,
    });
    expect(result.error).toBe(`default-egress: ${CAPACITY_PROBE_TIMEOUT_ERROR} during egress dispatcher`);
  });

  it('reads a 200 response`s unified headers and reports the unwall', async () => {
    const a = acct('walled', { utilization7d: 1.0, windowResetAt7d: 999 });
    const r = await probeAccountCapacity(a, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.04' }), FULL);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.windows.utilization7d).toBe(0.04);
    expect(r.before.utilization7d).toBe(1.0);
    expect(r.unwalls).toBe(true);
  });

  it('treats a 429 as SIGNAL, not failure — it confirms a real wall and carries the true reset', async () => {
    const a = acct('walled', { utilization7d: 1.0 });
    const r = await probeAccountCapacity(
      a,
      okDeps(
        { 'anthropic-ratelimit-unified-7d-utilization': '1.0', 'anthropic-ratelimit-unified-7d-reset': '1784048400' },
        429,
      ),
      FULL,
    );
    expect(r.ok).toBe(true); // a reading was obtained
    expect(r.status).toBe(429);
    expect(r.unwalls).toBe(false); // ...and it CONFIRMS the wall
    expect(r.windows.windowResetAt7d).toBe(1784048400_000);
  });

  it('a transport failure is captured, non-fatal, and NEVER unwalls', async () => {
    const a = acct('walled', { utilization7d: 1.0 });
    const r = await probeAccountCapacity(
      a,
      {
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED via proxy');
        }) as unknown as typeof fetch,
        resolveToken: async () => 'tok',
        buildDispatcher: async () => undefined,
      },
      FULL,
    );
    expect(r.ok).toBe(false);
    expect(r.unwalls).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(r.before.utilization7d).toBe(1.0); // before-state still reported for the evidence table
  });

  it('fails over from a dead pool head to a usable sibling egress', async () => {
    const a = acct(
      'walled',
      { utilization7d: 1.0 },
      { egressPool: [{ proxyUrl: 'http://dead:3128' }, {}] },
    );
    const seen: string[] = [];
    let route = '';
    const r = await probeAccountCapacity(
      a,
      {
        resolveToken: async () => 'tok',
        buildDispatcher: async (eg) => {
          route = eg?.proxyUrl ?? 'default-egress';
          seen.push(route);
          return route;
        },
        fetchImpl: (async () => {
          if (route === 'http://dead:3128') {
            throw Object.assign(new TypeError('fetch failed'), {
              cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
            });
          }
          return new Response('{}', {
            status: 429,
            headers: {
              'anthropic-ratelimit-unified-7d-utilization': '1.0',
              'anthropic-ratelimit-unified-7d-reset': '1784048400',
            },
          });
        }) as unknown as typeof fetch,
      },
      FULL,
    );
    expect(seen).toEqual(['http://dead:3128', 'default-egress']);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(429);
    expect(r.windows.utilization7d).toBe(1);
    expect(r.unwalls).toBe(false);
  });

  it('a credential-resolve failure is captured per-account, not thrown', async () => {
    const r = await probeAccountCapacity(
      acct('bad-cred', { utilization7d: 1.0 }),
      {
        fetchImpl: fakeFetch({}),
        resolveToken: async () => {
          throw new Error('dead credential');
        },
        buildDispatcher: async () => undefined,
      },
      FULL,
    );
    expect(r.ok).toBe(false);
    expect(r.unwalls).toBe(false);
    expect(r.error).toMatch(/dead credential/);
  });

  it('a 200 with NO unified header is not a usable reading', async () => {
    const r = await probeAccountCapacity(acct('quiet', { utilization7d: 1.0 }), okDeps({ 'content-type': 'application/json' }), FULL);
    expect(r.ok).toBe(false);
    expect(r.unwalls).toBe(false);
    expect(r.error).toMatch(/no anthropic-ratelimit-unified/);
  });

  it('sends a minimal 1-token request and authenticates with the account bearer + oauth beta', async () => {
    const f = fakeFetch({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' });
    await probeAccountCapacity(acct('a'), { fetchImpl: f, resolveToken: async () => 'TOK', buildDispatcher: async () => undefined }, FULL);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer TOK');
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(JSON.parse(init.body as string).max_tokens).toBe(1);
  });
});

describe('probeCapacityForAccounts', () => {
  it('bounds the whole sweep and emits deterministic no-reading rows for accounts not started', async () => {
    vi.useFakeTimers();
    const accounts = ['a', 'b', 'c', 'd', 'e'].map((id) => acct(id, { utilization7d: 1.0 }));
    const pending = probeCapacityForAccounts(
      accounts,
      { timeoutMs: 1_000 },
      {
        resolveToken: () => new Promise<string>(() => undefined),
        buildDispatcher: async () => undefined,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pending;

    expect(out.map((result) => result.accountId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.slice(0, 3).every((result) => result.attempted === true)).toBe(true);
    expect(out.slice(0, 3).every((result) => result.error === `${CAPACITY_PROBE_TIMEOUT_ERROR} during credential resolution`)).toBe(true);
    expect(out.slice(3)).toEqual([
      expect.objectContaining({
        accountId: 'd',
        attempted: false,
        ok: false,
        windows: {},
        before: storedWindows(accounts[3]),
        unwalls: false,
        error: CAPACITY_PROBE_NOT_STARTED_ERROR,
      }),
      expect.objectContaining({
        accountId: 'e',
        attempted: false,
        ok: false,
        windows: {},
        before: storedWindows(accounts[4]),
        unwalls: false,
        error: CAPACITY_PROBE_NOT_STARTED_ERROR,
      }),
    ]);
  });

  it('skips non-claude providers (codex has no unified-window dialect)', async () => {
    const accounts = [acct('claude-a'), acct('codex-a', {}, { provider: 'codex' })];
    const out = await probeCapacityForAccounts(accounts, {}, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' }));
    expect(out.map((r) => r.accountId)).toEqual(['claude-a']);
  });

  it('walledOnly probes ONLY the walled accounts', async () => {
    const accounts = [acct('healthy', { utilization7d: 0.2 }), acct('walled', { utilization7d: 1.0 })];
    const out = await probeCapacityForAccounts(accounts, { walledOnly: true }, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.02' }));
    expect(out.map((r) => r.accountId)).toEqual(['walled']);
    expect(out[0].unwalls).toBe(true);
  });

  it('one account failing never fails the sweep — N accounts in, N rows out', async () => {
    const accounts = [acct('good', { utilization7d: 1.0 }), acct('bad', { utilization7d: 1.0 })];
    let call = 0;
    const out = await probeCapacityForAccounts(
      accounts,
      {},
      {
        resolveToken: async () => 'tok',
        buildDispatcher: async () => undefined,
        fetchImpl: (async () => {
          if (call++ === 1) throw new Error('boom');
          return new Response('{}', { status: 200, headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.01' } });
        }) as unknown as typeof fetch,
      },
    );
    expect(out).toHaveLength(2);
    expect(out.filter((r) => r.ok)).toHaveLength(1);
    expect(out.filter((r) => !r.ok)[0].error).toMatch(/boom/);
  });

  it('returns rows in stable input order despite bounded-concurrency fan-out', async () => {
    const accounts = ['a', 'b', 'c', 'd', 'e'].map((id) => acct(id));
    const out = await probeCapacityForAccounts(accounts, {}, okDeps({ 'anthropic-ratelimit-unified-7d-utilization': '0.1' }));
    expect(out.map((r) => r.accountId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

// ---------------------------------------------------------------------------
// WI-38582 — the codex (ChatGPT-subscription) capacity dialect
// ---------------------------------------------------------------------------

/** A codex-cli account row (ChatGPT subscription served via OAuth home). */
const codexAcct = (id: string, rate: Partial<ClaudeAccount['rate']> = {}): ClaudeAccount =>
  acct(id, rate, { provider: 'codex', credentialRef: `codex-cli:/tmp/${id}-home` } as Partial<ClaudeAccount>);

const codexDeps = (headers: Record<string, string>, status = 200) => ({
  fetchImpl: fakeFetch(headers, status),
  resolveCodexAuth: async () => ({ accessToken: 'codex-tok', accountId: 'acc-123' }),
  buildDispatcher: async () => undefined,
});

describe('parseCapacityHeaders — codex dialect (WI-38582)', () => {
  it('stamps the METER: a Luna reserve reading is bucket base_model_inference, never premium (EI-22103680502746318)', () => {
    // The exact shape a `model:'gpt-reserve'` probe returns on a weekly-exhausted account: the
    // reserve bucket has budget while the premium meter (not on this response) is at 1.00.
    expect(
      parseCapacityHeaders({
        'x-codex-active-limit': 'base_model_inference',
        'x-base-model-inference-primary-used-percent': '4',
        'x-base-model-inference-primary-window-minutes': '10080',
        'x-base-model-inference-primary-reset-at': '1787249088',
      }),
    ).toEqual({ utilization7d: 0.04, windowResetAt7d: 1787249088_000, bucket: 'base_model_inference' });
  });

  it('maps a PRO plan (primary IS the weekly window, no secondary) into the 7d slot by window length', () => {
    expect(
      parseCapacityHeaders({
        'x-codex-primary-used-percent': '13',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': '1787201493',
        'x-codex-secondary-used-percent': '0',
        'x-codex-secondary-window-minutes': '0',
        'x-codex-secondary-reset-at': '',
      }),
    ).toEqual({ utilization7d: 0.13, windowResetAt7d: 1787201493_000, bucket: 'premium' });
  });

  it('maps a PLUS-shaped plan (primary 5h, secondary weekly) into both slots', () => {
    expect(
      parseCapacityHeaders({
        'x-codex-primary-used-percent': '42',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1787201493',
        'x-codex-secondary-used-percent': '7',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1787249088',
      }),
    ).toEqual({
      utilization: 0.42,
      windowResetAt: 1787201493_000,
      utilization7d: 0.07,
      windowResetAt7d: 1787249088_000,
      bucket: 'premium',
    });
  });

  it('falls back to reset-after-seconds when reset-at is absent', () => {
    const out = parseCapacityHeaders({
      'x-codex-primary-used-percent': '50',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-primary-reset-after-seconds': '3600',
    });
    expect(out.utilization7d).toBe(0.5);
    expect(out.windowResetAt7d).toBeGreaterThan(Date.now());
    expect(out.windowResetAt7d).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1_000);
  });

  it('prefers the Anthropic dialect when both are present (never mixes interpretations)', () => {
    expect(
      parseCapacityHeaders({
        'anthropic-ratelimit-unified-7d-utilization': '0.19',
        'x-codex-primary-used-percent': '99',
        'x-codex-primary-window-minutes': '10080',
      }),
    ).toEqual({ utilization7d: 0.19 });
  });
});

describe('probeCodexAccountCapacity (WI-38582)', () => {
  it('reports revoked authentication before capacity headers and stops retrying the credential', async () => {
    const token = 'test-codex-secret-123456';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'token_revoked', message: `Token ${token} was revoked` },
    }), { status: 401, headers: { 'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '10080' } }));
    const account = { ...codexAcct('revoked'), egressPool: [{}, { proxyUrl: 'http://other:3128' }] };
    const out = await probeCodexAccountCapacity(account, {
      ...codexDeps({}), fetchImpl, resolveCodexAuth: async () => ({ accessToken: token, accountId: 'acc' }),
    });
    expect(out).toMatchObject({ ok: false, status: 401, authentication: 'relink-required', windows: {}, unwalls: false,
      httpRefusal: { bodyState: 'parsed', errorCode: 'token_revoked' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it('distinguishes an unstructured authentication refusal from confirmed relink necessity', async () => {
    const out = await probeCodexAccountCapacity(codexAcct('unauthorized'), {
      ...codexDeps({}), fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
    });
    expect(out).toMatchObject({ ok: false, status: 401, authentication: 'refused', windows: {}, unwalls: false,
      httpRefusal: { bodyState: 'unstructured' } });
  });

  it('reports invalidated refresh credentials without starting an upstream model request', async () => {
    const fetchImpl = vi.fn();
    const out = await probeCodexAccountCapacity(codexAcct('invalidated'), {
      ...codexDeps({}), fetchImpl,
      resolveCodexAuth: async () => { throw new Error('codex-oauth-proxy: token refresh failed 401 {"error":"refresh_token_invalidated"}'); },
    });
    expect(out).toMatchObject({ ok: false, authentication: 'relink-required', windows: {}, unwalls: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps model refusal separate from authentication failure', async () => {
    const out = await probeCodexAccountCapacity(codexAcct('model'), {
      ...codexDeps({}), fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 400 }),
    });
    expect(out).toMatchObject({ ok: false, status: 400, httpRefusal: { errorCode: 'model_not_found' } });
    expect(out).not.toHaveProperty('authentication');
  });

  it('records the x-codex-* reading off a 200 and reports ok', async () => {
    const out = await probeCodexAccountCapacity(
      codexAcct('cx'),
      codexDeps({
        'x-codex-primary-used-percent': '13',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': '1787201493',
      }),
      FULL,
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.windows).toEqual({ utilization7d: 0.13, windowResetAt7d: 1787201493_000, bucket: 'premium' });
  });

  it('treats a headerless response as no-reading (never invents a window)', async () => {
    const out = await probeCodexAccountCapacity(codexAcct('cx'), codexDeps({}), FULL);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no x-codex-\* rate-limit header/);
  });

  it('refuses a bearer codex account (no codex-cli home) with a legible error', async () => {
    const bearer = acct('cx-bearer', {}, { provider: 'codex', credentialRef: 'bearer:sk-abc' } as Partial<ClaudeAccount>);
    const out = await probeCodexAccountCapacity(bearer, codexDeps({}), FULL);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no codex-cli:<home> credentialRef/);
  });

  it('proves an unwall when upstream reads materially below a stored full window', async () => {
    const out = await probeCodexAccountCapacity(
      codexAcct('cx', { utilization7d: 1, utilizationAt: 1 }),
      codexDeps({
        'x-codex-primary-used-percent': '20',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': '1787201493',
      }),
      FULL,
    );
    expect(out.ok).toBe(true);
    expect(out.unwalls).toBe(true);
  });
});

describe('probeCapacityForAccounts — codex routing (WI-38582)', () => {
  it('probes codex-cli accounts through the codex path instead of skipping them', async () => {
    const out = await probeCapacityForAccounts(
      [codexAcct('cx')],
      {},
      codexDeps({
        'x-codex-primary-used-percent': '13',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': '1787201493',
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(out[0].windows.utilization7d).toBe(0.13);
  });

  it('still skips bearer-only codex accounts (no subscription window to probe)', async () => {
    const bearer = acct('cx-bearer', {}, { provider: 'codex', credentialRef: 'bearer:sk-abc' } as Partial<ClaudeAccount>);
    const out = await probeCapacityForAccounts([bearer], {}, codexDeps({}));
    expect(out).toHaveLength(0);
  });
});

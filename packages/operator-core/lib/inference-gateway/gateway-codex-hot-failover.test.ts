import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInferenceGateway, OWNER_HEADER, ROUTED_ACCOUNT_HEADER } from './gateway';
import { createFailoverPool } from './account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import {
  configureGatewayRequestOutcomeStore,
  InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
} from './gateway-request-outcome-store';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;
const homes: string[] = [];

// Owner reports include durable outcomes; unit fixtures must not query PostgreSQL.
beforeEach(() => {
  resetGovernorRegistry();
  configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore());
});

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
  resetGatewayRequestOutcomeStore();
});

async function codexHome(accountId: string): Promise<string> {
  const home = await fs.mkdtemp(join(tmpdir(), `gateway-hot-failover-${accountId}-`));
  homes.push(home);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  await fs.writeFile(join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, refresh_token: `refresh-${accountId}`, account_id: accountId },
  }));
  return home;
}

describe('proxyOpenAi — Codex OAuth reachability and quota failover', () => {
  it.each(['cooldown', 'quota', 'auth', undefined] as const)(
    'stats distinguish a %s park from account usage exhaustion', async cause => {
      const pool = createFailoverPool(['chatgpt-a', 'chatgpt-b'].map(accountId => ({
        accountId, token: async () => 'unused',
      })));
      const recovery = Date.now() + 120_000;
      for (const account of pool.entries!()) pool.onExhausted(account.accountId, recovery, undefined, { cause });
      gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
        codexCliPool: pool, codexCliAccounts: () => [], selfHeal: { enabled: false } });
      const port = await gateway.listen(0);
      const stats = await (await fetch('http://127.0.0.1:' + port + '/stats')).json();
      expect(stats).toMatchObject({ codexHealthyAccounts: 0, codexTotalAccounts: 2,
        codexEarliestRecoveryAt: recovery,
        codexUnserviceableCause: cause === 'cooldown' ? 'temporary-cooldown' : 'accounts-unserviceable' });
    });

  it('an exhausted durable usage window still blocks an account with a cooldown park', async () => {
    const pool = createFailoverPool([{ accountId: 'chatgpt-a', token: async () => 'unused' }]);
    pool.onExhausted('chatgpt-a', Date.now() + 15_000, undefined, { cause: 'cooldown' });
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
      codexCliPool: pool, codexCliAccounts: () => [], selfHeal: { enabled: false } });
    gateway.setAccountRateHints([{ accountId: 'chatgpt-a', utilization7d: 1,
      windowResetAt7d: Date.now() + 3600_000 }]);
    const port = await gateway.listen(0);
    const stats = await (await fetch('http://127.0.0.1:' + port + '/stats')).json();
    expect(stats).toMatchObject({ codexHealthyAccounts: 0, codexUnserviceableCause: 'accounts-unserviceable' });
  });

  it.each([false, true])('surfaces a generic context SSE error to the native client (after output: %s)', async afterOutput => {
    const account = { accountId: 'context-account', home: await codexHome('context-account') };
    const output = afterOutput ? 'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'visible once' }) + '\n\n' : '';
    const wire = output + 'data: ' + JSON.stringify({ type: 'error', error: {
      code: 'context_length_exceeded', message: 'context window exceeded',
    } }) + '\n\n';
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ async start(controller) {
      if (afterOutput) {
        controller.enqueue(new TextEncoder().encode(output));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      controller.enqueue(new TextEncoder().encode(wire.slice(output.length))); controller.close();
    } }), { status: 200 })) as typeof fetch;
    gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused', fetchImpl,
      codexCliAccounts: () => [account], codexOAuthProxy: true, selfHeal: { enabled: false } });
    const port = await gateway.listen(0);
    const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', { method: 'POST',
      headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'context-owner' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true }) });
    const result = await response.text();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (!afterOutput) {
      expect(response.status).toBe(400);
      expect(JSON.parse(result).error.code).toBe('context_length_exceeded');
    } else {
      expect(response.status).toBe(200);
      const frames = result.split('\n\n').filter(Boolean).map(frame =>
        JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n')));
      expect(frames.filter(frame => frame.type === 'response.output_text.delta')).toHaveLength(1);
      expect(frames.at(-1)).toMatchObject({ type: 'error', error: {
        code: 'context_length_exceeded', message: 'context window exceeded',
      } });
      expect(frames.some(frame => frame.type === 'response.failed')).toBe(false);
      expect(frames.some(frame => frame.type === 'response.completed')).toBe(false);
    }
  });
  it('safely fails over a prelude-only EOF before exposing a response', async () => {
    const accounts = [
      { accountId: 'chatgpt-a', home: await codexHome('chatgpt-a') },
      { accountId: 'chatgpt-b', home: await codexHome('chatgpt-b') },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      const event = account === 'chatgpt-a'
        ? { type: 'response.created', response: { id: 'resp_pre_output_eof' } }
        : { type: 'response.completed', response: { id: 'resp_healthy', status: 'completed', output: [] } };
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
          controller.close();
        },
      }), { status: 200 });
    }) as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok', fetchImpl,
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(({ accountId }) => ({ accountId, token: async () => 'unused' }))),
      codexOAuthProxy: true, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'pre-output-eof-owner' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true }),
    });
    const wire = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
    expect(wire).toContain('resp_healthy');
    expect(wire).not.toContain('resp_pre_output_eof');
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-b']);
    const ownerReportResponse = await fetch(
      'http://127.0.0.1:' + port + '/admin/owner-report?owner=pre-output-eof-owner',
    );
    const ownerReport = await ownerReportResponse.json() as {
      requestOutcomes: { rows: Array<{ selectedAccountId: string | null; attemptAccountIds: Array<string | null> }> };
    };
    expect(ownerReport.requestOutcomes.rows).toHaveLength(1);
    expect(ownerReport.requestOutcomes.rows[0]).toMatchObject({
      selectedAccountId: 'chatgpt-b',
      attemptAccountIds: ['chatgpt-a', 'chatgpt-b'],
    });
  });

  it.each([true, false])('returns a truthful terminal after visible-output EOF without replay (provider id known: %s)', async (knownId) => {
    const accounts = [
      { accountId: 'chatgpt-a', home: await codexHome('chatgpt-a') },
      { accountId: 'chatgpt-b', home: await codexHome('chatgpt-b') },
    ];
    const routed: string[] = [];
    const events = [
      ...(knownId ? [{ type: 'response.created', response: { id: 'resp_visible_eof' } }] : []),
      { type: 'response.output_text.delta', delta: 'once-only-visible-output' },
      { type: 'response.output_item.done', item: {
        id: 'tool_item', type: 'function_call', call_id: 'call_once', name: 'once_only_tool', arguments: '{}' },
      },
    ];
    const upstreamWire = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      routed.push(new Headers(init?.headers).get('chatgpt-account-id') ?? '');
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(upstreamWire));
          controller.close();
        },
      }), { status: 200 });
    }) as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok', fetchImpl,
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(({ accountId }) => ({ accountId, token: async () => 'unused' }))),
      codexOAuthProxy: true, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const response = await fetch('http://127.0.0.1:' + port + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'visible-eof-owner' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true }),
    });
    const wire = await response.text();
    const frames = wire.split(/\r?\n\r?\n/).filter(Boolean).map(frame =>
      JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
    expect(routed).toEqual(['chatgpt-a']);
    expect(wire.startsWith(upstreamWire)).toBe(true);
    expect(frames.filter(event => event.type === 'response.output_text.delta')).toHaveLength(1);
    expect(frames.filter(event => event.type === 'response.output_item.done')).toHaveLength(1);
    expect(frames.some(event => event.type === 'response.completed')).toBe(false);
    if (knownId) {
      expect(frames.at(-1)).toMatchObject({ type: 'response.failed', response: {
        id: 'resp_visible_eof', status: 'failed', error: { code: 'server_error', message: expect.stringContaining('EOF') },
      } });
    } else {
      expect(frames.at(-1)).toMatchObject({ type: 'error', error: {
        code: 'server_error', message: expect.stringContaining('EOF'),
      } });
      expect(frames.some(event => event.type === 'response.failed')).toBe(false);
      expect(frames.at(-1)).not.toHaveProperty('response');
    }
    const report = await fetch('http://127.0.0.1:' + port + '/admin/owner-report?owner=visible-eof-owner');
    expect(report.status).toBe(200);
    const owner = await report.json() as { ledger: { upstreamErrors: number; lastStatus: number; recent: unknown[] } };
    expect(owner.ledger.upstreamErrors).toBe(1);
    expect(owner.ledger.lastStatus).toBe(502);
    expect(owner.ledger.recent).toContainEqual(expect.objectContaining({
      kind: 'upstream_error', detail: 'oauth-stream-incomplete', account: 'chatgpt-a',
    }));
  });

  it('moves the next retry off an account whose HTTP-200 stream fails after the prelude lookahead', async () => {
    const accounts = [
      { accountId: 'chatgpt-a', home: await codexHome('chatgpt-a') },
      { accountId: 'chatgpt-b', home: await codexHome('chatgpt-b') },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
          await new Promise((resolve) => setTimeout(resolve, 250));
          const event = account === 'chatgpt-a'
            ? { type: 'response.failed', response: { error: { code: 'server_error', message: 'high demand' } } }
            : { type: 'response.completed', response: { id: 'healthy', status: 'completed', output: [] } };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok', fetchImpl,
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(({ accountId }) => ({ accountId, token: async () => 'unused' }))),
      codexOAuthProxy: true, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    for (const expected of ['high demand', 'response.completed']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'live-overload-session' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true }),
      });
      expect(await response.text()).toContain(expected);
    }
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-b']);
  });

  it('moves a live auto session to a credited account and keeps the new affinity without restarting', async () => {
    const accounts = [
      { accountId: 'chatgpt-a', home: await codexHome('chatgpt-a') },
      { accountId: 'chatgpt-b', home: await codexHome('chatgpt-b') },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      const event = account === 'chatgpt-a'
        ? { type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'usage exhausted', resets_at: Math.floor(Date.now() / 1000) + 3600 } } }
        : { type: 'response.completed', response: { id: 'credit-backed-success', output: [] } };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(account => ({ accountId: account.accountId, token: async () => '' }))),
      codexOAuthProxy: true, fetchImpl, selfHeal: { enabled: false },
    });
    gateway.setAccountRateHints([
      { accountId: 'chatgpt-a', utilization: 0, utilization7d: 0 },
      { accountId: 'chatgpt-b', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000, usageCreditsAvailable: true },
    ]);
    const port = await gateway.listen(0);
    for (const input of ['first turn', 'second turn']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'one-running-session' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input, stream: true }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
      expect(await response.text()).toContain('credit-backed-success');
    }
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-b', 'chatgpt-b']);
    expect(gateway.stats().codex.failovers).toBe(1);
  });

  it('reports an all-account DNS outage separately from a usage wall in /stats', async () => {
    const accountIds = ['chatgpt-a', 'chatgpt-b', 'chatgpt-c'];
    const accounts = await Promise.all(
      accountIds.map(async (accountId) => ({
        accountId,
        home: await codexHome(accountId),
      })),
    );
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND chatgpt.com'), {
          code: 'ENOTFOUND',
        }),
      });
    }) as unknown as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(
        accounts.map((account) => ({
          accountId: account.accountId,
          token: async () => '',
        })),
      ),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
      internalRetryDeadlineMs: 500,
    });
    const port = await gateway.listen(0);
    const response = await fetch(
      "http://127.0.0.1:" + port + "/v1/responses",
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'dns-outage-session' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'network check', stream: true }),
      },
    );
    await response.text();

    expect(new Set(routed)).toEqual(new Set(accountIds));
    const ownerReportResponse = await fetch(
      'http://127.0.0.1:' + port + '/admin/owner-report?owner=dns-outage-session',
    );
    const ownerReport = await ownerReportResponse.json() as {
      requestOutcomes: { rows: Array<{ selectedAccountId: string | null; attemptAccountIds: Array<string | null> }> };
    };
    expect(ownerReport.requestOutcomes.rows).toHaveLength(1);
    expect(ownerReport.requestOutcomes.rows[0]?.attemptAccountIds).toEqual(routed);
    expect(ownerReport.requestOutcomes.rows[0]?.selectedAccountId).toBe(routed[routed.length - 1]);

    const statsResponse = await fetch("http://127.0.0.1:" + port + "/stats");
    expect(statsResponse.status).toBe(200);
    const stats = await statsResponse.json() as {
      codex: { upstream429: number };
      codexReachability: {
        unreachable: boolean;
        accountsFailingSinceResponse: number;
        lastTransportFailureKind: string | null;
      };
      codexUnserviceableCause: string | null;
    };
    expect(stats.codex.upstream429).toBe(0);
    expect(stats.codexUnserviceableCause).toBe('upstream-unreachable');
    expect(stats.codexReachability).toMatchObject({
      unreachable: true,
      accountsFailingSinceResponse: 3,
      lastTransportFailureKind: 'dns',
    });
  });

  // WI-6554700010029748: codexHealthyAccounts is model-blind. Live 2026-10-26: every serviceable
  // account refused gpt-5.5, /stats still read healthy > 0, psu's preflight let gpt-5.5 sessions
  // launch, and each model call came back a 429 after failing over across the pool.
  it.each([
    { bRefuses: true, expected: 0 },
    { bRefuses: false, expected: 1 },
  ])('/stats publishes the per-model serviceable count when accounts refuse a model (b refuses: $bRefuses)', async ({ bRefuses, expected }) => {
    const accounts = await Promise.all(['chatgpt-a', 'chatgpt-b'].map(async accountId => ({ accountId, home: await codexHome(accountId) })));
    const refusal = `{"detail":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."}`;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      if (account === 'chatgpt-a' || bRefuses) {
        return new Response(refusal, { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const event = { type: 'response.completed', response: { id: 'served', output: [] } };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(({ accountId }) => ({ accountId, token: async () => '' }))),
      codexOAuthProxy: true, fetchImpl, selfHeal: { enabled: false },
    });
    const port = await gateway.listen(0);
    const before = await (await fetch(`http://127.0.0.1:${port}/stats`)).json() as { codexServiceableByModel?: Record<string, number> };
    // No live refusal yet: the provider-wide count describes every model, so no map is published.
    expect(before.codexServiceableByModel).toBeUndefined();
    for (const owner of ['refusal-session-1', 'refusal-session-2']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', [OWNER_HEADER]: owner },
        body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
      });
      await response.text();
    }
    const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json() as {
      codexHealthyAccounts: number;
      codexServiceableByModel?: Record<string, number>;
      codexModelRefusals: Array<{ accountId: string; model: string }>;
    };
    // The refusal parks nothing: both accounts stay serviceable provider-wide…
    expect(stats.codexHealthyAccounts).toBe(2);
    expect(stats.codexModelRefusals.map(r => r.accountId).sort()).toEqual(bRefuses ? ['chatgpt-a', 'chatgpt-b'] : ['chatgpt-a']);
    // …but only the non-refusing ones can serve THIS model.
    expect(stats.codexServiceableByModel).toEqual({ 'gpt-5.5': expected });
  });
});

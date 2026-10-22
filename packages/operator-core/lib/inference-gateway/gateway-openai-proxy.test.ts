/**
 * gateway-openai-proxy.test.ts — the Codex / OpenAI-compatible proxy path
 * (`proxyOpenAi`, the `/v1/responses` route). gateway.test.ts has a SINGLE
 * codex test (429 rotation); this file exercises the path thoroughly because a
 * parallel-to-Claude code path is exactly where behavior silently drifts:
 *
 *   - no-codex-pool 503, and the bearer/header discipline (codex bearer injected,
 *     client x-api-key/authorization stripped, accept-encoding forced to identity,
 *     and — distinct from the Claude path — NO anthropic oauth beta injected);
 *   - the RESILIENCE-PARITY rotations the 2026-06-22 audit added: a 429, a
 *     token-read failure → rotate to another Codex account + retry (route around,
 *     don't surface), and the single-account cases that must FORWARD/ERROR rather
 *     than hang or loop;
 *   - route isolation: /v1/responses → the OpenAI upstream + codex creds, while
 *     /v1/messages → the Claude upstream + claude creds, on the same gateway.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createInferenceGateway,
  ACCOUNT_HEADER,
  ACCOUNT_PIN_HEADER,
  OWNER_HEADER,
  PIN_YIELDED_HEADER,
  POOL_RECOVERY_AT_HEADER,
  RETRIES_EXHAUSTED_HEADER,
  ROUTED_ACCOUNT_HEADER,
  resolveCodexOAuthNonStreamTimeoutMs,
} from './gateway';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import {
  configureGatewayRequestOutcomeStore,
  InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
} from './gateway-request-outcome-store';
import { RateLimitGovernor, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { CODEX_SAFE_DEFAULT_MODEL } from '../model-context-budget.mjs';
/** Managed Codex default id (the model-less fallback), derived so a deliberate default bump cannot strand these assertions. */
const DEFAULT_CODEX_ID = CODEX_SAFE_DEFAULT_MODEL.split(':')[0];

interface Upstream {
  server: http.Server;
  base: string;
  last: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
  close: () => Promise<void>;
}

async function startUpstream(
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<Upstream> {
  const state: Upstream['last'] = { headers: {}, body: '' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      state.method = req.method;
      state.url = req.url;
      state.headers = req.headers;
      state.body = Buffer.concat(chunks).toString('utf8');
      reply(req, res, state.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    last: state,
    close: () =>
      new Promise((r) => {
        // Destroy any lingering (e.g. deliberately-stalled) connections so close() can't hang the afterEach.
        (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

const codexAcct = (id: string, token?: () => Promise<string>): ActiveAccount => ({
  accountId: id,
  token: token ?? (async () => `${id}-tok`),
  invalidateToken: () => {},
});

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let openaiUpstream: Upstream | undefined;
let claudeUpstream: Upstream | undefined;
let port = 0;
const tempCodexHomes: string[] = [];

// Codex attempts use the shared backend registry, so each gateway fixture needs
// fresh pacing/penalty buckets as well as an isolated durable-outcome store.
beforeEach(() => {
  resetGovernorRegistry();
  configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore());
});

afterEach(async () => {
  vi.useRealTimers();
  await gw?.close();
  await openaiUpstream?.close();
  await claudeUpstream?.close();
  gw = undefined;
  openaiUpstream = undefined;
  claudeUpstream = undefined;
  await Promise.all(tempCodexHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  resetGovernorRegistry();
  resetGatewayRequestOutcomeStore();
});

const freshJwt = () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
};

async function makeCodexHome(accountId: string, withAuth = true): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-chatgpt-${accountId}-`));
  tempCodexHomes.push(home);
  if (withAuth) {
    await fs.writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: freshJwt(), refresh_token: `refresh-${accountId}`, account_id: accountId },
      }),
    );
  }
  return home;
}

/** Boot a gateway with a Codex pool + OpenAI upstream. `codexAccounts` defaults to two;
 *  `gwOpts` overrides createInferenceGateway deps (e.g. the stall-timeout knobs). */
async function bootCodex(
  openaiReply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  codexAccounts: ActiveAccount[] = [codexAcct('cdx-1'), codexAcct('cdx-2')],
  gwOpts: Partial<Parameters<typeof createInferenceGateway>[0]> = {},
) {
  openaiUpstream = await startUpstream(openaiReply);
  const codexPool = createFailoverPool(codexAccounts);
  gw = createInferenceGateway({
    accountId: 'claude-acct',
    // The Claude side is never contacted in codex-only tests; point it at the same
    // loopback host so nothing escapes to a real upstream if a path is mis-routed.
    upstreamBase: openaiUpstream.base,
    openaiUpstreamBase: openaiUpstream.base,
    codexPool,
    token: async () => 'claude-tok',
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 80,
    selfHeal: { enabled: false },
    ...gwOpts,
  });
  port = await gw.listen(0);
}

const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
const postResponses = (body: unknown, headers: Record<string, string> = {}) =>
  ask('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'resp_1', ok: true }));
};

it('refuses a bound Codex operation before upstream work while actual provider evidence is unavailable', async () => {
  let upstreamCalls = 0;
  let backendRead: string | undefined;
  await bootCodex((_req, res) => {
    upstreamCalls++;
    ok(_req, res);
  }, [codexAcct('cdx-1')], {
    readAcceptedOperationModelPolicy: async (ownerId, backend) => {
      expect(ownerId).toBe('operation-worker');
      backendRead = backend;
      return { status: 'bound', policy: {
        mode: 'exact', models: ['gpt-5.6-sol'], effort: 'high', onUnavailable: 'fail',
      }, attestation: {
        operationReceiptId: 12, advSessionId: 34, nativeSessionId: 'native-codex-worker',
        workspaceId: 'default', ownerId, harnessSlug: 'papercup',
        workItemId: 'WI-codex-1', operationId: 'run', specificationRevision: 'a'.repeat(64),
      } };
    },
  });
  const response = await postResponses({ model: 'gpt-5.6-sol', reasoning: { effort: 'high' },
    input: 'x' }, { [OWNER_HEADER]: 'operation-worker' });
  expect(response.status).toBe(503);
  expect(backendRead).toBe('codex');
  expect(upstreamCalls).toBe(0);
});

const boundCodexRead = async (ownerId: string) => ({
  status: 'bound' as const,
  policy: { mode: 'exact' as const, models: ['gpt-5.6-sol'], effort: 'high', onUnavailable: 'fail' as const },
  attestation: {
    operationReceiptId: 12, advSessionId: 34, nativeSessionId: 'native-codex-worker',
    workspaceId: 'default', ownerId, harnessSlug: 'papercup', workItemId: 'WI-codex-1',
    operationId: 'run', specificationRevision: 'a'.repeat(64),
  },
});
const boundCodexRequest = { model: 'gpt-5.6-sol', reasoning: { effort: 'high' }, input: 'x', stream: true };
const completedCodexResponse = (model = 'gpt-5.6-sol', usage: unknown = {
  input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 },
}) => ({ type: 'response.completed', response: { id: 'resp_bound_codex', model, usage, output: [] } });

describe('accepted Codex provider attestation', () => {
  it('records a bearer provider completion before exposing its successful stream', async () => {
    const record = vi.fn(async (..._args: unknown[]) => undefined);
    const wire = `data: ${JSON.stringify(completedCodexResponse())}\n\ndata: [DONE]\n\n`;
    await bootCodex((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(wire);
    }, [codexAcct('cdx-1')], {
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
    });
    const response = await postResponses(boundCodexRequest, { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      backend: 'codex', provider: 'openai', requestedModel: 'gpt-5.6-sol',
      actualModel: 'gpt-5.6-sol', forwardedEffort: 'high', effortSource: 'forwarded-request',
      providerResponseId: 'resp_bound_codex',
      usage: { inputTokens: 12, inputTokenBasis: 'inclusive', outputTokens: 3, cacheReadTokens: 2 },
    });
  });

  it('refuses an observed auxiliary native thread before upstream work', async () => {
    let upstreamCalls = 0;
    const record = vi.fn(async () => undefined);
    await bootCodex((_req, res) => {
      upstreamCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completedCodexResponse().response));
    }, [codexAcct('cdx-1')], {
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
    });
    const response = await postResponses({
      ...boundCodexRequest,
      client_metadata: {
        'x-codex-turn-metadata': JSON.stringify({
          session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          thread_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          turn_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      },
    }, { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(403);
    expect(upstreamCalls).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('accepts an alias-equivalent provider model under the exact policy', async () => {
    const record = vi.fn(async () => undefined);
    await bootCodex((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completedCodexResponse().response));
    }, [codexAcct('cdx-1')], {
      readAcceptedOperationModelPolicy: async (ownerId) => ({
        ...await boundCodexRead(ownerId),
        policy: { mode: 'exact', models: ['sol:high'], effort: 'high', onUnavailable: 'fail' },
      }),
      recordAcceptedOperationModelAttestation: record,
    });
    const response = await postResponses({ model: 'sol:high', input: 'x', stream: false },
      { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it.each([
    ['off-policy model', completedCodexResponse('gpt-5.6-luna')],
    ['missing provider usage', completedCodexResponse('gpt-5.6-sol', null)],
    ['provider-reported effort mismatch', { ...completedCodexResponse(), response: {
      ...completedCodexResponse().response, reasoning: { effort: 'low' },
    } }],
  ])('refuses a bearer %s before exposing a successful head', async (_case, completion) => {
    const record = vi.fn(async () => undefined);
    await bootCodex((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
    }, [codexAcct('cdx-1')], {
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
    });
    const response = await postResponses(boundCodexRequest, { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(502);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an unrecordable bearer completion and an off-policy request before upstream work', async () => {
    let calls = 0;
    await bootCodex((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completedCodexResponse().response));
    }, [codexAcct('cdx-1')], {
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: async () => { throw new Error('event log unavailable'); },
    });
    const rejected = await postResponses({ ...boundCodexRequest, model: 'gpt-5.6-luna' },
      { [OWNER_HEADER]: 'operation-worker' });
    expect(rejected.status).toBe(403);
    expect(calls).toBe(0);
    const response = await postResponses({ ...boundCodexRequest, stream: false },
      { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(502);
    expect(calls).toBe(1);
  });

  it('records an OAuth provider completion before exposing its successful stream', async () => {
    const home = await makeCodexHome('chatgpt-bound');
    const cliAccounts = [{ accountId: 'chatgpt-bound', home }];
    const record = vi.fn(async () => undefined);
    const wire = `data: ${JSON.stringify(completedCodexResponse())}\n\ndata: [DONE]\n\n`;
    const cliRun = vi.fn(async () => ({ text: 'synthetic', inputTokens: 1, outputTokens: 1 }));
    const fetchImpl = vi.fn(async () => new Response(wire,
      { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((account) => ({
        accountId: account.accountId, token: async () => '',
      }))),
      codexCliRun: cliRun, codexOAuthProxy: true, fetchImpl,
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    const response = await postResponses(boundCodexRequest, { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(wire);
    expect(record).toHaveBeenCalledOnce();
    expect(cliRun).not.toHaveBeenCalled();
  });

  it('attests OAuth non-stream aggregation and refuses a synthetic CLI fallback', async () => {
    const home = await makeCodexHome('chatgpt-bound');
    const cliAccounts = [{ accountId: 'chatgpt-bound', home }];
    const record = vi.fn(async () => undefined);
    const cliRun = vi.fn(async () => ({ text: 'synthetic', inputTokens: 1, outputTokens: 1 }));
    const completion = completedCodexResponse();
    const fetchImpl = vi.fn(async () => new Response(
      `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((account) => ({
        accountId: account.accountId, token: async () => '',
      }))),
      codexCliRun: cliRun, codexOAuthProxy: true, fetchImpl,
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    const nonstream = await postResponses({ ...boundCodexRequest, stream: false },
      { [OWNER_HEADER]: 'operation-worker' });
    expect(nonstream.status).toBe(200);
    expect(await nonstream.json()).toMatchObject(completion.response);
    expect(record).toHaveBeenCalledOnce();
    expect(cliRun).not.toHaveBeenCalled();
    await gw.close();
    gw = undefined;

    gw = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((account) => ({
        accountId: account.accountId, token: async () => '',
      }))),
      codexCliRun: cliRun, codexOAuthProxy: false,
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    const synthetic = await postResponses(boundCodexRequest, { [OWNER_HEADER]: 'operation-worker' });
    expect(synthetic.status).toBe(503);
    expect(cliRun).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
  });

  it.each([true, false])('attests headerless OAuth SSE before exposing stream=%s success', async (stream) => {
    const home = await makeCodexHome('chatgpt-headerless');
    const cliAccounts = [{ accountId: 'chatgpt-headerless', home }];
    const record = vi.fn(async (..._args: unknown[]) => undefined);
    const completion = completedCodexResponse();
    const wire = `event: response.completed\ndata: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`;
    const cliRun = vi.fn(async () => ({ text: 'synthetic', inputTokens: 1, outputTokens: 1 }));
    // A byte body avoids Fetch adding text/plain to a string Response: the real
    // ChatGPT transport can omit Content-Type entirely (WI-284159).
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(Buffer.from(wire)),
      { status: 200 })) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map(account => ({
        accountId: account.accountId, token: async () => '',
      }))),
      codexCliRun: cliRun, codexOAuthProxy: true, fetchImpl,
      readAcceptedOperationModelPolicy: boundCodexRead,
      recordAcceptedOperationModelAttestation: record,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    const response = await postResponses({ ...boundCodexRequest, stream }, { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(stream ? 'text/event-stream' : 'application/json');
    if (stream) expect(await response.text()).toBe(wire);
    else expect(await response.json()).toEqual(completion.response);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[1]).toMatchObject({ actualModel: 'gpt-5.6-sol',
      providerResponseId: 'resp_bound_codex', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(cliRun).not.toHaveBeenCalled();
  });

  it.each([
    ['wait', 429, '30'],
    ['fail', 503, null],
  ] as const)('reports accepted Codex %s policy when the account pool has no route', async (onUnavailable, status, retryAfter) => {
    let upstreamCalls = 0;
    openaiUpstream = await startUpstream((_req, res) => { upstreamCalls++; res.end(); });
    gw = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      upstreamBase: openaiUpstream.base,
      openaiUpstreamBase: openaiUpstream.base,
      readAcceptedOperationModelPolicy: async (ownerId) => ({
        ...await boundCodexRead(ownerId),
        policy: { mode: 'exact', models: ['gpt-5.6-sol'], effort: 'high', onUnavailable },
      }),
      recordAcceptedOperationModelAttestation: async () => undefined,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    const response = await postResponses(boundCodexRequest, { [OWNER_HEADER]: 'operation-worker' });
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe(retryAfter);
    if (onUnavailable === 'fail') expect(response.headers.get('x-should-retry')).toBe('false');
    expect(upstreamCalls).toBe(0);
  });
});

describe('proxyOpenAi — no pool / configuration', () => {
  it('/v1/responses returns a 503 gateway envelope when no Codex pool is configured', async () => {
    openaiUpstream = await startUpstream(ok);
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      upstreamBase: openaiUpstream.base,
      token: async () => 'claude-tok',
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      selfHeal: { enabled: false },
      // no codexPool
    });
    port = await gw.listen(0);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(503);
    const b = (await res.json()) as { gateway?: boolean; error?: { message?: string } };
    expect(b.gateway).toBe(true);
    expect(b.error?.message).toMatch(/no Codex account pool/i);
  });
});

describe('proxyOpenAi — happy path + header discipline', () => {
  it('forwards a 200 with the codex bearer + identity encoding, names the routed account, and does NOT inject the anthropic oauth beta', async () => {
    await bootCodex(ok);
    const res = await postResponses(
      { model: 'gpt-x', input: 'hi' },
      { 'x-api-key': 'sk-strip-me', authorization: 'Bearer client-replace-me', 'anthropic-beta': 'fine-grained-2025' },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);

    const h = openaiUpstream!.last.headers;
    // codex OAuth bearer injected (NOT the client's), client api-key stripped
    expect(h['authorization']).toBe('Bearer cdx-1-tok');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['accept-encoding']).toBe('identity');
    // CRITICAL: the codex path must NOT force the Claude-only oauth-2025-04-20 beta —
    // it would 400 against OpenAI. The client's anthropic-beta is passed through untouched
    // (no oauth- token merged in), unlike the Claude proxy which force-merges it.
    expect(String(h['anthropic-beta'] ?? '')).not.toContain('oauth-2025-04-20');
    // routed-account header names the codex account that served it
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-1');
  });

  it('routes an unpinned bearer request around a projection-known wall after a cold start', async () => {
    await bootCodex(ok, [codexAcct('walled'), codexAcct('healthy')]);
    // The pool cursor starts on `walled` and all live governors are blank, matching a gateway restart.
    // Durable hints must steer the FIRST request to healthy without learning through another 429.
    gw!.setAccountRateHints([
      { accountId: 'walled', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000 },
      { accountId: 'healthy', utilization7d: 0.2, windowResetAt7d: Date.now() + 86_400_000 },
    ]);
    const res = await postResponses({ model: 'gpt-5.6-sol', input: 'cold-start health pick' });
    expect(res.status).toBe(200);
    expect(openaiUpstream!.last.headers['authorization']).toBe('Bearer healthy-tok');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('healthy');
  });

  it('measures an automatic pick that diverges from the best available account without changing routing', async () => {
    const best = codexAcct('best');
    const picked = codexAcct('picked');
    const accounts = [best, picked];
    // A deliberately non-conforming pool that ignores the supplied health key is the observation target:
    // P-007 must REPORT this quality defect, not silently repair it in the telemetry layer.
    const fixedPool: AccountPool = {
      active: () => picked,
      onExhausted: () => null,
      select: (id) => accounts.find((account) => account.accountId === id) ?? null,
      entries: () => accounts,
      peek: () => picked,
      size: () => accounts.length,
      healthyCount: (extra) => accounts.filter((account) => !extra || extra(account.accountId)).length,
    };
    await bootCodex(ok, accounts, { codexPool: fixedPool });
    gw!.setAccountRateHints([
      { accountId: 'best', utilization7d: 0.1, windowResetAt7d: Date.now() + 86_400_000 },
      { accountId: 'picked', utilization7d: 0.8, windowResetAt7d: Date.now() + 86_400_000 },
    ]);

    const res = await postResponses(
      { model: 'gpt-5.6-sol', input: 'measure the picker' },
      { [OWNER_HEADER]: 'su-routing-divergence' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('picked');

    const quality = gw!.stats().routingQuality!;
    expect(quality.automatic).toEqual({ picks: 1, comparablePicks: 1, divergences: 1, divergenceRate: 1 });
    expect(quality.recent).toEqual([
      expect.objectContaining({
        provider: 'codex',
        owner: 'su-routing-divergence',
        selectedAccount: 'picked',
        mode: 'automatic',
        reason: 'health-ranked',
        bestAvailableAccount: 'best',
        divergedFromBest: true,
        includedInAutomaticDivergence: true,
      }),
    ]);
    expect(quality.recent[0]!.selectedScore).toBeGreaterThan(quality.recent[0]!.bestAvailableScore!);
  });

  it('yields a projection-walled bearer SOFT pin before the first attempt, then returns when it recovers', async () => {
    const routed: string[] = [];
    await bootCodex(
      (req, res) => {
        routed.push(String(req.headers.authorization ?? ''));
        ok(req, res);
      },
      [codexAcct('pinned'), codexAcct('healthy')],
    );
    const resetAt = Date.now() + 86_400_000;
    gw!.setAccountRateHints([
      { accountId: 'pinned', utilization7d: 1, windowResetAt7d: resetAt },
      { accountId: 'healthy', utilization7d: 0.2, windowResetAt7d: resetAt },
    ]);

    const yielded = await postResponses(
      { model: 'gpt-5.6-sol', input: 'route around the known wall' },
      { [ACCOUNT_HEADER]: 'pinned' },
    );
    expect(yielded.status).toBe(200);
    expect(routed).toEqual(['Bearer healthy-tok']);
    expect(yielded.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('healthy');
    expect(yielded.headers.get(PIN_YIELDED_HEADER)).toBe('pinned->healthy');

    // The resolver runs per request and never mutates the pin. Clearing the liveness wall
    // therefore returns the very next turn to the original warm credential.
    gw!.setAccountRateHints([]);
    const recovered = await postResponses(
      { model: 'gpt-5.6-sol', input: 'resume the warm pin' },
      { [ACCOUNT_HEADER]: 'pinned' },
    );
    expect(recovered.status).toBe(200);
    expect(routed).toEqual(['Bearer healthy-tok', 'Bearer pinned-tok']);
    expect(recovered.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('pinned');
    expect(recovered.headers.get(PIN_YIELDED_HEADER)).toBeNull();
    const quality = gw!.stats().routingQuality!;
    expect(quality.automatic).toEqual({ picks: 0, comparablePicks: 0, divergences: 0, divergenceRate: null });
    expect(quality.pins).toEqual({
      picks: 2,
      explicitPicks: 2,
      affinityPicks: 0,
      yields: 1,
      yieldRate: 0.5,
    });
    expect(
      quality.recent.map(({ mode, reason, requestedAccount, yieldedFrom }) => ({
        mode,
        reason,
        requestedAccount,
        yieldedFrom,
      })),
    ).toEqual([
      { mode: 'soft-pin', reason: 'pin-yield', requestedAccount: 'pinned', yieldedFrom: 'pinned' },
      { mode: 'soft-pin', reason: 'pin-kept', requestedAccount: 'pinned', yieldedFrom: null },
    ]);
  });

  it('keeps a projection-walled bearer HARD pin strict', async () => {
    await bootCodex(ok, [codexAcct('pinned'), codexAcct('healthy')]);
    gw!.setAccountRateHints([{ accountId: 'pinned', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000 }]);

    const res = await postResponses(
      { model: 'gpt-5.6-sol', input: 'operator accepts the wall' },
      { [ACCOUNT_HEADER]: 'pinned', [ACCOUNT_PIN_HEADER]: 'hard' },
    );
    expect(res.status).toBe(200);
    expect(openaiUpstream!.last.headers.authorization).toBe('Bearer pinned-tok');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('pinned');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBeNull();
  });

  it('reports a liveness yield from an implicit Codex auto-affinity pin', async () => {
    await bootCodex(ok, [codexAcct('warm'), codexAcct('healthy')]);
    const headers = { [OWNER_HEADER]: 'su-affinity-yield' };
    const warm = await postResponses({ model: 'gpt-5.6-sol', input: 'warm this account' }, headers);
    expect(warm.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('warm');

    gw!.setAccountRateHints([
      { accountId: 'warm', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000 },
      { accountId: 'healthy', utilization7d: 0.1, windowResetAt7d: Date.now() + 86_400_000 },
    ]);
    const yielded = await postResponses({ model: 'gpt-5.6-sol', input: 'stay alive' }, headers);
    expect(yielded.status).toBe(200);
    expect(yielded.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('healthy');
    expect(yielded.headers.get(PIN_YIELDED_HEADER)).toBe('warm->healthy');
    expect(gw!.stats().cache.affinity.yields).toBe(1);
  });

  it('forwards the method, path+query, and body verbatim to the OpenAI upstream', async () => {
    await bootCodex(ok);
    const res = await ask('/v1/responses?stream=false&trace=9', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', input: 'forward me' }),
    });
    expect(res.status).toBe(200);
    expect(openaiUpstream!.last.method).toBe('POST');
    expect(openaiUpstream!.last.url).toBe('/v1/responses?stream=false&trace=9');
    expect(JSON.parse(openaiUpstream!.last.body).input).toBe('forward me');
  });

  it('resolves the managed Codex default and preserves an explicit effort before bearer forwarding', async () => {
    await bootCodex(ok);
    const suffixed = await postResponses({ model: 'gpt-5.6-sol:xhigh', input: 'normalize me' });
    expect(suffixed.status).toBe(200);
    expect(JSON.parse(openaiUpstream!.last.body)).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'xhigh' },
      input: 'normalize me',
    });

    const omitted = await postResponses({ input: 'default me' });
    expect(omitted.status).toBe(200);
    expect(JSON.parse(openaiUpstream!.last.body)).toMatchObject({
      model: DEFAULT_CODEX_ID,
      reasoning: { effort: 'xhigh' },
      input: 'default me',
    });
  });

  it('rejects every Spark spelling before account selection or an upstream request', async () => {
    await bootCodex(ok);
    const res = await postResponses({ model: 'chatgpt:5.3-codex-spark:high', input: 'must not run' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/denied/i);
    expect(openaiUpstream!.last.method).toBeUndefined();
  });

  it('forwards explicit ChatGPT GPT-6.1 Sol with max reasoning without substituting the default', async () => {
    await bootCodex(ok);
    const res = await postResponses({ model: 'chatgpt:6.1-sol:max', input: 'use the requested model' });
    expect(res.status).toBe(200);
    expect(JSON.parse(openaiUpstream!.last.body)).toMatchObject({
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'max' },
      input: 'use the requested model',
    });
  });

  it('honors an x-papercusp-account pin to a specific codex account (cache affinity)', async () => {
    await bootCodex(ok);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }, { [ACCOUNT_HEADER]: 'cdx-2' });
    expect(res.status).toBe(200);
    expect(openaiUpstream!.last.headers['authorization']).toBe('Bearer cdx-2-tok');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
  });

  it('serves Codex /v1/models discovery locally when account-pinned', async () => {
    await bootCodex((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'should not reach upstream' }));
    });
    const res = await ask('/v1/models', { method: 'GET', headers: { [ACCOUNT_HEADER]: 'cdx-2' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models?: Array<{ slug: string; max_context_window?: number; supported_reasoning_levels?: Array<{ effort: string }> }>;
    };
    const sol = body.models?.find((m) => m.slug === 'gpt-6.1-sol');
    expect(sol?.max_context_window).toBe(1_000_000);
    expect(sol?.supported_reasoning_levels?.map((level) => level.effort)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(body.models?.some((m) => m.slug === 'gpt-6-astra')).toBe(true);
    // WI-10005673: the gateway's own fallback rows must never claim a compaction hash.
    expect(body.models?.filter((m) => 'comp_hash' in m)).toEqual([]);
    expect(body.models?.find((m) => m.slug === 'gpt-5.6-sol')?.supported_reasoning_levels).toContainEqual(
      expect.objectContaining({ effort: 'max' }),
    );
    expect(openaiUpstream!.last.method).toBeUndefined();
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
  });

  it('awaits the selected CLI account native model cache while retaining fallback reasoning levels', async () => {
    let nativeOnlySlug = 'gpt-future';
    const readNativeCache = vi.fn(async (home: string) => ({
      models: [
        {
          slug: 'gpt-6-astra',
          display_name: 'Native Astra',
          description: 'Account-native metadata.',
          supported_reasoning_levels: [{ effort: 'low', description: 'Native low' }],
          native_marker: home,
        },
        {
          slug: nativeOnlySlug,
          display_name: 'Future model',
          description: 'Appeared after this gateway build.',
          supported_reasoning_levels: [{ effort: 'max', description: 'Native max' }],
        },
        { display_name: 'invalid row without slug' },
      ],
    }));
    await bootCodex(
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'should not reach upstream' }));
      },
      [codexAcct('cdx-1')],
      {
        codexCliAccounts: () => [{ accountId: 'chatgpt-a', home: '/native/chatgpt-a' }],
        codexCliPool: createFailoverPool([{ accountId: 'chatgpt-a', token: async () => '' }]),
        codexModelsCacheRead: readNativeCache,
      },
    );

    const res = await ask('/v1/models', { method: 'GET', headers: { [ACCOUNT_HEADER]: 'chatgpt-a' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{
        slug: string;
        display_name?: string;
        native_marker?: string;
        supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
      }>;
    };
    const astra = body.models.find((model) => model.slug === 'gpt-6-astra');
    expect(astra).toMatchObject({ display_name: 'Native Astra', native_marker: '/native/chatgpt-a' });
    expect(astra?.supported_reasoning_levels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effort: 'low', description: 'Native low' }),
        expect.objectContaining({ effort: 'max' }),
        expect.objectContaining({ effort: 'ultra' }),
      ]),
    );
    expect(body.models.some((model) => model.slug === 'gpt-future')).toBe(true);
    expect(body.models.some((model) => !model.slug)).toBe(false);
    expect(readNativeCache).toHaveBeenCalledWith('/native/chatgpt-a');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');

    nativeOnlySlug = 'gpt-next';
    const refreshed = (await (
      await ask('/v1/models', { method: 'GET', headers: { [ACCOUNT_HEADER]: 'chatgpt-a' } })
    ).json()) as { models: Array<{ slug: string }> };
    expect(refreshed.models.some((model) => model.slug === 'gpt-next')).toBe(true);
    expect(refreshed.models.some((model) => model.slug === 'gpt-future')).toBe(false);
    expect(readNativeCache).toHaveBeenCalledTimes(2);
  });

  // client-native-features-adoption-2026-10-21 P-001 (D-005 route 1): the account's
  // native catalog switches Codex subagent tools on through these two fields,
  // whatever the session's [features] say, so the gateway never serves them.
  it('codex /v1/models strips multi_agent fields from every served model', async () => {
    const readNativeCache = vi.fn(async () => ({
      models: [
        {
          slug: 'gpt-6-astra',
          display_name: 'Native Astra',
          multi_agent_version: 'v2',
          multi_agent_reasoning_effort: 'low',
        },
        { slug: 'gpt-native-only', display_name: 'Native only', multi_agent_version: 'v1' },
      ],
    }));
    await bootCodex(
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'should not reach upstream' }));
      },
      [codexAcct('cdx-1')],
      {
        codexCliAccounts: () => [{ accountId: 'chatgpt-a', home: '/native/chatgpt-a' }],
        codexCliPool: createFailoverPool([{ accountId: 'chatgpt-a', token: async () => '' }]),
        codexModelsCacheRead: readNativeCache,
      },
    );

    for (const account of ['chatgpt-a', 'cdx-1']) {
      const res = await ask('/v1/models', { method: 'GET', headers: { [ACCOUNT_HEADER]: account } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: Array<Record<string, unknown>> };
      expect(body.models.length).toBeGreaterThan(0);
      for (const model of body.models) {
        expect(model).not.toHaveProperty('multi_agent_version');
        expect(model).not.toHaveProperty('multi_agent_reasoning_effort');
      }
      if (account === 'chatgpt-a') {
        // Stripping removes only the two fields; native metadata survives.
        expect(body.models.find((model) => model.slug === 'gpt-6-astra')).toMatchObject({ display_name: 'Native Astra' });
        expect(body.models.find((model) => model.slug === 'gpt-native-only')).toMatchObject({ display_name: 'Native only' });
      }
    }
    expect(readNativeCache).toHaveBeenCalled();
  });

  it('fetches the selected subscription account live catalog, overrides a stale cache, and coalesces concurrent callers', async () => {
    const home = await makeCodexHome('upstream-account');
    // Test placeholder: the word "placeholder" keeps git-sync's secret-assignment rule from quarantining this file.
    const accessToken = 'catalog-token-placeholder';
    await fs.writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken,
          refresh_token: 'catalog-refresh-sentinel',
          account_id: 'upstream-account',
        },
      }),
    );
    await fs.writeFile(
      path.join(home, 'models_cache.json'),
      // The stale cache deliberately OVERLAPS a live slug (gpt-6-sol): the live catalog's metadata
      // must win over the per-home cache for the same model, which is the "stale cache vs live"
      // precedence the gpt-6-sol display_name assertion below pins. A non-overlapping cache alone
      // cannot catch a merge that lets the cache override live rows.
      JSON.stringify({
        models: [
          // comp_hash on both rows: a stale cache's hash must never be served (WI-10005673).
          { slug: 'gpt-5.6-sol', display_name: 'stale cache', comp_hash: 'stale-cache-hash' },
          { slug: 'gpt-6-sol', display_name: 'stale cache GPT-6-Sol', comp_hash: 'stale-cache-hash' },
        ],
      }),
    );

    let releaseCatalog!: () => void;
    let markCatalogStarted!: () => void;
    const catalogStarted = new Promise<void>((resolve) => {
      markCatalogStarted = resolve;
    });
    const catalogHeld = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let catalogCalls = 0;
    let catalogTarget = '';
    let catalogInit: RequestInit & { dispatcher?: unknown } = {};
    const fetchImpl = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      catalogCalls += 1;
      catalogTarget = String(target);
      catalogInit = init ?? {};
      markCatalogStarted();
      await catalogHeld;
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-6-sol',
              display_name: 'Native GPT-6-Sol',
              comp_hash: '3000',
              visibility: 'list',
              priority: 2,
              supported_reasoning_levels: [{ effort: 'ultra', description: 'Native ultra' }],
            },
            { slug: 'gpt-6-luna', display_name: 'Native GPT-6-Luna', visibility: 'list', priority: 3 },
            { slug: 'gpt-future', display_name: 'Future model', visibility: 'list', priority: 4 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const cliAccount = {
      accountId: 'chatgpt-live',
      home,
      egress: { localAddress: '127.0.0.1' },
    };
    await bootCodex(ok, [codexAcct('cdx-bearer')], {
      codexCliAccounts: () => [cliAccount],
      codexCliPool: createFailoverPool([{ accountId: cliAccount.accountId, token: async () => '' }]),
      fetchImpl,
    });

    const headers = { [ACCOUNT_HEADER]: cliAccount.accountId };
    const first = ask('/v1/models?client_version=0.156.0', { method: 'GET', headers });
    const second = ask('/v1/models?client_version=0.156.0', { method: 'GET', headers });
    await catalogStarted;
    expect(catalogCalls).toBe(1);
    releaseCatalog();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      models: Array<{ slug: string; display_name?: string; comp_hash?: string }>;
    }>;
    for (const body of bodies) {
      expect(body.models.find((model) => model.slug === 'gpt-6-sol')?.display_name).toBe('Native GPT-6-Sol');
      // WI-10005673: comp_hash comes ONLY from the live catalog. A row the live catalog did not
      // supply (fallback lineup or the stale pool-home cache) must carry no comp_hash at all,
      // because Codex compacts before a turn whenever the hash differs from the previous turn's.
      expect(body.models.find((model) => model.slug === 'gpt-6-sol')?.comp_hash).toBe('3000');
      expect(body.models.find((model) => model.slug === 'gpt-5.6-sol')).toBeDefined();
      expect(
        body.models.filter((model) => model.slug !== 'gpt-6-sol' && model.comp_hash !== undefined),
      ).toEqual([]);
      expect(body.models.some((model) => model.slug === 'gpt-6-luna')).toBe(true);
      expect(body.models.some((model) => model.slug === 'gpt-future')).toBe(true);
      expect(JSON.stringify(body)).not.toContain(accessToken);
      expect(JSON.stringify(body)).not.toContain('upstream-account');
    }
    expect(catalogTarget).toContain('/backend-api/codex/models?client_version=0.156.0');
    const upstreamHeaders = new Headers(catalogInit.headers);
    expect(upstreamHeaders.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(upstreamHeaders.get('chatgpt-account-id')).toBe('upstream-account');
    expect(catalogInit.dispatcher).toBeDefined();

    const cached = await ask('/v1/models?client_version=0.156.0', { method: 'GET', headers });
    expect(cached.status).toBe(200);
    expect(catalogCalls).toBe(1);
  });

  it('refreshes an expired selected-account OAuth token before live catalog discovery', async () => {
    const home = await makeCodexHome('refresh-account');
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const expired = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) - 60 })}.sig`;
    await fs.writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: expired, refresh_token: 'refresh-me', account_id: 'refresh-account' },
      }),
    );
    const seen: Array<{ target: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const targetText = String(target);
      seen.push({ target: targetText, authorization: new Headers(init?.headers).get('authorization') });
      if (targetText.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'refreshed-access', refresh_token: 'refresh-next' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'list' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const cliAccount = { accountId: 'chatgpt-refresh', home };
    await bootCodex(ok, [codexAcct('cdx-bearer')], {
      codexCliAccounts: () => [cliAccount],
      codexCliPool: createFailoverPool([{ accountId: cliAccount.accountId, token: async () => '' }]),
      fetchImpl,
    });

    const response = await ask('/v1/models?client_version=0.156.0', {
      method: 'GET',
      headers: { [ACCOUNT_HEADER]: cliAccount.accountId },
    });
    expect(response.status).toBe(200);
    expect(seen.some((entry) => entry.target.includes('/oauth/token'))).toBe(true);
    expect(seen.find((entry) => entry.target.includes('/codex/models'))?.authorization).toBe(
      'Bearer refreshed-access',
    );
  });

  it.each([
    [
      'transport failure',
      async () => {
        throw new Error('catalog transport down');
      },
    ],
    ['non-2xx response', async () => new Response('unavailable', { status: 503 })],
    ['malformed JSON', async () => new Response('{not-json', { status: 200 })],
    [
      '401 whose refresh fails',
      async (target: RequestInfo | URL) =>
        String(target).includes('/oauth/token')
          ? new Response('refresh refused', { status: 500 })
          : new Response('unauthorized', { status: 401 }),
    ],
    [
      'deadline expiry',
      async (_target: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        }),
    ],
  ])('serves the GPT-6 emergency catalog on %s', async (_label, fetchCatalog) => {
    const home = await makeCodexHome(`fallback-${String(_label).replace(/\W+/g, '-')}`);
    const cliAccount = { accountId: `chatgpt-fallback-${String(_label).replace(/\W+/g, '-')}`, home };
    await bootCodex(ok, [codexAcct('cdx-bearer')], {
      codexCliAccounts: () => [cliAccount],
      codexCliPool: createFailoverPool([{ accountId: cliAccount.accountId, token: async () => '' }]),
      fetchImpl: fetchCatalog as typeof fetch,
      codexModelsCatalogTimeoutMs: 20,
    });
    const response = await ask('/v1/models?client_version=0.156.0', {
      method: 'GET',
      headers: { [ACCOUNT_HEADER]: cliAccount.accountId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<{ slug: string }> };
    expect(body.models.some((model) => model.slug === 'gpt-6-sol')).toBe(true);
    expect(body.models.some((model) => model.slug === 'gpt-6-luna')).toBe(true);
  });

  it('serves Codex /v1/models discovery without waiting behind a saturated admission queue', async () => {
    let releaseHeld!: () => void;
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    await bootCodex(
      (_req, res) => {
        markHeld();
        releaseHeld = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'resp_held', ok: true }));
        };
      },
      [codexAcct('cdx-1'), codexAcct('cdx-2')],
      { concurrency: 1, maxQueueWaitMs: 5_000 },
    );

    const holding = postResponses({ model: 'gpt-x', input: 'hold the only admission slot' });
    await held;
    const startedAt = Date.now();
    const res = await ask('/v1/models', { method: 'GET', headers: { [ACCOUNT_HEADER]: 'cdx-2' } });

    expect(res.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
    releaseHeld();
    expect((await holding).status).toBe(200);
  });

  it('counts the request on the codex stats bucket', async () => {
    await bootCodex(ok);
    await postResponses({ model: 'gpt-x', input: 'hi' });
    const s = (await (await ask('/stats')).json()) as { codex: { requests: number } };
    expect(s.codex.requests).toBeGreaterThanOrEqual(1);
  });

  it('observes native Responses streaming cache usage without altering the SSE body', async () => {
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp_cache',
        usage: { input_tokens: 1500, input_tokens_details: { cached_tokens: 1200, cache_write_tokens: 100 } },
      },
    };
    await bootCodex((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`);
    });
    const res = await postResponses({ model: 'gpt-5.6-sol', input: 'hi', stream: true });
    const body = await res.text();
    expect(body).toContain('response.completed');
    const stats = (await (await ask('/stats')).json()) as {
      cache: { read: number; create: number; input: number; hits: number; byAccount: Record<string, { read: number }> };
      requestStages: import('./request-stage-telemetry').GatewayRequestTelemetrySnapshot;
    };
    expect(stats.cache).toMatchObject({ read: 1200, create: 100, input: 200, hits: 1 });
    expect(stats.cache.byAccount['cdx-1']?.read).toBe(1200);
    expect(stats.requestStages.recent.at(-1)?.cache).toMatchObject({
      servingAccountId: 'cdx-1', providerRequestId: 'resp_cache', inputTokens: 200,
      cacheReadTokens: 1200, cacheWriteTokens: 100, reuse: 'partial-hit', shape: 'observed',
    });
  });

  it('uses inclusive OpenAI input for token reuse without inventing missing writes or uncached input', async () => {
    await bootCodex((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: 'missing-writes', usage: { input_tokens: 1500, input_tokens_details: { cached_tokens: 1200 } },
      } })}\n\ndata: [DONE]\n\n`);
    });
    await (await postResponses({ model: 'gpt-5.6-sol', input: 'hi', stream: true })).text();
    const stats = await (await ask('/stats')).json() as import('./gateway').GatewayStats;
    expect(stats.cache).toMatchObject({ input: null, create: null, read: 1200, hitRate: 0.8,
      tokenRateBasis: { read: 1200, inputTotal: 1500 },
      coverage: { requests: 1, writeKnown: 0, uncachedInputKnown: 0, inputTotalKnown: 1, tokenRateRequests: 1 } });
    expect(stats.cache.byAccount['cdx-1'].create).toBeNull();
    expect(stats.requestStages?.recent.at(-1)?.cache.cacheWriteTokens).toBeNull();
    expect(stats.requestStages?.recent.at(-1)?.cache.inputTokens).toBeNull();
  });
});

/**
 * gateway-admission-congestion-only-2026-10-13 R-3 / P-003 — pace uploads, not open streams.
 *
 * Before P-003 the Codex provider-lane slot was taken around the WHOLE admitted handler,
 * so a streamed response held it until its last byte. Here the upstream answers with SSE
 * headers and one event, then holds the response open; while it is open the lane must
 * report the slot free, and a second request must be admitted and complete.
 */
describe('proxyOpenAi — a streaming response does not hold the provider admission slot (R-3)', () => {
  it('frees the Codex slot while the stream is open, admits a second request, then relays the rest', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let upstreamCalls = 0;
    await bootCodex((_req, res) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_open' } })}\n\n`);
        void firstHeld.then(() => {
          res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_open' } })}\n\ndata: [DONE]\n\n`);
        });
        return;
      }
      ok(_req, res);
    });

    const first = await postResponses({ model: 'gpt-5.6-sol', input: 'hold me open', stream: true });
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let relayed = '';
    while (!relayed.includes('response.created')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      relayed += decoder.decode(chunk.value, { stream: true });
    }
    expect(relayed).toContain('response.created');
    expect(relayed, 'the first stream is still open').not.toContain('response.completed');

    // The stream is open and no longer holds a slot.
    const during = (await (await ask('/stats')).json()) as { codexAdmission: { running: number; queued: number } };
    expect(during.codexAdmission).toMatchObject({ running: 0, queued: 0 });

    // A second request is admitted and finishes while the first stream is still open.
    const second = await postResponses({ model: 'gpt-5.6-sol', input: 'second' });
    expect(second.status).toBe(200);
    expect((await second.json()) as { ok?: boolean }).toMatchObject({ ok: true });

    releaseFirst();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      relayed += decoder.decode(chunk.value, { stream: true });
    }
    expect(relayed).toContain('response.completed');
    expect(relayed).toContain('[DONE]');

    const after = (await (await ask('/stats')).json()) as { codexAdmission: { running: number; queued: number } };
    expect(after.codexAdmission).toMatchObject({ running: 0, queued: 0 });
    expect(upstreamCalls).toBe(2);
  });

  // R-3 falsifier (3): the slot paces UPLOADS, so it must not be released before the
  // request body has finished uploading. The stub upstream only runs its reply callback
  // once the whole body has arrived, and then withholds every response byte. Until the
  // first byte the slot must still be held. An implementation that freed the slot at
  // admission (no upload pacing at all) reads running:0 here.
  it('holds the Codex slot through the upload until the upstream sends its first response byte', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let bodyArrived!: (body: string) => void;
    const arrived = new Promise<string>((resolve) => {
      bodyArrived = resolve;
    });
    await bootCodex((req, res, body) => {
      bodyArrived(body);
      void answered.then(() => ok(req, res));
    });

    const payload = 'x'.repeat(256 * 1024);
    const pending = postResponses({ model: 'gpt-5.6-sol', input: payload });
    const uploaded = await arrived;
    expect(uploaded.length, 'the upstream received the whole body').toBeGreaterThan(payload.length);

    const held = (await (await ask('/stats')).json()) as { codexAdmission: { running: number } };
    expect(held.codexAdmission.running, 'slot still held: upload done, no response byte yet').toBe(1);

    answer();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok?: boolean }).toMatchObject({ ok: true });
    const after = (await (await ask('/stats')).json()) as { codexAdmission: { running: number; queued: number } };
    expect(after.codexAdmission).toMatchObject({ running: 0, queued: 0 });
  });
});

describe('proxyOpenAi — resilience parity (rotate, do not surface)', () => {
  it('observes the completed provider model and forwarded effort without treating the request model as serving proof', async () => {
    await bootCodex((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: 'resp-observed', model: 'provider-served-revision', status: 'completed', reasoning: { effort: 'high' },
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 2 },
      } })}\n\ndata: [DONE]\n\n`);
    });
    await (await postResponses({ model: 'gpt-5.6-sol', reasoning: { effort: 'high' }, input: 'private task', stream: true })).text();
    const stats = await (await ask('/stats')).json() as import('./gateway').GatewayStats;
    expect(stats.requestStages?.recent.at(-1)).toMatchObject({ model: 'gpt-5.6-sol', forwardedEffort: 'high',
      providerIdentity: { responseId: 'resp-observed', model: 'provider-served-revision', effort: 'high', accountId: 'cdx-1' } });
  });
  // Branch the upstream on the bearer token so cdx-1 is throttled but cdx-2 is healthy.
  const byBearer = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const auth = String(req.headers['authorization'] ?? '');
    if (auth.includes('cdx-1')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'slow down' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, served_by: 'cdx-2' }));
    }
  };

  it('a 429 on one codex account ROTATES to another + retries — the bee gets the 200, not the throttle', async () => {
    await bootCodex(byBearer);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { served_by?: string }).served_by).toBe('cdx-2');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
    const s = (await (await ask('/stats')).json()) as { codex: { failovers: number; upstream429: number } };
    expect(s.codex.failovers).toBeGreaterThanOrEqual(1);
    expect(s.codex.upstream429).toBeGreaterThanOrEqual(1);
  });

  it('a SOFT account pin yields only after its account is throttled and reports the structured divergence', async () => {
    await bootCodex(byBearer);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }, { [ACCOUNT_HEADER]: 'cdx-1' });
    expect(res.status).toBe(200);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBe('cdx-1->cdx-2');
  });

  it('a HARD account pin never fails over, even when a sibling could serve', async () => {
    await bootCodex(byBearer, [codexAcct('cdx-1'), codexAcct('cdx-2')], {
      requestAbsorbMs: 0,
      internalRetryDeadlineMs: 1,
      bare429FailoverBackoffMs: 1,
    });
    const res = await postResponses(
      { model: 'gpt-x', input: 'hi' },
      { [ACCOUNT_HEADER]: 'cdx-1', [ACCOUNT_PIN_HEADER]: 'hard' },
    );
    expect(res.status, await res.clone().text()).toBe(429);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-1');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBeNull();
  });

  it('Codex throttles shrink only the Codex admission controller, never Claude admission', async () => {
    await bootCodex(
      (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'over' } }));
      },
      [codexAcct('cdx-solo')],
      {
        concurrency: 8,
        aimd: { floor: 1, decreaseThreshold: 1, increaseEvery: 100 },
        requestAbsorbMs: 0,
        internalRetryDeadlineMs: 1,
        bare429FailoverBackoffMs: 1,
      },
    );
    expect((await postResponses({ model: 'gpt-x', input: 'hi' })).status).toBe(429);
    const stats = (await (await ask('/stats')).json()) as {
      admission: { maxConcurrent: number };
      codexAdmission: { maxConcurrent: number };
      aimd: { effective: number; cap: number };
      codexAimd: { effective: number; cap: number; decreases: number };
    };
    expect(stats.aimd).toMatchObject({ effective: 8, cap: 8 });
    expect(stats.admission.maxConcurrent).toBe(8);
    expect(stats.codexAimd.decreases).toBeGreaterThan(0);
    expect(stats.codexAimd.effective).toBeLessThan(stats.codexAimd.cap);
    expect(stats.codexAdmission.maxConcurrent).toBe(stats.codexAimd.effective);
  });

  it('a SINGLE-account codex pool with a persistent 429 FORWARDS the 429 (no rotate target → no hang/loop)', async () => {
    await bootCodex(
      (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'over' } }));
      },
      [codexAcct('cdx-solo')],
      { requestAbsorbMs: 0, internalRetryDeadlineMs: 1, bare429FailoverBackoffMs: 1 },
    );
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(429);
    // it's the real upstream 429 forwarded (the bee's CLI then backs off), not a synthetic loop
    expect(((await res.json()) as { error?: { type?: string } }).error?.type).toBe('rate_limit');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-solo');
  });

  it('a token-read failure on one codex account rotates to a healthy one + retries', async () => {
    let cdx1Calls = 0;
    await bootCodex(ok, [
      codexAcct('cdx-1', async () => {
        cdx1Calls++;
        throw new Error('token endpoint down');
      }),
      codexAcct('cdx-2'),
    ]);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(200);
    expect(cdx1Calls).toBe(1); // tried cdx-1's token, it failed, rotated
    expect(openaiUpstream!.last.headers['authorization']).toBe('Bearer cdx-2-tok');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
  });

  it('a token-read failure on a SINGLE-account codex pool returns a retryable 503 (no rotate target)', async () => {
    await bootCodex(ok, [
      codexAcct('cdx-solo', async () => {
        throw new Error('token endpoint down');
      }),
    ]);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(503);
    const b = (await res.json()) as { gateway?: boolean; error?: { type?: string } };
    expect(b.gateway).toBe(true);
    expect(b.error?.type).toBe('overloaded_error');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a non-streaming ChatGPT CLI bridge failure yields to the next subscription account', async () => {
    const cliAccounts = [
      { accountId: 'chatgpt-a', home: '/tmp/chatgpt-a' },
      { accountId: 'chatgpt-b', home: '/tmp/chatgpt-b' },
    ];
    const calls: string[] = [];
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexCliRun: async (opts) => {
        calls.push(opts.home);
        if (opts.home === '/tmp/chatgpt-a') throw new Error('account unavailable');
        return { text: 'served by b', inputTokens: 5, outputTokens: 3 };
      },
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    const res = await postResponses(
      { model: 'gpt-5.5', input: 'hi', stream: false },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(['/tmp/chatgpt-a', '/tmp/chatgpt-b']);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBe('chatgpt-a->chatgpt-b');
  });

  // WI-6554700010009426: on 2026-10-12 a mass-resume herd drove ~8,900 codex OAuth TTFB/transport
  // failures while the codex admission window kept EXPANDING (it only ever heard 429s and successes),
  // so the gateway kept admitting full-body re-uploads onto a saturated uplink for ~35 min. An admitted
  // OAuth attempt that dies on the wire must contract the codex window; clean traffic must not.
  // WI-6554700010011426 replaced the WI-6554700010009426 "transport failure CONTRACTS"
  // contract: one request is one unit of congestion pressure (plan D-001), so a
  // lone failover leaves the window open and only sustained pressure contracts it.
  it.each([
    { label: 'a lone transport failure leaves the codex window open', aimd: undefined, contracts: false },
    { label: 'sustained transport pressure still contracts the codex window', aimd: { decreaseThreshold: 1 }, contracts: true },
  ])('admitted codex OAuth transport failure: $label', async ({ aimd, contracts }) => {
    const cliAccounts = [
      { accountId: 'oauth-a', home: await makeCodexHome('oauth-a') },
      { accountId: 'oauth-b', home: await makeCodexHome('oauth-b') },
    ];
    let failNext = false;
    const wire = `data: ${JSON.stringify(completedCodexResponse())}\n\ndata: [DONE]\n\n`;
    const fetchImpl = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }
      return new Response(wire, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexCliRun: async () => ({ text: 'unused', inputTokens: 1, outputTokens: 1 }),
      codexOAuthProxy: true, fetchImpl,
      selfHeal: { enabled: false },
      ...(aimd ? { aimd } : {}),
    });
    port = await gw.listen(0);
    const initial = gw.stats().codexAdmission.maxConcurrent;
    const clean = await postResponses({ model: 'gpt-5.5', input: 'hi', stream: true });
    expect(clean.status).toBe(200);
    await clean.text();
    expect(gw.stats().codexAdmission.maxConcurrent).toBe(initial);
    failNext = true;
    const res = await postResponses({ model: 'gpt-5.5', input: 'hi', stream: true });
    expect(res.status).toBe(200);
    await res.text();
    expect(gw.stats().egressFailsByAccount).not.toEqual({});
    expect(gw.stats().egressProxyAttemptsByAccount).toEqual({});
    expect(gw.stats().egressProxyFailsByAccount).toEqual({});
    if (contracts) expect(gw.stats().codexAdmission.maxConcurrent).toBeLessThan(initial);
    else expect(gw.stats().codexAdmission.maxConcurrent).toBe(initial);
  });

  it('a terminal out-of-usage (weekly-wall) codex 429 leaves the codex window unchanged (WI-6554700010011426)', async () => {
    await bootCodex(
      (_req, res) => {
        res.writeHead(429, {
          'content-type': 'application/json',
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '10080',
          'x-codex-primary-reset-after-seconds': String(3 * 24 * 3600),
        });
        res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'usage limit reached' } }));
      },
      [codexAcct('cdx-walled')],
      {
        concurrency: 8,
        aimd: { floor: 1, decreaseThreshold: 1, increaseEvery: 100 },
        requestAbsorbMs: 0,
        internalRetryDeadlineMs: 1,
        bare429FailoverBackoffMs: 1,
      },
    );
    const before = ((await (await ask('/stats')).json()) as { codexAdmission: { maxConcurrent: number } })
      .codexAdmission.maxConcurrent;
    expect((await postResponses({ model: 'gpt-x', input: 'hi' })).status).toBe(429);
    const stats = (await (await ask('/stats')).json()) as {
      codexAdmission: { maxConcurrent: number };
      codexAimd: { decreases: number };
    };
    // FALSIFIER: the sibling test above ('Codex throttles shrink only the Codex
    // admission controller') sends a TRANSIENT 429 with the same threshold of 1 and
    // DOES contract; only the exhausted window differs here.
    expect(stats.codexAimd.decreases).toBe(0);
    expect(stats.codexAdmission.maxConcurrent).toBe(before);
  });

  it('a streaming ChatGPT CLI bridge failover carries final route metadata in response.completed', async () => {
    const cliAccounts = [
      { accountId: 'chatgpt-a', home: '/tmp/chatgpt-a' },
      { accountId: 'chatgpt-b', home: '/tmp/chatgpt-b' },
    ];
    const calls: string[] = [];
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexCliRun: async (opts) => {
        calls.push(opts.home);
        if (opts.home === '/tmp/chatgpt-a') throw new Error('account unavailable');
        return { text: 'served by b', inputTokens: 5, outputTokens: 3 };
      },
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const res = await postResponses({ model: 'gpt-5.5', input: 'hi', stream: true }, { [ACCOUNT_HEADER]: 'chatgpt-a' });
    expect(res.status).toBe(200);
    // The early SSE header is irrevocably committed for attempt 1; the in-band
    // response.completed metadata is the final serving-account truth.
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBeNull();
    expect(calls).toEqual(['/tmp/chatgpt-a', '/tmp/chatgpt-b']);

    const wire = await res.text();
    const completedFrame = wire
      .split('\n')
      .find((line) => line.startsWith('data: ') && line.includes('"type":"response.completed"'));
    expect(completedFrame).toBeDefined();
    const completed = JSON.parse(completedFrame!.slice('data: '.length)) as {
      response: {
        metadata?: Record<string, unknown>;
        output_text?: string;
      };
    };
    expect(completed.response.output_text).toBe('served by b');
    expect(completed.response.metadata).toMatchObject({
      [ROUTED_ACCOUNT_HEADER]: 'chatgpt-b',
      [PIN_YIELDED_HEADER]: 'chatgpt-a->chatgpt-b',
    });
  });

  it('yields a projection-walled ChatGPT CLI SOFT pin before launch and returns after recovery', async () => {
    const cliAccounts = [
      { accountId: 'chatgpt-a', home: '/tmp/chatgpt-a' },
      { accountId: 'chatgpt-b', home: '/tmp/chatgpt-b' },
    ];
    const calls: string[] = [];
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexCliRun: async (opts) => {
        calls.push(opts.home);
        return { text: `served by ${opts.home}`, inputTokens: 5, outputTokens: 3 };
      },
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    gw.setAccountRateHints([{ accountId: 'chatgpt-a', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000 }]);

    const yielded = await postResponses(
      { model: 'gpt-5.5', input: 'avoid the wall', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(yielded.status).toBe(200);
    await yielded.text();
    expect(calls).toEqual(['/tmp/chatgpt-b']);
    expect(yielded.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
    expect(yielded.headers.get(PIN_YIELDED_HEADER)).toBe('chatgpt-a->chatgpt-b');

    gw.setAccountRateHints([]);
    const recovered = await postResponses(
      { model: 'gpt-5.5', input: 'resume the warm account', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(calls).toEqual(['/tmp/chatgpt-b', '/tmp/chatgpt-a']);
    expect(recovered.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    expect(recovered.headers.get(PIN_YIELDED_HEADER)).toBeNull();
  });

  it.each(['credential', 'transport', '429', '503'] as const)(
    'a ChatGPT OAuth %s failure yields to the next subscription account and preserves the native SSE response',
    async (failure) => {
      const homeA = await makeCodexHome('chatgpt-a', failure !== 'credential');
      const homeB = await makeCodexHome('chatgpt-b');
      const cliAccounts = [
        { accountId: 'chatgpt-a', home: homeA },
        { accountId: 'chatgpt-b', home: homeB },
      ];
      const routed: string[] = [];
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
        const rawBody = init?.body;
        const bodyText =
          typeof rawBody === 'string'
            ? rawBody
            : rawBody instanceof Uint8Array
              ? Buffer.from(rawBody).toString('utf8')
              : '';
        const forwardedBody = JSON.parse(bodyText) as Record<string, unknown>;
        expect(Array.isArray(forwardedBody.input)).toBe(true);
        expect(forwardedBody.store).toBe(false);
        expect(forwardedBody.prompt_cache_options).toBeUndefined();
        expect(forwardedBody.prompt_cache_retention).toBeUndefined();
        expect(forwardedBody.prompt_cache_key).toMatch(/^psu-/);
        routed.push(account);
        if (account === 'chatgpt-a') {
          if (failure === 'transport') throw new Error('subscription transport unavailable');
          if (failure === '429') {
            return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
              status: 429,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (failure === '503') {
            return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        const completed = { type: 'response.completed', response: { id: 'resp_chatgpt_b', output: [] } };
        return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;

      gw = createInferenceGateway({
        accountId: 'claude-acct',
        token: async () => 'claude-tok',
        codexCliAccounts: () => cliAccounts,
        codexCliPool: createFailoverPool(
          cliAccounts.map((account) => ({
            accountId: account.accountId,
            token: async () => '',
          })),
        ),
        codexOAuthProxy: true,
        fetchImpl,
        selfHeal: { enabled: false },
      });
      port = await gw.listen(0);

      const res = await postResponses(
        { model: 'gpt-5.5', input: 'parity matrix', stream: true },
        { [ACCOUNT_HEADER]: 'chatgpt-a' },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('resp_chatgpt_b');
      expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
      expect(res.headers.get(PIN_YIELDED_HEADER)).toBe('chatgpt-a->chatgpt-b');
      expect(routed).toEqual(failure === 'credential' ? ['chatgpt-b'] : ['chatgpt-a', 'chatgpt-b']);
      expect(gw.stats().codex.failovers).toBeGreaterThanOrEqual(1);
    },
  );

  it('keeps a Luna tool-capable streaming turn on the transparent OAuth transport', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    const cliRun = vi.fn(async () => ({ text: 'must not flatten the tool turn', inputTokens: 1, outputTokens: 1 }));
    const gatewayStatusTool = {
      type: 'function',
      name: 'gateway_status',
      description: 'Read the live inference-gateway status.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    };
    const upstreamSse =
      `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'gateway_status', call_id: 'call_luna' } })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_luna_tool', output: [] } })}\n\n` +
      'data: [DONE]\n\n';
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const rawBody =
        init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init?.body ?? '');
      const forwarded = JSON.parse(rawBody) as Record<string, unknown>;
      expect(forwarded).toMatchObject({
        model: 'gpt-5.6-luna',
        stream: true,
        store: false,
        tools: [gatewayStatusTool],
        tool_choice: 'auto',
      });
      return new Response(upstreamSse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(
        cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
      ),
      codexCliRun: cliRun,
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const res = await postResponses(
      {
        model: 'gpt-5.6-luna',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Call gateway status.' }] }],
        stream: true,
        store: false,
        tools: [gatewayStatusTool],
        tool_choice: 'auto',
      },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamSse);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cliRun).not.toHaveBeenCalled();
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
  });

  it('aggregates a successful non-stream OAuth response into JSON without invoking the CLI bridge', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    const cliRun = vi.fn(async () => ({ text: 'must not run', inputTokens: 1, outputTokens: 1 }));
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const rawBody =
        init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init?.body ?? '');
      const forwarded = JSON.parse(rawBody) as Record<string, unknown>;
      expect(forwarded.stream).toBe(true);
      expect(forwarded.store).toBe(false);
      return new Response(
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_created' } })}\n\n` +
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_nonstream', output: [] } })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(
        cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
      ),
      codexCliRun: cliRun,
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const res = await postResponses(
      { model: 'gpt-5.5', input: 'aggregate me', stream: false },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ id: 'resp_nonstream', output: [] });
    expect(cliRun).not.toHaveBeenCalled();
    expect(gw.stats().codex).toMatchObject({ requests: 1, failovers: 0 });
    expect(gw.stats().egressAttemptsByAccount).toMatchObject({ 'chatgpt-a': 1 });
  });

  it('keeps the downstream open while a real HTTP non-stream OAuth response aggregates past the ordinary idle window', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    const downstreamIdleMs = 60;
    const delayedCompletionMs = 180;

    openaiUpstream = await startUpstream((_req, res, body) => {
      const forwarded = JSON.parse(body) as Record<string, unknown>;
      expect(forwarded.stream).toBe(true);
      expect(forwarded.store).toBe(false);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_delayed_created' } })}\n\n`);
      const completionTimer = setTimeout(() => {
        if (res.destroyed) return;
        res.end(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_delayed', output: [] } })}\n\n` +
            'data: [DONE]\n\n',
        );
      }, delayedCompletionMs);
      completionTimer.unref?.();
    });
    const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => {
      const upstreamUrl = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      return fetch(`${openaiUpstream!.base}${upstreamUrl.pathname}${upstreamUrl.search}`, init);
    }) as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool([{ accountId: 'chatgpt-a', token: async () => '' }]),
      codexOAuthProxy: true,
      fetchImpl,
      downstreamIdleMs,
      upstreamStreamHeadersTimeoutMs: 1_000,
      upstreamBodyIdleTimeoutMs: 1_000,
      codexOAuthNonStreamTimeoutMs: 1_000,
      requestCeilingMs: 2_500,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const res = await postResponses(
      { model: 'gpt-5.5', input: 'wait for the delayed completion', stream: false },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ id: 'resp_delayed', output: [] });
  });

  it('defaults OAuth non-stream aggregation to the universal request ceiling, not the former five-minute cap', () => {
    const twentyMinutes = 20 * 60 * 1_000;
    expect(resolveCodexOAuthNonStreamTimeoutMs(twentyMinutes)).toBe(twentyMinutes);
    expect(resolveCodexOAuthNonStreamTimeoutMs(twentyMinutes, 7 * 60 * 1_000)).toBe(7 * 60 * 1_000);
    expect(resolveCodexOAuthNonStreamTimeoutMs(10 * 60 * 1_000, twentyMinutes)).toBe(10 * 60 * 1_000);
  });

  it('PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM=0 selects the named temporary CLI fallback', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    const cliRun = vi.fn(async () => ({ text: 'served by the rollback path', inputTokens: 5, outputTokens: 3 }));
    const fetchImpl = vi.fn(async () => {
      throw new Error('the OAuth transport must stay dark while the fallback is selected');
    }) as unknown as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(
        cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
      ),
      codexCliRun: cliRun,
      codexOAuthProxy: true,
      codexOAuthNonStream: false,
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const res = await postResponses(
      { model: 'gpt-5.5', input: 'use the rollback path', stream: false },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(res.status).toBe(200);
    expect(cliRun).toHaveBeenCalledOnce();
    expect(cliRun).toHaveBeenCalledWith(expect.objectContaining({ home }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gw.stats().codex.requests).toBe(1);
  });

  it.each([429, 503] as const)(
    'retries a non-stream OAuth %s before aggregating the healthy account response',
    async (failureStatus) => {
      const homeA = await makeCodexHome('chatgpt-a');
      const homeB = await makeCodexHome('chatgpt-b');
      const cliAccounts = [
        { accountId: 'chatgpt-a', home: homeA },
        { accountId: 'chatgpt-b', home: homeB },
      ];
      const routed: string[] = [];
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
        routed.push(account);
        if (account === 'chatgpt-a') {
          return new Response(JSON.stringify({ error: { message: 'try another account' } }), {
            status: failureStatus,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_after_retry', output: [] } })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }) as typeof fetch;

      gw = createInferenceGateway({
        accountId: 'claude-acct',
        token: async () => 'claude-tok',
        codexCliAccounts: () => cliAccounts,
        codexCliPool: createFailoverPool(
          cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
        ),
        codexOAuthProxy: true,
        fetchImpl,
        selfHeal: { enabled: false },
      });
      port = await gw.listen(0);

      const res = await postResponses(
        { model: 'gpt-5.5', input: 'retry then aggregate', stream: false },
        { [ACCOUNT_HEADER]: 'chatgpt-a' },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'resp_after_retry', output: [] });
      expect(routed).toEqual(['chatgpt-a', 'chatgpt-b']);
      expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
      expect(res.headers.get(PIN_YIELDED_HEADER)).toBe('chatgpt-a->chatgpt-b');
      expect(gw.stats().codex).toMatchObject({ requests: 1, failovers: 1 });
      expect(gw.stats().egressAttemptsByAccount).toMatchObject({
        'chatgpt-a': 1,
        'chatgpt-b': 1,
      });
    },
  );

  it('aborts the OAuth upstream when a non-stream downstream caller disconnects', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    let upstreamAborted = false;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            upstreamAborted = true;
            reject(new Error('oauth upstream aborted'));
          },
          { once: true },
        );
      });
      throw new Error('unreachable');
    }) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool([{ accountId: 'chatgpt-a', token: async () => '' }]),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
      requestCeilingMs: 5_000,
    });
    port = await gw.listen(0);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await ask('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'chatgpt-a' },
      body: JSON.stringify({ model: 'gpt-5.5', input: 'disconnect me', stream: false }),
      signal: controller.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamAborted).toBe(true);
  });
});

/*
 * P-004 characterization goldens (plan `gateway-kernel-adoption-2026-08-29`, D-003).
 *
 * These pin the parts of `serveCodexOAuthProxy` that NOTHING else covered before the
 * kernel migration. Two of them exist because reading the kernel first showed the
 * migration would silently change them:
 *
 *  1. THE 401 REFRESH-AND-RETRY LADDER (`gateway.ts:5670`) had ZERO tests. It retries
 *     the SAME account after refreshing, and — unlike every other retry in this
 *     handler — it is NOT gated on `routing.hardPin`. The kernel suppresses failover
 *     for hard pins BEFORE the adapter is consulted (`request-kernel.ts:491`), so a
 *     migration that expresses this retry as a failover would forward the 401
 *     downstream on exactly the account-pinned path P-009 depends on. The hard-pin
 *     case below is the falsifier for that.
 *
 *  2. WHICH account serves an UNPINNED request. This is the D-010 double-advance
 *     catcher for this lane: `proxyOpenAi` already spends this request's one
 *     `codexCliPool.active()` call to resolve `cli` before the handler is entered
 *     (gateway.ts:5948), so an adapter whose `selectInitial` calls `active()` again
 *     would start every unpinned request on the SECOND account. Nothing else here
 *     asserts the FIRST account serves, which is exactly how that defect hid in the
 *     bearer lane until a golden pinned the serving account.
 *
 * The refresh is driven WITHOUT a network call: `doRefresh` re-reads auth.json first
 * and returns a token a peer already refreshed (`codex-oauth-proxy.ts:520-524`), so
 * rewriting the file mid-flight exercises the real code path deterministically. The
 * gateway calls `refreshCodexToken(home, auth)` with no `fetchImpl`, so it would
 * otherwise reach the live OpenAI token endpoint.
 */
describe('proxyOpenAi — codex terminal-429 shaping + stall attribution (WI-2038027)', () => {
  it('a walled OAuth account forwards a SHAPED 429: codex-dialect reset parsed, retry-after capped, retries-exhausted marked, stall recorded', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    // A weekly-cap 429 in the dialect the ChatGPT codex backend actually speaks: the reset is
    // 2h out and there is NO retry-after header. Through the old (anthropic-dialect) parsing this
    // read as "no reset signal" → the shed would fall to the 5s loadshed floor; the codex parser
    // reads the wall, so the response must carry the CAPPED 60s retry-after and the stall must
    // carry the REAL ~2h reset for the stall-waker's capacity gate.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'x-codex-primary-used-percent': '100',
            'x-codex-primary-window-minutes': '10080',
            'x-codex-primary-reset-after-seconds': '7200',
          },
        }),
    ) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(
        cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
      ),
      codexOAuthProxy: true,
      fetchImpl,
      requestAbsorbMs: 0,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const before = Date.now();
    const res = await postResponses(
      { model: 'gpt-5.5', input: 'hi', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a', [OWNER_HEADER]: 'su-oauth-stall-test' },
    );
    expect(res.status).toBe(429);
    // The 2h wall is far past the bee cap → capped, never the raw multi-hour value and never
    // the 5s loadshed floor an unparsed-dialect fallback would produce.
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get(RETRIES_EXHAUSTED_HEADER)).toMatch(/^\d+$/);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');

    const stalls = (await (await ask('/admin/stalls?since=0')).json()) as {
      stalls: Array<{ ownerId: string; accountId: string; soonestResetAt: number }>;
    };
    const mine = stalls.stalls.find((s) => s.ownerId === 'su-oauth-stall-test');
    expect(mine).toBeDefined();
    expect(mine!.accountId).toBe('chatgpt-a');
    // The stall carries the REAL window reset (~2h out), not the 30s floor — this is what the
    // stall-waker's capacityBack honors before waking the session.
    expect(mine!.soonestResetAt).toBeGreaterThan(before + 3_600_000);
  });

  it('a bearer terminal 429 caps a multi-hour upstream retry-after at the bee cap and records the stall', async () => {
    await bootCodex(
      (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '21600' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'weekly cap' } }));
      },
      [codexAcct('cdx-solo')],
      { requestAbsorbMs: 0 },
    );
    const before = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }, { [OWNER_HEADER]: 'su-bearer-stall-test' });
    expect(res.status).toBe(429);
    // 21600s (6h) from upstream → the caller is handed the CAPPED value; the multi-hour horizon
    // is a ROUTING fact (the stall below), not a client sleep instruction.
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get(RETRIES_EXHAUSTED_HEADER)).toMatch(/^\d+$/);

    const stalls = (await (await ask('/admin/stalls?since=0')).json()) as {
      stalls: Array<{ ownerId: string; accountId: string; soonestResetAt: number }>;
    };
    const mine = stalls.stalls.find((s) => s.ownerId === 'su-bearer-stall-test');
    expect(mine).toBeDefined();
    expect(mine!.accountId).toBe('cdx-solo');
    expect(mine!.soonestResetAt).toBeGreaterThan(before + 3_600_000);
  });

  it('OAuth outer ladder waits out a short throttle and resumes the same request to a 200 stream', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'brief burst' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '20ms' },
        });
      }
      return new Response(`data: ${JSON.stringify(completedCodexResponse())}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(
        cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
      ),
      codexOAuthProxy: true,
      fetchImpl,
      requestAbsorbMs: 0,
      internalRetryDeadlineMs: 2_000,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const res = await postResponses(
      { model: 'gpt-5.5', input: 'recover me', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    const body = await res.text();
    expect(body).toContain('"type":"response.completed"');
    expect(body).toContain('[DONE]');
  });

  it('OAuth absorb releases the provider admission slot while waiting, then re-enters and succeeds', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) {
        // The SECOND 429's park is the window the test observes, so it must dwarf
        // scheduler jitter: under the gate's loaded stateful lane a 5ms poll timer can
        // be delayed past a 200ms park, so the poller wakes to calls===3 having never
        // seen it and reports a release that did happen as missing (WI-10003256).
        const retryAfter = calls === 1 ? '20ms' : '1500ms';
        return new Response(JSON.stringify({ error: { message: 'pool burst' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
        });
      }
      return new Response(`data: ${JSON.stringify(completedCodexResponse())}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(
        cliAccounts.map((account) => ({ accountId: account.accountId, token: async () => '' })),
      ),
      codexOAuthProxy: true,
      fetchImpl,
      requestAbsorbMs: 5_000,
      // MUST be 0, not 1 (WI-10003724). Each absorb park re-arms
      // `retryDeadlineAt = Date.now() + internalRetryDeadlineMs`, and the ladder's rung (1)
      // — a transient wait that KEEPS the slot — fires while `now < retryDeadlineAt`. With 1ms,
      // a second 429 decided inside the same wall-clock millisecond takes that 1ms slot-holding
      // wait instead of the absorb park, so the slot is never released and this test reads
      // `false`. The gate saw exactly that: both reds ran ~1.5s SHORT (the 1500ms park never
      // happened). 0 makes rung (1) unreachable, so the absorb is the only rung.
      internalRetryDeadlineMs: 0,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const pending = postResponses(
      { model: 'gpt-5.5', input: 'absorb me', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    // A generous CEILING, not a pacing interval: both loops exit on their condition,
    // so this only bounds a genuinely broken release.
    const observedUntil = Date.now() + 10_000;
    while (calls < 2 && Date.now() < observedUntil) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBeGreaterThanOrEqual(2);
    // fetchImpl counts the second call before its 429 has released admission.
    // Observe the slot release itself while the recovery request is parked.
    let releasedWhileParked = false;
    while (calls === 2 && Date.now() < observedUntil) {
      if (gw!.stats().codexAdmission.running === 0) {
        releasedWhileParked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(releasedWhileParked).toBe(true);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    const body = await res.text();
    expect(body).toContain('"type":"response.completed"');
    expect(body).toContain('[DONE]');
  });

  it('a short upstream retry-after passes through unchanged (only the multi-hour horizon is capped)', async () => {
    await bootCodex(
      (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'burst' } }));
      },
      [codexAcct('cdx-solo')],
      { requestAbsorbMs: 0, internalRetryDeadlineMs: 1 },
    );
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get(RETRIES_EXHAUSTED_HEADER)).toMatch(/^\d+$/);
  });

  it('bearer outer ladder waits out a short throttle and resumes the same request to a 200', async () => {
    let calls = 0;
    await bootCodex(
      (_req, res) => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20ms' });
          res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'brief burst' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'recovered', ok: true }));
      },
      [codexAcct('cdx-solo')],
      { requestAbsorbMs: 0, internalRetryDeadlineMs: 2_000 },
    );

    const res = await postResponses({ model: 'gpt-x', input: 'recover me' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect((await res.json()) as { ok?: boolean }).toMatchObject({ ok: true });
  });

  it('bearer absorb releases the provider admission slot while waiting, then re-enters and succeeds', async () => {
    let calls = 0;
    await bootCodex(
      (_req, res) => {
        calls += 1;
        if (calls <= 2) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '80ms' });
          res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'pool burst' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'absorbed', ok: true }));
      },
      [codexAcct('cdx-solo')],
      // A 0ms slot-hold deadline spends the wait rung immediately; the still-open
      // 300ms absorb budget must park OUTSIDE the provider lane before attempt 3.
      // 0, not 1: each park re-arms the deadline to now+N, so with 1ms a 429 decided
      // inside that same millisecond takes the slot-HOLDING rung (1) instead of the
      // park, and the /stats read below sees running=1 (the race behind WI-10003724).
      { requestAbsorbMs: 300, internalRetryDeadlineMs: 0 },
    );

    const pending = postResponses({ model: 'gpt-x', input: 'absorb me' });
    const observedUntil = Date.now() + 500;
    while (calls < 2 && Date.now() < observedUntil) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBeGreaterThanOrEqual(2);
    const stats = (await (await ask('/stats')).json()) as { codexAdmission: { running: number } };
    expect(stats.codexAdmission.running).toBe(0);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect((await res.json()) as { ok?: boolean }).toMatchObject({ ok: true });
  });
});

describe('proxyOpenAi — ChatGPT OAuth 401 refresh-and-retry (uncovered before P-004)', () => {
  /** A fresh, VALID access token that is distinguishable from any other. `freshJwt()`
   *  is deterministic within one second, and the refresh only takes effect when the
   *  on-disk token actually DIFFERS from the one in hand. */
  const jwtWith = (nonce: string) => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, nonce })}.sig`;
  };
  const writeAuth = (home: string, accountId: string, accessToken: string) =>
    fs.writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: accessToken, refresh_token: `refresh-${accountId}`, account_id: accountId },
      }),
    );

  const sse = () =>
    new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_refreshed', output: [] } })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  /** Boot a single-account ChatGPT OAuth gateway whose upstream 401s once, rewriting
   *  auth.json to `refreshed` before it does, then serves SSE. */
  async function bootOAuth401(opts: { pin?: 'hard' | 'soft'; persistentlyUnauthorized?: boolean } = {}) {
    const home = await makeCodexHome('chatgpt-a');
    const refreshed = jwtWith('refreshed');
    const bearers: string[] = [];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      routed.push(headers.get('chatgpt-account-id') ?? '');
      bearers.push(headers.get('authorization') ?? '');
      if (bearers.length === 1) {
        // The peer-refresh the gateway's own refresh call will pick up off disk.
        await writeAuth(home, 'chatgpt-a', refreshed);
        return new Response(JSON.stringify({ error: { message: 'expired token' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (opts.persistentlyUnauthorized) {
        return new Response(JSON.stringify({ error: { message: 'still unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sse();
    }) as typeof fetch;

    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexOAuthProxy: true,
      codexCliRun: async () => {
        throw new Error('the CLI bridge must not run: this is the transparent OAuth transport');
      },
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const headers: Record<string, string> = { [ACCOUNT_HEADER]: 'chatgpt-a' };
    if (opts.pin === 'hard') headers[ACCOUNT_PIN_HEADER] = 'hard';
    const res = await postResponses({ model: 'gpt-5.5', input: 'refresh me', stream: true }, headers);
    return { res, bearers, routed, refreshed };
  }

  it('refreshes the token and retries the SAME account, forwarding the native SSE', async () => {
    const { res, bearers, routed, refreshed } = await bootOAuth401();

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('resp_refreshed');
    // Same account both times — a refresh is a re-AUTH, never a re-ROUTE.
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-a']);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBeNull();
    // The retry carried the REFRESHED bearer, not the stale one.
    expect(bearers).toHaveLength(2);
    expect(bearers[0]).not.toBe(bearers[1]);
    expect(bearers[1]).toBe(`Bearer ${refreshed}`);
    // A same-account re-auth is not a failover and must not be counted as one.
    expect(gw!.stats().codex.failovers).toBe(0);
  });

  it('refreshes and retries even when the account is HARD-pinned (a re-auth is not a re-route)', async () => {
    // THE REGRESSION CATCHER. A hard pin forbids changing ACCOUNT; it must not forbid
    // re-authenticating the pinned one. If this 401 is ever expressed as a kernel
    // failover, `request-kernel.ts:491` returns null before the adapter is asked and
    // this test sees a bare 401 instead of the refreshed 200.
    const { res, bearers, routed, refreshed } = await bootOAuth401({ pin: 'hard' });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('resp_refreshed');
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-a']);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    expect(bearers[1]).toBe(`Bearer ${refreshed}`);
  });

  it('forwards a persistent 401 after exactly ONE refresh instead of looping', async () => {
    // `refreshedAccount !== cli.accountId` bounds the refresh to once per account, so a
    // credential the backend keeps rejecting is surfaced byte-transparently.
    const { res, bearers } = await bootOAuth401({ persistentlyUnauthorized: true });

    expect(res.status).toBe(401);
    expect(bearers).toHaveLength(2);
  });
});

describe('proxyOpenAi — ChatGPT OAuth initial account selection (D-010 catcher)', () => {
  it('serves an UNPINNED request from the pool FIRST account, advancing the pool exactly once', async () => {
    const homeA = await makeCodexHome('chatgpt-a');
    const homeB = await makeCodexHome('chatgpt-b');
    const cliAccounts = [
      { accountId: 'chatgpt-a', home: homeA },
      { accountId: 'chatgpt-b', home: homeB },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      routed.push(new Headers(init?.headers).get('chatgpt-account-id') ?? '');
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_first', output: [] } })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    // No ACCOUNT_HEADER: the pool picks. The live handler resolves `cli` ONCE above the
    // handler, so the first account serves. A second `active()` call anywhere in the
    // migrated path would make this 'chatgpt-b'.
    const res = await postResponses({ model: 'gpt-5.5', input: 'who serves me', stream: true });

    expect(res.status).toBe(200);
    expect(routed).toEqual(['chatgpt-a']);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    expect(res.headers.get(PIN_YIELDED_HEADER)).toBeNull();
  });

  it('uses restart-surviving health hints for the first unpinned ChatGPT OAuth account', async () => {
    const homeA = await makeCodexHome('chatgpt-walled');
    const homeB = await makeCodexHome('chatgpt-healthy');
    const cliAccounts = [
      { accountId: 'chatgpt-walled', home: homeA },
      { accountId: 'chatgpt-healthy', home: homeB },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      routed.push(new Headers(init?.headers).get('chatgpt-account-id') ?? '');
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_healthy', output: [] } })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    gw.setAccountRateHints([
      { accountId: 'chatgpt-walled', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000 },
      { accountId: 'chatgpt-healthy', utilization7d: 0.1, windowResetAt7d: Date.now() + 86_400_000 },
    ]);

    const res = await postResponses({ model: 'gpt-5.6-sol', input: 'who serves the cold start', stream: true });
    expect(res.status).toBe(200);
    expect(routed).toEqual(['chatgpt-healthy']);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-healthy');
  });

  it('uses the same preflight SOFT-pin liveness resolver on the transparent OAuth transport', async () => {
    const homeA = await makeCodexHome('chatgpt-a');
    const homeB = await makeCodexHome('chatgpt-b');
    const cliAccounts = [
      { accountId: 'chatgpt-a', home: homeA },
      { accountId: 'chatgpt-b', home: homeB },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      routed.push(new Headers(init?.headers).get('chatgpt-account-id') ?? '');
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_pin_health', output: [] } })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    gw.setAccountRateHints([{ accountId: 'chatgpt-a', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000 }]);

    const yielded = await postResponses(
      { model: 'gpt-5.6-sol', input: 'avoid the OAuth wall', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(yielded.status).toBe(200);
    await yielded.text();
    expect(routed).toEqual(['chatgpt-b']);
    expect(yielded.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
    expect(yielded.headers.get(PIN_YIELDED_HEADER)).toBe('chatgpt-a->chatgpt-b');

    gw.setAccountRateHints([]);
    const recovered = await postResponses(
      { model: 'gpt-5.6-sol', input: 'resume the OAuth pin', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a' },
    );
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(routed).toEqual(['chatgpt-b', 'chatgpt-a']);
    expect(recovered.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    expect(recovered.headers.get(PIN_YIELDED_HEADER)).toBeNull();
  });
});

describe('proxyOpenAi — health and self-heal control-plane parity', () => {
  it('routes automatically through a credit-backed full allowance and permits psu launch', async () => {
    await bootCodex(ok, [codexAcct('credited'), codexAcct('depleted')]);
    gw!.setAccountRateHints([
      { accountId: 'credited', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000, usageCreditsAvailable: true },
      { accountId: 'depleted', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000, usageCreditsAvailable: false },
    ]);
    const stats = gw!.stats();
    expect(stats.codexHealthyAccounts).toBe(1);
    expect(stats.codexEarliestRecoveryAt).toBe(0);
    const { codexAutoPoolVerdict } = await import('../../../../apps/operator/scripts/psu-launcher.mjs');
    expect(codexAutoPoolVerdict({ agent: 'codex', account: 'auto', stats }).kind).toBe('proceed');
    const response = await postResponses({ model: 'gpt-6.1-sol', input: 'credit-backed automatic routing' });
    expect(response.status).toBe(200);
    expect(response.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('credited');
    await response.text();
  });

  it('preserves real pauses and never-metered exclusions despite available credits', async () => {
    await bootCodex(ok, [codexAcct('paused'), { ...codexAcct('never-metered'), meteredPolicy: 'never' }]);
    gw!.setAccountRateHints([
      { accountId: 'paused', utilization7d: 1, pausedUntil: Date.now() + 60_000, usageCreditsAvailable: true },
      { accountId: 'never-metered', utilization7d: 1, usageCreditsAvailable: true },
    ]);
    expect(gw!.stats().codexHealthyAccounts).toBe(0);
  });

  it('surfaces the Codex pool denominator and earliest recovery horizon for launch preflight', () => {
    const now = Date.UTC(2026, 8, 5, 20, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const codexPool = createFailoverPool([codexAcct('cdx-1'), codexAcct('cdx-2')]);
    codexPool.onExhausted('cdx-1', now + 60_000);
    codexPool.onExhausted('cdx-2', now + 120_000);
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexPool,
      selfHeal: { enabled: false },
    });

    expect(gw.stats()).toMatchObject({
      codexHealthyAccounts: 0,
      codexTotalAccounts: 2,
      codexEarliestRecoveryAt: now + 60_000,
    });

    codexPool.readmit?.('cdx-1', { reason: 'admin' });
    expect(gw.stats()).toMatchObject({
      codexHealthyAccounts: 1,
      codexTotalAccounts: 2,
      codexEarliestRecoveryAt: 0,
    });
  });

  it('counts only Codex accounts the automatic selector can serve under durable usage walls', () => {
    const now = Date.UTC(2026, 8, 27, 7, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const bearerPool = createFailoverPool([codexAcct('bearer-walled'), codexAcct('bearer-healthy')]);
    const cliAccounts = [
      { accountId: 'cli-walled', home: '/tmp/cli-walled' },
      { accountId: 'cli-healthy', home: '/tmp/cli-healthy' },
    ];
    const cliPool = createFailoverPool(cliAccounts.map(({ accountId }) => codexAcct(accountId)));
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexPool: bearerPool,
      codexCliAccounts: () => cliAccounts,
      codexCliPool: cliPool,
      selfHeal: { enabled: false },
    });

    gw.setAccountRateHints([
      { accountId: 'bearer-walled', utilization7d: 1, windowResetAt7d: now + 60_000 },
      { accountId: 'bearer-healthy', utilization7d: 0.2, windowResetAt7d: now + 60_000 },
      { accountId: 'cli-walled', utilization7d: 1, windowResetAt7d: now + 120_000 },
      { accountId: 'cli-healthy', utilization7d: 0.2, windowResetAt7d: now + 120_000 },
    ]);
    expect(gw.stats()).toMatchObject({
      codexHealthyAccounts: 2,
      codexTotalAccounts: 4,
      codexEarliestRecoveryAt: 0,
    });

    gw.setAccountRateHints([
      { accountId: 'bearer-walled', utilization7d: 1, windowResetAt7d: now + 60_000 },
      { accountId: 'bearer-healthy', utilization7d: 1, windowResetAt7d: now + 90_000 },
      { accountId: 'cli-walled', utilization7d: 1, windowResetAt7d: now + 120_000 },
      { accountId: 'cli-healthy', utilization7d: 1, windowResetAt7d: now + 150_000 },
    ]);
    expect(gw.stats()).toMatchObject({
      codexHealthyAccounts: 0,
      codexTotalAccounts: 4,
      codexEarliestRecoveryAt: now + 60_000,
    });
  });

  it('surfaces Codex admission/health in live config, includes ChatGPT egress, and readmits a paused Codex account', async () => {
    openaiUpstream = await startUpstream(ok);
    const codexPool = createFailoverPool([
      { ...codexAcct('cdx-1'), egress: { proxyUrl: 'http://127.0.0.1:19001' } },
      codexAcct('cdx-2'),
    ]);
    codexPool.onExhausted('cdx-1', Date.now() + 60_000);
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      upstreamBase: openaiUpstream.base,
      openaiUpstreamBase: openaiUpstream.base,
      codexPool,
      token: async () => 'claude-tok',
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      proactiveEgressProbeMs: 0,
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const before = gw.stats();
    expect(before.codexHealthyAccounts).toBe(1);
    expect(before.egressProxyHealth).toMatchObject({
      configured: true,
      totalProxyEntries: 1,
      reachableProxyEntries: 1,
    });
    expect(before.edgeThrottleByAccount).toHaveProperty('cdx-1');

    const config = (await (await ask('/admin/config')).json()) as {
      codexAdmission?: { maxConcurrent: number };
      codexAimd?: { cap: number };
      codexHealthyAccounts?: number;
    };
    expect(config.codexAdmission?.maxConcurrent).toBeGreaterThan(0);
    expect(config.codexAimd?.cap).toBeGreaterThan(0);
    expect(config.codexHealthyAccounts).toBe(1);

    const readmit = await ask('/admin/readmit?provider=codex&account=cdx-1', { method: 'POST' });
    expect(readmit.status).toBe(200);
    expect(await readmit.json()).toMatchObject({
      ok: true,
      provider: 'codex',
      readmitted: ['cdx-1'],
      healthyAccounts: 2,
    });
    expect(gw.stats().codexHealthyAccounts).toBe(2);
  });

  it('tracks and reclaims a wedged Codex slot against the Codex cap without waiting for Claude saturation', async () => {
    let attempts = 0;
    let firstUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => {
      firstUpstreamStarted = resolve;
    });
    await bootCodex(
      () => {
        /* fetchImpl below is the upstream seam */
      },
      [codexAcct('cdx-solo')],
      {
        // P-010: the lanes no longer take different sizes, so scarcity is expressed by
        // the ONE shared seed. A 1-slot seed still makes the wedged Codex request
        // saturate the Codex lane — which is this test's actual subject — while the
        // Claude lane, sized identically, stays at running:0 and is never consulted.
        concurrency: 1,
        selfHeal: { enabled: true, freezeMs: 40, pollMs: 10 },
        requestCeilingMs: 5_000,
        upstreamHeadersTimeoutMs: 5_000,
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          attempts++;
          if (attempts > 1) {
            return new Response(JSON.stringify({ ok: true, attempt: attempts }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          firstUpstreamStarted();
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            const abort = () => reject(new Error('first Codex upstream aborted'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          });
        }) as typeof fetch,
      },
    );

    const wedged = postResponses({ model: 'gpt-x', input: 'hold', stream: true }).catch((e) => e);
    await upstreamStarted;
    expect(gw!.stats()).toMatchObject({
      inFlight: 1,
      inFlightTracked: 1,
      // Both lanes are sized identically now; the ISOLATION claim is carried by the
      // running counts — the wedge is held on Codex and the Claude lane is untouched.
      admission: { running: 0, maxConcurrent: 1 },
      codexAdmission: { running: 1, maxConcurrent: 1 },
    });

    const queued = postResponses({ model: 'gpt-x', input: 'must be released', stream: true });
    const served = await queued;
    expect(served.status).toBe(200);
    expect(await served.json()).toMatchObject({ ok: true, attempt: 2 });
    await wedged;
    await vi.waitFor(() => {
      expect(gw!.stats().selfHealReclaims).toBeGreaterThanOrEqual(1);
      expect(gw!.stats().inFlight).toBe(0);
      expect(gw!.stats().inFlightTracked).toBe(0);
    });
  });
});

describe('proxyOpenAi — route isolation from the Claude proxy', () => {
  it('/v1/responses hits the OpenAI upstream with codex creds; /v1/messages hits the Claude upstream with claude creds', async () => {
    openaiUpstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'openai' }));
    });
    claudeUpstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'claude' }));
    });
    const codexPool = createFailoverPool([codexAcct('cdx-1')]);
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      upstreamBase: claudeUpstream.base,
      openaiUpstreamBase: openaiUpstream.base,
      codexPool,
      token: async () => 'claude-tok',
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const codexRes = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(((await codexRes.json()) as { from?: string }).from).toBe('openai');
    expect(openaiUpstream.last.headers['authorization']).toBe('Bearer cdx-1-tok');

    const claudeRes = await ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [] }),
    });
    expect(((await claudeRes.json()) as { from?: string }).from).toBe('claude');
    // the Claude path injects the claude bearer + the oauth beta (NOT a codex token)
    expect(claudeUpstream.last.headers['authorization']).toBe('Bearer claude-tok');
    expect(String(claudeUpstream.last.headers['anthropic-beta'])).toContain('oauth-2025-04-20');
  });
});

describe('proxyOpenAi — stream-stall guards (parity with the Claude proxy)', () => {
  // A server that accepts the request but NEVER responds (headers never arrive).
  const hangHeaders = () => {
    /* never write/end — the upstream stalls before sending response headers */
  };
  // A single-account codex pool so a stall makes exactly ONE attempt (no rotate) → deterministic timing.
  const solo = () => [codexAcct('cdx-solo')];

  it('a stream:true request aborts at the SHORT TTFB deadline, not the generous one (no slot squat)', async () => {
    await bootCodex(hangHeaders, solo(), {
      upstreamHeadersTimeoutMs: 1000, // generous (non-stream)
      upstreamStreamHeadersTimeoutMs: 150, // short TTFB for streams
    });
    const start = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi', stream: true });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(502); // single-account stall → forwarded as 502
    // It must abort at ~150ms (stream TTFB), well under the 1000ms generous deadline.
    expect(elapsed).toBeLessThan(700);
  });

  it('a NON-stream request keeps the GENEROUS headers deadline (regression guard — streams must not shorten it)', async () => {
    await bootCodex(hangHeaders, solo(), {
      upstreamHeadersTimeoutMs: 1000,
      upstreamStreamHeadersTimeoutMs: 150,
    });
    const start = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }); // no stream
    const elapsed = Date.now() - start;
    expect(res.status).toBe(502);
    // It must wait the generous ~1000ms, NOT the 150ms stream TTFB.
    expect(elapsed).toBeGreaterThan(700);
  });

  it('a mid-stream upstream BODY stall is aborted by the body-idle guard (not left to the slow downstream-idle backstop)', async () => {
    // Upstream: send 200 + headers + ONE chunk, then hang forever (never end, never send more).
    await bootCodex(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"response.created"}\n\n');
        // ...then stall mid-stream (no more bytes, no end).
      },
      solo(),
      {
        upstreamHeadersTimeoutMs: 2000,
        upstreamStreamHeadersTimeoutMs: 2000, // headers arrive instantly — not the limiting factor here
        upstreamBodyIdleTimeoutMs: 200, // the guard under test
        downstreamIdleMs: 3000, // the OLD-path backstop — high, so only a real body-idle guard is fast
      },
    );
    vi.useFakeTimers();
    const res = await postResponses({ model: 'gpt-x', input: 'hi', stream: true });
    expect(res.status).toBe(200); // headers forwarded, then upstream stalls
    const body = res.text().catch(() => 'destroyed');
    // Drive the gateway's body-idle timer deterministically. The downstream-idle
    // backstop is 3000ms, so advancing only the 200ms body-idle window proves the
    // upstream-body guard, not the slow client backstop, tears the stream down.
    await vi.advanceTimersByTimeAsync(201);
    await expect(body).resolves.toBeDefined();
  });

  it('aborts the upstream OpenAI request when the downstream client disconnects before headers', async () => {
    let upstreamAborted = false;
    await bootCodex(
      () => {
        /* fetchImpl below replaces the real upstream */
      },
      solo(),
      {
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          await new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            signal?.addEventListener(
              'abort',
              () => {
                upstreamAborted = true;
                reject(new Error('upstream aborted'));
              },
              { once: true },
            );
          });
          throw new Error('unreachable');
        }) as typeof fetch,
        upstreamHeadersTimeoutMs: 5000,
      },
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const clientReq = ask('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', input: 'hi' }),
      signal: ac.signal,
    }).catch((e) => e);
    await clientReq;
    await new Promise((r) => setTimeout(r, 50));
    expect(upstreamAborted).toBe(true);
  });

  it('hard-ceilings a non-streaming OpenAI request before the generous headers timeout', async () => {
    let upstreamAborted = false;
    await bootCodex(
      () => {
        /* fetchImpl below replaces the real upstream */
      },
      solo(),
      {
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          await new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            signal?.addEventListener(
              'abort',
              () => {
                upstreamAborted = true;
                reject(new Error('upstream ceiling abort'));
              },
              { once: true },
            );
          });
          throw new Error('unreachable');
        }) as typeof fetch,
        requestCeilingMs: 80,
        upstreamHeadersTimeoutMs: 5_000,
      },
    );

    const started = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }).catch((e) => e);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(upstreamAborted).toBe(true);
    if (res instanceof Response) {
      expect([502, 503]).toContain(res.status);
    }
  });
});

/**
 * CHARACTERIZATION GOLDENS — plan gateway-kernel-adoption-2026-08-29, P-001 (D-003).
 *
 * These pin the two behaviours the census (that plan's D-005) found UNPINNED before
 * `proxyOpenAi` migrates onto `executeGatewayRequestKernel`. They are deliberately
 * written against the CURRENT hand-rolled ladder and MUST pass unchanged after the
 * migration — that is the whole point of a before/after golden. If a kernel migration
 * makes one of these fail, the migration changed observable behaviour and is wrong,
 * not the test.
 */
describe('proxyOpenAi — transport-failure failover (the untested route-around branch)', () => {
  // A transport failure is NOT an HTTP error status: the upstream socket dies so the
  // gateway's own fetch REJECTS. gateway.ts handles this in a dedicated catch that
  // records `upstream_error` with detail 'bearer-transport', invalidates the account
  // token, and then rotates rather than surfacing — the same "route around, don't
  // surface" class the Claude path was hardened against. Nothing covered it.
  const killSocketOnce = () => {
    let hits = 0;
    return {
      hits: () => hits,
      reply: (req: http.IncomingMessage, res: http.ServerResponse) => {
        hits += 1;
        if (hits === 1) {
          req.socket.destroy();
          return;
        }
        ok(req, res);
      },
    };
  };

  it('a dead upstream socket ROTATES to another codex account + retries — the bee gets the 200, not a 502', async () => {
    const upstream = killSocketOnce();
    await bootCodex(upstream.reply);

    const res = await postResponses({ model: 'gpt-5', input: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
    expect(upstream.hits()).toBe(2);
  });

  it('invalidates the failed account token so a stale bearer is never reused on the retry', async () => {
    const invalidated: string[] = [];
    const spyAcct = (id: string): ActiveAccount => ({
      accountId: id,
      token: async () => `${id}-tok`,
      invalidateToken: () => {
        invalidated.push(id);
      },
    });
    const upstream = killSocketOnce();
    await bootCodex(upstream.reply, [spyAcct('cdx-1'), spyAcct('cdx-2')]);

    const res = await postResponses({ model: 'gpt-5', input: 'hi' });

    expect(res.status).toBe(200);
    expect(invalidated).toEqual(['cdx-1']);
  });

  it('a SINGLE-account pool with a dead upstream returns the 502 gateway envelope (no rotate target → no hang/loop)', async () => {
    await bootCodex((req) => req.socket.destroy(), [codexAcct('cdx-solo')]);

    const res = await postResponses({ model: 'gpt-5', input: 'hi' });

    expect(res.status).toBe(502);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-solo');
    const body = (await res.json()) as { gateway?: boolean; error?: { type?: string; message?: string } };
    expect(body.gateway).toBe(true);
    expect(body.error?.type).toBe('api_error');
    expect(body.error?.message).toContain('Codex upstream failed');
  });
});

describe('proxyOpenAi — owner-outcome taxonomy (pinned directly, not via response headers)', () => {
  // `recordOwnerOutcome` early-returns when there is no owner id, which is exactly why
  // this taxonomy went uncovered: every existing test posts without an owner header and
  // asserts on response headers instead. The kernel re-routes all five outcomes through
  // `classifyGatewayTelemetryOutcome`, so without these the taxonomy could shift silently.
  interface OwnerLedger {
    requests: number;
    ok: number;
    upstreamErrors: number;
    upstream429: number;
    pinYields: number;
    lastAccount: string | null;
    lastStatus: number | null;
    recent: { kind: string; account: string | null; detail?: string }[];
  }
  const ledgerFor = async (owner: string): Promise<OwnerLedger> => {
    const res = await ask(`/admin/owner-report?owner=${encodeURIComponent(owner)}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { ledger: OwnerLedger }).ledger;
  };

  it('keeps a durable report failure distinct from a successful upstream turn', async () => {
    const report = vi.fn().mockRejectedValue(new Error('outcome storage unavailable'));
    await bootCodex(ok, undefined, {
      requestOutcomeStore: { record: async () => {}, report },
    });

    const response = await postResponses({ model: 'gpt-5', input: 'hi' }, { [OWNER_HEADER]: 'bee-store-down' });
    expect(response.status).toBe(200);
    await response.text();

    const ownerReport = await ask('/admin/owner-report?owner=bee-store-down');
    expect(ownerReport.status).toBe(503);
    expect(await ownerReport.json()).toEqual({
      ok: false, error: 'durable request outcome report unavailable', owner: 'bee-store-down',
    });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'bee-store-down' }));
  });

  it('a clean turn records one request + one ok, with the routed account and status', async () => {
    await bootCodex(ok);

    const res = await postResponses({ model: 'gpt-5', input: 'hi' }, { [OWNER_HEADER]: 'bee-clean' });
    expect(res.status).toBe(200);

    const ledger = await ledgerFor('bee-clean');
    expect(ledger.requests).toBe(1);
    expect(ledger.ok).toBe(1);
    expect(ledger.upstreamErrors).toBe(0);
    expect(ledger.upstream429).toBe(0);
    expect(ledger.lastAccount).toBe('cdx-1');
    expect(ledger.lastStatus).toBe(200);
  });

  it('a dead upstream socket records upstream_error with detail bearer-transport, then ok on the rotated account', async () => {
    let hits = 0;
    await bootCodex((req, res) => {
      hits += 1;
      if (hits === 1) {
        req.socket.destroy();
        return;
      }
      ok(req, res);
    });

    const res = await postResponses({ model: 'gpt-5', input: 'hi' }, { [OWNER_HEADER]: 'bee-transport' });
    expect(res.status).toBe(200);

    const ledger = await ledgerFor('bee-transport');
    expect(ledger.requests).toBe(1);
    expect(ledger.upstreamErrors).toBe(1);
    expect(ledger.ok).toBe(1);
    expect(ledger.recent.map((entry) => entry.kind)).toEqual(['upstream_error', 'ok']);
    expect(ledger.recent[0].detail).toBe('bearer-transport');
    expect(ledger.recent[0].account).toBe('cdx-1');
    expect(ledger.recent[1].account).toBe('cdx-2');
  });

  it('a 429 records upstream_429 against the throttled account, then ok against the rotated one', async () => {
    let hits = 0;
    await bootCodex((req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: 'slow down' }));
        return;
      }
      ok(req, res);
    });

    const res = await postResponses({ model: 'gpt-5', input: 'hi' }, { [OWNER_HEADER]: 'bee-throttled' });
    expect(res.status).toBe(200);

    const ledger = await ledgerFor('bee-throttled');
    expect(ledger.upstream429).toBe(1);
    expect(ledger.ok).toBe(1);
    expect(ledger.recent.map((entry) => entry.kind)).toEqual(['upstream_429', 'ok']);
    expect(ledger.recent[0].account).toBe('cdx-1');

    const quality = gw!.stats().routingQuality!;
    expect(quality.picks).toBe(1);
    expect(quality.upstream429s).toBe(1);
    expect(quality.upstream429PerPick).toBe(1);
    expect(quality.byProvider.codex.upstream429PerPick).toBe(1);
    expect(quality.byProvider.codex.byAccount['cdx-1']).toEqual({
      picks: 1,
      upstream429s: 1,
      upstream429PerPick: 1,
    });
    const report = (await (await ask('/admin/owner-report?owner=bee-throttled')).json()) as {
      routingQuality: { recentScope: string | null; recent: Array<{ owner: string | null; selectedAccount: string }> };
    };
    expect(report.routingQuality.recentScope).toBe('bee-throttled');
    expect(report.routingQuality.recent).toEqual([
      expect.objectContaining({ owner: 'bee-throttled', selectedAccount: 'cdx-1' }),
    ]);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * P-005 characterization — the `cli-exec` transport (`serveCodexCliBridge`).
 *
 * WHY THESE AND NOT MORE: gateway.test.ts already carries eight `[codex-cli]`
 * tests, but all eight are about SELECTION and the wire (pin-vs-pool priority,
 * the early-SSE open + keepalive, GET /v1/models, the single-account 502, the
 * no-account 503). None of them touches the ATTEMPT LADDER, which is precisely
 * the part a kernel migration replaces. Everything below is that gap, pinned
 * against the UNMIGRATED handler first, in plan D-003 order.
 *
 * Note the ladder here is NOT the bearer ladder with different names: the
 * quarantine is unconditional for an auth-class failure and outlives the
 * request, which is the fix EI-21618978789879488 landed with NO regression test
 * — the reason `an auth-dead account is not re-chosen` below exists at all.
 * ────────────────────────────────────────────────────────────────────────────── */
describe('codex cli-exec bridge — attempt ladder (P-005 characterization)', () => {
  /** A cli-exec gateway: codex-cli accounts + their failover pool, and NO bearer
   *  codexPool, which is what routes `/v1/responses` to the bridge at all. */
  async function bootCliBridge(opts: {
    accounts: string[];
    run: (o: { home: string }) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
    oauthProxy?: boolean;
    oauthNonStream?: boolean;
    bare429FailoverBackoffMs?: number;
  }) {
    const cliAccounts = opts.accounts.map((accountId) => ({ accountId, home: `/tmp/${accountId}-home` }));
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool(cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' }))),
      codexCliRun: opts.run as never,
      ...(opts.oauthProxy === undefined ? {} : { codexOAuthProxy: opts.oauthProxy }),
      ...(opts.oauthNonStream === undefined ? {} : { codexOAuthNonStream: opts.oauthNonStream }),
      ...(opts.bare429FailoverBackoffMs === undefined
        ? {}
        : { bare429FailoverBackoffMs: opts.bare429FailoverBackoffMs }),
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);
    return cliAccounts;
  }

  /** Resolve which account a run was for from the home path `bootCliBridge` mints. */
  const acctOf = (home: string) => home.replace('/tmp/', '').replace('-home', '');

  it('fails over to the next CLI account when a run fails, and counts it as a failover', async () => {
    const seen: string[] = [];
    await bootCliBridge({
      accounts: ['cli-a', 'cli-b'],
      run: async ({ home }) => {
        const acct = acctOf(home);
        seen.push(acct);
        if (acct === 'cli-a') throw new Error('codex exited 1: transient upstream blip');
        return { text: 'SERVED BY B', inputTokens: 1, outputTokens: 1 };
      },
    });

    const res = await postResponses({ model: 'gpt-5.4', input: 'hi' });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['cli-a', 'cli-b']);
    // The header reports who ACTUALLY served it, not who was chosen first.
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cli-b');
    expect(await res.text()).toContain('SERVED BY B');
    // An account CHANGE is the thing that counts as a failover on this lane.
    expect(gw!.stats().codex.failovers).toBe(1);
  });

  it('a HARD pin suppresses cli-exec failover — the failure is forwarded on the pinned account', async () => {
    const seen: string[] = [];
    await bootCliBridge({
      accounts: ['cli-a', 'cli-b'],
      run: async ({ home }) => {
        seen.push(acctOf(home));
        throw new Error('codex exited 1: transient upstream blip');
      },
    });

    const res = await postResponses(
      { model: 'gpt-5.4', input: 'hi' },
      { [ACCOUNT_HEADER]: 'cli-a', [ACCOUNT_PIN_HEADER]: 'hard' },
    );
    expect(res.status).toBe(502);
    // Exactly ONE attempt: a hard pin forbids leaving the account, and this lane has
    // no same-account re-attempt to fall back on (contrast the OAuth lane's refresh).
    expect(seen).toEqual(['cli-a']);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cli-a');
    expect(gw!.stats().codex.failovers).toBe(0);
  });

  it('a terminal cli-exec usage wall is shaped as 429 and attributed to the stall-waker', async () => {
    await bootCliBridge({
      accounts: ['cli-walled'],
      run: async () => {
        throw new Error("codex exited 1: You've hit your usage limit · resets 3am");
      },
    });

    const res = await postResponses(
      { model: 'gpt-5.4', input: 'hi', stream: false },
      { [ACCOUNT_HEADER]: 'cli-walled', [ACCOUNT_PIN_HEADER]: 'hard', [OWNER_HEADER]: 'su-cli-stall-test' },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get(RETRIES_EXHAUSTED_HEADER)).toMatch(/^\d+$/);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cli-walled');
    const body = (await res.json()) as { error?: { type?: string }; gateway?: boolean };
    expect(body.error?.type).toBe('rate_limit_error');
    expect(body.gateway).toBe(true);

    const stalls = (await (await ask('/admin/stalls?since=0')).json()) as {
      stalls: Array<{ ownerId: string; accountId: string }>;
    };
    expect(stalls.stalls).toContainEqual(
      expect.objectContaining({ ownerId: 'su-cli-stall-test', accountId: 'cli-walled' }),
    );
  });

  it('an AUTH-DEAD account is quarantined and not re-chosen on the NEXT request (EI-21618978789879488)', async () => {
    const seen: string[] = [];
    await bootCliBridge({
      accounts: ['cli-dead', 'cli-good'],
      run: async ({ home }) => {
        const acct = acctOf(home);
        seen.push(acct);
        // Auth-class, NOT a quota wall — `isCodexAuthFailure` separates the two.
        if (acct === 'cli-dead') throw new Error('codex exited 1: 401 unauthorized — please run `codex login`');
        return { text: 'GOOD', inputTokens: 1, outputTokens: 1 };
      },
    });

    const first = await postResponses({ model: 'gpt-5.4', input: 'one' });
    expect(first.status).toBe(200);
    expect(first.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cli-good');
    expect(seen).toEqual(['cli-dead', 'cli-good']);

    // THE REGRESSION CATCHER. Before the fix, `available` only ever described QUOTA, so a
    // home whose auth.json cannot authenticate stayed fully selectable and was re-chosen on
    // the very next request, forever. The quarantine has to outlive the request that found it.
    const second = await postResponses({ model: 'gpt-5.4', input: 'two' });
    expect(second.status).toBe(200);
    expect(second.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cli-good');
    expect(seen).toEqual(['cli-dead', 'cli-good', 'cli-good']);
  });

  it('CONTROL: a QUOTA wall is not credential death — the account returns once its short backoff lapses', async () => {
    // This is the calibration case for the test above, and it is why that one is not
    // vacuous. BOTH failure classes call `onExhausted`, so "the account was skipped on
    // the next request" alone proves nothing — the two differ only in DURATION
    // (bare429FailoverBackoffMs vs the 15-minute CODEX_CLI_AUTH_QUARANTINE_MS). Driving
    // the 429 backoff to ~nothing makes that difference observable: a quota-walled
    // account comes BACK, an auth-dead one does not. If this control ever starts
    // behaving like the auth case, the auth golden has stopped measuring quarantine.
    const seen: string[] = [];
    let walled = true;
    await bootCliBridge({
      accounts: ['cli-walled', 'cli-good'],
      bare429FailoverBackoffMs: 1,
      run: async ({ home }) => {
        const acct = acctOf(home);
        seen.push(acct);
        // A usage wall — `isCodexAuthFailure` returns false for this, by design.
        if (acct === 'cli-walled' && walled) throw new Error('codex exited 1: usage limit reached, try again later');
        return { text: `SERVED BY ${acct}`, inputTokens: 1, outputTokens: 1 };
      },
    });

    const first = await postResponses({ model: 'gpt-5.4', input: 'one' });
    expect(first.status).toBe(200);
    expect(first.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cli-good');
    expect(seen).toEqual(['cli-walled', 'cli-good']);

    // Let the 1ms 429 backoff lapse, then clear the wall: the account is selectable again.
    walled = false;
    await new Promise((r) => setTimeout(r, 25));
    const second = await postResponses({ model: 'gpt-5.4', input: 'two' });
    expect(second.status).toBe(200);
    // The walled account is back in rotation — the exclusion was a short backoff, not a quarantine.
    expect(seen.slice(2)).toContain('cli-walled');
  });

  it('once the SSE stream is committed, a terminal failure travels IN-BAND, not as a status code', async () => {
    await bootCliBridge({
      accounts: ['cli-only'],
      run: async () => {
        throw new Error('codex exited 1: transient upstream blip');
      },
    });

    const res = await postResponses({ model: 'gpt-5.4', input: 'hi', stream: true });
    // The 200 was committed by `openSse()` BEFORE the run — the failure cannot change it.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await res.text();
    expect(body).toContain('event: response.created');
    expect(body).toContain('event: error');
    expect(body).toContain('codex-cli bridge failed');
    // Terminating the frame properly is what stops a client retrying blindly against
    // what would otherwise be indistinguishable from a network drop.
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('the OAuth non-stream kill-switch hands an ALREADY-READ body to the bridge (the live-reachable cli-exec entry)', async () => {
    let sawPrompt = '';
    await bootCliBridge({
      accounts: ['cli-a'],
      // With the OAuth proxy ON, this is the ONLY way cli-exec is reached: a
      // non-streaming request with PAPERCUSP_GATEWAY_CODEX_OAUTH_NONSTREAM=0.
      oauthProxy: true,
      oauthNonStream: false,
      run: async (o) => {
        sawPrompt = (o as { prompt?: string }).prompt ?? '';
        return { text: 'VIA PREBODY', inputTokens: 1, outputTokens: 1 };
      },
    });

    const res = await postResponses({ model: 'gpt-5.4', input: 'carried body', instructions: 'be terse' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('VIA PREBODY');
    // The handover must preserve the body: instructions are prepended to the input.
    expect(sawPrompt).toBe('be terse\n\ncarried body');
  });
});

/*
 * Plan `codex-auto-route-all-walled-fail-fast-2026-09-05` (D-001): every auto-routed codex request
 * hung ~2 minutes on a pool whose earliest reset was ~3h out, because the outer ladder's absorb
 * slept the whole budget toward the FAILED ACCOUNT's reset instead of asking the POOL when it
 * could next serve; and a transport-probe readmit cleared 7d usage walls, so the fleet re-burned
 * every walled account. These pin the fixed decision end-to-end through the real handler.
 */
describe('proxyOpenAi — pool recovery horizon + store↔pool reconciliation (codex-auto-route-all-walled-fail-fast-2026-09-05)', () => {
  const walled429 = (resetAfterSec: number) =>
    new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-after-seconds': String(resetAfterSec),
      },
    });
  const burst429 = (retryAfter: string) =>
    new Response(JSON.stringify({ error: { message: 'brief burst' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
    });
  const sse200 = () =>
    new Response(`data: ${JSON.stringify(completedCodexResponse())}\n\ndata: [DONE]\n\n`, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  const accountOf = (init?: RequestInit) =>
    new Headers((init?.headers ?? {}) as HeadersInit).get('chatgpt-account-id') ?? '';

  async function bootOAuthPair(fetchImpl: typeof fetch, gwOpts: Partial<Parameters<typeof createInferenceGateway>[0]>) {
    const homeA = await makeCodexHome('chatgpt-a');
    const homeB = await makeCodexHome('chatgpt-b');
    const cliAccounts = [
      { accountId: 'chatgpt-a', home: homeA },
      { accountId: 'chatgpt-b', home: homeB },
    ];
    const codexCliPool = createFailoverPool(
      cliAccounts.map((a) => ({ accountId: a.accountId, token: async () => '' })),
    );
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool,
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
      ...gwOpts,
    });
    port = await gw.listen(0);
    return codexCliPool;
  }

  it('an ALL-WALLED OAuth pool FAILS FAST: terminal 429 without sleeping the absorb budget, pool horizon on the wire + in the stall', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(accountOf(init));
      return walled429(2 * 86_400); // every account's 7d window resets in ~2 days
    }) as typeof fetch;
    // The absorb is ON with the production-shaped 2-minute budget: pre-fix, the ladder slept this
    // entire budget on an all-walled pool before forwarding (the owner-measured hang).
    await bootOAuthPair(fetchImpl, { requestAbsorbMs: 120_000 });

    const before = Date.now();
    const res = await postResponses(
      { model: 'gpt-5.5', input: 'hi', stream: true },
      { [OWNER_HEADER]: 'su-all-walled' },
    );
    const elapsedMs = Date.now() - before;
    expect(res.status).toBe(429);
    expect(elapsedMs).toBeLessThan(10_000);
    // The kernel ladder rotated across the pool once; the outer ladder did not absorb + re-enter.
    expect(new Set(seen)).toEqual(new Set(['chatgpt-a', 'chatgpt-b']));
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get(RETRIES_EXHAUSTED_HEADER)).toMatch(/^\d+$/);
    const horizon = res.headers.get(POOL_RECOVERY_AT_HEADER);
    expect(horizon).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(horizon!)).toBeGreaterThan(before + 1.9 * 86_400_000);

    // The stall carries the POOL horizon, so the stall-waker's capacity gate waits for real capacity.
    const stalls = (await (await ask('/admin/stalls?since=0')).json()) as {
      stalls: Array<{ ownerId: string; soonestResetAt: number }>;
    };
    const mine = stalls.stalls.find((s) => s.ownerId === 'su-all-walled');
    expect(mine).toBeDefined();
    expect(mine!.soonestResetAt).toBeGreaterThan(before + 1.9 * 86_400_000);
  });

  it("absorbs toward the POOL horizon: a sibling whose park expires in ~150ms is re-picked, not the failed account's 2h reset", async () => {
    let aCalls = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = accountOf(init);
      if (account === 'chatgpt-a') {
        aCalls += 1;
        return aCalls === 1 ? burst429('150ms') : sse200();
      }
      return walled429(7_200); // chatgpt-b: a 2h wall — the LAST account the kernel tries
    }) as typeof fetch;
    // Budget 2s: pre-fix the absorb slept min(budget, failed-account reset = 2h) = the full 2s.
    await bootOAuthPair(fetchImpl, { requestAbsorbMs: 2_000, internalRetryDeadlineMs: 1 });

    const before = Date.now();
    const res = await postResponses({ model: 'gpt-5.5', input: 'recover via a', stream: true });
    const elapsedMs = Date.now() - before;
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"response.completed"');
    expect(body).toContain('[DONE]');
    expect(aCalls).toBe(2);
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-a');
    // Slept ~150ms toward a's park expiry — NOT the 2s budget b's 2h reset would have forced.
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it("a HARD pin to a walled account fails fast on that account's own horizon even though a sibling could serve", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(accountOf(init));
      return accountOf(init) === 'chatgpt-a' ? walled429(7_200) : sse200();
    }) as typeof fetch;
    await bootOAuthPair(fetchImpl, { requestAbsorbMs: 120_000 });

    const before = Date.now();
    const res = await postResponses(
      { model: 'gpt-5.5', input: 'hi', stream: true },
      { [ACCOUNT_HEADER]: 'chatgpt-a', [ACCOUNT_PIN_HEADER]: 'hard' },
    );
    expect(res.status).toBe(429);
    expect(Date.now() - before).toBeLessThan(10_000);
    expect(seen.every((a) => a === 'chatgpt-a')).toBe(true);
    expect(Date.parse(res.headers.get(POOL_RECOVERY_AT_HEADER)!)).toBeGreaterThan(before + 3_600_000);
  });

  it('STORE↔POOL: a store reading NEWER than a park that reports capacity readmits it; a stale or still-walled reading leaves the park', async () => {
    const codexPool = createFailoverPool([codexAcct('cdx-1'), codexAcct('cdx-2')]);
    await bootCodex(ok, [codexAcct('cdx-1'), codexAcct('cdx-2')], { codexPool });
    const parkedAt = Date.now();
    codexPool.onExhausted('cdx-1', parkedAt + 7 * 86_400_000); // a 7d 429 parked it in THIS process
    expect(codexPool.parkState!('cdx-1')).toBeDefined();

    // (1) A reading OLDER than the park says nothing about whether the park's cause cleared.
    gw!.setAccountRateHints([{ accountId: 'cdx-1', utilization7d: 0.1, readingAt: parkedAt - 60_000 }]);
    expect(codexPool.parkState!('cdx-1')).toBeDefined();
    // (2) A fresh reading that still reports the wall keeps the park.
    gw!.setAccountRateHints([
      { accountId: 'cdx-1', utilization7d: 1, windowResetAt7d: parkedAt + 86_400_000, readingAt: parkedAt + 1_000 },
    ]);
    expect(codexPool.parkState!('cdx-1')).toBeDefined();
    // (3) A fresh SHED or exhausted reading remains a wall even when its recovery time is unknown.
    //     An absent reset is not evidence that the account is serviceable.
    gw!.setAccountRateHints([{ accountId: 'cdx-1', burnAction: 'shed', readingAt: parkedAt + 2_000 }]);
    expect(codexPool.parkState!('cdx-1')).toBeDefined();
    gw!.setAccountRateHints([{ accountId: 'cdx-1', utilization7d: 1, readingAt: parkedAt + 3_000 }]);
    expect(codexPool.parkState!('cdx-1')).toBeDefined();
    // (4) A fresh reading reporting capacity — the system that knows which accounts are available
    //     says this one is — clears the park, and routing sees it again.
    gw!.setAccountRateHints([{ accountId: 'cdx-1', utilization7d: 0.1, readingAt: parkedAt + 4_000 }]);
    expect(codexPool.parkState!('cdx-1')).toBeUndefined();
    expect(codexPool.healthyCount!()).toBe(2);
    expect(codexPool.msSinceReadmit!('cdx-1')).toBeLessThan(5_000);
  });

  it('/admin/readmit is the OPERATOR lever: it clears even a 7d wall (reason admin carries no transport bound)', async () => {
    const codexPool = createFailoverPool([codexAcct('cdx-1'), codexAcct('cdx-2')]);
    await bootCodex(ok, [codexAcct('cdx-1'), codexAcct('cdx-2')], { codexPool });
    codexPool.onExhausted('cdx-1', Date.now() + 7 * 86_400_000);
    expect(codexPool.healthyCount!()).toBe(1);
    const res = await ask('/admin/readmit?provider=codex&account=cdx-1', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(codexPool.parkState!('cdx-1')).toBeUndefined();
    expect(codexPool.healthyCount!()).toBe(2);
  });

  it('a downstream disconnect mid-aggregation aborts the OAuth upstream and leaves NO unhandled rejection behind (P-004)', async () => {
    const home = await makeCodexHome('chatgpt-a');
    const cliAccounts = [{ accountId: 'chatgpt-a', home }];
    let upstreamAborted = false;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      // A 200 SSE head whose body STALLS after one frame, so aggregation is in flight when the
      // caller disconnects — the shape that rejected the aggregate promise with no handler.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
          init?.signal?.addEventListener('abort', () => {
            upstreamAborted = true;
            try {
              controller.error(new Error('oauth upstream aborted'));
            } catch {
              /* already errored */
            }
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => cliAccounts,
      codexCliPool: createFailoverPool([{ accountId: 'chatgpt-a', token: async () => '' }]),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
      requestCeilingMs: 5_000,
    });
    port = await gw.listen(0);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 80);
      await ask('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: 'chatgpt-a' },
        body: JSON.stringify({ model: 'gpt-5.5', input: 'disconnect mid-aggregate', stream: false }),
        signal: controller.signal,
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(upstreamAborted).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

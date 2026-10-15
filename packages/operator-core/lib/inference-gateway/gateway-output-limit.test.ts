import { afterEach, expect, it, vi } from 'vitest';
import { createInferenceGateway } from './gateway';
import { createFailoverPool } from './account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

const HEADER = 'x-papercusp-require-output-token-limit';
let gateway: ReturnType<typeof createInferenceGateway> | undefined;
afterEach(async () => { await gateway?.close(); gateway = undefined; resetGovernorRegistry(); vi.unstubAllEnvs(); });

async function request(body: Record<string, unknown>, required: string | null = 'true') {
  const port = await gateway!.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(required === null ? {} : { [HEADER]: required }) },
    body: JSON.stringify({ model: 'gpt-6.1-sol:xhigh', input: 'fixture', stream: false, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

it.each([false, true])('refuses a required output limit before subscription execution (oauth=%s)', async oauth => {
  const run = vi.fn(async () => ({ text: 'UNBOUNDED', inputTokens: 1, outputTokens: 1 }));
  const fetchImpl = vi.fn(async () => new Response('UNBOUNDED'));
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexCliAccounts: () => [{ accountId: 'subscription', home: '/intentionally-absent-limit-fixture' }],
    codexOAuthProxy: oauth, codexCliRun: run, fetchImpl,
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  expect(await request({ max_output_tokens: 8 })).toMatchObject({ status: 422,
    body: { error: { code: 'output_token_limit_unsupported' } } });
  expect(run).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});

it('preserves a required limit on a bearer request and strips the internal header', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ output_text: 'bounded', output: [] }),
    { headers: { 'content-type': 'application/json' } }));
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexPool: createFailoverPool([{ accountId: 'bearer', token: async () => 'fixture-token' }]),
    fetchImpl, requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  expect(await request({ max_output_tokens: 8 })).toMatchObject({ status: 200, body: { output_text: 'bounded' } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8'))).toMatchObject({ max_output_tokens: 8, model: 'gpt-6.1-sol' });
  expect(new Headers(init.headers).has(HEADER)).toBe(false);
});

it.each([undefined, 0, -1, 1.5, '8', null])('refuses invalid required max_output_tokens=%s before a bearer send', async limit => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output: [] })));
  const token = vi.fn(async () => 'fixture-token');
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexPool: createFailoverPool([{ accountId: 'bearer', token }]), fetchImpl,
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  expect(await request({ max_output_tokens: limit })).toMatchObject({ status: 400,
    body: { error: { code: 'output_token_limit_invalid' } } });
  expect(fetchImpl).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
});

it('rejects an ambiguous requirement header before execution', async () => {
  const run = vi.fn(async () => ({ text: 'UNBOUNDED', inputTokens: 1, outputTokens: 1 }));
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexCliAccounts: () => [{ accountId: 'subscription', home: '/unused' }], codexCliRun: run,
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  expect(await request({ max_output_tokens: 8 }, 'true,false')).toMatchObject({ status: 400,
    body: { error: { code: 'output_token_limit_invalid' } } });
  expect(run).not.toHaveBeenCalled();
});

it('retains ordinary subscription calls with an advisory output limit', async () => {
  const run = vi.fn(async () => ({ text: 'ordinary', inputTokens: 1, outputTokens: 1 }));
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexCliAccounts: () => [{ accountId: 'subscription', home: '/unused' }], codexCliRun: run,
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  expect(await request({ max_output_tokens: 8 }, null)).toMatchObject({ status: 200, body: { output_text: 'ordinary' } });
  expect(run).toHaveBeenCalledTimes(1);
});

it('returns a known-zero refusal through the real LLM HTTP client before any subscription inference', async () => {
  const run = vi.fn(async () => ({ text: 'UNBOUNDED', inputTokens: 1, outputTokens: 1 }));
  gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexCliAccounts: () => [{ accountId: 'subscription', home: '/unused' }], codexCliRun: run,
    requestAbsorbMs: 0, selfHeal: { enabled: false },
  });
  vi.stubEnv('PAPERCUSP_GATEWAY_PORT', String(await gateway.listen(0)));
  const { llmCall } = await import('../llm-testing/llm-client');
  await expect(llmCall({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'fixture' }],
    maxTokens: 8, requireOutputTokenLimit: true })).rejects.toMatchObject({ costUsd: 0, turn: { retryable: false } });
  expect(run).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { governorForBackend, resetGovernorRegistry, effectiveRpm } from '@papercusp/papercusp-shared/agent';
import { createInferenceGateway } from './gateway';
import { createFailoverPool } from './account-failover';
import {
  configureGatewayRequestOutcomeStore,
  InMemoryGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
} from './gateway-request-outcome-store';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;
beforeEach(() => {
  resetGovernorRegistry();
  configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore());
});
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  vi.restoreAllMocks();
  resetGovernorRegistry();
  resetGatewayRequestOutcomeStore();
});

it.each(['claude-code', 'codex'] as const)('%s successful upstream responses grow the same account governor above its seed', async backend => {
  const codex = backend === 'codex';
  const model = codex ? 'gpt-6.1-sol' : 'claude-sonnet-4';
  const accountId = 'adaptive-account';
  const governor = governorForBackend(backend, model, undefined, accountId);
  const initialRpm = effectiveRpm(governor.state, Date.now())!;
  gateway = createInferenceGateway({
    accountId, token: async () => 'fixture-token',
    ...(codex ? { codexPool: createFailoverPool([{ accountId, token: async () => 'fixture-token' }]) } : {}),
    smoothRpm: true, requestAbsorbMs: 0, selfHeal: { enabled: false },
    fetchImpl: vi.fn(async () => Response.json(codex
      ? { id: 'resp-growth', object: 'response', status: 'completed', output: [] }
      : { id: 'msg-growth', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn' })) as typeof fetch,
  });
  const port = await gateway.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/${codex ? 'responses' : 'messages'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(codex ? { model, input: 'fixture', stream: false }
      : { model, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 8, stream: false }),
  });
  expect(response.status, await response.text()).toBe(200);
  expect(effectiveRpm(governor.state, Date.now())).toBeGreaterThan(initialRpm);
});

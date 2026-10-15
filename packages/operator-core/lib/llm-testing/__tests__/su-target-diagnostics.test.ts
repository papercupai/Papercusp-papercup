import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmCallDiagnostic } from '@papercusp/testing-shell/llm';
import { SuTarget } from '../targets/su';
import { buildCatalog } from '../targets/su-catalog';

afterEach(() => vi.unstubAllEnvs());

describe('SU Messages transport evidence', () => {
  it('observes the actual SDK request and terminal throttle without leaking prompt or credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-secret-key');
    vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'https://example.test');
    const events: LlmCallDiagnostic[] = [];
    const send = vi.fn(async () => new Response(JSON.stringify({
      type: 'error', error: { type: 'rate_limit_error', message: 'fixture throttle' },
    }), { status: 429, headers: {
      'content-type': 'application/json', 'x-should-retry': 'false', 'retry-after': '120',
      'request-id': 'request-fixture', 'x-papercusp-routed-account': 'account-fixture',
    } }));
    const session = await new SuTarget({
      catalog: buildCatalog([]), loadSystemPrompt: () => 'private-prompt-fixture', anthropicFetch: send,
    }).open({ runId: 'diagnostic-fixture', sutModel: 'claude-sonnet-4-6',
      workspaceMode: 'isolated', transport: 'in-process', onDiagnostic: e => events.push(e) });
    const result = await session.send({ messages: [{ role: 'user', content: 'private-user-fixture' }], trigger: 'user_message' });
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('fixture throttle');
    expect(send).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([
      { phase: 'request', attempt: 1, endpointOrigin: 'https://example.test', status: null },
      { phase: 'response', attempt: 1, status: 429, providerRequestId: 'request-fixture', servedAccount: 'account-fixture' },
    ]);
    expect(events[0].callId).toBe(events[1].callId);
    for (const secret of ['private-prompt-fixture', 'private-user-fixture', 'test-secret-key', 'fixture throttle']) {
      expect(JSON.stringify(events)).not.toContain(secret);
    }
    await session.close();
  });

  it('a failing evidence sink does not change a successful SDK response', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-secret-key');
    vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'https://example.test');
    const send = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg-fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } }));
    const session = await new SuTarget({ catalog: buildCatalog([]), loadSystemPrompt: () => 'prompt', anthropicFetch: send })
      .open({ runId: 'sink-fixture', sutModel: 'claude-sonnet-4-6', workspaceMode: 'isolated', transport: 'in-process',
        onDiagnostic: () => { throw new Error('sink failure'); } });
    expect(await session.send({ messages: [{ role: 'user', content: 'finish' }], trigger: 'user_message' }))
      .toMatchObject({ assistantText: 'done', finishReason: 'done' });
    expect(send).toHaveBeenCalledTimes(1);
    await session.close();
  });
});

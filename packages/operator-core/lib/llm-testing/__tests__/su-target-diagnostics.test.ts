import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_ADMIN, runScenario, type LlmCallDiagnostic, type LlmCallFn, type Scenario } from '@papercusp/testing-shell/llm';
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

describe('SU Codex transport evidence', () => {
  const completed = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed',
    response: { output, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, {
    headers: { 'content-type': 'text/event-stream', 'request-id': 'request-fixture',
      'x-papercusp-routed-account': 'account-fixture' },
  });
  const finalOutput = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }];

  it('records each request across tool rounds without including request or response bodies', async () => {
    const events: LlmCallDiagnostic[] = [];
    const send = vi.fn().mockResolvedValueOnce(completed([{
      type: 'function_call', call_id: 'call-fixture', name: 'docs__get', arguments: '{}',
    }])).mockResolvedValueOnce(completed(finalOutput));
    const session = await new SuTarget({ catalog: buildCatalog([
      { name: 'docs:get', description: 'Read.', input: { type: 'object' } },
    ]), loadSystemPrompt: () => 'private-prompt-fixture', codexFetch: send }).open({
      runId: 'codex-diagnostic-fixture', sutModel: 'gpt-fixture', workspaceMode: 'isolated', transport: 'in-process',
      onDiagnostic: event => events.push(event),
    });
    try {
      expect(await session.send({ messages: [{ role: 'user', content: 'private-user-fixture' }], trigger: 'user_message' }))
        .toMatchObject({ assistantText: 'done', finishReason: 'done' });
      expect(send).toHaveBeenCalledTimes(2);
      expect(events.map(event => event.phase)).toEqual(['request', 'response', 'request', 'response']);
      expect(events[0]!.callId).toBe(events[1]!.callId);
      expect(events[2]!.callId).toBe(events[3]!.callId);
      expect(events[0]!.callId).not.toBe(events[2]!.callId);
      expect(events[1]).toMatchObject({ status: 200, providerRequestId: 'request-fixture', servedAccount: 'account-fixture' });
      for (const secret of ['private-prompt-fixture', 'private-user-fixture', 'papercusp-gateway', 'done']) {
        expect(JSON.stringify(events)).not.toContain(secret);
      }
    } finally { await session.close(); }
  });

  it.each(['http', 'transport', 'sink'] as const)('preserves %s outcomes while observing the injected transport', async kind => {
    const events: LlmCallDiagnostic[] = [];
    const send = vi.fn(async () => {
      if (kind === 'transport') throw Object.assign(new Error('private-transport-error'), { code: 'ETIMEDOUT' });
      return kind === 'http' ? new Response('private-error-body', { status: 429 }) : completed(finalOutput);
    });
    const session = await new SuTarget({ catalog: buildCatalog([]), loadSystemPrompt: () => 'prompt', codexFetch: send })
      .open({ runId: `codex-${kind}`, sutModel: 'gpt-fixture', workspaceMode: 'isolated', transport: 'in-process',
        onDiagnostic: event => { events.push(event); if (kind === 'sink') throw new Error('sink failure'); } });
    try {
      const result = await session.send({ messages: [{ role: 'user', content: 'finish' }], trigger: 'user_message' });
      expect(result.finishReason).toBe(kind === 'sink' ? 'done' : 'error');
      expect(send).toHaveBeenCalledTimes(1);
      expect(events.map(event => event.phase)).toEqual(['request', kind === 'transport' ? 'transport-error' : 'response']);
      if (kind === 'http') expect(events[1]!.status).toBe(429);
      if (kind === 'transport') expect(events[1]!.transportFailureCode).toBe('ETIMEDOUT');
      expect(JSON.stringify(events)).not.toContain('private-');
    } finally { await session.close(); }
  });

  it('persists a pending Codex request in the runner report when the first turn hits its wallclock cap', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PAPERCUSP_LLM_TEST_SKIP_CLAIM', '1');
    let finishRequest!: (response: Response) => void;
    const send = vi.fn(() => new Promise<Response>(resolve => { finishRequest = resolve; }));
    const target = new SuTarget({ catalog: buildCatalog([]), loadSystemPrompt: () => 'prompt', codexFetch: send });
    const scenario: Scenario = { id: 'codex-pending-diagnostic', version: 1, target: 'su', description: 'diagnostic fixture',
      persona: BRIEF_ADMIN, goal: { kind: 'user_satisfied', declaredBy: 'sim_user' }, asserts: [],
      triggers: [{ on: 'after_turn', param: 0, fire: 'user_message' }],
      rubric: { version: 'v1', axes: [{ id: 'quality', description: 'quality', anchors: { bad: 'bad', ideal: 'ideal' } }] },
      caps: { maxTurns: 1, maxWallSecs: 1, maxCostUsd: 5 } };
    const llmCall: LlmCallFn = async () => ({ text: '', json: { summary: 'fixture', scores: { quality: 5 }, findings: [],
      agrees_with_deterministic_asserts: true, novel_failures: [] }, inputTokens: 1, outputTokens: 1, costUsd: 0, raw: null });
    try {
      const pending = runScenario(scenario, { sutModel: 'gpt-fixture', forceRepeat: 1 }, { getTarget: () => target, llmCall });
      const assertion = expect(pending).resolves.toMatchObject({ runs: [{ status: 'errored', summary: {
        turns: [], timeout: { stage: 'sut_session_send', turnIndex: 0 },
        llmCallDiagnostics: { events: [{ phase: 'request', attempt: 1, label: 'gateway-pool' }], total: 1, omitted: 0 },
      } }] });
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      finishRequest?.(completed(finalOutput));
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});

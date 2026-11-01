import { describe, expect, it, vi } from 'vitest';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { LEARNING_MODEL_ID, LEARNING_MODEL_SPEC } from '../../learning/model-policy';
import { buildCatalog } from '../targets/su-catalog';
import { SuTarget } from '../targets/su';

type OutputDelivery = 'snapshot' | 'streamed-only' | 'both';

const anthropicMock = vi.hoisted(() => ({
  responses: [] as unknown[],
  pendingCreate: null as null | ((signal?: AbortSignal) => Promise<unknown>),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(async (_body: unknown, options?: { signal?: AbortSignal }) => {
        if (anthropicMock.pendingCreate) return anthropicMock.pendingCreate(options?.signal);
        const response = anthropicMock.responses.shift();
        if (!response) throw new Error('unexpected Anthropic call');
        return response;
      }),
    };
  },
}));

function completed(output: unknown[], delivery: OutputDelivery): Response {
  const events: unknown[] = delivery === 'snapshot' ? [] : output.map((item, output_index) => ({
    type: 'response.output_item.done', output_index, item,
  }));
  events.push({
    type: 'response.completed',
    response: {
      output: delivery === 'streamed-only' ? [] : output,
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  });
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('SuTarget Codex Responses tool loop', () => {
  it.each(['codex', 'anthropic'] as const)('%s close cancels an in-flight provider request and prevents another send', async (transport) => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-anthropic-key';
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const requestStarted = new Promise<void>(resolve => { entered = resolve; });
    const waitForAbort = (requestSignal?: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal = requestSignal;
      requestSignal?.addEventListener('abort', () => reject(new Error('provider request cancelled')), { once: true });
      entered();
    });
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => waitForAbort(init?.signal ?? undefined));
    anthropicMock.pendingCreate = waitForAbort;
    const session = await new SuTarget({
      catalog: buildCatalog([]),
      loadSystemPrompt: () => 'Reply briefly.',
      codexFetch: fetchImpl as unknown as typeof fetch,
    }).open({
      runId: `cancel-on-close-${transport}`,
      sutModel: transport === 'codex' ? LEARNING_MODEL_SPEC : 'claude-sonnet-4-6',
      workspaceMode: 'isolated', transport: 'in-process',
    });
    const input = { trigger: 'user_message' as const, messages: [{ role: 'user' as const, content: 'Hello.' }] };
    const pending = session.send(input);
    try {
      await requestStarted;
      await session.close();
      expect(signal?.aborted).toBe(true);
      expect((await pending).finishReason).toBe('error');
      expect((await session.send(input)).finishReason).toBe('error');
      expect(fetchImpl).toHaveBeenCalledTimes(transport === 'codex' ? 1 : 0);
    } finally {
      // Release the fake provider even when the regression fails on an old target.
      signal?.dispatchEvent(new Event('abort'));
      await pending;
      await session.close();
      anthropicMock.pendingCreate = null;
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it.each(['codex', 'anthropic'] as const)('%s reaches a final response after more than six tool rounds', async (transport) => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-anthropic-key';
    let requests = 0;
    const toolOutput = (index: number) => ({
      type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`,
      name: 'docs__get', arguments: JSON.stringify({ slugs: [`step-${index}`] }),
    });
    const fetchImpl = vi.fn(async () => {
      requests++;
      return completed(requests <= 7 ? [toolOutput(requests)] : [{
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished seven evidence reads.' }],
      }], 'snapshot');
    });
    anthropicMock.responses = [
      ...Array.from({ length: 7 }, (_, index) => ({
        content: [{ type: 'tool_use', id: `toolu_${index}`, name: 'docs__get', input: { slugs: [`step-${index}`] } }],
        stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 },
      })),
      { content: [{ type: 'text', text: 'Finished seven evidence reads.' }], stop_reason: 'end_turn' },
    ];
    try {
      const target = new SuTarget({
        catalog: buildCatalog([{ name: 'docs:get', description: 'Read evidence.', input: { type: 'object' } }]),
        loadSystemPrompt: () => 'Read the required evidence, then report.',
        codexFetch: fetchImpl as unknown as typeof fetch,
      });
      const session = await target.open({
        runId: `seven-round-${transport}`,
        sutModel: transport === 'codex' ? LEARNING_MODEL_SPEC : 'claude-sonnet-4-6',
        workspaceMode: 'isolated', transport: 'in-process',
        dispatchOverride: { override: async () => ({ content: [{ text: '{"ok":true}' }] }) },
      });
      const result = await session.send({ trigger: 'user_message', messages: [{ role: 'user', content: 'Read the seven pieces of evidence and report.' }] });
      expect(result.toolCalls).toHaveLength(7);
      expect(result.toolResults).toHaveLength(7);
      expect(result.assistantText).toBe('Finished seven evidence reads.');
      expect(result.finishReason).toBe('done');
      await session.close();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      anthropicMock.responses = [];
    }
  });

  it.each(['codex', 'anthropic'] as const)('%s deadline remains an error rather than a successful empty final response', async (transport) => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-anthropic-key';
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fetchImpl = vi.fn(async () => {
      elapsed = 240_001;
      return completed([{
        type: 'function_call', id: 'fc_deadline', call_id: 'call_deadline',
        name: 'docs__get', arguments: '{}',
      }], 'snapshot');
    });
    anthropicMock.responses = [{
      content: [{ type: 'tool_use', id: 'toolu_deadline', name: 'docs__get', input: {} }],
      stop_reason: 'tool_use',
    }];
    try {
      const session = await new SuTarget({
        catalog: buildCatalog([{ name: 'docs:get', description: 'Read.', input: { type: 'object' } }]),
        loadSystemPrompt: () => 'Read then report.',
        codexFetch: fetchImpl as unknown as typeof fetch,
      }).open({
        runId: `deadline-after-tool-${transport}`, sutModel: transport === 'codex' ? LEARNING_MODEL_SPEC : 'claude-sonnet-4-6',
        workspaceMode: 'isolated', transport: 'in-process',
        dispatchOverride: { override: async () => {
          elapsed = 240_001;
          return { content: [{ text: '{"ok":true}' }] };
        } },
      });
      const result = await session.send({ trigger: 'user_message', messages: [{ role: 'user', content: 'Read.' }] });
      expect(fetchImpl).toHaveBeenCalledTimes(transport === 'codex' ? 1 : 0);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.finishReason).toBe('error');
      expect(result.error).toMatch(/deadline|timed out/i);
      await session.close();
    } finally {
      clock.mockRestore();
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      anthropicMock.responses = [];
    }
  });

  it.each<OutputDelivery>(['snapshot', 'streamed-only', 'both'])('replays reasoning, functions, and text exactly once with %s output', async (delivery) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return completed([
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'docs__get',
            arguments: JSON.stringify({ slugs: ['x'], harness: 'all' }),
          },
        ], delivery);
      }
      return completed([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done from Sol.' }],
        },
      ], delivery);
    });
    const dispatchOutput = JSON.stringify({ ok: true, results: [{ slug: 'x' }] });
    const dispatch = vi.fn(async () => ({ content: [{ text: dispatchOutput }] }));
    const target = new SuTarget({
      catalog: buildCatalog([
        {
          name: 'docs:get',
          description: 'Read a doc.',
          input: {
            type: 'object',
            properties: { slugs: { type: 'array', items: { type: 'string' } }, harness: { type: 'string' } },
            required: ['slugs', 'harness'],
          },
        },
      ]),
      loadSystemPrompt: () => 'Follow the playbook.',
      codexFetch: fetchImpl as unknown as typeof fetch,
    });
    const session = await target.open({
      runId: 'sol-tool-loop',
      sutModel: LEARNING_MODEL_SPEC,
      workspaceMode: 'isolated',
      transport: 'in-process',
      dispatchOverride: { override: dispatch } as never,
    });

    const result = await session.send({
      trigger: 'user_message',
      messages: [{ role: 'user', content: 'Read x.' }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({
      model: LEARNING_MODEL_ID,
      reasoning: { effort: 'xhigh' },
      store: false,
      stream: true,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
    });
    expect((bodies[0].tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'function',
      name: 'docs__get',
    });
    const secondInput = bodies[1].input as Array<Record<string, unknown>>;
    expect(secondInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'docs__get' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ]));
    expect(dispatch).toHaveBeenCalledWith('docs:get', { slugs: ['x'], harness: 'all' });
    expect(result.toolCalls).toEqual([{
      name: 'docs:get',
      input: { slugs: ['x'], harness: 'all' },
      responseIndex: 0,
    }]);
    expect(result.toolResults).toEqual([{
      name: 'docs:get',
      output: dispatchOutput,
      isError: false,
      truncated: false,
      sourceChars: dispatchOutput.length,
    }]);
    expect(result.assistantText).toBe('Done from Sol.');
    expect(result.finishReason).toBe('done');
  });

  it('dispatches a tools:invoke nested call into the scenario world and returns the nested evidence', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ((body.input as unknown[]).length === 1) {
        return completed([
          {
            type: 'function_call',
            id: 'fc_nested',
            call_id: 'call_nested',
            name: 'tools__invoke',
            arguments: JSON.stringify({
              name: 'capability:edit',
              args: {
                file_path: 'apps/operator-vite/src/components/harness-card/HarnessCard.tsx',
                old_string: '<header />',
                new_string: '<header><StatusPill /></header>',
              },
            }),
          },
        ], 'snapshot');
      }
      return completed([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Nested edit applied; I will verify the file.' }],
        },
      ], 'snapshot');
    });
    const nestedOutput = JSON.stringify({
      ok: true,
      changed: true,
      file_path: 'apps/operator-vite/src/components/harness-card/HarnessCard.tsx',
    });
    const dispatch = vi.fn(async (name: string) =>
      name.replace(/^mcp__agentmcp__/, '') === 'tools:invoke'
        ? PASS_THROUGH
        : { content: [{ text: nestedOutput }] });
    const target = new SuTarget({
      catalog: buildCatalog([
        {
          name: 'tools:invoke',
          description: 'Dispatch a discovered tool.',
          input: {
            type: 'object',
            properties: { name: { type: 'string' }, args: { type: 'object' } },
            required: ['name'],
          },
        },
      ]),
      loadSystemPrompt: () => 'Use tools:invoke for discovered tools, then verify writes.',
      codexFetch: fetchImpl as unknown as typeof fetch,
    });
    const session = await target.open({
      runId: 'sol-nested-tool-loop',
      sutModel: LEARNING_MODEL_SPEC,
      workspaceMode: 'isolated',
      transport: 'in-process',
      dispatchOverride: { override: dispatch } as never,
    });

    const result = await session.send({
      trigger: 'user_message',
      messages: [{ role: 'user', content: 'Apply the approved HarnessCard edit.' }],
    });

    expect(dispatch).toHaveBeenCalledWith(
      'capability:edit',
      expect.objectContaining({
        file_path: 'apps/operator-vite/src/components/harness-card/HarnessCard.tsx',
      }),
    );
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: 'tools:invoke',
        input: expect.objectContaining({ name: 'capability:edit' }),
      }),
    ]);
    expect(result.toolResults).toEqual([
      expect.objectContaining({ name: 'tools:invoke', output: nestedOutput, isError: false }),
    ]);
  });

  it('captures tool-result evidence on the Anthropic Messages path', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-anthropic-key';
    try {
      anthropicMock.responses = [
        {
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'docs__get',
            input: { slugs: ['x'], harness: 'all' },
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
        {
          content: [{ type: 'text', text: 'Done from Claude.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      ];
      const dispatchOutput = JSON.stringify({ ok: true, results: [{ slug: 'x' }] });
      const dispatch = vi.fn(async () => ({ content: [{ text: dispatchOutput }] }));
      const target = new SuTarget({
        catalog: buildCatalog([{
          name: 'docs:get',
          description: 'Read a doc.',
          input: {
            type: 'object',
            properties: {
              slugs: { type: 'array', items: { type: 'string' } },
              harness: { type: 'string' },
            },
            required: ['slugs', 'harness'],
          },
        }]),
        loadSystemPrompt: () => 'Follow the playbook.',
      });
      const session = await target.open({
        runId: 'claude-tool-loop',
        sutModel: 'claude-sonnet-4-6',
        workspaceMode: 'isolated',
        transport: 'in-process',
        dispatchOverride: { override: dispatch } as never,
      });

      const result = await session.send({
        trigger: 'user_message',
        messages: [{ role: 'user', content: 'Read x.' }],
      });

      expect(dispatch).toHaveBeenCalledWith('docs:get', { slugs: ['x'], harness: 'all' });
      expect(result.toolCalls).toEqual([{
        name: 'docs:get',
        input: { slugs: ['x'], harness: 'all' },
        responseIndex: 0,
      }]);
      expect(result.toolResults).toEqual([{
        name: 'docs:get',
        output: dispatchOutput,
        isError: false,
        truncated: false,
        sourceChars: dispatchOutput.length,
      }]);
      expect(result.assistantText).toBe('Done from Claude.');
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      anthropicMock.responses = [];
    }
  });
});

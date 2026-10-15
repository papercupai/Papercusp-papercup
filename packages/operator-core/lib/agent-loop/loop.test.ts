/**
 * runAgentLoop unit tests — scripted fake ModelPort, no provider, no network.
 * P-007 (own-tui-full-divorce-2026-08-24): the loop's semantics are the
 * contract P-008 (pane wire-up) and P-009 (sessions) build on, so every
 * branch is pinned here: natural stop, tool round-trip, stopWhen,
 * prepareStep overrides, approval approve/deny/no-channel, unknown tool,
 * execution failure, stream error, abort.
 */
import { describe, expect, it } from 'vitest';
import type { ModelPort, ModelStreamEvent } from './model-port';
import { MODEL_PROVIDER_REQUEST_CAPTURE, textMessage } from './model-port';
import {
  hasToolCall,
  runAgentLoop,
  stepCountIs,
  type ApprovalPort,
  type LoopEvent,
  type LoopTool,
  type RunAgentLoopOptions,
} from './loop';

/** A ModelPort that replays one scripted event-array per call, in order.
 *  Records every request it received for assertion. */
function scriptedPort(scripts: ModelStreamEvent[][]) {
  const requests: Parameters<ModelPort['stream']>[0][] = [];
  let call = 0;
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);
      const script = scripts[call++];
      if (!script) throw new Error(`scriptedPort: unscripted call #${call}`);
      for (const ev of script) yield ev;
    },
  };
  return { port, requests };
}

async function collect(opts: RunAgentLoopOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop(opts)) events.push(ev);
  return events;
}

function doneEvent(events: LoopEvent[]) {
  const done = events.find((e) => e.type === 'done');
  if (!done || done.type !== 'done') throw new Error('no done event');
  return done;
}

const echoTool: LoopTool = {
  name: 'echo',
  description: 'echoes its input',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  execute: async (input) => ({ echoed: input }),
};

const textStop = (text: string, usage?: { inputTokens: number; outputTokens: number }): ModelStreamEvent[] => [
  { type: 'text_delta', text },
  { type: 'stop', reason: 'end_turn', ...(usage ? { usage } : {}) },
];

const callTool = (id: string, name: string, input: unknown): ModelStreamEvent[] => [
  { type: 'tool_call', id, name, input },
  { type: 'stop', reason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
];

describe('runAgentLoop', () => {
  it('awaits private server capture and keeps a failed admission visible across abort', async () => {
    const abort = new AbortController(); let pulled = false;
    const port: ModelPort = { async *stream() {
      yield { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model' },
        [MODEL_PROVIDER_REQUEST_CAPTURE]: async () => { abort.abort(); throw new Error('private capture failed'); } };
      pulled = true; yield { type: 'stop', reason: 'end_turn' };
    } };
    const events = await collect({ port, model: 'm', messages: [], signal: abort.signal });
    expect(pulled).toBe(false);
    expect(events.find(e => e.type === 'error')).toMatchObject({ message: 'private capture failed' });
    expect(doneEvent(events).stopReason).toBe('error');
    expect(Object.getOwnPropertySymbols(doneEvent(events).providerRequests![0])).toEqual([]);
  });

  it('does not hide a durable-capture rejection behind an overlapping abort', async () => {
    const abort = new AbortController();
    const { port } = scriptedPort([[{ type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model' } }]]);
    const events = await collect({ port, model: 'm', messages: [], signal: abort.signal,
      onProviderRequest: async () => { abort.abort(); throw new Error('capture failed'); } });
    expect(events.find(e => e.type === 'error')).toMatchObject({ message: 'capture failed' });
    expect(doneEvent(events).stopReason).toBe('error');
    expect(doneEvent(events).providerRequests).toHaveLength(1);
  });

  it('copies only accounting identity fields, excluding extra provider metadata and charges', async () => {
    const request = { provider: 'openrouter', modelId: 'vendor/model', apiKey: 'private-key',
      response: { id: 'gen-whitelisted', reportedCostUsd: 100, raw: 'private-prompt' } };
    const { port } = scriptedPort([[{ type: 'provider_request', request }, { type: 'error', message: 'failed' }]]);
    const captured: unknown[] = [];
    const events = await collect({ port, model: 'm', messages: [], onProviderRequest: async info => { captured.push(info); } });
    expect(captured).toEqual([{ stepIndex: 0, request: { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-whitelisted' } } }]);
    expect(JSON.stringify(doneEvent(events).providerRequests)).not.toMatch(/private|reportedCost/);
  });
  it('treats an adapter aborted stop as an incomplete request even without a parent abort', async () => {
    const request = { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-provider-abort' } };
    const { port } = scriptedPort([[{ type: 'provider_request', request },
      { type: 'stop', reason: 'aborted', usage: { inputTokens: 4, outputTokens: 2, costUsd: 10 } }]]);
    const done = doneEvent(await collect({ port, model: 'm', messages: [] }));
    expect(done.stopReason).toBe('aborted');
    expect(done.steps).toEqual([]);
    expect(done.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(done.providerRequests).toEqual([{ stepIndex: 0, request }]);
  });

  it('keeps early observations isolated across steps and from event-consumer mutation', async () => {
    const first = callTool('c', 'echo', {});
    first.unshift({ type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/first', response: { id: 'gen-first' } } });
    const second: ModelStreamEvent[] = [{ type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/second' } },
      { type: 'error', message: 'lost second response' }];
    const { port } = scriptedPort([first, second]);
    const events: LoopEvent[] = [];
    for await (const event of runAgentLoop({ port, model: 'm', messages: [], tools: [echoTool] })) {
      events.push(event);
      if (event.type === 'provider_request' && event.request.response) event.request.response.id = 'gen-consumer-mutated';
    }
    const done = doneEvent(events);
    expect(done.steps).toHaveLength(1);
    expect(done.providerRequests).toEqual([
      { stepIndex: 0, request: { provider: 'openrouter', modelId: 'vendor/first', response: { id: 'gen-first' } } },
      { stepIndex: 1, request: { provider: 'openrouter', modelId: 'vendor/second' } },
    ]);
  });
  it.each(['error', 'eof', 'throw', 'aborted'] as const)('captures provider requests on %s without a completed step', async ending => {
    const abort = new AbortController();
    const request = { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-failed' } };
    const port: ModelPort = { async *stream() {
      yield { type: 'provider_request', request, servedAccount: 'account-one' };
      if (ending === 'error') yield { type: 'error', message: 'failed' };
      if (ending === 'throw') throw new Error('failed');
      if (ending === 'aborted') { abort.abort(); await new Promise(() => {}); }
    } };
    const captured: unknown[] = [];
    const events = await collect({ port, model: 'openrouter/vendor/model', messages: [], signal: abort.signal,
      onProviderRequest: async info => { captured.push(info); } });
    const done = doneEvent(events);
    expect(done.steps).toEqual([]);
    expect(done.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(done.providerRequests).toEqual([{ stepIndex: 0, request, servedAccount: 'account-one' }]);
    expect(captured).toEqual(done.providerRequests);
    expect(events.find(e => e.type === 'provider_request')).toEqual({ type: 'provider_request', stepIndex: 0, request, servedAccount: 'account-one' });
    expect(done.stopReason).toBe(ending === 'aborted' ? 'aborted' : 'error');
  });

  it('awaits durable capture before the next provider pull and isolates callback mutation', async () => {
    let captured = false;
    const port: ModelPort = { async *stream() {
      yield { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-captured' } } };
      expect(captured).toBe(true);
      yield { type: 'stop', reason: 'end_turn' };
    } };
    const events = await collect({ port, model: 'm', messages: [], onProviderRequest: async info => {
      await Promise.resolve(); captured = true;
      info.request.response!.id = 'gen-mutated';
    } });
    expect(doneEvent(events).providerRequests?.[0]?.request.response?.id).toBe('gen-captured');
    expect(doneEvent(events).steps[0]).not.toHaveProperty('providerResponse');
  });

  it('fails visibly and closes the provider if durable capture rejects', async () => {
    let closed = false; let pulledAfterCapture = false;
    const port: ModelPort = { async *stream() { try {
      yield { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-unsaved' } } };
      pulledAfterCapture = true;
      yield { type: 'stop', reason: 'end_turn' };
    } finally { closed = true; } } };
    const events = await collect({ port, model: 'm', messages: [], onProviderRequest: async () => { throw new Error('capture unavailable'); } });
    expect(events.find(e => e.type === 'error')).toMatchObject({ message: 'capture unavailable' });
    expect(doneEvent(events).stopReason).toBe('error');
    expect(doneEvent(events).steps).toEqual([]);
    expect(doneEvent(events).providerRequests).toHaveLength(1);
    expect(pulledAfterCapture).toBe(false);
    expect(closed).toBe(true);
  });
  it('keeps provider reports on their original steps without aggregating or carrying them forward', async () => {
    const report = { provider: 'openrouter', id: 'gen-first', reportedCostUsd: 0.25 };
    const first = callTool('c1', 'echo', { value: 'x' });
    first[first.length - 1] = { type: 'stop', reason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 }, providerResponse: report, servedAccount: 'account-one' };
    const { port } = scriptedPort([first, textStop('done', { inputTokens: 3, outputTokens: 2 })]);
    const events = await collect({ port, model: 'm1', messages: [], tools: [echoTool] });
    const done = doneEvent(events);
    expect(done.steps[0]).toMatchObject({ providerResponse: report, servedAccount: 'account-one' });
    expect(done.steps[1]).not.toHaveProperty('providerResponse');
    expect(done).not.toHaveProperty('providerResponse');
    expect(done.usage).toEqual({ inputTokens: 13, outputTokens: 7 });
    expect(events.find(e => e.type === 'step_end')).toMatchObject({ step: { providerResponse: report } });
  });

  it('single text turn ends naturally with the final text and transcript', async () => {
    const { port } = scriptedPort([textStop('hello world', { inputTokens: 7, outputTokens: 3 })]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'hi')],
    });
    const done = doneEvent(events);
    expect(done.stopReason).toBe('complete');
    expect(done.finalText).toBe('hello world');
    expect(done.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(done.messages).toHaveLength(2); // user + assistant
    expect(done.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world' }],
    });
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
  });

  it('executes a tool call, feeds the result back, and completes on the second step', async () => {
    const { port, requests } = scriptedPort([
      callTool('c1', 'echo', { value: 'x' }),
      textStop('done!', { inputTokens: 20, outputTokens: 2 }),
    ]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'use the tool')],
      tools: [echoTool],
    });
    const done = doneEvent(events);
    expect(done.stopReason).toBe('complete');
    expect(done.finalText).toBe('done!');
    expect(done.steps).toHaveLength(2);
    // usage aggregated across both steps
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 7 });
    // tool round-trip landed in the transcript
    const toolResultMsg = done.messages.find(
      (m) => m.role === 'user' && m.content.some((p) => p.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content[0]).toEqual({
      type: 'tool_result',
      toolCallId: 'c1',
      content: { echoed: { value: 'x' } },
    });
    // the second model call SAW the tool result
    expect(requests[1].messages.at(-1)!.content[0].type).toBe('tool_result');
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr).toMatchObject({ callId: 'c1', name: 'echo', result: { echoed: { value: 'x' } } });
  });

  it('stopWhen ends the loop even when the model keeps calling tools', async () => {
    const { port } = scriptedPort([callTool('c1', 'echo', { value: 1 }), callTool('c2', 'echo', { value: 2 })]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [echoTool],
      stopWhen: stepCountIs(2),
    });
    const done = doneEvent(events);
    expect(done.stopReason).toBe('stop-condition');
    expect(done.steps).toHaveLength(2);
  });

  it('hasToolCall stop condition fires on the named tool', async () => {
    const { port } = scriptedPort([callTool('c1', 'echo', {})]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [echoTool],
      stopWhen: hasToolCall('echo'),
    });
    expect(doneEvent(events).stopReason).toBe('stop-condition');
  });

  it('needsApproval + approving port executes; the approval events are emitted', async () => {
    const gated: LoopTool = { ...echoTool, needsApproval: true };
    const seen: string[] = [];
    const approvals: ApprovalPort = {
      requestApproval: async (req) => {
        seen.push(req.call.name);
        return { approved: true };
      },
    };
    const { port } = scriptedPort([callTool('c1', 'echo', { value: 'y' }), textStop('ok')]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [gated],
      approvals,
    });
    expect(seen).toEqual(['echo']);
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ needsApproval: true });
    expect(events.find((e) => e.type === 'approval_resolved')).toMatchObject({ approved: true });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      result: { echoed: { value: 'y' } },
    });
    expect(doneEvent(events).stopReason).toBe('complete');
  });

  it('prepares approval state before yielding the visible gated tool call', async () => {
    const gated: LoopTool = { ...echoTool, needsApproval: true };
    const order: string[] = [];
    const approvals: ApprovalPort = {
      async prepareApproval(req) {
        order.push(`prepared:${req.call.id}`);
      },
      async requestApproval(req) {
        order.push(`requested:${req.call.id}`);
        return { approved: true };
      },
    };
    const { port } = scriptedPort([callTool('c-prepared', 'echo', { value: 'y' }), textStop('ok')]);
    const events: LoopEvent[] = [];

    for await (const event of runAgentLoop({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [gated],
      approvals,
    })) {
      if (event.type === 'tool_call') {
        order.push(`yielded:${event.call.id}`);
        expect(order).toEqual(['prepared:c-prepared', 'yielded:c-prepared']);
      }
      events.push(event);
    }

    expect(order).toEqual(['prepared:c-prepared', 'yielded:c-prepared', 'requested:c-prepared']);
    expect(doneEvent(events).stopReason).toBe('complete');
  });

  it('denied approval feeds an isError tool_result back to the model, loop continues', async () => {
    const gated: LoopTool = { ...echoTool, needsApproval: () => true };
    const approvals: ApprovalPort = {
      requestApproval: async () => ({ approved: false, reason: 'owner said no' }),
    };
    const { port, requests } = scriptedPort([callTool('c1', 'echo', {}), textStop('understood')]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [gated],
      approvals,
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      denied: true,
      error: 'tool call denied: owner said no',
    });
    const fedBack = requests[1].messages.at(-1)!.content[0];
    expect(fedBack).toMatchObject({ type: 'tool_result', isError: true });
    expect(doneEvent(events).stopReason).toBe('complete');
  });

  it('needsApproval with NO approval channel is denied, never executed', async () => {
    let executed = false;
    const gated: LoopTool = {
      ...echoTool,
      needsApproval: true,
      execute: async () => {
        executed = true;
        return 'ran';
      },
    };
    const { port } = scriptedPort([callTool('c1', 'echo', {}), textStop('ok')]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [gated],
    });
    expect(executed).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ denied: true });
  });

  it('unknown tool produces an isError tool_result instead of crashing', async () => {
    const { port, requests } = scriptedPort([callTool('c1', 'nonexistent', {}), textStop('ok')]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [echoTool],
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      error: 'unknown tool: nonexistent',
    });
    expect(requests[1].messages.at(-1)!.content[0]).toMatchObject({ isError: true });
    expect(doneEvent(events).stopReason).toBe('complete');
  });

  it('a throwing tool execution becomes an isError tool_result, loop continues', async () => {
    const bomb: LoopTool = {
      ...echoTool,
      execute: async () => {
        throw new Error('kaboom');
      },
    };
    const { port } = scriptedPort([callTool('c1', 'echo', {}), textStop('recovered')]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [bomb],
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ error: 'kaboom' });
    expect(doneEvent(events).finalText).toBe('recovered');
  });

  it('a stream error event ends the loop with stopReason error', async () => {
    const { port } = scriptedPort([[{ type: 'error', message: 'rate limited' }]]);
    const events = await collect({ port, model: 'm1', messages: [textMessage('user', 'hi')] });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'rate limited' });
    expect(doneEvent(events).stopReason).toBe('error');
  });

  it('a throwing stream ends the loop with stopReason error', async () => {
    const port: ModelPort = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('socket closed');
      },
    };
    const events = await collect({ port, model: 'm1', messages: [textMessage('user', 'hi')] });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'socket closed' });
    expect(doneEvent(events).stopReason).toBe('error');
  });

  it('an early stream EOF is an error, not a successful empty completion', async () => {
    const { port } = scriptedPort([[{ type: 'text_delta', text: 'partial' }]]);
    const events = await collect({ port, model: 'm1', messages: [textMessage('user', 'hi')] });
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: 'model stream ended before terminal stop/error event',
    });
    expect(doneEvent(events).stopReason).toBe('error');
  });

  it('abort settles a never-ending iterator and invokes its cleanup', async () => {
    const ctrl = new AbortController();
    let returned = false;
    const port: ModelPort = {
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<ModelStreamEvent>>(() => undefined),
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          };
        },
      }),
    };
    const pending = collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'hi')],
      signal: ctrl.signal,
    });
    const timer = setTimeout(() => ctrl.abort(), 10);
    const events = await pending;
    clearTimeout(timer);
    expect(doneEvent(events).stopReason).toBe('aborted');
    expect(returned).toBe(true);
  });

  it('an aborted signal stops before the next step', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { port } = scriptedPort([]);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'hi')],
      signal: ctrl.signal,
    });
    expect(doneEvent(events).stopReason).toBe('aborted');
    expect(events).toHaveLength(1); // done only — no model call was made
  });

  it('prepareStep overrides model and tools for that step only', async () => {
    const altTool: LoopTool = { ...echoTool, name: 'alt' };
    const { port, requests } = scriptedPort([callTool('c1', 'alt', {}), textStop('finished')]);
    const events = await collect({
      port,
      model: 'base-model',
      messages: [textMessage('user', 'go')],
      tools: [echoTool],
      prepareStep: ({ stepIndex }) => (stepIndex === 0 ? { model: 'step0-model', tools: [altTool] } : undefined),
    });
    expect(requests[0].model).toBe('step0-model');
    expect(requests[0].tools?.map((t) => t.name)).toEqual(['alt']);
    expect(requests[1].model).toBe('base-model');
    // the alt tool actually executed on step 0
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ name: 'alt' });
    expect(doneEvent(events).stopReason).toBe('complete');
  });

  it('default stop condition caps a runaway tool loop at DEFAULT_MAX_STEPS', async () => {
    // Every step calls a tool — the model never stops on its own.
    const scripts: ModelStreamEvent[][] = Array.from({ length: 100 }, (_, i) => callTool(`c${i}`, 'echo', { i }));
    const { port } = scriptedPort(scripts);
    const events = await collect({
      port,
      model: 'm1',
      messages: [textMessage('user', 'go')],
      tools: [echoTool],
    });
    const done = doneEvent(events);
    expect(done.stopReason).toBe('stop-condition');
    expect(done.steps.length).toBeLessThanOrEqual(24);
  });

  it('model requests carry system, priority, account, owner and tool defs (not executors)', async () => {
    const { port, requests } = scriptedPort([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end_turn', servedAccount: 'acct-served' },
      ],
    ]);
    const events = await collect({
      port,
      model: 'm1',
      system: 'be terse',
      priority: 'interactive',
      account: 'auto',
      ownerId: 'agent-loop-c1',
      messages: [textMessage('user', 'hi')],
      tools: [echoTool],
    });
    expect(requests[0].system).toBe('be terse');
    expect(requests[0].priority).toBe('interactive');
    expect(requests[0].account).toBe('auto');
    expect(requests[0].ownerId).toBe('agent-loop-c1');
    expect(requests[0].tools).toEqual([
      { name: 'echo', description: 'echoes its input', inputSchema: echoTool.inputSchema },
    ]);
    // the wire def must NOT leak the execute function
    expect((requests[0].tools![0] as unknown as Record<string, unknown>).execute).toBeUndefined();
    expect(doneEvent(events).servedAccount).toBe('acct-served');
  });
});

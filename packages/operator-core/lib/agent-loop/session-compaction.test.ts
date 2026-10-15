/**
 * session-compaction unit tests — P-009 (own-tui-full-divorce-2026-08-24).
 * Scripted fake ModelPort; no PG, no network. Pins: the clean-user-turn cut
 * (a tool_call/tool_result pair never splits), the threshold noop, the
 * summarize round-trip (prior summary folded in, usage returned), and the
 * bounded-growth degrade when the summarizer fails.
 */
import { describe, expect, it } from 'vitest';
import type { ModelMessage, ModelPort, ModelStreamEvent } from './model-port';
import { MODEL_PROVIDER_REQUEST_CAPTURE } from './model-port';
import type { LoopProviderRequestInfo } from './loop';
import {
  findCompactionCut,
  maybeCompactSession,
  renderForSummary,
  serializedChars,
} from './session-compaction';

const user = (text: string): ModelMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const assistantCall = (id: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_call', id, name: 'do_thing', input: { id } }],
});
const toolResult = (id: string, content: unknown = 'ok'): ModelMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', toolCallId: id, content }],
});

function scriptedPort(script: ModelStreamEvent[]) {
  const requests: Parameters<ModelPort['stream']>[0][] = [];
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);
      for (const ev of script) yield ev;
    },
  };
  return { port, requests };
}

describe('findCompactionCut', () => {
  it('picks the latest clean user turn that still keeps keepRecent messages', () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
      user('q3'), assistant('a3'),
    ];
    // limit = 6 - 2 = 4; clean user turns at 0, 2, 4 → cut 4.
    expect(findCompactionCut(messages, 2)).toBe(4);
  });

  it('never splits a tool_call from its tool_result', () => {
    const messages = [
      user('q1'),
      assistantCall('c1'),
      toolResult('c1'),
      user('q2'),
      assistant('a2'),
    ];
    // limit = 5 - 1 = 4; indexes 1..2 are the pair; only clean user turn ≤ 4
    // (besides the opening) is 3 — the pair stays whole in the prefix.
    expect(findCompactionCut(messages, 1)).toBe(3);
  });

  it('falls back to the latest clean user turn anywhere when none fits the window', () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'),
      assistantCall('c1'), toolResult('c1'),
      assistantCall('c2'), toolResult('c2'),
    ];
    // limit = 7 - 10 < 0 → no candidate in window; bestAny = 2.
    expect(findCompactionCut(messages, 10)).toBe(2);
  });

  it('returns 0 when the opening user turn is the only clean one', () => {
    const messages = [user('q1'), assistantCall('c1'), toolResult('c1'), assistant('a1')];
    expect(findCompactionCut(messages, 1)).toBe(0);
  });
});

describe('maybeCompactSession', () => {
  const base = {
    priorSummary: null as string | null,
    priorCompactedCount: 0,
    model: 'test-model',
  };

  it('is a noop under the threshold', async () => {
    const messages = [user('q1'), assistant('a1')];
    const { port, requests } = scriptedPort([]);
    const out = await maybeCompactSession({ ...base, messages, port });
    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(messages);
    expect(out.summary).toBeNull();
    expect(requests.length).toBe(0);
  });

  it('summarizes the elder prefix, folds the prior summary, and returns usage', async () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
      user('q3'), assistant('a3'),
    ];
    const { port, requests } = scriptedPort([
      { type: 'text_delta', text: 'NEW SUMMARY' },
      { type: 'stop', reason: 'end_turn', usage: { inputTokens: 50, outputTokens: 9 } },
    ]);
    const out = await maybeCompactSession({
      ...base,
      priorSummary: 'OLD SUMMARY',
      priorCompactedCount: 3,
      messages,
      port,
      thresholdChars: 10, // force compaction
      keepRecent: 2,
    });
    expect(out.compacted).toBe(true);
    expect(out.summary).toBe('NEW SUMMARY');
    expect(out.messages).toEqual([user('q3'), assistant('a3')]);
    expect(out.compactedCount).toBe(3 + 4);
    expect(out.summarizeUsage).toEqual({ inputTokens: 50, outputTokens: 9 });
    // The summarizer saw the prior summary AND the folded turns, no tools.
    expect(requests.length).toBe(1);
    const req = requests[0];
    expect(req.tools).toBeUndefined();
    const prompt = (req.messages[0].content[0] as { type: 'text'; text: string }).text;
    expect(prompt).toContain('OLD SUMMARY');
    expect(prompt).toContain('q1');
    expect(prompt).not.toContain('q3'); // kept suffix is not summarized
  });

  it('still trims on summarizer failure and records the coverage gap', async () => {
    const messages = [
      user('q1'), assistant('a1'),
      user('q2'), assistant('a2'),
    ];
    const { port } = scriptedPort([{ type: 'error', message: 'gateway down' }]);
    const out = await maybeCompactSession({
      ...base,
      priorSummary: 'OLD SUMMARY',
      priorCompactedCount: 1,
      messages,
      port,
      thresholdChars: 10,
      keepRecent: 2,
    });
    expect(out.compacted).toBe(true);
    expect(out.messages).toEqual([user('q2'), assistant('a2')]);
    expect(out.compactedCount).toBe(1 + 2);
    expect(out.summary).toContain('OLD SUMMARY'); // prior coverage survives
    expect(out.summary).toContain('summarizer unavailable: gateway down');
  });
});

describe('renderForSummary', () => {
  it('renders text, tool calls and results with per-part clamps', () => {
    const rendered = renderForSummary([
      user('hello'),
      assistantCall('c9'),
      toolResult('c9', { big: 'y'.repeat(5_000) }),
    ]);
    expect(rendered).toContain('user: hello');
    expect(rendered).toContain('tool_call do_thing');
    expect(rendered).toContain('… [+'); // clamp marker on the oversized result
  });

  it('serializedChars counts the JSON form', () => {
    expect(serializedChars([user('x')])).toBe(JSON.stringify([user('x')]).length);
  });
});

describe('compaction provider obligations', () => {
  const messages = [user('elder'), assistant('answer'), user('recent'), assistant('answer')];
  const base = { messages, priorSummary: null, priorCompactedCount: 0, model: 'openrouter:vendor/model',
    thresholdChars: 10, keepRecent: 2 };
  const observation: ModelStreamEvent = { type: 'provider_request',
    request: { provider: 'openrouter', modelId: 'vendor/model', response: { id: 'gen-summary' } },
    servedAccount: 'local-account' };

  it('propagates a private server capture failure rather than accepting a degraded summary', async () => {
    const failure = new Error('private binding failed'); let pulled = false;
    const port: ModelPort = { async *stream() {
      yield { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model' },
        [MODEL_PROVIDER_REQUEST_CAPTURE]: async () => { throw failure; } };
      pulled = true; yield { type: 'text_delta', text: 'must not summarize' };
    } };
    await expect(maybeCompactSession({ ...base, port })).rejects.toBe(failure);
    expect(pulled).toBe(false);
  });

  it('awaits capture before the next provider pull and retains an independent snapshot on failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pulled = false;
    let entered!: () => void;
    const captureEntered = new Promise<void>(resolve => { entered = resolve; });
    const captured: LoopProviderRequestInfo[] = [];
    const port: ModelPort = { async *stream() {
      yield structuredClone(observation);
      pulled = true;
      yield { type: 'error', message: 'summary failed' };
    } };
    const pending = maybeCompactSession({ ...base, port, stepIndex: 3, onProviderRequest: async info => {
      captured.push(structuredClone(info));
      info.request.response!.id = 'mutated';
      entered();
      await gate;
    } });
    await captureEntered;
    expect(pulled).toBe(false);
    release();
    const out = await pending;
    expect(out.providerRequests).toEqual(captured);
    expect(out.providerRequests?.[0]).toMatchObject({ stepIndex: 3, purpose: 'compaction',
      request: { response: { id: 'gen-summary' } }, servedAccount: 'local-account' });
    expect(out.summary).toContain('summary failed');
    expect(out.summarizeUsage).toBeUndefined();
  }, 5_000);

  it('keeps dispatch intent without a generation id as unresolved observation', async () => {
    const { port } = scriptedPort([{ type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model' } },
      { type: 'error', message: 'no response' }]);
    const out = await maybeCompactSession({ ...base, port });
    expect(out.providerRequests).toEqual([{ stepIndex: 0, purpose: 'compaction',
      request: { provider: 'openrouter', modelId: 'vendor/model' } }]);
    expect(out.summarizeUsage).toBeUndefined();
  });

  it('does not dispatch a summarizer when the enclosing call was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { port, requests } = scriptedPort([]);
    const out = await maybeCompactSession({ ...base, port, signal: controller.signal });
    expect(requests).toHaveLength(0);
    expect(out.summary).toContain('summarizer aborted');
    expect(out.providerRequests).toBeUndefined();
    expect(out.summarizeUsage).toBeUndefined();
  });

  it('keeps conflicting identity observations and strips non-whitelisted provider fields', async () => {
    const request = Object.assign({ provider: 'openrouter', modelId: 'vendor/model',
      response: { id: 'gen-one', modelId: 'vendor/served' } }, { secret: 'private-key', reportedCostUsd: 77 });
    const { port } = scriptedPort([{ type: 'provider_request', request },
      { type: 'provider_request', request: { provider: 'openrouter', modelId: 'vendor/model',
        response: { id: 'gen-two', modelId: 'vendor/other' }, identityUncertain: true } },
      { type: 'error', message: 'identity conflict' }]);
    const out = await maybeCompactSession({ ...base, port });
    expect(out.providerRequests).toHaveLength(2);
    expect(out.providerRequests?.map(info => info.request.response?.id)).toEqual(['gen-one', 'gen-two']);
    expect(out.providerRequests?.[1].request.identityUncertain).toBe(true);
    expect(JSON.stringify(out.providerRequests)).not.toContain('private-key');
    expect(JSON.stringify(out.providerRequests)).not.toContain('reportedCostUsd');
    expect(out.summarizeProviderResponse).toBeUndefined();
  });

  it.each(['error', 'abort'])('propagates capture failure instead of hiding it in a %s fallback', async mode => {
    const controller = new AbortController();
    let closed = false;
    let pulled = false;
    const failure = new Error('durable capture unavailable');
    const port: ModelPort = { async *stream() { try {
      yield observation;
      pulled = true;
      yield { type: 'text_delta', text: 'must not be pulled' };
    } finally { closed = true; } } };
    await expect(maybeCompactSession({ ...base, port, signal: controller.signal,
      onProviderRequest: async () => { if (mode === 'abort') controller.abort(); throw failure; } })).rejects.toBe(failure);
    expect(pulled).toBe(false);
    expect(closed).toBe(true);
  });

  it.each(['eof', 'aborted', 'other', 'tool_use'] as const)('does not certify %s summary text or usage as complete', async reason => {
    const script: ModelStreamEvent[] = [observation, { type: 'text_delta', text: 'PARTIAL SUMMARY' }];
    if (reason !== 'eof') script.push({ type: 'stop', reason, usage: { inputTokens: 8, outputTokens: 2 } });
    const { port } = scriptedPort(script);
    const out = await maybeCompactSession({ ...base, port });
    expect(out.summary).toContain('dropped without a fresh summary');
    expect(out.summary).not.toBe('PARTIAL SUMMARY');
    expect(out.providerRequests).toHaveLength(1);
    expect(out.summarizeUsage).toBeUndefined();
    expect(out.summarizeProviderResponse).toBeUndefined();
  });

  it('retains a completed provider report separately and forwards the stable caller identity', async () => {
    const response = { provider: 'openrouter', id: 'gen-summary', modelId: 'vendor/model', reportedCostUsd: 0.005 };
    const { port, requests } = scriptedPort([observation, { type: 'text_delta', text: 'summary' },
      { type: 'stop', reason: 'end_turn', usage: { inputTokens: 9, outputTokens: 1 }, providerResponse: response }]);
    const out = await maybeCompactSession({ ...base, port, ownerId: 'owned-chat' });
    expect(requests[0].ownerId).toBe('owned-chat');
    expect(out.summary).toBe('summary');
    expect(out.summarizeUsage).toEqual({ inputTokens: 9, outputTokens: 1 });
    expect(out.summarizeProviderResponse).toEqual(response);
    expect(out.summarizeProviderResponse).not.toBe(response);
    expect(out.providerRequests).toHaveLength(1);
  });
});

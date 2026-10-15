import { describe, expect, it, vi } from 'vitest';
import { makeLiveGdpvalJudge } from './judge-live';
import { combineDualOrder, parseJudgeVerdict } from '../grader/gdpval';
import { benchDefaultModelId } from '../model-registry-snapshot';

/** A fake Anthropic-ish client: records the params, returns a canned text message. */
function fakeClient(text: string) {
  const stream = vi.fn((params: unknown) => ({
    finalMessage: async () => ({ content: [{ type: 'text', text }] }),
    _params: params,
  }));
  return { client: { messages: { stream } } as never, stream };
}

describe('gdpval judge-live — makeLiveGdpvalJudge', () => {
  it('sends the judge system + user prompt and returns the model text', async () => {
    const { client, stream } = fakeClient('Reasoning...\nWINNER: A');
    const judge = makeLiveGdpvalJudge({ client, baseUrl: null });
    const out = await judge({ prompt: 'Write a memo', rubric: 'clarity', deliverableA: 'AAA', deliverableB: 'BBB' });
    expect(out).toContain('WINNER: A');
    const params = stream.mock.calls[0][0] as { system: unknown; messages: { content: string }[]; model: string };
    // R-9: the default judge model is the registry-resolved benchmark default, never a literal.
    expect(params.model).toBe(benchDefaultModelId());
    expect(params.messages[0].content).toContain('Write a memo');
    expect(params.messages[0].content).toContain('AAA');
  });

  it('prepends the Claude Code identity block when routing through the gateway (baseUrl set)', async () => {
    const { client, stream } = fakeClient('WINNER: TIE');
    const judge = makeLiveGdpvalJudge({ client, baseUrl: 'http://127.0.0.1:8788' });
    await judge({ prompt: 'p', rubric: 'r', deliverableA: 'a', deliverableB: 'b' });
    const system = (stream.mock.calls[0][0] as { system: { text: string }[] }).system;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].text).toContain('Claude Code');
  });

  it('omits the identity block for a direct (non-gateway) call', async () => {
    const { client, stream } = fakeClient('WINNER: B');
    const judge = makeLiveGdpvalJudge({ client, baseUrl: null });
    await judge({ prompt: 'p', rubric: 'r', deliverableA: 'a', deliverableB: 'b' });
    expect(typeof (stream.mock.calls[0][0] as { system: unknown }).system).toBe('string');
  });

  it('its output flows through the pure grader parse + dual-order combine', async () => {
    // model-first says A (model wins), reference-first says B (model wins) → win.
    expect(combineDualOrder(parseJudgeVerdict('WINNER: A')!, parseJudgeVerdict('WINNER: B')!)).toBe('win');
  });
});

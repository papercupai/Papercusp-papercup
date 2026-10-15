import { defineTool, dispatchProjectedTool, lookupByMcpName, type ToolResult } from '@papercusp/tooldef';
import { encode } from '@papercusp/result-encoding';
import { describe, expect, it, vi } from 'vitest';
import decline from './decline';
import getFeedback from './get-feedback';
import reply from './reply';

function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ data: payload }) }] };
}

describe('consult verb abort-completion receipts', () => {
  const declineArgs = { conversation_id: 'conv-1', reason: 'This consult is outside my context.' };
  const replyArgs = { conversation_id: 'conv-1', kind: 'new_fact' as const, body: 'The finding is confirmed.' };
  const completedPost = result({ ok: true, post_id: 42 });
  const attempt = { callId: 'call-1', toolName: 'consult:decline' };

  it('reports a late completed decline by its committed post identity', () => {
    expect(decline.abortCompletionReceipt?.(declineArgs, completedPost, attempt)).toEqual({
      status: 'recorded',
      effectRef: 'consult-decline:conv-1:42',
    });
  });

  it.each(['http', 'mcp'] as const)('preserves the committed decline through real %s serialization after parent abort', async (transport) => {
    const parent = new AbortController();
    const name = `receipt-test:decline-${transport}`;
    defineTool({
      ...decline,
      name,
      async handler() {
        // The post and cascade completed; the caller's deadline fired while
        // the handler was running. Do not replace that committed write with
        // an ambiguous error merely because MCP serializes it differently.
        parent.abort();
        return { data: { ok: true, post_id: 42, state: 'awaiting_responder' } };
      },
    });
    const dispatched = await dispatchProjectedTool(lookupByMcpName(name)!, name, declineArgs, {
      transport,
      ...(transport === 'mcp' ? { requestedFormat: 'toon' as const } : {}),
      signal: parent.signal,
      workspaceId: 'receipt-test-workspace',
      log: vi.fn(),
      progress: vi.fn(),
      emit: vi.fn(),
      gateBypass: { role: true, capability: true },
    }, {});
    expect(dispatched.ok).toBe(true);
    expect(dispatched.result?._meta?.format).toBe(transport === 'mcp' ? 'toon' : 'json');
    expect(dispatched.result?._meta?.abortCompletionReceipt).toMatchObject({
      status: 'recorded', effectRef: 'consult-decline:conv-1:42', attemptId: expect.any(String),
    });
  });

  it('reads structured completion evidence when the text is compact or unavailable', () => {
    const completion = { ok: true, post_id: 42 };
    expect(decline.abortCompletionReceipt?.(declineArgs, {
      content: [], structuredContent: completion,
    }, attempt)).toMatchObject({ status: 'recorded', effectRef: 'consult-decline:conv-1:42' });
    expect(getFeedback.abortCompletionReceipt?.({ question: 'Router question', allow_dispatch: true }, {
      content: [{ type: 'text', text: `format: toon\n${encode({ ok: true, conversation_id: 'conv-compact' }, 'toon')}` }],
    }, attempt)).toMatchObject({ status: 'recorded', effectRef: 'consult-get-feedback:conv-compact' });
  });

  it.each([
    'format: toon\n<<<not valid toon>>>',
    `format: toon\n${encode({ ok: true, post_id: '42' }, 'toon')}`,
    `format: toon\n${encode({ ok: false, post_id: 42 }, 'toon')}`,
    `format: toon\n${encode({ ok: true }, 'toon')}`,
  ])('fails closed for malformed or unproven compact completion evidence: %s', (text) => {
    expect(decline.abortCompletionReceipt?.(declineArgs, {
      content: [{ type: 'text', text }],
    }, attempt)).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-post-id'] });
  });

  it('preserves the existing reply receipt identity while sharing the parser', () => {
    expect(reply.abortCompletionReceipt?.(replyArgs, completedPost, { ...attempt, toolName: 'consult:reply' })).toEqual({
      status: 'recorded',
      effectRef: 'consult-reply:conv-1:42',
    });
  });

  it('fails closed when completion does not prove a post id or conversation', () => {
    expect(decline.abortCompletionReceipt?.(declineArgs, result({ ok: true }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-post-id'],
    });
    expect(decline.abortCompletionReceipt?.({} as never, completedPost, attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-conversation-id'],
    });
  });

  it('reports the conversation opened by a late completed get_feedback call', () => {
    expect(getFeedback.abortCompletionReceipt?.(
      { question: 'How does the router choose a responder?', allow_dispatch: true },
      result({ ok: true, verdict: 'routed', conversation_id: 'conv-feedback-1' }),
      { callId: 'call-feedback-1', toolName: 'consult:get_feedback' },
    )).toEqual({
      status: 'recorded',
      effectRef: 'consult-get-feedback:conv-feedback-1',
    });
  });

  it('fails closed when get_feedback completion has no confirmed conversation id', () => {
    expect(getFeedback.abortCompletionReceipt?.(
      { question: 'How does the router choose a responder?', allow_dispatch: true },
      result({ ok: true, verdict: 'served_from_archive' }),
      { callId: 'call-feedback-2', toolName: 'consult:get_feedback' },
    )).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-conversation-id'],
    });
    expect(getFeedback.abortCompletionReceipt?.(
      { question: 'How does the router choose a responder?', allow_dispatch: true },
      result({ error: 'consult_cycle' }),
      { callId: 'call-feedback-3', toolName: 'consult:get_feedback' },
    )).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-conversation-id'],
    });
  });
});

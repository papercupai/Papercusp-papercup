/** @vitest-environment jsdom */
/**
 * usePapercupChat — the frame reducer, the ported portal helpers, and the hook
 * over a fake adapter (papercup-chat-one-component-one-contract-2026-09-06 P-007).
 *
 * The reducer cases mirror the portal's `tests/ask-*.test.tsx` so the port is
 * checked against the behaviour it replaces; the hook cases drive the adapter
 * seam the hosts (P-008 portal, P-009 operator) will implement.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatTurn, ChatTurnsPage, OpenCardSnapshot } from '@papercusp/chat-protocol';
import {
  ASK_CAPABILITY_CONTRACT,
  CHAT_TRANSPORT_FAILED,
  CHAT_TURN_FAILED,
  ChatTurnRefusedError,
  EMPTY_TURN,
  askChoiceArgsFromToolCall,
  askCompletedTurn,
  askErrorMessage,
  askRetryTarget,
  askTurnRefusalState,
  formatResetAt,
  parsePapercupFrame,
  reduceAskFrame,
  usePapercupChat,
  type PapercupChatAdapter,
  type PapercupChatFrame,
} from './use-papercup-chat';

const card: OpenCardSnapshot = {
  correlationId: 'c-1',
  prompt: 'Which one?',
  createdAt: 1_700_000_000_000,
  presentation: { kind: 'radio', options: [{ id: 'a', label: 'A' }] },
} as OpenCardSnapshot;

function frames(list: PapercupChatFrame[]): AsyncIterable<PapercupChatFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of list) yield f;
    },
  };
}

/** A stream that pauses after `head` until `release()` is called, then yields `tail`. */
function gatedFrames(head: PapercupChatFrame[], tail: PapercupChatFrame[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const iterable: AsyncIterable<PapercupChatFrame> = {
    async *[Symbol.asyncIterator]() {
      for (const f of head) yield f;
      await gate;
      for (const f of tail) yield f;
    },
  };
  return { iterable, release };
}

describe('reduceAskFrame — the D-008 wire folded into the live turn', () => {
  it('accumulates deltas, records provenance and tool calls in order', () => {
    let s = EMPTY_TURN;
    s = reduceAskFrame(s, { type: 'provenance', engine: 'loop', model: 'claude-sonnet-5' });
    s = reduceAskFrame(s, { type: 'delta', text: 'Hel' });
    s = reduceAskFrame(s, { type: 'tool_call', name: 'work_items:get', input: { id: 'WI-1' }, callId: 'k1' });
    s = reduceAskFrame(s, { type: 'delta', text: 'lo' });
    s = reduceAskFrame(s, { type: 'tool_call', name: 'work_items:get', callId: 'k2' });
    expect(s.text).toBe('Hello');
    expect(s.provenance).toEqual({ engine: 'loop', model: 'claude-sonnet-5', accountRoute: null });
    expect(s.toolCalls).toEqual([
      { name: 'work_items:get', input: { id: 'WI-1' }, callId: 'k1' },
      { name: 'work_items:get', callId: 'k2' },
    ]);
    expect(s.done).toBe(false);
  });

  it('card / card_closed / state are last-write-wins over the open-card set', () => {
    let s = reduceAskFrame(EMPTY_TURN, { type: 'card', card });
    expect(s.cards.map((c) => c.correlationId)).toEqual(['c-1']);
    s = reduceAskFrame(s, { type: 'card', card: { ...card, prompt: 'Updated?' } });
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0].prompt).toBe('Updated?');
    s = reduceAskFrame(s, { type: 'state', version: 2, snapshot: { openCards: [card, { ...card, correlationId: 'c-2' }] } });
    expect(s.cards.map((c) => c.correlationId)).toEqual(['c-1', 'c-2']);
    s = reduceAskFrame(s, { type: 'card_closed', correlationId: 'c-1' });
    expect(s.cards.map((c) => c.correlationId)).toEqual(['c-2']);
    // A malformed card is ignored, never thrown on.
    expect(reduceAskFrame(EMPTY_TURN, { type: 'card', card: { correlationId: '' } as OpenCardSnapshot }).cards).toEqual([]);
  });

  it('error carries the host code (or the generic) and ends the turn; done ends it cleanly', () => {
    const coded = reduceAskFrame(EMPTY_TURN, { type: 'error', message: 'nope', code: 'portal_chat_not_found' });
    expect(coded).toMatchObject({ errorCode: 'portal_chat_not_found', errorMessage: 'nope', done: true });
    const bare = reduceAskFrame(EMPTY_TURN, { type: 'error', message: 'nope' });
    expect(bare.errorCode).toBe(CHAT_TURN_FAILED);
    expect(reduceAskFrame(EMPTY_TURN, { type: 'done', stopReason: 'complete' }).done).toBe(true);
  });
});

describe('parsePapercupFrame — raw SSE (event, data) to a typed frame', () => {
  it('normalises the wire and keeps the error code/backoff chat-protocol drops', () => {
    expect(parsePapercupFrame('delta', '{"text":"hi"}')).toEqual({ type: 'delta', text: 'hi' });
    expect(parsePapercupFrame('error', '{"message":"m","code":"portal_chat_turn_rate_limited","retryAfterMs":5000}')).toEqual({
      type: 'error',
      message: 'm',
      code: 'portal_chat_turn_rate_limited',
      retryAfterMs: 5000,
    });
    expect(parsePapercupFrame('error', { message: 'm' })).toEqual({ type: 'error', message: 'm', retryAfterMs: null });
  });
  it('drops malformed / unknown frames instead of throwing', () => {
    expect(parsePapercupFrame('delta', '{not json')).toBeNull();
    expect(parsePapercupFrame('heartbeat', '{}')).toBeNull();
    expect(parsePapercupFrame('delta', 'null')).toBeNull();
  });
});

describe('ported portal helpers (parity pt-refusal-state / pt-error-taxonomy / pt-retry)', () => {
  it('askTurnRefusalState reads the host refusal body, generic otherwise', () => {
    expect(askTurnRefusalState({ ok: false, error: 'portal_chat_turn_rate_limited', retryAfterMs: 3000 })).toMatchObject({
      errorCode: 'portal_chat_turn_rate_limited',
      retryAfterMs: 3000,
      done: true,
    });
    expect(askTurnRefusalState('garbage').errorCode).toBe(CHAT_TURN_FAILED);
    expect(askTurnRefusalState({ ok: false, error: 'x', retryAfterMs: -1 }).retryAfterMs).toBeNull();
  });

  it('askErrorMessage is total over context and never leaks a raw code', () => {
    expect(askErrorMessage('portal_chat_voice_turn_invalid', 'turn')).toMatch(/voice message.*speaking again or type/);
    expect(askErrorMessage('portal_chat_voice_turn_too_long', 'turn')).toMatch(/voice message.*shorter question.*parts/);
    expect(askErrorMessage(null, 'turn')).toBe('That turn did not complete. Try asking again.');
    expect(askErrorMessage(null, 'conversation')).toBe('This conversation did not open. Try again.');
    expect(askErrorMessage(null, 'card')).toBe('That answer was not accepted. Try answering again.');
    expect(askErrorMessage('portal_operator_status_503', 'card')).toMatch(/not reachable/);
    expect(askErrorMessage('portal_operator_unreachable', 'turn')).toMatch(/not reachable/);
    expect(askErrorMessage(CHAT_TRANSPORT_FAILED, 'turn')).toMatch(/not reachable/);
    expect(askErrorMessage('portal_chat_turn_rate_limited', 'turn', 1500)).toBe(
      'Too many questions were started recently. Try again in 2 seconds.',
    );
    expect(askErrorMessage('portal_chat_turn_rate_limited', 'turn', 1000)).toMatch(/1 second\./);
    expect(askErrorMessage('some_unknown_code', 'turn')).not.toMatch(/some_unknown_code/);
  });

  // WI-10003494 (owner #723): a capped / signed-out workspace AI account must say so,
  // not "That turn did not complete" or "Papercup is not reachable".
  it('askErrorMessage names a model-account failure and what to do about it', () => {
    const resetAt = Date.parse('2026-10-03T21:30:00Z');
    const capped = askErrorMessage('portal_chat_model_usage_limited', 'turn', null, resetAt);
    expect(capped).toMatch(/^This workspace's AI account has reached its usage limit until /);
    expect(capped).toContain(formatResetAt(resetAt)!);
    expect(capped).toMatch(/Connect a different account/);
    expect(askErrorMessage('portal_chat_model_usage_limited', 'turn')).toBe(
      "This workspace's AI account has reached its usage limit. Connect a different account for this workspace, or try again later.",
    );
    expect(askErrorMessage('portal_chat_model_auth_required', 'turn')).toMatch(/signed out or its access was revoked/);
    expect(askErrorMessage('portal_chat_model_rate_limited', 'turn', 30_000)).toMatch(/Try again in 30 seconds\./);
    expect(askErrorMessage('portal_chat_model_rate_limited', 'turn')).toMatch(/Wait a moment/);
    for (const code of ['portal_chat_model_usage_limited', 'portal_chat_model_auth_required', 'portal_chat_model_rate_limited']) {
      const sentence = askErrorMessage(code, 'turn');
      expect(sentence).not.toMatch(/not reachable|did not complete/);
      expect(sentence).not.toContain(code);
    }
  });

  it('a live usage-limit frame reaches the transcript with its reset time', () => {
    const resetAt = Date.parse('2026-10-03T21:30:00Z');
    const frame = parsePapercupFrame('error', { message: '', code: 'portal_chat_model_usage_limited', resetAt });
    expect(frame).toMatchObject({ type: 'error', code: 'portal_chat_model_usage_limited', resetAt });
    const state = reduceAskFrame(EMPTY_TURN, frame!);
    expect(state.resetAt).toBe(resetAt);
    expect(askCompletedTurn(state)).toEqual({
      content: askErrorMessage('portal_chat_model_usage_limited', 'turn', null, resetAt),
      error: true,
    });
    // A malformed resetAt is dropped rather than rendered as a bogus date.
    expect(parsePapercupFrame('error', { message: '', code: 'x', resetAt: 'soon' })).not.toHaveProperty('resetAt');
    expect(formatResetAt(null)).toBeNull();
    expect(formatResetAt(-5)).toBeNull();
  });

  it('askCompletedTurn distinguishes a successful tool-only answer from an empty turn', () => {
    expect(askCompletedTurn({ ...EMPTY_TURN, text: 'ok', done: true })).toEqual({ content: 'ok', error: false });
    expect(
      askCompletedTurn({
        ...EMPTY_TURN,
        toolCalls: [{ name: 'chat:ask_choice' }],
        done: true,
      }),
    ).toEqual({ content: '', error: false });
    expect(askCompletedTurn({ ...EMPTY_TURN, done: true })).toEqual({ content: 'That turn ended without an answer.', error: true });
    expect(askCompletedTurn({ ...EMPTY_TURN, errorCode: 'portal_chat_not_found', done: true })).toEqual({
      content: 'This conversation is no longer available.',
      error: true,
    });
  });

  it('askRetryTarget prefers reopening a known conversation over re-asking', () => {
    expect(askRetryTarget({ hasSurfaceError: false, chatId: 'c', unsentQuestion: 'q' })).toBeNull();
    expect(askRetryTarget({ hasSurfaceError: true, chatId: 'c', unsentQuestion: 'q' })).toBe('conversation');
    expect(askRetryTarget({ hasSurfaceError: true, chatId: null, unsentQuestion: 'q' })).toBe('question');
    expect(askRetryTarget({ hasSurfaceError: true, chatId: null, unsentQuestion: '  ' })).toBeNull();
  });

  it('the capability contract still names the attached research tools', () => {
    expect(ASK_CAPABILITY_CONTRACT.attachedTools).toContain('work_items:get');
    expect(ASK_CAPABILITY_CONTRACT.machineAccess).toBe('full');
  });

  it('askChoiceArgsFromToolCall parses a persisted chat:ask_choice and refuses anything else', () => {
    expect(
      askChoiceArgsFromToolCall({
        name: 'chat:ask_choice',
        input: { question: 'Pick', options: [{ id: 'a', label: 'A', hint: 'h', style: 'primary' }, { id: 1 }], multi: true },
      }),
    ).toEqual({ question: 'Pick', options: [{ id: 'a', label: 'A', hint: 'h', style: 'primary' }], multi: true });
    expect(askChoiceArgsFromToolCall({ name: 'work_items:get', input: { question: 'x', options: [] } })).toBeNull();
    expect(askChoiceArgsFromToolCall({ name: 'chat:ask_choice', input: { question: 'x', options: [] } })).toBeNull();
  });

  it('restores the portal card when its tool input stored options as JSON text', () => {
    const options = [
      { id: 'template', label: 'From a template (papercusp-app, mobile, etc)', style: 'primary', hint: 'Scaffolds a pot + kicks off a builder' },
      { id: 'blank', label: 'Blank harness from a blueprint', hint: 'harness_create with coding/research blueprint' },
      { id: 'browse', label: 'Show me what templates exist first' },
    ];
    const input = { question: 'Two routes to a new app — which?', options };
    const restored = askChoiceArgsFromToolCall({
      name: 'chat:ask_choice', input: { ...input, options: JSON.stringify(options) },
    });
    expect(restored).toEqual(input);
    expect(restored).toEqual(askChoiceArgsFromToolCall({ name: 'chat:ask_choice', input }));
  });

  it.each(['not json', '{}', 'null', '"nested string"', '[]', '[null, 1, {}]'])(
    'rejects malformed or unusable persisted options %s', (options) => {
      expect(askChoiceArgsFromToolCall({ name: 'chat:ask_choice', input: { question: 'Pick', options } })).toBeNull();
    },
  );
});

describe('usePapercupChat — the hook over a fake adapter', () => {
  const history: ChatTurn[] = [
    { id: 't1', seq: 1, role: 'user', text: 'earlier?', createdAt: 1_700_000_000_000 },
    { id: 't2', seq: 2, role: 'assistant', text: 'earlier.', createdAt: 1_700_000_001_000 },
  ];

  function makeAdapter(overrides: Partial<PapercupChatAdapter> = {}): PapercupChatAdapter {
    return {
      loadHistory: vi.fn(async () => ({ turns: history, hasMoreEarlier: false })),
      sendTurn: vi.fn(async () =>
        frames([
          { type: 'provenance', engine: 'loop', model: 'm' },
          { type: 'tool_call', name: 'plans:get' },
          { type: 'delta', text: 'Answer ' },
          { type: 'delta', text: 'here.' },
          { type: 'done' },
        ]),
      ),
      answerCard: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('loads history for the conversation, then streams a turn into two committed turns', async () => {
    const adapter = makeAdapter();
    const onAssistantTurn = vi.fn();
    const { result } = renderHook(() => usePapercupChat({ adapter, conversationId: 'conv-1', onAssistantTurn }));
    await waitFor(() => expect(result.current.turns).toHaveLength(2));
    expect(adapter.loadHistory).toHaveBeenCalledWith({ beforeSeq: undefined, limit: 50 });

    await act(async () => {
      await result.current.send('  What now?  ');
    });
    const turns = result.current.turns;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[2]).toMatchObject({ text: 'What now?', source: 'text_typed' });
    expect(turns[3]).toMatchObject({
      text: 'Answer here.',
      provenance: { engine: 'loop', model: 'm' },
      tools: [{ name: 'plans:get' }],
    });
    expect(turns[3].error).toBeUndefined();
    expect(result.current.live).toBeNull();
    expect(result.current.streaming).toBe(false);
    expect(result.current.unsentQuestion).toBe('');
    expect(onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(adapter.sendTurn).toHaveBeenCalledWith('What now?', { signal: expect.any(AbortSignal) });
  });

  it.each([false, true])('preserves turns created during an initial history read (reply completed: %s)', async (completed) => {
    let finishHistory!: (page: ChatTurnsPage) => void;
    const pendingHistory = new Promise<ChatTurnsPage>((resolve) => { finishHistory = resolve; });
    const gated = gatedFrames([{ type: 'delta', text: 'Reply' }], [{ type: 'done' }]);
    const adapter = makeAdapter({ loadHistory: vi.fn(() => pendingHistory),
      sendTurn: vi.fn(async () => gated.iterable) });
    const { result } = renderHook(() => usePapercupChat({ adapter, conversationId: 'new-chat' }));
    await waitFor(() => expect(result.current.loadingHistory).toBe(true));
    let sending!: Promise<void>;
    act(() => { sending = result.current.send('Can I close this tab?'); });
    await waitFor(() => expect(result.current.live?.text).toBe('Reply'));
    if (completed) await act(async () => { gated.release(); await sending; });
    await act(async () => { finishHistory({ turns: history, hasMoreEarlier: false }); });
    expect(result.current.turns.slice(0, 2)).toEqual(history);
    expect(result.current.turns[2]).toMatchObject({ role: 'user', text: 'Can I close this tab?' });
    if (!completed) await act(async () => { gated.release(); await sending; });
    expect(result.current.turns.map((turn) => turn.text)).toEqual([
      'earlier?', 'earlier.', 'Can I close this tab?', 'Reply',
    ]);
    expect(adapter.sendTurn).toHaveBeenCalledOnce();
  });

  it('exposes open cards while the turn streams and routes the answer through the adapter', async () => {
    const gated = gatedFrames([{ type: 'delta', text: 'Choose: ' }, { type: 'card', card }], [{ type: 'card_closed', correlationId: 'c-1' }, { type: 'delta', text: 'thanks' }, { type: 'done' }]);
    const adapter = makeAdapter({ loadHistory: undefined, sendTurn: vi.fn(async () => gated.iterable) });
    const { result } = renderHook(() => usePapercupChat({ adapter, conversationId: null }));

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send('q');
    });
    await waitFor(() => expect(result.current.pendingCards).toHaveLength(1));
    expect(result.current.streaming).toBe(true);
    expect(result.current.live?.text).toBe('Choose: ');

    await act(async () => {
      await result.current.answerCard({ action: 'submit', correlationId: 'c-1', value: { picks: ['a'] } });
    });
    expect(adapter.answerCard).toHaveBeenCalledWith({ action: 'submit', correlationId: 'c-1', value: { picks: ['a'] } });

    await act(async () => {
      gated.release();
      await sendPromise;
    });
    expect(result.current.pendingCards).toHaveLength(0);
    expect(result.current.turns.at(-1)).toMatchObject({ role: 'assistant', text: 'Choose: thanks' });
  });

  it('a host refusal becomes an error turn with the taxonomy sentence, keeping the question for retry', async () => {
    const adapter = makeAdapter({
      loadHistory: undefined,
      sendTurn: vi.fn(async () => {
        throw new ChatTurnRefusedError({ ok: false, error: 'portal_chat_turn_rate_limited', retryAfterMs: 5000 }, 429);
      }),
    });
    const { result } = renderHook(() => usePapercupChat({ adapter, conversationId: null }));
    await act(async () => {
      await result.current.send('q');
    });
    expect(result.current.turns.at(-1)).toMatchObject({
      role: 'assistant',
      error: true,
      text: 'Too many questions were started recently. Try again in 5 seconds.',
    });
    expect(result.current.unsentQuestion).toBe('q');
    expect(result.current.streaming).toBe(false);
  });

  it('a transport failure mid-stream keeps nothing silent: the turn says the operator is unreachable', async () => {
    const adapter = makeAdapter({
      loadHistory: undefined,
      sendTurn: vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'delta', text: 'partial' } as PapercupChatFrame;
          throw new Error('socket closed');
        },
      })),
    });
    const { result } = renderHook(() => usePapercupChat({ adapter, conversationId: null }));
    await act(async () => {
      await result.current.send('q');
    });
    expect(result.current.turns.at(-1)).toMatchObject({ error: true, text: expect.stringMatching(/not reachable/) });
  });

  it('a history failure is a surface error whose retry reopens the conversation', async () => {
    const loadHistory = vi
      .fn<NonNullable<PapercupChatAdapter['loadHistory']>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ turns: history, hasMoreEarlier: true });
    const adapter = makeAdapter({ loadHistory });
    const { result } = renderHook(() => usePapercupChat({ adapter, conversationId: 'conv-1' }));
    await waitFor(() => expect(result.current.surfaceError).not.toBeNull());
    expect(result.current.surfaceError).toMatchObject({ context: 'conversation', code: CHAT_TRANSPORT_FAILED });
    expect(result.current.retryTarget).toBe('conversation');

    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.surfaceError).toBeNull();
    expect(result.current.turns).toHaveLength(2);
    expect(result.current.hasMoreEarlier).toBe(true);

    await act(async () => {
      await result.current.loadEarlier();
    });
    expect(loadHistory).toHaveBeenLastCalledWith({ beforeSeq: 1, limit: 50 });
  });

  it('switching conversation resets the transcript and reloads', async () => {
    const adapter = makeAdapter();
    const { result, rerender } = renderHook(({ id }) => usePapercupChat({ adapter, conversationId: id }), {
      initialProps: { id: 'conv-1' as string | null },
    });
    await waitFor(() => expect(result.current.turns).toHaveLength(2));
    rerender({ id: 'conv-2' });
    await waitFor(() => expect(adapter.loadHistory).toHaveBeenCalledTimes(2));
    expect(result.current.conversationId).toBe('conv-2');
  });
});

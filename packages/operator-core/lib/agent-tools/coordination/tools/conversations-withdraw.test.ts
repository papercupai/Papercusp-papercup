/** Handler shaping for conversations:withdraw. The production workflow is
 * mocked here; core lifecycle semantics live in conversations-core.test.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../../testing/typed-mock';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ withdrawConversation: vi.fn() }));

import { withdrawConversation } from '../conversations';
import type { ConversationRow } from '../conversations-store';
const withdrawM = vi.mocked(withdrawConversation);
const tool = (await import('./conversations-withdraw')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

const conversationFixture = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 'conv-q',
  kind: 'question',
  scope: 'operator',
  harness_slug: null,
  producer: 'coord:ask-owner',
  asker_id: 'me',
  title: null,
  body: 'question',
  state: 'closed',
  accepted_answer: null,
  accepted_post_id: null,
  capture_target: null,
  promoted_issue_id: null,
  superseded_by: null,
  created_ts: '2026-01-01T00:00:00.000Z',
  updated_ts: '2026-01-01T00:00:00.000Z',
  resolved_ts: null,
  superseded_ts: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('conversations:withdraw handler', () => {
  it('returns the closed state, reason post and notified count', async () => {
    mockResolvedTyped(withdrawM, { conversation: conversationFixture(), reasonPostId: 7, delivered: 2 });
    const result = await body({ id: 'conv-q', reason: 'answered in chat' });
    expect(result).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(result.results[0]).toEqual({
      ok: true,
      id: 'conv-q',
      state: 'closed',
      reason_post_id: 7,
      notified_subscribers: 2,
    });
    expect(withdrawM).toHaveBeenCalledWith({ ownerId: 'me' }, { conversation_id: 'conv-q', reason: 'answered in chat' });
  });

  it('refuses a missing reason without calling the workflow', async () => {
    const result = await body({ id: 'conv-q' });
    expect(result.results[0]).toMatchObject({ ok: false, id: 'conv-q', error: 'need_reason' });
    expect(withdrawM).not.toHaveBeenCalled();
  });

  it('maps lifecycle errors per item with the terminal state and a hint', async () => {
    withdrawM
      .mockResolvedValueOnce({ error: 'not_owner' })
      .mockResolvedValueOnce({ error: 'already_terminal', state: 'resolved' });
    const result = await body({
      items: [
        { id: 'conv-peer', reason: 'moot' },
        { conversation_id: 'conv-done', id: 'conv-done', reason: 'moot' },
      ],
    });
    expect(result).toMatchObject({ ok: false, counts: { ok: 0, failed: 2 } });
    expect(result.results[0]).toMatchObject({ ok: false, id: 'conv-peer', error: 'not_owner', hint: expect.any(String) });
    expect(result.results[1]).toMatchObject({ ok: false, id: 'conv-done', error: 'already_terminal', state: 'resolved' });
  });
});

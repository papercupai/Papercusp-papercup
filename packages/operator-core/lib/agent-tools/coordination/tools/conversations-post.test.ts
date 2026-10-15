/**
 * conversations-post.test.ts — the conversations:post HANDLER branch + result shaping
 * (the store ops openConversation/postReply are mocked). Two paths:
 *   • conversation_id present → REPLY: postReply, surfacing post_id + delivered, and
 *     mapping a store {error} to {ok:false, reason};
 *   • no conversation_id → NEW DISCUSSION: openConversation, and the unrouted HINT
 *     logic — a discussion with no topics warns it reaches only direct subscribers
 *     (the UX nudge to add topics for routing).
 * A regression that loses the reply/new branch, drops the error mapping, or shows the
 * wrong routing hint is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-post.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ openConversation: vi.fn(), postReply: vi.fn() }));

import { openConversation, postReply } from '../conversations';
import type { OpenConversationResult } from '../conversations-core';
import type { ConversationRow } from '../conversations-store';
import { mockResolvedTyped } from '../../../testing/typed-mock';
const openM = vi.mocked(openConversation);
const replyM = vi.mocked(postReply);

/** A complete conversation row, so `openConversation`'s resolved fixture is checked
 *  against the real `OpenConversationResult` instead of being cast through `never`. */
const convRow = (id: string): ConversationRow => ({
  id,
  kind: 'discussion',
  scope: 'operator',
  harness_slug: null,
  asker_id: 'me',
  title: null,
  body: '',
  state: 'open',
  accepted_answer: null,
  accepted_post_id: null,
  capture_target: null,
  promoted_issue_id: null,
  producer: null,
  superseded_by: null,
  created_ts: '2026-01-01T00:00:00.000Z',
  updated_ts: '2026-01-01T00:00:00.000Z',
  resolved_ts: null,
  superseded_ts: null,
});
const opened = (id: string, over: Partial<Omit<OpenConversationResult, 'conversation'>> = {}): OpenConversationResult => ({
  conversation: convRow(id),
  thread_id: `conv:${id}`,
  topics: [],
  delivered: 0,
  unrouted: false,
  direct_to: [],
  ...over,
});
const tool = (await import('./conversations-post')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ body: 'hello', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('conversations:post discovery', () => {
  it('routes consult threads to their typed verbs', () => {
    expect(tool.description).toContain(
      'Consult threads require typed verbs: use consult:reply to respond, consult:decline to decline, or consult:close to close',
    );
  });
});

describe('conversations:post reply path', () => {
  it('appends a reply and reports post_id + notified subscribers', async () => {
    replyM.mockResolvedValue({ post: { id: 'p1' }, delivered: 3 } as never);
    const b = body(await call({ conversation_id: 'c1', body: 'a reply' }));
    expect(replyM).toHaveBeenCalledWith({ ownerId: 'me' }, { conversation_id: 'c1', body: 'a reply' });
    expect(b).toMatchObject({ ok: true, conversation_id: 'c1', post_id: 'p1', notified_subscribers: 3 });
    expect(openM).not.toHaveBeenCalled();
  });

  it('maps a store error to { ok:false, reason }', async () => {
    replyM.mockResolvedValue({ error: 'not_a_member' } as never);
    const b = body(await call({ conversation_id: 'c1' }));
    expect(b).toMatchObject({ ok: false, reason: 'not_a_member' });
  });

  it('accepts id as the reply alias for conversation_id', async () => {
    replyM.mockResolvedValue({ post: { id: 'p-alias' }, delivered: 1 } as never);
    const b = body(await call({ id: 'c-alias', body: 'a reply' }));
    expect(replyM).toHaveBeenCalledWith({ ownerId: 'me' }, { conversation_id: 'c-alias', body: 'a reply' });
    expect(b).toMatchObject({ ok: true, conversation_id: 'c-alias', post_id: 'p-alias' });
  });

  it('prefers canonical conversation_id when both reply keys are supplied', async () => {
    replyM.mockResolvedValue({ post: { id: 'p-canonical' }, delivered: 1 } as never);
    const b = body(await call({ conversation_id: 'c-canonical', id: 'c-alias', body: 'a reply' }));
    expect(replyM).toHaveBeenCalledWith({ ownerId: 'me' }, { conversation_id: 'c-canonical', body: 'a reply' });
    expect(replyM).not.toHaveBeenCalledWith({ ownerId: 'me' }, { conversation_id: 'c-alias', body: 'a reply' });
    expect(b).toMatchObject({ ok: true, conversation_id: 'c-canonical', post_id: 'p-canonical' });
  });
});

describe('conversations:post new-discussion path', () => {
  it('starts a routed discussion and reports topics + how many agents it actually reached', async () => {
    mockResolvedTyped(openM, opened('c9', { topics: ['arch'], unrouted: false, delivered: 2 }));
    const b = body(await call({ title: 'how to X', topics: ['arch'] }));
    expect(openM).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({
      ok: true, conversation_id: 'c9', kind: 'discussion', topics: ['arch'],
      unrouted: false, notified_subscribers: 2,
    });
    // Was `toMatch(/routed/i)`. "Routed" is precisely the word that lied for
    // weeks: it described what the caller ATTEMPTED (topics were tagged), not
    // what happened, and stayed cheerful while questions reached zero agents
    // because no topic in this workspace had a subscriber. The hint now carries
    // the real delivery count, so assert THAT — a hint claiming success has to
    // name how many agents it actually reached.
    expect(String(b.hint)).toMatch(/\b2\b/);
    expect(String(b.hint)).toMatch(/notified/i);
  });

  it('warns when a new discussion is unrouted (no topics → direct subscribers only)', async () => {
    mockResolvedTyped(openM, opened('c10', { topics: [], unrouted: true, delivered: 0 }));
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, unrouted: true });
    expect(String(b.hint)).toMatch(/NO topics|Add topics/i);
  });
});

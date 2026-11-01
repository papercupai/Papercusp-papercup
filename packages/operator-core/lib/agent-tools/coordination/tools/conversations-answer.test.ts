/**
 * conversations-answer.test.ts — the conversations:answer HANDLER shaping, bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21; answerQuestion
 * mocked). Pins the store-error → per-item { ok:false, error } mapping and the
 * success shaping, including the hint that interpolates the new post_id into the
 * conversations:resolve { accepted_post_id } call the asker will make (keyed by id),
 * plus items:[…] answering many — each with its OWN body.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-answer.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ answerQuestion: vi.fn() }));

import { answerQuestion } from '../conversations';
const answerM = vi.mocked(answerQuestion);
const tool = (await import('./conversations-answer')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('conversations:answer handler (bulk keyed-array)', () => {
  it('maps a store error to a per-item { ok:false, error }', async () => {
    answerM.mockResolvedValue({ error: 'not_a_question' } as never);
    const b = await body({ id: 'c1', body: 'the answer' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'not_a_question' });
  });

  it('reports owner origin and a resolve hint wired to the post_id', async () => {
    answerM.mockResolvedValue({
      post: { id: 42 },
      delivered: 2,
      author_origin: 'owner-typed',
      owner_decision_effect: 'owner-typed-reply',
    } as never);
    const b = await body({ id: 'c1', body: 'the answer' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    const r = b.results[0];
    expect(r).toMatchObject({
      ok: true, id: 'c1', post_id: 42, notified_subscribers: 2,
      author_origin: 'owner-typed', owner_decision_effect: 'owner-typed-reply',
    });
    expect(String(r.hint)).toContain('accepted_post_id: 42');
  });

  it('does not present an agent peer opinion as an accept-able owner answer', async () => {
    answerM.mockResolvedValue({
      post: { id: 43 },
      delivered: 1,
      author_origin: 'agent',
      owner_decision_effect: 'peer-opinion',
    } as never);
    const b = await body({ id: 'owner-question', body: 'CONTINUE' });
    expect(b.results[0]).toMatchObject({
      author_origin: 'agent',
      owner_decision_effect: 'peer-opinion',
      hint: expect.stringContaining('does not answer the coord:ask-owner question'),
    });
    expect(String(b.results[0].hint)).not.toContain('accepted_post_id');
  });

  it('items:[…] answers many — each carries its own body; one bad item never fails the rest', async () => {
    answerM.mockImplementation(async (_id, opts: { conversation_id: string; body: string }) =>
      opts.conversation_id === 'c2'
        ? ({ error: 'not_found' } as never)
        : ({ post: { id: 7 }, delivered: 1, author_origin: 'agent' } as never),
    );
    const b = await body({
      items: [
        { id: 'c1', body: 'answer one' },
        { id: 'c2', body: 'answer two' },
      ],
    });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1', post_id: 7, author_origin: 'agent' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'c2', error: 'not_found' });
    expect(answerM.mock.calls[0]![1]).toMatchObject({ conversation_id: 'c1', body: 'answer one' });
  });
});

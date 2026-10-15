/**
 * conversations-resolve.test.ts — the conversations:resolve HANDLER guard +
 * shaping, bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21;
 * resolveConversation, which closes the thread + captures the answer to mem0, is
 * mocked). Pins the handler's own logic:
 *   • the per-item required-arg guard — accepted_answer OR accepted_post_id is
 *     mandatory; an item with neither fails WITHOUT touching the store for it;
 *   • the store-error → per-item { ok:false, error } mapping;
 *   • the success shaping (state + captured + notified_subscribers), keyed by id;
 *   • items:[…] resolves many, each with its OWN accepted answer.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-resolve.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ resolveConversation: vi.fn() }));

import { resolveConversation } from '../conversations';
const resolveM = vi.mocked(resolveConversation);
const tool = (await import('./conversations-resolve')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

describe('conversations:resolve handler (bulk keyed-array)', () => {
  it('documents that consult threads use the typed close verb', () => {
    expect(tool.description).toContain('Consult conversations are excluded; use consult:close');
  });

  it('an item missing both accepted answer + post id fails without touching the store', async () => {
    const b = await body({ id: 'c1' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'need_accepted_answer_or_post_id' });
    expect(resolveM).not.toHaveBeenCalled();
  });

  it('maps a store error to a per-item { ok:false, error }', async () => {
    resolveM.mockResolvedValue({ error: 'not_found' });
    const b = await body({ id: 'c1', accepted_post_id: 7 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'not_found' });
  });

  it('points consult resolution at the typed close verb', async () => {
    resolveM.mockResolvedValue({ error: 'consult_requires_typed_verb' });
    const b = await body({ id: 'consult-1', accepted_answer: 'answer' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'consult-1',
      error: 'consult_requires_typed_verb',
      hint: expect.stringContaining('consult:close'),
    });
  });

  it('on success reports state, capture target, and notified subscribers (keyed by id)', async () => {
    resolveM.mockResolvedValue({
      conversation: { id: 'c1', state: 'resolved' }, capture: 'mem0', delivered: 4,
    } as never);
    const b = await body({ id: 'c1', accepted_answer: 'do it this way' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1', state: 'resolved', captured: 'mem0', notified_subscribers: 4 });
    expect(resolveM.mock.calls[0]![1]).toMatchObject({ conversation_id: 'c1', accepted_answer: 'do it this way' });
  });

  it('projects only known capture fields and sanitized diagnostics into the response', async () => {
    resolveM.mockResolvedValue({
      conversation: { id: 'c1', state: 'resolved' },
      capture: {
        target: 'mem0_error',
        ok: false,
        detail: 'LLM extraction failed',
        diagnostics: {
          status: 404,
          requestId: 'req.123',
          type: 'anthropic',
          classification: 'permanent',
          transport: 'anthropic-direct',
          transportFailureCode: 'UND_ERR_HEADERS_TIMEOUT',
          url: 'https://provider.invalid/private-path',
          headers: { authorization: 'Bearer secret-token' },
          body: 'private provider response',
          account: 'private-account',
        },
        rawProviderPayload: 'private provider response',
      },
      delivered: 2,
    } as never);

    const b = await body({ id: 'c1', accepted_answer: 'do it this way' });

    expect(b.results[0].captured).toEqual({
      target: 'mem0_error',
      ok: false,
      detail: 'LLM extraction failed',
      diagnostics: {
        status: 404,
        requestId: 'req.123',
        type: 'anthropic',
        classification: 'permanent',
        transport: 'anthropic-direct',
        transportFailureCode: 'UND_ERR_HEADERS_TIMEOUT',
      },
    });
    expect(JSON.stringify(b.results[0])).not.toContain('secret-token');
    expect(JSON.stringify(b.results[0])).not.toContain('private provider response');
  });

  it('items:[…] resolves many — each carries its own accepted answer; one bad item never fails the rest', async () => {
    resolveM.mockImplementation(async (_id, opts: { conversation_id: string }) =>
      opts.conversation_id === 'c2'
        ? ({ error: 'not_a_question' } as never)
        : ({ conversation: { id: opts.conversation_id, state: 'resolved' }, capture: 'mem0', delivered: 1 } as never),
    );
    const b = await body({
      items: [
        { id: 'c1', accepted_answer: 'A1' },
        { id: 'c2', accepted_post_id: 5 },
      ],
    });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1', state: 'resolved' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'c2', error: 'not_a_question' });
  });
});

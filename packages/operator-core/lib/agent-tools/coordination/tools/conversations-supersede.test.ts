/** Handler shaping for conversations:supersede. The production workflow is
 * mocked here; core lifecycle and atomic row semantics live in
 * conversations-core.test.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import type { z } from 'zod';
import { mockResolvedTyped } from '../../../testing/typed-mock';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../conversations', () => ({ supersedeConversation: vi.fn() }));

import { supersedeConversation } from '../conversations';
import type { ConversationRow } from '../conversations-store';
import type { OpenConversationResult } from '../conversations-core';
const supersedeM = vi.mocked(supersedeConversation);
const tool = (await import('./conversations-supersede')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

const conversationFixture = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 'conv-old',
  kind: 'question',
  scope: 'operator',
  harness_slug: null,
  producer: 'test',
  asker_id: 'me',
  title: null,
  body: 'question',
  state: 'open',
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

const openConversationFixture = (over: Partial<OpenConversationResult> = {}): OpenConversationResult => ({
  conversation: conversationFixture(),
  thread_id: 'thr-conv-new',
  topics: [],
  delivered: 0,
  unrouted: false,
  direct_to: [],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('conversations:supersede handler', () => {
  it('publishes the bulk result contract for its authored return guidance', () => {
    const projected = lookupByMcpName('conversations:supersede')!;
    expect(projected.guidance?.returns).toBeTruthy();
    expect(projected.outputJsonSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['ok', 'results', 'counts']),
      properties: {
        ok: { type: 'boolean' },
        results: { type: 'array', items: { properties: { ok: { type: 'boolean' } } } },
        counts: { properties: { ok: { type: 'integer' }, failed: { type: 'integer' } } },
      },
    });
  });

  it('maps a lifecycle error to the item instead of failing the whole call', async () => {
    mockResolvedTyped(supersedeM, { error: 'already_superseded' });
    const result = await body({
      id: 'conv-old',
      replacement: { body: 'corrected question' },
    });
    expect(result).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(result.results[0]).toMatchObject({ ok: false, id: 'conv-old', error: 'already_superseded' });
    expect((tool.result as z.ZodType).parse(result)).toEqual(result);
  });

  it('returns the RETRACTED pointer and replacement thread id', async () => {
    mockResolvedTyped(supersedeM, {
      conversation: conversationFixture({ state: 'superseded', superseded_by: 'conv-new' }),
      replacement: openConversationFixture({
        conversation: conversationFixture({ id: 'conv-new', state: 'open' }),
        thread_id: 'thr-conv-new',
        delivered: 2,
      }),
      delivered: 2,
    });
    const result = await body({
      id: 'conv-old',
      replacement: { body: 'corrected question', topics: ['release'] },
      reason: 'old premise falsified',
    });
    expect(result).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(result.results[0]).toMatchObject({
      ok: true,
      id: 'conv-old',
      state: 'superseded',
      superseded_by: 'conv-new',
      replacement: { id: 'conv-new', state: 'open', thread_id: 'thr-conv-new' },
      notified_subscribers: 2,
    });
    expect((tool.result as z.ZodType).parse(result)).toEqual(result);
    expect(supersedeM).toHaveBeenCalledWith({ ownerId: 'me' }, {
      conversation_id: 'conv-old',
      replacement: { body: 'corrected question', topics: ['release'] },
      reason: 'old premise falsified',
    });
  });

  it('forwards the exact accepted answer for a single resolved-owner correction', async () => {
    mockResolvedTyped(supersedeM, { error: 'resolution_changed' });
    const result = await body({
      id: 'conv-old',
      expected_answer: 'approved answer v1',
      replacement: { body: 'corrected question' },
      reason: 'the accepted answer was stale',
    });

    expect(result.results[0]).toMatchObject({ ok: false, id: 'conv-old', error: 'resolution_changed' });
    expect(supersedeM).toHaveBeenCalledWith({ ownerId: 'me' }, {
      conversation_id: 'conv-old',
      expected_answer: 'approved answer v1',
      replacement: { body: 'corrected question' },
      reason: 'the accepted answer was stale',
    });
  });

  it('forwards per-item expected answers in a bulk correction', async () => {
    mockResolvedTyped(supersedeM, { error: 'resolution_changed' });
    await body({
      items: [{
        id: 'conv-old',
        expected_answer: 'approved answer v1',
        replacement: { body: 'corrected question' },
      }],
    });

    expect(supersedeM).toHaveBeenCalledWith({ ownerId: 'me' }, expect.objectContaining({
      conversation_id: 'conv-old',
      expected_answer: 'approved answer v1',
    }));
  });
});

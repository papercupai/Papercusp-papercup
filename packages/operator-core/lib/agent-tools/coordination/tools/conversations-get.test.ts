/**
 * conversations-get.test.ts — the conversations:get HANDLER projection, bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21; getConversation
 * mocked). Pins the not_found → per-item { ok:false } mapping, the deliberate
 * field-subset projection (the conversation's chosen fields are surfaced, each post
 * is projected to exactly {id, author_id, body, created_ts} — extra store columns
 * are dropped, not leaked), and that a missing id in an ids:[…] batch fails only
 * that item. A regression that leaks/loses a field, drops the not_found guard, or
 * lets one miss poison the batch is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-get.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail } from '../conversations-core';
import type { ConversationRow } from '../conversations-store';

vi.mock('../conversations', async (importActual) => ({
  getConversation: vi.fn(),
  getConsultStates: vi.fn(),
  getThreadPost: vi.fn(),
  // The REAL pure summarizer: its output is what the tool is asked to surface.
  summarizeConsultDispatch: (await importActual<typeof import('../conversations')>()).summarizeConsultDispatch,
}));

import {
  getConversation,
  getConsultStates,
  getThreadPost,
  summarizeConsultDispatch,
  type ConsultDispatchSummary,
} from '../conversations';
const getM = vi.mocked(getConversation);
const consultM = vi.mocked(getConsultStates);
const postM = vi.mocked(getThreadPost);
const tool = (await import('./conversations-get')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

/**
 * A COMPLETE, genuinely-typed ConversationDetail with a `Partial` override
 * seam, so call sites need no `as never` and a new required field on
 * ConversationRow breaks this factory loudly at typecheck instead of rotting
 * the fixtures silently (lint:mock-cast-escape's preferred shape).
 */
const conversationRow = (id: string, over: Partial<ConversationRow> = {}): ConversationRow => ({
  id,
  kind: 'question',
  // 'operator', not the 'global' this fixture carried before it was typed:
  // ConversationScope is 'operator' | 'harness', and 'global' was never a
  // member. The old `as never` cast hid that outright — which is precisely the
  // silent fixture rot the typed factory exists to surface.
  scope: 'operator',
  harness_slug: null,
  asker_id: 'a1',
  title: 'How?',
  body: 'the seed',
  state: 'resolved',
  accepted_answer: 'do X',
  accepted_post_id: 9,
  capture_target: 'mem0',
  promoted_issue_id: null,
  producer: null,
  superseded_by: null,
  created_ts: 't0',
  updated_ts: 't0',
  resolved_ts: 't1',
  superseded_ts: null,
  ...over,
});

const detail = (id: string, over: Partial<ConversationRow> = {}): ConversationDetail => ({
  conversation: conversationRow(id, over),
  topics: ['arch'],
  subscriber_count: 2,
  // The extra `secret` column is deliberate — it is what the projection test
  // proves gets dropped rather than leaked. Attached via Object.assign so the
  // surrounding fixture stays typechecked instead of being cast wholesale.
  posts: [
    Object.assign({ id: 1, author_id: 'b1', body: 'reply', created_ts: 't2' }, { secret: 'DROP_ME' }),
  ] as unknown as ConversationDetail['posts'],
});

beforeEach(() => {
  vi.clearAllMocks();
  postM.mockResolvedValue(null);
  // Default: no consult rows — the ordinary (non-consult) conversation path.
  // No `as never`: getConsultStates' real return type is
  // Promise<Map<string, ConsultLifecycleState>>, which an empty Map satisfies
  // outright, so the fixture stays genuinely typechecked against the signature.
  consultM.mockResolvedValue(new Map());
});

describe('conversations:get handler (bulk keyed-array)', () => {
  it('maps a missing conversation to a per-item { ok:false, reason→error:not_found }', async () => {
    getM.mockResolvedValue(null);
    const b = await body({ id: 'c1' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'not_found' });
  });

  it('resolves a thread-post citation in the caller workspace without treating it as a conversation id', async () => {
    const post = {
      id: 1152470,
      thread_id: 'work-item-thread-WI-7',
      author_id: 'su-reviewer',
      body: 'approve the reviewed change',
      created_ts: '2026-10-01T08:00:00.000Z',
    };
    postM.mockResolvedValue(post);
    const result = ((await tool.handler(
      { id: 'thread-post:1152470' } as never,
      { isSuperuser: true, uiClientId: 'client-1', workspaceId: 'ws-x' } as never,
    )) as Out).data;

    expect(postM).toHaveBeenCalledWith(1152470, expect.objectContaining({ workspaceId: 'ws-x' }));
    expect(getM).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ ok: true, id: 'thread-post:1152470', post });
    expect(result.results[0]).not.toHaveProperty('conversation');
  });

  it('rejects malformed thread-post citations without falling through to conversation prefix lookup', async () => {
    const result = await body({ id: 'thread-post:01' });
    expect(result.results[0]).toMatchObject({ ok: false, id: 'thread-post:01', error: 'not_found' });
    expect(postM).not.toHaveBeenCalled();
    expect(getM).not.toHaveBeenCalled();
  });

  it('projects the conversation fields, topics, count, and trims post fields', async () => {
    getM.mockResolvedValue(detail('c1'));
    const b = await body({ id: 'c1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    const r = b.results[0];
    expect(r).toMatchObject({
      ok: true,
      id: 'c1',
      conversation: { id: 'c1', kind: 'question', state: 'resolved', accepted_post_id: 9, capture_target: 'mem0' },
      topics: ['arch'],
      subscriber_count: 2,
    });
    expect(r.posts).toEqual([{ id: 1, author_id: 'b1', body: 'reply', created_ts: 't2' }]);
    expect(r.posts[0]).not.toHaveProperty('secret'); // extra store columns are not leaked
  });

  // EI-21914051456641891: when the core resolved a hand-truncated id via
  // its unique-prefix fallback, the tool surfaces an explicit `warning`
  // naming the real full id — never silently swaps ids into the response
  // with no trace that a fallback happened.
  it('surfaces a `warning` naming the real id when the core resolved via prefix fallback', async () => {
    getM.mockResolvedValue({ ...detail('conv-mtg3t543-0000-abc'), resolvedFromPrefix: 'conv-mtg3t543' });
    const b = await body({ id: 'conv-mtg3t543' });
    const r = b.results[0];
    expect(r).toMatchObject({ ok: true, id: 'conv-mtg3t543' });
    expect(r.conversation.id).toBe('conv-mtg3t543-0000-abc');
    expect(r.warning).toMatch(/conv-mtg3t543-0000-abc/);
    expect(r.warning).toMatch(/prefix/i);
  });

  it('an EXACT match carries no `warning` field at all', async () => {
    getM.mockResolvedValue(detail('c1'));
    const b = await body({ id: 'c1' });
    expect(b.results[0]).not.toHaveProperty('warning');
  });

  it('ids:[…]: one found + one missing — the miss fails only its item', async () => {
    getM.mockImplementation(async (id: string) => (id === 'c404' ? null : detail(id)));
    const b = await body({ ids: ['c1', 'c404'] });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'c404', error: 'not_found' });
  });

  it('accepts conversation_id as the single-item alias for id', async () => {
    getM.mockResolvedValue(detail('c-alias'));
    const b = await body({ conversation_id: 'c-alias' });
    expect(getM).toHaveBeenCalledWith('c-alias', undefined);
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c-alias' });
  });

  it('prefers canonical id when id and conversation_id are both supplied', async () => {
    getM.mockResolvedValue(detail('c-canonical'));
    const b = await body({ id: 'c-canonical', conversation_id: 'c-alias' });
    expect(getM).toHaveBeenCalledWith('c-canonical', undefined);
    expect(getM).not.toHaveBeenCalledWith('c-alias', expect.anything());
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c-canonical' });
  });

  // WI-1571 read side: a workspace-scoped caller must read ITS OWN partition
  // (the one its writes land in) — an identity-less read resolved 'default' and
  // returned not_found for the caller's own conversations (live 2026-07-07).
  it('threads the caller identity into the read so reader and writer resolve the same partition', async () => {
    getM.mockResolvedValue(null);
    await tool.handler(
      { id: 'c1' } as never,
      { isSuperuser: true, uiClientId: 'client-1', workspaceId: 'ws-x' } as never,
    );
    expect(getM).toHaveBeenCalledWith('c1', expect.objectContaining({ workspaceId: 'ws-x' }));
  });

  it('an unattributable context reads identity-less (fail-open — request-ALS chain unchanged)', async () => {
    getM.mockResolvedValue(null);
    await body({ id: 'c1' });
    expect(getM).toHaveBeenCalledWith('c1', undefined);
  });

  // EI-21510601647367544 — the divergence that makes this necessary.
  describe('consult lifecycle state', () => {
    const consultRow = (id: string) => ({
      conversation_id: id,
      state: 'expired',
      latency_contract: 'proceed',
      responder_id: 'su-884f6b9f',
      expires_at: '2026-08-26T07:44:56.262Z',
      closed_at: '2026-08-26T07:48:28.261Z',
      wakes_used: 1,
      session_cost: {
        status: 'partial' as const,
        usd: 0.03,
        sample_count: 2,
        priced_sample_count: 1,
        estimated_sample_count: 1,
        unpriced_sample_count: 0,
      },
      dispatch: null as ConsultDispatchSummary | null,
    });

    it('exposes an unmeasured routing result and remedy separately from the no-responder lifecycle', async () => {
      const result = { verdict: 'relevance_unmeasured', reason: 'evidence_unavailable',
        hint: 'This does not prove no expert exists.', remaining_candidates: [] };
      getM.mockResolvedValue(detail('c-unmeasured', { kind: 'consult', state: 'open' }));
      consultM.mockResolvedValue(new Map([['c-unmeasured', {
        ...consultRow('c-unmeasured'), state: 'no_qualified_responder', request_result: result,
      }]]));
      const reply = (await body({ id: 'c-unmeasured' })).results[0];
      expect(reply.consult.state).toBe('no_qualified_responder');
      expect(reply.consult.result).toEqual(result);
      expect(reply.consult.result.verdict).not.toBe('no_qualified_responder');
    });

    it('surfaces WHY each answering-session launch failed once a dispatch walk is recorded (WI-10003197)', async () => {
      const dispatch = summarizeConsultDispatch([
        {
          at: '2026-09-26T03:33:07.713Z',
          dispatched: false,
          answeringOwnerId: null,
          detail: 'every allowed expert model was exhausted …',
          attempts: [
            {
              rank: 1,
              agent: 'claude',
              model: 'opus',
              operation: 'fork',
              outcome: 'failed',
              reason: 'launch-exited',
              detail: 'long detail',
              launchError: 'psu: refusing unmanaged fork su-x: could not recover adv row #29351.',
            },
          ],
        },
      ]);
      getM.mockResolvedValue(detail('c-consult', { kind: 'consult', state: 'open' }));
      consultM.mockResolvedValue(new Map([['c-consult', { ...consultRow('c-consult'), dispatch }]]));
      const r = (await body({ id: 'c-consult' })).results[0];
      expect(r.consult.dispatch.recent[0].attempts[0]).toEqual({
        rank: 1,
        agent: 'claude',
        model: 'opus',
        operation: 'fork',
        outcome: 'failed',
        reason: 'launch-exited',
        launch_error: 'psu: refusing unmanaged fork su-x: could not recover adv row #29351.',
      });
    });

    it('surfaces `consult` for a consult conversation whose CONVERSATION row still reads open', async () => {
      // The real observed shape: conversation.state 'open' while the consult
      // itself expired and closed 49 minutes earlier. Reading only the
      // conversation cannot tell that apart from a live consult, which is
      // exactly the wrong inference this field exists to prevent.
      getM.mockResolvedValue(detail('c-consult', { kind: 'consult', state: 'open' }));
      consultM.mockResolvedValue(new Map([['c-consult', consultRow('c-consult')]]));

      const r = (await body({ id: 'c-consult' })).results[0];
      expect(r.conversation.state).toBe('open'); // unchanged — still the conversation's own state
      expect(r.consult).toEqual({
        state: 'expired',
        latency_contract: 'proceed',
        responder_id: 'su-884f6b9f',
        expires_at: '2026-08-26T07:44:56.262Z',
        closed_at: '2026-08-26T07:48:28.261Z',
        wakes_used: 1,
        session_cost: {
          status: 'partial',
          usd: 0.03,
          sample_count: 2,
          priced_sample_count: 1,
          estimated_sample_count: 1,
          unpriced_sample_count: 0,
        },
      });
    });

    it('omits `consult` entirely for a non-consult conversation (no consumer shape changes)', async () => {
      getM.mockResolvedValue(detail('c1'));
      const r = (await body({ id: 'c1' })).results[0];
      expect(r).not.toHaveProperty('consult');
    });

    it('summarizeConsultDispatch keeps the newest walks only, drops long detail, and is null when empty', () => {
      const walk = (i: number) => ({
        at: `t${i}`,
        dispatched: i === 5,
        answeringOwnerId: i === 5 ? 'su-a' : null,
        detail: 'x'.repeat(500),
        attempts: [{ rank: 1, agent: 'claude', model: 'opus', operation: 'fork', outcome: 'skipped', detail: 'y' }],
      });
      const s = summarizeConsultDispatch([1, 2, 3, 4, 5].map(walk))!;
      expect(s.total_walks).toBe(5);
      expect(s.recent.map((w) => w.at)).toEqual(['t3', 't4', 't5']);
      expect(s.recent[2]).toMatchObject({ dispatched: true, answering_owner_id: 'su-a' });
      // no reason / launch_error key when the rank had none; no `detail` at all
      expect(s.recent[0]!.attempts[0]).toEqual({
        rank: 1, agent: 'claude', model: 'opus', operation: 'fork', outcome: 'skipped',
      });
      expect(JSON.stringify(s)).not.toContain('xxxxx');
      expect(summarizeConsultDispatch([])).toBeNull();
      expect(summarizeConsultDispatch(null)).toBeNull();
      expect(summarizeConsultDispatch('[]')).toBeNull();
    });

    it('omits consult.dispatch when no walk is recorded (CONTROL — no shape change for old consults)', async () => {
      getM.mockResolvedValue(detail('c-consult', { kind: 'consult', state: 'open' }));
      consultM.mockResolvedValue(new Map([['c-consult', consultRow('c-consult')]]));
      const r = (await body({ id: 'c-consult' })).results[0];
      expect(r.consult).not.toHaveProperty('dispatch');
    });

    it('batches the lifecycle read ONCE for the whole ids:[…] set, not per id', async () => {
      // Guards the N+1 this was deliberately written to avoid: conversations:get
      // accepts up to 100 ids.
      getM.mockImplementation(async (id: string) => detail(id));
      await body({ ids: ['c1', 'c2', 'c3'] });
      expect(consultM).toHaveBeenCalledTimes(1);
      expect(consultM).toHaveBeenCalledWith(['c1', 'c2', 'c3'], undefined);
    });
  });
});

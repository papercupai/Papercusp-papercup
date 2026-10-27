import { describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@papercusp/tooldef';
import consultReplyTool from './reply';
import { isConfirmedDeadConsultResponder, measureConsultFollowupReach } from './reply';
import { consultReplyCore } from '../../consult/consult-verbs-core';
import { validateDecisionReviewStance } from '../../consult/decision-review';

const result = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
}) as unknown as ToolResult;

describe('consult follow-up confirmed-dead classifier', () => {
  it.each([0, 1])('measures the exact answering identity after queued wake count %i', async (woke) => {
    const endedSessions = new Map([['responder-1', '2026-10-25T00:01:25Z']]);
    const readLiveness = vi.fn(async () => ({ report: { degraded: false, confirmedDead: [] }, endedSessions }));
    await expect(measureConsultFollowupReach('responder-1', async () => ({ woke }), readLiveness))
      .resolves.toEqual({ woke, confirmedDead: true });
    expect(readLiveness).toHaveBeenCalledOnce();
    await expect(measureConsultFollowupReach('responder-2', async () => ({ woke }), readLiveness))
      .resolves.toEqual({ woke, confirmedDead: false });
    await expect(measureConsultFollowupReach('responder-1', async () => ({ woke }), async () => ({
      report: { degraded: false, confirmedDead: [], live: ['responder-1'] }, endedSessions,
    }))).resolves.toEqual({ woke, confirmedDead: false });
  });

  it('requires an explicit confirmed-dead result for the exact responder', () => {
    expect(isConfirmedDeadConsultResponder({ degraded: false, confirmedDead: ['responder-1'] }, 'responder-1')).toBe(true);
    expect(isConfirmedDeadConsultResponder({ degraded: false, idle: ['responder-1'] } as never, 'responder-1')).toBe(false);
    expect(isConfirmedDeadConsultResponder({ degraded: true, confirmedDead: ['responder-1'] }, 'responder-1')).toBe(false);
  });

  it('uses an exact ended-session record when the wake liveness report cannot confirm death', () => {
    const ended = new Map<string, string | null>([['responder-1', '2026-10-12T20:49:14.671778-04:00']]);
    expect(
      isConfirmedDeadConsultResponder(
        { degraded: false, confirmedDead: [], live: [], aliveNotWakeable: [], dormantScheduled: [] },
        'responder-1',
        ended,
      ),
    ).toBe(true);
    expect(
      isConfirmedDeadConsultResponder(
        { degraded: false, confirmedDead: [], live: [], aliveNotWakeable: [], dormantScheduled: [] },
        'responder-2',
        ended,
      ),
    ).toBe(false);
  });

  it('does not let an ended-session record override current liveness evidence', () => {
    const ended = new Map<string, string | null>([['responder-1', '2026-10-12T20:49:14.671778-04:00']]);
    expect(
      isConfirmedDeadConsultResponder(
        { degraded: false, confirmedDead: [], live: ['responder-1'], aliveNotWakeable: [], dormantScheduled: [] },
        'responder-1',
        ended,
      ),
    ).toBe(false);
    expect(
      isConfirmedDeadConsultResponder(
        {
          degraded: false,
          confirmedDead: [],
          live: [],
          aliveNotWakeable: [],
          dormantScheduled: [{ ownerId: 'responder-1' } as never],
        },
        'responder-1',
        ended,
      ),
    ).toBe(false);
  });
});

// consult-backed-parking-2026-10-12 P-004 — bars R-4 (stance required on a
// decision-review consult) and R-15 (an objection needs an alternative, hazard
// evidence, or an owner-authority topic).
describe('consult:reply stance on decision-review consults (R-4, R-15)', () => {
  const CONV = 'conv-muw5z34v-0000-581b3950cb3a49c6b018d1b83a5fc373';
  const REVIEWER = 'su-reviewer-1';

  function stateRow(flavor: string | null) {
    return {
      workspace_id: 'ws',
      conversation_id: CONV,
      requester_id: 'su-parker',
      responder_id: 'su-reviewer-2',
      state: 'active',
      question: 'Park: proceed with default X?',
      latency_contract: 'proceed',
      max_exchanges: 4,
      exchanges_used: 0,
      wakes_used: 0,
      // The reviewer is a PAST selectee (cursor moved on), so the reply is an
      // ordinary exchange: no cascade advance, no follow-up wake.
      cascade_cursor: 1,
      cascade_digest: [],
      origin_task_ref: 'WI-1',
      routing: {
        selection: { selected: [{ ownerId: REVIEWER, score: 1 }, { ownerId: 'su-reviewer-2', score: 1 }] },
        cascade: flavor
          ? { flavor, workItemId: 'WI-1', setterId: 'su-parker', defaultAction: 'X', deadlineAt: '2026-10-13T01:00:00Z', ownerAuthorityTopic: null }
          : null,
      },
      outcome: null,
      closed_at: null,
    };
  }

  function harness(flavor: string | null) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push({ text, values });
      if (/SELECT[\s\S]*FROM harness_shared\.consult_state/.test(text)) return Promise.resolve([stateRow(flavor)]);
      return Promise.resolve([]);
    };
    const sql = Object.assign(sqlFn, { json: (v: unknown) => ({ __json: v }) });
    const post = vi.fn(async () => ({ post: { id: 4242 } }));
    const deps = {
      getSql: () => sql as never,
      post: post as never,
      emitReplyEvent: vi.fn(async () => {}),
    };
    return { queries, post, deps };
  }

  const reply = (stance: unknown) => ({
    workspaceId: 'ws',
    authorId: REVIEWER,
    conversationId: CONV,
    kind: 'new_fact' as const,
    body: 'My view on the parked default.',
    ...(stance === undefined ? {} : { stance }),
  });

  it('refuses a stance-less reviewer reply before anything is posted', async () => {
    const h = harness('decision-review');
    const out = await consultReplyCore(reply(undefined), h.deps);
    expect(out).toMatchObject({ error: 'stance_required' });
    expect(h.post).not.toHaveBeenCalled();
  });

  it('refuses an objection with no alternative, no hazard evidence and no owner-authority topic', async () => {
    for (const stance of [
      { position: 'object', reason: 'I disagree' },
      { position: 'object', basis: 'alternative', reason: 'I disagree' },
      { position: 'object', basis: 'alternative', alternative: 'do Y' },
      { position: 'object', basis: 'hazard', reason: 'risky', evidence: [] },
      { position: 'object', basis: 'owner-authority', topic: 'vibes' },
    ]) {
      const h = harness('decision-review');
      const out = await consultReplyCore(reply(stance), h.deps);
      expect(out, JSON.stringify(stance)).toMatchObject({ error: 'objection_basis_required' });
      expect(h.post).not.toHaveBeenCalled();
    }
  });

  it('accepts support, no-view and each valid objection basis, and stores the stance with the post', async () => {
    for (const stance of [
      { position: 'support' },
      { position: 'no-view', reason: 'outside my context' },
      { position: 'object', basis: 'alternative', reason: 'X breaks Z', alternative: 'do Y instead' },
      { position: 'object', basis: 'hazard', reason: 'drops data', evidence: ['WI-123'] },
      { position: 'object', basis: 'owner-authority', topic: 'spend' },
    ]) {
      const h = harness('decision-review');
      const out = await consultReplyCore(reply(stance), h.deps);
      expect(out, JSON.stringify(stance)).toMatchObject({ ok: true, post_id: 4242, stance: { position: stance.position } });
      const insert = h.queries.find((q) => q.text.includes('INSERT INTO harness_shared.consult_post_meta'));
      expect(insert?.text).toContain('stance');
      expect(insert?.values).toContainEqual({ __json: expect.objectContaining({ position: stance.position }) });
    }
  });

  it('leaves ordinary consults alone: no stance required, none stored', async () => {
    const h = harness(null);
    const out = await consultReplyCore(reply(undefined), h.deps);
    expect(out).toMatchObject({ ok: true, post_id: 4242 });
    expect(out).not.toHaveProperty('stance');
    const insert = h.queries.find((q) => q.text.includes('INSERT INTO harness_shared.consult_post_meta'));
    expect(insert?.text).not.toContain('stance');
  });

  it('validateDecisionReviewStance normalizes what it accepts', () => {
    expect(validateDecisionReviewStance({ position: 'object', basis: 'alternative', reason: ' a ', alternative: ' b ', extra: 1 }))
      .toEqual({ ok: true, stance: { position: 'object', basis: 'alternative', reason: 'a', alternative: 'b' } });
    expect(validateDecisionReviewStance({ position: 'maybe' })).toMatchObject({ ok: false, error: 'invalid_stance' });
  });

  it('exposes the stance argument on the tool schema', () => {
    const parsed = (consultReplyTool.args as unknown as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      conversation_id: CONV,
      kind: 'new_fact',
      body: 'x',
      stance: { position: 'object', basis: 'hazard', reason: 'r', evidence: ['WI-1'] },
    });
    expect(parsed.success).toBe(true);
  });
});

// consult-backed-parking-2026-10-12 P-006 — bars R-6/R-16: the parked agent
// (the requester of a decision review) adopts or rebuts an objection through
// consult:reply's parkResponse, and the park resolver runs after every reply on
// a decision review.
describe('consult:reply parkResponse on decision-review consults (R-6, R-16)', () => {
  const CONV = 'conv-muw5z34v-0000-681b3950cb3a49c6b018d1b83a5fc374';
  const PARKER = 'su-parker';
  const REVIEWER = 'su-reviewer-1';

  function harness(flavor: string | null, opts: { resolverThrows?: boolean } = {}) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push({ text, values });
      if (/SELECT[\s\S]*FROM harness_shared\.consult_state/.test(text)) {
        return Promise.resolve([
          {
            workspace_id: 'ws',
            conversation_id: CONV,
            requester_id: PARKER,
            responder_id: REVIEWER,
            state: 'active',
            question: 'Park: proceed with default X?',
            latency_contract: 'proceed',
            max_exchanges: 4,
            exchanges_used: 1,
            wakes_used: 0,
            cascade_cursor: 0,
            cascade_digest: [],
            origin_task_ref: 'WI-1',
            routing: {
              selection: { selected: [{ ownerId: REVIEWER, score: 1 }] },
              cascade: flavor
                ? { flavor, workItemId: 'WI-1', setterId: PARKER, defaultAction: 'X', deadlineAt: '2026-10-13T01:00:00Z', ownerAuthorityTopic: null }
                : null,
            },
            outcome: null,
            closed_at: null,
          },
        ]);
      }
      return Promise.resolve([]);
    };
    const sql = Object.assign(sqlFn, { json: (v: unknown) => ({ __json: v }) });
    const post = vi.fn(async () => ({ post: { id: 5151 } }));
    const onDecisionReviewReply = vi.fn(async () => {
      if (opts.resolverThrows) throw new Error('resolver down');
    });
    const deps = {
      getSql: () => sql as never,
      post: post as never,
      emitReplyEvent: vi.fn(async () => {}),
      onDecisionReviewReply,
      now: () => new Date('2026-10-13T00:30:00Z'),
    };
    const parkerWrite = () =>
      queries.find((q) => q.text.includes('UPDATE harness_shared.consult_state') && q.text.includes('parkerResponses'));
    return { queries, post, deps, onDecisionReviewReply, parkerWrite };
  }

  const reply = (authorId: string, parkResponse: unknown, extra: Record<string, unknown> = {}) => ({
    workspaceId: 'ws',
    authorId,
    conversationId: CONV,
    kind: 'new_fact' as const,
    body: 'Answering the objection.',
    parkResponse: parkResponse as never,
    ...extra,
  });

  it('records the parker adopt on park_state.parkerResponses after the post, then runs the resolver', async () => {
    const h = harness('decision-review');
    const out = await consultReplyCore(
      reply(PARKER, { kind: 'adopt', text: 'Doing Y instead.', objectionId: '777' }),
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, post_id: 5151, role: 'requester' });
    const write = h.parkerWrite();
    expect(write).toBeDefined();
    expect(write?.values).toContainEqual({
      __json: { kind: 'adopt', at: '2026-10-13T00:30:00.000Z', text: 'Doing Y instead.', objectionId: '777' },
    });
    // Ordering: the response is recorded only after the post committed.
    const postIdx = h.queries.findIndex((q) => q.text.includes('INSERT INTO harness_shared.consult_post_meta'));
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(h.queries.indexOf(write!)).toBeGreaterThan(postIdx);
    expect(h.onDecisionReviewReply).toHaveBeenCalledWith({ workspaceId: 'ws', conversationId: CONV, now: '2026-10-13T00:30:00.000Z' });
  });

  it('records a rebut with a null objectionId when none is named', async () => {
    const h = harness('decision-review');
    const out = await consultReplyCore(reply(PARKER, { kind: 'rebut', text: 'X is right because Z.' }), h.deps);
    expect(out).toMatchObject({ ok: true });
    expect(h.parkerWrite()?.values).toContainEqual({
      __json: { kind: 'rebut', at: '2026-10-13T00:30:00.000Z', text: 'X is right because Z.', objectionId: null },
    });
  });

  it('refuses a parkResponse from a reviewer, or on an ordinary consult, before anything is posted', async () => {
    const fromReviewer = harness('decision-review');
    expect(
      await consultReplyCore(
        reply(REVIEWER, { kind: 'adopt', text: 'y' }, { stance: { position: 'support' } }),
        fromReviewer.deps,
      ),
    ).toMatchObject({ error: 'park_response_not_applicable' });
    expect(fromReviewer.post).not.toHaveBeenCalled();

    const ordinary = harness(null);
    expect(await consultReplyCore(reply(PARKER, { kind: 'adopt', text: 'y' }), ordinary.deps)).toMatchObject({
      error: 'park_response_not_applicable',
    });
    expect(ordinary.post).not.toHaveBeenCalled();
  });

  it('refuses a malformed parkResponse before anything is posted', async () => {
    for (const pr of [{ kind: 'maybe', text: 'x' }, { kind: 'adopt', text: '   ' }, { kind: 'rebut' }]) {
      const h = harness('decision-review');
      expect(await consultReplyCore(reply(PARKER, pr), h.deps), JSON.stringify(pr)).toMatchObject({
        error: 'invalid_park_response',
      });
      expect(h.post).not.toHaveBeenCalled();
    }
  });

  it('runs the resolver on a plain reply to a decision review, but never on an ordinary consult', async () => {
    const dr = harness('decision-review');
    await consultReplyCore(reply(PARKER, undefined), dr.deps);
    expect(dr.onDecisionReviewReply).toHaveBeenCalledTimes(1);
    expect(dr.parkerWrite()).toBeUndefined();

    const ordinary = harness(null);
    await consultReplyCore(reply(PARKER, undefined), ordinary.deps);
    expect(ordinary.onDecisionReviewReply).not.toHaveBeenCalled();
  });

  it('keeps the committed reply when the resolver throws (fail-soft)', async () => {
    const h = harness('decision-review', { resolverThrows: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await consultReplyCore(reply(PARKER, { kind: 'adopt', text: 'Doing Y.' }), h.deps);
      expect(out).toMatchObject({ ok: true, post_id: 5151 });
      expect(h.parkerWrite()).toBeDefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('park resolver failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('exposes the parkResponse argument on the tool schema', () => {
    const schema = consultReplyTool.args as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(
      schema.safeParse({ conversation_id: CONV, kind: 'new_fact', body: 'x', parkResponse: { kind: 'rebut', text: 'because' } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ conversation_id: CONV, kind: 'new_fact', body: 'x', parkResponse: { kind: 'maybe', text: 'because' } }).success,
    ).toBe(false);
  });
});

describe('consult:reply abort completion receipt', () => {
  it('declares enough time for post-commit requester and cascade delivery', () => {
    // The nested MCP deadline is timeoutSec + 5s, above its flat 55s floor.
    expect(consultReplyTool.timeoutSec).toBe(120);
  });

  it('surfaces the exact post recorded before a late cascade completion', () => {
    expect(consultReplyTool.idempotent).not.toBe(true);
    expect(consultReplyTool.abortCompletionReceipt).toEqual(expect.any(Function));

    const receipt = consultReplyTool.abortCompletionReceipt?.(
      { conversation_id: 'conv-123', kind: 'new_fact', body: 'A concise follow-up.' },
      result({ data: { ok: true, post_id: 1151100 } }),
      { callId: 'call-123', toolName: 'consult:reply' },
    );

    expect(receipt).toEqual({
      status: 'recorded',
      effectRef: 'consult-reply:conv-123:1151100',
    });
  });

  it('fails closed when a completed response has no durable post identity', () => {
    const receipt = consultReplyTool.abortCompletionReceipt?.(
      { conversation_id: 'conv-123', kind: 'new_fact', body: 'A concise follow-up.' },
      result({ data: { ok: true, role: 'responder' } }),
      { callId: 'call-124', toolName: 'consult:reply' },
    );

    expect(receipt).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-post-id'],
    });
  });
});

/**
 * EI-21559794492221235 — the `system:consult-expiry-sweep` production adapters.
 *
 * ── WHAT THIS FILE IS EVIDENCE OF ──────────────────────────────────────────────
 * Every assertion below CALLS the adapter. Before the extraction these lived as
 * lambdas inside a `registerSystemAction` closure, so the only thing a suite could do
 * with them was match their source text — which cannot catch a wrong field, a wrong
 * parameter, or a workspace threaded from the wrong place. That this file can exist
 * at all is the point of the change.
 *
 * ── WHY THESE PARTICULAR ASSERTIONS ────────────────────────────────────────────
 * `consult_state` is workspace-PARTITIONED and ONE sweep serves every workspace, so
 * each adapter must carry the workspace from the ROW it was handed. Taking it from
 * ambient scope instead addresses the wrong tenant while still passing every
 * `consult-expiry-core` test, because the core supplies the workspace and never checks
 * where the adapter sourced it. So the tests pass a row workspace that is deliberately
 * DIFFERENT from any plausible ambient default and assert it arrives intact.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CONSULT_EXPIRY_SWEEP_OWNER_ID,
  CONSULT_CARRY_RESPAWN_GRACE_MS,
  REVIEW_CONSULT_CONDITION_NAMESPACE,
  consultExpiryFileReviewWorkItem,
  consultExpiryEmitReplyEvent,
  consultExpiryFindSilentResponders,
  consultExpiryNotifyRequester,
  consultExpiryDispatch,
  consultExpiryStopAnsweringSession,
  sweepIdentity,
  type AnsweringSessionTaskSeams,
  type AwaitedEventEmitter,
  type ConsultDispatcherFactory,
} from './consult-expiry-adapters';
import { requesterAlertForRow, reviewConsultKind, type DueConsultRow } from './consult-expiry-core';
import { currentRequestWorkspaceId, runWithWorkspace } from '../workspace-als';
import type { TaskRow } from '../task-manager/types';

/** A row workspace that could not be mistaken for an ambient/default one. */
const ROW_WS = 'ws-row-7f3a';

const alertRow: DueConsultRow = {
  workspace_id: ROW_WS, conversation_id: 'conv-alert', requester_id: 'su-requester',
  responder_id: 'su-reviewer', state: 'awaiting_responder', is_due: true,
  expires_at: '2026-09-19T23:59:00Z',
  updated_at: '2026-09-20T00:00:00Z', snapshot_updated_at: '2026-09-20T00:00:00.000000Z',
  latency_contract: 'hard-blocked',
  question: 'review this', routing: {}, cascade_cursor: 0, cascade_digest: [],
};

describe('P-005 durable requester alert', () => {
  it('uses a stable lifecycle key across clocks/reasons and distinct keys across consults, workspaces, and positions', () => {
    const make = (row: DueConsultRow, kind: 'expired' | 'pickup_failed' = 'expired', nowIso = '2026-09-20T01:00:00Z') =>
      requesterAlertForRow({ row, kind, nowIso });
    const first = make(alertRow);
    expect(make(alertRow, 'pickup_failed', '2026-09-20T02:00:00Z').msgId).toBe(first.msgId);
    expect(new Set([
      first.msgId,
      make({ ...alertRow, conversation_id: 'conv-other' }).msgId,
      make({ ...alertRow, workspace_id: 'ws-other' }).msgId,
      make({ ...alertRow, cascade_cursor: 1 }).msgId,
      make({ ...alertRow, workspace_id: 'ws:conv', conversation_id: 'alert' }).msgId,
      make({ ...alertRow, workspace_id: 'ws', conversation_id: 'conv:alert' }).msgId,
    ]).size).toBe(6);
  });

  it.each(['hard-blocked', 'proceed'])('names the exact consult and honest pending recovery for %s', (latency_contract) => {
    const alert = requesterAlertForRow({
      row: { ...alertRow, latency_contract }, kind: 'expired', nowIso: '2026-09-20T01:00:00Z',
    });
    expect(alert.summary).toContain(alertRow.conversation_id);
    expect(alert.body).toContain(`conversation_id: "${alertRow.conversation_id}"`);
    expect(alert.body).toContain('Recovery disposition: pending');
    expect(alert.body).toContain('never approval');
    expect(alert.body).toContain(latency_contract === 'hard-blocked'
      ? `await consult:reply:${alertRow.conversation_id}` : 'Continue independent work');
    // A due row may still ADVANCE; expiry of one wait is not cascade exhaustion.
    expect(alert.body).toContain('if the cascade is exhausted');
  });

  it('threads replay key, recipient, content and ROW workspace through the real ALS scope, then restores ambient scope', async () => {
    const alert = requesterAlertForRow({ row: alertRow, kind: 'pickup_failed', nowIso: '2026-09-20T01:00:00Z' });
    const send = vi.fn(async (identity, opts) => {
      await Promise.resolve();
      expect(currentRequestWorkspaceId()).toBe(ROW_WS);
      expect(identity).toMatchObject({ workspaceId: ROW_WS, ownerId: CONSULT_EXPIRY_SWEEP_OWNER_ID });
      expect(opts).toEqual({
        msgId: alert.msgId, to: ['su-requester'], summary: alert.summary, body: alert.body, harnessSlug: null,
        extra: { conversation_id: alert.conversationId, recovery: 'pending' },
      });
    });
    await runWithWorkspace('ambient-other', async () => {
      await consultExpiryNotifyRequester(send)(alert);
      expect(currentRequestWorkspaceId()).toBe('ambient-other');
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('propagates durable-write failures so the sweep can retry instead of silently consuming the lifecycle row', async () => {
    const send = vi.fn(async () => { throw new Error('coord write failed'); });
    const alert = requesterAlertForRow({ row: alertRow, kind: 'expired', nowIso: '2026-09-20T01:00:00Z' });
    await expect(consultExpiryNotifyRequester(send)(alert)).rejects.toThrow('coord write failed');
  });
});

describe('sweepIdentity', () => {
  it('takes the workspace from its argument and uses the real sweep ownerId', () => {
    const id = sweepIdentity(ROW_WS);

    expect(id.workspaceId).toBe(ROW_WS);
    expect(id.ownerId).toBe(CONSULT_EXPIRY_SWEEP_OWNER_ID);
    expect(id.ownerId).toBe('system:consult-expiry-sweep');
  });
});

describe('consultExpiryEmitReplyEvent', () => {
  it("emits into the ROW's workspace and stamps the sweep as the source", async () => {
    const seen: Record<string, unknown>[] = [];
    const emit = (async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return {} as never;
    }) as AwaitedEventEmitter;

    await consultExpiryEmitReplyEvent(emit)({
      key: 'consult:reply:conv-1',
      summary: 'window elapsed',
      payload: { reason: 'expired' },
      to: ['su-requester'],
      workspaceId: ROW_WS,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      key: 'consult:reply:conv-1',
      summary: 'window elapsed',
      payload: { reason: 'expired' },
      to: ['su-requester'],
      workspaceId: ROW_WS,
      source: 'consult-expiry-sweep',
    });
  });
});

describe('consultExpiryDispatch', () => {
  it('builds the dispatcher from the ROW workspace, not an ambient one', async () => {
    let ctxArg: Record<string, unknown> = {};
    const makeDispatcher = ((ctx: Record<string, unknown>) => {
      ctxArg = ctx;
      return async () => {
        expect(currentRequestWorkspaceId()).toBe(ROW_WS);
        return { woke: 1, answeringOwnerId: 'su-next-fork' };
      };
    }) as ConsultDispatcherFactory;

    await runWithWorkspace('ambient-other', async () => {
      await consultExpiryDispatch(makeDispatcher)({
        responder: 'su-next',
        conversationId: 'conv-1',
        summary: 's',
        body: 'b',
        workspaceId: ROW_WS,
      });
      expect(currentRequestWorkspaceId()).toBe('ambient-other');
    });

    expect(ctxArg.workspaceId).toBe(ROW_WS);
    expect(ctxArg.launchedBy).toBe(CONSULT_EXPIRY_SWEEP_OWNER_ID);
    expect(ctxArg.harnessSlug).toBeNull();
  });

  it('builds the dispatcher PER ROW — a hoisted factory call would bind every launch to the first tenant', async () => {
    const seen: string[] = [];
    const makeDispatcher = ((ctx: { workspaceId: string }) => {
      seen.push(ctx.workspaceId);
      return async () => ({ woke: 1, answeringOwnerId: null });
    }) as ConsultDispatcherFactory;
    const dispatch = consultExpiryDispatch(makeDispatcher);

    await dispatch({ responder: 'a', conversationId: 'c1', summary: 's', body: 'b', workspaceId: ROW_WS });
    await dispatch({ responder: 'b', conversationId: 'c2', summary: 's', body: 'b', workspaceId: 'ws-second' });

    expect(seen).toEqual([ROW_WS, 'ws-second']);
  });

  it('passes the expert as the dispatch SOURCE and narrows the result to { woke, answeringOwnerId }', async () => {
    let opts: { responder?: string; conversationId?: string } = {};
    const makeDispatcher = (() => async (o: { responder: string; conversationId: string }) => {
      opts = o;
      return { queued: 1, woke: 1, pickupConfirmed: true, answeringOwnerId: 'su-next-fork', extra: 'ignored' };
    }) as ConsultDispatcherFactory;

    const out = await consultExpiryDispatch(makeDispatcher)({
      responder: 'su-next',
      conversationId: 'conv-42',
      summary: 's',
      body: 'b',
      workspaceId: ROW_WS,
    });

    expect(opts.responder).toBe('su-next');
    expect(opts.conversationId).toBe('conv-42');
    expect(out).toEqual({ woke: 1, answeringOwnerId: 'su-next-fork' });
  });

  it('preserves cited turns and the pre-launch answering-owner reservation on an expiry cascade', async () => {
    const evidence = [{ session_id: 'exact-source-session', turn_idx: 8, sim: 0.87 }];
    const onAnsweringOwner = vi.fn(async (_owner: string) => {});
    const launch = vi.fn(async (opts) => {
      // A cross-backend brief needs the exact cited turn before it can launch.
      if (!opts.evidence?.length) return { woke: 0, answeringOwnerId: null };
      await opts.onAnsweringOwner('su-expiry-answerer');
      return { woke: 1, answeringOwnerId: 'su-expiry-answerer' };
    });
    const dispatch = consultExpiryDispatch(() => launch);
    const result = await dispatch({
      workspaceId: ROW_WS, responder: 'su-source', conversationId: 'conv-expiry-evidence',
      summary: 'current rubric review', body: 'Read the cited current-subject evidence.',
      evidence, onAnsweringOwner,
    });

    expect(result).toEqual({ woke: 1, answeringOwnerId: 'su-expiry-answerer' });
    expect(launch.mock.calls[0]![0].evidence).toBe(evidence);
    expect(launch.mock.calls[0]![0].onAnsweringOwner).toBe(onAnsweringOwner);
    expect(onAnsweringOwner).toHaveBeenCalledExactlyOnceWith('su-expiry-answerer');
  });
});

describe('consultExpiryFindSilentResponders', () => {
  it('recovers a missing reserved answerer only from exact terminal consult-task evidence, retaining live-task and post guards', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const task = (conversationId: string, overrides: Partial<TaskRow> = {}) => ({
      workspaceId: ROW_WS, class: 'agent-session', state: 'ended_unobserved',
      // A requester follow-up refreshed routedAt AFTER the failed launch ended.
      endedAt: '2026-08-27T05:50:00.000Z',
      detail: { consultAnswer: { conversationId, sourceOwnerId: 'su-source', answeringOwnerId: 'su-reserved' } },
      ...overrides,
    });
    const cases = {
      exact: [task('exact')],
      exited: [task('exited', { state: 'exited' })],
      killed: [task('killed', { state: 'killed' })],
      absent: [],
      conversation: [task('other-conversation')],
      workspace: [task('workspace', { workspaceId: 'another-workspace' })],
      source: [task('source', { detail: { consultAnswer: { conversationId: 'source', sourceOwnerId: 'other-source', answeringOwnerId: 'su-reserved' } } })],
      answerer: [task('answerer', { detail: { consultAnswer: { conversationId: 'answerer', sourceOwnerId: 'su-source', answeringOwnerId: 'other-answerer' } } })],
      untagged: [task('untagged', { detail: { coordOwnerId: 'su-reserved' } })],
      taskClass: [task('taskClass', { class: 'bash-job' })],
      running: [task('running', { state: 'running' })],
      noEnd: [task('noEnd', { endedAt: null })],
      futureEnd: [task('futureEnd', { endedAt: '2026-08-27T06:01:00.000Z' })],
      liveSibling: [task('liveSibling'), task('liveSibling', { state: 'running', endedAt: null })],
      posted: [task('posted')],
      unknownAuthor: [task('unknownAuthor')],
      liveOracle: [task('liveOracle')],
      noSource: [task('noSource')],
    };
    const lookup = vi.fn(async (workspaceId: string, answeringOwnerId: string) => {
      expect(workspaceId).toBe(ROW_WS);
      expect(answeringOwnerId).toBe('su-reserved');
      return Object.values(cases).flat() as TaskRow[];
    });
    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => null,
      resolveSessionStates: async () => new Map(),
      listAnsweringTasks: lookup,
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: parent.ref }) as never,
        listRecentPosts: async (id) => ({ total: 1, posts: [{ author_id: id === 'posted' ? 'su-reserved' : id === 'unknownAuthor' ? 'unknown' : 'su-requester' }] }),
      }),
      now: () => now,
    })(Object.keys(cases).filter((id) => id !== 'liveOracle').map((conversationId) => ({
      workspaceId: ROW_WS, conversationId, answeringOwnerId: 'su-reserved',
      ...(conversationId === 'noSource' ? {} : { sourceOwnerId: 'su-source' }),
      requesterId: 'su-requester', routedAt: '2026-08-27T05:59:00.000Z',
    })));
    expect(found).toEqual(new Set(['exact', 'exited', 'killed']));
    expect(lookup).toHaveBeenCalledTimes(1);

    const liveLookup = vi.fn(async () => cases.liveOracle as TaskRow[]);
    const live = await consultExpiryFindSilentResponders({
      getPresence: async () => null,
      resolveSessionStates: async () => new Map([['su-reserved', { sessionState: 'live' }]]),
      listAnsweringTasks: liveLookup,
      getThreadStore: () => { throw new Error('live answerer within pickup grace must be retained'); },
      now: () => now,
    })([{ workspaceId: ROW_WS, conversationId: 'liveOracle', sourceOwnerId: 'su-source', answeringOwnerId: 'su-reserved', routedAt: '2026-08-27T05:59:00.000Z' }]);
    expect(live.size).toBe(0);
    expect(liveLookup).not.toHaveBeenCalled();
  });

  it('uses an empty thread and pickup grace for an unstamped dispatch without reading source liveness', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const staleRoute = new Date(now.getTime() - 30 * 60_000).toISOString();
    const freshRoute = new Date(now.getTime() - 30 * 60_000 + 1).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-unstamped', answeringOwnerId: null, routedAt: staleRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-recent', answeringOwnerId: null, routedAt: freshRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-posted', answeringOwnerId: null, routedAt: staleRoute },
    ];
    const threadReads: string[] = [];
    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => { throw new Error('source presence must not be read'); },
      resolveSessionStates: async () => { throw new Error('source liveness must not be read'); },
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async (threadId) => {
          threadReads.push(threadId);
          return { total: threadId === 'thread-conv-posted' ? 1 : 0 };
        },
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-unstamped']));
    expect(threadReads).toEqual(['thread-conv-unstamped', 'thread-conv-posted']);
  });

  it('ignores a prior reviewer decline but fails closed on a current or unknown post', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const routedAt = new Date(now.getTime() - 31 * 60_000).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-prior', answeringOwnerId: null, routedAt, priorResponderIds: ['su-prior'] },
      { workspaceId: ROW_WS, conversationId: 'conv-current', answeringOwnerId: null, routedAt, priorResponderIds: ['su-prior'] },
      { workspaceId: ROW_WS, conversationId: 'conv-unbounded', answeringOwnerId: null, routedAt, priorResponderIds: ['su-prior'] },
    ];
    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => { throw new Error('unstamped branch must not read presence'); },
      resolveSessionStates: async () => { throw new Error('unstamped branch must not read liveness'); },
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async (threadId) => threadId === 'thread-conv-unbounded'
          ? { total: 21, posts: [{ author_id: 'su-prior' }] }
          : { total: 1, posts: [{ author_id: threadId === 'thread-conv-prior' ? 'su-prior' : 'su-current' }] },
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-prior']));
  });

  it.each(['ended', 'parked', 'live'])('recovers a reserved %s answerer with only requester or prior replies while retaining history controls', async (sessionState) => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const routedAt = new Date(now.getTime() - 31 * 60_000).toISOString();
    const histories = {
      prior: { total: 2, posts: [{ author_id: 'su-prior-source' }, { author_id: 'su-prior-fork' }] },
      requester: { total: 2, posts: [{ author_id: 'su-requester' }, { author_id: 'su-requester' }] },
      mixed: { total: 2, posts: [{ author_id: 'su-prior-fork' }, { author_id: 'su-requester' }] },
      current: { total: 1, posts: [{ author_id: 'su-reserved' }] },
      unknown: { total: 1, posts: [{ author_id: 'su-unknown' }] },
      anonymous: { total: 1, posts: [{ author_id: null }] },
      partial: { total: 2, posts: [{ author_id: 'su-prior-fork' }] },
      unbounded: { total: 21, posts: [{ author_id: 'su-prior-fork' }] },
      overlap: { total: 1, posts: [{ author_id: 'su-reserved' }] },
      requesterOverlap: { total: 1, posts: [{ author_id: 'su-reserved' }] },
    };
    const rows = Object.keys(histories).map((conversationId) => ({
      workspaceId: ROW_WS, conversationId, sourceOwnerId: 'su-source', answeringOwnerId: 'su-reserved', routedAt,
      requesterId: conversationId === 'requesterOverlap' ? 'su-reserved' : 'su-requester',
      priorResponderIds: ['su-prior-source', 'su-prior-fork', ...(conversationId === 'overlap' ? ['su-reserved'] : [])],
    }));
    const taskRows = rows.map((row) => ({
      taskId: 'task-' + row.conversationId,
      workspaceId: ROW_WS,
      class: 'agent-session',
      state: 'running',
      startedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      endedAt: null,
      logPath: '/logs/' + row.conversationId,
      detail: {
        consultAnswer: {
          conversationId: row.conversationId,
          sourceOwnerId: row.sourceOwnerId,
          answeringOwnerId: row.answeringOwnerId,
        },
      },
    } as unknown as TaskRow));
    const mtimes = new Map<string, number>();
    for (const row of rows) mtimes.set('/logs/' + row.conversationId, now.getTime() - 32 * 60_000);

    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: new Date(now.getTime() - 60_000).toISOString() }),
      resolveSessionStates: async () => new Map([['su-reserved', { sessionState }]]),
      listAnsweringTasks: async () => taskRows,
      statMtimeMs: (path) => mtimes.get(path) ?? null,
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: parent.ref }) as never,
        listRecentPosts: async (threadId) => histories[threadId as keyof typeof histories],
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['prior', 'requester', 'mixed']));
  });

  it.each(['unknown', 'live', 'parked'])('keeps requester replies from bypassing %s answerer liveness and pickup grace', async (sessionState) => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const getThreadStore = vi.fn(() => ({
      getThreadByParent: async () => ({ thread_id: 'thread' }) as never,
      listRecentPosts: async () => ({ total: 1, posts: [{ author_id: 'su-requester' }] }),
    }));
    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () => new Map([['su-reserved', { sessionState }]]),
      getThreadStore,
      now: () => now,
    })([{
      workspaceId: ROW_WS, conversationId: 'conv-fresh', answeringOwnerId: 'su-reserved',
      requesterId: 'su-requester',
      routedAt: new Date(now.getTime() - 60_000).toISOString(), priorResponderIds: ['su-prior-fork'],
    }]);

    expect(found.size).toBe(0);
    expect(getThreadStore).not.toHaveBeenCalled();
  });

  it('requires active-after-route + parked + zero posts, and reads each thread in its row workspace', async () => {
    const routedAt = '2026-08-27T05:00:00.000Z';
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-positive', answeringOwnerId: 'su-parked', routedAt },
      { workspaceId: 'ws-live', conversationId: 'conv-live', answeringOwnerId: 'su-live', routedAt },
      { workspaceId: 'ws-before', conversationId: 'conv-before', answeringOwnerId: 'su-before', routedAt },
      { workspaceId: 'ws-posted', conversationId: 'conv-posted', answeringOwnerId: 'su-posted', routedAt },
    ];
    const presence = new Map([
      ['su-parked', { lastActiveAt: '2026-08-27T05:01:00.000Z' }],
      ['su-live', { lastActiveAt: '2026-08-27T05:01:00.000Z' }],
      ['su-before', { lastActiveAt: '2026-08-27T04:59:00.000Z' }],
      ['su-posted', { lastActiveAt: '2026-08-27T05:01:00.000Z' }],
    ]);
    const verdicts = new Map([
      ['su-parked', { sessionState: 'parked' }],
      ['su-live', { sessionState: 'live' }],
      ['su-before', { sessionState: 'parked' }],
      ['su-posted', { sessionState: 'parked' }],
    ]);
    const resolveSessionStates = vi.fn(
      async (subjects: readonly { ownerId: string }[], opts: { hydratePerId: true }) => {
        expect(subjects.map((subject) => subject.ownerId)).toEqual([
          'su-parked',
          'su-live',
          'su-before',
          'su-posted',
        ]);
        expect(opts).toEqual({ hydratePerId: true });
        return verdicts;
      },
    );
    const threadStoreCalls: string[] = [];
    const parentCalls: Array<{ workspaceId: string; ref: string }> = [];
    const getThreadStore = vi.fn((workspaceId: string) => {
      threadStoreCalls.push(workspaceId);
      return {
        getThreadByParent: async (parent: { kind: string; ref: string }) => {
          parentCalls.push({ workspaceId, ref: parent.ref });
          return { thread_id: `thread-${parent.ref}` } as never;
        },
        listRecentPosts: async (threadId: string) => ({
          posts: [],
          total: threadId === 'thread-conv-posted' ? 1 : 0,
        }),
      };
    });

    const found = await consultExpiryFindSilentResponders({
      getPresence: async (ownerId) => presence.get(ownerId) ?? null,
      resolveSessionStates,
      getThreadStore,
      now: () => new Date('2026-08-27T05:02:00.000Z'),
    })(rows);

    expect(found).toEqual(new Set(['conv-positive']));
    expect(threadStoreCalls).toEqual(expect.arrayContaining([ROW_WS, 'ws-posted']));
    expect(parentCalls).toEqual(
      expect.arrayContaining([
        { workspaceId: ROW_WS, ref: 'conv-positive' },
        { workspaceId: 'ws-posted', ref: 'conv-posted' },
      ]),
    );
    expect(parentCalls).not.toEqual(expect.arrayContaining([{ workspaceId: 'ws-live', ref: 'conv-live' }]));
    expect(parentCalls).not.toEqual(expect.arrayContaining([{ workspaceId: 'ws-before', ref: 'conv-before' }]));
  });

  it('bounds a continuously-live no-pickup responder at the hard-blocked window, but not before it', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const staleRoute = new Date(now.getTime() - 30 * 60_000).toISOString();
    const freshRoute = new Date(now.getTime() - 30 * 60_000 + 1).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-live-stale', sourceOwnerId: 'su-source', answeringOwnerId: 'su-live-stale', routedAt: staleRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-live-fresh', sourceOwnerId: 'su-source', answeringOwnerId: 'su-live-fresh', routedAt: freshRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-live-posted', sourceOwnerId: 'su-source', answeringOwnerId: 'su-live-posted', routedAt: staleRoute },
    ];
    const verdicts = new Map(rows.map((row) => [row.answeringOwnerId, { sessionState: 'live' }]));
    const threadReads: string[] = [];
    const taskRows = new Map<string, TaskRow>();
    const mtimes = new Map<string, number>();
    for (const row of rows) {
      const logPath = '/logs/' + row.conversationId;
      taskRows.set(row.answeringOwnerId, {
        taskId: 'task-' + row.conversationId,
        workspaceId: ROW_WS,
        class: 'agent-session',
        state: 'running',
        startedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
        endedAt: null,
        logPath,
        detail: {
          consultAnswer: {
            conversationId: row.conversationId,
            sourceOwnerId: 'su-source',
            answeringOwnerId: row.answeringOwnerId,
          },
        },
      } as unknown as TaskRow);
      mtimes.set(logPath, now.getTime() - 31 * 60_000);
    }

    const found = await consultExpiryFindSilentResponders({
      // No exact-task log write after routing through the pickup window is the
      // no-pickup signal; an empty thread alone is not sufficient.
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () => verdicts,
      listAnsweringTasks: async (_workspaceId, answeringOwnerId) => {
        const task = taskRows.get(answeringOwnerId);
        return task ? [task] : [];
      },
      statMtimeMs: (path) => mtimes.get(path) ?? null,
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async (threadId) => {
          threadReads.push(threadId);
          return { total: threadId === 'thread-conv-live-posted' ? 1 : 0 };
        },
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-live-stale']));
    expect(threadReads).toEqual(
      expect.arrayContaining(['thread-conv-live-stale', 'thread-conv-live-posted']),
    );
    expect(threadReads).not.toContain('thread-conv-live-fresh');
  });

  it('uses exact answering task log progress to distinguish busy and stalled responders', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const routedAt = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-active', sourceOwnerId: 'su-source', answeringOwnerId: 'su-active', routedAt },
      { workspaceId: ROW_WS, conversationId: 'conv-stalled', sourceOwnerId: 'su-source', answeringOwnerId: 'su-stalled', routedAt },
      { workspaceId: ROW_WS, conversationId: 'conv-missing-log', sourceOwnerId: 'su-source', answeringOwnerId: 'su-missing-log', routedAt },
      { workspaceId: ROW_WS, conversationId: 'conv-unreadable-log', sourceOwnerId: 'su-source', answeringOwnerId: 'su-unreadable-log', routedAt },
    ];
    const mtimes = new Map<string, number | null>([
      ['/logs/conv-active', now.getTime() - 15 * 60_000],
      ['/logs/conv-stalled', now.getTime() - 91 * 60_000],
      ['/logs/conv-unreadable-log', null],
    ]);
    const taskRows = new Map<string, TaskRow>();
    for (const row of rows) {
      const logPath = row.conversationId === 'conv-missing-log'
        ? null
        : '/logs/' + row.conversationId;
      taskRows.set(row.answeringOwnerId, {
        taskId: 'task-' + row.conversationId,
        workspaceId: ROW_WS,
        class: 'agent-session',
        state: 'running',
        startedAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
        endedAt: null,
        logPath,
        detail: {
          consultAnswer: {
            conversationId: row.conversationId,
            sourceOwnerId: 'su-source',
            answeringOwnerId: row.answeringOwnerId,
          },
        },
      } as unknown as TaskRow);
    }
    const threadReads: string[] = [];
    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () =>
        new Map(rows.map((row) => [row.answeringOwnerId, { sessionState: 'live' }])),
      listAnsweringTasks: async (_workspaceId, answeringOwnerId) => {
        const task = taskRows.get(answeringOwnerId);
        return task ? [task] : [];
      },
      statMtimeMs: (path) => mtimes.get(path) ?? null,
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: 'thread-' + parent.ref }) as never,
        listRecentPosts: async (threadId) => {
          threadReads.push(threadId);
          return { total: 0 };
        },
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-stalled']));
    expect(threadReads).toEqual(['thread-conv-stalled']);
  });

  it.each(['ended', 'recorded'] as const)(
    'advances a terminal no-pickup responder without waiting for the expiry window (%s)',
    async (sessionState) => {
      const routedAt = '2026-08-27T05:59:59.000Z';
      const rows = [
        { workspaceId: ROW_WS, conversationId: `conv-${sessionState}`, answeringOwnerId: `su-${sessionState}`, routedAt },
        { workspaceId: ROW_WS, conversationId: `conv-posted-${sessionState}`, answeringOwnerId: `su-posted-${sessionState}`, routedAt },
      ];
      const verdicts = new Map([
        [rows[0]!.answeringOwnerId, { sessionState }],
        [rows[1]!.answeringOwnerId, { sessionState }],
      ]);
      const resolveSessionStates = vi.fn(async () => verdicts);
      const threadReads: string[] = [];

      const found = await consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates,
        getThreadStore: () => ({
          getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
          listRecentPosts: async (threadId) => {
            threadReads.push(threadId);
            return { total: threadId === `thread-conv-posted-${sessionState}` ? 1 : 0 };
          },
        }),
        now: () => new Date('2026-08-27T06:00:00.000Z'),
      })(rows);

      expect(found).toEqual(new Set([`conv-${sessionState}`]));
      expect(threadReads).toEqual(
        expect.arrayContaining([`thread-conv-${sessionState}`, `thread-conv-posted-${sessionState}`]),
      );
    },
  );

  it.each(['pending', 'delivered'] as const)(
    'preserves an ended responder while a recent %s carry-respawn can restore it',
    async (outcome) => {
      const now = new Date('2026-08-27T06:00:00.000Z');
      const routedAt = new Date(now.getTime() - 60_000).toISOString();
      const getCarryRespawnOutcome = vi.fn(async () => ({
        outcome,
        ts: new Date(now.getTime() - 30_000).toISOString(),
      }));
      const getThreadStore = vi.fn(() => {
        throw new Error('a recent carry means the predecessor death is not terminal');
      });

      const found = await consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates: async () => new Map([['su-ended-carry', { sessionState: 'ended' }]]),
        getCarryRespawnOutcome,
        getThreadStore,
        now: () => now,
      })([{
        workspaceId: ROW_WS,
        conversationId: 'conv-ended-carry',
        answeringOwnerId: 'su-ended-carry',
        routedAt,
      }]);

      expect(found).toEqual(new Set());
      expect(getCarryRespawnOutcome).toHaveBeenCalledExactlyOnceWith('su-ended-carry');
      expect(getThreadStore).not.toHaveBeenCalled();
    },
  );

  it.each(['outside-grace', 'before-route'] as const)(
    'advances a terminal responder when the carry is %s',
    async (age) => {
      const now = new Date('2026-08-27T06:00:00.000Z');
      const routedAtMs = now.getTime() - 60_000;
      const carryAtMs = age === 'outside-grace'
        ? now.getTime() - CONSULT_CARRY_RESPAWN_GRACE_MS - 1
        : routedAtMs - 1;
      const getCarryRespawnOutcome = vi.fn(async () => ({
        outcome: 'pending' as const,
        ts: new Date(carryAtMs).toISOString(),
      }));

      const found = await consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates: async () => new Map([['su-old-carry', { sessionState: 'ended' }]]),
        getCarryRespawnOutcome,
        getThreadStore: () => ({
          getThreadByParent: async (parent) => ({ thread_id: parent.ref }) as never,
          listRecentPosts: async () => ({ total: 0 }),
        }),
        now: () => now,
      })([{
        workspaceId: ROW_WS,
        conversationId: 'conv-old-carry',
        answeringOwnerId: 'su-old-carry',
        routedAt: new Date(routedAtMs).toISOString(),
      }]);

      expect(found).toEqual(new Set(['conv-old-carry']));
    },
  );

  it('bounds a parked responder that never became active after the pickup window', async () => {
    const now = new Date('2026-08-27T06:00:00.000Z');
    const staleRoute = new Date(now.getTime() - 30 * 60_000).toISOString();
    const rows = [
      { workspaceId: ROW_WS, conversationId: 'conv-parked-stale', sourceOwnerId: 'su-source', answeringOwnerId: 'su-parked-stale', routedAt: staleRoute },
      { workspaceId: ROW_WS, conversationId: 'conv-parked-fresh', sourceOwnerId: 'su-source', answeringOwnerId: 'su-parked-fresh', routedAt: now.toISOString() },
    ];
    const taskRows = new Map<string, TaskRow>();
    const mtimes = new Map<string, number>();
    for (const row of rows) {
      const logPath = '/logs/' + row.conversationId;
      taskRows.set(row.answeringOwnerId, {
        taskId: 'task-' + row.conversationId,
        workspaceId: ROW_WS,
        class: 'agent-session',
        state: 'running',
        startedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
        endedAt: null,
        logPath,
        detail: {
          consultAnswer: {
            conversationId: row.conversationId,
            sourceOwnerId: 'su-source',
            answeringOwnerId: row.answeringOwnerId,
          },
        },
      } as unknown as TaskRow);
      mtimes.set(logPath, now.getTime() - 31 * 60_000);
    }

    const found = await consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () =>
        new Map(rows.map((row) => [row.answeringOwnerId, { sessionState: 'parked' }])),
      listAnsweringTasks: async (_workspaceId, answeringOwnerId) => {
        const task = taskRows.get(answeringOwnerId);
        return task ? [task] : [];
      },
      statMtimeMs: (path) => mtimes.get(path) ?? null,
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async () => ({ total: 0 }),
      }),
      now: () => now,
    })(rows);

    expect(found).toEqual(new Set(['conv-parked-stale']));
  });

  it.each(['unknown', 'draining', 'suspect'] as const)(
    'does not recover a %s responder without terminal or empty-pickup evidence',
    async (sessionState) => {
      const now = new Date('2026-08-27T06:00:00.000Z');
      const staleRoute = new Date(now.getTime() - 60 * 60_000).toISOString();
      const getThreadStore = vi.fn(() => {
        throw new Error('thread store must not be read for an unresolved responder');
      });

      const found = await consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates: async () =>
          new Map([['su-unresolved', { sessionState }]]),
        getThreadStore,
        now: () => now,
      })([
        {
          workspaceId: ROW_WS,
          conversationId: `conv-${sessionState}`,
          answeringOwnerId: 'su-unresolved',
          routedAt: staleRoute,
        },
      ]);

      expect(found).toEqual(new Set());
      expect(getThreadStore).not.toHaveBeenCalled();
    },
  );
});

// review-system-rework-reduction-2026-09-23 P-014 (spec RSR-P-014-A).
describe('review consult classification', () => {
  it('recognizes the three review families and nothing else', () => {
    expect(reviewConsultKind({ policy: 'rubric-vetting' })).toBe('rubric-vetting');
    expect(reviewConsultKind({ cascade: { flavor: 'acceptance-grading' } })).toBe('acceptance-grading');
    expect(reviewConsultKind(JSON.stringify({ cascade: { flavor: 'grading-integrity' } }))).toBe('grading-integrity');
    expect(reviewConsultKind({ policy: 'consult-default' })).toBeNull();
    expect(reviewConsultKind({ selection: { selected: [] } })).toBeNull();
    expect(reviewConsultKind(null)).toBeNull();
    expect(reviewConsultKind('{not json')).toBeNull();
  });
});

describe('consultExpiryFileReviewWorkItem', () => {
  const base = {
    workspaceId: ROW_WS,
    conversationId: 'conv-silent',
    question: 'Vet acceptance rubric acceptance-foo revision 3 against meta-acceptance-rubric\nmore detail',
    requesterId: 'rubric-author',
    silentResponderId: 'resp-silent',
  };

  it('files a vetting review as an unassigned open task keyed per conversation, in the resolved harness', async () => {
    const upsert = vi.fn(async () => ({ id: 'EI-review-1' }));
    const resolveHarness = vi.fn(async () => 'papercusp');
    const file = consultExpiryFileReviewWorkItem({ upsert, resolveHarness });
    await expect(file({ ...base, kind: 'rubric-vetting', routing: { policy: 'rubric-vetting' } }))
      .resolves.toEqual({ id: 'EI-review-1' });

    expect(resolveHarness).toHaveBeenCalledWith(ROW_WS, 'conv-silent');
    expect(upsert).toHaveBeenCalledTimes(1);
    const [key, input] = upsert.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(key).toBe(`${REVIEW_CONSULT_CONDITION_NAMESPACE}:conv-silent`);
    expect(input).toMatchObject({
      kind: 'task', harness: 'papercusp', workspaceId: ROW_WS, createdBy: CONSULT_EXPIRY_SWEEP_OWNER_ID,
      payload: { reviewConsult: { conversationId: 'conv-silent', kind: 'rubric-vetting', requesterId: 'rubric-author' } },
    });
    // Claimable shape: no assignee is stamped at creation.
    expect(input).not.toHaveProperty('assignee');
    expect(input.title).toBe('Review needed (rubric-vetting) — Vet acceptance rubric acceptance-foo revision 3 against meta-acceptance-rubric');
    expect(input.summary).toContain("scorecards:emit { vettingWorkItem: '<this id>' }");
    expect(input.summary).toContain('more detail');
  });

  it('adopts the acceptance review-target reservation instead of minting a sibling', async () => {
    const upsert = vi.fn(async () => ({ id: 'WI-reservation' }));
    const resolveHarness = vi.fn(async () => 'should-not-be-used');
    const file = consultExpiryFileReviewWorkItem({ upsert, resolveHarness });
    const routing = {
      cascade: {
        flavor: 'acceptance-grading', planSlug: 'plan-x', rubricId: 'rubric-x', harnessSlug: 'hx',
        reservation: { conditionKey: 'acceptance-review-target:v1:abc', id: 'WI-reservation' },
      },
    };
    await expect(file({ ...base, kind: 'acceptance-grading', routing })).resolves.toEqual({ id: 'WI-reservation' });
    const [key, input] = upsert.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(key).toBe('acceptance-review-target:v1:abc');
    expect(input).toMatchObject({ harness: 'hx', title: 'Acceptance review-target reservation — plan-x (rubric-x)' });
    expect(resolveHarness).not.toHaveBeenCalled();
  });

  it('refuses to report success when the upsert yields no row', async () => {
    const file = consultExpiryFileReviewWorkItem({
      upsert: async () => ({ id: null }),
      resolveHarness: async () => null,
    });
    await expect(file({ ...base, kind: 'grading-integrity', routing: {} })).rejects.toThrow(/no id/);
  });
});

describe('consultExpiryStopAnsweringSession (WI-10003199, P-003)', () => {
  type Row = Awaited<ReturnType<AnsweringSessionTaskSeams['listLiveTasks']>>[number];
  const tagged = (taskId: string, consultAnswer: Record<string, unknown>, cls = 'agent-session'): Row =>
    ({ taskId, class: cls, detail: { consultAnswer } }) as unknown as Row;
  const target = { workspaceId: 'ws', conversationId: 'conv-1', answeringOwnerId: 'fork-1', sourceOwnerId: 'src-1' };

  function seams(rows: Row[], kill: AnsweringSessionTaskSeams['killTask'] = async () => ({ ok: true })) {
    const killed: string[] = [];
    const listCalls: string[] = [];
    return {
      killed,
      listCalls,
      seams: {
        listLiveTasks: async (ws: string) => { listCalls.push(ws); return rows; },
        killTask: async (id: string) => { killed.push(id); return kill(id); },
      } satisfies AnsweringSessionTaskSeams,
    };
  }

  it("kills only this slot's tagged session — never another consult's, another slot's, or the expert's own session", async () => {
    const s = seams([
      tagged('t-slot', { conversationId: 'conv-1', operation: 'fork', answeringOwnerId: 'fork-1', sourceOwnerId: 'src-1' }),
      tagged('t-next-slot', { conversationId: 'conv-1', operation: 'fork', answeringOwnerId: 'fork-2', sourceOwnerId: 'src-2' }),
      tagged('t-other-consult', { conversationId: 'conv-2', operation: 'fork', answeringOwnerId: 'fork-1', sourceOwnerId: 'src-1' }),
      tagged('t-not-agent', { conversationId: 'conv-1', sourceOwnerId: 'src-1' }, 'command'),
      // The expert's own live session carries no consultAnswer tag at all.
      { taskId: 't-expert', class: 'agent-session', detail: { label: 'su-src-1' } } as unknown as Row,
    ]);
    const out = await consultExpiryStopAnsweringSession(s.seams)(target);
    expect(s.listCalls).toEqual(['ws']);
    expect(s.killed).toEqual(['t-slot']);
    expect(out).toBe('stopped task t-slot');
  });

  it('matches a row tagged before sourceOwnerId was recorded by its answeringOwnerId stamp', async () => {
    const s = seams([tagged('t-old', { conversationId: 'conv-1', operation: 'fork', answeringOwnerId: 'fork-1' })]);
    expect(await consultExpiryStopAnsweringSession(s.seams)(target)).toBe('stopped task t-old');
    const unstamped = seams([tagged('t-old', { conversationId: 'conv-1', operation: 'fork', answeringOwnerId: 'fork-1' })]);
    await consultExpiryStopAnsweringSession(unstamped.seams)({ ...target, answeringOwnerId: null });
    expect(unstamped.killed).toEqual([]);
  });

  it('reports no session, an already-gone task, a refusal and a failed lookup without throwing', async () => {
    expect(await consultExpiryStopAnsweringSession(seams([]).seams)(target)).toBe('no live answering session found');
    const row = tagged('t-slot', { conversationId: 'conv-1', sourceOwnerId: 'src-1' });
    const gone = seams([row], async () => ({ ok: false, error: 'already_gone' }));
    expect(await consultExpiryStopAnsweringSession(gone.seams)(target)).toBe('task t-slot already gone');
    const refused = seams([row], async () => ({ ok: false, error: 'identity_mismatch' }));
    expect(await consultExpiryStopAnsweringSession(refused.seams)(target)).toBe('stop of task t-slot refused: identity_mismatch');
    const broken = consultExpiryStopAnsweringSession({
      listLiveTasks: async () => { throw new Error('ledger down'); },
      killTask: async () => ({ ok: true }),
    });
    expect(await broken(target)).toBe('answering-session lookup failed: ledger down');
  });
});

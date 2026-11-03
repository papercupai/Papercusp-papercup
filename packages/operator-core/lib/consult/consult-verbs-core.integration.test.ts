/**
 * consult-verbs-core.integration.test.ts — the responder-side consult verbs
 * against a real Postgres, P-004 of get-feedback-relevance-consults-2026-08-16.
 *
 * Bootstrap mirrors get-feedback-core.integration.test.ts: the consult tables
 * are created by applying the REAL migration file (834-consult-threads.sql,
 * readFileSync) — never a hand-mirrored CREATE that silently falls behind the
 * schema. The conversation substrate is stubbed at the deps.post seam (the
 * conversations-core kind gate has its own unit pins).
 *
 * What only a real-PG test can prove here:
 *  - the consult_post_meta INSERT satisfies the migration's kind CHECK and the
 *    evidence jsonb round-trips;
 *  - the state transitions land under the consult_state state CHECK
 *    (awaiting_responder→active, →declined, →closed_answered/closed_cant_help)
 *    with outcome/closed_at written;
 *  - exchange-cap arithmetic against real column defaults (max_exchanges 4);
 *  - the D-005 follow-up wake-budget aggregation over origin_task_ref rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import {
  consultCloseCore,
  consultDeclineCore,
  consultReplyCore,
  consultResolveRequestedConsult,
  consultTransferRequesterFollowupCore,
  type ConsultVerbDeps,
} from './consult-verbs-core';
import { advanceCascade, continueCascadeDispatchCore, makeDigestEntry } from './cascade-core';
import { acquireConsultSpawnLease, makeDeferredConsultReachDispatcher } from './consult-dispatch';
import { readConsultReview } from './review-findings';

const WS = 'ws-consult-verbs';
const NOW = new Date('2026-08-16T00:00:00Z');
const REQUESTER = 'req-1';
const RESPONDER = 'resp-1';

describe('preserving review findings through consult settlement', () => {
  const review = { subjectRef: 'plan:recovery@source-hash', coverage: 'complete' as const,
    findings: [{ key: 'F1', severity: 'major' as const, text: 'Recovery drops pending work', evidenceRefs: ['source:queue.ts'] }] };
  it('persists original reviewer evidence and requester disposition together at close', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    const posted = await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: RESPONDER,
      kind: 'answer', body: 'Found a recovery gap', evidence: [{ session_id: 'review-session', turn_idx: 1 }], review }, deps);
    if ('error' in posted) throw new Error(posted.error);
    const findingId = `post:${posted.post_id}#F1`;
    expect(posted.review?.findings[0]).toMatchObject({ id: findingId, reviewerId: RESPONDER });
    const closed = await consultCloseCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      outcome: 'answered', answer: 'Carry the repair into implementation', reviewDispositions: [{ findingId,
        status: 'planned', reason: 'Binding repair obligation', reference: 'plan:recovery#D-001' }] }, deps);
    expect(closed).toMatchObject({ ok: true, state: 'closed_answered', review: { findings: [expect.objectContaining({
      text: review.findings[0].text, reviewerId: RESPONDER, postId: posted.post_id })],
      dispositions: [expect.objectContaining({ findingId, status: 'planned', authorId: REQUESTER })] } });
    if ('error' in closed) throw new Error(closed.error);
    expect((await stateRow(id)).outcome).toMatchObject({ review: closed.review });
  });
  it('preserves incomplete review evidence on a non-answer close', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: RESPONDER, kind: 'answer',
      body: 'Runtime unavailable', evidence: [{ session_id: 'review-session', turn_idx: 2 }],
      review: { ...review, coverage: 'incomplete', findings: [] } }, deps);
    const result = await consultCloseCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      outcome: 'cant_help', reason: 'Record the coverage limit' }, deps);
    expect(result).toMatchObject({ ok: true, review: { answers: [expect.objectContaining({ coverage: 'incomplete' })], findings: [] } });
  });
  it('refuses invented dispositions before posting or closing', async () => {
    const id = await seedConsult();
    const { deps, posts } = makeDeps();
    const result = await consultCloseCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      outcome: 'answered', answer: 'Dismissed', reviewDispositions: [{ findingId: 'post:999#F1',
        status: 'rejected', reason: 'Unsupported', reference: 'source:queue.ts' }] }, deps);
    expect(result).toMatchObject({ error: 'invalid_review' });
    expect(posts).toEqual([]);
    expect((await stateRow(id)).state).toBe('awaiting_responder');
  });

  async function reviewed() {
    const id = await seedConsult({ maxExchanges: 20 });
    const harness = makeDeps({ withDispatch: false });
    const answer = await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: RESPONDER,
      kind: 'answer', body: 'Review', evidence: [{ session_id: 'review-session', turn_idx: 1 }], review }, harness.deps);
    if ('error' in answer) throw new Error(answer.error);
    return { id, ...harness, findingId: `post:${answer.post_id}#F1` };
  }
  function disposition(findingId: string, status: 'planned' | 'fixed' = 'planned') {
    return { findingId, status, reason: 'Existing queue repair', reference: 'plan:recovery#P-001' };
  }
  async function snapshot(id: string, posts: unknown[]) {
    return { row: await stateRow(id), posts: structuredClone(posts),
      meta: [...await rootSql`SELECT * FROM harness_shared.consult_post_meta
        WHERE workspace_id=${WS} AND conversation_id=${id} ORDER BY post_id`],
      conversation: [...await rootSql`SELECT * FROM harness_shared.coord_conversations
        WHERE workspace_id=${WS} AND id=${id}`] };
  }
  it('reprocesses an identical accepted source post without duplicating disposition history', async () => {
    const { id, deps, posts, findingId } = await reviewed();
    const post = await deps.post({ conversation_id: id, body: 'Planned', via_consult_verb: true });
    if ('error' in post) throw new Error(post.error);
    const req = { workspaceId: WS, conversationId: id, authorId: REQUESTER, kind: 'new_fact' as const,
      body: 'Planned', reviewDispositions: [disposition(findingId)] };
    const replayDeps = { ...deps, post: async () => post };
    expect(await consultReplyCore(req, replayDeps)).toMatchObject({ ok: true });
    const before = await snapshot(id, posts);
    expect(await consultReplyCore(req, { ...replayDeps, now: () => new Date('2026-11-03') })).toMatchObject({ ok: true });
    expect(await snapshot(id, posts)).toEqual(before);
    expect(readConsultReview(before.row.outcome)?.dispositions).toHaveLength(1);
  });
  it('refuses a conflicting same-source disposition payload before persistence', async () => {
    const { id, deps, posts, findingId } = await reviewed();
    const post = await deps.post({ conversation_id: id, body: 'Planned', via_consult_verb: true });
    if ('error' in post) throw new Error(post.error);
    const req = { workspaceId: WS, conversationId: id, authorId: REQUESTER, kind: 'new_fact' as const,
      body: 'Planned', reviewDispositions: [disposition(findingId)] };
    const replayDeps = { ...deps, post: async () => post };
    await consultReplyCore(req, replayDeps);
    const before = await snapshot(id, posts);
    expect(await consultReplyCore({ ...req, reviewDispositions: [disposition(findingId, 'fixed')] }, replayDeps))
      .toMatchObject({ error: 'invalid_review', hint: expect.stringContaining('Conflicting replay') });
    expect(await snapshot(id, posts)).toEqual(before);
  });
  it('refuses an authorized attempt to replace prior review history before mutation', async () => {
    const { id, deps, posts, findingId } = await reviewed();
    const before = await snapshot(id, posts);
    expect(await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      kind: 'new_fact', body: 'Replace review', review: { ...review, findings: [] } }, deps))
      .toMatchObject({ error: 'invalid_review' });
    expect(await consultCloseCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      outcome: 'answered', answer: 'Replace history',
      reviewDispositions: [{ ...disposition(findingId), history: [] }] as never }, deps))
      .toMatchObject({ error: 'invalid_review' });
    expect(await snapshot(id, posts)).toEqual(before);
  });

  // Invoke the production tools and their real identity resolver. Only the DB,
  // conversation post and notification adapters are isolated to this fixture;
  // neither authorization nor the persistence decision is replaced.
  async function publicTools(deps: ConsultVerbDeps, run: (tools: {
    reply: (args: Record<string, unknown>, owner: string, transport: string) => Promise<unknown>;
    close: (args: Record<string, unknown>, owner: string, transport: string) => Promise<unknown>;
  }) => Promise<void>) {
    const [db, conversations, notify, dispatch, liveness, deadSessions, stopper, events, reply, close] = await Promise.all([
      import('@papercusp/db-org'), import('../agent-tools/coordination/conversations'),
      import('../agent-tools/coordination/notify-agents'), import('./consult-dispatch'),
      import('../agent-tools/coordination/inbox-wake'), import('../agent-tools/coordination/dead-session-recipient-guidance'),
      import('./consult-expiry-adapters'), import('../events/await/engine'),
      import('../agent-tools/consult/reply'), import('../agent-tools/consult/close'),
    ]);
    const spies = [
      vi.spyOn(db, 'getOrgPg').mockReturnValue({ sql: rootSql } as never),
      vi.spyOn(conversations, 'postReply').mockImplementation((_identity, input) => deps.post(input as never)),
      vi.spyOn(conversations, 'conversationsScopeWorkspace').mockReturnValue(WS),
      vi.spyOn(conversations, 'settleConsultConversation').mockImplementation(async (_identity, input, tx) => {
        await deps.settleConversation?.(input as never, tx as never);
      }),
      vi.spyOn(notify, 'notifyAgents').mockResolvedValue({ woke: 0 } as never),
      vi.spyOn(liveness, 'reportIdleRecipients').mockResolvedValue({ degraded: false, confirmedDead: [] } as never),
      vi.spyOn(deadSessions, 'lookupEndedSessions').mockResolvedValue(new Map()),
      vi.spyOn(dispatch, 'makeDeferredConsultReachDispatcher').mockReturnValue(deps.dispatch as never),
      vi.spyOn(stopper, 'consultExpiryStopAnsweringSession').mockReturnValue(async () => 'none' as never),
      vi.spyOn(events, 'emitAwaitedEvent').mockResolvedValue({} as never),
    ];
    type PublicTool = { args: { parse: (args: unknown) => unknown }; handler: (args: unknown, ctx: unknown) => Promise<unknown> };
    const invoke = (tool: unknown) => async (args: Record<string, unknown>, owner: string, transport: string) => {
      const definition = tool as PublicTool;
      // Server-authenticated superuser context keeps the durable client/owner;
      // the MCP handshake and per-call run ids change on managed resume.
      return definition.handler(definition.args.parse(args), {
        isSuperuser: true, uiClientId: owner, workspaceId: WS, runId: transport, mcpSessionId: transport,
      });
    };
    try { await run({ reply: invoke(reply.default), close: invoke(close.default) }); }
    finally { for (const spy of spies) spy.mockRestore(); }
  }
  it('accepts a valid disposition from the same verified requester after managed resume on a new transport', async () => {
    const { id, deps, findingId } = await reviewed();
    await publicTools(deps, async ({ reply, close }) => {
      expect(await reply({ conversation_id: id, kind: 'new_fact', body: 'Planned before resume',
        reviewDispositions: [disposition(findingId)] }, REQUESTER, 'mcp-before-respawn'))
        .toMatchObject({ data: { ok: true } });
      expect(await close({ conversation_id: id, outcome: 'answered', answer: 'Verified after resume',
        reviewDispositions: [disposition(findingId, 'fixed')] }, REQUESTER, 'mcp-after-respawn'))
        .toMatchObject({ data: { ok: true } });
    });
    expect(readConsultReview((await stateRow(id)).outcome)?.dispositions.map(d => [d.authorId, d.status]))
      .toEqual([[REQUESTER, 'planned'], [REQUESTER, 'fixed']]);
  });
  it('refuses valid-finding dispositions from peer and reviewer identities before any mutation', async () => {
    const { id, deps, posts, findingId } = await reviewed();
    const before = await snapshot(id, posts);
    await publicTools(deps, async ({ reply, close }) => {
      for (const owner of ['unrelated-peer', RESPONDER]) {
        // A caller-supplied authorId must not override the verified transport.
        const reviewDispositions = [disposition(findingId)];
        expect(await reply({ conversation_id: id, kind: 'new_fact', body: 'Dismissed',
          authorId: REQUESTER, reviewDispositions }, owner, `mcp-${owner}`))
          .toMatchObject({ data: { error: expect.stringMatching(/not_a_participant|invalid_review/) } });
        expect(await close({ conversation_id: id, outcome: 'answered', answer: 'Dismissed',
          authorId: REQUESTER, reviewDispositions }, owner, `mcp-${owner}-close`))
          .toMatchObject({ data: { error: expect.stringMatching(/not_a_participant|invalid_review/) } });
        expect(await snapshot(id, posts)).toEqual(before);
      }
    });
  });

  async function overlapping(id: string, deps: ConsultVerbDeps, first: Parameters<typeof consultReplyCore>[0],
    second: Parameters<typeof consultReplyCore>[0]) {
    const sql = postgres(fixtureDb.url, { max: 4, onnotice: () => {}, connection: { application_name: 'egm-disposition-overlap' } });
    const locked = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const secondPosted = Promise.withResolvers<void>();
    const permitSecond = Promise.withResolvers<void>();
    const commits: number[] = [];
    const hold = rootSql.begin(async tx => {
      await tx`SELECT outcome FROM harness_shared.consult_state
        WHERE workspace_id=${WS} AND conversation_id=${id} FOR UPDATE`;
      locked.resolve(); await unlock.promise;
    });
    try {
      await locked.promise;
      const a = consultReplyCore(first, { ...deps, getSql: () => sql, post: async input => {
        const result = await deps.post(input);
        if (!('error' in result)) result.post.created_ts = '2026-11-03T03:00:00Z';
        return result;
      } });
      await expect.poll(async () => Number((await sql`SELECT count(*) AS n FROM pg_stat_activity
        WHERE application_name='egm-disposition-overlap' AND wait_event_type='Lock'`)[0].n)).toBe(1);
      const b = consultReplyCore(second, { ...deps, getSql: () => sql, post: async input => {
        secondPosted.resolve(); await permitSecond.promise;
        const result = await deps.post(input);
        if (!('error' in result)) result.post.created_ts = '2026-11-03T01:00:00Z';
        return result;
      } });
      await secondPosted.promise;
      unlock.resolve(); await hold;
      const firstResult = await a;
      if ('error' in firstResult) throw new Error(firstResult.error);
      commits.push(firstResult.post_id); // Observed committed result BEFORE permitting B.
      permitSecond.resolve();
      const secondResult = await b;
      if ('error' in secondResult) throw new Error(secondResult.error);
      commits.push(secondResult.post_id);
      return commits;
    } finally { unlock.resolve(); permitSecond.resolve(); await hold; await sql.end({ timeout: 5 }); }
  }
  it('preserves both concurrent authorized disposition appends in committed order', async () => {
    const { id, deps, findingId } = await reviewed();
    const base = { workspaceId: WS, conversationId: id, authorId: REQUESTER, kind: 'new_fact' as const, body: 'Disposition' };
    const commits = await overlapping(id, deps,
      { ...base, reviewDispositions: [disposition(findingId)] },
      { ...base, reviewDispositions: [disposition(findingId, 'fixed')] });
    const row = await stateRow(id);
    const events = readConsultReview(row.outcome)!.dispositions;
    expect(events.map(d => d.postId)).toEqual(commits);
    expect(events.map(d => d.status)).toEqual(['planned', 'fixed']);
    expect(events.map(d => d.at)).toEqual(['2026-11-03T03:00:00Z', '2026-11-03T01:00:00Z']);
    expect(row.exchanges_used).toBe(2);
  });

  const sentinel = { acceptedBeforeReview: { nested: ['keep', 17] }, reconciliation: { status: 'confirmed', ref: 'WI-existing' } };
  it('preserves unrelated accepted outcome data through review reply, disposition, close and canonical round trips', async () => {
    const id = await seedConsult({ maxExchanges: 20 });
    const { deps } = makeDeps({ withDispatch: false });
    await rootSql`UPDATE harness_shared.consult_state SET outcome=${rootSql.json(sentinel)} WHERE conversation_id=${id}`;
    const result = await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: RESPONDER,
      kind: 'answer', body: 'Review', evidence: [{ session_id: 'review-session', turn_idx: 1 }], review }, deps);
    if ('error' in result) throw new Error(result.error);
    const findingId = `post:${result.post_id}#F1`;
    const check = async () => {
      const stored = (await stateRow(id)).outcome;
      expect(stored).toMatchObject(sentinel);
      const roundTrip = readConsultReview(JSON.stringify(stored));
      expect(roundTrip).toEqual(readConsultReview(stored));
      await rootSql`UPDATE harness_shared.consult_state
        SET outcome=outcome || ${rootSql.json({ review: roundTrip } as never)}::jsonb WHERE conversation_id=${id}`;
      expect((await stateRow(id)).outcome).toEqual(stored);
    };
    await check();
    await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER, kind: 'new_fact', body: 'Planned',
      reviewDispositions: [disposition(findingId)] }, deps);
    await check();
    await consultCloseCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      outcome: 'answered', answer: 'Repair carried', reviewDispositions: [disposition(findingId, 'fixed')] }, deps);
    await check();
  });
  it('preserves unrelated accepted outcome data through an ordinary edit to another field', async () => {
    const { id, deps, findingId } = await reviewed();
    await rootSql`UPDATE harness_shared.consult_state SET outcome=outcome || ${rootSql.json(sentinel)}::jsonb WHERE conversation_id=${id}`;
    const before = (await stateRow(id)).outcome;
    await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER,
      kind: 'question', body: 'Clarify the implementation boundary' }, deps);
    expect((await stateRow(id)).outcome).toEqual(before);
    await consultReplyCore({ workspaceId: WS, conversationId: id, authorId: REQUESTER, kind: 'new_fact', body: 'Disposition',
      reviewDispositions: [disposition(findingId)] }, deps);
    expect((await stateRow(id)).outcome).toMatchObject(sentinel);
  });
  it('preserves unrelated and concurrently accepted outcome data during overlapping accepted updates', async () => {
    const { id, deps, findingId } = await reviewed();
    await rootSql`UPDATE harness_shared.consult_state SET outcome=outcome || ${rootSql.json(sentinel)}::jsonb WHERE conversation_id=${id}`;
    const base = { workspaceId: WS, conversationId: id, authorId: REQUESTER, kind: 'new_fact' as const, body: 'Disposition' };
    let posts = 0;
    const commits = await overlapping(id, { ...deps, post: async input => {
      // An independently accepted non-review update overlaps the pending review
      // transaction and must survive its merge of the review field.
      if (++posts === 2) await rootSql`UPDATE harness_shared.consult_state
        SET outcome=outcome || '{"acceptedConcurrently":{"retained":true}}'::jsonb WHERE conversation_id=${id}`;
      return deps.post(input);
    } }, { ...base, reviewDispositions: [disposition(findingId)] },
    { ...base, reviewDispositions: [disposition(findingId, 'fixed')] });
    const outcome = (await stateRow(id)).outcome;
    expect(outcome).toMatchObject({ ...sentinel, acceptedConcurrently: { retained: true } });
    expect(readConsultReview(outcome)?.dispositions.map(d => d.postId)).toEqual(commits);
  });
});

// Durable acknowledgement/recovery uses the real production adapter and real
// consult rows; only the launch seam is controlled, so a blocked launch cannot
// accidentally pass because the test bypassed the interactive binding.
describe('durable cascade acknowledgement and restart recovery', () => {
  async function queuedRow(id: string) {
    return await stateRow(id) as Record<string, unknown> & { expires_at: string; routing: {
      cascadeDispatch?: { attempts?: number; lastError?: string; leaseToken?: string | null; leaseUntil?: string | null };
      selection: { selected: Array<{ answeringOwnerId?: string }> };
    } };
  }
  async function queue(kind: 'decline' | 'reply' = 'decline', refill = false) {
    const snap = menuSnapshot([RESPONDER, 'resp-next']);
    const routing = refill ? { ...snap, selection: { min: 1, selected: snap.selection.selected.slice(0, 1) } } : snap;
    const id = await seedConsult({ routing });
    const { deps, posts } = makeDeps();
    let acknowledged = false;
    let acknowledgedBeforeLaunch = false;
    let launchFinished!: Promise<boolean>;
    let starts = 0;
    deps.dispatch = makeDeferredConsultReachDispatcher({ workspaceId: WS, harnessSlug: 'papercusp', launchedBy: RESPONDER }, {
      getSql: () => rootSql,
      continueDispatch: async () => {
        starts += 1;
        launchFinished = new Promise<boolean>((resolve) => setImmediate(() => {
          acknowledgedBeforeLaunch = acknowledged;
          resolve(true);
        }));
        return launchFinished;
      },
    });
    const result = kind === 'decline'
      ? await consultDeclineCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'wrong subsystem' }, deps)
      : await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'known fact' }, deps);
    if ('error' in result) throw new Error(result.error);
    acknowledged = true;
    await launchFinished;
    expect(acknowledgedBeforeLaunch).toBe(true);
    expect(result.cascade).toMatchObject({ advanced_to: 'resp-next', exhausted: false, woke: 0, pending: true });
    expect(result.hint).toContain('durably queued');
    expect(posts).toHaveLength(1);
    expect(starts).toBe(1);
    return id;
  }

  it.each(['decline', 'reply'] as const)('%s returns its post identity while the subsequent launch is blocked', async (kind) => {
    const id = await queue(kind);
    const row = await queuedRow(id);
    expect(row.cascade_cursor).toBe(1);
    expect(row.routing.cascadeDispatch).toMatchObject({ version: 1, cursor: 1, responder: 'resp-next', leaseToken: null });
    expect(row.routing.selection.selected[1].answeringOwnerId).toBeUndefined();
    const posts = await rootSql`SELECT post_id FROM harness_shared.consult_post_meta WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    expect(posts).toHaveLength(1);
  });

  it('queues the refill without mistaking an accepted launch for a failed dispatch', async () => {
    const id = await queue('decline', true);
    expect((await queuedRow(id)).cascade_digest).toMatchObject([{ kind: 'decline' }]);
  });

  it.each(['decline', 'reply'] as const)('%s acknowledges while its continuation owns the lease and is still launching', async (kind) => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-next']) });
    const { deps, posts } = makeDeps();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let continuation: Promise<boolean> | undefined;
    let launches = 0;
    let currentAtCompletion = false;
    deps.dispatch = makeDeferredConsultReachDispatcher({ workspaceId: WS, harnessSlug: 'papercusp', launchedBy: RESPONDER }, {
      getSql: () => rootSql,
      continueDispatch: (workspaceId, conversationId) => {
        continuation = continueCascadeDispatchCore(workspaceId, conversationId, {
          getSql: () => rootSql,
          now: () => NOW,
          dispatch: (isCurrent) => async (opts) => {
            launches += 1;
            entered();
            await held;
            currentAtCompletion = await isCurrent();
            await opts.onAnsweringOwner?.('resp-next-fork');
            return { woke: 1, answeringOwnerId: 'resp-next-fork' };
          },
        });
        return continuation;
      },
    });
    let acknowledged = false;
    const response = (kind === 'decline'
      ? consultDeclineCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'wrong subsystem' }, deps)
      : consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'known fact' }, deps)
    ).then((result) => { acknowledged = true; return result; });
    try {
      await started;
      // Observe after the acknowledgement microtasks, while the real lease-owning
      // continuation remains blocked. Always release it, including on regression.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(true);
      const result = await response;
      if ('error' in result) throw new Error(result.error);
      expect(result.post_id).toBeTruthy();
      expect(result.cascade).toMatchObject({ advanced_to: 'resp-next', woke: 0, pending: true });
      const pending = (await queuedRow(id)).routing.cascadeDispatch;
      expect(pending?.leaseToken).toEqual(expect.any(String));
      expect(new Date(pending!.leaseUntil!).getTime()).toBeGreaterThan(NOW.getTime());
      expect(posts).toHaveLength(1);
      const persisted = await rootSql`SELECT post_id FROM harness_shared.consult_post_meta
        WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
      expect(persisted).toHaveLength(1);
      expect(String(persisted[0].post_id)).toBe(String(result.post_id));
      expect(launches).toBe(1);
    } finally {
      release();
      await response;
      await continuation;
    }
    expect(currentAtCompletion).toBe(true);
    expect((await queuedRow(id)).routing.cascadeDispatch).toBeUndefined();
    expect((await queuedRow(id)).routing.selection.selected[1].answeringOwnerId).toBe('resp-next-fork');
    expect(launches).toBe(1);
  });

  it('restarts from the saved copy, authorizes the answerer before launch, and does not launch twice', async () => {
    const id = await queue();
    let launches = 0;
    const deps = { getSql: () => rootSql, now: () => NOW, dispatch: (isCurrent: () => Promise<boolean>) => async (opts: Parameters<NonNullable<ConsultVerbDeps['dispatch']>>[0]) => {
      expect(await isCurrent()).toBe(true);
      expect(opts.body).toContain('wrong subsystem');
      await opts.onAnsweringOwner?.('resp-next-fork');
      expect((await queuedRow(id)).routing.selection.selected[1].answeringOwnerId).toBe('resp-next-fork');
      launches += 1;
      return { woke: 1, answeringOwnerId: 'resp-next-fork' };
    } };
    expect(await continueCascadeDispatchCore(WS, id, deps)).toBe(true);
    expect(await continueCascadeDispatchCore(WS, id, deps)).toBe(false);
    expect(launches).toBe(1);
    expect((await queuedRow(id)).routing.cascadeDispatch).toBeUndefined();
  });

  it('revalidates an unreplaced dispatch lease after slow preflight', async () => {
    const id = await queue();
    let time = NOW;
    expect(await continueCascadeDispatchCore(WS, id, {
      getSql: () => rootSql, now: () => time,
      dispatch: (isCurrent) => async (opts) => {
        time = new Date(NOW.getTime() + 300_000);
        // The consultation is still open and no other continuation took its
        // token. Slow capacity/transcript preparation must not impersonate a
        // terminal consultation at the actual spawn boundary.
        expect(await isCurrent()).toBe(true);
        expect(new Date((await queuedRow(id)).routing.cascadeDispatch!.leaseUntil!).getTime())
          .toBeGreaterThan(time.getTime());
        await opts.onAnsweringOwner?.('slow-preflight-fork');
        return { woke: 1, answeringOwnerId: 'slow-preflight-fork' };
      },
    })).toBe(true);
    expect((await queuedRow(id)).routing.selection.selected[1].answeringOwnerId).toBe('slow-preflight-fork');
  });

  it('does not renew a dispatch lease after the consultation closes', async () => {
    const id = await queue();
    await continueCascadeDispatchCore(WS, id, {
      getSql: () => rootSql, now: () => NOW,
      dispatch: (isCurrent) => async () => {
        await rootSql`UPDATE harness_shared.consult_state SET state='closed_answered', closed_at=${NOW.toISOString()}::timestamptz
          WHERE workspace_id=${WS} AND conversation_id=${id}`;
        expect(await isCurrent()).toBe(false);
        return { woke: 0 };
      },
    });
    expect((await stateRow(id)).state).toBe('closed_answered');
  });

  it('only one continuation acquires a live lease; the sweep cannot expire its launch', async () => {
    const id = await queue();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const deps = { getSql: () => rootSql, now: () => NOW, dispatch: () => async () => {
      entered(); await held; return { woke: 0, answeringOwnerId: null };
    } };
    const first = continueCascadeDispatchCore(WS, id, deps);
    await started;
    expect(await continueCascadeDispatchCore(WS, id, deps)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(new Date((await queuedRow(id)).expires_at).getTime()).toBeLessThan(NOW.getTime());
  });

  it('recovers an expired pre-launch lease and fences the older continuation', async () => {
    const id = await queue();
    let time = NOW;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let staleCurrent = true;
    const first = continueCascadeDispatchCore(WS, id, { getSql: () => rootSql, now: () => time, dispatch: (isCurrent) => async () => {
      entered(); await held; staleCurrent = await isCurrent(); return { woke: 0, answeringOwnerId: null };
    } });
    await started;
    time = new Date(NOW.getTime() + 120_001);
    expect(await continueCascadeDispatchCore(WS, id, { getSql: () => rootSql, now: () => time, dispatch: () => async (opts) => {
      await opts.onAnsweringOwner?.('restart-fork'); return { woke: 1, answeringOwnerId: 'restart-fork' };
    } })).toBe(true);
    release(); await first;
    expect(staleCurrent).toBe(false);
    expect((await queuedRow(id)).routing.selection.selected[1].answeringOwnerId).toBe('restart-fork');
    expect(new Date((await queuedRow(id)).expires_at).getTime()).toBeGreaterThan(time.getTime());
  });

  it('does not replay a reserved answering identity after process death', async () => {
    const id = await queue();
    await rootSql`UPDATE harness_shared.consult_state SET routing = jsonb_set(routing, '{selection,selected,1,answeringOwnerId}', '"reserved-fork"'::jsonb) WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    let called = false;
    expect(await continueCascadeDispatchCore(WS, id, { getSql: () => rootSql, now: () => NOW, dispatch: () => async () => {
      called = true; return { woke: 1 };
    } })).toBe(false);
    expect(called).toBe(false);
  });

  it('persists thrown pre-launch recovery and retries only after its backoff', async () => {
    const id = await queue();
    const fail = { getSql: () => rootSql, now: () => NOW, dispatch: () => async () => { throw new Error('pre-launch fault'); } };
    await expect(continueCascadeDispatchCore(WS, id, fail)).rejects.toThrow('pre-launch fault');
    expect((await queuedRow(id)).routing.cascadeDispatch).toMatchObject({ attempts: 1, lastError: 'Error: pre-launch fault', leaseToken: null });
    expect(await continueCascadeDispatchCore(WS, id, fail)).toBe(false);
    expect(await continueCascadeDispatchCore(WS, id, { ...fail, now: () => new Date(NOW.getTime() + 30_001), dispatch: () => async () => ({ woke: 0 }) })).toBe(true);
  });

  it('bounds thrown recovery attempts and makes exhaustion due for requester-visible expiry', async () => {
    const id = await queue();
    let time = NOW;
    const deps = { getSql: () => rootSql, now: () => time, dispatch: () => async () => { throw new Error('persistent launch fault'); } };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(continueCascadeDispatchCore(WS, id, deps)).rejects.toThrow('persistent launch fault');
      time = new Date(time.getTime() + 30_001);
    }
    expect((await queuedRow(id)).routing.cascadeDispatch).toMatchObject({ attempts: 3, leaseToken: null });
    expect(new Date((await queuedRow(id)).expires_at).getTime()).toBeLessThan(time.getTime());
    expect(await continueCascadeDispatchCore(WS, id, deps)).toBe(false);
  });
});
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);
// Migration 844 (cascade_cursor + cascade_digest) — .sql once armed, .DRAFT
// while iterating, so the suite is valid on both sides of the arming mv.
const MIGRATION_844_ARMED = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url),
);
const MIGRATION_844 = existsSync(MIGRATION_844_ARMED) ? MIGRATION_844_ARMED : `${MIGRATION_844_ARMED}.DRAFT`;

let rootSql: Sql;
let fixtureDb: MigratedTestDb;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'consultv' });
  rootSql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Minimal landing pad for the migration's coord_conversations kind-CHECK
  // widening (the real table is migration-132-owned; only `kind` matters here).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      accepted_answer text,
      accepted_post_id bigint,
      updated_at timestamptz,
      resolved_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    )`);
  // The REAL migration — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_844, 'utf8'));
  await rootSql.unsafe(readFileSync(fileURLToPath(
    new URL('../../../../libs/papercusp/libs/db/sql/1484-consult-state-no-launchable-responder.sql', import.meta.url),
  ), 'utf8'));
}, 120_000);

afterAll(async () => {
  try { await rootSql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

// ── Fixture builders ─────────────────────────────────────────────────────

let convSeq = 0;
let postSeq = 100;

interface SeedOpts {
  state?: string;
  responderId?: string | null;
  exchangesUsed?: number;
  maxExchanges?: number;
  wakesUsed?: number;
  originTaskRef?: string | null;
  routing?: unknown;
  latency?: string;
  /** Override the generated id. Needed for refs of the REAL
   * `<short>-0000-<32 hex>` shape, which the truncated-prefix resolver
   * branches on (EI-23942597240908282). */
  id?: string;
}

/** Insert a consult_state row directly (P-003's writer owns the real path;
 * these verbs only ever see an existing row). Returns the conversation id. */
async function seedConsult(opts: SeedOpts = {}): Promise<string> {
  convSeq += 1;
  const id = opts.id ?? `conv-v-${convSeq}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, max_exchanges, exchanges_used, wakes_used, origin_task_ref, routing)
    VALUES
      (${WS}, ${id}, ${REQUESTER}, ${opts.responderId === undefined ? RESPONDER : opts.responderId},
       ${opts.state ?? 'awaiting_responder'}, 'q', ${opts.latency ?? 'proceed'},
       ${opts.maxExchanges ?? 4}, ${opts.exchangesUsed ?? 0}, ${opts.wakesUsed ?? 0},
       ${opts.originTaskRef ?? null}, ${rootSql.json((opts.routing ?? {}) as never)})
  `;
  await rootSql`
    INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, state, updated_at)
    VALUES (${WS}, ${id}, 'consult', 'open', ${NOW.toISOString()}::timestamptz)
  `;
  return id;
}

function makeDeps(
  opts: {
    postError?: string;
    withReach?: boolean;
    withDispatch?: boolean;
    /** Force the dispatched session's identity (default: `<responder>-fork`). */
    answeringOwnerId?: string;
    withMint?: boolean;
    mintError?: string;
    withSettlement?: boolean;
    settlementError?: string;
  } = {},
) {
  const posts: Array<{ conversation_id: string; body: string; via_consult_verb: true }> = [];
  const emits: Array<{ key: string; summary: string; payload: Record<string, unknown>; to: string[] }> = [];
  const reached: Array<{ responder: string; conversationId: string }> = [];
  const reachCalls: Array<{ responder: string; conversationId: string; summary: string; body: string }> = [];
  /** D-011: the CASCADE's deliveries, kept apart from `reach` on purpose. The
   * two seams address different parties — `reach` notifies the session already
   * answering, `dispatch` launches a new one from the next expert's transcript
   * — and a shared recorder would let a regression that swaps them pass. */
  const dispatchCalls: Array<{ responder: string; conversationId: string; summary: string; body: string }> = [];
  const minted: Array<Parameters<NonNullable<ConsultVerbDeps['mintGraduationWorkItem']>>[0]> = [];
  const settlements: Array<Parameters<NonNullable<ConsultVerbDeps['settleConversation']>>[0]> = [];
  const deps: ConsultVerbDeps = {
    getSql: () => rootSql,
    post: async (input) => {
      if (opts.postError) return { error: opts.postError };
      posts.push(input);
      postSeq += 1;
      const post: ThreadPostRow = {
        id: postSeq,
        thread_id: `thr-${input.conversation_id}`,
        author_id: 'author',
        body: input.body,
        created_ts: NOW.toISOString(),
      };
      return { post, delivered: 1 };
    },
    emitReplyEvent: async (e) => {
      emits.push(e);
    },
    ...(opts.withSettlement
      ? {
          settleConversation: async (
            input: Parameters<NonNullable<ConsultVerbDeps['settleConversation']>>[0],
            tx: Parameters<NonNullable<ConsultVerbDeps['settleConversation']>>[1],
          ) => {
            settlements.push(input);
            if (opts.settlementError) throw new Error(opts.settlementError);
            if (!tx) throw new Error('settlement transaction missing');
            await tx`
              UPDATE harness_shared.coord_conversations
                 SET state = ${input.outcome === 'answered' ? 'resolved' : 'closed'},
                     accepted_answer = ${input.answer ?? null},
                     accepted_post_id = ${input.outcome === 'answered' ? input.postId : null},
                     updated_at = ${input.now}::timestamptz,
                     resolved_at = ${input.outcome === 'answered' ? input.now : null}::timestamptz
               WHERE workspace_id = ${WS} AND id = ${input.conversationId}
            `;
          },
        }
      : {}),
    ...(opts.withReach === false
      ? {}
      : {
          reach: async (o) => {
            reached.push({ responder: o.responder, conversationId: o.conversationId });
            reachCalls.push(o);
            return { woke: 1 };
          },
        }),
    ...(opts.withDispatch === false
      ? {}
      : {
          dispatch: async (o) => {
            dispatchCalls.push(o);
            return {
              woke: 1,
              // A fork answers under a NEW identity — the shape production
              // actually returns, so a fixture cannot accidentally pin the
              // same-identity case that only a conversion produces.
              answeringOwnerId: opts.answeringOwnerId ?? `${o.responder}-fork`,
            };
          },
        }),
    ...(opts.withMint || opts.mintError
      ? {
          mintGraduationWorkItem: async (input) => {
            if (opts.mintError) throw new Error(opts.mintError);
            minted.push(input);
            return { id: `WI-GRAD-${minted.length}` };
          },
        }
      : {}),
    now: () => NOW,
  };
  return { deps, posts, emits, reached, reachCalls, dispatchCalls, minted, settlements };
}

async function stateRow(conversationId: string) {
  const rows = (await rootSql`
    SELECT * FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  // This fixture connection returns jsonb unparsed — normalize before asserting.
  for (const k of ['routing', 'outcome', 'cascade_digest'] as const) {
    if (typeof row[k] === 'string') row[k] = JSON.parse(row[k] as string);
  }
  return row;
}

async function metaRows(conversationId: string) {
  const rows = (await rootSql`
    SELECT * FROM harness_shared.consult_post_meta
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
     ORDER BY post_id
  `) as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    if (typeof row.evidence === 'string') row.evidence = JSON.parse(row.evidence);
  }
  return rows;
}

async function jsonbShapes(conversationId: string) {
  const rows = (await rootSql`
    SELECT jsonb_typeof(routing) AS routing_type,
           jsonb_typeof(outcome) AS outcome_type,
           jsonb_typeof(cascade_digest) AS cascade_digest_type
      FROM harness_shared.consult_state
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
  `) as unknown as Array<{
    routing_type: string | null;
    outcome_type: string | null;
    cascade_digest_type: string | null;
  }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function evidenceJsonbType(conversationId: string) {
  const rows = (await rootSql`
    SELECT jsonb_typeof(evidence) AS evidence_type
      FROM harness_shared.consult_post_meta
     WHERE workspace_id = ${WS} AND conversation_id = ${conversationId}
     ORDER BY post_id
     LIMIT 1
  `) as unknown as Array<{ evidence_type: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].evidence_type;
}

const EVIDENCE = [{ session_id: 'sess-r', turn_idx: 7, note: 'the debug session' }];

describe.each(['confirmed', 'rescoped', 'reversed', 'moot'] as const)(
  'retired requester reporting — historical outcome preservation: %s',
  (disposition) => {
    const historical = {
      disposition,
      note: 'Previously recorded project decision; no new reporting call is required.',
      by: REQUESTER,
      at: '2026-08-15T12:00:00Z',
      consult_state: 'active',
      decision_ref: 'historical-project#D-001',
    };

    async function seedHistory() {
      const id = await seedConsult({ state: 'active' });
      await rootSql`
        UPDATE harness_shared.consult_state
           SET outcome = ${rootSql.json({ reconciliation: historical } as never)}
         WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
      expect((await stateRow(id)).outcome).toEqual({ reconciliation: historical });
      return id;
    }

    it('preserves the exact historical record when the responder replies', async () => {
      const id = await seedHistory();
      const { deps } = makeDeps();
      const result = await consultReplyCore({
        workspaceId: WS, authorId: RESPONDER, conversationId: id,
        kind: 'answer', body: 'Source-grounded advice.', evidence: EVIDENCE,
      }, deps);
      expect(result).not.toHaveProperty('error');
      expect((await stateRow(id)).outcome).toEqual({ reconciliation: historical });
    });

    it.each(['answered', 'cant_help', 'graduate'] as const)(
      'preserves the exact historical record through an %s close',
      async (outcome) => {
        const id = await seedHistory();
        const { deps } = makeDeps({ withMint: true });
        const result = await consultCloseCore({
          workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome,
          ...(outcome === 'answered'
            ? { answer: 'Advice reviewed in the project.', evidence: EVIDENCE }
            : { reason: 'Continue the project through the ordinary workflow.' }),
        }, deps);
        expect(result).not.toHaveProperty('error');
        const row = await stateRow(id);
        expect(row.state).toBe(outcome === 'answered'
          ? 'closed_answered' : outcome === 'graduate' ? 'graduated' : 'closed_cant_help');
        expect(row.outcome).toMatchObject({ reconciliation: historical });
        expect((row.outcome as Record<string, unknown>).reconciliation).toEqual(historical);
      },
    );

    it('preserves the exact historical record through terminal decline', async () => {
      const id = await seedHistory();
      const { deps } = makeDeps();
      const result = await consultDeclineCore({
        workspaceId: WS, authorId: RESPONDER, conversationId: id,
        reason: 'The transcript does not cover this question.',
      }, deps);
      expect(result).not.toHaveProperty('error');
      const row = await stateRow(id);
      expect(row.state).toBe('declined');
      expect((row.outcome as Record<string, unknown>).reconciliation).toEqual(historical);
    });
  },
);

// ── consult:reply ────────────────────────────────────────────────────────
describe('consultReplyCore — kind rules + transitions', () => {
  it('responder answer: meta row with evidence, awaiting_responder→active, park-key emit to the requester', async () => {
    const id = await seedConsult();
    const { deps, posts, emits } = makeDeps();
    const emit = deps.emitReplyEvent;
    deps.emitReplyEvent = async (event) => {
      if (event.key === `consult:answer-posted:${id}`) {
        expect((await stateRow(id)).state).toBe('active');
        expect(await metaRows(id)).toMatchObject([{ kind: 'answer', author_id: RESPONDER }]);
      }
      await emit(event);
    };
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.role).toBe('responder');
    expect(r.state).toBe('active');
    expect(r.exchanges_used).toBe(0); // a PERSPECTIVE reply is cap-exempt and does not debit (D-005)
    expect(r.wake).toBeUndefined(); // responder replies carry no wake report
    expect(r.cascade).toEqual({ advanced_to: null, exhausted: true, woke: 0 }); // seed has no selection menu

    // Write-through went via the (gated) post seam.
    expect(posts).toEqual([{ conversation_id: id, body: 'the answer', via_consult_verb: true }]);

    // Typed overlay landed under the migration's kind CHECK, evidence verbatim.
    const meta = await metaRows(id);
    expect(meta).toHaveLength(1);
    expect(meta[0].kind).toBe('answer');
    expect(meta[0].author_id).toBe(RESPONDER);
    expect(meta[0].evidence).toEqual(EVIDENCE);
    expect(await evidenceJsonbType(id)).toBe('array');

    // State row transitioned; a perspective reply does NOT debit the cap (D-005).
    const row = await stateRow(id);
    expect(row.state).toBe('active');
    expect(row.exchanges_used).toBe(0);
    // consultReplyCore normalizes outcome to {} on its first post so future
    // review metadata can merge without inventing a second terminal schema.
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });

    // The hard-blocked requester's park key fired, latched, addressed to them.
    expect(emits).toHaveLength(2);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
    expect(emits[0].payload.post_id).toBe(r.post_id);
    expect(emits[1]).toMatchObject({ key: `consult:answer-posted:${id}`, to: [],
      payload: { conversation_id: id, responder: RESPONDER, kind: 'answer', post_id: r.post_id } });
  });

  it.each(['clarifying_question', 'new_fact'] as const)('%s does not signal an answer', async (kind) => {
    const id = await seedConsult();
    const { deps, emits } = makeDeps();
    expect(await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id,
      kind, body: 'More context', evidence: EVIDENCE }, deps)).toMatchObject({ ok: true });
    expect(emits.map((event) => event.key)).toEqual([`consult:reply:${id}`]);
  });

  it('an answer WITHOUT evidence is refused (D-004 grounding) — nothing written', async () => {
    const id = await seedConsult();
    const { deps, posts } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'ungrounded' },
      deps,
    );
    expect(r).toMatchObject({ error: 'evidence_required' });
    expect(posts).toHaveLength(0);
    expect(await metaRows(id)).toHaveLength(0);
  });

  it('kind rules per role: responder cannot post question; requester cannot post answer/clarifying_question', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'question', body: 'b' }, deps),
    ).toMatchObject({ error: 'invalid_kind', role: 'responder' });
    expect(
      await consultReplyCore(
        { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'answer', body: 'b', evidence: EVIDENCE },
        deps,
      ),
    ).toMatchObject({ error: 'invalid_kind', role: 'requester' });
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'clarifying_question', body: 'b' }, deps),
    ).toMatchObject({ error: 'invalid_kind', role: 'requester' });
  });

  it('a non-participant is refused; an unknown conversation is not_a_consult', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: 'stranger', conversationId: id, kind: 'new_fact', body: 'b' },
      deps,
    );
    // EI-21385436565682208: the refusal must NAME the remedy — participation is
    // router-assigned, so conversations:join can never fix a not_a_participant.
    expect(refused).toMatchObject({
      error: 'not_a_participant',
      hint: expect.stringContaining('consult:get_feedback'),
    });
    expect(refused).toMatchObject({ hint: expect.stringContaining('conversations:join cannot enroll you') });
    // 'conv-none' is NOT of the full `<short>-0000-<32 hex>` shape, so the
    // truncated-ref resolver (EI-23942597240908282) scans for a prefix match,
    // finds none, and attaches the remedy hint. That hint is the contract, not
    // incidental: pin it rather than dropping back to a bare error match.
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: 'conv-none', kind: 'new_fact', body: 'b' }, deps),
    ).toMatchObject({
      error: 'not_a_consult',
      hint: expect.stringContaining("No consult id starts with 'conv-none'"),
    });
  });

  it('terminal states refuse posts, with the decline hint pointing at the cascade', async () => {
    const declined = await seedConsult({ state: 'declined' });
    const closed = await seedConsult({ state: 'closed_answered' });
    const { deps } = makeDeps();
    const r1 = await consultReplyCore({ workspaceId: WS, authorId: REQUESTER, conversationId: declined, kind: 'question', body: 'b' }, deps);
    expect(r1).toMatchObject({ error: 'consult_not_open', state: 'declined' });
    if ('error' in r1 && r1.error === 'consult_not_open') expect(r1.hint).toContain('exclude');
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: closed, kind: 'answer', body: 'b', evidence: EVIDENCE }, deps),
    ).toMatchObject({ error: 'consult_not_open', state: 'closed_answered' });
  });

  it('allows only the explicitly assigned manual responder to post a new_fact fallback on no_qualified_responder', async () => {
    const id = await seedConsult({ state: 'no_qualified_responder', responderId: RESPONDER });
    const { deps, posts } = makeDeps();

    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'manual fallback finding' },
      deps,
    );
    if ('error' in reply) throw new Error(reply.error);
    expect(reply.role).toBe('responder');
    expect(reply.state).toBe('active');
    expect(posts).toEqual([{ conversation_id: id, body: 'manual fallback finding', via_consult_verb: true }]);

    const noAssignment = await seedConsult({ state: 'no_qualified_responder', responderId: null });
    expect(
      await consultReplyCore(
        { workspaceId: WS, authorId: RESPONDER, conversationId: noAssignment, kind: 'new_fact', body: 'unassigned' },
        deps,
      ),
    ).toMatchObject({ error: 'consult_not_open', state: 'no_qualified_responder' });
  });

  it.each(['no_qualified_responder', 'no_launchable_responder'])('continues an undelivered consult (%s) from requester new facts without replaying tried reviewers', async (state) => {
    const snapshot = menuSnapshot([RESPONDER, 'resp-next']);
    const routing = { ...snapshot, selection: { min: 1, selected: snapshot.selection.selected.slice(0, 1) } };
    const id = await seedConsult({ state, responderId: null, routing });
    await rootSql`UPDATE harness_shared.consult_state SET cascade_digest = ${rootSql.json([
      makeDigestEntry(RESPONDER, 'dispatch_failed', NOW.toISOString(), 'source port unavailable'),
    ] as never)} WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    const { deps, reached, dispatchCalls } = makeDeps();
    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'The containing runtime now supports exact source acquisition.' },
      deps,
    );
    if ('error' in reply) throw new Error(reply.error);
    expect(reply.cascade).toMatchObject({ advanced_to: 'resp-next', exhausted: false, woke: 1 });
    expect(reply.wake).toMatchObject({ attempted: false, reroute: { status: 'advanced', to: 'resp-next' } });
    expect(reply.state).toBe('active');
    expect(dispatchCalls.map((call) => call.responder)).toEqual(['resp-next']);
    expect(reached).toEqual([]);
    expect(await stateRow(id)).toMatchObject({ state: 'active', responder_id: 'resp-next', cascade_cursor: 1, exchanges_used: 1 });
  });

  it.each(['no_qualified_responder', 'no_launchable_responder'])('does not restart undelivered consults (%s) for questions, missing selections, foreign authors or a spent exchange cap', async (state) => {
    const routing = menuSnapshot([RESPONDER, 'resp-next']);
    const id = await seedConsult({ state, responderId: null, routing });
    const { deps, posts, dispatchCalls } = makeDeps();
    for (const [authorId, kind] of [[REQUESTER, 'question'], ['unassigned', 'new_fact']] as const) {
      expect(await consultReplyCore({ workspaceId: WS, authorId, conversationId: id, kind, body: 'b' }, deps))
        .toMatchObject({ error: 'consult_not_open' });
    }
    const empty = await seedConsult({ state, responderId: null });
    expect(await consultReplyCore({ workspaceId: WS, authorId: REQUESTER, conversationId: empty, kind: 'new_fact', body: 'b' }, deps))
      .toMatchObject({ error: 'consult_not_open' });
    const capped = await seedConsult({ state, responderId: null, routing, exchangesUsed: 4 });
    expect(await consultReplyCore({ workspaceId: WS, authorId: REQUESTER, conversationId: capped, kind: 'new_fact', body: 'b' }, deps))
      .toMatchObject({ error: 'exchange_cap' });
    expect(posts).toEqual([]);
    expect(dispatchCalls).toEqual([]);
  });

  it('concurrent changed facts launch the next saved reviewer once and preserve its active state', async () => {
    const id = await seedConsult({ state: 'no_qualified_responder', responderId: null, routing: menuSnapshot([RESPONDER, 'resp-next']) });
    const { deps, dispatchCalls } = makeDeps();
    let posted = 0;
    let release!: () => void;
    const bothPosted = new Promise<void>((resolve) => { release = resolve; });
    const originalPost = deps.post;
    deps.post = async (input) => {
      const result = await originalPost(input);
      if (++posted === 2) release();
      await bothPosted;
      return result;
    };
    const replies = await Promise.all(['runtime fixed', 'source now retained'].map((body) => consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body }, deps,
    )));
    expect(replies.every((reply) => !('error' in reply))).toBe(true);
    expect(dispatchCalls.map((call) => call.responder)).toEqual(['resp-next']);
    expect(await stateRow(id)).toMatchObject({ state: 'active', responder_id: 'resp-next', cascade_cursor: 1, exchanges_used: 2 });
  });

  it('the exchange cap refuses a reply with the close-instead nudge; close still works AT the cap', async () => {
    const id = await seedConsult({ state: 'active', exchangesUsed: 4, maxExchanges: 4 });
    const { deps, posts } = makeDeps();
    // The cap binds NON-perspective posts (a requester follow-up here) — the
    // current responder's perspective reply is deliberately cap-exempt (D-005).
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'one more thing' },
      deps,
    );
    expect(refused).toMatchObject({ error: 'exchange_cap', exchanges_used: 4, max_exchanges: 4 });
    if ('error' in refused && refused.error === 'exchange_cap') expect(refused.hint).toContain('consult:close');
    expect(posts).toHaveLength(0);

    // The terminal move stays available — that is the point of the nudge.
    const closed = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'what we have' },
      deps,
    );
    if ('error' in closed) throw new Error(closed.error);
    expect(closed.state).toBe('closed_answered');
  });

  it('a post-seam failure passes through and writes NO meta/state', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps({ postError: 'not_found' });
    expect(
      await consultReplyCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'new_fact', body: 'b' }, deps),
    ).toEqual({ error: 'post_failed', cause: 'not_found' });
    expect(await metaRows(id)).toHaveLength(0);
    expect((await stateRow(id)).exchanges_used).toBe(0);
  });
});

describe('consultReplyCore — requester follow-up wake (budget REMOVED, consult-min-max-and-rubric-vetting D-005)', () => {
  it('wakes the answering fork rather than the transcript expert when their identities differ', async () => {
    const routing = menuSnapshot([RESPONDER, 'resp-2']);
    routing.selection.selected[0] = {
      ...routing.selection.selected[0],
      answeringOwnerId: 'resp-1-answering-fork',
    };
    const id = await seedConsult({ state: 'active', routing });
    const { deps, reached } = makeDeps();

    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'question', body: 'follow-up for the fork' },
      deps,
    );

    if ('error' in r) throw new Error(r.error);
    expect(r.wake).toMatchObject({ attempted: true, woke: 1 });
    expect(reached).toEqual([{ responder: 'resp-1-answering-fork', conversationId: id }]);
  });

  it('wakes the responder and debits the wakes_used stat', async () => {
    const ref = 'WI-V-BUDGET-1';
    const id = await seedConsult({ state: 'active', originTaskRef: ref, wakesUsed: 1 });
    const { deps, reached, emits } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'question', body: 'and what about X?' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.role).toBe('requester');
    expect(r.wake).toEqual({ attempted: true, woke: 1 }); // no budget surfaces at all
    expect(r.hint).toContain('responder wake queued; turn pickup not confirmed');
    expect(reached).toEqual([{ responder: RESPONDER, conversationId: id }]);
    expect(emits).toHaveLength(0); // requester posts never fire the park key
    expect((await stateRow(id)).wakes_used).toBe(2);
    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('question');
  });

  it.each([0, 1])('reroutes a confirmed-ended answering session with queued wake count %i', async (woke) => {
    const id = await seedConsult({ state: 'active', routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps, dispatchCalls } = makeDeps();
    deps.reach = async () => ({ woke, confirmedDead: true });
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'question', body: 'additional evidence' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.wake).toMatchObject({ attempted: true, woke, reroute: { status: 'advanced', to: 'resp-2' } });
    expect(r.cascade).toMatchObject({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect(r.hint).toContain('advanced to reviewer resp-2');
    expect(dispatchCalls.map((call) => call.responder)).toEqual(['resp-2']);
    expect(dispatchCalls[0].body).toContain('resp-1 (wake_failed)');
    const row = await stateRow(id);
    expect(row).toMatchObject({ state: 'active', responder_id: 'resp-2', cascade_cursor: 1, closed_at: null });
    expect(row.cascade_digest).toMatchObject([
      { ownerId: RESPONDER, kind: 'wake_failed' },
    ]);
  });

  it('leaves the cascade untouched when the wake count is zero but liveness is ambiguous', async () => {
    const id = await seedConsult({ state: 'active', routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps, dispatchCalls } = makeDeps();
    deps.reach = async () => ({ woke: 0 });
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'question', body: 'additional evidence' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.wake).toMatchObject({ attempted: true, woke: 0, reroute: { status: 'not_confirmed_dead', to: null } });
    expect(r.cascade).toBeUndefined();
    expect(dispatchCalls).toEqual([]);
    expect(await stateRow(id)).toMatchObject({ state: 'active', responder_id: RESPONDER, cascade_cursor: 0, closed_at: null });
  });

  it('wakes even when sibling consults on the same origin ref spent what was once the budget', async () => {
    const ref = 'WI-V-BUDGET-2';
    // Sibling consults on the same origin ref carry 4 wakes — the OLD budget
    // ceiling. Under the removed gate this follow-up would have been
    // subscription-only; now it must still wake (D-005: max_exchanges is the
    // remaining per-consult bound).
    for (let i = 0; i < 4; i++) await seedConsult({ originTaskRef: ref, wakesUsed: 1 });
    const id = await seedConsult({ state: 'active', originTaskRef: ref, wakesUsed: 0 });
    const { deps, reached } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'found another log line' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.wake).toEqual({ attempted: true, woke: 1 });
    expect(r.hint).not.toContain('exhausted');
    expect(reached).toHaveLength(1);
    expect((await stateRow(id)).wakes_used).toBe(1); // debit on the attempt — a plain stat
    expect((await stateRow(id)).exchanges_used).toBe(1);
  });
});

// ── consult:decline ──────────────────────────────────────────────────────
describe('consultDeclineCore', () => {
  const SNAPSHOT = {
    query: 'q',
    floor: 0.5,
    candidates: [
      { ownerId: RESPONDER, score: 0.8, liveness: 'live' },
      { ownerId: 'agent-next', score: 0.7, liveness: 'parked' },
      { ownerId: 'agent-dead', score: 0.65, liveness: 'ended' },
      { ownerId: 'agent-third', score: 0.6, liveness: 'live' },
    ],
  };

  it('declines: state+outcome+closed_at, decline meta, park-key emit, cascade menu (ONLY the decliner excluded)', async () => {
    const id = await seedConsult({ routing: SNAPSHOT });
    const { deps, emits, settlements } = makeDeps({ withSettlement: true });
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'my transcript covers the file, not this subsystem' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    // The DEAD candidate is on the menu, in rank order, exactly like the rest:
    // the cascade feeds the fork/convert dispatcher now, so route-time deadness
    // stopped being a reason to drop anyone (D-002 retiring D-007(7)).
    expect(r.remaining_candidates).toEqual([
      { ownerId: 'agent-next', score: 0.7, liveness: 'parked' },
      { ownerId: 'agent-dead', score: 0.65, liveness: 'ended' },
      { ownerId: 'agent-third', score: 0.6, liveness: 'live' },
    ]);
    expect(r.hint).toContain('cascade menu is exhausted'); // no selection block in the seed ⇒ terminal decline (D-005)

    const row = await stateRow(id);
    expect(row.state).toBe('declined');
    expect(row.outcome).toEqual({ reason: 'my transcript covers the file, not this subsystem' });
    expect(row.closed_at).not.toBeNull();
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });

    // A terminal decline must settle the coarse conversation projection too;
    // otherwise asker-side `state='open'` queries resurrect this dead consult.
    expect(settlements).toEqual([
      {
        conversationId: id,
        outcome: 'cant_help',
        answer: undefined,
        postId: r.post_id,
        now: NOW.toISOString(),
      },
    ]);
    const [conversation] = await rootSql`
      SELECT state, accepted_answer, accepted_post_id, resolved_at
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${WS} AND id = ${id}
    `;
    expect(conversation).toMatchObject({
      state: 'closed',
      accepted_answer: null,
      accepted_post_id: null,
      resolved_at: null,
    });

    const meta = await metaRows(id);
    expect(meta).toHaveLength(1);
    expect(meta[0].kind).toBe('decline');

    // A parked hard-blocked requester wakes on the decline too.
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
  });

  it('only the responder may decline; a blank reason is refused', async () => {
    const id = await seedConsult();
    const { deps } = makeDeps();
    expect(
      await consultDeclineCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, reason: 'r' }, deps),
    ).toEqual({ error: 'not_the_responder' });
    expect(
      await consultDeclineCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: '   ' }, deps),
    ).toEqual({ error: 'reason_required' });
  });

  it('an empty/absent snapshot yields an empty cascade menu, honestly', async () => {
    const id = await seedConsult({ routing: {} });
    const { deps } = makeDeps();
    const r = await consultDeclineCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'nope' }, deps);
    if ('error' in r) throw new Error(r.error);
    expect(r.remaining_candidates).toEqual([]);
    expect(r.hint).toContain('own judgment');
  });
});

// ── consult:close ────────────────────────────────────────────────────────
describe('consultCloseCore', () => {
  it('answered: structured outcome {answer, confidence, evidence}, closed_answered, close meta, responder emit', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits, posts, settlements } = makeDeps({ withSettlement: true });
    const r = await consultCloseCore(
      {
        workspaceId: WS,
        authorId: RESPONDER,
        conversationId: id,
        outcome: 'answered',
        answer: 'the pool starves under POLLING',
        confidence: 0.8,
        evidence: EVIDENCE,
      },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('closed_answered');

    const row = await stateRow(id);
    expect(row.state).toBe('closed_answered');
    expect(row.outcome).toEqual({ answer: 'the pool starves under POLLING', confidence: 0.8, evidence: EVIDENCE });
    expect(row.closed_at).not.toBeNull();
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });

    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('close');
    expect(meta[0].evidence).toEqual(EVIDENCE);
    expect(await evidenceJsonbType(id)).toBe('array');

    // The terminal post is still written exactly once, and the coarse
    // conversations:get projection receives the same answer/post/time rather
    // than requiring a second terminal post or a caller-side repair.
    expect(posts).toHaveLength(1);
    expect(settlements).toEqual([
      {
        conversationId: id,
        outcome: 'answered',
        answer: 'the pool starves under POLLING',
        postId: r.post_id,
        now: NOW.toISOString(),
      },
    ]);

    const [conversation] = await rootSql`
      SELECT state, accepted_answer, accepted_post_id, resolved_at
        FROM harness_shared.coord_conversations
       WHERE workspace_id = ${WS} AND id = ${id}
    `;
    expect(conversation).toMatchObject({
      state: 'resolved',
      accepted_answer: 'the pool starves under POLLING',
      accepted_post_id: String(r.post_id),
    });

    expect(emits.map((event) => event.key)).toEqual([
      `consult:reply:${id}`, `consult:answer-posted:${id}`, `consult:closed:${id}`,
    ]);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
  });

  it('does not publish a close or answer when the close transaction rolls back', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits } = makeDeps();
    deps.settleConversation = async () => { throw new Error('projection failed'); };
    await expect(consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id,
      outcome: 'answered', answer: 'an answer', evidence: EVIDENCE }, deps)).rejects.toThrow('projection failed');
    expect((await stateRow(id)).state).toBe('active');
    expect(await metaRows(id)).toEqual([]);
    expect(emits).toEqual([]);
  });

  it('serializes terminal close behind the final consult spawn boundary', async () => {
    const id = await seedConsult({ state: 'active' });
    const spawnSql = postgres(fixtureDb.url, { max: 4, onnotice: () => {} });
    let lease: Awaited<ReturnType<typeof acquireConsultSpawnLease>> = null;
    let closing: Promise<unknown> | null = null;
    try {
      lease = await acquireConsultSpawnLease(WS, id, spawnSql);
      expect(lease).not.toBeNull();
      if (!lease) throw new Error('active consult should have granted a spawn lease');

      const { deps } = makeDeps();
      deps.getSql = () => spawnSql;
      const originalPost = deps.post;
      let resolvePost!: () => void;
      const postWritten = new Promise<void>((resolve) => { resolvePost = resolve; });
      deps.post = async (input) => {
        const result = await originalPost(input);
        resolvePost();
        return result;
      };
      let closeSettled = false;
      const closePromise = consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id,
        outcome: 'cant_help', reason: 'fixture terminal close' }, deps).finally(() => { closeSettled = true; });
      closing = closePromise;
      await postWritten;

      const deadline = Date.now() + 2_000;
      let lockWaitSeen = false;
      while (!lockWaitSeen && Date.now() < deadline) {
        const rows = await spawnSql<Array<{ count: number }>>`
          SELECT count(*)::int AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%consult_state%'
        `;
        lockWaitSeen = Number(rows[0]?.count ?? 0) > 0;
        if (!lockWaitSeen) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockWaitSeen).toBe(true);
      expect(closeSettled).toBe(false);

      // This is the same ordering as console-spawn's afterSpawn callback.
      await lease.release();
      lease = null;
      await expect(closePromise).resolves.toMatchObject({ ok: true, state: 'closed_cant_help' });
      expect((await stateRow(id)).state).toBe('closed_cant_help');
      expect(await acquireConsultSpawnLease(WS, id, spawnSql)).toBeNull();
    } finally {
      await lease?.release();
      if (closing) await closing.catch(() => undefined);
      await spawnSql.end({ timeout: 5 });
    }
  });

  it('does not count a requester answer disposition as a responder critique', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits } = makeDeps();
    expect(await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id,
      outcome: 'answered', answer: 'resolved independently', evidence: EVIDENCE }, deps))
      .toMatchObject({ ok: true, state: 'closed_answered' });
    expect(emits.map((event) => event.key)).toEqual([`consult:closed:${id}`]);
    expect(emits[0]).toMatchObject({ to: [], payload: { state: 'closed_answered', closed_by: REQUESTER } });
  });

  it("cant_help requires the reason; answered requires the answer — outcome validation refuses incomplete closes", async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts } = makeDeps();
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered' }, deps),
    ).toEqual({ error: 'answer_required' });
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'cant_help' }, deps),
    ).toEqual({ error: 'reason_required' });
    expect(posts).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it("the requester may close (cant_help path) — no park-key emit for their own close", async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits } = makeDeps();
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'cant_help', reason: 'answered it myself meanwhile' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('closed_cant_help');
    expect((await stateRow(id)).outcome).toEqual({ reason: 'answered it myself meanwhile' });
    expect(emits.map((event) => event.key)).toEqual([`consult:closed:${id}`]);
  });

  it('a closed consult refuses a second close', async () => {
    const id = await seedConsult({ state: 'closed_cant_help' });
    const { deps } = makeDeps();
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'a' }, deps),
    ).toMatchObject({ error: 'consult_not_open', state: 'closed_cant_help' });
  });

  it.each(['no_qualified_responder', 'no_launchable_responder'])('requester can retire an undelivered %s consult without dispatching another reviewer', async (state) => {
    const id = await seedConsult({ state, responderId: null, routing: menuSnapshot([RESPONDER, 'resp-next']) });
    const { deps, posts, emits, dispatchCalls, settlements } = makeDeps({ withSettlement: true });
    const reason = 'The saved reviewer menu is exhausted without a critique.';
    expect(await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'cant_help' }, deps))
      .toEqual({ error: 'reason_required' });
    const result = await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'cant_help', reason }, deps);
    expect(result).toMatchObject({ ok: true, state: 'closed_cant_help' });
    const row = await stateRow(id);
    expect(row).toMatchObject({ state: 'closed_cant_help', outcome: { reason }, responder_id: null });
    expect(row.closed_at).not.toBeNull();
    const [conversation] = await rootSql`
      SELECT state, accepted_answer FROM harness_shared.coord_conversations
       WHERE workspace_id = ${WS} AND id = ${id}`;
    expect(conversation).toMatchObject({ state: 'closed', accepted_answer: null });
    expect(posts).toHaveLength(1);
    expect(settlements).toHaveLength(1);
    expect(dispatchCalls).toEqual([]);
    expect(emits.map((event) => event.key)).toEqual([`consult:closed:${id}`]);
    expect(await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'cant_help', reason }, deps))
      .toMatchObject({ error: 'consult_not_open', state: 'closed_cant_help' });
    expect(posts).toHaveLength(1);
  });

  it.each(['no_qualified_responder', 'no_launchable_responder'])('undelivered %s disposition stays requester-only and cannot manufacture an answer', async (state) => {
    const id = await seedConsult({ state, responderId: null, routing: menuSnapshot([RESPONDER]) });
    const { deps, posts, dispatchCalls } = makeDeps({ withMint: true });
    for (const authorId of [RESPONDER, 'unassigned']) {
      expect(await consultCloseCore({ workspaceId: WS, authorId, conversationId: id, outcome: 'cant_help', reason: 'foreign' }, deps))
        .toMatchObject({ error: 'consult_not_open', state });
    }
    for (const outcome of ['answered', 'graduate'] as const) {
      expect(await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome, answer: 'unreviewed', reason: 'unreviewed' }, deps))
        .toMatchObject({ error: 'consult_not_open', state });
    }
    const assigned = await seedConsult({ state, responderId: RESPONDER });
    expect(await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: assigned, outcome: 'cant_help', reason: 'still assigned' }, deps))
      .toMatchObject({ error: 'consult_not_open', state });
    await rootSql`UPDATE harness_shared.consult_state SET closed_at = ${NOW.toISOString()}::timestamptz
      WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    expect(await consultCloseCore({ workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'cant_help', reason: 'already closed' }, deps))
      .toMatchObject({ error: 'consult_not_open', state });
    expect(posts).toEqual([]);
    expect(dispatchCalls).toEqual([]);
  });

  it('rolls back consult_state and close metadata when coarse settlement fails', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps } = makeDeps({ withSettlement: true, settlementError: 'coarse projection unavailable' });
    await expect(
      consultCloseCore(
        { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'rollback me' },
        deps,
      ),
    ).rejects.toThrow('coarse projection unavailable');

    expect((await stateRow(id)).state).toBe('active');
    expect(await metaRows(id)).toHaveLength(0);
    expect(
      await rootSql`
        SELECT state, accepted_answer, accepted_post_id, resolved_at
          FROM harness_shared.coord_conversations
         WHERE workspace_id = ${WS} AND id = ${id}
      `,
    ).toMatchObject([{ state: 'open', accepted_answer: null, accepted_post_id: null, resolved_at: null }]);
  });
});

// ── consult:close outcome 'graduate' (P-005, D-004) ──────────────────────
describe('consultCloseCore — graduate', () => {
  it('responder graduate: mints the shared work item, state=graduated, outcome {reason, work_item_id}, park-key emit', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits, minted, posts } = makeDeps({ withMint: true });
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate', reason: 'cap hit while still deliberating' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('graduated');
    expect(r.work_item_id).toBe('WI-GRAD-1');
    expect(r.hint).toContain('WI-GRAD-1');

    // The mint saw the consult's question + both participants + the closer.
    expect(minted).toEqual([
      {
        workspaceId: WS,
        conversationId: id,
        question: 'q',
        requesterId: REQUESTER,
        responderId: RESPONDER,
        closedBy: RESPONDER,
        reason: 'cap hit while still deliberating',
      },
    ]);

    // The closing post names the minted work item; its meta stays kind='close'
    // ('graduate' is a close OUTCOME, not a post kind — the enum is untouched).
    expect(posts[0].body).toContain('WI-GRAD-1');
    const meta = await metaRows(id);
    expect(meta[0].kind).toBe('close');

    // State row: 'graduated' under the migration's state CHECK, outcome carries the id.
    const row = await stateRow(id);
    expect(row.state).toBe('graduated');
    expect(row.outcome).toEqual({ reason: 'cap hit while still deliberating', work_item_id: 'WI-GRAD-1' });
    expect(row.closed_at).not.toBeNull();

    // A responder graduate is the terminal reply — the parked requester is woken.
    expect(emits.map((event) => event.key)).toEqual([`consult:reply:${id}`, `consult:closed:${id}`]);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
  });

  it('the requester may graduate too (close symmetry) — no park-key emit for their own close', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, emits, minted } = makeDeps({ withMint: true });
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'graduate', reason: 'outgrew the consult' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('graduated');
    expect(minted[0].closedBy).toBe(REQUESTER);
    expect(emits.map((event) => event.key)).toEqual([`consult:closed:${id}`]);
  });

  it('graduate requires the reason — refused with nothing written', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts, minted } = makeDeps({ withMint: true });
    expect(
      await consultCloseCore({ workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate' }, deps),
    ).toEqual({ error: 'reason_required' });
    expect(posts).toHaveLength(0);
    expect(minted).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it('graduate without a bound mint seam is refused structurally (graduate_unavailable), nothing written', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts } = makeDeps(); // no withMint
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate', reason: 'r' },
      deps,
    );
    expect(r).toMatchObject({ error: 'graduate_unavailable' });
    expect(posts).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it('a mint failure is a clean refusal (graduate_failed) — consult stays open, no post', async () => {
    const id = await seedConsult({ state: 'active' });
    const { deps, posts } = makeDeps({ mintError: 'work-items store down' });
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'graduate', reason: 'r' },
      deps,
    );
    expect(r).toEqual({ error: 'graduate_failed', cause: 'work-items store down' });
    expect(posts).toHaveLength(0);
    expect((await stateRow(id)).state).toBe('active');
  });

  it('the cap-hit reply refusal names the graduate option (D-004 canonical trigger)', async () => {
    const id = await seedConsult({ state: 'active', exchangesUsed: 4, maxExchanges: 4 });
    const { deps } = makeDeps();
    // Cap-bound post = a NON-perspective one (requester follow-up; D-005
    // exempts the current responder's perspective reply).
    const refused = await consultReplyCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, kind: 'new_fact', body: 'one more thing' },
      deps,
    );
    expect(refused).toMatchObject({ error: 'exchange_cap' });
    if ('error' in refused && refused.error === 'exchange_cap') {
      expect(refused.hint).toContain("outcome: 'graduate'");
    }
  });
});

// ── D-005/P-013 always-advance cascade (consult-min-max-and-rubric-vetting) ─

/** A routing snapshot with a real selection menu (the 844 cascade drives off
 * selection.selected) plus route-time candidates for remaining_candidates.
 *
 * ⚠ DELIBERATELY PRE-D-001 SHAPED — do NOT "complete" it by adding `relevance`.
 * consult_state.routing is a persisted column, so the cascade reads rows written
 * before the two-stage router existed and its TypeScript type is a claim about
 * what we WRITE, not a guarantee about what is stored. This fixture is the only
 * thing that catches an unguarded `entry.relevance.toFixed(2)` in the wake copy
 * — which is exactly how that bug reached a suite once already. */
function menuSnapshot(owners: string[]) {
  return {
    candidates: owners.map((o, i) => ({ ownerId: o, score: 0.9 - i * 0.1, liveness: 'live' })),
    selection: {
      selected: owners.map((o, i): {
        ownerId: string;
        via: 'floor';
        score: number;
        similarity: number;
        liveness: string;
        /** Set by tests whose answering fork differs from the routed expert. */
        answeringOwnerId?: string;
      } => ({
        ownerId: o,
        via: 'floor' as const,
        score: 0.9 - i * 0.1,
        similarity: 0.8 - i * 0.1,
        liveness: 'live',
      })),
    },
  };
}

describe('cascade advance (D-005/P-013)', () => {
  it('a perspective reply ADVANCES the chain: cursor+responder move, digest carries the reply, next selectee DISPATCHED with the feedback so far', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']) });
    const { deps, reachCalls, dispatchCalls } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.cascade).toEqual({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect(r.hint).toContain('Cascade advanced');

    const row = await stateRow(id);
    expect(row.state).toBe('active'); // reply-triggered advance keeps the consult engaged
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
    expect(row.expires_at).not.toBeNull(); // fresh latency window for the next selectee
    const digest = row.cascade_digest as Array<{ ownerId: string; kind: string; excerpt: string }>;
    expect((await jsonbShapes(id)).cascade_digest_type).toBe('array');
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ ownerId: RESPONDER, kind: 'answer', excerpt: 'the answer' });

    // The next selectee's dispatch body: position, question, and the digest line.
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].responder).toBe('resp-2');
    expect(dispatchCalls[0].body).toContain('reviewer 2/3');
    expect(dispatchCalls[0].body).toContain('QUESTION: q');
    expect(dispatchCalls[0].body).toContain(`- ${RESPONDER} (answer): the answer`);
    // R-11/D-011: an ADVANCE dispatches and notifies NOBODY. `reach` is bound
    // here, so a binding that slipped back to the wake seam would record a call.
    expect(reachCalls).toEqual([]);
    // …and the launched session's identity is persisted, or its first reply is
    // refused not_a_participant (the fork answers under a new coord id).
    const advancedRouting = (await stateRow(id)).routing as {
      selection?: { selected?: Array<Record<string, unknown>> };
    };
    expect(advancedRouting.selection?.selected?.[1]).toMatchObject({
      ownerId: 'resp-2',
      answeringOwnerId: 'resp-2-fork',
    });
  });

  it('a previously woken responder remains a participant and may close after advancing the cascade', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps } = makeDeps();
    const stopped: Parameters<NonNullable<ConsultVerbDeps['stopAnsweringSession']>>[0][] = [];
    deps.stopAnsweringSession = async (target) => {
      stopped.push(target);
      return 'stopped task resp-2-fork';
    };

    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in reply) throw new Error(reply.error);
    expect((await stateRow(id)).responder_id).toBe('resp-2');

    const close = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'answered', answer: 'settled' },
      deps,
    );
    if ('error' in close) throw new Error(close.error);
    expect(close.state).toBe('closed_answered');
    expect((await stateRow(id)).state).toBe('closed_answered');
    expect(stopped).toEqual([{
      workspaceId: WS,
      conversationId: id,
      answeringOwnerId: 'resp-2-fork',
      sourceOwnerId: 'resp-2',
    }]);
  });

  it("does not stop the current responder's session when it closes its own consult", async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps } = makeDeps();
    const stopped: Parameters<NonNullable<ConsultVerbDeps['stopAnsweringSession']>>[0][] = [];
    deps.stopAnsweringSession = async (target) => {
      stopped.push(target);
      return 'stopped task resp-2-fork';
    };

    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'the answer', evidence: EVIDENCE },
      deps,
    );
    if ('error' in reply) throw new Error(reply.error);

    const close = await consultCloseCore(
      { workspaceId: WS, authorId: 'resp-2-fork', conversationId: id, outcome: 'answered', answer: 'settled' },
      deps,
    );
    if ('error' in close) throw new Error(close.error);
    expect(close.state).toBe('closed_answered');
    expect((await stateRow(id)).state).toBe('closed_answered');
    expect(stopped).toEqual([]);
  });

  // WI-1700133: the VOID-consult exit. A responder who judges the QUESTION
  // void (duplicate, inadmissible, already settled) must be able to end the
  // consult WITHOUT spending the next selectee — every other responder verb
  // advances (reply of any kind, decline, expiry), and for an acceptance
  // grading cascade each advance PERMANENTLY disqualifies that grader under
  // D-009 independence. The filed item asserted this exit was unreachable
  // through the tool surface. It is not: close is non-advancing for the
  // CURRENT responder, mid-menu, with no prior reply. This pins the property
  // the guidance now routes to, so a later refactor cannot quietly make
  // close advance and re-open the grader-burn.
  it('the CURRENT responder may close a VOID consult mid-menu: terminal, cursor unmoved, NO next selectee dispatched, requester signalled (WI-1700133)', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']) });
    // BOTH seams are bound — either a wake or a dispatch would be recorded.
    const { deps, reachCalls, dispatchCalls, emits } = makeDeps();

    const close = await consultCloseCore(
      {
        workspaceId: WS,
        authorId: RESPONDER,
        conversationId: id,
        outcome: 'cant_help',
        reason: 'the question is void — the subject rubric already carries a complete independent card',
      },
      deps,
    );
    if ('error' in close) throw new Error(close.error);
    expect(close.state).toBe('closed_cant_help');

    // The cascade did NOT advance: no selectee after this one was reached or
    // dispatched, and the cursor/responder never moved off the closer.
    expect(reachCalls).toEqual([]);
    expect(dispatchCalls).toEqual([]);
    const row = await stateRow(id);
    expect(row.state).toBe('closed_cant_help');
    expect(row.responder_id).toBe(RESPONDER);
    expect(row.cascade_cursor).toBe(0);

    // …and the requester IS woken, via the latched park key — the disposition
    // reaches the one agent who can act on a void consult.
    expect(emits.map((event) => event.key)).toEqual([`consult:reply:${id}`, `consult:closed:${id}`]);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
  });

  it('hard-blocked: the FIRST reply fires the park key while the chain continues behind it (D-007)', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps, emits } = makeDeps();
    const r = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'a1', evidence: EVIDENCE },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    // The parked requester is woken by the FIRST responder post…
    expect(emits.map((event) => event.key)).toEqual([`consult:reply:${id}`, `consult:answer-posted:${id}`]);
    expect(emits[0].key).toBe(`consult:reply:${id}`);
    expect(emits[0].to).toEqual([REQUESTER]);
    // …AND the cascade still advanced behind them.
    expect(r.cascade).toEqual({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect((await stateRow(id)).responder_id).toBe('resp-2');
  });

  it('a mid-chain decline ADVANCES instead of closing — no park-key emit, digest records the decline', async () => {
    const id = await seedConsult({ state: 'active', routing: menuSnapshot([RESPONDER, 'resp-2']) });
    const { deps, emits, dispatchCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder');
    expect(r.cascade).toEqual({ advanced_to: 'resp-2', exhausted: false, woke: 1 });
    expect(emits).toHaveLength(0); // mid-chain: more feedback is coming — the parked requester sleeps on

    const row = await stateRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(row.responder_id).toBe('resp-2');
    const digest = row.cascade_digest as Array<{ ownerId: string; kind: string }>;
    expect((await jsonbShapes(id)).cascade_digest_type).toBe('array');
    expect(digest).toMatchObject([{ ownerId: RESPONDER, kind: 'decline' }]);
    expect(dispatchCalls[0].body).toContain(`- ${RESPONDER} (decline): not my area`);
  });

  it('advanceCascade is CAS-guarded: a stale-cursor second call is a raced no-op (no duplicate wake, no duplicate digest)', async () => {
    const id = await seedConsult({ routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']) });
    const wakes: string[] = [];
    const reach = async (o: { responder: string }) => {
      wakes.push(o.responder);
      return { woke: 1 };
    };
    const params = {
      workspaceId: WS,
      conversationId: id,
      question: 'q',
      latencyContract: 'proceed',
      routing: menuSnapshot([RESPONDER, 'resp-2', 'resp-3']),
      cascadeCursor: 0,
      digest: [],
      event: makeDigestEntry(RESPONDER, 'decline' as const, NOW.toISOString(), 'x'),
      stateOnAdvance: 'awaiting_responder' as const,
      nowIso: NOW.toISOString(),
    };
    const first = await advanceCascade(params, rootSql, reach);
    expect(first).toMatchObject({ advanced: true, raced: false, next: { ownerId: 'resp-2' } });
    const second = await advanceCascade(params, rootSql, reach); // same stale cursor 0
    expect(second).toMatchObject({ advanced: false, exhausted: false, raced: true, woke: 0 });
    expect(wakes).toEqual(['resp-2']); // exactly one wake
    const digest = (await stateRow(id)).cascade_digest as unknown[];
    expect(digest).toHaveLength(1); // the raced call appended nothing
  });
});

// EI-24351703367365896: a refused launch must not buy an empty seat a new TTL.
describe.each(['selected', 'refill'] as const)('failed cascade dispatch — %s menu', (menu) => {
  function routingFor(others: string[]) {
    const snap = menuSnapshot([RESPONDER, ...others]);
    return menu === 'selected' ? snap : {
      ...snap,
      selection: { min: others.length, selected: snap.selection.selected.slice(0, 1) },
    };
  }

  it('skips a refused launch and delivers the decline plus failure digest to the next expert', async () => {
    const id = await seedConsult({ routing: routingFor(['unlaunchable', 'available']) });
    const { deps, dispatchCalls, emits } = makeDeps();
    deps.dispatch = async (o) => {
      dispatchCalls.push(o);
      return o.responder === 'unlaunchable'
        ? { woke: 0 }
        : { woke: 1, answeringOwnerId: 'available-fork' };
    };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'conflict of interest' }, deps,
    );
    expect(r).toMatchObject({ cascade: { advanced_to: 'available', exhausted: false, woke: 1 } });
    expect(dispatchCalls.map((o) => o.responder)).toEqual(['unlaunchable', 'available']);
    expect(dispatchCalls[1].body).toContain('unlaunchable (dispatch_failed)');
    const row = await stateRow(id);
    expect(row).toMatchObject({ responder_id: 'available', cascade_cursor: 2, closed_at: null });
    expect(row.cascade_digest).toMatchObject([
      { ownerId: RESPONDER, kind: 'decline' }, { ownerId: 'unlaunchable', kind: 'dispatch_failed' },
    ]);
    expect(emits).toEqual([]);
  });

  it('treats a zero-row answering-owner stamp as a refused launch and advances', async () => {
    const id = await seedConsult({ routing: routingFor(['unstampable', 'available']) });
    const { deps, dispatchCalls, emits } = makeDeps();
    deps.dispatch = async (o) => {
      dispatchCalls.push(o);
      if (o.responder === 'unstampable') {
        // Remove the selected slot after the cursor advances so the stamp's
        // guarded UPDATE affects zero rows instead of throwing a SQL error.
        await rootSql`
          UPDATE harness_shared.consult_state
             SET routing = routing #- ARRAY['selection', 'selected', '1', 'ownerId']
           WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
        try {
          await o.onAnsweringOwner?.('unstampable-fork');
        } catch {
          return { woke: 0 };
        }
        return { woke: 1, answeringOwnerId: 'unstampable-fork' };
      }
      await o.onAnsweringOwner?.('available-fork');
      return { woke: 1, answeringOwnerId: 'available-fork' };
    };

    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'conflict of interest' }, deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.cascade).toMatchObject({ advanced_to: 'available', exhausted: false, woke: 1 });
    expect(dispatchCalls.map((o) => o.responder)).toEqual(['unstampable', 'available']);
    expect(dispatchCalls[1].body).toContain('unstampable (dispatch_failed)');
    expect(await stateRow(id)).toMatchObject({ responder_id: 'available', cascade_cursor: 2, closed_at: null });
    expect(emits).toEqual([]);
  });

  it('exhausts refused launches and closes honestly without waiting for another expiry', async () => {
    const id = await seedConsult({ routing: routingFor(['unlaunchable', 'also-unlaunchable']) });
    const { deps, dispatchCalls, emits } = makeDeps();
    deps.dispatch = async (o) => { dispatchCalls.push(o); return { woke: 0 }; };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'conflict of interest' }, deps,
    );
    expect(r).toMatchObject({ state: 'declined', cascade: { exhausted: true } });
    expect(dispatchCalls.map((o) => o.responder)).toEqual(['unlaunchable', 'also-unlaunchable']);
    const row = await stateRow(id);
    expect(row.closed_at).not.toBeNull();
    expect(row.cascade_digest).toMatchObject([
      { ownerId: RESPONDER, kind: 'decline' },
      { ownerId: 'unlaunchable', kind: 'dispatch_failed' },
      { ownerId: 'also-unlaunchable', kind: 'dispatch_failed' },
    ]);
    if (menu === 'refill') {
      // WI-10005360: every refill pick was refused BEFORE launch, so the round is
      // not spent — the cascade ran out because the POOL did. That is the honest label.
      expect(row.routing).toMatchObject({ selection: { underFilled: { answers: 0, min: 2, reason: 'no-untried-candidate' } } });
    }
    expect(emits).toHaveLength(1);
  });

  it.each(['return', 'early stamp'] as const)(
    'retains a booting answering session when the dispatcher returns its identity (%s path)',
    async (identity) => {
      const id = await seedConsult({ routing: routingFor(['booting', 'unused']) });
      const { deps, dispatchCalls } = makeDeps();
      deps.dispatch = async (o) => {
        dispatchCalls.push(o);
        if (identity === 'early stamp') await o.onAnsweringOwner?.('booting-fork');
        return { woke: 0, answeringOwnerId: 'booting-fork' };
      };
      const r = await consultDeclineCore(
        { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'conflict' }, deps,
      );
      expect(r).toMatchObject({ cascade: { advanced_to: 'booting', exhausted: false, woke: 0 } });
      expect(dispatchCalls).toHaveLength(1);
      const row = await stateRow(id);
      expect(row).toMatchObject({ responder_id: 'booting', cascade_cursor: 1, closed_at: null });
      expect((row.routing as { selection: { selected: Array<{ answeringOwnerId?: string }> } }).selection.selected[1])
        .toMatchObject({ answeringOwnerId: 'booting-fork' });
      expect(row.cascade_digest).toHaveLength(1);
    },
  );

  it.each(['cursor', 'expiry'] as const)('preserves concurrent %s progress instead of dispatching or terminal-closing over it', async (race) => {
    const id = await seedConsult({ routing: routingFor(['unlaunchable', 'concurrent-winner']) });
    const { deps, dispatchCalls, emits } = makeDeps();
    const refreshedExpiry = new Date(NOW.getTime() + 86_400_000);
    deps.dispatch = async (o) => {
      dispatchCalls.push(o);
      if (race === 'cursor') {
        await rootSql`UPDATE harness_shared.consult_state SET cascade_cursor = 2,
          responder_id = 'concurrent-winner' WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
      } else {
        await rootSql`UPDATE harness_shared.consult_state SET expires_at = ${refreshedExpiry.toISOString()}::timestamptz
          WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
      }
      return { woke: 0 };
    };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'conflict' }, deps,
    );
    expect(r).toMatchObject({ cascade: { advanced_to: null, exhausted: false, woke: 0 } });
    expect(dispatchCalls).toHaveLength(1);
    const row = await stateRow(id);
    expect(row.closed_at).toBeNull();
    expect(row.cascade_digest).toHaveLength(1);
    if (race === 'cursor') expect(row.responder_id).toBe('concurrent-winner');
    else expect(new Date(row.expires_at as string).getTime()).toBe(refreshedExpiry.getTime());
    expect(emits).toEqual([]);
  });
});

// ── WI-39862 honest expiry (late disposition) + WI-39861 refill via decline ──
describe('consultCloseCore — late disposition on an expired consult (WI-39862 / EI-20824019943814803)', () => {
  async function seedExpired(opts: { digest?: unknown[]; outcome?: unknown } = {}): Promise<string> {
    const id = await seedConsult({ state: 'expired' });
    await rootSql`
      UPDATE harness_shared.consult_state
         SET closed_at = ${NOW.toISOString()}::timestamptz,
             cascade_digest = ${rootSql.json((opts.digest ?? []) as never)},
             outcome = ${opts.outcome ? rootSql.json(opts.outcome as never) : null}
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    return id;
  }

  it('the REQUESTER may close an expired consult — the late disposition overwrites state + outcome (archive candidacy regained)', async () => {
    const id = await seedExpired({
      digest: [{ ownerId: 'rev-1', kind: 'answer', at: NOW.toISOString(), excerpt: 'ans' }],
      outcome: { disposition: 'cascade_exhausted_with_answers', answers: 1, answered_by: ['rev-1'] },
    });
    const { deps, posts } = makeDeps();
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: REQUESTER, conversationId: id, outcome: 'answered', answer: 'the settled answer', confidence: 0.8 },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('closed_answered');
    expect(posts).toHaveLength(1);
    const row = await stateRow(id);
    expect(row.state).toBe('closed_answered');
    const outcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome as string) : row.outcome;
    expect(outcome).toMatchObject({ answer: 'the settled answer', confidence: 0.8 });
    expect(row.closed_at).not.toBeNull();
  });

  it('a NON-requester (even the last responder) still cannot close an expired consult', async () => {
    const id = await seedExpired();
    const { deps } = makeDeps();
    const r = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, outcome: 'cant_help', reason: 'late' },
      deps,
    );
    expect(r).toMatchObject({ error: 'consult_not_open', state: 'expired' });
  });

  it('reply and decline on an expired consult stay refused — the hint names the requester late-close path', async () => {
    const id = await seedExpired();
    const { deps } = makeDeps();
    const reply = await consultReplyCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, kind: 'answer', body: 'late', evidence: EVIDENCE },
      deps,
    );
    expect(reply).toMatchObject({ error: 'consult_not_open', state: 'expired' });
    expect((reply as { hint?: string }).hint).toContain('consult:close');
    const decline = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'late' },
      deps,
    );
    expect(decline).toMatchObject({ error: 'consult_not_open', state: 'expired' });
  });
});

describe('consultDeclineCore — exhaustion honesty + min-ANSWERS refill (WI-39862 / WI-39861)', () => {
  it('a decline-exhaustion terminal that collected answers says so on the outcome', async () => {
    // Menu [ans-r, RESPONDER], cursor 1 (RESPONDER current), digest holds ans-r's answer.
    const id = await seedConsult({ state: 'active', routing: menuSnapshot(['ans-r', RESPONDER]) });
    await rootSql`
      UPDATE harness_shared.consult_state
         SET cascade_cursor = 1,
             cascade_digest = ${rootSql.json([{ ownerId: 'ans-r', kind: 'answer', at: NOW.toISOString(), excerpt: 'real answer' }] as never)}
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    const { deps } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'cannot add more' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    expect(r.cascade.exhausted).toBe(true);
    const row = await stateRow(id);
    const outcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome as string) : row.outcome;
    expect(outcome).toMatchObject({ reason: 'cannot add more', answers: 1, answered_by: ['ans-r'] });
    expect(await jsonbShapes(id)).toEqual({ routing_type: 'object', outcome_type: 'object', cascade_digest_type: 'array' });
  });

  it('a decline that exhausts BELOW min triggers the refill round (trigger-independence with the expiry path)', async () => {
    const routing = {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      candidates: [
        { ownerId: RESPONDER, score: 0.9, relevance: 0.9, signals: { similarity: 0.8 }, liveness: 'live' },
        { ownerId: 'w-b', score: 0.6, relevance: 0.6, signals: { similarity: 0.5 }, liveness: 'live' },
      ],
      selection: {
        min: 1,
        max: 1,
        selected: [{ ownerId: RESPONDER, via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' }],
      },
    };
    const id = await seedConsult({ state: 'active', routing });
    const { deps, dispatchCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder');
    expect(r.cascade).toMatchObject({ advanced_to: 'w-b', exhausted: false, refilled: true });
    expect(r.hint).toContain('min-ANSWERS refill');
    const row = await stateRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('w-b');
    expect(row.closed_at).toBeNull();
    const routingRow = (typeof row.routing === 'string' ? JSON.parse(row.routing as string) : row.routing) as {
      selection?: { selected?: Array<Record<string, unknown>>; refill?: { added?: string[] } };
    };
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'w-b', refill: true });
    expect(routingRow.selection?.refill?.added).toEqual(['w-b']);
    expect(dispatchCalls.at(-1)?.responder).toBe('w-b');
  });
});

// ── D-002/D-004: the refill is LIVENESS-BLIND, and under-filled stays honest ──
//
// These are the EI-20864690354207496 probes, rewritten for the model that
// replaced the revival leg. The original drove a consult to refill exhaustion
// with ONLY dead untried candidates and asserted a DISJUNCTION: either a dead
// above-floor candidate is revived within the per-consult budget, XOR the
// terminal state says why the min stays unfilled. Dispatch collapsed the first
// branch into the ordinary one — a dead candidate is refilled and dispatched
// like any other (R-2) — so what is pinned now is that deadness changes
// NOTHING, and that the remaining ways to run out are still labeled rather than
// silent. Silence is still the one outcome these pin out.
describe('advanceCascade — liveness-blind refill + honest under-filled (D-002/D-004)', () => {
  type ParsedRouting = {
    selection?: {
      selected?: Array<Record<string, unknown>>;
      refill?: { added?: string[] };
      underFilled?: Record<string, unknown>;
    };
  };
  const parseRouting = (raw: unknown): ParsedRouting =>
    (typeof raw === 'string' ? JSON.parse(raw) : raw) as ParsedRouting;

  /** min:1 snapshot whose untried pool holds ONLY a dead candidate. The dead
   * candidate clears both floors unless lowScore drops it below them;
   * `noUntried` empties the pool entirely, and `refillSpent` stamps the one
   * bounded round as already used. */
  function deadPoolRouting(opts: { lowScore?: boolean; noUntried?: boolean; refillSpent?: boolean } = {}) {
    const self = { ownerId: RESPONDER, score: 0.9, relevance: 0.9, signals: { similarity: 0.8 }, liveness: 'live' };
    const dead = opts.lowScore
      ? { ownerId: 'dead-low', score: 0.2, relevance: 0.2, signals: { similarity: 0.1 }, liveness: 'ended' }
      : { ownerId: 'dead-x', score: 0.7, relevance: 0.7, signals: { similarity: 0.6 }, liveness: 'ended' };
    return {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      candidates: opts.noUntried ? [self] : [self, dead],
      selection: {
        min: 1,
        max: 1,
        selected: [{ ownerId: RESPONDER, via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' }],
        ...(opts.refillSpent
          ? { refill: { at: NOW.toISOString(), added: [], reason: 'the one bounded round already ran' } }
          : {}),
      },
    };
  }

  it('driven through consult:decline — exhaustion below min with only a DEAD untried candidate refills and DISPATCHES them exactly like a live one (R-2)', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps, reachCalls, dispatchCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder'); // NOT terminal — the refill filled the slot
    expect(r.cascade).toMatchObject({ advanced_to: 'dead-x', exhausted: false, refilled: true });
    const row = await stateRow(id);
    expect(row.responder_id).toBe('dead-x');
    expect(row.closed_at).toBeNull();
    const routingRow = parseRouting(row.routing);
    // An ORDINARY refill entry — no `revived` stamp, no reservation, and the
    // route-time liveness carried verbatim as provenance rather than as a gate.
    expect(routingRow.selection?.selected?.[1]).toMatchObject({
      ownerId: 'dead-x',
      via: 'floor',
      refill: true,
      liveness: 'ended',
    });
    expect(routingRow.selection?.selected?.[1]?.revived).toBeUndefined();
    expect(routingRow.selection?.underFilled).toBeUndefined();
    // Delivered by DISPATCH, and nothing was woken (R-11) — a dead expert has
    // no session to wake, which is precisely why this used to need a revival.
    expect(dispatchCalls.at(-1)?.responder).toBe('dead-x');
    expect(reachCalls).toEqual([]);
  });

  it('the answering session may reply DURING dispatch: the early identity stamp makes its first turn a participant', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps } = makeDeps();
    let firstTurn: Awaited<ReturnType<typeof consultReplyCore>> | undefined;
    // Production's dispatcher announces the answering identity BEFORE its
    // verification wait, and the launched session can post during that wait.
    // Replying from inside the hook reproduces exactly that window.
    deps.dispatch = async (o) => {
      await o.onAnsweringOwner?.('dead-x-fork');
      firstTurn = await consultReplyCore(
        {
          workspaceId: WS,
          authorId: 'dead-x-fork',
          conversationId: id,
          kind: 'answer',
          body: 'dispatched first-turn answer',
          evidence: EVIDENCE,
        },
        deps,
      );
      return { woke: 1, answeringOwnerId: 'dead-x-fork' };
    };

    const decline = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in decline) throw new Error(decline.error);
    // Without the early stamp this is `{ error: 'not_a_participant' }` — the
    // launcher refusing the session it just launched.
    expect(firstTurn).toMatchObject({ ok: true, role: 'responder', state: 'active' });
    expect(decline.cascade.exhausted).toBe(false);
    const row = await stateRow(id);
    expect(row.state).toBe('active');
    expect(row.cascade_cursor).toBe(1);
    const routingRow = parseRouting(row.routing);
    expect(routingRow.selection?.selected?.[1]).toMatchObject({
      ownerId: 'dead-x',
      answeringOwnerId: 'dead-x-fork',
    });
    expect(row.cascade_digest).toMatchObject([
      { ownerId: RESPONDER, kind: 'decline' },
      { ownerId: 'dead-x-fork', kind: 'answer' },
    ]);
  });

  it('the FORK may decline under its own identity — responder_id names the transcript, not the author', async () => {
    // The dispatched session is the one that reads the question and discovers
    // its inherited transcript does not cover it. Gating decline on
    // `authorId === responder_id` refuses exactly that session (a fork posts
    // under a fresh coord id BY CONSTRUCTION), which strands the consult on an
    // expert who cannot answer until the expiry sweep settles it hours later.
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps } = makeDeps();
    // Dispatch stamps the answering identity onto the cursor entry; the gate
    // reads it from there.
    deps.dispatch = async (o) => {
      await o.onAnsweringOwner?.(`${o.responder}-fork`);
      return { woke: 1, answeringOwnerId: `${o.responder}-fork` };
    };
    const first = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in first) throw new Error(first.error);
    expect(first.cascade).toMatchObject({ advanced_to: 'dead-x' });

    const forked = await consultDeclineCore(
      {
        workspaceId: WS,
        authorId: 'dead-x-fork',
        conversationId: id,
        reason: 'the inherited transcript covers the router, not this subsystem',
      },
      deps,
    );
    expect(forked).not.toMatchObject({ error: 'not_the_responder' });
    if ('error' in forked) throw new Error(forked.error);
    const row = await stateRow(id);
    expect(row.cascade_digest).toMatchObject([
      { ownerId: RESPONDER, kind: 'decline' },
      { ownerId: 'dead-x-fork', kind: 'decline' },
    ]);
  });

  it('the ONE refill round is already spent — honest terminal, selection.underFilled says refill-spent', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting({ refillSpent: true }) });
    const { deps, dispatchCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(dispatchCalls).toEqual([]); // the persisted stamp, not a local flag, is the bound
    expect(r.state).toBe('declined');
    expect(r.cascade.exhausted).toBe(true);
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({ answers: 0, min: 1, reason: 'refill-spent' });
  });

  // WI-10005360 (conv-muqlw2ay): min 1, the menu AND the one refill pick were all
  // refused BEFORE launch, and the consult closed `refill-spent` while launchable
  // experts sat untried. The bound is on LAUNCHES — a pre-launch refusal costs no
  // answering session, so it must not spend the round.
  function refusalPoolRouting(extra: string[]) {
    const cand = (ownerId: string, score: number) => ({
      ownerId, score, relevance: score, signals: { similarity: score - 0.1 }, liveness: 'ended',
    });
    return {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      candidates: [cand(RESPONDER, 0.9), ...extra.map((o, i) => cand(o, 0.8 - i * 0.05))],
      selection: {
        min: 1,
        max: 1,
        selected: [{ ownerId: RESPONDER, via: 'floor', score: 0.9, similarity: 0.8, liveness: 'live' }],
      },
    };
  }

  it('WI-10005360: a refill round refused entirely before launch is NOT spent — it extends until an expert launches', async () => {
    const id = await seedConsult({
      state: 'active',
      routing: refusalPoolRouting(['refused-1', 'refused-2', 'launchable', 'never-needed']),
    });
    const { deps, dispatchCalls } = makeDeps();
    deps.dispatch = async (o) => {
      dispatchCalls.push(o);
      return o.responder === 'launchable' ? { woke: 1, answeringOwnerId: 'launchable-fork' } : { woke: 0 };
    };
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(dispatchCalls.map((o) => o.responder)).toEqual(['refused-1', 'refused-2', 'launchable']);
    expect(r.cascade).toMatchObject({ advanced_to: 'launchable', exhausted: false });
    const row = await stateRow(id);
    expect(row).toMatchObject({ responder_id: 'launchable', closed_at: null });
    const routingRow = parseRouting(row.routing);
    // The continuation APPENDS to the original stamp, so `added` stays the full record.
    expect(routingRow.selection?.refill?.added).toEqual(['refused-1', 'refused-2', 'launchable']);
    expect(routingRow.selection?.refill).toHaveProperty('continued');
    expect(routingRow.selection?.underFilled).toBeUndefined();
    // Still bounded: once one pick launched, nobody further is pulled in.
    expect(routingRow.selection?.selected?.map((s) => s.ownerId)).not.toContain('never-needed');
  });

  it('WI-10005360 bound: once a refill pick LAUNCHED, the round is spent — its fork declining ends refill-spent with pool left', async () => {
    const id = await seedConsult({ state: 'active', routing: refusalPoolRouting(['launch-a', 'spare-b']) });
    const { deps, dispatchCalls } = makeDeps();
    deps.dispatch = async (o) => {
      dispatchCalls.push(o);
      await o.onAnsweringOwner?.(`${o.responder}-fork`);
      return { woke: 1, answeringOwnerId: `${o.responder}-fork` };
    };
    const first = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'not my area' },
      deps,
    );
    if ('error' in first) throw new Error(first.error);
    expect(first.cascade).toMatchObject({ advanced_to: 'launch-a', exhausted: false });
    // The launched fork posts under its OWN identity, so the digest has no entry
    // under 'launch-a' — that absence must read as "launched" (spent), never as
    // "refused before launch".
    const second = await consultDeclineCore(
      { workspaceId: WS, authorId: 'launch-a-fork', conversationId: id, reason: 'transcript does not cover this' },
      deps,
    );
    if ('error' in second) throw new Error(second.error);
    expect(second.cascade.exhausted).toBe(true);
    expect(dispatchCalls.map((o) => o.responder)).toEqual(['launch-a']);
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({ answers: 0, min: 1, reason: 'refill-spent' });
    expect(routingRow.selection?.selected?.map((s) => s.ownerId)).not.toContain('spare-b');
  });

  it('nobody untried left at all — honest terminal: no-untried-candidate, never a silent exhaustion', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting({ noUntried: true }) });
    const { deps } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('declined');
    const routingRow = parseRouting((await stateRow(id)).routing);
    expect(routingRow.selection?.underFilled).toMatchObject({
      answers: 0,
      min: 1,
      reason: 'no-untried-candidate',
    });
  });

  it('no dispatch seam bound — the advance still happens and nobody is launched (fixtures only; prod always binds it)', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting() });
    const { deps } = makeDeps({ withDispatch: false });
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder');
    expect(r.cascade).toMatchObject({ advanced_to: 'dead-x', woke: 0 });
    const routingRow = parseRouting((await stateRow(id)).routing);
    // No answering identity, because nothing answered — the honest shape.
    expect(routingRow.selection?.selected?.[1]?.answeringOwnerId).toBeUndefined();
  });

  it('a dead BELOW-floor candidate still fills the minimum, labeled via:minimum (D-003 honesty, not a costumed expert)', async () => {
    const id = await seedConsult({ state: 'active', routing: deadPoolRouting({ lowScore: true }) });
    const { deps, dispatchCalls } = makeDeps();
    const r = await consultDeclineCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: id, reason: 'no' },
      deps,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toBe('awaiting_responder');
    expect(dispatchCalls.at(-1)?.responder).toBe('dead-low');
    const routingRow = parseRouting((await stateRow(id)).routing);
    // The LABEL is what keeps this honest: below both floors, so 'minimum'.
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'dead-low', via: 'minimum' });
    expect(routingRow.selection?.underFilled).toBeUndefined();
  });
});

/**
 * A TRUNCATED conversation ref must resolve on EVERY verb that accepts one
 * (EI-23942597240908282). The incident: a grader was told "you remain the
 * assigned grader on conv-mucapfpl until consult:decline advances it", fired
 * exactly that, and got a bare `not_a_consult` — the row's real id was the
 * 51-char `conv-mucapfpl-0000-30e383612d604ea88789d3c06b3a01fe`, and the
 * refusal was indistinguishable from "you have no decline to make". Reply and
 * decline were wired first; CLOSE is the third verb of the same class and was
 * missed, which is the gap these pin. Close matters most of the three: it is
 * the verb that records the TERMINAL outcome, so a miss stranded exactly the
 * consults that most needed a disposition.
 */
describe('truncated conversation ref resolution (EI-23942597240908282)', () => {
  const FULL = 'conv-mucapfpl-0000-30e383612d604ea88789d3c06b3a01fe';
  const PREFIX = 'conv-mucapfpl';

  it('close resolves a unique prefix AND performs its WRITES against the resolved id', async () => {
    await seedConsult({ id: FULL, state: 'active' });
    const { deps, posts } = makeDeps();

    const res = await consultCloseCore(
      {
        workspaceId: WS,
        authorId: RESPONDER,
        conversationId: PREFIX,
        outcome: 'answered',
        answer: 'resolved via a truncated ref',
      },
      deps,
    );
    if ('error' in res) throw new Error(`close refused a resolvable prefix: ${res.error}`);
    expect(res.state).toBe('closed_answered');

    // THE LOAD-BEARING ASSERTION, and the reason normalizeConversationRef
    // rebinds the request instead of only resolving the gate read: a
    // gate-only fix returns success here while every UPDATE and INSERT below
    // it matches ZERO rows — reporting a close that never happened, which is
    // strictly worse than the honest refusal it replaces.
    const row = await stateRow(FULL);
    expect(row.state).toBe('closed_answered');
    expect(row.closed_at).not.toBeNull();
    expect(posts.map((p) => p.conversation_id)).toEqual([FULL]);
  });

  it('REFUSES an ambiguous prefix rather than closing a stranger’s consult', async () => {
    const a = `conv-ambigxy-0000-${'a'.repeat(32)}`;
    const b = `conv-ambigxy-0000-${'b'.repeat(32)}`;
    await seedConsult({ id: a, state: 'active' });
    await seedConsult({ id: b, state: 'active' });
    const { deps, posts } = makeDeps();

    const res = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: 'conv-ambigxy', outcome: 'answered', answer: 'x' },
      deps,
    );
    expect('error' in res && res.error).toBe('conversation_id_ambiguous');
    // Neither consult may be touched — guessing would post a terminal outcome
    // into whichever cascade sorted first.
    expect(posts).toHaveLength(0);
    expect((await stateRow(a)).state).toBe('active');
    expect((await stateRow(b)).state).toBe('active');
  });

  it('CALIBRATION: a well-formed FULL id that genuinely misses still refuses, with no truncation hint', async () => {
    const { deps } = makeDeps();
    const absent = `conv-absentxx-0000-${'c'.repeat(32)}`;

    const res = await consultCloseCore(
      { workspaceId: WS, authorId: RESPONDER, conversationId: absent, outcome: 'answered', answer: 'x' },
      deps,
    );
    // Exact equality is the point: a full-shaped id skips the prefix scan, so
    // it must carry NO truncation hint. Without this the other two cases pass
    // just as well against a resolver that sprays the hint onto every miss.
    expect(res).toEqual({ error: 'not_a_consult' });
  });
});

describe('consult requester follow-up transfer', () => {
  it('records an ended requester’s successor without rewriting original requester attribution', async () => {
    const id = await seedConsult({ state: 'closed_cant_help', routing: { preserved: 'route-snapshot' } });
    const reason = 'The requester session ended; this session owns the saved plan-start follow-up.';
    const requesterEnded = async (ownerId: string) => ownerId === REQUESTER;

    const transferred = await consultTransferRequesterFollowupCore({
      workspaceId: WS,
      authorId: 'successor-1',
      conversationId: id,
      reason,
    }, {
      getSql: () => rootSql,
      isSuperuser: true,
      requesterEnded,
      now: () => NOW,
    });

    expect(transferred).toMatchObject({
      ok: true,
      conversation_id: id,
      original_requester_id: REQUESTER,
      previous_followup_owner_id: REQUESTER,
      followup_owner_id: 'successor-1',
      state: 'closed_cant_help',
      changed: true,
      reason,
      transferred_at: NOW.toISOString(),
    });
    const row = await stateRow(id);
    expect(row.requester_id).toBe(REQUESTER);
    expect(row.routing).toMatchObject({
      preserved: 'route-snapshot',
      requesterFollowupTransfers: [{
        from: REQUESTER,
        to: 'successor-1',
        by: 'successor-1',
        reason,
        at: NOW.toISOString(),
      }],
    });

    await expect(consultResolveRequestedConsult({
      workspaceId: WS, requesterId: 'successor-1', conversationRef: id,
    }, { getSql: () => rootSql })).resolves.toMatchObject({ ok: true, conversation_id: id });
    await expect(consultResolveRequestedConsult({
      workspaceId: WS, requesterId: 'unrelated-agent', conversationRef: id,
    }, { getSql: () => rootSql })).resolves.toMatchObject({ error: 'not_the_requester' });
  });

  it('refuses transfer unless the current follow-up owner is confirmed ended', async () => {
    const id = await seedConsult({ state: 'active', routing: { preserved: true } });
    const transferred = await consultTransferRequesterFollowupCore({
      workspaceId: WS,
      authorId: 'successor-live-check',
      conversationId: id,
      reason: 'Attempted takeover while requester is still live.',
    }, {
      getSql: () => rootSql,
      isSuperuser: true,
      requesterEnded: async () => false,
      now: () => NOW,
    });

    expect(transferred).toMatchObject({ error: 'requester_not_confirmed_ended', requester_id: REQUESTER });
    expect(await stateRow(id)).toMatchObject({ requester_id: REQUESTER, routing: { preserved: true } });
  });

  it('refuses a non-superuser before reading consult state', async () => {
    const transferred = await consultTransferRequesterFollowupCore({
      workspaceId: WS,
      authorId: 'ordinary-agent',
      conversationId: 'unknown-consult',
      reason: 'not authorized',
    }, {
      getSql: () => { throw new Error('unauthorized transfer must not read storage'); },
      isSuperuser: false,
      requesterEnded: async () => true,
      now: () => NOW,
    });

    expect(transferred).toEqual({ error: 'superuser_required' });
  });

  it('does not transfer while the consult is still routing', async () => {
    const id = await seedConsult({ state: 'routing' });
    const transferred = await consultTransferRequesterFollowupCore({
      workspaceId: WS,
      authorId: 'successor-routing',
      conversationId: id,
      reason: 'The requester session ended during routing.',
    }, {
      getSql: () => rootSql,
      isSuperuser: true,
      requesterEnded: async () => { throw new Error('routing consult must be refused before liveness lookup'); },
      now: () => NOW,
    });

    expect(transferred).toEqual({ error: 'consult_routing_in_progress' });
    expect((await stateRow(id)).requester_id).toBe(REQUESTER);
  });
});

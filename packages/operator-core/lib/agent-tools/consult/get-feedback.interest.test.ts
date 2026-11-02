import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { AGENT_LAUNCH_HANDLER_TIMEOUT_SEC } from '../../agent-kickoff/launch-budgets.mjs';

const h = vi.hoisted(() => ({
  getFeedbackCore: vi.fn(),
  acceptFeedbackRequestCore: vi.fn(),
  continueFeedbackRequestCore: vi.fn(),
  validateBarCritiquePlanOrigin: vi.fn(async () => null),
  reconcileInterestEventAwaits: vi.fn(),
  buildQueryEmbedderResolved: vi.fn(async () => null),
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
  routeConsult: vi.fn(),
  resolveSessionStates: vi.fn(),
  notifyAgents: vi.fn(),
  makeConsultReachDispatcher: vi.fn(() => vi.fn()),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'requester-1', ownerLabel: 'Requester 1' }),
}));
vi.mock('../../interest-auto-arm', () => ({
  reconcileInterestEventAwaits: h.reconcileInterestEventAwaits,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: vi.fn(async () => []) }) };
});
vi.mock('../../consult/get-feedback-core', () => ({
  getFeedbackCore: h.getFeedbackCore,
  acceptFeedbackRequestCore: h.acceptFeedbackRequestCore,
  continueFeedbackRequestCore: h.continueFeedbackRequestCore,
  validateBarCritiquePlanOrigin: h.validateBarCritiquePlanOrigin,
}));
vi.mock('../../consult/relevance-router', () => ({
  DEFAULT_RECENCY_HALF_LIFE_DAYS: 7,
  expertiseSubject: () => null,
  routeConsult: h.routeConsult,
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedderResolved: h.buildQueryEmbedderResolved,
  interactiveEmbedAcquireBudgetMs: h.interactiveEmbedAcquireBudgetMs,
}));
vi.mock('../coordination/liveness-oracle', () => ({ resolveSessionStates: h.resolveSessionStates }));
vi.mock('../coordination/conversations', () => ({
  withConversationsIdentityScope: (_identity: unknown, _harness: unknown, fn: () => unknown) => fn(),
  conversationsScopeWorkspace: () => 'ws-test',
  openConversation: vi.fn(),
}));
vi.mock('../coordination/notify-agents', () => ({ notifyAgents: h.notifyAgents }));
vi.mock('../../consult/consult-dispatch', () => ({
  makeConsultReachDispatcher: h.makeConsultReachDispatcher,
  continueCascadeDispatchProd: vi.fn(async () => true),
}));
vi.mock('../../rubrics', () => ({ resolveAcceptanceBarApproverScreen: async () => ({
  check: async () => ({ eligible: true, reason: 'eligible' }),
}) }));

import tool from './get-feedback';
import { lookupByMcpName } from '@papercusp/tooldef';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

const handle = {
  event_keys: ['consult:reply:consult-1'],
  await_ids: [61],
  cancel: { tool: 'events:cancel' as const, args: { await_ids: [61] } },
  handle_note: 'captured requester wake handle',
};

const routed = (latencyContract: 'proceed' | 'hard-blocked') => ({
  verdict: 'routed' as const,
  conversation_id: 'consult-1',
  thread_id: 'thread-1',
  responder: 'peer-1',
  responder_via: 'floor',
  remaining_candidates: [],
  origin_task_ref: 'WI-1',
  latency_contract: latencyContract,
  expires_at: '2026-08-21T00:10:00.000Z',
  wake: { woke: 1 },
  park_key: latencyContract === 'hard-blocked' ? 'consult:reply:consult-1' : null,
});

const call = async (latencyContract: 'proceed' | 'hard-blocked', extra: Record<string, unknown> = {}) => {
  const out = await (tool as any).handler(
    { question: 'What already failed here?', latency_contract: latencyContract, ...extra },
    { harnessSlug: 'papercusp' },
  );
  return out.data as Record<string, unknown>;
};

beforeEach(() => {
  h.getFeedbackCore.mockReset();
  h.validateBarCritiquePlanOrigin.mockReset().mockResolvedValue(null);
  h.acceptFeedbackRequestCore.mockReset().mockImplementation(async (request) => ({
    ok: true, verdict: 'accepted', state: 'routing', pending: true,
    conversation_id: 'consult-1', thread_id: 'thread-1', request_key: request.requestKey ?? 'auto-key',
    latency_contract: request.latencyContract,
    park_key: request.latencyContract === 'hard-blocked' ? 'consult:reply:consult-1' : null,
  }));
  h.continueFeedbackRequestCore.mockReset().mockImplementation(async (_workspace, _id, deps) => {
    await deps.execute(h.acceptFeedbackRequestCore.mock.calls.at(-1)![0], {
      conversation_id: 'consult-1', thread_id: 'thread-1', leaseToken: 'fixture-lease',
    });
    return true;
  });
  h.routeConsult.mockReset();
  h.resolveSessionStates.mockReset();
  h.reconcileInterestEventAwaits.mockReset().mockResolvedValue(handle);
  h.buildQueryEmbedderResolved.mockClear();
  h.interactiveEmbedAcquireBudgetMs.mockClear();
  h.makeConsultReachDispatcher.mockClear();
});

describe('consult:get_feedback requester interest handle (P-024)', () => {
  it('preserves the explicit METHOD independence target in the accepted request', async () => {
    await call('proceed', { policy: 'method-review', method_review_rubric_ref: 'acceptance-native', allow_dispatch: false });
    expect(h.acceptFeedbackRequestCore.mock.calls[0]![0]).toMatchObject({
      policy: 'method-review', methodReviewRubricRef: 'acceptance-native',
    });
    // The accepted request runs asynchronously; drain this test's continuation
    // before the next case resets the shared mocks.
    await vi.waitFor(() => expect(h.getFeedbackCore).toHaveBeenCalledTimes(1));
  });
  it('registers the hard-blocked reply waiter before dispatch and returns its cancel handle', async () => {
    let releaseArm!: () => void;
    const armGate = new Promise<void>((resolve) => { releaseArm = resolve; });
    const order: string[] = [];
    h.reconcileInterestEventAwaits.mockImplementation(async () => {
      order.push('arm-start');
      await armGate;
      order.push('arm-ready');
      return handle;
    });
    h.getFeedbackCore.mockImplementation(async (_request: unknown, deps: {
      reach?: (opts: unknown) => Promise<unknown>;
    }) => {
      expect(order).toContain('arm-ready');
      order.push('dispatch-start');
      await deps.reach?.({});
      order.push('reply-event-emitted');
      return routed('hard-blocked');
    });

    const outPromise = call('hard-blocked');
    await vi.waitFor(() => expect(h.reconcileInterestEventAwaits).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['arm-start']);
    expect(h.getFeedbackCore).not.toHaveBeenCalled();
    releaseArm();

    const out = await outPromise;
    await vi.waitFor(() => expect(h.getFeedbackCore).toHaveBeenCalledTimes(1));
    expect(out).toMatchObject({ verdict: 'accepted', state: 'routing', pending: true });
    expect(order).toEqual(['arm-start', 'arm-ready', 'dispatch-start', 'reply-event-emitted']);
    await vi.waitFor(() => expect(h.interactiveEmbedAcquireBudgetMs).toHaveBeenCalledTimes(1));
    expect(h.buildQueryEmbedderResolved).toHaveBeenCalledWith({ acquireBudgetMs: 4000 });
    expect(h.reconcileInterestEventAwaits).toHaveBeenCalledWith({
      ownerId: 'requester-1',
      eventKeys: ['consult:reply:consult-1'],
      boundTo: { kind: 'consult-request', ref: 'consult-1' },
      note: 'hard-blocked consult requester auto-arm for consult-1',
    });
    expect(out.interest_watch).toEqual(handle);
  });

  it('does not arm or return a requester watch for proceed-mode consults', async () => {
    h.getFeedbackCore.mockResolvedValue(routed('proceed'));
    const out = await call('proceed');
    expect(h.reconcileInterestEventAwaits).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('interest_watch');
  });

  it('retains an explicit rubric-vetting model in the durable request and routing continuation', async () => {
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' };
    const args = (tool as any).args.parse({ question: 'Vet the current acceptance rubric',
      policy: 'rubric-vetting', reviewerModel });
    h.getFeedbackCore.mockResolvedValue(routed('proceed'));
    await call('proceed', args);
    expect(h.acceptFeedbackRequestCore).toHaveBeenCalledWith(
      expect.objectContaining({ policy: 'rubric-vetting', reviewerModel }), expect.anything(),
    );
    await vi.waitFor(() => expect(h.getFeedbackCore).toHaveBeenCalledWith(
      expect.objectContaining({ policy: 'rubric-vetting', reviewerModel }), expect.anything(),
    ));
  });

  it('refuses reviewer model steering outside rubric vetting before creating or dispatching a consult', async () => {
    const out = await call('hard-blocked', { reviewerModel: { agent: 'codex', model: 'sol' } });
    expect(out).toMatchObject({ error: 'reviewer_model_requires_rubric_vetting' });
    expect(h.acceptFeedbackRequestCore).not.toHaveBeenCalled();
    expect(h.continueFeedbackRequestCore).not.toHaveBeenCalled();
    expect(h.reconcileInterestEventAwaits).not.toHaveBeenCalled();
  });

  it('keeps dispatch enabled by default but honors an explicit allow_dispatch opt-out', async () => {
    h.getFeedbackCore.mockImplementation(async (_request: unknown, deps: { reach?: unknown }) => {
      expect(deps.reach).toEqual(expect.any(Function));
      return routed('proceed');
    });
    await call('proceed');
    await vi.waitFor(() => expect(h.getFeedbackCore).toHaveBeenCalledTimes(1));
    expect(h.makeConsultReachDispatcher).toHaveBeenCalledTimes(1);

    h.getFeedbackCore.mockReset();
    h.makeConsultReachDispatcher.mockClear();
    // Opted out, the delivery seam is a LOCAL no-op stub, not an absent seam
    // and never a wake: the dispatcher factory is not built at all.
    h.getFeedbackCore.mockImplementation(
      async (_request: unknown, deps: { reach?: (opts: unknown) => Promise<{ woke: number }> }) => {
        expect(deps.reach).toEqual(expect.any(Function));
        await expect(deps.reach!({})).resolves.toMatchObject({ queued: 0, woke: 0 });
        return routed('proceed');
      },
    );
    await call('proceed', { allow_dispatch: false });
    await vi.waitFor(() => expect(h.getFeedbackCore).toHaveBeenCalledTimes(1));
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
    expect(h.notifyAgents).not.toHaveBeenCalled();
  });

  it('uses a live PTY host as positive authority when annotating routing candidates', async () => {
    h.resolveSessionStates.mockResolvedValue(
      new Map([['peer-host-live', { ownerId: 'peer-host-live', sessionState: 'recorded' }]]),
    );
    h.routeConsult.mockImplementation(
      async (
        _params: unknown,
        deps: {
          getLiveness: (
            ownerIds: string[],
          ) => Promise<Record<string, { sessionState: string | null; warmIdle?: boolean }>>;
        },
      ) => {
        expect(await deps.getLiveness(['peer-host-live'])).toEqual({
          'peer-host-live': { sessionState: 'recorded' },
        });
        return {};
      },
    );
    h.getFeedbackCore.mockImplementation(
      async (
        _request: unknown,
        deps: { route: (params: Record<string, unknown>) => Promise<unknown> },
      ) => {
        await deps.route({});
        return routed('proceed');
      },
    );

    await call('proceed');
    await vi.waitFor(() => expect(h.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'peer-host-live' }],
      { hydrateBatch: true, psuHostPositiveAuthority: true },
    ));
  });
});

describe('consult:get_feedback requester guidance', () => {
  it('accepts bounded retry identities in the registered public schema and rejects empty or oversized keys', () => {
    const args = tool.args.parse({ question: 'Retry the persisted request', request_key: '  stable-key  ' });
    expect(args.request_key).toBe('stable-key');
    expect(tool.args.safeParse({ question: 'Retry the persisted request' }).success).toBe(true);
    expect(tool.args.safeParse({ question: 'Retry the persisted request', request_key: 'x'.repeat(200) }).success).toBe(true);
    for (const request_key of ['', '   ', 'x'.repeat(201)]) {
      expect(tool.args.safeParse({ question: 'Retry the persisted request', request_key }).success).toBe(false);
    }
  });

  it('accepts an uncapped subject_refs list and persists expanded public-manual anchors before routing', async () => {
    const manyRefs = Array.from({ length: 1_024 }, (_, index) => `packages/example/source-${index}.ts`);
    expect(tool.args.safeParse({ question: 'Review all requested sources', subject_refs: manyRefs }).success).toBe(true);

    const faqPath = 'apps/papercusp-docs/src/content/docs/faq.mdx';
    await call('proceed', { subject_refs: [faqPath] });
    const accepted = h.acceptFeedbackRequestCore.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(accepted).toMatchObject({
      subjectRefs: [faqPath],
      resolvedSubjectRefs: [
        'packages/operator-core/lib/auth/hosted/self-signup.ts',
        'packages/operator-core/lib/auth/hosted/billing/entitlement-seam.ts',
        'packages/operator-core/lib/agent-tools/mode/set.ts',
        'packages/operator-core/lib/workspace-host/hosted-provider-delegation.ts',
        'packages/operator-core/lib/agent-tools/access/create.ts',
        'packages/operator-core/lib/agent-tools/backup/snapshot_create.ts',
        'packages/operator-core/lib/agent-tools/backup/restore.ts',
      ],
      unresolvedSubjectRefs: [],
    });
  });

  it('passes the retry key and payload through the public handler to durable acceptance', async () => {
    const out = await call('proceed', {
      request_key: 'stable-key', tried: 'Read the implementation', observed: 'Transport timed out',
      decision_at_stake: 'Resume the existing consult', origin_task_ref: 'WI-1',
      allow_dispatch: false, harness: 'papercusp', min_agents: 0, max_agents: 2,
    });
    expect(h.acceptFeedbackRequestCore).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-test', requesterId: 'requester-1', requestKey: 'stable-key',
      question: 'What already failed here?', tried: 'Read the implementation', observed: 'Transport timed out',
      decisionAtStake: 'Resume the existing consult', originTaskRef: 'WI-1',
      allowDispatch: false, harnessSlug: 'papercusp', minResponders: 0, maxResponders: 2,
    }), expect.any(Object));
    expect(out).toMatchObject({ verdict: 'accepted', conversation_id: 'consult-1', request_key: 'stable-key' });
    await vi.waitFor(() => expect(h.continueFeedbackRequestCore).toHaveBeenCalledWith(
      'ws-test', 'consult-1', expect.objectContaining({ execute: expect.any(Function) }),
    ));
  });

  it('returns durable acceptance while routing continuation has not completed', async () => {
    let finish!: (value: boolean) => void;
    h.continueFeedbackRequestCore.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    try {
      const out = await call('proceed', { request_key: 'pending-key' });
      expect(out).toMatchObject({ verdict: 'accepted', pending: true, request_key: 'pending-key' });
      await vi.waitFor(() => expect(h.continueFeedbackRequestCore).toHaveBeenCalledTimes(1));
      expect(h.getFeedbackCore).not.toHaveBeenCalled();
      expect(h.buildQueryEmbedderResolved).not.toHaveBeenCalled();
      expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
    } finally {
      finish?.(false);
    }
  });

  it('returns key reuse refusal without scheduling routing or arming a requester watch', async () => {
    const refusal = {
      error: 'request_key_conflict', conversation_id: 'consult-1',
      hint: 'Reuse its original payload for recovery, or use a new key for a fresh consult.',
    };
    h.acceptFeedbackRequestCore.mockResolvedValue(refusal);
    const out = await call('hard-blocked', { request_key: 'conflicting-key' });
    expect(out).toEqual(refusal);
    expect(h.continueFeedbackRequestCore).not.toHaveBeenCalled();
    expect(h.reconcileInterestEventAwaits).not.toHaveBeenCalled();
    expect(h.buildQueryEmbedderResolved).not.toHaveBeenCalled();
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
  });

  it('uses the shared handler timeout budget for synchronous consult dispatch', () => {
    const projected = lookupByMcpName('consult:get_feedback');
    expect(projected).toBeDefined();
    if (!projected) throw new Error('consult:get_feedback was not projected');
    const timeoutSec = (projected as unknown as { timeoutSec?: number }).timeoutSec;
    expect(timeoutSec).toBe(AGENT_LAUNCH_HANDLER_TIMEOUT_SEC);
    expect(timeoutSec).toBeGreaterThan(55);
  });

  it('keeps the retired reporting verb out of the production registration entrypoint', () => {
    const entrypoint = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(entrypoint).not.toMatch(/import\s+['"]\.\/consult\/reconcile['"]/);
    expect(existsSync(new URL('./reconcile.ts', import.meta.url))).toBe(false);
  });

  it('stays within the live prompt-weight budget', () => {
    const projected = lookupByMcpName('consult:get_feedback');
    expect(projected).toBeDefined();
    if (!projected) throw new Error('consult:get_feedback was not projected');
    expect(promptWeight(projected)).toBeLessThanOrEqual(BUDGET);
  });

  it('clearly distinguishes opening a consult from reading an existing conversation', () => {
    expect((tool as any).description).toContain('Accept a recoverable consult request');
    expect((tool as any).description).toContain('before routing/launch completes');
    expect((tool as any).description).toContain('conversations:get { id }');
    expect((tool as any).description).toContain('Reuse request_key and the same payload after a timeout');
    expect((tool as any).guidance.notWhen).toContain('Reading an existing conversation');
    expect((tool as any).guidance.chaining).toContain('does not read an existing conversation');
  });

  it('limits consults to unresolved peer-knowledge questions and explains isolated dispatch', () => {
    expect((tool as any).guidance.when).toContain('first-pass check of local code, docs, or search');
    expect((tool as any).guidance.when).toContain('Ask once');
    expect((tool as any).guidance.notWhen).toContain('owner decisions');
    expect((tool as any).guidance.notWhen).toContain('Do not open duplicate consults');
    expect((tool as any).description).toContain('isolated answer session');
    expect((tool as any).description).toContain('does not wake the expert’s live session');
    expect((tool as any).guidance.chaining).toContain('dispatcher already walks allowed model ranks');
  });

  it('asks agents to use advice without a separate reporting tool call', () => {
    expect((tool as any).guidance.chaining).toContain('read the reply');
    expect((tool as any).guidance.chaining).toContain('apply relevant findings to your project decision');
    expect((tool as any).guidance.chaining).toContain('Receipt or silence does not prove usefulness');
    expect((tool as any).guidance.chaining).toContain('retrieval-only');
    expect((tool as any).guidance.chaining).not.toContain('consult:reconcile');
    expect((tool as any).guidance.notWhen).toContain('Do not consult to meet a quota');
  });
});

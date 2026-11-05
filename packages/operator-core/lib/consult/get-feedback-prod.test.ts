import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedOnceTyped } from '../testing/typed-mock';

type ValidateBarCritiquePlanOrigin = typeof import('./get-feedback-core').validateBarCritiquePlanOrigin;
type BuildQueryEmbedderResolved = typeof import('../agent-tools/search/embedder').buildQueryEmbedderResolved;

const h = vi.hoisted(() => {
  const sql = {};
  const routingSettings = {
    allowlist: [{ rank: 1, agent: 'codex' as const, model: 'sol' }],
    recencyHalfLifeDays: 14,
  };
  return {
    routingSettings,
    getFeedbackCore: vi.fn(async (_request: unknown, _deps: unknown) => ({})),
    acceptFeedbackRequestCore: vi.fn(async (_request: unknown, _deps: unknown) => ({
      ok: true as const, verdict: 'accepted' as const, state: 'routing', pending: true,
      conversation_id: 'accepted-conv', thread_id: 'thr-accepted-conv', request_key: 'retry-key',
      latency_contract: 'proceed' as const, park_key: null, hint: 'pending',
    })),
    validateBarCritiquePlanOrigin: vi.fn<ValidateBarCritiquePlanOrigin>(async () => null),
    continueFeedbackRequestCore: vi.fn(async (_workspace: string, _conversation: string, _deps: unknown) => false),
    getOrgPg: vi.fn(() => ({ sql })),
    buildQueryEmbedderResolved: vi.fn<BuildQueryEmbedderResolved>(async () => null),
    interactiveEmbedAcquireBudgetMs: vi.fn(() => 10),
    resolveProseProfileSelection: vi.fn(),
    resolveSessionStates: vi.fn(),
    listLoopStanddownOwners: vi.fn(),
    openConversation: vi.fn(),
    routeConsult: vi.fn(async (_params: unknown, _deps: unknown) => ({ verdict: 'no_qualified_responder' })),
    makeConsultReachDispatcher: vi.fn((_context: unknown, _deps: unknown) => async () => ({})),
    continueCascadeDispatchProd: vi.fn(async (_workspace: string, _conversation: string, _context: unknown, _options: unknown) => true),
    observeNativeConsultSource: vi.fn(async (_candidate: unknown, _constraint: unknown) => ({})),
    readConsultExpertRoutingSettings: vi.fn(async () => routingSettings),
    resolveAcceptanceBarApproverScreen: vi.fn(),
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: h.getOrgPg,
}));
vi.mock('./get-feedback-core', () => ({ getFeedbackCore: h.getFeedbackCore,
  acceptFeedbackRequestCore: h.acceptFeedbackRequestCore, validateBarCritiquePlanOrigin: h.validateBarCritiquePlanOrigin,
  continueFeedbackRequestCore: h.continueFeedbackRequestCore }));
vi.mock('../rubrics', () => ({ resolveAcceptanceBarApproverScreen: h.resolveAcceptanceBarApproverScreen }));
// expertiseSubject: acceptFeedbackRequestProd reads it since f36b33ffd5; the mock
// lacked it, so the acceptance test failed at HEAD.
vi.mock('./relevance-router', () => ({ routeConsult: h.routeConsult, expertiseSubject: () => null }));
// WI-6554700010009982: the dispatchability filter is unit-tested on its own;
// here it is a passthrough so routes stay hermetic, and its wiring is asserted.
const filterDispatchableRoute = vi.hoisted(() => vi.fn(async (route: unknown, _probe?: unknown, _options?: unknown) => route));
vi.mock('./source-dispatchability', () => ({ filterDispatchableRoute, probeConsultSourceDispatchable: vi.fn() }));
vi.mock('../agent-tools/search/embedder', () => ({
  buildQueryEmbedderResolved: h.buildQueryEmbedderResolved,
  interactiveEmbedAcquireBudgetMs: h.interactiveEmbedAcquireBudgetMs,
}));
vi.mock('../search/prose-vector-dims', () => ({ resolveProseProfileSelection: h.resolveProseProfileSelection }));
vi.mock('../agent-tools/coordination/liveness-oracle', () => ({ resolveSessionStates: h.resolveSessionStates }));
vi.mock('../harness/routines/release-pause-ttl', () => ({ listLoopStanddownOwners: h.listLoopStanddownOwners }));
vi.mock('../agent-tools/coordination/conversations', () => ({ openConversation: h.openConversation }));
vi.mock('./consult-dispatch', () => ({ makeConsultReachDispatcher: h.makeConsultReachDispatcher,
  continueCascadeDispatchProd: h.continueCascadeDispatchProd,
  observeNativeConsultSource: h.observeNativeConsultSource }));
vi.mock('./expert-routing-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./expert-routing-settings')>();
  return { ...actual, readConsultExpertRoutingSettings: h.readConsultExpertRoutingSettings };
});

import { acceptFeedbackRequestProd, continueFeedbackRequestProd, getFeedbackProd } from './get-feedback-prod';

describe('getFeedbackProd expert-routing settings', () => {
  it.each([undefined, Date.now() + 120_000])('uses only the internal accepted lease for scoring: %s', async leaseUntilMs => {
    const request = { workspaceId: 'ws-budget', requesterId: 'requester', question: 'same question' };
    await getFeedbackProd(request, { ownerId: 'requester' } as never, {
      allowDispatch: false,
      ...(leaseUntilMs === undefined ? {} : { acceptedRequest: {
        conversation_id: 'accepted-budget', thread_id: 'thr-accepted-budget', leaseToken: 'lease', leaseUntilMs,
      } }),
    });
    const deps = h.getFeedbackCore.mock.calls[0]![1] as { route: (params: unknown) => Promise<unknown> };
    await deps.route({ question: request.question });
    expect(h.routeConsult.mock.calls[0]![1]).toMatchObject({ subjectEvidenceDeadline: leaseUntilMs });
    expect(h.getFeedbackCore.mock.calls[0]![0]).toEqual({ ...request, allowDispatch: false });
  });

  it.each([
    { status: 'timed-out', cause: 'acquisition-budget-exhausted' },
    { status: 'failed', cause: 'ECONNREFUSED' },
    { status: 'disabled', cause: 'user_disabled' },
    { status: 'unavailable', cause: 'gemma_forced_but_transformers_not_installed' },
  ] as const)('retains exact acquisition cause $cause at the consult boundary without duplicate dispatch', async (failure) => {
    const outcome = { ...failure, durationMs: 10, budgetMs: 10 };
    h.buildQueryEmbedderResolved.mockImplementationOnce(async opts => {
      opts?.onAcquisition?.(outcome);
      return null;
    });
    const request = { workspaceId: 'ws-acquisition', requesterId: 'requester', question: 'exact saved question', requestKey: 'same-key' };
    await getFeedbackProd(request, { ownerId: 'requester' } as never, { allowDispatch: false });
    expect(h.getFeedbackCore).toHaveBeenCalledOnce();
    expect(h.getFeedbackCore.mock.calls[0]![0]).toMatchObject(request);
    const deps = h.getFeedbackCore.mock.calls[0]![1] as { route: (params: unknown) => Promise<unknown> };
    await deps.route({ question: request.question });
    expect(h.routeConsult).toHaveBeenCalledOnce();
    expect(h.routeConsult.mock.calls[0]![1]).toMatchObject({ embeddingAcquisition: outcome, embed: null });
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
  });

  it.each(['floor', 'minimum', 'lexical'])('screens the canonical METHOD target before %s selection, including recovery', async (via) => {
    const saved = { workspaceId: 'ws-method', requesterId: 'applier', question: 'current method',
      policy: 'method-review', methodReviewRubricRef: 'acceptance-native' };
    h.resolveAcceptanceBarApproverScreen.mockResolvedValue({ check: async (ownerId: string) => ({
      eligible: ownerId === 'unrelated', reason: ownerId === 'unrelated' ? 'eligible' : 'related_to_plan_implementer',
    }) });
    await continueFeedbackRequestProd(saved.workspaceId, 'method-conv');
    const recovery = h.continueFeedbackRequestCore.mock.calls.at(-1)![2] as {
      execute: (request: unknown, accepted: unknown) => Promise<unknown>;
    };
    await recovery.execute(saved, { conversation_id: 'method-conv', thread_id: 'thr-method', leaseToken: 'lease' });
    expect(h.resolveAcceptanceBarApproverScreen).toHaveBeenCalledWith({ rubricId: 'acceptance-native', applierId: 'applier' });
    const candidates = ['related', 'unrelated'].map(ownerId => ({ ownerId, score: 0.9,
      ...(via === 'lexical' ? { fallback: 'lexical' as const } : {}) }));
    h.routeConsult.mockResolvedValueOnce({ verdict: 'routed', qualified: via === 'floor' ? candidates : [],
      snapshot: { candidates }, queryVec: null } as Awaited<ReturnType<typeof import('./relevance-router').routeConsult>>);
    const deps = h.getFeedbackCore.mock.calls.at(-1)![1] as {
      route: (params: unknown) => ReturnType<typeof import('./relevance-router').routeConsult>;
    };
    const route = await deps.route({});
    const { selectResponders } = await vi.importActual<typeof import('./relevance-router')>('./relevance-router');
    expect(selectResponders({ qualified: route.qualified, allCandidates: route.snapshot.candidates, min: 1, max: 1 })
      .map(pick => pick.candidate.ownerId)).toEqual(['unrelated']);
    expect(route.snapshot.candidates.map((c: { ownerId: string }) => c.ownerId)).toEqual(['unrelated']);
  });

  it('refuses missing context and unreadable canonical population before routing or dispatch', async () => {
    const request = { workspaceId: 'ws-method', requesterId: 'applier', question: 'current method', policy: 'method-review' };
    await expect(getFeedbackProd(request, { ownerId: 'applier' } as never)).rejects.toThrow('method_review_requires_acceptance_rubric');
    h.resolveAcceptanceBarApproverScreen.mockRejectedValueOnce(new Error('implementer population unreadable'));
    await expect(getFeedbackProd({ ...request, methodReviewRubricRef: 'acceptance-native' },
      { ownerId: 'applier' } as never)).rejects.toThrow('implementer population unreadable');
    expect(h.routeConsult).not.toHaveBeenCalled();
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
  });

  it('restores the native source constraint during durable recovery and filters the real ranked pool before selection', async () => {
    const nativeConsult = { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' } as const;
    const saved = { workspaceId: 'workspace-native', requesterId: 'native-requester', question: 'native recovery',
      requestKey: 'native-key', allowDispatch: true, nativeConsult };
    await continueFeedbackRequestProd(saved.workspaceId, 'native-conv');
    const recovery = h.continueFeedbackRequestCore.mock.calls.at(-1)![2] as {
      execute: (request: unknown, accepted: unknown) => Promise<unknown>;
    };
    await recovery.execute(saved, { conversation_id: 'native-conv', thread_id: 'thr-native', leaseToken: 'native-lease' });
    expect(h.getFeedbackCore.mock.calls.at(-1)![0]).toMatchObject({ nativeConsult });
    const candidates = [
      { ownerId: 'wrong-owner', score: 0.95, evidence: [{ session_id: 'wrong-native', turn_idx: 1, sim: 0.95 }] },
      { ownerId: 'right-owner', score: 0.9, evidence: [{ session_id: 'right-native', turn_idx: 3, sim: 0.9 }] },
    ];
    h.routeConsult.mockResolvedValueOnce({ verdict: 'routed', qualified: candidates,
      snapshot: { candidates }, queryVec: null } as Awaited<ReturnType<typeof import('./relevance-router').routeConsult>>);
    h.observeNativeConsultSource.mockImplementationOnce(async () => ({ ownerId: 'wrong-owner', eligible: false,
      sessionId: null, evidenceSessions: ['wrong-native'], backend: null, state: 'unknown', reason: 'evidence session ownership changed' }));
    h.observeNativeConsultSource.mockImplementationOnce(async () => ({ ownerId: 'right-owner', eligible: true,
      sessionId: 'right-native', evidenceSessions: ['right-native'], backend: 'claude', state: 'ended', reason: 'matched' }));
    const deps = h.getFeedbackCore.mock.calls.at(-1)![1] as { route: (params: unknown) => Promise<unknown> };
    expect(await deps.route({ question: saved.question })).toMatchObject({
      qualified: [candidates[1]], snapshot: { nativeConsult, candidates: [candidates[1]], nativeConsultPool: candidates,
        nativeConsultSources: [expect.objectContaining({ eligible: false }), expect.objectContaining({ eligible: true })] },
    });
    expect(h.routeConsult.mock.calls.at(-1)![0]).toMatchObject({ nativeConsult });
    expect(h.observeNativeConsultSource).toHaveBeenCalledWith(candidates[0], nativeConsult, undefined, saved.workspaceId);
    // The dispatchability filter sees the NATIVE-filtered pool, after it.
    expect(filterDispatchableRoute.mock.calls.at(-1)![0]).toMatchObject({ snapshot: { candidates: [candidates[1]] } });
    expect(filterDispatchableRoute.mock.calls.at(-1)![2]).toEqual({ workspaceId: saved.workspaceId });
  });

  beforeEach(() => vi.clearAllMocks());

  it('persists the server-selected accepting runtime before asynchronous routing', async () => {
    const original = process.env.PAPERCUSP_HONO_PORT;
    const desktop = process.env.OPERATOR_DEV_PORT;
    try {
      process.env.PAPERCUSP_HONO_PORT = '3170';
      delete process.env.OPERATOR_DEV_PORT;
      await acceptFeedbackRequestProd({ workspaceId: 'runtime-workspace', requesterId: 'requester',
        question: 'review current contracts', requestKey: 'runtime-retry' }, { ownerId: 'requester' } as never);
      const saved = h.acceptFeedbackRequestCore.mock.calls[0]![0];
      expect(saved).toMatchObject({ launchOperatorBaseUrl: 'http://localhost:3170' });
      await vi.waitFor(() => expect(h.continueFeedbackRequestCore).toHaveBeenCalled());
    } finally {
      if (original === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = original;
      if (desktop === undefined) delete process.env.OPERATOR_DEV_PORT;
      else process.env.OPERATOR_DEV_PORT = desktop;
    }
  });

  it('restores the saved accepting runtime when another host recovers routing', async () => {
    const original = process.env.PAPERCUSP_HONO_PORT;
    const desktop = process.env.OPERATOR_DEV_PORT;
    try {
      process.env.PAPERCUSP_HONO_PORT = '3271';
      delete process.env.OPERATOR_DEV_PORT;
      await getFeedbackProd({ workspaceId: 'runtime-workspace', requesterId: 'requester',
        question: 'review current contracts', launchOperatorBaseUrl: 'http://localhost:3170' },
      { ownerId: 'requester' } as never, {
        acceptedRequest: { conversation_id: 'runtime-conversation', thread_id: 'runtime-thread', leaseToken: 'lease' },
      });
      expect(h.makeConsultReachDispatcher.mock.calls.at(-1)![0]).toMatchObject({
        launchOperatorBaseUrl: 'http://localhost:3170',
      });
      const deps = h.getFeedbackCore.mock.calls.at(-1)![1] as { resumeInitialDispatch: (id: string) => void };
      deps.resumeInitialDispatch('runtime-conversation');
      expect(h.continueCascadeDispatchProd.mock.calls.at(-1)![2]).toMatchObject({
        launchOperatorBaseUrl: 'http://localhost:3170',
      });
    } finally {
      if (original === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = original;
      if (desktop === undefined) delete process.env.OPERATOR_DEV_PORT;
      else process.env.OPERATOR_DEV_PORT = desktop;
    }
  });

  it('starts accepted initial delivery through the leased continuation under the saved requester', async () => {
    await getFeedbackProd({ workspaceId: 'saved-workspace', requesterId: 'saved-requester', question: 'saved question' },
      { ownerId: 'saved-requester' } as never, { harnessSlug: 'saved-harness',
        acceptedRequest: { conversation_id: 'saved-conversation', thread_id: 'thr-saved-conversation', leaseToken: 'lease' } });
    const deps = h.getFeedbackCore.mock.calls[0]![1] as { resumeInitialDispatch: (id: string) => void };
    expect(h.continueCascadeDispatchProd).not.toHaveBeenCalled();
    deps.resumeInitialDispatch('saved-conversation');
    expect(h.continueCascadeDispatchProd).toHaveBeenCalledWith('saved-workspace', 'saved-conversation', {
      workspaceId: 'saved-workspace', harnessSlug: 'saved-harness', launchedBy: 'saved-requester',
    }, { loadRanks: expect.any(Function) });
    const options = h.continueCascadeDispatchProd.mock.calls[0]![3] as {
      loadRanks: (workspace: string) => Promise<readonly unknown[]>;
    };
    await expect(options.loadRanks('saved-workspace')).resolves.toEqual(h.routingSettings.allowlist);
  });

  it('persists and returns acceptance before embedder/settings acquisition, then resumes the same identity', async () => {
    const result = await acceptFeedbackRequestProd({ workspaceId: 'workspace-1', requesterId: 'requester',
      question: 'slow routing', requestKey: 'retry-key' }, { ownerId: 'requester' } as never,
      { harnessSlug: 'papercusp', allowDispatch: false });
    expect(result).toMatchObject({ verdict: 'accepted', conversation_id: 'accepted-conv', pending: true });
    expect(h.acceptFeedbackRequestCore.mock.calls[0]?.[0]).toMatchObject({
      requestKey: 'retry-key', harnessSlug: 'papercusp', allowDispatch: false,
    });
    expect(h.readConsultExpertRoutingSettings).not.toHaveBeenCalled();
    expect(h.buildQueryEmbedderResolved).not.toHaveBeenCalled();
    expect(h.getFeedbackCore).not.toHaveBeenCalled();
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.continueFeedbackRequestCore).toHaveBeenCalledWith(
      'workspace-1', 'accepted-conv', expect.objectContaining({ execute: expect.any(Function) })));
  });

  it('refuses an invalid bar-critique plan before acceptance persistence or dispatch', async () => {
    const refusal = { error: 'bar_critique_requires_plan', hint: 'exact registered plan required' } as const;
    mockResolvedOnceTyped(h.validateBarCritiquePlanOrigin, refusal);
    const result = await acceptFeedbackRequestProd({ workspaceId: 'workspace-1', requesterId: 'requester',
      question: 'review these bars', policy: 'bar-critique', originTaskRef: 'EI-incident' },
    { ownerId: 'requester' } as never, { harnessSlug: 'papercusp' });
    expect(result).toEqual(refusal);
    expect(h.validateBarCritiquePlanOrigin).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', harnessSlug: 'papercusp', originTaskRef: 'EI-incident',
    }), h.getOrgPg().sql);
    expect(h.acceptFeedbackRequestCore).not.toHaveBeenCalled();
    expect(h.openConversation).not.toHaveBeenCalled();
    expect(h.continueFeedbackRequestCore).not.toHaveBeenCalled();
  });

  it.each([true, false])('passes actual dispatch permission %s to creation without launching when disabled', async (allowDispatch) => {
    await getFeedbackProd(
      { workspaceId: 'workspace-1', requesterId: 'requester', question: 'question' },
      { ownerId: 'requester' } as never,
      { allowDispatch },
    );
    expect(h.getFeedbackCore.mock.calls[0]?.[0]).toMatchObject({ allowDispatch });
    expect(h.makeConsultReachDispatcher).toHaveBeenCalledTimes(allowDispatch ? 1 : 0);
  });

  it('recovers a saved request under its requester and workspace without restoring dispatch permission', async () => {
    h.continueFeedbackRequestCore.mockResolvedValueOnce(true);
    const savedRequest = {
      workspaceId: 'saved-workspace', requesterId: 'saved-requester', question: 'saved question',
      requestKey: 'saved-key', harnessSlug: 'saved-harness', allowDispatch: false,
    };
    const acceptedRequest = {
      conversation_id: 'saved-conversation', thread_id: 'thr-saved-conversation', leaseToken: 'recovery-lease',
    };

    await expect(continueFeedbackRequestProd('saved-workspace', 'saved-conversation')).resolves.toBe(true);
    const [workspace, conversation, deps] = h.continueFeedbackRequestCore.mock.calls[0] as unknown as [
      string, string, { getSql: () => unknown; execute: (request: unknown, accepted: unknown) => Promise<unknown> },
    ];
    expect([workspace, conversation]).toEqual(['saved-workspace', 'saved-conversation']);
    expect(deps.getSql()).toBe(h.getOrgPg().sql);

    await deps.execute(savedRequest, acceptedRequest);
    expect(h.getFeedbackCore.mock.calls[0]?.[0]).toMatchObject(savedRequest);
    expect(h.getFeedbackCore.mock.calls[0]?.[1]).toMatchObject({ acceptedRequest });
    expect(h.makeConsultReachDispatcher).not.toHaveBeenCalled();
    expect(h.acceptFeedbackRequestCore).not.toHaveBeenCalled();
    expect(h.openConversation).not.toHaveBeenCalled();
  });

  it('uses one persisted snapshot for comparison recency and dispatch ranks', async () => {
    await getFeedbackProd(
      { workspaceId: 'workspace-1', requesterId: 'requester', question: 'question', subjectRef: 'acceptance-x' },
      { ownerId: 'requester' } as never,
    );

    expect(h.readConsultExpertRoutingSettings).toHaveBeenCalledTimes(1);

    const deps = h.getFeedbackCore.mock.calls[0]?.[1] as {
      route: (params: unknown) => Promise<unknown>;
      reach: (params: unknown) => Promise<unknown>;
    };
    await deps.route({
      workspaceId: 'workspace-1',
      requesterId: 'requester',
      question: 'question',
      subjectRef: 'acceptance-x',
    });
    const routeParams = h.routeConsult.mock.calls[0]?.[0] as {
      recencyHalfLifeDays?: number;
      subjectRef?: string | null;
      telemetry?: { caller: string; policy: string; buildSha: string | null };
    };
    expect(routeParams.recencyHalfLifeDays).toBe(14);
    expect(routeParams.subjectRef).toBe('acceptance-x');
    expect(routeParams.telemetry).toMatchObject({ caller: 'consult:get_feedback', policy: 'consult-default' });

    const routeDeps = h.routeConsult.mock.calls[0]?.[1] as {
      getLiveness?: (ownerIds: string[]) => Promise<unknown>;
    };
    h.resolveSessionStates.mockResolvedValue(new Map());
    h.listLoopStanddownOwners.mockResolvedValue(new Set());
    await routeDeps.getLiveness?.(['expert-a', 'expert-b']);
    expect(h.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'expert-a' }, { ownerId: 'expert-b' }],
      { hydrateBatch: true, psuHostPositiveAuthority: true },
    );

    await deps.reach({ responder: 'expert', conversationId: 'conversation', summary: 'summary', body: 'body' });
    const dispatchDeps = h.makeConsultReachDispatcher.mock.calls[0]?.[1] as {
      loadRanks: (workspaceId: string) => Promise<readonly unknown[]>;
    };
    await expect(dispatchDeps.loadRanks('workspace-1')).resolves.toEqual(h.routingSettings.allowlist);
  });
});

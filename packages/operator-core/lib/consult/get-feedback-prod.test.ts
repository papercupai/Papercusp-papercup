import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    continueFeedbackRequestCore: vi.fn(async (_workspace: string, _conversation: string, _deps: unknown) => false),
    getOrgPg: vi.fn(() => ({ sql })),
    buildQueryEmbedderResolved: vi.fn(async () => null),
    interactiveEmbedAcquireBudgetMs: vi.fn(() => 10),
    resolveProseProfileSelection: vi.fn(),
    resolveSessionStates: vi.fn(),
    listLoopStanddownOwners: vi.fn(),
    openConversation: vi.fn(),
    routeConsult: vi.fn(async (_params: unknown, _deps: unknown) => ({ verdict: 'no_qualified_responder' })),
    makeConsultReachDispatcher: vi.fn((_context: unknown, _deps: unknown) => async () => ({})),
    observeNativeConsultSource: vi.fn(async (_candidate: unknown, _constraint: unknown) => ({})),
    readConsultExpertRoutingSettings: vi.fn(async () => routingSettings),
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: h.getOrgPg,
}));
vi.mock('./get-feedback-core', () => ({ getFeedbackCore: h.getFeedbackCore,
  acceptFeedbackRequestCore: h.acceptFeedbackRequestCore, continueFeedbackRequestCore: h.continueFeedbackRequestCore }));
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
  observeNativeConsultSource: h.observeNativeConsultSource }));
vi.mock('./expert-routing-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./expert-routing-settings')>();
  return { ...actual, readConsultExpertRoutingSettings: h.readConsultExpertRoutingSettings };
});

import { acceptFeedbackRequestProd, continueFeedbackRequestProd, getFeedbackProd } from './get-feedback-prod';

describe('getFeedbackProd expert-routing settings', () => {
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

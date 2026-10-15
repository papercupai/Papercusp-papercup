/** Shared production binding for consult lifecycle consumers. No tool recursion. */
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { getBuildInfo } from '../build-info';
import { recordExpertiseRoutingInvocation } from '../endpoint-route/telemetry';
import { CONSULT_DEFAULT_POLICY } from './selection-policies';
import type { AcceptedFeedbackResult, GetFeedbackDeps, GetFeedbackRequest } from './get-feedback-core';

export interface GetFeedbackProdOptions {
    acceptedRequest?: GetFeedbackDeps['acceptedRequest'];
    harnessSlug?: string | null;
    filterRoute?: (route: Awaited<ReturnType<GetFeedbackDeps['route']>>) => Promise<Awaited<ReturnType<GetFeedbackDeps['route']>>>;
    /**
     * D-002: let a caller that only wants RETRIEVAL prevent any launch side
     * effect. Absent/true binds the fork/convert dispatcher; false returns the
     * ranked retrieval menu without entering the dispatch/cascade path. The
     * core reports `retrieval_only`, never a failed launch.
     *
     * (Named `allowRevival` before the dispatcher replaced revive-in-place; the
     * question it answers — "may this consult start a process?" — is unchanged.)
     */
    allowDispatch?: boolean;
}

export interface AcceptFeedbackRequestProdOptions extends Pick<GetFeedbackProdOptions, 'harnessSlug' | 'allowDispatch'> {
    /**
     * Runs after the request row is durable and before the async continuation
     * can dispatch a responder. Hard-blocked callers use this to register the
     * reply waiter before a fast responder can emit it.
     */
    onAccepted?: (accepted: AcceptedFeedbackResult) => Promise<void> | void;
}

export async function acceptFeedbackRequestProd(
  request: GetFeedbackRequest, identity: AgentIdentity,
    options: AcceptFeedbackRequestProdOptions = {},
) {
    const [{ getOrgPg }, { acceptFeedbackRequestCore }, conversations, { publicManualSource }, { expertiseSubject }] = await Promise.all([
      import('@papercusp/db-org'), import('./get-feedback-core'), import('../agent-tools/coordination/conversations'),
      import('../agent-tools/docs/_public-manual'), import('./relevance-router'),
    ]);
    const sourceRefs = request.subjectRefs?.length ? request.subjectRefs :
      expertiseSubject(request.question) ? [expertiseSubject(request.question)!] : [];
    const subjectExpansion = sourceRefs.length ? await publicManualSource().expandSubjectRefs(sourceRefs) : null;
    const payload = { ...request, harnessSlug: request.harnessSlug || options.harnessSlug || undefined,
      allowDispatch: options.allowDispatch !== false,
      ...(subjectExpansion ? {
        resolvedSubjectRefs: subjectExpansion.refs,
        unresolvedSubjectRefs: subjectExpansion.unresolvedDocuments,
      } : {}) };
    const accepted = await acceptFeedbackRequestCore(payload, {
      getSql: () => getOrgPg().sql,
      open: async (input) => {
        const result = await conversations.openConversation(identity, { ...input, producer: 'consult:get_feedback' });
        return { conversation_id: result.conversation.id, thread_id: result.thread_id, delivered: result.delivered };
      },
    });
    if (!('error' in accepted)) {
      // Registration must finish before the continuation starts: its responder
      // can post the first reply during dispatch, before this function returns.
      await options.onAccepted?.(accepted);
      if (accepted.state === 'routing') {
        // The durable row, not this promise, owns recovery after process death.
        void continueFeedbackRequestProd(request.workspaceId, accepted.conversation_id).catch(() => {});
      }
    }
    return accepted;
}

export async function getFeedbackProd(
  request: GetFeedbackRequest, identity: AgentIdentity, options: GetFeedbackProdOptions = {},
) {
  const [
    { getOrgPg }, { getFeedbackCore }, { routeConsult }, { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs },
    { resolveProseProfileSelection },
    { resolveSessionStates }, { listLoopStanddownOwners }, conversations, { makeConsultReachDispatcher },
    { readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings },
  ] = await Promise.all([
    import('@papercusp/db-org'), import('./get-feedback-core'), import('./relevance-router'),
    import('../agent-tools/search/embedder'), import('../search/prose-vector-dims'),
    import('../agent-tools/coordination/liveness-oracle'),
    import('../harness/routines/release-pause-ttl'),
    import('../agent-tools/coordination/conversations'),
    import('./consult-dispatch'),
    import('./expert-routing-settings'),
  ]);
  // This is an interactive MCP path, so a cold/local or rate-limited embedder
  // must degrade to the lexical fallback before the ~55s transport deadline.
  // The shared helper keeps this budget aligned with the other interactive
  // query surfaces (WI-3922); the losing acquisition continues warming the
  // process for a later consult.
  const dispatchDisabled = options.allowDispatch === false;
  // P-005: the PERSISTED expert-routing settings, read ONCE per consult. Once,
  // deliberately: the ranking half-life and the dispatcher's allowlist are two
  // halves of one policy, so re-reading per seam would let a mid-consult settings
  // edit rank against one policy and dispatch against another.
  const routingSettings = await readConsultExpertRoutingSettings(request.workspaceId);
  const expertRouting = bindConsultExpertRoutingSettings(routingSettings);
  const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() });
  const embed = resolved?.embed ?? null;
  const embeddingProfile = resolved
    ? resolveProseProfileSelection(resolved.mode, resolved.profile)
    : null;
  return getFeedbackCore({ ...request, allowDispatch: !dispatchDisabled }, {
    ...(options.acceptedRequest ? { acceptedRequest: options.acceptedRequest } : {}),
    getSql: () => getOrgPg().sql,
    route: async (params) => {
      const routed = await routeConsult({
        ...params,
        ...(request.nativeConsult ? { nativeConsult: request.nativeConsult } : {}),
        telemetry: { caller: 'consult:get_feedback', policy: request.policy ?? CONSULT_DEFAULT_POLICY, buildSha: getBuildInfo().sha },
        // ⚠ STAGE-2 ONLY [owner 2026-09-22]: "recently should only be considered
        // when comparing... If we have like any expert floor that an agent has to
        // pass, the recency shouldnt be considered for this." This tunes how
        // qualified candidates are RANKED against each other; it never gates
        // qualification, so time away cannot strip an agent of expert status.
        recencyHalfLifeDays: expertRouting.recencyHalfLifeDays,
      }, {
        recordTelemetry: receipt => recordExpertiseRoutingInvocation(receipt, getOrgPg().sql),
        getSql: () => getOrgPg().sql,
        embed,
        embeddingProfile,
        embeddingMode: embeddingProfile && resolved ? resolved.mode : null,
        getLiveness: async (ownerIds) => {
          const [verdicts, pausedOwners] = await Promise.all([
            resolveSessionStates(ownerIds.map((ownerId) => ({ ownerId })), {
              hydrateBatch: true,
              psuHostPositiveAuthority: true,
            }),
            listLoopStanddownOwners(getOrgPg().sql, { workspaceId: request.workspaceId }),
          ]);
          return Object.fromEntries([...verdicts.values()].map((v) => [v.ownerId, {
            sessionState: v.sessionState,
            ...(typeof v.warmIdle === 'boolean' ? { warmIdle: v.warmIdle } : {}),
            ...(pausedOwners.has(v.ownerId) ? { ownerPaused: true } : {}),
          }]));
        },
      });
      let constrained = routed;
      if (request.nativeConsult) {
        const [{ filterNativeConsultRoute }, { observeNativeConsultSource }] = await Promise.all([
          import('./native-consult'), import('./consult-dispatch'),
        ]);
        constrained = await filterNativeConsultRoute(routed, request.nativeConsult,
          candidate => observeNativeConsultSource(candidate, request.nativeConsult!, undefined, request.workspaceId));
      }
      // WI-6554700010009982: a ranked source whose transcript is gone (no
      // native file, no archive) can never be dispatched; keep it off the menu.
      if (!dispatchDisabled) {
        const { filterDispatchableRoute, probeConsultSourceDispatchable } = await import('./source-dispatchability');
        constrained = await filterDispatchableRoute(constrained, probeConsultSourceDispatchable, {
          workspaceId: request.workspaceId,
        });
      }
      return options.filterRoute ? options.filterRoute(constrained) : constrained;
    },
    open: async (input) => {
      const opened = await conversations.openConversation(identity, {
        ...input, producer: 'consult:get_feedback',
      });
      return { conversation_id: opened.conversation.id, thread_id: opened.thread_id, delivered: opened.delivered };
    },
    // D-002/D-010: the DELIVERY seam is the fork/convert walk, not notifyAgents.
    // A consult never pings or wakes a live agent — it launches a new session
    // from the routed expert's transcript. `notifyAgents` is deliberately no
    // longer imported here, so this binding cannot silently regain a wake.
    reach: dispatchDisabled
      ? async () => ({ queued: 0, woke: 0, pickupConfirmed: false, answeringOwnerId: null })
      : makeConsultReachDispatcher({
          workspaceId: request.workspaceId,
          harnessSlug: request.harnessSlug?.trim() || options.harnessSlug || null,
          launchedBy: identity.ownerId,
          // P-005: the walk order is the PERSISTED allowlist (D-004), not the
          // hardcoded seed. loadExpertModelRanks returns null when nothing usable
          // is stored, which lets resolveExpertModelAllowlist fall back to the
          // owner-stated seed on its own terms.
        }, { loadRanks: expertRouting.loadRanks }),
  });
}

/** Existing sweep calls this under the row's saved requester/workspace, with
 * no tool recursion and no new launch mechanism. */
export async function continueFeedbackRequestProd(workspaceId: string, conversationId: string): Promise<boolean> {
  const [{ getOrgPg }, { continueFeedbackRequestCore }] = await Promise.all([
    import('@papercusp/db-org'), import('./get-feedback-core'),
  ]);
  return continueFeedbackRequestCore(workspaceId, conversationId, {
    getSql: () => getOrgPg().sql,
    execute: async (request, acceptedRequest) => getFeedbackProd(request,
      { ownerId: request.requesterId, workspaceId } as AgentIdentity,
      { acceptedRequest, harnessSlug: request.harnessSlug, allowDispatch: request.allowDispatch }),
  });
}

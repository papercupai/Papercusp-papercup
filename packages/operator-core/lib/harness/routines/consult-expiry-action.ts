/**
 * `system:consult-expiry-sweep` — the consult lifecycle expiry sweep's
 * routine-engine registration (get-feedback-relevance-consults-2026-08-16
 * P-005 / D-005).
 *
 * This module is now WIRING ONLY. Two layers sit beneath it, and both are reachable
 * from a test:
 *   - the sweep logic in `../../consult/consult-expiry-core.ts` (pure, integration-
 *     tested against the real migration-834 tables);
 *   - the production adapters in `../../consult/consult-expiry-adapters.ts`, which
 *     bind that core to org PG, the awaited-event engine, the durable requester
 *     alert, and the D-002 fork/convert dispatcher.
 *
 * The adapters used to be lambdas inside the `registerSystemAction` closure below,
 * where no test could execute them — only pin their source text (EI-21559794492221235).
 * They carry real per-row workspace-threading decisions, so that blind spot was load
 * bearing; see the adapters module's header for what each one actually decides.
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine (300s cadence) by
 * `seed-consult-expiry-routine.ts` — an operator-HOME-level substrate concern
 * (one sweep serves every workspace's consult rows), not a per-blueprint-install
 * one; mirrors `supervision-reconcile-action.ts`'s documented deviation.
 */
import { statSync } from 'node:fs';
import { registerSystemAction } from './system-actions';
import { PgThreadStore } from '@papercusp/coordination/capabilities';

registerSystemAction('consult-expiry-sweep', async () => {
  const [
    { getOrgPg },
    { sweepExpiredConsults },
    { emitAwaitedEvent },
    {
      consultExpiryEmitReplyEvent,
      consultExpiryFindSilentResponders,
      consultExpiryRejudgeAnsweringTask,
      consultExpiryNotifyRequester,
      consultExpiryDispatch,
      consultExpiryFileReviewWorkItem,
      consultExpiryStopAnsweringSession,
    },
    { makeConsultReachDispatcher, rejudgeFirstTurn },
    { upsertConditionWorkItem },
    { listLiveTasks, listTasks },
    { killTask },
  ] = await Promise.all([
    import('@papercusp/db-org'),
    import('../../consult/consult-expiry-core'),
    import('../../events/await/engine'),
    import('../../consult/consult-expiry-adapters'),
    import('../../consult/consult-dispatch'),
    import('../../coord/condition-upsert'),
    import('../../task-manager/store'),
    import('../../task-manager/control'),
  ]);

  await sweepExpiredConsults({
    getSql: () => getOrgPg().sql,
    resumeCascadeDispatch: async (workspaceId, conversationId) => {
      const { continueCascadeDispatchProd } = await import('../../consult/consult-dispatch');
      return continueCascadeDispatchProd(workspaceId, conversationId);
    },
    resumeRequest: async (workspaceId, conversationId) => {
      const { continueFeedbackRequestProd } = await import('../../consult/get-feedback-prod');
      return continueFeedbackRequestProd(workspaceId, conversationId);
    },
    // P-003 (WI-10003199): a slot whose window closes without a post has its
    // answering session stopped here, at the transition, instead of idling until
    // the task reaper's next pass; the reaper remains the backstop.
    stopAnsweringSession: consultExpiryStopAnsweringSession({
      listLiveTasks: (workspaceId) => listLiveTasks(workspaceId),
      killTask: (taskId) => killTask(taskId),
    }),
    emitReplyEvent: consultExpiryEmitReplyEvent(emitAwaitedEvent),
    notifyRequester: consultExpiryNotifyRequester(async (identity, opts) => {
      const { sendMessage } = await import('../../agent-tools/coordination/messages');
      return sendMessage(identity, opts);
    }),
    // D-002/D-011: the sweep DISPATCHES the next selectee (fork/convert from
    // their transcript) instead of waking them. notifyAgents is no longer on
    // this binding at all, so the sweep cannot silently regain a wake.
    dispatch: consultExpiryDispatch((ctx) => makeConsultReachDispatcher(ctx)),
    // EI-27111739698817170: a first reply that lands after the dispatcher's
    // first-turn window is judged here by the dispatcher's own classifier, so a
    // late provider refusal (model_not_found, a usage wall) advances the cascade
    // instead of holding the slot until bounded pickup recovery.
    rejudgeFirstTurn: (unjudged) => rejudgeFirstTurn(unjudged),
    // P-014: a silent review consult at half its TTL becomes a pullable work item
    // (filed in the consult's harness, else the workspace's home pot) instead of
    // cascading to another silent responder.
    fileReviewWorkItem: consultExpiryFileReviewWorkItem({
      upsert: upsertConditionWorkItem,
      resolveHarness: async (workspaceId, conversationId) => {
        const rows = (await getOrgPg().sql`
          SELECT harness_slug FROM harness_shared.coord_conversations
           WHERE workspace_id = ${workspaceId} AND id = ${conversationId}
        `) as unknown as Array<{ harness_slug: string | null }>;
        if (rows[0]?.harness_slug) return rows[0].harness_slug;
        const { resolveHomePotSlug } = await import('../../agent-tools/pot/_resolve');
        return resolveHomePotSlug(workspaceId);
      },
    }),
    findSilentResponders: consultExpiryFindSilentResponders({
      rejudgeAnsweringTask: consultExpiryRejudgeAnsweringTask({
        resolveResumeTarget: async (ref) => (await import('../../agent-launch-core')).resolveResumeTarget(ref),
        checkTranscript: async (target) =>
          (await import('../../consult/resume-transcript-preflight')).checkConsultResumeTranscript(target),
        rejudgeFirstTurn,
      }),
      listAnsweringTasks: async (workspaceId, answeringOwnerId) => {
        const filter = { workspaceId, coordOwnerId: answeringOwnerId, classes: ['agent-session'], limit: 20 };
        // Read live rows separately so a capped terminal-history window cannot
        // hide a live sibling of an older failed launch.
        const [history, live] = await Promise.all([
          listTasks({ ...filter, includeEnded: true }),
          listTasks(filter),
        ]);
        return [...new Map([...history, ...live].map((task) => [task.taskId, task])).values()];
      },
      statMtimeMs: (path) => {
        try {
          return statSync(path).mtimeMs;
        } catch {
          return null;
        }
      },
      getPresence: async (ownerId) => {
        const { getPresence } = await import('../../agent-tools/coordination/presence');
        return getPresence(ownerId);
      },
      resolveSessionStates: async (subjects, opts) => {
        const { resolveSessionStates } = await import('../../agent-tools/coordination/liveness-oracle');
        return resolveSessionStates(subjects, opts);
      },
      getCarryRespawnOutcome: async (ownerId) => {
        const { readPriorRespawnOutcome } = await import('../../carry-respawn-outcome');
        return readPriorRespawnOutcome(ownerId);
      },
      getThreadStore: (workspaceId) =>
        new PgThreadStore({
          getSql: () => getOrgPg().sql,
          ensureSchema: async () => {},
          workspaceId,
        }),
    }),
  });

  // consult-backed-parking-2026-10-12 P-006: resolve decision-review parks past their
  // deadline (R-5/R-17) and read back owner answers to open park questions (R-18). Its
  // own try: a park fault must never cost the expiry sweep above its tick.
  try {
    const sql = getOrgPg().sql as never;
    const [{ sweepDueParks, pollParkOwnerAnswers }, { makeProdParkSeams, readParkOwnerAnswer }] = await Promise.all([
      import('../../consult/park-adapters'),
      import('../../consult/park-prod'),
    ]);
    const seamsFor = (workspaceId: string) => makeProdParkSeams(sql, workspaceId);
    await pollParkOwnerAnswers({ sql, seamsFor, readAnswer: readParkOwnerAnswer });
    await sweepDueParks({ sql, seamsFor });
  } catch (e) {
    console.warn(`[consult-expiry-sweep] park sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Park verdict delivery (R-7/R-20/R-21) in its own try: a delivery fault must not cost
  // the deadline resolution above, and the reverse.
  try {
    const sql = getOrgPg().sql as never;
    const { sweepParkDeliveries } = await import('../../consult/park-delivery-prod');
    const r = await sweepParkDeliveries({ sql });
    for (const f of r.failures) {
      console.warn(`[consult-expiry-sweep] park delivery check failed for ${f.conversationId}: ${f.error}`);
    }
  } catch (e) {
    console.warn(`[consult-expiry-sweep] park delivery sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

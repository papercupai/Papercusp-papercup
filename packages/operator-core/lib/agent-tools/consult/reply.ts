/**
 * consult:reply — post a TYPED reply into a consult thread (plan
 * get-feedback-relevance-consults-2026-08-16, P-004).
 *
 * PROD BINDING ONLY — all verb logic lives in lib/consult/consult-verbs-core.ts
 * (core/binding split, mirrors get-feedback.ts). This file wires the prod
 * seams: post → conversations.postReply (with the internal via_consult_verb
 * kind-gate opt-in), emitReplyEvent → emitAwaitedEvent (latched park key),
 * reach → notifyAgents (requester-follow-up wake; unconditional — the wake
 * budget is removed, consult-min-max-and-rubric-vetting-2026-08-17 D-005).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { resolveAgentIdentity } from '../coordination/identity';
import type { IdleRecipientReport } from '../coordination/inbox-wake';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import { lookupEndedSessions } from '../coordination/dead-session-recipient-guidance';
import { hardText } from '../limits';
import { consultPostAbortCompletionReceipt } from './abort-completion';
import { DECISION_REVIEW_POSITIONS, OBJECTION_BASES, OWNER_AUTHORITY_TOPICS } from '../../consult/decision-review';
import { reviewAnswerSchema, reviewDispositionsSchema } from '../../consult/review-findings';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

/** A follow-up may reroute only on a complete, positive ended-session verdict. */
export function isConfirmedDeadConsultResponder(
  report:
    | (Pick<IdleRecipientReport, 'confirmedDead' | 'degraded'> &
        Partial<Pick<IdleRecipientReport, 'live' | 'aliveNotWakeable' | 'dormantScheduled'>>)
    | null
    | undefined,
  responder: string,
  endedSessions?: ReadonlyMap<string, string | null>,
): boolean {
  const currentlyActionable =
    report?.live?.includes(responder) === true ||
    report?.aliveNotWakeable?.includes(responder) === true ||
    report?.dormantScheduled?.some(({ ownerId }) => ownerId === responder) === true;
  if (currentlyActionable) return false;
  return (
    endedSessions?.has(responder) === true ||
    (report?.degraded !== true && report?.confirmedDead?.includes(responder) === true)
  );
}

/** Delivery counts cannot replace a fresh verdict for the answering identity. */
export async function measureConsultFollowupReach(
  responder: string,
  notify: () => Promise<{ woke: number }>,
  readLiveness: () => Promise<{
    report: Parameters<typeof isConfirmedDeadConsultResponder>[0];
    endedSessions: ReadonlyMap<string, string | null>;
  }>,
): Promise<{ woke: number; confirmedDead: boolean }> {
  const delivery = await notify();
  const { report, endedSessions } = await readLiveness();
  return { woke: delivery.woke, confirmedDead: isConfirmedDeadConsultResponder(report, responder, endedSessions) };
}

/**
 * The handler writes the consult post before finishing its remaining work. If the
 * handler returns after the tool deadline, preserve the completed reply identity so
 * the caller does not mistake a committed post for a safe retry. This does not make
 * the non-idempotent post globally idempotent.
 */
export function consultReplyAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
): ReturnType<typeof consultPostAbortCompletionReceipt> {
  return consultPostAbortCompletionReceipt(args, result, 'consult:reply');
}

const evidenceRef = z.object({
  session_id: z.string().min(1),
  turn_idx: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

export default defineTool({
  name: 'consult:reply',
  description:
    'Post a TYPED reply into a consult thread. Responder kinds: answer (evidence REQUIRED — cite the transcript turns), clarifying_question, new_fact. Requester follow-up kinds: question, new_fact. On an undelivered consult with a saved reviewer menu, requester new_fact continues its finite cascade through untried reviewers. Untyped posts into a consult are refused (conversations:post will not work); the exchange cap binds — at the cap, close instead.',
  guidance: {
    when:
      'You were routed a consult (a 🧭 wake naming a conversation) and are answering/clarifying from your own transcript — or you are the requester following up.',
    notWhen:
      "Your context does not cover it but another reviewer might → consult:decline (cheap, honest). Settled, or the QUESTION is void (duplicate, inadmissible, already settled) → consult:close { outcome:'cant_help', reason }: terminal and non-advancing, where EVERY reply kind advances and spends the next reviewer. A non-consult conversation → conversations:post.",
    chaining:
      'READ THE THREAD FIRST: conversations:get { id } — there is NO consult:read, and a wrong-door read returns EMPTY, which looks exactly like a thread with no replies (a reviewer answered without the requester\'s posts that way). → validate relevance (sessions:read the cited evidence) → consult:reply { kind } → when settled, consult:close { outcome }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  // Reply handling persists the post, then waits for the requester signal and
  // (for a responder perspective) cascade dispatch. The nested tools:invoke
  // transport otherwise cuts this off at 55s, before the target's completion
  // receipt can identify a post that already landed. Keep enough budget for
  // that synchronous delivery path; the MCP nested deadline adds its 5s buffer.
  timeoutSec: 120,
  abortCompletionReceipt: consultReplyAbortCompletionReceipt,
  args: z
    .object({
      conversation_id: z.string().min(1).describe('The consult conversation (from the wake / get_feedback result).'),
      kind: z
        .enum(['answer', 'clarifying_question', 'new_fact', 'question'])
        .describe('Responder: answer | clarifying_question | new_fact. Requester follow-up: question | new_fact.'),
      body: hardText(8000),
      review: reviewAnswerSchema.optional().describe('Responder answer: preserve findings with the reviewed subject/revision and coverage. Stable finding ids are returned.'),
      reviewDispositions: reviewDispositionsSchema.optional().describe('Requester new_fact: disposition stored finding ids without overwriting reviewer evidence. Planned obligations may proceed to implementation.'),
      evidence: z
        .array(evidenceRef)
        .max(16)
        .optional()
        .describe('Transcript grounding [{ session_id, turn_idx, note? }] — REQUIRED for kind=answer (D-004).'),
      stance: z
        .object({
          position: z.enum(DECISION_REVIEW_POSITIONS),
          basis: z.enum(OBJECTION_BASES).optional(),
          reason: z.string().max(2000).optional(),
          alternative: z.string().max(2000).optional(),
          evidence: z.array(z.string().min(1).max(500)).max(16).optional(),
          topic: z.enum(OWNER_AUTHORITY_TOPICS).optional(),
        })
        .optional()
        .describe(
          "Decision-review consults (a parked product decision) ONLY, and REQUIRED there on every reviewer reply: support | no-view, or object with basis 'alternative' (reason + alternative), 'hazard' (reason + evidence refs) or 'owner-authority' (topic).",
        ),
      parkResponse: z
        .object({
          kind: z.enum(['adopt', 'rebut']),
          text: z.string().min(1).max(4000),
          objectionId: z.string().min(1).max(200).optional(),
        })
        .optional()
        .describe(
          "Parked agent (requester of a decision review) ONLY: answer an objection — adopt (take the alternative) or rebut (keep your default, with reasoning). Omitting objectionId answers the latest standing objection.",
        ),
    })
    .refine((a) => a.kind !== 'answer' || (a.evidence?.length ?? 0) > 0, {
      message: 'kind=answer requires evidence — cite the transcript turns the answer rests on',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Heavy prod seams — imported per-call, never at registration.
    const [{ getOrgPg }, { consultReplyCore }, conversations, { notifyAgents }, { makeDeferredConsultReachDispatcher }, { reportIdleRecipients }] =
      await Promise.all([
        import('@papercusp/db-org'),
        import('../../consult/consult-verbs-core'),
        import('../coordination/conversations'),
        import('../coordination/notify-agents'),
        import('../../consult/consult-dispatch'),
        import('../coordination/inbox-wake'),
      ]);

    // Same partition resolver as the conversation writes (WI-1571).
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );

    const result = await consultReplyCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        kind: args.kind,
        body: args.body,
        review: args.review,
        reviewDispositions: args.reviewDispositions,
        evidence: args.evidence,
        stance: args.stance,
        parkResponse: args.parkResponse,
      },
      {
        getSql: () => getOrgPg().sql,
        post: (input) => conversations.postReply(identity, input),
        emitReplyEvent: async (e) => {
          await import('../../events/await/engine')
            .then(({ emitAwaitedEvent }) => emitAwaitedEvent({ ...e, source: identity.ownerId }))
            .catch(() => {});
        },
        // D-011 seam 1 of 2: the requester's follow-up, addressed to the
        // session ALREADY answering this consult (consult-verbs-core resolves
        // the answering identity). That session is our own worker, so this is
        // the ONE consult delivery that legitimately notifies a live agent.
        reach: (opts) => measureConsultFollowupReach(opts.responder, () => notifyAgents(identity, {
            addressees: [opts.responder],
            objectRef: { kind: 'conversation', ref: opts.conversationId },
            summary: opts.summary,
            body: opts.body,
            wake: true,
          }), async () => {
          // A queued wake is not pickup. Even a positive count may address an
          // ended answering session; measure its current liveness separately.
          const [report, endedSessions] = await Promise.all([
            reportIdleRecipients([opts.responder], {
              workspaceId: identity.workspaceId ?? undefined,
            }),
            // coord:send's `unknown_recipient` diagnosis uses this same
            // adv_sessions.ended_at evidence. The liveness report can remain
            // inconclusive when that exact ended fork is absent from the live
            // roster, so preserve the terminal record as an independent signal.
            lookupEndedSessions([opts.responder], identity.workspaceId),
          ]);
          return { report, endedSessions };
        }),
        // D-011 seam 2 of 2: a cascade advance addresses an expert who is NOT
        // in this conversation — fork/convert a fresh answering session from
        // their transcript, never a wake.
        dispatch: makeDeferredConsultReachDispatcher({
          workspaceId,
          harnessSlug: ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null,
          launchedBy: identity.ownerId,
        }),
        // consult-backed-parking P-006 (R-6/R-16): resolve the park after the reply.
        onDecisionReviewReply: async ({ workspaceId: ws, conversationId, now }) => {
          const [{ runParkTriggersForConsult }, { makeProdParkSeams }] = await Promise.all([
            import('../../consult/park-adapters'),
            import('../../consult/park-prod'),
          ]);
          const sql = getOrgPg().sql;
          await runParkTriggersForConsult(sql, ws, conversationId, makeProdParkSeams(sql, ws), now);
        },
      },
    );
    return ok(result as unknown as Record<string, unknown>);
  },
});

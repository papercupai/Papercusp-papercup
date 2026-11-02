/**
 * consult:transfer — hand off only plan-start follow-up authority from a
 * confirmed-ended requester session to the current superuser session.
 * The original requester_id remains unchanged for historical attribution.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { hardText } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'consult:transfer',
  description:
    'Transfer a consult\'s plan-start follow-up authority to the current superuser session when its current requester/delegate is confirmed ended. The original requester_id and consult history remain unchanged; this does not reopen a settled consult.',
  guidance: {
    when:
      'A saved consult follow-up must continue in this superuser session after the current follow-up owner is confirmed ended. Transfer authority before passing consult_id to plans:start.',
    notWhen:
      'The current requester is live, the consult is still routing, or the caller cannot establish the ended-session record. This is not a way to reopen a closed consult or transfer authority to a different target.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    conversation_id: z.string().min(1).describe('Full consult conversation id or a unique prefix.'),
    reason: hardText(2000).refine((value) => Boolean(value.trim()), 'reason must not be blank')
      .describe('Why this superuser session is taking over the saved plan-start follow-up.'),
  }),
  async handler(args, ctx) {
    if (ctx.isSuperuser !== true) {
      return ok({ ok: false, error: 'superuser_required', hint: 'Only a superuser may transfer requester follow-up authority.' });
    }
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, { consultTransferRequesterFollowupCore }, conversations, { lookupEndedSessions }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-verbs-core'),
      import('../coordination/conversations'),
      import('../coordination/dead-session-recipient-guidance'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await consultTransferRequesterFollowupCore({
      workspaceId,
      authorId: identity.ownerId,
      conversationId: args.conversation_id,
      reason: args.reason,
    }, {
      getSql: () => getOrgPg().sql,
      isSuperuser: ctx.isSuperuser === true,
      requesterEnded: async (requesterId) =>
        (await lookupEndedSessions([requesterId], workspaceId)).has(requesterId),
    });
    return ok(result as unknown as Record<string, unknown>);
  },
});

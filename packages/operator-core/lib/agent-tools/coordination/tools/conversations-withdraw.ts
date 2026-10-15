/**
 * conversations:withdraw — the asker retracts one OR many open questions that no
 * longer need an answer, without inventing an answer (conversations:resolve) or
 * opening a replacement (conversations:supersede). The row moves open → closed
 * by compare-and-set, the reason is posted to the thread, subscribers are told,
 * and the question's answer awaits plus any ask-owner escalation twin are
 * retired. Nothing is captured to memory and conversation:answered never fires.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { withdrawConversation } from '../conversations';
import { runBulk, bulkContent } from '../../_bulk';
import { hardText } from '../../limits';

const itemSpec = z.object({
  id: z.string().min(1).describe('conversation id (alias: conversation_id)'),
  conversation_id: z.string().min(1).optional().describe('alias for id'),
  reason: hardText(2000).describe('Why no answer is needed any more; posted to the thread.'),
});

const ERROR_HINTS: Record<string, string> = {
  not_owner: 'Only the agent that asked can withdraw it; ask that agent instead.',
  consult_requires_typed_verb: 'Consults close through consult:close.',
  already_terminal: 'It is no longer open; nothing to withdraw.',
};

export default defineTool({
  name: 'conversations:withdraw',
  description:
    'Withdraw one OR many of YOUR open questions that no longer need an answer: no answer is recorded, no replacement is opened. State becomes closed, the reason is posted to the thread, subscribers are notified, and answer awaits plus any ask-owner escalation are retired. Single: { id, reason }. Many: items:[{ id, reason }]. Asker-only; consults use consult:close.',
  guidance: {
    when:
      'You asked a question (coord:ask-owner, coord:ask, conversations:open) and it became moot: you resolved it yourself, the work was dropped, or the premise vanished, and no replacement question is needed.',
    notWhen:
      'It was answered → conversations:resolve. The question is still needed in a corrected form → conversations:supersede. Someone else asked it → ask them.',
    chaining: 'conversations:get → conversations:withdraw { id, reason }.',
    seeAlso: [
      'conversations:supersede (retract AND replace)',
      'conversations:resolve (record an answer)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-withdraw shorthand: the conversation id'),
      conversation_id: z.string().min(1).optional().describe('alias for id'),
      reason: hardText(2000).optional().describe('why no answer is needed any more (required)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('withdraw many conversations, each with its own reason'),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.conversation_id),
      { message: 'pass { id, reason } for one, or items:[{ id, reason }] for many' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({ id: it.id ?? (it.conversation_id as string), reason: it.reason }))
      : [{ id: (args.id ?? args.conversation_id) as string, reason: args.reason }];
    const env = await runBulk(
      list,
      async (it) => {
        if (!it.reason?.trim()) return { ok: false as const, id: it.id, error: 'need_reason' };
        const result = await withdrawConversation(identity, { conversation_id: it.id, reason: it.reason });
        if ('error' in result) {
          return {
            ok: false as const,
            id: it.id,
            error: result.error,
            ...('state' in result ? { state: result.state } : {}),
            ...(ERROR_HINTS[result.error] ? { hint: ERROR_HINTS[result.error] } : {}),
          };
        }
        return {
          ok: true as const,
          id: result.conversation.id,
          state: result.conversation.state,
          reason_post_id: result.reasonPostId,
          notified_subscribers: result.delivered,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});

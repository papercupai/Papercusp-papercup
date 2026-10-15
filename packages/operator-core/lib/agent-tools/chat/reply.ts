import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { replyToCanonicalChat, replyToTriggerRun } from '../../capability-verbs/chat';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'chat:reply',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Reply in the thread of one chat message the owner already has, named by its canonical messageId. You supply TEXT ONLY: the server resolves channel and thread from the stored message, so this tool cannot post somewhere else or read the token. Provider-neutral (Slack today).',
  guidance: {
    when: 'The owner asks you to answer a specific chat message or thread (personal:search → externalId as messageId), or a chat-triggered plan run says to respond (pass its planRunId; posts once).',
    notWhen:
      'Posting into a channel you name yourself — that is chat:post, which checks the destination. Not for email (mail:reply).',
    chaining: 'personal:search → externalId → chat:reply. Report the echoed channelId/threadId as evidence.',
  },
  args: z
    .object({
      messageId: z.string().trim().min(1).max(512).optional(),
      /** A trigger-bound plan run: reply once to the message that started it. */
      planRunId: z.number().int().positive().optional(),
      text: z.string().trim().min(1).max(4_000),
    })
    .strict()
    .refine((a) => (a.messageId === undefined) !== (a.planRunId === undefined), {
      message: 'pass exactly one of messageId or planRunId',
    }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('chat_reply_workspace_required');
    if (args.planRunId !== undefined) {
      // The run's own trigger payload names the thread and its source posts the
      // reply; nothing is read from the owner's vault, so no personal-access check.
      const result = await replyToTriggerRun(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        planRunId: args.planRunId,
        text: args.text,
      });
      return { data: { ok: true, ...result } };
    }
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, ['personal:slack']);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await replyToCanonicalChat(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        messageId: args.messageId!,
        text: args.text,
        agentOwnerId: disclosureSubject(ctx),
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});

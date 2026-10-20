import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { NOTIFY_TEXT_MAX, sendNotification } from '../../capability-verbs/notify';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'notify:send', needsWorkspaceTx: true, profile: 'engineer', capability: 'operator:write', irreversible: true,
  requirePrincipal: false, agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description: 'Post a notification to the channel of an installed notification provider (e.g. Discord) through an explicit connected source. Mentions never ping.',
  guidance: {
    when: 'The owner asks to post an announcement or alert to their connected Discord channel.',
    notWhen: 'Not for replying in a chat thread (chat:reply) or social posts (social:post).',
    chaining: 'Reuse the same idempotencyKey when repeating an ambiguous send. Report the returned url.',
  },
  args: z.object({
    providerId: z.string().trim().min(2).max(128), sourceId: z.string().trim().min(1).max(256),
    text: z.string().min(1).max(NOTIFY_TEXT_MAX), idempotencyKey: z.string().trim().min(1).max(200), addressee: addresseeArg,
  }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('notify_send_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, [`personal:${args.providerId}`]);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      return { data: await sendNotification(ctx.tx as unknown as postgres.Sql, { ...args, workspaceId, userId: user.id,
        provenance: toProvenance(args.addressee), agentOwnerId: disclosureSubject(ctx) }) };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});

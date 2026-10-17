import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { postToBlog } from '../../capability-verbs/blog';
import { addresseeArg, toProvenance } from '../_addressee-arg';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'blog:post', needsWorkspaceTx: true, profile: 'engineer', capability: 'operator:write', irreversible: true,
  requirePrincipal: false, agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description: 'Cross-post Markdown to an installed publishing provider and an explicit connected source. Creates a vendor draft by default; published:true requests public publication, subject to the existing owner publication setting. canonicalUrl must point to HTTPS papercusp.com.',
  guidance: {
    when: 'The owner asks to cross-post a blog article or documentation to a connected publishing account.',
    notWhen: 'For a short social post use social:post.',
    chaining: 'Use the owner-selected source. Report drafted, published or withheld exactly as returned. A draft is stored at the vendor. Hashnode requires a Pro publication. Ambiguous create errors require reconciliation before another attempt.',
  },
  args: z.object({
    providerId: z.string().trim().min(2).max(128), sourceId: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(128), markdown: z.string().min(1).max(80000),
    canonicalUrl: z.string().url().max(4096), published: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(64)).max(15).optional(), addressee: addresseeArg,
  }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('blog_post_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, [`personal:${args.providerId}`]);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      return { data: await postToBlog(ctx.tx as unknown as postgres.Sql, { ...args, workspaceId, userId: user.id,
        provenance: toProvenance(args.addressee), agentOwnerId: disclosureSubject(ctx) }) };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});

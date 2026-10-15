/**
 * people:merge — a person's assertion that two or more canonical persons are the same human
 * (crm-agent-sales-onboarding-apps-2026-10-06 D-027, R-2): the duplicate the email/phone keys
 * missed. The oldest PER- id survives; the others resolve to it through people:get.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { isCodingAgentRole } from '../../personal-vault/coding-roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { mergePeople } from '../../relationship-graph/people';
import { MergeEntitiesError } from '../../relationship-graph/resolver';

export default defineTool({
  name: 'people:merge',
  description:
    'Merge duplicate canonical persons (PER- ids) in the workspace relationship graph into one. The oldest id survives; ' +
    'every other id then resolves to it via people:get. Idempotent. Returns { ok, person, merged, alreadyMerged } or { ok:false, error }.',
  guidance: {
    when: 'A user confirmed two PER- persons are the same human (a duplicate the email/phone keys missed).',
    notWhen: 'Persons sharing an email or phone merge automatically; to correct one field, not a whole person, this is the wrong tool.',
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    ids: z.array(z.string().min(1)).min(2).max(20).describe('PER- ids of the persons to merge (2-20)'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId?.trim() ?? '';
    if (isCodingAgentRole((ctx as { role?: string | null }).role)) return { data: { ok: false, error: 'coding_agent_denied' } };
    if (!workspaceId || workspaceId === '*') return { data: { ok: false, error: 'workspace_required' } };
    // The caller who asserted the merge is recorded as its provenance (assertedSameAsBy.acceptedBy).
    const acceptedBy = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId?.trim() || ctx.principal?.slug?.trim() || '';
    try {
      const result = await mergePeople(getOrgPg().sql, workspaceId, { ids: args.ids, acceptedBy });
      return { data: { ok: true, ...result } };
    } catch (err) {
      if (err instanceof MergeEntitiesError) return { data: { ok: false, error: err.code, message: err.message } };
      throw err;
    }
  },
});

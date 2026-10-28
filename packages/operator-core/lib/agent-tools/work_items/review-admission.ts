import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { bindAdmissionAuthority, AdmissionAuthorityRefused } from '../../work-item-admission-authority';
import { requestAdmissionReview } from '../../work-item-admission-review';

export default defineTool({
  name: 'work_items:review-admission', profile: 'engineer',
  description: 'Request admission review on the exact original item while preserving custody and parks. Never assigns or wakes an executor.',
  guidance: { when: 'An authenticated custodian or current same-fleet leader needs review without changing execution custody.',
    notWhen: 'Assignment, claim release, reopening, policy overrides or executor pickup.' },
  capability: 'work_items:write', requirePrincipal: false, agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1), harness: z.string().min(1),
    purpose: z.literal('admission-review'), requestId: z.string().uuid().optional(),
  }).strict(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    try {
      const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
      const authority = bindAdmissionAuthority(ctx);
      if (!identity.workspaceId || !harnessSlug || !authority) {
        throw new AdmissionAuthorityRefused('review requires renewable transport authentication and concrete scope');
      }
      const result = await requestAdmissionReview({ workspaceId: identity.workspaceId, harnessSlug, workItemId: args.id }, {
        caller: identity.ownerId, authority, requestId: args.requestId,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      if (!(error instanceof AdmissionAuthorityRefused)) throw error;
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ok: false, error: 'admission_review_refused', reason: error.message,
        workItemId: args.id, responsibleActor: identity.ownerId,
        nextAction: 'Repair the named authority, policy or hold, then retry this same item with purpose admission-review.',
        pickupConfirmed: false,
      }) }] };
    }
  },
});

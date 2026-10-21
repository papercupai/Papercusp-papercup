/**
 * plan-types:pin — move one plan's pin for one type to another revision
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, R-14, D-006).
 *
 * Plans pin the revisions they resolve when they activate. This is the only way to change an
 * existing pin. It runs the shared shrink check against the plan, so a pin that would drop a
 * verification module needs a recorded Decision and a fresh activation audit.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg } from '../_harness-scope';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from '../plans/plan-lock-key';
import { pinPlanTypeRevision } from '../../plan-types/authoring';
import { asToolResult, callerId, inWorkspace, typeIdArg, typeKindArg, typeScope } from './_shared';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug.'),
  kind: typeKindArg,
  typeId: typeIdArg,
  revision: z.number().int().min(1).describe('The revision the plan should be held to.'),
  reason: z.string().min(1).max(2000).describe('Why the plan moves to this revision.'),
});

export default defineTool({
  name: 'plan-types:pin',
  description:
    "Pin a plan to a revision of an item type or plan type. A pin that drops verification modules needs a recorded Decision and a fresh activation audit.",
  guidance: {
    when: 'An activated plan should adopt a newer type revision, or be held to its current one before the type changes.',
    notWhen: 'New plans: they pin what they resolve when they activate.',
    chaining: "Lowering: plans:add-decision → plans:audit { phase:'activation' } → this.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const { workspaceId, harnessSlug } = await typeScope(args.harness, ctx);
    const result = await inWorkspace(workspaceId, async (tx) => {
      await acquirePlanAdvisoryLock(tx as never, planAdvisoryLockKey(workspaceId, harnessSlug, args.slug));
      return pinPlanTypeRevision(tx, {
        workspaceId,
        harnessSlug,
        planSlug: args.slug,
        kind: args.kind,
        typeId: args.typeId,
        revision: args.revision,
        reason: args.reason,
        pinnedBy: callerId(ctx),
      });
    });
    return asToolResult(result);
  },
});

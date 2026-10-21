/**
 * plan-types:retire — stop new references to one revision of a type
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, R-12/R-14, D-006).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg } from '../_harness-scope';
import { retireTypeDefinition } from '../../plan-types/authoring';
import { asToolResult, callerId, inWorkspace, typeIdArg, typeKindArg, typeScope } from './_shared';

const argsSchema = z.object({
  harness: harnessArg,
  kind: typeKindArg,
  typeId: typeIdArg,
  revision: z.number().int().min(1).describe('The revision to retire.'),
  reason: z.string().min(1).max(2000).describe('Why the revision is retired.'),
});

export default defineTool({
  name: 'plan-types:retire',
  description:
    'Retire one revision of an item type or plan type. New references stop resolving it; plans pinned to it keep it. Refused when it would drop checks from an activated, unpinned plan.',
  guidance: {
    when: 'A revision is wrong or superseded and new plans must stop using it.',
    notWhen: 'Changing what an existing plan is held to: plan-types:pin.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const { workspaceId } = await typeScope(args.harness, ctx);
    const result = await inWorkspace(workspaceId, (tx) =>
      retireTypeDefinition(tx, {
        workspaceId,
        kind: args.kind,
        typeId: args.typeId,
        revision: args.revision,
        reason: args.reason,
        retiredBy: callerId(ctx),
      }));
    return asToolResult(result);
  },
});

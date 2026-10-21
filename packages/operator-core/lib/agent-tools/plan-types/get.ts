/**
 * plan-types:get — read one item-type or plan-type definition
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, R-12).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg } from '../_harness-scope';
import { getTypeDefinition } from '../../plan-types/authoring';
import { asToolResult, inWorkspace, typeIdArg, typeKindArg, typeScope } from './_shared';

const argsSchema = z.object({
  harness: harnessArg,
  kind: typeKindArg,
  typeId: typeIdArg,
  revision: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('An exact revision (retired ones included). Omit for the revision a new reference resolves.'),
});

export default defineTool({
  name: 'plan-types:get',
  description:
    'Read one item-type or plan-type definition as stored, with its content hash, origin, retirement and the list of its revisions.',
  guidance: {
    when: 'Before declaring or extending a type, or to see exactly which rule a pinned plan is held to.',
    notWhen: 'Browsing what exists: plan-types:list.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const { workspaceId } = await typeScope(args.harness, ctx);
    const result = await inWorkspace(workspaceId, (tx) =>
      getTypeDefinition(tx, { workspaceId, kind: args.kind, typeId: args.typeId, revision: args.revision }));
    return asToolResult(result);
  },
});

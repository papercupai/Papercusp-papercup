/**
 * plan-types:list — the item types and plan types a plan in this workspace can use
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, R-12).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg } from '../_harness-scope';
import { listTypeDefinitions } from '../../plan-types/authoring';
import { inWorkspace, typeKindArg, typeScope } from './_shared';

const argsSchema = z.object({
  harness: harnessArg,
  kind: typeKindArg.optional(),
  prefix: z.string().min(1).optional().describe('Only ids starting with this, e.g. acme/.'),
  includeRetired: z
    .boolean()
    .optional()
    .describe('List every revision, retired ones included. Default: one entry per id at the revision a new reference resolves.'),
});

export default defineTool({
  name: 'plan-types:list',
  description:
    'List item types and plan types (built-in and workspace-defined): one entry per id at its current revision, or every revision with includeRetired.',
  guidance: {
    when: 'Choosing a deliverable: or type: for a plan, or checking whether a type id is taken.',
    notWhen: 'Reading one definition in full: plan-types:get.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const { workspaceId } = await typeScope(args.harness, ctx);
    const types = await inWorkspace(workspaceId, (tx) =>
      listTypeDefinitions(tx, { workspaceId, kind: args.kind, prefix: args.prefix, includeRetired: args.includeRetired }));
    return { data: { ok: true as const, count: types.length, types } };
  },
});

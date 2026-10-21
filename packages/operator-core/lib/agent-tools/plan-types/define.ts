/**
 * plan-types:define — store a new revision of an item-type or plan-type definition
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, R-12/R-13, D-006).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg } from '../_harness-scope';
import { defineTypeDefinition } from '../../plan-types/authoring';
import { asToolResult, callerId, inWorkspace, typeKindArg, typeScope } from './_shared';

const argsSchema = z.object({
  harness: harnessArg,
  kind: typeKindArg,
  definition: z
    .record(z.string(), z.unknown())
    .describe('The definition (schemaVersion 1, id, revision = next revision, title, ...). Stored exactly as given.'),
});

export default defineTool({
  name: 'plan-types:define',
  description:
    'Define a revision of an item type or plan type. Validates the schema, the verification-module catalog and the generic-core floor; references must resolve; refuses a revision that would drop checks from an activated, unpinned plan.',
  guidance: {
    when: 'A plan item or plan needs a type the built-in catalog does not have, or an existing type needs a new rule (define the next revision).',
    notWhen: 'Editing a stored revision: revisions are immutable. Ids under papercusp/ are built-in only.',
    chaining: 'plan-types:list / plan-types:get to see what exists → this → declare it in a plan (deliverable: / type:).',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const { workspaceId } = await typeScope(args.harness, ctx);
    const result = await inWorkspace(workspaceId, (tx) =>
      defineTypeDefinition(tx, { workspaceId, kind: args.kind, definition: args.definition, createdBy: callerId(ctx) }));
    return asToolResult(result);
  },
});

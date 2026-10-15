/** blueprint:read-private-input — the worker half of an operation's private input
 * (plan app-agent-tasks-durable-execution-2026-10-06 D-014, WI-10006699).
 *
 * The submitter attaches `privateInput` to blueprint:submit for an operation that
 * declares privateInputSchema; it is stored OUTSIDE the work item. The worker
 * holding that operation's work item reads it here by work item id. Everything
 * else is resolved server-side from the durable invocation receipt, and the read
 * refuses unless the caller currently holds the item and the item is not
 * terminal — so the content is reachable only while the operation is in flight.
 *
 * Modelled on triggers:read-payload { workItemId } (email D-006), with a stronger
 * holder check: this returns private app content, not an event already on the
 * owner's own account. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { InvalidInputError } from '@papercusp/tooldef';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  PrivateInputReadError,
  readOperationPrivateInput,
} from '../../blueprint/operation-private-input';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'blueprint:read-private-input',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Read the private input attached to the blueprint operation whose work item you hold (e.g. a call transcript). Returns { content, sha256 }; sha256 is over JSON.stringify(content).',
  guidance: {
    when: 'Your operation work item says its content is private input: pass your held work item id, then verify sha256 against the reference in the item input.',
    notWhen: 'An item you do not hold, a terminal item, or an operation without privateInputSchema; these are refused.',
    chaining: 'work_items:claim → blueprint:read-private-input { workItemId } → work_items:complete.',
    seeAlso: ['triggers:read-payload (the trigger-event read for trigger-fired operations)'],
  },
  args: z
    .object({
      workItemId: z.string().trim().min(1).max(200).describe('The operation work item you currently hold.'),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') {
      throw new InvalidInputError('private_input_workspace_required: call from a session bound to a concrete workspace');
    }
    const holderOwnerId = resolveAgentIdentity(ctx).ownerId;
    try {
      const result = await readOperationPrivateInput(ctx.tx ?? getOrgPg().sql, {
        workspaceId, workItemId: args.workItemId, holderOwnerId,
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof PrivateInputReadError ||
          (error instanceof Error && error.name === 'PrivateInputReadError')) {
        throw new InvalidInputError(error.message);
      }
      throw error;
    }
  },
});

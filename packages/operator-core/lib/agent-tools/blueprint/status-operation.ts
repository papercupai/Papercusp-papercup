/** blueprint:status — canonical lifecycle state of one operation (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { z } from 'zod';
import { readWorkflowAdministration, WorkflowAdministrationSchema } from '../../blueprint/support-workflow-administration';
import { getBlueprintOperationStatus } from '../../blueprint/operation-service';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationStatusSchema, StatusArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.status,
  capability: 'work_items:read',
  description:
    'Read operation lifecycle state. With administration:true, read the selected local workflow revision, owner, reviews, funding/cost evidence and administrative history as its authenticated accountable owner.',
  guidance: {
    when: 'Checking progress of a blueprint operation handle you hold.',
    notWhen: 'Reading the output — terminal is not success; use blueprint:result.',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: StatusArgsSchema,
  result: z.union([BlueprintOperationStatusSchema, z.object({ administration: WorkflowAdministrationSchema })]),
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    if ('administration' in args) return runOperation(async () => ({ administration: await readWorkflowAdministration(scope.sql,
      { workspaceId: scope.workspaceId, principalId: scope.principalId, harness: args.harness, operationId: args.operationId }) }));
    checkHandleScope(scope, args.handle);
    return runOperation(() => getBlueprintOperationStatus(scope.sql, args.handle, scope.callerId,
      args.review ? { principalId: scope.principalId } : undefined));
  },
});

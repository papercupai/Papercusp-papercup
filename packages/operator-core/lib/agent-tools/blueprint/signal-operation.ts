/** blueprint:signal — send a declared signal to an operation (P-017, D-009). */
import { defineTool } from '@papercusp/agent-mcp';
import { signalBlueprintOperation } from '../../blueprint/operation-service';
import { administerWorkflow } from '../../blueprint/support-workflow-administration';
import {
  BLUEPRINT_OPERATION_TOOLS, BlueprintOperationInputReceiptSchema, SignalArgsSchema,
} from '../../blueprint/operation-contract';
import { checkHandleScope, OPERATION_TOOL_SEE_ALSO, resolveOperationScope, runOperation } from './_operation-tool';

export default defineTool({
  name: BLUEPRINT_OPERATION_TOOLS.signal,
  capability: 'work_items:write',
  idempotent: true,
  description:
    'Send a declared operation signal, or administer a selected local workflow as its authenticated accountable owner: promote/rollback retained revisions, stop an exact receipt, or revoke its employee source grant. Administrative requests require the displayed approved revision and an audit reason; public publication is separate.',
  guidance: {
    when: 'Feeding a running operation you submitted an input it declares.',
    notWhen: 'Answering a declared wait (blueprint:resume) or an undeclared channel (refused).',
    seeAlso: [...OPERATION_TOOL_SEE_ALSO],
  },
  args: SignalArgsSchema,
  result: BlueprintOperationInputReceiptSchema,
  async handler(args, ctx) {
    const scope = resolveOperationScope(ctx);
    if ('administration' in args) return runOperation(() => administerWorkflow(scope.sql,
      { workspaceId: scope.workspaceId, principalId: scope.principalId, harness: args.harness, operationId: args.operationId },
      { ...args.administration, requestKey: args.requestKey }));
    checkHandleScope(scope, args.handle);
    return runOperation(() => signalBlueprintOperation(scope.sql, args.handle, scope.callerId, {
      channel: args.channel, payload: args.payload, requestKey: args.requestKey,
    }, { principalId: scope.principalId }));
  },
});

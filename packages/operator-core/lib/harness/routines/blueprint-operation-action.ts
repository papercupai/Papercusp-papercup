/**
 * system:blueprint-operation — the on-demand routine action for P-016.
 *
 * The routine fire's DBOS workflow UUID is already the durable occurrence
 * receipt. Reusing it as requestKey lets operation admission reconcile a replay
 * without another scheduler, workflow registry, or receipt table.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  submitBlueprintOperation,
  type BlueprintOperationHandle,
  type SubmitBlueprintOperationInput,
  type InternalBlueprintOperationSubmission,
} from '../../blueprint/operation-service';
import { assertRoutineOperationAdmission, pauseRefusedRoutineOperation,
  RoutineOperationAdmissionRefusal } from '../../blueprint/operation-routine-admission';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

type SubmitOperation = (
  sql: ReturnType<typeof getOrgPg>['sql'],
  input: SubmitBlueprintOperationInput,
  internal?: InternalBlueprintOperationSubmission,
) => Promise<BlueprintOperationHandle>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`blueprint_operation_routine_${field}_required`);
  return normalized;
}

export async function runBlueprintOperationAction(
  ctx: SystemActionCtx,
  deps: { submit?: SubmitOperation; sql?: ReturnType<typeof getOrgPg>['sql'] } = {},
): Promise<SystemActionResult> {
  const routineId = requiredString(ctx.routineId, 'routine_id');
  const workflowId = requiredString(ctx.workflowId, 'workflow_id');
  const payload = object(ctx.payloadTemplate);
  const operationHarnessSlug = requiredString(payload.operationHarnessSlug, 'harness');
  const operationId = requiredString(payload.operationId, 'operation_id');
  if (
    payload.input !== undefined &&
    (payload.input === null || Array.isArray(payload.input) || typeof payload.input !== 'object')
  ) {
    throw new Error('blueprint_operation_routine_input_invalid');
  }
  const sql = deps.sql ?? getOrgPg().sql;
  const callerId = `routine:${routineId}`;
  try {
    const handle = await (deps.submit ?? submitBlueprintOperation)(sql, {
      workspaceId: ctx.workspaceId,
      harnessSlug: operationHarnessSlug,
      callerId,
      operationId,
      requestKey: workflowId,
      input: object(payload.input),
    }, { beforeNewAdmission: tx => assertRoutineOperationAdmission(tx, {
      workspaceId: ctx.workspaceId, routineId, callerId, requestKey: workflowId,
    }) });
    return { diagnostics: { blueprintOperation: handle } };
  } catch (error) {
    if (!(error instanceof RoutineOperationAdmissionRefusal)) throw error;
    const paused = !['inactive', 'overlap'].includes(error.reason);
    if (paused) await pauseRefusedRoutineOperation(sql, ctx.workspaceId, routineId, error);
    return { diagnostics: { blueprintOperationAdmission: {
      admitted: false, reason: error.reason, paused, costCents: error.costCents,
    } } };
  }
}

registerSystemAction('blueprint-operation', runBlueprintOperationAction, { scheduling: 'on-demand' });

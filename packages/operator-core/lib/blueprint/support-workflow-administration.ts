/** Local administration of the existing support operation. No publisher, version
 * store or funding ledger: all changes reuse the retained specification, current
 * projection, allocation accounting, personal grants and cancellation service. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BlueprintSchema, operationFromSpecification } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { readHostedAllocationAccountingExport, readHostedAllocationReport } from '../auth/hosted/billing/allocation-store';
import { listPersonalGrants, personalScope, revokePersonalGrant } from '../personal-vault/store';
import { ORGANIZATION_CORPUS_SCOPE } from '../data-sources/documents-corpus';
import { runWithWorkspace } from '../workspace-als';
import { BlueprintOperationRefusal } from './operation-refusal';
import { cancelBlueprintOperation, getBlueprintOperationStatus, OperationHandleSchema } from './operation-service';
import { projectBlueprintToPg, readBlueprintHashFromPg, readBlueprintSpecificationSnapshot } from './project-to-pg';

const revision = z.string().regex(/^[0-9a-f]{64}$/);
export const WorkflowAdministrationSelectionSchema = z.object({
  harness: z.string().trim().min(1).max(120), operationId: z.string().trim().min(1).max(200),
});
export const WorkflowAdministrationActionSchema = z.object({
  action: z.enum(['promote', 'rollback', 'stop', 'revoke']),
  expectedSpecificationRevision: revision,
  reason: z.string().trim().min(1).max(2000),
  targetRevision: revision.optional(),
  handle: OperationHandleSchema.optional(),
}).strict();
const cost = z.union([z.object({ value: z.number() }), z.object({ unknownReason: z.string() })]);
export const WorkflowAdministrationSchema = z.object({
  harnessSlug: z.string(), operationId: z.string(), approvedRevision: revision,
  version: z.string(), accountableOwner: z.string(), reviewerPrincipals: z.array(z.string()),
  retainedRevisions: z.array(z.object({ revision, version: z.string() })),
  funding: z.object({ allocationId: z.string(), month: z.string(), maximumCostMicros: z.number(),
    capMicros: z.number().nullable(), availableMicros: z.number().nullable(), committedMicros: z.number().nullable(),
    unknownReason: z.string().nullable(),
    costs: z.array(z.object({ reservationId: z.string(), observedCostMicros: cost, providerFinalCostMicros: cost })),
  }).nullable(),
  history: z.array(z.object({ eventId: z.string(), body: z.record(z.string(), z.unknown()) })),
  businessReviews: z.array(z.object({ eventId: z.string(), body: z.record(z.string(), z.unknown()) })),
});
export type WorkflowAdministration = z.infer<typeof WorkflowAdministrationSchema>;
type Selection = z.infer<typeof WorkflowAdministrationSelectionSchema> & { workspaceId: string; principalId: string };
type Action = z.infer<typeof WorkflowAdministrationActionSchema> & { requestKey: string };

async function current(sql: Sql, input: Selection) {
  const hash = await readBlueprintHashFromPg(sql, input.workspaceId, input.harness);
  const specification = hash && await readBlueprintSpecificationSnapshot(sql, input.workspaceId, input.harness, hash);
  if (!specification) throw new BlueprintOperationRefusal('undeclared', 'No retained approved workflow');
  const { operation } = operationFromSpecification(specification, input.operationId);
  if (!operation.policy.supportCase || !operation.acceptance.businessReview ||
      operation.acceptance.businessReview.accountableOwner !== input.principalId) {
    throw new BlueprintOperationRefusal('handle_mismatch', 'Workflow administration requires its authenticated accountable owner');
  }
  return { specification, operation };
}

export async function readWorkflowAdministration(sql: Sql, input: Selection): Promise<WorkflowAdministration> {
  return runWithWorkspace(input.workspaceId, () => sql.begin(async tx => {
    const client = tx as unknown as Sql;
    const { specification, operation } = await current(client, input);
    const policy = operation.policy.supportCase!;
    const funding = policy.funding;
    if (funding && funding.organization.controlWorkspaceId !== input.workspaceId)
      throw new BlueprintOperationRefusal('handle_mismatch', 'Workflow funding belongs to another workspace');
    const report = funding ? await readHostedAllocationReport(client, funding) : null;
    const accounting = funding ? await readHostedAllocationAccountingExport(client, funding) : null;
    const allocation = report?.byCostClass.model.allocations.find(a => a.allocationId === funding?.allocationId);
    const snapshots = await tx<{ specification_revision: string }[]>`SELECT specification_revision
      FROM harness_shared.blueprint_specifications WHERE workspace_id = ${input.workspaceId}
        AND harness_slug = ${input.harness} ORDER BY created_at DESC LIMIT 20`;
    const retainedRevisions: WorkflowAdministration['retainedRevisions'] = [];
    for (const row of snapshots) {
      const snapshot = await readBlueprintSpecificationSnapshot(client, input.workspaceId, input.harness, row.specification_revision);
      const candidate = snapshot?.configuration.operations?.find(o => o.id === input.operationId);
      if (candidate?.policy.supportCase && candidate.acceptance.businessReview?.accountableOwner === input.principalId)
        retainedRevisions.push({ revision: row.specification_revision, version: candidate.version });
    }
    const history = await tx<{ eventId: string; body: Record<string, unknown> }[]>`SELECT id::text AS "eventId", body
      FROM harness_shared.coord_event_log WHERE workspace_id = ${input.workspaceId}
        AND surface = 'blueprint-administration' AND body->>'harness' = ${input.harness}
        AND body->>'operationId' = ${input.operationId} ORDER BY id DESC LIMIT 20`;
    const businessReviews = await tx<{ eventId: string; body: Record<string, unknown> }[]>`SELECT e.id::text AS "eventId", e.body
      FROM harness_shared.coord_event_log e JOIN harness_shared.blueprint_operation_invocations r
        ON r.id::text = e.body->>'receiptId' AND r.workspace_id = e.workspace_id
      WHERE e.workspace_id = ${input.workspaceId} AND e.surface = 'blueprint-operation'
        AND e.body->>'kind' = 'business-review' AND r.harness_slug = ${input.harness}
        AND r.operation_id = ${input.operationId} ORDER BY e.id DESC LIMIT 20`;
    return WorkflowAdministrationSchema.parse({ harnessSlug: input.harness, operationId: input.operationId,
      approvedRevision: specification.specificationRevision, version: operation.version,
      accountableOwner: operation.acceptance.businessReview!.accountableOwner,
      reviewerPrincipals: operation.acceptance.businessReview!.reviewerPrincipals, retainedRevisions, history, businessReviews,
      funding: funding ? { allocationId: funding.allocationId, month: funding.month,
        maximumCostMicros: policy.maximumCostMicros, capMicros: allocation?.capMicros ?? null,
        availableMicros: allocation?.availableMicros ?? null, committedMicros: allocation?.committedMicros ?? null,
        unknownReason: allocation ? null : 'allocation-not-recorded',
        costs: accounting?.rows.filter(r => r.costClass === 'model' && r.allocationId === funding.allocationId)
          .map(r => ({ reservationId: r.reservationId, observedCostMicros: r.observedCostMicros,
            providerFinalCostMicros: r.providerFinalCostMicros })) ?? [],
      } : null });
  }));
}

export async function administerWorkflow(sql: Sql, input: Selection, raw: Action) {
  const { requestKey, ...payload } = raw;
  const action = WorkflowAdministrationActionSchema.parse(payload);
  if (!requestKey?.trim() || requestKey.length > 200)
    throw new BlueprintOperationRefusal('invalid_request', 'Administration requires a bounded request key');
  const body = { ...action, harness: input.harness, operationId: input.operationId, principalId: input.principalId };
  const msgId = 'workflow-admin:' + createHash('sha256').update(canonicalJson({ workspaceId: input.workspaceId,
    harness: input.harness, operationId: input.operationId, principalId: input.principalId, requestKey })).digest('hex');
  return runWithWorkspace(input.workspaceId, () => sql.begin(async tx => {
    const client = tx as unknown as Sql;
    // Same row fence as new admission: the displayed revision comparison and
    // pointer change cannot interleave with another promotion or admission.
    await tx`SELECT content_hash FROM harness_shared.blueprints WHERE workspace_id = ${input.workspaceId}
      AND harness_slug = ${input.harness} FOR UPDATE`;
    const { specification } = await current(client, input);
    const [prior] = await tx<{ id: string; body: unknown }[]>`SELECT id::text, body
      FROM harness_shared.coord_event_log WHERE workspace_id = ${input.workspaceId}
        AND surface = 'blueprint-administration' AND msg_id = ${msgId}`;
    if (prior) {
      if (canonicalJson(prior.body) !== canonicalJson(body))
        throw new BlueprintOperationRefusal('input_conflict', 'Administrative request key was reused with different input');
      return { eventId: prior.id, replayed: true, accepted: true as const, wakeQueued: false, handled: false as const };
    }
    if (specification.specificationRevision !== action.expectedSpecificationRevision)
      throw new BlueprintOperationRefusal('invalid_request', 'Approved revision changed; refresh workflow administration');
    if (action.action === 'promote' || action.action === 'rollback') {
      if (!action.targetRevision || action.handle)
        throw new BlueprintOperationRefusal('invalid_payload', 'Promotion and rollback require a retained target revision only');
      const target = await readBlueprintSpecificationSnapshot(client, input.workspaceId, input.harness, action.targetRevision);
      const candidate = target?.configuration.operations?.find(o => o.id === input.operationId);
      if (!target || !candidate?.policy.supportCase ||
          candidate.acceptance.businessReview?.accountableOwner !== input.principalId ||
          candidate.policy.supportCase.funding?.organization.controlWorkspaceId !== input.workspaceId)
        throw new BlueprintOperationRefusal('invalid_payload', 'Target must be a retained local workflow with the same accountable owner and workspace funding');
      const outsideOperation = (configuration: typeof target.configuration) => ({ ...configuration,
        operations: configuration.operations?.filter(o => o.id !== input.operationId) });
      if (canonicalJson(outsideOperation(target.configuration)) !== canonicalJson(outsideOperation(specification.configuration)))
        throw new BlueprintOperationRefusal('invalid_payload', 'Target changes configuration outside this workflow operation');
      await projectBlueprintToPg(client, { workspaceId: input.workspaceId, harnessSlug: input.harness,
        blueprint: BlueprintSchema.parse(target.configuration), specification: target });
    } else {
      const handle = action.handle;
      if (!handle || action.targetRevision || handle.workspaceId !== input.workspaceId ||
          handle.harnessSlug !== input.harness || handle.operationId !== input.operationId)
        throw new BlueprintOperationRefusal('handle_mismatch', 'Administration requires this workflow’s exact receipt');
      const [receipt] = await tx<{ caller_id: string }[]>`SELECT caller_id FROM harness_shared.blueprint_operation_invocations
        WHERE workspace_id = ${input.workspaceId} AND id = ${handle.receiptId} AND harness_slug = ${input.harness}`;
      if (!receipt) throw new BlueprintOperationRefusal('handle_mismatch', 'Receipt is unavailable');
      // Validate the complete immutable handle before exercising owner authority.
      const status = await getBlueprintOperationStatus(client, handle, receipt.caller_id);
      const accepted = await readBlueprintSpecificationSnapshot(client, input.workspaceId, input.harness, handle.specificationRevision);
      const operation = accepted && operationFromSpecification(accepted, input.operationId).operation;
      if (!operation || operation.acceptance.businessReview?.accountableOwner !== input.principalId)
        throw new BlueprintOperationRefusal('handle_mismatch', 'Receipt has a different accountable owner');
      if (action.action === 'stop') {
        if (!status.cancellationRequested) await cancelBlueprintOperation(client, handle, receipt.caller_id,
          { requestKey: msgId, reason: action.reason }, { inTransaction: true, requestedBy: input.principalId });
      } else {
        const userId = receipt.caller_id.split('/')[0];
        const execution = operation.execution;
        if (!z.string().uuid().safeParse(userId).success || execution?.kind !== 'agent')
          throw new BlueprintOperationRefusal('invalid_payload', 'Receipt has no revocable employee source grant');
        const grants = await listPersonalGrants(client, input.workspaceId, userId);
        for (const grant of grants) if (grant.principal_type === 'agent-role' &&
            grant.principal_id === execution.role && Array.isArray(grant.scopes) &&
            grant.scopes.includes(personalScope(ORGANIZATION_CORPUS_SCOPE)) && !grant.revoked_at)
          await revokePersonalGrant(client, input.workspaceId, userId, grant.id);
      }
    }
    const [event] = await tx<{ id: string }[]>`INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body) VALUES (${input.workspaceId}, 'blueprint-administration',
        ${`workflow:${input.harness}:${input.operationId}`}, ${msgId}, ${JSON.stringify(body)}::text::jsonb) RETURNING id::text`;
    if (!event) throw new Error('Administrative audit receipt was not recorded');
    return { eventId: event.id, replayed: false, accepted: true as const, wakeQueued: false, handled: false as const };
  }));
}

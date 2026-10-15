/** P-012 uses the native gateway's final-send receipt and P-009's allocation
 * ledger. Unknown provider charges keep their full reservation. This module
 * neither estimates token counts nor creates a second funding ledger. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql } from 'postgres';
import type { BlueprintOperationHandle, BusinessReviewDecision } from './operation-service';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialBinding } from '../inference-gateway/gateway';
import type { NativeGymProviderAuthorization } from '../gym/proposer';
import { processMonotonicClock } from '../process-monotonic-clock';
import { reserveHostedAllocation, recordHostedOutcome,
  type HostedAllocationOrganization } from '../auth/hosted/billing/allocation-store';

export interface SupportWorkflowFunding {
  organization: HostedAllocationOrganization;
  allocationId: string;
  month: string;
}

/** Resolve from an APPLIED worker receipt and immutable operation snapshot.
 * Caller headers cannot supply funding, prices, an old revision or a handle. */
export async function readSupportOperationBudgetBinding(workspaceId: string, ownerId: string): Promise<GatewayCarryTrialBinding | null> {
  const [{ readActiveOperationWorkerClaimBinding }, { readAcceptedBlueprintDirectWorkItem },
    { getWorkItem }, { getOrgPg }, { runWithWorkspace }, { createNativeProviderAuthenticator },
    { ANY_FAMILY_TERMINAL_STATES }] = await Promise.all([
    import('./operation-worker-binding'), import('./operation-admission'), import('../work-items'),
    import('@papercusp/db-org'), import('../workspace-als'), import('../external-bench/current-su'),
    import('../work-item-dispatch-states'),
  ]);
  const active = await readActiveOperationWorkerClaimBinding(workspaceId, ownerId);
  if (active.status === 'none') return null;
  if (active.status !== 'bound') throw new Error('Operation budget worker authority unavailable');
  return runWithWorkspace(workspaceId, async () => {
    const sql = getOrgPg().sql, binding = active.binding;
    const item = await getWorkItem(binding.workItemId, binding.storageHarnessSlug);
    if (!item) throw new Error('Operation budget target missing');
    const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(sql, workspaceId, item);
    const support = operation.policy.supportCase;
    if (!support) return null;
    const payload = item.payload as Record<string, unknown> | null;
    if (!isDeepStrictEqual(pin, binding.pin) || operation.id !== binding.operationId ||
        item.assignee !== ownerId || ANY_FAMILY_TERMINAL_STATES.includes(item.state) || payload?.blueprintCancellation ||
        pin.specificationRevision !== binding.specificationRevision || !support.funding || !support.native ||
        support.funding.organization.controlWorkspaceId !== workspaceId ||
        operation.policy.model?.mode !== 'exact' || operation.policy.model.models.length !== 1 ||
        operation.policy.model.models[0] !== support.native.model || operation.policy.model.effort !== support.native.effort) {
      throw new Error('Support operation requires live revision-pinned native budget authority');
    }
    const [receipt] = await sql<Array<{ id: string | number }>>`SELECT id FROM harness_shared.blueprint_operation_invocations
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${binding.harnessSlug}
        AND operation_id = ${binding.operationId} AND specification_revision = ${binding.specificationRevision}
        AND target_kind = 'work-item' AND target_ref = ${binding.workItemId}
        AND caller_id = ${pin.callerId ?? ''} AND request_key = ${pin.requestKey ?? ''}`;
    if (!receipt) throw new Error('Support operation has no durable invocation');
    const handle: BlueprintOperationHandle = { workspaceId, harnessSlug: binding.harnessSlug,
      operationId: binding.operationId, receiptId: Number(receipt.id), specificationRevision: binding.specificationRevision,
      target: { kind: 'work-item', id: binding.workItemId } };
    const validateOperationAuthority = async () => {
      // Counting native input and reserving funding both await external work.
      // A receipt read before either wait cannot authorize a stopped/replaced
      // worker or content whose source access has since been revoked.
      const current = await readActiveOperationWorkerClaimBinding(workspaceId, ownerId);
      if (current.status !== 'bound' || !isDeepStrictEqual(current, active)) {
        throw new Error('Support operation worker authority changed');
      }
      const latest = await getWorkItem(binding.workItemId, binding.storageHarnessSlug);
      if (!latest || latest.assignee !== ownerId || ANY_FAMILY_TERMINAL_STATES.includes(latest.state) ||
          (latest.payload as Record<string, unknown> | null)?.blueprintCancellation) {
        throw new Error('Support operation worker is stopped or no longer holds its item');
      }
      const accepted = await readAcceptedBlueprintDirectWorkItem(sql, workspaceId, latest);
      if (!isDeepStrictEqual(accepted.pin, pin)) throw new Error('Support operation pin changed');
      const [{ supportWorkflowFromOperation }, { readSelectedSupportCase }] = await Promise.all([
        import('./support-workflow-operation'), import('./support-workflow-case'),
      ]);
      const workflow = supportWorkflowFromOperation(accepted.operation, binding.harnessSlug, binding.specificationRevision);
      if (!workflow) throw new Error('Support operation source policy is missing');
      // Admission verified and pinned this principal; the worker cannot replace
      // it with its own identity or with an inference request header.
      const principal = { kind: 'user', trust: 'verified', workspaceId, slug: pin.callerId?.split('/')[0] };
      const selected = await readSelectedSupportCase(sql, { workspaceId, harnessSlug: binding.harnessSlug,
        role: accepted.operation.execution?.kind === 'agent' ? accepted.operation.execution.role : undefined,
        principal }, workflow, pin.input as unknown as import('./support-workflow-contract').SupportCaseInput);
      if (!selected.allowed) throw new Error('Support operation source access revoked');
    };
    await validateOperationAuthority();
    const native = support.native;
    const authenticator = createNativeProviderAuthenticator({ workspaceId, manifestSha256: binding.specificationRevision,
      assignmentId: supportOperationReservationId(handle), rate: native,
      policy: { agent: 'codex', account: native.account, model: native.model, effort: native.effort,
        payer: native.payer, generationBudget: { maxUsd: support.maximumCostMicros / 1_000_000,
          maxTokens: native.inputTokenCeiling + native.outputTokenCeiling } } });
    const controller = createSupportWorkflowBudgetController({ handle, funding: support.funding,
      maximumCostMicros: support.maximumCostMicros, authenticateProvider: authenticator.authenticateProvider,
      validateOperationAuthority,
      reserveAttempt: attempt => reserveSupportOperationAttempt(sql, attempt) });
    return { ...controller.binding,
      // The callback escapes this read's async scope and may be invoked later
      // from another gateway request. Re-establish the accepted workspace for
      // every authority/source read and reservation it performs.
      authorizeAttempt: attempt => runWithWorkspace(workspaceId, () => controller.binding.authorizeAttempt(attempt)),
      ...(native.payer === 'api-key' ? { outputTokenLimit: native.outputTokenCeiling } : {}) };
  });
}

export function supportOperationReservationId(handle: BlueprintOperationHandle): string {
  return createHash('sha256').update(JSON.stringify([
    handle.workspaceId, handle.harnessSlug, handle.receiptId, handle.operationId,
    handle.specificationRevision, handle.target,
  ])).digest('hex');
}

export interface SupportOperationAttemptReservation {
  handle: BlueprintOperationHandle;
  funding: SupportWorkflowFunding;
  operationMaximumMicros: number;
  attemptId: string;
  attemptMaximumMicros: number;
  bodySha256: string;
}

/** The invocation row serializes ALL workers, retries and process restarts.
 * The entire operation maximum is also held against its P-009 ancestor chain.
 * Failed/unknown sends do not replenish the operation's allowance. */
export async function reserveSupportOperationAttempt(sql: Sql, value: SupportOperationAttemptReservation): Promise<boolean> {
  const input = structuredClone(value), { handle, funding } = input;
  if (funding.organization.controlWorkspaceId !== handle.workspaceId || handle.target.kind !== 'work-item' ||
      ![input.operationMaximumMicros, input.attemptMaximumMicros].every(n => Number.isSafeInteger(n) && n > 0) ||
      input.attemptMaximumMicros > input.operationMaximumMicros ||
      !/^[0-9a-f-]{36}$/.test(input.attemptId) || !/^[0-9a-f]{64}$/.test(input.bodySha256)) return false;
  return await sql.begin(async tx => {
    const [receipt] = await tx`SELECT id FROM harness_shared.blueprint_operation_invocations
      WHERE workspace_id = ${handle.workspaceId} AND harness_slug = ${handle.harnessSlug}
        AND id = ${handle.receiptId} AND operation_id = ${handle.operationId}
        AND specification_revision = ${handle.specificationRevision}
        AND target_kind = 'work-item' AND target_ref = ${handle.target.kind === 'work-item' ? handle.target.id : ''}
      FOR UPDATE`;
    if (!receipt) return false;
    const writer = `receipt:${handle.receiptId}`;
    const prior = await tx<Array<{ msg_id: string; body: { maximumCostMicros: number; bodySha256: string } }>>`
      SELECT msg_id, body FROM harness_shared.coord_event_log
      WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
        AND writer_key = ${writer} AND body->>'kind' = 'native-budget-reservation'`;
    const msgId = `support-budget:${handle.receiptId}:${input.attemptId}`;
    // A provider attempt is single use, including a duplicate from another host.
    if (prior.some(row => row.msg_id === msgId)) return false;
    let committed = 0n;
    for (const row of prior) {
      if (!Number.isSafeInteger(row.body.maximumCostMicros) || row.body.maximumCostMicros <= 0) return false;
      committed += BigInt(row.body.maximumCostMicros);
    }
    if (committed + BigInt(input.attemptMaximumMicros) > BigInt(input.operationMaximumMicros)) return false;
    const reservationId = supportOperationReservationId(handle);
    const held = await reserveHostedAllocation(tx as unknown as Sql, {
      ...funding, reservationId, costClass: 'model', maximumCostMicros: input.operationMaximumMicros,
      observedAtMs: Date.now(), evidenceRef: `blueprint-operation:${handle.receiptId}:${handle.specificationRevision}`,
    });
    if (held.outcome !== 'admitted' && held.outcome !== 'duplicate') return false;
    const body = JSON.stringify({ kind: 'native-budget-reservation', receiptId: handle.receiptId,
      attemptId: input.attemptId, maximumCostMicros: input.attemptMaximumMicros,
      bodySha256: input.bodySha256, reservationId, specificationRevision: handle.specificationRevision });
    await tx`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
      VALUES (${handle.workspaceId}, 'blueprint-operation', ${writer}, ${msgId}, ${body}::text::jsonb)`;
    return true;
  });
}

/** The authenticator verifies the FINAL credential/body, native input bound and
 * frozen prices. Only its source-bound authority can reserve a provider send. */
export function createSupportWorkflowBudgetController(input: {
  handle: BlueprintOperationHandle; funding: SupportWorkflowFunding; maximumCostMicros: number;
  authenticateProvider: (attempt: GatewayCarryTrialAttempt) => Promise<NativeGymProviderAuthorization | null>;
  validateOperationAuthority: () => Promise<void>;
  reserveAttempt: (attempt: SupportOperationAttemptReservation) => Promise<boolean>;
}): { binding: GatewayCarryTrialBinding; revoke: () => void } {
  const handle = structuredClone(input.handle), funding = structuredClone(input.funding);
  const { maximumCostMicros, authenticateProvider, reserveAttempt, validateOperationAuthority } = input;
  if (!Number.isSafeInteger(maximumCostMicros) || maximumCostMicros <= 0 ||
      funding.organization.controlWorkspaceId !== handle.workspaceId) throw new Error('Invalid support operation budget');
  const armId = supportOperationReservationId(handle);
  let live = true;
  return { revoke() { live = false; }, binding: {
    manifestSha256: handle.specificationRevision, armId,
    // The dynamic operation route authenticates its applied worker separately.
    requestTokenSha256: armId, protocols: ['openai-responses', 'anthropic-messages'],
    async authorizeAttempt(value) {
      const attempt = Object.freeze({ ...value });
      if (!live || attempt.signal.aborted || attempt.clockId !== processMonotonicClock.id ||
          attempt.manifestSha256 !== handle.specificationRevision || attempt.armId !== armId ||
          attempt.bodySha256 !== createHash('sha256').update(attempt.body).digest('hex')) return null;
      try { await validateOperationAuthority(); } catch { return null; }
      if (!live || attempt.signal.aborted) return null;
      const supplied = await authenticateProvider(attempt);
      if (!supplied?.inputEvidence) return null;
      const authority = Object.freeze({ ...supplied });
      const micros = Math.round(authority.requestedUsd * 1_000_000);
      const check = () => {
        if (!live || attempt.signal.aborted || processMonotonicClock.now() >= authority.validUntilMonotonicMs) {
          throw new Error('Support operation provider authority expired or revoked');
        }
        const result: unknown = authority.validateAuthorization();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new Error('Support operation provider authority must be synchronous');
        }
        if (!live || attempt.signal.aborted || processMonotonicClock.now() >= authority.validUntilMonotonicMs) {
          throw new Error('Support operation provider authority expired or revoked');
        }
      };
      if (!Number.isSafeInteger(micros) || micros <= 0 || micros > maximumCostMicros ||
          micros / 1_000_000 !== authority.requestedUsd ||
          !Number.isFinite(authority.validUntilMonotonicMs) ||
          authority.inputEvidence!.bodySha256 !== attempt.bodySha256) return null;
      try { check(); } catch { return null; }
      try { await validateOperationAuthority(); check(); } catch { return null; }
      if (!await reserveAttempt({ handle, funding, operationMaximumMicros: maximumCostMicros,
        attemptId: attempt.attemptId, attemptMaximumMicros: micros, bodySha256: attempt.bodySha256 })) return null;
      try { await validateOperationAuthority(); check(); } catch { return null; }
      // The gateway invokes this again synchronously inside its send callback.
      return { attemptId: attempt.attemptId, reservationRef: armId, clockId: attempt.clockId,
        validUntilMonotonicMs: authority.validUntilMonotonicMs, validateAuthorization: check };
    },
  } };
}

/** Business review writes P-009 outcomes without inventing invoice cost or
 * reviewer timing. The caller owns the transaction with the review event. */
export async function recordSupportWorkflowOutcome(sql: Sql, input: {
  handle: BlueprintOperationHandle; funding: SupportWorkflowFunding; decision: BusinessReviewDecision;
  reviewerPrincipal: string; evidenceRef: string;
}): Promise<void> {
  const { handle, funding } = input;
  if (funding.organization.controlWorkspaceId !== handle.workspaceId) throw new Error('Support outcome workspace mismatch');
  const recorded = await recordHostedOutcome(sql, {
    organization: funding.organization, allocationId: funding.allocationId,
    outcomeId: supportOperationReservationId(handle), workflowRef: `${handle.harnessSlug}:${handle.operationId}:${handle.specificationRevision}`,
    evidenceClass: 'internal-simulation', result: { state: input.decision === 'accept' ? 'accepted'
      : input.decision === 'reject' ? 'rejected' : 'rework-requested' },
    reservationIds: [supportOperationReservationId(handle)],
    reviewEffortSeconds: { unknownReason: 'review-duration-not-measured' },
    reworkCount: { unknownReason: 'rework-effort-not-measured' }, observedAtMs: Date.now(),
    evidenceRef: input.evidenceRef, recordedBy: input.reviewerPrincipal,
  });
  if (recorded.outcome !== 'recorded') throw new Error(`Support outcome refused: ${recorded.reason}`);
}

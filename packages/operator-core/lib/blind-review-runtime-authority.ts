/** Canonical, transaction-local authority for the host-owned runtime broker. */
import { isDeepStrictEqual } from 'node:util';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { BLIND_GAP_REVIEW_ACTOR } from './blind-review-session-bindings';
import { blindReviewerConfinement } from './blind-reviewer-mint';
import { isBlindReviewerBackendAgent } from './blind-reviewer-backends';
import { createRuntimeCustodyStore, runtimeCustodyFingerprint, type RuntimeAuthorityCheck } from './blind-review-runtime-custody';
import { validProductReadBoundary, validScratchPlanBoundary,
  type SessionToolConfinement } from './capability-envelope/session-confinement';

/**
 * All reads use the custody transaction, never a cached confinement or a second
 * pool. The shared plan advisory lock plus plan row lock serialize activation
 * and replacement writers; row locks serialize native lifecycle, binding state
 * and confinement writers until the custody operation commits. Call cleanup
 * hooks after their canonical writer commits, not in a nested transaction.
 * Errors propagate: an unavailable oracle never grants authority.
 */
export const checkRuntimeReviewerAuthority: RuntimeAuthorityCheck = async (tx, identity) => {
  // This first lookup selects a lock key only. Re-read the binding under that
  // lock before trusting any mutable or immutable value from it.
  const [scope] = await tx<Array<{ harness_slug: string; plan_slug: string }>>`
    SELECT harness_slug, plan_slug FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${identity.workspaceId} AND id = ${identity.bindingId}`;
  if (!scope) return false;
  await acquirePlanAdvisoryLock(tx, planAdvisoryLockKey(identity.workspaceId, scope.harness_slug, scope.plan_slug));
  await tx`SELECT set_config('lock_timeout', '5000', true)`;
  const [plan] = await tx<Array<{ plan_slug: string }>>`
    SELECT plan_slug FROM harness_shared.harness_plans
    WHERE workspace_id = ${identity.workspaceId} AND harness_slug = ${scope.harness_slug}
      AND plan_slug = ${scope.plan_slug} FOR SHARE`;
  if (!plan) return false;
  const [binding] = await tx<Array<{
    harness_slug: string; plan_slug: string; activation_audit_seq: number; attempt_seq: number;
    reviewer_owner_id: string; native_session_id: string; adv_session_id: number | string;
    launch_parent_owner: string; account_route: string | null; model_spec: string | null;
    status: string; confinement_snapshot: SessionToolConfinement;
  }>>`SELECT * FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${identity.workspaceId} AND id = ${identity.bindingId} FOR SHARE`;
  if (!binding || binding.harness_slug !== scope.harness_slug || binding.plan_slug !== scope.plan_slug ||
      binding.status !== 'ready' || binding.activation_audit_seq !== identity.activationAuditSeq ||
      binding.attempt_seq !== identity.replacementEpoch || binding.reviewer_owner_id !== identity.reviewerOwnerId ||
      binding.native_session_id !== identity.nativeSessionId || binding.launch_parent_owner !== BLIND_GAP_REVIEW_ACTOR ||
      binding.account_route !== 'auto') return false;
  const [activation] = await tx<Array<{ audit_seq: number }>>`
    SELECT audit_seq FROM harness_shared.plan_audits WHERE workspace_id = ${identity.workspaceId}
      AND harness_slug = ${scope.harness_slug} AND plan_slug = ${scope.plan_slug} AND audit_kind = 'activation'
    ORDER BY audit_seq DESC LIMIT 1`;
  if (activation?.audit_seq !== identity.activationAuditSeq) return false;
  // A launching or uncertain successor also cuts off the old binding. Neither
  // a missing native identity nor an uncommitted launch result restores it.
  const [successor] = await tx<Array<{ id: number | string }>>`
    SELECT id FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${identity.workspaceId} AND harness_slug = ${scope.harness_slug}
      AND plan_slug = ${scope.plan_slug} AND activation_audit_seq = ${identity.activationAuditSeq}
      AND id <> ${identity.bindingId} AND status <> 'failed'
      AND (attempt_seq > ${identity.replacementEpoch} OR replacement_of = ${identity.bindingId}) LIMIT 1`;
  if (successor) return false;
  const [native] = await tx<Array<{
    coord_owner_id: string | null; session_id: string | null; agent: string | null;
    ended_at: unknown; launch_spec: { account?: string; model?: string; headless?: boolean; launchedBy?: string } | null;
  }>>`SELECT coord_owner_id, session_id, agent, ended_at, launch_spec FROM harness_shared.adv_sessions
    WHERE workspace_id = ${identity.workspaceId} AND id = ${binding.adv_session_id} FOR SHARE`;
  if (!native || native.ended_at !== null || !isBlindReviewerBackendAgent(native.agent) ||
      native.coord_owner_id !== identity.reviewerOwnerId || native.session_id !== identity.nativeSessionId ||
      native.launch_spec?.launchedBy !== BLIND_GAP_REVIEW_ACTOR || native.launch_spec.headless !== true ||
      native.launch_spec.account !== binding.account_route || (native.launch_spec.model ?? null) !== binding.model_spec) return false;
  const [policy] = await tx<Array<{ confinement: SessionToolConfinement | null; live: boolean | null }>>`
    SELECT payload->'sessions'->${identity.reviewerOwnerId}->'confinement' AS confinement,
      (payload->'sessions'->${identity.reviewerOwnerId}->>'expiresAt')::timestamptz > clock_timestamp() AS live
    FROM harness_shared.operator_session_confinements WHERE workspace_id = ${identity.workspaceId} FOR SHARE`;
  const confinement = policy?.confinement;
  if (policy?.live !== true || !confinement || !Array.isArray(confinement.denyOutside) ||
      confinement.denyAmbientContext !== true ||
      confinement.denyProductReadsOutside !== undefined && !validProductReadBoundary(confinement.denyProductReadsOutside) ||
      confinement.denyPlansOutside !== undefined && !validScratchPlanBoundary(confinement.denyPlansOutside)) return false;
  // Match both the canonical mint grammar and the immutable launch snapshot.
  // A tampered snapshot plus identically tampered policy must not widen access.
  return isDeepStrictEqual(confinement, JSON.parse(JSON.stringify(blindReviewerConfinement(scope.plan_slug,
    confinement.denyProductReadsOutside, confinement.denyPlansOutside)))) &&
    isDeepStrictEqual(confinement, binding.confinement_snapshot) &&
    runtimeCustodyFingerprint(confinement) === identity.confinementFingerprint;
};

/** Operational callers cannot accidentally replace the canonical authority port. */
export function createCanonicalRuntimeCustodyStore(sql?: Parameters<typeof createRuntimeCustodyStore>[0]['sql']) {
  return createRuntimeCustodyStore({ sql, checkAuthority: checkRuntimeReviewerAuthority });
}

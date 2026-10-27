/** Signed review-only requests. Neither a request nor a review receipt grants execution. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { decodeOperatorSecretKey } from './operator-secret-key';
import { getPresence } from './agent-tools/coordination/presence';
import { latestFleetMembership } from './fleet-membership-store';
import {
  admissionAuthoritySchema, authorizeAdmissionReviewReplay, AdmissionAuthorityRefused,
  type AdmissionRecoveryAuthority,
} from './work-item-admission-authority';
import type { AdmissionRecoveryScope } from './work-item-admission-recovery';
import {
  readAdmissionMergeSnapshots, runWorkItemAdmissionPromoter, admissionReviewSubjectEligible,
  WORK_ITEM_ADMISSION_PROMOTER, type AdmissionMergeGuardRefusal, type PromoterLlmCall, type PromoterRunResult,
} from './work-items-admission-promoter';

const requestSchema = z.object({
  version: z.literal(1), requestId: z.string().uuid(), caller: z.string().min(1),
  purpose: z.literal('admission-review'), routineId: z.string().min(1),
  authority: admissionAuthoritySchema, requestedAt: z.string().datetime(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type ReviewRequest = z.infer<typeof requestSchema>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part) =>
  part && typeof part === 'object' && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);

async function signature(sql: Sql, scope: AdmissionRecoveryScope, request: Omit<ReviewRequest, 'signature'>) {
  const [key] = await sql<{ value_b64: string }[]>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'`;
  if (!key) throw new AdmissionAuthorityRefused('review signing key unavailable');
  return createHmac('sha256', decodeOperatorSecretKey(key.value_b64, 'spawn-signing-key'))
    .update(canonical(['admission-review-v1', scope, request])).digest('hex');
}

async function snapshot(sql: Sql, scope: AdmissionRecoveryScope, lockRows = false) {
  const item = (await readAdmissionMergeSnapshots(sql, {
    workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, ids: [scope.workItemId], lockRows,
  })).get(scope.workItemId);
  if (!item) throw new AdmissionAuthorityRefused('exact review subject not found');
  if (!admissionReviewSubjectEligible(item)) {
    throw new AdmissionAuthorityRefused('review subject has a terminal, human, policy, mixed or unproven park/dependency');
  }
  return item;
}

/** Custody and fleet placement are additional restrictions, never permission grants. */
async function authorize(sql: Sql, scope: AdmissionRecoveryScope, request: ReviewRequest) {
  const presence = await getPresence(request.caller);
  if (!presence || presence.revoked || presence.workspaceId !== scope.workspaceId) {
    throw new AdmissionAuthorityRefused('review requester absent, revoked or foreign');
  }
  const item = await snapshot(sql, scope);
  if (item.assignee !== request.caller) {
    const membership = await latestFleetMembership(scope.workspaceId, request.caller, sql);
    if (membership?.fleetRole !== 'leader' || !membership.fleetSlug) {
      throw new AdmissionAuthorityRefused('review requester is neither current custodian nor canonical fleet leader');
    }
    const rows = await sql<{ agent_id: string }[]>`
      SELECT DISTINCT agent_id FROM harness_shared.fleet_assignment
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
         AND work_item_id = ${scope.workItemId} AND fleet_slug = ${membership.fleetSlug}
         AND agent_id IS NOT NULL`;
    if (rows.length !== 1) throw new AdmissionAuthorityRefused('exact same-fleet placement unknown or ambiguous');
    const target = await latestFleetMembership(scope.workspaceId, rows[0]!.agent_id, sql);
    if (target?.fleetSlug !== membership.fleetSlug ||
        item.assignee && item.assignee !== rows[0]!.agent_id) {
      throw new AdmissionAuthorityRefused('current membership and review placement disagree');
    }
    const contract = (item.payload as Record<string, unknown>).claim_hold_release as { owner?: unknown } | undefined;
    if (contract && contract.owner !== request.caller) {
      throw new AdmissionAuthorityRefused('park release owner is not the current reviewing fleet leader');
    }
  }
  const revision = await authorizeAdmissionReviewReplay(sql, scope, request);
  return { item, revision };
}

async function verify(sql: Sql, scope: AdmissionRecoveryScope, request: ReviewRequest) {
  const { signature: saved, ...unsigned } = request;
  const expected = await signature(sql, scope, unsigned);
  if (!timingSafeEqual(Buffer.from(saved, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new AdmissionAuthorityRefused('review signature does not bind this exact scope/request/purpose');
  }
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.routines
     WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.harnessSlug}
       AND id = ${request.routineId} AND name = ${WORK_ITEM_ADMISSION_PROMOTER}
       AND target_role = ${`system:${WORK_ITEM_ADMISSION_PROMOTER}`} AND active = true`;
  if (rows.length !== 1) throw new AdmissionAuthorityRefused('original review promoter inactive');
}

export async function requestAdmissionReview(
  scope: AdmissionRecoveryScope,
  input: { caller: string; authority: AdmissionRecoveryAuthority; requestId?: string },
  sql: Sql = getOrgPg().sql,
) {
  const routines = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.routines
     WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.harnessSlug}
       AND name = ${WORK_ITEM_ADMISSION_PROMOTER}
       AND target_role = ${`system:${WORK_ITEM_ADMISSION_PROMOTER}`} AND active = true
       AND (trigger_config->>'cron' IS NOT NULL OR trigger_config->>'rrule' IS NOT NULL)`;
  if (routines.length !== 1) throw new AdmissionAuthorityRefused('one recurring admission promoter required');
  const unsigned = {
    version: 1 as const, requestId: input.requestId ?? randomUUID(), caller: input.caller,
    authority: input.authority, purpose: 'admission-review' as const, routineId: routines[0]!.id,
    requestedAt: new Date().toISOString(),
  };
  const request = requestSchema.parse({ ...unsigned, signature: await signature(sql, scope, unsigned) });
  // Initial policy observation is not retained as authority. Renew inside the lock.
  const initial = await authorize(sql, scope, request);
  await sql.begin(async rawTx => {
    const tx = rawTx as unknown as Sql;
    const locked = await snapshot(tx, scope, true);
    if (locked.fingerprint !== initial.item.fingerprint) throw new AdmissionAuthorityRefused('review custody changed');
    const renewed = await authorize(tx, scope, request);
    if (renewed.revision !== initial.revision) throw new AdmissionAuthorityRefused('review policy changed');
    await tx`UPDATE harness_shared.work_items SET payload =
      jsonb_set(COALESCE(payload, '{}'::jsonb), '{_admissionReviewRequest}', ${tx.typed(JSON.stringify(request), 25)}::jsonb)
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
        AND feature_id = ${scope.workItemId}`;
  });
  return { requestId: request.requestId, purpose: request.purpose, queued: true, pickupConfirmed: false };
}

/** Called only inside the existing promoter's single-flight slot. No executor side effects. */
export async function runAdmissionReviews(
  options: { workspaceId: string; harnessSlug: string; runId: string; targetItemIds?: readonly string[] },
  sql: Sql, llmCall: PromoterLlmCall,
): Promise<{ result: PromoterRunResult | null; guardRefusals: AdmissionMergeGuardRefusal[] }> {
  const rows = await sql<{ feature_id: string; request: unknown }[]>`
    SELECT feature_id, payload->'_admissionReviewRequest' AS request FROM harness_shared.work_items
     WHERE workspace_id = ${options.workspaceId} AND harness_slug = ${options.harnessSlug}
       AND admission IN ('pending', 'unreviewed')
       AND payload ? '_admissionReviewRequest'
       AND (jsonb_typeof(payload->'_admissionReviewRequest') IS DISTINCT FROM 'object'
         OR payload #>> '{_admissionReviewRequest,requestId}' IS NULL
         OR (payload #>> '{_admissionReviewReceipt,requestId}') IS DISTINCT FROM
           payload #>> '{_admissionReviewRequest,requestId}')
       AND (${options.targetItemIds === undefined} OR feature_id = ANY(${[...(options.targetItemIds ?? [])]}::text[]))
     ORDER BY feature_id LIMIT 20`;
  const guardRefusals: AdmissionMergeGuardRefusal[] = [];
  for (const row of rows) {
    const scope = { workspaceId: options.workspaceId, harnessSlug: options.harnessSlug, workItemId: row.feature_id };
    const refuse = (detail: string) => guardRefusals.push({
      itemId: scope.workItemId, canonicalId: null, reason: 'review-gated', detail,
    });
    const parsed = requestSchema.safeParse(row.request);
    if (!parsed.success) {
      refuse(`malformed admission review request: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
      continue;
    }
    const request = parsed.data;
    let initial: Awaited<ReturnType<typeof authorize>>;
    try {
      await verify(sql, scope, request);
      initial = await authorize(sql, scope, request);
    } catch (error) {
      if (!(error instanceof AdmissionAuthorityRefused)) throw error;
      refuse(error.message);
      continue;
    }

    // Keep model work and its final beforeWrite revalidation outside the preflight
    // catch: late custody, request, or policy drift must still abort the run.
    const result = await runWorkItemAdmissionPromoter({
      ...options, sql, llmCall, runId: `${options.runId}:review:${request.requestId}`,
      targetItemIds: [scope.workItemId],
      reviewOnly: {
        itemId: scope.workItemId,
        beforeWrite: async tx => {
          await verify(tx, scope, request);
          const current = await authorize(tx, scope, request);
          if (current.item.fingerprint !== initial.item.fingerprint ||
              canonical((current.item.payload as Record<string, unknown>)._admissionReviewRequest) !== canonical(row.request)) {
            throw new AdmissionAuthorityRefused('review request or custody changed during judging');
          }
          if (current.revision !== initial.revision) throw new AdmissionAuthorityRefused('review policy changed during judging');
        },
        afterWrite: async tx => {
          await tx`UPDATE harness_shared.work_items SET payload = jsonb_set(payload,
            '{_admissionReviewReceipt}', ${tx.typed(JSON.stringify({ requestId: request.requestId,
              purpose: request.purpose, runId: `${options.runId}:review:${request.requestId}`,
              pickupConfirmed: false }), 25)}::jsonb)
            WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
              AND feature_id = ${scope.workItemId}`;
        },
      },
    });
    return { result, guardRefusals };
  }
  return { result: null, guardRefusals };
}

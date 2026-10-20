/** Omitted-review recovery on the existing gate-watcher cadence. No new scheduler. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { readExternalBlockers } from '../external-blockers';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { defaultBlockerReapDeps } from './work-item-blocker-reaper';

export const OMITTED_REVIEW_AGE_MS = 30 * 60 * 1000;
/** Receipt GC (amend-receipts.ts trackAmendRun) keeps every unsettled recovery row,
 * and only this sweep settles one, so a row the nudge query can never select must be
 * settled here or it is retained forever (WI-6554700010018294). A carrier that is
 * missing, unbound or terminal settles at the nudge age. A carrier now held by
 * someone else, or by no one, waits this grace first: a carry-respawn releases
 * every claim, and the successor re-takes them. */
export const RELEASED_CARRIER_GRACE_MS = 24 * 60 * 60 * 1000;
const ACTOR = 'system:omitted-review-recovery';
interface Candidate {
  idempotency_key: string;
  rubric_ref: string;
  result_json: {
    preview: { approval?: { subjectPlan?: string }; rubricRevision?: number | null };
    _reviewRecovery: {
      ownerId: string; retryArgs: Record<string, unknown>; nudgedAt?: string; completedAt?: string;
      supersededByRevision?: number;
    };
  };
  work_item_id: string;
  harness_slug: string;
}
export interface ReviewStallMessage {
  ownerId: string; workItemId: string; harness: string; msgId: string;
  retry: { tool: 'rubrics:amend'; args: Record<string, unknown> };
}

async function deliver(message: ReviewStallMessage): Promise<void> {
  const workspaceId = activeWorkspaceId();
  try {
    await sendMessage({ ownerId: ACTOR, ownerLabel: 'Omitted review recovery', source: 'principal', workspaceId, userId: null }, {
      to: [message.ownerId], msgId: message.msgId, harnessSlug: message.harness,
      summary: `${message.workItemId}: required rubric review was not requested`,
      body: `This preview has waited at least thirty minutes without its required review. A one-agent implementation route permits platform-routed acceptance. This step is agent-actionable, not an owner exception. Run this exact call, then follow review.next:\n${JSON.stringify(message.retry)}`,
      extra: { expects: 'action', omittedReview: { workItemId: message.workItemId } },
    });
  } catch (error) {
    // Crash after durable send but before receipt stamp: the SAME message id
    // proves delivery on retry. Other failures leave the receipt eligible.
    if ((error as { code?: string }).code !== '23505') throw error;
  }
}

/** Clear only a typed ask bound to THIS receipt and its exact machine action.
 * An untyped wall or another owner question is never inferred away from prose. */
export async function clearOmittedReviewOwnerWall(candidate: {
  workItemId: string; harness: string; receiptKey: string;
}): Promise<void> {
  const current = await defaultBlockerReapDeps.readPayload(candidate.workItemId, candidate.harness);
  if (!current) return;
  const blockers = readExternalBlockers(current.payload);
  const matching = blockers.filter((b) => b.status === 'active' && b.ref === candidate.receiptKey
    && b.nextVerb?.startsWith('rubrics:amend'));
  if (!matching.length) return;
  const now = new Date().toISOString();
  const next = blockers.map((b) => matching.includes(b)
    ? { ...b, status: 'cleared' as const, updatedAt: now, clearedAt: now, clearedBy: ACTOR }
    : b);
  if (!await defaultBlockerReapDeps.writeBlockers(candidate.workItemId, candidate.harness, next, blockers)) return;
  await defaultBlockerReapDeps.restoreLifecycle({ id: candidate.workItemId, harness: candidate.harness,
    family: current.family, state: current.state, remaining: next.filter((b) => b.status === 'active') });
}

/** The rubric's live revision, or null when it cannot be resolved. Loaded lazily
 * so the gate-watch tick pays for the rubric library only when a candidate exists. */
async function readCurrentRubricRevision(rubricRef: string): Promise<number | null> {
  const { getRubric } = await import('../rubrics');
  return (await getRubric(rubricRef))?.revision ?? null;
}

export async function sweepOmittedReviews(options: {
  now?: number; limit?: number;
  send?: (message: ReviewStallMessage) => Promise<void>;
  wake?: (message: ReviewStallMessage) => Promise<void>;
  clearWall?: typeof clearOmittedReviewOwnerWall;
  currentRubricRevision?: (rubricRef: string) => Promise<number | null>;
} = {}): Promise<{ examined: number; nudged: number; superseded: number; released: number; errors: string[] }> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  const now = options.now ?? Date.now();
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = await sql<Candidate[]>`
    SELECT DISTINCT ON (r.rubric_ref, r.idempotency_key)
           r.idempotency_key, r.rubric_ref, r.result_json,
           w.feature_id AS work_item_id, w.harness_slug
      FROM harness_shared.rubric_amend_receipts r
      JOIN harness_shared.work_items w ON w.workspace_id = r.workspace_id
       AND w.taken_by = r.result_json #>> '{_reviewRecovery,ownerId}'
       AND w.feature_id = r.result_json #>> '{_reviewRecovery,carrier,workItemId}'
       AND w.harness_slug = r.result_json #>> '{_reviewRecovery,carrier,harness}'
       AND w.source_plan_slug = r.result_json #>> '{preview,approval,subjectPlan}'
     WHERE r.workspace_id = ${workspaceId} AND r.state = 'previewed'
       AND r.finished_at <= ${new Date(now - OMITTED_REVIEW_AGE_MS).toISOString()}::timestamptz
       AND r.result_json #>> '{preview,approvalRequired}' = 'true'
       AND r.result_json #>> '{review,state}' = 'not-requested'
       AND r.result_json #>> '{_reviewRecovery,completedAt}' IS NULL
       AND r.result_json #>> '{_reviewRecovery,ownerId}' IS NOT NULL
       AND jsonb_typeof(r.result_json #> '{_reviewRecovery,retryArgs}') = 'object'
       AND (w.status IN ('blocked', 'needs-human') OR
            (w.status IN ('open', 'wip', 'in-progress') AND w.payload->>'_claimHold' = 'true'))
     ORDER BY r.rubric_ref, r.idempotency_key, w.feature_id
     LIMIT ${limit}`;
  const result = { examined: rows.length, nudged: 0, superseded: 0, released: 0, errors: [] as string[] };
  for (const row of rows) {
    let message: ReviewStallMessage | undefined;
    let supersededByRevision: number | undefined;
    let settledSuperseded = false;
    try {
      // A preview is computed against one rubric revision. Once the rubric moved
      // past it (a later amendment committed), the preview can never be applied,
      // so re-requesting its review is a stale nudge. Settle it instead.
      const baseRevision = row.result_json.preview.rubricRevision;
      if (typeof baseRevision === 'number') {
        const current = await (options.currentRubricRevision ?? readCurrentRubricRevision)(row.rubric_ref);
        if (typeof current === 'number' && current > baseRevision) supersededByRevision = current;
      }
      await sql.begin(async (tx) => {
        const key = `${workspaceId}:${row.rubric_ref}:${row.idempotency_key}`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const [receipt] = await tx<{ result_json: Candidate['result_json'] }[]>`
          SELECT result_json FROM harness_shared.rubric_amend_receipts
           WHERE workspace_id = ${workspaceId} AND rubric_ref = ${row.rubric_ref}
             AND idempotency_key = ${row.idempotency_key} AND state = 'previewed'
             AND result_json #>> '{review,state}' = 'not-requested'
             AND result_json #>> '{_reviewRecovery,completedAt}' IS NULL FOR UPDATE`;
        if (!receipt) return;
        if (supersededByRevision !== undefined) {
          await tx`UPDATE harness_shared.rubric_amend_receipts
            SET result_json = jsonb_set(result_json, '{_reviewRecovery,supersededByRevision}', ${JSON.stringify(supersededByRevision)}::jsonb)
            WHERE workspace_id = ${workspaceId} AND rubric_ref = ${row.rubric_ref} AND idempotency_key = ${row.idempotency_key}`;
          result.superseded++;
          settledSuperseded = true;
          return;
        }
        const recovery = receipt.result_json._reviewRecovery;
        // A reassignment or owner answer after candidate selection cancels the
        // recovery. Lock and re-check the actual carrier before sending.
        const [carrier] = await tx<{ feature_id: string }[]>`
          SELECT feature_id FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId} AND feature_id = ${row.work_item_id}
             AND harness_slug = ${row.harness_slug} AND taken_by = ${recovery.ownerId}
             AND source_plan_slug = ${receipt.result_json.preview.approval?.subjectPlan ?? ''}
             AND (status IN ('blocked', 'needs-human') OR
                 (status IN ('open', 'wip', 'in-progress') AND payload->>'_claimHold' = 'true'))
           FOR UPDATE`;
        if (!carrier) return;
        message = { ownerId: recovery.ownerId, workItemId: row.work_item_id, harness: row.harness_slug,
          msgId: `coord-send-${createHash('sha256').update(`omitted-review:${key}`).digest('hex')}`,
          retry: { tool: 'rubrics:amend', args: { ...recovery.retryArgs, dryRun: true,
            requestReview: { workItemId: row.work_item_id, harness: row.harness_slug } } } };
        if (!recovery.nudgedAt) {
          await (options.send ?? deliver)(message);
          await tx`UPDATE harness_shared.rubric_amend_receipts
            SET result_json = jsonb_set(result_json, '{_reviewRecovery,nudgedAt}', ${JSON.stringify(new Date(now).toISOString())}::jsonb)
            WHERE workspace_id = ${workspaceId} AND rubric_ref = ${row.rubric_ref} AND idempotency_key = ${row.idempotency_key}`;
          result.nudged++;
        }
      });
      if (message || settledSuperseded) {
        // A wall bound to a superseded preview asks for a call that can no longer
        // apply; clear it on the same retryable path as a delivered nudge.
        await (options.clearWall ?? clearOmittedReviewOwnerWall)({ workItemId: row.work_item_id, harness: row.harness_slug, receiptKey: row.idempotency_key });
        if (message && options.wake) await options.wake(message);
        else if (message) await wakeRecipients([message.ownerId], { workspaceId, requiredWake: true,
          summary: 'Required rubric review is agent-actionable', payload: { msg_id: message.msgId }, source: ACTOR });
        await sql`UPDATE harness_shared.rubric_amend_receipts
          SET result_json = jsonb_set(result_json, '{_reviewRecovery,completedAt}', ${JSON.stringify(new Date(now).toISOString())}::jsonb)
          WHERE workspace_id = ${workspaceId} AND rubric_ref = ${row.rubric_ref} AND idempotency_key = ${row.idempotency_key}`;
      }
    } catch (error) {
      result.errors.push(`${row.rubric_ref}/${row.idempotency_key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    result.released = await settleUnnudgeableRecoveries(sql, workspaceId, now, limit);
  } catch (error) {
    result.errors.push(`release: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

/** Settle, with a reason, every unsettled recovery row the nudge query above can
 * never select. The predicates mirror that query's, so the two populations are
 * disjoint. One statement: row locks serialize it with a concurrent nudge. */
async function settleUnnudgeableRecoveries(
  sql: ReturnType<typeof getOrgPg>['sql'], workspaceId: string, now: number, limit: number,
): Promise<number> {
  const terminal = [...ANY_FAMILY_TERMINAL_STATES];
  const nudgeCutoff = new Date(now - OMITTED_REVIEW_AGE_MS).toISOString();
  const graceCutoff = new Date(now - RELEASED_CARRIER_GRACE_MS).toISOString();
  const settled = await sql<{ idempotency_key: string }[]>`
    WITH orphan AS (
      SELECT r.rubric_ref, r.idempotency_key,
             CASE WHEN r.result_json #>> '{preview,approvalRequired}' IS DISTINCT FROM 'true'
                    OR r.result_json #>> '{_reviewRecovery,ownerId}' IS NULL
                    OR jsonb_typeof(r.result_json #> '{_reviewRecovery,retryArgs}') IS DISTINCT FROM 'object'
                    THEN 'not-nudgeable'
                  WHEN r.result_json #>> '{_reviewRecovery,carrier,workItemId}' IS NULL THEN 'carrier-unbound'
                  WHEN w.feature_id IS NULL THEN 'carrier-missing'
                  WHEN w.status = ANY(${terminal}::text[]) THEN 'carrier-terminal'
                  WHEN r.finished_at <= ${graceCutoff}::timestamptz
                   AND (w.taken_by IS DISTINCT FROM r.result_json #>> '{_reviewRecovery,ownerId}'
                     OR w.source_plan_slug IS DISTINCT FROM r.result_json #>> '{preview,approval,subjectPlan}')
                    THEN 'carrier-released'
             END AS reason
        FROM harness_shared.rubric_amend_receipts r
        LEFT JOIN harness_shared.work_items w ON w.workspace_id = r.workspace_id
         AND w.feature_id = r.result_json #>> '{_reviewRecovery,carrier,workItemId}'
         AND w.harness_slug = r.result_json #>> '{_reviewRecovery,carrier,harness}'
       WHERE r.workspace_id = ${workspaceId} AND r.state = 'previewed'
         AND r.finished_at <= ${nudgeCutoff}::timestamptz
         AND r.result_json #>> '{review,state}' = 'not-requested'
         AND r.result_json->'_reviewRecovery' IS NOT NULL
         AND r.result_json #>> '{_reviewRecovery,completedAt}' IS NULL)
    UPDATE harness_shared.rubric_amend_receipts r
       SET result_json = jsonb_set(jsonb_set(r.result_json, '{_reviewRecovery,completedAt}', ${JSON.stringify(new Date(now).toISOString())}::jsonb),
             '{_reviewRecovery,settledReason}', to_jsonb(o.reason))
      FROM (SELECT * FROM orphan WHERE reason IS NOT NULL ORDER BY rubric_ref, idempotency_key LIMIT ${limit}) o
     WHERE r.workspace_id = ${workspaceId} AND r.rubric_ref = o.rubric_ref AND r.idempotency_key = o.idempotency_key
       AND r.state = 'previewed' AND r.result_json #>> '{_reviewRecovery,completedAt}' IS NULL
    RETURNING r.idempotency_key`;
  return settled.length;
}

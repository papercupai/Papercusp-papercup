/** Shared receipts: status polls may land on any operator worker. */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { TERMINAL_TASK_STATES } from '../../task-manager/types';

export type AmendReceiptState = 'running' | 'committed' | 'previewed' | 'failed';

export interface AmendReceiptEntry {
  idempotencyKey: string;
  rubricRef: string;
  state: AmendReceiptState;
  startedAt: number;
  finishedAt?: number;
  /** The exact JSON payload the synchronous call would have returned. */
  result?: Record<string, unknown>;
  error?: string;
}

export const AMEND_RECEIPT_RETENTION_MS = 60 * 60 * 1000;
/** A run still 'running' after this long is treated as orphaned and may be reclaimed by a same-key retry. */
export const AMEND_RECEIPT_RUNNING_LEASE_MS = 15 * 60 * 1000;
interface ReceiptRow {
  idempotency_key: string;
  rubric_ref: string;
  state: AmendReceiptState;
  started_at: Date | string;
  finished_at: Date | string | null;
  result_json: Record<string, unknown> | null;
  error: string | null;
}

function asEntry(row: ReceiptRow): AmendReceiptEntry {
  return {
    idempotencyKey: row.idempotency_key,
    rubricRef: row.rubric_ref,
    state: row.state,
    startedAt: new Date(row.started_at).getTime(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).getTime() } : {}),
    ...(row.result_json ? { result: row.result_json } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** A valid preview is not a completed review request when nobody could start. */
function reviewLaunchFailure(result: Record<string, unknown>): string | undefined {
  const review = result.review;
  if (result.ok !== true || result.dryRun !== true || !review || typeof review !== 'object'
    || !('state' in review) || review.state !== 'no-eligible-reviewer') return undefined;
  const fresh = 'freshReviewer' in review ? review.freshReviewer : undefined;
  if (fresh && typeof fresh === 'object' && 'state' in fresh && fresh.state === 'launched') return undefined;
  if (fresh && typeof fresh === 'object' && 'reason' in fresh && typeof fresh.reason === 'string') return fresh.reason;
  return 'no eligible amendment reviewer was routed or launched';
}

/**
 * Reserve the key before invoking the amend. A same-key request on another
 * worker reads the shared row rather than starting duplicate work.
 *
 * A FAILED receipt is re-run, never replayed (EI-24680663429090445). The key is
 * minted deterministically from the request, so a retry of the same payload
 * always lands on the same row. Replaying the stored failure therefore made
 * every retry for the next hour return the ORIGINAL error, even after the defect
 * behind it was fixed and deployed: an apply refused on a stale build kept
 * failing on the fixed one, and read exactly like the fix not working. A
 * failure commits nothing (the amendment transaction rolled back), and the rare
 * case where it committed and a later step threw is reconciled by amendRubric's
 * own Amendment-Id replay check, so running again is always safe. The claim is
 * an atomic `failed -> running` UPDATE, so concurrent retries still run once.
 * EI-25444129715658415: an ok:true dry-run can still fail to start its review.
 * Reclaim legacy previewed rows with that exact outcome as well; a routed or
 * launched reviewer remains replayable and must never be duplicated.
 */
export async function trackAmendRun(
  idempotencyKey: string,
  rubricRef: string,
  run: () => Promise<Record<string, unknown>>,
  options: { onRegistered?: () => void } = {},
): Promise<Record<string, unknown>> {
  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();
  // Finished previews/failures have no Decision fallback. Retain them for one
  // hour, then bound the shared table opportunistically on the next amend.
  await sql`
    DELETE FROM harness_shared.rubric_amend_receipts
     WHERE workspace_id = ${workspaceId}
       AND finished_at < now() - interval '1 hour' AND state <> 'running'
  `;
  const inserted = await sql<Array<{ idempotency_key: string }>>`
    INSERT INTO harness_shared.rubric_amend_receipts
      (workspace_id, rubric_ref, idempotency_key, state)
    VALUES (${workspaceId}, ${rubricRef}, ${idempotencyKey}, 'running')
    ON CONFLICT (workspace_id, rubric_ref, idempotency_key) DO NOTHING
    RETURNING idempotency_key
  `;
  // A 'running' row past the lease belongs to a worker that died mid-run (an operator
  // restart kills the in-process run before it can write 'failed'). Keys are
  // deterministic per request, so without this reclaim every same-key retry would
  // answer `pending` forever (WI-10006937).
  const leaseSeconds = Math.round(AMEND_RECEIPT_RUNNING_LEASE_MS / 1000);
  const reclaimed = inserted.length > 0 ? [] : await sql<Array<{ idempotency_key: string }>>`
    UPDATE harness_shared.rubric_amend_receipts
       SET state = 'running', result_json = NULL, error = NULL, started_at = now(), finished_at = NULL
     WHERE workspace_id = ${workspaceId} AND rubric_ref = ${rubricRef}
       AND idempotency_key = ${idempotencyKey}
       AND (state = 'failed'
         OR (state = 'previewed'
           AND result_json->>'ok' = 'true' AND result_json->>'dryRun' = 'true'
           AND result_json #>> '{review,state}' = 'no-eligible-reviewer'
           AND result_json #>> '{review,freshReviewer,state}' IS DISTINCT FROM 'launched')
         -- WI-6554700010010527: a launched reviewer whose task ENDED with nothing
         -- posted after the preview is dead, not pending. Replaying it stranded the
         -- review until the receipt aged out; re-running reaches the launcher, which
         -- re-keys past the dead task.
         OR (state = 'previewed'
           AND result_json #>> '{review,freshReviewer,state}' = 'launched'
           AND EXISTS (
             SELECT 1 FROM harness_shared.task_ledger tl
              WHERE tl.task_id = result_json #>> '{review,freshReviewer,taskId}'
                AND tl.state = ANY(${[...TERMINAL_TASK_STATES]}::text[]))
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.coord_thread_posts pv
               JOIN harness_shared.coord_thread_posts p
                 ON p.workspace_id = pv.workspace_id AND p.thread_id = pv.thread_id AND p.id > pv.id
              WHERE pv.workspace_id = ${workspaceId}
                AND pv.id = substring(result_json #>> '{review,previewPostRef}' from '^thread-post:([0-9]+)$')::bigint))
         OR (state = 'running' AND started_at < now() - make_interval(secs => ${leaseSeconds})))
    RETURNING idempotency_key
  `;
  if (inserted.length === 0 && reclaimed.length === 0) {
    const existing = await getAmendReceipt(rubricRef, idempotencyKey);
    if (!existing) throw new Error('rubric amend receipt disappeared during same-key retry');
    options.onRegistered?.();
    if (existing.result) return existing.result;
    if (existing.state === 'failed') throw new Error(existing.error ?? 'previous rubric amendment failed');
    return { ok: true, pending: true, idempotencyKey, receipt: { rubricRef, idempotencyKey } };
  }
  options.onRegistered?.();
  let result: Record<string, unknown>;
  try {
    result = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE harness_shared.rubric_amend_receipts
         SET state = 'failed', error = ${message}, finished_at = now()
       WHERE workspace_id = ${workspaceId} AND rubric_ref = ${rubricRef}
         AND idempotency_key = ${idempotencyKey} AND state = 'running'
    `;
    throw error;
  }
  // A persistence failure after the amend committed must never reclassify it as
  // failed. The atomic Decision remains the source of truth for applied BARs.
  const launchFailure = reviewLaunchFailure(result);
  const state: AmendReceiptState = launchFailure ? 'failed' : result.ok === true
    ? (result.dryRun === true ? 'previewed' : 'committed') : 'failed';
  const error = state === 'failed'
    ? (launchFailure ?? (typeof result.error === 'string' ? result.error : 'amend returned ok:false')) : null;
  await sql`
    UPDATE harness_shared.rubric_amend_receipts
       SET state = ${state}, result_json = ${JSON.stringify(result)}::text::jsonb,
           error = ${error}, finished_at = now()
     WHERE workspace_id = ${workspaceId} AND rubric_ref = ${rubricRef}
       AND idempotency_key = ${idempotencyKey}
  `;
  return result;
}

export async function getAmendReceipt(rubricRef: string, idempotencyKey: string): Promise<AmendReceiptEntry | undefined> {
  const { sql } = getOrgPg();
  const rows = await sql<ReceiptRow[]>`
    SELECT idempotency_key, rubric_ref, state, started_at, finished_at, result_json, error
      FROM harness_shared.rubric_amend_receipts
     WHERE workspace_id = ${activeWorkspaceId()}
       AND rubric_ref = ${rubricRef}
       AND idempotency_key = ${idempotencyKey.trim()}
  `;
  return rows[0] ? asEntry(rows[0]) : undefined;
}

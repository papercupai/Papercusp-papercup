/** Operation private input (plan app-agent-tasks-durable-execution-2026-10-06
 * D-014, WI-10006699).
 *
 * An operation may declare `privateInputSchema`: content the submitter hands to
 * the worker WITHOUT putting it in the work-item payload. The payload is pinned
 * and replay-hashed, and it outlives the app's own content deletion (a Phone
 * call transcript is deleted by the app after 30 days, phone D-022), so private
 * content must not live there.
 *
 * The content is stored in `harness_shared.blueprint_operation_private_inputs`
 * (migration 1401) under the invocation's natural key, BEFORE the work item is
 * accepted, so a worker can never hold an item whose private input is missing.
 * Only the current holder of the operation's NON-terminal work item can read it,
 * and the trigger-delivery retention sweep deletes it once the item is terminal
 * or the row expires.
 *
 * `contentText` is the exact serialization that was hashed: JSON.stringify of
 * the submitted value. A submitter that hashes the same value the same way
 * (Phone's transcriptDigest) therefore gets an identical sha256, which is how a
 * worker verifies the content against a reference in its operation input. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { getWorkItem, isSelfOwnerRecord } from '../work-items';
import { isSettledWorkItem } from '../work-items-events';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { workItemStorageSlug } from '../pot-membership';
import { BlueprintOperationRefusal } from './operation-refusal';

/** Matches the migration's CHECK on octet_length(content_text). */
export const OPERATION_PRIVATE_INPUT_MAX_BYTES = 4 * 1024 * 1024;

/** How long an unread or orphaned row may live (D-014: under phone D-022's 30 days). */
export const OPERATION_PRIVATE_INPUT_TTL_DAYS = 7;

export interface SerializedPrivateInput {
  contentText: string;
  sha256: string;
}

export function serializeOperationPrivateInput(value: unknown): SerializedPrivateInput {
  const contentText = JSON.stringify(value);
  if (typeof contentText !== 'string') {
    throw new BlueprintOperationRefusal('invalid_payload', 'blueprint operation privateInput must be a JSON value');
  }
  if (Buffer.byteLength(contentText, 'utf8') > OPERATION_PRIVATE_INPUT_MAX_BYTES) {
    throw new BlueprintOperationRefusal('invalid_payload',
      `blueprint operation privateInput exceeds ${OPERATION_PRIVATE_INPUT_MAX_BYTES} bytes`);
  }
  return { contentText, sha256: createHash('sha256').update(contentText, 'utf8').digest('hex') };
}

export interface OperationPrivateInputKey {
  workspaceId: string;
  harnessSlug: string;
  callerId: string;
  operationId: string;
  requestKey: string;
}

/**
 * Validate and store a submission's private input. Runs BEFORE the work item is
 * accepted. Returns without writing when the operation declares no private input
 * and none was sent.
 *
 * - privateInput sent to an operation that does not declare it → `invalid_request`.
 * - declared but absent, or failing the schema → `invalid_payload`.
 * - an existing row for the same key with different content → `input_conflict`
 *   (D-014's private_input_conflict; the message names it).
 * - `alreadyAccepted` (the receipt exists): never (re)write. The row was written
 *   before the first acceptance; if it is gone, the item went terminal or expired,
 *   and re-creating deleted private content on a replay is exactly what D-014 forbids.
 */
export async function storeOperationPrivateInput(
  sql: Sql,
  key: OperationPrivateInputKey,
  declaration: { schema: Record<string, unknown> | undefined; value: unknown; alreadyAccepted: boolean },
): Promise<{ stored: boolean; sha256: string } | null> {
  const sent = declaration.value !== undefined;
  if (!declaration.schema) {
    if (sent) {
      throw new BlueprintOperationRefusal('invalid_request',
        `blueprint operation "${key.operationId}" declares no privateInputSchema, so it accepts no privateInput`);
    }
    return null;
  }
  if (!sent) {
    throw new BlueprintOperationRefusal('invalid_payload',
      `blueprint operation "${key.operationId}" declares privateInputSchema; privateInput is required`);
  }
  const verdict = checkAgainstJsonSchema(declaration.schema, declaration.value);
  if (!verdict.ok) {
    throw new BlueprintOperationRefusal('invalid_payload',
      `blueprint operation privateInput ${verdict.code}: ${verdict.errors.join('; ')}`);
  }
  const serialized = serializeOperationPrivateInput(declaration.value);
  const existing = await readStoredSha(sql, key);
  if (existing !== null) {
    if (existing !== serialized.sha256) throw privateInputConflict(key);
    return { stored: false, sha256: serialized.sha256 };
  }
  if (declaration.alreadyAccepted) return { stored: false, sha256: serialized.sha256 };
  const inserted = await sql<Array<{ content_sha256: string }>>`
    INSERT INTO harness_shared.blueprint_operation_private_inputs
      (workspace_id, harness_slug, caller_id, operation_id, request_key,
       content_text, content_sha256, expires_at)
    VALUES (${key.workspaceId}, ${key.harnessSlug}, ${key.callerId}, ${key.operationId}, ${key.requestKey},
            ${serialized.contentText}, ${serialized.sha256},
            now() + make_interval(days => ${OPERATION_PRIVATE_INPUT_TTL_DAYS}))
    ON CONFLICT (workspace_id, harness_slug, caller_id, operation_id, request_key) DO NOTHING
    RETURNING content_sha256`;
  if (inserted.length > 0) return { stored: true, sha256: serialized.sha256 };
  // A concurrent submit with the same key won the insert; content must match.
  const raced = await readStoredSha(sql, key);
  if (raced !== serialized.sha256) throw privateInputConflict(key);
  return { stored: false, sha256: serialized.sha256 };
}

function privateInputConflict(key: OperationPrivateInputKey): BlueprintOperationRefusal {
  return new BlueprintOperationRefusal('input_conflict',
    `private_input_conflict: request key "${key.requestKey}" was already submitted with different privateInput`);
}

async function readStoredSha(sql: Sql, key: OperationPrivateInputKey): Promise<string | null> {
  const rows = await sql<Array<{ content_sha256: string }>>`
    SELECT content_sha256 FROM harness_shared.blueprint_operation_private_inputs
     WHERE workspace_id = ${key.workspaceId} AND harness_slug = ${key.harnessSlug}
       AND caller_id = ${key.callerId} AND operation_id = ${key.operationId}
       AND request_key = ${key.requestKey}`;
  return rows[0]?.content_sha256 ?? null;
}

export interface OperationPrivateInputRead {
  workItemId: string;
  operationId: string;
  content: unknown;
  /** sha256 over JSON.stringify(content), exactly as stored. */
  sha256: string;
  expiresAt: string;
}

/** Refusal codes of the worker read. Every refusal is a caller-visible reason. */
export type PrivateInputReadRefusal =
  | 'private_input_not_operation'
  | 'private_input_item_missing'
  | 'private_input_not_holder'
  | 'private_input_terminal'
  | 'private_input_absent';

export class PrivateInputReadError extends Error {
  override readonly name = 'PrivateInputReadError';
  constructor(readonly code: PrivateInputReadRefusal, message: string) {
    super(`${code}: ${message}`);
  }
}

/**
 * The worker read (`blueprint:read-private-input`). Refuses unless `holderOwnerId`
 * currently holds the work item, the item is the target of an operation
 * invocation, the item is not terminal, and the row exists and has not expired.
 */
export async function readOperationPrivateInput(
  sql: Sql,
  input: { workspaceId: string; workItemId: string; holderOwnerId: string },
): Promise<OperationPrivateInputRead> {
  const id = input.workItemId.trim();
  const receipts = await sql<Array<{
    harness_slug: string; caller_id: string; operation_id: string; request_key: string;
    target_harness_slug: string | null;
  }>>`
    SELECT harness_slug, caller_id, operation_id, request_key, target_harness_slug
      FROM harness_shared.blueprint_operation_invocations
     WHERE workspace_id = ${input.workspaceId} AND target_kind = 'work-item' AND target_ref = ${id}
     ORDER BY id DESC
     LIMIT 1`;
  const receipt = receipts[0];
  if (!receipt) {
    throw new PrivateInputReadError('private_input_not_operation',
      `work item ${id} is not the target of a blueprint operation in this workspace`);
  }
  const storageHarness = receipt.target_harness_slug
    ?? await workItemStorageSlug(receipt.harness_slug, input.workspaceId);
  const item = await getWorkItem(id, storageHarness);
  if (!item || item.harness !== storageHarness) {
    throw new PrivateInputReadError('private_input_item_missing', `work item ${id} is missing`);
  }
  if (isSettledWorkItem(item)) {
    throw new PrivateInputReadError('private_input_terminal',
      `work item ${id} is ${item.state}; its private input is no longer readable`);
  }
  if (!isSelfOwnerRecord(item.assignee, input.holderOwnerId)) {
    throw new PrivateInputReadError('private_input_not_holder',
      `work item ${id} is held by ${item.assignee ?? 'nobody'}, not ${input.holderOwnerId}; claim it first`);
  }
  const rows = await sql<Array<{ content_text: string; content_sha256: string; expires_at: Date }>>`
    SELECT content_text, content_sha256, expires_at
      FROM harness_shared.blueprint_operation_private_inputs
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${receipt.harness_slug}
       AND caller_id = ${receipt.caller_id} AND operation_id = ${receipt.operation_id}
       AND request_key = ${receipt.request_key}
       AND expires_at > now()`;
  const row = rows[0];
  if (!row) {
    throw new PrivateInputReadError('private_input_absent',
      `work item ${id} has no readable private input (never sent, expired, or deleted)`);
  }
  return {
    workItemId: id,
    operationId: receipt.operation_id,
    content: JSON.parse(row.content_text) as unknown,
    sha256: row.content_sha256,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/**
 * Retention step for the 15-minute triggerDeliveryRetention workflow: delete
 * private inputs whose operation work item is terminal or missing, and every
 * row past expires_at. Bounded per call so one tick never holds a long lock.
 */
export async function pruneOperationPrivateInputs(
  options: { sql?: Sql; limit?: number } = {},
): Promise<{ deleted: number }> {
  const sql = options.sql ?? getOrgPg().sql;
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
  const rows = await sql<Array<{ n: number }>>`
    WITH doomed AS (
      SELECT p.workspace_id, p.harness_slug, p.caller_id, p.operation_id, p.request_key
        FROM harness_shared.blueprint_operation_private_inputs p
        LEFT JOIN harness_shared.blueprint_operation_invocations i
          ON i.workspace_id = p.workspace_id AND i.harness_slug = p.harness_slug
         AND i.caller_id = p.caller_id AND i.operation_id = p.operation_id
         AND i.request_key = p.request_key AND i.target_kind = 'work-item'
        LEFT JOIN harness_shared.work_items w
          ON w.workspace_id = i.workspace_id AND w.feature_id = i.target_ref
         AND w.harness_slug = COALESCE(i.target_harness_slug, i.harness_slug)
       WHERE p.expires_at <= now()
          OR (i.id IS NOT NULL AND w.feature_id IS NULL)
          OR w.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])
       LIMIT ${limit}
    ), gone AS (
      DELETE FROM harness_shared.blueprint_operation_private_inputs p
       USING doomed d
       WHERE p.workspace_id = d.workspace_id AND p.harness_slug = d.harness_slug
         AND p.caller_id = d.caller_id AND p.operation_id = d.operation_id
         AND p.request_key = d.request_key
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`;
  return { deleted: rows[0]?.n ?? 0 };
}

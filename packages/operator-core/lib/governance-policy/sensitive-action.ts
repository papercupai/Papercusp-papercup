/**
 * Sensitive actions with separation of duties (P-006, plan papercusp-enterprise-readiness-roadmap-2026-10-09, D-015).
 *
 * A sensitive action is PREPARED by one principal, APPROVED by distinct authorized human principals,
 * then EXECUTED exactly once inside a short window. Storage: harness_shared.sensitive_action_requests
 * + sensitive_action_approvals (migration 1498), whose triggers refuse self-approval, decisions on a
 * non-pending request, re-execution and execution after the window, independently of this code.
 *
 * The sample action is an organization/department governance policy change (control.ts
 * prepareGovernancePolicyChange / applyGovernancePolicyChange). The module is action-agnostic: the
 * caller supplies the payload when preparing and the effect (`run`) when executing, and `run` runs in
 * a savepoint of the same transaction that marks the request executed, so the effect and the
 * one-time mark commit together or not at all.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { authorize, principalKindOf } from './authority';

/** How long a prepared request may wait for its approvals. */
export const SENSITIVE_ACTION_REQUEST_TTL_MS = 24 * 60 * 60_000;
/** Short-lived authorization: how long a fully approved request stays executable. */
export const SENSITIVE_ACTION_EXECUTION_WINDOW_MS = 15 * 60_000;
export const MAX_REQUIRED_APPROVALS = 5;

export type SensitiveActionStatus = 'pending' | 'approved' | 'executed' | 'denied' | 'expired' | 'cancelled';
export type SensitiveActionDecision = 'approve' | 'deny';

export type SensitiveActionErrorCode =
  | 'invalid'
  | 'not-found'
  | 'forbidden'
  | 'self-approval'
  | 'already-decided'
  | 'not-pending'
  | 'not-approved'
  | 'expired'
  | 'replayed'
  | 'payload-mismatch'
  | 'stale';

export class SensitiveActionError extends Error {
  constructor(
    readonly code: SensitiveActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SensitiveActionError';
  }
}

export interface SensitiveActionApproval {
  approver: string;
  decision: SensitiveActionDecision;
  reason: string;
  decidedAt: string;
}

export interface SensitiveActionRequest {
  requestId: string;
  workspaceId: string;
  actionKind: string;
  targetLayerId: string;
  authorityLayerId: string;
  payload: unknown;
  payloadHash: string;
  chainRevision: string | null;
  baseVersion: number;
  simulation: unknown;
  preparedBy: string;
  reason: string;
  requiredApprovals: number;
  status: SensitiveActionStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  executeBy: string | null;
  executedAt: string | null;
  executedBy: string | null;
  result: unknown;
  approvals: SensitiveActionApproval[];
}

function sqlOf(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** Canonical JSON (object keys sorted at every depth) so the hash pins content, not key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sensitivePayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

interface RawRequestRow {
  request_id: string;
  workspace_id: string;
  action_kind: string;
  target_layer_id: string;
  authority_layer_id: string;
  payload: unknown;
  payload_hash: string;
  chain_revision: string | null;
  base_version: number;
  simulation: unknown;
  prepared_by: string;
  reason: string;
  required_approvals: number;
  status: SensitiveActionStatus;
  created_at: Date | string;
  expires_at: Date | string;
  approved_at: Date | string | null;
  execute_by: Date | string | null;
  executed_at: Date | string | null;
  executed_by: string | null;
  result: unknown;
}

const REQUEST_COLUMNS =
  'request_id, workspace_id, action_kind, target_layer_id, authority_layer_id, payload, payload_hash, chain_revision, base_version, simulation, prepared_by, reason, required_approvals, status, created_at, expires_at, approved_at, execute_by, executed_at, executed_by, result';

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** A jsonb column may arrive as a parsed value or (on some pools) as its JSON text. */
function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function requestOf(row: RawRequestRow, approvals: SensitiveActionApproval[]): SensitiveActionRequest {
  return {
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    actionKind: row.action_kind,
    targetLayerId: row.target_layer_id,
    authorityLayerId: row.authority_layer_id,
    payload: jsonValue(row.payload),
    payloadHash: row.payload_hash,
    chainRevision: row.chain_revision,
    baseVersion: Number(row.base_version),
    simulation: jsonValue(row.simulation),
    preparedBy: row.prepared_by,
    reason: row.reason,
    requiredApprovals: Number(row.required_approvals),
    status: row.status,
    createdAt: iso(row.created_at) as string,
    expiresAt: iso(row.expires_at) as string,
    approvedAt: iso(row.approved_at),
    executeBy: iso(row.execute_by),
    executedAt: iso(row.executed_at),
    executedBy: row.executed_by,
    result: jsonValue(row.result),
    approvals,
  };
}

async function approvalsOf(db: Sql, requestId: string): Promise<SensitiveActionApproval[]> {
  const rows = await db<Array<{ approver: string; decision: SensitiveActionDecision; reason: string; decided_at: Date | string }>>`
    SELECT approver, decision, reason, decided_at FROM harness_shared.sensitive_action_approvals
     WHERE request_id = ${requestId} ORDER BY decided_at, approver
  `;
  return rows.map((r) => ({ approver: r.approver, decision: r.decision, reason: r.reason, decidedAt: iso(r.decided_at) as string }));
}

async function lockRequest(tx: Sql, requestId: string): Promise<RawRequestRow> {
  const rows = await tx<RawRequestRow[]>`
    SELECT ${tx.unsafe(REQUEST_COLUMNS)} FROM harness_shared.sensitive_action_requests
     WHERE request_id = ${requestId} FOR UPDATE
  `;
  if (!rows[0]) throw new SensitiveActionError('not-found', `no sensitive action request '${requestId}'`);
  return rows[0];
}

export interface PrepareSensitiveActionInput {
  workspaceId: string;
  actionKind: string;
  targetLayerId: string;
  authorityLayerId: string;
  payload: unknown;
  chainRevision: string | null;
  baseVersion: number;
  simulation: unknown;
  preparedBy: string;
  reason: string;
  requiredApprovals?: number;
  now?: Date;
}

/** Record a prepared sensitive action. The preparer needs `prepare` over the authority layer. */
export async function prepareSensitiveAction(input: PrepareSensitiveActionInput, sql?: Sql): Promise<SensitiveActionRequest> {
  const now = input.now ?? new Date();
  for (const field of ['workspaceId', 'actionKind', 'targetLayerId', 'authorityLayerId', 'preparedBy', 'reason'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim()) throw new SensitiveActionError('invalid', `${field} is required`);
  }
  const required = input.requiredApprovals ?? 1;
  if (!Number.isInteger(required) || required < 1 || required > MAX_REQUIRED_APPROVALS) {
    throw new SensitiveActionError('invalid', `requiredApprovals must be an integer from 1 to ${MAX_REQUIRED_APPROVALS}`);
  }
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) throw new SensitiveActionError('invalid', 'baseVersion must be >= 0');
  const db = sqlOf(sql);
  if (!(await authorize(input.preparedBy, input.authorityLayerId, 'prepare', { now, sql: db }))) {
    throw new SensitiveActionError('forbidden', `${input.preparedBy} holds no prepare authority over ${input.authorityLayerId}`);
  }
  const expiresAt = new Date(now.getTime() + SENSITIVE_ACTION_REQUEST_TTL_MS);
  // jsonb binds as JSON text + ::text::jsonb (agent-insights/postgres-js-jsonb-binding).
  const rows = await db<RawRequestRow[]>`
    INSERT INTO harness_shared.sensitive_action_requests
      (workspace_id, action_kind, target_layer_id, authority_layer_id, payload, payload_hash, chain_revision,
       base_version, simulation, prepared_by, reason, required_approvals, status, created_at, expires_at)
    VALUES (${input.workspaceId}, ${input.actionKind}, ${input.targetLayerId}, ${input.authorityLayerId},
            ${JSON.stringify(input.payload ?? null)}::text::jsonb, ${sensitivePayloadHash(input.payload)}, ${input.chainRevision},
            ${input.baseVersion}, ${JSON.stringify(input.simulation ?? null)}::text::jsonb, ${input.preparedBy},
            ${input.reason.trim()}, ${required}, 'pending', ${now}, ${expiresAt})
    RETURNING ${db.unsafe(REQUEST_COLUMNS)}
  `;
  return requestOf(rows[0], []);
}

export async function getSensitiveAction(requestId: string, sql?: Sql): Promise<SensitiveActionRequest | null> {
  const db = sqlOf(sql);
  const rows = await db<RawRequestRow[]>`
    SELECT ${db.unsafe(REQUEST_COLUMNS)} FROM harness_shared.sensitive_action_requests WHERE request_id = ${requestId}
  `;
  return rows[0] ? requestOf(rows[0], await approvalsOf(db, requestId)) : null;
}

/** Open (pending/approved) requests, newest first; pass `status: 'all'` for history. */
export async function listSensitiveActions(
  opts: { workspaceId?: string; actionKind?: string; status?: 'open' | 'all'; limit?: number; sql?: Sql } = {},
): Promise<SensitiveActionRequest[]> {
  const db = sqlOf(opts.sql);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const openOnly = (opts.status ?? 'open') === 'open';
  const rows = await db<RawRequestRow[]>`
    SELECT ${db.unsafe(REQUEST_COLUMNS)} FROM harness_shared.sensitive_action_requests
     WHERE (${opts.workspaceId ?? null}::text IS NULL OR workspace_id = ${opts.workspaceId ?? null})
       AND (${opts.actionKind ?? null}::text IS NULL OR action_kind = ${opts.actionKind ?? null})
       AND (${!openOnly} OR status IN ('pending', 'approved'))
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  const out: SensitiveActionRequest[] = [];
  for (const row of rows) out.push(requestOf(row, await approvalsOf(db, row.request_id)));
  return out;
}

export interface DecideSensitiveActionInput {
  requestId: string;
  approver: string;
  decision: SensitiveActionDecision;
  reason: string;
  now?: Date;
}

/**
 * Record one approve/deny decision. The approver must be a human principal other than the preparer
 * and hold `approve` over the request's authority layer. A deny ends the request; the approval that
 * reaches `requiredApprovals` opens a SENSITIVE_ACTION_EXECUTION_WINDOW_MS execution window.
 */
export async function decideSensitiveAction(input: DecideSensitiveActionInput, sql?: Sql): Promise<SensitiveActionRequest> {
  const now = input.now ?? new Date();
  if (input.decision !== 'approve' && input.decision !== 'deny') throw new SensitiveActionError('invalid', 'decision must be approve or deny');
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new SensitiveActionError('invalid', 'reason is required');
  const db = sqlOf(sql);
  const outcome = await db.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    const req = await lockRequest(tx, input.requestId);
    if (req.status !== 'pending') return { error: new SensitiveActionError('not-pending', `request ${input.requestId} is ${req.status}`) };
    if (now.getTime() >= new Date(req.expires_at).getTime()) {
      await tx`UPDATE harness_shared.sensitive_action_requests SET status = 'expired' WHERE request_id = ${input.requestId}`;
      return { error: new SensitiveActionError('expired', `request ${input.requestId} expired before it was approved`) };
    }
    if (input.approver === req.prepared_by) {
      return { error: new SensitiveActionError('self-approval', `${input.approver} prepared request ${input.requestId} and cannot decide it`) };
    }
    if (principalKindOf(input.approver) !== 'human') {
      return { error: new SensitiveActionError('forbidden', `${input.approver} is a service identity; only a human administrator can decide`) };
    }
    if (!(await authorize(input.approver, req.authority_layer_id, 'approve', { now, sql: tx }))) {
      return { error: new SensitiveActionError('forbidden', `${input.approver} holds no approve authority over ${req.authority_layer_id}`) };
    }
    const prior = await tx<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.sensitive_action_approvals
       WHERE request_id = ${input.requestId} AND approver = ${input.approver}
    `;
    if (Number(prior[0]?.n ?? 0) > 0) {
      return { error: new SensitiveActionError('already-decided', `${input.approver} already decided request ${input.requestId}`) };
    }
    await tx`
      INSERT INTO harness_shared.sensitive_action_approvals (request_id, approver, decision, reason, decided_at)
      VALUES (${input.requestId}, ${input.approver}, ${input.decision}, ${input.reason.trim()}, ${now})
    `;
    if (input.decision === 'deny') {
      await tx`UPDATE harness_shared.sensitive_action_requests SET status = 'denied' WHERE request_id = ${input.requestId}`;
    } else {
      const approved = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.sensitive_action_approvals
         WHERE request_id = ${input.requestId} AND decision = 'approve'
      `;
      if (Number(approved[0]?.n ?? 0) >= Number(req.required_approvals)) {
        const expiresAt = new Date(req.expires_at).getTime();
        const executeBy = new Date(Math.min(now.getTime() + SENSITIVE_ACTION_EXECUTION_WINDOW_MS, expiresAt));
        await tx`
          UPDATE harness_shared.sensitive_action_requests
             SET status = 'approved', approved_at = ${now}, execute_by = ${executeBy}
           WHERE request_id = ${input.requestId}
        `;
      }
    }
    return { error: null };
  });
  if (outcome.error) throw outcome.error;
  return (await getSensitiveAction(input.requestId, db)) as SensitiveActionRequest;
}

export interface ExecuteSensitiveActionInput {
  requestId: string;
  executor: string;
  /** When given, execution is refused unless it equals the prepared payload's hash. */
  expectedPayloadHash?: string;
  now?: Date;
}

/**
 * Execute an approved request exactly once. `run` performs the effect inside a savepoint of the
 * transaction that marks the request executed. A `run` that throws SensitiveActionError('stale')
 * cancels the request (it can never become valid again); any other failure leaves it approved.
 */
export async function executeSensitiveAction<T>(
  input: ExecuteSensitiveActionInput,
  run: (tx: Sql, request: SensitiveActionRequest) => Promise<T>,
  sql?: Sql,
): Promise<{ request: SensitiveActionRequest; result: T }> {
  const now = input.now ?? new Date();
  const db = sqlOf(sql);
  const outcome = await db.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    const row = await lockRequest(tx, input.requestId);
    if (row.status === 'executed') {
      return { error: new SensitiveActionError('replayed', `request ${input.requestId} was already executed at ${iso(row.executed_at)}`) };
    }
    if (row.status !== 'approved') {
      return { error: new SensitiveActionError('not-approved', `request ${input.requestId} is ${row.status}, not approved`) };
    }
    if (!row.execute_by || now.getTime() > new Date(row.execute_by).getTime()) {
      await tx`UPDATE harness_shared.sensitive_action_requests SET status = 'expired' WHERE request_id = ${input.requestId}`;
      return { error: new SensitiveActionError('expired', `request ${input.requestId}'s execution window closed at ${iso(row.execute_by)}`) };
    }
    if (input.expectedPayloadHash !== undefined && input.expectedPayloadHash !== row.payload_hash) {
      return { error: new SensitiveActionError('payload-mismatch', `request ${input.requestId} was approved for different content`) };
    }
    const mayExecute =
      input.executor === row.prepared_by || (await authorize(input.executor, row.authority_layer_id, 'prepare', { now, sql: tx }));
    if (!mayExecute) {
      return { error: new SensitiveActionError('forbidden', `${input.executor} may not execute request ${input.requestId}`) };
    }
    const request = requestOf(row, await approvalsOf(tx, input.requestId));
    let result: T;
    try {
      result = (await txRaw.savepoint((sp) => run(sp as unknown as Sql, request))) as T;
    } catch (err) {
      if (err instanceof SensitiveActionError && err.code === 'stale') {
        await tx`
          UPDATE harness_shared.sensitive_action_requests
             SET status = 'cancelled', result = ${JSON.stringify({ cancelled: 'stale', detail: err.message })}::text::jsonb
           WHERE request_id = ${input.requestId}
        `;
        return { error: err };
      }
      throw err;
    }
    await tx`
      UPDATE harness_shared.sensitive_action_requests
         SET status = 'executed', executed_at = ${now}, executed_by = ${input.executor},
             result = ${JSON.stringify(result ?? null)}::text::jsonb
       WHERE request_id = ${input.requestId}
    `;
    return { error: null, result };
  });
  if (outcome.error) throw outcome.error;
  return { request: (await getSensitiveAction(input.requestId, db)) as SensitiveActionRequest, result: outcome.result as T };
}

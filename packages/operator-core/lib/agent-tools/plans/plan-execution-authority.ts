import { isDeepStrictEqual } from 'node:util';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import type { AgentIdentity } from '../coordination/identity';
import { recordPlanRevisionInTransaction, type PlanRevisionSql } from './revisions';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './plan-lock-key';
import { planExecutionMeaning } from './plan-execution-meaning';
import { checkPlanExecutionReadiness, type ExecutionPlanBinding } from './plan-execution-guard';
import { readPlanLineNodes } from './plan-line-graph';
import { renderPlanLines } from './plan-line-render';

export interface ExecutionStartScope { workspaceId: string; harnessSlug: string; planSlug: string }
export type ExecutionPlanRow = Record<string, unknown> & { content: string; content_hash: string };
const progressFields = ['execution_start_revision_seq', 'rendered_content', 'content', 'content_hash', 'version', 'updated_at',
  'updated', 'status', 'op_status', 'op_updated_at', 'op_started_at', 'items', 'decisions', 'title',
  'now_state', 'now_next', 'now_note', 'now_note_version', 'now_note_updated_at', 'fed_ts', 'fed_hlc', 'origin'];

/** Structured execution inputs are part of the immutable start snapshot. */
export function executionPlanInputs(row: ExecutionPlanRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !progressFields.includes(key)));
}

export async function readExecutionPlanRow(scope: ExecutionStartScope): Promise<ExecutionPlanRow | null> {
  const { sql } = getOrgPg();
  return readExecutionSnapshot(sql, scope);
}

async function readExecutionSnapshot(sql: PlanRevisionSql, scope: ExecutionStartScope,
  lock = false): Promise<ExecutionPlanRow | null> {
  const rows = await sql<{ row: ExecutionPlanRow }[]>`
    SELECT to_jsonb(p) - ARRAY(SELECT attname::text FROM pg_attribute
      WHERE attrelid='harness_shared.harness_plans'::regclass AND attgenerated<>'' AND NOT attisdropped) AS row
    FROM harness_shared.harness_plans p
     WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
     ${lock ? sql`FOR UPDATE` : sql``}`;
  const row = rows[0]?.row;
  if (!row) return null;
  const nodes = await readPlanLineNodes(sql as never, { ...scope, slug: scope.planSlug });
  return { ...row, rendered_content: renderPlanLines(row.content, nodes) };
}

/** Preserve only equivalent local edits, fenced to the exact old and new body hashes. */
export async function preservePlanExecutionProgress(tx: PlanRevisionSql, scope: ExecutionStartScope,
  before: string, after: string, beforeHash: string, afterHash: string): Promise<void> {
  if (planExecutionMeaning(before) !== planExecutionMeaning(after)) return;
  await tx`SELECT set_config('papercusp.execution_progress',
    ${JSON.stringify([scope.workspaceId, scope.harnessSlug, scope.planSlug, beforeHash, afterHash])}, true)`;
}

/** Canonical start calls this after its final promotion, admission and binding legs. */
export async function recordPlanExecutionStart(scope: ExecutionStartScope, identity: AgentIdentity,
  expected: ExecutionPlanRow): Promise<{ seq: number; contentHash: string }> {
  return withWorkspace(scope.workspaceId, async tx => {
    await acquirePlanAdvisoryLock(tx, planAdvisoryLockKey(scope.workspaceId, scope.harnessSlug, scope.planSlug));
    const row = await readExecutionSnapshot(tx, scope, true);
    if (!row || !isDeepStrictEqual(row, expected)) throw new Error('plan_changed_before_start_proof');
    const blockers = await checkPlanExecutionReadiness({ planSlug: scope.planSlug, harnessSlug: scope.harnessSlug }, scope.workspaceId);
    if (blockers.length) throw new Error(`plan_start_proof_refused:${blockers.join(',')}`);
    const revision = await recordPlanRevisionInTransaction(tx, {
      ...scope, identity, contentHash: row.content_hash,
      content: JSON.stringify({ schema: 'plan-execution-start-v1', scope, body: row.rendered_content, inputs: executionPlanInputs(row) }),
      rationale: 'plans:start completed canonical promotion, admission and claim binding',
    });
    await tx`SELECT set_config('papercusp.execution_start',
      ${JSON.stringify([scope.workspaceId, scope.harnessSlug, scope.planSlug, row.content_hash, revision.seq])}, true)`;
    const updated = await tx<{ seq: number }[]>`
      UPDATE harness_shared.harness_plans SET execution_start_revision_seq=${revision.seq}
       WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
         AND content_hash=${row.content_hash}
       RETURNING execution_start_revision_seq AS seq`;
    if (updated[0]?.seq == null || Number(updated[0].seq) !== revision.seq)
      throw new Error('plan_start_proof_not_recorded');
    return revision;
  });
}

/** Read the exact same-scope reference; caller properties and rationale grant nothing. */
export async function readPlanExecutionStart(binding: ExecutionPlanBinding, workspaceId: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ row: ExecutionPlanRow; snapshot: string | null }[]>`
    SELECT to_jsonb(p) - ARRAY(SELECT attname::text FROM pg_attribute
      WHERE attrelid='harness_shared.harness_plans'::regclass AND attgenerated<>'' AND NOT attisdropped) AS row,
      r.content_snapshot AS snapshot
      FROM harness_shared.harness_plans p
      LEFT JOIN harness_shared.plan_revisions r ON r.workspace_id=p.workspace_id
        AND r.harness_slug=p.harness_slug AND r.plan_slug=p.plan_slug AND r.seq=p.execution_start_revision_seq
     WHERE p.workspace_id=${workspaceId} AND p.plan_slug=${binding.planSlug}
       AND (${binding.harnessSlug}::text IS NULL OR p.harness_slug=${binding.harnessSlug})`;
  if (rows.length !== 1) return [rows.length ? 'plan_scope_ambiguous' : 'bound_plan_missing'];
  const { row, snapshot } = rows[0]!;
  if (!['ready', 'active', 'awaiting-acceptance'].includes(String(row.status))) return [`plan_status:${row.status ?? 'unknown'}`];
  if (row.execution_start_revision_seq == null) return ['plan_not_started'];
  if (!snapshot) return ['plan_start_revision_missing'];
  try {
    const receipt = JSON.parse(snapshot);
    const scope = { workspaceId, harnessSlug: row.harness_slug, planSlug: binding.planSlug };
    if (receipt.schema !== 'plan-execution-start-v1' || !isDeepStrictEqual(receipt.scope, scope)
      || typeof receipt.body !== 'string') return ['plan_start_revision_invalid'];
    const nodes = await readPlanLineNodes(sql, { workspaceId, harnessSlug: String(row.harness_slug), slug: binding.planSlug });
    if (planExecutionMeaning(receipt.body) !== planExecutionMeaning(renderPlanLines(row.content, nodes))
      || !isDeepStrictEqual(receipt.inputs, executionPlanInputs(row))) return ['plan_start_revision_stale'];
    return [];
  } catch { return ['plan_start_revision_invalid']; }
}

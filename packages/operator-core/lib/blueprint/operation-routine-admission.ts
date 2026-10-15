/** Schedule governance extends the existing operation admission transaction.
 * Locking the routine row covers different workflow keys, while receipt replay
 * bypasses this guard. No outer transaction holds a connection during admission.
 * Cost is a post-run governance threshold, not a preemptive provider spend cap. */
import type { Sql, TransactionSql } from 'postgres';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

type Reason = 'inactive' | 'overlap' | 'unsupported-concurrency' | 'cost-unknown' | 'cost-exceeded';
export class RoutineOperationAdmissionRefusal extends Error {
  override readonly name = 'RoutineOperationAdmissionRefusal';
  constructor(readonly reason: Reason, readonly costCents: number | null = null) {
    super(`blueprint_operation_routine_${reason}`);
  }
}

export async function assertRoutineOperationAdmission(
  tx: TransactionSql,
  input: { workspaceId: string; routineId: string; callerId: string; requestKey: string },
): Promise<void> {
  if (input.callerId !== `routine:${input.routineId}`) throw new Error('routine operation caller mismatch');
  const [routine] = await tx<Array<{
    active: boolean; concurrency: string; trigger_config: Record<string, unknown>;
  }>>`
    SELECT active, concurrency, trigger_config FROM harness_shared.routines
     WHERE workspace_id = ${input.workspaceId} AND id = ${input.routineId}
       AND target_role = 'system:blueprint-operation'
     FOR UPDATE
  `;
  if (!routine?.active) throw new RoutineOperationAdmissionRefusal('inactive');
  // The routine engine's queue/cancel-prev policies govern its short admission
  // workflow, not the accepted worker. Refuse unsupported worker policies rather
  // than silently interpreting them as skip.
  const items = await tx<Array<{ feature_id: string; status: string; harness_slug: string }>>`
    SELECT feature_id, status, harness_slug FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND payload->'blueprintOperation'->>'callerId' = ${input.callerId}
       AND payload->'blueprintOperation'->>'requestKey' IS DISTINCT FROM ${input.requestKey}
     ORDER BY created_ts DESC LIMIT 1001
  `;
  if (items.length > 1000) throw new RoutineOperationAdmissionRefusal('cost-unknown');
  if (items.some(item => !ANY_FAMILY_TERMINAL_STATES.includes(item.status))) {
    throw new RoutineOperationAdmissionRefusal(routine.concurrency === 'skip' ? 'overlap' : 'unsupported-concurrency');
  }
  // Plan reservations are durable before their instance exists. Treat an
  // incomplete receipt, missing run or unsettled child as still outstanding.
  const plans = await tx<Array<{ target_ref: string | null; status: string | null; unsettled_children: boolean }>>`
    SELECT i.target_ref, p.status, EXISTS (
      SELECT 1 FROM harness_shared.work_items w WHERE w.workspace_id = i.workspace_id
       AND w.payload->'plan_run'->>'runId' = p.id::text
       AND w.payload->'plan_run'->>'instancePlanSlug' = i.target_ref
       AND NOT (w.status = ANY(${tx.array([...ANY_FAMILY_TERMINAL_STATES])}::text[]))
    ) AS unsettled_children FROM harness_shared.blueprint_operation_invocations i
      LEFT JOIN harness_shared.plan_runs p ON p.workspace_id = i.workspace_id
       AND p.harness_slug = COALESCE(i.target_harness_slug, i.harness_slug)
       AND p.instance_plan_slug = i.target_ref
     WHERE i.workspace_id = ${input.workspaceId} AND i.caller_id = ${input.callerId}
       AND i.request_key <> ${input.requestKey} AND i.target_kind = 'plan'
     ORDER BY i.id DESC LIMIT 1001
  `;
  if (plans.length > 1000 || plans.some(p => !p.target_ref || p.unsettled_children || !['done', 'failed'].includes(p.status ?? ''))) {
    throw new RoutineOperationAdmissionRefusal(routine.concurrency === 'skip' ? 'overlap' : 'unsupported-concurrency');
  }
  const cap = Number(routine.trigger_config.costCapCents);
  if (routine.trigger_config.costCapCents == null) return;
  if (!Number.isSafeInteger(cap) || cap <= 0 || plans.length > 0) {
    // Native direct-worker accounting is proven here. A plan target must use
    // its existing run-cost contract; do not claim it was measured by this join.
    throw new RoutineOperationAdmissionRefusal('cost-unknown');
  }
  for (const item of items) {
    const [cost] = await tx<Array<{ samples: number; attested: number; unmatched: number; unknown: number; cost_usd: number | null }>>`
      WITH sessions AS (
        SELECT DISTINCT s.session_id FROM harness_shared.adv_sessions s
          JOIN harness_shared.work_items w ON w.workspace_id = s.workspace_id
           AND w.feature_id = s.feature AND w.harness_slug = ${item.harness_slug}
         WHERE s.workspace_id = ${input.workspaceId} AND s.feature = ${item.feature_id}
           AND s.launch_spec->'acceptedOperation'->'pin' = w.payload->'blueprintOperation'
      ), attestations AS (
        SELECT DISTINCT e.body->>'nativeSessionId' AS session_id, e.body->>'providerResponseId' AS response_id
          FROM harness_shared.coord_event_log e JOIN harness_shared.blueprint_operation_invocations i
            ON i.workspace_id = e.workspace_id AND e.writer_key = 'receipt:' || i.id::text
         WHERE i.workspace_id = ${input.workspaceId} AND i.target_kind = 'work-item'
           AND i.target_ref = ${item.feature_id} AND i.caller_id = ${input.callerId}
           AND e.surface = 'blueprint-operation' AND e.body->>'kind' = 'model-attestation'
           AND e.body->>'workItemId' = ${item.feature_id}
           AND e.body->>'source' = 'gateway'
      )
      SELECT count(u.id)::int AS samples,
             (SELECT count(*)::int FROM attestations) AS attested,
             (SELECT count(*)::int FROM attestations a WHERE a.session_id IS NULL OR a.response_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = a.session_id)) AS unmatched,
             count(*) FILTER (WHERE u.id IS NULL OR u.cost_usd IS NULL OR u.cost_usd < 0
               OR u.cost_source NOT IN ('estimated', 'provider') OR u.cost_source IS NULL
               OR (u.cost_source = 'estimated' AND u.price_table_version IS DISTINCT FROM ${PRICE_TABLE_VERSION})
               OR u.usage_provenance->>'grain' IS DISTINCT FROM 'request'
               OR u.usage_provenance->>'modelSource' IS DISTINCT FROM 'transcript'
               OR u.usage_provenance->>'costBound' = 'lower')::int AS unknown,
             sum(u.cost_usd)::float8 AS cost_usd
        FROM sessions s LEFT JOIN harness_shared.agent_usage_samples u
          ON u.workspace_id = ${input.workspaceId} AND u.session_id = s.session_id
         AND u.source = 'interactive'
    `;
    if (!cost?.samples || cost.samples !== cost.attested || cost.unmatched || cost.unknown || cost.cost_usd === null || !Number.isFinite(cost.cost_usd)) {
      throw new RoutineOperationAdmissionRefusal('cost-unknown');
    }
    // Compare before rounding: $2.004 must not sneak under a 200-cent threshold.
    if (cost.cost_usd * 100 > cap) {
      throw new RoutineOperationAdmissionRefusal('cost-exceeded', Math.ceil(cost.cost_usd * 100));
    }
  }
}

/** A refusal rolls back admission. Persist a cost/unsupported-policy pause in a
 * separate transaction, using the existing routine + plan schedule controls. */
export async function pauseRefusedRoutineOperation(
  sql: Sql, workspaceId: string, routineId: string, refusal: RoutineOperationAdmissionRefusal,
): Promise<void> {
  await sql.begin(async tx => {
    const [routine] = await tx<Array<{ payload_template: Record<string, unknown> | null }>>`
      UPDATE harness_shared.routines SET active = false, next_fire_at = NULL,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pause',
          jsonb_build_object('reason', ${refusal.message}::text,
            'pausedAtMs', (extract(epoch FROM now()) * 1000)::bigint)), updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${routineId}
         AND target_role = 'system:blueprint-operation'
       RETURNING payload_template
    `;
    const payload = routine?.payload_template;
    if (typeof payload?.harnessSlug === 'string' && typeof payload.templateSlug === 'string') {
      await tx`UPDATE harness_shared.harness_plans SET schedule_active = false, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${payload.harnessSlug}
          AND plan_slug = ${payload.templateSlug}`;
    }
  });
}

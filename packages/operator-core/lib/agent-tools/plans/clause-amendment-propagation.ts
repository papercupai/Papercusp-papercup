/** R-10: amendment evidence and holder delivery share the clause revision transaction. */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import type { SpecClauseSql } from './spec-clauses-store';

export interface ClauseAmendment {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  specId: string;
  planItemId: string;
  priorPlanItemId?: string;
  oldRevision: number;
  newRevision: number;
  actorId: string;
}

export async function propagateClauseAmendment(tx: SpecClauseSql, amendment: ClauseAmendment): Promise<void> {
  const a = amendment;
  const owningItems = [...new Set([a.planItemId, ...(a.priorPlanItemId ? [a.priorPlanItemId] : [])])];
  // Resolve each provenance path separately so the source-plan, payload-stamp and
  // spec-edge indexes can bound the candidates before we lock work items. Converting
  // the entire row to JSON here deTOASTs unrelated bodies and hides those indexes.
  const rows = await tx<Array<{ id: string; holder: string | null }>>`
    WITH candidates AS (
      SELECT feature_id AS id FROM harness_shared.work_items
       WHERE workspace_id = ${a.workspaceId} AND harness_slug = ${a.harnessSlug}
         AND source_plan_slug = ${a.planSlug}
         AND source_plan_item_ids && ${owningItems}::text[]
      UNION
      SELECT feature_id AS id FROM harness_shared.work_items
       WHERE workspace_id = ${a.workspaceId} AND harness_slug = ${a.harnessSlug}
         AND payload -> 'plan_item' ->> 'plan_slug' = ${a.planSlug}
         AND payload -> 'plan_item' ->> 'item_id' = ANY(${owningItems}::text[])
      UNION
      SELECT work_item_id AS id FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${a.workspaceId} AND harness_slug = ${a.harnessSlug}
         AND plan_slug = ${a.planSlug} AND spec_id = ${a.specId}
    )
    SELECT w.feature_id AS id, w.taken_by AS holder
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${a.workspaceId} AND w.harness_slug = ${a.harnessSlug}
       AND COALESCE(w.status, '') NOT IN ('done','dropped','resolved','closed','passed','deprecated')
       AND w.feature_id IN (SELECT id FROM candidates)
     -- Keep a stable row order and preserve KEY SHARE held by sibling proof-edge FK
     -- checks. FOR UPDATE would make both transactions upgrade against the other's
     -- KEY SHARE and deadlock even on one row. We only change payload, so NO KEY UPDATE
     -- still serializes amendments without conflicting with those FK checks.
     ORDER BY w.feature_id
     FOR NO KEY UPDATE OF w`;
  if (!rows.length) return;
  const key = createHash('sha256').update(JSON.stringify([a.planSlug, a.specId])).digest('hex');
  const holders = new Map<string, string[]>();
  for (const row of rows) {
    const recorded = await tx<Array<{ id: string }>>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(COALESCE(payload,'{}'::jsonb), ARRAY['_specAmendments'],
           COALESCE(payload->'_specAmendments','{}'::jsonb) ||
             jsonb_build_object(${key}::text, ${JSON.stringify(a)}::text::jsonb))
       WHERE workspace_id = ${a.workspaceId} AND harness_slug = ${a.harnessSlug} AND feature_id = ${row.id}
         AND COALESCE((payload #>> ARRAY['_specAmendments', ${key}, 'newRevision'])::int, 0) < ${a.newRevision}
       RETURNING feature_id AS id`;
    if (!recorded.length || !row.holder) continue;
    const live = await tx<Array<{ live: boolean }>>`
      SELECT heartbeat_at > now() - (${PRESENCE_STALE_MS} * interval '1 millisecond') AS live
        FROM harness_shared.coord_presence
       WHERE workspace_id = ${a.workspaceId} AND owner_id = ${row.holder}`;
    if (!live[0]?.live) continue;
    const ids = holders.get(row.holder) ?? [];
    ids.push(row.id); holders.set(row.holder, ids);
  }
  // Extend the existing idempotent coordination writer; no parallel notification table.
  const log = new PgCoordLog({
    getSql: () => tx as unknown as postgres.Sql, workspaceId: a.workspaceId, ensureSchema: async () => {},
  });
  for (const [holder, ids] of holders) {
    const msgId = `spec-amend-${createHash('sha256').update(JSON.stringify([
      a.workspaceId, a.harnessSlug, a.planSlug, a.specId, a.newRevision, holder,
    ])).digest('hex')}`;
    const text = `${a.planSlug}#${a.specId} changed revision ${a.oldRevision} → ${a.newRevision}. ` +
      `Linked in-flight work: ${ids.join(', ')}. Re-read plans:get-specs before continuing.`;
    await log.appendLineIfAbsent('messages', a.actorId, {
      msg_id: msgId, ts: new Date().toISOString(), kind: 'message', from: a.actorId,
      to: [holder], summary: `${a.specId}: revision ${a.oldRevision} → ${a.newRevision}`,
      body: text, expects: 'none', plan_slug: a.planSlug, harness_slug: a.harnessSlug,
      sections: [{ text }],
    }, { transactionSql: tx as unknown as postgres.TransactionSql });
  }
}

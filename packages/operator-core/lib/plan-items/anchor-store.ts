import { getOrgPg } from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';
import type { PlanItemAnchor } from './anchors';

export interface PlanAnchorScope { workspaceId: string; harnessSlug: string; planSlug: string }
export interface PlanAnchorWrite { itemId: string; anchors: PlanItemAnchor[] }

/** Called by withPlanLock inside the SAME transaction as the plan/item write. */
export async function writePlanItemAnchors(tx: TransactionSql, scope: PlanAnchorScope, write: PlanAnchorWrite, actor: string): Promise<void> {
  await tx`DELETE FROM harness_shared.plan_item_anchors
    WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug}
      AND plan_slug=${scope.planSlug} AND item_id=${write.itemId}`;
  const rows = JSON.stringify(write.anchors);
  await tx`INSERT INTO harness_shared.plan_item_anchors
    (workspace_id,harness_slug,plan_slug,item_id,anchor_kind,requested,symbol_id,symbol_name,path,line,
     signature,content_hash,consumers,consumers_total,tests,resolution,unknown_reason,freshness,resolved_commit,created_by,last_checked_at,last_check_ok,change_intent)
    SELECT ${scope.workspaceId},${scope.harnessSlug},${scope.planSlug},${write.itemId},
      x."anchorKind",x.requested,x."symbolId",x."symbolName",x.path,x.line,x.signature,x."contentHash",
      x.consumers,x."consumersTotal",x.tests,x.resolution,x."unknownReason",x.freshness,x."resolvedCommit",${actor},now(),x.resolution='resolved',x.change
    -- Match plan-index-rows: bind pre-serialized JSON as TEXT before casting,
    -- independent of whether this connection has the hybrid JSON serializer.
    FROM jsonb_to_recordset(${rows}::text::jsonb) AS x("anchorKind" text,requested text,"symbolId" text,"symbolName" text,path text,line int,
      signature text,"contentHash" text,consumers jsonb,"consumersTotal" int,tests jsonb,resolution text,"unknownReason" text,freshness text,"resolvedCommit" text,change jsonb)`;
}

export async function readPlanItemAnchors(scope: PlanAnchorScope): Promise<Record<string, PlanItemAnchor[]>> {
  const { sql } = getOrgPg();
  const rows = await sql<(PlanItemAnchor & { itemId: string })[]>`
    SELECT a.id::text, a.item_id AS "itemId", a.anchor_kind AS "anchorKind", a.requested,
      a.symbol_id AS "symbolId", a.symbol_name AS "symbolName", a.path, a.line, a.signature,
      a.content_hash AS "contentHash", a.consumers, a.consumers_total AS "consumersTotal", a.tests,
      a.resolution, a.unknown_reason AS "unknownReason", a.freshness, a.resolved_commit AS "resolvedCommit",
      a.stale_notice_id::text AS "staleNoticeId", a.change_intent AS change
    FROM harness_shared.plan_item_anchors a
    WHERE a.workspace_id=${scope.workspaceId} AND a.harness_slug=${scope.harnessSlug} AND a.plan_slug=${scope.planSlug}
      AND EXISTS (SELECT 1 FROM harness_shared.plan_items i WHERE i.workspace_id=a.workspace_id
        AND i.harness_slug=a.harness_slug AND i.plan_slug=a.plan_slug AND i.item_id=a.item_id)
    ORDER BY a.item_id,a.id`;
  const byItem: Record<string, PlanItemAnchor[]> = {};
  for (const { itemId, ...anchor } of rows) (byItem[itemId] ??= []).push(anchor);
  return byItem;
}

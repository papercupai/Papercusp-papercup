/** P-005: bounded, replay-safe freshness and notice persistence on the D-014 tables. */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { checkPlanItemAnchorFreshness, type AnchorFreshnessCheck, type AnchorFreshnessOptions } from './anchor-freshness';
import type { PlanItemAnchor } from './anchors';
import { runWithWorkspace } from '../workspace-als';

export const PLAN_ANCHOR_SWEEP_CAP = 50;
export const PLAN_ANCHOR_FRESHNESS_CRON = '15 */15 * * * *';
export interface PlanAnchorNotice {
  id: string;
  planSlug: string;
  audience: string[];
  anchorIds: string[];
}
export interface PlanAnchorSweepOptions extends AnchorFreshnessOptions {
  workspaceId: string;
  harnessSlug: string;
  cap?: number;
  sql?: Sql;
  holders?: (planSlug: string) => Promise<string[]>;
  notify?: (notice: PlanAnchorNotice) => Promise<string>;
}
type Candidate = PlanItemAnchor & { id: string; planSlug: string; itemId: string };

async function defaultHolders(options: PlanAnchorSweepOptions, planSlug: string): Promise<string[]> {
  const { listWorkItems } = await import('../work-items');
  const items = await runWithWorkspace(options.workspaceId, () => listWorkItems({ harness: options.harnessSlug,
    sourcePlanSlug: planSlug, notTerminal: true, includeChildren: true, limit: 1001 }));
  if (items.length > 1000) throw new Error('Plan-anchor notice audience exceeds its bounded holder census');
  return [...new Set(items.flatMap(item => item.assignee ? [item.assignee] : []))];
}

async function defaultNotify(options: PlanAnchorSweepOptions, notice: PlanAnchorNotice): Promise<string> {
  const { getMessageById, sendMessage } = await import('../agent-tools/coordination/messages');
  const msgId = `plan-anchor-notice:${options.harnessSlug}:${notice.id}`;
  // The durable notice is an outbox: a crash after send but before acknowledgement
  // must not duplicate the message when the system action replays.
  await runWithWorkspace(options.workspaceId, async () => {
    if (await getMessageById(msgId)) return;
    await sendMessage({ ownerId: 'system:plan-anchor-freshness', ownerLabel: 'Plan anchor freshness',
      source: 'static-client', workspaceId: options.workspaceId, userId: null }, {
      msgId, to: notice.audience, harnessSlug: options.harnessSlug, plan_slug: notice.planSlug,
      summary: `Code links need review in ${notice.planSlug}`,
      body: `${notice.anchorIds.length} code link(s) changed or no longer resolve. Review the plan's code links before using them.`,
    });
  });
  return msgId;
}

export async function sweepPlanItemAnchors(options: PlanAnchorSweepOptions): Promise<{
  scanned: number; checked: number; deferred: number; noticesCreated: number; noticesDelivered: number;
}> {
  const sql = options.sql ?? getOrgPg().sql;
  const requestedCap = options.cap ?? PLAN_ANCHOR_SWEEP_CAP;
  const cap = Number.isFinite(requestedCap) ? Math.max(1, Math.min(200, Math.floor(requestedCap))) : PLAN_ANCHOR_SWEEP_CAP;
  const candidates = await sql<Candidate[]>`
    SELECT a.id::text, a.plan_slug AS "planSlug", a.item_id AS "itemId",
      a.anchor_kind AS "anchorKind", a.requested, a.symbol_id AS "symbolId", a.symbol_name AS "symbolName",
      a.path, a.line, a.content_hash AS "contentHash", a.freshness
    FROM harness_shared.plan_item_anchors a
    JOIN harness_shared.plan_items i ON i.workspace_id=a.workspace_id AND i.harness_slug=a.harness_slug
      AND i.plan_slug=a.plan_slug AND i.item_id=a.item_id
    WHERE a.workspace_id=${options.workspaceId} AND a.harness_slug=${options.harnessSlug}
      AND a.anchor_kind='symbol' AND i.status NOT IN ('done','dropped')
    ORDER BY a.last_checked_at NULLS FIRST,a.id LIMIT ${cap}`;
  const checks: { anchor: Candidate; check: AnchorFreshnessCheck }[] = [];
  for (const anchor of candidates) checks.push({ anchor, check: await checkPlanItemAnchorFreshness(anchor, options) });
  let checked = 0;
  let deferred = 0;
  let noticesCreated = 0;
  const plans = [...new Set(candidates.map(anchor => anchor.planSlug))];
  for (const planSlug of plans) {
    const audience = [...new Set([`@plan:${planSlug}`, ...await (options.holders
      ? options.holders(planSlug) : defaultHolders(options, planSlug))])];
    await sql.begin(async tx => {
      // Serialize only the short persistence step, never source parsing or audience lookup.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        'plan-anchor-freshness',options.workspaceId,options.harnessSlug,planSlug])},0))`;
      const updatedIds: string[] = [];
      for (const { anchor, check } of checks.filter(entry => entry.anchor.planSlug === planSlug)) {
        if (check.status === 'skipped') continue;
        const rows = await tx<{ id: string }[]>`
          UPDATE harness_shared.plan_item_anchors a SET last_checked_at=now(),
            last_check_ok=${check.status === 'checked' ? check.freshness === 'fresh' : null},
            freshness=${check.status === 'checked' ? check.freshness : anchor.freshness},
            stale_since=CASE WHEN ${check.status === 'checked' && check.freshness !== 'fresh'}
              THEN coalesce(a.stale_since,now()) WHEN ${check.status === 'checked' && check.freshness === 'fresh'}
              THEN NULL ELSE a.stale_since END
          WHERE a.workspace_id=${options.workspaceId} AND a.harness_slug=${options.harnessSlug}
            AND a.plan_slug=${planSlug} AND a.id::text=${anchor.id}
            AND a.content_hash IS NOT DISTINCT FROM ${anchor.contentHash}
            AND a.path IS NOT DISTINCT FROM ${anchor.path}
            AND EXISTS (SELECT 1 FROM harness_shared.plan_items i WHERE i.workspace_id=a.workspace_id
              AND i.harness_slug=a.harness_slug AND i.plan_slug=a.plan_slug AND i.item_id=a.item_id
              AND i.status NOT IN ('done','dropped'))
          RETURNING a.id::text`;
        if (!rows.length) continue; // Re-anchored or closed since the source read.
        if (check.status === 'checked') { checked++; updatedIds.push(anchor.id); } else deferred++;
      }
      const unnotified = updatedIds.length ? await tx<{ id: string }[]>`
        SELECT id::text FROM harness_shared.plan_item_anchors
        WHERE workspace_id=${options.workspaceId} AND harness_slug=${options.harnessSlug} AND plan_slug=${planSlug}
          AND id::text=ANY(${updatedIds}) AND freshness IN ('stale','missing') AND stale_notice_id IS NULL
        ORDER BY id FOR UPDATE` : [];
      if (!unnotified.length) return;
      const ids = unnotified.map(row => row.id);
      const [notice] = await tx<{ id: string }[]>`
        INSERT INTO harness_shared.plan_anchor_notices(workspace_id,harness_slug,plan_slug,audience,anchor_ids)
        VALUES (${options.workspaceId},${options.harnessSlug},${planSlug},${JSON.stringify(audience)}::text::jsonb,
          ${JSON.stringify(ids)}::text::jsonb) RETURNING id::text`;
      await tx`UPDATE harness_shared.plan_item_anchors SET stale_notice_id=${notice!.id}
        WHERE workspace_id=${options.workspaceId} AND harness_slug=${options.harnessSlug}
          AND plan_slug=${planSlug} AND id::text=ANY(${ids})`;
      noticesCreated++;
    });
  }
  // Retry undelivered records even when this pass finds no newly stale anchors.
  const pending = await sql<PlanAnchorNotice[]>`
    SELECT id::text,plan_slug AS "planSlug",audience,anchor_ids AS "anchorIds"
    FROM harness_shared.plan_anchor_notices
    WHERE workspace_id=${options.workspaceId} AND harness_slug=${options.harnessSlug} AND coord_message_id IS NULL
    ORDER BY id LIMIT ${cap}`;
  let noticesDelivered = 0;
  for (const notice of pending) {
    await sql.begin(async tx => {
      const [current] = await tx<PlanAnchorNotice[]>`
        SELECT id::text,plan_slug AS "planSlug",audience,anchor_ids AS "anchorIds"
        FROM harness_shared.plan_anchor_notices WHERE workspace_id=${options.workspaceId}
          AND harness_slug=${options.harnessSlug} AND id::text=${notice.id} AND coord_message_id IS NULL FOR UPDATE`;
      if (!current) return; // Another sweep delivered it while this one waited.
      const messageId = await (options.notify ? options.notify(current) : defaultNotify(options, current));
      await tx`UPDATE harness_shared.plan_anchor_notices SET coord_message_id=${messageId}
        WHERE workspace_id=${options.workspaceId} AND harness_slug=${options.harnessSlug} AND id::text=${current.id}`;
      noticesDelivered++;
    });
  }
  return { scanned: candidates.length, checked, deferred, noticesCreated, noticesDelivered };
}

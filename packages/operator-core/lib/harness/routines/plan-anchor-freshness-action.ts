/** P-005 uses the existing routine engine; no private timer or agent loop. */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';
import { PLAN_ANCHOR_SWEEP_CAP, sweepPlanItemAnchors } from '../../plan-items/anchor-freshness-sweep';
import { loadHarnessRegistry } from '../../harness-registry';
import { peekPushSnapshot } from '../../code-intelligence/push-snapshot';

export { PLAN_ANCHOR_FRESHNESS_CRON } from '../../plan-items/anchor-freshness-sweep';
export async function runPlanAnchorFreshnessAction(ctx: SystemActionCtx, deps: {
  sql?: Sql;
  loadRegistry?: typeof loadHarnessRegistry;
  sweep?: typeof sweepPlanItemAnchors;
} = {}): Promise<SystemActionResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const registry = await (deps.loadRegistry ?? loadHarnessRegistry)(ctx.workspaceId);
  const projects = registry.projects.filter(project => project.path);
  const requested = typeof ctx.triggerConfig.cap === 'number' ? ctx.triggerConfig.cap : PLAN_ANCHOR_SWEEP_CAP;
  const cap = Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.floor(requested))) : PLAN_ANCHOR_SWEEP_CAP;
  // One workspace routine covers coding harnesses created after its seed, too.
  // Oldest checks come first; both source checks and outbox deliveries share a
  // bounded allocation across targets, rather than multiplying the cap per repo.
  const targets = projects.length ? await sql<{ harnessSlug: string }[]>`
    SELECT harness_slug AS "harnessSlug" FROM (
      SELECT a.harness_slug,a.last_checked_at AS checked_at
      FROM harness_shared.plan_item_anchors a JOIN harness_shared.plan_items i
        ON i.workspace_id=a.workspace_id AND i.harness_slug=a.harness_slug
          AND i.plan_slug=a.plan_slug AND i.item_id=a.item_id
      WHERE a.workspace_id=${ctx.workspaceId} AND a.anchor_kind='symbol'
        AND i.status NOT IN ('done','dropped')
      UNION ALL
      SELECT harness_slug,NULL::timestamptz FROM harness_shared.plan_anchor_notices
      WHERE workspace_id=${ctx.workspaceId} AND coord_message_id IS NULL
    ) pending WHERE harness_slug=ANY(${projects.map(project => project.slug)}::text[])
    GROUP BY harness_slug ORDER BY min(checked_at) NULLS FIRST,harness_slug LIMIT ${cap}` : [];
  const perHarnessCap = Math.max(1, Math.floor(cap / Math.max(1, targets.length)));
  const totals = { scanned: 0, checked: 0, deferred: 0, noticesCreated: 0, noticesDelivered: 0 };
  for (const target of targets) {
    const project = projects.find(project => project.slug === target.harnessSlug)!;
    const result = await (deps.sweep ?? sweepPlanItemAnchors)({ workspaceId: ctx.workspaceId,
      harnessSlug: target.harnessSlug, root: project.path, sql,
      snapshot: peekPushSnapshot(target.harnessSlug), cap: perHarnessCap });
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key];
  }
  return { diagnostics: { ...totals, harnesses: targets.map(target => target.harnessSlug), cap } };
}
registerSystemAction('plan-anchor-freshness', runPlanAnchorFreshnessAction);

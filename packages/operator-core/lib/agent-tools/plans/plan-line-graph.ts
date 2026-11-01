/** Plan-line storage over the existing work graph (migration 1601). */
import type { Sql } from 'postgres';
import type { PlanIndexItem } from './derive-index';
import { ISSUE_FAMILY_ROUTE_KINDS } from '../../work-nature/agent-work-predicate';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { WorkItemDependencyMutation } from '../../dbos/work-item-deps-store';

export interface PlanLineScope { workspaceId: string; harnessSlug: string; slug: string }
export interface PlanLineNode extends PlanIndexItem { featureId: string; kind: string; planSlug: string }

const endpoint = (node: PlanLineNode, harness: string) =>
  (ISSUE_FAMILY_ROUTE_KINDS as readonly string[]).includes(node.kind)
    ? { kind: 'issue' as const, ref: node.featureId }
    : { kind: 'feature' as const, ref: `${harness}#${node.featureId}` };

export async function readPlanLineNodes(tx: Sql, scope: Omit<PlanLineScope, 'slug'> & { slug: string | string[] }): Promise<PlanLineNode[]> {
  const { workspaceId, harnessSlug, slug } = scope;
  const rows = await tx<{
    feature_id: string; item_kind: string; plan_slug: string; plan_line_id: string; status: string;
    plan_line_text: string; plan_importance: string | null; plan_phase: string | null;
    plan_decision_refs: string[]; plan_deliverable: string | null;
    plan_owner_gate_marker: string | null; blocked_by: string[];
  }[]>`
    SELECT n.feature_id, n.item_kind, n.plan_slug, n.plan_line_id, n.status, n.plan_line_text,
           n.plan_importance, n.plan_phase, n.plan_decision_refs, n.plan_deliverable,
           n.plan_owner_gate_marker,
           ARRAY(SELECT b.plan_line_id FROM harness_shared.work_item_deps d
             JOIN harness_shared.work_items b ON b.workspace_id = n.workspace_id
              AND b.harness_slug = n.harness_slug AND b.plan_slug = n.plan_slug
              AND b.plan_line_id IS NOT NULL
              AND d.blocker_kind = CASE WHEN b.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN 'issue' ELSE 'feature' END
              AND d.blocker_ref = CASE WHEN b.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN b.feature_id ELSE b.harness_slug || '#' || b.feature_id END
             WHERE d.workspace_id = ${DEFAULT_COORD_WORKSPACE} AND d.dep_type = 'blocks'
               AND d.blocked_kind = CASE WHEN n.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN 'issue' ELSE 'feature' END
               AND d.blocked_ref = CASE WHEN n.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN n.feature_id ELSE n.harness_slug || '#' || n.feature_id END
             ORDER BY b.plan_seq, b.plan_line_id) AS blocked_by
      FROM harness_shared.work_items n
     WHERE n.workspace_id = ${workspaceId} AND n.harness_slug = ${harnessSlug}
       AND n.plan_slug = ANY(${Array.isArray(slug) ? slug : [slug]}::text[]) AND n.plan_line_id IS NOT NULL
     ORDER BY n.plan_seq, n.plan_line_id`;
  return rows.map((r) => ({
    id: r.plan_line_id, featureId: r.feature_id, kind: r.item_kind, planSlug: r.plan_slug,
    text: r.plan_line_text, importance: r.plan_importance ?? 'normal',
    phase: r.plan_phase, decisionRefs: r.plan_decision_refs,
    deliverable: r.plan_deliverable, ownerGateMarker: r.plan_owner_gate_marker,
    status: ['done', 'resolved', 'closed'].includes(r.status) ? 'done'
      : ['dropped', 'superseded'].includes(r.status) ? 'dropped'
        : r.status === 'wip' ? 'wip' : r.status === 'needs-human' ? 'needs-human' : 'todo',
    blockedBy: r.blocked_by,
  }));
}

/** Under the plan lock; admit the returned edge changes in the SAME transaction. */
export async function writePlanLineNodes(
  tx: Sql, scope: PlanLineScope, before: readonly PlanLineNode[], items: readonly PlanIndexItem[],
): Promise<WorkItemDependencyMutation[]> {
  const { workspaceId, harnessSlug, slug } = scope;
  const prior = new Map(before.map((n) => [n.id, n]));
  const next = new Map<string, PlanLineNode>();
  const now = Date.now();
  for (const [seq, item] of items.entries()) {
    const old = prior.get(item.id);
    const status = item.status === 'todo' || item.status === 'blocked' ? 'open' : item.status;
    if (old) {
      const changeStatus = item.status !== old.status && !(item.status === 'blocked' && old.status === 'todo');
      const changeText = item.text !== old.text;
      await tx`
        UPDATE harness_shared.work_items SET plan_seq = ${seq}, plan_phase = ${item.phase},
          plan_importance = ${item.importance}, plan_decision_refs = ${item.decisionRefs}::text[],
          plan_deliverable = ${item.deliverable ?? null}, plan_owner_gate_marker = ${item.ownerGateMarker ?? null},
          plan_line_text = ${item.text},
          title = CASE WHEN ${changeText} THEN ${item.text.slice(0, 300)} ELSE title END,
          summary = CASE WHEN ${changeText} THEN ${item.text} ELSE summary END,
          status = CASE WHEN ${changeStatus} THEN ${status} ELSE status END,
          closed_ts = CASE WHEN ${changeStatus} THEN CASE WHEN ${status} IN ('done', 'dropped') THEN ${now}::bigint ELSE NULL END ELSE closed_ts END,
          updated_ts = ${now}, origin = 'local'
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${old.featureId}`;
      next.set(item.id, { ...item, featureId: old.featureId, kind: old.kind, planSlug: slug });
    } else {
      const park = status === 'open' ? {
        _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes',
        claim_hold_at: new Date(now).toISOString(),
        claim_hold_reason: 'Plan-line transition park until one-work-graph-structured-holds-2026-10-26 P-008 (D-011).',
      } : {};
      const [row] = await tx<{ feature_id: string }[]>`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, nature, audience,
           origin, source_plan_slug, source_plan_item_ids, feature_order, payload, created_ts, updated_ts, ts,
           plan_slug, plan_line_id, plan_seq, plan_phase, plan_importance, plan_decision_refs,
           plan_deliverable, plan_owner_gate_marker, plan_line_text)
        VALUES (${workspaceId}, ${harnessSlug}, harness_shared.next_work_item_id(), ${item.text.slice(0, 300)},
          ${item.text}, ${status}, 'feature', 'work', 'agent', 'local', ${slug}, ${[item.id]}::text[],
          ${seq}, ${JSON.stringify(park)}::text::jsonb, ${now}, ${now}, ${now},
          ${slug}, ${item.id}, ${seq}, ${item.phase}, ${item.importance}, ${item.decisionRefs}::text[],
          ${item.deliverable ?? null}, ${item.ownerGateMarker ?? null}, ${item.text}) RETURNING feature_id`;
      next.set(item.id, { ...item, featureId: row.feature_id, kind: 'feature', planSlug: slug });
    }
  }
  const mutations: WorkItemDependencyMutation[] = [];
  for (const old of before) {
    const desired = next.get(old.id);
    for (const id of old.blockedBy) if (!desired?.blockedBy.includes(id)) {
      const blocker = prior.get(id);
      if (blocker) mutations.push({ op: 'remove', blocked: endpoint(old, harnessSlug), blocker: endpoint(blocker, harnessSlug) });
    }
    if (!desired) {
      // Unlink the line without deleting work, descendants, history, or external edges.
      await tx`UPDATE harness_shared.work_items SET plan_slug = NULL, plan_line_id = NULL,
        plan_seq = NULL, updated_ts = ${now}, origin = 'local'
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${old.featureId}`;
    }
  }
  for (const node of next.values()) for (const id of node.blockedBy) {
    const blocker = next.get(id);
    if (!blocker) throw new Error(`plan_line_blocker_missing: ${slug}#${node.id} requires ${id}`);
    if (!prior.get(node.id)?.blockedBy.includes(id)) mutations.push({ op: 'add',
      blocked: endpoint(node, harnessSlug), blocker: endpoint(blocker, harnessSlug),
      satisfaction: 'settled', createdBy: `plan-dependency:${harnessSlug}/${slug}`,
    });
  }
  return mutations;
}

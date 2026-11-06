/** Canonical focus acceptance, committed in the task mutation transaction. */
import type { Sql, TransactionSql } from 'postgres';
import type { MissionBinding, MissionParent } from './mission-continuity';
import { acceptMissionActivityInTransaction, applyMissionEventInTransaction, parseSessionMission,
  type MissionSessionIdentity } from './session-brief-mission';
import type { SessionTask, SessionTaskResult, SessionTaskWorkItemLink } from './session-tasks';

interface ItemAuthority {
  feature_id: string; harness_slug: string; source_plan_slug: string | null;
  taken_by: string | null; taken_at: Date | string | null; status: string;
  directive_ref: string | null; goal_id: string | null; directive_source: string | null;
  captured_by_hook: boolean | null; disposition_status: string | null;
}
const itemRef = (item: Pick<ItemAuthority, 'harness_slug' | 'feature_id'>) =>
  `work-item:${encodeURIComponent(item.harness_slug)}:${encodeURIComponent(item.feature_id)}`;
const taskRef = (sessionId: string, taskId: string) => `session-task:${sessionId}:${taskId}`;
const terminal = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled', 'dropped', 'declined']);
const stamp = (value: Date | string | null) => value instanceof Date ? value.toISOString() : value;

async function readItem(tx: Sql, workspaceId: string, link: SessionTaskWorkItemLink): Promise<ItemAuthority | null> {
  const rows = await tx<ItemAuthority[]>`
    SELECT w.feature_id,w.harness_slug,w.source_plan_slug,w.taken_by,w.taken_at,
      w.status,w.directive_ref,w.goal_id,d.source_turn_ref AS directive_source,
      d.captured_by_hook,d.disposition_status
      FROM harness_shared.work_items w
      LEFT JOIN harness_shared.owner_directives d ON d.workspace_id=w.workspace_id AND d.id=w.directive_ref
     WHERE w.workspace_id=${workspaceId} AND w.feature_id=${link.workItemId}
       AND (${link.workItemHarness}::text IS NULL OR w.harness_slug=${link.workItemHarness})
     LIMIT 2`;
  return rows.length === 1 ? rows[0]! : null;
}

/** Reads current parent disposition, never the latest child's completion. */
export async function readMissionTaskParent(tx: Sql, identity: MissionSessionIdentity,
  binding: MissionBinding): Promise<MissionParent | null> {
  let anchor: { kind?: string; harness?: string; id?: string; takenAt?: string };
  try { anchor = JSON.parse(binding.authorityRef); } catch { return null; }
  if (anchor.kind !== 'work-item-claim' || !anchor.harness || !anchor.id || !anchor.takenAt) return null;
  const item = await readItem(tx, identity.workspaceId, {
    workItemId: anchor.id, workItemHarness: anchor.harness, relation: 'for',
  });
  if (!item) return null;
  const parent: MissionParent = { ...binding, disposition: 'ready', blockerRef: null, nextActionRef: binding.assignmentRef };
  if ((item.taken_by && item.taken_by !== identity.ownerId) ||
    (item.taken_at && stamp(item.taken_at) !== anchor.takenAt)) {
    return { ...parent, accountableOwner: item.taken_by ?? binding.accountableOwner,
      custodyGeneration: binding.custodyGeneration + 1, disposition: 'transferred' };
  }
  if (item.directive_ref && (!item.captured_by_hook || !item.directive_source)) return null;
  if (item.disposition_status === 'declined') return { ...parent, disposition: 'cancelled', nextActionRef: null };
  if (binding.assignmentRef === itemRef(item)) {
    if (terminal.has(item.status)) return { ...parent,
      disposition: ['cancelled','canceled','dropped','declined'].includes(item.status) ? 'cancelled' : 'complete', nextActionRef: null };
    return item.status === 'blocked' ? { ...parent, disposition: 'blocked', blockerRef: itemRef(item) } : parent;
  }
  if (!item.source_plan_slug) return null;
  const root = `plan:${encodeURIComponent(item.harness_slug)}:${encodeURIComponent(item.source_plan_slug)}`;
  if (binding.assignmentRef !== root) return null;
  const plans = await tx<{ status: string; op_status: string | null; execution_start_revision_seq: number | null }[]>`
    SELECT status,op_status,execution_start_revision_seq FROM harness_shared.harness_plans
     WHERE workspace_id=${identity.workspaceId} AND harness_slug=${item.harness_slug} AND plan_slug=${item.source_plan_slug}`;
  const plan = plans[0];
  if (!plan) return null;
  if (terminal.has(plan.status)) return { ...parent,
    disposition: ['cancelled','canceled','dropped','declined'].includes(plan.status) ? 'cancelled' : 'complete', nextActionRef: null };
  if (plan.execution_start_revision_seq == null) return { ...parent, disposition: 'unknown' };
  if (!['ready','active','awaiting-acceptance'].includes(plan.status)) return { ...parent, disposition: 'unknown' };
  return { ...parent, assignmentRevision: Number(plan.execution_start_revision_seq),
    disposition: plan.op_status === 'paused' ? 'blocked' : 'ready', blockerRef: plan.op_status === 'paused' ? root : null };
}

async function deriveBinding(tx: Sql, identity: MissionSessionIdentity, item: ItemAuthority): Promise<MissionBinding | null> {
  if (item.taken_by !== identity.ownerId || !item.taken_at || terminal.has(item.status)) return null;
  if (item.directive_ref && (!item.captured_by_hook || !item.directive_source || item.disposition_status === 'declined')) return null;
  let assignmentRef = itemRef(item);
  let assignmentRevision = 1;
  if (item.source_plan_slug) {
    const plans = await tx<{ execution_start_revision_seq: number | null; snapshot: string | null }[]>`
      SELECT p.execution_start_revision_seq,r.content_snapshot AS snapshot
        FROM harness_shared.harness_plans p
        LEFT JOIN harness_shared.plan_revisions r ON r.workspace_id=p.workspace_id AND r.harness_slug=p.harness_slug
          AND r.plan_slug=p.plan_slug AND r.seq=p.execution_start_revision_seq
       WHERE p.workspace_id=${identity.workspaceId} AND p.harness_slug=${item.harness_slug} AND p.plan_slug=${item.source_plan_slug}`;
    if (!plans[0]?.execution_start_revision_seq || !plans[0].snapshot) return null;
    let receipt;
    try { receipt = JSON.parse(plans[0].snapshot); } catch { return null; }
    // This is a meaning receipt, not a substitute owner directive.
    if (receipt.schema !== 'plan-execution-start-v1' || receipt.scope?.workspaceId !== identity.workspaceId ||
      receipt.scope?.harnessSlug !== item.harness_slug || receipt.scope?.planSlug !== item.source_plan_slug) return null;
    assignmentRef = `plan:${encodeURIComponent(item.harness_slug)}:${encodeURIComponent(item.source_plan_slug)}`;
    assignmentRevision = Number(plans[0].execution_start_revision_seq);
  }
  return { assignmentRef, ownerDirectiveRef: item.directive_ref ? `order:${item.directive_ref}` : null,
    objectiveRefs: [assignmentRef, ...(item.goal_id ? [`goal:${item.goal_id}`] : [])],
    completionCriteriaRefs: [item.source_plan_slug ? `${assignmentRef}#Requirements` : assignmentRef],
    accountableOwner: identity.ownerId, custodyGeneration: 1, assignmentRevision,
    authorityRef: JSON.stringify({ kind: 'work-item-claim', harness: item.harness_slug, id: item.feature_id, takenAt: stamp(item.taken_at) }) };
}

/** A claim can bootstrap custody; it cannot prove displacement or replace an
 * existing root. Unknown accepted selections preserve the root and stay unknown. */
export async function commitMissionTaskTransition(sql: Sql | TransactionSql, identity: MissionSessionIdentity,
  sessionId: string, before: readonly SessionTask[], result: SessionTaskResult, nowMs = Date.now()): Promise<void> {
  const tx = sql as Sql;
  const previous = before.find(task => task.status === 'in_progress');
  const selected = result.tasks.find(task => task.status === 'in_progress');
  const changedFocus = previous?.id !== selected?.id;
  const ended = before.filter(task => !['completed','dropped'].includes(task.status) &&
    result.tasks.some(next => next.id === task.id && ['completed','dropped'].includes(next.status)));
  if (!changedFocus && !ended.length) return;
  await tx`INSERT INTO harness_shared.session_briefs(owner_id,workspace_id)
    VALUES (${identity.ownerId},${identity.workspaceId}) ON CONFLICT(owner_id) DO NOTHING`;
  const rows = await tx<{ mission_continuity: unknown }[]>`SELECT mission_continuity FROM harness_shared.session_briefs
    WHERE owner_id=${identity.ownerId} AND workspace_id=${identity.workspaceId} FOR UPDATE`;
  if (!rows[0]) throw new Error('mission-session-scope-conflict');
  let envelope = parseSessionMission(rows[0].mission_continuity);
  const readParent = (port: Sql, binding: MissionBinding) => readMissionTaskParent(port, identity, binding);
  const selectedLink = selected?.links.find(link => link.relation === 'for');
  const item = selectedLink ? await readItem(tx, identity.workspaceId, selectedLink) : null;
  if (!envelope?.state.binding && item) {
    const binding = await deriveBinding(tx, identity, item);
    if (binding) envelope = (await applyMissionEventInTransaction(tx, identity, {
      id: `mission-bind:${binding.authorityRef}`, kind: 'assignment-accepted', binding,
      currentWorkRef: previous ? taskRef(sessionId, previous.id) : null,
    }, readParent, nowMs)).envelope;
  }
  if (!envelope?.state.binding) {
    await applyMissionEventInTransaction(tx, identity, {id:`unbound-task:${result.changedTaskId ?? result.op}`,kind:'recovered'}, readParent,nowMs);
    return;
  }
  for (const task of ended) {
    envelope = (await applyMissionEventInTransaction(tx, identity, {
      id: `task-ended:${sessionId}:${task.id}:${envelope.state.selectionRevision}`, kind:'child-ended',
      childRef:taskRef(sessionId,task.id),terminal:true,
    },readParent,nowMs)).envelope;
  }
  if (!changedFocus || !selected) return;
  const binding = envelope.state.binding!;
  const sameRoot = item && (binding.assignmentRef === itemRef(item) ||
    binding.assignmentRef === `plan:${encodeURIComponent(item.harness_slug)}:${encodeURIComponent(item.source_plan_slug ?? '')}`);
  await acceptMissionActivityInTransaction(tx, identity, {
    selectedRef:taskRef(sessionId,selected.id),accepted:true,changesFocus:true,
    displacedContinuationRef:envelope.state.currentWorkRef, relationship:sameRoot?'same-assignment':'unknown',
  }, readParent,nowMs);
}

/**
 * P-007 Phase C (D-028): the Postgres-backed deps for completion-verification.ts. Kept apart
 * so the policy module stays pure and unit-testable, and so work_items:complete can load it
 * lazily (its unit tests mock '../../work-items').
 */
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getOrgPg } from '@papercusp/db-org';
import { readWorkItemDependenciesForRefs } from '../../dbos/work-item-deps-store';
import { createIssue, issueRef, linkIssue } from '../../issues-engineer';
import { claimWorkItem, commentWorkItem, setWorkItemState, TERMINAL_WORK_ITEM_STATES } from '../../work-items';
import {
  acceptCompletionOnSettlement,
  applyCompletionVerdict,
  COMPLETION_SETTLEMENT_ACTOR,
  COMPLETION_VERIFICATION_ACTOR,
  spawnCompletionVerification,
  type CompletionSubject,
  type LiveDependent,
} from './completion-verification';

const terminalStates = () => [...TERMINAL_WORK_ITEM_STATES].map((s) => s.toLowerCase());

/**
 * The live dependents of a just-closed subject. Edges come from the canonical edge reader
 * (readWorkItemDependenciesForRefs), not a private blocking predicate, so this enumeration
 * cannot drift from the dependency store (blocking-floor-single-source guard, WI-6554700010008447).
 *
 * Both endpoint families are covered (D-009): an issue-family endpoint is a BARE ref and a
 * feature-family endpoint a harness-QUALIFIED `<harness>#<id>`, on either side of an edge.
 * The earlier inline join (`feature_id = blocked_ref`) could never match a qualified
 * dependent, so feature-family dependents were silently left ungated. Liveness is judged per
 * form: a bare ref against `feature_id`, a qualified ref against `(harness_slug, feature_id)`.
 */
export async function liveDependents(subjectId: string): Promise<LiveDependent[]> {
  const sql = getOrgPg().sql;
  const harnesses = await sql<{ harness_slug: string }[]>`
    SELECT DISTINCT harness_slug FROM harness_shared.work_items
     WHERE feature_id = ${subjectId} AND harness_slug IS NOT NULL`;
  const subjectRefs = new Set([subjectId, ...harnesses.map((r) => `${r.harness_slug}#${subjectId}`)]);
  const edges = (await readWorkItemDependenciesForRefs(sql, {
    workspaceId: DEFAULT_COORD_WORKSPACE,
    refs: [...subjectRefs],
  })).filter((edge) => subjectRefs.has(edge.blocker_ref));
  if (edges.length === 0) return [];
  const blockedRefs = [...new Set(edges.map((edge) => edge.blocked_ref))];
  const bare = blockedRefs.filter((ref) => !ref.includes('#'));
  const qualified = blockedRefs.filter((ref) => ref.includes('#'));
  const qualifiedIds = qualified.map((ref) => ref.slice(ref.indexOf('#') + 1));
  const live = await sql<{ ref: string }[]>`
    SELECT w.feature_id AS ref
      FROM harness_shared.work_items w
     WHERE w.feature_id = ANY(${bare}::text[])
       AND lower(COALESCE(w.status, '')) <> ALL(${terminalStates()}::text[])
    UNION
    SELECT w.harness_slug || '#' || w.feature_id AS ref
      FROM harness_shared.work_items w
     WHERE w.feature_id = ANY(${qualifiedIds}::text[])
       AND (w.harness_slug || '#' || w.feature_id) = ANY(${qualified}::text[])
       AND lower(COALESCE(w.status, '')) <> ALL(${terminalStates()}::text[])`;
  const liveRefs = new Set(live.map((r: { ref: string }) => r.ref));
  const dependents = new Map<string, LiveDependent>();
  for (const edge of edges) {
    if (!liveRefs.has(edge.blocked_ref)) continue;
    dependents.set(`${edge.blocked_kind}\u0000${edge.blocked_ref}`, { kind: edge.blocked_kind, ref: edge.blocked_ref });
  }
  return [...dependents.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

async function findOpenTask(subjectId: string): Promise<{ id: string } | null> {
  const sql = getOrgPg().sql;
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE payload -> 'verification' ->> 'check' = 'completion'
       AND payload -> 'verification' ->> 'subject' = ${subjectId}
       AND payload ? 'completionVerification'
       AND lower(COALESCE(status, '')) <> ALL(${terminalStates()}::text[])
     ORDER BY created_ts ASC, feature_id ASC
     LIMIT 1`;
  return rows[0] ? { id: rows[0].feature_id } : null;
}

export async function spawnCompletionVerificationForClose(subject: CompletionSubject) {
  return spawnCompletionVerification(subject, {
    liveDependents,
    findOpenTask,
    async createTask(input) {
      const created = await createIssue({
        kind: 'task',
        title: input.title,
        body: input.body,
        ...(input.harness ? { scope: `harness:${input.harness}` } : {}),
        createdBy: COMPLETION_VERIFICATION_ACTOR,
        payload: input.payload,
        // The completion policy sealed acceptance; the task needs no separate review.
        admission: 'auto',
        admittedBy: 'bypass:completion-verification',
      });
      return { id: created.id };
    },
    async addBlockingEdge(taskId, dependent) {
      await linkIssue(taskId, { kind: dependent.kind, ref: dependent.ref }, 'blocks', COMPLETION_VERIFICATION_ACTOR, 'success');
    },
    now: () => new Date(),
  });
}

export async function applyCompletionVerdictForClose(input: { taskPayload: unknown; completion: unknown; verifier: string }) {
  return applyCompletionVerdict(input, {
    async reopenSubject(subjectId, closer, by) {
      await setWorkItemState(subjectId, 'open', { by, force: true, completionRef: `completion verification rejected by ${by}` });
      await claimWorkItem(subjectId, closer, { assignedBy: by });
    },
    async comment(subjectId, body, by) {
      await commentWorkItem(subjectId, body, by);
    },
  });
}

export async function acceptCompletionOnSettlementForSubject(subjectId: string, authority: string) {
  return acceptCompletionOnSettlement(
    { subjectId, authority },
    {
      findOpenTask,
      async closeAccepted(taskId, subject, settledAuthority) {
        await setWorkItemState(taskId, 'done', {
          by: COMPLETION_SETTLEMENT_ACTOR,
          completionRef: `accepted by settlement: ${subject} settled at authority '${settledAuthority}'`,
          skipCompletionGate: true,
        });
      },
    },
  );
}

/** Kept for symmetry with the edge writer: the endpoint a subject id resolves to. */
export const subjectEndpoint = issueRef;

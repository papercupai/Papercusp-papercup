/** Current independent rubric critique, read from the existing consult/review records. */
import type { Rubric } from './rubrics';
import { pgTimestampToIsoOrNull } from './pg-timestamp';

export interface AcceptanceRubricCritique {
  consultId: string | null;
  workItemId: string | null;
  createdAt: string;
  rubricRevision: number | null;
  criteriaHash: string | null;
  critics: string[];
}

export interface RubricCritiqueCandidate {
  consultId?: string;
  workItemId?: string;
  request: string;
  createdAt: string;
}

/** A subject mention alone never establishes which version was reviewed. */
export function critiqueCoversRubric(request: string, rubric: Rubric, revision: number | null): boolean {
  const escaped = rubric.rubricId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = `(?<![\\w-])${escaped}(?![\\w-])`;
  if (!new RegExp(mention, 'i').test(request)) return false;
  // Prefer the content identity: a cosmetic revision bump does not invalidate critique.
  if (rubric.criteriaHash && request.includes(rubric.criteriaHash)) return true;
  // An explicit revision is usable only when no contradictory content hash was supplied.
  if (/criteriaHash\s*[:=]?\s*[`"']?\w+/i.test(request)) return false;
  // A rubric@revision pin belongs to this rubric, unlike a different plan's
  // "revision" in the same request. Explicit stale or malformed pins must not
  // fall through to that unrelated revision, nor may conflicting pins qualify.
  const pins = [...request.matchAll(new RegExp(`${mention}@`, 'gi'))];
  if (pins.length > 0) {
    return revision != null && pins.every(pin =>
      new RegExp(`^${revision}(?![\\w.@-])`).test(request.slice(pin.index! + pin[0].length)));
  }
  // Both "rev3" and "revision 3" name the same immutable revision. Keep the
  // trailing word boundary so rev30 and rev3x cannot qualify as revision 3.
  return revision != null && new RegExp(`\\b(?:rev(?:ision)?)[\\s:=#]*${revision}\\b`, 'i').test(request);
}

type CritiqueDeps = {
  candidates: (rubric: Rubric) => Promise<RubricCritiqueCandidate[]>;
  consult: (id: string, rubric: Rubric) => Promise<{ exists: boolean; critiquePosts: number; critics: string[] }>;
  workItem: (id: string, rubric: Rubric) => Promise<{ exists: boolean; critiquePosts: number; critics: string[] }>;
};

async function defaultCandidates(rubric: Rubric): Promise<RubricCritiqueCandidate[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const rows = await sql`
    SELECT cs.conversation_id,
           CASE WHEN cs.outcome->>'source' = 'archive' THEN source.question ELSE cs.question END AS question,
           CASE WHEN cs.outcome->>'source' = 'archive' THEN source.updated_at ELSE cs.updated_at END AS updated_at
      FROM harness_shared.consult_state cs
      LEFT JOIN harness_shared.consult_state source
        ON source.workspace_id = cs.workspace_id
       AND source.conversation_id = cs.outcome->>'source_conversation_id'
     WHERE cs.workspace_id = ${rubric.workspaceId}
       AND cs.question ILIKE ${'%' + rubric.rubricId + '%'}
     ORDER BY cs.updated_at DESC LIMIT 50
  `;
  const candidates: RubricCritiqueCandidate[] = rows.flatMap(row => {
    const createdAt = pgTimestampToIsoOrNull(row.updated_at);
    return typeof row.conversation_id === 'string' && typeof row.question === 'string' && createdAt
      ? [{ consultId: row.conversation_id, request: row.question, createdAt }] : [];
  });
  // Pullable reviews are an existing alternate critique channel. Search their durable
  // opening request, then let the same third-party-comment reader validate the answer.
  const { searchWorkItems } = await import('./work-items');
  const reviews = await searchWorkItems(rubric.rubricId, { semantic: false, kind: 'task', limit: 50 });
  for (const item of reviews.items) {
    if (!/rubric.vetting|vet\s+(?:acceptance\s+)?rubric/i.test(`${item.title}\n${item.summary}`)) continue;
    candidates.push({ workItemId: item.id, request: `${item.title}\n${item.summary}`, createdAt: item.updatedAt });
  }
  return candidates;
}

export async function readCurrentAcceptanceRubricCritique(
  rubric: Rubric,
  revision: number | null,
  deps: Partial<CritiqueDeps> = {},
): Promise<AcceptanceRubricCritique | null> {
  const candidates = await (deps.candidates ?? defaultCandidates)(rubric);
  for (const candidate of candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    if (!critiqueCoversRubric(candidate.request, rubric, revision)) continue;
    let critique: { exists: boolean; critiquePosts: number; critics: string[] } | undefined;
    if (candidate.consultId) {
      if (deps.consult) critique = await deps.consult(candidate.consultId, rubric);
      else {
        const [{ getOrgPg }, { readVettingConsultCritique }] = await Promise.all([
          import('@papercusp/db-org'), import('./consult/get-feedback-core'),
        ]);
        critique = await readVettingConsultCritique(getOrgPg().sql, rubric.workspaceId,
          candidate.consultId, rubric.createdBy ?? rubric.proposedBy ?? '', [rubric.rubricId]);
      }
    } else if (candidate.workItemId) {
      if (deps.workItem) critique = await deps.workItem(candidate.workItemId, rubric);
      else {
        const { readVettingWorkItemCritique } = await import('./work-items');
        critique = await readVettingWorkItemCritique(candidate.workItemId, [rubric.createdBy, rubric.proposedBy]);
      }
    }
    const critics = critique?.critics.filter(id => id !== rubric.createdBy && id !== rubric.proposedBy) ?? [];
    if (!critique?.exists || critique.critiquePosts < 1 || critics.length === 0) continue;
    return { consultId: candidate.consultId ?? null, workItemId: candidate.workItemId ?? null,
      createdAt: candidate.createdAt, rubricRevision: revision, criteriaHash: rubric.criteriaHash ?? null, critics };
  }
  return null;
}

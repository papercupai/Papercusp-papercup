/** WOE quality evidence, composed from the existing goal/scorecard/completion ledgers.
 * A bounded recent page is never a census, and a passing card is never proof of repair.
 */
import type { Sql } from 'postgres';
import type { ScorecardRow } from './scorecards';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from './pg-timestamp';
import { traceNamedQueryStage } from './agent-tools/db-diagnostic-correlation-wiring';

export const RUBRIC_STEWARDSHIP_CRITERIA = [
  'rubric-coverage-stewardship', 'rubric-quality-stewardship', 'grading-correction-closure',
] as const;
export type StewardshipCriterion = typeof RUBRIC_STEWARDSHIP_CRITERIA[number];
const WOE_RUBRIC = 'work-on-everything-stewardship-health';
const PAGE_SIZE = 40;
const BAD = new Set(['partial', 'degraded', 'fail', 'severe', 'broken']);
const GOOD = new Set(['pass', 'healthy', 'exemplary']);

export interface StewardshipRepair {
  id: string;
  goalId: string;
  owner: string | null;
  closedAt: string | null;
  verified: boolean;
}
export type StewardshipCard = Pick<ScorecardRow, 'issueId' | 'createdAt' | 'createdBy' | 'rubricRef' |
  'rubricRevision' | 'criteriaHash' | 'subject' | 'ratings' | 'supersedes' | 'baselineRef'> & {
  settled: boolean;
  current: boolean;
  requiresIndependentAcceptance: boolean;
  /** Canonical spawn/rebind lineage was read, rather than comparing labels only. */
  acceptanceIndependent?: boolean;
};
export interface StewardshipCycle {
  target: string;
  rubricRef: string;
  rubricRevision: number | null;
  baselineRef: string | null;
  scorecardRef: string;
  repairRefs: string[];
  status: 'baseline' | 'needs-repair' | 'needs-regrade' | 'unverified' | 'incomparable' | 'verified';
  reason: string;
}
export interface GoalRubricStewardship {
  measuredAt: string;
  windowStart: string;
  complete: boolean;
  rubricRef: string;
  rubricRevision: number | null;
  criteria: Record<StewardshipCriterion, { rating: string; evidence: string; scorecardRef: string } | null>;
  cycles: StewardshipCycle[];
  /** Persisted GRADE entry, tracked session and goal-owned work are separate facts. */
  gradingAssignments?: Array<{
    ownerId: string;
    subject: string | null;
    enteredGradeAt: string;
    launchRef: string | null;
    launchedAt: string | null;
    endedAt: string | null;
    work: Array<{ ref: string; state: string; claimedAt: string | null; progressAt: string | null; authority: string | null }>;
  }>;
  assignmentsComplete?: boolean;
  error: string | null;
}

/** Reuse the goal-scoped snapshot in launch, portfolio and wake briefs. */
export function renderGoalRubricStewardshipBrief(evidence: GoalRubricStewardship | null | undefined): string {
  const lines = [
    'RUBRIC STEWARDSHIP — Maintain rubric coverage; Improve rubric quality; Grade, improve and re-grade.',
    'Reuse applicable rubrics and independently vet genuine gaps/amendments. Delegate bounded GRADE assignments with exact target, pinned rubric revision, goal provenance, scope, budget, cadence and exit criterion; verify launch, claim and progress separately.',
    'Preserve the baseline; emit a comparable regrade with baselineRef. supersedes corrects an earlier reading and is never improvement evidence. Place repairs with implementers; require recurrence guards, verified closure and an independent acceptance grader where required.',
  ];
  if (!evidence) return [...lines, 'Evidence: unavailable — read canonical goal-scoped rubric, scorecard and work-item ledgers; no verified improvement is established.'].join('\n');
  lines.push(`Applicable rubric: ${evidence.rubricRef}@${evidence.rubricRevision ?? 'unknown'}; measured ${evidence.measuredAt}; since ${evidence.windowStart}; coverage=${evidence.complete ? 'complete recent page' : 'limited recent page, not a census'}.`);
  if (evidence.error) lines.push(`Evidence unavailable: ${evidence.error}`);
  if (evidence.gradingAssignments) {
    lines.push(`GRADE assignments: ${evidence.assignmentsComplete ? 'complete recent page' : 'limited recent page, not a census'}.`);
    for (const assignment of evidence.gradingAssignments.slice(0, 4)) {
      lines.push(`GRADE ${assignment.ownerId}; subject=${assignment.subject ?? 'not recorded'}; entered=${assignment.enteredGradeAt}; launch=${assignment.launchRef ?? 'unverified'}; ended=${assignment.endedAt ?? 'not recorded'}; goal-owned work=${assignment.work.map(w => `${w.ref}[${w.state}; claimed=${w.claimedAt ?? 'not recorded'}; progress=${w.progressAt ?? 'not recorded'}; authority=${w.authority ?? 'unjudged'}]`).join(', ') || 'none measured'}.`);
    }
  }
  for (const key of RUBRIC_STEWARDSHIP_CRITERIA) {
    const rating = evidence.criteria[key];
    lines.push(`${key}: ${rating ? `${rating.rating}; scorecard=${rating.scorecardRef}; ${rating.evidence}` : 'not measured'}`);
  }
  const shown = evidence.cycles.slice(0, 8);
  for (const cycle of shown) lines.push(`Cycle ${cycle.target} (${cycle.rubricRef}@${cycle.rubricRevision ?? 'unknown'}): ${cycle.status}; baseline=${cycle.baselineRef ?? 'missing'}; regrade=${cycle.scorecardRef}; repairs=${cycle.repairRefs.join(',') || 'none'}; ${cycle.reason}`);
  if (!shown.length) lines.push('Grading cycles: none measured; a launch or completed repair alone is not verified improvement.');
  if (evidence.cycles.length > shown.length) lines.push(`${evidence.cycles.length - shown.length} additional cycles in this bounded page; read their canonical references before allocating duplicate work.`);
  lines.push('A changed target/rubric revision needs a fresh baseline. Unknown, stale, incomplete and unsuccessful evidence remains a gap; preserve paused/killed state and owner worklist choices.');
  return lines.join('\n');
}

/** The remediation field is the scorecard's canonical pointer to its owned repairs. */
export function stewardshipRepairRefs(card: StewardshipCard): string[] {
  return [...new Set(Object.values(card.ratings).flatMap(r =>
    r.remediation?.match(/\b(?:WI|EI)-\d+\b/g) ?? []))];
}

export function classifyStewardshipCycle(
  goalId: string, card: StewardshipCard, cards: readonly StewardshipCard[], repairs: readonly StewardshipRepair[],
): StewardshipCycle {
  const baseline = cards.find(c => c.issueId === card.baselineRef);
  const repairRefs = stewardshipRepairRefs(baseline ?? card);
  const out = (status: StewardshipCycle['status'], reason: string): StewardshipCycle => ({
    target: card.subject?.ref ?? 'Target not recorded', rubricRef: card.rubricRef,
    rubricRevision: card.rubricRevision ?? null, baselineRef: baseline?.issueId ?? null,
    scorecardRef: card.issueId, repairRefs, status, reason,
  });
  if (!Number.isFinite(Date.parse(card.createdAt)) ||
      (baseline && !Number.isFinite(Date.parse(baseline.createdAt)))) {
    return out('unverified', 'Scorecard chronology could not be verified.');
  }
  if (!card.subject || !card.settled || !card.current) return out('unverified', 'Current, audited terminal evidence is required.');
  if (card.supersedes) return out('unverified', 'A corrected scorecard is not a preserved baseline-to-regrade comparison.');
  if (!baseline) {
    if (card.baselineRef) return out('unverified', 'The linked baseline is outside the available goal-scoped evidence.');
    if (Object.values(card.ratings).some(r => BAD.has(r.rating))) {
      const closed = repairRefs.length > 0 && repairRefs.every(id => repairs.some(r =>
        r.id === id && r.goalId === goalId && r.verified && r.closedAt &&
        Number.isFinite(Date.parse(r.closedAt)) && Date.parse(r.closedAt) > Date.parse(card.createdAt)));
      return out(closed ? 'needs-regrade' : 'needs-repair', closed
        ? 'Verified repairs are recorded; a comparable re-grade is still needed.'
        : 'Baseline findings need owned, verified repairs.');
    }
    return out(Object.values(card.ratings).every(r => GOOD.has(r.rating) || r.rating === 'not-applicable') &&
      Object.keys(card.ratings).length > 0 ? 'baseline' : 'unverified',
      'Baseline recorded; verified improvement has not been established.');
  }
  if (!baseline.subject || card.subject.ref !== baseline.subject.ref || card.subject.kind !== baseline.subject.kind ||
      card.rubricRef !== baseline.rubricRef || !card.rubricRevision || card.rubricRevision !== baseline.rubricRevision ||
      !card.criteriaHash || card.criteriaHash !== baseline.criteriaHash) {
    return out('incomparable', 'Target or rubric revision changed; record a fresh baseline.');
  }
  if (!baseline.settled || !baseline.current || Date.parse(baseline.createdAt) >= Date.parse(card.createdAt)) {
    return out('unverified', 'An earlier audited baseline is required.');
  }
  const failed = Object.entries(baseline.ratings).filter(([, r]) => BAD.has(r.rating));
  if (!failed.length || !repairRefs.length) return out('unverified', 'No confirmed baseline finding with an owned repair is recorded.');
  const selected = repairRefs.map(id => repairs.find(r => r.id === id && r.goalId === goalId));
  if (selected.some(r => !r?.verified || !r.closedAt || !Number.isFinite(Date.parse(r.closedAt)) ||
      Date.parse(r.closedAt) <= Date.parse(baseline.createdAt) || Date.parse(r.closedAt) >= Date.parse(card.createdAt))) {
    return out('unverified', 'Every linked repair needs verification between the baseline and re-grade.');
  }
  if (card.requiresIndependentAcceptance && (card.acceptanceIndependent !== true ||
      !card.createdBy || selected.some(r => !r?.owner || r.owner === card.createdBy))) {
    return out('unverified', 'This rubric requires acceptance by a grader independent of the implementers.');
  }
  if (failed.some(([key]) => !GOOD.has(card.ratings[key]?.rating ?? '')) ||
      Object.values(card.ratings).some(r => BAD.has(r.rating) || r.rating === 'unknown')) {
    return out('needs-repair', 'The re-grade has unresolved or unmeasured criteria.');
  }
  return out('verified', 'Comparable audited re-grade confirms the verified repairs.');
}

/** Goal scope comes from persisted attribution, never title matches or the reader's agent. */
export async function readGoalRubricStewardship(
  input: { workspaceId: string; goalId: string; nowMs?: number }, deps: { sql: Sql },
): Promise<GoalRubricStewardship> {
  const now = input.nowMs ?? Date.now();
  const windowStart = new Date(now - 7 * 86400_000).toISOString();
  const base: GoalRubricStewardship = {
    measuredAt: new Date(now).toISOString(), windowStart, complete: false,
    rubricRef: WOE_RUBRIC, rubricRevision: null,
    criteria: Object.fromEntries(RUBRIC_STEWARDSHIP_CRITERIA.map(k => [k, null])) as GoalRubricStewardship['criteria'],
    cycles: [], error: null,
  };
  try {
    const { sql } = deps;
    const rows = await sql<{ id: string; baseline: string | null }[]>`
      SELECT feature_id AS id, payload->'observation'->>'baselineRef' AS baseline
        FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId} AND goal_id = ${input.goalId}
         AND lane = 'observation' AND payload->'observation'->>'rubricRef' IS NOT NULL
         AND payload->'observation'->>'rubricRef' NOT IN ('grading-integrity', 'spec-quality', 'spec-test-adequacy')
         AND created_ts >= ${Date.parse(windowStart)} AND created_ts <= ${now}
       ORDER BY created_ts DESC, feature_id DESC LIMIT ${PAGE_SIZE + 1}`;
    const page = rows.slice(0, PAGE_SIZE);
    // The append-only mode ledger retains exited assignments. Goal provenance
    // comes from the maintained successor brief, not the reader or a title match.
    const assignmentRows = await sql<Array<{ owner_id: string; subject: string | null; mode_at: unknown;
      session_ref: string | null; launch_at: unknown; ended_at: unknown }>>`
      SELECT DISTINCT ON (c.owner_id) c.owner_id, c.subject, c.changed_at AS mode_at,
             a.session_ref, a.launch_at, a.ended_at
        FROM harness_shared.agent_mode_changes c
        JOIN harness_shared.session_briefs b ON b.workspace_id = c.workspace_id AND b.owner_id = c.owner_id
        LEFT JOIN LATERAL (
          SELECT id::text AS session_ref, first_seen_at AS launch_at, ended_at
            FROM harness_shared.adv_sessions
           WHERE workspace_id = c.workspace_id AND coord_owner_id = c.owner_id
           ORDER BY started_at DESC, id DESC LIMIT 1
        ) a ON true
       WHERE c.workspace_id = ${input.workspaceId} AND b.goal_id = ${input.goalId}
         AND c.new_mode = 'grade' AND c.changed_at >= ${windowStart}::timestamptz
         AND c.changed_at <= ${new Date(now).toISOString()}::timestamptz
       ORDER BY c.owner_id, c.changed_at DESC LIMIT ${PAGE_SIZE + 1}`;
    const assignmentPage = assignmentRows.slice(0, PAGE_SIZE);
    const owners = assignmentPage.map(a => a.owner_id);
    const assignmentWork = owners.length ? await sql<Array<{ id: string; owner_id: string; state: string;
      claimed_at: unknown; progress_at: unknown; authority: string | null }>>`
      SELECT feature_id AS id, COALESCE(taken_by, terminal_owner) AS owner_id, status AS state,
             taken_at AS claimed_at, last_progress_at AS progress_at, authority
        FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId} AND goal_id = ${input.goalId}
         AND COALESCE(taken_by, terminal_owner) = ANY(${owners})
         AND updated_ts >= ${Date.parse(windowStart)} AND updated_ts <= ${now}
       ORDER BY updated_ts DESC, feature_id DESC LIMIT ${PAGE_SIZE * 2 + 1}` : [];
    const gradingAssignments = assignmentPage.map(a => ({
      ownerId: a.owner_id, subject: a.subject, enteredGradeAt: pgTimestampToIso(a.mode_at),
      launchRef: a.session_ref ? `adv-session:${a.session_ref}` : null,
      launchedAt: pgTimestampToIsoOrNull(a.launch_at), endedAt: pgTimestampToIsoOrNull(a.ended_at),
      work: assignmentWork.slice(0, PAGE_SIZE * 2).filter(w => w.owner_id === a.owner_id).map(w => ({
        ref: w.id, state: w.state, claimedAt: pgTimestampToIsoOrNull(w.claimed_at),
        progressAt: pgTimestampToIsoOrNull(w.progress_at), authority: w.authority,
      })),
    }));
    const baselineIds = page.flatMap(r => r.baseline ? [r.baseline] : []);
    const earlier = baselineIds.length ? await sql<{ id: string }[]>`
      SELECT feature_id AS id FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId} AND goal_id = ${input.goalId}
         AND feature_id = ANY(${baselineIds}) AND created_ts <= ${now}` : [];
    const ids = [...new Set([...page, ...earlier].map(r => r.id))];
    // Reuse the canonical reader: it resolves rubric/audit currentness and retractions.
    const [{ listScorecards, settledGradingAuditIsCurrent }, { getRubricWithoutSeeding }, { isSufficientEvidence }, { getWorkItemsByIds }] = await traceNamedQueryStage('stewardship-dependencies', () => Promise.all([
      import('./scorecards'), import('./rubrics'), import('./work-item-completion-authority'), import('./work-items'),
    ]));
    const [stored, rubric] = await Promise.all([
      // Cycle classification consumes rubric/audit currentness, not the bg-host
      // generation. Awaiting that unused process probe can exhaust goals.detail's
      // deadline while the mandatory evidence reads have already completed.
      ids.length ? traceNamedQueryStage('stewardship-scorecards', () => listScorecards({ issueIds: ids,
        includeSuperseded: true, includeGeneration: false, limit: PAGE_SIZE * 2 })) : Promise.resolve([]),
      // Missing rubrics stay unmeasured. A GUI read must not start the broad
      // library fallback's first-party seed writes in a cold real process.
      traceNamedQueryStage('stewardship-rubrics', () => getRubricWithoutSeeding(WOE_RUBRIC)),
    ]);
    const rubrics = new Map(await traceNamedQueryStage('stewardship-rubrics', () => Promise.all([...new Set(stored.map(c => c.rubricRef))].map(async ref => [ref, await getRubricWithoutSeeding(ref)] as const))));
    const cards: StewardshipCard[] = stored.filter(c => ids.includes(c.issueId)).map(c => ({ ...c,
      settled: c.rubricResolved && c.missingKeys.length === 0 && !c.provisional && !c.synthesized &&
        !c.retracted && !c.supersededBy && !!c.gradingAudit && settledGradingAuditIsCurrent(c),
      current: c.rubricCurrentness?.state === 'current',
      requiresIndependentAcceptance: rubrics.get(c.rubricRef)?.kind === 'acceptance' ||
        rubrics.get(c.rubricRef)?.gradingAuthority === 'independent',
    }));
    const refs = [...new Set(cards.flatMap(stewardshipRepairRefs))];
    const repairRows = refs.length ? await sql<{ id: string }[]>`
      SELECT feature_id AS id
        FROM harness_shared.work_items WHERE workspace_id = ${input.workspaceId}
         AND goal_id = ${input.goalId} AND feature_id = ANY(${refs})` : [];
    const canonicalRepairs = repairRows.length ? await traceNamedQueryStage('stewardship-repairs', () => getWorkItemsByIds(repairRows.map(r => r.id))) : [];
    const repairs: StewardshipRepair[] = canonicalRepairs.map(r => ({
      id: r.id, goalId: input.goalId, owner: r.terminalOwner,
      closedAt: r.closedAt,
      verified: r.state === 'done' && (r.completionAuthority === 'committed' || r.completionAuthority === 'validated') &&
        isSufficientEvidence(r.terminalCompletionEvidence),
    }));
    // Reuse the acceptance authority's spawn/rebind closure. A child/successor
    // with a different label still belongs to its implementer's lineage.
    const { acceptanceLineageClosure } = await import('./acceptance-author-identity');
    const lineages = new Map<string, Set<string>>();
    for (const card of cards) {
      if (!card.requiresIndependentAcceptance || !card.createdBy) continue;
      let lineage = lineages.get(card.createdBy);
      if (!lineage) {
        lineage = await traceNamedQueryStage('stewardship-lineage', () => acceptanceLineageClosure(card.createdBy!, { workspaceId: input.workspaceId, sql }));
        lineages.set(card.createdBy, lineage);
      }
      const baseline = cards.find(c => c.issueId === card.baselineRef);
      const owners = stewardshipRepairRefs(baseline ?? card).map(id => repairs.find(r => r.id === id)?.owner);
      card.acceptanceIndependent = owners.length > 0 && owners.every(owner => !!owner && !lineage.has(owner));
    }
    const latest = cards.find(c => c.rubricRef === WOE_RUBRIC && c.current && c.settled);
    return { ...base, complete: rows.length <= PAGE_SIZE, rubricRevision: rubric?.revision ?? null,
      gradingAssignments, assignmentsComplete: assignmentRows.length <= PAGE_SIZE && assignmentWork.length <= PAGE_SIZE * 2,
      criteria: Object.fromEntries(RUBRIC_STEWARDSHIP_CRITERIA.map(key => [key, latest?.ratings[key]
        ? { rating: latest.ratings[key].rating, evidence: latest.ratings[key].evidence, scorecardRef: latest.issueId } : null])) as GoalRubricStewardship['criteria'],
      cycles: cards.filter(c => page.some(r => r.id === c.issueId) &&
        !cards.some(newer => newer.supersedes === c.issueId || newer.baselineRef === c.issueId))
        .map(c => classifyStewardshipCycle(input.goalId, c, cards, repairs)),
    };
  } catch (error) {
    return { ...base, error: `Rubric stewardship evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

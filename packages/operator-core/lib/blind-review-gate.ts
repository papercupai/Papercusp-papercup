/**
 * Blind gap review before acceptance: the door, its store, and the brief loader.
 * verification-system-improvements-2026-10-10 P-006 (D-006, D-039).
 *
 * A reviewer who never read the plan's artifacts gets only the owner's source turns
 * (the latest activation audit's cited owner turns) and the running product, and
 * records the gaps it finds. Each gap must then be dispositioned to a required plan
 * item or to a Decision recorded as an accepted risk.
 *
 * evaluateBlindReviewGate is called at BOTH awaiting-acceptance writers (plans:set-status
 * in-lock drain, applyPlanDrainTransition) and at ship (plan-acceptance-gate.ts):
 *
 *   blind_review_missing             no review that counts is recorded for the plan's
 *                                    latest activation audit (D-039 (1)); a review
 *                                    counts only if its reviewer never read the plan's
 *                                    artifacts before posting (ledger probe, D-039 (4))
 *                                    and is not the owner, an implementer, or
 *                                    lineage-related to one.
 *   blind_review_gap_undispositioned a counted review's gap has neither a non-dropped
 *                                    plan item nor an existing Decision.
 *   blind_review_unavailable         a read failed; the door refuses rather than guess.
 *
 * Not waivable by force: it is an independence check (D-039 (5)).
 */
import { getOrgPg } from '@papercusp/db-org';
import { parsePlan } from '@papercusp/plan-parser';
import { createHash } from 'node:crypto';
import { activeWorkspaceId } from './workspace-registry';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { fetchSourceTurns } from './activation-item-provenance';
import { buildBlindReviewBrief, type BlindReviewBrief } from './blind-review-brief';

/** Plans created before this instant are not in the cohort unless they record a review. */
export const BLIND_REVIEW_REQUIRED_AFTER = '2026-10-11T03:00:00.000Z';

/** Tool families whose call, naming the plan slug, counts as reading the plan's artifacts. */
export const PLAN_ARTIFACT_TOOL_FAMILIES = ['plans', 'rubrics', 'scorecards', 'acceptance'] as const;

/** The one plans:* tool a blind reviewer may call: it returns owner turns, ids and codes only. */
export const BLIND_REVIEW_TOOL = 'plans:blind-review';

/** Owner-turn text width for the brief (the activation audit itself reads only a head). */
const BRIEF_TURN_CHARS = 20_000;

export type BlindReviewGateCode =
  | 'blind_review_missing'
  | 'blind_review_gap_undispositioned'
  | 'blind_review_unavailable';

export interface BlindReviewGap {
  reviewId: number;
  gapId: string;
  text: string;
}

export interface RejectedBlindReview {
  reviewId: number;
  reviewer: string;
  reason: 'read-plan-artifacts' | 'owner-or-implementer' | 'lineage-related';
  detail: string;
}

export interface BlindReviewVerdict {
  satisfied: boolean;
  /** False when the plan is outside the door's scope; the door then has nothing to decide. */
  applicable: boolean;
  notApplicableReason?: 'pre-cohort' | 'no-activation-audit';
  code?: BlindReviewGateCode;
  message?: string;
  activationAuditSeq?: number;
  acceptedReviewIds: number[];
  rejectedReviews: RejectedBlindReview[];
  undispositionedGaps: BlindReviewGap[];
  readFailure?: string;
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

export interface BlindReviewGateDeps {
  sql?: Sql;
  resolveImplementers?: (planSlug: string, workspaceId: string) => Promise<string[]>;
  lineageRelated?: (a: string, b: string, workspaceId: string) => Promise<boolean>;
}

interface PlanRow {
  harness_slug: string;
  created_at: Date | string | null;
  owner: string | null;
  content: string | null;
}

interface ActivationRow {
  audit_seq: number;
  activation: { mappings?: Array<{ sourceRefs?: string[] | null }> } | null;
}

interface ReviewRow {
  id: number | string;
  record_kind: 'review' | 'disposition';
  activation_audit_seq: number;
  gaps: Array<{ id: string; text: string }>;
  dispositions: Array<{ reviewId: number; gapId: string; itemId?: string; acceptedRiskDecisionId?: string }>;
  created_by: string;
  created_at: Date | string;
}

interface PlanFacts {
  plan: PlanRow;
  activation: ActivationRow | null;
  rows: ReviewRow[];
}

async function readPlanFacts(sql: Sql, workspaceId: string, planSlug: string, harnessSlug?: string | null): Promise<PlanFacts | null> {
  const harness = harnessSlug ?? null;
  const [plan] = await sql<PlanRow[]>`
    SELECT harness_slug, created_at, owner, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND plan_slug = ${planSlug}
       AND (${harness}::text IS NULL OR harness_slug = ${harness})
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`;
  if (!plan) return null;
  const [activation] = await sql<ActivationRow[]>`
    SELECT audit_seq, activation
      FROM harness_shared.plan_audits
     WHERE workspace_id = ${workspaceId} AND plan_slug = ${planSlug} AND audit_kind = 'activation'
     ORDER BY audit_seq DESC
     LIMIT 1`;
  const rows = await sql<ReviewRow[]>`
    SELECT id, record_kind, activation_audit_seq, gaps, dispositions, created_by, created_at
      FROM harness_shared.plan_blind_reviews
     WHERE workspace_id = ${workspaceId} AND plan_slug = ${planSlug}
     ORDER BY id`;
  return { plan, activation: activation ?? null, rows };
}

/** First artifact read by `reviewer` naming `planSlug` before `before`, or null. */
async function firstArtifactRead(
  sql: Sql,
  reviewer: string,
  planSlug: string,
  before: Date,
): Promise<{ tool_name: string; invoked_at: Date | string } | null> {
  const families = `^(${PLAN_ARTIFACT_TOOL_FAMILIES.join('|')})[:_]`;
  const [row] = await sql<Array<{ tool_name: string; invoked_at: Date | string }>>`
    SELECT CASE WHEN tool_name = 'tools:invoke' THEN args_json->>'name' ELSE tool_name END AS tool_name,
           invoked_at
      FROM harness_shared.tool_invocations
     WHERE coord_owner_id = ${reviewer}
       AND invoked_at < ${before}
       AND strpos(args_json::text, ${planSlug}) > 0
       AND (
         (tool_name ~ ${families} AND tool_name NOT IN (${BLIND_REVIEW_TOOL}, 'plans_blind-review', 'plans_blind_review'))
         OR (tool_name = 'tools:invoke' AND coalesce(args_json->>'name', '') ~ ${families}
           AND args_json->>'name' <> ${BLIND_REVIEW_TOOL})
       )
     ORDER BY invoked_at
     LIMIT 1`;
  return row ?? null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function inCohort(createdAt: Date | string | null, hasReviews: boolean): boolean {
  if (hasReviews) return true;
  const ms = createdAt == null ? Number.NaN : toDate(createdAt).getTime();
  // Fail closed: an unreadable age is IN the cohort.
  return !Number.isFinite(ms) || ms >= Date.parse(BLIND_REVIEW_REQUIRED_AFTER);
}

/** Item ids that can carry a gap (non-dropped) and every Decision id, from the plan body. */
function dispositionTargets(body: string | null): { items: Set<string>; decisions: Set<string> } {
  if (!body) return { items: new Set(), decisions: new Set() };
  const parsed = parsePlan(body);
  return {
    items: new Set(parsed.items.filter((i) => i.storedStatus !== 'dropped').map((i) => i.id)),
    decisions: new Set(parsed.decisions.map((d) => d.id)),
  };
}

export async function evaluateBlindReviewGate(
  input: { planSlug: string; harnessSlug?: string | null; workspaceId?: string; planBody?: string | null },
  deps: BlindReviewGateDeps = {},
): Promise<BlindReviewVerdict> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const sql = deps.sql ?? getOrgPg().sql;
  const resolveImplementers =
    deps.resolveImplementers ?? ((plan, ws) => resolvePlanImplementerIdentities(plan, { workspaceId: ws }));
  const lineageRelated =
    deps.lineageRelated ?? ((a, b, ws) => areAcceptanceLineageRelated(a, b, { workspaceId: ws }));
  const base = { acceptedReviewIds: [] as number[], rejectedReviews: [] as RejectedBlindReview[], undispositionedGaps: [] as BlindReviewGap[] };

  const unavailable = (what: string, error: unknown): BlindReviewVerdict => {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      satisfied: false,
      applicable: true,
      code: 'blind_review_unavailable',
      readFailure: `${what}: ${detail}`,
      message:
        `plan '${input.planSlug}' cannot proceed to acceptance: the blind gap review check could not read ${what} ` +
        `(${detail}). The door refuses rather than guess; repair the read and retry.`,
    };
  };

  let facts: PlanFacts | null;
  try {
    facts = await readPlanFacts(sql, workspaceId, input.planSlug, input.harnessSlug);
  } catch (error) {
    return unavailable('the plan, its activation audit or its blind reviews', error);
  }
  if (!facts) return unavailable('the plan', new Error('plan not found'));

  const reviews = facts.rows.filter((r) => r.record_kind === 'review');
  if (!inCohort(facts.plan.created_at, reviews.length > 0)) {
    return { ...base, satisfied: true, applicable: false, notApplicableReason: 'pre-cohort' };
  }
  if (!facts.activation) {
    return { ...base, satisfied: true, applicable: false, notApplicableReason: 'no-activation-audit' };
  }
  const anchor = facts.activation.audit_seq;
  const candidates = reviews.filter((r) => r.activation_audit_seq === anchor);

  let excluded: string[];
  try {
    const implementers = await resolveImplementers(input.planSlug, workspaceId);
    excluded = [...new Set([facts.plan.owner, ...implementers].filter((x): x is string => !!x))];
  } catch (error) {
    return unavailable('the plan implementers', error);
  }

  const accepted: ReviewRow[] = [];
  const rejected: RejectedBlindReview[] = [];
  try {
    for (const review of candidates) {
      const reviewId = Number(review.id);
      const reviewer = review.created_by;
      if (excluded.includes(reviewer)) {
        rejected.push({ reviewId, reviewer, reason: 'owner-or-implementer', detail: `${reviewer} owns or implemented the plan` });
        continue;
      }
      let related: string | null = null;
      for (const other of excluded) {
        if (await lineageRelated(reviewer, other, workspaceId)) { related = other; break; }
      }
      if (related) {
        rejected.push({ reviewId, reviewer, reason: 'lineage-related', detail: `${reviewer} shares a spawn/rebind lineage with ${related}` });
        continue;
      }
      const read = await firstArtifactRead(sql, reviewer, input.planSlug, toDate(review.created_at));
      if (read) {
        rejected.push({
          reviewId, reviewer, reason: 'read-plan-artifacts',
          detail: `${reviewer} called ${read.tool_name} on this plan at ${toDate(read.invoked_at).toISOString()}, before posting`,
        });
        continue;
      }
      accepted.push(review);
    }
  } catch (error) {
    return unavailable('the reviewer ledger or lineage', error);
  }

  if (accepted.length === 0) {
    const why = rejected.length
      ? ` ${rejected.length} recorded review(s) do not count: ${rejected.map((r) => `#${r.reviewId} ${r.detail}`).join('; ')}.`
      : '';
    return {
      ...base,
      satisfied: false,
      applicable: true,
      code: 'blind_review_missing',
      activationAuditSeq: anchor,
      rejectedReviews: rejected,
      message:
        `plan '${input.planSlug}' has no blind gap review for its activation audit #${anchor}.${why} ` +
        `Have a reviewer outside the plan's lineage, who has not read the plan, take the brief from ` +
        `plans:blind-review { slug, op: 'brief' } and post its gaps with op 'post'.`,
    };
  }

  const { items, decisions } = dispositionTargets(input.planBody ?? facts.plan.content);
  const disposed = new Map<string, { itemId?: string; acceptedRiskDecisionId?: string }>();
  for (const row of facts.rows) {
    if (row.record_kind !== 'disposition') continue;
    for (const d of row.dispositions) disposed.set(`${d.reviewId}:${d.gapId}`, d);
  }
  const undispositioned: BlindReviewGap[] = [];
  for (const review of accepted) {
    for (const gap of review.gaps) {
      const d = disposed.get(`${Number(review.id)}:${gap.id}`);
      const ok = d && ((d.itemId && items.has(d.itemId)) || (d.acceptedRiskDecisionId && decisions.has(d.acceptedRiskDecisionId)));
      if (!ok) undispositioned.push({ reviewId: Number(review.id), gapId: gap.id, text: gap.text });
    }
  }
  const acceptedReviewIds = accepted.map((r) => Number(r.id));
  if (undispositioned.length) {
    return {
      ...base,
      satisfied: false,
      applicable: true,
      code: 'blind_review_gap_undispositioned',
      activationAuditSeq: anchor,
      acceptedReviewIds,
      rejectedReviews: rejected,
      undispositionedGaps: undispositioned,
      message:
        `plan '${input.planSlug}' has ${undispositioned.length} blind-review gap(s) with neither a plan item nor an ` +
        `accepted-risk Decision: ${undispositioned.map((g) => `review #${g.reviewId} ${g.gapId}`).join(', ')}. ` +
        `Record each with plans:blind-review { slug, op: 'dispose', dispositions: [{ reviewId, gapId, itemId | acceptedRiskDecisionId }] }.`,
    };
  }
  return { ...base, satisfied: true, applicable: true, activationAuditSeq: anchor, acceptedReviewIds, rejectedReviews: rejected };
}

// ── store ────────────────────────────────────────────────────────────────────

export type BlindReviewWriteRefusal =
  | 'plan_not_found'
  | 'no_activation_audit'
  | 'activation_audit_mismatch'
  | 'review_not_found'
  | 'gap_not_found'
  | 'disposition_target_missing'
  | 'idempotency_conflict';

export type BlindReviewWriteResult =
  | { ok: true; id: number; activationAuditSeq: number; gapIds: string[] }
  | { ok: false; code: BlindReviewWriteRefusal; message: string };

export async function recordBlindReview(
  input: {
    workspaceId: string;
    planSlug: string;
    harnessSlug?: string | null;
    createdBy: string;
    gaps: ReadonlyArray<{ text: string }>;
    activationAuditSeq?: number;
    summary?: string;
  },
  deps: { sql?: Sql } = {},
): Promise<BlindReviewWriteResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const facts = await readPlanFacts(sql, input.workspaceId, input.planSlug, input.harnessSlug);
  if (!facts) return { ok: false, code: 'plan_not_found', message: `no plan '${input.planSlug}'` };
  if (!facts.activation) {
    return { ok: false, code: 'no_activation_audit', message: `plan '${input.planSlug}' has no activation audit to brief a blind review from` };
  }
  const anchor = facts.activation.audit_seq;
  if (input.activationAuditSeq !== undefined && input.activationAuditSeq !== anchor) {
    return {
      ok: false,
      code: 'activation_audit_mismatch',
      message: `the brief was built from activation audit #${input.activationAuditSeq}, but the plan's latest is #${anchor}; take a fresh brief`,
    };
  }
  const gaps = input.gaps.map((g, i) => ({ id: `G-${i + 1}`, text: g.text }));
  const idempotencyKey = `blind-review:v1:${createHash('sha256')
    .update(`${input.workspaceId}\u0000${input.planSlug}\u0000${anchor}\u0000${input.createdBy}`)
    .digest('hex')}`;
  const samePost = (row: { activation_audit_seq: number | string; gaps: unknown }) =>
    Number(row.activation_audit_seq) === anchor && JSON.stringify(row.gaps) === JSON.stringify(gaps);
  const [existing] = await sql<Array<{ id: number | string; activation_audit_seq: number | string; gaps: unknown }>>`
    SELECT id, activation_audit_seq, gaps
      FROM harness_shared.plan_blind_reviews
     WHERE workspace_id = ${input.workspaceId}
       AND record_kind = 'review'
       AND idempotency_key = ${idempotencyKey}
     LIMIT 1`;
  if (existing) {
    if (!samePost(existing)) {
      return {
        ok: false,
        code: 'idempotency_conflict',
        message: 'this reviewer session already posted different gaps for the current activation audit',
      };
    }
    return {
      ok: true,
      id: Number(existing.id),
      activationAuditSeq: anchor,
      gapIds: gaps.map((g) => g.id),
    };
  }
  const [row] = await sql<Array<{ id: number | string }>>`
    INSERT INTO harness_shared.plan_blind_reviews
      (workspace_id, harness_slug, plan_slug, record_kind, activation_audit_seq, gaps, summary, created_by, idempotency_key)
    VALUES (${input.workspaceId}, ${facts.plan.harness_slug}, ${input.planSlug}, 'review', ${anchor},
            ${sql.json(gaps as never)}, ${input.summary ?? null}, ${input.createdBy}, ${idempotencyKey})
    ON CONFLICT (workspace_id, idempotency_key)
      WHERE record_kind = 'review' AND idempotency_key IS NOT NULL
      DO NOTHING
    RETURNING id`;
  if (row) return { ok: true, id: Number(row.id), activationAuditSeq: anchor, gapIds: gaps.map((g) => g.id) };

  // The unique index serializes simultaneous retries. A conflict means another
  // request won the insert between our first read and write; return that same
  // receipt only if it carries the identical activation anchor and gaps.
  const [raced] = await sql<Array<{ id: number | string; activation_audit_seq: number | string; gaps: unknown }>>`
    SELECT id, activation_audit_seq, gaps
      FROM harness_shared.plan_blind_reviews
     WHERE workspace_id = ${input.workspaceId}
       AND record_kind = 'review'
       AND idempotency_key = ${idempotencyKey}
     LIMIT 1`;
  if (raced && samePost(raced)) {
    return { ok: true, id: Number(raced.id), activationAuditSeq: anchor, gapIds: gaps.map((g) => g.id) };
  }
  return {
    ok: false,
    code: 'idempotency_conflict',
    message: 'the review post conflicted with an existing idempotency receipt; retry only after checking the stored review',
  };
}

export async function recordBlindGapDispositions(
  input: {
    workspaceId: string;
    planSlug: string;
    harnessSlug?: string | null;
    createdBy: string;
    dispositions: ReadonlyArray<{ reviewId: number; gapId: string; itemId?: string; acceptedRiskDecisionId?: string }>;
    summary?: string;
  },
  deps: { sql?: Sql } = {},
): Promise<BlindReviewWriteResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const facts = await readPlanFacts(sql, input.workspaceId, input.planSlug, input.harnessSlug);
  if (!facts) return { ok: false, code: 'plan_not_found', message: `no plan '${input.planSlug}'` };
  const reviews = new Map(facts.rows.filter((r) => r.record_kind === 'review').map((r) => [Number(r.id), r]));
  const { items, decisions } = dispositionTargets(facts.plan.content);
  for (const d of input.dispositions) {
    const review = reviews.get(d.reviewId);
    if (!review) return { ok: false, code: 'review_not_found', message: `no blind review #${d.reviewId} on this plan` };
    if (!review.gaps.some((g) => g.id === d.gapId)) {
      return { ok: false, code: 'gap_not_found', message: `review #${d.reviewId} has no gap ${d.gapId}` };
    }
    const target = d.itemId ? items.has(d.itemId) : d.acceptedRiskDecisionId ? decisions.has(d.acceptedRiskDecisionId) : false;
    if (!target) {
      return {
        ok: false,
        code: 'disposition_target_missing',
        message: `${d.gapId}: ${d.itemId ? `item ${d.itemId} is not a non-dropped item of this plan` : `decision ${d.acceptedRiskDecisionId ?? '(none)'} does not exist on this plan`}`,
      };
    }
  }
  const anchor = reviews.get(input.dispositions[0].reviewId)!.activation_audit_seq;
  const [row] = await sql<Array<{ id: number | string }>>`
    INSERT INTO harness_shared.plan_blind_reviews
      (workspace_id, harness_slug, plan_slug, record_kind, activation_audit_seq, dispositions, summary, created_by)
    VALUES (${input.workspaceId}, ${facts.plan.harness_slug}, ${input.planSlug}, 'disposition', ${anchor},
            ${sql.json(input.dispositions as never)}, ${input.summary ?? null}, ${input.createdBy})
    RETURNING id`;
  return { ok: true, id: Number(row.id), activationAuditSeq: anchor, gapIds: input.dispositions.map((d) => d.gapId) };
}

/** Build the blind brief for the plan's latest activation audit, or null when there is none. */
export async function loadBlindReviewBrief(
  input: { workspaceId: string; planSlug: string; harnessSlug?: string | null },
  deps: { sql?: Sql } = {},
): Promise<BlindReviewBrief | null> {
  const sql = deps.sql ?? getOrgPg().sql;
  const facts = await readPlanFacts(sql, input.workspaceId, input.planSlug, input.harnessSlug);
  if (!facts?.activation) return null;
  const mappings = facts.activation.activation?.mappings ?? [];
  const refs = [...new Set(mappings.flatMap((m) => m.sourceRefs ?? []))];
  const turns = await fetchSourceTurns(sql as never, input.workspaceId, refs, BRIEF_TURN_CHARS);
  return buildBlindReviewBrief({
    planSlug: input.planSlug,
    activation: { auditSeq: facts.activation.audit_seq, mappings },
    turns,
  });
}

/**
 * decision-review.ts — the DECISION-REVIEW flavour of the shared consult cascade
 * (plan consult-backed-parking-2026-10-12; P-004 stance, P-005 park door, P-006
 * resolver).
 *
 * A product-decision park (`work_items:set_blocker`, D-001) opens a get_feedback
 * consult whose persisted routing carries `cascade.flavor = 'decision-review'`
 * plus the park's identity (work item, default action, deadline, owner-authority
 * topic). Like the grading flavour (grading-cascade.ts), the flavour rides on the
 * ROW, so every trigger — reply, decline, expiry sweep — can recognise a park
 * review without being told.
 *
 * This module is PURE (types, parsing, validation; no I/O) so the reply core, the
 * park door and the resolver can all import it without a module cycle.
 *
 * Stance rules (D-003 [owner]): a reviewer replies with support, object or
 * no-view. An objection must carry a reason AND a concrete alternative, unless it
 * is a hazard citing evidence, or an owner-authority topic (spend, destructive,
 * publish, credentials, security) — the two exceptions that may block without an
 * alternative.
 */

/** The persisted `routing.cascade.flavor` discriminator. */
export const DECISION_REVIEW_CASCADE_FLAVOR = 'decision-review';

/** D-003: the topics only the owner may decide; peers never resolve these to proceed (D-004). */
export const OWNER_AUTHORITY_TOPICS = ['spend', 'destructive', 'publish', 'credentials', 'security'] as const;
export type OwnerAuthorityTopic = (typeof OWNER_AUTHORITY_TOPICS)[number];

export const DECISION_REVIEW_POSITIONS = ['support', 'object', 'no-view'] as const;
export type DecisionReviewPosition = (typeof DECISION_REVIEW_POSITIONS)[number];

export const OBJECTION_BASES = ['alternative', 'hazard', 'owner-authority'] as const;
export type ObjectionBasis = (typeof OBJECTION_BASES)[number];

/** A reviewer's declared stance, as stored on consult_post_meta.stance (migration 1482). */
export type DecisionReviewStance =
  | { position: 'support' | 'no-view'; reason?: string }
  | { position: 'object'; basis: 'alternative'; reason: string; alternative: string }
  | { position: 'object'; basis: 'hazard'; reason: string; evidence: string[] }
  | { position: 'object'; basis: 'owner-authority'; topic: OwnerAuthorityTopic; reason?: string };

/** What a park writes on `routing.cascade` so any trigger can read the park's identity. */
export interface DecisionReviewCascadeMeta {
  flavor: typeof DECISION_REVIEW_CASCADE_FLAVOR;
  /** The parked work item (the blocker's subject). */
  workItemId: string;
  /** The agent that parked, and is woken with the verdict. */
  setterId: string;
  /** What the parker will do if nobody objects (D-002). */
  defaultAction: string;
  /** ISO instant at which silence resolves to proceed (D-002). */
  deadlineAt: string;
  /** Non-null ⇒ owner-authority park: it never resolves to proceed without the owner (R-14). */
  ownerAuthorityTopic: OwnerAuthorityTopic | null;
}

function parseRouting(routing: unknown): unknown {
  if (typeof routing !== 'string') return routing;
  try {
    return JSON.parse(routing);
  } catch {
    return null;
  }
}

/** The park identity on a persisted routing snapshot; null when the consult is not a decision review. */
export function decisionReviewMetaFromRouting(routing: unknown): DecisionReviewCascadeMeta | null {
  const snap = parseRouting(routing);
  const block = (snap as { cascade?: Partial<DecisionReviewCascadeMeta> | null } | null)?.cascade;
  if (!block || block.flavor !== DECISION_REVIEW_CASCADE_FLAVOR) return null;
  if (typeof block.workItemId !== 'string' || typeof block.setterId !== 'string') return null;
  if (typeof block.defaultAction !== 'string' || typeof block.deadlineAt !== 'string') return null;
  const topic = block.ownerAuthorityTopic;
  return {
    flavor: DECISION_REVIEW_CASCADE_FLAVOR,
    workItemId: block.workItemId,
    setterId: block.setterId,
    defaultAction: block.defaultAction,
    deadlineAt: block.deadlineAt,
    ownerAuthorityTopic: isOwnerAuthorityTopic(topic) ? topic : null,
  };
}

/** Is this routing snapshot a decision-review consult (flavour present, even if the meta is partial)? */
export function isDecisionReviewRouting(routing: unknown): boolean {
  const snap = parseRouting(routing);
  return (snap as { cascade?: { flavor?: unknown } | null } | null)?.cascade?.flavor === DECISION_REVIEW_CASCADE_FLAVOR;
}

export function isOwnerAuthorityTopic(v: unknown): v is OwnerAuthorityTopic {
  return typeof v === 'string' && (OWNER_AUTHORITY_TOPICS as readonly string[]).includes(v);
}

const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export type StanceValidation =
  | { ok: true; stance: DecisionReviewStance }
  | { ok: false; error: 'stance_required' | 'invalid_stance' | 'objection_basis_required'; hint: string };

const STANCE_SHAPE_HINT =
  "stance: { position:'support' | 'no-view', reason? } or an objection — " +
  "{ position:'object', basis:'alternative', reason, alternative } | " +
  "{ position:'object', basis:'hazard', reason, evidence:[refs] } | " +
  `{ position:'object', basis:'owner-authority', topic: ${OWNER_AUTHORITY_TOPICS.join('|')}, reason? }`;

/**
 * Validate a reviewer's stance on a decision-review consult (bars R-4, R-15).
 * Returns the NORMALIZED stance (trimmed strings, unknown keys dropped) so what is
 * stored is exactly what was validated.
 */
export function validateDecisionReviewStance(raw: unknown): StanceValidation {
  if (raw == null) {
    return {
      ok: false,
      error: 'stance_required',
      hint:
        'This consult is a decision review (a parked judgment call with a default and a deadline). ' +
        `Every reviewer reply must declare a stance — ${STANCE_SHAPE_HINT}. Silence means proceed at the deadline.`,
    };
  }
  if (typeof raw !== 'object') return { ok: false, error: 'invalid_stance', hint: STANCE_SHAPE_HINT };
  const s = raw as Record<string, unknown>;
  const reason = nonBlank(s.reason) ? s.reason.trim() : undefined;
  if (s.position === 'support' || s.position === 'no-view') {
    return { ok: true, stance: reason ? { position: s.position, reason } : { position: s.position } };
  }
  if (s.position !== 'object') {
    return { ok: false, error: 'invalid_stance', hint: `position must be one of ${DECISION_REVIEW_POSITIONS.join(', ')}. ${STANCE_SHAPE_HINT}` };
  }
  const objectionHint =
    'An objection must carry a reason with a concrete alternative (basis:"alternative"), a hazard citing evidence ' +
    '(basis:"hazard", evidence:[work-item ids, file paths, transcript refs]), or an owner-authority basis naming the ' +
    `topic (basis:"owner-authority", topic: ${OWNER_AUTHORITY_TOPICS.join('|')}). No alternative and no basis? Reply no-view instead.`;
  switch (s.basis) {
    case 'alternative':
      if (reason && nonBlank(s.alternative)) {
        return { ok: true, stance: { position: 'object', basis: 'alternative', reason, alternative: s.alternative.trim() } };
      }
      break;
    case 'hazard': {
      const evidence = Array.isArray(s.evidence) ? s.evidence.filter(nonBlank).map((e) => e.trim()) : [];
      if (reason && evidence.length > 0) {
        return { ok: true, stance: { position: 'object', basis: 'hazard', reason, evidence } };
      }
      break;
    }
    case 'owner-authority':
      if (isOwnerAuthorityTopic(s.topic)) {
        return {
          ok: true,
          stance: reason
            ? { position: 'object', basis: 'owner-authority', topic: s.topic, reason }
            : { position: 'object', basis: 'owner-authority', topic: s.topic },
        };
      }
      break;
    default:
      break;
  }
  return { ok: false, error: 'objection_basis_required', hint: objectionHint };
}

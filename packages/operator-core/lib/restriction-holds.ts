/**
 * restriction-holds — the structured record behind an agent- or owner-placed
 * restriction ("do not reinstall machine M", "do not recut the release").
 *
 * Plan one-work-graph-structured-holds-2026-10-26, P-010 (slice 1: the pure
 * model). Background: on the p2p endgame plan, restrictions written as prose in
 * work-item bodies, plan notes and handoff checkpoints froze progress for 11
 * days — nothing recorded who placed them, why, or when they should be looked
 * at again, so every successor obeyed them forever. A hold makes the
 * restriction a record:
 *
 *   - target   — WHAT it applies to, as a typed, shape-checked reference;
 *   - forbids  — WHICH action, from a fixed vocabulary (later mapped to tools);
 *   - reason   — WHY (the risk, or the evidence it protects);
 *   - placedBy — owner or agent (derived from turn provenance by the caller);
 *   - reviewAt — WHEN it must be looked at again, chosen by the placer
 *                (owner ruling 2026-10-26: no automatic default). Agent holds
 *                are capped at HOLD_AGENT_MAX_REVIEW_DAYS ahead (plan D-002);
 *                owner holds are uncapped.
 *
 * A hold whose reviewAt has passed is DUE, not released (owner ruling
 * 2026-10-26: idle time must never release anything). The next agent working
 * the plan reviews it — renew with a fresh reviewAt and a current reason, or
 * lift it. Lifting an owner hold needs the owner (R-6).
 *
 * This module is pure (no DB, no clock reads): callers pass `now`. Wiring into
 * work_items:set_blocker and get_next is later slices of P-010/P-011.
 */

export const HOLD_AGENT_MAX_REVIEW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REASON_CHARS = 2000;
const MAX_TARGET_ID_CHARS = 200;

/** Actions a hold can forbid. Fixed vocabulary — a free-text action is refused. */
export const HOLD_ACTIONS = [
  'reinstall',
  'reset',
  'rerun-test',
  'physical-run',
  'release-recut',
  'deploy',
  'migrate',
  'restart-service',
  'delete',
  'mutate',
] as const;
export type HoldAction = (typeof HOLD_ACTIONS)[number];

/**
 * The tools each forbidden action covers (plan D-014 item 6). P-010 only records
 * this mapping; refusing these tools at dispatch is P-012/P-014. Every name must
 * be a registered tool — restriction-holds.test.ts checks them against the
 * generated tool catalog.
 */
export const HOLD_ACTION_TOOLS: Readonly<Record<HoldAction, readonly string[]>> = {
  reinstall: ['provisioner:install', 'provisioner:plan_install'],
  reset: ['config:reset-overrides', 'accounts:reset-rate'],
  'rerun-test': ['testing:run', 'release:checkpoint-run'],
  'physical-run': ['blender:run-drill', 'session:carry-drill'],
  'release-recut': ['release:cut', 'release:checkpoint-run', 'release:repair-queue'],
  deploy: ['release:deploy', 'deploy:harness', 'deploy:pot'],
  migrate: ['db:migrate', 'harness:migrate-config-json'],
  'restart-service': ['dev:restart', 'processes:kill'],
  delete: ['artifacts:delete', 'rules:delete', 'personal:purge'],
  mutate: ['dev:pg_mutate', 'capability:edit', 'capability:write'],
};

/** What a hold can apply to. Each kind has an id shape check. */
export const HOLD_TARGET_KINDS = [
  'work-item',
  'plan',
  'decision',
  'agent',
  'machine',
  'release-build',
  'artifact',
] as const;
export type HoldTargetKind = (typeof HOLD_TARGET_KINDS)[number];

export type HoldPlacedBy = 'owner' | 'agent';

export interface HoldTarget {
  kind: HoldTargetKind;
  id: string;
}

export interface RestrictionHold {
  target: HoldTarget;
  forbids: HoldAction;
  reason: string;
  placedBy: HoldPlacedBy;
  /** Owner id / session id of whoever placed it. */
  placedById: string;
  /** For an owner hold: the verified owner turn that placed it (D-014 item 5). */
  ownerTurnRef?: string;
  placedAt: string;
  /** ISO timestamp the placer chose for the next review. */
  reviewAt: string;
  /** Optional event key that makes the hold due early (validated by the caller). */
  reviewWhen?: string;
  /** Prior reviews, oldest first. */
  reviews?: HoldReview[];
}

export interface HoldReview {
  at: string;
  byId: string;
  outcome: 'renewed' | 'lifted';
  reason: string;
  /** For a renewal: the new review date. */
  reviewAt?: string;
}

export interface HoldSpecInput {
  target?: { kind?: unknown; id?: unknown } | null;
  forbids?: unknown;
  reason?: unknown;
  reviewAt?: unknown;
  reviewWhen?: unknown;
}

export type HoldValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const TARGET_ID_PATTERNS: Record<HoldTargetKind, RegExp> = {
  'work-item': /^(?:WI|EI|F)-\d+$/,
  plan: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
  // Decisions are scoped: <plan-slug>#D-NNN (identifier-scope invariant).
  decision: /^[a-z0-9][a-z0-9-]*[a-z0-9]#D-\d{3,}$/,
  agent: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  machine: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  'release-build': /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/,
  artifact: /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/,
};

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function validateReviewAt(
  value: unknown,
  placedBy: HoldPlacedBy,
  now: Date,
  errors: string[],
): string | null {
  const reviewAt = parseIso(value);
  if (!reviewAt) {
    errors.push(
      'reviewAt is required: an ISO timestamp for when this hold must next be reviewed. There is no default — choose the date your reason may stop applying.',
    );
    return null;
  }
  if (reviewAt.getTime() <= now.getTime()) {
    errors.push('reviewAt must be in the future.');
    return null;
  }
  if (placedBy === 'agent' && reviewAt.getTime() - now.getTime() > HOLD_AGENT_MAX_REVIEW_DAYS * DAY_MS) {
    errors.push(
      `reviewAt is more than ${HOLD_AGENT_MAX_REVIEW_DAYS} days ahead; an agent-placed hold must be reviewed within ${HOLD_AGENT_MAX_REVIEW_DAYS} days (a due hold stays in force — the review only makes someone look at it).`,
    );
    return null;
  }
  return reviewAt.toISOString();
}

function validateReason(value: unknown, errors: string[]): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push('reason is required: the risk this hold prevents, or the evidence it preserves.');
    return null;
  }
  const reason = value.trim();
  if (reason.length > MAX_REASON_CHARS) {
    errors.push(`reason is longer than ${MAX_REASON_CHARS} characters.`);
    return null;
  }
  return reason;
}

/**
 * Validate a hold request. `placedBy` and `placedById` come from the caller's
 * verified identity/turn provenance, never from the request body.
 */
export function parseHoldSpec(
  input: HoldSpecInput,
  ctx: { now: Date; placedBy: HoldPlacedBy; placedById: string },
): HoldValidation<RestrictionHold> {
  const errors: string[] = [];

  const kind = input.target?.kind;
  const id = input.target?.id;
  let target: HoldTarget | null = null;
  if (!isOneOf(HOLD_TARGET_KINDS, kind)) {
    errors.push(`target.kind must be one of: ${HOLD_TARGET_KINDS.join(', ')}.`);
  } else if (typeof id !== 'string' || id.trim() === '' || id.trim().length > MAX_TARGET_ID_CHARS) {
    errors.push(`target.id is required (at most ${MAX_TARGET_ID_CHARS} characters).`);
  } else if (!TARGET_ID_PATTERNS[kind].test(id.trim())) {
    errors.push(`target.id "${id.trim()}" is not a valid ${kind} reference.`);
  } else {
    target = { kind, id: id.trim() };
  }

  const forbids = input.forbids;
  if (!isOneOf(HOLD_ACTIONS, forbids)) {
    errors.push(`forbids must be one of: ${HOLD_ACTIONS.join(', ')}.`);
  }

  const reason = validateReason(input.reason, errors);
  const reviewAt = validateReviewAt(input.reviewAt, ctx.placedBy, ctx.now, errors);

  let reviewWhen: string | undefined;
  if (input.reviewWhen !== undefined && input.reviewWhen !== null) {
    if (typeof input.reviewWhen !== 'string' || input.reviewWhen.trim() === '') {
      errors.push('reviewWhen, when given, must be a non-empty event key.');
    } else {
      reviewWhen = input.reviewWhen.trim();
    }
  }

  if (typeof ctx.placedById !== 'string' || ctx.placedById.trim() === '') {
    errors.push('placedById is required (derived from the caller identity).');
  }

  if (errors.length > 0 || !target || !reason || !reviewAt || !isOneOf(HOLD_ACTIONS, forbids)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      target,
      forbids,
      reason,
      placedBy: ctx.placedBy,
      placedById: ctx.placedById.trim(),
      placedAt: ctx.now.toISOString(),
      reviewAt,
      ...(reviewWhen ? { reviewWhen } : {}),
      reviews: [],
    },
  };
}

/**
 * A hold is DUE when its review date has passed or its reviewWhen event has
 * fired. A due hold is still in force; due only means "must be reviewed next".
 */
export function holdReviewState(
  hold: Pick<RestrictionHold, 'reviewAt'>,
  ctx: { now: Date; reviewWhenFired?: boolean },
): 'active' | 'due' {
  if (ctx.reviewWhenFired) return 'due';
  const reviewAt = parseIso(hold.reviewAt);
  if (!reviewAt) return 'due';
  return reviewAt.getTime() <= ctx.now.getTime() ? 'due' : 'active';
}

/** R-6: anyone may lift an agent hold; only the owner may lift an owner hold. */
export function canLiftHold(hold: Pick<RestrictionHold, 'placedBy'>, actor: HoldPlacedBy): boolean {
  return hold.placedBy === 'agent' || actor === 'owner';
}

/**
 * Renew a hold with a new review date and a CURRENT reason. Repeating the
 * previous reason verbatim is refused: a renewal must say why the hold still
 * applies now.
 */
export function renewHold(
  hold: RestrictionHold,
  input: { reviewAt: unknown; reason: unknown },
  ctx: { now: Date; actor: HoldPlacedBy; actorId: string },
): HoldValidation<RestrictionHold> {
  const errors: string[] = [];
  if (hold.placedBy === 'owner' && ctx.actor !== 'owner') {
    errors.push('only the owner can renew or lift an owner-placed hold.');
  }
  const reason = validateReason(input.reason, errors);
  const lastReason = hold.reviews?.length ? hold.reviews[hold.reviews.length - 1]!.reason : hold.reason;
  if (reason && reason.toLowerCase() === lastReason.trim().toLowerCase()) {
    errors.push('a renewal needs a current reason, not a repeat of the previous one: say why the hold still applies now.');
  }
  // The renewal cap follows the hold's placer: an agent hold stays capped even
  // when an owner renews it, so the owner can extend only their own holds freely.
  const reviewAt = validateReviewAt(input.reviewAt, hold.placedBy === 'owner' ? 'owner' : 'agent', ctx.now, errors);
  if (errors.length > 0 || !reason || !reviewAt) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...hold,
      reviewAt,
      reviews: [
        ...(hold.reviews ?? []),
        { at: ctx.now.toISOString(), byId: ctx.actorId, outcome: 'renewed', reason, reviewAt },
      ],
    },
  };
}

/** Record a lift. Refused when the actor may not lift this hold. */
export function liftHold(
  hold: RestrictionHold,
  input: { reason: unknown },
  ctx: { now: Date; actor: HoldPlacedBy; actorId: string },
): HoldValidation<RestrictionHold> {
  const errors: string[] = [];
  if (!canLiftHold(hold, ctx.actor)) errors.push('only the owner can renew or lift an owner-placed hold.');
  const reason = validateReason(input.reason, errors);
  if (errors.length > 0 || !reason) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...hold,
      reviews: [...(hold.reviews ?? []), { at: ctx.now.toISOString(), byId: ctx.actorId, outcome: 'lifted', reason }],
    },
  };
}

/** True once the most recent review lifted the hold. */
export function isHoldLifted(hold: Pick<RestrictionHold, 'reviews'>): boolean {
  const last = hold.reviews?.[hold.reviews.length - 1];
  return last?.outcome === 'lifted';
}

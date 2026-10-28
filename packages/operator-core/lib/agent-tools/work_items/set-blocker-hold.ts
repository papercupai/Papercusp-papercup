/**
 * set-blocker-hold — placement and lift checks for `work_items:set_blocker { kind:'hold' }`.
 *
 * Plan one-work-graph-structured-holds-2026-10-26, P-010 slice 2, shaped by #D-014:
 *   - the hold is one `hold`-kind row (capability `restriction-hold`) in the carrier
 *     work-item's externalBlockers, carrying the parsed RestrictionHold;
 *   - its ref is derived, `hold:<target.kind>:<target.id>:<forbids>`, so re-asserting upserts;
 *   - the placer is the caller's coord identity; placedBy is 'owner' only when
 *     ownerTurnRef verifies against the caller's transcript chain (the #D-012 resolver);
 *   - the target must resolve at placement (work-item, plan, decision, agent);
 *     machine / release-build / artifact are format-checked only (#D-002 item 2).
 * Review is not expiry: the row's recheckAt is the hold's reviewAt, and the reaper never
 * clears a hold row (D-014 item 2).
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { canLiftHold, parseHoldSpec, type HoldTarget, type RestrictionHold } from '../../restriction-holds';
import {
  OWNER_TURN_REF_MAX,
  provenanceFromOwnerTurnRef,
  resolveDecisionProvenance,
  type DecisionProvenanceDeps,
} from '../plans/decision-provenance-record';
import { admitWaitRef } from '../../wait-ref-admission';

/** The `hold` argument. Values are checked by parseHoldSpec so a refusal names the vocabulary. */
export const holdArg = z
  .object({
    target: z.object({ kind: z.string(), id: z.string() }).strict(),
    forbids: z.string(),
    reviewAt: z.string(),
    reviewWhen: z.string().optional(),
  })
  .strict();
export type HoldArg = z.infer<typeof holdArg>;

export const ownerTurnRefField = z.string().max(OWNER_TURN_REF_MAX);

export function holdBlockerRef(hold: Pick<RestrictionHold, 'target' | 'forbids'>): string {
  return `hold:${hold.target.kind}:${hold.target.id}:${hold.forbids}`;
}

/**
 * Does the target exist in this workspace? Kinds without a registry are format-checked
 * by parseHoldSpec only and resolve true here. Same pool as the other work_items tools
 * (getOrgPg), scoped by an explicit workspace_id predicate on every query.
 */
export async function holdTargetExists(workspaceId: string, target: HoldTarget): Promise<boolean> {
  if (target.kind === 'machine' || target.kind === 'release-build' || target.kind === 'artifact') return true;
  const { sql } = getOrgPg();
  let rows: readonly unknown[];
  if (target.kind === 'work-item') {
    rows = await sql`SELECT 1 FROM harness_shared.work_items
      WHERE workspace_id = ${workspaceId} AND feature_id = ${target.id} LIMIT 1`;
  } else if (target.kind === 'plan') {
    rows = await sql`SELECT 1 FROM harness_shared.harness_plans
      WHERE workspace_id = ${workspaceId} AND plan_slug = ${target.id} LIMIT 1`;
  } else if (target.kind === 'decision') {
    const [planSlug, decisionId] = target.id.split('#');
    rows = await sql`SELECT 1 FROM harness_shared.plan_decisions
      WHERE workspace_id = ${workspaceId} AND plan_slug = ${planSlug} AND decision_id = ${decisionId} LIMIT 1`;
  } else {
    rows = await sql`SELECT 1 FROM harness_shared.coord_presence
      WHERE workspace_id = ${workspaceId} AND owner_id = ${target.id} LIMIT 1`;
  }
  return rows.length > 0;
}

export interface HoldPlacementDeps {
  now?: () => Date;
  targetExists?: (workspaceId: string, target: HoldTarget) => Promise<boolean>;
  provenance?: DecisionProvenanceDeps;
  admitReviewWhen?: (ref: string) => Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
}

export type HoldRefusal = { ok: false; code: string; error: string; field?: string };
export type PreparedHold = { ok: true; hold: RestrictionHold; ref: string } | HoldRefusal;

/** Validate a hold placement. Every refusal means nothing was written. */
export async function prepareHoldPlacement(
  input: { workspaceId: string; hold?: HoldArg; reason?: string; ownerTurnRef?: string; ctx: unknown },
  deps: HoldPlacementDeps = {},
): Promise<PreparedHold> {
  if (!input.hold) {
    return {
      ok: false,
      code: 'hold_spec_required',
      field: 'hold',
      error: "kind 'hold' needs hold:{ target:{kind,id}, forbids, reviewAt } with summary as the reason.",
    };
  }
  const provenance = await resolveDecisionProvenance(
    provenanceFromOwnerTurnRef(input.ownerTurnRef),
    input.reason ?? '',
    input.ctx,
    deps.provenance,
  );
  if (!provenance.ok) {
    return { ok: false, code: provenance.error, field: provenance.field, error: `hold placer: ${provenance.message}` };
  }
  const parsed = parseHoldSpec(
    { ...input.hold, reason: input.reason },
    {
      now: (deps.now ?? (() => new Date()))(),
      placedBy: provenance.provenance.kind,
      placedById: provenance.provenance.agentId,
    },
  );
  if (!parsed.ok) return { ok: false, code: 'hold_spec_invalid', field: 'hold', error: parsed.errors.join(' ') };

  const target = parsed.value.target;
  let exists: boolean;
  try {
    exists = await (deps.targetExists ?? holdTargetExists)(input.workspaceId, target);
  } catch (err) {
    // Fail closed: an unverifiable target is not a resolved one.
    return {
      ok: false,
      code: 'hold_target_unverifiable',
      field: 'hold.target',
      error: `could not check ${target.kind} '${target.id}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!exists) {
    return {
      ok: false,
      code: 'hold_target_unresolved',
      field: 'hold.target',
      error: `${target.kind} '${target.id}' does not exist in workspace '${input.workspaceId}'. A hold must name something real.`,
    };
  }

  if (parsed.value.reviewWhen) {
    const admit =
      deps.admitReviewWhen ?? ((ref: string) => admitWaitRef(ref, { surface: 'blocker' }));
    const admission = await admit(parsed.value.reviewWhen);
    if (!admission.ok) {
      return { ok: false, code: admission.code, field: 'hold.reviewWhen', error: `reviewWhen refused — ${admission.detail}` };
    }
  }

  const hold: RestrictionHold =
    provenance.provenance.kind === 'owner'
      ? { ...parsed.value, ownerTurnRef: provenance.provenance.ownerTurnRef }
      : parsed.value;
  return { ok: true, hold, ref: holdBlockerRef(hold) };
}

/**
 * May this caller clear (lift) a hold row? An agent hold lifts freely; an owner hold needs
 * a verified owner turn (R-6). P-011 adds the review verbs; this keeps set_blocker's clear
 * from bypassing the rule meanwhile.
 */
export async function checkHoldLift(
  hold: RestrictionHold | undefined,
  input: { ownerTurnRef?: string; ctx: unknown },
  deps: Pick<HoldPlacementDeps, 'provenance'> = {},
): Promise<{ ok: true } | HoldRefusal> {
  if (!hold || canLiftHold(hold, 'agent')) return { ok: true };
  if (input.ownerTurnRef === undefined) {
    return {
      ok: false,
      code: 'hold_owner_lift_requires_owner',
      field: 'ownerTurnRef',
      error: 'This hold was placed by the owner; lifting it needs ownerTurnRef naming the owner turn that lifts it.',
    };
  }
  const provenance = await resolveDecisionProvenance(
    provenanceFromOwnerTurnRef(input.ownerTurnRef),
    '',
    input.ctx,
    deps.provenance,
  );
  if (!provenance.ok) {
    return { ok: false, code: provenance.error, field: provenance.field, error: `hold lift: ${provenance.message}` };
  }
  return canLiftHold(hold, provenance.provenance.kind)
    ? { ok: true }
    : { ok: false, code: 'hold_owner_lift_requires_owner', field: 'ownerTurnRef', error: 'Only the owner can lift an owner hold.' };
}

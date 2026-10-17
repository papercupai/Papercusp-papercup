/**
 * claim-discipline.ts — claim-before-work, wired into the calls agents already
 * make (plan claim-discipline-enforcement-2026-06-10).
 *
 * The fleet held ZERO plan-item claims while 18+ agents worked declared plans
 * (2026-06-10 audit): the lease store works, but claiming was a separate,
 * optional chore — and optional coordination steps don't happen. The file-lock
 * lesson applied: discipline enforced at the moment of action is followed;
 * discipline documented as convention is not. Three thin compositions over the
 * existing stores put the claim ON the action:
 *
 *   - `claimForWork` — flipping an item to `wip` claims it first; a live peer's
 *     claim REJECTS the flip (the collision the lease exists to stop).
 *   - `releaseOwnClaim` — a terminal flip (done/dropped) releases the caller's
 *     claim: a finished item is held by no one (owner decision, 2026-06-10 —
 *     done never auto-claims).
 *   - `reconcileDeclaredClaims` — coord:declare-intent `items` claims the
 *     declared lane and releases the caller's other claims in that plan, so one
 *     call = presence + structured lane (replacing prose-intent lanes).
 *
 * POLICY (assignment anchoring, work-group gating) stays in liveness.ts
 * (`claimPlanItem`) — this module only decides WHEN those verbs fire.
 */
import { getClaim, listClaimsForPlan, releaseClaim } from './claims';
import { claimPlanItem, type LinkedClaimHold } from './liveness';

export interface ClaimForWorkOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  ownerUser: string;
  intent?: string;
}

/**
 * Release the execution record that implements a plan item when the same owner
 * explicitly releases that plan item's live claim.
 *
 * Plan-item leases and work-item claims are separate stores. Releasing only the
 * lease leaves a linked work item assigned to the former holder, so the next
 * claimant can own the plan lane but still be refused by work_items:checkpoint
 * as `not_holder`. The owner check below is deliberate: a linked record held by
 * another agent is their independent work and must never be released as a side
 * effect of this lane's release.
 *
 * This is best-effort by contract. The plan claim has already been released when
 * callers invoke this helper; a failed linked release leaves the former holder
 * with a recoverable work-item claim rather than exposing it to a peer.
 */
export async function releaseLinkedWorkItemForPlanItem(
  planSlug: string,
  itemId: string,
  owner: string,
): Promise<boolean> {
  if (!owner) return false;
  try {
    const [{ findImplementingWorkItem, TERMINAL_WORK_ITEM_STATES }, { releaseWorkItem }] = await Promise.all([
      import('./convert'),
      import('../work-items'),
    ]);
    const workItem = await findImplementingWorkItem(planSlug, itemId);
    if (!workItem || TERMINAL_WORK_ITEM_STATES.has(workItem.state) || workItem.assignee !== owner) return false;
    return Boolean(
      await releaseWorkItem(workItem.id, {
        harness: workItem.harness ?? undefined,
        expectedAssignee: owner,
        releasingOwnerId: owner,
      }),
    );
  } catch {
    return false;
  }
}

export type ClaimForWorkOutcome =
  | { ok: true; claimId: string; alreadyHeld: boolean }
  | {
      ok: false;
      reason: string;
      holder?: { owner: string; ownerLabel: string | null; intent: string; expiresTs: string };
      claimHold?: LinkedClaimHold;
    };

/**
 * Take (or confirm) the live claim on an item the caller is starting. The
 * caller's own live claim short-circuits ok; a live peer claim or an
 * assignment-policy refusal comes back ok:false with the holder so the caller
 * can surface WHO has it (mirroring the file-lock busy payload).
 */
export async function claimForWork(opts: ClaimForWorkOpts): Promise<ClaimForWorkOutcome> {
  const existing = await getClaim(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);
  if (existing && !existing.expired && existing.owner === opts.owner) {
    return { ok: true, claimId: existing.claimId, alreadyHeld: true };
  }
  const res = await claimPlanItem({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    itemId: opts.itemId,
    owner: opts.owner,
    ownerLabel: opts.ownerLabel ?? null,
    ownerName: opts.ownerName ?? null,
    ownerUser: opts.ownerUser,
    ...(opts.intent ? { intent: opts.intent } : {}),
  });
  if (res.status === 'claimed') {
    return { ok: true, claimId: res.claim.claimId, alreadyHeld: false };
  }
  if (res.status === 'conflict') {
    return {
      ok: false,
      reason: `claimed by ${res.conflict.ownerLabel ?? res.conflict.owner} — coordinate with the holder or pick another item`,
      holder: {
        owner: res.conflict.owner,
        ownerLabel: res.conflict.ownerLabel,
        intent: res.conflict.intent,
        expiresTs: res.conflict.expiresTs,
      },
    };
  }
  return {
    ok: false,
    reason: res.reason,
    ...(res.claimHold ? { claimHold: res.claimHold } : {}),
  };
}

/**
 * Release the caller's own claim on an item (terminal flips). A peer's claim is
 * left alone — releasing someone else's live lease is never this seam's call;
 * it lapses on its own TTL. Returns whether a release actually happened.
 */
export async function releaseOwnClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
  owner: string,
): Promise<boolean> {
  const current = await getClaim(workspaceId, harnessSlug, planSlug, itemId);
  if (!current || current.owner !== owner) return false;
  const released = await releaseClaim(workspaceId, harnessSlug, planSlug, itemId, current.claimId, owner);
  if (released) await releaseLinkedWorkItemForPlanItem(planSlug, itemId, owner);
  return released;
}

export interface ReconcileDeclaredClaimsOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** The declared lane — the FULL set of items the caller is working. */
  items: string[];
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  ownerUser: string;
  intent?: string;
}

export interface ReconcileDeclaredClaimsResult {
  claimed: string[];
  alreadyHeld: string[];
  conflicts: Array<{ item: string; reason: string; holder?: string }>;
  released: string[];
}

/**
 * Make the caller's claims in a plan match its declared lane: claim every item
 * in `items`, release the caller's live claims on items NOT in it. An empty
 * `items` releases the whole lane. Per-item conflicts are reported, never
 * thrown — declaring intent must always succeed even when part of the lane is
 * contested.
 */
export async function reconcileDeclaredClaims(
  opts: ReconcileDeclaredClaimsOpts,
): Promise<ReconcileDeclaredClaimsResult> {
  const result: ReconcileDeclaredClaimsResult = {
    claimed: [],
    alreadyHeld: [],
    conflicts: [],
    released: [],
  };
  const wanted = new Set(opts.items);
  for (const item of wanted) {
    const outcome = await claimForWork({ ...opts, itemId: item });
    if (outcome.ok) {
      (outcome.alreadyHeld ? result.alreadyHeld : result.claimed).push(item);
    } else {
      result.conflicts.push({
        item,
        reason: outcome.reason,
        ...(outcome.holder ? { holder: outcome.holder.ownerLabel ?? outcome.holder.owner } : {}),
      });
    }
  }
  const mine = (await listClaimsForPlan(opts.workspaceId, opts.harnessSlug, opts.planSlug)).filter(
    (c) => c.owner === opts.owner && !c.expired && !wanted.has(c.itemId),
  );
  for (const c of mine) {
    const released = await releaseClaim(
      opts.workspaceId,
      opts.harnessSlug,
      opts.planSlug,
      c.itemId,
      c.claimId,
      opts.owner,
    );
    if (released) {
      result.released.push(c.itemId);
      await releaseLinkedWorkItemForPlanItem(opts.planSlug, c.itemId, opts.owner);
    }
  }
  return result;
}

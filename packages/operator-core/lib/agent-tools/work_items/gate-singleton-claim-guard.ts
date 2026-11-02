/**
 * gate-singleton-claim-guard — green-main-cycle-time-2026-10-08 P-013, D-028(4).
 *
 * A red gate's two condition singletons — `gate-red-streak:<harness>` ("the gate is red, own
 * it") and `frozen-repair-convergence:<pipeline>` ("the frozen queue is not converging") — are
 * the items a multi-day red is OWNED through. Measured before this guard: WI-10006055 went
 * through 48 claimants. Each one claimed by id, worked one turn, ended the turn with no
 * re-wake armed, and the claim lapsed into the next relay leg. A claim that cannot outlive
 * its own turn is not ownership.
 *
 * So a by-id claim of either singleton is refused unless the CLAIMANT (the assignee the item
 * would land on, not necessarily the caller) has a guaranteed re-wake. That is the verdict
 * `loop:status` reports as `rewake.rewakeGuaranteed`: `classifyLoopNextWake` over the
 * claimant's loop row and its measured wake reachability. Sharing that classifier means the
 * guard and `loop:status` cannot disagree about whether an owner will be woken again.
 *
 * This re-wake guard does not cover per-leg items or `release:repair-queue admit`.
 * That does not grant gate authority: current-run leg triage/admission belongs to the live
 * gate owner (gate-systems-as-designed-2026-10-27 D-010). Independent source work remains
 * available under its own work-item and locks; the refusal preserves that distinction.
 *
 * Exempt: `system:*` identities. A routine identity is re-run by its own schedule rather than
 * by a loop row, so the loop verdict does not describe it; D-028(4) requires that exemption to
 * be explicit, which is this constant.
 *
 * Read failures: an unreadable condition key skips the guard (the same advisory stance
 * work_items:complete takes on that column; nearly every item is unguarded). An unreadable
 * re-wake verdict on a GUARDED item refuses, because granting a singleton on an unknown
 * verdict is the exact relay this guard exists to stop; the hint says to retry.
 */
import type { LoopNextWakeVerdict } from '../loop/next-wake';
import { GATE_RED_STREAK_CONDITION_PREFIX } from '../../work-items-admission';
import { FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX } from '../../coord/actionable-conditions';

/** Condition-key prefixes whose singleton may only be claimed by a long-lived owner. */
export const LONG_LIVED_OWNER_CONDITION_PREFIXES: readonly string[] = [
  GATE_RED_STREAK_CONDITION_PREFIX,
  FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
];

/** Claimant prefix exempt from the guard: routine identities re-run on their own schedule. */
export const GATE_SINGLETON_EXEMPT_CLAIMANT_PREFIX = 'system:';

export function requiresLongLivedOwner(conditionKey: string | null | undefined): boolean {
  if (typeof conditionKey !== 'string' || !conditionKey) return false;
  return LONG_LIVED_OWNER_CONDITION_PREFIXES.some((prefix) => conditionKey.startsWith(prefix));
}

export interface GateSingletonClaimRefusal {
  error: 'gate_singleton_requires_long_lived_owner';
  conditionKey: string;
  claimant: string;
  /** Why the re-wake is not guaranteed; `rewake-unverifiable` when the verdict could not be read. */
  rewakeReason: string;
  hint: string;
}

export interface GateSingletonClaimInput {
  conditionKey: string | null | undefined;
  claimant: string;
  /** The claimant's re-wake verdict; null when it could not be read. */
  rewake: LoopNextWakeVerdict | null;
}

/** Pure decision. `null` means the claim may proceed as far as this guard is concerned. */
export function assessGateSingletonClaim(input: GateSingletonClaimInput): GateSingletonClaimRefusal | null {
  const conditionKey = input.conditionKey;
  if (!requiresLongLivedOwner(conditionKey)) return null;
  if (input.claimant.startsWith(GATE_SINGLETON_EXEMPT_CLAIMANT_PREFIX)) return null;
  if (input.rewake?.guaranteed === true) return null;
  const rewakeReason = input.rewake ? input.rewake.reason : 'rewake-unverifiable';
  const key = conditionKey as string;
  return {
    error: 'gate_singleton_requires_long_lived_owner',
    conditionKey: key,
    claimant: input.claimant,
    rewakeReason,
    hint:
      `${key} is a gate-red singleton: its holder owns a red gate across turns, so it can only be ` +
      `claimed by an owner with a guaranteed re-wake. ${input.claimant} has none (${rewakeReason}). ` +
      (rewakeReason === 'rewake-unverifiable'
        ? 'The re-wake verdict could not be read; retry the claim. '
        : 'Arm one first with loop:arm { intervalSec, goal } (check loop:status rewake.rewakeGuaranteed), then claim again. ') +
      "Read state:read { cell: 'gate.greenCheckpoint.ownership' } before current-run work. " +
      'Current-run frozen-repair-leg: triage and release:repair-queue admission belong to the live gate owner. ' +
      'When another live agent holds it, send useful evidence once and stop current-run operations. ' +
      'Independently registered source work may proceed under its own work-item and file locks; ' +
      'send the verified patch to the gate owner for admission. The claim was refused before mutation (D-028(4)).',
  };
}

export interface GateSingletonClaimReader {
  /** The item's condition_key, null when it has none. Throws when unreadable. */
  readConditionKey(id: string, harness: string | undefined): Promise<string | null>;
  /** The claimant's re-wake verdict, the one loop:status reports. Throws when unreadable. */
  readRewake(claimant: string): Promise<LoopNextWakeVerdict>;
}

/** Production reader: the same reads loop:status composes, plus one indexed condition_key read. */
export function defaultGateSingletonClaimReader(workspaceId: string): GateSingletonClaimReader {
  return {
    async readConditionKey(id, harness) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const rows = (await getOrgPg().sql.unsafe(
        harness
          ? `SELECT condition_key FROM harness_shared.work_items
              WHERE feature_id = $1 AND workspace_id = $2 AND harness_slug = $3 LIMIT 1`
          : `SELECT condition_key FROM harness_shared.work_items
              WHERE feature_id = $1 AND workspace_id = $2 LIMIT 1`,
        harness ? [id, workspaceId, harness] : [id, workspaceId],
      )) as unknown;
      const key = Array.isArray(rows) ? (rows[0] as { condition_key?: unknown } | undefined)?.condition_key : null;
      return typeof key === 'string' && key ? key : null;
    },
    async readRewake(claimant) {
      const [{ getLoopStatus }, { probeWakeReachability }, { classifyLoopNextWake }] = await Promise.all([
        import('../../harness/routines/loop'),
        import('../../events/await/wake-reachability'),
        import('../loop/next-wake'),
      ]);
      const [loop, reachability] = await Promise.all([
        getLoopStatus(claimant),
        probeWakeReachability(claimant).catch(() => null),
      ]);
      return classifyLoopNextWake(loop, Date.now(), reachability?.reachable);
    },
  };
}

/**
 * IO wrapper used by work_items:claim. Reads the condition key first, so an ordinary item
 * costs one indexed read and never touches the loop store.
 */
export async function checkGateSingletonClaim(
  args: { id: string; harness: string | undefined; claimant: string },
  reader: GateSingletonClaimReader,
): Promise<GateSingletonClaimRefusal | null> {
  let conditionKey: string | null;
  try {
    conditionKey = await reader.readConditionKey(args.id, args.harness);
  } catch {
    return null;
  }
  if (!requiresLongLivedOwner(conditionKey)) return null;
  if (args.claimant.startsWith(GATE_SINGLETON_EXEMPT_CLAIMANT_PREFIX)) return null;
  let rewake: LoopNextWakeVerdict | null;
  try {
    rewake = await reader.readRewake(args.claimant);
  } catch {
    rewake = null;
  }
  return assessGateSingletonClaim({ conditionKey, claimant: args.claimant, rewake });
}

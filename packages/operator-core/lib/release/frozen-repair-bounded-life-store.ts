/**
 * P-021 (green-main-cycle-time-2026-10-08, D-023): storage for the frozen repair queue's bounded
 * life. The decision is PURE (`./frozen-repair-bounded-life`); this module applies it atomically.
 *
 * The bounded-life state lives in the gate routine's metadata under
 * `FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY`, BESIDE `repair_queue` rather than inside it, because
 * retiring the queue deletes `repair_queue` and the 24h rate limit must outlive that. The retire
 * and the record are ONE row update under the routine row lock: the rate limit, the queue
 * identity and the fixer's liveness are all re-checked against the locked row, so two gate hosts
 * cannot both retire inside one window and a retirement can never land without its record.
 *
 * Kept separate from `release-actions.ts`' owner retire (`retireFrozenCandidateRepairQueue`),
 * whose policy D-023 leaves unchanged: that verb retires only `awaiting-fixer`/`blocked` queues on
 * an operator's exact request; this rule is the gate's own, bounded by the decision module.
 */
import type { GateVerdictTarget } from './gate-verdict-target';
import {
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import { releaseFixerSpawnAlive } from './fixer-liveness';
import {
  decideFrozenRepairBoundedLife,
  frozenRepairBoundedLifeStateAfterEscalation,
  frozenRepairBoundedLifeStateAfterRetire,
  parseFrozenRepairBoundedLifeState,
  type FrozenRepairBoundedLifeDeferral,
  type FrozenRepairBoundedLifeEscalation,
  type FrozenRepairBoundedLifeRecord,
  type FrozenRepairBoundedLifeState,
} from './frozen-repair-bounded-life';
import { FROZEN_REPAIR_CARRY_METADATA_KEY, nextFrozenRepairPendingCarry } from './frozen-repair-carry';

export const FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY = 'repair_queue_bounded_life';

export type FrozenRepairBoundedLifeRetireRefusal =
  | 'identity-mismatch'
  | 'within-bounds'
  | 'rate-limited'
  | 'live-fixer'
  | 'liveness-unknown'
  | FrozenRepairBoundedLifeDeferral;

export interface FrozenRepairBoundedLifeRetireResult {
  retired: boolean;
  refusal?: FrozenRepairBoundedLifeRetireRefusal;
}

/** Some pg client paths hand `routines.metadata` back as a JSON string (EI-22026318885195355). */
function decodeMetadata(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readFrozenRepairBoundedLifeState(
  target: GateVerdictTarget,
): Promise<FrozenRepairBoundedLifeState | null> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'${FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY}' AS state
       FROM harness_shared.routines
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'`,
    [target.workspaceId, target.installSlug],
  )) as Array<{ state: unknown }>;
  return parseFrozenRepairBoundedLifeState(rows[0]?.state);
}

/**
 * Retire `expectedQueue` and persist `record`, atomically, iff the locked row still holds that
 * exact queue, the bounded-life decision (re-run against the locked row and its state) still
 * says `retire`, and the queue's fixer is provably not alive.
 */
export async function retireFrozenRepairQueueForBoundedLife(
  target: GateVerdictTarget,
  expectedQueue: FrozenCandidateRepairQueue,
  record: FrozenRepairBoundedLifeRecord,
): Promise<FrozenRepairBoundedLifeRetireResult> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const result = await sql.begin(async (tx): Promise<FrozenRepairBoundedLifeRetireResult> => {
    const lockedRows = (await tx.unsafe(
      `SELECT metadata
         FROM harness_shared.routines
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'
        FOR UPDATE`,
      [target.workspaceId, target.installSlug],
    )) as Array<{ metadata?: unknown }>;
    const metadata = decodeMetadata(lockedRows[0]?.metadata);
    const current = parseFrozenCandidateRepairQueue(metadata?.repair_queue);
    if (
      !current ||
      current.candidate !== expectedQueue.candidate ||
      current.repairHead !== expectedQueue.repairHead ||
      current.updatedAtMs !== expectedQueue.updatedAtMs ||
      current.fixerSpawnId !== expectedQueue.fixerSpawnId
    ) {
      return { retired: false, refusal: 'identity-mismatch' };
    }
    const state = parseFrozenRepairBoundedLifeState(metadata?.[FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY]);
    const decision = decideFrozenRepairBoundedLife(current, { nowMs: record.retiredAtMs, state });
    if (decision.kind === 'within-bounds') return { retired: false, refusal: 'within-bounds' };
    if (decision.kind === 'rate-limited') return { retired: false, refusal: 'rate-limited' };
    if (decision.kind === 'deferred') return { retired: false, refusal: decision.reason };
    // The ONE liveness definition, sampled while the row is locked (same as the owner retire).
    const fixerAlive = current.fixerSpawnId
      ? await releaseFixerSpawnAlive(tx, current.fixerSpawnId)
      : null;
    if (current.fixerSpawnId && fixerAlive !== false) {
      return { retired: false, refusal: fixerAlive === true ? 'live-fixer' : 'liveness-unknown' };
    }
    const nextState = frozenRepairBoundedLifeStateAfterRetire(state, record);
    // P-010 (D-026): the retired queue's admitted fixes, carried into the next fresh cut.
    const pendingCarry = nextFrozenRepairPendingCarry(
      metadata?.[FROZEN_REPAIR_CARRY_METADATA_KEY],
      current,
      'bounded-life',
      record.retiredAtMs,
    );
    const rows = (await tx.unsafe(
      // Same teardown as the owner retire (P-013 convergence + repair inconclusive cleared),
      // plus the bounded-life record and the pending carry in the SAME write.
      `UPDATE harness_shared.routines
          SET metadata = ((CASE
                WHEN metadata #>> '{gate_health,inconclusive,status}'
                       IN ('repair-in-progress', 'repair-staging-mismatch')
                  THEN (COALESCE(metadata, '{}'::jsonb) - 'repair_queue')
                       #- '{gate_health,inconclusive}'
                ELSE COALESCE(metadata, '{}'::jsonb) - 'repair_queue'
              END) #- '{gate_health,convergence}')
              || jsonb_build_object('${FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY}', $7::jsonb)
              || CASE WHEN $8::jsonb IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('${FROZEN_REPAIR_CARRY_METADATA_KEY}', $8::jsonb) END,
              updated_at = now()
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'
          AND metadata->'repair_queue'->>'candidate' = $3::text
          AND metadata->'repair_queue'->>'repairHead' = $4::text
          AND metadata->'repair_queue'->'updatedAtMs' = to_jsonb($5::bigint)
          AND metadata->'repair_queue'->>'fixerSpawnId' IS NOT DISTINCT FROM $6::text
        RETURNING true AS retired`,
      [
        target.workspaceId,
        target.installSlug,
        expectedQueue.candidate,
        expectedQueue.repairHead,
        expectedQueue.updatedAtMs,
        expectedQueue.fixerSpawnId,
        JSON.stringify(nextState),
        pendingCarry ? JSON.stringify(pendingCarry) : null,
      ],
    )) as Array<{ retired: boolean }>;
    return rows[0]?.retired === true
      ? { retired: true }
      : { retired: false, refusal: 'identity-mismatch' };
  });
  if (result.retired) {
    // P-004: the edit-time marker names the retired candidate; drop it with the queue.
    const { projectFrozenRepairMarker } = await import('./frozen-repair-edit-marker');
    projectFrozenRepairMarker(null, target);
  }
  return result;
}

/** Record that a rate-limited trigger was escalated, so the next tick does not escalate again. */
export async function recordFrozenRepairBoundedLifeEscalation(
  target: GateVerdictTarget,
  escalation: FrozenRepairBoundedLifeEscalation,
): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  await sql.begin(async (tx) => {
    const lockedRows = (await tx.unsafe(
      `SELECT metadata->'${FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY}' AS state
         FROM harness_shared.routines
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'
        FOR UPDATE`,
      [target.workspaceId, target.installSlug],
    )) as Array<{ state: unknown }>;
    if (lockedRows.length === 0) return;
    const nextState = frozenRepairBoundedLifeStateAfterEscalation(
      parseFrozenRepairBoundedLifeState(lockedRows[0]?.state),
      escalation,
    );
    await tx.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('${FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY}', $3::jsonb),
              updated_at = now()
        WHERE workspace_id = $1
          AND install_slug = $2
          AND target_role = 'system:green-checkpoint'`,
      [target.workspaceId, target.installSlug, JSON.stringify(nextState)],
    );
  });
}

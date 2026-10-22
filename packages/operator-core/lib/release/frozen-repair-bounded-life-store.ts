/** Historical bounded-life telemetry. Automatic retirement is forbidden by D-090. */
import type { GateVerdictTarget } from './gate-verdict-target';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import {
  frozenRepairBoundedLifeStateAfterEscalation,
  parseFrozenRepairBoundedLifeState,
  type FrozenRepairBoundedLifeDeferral,
  type FrozenRepairBoundedLifeEscalation,
  type FrozenRepairBoundedLifeRecord,
  type FrozenRepairBoundedLifeState,
} from './frozen-repair-bounded-life';

export const FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY = 'repair_queue_bounded_life';

export type FrozenRepairBoundedLifeRetireRefusal =
  | 'automatic-retirement-disabled'
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

/** Compatibility entry point for old callers: never opens a transaction or clears a queue. */
export async function retireFrozenRepairQueueForBoundedLife(
  _target: GateVerdictTarget,
  _expectedQueue: FrozenCandidateRepairQueue,
  _record: FrozenRepairBoundedLifeRecord,
): Promise<FrozenRepairBoundedLifeRetireResult> {
  return { retired: false, refusal: 'automatic-retirement-disabled' };
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

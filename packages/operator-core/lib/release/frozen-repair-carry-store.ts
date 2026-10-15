/**
 * P-010 (green-main-cycle-time-2026-10-08, D-026/D-027): storage for the frozen repair CARRY.
 * The check is PURE (`./frozen-repair-carry`); the WRITE of a pending carry happens inside each
 * retire's own locked row update (`retireFrozenRepairQueueForBoundedLife` in
 * `./frozen-repair-bounded-life-store`, `retireFrozenCandidateRepairQueue` in
 * `../harness/routines/release-actions`). This module owns the gate's two halves: reading the
 * pending carry at a fresh cut, and consuming it.
 *
 * Consuming is a compare-and-swap on the pending carry's identity (`fromCandidate` +
 * `retiredAtMs`): a retire that lands between the gate's read and its consume replaces the
 * pending carry, the swap misses, and the NEXT fresh cut assesses the newer carry — the newer
 * retire is never silently consumed by an assessment that did not include it.
 */
import type { GateVerdictTarget } from './gate-verdict-target';
import {
  FROZEN_REPAIR_CARRY_LAST_METADATA_KEY,
  FROZEN_REPAIR_CARRY_METADATA_KEY,
  parseFrozenRepairPendingCarry,
  type FrozenRepairCarryRecord,
  type FrozenRepairPendingCarry,
} from './frozen-repair-carry';

/** Some pg client paths hand jsonb back as a JSON string (EI-22026318885195355). */
function decodeJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function readFrozenRepairPendingCarry(
  target: GateVerdictTarget,
): Promise<FrozenRepairPendingCarry | null> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT metadata->'${FROZEN_REPAIR_CARRY_METADATA_KEY}' AS carry
       FROM harness_shared.routines
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'`,
    [target.workspaceId, target.installSlug],
  )) as Array<{ carry: unknown }>;
  return parseFrozenRepairPendingCarry(decodeJson(rows[0]?.carry));
}

/**
 * Replace exactly `pending` with `record` as the last consumed carry, in one write. False when the
 * stored pending carry is no longer `pending` (a newer retire replaced it, or it was consumed).
 */
export async function consumeFrozenRepairCarry(
  target: GateVerdictTarget,
  pending: FrozenRepairPendingCarry,
  record: FrozenRepairCarryRecord,
): Promise<boolean> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = (COALESCE(metadata, '{}'::jsonb) - '${FROZEN_REPAIR_CARRY_METADATA_KEY}')
              || jsonb_build_object('${FROZEN_REPAIR_CARRY_LAST_METADATA_KEY}', $5::jsonb),
            updated_at = now()
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'
        AND metadata->'${FROZEN_REPAIR_CARRY_METADATA_KEY}'->>'fromCandidate' = $3::text
        AND metadata->'${FROZEN_REPAIR_CARRY_METADATA_KEY}'->'retiredAtMs' = to_jsonb($4::bigint)
      RETURNING true AS consumed`,
    [target.workspaceId, target.installSlug, pending.fromCandidate, pending.retiredAtMs, JSON.stringify(record)],
  )) as Array<{ consumed: boolean }>;
  return rows[0]?.consumed === true;
}

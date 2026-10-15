/**
 * Dependency-light effective GOAL-holder authority read.
 *
 * Kept separate from holder.ts because compact control-context construction is
 * on the agent-MCP bootstrap path. Importing the full holder/liveness oracle
 * graph there creates a cycle through agent-mcp goal registration. This module
 * owns only the canonical election SQL and its small value types.
 */
import type { Sql } from 'postgres';
import { GOAL_MODE } from '../modes/goal-session';

/** Upper bound on superseded rows retired per goal per sweep tick. */
export const SUPERSEDED_GOAL_HOLDER_RETIRE_LIMIT = 50;

/** Lease-authority residue, including dead predecessors: liveness cannot erase a superseded lease. */
export async function readSupersededGoalHolderModes(sql: Sql, workspaceId: string, goalId: string) {
  return await sql<Array<{ owner_id: string; goal_lease_epoch: string; elected_owner_id: string; elected_epoch: string }>>`
    WITH elected AS (
      SELECT owner_id, goal_lease_epoch, goal_handoff_expires_at
        FROM harness_shared.agent_modes
       WHERE workspace_id = ${workspaceId}
         AND mode = ${GOAL_MODE}
         AND subject = ${goalId}
       ORDER BY goal_lease_epoch DESC NULLS LAST, set_at DESC, owner_id ASC
       LIMIT 1
    )
    SELECT am.owner_id, am.goal_lease_epoch::text AS goal_lease_epoch,
           e.owner_id AS elected_owner_id, e.goal_lease_epoch::text AS elected_epoch
      FROM harness_shared.agent_modes am
      CROSS JOIN elected e
     WHERE am.workspace_id = ${workspaceId}
       AND am.mode = ${GOAL_MODE}
       AND am.subject = ${goalId}
       AND am.owner_id <> e.owner_id
       AND am.goal_lease_epoch IS NOT NULL
       AND e.goal_lease_epoch IS NOT NULL
       AND am.goal_lease_epoch < e.goal_lease_epoch
       AND (e.goal_handoff_expires_at IS NULL OR e.goal_handoff_expires_at <= now())
     ORDER BY am.goal_lease_epoch ASC, am.owner_id ASC
     LIMIT ${SUPERSEDED_GOAL_HOLDER_RETIRE_LIMIT}`;
}

/** Historical holder membership with an atomic current-row exclusion, not a staffing read. */
export async function readFormerGoalHolderAwaits(
  sql: Sql, workspaceId: string, goalId: string, coordWorkspaceId: string, keys: string[],
) {
  return await sql<Array<{ subscriber_id: string }>>`
    SELECT DISTINCT a.subscriber_id
      FROM harness_shared.event_awaits a
     WHERE a.workspace_id = ${coordWorkspaceId}
       AND a.event_key = ANY(${sql.array(keys)}::text[])
       AND a.policy <> 'announce'
       AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND EXISTS (
         -- Either side proves historical membership, including entries before subject was recorded.
         SELECT 1 FROM harness_shared.agent_mode_changes c
          WHERE c.workspace_id = ${workspaceId} AND c.owner_id = a.subscriber_id
            AND (c.new_mode = ${GOAL_MODE} OR c.old_mode = ${GOAL_MODE})
            AND c.subject = ${goalId})
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_modes m
          WHERE m.workspace_id = ${workspaceId} AND m.owner_id = a.subscriber_id
            AND m.mode = ${GOAL_MODE} AND m.subject = ${goalId})`;
}

/** Upper bound on former-holder claims released per goal per sweep tick (WI-10006948). */
export const FORMER_GOAL_HOLDER_CLAIM_RELEASE_LIMIT = 50;

/**
 * WI-10006948: goal-stamped work-items still held by a FORMER holder of this goal
 * (one whose GOAL exit on this subject is in the mode audit and who holds no GOAL row
 * on it now), claimed during its tenure and untouched since that exit.
 *
 * The handoff only disarms the predecessor's loop and tells it to release its lane.
 * A predecessor that never takes another turn (WI-10006814) keeps those claims for
 * good: its session is parked, not ended, so the session-death release never fires.
 * Measured 2026-10-06: WI-10006823 stayed wip on the epoch-25 holder of 60d3a8 for
 * 2h after the lease moved to epoch 26.
 *
 * Two fences keep this to abandoned custody:
 *  - `taken_at <= exit`: a claim taken AFTER the agent left GOAL is a later,
 *    deliberate act, not residue of its tenure.
 *  - `COALESCE(last_progress_at, taken_at) <= exit`: an item the agent kept
 *    progressing after it left GOAL (a voluntary exit that kept working) is
 *    live work and stays put.
 * The exit row is written only when the elected row's handoff window has expired
 * (retireSupersededGoalHolderModes) or by an explicit setMode disable, so nothing a
 * predecessor could still legitimately finish inside its handoff window is selected.
 */
export async function readFormerGoalHolderTenureClaims(
  sql: Sql,
  workspaceId: string,
  goalId: string,
  terminalStatuses: readonly string[],
) {
  return await sql<Array<{ id: string; harness: string; owner_id: string; exited_at: Date }>>`
    SELECT w.feature_id AS id, w.harness_slug AS harness, w.taken_by AS owner_id, x.exited_at
      FROM harness_shared.work_items w
      CROSS JOIN LATERAL (
        SELECT max(c.changed_at) AS exited_at
          FROM harness_shared.agent_mode_changes c
         WHERE c.workspace_id = ${workspaceId}
           AND c.owner_id = w.taken_by
           AND c.old_mode = ${GOAL_MODE}
           AND c.subject = ${goalId}
      ) x
     WHERE w.workspace_id = ${workspaceId}
       AND w.goal_id = ${goalId}
       AND w.taken_by IS NOT NULL AND w.taken_by <> ''
       AND w.lane IS DISTINCT FROM 'observation'
       AND NOT (w.status = ANY(${sql.array([...terminalStatuses])}::text[]))
       AND x.exited_at IS NOT NULL
       AND w.taken_at IS NOT NULL
       AND w.taken_at <= x.exited_at
       AND COALESCE(w.last_progress_at, w.taken_at) <= x.exited_at
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_modes m
          WHERE m.workspace_id = ${workspaceId} AND m.owner_id = w.taken_by
            AND m.mode = ${GOAL_MODE} AND m.subject = ${goalId})
     ORDER BY w.taken_at ASC, w.feature_id ASC
     LIMIT ${FORMER_GOAL_HOLDER_CLAIM_RELEASE_LIMIT}`;
}

export type GoalHolderAuthorityStatus = 'none' | 'elected' | 'handoff' | 'superseded';

export interface GoalHolderAuthority {
  status: GoalHolderAuthorityStatus;
  goalId: string | null;
  electedOwnerId: string | null;
  electedEpoch: number | null;
  handoffExpiresAt: string | null;
}

/** Canonical holder-authority read for one session. */
export async function readGoalHolderAuthority(
  sql: Sql,
  workspaceId: string,
  ownerId: string,
): Promise<GoalHolderAuthority> {
  if (!workspaceId || workspaceId === '*' || !ownerId) {
    return {
      status: 'none',
      goalId: null,
      electedOwnerId: null,
      electedEpoch: null,
      handoffExpiresAt: null,
    };
  }
  const rows = await sql<
    Array<{
      subject: string;
      elected_owner_id: string;
      elected_epoch: string | number | null;
      predecessor_owner_id: string | null;
      handoff_expires_at: Date | string | null;
    }>
  >`
    WITH mine AS MATERIALIZED (
      SELECT subject
        FROM harness_shared.agent_modes
       WHERE workspace_id = ${workspaceId}
         AND owner_id = ${ownerId}
         AND mode = ${GOAL_MODE}
         AND subject IS NOT NULL
       LIMIT 1
    ),
    elected AS MATERIALIZED (
      SELECT am.owner_id, am.goal_lease_epoch,
             am.goal_handoff_from_owner_id, am.goal_handoff_expires_at
        FROM harness_shared.agent_modes am
        CROSS JOIN mine
       WHERE am.workspace_id = ${workspaceId}
         AND am.mode = ${GOAL_MODE}
         AND am.subject = mine.subject
       ORDER BY am.goal_lease_epoch DESC NULLS LAST, am.set_at DESC, am.owner_id ASC
       LIMIT 1
    )
    SELECT mine.subject, elected.owner_id AS elected_owner_id,
           elected.goal_lease_epoch AS elected_epoch,
           elected.goal_handoff_from_owner_id AS predecessor_owner_id,
           elected.goal_handoff_expires_at AS handoff_expires_at
      FROM mine
      CROSS JOIN elected`;
  const row = rows[0];
  if (!row) {
    return {
      status: 'none',
      goalId: null,
      electedOwnerId: null,
      electedEpoch: null,
      handoffExpiresAt: null,
    };
  }
  const handoffExpiresAt =
    row.handoff_expires_at == null
      ? null
      : row.handoff_expires_at instanceof Date
        ? row.handoff_expires_at.toISOString()
        : String(row.handoff_expires_at);
  const handoffLive =
    row.predecessor_owner_id === ownerId &&
    handoffExpiresAt != null &&
    Number.isFinite(Date.parse(handoffExpiresAt)) &&
    Date.parse(handoffExpiresAt) > Date.now();
  return {
    status: row.elected_owner_id === ownerId ? 'elected' : handoffLive ? 'handoff' : 'superseded',
    goalId: row.subject,
    electedOwnerId: row.elected_owner_id,
    electedEpoch: row.elected_epoch == null ? null : Number(row.elected_epoch),
    handoffExpiresAt,
  };
}

/**
 * fleet-membership-store — the ONE write path for named-fleet membership
 * (presence-coord-unification-2026-07-01 P-002 / WI-1345).
 *
 * Canonical membership is an APPEND-ONLY fact: harness_shared.fleet_membership_events
 * ("agent X is member|leader of / left fleet Y at T", migration 430). This module is the
 * only place the app appends one. coord_presence.fleet_slug/fleet_role are a PROJECTION of
 * it — maintained by DB triggers and re-materialized after death — never written directly
 * (a DB guard rejects a direct UPDATE). So membership survives the presence reaper, and
 * "who was ever in fleet X" is a durable history read over this log.
 *
 * The `sql?` seam lets a caller thread a transaction (e.g. an atomic leadership transfer)
 * or a per-file test schema, mirroring agent-fleets-store.
 */
import type { Sql, TransactionSql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** The human-readable event label recorded on a membership fact (does not affect the
 *  projection, which is purely the latest fact's fleet_slug/fleet_role). */
export type FleetMembershipEvent = 'join' | 'leave' | 'lead' | 'demote' | 'backfill';

export interface FleetMembershipInput {
  workspaceId: string;
  ownerId: string;
  /** Fleet joined; null = the agent left / is in no fleet (clears the projection). */
  fleetSlug: string | null;
  /** 'leader' | 'member' | null. */
  fleetRole: string | null;
  ownerLabel?: string | null;
  /** Override the derived event label. */
  event?: FleetMembershipEvent;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** Derive a sensible event label from the (slug, role) target when the caller
 *  doesn't specify one: a null slug is a leave; a leader label is a lead; else a join. */
export function deriveFleetMembershipEvent(
  fleetSlug: string | null,
  fleetRole: string | null,
): FleetMembershipEvent {
  if (fleetSlug == null) return 'leave';
  return fleetRole === 'leader' ? 'lead' : 'join';
}

/**
 * Append a membership FACT — the canonical, append-only source of truth. The DB
 * projection trigger mirrors it onto the live coord_presence row (if one exists);
 * the fact itself is durable and re-materializes on the agent's next presence write.
 */
export async function appendFleetMembershipEvent(
  input: FleetMembershipInput,
  sql?: Sql | TransactionSql,
): Promise<void> {
  const s = sql ?? getOrgPg().sql;
  const event = input.event ?? deriveFleetMembershipEvent(input.fleetSlug, input.fleetRole);
  await s`
    INSERT INTO harness_shared.fleet_membership_events
      (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
    VALUES (${input.workspaceId}, ${input.ownerId}, ${input.ownerLabel ?? null},
            ${input.fleetSlug}, ${input.fleetRole}, ${event})
  `;
}

/**
 * Populate-once: append a membership fact ONLY if the owner has no prior fact. The
 * durable analog of the old env-fold `COALESCE(fleet_slug, env)` "the first declared
 * write populates them, every later one preserves" semantic — now a single-statement
 * conditional INSERT so a leader role a handoff promoted this owner to is never
 * clobbered back to the env default, and a re-declaring agent never re-appends.
 */
export async function appendFleetMembershipIfAbsent(
  input: FleetMembershipInput,
  sql?: Sql,
): Promise<void> {
  const s = pg(sql);
  const event = input.event ?? deriveFleetMembershipEvent(input.fleetSlug, input.fleetRole);
  await s`
    INSERT INTO harness_shared.fleet_membership_events
      (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
    SELECT ${input.workspaceId}, ${input.ownerId}, ${input.ownerLabel ?? null},
           ${input.fleetSlug}, ${input.fleetRole}, ${event}
     WHERE NOT EXISTS (
       SELECT 1 FROM harness_shared.fleet_membership_events e
        WHERE e.workspace_id = ${input.workspaceId} AND e.owner_id = ${input.ownerId}
     )
  `;
}

/**
 * Every owner who was EVER a member of `fleetSlug` — the durable, postmortem-safe
 * answer to "whose work counts as this fleet's", including members that have since
 * died or been presence-reaped.
 *
 * This is the ONE read behind every ever-member question; it exists so the rule below
 * is stated once rather than re-derived per caller (EI-19313376980892266's own "one
 * oracle" principle applied to the oracle this module owns).
 *
 * ⚠ NEVER answer this from `coord_presence.fleet_slug`. That column is a projection of
 * the LATEST fact and is cleared when an agent ends, so a live-presence read silently
 * drops exactly the dead members a window-scoped question is asking about. This is a
 * ratified convention, not a preference — `session-search-scope-2026-07-05` **D-002**
 * (see `agent-tools/search/filters.ts`, which resolves `fleet:<slug>` this same way).
 *
 * Measured cost of getting it wrong, 2026-08-03 on fleet `nonp2p-bug-drain-0801`:
 * 22 ever-members vs 11 live, and 708 closes in the trailing 24h vs 318 attributable
 * from presence alone — a live-presence basis would have UNDER-reported that fleet's
 * own output by 55%.
 *
 * An unknown fleet resolves to an EMPTY set. Callers must treat empty as "no members
 * known", never as "this fleet did nothing" — the two are indistinguishable here and
 * only the caller knows which it can safely assume.
 */
export async function fleetEverMembers(
  fleetSlug: string,
  opts: { workspaceId?: string; beforeOrAt?: string } = {},
  sql?: Sql,
): Promise<Set<string>> {
  const s = pg(sql);
  const ws = opts.workspaceId ?? '';
  const rows = await s<Array<{ owner_id: string }>>`
    SELECT DISTINCT owner_id
      FROM harness_shared.fleet_membership_events
     WHERE fleet_slug = ${fleetSlug}
       AND (${ws} = '' OR workspace_id = ${ws} OR workspace_id = 'default')
       ${opts.beforeOrAt ? s`AND at <= ${opts.beforeOrAt}::timestamptz` : s``}
  `;
  const out = new Set<string>();
  for (const r of rows) if (r.owner_id) out.add(r.owner_id);
  return out;
}

/**
 * How long a freshly-joined owner may stay silent before its join is judged a dead launch.
 * psu appends the `join` fact at bootstrap — BEFORE the CLI has booted — so a launch refused
 * at boot still leaves a join behind. Ten minutes covers a cold boot plus its first orient.
 */
export const JOIN_ACTIVATION_GRACE_SEC = 600;

/**
 * How far BEFORE the join an owner's call may land and still count. The writePresence path
 * appends the join DURING the agent's first call, so that call's `invoked_at` precedes `at`.
 */
const JOIN_ACTIVATION_LOOKBACK_SEC = 300;

/** Arrivals in a window, split by whether the joining owner ever became active. */
export interface JoinActivation {
  /** Every `join` fact in the window — the raw arrival count the log has always reported. */
  joined: number;
  /**
   * Joins older than the grace whose owner has made NO MCP call since joining: launches that
   * died at boot (EI-27031443048618869 — 234 of 754 Luna Max joins in one week). These are
   * not seat turnover and must not be read as churn.
   */
  neverActive: number;
  /** Joins still inside the grace with no call yet — booting, not yet judgeable either way. */
  pending: number;
}

/**
 * The ONE definition of "did this join turn into a working member". Every churn reader
 * (the leader brief's delta, fleet:campaign) calls this instead of counting raw `join` rows,
 * because a raw count includes every launch the boot path refused.
 *
 * Activity = at least one `tool_invocations` row for the owner. That ledger misses native
 * client calls, but a booted psu agent's first act is an MCP orient, so for a JOIN the
 * absence of any call past the grace is a reliable dead-launch signal (measured: the 379
 * healthy Luna Max joins of 10-19..10-22 were all active). Served by
 * tool_invocations_coord_owner_idx (coord_owner_id, invoked_at DESC).
 */
export async function readJoinActivation(
  args: {
    workspaceId: string;
    fleetSlug: string;
    /** Window start. Exclusive unless `sinceInclusive`. */
    since: string;
    sinceInclusive?: boolean;
    /** Also count facts recorded under the legacy 'default' workspace. */
    includeDefaultWorkspace?: boolean;
    graceSec?: number;
  },
  sql?: Sql,
): Promise<JoinActivation> {
  const s = pg(sql);
  const grace = args.graceSec ?? JOIN_ACTIVATION_GRACE_SEC;
  const includeDefault = args.includeDefaultWorkspace === true;
  const inclusive = args.sinceInclusive === true;
  const rows = await s<Array<{ joined: string | number; never_active: string | number; pending: string | number }>>`
    SELECT count(*)                                                                    AS joined,
           count(*) FILTER (WHERE NOT x.active AND x.at <= now() - ${grace}::int * interval '1 second') AS never_active,
           count(*) FILTER (WHERE NOT x.active AND x.at >  now() - ${grace}::int * interval '1 second') AS pending
      FROM (
        SELECT e.at,
               EXISTS (
                 SELECT 1 FROM harness_shared.tool_invocations t
                  WHERE t.coord_owner_id = e.owner_id
                    AND t.invoked_at >= e.at - ${JOIN_ACTIVATION_LOOKBACK_SEC}::int * interval '1 second'
               ) AS active
          FROM harness_shared.fleet_membership_events e
         WHERE (e.workspace_id = ${args.workspaceId}
                OR (${includeDefault}::boolean AND e.workspace_id = 'default'))
           AND e.fleet_slug = ${args.fleetSlug}
           AND e.event = 'join'
           AND (e.at > ${args.since}::timestamptz
                OR (${inclusive}::boolean AND e.at = ${args.since}::timestamptz))
      ) x
  `;
  const row = rows[0];
  return {
    joined: Number(row?.joined ?? 0),
    neverActive: Number(row?.never_active ?? 0),
    pending: Number(row?.pending ?? 0),
  };
}

/**
 * The canonical CURRENT membership for an owner: the latest fact (MAX id). Returns null
 * when the owner has no membership fact at all; a returned `{ fleetSlug: null }` means the
 * owner's latest fact was a leave (explicitly in no fleet). This is the same projection the
 * DB triggers apply to coord_presence, exposed for reads that must survive agent death.
 */
export async function latestFleetMembership(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<{ fleetSlug: string | null; fleetRole: string | null } | null> {
  const s = pg(sql);
  const rows = await s<{ fleet_slug: string | null; fleet_role: string | null }[]>`
    SELECT fleet_slug, fleet_role
      FROM harness_shared.fleet_membership_events
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
     ORDER BY id DESC
     LIMIT 1
  `;
  return rows[0] ? { fleetSlug: rows[0].fleet_slug, fleetRole: rows[0].fleet_role } : null;
}

/**
 * The most recently recorded leader for a fleet, including a leader who has
 * since left. This is deliberately a HISTORY read, not a current-membership
 * read: callers must gate it to an explicit lifecycle state (currently fleet
 * wind-down) before using the result as a recovery recipient.
 */
export async function latestFleetLeader(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<string | null> {
  const s = pg(sql);
  const rows = await s<{ owner_id: string }[]>`
    SELECT owner_id
      FROM harness_shared.fleet_membership_events
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug = ${fleetSlug}
       AND fleet_role = 'leader'
     ORDER BY id DESC
     LIMIT 1
  `;
  return rows[0]?.owner_id ?? null;
}

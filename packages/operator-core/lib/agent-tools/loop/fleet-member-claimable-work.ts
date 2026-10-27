/**
 * WI-6554700010029607 — a fleet member must not end its loop while work it could take
 * NOW is claimable under its own fleet claim spec.
 *
 * Measured on fleet nonp2p-bug-drain-luna-max-0930 (2026-10-26): 11 members sat parked
 * with no loop while 1,041 items were claimable under the fleet spec. 8 of the 11 had at
 * least one free claim slot; every held item was open/wip on an exact dependency wait,
 * none recorded with work_items:set_blocker (which frees its slot). loop:end's existing
 * rails only ask "will this session wake again?" (a guaranteed bounded await, or claimless
 * plus acknowledgeWakeLessAutonomy). Both recovery paths left the seat parked: one member
 * was refused twice while holding 2 items, released both, then ended with the
 * acknowledgement holding 0.
 *
 * This module adds the missing question for fleet members: "is there claimable work under
 * your spec?". The refusal's recovery is set_blocker on dependency-wait items, then
 * scheduler:get_next. acknowledgeWakeLessAutonomy does NOT override it.
 *
 * Every read is POSITIVE-FINDING-ONLY: a failed or unknown read returns null and never
 * refuses a stop. The escape is bounded: once refused, a member that has since called
 * scheduler:get_next may end its loop. A get_next miss records as `ok` in the invocation
 * ledger, so "tried and still parked" is the only safe signal that the claimable count
 * over-reports what the claim path can serve; it prevents a refuse/miss livelock.
 */
import type { HeldWorkItem } from '../../events/await/wake-source-predicate';

export const FLEET_MEMBER_CLAIMABLE_WORK_REFUSED = 'fleet_member_claimable_work_refused';

/** How long a refusal stays "recent" for the bounded-retry escape. */
export const FLEET_MEMBER_RETRY_WINDOW_MINUTES = 30;

/** Upper bound on the claimability read; a slower read is unknown (never a refusal). */
export const FLEET_MEMBER_CLAIMABLE_READ_TIMEOUT_MS = 8_000;

export interface FleetMemberClaimableReading {
  fleetSlug: string;
  harness: string;
  claimableCount: number;
}

export interface FleetMemberClaimableDeps {
  readMembership(ownerId: string): Promise<{ fleetSlug: string | null; fleetRole: string | null } | null>;
  readFleetControlState(workspaceId: string, fleetSlug: string): Promise<string | null>;
  resolveHarness(input: { ownerId: string; workspaceId: string; sessionHarness: string | null }): Promise<string | null>;
  countClaimable(input: { harness: string; ctx: unknown }): Promise<number | null>;
  readRetriedAfterRefusal(input: { ownerId: string; workspaceId: string }): Promise<boolean | null>;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);

export const defaultFleetMemberClaimableDeps: FleetMemberClaimableDeps = {
  async readMembership(ownerId) {
    const { fetchPresenceFleet } = await import('../coordination/presence-fleet');
    const membership = (await fetchPresenceFleet([ownerId])).get(ownerId);
    return { fleetSlug: membership?.fleetSlug ?? null, fleetRole: membership?.fleetRole ?? null };
  },
  async readFleetControlState(workspaceId, fleetSlug) {
    const { getFleet } = await import('../../agent-fleets-store');
    const fleet = await getFleet(workspaceId, fleetSlug);
    return fleet?.controlState ?? null;
  },
  async resolveHarness({ ownerId, workspaceId, sessionHarness }) {
    // The same precedence chain scheduler:get_next uses when a member omits `harness`
    // (claim → plan → fleet spec → brief → session), so the count measures the lane
    // get_next would serve.
    const { resolveInheritedHarnessScope } = await import('../_harness-scope');
    const scope = await resolveInheritedHarnessScope({
      explicitHarness: undefined,
      ownerId,
      workspaceId,
      sessionHarness,
    });
    return scope.kind === 'harness' ? scope.slug : null;
  },
  async countClaimable({ harness, ctx }) {
    // Reuse the authoritative "claimable right now" read (caller-effective spec + every
    // claim floor) instead of a second copy of its SQL.
    const { default: claimableTool } = await import('../work_items/claimable');
    const result = (await claimableTool.handler(
      { harness, breakdownOnly: true } as Parameters<typeof claimableTool.handler>[0],
      ctx as Parameters<typeof claimableTool.handler>[1],
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (result?.isError) return null;
    const text = result?.content?.find((part) => part.type === 'text')?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as { ok?: boolean; claimableCount?: unknown };
    if (parsed.ok === false) return null;
    return typeof parsed.claimableCount === 'number' ? parsed.claimableCount : null;
  },
  async readRetriedAfterRefusal({ ownerId, workspaceId }) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ retried: boolean }>>`
      SELECT EXISTS (
        SELECT 1
          FROM harness_shared.tool_invocations r
         WHERE r.workspace_id = ${workspaceId}
           AND r.coord_owner_id = ${ownerId}
           AND r.tool_name = 'loop:end'
           AND r.error_code = ${FLEET_MEMBER_CLAIMABLE_WORK_REFUSED}
           AND r.invoked_at > now() - make_interval(mins => ${FLEET_MEMBER_RETRY_WINDOW_MINUTES})
           AND EXISTS (
             SELECT 1
               FROM harness_shared.tool_invocations g
              WHERE g.workspace_id = r.workspace_id
                AND g.coord_owner_id = r.coord_owner_id
                AND g.tool_name = 'scheduler:get_next'
                AND g.invoked_at > r.invoked_at
           )
      ) AS retried`;
    return rows[0]?.retried === true;
  },
};

/**
 * Read whether this owner is a member of an ACTIVE fleet with claimable work under its
 * spec. Null on anything other than a positive, measured finding (not a member, a
 * winding-down fleet, an unresolvable harness, a zero count, a read error or timeout).
 */
export async function readFleetMemberClaimableWork(
  input: { ownerId: string; workspaceId: string; sessionHarness: string | null; ctx: unknown },
  deps: FleetMemberClaimableDeps = defaultFleetMemberClaimableDeps,
): Promise<FleetMemberClaimableReading | null> {
  try {
    const membership = await deps.readMembership(input.ownerId);
    if (!membership || membership.fleetRole !== 'member' || !membership.fleetSlug) return null;
    const controlState = await deps.readFleetControlState(input.workspaceId, membership.fleetSlug);
    if (controlState !== 'active') return null;
    const harness = await deps.resolveHarness({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      sessionHarness: input.sessionHarness,
    });
    if (!harness) return null;
    const count = await withTimeout(deps.countClaimable({ harness, ctx: input.ctx }), FLEET_MEMBER_CLAIMABLE_READ_TIMEOUT_MS);
    if (typeof count !== 'number' || !(count > 0)) return null;
    return { fleetSlug: membership.fleetSlug, harness, claimableCount: count };
  } catch {
    return null;
  }
}

/** Pure: refuse only on a positive reading, with no exit authorization and no completed retry. */
export function shouldRefuseFleetMemberLoopEnd(input: {
  reading: FleetMemberClaimableReading | null;
  exitAuthorized: boolean;
  retriedAfterRefusal: boolean | null;
}): boolean {
  if (input.exitAuthorized || !input.reading) return false;
  // Unknown (null) is fail-open, like every other read here: only a readable
  // "not yet retried" keeps the refusal.
  return input.retriedAfterRefusal === false;
}

/**
 * The one call loop:end makes: the refusal payload when this self-end must be refused,
 * otherwise null. The caller has already excluded authorized exits (achieved goal,
 * verified owner stop directive); a winding-down fleet reads as null here.
 */
export async function readFleetMemberLoopEndRefusal(
  input: {
    ownerId: string;
    workspaceId: string;
    sessionHarness: string | null;
    ctx: unknown;
    held: readonly HeldWorkItem[] | null;
  },
  deps: FleetMemberClaimableDeps = defaultFleetMemberClaimableDeps,
): Promise<Record<string, unknown> | null> {
  const reading = await readFleetMemberClaimableWork(input, deps);
  if (!reading) return null;
  const retriedAfterRefusal = await deps
    .readRetriedAfterRefusal({ ownerId: input.ownerId, workspaceId: input.workspaceId })
    .catch(() => null);
  if (!shouldRefuseFleetMemberLoopEnd({ reading, exitAuthorized: false, retriedAfterRefusal })) return null;
  return buildFleetMemberClaimableRefusal({ ownerId: input.ownerId, reading, held: input.held });
}

/** Pure: the refusal payload. Its recovery is set_blocker then scheduler:get_next, never an acknowledgement. */
export function buildFleetMemberClaimableRefusal(opts: {
  ownerId: string;
  reading: FleetMemberClaimableReading;
  held: readonly HeldWorkItem[] | null;
}): Record<string, unknown> {
  const { ownerId, reading } = opts;
  const waiting = (opts.held ?? []).filter((item) => item.status !== 'blocked' && item.status !== 'needs-human');
  return {
    ok: false,
    error: FLEET_MEMBER_CLAIMABLE_WORK_REFUSED,
    message:
      `REFUSED — ${ownerId} is a member of active fleet '${reading.fleetSlug}' and ${reading.claimableCount} ` +
      `item(s) are claimable under its claim spec on harness '${reading.harness}'. Ending the loop parks this ` +
      `seat while the frontier has work. Blocked is not a stop: record each held item that waits on an event, ` +
      `gate, runtime or human with work_items:set_blocker (you keep it, and it stops counting against your ` +
      `claim cap), then take the next item with scheduler:get_next. acknowledgeWakeLessAutonomy does not ` +
      `override this refusal.`,
    fleet: reading.fleetSlug,
    harness: reading.harness,
    claimableCount: reading.claimableCount,
    recovery: [
      ...waiting.map((item) => ({
        tool: 'work_items:set_blocker',
        args: { id: item.id, harness: item.harness },
        why: `held ${item.status} item waiting on a dependency: record its blocker (kind, ref, evidence, next action) to free its claim slot`,
      })),
      { tool: 'scheduler:get_next', args: { harness: reading.harness }, why: 'claim the next item under your fleet spec' },
    ],
    exits:
      "The loop may end when the goal is achieved (disposition:'achieved'), on a verified owner stop directive " +
      "(ownerStopDirectiveId), when the fleet is winding down, when nothing is claimable under your spec, or " +
      `after you have called scheduler:get_next since this refusal (within ${FLEET_MEMBER_RETRY_WINDOW_MINUTES} min).`,
    acknowledgeWakeLessAutonomyOverrides: false,
  };
}

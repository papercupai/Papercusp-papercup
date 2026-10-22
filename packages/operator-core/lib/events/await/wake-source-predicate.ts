/**
 * The ONE wake-source predicate (plan parked-agent-census-resumption-and-root-cause-2026-10-09,
 * D-008 (1), D-009; P-009).
 *
 * Two surfaces ask "will anything wake this session?" about a session whose engine loop is (or is
 * about to be) off: the silent-halt detector (`evaluateSilentHalt`'s `pendingAwaits`) and
 * `loop:end`'s wake-less guard. Each used to re-derive the answer, and each counted an await that
 * can never fire as a live wake source — so the detector stayed silent and the guard let the stop
 * through for a session that was in fact stranded. This module is where that judgement lives; the
 * callers pass rows in and never re-implement the exclusions.
 *
 * NOT A WAKE SOURCE (D-008 (1)):
 *   - the session's own `coord:inbox-wake:<self>` watcher (D-006). Every parked session holds one,
 *     and it fires only when somebody else messages the session. A DELIBERATE bounded
 *     wake-on-timeout await on that same key is not the watcher: it wakes on its deadline
 *     (WI-2146110), so it is judged like any other await.
 *   - `work-item:done:<X>` where the subscriber itself holds X: it can fire only when the
 *     subscriber finishes X, which a sleeping subscriber never does (a self-deadlock).
 *   - an await on a work-item that is already terminal (the event already happened) or that does
 *     not exist (the event can never happen).
 *
 * A GUARANTEED wake source (D-009) is a wake source that is also BOUNDED and wakes on its
 * deadline — `awaitGuaranteesRewake`, the same rule the turn-end halt tripwire uses. A claim-holding
 * autonomous session must have one of these before `loop:end` lets its loop go: an untimed watch
 * makes no promise to fire, and "untimed watch + held claim + no loop" is exactly the strand shape
 * the census measured. The silent-halt detector deliberately keeps counting untimed live awaits
 * (it is a retroactive detector; widening it is P-011's call), so the two callers differ ONLY in
 * that one strictness, never in what counts as dead.
 *
 * Failure direction: a target that was not looked up is UNKNOWN and is treated as live. Every
 * caller is positive-finding-only — an unreadable target must not page a human or refuse a stop.
 */
import type { Sql } from 'postgres';
import { awaitGuaranteesRewake } from '../../turn-end-tracking';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

/** The await fields the predicate reads. Every await read in this codebase can supply them. */
export interface WakeSourceAwait {
  subscriberId: string;
  eventKey: string;
  /** ISO deadline; null/absent = unbounded. */
  expiresTs?: string | null;
  /** What happens at the deadline; absent = the store default ('wake'). */
  timeoutBehavior?: string | null;
  /** Cardinality; the platform keepalive is the only standing (`once:false`) inbox-wake row. */
  once?: boolean | null;
}

/** A work-item an await names, as read from `harness_shared.work_items`. */
export interface WorkItemAwaitTarget {
  status: string;
  takenBy: string | null;
}

/**
 * item id → its rows (one per harness: the primary key is `(harness_slug, feature_id)`, and an event
 * key carries the bare id). An EMPTY array = looked up and absent. An id with NO entry was not
 * looked up and is treated as unknown (live).
 */
export type WorkItemAwaitTargets = ReadonlyMap<string, readonly WorkItemAwaitTarget[]>;

export type NonWakeReason = 'inbox-watcher' | 'self-held-done' | 'terminal-target' | 'missing-target';

const TERMINAL = new Set(ANY_FAMILY_TERMINAL_STATES);

/** `work-item:<verb>:<id>` → its parts; null for any other key (including the id-less backlog watch). */
export function parseWorkItemAwaitKey(eventKey: string): { verb: string; itemId: string } | null {
  const m = /^work-item:([a-z][a-z-]*):([A-Z]+-\d+)$/.exec(eventKey);
  return m ? { verb: m[1], itemId: m[2] } : null;
}

/**
 * Why this await is NOT a wake source, or null when it is one. Pure.
 *
 * An id with several rows (same id in two harnesses) resolves toward LIVE: it is terminal only when
 * every row is, and self-held only when a live row is held by the subscriber.
 */
export function nonWakeReason(
  a: WakeSourceAwait,
  targets: WorkItemAwaitTargets,
  inboxWakePrefix: string,
): NonWakeReason | null {
  if (a.eventKey === inboxWakePrefix + a.subscriberId && !awaitGuaranteesRewake(a, inboxWakePrefix)) {
    return 'inbox-watcher';
  }
  const ref = parseWorkItemAwaitKey(a.eventKey);
  if (!ref) return null;
  const rows = targets.get(ref.itemId);
  if (rows === undefined) return null;
  if (rows.length === 0) return 'missing-target';
  const live = rows.filter((r) => !TERMINAL.has(r.status));
  // A settled await is specifically about the post-terminal git-sync commit. The terminal
  // status is its prerequisite, so it cannot by itself make this event a dead wake source.
  if (live.length === 0 && ref.verb !== 'settled') return 'terminal-target';
  if (ref.verb === 'done' && live.some((r) => r.takenBy === a.subscriberId)) return 'self-held-done';
  return null;
}

/** D-008 (1): can this await wake its subscriber at all? */
export function isWakeSource(a: WakeSourceAwait, targets: WorkItemAwaitTargets, inboxWakePrefix: string): boolean {
  return nonWakeReason(a, targets, inboxWakePrefix) === null;
}

/** D-009: a wake source that is also bounded and wakes on its deadline. */
export function guaranteesWake(a: WakeSourceAwait, targets: WorkItemAwaitTargets, inboxWakePrefix: string): boolean {
  return isWakeSource(a, targets, inboxWakePrefix) && awaitGuaranteesRewake(a, inboxWakePrefix);
}

/** The work-item ids named by these awaits' event keys (deduplicated). */
export function workItemIdsNamedBy(awaits: readonly { eventKey: string }[]): string[] {
  const ids = new Set<string>();
  for (const a of awaits) {
    const ref = parseWorkItemAwaitKey(a.eventKey);
    if (ref) ids.add(ref.itemId);
  }
  return [...ids];
}

async function resolveSql(sql?: Sql): Promise<Sql> {
  if (sql) return sql;
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql as unknown as Sql;
}

/**
 * Look up every work-item these awaits name. Every requested id gets an entry (empty = absent), so
 * the predicate can tell "absent" from "not looked up". Not workspace-filtered: an event key carries
 * only the bare id, and a cross-tenant match can only make an await read as LIVE, never as dead.
 */
export async function readWorkItemAwaitTargets(
  awaits: readonly { eventKey: string }[],
  sql?: Sql,
): Promise<Map<string, WorkItemAwaitTarget[]>> {
  const ids = workItemIdsNamedBy(awaits);
  const out = new Map<string, WorkItemAwaitTarget[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const db = await resolveSql(sql);
  const rows = await db<Array<{ feature_id: string; status: string; taken_by: string | null }>>`
    SELECT feature_id, status, taken_by
      FROM harness_shared.work_items
     WHERE feature_id = ANY(${ids}::text[])`;
  for (const r of rows) out.get(r.feature_id)?.push({ status: r.status, takenBy: r.taken_by ?? null });
  return out;
}

/**
 * Every open (un-fired, un-cancelled, un-expired) await for these subscribers, in the shape the
 * predicate reads. Joined on `subscriber_id` alone: `event_awaits` stores rows under the corpus
 * namespace, so a real-workspace filter matches nothing (see silent-halt-reconcile's candidate read).
 */
export async function readOpenAwaitsForSubscribers(
  subscriberIds: readonly string[],
  sql?: Sql,
): Promise<WakeSourceAwait[]> {
  const ids = [...new Set(subscriberIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const db = await resolveSql(sql);
  const rows = await db<
    Array<{
      subscriber_id: string;
      event_key: string;
      expires_ts: Date | string | null;
      timeout_behavior: string | null;
      once: boolean | null;
    }>
  >`
    SELECT subscriber_id, event_key, expires_ts, timeout_behavior, once
      FROM harness_shared.event_awaits
     WHERE subscriber_id = ANY(${ids}::text[])
       AND fired_at IS NULL AND cancelled_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())`;
  return rows.map((r) => ({
    subscriberId: r.subscriber_id,
    eventKey: r.event_key,
    expiresTs: r.expires_ts == null ? null : new Date(r.expires_ts).toISOString(),
    timeoutBehavior: r.timeout_behavior ?? null,
    once: r.once ?? null,
  }));
}

/** subscriber → how many of its awaits are wake sources (D-008 (1)). Pure. */
export function countWakeSourcesBySubscriber(
  awaits: readonly WakeSourceAwait[],
  targets: WorkItemAwaitTargets,
  inboxWakePrefix: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of awaits) {
    if (!isWakeSource(a, targets, inboxWakePrefix)) continue;
    out.set(a.subscriberId, (out.get(a.subscriberId) ?? 0) + 1);
  }
  return out;
}

// ── The held-claim half of loop:end's guard (P-009) ────────────────────────────────────────────

/** A non-terminal work-item a session holds, with what its blocker says it is waiting for. */
export interface HeldWorkItem {
  id: string;
  harness: string;
  status: string;
  /** Active typed external blockers of kind 'event' (their `ref` IS the event key). */
  eventBlockers: Array<{ ref: string; summary: string; recheckAt: string | null }>;
}

/**
 * The session's held, non-terminal, non-observation work-items — the same population silent-halt
 * counts as `heldWorkItems` (lane <> 'observation' is load-bearing: agents' turn-end notes live in
 * the same table and are never claimed work).
 */
export async function readHeldWorkItems(
  ownerId: string,
  workspaceId: string,
  sql?: Sql,
): Promise<HeldWorkItem[]> {
  const db = await resolveSql(sql);
  const rows = await db<
    Array<{ feature_id: string; harness_slug: string; status: string; blockers: unknown }>
  >`
    SELECT feature_id, harness_slug, status, payload->'externalBlockers' AS blockers
      FROM harness_shared.work_items
     WHERE taken_by = ${ownerId}
       AND workspace_id = ${workspaceId}
       AND lane IS DISTINCT FROM 'observation'
       AND status <> ALL(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])
     ORDER BY feature_id
     LIMIT 50`;
  return rows.map((r) => ({
    id: r.feature_id,
    harness: r.harness_slug,
    status: r.status,
    eventBlockers: readActiveEventBlockers(r.blockers),
  }));
}

function readActiveEventBlockers(raw: unknown): HeldWorkItem['eventBlockers'] {
  const list = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(list)) return [];
  return list.flatMap((b) => {
    if (!b || typeof b !== 'object') return [];
    const r = b as Record<string, unknown>;
    if (r.kind !== 'event' || r.status !== 'active' || typeof r.ref !== 'string' || !r.ref) return [];
    return [
      {
        ref: r.ref,
        summary: typeof r.summary === 'string' ? r.summary : '',
        recheckAt: typeof r.recheckAt === 'string' ? r.recheckAt : null,
      },
    ];
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Default bound for a template await: long enough not to spin, short enough to recheck the hold. */
export const BOUNDED_AWAIT_DEFAULT_TIMEOUT_SEC = 3600;
const BOUNDED_AWAIT_MIN_TIMEOUT_SEC = 300;
const BOUNDED_AWAIT_MAX_TIMEOUT_SEC = 86_400;

export interface BoundedAwaitTemplate {
  itemId: string;
  args: { event: string; timeout_sec: number; on_timeout: 'wake'; note: string };
}

/**
 * A bounded `events:await` keyed to an active typed event blocker a held item STATES, or null
 * when none states one. Lifecycle status alone does not prove a dependency edge, so this helper
 * must not invent `work-item:unblocked:<id>` for every blocked item. Typed lifecycle events on
 * the held item itself are also unsatisfiable waits and are skipped here; this keeps loop:end's
 * recovery advice from producing the same self-await deadlock that events:await rejects.
 */
export function boundedAwaitTemplateFor(held: readonly HeldWorkItem[], nowMs: number): BoundedAwaitTemplate | null {
  const heldIds = new Set(held.map((item) => item.id));
  for (const item of held) {
    const blocker = item.eventBlockers.find((candidate) => {
      const lifecycleTarget = /^(?:work-item:(?:status|done)|claim:released):([^:]+)$/.exec(candidate.ref)?.[1];
      return lifecycleTarget === undefined || !heldIds.has(lifecycleTarget);
    });
    if (!blocker) continue;
    return {
      itemId: item.id,
      args: {
        event: blocker.ref,
        timeout_sec: boundedTimeoutSec(blocker.recheckAt, nowMs),
        on_timeout: 'wake',
        note: `P-009 bounded wake for ${item.id}: ${blocker.summary || 'stated event blocker'}`.slice(0, 200),
      },
    };
  }
  return null;
}

function boundedTimeoutSec(recheckAt: string | null, nowMs: number): number {
  const at = recheckAt ? Date.parse(recheckAt) : Number.NaN;
  if (!Number.isFinite(at)) return BOUNDED_AWAIT_DEFAULT_TIMEOUT_SEC;
  const sec = Math.round((at - nowMs) / 1000);
  return Math.min(BOUNDED_AWAIT_MAX_TIMEOUT_SEC, Math.max(BOUNDED_AWAIT_MIN_TIMEOUT_SEC, sec));
}

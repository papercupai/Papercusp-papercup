/**
 * Wake-delivery turn-start proof (parked-agent-census-resumption-and-root-cause-2026-10-09
 * P-006 / WI-10008157, decision D-004).
 *
 * `event_wake_deliveries.status = 'delivered'` only says the delivery reached its channel: an
 * inbox write, a pty write, a spawned resume process. Measured 2026-10-10 over 24h, 13,131 of
 * 21,970 inbox deliveries and 259 of 1,119 psu-socket-inject deliveries were followed by no
 * tool_use from the recipient within 10 minutes, yet every one read back as a clean success.
 * `turn_proof` answers the separate question "did a turn actually start", and this module is
 * the one definition of its states that the store, the pump's pickup sweep and the coord
 * wake/send/dispatch results all share.
 */

import { WAKE_TURN_CHANNELS } from './types';

/** Every value `event_wake_deliveries.turn_proof` may hold (migration 1441 CHECK). */
export const TURN_PROOF_STATES = [
  'host-attested',
  'observed',
  'awaiting',
  'not-picked-up',
  'superseded',
] as const;
export type TurnProof = (typeof TURN_PROOF_STATES)[number];

/** The states that prove a turn started. Everything else is NOT pickup. */
export const TURN_PROOF_CONFIRMED: ReadonlySet<TurnProof> = new Set<TurnProof>(['host-attested', 'observed']);

export function isTurnProof(value: unknown): value is TurnProof {
  return typeof value === 'string' && (TURN_PROOF_STATES as readonly string[]).includes(value);
}

/**
 * Channels whose content rides ANOTHER delivery (or was already seen through another read), so
 * the row itself never owes a turn: `coalesced` siblings fold into a headline wake, and
 * `suppressed-redundant` was cancelled because an earlier delivery already carries it.
 */
const SUPERSEDED_CHANNELS: ReadonlySet<string> = new Set(['coalesced', 'suppressed-redundant']);

/**
 * The proof a delivery is booked with at the moment the pump marks it delivered. Only the
 * executor's own attestation is trusted at booking time; every other turn-capable delivery
 * (including the inbox fallback) starts `awaiting` and is resolved later from real-time signals.
 */
export function initialTurnProof(channel: string, attested: 'host-attested' | undefined): TurnProof {
  if (attested === 'host-attested') return 'host-attested';
  if (SUPERSEDED_CHANNELS.has(channel)) return 'superseded';
  return 'awaiting';
}

/** Default pickup window. Basis (D-004): delivery-to-first-tool-use p95 is 200s for
 *  resume-headless and p90 160s for psu-socket-inject, measured 2026-10-10 over 24h. */
export const DEFAULT_PICKUP_WINDOW_SEC = 600;
const MIN_PICKUP_WINDOW_SEC = 30;
const MAX_PICKUP_WINDOW_SEC = 86_400;

/** `PAPERCUSP_WAKE_PICKUP_WINDOW_SEC`, clamped to [30s, 24h]; unset or unparsable ⇒ 600. */
export function pickupWindowSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCUSP_WAKE_PICKUP_WINDOW_SEC;
  if (raw == null || raw.trim() === '') return DEFAULT_PICKUP_WINDOW_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PICKUP_WINDOW_SEC;
  return Math.min(MAX_PICKUP_WINDOW_SEC, Math.max(MIN_PICKUP_WINDOW_SEC, Math.floor(n)));
}

// ── Real-time turn evidence (slice 2) ──────────────────────────────────────────────────────
//
// `tool_invocations` rows by the subscriber after `delivered_at` are the primary turn signal,
// but not every row there is a turn. Measured 2026-10-10 over 3h:
//   • `session:request-compaction` with empty args was called 418× for 17 owners, 280 of them
//     authorization_denied and ~120 no_live_pty_host: a retry stream against sessions with a
//     dead host or a stale identity — it carries no evidence that a turn ran.
//   • hook-origin `activity:report` with kind='lifecycle' ("session started" / "session ended")
//     and display-only `coord:glance` (status line) fire without any turn.
// So an agent-origin call counts unless its tool is excluded below, and a hook-origin call
// counts only for hooks that fire INSIDE a turn (tool-use hooks and the turn journal).

/** Agent-origin tools whose call is NOT evidence that a turn started. */
export const TURN_EVIDENCE_EXCLUDED_AGENT_TOOLS: readonly string[] = ['session:request-compaction'];

/** Hook-origin tools that only fire inside a running turn (Pre/PostToolUse, Stop). */
export const TURN_EVIDENCE_HOOK_TOOLS: readonly string[] = [
  'journal:record-turn',
  'locks:acquire',
  'locks:check_command',
  'locks:release',
];

/** `activity:report` hook phases that are tool-use hooks (lifecycle reports are excluded). */
export const TURN_EVIDENCE_HOOK_ACTIVITY_PHASES: readonly string[] = ['pre', 'post'];

// ── Pickup escalation (D-004 (4)) ──────────────────────────────────────────────────────────

/** `event_wake_deliveries.source` of the ONE re-queue a not-picked-up delivery may get. */
export const PICKUP_ESCALATION_SOURCE = 'pickup-escalation';

/**
 * Channels that tried to START a turn — derived from the floor's own registry, so a new turn
 * channel can never be silently excluded. Only these may escalate: an `inbox` delivery never
 * tried to start one (it is the fallback for an unwakeable session), and D-002 forbids
 * re-waking those rows en masse — they are reported, and P-012 remediates the population.
 */
const ESCALATABLE_CHANNELS: ReadonlySet<string> = new Set<string>(WAKE_TURN_CHANNELS);

type HostExecutionView = { phase?: string; turnStartedAt?: number | null; lastProgressAt?: number | null };

/** The slice of the psu host's discovery record and event tail the judge reads. */
export interface PickupHostView {
  execution?: HostExecutionView | null;
  authBlocked?: boolean;
  quotaBlocked?: boolean;
  /** The current host process's child has no native identity, so the host refuses its turns (D-007 (b)). */
  unboundSuccessor?: boolean;
  /** Deliveries the host has held as pending past the pickup window with no turn since (D-007 (c)). */
  stuckPending?: StuckPendingDeliveries | null;
}

/** Deliveries a host ACKed but never turned into a turn (D-007 (c)). */
export interface StuckPendingDeliveries {
  /** `duplicate-delivery-id` re-polls the host answered `pending` since the oldest one. */
  repolls: number;
  /** When the host first answered `pending` for a still-unturned delivery. */
  oldestAtMs: number;
}

/**
 * Host lifecycle events that settle the current child's binding verdict, newest wins (D-007 (b)).
 * A delivered turn counts: the host refuses every turn to an unbindable child (P-005(c)), so a
 * turn written after an unconfirmed binding proves the child was bindable after all.
 */
export const BINDING_VERDICT_EVENTS: ReadonlySet<string> = new Set([
  'respawn-binding-unconfirmed',
  'respawn-binding-confirmed',
  'respawn-carry-delivered',
  'successor-unbindable-refused',
  'turn-delivered',
]);

/**
 * The one binding-failure reason psu-pty-host itself treats as an unbindable child (P-005 /
 * D-003). Other `respawn-binding-unconfirmed` reasons (`superseded`,
 * `successor-reanchor-unconfirmed`, ...) describe a binding WAIT that ended, not a child without
 * an identity; measured 2026-10-10, hosts carrying them ran 95-245 tool calls an hour (D-007).
 */
export const UNBINDABLE_BINDING_REASON = 'successor-native-id-missing';

/** One psu-pty-host lifecycle event as `appendHostEvent` writes it (`ts` is an ISO string). */
export interface HostTailEvent {
  kind?: unknown;
  ts?: unknown;
  [k: string]: unknown;
}

function hostEventMs(e: HostTailEvent): number | null {
  if (typeof e.ts === 'number') return Number.isFinite(e.ts) ? e.ts : null;
  if (typeof e.ts === 'string') {
    const ms = Date.parse(e.ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export interface HostTailVerdict {
  unboundSuccessor: boolean;
  stuckPending: StuckPendingDeliveries | null;
}

/**
 * A pending TURN delivery can be a stuck turn. Cold loop wakes may use a lifecycle transport
 * (`carry-respawn`, `reset`, or `recycle`) to create that turn, so the host also stamps duplicate
 * delivery events with `routineId`; those loop-origin deliveries count regardless of transport.
 * An ordinary carry-respawn/control delivery still does not block the next wake turn. Measured
 * 2026-10-11 (P-012): su-ef6886ef's tail held 2 pending carry-respawn deliveries closed by
 * `respawn-carry-dropped`; its first wake turn was delivered on poll 1. A missing `mode` predates
 * the stamp and stays a turn.
 */
function isTurnDelivery(e: HostTailEvent): boolean {
  return e.mode === undefined || e.mode === null || e.mode === 'turn' ||
    (typeof e.routineId === 'string' && e.routineId.trim().length > 0);
}

/**
 * Judge a psu host's lifecycle tail (D-007). The ONE reading both the pickup sweep (P-006) and
 * the stalled-loops guard (P-007) use, so "this host is wedged" means one thing everywhere.
 *
 * The tail file is per OWNER and outlives a host process, so only events at or after the current
 * host's `startedAt` describe its child: a predecessor's unconfirmed binding says nothing about a
 * relaunched session. When the start is unknown every timed event counts.
 *
 * `stuckPending` needs persistence, not one sighting: a busy host answers `pending` for a wake
 * that arrived mid-turn and delivers it at turn end (measured: 78 of 220 healthy hosts in 6h).
 * It is reported only when the host has re-polled the same pending state at least twice, the
 * oldest is past the pickup window, no turn was written since, and the host is not visibly
 * busy: execution running with progress inside the window, or the child writing terminal output
 * inside it. The output test covers bridged (interactive) hosts, which publish no execution
 * observation; measured 2026-10-10, a bridged session inside one long turn made 100 tool calls
 * in 10 minutes while its wakes pended, and its last output was 0 minutes old, against 42-148
 * minutes for every genuinely stuck host.
 */
export function judgeHostTail(
  events: readonly HostTailEvent[],
  opts: {
    hostStartedAtMs?: number | null;
    nowMs: number;
    pickupWindowMs: number;
    execution?: HostExecutionView | null;
    /** The host's `lastOutputAt`: when its child last wrote to the terminal. */
    lastOutputAtMs?: number | null;
  },
): HostTailVerdict {
  const start =
    typeof opts.hostStartedAtMs === 'number' && Number.isFinite(opts.hostStartedAtMs) && opts.hostStartedAtMs > 0
      ? opts.hostStartedAtMs
      : null;
  let binding: HostTailEvent | null = null;
  let oldestPendingMs: number | null = null;
  let repolls = 0;
  for (const e of events) {
    const at = hostEventMs(e);
    if (at === null || (start !== null && at < start)) continue;
    const kind = typeof e.kind === 'string' ? e.kind : '';
    if (BINDING_VERDICT_EVENTS.has(kind)) binding = e;
    if (kind === 'turn-delivered') {
      oldestPendingMs = null;
      repolls = 0;
    } else if (kind === 'duplicate-delivery-id' && e.state === 'pending' && isTurnDelivery(e)) {
      oldestPendingMs ??= at;
      repolls += 1;
    }
  }
  const unboundSuccessor =
    binding !== null &&
    (binding.kind === 'successor-unbindable-refused' ||
      (binding.kind === 'respawn-binding-unconfirmed' && binding.reason === UNBINDABLE_BINDING_REASON));

  const within = (ms: number | null | undefined) =>
    typeof ms === 'number' && Number.isFinite(ms) && opts.nowMs - ms < opts.pickupWindowMs;
  const visiblyBusy =
    (opts.execution?.phase === 'running' && within(opts.execution.lastProgressAt)) || within(opts.lastOutputAtMs);
  const stuckPending =
    oldestPendingMs !== null && repolls >= 2 && opts.nowMs - oldestPendingMs >= opts.pickupWindowMs && !visiblyBusy
      ? { repolls, oldestAtMs: oldestPendingMs }
      : null;
  return { unboundSuccessor, stuckPending };
}

/** The discovery-record fields `pickupHostView` reads (a structural slice of `PsuPtyHost`). */
export interface PickupHostRecord {
  startedAt?: number | null;
  lastOutputAt?: number | null;
  execution?: HostExecutionView | null;
  authBlocked?: boolean;
  quotaBlocked?: boolean;
}

/** Build the judge's view of a live host from its discovery record and lifecycle tail (D-007 (a)). */
export function pickupHostView(
  host: PickupHostRecord,
  events: readonly HostTailEvent[],
  nowMs: number,
  pickupWindowMs: number = pickupWindowSec() * 1000,
): PickupHostView {
  const execution = host.execution ?? null;
  const verdict = judgeHostTail(events, {
    hostStartedAtMs: host.startedAt ?? null,
    nowMs,
    pickupWindowMs,
    execution,
    lastOutputAtMs: host.lastOutputAt ?? null,
  });
  return {
    execution,
    authBlocked: host.authBlocked,
    quotaBlocked: host.quotaBlocked,
    unboundSuccessor: verdict.unboundSuccessor,
    stuckPending: verdict.stuckPending,
  };
}

export type PickupRecoverable = 'auth-blocked' | 'quota-blocked' | 'unbound-successor' | 'pending-turn-stuck';

export type ExpiredPickupVerdict =
  | { proof: 'observed'; turnStartedAtMs: number; via: 'host-turn-start' }
  | { proof: 'not-picked-up'; escalate: boolean; reason: string; recoverable: PickupRecoverable | null };

/**
 * The P-004/P-005/D-007 condition the host reports, if any. Auth first: it is the one a turn
 * cannot outlive. A stuck pending pipeline is last: the conditions above it explain WHY turns
 * pend, and naming the cause routes to the right recovery.
 */
export function hostRecoverableCondition(host: PickupHostView | null): PickupRecoverable | null {
  if (!host) return null;
  if (host.authBlocked === true) return 'auth-blocked';
  if (host.quotaBlocked === true) return 'quota-blocked';
  if (host.unboundSuccessor === true) return 'unbound-successor';
  if (host.stuckPending) return 'pending-turn-stuck';
  return null;
}

/**
 * Decide an expired `awaiting` delivery (D-004). The tool-call evidence was already checked in
 * SQL; this adds the psu host's own turn-start observation, then decides escalation.
 *
 * A host turn start counts only when it happened after delivery, did not fail, and the host is
 * not blocked: a codex child whose login cannot refresh starts a turn that fails at once, and
 * calling that a pickup would hide exactly the stranded agents this exists to surface.
 */
export function judgeExpiredPickup(
  row: { deliveredAtMs: number; channel: string | null; source: string | null },
  host: PickupHostView | null,
): ExpiredPickupVerdict {
  const recoverable = hostRecoverableCondition(host);
  const started = host?.execution?.turnStartedAt;
  if (
    host &&
    recoverable === null &&
    typeof started === 'number' &&
    Number.isFinite(started) &&
    started > row.deliveredAtMs &&
    host.execution?.phase !== 'failed'
  ) {
    return { proof: 'observed', turnStartedAtMs: started, via: 'host-turn-start' };
  }
  if (row.source === PICKUP_ESCALATION_SOURCE) {
    return { proof: 'not-picked-up', escalate: false, reason: 'already a pickup escalation', recoverable };
  }
  if (!row.channel || !ESCALATABLE_CHANNELS.has(row.channel)) {
    return {
      proof: 'not-picked-up',
      escalate: false,
      reason: `channel ${row.channel ?? 'unknown'} does not start a turn; reported only (D-002)`,
      recoverable,
    };
  }
  if (!host) {
    return { proof: 'not-picked-up', escalate: false, reason: 'no live psu host to recover', recoverable: null };
  }
  if (recoverable === null) {
    return {
      proof: 'not-picked-up',
      escalate: false,
      reason: 'host reports no recoverable condition (P-004/P-005)',
      recoverable: null,
    };
  }
  if (recoverable === 'pending-turn-stuck') {
    // D-007 (c): the host ACKs a re-queued wake into the same stalled pipeline, so the one
    // re-queue would only add another pending delivery. Reported for relaunch (P-012).
    return {
      proof: 'not-picked-up',
      escalate: false,
      reason: 'host pending-turn-stuck: a re-queued wake would pend behind the stalled turn; reported only (P-012)',
      recoverable,
    };
  }
  return { proof: 'not-picked-up', escalate: true, reason: `host ${recoverable}; one re-queue`, recoverable };
}

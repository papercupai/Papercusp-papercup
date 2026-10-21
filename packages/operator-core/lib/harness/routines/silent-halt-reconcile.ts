/**
 * silent-halt-reconcile — a STANDING reconciler for the autonomous session that went
 * inert for a reason no code path was executing to notice (WI-35718).
 *
 * THE GAP THIS CLOSES. Two point-fixes already page the owner at the moment they silence a
 * session: `loop-dead-man.ts` on a maxFires/maxDurationSec breach, and `stalled-loops-guard.ts`
 * on a disarm of a still-reachable session. Both fire only on the specific code path that does
 * the silencing. A session that goes inert for any OTHER reason — a crashed CLI child, a died
 * carry-respawn, a wedged host, a dropped socket ack booked as `delivered`, a zero-tool
 * escalation whose real cause was a provider usage wall — is caught by nothing, because at that
 * moment there is no executing code to notice. Only a sweep run from OUTSIDE the halted session
 * can see it.
 *
 * WHY THE OWNER, NEVER THE AGENT'S OWN INBOX. Delivery-to-inbox does not wake a session.
 * `claim-discipline-watch` fired at su-1f7ee244 roughly hourly for the FULL four days it was
 * inert; every one landed in an inbox nobody would ever read. The system already HELD the signal
 * and spent it on a dead channel. A watchdog that repeats the same finding at the same agent for
 * four days without escalating CHANNEL is not a detector, it is a metronome.
 *
 * ── WHY THIS PAGES ONLY ABOUT A SESSION THAT HOLDS WORK ───────────────────────────────────────
 *
 * WI-35718 states its conjunction and calls it "an unambiguous silently-halted autonomous
 * agent". Measured against live PG before this file was written, it is not unambiguous — as
 * written it selects ~4,037 rows, because ~4,091 candidates have no coord_presence row at all.
 * Presence is reaped, so a mode row beside an inactive loop is the normal terminal RESIDUE every
 * cleanly-ended session leaves behind forever. Adding a presence join drops that ~60x, and the
 * item's own `no pending await` term drops it again (an await IS a wake source).
 *
 * That gets the population small. It does NOT establish that the survivors are halted, and the
 * distinction matters because `unguarded-halt-rescue-action.ts` (2026-07-26, which PRE-dates
 * this item and which the item does not mention) already targets this failure class — and its
 * own measurement contradicts the obvious gate head-on:
 *
 *     "The obvious gate — heartbeat fresh ⇒ the process is alive, so wake it — is WRONG here,
 *      and measurably so. 30+ agents had made no tool call for 6-9 DAYS while still heartbeating
 *      every ~50s."
 *
 * So heartbeat-fresh proves a PROCESS EXISTS; it does not separate halted-and-recoverable from
 * abandoned, and no available signal does (that module reports sessionState and wakeable failing
 * the same way). It therefore targets by REASON TO WAKE — fleet still active, load 0, and work
 * actually claimable — and WAKES the agent, which is strictly better than bothering a human.
 *
 * This module must not re-litigate that. It takes the one case that design provably EXCLUDES:
 * its conjunct (2) requires load 0 ("nothing to resume"), so a halted session that HOLDS a
 * claimed work-item is rescued by nothing. That case is worth a human, and it is the only one
 * here that survives the abandoned-vs-halted ambiguity — because it does not depend on resolving
 * it. Either way the held item is STRANDED: the owner is heartbeat-fresh, so the dead-owner claim
 * reaper does not reclaim it, and the session takes no turns, so nothing advances it. The work
 * sits claimed and unworkable until a human looks. Whether the agent behind it is recoverable or
 * abandoned changes the remedy, not the fact that one is needed.
 *
 * Hence: liveness NARROWS the population, and actionable held work JUSTIFIES the page. Holds
 * parked on an active typed external blocker are not actionable stranded work (D-010/P-010); the
 * shared classifier excludes them from the count and keeps their IDs visible in the verdict.
 * Neither liveness nor held work alone is enough, and paging on liveness alone is the mistake
 * the counter-design already measured.
 *
 * A blocker park excuses the stop only when it names its wake (WI-6554700010018551). With no
 * await left, that wake is the blocker's re-check time, which the blocker reaper services. A park
 * whose blocker has none is revisited by nothing, so it is a WAKE-ONLY halt: one wake per disarm
 * epoch asking the holder to name the wake, and never a page or the owner-facing condition.
 *
 * WHY REUSE getLoopStatuses. `lastRealTurnAt` is a union over the journal and session_turns'
 * assistant turns (loop.ts ~line 2000) and has under-reported twice already (WI-6069 and its
 * follow-up), both times in the direction of a healthy agent reading as dead. This module reads
 * it through the SAME accessor `loop:status` and `stalled-loops-guard` use rather than
 * re-deriving it, so a future correction lands here for free and cannot drift into a second,
 * subtly-different definition of "produced a turn".
 *
 * RECURRENCE GUARD. One owner-visible escalation per (owner, disarm epoch), via
 * `notifyAttentionOnce`'s `dedupeKey`. A session that stays halted does not re-page; one that is
 * re-armed and later halts AGAIN has a new epoch and does page, because that is a new fault.
 * This is the direct answer to the metronome above.
 *
 * SAFETY / FAILURE DIRECTION. Every ambiguity resolves toward SILENCE except one. No presence
 * row, a stale heartbeat, any pending await, an armed loop, or no autonomy posture all mean "not
 * my case". The single deliberate exception is inherited from `hasAutonomyPosture`: an UNKNOWN
 * mode id counts as autonomous, because a spurious page costs one notification while a missed
 * one costs days.
 *
 * "Any pending await" EXCLUDES the session's own `coord:inbox-wake:<self>` watcher (P-007 slice 2,
 * D-006). Every parked session holds one, and it fires only when somebody else messages the
 * session, so it is not a wake source the session can count on. Counting it hid every normally
 * parked AUTO session: measured 2026-10-10, 115 of 115 exemptions were 'pending-await', and 51
 * claim-holding AUTO sessions had that watcher as their only await.
 *
 * That exclusion, and every other "this await can never fire" rule (a self-held
 * `work-item:done:<X>`, an await on a terminal or absent item), lives in ONE place:
 * `events/await/wake-source-predicate.ts` (D-008 (1)). `loop:end`'s wake-less guard reads the same
 * predicate, so the two can no longer disagree about what is dead. This detector stays lenient
 * about UNTIMED live awaits (D-009); only `loop:end` demands a guaranteed (bounded) source.
 */

import type { Sql } from 'postgres';
import { observeFallback } from '../../degradation/fallback-observations';
import { broadcastSevereEvent } from '../../severe-event-broadcast';
import { resolveAlarm } from '../../alarm-attention';
import { getOrgPg } from '@papercusp/db-org';
import type { ReplaySafeAttentionNotifyInput } from '../../attention-notify';
import type { StalledLoopHostClass } from '../../events/await/host-recovery-eligibility';
import {
  countWakeSourcesBySubscriber,
  readOpenAwaitsForSubscribers,
  readWorkItemAwaitTargets,
} from '../../events/await/wake-source-predicate';
import { hasAutonomyPosture } from './loop-dead-man';
import { getLoopStatuses } from './loop';
import { readEngineLoopRowsByOwner } from './engine-loop-standdown';
import { isParkedOnExternalBlocker } from '../../scheduler/claim-spec-store';
import { activeBlockersWithoutRecheck } from '../../external-blockers';
import { classifyEndedHolder, type SessionEndClassification } from '../../session-end-classifier';
import {
  resolveFleetParkResumePath,
  describeParkResumePath,
  type FleetParkResumePath,
} from '../../fleet-park-resume-path';

/**
 * A heartbeat older than this means the PROCESS is gone, not halted — the fifth term measured
 * above. Deliberately generous relative to the ~30s presence beat: a missed beat or two under
 * load must not be read as death, because reading a live agent as gone is how this module would
 * stop reporting the very thing it exists to find.
 */
export const SILENT_HALT_HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

/**
 * Floor under the staleness test, whatever the loop's interval. A 60s loop must not page 5
 * minutes after a disarm that an agent is about to correct itself — most disarms are transient
 * and self-heal, and the cost of waiting is bounded while the cost of a false page is trust.
 */
export const SILENT_HALT_MIN_STALE_MS = 30 * 60 * 1000;

/** Multiple of the loop's own interval that must elapse with no real turn. */
export const SILENT_HALT_STALE_INTERVALS = 5;

/** Never page about more owners than this in one pass — a mass-halt is ONE incident. */
export const SILENT_HALT_MAX_PAGES_PER_SWEEP = 5;

/** Bound the per-sweep WAKE fan the same way (P-003 R2): a mass halt recovers steadily. */
export const SILENT_HALT_MAX_WAKES_PER_SWEEP = 5;

/** Outbox identity for the wake-first rung — its own sent rows ARE the markers that
 *  make the one-wake-per-(owner, disarm-epoch) bound restart-safe with NO new table
 *  (R2), the same derived-from-PG pattern as `unguarded-halt-rescue-action.ts`. */
export const SILENT_HALT_WAKE_OWNER = 'silent-halt-reconcile';

/** Marks this rung's own outbox rows so the epoch dedupe can find them. */
export const SILENT_HALT_WAKE_PREFIX = 'silent-halt wake:';

/**
 * The disarm-epoch token BOTH actuations key on: the disarm INSTANT in epoch-minutes
 * (stable across sweeps — `now - inactiveFor` reproduces `active_changed_at`), or
 * 'unknown' when no disarm timestamp exists. The page dedupeKey and the wake marker
 * MUST share this derivation, or the two rungs would disagree about what "once per
 * epoch" means.
 */
export function disarmEpochToken(nowMs: number, inactiveForMs: number | null): string {
  return inactiveForMs != null ? String(Math.round((nowMs - inactiveForMs) / 60000)) : 'unknown';
}

/** The exact outbox summary a wake attempt writes — doubling as its dedupe marker. */
export function wakeMarkerSummary(ownerId: string, epochToken: string): string {
  return `${SILENT_HALT_WAKE_PREFIX} ${ownerId}:${epochToken}`;
}

/**
 * The member-facing wake text (P-003). Unlike the rescue's body this addresses a
 * session that HOLDS work: the ask is resume-or-release, then restore a wake source.
 * A parked fleet's member also gets its park's way back VERBATIM
 * (`describeParkResumePath`), so the key it should await is copied, never re-typed.
 */
export function silentHaltWakeBody(
  candidate: SilentHaltCandidate,
  verdict: SilentHaltVerdict,
  parkPath: FleetParkResumePath | null,
): string {
  const blockerParkedIds = candidate.blockerParkedWorkItemIds ?? [];
  const park = parkPath?.parked
    ? [
        ``,
        `Your fleet${candidate.fleetSlug ? ` "${candidate.fleetSlug}"` : ''} has a park directive in force:`,
        describeParkResumePath(parkPath),
      ]
    : [];
  if (verdict.wakeOnly) {
    const unbounded = candidate.unboundedBlockerParkedWorkItemIds ?? [];
    return [
      `You are an autonomous session that stopped taking turns while holding ${unbounded.length} ` +
        `blocked work-item(s) whose blocker names no wake: ${unbounded.join(', ')}.`,
      `Each blocker has no re-check time, and you hold no await, so nothing will ever wake you about`,
      `it: the blocker reaper only revisits blockers that carry a re-check time.`,
      ``,
      `This wake came from the system-side silent-halt sweep (${SILENT_HALT_WAKE_OWNER}), not from a`,
      `peer, so there is no one to reply to. It is the ONE wake this disarm epoch gets, and it does not`,
      `page the human owner.`,
      ``,
      `NEXT, in this turn, for each listed item:`,
      `  1. Re-check the condition its blocker names (work_items:get).`,
      `  2. Still blocked: name its wake. Re-declare the blocker with work_items:set_blocker`,
      `     { id, kind, ref } (re-declaring stamps a re-check time; pass recheckAt to choose it), or`,
      `     events:await { event, timeout_sec, on_timeout:'wake' } on the event it waits for.`,
      `  3. Cleared: clear the blocker and resume the item. Not continuing it: release it.`,
      ...park,
    ].join('\n');
  }
  return [
    `You are an autonomous session that stopped taking turns while still HOLDING ` +
      `${candidate.heldWorkItems} actionable work-item(s): ${verdict.reason ?? 'no armed loop, no pending await — no wake source'}.`,
    ...(blockerParkedIds.length > 0
      ? [`Held item(s) excluded from the stranded-work count because they are parked on active typed external blockers: ${blockerParkedIds.join(', ')}.`]
      : []),
    ``,
    `This wake came from the system-side silent-halt sweep (${SILENT_HALT_WAKE_OWNER}), not from a`,
    `peer — there is no one to reply to. It is the ONE wake this disarm epoch gets: if you take no`,
    `real turn, the next sweep tick pages the human owner about the stranded work.`,
    ``,
    `NEXT, in this turn:`,
    `  1. Re-read each actionable held item's checkpoint (work_items:get) and governing decision.`,
    `     Preserve any named evidence gate or explicit stop: this alarm does not prove the gate cleared.`,
    `     Resume, release, or re-place only when that named condition permits it. Otherwise checkpoint`,
    `     and release what you cannot continue.`,
    ...(blockerParkedIds.length > 0
      ? [`     Keep the listed blocker-parked items visible with their typed blockers; do not count them as stranded work.`]
      : []),
    `  2. Restore a real wake source before ending the turn: loop:arm { intervalSec, goal }`,
    `     (verify loop:status.active) or events:await { event } when blocked on a completion.`,
    `  3. If a checkpoint or decision explicitly parks the lane, preserve that hold until its gate`,
    `     permits action. For an ordinary clean wind-down (loop:end), release held claims first.`,
    ...park,
  ].join('\n');
}

export interface SilentHaltInput {
  /** Loop routine `active`. An ARMED loop is stalled-loops-guard's domain, never this one. */
  loopActive: boolean;
  /** Result of `hasAutonomyPosture` over the owner's registered modes. */
  hasPosture: boolean;
  /** Un-fired, un-cancelled, un-expired awaits. Any at all is a live wake source. */
  pendingAwaits: number;
  /** Age of the presence heartbeat. `null` = no presence row = gone, not halted. */
  heartbeatAgeMs: number | null;
  /** Age of the last REAL turn (`lastRealTurnAt`); `null` when none was ever produced. */
  lastRealTurnAgeMs: number | null;
  /** How long the loop has been inactive (`active_changed_at`); `null` when unknown. */
  inactiveForMs: number | null;
  /** The loop's own cadence, for the interval-relative staleness floor. */
  intervalSec: number | null;
  /**
   * Non-terminal, non-observation work-items this session holds, excluding rows parked on an
   * active typed external blocker. ZERO means no actionable held work justifies this page.
   */
  heldWorkItems: number;
  /** Held items excluded by D-010/P-010's shared typed-blocker predicate, retained for context. */
  blockerParkedWorkItemIds?: readonly string[];
  /**
   * The subset of {@link blockerParkedWorkItemIds} whose blocker names no re-check time
   * (`activeBlockersWithoutRecheck`). With no pending await, nothing will ever wake the holder
   * about these, so they excuse the stop only for a wake, never for a page (WI-6554700010018551).
   */
  unboundedBlockerParkedWorkItemIds?: readonly string[];
}

export interface SilentHaltVerdict {
  /**
   * Halted, but the only stranded work is blocker-parked with no named wake. The remedy is ONE
   * wake asking the holder to name it; the sweep never pages the owner or raises the aggregate
   * condition for it. Absent = false.
   */
  wakeOnly?: boolean;
  halted: boolean;
  /** Why it IS a halt — populated only when `halted`. */
  reason: string | null;
  /** Why it is NOT — populated only when not `halted`. Every exemption is named, never silent. */
  exemption: string | null;
  /** The floor actually applied, so a verdict can be explained without re-deriving it. */
  staleFloorMs: number;
}

/**
 * The pure verdict. Split out from the sweep so the conjunction is testable without PG, and so
 * the exemption that fired is always nameable — an unexplained silence is indistinguishable
 * from a broken detector, which is the failure mode this whole module is about.
 */
export function evaluateSilentHalt(input: SilentHaltInput): SilentHaltVerdict {
  const intervalMs =
    input.intervalSec != null && Number.isFinite(input.intervalSec) && input.intervalSec > 0
      ? input.intervalSec * 1000
      : 0;
  const staleFloorMs = Math.max(SILENT_HALT_MIN_STALE_MS, intervalMs * SILENT_HALT_STALE_INTERVALS);
  const no = (exemption: string): SilentHaltVerdict => ({ halted: false, reason: null, exemption, staleFloorMs });

  // An ARMED loop that stopped producing turns is a different fault with a different remedy,
  // owned by stalled-loops-guard. Two modules acting on one signal is how a fleet gets disarmed
  // twice for one cause.
  if (input.loopActive) return no('loop-armed (stalled-loops-guard owns this case)');

  // A session with no autonomy posture has a human in front of it who will see the next turn.
  if (!input.hasPosture) return no('no-autonomy-posture (interactive session)');

  // An await IS a wake source. 63 of 67 live candidates were exempt here — this term, not
  // liveness, is what separates a waiting agent from a halted one.
  if (input.pendingAwaits > 0) return no(`pending-await x${input.pendingAwaits} (a live wake source)`);

  // No presence row = reaped = long gone. This is the ~60x collapse, and omitting it is what
  // turns this detector into a metronome. It NARROWS the population; it does not establish that
  // a survivor is halted rather than abandoned — see the header, and the held-work term below.
  if (input.heartbeatAgeMs == null) return no('no-presence-row (session is gone, not halted)');
  if (input.heartbeatAgeMs > SILENT_HALT_HEARTBEAT_FRESH_MS) {
    return no(`heartbeat-stale ${Math.round(input.heartbeatAgeMs / 60000)}m (process gone, not halted)`);
  }

  // THE TERM THAT JUSTIFIES A PAGE. A load-0 halt is `unguarded-halt-rescue`'s case and it WAKES
  // that agent — strictly better than bothering a human, so this module must not double-report
  // it. Only actionable held work makes the strand concrete: active typed external-blocker parks
  // are excluded by D-010/P-010, while every other held row keeps the original rule. For an
  // actionable hold, heartbeat-fresh means the dead-owner reaper will not reclaim it, and a
  // session taking no turns will not advance it, so it is stuck whether the agent is recoverable
  // OR abandoned. That is what makes this the one case here that does not depend on a distinction
  // no available signal can make.
  //
  // A blocker park excuses the stop only when it names its wake (report rpt_24408ef5 item #4,
  // WI-6554700010018551). Every await is already gone by this point (the pending-await term above),
  // so the one wake left is the blocker's own re-check time, which the blocker reaper services. A
  // blocker with none is revisited by nothing, so that hold falls through to the clocks as a
  // WAKE-ONLY halt: one wake asking the holder to name the wake, never a page.
  const unboundedParkedIds = input.unboundedBlockerParkedWorkItemIds ?? [];
  if (input.heldWorkItems <= 0 && unboundedParkedIds.length === 0) {
    const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];
    if (blockerParkedIds.length > 0) {
      return no(
        `holds-only-active-external-blockers (each names a re-check time; parked work items: ${blockerParkedIds.join(', ')})`,
      );
    }
    return no('holds-no-work (unguarded-halt-rescue wakes this case; nothing is stranded)');
  }
  const wakeOnly = input.heldWorkItems <= 0;

  // Both clocks must clear the floor. A loop disarmed seconds ago is not yet a halt however old
  // the last turn is, and a turn produced seconds ago is not a halt however long the loop has
  // been off — either one alone would page an agent that is actively recovering.
  const turnAge = input.lastRealTurnAgeMs;
  const inactiveFor = input.inactiveForMs;
  if (inactiveFor != null && inactiveFor <= staleFloorMs) {
    return no(`recently-disarmed ${Math.round(inactiveFor / 60000)}m (below floor)`);
  }
  if (turnAge != null && turnAge <= staleFloorMs) {
    return no(`recent-turn ${Math.round(turnAge / 60000)}m (below floor)`);
  }
  // Never produced a turn AND never recorded a disarm time: nothing establishes duration, so
  // there is no evidence of a HALT as opposed to a session that has not started. Fail quiet.
  if (turnAge == null && inactiveFor == null) {
    return no('no-duration-evidence (neither a real turn nor a disarm timestamp)');
  }

  const silentForMs = Math.max(turnAge ?? 0, inactiveFor ?? 0);
  const blockerParkedIds = input.blockerParkedWorkItemIds ?? [];
  const unboundedNote =
    unboundedParkedIds.length > 0 ? ` (no re-check time: ${unboundedParkedIds.join(', ')})` : '';
  const blockerParkedNote =
    !wakeOnly && blockerParkedIds.length > 0
      ? `; active external-blocker parks excluded: ${blockerParkedIds.join(', ')}${unboundedNote}`
      : '';
  const heldClause = wakeOnly
    ? `no actionable held work, but ${unboundedParkedIds.length} blocker-parked work item(s) whose ` +
      `blocker names no wake (no re-check time): ${unboundedParkedIds.join(', ')}; `
    : `${input.heldWorkItems} actionable held work item(s), but `;
  return {
    halted: true,
    wakeOnly,
    reason:
      `autonomy posture registered, loop INACTIVE for ` +
      `${inactiveFor != null ? `${Math.round(inactiveFor / 60000)}m` : 'unknown'}, ` +
      `no pending await, heartbeat fresh (${Math.round(input.heartbeatAgeMs / 1000)}s), ` +
      heldClause +
      `${turnAge != null ? `no real turn in ${Math.round(turnAge / 60000)}m` : 'no real turn ever recorded'}` +
      blockerParkedNote,
    exemption: null,
    staleFloorMs: silentForMs > 0 ? staleFloorMs : staleFloorMs,
  };
}

/** One candidate as read from PG, before the verdict is applied. */
export interface SilentHaltCandidate {
  ownerId: string;
  workspaceId: string;
  routineId: string;
  intervalSec: number | null;
  heartbeatAgeMs: number | null;
  inactiveForMs: number | null;
  pendingAwaits: number;
  /** Non-terminal, non-observation actionable work-items this session still holds (`taken_by`). */
  heldWorkItems: number;
  /** Held rows excluded because they are parked on active typed external blockers. */
  blockerParkedWorkItemIds?: string[];
  /** The subset of those whose blocker names no re-check time (WI-6554700010018551). */
  unboundedBlockerParkedWorkItemIds?: string[];
  modes: Array<{ mode: string }>;
  /** Fleet the session belongs to (presence row), for the park-contract framing. */
  fleetSlug?: string | null;
}

/** One wake marker row as the rung reads it back from its own outbox. */
export interface SilentHaltWakeMarker {
  to: readonly string[];
  summary?: string | null;
  /** ISO-8601 — when the wake was attempted. */
  ts?: string | null;
}

export interface SilentHaltSweepDeps {
  broadcast?: typeof broadcastSevereEvent;
  resolveCondition?: (key: string) => Promise<unknown>;
  /** Injectable for tests; defaults to the real candidate read. */
  readCandidates?: (workspaceId: string, sql: Sql) => Promise<SilentHaltCandidate[]>;
  /** Injectable for tests; defaults to the shared `getLoopStatuses` accessor. */
  readLoopStatuses?: typeof getLoopStatuses;
  /**
   * Injectable for tests; defaults to a dynamically-imported `notifyAttentionOnce`. Return
   * `{ intentCreated: false }` when the page already existed for this (owner, epoch): a replay
   * neither counts against the per-sweep page cap nor re-alerts the fleet leader (D-006 (3)/(4)).
   * Older injected adapters may return `{ deduped: true }` or void.
   */
  notify?: (payload: ReplaySafeAttentionNotifyInput) => Promise<{ intentCreated?: boolean | null; deduped?: boolean } | void>;
  /**
   * Classifies the halted session's psu host (P-007 slice 2, D-006 (2)); defaults to the
   * stalled-loops guard's `readStalledLoopHost` + `classifyStalledLoopHost`. `null` = unreadable,
   * which keeps today's wake-first behaviour.
   */
  readHostClass?: (ownerId: string, nowMs: number) => Promise<StalledLoopHostClass | null>;
  /**
   * Alerts a halted fleet member's CURRENT leader beside the owner page (D-006 (3)); defaults to
   * resolving `@fleet-leader:<slug>` with `expandAudience` and sending + waking that leader.
   */
  alertFleetLeader?: (fleetSlug: string, summary: string, body: string, workspaceId: string) => Promise<void>;
  nowMs?: number;
  /** P-003 wake-first rung on/off. Defaults to the SILENT_HALT_WAKE_FIRST flag (fail-closed). */
  wakeFirstEnabled?: boolean;
  /** Reads this rung's own outbox markers; defaults to `readOutbox(SILENT_HALT_WAKE_OWNER)`. */
  readWakeMarkers?: (sinceIso: string) => Promise<readonly SilentHaltWakeMarker[]>;
  /** Writes the durable marker/inbox row (BEFORE the wake fires); defaults to `sendMessage`. */
  sendWakeMessage?: (ownerId: string, summary: string, body: string) => Promise<void>;
  /** Fires the actual wake; defaults to `wakeRecipients`. */
  fireWake?: (ownerId: string, summary: string, workspaceId: string) => Promise<void>;
  /** Engine-loop rows for the end classification; defaults to `readEngineLoopRowsByOwner`. */
  readEngineLoopRows?: typeof readEngineLoopRowsByOwner;
  /** Fleet park path for the park-contract framing; defaults to `getFleet` + resolver. */
  readFleetParkPath?: (workspaceId: string, fleetSlug: string) => Promise<FleetParkResumePath | null>;
}

export interface SilentHaltSweepResult {
  checked: number;
  halted: string[];
  /**
   * The subset of `halted` whose only strand is a blocker park that names no wake. They are woken
   * once per disarm epoch and never paged (WI-6554700010018551).
   */
  wakeOnly: string[];
  paged: string[];
  /** Owners the wake-first rung WOKE this tick (P-003) — deliberately NOT paged this tick. */
  woken: string[];
  /** Halted fleet members whose CURRENT leader was alerted with a newly created page (D-006 (3)). */
  fleetLeaderAlerted: string[];
  /** ownerId → the named exemption, so a zero-page sweep is explicable rather than mute. */
  exempt: Record<string, string>;
  dryRun: boolean;
  /** True when more wake-spent halts were found than `SILENT_HALT_MAX_PAGES_PER_SWEEP`. */
  pageCapReached: boolean;
  /** True when more unwoken halts were found than `SILENT_HALT_MAX_WAKES_PER_SWEEP`. */
  wakeCapReached: boolean;
}

/**
 * Read the candidate set. Deliberately CHEAP and broad: it applies only the terms expressible as
 * a cheap index-friendly predicate and leaves every judgement to `evaluateSilentHalt`, so the
 * verdict has exactly one home.
 *
 * NOTE the `event_awaits` scoping. That table stores every row under the literal
 * workspace_id='default' (the corpus namespace, hardcoded in search/session-ingest.ts), so it
 * MUST be joined on `subscriber_id` alone. Filtering it by a real workspace matches zero rows
 * and silently disables the no-pending-await term while returning a clean, confident result —
 * measured live while writing this file, and the reason the term is joined this way.
 */
/**
 * owner → how many of its open awaits are wake sources, per the shared predicate. Exported for the
 * test: it is the seam where this detector meets `wake-source-predicate`.
 */
export async function countPendingWakeSources(
  ownerIds: readonly string[],
  inboxWakePrefix: string,
  sql: Sql,
): Promise<Map<string, number>> {
  const awaits = await readOpenAwaitsForSubscribers(ownerIds, sql);
  if (awaits.length === 0) return new Map();
  const targets = await readWorkItemAwaitTargets(awaits, sql);
  return countWakeSourcesBySubscriber(awaits, targets, inboxWakePrefix);
}

async function defaultReadCandidates(workspaceId: string, sql: Sql): Promise<SilentHaltCandidate[]> {
  // Lazy, like the wake leg's `wakeRecipients` import: keeps inbox-wake's graph out of this module.
  const { COORD_INBOX_WAKE_PREFIX: inboxWakePrefix } = await import('../../agent-tools/coordination/inbox-wake');
  const rows = await sql<
    Array<{
      owner_id: string;
      workspace_id: string;
      routine_id: string;
      interval_sec: number | null;
      fleet_slug: string | null;
      heartbeat_age_ms: string | number | null;
      inactive_for_ms: string | number | null;
      modes: string[] | null;
    }>
  >`
    WITH loops AS (
      SELECT r.id AS routine_id, r.target_owner_id AS owner_id, r.workspace_id,
             r.reschedule_interval_sec AS interval_sec, r.active_changed_at
        FROM harness_shared.routines r
       WHERE r.name LIKE 'loop-%'
         AND r.target_owner_id IS NOT NULL
         AND r.workspace_id = ${workspaceId}
         AND r.active = false
    )
    SELECT l.routine_id, l.owner_id, l.workspace_id, l.interval_sec,
           p.fleet_slug,
           round(extract(epoch from (now() - p.heartbeat_at)) * 1000)     AS heartbeat_age_ms,
           round(extract(epoch from (now() - l.active_changed_at)) * 1000) AS inactive_for_ms,
           array_agg(DISTINCT m.mode)                                      AS modes
      FROM loops l
      JOIN harness_shared.agent_modes m
        ON m.owner_id = l.owner_id AND m.workspace_id = l.workspace_id
      JOIN harness_shared.coord_presence p
        ON p.owner_id = l.owner_id AND p.workspace_id = l.workspace_id
     WHERE p.heartbeat_at > now() - make_interval(secs => ${SILENT_HALT_HEARTBEAT_FRESH_MS / 1000})
     GROUP BY l.routine_id, l.owner_id, l.workspace_id, l.interval_sec,
              p.fleet_slug, p.heartbeat_at, l.active_changed_at`;

  if (rows.length === 0) return [];

  // Read held rows once, then classify them with D-010/P-010's shared parser. SQL must not grow
  // a second interpretation of which external blockers are active.
  const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
  const heldRows = await sql<
    Array<{
      owner_id: string;
      work_item_id: string;
      status: string | null;
      external_blockers: unknown;
    }>
  >`
    /* silent-halt-held-work */
    SELECT w.taken_by AS owner_id, w.feature_id AS work_item_id, w.status,
           w.payload->'externalBlockers' AS external_blockers
      FROM harness_shared.work_items w
     WHERE w.taken_by = ANY(${ownerIds}::text[])
       AND w.lane IS DISTINCT FROM 'observation'
       AND w.status NOT IN ('done','dropped','passed','deprecated','resolved','closed')`;
  const heldByOwner = new Map<
    string,
    { actionableCount: number; blockerParkedIds: string[]; unboundedParkedIds: string[] }
  >();
  for (const held of heldRows) {
    const current = heldByOwner.get(held.owner_id) ?? {
      actionableCount: 0,
      blockerParkedIds: [],
      unboundedParkedIds: [],
    };
    if (isParkedOnExternalBlocker({ status: held.status, externalBlockers: held.external_blockers })) {
      current.blockerParkedIds.push(held.work_item_id);
      // Same parser, same payload shape: a blocker with no re-check time names no wake.
      if (activeBlockersWithoutRecheck({ externalBlockers: held.external_blockers }).length > 0) {
        current.unboundedParkedIds.push(held.work_item_id);
      }
    } else {
      current.actionableCount += 1;
    }
    heldByOwner.set(held.owner_id, current);
  }

  // The wake-source count comes from the ONE shared predicate (D-008 (1)), never re-derived here:
  // it drops the session's own inbox watcher (D-006), a self-held `work-item:done:<X>`, and an
  // await on a terminal or absent item. Untimed live awaits still count (D-009: this detector
  // stays lenient; only loop:end demands a GUARANTEED wake source).
  const pending = await countPendingWakeSources(
    rows.map((r) => r.owner_id),
    inboxWakePrefix,
    sql,
  );

  return rows.map((r) => {
    const held = heldByOwner.get(r.owner_id) ?? { actionableCount: 0, blockerParkedIds: [], unboundedParkedIds: [] };
    return {
      ownerId: r.owner_id,
      workspaceId: r.workspace_id,
      routineId: r.routine_id,
      intervalSec: r.interval_sec == null ? null : Number(r.interval_sec),
      heartbeatAgeMs: r.heartbeat_age_ms == null ? null : Number(r.heartbeat_age_ms),
      inactiveForMs: r.inactive_for_ms == null ? null : Number(r.inactive_for_ms),
      pendingAwaits: pending.get(r.owner_id) ?? 0,
      heldWorkItems: held.actionableCount,
      blockerParkedWorkItemIds: held.blockerParkedIds.sort(),
      unboundedBlockerParkedWorkItemIds: held.unboundedParkedIds.sort(),
      modes: (r.modes ?? []).filter(Boolean).map((mode) => ({ mode })),
      fleetSlug: r.fleet_slug ?? null,
    };
  });
}

/**
 * Sweep for silently-halted autonomous sessions and page the OWNER once per halt epoch.
 *
 * Writes nothing to the loop. Unlike its siblings this module does NOT disarm, re-arm, or
 * otherwise touch the session: by construction its subjects are already stopped, and the one
 * thing a halted agent provably cannot do is act on a message. The remedy is a human.
 */
export async function sweepSilentHalts(opts: {
  workspaceId: string;
  dryRun?: boolean;
  sql?: Sql;
  deps?: SilentHaltSweepDeps;
}): Promise<SilentHaltSweepResult> {
  const deps = opts.deps ?? {};
  const sql = opts.sql ?? getOrgPg().sql;
  const dryRun = opts.dryRun === true;
  const nowMs = deps.nowMs ?? Date.now();

  const readCandidates = deps.readCandidates ?? defaultReadCandidates;
  const candidates = await readCandidates(opts.workspaceId, sql);

  const result: SilentHaltSweepResult = {
    checked: candidates.length,
    halted: [],
    wakeOnly: [],
    paged: [],
    woken: [],
    fleetLeaderAlerted: [],
    exempt: {},
    dryRun,
    pageCapReached: false,
    wakeCapReached: false,
  };
  const conditionKey = `alarm:silent-halt:${opts.workspaceId}`;
  const resolveCondition = deps.resolveCondition ?? ((key: string) => resolveAlarm(key, 'silent-halt-reconcile'));
  if (candidates.length === 0) {
    if (!dryRun) await resolveCondition(conditionKey).catch(() => {});
    return result;
  }

  // One round-trip for every candidate's lastRealTurnAt, through the SAME accessor loop:status
  // uses — never a second local derivation of "produced a turn".
  const readStatuses = deps.readLoopStatuses ?? getLoopStatuses;
  let statuses: Awaited<ReturnType<typeof getLoopStatuses>>;
  try {
    statuses = await readStatuses(
      candidates.map((c) => c.ownerId),
      { sql },
    );
  } catch (e) {
    console.warn(
      `[silent-halt-reconcile] loop-status read failed; sweeping without turn evidence: ` +
        `${e instanceof Error ? e.message : e}`,
    );
    statuses = new Map();
  }

  const halted: Array<{
    candidate: SilentHaltCandidate;
    verdict: SilentHaltVerdict;
    lastRealTurnAtMs: number | null;
  }> = [];
  for (const c of candidates) {
    const status = statuses.get(c.ownerId);
    const lastRealTurnAt = status?.lastRealTurnAt ?? null;
    const lastRealTurnAgeMs = lastRealTurnAt ? nowMs - Date.parse(lastRealTurnAt) : null;

    const verdict = evaluateSilentHalt({
      // Re-read `active` from the status when available: the candidate query and this read are
      // separate round-trips, and an agent that re-armed in between must not be paged about.
      loopActive: status?.active === true,
      hasPosture: hasAutonomyPosture(c.modes),
      pendingAwaits: c.pendingAwaits,
      heartbeatAgeMs: c.heartbeatAgeMs,
      lastRealTurnAgeMs: Number.isFinite(lastRealTurnAgeMs as number) ? lastRealTurnAgeMs : null,
      inactiveForMs: c.inactiveForMs,
      intervalSec: c.intervalSec,
      heldWorkItems: c.heldWorkItems,
      blockerParkedWorkItemIds: c.blockerParkedWorkItemIds,
      unboundedBlockerParkedWorkItemIds: c.unboundedBlockerParkedWorkItemIds,
    });

    if (!verdict.halted) {
      result.exempt[c.ownerId] = verdict.exemption ?? 'unspecified';
      continue;
    }
    result.halted.push(c.ownerId);
    if (verdict.wakeOnly) result.wakeOnly.push(c.ownerId);
    halted.push({
      candidate: c,
      verdict,
      lastRealTurnAtMs:
        lastRealTurnAt != null && Number.isFinite(Date.parse(lastRealTurnAt))
          ? Date.parse(lastRealTurnAt)
          : null,
    });
  }

  if (dryRun) return result;
  // A wake-only halt (its one strand is a blocker park that names no wake) gets the wake rung and
  // nothing else: it never raises or holds open the owner-facing condition, and never pages
  // (WI-6554700010018551; the owner rejected verification-ceremony pages 2026-09-23).
  const pageable = halted.filter((h) => !h.verdict.wakeOnly);
  if (pageable.length === 0) {
    // A missing/failed status read cannot establish recovery of the aggregate.
    if (candidates.every((candidate) => statuses.has(candidate.ownerId))) {
      await resolveCondition(conditionKey).catch(() => {});
    }
    if (halted.length === 0) return result;
  }
  // Refresh the condition before wake/page dedup or caps; an attempted wake is not recovery.
  const event = {
    category: 'silent-halt-reconcile',
    summary: `${pageable.length} autonomous session(s) silently halted while holding work`,
    body: pageable.map(({ candidate, verdict }) => `${candidate.ownerId}: ${verdict.reason}`).join('\n'),
    conditionKey, oneShot: true,
  };
  const conditionPublished =
    pageable.length === 0
      ? false
      : deps.broadcast
        ? await deps.broadcast(event).catch(() => false)
        : await broadcastSevereEvent(event).catch(() => false);

  // ── P-003 wake-first rung (R1/R2) ──────────────────────────────────────────────
  // ONE wake attempt per (owner, disarm epoch) BEFORE any owner page. The dedupe
  // marker is this rung's own outbox row — written before the wake fires, so a crash
  // between the two counts as attempted (never a re-wake storm), and the whole bound
  // is derived from PG with no new table (R2). The page becomes the NEXT tick's
  // fallback when the wake demonstrably produced no recovery (plan D-001/D-004).
  const wakeFirstEnabled =
    deps.wakeFirstEnabled ??
    (await (async () => {
      const [{ getFlag }, { FLAGS }] = await Promise.all([
        import('@papercusp/flags/server'),
        import('@papercusp/flags'),
      ]);
      return getFlag(FLAGS.SILENT_HALT_WAKE_FIRST, 'system');
    })().catch(() => false)); // fail-CLOSED: a wake is a billable turn; the page is the established fallback

  // Read the markers. A FAILED read must disable the rung for this tick (page-only,
  // the pre-P-003 behavior) rather than read as "no marker": that direction would
  // re-wake every candidate on every tick for as long as the read stays broken.
  let markers: readonly SilentHaltWakeMarker[] | null = null;
  if (wakeFirstEnabled) {
    const readMarkers =
      deps.readWakeMarkers ??
      (async (sinceIso: string): Promise<readonly SilentHaltWakeMarker[]> => {
        const { readOutbox } = await import('../../agent-tools/coordination/messages');
        return readOutbox(SILENT_HALT_WAKE_OWNER, { since_ts: sinceIso });
      });
    // Look back to the oldest disarm among the halted (plus slack), bounded at 14d.
    const oldestDisarmMs = halted.reduce(
      (min, h) =>
        h.candidate.inactiveForMs != null ? Math.min(min, nowMs - h.candidate.inactiveForMs) : min,
      nowMs,
    );
    const lookbackMs = Math.min(
      Math.max(nowMs - oldestDisarmMs + 60 * 60 * 1000, 60 * 60 * 1000),
      14 * 24 * 60 * 60 * 1000,
    );
    try {
      markers = await readMarkers(new Date(nowMs - lookbackMs).toISOString());
      observeFallback('routine-capability-read', { eligible: 1, applied: 1, reason: 'applied', scope: 'silent-halt-wake-markers' });
    } catch (e) {
      observeFallback('routine-capability-read', { eligible: 1, applied: 0, reason: 'wake-markers-unavailable', scope: 'silent-halt-wake-markers' });
      markers = null;
      console.warn(
        `[silent-halt-reconcile] wake-marker read failed; falling back to page-only this tick: ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }
  }
  const rungLive = wakeFirstEnabled && markers != null;

  // End classification (plan D-003/D-005): consumed for FRAMING — the wake body tells
  // a parked member its way back, and the page tells the owner what kind of stop this
  // was. It deliberately does NOT gate the wake: every candidate here has an inactive
  // loop row by construction (the candidate query keys on them), so the standdown
  // conjunct is uniformly true over this population and gating on it would nullify R1.
  const readRows = deps.readEngineLoopRows ?? readEngineLoopRowsByOwner;
  const loopRows = await readRows(
    halted.map((h) => h.candidate.ownerId),
    { workspaceId: opts.workspaceId, sql },
  ).catch(() => null);
  const readParkPath =
    deps.readFleetParkPath ??
    (async (workspaceId: string, fleetSlug: string): Promise<FleetParkResumePath | null> => {
      const { getFleet } = await import('../../agent-fleets-store');
      const fleet = await getFleet(workspaceId, fleetSlug).catch(() => null);
      return fleet ? resolveFleetParkResumePath(fleet, nowMs) : null;
    });
  const parkBySlug = new Map<string, FleetParkResumePath | null>();
  const parkFor = async (c: SilentHaltCandidate): Promise<FleetParkResumePath | null> => {
    const slug = c.fleetSlug ?? null;
    if (!slug) return null;
    if (!parkBySlug.has(slug)) {
      parkBySlug.set(slug, await readParkPath(opts.workspaceId, slug).catch(() => null));
    }
    return parkBySlug.get(slug) ?? null;
  };

  type ActuationEntry = (typeof halted)[number] & {
    epochToken: string;
    marker: SilentHaltWakeMarker | null;
    classification: SessionEndClassification;
    parkPath: FleetParkResumePath | null;
    /** The session's psu host, classified (D-006 (2)); null = unreadable. */
    host: StalledLoopHostClass | null;
  };
  const readHost =
    deps.readHostClass ??
    (async (ownerId: string, atMs: number): Promise<StalledLoopHostClass | null> => {
      const [{ readStalledLoopHost }, { classifyStalledLoopHost }] = await Promise.all([
        import('./stalled-loops-guard'),
        import('../../events/await/host-recovery-eligibility'),
      ]);
      return classifyStalledLoopHost(await readStalledLoopHost(ownerId), ownerId, atMs);
    });
  const hosts = await Promise.all(
    halted.map((h) =>
      readHost(h.candidate.ownerId, nowMs).catch((e) => {
        console.warn(
          `[silent-halt-reconcile] host read for ${h.candidate.ownerId} failed (wake-first kept): ` +
            `${e instanceof Error ? e.message : e}`,
        );
        return null;
      }),
    ),
  );
  const entries: ActuationEntry[] = [];
  for (const [i, h] of halted.entries()) {
    const epochToken = disarmEpochToken(nowMs, h.candidate.inactiveForMs);
    const summary = wakeMarkerSummary(h.candidate.ownerId, epochToken);
    const marker = rungLive ? ((markers ?? []).find((m) => m.summary === summary) ?? null) : null;
    const parkPath = await parkFor(h.candidate);
    entries.push({
      ...h,
      epochToken,
      marker,
      classification: classifyEndedHolder({
        engineLoopRows: loopRows,
        ownerId: h.candidate.ownerId,
        parkPath,
        heldWorkItems: h.candidate.heldWorkItems,
      }),
      parkPath,
      host: hosts[i] ?? null,
    });
  }

  // A host that needs a RELAUNCH (unbound carry-respawn child, or a wall a wake cannot clear) is
  // never woken: the wake would bounce off it, and waking wedged sessions en masse is exactly what
  // D-002 forbids. It is paged at once, with the remedy, instead (D-006 (2)).
  const needsRelaunch = (e: ActuationEntry): boolean => e.host?.kind === 'needs-relaunch';
  const isWakeOnly = (e: ActuationEntry): boolean => e.verdict.wakeOnly === true;
  const toWake = rungLive
    ? entries
        .filter((e) => e.marker == null && !needsRelaunch(e))
        // Actionable strands first, so the per-sweep cap never defers them behind wake-only ones.
        .sort((a, b) => Number(isWakeOnly(a)) - Number(isWakeOnly(b)))
    : [];
  const toPage = (rungLive ? entries.filter((e) => e.marker != null || needsRelaunch(e)) : entries).filter(
    (e) => !isWakeOnly(e),
  );

  // WAKE leg — bounded fan (R2). Overflow is DEFERRED whole: an unwoken candidate has
  // not had its R1 wake yet, so it must not fall through to the page either.
  result.wakeCapReached = toWake.length > SILENT_HALT_MAX_WAKES_PER_SWEEP;
  const waking = toWake.slice(0, SILENT_HALT_MAX_WAKES_PER_SWEEP);
  if (waking.length > 0) {
    const send =
      deps.sendWakeMessage ??
      (async (ownerId: string, summary: string, body: string) => {
        const { sendMessage } = await import('../../agent-tools/coordination/messages');
        await sendMessage(
          {
            ownerId: SILENT_HALT_WAKE_OWNER,
            ownerLabel: SILENT_HALT_WAKE_OWNER,
            source: 'static-client',
            workspaceId: null,
            userId: null,
          },
          { to: [ownerId], summary, body },
        );
      });
    const fire =
      deps.fireWake ??
      (async (ownerId: string, summary: string, workspaceId: string) => {
        const { wakeRecipients } = await import('../../agent-tools/coordination/inbox-wake');
        await wakeRecipients([ownerId], { summary, source: SILENT_HALT_WAKE_OWNER, workspaceId });
      });
    for (const e of waking) {
      const owner = e.candidate.ownerId;
      const summary = wakeMarkerSummary(owner, e.epochToken);
      try {
        // Marker FIRST: an unmarked wake would break the ≤1-per-epoch bound on the next
        // tick. If the marker cannot be written, skip the wake — the next tick retries.
        await send(owner, summary, silentHaltWakeBody(e.candidate, e.verdict, e.parkPath));
      } catch (err) {
        console.warn(
          `[silent-halt-reconcile] wake marker write for ${owner} failed (wake skipped): ` +
            `${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      await fire(owner, summary, opts.workspaceId).catch((err) =>
        console.warn(
          `[silent-halt-reconcile] wake for ${owner} failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
      result.woken.push(owner);
    }
  }

  if (toPage.length === 0) return result;

  // PAGE leg — unchanged mechanics; with the rung live it now fires only for a
  // candidate whose disarm epoch already spent its wake attempt.
  // A mass halt is ONE incident (a wedged host, a deploy, an operator restart), not N — page a
  // bounded sample and name the total, the same reasoning stalled-loops-guard applies to its
  // fleet-wide broadcast.
  // The cap counts NEWLY created pages only (D-006 (4)): a session that stays halted re-presents
  // every sweep and its page dedupes, and counting those let a standing set of 5 still-halted
  // sessions starve every new halt out of the cap indefinitely.
  let newPages = 0;

  const notify =
    deps.notify ??
    (async (payload: ReplaySafeAttentionNotifyInput) => {
      // Keep the original owner-alarm producer on the rail too. Retry its failed
      // aggregate delivery before paging, without duplicating a successful broadcast.
      if (!conditionPublished) await broadcastSevereEvent(event).catch(() => false);
      const { notifyAttentionOnce } = await import('../../attention-notify');
      return notifyAttentionOnce(payload);
    });
  const alertFleetLeader =
    deps.alertFleetLeader ??
    (async (fleetSlug: string, summary: string, body: string, workspaceId: string) => {
      const [{ expandAudience }, { hostAudienceResolvers, audienceMode }, { sendMessage }, { wakeRecipients }] =
        await Promise.all([
          import('../../agent-tools/coordination/audience'),
          import('../../agent-tools/coordination/audience-host'),
          import('../../agent-tools/coordination/messages'),
          import('../../agent-tools/coordination/inbox-wake'),
        ]);
      const leaders = await expandAudience([`@fleet-leader:${fleetSlug}`], hostAudienceResolvers, audienceMode());
      if (leaders.length === 0) return;
      await sendMessage(
        {
          ownerId: SILENT_HALT_WAKE_OWNER,
          ownerLabel: SILENT_HALT_WAKE_OWNER,
          source: 'static-client',
          workspaceId: null,
          userId: null,
        },
        { to: leaders, summary, body },
      );
      await wakeRecipients(leaders, { summary, source: SILENT_HALT_WAKE_OWNER, workspaceId });
    });

  for (const entry of toPage) {
    if (newPages >= SILENT_HALT_MAX_PAGES_PER_SWEEP) {
      result.pageCapReached = true;
      break;
    }
    const { candidate, verdict, epochToken, marker, classification, parkPath, lastRealTurnAtMs, host } = entry;
    // One page per (owner, disarm epoch). A session that STAYS halted never re-pages; one that
    // is re-armed and halts again gets a new epoch, because that is a genuinely new fault.
    const dedupeKey = `silent-halt:${candidate.ownerId}:${epochToken}`;
    const inactiveMin = candidate.inactiveForMs != null ? Math.round(candidate.inactiveForMs / 60000) : null;
    const attemptedAt = marker?.ts ?? null;
    const attemptedAtMs = attemptedAt != null ? Date.parse(attemptedAt) : Number.NaN;
    const turnFollowedWake =
      Number.isFinite(attemptedAtMs) && lastRealTurnAtMs != null && lastRealTurnAtMs > attemptedAtMs;
    const wakeLine =
      marker != null
        ? `\n\nA system wake was already attempted${attemptedAt ? ` at ${attemptedAt}` : ''} in this disarm ` +
          `epoch and ${
            turnFollowedWake
              ? 'a turn followed, but the session halted again with the same held work'
              : 'produced no real turn'
          } — escalating to you (wake-before-page).`
        : '';
    const classificationLine =
      `\n\nEnd classification (derived): ${classification}.` +
      (parkPath?.parked ? ` Fleet park state: ${describeParkResumePath(parkPath)}` : '');

    // D-006 (2): a host that needs a relaunch was deliberately NOT woken — say why, and what fixes it.
    const hostLine =
      host?.kind === 'needs-relaunch'
        ? `\n\nHOST UNHEALTHY (${host.condition}): ${host.why} No wake was attempted, because a ` +
          `wake cannot fix this. ${host.remedy}`
        : '';
    const title =
      `Autonomous session ${candidate.ownerId} is alive but has taken no turns` +
      (inactiveMin != null ? ` for ${inactiveMin}m` : '') +
      ` — nothing will wake it`;
    const body =
      `${verdict.reason}.\n\n` +
      `This session's process is still running (its presence heartbeat is current), it holds a ` +
      `registered autonomy posture (${candidate.modes.map((m) => m.mode).join(', ')}), and its ` +
      `engine loop is INACTIVE with no pending events:await other than its own inbox watcher, ` +
      `which fires only if somebody messages it. There is therefore no wake source it can count ` +
      `on: a paused loop does not fire, no await will resolve on its own, and the one warning ` +
      `designed to catch this (coord:orient's wakeSourceLostWarning) is only ever delivered ON a ` +
      `wake. It will take no further turns, and any plan or work-item it was advancing stops ` +
      `exactly where it is, until something acts.\n\n` +
      `To bring it back: resume the session and re-arm its loop (loop:arm). If it was stopped ` +
      `by a bound it should not have had, re-arm without maxFires/maxDurationSec. If it was ` +
      `stopped by a zero-tool escalation, check for a provider usage wall first — a wall makes ` +
      `an agent look inert without anything being wrong with it.\n\n` +
      `Loop routine: ${candidate.routineId}` +
      hostLine +
      wakeLine +
      classificationLine;

    try {
      const outcome = await notify({
        kind: 'intervention',
        title,
        body,
        importance: 'urgent',
        workspaceId: candidate.workspaceId,
        dedupeKey,
        data: {
          ownerId: candidate.ownerId,
          routineId: candidate.routineId,
          reason: verdict.reason ?? '',
          modes: candidate.modes.map((m) => m.mode).join(','),
          inactiveForMin: inactiveMin,
          totalHalted: halted.length,
          wakeAttemptedAt: attemptedAt,
          endClassification: classification,
          hostClass: host?.kind ?? null,
        },
      });
      result.paged.push(candidate.ownerId);
      // Channel delivery is a separate decision: an existing intent can still have an
      // unfinished channel. Only a NEW intent spends this cap or alerts the leader.
      // Preserve legacy injected adapters and fail-soft paging when reservation is unknown.
      const existingIntent = typeof outcome === 'object' && outcome !== null && (
        outcome.intentCreated === false || (outcome.intentCreated == null && outcome.deduped === true)
      );
      if (existingIntent) continue;
      newPages++;
      // D-006 (3): the fleet's leader can re-place the held work; the owner page alone leaves a
      // fleet member's lane frozen until a human reads it. Same epoch dedupe as the page.
      if (candidate.fleetSlug) {
        try {
          await alertFleetLeader(
            candidate.fleetSlug,
            `silent-halt: fleet member ${candidate.ownerId} is halted holding ` +
              `${candidate.heldWorkItems} work-item(s) — inspect checkpoints; re-place or resume only if their gates permit`,
            `${title}.\n\nBefore re-placing or resuming, re-read each held item's checkpoint and governing decision. ` +
              `Preserve any named evidence gate or explicit stop until its condition is satisfied.\n\n${body}`,
            candidate.workspaceId,
          );
          result.fleetLeaderAlerted.push(candidate.ownerId);
        } catch (e) {
          console.warn(
            `[silent-halt-reconcile] fleet-leader alert for ${candidate.ownerId} ` +
              `(${candidate.fleetSlug}) failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    } catch (e) {
      // A downed push transport must never turn a successful detection into a thrown routine —
      // the remaining candidates still deserve their page.
      console.warn(
        `[silent-halt-reconcile] owner page failed for ${candidate.ownerId}: ` +
          `${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return result;
}

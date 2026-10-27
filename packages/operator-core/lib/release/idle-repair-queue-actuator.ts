/**
 * Idle frozen-repair-queue ACTUATOR — plan green-main-cycle-time-2026-10-08 P-002 (WI-10007476).
 *
 * ## What this replaces
 *
 * `checkStrandedRepairQueue` (green-stall-watchdog.ts) used to answer a stalled frozen queue with
 * a fleet-wide `broadcastSevereEvent` ("Frozen repair queue has held main ~Nh") on every 8h age
 * rung. Nobody acted on it: on 2026-10-08 the 65h alarm made at least four agents each spend a
 * turn reading gate ownership and replying, while the gate already had a live owner. A broadcast
 * that names no actor and performs no action costs turns and moves nothing.
 *
 * ## What this does instead
 *
 * When no repair round has STARTED for more than {@link IDLE_REPAIR_QUEUE_MS} while failing legs
 * exist, it climbs a three-rung ladder, at most one rung per idle episode each:
 *
 *   1. `dispatch-fixer`  — dispatch the release fixer (only when the queue awaits one).
 *   2. `wake-gate-owner` — failing that, wake the CURRENT gate holder directly, naming the next
 *                          action for the queue's phase.
 *   3. `escalate-owner`  — failing that, raise an urgent intervention on the human owner's
 *                          attention surface.
 *
 * "Failing that" means one of three things. The rung did not apply (no fixer is awaited, or no
 * wakeable gate holder exists), so the next rung runs in the same pass. Its action failed, so the
 * next rung also runs in the same pass. Or it acted and still no round started within
 * {@link IDLE_RUNG_GRACE_MS}, so the next rung runs on a later tick.
 *
 * ## The idle episode
 *
 * An episode is keyed by `(candidate, idleSinceMs)` where `idleSinceMs` is the latest of the
 * queue's open, admission, and repair-verification-start timestamps. A new admission or round
 * starting moves `idleSinceMs`, which starts a fresh episode, so a queue that keeps stalling is
 * acted on again, once per stall, never once per tick. A checkpoint run lock also suppresses
 * action while any scheduled or manual suite is active. With all three rungs spent the episode
 * is `exhausted` and the actuator stays silent until the queue moves.
 *
 * The decision half ({@link decideIdleQueueAction}) is PURE. The pass
 * ({@link runIdleQueueActuatorPass}) takes every effect as an injected dependency, so the
 * stalled-queue fixture in the test file walks the real ladder without a database.
 */

import type { Sql } from 'postgres';
import type { ReleaseFixerDispatchSkip } from '../harness/routines/release-actions';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  type FrozenCandidateRepairQueue,
  type FrozenRepairQueueLimits,
} from './frozen-candidate-repair-queue';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';
import {
  currentRepairLimbExecutor,
  parseRepairLimbExecutor,
  type RepairLimbExecutor,
} from './repair-limb-executor';

export const IDLE_REPAIR_QUEUE_MS = 60 * 60_000;
export const IDLE_RUNG_GRACE_MS = 30 * 60_000;
/** Retry one accepted fixer launch if its queue assignment is absent or confirmed dead. */
export const IDLE_DISPATCH_RETRY_LIMIT = 1;
/** Below the 15-min watchdog interval, so the ladder runs once per tick across all hosts. */
export const IDLE_PASS_LEASE_MS = 10 * 60_000;
/** `harness_escalations.phase` the episode is persisted under (one row per install). */
export const IDLE_REPAIR_QUEUE_PHASE = 'idle-repair-queue-actuator';

export const IDLE_QUEUE_RUNGS = ['dispatch-fixer', 'wake-gate-owner', 'escalate-owner'] as const;
export type IdleQueueRung = (typeof IDLE_QUEUE_RUNGS)[number];

/**
 * `acted` = the rung's action happened (or, for `dispatch-fixer`, a live fixer already exists);
 * the next rung waits out the grace. `failed` / `not-applicable` = the next rung runs at once.
 */
export type IdleRungOutcome = 'acted' | 'failed' | 'not-applicable';

export interface IdleRungRecord {
  atMs: number;
  outcome: IdleRungOutcome;
  detail: string;
}

export interface IdleQueueEpisode {
  candidate: string;
  idleSinceMs: number;
  rungs: Partial<Record<IdleQueueRung, IdleRungRecord>>;
  /** Durable budget for the one retry after an acted dispatch leaves no live fixer assignment. */
  dispatchRetryCount?: number;
  /** A deterministic refusal survives idle-clock resets, until its head or verdict changes. */
  dispatchRefusal?: { repairHead: string; lastVerdictAtMs: number | null; detail: string };
}

export interface IdleQueueSnapshot {
  candidate: string;
  repairHead: string;
  phase: string;
  openedAtMs: number;
  lastAdmittedAtMs: number | null;
  lastResumeRunStartedAtMs: number | null;
  lastVerdictAtMs?: number | null;
  /** null = the run-lock probe failed, so the actuator must preserve state without acting. */
  runInFlight: boolean | null;
  /** Failing legs still outstanding on the frozen candidate (the queue's `failingTests`). */
  failingLegs: number;
  fixerSpawnId: string | null;
  /** true = live, false = definitively dead, null = unknown / none recorded. */
  fixerAlive: boolean | null;
  /** The gate holder's ownerId, or null when nobody holds the gate. */
  gateHolder: string | null;
  /** True only when the holder's session can take a turn (live or parked). */
  gateHolderWakeable: boolean;
  blockedReason: string | null;
}

export type IdleQueueDecision =
  | { kind: 'not-idle'; reason: string }
  | { kind: 'wait'; reason: string; episode: IdleQueueEpisode; nextRungAtMs: number }
  | { kind: 'act'; rung: IdleQueueRung; reason: string; nextAction: string; episode: IdleQueueEpisode }
  | { kind: 'exhausted'; reason: string; episode: IdleQueueEpisode };

const short = (sha: string): string => sha.slice(0, 12);

function hoursText(ms: number): string {
  const h = ms / 3_600_000;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

/** The single concrete step that moves a queue in this phase. Named in every rung's message. */
export function namedNextAction(s: IdleQueueSnapshot, episode?: IdleQueueEpisode): string {
  if (episode?.dispatchRefusal) {
    return `Fire release:checkpoint-run for a fresh measured verdict on repairHead ${short(s.repairHead)} before dispatching another fixer.`;
  }
  switch (s.phase) {
    case 'awaiting-fixer':
      return (
        `Dispatch a release fixer for frozen candidate ${short(s.candidate)}, or author the fix on staging ` +
        `and land it with release:repair-queue { op:'admit', paths:[...] }.`
      );
    case 'ready-to-test':
      return `Fire release:checkpoint-run: it resumes the frozen candidate ${short(s.candidate)} (no new cut).`;
    case 'ready-to-verify':
      return `Fire release:checkpoint-run: it re-tests repairHead ${short(s.repairHead)} on the frozen lineage.`;
    case 'blocked':
      return (
        `Read release:repair-queue { op:'status' } (blocked: ${s.blockedReason ?? 'reason not recorded'}); ` +
        `retire only per the documented unreachable-green test.`
      );
    default:
      return `Read release:repair-queue { op:'status' } for the per-leg picture.`;
  }
}

function notApplicableReason(rung: IdleQueueRung, s: IdleQueueSnapshot): string | null {
  switch (rung) {
    case 'dispatch-fixer':
      return s.phase === 'awaiting-fixer' ? null : `phase '${s.phase}' is not waiting on a fixer`;
    case 'wake-gate-owner':
      if (!s.gateHolder) return 'nobody holds the gate';
      return s.gateHolderWakeable ? null : `gate holder ${s.gateHolder} cannot take a turn`;
    case 'escalate-owner':
      return null;
  }
}

function sameDispatchRefusal(s: IdleQueueSnapshot | null, prior: IdleQueueEpisode | null): boolean {
  return !!s && !!prior?.dispatchRefusal &&
    prior.candidate === s.candidate &&
    prior.dispatchRefusal.repairHead === s.repairHead &&
    prior.dispatchRefusal.lastVerdictAtMs === (s.lastVerdictAtMs ?? null) &&
    s.failingLegs > 0 && s.phase !== 'ready-to-promote';
}

/** PURE. One rung per call; records not-applicable rungs on the returned episode as it walks. */
export function decideIdleQueueAction(
  s: IdleQueueSnapshot | null,
  prior: IdleQueueEpisode | null,
  nowMs: number,
): IdleQueueDecision {
  if (!s) return { kind: 'not-idle', reason: 'no frozen repair queue' };
  if (s.phase === 'ready-to-promote') return { kind: 'not-idle', reason: 'queue is ready to promote' };
  if (s.failingLegs <= 0) return { kind: 'not-idle', reason: 'no failing legs outstanding' };

  const idleSinceMs = Math.max(
    s.openedAtMs,
    s.lastAdmittedAtMs ?? 0,
    s.lastResumeRunStartedAtMs ?? 0,
  );
  const idleMs = nowMs - idleSinceMs;
  if (!(idleMs > IDLE_REPAIR_QUEUE_MS)) {
    return { kind: 'not-idle', reason: `last round started ${hoursText(Math.max(0, idleMs))} ago` };
  }

  const episode: IdleQueueEpisode =
    prior && prior.candidate === s.candidate && prior.idleSinceMs === idleSinceMs &&
      (!prior.dispatchRefusal || sameDispatchRefusal(s, prior))
      ? { ...prior, rungs: { ...prior.rungs } }
      : { candidate: s.candidate, idleSinceMs, rungs: {},
          ...(sameDispatchRefusal(s, prior) ? { dispatchRefusal: prior!.dispatchRefusal } : {}) };

  if (s.runInFlight === true) {
    return { kind: 'not-idle', reason: 'a checkpoint run is in flight' };
  }
  if (s.runInFlight === null) {
    return {
      kind: 'wait',
      reason: 'checkpoint run lock could not be measured; preserving the idle episode without acting',
      episode,
      nextRungAtMs: nowMs + IDLE_PASS_LEASE_MS,
    };
  }

  for (const rung of IDLE_QUEUE_RUNGS) {
    const rec = episode.rungs[rung];
    if (rec) {
      if (rec.outcome === 'acted') {
        if (nowMs < rec.atMs + IDLE_RUNG_GRACE_MS) {
          return {
            kind: 'wait',
            reason: `${rung} acted at ${new Date(rec.atMs).toISOString()} (${rec.detail}); waiting for a round to start`,
            episode,
            nextRungAtMs: rec.atMs + IDLE_RUNG_GRACE_MS,
          };
        }
        // An accepted dispatch is not proof that a fixer still owns the queue. If its durable
        // assignment is absent or its exact spawn is terminal, allow one recovery dispatch.
        // The queue reservation CAS remains the single-flight guard against a concurrent launch.
        if (
          rung === 'dispatch-fixer' &&
          s.phase === 'awaiting-fixer' &&
          (s.fixerSpawnId === null || s.fixerAlive === false) &&
          (episode.dispatchRetryCount ?? 0) < IDLE_DISPATCH_RETRY_LIMIT
        ) {
          episode.dispatchRetryCount = (episode.dispatchRetryCount ?? 0) + 1;
          return {
            kind: 'act',
            rung,
            reason: 'the prior fixer dispatch left no assigned live fixer; using the bounded retry',
            nextAction: namedNextAction(s, episode),
            episode,
          };
        }
      }
      if (rung === 'escalate-owner' && rec.outcome === 'failed') {
        // The last rung has nothing to fall through to, so a failed escalation is retried after
        // the grace rather than leaving the episode silently exhausted with nobody told.
        if (nowMs < rec.atMs + IDLE_RUNG_GRACE_MS) {
          return {
            kind: 'wait',
            reason: `owner escalation failed (${rec.detail}); retrying after the grace`,
            episode,
            nextRungAtMs: rec.atMs + IDLE_RUNG_GRACE_MS,
          };
        }
        return {
          kind: 'act',
          rung,
          reason: `retrying the owner escalation that failed at ${new Date(rec.atMs).toISOString()}`,
          nextAction: namedNextAction(s, episode),
          episode,
        };
      }
      continue;
    }
    if (rung === 'dispatch-fixer' && s.phase === 'awaiting-fixer' && s.fixerAlive === true) {
      // A live fixer is already the action this rung would take. Dispatching a second one would
      // race it; give it the grace before going over its head.
      episode.rungs[rung] = {
        atMs: nowMs,
        outcome: 'acted',
        detail: `fixer ${s.fixerSpawnId ?? '(unrecorded)'} already live; no second dispatch`,
      };
      return {
        kind: 'wait',
        reason: `a live fixer holds the queue; waiting ${hoursText(IDLE_RUNG_GRACE_MS)} for it to start a round`,
        episode,
        nextRungAtMs: nowMs + IDLE_RUNG_GRACE_MS,
      };
    }
    const na = rung === 'dispatch-fixer' && episode.dispatchRefusal
      ? `unchanged nonretryable dispatcher refusal: ${episode.dispatchRefusal.detail}`
      : notApplicableReason(rung, s);
    if (na) {
      episode.rungs[rung] = { atMs: nowMs, outcome: 'not-applicable', detail: na };
      continue;
    }
    return {
      kind: 'act',
      rung,
      reason: `no repair round has started for ${hoursText(idleMs)} with ${s.failingLegs} failing leg(s)`,
      nextAction: namedNextAction(s, episode),
      episode,
    };
  }
  return {
    kind: 'exhausted',
    reason: 'every rung has run for this idle episode; silent until a round starts',
    episode,
  };
}

/** PURE. The episode with `rung`'s outcome recorded. */
export function recordIdleRungOutcome(
  episode: IdleQueueEpisode,
  rung: IdleQueueRung,
  outcome: IdleRungOutcome,
  detail: string,
  nowMs: number,
): IdleQueueEpisode {
  return { ...episode, rungs: { ...episode.rungs, [rung]: { atMs: nowMs, outcome, detail } } };
}

/** PURE. The message a wake or an escalation carries: what is idle, what already ran, what to do. */
export function idleQueueMessage(
  installSlug: string,
  s: IdleQueueSnapshot,
  episode: IdleQueueEpisode,
  nowMs: number,
): { summary: string; body: string } {
  const idle = hoursText(nowMs - episode.idleSinceMs);
  const ran = IDLE_QUEUE_RUNGS.filter((r) => episode.rungs[r])
    .map((r) => `${r}: ${episode.rungs[r]!.outcome} (${episode.rungs[r]!.detail})`)
    .join('; ');
  const nextAction = namedNextAction(s, episode);
  return {
    summary: `Frozen repair queue on ${installSlug} idle ${idle} — ${nextAction}`,
    body:
      `Frozen candidate ${short(s.candidate)} (repairHead ${short(s.repairHead)}, phase '${s.phase}') has ` +
      `${s.failingLegs} failing leg(s) and no repair round has started for ${idle}. ` +
      (ran ? `Earlier rungs this episode: ${ran}. ` : '') +
      `Next action: ${nextAction}`,
  };
}

export interface IdleRungResult {
  ok: boolean;
  detail: string;
  /** False means dispatch cannot help until a new head or verdict; absent retains legacy retry behavior. */
  retryable?: boolean;
}

export interface IdleQueueFixerDispatchReceipt {
  spawnId: string | null;
  runId: string | null;
}

export interface IdleQueueFixerHandoffDeps {
  reserve: (queue: FrozenCandidateRepairQueue) => Promise<FrozenCandidateRepairQueue | null>;
  dispatch: (reserved: FrozenCandidateRepairQueue, onSkip: (skip: ReleaseFixerDispatchSkip) => void) => Promise<IdleQueueFixerDispatchReceipt | null>;
  finalize: (
    reserved: FrozenCandidateRepairQueue,
    fired: IdleQueueFixerDispatchReceipt | null,
  ) => Promise<FrozenCandidateRepairQueue | null>;
}

/** The slice of `dispatchReleaseFixer`'s signature the idle rung calls (injected for tests). */
export type FrozenRepairFixerDispatcher<T, R> = (
  target: T,
  candidate: string,
  failingTests: string[],
  repairQueue: FrozenCandidateRepairQueue,
  checkpointEvidence: undefined,
  deps: { onSkip: (skip: ReleaseFixerDispatchSkip) => void },
) => Promise<R>;

/**
 * Build the idle rung's `dispatch` handoff. A frozen-repair dispatch targets the queue's
 * mutable REPAIR HEAD, never its immutable candidate pin: `candidateSnapshotMatchesDispatch`
 * refuses any candidate other than `queue.repairHead`, and green-checkpoint's own frozen
 * dispatcher passes `queue.repairHead`. Passing `queue.candidate` made every idle-rung dispatch
 * skip as `snapshot-mismatch` once a fix had been admitted (WI-6554700010029686: five skips
 * handed 8c03b5dcd156 while the repair head was 327e4d1d, 2026-10-26).
 */
export function idleQueueFixerDispatch<T, R>(
  target: T,
  dispatch: FrozenRepairFixerDispatcher<T, R>,
): (reserved: FrozenCandidateRepairQueue, onSkip: (skip: ReleaseFixerDispatchSkip) => void) => Promise<R> {
  return (reserved, onSkip) =>
    dispatch(target, reserved.repairHead, reserved.failingTests, reserved, undefined, { onSkip });
}

/**
 * The idle rung may report success only after the durable queue row names the spawned fixer.
 * The reservation closes the read/launch/write race; finalization binds the launch receipt to
 * that exact queue generation, or releases the reservation when no spawn was made.
 */
export async function dispatchIdleQueueFixer(
  queue: FrozenCandidateRepairQueue,
  deps: IdleQueueFixerHandoffDeps,
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): Promise<IdleRungResult> {
  // WI-6554700010030357 (blind review 112 G-2): the attempt budget is enforced at finalize
  // (markFrozenRepairFixerDispatched), which runs AFTER the spawn — so an exhausted queue used to
  // launch a fixer the queue then refused to record. Refuse before reserving or spawning; the
  // refusal is nonretryable, so the ladder moves on to waking the gate owner.
  if (queue.attempts >= limits.maxAttempts) {
    return {
      ok: false,
      retryable: false,
      detail: `repair queue attempt budget is exhausted (${queue.attempts} of ${limits.maxAttempts} attempts used); no fixer launched`,
    };
  }
  const reserved = await deps.reserve(queue);
  if (!reserved) return { ok: false, detail: 'queue reservation was unavailable or the queue changed' };

  let fired: IdleQueueFixerDispatchReceipt | null = null;
  let skipped: ReleaseFixerDispatchSkip | undefined;
  try {
    fired = await deps.dispatch(reserved, skip => { skipped = skip; });
  } catch (error) {
    let released = false;
    try {
      const after = await deps.finalize(reserved, null);
      released = !!after && !after.dispatchReservation;
    } catch {
      // Preserve the dispatch error; the detail below says the lease release is unconfirmed.
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: `dispatcher threw: ${message}; reservation ${released ? 'released' : 'release could not be confirmed'}`,
    };
  }

  let finalized: FrozenCandidateRepairQueue | null;
  try {
    finalized = await deps.finalize(reserved, fired);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: fired?.spawnId
        ? `spawned fixer ${fired.spawnId}, but queue assignment finalization failed: ${message}`
        : `queue reservation finalization failed: ${message}`,
    };
  }

  if (!fired?.spawnId) {
    return {
      ok: false,
      ...(skipped ? { retryable: skipped.retryable } : {}),
      detail: `${skipped?.reason ?? 'dispatcher returned no spawn'}; reservation ${
        finalized && !finalized.dispatchReservation ? 'released' : 'release could not be confirmed'}`,

    };
  }
  if (finalized?.fixerSpawnId !== fired.spawnId || finalized.dispatchReservation) {
    return { ok: false, detail: `spawned fixer ${fired.spawnId}, but queue assignment was not persisted` };
  }
  return { ok: true, detail: `dispatched fixer ${fired.spawnId} and persisted its queue assignment` };
}

export interface IdleQueueActuatorDeps {
  installSlug: string;
  nowMs: () => number;
  readSnapshot: () => Promise<IdleQueueSnapshot | null>;
  loadEpisode: () => Promise<IdleQueueEpisode | null>;
  saveEpisode: (episode: IdleQueueEpisode | null) => Promise<void>;
  dispatchFixer: (s: IdleQueueSnapshot) => Promise<IdleRungResult>;
  wakeGateOwner: (holder: string, msg: { summary: string; body: string }) => Promise<IdleRungResult>;
  escalateOwner: (msg: { summary: string; body: string }) => Promise<IdleRungResult>;
}

export interface IdleQueuePassResult {
  decision: IdleQueueDecision['kind'];
  acted: Array<{ rung: IdleQueueRung; outcome: IdleRungOutcome; detail: string;
    startedAtMs: number; completedAtMs: number }>;
}

/**
 * One actuator pass. A failed rung falls through to the next rung IN THE SAME PASS, so a dead
 * dispatcher costs no extra tick before the gate owner hears about it. Never throws on a rung's
 * failure; a read/persist failure propagates to the caller's watchdog-health record.
 */
export async function runIdleQueueActuatorPass(deps: IdleQueueActuatorDeps): Promise<IdleQueuePassResult> {
  const s = await deps.readSnapshot();
  let episode = await deps.loadEpisode();
  const acted: IdleQueuePassResult['acted'] = [];

  for (let i = 0; i <= IDLE_QUEUE_RUNGS.length; i++) {
    const now = deps.nowMs();
    const d = decideIdleQueueAction(s, episode, now);
    if (d.kind === 'not-idle') {
      // A run starting is not a new verdict. Retain deterministic refusal evidence while
      // it runs and during the idle grace; clear it when the queue/head/verdict changes.
      if (episode && !sameDispatchRefusal(s, episode)) await deps.saveEpisode(null);
      return { decision: d.kind, acted };
    }
    if (d.kind !== 'act') {
      await deps.saveEpisode(d.episode);
      return { decision: d.kind, acted };
    }
    const previousDispatchRetryCount = episode?.dispatchRetryCount ?? 0;
    if (
      d.rung === 'dispatch-fixer' &&
      (d.episode.dispatchRetryCount ?? 0) > previousDispatchRetryCount
    ) {
      // Persist before the external launch so a process exit cannot retry this rung forever.
      await deps.saveEpisode(d.episode);
      episode = d.episode;
    }
    const msg = idleQueueMessage(deps.installSlug, s!, d.episode, now);
    let result: IdleRungResult;
    try {
      result =
        d.rung === 'dispatch-fixer'
          ? await deps.dispatchFixer(s!)
          : d.rung === 'wake-gate-owner'
            ? await deps.wakeGateOwner(s!.gateHolder!, msg)
            : await deps.escalateOwner(msg);
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const outcome: IdleRungOutcome = result.ok ? 'acted' : 'failed';
    episode = recordIdleRungOutcome(d.episode, d.rung, outcome, result.detail, now);
    if (d.rung === 'dispatch-fixer' && !result.ok && result.retryable === false) {
      episode.dispatchRefusal = {
        repairHead: s!.repairHead, lastVerdictAtMs: s!.lastVerdictAtMs ?? null, detail: result.detail,
      };
    }
    acted.push({ rung: d.rung, outcome, detail: result.detail, startedAtMs: now, completedAtMs: deps.nowMs() });
    await deps.saveEpisode(episode);
    if (result.ok) return { decision: 'act', acted };
  }
  return { decision: 'exhausted', acted };
}

/** `harness_escalations.escalation` is TEXT, so a stored episode reads back as a JSON string. */
export function parseEpisode(raw: unknown): IdleQueueEpisode | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.candidate !== 'string' || typeof r.idleSinceMs !== 'number') return null;
  const rungs: IdleQueueEpisode['rungs'] = {};
  const src = r.rungs && typeof r.rungs === 'object' ? (r.rungs as Record<string, unknown>) : {};
  for (const rung of IDLE_QUEUE_RUNGS) {
    const rec = src[rung] as Record<string, unknown> | undefined;
    if (
      rec &&
      typeof rec.atMs === 'number' &&
      (rec.outcome === 'acted' || rec.outcome === 'failed' || rec.outcome === 'not-applicable')
    ) {
      rungs[rung] = { atMs: rec.atMs, outcome: rec.outcome, detail: String(rec.detail ?? '') };
    }
  }
  const hasDispatchRetryCount = Object.prototype.hasOwnProperty.call(r, 'dispatchRetryCount');
  const persistedRetryCount = r.dispatchRetryCount;
  const dispatchRetryCount = hasDispatchRetryCount
    ? typeof persistedRetryCount === 'number' && Number.isInteger(persistedRetryCount) && persistedRetryCount >= 0
      ? Math.min(persistedRetryCount, IDLE_DISPATCH_RETRY_LIMIT)
      : IDLE_DISPATCH_RETRY_LIMIT
    : 0;
  const refusal = r.dispatchRefusal;
  let dispatchRefusal: IdleQueueEpisode['dispatchRefusal'];
  if (refusal && typeof refusal === 'object') {
    const saved = refusal as Record<string, unknown>;
    if (typeof saved.repairHead === 'string' && saved.repairHead.length > 0 &&
      (saved.lastVerdictAtMs === null ||
        (typeof saved.lastVerdictAtMs === 'number' && Number.isFinite(saved.lastVerdictAtMs))) &&
      typeof saved.detail === 'string') {
      dispatchRefusal = { repairHead: saved.repairHead, lastVerdictAtMs: saved.lastVerdictAtMs, detail: saved.detail };
    }
  }
  return { candidate: r.candidate, idleSinceMs: r.idleSinceMs, rungs, dispatchRetryCount,
    ...(dispatchRefusal ? { dispatchRefusal } : {}) };

}

/**
 * The episode row is the actuator's own state, not a request for triage. Without a note,
 * `collectEscalationSignals` (harness/improvements/watchdog.ts) files a major "Unresolved
 * escalation" bug for ANY row lacking `supervisor_notes`, which would page a second time,
 * through a worker dispatch, for a stall that rung 3 already put in front of the owner.
 */
export const IDLE_ACTUATOR_SELF_MANAGED_NOTE =
  'self-managed: idle-repair-queue-actuator state; the actuator escalates to the owner itself (rung 3)';

/**
 * One host per tick. The watchdog starts from DBOS bootstrap, so every DBOS-running process ticks
 * it; without a claim two hosts could read the same episode and both wake or escalate. The claim
 * is ONE atomic upsert on the episode row: it advances `mtime_ms` only when the last pass (any
 * host) is at least {@link IDLE_PASS_LEASE_MS} old, and returns the stored episode. An
 * `mtime_ms`-only change is a refresh stamp to git-export (WI-10003624), so this causes no churn.
 */
/**
 * gate-repair-plane-on-current-build-2026-10-15 R-2: the pass lease names its holder. The
 * winning claim writes `gate_health.idleActuatorClaim` on the green-checkpoint routine IN THE
 * SAME STATEMENT as the lease upsert, so no reader can see a lease without its attribution. A
 * host that loses the lease to a DIFFERENT executor records `gate_health.idleActuatorStandDown`
 * naming that winner ({@link recordIdleActuatorStandDown}).
 */
export const IDLE_ACTUATOR_CLAIM_FIELD = 'idleActuatorClaim';
export const IDLE_ACTUATOR_STAND_DOWN_FIELD = 'idleActuatorStandDown';

export interface IdleActuatorPassClaim extends RepairLimbExecutor {
  claimedAtMs: number;
}

export interface IdleActuatorStandDown extends RepairLimbExecutor {
  atMs: number;
  winner: IdleActuatorPassClaim;
}

export function parseIdleActuatorPassClaim(value: unknown): IdleActuatorPassClaim | null {
  const executor = parseRepairLimbExecutor(value);
  const claimedAtMs = (value as { claimedAtMs?: unknown } | null)?.claimedAtMs;
  if (!executor || typeof claimedAtMs !== 'number' || !Number.isFinite(claimedAtMs)) return null;
  return { ...executor, claimedAtMs };
}

export async function claimIdleActuatorPass(
  sql: Sql,
  o: { installSlug: string; workspaceId: string; nowMs: number; executor?: RepairLimbExecutor },
): Promise<{ claimed: false } | { claimed: true; episode: IdleQueueEpisode | null; claim: IdleActuatorPassClaim;
  /** False when no green-checkpoint routine row exists to carry the attribution. */
  attributed: boolean }> {
  const claim: IdleActuatorPassClaim = { ...(o.executor ?? currentRepairLimbExecutor()), claimedAtMs: o.nowMs };
  const rows = await sql<{ escalation: unknown; attributed: boolean }[]>`
    WITH lease AS (
      INSERT INTO harness_shared.harness_escalations
             (harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)
      VALUES (${o.installSlug}, ${IDLE_REPAIR_QUEUE_PHASE}, NULL, ${IDLE_ACTUATOR_SELF_MANAGED_NOTE},
              ${o.nowMs}, ${o.workspaceId})
      ON CONFLICT (harness_slug, phase) DO UPDATE SET mtime_ms = EXCLUDED.mtime_ms
       WHERE harness_shared.harness_escalations.mtime_ms <= ${o.nowMs - IDLE_PASS_LEASE_MS}
      RETURNING escalation
    ), stamp AS (
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{gate_health}',
               COALESCE(NULLIF(metadata->'gate_health', 'null'::jsonb), '{}'::jsonb)
                 || jsonb_build_object(${IDLE_ACTUATOR_CLAIM_FIELD}::text, ${JSON.stringify(claim)}::text::jsonb),
               true)
       WHERE install_slug = ${o.installSlug}
         AND workspace_id = ${o.workspaceId}
         AND target_role = 'system:green-checkpoint'
         AND EXISTS (SELECT 1 FROM lease)
      RETURNING 1
    )
    SELECT lease.escalation, EXISTS (SELECT 1 FROM stamp) AS attributed FROM lease`;
  return rows.length === 0
    ? { claimed: false }
    : { claimed: true, episode: parseEpisode(rows[0].escalation), claim, attributed: rows[0].attributed === true };
}

/**
 * The losing side of R-2. A host that did not get the pass lease records one no-op naming the
 * executor that holds it — only when that holder is a DIFFERENT executor (losing to this
 * process's own earlier pass is just a tick inside its lease), and only once per (loser,
 * winning claim), so a host ticking through someone else's 10-minute lease writes once.
 */
export async function recordIdleActuatorStandDown(
  sql: Sql,
  o: { installSlug: string; workspaceId: string; nowMs: number; executor?: RepairLimbExecutor },
): Promise<{ recorded: boolean; winner: IdleActuatorPassClaim | null }> {
  const me = o.executor ?? currentRepairLimbExecutor();
  const standDown = { ...me, atMs: o.nowMs };
  const updated = await sql<{ winner: unknown }[]>`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(
             metadata,
             '{gate_health}',
             metadata->'gate_health' || jsonb_build_object(
               ${IDLE_ACTUATOR_STAND_DOWN_FIELD}::text,
               ${JSON.stringify(standDown)}::text::jsonb
                 || jsonb_build_object('winner', metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text)),
             true)
     WHERE install_slug = ${o.installSlug}
       AND workspace_id = ${o.workspaceId}
       AND target_role = 'system:green-checkpoint'
       AND jsonb_typeof(metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text) = 'object'
       AND (metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text->>'hostId',
            metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text->>'processId')
           IS DISTINCT FROM (${me.hostId}::text, ${me.processId}::text)
       AND (metadata->'gate_health'->${IDLE_ACTUATOR_STAND_DOWN_FIELD}::text->>'hostId',
            metadata->'gate_health'->${IDLE_ACTUATOR_STAND_DOWN_FIELD}::text->>'processId',
            metadata->'gate_health'->${IDLE_ACTUATOR_STAND_DOWN_FIELD}::text->'winner'->>'hostId',
            metadata->'gate_health'->${IDLE_ACTUATOR_STAND_DOWN_FIELD}::text->'winner'->>'processId',
            metadata->'gate_health'->${IDLE_ACTUATOR_STAND_DOWN_FIELD}::text->'winner'->>'claimedAtMs')
           IS DISTINCT FROM
           (${me.hostId}::text, ${me.processId}::text,
            metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text->>'hostId',
            metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text->>'processId',
            metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text->>'claimedAtMs')
    RETURNING metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text AS winner`;
  if (updated.length > 0) return { recorded: true, winner: parseIdleActuatorPassClaim(updated[0].winner) };
  const current = await sql<{ winner: unknown }[]>`
    SELECT metadata->'gate_health'->${IDLE_ACTUATOR_CLAIM_FIELD}::text AS winner
      FROM harness_shared.routines
     WHERE install_slug = ${o.installSlug} AND workspace_id = ${o.workspaceId}
       AND target_role = 'system:green-checkpoint'
     LIMIT 1`;
  return { recorded: false, winner: parseIdleActuatorPassClaim(current[0]?.winner) };
}

/** Persist (or, with `null`, clear) the episode. Always carries the self-managed note, and a
 * non-null episode carries the writing executor's host and build (R-1). */
export async function saveIdleActuatorEpisode(
  sql: Sql,
  o: { installSlug: string; workspaceId: string; nowMs: number; episode: IdleQueueEpisode | null;
    executor?: RepairLimbExecutor },
): Promise<void> {
  if (!o.episode) {
    await sql`
      UPDATE harness_shared.harness_escalations
         SET escalation = NULL, mtime_ms = ${o.nowMs}
       WHERE harness_slug = ${o.installSlug} AND phase = ${IDLE_REPAIR_QUEUE_PHASE}
         AND escalation IS NOT NULL`;
    return;
  }
  await sql`
    INSERT INTO harness_shared.harness_escalations
           (harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)
    VALUES (${o.installSlug}, ${IDLE_REPAIR_QUEUE_PHASE},
            ${JSON.stringify({ kind: IDLE_REPAIR_QUEUE_PHASE, harness_slug: o.installSlug, ...o.episode,
              ...(o.executor ?? currentRepairLimbExecutor()) })},
            ${IDLE_ACTUATOR_SELF_MANAGED_NOTE}, ${o.nowMs}, ${o.workspaceId})
    ON CONFLICT (harness_slug, phase)
    DO UPDATE SET escalation = EXCLUDED.escalation, supervisor_notes = EXCLUDED.supervisor_notes,
                  mtime_ms = EXCLUDED.mtime_ms`;
}

/** Original observations share the existing repair-latency stream, without becoming gate fires
 * or verdicts. The snapshot precedes effects; receipt clocks bracket the actual awaited effect.
 * A carried episode's old rung stamp is deliberately not a delivery receipt. */
export interface IdleQueueActuatorObservation {
  version: 1;
  startedAtMs: number;
  completedAtMs: number;
  snapshot: IdleQueueSnapshot;
  episode: IdleQueueEpisode | null;
  result: IdleQueuePassResult;
  /**
   * The writing executor: host, process and loaded build (R-1; absent on records written
   * before gate-repair-plane-on-current-build-2026-10-15#P-038).
   */
  executor?: RepairLimbExecutor;
  /** The code-content marker of the writing build (absent on records written before it). */
  marker?: string;
}

/**
 * gate-repair-plane-on-current-build-2026-10-15 R-6 / P-006: a constant every pass record
 * carries, so a record proves WHICH CODE executed by content, not by a build sha that can
 * describe a dirty bundle. Change the value only to run a fresh proof.
 *
 * #D-010 / #P-038: the first value's records carried no executor stamp, so R-6 could not tell
 * from a record alone whether the build that wrote it contains the marker. The R-6 subject is
 * now the first pass record carrying THIS value whose own `executor.executingBuild.sha`
 * contains it; a record whose stamped sha lacks it is a dirty-bundle execution (residue).
 */
export const IDLE_ACTUATOR_PASS_MARKER = 'gate-repair-plane-r6-proof-2026-10-27-stamped';

/** One pass record, stamped with the writing executor and this build's marker. */
export function buildIdleQueueActuatorObservation(
  pass: Omit<IdleQueueActuatorObservation, 'version' | 'marker' | 'executor'>,
  executor: RepairLimbExecutor = currentRepairLimbExecutor(),
): IdleQueueActuatorObservation {
  return { version: 1, ...pass, executor, marker: IDLE_ACTUATOR_PASS_MARKER };
}

export async function recordIdleQueueActuatorObservation(sql: Sql,
  scope: { workspaceId: string; installSlug: string }, queue: FrozenCandidateRepairQueue,
  observation: IdleQueueActuatorObservation): Promise<void> {
  const { buildGateRepairLatencyLedgerRow, deriveTickFreezeDisposition, GATE_REPAIR_LATENCY_KIND } =
    await import('./freeze-disposition');
  const { appendPipelineEvent } = await import('../harness/git-sync/pipeline-events');
  // This describes the queue the actuator read, not a gate verdict or a measurement of the flag.
  const row = buildGateRepairLatencyLedgerRow(deriveTickFreezeDisposition({
    flagEnabled: true, repairQueue: queue, nowMs: observation.startedAtMs,
    summary: 'Original idle-actuator observation; no gate verdict implied',
  }), observation.startedAtMs)!;
  await appendPipelineEvent({ ...scope, kind: GATE_REPAIR_LATENCY_KIND, status: row.status,
    detail: { ...row.detail, idleActuator: observation } }, sql, { required: true });
}

/** Read the complete original population and its boundary observation in one PG snapshot.
 * Legacy mutable episodes cannot reconstruct missing receipts; they stay unmeasured. */
export async function readIdleQueueActuatorWindow(sql: Sql,
  scope: { workspaceId: string; installSlug: string },
  window: { windowStartMs: number; windowEndMs: number; maxRows?: number }): Promise<PipelineEventWindowRead> {
  const { windowStartMs, windowEndMs } = window;
  const maxRows = window.maxRows ?? 10_000;
  const base = { windowStartMs, windowEndMs, total: null, rows: [] };
  if (!scope.workspaceId.trim() || !scope.installSlug.trim() ||
      !Number.isSafeInteger(windowStartMs) || windowStartMs < 0 ||
      !Number.isSafeInteger(windowEndMs) || windowEndMs <= windowStartMs ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
    return { ...base, status: 'invalid', reason: 'Exact scope, finite window and bounded population are required.' };
  }
  try {
    const rows = await sql<{ id: string; status: string; detail: Record<string, unknown>;
      created_at: Date | string; population_count: string | number }[]>`
      WITH scoped AS MATERIALIZED (
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'green_checkpoint_repair_latency' AND detail ? 'idleActuator'
      ), predecessor AS (
        SELECT * FROM scoped WHERE created_at <= ${new Date(windowStartMs)}
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), population AS (
        SELECT * FROM predecessor UNION ALL
        SELECT * FROM scoped WHERE created_at > ${new Date(windowStartMs)}
          AND created_at <= ${new Date(windowEndMs)}
      )
      SELECT id::text, status, detail, created_at, count(*) OVER () AS population_count
      FROM population ORDER BY created_at, id LIMIT ${maxRows + 1}`;
    const total = rows.length ? Number(rows[0]!.population_count) : 0;
    if (!Number.isSafeInteger(total) || total < rows.length ||
        (total <= maxRows && total !== rows.length) || rows.some(row => Number(row.population_count) !== total)) {
      return { ...base, status: 'unavailable', reason: 'Historical population count is inconsistent.' };
    }
    return { windowStartMs, windowEndMs, total, status: total > maxRows ? 'capped' : 'complete',
      reason: total > maxRows ? 'Historical population exceeds the row budget.' : null,
      rows: rows.slice(0, maxRows).map(row => ({ id: row.id, kind: 'green_checkpoint_repair_latency',
        status: row.status, detail: row.detail, createdAtMs: new Date(row.created_at).getTime() })) };
  } catch (error) {
    return { ...base, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Strict historical measurement, not an amendment of the Goal: action delay is bounded by
 * 60 minutes, with no extra tick silently added. Coverage requires uninterrupted observations;
 * absent-queue gaps and legacy data remain unqualified, never a vacuous operational pass. */
export function evaluateIdleQueueActuatorWindow(history: PipelineEventWindowRead,
  observedAtMs = Date.now(), maxGapMs = 15 * 60_000) {
  const stamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const windowValid = stamp(history.windowStartMs) && stamp(history.windowEndMs) &&
    history.windowEndMs > history.windowStartMs && stamp(observedAtMs) && observedAtMs >= history.windowEndMs &&
    stamp(maxGapMs) && maxGapMs > 0 && maxGapMs <= IDLE_REPAIR_QUEUE_MS;
  const complete = history.status === 'complete' && history.total === history.rows.length &&
    history.rows.length > 0 && new Set(history.rows.map(row => row.id)).size === history.rows.length;
  const rows = [...history.rows].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  const samples: number[] = [];
  const episodes = new Map<string, { idleSinceMs: number; observedAtMs: number; firstActionAtMs: number | null }>();
  const observations = new Set<string>();
  let qualified = complete;
  for (const row of rows) {
    const o = row.detail?.idleActuator as IdleQueueActuatorObservation | undefined;
    const s = o?.snapshot;
    if (!row.id?.trim() || row.kind !== 'green_checkpoint_repair_latency' || row.status !== 'converging' ||
        !stamp(row.createdAtMs) || row.createdAtMs > history.windowEndMs || o?.version !== 1 ||
        !stamp(o.startedAtMs) || !stamp(o.completedAtMs) || o.startedAtMs > o.completedAtMs ||
        o.completedAtMs > row.createdAtMs || !s || typeof s.candidate !== 'string' || !s.candidate.trim() ||
        row.detail.candidate !== s.candidate || !stamp(s.openedAtMs) || s.openedAtMs > o.startedAtMs ||
        !['ready-to-test', 'awaiting-fixer', 'ready-to-verify', 'ready-to-promote', 'blocked'].includes(s.phase) ||
        typeof s.runInFlight !== 'boolean' || !Number.isSafeInteger(s.failingLegs) || s.failingLegs < 0 ||
        ![s.lastAdmittedAtMs, s.lastResumeRunStartedAtMs].every(t => t === null ||
          (stamp(t) && t >= s.openedAtMs && t <= o.startedAtMs)) ||
        !o.result || !['act', 'not-idle', 'wait', 'exhausted'].includes(o.result.decision) ||
        !Array.isArray(o.result.acted)) { qualified = false; continue; }
    const identity = JSON.stringify([s.candidate, s.openedAtMs, o.startedAtMs]);
    if (observations.has(identity)) qualified = false;
    observations.add(identity);
    samples.push(o.startedAtMs);
    const idleSinceMs = Math.max(s.openedAtMs, s.lastAdmittedAtMs ?? 0, s.lastResumeRunStartedAtMs ?? 0);
    const key = JSON.stringify([s.candidate, s.openedAtMs, idleSinceMs]);
    const episode = episodes.get(key) ?? { idleSinceMs, observedAtMs: o.startedAtMs, firstActionAtMs: null };
    for (const action of o.result.acted) {
      if (!action || !IDLE_QUEUE_RUNGS.includes(action.rung) || !['acted', 'failed'].includes(action.outcome) ||
          !stamp(action.startedAtMs) || !stamp(action.completedAtMs) || action.startedAtMs < o.startedAtMs ||
          action.completedAtMs < action.startedAtMs || action.completedAtMs > o.completedAtMs) {
        qualified = false; continue;
      }
      if (action.outcome === 'acted') episode.firstActionAtMs = Math.min(episode.firstActionAtMs ?? Infinity, action.completedAtMs);
    }
    if (!s.runInFlight && s.phase !== 'ready-to-promote' && s.failingLegs > 0) {
      episode.observedAtMs = Math.max(episode.observedAtMs, o.startedAtMs);
      episodes.set(key, episode);
    }
  }
  samples.sort((a, b) => a - b);
  const coverage = qualified && windowValid && samples.length > 0 && samples[0]! <= history.windowStartMs &&
    history.windowStartMs - samples[0]! <= maxGapMs &&
    history.windowEndMs - samples.at(-1)! <= maxGapMs &&
    samples.every((t, i) => i === 0 || t - samples[i - 1]! <= maxGapMs);
  const due = [...episodes.values()].filter(e => e.observedAtMs - e.idleSinceMs >= IDLE_REPAIR_QUEUE_MS);
  const admissible = windowValid && complete && qualified && coverage && due.length > 0;
  return { episodes: due, eventIds: rows.map(row => row.id), assertions: [
    { id: 'bounded-idle-actuator-window', passed: windowValid, evidence: `start=${history.windowStartMs}; end=${history.windowEndMs}; observed=${observedAtMs}; maxGap=${maxGapMs}` },
    { id: 'complete-idle-actuator-population', passed: complete, evidence: `read=${history.status}; population=${history.total}; rows=${rows.length}` },
    { id: 'original-idle-actuator-receipts', passed: complete && qualified, evidence: 'Original queue clocks and awaited effect receipts; carried rung stamps cannot substitute.' },
    { id: 'continuous-idle-actuator-observations', passed: coverage, evidence: `samples=${samples.length}; maxGap=${maxGapMs}` },
    { id: 'nonempty-idle-actuator-episodes', passed: admissible, evidence: `dueEpisodes=${due.length}` },
    { id: 'idle-actuator-action-at-most-60min', passed: admissible && due.every(e =>
      e.firstActionAtMs !== null && e.firstActionAtMs - e.idleSinceMs <= IDLE_REPAIR_QUEUE_MS),
      evidence: `actionDelaysMs=${due.map(e => e.firstActionAtMs === null ? 'unknown' : e.firstActionAtMs - e.idleSinceMs).join(',')}` },
  ] };
}

export async function executeIdleQueueActuatorWindow(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; installSlug: string;
  runtimeUnits: string[]; windowStartMs: number; windowEndMs: number;
}) {
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/idle-repair-queue-actuator.ts',
    name: 'Original idle-actuator history', framework: 'operational', runtimeUnits: args.runtimeUnits,
    command: ['executeIdleQueueActuatorWindow', args.workspaceId, args.installSlug,
      String(args.windowStartMs), String(args.windowEndMs)],
    run: async () => {
      const history = await readIdleQueueActuatorWindow(sql, args, args);
      const evaluation = evaluateIdleQueueActuatorWindow(history);
      return { exitCode: evaluation.assertions.every(a => a.passed) ? 0 : 1, assertions: evaluation.assertions,
        summary: `Idle-actuator history only: window=${args.windowStartMs}..${args.windowEndMs}; ` +
          `original_population_sha256=${createHash('sha256').update(JSON.stringify(history)).digest('hex')}. ` +
          'No cycle, repair-round, invariant-soak, alarm or shipment assertion.' };
    },
  }, args);
}

const IDLE_ACTUATOR_IDENTITY = {
  ownerId: 'system-watchdog',
  ownerLabel: 'system-watchdog',
  source: 'static-client' as const,
  workspaceId: null,
  userId: null,
};

/**
 * The production pass, wired into `startGreenStallWatchdog` beside `checkStrandedRepairQueue`.
 * Every effect is real: `dispatchReleaseFixer` (which dedups against a live fixer and takes a
 * CAS-written reservation, so a watchdog dispatch cannot double-spawn), a directed message plus
 * wake to the gate holder alone, and an urgent intervention on the owner's attention surface.
 * The episode persists in `harness_escalations` under {@link IDLE_REPAIR_QUEUE_PHASE}.
 */
export async function checkIdleRepairQueue(
  sql: Sql,
  opts: { installSlug: string; workspaceId?: string; nowMs?: () => number;
    alarm?: import('../alarm-attention').AlarmAttentionDeps },
): Promise<IdleQueuePassResult | null> {
  const installSlug = typeof opts.installSlug === 'string' ? opts.installSlug.trim() : '';
  if (!installSlug) {
    console.warn('[idle-repair-queue-actuator] skipped: installSlug is required');
    return null;
  }
  const { recordWatchdogPassOutcome } = await import('./watchdog-health');
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return null;
    const workspaceId = opts.workspaceId ?? rows[0].workspace_id;

    const {
      readFrozenCandidateRepairQueueState,
      dispatchReleaseFixer,
      reserveFrozenCandidateRepairFixer,
      finalizeFrozenCandidateRepairFixer,
    } = await import('../harness/routines/release-actions');
    const { releaseFixerSpawnAlive } = await import('./fixer-liveness');
    const { readGateOwnership } = await import('../coord/gate-ownership');

    // One host per tick. The watchdog starts from DBOS bootstrap, so every DBOS-running process
    // ticks it; without this two hosts could read the same episode and both wake or escalate.
    // The claim is one atomic upsert on the episode row: it advances mtime_ms only when the last
    // pass (any host) is at least IDLE_PASS_LEASE_MS old, and hands back the stored episode.
    const executor = currentRepairLimbExecutor();
    const claim = await claimIdleActuatorPass(sql, { installSlug, workspaceId, nowMs: (opts.nowMs ?? Date.now)(), executor });
    if (!claim.claimed) {
      // R-2: losing the lease to another executor is a recorded no-op that names the winner.
      const standDown = await recordIdleActuatorStandDown(sql, {
        installSlug, workspaceId, nowMs: (opts.nowMs ?? Date.now)(), executor,
      });
      if (standDown.recorded && standDown.winner) {
        console.warn(
          `[idle-repair-queue-actuator] ${installSlug}: stood down; pass lease held by ` +
            `${standDown.winner.hostId} (build ${standDown.winner.executingBuild.sha ?? 'unresolved'})`,
        );
      }
      return null;
    }
    const storedEpisode = claim.episode;

    const startedAtMs = (opts.nowMs ?? Date.now)();
    let queue: FrozenCandidateRepairQueue | null = null;
    let snapshot: IdleQueueSnapshot | null = null;
    let episode = storedEpisode;
    let queueMeasured = false;
    const result = await runIdleQueueActuatorPass({
      installSlug,
      nowMs: opts.nowMs ?? Date.now,
      readSnapshot: async () => {
        const read = await readFrozenCandidateRepairQueueState({ workspaceId, installSlug });
        queueMeasured = read.status === 'value' || read.status === 'absent';
        if (!queueMeasured) throw new Error('repair queue is unreadable; preserve the idle episode');
        queue = read.status === 'value' ? read.queue : null;
        if (!queue) return null;
        const fixerAlive = queue.fixerSpawnId
          ? await releaseFixerSpawnAlive(sql as never, queue.fixerSpawnId).catch(() => null)
          : null;
        const own = await readGateOwnership({ harness: installSlug }).catch(() => null);
        const holderState = own?.holderSessionState ?? null;
        let runInFlight: boolean | null = null;
        try {
          const [{ integrationRoot }, { isCheckpointRunLockHeldCheap }] = await Promise.all([
            import('../release-deploy-launch'),
            import('../release-checkpoint-launch'),
          ]);
          runInFlight = isCheckpointRunLockHeldCheap(integrationRoot()).held;
        } catch {
          // Unknown is distinct from idle: do not wake the gate owner or recommend a refire.
          runInFlight = null;
        }
        snapshot = {
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          phase: queue.phase,
          openedAtMs: queue.openedAtMs,
          lastAdmittedAtMs: queue.lastAdmittedAtMs ?? null,
          lastResumeRunStartedAtMs: queue.lastResumeRunStartedAtMs ?? null,
          lastVerdictAtMs: queue.lastVerdictAtMs ?? null,
          runInFlight,
          failingLegs: queue.failingTests.length,
          fixerSpawnId: queue.fixerSpawnId,
          fixerAlive,
          gateHolder: own?.takenBy ?? null,
          gateHolderWakeable: holderState === 'live' || holderState === 'parked',
          blockedReason: queue.blockedReason ?? null,
        };
        return snapshot;
      },
      loadEpisode: async () => storedEpisode,
      saveEpisode: async (nextEpisode) => {
        await saveIdleActuatorEpisode(sql, {
          installSlug, workspaceId, nowMs: (opts.nowMs ?? Date.now)(), episode: nextEpisode, executor,
        });
        episode = nextEpisode;
      },
      dispatchFixer: async () => {
        const q = queue;
        if (!q) return { ok: false, detail: 'queue vanished before dispatch' };
        const target = { installSlug, workspaceId };
        return dispatchIdleQueueFixer(q, {
          reserve: (current) => reserveFrozenCandidateRepairFixer(target, current),
          dispatch: idleQueueFixerDispatch(target, dispatchReleaseFixer),
          finalize: (reserved, fired) => finalizeFrozenCandidateRepairFixer(target, reserved, fired),
        });
      },
      wakeGateOwner: async (holder, msg) => {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
        const env = await sendMessage(IDLE_ACTUATOR_IDENTITY, {
          to: [holder],
          summary: msg.summary,
          body: msg.body,
          expectsReply: true,
        });
        if (env.to.length === 0) return { ok: false, detail: `${holder} resolved to no recipient` };
        const w = await wakeRecipients(env.to, { summary: msg.summary, source: IDLE_REPAIR_QUEUE_PHASE, workspaceId });
        return w.woken > 0
          ? { ok: true, detail: `woke ${holder}` }
          : { ok: false, detail: `message sent but no live wake landed for ${holder}` };
      },
      escalateOwner: async (msg) => {
        const { notifyAttention } = await import('../attention-notify');
        const broadcastSevereEvent = opts.alarm?.broadcast ?? (await import('../severe-event-broadcast')).broadcastSevereEvent;
        await broadcastSevereEvent({
          conditionKey: `alarm:idle-repair-queue:${installSlug}`, summary: msg.summary, body: msg.body, oneShot: true,
        });
        const input = {
          kind: 'intervention',
          title: msg.summary,
          body: msg.body,
          importance: 'urgent',
          workspaceId,
          data: { installSlug, phase: IDLE_REPAIR_QUEUE_PHASE },
        } as const;
        if (opts.alarm?.notify) await opts.alarm.notify(input);
        else await notifyAttention(input);
        return { ok: true, detail: 'urgent intervention raised on the owner attention surface' };
      },
    });
    if (queue && snapshot) {
      await recordIdleQueueActuatorObservation(sql, { workspaceId, installSlug }, queue,
        buildIdleQueueActuatorObservation({
          startedAtMs, completedAtMs: (opts.nowMs ?? Date.now)(), snapshot, episode, result,
        }, executor));
    }
    if (queueMeasured && result.decision === 'not-idle') {
      const { resolveAlarm } = await import('../alarm-attention');
      await resolveAlarm(`alarm:idle-repair-queue:${installSlug}`, 'idle-repair-queue', opts.alarm);
    }
    if (result.acted.length > 0) {
      console.warn(
        `[idle-repair-queue-actuator] ${installSlug}: ` +
          result.acted.map((a) => `${a.rung}=${a.outcome} (${a.detail})`).join('; '),
      );
    }
    return result;
  } catch (e) {
    passError = e;
    console.warn(`[idle-repair-queue-actuator] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    await recordWatchdogPassOutcome(sql, 'idle-repair-queue', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}

/**
 * Park verdict delivery check (consult-backed-parking-2026-10-12 P-007).
 *
 * A park verdict is only useful once the parked agent takes a turn on it. This module
 * decides, from durable facts alone, what to do when it has not:
 *  - R-7: no turn within ten minutes of the verdict ⇒ re-wake the parked agent once.
 *  - R-20: an ENDED parked session cannot take a wake ⇒ resume it from its checkpoint.
 *  - R-21: when the re-wake and the resume both fail to produce a turn ⇒ tell the owner,
 *    naming the park, exactly once.
 *
 * `checkParkDelivery` is pure and idempotent; `runParkDeliveryCheck` applies its single
 * action through injected seams so production wiring lives with the caller.
 */
import type { ParkVerdict } from './park-resolver';

/** How long a delivered verdict may sit without a parker turn before each escalation step. */
export const PARK_DELIVERY_GRACE_MS = 10 * 60_000;

/** Liveness verdicts from the shared presence oracle (`sessionState`). */
export type ParkerSessionState = 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded';

export interface ParkDeliveryState {
  consultId: string;
  workItemId: string;
  parkerId: string;
  verdict: ParkVerdict;
  /** When the verdict event was emitted. */
  emittedAt: string;
  /** The parked agent's most recent turn, or null when unknown. */
  parkerLastTurnAt: string | null;
  parkerSessionState: ParkerSessionState | null;
  rewakeAttemptedAt: string | null;
  resumeAttemptedAt: string | null;
  /** Whether the resume launch itself succeeded; null until attempted. */
  resumeResult: 'ok' | 'failed' | null;
  ownerNotifiedAt: string | null;
}

export type ParkDeliveryReason =
  | 'delivered'
  | 'within-grace'
  | 'owner-notified'
  | 'awaiting-rewake-turn'
  | 'awaiting-resume-turn';

export type ParkDeliveryAction =
  | { kind: 'none'; reason: ParkDeliveryReason }
  | { kind: 'rewake'; note: string }
  | { kind: 'resume'; note: string }
  | { kind: 'notify-owner'; text: string; failure: 'resume-failed' | 'no-turn-after-resume' };

function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`park-delivery: invalid timestamp ${JSON.stringify(iso)}`);
  return t;
}

/** A turn at or after the verdict means the parked agent has seen it. */
export function parkVerdictDelivered(s: Pick<ParkDeliveryState, 'emittedAt' | 'parkerLastTurnAt'>): boolean {
  return s.parkerLastTurnAt !== null && ms(s.parkerLastTurnAt) >= ms(s.emittedAt);
}

function wakeNote(s: ParkDeliveryState): string {
  return `Your park on ${s.workItemId} (consult ${s.consultId}) has a verdict: ${s.verdict}. Read it and continue.`;
}

export function ownerNotificationText(
  s: ParkDeliveryState,
  failure: 'resume-failed' | 'no-turn-after-resume',
): string {
  const why =
    failure === 'resume-failed'
      ? 'the re-wake got no turn and resuming the ended session failed'
      : 'the re-wake got no turn and the resumed session has not taken one either';
  return (
    `Park verdict not delivered: park ${s.consultId} on ${s.workItemId} reached "${s.verdict}" at ${s.emittedAt}, ` +
    `but ${s.parkerId} has not acted on it — ${why}. The work item stays blocked until someone picks it up.`
  );
}

/** Decide the one delivery step owed for `s` at `now`. Pure and idempotent. */
export function checkParkDelivery(s: ParkDeliveryState, now: string): ParkDeliveryAction {
  if (parkVerdictDelivered(s)) return { kind: 'none', reason: 'delivered' };
  if (s.ownerNotifiedAt) return { kind: 'none', reason: 'owner-notified' };

  const t = ms(now);
  const elapsed = (since: string) => t - ms(since) >= PARK_DELIVERY_GRACE_MS;

  // R-20/R-21: resume already tried — a failed launch, or still no turn after the grace, goes to the owner.
  if (s.resumeAttemptedAt) {
    if (s.resumeResult === 'failed') {
      return { kind: 'notify-owner', failure: 'resume-failed', text: ownerNotificationText(s, 'resume-failed') };
    }
    if (elapsed(s.resumeAttemptedAt)) {
      return {
        kind: 'notify-owner',
        failure: 'no-turn-after-resume',
        text: ownerNotificationText(s, 'no-turn-after-resume'),
      };
    }
    return { kind: 'none', reason: 'awaiting-resume-turn' };
  }

  // R-20: an ended session cannot take a wake, so resume it as soon as the grace passes.
  // R-7: otherwise the first step after the grace is a single re-wake.
  if (!s.rewakeAttemptedAt) {
    if (!elapsed(s.emittedAt)) return { kind: 'none', reason: 'within-grace' };
    if (s.parkerSessionState === 'ended') return { kind: 'resume', note: wakeNote(s) };
    return { kind: 'rewake', note: wakeNote(s) };
  }

  // The re-wake got no turn within the grace: resume from the checkpoint.
  if (elapsed(s.rewakeAttemptedAt)) return { kind: 'resume', note: wakeNote(s) };
  return { kind: 'none', reason: 'awaiting-rewake-turn' };
}

export interface ParkDeliveryDeps {
  rewake(s: ParkDeliveryState, note: string): Promise<void>;
  /** Resume the parked session from its checkpoint; resolve false when the launch fails. */
  resume(s: ParkDeliveryState, note: string): Promise<boolean>;
  notifyOwner(s: ParkDeliveryState, text: string): Promise<void>;
  /** Persist the delivery bookkeeping so the next check is idempotent. */
  record(
    s: ParkDeliveryState,
    patch: Partial<Pick<ParkDeliveryState, 'rewakeAttemptedAt' | 'resumeAttemptedAt' | 'resumeResult' | 'ownerNotifiedAt'>>,
  ): Promise<void>;
}

export interface ParkDeliveryResult {
  consultId: string;
  action: ParkDeliveryAction['kind'];
  reason?: ParkDeliveryReason;
  resumeResult?: 'ok' | 'failed';
}

/** Apply the one owed step. A resume that throws counts as a failed resume. */
export async function runParkDeliveryCheck(
  deps: ParkDeliveryDeps,
  s: ParkDeliveryState,
  now: string,
): Promise<ParkDeliveryResult> {
  const action = checkParkDelivery(s, now);
  switch (action.kind) {
    case 'none':
      return { consultId: s.consultId, action: 'none', reason: action.reason };
    case 'rewake':
      await deps.rewake(s, action.note);
      await deps.record(s, { rewakeAttemptedAt: now });
      return { consultId: s.consultId, action: 'rewake' };
    case 'resume': {
      let ok = false;
      try {
        ok = await deps.resume(s, action.note);
      } catch {
        ok = false;
      }
      const resumeResult = ok ? 'ok' : 'failed';
      await deps.record(s, { resumeAttemptedAt: now, resumeResult });
      return { consultId: s.consultId, action: 'resume', resumeResult };
    }
    case 'notify-owner':
      await deps.notifyOwner(s, action.text);
      await deps.record(s, { ownerNotifiedAt: now });
      return { consultId: s.consultId, action: 'notify-owner' };
  }
}

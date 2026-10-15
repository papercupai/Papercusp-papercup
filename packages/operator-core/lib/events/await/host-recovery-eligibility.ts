/**
 * Host recovery eligibility — the ONE definition of "will a wake to this psu host recover it".
 *
 * Two callers ask that question and must get the same answer:
 *   - wake-executor.ts, at inject time: an eligible auth/quota wall turns the wake into a
 *     `recycle` inject that respawns the child (P-004 / EI-21618720801156173);
 *   - stalled-loops-guard.ts, at disarm time (parked-agent-census-resumption-and-root-cause
 *     -2026-10-09 P-007): a loop whose fires produce no turn is only worth keeping armed when the
 *     NEXT fire will carry that recycle. Disarming it instead throws the recovery away; measured
 *     2026-10-10, 37 of 61 turns-stalled disarms were sessions with a dead provider login.
 *
 * Pure, and deliberately free of the executor's import graph so the guard can load it on every
 * routine tick.
 */

import { hostIsAgentLaunched, hostSupports, type PsuPtyHost, type PtyHostEvent } from './psu-pty-discovery';
import {
  hostRecoverableCondition,
  pickupHostView,
  pickupWindowSec,
  type PickupHostView,
  type PickupRecoverable,
} from './turn-proof';

/** The host fields the recovery gate reads. A live `PsuPtyHost` satisfies it. */
export interface RecoveryHostView {
  ownerId?: string | null;
  bridgeTty?: boolean | null;
  quotaBlocked?: boolean | null;
  authBlocked?: boolean | null;
  caps?: string[] | null;
  launchedBy?: string | null;
}

export interface QuotaWakeRecoveryDecision {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'wrong-owner'
    | 'not-quota-blocked'
    | 'not-headless'
    | 'not-agent-launched'
    | 'route-not-auto'
    | 'host-capability-missing'
    | 'auth-recovery-exhausted';
  /** Which wall the recycle clears. 'auth' = the child's in-memory provider
   * login is dead (P-004); 'quota' = the account is walled. */
  cause: 'quota' | 'auth';
  operationId: string;
}

/** P-004 bound: auth recoveries per owner inside AUTH_RECOVERY_WINDOW_MS. A
 * fresh child re-reads the shared auth file, so one recycle normally clears the
 * wall. If the shared login itself is dead, every new child fails the same way;
 * the bound stops a recycle-per-wake loop and leaves the failure visible. */
export const AUTH_RECOVERY_MAX_PER_WINDOW = 2;
export const AUTH_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;

/** Count this owner's auth recoveries the host recorded inside the window. */
export function recentAuthRecoveryCount(
  events: readonly PtyHostEvent[],
  ownerId: string,
  nowMs: number,
  windowMs: number = AUTH_RECOVERY_WINDOW_MS,
): number {
  let count = 0;
  for (const raw of events) {
    const event = raw as unknown as Record<string, unknown>;
    if (event.kind !== 'quota-recovery-started' || event.cause !== 'auth') continue;
    if (event.recoveryOwnerId !== ownerId) continue;
    const startedAtMs = event.startedAtMs;
    if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) continue;
    if (nowMs - startedAtMs <= windowMs) count += 1;
  }
  return count;
}

/** Pure, fail-closed eligibility gate for the one automatic lifecycle action in
 * this path. A quota recycle is useful only when gateway auto-routing can choose
 * a different credential. An auth recycle (P-004) is useful on any route: the
 * fresh child re-reads the shared login the old child holds a spent copy of.
 * Legacy hosts require headless agent provenance. A host advertising
 * quota-recovery-resume preserves the native Codex conversation and enforces
 * owner-input/native-work guards at its own mutation boundary. */
export function decideQuotaWakeRecovery(input: {
  host: RecoveryHostView;
  subscriberId: string;
  deliveryId: string;
  accountMode?: string | null;
  /** Auth recoveries already recorded for this owner inside the window. */
  priorAuthRecoveries?: number;
}): QuotaWakeRecoveryDecision {
  const base = { operationId: input.deliveryId, cause: 'quota' } as const;
  if (input.host.ownerId !== input.subscriberId) return { ...base, eligible: false, reason: 'wrong-owner' };
  if (input.host.authBlocked === true) {
    const auth = { ...base, cause: 'auth' } as const;
    if (input.host.bridgeTty !== false) return { ...auth, eligible: false, reason: 'not-headless' };
    if (!hostIsAgentLaunched(input.host as PsuPtyHost)) {
      return { ...auth, eligible: false, reason: 'not-agent-launched' };
    }
    if (!hostSupports(input.host as PsuPtyHost, 'auth-recovery')) {
      return { ...auth, eligible: false, reason: 'host-capability-missing' };
    }
    if ((input.priorAuthRecoveries ?? 0) >= AUTH_RECOVERY_MAX_PER_WINDOW) {
      return { ...auth, eligible: false, reason: 'auth-recovery-exhausted' };
    }
    return { ...auth, eligible: true, reason: 'eligible' };
  }
  if (input.host.quotaBlocked !== true) return { ...base, eligible: false, reason: 'not-quota-blocked' };
  const preservesConversation = hostSupports(input.host as PsuPtyHost, 'quota-recovery-resume');
  if (!preservesConversation && input.host.bridgeTty !== false) return { ...base, eligible: false, reason: 'not-headless' };
  if (!preservesConversation && !hostIsAgentLaunched(input.host as PsuPtyHost)) {
    return { ...base, eligible: false, reason: 'not-agent-launched' };
  }
  if (input.accountMode !== 'auto') return { ...base, eligible: false, reason: 'route-not-auto' };
  if (!hostSupports(input.host as PsuPtyHost, 'quota-recovery')) {
    return { ...base, eligible: false, reason: 'host-capability-missing' };
  }
  return { ...base, eligible: true, reason: 'eligible' };
}

// ── Stalled-loop host classification (P-007) ──────────────────────────────────────────────────

/** The live host as the stalled-loops guard reads it: discovery record plus its event tail. */
export interface StalledLoopHostReading {
  /** `startedAt` scopes the tail to the current host process (D-007); unknown counts every event.
   *  `lastOutputAt` exempts a visibly busy host from `pending-turn-stuck`. */
  host:
    | (RecoveryHostView &
        Pick<PickupHostView, 'execution'> & { startedAt?: number | null; lastOutputAt?: number | null })
    | null;
  /** The host's lifecycle event tail, oldest first. Empty when unreadable. */
  events: readonly PtyHostEvent[];
}

export type StalledLoopHostClass =
  /** No live psu host: the existing corpse/healthy disarm logic applies unchanged. */
  | { kind: 'no-host' }
  /** The host reports no P-004/P-005 condition: turns are genuinely not being produced. */
  | { kind: 'healthy' }
  /** The next wake will carry a child recycle that clears this condition. Keep firing. */
  | { kind: 'recoverable-on-wake'; condition: PickupRecoverable; cause: 'auth' | 'quota' }
  /** A wake cannot clear it. More fires only feed an agent that cannot answer. */
  | { kind: 'needs-relaunch'; condition: PickupRecoverable; why: string; remedy: string };

/**
 * Classify a turn-stalled loop's host (P-007).
 *
 * The condition comes from `hostRecoverableCondition` — the same judge the wake pickup sweep
 * uses (P-006), so "this host is wedged" means one thing everywhere. Whether a WAKE clears it
 * comes from `decideQuotaWakeRecovery` — the same gate the executor applies at inject time, so
 * the guard never keeps a loop armed for a recycle the executor would refuse.
 *
 * Two deliberate limits:
 *   - `unbound-successor` is never wake-recoverable. psu-pty-host refuses every turn to an
 *     unbindable child as `deferred-successor-unbindable` (P-005(c)), and the executor parks it,
 *     so a fire cannot reach the recovery. That session needs an identity-preserving relaunch.
 *   - For a quota wall the guard cannot see the delivery's live account route (the executor
 *     resolves it per delivery, after gateway repair). It predicts the HOST-level gates only and
 *     relies on the caller's bounded route budget to stop a misprediction from holding a loop
 *     armed forever.
 */
export function classifyStalledLoopHost(
  reading: StalledLoopHostReading,
  ownerId: string,
  nowMs: number,
  pickupWindowMs: number = pickupWindowSec() * 1000,
): StalledLoopHostClass {
  const host = reading.host;
  if (!host) return { kind: 'no-host' };
  const view = pickupHostView(
    {
      startedAt: host.startedAt ?? null,
      lastOutputAt: host.lastOutputAt ?? null,
      execution: host.execution ?? null,
      authBlocked: host.authBlocked === true,
      quotaBlocked: host.quotaBlocked === true,
    },
    reading.events,
    nowMs,
    pickupWindowMs,
  );
  const condition = hostRecoverableCondition(view);
  if (condition === null) return { kind: 'healthy' };

  if (condition === 'unbound-successor') {
    return {
      kind: 'needs-relaunch',
      condition,
      why:
        'the current child never bound a native session id after its carry-respawn, and the host ' +
        'refuses every turn to it as deferred-successor-unbindable (P-005(c))',
      remedy: 'relaunch the session through the identity-preserving successor route (P-012)',
    };
  }

  if (condition === 'pending-turn-stuck' && view.stuckPending) {
    const heldMin = Math.max(1, Math.round((nowMs - view.stuckPending.oldestAtMs) / 60_000));
    return {
      kind: 'needs-relaunch',
      condition,
      why:
        `the host has answered pending-delivery-id ${view.stuckPending.repolls} times over ${heldMin}m with no ` +
        'turn written since, so every further wake is ACKed into the same stalled pipeline (D-007)',
      remedy: 'relaunch the session through the identity-preserving successor route (P-012)',
    };
  }

  const decision = decideQuotaWakeRecovery({
    host,
    subscriberId: ownerId,
    deliveryId: 'stalled-loops-guard',
    // See the doc comment: host-level prediction only for quota walls.
    accountMode: condition === 'quota-blocked' ? 'auto' : null,
    priorAuthRecoveries:
      condition === 'auth-blocked' ? recentAuthRecoveryCount(reading.events, ownerId, nowMs) : 0,
  });
  if (decision.eligible) return { kind: 'recoverable-on-wake', condition, cause: decision.cause };

  const remedies: Record<QuotaWakeRecoveryDecision['reason'], string> = {
    eligible: '',
    'wrong-owner': 'the discovery record belongs to another owner; relaunch this session',
    'not-quota-blocked': 'relaunch this session',
    'not-headless':
      'this is an interactive (bridged) session, which is never recycled automatically; the owner ' +
      'must restart its CLI',
    'not-agent-launched':
      'this host was not launched by an agent, so it is never recycled automatically; relaunch it ' +
      'by hand',
    'route-not-auto': 'move the session to the auto account route, or wait out the wall',
    'host-capability-missing':
      'this host predates automatic recovery; relaunch it so the current psu-pty-host takes over',
    'auth-recovery-exhausted':
      `the host already recycled this child ${AUTH_RECOVERY_MAX_PER_WINDOW} times in ` +
      `${Math.round(AUTH_RECOVERY_WINDOW_MS / 3_600_000)}h and the login still fails, so the SHARED ` +
      'provider login is dead; re-authenticate the provider account, then relaunch',
  };
  return {
    kind: 'needs-relaunch',
    condition,
    why: `the host reports ${condition} and the wake recovery gate refuses it (${decision.reason})`,
    remedy: remedies[decision.reason],
  };
}

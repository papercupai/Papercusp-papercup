/** Recovery eligibility for an unexpectedly lost session host. This extends
 * the existing session/launch ledger and wake/resume machinery; it grants no
 * new task, autonomy mode, or native conversation. */
import type { PsuPtyHost } from '../../events/await/psu-pty-discovery';

export interface SessionInterruption {
  v: 1;
  ownerId: string;
  nativeSessionId: string;
  hostPid: number;
  hostStartedAt: number;
  execution: NonNullable<PsuPtyHost['execution']>;
  capturedAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: 'pending' | 'recovering' | 'restored' | 'blocked';
  leaseKey?: string;
}

export interface SessionRecoveryEvidence {
  ownerId: string;
  nativeSessionId: string | null;
  /** Actual native host/writer evidence, not a fresh heartbeat. */
  liveness: 'live' | 'dead' | 'unknown';
  retired: boolean;
  recoveryEnabled: boolean;
  deliberatelyPaused: boolean;
  launchRecipeAvailable: boolean;
  headless: boolean | null;
  interruption: SessionInterruption | null;
  /** null means the read failed; unknown must never become an empty wait set. */
  meaningfulWaits: number | null;
  humanDecisionPending: boolean | null;
  actionableHeldWork: number | null;
  loop: { active: boolean; goal: string | null; nextFireAt: number | null } | null;
}

export type SessionRecoveryDecision =
  | { action: 'hold'; reason: string }
  | { action: 'resume-work' | 'restore-wait'; reason: string; headless: boolean };

export const SESSION_RECOVERY_MAX_ATTEMPTS = 3;
export const SESSION_RECOVERY_LEASE_MS = 5 * 60_000;

/** Stable per host incarnation, so manual/event recovery and repeated census
 * ticks can share the native resume claim's replay protection. */
export function sessionRecoveryKey(s: SessionInterruption): string {
  return `interruption:${s.ownerId}:${s.nativeSessionId}:${s.hostPid}:${s.hostStartedAt}`;
}

export function classifySessionInterruption(e: SessionRecoveryEvidence, nowMs: number, ownedLease?: string): SessionRecoveryDecision {
  const hold = (reason: string): SessionRecoveryDecision => ({ action: 'hold', reason });
  if (e.retired) return hold('retired');
  if (!e.recoveryEnabled) return hold('recovery-disabled');
  if (e.deliberatelyPaused) return hold('deliberate-pause');
  if (e.liveness !== 'dead') return hold(e.liveness === 'live' ? 'already-running' : 'liveness-unknown');
  const s = e.interruption;
  if (!s || s.v !== 1) return hold('no-interruption-witness');
  if (s.ownerId !== e.ownerId || !e.nativeSessionId || s.nativeSessionId !== e.nativeSessionId) {
    return hold('identity-mismatch');
  }
  const x = s.execution;
  if (x.ownerId !== s.ownerId || x.hostPid !== s.hostPid || !Number.isFinite(s.hostStartedAt)
    || !Number.isFinite(x.observedAt) || x.observedAt < s.hostStartedAt
    || x.observedAt > s.capturedAt || s.capturedAt > nowMs) return hold('execution-witness-invalid');
  if (x.ownerStopRequested) return hold('owner-stop');
  if (!e.launchRecipeAvailable || e.headless == null) return hold('launch-recipe-unknown');
  if (s.state === 'restored' || s.state === 'blocked') return hold(s.state);
  const ownsLease = ownedLease != null && s.leaseKey === ownedLease && s.state === 'recovering';
  if (!ownsLease && s.attempts >= SESSION_RECOVERY_MAX_ATTEMPTS) return hold('retry-budget-exhausted');
  if (!ownsLease && s.nextAttemptAt > nowMs) return hold('backoff');
  if (e.humanDecisionPending == null || e.meaningfulWaits == null) return hold('waiting-state-unknown');
  if (e.humanDecisionPending || x.ownerInputPending) return hold('human-decision-pending');
  if (e.meaningfulWaits > 0) return { action: 'restore-wait', reason: 'meaningful-event-wait', headless: e.headless };
  if (e.loop?.active && e.loop.goal?.trim() && e.loop.nextFireAt != null && e.loop.nextFireAt > nowMs) {
    return { action: 'restore-wait', reason: 'scheduled-loop', headless: e.headless };
  }
  if (x.phase === 'running' && x.turnStartedAt != null && x.turnStartedAt >= s.hostStartedAt) {
    return { action: 'resume-work', reason: 'interrupted-native-turn', headless: e.headless };
  }
  if (e.actionableHeldWork != null && e.actionableHeldWork > 0) {
    return { action: 'resume-work', reason: 'actionable-held-work', headless: e.headless };
  }
  if (e.loop?.active && e.loop.goal?.trim() && e.loop.nextFireAt != null && e.loop.nextFireAt <= nowMs) {
    return { action: 'resume-work', reason: 'due-loop', headless: e.headless };
  }
  return hold(x.phase === 'settled' ? 'completed-or-idle' : 'no-authorized-work-evidence');
}

export interface SessionRecoveryDeps {
  list(): Promise<SessionRecoveryEvidence[]>;
  /** Atomic bounded lease on the existing session row, followed by a re-read. */
  claim(candidate: SessionRecoveryEvidence, key: string): Promise<SessionRecoveryEvidence | null>;
  restore(candidate: SessionRecoveryEvidence, decision: Exclude<SessionRecoveryDecision, { action: 'hold' }>,
    key: string): Promise<{ verified: boolean; reason: string }>;
  finish(candidate: SessionRecoveryEvidence, key: string, result: { verified: boolean; reason: string }): Promise<boolean | void>;
}

/** One bounded pass. A wait restore never supplies a work prompt. Errors consume
 * the same bounded attempt as a refused launch; they cannot spin per tick. */
export async function recoverInterruptedSessions(deps: SessionRecoveryDeps, nowMs = Date.now(), limit = 5) {
  const result = { checked: 0, attempted: [] as string[], restored: [] as string[], held: {} as Record<string, string> };
  for (const candidate of await deps.list()) {
    result.checked += 1;
    const decision = classifySessionInterruption(candidate, nowMs);
    if (decision.action === 'hold') { result.held[candidate.ownerId] = decision.reason; continue; }
    if (result.attempted.length >= limit) break;
    const key = sessionRecoveryKey(candidate.interruption!);
    const claimed = await deps.claim(candidate, key);
    if (!claimed) { result.held[candidate.ownerId] = 'claim-lost'; continue; }
    const fresh = classifySessionInterruption(claimed, nowMs, claimed.interruption?.leaseKey ?? key);
    if (fresh.action === 'hold') {
      await deps.finish(claimed, key, { verified: false, reason: fresh.reason });
      result.held[candidate.ownerId] = fresh.reason; continue;
    }
    result.attempted.push(candidate.ownerId);
    let outcome: { verified: boolean; reason: string };
    try { outcome = await deps.restore(claimed, fresh, key); }
    catch (error) { outcome = { verified: false, reason: error instanceof Error ? error.message : String(error) }; }
    const finished = await deps.finish(claimed, key, outcome);
    if (outcome.verified && finished !== false) result.restored.push(candidate.ownerId);
  }
  return result;
}

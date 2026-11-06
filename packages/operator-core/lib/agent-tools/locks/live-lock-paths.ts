/**
 * live-lock-paths — "which repo paths does a LIVE agent currently hold?", read from the
 * lock plane rather than from declared presence.
 *
 * WHY THIS EXISTS (EI-18776963284535761). Several collision-avoidance consumers were
 * built on `coord_presence.current_files`, which is populated only by an explicit
 * `coord:declare-intent { current_files }`. Almost nothing declares it, and until the fix
 * in that item every `coord:orient` actively WIPED it — measured 113 live presence rows,
 * 0 populated. So those consumers were reading a permanently-empty set and silently
 * degraded to no-ops.
 *
 * The lock plane is the authority on who is on a file (the same conclusion `coord:send`
 * states in its own `@file:` miss message, and the fix EI-18772330418885814 applied to
 * the `@file:` audience). It is also AUTOMATIC: the PreToolUse edit hook acquires a lock
 * on every Edit/Write, so it reflects real activity with no agent discipline required.
 *
 * ⚠ This is deliberately NOT wired back into `current_files` itself. That column must stay
 * a DECLARED signal, because `locks/enrich-busy.ts` compares it against the contended path
 * to decide whether a lock holder is still focused on it (`holder_focused`, the veto that
 * protects a live holder from being advertised as an orphaned lock, EI-10433). A holder
 * holds a lock on the contended path by definition, so a lock-derived `current_files`
 * would make that term CONSTANT-TRUE and kill the orphan signal — the same
 * constant-valued-term bug the original issue was about, merely inverted. Consumers that
 * want the automatic signal call THIS; consumers that want the declared one read presence.
 */

import { ensureBootstrap, getTxPool, readQueue, type ReadQueuePhaseEvent } from './su-lock-store';

export type LiveLockPathPhase = 'ensureBootstrap' | 'pool-lookup' | ReadQueuePhaseEvent['phase'];

export interface LiveLockPathPhaseEvent {
  phase: LiveLockPathPhase;
  state: 'start' | 'end';
  durationMs?: number;
}

export interface LiveLockPathReadOptions {
  /** Optional bounded phase diagnostics for callers with an outer timeout. */
  onPhase?: (event: LiveLockPathPhaseEvent) => void;
}

function reportLiveLockPathPhase(
  observer: LiveLockPathReadOptions['onPhase'],
  event: LiveLockPathPhaseEvent,
): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Diagnostics must not change lock-read behavior.
  }
}

async function observeAsyncPhase<T>(
  observer: LiveLockPathReadOptions['onPhase'],
  phase: LiveLockPathPhase,
  operation: () => Promise<T>,
): Promise<T> {
  // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/observeAsyncPhase:22479e25eb9f5221ba9b:1","classification":"safe-to-lose","reason":"This private helper receives only ensureBootstrap. Bootstrap never marks resource-lock-store's transaction-local expiry set, so its shared transaction wrapper passes an empty receipt list to notifyResourceExpiries; there is no expiry notice to lose."}
  if (!observer) return operation();
  const startedAt = Date.now();
  reportLiveLockPathPhase(observer, { phase, state: 'start' });
  try {
    // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/observeAsyncPhase:22479e25eb9f5221ba9b:2","classification":"safe-to-lose","reason":"The observed branch awaits the same bootstrap-only callback. Bootstrap has no resource sweep and cannot mark the expiry receipt set; phase diagnostics do not introduce an expiry notification."}
    return await operation();
  } finally {
    reportLiveLockPathPhase(observer, {
      phase,
      state: 'end',
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }
}

function observeSyncPhase<T>(
  observer: LiveLockPathReadOptions['onPhase'],
  phase: LiveLockPathPhase,
  operation: () => T,
): T {
  if (!observer) return operation();
  const startedAt = Date.now();
  reportLiveLockPathPhase(observer, { phase, state: 'start' });
  try {
    return operation();
  } finally {
    reportLiveLockPathPhase(observer, {
      phase,
      state: 'end',
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }
}

export interface LiveLockHolding {
  path: string;
  owner: string;
  /** The holder's declared edit intent, preserved for actionable git-sync diagnostics. */
  intent: string;
  /** The active work-item/goal associated with the lock, when the caller stamped one. */
  goalRef?: string;
  /**
   * The lock's coordination domain: the absolute root of the repository `path` is relative
   * to. The read below spans EVERY domain, so a consumer that compares `path` against one
   * specific tree must translate by this first (EI-24649116564770033; git-sync does so via
   * `translateLiveLockHoldingsToRoot`).
   */
  coordinationDomain?: string;
}

/**
 * Read every currently-held file lock without swallowing lock-plane failures.
 *
 * Most collision-avoidance callers should use {@link liveLockHoldings}, whose
 * fail-soft contract preserves their historical best-effort behaviour. Commit
 * gates are different: treating an unreadable lock plane as an empty set can
 * stage a peer's in-flight (including temporarily truncated) file. Those
 * callers use this strict seam and must fail closed when it throws.
 */
export async function liveLockHoldingsStrict(options: LiveLockPathReadOptions = {}): Promise<LiveLockHolding[]> {
  // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/liveLockHoldingsStrict:5125ae23e177cc0eb3e3:1","classification":"safe-to-lose","reason":"The awaited bootstrap/migration path does not call a resource sweep. takeResourceExpiryReleases returns [] for its unmarked transaction, so the conservative graph edge to notifyResourceExpiries produces no notice."}
  // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/liveLockHoldingsStrict/<callback>:40e72844df81469ea8c1:1","classification":"safe-to-lose","reason":"This callback supplies only ensureBootstrap to the private observer wrapper; schema bootstrap never marks a resource-expiry transaction. The actual mutating resource-expiry emitter is outside this read path."}
  await observeAsyncPhase(options.onPhase, 'ensureBootstrap', () => ensureBootstrap());
  // readQueue already filters holders to expires_ts > clock_timestamp(), so the set is
  // live by construction. No `paths`/`owner` filter ⇒ the whole active set.
  const pool = observeSyncPhase(options.onPhase, 'pool-lookup', () => getTxPool());
  const queue = options.onPhase
    // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/liveLockHoldingsStrict:0a6b89763cacf8f3d235:1","classification":"safe-to-lose","reason":"readQueue with diagnostics runs only SELECTs and SET LOCAL; it never marks the resource-expiry transaction set, so the shared transaction wrapper has no receipt to notify. The maintained lock-store readQueue regression also exercises this diagnostic branch."}
    ? await readQueue(pool, { coordinationDomain: null, includeWaiting: false }, { onPhase: options.onPhase })
    // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/liveLockHoldingsStrict:9aefc15f92dcab69e0ef:1","classification":"safe-to-lose","reason":"readQueue without diagnostics runs only SELECTs and SET LOCAL; takeResourceExpiryReleases receives an unmarked transaction and returns [], so no expiry notification is discarded. The maintained lock-store readQueue regression covers this branch."}
    : await readQueue(pool, { coordinationDomain: null, includeWaiting: false });
  return queue.active_locks.map((l) => ({
    path: l.path,
    owner: l.owner,
    intent: l.intent,
    ...(l.goal_ref?.trim() ? { goalRef: l.goal_ref.trim() } : {}),
    ...(l.coordination_domain?.trim() ? { coordinationDomain: l.coordination_domain.trim() } : {}),
  }));
}

/**
 * Every path currently held by a live lock, with its holder.
 *
 * `coordinationDomain: null` reads across EVERY domain, matching the audience-host
 * `@file:` read: the domain resolves from whichever checkout the operator process
 * loaded, so a domain-scoped read can report a genuinely-held lock as absent (observed
 * live — an agent editing the staging tree had its lock recorded under
 * `…/papercup-release`). Missing a real holder is the failure mode this exists to remove.
 *
 * HOLDERS ONLY, not waiters: unlike an audience — where an extra recipient is harmless —
 * a false positive here DEFERS real work, and a waiter is by definition not editing yet.
 *
 * Fail-soft: any error (locks unconfigured, side-DB unreachable) returns [] so the caller
 * degrades to exactly its pre-existing behaviour rather than breaking.
 */
export async function liveLockHoldings(options: LiveLockPathReadOptions = {}): Promise<LiveLockHolding[]> {
  try {
    // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/liveLockHoldings:02d349c8b353c6bd527a:1","classification":"safe-to-lose","reason":"This fail-soft wrapper awaits bootstrap and a holder-only queue read. Neither marks the transaction-local resource-expiry set, so the underlying shared notification hook receives [] rather than an expiry signal."}
    return await liveLockHoldingsStrict(options);
  } catch {
    return [];
  }
}

/** The distinct held paths, optionally excluding one agent's own holdings. */
export async function liveLockedPaths(
  opts: { excludeOwner?: string; onPhase?: LiveLockPathReadOptions['onPhase'] } = {},
): Promise<string[]> {
  // notify-classification: {"id":"packages/operator-core/lib/agent-tools/locks/live-lock-paths.ts#<module>/liveLockedPaths:fe655c2c970224eb176b:1","classification":"safe-to-lose","reason":"This projects the awaited holder-only queue result. The complete local path contains no resource sweep, and the unmarked expiry receipt set prevents the shared transaction hook from emitting any expiry notice."}
  const holdings = await liveLockHoldings({ onPhase: opts.onPhase });
  const seen = new Set<string>();
  for (const h of holdings) {
    if (opts.excludeOwner && h.owner === opts.excludeOwner) continue;
    const path = h.path.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}

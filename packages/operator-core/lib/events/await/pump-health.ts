/**
 * pump-health.ts — page when the wake pump (or its sweep) fails continuously (WI-10008194).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every wake in the fleet (coord:wake, a wake-carrying coord:send, an events:await fire, a loop
 * fire) is delivered by `pumpWakeDeliveries`, kicked on each emit and by the 30s sweeper. When the
 * pump throws, the kick sites only `console.warn` the error — and on this box journald books
 * console.warn AND console.error at the same `info` priority, so the log level carries no alarm
 * either. Measured 2026-10-10: bg-host restarted at 20:19:10Z onto code that wrote migration 1441's
 * columns while the boot gate had withheld 1441; every pump kick, sweep and pickup sweep then failed
 * with `column "turn_proof" of relation "event_wake_deliveries" does not exist`. No wake was booked
 * `delivered` fleet-wide from 20:28Z, `delivering` rows piled to 94, and nothing paged — the outage
 * was found by hand ~20:37Z and fixed 20:44:44Z. The boot-migration gate DID page (20:29:28Z), but
 * it can only say "the background plane is withheld"; it cannot know that code running OUTSIDE the
 * gate depends on a withheld migration.
 *
 * THE MECHANISM — a per-(workspace, leg) consecutive-failure streak
 * -----------------------------------------------------------------
 * Each pump/sweep/pickup-sweep run reports its outcome here. A success resets that leg's streak
 * (and resolves its page if one was raised); a failure extends it. Once a streak has BOTH
 * {@link PUMP_FAILURE_ALARM_MIN_FAILURES} failures AND has lasted {@link PUMP_FAILURE_ALARM_MIN_DURATION_MS},
 * the tracker pages ONCE for that episode. Requiring both keeps a transient pooler blip (a couple of
 * failures in a few seconds) silent while still paging within ~2–3 minutes of a real outage — the
 * sweeper alone guarantees ≥4 attempts per 2 minutes, and emits add many more.
 *
 * Legs are tracked separately on purpose: a healthy pump must not mask a sweep that fails every tick
 * (the sweep owns stuck-delivery recovery, timeouts and turn-proof resolution).
 *
 * The tracker is pure (injected clock + raise/clear) so the whole episode is unit-testable; the
 * production instance wires the owner-attention notification and the one-shot severe broadcast,
 * mirroring `boot-migration-gate.ts`. Raising/clearing is fire-and-forget and never throws into the
 * pump: an alarm path must not be able to break the thing it watches.
 */
import { pinModuleState } from '@papercusp/module-singleton';

export type PumpLeg = 'pump' | 'sweep' | 'pickup-sweep';

/** Consecutive failures a streak needs before it can page. */
export const PUMP_FAILURE_ALARM_MIN_FAILURES = 5;

/** How long a streak must have lasted before it can page. */
export const PUMP_FAILURE_ALARM_MIN_DURATION_MS = 2 * 60_000;

export interface PumpFailureAlarm {
  workspaceId: string;
  leg: PumpLeg;
  /** Consecutive failures in this streak at the moment of the call. */
  failures: number;
  /** Epoch ms of the streak's first failure. */
  failingSince: number;
  /** How long the streak has lasted at the moment of the call. */
  failingMs: number;
  /** The most recent failure message. */
  lastError: string;
  /** True when the error names a missing column/relation — a code-ahead-of-schema mismatch. */
  schemaMismatch: boolean;
}

export interface PumpHealthDeps {
  raise: (alarm: PumpFailureAlarm) => Promise<void>;
  clear: (alarm: PumpFailureAlarm) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  minFailures?: number;
  minDurationMs?: number;
}

export interface PumpHealthTracker {
  recordFailure(workspaceId: string, leg: PumpLeg, error: unknown): void;
  recordSuccess(workspaceId: string, leg: PumpLeg): void;
  /** Test/diagnostic seam: the live streaks. */
  streaks(): Array<PumpFailureAlarm & { alarmed: boolean }>;
}

interface Streak {
  failures: number;
  firstAt: number;
  lastError: string;
  alarmed: boolean;
}

const SCHEMA_MISMATCH_RE = /(column|relation) "[^"]+"( of relation "[^"]+")? does not exist/i;

export function isSchemaMismatchError(message: string): boolean {
  return SCHEMA_MISMATCH_RE.test(message);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function createPumpHealthTracker(deps: PumpHealthDeps): PumpHealthTracker {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const minFailures = deps.minFailures ?? PUMP_FAILURE_ALARM_MIN_FAILURES;
  const minDurationMs = deps.minDurationMs ?? PUMP_FAILURE_ALARM_MIN_DURATION_MS;
  const streaks = new Map<string, Streak & { workspaceId: string; leg: PumpLeg }>();

  const snapshot = (s: Streak & { workspaceId: string; leg: PumpLeg }): PumpFailureAlarm => ({
    workspaceId: s.workspaceId,
    leg: s.leg,
    failures: s.failures,
    failingSince: s.firstAt,
    failingMs: now() - s.firstAt,
    lastError: s.lastError,
    schemaMismatch: isSchemaMismatchError(s.lastError),
  });

  const fireAndForget = (label: string, p: () => Promise<void>): void => {
    try {
      void p().catch((e: unknown) => log(`[await-event] wake-${label} failed (non-fatal): ${messageOf(e)}`));
    } catch (e) {
      log(`[await-event] wake-${label} failed (non-fatal): ${messageOf(e)}`);
    }
  };

  return {
    recordFailure(workspaceId, leg, error) {
      const key = `${workspaceId}\u0000${leg}`;
      const message = messageOf(error);
      let s = streaks.get(key);
      if (!s) {
        s = { workspaceId, leg, failures: 0, firstAt: now(), lastError: message, alarmed: false };
        streaks.set(key, s);
      }
      s.failures += 1;
      s.lastError = message;
      if (!s.alarmed && s.failures >= minFailures && now() - s.firstAt >= minDurationMs) {
        s.alarmed = true;
        const alarm = snapshot(s);
        log(
          `[await-event] 🚨 wake ${leg} FAILING for ${Math.round(alarm.failingMs / 1000)}s ` +
            `(${alarm.failures} consecutive failures, ws=${workspaceId}): ${message}`,
        );
        fireAndForget('alarm', () => deps.raise(alarm));
      }
    },
    recordSuccess(workspaceId, leg) {
      const key = `${workspaceId}\u0000${leg}`;
      const s = streaks.get(key);
      if (!s) return;
      streaks.delete(key);
      if (!s.alarmed) return;
      const alarm = snapshot(s);
      log(
        `[await-event] ✅ wake ${leg} RECOVERED after ${Math.round(alarm.failingMs / 1000)}s ` +
          `(${alarm.failures} failures, ws=${workspaceId})`,
      );
      fireAndForget('alarm resolve', () => deps.clear(alarm));
    },
    streaks() {
      return [...streaks.values()].map((s) => ({ ...snapshot(s), alarmed: s.alarmed }));
    },
  };
}

/** Stable per-(host, workspace, leg) condition key so the recovery broadcast resolves the same page. */
export function pumpFailureConditionKey(host: string, workspaceId: string, leg: PumpLeg): string {
  return `wake-pump-failing:${host}:${workspaceId}:${leg}`;
}

export function pumpFailureAlarmText(alarm: PumpFailureAlarm, host: string): { summary: string; body: string } {
  const minutes = Math.max(1, Math.round(alarm.failingMs / 60_000));
  const summary =
    `🚨 ${host}: wake ${alarm.leg} FAILING for ${minutes}m (${alarm.failures} consecutive failures, ` +
    `ws=${alarm.workspaceId}) — agent wakes from this host are NOT being delivered. Last error: ${alarm.lastError}`;
  const cause = alarm.schemaMismatch
    ? 'The error names a missing column/relation: code on this host is ahead of the live schema — most often a ' +
      'migration the boot gate has withheld (check db:migrations / db:check_drift and any open ' +
      '"boot-migration-gate-withheld" alarm). Either apply the migration or make the code degrade until it lands ' +
      '(see packages/operator-core/lib/events/await/turn-proof-schema.ts).'
    : 'Read the host log for the full error: logs:read { unit, grep: "await-event" }.';
  const body =
    `The wake ${alarm.leg} on ${host} has failed on every run since ${new Date(alarm.failingSince).toISOString()}. ` +
    'While it fails, coord:wake, wake-carrying coord:send, events:await fires and loop wakes queue as pending/' +
    `delivering and no agent is woken. ${cause} This page resolves on the next successful ${alarm.leg} run; ` +
    'no restart is needed once the cause is fixed (a restart cannot fix a schema mismatch).';
  return { summary, body };
}

/** Production alarm: urgent owner attention + a one-shot severe broadcast, like the boot gate. */
export async function raisePumpFailureAlarm(alarm: PumpFailureAlarm, host: string): Promise<void> {
  const { summary, body } = pumpFailureAlarmText(alarm, host);
  try {
    const { notifyAttention } = await import('../../attention-notify');
    await notifyAttention({
      kind: 'intervention',
      title: `Wake ${alarm.leg} failing on ${host}: agent wakes are not being delivered`,
      body: `${summary}\n\n${body}`,
      importance: 'urgent',
      data: {
        host,
        workspaceId: alarm.workspaceId,
        leg: alarm.leg,
        failingSince: alarm.failingSince,
        failures: alarm.failures,
        lastError: alarm.lastError,
        schemaMismatch: alarm.schemaMismatch,
      },
    });
  } catch (e) {
    console.warn(`[await-event] wake-pump alarm notify failed (non-fatal): ${messageOf(e)}`);
  }
  try {
    const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
    await broadcastSevereEvent({
      summary,
      body,
      category: 'severe-event',
      conditionKey: pumpFailureConditionKey(host, alarm.workspaceId, alarm.leg),
      oneShot: true,
    });
  } catch (e) {
    console.warn(`[await-event] wake-pump alarm broadcast failed (non-fatal): ${messageOf(e)}`);
  }
}

export async function clearPumpFailureAlarm(alarm: PumpFailureAlarm, host: string): Promise<void> {
  try {
    const { broadcastSevereEventResolved } = await import('../../severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: pumpFailureConditionKey(host, alarm.workspaceId, alarm.leg),
      summary:
        `${host}: wake ${alarm.leg} RECOVERED after ${Math.max(1, Math.round(alarm.failingMs / 60_000))}m ` +
        `(${alarm.failures} failures, ws=${alarm.workspaceId}) — wakes are being delivered again.`,
    });
  } catch (e) {
    console.warn(`[await-event] wake-pump alarm resolve failed (non-fatal): ${messageOf(e)}`);
  }
}

async function productionHost(): Promise<string> {
  try {
    const { hostIdentity } = await import('../../serving-host-identity');
    return hostIdentity();
  } catch {
    return `pid-${process.pid}`;
  }
}

const state = pinModuleState('@papercusp/operator-core.events.await.pump-health', () => ({
  tracker: null as PumpHealthTracker | null,
}));

/** The process-wide tracker the engine reports to. Lazily built with the production alarm. */
export function pumpHealth(): PumpHealthTracker {
  if (!state.tracker) {
    state.tracker = createPumpHealthTracker({
      raise: async (alarm) => raisePumpFailureAlarm(alarm, await productionHost()),
      clear: async (alarm) => clearPumpFailureAlarm(alarm, await productionHost()),
    });
  }
  return state.tracker;
}

/** Test seam: swap (or reset with null) the process-wide tracker. Returns the previous one. */
export function setPumpHealthTrackerForTests(tracker: PumpHealthTracker | null): PumpHealthTracker | null {
  const prev = state.tracker;
  state.tracker = tracker;
  return prev;
}

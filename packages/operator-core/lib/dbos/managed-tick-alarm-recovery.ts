import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { createNotifyBus } from '../pg-notify-bus';
import { coordScopeWorkspace } from '../agent-tools/coordination/log';
import { asSevereEventEmitter, probeSevereEventEmitter, type SevereEventEmitter,
  type SevereEventEmitterLiveness } from '../severe-event-emitter';

const PREFIX = 'alarm:managed-tick:';
const MAX_INTERVAL_MS = 60_000;

export interface ManagedTickRecoveryDeps {
  read?: () => Promise<Record<string, unknown>[]>;
  probe?: (emitter: SevereEventEmitter) => SevereEventEmitterLiveness;
  resolve?: (conditionKey: string) => Promise<boolean>;
  /** Durable alarm-change hints, including a rescan when LISTEN reconnects. */
  subscribe?: (changed: () => void) => () => void;
}

/** Reuse the original condition envelopes; silence and an unreadable PID never mean death. */
export async function reconcileManagedTickAlarms(deps: ManagedTickRecoveryDeps = {}): Promise<{
  resolved: string[]; intervalMs: number;
}> {
  const { computeConditionStates, readConditionEnvelopesForPrefix } =
    await import('../agent-tools/coordination/condition-state');
  const envelopes = await (deps.read ?? (() => readConditionEnvelopesForPrefix(PREFIX)))();
  const states = computeConditionStates(envelopes);
  const alarms = new Map<string, Record<string, unknown>>();
  // Match the fold's chronological order, retaining the ORIGINAL alarm even after resolution.
  for (const envelope of [...envelopes].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    if (typeof envelope.condition_key === 'string' && !envelope.resolves_condition && !envelope.resolves_conditions)
      alarms.set(envelope.condition_key, envelope);
  }
  let intervalMs = MAX_INTERVAL_MS;
  const resolved: string[] = [];
  for (const state of states) {
    if (!state.open || !state.condition_key.startsWith(PREFIX) || !state.one_shot) continue;
    const alarm = alarms.get(state.condition_key);
    const data = alarm?.data;
    if (!data || typeof data !== 'object') continue;
    const episode = data as Record<string, unknown>;
    const cadence = episode.watcherIntervalMs;
    if (typeof cadence !== 'number' || !Number.isFinite(cadence) || cadence <= 0 || cadence > MAX_INTERVAL_MS
      || typeof episode.producerRun !== 'string' || !episode.producerRun
      || !Number.isSafeInteger(episode.id) || Number(episode.id) <= 0
      || state.condition_key !== `${PREFIX}${episode.producerRun}:${episode.id}`
      || typeof episode.timerName !== 'string' || !episode.timerName
      || typeof episode.timerKey !== 'string' || !episode.timerKey
      || typeof episode.heldMs !== 'number' || !Number.isFinite(episode.heldMs)
      || typeof episode.thresholdMs !== 'number' || !Number.isFinite(episode.thresholdMs)
      || episode.thresholdMs <= 0 || episode.heldMs <= episode.thresholdMs) continue;
    intervalMs = Math.min(intervalMs, cadence);
    const emitter = asSevereEventEmitter(alarm?.emitter);
    if (!emitter || (deps.probe ?? probeSevereEventEmitter)(emitter) !== 'dead') continue;
    const resolve = deps.resolve ?? (async (key: string) => {
      const { resolveAlarm } = await import('../alarm-attention');
      return resolveAlarm(key, 'managed-tick-watch', {},
        `Original managed tick ended: ${episode.timerName} (${episode.timerKey}), ` +
        `episode ${episode.id}, held ${episode.heldMs}ms; original producer incarnation is proven dead.`);
    });
    if (await resolve(state.condition_key)) resolved.push(state.condition_key);
  }
  return { resolved, intervalMs };
}

let stopRecovery: (() => void) | undefined;

/** The same managed watcher rail also reconciles persisted episodes immediately on startup. */
export function startManagedTickAlarmRecovery(deps: ManagedTickRecoveryDeps = {}): {
  observeInterval: (intervalMs: number) => void; ready: Promise<void>; stop: () => void;
} {
  stopRecovery?.();
  let recovery: ManagedHandle | undefined;
  let active = true;
  let unsubscribe: (() => void) | undefined;
  let inFlight: Promise<void> | null = null;
  let dirty = false;
  let intervalMs = MAX_INTERVAL_MS;
  let observationVersion = 0;
  const replaceInterval = (nextMs: number): void => {
    if (!active || nextMs === intervalMs) return;
    intervalMs = nextMs;
    recovery?.stop();
    arm(false);
  };
  const run = (): Promise<void> => {
    dirty = true;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (active && dirty) {
        dirty = false;
        const version = observationVersion;
        const result = await reconcileManagedTickAlarms(deps);
        // A notification arriving during an older read requests another pass.
        // A local alarm must also retain its tighter bound until that pass.
        replaceInterval(version === observationVersion ? result.intervalMs : Math.min(intervalMs, result.intervalMs));
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  const arm = (fireOnArm: boolean): void => {
    recovery = managedSetInterval('managed-tick-watch', intervalMs, run, {
      instanced: true, category: 'watchdog', classification: 'timeout-reaper', fireOnArm,
      activity: { kind: 'required-control', reason: 'Reconciles original managed ticks after authoritative producer death.' },
    });
  };
  const observeInterval = (observedMs: number): void => {
    if (!active || !Number.isFinite(observedMs) || observedMs <= 0) return;
    observationVersion++;
    replaceInterval(Math.min(intervalMs, observedMs));
  };
  const changed = (): void => {
    if (!active) return;
    void run().catch(error => console.warn('[managed-tick-recovery] condition rescan failed:',
      error instanceof Error ? error.name : 'unknown'));
  };
  arm(false);
  const ready = run();
  void ready.catch(error => console.warn('[managed-tick-recovery] startup rescan failed:',
    error instanceof Error ? error.name : 'unknown'));
  // Reuse migration126's existing coord_inbox channel. Filter system alarm
  // writes in this workspace; notification payloads are hints, never death proof.
  const subscribe = deps.subscribe ?? ((notify: () => void) => {
    const bus = createNotifyBus('coord_inbox', 'managed-tick-recovery', notify);
    return bus.subscribe(payload => {
      if (payload === `${coordScopeWorkspace()}::system-watchdog`) notify();
    });
  });
  unsubscribe = subscribe(changed);
  const stop = (): void => { active = false; recovery?.stop(); unsubscribe?.(); };
  stopRecovery = stop;
  return { observeInterval, ready, stop };
}

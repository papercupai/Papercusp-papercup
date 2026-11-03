import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { asSevereEventEmitter, probeSevereEventEmitter, type SevereEventEmitter,
  type SevereEventEmitterLiveness } from '../severe-event-emitter';

const PREFIX = 'alarm:managed-tick:';
const MAX_INTERVAL_MS = 60_000;

export interface ManagedTickRecoveryDeps {
  read?: () => Promise<Record<string, unknown>[]>;
  probe?: (emitter: SevereEventEmitter) => SevereEventEmitterLiveness;
  resolve?: (conditionKey: string) => Promise<boolean>;
}

/** Reuse the original condition envelopes; silence and an unreadable PID never mean death. */
export async function reconcileManagedTickAlarms(deps: ManagedTickRecoveryDeps = {}): Promise<{
  resolved: string[]; intervalMs: number;
}> {
  const { computeConditionStates, readConditionEnvelopesForPrefix } =
    await import('../agent-tools/coordination/tools/conditions');
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

let recovery: ManagedHandle | undefined;

/** The same managed watcher rail also reconciles persisted episodes immediately on startup. */
export function startManagedTickAlarmRecovery(deps: ManagedTickRecoveryDeps = {}): { observeInterval: (intervalMs: number) => void } {
  recovery?.stop();
  let intervalMs = MAX_INTERVAL_MS;
  let observationVersion = 0;
  const replaceInterval = (nextMs: number): void => {
    if (nextMs === intervalMs) return;
    intervalMs = nextMs;
    recovery?.stop();
    arm(false);
  };
  const arm = (fireOnArm: boolean): void => {
    recovery = managedSetInterval('managed-tick-watch', intervalMs, async () => {
      const version = observationVersion;
      const result = await reconcileManagedTickAlarms(deps);
      // An older empty read cannot undo a just-persisted local alarm's bound.
      replaceInterval(version === observationVersion ? result.intervalMs : Math.min(intervalMs, result.intervalMs));
    }, {
      instanced: true, category: 'watchdog', classification: 'timeout-reaper', fireOnArm,
      activity: { kind: 'required-control', reason: 'Reconciles original managed ticks after authoritative producer death.' },
    });
  };
  const observeInterval = (observedMs: number): void => {
    if (!Number.isFinite(observedMs) || observedMs <= 0) return;
    observationVersion++;
    replaceInterval(Math.min(intervalMs, observedMs));
  };
  arm(true);
  return { observeInterval };
}

import { randomUUID } from 'node:crypto';
import { configureScheduledRegistry, type ManagedTickEpisode } from '@papercusp/scheduled-registry';
import type { AlarmAttentionDeps } from '../alarm-attention';

// A new process owns new episodes, including when its PID is reused after restart.
const processEpoch = randomUUID();

/** Wire the existing attention/condition rail; neither delivery leg goes through DBOS. */
export function installManagedTickAlarm(deps: AlarmAttentionDeps = {}): void {
  const conditionKey = (episode: ManagedTickEpisode): string =>
    `alarm:managed-tick:${processEpoch}:${episode.id}`;
  configureScheduledRegistry({
    onHungTick: async (episode) => {
      const { escalateAlarm, DEFAULT_ALARM_ESCALATION_COOLDOWN_MS } = await import('../alarm-attention');
      await escalateAlarm({
        source: 'managed-tick-watch',
        title: `Managed timer ${episode.timerName} is hung`,
        body: `${episode.timerName} (${episode.timerKey}) has held its tick for ${episode.heldMs}ms ` +
          `(threshold ${episode.thresholdMs}ms, episode ${episode.id}).`,
        conditionKey: conditionKey(episode),
        cooldownMs: DEFAULT_ALARM_ESCALATION_COOLDOWN_MS,
        data: { ...episode },
      }, deps);
    },
    onHungTickSettled: async (episode) => {
      const { resolveAlarm } = await import('../alarm-attention');
      await resolveAlarm(conditionKey(episode), 'managed-tick-watch', deps);
    },
  });
}

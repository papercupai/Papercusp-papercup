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
    canRun: (entry) => {
      const activity = entry.activity;
      // Unclassified legacy timers have no workspace switch yet. Their inventory must
      // remain unknown; this adapter must not manufacture a workspace from global state.
      if (activity === undefined) return true;
      if (activity.kind === 'required-control')
        return typeof activity.reason === 'string' && activity.reason.trim().length > 0;
      if (activity.kind !== 'workspace') return false;
      if (typeof activity.workspaceId !== 'string' || !activity.workspaceId.trim() || activity.workspaceId === '*'
        || typeof activity.featureId !== 'string' || !/^activity-[a-f0-9]{64}$/.test(activity.featureId)) return false;
      return import('../device-operator-actions').then(({ workspaceBackgroundActivityAllowed }) =>
        workspaceBackgroundActivityAllowed(activity.workspaceId, activity.featureId));
    },
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

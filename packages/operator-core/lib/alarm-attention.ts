/**
 * Shared delivery rail for periodic alarms that cross an explicit attention
 * threshold.
 *
 * Alarm detectors still own their policy: they decide which observations are
 * severe enough to call a human and provide a title/body. This module owns the
 * cross-alarm mechanics that must not drift: a durable cross-restart cooldown,
 * the attention-notify delivery path, and fail-open observability semantics.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AttentionNotifyInput } from './attention-notify';
import type { SevereEventBroadcast, SevereEventResolution } from './severe-event-broadcast';

export const DEFAULT_ALARM_ESCALATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface AlarmAttentionRequest {
  /** Stable title used as the durable cooldown identity. */
  title: string;
  body: string;
  /** The alarm's explicit repeat-notification policy. */
  cooldownMs: number;
  /** Used only to make non-fatal failures attributable in logs. */
  source: string;
  /** Stable per-caller identity, independent of the repeat-notification cooldown. */
  conditionKey: string;
  /** Native detector evidence persisted with the existing notification receipt. */
  data?: AttentionNotifyInput['data'];
  /** This episode emits once and must never clear from signal absence. */
  oneShot?: boolean;
}

export interface AlarmAttentionDeps {
  /**
   * Injectable for tests; production defaults to notifyAttention. Takes the FULL
   * AttentionNotifyInput (kind, importance, routing data), never a {title, body}
   * subset: a narrowed seam hides urgency and routing from every test that injects
   * it (WI-6554700010009741; guarded by lint:di-seam-arity-strands).
   */
  notify?: (input: AttentionNotifyInput) => Promise<void>;
  /** Injectable for tests; production reads the durable notification rail. */
  recentlyEscalated?: () => Promise<boolean>;
  broadcast?: (input: SevereEventBroadcast) => Promise<boolean>;
  resolve?: (input: SevereEventResolution) => Promise<boolean>;
}

async function defaultRecentlyEscalated(title: string, cooldownMs: number): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const cutoffIso = new Date(Date.now() - cooldownMs).toISOString();
    const rows = await sql/* sql */ `
      select 1
        from harness_shared.attention_notifications
       where title = ${title}
         and created_at > ${cutoffIso}::timestamptz
       limit 1`;
    return rows.length > 0;
  } catch {
    // Fail open: a cooldown read failure costs one extra ping, while failing
    // closed could swallow the alert that says the system is about to fail.
    return false;
  }
}

async function defaultResolve(input: SevereEventResolution): Promise<boolean> {
  const { computeConditionStates, readConditionEnvelopes, readLatestConditionEnvelope } =
    await import('./agent-tools/coordination/condition-state');
  // The generic fold deliberately stops at CONDITIONS_FAST_PATH_ROW_CAP across
  // every condition family. Long-open one-shot conditions can age out of that
  // window while still being current, so prefer the indexed exact-key read when
  // it is available and use the bounded fold only for non-PG transports.
  const latest = await readLatestConditionEnvelope(input.conditionKey);
  if (latest) {
    const hasResolution =
      (typeof latest['resolves_condition'] === 'string' && latest['resolves_condition'].length > 0) ||
      (Array.isArray(latest['resolves_conditions']) &&
        latest['resolves_conditions'].some((key) => typeof key === 'string' && key.length > 0));
    if (hasResolution || latest['condition_key'] !== input.conditionKey) return false;
  } else {
    const open = computeConditionStates(await readConditionEnvelopes())
      .some((condition) => condition.condition_key === input.conditionKey && condition.open);
    if (!open) return false;
  }
  const { broadcastSevereEventResolved } = await import('./severe-event-broadcast');
  return broadcastSevereEventResolved({ ...input,
    ...(typeof latest?.['msg_id'] === 'string' ? { alarmMessageId: latest['msg_id'] } : {}),
  });
}

/** Resolve only after measured recovery or explicit supersession; unreadable scans never clear. */
export async function resolveAlarm(
  conditionKey: string,
  source: string,
  deps: AlarmAttentionDeps = {},
  resolutionSummary?: string,
): Promise<boolean> {
  try {
    return await (deps.resolve ?? defaultResolve)({
      conditionKey,
      summary: resolutionSummary?.trim() || source + ' recovered',
    });
  } catch (err) {
    console.warn(`[${source}] condition resolution failed (non-fatal): ${String(err)}`);
    return false;
  }
}

/**
 * Attempt one attention escalation.
 *
 * Returns true only when the delivery function resolved and false when the
 * durable cooldown suppressed the attempt or the best-effort rail failed.
 * Callers should continue returning their detector result in either case.
 */
export async function escalateAlarm(
  request: AlarmAttentionRequest,
  deps: AlarmAttentionDeps = {},
): Promise<boolean> {
  return defaultNotify(request, deps);
}

async function defaultNotify(request: AlarmAttentionRequest, deps: AlarmAttentionDeps): Promise<boolean> {
  const recentlyEscalated =
    deps.recentlyEscalated ?? (() => defaultRecentlyEscalated(request.title, request.cooldownMs));

  // The owning work-item must remain visible even while owner notifications are cooling down.
  // Failures in either delivery leg cannot suppress an attempt on the other leg.
  if (request.conditionKey) {
    try {
      const event: SevereEventBroadcast = {
        conditionKey: request.conditionKey, summary: request.title, body: request.body,
        ...(request.oneShot ? { oneShot: true } : {}),
        ...(request.data ? { data: request.data } : {}),
      };
      if (deps.broadcast) await deps.broadcast(event);
      else {
        const { broadcastSevereEvent } = await import('./severe-event-broadcast');
        await broadcastSevereEvent(event);
      }
    } catch (err) {
      console.warn(`[${request.source}] condition broadcast failed (non-fatal): ${String(err)}`);
    }
  }

  try {
    if (await recentlyEscalated()) return false;
    // ONE input for both legs, so an injected seam observes exactly what production delivers.
    const input: AttentionNotifyInput = {
      kind: 'intervention',
      title: request.title,
      body: request.body,
      importance: 'urgent',
      data: request.conditionKey ? { ...request.data, conditionKey: request.conditionKey } : request.data,
    };
    if (deps.notify) await deps.notify(input);
    else {
      const { notifyAttention } = await import('./attention-notify');
      await notifyAttention(input);
    }
    return true;
  } catch (err) {
    console.warn(
      `[${request.source}] escalation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

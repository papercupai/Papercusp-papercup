/**
 * In-process fan-out of PLUGIN-fired events to live subscribers (WI-39801).
 *
 * Plugin events reach reaction rules through `emitSystemEvent` (events/engine.ts),
 * which has no subscribe surface. Iframe plugin surfaces also need those events,
 * over the SSE stream GET /api/plugins/host/events. That stream used to bridge the
 * retired HookBus; this module is its replacement.
 *
 * Only events a plugin fires travel here. `emitSystemEvent` also carries internal
 * fire-points (pipeline step transitions, work-item lifecycle), and the SSE route is
 * `auth: 'public'`, so a fan-out over every system event would expose them. Every
 * plugin emit site calls `emitPluginEvent`, which feeds the reaction matcher and this
 * fan-out together.
 *
 * Delivery is same-process: a subscriber sees events fired in the process that holds
 * its SSE connection (the operator host), exactly as the HookBus did.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import { emitSystemEvent } from './engine';

export interface PluginEventDelivery {
  /** The event key, e.g. `myplugin.cache-warm`. */
  name: string;
  /** The install the event was fired in; null means not install-scoped (reaches every install). */
  installSlug: string | null;
  payload: Record<string, unknown>;
}

export interface PluginEventFilter {
  name: string;
  installSlug: string;
}

type Listener = (delivery: PluginEventDelivery) => void;

const state = pinModuleState('@papercusp/operator-core.pluginEventFanout', () => ({
  listeners: new Set<Listener>(),
}));

/** True when `delivery` is addressed to a subscriber with `filter`. */
export function pluginEventMatches(filter: PluginEventFilter, delivery: PluginEventDelivery): boolean {
  if (delivery.name !== filter.name) return false;
  return delivery.installSlug === null || delivery.installSlug === filter.installSlug;
}

/**
 * Subscribe to plugin events matching `filter`. Returns the unsubscribe function.
 * A throwing `onEvent` is isolated: it never reaches the emitter or other subscribers.
 */
export function subscribePluginEvents(
  filter: PluginEventFilter,
  onEvent: (payload: Record<string, unknown>) => void,
): () => void {
  const listener: Listener = (delivery) => {
    if (!pluginEventMatches(filter, delivery)) return;
    onEvent(delivery.payload);
  };
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

/** Deliver one plugin event to every matching subscriber. Never throws. */
export function publishPluginEvent(delivery: PluginEventDelivery): void {
  for (const listener of [...state.listeners]) {
    try {
      listener(delivery);
    } catch (err) {
      console.warn(`[plugin-event-fanout] subscriber failed for ${delivery.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Live subscriber count, for diagnostics and tests. */
export function pluginEventSubscriberCount(): number {
  return state.listeners.size;
}

/** Normalize a raw plugin payload into the object shape reaction rules match on. */
export function pluginEventPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload as Record<string, unknown>;
  return payload === undefined ? {} : { value: payload };
}

/**
 * The single emit point for a plugin-fired event: feeds the reaction matcher
 * (`emitSystemEvent`) and the iframe fan-out. Never throws.
 */
export function emitPluginEvent(opts: { name: string; payload?: unknown; installSlug?: string | null }): void {
  const payload = pluginEventPayload(opts.payload);
  const installSlug = opts.installSlug ?? null;
  emitSystemEvent({ tool: opts.name, args: payload, ...(installSlug ? { harnessSlug: installSlug } : {}) });
  publishPluginEvent({ name: opts.name, installSlug, payload });
}

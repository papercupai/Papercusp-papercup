/**
 * Event-driven urgent wake (plan curator-operator-2026-06-04, P2).
 *
 * The cadence handles routine curation; this handles URGENT news (escalations /
 * blockers / human handoffs) with low latency. It rides the LANDED `coord_inbox`
 * bus (`coord-inbox-bus.ts`, migration 126) — `onCoordInbox` already fires only
 * on human-relevant rows (any escalation, or a message/handoff addressed to
 * 'human'), which is exactly the always-surface, urgent set. A coalescing
 * debounce collapses a burst into one tick. The tick runs urgent-only
 * (`canEmitDigest:false`) so routine batching stays on the calm cadence.
 *
 * The event-reaction-system (declarative "on coord:escalate → fire X") is
 * plan-only / not yet landed; when it ships, this wake can be expressed as a
 * rule (`on:'coord:escalate', fire:'curation:tick'`) over the same bus. Until
 * then this direct subscription is the real low-latency signal.
 */
import { onCoordInbox } from '../coord-inbox-bus';
import { runWithWorkspace } from '../workspace-als';
import { orchestratorWorkspaceIds } from '../dbos/orchestrator-loop';
import { runCurationTick } from './curation-loop';
import { buildCurationDeps } from './deps';
import { writeCurationState } from './curation-state';
import { BASE_INTERVAL_SECONDS } from './curation-loop';

/** Collapse a burst of coord rows into one urgent tick. */
export const URGENT_DEBOUNCE_MS = Number(process.env.PAPERCUSP_CURATION_WAKE_DEBOUNCE_MS ?? 1_500);

/**
 * A leading-edge debounce with one async runner in flight. Extra triggers
 * coalesce into one follow-up after both the runner and its debounce window
 * finish. Every fire starts a fresh window, including a trailing fire, so the
 * runner's own notifications cannot create a rapid feedback loop.
 */
export function makeDebouncedRunner(
  runner: () => void | Promise<void>,
  debounceMs: number = URGENT_DEBOUNCE_MS,
): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  const warn = (err: unknown): void => {
     
    console.warn('[curation] urgent wake runner failed:', err instanceof Error ? err.message : err);
  };
  const fire = (): void => {
    // Arm before invoking user code: synchronous notifications must coalesce too.
    timer = setTimeout(() => {
      timer = null;
      firePending();
    }, debounceMs);
    running = true;
    // Call synchronously (leading-edge), but swallow BOTH a sync throw and an
    // async rejection so a bad runner can't crash the coord-inbox handler.
    try {
      const r = runner();
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        void Promise.resolve(r).catch(warn).finally(() => {
          running = false;
          firePending();
        });
      } else {
        running = false;
      }
    } catch (err) {
      running = false;
      warn(err);
    }
  };
  const firePending = (): void => {
    if (!pending || timer || running) return;
    pending = false;
    fire();
  };
  return {
    trigger(): void {
      if (timer || running) {
        pending = true;
        return;
      }
      fire();
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}

/** Run one urgent-only curation tick across every orchestrated workspace. */
export async function runUrgentCurationTick(): Promise<void> {
  for (const ws of orchestratorWorkspaceIds()) {
    await runWithWorkspace(ws, async () => {
      const deps = buildCurationDeps();
      const result = await runCurationTick(deps, { canEmitDigest: false });
      // A surface ⇒ busy ⇒ reset the adaptive cadence to its floor.
      await writeCurationState({
        lastRunAtMs: Date.now(),
        lastSurfacedCount: result.surfacedCount,
        ...(result.surfacedCount > 0 ? { currentIntervalSeconds: BASE_INTERVAL_SECONDS, consecutiveQuiet: 0 } : {}),
      });
    });
  }
}

let active: { cancel: () => void; unsub: () => void } | null = null;
let starting = false;

/**
 * Wire the urgent wake. Idempotent. `opts.runTick` overrides the default
 * (tests). Returns an unsubscribe that also cancels any pending debounce.
 *
 * Guard against concurrent calls that could create multiple listeners: if
 * already starting or active, returns immediately without creating a new
 * listener. This prevents a memory leak where multiple listeners would accumulate
 * if startCurationUrgentWake was called multiple times rapidly.
 */
export function startCurationUrgentWake(opts: { runTick?: () => void | Promise<void>; debounceMs?: number } = {}): () => void {
  if (active || starting) return () => stopCurationUrgentWake();
  starting = true;
  try {
    const runner = opts.runTick ?? runUrgentCurationTick;
    const { trigger, cancel } = makeDebouncedRunner(runner, opts.debounceMs ?? URGENT_DEBOUNCE_MS);
    const unsub = onCoordInbox(() => trigger());
    active = { cancel, unsub };
     
    console.log('[curation] urgent wake armed (coord_inbox → urgent tick)');
  } finally {
    starting = false;
  }
  return () => stopCurationUrgentWake();
}

export function stopCurationUrgentWake(): void {
  if (!active) return;
  active.unsub();
  active.cancel();
  active = null;
}

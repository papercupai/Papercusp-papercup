/**
 * `system:gate-watcher-tick` — the cadence wrapper for the client-agnostic
 * session-gate transcript watcher (owner-inbox-single-pane-2026-07-17 P-002;
 * design + idempotency model in `gate-watch.ts`).
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run:
 * every file delta is fenced by its own byte watermark (session_gate_watcher_files).
 *
 * Config (routine `trigger_config`, all optional):
 *   - `roots`     — transcript roots (JSON array, or comma-separated string).
 *                   Default: the psu root AND the native `~/.claude/projects`
 *                   — see `defaultGateWatchRoots`, WI-10002079/R1.
 *   - `root`      — single-root override, kept for back-compat; when set it
 *                   REPLACES the defaults.
 *   - `max_files` — per-tick file BUDGET (default 5000). Files already at
 *                   their watermark do not consume it; a tick that hits it
 *                   resumes from the same place next tick.
 *   - `cold_start_open_window_ms` — a FIRST-SEEN transcript last written
 *                   longer ago than this is replayed for closes only, never
 *                   minting a gate from dead history (default 24h; R3).
 */
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { tickGateWatch } from './gate-watch';
import { sweepSessionIndependentGates } from './gate-reaper';
import { backfillUnprovableWaitRecheckDates, sweepWorkItemBlockerDefaults } from './work-item-blocker-reaper';
import { backfillUnprovableParkRecheckDates, sweepDueParkRechecks } from './durable-park-recheck';
import { sweepOmittedReviews } from './review-stall-reaper';
import { sweepOwnerDirectiveRecovery } from '../owner-directive-recovery';
import { pinModuleState } from '@papercusp/module-singleton';

/** Default gap between full unprovable-wait backfill passes (WI-6554700010029948). */
export const UNPROVABLE_WAIT_BACKFILL_EVERY_MS = 10 * 60_000;
const unprovableBackfill = pinModuleState('@papercusp/operator-core.unprovableWaitBackfillThrottle', () => ({
  lastCompletedAt: 0,
  /** WI-6554700010030346: where the paged durable-park backfill resumes (null = from the start). */
  parkAfterId: null as string | null,
}));

export function resetUnprovableWaitBackfillThrottleForTest(): void {
  unprovableBackfill.lastCompletedAt = 0;
  unprovableBackfill.parkAfterId = null;
}

registerSystemAction('gate-watcher-tick', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  // Run before transcript IO: a broken/missing transcript cannot strand the
  // requests of a session that has already ended. No new routine or worker.
  try {
    const recovered = await sweepOwnerDirectiveRecovery({ workspaceId: ctx.workspaceId, harness: ctx.installSlug });
    if (recovered.created || recovered.retained || recovered.errors.length) {
      console.log(`[owner-directive-recovery] ${JSON.stringify(recovered)}`);
    }
  } catch (error) {
    console.warn(`[owner-directive-recovery] ${error instanceof Error ? error.message : String(error)}`);
  }
  const maxFiles = Number(cfg.max_files);
  const result = await tickGateWatch({
    roots: readRoots(cfg.roots),
    root: typeof cfg.root === 'string' && cfg.root.length > 0 ? cfg.root : undefined,
    maxFilesPerTick: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined,
    coldStartOpenWindowMs: readPositiveMs(cfg.cold_start_open_window_ms),
  });
  console.log(
    `[gate-watch] scanned ${result.scannedFiles} transcript(s) under ${result.roots.length} root(s) → ` +
      `${result.opened} opened, ${result.alreadyOpen} already-open, ${result.closed} closed` +
      (result.coldStartSkippedOpens
        ? `, ${result.coldStartSkippedOpens} cold-start open(s) suppressed`
        : '') +
      (result.budgetExhausted ? ', BUDGET EXHAUSTED — more remain for next tick' : '') +
      (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
  );
  for (const e of result.errors.slice(0, 5)) console.warn(`[gate-watch]   ! ${e.file}: ${e.error}`);
  try {
    const reviews = await sweepOmittedReviews();
    if (reviews.examined || reviews.released || reviews.errors.length) console.log(`[omitted-review] ${JSON.stringify(reviews)}`);
  } catch (error) {
    console.warn(`[omitted-review] ${error instanceof Error ? error.message : String(error)}`);
  }

  // WI-10002067: the SESSION-INDEPENDENT half. The watcher above can only ever
  // close a gate whose asking session is alive to be observed, which is why 241
  // gates had accumulated with no code path able to discharge them. This runs
  // inside the existing handler deliberately — the brief forbids a new routine,
  // and the repo's scheduling rule bans adding a third mechanism.
  //
  // Isolated in its own try/catch because it is ADDITIVE: it requires migration
  // 1185's columns, so on a host where that has not been applied yet it must
  // degrade to a logged warning rather than take the transcript watcher — which
  // predates it and is independently useful — down with it.
  try {
    const swept = await sweepSessionIndependentGates({
      unknownGoneAfterMs: readPositiveMs(cfg.unknown_gone_after_ms),
      limit: readPositiveMs(cfg.sweep_limit),
    });
    console.log(
      `[gate-reaper] examined ${swept.examined} open gate(s) → ${swept.closedAskerGone} asker_gone, ` +
        `${swept.closedDefaultApplied} default_applied; skipped ` +
        `${swept.skipped['asker-live']} live / ${swept.skipped['asker-unknown-within-grace']} within-grace` +
        (swept.truncatedByLimit ? ' — TRUNCATED BY LIMIT, more remain' : ''),
    );
  } catch (err) {
    console.warn(`[gate-reaper]   ! sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // WI-6554700010029948: the unprovable-wait backfill as a RECURRING leg, not a one-shot.
  // Admission refuses an unprovable wait at write (wait-ref-admission.ts), but only on a build
  // that carries it. An older deployed build, or a path that writes externalBlockers without
  // set_blocker, can still create one. EI-27144615875235926: :3070 on d740fc3802 wrote a broad
  // coord:inbox-wake wait after the one-shot backfill, which failed the R-12 live oracle.
  // It runs BEFORE the sweep below, so a row stamped `recheckAt: now` is escalated to its holder
  // on this same tick instead of staying silent. A full pass re-classifies every provable
  // wait (94 items took 33s on 2026-10-27), so it is throttled, not run on every tick. A failed
  // pass does not advance the throttle, so the next tick retries it.
  const backfillEveryMs = readPositiveMs(cfg.unprovable_wait_backfill_every_ms) ?? UNPROVABLE_WAIT_BACKFILL_EVERY_MS;
  if (Date.now() - unprovableBackfill.lastCompletedAt >= backfillEveryMs) {
    try {
      const b = await backfillUnprovableWaitRecheckDates({ limit: readPositiveMs(cfg.unprovable_wait_backfill_limit) });
      unprovableBackfill.lastCompletedAt = Date.now();
      if (b.stamped > 0 || b.truncatedByLimit || Object.keys(b.skipped).length > 0) {
        console.log(
          `[unprovable-wait-backfill] ${b.items} item(s), ${b.examined} wait(s) → ${b.stamped} stamped ` +
            `${JSON.stringify(b.byReason)}, ${b.provable} provable; skipped ${JSON.stringify(b.skipped)}` +
            (b.truncatedByLimit ? ' — TRUNCATED BY LIMIT, more remain' : ''),
        );
      }
    } catch (err) {
      console.warn(`[unprovable-wait-backfill]   ! pass skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    // WI-6554700010030346 (blind review #110 G-5): durable parks store their wait in
    // claim_hold_release.trigger, which the leg above never reads, so unprovable parks made
    // before P-006 had no re-check at all. Same throttle, its own isolation. Provable parks
    // stay candidates, so each pass reads one page and resumes after it on the next pass.
    try {
      const p = await backfillUnprovableParkRecheckDates({
        limit: readPositiveMs(cfg.unprovable_park_backfill_limit),
        afterId: unprovableBackfill.parkAfterId ?? null,
      });
      unprovableBackfill.parkAfterId = p.nextAfterId;
      if (p.stamped > 0 || Object.keys(p.skipped).length > 0) {
        console.log(
          `[unprovable-park-backfill] ${p.parks} park(s) → ${p.stamped} stamped ${JSON.stringify(p.byReason)}, ` +
            `${p.provable} provable; skipped ${JSON.stringify(p.skipped)}` +
            (p.truncatedByLimit ? ` — paged, resumes after ${p.nextAfterId}` : ''),
        );
      }
    } catch (err) {
      console.warn(`[unprovable-park-backfill]   ! pass skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // WI-10005010: the WORK-ITEM sibling of the session-gate reaper — applies the TYPED
  // `defaultAction` of an owner ask whose `decideBy` has passed. Same isolation rule as
  // above: additive, so a failure here is a logged warning, never a reason to take the
  // transcript watcher or the session-gate reaper down with it.
  try {
    const reaped = await sweepWorkItemBlockerDefaults({ limit: readPositiveMs(cfg.blocker_sweep_limit) });
    if (reaped.examined > 0 || Object.keys(reaped.skipped).length > 0) {
      console.log(
        `[blocker-default-reaper] examined ${reaped.examined} item(s) → ${reaped.applied.stay_parked} stay_parked, ` +
          `${reaped.applied.release_to_agents} release_to_agents; skipped ${JSON.stringify(reaped.skipped)}` +
          `; re-checks ${reaped.rechecked.cleared} cleared / ${reaped.rechecked.escalated} escalated` +
          (reaped.truncatedByLimit ? ' — TRUNCATED BY LIMIT, more remain' : ''),
      );
    }
    // event-wait-settlement-2026-10-20 P-005: the recovery and stranded-repair passes.
    const { recovered, repaired } = reaped;
    if (recovered.keys > 0 || recovered.failed > 0 || repaired.reopened > 0 || 'failed' in repaired.skipped) {
      console.log(
        `[blocker-recheck] missed fires: ${recovered.keys} key(s) → ${recovered.settled} wait(s) settled, ` +
          `${recovered.failed} failed${recovered.truncatedByLimit ? ' (TRUNCATED BY LIMIT)' : ''}; ` +
          `stranded blocked: ${repaired.examined} examined → ${repaired.reopened} reopened, ` +
          `skipped ${JSON.stringify(repaired.skipped)}${repaired.truncatedByLimit ? ' (TRUNCATED BY LIMIT)' : ''}`,
      );
    }
  } catch (err) {
    console.warn(`[blocker-default-reaper]   ! sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // WI-6554700010030346: escalate durable parks whose re-check date passed, then re-arm it.
  try {
    const parks = await sweepDueParkRechecks({ limit: readPositiveMs(cfg.park_recheck_sweep_limit) });
    if (parks.examined > 0 || Object.keys(parks.skipped).length > 0) {
      console.log(
        `[park-recheck] ${parks.examined} due park(s) → ${parks.escalated} escalated, ${parks.provable} now provable; ` +
          `skipped ${JSON.stringify(parks.skipped)}${parks.truncatedByLimit ? ' — TRUNCATED BY LIMIT, more remain' : ''}`,
      );
    }
  } catch (err) {
    console.warn(`[park-recheck]   ! sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** `undefined` for anything not a usable positive number, so the callee's own
 *  default applies rather than a NaN silently disabling a bound. */
function readPositiveMs(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Transcript roots from `trigger_config`: a JSON array, or a comma-separated
 *  string for hand-edited config. `undefined` (never `[]`) when nothing usable
 *  is configured, so `tickGateWatch` falls back to its own defaults rather
 *  than being handed an empty list that would silently scan nothing. */
function readRoots(raw: unknown): string[] | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const roots = parts.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
  return roots.length ? roots : undefined;
}

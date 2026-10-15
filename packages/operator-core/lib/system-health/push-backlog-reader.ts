/**
 * Bounded, cached reader for the live git-sync push backlog (WI-10006803).
 *
 * `collectDeploy` consults the live backlog only while a git-sync install reports
 * consecutive push errors (it zeroes a sticky error count when nothing is actually
 * unpushed). The probe behind it (`liveGitSyncPushBacklog` in compute.ts) fetches and
 * counts ahead-commits on the repo root and on every submodule, one after another: on the
 * papercusp tree that is ~117 git spawns and ~31s of network per call (measured
 * 2026-10-06: root fetch 1.2s + 38 submodule fetches 29.7s). Awaiting it inside every
 * system-health tick made the `deploy` leg 39-75s on 9 of 9 ticks, and those spawns are
 * the main-thread stall WI-7160 profiled.
 *
 * This reader puts the probe behind `@papercusp/cache`'s `getOrSetBounded`:
 *  - cold miss: the caller waits at most `deadlineMs`, then gets `null` (unknown — the same
 *    answer a failed probe already gives) while the single-flight build keeps running and
 *    lands in cache for the next tick;
 *  - within `softTtlMs`: the cached value, no git work at all;
 *  - past `softTtlMs`: the stale value immediately, plus ONE background refresh;
 *  - past `hardTtlMs`: treated as a cold miss again (still bounded by `deadlineMs`), so an
 *    arbitrarily old backlog is never served.
 * `null` results are cached too, so a failing probe is not re-run on every tick.
 */
import { createCache, getOrSetBounded, type Cache } from '@papercusp/cache';

/** Serve a cached backlog this long before refreshing it in the background. */
export const PUSH_BACKLOG_SOFT_TTL_MS = 5 * 60_000;
/** Never serve a backlog older than this; past it, re-probe (bounded by the deadline). */
export const PUSH_BACKLOG_HARD_TTL_MS = 30 * 60_000;
/** The longest a health tick waits on a cold probe before answering "unknown". */
export const PUSH_BACKLOG_DEADLINE_MS = 2_000;

export type PushBacklogProbe = (slug: string) => Promise<number | null>;
export type PushBacklogReader = (slug: string) => Promise<number | null>;

export interface PushBacklogReaderOptions {
  /** The expensive live probe (git fetch + ahead count across the root and submodules). */
  probe: PushBacklogProbe;
  /** Cache seam (tests inject one with a controllable clock). */
  cache?: Cache;
  softTtlMs?: number;
  hardTtlMs?: number;
  deadlineMs?: number;
}

export function createPushBacklogReader(opts: PushBacklogReaderOptions): PushBacklogReader {
  const cache = opts.cache ?? createCache();
  const softTtlMs = opts.softTtlMs ?? PUSH_BACKLOG_SOFT_TTL_MS;
  const hardTtlMs = opts.hardTtlMs ?? PUSH_BACKLOG_HARD_TTL_MS;
  const deadlineMs = opts.deadlineMs ?? PUSH_BACKLOG_DEADLINE_MS;
  return async (slug) => {
    const r = await getOrSetBounded(cache, 'host-local', `git-sync-push-backlog:${slug}`, () => opts.probe(slug), {
      softTtlMs,
      hardTtlMs,
      deadlineMs,
      cacheEmpty: true,
    });
    return r.ok ? r.value : null;
  };
}

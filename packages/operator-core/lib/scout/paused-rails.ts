/**
 * Which routed-idea rails are PAUSED right now (plan scout-su-ideate-pipeline-gaps-2026-10-08
 * P-002, BARs R-2 / R-3).
 *
 * A paused rail cannot decide anything: an idea routed into it never reaches a terminal
 * verdict, so it must not sit 'pending' (which reads as "still deciding") and must not
 * count in a win-rate denominator. This module is the ONE answer to "is this rail live?",
 * shared by the router's routing gate (cycle-deps.ts), the outcome classifier
 * (classifyIdeaOutcome → 'unresolvable') and the success-metrics outcome tally.
 *
 * The gym rail is live only when BOTH halves of the gym are on for at least one harness:
 *   - its autoloop config is enabled (`harness_shared.gym_autoloop_config.enabled`), AND
 *   - its `gym-cycle` routine is active (`harness_shared.routines`, install_slug = harness).
 *
 * Before this, the router read only the autoloop flag. The owner's 2026-10-08 pause
 * (directive #1558) deactivated the `gym-cycle@papercusp` routine and left the autoloop
 * flag `true`, so the router still treated the gym as live.
 */
import type { getOrgPg } from '@papercusp/db-org';
import type { RoutedRail } from './outcome-feedback';
import { observeFallback } from '../degradation/fallback-observations';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/** The routine whose activity is the gym's heartbeat (one per harness, install_slug = harness slug). */
export const GYM_CYCLE_ROUTINE_NAME = 'gym-cycle';

/** The facts the gym-rail liveness decision is computed from. */
export interface RailLivenessFacts {
  /** Gym autoloop configs in the workspace, one per harness. */
  autoloops: ReadonlyArray<{ harnessSlug: string; enabled: boolean }>;
  /** `gym-cycle` routines in the workspace, keyed by install slug (= harness slug). */
  gymCycleRoutines: ReadonlyArray<{ installSlug: string; active: boolean }>;
}

/**
 * Pure core: the set of paused rails given the liveness facts. The gym rail is paused
 * unless some harness has an enabled autoloop AND an active gym-cycle routine.
 */
export function pausedRailsFrom(facts: RailLivenessFacts): ReadonlySet<RoutedRail> {
  const activeCycles = new Set(facts.gymCycleRoutines.filter((r) => r.active).map((r) => r.installSlug));
  const gymLive = facts.autoloops.some((l) => l.enabled && activeCycles.has(l.harnessSlug));
  return new Set<RoutedRail>(gymLive ? [] : ['gym']);
}

/** True when `rail` is in the paused set. */
export function isRailPaused(paused: ReadonlySet<RoutedRail> | undefined, rail: RoutedRail): boolean {
  return paused?.has(rail) === true;
}

/**
 * Read the paused-rail set for one workspace.
 *
 * Fail-OPEN (returns an empty set, i.e. nothing paused) when the read fails, matching the
 * router's historical gym-liveness read: a broken liveness probe must not silently divert
 * routing or reclassify outcomes. The failure is logged so it is visible.
 */
export async function readPausedRails(sql: OrgSql, workspaceId: string): Promise<ReadonlySet<RoutedRail>> {
  try {
    const [autoloops, routines] = await Promise.all([
      sql<Array<{ harness_slug: string; enabled: boolean | null }>>`
        SELECT harness_slug, enabled
          FROM harness_shared.gym_autoloop_config
         WHERE workspace_id = ${workspaceId}`,
      sql<Array<{ install_slug: string; active: boolean | null }>>`
        SELECT install_slug, active
          FROM harness_shared.routines
         WHERE workspace_id = ${workspaceId}
           AND name = ${GYM_CYCLE_ROUTINE_NAME}`,
    ]);
    const paused = pausedRailsFrom({
      autoloops: autoloops.map((r) => ({ harnessSlug: r.harness_slug, enabled: r.enabled === true })),
      gymCycleRoutines: routines.map((r) => ({ installSlug: r.install_slug, active: r.active === true })),
    });
    observeFallback('scout-state-read', { eligible: 1, applied: 1, reason: 'applied', scope: 'rail-liveness' }, { workspaceId });
    return paused;
  } catch (err) {
    observeFallback('scout-state-read', { eligible: 1, applied: 0, reason: 'rail-liveness-read-failed', scope: 'rail-liveness' }, { workspaceId });
    console.warn(
      '[scout/paused-rails] rail-liveness read failed — treating every rail as live (fail-open):',
      err instanceof Error ? err.message : err,
    );
    return new Set<RoutedRail>();
  }
}

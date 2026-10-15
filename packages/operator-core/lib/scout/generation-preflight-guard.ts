/**
 * generation-preflight-guard.ts — skip PAID Scout generation when its output is
 * already known to be wasted (WI-10007380; plan scout-su-ideate-pipeline-gaps-2026-10-08
 * P-003, BARs R-4 / R-5 / R-6).
 *
 * THE MEASUREMENT (2026-10-08): over 7 days the Scout generated 458 ideas, the
 * dedup gate removed 397 (87%), and 2 were routed — $56.63 of ideation for ~7
 * routed ideas. Every recent tick also ran under a DEEP admission throttle
 * (pending > two promoter batches, claim-latency p95 ≈ 20 days). The existing
 * reactions only RE-SHAPE a cycle: the admission throttle caps `maxIdeators`, and
 * the dedup-burn guard (dedup-burn-guard.ts) widens the novelty band. Neither
 * stops the paid generation step, and the dedup gate runs AFTER it.
 *
 * THE GUARD (pure; run.ts consults it before the tick fans out):
 *   1. DEEP THROTTLE — the work queue cannot absorb new items (they would wait
 *      weeks to be claimed). Skip; the throttle is re-read every tick, so the
 *      Scout resumes as soon as the queue drains.
 *   2. DEDUP SATURATION PAST THE WIDENING BUDGET — the dedup-burn guard has
 *      already widened the novelty band as far as it goes and cycles are STILL
 *      saturated. Skip, but run a PROBE cycle after `probeEvery` consecutive
 *      dedup skips: a skipped (gated) tick says nothing about saturation, so
 *      without a probe the streak could never break and the skip would be
 *      permanent.
 * Every skip carries a reason and its evidence; run.ts records it on the tick
 * (status 'gated', gate {@link GENERATION_PREFLIGHT_GATE}) so a skipped cycle is
 * never silent (R-6). The curb under an ELEVATED throttle (fewer ideators) is
 * unchanged and already records `detail.admissionThrottle`.
 */
import type { WorkItemAdmissionProducerPressure } from '../work-items-admission-promoter';
import {
  assessDedupBurn,
  DEFAULT_DEDUP_BURN_OPTIONS,
  type DedupBurnOptions,
  type DedupBurnTick,
} from './dedup-burn-guard';
import type { ScoutTickRecord } from './tick-ledger';

/** The tick-ledger gate name a preflight skip is recorded under. */
export const GENERATION_PREFLIGHT_GATE = 'generation-preflight';

export type GenerationPreflightReason = 'admission-throttle-deep' | 'dedup-saturated';

/** Tick fields the guard reads (a {@link ScoutTickRecord} satisfies it). */
export type GenerationPreflightTick = DedupBurnTick & Pick<ScoutTickRecord, 'gate' | 'detail'>;

export interface GenerationPreflightOptions {
  /** Options passed through to the dedup-burn assessment (same defaults). */
  dedupBurn?: DedupBurnOptions;
  /**
   * Consecutive saturated ran-cycles at which generation is skipped. Default:
   * the dedup-burn trigger plus its full widening budget, i.e. the band has been
   * widened as far as it goes for at least one cycle and the corpus is still
   * saturated.
   */
  skipStreak?: number;
  /** After this many consecutive dedup skips, let one probe cycle run (default 5). */
  probeEvery?: number;
}

export type GenerationPreflightVerdict =
  | { skip: false; probe: boolean; reason: string }
  | { skip: true; reason: GenerationPreflightReason; detail: Record<string, unknown> };

export const DEFAULT_PREFLIGHT_PROBE_EVERY = 5;

export function defaultSkipStreak(opts: DedupBurnOptions = {}): number {
  const consecutive = opts.consecutiveCycles ?? DEFAULT_DEDUP_BURN_OPTIONS.consecutiveCycles;
  const widening = opts.maxWideningSteps ?? DEFAULT_DEDUP_BURN_OPTIONS.maxWideningSteps;
  return consecutive + widening;
}

function isPreflightSkip(tick: GenerationPreflightTick, reason: GenerationPreflightReason): boolean {
  return tick.status === 'gated' && tick.gate === GENERATION_PREFLIGHT_GATE && tick.detail?.reason === reason;
}

/**
 * Consecutive dedup-preflight skips counted back from the newest tick. Throttle
 * skips in between are passed over (they say nothing about the corpus); any
 * other tick ends the run.
 */
export function leadingDedupSkips(ticksNewestFirst: readonly GenerationPreflightTick[]): number {
  let n = 0;
  for (const tick of ticksNewestFirst) {
    if (isPreflightSkip(tick, 'admission-throttle-deep')) continue;
    if (!isPreflightSkip(tick, 'dedup-saturated')) break;
    n += 1;
  }
  return n;
}

/** Ticks scanned for the preflight: covers the skip streak plus the probe window. */
const PREFLIGHT_TICK_SCAN_LIMIT = 60;

/**
 * Production tick reader for {@link ScoutCycleDeps.generationPreflightTicks}
 * (newest first, this install). Wired identically by both Scout entrypoints
 * (scout-cycle-action.ts and blueprint-steps/ops/scout-cycle.ts).
 */
export async function readGenerationPreflightTicks(scope: {
  workspaceId: string;
  installSlug: string;
}): Promise<readonly GenerationPreflightTick[]> {
  const { readScoutTicks } = await import('./tick-ledger');
  return readScoutTicks({
    workspaceId: scope.workspaceId,
    installSlug: scope.installSlug,
    limit: PREFLIGHT_TICK_SCAN_LIMIT,
  });
}

export function assessGenerationPreflight(input: {
  admissionPressure?: Pick<WorkItemAdmissionProducerPressure, 'level' | 'pending' | 'p95Ms' | 'reasons'> | null;
  recentTicksNewestFirst?: readonly GenerationPreflightTick[] | null;
  opts?: GenerationPreflightOptions;
}): GenerationPreflightVerdict {
  const pressure = input.admissionPressure;
  if (pressure?.level === 'deep') {
    return {
      skip: true,
      reason: 'admission-throttle-deep',
      detail: {
        reason: 'admission-throttle-deep',
        pending: pressure.pending,
        p95Ms: pressure.p95Ms,
        throttleReasons: pressure.reasons,
      },
    };
  }

  const ticks = input.recentTicksNewestFirst ?? [];
  if (ticks.length === 0) return { skip: false, probe: false, reason: 'no tick history' };
  const opts = input.opts ?? {};
  const skipStreak = opts.skipStreak ?? defaultSkipStreak(opts.dedupBurn);
  const probeEvery = opts.probeEvery ?? DEFAULT_PREFLIGHT_PROBE_EVERY;
  const burn = assessDedupBurn(ticks, opts.dedupBurn);
  if (!burn.saturated || burn.consecutiveSaturated < skipStreak) {
    return { skip: false, probe: false, reason: burn.reason };
  }
  const skipped = leadingDedupSkips(ticks);
  if (skipped >= probeEvery) {
    return {
      skip: false,
      probe: true,
      reason: `probe after ${skipped} dedup skip(s): ${burn.consecutiveSaturated} saturated cycle(s), last ratio ${burn.lastRatio}`,
    };
  }
  return {
    skip: true,
    reason: 'dedup-saturated',
    detail: {
      reason: 'dedup-saturated',
      consecutiveSaturated: burn.consecutiveSaturated,
      lastRatio: burn.lastRatio,
      skipStreak,
      probeIn: probeEvery - skipped,
    },
  };
}

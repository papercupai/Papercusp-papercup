/** Provider-declared budgets feed host-owned trigger admission. Reuses the existing
 * quota math; durable batching executes in binding-engine, never in a second coalescer. */
import type { ProviderDescriptor, ProviderQuotaBucket, ProviderRateBudget } from '@papercusp/plugin-sdk';
import type { ProviderRegistry } from '../integrations/provider-registry';

export type ProviderQuotaVerb = string;

/**
 * The coalescing window. Longer than the binding engine's 60s default because
 * the unit being coalesced is a conversation's worth of comments, not a
 * retry burst — five minutes is long enough that a viral thread produces one
 * batched run rather than five, and short enough that a reply still feels
 * responsive.
 */
export const PROVIDER_STORM_WINDOW_SECONDS = 300;

/**
 * Requests one launched run is assumed to spend against the platform (fetch
 * the thread's context, compose, post). Deliberately pessimistic: the cap
 * exists to keep runs from exhausting the very budget each run needs, so
 * over-estimating costs a smaller cap while under-estimating costs a
 * rate-limit wall mid-conversation.
 */
export const ASSUMED_REQUESTS_PER_RUN = 10;

/** Cap used when the registry states no numeric budget. */
export const FALLBACK_MAX_RUNS = 12;

/** Nothing derives above this, however generous the platform's budget. */
export const MAX_RUNS_CEILING = 60;

/**
 * How the cap was arrived at. Carried on the policy so a fallback cap is
 * visible rather than passing for a measured one.
 */
export type ProviderStormCapBasis =
  | {
      kind: 'rate-budget';
      /** The registry figure the cap was derived from. */
      requestsPerMinute: number;
      requestsPerRun: number;
    }
  | {
      kind: 'quota-bucket';
      /** WHICH non-fungible bucket this cap was derived from (D-020). */
      bucket: string;
      /** The verb the bucket was selected for. */
      verb: ProviderQuotaVerb;
      perDay: number;
      unit: 'calls' | 'units';
      /** What one run is assumed to spend against that bucket, in its unit. */
      spendPerRun: number;
      /**
       * True when the bucket could not be selected from a declaration and the
       * TIGHTEST bucket was taken instead. A cap derived this way is safe but
       * may be far stricter than the platform requires, and saying so is the
       * difference between a deliberate throttle and an unexplained one.
       */
      fallbackToTightest?: boolean;
      /**
       * True when the daily budget could not fund even ONE run inside the
       * standard window, so the WINDOW was widened instead of the cap being
       * floored to 1. Without this the policy would silently overspend — see
       * `providerStormPolicyFor`.
       */
      windowWidened?: boolean;
    }
  | {
      kind: 'dynamic-quota';
      /** The vendor formula the allowance actually follows (D-028). */
      formula: string;
      /**
       * Response header that reports consumption, as percentages — or null when
       * the platform publishes NO usage signal (Threads, D-037).
       *
       * A null here is not cosmetic. It says `observedPeakUsagePct` can never
       * become non-null, so the cap below rests on `assumedDailyFloor` alone
       * permanently rather than until the first observation arrives.
       */
      usageHeader: string | null;
      /** The absolute anchor: the formula's smallest non-vacuous daily value. */
      assumedDailyFloor: number;
      /** Calls one run is assumed to spend against that allowance. */
      spendPerRun: number;
      /**
       * Peak utilisation percentage actually observed, or null when nothing has
       * been observed yet. A null is the load-bearing distinction: it means the
       * cap rests on the floor ALONE, not on a measurement of this account.
       */
      observedPeakUsagePct: number | null;
      /** Percentage of the allowance believed to remain (100 when unobserved). */
      headroomPct: number;
      /** The window was widened rather than the cap inflated — see below. */
      windowWidened?: boolean;
      /** No run may launch: the allowance is spent, or the provider said stop. */
      held?: boolean;
    }
  | {
      kind: 'conservative-default';
      /** Why no cap could be derived — surfaced, not swallowed. */
      why: string;
    };

/**
 * What a live call learned about the platform's remaining allowance.
 *
 * Deliberately platform-NEUTRAL: this module knows nothing about Graph headers
 * or error codes, and the vendor-specific translation lives beside the vendor's
 * parser (`facebookQuotaObservation`). A dynamic quota is not a Facebook
 * peculiarity — any platform whose allowance scales with usage produces the same
 * two facts, and both are things only a response can tell you.
 */
export interface ProviderQuotaObservation {
  /**
   * Peak percentage of the current allowance already consumed, 0–100+.
   * Null/undefined means NOT OBSERVED, which is treated as full headroom
   * against the floor — never as "fine, proceed" against an unknown budget.
   */
  peakUsagePct?: number | null;
  /** The provider has reported a throttle on this account right now. */
  throttled?: boolean;
  /**
   * Milliseconds the provider stated it will take to regain access, or null
   * when it stated none. NULL IS NOT ZERO and must never be defaulted to a
   * number: the platform this exists for documents that continuing to call
   * extends the block, so an invented duration is a retry loop wearing a
   * policy's clothes.
   */
  throttleHoldMs?: number | null;
}

export interface ProviderStormPolicy {
  /**
   * Always `coalesce-with-cap` for social. Named rather than implied so a
   * reader of a stored policy can tell it apart from the binding engine's
   * skip-the-overflow default.
   */
  mode: 'coalesce-with-cap';
  maxRuns: number;
  windowSeconds: number;
  basis: ProviderStormCapBasis;
  /**
   * Present when NOTHING may launch right now.
   *
   * WHY THIS IS NOT JUST `maxRuns: 0`. A zero cap and a hold produce the same
   * run count and mean opposite things to a reader: zero-as-cap says "this
   * source is rationed to nothing", a hold says "the provider has told us to
   * stop, and it expires". The executing binding engine must account for the
   * events differently because calling them
   * "coalesced" would claim they were folded into a run that never launched.
   */
  hold?: {
    /** Why launching is suspended, in terms a reader of a stored policy can act on. */
    reason: string;
    /**
     * The vendor states that retrying EXTENDS the block. A consumer seeing this
     * must schedule no retry at all; wrapping this in generic exponential
     * backoff deepens every throttle it touches, and presents as the platform
     * being flaky rather than as our own retry loop being the cause.
     */
    retryForbidden: boolean;
    /**
     * Milliseconds to park, or null when the provider stated no duration.
     * A null must be surfaced, never replaced with a default — inventing one
     * reintroduces exactly the retry `retryForbidden` exists to prevent.
     */
    untilMs: number | null;
  };
}

const SECONDS_PER_DAY = 86_400;

/**
 * The verified unit cost of the most expensive social write measured so far —
 * YouTube's `comments.insert`, "a quota cost of 50 units".
 *
 * Used as the write component of a run's spend against a UNITS bucket. It is
 * deliberately platform-neutral and pessimistic, for the same reason
 * `ASSUMED_REQUESTS_PER_RUN` is: a platform with a cheaper write only ends up
 * with a smaller cap than it could have had, whereas under-estimating spends a
 * budget that, once gone, stops the integration for the rest of the quota day.
 */
export const ASSUMED_WRITE_UNITS = 50;

/**
 * What one launched run is assumed to spend against a bucket, in that bucket's
 * own unit.
 *
 * `calls`: 1. A call-capped bucket caps the ONE expensive operation a run
 * performs (an upload, a search); the cheap surrounding calls are not drawn
 * from it — that non-fungibility is the entire point of D-020.
 *
 * `units`: the run's list calls (`ASSUMED_REQUESTS_PER_RUN`, 1 unit each) plus
 * one write when the verb writes. Every term traces to a figure the registry or
 * a vendor page states, rather than being a new magic number.
 */
export function assumedSpendPerRun(bucket: ProviderQuotaBucket, verb: ProviderQuotaVerb): number {
  if (bucket.unit === 'calls') return 1;
  return ASSUMED_REQUESTS_PER_RUN + (verb === 'read' ? 0 : ASSUMED_WRITE_UNITS);
}

/**
 * Pick the bucket a verb draws on.
 *
 * Matches only on the DECLARED `verbs` list. When nothing declares the verb,
 * the TIGHTEST bucket wins — the conservative direction on purpose: a cap that
 * is too small throttles the integration, while one that is too large exhausts a
 * daily budget and stops it outright until the quota day rolls over. The caller
 * is told which happened via `fallbackToTightest`.
 */
export function selectQuotaBucket(
  buckets: Record<string, ProviderQuotaBucket>,
  verb: ProviderQuotaVerb,
): { name: string; bucket: ProviderQuotaBucket; fallbackToTightest: boolean } | null {
  const entries = Object.entries(buckets).filter(([, b]) => Number.isFinite(b.perDay) && b.perDay > 0);
  if (entries.length === 0) return null;

  const declared = entries.filter(([, b]) => b.verbs?.includes(verb));
  if (declared.length > 0) {
    // More than one declaring bucket is still resolvable, and the tightest is
    // the only safe reading: a verb genuinely drawing on two budgets is bounded
    // by whichever runs out first.
    const [name, bucket] = declared.reduce((a, b) => (b[1].perDay < a[1].perDay ? b : a));
    return { name, bucket, fallbackToTightest: false };
  }

  const [name, bucket] = entries.reduce((a, b) => (b[1].perDay < a[1].perDay ? b : a));
  return { name, bucket, fallbackToTightest: true };
}

/**
 * Derive a cap for a platform whose allowance is NOT A CONSTANT (D-028).
 *
 * THE FACT THAT SHAPES THIS WHOLE FUNCTION: the usage header reports
 * PERCENTAGES, so an observation says what fraction of the allowance remains
 * and never how big it is. There is consequently no observation, however fresh,
 * that yields an absolute budget — the floor from the vendor's formula is the
 * anchor in every case, and the observation only scales it down.
 *
 * TWO CONDITIONS THAT LOOK ALIKE AND ARE NOT:
 *
 *  - RATIONING — headroom is low but nonzero. The right answer is to keep
 *    working more slowly, so the WINDOW widens and the cap stays 1, exactly as
 *    the daily-bucket path does. Holding here would take an integration that
 *    can still act once an hour and stop it entirely.
 *  - THROTTLED — the provider has said stop, or the allowance is spent. Here
 *    the right answer is to launch nothing, because on this platform the calls
 *    a retry would make are themselves what extends the block. Widening a
 *    window would still authorise those calls, just later.
 *
 * Conflating them is the failure this split exists to prevent, and it is easy
 * to conflate because both present as "we are near the limit".
 */
function dynamicQuotaPolicy(
  dq: NonNullable<ProviderRateBudget['dynamicQuota']>,
  observation: ProviderQuotaObservation | undefined,
): ProviderStormPolicy {
  const retryForbidden = dq.retryExtendsBlock === true;
  const spendPerRun = ASSUMED_REQUESTS_PER_RUN;
  // Threads has a dynamic quota and NO usage header (D-037), so this prose may
  // not name a header that does not exist. Saying the absence out loud beats a
  // generic subject: a reader of the reason string learns why no measurement
  // backs the cap, which is the whole difference between this platform and its
  // two header-reporting siblings.
  const usageSubject = dq.usageHeader ?? 'the provider (which publishes no usage signal)';
  const observed =
    typeof observation?.peakUsagePct === 'number' && Number.isFinite(observation.peakUsagePct)
      ? observation.peakUsagePct
      : null;

  const held = (reason: string, headroomPct: number): ProviderStormPolicy => ({
    mode: 'coalesce-with-cap',
    // Zero is the honest cap for a hold, and `toBindingStormPolicy` refuses to
    // persist it rather than rounding it up to something runnable.
    maxRuns: 0,
    windowSeconds: PROVIDER_STORM_WINDOW_SECONDS,
    basis: {
      kind: 'dynamic-quota',
      formula: dq.formula,
      usageHeader: dq.usageHeader ?? null,
      assumedDailyFloor: dq.assumedDailyFloor,
      spendPerRun,
      observedPeakUsagePct: observed,
      headroomPct,
      held: true,
    },
    hold: {
      reason,
      retryForbidden,
      // Never defaulted. A stated duration or nothing.
      untilMs:
        typeof observation?.throttleHoldMs === 'number' && Number.isFinite(observation.throttleHoldMs)
          ? observation.throttleHoldMs
          : null,
    },
  });

  if (observation?.throttled === true) {
    return held(
      `${usageSubject} reported a throttle on this account; ${
        retryForbidden ? 'retrying would extend the block, so no retry is scheduled' : 'launching is suspended'
      }`,
      observed === null ? 0 : Math.max(0, 100 - observed),
    );
  }

  const headroomPct = observed === null ? 100 : Math.max(0, 100 - observed);
  if (headroomPct <= 0) {
    return held(
      `${usageSubject} reports ${observed}% of the allowance consumed; the next call is the one that trips the throttle`,
      0,
    );
  }

  const remainingPerDay = dq.assumedDailyFloor * (headroomPct / 100);
  const runsPerDay = Math.floor(remainingPerDay / spendPerRun);

  const basis = (extra: { windowWidened?: true }): ProviderStormCapBasis => ({
    kind: 'dynamic-quota',
    formula: dq.formula,
    usageHeader: dq.usageHeader ?? null,
    assumedDailyFloor: dq.assumedDailyFloor,
    spendPerRun,
    observedPeakUsagePct: observed,
    headroomPct,
    ...extra,
  });

  if (runsPerDay < 1) {
    // Rationing has run out: the share of the allowance believed to remain
    // cannot fund even one run for the rest of the day. That is materially the
    // throttled case, so it holds rather than widening to a 24-hour window and
    // spending the last of the budget on one call.
    return held(
      `only ${headroomPct}% of the allowance is believed to remain, which cannot fund a single ${spendPerRun}-call run`,
      headroomPct,
    );
  }

  const windowsPerDay = SECONDS_PER_DAY / PROVIDER_STORM_WINDOW_SECONDS;
  const perWindow = Math.floor(runsPerDay / windowsPerDay);

  if (perWindow < 1) {
    return {
      mode: 'coalesce-with-cap',
      maxRuns: 1,
      windowSeconds: Math.ceil(SECONDS_PER_DAY / runsPerDay),
      basis: basis({ windowWidened: true }),
    };
  }

  return {
    mode: 'coalesce-with-cap',
    maxRuns: Math.min(perWindow, MAX_RUNS_CEILING),
    windowSeconds: PROVIDER_STORM_WINDOW_SECONDS,
    basis: basis({}),
  };
}

/**
 * The default storm policy for a source on this platform, for a given verb.
 *
 * Pure and total: every registry row yields a policy, and no row yields an
 * unbounded one.
 *
 * ⚠ WHY THE WINDOW CAN WIDEN, WHICH IS THE POINT OF THE WHOLE BUCKET PATH.
 * The existing `requestsPerMinute` derivation clamps a small cap up to 1,
 * reasoning that "a platform with a tiny budget still gets to act once per
 * window" and that a cap of 0 would be an outage wearing a policy's clothes.
 * That reasoning holds for a PER-MINUTE budget, which refills continuously. It
 * breaks for a DAILY one, which does not: YouTube's 10,000 units/day against a
 * ~60-unit reply run funds ~166 runs a day, but the 300-second window contains
 * 288 windows a day — so clamping to "1 per window" authorises 288 runs and
 * overspends the budget by ~70%, then stops the integration entirely for the
 * remainder of the quota day.
 *
 * So when the budget cannot fund one run per standard window, this widens the
 * WINDOW to the run's actual share of the day rather than inflating the cap.
 * The cap stays honest, nothing is dropped (`coalesce-with-cap` still folds the
 * overflow in), and `basis.windowWidened` records that it happened.
 */
export function providerStormPolicyFor(
  descriptor: Pick<ProviderDescriptor, 'id'> & { rateBudget?: Partial<ProviderRateBudget> },
  verb: ProviderQuotaVerb = 'read',
  observation?: ProviderQuotaObservation,
): ProviderStormPolicy {
  const budget = descriptor.rateBudget ?? {};
  // ORDERING, AND THE ONE CASE THAT LOOKS LIKE A CONFLICT AND IS NOT (D-030).
  //
  // A declared `dynamicQuota` outranks a compiled-in FIGURE — that is what the
  // field is for: the row saying any constant it also carries describes a budget
  // that moves. But a declared BUCKET is not a competing estimate of that same
  // budget; it is a DIFFERENT, non-fungible one. Instagram states both at once:
  // a call budget of "4800 * Number of Impressions" AND a publishing cap of
  // ~50 posts/24h enforced specifically on `media_publish`. A read-heavy day
  // cannot consume publishing quota and vice versa, so whichever runs out first
  // is the real bound on ITS OWN verb.
  //
  // So the precedence is per-verb: a bucket that DECLARES this verb wins,
  // because it is a hard cap on exactly this operation. Every verb no bucket
  // declares falls to the dynamic quota — never to the tightest-bucket fallback,
  // which would cap a read against a publishing limit it does not draw on.
  const buckets = budget.buckets;
  const dynamicQuota = budget.dynamicQuota;
  if (buckets) {
    const picked = selectQuotaBucket(buckets, verb);
    // D-020: a verb's own non-fungible bucket outranks any aggregate figure. A cap
    // derived from `quotaUnitsPerDay` alone is not merely imprecise for a
    // call-capped verb, it is calibrated against an unrelated quantity.
    if (picked && !(dynamicQuota && picked.fallbackToTightest)) {
      const { name, bucket, fallbackToTightest } = picked;
      const spendPerRun = assumedSpendPerRun(bucket, verb);
      const runsPerDay = Math.floor(bucket.perDay / spendPerRun);

      if (runsPerDay < 1) {
        // The budget cannot fund a single run even across a whole day. Refuse to
        // invent headroom: one run per day is the most this can honestly allow.
        return {
          mode: 'coalesce-with-cap',
          maxRuns: 1,
          windowSeconds: SECONDS_PER_DAY,
          basis: {
            kind: 'quota-bucket',
            bucket: name,
            verb,
            perDay: bucket.perDay,
            unit: bucket.unit,
            spendPerRun,
            windowWidened: true,
            ...(fallbackToTightest ? { fallbackToTightest } : {}),
          },
        };
      }

      const windowsPerDay = SECONDS_PER_DAY / PROVIDER_STORM_WINDOW_SECONDS;
      const perWindow = Math.floor(runsPerDay / windowsPerDay);

      if (perWindow < 1) {
        return {
          mode: 'coalesce-with-cap',
          maxRuns: 1,
          windowSeconds: Math.ceil(SECONDS_PER_DAY / runsPerDay),
          basis: {
            kind: 'quota-bucket',
            bucket: name,
            verb,
            perDay: bucket.perDay,
            unit: bucket.unit,
            spendPerRun,
            windowWidened: true,
            ...(fallbackToTightest ? { fallbackToTightest } : {}),
          },
        };
      }

      return {
        mode: 'coalesce-with-cap',
        maxRuns: Math.min(perWindow, MAX_RUNS_CEILING),
        windowSeconds: PROVIDER_STORM_WINDOW_SECONDS,
        basis: {
          kind: 'quota-bucket',
          bucket: name,
          verb,
          perDay: bucket.perDay,
          unit: bucket.unit,
          spendPerRun,
          ...(fallbackToTightest ? { fallbackToTightest } : {}),
        },
      };
    }
  }

  // D-028: the allowance is not a constant, so it outranks anything compiled in.
  if (dynamicQuota) return dynamicQuotaPolicy(dynamicQuota, observation);

  const rpm = budget.requestsPerMinute;

  if (typeof rpm === 'number' && Number.isFinite(rpm) && rpm > 0) {
    const windowMinutes = PROVIDER_STORM_WINDOW_SECONDS / 60;
    const sustainable = Math.floor((rpm * windowMinutes) / ASSUMED_REQUESTS_PER_RUN);
    // Never below 1: a platform with a tiny budget still gets to act once per
    // window. A cap of 0 would be an outage wearing a policy's clothes.
    const maxRuns = Math.min(Math.max(sustainable, 1), MAX_RUNS_CEILING);

    return {
      mode: 'coalesce-with-cap',
      maxRuns,
      windowSeconds: PROVIDER_STORM_WINDOW_SECONDS,
      basis: { kind: 'rate-budget', requestsPerMinute: rpm, requestsPerRun: ASSUMED_REQUESTS_PER_RUN },
    };
  }

  return {
    mode: 'coalesce-with-cap',
    maxRuns: FALLBACK_MAX_RUNS,
    windowSeconds: PROVIDER_STORM_WINDOW_SECONDS,
    basis: {
      kind: 'conservative-default',
      why:
        budget.notes?.trim() ||
        `the ${descriptor.id} installed provider declares no requestsPerMinute, so no cap could be derived from a budget`,
    },
  };
}

/**
 * Project a social policy onto the landed binding-engine storm-policy shape,
 * which is what `storm_policy` jsonb actually stores.
 *
 * The extra social fields ride along rather than being dropped: `parseStormPolicy`
 * reads the cap and coalescing mode while retaining the declared basis, so persisting the
 * basis costs nothing and keeps a stored policy self-describing — otherwise the
 * only record of whether a cap was measured or guessed would be this source file.
 */
export function toBindingStormPolicy(policy: ProviderStormPolicy): Record<string, unknown> {
  // A HOLD HAS NO FAITHFUL STORED FORM, and both ways of forcing one are wrong.
  // The binding parser requires a POSITIVE integer, so `maxRuns: 0` is rejected
  // there — and the tempting repair, rounding it up to 1, would persist a
  // standing licence to call built out of an instruction to stop. A hold is also
  // a live verdict with an expiry, while a binding outlives the throttle that
  // produced it. So this refuses instead of choosing: a held policy is something
  // a caller acts on now, never something it writes down.
  if (policy.hold) {
    throw new Error(
      `provider_storm_policy_held_not_persistable: ${policy.hold.reason}` +
        (policy.hold.retryForbidden ? ' (retry forbidden)' : ''),
    );
  }
  return {
    maxRuns: policy.maxRuns,
    windowSeconds: policy.windowSeconds,
    mode: policy.mode,
    basis: policy.basis,
  };
}


/** Resolve the installed descriptor on every call; unload/replacement cannot keep stale quotas. */
export function defaultProviderStormPolicyForSourceKind(registry: ProviderRegistry, kind: string): Record<string, unknown> | null {
  const descriptor = registry.get(kind)?.descriptor;
  if (!descriptor || (!descriptor.rateBudget && !descriptor.datatypes.includes('social-post'))) return null;
  return toBindingStormPolicy(providerStormPolicyFor(descriptor));
}


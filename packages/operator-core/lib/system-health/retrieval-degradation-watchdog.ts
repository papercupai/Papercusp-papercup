/**
 * retrieval-degradation-watchdog (system-notices-on-its-own-2026-08-16 P-002) —
 * make a sustained retrieval degradation visible the way a stalled routine is.
 *
 * WHY. `summariseLegs` decides, for every single search, whether the ranking
 * returned is the ranking the configuration promises. `observeLegs` (P-002) now
 * records that verdict into a bounded trailing window instead of throwing it
 * away. This is the last leg: something has to READ the rate, or instrumenting
 * it just moves the problem from "prose nobody reads" to "a counter nobody
 * queries".
 *
 * The observed failure, three times inside one agent session on 2026-08-16:
 * `semantic leg blocked: query embed failed: query embed exceeded 1200ms budget`
 * — every returned pointer lexical-only — plus a fourth occurrence where the
 * LEXICAL leg contributed 0 candidates instead. Retrieval is how stored
 * knowledge reaches the moment of need, so a half-strength retrieval layer is
 * precisely the mechanism behind "the knowledge existed and it did not reach
 * me". Nothing alarmed, because nothing was counting.
 *
 * P-005 now extends that SAME per-search recorder with an optional host sink.
 * Startup wires each authoritative healthy/degraded sample into observeFallback;
 * the generic degradation watchdog reads its durable cross-process window and
 * owns alarm and recovery on the existing condition bridge. The local ring stays
 * available for diagnostics. A quiet durable window still means no measured
 * collapse among instrumented searches, never universal retrieval health.
 */
import { readLegHealth, setLegHealthObserver, type LegHealthWindow, type LegSample } from '@papercusp/search';
import { observeFallback, type FallbackDecision } from '../degradation/fallback-observations';

export const RETRIEVAL_DEGRADATION_SWEEP_INTERVAL_MS = 15 * 60_000;
export const RETRIEVAL_DEGRADATION_WINDOW_MS = 60 * 60_000;

/**
 * Minimum searches in the window before any verdict is issued.
 *
 * Without this, one degraded search in a quiet hour reads as a 100% degradation
 * rate. A rate over a tiny denominator is not a measurement.
 */
export const RETRIEVAL_DEGRADATION_MIN_SAMPLES = 20;

/**
 * The alarm floor, as a fraction of searches in the window.
 *
 * PROVISIONAL AND DELIBERATELY HIGH, and the reason is worth stating: there is
 * no baseline for this rate yet, because until P-002 nothing measured it. Any
 * precise-looking threshold chosen today would be invented rather than derived.
 * So this is set where the verdict is unambiguous REGARDLESS of baseline — half
 * of all retrievals in an hour not running at full strength is wrong under any
 * reading — and it should be re-derived from real percentiles once the metric
 * has produced a few days of data. Producing that baseline is the point of
 * shipping the measurement first.
 */
export const RETRIEVAL_DEGRADATION_FLOOR = 0.5;

export const RETRIEVAL_DEGRADATION_MECHANISM = 'retrieval';

export function retrievalSampleDecision(sample: LegSample): FallbackDecision {
  const reasons = [
    sample.semanticBlocked && 'semantic-blocked', sample.lexicalBlocked && 'lexical-blocked',
    sample.semanticEmpty && 'semantic-empty', sample.lexicalEmpty && 'lexical-empty',
  ].filter((reason): reason is string => typeof reason === 'string');
  return { eligible: 1, applied: sample.degraded ? 0 : 1,
    reason: !sample.degraded ? 'applied' : reasons.length === 1 ? reasons[0] : 'mixed' };
}

export type RetrievalVerdict =
  | { kind: 'insufficient-samples'; health: LegHealthWindow }
  | { kind: 'healthy'; health: LegHealthWindow }
  | { kind: 'degraded'; health: LegHealthWindow; rate: number; dominant: string };

/**
 * PURE: decide what the window says. Split from the sweep so the thresholds are
 * testable with no timers, no PG and no escalation surface.
 */
export function judgeRetrievalHealth(
  health: LegHealthWindow,
  opts: { minSamples?: number; floor?: number } = {},
): RetrievalVerdict {
  const minSamples = opts.minSamples ?? RETRIEVAL_DEGRADATION_MIN_SAMPLES;
  const floor = opts.floor ?? RETRIEVAL_DEGRADATION_FLOOR;
  // degradedRate is null (never 0) when nothing was recorded — a no-data window
  // must not be able to impersonate a clean bill of health.
  if (health.degradedRate === null || health.searches < minSamples) {
    return { kind: 'insufficient-samples', health };
  }
  if (health.degradedRate < floor) return { kind: 'healthy', health };
  // Name the leg actually responsible, so the alarm points at a cause rather
  // than restating that something is wrong.
  const counts: [string, number][] = [
    ['semantic leg blocked', health.semanticBlocked],
    ['lexical leg blocked', health.lexicalBlocked],
    ['semantic leg returned nothing', health.semanticEmpty],
    ['lexical leg returned nothing', health.lexicalEmpty],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const dominant = counts[0][1] > 0 ? counts[0][0] : 'mixed / partial source failures';
  return { kind: 'degraded', health, rate: health.degradedRate, dominant };
}

export interface RetrievalDegradationSweepDeps {
  readHealth: () => LegHealthWindow;
  escalate: (v: Extract<RetrievalVerdict, { kind: 'degraded' }>) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  minSamples: number;
  floor: number;
  observe: typeof observeFallback;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.RETRIEVAL_DEGRADATION_WATCHDOG, 'system');
  } catch {
    return false;
  }
}

async function defaultEscalate(
  v: Extract<RetrievalVerdict, { kind: 'degraded' }>,
  observer: typeof observeFallback = observeFallback,
): Promise<void> {
  const h = v.health;
  const counts = { searches: h.searches, degraded: h.degraded };
  const decision = { eligible: counts.searches, applied: counts.searches - counts.degraded,
    reason: v.dominant.replace(/\s+/g, '-') };
  // Kept for explicit one-shot callers; runtime startup now observes each search,
  // and the generic durable watchdog is the only scheduled rate detector.
  if (observer === observeFallback) observeFallback(RETRIEVAL_DEGRADATION_MECHANISM, decision);
  else observer(RETRIEVAL_DEGRADATION_MECHANISM, decision);
}

function sweepDeps(
  overrides: Partial<RetrievalDegradationSweepDeps>,
): RetrievalDegradationSweepDeps {
  return {
    readHealth: () => readLegHealth({ windowMs: RETRIEVAL_DEGRADATION_WINDOW_MS }),
    escalate: (v) => defaultEscalate(v, overrides.observe ?? observeFallback),
    flagEnabled: defaultFlagEnabled,
    minSamples: RETRIEVAL_DEGRADATION_MIN_SAMPLES,
    floor: RETRIEVAL_DEGRADATION_FLOOR,
    observe: observeFallback,
    ...overrides,
  };
}

/** One sweep. Exported for tests. */
export async function runRetrievalDegradationSweepOnce(
  overrides: Partial<RetrievalDegradationSweepDeps> = {},
): Promise<{ verdict: RetrievalVerdict['kind'] | 'skipped'; escalated: number }> {
  const deps = sweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { verdict: 'skipped', escalated: 0 };
  const verdict = judgeRetrievalHealth(deps.readHealth(), {
    minSamples: deps.minSamples,
    floor: deps.floor,
  });
  if (verdict.kind !== 'degraded') return { verdict: verdict.kind, escalated: 0 };
  await deps.escalate(verdict);
  return { verdict: 'degraded', escalated: 1 };
}

/**
 * Install a sink on the existing authoritative search measurement. Idempotent:
 * replacing the observer cannot multiply records. The generic degradation watchdog
 * owns the schedule and condition lifecycle; no private ring-poll/escalation timer.
 */
export function startRetrievalDegradationWatchdog(opts: { observe?: typeof observeFallback } = {}): void {
  setLegHealthObserver((sample) => (opts.observe ?? observeFallback)(RETRIEVAL_DEGRADATION_MECHANISM,
    retrievalSampleDecision(sample), {
      observedAt: new Date(sample.atMs),
      processTag: 'search',
      correlationId: sample.correlationId,
    }));
}
